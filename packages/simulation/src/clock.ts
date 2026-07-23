import {
  DEFAULT_SIMULATION_EPOCH_AT,
  DEFAULT_SIMULATION_MAX_BATCH_TICKS,
  DEFAULT_SIMULATION_MAX_CATCH_UP_TICKS,
  DEFAULT_SIMULATION_WALL_CADENCE_MILLISECONDS,
  DEFAULT_WORLD_MILLISECONDS_PER_TICK,
  MAX_SIMULATION_BATCH_TICKS,
  MAX_SIMULATION_CATCH_UP_TICKS,
  MAX_SIMULATION_WALL_CADENCE_MILLISECONDS,
  MAX_SIMULATION_WORLD_MILLISECONDS_PER_TICK,
  MIN_SIMULATION_WALL_CADENCE_MILLISECONDS,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  type SimulationClockMode,
  type WorldClockConfigurationV1,
} from '@worldgraph/contracts';

import {
  canonicalTimestampToUnixMillisecondsV1,
  deriveWorldTimeV1,
  parseNonNegativeInt64V1,
} from './arithmetic.js';
import { SimulationDomainError } from './errors.js';

export interface SimulationClockStateV1 {
  readonly configuration: WorldClockConfigurationV1;
  readonly currentTick: string;
  readonly mode: SimulationClockMode;
}

export const DEFAULT_WORLD_CLOCK_CONFIGURATION_V1: WorldClockConfigurationV1 = Object.freeze({
  epochAt: DEFAULT_SIMULATION_EPOCH_AT,
  maxBatchTicks: DEFAULT_SIMULATION_MAX_BATCH_TICKS,
  maxCatchUpTicks: DEFAULT_SIMULATION_MAX_CATCH_UP_TICKS,
  prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
  wallCadenceMilliseconds: DEFAULT_SIMULATION_WALL_CADENCE_MILLISECONDS,
  worldMillisecondsPerTick: DEFAULT_WORLD_MILLISECONDS_PER_TICK,
});

export function initialSimulationClockV1(
  configuration: WorldClockConfigurationV1 = DEFAULT_WORLD_CLOCK_CONFIGURATION_V1,
): SimulationClockStateV1 {
  assertClockConfigurationV1(configuration);
  return { configuration: { ...configuration }, currentTick: '0', mode: 'paused' };
}

export function assertClockConfigurationV1(configuration: WorldClockConfigurationV1): void {
  canonicalTimestampToUnixMillisecondsV1(configuration.epochAt);
  if (
    !Number.isSafeInteger(configuration.worldMillisecondsPerTick) ||
    configuration.worldMillisecondsPerTick < 1 ||
    configuration.worldMillisecondsPerTick > MAX_SIMULATION_WORLD_MILLISECONDS_PER_TICK
  ) {
    throw new RangeError('World milliseconds per tick is outside the supported range.');
  }
  // A configured clock must permit at least one advance. This also proves the
  // configured epoch/duration pair can produce a contract-renderable timestamp.
  deriveWorldTimeV1(configuration.epochAt, '1', configuration.worldMillisecondsPerTick);
  if (
    !Number.isSafeInteger(configuration.wallCadenceMilliseconds) ||
    configuration.wallCadenceMilliseconds < MIN_SIMULATION_WALL_CADENCE_MILLISECONDS ||
    configuration.wallCadenceMilliseconds > MAX_SIMULATION_WALL_CADENCE_MILLISECONDS
  ) {
    throw new RangeError('Wall cadence is outside the supported range.');
  }
  if (
    !Number.isSafeInteger(configuration.maxBatchTicks) ||
    configuration.maxBatchTicks < 1 ||
    configuration.maxBatchTicks > MAX_SIMULATION_BATCH_TICKS
  ) {
    throw new RangeError('Maximum batch ticks is outside the supported range.');
  }
  if (
    !Number.isSafeInteger(configuration.maxCatchUpTicks) ||
    configuration.maxCatchUpTicks < configuration.maxBatchTicks ||
    configuration.maxCatchUpTicks > MAX_SIMULATION_CATCH_UP_TICKS
  ) {
    throw new RangeError('Maximum catch-up ticks must be in range and at least one batch.');
  }
  if (configuration.prngAlgorithmVersion !== SIMULATION_PRNG_ALGORITHM_VERSION) {
    throw new SimulationDomainError(
      'SIMULATION_PROCESS_VERSION_MISMATCH',
      'The clock PRNG algorithm is unsupported.',
    );
  }
}

export function configureSimulationClockV1(
  state: SimulationClockStateV1,
  configuration: WorldClockConfigurationV1,
): SimulationClockStateV1 {
  if (state.mode !== 'paused' || state.currentTick !== '0') {
    throw new SimulationDomainError(
      'CLOCK_NOT_PAUSED',
      'Clock configuration is allowed only while paused at tick zero.',
    );
  }
  assertClockConfigurationV1(configuration);
  return { configuration: { ...configuration }, currentTick: '0', mode: 'paused' };
}

export function startSimulationClockV1(state: SimulationClockStateV1): SimulationClockStateV1 {
  if (state.mode !== 'paused') {
    throw new SimulationDomainError('CLOCK_NOT_PAUSED', 'Only a paused clock can be started.');
  }
  return { ...state, mode: 'running' };
}

export function pauseSimulationClockV1(state: SimulationClockStateV1): SimulationClockStateV1 {
  if (state.mode !== 'running') {
    throw new SimulationDomainError('CLOCK_NOT_RUNNING', 'Only a running clock can be paused.');
  }
  return { ...state, mode: 'paused' };
}

export function autoPauseSimulationClockV1(state: SimulationClockStateV1): SimulationClockStateV1 {
  return { ...state, mode: 'error' };
}

export function resolveSimulationFailureClockV1(
  state: SimulationClockStateV1,
): SimulationClockStateV1 {
  if (state.mode !== 'error') {
    throw new SimulationDomainError(
      'CLOCK_NOT_PAUSED',
      'Only an error-paused clock can complete failure repair.',
    );
  }
  return { ...state, mode: 'paused' };
}

export function advanceSimulationClockV1(
  state: SimulationClockStateV1,
  ticks: number,
): SimulationClockStateV1 {
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > state.configuration.maxBatchTicks) {
    throw new SimulationDomainError(
      'ADVANCE_LIMIT_EXCEEDED',
      'Advance ticks must be a positive integer within the configured batch limit.',
    );
  }
  if (state.mode === 'error') {
    throw new SimulationDomainError('CLOCK_NOT_PAUSED', 'An errored clock cannot advance.');
  }
  const current = parseNonNegativeInt64V1(state.currentTick, 'current tick');
  const target = parseNonNegativeInt64V1(current + BigInt(ticks), 'target tick');
  deriveWorldTimeV1(
    state.configuration.epochAt,
    target,
    state.configuration.worldMillisecondsPerTick,
  );
  return { ...state, currentTick: target.toString() };
}

export function assertExpectedTickV1(state: SimulationClockStateV1, expectedTick: string): void {
  if (parseNonNegativeInt64V1(expectedTick, 'expected tick') !== BigInt(state.currentTick)) {
    throw new SimulationDomainError(
      'EXPECTED_TICK_MISMATCH',
      'Expected tick does not match the authoritative clock.',
    );
  }
}
