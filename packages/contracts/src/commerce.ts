import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { IdempotencyKeySchema } from './commands.js';
import {
  EconomyHashSchema,
  EconomyPositiveMinorSchema,
  EconomyPositiveVersionSchema,
  EconomyRepairCanonicalTimestampSchema,
  EconomyStableKeySchema,
  EconomyTickSchema,
  EconomyUnsignedMinorSchema,
  EconomyUuidSchema,
  EconomyVersionSchema,
} from './economy.js';

export const CommerceSchemaVersionSchema = Type.Literal(1);
export const CommerceQuantitySchema = Type.String({
  maxLength: 43,
  minLength: 1,
  pattern: '^(?:0|[1-9][0-9]{0,29})(?:\\.[0-9]{1,12})?$',
});
export const CommercePositiveQuantitySchema = Type.String({
  maxLength: 43,
  minLength: 1,
  pattern: '^(?=.*[1-9])(?:0|[1-9][0-9]{0,29})(?:\\.[0-9]{1,12})?$',
});
export const CommercePositiveWholeQuantitySchema = Type.String({
  maxLength: 18,
  minLength: 1,
  pattern: '^[1-9][0-9]{0,17}$',
});
export const CommerceCodeSchema = Type.String({
  maxLength: 80,
  minLength: 1,
  pattern: '^[a-z][a-z0-9_]*$',
});
export const CommerceFailureCodeSchema = Type.String({
  maxLength: 100,
  minLength: 3,
  pattern: '^[A-Z][A-Z0-9_]*$',
});
export const CommerceDisplayNameSchema = Type.String({
  maxLength: 100,
  minLength: 1,
  pattern: '^[^\\u0000-\\u001F\\u007F]+$',
});

export const ResourceTypeStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('retired'),
]);
export const InventoryReservationPurposeSchema = Type.Union([
  Type.Literal('production_input'),
  Type.Literal('market_listing'),
]);
export const InventoryReservationStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('consumed'),
  Type.Literal('released'),
  Type.Literal('expired'),
]);
export const BusinessStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('suspended'),
  Type.Literal('closed'),
]);
export const FacilityStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('disabled'),
  Type.Literal('retired'),
]);
export const ProductionRunStatusSchema = Type.Union([
  Type.Literal('scheduled'),
  Type.Literal('reserving'),
  Type.Literal('ready'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);
export const EmploymentContractStatusSchema = Type.Union([
  Type.Literal('offered'),
  Type.Literal('active'),
  Type.Literal('ended'),
  Type.Literal('cancelled'),
]);
export const WageRuleKindSchema = Type.Union([
  Type.Literal('per_shift'),
  Type.Literal('per_output'),
]);
export const PayrollStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('paid'),
  Type.Literal('failed'),
]);
export const MarketListingStatusSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('filled'),
  Type.Literal('cancelled'),
  Type.Literal('expired'),
]);
export const TaxPolicyTypeSchema = Type.Union([
  Type.Literal('transaction'),
  Type.Literal('sales'),
  Type.Literal('payroll'),
  Type.Literal('periodic_flat'),
  Type.Literal('marketplace_fee'),
]);
export const TaxCollectionModeSchema = Type.Union([
  Type.Literal('added_to_payer'),
  Type.Literal('withheld_from_recipient'),
]);
export const TaxPolicyStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('disabled'),
  Type.Literal('retired'),
]);

const CommerceCommandCommonFields = {
  commandId: EconomyUuidSchema,
  expectedAggregateVersion: EconomyVersionSchema,
  expectedStateRevision: EconomyVersionSchema,
  expectedTick: EconomyTickSchema,
  expectedWorldVersion: EconomyPositiveVersionSchema,
  idempotencyKey: IdempotencyKeySchema,
  schemaVersion: Type.Literal(1),
} as const;

function commerceCommand<TType extends string, TPayload extends TSchema>(
  type: TType,
  payload: TPayload,
) {
  return Type.Object(
    { ...CommerceCommandCommonFields, payload, type: Type.Literal(type) },
    { additionalProperties: false },
  );
}

export const InitializeWorldCommercePayloadV1Schema = Type.Object(
  {
    compiledWorldVersionId: EconomyUuidSchema,
    seedPlanHash: EconomyHashSchema,
  },
  { $id: 'InitializeWorldCommercePayloadV1', additionalProperties: false },
);
export const InitializeWorldCommerceV1Schema = commerceCommand(
  'InitializeWorldCommerceV1',
  InitializeWorldCommercePayloadV1Schema,
);

export const CreateBusinessPayloadV1Schema = Type.Object(
  {
    backingOrganizationEntityKey: EconomyStableKeySchema,
    walletId: EconomyUuidSchema,
  },
  { $id: 'CreateBusinessPayloadV1', additionalProperties: false },
);
export const CreateBusinessV1Schema = commerceCommand(
  'CreateBusinessV1',
  CreateBusinessPayloadV1Schema,
);

