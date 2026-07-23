import { createHash, timingSafeEqual } from 'node:crypto';

import {
  SYSTEM_SMOKE_QUEUE,
  type SmokeJobAccepted,
  type SystemSmokeRequested,
} from '@worldgraph/contracts';

import type { SmokeQueue } from './types.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function isOperationsTokenValid(provided: string | undefined, expected: string): boolean {
  if (!provided?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(provided.slice(7)), digest(expected));
}

export class SmokeService {
  public constructor(private readonly queue: SmokeQueue) {}

  public async enqueue(idempotencyKey: string, requestId: string): Promise<SmokeJobAccepted> {
    const jobId = `smoke-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 48)}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      return { jobId, status: state === 'completed' ? 'completed' : 'queued' };
    }

    const payload: SystemSmokeRequested = {
      jobId,
      requestId,
      schemaVersion: 1,
      type: 'SystemSmokeRequested',
    };
    await this.queue.add(SYSTEM_SMOKE_QUEUE, payload, {
      jobId,
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: false,
    });
    return { jobId, status: 'queued' };
  }
}
