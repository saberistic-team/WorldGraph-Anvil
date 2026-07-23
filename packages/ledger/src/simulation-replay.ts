import {
  DOMAIN_EVENT_SCHEMA_VERSION,
  DomainEventEnvelopeV1Schema,
  SIMULATION_OUTCOME_SCHEMA_VERSION,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  SIMULATION_PROJECTION_SCHEMA_VERSION,
  canonicalJson,
  createValidator,
  type DomainEventEnvelopeV1,
  type SimulationProcessRegistryVersion,
  type Validator,
} from '@worldgraph/contracts';

import { computeDomainEventHashV1, hashesEqual, sha256CanonicalV1 } from './hash.js';
import {
  computeSimulationProjectionChecksumV1,
  type SimulationReplayFailureV1,
  type SimulationReplayScheduledActionV1,
  type SimulationReplayStateV1,
} from './simulation-projection.js';

const eventValidator: Validator<DomainEventEnvelopeV1> = createValidator<DomainEventEnvelopeV1>(
  DomainEventEnvelopeV1Schema,
);

const SIMULATION_EVENT_TYPES = new Set([
  'WorldSimulationInitializedV1',
  'WorldClockConfiguredV1',
  'WorldClockStartedV1',
  'WorldClockPausedV1',
  'SimulationAdvancedV1',
  'ScheduledActionCreatedV1',
  'ScheduledActionCancelledV1',
  'ScheduledActionExecutedV1',
  'WorldNoticeEmittedV1',
  'SimulationFailureRecordedV1',
  'SimulationFailureResolvedV1',
  'WorldClockAutoPausedV1',
] as const);

const MAX_EVENTS_PER_REPLAY_COMMAND = 64;

interface ReplayEventGroupV1 {
  commandId: string;
  events: DomainEventEnvelopeV1[];
}

export interface ReplaySimulationProjectionInputV1 {
  events: readonly DomainEventEnvelopeV1[];
  worldId: string;
  worldSeed: string;
}

