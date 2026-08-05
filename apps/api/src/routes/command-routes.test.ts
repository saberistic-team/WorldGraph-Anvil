import Fastify, { type FastifyInstance } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedActor } from '../identity/service.js';
import { ApplicationError } from '../application/errors.js';
import type { WorldCommandService } from '../commands/service.js';
import { registerCommandRoutes } from './command-routes.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const actor = {
  user: {
    id: '018f8652-3cb6-7d52-904b-cce7901d7e21',
    platformRole: 'user',
  },
} as AuthenticatedActor;

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
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        error instanceof ApplicationError
          ? error.statusCode
          : typeof error === 'object' && error !== null && 'validation' in error
            ? 400
            : 500,
      )
      .send({
        error: {
          code: error instanceof ApplicationError ? error.code : 'VALIDATION_FAILED',
          message: error instanceof ApplicationError ? error.message : 'Request invalid.',
          requestId: commandId,
        },
      }),
  );
  return app;
}

describe('command routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('rejects forged actor/override metadata before invoking the command bus', async () => {
    const submit = vi.fn();
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(app, { submit } as unknown as WorldCommandService, {
      authenticate: async () => actor,
      mutation: async () => actor,
    });

    const response = await app.inject({
      method: 'POST',
      payload: {
        actor: { actorId: actor.user.id, actorType: 'user' },
        commandId,
        expectedAggregateVersion: '0',
        expectedStateRevision: '0',
        expectedWorldVersion: '1',
        idempotencyKey: 'rename-command-key',
        overrideId: commandId,
        payload: { entityKey: 'district:civic-platform', newDisplayName: 'Civic Commons' },
        schemaVersion: 1,
        type: 'RenameWorldEntityV1',
      },
      url: `/api/v1/worlds/${worldId}/commands`,
    });

    expect(response.statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it('allows a bounded unknown discriminator to reach durable bus rejection', async () => {
    const submit = vi.fn(async () => ({
      httpStatus: 422 as const,
      result: {
        commandId,
        currentStateRevision: '0',
        eventIds: [],
        rejectionCode: 'COMMAND_TYPE_DISABLED' as const,
        schemaVersion: 1 as const,
        status: 'rejected' as const,
      },
    }));
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(app, { submit } as unknown as WorldCommandService, {
      authenticate: async () => actor,
      mutation: async () => actor,
    });

    const response = await app.inject({
      method: 'POST',
      payload: {
        commandId,
        expectedAggregateVersion: '0',
        expectedStateRevision: '0',
        expectedWorldVersion: '1',
        idempotencyKey: 'unknown-command-key',
        payload: {},
        schemaVersion: 9,
        type: 'UnknownCommandV9',
      },
      url: `/api/v1/worlds/${worldId}/commands`,
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ rejectionCode: 'COMMAND_TYPE_DISABLED' });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('accepts a bounded system actor identifier as a history filter', async () => {
    const history = vi.fn(async () => ({ items: [], nextCursor: null }));
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(app, { history } as unknown as WorldCommandService, {
      authenticate: async () => actor,
      mutation: async () => actor,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/history?actorId=worldgraph:compiler`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    expect(history).toHaveBeenCalledWith(actor, worldId, { actorId: 'worldgraph:compiler' });
  });

  it('requires a recent credential before a governance override or repair reaches the bus', async () => {
    const submit = vi.fn();
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(app, { submit } as unknown as WorldCommandService, {
      authenticate: async () => actor,
      mutation: async () => actor,
    });

    const response = await app.inject({
      method: 'POST',
      payload: repairCommand(),
      url: `/api/v1/worlds/${worldId}/commands`,
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'RECENT_CREDENTIAL_REQUIRED' } });
    expect(submit).not.toHaveBeenCalled();
  });

  it('passes only server-derived recent-credential evidence for the exact privileged request', async () => {
    const result = {
      httpStatus: 200 as const,
      result: {
        commandId,
        eventIds: ['018f8652-3cb6-7d52-904b-cce7901d7e24'],
        eventSequenceRange: { from: '5', to: '5' },
        ledgerSequenceRange: { from: '8', to: '9' },
        resultingStateRevision: '5',
        schemaVersion: 1 as const,
        status: 'accepted' as const,
      },
    };
    const submit = vi.fn(async () => result);
    const recentCredential = vi.fn(() => ({
      commandRequestHash: Buffer.alloc(32, 1),
      proofHash: Buffer.alloc(32, 2),
      sessionId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
      userId: actor.user.id,
    }));
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(app, { submit } as unknown as WorldCommandService, {
      authenticate: async () => actor,
      mutation: async () => actor,
      recentCredential,
    });
    const command = repairCommand();

    const response = await app.inject({
      headers: { 'x-recent-credential-proof': 'p'.repeat(43) },
      method: 'POST',
      payload: command,
      url: `/api/v1/worlds/${worldId}/commands`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(recentCredential).toHaveBeenCalledWith(actor, 'p'.repeat(43), command);
    expect(submit).toHaveBeenCalledWith(
      actor,
      worldId,
      command,
      expect.any(String),
      expect.objectContaining({ proofHash: Buffer.alloc(32, 2) }),
    );
  });

  it('returns the stable invalid-proof error for a present malformed credential', async () => {
    const submit = vi.fn();
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(app, { submit } as unknown as WorldCommandService, {
      authenticate: async () => actor,
      mutation: async () => actor,
      recentCredential: () => {
        throw new ApplicationError(
          'RECENT_CREDENTIAL_INVALID',
          'The recent-credential proof is invalid or expired.',
          403,
        );
      },
    });

    const response = await app.inject({
      headers: { 'x-recent-credential-proof': 'short' },
      method: 'POST',
      payload: repairCommand(),
      url: `/api/v1/worlds/${worldId}/commands`,
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'RECENT_CREDENTIAL_INVALID' } });
    expect(submit).not.toHaveBeenCalled();
  });
});

function repairCommand() {
  return {
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
      sourceResultId: '018f8652-3cb6-7d52-904b-cce7901d7e24',
    },
    schemaVersion: 1,
    type: 'RepairGovernanceResultV1',
  } as const;
}
