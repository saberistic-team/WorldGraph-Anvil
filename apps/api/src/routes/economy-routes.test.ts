import Fastify, { type FastifyInstance } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type {
  EconomyRepairApprovalRequestTransport,
  EconomySummaryTransport,
} from '../economy/api-contracts.js';
import {
  repairApproval,
  repairApprovalId,
  repairPlanHash,
  repairPlanId,
  repairPlanView,
  repairTestId,
  repairWorldId,
} from '../economy/repair-test-fixtures.js';
import type { EconomyQueryService } from '../economy/service.js';
import { registerEconomyRoutes } from './economy-routes.js';

const actor = {
  user: {
    id: '018f8652-3cb6-7d52-904b-cce7901d7e21',
    platformRole: 'user',
  },
} as AuthenticatedActor;
const worldId = repairWorldId;

function testApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
  });
  addFormats(ajv);
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApplicationError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: repairTestId(99),
        },
      });
    }
    const validationFailed = typeof error === 'object' && error !== null && 'validation' in error;
    return reply.code(validationFailed ? 400 : 500).send({
      error: {
        code: validationFailed ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR',
        message: validationFailed ? 'Request invalid.' : 'Failed.',
        requestId: repairTestId(99),
      },
    });
  });
  return app;
}

describe('economy routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('returns the exact economy summary including the last reconciliation time', async () => {
    const response: EconomySummaryTransport = {
      capabilities: {
        canAdoptLegacySeed: false,
        canInitialize: false,
        canIssue: true,
        canReconcile: true,
      },
      currentTick: '42',
      designVersion: '3',
      economyHeadVersion: '8',
      featurePolicy: {
        debitsFrozen: false,
        issuanceEnabled: true,
        offersEnabled: true,
        transfersEnabled: true,
      },
      initializedEventId: '018f8652-3cb6-7d52-904b-cce7901d7e24',
      issuanceTarget: {
        currencyCode: 'GCR',
        currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        currencyVersion: '1',
        currentSupplyMinor: '20000',
        maxSupplyMinor: '100000000',
        minorUnitScale: 2,
        supplyVersion: '1',
        treasuryBalanceMinor: '0',
        treasuryBalanceVersion: '1',
        treasuryWalletId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        treasuryWalletVersion: '1',
      },
      projectionChecksum: 'b'.repeat(64),
      reconciliation: {
        lastReconciledAt: '2026-07-22T12:34:56.789Z',
        lastReconciledStateRevision: '17',
        status: 'current',
      },
      seedPlan: {
        available: true,
        hash: 'a'.repeat(64),
        sourceKind: 'compiler_1_1',
      },
      stateRevision: '17',
      status: 'ready',
      virtualValueBoundary: { cashOutAllowed: false, noCashValue: true },
      worldId,
    };
    const summary = vi.fn(async () => response);
    const authenticate = vi.fn(async () => actor);
    const mutation = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerEconomyRoutes(app, { summary } as unknown as EconomyQueryService, {
      authenticate,
      mutation,
    });

    const result = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/summary`,
    });

    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual(response);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(summary).toHaveBeenCalledWith(actor, worldId);
  });

  it('returns a private repair plan only through authenticated plan lookup', async () => {
    const repairPlan = vi.fn(async () => repairPlanView);
    const authenticate = vi.fn(async () => actor);
    const mutation = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerEconomyRoutes(app, { repairPlan } as unknown as EconomyQueryService, {
      authenticate,
      mutation,
    });

    const result = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/repair-plans/${repairPlanId}`,
    });

    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual(repairPlanView);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(mutation).not.toHaveBeenCalled();
    expect(repairPlan).toHaveBeenCalledWith(actor, worldId, repairPlanId);
  });

  it('uses mutation authentication and the idempotent approval identity for approval', async () => {
    const approval = repairApproval('creator');
    const approveRepair = vi.fn(async () => approval);
    const authenticate = vi.fn(async () => actor);
    const mutation = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerEconomyRoutes(app, { approveRepair } as unknown as EconomyQueryService, {
      authenticate,
      mutation,
    });
    const body: EconomyRepairApprovalRequestTransport = {
      approvalId: repairApprovalId,
      authorityKind: 'creator',
      confirmation: 'APPROVE APPEND-ONLY ECONOMY REPAIR',
      planHash: repairPlanHash,
    };

    const result = await app.inject({
      body,
      headers: {
        'idempotency-key': repairApprovalId,
        'x-csrf-token': 'c'.repeat(32),
      },
      method: 'POST',
      url: `/api/v1/worlds/${worldId}/economy/repair-plans/${repairPlanId}/approvals`,
    });

    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual(approval);
    expect(authenticate).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledOnce();
    expect(approveRepair).toHaveBeenCalledWith(actor, worldId, repairPlanId, body);
  });

  it.each([
    {
      approvalId: repairApprovalId,
      header: repairTestId(33),
      label: 'changed header with the same body',
    },
    {
      approvalId: repairTestId(33),
      header: repairApprovalId,
      label: 'same header with a changed body identity',
    },
  ])('rejects $label before mutation authentication', async ({ approvalId, header }) => {
    const approveRepair = vi.fn();
    const mutation = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerEconomyRoutes(app, { approveRepair } as unknown as EconomyQueryService, {
      authenticate: vi.fn(async () => actor),
      mutation,
    });

    const result = await app.inject({
      body: {
        approvalId,
        authorityKind: 'creator',
        confirmation: 'APPROVE APPEND-ONLY ECONOMY REPAIR',
        planHash: repairPlanHash,
      },
      headers: {
        'idempotency-key': header,
        'x-csrf-token': 'c'.repeat(32),
      },
      method: 'POST',
      url: `/api/v1/worlds/${worldId}/economy/repair-plans/${repairPlanId}/approvals`,
    });

    expect(result.statusCode, result.body).toBe(400);
    expect(result.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_MISMATCH' } });
    expect(mutation).not.toHaveBeenCalled();
    expect(approveRepair).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a changed confirmation phrase',
      mutation: { confirmation: 'approve' },
    },
    {
      label: 'a non-canonical plan hash',
      mutation: { planHash: 'A'.repeat(64) },
    },
  ])('rejects $label before authentication or approval', async ({ mutation: bodyChange }) => {
    const approveRepair = vi.fn();
    const authenticate = vi.fn(async () => actor);
    const mutation = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerEconomyRoutes(app, { approveRepair } as unknown as EconomyQueryService, {
      authenticate,
      mutation,
    });

    const result = await app.inject({
      body: {
        approvalId: repairApprovalId,
        authorityKind: 'creator',
        confirmation: 'APPROVE APPEND-ONLY ECONOMY REPAIR',
        planHash: repairPlanHash,
        ...bodyChange,
      },
      headers: {
        'idempotency-key': repairApprovalId,
        'x-csrf-token': 'c'.repeat(32),
      },
      method: 'POST',
      url: `/api/v1/worlds/${worldId}/economy/repair-plans/${repairPlanId}/approvals`,
    });

    expect(result.statusCode, result.body).toBe(400);
    expect(mutation).not.toHaveBeenCalled();
    expect(approveRepair).not.toHaveBeenCalled();
  });

  it('requires the conventional mutation idempotency header', async () => {
    const approveRepair = vi.fn();
    const mutation = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerEconomyRoutes(app, { approveRepair } as unknown as EconomyQueryService, {
      authenticate: vi.fn(async () => actor),
      mutation,
    });

    const result = await app.inject({
      body: {
        approvalId: repairApprovalId,
        authorityKind: 'creator',
        confirmation: 'APPROVE APPEND-ONLY ECONOMY REPAIR',
        planHash: repairPlanHash,
      },
      headers: { 'x-csrf-token': 'c'.repeat(32) },
      method: 'POST',
      url: `/api/v1/worlds/${worldId}/economy/repair-plans/${repairPlanId}/approvals`,
    });

    expect(result.statusCode, result.body).toBe(400);
    expect(mutation).not.toHaveBeenCalled();
    expect(approveRepair).not.toHaveBeenCalled();
  });
});
