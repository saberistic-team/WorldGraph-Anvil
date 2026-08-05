import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { RedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SYSTEM_SMOKE_QUEUE, type SystemSmokeRequested } from '@worldgraph/contracts';
import { createLogger } from '@worldgraph/observability';
import { FixedClock } from '@worldgraph/test-utils';

import { createSmokeWorker } from './smoke-worker.js';

describe('system smoke queue', () => {
  let container: Awaited<ReturnType<RedisContainer['start']>>;
  let redis: Redis;

  beforeAll(async () => {
    container = await new RedisContainer('redis:8.4.5-alpine3.22').start();
    redis = new Redis(container.getConnectionUrl(), { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis?.quit();
    await container?.stop();
  });

  it('delivers a duplicate job ID once and preserves processor idempotency after restart', async () => {
    const logger = createLogger({
      buildRevision: 'test',
      environment: 'test',
      level: 'fatal',
      service: 'worker-test',
    });
    const clock = new FixedClock(new Date('2026-07-21T12:00:00.000Z'));
    const queue = new Queue<SystemSmokeRequested>(SYSTEM_SMOKE_QUEUE, { connection: redis });
    const queueEvents = new QueueEvents(SYSTEM_SMOKE_QUEUE, { connection: redis });
    await queueEvents.waitUntilReady();
    let worker = createSmokeWorker(redis, clock, logger);
    const payload: SystemSmokeRequested = {
      jobId: 'smoke-integration-test',
      requestId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
      schemaVersion: 1,
      type: 'SystemSmokeRequested',
    };

    const first = await queue.add(SYSTEM_SMOKE_QUEUE, payload, { jobId: payload.jobId });
    const duplicate = await queue.add(SYSTEM_SMOKE_QUEUE, payload, { jobId: payload.jobId });
    expect(duplicate.id).toBe(first.id);
    await first.waitUntilFinished(queueEvents, 10_000);
    expect(await redis.exists(`worldgraph:system:smoke-completed:${payload.jobId}`)).toBe(1);

    await worker.close();
    await queue.remove(payload.jobId);
    worker = createSmokeWorker(redis, clock, logger);
    const retried = await queue.add(SYSTEM_SMOKE_QUEUE, payload, { jobId: payload.jobId });
    const result = (await retried.waitUntilFinished(queueEvents, 10_000)) as {
      alreadyCompleted: boolean;
    };
    expect(result.alreadyCompleted).toBe(true);

    await worker.close();
    await queueEvents.close();
    await queue.close();
  });
});