export const ConfigureBusinessFacilityPayloadV1Schema = Type.Object(
  {
    businessId: EconomyUuidSchema,
    expectedBusinessVersion: EconomyPositiveVersionSchema,
    expectedOwnershipVersion: EconomyPositiveVersionSchema,
    facilityAssetId: EconomyUuidSchema,
    recipeVersionIds: Type.Array(EconomyUuidSchema, {
      maxItems: 32,
      minItems: 1,
      uniqueItems: true,
    }),
  },
  { $id: 'ConfigureBusinessFacilityPayloadV1', additionalProperties: false },
);
export const ConfigureBusinessFacilityV1Schema = commerceCommand(
  'ConfigureBusinessFacilityV1',
  ConfigureBusinessFacilityPayloadV1Schema,
);

export const CreateEmploymentContractPayloadV1Schema = Type.Object(
  {
    businessId: EconomyUuidSchema,
    cooldownTicks: EconomyTickSchema,
    effectiveFromTick: EconomyTickSchema,
    effectiveToTick: EconomyTickSchema,
    employerWalletId: EconomyUuidSchema,
    expectedBusinessVersion: EconomyPositiveVersionSchema,
    maxPerformancesPerPeriod: Type.Integer({ maximum: 100, minimum: 1 }),
    periodTicks: EconomyTickSchema,
    rewardCapMinor: EconomyPositiveMinorSchema,
    roleCode: CommerceCodeSchema,
    wageMinor: EconomyPositiveMinorSchema,
    wageRuleKind: Type.Literal('per_shift'),
    workerEntityKey: EconomyStableKeySchema,
    workerWalletId: EconomyUuidSchema,
  },
  { $id: 'CreateEmploymentContractPayloadV1', additionalProperties: false },
);
export const CreateEmploymentContractV1Schema = commerceCommand(
  'CreateEmploymentContractV1',
  CreateEmploymentContractPayloadV1Schema,
);

export const AcceptEmploymentContractPayloadV1Schema = Type.Object(
  {
    contractId: EconomyUuidSchema,
    expectedContractVersion: EconomyPositiveVersionSchema,
  },
  { $id: 'AcceptEmploymentContractPayloadV1', additionalProperties: false },
);
export const AcceptEmploymentContractV1Schema = commerceCommand(
  'AcceptEmploymentContractV1',
  AcceptEmploymentContractPayloadV1Schema,
);

export const EndEmploymentContractPayloadV1Schema = Type.Object(
  {
    contractId: EconomyUuidSchema,
    expectedContractVersion: EconomyPositiveVersionSchema,
    reason: Type.String({
      maxLength: 240,
      minLength: 8,
      pattern: '^(?! )(?!.* $)[^\\u0000-\\u001F\\u007F-\\u009F]+$',
    }),
  },
  { $id: 'EndEmploymentContractPayloadV1', additionalProperties: false },
);
export const EndEmploymentContractV1Schema = commerceCommand(
  'EndEmploymentContractV1',
  EndEmploymentContractPayloadV1Schema,
);

export const PerformJobPayloadV1Schema = Type.Object(
  {
    contractId: EconomyUuidSchema,
    expectedContractVersion: EconomyPositiveVersionSchema,
  },
  { $id: 'PerformJobPayloadV1', additionalProperties: false },
);
export const PerformJobV1Schema = commerceCommand('PerformJobV1', PerformJobPayloadV1Schema);

export const ExpectedInventoryVersionV1Schema = Type.Object(
  {
    inventoryId: EconomyUuidSchema,
    rowVersion: EconomyPositiveVersionSchema,
  },
  { additionalProperties: false },
);
export const StartProductionRunPayloadV1Schema = Type.Object(
  {
    businessId: EconomyUuidSchema,
    expectedBusinessVersion: EconomyPositiveVersionSchema,
    expectedFacilityVersion: EconomyPositiveVersionSchema,
    expectedInventories: Type.Array(ExpectedInventoryVersionV1Schema, {
      maxItems: 32,
      minItems: 1,
    }),
    facilityId: EconomyUuidSchema,
    recipeVersionId: EconomyUuidSchema,
    runQuantity: CommercePositiveWholeQuantitySchema,
  },
  { $id: 'StartProductionRunPayloadV1', additionalProperties: false },
);
export const StartProductionRunV1Schema = commerceCommand(
  'StartProductionRunV1',
  StartProductionRunPayloadV1Schema,
);

export const CreateMarketListingPayloadV1Schema = Type.Object(
  {
    expiresAtTick: EconomyTickSchema,
    expectedInventoryVersion: EconomyPositiveVersionSchema,
    quantity: CommercePositiveQuantitySchema,
    sellerInventoryId: EconomyUuidSchema,
    sellerWalletId: EconomyUuidSchema,
    unitPriceMinor: EconomyPositiveMinorSchema,
  },
  { $id: 'CreateMarketListingPayloadV1', additionalProperties: false },
);
export const CreateMarketListingV1Schema = commerceCommand(
  'CreateMarketListingV1',
  CreateMarketListingPayloadV1Schema,
);

export const CancelMarketListingPayloadV1Schema = Type.Object(
  {
    expectedListingVersion: EconomyPositiveVersionSchema,
    listingId: EconomyUuidSchema,
  },
  { $id: 'CancelMarketListingPayloadV1', additionalProperties: false },
);
export const CancelMarketListingV1Schema = commerceCommand(
  'CancelMarketListingV1',
  CancelMarketListingPayloadV1Schema,
);

