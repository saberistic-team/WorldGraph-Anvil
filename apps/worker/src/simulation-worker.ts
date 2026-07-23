import { metrics } from '@opentelemetry/api';
import type { Logger } from 'pino';

import {
  AdvanceSimulationCommandV1Schema,
  createValidator,
  type AdvanceSimulationCommandV1,
  type IdGenerator,
  type Validator,
} from '@worldgraph/contracts';
import { withSpan, withSpanSync } from '@worldgraph/observability';
import type {
  FencedSimulationAdvanceRequest,
  FencedSimulationAdvanceResult,
  FencedSimulationAutoPauseRequest,
  FencedSimulationAutoPauseResult,
  SimulationAdvanceCommandPort,
  SimulationFailureContextV1,
  SimulationCommandObserver,
  SimulationAdvanceTelemetryV1,
} from '@worldgraph/simulation-command';

import type {
  DueSimulationWorld,
  SimulationAdvanceCandidate,
  SimulationLease,
  SimulationLeaseRepository,
} from './simulation-repository.js';

const advanceCommandValidator: Validator<AdvanceSimulationCommandV1> =
  createValidator<AdvanceSimulationCommandV1>(AdvanceSimulationCommandV1Schema);

export type SimulationRunOutcome =
  | 'advanced'
  | 'auto_paused'
  | 'busy'
  | 'conflict'
  | 'failed'
  | 'fenced'
  | 'idle'
  | 'not_due'
  | 'not_running';

export type {
  FencedSimulationAdvanceRequest,
  FencedSimulationAdvanceResult,
  FencedSimulationAutoPauseRequest,
  FencedSimulationAutoPauseResult,
  SimulationAdvanceCommandPort,
};

export interface SimulationRunResult {
  attempts: number;
  outcome: SimulationRunOutcome;
  worldId: string | null;
}

export interface SimulationWorkerMetrics {
  recordAdvancedTicks(ticks: number): void;
  recordBacklogTicks(ticks: number): void;
  recordBatchTicks(ticks: number): void;
  recordCommand(
    operation: 'advance' | 'auto_pause',
    milliseconds: number,
    outcome: SimulationRunOutcome,
  ): void;
  recordDiscovery(worldCount: number): void;
  recordDueLag(milliseconds: number): void;
  recordFencingLoss(stage: 'candidate' | 'command' | 'renew' | 'release'): void;
  recordLease(
    stage: 'acquire' | 'hold' | 'release',
    milliseconds: number,
    outcome: 'acquired' | 'contended' | 'failed' | 'fenced' | 'released',
  ): void;
  recordProcessExecution(processType: string, processVersion: string): void;
  recordProcessFailure(code: string, processType: string, processVersion: string): void;
  recordQueueWakeAge(milliseconds: number): void;
  recordReconciliation(milliseconds: number, outcome: 'failed' | 'succeeded'): void;
  recordRetry(code: string): void;
  recordRun(outcome: SimulationRunOutcome): void;
  recordWakeAvailability(available: boolean): void;
}

const discardMetrics: SimulationWorkerMetrics = {
  recordAdvancedTicks: () => undefined,
  recordBacklogTicks: () => undefined,
  recordBatchTicks: () => undefined,
  recordCommand: () => undefined,
  recordDiscovery: () => undefined,
  recordDueLag: () => undefined,
  recordFencingLoss: () => undefined,
  recordLease: () => undefined,
  recordProcessExecution: () => undefined,
  recordProcessFailure: () => undefined,
  recordQueueWakeAge: () => undefined,
  recordReconciliation: () => undefined,
  recordRetry: () => undefined,
  recordRun: () => undefined,
  recordWakeAvailability: () => undefined,
};

