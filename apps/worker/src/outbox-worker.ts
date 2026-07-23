import { metrics } from '@opentelemetry/api';
import type { Logger } from 'pino';

import type { ClaimedOutboxMessage, OutboxBacklog, OutboxRepository } from './outbox-repository.js';

export type OutboxDispatchOutcome = 'dead' | 'idle' | 'lost_claim' | 'published' | 'retry';

export interface OutboxDispatchResult {
  message: ClaimedOutboxMessage | null;
  outcome: OutboxDispatchOutcome;
}

export interface OutboxMetrics {
  recordBacklog(backlog: OutboxBacklog): void;
  recordDispatch(outcome: OutboxDispatchOutcome, messageType?: string): void;
}

const discardMetrics: OutboxMetrics = {
  recordBacklog: () => undefined,
  recordDispatch: () => undefined,
};

export function createProductionOutboxMetrics(): OutboxMetrics {
  const meter = metrics.getMeter('worldgraph-worker');
  const ready = meter.createHistogram('worldgraph_outbox_backlog');
  const age = meter.createHistogram('worldgraph_outbox_oldest_age_ms');
  const dead = meter.createHistogram('worldgraph_outbox_dead');
  const dispatches = meter.createCounter('worldgraph_outbox_dispatch_total');
  return {
    recordBacklog(backlog) {
      ready.record(backlog.ready);
      age.record(backlog.oldestReadyAgeMs);
      dead.record(backlog.dead);
    },
    recordDispatch(outcome, messageType) {
      dispatches.add(1, { message_type: messageType ?? 'none', outcome });
    },
  };
}

export interface OutboxRunnerOptions {
  batchSize?: number;
  leaseMs?: number;
  maximumAttempts?: number;
  metrics?: OutboxMetrics;
  retryBaseMs?: number;
}

export class OutboxRunner {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maximumAttempts: number;
  private readonly metrics: OutboxMetrics;
  private readonly retryBaseMs: number;

  public constructor(
    private readonly repository: OutboxRepository,
    private readonly workerId: string,
    private readonly logger: Logger,
    options: OutboxRunnerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 25;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maximumAttempts = options.maximumAttempts ?? 10;
    this.metrics = options.metrics ?? discardMetrics;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    if (
      !workerId.trim() ||
      !Number.isSafeInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 250 ||
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1_000 ||
      !Number.isSafeInteger(this.maximumAttempts) ||
      this.maximumAttempts < 1 ||
      this.maximumAttempts > 100 ||
      !Number.isSafeInteger(this.retryBaseMs) ||
      this.retryBaseMs < 100
    ) {
      throw new Error('OUTBOX_CONFIGURATION_INVALID');
    }
  }

  public async reconcile(): Promise<OutboxDispatchResult[]> {
    const backlog = await this.repository.inspectBacklog();
    this.metrics.recordBacklog(backlog);
    const messages = await this.repository.claim(this.workerId, this.batchSize, this.leaseMs);
    if (messages.length === 0) {
      this.metrics.recordDispatch('idle');
      return [{ message: null, outcome: 'idle' }];
    }
    const results: OutboxDispatchResult[] = [];
    for (const message of messages) {
      try {
        const published = await this.repository.publish(message, this.workerId);
        const outcome = published ? 'published' : 'lost_claim';
        this.metrics.recordDispatch(outcome, message.messageType);
        results.push({ message, outcome });
      } catch {
        const exponential = this.retryBaseMs * 2 ** Math.max(0, message.attempts - 1);
        const retryDelayMs = Math.min(60_000, exponential);
        const status = await this.repository.markFailed(
          message,
          this.workerId,
          this.maximumAttempts,
          retryDelayMs,
        );
        const outcome =
          status === 'lost_claim' ? 'lost_claim' : status === 'dead' ? 'dead' : 'retry';
        this.metrics.recordDispatch(outcome, message.messageType);
        this.logger[status === 'dead' ? 'error' : 'warn'](
          {
            attempts: message.attempts,
            code: status === 'dead' ? 'OUTBOX_DEAD' : 'OUTBOX_RETRY',
            messageId: message.id,
            messageType: message.messageType,
            worldId: message.worldId,
          },
          status === 'dead' ? 'outbox.dead' : 'outbox.retry_scheduled',
        );
        results.push({ message, outcome });
      }
    }
    return results;
  }
}

export interface OutboxCoordinatorOptions {
  monotonicNow?: () => number;
  reconciliationIntervalMs?: number;
}

export class OutboxCoordinator {
  private active: Promise<OutboxDispatchResult[]> | undefined;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private readonly monotonicNow: () => number;
  private readonly reconciliationIntervalMs: number;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly runner: Pick<OutboxRunner, 'reconcile'>,
    private readonly logger: Logger,
    options: OutboxCoordinatorOptions = {},
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.reconciliationIntervalMs = options.reconciliationIntervalMs ?? 1_000;
    if (
      !Number.isSafeInteger(this.reconciliationIntervalMs) ||
      this.reconciliationIntervalMs < 250
    ) {
      throw new Error('OUTBOX_RECONCILIATION_INTERVAL_INVALID');
    }
  }

  public start(): void {
    if (this.stopped || this.timer) return;
    void this.wake();
    this.timer = setInterval(() => void this.wake(), this.reconciliationIntervalMs);
    this.timer.unref();
  }

  public wake(): Promise<OutboxDispatchResult[]> {
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
      this.logger.error({ code: 'OUTBOX_RECONCILIATION_FAILED', error }, 'outbox.failed');
    });
    return active;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
