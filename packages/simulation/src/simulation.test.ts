import { describe, expect, it } from 'vitest';

import {
  EMIT_WORLD_NOTICE_PROCESS_VERSION,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  type ScheduledActionV1,
  type SimulationProcessContextV1,
} from '@worldgraph/contracts';

import {
  SIGNED_INT64_MAX,
  EMIT_WORLD_NOTICE_DESCRIPTOR_V1,
  addAdvanceBudgetUsageV1,
  advanceSimulationClockV1,
  assertExpectedTickV1,
  assertFutureScheduleV1,
  assertScheduledActionTransitionV1,
  canonicalTimestampToUnixMillisecondsV1,
  computeInitialSimulationOutcomeHashV1,
  computeSemanticSimulationOutcomeHashV1,
  computeSimulationWorldSeedHashV1,
  computeGroupedSemanticSimulationOutcomeHashV1,
  configureSimulationClockV1,
  createSimulationOutcomeV1,
  deriveSimulationPrngSubstreamSeedV1,
  deriveWorldTimeV1,
  initialSimulationClockV1,
  initialSimulationAdvanceBudgetUsageV1,
  orderScheduledActionsV1,
  pauseSimulationClockV1,
  resolveSimulationFailureClockV1,
  runSimulationProcessV1,
  startSimulationClockV1,
  unixMillisecondsToCanonicalTimestampV1,
  validateProcessResultV1,
  SimulationDomainError,
  SimulationPrngV1,
} from './index.js';

const hash = 'a'.repeat(64);
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e26';

function expectSimulationError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('Expected simulation operation to fail.');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function action(
  id: string,
  dueTick: string,
  priority: number,
  scheduleSequence: string,
): ScheduledActionV1 {
  return {
    actionSchemaVersion: 1,
    actionType: 'EmitWorldNoticeV1',
    cancelledCommandId: null,
    completedEventId: null,
    completedStateRevision: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    createdBy: { actorId: worldId, actorType: 'user' },
    createdCommandId: commandId,
    createdStateRevision: '1',
    dueTick,
    id,
    payload: { text: 'Notice', visibility: 'public' },
    payloadHash: hash,
    priority,
    processVersion: EMIT_WORLD_NOTICE_PROCESS_VERSION,
    scheduleSchemaVersion: 1,
    scheduleSequence,
    status: 'scheduled',
    updatedAt: '2026-07-22T00:00:00.000Z',
    worldId,
  };
}

function context(): SimulationProcessContextV1 {
  return {
    currentProjectionChecksum: hash,
    processSchemaVersion: 1,
    scheduleSequence: '7',
    stableProcessKey: 'schedule:7',
    state: { active: true },
    tick: '3',
    worldSeed: 'golden-world-seed',
    worldTimeUnixMilliseconds: '946944000000',
  };
}