export const PurchaseMarketListingPayloadV1Schema = Type.Object(
  {
    buyerInventoryId: Type.Union([EconomyUuidSchema, Type.Null()]),
    buyerWalletId: EconomyUuidSchema,
    expectedBuyerInventoryVersion: Type.Union([EconomyPositiveVersionSchema, Type.Null()]),
    expectedBuyerWalletVersion: EconomyPositiveVersionSchema,
    expectedListingVersion: EconomyPositiveVersionSchema,
    listingId: EconomyUuidSchema,
    quantity: CommercePositiveQuantitySchema,
  },
  { $id: 'PurchaseMarketListingPayloadV1', additionalProperties: false },
);
export const PurchaseMarketListingV1Schema = commerceCommand(
  'PurchaseMarketListingV1',
  PurchaseMarketListingPayloadV1Schema,
);

export const ReconcileWorldCommercePayloadV1Schema = Type.Object(
  { expectedExpansionVersion: EconomyPositiveVersionSchema },
  { $id: 'ReconcileWorldCommercePayloadV1', additionalProperties: false },
);
export const ReconcileWorldCommerceV1Schema = commerceCommand(
  'ReconcileWorldCommerceV1',
  ReconcileWorldCommercePayloadV1Schema,
);

export const CommerceProjectionRepairReasonSchema = Type.String({
  maxLength: 1_000,
  minLength: 20,
  pattern: '^(?! )(?!.* $)[^\\u0000-\\u001F\\u007F-\\u009F]+$',
});
export const CommerceProjectionRepairMismatchKindSchema = Type.Union([
  Type.Literal('quantity'),
  Type.Literal('reservation'),
]);
export const CommerceProjectionRepairItemV1Schema = Type.Object(
  {
    actualQuantity: CommerceQuantitySchema,
    actualReservedQuantity: CommerceQuantitySchema,
    expectedRowVersion: EconomyPositiveVersionSchema,
    inventoryId: EconomyUuidSchema,
    itemOrdinal: Type.Integer({ maximum: 9_999, minimum: 0 }),
    mismatchKinds: Type.Array(CommerceProjectionRepairMismatchKindSchema, {
      maxItems: 2,
      minItems: 1,
      uniqueItems: true,
    }),
    repairFactId: EconomyUuidSchema,
    repairedQuantity: CommerceQuantitySchema,
    repairedReservedQuantity: CommerceQuantitySchema,
  },
  { $id: 'CommerceProjectionRepairItemV1', additionalProperties: false },
);
const CommerceProjectionRepairPlanBodyFields = {
  domain: Type.Literal('worldgraph.commerce-projection-repair-plan.v1'),
  expiresAt: EconomyRepairCanonicalTimestampSchema,
  items: Type.Array(CommerceProjectionRepairItemV1Schema, {
    maxItems: 10_000,
    minItems: 1,
  }),
  preparedAt: EconomyRepairCanonicalTimestampSchema,
  preparedByUserId: EconomyUuidSchema,
  reason: CommerceProjectionRepairReasonSchema,
  repairPlanId: EconomyUuidSchema,
  repairPlanSchemaVersion: Type.Literal(1),
  reservedCommandId: EconomyUuidSchema,
  reservedEventId: EconomyUuidSchema,
  reservedLedgerEntryId: EconomyUuidSchema,
  sourceEconomyChecksum: EconomyHashSchema,
  sourceEconomyHeadVersion: EconomyPositiveVersionSchema,
  sourceEventSequence: EconomyPositiveVersionSchema,
  sourceExpansionChecksum: EconomyHashSchema,
  sourceExpansionHeadVersion: EconomyPositiveVersionSchema,
  sourceLedgerSequence: EconomyPositiveVersionSchema,
  sourceReconciliationLiveChecksum: EconomyHashSchema,
  sourceReconciliationRebuiltChecksum: EconomyHashSchema,
  sourceReconciliationRunId: EconomyUuidSchema,
  sourceStateRevision: EconomyPositiveVersionSchema,
  sourceWorldVersion: EconomyPositiveVersionSchema,
  worldId: EconomyUuidSchema,
} as const;
export const CommerceProjectionRepairPlanBodyV1Schema = Type.Object(
  CommerceProjectionRepairPlanBodyFields,
  { $id: 'CommerceProjectionRepairPlanBodyV1', additionalProperties: false },
);
export const CommerceProjectionRepairPlanV1Schema = Type.Object(
  { ...CommerceProjectionRepairPlanBodyFields, planHash: EconomyHashSchema },
  { $id: 'CommerceProjectionRepairPlanV1', additionalProperties: false },
);
export const CommerceProjectionRepairApprovalRequestV1Schema = Type.Object(
  {
    approvalId: EconomyUuidSchema,
    confirmation: Type.Literal('APPROVE APPEND-ONLY COMMERCE REPAIR'),
    planHash: EconomyHashSchema,
  },
  { $id: 'CommerceProjectionRepairApprovalRequestV1', additionalProperties: false },
);
export const CommerceProjectionRepairApprovalV1Schema = Type.Object(
  {
    approvalId: EconomyUuidSchema,
    approvedAt: EconomyRepairCanonicalTimestampSchema,
    approverUserId: EconomyUuidSchema,
    planHash: EconomyHashSchema,
    repairPlanId: EconomyUuidSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'CommerceProjectionRepairApprovalV1', additionalProperties: false },
);
export const CommerceProjectionRepairExecutionReceiptV1Schema = Type.Object(
  {
    commandId: EconomyUuidSchema,
    eventId: EconomyUuidSchema,
    ledgerEntryId: EconomyUuidSchema,
    reconciliationRunId: EconomyUuidSchema,
    repairFactCount: Type.Integer({ maximum: 10_000, minimum: 1 }),
    repairPlanId: EconomyUuidSchema,
    resultingChecksum: EconomyHashSchema,
    resultingEventSequence: EconomyPositiveVersionSchema,
    resultingLedgerSequence: EconomyPositiveVersionSchema,
    resultingStateRevision: EconomyPositiveVersionSchema,
    schemaVersion: Type.Literal(1),
    worldId: EconomyUuidSchema,
  },
  { $id: 'CommerceProjectionRepairExecutionReceiptV1', additionalProperties: false },
);

