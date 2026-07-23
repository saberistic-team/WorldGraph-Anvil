import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import type { RuntimeConfig } from '@worldgraph/config';
import { RUNTIME_SCHEMA_VERSION, SystemClock } from '@worldgraph/contracts';
import { createLogger } from '@worldgraph/observability';
import { SequenceIdGenerator } from '@worldgraph/test-utils';

import { buildApp } from './app.js';

const requestIds = [
  '018f8652-3cb6-7d52-904b-cce7901d7e25',
  '018f8652-3cb6-7d52-904b-cce7901d7e26',
  '018f8652-3cb6-7d52-904b-cce7901d7e27',
  '018f8652-3cb6-7d52-904b-cce7901d7e28',
  '018f8652-3cb6-7d52-904b-cce7901d7e29',
];

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    allowedOrigins: ['http://localhost:3000'],
    apiHost: '127.0.0.1',
    apiPort: 4000,
    authPepper: 'test-only-auth-pepper-32-characters-long',
    buildRevision: 'test-revision',
    compilerEnabled: true,
    compilerMaxEntities: 2_000,
    compilerMaxRelationships: 8_000,
    databaseUrl: 'postgres://ignored',
    dependencyTimeoutMs: 100,
    economyDebitsFrozen: false,
    economyIssuanceEnabled: true,
    economyIssuanceRateLimitPerHour: 3,
    economyOfferRateLimitPerMinute: 10,
    economyOfferReconciliationBatchSize: 25,
    economyOfferReconciliationIntervalMs: 1_000,
    economyOffersEnabled: true,
    economyTransferRateLimitPerMinute: 20,
    economyTransfersEnabled: true,
    enableOperationalSmoke: false,
    enableLocalRegistration: true,
    environment: 'test',
    logLevel: 'fatal',
    manifestGenerationDailyBudgetMicrounits: 0,
    manifestGenerationEnabled: true,
    manifestGenerationMaxConcurrentPerUser: 2,
    manifestGenerationMaxConcurrentPerWorld: 1,
    manifestGenerationOutputTokenLimit: 4_096,
    manifestGenerationProvider: 'disabled',
    manifestGenerationProviderTimeoutMs: 8_000,
    manifestGenerationReconciliationIntervalMs: 2_000,
    manifestPromptRetentionDays: 30,
    primitiveEmbeddingCostBudgetMicrounits: 0,
    primitiveEmbeddingProviderTimeoutMs: 3_000,
    primitiveIndexMaxJobsPerReconciliation: 25,
    primitiveIndexReconciliationIntervalMs: 5_000,
    primitiveSemanticContributionEnabled: false,
    primitiveSemanticProfile: 'disabled',
    redisUrl: 'redis://ignored',
    requestTimeoutMs: 1_000,
    simulationContinuousEnabled: true,
    simulationLeaseMs: 30_000,
    simulationMaximumAttempts: 3,
    simulationMaximumBackoffMs: 5_000,
    simulationMaximumWorldsPerRun: 25,
    simulationReconciliationIntervalMs: 1_000,
    simulationRetryBaseMs: 250,
    sessionAbsoluteTtlSeconds: 86_400,
    sessionIdleTtlSeconds: 3_600,
    workerHeartbeatIntervalMs: 1_000,
    workerHeartbeatTtlMs: 5_000,
    workerHealthHost: '127.0.0.1',
    workerHealthPort: 4001,
    worldCompilationReconciliationIntervalMs: 2_000,
    ...overrides,
  };
}

async function appFor(runtimeConfig = config()) {
  return buildApp({
    clock: new SystemClock(),
    config: runtimeConfig,
    idGenerator: new SequenceIdGenerator(requestIds),
    logger: createLogger({
      buildRevision: 'test',
      environment: 'test',
      level: 'fatal',
      service: 'api-test',
    }),
    pool: { query: async () => ({ rows: [{ runtime_schema: RUNTIME_SCHEMA_VERSION }] }) },
    redis: {
      get: async () =>
        JSON.stringify({ at: new Date().toISOString(), buildRevision: 'test', schemaVersion: 1 }),
      ping: async () => 'PONG',
    },
    smokeQueue: {
      add: async () => ({ getState: async () => 'waiting' }),
      getJob: async () => undefined,
    },
  });
}