export function createProductionSimulationWorkerMetrics(): SimulationWorkerMetrics {
  const meter = metrics.getMeter('worldgraph-worker');
  const discoveries = meter.createHistogram('worldgraph_simulation_due_worlds');
  const dueLag = meter.createHistogram('worldgraph_simulation_due_lag_ms');
  const batchTicks = meter.createHistogram('worldgraph_simulation_batch_ticks');
  const backlogTicks = meter.createHistogram('worldgraph_simulation_backlog_ticks');
  const advancedTicks = meter.createCounter('worldgraph_simulation_ticks_total');
  const commandDuration = meter.createHistogram('worldgraph_simulation_command_duration_ms');
  const leaseDuration = meter.createHistogram('worldgraph_simulation_lease_duration_ms');
  const leaseContention = meter.createCounter('worldgraph_simulation_lease_contention_total');
  const fencingLoss = meter.createCounter('worldgraph_simulation_fencing_loss_total');
  const processExecutions = meter.createCounter('worldgraph_simulation_process_executions_total');
  const processFailures = meter.createCounter('worldgraph_simulation_process_failures_total');
  const queueWakeAge = meter.createHistogram('worldgraph_simulation_queue_wake_age_ms');
  const reconciliationDuration = meter.createHistogram(
    'worldgraph_simulation_reconciliation_duration_ms',
  );
  const retries = meter.createCounter('worldgraph_simulation_retry_total');
  const runs = meter.createCounter('worldgraph_simulation_run_total');
  const wakeAvailability = meter.createGauge('worldgraph_simulation_wake_available');
  return {
    recordAdvancedTicks(ticks) {
      advancedTicks.add(ticks);
    },
    recordBacklogTicks(ticks) {
      backlogTicks.record(ticks);
    },
    recordBatchTicks(ticks) {
      batchTicks.record(ticks);
    },
    recordCommand(operation, milliseconds, outcome) {
      commandDuration.record(milliseconds, { operation, outcome });
    },
    recordDiscovery(worldCount) {
      discoveries.record(worldCount);
    },
    recordDueLag(milliseconds) {
      dueLag.record(milliseconds);
    },
    recordFencingLoss(stage) {
      fencingLoss.add(1, { stage });
    },
    recordLease(stage, milliseconds, outcome) {
      leaseDuration.record(milliseconds, { outcome, stage });
      if (stage === 'acquire' && outcome === 'contended') leaseContention.add(1);
    },
    recordProcessExecution(processType, processVersion) {
      processExecutions.add(1, { process_type: processType, process_version: processVersion });
    },
    recordProcessFailure(code, processType, processVersion) {
      processFailures.add(1, {
        code,
        process_type: processType,
        process_version: processVersion,
      });
    },
    recordQueueWakeAge(milliseconds) {
      queueWakeAge.record(milliseconds);
    },
    recordReconciliation(milliseconds, outcome) {
      reconciliationDuration.record(milliseconds, { outcome });
    },
    recordRetry(code) {
      retries.add(1, { code });
    },
    recordRun(outcome) {
      runs.add(1, { outcome });
    },
    recordWakeAvailability(available) {
      wakeAvailability.record(available ? 1 : 0);
    },
  };
}

type SimulationSpanValue = boolean | number | string;
type SimulationSpanAttributes = Readonly<Record<string, SimulationSpanValue>>;

export interface SimulationWorkerSpan {
  setAttribute(name: string, value: SimulationSpanValue): void;
  setAttributes(attributes: SimulationSpanAttributes): void;
}

export interface SimulationWorkerTracing {
  recordSpan(name: string, attributes: SimulationSpanAttributes): void;
  withSpan<T>(
    name: string,
    attributes: SimulationSpanAttributes,
    operation: (span: SimulationWorkerSpan) => Promise<T>,
  ): Promise<T>;
}

const discardSpan: SimulationWorkerSpan = {
  setAttribute: () => undefined,
  setAttributes: () => undefined,
};

const discardTracing: SimulationWorkerTracing = {
  recordSpan: () => undefined,
  withSpan: async (_name, _attributes, operation) => operation(discardSpan),
};

