import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  type DomainEventEnvelopeV1,
  type WorldClockConfigurationV1,
} from '@worldgraph/contracts';

import { sealDomainEventV1, sha256CanonicalV1 } from './hash.js';
import {
  compareSimulationProjectionDocumentV1,
  simulationProjectionDocumentV1,
} from './simulation-projection.js';
import { replaySimulationProjectionV1 } from './simulation-replay.js';

const worldId = uuid(1);
const worldVersionId = uuid(2);
const scheduleId = uuid(3);
const worldSeed = 'c'.repeat(64);
const configuration: WorldClockConfigurationV1 = {
  epochAt: '2000-01-01T00:00:00.000Z',
  maxBatchTicks: 64,
  maxCatchUpTicks: 256,
  prngAlgorithmVersion: 'xorshift32-sha256-v1',
  wallCadenceMilliseconds: 10_000,
  worldMillisecondsPerTick: 86_400_000,
};
const noticePayload = { text: 'Guild Founding Day', visibility: 'public' } as const;
const noticePayloadHash = sha256CanonicalV1(noticePayload);

interface EventFact {
  aggregateId: string;
  aggregateType: string;
  aggregateVersion: string;
  command: number;
  eventOrdinal?: number;
  eventType: string;
  payload: unknown;
  revision: string;
  sequence: number;
}

