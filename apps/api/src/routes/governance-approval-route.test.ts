import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '@worldgraph/config';

import { ApplicationError } from '../application/errors.js';
import type { IdentityService } from '../identity/service.js';
import type { WorldService } from '../worlds/service.js';
import { registerDomainRoutes } from './domain-routes.js';

const csrf = 'c'.repeat(43);
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const actor = {
  csrfHash: Buffer.alloc(32, 1),
  session: {
    absoluteExpiresAt: '2026-08-03T13:00:00.000Z',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e22',
    idleExpiresAt: '2026-08-03T12:30:00.000Z',
  },
  user: {
    displayName: 'Reviewer',
    email: 'reviewer@example.test',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e21',
    platformRole: 'platform_admin',
    rowVersion: 1,
    status: 'active',
  },
} as const;
const payload = {
  command: {
    actorMode: 'creator',
    commandId,
    expectedAggregateVersion: '0',
    expectedStateRevision: '4',
    expectedTick: '10',
    expectedWorldVersion: '1',
    idempotencyKey: 'governance-approval-route-command',
    payload: {
      approvalId: null,
      confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
      expectedCurrentResultChecksum: 'a'.repeat(64),
      reason: 'Recompute the frozen ballots and append linked evidence.',
      repairKind: 'proposal_recount',
      replacementResultChecksum: 'b'.repeat(64),
      sourceResultId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
    },
    schemaVersion: 1,
    type: 'RepairGovernanceResultV1',
  },
  password: 'correct horse battery',
  worldId,
} as const;

describe('governance approval route', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('uses authenticated mutation guards and forwards the idempotency identity', async () => {
    const approve = vi.fn(async () => ({
      approvalId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
      commandId,
      expiresAt: '2026-08-03T12:15:00.000Z',
    }));
    const app = await testApp(approve);
    apps.push(app);

    const response = await app.inject({
      headers: approvalHeaders('governance-approval-route-key'),
      method: 'POST',
      payload,
      url: '/api/v1/auth/governance-approval',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(approve).toHaveBeenCalledWith(
      actor,
      payload,
      expect.any(String),
      'governance-approval-route-key',
    );
  });

  it('rejects wrong-origin and missing-CSRF requests before approval', async () => {
    const approve = vi.fn();
    const app = await testApp(approve);
    apps.push(app);

    const wrongOrigin = await app.inject({
      headers: { ...approvalHeaders('governance-approval-origin'), origin: 'https://evil.test' },
      method: 'POST',
      payload,
      url: '/api/v1/auth/governance-approval',
    });
    const missingCsrf = await app.inject({
      headers: {
        cookie: 'wg_session=session-token; wg_csrf=missing',
        'idempotency-key': 'governance-approval-missing-csrf',
        origin: 'http://localhost:3000',
      },
      method: 'POST',
      payload,
      url: '/api/v1/auth/governance-approval',
    });

    expect(wrongOrigin.statusCode).toBe(403);
    expect(missingCsrf.statusCode).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });

  it('rate limits the sixth approval authentication attempt for one session', async () => {
    const approve = vi.fn(async () => ({
      approvalId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
      commandId,
      expiresAt: '2026-08-03T12:15:00.000Z',
    }));
    const app = await testApp(approve);
    apps.push(app);
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push(
        (
          await app.inject({
            headers: approvalHeaders(`governance-approval-rate-${attempt}`),
            method: 'POST',
            payload,
            url: '/api/v1/auth/governance-approval',
          })
        ).statusCode,
      );
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(approve).toHaveBeenCalledTimes(5);
  });
});

function approvalHeaders(idempotencyKey: string): Record<string, string> {
  return {
    cookie: `wg_session=session-token; wg_csrf=${csrf}`,
    'idempotency-key': idempotencyKey,
    origin: 'http://localhost:3000',
    'x-csrf-token': csrf,
  };
}

async function testApp(approve: ReturnType<typeof vi.fn>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    discriminator: true,
    removeAdditional: false,
    strict: true,
  });
  addFormats(ajv);
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema));
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, request, reply) => {
    const applicationError =
      error instanceof ApplicationError
        ? error
        : new ApplicationError('INTERNAL_ERROR', 'The request failed.', 500);
    return reply.code(applicationError.statusCode).send({
      error: {
        code: applicationError.code,
        message: applicationError.message,
        requestId: request.id,
      },
    });
  });
  const identity = {
    approveGovernanceOperation: approve,
    assertCsrf: vi.fn(
      (_actor: unknown, cookieToken: string | undefined, headerToken: string | undefined) => {
        if (cookieToken !== csrf || headerToken !== csrf) {
          throw new ApplicationError('CSRF_INVALID', 'The CSRF token is invalid.', 403);
        }
      },
    ),
    authenticate: vi.fn(async () => actor),
  } as unknown as IdentityService;
  await registerDomainRoutes(app, { identity, worlds: {} as WorldService }, {
    allowedOrigins: ['http://localhost:3000'],
    authPepper: 'test-auth-pepper-that-is-at-least-thirty-two-characters',
  } as RuntimeConfig);
  return app;
}
