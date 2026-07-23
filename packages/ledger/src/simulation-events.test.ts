import { describe, expect, it } from 'vitest';

import {
  DomainEventEnvelopeV1Schema,
  WorldHistoryEntryV1Schema,
  createValidator,
  type DomainEventEnvelopeV1,
} from '@worldgraph/contracts';

import { sealDomainEventV1, sealLedgerEntryV1 } from './hash.js';
import { projectWorldHistoryEntryV1 } from './history.js';
import { createDefaultEventRegistry } from './registry.js';
import type { WorldProjectionV1 } from './types.js';

const worldId = uuid(1);
const scheduleId = uuid(2);
const failureId = uuid(3);
const batchRunId = uuid(4);
const at = '2026-07-22T12:00:00.000Z';
const noticeText = 'Private council notice that must never enter history summaries.';
const configuration = {
  epochAt: '2000-01-01T00:00:00.000Z',
  maxBatchTicks: 64,
  maxCatchUpTicks: 256,
  prngAlgorithmVersion: 'xorshift32-sha256-v1',
  wallCadenceMilliseconds: 10_000,
  worldMillisecondsPerTick: 86_400_000,
} as const;

const simulationFacts = [
  {
    aggregateId: worldId,
    aggregateType: 'world_simulation',
    eventType: 'WorldSimulationInitializedV1',
    payload: {
      configuration,
      currentTick: '0',
      mode: 'paused',
      processRegistryVersion: 1,
      provenance: 'm07_default',
    },
  },
  {
    aggregateId: worldId,
    aggregateType: 'world_clock',
    eventType: 'WorldClockConfiguredV1',
    payload: { configuration, previousConfiguration: configuration, tick: '0' },
  },
  {
    aggregateId: worldId,
    aggregateType: 'world_clock',
    eventType: 'WorldClockStartedV1',
    payload: { tick: '0' },
  },
  {
    aggregateId: worldId,
    aggregateType: 'world_clock',
    eventType: 'WorldClockPausedV1',
    payload: { reason: 'creator', tick: '0' },
  },
  {
    aggregateId: worldId,
    aggregateType: 'world_simulation',
    eventType: 'SimulationAdvancedV1',
    payload: {
      executedScheduleCount: 1,
      fromTick: '0',
      outcomeHash: 'a'.repeat(64),
      processRegistryVersion: 1,
      tickCount: 1,
      toTick: '1',
    },
  },
  {
    aggregateId: scheduleId,
    aggregateType: 'scheduled_action',
    eventType: 'ScheduledActionCreatedV1',
    payload: {
      actionSchemaVersion: 1,
      actionType: 'EmitWorldNoticeV1',
      dueTick: '1',
      payload: { text: noticeText, visibility: 'member' },
      payloadHash: 'b'.repeat(64),
      priority: 0,
      processVersion: '1.0.0',
      scheduleId,
      scheduleSequence: '1',
    },
  },
  {
    aggregateId: scheduleId,
    aggregateType: 'scheduled_action',
    eventType: 'ScheduledActionCancelledV1',
    payload: {
      actionType: 'EmitWorldNoticeV1',
      dueTick: '1',
      scheduleId,
      scheduleSequence: '1',
    },
  },
  {
    aggregateId: scheduleId,
    aggregateType: 'scheduled_action',
    eventType: 'ScheduledActionExecutedV1',
    payload: {
      actionType: 'EmitWorldNoticeV1',
      dueTick: '1',
      outcomeHash: 'c'.repeat(64),
      processVersion: '1.0.0',
      scheduleId,
      scheduleSequence: '1',
    },
  },
  {
    aggregateId: scheduleId,
    aggregateType: 'world_notice',
    eventType: 'WorldNoticeEmittedV1',
    payload: { emittedAtTick: '1', scheduleId, text: noticeText, visibility: 'member' },
  },
  {
    aggregateId: failureId,
    aggregateType: 'simulation_failure',
    eventType: 'SimulationFailureRecordedV1',
    payload: {
      attempts: 1,
      batchRunId,
      errorCode: 'SIMULATION_HANDLER_FAILED',
      failureId,
      processType: 'EmitWorldNoticeV1',
      processVersion: '1.0.0',
      scheduleId,
      tick: '1',
    },
  },
  {
    aggregateId: failureId,
    aggregateType: 'simulation_failure',
    eventType: 'SimulationFailureResolvedV1',
    payload: {
      failureId,
      resolution: 'cancel_action',
      scheduleId,
      tick: '1',
    },
  },
  {
    aggregateId: worldId,
    aggregateType: 'world_clock',
    eventType: 'WorldClockAutoPausedV1',
    payload: { errorCode: 'SIMULATION_HANDLER_FAILED', failureId, tick: '1' },
  },
] as const;