/** Owner/operator-only command. Public command transports must not register this type. */
export const RepairEconomicProjectionPayloadV1Schema = Type.Object(
  {
    confirmation: Type.Literal('APPLY APPEND-ONLY COMMERCE REPAIR'),
    repairPlanHash: EconomyHashSchema,
    repairPlanId: EconomyUuidSchema,
    sourceReconciliationRunId: EconomyUuidSchema,
  },
  { $id: 'RepairEconomicProjectionPayloadV1', additionalProperties: false },
);
export const RepairEconomicProjectionV1Schema = commerceCommand(
  'RepairEconomicProjectionV1',
  RepairEconomicProjectionPayloadV1Schema,
);

const InternalScheduledPayloadFields = {
  expectedTick: EconomyTickSchema,
  scheduledActionId: EconomyUuidSchema,
} as const;
export const CompleteProductionRunPayloadV1Schema = Type.Object(
  { ...InternalScheduledPayloadFields, productionRunId: EconomyUuidSchema },
  { $id: 'CompleteProductionRunPayloadV1', additionalProperties: false },
);
export const SettlePayrollPayloadV1Schema = Type.Object(
  { ...InternalScheduledPayloadFields, payrollRecordId: EconomyUuidSchema },
  { $id: 'SettlePayrollPayloadV1', additionalProperties: false },
);
export const ExpireMarketListingPayloadV1Schema = Type.Object(
  { ...InternalScheduledPayloadFields, listingId: EconomyUuidSchema },
  { $id: 'ExpireMarketListingPayloadV1', additionalProperties: false },
);
export const AssessPeriodicTaxPayloadV1Schema = Type.Object(
  { ...InternalScheduledPayloadFields, taxPolicyId: EconomyUuidSchema },
  { $id: 'AssessPeriodicTaxPayloadV1', additionalProperties: false },
);

