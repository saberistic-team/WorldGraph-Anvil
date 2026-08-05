import { metrics } from '@opentelemetry/api';
import type { Logger } from 'pino';

import {
  GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION,
  GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION,
  GOVERNANCE_SCHEMA_VERSION,
  type InternalGovernanceCommandRequestV1,
  type WorldCommandResultV1,
} from '@worldgraph/contracts';
import {
  governanceScheduleIdempotencyKey,
  type GovernanceCommandExecutionResult,
  type InternalGovernanceCommandExecutionInput,
} from '@worldgraph/governance-command';
import {
  annotateActiveGovernanceCommandSpan,
  telemetry,
  withSpan,
} from '@worldgraph/observability';

import {
  GOVERNANCE_SCHEDULE_ACTION_TYPES,
  GOVERNANCE_SCHEDULER_ACTOR_ID,
  governanceScheduleDeterministicUuid,
  type GovernanceOperationalSnapshot,
  type GovernanceScheduledEffectCandidate,
  type GovernanceScheduleRepository,
} from './governance-schedule-repository.js';

export interface GovernanceInternalCommandPort {
  executeInternal(
    input: InternalGovernanceCommandExecutionInput,
  ): Promise<GovernanceCommandExecutionResult>;
}

export type GovernanceScheduleRunOutcome = WorldCommandResultV1['status'] | 'failed';

export interface GovernanceScheduleRunResult {
  actionType: GovernanceScheduledEffectCandidate['actionType'];
  outcome: GovernanceScheduleRunOutcome;
  scheduledActionId: string;
}

export interface GovernanceScheduleWorkerMetrics {
  recordCommand: (
    actionType: string,
    milliseconds: number,
    outcome: GovernanceScheduleRunOutcome,
  ) => void;
  recordDiscovery: (count: number) => void;
  recordEnactmentFailure: (actionType: string) => void;
  recordOperationalSnapshot: (snapshot: GovernanceOperationalSnapshot) => void;
  recordScheduleLag: (ticks: number, actionType: string) => void;
  recordSweep: (milliseconds: number, outcome: 'failed' | 'succeeded') => void;
  recordTally: (
    milliseconds: number,
    actionType: string,
    outcome: GovernanceScheduleRunOutcome,
  ) => void;
  recordTallyChecksumMismatch: (actionType: string) => void;
}

const discardMetrics: GovernanceScheduleWorkerMetrics = {
  recordCommand: () => undefined,
  recordDiscovery: () => undefined,
  recordEnactmentFailure: () => undefined,
  recordOperationalSnapshot: () => undefined,
  recordScheduleLag: () => undefined,
  recordSweep: () => undefined,
  recordTally: () => undefined,
  recordTallyChecksumMismatch: () => undefined,
};

type GovernanceTraceValue = boolean | number | string;
type GovernanceTraceAttributes = Readonly<Record<string, GovernanceTraceValue>>;

export interface GovernanceScheduleTracing {
  withSpan<T>(
    name: string,
    attributes: GovernanceTraceAttributes,
    operation: () => Promise<T>,
  ): Promise<T>;
}

const discardTracing: GovernanceScheduleTracing = {
  withSpan: async (_name, _attributes, operation) => operation(),
};

export function createProductionGovernanceScheduleMetrics(): GovernanceScheduleWorkerMetrics {
  const meter = metrics.getMeter('worldgraph-worker');
  const commands = meter.createCounter('worldgraph_governance_scheduled_commands_total');
  const commandDuration = meter.createHistogram(
    'worldgraph_governance_scheduled_command_duration_ms',
  );
  const discoveries = meter.createHistogram('worldgraph_governance_scheduled_effects_pending');
  const sweeps = meter.createCounter('worldgraph_governance_scheduler_sweeps_total');
  const sweepDuration = meter.createHistogram('worldgraph_governance_scheduler_sweep_duration_ms');
  return {
    recordCommand(actionType, milliseconds, outcome) {
      const attributes = { action_type: actionType, outcome };
      commands.add(1, attributes);
      commandDuration.record(milliseconds, attributes);
      telemetry.governanceCommands.add(1, {
        command_type: actionType,
        outcome,
        source: 'scheduler',
      });
    },
    recordDiscovery(count) {
      discoveries.record(count);
    },
    recordEnactmentFailure(actionType) {
      telemetry.governanceEnactmentFailures.add(1, { command_type: actionType });
    },
    recordOperationalSnapshot(snapshot) {
      telemetry.setGovernanceOperationalState(snapshot);
    },
    recordScheduleLag(ticks, actionType) {
      telemetry.governanceSchedulerLag.record(ticks, { action_type: actionType });
    },
    recordSweep(milliseconds, outcome) {
      sweeps.add(1, { outcome });
      sweepDuration.record(milliseconds, { outcome });
    },
    recordTally(milliseconds, actionType, outcome) {
      telemetry.governanceTallyDuration.record(milliseconds, {
        command_type: actionType,
        outcome,
      });
    },
    recordTallyChecksumMismatch(actionType) {
      telemetry.governanceTallyChecksumMismatches.add(1, { command_type: actionType });
    },
  };
}

