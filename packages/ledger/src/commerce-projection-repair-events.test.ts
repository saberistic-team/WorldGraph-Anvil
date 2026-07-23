import { describe, expect, it } from 'vitest';

import type { DomainEventEnvelopeV1, LedgerEntryV1 } from '@worldgraph/contracts';

import { projectWorldHistoryEntryV1, renderWorldHistoryTitleV1 } from './history.js';

const id = (value: number): string => `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;

describe('commerce projection repair event history', () => {
  it('projects a private operator-only summary without leaking plan contents', () => {
    const event: DomainEventEnvelopeV1 = {
      aggregateId: id(1),
      aggregateType: 'world_commerce_repair',
      aggregateVersion: '1',
      commandId: id(2),
      eventHash: 'a'.repeat(64),
      eventId: id(3),
      eventOrdinal: 0,
      eventSchemaVersion: 1,
      eventType: 'WorldCommerceProjectionRepairedV1',
      metadata: {
        actor: { actorId: id(4), actorType: 'platform_admin' },
        authorizationRuleId: 'operations.commerce_projection.repair.execute',
        causationId: id(1),
        commandSchemaVersion: 1,
        commandType: 'RepairEconomicProjectionV1',
        correlationId: id(2),
        overrideId: id(5),
        payloadClassification: 'private',
      },
      occurredAt: '2026-07-22T12:05:00.000Z',
      payload: {
        affectedInventoryCount: 2,
        aggregateVersion: '1',
        repairFactCount: 2,
        repairPlanHash: 'b'.repeat(64),
        repairPlanId: id(1),
        repairedProjectionChecksum: 'c'.repeat(64),
        sourceReconciliationRunId: id(6),
        tick: '40',
      },
      recordedAt: '2026-07-22T12:05:00.000Z',
      resultingStateRevision: '19',
      worldEventSequence: '19',
      worldId: id(7),
    };
    const entry: LedgerEntryV1 = {
      actor: { actorId: id(4), actorType: 'platform_admin' },
      commandId: id(2),
      entryHash: 'd'.repeat(64),
      entryId: id(8),
      entryKind: 'repair_anchor',
      eventId: id(3),
      ledgerSchemaVersion: 1,
      ledgerSequence: '22',
      previousHash: 'e'.repeat(64),
      publicSummaryCode: 'COMMERCE_PROJECTION_REPAIRED',
      recordedAt: '2026-07-22T12:05:00.000Z',
      redactedDetails: {
        affectedInventoryCount: 2,
        repairPlanId: id(1),
      },
      worldId: id(7),
    };

    const history = projectWorldHistoryEntryV1(event, entry);
    expect(history).toMatchObject({
      category: 'repair',
      summaryArgs: { repairFactCount: 2 },
      targetId: id(1),
      targetType: 'commerce_projection_repair',
      titleKey: 'history.commerce.projection_repaired',
      visibility: 'operator',
    });
    expect(renderWorldHistoryTitleV1(history)).toBe(
      'An approved commerce projection repair applied 2 immutable repair facts.',
    );
    expect(JSON.stringify(history)).not.toContain('repairPlanHash');
    expect(JSON.stringify(history)).not.toContain('repairedProjectionChecksum');
  });
});
