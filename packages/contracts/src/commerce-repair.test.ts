import { describe, expect, it } from 'vitest';

import {
  CommerceProjectionRepairApprovalRequestV1Schema,
  CommerceProjectionRepairApprovalV1Schema,
  CommerceProjectionRepairExecutionReceiptV1Schema,
  CommerceProjectionRepairPlanBodyV1Schema,
  CommerceProjectionRepairPlanV1Schema,
  RepairEconomicProjectionV1Schema,
} from './commerce.js';
import {
  DomainEventEnvelopeV1Schema,
  WorldCommerceProjectionRepairedEventV1Schema,
} from './ledger.js';
import { createValidator } from './validation.js';

const id = (value: number): string => `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;
const hash = (value: string): string => value.repeat(64);

const planBody = {
  domain: 'worldgraph.commerce-projection-repair-plan.v1',
  expiresAt: '2026-07-22T12:15:00.000Z',
  items: [
    {
      actualQuantity: '8.000000000000',
      actualReservedQuantity: '3.000000000000',
      expectedRowVersion: '7',
      inventoryId: id(1),
      itemOrdinal: 0,
      mismatchKinds: ['quantity', 'reservation'],
      repairFactId: id(2),
      repairedQuantity: '10.000000000000',
      repairedReservedQuantity: '2.000000000000',
    },
  ],
  preparedAt: '2026-07-22T12:00:00.000Z',
  preparedByUserId: id(3),
  reason: 'INCIDENT-COMMERCE-001 projection differs from immutable journals',
  repairPlanId: id(4),
  repairPlanSchemaVersion: 1,
  reservedCommandId: id(5),
  reservedEventId: id(6),
  reservedLedgerEntryId: id(7),
  sourceEconomyChecksum: hash('a'),
  sourceEconomyHeadVersion: '4',
  sourceEventSequence: '18',
  sourceExpansionChecksum: hash('b'),
  sourceExpansionHeadVersion: '5',
  sourceLedgerSequence: '21',
  sourceReconciliationLiveChecksum: hash('c'),
  sourceReconciliationRebuiltChecksum: hash('d'),
  sourceReconciliationRunId: id(8),
  sourceStateRevision: '18',
  sourceWorldVersion: '2',
  worldId: id(9),
} as const;

const plan = { ...planBody, planHash: hash('e') } as const;

function repairEvent(): Record<string, unknown> {
  return {
    aggregateId: plan.repairPlanId,
    aggregateType: 'world_commerce_repair',
    aggregateVersion: '1',
    commandId: plan.reservedCommandId,
    eventHash: hash('f'),
    eventId: plan.reservedEventId,
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType: 'WorldCommerceProjectionRepairedV1',
    metadata: {
      actor: { actorId: id(10), actorType: 'platform_admin' },
      authorizationRuleId: 'operations.commerce_projection.repair.execute',
      causationId: plan.repairPlanId,
      commandSchemaVersion: 1,
      commandType: 'RepairEconomicProjectionV1',
      correlationId: plan.reservedCommandId,
      overrideId: id(11),
      payloadClassification: 'private',
    },
    occurredAt: '2026-07-22T12:05:00.000Z',
    payload: {
      affectedInventoryCount: 1,
      aggregateVersion: '1',
      repairFactCount: 1,
      repairPlanHash: plan.planHash,
      repairPlanId: plan.repairPlanId,
      repairedProjectionChecksum: hash('1'),
      sourceReconciliationRunId: plan.sourceReconciliationRunId,
      tick: '40',
    },
    recordedAt: '2026-07-22T12:05:00.000Z',
    resultingStateRevision: '19',
    worldEventSequence: '19',
    worldId: plan.worldId,
  };
}

describe('reviewed commerce projection repair contracts', () => {
  it('accepts a bounded sealed dry-run plan and rejects invented repair values', () => {
    const bodyValidator = createValidator(CommerceProjectionRepairPlanBodyV1Schema);
    const planValidator = createValidator(CommerceProjectionRepairPlanV1Schema);

    expect(bodyValidator.is(planBody)).toBe(true);
    expect(planValidator.is(plan)).toBe(true);
    expect(planValidator.is({ ...plan, items: [] })).toBe(false);
    expect(
      planValidator.is({
        ...plan,
        items: [{ ...plan.items[0], replacementQuantity: '999' }],
      }),
    ).toBe(false);
    expect(planValidator.is({ ...plan, reason: 'too short' })).toBe(false);
    expect(planValidator.is({ ...plan, reason: ` ${plan.reason}` })).toBe(false);
  });

  it('keeps the executable command minimal and owner/operator-only by contract intent', () => {
    const command = {
      commandId: plan.reservedCommandId,
      expectedAggregateVersion: '0',
      expectedStateRevision: plan.sourceStateRevision,
      expectedTick: '40',
      expectedWorldVersion: plan.sourceWorldVersion,
      idempotencyKey: 'commerce-projection-repair-0001',
      payload: {
        confirmation: 'APPLY APPEND-ONLY COMMERCE REPAIR',
        repairPlanHash: plan.planHash,
        repairPlanId: plan.repairPlanId,
        sourceReconciliationRunId: plan.sourceReconciliationRunId,
      },
      schemaVersion: 1,
      type: 'RepairEconomicProjectionV1',
    };
    const validator = createValidator(RepairEconomicProjectionV1Schema);

    expect(validator.is(command)).toBe(true);
    expect(
      validator.is({
        ...command,
        payload: { ...command.payload, quantity: '999' },
      }),
    ).toBe(false);
    expect(
      validator.is({
        ...command,
        payload: { ...command.payload, confirmation: 'yes' },
      }),
    ).toBe(false);
  });

  it('requires a sealed independent approval document', () => {
    const request = {
      approvalId: id(12),
      confirmation: 'APPROVE APPEND-ONLY COMMERCE REPAIR',
      planHash: plan.planHash,
    };
    expect(createValidator(CommerceProjectionRepairApprovalRequestV1Schema).is(request)).toBe(true);
    expect(
      createValidator(CommerceProjectionRepairApprovalV1Schema).is({
        approvalId: request.approvalId,
        approvedAt: '2026-07-22T12:03:00.000Z',
        approverUserId: id(10),
        planHash: plan.planHash,
        repairPlanId: plan.repairPlanId,
        worldId: plan.worldId,
      }),
    ).toBe(true);
    expect(
      createValidator(CommerceProjectionRepairApprovalRequestV1Schema).is({
        ...request,
        confirmation: 'approve',
      }),
    ).toBe(false);
  });

  it('defines a bounded non-sensitive execution receipt', () => {
    const receipt = {
      commandId: plan.reservedCommandId,
      eventId: plan.reservedEventId,
      ledgerEntryId: plan.reservedLedgerEntryId,
      reconciliationRunId: id(13),
      repairFactCount: 1,
      repairPlanId: plan.repairPlanId,
      resultingChecksum: hash('1'),
      resultingEventSequence: '19',
      resultingLedgerSequence: '22',
      resultingStateRevision: '19',
      schemaVersion: 1,
      worldId: plan.worldId,
    };
    const validator = createValidator(CommerceProjectionRepairExecutionReceiptV1Schema);
    expect(validator.is(receipt)).toBe(true);
    expect(validator.is({ ...receipt, reason: plan.reason })).toBe(false);
    expect(validator.is({ ...receipt, repairFactCount: 0 })).toBe(false);
  });

  it('admits only the private platform-admin repair event metadata', () => {
    const event = repairEvent();
    const repairValidator = createValidator(WorldCommerceProjectionRepairedEventV1Schema);
    const domainValidator = createValidator(DomainEventEnvelopeV1Schema);

    expect(repairValidator.is(event)).toBe(true);
    expect(domainValidator.is(event)).toBe(true);
    expect(
      repairValidator.is({
        ...event,
        metadata: { ...(event.metadata as object), payloadClassification: 'member' },
      }),
    ).toBe(false);
    expect(repairValidator.is({ ...event, aggregateType: 'world_commerce' })).toBe(false);
  });
});