export const CommerceResourceAmountV1Schema = Type.Object(
  {
    quantity: CommercePositiveQuantitySchema,
    resourceTypeId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);

export const ResourceTypeViewV1Schema = Type.Object(
  {
    displayName: CommerceDisplayNameSchema,
    id: EconomyUuidSchema,
    primitiveContentHash: EconomyHashSchema,
    primitiveVersionId: EconomyUuidSchema,
    quantityScale: Type.Integer({ maximum: 12, minimum: 0 }),
    rowVersion: EconomyPositiveVersionSchema,
    schemaVersion: CommerceSchemaVersionSchema,
    stableKey: EconomyStableKeySchema,
    status: ResourceTypeStatusSchema,
    unitCode: Type.String({ maxLength: 40, minLength: 1, pattern: '^[a-z][a-z0-9-]*$' }),
    worldId: EconomyUuidSchema,
  },
  { $id: 'ResourceTypeViewV1', additionalProperties: false },
);

export const ProductionRecipeVersionViewV1Schema = Type.Object(
  {
    checksum: EconomyHashSchema,
    durationTicks: EconomyTickSchema,
    facilityAssetType: CommerceCodeSchema,
    id: EconomyUuidSchema,
    inputs: Type.Array(CommerceResourceAmountV1Schema, { maxItems: 32 }),
    outputs: Type.Array(CommerceResourceAmountV1Schema, { maxItems: 32, minItems: 1 }),
    recipeId: EconomyUuidSchema,
    schemaVersion: CommerceSchemaVersionSchema,
    version: Type.Integer({ minimum: 1 }),
    worldId: EconomyUuidSchema,
  },
  { $id: 'ProductionRecipeVersionViewV1', additionalProperties: false },
);

export const InventoryViewV1Schema = Type.Object(
  {
    availableQuantity: CommerceQuantitySchema,
    containerAssetId: Type.Union([EconomyUuidSchema, Type.Null()]),
    containerEntityKey: Type.Union([EconomyStableKeySchema, Type.Null()]),
    controlledByActor: Type.Boolean(),
    id: EconomyUuidSchema,
    ownerEntityKey: EconomyStableKeySchema,
    quantity: CommerceQuantitySchema,
    reservedQuantity: CommerceQuantitySchema,
    resourceType: ResourceTypeViewV1Schema,
    rowVersion: EconomyPositiveVersionSchema,
    updatedStateRevision: EconomyVersionSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'InventoryViewV1', additionalProperties: false },
);

export const BusinessViewV1Schema = Type.Object(
  {
    backingOrganizationEntityKey: EconomyStableKeySchema,
    canManage: Type.Boolean(),
    id: EconomyUuidSchema,
    rowVersion: EconomyPositiveVersionSchema,
    schemaVersion: CommerceSchemaVersionSchema,
    status: BusinessStatusSchema,
    walletId: EconomyUuidSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'BusinessViewV1', additionalProperties: false },
);

export const BusinessFacilityViewV1Schema = Type.Object(
  {
    businessId: EconomyUuidSchema,
    facilityAssetId: EconomyUuidSchema,
    id: EconomyUuidSchema,
    recipeVersionIds: Type.Array(EconomyUuidSchema, { maxItems: 32 }),
    rowVersion: EconomyPositiveVersionSchema,
    schemaVersion: CommerceSchemaVersionSchema,
    status: FacilityStatusSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'BusinessFacilityViewV1', additionalProperties: false },
);

export const ProductionRunViewV1Schema = Type.Object(
  {
    businessId: EconomyUuidSchema,
    dueTick: EconomyTickSchema,
    facilityId: EconomyUuidSchema,
    failureCode: Type.Union([CommerceCodeSchema, Type.Null()]),
    id: EconomyUuidSchema,
    inputSnapshot: Type.Array(CommerceResourceAmountV1Schema, { maxItems: 32 }),
    outputSnapshot: Type.Array(CommerceResourceAmountV1Schema, { maxItems: 32 }),
    recipeVersionId: EconomyUuidSchema,
    rowVersion: EconomyPositiveVersionSchema,
    runQuantity: CommercePositiveWholeQuantitySchema,
    status: ProductionRunStatusSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'ProductionRunViewV1', additionalProperties: false },
);

export const EmploymentContractViewV1Schema = Type.Object(
  {
    businessId: EconomyUuidSchema,
    canManage: Type.Boolean(),
    canWork: Type.Boolean(),
    effectiveFromTick: EconomyTickSchema,
    effectiveToTick: EconomyTickSchema,
    id: EconomyUuidSchema,
    privateTermsVisible: Type.Boolean(),
    roleCode: CommerceCodeSchema,
    rowVersion: EconomyPositiveVersionSchema,
    status: EmploymentContractStatusSchema,
    wageMinor: Type.Union([EconomyPositiveMinorSchema, Type.Null()]),
    workerEntityKey: EconomyStableKeySchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'EmploymentContractViewV1', additionalProperties: false },
);

export const MarketListingViewV1Schema = Type.Object(
  {
    canCancel: Type.Boolean(),
    currencyId: EconomyUuidSchema,
    expiresAtTick: EconomyTickSchema,
    id: EconomyUuidSchema,
    offeredQuantity: CommercePositiveQuantitySchema,
    remainingQuantity: CommerceQuantitySchema,
    resourceType: ResourceTypeViewV1Schema,
    rowVersion: EconomyPositiveVersionSchema,
    sellerEntityKey: EconomyStableKeySchema,
    status: MarketListingStatusSchema,
    unitPriceMinor: EconomyPositiveMinorSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'MarketListingViewV1', additionalProperties: false },
);

export const MarketPurchasePreviewV1Schema = Type.Object(
  {
    buyerTotalMinor: EconomyPositiveMinorSchema,
    currencyId: EconomyUuidSchema,
    feeMinor: EconomyUnsignedMinorSchema,
    grossMinor: EconomyPositiveMinorSchema,
    listingId: EconomyUuidSchema,
    listingVersion: EconomyPositiveVersionSchema,
    quantity: CommercePositiveQuantitySchema,
    quoteHash: EconomyHashSchema,
    sellerNetMinor: EconomyPositiveMinorSchema,
    taxMinor: EconomyUnsignedMinorSchema,
  },
  { $id: 'MarketPurchasePreviewV1', additionalProperties: false },
);

export const MarketTradeViewV1Schema = Type.Object(
  {
    buyerTotalMinor: EconomyPositiveMinorSchema,
    createdTick: EconomyTickSchema,
    feeMinor: EconomyUnsignedMinorSchema,
    grossMinor: EconomyPositiveMinorSchema,
    id: EconomyUuidSchema,
    listingId: EconomyUuidSchema,
    quantity: CommercePositiveQuantitySchema,
    sellerNetMinor: EconomyPositiveMinorSchema,
    taxMinor: EconomyUnsignedMinorSchema,
    unitPriceMinor: EconomyPositiveMinorSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'MarketTradeViewV1', additionalProperties: false },
);

export const TreasurySummaryViewV1Schema = Type.Object(
  {
    balanceMinor: EconomyUnsignedMinorSchema,
    currencyId: EconomyUuidSchema,
    lastRevenueTick: Type.Union([EconomyTickSchema, Type.Null()]),
    noCashValue: Type.Literal(true),
    revenueMinor: EconomyUnsignedMinorSchema,
    treasuryWalletId: EconomyUuidSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'TreasurySummaryViewV1', additionalProperties: false },
);

export const TaxAssessmentViewV1Schema = Type.Object(
  {
    amountMinor: EconomyUnsignedMinorSchema,
    basisMinor: EconomyUnsignedMinorSchema,
    id: EconomyUuidSchema,
    policyId: EconomyUuidSchema,
    sourceId: EconomyUuidSchema,
    sourceType: Type.Union([
      Type.Literal('market_trade'),
      Type.Literal('payroll'),
      Type.Literal('periodic_tax'),
    ]),
    tick: EconomyTickSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'TaxAssessmentViewV1', additionalProperties: false },
);

const CommerceTransactionSummaryBase = {
  currencyId: EconomyUuidSchema,
  id: EconomyUuidSchema,
  occurredTick: EconomyTickSchema,
  worldId: EconomyUuidSchema,
} as const;

export const CommerceTransactionSummaryViewV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...CommerceTransactionSummaryBase,
        buyerTotalMinor: EconomyPositiveMinorSchema,
        feeMinor: EconomyUnsignedMinorSchema,
        grossMinor: EconomyPositiveMinorSchema,
        kind: Type.Literal('market_purchase'),
        marketTradeId: EconomyUuidSchema,
        sellerNetMinor: EconomyPositiveMinorSchema,
        taxMinor: EconomyUnsignedMinorSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...CommerceTransactionSummaryBase,
        grossMinor: EconomyPositiveMinorSchema,
        kind: Type.Literal('payroll'),
        netMinor: EconomyUnsignedMinorSchema,
        payrollRecordId: EconomyUuidSchema,
        taxMinor: EconomyUnsignedMinorSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...CommerceTransactionSummaryBase,
        amountMinor: EconomyPositiveMinorSchema,
        basisMinor: EconomyUnsignedMinorSchema,
        kind: Type.Literal('periodic_tax'),
        taxAssessmentId: EconomyUuidSchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'CommerceTransactionSummaryViewV1' },
);

