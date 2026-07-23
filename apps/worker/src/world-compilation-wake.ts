import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

import {
  WORLD_COMPILATION_QUEUE,
  WorldCompilationRequestedQueueSchema,
  createValidator,
  type Validator,
  type WorldCompilationRequestedQueue,
} from '@worldgraph/contracts';

import type { WorldCompilationRunResult } from './world-compilation-worker.js';

const requestValidator: Validator<WorldCompilationRequestedQueue> =
  createValidator<WorldCompilationRequestedQueue>(WorldCompilationRequestedQueueSchema);

export interface WorldCompilationWakeCoordinator {
  wake(): Promise<WorldCompilationRunResult[]>;
}

export interface WorldCompilationWakeResult {
  processed: number;
}

export function createWorldCompilationWakeProcessor(coordinator: WorldCompilationWakeCoordinator) {
  return async (job: Job<WorldCompilationRequestedQueue>): Promise<WorldCompilationWakeResult> => {
    requestValidator.assert(job.data);
    const results = await coordinator.wake();
    return { processed: results.length };
  };
}

export function createWorldCompilationWakeWorker(
  redis: Redis,
  coordinator: WorldCompilationWakeCoordinator,
  logger: Logger,
): Worker<WorldCompilationRequestedQueue> {
  const worker = new Worker<WorldCompilationRequestedQueue>(
    WORLD_COMPILATION_QUEUE,
    createWorldCompilationWakeProcessor(coordinator),
    { concurrency: 1, connection: redis, lockDuration: 30_000 },
  );
  worker.on('failed', (job) => {
    logger.error(
      { code: 'WORLD_COMPILATION_WAKE_FAILED', jobId: job?.id },
      'world_compilation.wake_failed',
    );
  });
  return worker;
}
