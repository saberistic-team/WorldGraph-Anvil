import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import type { IdGenerator } from '@worldgraph/contracts';

import type { DueAssetTransferOffer } from './economy-offer-repository.js';
import { EconomyOfferCoordinator, EconomyOfferRunner } from './economy-offer-worker.js';

const due: DueAssetTransferOffer = {
  currentTick: '12',
  expectedOfferVersion: '1',
  expectedStateRevision: '8',
  expectedWorldVersion: '2',
  expiresAtTick: '10',
  offerId: '018f8652-3cb6-7d52-904b-cce7901d7e24',
  worldId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
};

const operationalSnapshot = {
  activeReservationCount: 1,
  assetCount: 1,
  currencyCount: 1,
  failedPayrollCount: 0,
  failedProductionRunCount: 0,
  lastRepairTimestampSeconds: 0,
  marketVolumeTrades: 1,
  maxProductionOverdueTicks: 0,
  maxReservationAgeTicks: 2,
  openExpiredOfferCount: 1,
  openOfferCount: 1,
  overdueProductionRunCount: 0,
  reconciliationMismatchCount: 0,
  staleListingCount: 1,
  taxSettlementCount: 1,
  treasuryReconciliationDeltaMinor: 0,
  treasuryReconciliationMismatchCount: 0,
  walletCount: 3,
};

describe('authoritative-tick economy offer reconciler', () => {
  it('uses a fixed offer/expiry idempotency key and never consults wall time for due-ness', async () => {
    const expire = vi.fn(async () => ({
      resultingStateRevision: '9',
      status: 'expired' as const,
    }));
    const ids = sequenceIds();
    const metrics = metricsFixture();
    const runner = new EconomyOfferRunner(
      {
        findDueOffers: vi.fn(async () => [due]),
        readOperationalSnapshot: vi.fn(async () => operationalSnapshot),
      },
      { expire },
      pino({ enabled: false }),
      { batchSize: 25, ids, metrics, monotonicNow: sequenceNow(100, 108) },
    );

    await expect(runner.reconcile()).resolves.toEqual([{ outcome: 'expired' }]);
    expect(expire).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTick: '12',
        idempotencyKey: `economy-offer-expiry-v1:${due.offerId}:10`,
        offerId: due.offerId,
      }),
    );
    expect(metrics.recordTickLag).toHaveBeenCalledWith(2);
    expect(metrics.recordOperationalSnapshot).toHaveBeenCalledWith(operationalSnapshot);
    expect(metrics.recordSweep).toHaveBeenCalledWith(8, 'succeeded');
  });

  it('continues a bounded batch after one candidate fails and records a failed sweep', async () => {
    const second = { ...due, offerId: '018f8652-3cb6-7d52-904b-cce7901d7e26' };
    const expire = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ status: 'already_terminal' as const });
    const metrics = metricsFixture();
    const runner = new EconomyOfferRunner(
      {
        findDueOffers: vi.fn(async () => [due, second]),
        readOperationalSnapshot: vi.fn(async () => operationalSnapshot),
      },
      { expire },
      pino({ enabled: false }),
      { batchSize: 2, ids: sequenceIds(), metrics, monotonicNow: sequenceNow(10, 15) },
    );

    await expect(runner.reconcile()).resolves.toEqual([
      { outcome: 'failed' },
      { outcome: 'already_terminal' },
    ]);
    expect(expire).toHaveBeenCalledTimes(2);
    expect(metrics.recordSweep).toHaveBeenCalledWith(5, 'failed');
  });

  it('coalesces concurrent wakes and stops independently of Redis availability', async () => {
    let resolve!: (value: []) => void;
    const reconcile = vi
      .fn<() => Promise<[]>>()
      .mockImplementationOnce(() => new Promise<[]>((resolvePromise) => (resolve = resolvePromise)))
      .mockResolvedValue([]);
    let now = 1_000;
    const coordinator = new EconomyOfferCoordinator({ reconcile }, pino({ enabled: false }), {
      monotonicNow: () => now,
      reconciliationIntervalMs: 100,
    });
    const first = coordinator.wake();
    const second = coordinator.wake();
    expect(second).toBe(first);
    expect(reconcile).toHaveBeenCalledOnce();
    resolve([]);
    await first;
    now += 100;
    await coordinator.wake();
    expect(reconcile).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });
});

function sequenceIds(): IdGenerator {
  let sequence = 0x30;
  return {
    next: () => `018f8652-3cb6-7d52-904b-cce7901d7e${(sequence++).toString(16)}`,
  };
}

function sequenceNow(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function metricsFixture() {
  return {
    recordDiscovery: vi.fn(),
    recordExpiry: vi.fn(),
    recordOperationalSnapshot: vi.fn(),
    recordSweep: vi.fn(),
    recordTickLag: vi.fn(),
  };
}