export const CommerceProjectionMetaV1Schema = Type.Object(
  {
    checkpointVersion: EconomyVersionSchema,
    currentStateRevision: EconomyVersionSchema,
    lagRevisions: EconomyVersionSchema,
    status: Type.Union([
      Type.Literal('current'),
      Type.Literal('catching_up'),
      Type.Literal('mismatch'),
      Type.Literal('failed'),
    ]),
  },
  { additionalProperties: false },
);

function commercePage<T extends TSchema>(item: T, id: string) {
  return Type.Object(
    {
      items: Type.Array(item, { maxItems: 100 }),
      nextCursor: Type.Union([Type.String({ maxLength: 1_024, minLength: 16 }), Type.Null()]),
      projection: CommerceProjectionMetaV1Schema,
    },
    { $id: id, additionalProperties: false },
  );
}

export const ResourceTypePageV1Schema = commercePage(
  ResourceTypeViewV1Schema,
  'ResourceTypePageV1',
);
export const InventoryPageV1Schema = commercePage(InventoryViewV1Schema, 'InventoryPageV1');
export const BusinessPageV1Schema = commercePage(BusinessViewV1Schema, 'BusinessPageV1');
export const ProductionRunPageV1Schema = commercePage(
  ProductionRunViewV1Schema,
  'ProductionRunPageV1',
);
export const EmploymentContractPageV1Schema = commercePage(
  EmploymentContractViewV1Schema,
  'EmploymentContractPageV1',
);
export const MarketListingPageV1Schema = commercePage(
  MarketListingViewV1Schema,
  'MarketListingPageV1',
);
export const MarketTradePageV1Schema = commercePage(MarketTradeViewV1Schema, 'MarketTradePageV1');
export const TaxAssessmentPageV1Schema = commercePage(
  TaxAssessmentViewV1Schema,
  'TaxAssessmentPageV1',
);
export const CommerceTransactionPageV1Schema = commercePage(
  CommerceTransactionSummaryViewV1Schema,
  'CommerceTransactionPageV1',
);

const CommerceEventBase = {
  aggregateVersion: EconomyPositiveVersionSchema,
  tick: EconomyTickSchema,
} as const;