export function createProductionSimulationWorkerTracing(): SimulationWorkerTracing {
  return {
    recordSpan(name, attributes) {
      withSpanSync(name, (span) => {
        span.setAttributes(attributes);
      });
    },
    withSpan(name, attributes, operation) {
      return withSpan(name, async (span) => {
        span.setAttributes(attributes);
        return operation(span);
      });
    },
  };
}

export function createSimulationCommandObserver(
  metricsSink: Pick<SimulationWorkerMetrics, 'recordProcessExecution'>,
  tracing: Pick<SimulationWorkerTracing, 'recordSpan'>,
): SimulationCommandObserver {
  return {
    onAdvanceCommitted(summary: SimulationAdvanceTelemetryV1) {
      for (const execution of summary.executions) {
        metricsSink.recordProcessExecution(execution.processType, execution.processVersion);
        tracing.recordSpan('simulation.process.execute', {
          'simulation.process.event_count': execution.eventCount,
          'simulation.process.proposed_schedule_count': execution.proposedScheduleCount,
          'simulation.process.type': execution.processType,
          'simulation.process.version': execution.processVersion,
          'simulation.tick': execution.tick,
        });
      }
    },
  };
}

export interface SimulationRunnerOptions {
  ids: IdGenerator;
  leaseMs?: number;
  maximumAttempts?: number;
  maximumBackoffMs?: number;
  maximumWorldsPerRun?: number;
  metrics?: SimulationWorkerMetrics;
  monotonicNow?: () => number;
  retryBaseMs?: number;
  tracing?: SimulationWorkerTracing;
  wait?: (milliseconds: number) => Promise<void>;
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === 'DATABASE_UNAVAILABLE' ||
      code === 'QUERY_TIMEOUT' ||
      code === 'SERIALIZATION_FAILURE' ||
      code === 'SIMULATION_COMMAND_UNCERTAIN' ||
      code === 'SIMULATION_BUDGET_EXCEEDED' ||
      code === 'SIMULATION_HANDLER_FAILED' ||
      code === 'SIMULATION_INTEGER_OVERFLOW' ||
      code === 'SIMULATION_PROCESS_UNKNOWN' ||
      code === 'SIMULATION_PROCESS_VERSION_MISMATCH'
    ) {
      return code;
    }
    if (code === '40001') return 'SERIALIZATION_FAILURE';
    if (code === '57014') return 'QUERY_TIMEOUT';
    if (code === '57P01' || code === '08006' || code === 'ECONNRESET') {
      return 'DATABASE_UNAVAILABLE';
    }
  }
  return 'SIMULATION_ADVANCE_FAILED';
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class SimulationRunner {
  private readonly ids: IdGenerator;
  private readonly leaseMs: number;
  private readonly maximumAttempts: number;
  private readonly maximumBackoffMs: number;
  private readonly maximumWorldsPerRun: number;
  private readonly metrics: SimulationWorkerMetrics;
  private readonly monotonicNow: () => number;
  private readonly retryBaseMs: number;
  private readonly tracing: SimulationWorkerTracing;
  private readonly wait: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly repository: SimulationLeaseRepository,
    private readonly commands: SimulationAdvanceCommandPort,
    private readonly workerId: string,
    private readonly logger: Logger,
    options: SimulationRunnerOptions,
  ) {
    this.ids = options.ids;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.maximumBackoffMs = options.maximumBackoffMs ?? 5_000;
    this.maximumWorldsPerRun = options.maximumWorldsPerRun ?? 25;
    this.metrics = options.metrics ?? discardMetrics;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.tracing = options.tracing ?? discardTracing;
    this.wait = options.wait ?? defaultWait;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u.test(workerId) ||
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1_000 ||
      this.leaseMs > 300_000 ||
      !Number.isSafeInteger(this.maximumAttempts) ||
      this.maximumAttempts < 1 ||
      this.maximumAttempts > 10 ||
      !Number.isSafeInteger(this.maximumBackoffMs) ||
      this.maximumBackoffMs < 100 ||
      this.maximumBackoffMs > 60_000 ||
      !Number.isSafeInteger(this.maximumWorldsPerRun) ||
      this.maximumWorldsPerRun < 1 ||
      this.maximumWorldsPerRun > 100 ||
      !Number.isSafeInteger(this.retryBaseMs) ||
      this.retryBaseMs < 100 ||
      this.retryBaseMs > this.maximumBackoffMs
    ) {
      throw new Error('SIMULATION_WORKER_CONFIGURATION_INVALID');
    }
  }

  public async reconcile(): Promise<SimulationRunResult[]> {
    const startedAt = this.monotonicNow();
    let outcome: 'failed' | 'succeeded' = 'failed';
    try {
      return await this.tracing.withSpan('simulation.reconcile', {}, async (span) => {
        const dueWorlds = await this.repository.discoverDueWorlds(this.maximumWorldsPerRun);
        span.setAttribute('simulation.reconcile.due_world_count', dueWorlds.length);
        this.metrics.recordDiscovery(dueWorlds.length);
        const observedAt = Date.now();
        for (const dueWorld of dueWorlds) {
          this.metrics.recordDueLag(Math.max(0, observedAt - dueWorld.nextDueAt.getTime()));
        }
        if (dueWorlds.length === 0) {
          outcome = 'succeeded';
          return [this.record(null, 'idle', 0)];
        }

        const results: SimulationRunResult[] = [];
        for (const dueWorld of dueWorlds) {
          results.push(await this.runDueWorld(dueWorld));
        }
        span.setAttribute('simulation.reconcile.result_count', results.length);
        outcome = 'succeeded';
        return results;
      });
    } finally {
      this.metrics.recordReconciliation(this.elapsed(startedAt), outcome);
    }
  }

  private async runDueWorld(dueWorld: DueSimulationWorld): Promise<SimulationRunResult> {
    try {
      const lease = await this.acquireLease(dueWorld);
      if (!lease) return this.record(dueWorld.worldId, 'busy', 0);
      return this.holdLease(lease);
    } catch (error) {
      const code = safeErrorCode(error);
      this.logger.error({ code, worldId: dueWorld.worldId }, 'simulation.run_failed');
      return this.record(dueWorld.worldId, 'failed', 0);
    }
  }

  private async acquireLease(dueWorld: DueSimulationWorld): Promise<SimulationLease | null> {
    return this.tracing.withSpan(
      'simulation.lease.acquire',
      { 'simulation.world.id': dueWorld.worldId },
      async (span) => {
        const startedAt = this.monotonicNow();
        let outcome: 'acquired' | 'contended' | 'failed' = 'failed';
        try {
          const lease = await this.repository.acquireLease(
            dueWorld.worldId,
            this.workerId,
            this.leaseMs,
          );
          outcome = lease ? 'acquired' : 'contended';
          span.setAttribute('simulation.lease.outcome', outcome);
          return lease;
        } finally {
          this.metrics.recordLease('acquire', this.elapsed(startedAt), outcome);
        }
      },
    );
  }

  private async holdLease(lease: SimulationLease): Promise<SimulationRunResult> {
    return this.tracing.withSpan(
      'simulation.lease.hold',
      { 'simulation.world.id': lease.worldId },
      async (span) => {
        const startedAt = this.monotonicNow();
        let result: SimulationRunResult;
        try {
          result = await this.runWithLease(lease);
        } catch (error) {
          this.logger.error(
            { code: safeErrorCode(error), worldId: lease.worldId },
            'simulation.run_failed',
          );
          result = this.record(lease.worldId, 'failed', 0);
        } finally {
          await this.releaseLease(lease);
        }
        span.setAttribute('simulation.run.outcome', result.outcome);
        this.metrics.recordLease(
          'hold',
          this.elapsed(startedAt),
          result.outcome === 'fenced' ? 'fenced' : 'released',
        );
        return result;
      },
    );
  }

  private async releaseLease(lease: SimulationLease): Promise<void> {
    await this.tracing.withSpan(
      'simulation.lease.release',
      { 'simulation.world.id': lease.worldId },
      async (span) => {
        const startedAt = this.monotonicNow();
        let outcome: 'failed' | 'fenced' | 'released' = 'failed';
        try {
          const released = await this.repository.releaseLease(lease);
          outcome = released ? 'released' : 'fenced';
          if (!released) {
            this.metrics.recordFencingLoss('release');
            this.logger.warn(
              { code: 'SIMULATION_LEASE_RELEASE_FENCED', worldId: lease.worldId },
              'simulation.lease_release_fenced',
            );
          }
        } catch {
          this.logger.warn(
            { code: 'SIMULATION_LEASE_RELEASE_FAILED', worldId: lease.worldId },
            'simulation.lease_release_failed',
          );
        } finally {
          span.setAttribute('simulation.lease.outcome', outcome);
          this.metrics.recordLease('release', this.elapsed(startedAt), outcome);
        }
      },
    );
  }

  private async runWithLease(initialLease: SimulationLease): Promise<SimulationRunResult> {
    const candidate = await this.repository.loadAdvanceCandidate(initialLease);
    if (!candidate) {
      const current = await this.repository.isLeaseCurrent(initialLease);
      if (!current) this.metrics.recordFencingLoss('candidate');
      return this.record(initialLease.worldId, current ? 'not_due' : 'fenced', 0);
    }

    const command = this.createCommand(candidate);
    this.metrics.recordBacklogTicks(candidate.backlogTicks);
    this.metrics.recordBatchTicks(candidate.ticks);
    let lease = initialLease;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      if (attempt > 1) {
        const backoffMs = Math.min(this.maximumBackoffMs, this.retryBaseMs * 2 ** (attempt - 2));
        await this.wait(backoffMs);
        const renewed = await this.repository.renewLease(lease, this.leaseMs);
        if (!renewed) {
          this.metrics.recordFencingLoss('renew');
          return this.record(candidate.worldId, 'fenced', attempt - 1);
        }
        lease = renewed;
      }

      try {
        const advanced = await this.submitAdvance(candidate, command, lease, attempt);
        switch (advanced.status) {
          case 'advanced':
            this.metrics.recordAdvancedTicks(candidate.ticks);
            return this.record(candidate.worldId, 'advanced', attempt);
          case 'clock_not_running':
            return this.record(candidate.worldId, 'not_running', attempt);
          case 'conflict':
            return this.record(candidate.worldId, 'conflict', attempt);
          case 'fenced':
            this.metrics.recordFencingLoss('command');
            return this.record(candidate.worldId, 'fenced', attempt);
          case 'not_due':
            return this.record(candidate.worldId, 'not_due', attempt);
        }
      } catch (error) {
        const code = safeErrorCode(error);
        if (attempt >= this.maximumAttempts) {
          const deterministicFailure = deterministicFailureContext(error);
          if (deterministicFailure) {
            return this.recordAutoPause(candidate, command, lease, deterministicFailure, attempt);
          }
          this.logger.error(
            { attempts: attempt, code, worldId: candidate.worldId },
            'simulation.advance_failed',
          );
          return this.record(candidate.worldId, 'failed', attempt);
        }
        this.metrics.recordRetry(code);
        this.logger.warn(
          { attempts: attempt, code, worldId: candidate.worldId },
          'simulation.advance_retry',
        );
      }
    }
    return this.record(candidate.worldId, 'failed', this.maximumAttempts);
  }

  private async submitAdvance(
    candidate: SimulationAdvanceCandidate,
    command: AdvanceSimulationCommandV1,
    lease: SimulationLease,
    attempt: number,
  ): Promise<FencedSimulationAdvanceResult> {
    const startedAt = this.monotonicNow();
    let outcome: SimulationRunOutcome = 'failed';
    try {
      return await this.tracing.withSpan(
        'simulation.command.advance',
        {
          'simulation.batch.tick_count': candidate.ticks,
          'simulation.command.attempt': attempt,
          'simulation.tick.from': candidate.expectedTick,
          'simulation.tick.to': (
            BigInt(candidate.expectedTick) + BigInt(candidate.ticks)
          ).toString(),
          'simulation.world.id': candidate.worldId,
        },
        async (span) => {
          try {
            const advanced = await this.commands.advance({
              command,
              leaseFencingToken: lease.fencingToken,
              leaseOwner: lease.leaseOwner,
              worldId: candidate.worldId,
            });
            outcome = commandResultOutcome(advanced.status);
            if (
              advanced.status === 'advanced' &&
              advanced.resultingTick !==
                (BigInt(candidate.expectedTick) + BigInt(candidate.ticks)).toString()
            ) {
              outcome = 'failed';
              throw Object.assign(new Error('Invalid authoritative advance result.'), {
                code: 'SIMULATION_COMMAND_UNCERTAIN',
              });
            }
            span.setAttribute('simulation.command.outcome', outcome);
            return advanced;
          } catch (error) {
            span.setAttribute('simulation.error.code', safeErrorCode(error));
            throw error;
          }
        },
      );
    } finally {
      this.metrics.recordCommand('advance', this.elapsed(startedAt), outcome);
    }
  }

  private async recordAutoPause(
    candidate: SimulationAdvanceCandidate,
    command: AdvanceSimulationCommandV1,
    lease: SimulationLease,
    failure: SimulationFailureContextV1,
    attempts: number,
  ): Promise<SimulationRunResult> {
    const startedAt = this.monotonicNow();
    let outcome: SimulationRunOutcome = 'failed';
    try {
      const paused = await this.tracing.withSpan(
        'simulation.command.auto_pause',
        {
          'simulation.command.attempts': attempts,
          'simulation.error.code': failure.errorCode,
          ...failureSourceSpanAttributes(failure),
          'simulation.tick': failure.tick,
          'simulation.world.id': candidate.worldId,
        },
        async (span) => {
          const response = await this.commands.recordFailureAndAutoPause({
            attempts,
            failedCommand: command,
            failure,
            leaseFencingToken: lease.fencingToken,
            leaseOwner: lease.leaseOwner,
            worldId: candidate.worldId,
          });
          outcome = autoPauseResultOutcome(response.status);
          span.setAttribute('simulation.command.outcome', outcome);
          return response;
        },
      );
      switch (paused.status) {
        case 'auto_paused':
          this.logger.error(
            {
              attempts,
              code: failure.errorCode,
              failureId: paused.failureId,
              worldId: candidate.worldId,
            },
            'simulation.auto_paused',
          );
          return this.record(candidate.worldId, 'auto_paused', attempts);
        case 'clock_not_running':
          return this.record(candidate.worldId, 'not_running', attempts);
        case 'conflict':
          return this.record(candidate.worldId, 'conflict', attempts);
        case 'fenced':
          this.metrics.recordFencingLoss('command');
          return this.record(candidate.worldId, 'fenced', attempts);
      }
      throw new Error('SIMULATION_AUTO_PAUSE_RESULT_INVALID');
    } catch (error) {
      this.logger.error(
        { attempts, code: safeErrorCode(error), worldId: candidate.worldId },
        'simulation.auto_pause_failed',
      );
      return this.record(candidate.worldId, 'failed', attempts);
    } finally {
      this.metrics.recordCommand('auto_pause', this.elapsed(startedAt), outcome);
      const attributes = {
        'simulation.command.attempts': attempts,
        'simulation.command.outcome': outcome,
        'simulation.error.code': failure.errorCode,
        ...failureSourceSpanAttributes(failure),
        'simulation.tick': failure.tick,
        'simulation.world.id': candidate.worldId,
      };
      if (failure.processType === 'EmitWorldNoticeV1') {
        this.metrics.recordProcessFailure(
          failure.errorCode,
          failure.processType,
          failure.processVersion,
        );
        this.tracing.recordSpan('simulation.process.failure', attributes);
      } else {
        this.tracing.recordSpan('simulation.clock.failure', attributes);
      }
    }
  }

  private createCommand(candidate: SimulationAdvanceCandidate): AdvanceSimulationCommandV1 {
    const command: AdvanceSimulationCommandV1 = {
      commandId: this.ids.next(),
      expectedAggregateVersion: candidate.expectedAggregateVersion,
      expectedStateRevision: candidate.expectedStateRevision,
      expectedTick: candidate.expectedTick,
      expectedWorldVersion: candidate.expectedWorldVersion,
      idempotencyKey: `simulation-auto.${candidate.expectedTick}.${candidate.expectedStateRevision}.${candidate.ticks}`,
      payload: { ticks: candidate.ticks },
      schemaVersion: 1,
      type: 'AdvanceSimulationV1',
    };
    advanceCommandValidator.assert(command);
    return command;
  }

  private elapsed(startedAt: number): number {
    const elapsed = this.monotonicNow() - startedAt;
    return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  }

  private record(
    worldId: string | null,
    outcome: SimulationRunOutcome,
    attempts: number,
  ): SimulationRunResult {
    this.metrics.recordRun(outcome);
    if (worldId && outcome !== 'idle') {
      this.logger[outcome === 'failed' ? 'error' : 'info'](
        { attempts, outcome, worldId },
        'simulation.finished',
      );
    }
    return { attempts, outcome, worldId };
  }
}

