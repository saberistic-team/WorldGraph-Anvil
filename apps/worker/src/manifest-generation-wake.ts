import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

import {
  MANIFEST_GENERATION_QUEUE,
  ManifestGenerationRequestedSchema,
  createValidator,
  type ManifestGenerationRequested,
  type Validator,
} from '@worldgraph/contracts';

import type { ManifestGenerationRunResult } from './manifest-generation-worker.js';

const requestValidator: Validator<ManifestGenerationRequested> =
  createValidator<ManifestGenerationRequested>(ManifestGenerationRequestedSchema);

export interface ManifestGenerationWakeCoordinator {
  wake(): Promise<ManifestGenerationRunResult[]>;
}

export interface ManifestGenerationWakeResult {
  processed: number;
}

export function createManifestGenerationWakeProcessor(
  coordinator: ManifestGenerationWakeCoordinator,
) {
  return async (job: Job<ManifestGenerationRequested>): Promise<ManifestGenerationWakeResult> => {
    requestValidator.assert(job.data);
    const results = await coordinator.wake();
    return { processed: results.length };
  };
}

export function createManifestGenerationWakeWorker(
  redis: Redis,
  coordinator: ManifestGenerationWakeCoordinator,
  logger: Logger,
): Worker<ManifestGenerationRequested> {
  const worker = new Worker<ManifestGenerationRequested>(
    MANIFEST_GENERATION_QUEUE,
    createManifestGenerationWakeProcessor(coordinator),
    {
      concurrency: 2,
      connection: redis,
      lockDuration: 15_000,
    },
  );
  worker.on('failed', (job) => {
    logger.error(
      { code: 'MANIFEST_GENERATION_WAKE_FAILED', jobId: job?.id },
      'manifest_generation.wake_failed',
    );
  });
  return worker;
}
