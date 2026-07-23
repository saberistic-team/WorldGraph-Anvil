import { metrics } from '@opentelemetry/api';
import type { Logger } from 'pino';

import type { IdGenerator } from '@worldgraph/contracts';
import type {
  CommerceScheduledCommandPort,
  CommerceScheduledCommandRequest,
  CommerceScheduledCommandResult,
} from '@worldgraph/economy-command';

import type {
  CommerceScheduleRepository,
  CommerceScheduledEffectCandidate,
} from './commerce-schedule-repository.js';

export type CommerceScheduleRunOutcome = CommerceScheduledCommandResult['status'] | 'failed';

export interface CommerceScheduleRunResult {
  actionType: CommerceScheduledEffectCandidate['actionType'];
  outcome: CommerceScheduleRunOutcome;
  scheduledActionId: string;
}

export interface CommerceScheduleWorkerMetrics {
  recordCommand: (
    actionType: string,
    milliseconds: number,
    outcome: CommerceScheduleRunOutcome,
  ) => void;
  recordDiscovery: (count: number) => void;
  recordScheduleLag: (ticks: number, actionType: string) => void;
  recordSweep: (milliseconds: number, outcome: 'failed' | 'succeeded') => void;
}

const discardMetrics: CommerceScheduleWorkerMetrics = {
  recordCommand: () => undefined,
  recordDiscovery: () => undefined,
  recordScheduleLag: () => undefined,
  recordSweep: () => undefined,
};

export function createProductionCommerceScheduleMetrics(): CommerceScheduleWorkerMetrics {
  const meter = metrics.getMeter('worldgraph-worker');
  const commands = meter.createCounter('worldgraph_commerce_scheduled_commands_total');
  const commandDuration = meter.createHistogram(
    'worldgraph_commerce_scheduled_command_duration_ms',
  );
  const discoveries = meter.createHistogram('worldgraph_commerce_scheduled_effects_pending');
  const lag = meter.createHistogram('worldgraph_commerce_scheduler_lag_ticks');
  const sweeps = meter.createCounter('worldgraph_commerce_scheduler_sweeps_total');
  const sweepDuration = meter.createHistogram('worldgraph_commerce_scheduler_sweep_duration_ms');
  return {
    recordCommand(actionType, milliseconds, outcome) {
      const attributes = { action_type: actionType, outcome };
      commands.add(1, attributes);
      commandDuration.record(milliseconds, attributes);
    },
    recordDiscovery(count) {
      discoveries.record(count);
    },
    recordScheduleLag(ticks, actionType) {
      lag.record(ticks, { action_type: actionType });
    },
    recordSweep(milliseconds, outcome) {
      sweeps.add(1, { outcome });
      sweepDuration.record(milliseconds, { outcome });
    },
  };
}

export interface CommerceScheduleRunnerOptions {
  batchSize: number;
  ids: IdGenerator;
  metrics?: CommerceScheduleWorkerMetrics;
  monotonicNow?: () => number;
}

export class CommerceScheduleRunner {
  private readonly batchSize: number;
  private readonly metrics: CommerceScheduleWorkerMetrics;
  private readonly monotonicNow: () => number;

  public constructor(
    private readonly repository: CommerceScheduleRepository,
    private readonly commands: CommerceScheduledCommandPort,
    private readonly logger: Logger,
    private readonly options: CommerceScheduleRunnerOptions,
  ) {
    this.batchSize = options.batchSize;
    this.metrics = options.metrics ?? discardMetrics;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 250) {
      throw new Error('COMMERCE_SCHEDULE_RUNNER_CONFIGURATION_INVALID');
    }
  }

  public async reconcile(): Promise<CommerceScheduleRunResult[]> {
    const sweepStartedAt = this.monotonicNow();
    let sweepFailed = false;
    try {
      const candidates = await this.repository.findPendingEffects(this.batchSize);
      this.metrics.recordDiscovery(candidates.length);
      const results: CommerceScheduleRunResult[] = [];
      for (const candidate of candidates) {
        const startedAt = this.monotonicNow();
        this.metrics.recordScheduleLag(scheduleLag(candidate), candidate.actionType);
        try {
          const result = await this.commands.execute(
            scheduledCommandRequest(candidate, this.options.ids.next()),
          );
          this.metrics.recordCommand(
            candidate.actionType,
            Math.max(0, this.monotonicNow() - startedAt),
            result.status,
          );
          results.push({
            actionType: candidate.actionType,
            outcome: result.status,
            scheduledActionId: candidate.scheduledActionId,
          });
        } catch (error) {
          sweepFailed = true;
          this.metrics.recordCommand(
            candidate.actionType,
            Math.max(0, this.monotonicNow() - startedAt),
            'failed',
          );
          this.logger.error(
            {
              actionType: candidate.actionType,
              code: 'COMMERCE_SCHEDULE_COMMAND_FAILED',
              failureClass: safeFailureClass(error),
              scheduledActionId: candidate.scheduledActionId,
              worldId: candidate.worldId,
            },
            'commerce.schedule_command_failed',
          );
          results.push({
            actionType: candidate.actionType,
            outcome: 'failed',
            scheduledActionId: candidate.scheduledActionId,
          });
        }
      }
      return results;
    } catch (error) {
      sweepFailed = true;
      this.logger.error(
        {
          code: 'COMMERCE_SCHEDULE_DISCOVERY_FAILED',
          failureClass: safeFailureClass(error),
        },
        'commerce.schedule_discovery_failed',
      );
      throw error;
    } finally {
      this.metrics.recordSweep(
        Math.max(0, this.monotonicNow() - sweepStartedAt),
        sweepFailed ? 'failed' : 'succeeded',
      );
    }
  }
}

