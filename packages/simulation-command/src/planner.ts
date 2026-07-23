import {
  SIMULATION_PRNG_ALGORITHM_VERSION,
  SIMULATION_PROCESS_REGISTRY_VERSION,
  type ScheduledActionV1,
  type SimulationOutcomeV1,
  type SimulationProcessResultV1,
  type WorldSimulationClockV1,
} from '@worldgraph/contracts';
import {
  addAdvanceBudgetUsageV1,
  advanceSimulationClockV1,
  assertFutureScheduleV1,
  assertScheduledActionTransitionV1,
  computeSimulationWorldSeedHashV1,
  createSimulationOutcomeV1,
  deriveWorldTimeV1,
  initialSimulationAdvanceBudgetUsageV1,
  isScheduledActionDueV1,
  orderScheduledActionsV1,
  runSimulationProcessV1,
  simulationScheduleProcessKeyV1,
  SIGNED_INT64_MAX,
  type SimulationClockStateV1,
} from '@worldgraph/simulation';

import type { SimulationFailureContextV1 } from './types.js';

type WithoutErrorCode<T> = T extends unknown ? Omit<T, 'errorCode'> : never;
type SimulationFailureSourceContextV1 = WithoutErrorCode<SimulationFailureContextV1>;

export class DeterministicSimulationExecutionError extends Error {
  public readonly code: string;
  public readonly failure: SimulationFailureContextV1;

  public constructor(error: unknown, failure: SimulationFailureSourceContextV1) {
    const code = simulationErrorCode(error);
    super(code, { cause: error });
    this.name = 'DeterministicSimulationExecutionError';
    this.code = code;
    this.failure = { ...failure, errorCode: code };
  }
}

export interface PlannedSimulationExecutionV1 {
  action: ScheduledActionV1;
  processResult: SimulationProcessResultV1;
  tick: string;
}

export interface SimulationAdvancePlanV1 {
  executions: readonly PlannedSimulationExecutionV1[];
  nextClockState: SimulationClockStateV1;
  outcome: SimulationOutcomeV1;
}

export interface PlanSimulationAdvanceInputV1 {
  clock: WorldSimulationClockV1;
  dueActions: readonly ScheduledActionV1[];
  startingProjectionChecksum: string;
  ticks: number;
  worldSeed: string;
}

/** Pure deterministic planning boundary; generated IDs and wall metadata stay outside. */
export function planSimulationAdvanceV1(
  input: PlanSimulationAdvanceInputV1,
): SimulationAdvancePlanV1 {
  if (input.clock.mode !== 'running') {
    throw new Error('CLOCK_NOT_RUNNING');
  }
  const clockState: SimulationClockStateV1 = {
    configuration: input.clock.configuration,
    currentTick: input.clock.currentTick,
    mode: input.clock.mode,
  };
  let nextClockState: SimulationClockStateV1;
  try {
    nextClockState = advanceSimulationClockV1(clockState, input.ticks);
  } catch (error) {
    if (simulationErrorCode(error) !== 'SIMULATION_INTEGER_OVERFLOW') throw error;
    throw new DeterministicSimulationExecutionError(error, {
      processType: 'WorldClockV1',
      processVersion: '1.0.0',
      scheduleId: null,
      tick: representableFailureTick(input.clock.currentTick, input.ticks),
    });
  }
  const fromTick = BigInt(input.clock.currentTick);
  const toTick = BigInt(nextClockState.currentTick);
  const orderedActions = orderScheduledActionsV1(input.dueActions);
  const seenIds = new Set<string>();
  const seenSequences = new Set<string>();
  for (const action of orderedActions) {
    if (
      action.worldId !== input.clock.worldId ||
      !isScheduledActionDueV1(action, nextClockState.currentTick) ||
      BigInt(action.dueTick) <= fromTick ||
      BigInt(action.dueTick) > toTick ||
      seenIds.has(action.id) ||
      seenSequences.has(action.scheduleSequence)
    ) {
      throw new Error('SIMULATION_DUE_SET_INVALID');
    }
    assertScheduledActionTransitionV1(action.status, 'completed');
    seenIds.add(action.id);
    seenSequences.add(action.scheduleSequence);
  }

  let budget = initialSimulationAdvanceBudgetUsageV1();
  const executions: PlannedSimulationExecutionV1[] = [];
  const semanticTicks = [];
  for (let tick = fromTick + 1n; tick <= toTick; tick += 1n) {
    const tickText = tick.toString(10);
    const tickActions = orderedActions.filter((action) => action.dueTick === tickText);
    const returnedEvents = [];
    const createdSchedules = [];
    for (const action of tickActions) {
      try {
        const worldTime = deriveWorldTimeV1(
          input.clock.configuration.epochAt,
          tickText,
          input.clock.configuration.worldMillisecondsPerTick,
        );
        const processResult = runSimulationProcessV1({
          actionSchemaVersion: action.actionSchemaVersion,
          actionType: action.actionType,
          context: {
            currentProjectionChecksum: input.startingProjectionChecksum,
            processSchemaVersion: 1,
            scheduleSequence: action.scheduleSequence,
            stableProcessKey: simulationScheduleProcessKeyV1(action.scheduleSequence),
            state: {},
            tick: tickText,
            worldSeed: input.worldSeed,
            worldTimeUnixMilliseconds: worldTime.worldTimeUnixMilliseconds,
          },
          payload: action.payload,
          processVersion: action.processVersion,
        });
        budget = addAdvanceBudgetUsageV1(budget, processResult);
        for (const schedule of processResult.schedules) {
          assertFutureScheduleV1(tickText, schedule.dueTick);
          createdSchedules.push(schedule);
        }
        returnedEvents.push(...processResult.events);
        executions.push({ action, processResult, tick: tickText });
      } catch (error) {
        throw new DeterministicSimulationExecutionError(error, {
          processType: action.actionType,
          processVersion: action.processVersion,
          scheduleId: action.id,
          tick: tickText,
        });
      }
    }
    semanticTicks.push({
      createdSchedules,
      dueActions: tickActions.map((action) => ({
        actionSchemaVersion: action.actionSchemaVersion,
        actionType: action.actionType,
        dueTick: action.dueTick,
        payloadHash: action.payloadHash,
        priority: action.priority,
        processVersion: action.processVersion,
        scheduleSequence: action.scheduleSequence,
      })),
      returnedEvents,
      tick: tickText,
    });
  }

  const outcome = createSimulationOutcomeV1({
    prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
    processRegistryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
    startingOutcomeHash: input.clock.outcomeHash,
    startingProjectionChecksum: input.startingProjectionChecksum,
    ticks: semanticTicks,
    worldSeedHash: computeSimulationWorldSeedHashV1(input.worldSeed),
  });
  return { executions, nextClockState, outcome };
}

/**
 * Failure rows use PostgreSQL bigint ticks. Preserve the attempted target when
 * representable; otherwise identify the last authoritative representable tick.
 */
function representableFailureTick(currentTick: string, ticks: number): string {
  const current = BigInt(currentTick);
  const attempted = current + BigInt(ticks);
  return (attempted <= SIGNED_INT64_MAX ? attempted : current).toString(10);
}

function simulationErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,99}$/u.test(code)) return code;
  }
  return 'SIMULATION_HANDLER_FAILED';
}
