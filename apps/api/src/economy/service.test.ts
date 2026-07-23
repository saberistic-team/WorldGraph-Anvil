import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedActor } from '../identity/service.js';
import {
  repairActorId,
  repairApproval,
  repairApprovalId,
  repairOtherWorldId,
  repairPlanHash,
  repairPlanId,
  repairPlanView,
  repairTestId,
  repairWorldId,
} from './repair-test-fixtures.js';
import type { EconomyRepairApprovalInput, PostgresEconomyQueryRepository } from './repository.js';
import { EconomyQueryService } from './service.js';

const actor = {
  user: { id: repairActorId, platformRole: 'user' },
} as AuthenticatedActor;
const approvalRequest = {
  approvalId: repairApprovalId,
  authorityKind: 'creator',
  confirmation: 'APPROVE APPEND-ONLY ECONOMY REPAIR',
  planHash: repairPlanHash,
} as const;

function service(repository: Partial<PostgresEconomyQueryRepository>): EconomyQueryService {
  return new EconomyQueryService(repository as PostgresEconomyQueryRepository, 'cursor-secret', {
    debitsFrozen: false,
    issuanceEnabled: true,
    offersEnabled: true,
    transfersEnabled: true,
  });
}

function postgresError(
  code: string,
  constraint?: string,
): Error & { code: string; constraint?: string } {
  const error: Error & { code: string; constraint?: string } = Object.assign(
    new Error('Database operation failed.'),
    { code },
  );
  if (constraint !== undefined) error.constraint = constraint;
  return error;
}

describe('EconomyQueryService repair plan authorization', () => {
  it('redacts both a cross-world plan and a plan unavailable to the actor as not found', async () => {
    const crossWorld = service({
      repairPlan: vi.fn(async () => ({ ...repairPlanView, worldId: repairOtherWorldId })),
    });
    const unauthorized = service({
      repairPlan: vi.fn(async () => {
        throw postgresError('42501');
      }),
    });

    await expect(crossWorld.repairPlan(actor, repairWorldId, repairPlanId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      statusCode: 404,
    });
    await expect(unauthorized.repairPlan(actor, repairWorldId, repairPlanId)).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
        statusCode: 404,
      },
    );
  });

  it('redacts a cross-world approval before any approval result is exposed', async () => {
    const approveRepair = vi.fn(async () => null);
    const query = service({ approveRepair });

    await expect(
      query.approveRepair(actor, repairOtherWorldId, repairPlanId, approvalRequest),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      statusCode: 404,
    });
  });

  it('lets the database reject a forged authority and returns a stable redacted error', async () => {
    const approveRepair = vi.fn(async (_input: EconomyRepairApprovalInput) => {
      throw postgresError('42501');
    });
    const query = service({ approveRepair });

    await expect(
      query.approveRepair(actor, repairWorldId, repairPlanId, {
        ...approvalRequest,
        authorityKind: 'platform_admin',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The economy repair approval is not authorized.',
      statusCode: 403,
    });
    expect(approveRepair.mock.calls[0]?.[0]).toMatchObject({
      actorId: repairActorId,
      authorityKind: 'platform_admin',
      creatorOverrideId: null,
    });
  });

  it.each([
    ['22023', 'REPAIR_APPROVAL_INVALID', 422],
    ['55000', 'REPAIR_APPROVAL_CONFLICT', 409],
  ] as const)(
    'maps database state %s without exposing database detail',
    async (sqlState, code, statusCode) => {
      const query = service({
        approveRepair: vi.fn(async () => {
          throw postgresError(sqlState);
        }),
      });

      await expect(
        query.approveRepair(actor, repairWorldId, repairPlanId, approvalRequest),
      ).rejects.toMatchObject({ code, statusCode });
    },
  );

  it('maps only the exact deferred approval constraint to a conflict', async () => {
    const expiredApproval = postgresError('23514', 'economy_repair_approval_exact');
    const unrelatedCheck = postgresError('23514', 'some_other_constraint');
    const expired = service({
      approveRepair: vi.fn(async () => {
        throw expiredApproval;
      }),
    });
    const unrelated = service({
      approveRepair: vi.fn(async () => {
        throw unrelatedCheck;
      }),
    });

    await expect(
      expired.approveRepair(actor, repairWorldId, repairPlanId, approvalRequest),
    ).rejects.toMatchObject({ code: 'REPAIR_APPROVAL_CONFLICT', statusCode: 409 });
    await expect(
      unrelated.approveRepair(actor, repairWorldId, repairPlanId, approvalRequest),
    ).rejects.toBe(unrelatedCheck);
  });
});

describe('EconomyQueryService repair approval replay evidence', () => {
  it('derives identical server evidence ids for an exact approval replay', async () => {
    const inputs: EconomyRepairApprovalInput[] = [];
    const approval = repairApproval('creator');
    const approveRepair = vi.fn(async (input: EconomyRepairApprovalInput) => {
      inputs.push(input);
      return approval;
    });
    const query = service({ approveRepair });

    await expect(
      query.approveRepair(actor, repairWorldId, repairPlanId, approvalRequest),
    ).resolves.toEqual(approval);
    await expect(
      query.approveRepair(actor, repairWorldId, repairPlanId, approvalRequest),
    ).resolves.toEqual(approval);

    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.auditRecordId).toBe(inputs[1]?.auditRecordId);
    expect(inputs[0]?.creatorOverrideId).toBe(inputs[1]?.creatorOverrideId);
    expect(inputs[0]?.auditRecordId).toMatch(/^[a-f0-9-]{36}$/);
    expect(inputs[0]?.creatorOverrideId).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      new Set([
        inputs[0]?.auditRecordId,
        inputs[0]?.creatorOverrideId,
        repairApprovalId,
        repairActorId,
        repairPlanId,
      ]).size,
    ).toBe(5);
  });

  it('creates creator evidence only for creator authority and keeps both authorities distinct', async () => {
    const inputs: EconomyRepairApprovalInput[] = [];
    const approveRepair = vi.fn(async (input: EconomyRepairApprovalInput) => {
      inputs.push(input);
      return repairApproval(input.authorityKind, input.approvalId);
    });
    const query = service({ approveRepair });
    const adminApprovalId = repairTestId(33);
    const adminActor = {
      user: { id: repairTestId(36), platformRole: 'platform_admin' },
    } as AuthenticatedActor;

    await query.approveRepair(actor, repairWorldId, repairPlanId, approvalRequest);
    await query.approveRepair(adminActor, repairWorldId, repairPlanId, {
      ...approvalRequest,
      approvalId: adminApprovalId,
      authorityKind: 'platform_admin',
    });

    expect(inputs[0]).toMatchObject({
      approvalId: repairApprovalId,
      authorityKind: 'creator',
    });
    expect(typeof inputs[0]?.creatorOverrideId).toBe('string');
    expect(inputs[1]).toMatchObject({
      actorId: repairTestId(36),
      approvalId: adminApprovalId,
      authorityKind: 'platform_admin',
      creatorOverrideId: null,
    });
    expect(inputs[0]?.actorId).not.toBe(inputs[1]?.actorId);
    expect(inputs[0]?.auditRecordId).not.toBe(inputs[1]?.auditRecordId);
  });
});
