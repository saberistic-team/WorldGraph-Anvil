import { describe, expect, it, vi } from 'vitest';

import { reconcilePrimitiveIndexJobs } from './primitive-index-startup.js';

describe('primitive index startup reconciliation', () => {
  it('discovers every missing current-profile job in bounded batches', async () => {
    const ensureCurrentJobs = vi
      .fn()
      .mockResolvedValueOnce({ inserted: 2, remaining: 1 })
      .mockResolvedValueOnce({ inserted: 1, remaining: 0 });

    await expect(
      reconcilePrimitiveIndexJobs({ ensureCurrentJobs }, 'local-hash-1536-v1', 2),
    ).resolves.toBe(3);
    expect(ensureCurrentJobs).toHaveBeenNthCalledWith(1, 'local-hash-1536-v1', 1, 2);
    expect(ensureCurrentJobs).toHaveBeenCalledTimes(2);
  });

  it('fails closed when reconciliation makes no forward progress', async () => {
    const ensureCurrentJobs = vi.fn(async () => ({ inserted: 0, remaining: 1 }));
    await expect(
      reconcilePrimitiveIndexJobs({ ensureCurrentJobs }, 'local-hash-1536-v1', 25),
    ).rejects.toThrow('PRIMITIVE_INDEX_DISCOVERY_LIMIT_EXCEEDED');
    expect(ensureCurrentJobs).toHaveBeenCalledTimes(8);
  });

  it('re-queries boundedly when another worker wins the same missing-job insert race', async () => {
    const ensureCurrentJobs = vi
      .fn()
      .mockResolvedValueOnce({ inserted: 0, remaining: 1 })
      .mockResolvedValueOnce({ inserted: 0, remaining: 0 });

    await expect(
      reconcilePrimitiveIndexJobs({ ensureCurrentJobs }, 'local-hash-1536-v1', 25),
    ).resolves.toBe(0);
    expect(ensureCurrentJobs).toHaveBeenCalledTimes(2);
  });

  it('honors the supported one-job batch size beyond forty catalog versions', async () => {
    let remaining = 41;
    const ensureCurrentJobs = vi.fn(async () => {
      remaining -= 1;
      return { inserted: 1, remaining };
    });

    await expect(
      reconcilePrimitiveIndexJobs({ ensureCurrentJobs }, 'local-hash-1536-v1', 1),
    ).resolves.toBe(41);
    expect(ensureCurrentJobs).toHaveBeenCalledTimes(41);
  });
});
