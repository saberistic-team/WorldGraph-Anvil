import type { Job } from 'bullmq';
import type { ManifestGenerationRequested } from '@worldgraph/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createManifestGenerationWakeProcessor } from './manifest-generation-wake.js';

const request: ManifestGenerationRequested = {
  generatorSchemaVersion: 1,
  inputHash: 'a'.repeat(64),
  promptTemplateVersion: 1,
  providerConfigurationId: 'disabled-v1',
  runId: '018f0000-0000-7000-8000-000000000001',
  schemaVersion: 1,
  type: 'ManifestGenerationRequested',
  validatorVersion: 1,
};

describe('manifest generation BullMQ wake adapter', () => {
  it('validates the ID/hash-only message and wakes PostgreSQL reconciliation', async () => {
    const wake = vi.fn().mockResolvedValue([
      { job: null, outcome: 'succeeded' as const },
      { job: null, outcome: 'retry_scheduled' as const },
    ]);
    const process = createManifestGenerationWakeProcessor({ wake });

    await expect(process({ data: request } as Job<ManifestGenerationRequested>)).resolves.toEqual({
      processed: 2,
    });
    expect(wake).toHaveBeenCalledOnce();
    expect(request).not.toHaveProperty('prompt');
  });

  it('rejects an oversized or stale-profile wake before touching durable work', async () => {
    const wake = vi.fn().mockResolvedValue([]);
    const process = createManifestGenerationWakeProcessor({ wake });

    await expect(
      process({
        data: { ...request, providerConfigurationId: 'x'.repeat(121) },
      } as Job<ManifestGenerationRequested>),
    ).rejects.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });
});