describe('simulation projection replay', () => {
  it('rebuilds equal semantic state for one three-tick batch and three one-tick batches', () => {
    const grouped = replaySimulationProjectionV1({
      events: stream([
        scheduleCreated(3, '2'),
        advance(4, '3', '0', '3', 3, 'f'.repeat(64), 1, 0),
        scheduleExecuted(5, '3', 4, 1, 'f'.repeat(64)),
        noticeEmitted(6, '3', 4, 2),
      ]),
      worldId,
      worldSeed,
    });
    const split = replaySimulationProjectionV1({
      events: stream([
        scheduleCreated(3, '2'),
        advance(4, '3', '0', '1', 1, 'd'.repeat(64), 0, 0),
        advance(5, '4', '1', '2', 1, 'e'.repeat(64), 0, 0),
        advance(6, '5', '2', '3', 1, 'f'.repeat(64), 1, 0),
        scheduleExecuted(7, '5', 6, 1, 'f'.repeat(64)),
        noticeEmitted(8, '5', 6, 2),
      ]),
      worldId,
      worldSeed,
    });

    expect(grouped.checksum).toBe(split.checksum);
    expect(simulationProjectionDocumentV1(grouped.projection)).toEqual(
      simulationProjectionDocumentV1(split.projection),
    );
    expect(grouped.projection).toMatchObject({
      clock: { currentTick: '3', mode: 'paused', outcomeHash: 'f'.repeat(64) },
      nextScheduleSequence: '2',
      scheduledActions: [{ id: scheduleId, scheduleSequence: '1', status: 'completed' }],
    });
    expect(grouped.projection.stateRevision).toBe('3');
    expect(split.projection.stateRevision).toBe('5');
  });

  it('reconstructs failure state and the implicit error-to-paused resolution transition', () => {
    const failureId = uuid(40);
    const batchRunId = uuid(41);
    const replayed = replaySimulationProjectionV1({
      events: stream([
        eventFact({
          aggregateId: worldId,
          aggregateType: 'simulation_clock',
          aggregateVersion: '2',
          command: 10,
          eventOrdinal: 0,
          eventType: 'WorldClockStartedV1',
          payload: { tick: '0' },
          revision: '2',
          sequence: 3,
        }),
        eventFact({
          aggregateId: worldId,
          aggregateType: 'simulation_clock',
          aggregateVersion: '3',
          command: 11,
          eventOrdinal: 0,
          eventType: 'WorldClockAutoPausedV1',
          payload: { errorCode: 'SIMULATION_HANDLER_FAILED', failureId, tick: '0' },
          revision: '3',
          sequence: 4,
        }),
        eventFact({
          aggregateId: failureId,
          aggregateType: 'simulation_failure',
          aggregateVersion: '1',
          command: 11,
          eventOrdinal: 1,
          eventType: 'SimulationFailureRecordedV1',
          payload: {
            attempts: 3,
            batchRunId,
            errorCode: 'SIMULATION_HANDLER_FAILED',
            failureId,
            processType: 'EmitWorldNoticeV1',
            processVersion: '1.0.0',
            scheduleId: null,
            tick: '1',
          },
          revision: '3',
          sequence: 5,
        }),
        eventFact({
          aggregateId: failureId,
          aggregateType: 'simulation_failure',
          aggregateVersion: '2',
          command: 12,
          eventOrdinal: 0,
          eventType: 'SimulationFailureResolvedV1',
          payload: {
            failureId,
            resolution: 'retry_after_repair',
            scheduleId: null,
            tick: '1',
          },
          revision: '4',
          sequence: 6,
        }),
      ]),
      worldId,
      worldSeed,
    });

    expect(replayed.projection.clock?.mode).toBe('paused');
    expect(replayed.projection.failures).toEqual([
      expect.objectContaining({
        aggregateVersion: '2',
        attempts: 3,
        batchRunId,
        id: failureId,
        resolution: 'retry_after_repair',
        status: 'resolved',
      }),
    ]);
    expect(simulationProjectionDocumentV1(replayed.projection)).not.toHaveProperty('failures');
  });

  it('accepts only the typed overflow shape for a world-clock failure source', () => {
    const failureId = uuid(50);
    const invalid = stream([
      eventFact({
        aggregateId: worldId,
        aggregateType: 'simulation_clock',
        aggregateVersion: '2',
        command: 20,
        eventType: 'WorldClockStartedV1',
        payload: { tick: '0' },
        revision: '2',
        sequence: 3,
      }),
      eventFact({
        aggregateId: worldId,
        aggregateType: 'simulation_clock',
        aggregateVersion: '3',
        command: 21,
        eventOrdinal: 0,
        eventType: 'WorldClockAutoPausedV1',
        payload: { errorCode: 'SIMULATION_HANDLER_FAILED', failureId, tick: '0' },
        revision: '3',
        sequence: 4,
      }),
      eventFact({
        aggregateId: failureId,
        aggregateType: 'simulation_failure',
        aggregateVersion: '1',
        command: 21,
        eventOrdinal: 1,
        eventType: 'SimulationFailureRecordedV1',
        payload: {
          attempts: 3,
          batchRunId: uuid(51),
          errorCode: 'SIMULATION_HANDLER_FAILED',
          failureId,
          processType: 'WorldClockV1',
          processVersion: '1.0.0',
          scheduleId: null,
          tick: '1',
        },
        revision: '3',
        sequence: 5,
      }),
    ]);

    expect(() => replaySimulationProjectionV1({ events: invalid, worldId, worldSeed })).toThrow(
      'world clock failure source has an invalid schedule or error code',
    );
  });

  it('fails closed at the exact event for altered hashes and illegal schedule transitions', () => {
    const valid = stream([scheduleCreated(3, '2')]);
    const altered = valid.map((event, index) =>
      index === 2 ? { ...event, payload: { ...event.payload, dueTick: '4' } } : event,
    ) as DomainEventEnvelopeV1[];
    expect(() => replaySimulationProjectionV1({ events: altered, worldId, worldSeed })).toThrow(
      'Replay event hash mismatch at 3',
    );

    const illegal = stream([
      eventFact({
        ...scheduleCreated(3, '2'),
        payload: { ...noticeCreatedPayload(), dueTick: '0' },
      }),
    ]);
    expect(() => replaySimulationProjectionV1({ events: illegal, worldId, worldSeed })).toThrow(
      'Simulation replay invariant failed at event 3 (ScheduledActionCreatedV1): schedule is not in the future',
    );
  });

  it('reports the first canonical JSON divergence without exposing schedule payload text', () => {
    const replayed = replaySimulationProjectionV1({
      events: stream([scheduleCreated(3, '2')]),
      worldId,
      worldSeed,
    });
    const document = simulationProjectionDocumentV1(replayed.projection);
    const live = JSON.parse(canonicalJson(document)) as typeof document;
    live.clock.currentTick = '9';
    const compared = compareSimulationProjectionDocumentV1(live, document);

    expect(compared).toMatchObject({ equal: false, firstDivergencePath: '/clock/currentTick' });
    expect(compared.liveChecksum).not.toBe(compared.replayChecksum);
    expect(JSON.stringify(document)).not.toContain(noticePayload.text);
  });
});

function stream(extra: readonly EventFact[]): DomainEventEnvelopeV1[] {
  return [genesis(), initialized(), ...extra].map(toEvent);
}

function genesis(): EventFact {
  return eventFact({
    aggregateId: worldId,
    aggregateType: 'world',
    aggregateVersion: '1',
    command: 1,
    eventType: 'WorldStateImportedV1',
    payload: {
      activeWorldVersionId: worldVersionId,
      artifactHash: 'a'.repeat(64),
      projectionSchemaVersions: {
        controllers: 1,
        entities: 1,
        relationships: 1,
        runtimeHead: 1,
      },
      rowCounts: { controllers: '0', entities: '0', relationships: '0' },
      stateChecksum: 'b'.repeat(64),
      worldVersionNumber: '1',
    },
    revision: '0',
    sequence: 1,
  });
}

