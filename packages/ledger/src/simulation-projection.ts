import {
  canonicalJson,
  type LedgerActorV1,
  type ScheduledActionV1,
  type SIMULATION_PROJECTION_SCHEMA_VERSION,
  type SimulationClockMode,
  type SimulationFailureResolution,
  type SimulationFailureSourceType,
  type WorldClockConfigurationV1,
} from '@worldgraph/contracts';

import { hashesEqual, sha256CanonicalV1 } from './hash.js';

export const SIMULATION_PROJECTION_CHECKSUM_DOMAIN_V1 =
  'worldgraph.simulation-projection.v1' as const;

export interface SimulationReplayClockV1 {
  aggregateVersion: string;
  clockSchemaVersion: 1;
  configuration: WorldClockConfigurationV1;
  currentTick: string;
  mode: SimulationClockMode;
  outcomeHash: string;
  updatedAt: string;
  updatedStateRevision: string;
}

type ReplayScheduledAction<T> = T extends ScheduledActionV1
  ? Omit<T, 'scheduleSchemaVersion' | 'worldId'> & { aggregateVersion: string }
  : never;

export type SimulationReplayScheduledActionV1 = ReplayScheduledAction<ScheduledActionV1>;

export interface SimulationReplayFailureV1 {
  aggregateVersion: string;
  attempts: number;
  batchRunId: string;
  errorCode: string;
  id: string;
  openedAt: string;
  processType: SimulationFailureSourceType;
  processVersion: '1.0.0';
  resolution: SimulationFailureResolution | null;
  resolutionCommandId: string | null;
  resolvedAt: string | null;
  resolvedBy: LedgerActorV1 | null;
  scheduleId: string | null;
  status: 'open' | 'resolved';
  tick: string;
}

export interface SimulationReplayStateV1 {
  clock: SimulationReplayClockV1 | null;
  failures: readonly SimulationReplayFailureV1[];
  lastEventSequence: string;
  nextScheduleSequence: string | null;
  scheduledActions: readonly SimulationReplayScheduledActionV1[];
  simulationProjectionSchemaVersion: typeof SIMULATION_PROJECTION_SCHEMA_VERSION;
  stateRevision: string;
  worldId: string;
  worldSeedHash: string;
}

export interface SimulationProjectionClockDocumentV1 {
  clockSchemaVersion: 1;
  currentTick: string;
  epochAt: string;
  maxBatchTicks: number;
  maxCatchUpTicks: number;
  mode: SimulationClockMode;
  outcomeHash: string;
  prngAlgorithmVersion: 'xorshift32-sha256-v1';
  wallCadenceMilliseconds: number;
  worldMillisecondsPerTick: string;
}

export interface SimulationProjectionDocumentV1 {
  clock: SimulationProjectionClockDocumentV1;
  domain: typeof SIMULATION_PROJECTION_CHECKSUM_DOMAIN_V1;
  scheduleHead: { nextScheduleSequence: string };
  scheduledActions: readonly {
    actionSchemaVersion: 1;
    actionType: ScheduledActionV1['actionType'];
    dueTick: string;
    payloadHash: string;
    priority: number;
    processVersion: ScheduledActionV1['processVersion'];
    scheduleSequence: string;
    status: ScheduledActionV1['status'];
  }[];
  simulationProjectionSchemaVersion: typeof SIMULATION_PROJECTION_SCHEMA_VERSION;
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function compareDecimal(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function simulationProjectionDocumentV1(
  state: SimulationReplayStateV1,
): SimulationProjectionDocumentV1 {
  if (!state.clock || !state.nextScheduleSequence) {
    throw new Error('Simulation replay did not encounter an initialization event.');
  }
  const { configuration } = state.clock;
  return canonicalClone({
    clock: {
      clockSchemaVersion: state.clock.clockSchemaVersion,
      currentTick: state.clock.currentTick,
      epochAt: configuration.epochAt,
      maxBatchTicks: configuration.maxBatchTicks,
      maxCatchUpTicks: configuration.maxCatchUpTicks,
      mode: state.clock.mode,
      outcomeHash: state.clock.outcomeHash,
      prngAlgorithmVersion: configuration.prngAlgorithmVersion,
      wallCadenceMilliseconds: configuration.wallCadenceMilliseconds,
      worldMillisecondsPerTick: String(configuration.worldMillisecondsPerTick),
    },
    domain: SIMULATION_PROJECTION_CHECKSUM_DOMAIN_V1,
    scheduleHead: { nextScheduleSequence: state.nextScheduleSequence },
    scheduledActions: [...state.scheduledActions]
      .sort((left, right) => compareDecimal(left.scheduleSequence, right.scheduleSequence))
      .map((action) => ({
        actionSchemaVersion: action.actionSchemaVersion,
        actionType: action.actionType,
        dueTick: action.dueTick,
        payloadHash: action.payloadHash,
        priority: action.priority,
        processVersion: action.processVersion,
        scheduleSequence: action.scheduleSequence,
        status: action.status,
      })),
    simulationProjectionSchemaVersion: state.simulationProjectionSchemaVersion,
  });
}

export function computeSimulationProjectionChecksumV1(state: SimulationReplayStateV1): string {
  return sha256CanonicalV1(simulationProjectionDocumentV1(state));
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function firstDivergence(left: unknown, right: unknown, path: string): string | null {
  if (Object.is(left, right)) return null;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path || '/';
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= left.length || index >= right.length) return `${path}/${index}`;
      const divergence = firstDivergence(left[index], right[index], `${path}/${index}`);
      if (divergence) return divergence;
    }
    return null;
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    for (const key of keys) {
      const nextPath = `${path}/${escapeJsonPointer(key)}`;
      if (!(key in leftRecord) || !(key in rightRecord)) return nextPath;
      const divergence = firstDivergence(leftRecord[key], rightRecord[key], nextPath);
      if (divergence) return divergence;
    }
    return null;
  }
  return path || '/';
}

export function compareSimulationProjectionDocumentV1(
  live: unknown,
  replayed: SimulationProjectionDocumentV1,
): {
  equal: boolean;
  firstDivergencePath: string | null;
  liveChecksum: string;
  replayChecksum: string;
} {
  const liveChecksum = sha256CanonicalV1(live);
  const replayChecksum = sha256CanonicalV1(replayed);
  return {
    equal: hashesEqual(liveChecksum, replayChecksum),
    firstDivergencePath: firstDivergence(live, replayed, ''),
    liveChecksum,
    replayChecksum,
  };
}
