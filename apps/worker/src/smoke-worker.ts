import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

import {
  createValidator,
  SYSTEM_SMOKE_QUEUE,
  SystemSmokeRequestedSchema,
  type Clock,
  type SystemSmokeCompleted,
  type SystemSmokeRequested,
  type Validator,
} from '@worldgraph/contracts';
import { telemetry, withSpan } from '@worldgraph/observability';

const requestValidator: Validator<SystemSmokeRequested> = createValidator<SystemSmokeRequested>(
  SystemSmokeRequestedSchema,
);

export interface ProcessorResult {
  alreadyCompleted: boolean;
  completion: SystemSmokeCompleted;
}

export function createSmokeProcessor(redis: Redis, clock: Clock, logger: Logger) {
  return async (job: Job<SystemSmokeRequested>): Promise<ProcessorResult> => {
    requestValidator.assert(job.data);
    if (job.id !== job.data.jobId) throw new Error('SMOKE_JOB_ID_MISMATCH');

    return withSpan('worker.system-smoke', async (span) => {
      span.setAttribute('job.id', job.id ?? 'unknown');
      const completion: SystemSmokeCompleted = {
        completedAt: clock.now().toISOString(),
        jobId: job.data.jobId,
        requestId: job.data.requestId,
        schemaVersion: 1,
        type: 'SystemSmokeCompleted',
      };
      const key = `worldgraph:system:smoke-completed:${job.data.jobId}`;
      const inserted = await redis.set(key, JSON.stringify(completion), 'EX', 86_400, 'NX');
      const alreadyCompleted = inserted !== 'OK';
      telemetry.smokeJobs.add(1, { outcome: alreadyCompleted ? 'deduplicated' : 'completed' });
      logger.info(
        { alreadyCompleted, jobId: job.data.jobId, requestId: job.data.requestId },
        'system_smoke.completed',
      );
      return { alreadyCompleted, completion };
    });
  };
}

export function createSmokeWorker(
  redis: Redis,
  clock: Clock,
  logger: Logger,
): Worker<SystemSmokeRequested> {
  const worker = new Worker<SystemSmokeRequested>(
    SYSTEM_SMOKE_QUEUE,
    createSmokeProcessor(redis, clock, logger),
    { concurrency: 2, connection: redis, lockDuration: 15_000 },
  );
  worker.on('failed', (job, error) => {
    logger.error({ error, jobId: job?.id }, 'system_smoke.failed');
  });
  return worker;
}
