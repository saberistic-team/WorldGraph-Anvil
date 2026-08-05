import { describe, expect, it } from 'vitest';

import {
  DomainEventEnvelopeV1Schema,
  createValidator,
  type DomainEventEnvelopeV1,
} from '@worldgraph/contracts';

import { sealDomainEventV1 } from './hash.js';
import { createDefaultEventRegistry } from './registry.js';
import { createFixtureProjection, FIXTURE_WORLD_ID } from './test-fixture.js';

const id = (value: number): string => `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;
const at = '2026-07-22T12:00:00.000Z';
const hash = 'a'.repeat(64);
const base = { aggregateVersion: '1', tick: '40' } as const;

const commerceFacts = [
  {
    aggregateId: FIXTURE_WORLD_ID,
    aggregateType: 'world_commerce',
    eventType: 'WorldCommerceInitializedV1',
    payload: {
      ...base,
      businessCount: 1,
      facilityCount: 1,
      inventoryCount: 1,
      recipeVersionCount: 1,
      resourceTypeCount: 1,
      seedPlanHash: hash,
      taxPolicyCount: 1,
    },
  },
  {
    aggregateId: id(1),
    aggregateType: 'business',
    eventType: 'BusinessCreatedV1',
    payload: {
      ...base,
      backingOrganizationEntityId: id(2),
      businessId: id(1),
      walletId: id(3),
    },
  },
  {
    aggregateId: id(4),
    aggregateType: 'business_facility',
    eventType: 'BusinessFacilityConfiguredV1',
    payload: {
      ...base,
      businessId: id(1),
      facilityAssetId: id(5),
      facilityId: id(4),
      recipeVersionIds: [id(6)],
    },
  },
  {
    aggregateId: id(7),
    aggregateType: 'employment_contract',
    eventType: 'EmploymentContractCreatedV1',
    payload: {
      ...base,
      businessId: id(1),
      contractId: id(7),
      status: 'offered',
      workerEntityId: id(8),
    },
  },
  {
    aggregateId: id(7),
    aggregateType: 'employment_contract',
    eventType: 'EmploymentContractAcceptedV1',
    payload: {
      ...base,
      businessId: id(1),
      contractId: id(7),
      status: 'active',
      workerEntityId: id(8),
    },
  },
  {
    aggregateId: id(7),
    aggregateType: 'employment_contract',
    eventType: 'EmploymentContractEndedV1',
    payload: {
      ...base,
      businessId: id(1),
      contractId: id(7),
      status: 'ended',
      workerEntityId: id(8),
    },
  },
  {
    aggregateId: id(9),
    aggregateType: 'work_record',
    eventType: 'WorkRecordedV1',
    payload: {
      ...base,
      contractId: id(7),
      payrollRecordId: id(10),
      taxPolicyId: null,
      workRecordId: id(9),
    },
  },
  {
    aggregateId: id(10),
    aggregateType: 'payroll_record',
    eventType: 'PayrollSettledV1',
    payload: {
      ...base,
      contractId: id(7),
      financialTransactionId: id(11),
      grossMinor: '100',
      netMinor: '90',
      payrollRecordId: id(10),
      taxMinor: '10',
    },
  },
  {
    aggregateId: id(10),
    aggregateType: 'payroll_record',
    eventType: 'PayrollFailedV1',
    payload: {
      ...base,
      contractId: id(7),
      errorCode: 'INSUFFICIENT_FUNDS',
      payrollRecordId: id(10),
    },
  },
  {
    aggregateId: id(12),
    aggregateType: 'production_run',
    eventType: 'ProductionRunStartedV1',
    payload: {
      ...base,
      dueTick: '50',
      productionRunId: id(12),
      recipeVersionId: id(6),
      scheduledActionId: id(13),
    },
  },
  {
    aggregateId: id(12),
    aggregateType: 'production_run',
    eventType: 'ResourcesConsumedV1',
    payload: {
      ...base,
      productionRunId: id(12),
      resources: [{ quantity: '2.000000000000', resourceTypeId: id(14) }],
    },
  },
  {
    aggregateId: id(12),
    aggregateType: 'production_run',
    eventType: 'ResourcesProducedV1',
    payload: {
      ...base,
      productionRunId: id(12),
      resources: [{ quantity: '1.000000000000', resourceTypeId: id(15) }],
    },
  },
  {
    aggregateId: id(12),
    aggregateType: 'production_run',
    eventType: 'ProductionFailedV1',
    payload: { ...base, errorCode: 'OUTPUT_INVENTORY_UNAVAILABLE', productionRunId: id(12) },
  },
  {
    aggregateId: id(16),
    aggregateType: 'market_listing',
    eventType: 'MarketListingCreatedV1',
    payload: { ...base, listingId: id(16), remainingQuantity: '10', status: 'open' },
  },
  {
    aggregateId: id(16),
    aggregateType: 'market_listing',
    eventType: 'MarketListingCancelledV1',
    payload: { ...base, listingId: id(16), remainingQuantity: '10', status: 'cancelled' },
  },
  {
    aggregateId: id(16),
    aggregateType: 'market_listing',
    eventType: 'MarketListingExpiredV1',
    payload: { ...base, listingId: id(16), remainingQuantity: '10', status: 'expired' },
  },
  {
    aggregateId: id(16),
    aggregateType: 'market_listing',
    eventType: 'MarketListingPartiallyFilledV1',
    payload: { ...base, listingId: id(16), remainingQuantity: '5', status: 'open' },
  },
  {
    aggregateId: id(16),
    aggregateType: 'market_listing',
    eventType: 'MarketListingFilledV1',
    payload: { ...base, listingId: id(16), remainingQuantity: '0', status: 'filled' },
  },
  {
    aggregateId: id(17),
    aggregateType: 'inventory_transfer',
    eventType: 'InventoryTransferredV1',
    payload: {
      ...base,
      fromInventoryId: id(18),
      quantity: '2',
      resourceTypeId: id(14),
      toInventoryId: id(19),
      tradeId: id(17),
    },
  },
  {
    aggregateId: id(17),
    aggregateType: 'market_trade',
    eventType: 'MarketTradeCompletedV1',
    payload: {
      ...base,
      buyerTotalMinor: '110',
      feeMinor: '2',
      grossMinor: '100',
      listingId: id(16),
      quantity: '2',
      sellerNetMinor: '98',
      taxMinor: '10',
      tradeId: id(17),
    },
  },
  {
    aggregateId: id(20),
    aggregateType: 'tax_assessment',
    eventType: 'TaxAssessedV1',
    payload: {
      ...base,
      amountMinor: '10',
      assessmentId: id(20),
      basisMinor: '100',
      policyId: id(21),
      sourceId: id(17),
    },
  },
  {
    aggregateId: id(20),
    aggregateType: 'tax_assessment',
    eventType: 'TreasuryRevenueRecordedV1',
    payload: { ...base, amountMinor: '10', assessmentId: id(20), treasuryWalletId: id(22) },
  },
  {
    aggregateId: FIXTURE_WORLD_ID,
    aggregateType: 'world_commerce',
    eventType: 'WorldCommerceReconciledV1',
    payload: {
      ...base,
      checksum: hash,
      mismatchCount: 0,
      reconciliationRunId: id(23),
      status: 'matched',
    },
  },
  {
    aggregateId: id(24),
    aggregateType: 'world_commerce_repair',
    eventType: 'WorldCommerceProjectionRepairedV1',
    payload: {
      ...base,
      affectedInventoryCount: 1,
      repairFactCount: 1,
      repairPlanHash: hash,
      repairPlanId: id(24),
      repairedProjectionChecksum: 'b'.repeat(64),
      sourceReconciliationRunId: id(23),
    },
  },
] as const;

describe('productive-commerce event registry', () => {
  it('registers and evidence-replays every M09 commerce event without changing graph state', () => {
    const validator = createValidator<DomainEventEnvelopeV1>(DomainEventEnvelopeV1Schema);
    const registry = createDefaultEventRegistry();
    const registered = new Set(registry.registeredEvents().map(({ eventType }) => eventType));
    const projection = createFixtureProjection();

    for (const [index, fact] of commerceFacts.entries()) {
      const event = commerceEvent(fact, index);
      expect(registered.has(fact.eventType), fact.eventType).toBe(true);
      expect(validator.is(event), fact.eventType).toBe(true);
      expect(registry.apply(projection, event), fact.eventType).toBe(projection);
    }
  });

  it('keeps unknown event types fail-closed', () => {
    expect(() =>
      createDefaultEventRegistry().upcastPayload('UnknownCommerceEventV1', 1, {}),
    ).toThrow('Unknown event type');
  });
});

function commerceEvent(fact: (typeof commerceFacts)[number], index: number): DomainEventEnvelopeV1 {
  const repair = fact.eventType === 'WorldCommerceProjectionRepairedV1';
  return sealDomainEventV1({
    aggregateId: fact.aggregateId,
    aggregateType: fact.aggregateType,
    aggregateVersion: '1',
    commandId: id(100 + index),
    eventId: id(200 + index),
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType: fact.eventType,
    metadata: repair
      ? {
          actor: { actorId: id(300), actorType: 'platform_admin' },
          authorizationRuleId: 'operations.commerce_projection.repair.execute',
          causationId: id(24),
          commandSchemaVersion: 1,
          commandType: 'RepairEconomicProjectionV1',
          correlationId: id(100 + index),
          overrideId: id(301),
          payloadClassification: 'private',
        }
      : {
          actor: { actorId: id(300), actorType: 'user' },
          authorizationRuleId: 'world.commerce.command',
          causationId: null,
          commandSchemaVersion: 1,
          commandType: 'CommerceCommandV1',
          correlationId: id(100 + index),
          overrideId: null,
          payloadClassification: 'member',
        },
    occurredAt: at,
    payload: fact.payload,
    recordedAt: at,
    resultingStateRevision: String(index + 1),
    worldEventSequence: String(index + 1),
    worldId: FIXTURE_WORLD_ID,
  } as never);
}