export interface CommerceScheduleCoordinatorOptions {
  monotonicNow?: () => number;
  reconciliationIntervalMs: number;
}

export class CommerceScheduleCoordinator {
  private active: Promise<CommerceScheduleRunResult[]> | undefined;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private readonly monotonicNow: () => number;
  private readonly reconciliationIntervalMs: number;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly runner: Pick<CommerceScheduleRunner, 'reconcile'>,
    private readonly logger: Logger,
    options: CommerceScheduleCoordinatorOptions,
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.reconciliationIntervalMs = options.reconciliationIntervalMs;
    if (
      !Number.isSafeInteger(this.reconciliationIntervalMs) ||
      this.reconciliationIntervalMs < 100 ||
      this.reconciliationIntervalMs > 60_000
    ) {
      throw new Error('COMMERCE_SCHEDULE_RECONCILIATION_INTERVAL_INVALID');
    }
  }

  public start(): void {
    if (this.stopped || this.timer) return;
    void this.wake();
    this.timer = setInterval(() => void this.wake(), this.reconciliationIntervalMs);
    this.timer.unref();
  }

  public wake(): Promise<CommerceScheduleRunResult[]> {
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
          code: 'COMMERCE_SCHEDULE_RECONCILIATION_FAILED',
          failureClass: safeFailureClass(error),
        },
        'commerce.schedule_reconciliation_failed',
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

export function commerceScheduleIdempotencyKeyV1(
  candidate: Pick<CommerceScheduledEffectCandidate, 'actionType' | 'scheduledActionId'>,
): string {
  return `commerce-schedule-v1:${candidate.actionType}:${candidate.scheduledActionId}`;
}

function scheduledCommandRequest(
  candidate: CommerceScheduledEffectCandidate,
  commandId: string,
): CommerceScheduledCommandRequest {
  const common = {
    commandId,
    completedEventId: candidate.completedEventId,
    dueTick: candidate.dueTick,
    idempotencyKey: commerceScheduleIdempotencyKeyV1(candidate),
    scheduleSequence: candidate.scheduleSequence,
    scheduledActionId: candidate.scheduledActionId,
    worldId: candidate.worldId,
  };
  switch (candidate.actionType) {
    case 'CompleteProductionRunV1':
      return { ...common, actionType: candidate.actionType, payload: candidate.payload };
    case 'SettlePayrollV1':
      return { ...common, actionType: candidate.actionType, payload: candidate.payload };
    case 'ExpireMarketListingV1':
      return { ...common, actionType: candidate.actionType, payload: candidate.payload };
    case 'AssessPeriodicTaxV1':
      return { ...common, actionType: candidate.actionType, payload: candidate.payload };
  }
}

function safeFailureClass(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === '40001') return 'serialization';
  if (code === '40P01') return 'deadlock';
  if (code.startsWith('08')) return 'dependency';
  return error instanceof TypeError || error instanceof RangeError ? 'validation' : 'unexpected';
}

function scheduleLag(candidate: Pick<CommerceScheduledEffectCandidate, 'currentTick' | 'dueTick'>) {
  const lag = BigInt(candidate.currentTick) - BigInt(candidate.dueTick);
  return lag > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(lag);
}
