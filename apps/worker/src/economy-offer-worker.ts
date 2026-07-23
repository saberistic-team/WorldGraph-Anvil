import type { Logger } from 'pino';

import type { IdGenerator } from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';
import type {
  EconomyOfferExpiryCommandPort,
  ExpireAssetTransferOfferResult,
} from '@worldgraph/economy-command';

import type {
  DueAssetTransferOffer,
  EconomyOfferRepository,
  EconomyOperationalSnapshot,
} from './economy-offer-repository.js';

export type EconomyOfferRunOutcome = ExpireAssetTransferOfferResult['status'] | 'failed';

export interface EconomyOfferRunResult {
  outcome: EconomyOfferRunOutcome;
}

export interface EconomyOfferWorkerMetrics {
  recordDiscovery(count: number): void;
  recordExpiry(outcome: EconomyOfferRunOutcome): void;
  recordOperationalSnapshot(snapshot: EconomyOperationalSnapshot): void;
  recordSweep(milliseconds: number, outcome: 'failed' | 'succeeded'): void;
  recordTickLag(ticks: number): void;
}

const discardMetrics: EconomyOfferWorkerMetrics = {
  recordDiscovery: () => undefined,
  recordExpiry: () => undefined,
  recordOperationalSnapshot: () => undefined,
  recordSweep: () => undefined,
  recordTickLag: () => undefined,
};

export function createProductionEconomyOfferMetrics(): EconomyOfferWorkerMetrics {
  return {
    recordDiscovery(count) {
      telemetry.economyDueOffers.record(count, { outcome: 'discovered' });
    },
    recordExpiry(outcome) {
      telemetry.economyCommands.add(1, { operation: 'expire_offer', outcome });
    },
    recordOperationalSnapshot(snapshot) {
      telemetry.setEconomyOperationalState(snapshot);
    },
    recordSweep(milliseconds, outcome) {
      telemetry.economyOfferSweeps.add(1, { outcome });
      telemetry.economyOfferSweepDuration.record(milliseconds, { outcome });
    },
    recordTickLag(ticks) {
      telemetry.economyExpiredOfferTickLag.record(ticks, { outcome: 'discovered' });
    },
  };
}

export interface EconomyOfferRunnerOptions {
  batchSize: number;
  ids: IdGenerator;
  metrics?: EconomyOfferWorkerMetrics;
  monotonicNow?: () => number;
}

export class EconomyOfferRunner {
  private readonly batchSize: number;
  private readonly metrics: EconomyOfferWorkerMetrics;
  private readonly monotonicNow: () => number;

  public constructor(
    private readonly repository: EconomyOfferRepository,
    private readonly commands: EconomyOfferExpiryCommandPort,
    private readonly logger: Logger,
    private readonly options: EconomyOfferRunnerOptions,
  ) {
    this.batchSize = options.batchSize;
    this.metrics = options.metrics ?? discardMetrics;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 250) {
      throw new Error('ECONOMY_OFFER_RUNNER_CONFIGURATION_INVALID');
    }
  }

  public async reconcile(): Promise<EconomyOfferRunResult[]> {
    const startedAt = this.monotonicNow();
    let failed = false;
    const results: EconomyOfferRunResult[] = [];
    try {
      const due = await this.repository.findDueOffers(this.batchSize);
      this.metrics.recordDiscovery(due.length);
      try {
        this.metrics.recordOperationalSnapshot(await this.repository.readOperationalSnapshot());
      } catch (error) {
        this.logger.warn(
          {
            code: 'ECONOMY_OPERATIONAL_METRICS_REFRESH_FAILED',
            failureClass: safeFailureClass(error),
          },
          'economy.operational_metrics_refresh_failed',
        );
      }
      for (const candidate of due) {
        this.metrics.recordTickLag(safeTickLag(candidate));
        try {
          const result = await this.commands.expire({
            commandId: this.options.ids.next(),
            eventId: this.options.ids.next(),
            expectedOfferVersion: candidate.expectedOfferVersion,
            expectedStateRevision: candidate.expectedStateRevision,
            expectedTick: candidate.currentTick,
            expectedWorldVersion: candidate.expectedWorldVersion,
            idempotencyKey: expiryIdempotencyKey(candidate),
            offerId: candidate.offerId,
            worldId: candidate.worldId,
          });
          this.metrics.recordExpiry(result.status);
          results.push({ outcome: result.status });
        } catch (error) {
          failed = true;
          this.metrics.recordExpiry('failed');
          this.logger.error(
            {
              code: 'ECONOMY_OFFER_EXPIRY_FAILED',
              failureClass: safeFailureClass(error),
            },
            'economy.offer_expiry_failed',
          );
          results.push({ outcome: 'failed' });
        }
      }
      return results;
    } catch (error) {
      failed = true;
      this.logger.error(
        {
          code: 'ECONOMY_OFFER_DISCOVERY_FAILED',
          failureClass: safeFailureClass(error),
        },
        'economy.offer_discovery_failed',
      );
      throw error;
    } finally {
      this.metrics.recordSweep(
        Math.max(0, this.monotonicNow() - startedAt),
        failed ? 'failed' : 'succeeded',
      );
    }
  }
}

export interface EconomyOfferCoordinatorOptions {
  monotonicNow?: () => number;
  reconciliationIntervalMs: number;
}

export class EconomyOfferCoordinator {
  private active: Promise<EconomyOfferRunResult[]> | undefined;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private readonly monotonicNow: () => number;
  private readonly reconciliationIntervalMs: number;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly runner: Pick<EconomyOfferRunner, 'reconcile'>,
    private readonly logger: Logger,
    options: EconomyOfferCoordinatorOptions,
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.reconciliationIntervalMs = options.reconciliationIntervalMs;
    if (
      !Number.isSafeInteger(this.reconciliationIntervalMs) ||
      this.reconciliationIntervalMs < 100 ||
      this.reconciliationIntervalMs > 60_000
    ) {
      throw new Error('ECONOMY_OFFER_RECONCILIATION_INTERVAL_INVALID');
    }
  }

  public start(): void {
    if (this.stopped || this.timer) return;
    void this.wake();
    this.timer = setInterval(() => void this.wake(), this.reconciliationIntervalMs);
    this.timer.unref();
  }

  public wake(): Promise<EconomyOfferRunResult[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.active) return this.active;
    const now = this.monotonicNow();
    if (now - this.lastStartedAt < this.reconciliationIntervalMs) return Promise.resolve([]);
    this.lastStartedAt = now;
    const active = this.runner.reconcile();
    this.active = active;
    const clear = (): void => {
      if (this.active === active) this.active = undefined;
    };
    void active.then(clear, (error: unknown) => {
      clear();
      this.logger.error(
        {
          code: 'ECONOMY_OFFER_RECONCILIATION_FAILED',
          failureClass: safeFailureClass(error),
        },
        'economy.offer_reconciliation_failed',
      );
    });
    return active;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
  }
}

function expiryIdempotencyKey(candidate: DueAssetTransferOffer): string {
  return `economy-offer-expiry-v1:${candidate.offerId}:${candidate.expiresAtTick}`;
}

function safeTickLag(candidate: DueAssetTransferOffer): number {
  const lag = BigInt(candidate.currentTick) - BigInt(candidate.expiresAtTick);
  return lag > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(lag);
}

function safeFailureClass(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === '40001') return 'serialization';
  if (code === '40P01') return 'deadlock';
  if (code.startsWith('08')) return 'dependency';
  return error instanceof TypeError || error instanceof RangeError ? 'validation' : 'unexpected';
}
