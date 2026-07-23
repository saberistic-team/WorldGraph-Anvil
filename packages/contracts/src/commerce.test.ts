import { describe, expect, it } from 'vitest';

import {
  CommerceNotificationV1Schema,
  CommercePositiveQuantitySchema,
  CommerceTransactionSummaryViewV1Schema,
  CreateEmploymentContractPayloadV1Schema,
  CreateMarketListingPayloadV1Schema,
  InventoryViewV1Schema,
  PerformJobPayloadV1Schema,
  ProductionRecipeVersionViewV1Schema,
  PurchaseMarketListingV1Schema,
  StartProductionRunPayloadV1Schema,
  WorldCommerceInitializedPayloadV1Schema,
} from './commerce.js';
import { createValidator } from './validation.js';

const id = '018f8652-3cb6-7d52-904b-cce7901d7e25';

describe('commerce contracts', () => {
  it('bounds positive fixed-point quantities to twelve fractional digits', () => {
    const validator = createValidator(CommercePositiveQuantitySchema);
    for (const quantity of ['1', '1.000000000000', '0.000000000001', '999999999999999999']) {
      expect(validator.is(quantity)).toBe(true);
    }
    for (const quantity of ['0', '0.0', '-1', '+1', '01', '1e2', '1.0000000000000']) {
      expect(validator.is(quantity)).toBe(false);
    }
  });

  it('keeps M09 production multipliers whole and employment rules server-verifiable', () => {
    const production = createValidator(StartProductionRunPayloadV1Schema);
    const productionPayload = {
      businessId: id,
      expectedBusinessVersion: '1',
      expectedFacilityVersion: '1',
      expectedInventories: [{ inventoryId: id, rowVersion: '1' }],
      facilityId: id,
      recipeVersionId: id,
      runQuantity: '999999999999999999',
    };
    expect(production.is(productionPayload)).toBe(true);
    expect(production.is({ ...productionPayload, runQuantity: '1.5' })).toBe(false);
    expect(production.is({ ...productionPayload, runQuantity: '1000000000000000000' })).toBe(false);

    const contract = createValidator(CreateEmploymentContractPayloadV1Schema);
    const contractPayload = {
      businessId: id,
      cooldownTicks: '1',
      effectiveFromTick: '1',
      effectiveToTick: '10',
      employerWalletId: id,
      expectedBusinessVersion: '1',
      maxPerformancesPerPeriod: 1,
      periodTicks: '10',
      rewardCapMinor: '100',
      roleCode: 'worker',
      wageMinor: '10',
      wageRuleKind: 'per_shift',
      workerEntityKey: 'character:worker',
      workerWalletId: id,
    };
    expect(contract.is(contractPayload)).toBe(true);
    expect(contract.is({ ...contractPayload, wageRuleKind: 'per_output' })).toBe(false);

    const perform = createValidator(PerformJobPayloadV1Schema);
    const performPayload = { contractId: id, expectedContractVersion: '1' };
    expect(perform.is(performPayload)).toBe(true);
    expect(
      perform.is({
        ...performPayload,
        declaredOutput: { quantity: '1', resourceTypeId: id },
      }),
    ).toBe(false);
  });

  it('rejects actor, totals, authority, and unknown fields in public market commands', () => {
    const listing = createValidator(CreateMarketListingPayloadV1Schema);
    const purchase = createValidator(PurchaseMarketListingV1Schema);
    const listingPayload = {
      expiresAtTick: '12',
      expectedInventoryVersion: '1',
      quantity: '2',
      sellerInventoryId: id,
      sellerWalletId: id,
      unitPriceMinor: '125',
    };
    expect(listing.is(listingPayload)).toBe(true);
    expect(listing.is({ ...listingPayload, sellerEntityId: id })).toBe(false);
    const command = {
      commandId: id,
      expectedAggregateVersion: '1',
      expectedStateRevision: '8',
      expectedTick: '20',
      expectedWorldVersion: '2',
      idempotencyKey: 'purchase-key-0001',
      payload: {
        buyerInventoryId: null,
        buyerWalletId: id,
        expectedBuyerInventoryVersion: null,
        expectedBuyerWalletVersion: '1',
        expectedListingVersion: '1',
        listingId: id,
        quantity: '1',
      },
      schemaVersion: 1,
      type: 'PurchaseMarketListingV1',
    };
    expect(purchase.is(command)).toBe(true);
    expect(purchase.is({ ...command, payload: { ...command.payload, grossMinor: '125' } })).toBe(
      false,
    );
    expect(purchase.is({ ...command, actorId: id })).toBe(false);
  });

  it('keeps initialization events and realtime messages bounded and non-sensitive', () => {
    const initialized = createValidator(WorldCommerceInitializedPayloadV1Schema);
    expect(
      initialized.is({
        aggregateVersion: '1',
        businessCount: 1,
        facilityCount: 1,
        inventoryCount: 3,
        recipeVersionCount: 1,
        resourceTypeCount: 3,
        seedPlanHash: 'a'.repeat(64),
        taxPolicyCount: 1,
        tick: '0',
      }),
    ).toBe(true);
    const notification = createValidator(CommerceNotificationV1Schema);
    const safe = {
      cursor: '9',
      entityId: id,
      schemaVersion: 1,
      stateRevision: '12',
      type: 'economy.trade.completed',
      worldId: id,
    };
    expect(notification.is(safe)).toBe(true);
    expect(notification.is({ ...safe, buyerWalletId: id })).toBe(false);
  });

  it('keeps aggregate transaction summaries discriminated and free of account identifiers', () => {
    const transaction = createValidator(CommerceTransactionSummaryViewV1Schema);
    const common = {
      currencyId: id,
      id,
      occurredTick: '9',
      worldId: id,
    };
    expect(
      transaction.is({
        ...common,
        buyerTotalMinor: '108',
        feeMinor: '3',
        grossMinor: '100',
        kind: 'market_purchase',
        marketTradeId: id,
        sellerNetMinor: '100',
        taxMinor: '5',
      }),
    ).toBe(true);
    expect(
      transaction.is({
        ...common,
        grossMinor: '100',
        kind: 'payroll',
        netMinor: '90',
        payrollRecordId: id,
        taxMinor: '10',
      }),
    ).toBe(true);
    expect(
      transaction.is({
        ...common,
        amountMinor: '5',
        basisMinor: '0',
        kind: 'periodic_tax',
        taxAssessmentId: id,
      }),
    ).toBe(true);
    expect(
      transaction.is({
        ...common,
        amountMinor: '5',
        basisMinor: '0',
        kind: 'periodic_tax',
        payerWalletId: id,
        taxAssessmentId: id,
      }),
    ).toBe(false);
    expect(
      transaction.is({
        ...common,
        grossMinor: '100',
        kind: 'payroll',
        netMinor: '90',
        payrollRecordId: id,
        taxMinor: '10',
        workerEntityId: id,
      }),
    ).toBe(false);
  });

  it('exposes exact facility requirements and inventory container identity in read views', () => {
    const recipe = createValidator(ProductionRecipeVersionViewV1Schema);
    const recipeView = {
      checksum: 'a'.repeat(64),
      durationTicks: '10',
      facilityAssetType: 'workshop',
      id,
      inputs: [{ quantity: '2.00', resourceTypeId: id }],
      outputs: [{ quantity: '1.00', resourceTypeId: id }],
      recipeId: id,
      schemaVersion: 1,
      version: 1,
      worldId: id,
    };
    expect(recipe.is(recipeView)).toBe(true);
    expect(recipe.is({ ...recipeView, facilityAssetType: undefined })).toBe(false);

    const inventory = createValidator(InventoryViewV1Schema);
    const inventoryView = {
      availableQuantity: '8.00',
      containerAssetId: id,
      containerEntityKey: 'asset:workshop-one',
      controlledByActor: true,
      id,
      ownerEntityKey: 'organization:forge',
      quantity: '10.00',
      reservedQuantity: '2.00',
      resourceType: {
        displayName: 'Iron ore',
        id,
        primitiveContentHash: 'b'.repeat(64),
        primitiveVersionId: id,
        quantityScale: 2,
        rowVersion: '1',
        schemaVersion: 1,
        stableKey: 'resource:iron-ore',
        status: 'active',
        unitCode: 'kg',
        worldId: id,
      },
      rowVersion: '1',
      updatedStateRevision: '8',
      worldId: id,
    };
    expect(inventory.is(inventoryView)).toBe(true);
    expect(inventory.is({ ...inventoryView, containerAssetId: null })).toBe(true);
    expect(inventory.is({ ...inventoryView, containerAssetId: undefined })).toBe(false);
  });
});
