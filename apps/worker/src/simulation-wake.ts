import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

import {
  SimulationWakeMessageV1Schema,
  createValidator,
  type SimulationWakeMessageV1,
  type Validator,
} from '@worldgraph/contracts';

import type { SimulationRunResult, SimulationWorkerMetrics } from './simulation-worker.js';

export const SIMULATION_WAKE_QUEUE = 'simulation-wake' as const;

const wakeValidator: Validator<SimulationWakeMessageV1> = createValidator<SimulationWakeMessageV1>(
  SimulationWakeMessageV1Schema,
);

export interface SimulationWakeCoordinator {
  wake(): Promise<SimulationRunResult[]>;
}

export interface SimulationWakeResult {
  reconciled: number;
}

export interface SimulationWakeProcessorOptions {
  metrics?: Pick<SimulationWorkerMetrics, 'recordQueueWakeAge'>;
  now?: () => number;
}

/**
 * The validated job is deliberately discarded after waking reconciliation.
 * Its world/token fields are hints only; PostgreSQL discovery and lease
 * acquisition choose the work and fencing epoch.
 */
export function createSimulationWakeProcessor(
  coordinator: SimulationWakeCoordinator,
  options: SimulationWakeProcessorOptions = {},
) {
  const now = options.now ?? Date.now;
  return async (job: Job<SimulationWakeMessageV1>): Promise<SimulationWakeResult> => {
    wakeValidator.assert(job.data);
    if (Number.isFinite(job.timestamp)) {
      options.metrics?.recordQueueWakeAge(Math.max(0, now() - job.timestamp));
    }
    const results = await coordinator.wake();
    return { reconciled: results.length };
  };
}

export function createSimulationWakeWorker(
  redis: Redis,
  coordinator: SimulationWakeCoordinator,
  logger: Logger,
  options: SimulationWakeProcessorOptions = {},
): Worker<SimulationWakeMessageV1> {
  const worker = new Worker<SimulationWakeMessageV1>(
    SIMULATION_WAKE_QUEUE,
    createSimulationWakeProcessor(coordinator, options),
    { concurrency: 1, connection: redis, lockDuration: 30_000 },
  );
  worker.on('failed', (job) => {
    logger.warn({ code: 'SIMULATION_WAKE_FAILED', jobId: job?.id }, 'simulation.wake_failed');
  });
  worker.on('error', () => {
    logger.warn({ code: 'SIMULATION_REDIS_DEGRADED' }, 'simulation.redis_degraded');
  });
  return worker;
}