export const WorldCommerceInitializedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    businessCount: Type.Integer({ minimum: 1 }),
    facilityCount: Type.Integer({ minimum: 1 }),
    inventoryCount: Type.Integer({ minimum: 1 }),
    recipeVersionCount: Type.Integer({ minimum: 1 }),
    resourceTypeCount: Type.Integer({ minimum: 1 }),
    seedPlanHash: EconomyHashSchema,
    taxPolicyCount: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const BusinessCreatedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    backingOrganizationEntityId: EconomyUuidSchema,
    businessId: EconomyUuidSchema,
    walletId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const BusinessFacilityConfiguredPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    businessId: EconomyUuidSchema,
    facilityAssetId: EconomyUuidSchema,
    facilityId: EconomyUuidSchema,
    recipeVersionIds: Type.Array(EconomyUuidSchema, { maxItems: 32, minItems: 1 }),
  },
  { additionalProperties: false },
);
export const EmploymentContractLifecyclePayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    businessId: EconomyUuidSchema,
    contractId: EconomyUuidSchema,
    status: EmploymentContractStatusSchema,
    workerEntityId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const WorkRecordedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    contractId: EconomyUuidSchema,
    payrollRecordId: EconomyUuidSchema,
    taxPolicyId: Type.Optional(Type.Union([EconomyUuidSchema, Type.Null()])),
    workRecordId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const PayrollSettledPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    contractId: EconomyUuidSchema,
    financialTransactionId: EconomyUuidSchema,
    grossMinor: EconomyPositiveMinorSchema,
    netMinor: EconomyPositiveMinorSchema,
    payrollRecordId: EconomyUuidSchema,
    taxMinor: EconomyUnsignedMinorSchema,
  },
  { additionalProperties: false },
);
export const PayrollFailedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    contractId: EconomyUuidSchema,
    errorCode: CommerceFailureCodeSchema,
    payrollRecordId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const ProductionRunStartedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    dueTick: EconomyTickSchema,
    productionRunId: EconomyUuidSchema,
    recipeVersionId: EconomyUuidSchema,
    scheduledActionId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const ProductionResourcesPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    productionRunId: EconomyUuidSchema,
    resources: Type.Array(CommerceResourceAmountV1Schema, { maxItems: 32, minItems: 1 }),
  },
  { additionalProperties: false },
);
export const ProductionFailedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    errorCode: CommerceFailureCodeSchema,
    productionRunId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const MarketListingLifecyclePayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    listingId: EconomyUuidSchema,
    remainingQuantity: CommerceQuantitySchema,
    status: MarketListingStatusSchema,
  },
  { additionalProperties: false },
);
export const InventoryTransferredPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    fromInventoryId: EconomyUuidSchema,
    quantity: CommercePositiveQuantitySchema,
    resourceTypeId: EconomyUuidSchema,
    toInventoryId: EconomyUuidSchema,
    tradeId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const MarketTradeCompletedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    buyerTotalMinor: EconomyPositiveMinorSchema,
    feeMinor: EconomyUnsignedMinorSchema,
    grossMinor: EconomyPositiveMinorSchema,
    listingId: EconomyUuidSchema,
    quantity: CommercePositiveQuantitySchema,
    sellerNetMinor: EconomyPositiveMinorSchema,
    taxMinor: EconomyUnsignedMinorSchema,
    tradeId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const TaxAssessedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    amountMinor: EconomyUnsignedMinorSchema,
    assessmentId: EconomyUuidSchema,
    basisMinor: EconomyUnsignedMinorSchema,
    policyId: EconomyUuidSchema,
    sourceId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const TreasuryRevenueRecordedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    amountMinor: EconomyUnsignedMinorSchema,
    assessmentId: EconomyUuidSchema,
    treasuryWalletId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);
export const WorldCommerceReconciledPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    checksum: EconomyHashSchema,
    mismatchCount: Type.Integer({ minimum: 0 }),
    reconciliationRunId: EconomyUuidSchema,
    status: Type.Union([Type.Literal('matched'), Type.Literal('mismatch')]),
  },
  { additionalProperties: false },
);
export const WorldCommerceProjectionRepairedPayloadV1Schema = Type.Object(
  {
    ...CommerceEventBase,
    affectedInventoryCount: Type.Integer({ maximum: 10_000, minimum: 1 }),
    repairFactCount: Type.Integer({ maximum: 10_000, minimum: 1 }),
    repairPlanHash: EconomyHashSchema,
    repairPlanId: EconomyUuidSchema,
    repairedProjectionChecksum: EconomyHashSchema,
    sourceReconciliationRunId: EconomyUuidSchema,
  },
  { $id: 'WorldCommerceProjectionRepairedPayloadV1', additionalProperties: false },
);

const SafeNotificationFields = {
  cursor: EconomyPositiveVersionSchema,
  entityId: EconomyUuidSchema,
  schemaVersion: Type.Literal(1),
  stateRevision: EconomyPositiveVersionSchema,
  worldId: EconomyUuidSchema,
} as const;
export const CommerceNotificationV1Schema = Type.Union(
  [
    Type.Object(
      { ...SafeNotificationFields, type: Type.Literal('economy.inventory.changed') },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...SafeNotificationFields, type: Type.Literal('economy.production.changed') },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...SafeNotificationFields, type: Type.Literal('economy.listing.changed') },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...SafeNotificationFields, type: Type.Literal('economy.trade.completed') },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...SafeNotificationFields, type: Type.Literal('economy.treasury.changed') },
      { additionalProperties: false },
    ),
  ],
  { $id: 'CommerceNotificationV1' },
);