describe('simulation ledger events', () => {
  it('registers, validates and projects every simulation event without changing graph revision', () => {
    const eventValidator = createValidator<DomainEventEnvelopeV1>(DomainEventEnvelopeV1Schema);
    const historyValidator = createValidator(WorldHistoryEntryV1Schema);
    const registry = createDefaultEventRegistry();
    const registeredEventTypes = new Set(
      registry.registeredEvents().map((registration) => registration.eventType),
    );
    let projection: WorldProjectionV1 = {
      activeWorldVersionId: uuid(10),
      controllers: [],
      entities: [],
      projectionSchemaVersion: 1,
      relationships: [],
      stateRevision: '0',
      worldId,
      worldVersionNumber: '1',
    };

    for (const [index, fact] of simulationFacts.entries()) {
      expect(registeredEventTypes.has(fact.eventType), fact.eventType).toBe(true);
      const event = simulationEvent(fact, index);
      expect(eventValidator.issues(event), fact.eventType).toEqual([]);
      projection = registry.apply(projection, event);
      expect(projection.stateRevision).toBe('0');

      const ledger = sealLedgerEntryV1({
        actor: event.metadata.actor,
        commandId: event.commandId,
        entryId: uuid(300 + index),
        entryKind: 'domain_event',
        eventId: event.eventId,
        ledgerSchemaVersion: 1,
        ledgerSequence: String(index + 1),
        previousHash: '0'.repeat(64),
        publicSummaryCode: 'SIMULATION_EVENT',
        recordedAt: at,
        redactedDetails: {},
        worldId,
      });
      const history = projectWorldHistoryEntryV1(event, ledger);
      expect(historyValidator.is(history), fact.eventType).toBe(true);
      expect(history).toMatchObject({ category: 'simulation', eventType: fact.eventType });
      expect(JSON.stringify(history.summaryArgs)).not.toContain(noticeText);
    }
  });

  it('redacts notice text and low-entropy payload hashes from history summaries', () => {
    const created = projectHistoryForFact(simulationFacts[5], 5);
    const emitted = projectHistoryForFact(simulationFacts[8], 8);

    expect(created.summaryArgs).toEqual({
      actionType: 'EmitWorldNoticeV1',
      dueTick: '1',
      priority: 0,
      scheduleId,
      scheduleSequence: '1',
      visibility: 'member',
    });
    expect(emitted).toMatchObject({
      summaryArgs: { emittedAtTick: '1', scheduleId, visibility: 'member' },
      visibility: 'member',
    });
    expect(JSON.stringify([created.summaryArgs, emitted.summaryArgs])).not.toContain(noticeText);
    expect(created.summaryArgs).not.toHaveProperty('payloadHash');
    expect(emitted.summaryArgs).not.toHaveProperty('text');
  });
});

function projectHistoryForFact(fact: (typeof simulationFacts)[number], index: number) {
  const event = simulationEvent(fact, index);
  return projectWorldHistoryEntryV1(
    event,
    sealLedgerEntryV1({
      actor: event.metadata.actor,
      commandId: event.commandId,
      entryId: uuid(300 + index),
      entryKind: 'domain_event',
      eventId: event.eventId,
      ledgerSchemaVersion: 1,
      ledgerSequence: String(index + 1),
      previousHash: '0'.repeat(64),
      publicSummaryCode: 'SIMULATION_EVENT',
      recordedAt: at,
      redactedDetails: {},
      worldId,
    }),
  );
}

function simulationEvent(
  fact: (typeof simulationFacts)[number],
  index: number,
): DomainEventEnvelopeV1 {
  const commandId = uuid(100 + index);
  return sealDomainEventV1({
    aggregateId: fact.aggregateId,
    aggregateType: fact.aggregateType,
    aggregateVersion: String(index + 1),
    commandId,
    eventId: uuid(200 + index),
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType: fact.eventType,
    metadata: {
      actor: { actorId: 'worldgraph.simulation', actorType: 'system' },
      authorizationRuleId: 'world.simulation.event',
      causationId: null,
      commandSchemaVersion: 1,
      commandType: 'AdvanceSimulationV1',
      correlationId: commandId,
      overrideId: null,
      payloadClassification: 'member',
    },
    occurredAt: at,
    payload: fact.payload,
    recordedAt: at,
    resultingStateRevision: String(index + 1),
    worldEventSequence: String(index + 1),
    worldId,
  } as never);
}

function uuid(value: number): string {
  return `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;
}
