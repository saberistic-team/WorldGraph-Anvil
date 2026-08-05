import { describe, expect, it, vi } from 'vitest';

import type { InternalGovernanceCommandExecutionInput } from '@worldgraph/governance-command';

import {
  GOVERNANCE_SCHEDULE_ACTION_TYPES,
  type GovernanceOperationalSnapshot,
  type GovernanceScheduledEffectCandidate,
  type GovernanceScheduleRepository,
} from './governance-schedule-repository.js';
import {
  GovernanceScheduleCoordinator,
  GovernanceScheduleRunner,
  governanceScheduledCommandInput,
  type GovernanceInternalCommandPort,
  type GovernanceScheduleTracing,
  type GovernanceScheduleWorkerMetrics,
} from './governance-schedule-worker.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const actionId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const completedEventId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const targetId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const contestId = '018f8652-3cb6-7d52-904b-cce7901d7e29';
const snapshotId = '018f8652-3cb6-7d52-904b-cce7901d7e30';

const operationalSnapshot: GovernanceOperationalSnapshot = {
  maxProjectionLagRevisions: 2,
  pendingOutboxCount: 1,
  states: [],
};

const closeCandidate: GovernanceScheduledEffectCandidate = {
  actionType: 'CloseAndTallyProposalV1',
  aggregateVersion: '3',
  algorithmVersion: 'proposal_yes_no_v1',
  completedEventId,
  contestId,
  currentTick: '15',
  dueTick: '12',
  eligibilitySnapshotId: snapshotId,
  expectedStateRevision: '19',
  expectedWorldVersion: '4',
  occurrenceKey: `governance:proposal:${targetId}:close_tally:12`,
  scheduleSequence: '7',
  scheduledActionId: actionId,
  targetId,
  targetKind: 'proposal',
  worldId,
};

function logger() {
  return { error: vi.fn(), warn: vi.fn() } as never;
}

function observedMetrics(): GovernanceScheduleWorkerMetrics {
  return {
    recordCommand: vi.fn(),
    recordDiscovery: vi.fn(),
    recordEnactmentFailure: vi.fn(),
    recordOperationalSnapshot: vi.fn(),
    recordScheduleLag: vi.fn(),
    recordSweep: vi.fn(),
    recordTally: vi.fn(),
    recordTallyChecksumMismatch: vi.fn(),
  };
}

function accepted(input: InternalGovernanceCommandExecutionInput) {
  const resultingStateRevision = (BigInt(input.command.expectedStateRevision) + 1n).toString();
  return {
    replayed: false,
    result: {
      commandId: input.command.commandId,
      eventIds: ['018f8652-3cb6-7d52-904b-cce7901d7e31'],
      eventSequenceRange: { from: '20', to: '20' },
      ledgerSequenceRange: { from: '30', to: '31' },
      resultingStateRevision,
      schemaVersion: 1 as const,
      status: 'accepted' as const,
    },
  };
}

function closeCandidateWith(input: {
  actionId: string;
  contestId: string;
  eventId: string;
  expectedStateRevision?: string;
  targetId: string;
  worldId?: string;
}): GovernanceScheduledEffectCandidate {
  return {
    ...closeCandidate,
    completedEventId: input.eventId,
    contestId: input.contestId,
    expectedStateRevision: input.expectedStateRevision ?? closeCandidate.expectedStateRevision,
    occurrenceKey: `governance:proposal:${input.targetId}:close_tally:12`,
    scheduledActionId: input.actionId,
    targetId: input.targetId,
    worldId: input.worldId ?? worldId,
  };
}