function initialized(): EventFact {
  return eventFact({
    aggregateId: worldId,
    aggregateType: 'simulation_clock',
    aggregateVersion: '1',
    command: 2,
    eventType: 'WorldSimulationInitializedV1',
    payload: {
      configuration,
      currentTick: '0',
      mode: 'paused',
      processRegistryVersion: 1,
      provenance: 'm07_default',
    },
    revision: '1',
    sequence: 2,
  });
}

function noticeCreatedPayload() {
  return {
    actionSchemaVersion: 1,
    actionType: 'EmitWorldNoticeV1',
    dueTick: '3',
    payload: noticePayload,
    payloadHash: noticePayloadHash,
    priority: 0,
    processVersion: '1.0.0',
    scheduleId,
    scheduleSequence: '1',
  } as const;
}

function scheduleCreated(sequence: number, revision: string): EventFact {
  return eventFact({
    aggregateId: scheduleId,
    aggregateType: 'scheduled_action',
    aggregateVersion: '1',
    command: 3,
    eventType: 'ScheduledActionCreatedV1',
    payload: noticeCreatedPayload(),
    revision,
    sequence,
  });
}

function advance(
  sequence: number,
  revision: string,
  fromTick: string,
  toTick: string,
  tickCount: number,
  outcomeHash: string,
  executedScheduleCount: number,
  eventOrdinal: number,
): EventFact {
  return eventFact({
    aggregateId: worldId,
    aggregateType: 'simulation_clock',
    aggregateVersion: String(1 + Number(revision) - 2),
    command: 100 + sequence,
    eventOrdinal,
    eventType: 'SimulationAdvancedV1',
    payload: {
      executedScheduleCount,
      fromTick,
      outcomeHash,
      processRegistryVersion: 1,
      tickCount,
      toTick,
    },
    revision,
    sequence,
  });
}

function scheduleExecuted(
  sequence: number,
  revision: string,
  command: number,
  eventOrdinal: number,
  outcomeHash: string,
): EventFact {
  return eventFact({
    aggregateId: scheduleId,
    aggregateType: 'scheduled_action',
    aggregateVersion: '2',
    command: 100 + command,
    eventOrdinal,
    eventType: 'ScheduledActionExecutedV1',
    payload: {
      actionType: 'EmitWorldNoticeV1',
      dueTick: '3',
      outcomeHash,
      processVersion: '1.0.0',
      scheduleId,
      scheduleSequence: '1',
    },
    revision,
    sequence,
  });
}

function noticeEmitted(
  sequence: number,
  revision: string,
  command: number,
  eventOrdinal: number,
): EventFact {
  return eventFact({
    aggregateId: scheduleId,
    aggregateType: 'world_notice',
    aggregateVersion: '1',
    command: 100 + command,
    eventOrdinal,
    eventType: 'WorldNoticeEmittedV1',
    payload: { emittedAtTick: '3', scheduleId, ...noticePayload },
    revision,
    sequence,
  });
}

function eventFact(fact: EventFact): EventFact {
  return fact;
}

function toEvent(fact: EventFact): DomainEventEnvelopeV1 {
  const commandId = uuid(100 + fact.command);
  const at = `2026-07-22T00:${String(fact.sequence).padStart(2, '0')}:00.000Z`;
  return sealDomainEventV1({
    aggregateId: fact.aggregateId,
    aggregateType: fact.aggregateType,
    aggregateVersion: fact.aggregateVersion,
    commandId,
    eventId: uuid(300 + fact.sequence),
    eventOrdinal: fact.eventOrdinal ?? 0,
    eventSchemaVersion: 1,
    eventType: fact.eventType,
    metadata: {
      actor: { actorId: 'worldgraph.simulation', actorType: 'system' },
      authorizationRuleId: 'world.simulation.replay-test',
      causationId: null,
      commandSchemaVersion: 1,
      commandType: fact.eventType,
      correlationId: commandId,
      overrideId: null,
      payloadClassification: 'member',
    },
    occurredAt: at,
    payload: fact.payload,
    recordedAt: at,
    resultingStateRevision: fact.revision,
    worldEventSequence: String(fact.sequence),
    worldId,
  } as never);
}

function uuid(value: number): string {
  return `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;
}
