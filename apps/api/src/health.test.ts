import { describe, expect, it } from 'vitest';

import { RUNTIME_SCHEMA_VERSION } from '@worldgraph/contracts';
import { FixedClock } from '@worldgraph/test-utils';

import { HealthService } from './health.js';

describe('health aggregation', () => {
  it('separates dependency readiness from process liveness and recovers', async () => {
    let redisAvailable = false;
    const clock = new FixedClock(new Date('2026-07-21T12:00:00.000Z'));
    const service = new HealthService({
      clock,
      dependencyTimeoutMs: 50,
      pool: { query: async () => ({ rows: [{ runtime_schema: RUNTIME_SCHEMA_VERSION }] }) },
      redis: {
        get: async () =>
          redisAvailable
            ? JSON.stringify({
                at: clock.now().toISOString(),
                buildRevision: 'test',
                schemaVersion: 1,
              })
            : null,
        ping: async () => {
          if (!redisAvailable) throw new Error('offline');
          return 'PONG';
        },
      },
      workerHeartbeatTtlMs: 15_000,
    });

    await expect(service.readiness()).resolves.toEqual([
      { name: 'api', status: 'healthy' },
      { name: 'postgresql', status: 'healthy' },
      { code: 'REDIS_UNAVAILABLE', name: 'redis', status: 'unavailable' },
      { code: 'WORKER_HEARTBEAT_MISSING', name: 'worker', status: 'unavailable' },
    ]);
    redisAvailable = true;
    expect((await service.readiness()).every((component) => component.status === 'healthy')).toBe(
      true,
    );
  });

  it('bounds a hanging probe', async () => {
    const service = new HealthService({
      clock: new FixedClock(new Date('2026-07-21T12:00:00.000Z')),
      dependencyTimeoutMs: 10,
      pool: { query: async () => new Promise(() => undefined) },
      redis: { get: async () => null, ping: async () => 'PONG' },
      workerHeartbeatTtlMs: 15_000,
    });
    expect(await service.readiness()).toContainEqual({
      code: 'POSTGRESQL_UNAVAILABLE',
      name: 'postgresql',
      status: 'unavailable',
    });
  });
});