function commandResultOutcome(
  status: FencedSimulationAdvanceResult['status'],
): SimulationRunOutcome {
  switch (status) {
    case 'advanced':
      return 'advanced';
    case 'clock_not_running':
      return 'not_running';
    case 'conflict':
      return 'conflict';
    case 'fenced':
      return 'fenced';
    case 'not_due':
      return 'not_due';
  }
}

function autoPauseResultOutcome(
  status: FencedSimulationAutoPauseResult['status'],
): SimulationRunOutcome {
  switch (status) {
    case 'auto_paused':
      return 'auto_paused';
    case 'clock_not_running':
      return 'not_running';
    case 'conflict':
      return 'conflict';
    case 'fenced':
      return 'fenced';
  }
}

function deterministicFailureContext(error: unknown): SimulationFailureContextV1 | null {
  if (!error || typeof error !== 'object' || !('failure' in error)) return null;
  const failure = (error as { failure?: unknown }).failure;
  if (!failure || typeof failure !== 'object') return null;
  const candidate = failure as Record<string, unknown>;
  const deterministicCodes = new Set([
    'SIMULATION_BUDGET_EXCEEDED',
    'SIMULATION_HANDLER_FAILED',
    'SIMULATION_INTEGER_OVERFLOW',
    'SIMULATION_PROCESS_UNKNOWN',
    'SIMULATION_PROCESS_VERSION_MISMATCH',
  ]);
  if (
    typeof candidate.errorCode !== 'string' ||
    !deterministicCodes.has(candidate.errorCode) ||
    candidate.processVersion !== '1.0.0' ||
    typeof candidate.tick !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(candidate.tick)
  ) {
    return null;
  }
  if (candidate.processType === 'WorldClockV1') {
    return candidate.errorCode === 'SIMULATION_INTEGER_OVERFLOW' && candidate.scheduleId === null
      ? (candidate as unknown as SimulationFailureContextV1)
      : null;
  }
  if (
    candidate.processType !== 'EmitWorldNoticeV1' ||
    (candidate.scheduleId !== null && typeof candidate.scheduleId !== 'string')
  ) {
    return null;
  }
  return candidate as unknown as SimulationFailureContextV1;
}

