import { describe, expect, it } from 'vitest';

import type { DomainEventEnvelopeV1, LedgerEntryV1 } from '@worldgraph/contracts';

import { sealDomainEventV1, sealLedgerEntryV1 } from './hash.js';
import { projectWorldHistoryEntryV1, renderWorldHistoryTitleV1 } from './history.js';
import { createDefaultEventRegistry } from './registry.js';
import { createFixtureProjection, FIXTURE_WORLD_ID } from './test-fixture.js';

const id = (value: number): string => `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;

function repairEvent(): DomainEventEnvelopeV1 {
  return sealDomainEventV1({
    aggregateId: FIXTURE_WORLD_ID,
    aggregateType: 'world_economy',
    aggregateVersion: '10',
    commandId: id(50),
    eventId: id(51),
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType: 'WorldEconomyRepairedV1',
    metadata: {
      actor: { actorId: id(52), actorType: 'platform_admin' },
      authorizationRuleId: 'operations.economy.repair.execute',
      causationId: id(57),
      commandSchemaVersion: 1,
      commandType: 'RepairWorldEconomyV1',
      correlationId: id(50),
      overrideId: id(53),
      payloadClassification: 'private',
    },
    occurredAt: '2026-07-22T12:01:00.000Z',
    payload: {
      compensationTransactionId: id(54),
      compensationTransferId: id(55),
      reasonCode: 'DUPLICATE_EFFECT',
      repairKind: 'reverse_asset_purchase',
      repairPlanHash: 'a'.repeat(64),
      repairPlanId: id(56),
      sourceCommandId: id(57),
    },
    recordedAt: '2026-07-22T12:01:00.000Z',
    resultingStateRevision: '1',
    worldEventSequence: '10',
    worldId: FIXTURE_WORLD_ID,
  });
}

function repairLedger(event: DomainEventEnvelopeV1): LedgerEntryV1 {
  return sealLedgerEntryV1({
    actor: event.metadata.actor,
    commandId: event.commandId,
    entryId: id(58),
    entryKind: 'repair_anchor',
    eventId: event.eventId,
    ledgerSchemaVersion: 1,
    ledgerSequence: '20',
    previousHash: '0'.repeat(64),
    publicSummaryCode: 'WORLD_ECONOMY_REPAIRED',
    recordedAt: event.recordedAt,
    redactedDetails: {
      eventType: event.eventType,
      repairKind: 'reverse_asset_purchase',
    },
    worldId: FIXTURE_WORLD_ID,
  });
}

describe('WorldEconomyRepairedV1 ledger integration', () => {
  it('is registered as an evidence event without changing the graph projection', () => {
    const event = repairEvent();
    const projection = createFixtureProjection();
    const registry = createDefaultEventRegistry();

    expect(registry.registeredEvents()).toContainEqual({
      eventSchemaVersion: 1,
      eventType: 'WorldEconomyRepairedV1',
    });
    expect(registry.apply(projection, event)).toBe(projection);
    expect(event.metadata).toMatchObject({
      authorizationRuleId: 'operations.economy.repair.execute',
      causationId: id(57),
      overrideId: id(53),
    });
  });

  it('projects only a bounded member-visible repair summary', () => {
    const event = repairEvent();
    const history = projectWorldHistoryEntryV1(event, repairLedger(event));

    expect(history).toMatchObject({
      category: 'repair',
      summaryArgs: {
        reasonCode: 'DUPLICATE_EFFECT',
        repairKind: 'reverse_asset_purchase',
      },
      targetId: FIXTURE_WORLD_ID,
      targetType: 'world_economy',
      titleKey: 'history.economy.repair_applied',
      visibility: 'member',
    });
    expect(renderWorldHistoryTitleV1(history)).toBe(
      'An audited append-only economy repair was applied (reverse_asset_purchase).',
    );
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain('a'.repeat(64));
    expect(serialized).not.toContain(id(54));
    expect(serialized).not.toContain(id(55));
    expect(serialized).not.toContain(id(56));
    expect(serialized).not.toContain(id(57));
  });
});
