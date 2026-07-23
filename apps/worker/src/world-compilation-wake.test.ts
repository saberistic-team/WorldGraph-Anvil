import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  WORLD_COMPILATION_QUEUE_SCHEMA_VERSION,
  type WorldCompilationRequestedQueue,
} from '@worldgraph/contracts';

import { createWorldCompilationWakeProcessor } from './world-compilation-wake.js';

const request: WorldCompilationRequestedQueue = {
  compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
  compilerVersion: COMPILER_VERSION,
  inputHash: 'a'.repeat(64),
  manifestRevisionId: '058f0000-0000-7000-8000-000000000001',
  runId: '058f0000-0000-7000-8000-000000000002',
  schemaVersion: WORLD_COMPILATION_QUEUE_SCHEMA_VERSION,
  type: 'WorldCompilationRequested',
};

describe('world compilation wake processor', () => {
  it('treats a validated queue message as a wake hint and reports claimed work', async () => {
    const wake = vi.fn().mockResolvedValue([
      { job: null, outcome: 'idle' },
      { job: null, outcome: 'lost_claim' },
    ]);
    const processor = createWorldCompilationWakeProcessor({ wake });

    await expect(
      processor({ data: request } as Job<WorldCompilationRequestedQueue>),
    ).resolves.toEqual({
      processed: 2,
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed or future queue envelopes before waking PostgreSQL reconciliation', async () => {
    const wake = vi.fn().mockResolvedValue([]);
    const processor = createWorldCompilationWakeProcessor({ wake });
    const malformed = { ...request, compilerVersion: '2.0.0' };

    await expect(
      processor({ data: malformed } as unknown as Job<WorldCompilationRequestedQueue>),
    ).rejects.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });
});
