import { describe, expect, it, vi } from 'vitest';

import type { CommerceScheduledCommandPort } from '@worldgraph/economy-command';

import type {
  CommerceScheduleRepository,
  CommerceScheduledEffectCandidate,
} from './commerce-schedule-repository.js';
import {
  CommerceScheduleCoordinator,
  CommerceScheduleRunner,
  commerceScheduleIdempotencyKeyV1,
  type CommerceScheduleWorkerMetrics,
} from './commerce-schedule-worker.js';

const candidate: CommerceScheduledEffectCandidate = {
  actionType: 'ExpireMarketListingV1',
  completedEventId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
  currentTick: '15',
  dueTick: '12',
  payload: { listingId: '018f8652-3cb6-7d52-904b-cce7901d7e28' },
  scheduleSequence: '7',
  scheduledActionId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
  worldId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
};

function logger() {
  return { error: vi.fn() } as never;
}

function metrics(): CommerceScheduleWorkerMetrics {
  return {
    recordCommand: vi.fn(),
    recordDiscovery: vi.fn(),
    recordScheduleLag: vi.fn(),
    recordSweep: vi.fn(),
  };
}

describe('commerce scheduled-effect worker', () => {
  it('derives the same bounded idempotency key from immutable schedule identity', () => {
    expect(commerceScheduleIdempotencyKeyV1(candidate)).toBe(
      `commerce-schedule-v1:ExpireMarketListingV1:${candidate.scheduledActionId}`,
    );
    expect(commerceScheduleIdempotencyKeyV1({ ...candidate })).toBe(
      commerceScheduleIdempotencyKeyV1(candidate),
    );
  });

  it('dispatches only target identity and schedule provenance, recording tick lag', async () => {
    const repository: CommerceScheduleRepository = {
      findPendingEffects: vi.fn(async () => [candidate]),
    };
    const execute = vi.fn<CommerceScheduledCommandPort['execute']>(async () => ({
      resultingStateRevision: '19',
      status: 'applied',
    }));
    const commands: CommerceScheduledCommandPort = { execute };
    const observed = metrics();
    const runner = new CommerceScheduleRunner(repository, commands, logger(), {
      batchSize: 25,
      ids: { next: () => '018f8652-3cb6-7d52-904b-cce7901d7e29' },
      metrics: observed,
      monotonicNow: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });
    await expect(runner.reconcile()).resolves.toEqual([
      {
        actionType: candidate.actionType,
        outcome: 'applied',
        scheduledActionId: candidate.scheduledActionId,
      },
    ]);
    expect(execute).toHaveBeenCalledWith({
      actionType: candidate.actionType,
      commandId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
      completedEventId: candidate.completedEventId,
      dueTick: candidate.dueTick,
      idempotencyKey: commerceScheduleIdempotencyKeyV1(candidate),
      payload: candidate.payload,
      scheduleSequence: candidate.scheduleSequence,
      scheduledActionId: candidate.scheduledActionId,
      worldId: candidate.worldId,
    });
    expect(observed.recordScheduleLag).toHaveBeenCalledWith(3, candidate.actionType);
  });

  it('uses the same key after a failed attempt so periodic recovery is idempotent', async () => {
    const execute = vi
      .fn<CommerceScheduledCommandPort['execute']>()
      .mockRejectedValueOnce(Object.assign(new Error('lost response'), { code: '08006' }))
      .mockResolvedValueOnce({ resultingStateRevision: '19', status: 'applied' });
    const repository: CommerceScheduleRepository = {
      findPendingEffects: vi.fn(async () => [candidate]),
    };
    const runner = new CommerceScheduleRunner(repository, { execute }, logger(), {
      batchSize: 25,
      ids: {
        next: (() => {
          let ordinal = 40;
          return () => `018f8652-3cb6-7d52-904b-cce7901d7e${ordinal++}`;
        })(),
      },
    });
    expect((await runner.reconcile())[0]?.outcome).toBe('failed');
    expect((await runner.reconcile())[0]?.outcome).toBe('applied');
    expect(execute.mock.calls[0]![0].idempotencyKey).toBe(execute.mock.calls[1]![0].idempotencyKey);
  });

  it('coalesces concurrent wakes and honors the reconciliation interval', async () => {
    let resolve!: (value: never[]) => void;
    const reconcile = vi.fn(() => new Promise<never[]>((done) => (resolve = done)));
    let now = 1_000;
    const coordinator = new CommerceScheduleCoordinator({ reconcile }, logger(), {
      monotonicNow: () => now,
      reconciliationIntervalMs: 100,
    });
    const first = coordinator.wake();
    expect(coordinator.wake()).toBe(first);
    resolve([]);
    await first;
    now = 1_050;
    await expect(coordinator.wake()).resolves.toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    now = 1_101;
    resolve = undefined as never;
    const second = coordinator.wake();
    expect(reconcile).toHaveBeenCalledTimes(2);
    resolve([]);
    await second;
    await coordinator.stop();
  });
});