describe('system API', () => {
  it('serves live, ready and public version contracts with security headers', async () => {
    const app = await appFor();
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const info = await app.inject({ method: 'GET', url: '/api/v1/system/info' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect(live.headers['x-content-type-options']).toBe('nosniff');
    expect(ready.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ codename: 'Anvil', build: { api: 'test-revision' } });
    await app.close();
  });

  it('does not expose the smoke route when disabled', async () => {
    const app = await appFor();
    const response = await app.inject({
      method: 'POST',
      payload: {},
      url: '/api/v1/system/smoke-jobs',
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('enforces token and idempotency for enabled smoke jobs', async () => {
    let adds = 0;
    const app = await buildApp({
      clock: new SystemClock(),
      config: config({ enableOperationalSmoke: true, operationsToken: 'x'.repeat(32) }),
      idGenerator: new SequenceIdGenerator(requestIds),
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'api-test',
      }),
      pool: { query: async () => ({ rows: [{ runtime_schema: RUNTIME_SCHEMA_VERSION }] }) },
      redis: { get: async () => null, ping: async () => 'PONG' },
      smokeQueue: {
        add: async () => {
          adds += 1;
          return { getState: async () => 'waiting' };
        },
        getJob: async () => undefined,
      },
    });
    const unauthorized = await app.inject({
      headers: { authorization: 'Bearer invalid', 'idempotency-key': 'test-key-123' },
      method: 'POST',
      payload: {},
      url: '/api/v1/system/smoke-jobs',
    });
    const accepted = await app.inject({
      headers: { authorization: `Bearer ${'x'.repeat(32)}`, 'idempotency-key': 'test-key-123' },
      method: 'POST',
      payload: {},
      url: '/api/v1/system/smoke-jobs',
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(202);
    expect(adds).toBe(1);
    await app.close();
  });

  it('fails smoke enqueue quickly with a stable dependency error', async () => {
    const app = await buildApp({
      clock: new SystemClock(),
      config: config({ enableOperationalSmoke: true, operationsToken: 'x'.repeat(32) }),
      idGenerator: new SequenceIdGenerator(requestIds),
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'api-test',
      }),
      pool: { query: async () => ({ rows: [{ runtime_schema: 2 }] }) },
      redis: { get: async () => null, ping: async () => 'PONG' },
      smokeQueue: {
        add: async () => {
          throw new Error('redis offline');
        },
        getJob: async () => {
          throw new Error('redis offline');
        },
      },
    });
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${'x'.repeat(32)}`,
        'idempotency-key': 'test-key-offline',
      },
      method: 'POST',
      payload: {},
      url: '/api/v1/system/smoke-jobs',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'DEPENDENCY_NOT_READY' } });
    await app.close();
  });

  it('uses a restrictive origin policy', async () => {
    const app = await appFor();
    const allowed = await app.inject({
      headers: { origin: 'http://localhost:3000' },
      method: 'GET',
      url: '/health/live',
    });
    const denied = await app.inject({
      headers: { origin: 'https://attacker.example' },
      method: 'GET',
      url: '/health/live',
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('maps the global body budget to a stable non-internal error', async () => {
    const app = await appFor(
      config({
        enableOperationalSmoke: true,
        operationsToken: 'x'.repeat(32),
      }),
    );
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${'x'.repeat(32)}`,
        'idempotency-key': 'oversized-body-test',
      },
      method: 'POST',
      payload: { padding: 'x'.repeat(17 * 1024) },
      url: '/api/v1/system/smoke-jobs',
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    await app.close();
  });

  it('does not echo malformed JSON body text into responses or failure logs', async () => {
    const logChunks: string[] = [];
    const logger = pino(
      { level: 'warn' },
      new Writable({
        write(chunk, _encoding, callback) {
          logChunks.push(String(chunk));
          callback();
        },
      }),
    );
    const app = await buildApp({
      clock: new SystemClock(),
      config: config({ enableOperationalSmoke: true, operationsToken: 'x'.repeat(32) }),
      idGenerator: new SequenceIdGenerator(requestIds),
      logger,
      pool: { query: async () => ({ rows: [{ runtime_schema: RUNTIME_SCHEMA_VERSION }] }) },
      redis: { get: async () => null, ping: async () => 'PONG' },
      smokeQueue: {
        add: async () => ({ getState: async () => 'waiting' }),
        getJob: async () => undefined,
      },
    });
    const privateBody = 'guild SECRET phrase';
    const response = await app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: privateBody,
      url: '/api/v1/system/smoke-jobs',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(privateBody);
    expect(logChunks.join('')).not.toContain(privateBody);
    await app.close();
  });
});