export interface ReplaySimulationProjectionResultV1 {
  checksum: string;
  eventCount: number;
  lastEventSequence: string;
  projection: SimulationReplayStateV1;
  simulationEventCount: number;
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function invariant(
  condition: unknown,
  event: DomainEventEnvelopeV1,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(
      `Simulation replay invariant failed at event ${event.worldEventSequence} (${event.eventType}): ${message}`,
    );
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertNextAggregateVersion(currentVersion: string, event: DomainEventEnvelopeV1): void {
  invariant(
    BigInt(event.aggregateVersion) === BigInt(currentVersion) + 1n,
    event,
    `aggregate version does not follow ${currentVersion}`,
  );
}

function assertClockEvent(
  state: SimulationReplayStateV1,
  event: DomainEventEnvelopeV1,
): NonNullable<SimulationReplayStateV1['clock']> {
  const current = clock(state, event);
  invariant(event.aggregateType === 'simulation_clock', event, 'aggregate type is not clock');
  invariant(event.aggregateId === state.worldId, event, 'clock aggregate ID is not the world');
  assertNextAggregateVersion(current.aggregateVersion, event);
  return current;
}

function initialOutcomeHash(
  worldSeedHash: string,
  processRegistryVersion: SimulationProcessRegistryVersion,
): string {
  return sha256CanonicalV1({
    domain: 'worldgraph.simulation.outcome.initial.v1',
    outcomeSchemaVersion: SIMULATION_OUTCOME_SCHEMA_VERSION,
    prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
    processRegistryVersion,
    worldSeedHash,
  });
}

function worldSeedHash(worldSeed: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(worldSeed)) {
    throw new TypeError('Simulation replay world seed is invalid.');
  }
  return sha256CanonicalV1({ domain: 'worldgraph.simulation.world-seed.v1', worldSeed });
}

export function createSimulationReplayStateV1(input: {
  worldId: string;
  worldSeed: string;
}): SimulationReplayStateV1 {
  return {
    clock: null,
    failures: [],
    lastEventSequence: '0',
    nextScheduleSequence: null,
    scheduledActions: [],
    simulationProjectionSchemaVersion: SIMULATION_PROJECTION_SCHEMA_VERSION,
    stateRevision: '0',
    worldId: input.worldId,
    worldSeedHash: worldSeedHash(input.worldSeed),
  };
}

function clock(state: SimulationReplayStateV1, event: DomainEventEnvelopeV1) {
  invariant(state.clock, event, 'clock is not initialized');
  return state.clock;
}

function actionIndex(
  state: SimulationReplayStateV1,
  scheduleId: string,
  event: DomainEventEnvelopeV1,
): number {
  const index = state.scheduledActions.findIndex((action) => action.id === scheduleId);
  invariant(index >= 0, event, `scheduled action ${scheduleId} does not exist`);
  return index;
}

function failureIndex(
  state: SimulationReplayStateV1,
  failureId: string,
  event: DomainEventEnvelopeV1,
): number {
  const index = state.failures.findIndex((failure) => failure.id === failureId);
  invariant(index >= 0, event, `simulation failure ${failureId} does not exist`);
  return index;
}

function replaceAction(
  state: SimulationReplayStateV1,
  index: number,
  action: SimulationReplayScheduledActionV1,
): SimulationReplayStateV1 {
  const scheduledActions = [...state.scheduledActions];
  scheduledActions[index] = action;
  return { ...state, scheduledActions };
}

function replaceFailure(
  state: SimulationReplayStateV1,
  index: number,
  failure: SimulationReplayFailureV1,
): SimulationReplayStateV1 {
  const failures = [...state.failures];
  failures[index] = failure;
  return { ...state, failures };
}

/**
 * Applies one immutable event to the rebuildable simulation projection. Non-simulation facts are
 * deliberately no-ops; their ordering and hashes are still checked by replaySimulationProjectionV1.
 */
export function reduceSimulationProjectionV1(
  state: SimulationReplayStateV1,
  event: DomainEventEnvelopeV1,
): SimulationReplayStateV1 {
  invariant(event.worldId === state.worldId, event, 'world scope differs from the replay target');
  switch (event.eventType) {
    case 'WorldSimulationInitializedV1': {
      invariant(!state.clock, event, 'clock was initialized more than once');
      invariant(event.aggregateType === 'simulation_clock', event, 'aggregate type is not clock');
      invariant(event.aggregateId === state.worldId, event, 'clock aggregate ID is not the world');
      invariant(event.aggregateVersion === '1', event, 'initial clock aggregate version is not 1');
      return {
        ...state,
        clock: {
          aggregateVersion: event.aggregateVersion,
          clockSchemaVersion: 1,
          configuration: canonicalClone(event.payload.configuration),
          currentTick: event.payload.currentTick,
          mode: event.payload.mode,
          outcomeHash: initialOutcomeHash(
            state.worldSeedHash,
            event.payload.processRegistryVersion,
          ),
          updatedAt: event.recordedAt,
          updatedStateRevision: event.resultingStateRevision,
        },
        nextScheduleSequence: '1',
      };
    }
    case 'WorldClockConfiguredV1': {
      const current = assertClockEvent(state, event);
      invariant(
        current.currentTick === '0' && current.mode === 'paused',
        event,
        'clock is not paused at tick zero',
      );
      invariant(event.payload.tick === '0', event, 'configuration event tick is not zero');
      invariant(
        sameCanonical(current.configuration, event.payload.previousConfiguration),
        event,
        'previous clock configuration does not match replay state',
      );
      return {
        ...state,
        clock: {
          ...current,
          aggregateVersion: event.aggregateVersion,
          configuration: canonicalClone(event.payload.configuration),
          updatedAt: event.recordedAt,
          updatedStateRevision: event.resultingStateRevision,
        },
      };
    }
    case 'WorldClockStartedV1': {
      const current = assertClockEvent(state, event);
      invariant(current.mode === 'paused', event, 'only a paused clock can start');
      invariant(event.payload.tick === current.currentTick, event, 'start tick differs from clock');
      return {
        ...state,
        clock: {
          ...current,
          aggregateVersion: event.aggregateVersion,
          mode: 'running',
          updatedAt: event.recordedAt,
          updatedStateRevision: event.resultingStateRevision,
        },
      };
    }
    case 'WorldClockPausedV1': {
      const current = assertClockEvent(state, event);
      invariant(current.mode === 'running', event, 'only a running clock can pause');
      invariant(event.payload.tick === current.currentTick, event, 'pause tick differs from clock');
      return {
        ...state,
        clock: {
          ...current,
          aggregateVersion: event.aggregateVersion,
          mode: 'paused',
          updatedAt: event.recordedAt,
          updatedStateRevision: event.resultingStateRevision,
        },
      };
    }
    case 'SimulationAdvancedV1': {
      const current = assertClockEvent(state, event);
      invariant(current.mode !== 'error', event, 'an error-paused clock cannot advance');
      invariant(
        event.payload.fromTick === current.currentTick,
        event,
        'advance source tick differs from clock',
      );
      invariant(
        BigInt(event.payload.toTick) ===
          BigInt(event.payload.fromTick) + BigInt(event.payload.tickCount),
        event,
        'advance range does not match tick count',
      );
      invariant(
        event.payload.tickCount <= current.configuration.maxBatchTicks,
        event,
        'advance exceeds configured batch limit',
      );
      return {
        ...state,
        clock: {
          ...current,
          aggregateVersion: event.aggregateVersion,
          currentTick: event.payload.toTick,
          outcomeHash: event.payload.outcomeHash,
          updatedAt: event.recordedAt,
          updatedStateRevision: event.resultingStateRevision,
        },
      };
    }
    case 'ScheduledActionCreatedV1': {
      const current = clock(state, event);
      invariant(
        event.aggregateType === 'scheduled_action',
        event,
        'aggregate type is not schedule',
      );
      invariant(
        event.aggregateId === event.payload.scheduleId,
        event,
        'schedule aggregate ID differs',
      );
      invariant(
        event.aggregateVersion === '1',
        event,
        'created schedule aggregate version is not 1',
      );
      invariant(state.nextScheduleSequence, event, 'schedule head is not initialized');
      invariant(
        event.payload.scheduleSequence === state.nextScheduleSequence,
        event,
        'schedule sequence is not the next allocated value',
      );
      invariant(
        BigInt(event.payload.dueTick) > BigInt(current.currentTick),
        event,
        'schedule is not in the future',
      );
      invariant(
        sha256CanonicalV1(event.payload.payload) === event.payload.payloadHash,
        event,
        'schedule payload hash differs from canonical payload',
      );
      invariant(
        !state.scheduledActions.some((action) => action.id === event.payload.scheduleId),
        event,
        'schedule ID already exists',
      );
      invariant(
        event.metadata.actor.actorType !== 'ai',
        event,
        'AI actors cannot create schedules',
      );
      const replayedAction = {
        actionSchemaVersion: event.payload.actionSchemaVersion,
        actionType: event.payload.actionType,
        aggregateVersion: event.aggregateVersion,
        cancelledCommandId: null,
        completedEventId: null,
        completedStateRevision: null,
        createdAt: event.recordedAt,
        createdBy: canonicalClone(event.metadata.actor),
        createdCommandId: event.commandId,
        createdStateRevision: event.resultingStateRevision,
        dueTick: event.payload.dueTick,
        id: event.payload.scheduleId,
        payload: canonicalClone(event.payload.payload),
        payloadHash: event.payload.payloadHash,
        priority: event.payload.priority,
        processVersion: event.payload.processVersion,
        scheduleSequence: event.payload.scheduleSequence,
        status: 'scheduled' as const,
        updatedAt: event.recordedAt,
      } as SimulationReplayScheduledActionV1;
      return {
        ...state,
        nextScheduleSequence: (BigInt(state.nextScheduleSequence) + 1n).toString(),
        scheduledActions: [...state.scheduledActions, replayedAction],
      };
    }
    case 'ScheduledActionCancelledV1': {
      const index = actionIndex(state, event.payload.scheduleId, event);
      const current = state.scheduledActions[index]!;
      invariant(current.status === 'scheduled', event, 'only a scheduled action can cancel');
      invariant(event.aggregateId === current.id, event, 'schedule aggregate ID differs');
      invariant(
        event.aggregateType === 'scheduled_action',
        event,
        'aggregate type is not schedule',
      );
      assertNextAggregateVersion(current.aggregateVersion, event);
      invariant(
        event.payload.scheduleSequence === current.scheduleSequence &&
          event.payload.dueTick === current.dueTick &&
          event.payload.actionType === current.actionType,
        event,
        'cancelled schedule identity differs from creation',
      );
      return replaceAction(state, index, {
        ...current,
        aggregateVersion: event.aggregateVersion,
        cancelledCommandId: event.commandId,
        completedStateRevision: event.resultingStateRevision,
        status: 'cancelled',
        updatedAt: event.recordedAt,
      });
    }
    case 'ScheduledActionExecutedV1': {
      const currentClock = clock(state, event);
      const index = actionIndex(state, event.payload.scheduleId, event);
      const current = state.scheduledActions[index]!;
      invariant(current.status === 'scheduled', event, 'only a scheduled action can execute');
      invariant(event.aggregateId === current.id, event, 'schedule aggregate ID differs');
      invariant(
        event.aggregateType === 'scheduled_action',
        event,
        'aggregate type is not schedule',
      );
      assertNextAggregateVersion(current.aggregateVersion, event);
      invariant(
        event.payload.scheduleSequence === current.scheduleSequence &&
          event.payload.dueTick === current.dueTick &&
          event.payload.actionType === current.actionType &&
          event.payload.processVersion === current.processVersion,
        event,
        'executed schedule identity differs from creation',
      );
      invariant(
        BigInt(current.dueTick) <= BigInt(currentClock.currentTick),
        event,
        'schedule executed before due tick',
      );
      invariant(
        event.payload.outcomeHash === currentClock.outcomeHash,
        event,
        'execution outcome differs from clock',
      );
      return replaceAction(state, index, {
        ...current,
        aggregateVersion: event.aggregateVersion,
        completedEventId: event.eventId,
        completedStateRevision: event.resultingStateRevision,
        status: 'completed',
        updatedAt: event.recordedAt,
      });
    }
    case 'WorldNoticeEmittedV1': {
      const index = actionIndex(state, event.payload.scheduleId, event);
      const current = state.scheduledActions[index]!;
      invariant(
        event.aggregateType === 'world_notice',
        event,
        'aggregate type is not world notice',
      );
      invariant(event.aggregateId === current.id, event, 'world notice aggregate ID differs');
      invariant(event.aggregateVersion === '1', event, 'world notice aggregate version is not 1');
      invariant(current.status === 'completed', event, 'notice schedule is not completed');
      invariant(
        current.actionType === 'EmitWorldNoticeV1',
        event,
        'world notice is not backed by a notice schedule',
      );
      invariant(
        event.payload.emittedAtTick === current.dueTick,
        event,
        'notice tick differs from schedule',
      );
      invariant(
        event.payload.text === current.payload.text &&
          event.payload.visibility === current.payload.visibility,
        event,
        'notice fact differs from scheduled payload',
      );
      return state;
    }
    case 'WorldClockAutoPausedV1': {
      const current = assertClockEvent(state, event);
      invariant(current.mode === 'running', event, 'only a running clock can auto-pause');
      invariant(
        event.payload.tick === current.currentTick,
        event,
        'auto-pause tick differs from clock',
      );
      return {
        ...state,
        clock: {
          ...current,
          aggregateVersion: event.aggregateVersion,
          mode: 'error',
          updatedAt: event.recordedAt,
          updatedStateRevision: event.resultingStateRevision,
        },
      };
    }
    case 'SimulationFailureRecordedV1': {
      invariant(
        event.aggregateType === 'simulation_failure',
        event,
        'aggregate type is not failure',
      );
      invariant(
        event.aggregateId === event.payload.failureId,
        event,
        'failure aggregate ID differs',
      );
      invariant(
        event.aggregateVersion === '1',
        event,
        'recorded failure aggregate version is not 1',
      );
      invariant(
        !state.failures.some((failure) => failure.id === event.payload.failureId),
        event,
        'failure ID already exists',
      );
      if (event.payload.processType === 'WorldClockV1') {
        invariant(
          event.payload.scheduleId === null &&
            event.payload.errorCode === 'SIMULATION_INTEGER_OVERFLOW',
          event,
          'world clock failure source has an invalid schedule or error code',
        );
      }
      if (event.payload.scheduleId !== null) actionIndex(state, event.payload.scheduleId, event);
      return {
        ...state,
        failures: [
          ...state.failures,
          {
            aggregateVersion: event.aggregateVersion,
            attempts: event.payload.attempts,
            batchRunId: event.payload.batchRunId,
            errorCode: event.payload.errorCode,
            id: event.payload.failureId,
            openedAt: event.recordedAt,
            processType: event.payload.processType,
            processVersion: event.payload.processVersion,
            resolution: null,
            resolutionCommandId: null,
            resolvedAt: null,
            resolvedBy: null,
            scheduleId: event.payload.scheduleId,
            status: 'open',
            tick: event.payload.tick,
          },
        ],
      };
    }
    case 'SimulationFailureResolvedV1': {
      const currentClock = clock(state, event);
      const index = failureIndex(state, event.payload.failureId, event);
      const current = state.failures[index]!;
      invariant(
        currentClock.mode === 'error',
        event,
        'failure resolution requires an error-paused clock',
      );
      invariant(current.status === 'open', event, 'only an open failure can resolve');
      invariant(event.aggregateId === current.id, event, 'failure aggregate ID differs');
      invariant(
        event.aggregateType === 'simulation_failure',
        event,
        'aggregate type is not failure',
      );
      assertNextAggregateVersion(current.aggregateVersion, event);
      invariant(
        event.payload.scheduleId === current.scheduleId && event.payload.tick === current.tick,
        event,
        'resolved failure identity differs from recorded failure',
      );
      return replaceFailure(
        {
          ...state,
          clock: {
            ...currentClock,
            // The v1 resolution command changes the clock projection atomically without a
            // separate clock event; this transition is therefore part of this reducer.
            mode: 'paused',
            updatedAt: event.recordedAt,
            updatedStateRevision: event.resultingStateRevision,
          },
        },
        index,
        {
          ...current,
          aggregateVersion: event.aggregateVersion,
          resolution: event.payload.resolution,
          resolutionCommandId: event.commandId,
          resolvedAt: event.recordedAt,
          resolvedBy: canonicalClone(event.metadata.actor),
          status: 'resolved',
        },
      );
    }
    default:
      return state;
  }
}

function groupEvents(
  events: readonly DomainEventEnvelopeV1[],
  expectedWorldId: string,
): ReplayEventGroupV1[] {
  const groups: ReplayEventGroupV1[] = [];
  const completedCommandIds = new Set<string>();
  let current: ReplayEventGroupV1 | undefined;
  let expectedSequence = 1n;

  for (const event of events) {
    if (!eventValidator.is(event)) throw new TypeError('Invalid domain event.');
    if (event.worldId !== expectedWorldId) throw new Error('Replay event world scope mismatch.');
    if (event.worldEventSequence !== expectedSequence.toString()) {
      throw new Error(`Replay event sequence gap at ${expectedSequence}.`);
    }
    if (!hashesEqual(event.eventHash, computeDomainEventHashV1(event))) {
      throw new Error(`Replay event hash mismatch at ${event.worldEventSequence}.`);
    }
    if (!current || current.commandId !== event.commandId) {
      if (current) completedCommandIds.add(current.commandId);
      if (completedCommandIds.has(event.commandId)) {
        throw new Error(`Replay command events are not contiguous for command ${event.commandId}.`);
      }
      current = { commandId: event.commandId, events: [] };
      groups.push(current);
    }
    current.events.push(event);
    if (current.events.length > MAX_EVENTS_PER_REPLAY_COMMAND) {
      throw new Error(`Replay command ${event.commandId} exceeds the 64-event budget.`);
    }
    expectedSequence += 1n;
  }
  return groups;
}

function validateGroup(group: ReplayEventGroupV1): string {
  const revision = group.events[0]!.resultingStateRevision;
  for (const [index, event] of group.events.entries()) {
    if (event.eventOrdinal !== index) {
      throw new Error(
        `Replay event ordinal mismatch for command ${group.commandId}: expected ${index}.`,
      );
    }
    if (event.resultingStateRevision !== revision) {
      throw new Error(`Replay command ${group.commandId} has inconsistent state revisions.`);
    }
    if (event.eventSchemaVersion !== DOMAIN_EVENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported simulation replay event version at ${event.worldEventSequence}.`,
      );
    }
  }
  return revision;
}

export function replaySimulationProjectionV1(
  input: ReplaySimulationProjectionInputV1,
): ReplaySimulationProjectionResultV1 {
  if (input.events.length === 0) throw new Error('Replay requires a genesis event.');
  const groups = groupEvents(input.events, input.worldId);
  let projection = createSimulationReplayStateV1(input);
  let simulationEventCount = 0;

  for (const [groupIndex, group] of groups.entries()) {
    const revision = validateGroup(group);
    if (groupIndex === 0) {
      if (
        group.events.length !== 1 ||
        !['WorldCompiledGenesisV1', 'WorldStateImportedV1'].includes(group.events[0]!.eventType)
      ) {
        throw new Error('Simulation replay must begin with one honest world genesis event.');
      }
    } else {
      const expectedRevision = (BigInt(projection.stateRevision) + 1n).toString();
      if (revision !== expectedRevision) {
        throw new Error(
          `Replay state revision mismatch for command ${group.commandId}: expected ${expectedRevision}.`,
        );
      }
    }
    projection = { ...projection, stateRevision: revision };
    for (const event of group.events) {
      projection = reduceSimulationProjectionV1(projection, event);
      projection = { ...projection, lastEventSequence: event.worldEventSequence };
      if (SIMULATION_EVENT_TYPES.has(event.eventType as never)) simulationEventCount += 1;
    }
  }

  if (!projection.clock || !projection.nextScheduleSequence) {
    throw new Error('Simulation replay did not encounter WorldSimulationInitializedV1.');
  }
  return {
    checksum: computeSimulationProjectionChecksumV1(projection),
    eventCount: input.events.length,
    lastEventSequence: projection.lastEventSequence,
    projection,
    simulationEventCount,
  };
}

export const SIMULATION_REPLAY_EVENT_TYPES_V1 = Object.freeze([...SIMULATION_EVENT_TYPES].sort());