describe('deterministic simulation kernel', () => {
  it('derives exact UTC world time with checked integer arithmetic', () => {
    expect(canonicalTimestampToUnixMillisecondsV1('1970-01-01T00:00:00.000Z')).toBe(0n);
    expect(canonicalTimestampToUnixMillisecondsV1('2000-02-29T12:34:56.789Z')).toBe(
      951_827_696_789n,
    );
    expect(unixMillisecondsToCanonicalTimestampV1(951_827_696_789n)).toBe(
      '2000-02-29T12:34:56.789Z',
    );
    expect(deriveWorldTimeV1('2000-01-01T00:00:00.000Z', '3', 86_400_000)).toEqual({
      epochAt: '2000-01-01T00:00:00.000Z',
      tick: '3',
      worldTimeAt: '2000-01-04T00:00:00.000Z',
      worldTimeUnixMilliseconds: '946944000000',
    });
    expect(() => deriveWorldTimeV1('2000-01-01T00:00:00.000Z', SIGNED_INT64_MAX, 2)).toThrow(
      SimulationDomainError,
    );
    expectSimulationError(
      () => deriveWorldTimeV1('9999-12-31T23:59:59.999Z', '1', 1),
      'SIMULATION_INTEGER_OVERFLOW',
    );
    expect(() => canonicalTimestampToUnixMillisecondsV1('2001-02-29T00:00:00.000Z')).toThrow(
      RangeError,
    );
  });

  it('enforces the clock state machine, expected tick, and configured advance budget', () => {
    const initial = initialSimulationClockV1();
    expect(initial).toMatchObject({ currentTick: '0', mode: 'paused' });
    const configured = configureSimulationClockV1(initial, {
      ...initial.configuration,
      maxBatchTicks: 2,
      maxCatchUpTicks: 4,
    });
    const running = startSimulationClockV1(configured);
    const advanced = advanceSimulationClockV1(running, 2);
    expect(advanced.currentTick).toBe('2');
    expect(pauseSimulationClockV1(advanced).mode).toBe('paused');
    expect(resolveSimulationFailureClockV1({ ...advanced, mode: 'error' }).mode).toBe('paused');
    expectSimulationError(() => resolveSimulationFailureClockV1(advanced), 'CLOCK_NOT_PAUSED');
    expectSimulationError(() => advanceSimulationClockV1(advanced, 3), 'ADVANCE_LIMIT_EXCEEDED');
    expectSimulationError(() => assertExpectedTickV1(advanced, '1'), 'EXPECTED_TICK_MISMATCH');
    expect(() => configureSimulationClockV1(advanced, advanced.configuration)).toThrow(
      SimulationDomainError,
    );

    expectSimulationError(
      () =>
        configureSimulationClockV1(initial, {
          ...initial.configuration,
          epochAt: '9999-12-31T23:59:59.999Z',
          worldMillisecondsPerTick: 1,
        }),
      'SIMULATION_INTEGER_OVERFLOW',
    );
    const boundary = configureSimulationClockV1(initial, {
      ...initial.configuration,
      epochAt: '9999-12-31T23:59:59.997Z',
      maxBatchTicks: 2,
      maxCatchUpTicks: 2,
      worldMillisecondsPerTick: 1,
    });
    expect(advanceSimulationClockV1(boundary, 2).currentTick).toBe('2');
    expectSimulationError(
      () => advanceSimulationClockV1({ ...boundary, currentTick: '2' }, 1),
      'SIMULATION_INTEGER_OVERFLOW',
    );
  });

  it('rejects current/past schedules and orders due work by tick, priority, sequence, then id', () => {
    expectSimulationError(() => assertFutureScheduleV1('2', '2'), 'SCHEDULE_IN_PAST');
    expectSimulationError(() => assertFutureScheduleV1('2', '1'), 'SCHEDULE_IN_PAST');
    expect(() => assertFutureScheduleV1('2', '3')).not.toThrow();
    expect(() => assertScheduledActionTransitionV1('scheduled', 'completed')).not.toThrow();
    expectSimulationError(
      () => assertScheduledActionTransitionV1('completed', 'cancelled'),
      'SCHEDULE_ALREADY_TERMINAL',
    );

    const ordered = orderScheduledActionsV1([
      action('018f8652-3cb6-7d52-904b-cce7901d7e29', '4', -1, '3'),
      action('018f8652-3cb6-7d52-904b-cce7901d7e28', '3', 0, '2'),
      action('018f8652-3cb6-7d52-904b-cce7901d7e27', '3', -1, '4'),
      action('018f8652-3cb6-7d52-904b-cce7901d7e26', '3', -1, '3'),
    ]);
    expect(ordered.map((item) => item.id)).toEqual([
      '018f8652-3cb6-7d52-904b-cce7901d7e26',
      '018f8652-3cb6-7d52-904b-cce7901d7e27',
      '018f8652-3cb6-7d52-904b-cce7901d7e28',
      '018f8652-3cb6-7d52-904b-cce7901d7e29',
    ]);
  });

  it('derives stable, domain-separated PRNG substreams', () => {
    const input = {
      processType: 'EmitWorldNoticeV1',
      processVersion: EMIT_WORLD_NOTICE_PROCESS_VERSION,
      stableProcessKey: 'schedule:7',
      tick: '3',
      worldSeed: 'golden-world-seed',
    };
    expect(deriveSimulationPrngSubstreamSeedV1(input)).toBe(
      'bada9777d73b38d4b898a3b344de2fa8d098135118da80f6cb06b2ed302708af',
    );
    expect(computeSimulationWorldSeedHashV1(input.worldSeed)).toBe(
      '5cca86a1924f20589430731a1ff027af2942edeb25422b504939b525e67ec06c',
    );
    const first = new SimulationPrngV1(input);
    const second = new SimulationPrngV1(input);
    expect([first.nextUint32(), first.nextUint32(), first.nextInt(10)]).toEqual([
      second.nextUint32(),
      second.nextUint32(),
      second.nextInt(10),
    ]);
    expect(
      deriveSimulationPrngSubstreamSeedV1({ ...input, stableProcessKey: 'schedule:8' }),
    ).not.toBe(deriveSimulationPrngSubstreamSeedV1(input));
  });

  it('executes only the allowlisted, schema-valid notice handler', () => {
    expect(Object.isFrozen(EMIT_WORLD_NOTICE_DESCRIPTOR_V1)).toBe(true);
    expect(Object.isFrozen(EMIT_WORLD_NOTICE_DESCRIPTOR_V1.compatibility)).toBe(true);
    const result = runSimulationProcessV1({
      actionSchemaVersion: 1,
      actionType: 'EmitWorldNoticeV1',
      context: context(),
      payload: { text: 'Guild Founding Day', visibility: 'public' },
      processVersion: EMIT_WORLD_NOTICE_PROCESS_VERSION,
    });
    expect(result).toEqual({
      events: [
        {
          eventSchemaVersion: 1,
          eventType: 'WorldNoticeEmittedV1',
          payload: {
            emittedAtTick: '3',
            text: 'Guild Founding Day',
            visibility: 'public',
          },
        },
      ],
      processSchemaVersion: 1,
      schedules: [],
    });
    let usage = initialSimulationAdvanceBudgetUsageV1();
    for (let count = 0; count < 31; count += 1) {
      usage = addAdvanceBudgetUsageV1(usage, result);
    }
    expect(usage).toEqual({ eventCount: 63, scheduleCount: 0 });
    expectSimulationError(
      () => addAdvanceBudgetUsageV1(usage, result),
      'SIMULATION_BUDGET_EXCEEDED',
    );
    expectSimulationError(
      () =>
        runSimulationProcessV1({
          actionSchemaVersion: 1,
          actionType: 'EmitWorldNoticeV1',
          context: context(),
          payload: { html: '<script>', text: 'Notice', visibility: 'public' },
          processVersion: EMIT_WORLD_NOTICE_PROCESS_VERSION,
        }),
      'SIMULATION_HANDLER_FAILED',
    );
    expectSimulationError(
      () =>
        runSimulationProcessV1({
          actionSchemaVersion: 1,
          actionType: 'EmitWorldNoticeV1',
          context: context(),
          payload: { text: 'Notice', visibility: 'public' },
          processVersion: '2.0.0',
        }),
      'SIMULATION_PROCESS_VERSION_MISMATCH',
    );
    expectSimulationError(
      () =>
        runSimulationProcessV1({
          actionSchemaVersion: 2,
          actionType: 'EmitWorldNoticeV1',
          context: context(),
          payload: { text: 'Notice', visibility: 'public' },
          processVersion: EMIT_WORLD_NOTICE_PROCESS_VERSION,
        }),
      'SIMULATION_PROCESS_VERSION_MISMATCH',
    );
  });

  it('rejects untyped or over-budget process results', () => {
    expectSimulationError(
      () => validateProcessResultV1({ events: [], schedules: [] }),
      'SIMULATION_HANDLER_FAILED',
    );
    expectSimulationError(
      () =>
        validateProcessResultV1({
          events: Array.from({ length: 65 }, () => ({
            eventSchemaVersion: 1,
            eventType: 'WorldNoticeEmittedV1',
            payload: { emittedAtTick: '3', text: 'Notice', visibility: 'public' },
          })),
          processSchemaVersion: 1,
          schedules: [],
        }),
      'SIMULATION_BUDGET_EXCEEDED',
    );
  });

  it('hashes semantic outcomes independent of tick/due insertion and operational identities', () => {
    const due = {
      actionSchemaVersion: 1,
      actionType: 'EmitWorldNoticeV1',
      dueTick: '3',
      payloadHash: 'b'.repeat(64),
      priority: 0,
      processVersion: EMIT_WORLD_NOTICE_PROCESS_VERSION,
      scheduleSequence: '1',
    };
    const tickThree = {
      createdSchedules: [],
      dueActions: [due],
      returnedEvents: [
        {
          eventSchemaVersion: 1,
          eventType: 'WorldNoticeEmittedV1',
          payload: { emittedAtTick: '3', text: 'Guild Founding Day', visibility: 'public' },
        },
      ],
      tick: '3',
    } as const;
    const emptyTick = {
      createdSchedules: [],
      dueActions: [],
      returnedEvents: [],
      tick: '2',
    } as const;
    const base = {
      prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
      processRegistryVersion: 1,
      startingOutcomeHash: computeInitialSimulationOutcomeHashV1({
        prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
        processRegistryVersion: 1,
        worldSeedHash: 'c'.repeat(64),
      }),
      startingProjectionChecksum: hash,
      ticks: [tickThree, emptyTick],
      worldSeedHash: 'c'.repeat(64),
    } as const;
    const reordered = { ...base, ticks: [emptyTick, tickThree] } as const;
    expect(base.startingOutcomeHash).toBe(
      '3b68fb925ee6f4cad06fbbb772b989cf005dcaf7849127364d444105f325ceae',
    );
    expect(computeSemanticSimulationOutcomeHashV1(base)).toBe(
      computeSemanticSimulationOutcomeHashV1(reordered),
    );
    expect(computeSemanticSimulationOutcomeHashV1(base)).toBe(
      'cf620f728f637111bef99909f788ca4613377ac3be04f4a65120ac27ced02cb5',
    );
    const operationallyPolluted = {
      ...base,
      batchRunId: worldId,
      commandId,
      ticks: base.ticks.map((tick) => ({
        ...tick,
        batchKey: worldId,
        dueActions: tick.dueActions.map((item) => ({ ...item, scheduleId: worldId })),
        returnedEvents: tick.returnedEvents.map((item) => ({ ...item, eventId: worldId })),
        workerId: worldId,
      })),
    };
    expect(
      computeSemanticSimulationOutcomeHashV1(operationallyPolluted as unknown as typeof base),
    ).toBe(computeSemanticSimulationOutcomeHashV1(base));
    const changedProcessVersion = {
      ...base,
      ticks: base.ticks.map((tick) => ({
        ...tick,
        dueActions: tick.dueActions.map((action) => ({
          ...action,
          processVersion: '1.0.1',
        })),
      })),
    };
    expect(computeSemanticSimulationOutcomeHashV1(changedProcessVersion)).not.toBe(
      computeSemanticSimulationOutcomeHashV1(base),
    );
    expect(
      computeGroupedSemanticSimulationOutcomeHashV1({
        ...base,
        tickGroups: [[emptyTick], [tickThree]],
      }),
    ).toBe(computeSemanticSimulationOutcomeHashV1(base));
    const firstBatch = createSimulationOutcomeV1({ ...base, ticks: [emptyTick] });
    expect(firstBatch.outcomeHash).toBe(
      '7048fdca869a3b6c14999a2a8ff868db054c09920b26d060d46d67621384a57d',
    );
    const secondBatch = createSimulationOutcomeV1({
      ...base,
      startingOutcomeHash: firstBatch.outcomeHash,
      startingProjectionChecksum: 'd'.repeat(64),
      ticks: [tickThree],
    });
    expect(secondBatch.inputChecksum).toBe('d'.repeat(64));
    expect(secondBatch.outcomeHash).toBe(computeSemanticSimulationOutcomeHashV1(base));
    expect(
      computeSemanticSimulationOutcomeHashV1({
        ...base,
        startingProjectionChecksum: 'e'.repeat(64),
      }),
    ).not.toBe(computeSemanticSimulationOutcomeHashV1(base));
    expect(computeSemanticSimulationOutcomeHashV1({ ...base, ticks: [] })).toBe(
      base.startingOutcomeHash,
    );
    expect(() =>
      computeSemanticSimulationOutcomeHashV1({
        ...base,
        ticks: [emptyTick, emptyTick],
      }),
    ).toThrow('every tick exactly once');
    expect(() =>
      computeSemanticSimulationOutcomeHashV1({
        ...base,
        startingOutcomeHash: 'not-a-hash',
      }),
    ).toThrow('Starting outcome hash');
    expect(createSimulationOutcomeV1(base)).toMatchObject({ fromTick: '2', toTick: '3' });
  });
});
