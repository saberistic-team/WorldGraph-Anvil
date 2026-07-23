import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthenticatedActor } from '../identity/service.js';
import type { ManifestService } from '../manifests/service.js';
import { registerManifestRoutes, type ManifestRouteAuthentication } from './manifest-routes.js';

const actor = {
  csrfHash: Buffer.alloc(32),
  session: {
    absoluteExpiresAt: '2026-07-22T12:00:00.000Z',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e20',
    idleExpiresAt: '2026-07-21T13:00:00.000Z',
  },
  user: {
    displayName: 'Creator',
    email: 'creator@example.test',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e21',
    platformRole: 'user',
    rowVersion: 1,
    status: 'active',
  },
} as AuthenticatedActor;

const authentication: ManifestRouteAuthentication = {
  authenticate: async () => actor,
  command: () => ({ idempotencyKey: 'manifest-route-test', requestId: 'request-test' }),
  mutation: async () => actor,
};

describe('manifest route response serialization', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('fails closed instead of serializing a field outside the registered contract', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.setErrorHandler((_error, request, reply) =>
      reply.code(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The request could not be completed.',
          requestId: request.id,
        },
      }),
    );
    const service = {
      generation: async () => ({
        attempts: 0,
        catalogSnapshotHash: null,
        completedAt: null,
        costEstimateMicrounits: null,
        errorCode: null,
        generatorSchemaVersion: 1,
        id: '018f8652-3cb6-7d52-904b-cce7901d7e30',
        inputHash: 'a'.repeat(64),
        inputTokenCount: null,
        model: null,
        outcome: null,
        outputRevisionId: null,
        outputTokenCount: null,
        progressPercent: 0,
        promptTemplateVersion: 1,
        promptText: 'must-never-reach-the-wire',
        provider: null,
        providerCallCount: 0,
        queuedAt: '2026-07-21T12:00:00.000Z',
        repairAttempts: 0,
        resolvedInputHash: null,
        rowVersion: 1,
        stage: 'queued',
        startedAt: null,
        status: 'queued',
        worldId: '018f8652-3cb6-7d52-904b-cce7901d7e22',
      }),
    };
    await registerManifestRoutes(app, service as unknown as ManifestService, authentication);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/manifest-generations/018f8652-3cb6-7d52-904b-cce7901d7e30',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('must-never-reach-the-wire');
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
});
