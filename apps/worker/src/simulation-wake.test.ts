import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { SimulationWakeMessageV1 } from '@worldgraph/contracts';

import { createSimulationWakeProcessor } from './simulation-wake.js';

const message: SimulationWakeMessageV1 = {
  expectedLeaseFencingToken: '7',
  messageSchemaVersion: 1,
  messageType: 'SimulationWakeV1',
  worldId: '078f0000-0000-7000-8000-000000000001',
};

describe('disposable simulation BullMQ wake adapter', () => {
  it('validates a wake hint and triggers global PostgreSQL reconciliation only', async () => {
    const wake = vi
      .fn()
      .mockResolvedValue([{ attempts: 1, outcome: 'advanced', worldId: message.worldId }]);
    const processor = createSimulationWakeProcessor({ wake });

    await expect(processor({ data: message } as Job<SimulationWakeMessageV1>)).resolves.toEqual({
      reconciled: 1,
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith();
  });

  it('records non-negative queue wake age without using job or world identifiers as labels', async () => {
    const wake = vi.fn().mockResolvedValue([]);
    const recordQueueWakeAge = vi.fn();
    const processor = createSimulationWakeProcessor(
      { wake },
      { metrics: { recordQueueWakeAge }, now: () => 2_000 },
    );

    await processor({ data: message, timestamp: 1_250 } as Job<SimulationWakeMessageV1>);
    await processor({ data: message, timestamp: 2_500 } as Job<SimulationWakeMessageV1>);

    expect(recordQueueWakeAge.mock.calls).toEqual([[750], [0]]);
  });

  it('does not treat a stale queue fencing token or world ID as lease authority', async () => {
    const wake = vi.fn().mockResolvedValue([]);
    const processor = createSimulationWakeProcessor({ wake });

    await processor({ data: message } as Job<SimulationWakeMessageV1>);
    await processor({
      data: {
        ...message,
        expectedLeaseFencingToken: '999',
        worldId: '078f0000-0000-7000-8000-000000000099',
      },
    } as Job<SimulationWakeMessageV1>);

    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls).toEqual([[], []]);
  });

  it('rejects malformed or authority-bearing queue data before reconciliation', async () => {
    const wake = vi.fn().mockResolvedValue([]);
    const processor = createSimulationWakeProcessor({ wake });

    await expect(
      processor({
        data: { ...message, actorId: message.worldId },
      } as unknown as Job<SimulationWakeMessageV1>),
    ).rejects.toThrow();
    await expect(
      processor({
        data: { ...message, expectedLeaseFencingToken: '0' },
      } as Job<SimulationWakeMessageV1>),
    ).rejects.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });
});