function openCandidateWith(input: {
  actionId: string;
  aggregateVersion?: string;
  eventId: string;
  expectedStateRevision?: string;
  snapshotChecksum?: string;
  snapshotSourceStateRevision?: string;
  targetId: string;
}): GovernanceScheduledEffectCandidate {
  const expectedStateRevision = input.expectedStateRevision ?? '19';
  return {
    actionType: 'OpenProposalVotingV1',
    aggregateVersion: input.aggregateVersion ?? '1',
    completedEventId: input.eventId,
    contestId,
    currentTick: '15',
    dueTick: '12',
    eligibilitySnapshot: {
      eligibleCount: 3,
      policyChecksum: 'a'.repeat(64),
      snapshotChecksum: input.snapshotChecksum ?? 'b'.repeat(64),
      snapshotId,
      sourceStateRevision: input.snapshotSourceStateRevision ?? expectedStateRevision,
    },
    expectedStateRevision,
    expectedWorldVersion: '4',
    occurrenceKey: `governance:proposal:${input.targetId}:open:12`,
    scheduleSequence: '7',
    scheduledActionId: input.actionId,
    targetId: input.targetId,
    targetKind: 'proposal',
    worldId,
  };
}

function staticRepository(
  ...candidates: GovernanceScheduledEffectCandidate[]
): GovernanceScheduleRepository {
  return {
    findPendingEffect: vi.fn(async (scheduledActionId: string) => {
      return (
        candidates.find((candidate) => candidate.scheduledActionId === scheduledActionId) ?? null
      );
    }),
    findPendingEffects: vi.fn(async () => candidates),
    readOperationalSnapshot: vi.fn(async () => operationalSnapshot),
  };
}