function failureSourceSpanAttributes(failure: SimulationFailureContextV1): Record<string, string> {
  return failure.processType === 'EmitWorldNoticeV1'
    ? {
        'simulation.process.type': failure.processType,
        'simulation.process.version': failure.processVersion,
      }
    : {
        'simulation.failure.source.type': failure.processType,
        'simulation.failure.source.version': failure.processVersion,
      };
}

export interface SimulationCoordinatorOptions {
  isAutomationAvailable?: () => boolean;
  metrics?: Pick<SimulationWorkerMetrics, 'recordWakeAvailability'>;
  monotonicNow?: () => number;
  reconciliationIntervalMs?: number;
  tracing?: SimulationWorkerTracing;
}

export class SimulationCoordinator {
  private active: Promise<SimulationRunResult[]> | undefined;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private readonly monotonicNow: () => number;
  private readonly isAutomationAvailable: () => boolean;
  private readonly metrics: Pick<SimulationWorkerMetrics, 'recordWakeAvailability'>;
  private readonly reconciliationIntervalMs: number;
  private readonly tracing: SimulationWorkerTracing;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly runner: Pick<SimulationRunner, 'reconcile'>,
    private readonly logger: Logger,
    options: SimulationCoordinatorOptions = {},
  ) {
    this.isAutomationAvailable = options.isAutomationAvailable ?? (() => true);
    this.metrics = options.metrics ?? discardMetrics;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.reconciliationIntervalMs = options.reconciliationIntervalMs ?? 1_000;
    this.tracing = options.tracing ?? discardTracing;
    if (
      !Number.isSafeInteger(this.reconciliationIntervalMs) ||
      this.reconciliationIntervalMs < 100
    ) {
      throw new Error('SIMULATION_RECONCILIATION_INTERVAL_INVALID');
    }
  }

  /** The periodic timer stays armed, while Redis readiness gates every automation run. */
  public start(): void {
    if (this.stopped || this.timer) return;
    void this.wake('periodic');
    this.timer = setInterval(() => void this.wake('periodic'), this.reconciliationIntervalMs);
    this.timer.unref();
  }

  /** Queue payloads only call this method; they never carry authority into the runner. */
  public wake(source: 'periodic' | 'queue' = 'queue'): Promise<SimulationRunResult[]> {
    if (this.stopped) {
      this.tracing.recordSpan('simulation.wake', {
        'simulation.wake.outcome': 'stopped',
        'simulation.wake.source': source,
      });
      return Promise.resolve([]);
    }
    const available = this.isAutomationAvailable();
    this.metrics.recordWakeAvailability(available);
    if (!available) {
      this.tracing.recordSpan('simulation.wake', {
        'simulation.wake.available': false,
        'simulation.wake.outcome': 'degraded',
        'simulation.wake.source': source,
      });
      return Promise.resolve([]);
    }
    if (this.active) {
      this.tracing.recordSpan('simulation.wake', {
        'simulation.wake.available': true,
        'simulation.wake.outcome': 'coalesced',
        'simulation.wake.source': source,
      });
      return this.active;
    }
    const now = this.monotonicNow();
    if (now - this.lastStartedAt < this.reconciliationIntervalMs) {
      this.tracing.recordSpan('simulation.wake', {
        'simulation.wake.available': true,
        'simulation.wake.outcome': 'paced',
        'simulation.wake.source': source,
      });
      return Promise.resolve([]);
    }
    this.lastStartedAt = now;
    const active = this.tracing.withSpan(
      'simulation.wake',
      {
        'simulation.wake.available': true,
        'simulation.wake.outcome': 'reconcile',
        'simulation.wake.source': source,
      },
      async () => this.runner.reconcile(),
    );
    this.active = active;
    const clear = (): void => {
      if (this.active === active) this.active = undefined;
    };
    void active.then(clear, () => {
      clear();
      this.logger.error(
        { code: 'SIMULATION_RECONCILIATION_FAILED' },
        'simulation.reconciliation_failed',
      );
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
