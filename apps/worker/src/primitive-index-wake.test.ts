import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { PrimitiveIndexRequested } from '@worldgraph/contracts';

import { createPrimitiveIndexWakeProcessor } from './primitive-index-wake.js';

const request: PrimitiveIndexRequested = {
  contentHash: 'a'.repeat(64),
  indexSchemaVersion: 1,
  primitiveVersionId: '018f0000-0000-7000-8000-000000000001',
  providerConfigurationId: 'disabled-v1',
  schemaVersion: 1,
  type: 'PrimitiveIndexRequested',
};

describe('primitive index BullMQ wake adapter', () => {
  it('validates the bounded message then wakes PostgreSQL reconciliation', async () => {
    const wake = vi.fn().mockResolvedValue([
      { job: null, outcome: 'disabled' as const },
      { job: null, outcome: 'stale' as const },
    ]);
    const process = createPrimitiveIndexWakeProcessor({ wake });

    await expect(process({ data: request } as Job<PrimitiveIndexRequested>)).resolves.toEqual({
      processed: 2,
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('rejects an unversioned or oversized wake message before reconciliation', async () => {
    const wake = vi.fn().mockResolvedValue([]);
    const process = createPrimitiveIndexWakeProcessor({ wake });

    await expect(
      process({
        data: { ...request, providerConfigurationId: 'x'.repeat(121) },
      } as Job<PrimitiveIndexRequested>),
    ).rejects.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });
});
