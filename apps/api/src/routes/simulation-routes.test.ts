import Fastify, { type FastifyInstance } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ScheduledActionV1,
  SimulationBatchRunV1,
  WorldSimulationClockV1,
} from '@worldgraph/contracts';

import type { WorldCommandService } from '../commands/service.js';
import type { AuthenticatedActor } from '../identity/service.js';
import { registerCommandRoutes } from './command-routes.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const scheduleId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const batchId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const requestId = '018f8652-3cb6-7d52-904b-cce7901d7e99';
const now = '2026-07-22T12:00:00.000Z';
const actor = {
  user: {
    id: '018f8652-3cb6-7d52-904b-cce7901d7e21',
    platformRole: 'user',
  },
} as AuthenticatedActor;

const action: ScheduledActionV1 = {
  actionSchemaVersion: 1,
  actionType: 'EmitWorldNoticeV1',
  cancelledCommandId: null,
  completedEventId: null,
  completedStateRevision: null,
  createdAt: now,
  createdBy: { actorId: actor.user.id, actorType: 'user' },
  createdCommandId: commandId,
  createdStateRevision: '7',
  dueTick: '3',
  id: scheduleId,
  payload: { text: 'Founding day begins.', visibility: 'member' },
  payloadHash: 'a'.repeat(64),
  priority: 0,
  processVersion: '1.0.0',
  scheduleSchemaVersion: 1,
  scheduleSequence: '1',
  status: 'scheduled',
  updatedAt: now,
  worldId,
};

const batch: SimulationBatchRunV1 = {
  attempts: 1,
  batchKey: 'b'.repeat(64),
  batchSchemaVersion: 1,
  commandId,
  completedAt: now,
  errorCode: null,
  fromTick: '0',
  id: batchId,
  inputChecksum: 'c'.repeat(64),
  outcomeHash: 'd'.repeat(64),
  processRegistryVersion: 1,
  startedAt: now,
  status: 'completed',
  toTick: '3',
  worldId,
};

const clock: WorldSimulationClockV1 = {
  clockSchemaVersion: 1,
  configuration: {
    epochAt: '2000-01-01T00:00:00.000Z',
    maxBatchTicks: 64,
    maxCatchUpTicks: 256,
    prngAlgorithmVersion: 'xorshift32-sha256-v1',
    wallCadenceMilliseconds: 10_000,
    worldMillisecondsPerTick: 86_400_000,
  },
  currentTick: '0',
  lastWallAnchorAt: null,
  mode: 'paused',
  outcomeHash: 'e'.repeat(64),
  projectionSchemaVersion: 1,
  rowVersion: '2',
  updatedAt: now,
  updatedStateRevision: '7',
  worldId,
};

const clockView = {
  aggregateVersion: '2',
  backlogCount: 1,
  canManage: true,
  canSchedule: true,
  clock,
  degradedWake: false,
  designVersion: '1',
  lastBatch: batch,
  nextDueAction: action,
  stateRevision: '7',
  worldTime: {
    epochAt: '2000-01-01T00:00:00.000Z',
    tick: '0',
    worldTimeAt: '2000-01-01T00:00:00.000Z',
    worldTimeUnixMilliseconds: '946684800000',
  },
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
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(typeof error === 'object' && error !== null && 'validation' in error ? 400 : 500)
      .send({
        error: { code: 'VALIDATION_FAILED', message: 'Request invalid.', requestId },
      }),
  );
  return app;
}

describe('simulation read routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('authenticates and binds clock, schedule, action, and batch reads to the world', async () => {
    const authenticate = vi.fn(async () => actor);
    const simulationClock = vi.fn(async () => clockView);
    const schedule = vi.fn(async () => ({ items: [action], nextCursor: '2' }));
    const scheduledAction = vi.fn(async () => action);
    const simulationBatches = vi.fn(async () => ({
      failures: [],
      items: [batch],
      nextCursor: null,
    }));
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(
      app,
      {
        schedule,
        scheduledAction,
        simulationBatches,
        simulationClock,
      } as unknown as WorldCommandService,
      { authenticate, mutation: async () => actor },
    );

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: `/api/v1/worlds/${worldId}/simulation/clock` }),
      app.inject({
        method: 'GET',
        url: `/api/v1/worlds/${worldId}/simulation/schedule?cursor=12&status=scheduled`,
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/worlds/${worldId}/simulation/schedule/${scheduleId}`,
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/worlds/${worldId}/simulation/batches?cursor=3&status=completed`,
      }),
    ]);

    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    expect(responses[0]?.json()).toEqual(clockView);
    expect(responses[1]?.json()).toEqual({ items: [action], nextCursor: '2' });
    expect(responses[2]?.json()).toEqual(action);
    expect(responses[3]?.json()).toEqual({ failures: [], items: [batch], nextCursor: null });
    expect(authenticate).toHaveBeenCalledTimes(4);
    expect(simulationClock).toHaveBeenCalledWith(actor, worldId);
    expect(schedule).toHaveBeenCalledWith(actor, worldId, {
      cursor: '12',
      status: 'scheduled',
    });
    expect(scheduledAction).toHaveBeenCalledWith(actor, worldId, scheduleId);
    expect(simulationBatches).toHaveBeenCalledWith(actor, worldId, {
      cursor: '3',
      status: 'completed',
    });
  });

  it('accepts bounded numeric limits from URL query strings', async () => {
    const authenticate = vi.fn(async () => actor);
    const schedule = vi.fn(async () => ({ items: [], nextCursor: null }));
    const simulationBatches = vi.fn(async () => ({ failures: [], items: [], nextCursor: null }));
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(
      app,
      { schedule, simulationBatches } as unknown as WorldCommandService,
      { authenticate, mutation: async () => actor },
    );

    const scheduleResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/simulation/schedule?limit=100`,
    });
    const batchResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/simulation/batches?limit=20`,
    });

    expect(scheduleResponse.statusCode, scheduleResponse.body).toBe(200);
    expect(batchResponse.statusCode, batchResponse.body).toBe(200);
    expect(schedule).toHaveBeenCalledOnce();
    expect(simulationBatches).toHaveBeenCalledOnce();
  });

  it('rejects malformed identifiers and unbounded query controls before authentication', async () => {
    const authenticate = vi.fn(async () => actor);
    const simulationClock = vi.fn();
    const schedule = vi.fn();
    const scheduledAction = vi.fn();
    const simulationBatches = vi.fn();
    const app = testApp();
    apps.push(app);
    await registerCommandRoutes(
      app,
      {
        schedule,
        scheduledAction,
        simulationBatches,
        simulationClock,
      } as unknown as WorldCommandService,
      { authenticate, mutation: async () => actor },
    );

    const invalidUrls = [
      '/api/v1/worlds/not-a-uuid/simulation/clock',
      `/api/v1/worlds/${worldId}/simulation/schedule/not-a-uuid`,
      `/api/v1/worlds/${worldId}/simulation/schedule?limit=0`,
      `/api/v1/worlds/${worldId}/simulation/batches?limit=101`,
      `/api/v1/worlds/${worldId}/simulation/schedule?operator=true`,
      `/api/v1/worlds/${worldId}/simulation/batches?status=${'x'.repeat(33)}`,
    ];
    const responses = await Promise.all(
      invalidUrls.map((url) => app.inject({ method: 'GET', url })),
    );

    for (const response of responses) expect(response.statusCode, response.body).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(simulationClock).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(scheduledAction).not.toHaveBeenCalled();
    expect(simulationBatches).not.toHaveBeenCalled();
  });
});