export type ResourceTypeStatus = Static<typeof ResourceTypeStatusSchema>;
export type InventoryReservationPurpose = Static<typeof InventoryReservationPurposeSchema>;
export type InventoryReservationStatus = Static<typeof InventoryReservationStatusSchema>;
export type BusinessStatus = Static<typeof BusinessStatusSchema>;
export type FacilityStatus = Static<typeof FacilityStatusSchema>;
export type ProductionRunStatus = Static<typeof ProductionRunStatusSchema>;
export type EmploymentContractStatus = Static<typeof EmploymentContractStatusSchema>;
export type WageRuleKind = Static<typeof WageRuleKindSchema>;
export type PayrollStatus = Static<typeof PayrollStatusSchema>;
export type MarketListingStatus = Static<typeof MarketListingStatusSchema>;
export type TaxPolicyType = Static<typeof TaxPolicyTypeSchema>;
export type TaxCollectionMode = Static<typeof TaxCollectionModeSchema>;
export type TaxPolicyStatus = Static<typeof TaxPolicyStatusSchema>;
export type InitializeWorldCommercePayloadV1 = Static<
  typeof InitializeWorldCommercePayloadV1Schema
>;
export type CreateBusinessPayloadV1 = Static<typeof CreateBusinessPayloadV1Schema>;
export type ConfigureBusinessFacilityPayloadV1 = Static<
  typeof ConfigureBusinessFacilityPayloadV1Schema
>;
export type CreateEmploymentContractPayloadV1 = Static<
  typeof CreateEmploymentContractPayloadV1Schema
>;
export type AcceptEmploymentContractPayloadV1 = Static<
  typeof AcceptEmploymentContractPayloadV1Schema
>;
export type EndEmploymentContractPayloadV1 = Static<typeof EndEmploymentContractPayloadV1Schema>;
export type PerformJobPayloadV1 = Static<typeof PerformJobPayloadV1Schema>;
export type StartProductionRunPayloadV1 = Static<typeof StartProductionRunPayloadV1Schema>;
export type CreateMarketListingPayloadV1 = Static<typeof CreateMarketListingPayloadV1Schema>;
export type CancelMarketListingPayloadV1 = Static<typeof CancelMarketListingPayloadV1Schema>;
export type PurchaseMarketListingPayloadV1 = Static<typeof PurchaseMarketListingPayloadV1Schema>;
export type ReconcileWorldCommercePayloadV1 = Static<typeof ReconcileWorldCommercePayloadV1Schema>;
export type CommerceProjectionRepairMismatchKind = Static<
  typeof CommerceProjectionRepairMismatchKindSchema
>;
export type CommerceProjectionRepairItemV1 = Static<typeof CommerceProjectionRepairItemV1Schema>;
export type CommerceProjectionRepairPlanBodyV1 = Static<
  typeof CommerceProjectionRepairPlanBodyV1Schema
>;
export type CommerceProjectionRepairPlanV1 = Static<typeof CommerceProjectionRepairPlanV1Schema>;
export type CommerceProjectionRepairApprovalRequestV1 = Static<
  typeof CommerceProjectionRepairApprovalRequestV1Schema
>;
export type CommerceProjectionRepairApprovalV1 = Static<
  typeof CommerceProjectionRepairApprovalV1Schema
>;
export type CommerceProjectionRepairExecutionReceiptV1 = Static<
  typeof CommerceProjectionRepairExecutionReceiptV1Schema
>;
export type RepairEconomicProjectionPayloadV1 = Static<
  typeof RepairEconomicProjectionPayloadV1Schema
>;
export type RepairEconomicProjectionV1 = Static<typeof RepairEconomicProjectionV1Schema>;
export type CompleteProductionRunPayloadV1 = Static<typeof CompleteProductionRunPayloadV1Schema>;
export type SettlePayrollPayloadV1 = Static<typeof SettlePayrollPayloadV1Schema>;
export type ExpireMarketListingPayloadV1 = Static<typeof ExpireMarketListingPayloadV1Schema>;
export type AssessPeriodicTaxPayloadV1 = Static<typeof AssessPeriodicTaxPayloadV1Schema>;
export type ResourceTypeViewV1 = Static<typeof ResourceTypeViewV1Schema>;
export type ProductionRecipeVersionViewV1 = Static<typeof ProductionRecipeVersionViewV1Schema>;
export type InventoryViewV1 = Static<typeof InventoryViewV1Schema>;
export type BusinessViewV1 = Static<typeof BusinessViewV1Schema>;
export type BusinessFacilityViewV1 = Static<typeof BusinessFacilityViewV1Schema>;
export type ProductionRunViewV1 = Static<typeof ProductionRunViewV1Schema>;
export type EmploymentContractViewV1 = Static<typeof EmploymentContractViewV1Schema>;
export type MarketListingViewV1 = Static<typeof MarketListingViewV1Schema>;
export type MarketPurchasePreviewV1 = Static<typeof MarketPurchasePreviewV1Schema>;
export type MarketTradeViewV1 = Static<typeof MarketTradeViewV1Schema>;
export type TreasurySummaryViewV1 = Static<typeof TreasurySummaryViewV1Schema>;
export type TaxAssessmentViewV1 = Static<typeof TaxAssessmentViewV1Schema>;
export type CommerceTransactionSummaryViewV1 = Static<
  typeof CommerceTransactionSummaryViewV1Schema
>;
export type CommerceNotificationV1 = Static<typeof CommerceNotificationV1Schema>;
export type WorldCommerceProjectionRepairedPayloadV1 = Static<
  typeof WorldCommerceProjectionRepairedPayloadV1Schema
>;
