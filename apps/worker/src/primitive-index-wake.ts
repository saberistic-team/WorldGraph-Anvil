import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

import {
  createValidator,
  PRIMITIVE_INDEX_QUEUE,
  PrimitiveIndexRequestedSchema,
  type PrimitiveIndexRequested,
  type Validator,
} from '@worldgraph/contracts';

import type { PrimitiveIndexRunResult } from './primitive-index-worker.js';

const requestValidator: Validator<PrimitiveIndexRequested> =
  createValidator<PrimitiveIndexRequested>(PrimitiveIndexRequestedSchema);

export interface PrimitiveIndexWakeResult {
  processed: number;
}

export interface PrimitiveIndexWakeCoordinator {
  wake(): Promise<PrimitiveIndexRunResult[]>;
}

export function createPrimitiveIndexWakeProcessor(coordinator: PrimitiveIndexWakeCoordinator) {
  return async (job: Job<PrimitiveIndexRequested>): Promise<PrimitiveIndexWakeResult> => {
    requestValidator.assert(job.data);
    const results = await coordinator.wake();
    return { processed: results.length };
  };
}

export function createPrimitiveIndexWakeWorker(
  redis: Redis,
  coordinator: PrimitiveIndexWakeCoordinator,
  logger: Logger,
): Worker<PrimitiveIndexRequested> {
  const worker = new Worker<PrimitiveIndexRequested>(
    PRIMITIVE_INDEX_QUEUE,
    createPrimitiveIndexWakeProcessor(coordinator),
    {
      concurrency: 2,
      connection: redis,
      lockDuration: 15_000,
    },
  );
  worker.on('failed', (job) => {
    logger.error(
      { code: 'PRIMITIVE_INDEX_WAKE_FAILED', jobId: job?.id },
      'primitive_index.wake_failed',
    );
  });
  return worker;
}