export function createProductionGovernanceScheduleTracing(): GovernanceScheduleTracing {
  return {
    withSpan(name, attributes, operation) {
      return withSpan(name, async (span) => {
        span.setAttributes(attributes);
        return operation();
      });
    },
  };
}

export interface GovernanceScheduleRunnerOptions {
  batchSize: number;
  isActionEnabled?: (actionType: GovernanceScheduledEffectCandidate['actionType']) => boolean;
  metrics?: GovernanceScheduleWorkerMetrics;
  monotonicNow?: () => number;
  tracing?: GovernanceScheduleTracing;
}

export class GovernanceScheduleRunner {
  private readonly batchSize: number;
  private readonly isActionEnabled: (
    actionType: GovernanceScheduledEffectCandidate['actionType'],
  ) => boolean;
  private readonly metrics: GovernanceScheduleWorkerMetrics;
  private readonly monotonicNow: () => number;
  private readonly tracing: GovernanceScheduleTracing;

  public constructor(
    private readonly repository: GovernanceScheduleRepository,
    private readonly commands: GovernanceInternalCommandPort,
    private readonly logger: Logger,
    options: GovernanceScheduleRunnerOptions,
  ) {
    this.batchSize = options.batchSize;
    this.isActionEnabled = options.isActionEnabled ?? (() => true);
    this.metrics = options.metrics ?? discardMetrics;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.tracing = options.tracing ?? discardTracing;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 250) {
      throw new Error('GOVERNANCE_SCHEDULE_RUNNER_CONFIGURATION_INVALID');
    }
  }

  public async reconcile(): Promise<GovernanceScheduleRunResult[]> {
    const sweepStartedAt = this.monotonicNow();
    let sweepFailed = false;
    try {
      const enabledActionTypes = GOVERNANCE_SCHEDULE_ACTION_TYPES.filter(this.isActionEnabled);
      const candidates = await this.repository.findPendingEffects(
        this.batchSize,
        enabledActionTypes,
      );
      this.metrics.recordDiscovery(candidates.length);
      try {
        this.metrics.recordOperationalSnapshot(await this.repository.readOperationalSnapshot());
      } catch (error) {
        this.logger.warn(
          {
            code: 'GOVERNANCE_OPERATIONAL_METRICS_REFRESH_FAILED',
            failureClass: safeFailureClass(error),
          },
          'governance.operational_metrics_refresh_failed',
        );
      }
      const results: GovernanceScheduleRunResult[] = [];
      const committedStateRevisionByWorld = new Map<string, string>();
      for (const candidate of candidates) {
        if (!this.isActionEnabled(candidate.actionType)) continue;
        const startedAt = this.monotonicNow();
        try {
          let executionCandidate = candidate;
          const committedStateRevision = committedStateRevisionByWorld.get(candidate.worldId);
          if (committedStateRevision !== undefined) {
            const refreshed = await this.repository.findPendingEffect(
              candidate.scheduledActionId,
              enabledActionTypes,
            );
            if (!refreshed) continue;
            executionCandidate = refreshed;
          }
          const lag = scheduleLag(executionCandidate);
          this.metrics.recordScheduleLag(lag, candidate.actionType);
          const execution = await this.tracing.withSpan(
            'governance.schedule.execute',
            {
              'governance.schedule.action_type': candidate.actionType,
              'governance.schedule.lag_ticks': lag,
              'governance.schedule.target_kind': executionCandidate.targetKind,
            },
            async () => {
              const input = governanceScheduledCommandInput(executionCandidate);
              annotateActiveGovernanceCommandSpan({
                actorId: input.actor.actorId,
                commandId: input.command.commandId,
                commandType: input.command.type,
                contestId: executionCandidate.contestId,
                contestType: executionCandidate.targetKind,
                correlationId: input.correlationId,
                occurrenceKey: executionCandidate.occurrenceKey,
                tick: executionCandidate.currentTick,
                worldId: executionCandidate.worldId,
                ...('eligibilitySnapshot' in executionCandidate
                  ? {
                      eligibilitySnapshotId: executionCandidate.eligibilitySnapshot.snapshotId,
                    }
                  : 'eligibilitySnapshotId' in executionCandidate
                    ? { eligibilitySnapshotId: executionCandidate.eligibilitySnapshotId }
                    : {}),
                ...('expectedResultChecksum' in executionCandidate
                  ? { resultChecksum: executionCandidate.expectedResultChecksum }
                  : {}),
              });
              return this.commands.executeInternal(input);
            },
          );
          if (execution.result.status === 'accepted') {
            committedStateRevisionByWorld.set(
              candidate.worldId,
              execution.result.resultingStateRevision,
            );
          }
          const elapsed = Math.max(0, this.monotonicNow() - startedAt);
          this.metrics.recordCommand(candidate.actionType, elapsed, execution.result.status);
          if (isTally(candidate)) {
            this.metrics.recordTally(elapsed, candidate.actionType, execution.result.status);
          }
          if (
            execution.result.status === 'rejected' &&
            execution.result.rejectionCode === 'TALLY_CHECKSUM_MISMATCH'
          ) {
            this.metrics.recordTallyChecksumMismatch(candidate.actionType);
          }
          if (!execution.replayed && execution.details?.status === 'passed_but_enactment_failed') {
            this.metrics.recordEnactmentFailure(candidate.actionType);
          }
          results.push({
            actionType: candidate.actionType,
            outcome: execution.result.status,
            scheduledActionId: candidate.scheduledActionId,
          });
        } catch (error) {
          sweepFailed = true;
          const elapsed = Math.max(0, this.monotonicNow() - startedAt);
          this.metrics.recordCommand(candidate.actionType, elapsed, 'failed');
          if (isTally(candidate)) {
            this.metrics.recordTally(elapsed, candidate.actionType, 'failed');
          }
          this.logger.error(
            {
              actionType: candidate.actionType,
              code: 'GOVERNANCE_SCHEDULE_COMMAND_FAILED',
              failureClass: safeFailureClass(error),
              scheduledActionId: candidate.scheduledActionId,
              worldId: candidate.worldId,
            },
            'governance.schedule_command_failed',
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
          code: 'GOVERNANCE_SCHEDULE_DISCOVERY_FAILED',
          failureClass: safeFailureClass(error),
        },
        'governance.schedule_discovery_failed',
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

export interface GovernanceScheduleCoordinatorOptions {
  enabled: boolean;
  monotonicNow?: () => number;
  reconciliationIntervalMs: number;
}

export class GovernanceScheduleCoordinator {
  private active: Promise<GovernanceScheduleRunResult[]> | undefined;
  private readonly enabled: boolean;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private readonly monotonicNow: () => number;
  private readonly reconciliationIntervalMs: number;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly runner: Pick<GovernanceScheduleRunner, 'reconcile'>,
    private readonly logger: Logger,
    options: GovernanceScheduleCoordinatorOptions,
  ) {
    this.enabled = options.enabled;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.reconciliationIntervalMs = options.reconciliationIntervalMs;
    if (
      !Number.isSafeInteger(this.reconciliationIntervalMs) ||
      this.reconciliationIntervalMs < 100 ||
      this.reconciliationIntervalMs > 60_000
    ) {
      throw new Error('GOVERNANCE_SCHEDULE_RECONCILIATION_INTERVAL_INVALID');
    }
  }

  public start(): void {
    if (!this.enabled || this.stopped || this.timer) return;
    void this.wake();
    this.timer = setInterval(() => void this.wake(), this.reconciliationIntervalMs);
    this.timer.unref();
  }

  public wake(): Promise<GovernanceScheduleRunResult[]> {
    if (!this.enabled || this.stopped) return Promise.resolve([]);
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
          code: 'GOVERNANCE_SCHEDULE_RECONCILIATION_FAILED',
          failureClass: safeFailureClass(error),
        },
        'governance.schedule_reconciliation_failed',
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

export function governanceScheduledCommandInput(
  candidate: GovernanceScheduledEffectCandidate,
): InternalGovernanceCommandExecutionInput {
  const identity = {
    dueTick: candidate.dueTick,
    targetId: candidate.targetId,
    targetKind: candidate.targetKind,
    transitionKind: candidate.actionType.includes('Open')
      ? ('open' as const)
      : candidate.actionType.includes('CloseAndTally')
        ? ('close_tally' as const)
        : ('certify' as const),
    worldId: candidate.worldId,
  };
  const commandId = governanceScheduleDeterministicUuid(candidate.scheduledActionId, 'command');
  const command = governanceCommand(
    candidate,
    commandId,
    governanceScheduleIdempotencyKey(candidate.actionType, identity),
  );
  const scheduler = {
    completedEventId: candidate.completedEventId,
    dueTick: candidate.dueTick,
    occurrenceKey: candidate.occurrenceKey,
    scheduledActionId: candidate.scheduledActionId,
  };
  return {
    actor: {
      actorEntityId: null,
      actorId: GOVERNANCE_SCHEDULER_ACTOR_ID,
      actorType: 'system',
    },
    authorization: {
      actionCode: 'governance.schedule.execute',
      allowed: true,
      context: {
        actionType: candidate.actionType,
        completedEventId: candidate.completedEventId,
        dueTick: candidate.dueTick,
        occurrenceKey: candidate.occurrenceKey,
        scheduleSequence: candidate.scheduleSequence,
        scheduledActionId: candidate.scheduledActionId,
      },
      reasonCode: 'SYSTEM_SCHEDULE_COMPLETED',
      resourceId: candidate.targetId,
      resourceType: candidate.targetKind,
      ruleId: 'system.governance.scheduler.v1',
      sources: [],
    },
    causationId: candidate.completedEventId,
    command,
    correlationId: governanceScheduleDeterministicUuid(candidate.scheduledActionId, 'correlation'),
    scheduler,
    worldId: candidate.worldId,
  };
}

function governanceCommand(
  candidate: GovernanceScheduledEffectCandidate,
  commandId: string,
  idempotencyKey: string,
): InternalGovernanceCommandRequestV1 {
  const common = {
    actorMode: 'system' as const,
    commandId,
    expectedAggregateVersion: candidate.aggregateVersion,
    expectedStateRevision: candidate.expectedStateRevision,
    expectedTick: candidate.currentTick,
    expectedWorldVersion: candidate.expectedWorldVersion,
    idempotencyKey,
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
  };
  switch (candidate.actionType) {
    case 'OpenProposalVotingV1':
      return {
        ...common,
        payload: {
          eligibilitySnapshot: candidate.eligibilitySnapshot,
          expectedProposalVersion: candidate.aggregateVersion,
          occurrenceKey: candidate.occurrenceKey,
          proposalId: candidate.targetId,
        },
        type: candidate.actionType,
      };
    case 'CloseAndTallyProposalV1':
      return {
        ...common,
        payload: {
          algorithmVersion: GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION,
          eligibilitySnapshotId: candidate.eligibilitySnapshotId,
          expectedProposalVersion: candidate.aggregateVersion,
          occurrenceKey: candidate.occurrenceKey,
          proposalId: candidate.targetId,
        },
        type: candidate.actionType,
      };
    case 'CertifyAndEnactProposalV1':
      return {
        ...common,
        payload: {
          enactmentKey: `governance:proposal:${candidate.targetId}:enact:${candidate.dueTick}`,
          expectedProposalVersion: candidate.aggregateVersion,
          expectedResultChecksum: candidate.expectedResultChecksum,
          proposalId: candidate.targetId,
          resultId: governanceScheduleDeterministicUuid(
            candidate.scheduledActionId,
            'proposal-result',
          ),
        },
        type: candidate.actionType,
      };
    case 'OpenElectionV1':
      return {
        ...common,
        payload: {
          electionId: candidate.targetId,
          eligibilitySnapshot: candidate.eligibilitySnapshot,
          expectedElectionVersion: candidate.aggregateVersion,
          occurrenceKey: candidate.occurrenceKey,
        },
        type: candidate.actionType,
      };
    case 'CloseAndTallyElectionV1':
      return {
        ...common,
        payload: {
          algorithmVersion: GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION,
          electionId: candidate.targetId,
          eligibilitySnapshotId: candidate.eligibilitySnapshotId,
          expectedElectionVersion: candidate.aggregateVersion,
          occurrenceKey: candidate.occurrenceKey,
        },
        type: candidate.actionType,
      };
    case 'CertifyElectionV1':
      return {
        ...common,
        payload: {
          electionId: candidate.targetId,
          expectedElectionVersion: candidate.aggregateVersion,
          expectedResultChecksum: candidate.expectedResultChecksum,
          resultId: governanceScheduleDeterministicUuid(
            candidate.scheduledActionId,
            'election-result',
          ),
          termTransitionKey: `governance:election:${candidate.targetId}:term:${candidate.dueTick}`,
        },
        type: candidate.actionType,
      };
  }
  throw new Error('GOVERNANCE_SCHEDULE_ACTION_UNREACHABLE');
}

function isTally(candidate: GovernanceScheduledEffectCandidate): boolean {
  return candidate.actionType.includes('CloseAndTally');
}

function scheduleLag(
  candidate: Pick<GovernanceScheduledEffectCandidate, 'currentTick' | 'dueTick'>,
): number {
  const lag = BigInt(candidate.currentTick) - BigInt(candidate.dueTick);
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