describe('governance schedule worker', () => {
  it('builds deterministic internal commands from completed-event provenance', () => {
    const first = governanceScheduledCommandInput(closeCandidate);
    const second = governanceScheduledCommandInput(structuredClone(closeCandidate));

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      actor: {
        actorEntityId: null,
        actorId: 'worldgraph:governance-scheduler',
        actorType: 'system',
      },
      causationId: completedEventId,
      command: {
        actorMode: 'system',
        expectedAggregateVersion: '3',
        expectedStateRevision: '19',
        expectedTick: '15',
        expectedWorldVersion: '4',
        payload: {
          algorithmVersion: 'proposal_yes_no_v1',
          eligibilitySnapshotId: snapshotId,
          expectedProposalVersion: '3',
          occurrenceKey: closeCandidate.occurrenceKey,
          proposalId: targetId,
        },
        type: 'CloseAndTallyProposalV1',
      },
      scheduler: {
        completedEventId,
        dueTick: '12',
        occurrenceKey: closeCandidate.occurrenceKey,
        scheduledActionId: actionId,
      },
      worldId,
    });
    expect(first.command.expectedTick).not.toBe(first.scheduler.dueTick);
    expect(first.command.idempotencyKey).toMatch(/^governance-schedule-v1\.[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toMatch(/"(?:choice|selection|secret)"/iu);
  });

  it('dispatches once per discovery, records lag/tally metrics, and emits safe trace fields', async () => {
    const repository = staticRepository(closeCandidate);
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) =>
      accepted(input),
    );
    const commands: GovernanceInternalCommandPort = { executeInternal };
    const metrics = observedMetrics();
    const traceCalls: Array<[string, Readonly<Record<string, boolean | number | string>>]> = [];
    const tracing: GovernanceScheduleTracing = {
      async withSpan<T>(
        name: string,
        attributes: Readonly<Record<string, boolean | number | string>>,
        operation: () => Promise<T>,
      ): Promise<T> {
        traceCalls.push([name, attributes]);
        return operation();
      },
    };
    const runner = new GovernanceScheduleRunner(repository, commands, logger(), {
      batchSize: 25,
      metrics,
      monotonicNow: (() => {
        let now = 0;
        return () => ++now;
      })(),
      tracing,
    });

    await expect(runner.reconcile()).resolves.toEqual([
      {
        actionType: 'CloseAndTallyProposalV1',
        outcome: 'accepted',
        scheduledActionId: actionId,
      },
    ]);
    expect(executeInternal).toHaveBeenCalledTimes(1);
    expect(metrics.recordOperationalSnapshot).toHaveBeenCalledWith(operationalSnapshot);
    expect(metrics.recordScheduleLag).toHaveBeenCalledWith(3, 'CloseAndTallyProposalV1');
    expect(metrics.recordTally).toHaveBeenCalledWith(
      expect.any(Number),
      'CloseAndTallyProposalV1',
      'accepted',
    );
    expect(traceCalls[0]![1]).toEqual({
      'governance.schedule.action_type': 'CloseAndTallyProposalV1',
      'governance.schedule.lag_ticks': 3,
      'governance.schedule.target_kind': 'proposal',
    });
    expect(JSON.stringify(traceCalls[0]![1])).not.toMatch(/choice|selection|secret|voter/iu);
  });

  it('keeps operational telemetry refresh failure outside scheduler authority and sweep outcome', async () => {
    const repository: GovernanceScheduleRepository = {
      ...staticRepository(),
      readOperationalSnapshot: vi.fn(async () => {
        throw Object.assign(new Error('private database detail'), { code: '08006' });
      }),
    };
    const safeLogger = logger() as unknown as {
      error: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    };
    const metrics = observedMetrics();
    const runner = new GovernanceScheduleRunner(
      repository,
      { executeInternal: vi.fn() },
      safeLogger as never,
      { batchSize: 1, metrics },
    );

    await expect(runner.reconcile()).resolves.toEqual([]);
    expect(metrics.recordOperationalSnapshot).not.toHaveBeenCalled();
    expect(metrics.recordSweep).toHaveBeenCalledWith(expect.any(Number), 'succeeded');
    expect(safeLogger.error).not.toHaveBeenCalled();
    expect(safeLogger.warn).toHaveBeenCalledWith(
      {
        code: 'GOVERNANCE_OPERATIONAL_METRICS_REFRESH_FAILED',
        failureClass: 'dependency',
      },
      'governance.operational_metrics_refresh_failed',
    );
    expect(JSON.stringify(safeLogger.warn.mock.calls)).not.toMatch(
      /private database detail|contest|voter|worldId/iu,
    );
  });

  it('reuses the exact request identity after an uncertain response', async () => {
    const repository = staticRepository(closeCandidate);
    const seen: InternalGovernanceCommandExecutionInput[] = [];
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) => {
      seen.push(structuredClone(input));
      if (seen.length === 1) throw Object.assign(new Error('lost response'), { code: '08006' });
      return { ...accepted(input), replayed: true };
    });
    const runner = new GovernanceScheduleRunner(repository, { executeInternal }, logger(), {
      batchSize: 1,
    });

    await expect(runner.reconcile()).resolves.toEqual([
      expect.objectContaining({ outcome: 'failed' }),
    ]);
    await expect(runner.reconcile()).resolves.toEqual([
      expect.objectContaining({ outcome: 'accepted' }),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
  });

  it('carries accepted and replayed revisions through same-world candidates in claimed order', async () => {
    const candidates = [
      closeCandidateWith({
        actionId: '018f8652-3cb6-7d52-904b-cce7901d7e32',
        contestId: '018f8652-3cb6-7d52-904b-cce7901d7e33',
        eventId: '018f8652-3cb6-7d52-904b-cce7901d7e34',
        targetId: '018f8652-3cb6-7d52-904b-cce7901d7e35',
      }),
      closeCandidateWith({
        actionId: '018f8652-3cb6-7d52-904b-cce7901d7e36',
        contestId: '018f8652-3cb6-7d52-904b-cce7901d7e37',
        eventId: '018f8652-3cb6-7d52-904b-cce7901d7e38',
        targetId: '018f8652-3cb6-7d52-904b-cce7901d7e39',
      }),
      closeCandidateWith({
        actionId: '018f8652-3cb6-7d52-904b-cce7901d7e40',
        contestId: '018f8652-3cb6-7d52-904b-cce7901d7e41',
        eventId: '018f8652-3cb6-7d52-904b-cce7901d7e42',
        targetId: '018f8652-3cb6-7d52-904b-cce7901d7e43',
      }),
    ];
    const seen: string[] = [];
    let calls = 0;
    let refreshes = 0;
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) => {
      seen.push(input.command.expectedStateRevision);
      calls += 1;
      return { ...accepted(input), replayed: calls === 2 };
    });
    const runner = new GovernanceScheduleRunner(
      {
        findPendingEffect: vi.fn(async (scheduledActionId: string) => {
          refreshes += 1;
          const nextRevision = refreshes === 1 ? '20' : '21';
          const candidate = candidates.find(
            (entry) => entry.scheduledActionId === scheduledActionId,
          );
          return candidate ? { ...candidate, expectedStateRevision: nextRevision } : null;
        }),
        findPendingEffects: vi.fn(async () => candidates),
        readOperationalSnapshot: vi.fn(async () => operationalSnapshot),
      },
      { executeInternal },
      logger(),
      { batchSize: 3 },
    );

    await expect(runner.reconcile()).resolves.toEqual(
      candidates.map((candidate) => ({
        actionType: candidate.actionType,
        outcome: 'accepted',
        scheduledActionId: candidate.scheduledActionId,
      })),
    );
    expect(seen).toEqual(['19', '20', '21']);
  });

  it('refreshes an exact claimed action after a same-world commit even when discovery is saturated', async () => {
    const first = openCandidateWith({
      actionId: '018f8652-3cb6-7d52-904b-cce7901d7e61',
      eventId: '018f8652-3cb6-7d52-904b-cce7901d7e62',
      targetId: '018f8652-3cb6-7d52-904b-cce7901d7e63',
    });
    const staleSecond = openCandidateWith({
      actionId: '018f8652-3cb6-7d52-904b-cce7901d7e64',
      eventId: '018f8652-3cb6-7d52-904b-cce7901d7e65',
      targetId: '018f8652-3cb6-7d52-904b-cce7901d7e66',
    });
    const refreshedSecond = openCandidateWith({
      actionId: staleSecond.scheduledActionId,
      aggregateVersion: '4',
      eventId: staleSecond.completedEventId,
      expectedStateRevision: '20',
      snapshotChecksum: 'c'.repeat(64),
      snapshotSourceStateRevision: '20',
      targetId: staleSecond.targetId,
    });
    const findPendingEffect = vi.fn(async () => refreshedSecond);
    const findPendingEffects = vi
      .fn<GovernanceScheduleRepository['findPendingEffects']>()
      .mockResolvedValueOnce([first, staleSecond])
      .mockResolvedValueOnce([first]);
    const repository: GovernanceScheduleRepository = {
      findPendingEffect,
      findPendingEffects,
      readOperationalSnapshot: vi.fn(async () => operationalSnapshot),
    };
    const inputs: InternalGovernanceCommandExecutionInput[] = [];
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) => {
      inputs.push(input);
      return accepted(input);
    });
    const runner = new GovernanceScheduleRunner(repository, { executeInternal }, logger(), {
      batchSize: 2,
    });

    await expect(runner.reconcile()).resolves.toHaveLength(2);
    expect(findPendingEffects).toHaveBeenCalledTimes(1);
    expect(findPendingEffect).toHaveBeenCalledWith(
      staleSecond.scheduledActionId,
      GOVERNANCE_SCHEDULE_ACTION_TYPES,
    );
    expect(inputs[1]).toMatchObject({
      command: {
        expectedAggregateVersion: '4',
        expectedStateRevision: '20',
        payload: {
          eligibilitySnapshot: {
            snapshotChecksum: 'c'.repeat(64),
            sourceStateRevision: '20',
          },
          expectedProposalVersion: '4',
        },
      },
    });
  });

  it('does not speculate after a failed command and keeps later worlds independent', async () => {
    const secondWorldId = '018f8652-3cb6-7d52-904b-cce7901d7e44';
    const candidates = [
      closeCandidateWith({
        actionId: '018f8652-3cb6-7d52-904b-cce7901d7e45',
        contestId: '018f8652-3cb6-7d52-904b-cce7901d7e46',
        eventId: '018f8652-3cb6-7d52-904b-cce7901d7e47',
        targetId: '018f8652-3cb6-7d52-904b-cce7901d7e48',
      }),
      closeCandidateWith({
        actionId: '018f8652-3cb6-7d52-904b-cce7901d7e49',
        contestId: '018f8652-3cb6-7d52-904b-cce7901d7e50',
        eventId: '018f8652-3cb6-7d52-904b-cce7901d7e51',
        expectedStateRevision: '44',
        targetId: '018f8652-3cb6-7d52-904b-cce7901d7e52',
        worldId: secondWorldId,
      }),
      closeCandidateWith({
        actionId: '018f8652-3cb6-7d52-904b-cce7901d7e53',
        contestId: '018f8652-3cb6-7d52-904b-cce7901d7e54',
        eventId: '018f8652-3cb6-7d52-904b-cce7901d7e55',
        targetId: '018f8652-3cb6-7d52-904b-cce7901d7e56',
      }),
      closeCandidateWith({
        actionId: '018f8652-3cb6-7d52-904b-cce7901d7e57',
        contestId: '018f8652-3cb6-7d52-904b-cce7901d7e58',
        eventId: '018f8652-3cb6-7d52-904b-cce7901d7e59',
        expectedStateRevision: '44',
        targetId: '018f8652-3cb6-7d52-904b-cce7901d7e60',
        worldId: secondWorldId,
      }),
    ];
    const seen: Array<{ revision: string; worldId: string }> = [];
    let calls = 0;
    let refreshes = 0;
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) => {
      seen.push({ revision: input.command.expectedStateRevision, worldId: input.worldId });
      calls += 1;
      if (calls === 1) throw new Error('injected command failure');
      return accepted(input);
    });
    const runner = new GovernanceScheduleRunner(
      {
        findPendingEffect: vi.fn(async (scheduledActionId: string) => {
          refreshes += 1;
          const candidate = candidates.find(
            (entry) => entry.scheduledActionId === scheduledActionId,
          );
          return candidate ? { ...candidate, expectedStateRevision: '45' } : null;
        }),
        findPendingEffects: vi.fn(async () => candidates),
        readOperationalSnapshot: vi.fn(async () => operationalSnapshot),
      },
      { executeInternal },
      logger(),
      { batchSize: 4 },
    );

    await expect(runner.reconcile()).resolves.toEqual([
      expect.objectContaining({ outcome: 'failed' }),
      expect.objectContaining({ outcome: 'accepted' }),
      expect.objectContaining({ outcome: 'accepted' }),
      expect.objectContaining({ outcome: 'accepted' }),
    ]);
    expect(seen).toEqual([
      { revision: '19', worldId },
      { revision: '44', worldId: secondWorldId },
      { revision: '19', worldId },
      { revision: '45', worldId: secondWorldId },
    ]);
    expect(refreshes).toBe(1);
  });

  it('isolates an exact-refresh failure and continues processing independent worlds', async () => {
    const secondWorldId = '018f8652-3cb6-7d52-904b-cce7901d7e70';
    const first = closeCandidateWith({
      actionId: '018f8652-3cb6-7d52-904b-cce7901d7e71',
      contestId: '018f8652-3cb6-7d52-904b-cce7901d7e72',
      eventId: '018f8652-3cb6-7d52-904b-cce7901d7e73',
      targetId: '018f8652-3cb6-7d52-904b-cce7901d7e74',
    });
    const staleSameWorld = closeCandidateWith({
      actionId: '018f8652-3cb6-7d52-904b-cce7901d7e75',
      contestId: '018f8652-3cb6-7d52-904b-cce7901d7e76',
      eventId: '018f8652-3cb6-7d52-904b-cce7901d7e77',
      targetId: '018f8652-3cb6-7d52-904b-cce7901d7e78',
    });
    const independent = closeCandidateWith({
      actionId: '018f8652-3cb6-7d52-904b-cce7901d7e79',
      contestId: '018f8652-3cb6-7d52-904b-cce7901d7e80',
      eventId: '018f8652-3cb6-7d52-904b-cce7901d7e81',
      expectedStateRevision: '44',
      targetId: '018f8652-3cb6-7d52-904b-cce7901d7e82',
      worldId: secondWorldId,
    });
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) =>
      accepted(input),
    );
    const safeLogger = logger() as unknown as { error: ReturnType<typeof vi.fn> };
    const metrics = observedMetrics();
    const runner = new GovernanceScheduleRunner(
      {
        findPendingEffect: vi.fn(async () => {
          throw new Error('injected exact-refresh failure');
        }),
        findPendingEffects: vi.fn(async () => [first, staleSameWorld, independent]),
        readOperationalSnapshot: vi.fn(async () => operationalSnapshot),
      },
      { executeInternal },
      safeLogger as never,
      { batchSize: 3, metrics },
    );

    await expect(runner.reconcile()).resolves.toEqual([
      expect.objectContaining({ outcome: 'accepted' }),
      expect.objectContaining({ outcome: 'failed' }),
      expect.objectContaining({ outcome: 'accepted' }),
    ]);
    expect(executeInternal).toHaveBeenCalledTimes(2);
    expect(executeInternal.mock.calls.map(([input]) => input.worldId)).toEqual([
      worldId,
      secondWorldId,
    ]);
    expect(safeLogger.error).toHaveBeenCalledTimes(1);
    expect(metrics.recordSweep).toHaveBeenCalledWith(expect.any(Number), 'failed');
  });

  it('keeps the coordinator inert when governance scheduling is disabled', async () => {
    const reconcile = vi.fn(async () => []);
    const coordinator = new GovernanceScheduleCoordinator({ reconcile }, logger(), {
      enabled: false,
      reconciliationIntervalMs: 1_000,
    });
    coordinator.start();
    await expect(coordinator.wake()).resolves.toEqual([]);
    await coordinator.stop();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('does not consume an action while its independent safety flag is paused', async () => {
    const findPendingEffects = vi.fn(async () => [closeCandidate]);
    const repository: GovernanceScheduleRepository = {
      findPendingEffect: vi.fn(async () => closeCandidate),
      findPendingEffects,
      readOperationalSnapshot: vi.fn(async () => operationalSnapshot),
    };
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) =>
      accepted(input),
    );
    const runner = new GovernanceScheduleRunner(repository, { executeInternal }, logger(), {
      batchSize: 1,
      isActionEnabled: () => false,
    });

    await expect(runner.reconcile()).resolves.toEqual([]);
    expect(findPendingEffects).toHaveBeenCalledWith(1, []);
    expect(executeInternal).not.toHaveBeenCalled();
  });

  it('records a checksum mismatch without logging result or ballot material', async () => {
    const repository = staticRepository(closeCandidate);
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) => ({
      replayed: false,
      result: {
        commandId: input.command.commandId,
        currentStateRevision: '19',
        eventIds: [],
        rejectionCode: 'TALLY_CHECKSUM_MISMATCH' as const,
        schemaVersion: 1 as const,
        status: 'rejected' as const,
      },
    }));
    const metrics = observedMetrics();
    const safeLogger = logger() as unknown as { error: ReturnType<typeof vi.fn> };
    const runner = new GovernanceScheduleRunner(
      repository,
      { executeInternal },
      safeLogger as never,
      {
        batchSize: 1,
        metrics,
      },
    );
    await runner.reconcile();
    expect(metrics.recordTallyChecksumMismatch).toHaveBeenCalledWith('CloseAndTallyProposalV1');
    expect(safeLogger.error).not.toHaveBeenCalled();
  });

  it('records a newly committed enactment failure exactly once and never on replay', async () => {
    const repository = staticRepository(closeCandidate);
    let replayed = false;
    const executeInternal = vi.fn(async (input: InternalGovernanceCommandExecutionInput) => ({
      ...accepted(input),
      details: {
        enactmentFailure: 'CONFLICT',
        status: 'passed_but_enactment_failed',
      },
      replayed,
    }));
    const metrics = observedMetrics();
    const runner = new GovernanceScheduleRunner(repository, { executeInternal }, logger(), {
      batchSize: 1,
      metrics,
    });

    await runner.reconcile();
    replayed = true;
    await runner.reconcile();

    expect(metrics.recordEnactmentFailure).toHaveBeenCalledTimes(1);
    expect(metrics.recordEnactmentFailure).toHaveBeenCalledWith('CloseAndTallyProposalV1');
  });
});
