import Fastify, { type FastifyInstance } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommerceReadService } from '../economy/commerce-read-service.js';
import type { AuthenticatedActor } from '../identity/service.js';
import { registerCommerceReadRoutes } from './commerce-read-routes.js';

const actor = {
  user: {
    id: '018f8652-3cb6-7d52-904b-cce7901d7e21',
    platformRole: 'user',
  },
} as AuthenticatedActor;
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const projection = {
  checkpointVersion: '17',
  currentStateRevision: '19',
  lagRevisions: '2',
  status: 'catching_up' as const,
};

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
    const invalid = typeof error === 'object' && error !== null && 'validation' in error;
    return reply.code(invalid ? 400 : 500).send({
      error: {
        code: invalid ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR',
        message: invalid ? 'Request invalid.' : 'Failed.',
        requestId: '018f8652-3cb6-7d52-904b-cce7901d7e99',
      },
    });
  });
  return app;
}

describe('commerce read routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('authenticates and returns strict projection metadata with resource pages', async () => {
    const resources = vi.fn(async () => ({
      items: [
        {
          displayName: 'Iron ore',
          id: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          primitiveContentHash: 'a'.repeat(64),
          primitiveVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
          quantityScale: 2,
          rowVersion: '1',
          schemaVersion: 1 as const,
          stableKey: 'resource:iron-ore',
          status: 'active' as const,
          unitCode: 'kg',
          worldId,
        },
      ],
      nextCursor: null,
      projection,
    }));
    const authenticate = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerCommerceReadRoutes(app, { resources } as unknown as CommerceReadService, {
      authenticate,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/resources?limit=25&status=active`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ projection, items: [{ unitCode: 'kg' }] });
    expect(resources).toHaveBeenCalledWith(actor, worldId, { limit: '25', status: 'active' });
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('returns the fee as a mandatory part of an authenticated purchase preview', async () => {
    const purchasePreview = vi.fn(async () => ({
      preview: {
        buyerTotalMinor: '108',
        currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e28',
        feeMinor: '3',
        grossMinor: '100',
        listingId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        listingVersion: '4',
        quantity: '2.50',
        quoteHash: 'b'.repeat(64),
        sellerNetMinor: '100',
        taxMinor: '5',
      },
      projection,
    }));
    const app = testApp();
    apps.push(app);
    await registerCommerceReadRoutes(app, { purchasePreview } as unknown as CommerceReadService, {
      authenticate: async () => actor,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/market/listings/018f8652-3cb6-7d52-904b-cce7901d7e29/purchase-preview?quantity=2.50`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const rawBody: unknown = response.json();
    const body = rawBody as Awaited<ReturnType<CommerceReadService['purchasePreview']>>;
    expect(body.preview).toMatchObject({
      buyerTotalMinor: '108',
      feeMinor: '3',
      grossMinor: '100',
      taxMinor: '5',
    });
  });

  it('scopes minimal employment candidates to the requested managed business', async () => {
    const businessId = '118f8652-3cb6-7d52-904b-cce7901d7e25';
    const employmentCandidates = vi.fn(async () => ({
      items: [
        {
          businessId,
          currencyId: '218f8652-3cb6-7d52-904b-cce7901d7e25',
          workerEntityKey: 'character:eligible-worker',
          workerWalletId: '318f8652-3cb6-7d52-904b-cce7901d7e25',
        },
      ],
      nextCursor: null,
      projection,
    }));
    const app = testApp();
    apps.push(app);
    await registerCommerceReadRoutes(
      app,
      { employmentCandidates } as unknown as CommerceReadService,
      { authenticate: async () => actor },
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/businesses/${businessId}/employment-candidates?limit=25`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          businessId,
          currencyId: '218f8652-3cb6-7d52-904b-cce7901d7e25',
          workerEntityKey: 'character:eligible-worker',
          workerWalletId: '318f8652-3cb6-7d52-904b-cce7901d7e25',
        },
      ],
      nextCursor: null,
      projection,
    });
    expect(employmentCandidates).toHaveBeenCalledWith(actor, worldId, businessId, { limit: '25' });
  });

  it('serves the bounded aggregate transaction contract without account detail', async () => {
    const transactions = vi.fn(async () => ({
      items: [
        {
          currencyId: '218f8652-3cb6-7d52-904b-cce7901d7e25',
          grossMinor: '100',
          id: '318f8652-3cb6-7d52-904b-cce7901d7e25',
          kind: 'payroll' as const,
          netMinor: '90',
          occurredTick: '9',
          payrollRecordId: '418f8652-3cb6-7d52-904b-cce7901d7e25',
          taxMinor: '10',
          worldId,
        },
      ],
      nextCursor: null,
      projection,
    }));
    const authenticate = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerCommerceReadRoutes(app, { transactions } as unknown as CommerceReadService, {
      authenticate,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/transactions?limit=25`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          currencyId: '218f8652-3cb6-7d52-904b-cce7901d7e25',
          grossMinor: '100',
          id: '318f8652-3cb6-7d52-904b-cce7901d7e25',
          kind: 'payroll',
          netMinor: '90',
          occurredTick: '9',
          payrollRecordId: '418f8652-3cb6-7d52-904b-cce7901d7e25',
          taxMinor: '10',
          worldId,
        },
      ],
      nextCursor: null,
      projection,
    });
    expect(transactions).toHaveBeenCalledWith(actor, worldId, { limit: '25' });
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('rejects unknown query fields before authentication', async () => {
    const authenticate = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerCommerceReadRoutes(
      app,
      { resources: vi.fn() } as unknown as CommerceReadService,
      { authenticate },
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/resources?unsafeParticipantId=${actor.user.id}`,
    });

    expect(response.statusCode).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });
});
