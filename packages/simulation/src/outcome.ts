import { createHash } from 'node:crypto';

import {
  SIMULATION_OUTCOME_SCHEMA_VERSION,
  canonicalJson,
  type JsonValue,
  type SIMULATION_PRNG_ALGORITHM_VERSION,
  type SimulationOutcomeV1,
  type SimulationProcessRegistryVersion,
} from '@worldgraph/contracts';

import { parseNonNegativeInt64V1, parsePositiveInt64V1 } from './arithmetic.js';

export const SIMULATION_OUTCOME_HASH_DOMAIN_V1 = 'worldgraph.simulation.outcome.v1' as const;
export const SIMULATION_INITIAL_OUTCOME_HASH_DOMAIN_V1 =
  'worldgraph.simulation.outcome.initial.v1' as const;

export interface InitialSimulationOutcomeHashInputV1 {
  readonly prngAlgorithmVersion: typeof SIMULATION_PRNG_ALGORITHM_VERSION;
  readonly processRegistryVersion: SimulationProcessRegistryVersion;
  readonly worldSeedHash: string;
}

export interface SemanticDueActionV1 {
  readonly actionSchemaVersion: number;
  readonly actionType: string;
  readonly dueTick: string;
  readonly payloadHash: string;
  readonly priority: number;
  readonly processVersion: string;
  readonly scheduleSequence: string;
}

export interface SemanticReturnedEventV1 {
  readonly eventSchemaVersion: number;
  readonly eventType: string;
  readonly payload: JsonValue;
}

export interface SemanticCreatedScheduleV1 {
  readonly actionSchemaVersion: number;
  readonly actionType: string;
  readonly dueTick: string;
  readonly payload: JsonValue;
  readonly priority: number;
  readonly processVersion: string;
}

export interface SemanticTickOutcomeV1 {
  readonly createdSchedules: readonly SemanticCreatedScheduleV1[];
  readonly dueActions: readonly SemanticDueActionV1[];
  readonly returnedEvents: readonly SemanticReturnedEventV1[];
  readonly tick: string;
}

export interface SemanticSimulationOutcomeInputV1 {
  readonly prngAlgorithmVersion: typeof SIMULATION_PRNG_ALGORITHM_VERSION;
  readonly processRegistryVersion: SimulationProcessRegistryVersion;
  readonly startingOutcomeHash: string;
  readonly startingProjectionChecksum: string;
  readonly ticks: readonly SemanticTickOutcomeV1[];
  readonly worldSeedHash: string;
}

const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;

