import { describe, expect, it } from 'vitest';

import type { ScheduledActionV1, WorldSimulationClockV1 } from '@worldgraph/contracts';

import { SIGNED_INT64_MAX } from '@worldgraph/simulation';

import { planSimulationAdvanceV1 } from './planner.js';

const worldId = '078f0000-0000-7000-8000-000000000001';
const now = '2026-07-22T00:00:00.000Z';

function clock(): WorldSimulationClockV1 {
  return {
    clockSchemaVersion: 1,
    configuration: {
      epochAt: '2000-01-01T00:00:00.000Z',
      maxBatchTicks: 64,
      maxCatchUpTicks: 256,
      prngAlgorithmVersion: 'xorshift32-sha256-v1',
      wallCadenceMilliseconds: 1_000,
      worldMillisecondsPerTick: 86_400_000,
    },
    currentTick: '0',
    lastWallAnchorAt: now,
    mode: 'running',
    outcomeHash: 'c'.repeat(64),
    projectionSchemaVersion: 1,
    rowVersion: '1',
    updatedAt: now,
    updatedStateRevision: '1',
    worldId,
  };
}

function action(input: {
  dueTick: string;
  id: string;
  priority: number;
  sequence: string;
}): ScheduledActionV1 {
  return {
    actionSchemaVersion: 1,
    actionType: 'EmitWorldNoticeV1',
    cancelledCommandId: null,
    completedEventId: null,
    completedStateRevision: null,
    createdAt: now,
    createdBy: { actorId: 'creator:test', actorType: 'system' },
    createdCommandId: '078f0000-0000-7000-8000-000000000010',
    createdStateRevision: '1',
    dueTick: input.dueTick,
    id: input.id,
    payload: { text: `Notice ${input.sequence}`, visibility: 'public' },
    payloadHash: input.sequence.padStart(64, 'a').slice(-64),
    priority: input.priority,
    processVersion: '1.0.0',
    scheduleSchemaVersion: 1,
    scheduleSequence: input.sequence,
    status: 'scheduled',
    updatedAt: now,
    worldId,
  };
}

describe('pure simulation advance planner', () => {
  it('orders due actions by tick, priority, sequence, and stable id independent of input order', () => {
    const actions = [
      action({
        dueTick: '2',
        id: '078f0000-0000-7000-8000-000000000023',
        priority: 0,
        sequence: '3',
      }),
      action({
        dueTick: '1',
        id: '078f0000-0000-7000-8000-000000000022',
        priority: -1,
        sequence: '2',
      }),
      action({
        dueTick: '1',
        id: '078f0000-0000-7000-8000-000000000021',
        priority: -1,
        sequence: '1',
      }),
    ];
    const input = {
      clock: clock(),
      dueActions: actions,
      startingProjectionChecksum: 'b'.repeat(64),
      ticks: 2,
      worldSeed: 'planner-seed',
    };

    const planned = planSimulationAdvanceV1(input);
    const reordered = planSimulationAdvanceV1({ ...input, dueActions: [...actions].reverse() });

    expect(planned.executions.map(({ action: value }) => value.scheduleSequence)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(planned.nextClockState.currentTick).toBe('2');
    expect(reordered.outcome.outcomeHash).toBe(planned.outcome.outcomeHash);
  });

  it('fails closed on an overdue, duplicate, or cross-world due set', () => {
    const overdue = action({
      dueTick: '0',
      id: '078f0000-0000-7000-8000-000000000031',
      priority: 0,
      sequence: '1',
    });
    expect(() =>
      planSimulationAdvanceV1({
        clock: clock(),
        dueActions: [overdue],
        startingProjectionChecksum: 'b'.repeat(64),
        ticks: 1,
        worldSeed: 'planner-seed',
      }),
    ).toThrow('SIMULATION_DUE_SET_INVALID');
  });

  it('attributes an unrenderable target tick to the deterministic world clock source', () => {
    const boundaryClock: WorldSimulationClockV1 = {
      ...clock(),
      configuration: {
        ...clock().configuration,
        epochAt: '9999-12-31T23:59:59.997Z',
        maxBatchTicks: 2,
        maxCatchUpTicks: 2,
        worldMillisecondsPerTick: 1,
      },
      currentTick: '2',
    };
    try {
      planSimulationAdvanceV1({
        clock: boundaryClock,
        dueActions: [],
        startingProjectionChecksum: 'b'.repeat(64),
        ticks: 1,
        worldSeed: 'planner-seed',
      });
      throw new Error('Expected world-clock exhaustion to fail.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'SIMULATION_INTEGER_OVERFLOW',
        failure: {
          errorCode: 'SIMULATION_INTEGER_OVERFLOW',
          processType: 'WorldClockV1',
          processVersion: '1.0.0',
          scheduleId: null,
          tick: '3',
        },
      });
    }
  });

  it('uses the authoritative tick when an attempted target exceeds signed int64 storage', () => {
    try {
      planSimulationAdvanceV1({
        clock: { ...clock(), currentTick: SIGNED_INT64_MAX.toString(10) },
        dueActions: [],
        startingProjectionChecksum: 'b'.repeat(64),
        ticks: 1,
        worldSeed: 'planner-seed',
      });
      throw new Error('Expected target tick overflow to fail.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'SIMULATION_INTEGER_OVERFLOW',
        failure: {
          errorCode: 'SIMULATION_INTEGER_OVERFLOW',
          processType: 'WorldClockV1',
          scheduleId: null,
          tick: SIGNED_INT64_MAX.toString(10),
        },
      });
    }
  });
});
