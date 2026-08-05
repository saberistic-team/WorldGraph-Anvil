import { describe, expect, it, vi } from 'vitest';

import { governanceTwoPersonApprovalBindingHashV1 } from '@worldgraph/governance-command';

import type { GovernanceApprovalRequestTransport } from '../commands/api-contracts.js';
import { ApplicationError } from '../application/errors.js';
import type { PostgresRepository } from '../repositories/postgres-repository.js';
import { IdentityService, type AuthenticatedActor } from './service.js';
import type { Argon2idPasswordHasher } from './security.js';

const userId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const sessionId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const requestId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const now = new Date('2026-08-03T12:00:00.000Z');

const actor: AuthenticatedActor = {
  csrfHash: Buffer.alloc(32, 1),
  session: {
    absoluteExpiresAt: '2026-08-03T13:00:00.000Z',
    id: sessionId,
    idleExpiresAt: '2026-08-03T12:07:00.000Z',
  },
  user: {
    displayName: 'Second reviewer',
    email: 'reviewer@example.test',
    id: userId,
    platformRole: 'user',
    rowVersion: 1,
    status: 'active',
  },
};

const input = {
  command: {
    actorMode: 'creator',
    commandId,
    expectedAggregateVersion: '0',
    expectedStateRevision: '4',
    expectedTick: '10',
    expectedWorldVersion: '1',
    idempotencyKey: 'repair-governance-result-0001',
    payload: {
      approvalId: null,
      confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
      expectedCurrentResultChecksum: 'a'.repeat(64),
      reason: 'Recompute the frozen ballots and append linked evidence.',
      repairKind: 'proposal_recount',
      replacementResultChecksum: 'b'.repeat(64),
      sourceResultId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
    },
    schemaVersion: 1,
    type: 'RepairGovernanceResultV1',
  },
  password: 'correct horse battery',
  worldId,
} satisfies GovernanceApprovalRequestTransport;

describe('governance two-person approval service', () => {
  it('idempotently appends one exact approval audit with session-bounded expiry', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const repository = approvalRepository(audits, 'administrator');
    const service = identityService(repository, true);

    const first = await service.approveGovernanceOperation(
      actor,
      input,
      requestId,
      'governance-approval-key-0001',
    );
    const replay = await service.approveGovernanceOperation(
      actor,
      input,
      requestId,
      'governance-approval-key-0001',
    );

    expect(replay).toEqual(first);
    expect(first).toEqual({
      approvalId: '018f8652-3cb6-7d52-904b-000000000030',
      commandId,
      expiresAt: '2026-08-03T12:07:00.000Z',
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'governance.approve_repair',
      actorUserId: userId,
      category: 'governance_approval',
      id: first.approvalId,
      metadata: {
        approvalExpiresAt: first.expiresAt,
        approvalIssuedAt: now.toISOString(),
        bindingHash: governanceTwoPersonApprovalBindingHashV1(input.command),
        commandType: 'RepairGovernanceResultV1',
        sessionId,
      },
      outcome: 'allowed',
      reasonCode: 'GOVERNANCE_REPAIR_SECOND_APPROVAL',
      targetId: commandId,
      targetType: 'command',
      worldId,
    });
    expect(JSON.stringify(audits)).not.toContain(input.password);
  });

  it('rejects a non-administrator world member without appending an allowed approval', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const service = identityService(approvalRepository(audits, 'player'), true);

    await expect(
      service.approveGovernanceOperation(actor, input, requestId, 'governance-approval-key-0002'),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED', statusCode: 403 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'governance.approve_repair',
      outcome: 'denied',
      reasonCode: 'GOVERNANCE_APPROVAL_FORBIDDEN',
    });
    expect(audits.some((audit) => audit.outcome === 'allowed')).toBe(false);
  });

  it('returns a generic password failure without storing the password', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const service = identityService(approvalRepository(audits, 'creator'), false);

    await expect(
      service.approveGovernanceOperation(
        actor,
        { ...input, password: 'incorrect password value' },
        requestId,
        'governance-approval-key-0003',
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_FAILED', statusCode: 401 });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain('incorrect password value');
  });
});

function approvalRepository(
  audits: Array<Record<string, unknown>>,
  role: 'administrator' | 'creator' | 'player',
): PostgresRepository {
  let identity:
    | {
        body?: Record<string, unknown>;
        requestHash: Buffer;
      }
    | undefined;
  const repository = {
    beginIdempotency: vi.fn(async (value: { requestHash: Buffer }) => {
      if (!identity) {
        identity = { requestHash: value.requestHash };
        return { kind: 'new' as const };
      }
      if (!identity.requestHash.equals(value.requestHash)) {
        throw new ApplicationError(
          'IDEMPOTENCY_KEY_REUSED',
          'The idempotency key was already used for a different request.',
          409,
        );
      }
      return { body: identity.body!, kind: 'replay' as const, status: 200 };
    }),
    completeIdempotency: vi.fn(
      async (_value: unknown, _status: number, body: Record<string, unknown>) => {
        identity = { body, requestHash: identity!.requestHash };
      },
    ),
    findCredential: vi.fn(async () => ({ passwordHash: 'encoded', user: actor.user })),
    getWorld: vi.fn(async () => ({ id: worldId, role })),
    insertAudit: vi.fn(async (audit: Record<string, unknown>) => {
      audits.push(audit);
    }),
    transaction: vi.fn(async (operation: (value: PostgresRepository) => Promise<unknown>) =>
      operation(repository as unknown as PostgresRepository),
    ),
  };
  return repository as unknown as PostgresRepository;
}

function identityService(repository: PostgresRepository, verifyPassword: boolean): IdentityService {
  let nextId = 30;
  return new IdentityService(
    repository,
    {
      authPepper: 'test-auth-pepper-that-is-at-least-thirty-two-characters',
      sessionAbsoluteTtlSeconds: 3_600,
      sessionIdleTtlSeconds: 1_800,
    } as never,
    { now: () => now },
    { next: () => `018f8652-3cb6-7d52-904b-${String(nextId++).padStart(12, '0')}` },
    {
      hash: vi.fn(async () => 'dummy'),
      verify: vi.fn(async () => verifyPassword),
    } as unknown as Argon2idPasswordHasher,
    { publish: vi.fn(async () => undefined) },
  );
}