function assertSha256(value: string, label: string): void {
  if (!SHA_256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hash.`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDue(left: SemanticDueActionV1, right: SemanticDueActionV1): number {
  const tickLeft = parseNonNegativeInt64V1(left.dueTick, 'due tick');
  const tickRight = parseNonNegativeInt64V1(right.dueTick, 'due tick');
  if (tickLeft !== tickRight) return tickLeft < tickRight ? -1 : 1;
  if (left.priority !== right.priority) return left.priority < right.priority ? -1 : 1;
  const sequenceLeft = parsePositiveInt64V1(left.scheduleSequence, 'schedule sequence');
  const sequenceRight = parsePositiveInt64V1(right.scheduleSequence, 'schedule sequence');
  if (sequenceLeft !== sequenceRight) return sequenceLeft < sequenceRight ? -1 : 1;
  const actionOrder = compareText(left.actionType, right.actionType);
  return actionOrder || compareText(left.payloadHash, right.payloadHash);
}

export function semanticSimulationOutcomeMaterialV1(input: SemanticSimulationOutcomeInputV1) {
  assertSha256(input.startingOutcomeHash, 'Starting outcome hash');
  assertSha256(input.startingProjectionChecksum, 'Starting projection checksum');
  assertSha256(input.worldSeedHash, 'World seed hash');
  const orderedTicks = [...input.ticks].sort((left, right) => {
    const leftTick = parseNonNegativeInt64V1(left.tick, 'tick');
    const rightTick = parseNonNegativeInt64V1(right.tick, 'tick');
    return leftTick < rightTick ? -1 : leftTick > rightTick ? 1 : 0;
  });
  for (let index = 1; index < orderedTicks.length; index += 1) {
    const previous = parseNonNegativeInt64V1(orderedTicks[index - 1]!.tick, 'tick');
    const current = parseNonNegativeInt64V1(orderedTicks[index]!.tick, 'tick');
    if (current !== previous + 1n) {
      throw new TypeError('A semantic outcome must contain every tick exactly once.');
    }
  }
  return {
    domain: SIMULATION_OUTCOME_HASH_DOMAIN_V1,
    outcomeSchemaVersion: SIMULATION_OUTCOME_SCHEMA_VERSION,
    prngAlgorithmVersion: input.prngAlgorithmVersion,
    processRegistryVersion: input.processRegistryVersion,
    startingProjectionChecksum: input.startingProjectionChecksum,
    startingOutcomeHash: input.startingOutcomeHash,
    ticks: orderedTicks.map((tick) => ({
      createdSchedules: tick.createdSchedules.map((schedule) => ({
        actionSchemaVersion: schedule.actionSchemaVersion,
        actionType: schedule.actionType,
        dueTick: schedule.dueTick,
        payload: schedule.payload,
        priority: schedule.priority,
        processVersion: schedule.processVersion,
      })),
      dueActions: [...tick.dueActions].sort(compareDue).map((action) => ({
        actionSchemaVersion: action.actionSchemaVersion,
        actionType: action.actionType,
        dueTick: action.dueTick,
        payloadHash: action.payloadHash,
        priority: action.priority,
        processVersion: action.processVersion,
        scheduleSequence: action.scheduleSequence,
      })),
      returnedEvents: tick.returnedEvents.map((event) => ({
        eventSchemaVersion: event.eventSchemaVersion,
        eventType: event.eventType,
        payload: event.payload,
      })),
      tick: tick.tick,
    })),
    worldSeedHash: input.worldSeedHash,
  };
}

export function computeInitialSimulationOutcomeHashV1(
  input: InitialSimulationOutcomeHashInputV1,
): string {
  assertSha256(input.worldSeedHash, 'World seed hash');
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: SIMULATION_INITIAL_OUTCOME_HASH_DOMAIN_V1,
        outcomeSchemaVersion: SIMULATION_OUTCOME_SCHEMA_VERSION,
        prngAlgorithmVersion: input.prngAlgorithmVersion,
        processRegistryVersion: input.processRegistryVersion,
        worldSeedHash: input.worldSeedHash,
      }),
      'utf8',
    )
    .digest('hex');
}

function foldSemanticSimulationOutcomeMaterialV1(
  material: ReturnType<typeof semanticSimulationOutcomeMaterialV1>,
): string {
  const initialOutcomeHash = computeInitialSimulationOutcomeHashV1({
    prngAlgorithmVersion: material.prngAlgorithmVersion,
    processRegistryVersion: material.processRegistryVersion,
    worldSeedHash: material.worldSeedHash,
  });
  return material.ticks.reduce(
    (previousOutcomeHash, tick, index) =>
      createHash('sha256')
        .update(
          canonicalJson({
            domain: material.domain,
            outcomeSchemaVersion: material.outcomeSchemaVersion,
            previousOutcomeHash,
            prngAlgorithmVersion: material.prngAlgorithmVersion,
            processRegistryVersion: material.processRegistryVersion,
            ...(index === 0 && material.startingOutcomeHash === initialOutcomeHash
              ? { startingProjectionChecksum: material.startingProjectionChecksum }
              : {}),
            tick,
            worldSeedHash: material.worldSeedHash,
          }),
          'utf8',
        )
        .digest('hex'),
    material.startingOutcomeHash,
  );
}

export function computeSemanticSimulationOutcomeHashV1(
  input: SemanticSimulationOutcomeInputV1,
): string {
  return foldSemanticSimulationOutcomeMaterialV1(semanticSimulationOutcomeMaterialV1(input));
}

export function createSimulationOutcomeV1(
  input: SemanticSimulationOutcomeInputV1,
): SimulationOutcomeV1 {
  const material = semanticSimulationOutcomeMaterialV1(input);
  if (material.ticks.length === 0) throw new RangeError('An outcome requires at least one tick.');
  return {
    fromTick: material.ticks[0]!.tick,
    inputChecksum: input.startingProjectionChecksum,
    outcomeHash: foldSemanticSimulationOutcomeMaterialV1(material),
    outcomeSchemaVersion: SIMULATION_OUTCOME_SCHEMA_VERSION,
    prngAlgorithmVersion: input.prngAlgorithmVersion,
    processRegistryVersion: input.processRegistryVersion,
    toTick: material.ticks.at(-1)!.tick,
    worldSeedHash: input.worldSeedHash,
  };
}

export function computeGroupedSemanticSimulationOutcomeHashV1(
  input: Omit<SemanticSimulationOutcomeInputV1, 'ticks'> & {
    readonly tickGroups: readonly (readonly SemanticTickOutcomeV1[])[];
  },
): string {
  return computeSemanticSimulationOutcomeHashV1({
    prngAlgorithmVersion: input.prngAlgorithmVersion,
    processRegistryVersion: input.processRegistryVersion,
    startingOutcomeHash: input.startingOutcomeHash,
    startingProjectionChecksum: input.startingProjectionChecksum,
    ticks: input.tickGroups.flat(),
    worldSeedHash: input.worldSeedHash,
  });
}
