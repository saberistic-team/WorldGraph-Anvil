import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { IdempotencyKeySchema } from './commands.js';
import {
  ASSET_SCHEMA_VERSION,
  ASSET_TRANSFER_OFFER_SCHEMA_VERSION,
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  COMPILER_VERSION,
  CURRENCY_SCHEMA_VERSION,
  ECONOMY_SCHEMA_VERSION,
  ECONOMY_SEED_PLAN_SCHEMA_VERSION,
  FINANCIAL_TRANSACTION_SCHEMA_VERSION,
  LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION,
  LEGACY_COMPILER_VERSION,
  LEGACY_ECONOMY_SEED_PLAN_SCHEMA_VERSION,
  OWNERSHIP_SCHEMA_VERSION,
  PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION,
  PREVIOUS_COMPILER_VERSION,
  PREVIOUS_ECONOMY_RECONCILIATION_SCHEMA_VERSION,
  WALLET_SCHEMA_VERSION,
} from './versions.js';

export const EconomyUuidSchema = Type.String({ format: 'uuid' });
export const EconomyHashSchema = Type.String({
  maxLength: 64,
  minLength: 64,
  pattern: '^[a-f0-9]{64}$',
});
export const EconomyStableKeySchema = Type.String({
  maxLength: 240,
  minLength: 3,
  pattern: '^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$',
});
export const EconomyEntityLogicalKeySchema = EconomyStableKeySchema;
export const EconomyUnsignedMinorSchema = Type.String({
  maxLength: 19,
  pattern: '^(?:0|[1-9][0-9]{0,18})$',
});
export const EconomyPositiveMinorSchema = Type.String({
  maxLength: 19,
  pattern: '^[1-9][0-9]{0,18}$',
});
export const EconomySignedMinorSchema = Type.String({
  maxLength: 20,
  pattern: '^(?:0|-?[1-9][0-9]{0,18})$',
});
export const EconomyCanonicalAmountSchema = Type.String({
  maxLength: 26,
  minLength: 1,
  pattern: '^(?:0|[1-9][0-9]{0,18})(?:\\.[0-9]{1,6})?$',
});
export const EconomyTickSchema = EconomyUnsignedMinorSchema;
export const EconomyVersionSchema = Type.String({
  maxLength: 19,
  pattern: '^(?:0|[1-9][0-9]{0,18})$',
});
export const EconomyPositiveVersionSchema = Type.String({
  maxLength: 19,
  pattern: '^[1-9][0-9]{0,18}$',
});

export const CurrencyStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('frozen'),
  Type.Literal('retired'),
]);
export const WalletKindSchema = Type.Union([
  Type.Literal('player'),
  Type.Literal('organization'),
  Type.Literal('treasury'),
]);
export const WalletStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('frozen'),
  Type.Literal('closed'),
]);
export const FinancialTransactionKindSchema = Type.Union([
  Type.Literal('initialization'),
  Type.Literal('issuance'),
  Type.Literal('transfer'),
  Type.Literal('asset_purchase'),
  Type.Literal('compensation'),
  Type.Literal('market_purchase'),
  Type.Literal('payroll'),
  Type.Literal('periodic_tax'),
]);
export const AssetStatusSchema = Type.Union([Type.Literal('active'), Type.Literal('retired')]);
export const AssetTransferKindSchema = Type.Union([
  Type.Literal('initial'),
  Type.Literal('grant'),
  Type.Literal('purchase'),
  Type.Literal('compensation'),
]);
export const AssetTransferOfferStatusSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('accepted'),
  Type.Literal('cancelled'),
  Type.Literal('expired'),
]);

export const EconomyRepairKindSchema = Type.Union([
  Type.Literal('reverse_financial_transaction'),
  Type.Literal('reverse_asset_transfer'),
  Type.Literal('reverse_asset_purchase'),
]);
export const EconomyRepairReasonCodeSchema = Type.Union([
  Type.Literal('DUPLICATE_EFFECT'),
  Type.Literal('ERRONEOUS_EFFECT'),
  Type.Literal('INCIDENT_RECOVERY'),
]);
export const EconomyRepairApprovalAuthorityKindSchema = Type.Union([
  Type.Literal('creator'),
  Type.Literal('platform_admin'),
]);
export const EconomyRepairCanonicalTimestampSchema = Type.String({
  format: 'date-time',
  maxLength: 24,
  minLength: 24,
  pattern:
    '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$',
});
const EconomyRepairNonZeroSignedMinorSchema = Type.String({
  maxLength: 20,
  pattern: '^-?[1-9][0-9]{0,18}$',
});

export const CurrencyV1Schema = Type.Object(
  {
    cashOutAllowed: Type.Literal(false),
    code: Type.String({ maxLength: 12, minLength: 3, pattern: '^[A-Z][A-Z0-9]{2,11}$' }),
    currencySchemaVersion: Type.Literal(CURRENCY_SCHEMA_VERSION),
    id: EconomyUuidSchema,
    issuerEntityLogicalKey: Type.Union([EconomyEntityLogicalKeySchema, Type.Null()]),
    maxSupplyMinor: Type.Union([EconomyUnsignedMinorSchema, Type.Null()]),
    minorUnitScale: Type.Integer({ maximum: 6, minimum: 0 }),
    name: Type.String({ maxLength: 100, minLength: 1 }),
    noCashValue: Type.Literal(true),
    rowVersion: EconomyPositiveVersionSchema,
    stableKey: EconomyStableKeySchema,
    status: CurrencyStatusSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'CurrencyV1', additionalProperties: false },
);

export const WalletV1Schema = Type.Object(
  {
    currencyId: EconomyUuidSchema,
    id: EconomyUuidSchema,
    ownerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    rowVersion: EconomyPositiveVersionSchema,
    stableKey: EconomyStableKeySchema,
    status: WalletStatusSchema,
    walletKind: WalletKindSchema,
    walletSchemaVersion: Type.Literal(WALLET_SCHEMA_VERSION),
    worldId: EconomyUuidSchema,
  },
  { $id: 'WalletV1', additionalProperties: false },
);

export const WalletBalanceV1Schema = Type.Object(
  {
    availableMinor: EconomyUnsignedMinorSchema,
    rowVersion: EconomyPositiveVersionSchema,
    updatedStateRevision: EconomyVersionSchema,
    walletId: EconomyUuidSchema,
  },
  { $id: 'WalletBalanceV1', additionalProperties: false },
);

export const WalletPostingV1Schema = Type.Object(
  {
    currencyId: EconomyUuidSchema,
    postingOrdinal: Type.Integer({ maximum: 100, minimum: 0 }),
    signedAmountMinor: EconomySignedMinorSchema,
    transactionId: EconomyUuidSchema,
    walletId: EconomyUuidSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'WalletPostingV1', additionalProperties: false },
);

export const FinancialTransactionV1Schema = Type.Object(
  {
    commandId: EconomyUuidSchema,
    currencyId: EconomyUuidSchema,
    financialTransactionSchemaVersion: Type.Literal(FINANCIAL_TRANSACTION_SCHEMA_VERSION),
    id: EconomyUuidSchema,
    kind: FinancialTransactionKindSchema,
    occurredTick: EconomyTickSchema,
    postings: Type.Array(WalletPostingV1Schema, { maxItems: 101, minItems: 1 }),
    stateRevision: EconomyPositiveVersionSchema,
    supplyDeltaMinor: EconomySignedMinorSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'FinancialTransactionV1', additionalProperties: false },
);

export const AssetMetadataV1Schema = Type.Object(
  {
    displayName: Type.String({ maxLength: 100, minLength: 1 }),
    provenance: Type.String({
      maxLength: 80,
      minLength: 3,
      pattern: '^[a-z][a-z0-9._-]*$',
    }),
  },
  { $id: 'AssetMetadataV1', additionalProperties: false },
);

export const AssetV1Schema = Type.Object(
  {
    assetSchemaVersion: Type.Literal(ASSET_SCHEMA_VERSION),
    assetType: Type.String({
      maxLength: 80,
      minLength: 1,
      pattern: '^[a-z][a-z0-9_]*$',
    }),
    id: EconomyUuidSchema,
    metadata: AssetMetadataV1Schema,
    stableKey: EconomyStableKeySchema,
    status: AssetStatusSchema,
    transferable: Type.Boolean(),
    worldEntityLogicalKey: Type.Union([EconomyEntityLogicalKeySchema, Type.Null()]),
    worldId: EconomyUuidSchema,
  },
  { $id: 'AssetV1', additionalProperties: false },
);

export const AssetOwnershipV1Schema = Type.Object(
  {
    acquiredEventId: EconomyUuidSchema,
    assetId: EconomyUuidSchema,
    ownerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    ownershipSchemaVersion: Type.Literal(OWNERSHIP_SCHEMA_VERSION),
    ownershipVersion: EconomyPositiveVersionSchema,
    updatedStateRevision: EconomyPositiveVersionSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'AssetOwnershipV1', additionalProperties: false },
);

export const AssetTransferOfferV1Schema = Type.Object(
  {
    assetId: EconomyUuidSchema,
    buyerEntityLogicalKey: Type.Union([EconomyEntityLogicalKeySchema, Type.Null()]),
    currencyId: EconomyUuidSchema,
    expiresAtTick: EconomyTickSchema,
    id: EconomyUuidSchema,
    offerSchemaVersion: Type.Literal(ASSET_TRANSFER_OFFER_SCHEMA_VERSION),
    priceMinor: EconomyPositiveMinorSchema,
    rowVersion: EconomyPositiveVersionSchema,
    sellerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    sellerWalletId: EconomyUuidSchema,
    status: AssetTransferOfferStatusSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'AssetTransferOfferV1', additionalProperties: false },
);

export const EconomySeedCurrencyV1Schema = Type.Object(
  {
    cashOutAllowed: Type.Literal(false),
    code: Type.String({ maxLength: 12, minLength: 3, pattern: '^[A-Z][A-Z0-9]{2,11}$' }),
    currencySchemaVersion: Type.Literal(CURRENCY_SCHEMA_VERSION),
    issuerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    maxSupplyMinor: EconomyUnsignedMinorSchema,
    minorUnitScale: Type.Integer({ maximum: 6, minimum: 0 }),
    name: Type.String({ maxLength: 100, minLength: 1 }),
    noCashValue: Type.Literal(true),
    stableKey: EconomyStableKeySchema,
  },
  { $id: 'EconomySeedCurrencyV1', additionalProperties: false },
);

export const EconomySeedWalletV1Schema = Type.Object(
  {
    initialBalanceMinor: EconomyUnsignedMinorSchema,
    ownerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    stableKey: EconomyStableKeySchema,
    walletKind: WalletKindSchema,
    walletSchemaVersion: Type.Literal(WALLET_SCHEMA_VERSION),
  },
  { $id: 'EconomySeedWalletV1', additionalProperties: false },
);

export const EconomySeedAssetV1Schema = Type.Object(
  {
    assetSchemaVersion: Type.Literal(ASSET_SCHEMA_VERSION),
    assetType: Type.Literal('founding_seal'),
    initialOwnerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    metadata: Type.Object(
      {
        displayName: Type.Literal('Founding Seal'),
        provenance: Type.Literal('compiler-economy-adapter-v1'),
      },
      { additionalProperties: false },
    ),
    stableKey: Type.Literal('asset:founding-seal'),
    transferable: Type.Literal(true),
    worldEntityLogicalKey: Type.Null(),
  },
  { $id: 'EconomySeedAssetV1', additionalProperties: false },
);

/**
 * Semantic deterministic compiler output. Artifact/adapter provenance is kept
 * beside this document so a reviewed legacy adapter can yield the same plan.
 */
export const EconomySeedPlanV1Schema = Type.Object(
  {
    assets: Type.Array(EconomySeedAssetV1Schema, { maxItems: 1, minItems: 1 }),
    currency: EconomySeedCurrencyV1Schema,
    economySeedPlanSchemaVersion: Type.Literal(LEGACY_ECONOMY_SEED_PLAN_SCHEMA_VERSION),
    initialSupplyMinor: EconomyUnsignedMinorSchema,
    wallets: Type.Array(EconomySeedWalletV1Schema, { maxItems: 101, minItems: 2 }),
  },
  { $id: 'EconomySeedPlanV1', additionalProperties: false },
);

const EconomySeedPrimitiveRefSchema = Type.String({
  maxLength: 64,
  minLength: 1,
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
});
const EconomySeedPrimitiveKeySchema = Type.String({
  maxLength: 160,
  minLength: 3,
  pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$',
});
const EconomySeedSemverSchema = Type.String({
  maxLength: 64,
  minLength: 5,
  pattern:
    '^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
});
const EconomySeedDisplayNameSchema = Type.String({
  maxLength: 100,
  minLength: 1,
  pattern: '^[^\\u0000-\\u001F\\u007F]+$',
});
const EconomySeedPrimitiveProvenanceFields = {
  primitiveContentHash: EconomyHashSchema,
  primitiveKey: EconomySeedPrimitiveKeySchema,
  primitiveRef: EconomySeedPrimitiveRefSchema,
  primitiveVersion: EconomySeedSemverSchema,
  primitiveVersionId: EconomyUuidSchema,
} as const;

export const EconomySeedAssetV2Schema = Type.Object(
  {
    assetSchemaVersion: Type.Literal(ASSET_SCHEMA_VERSION),
    assetType: Type.Union([Type.Literal('founding_seal'), Type.Literal('workshop')]),
    initialOwnerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    metadata: Type.Object(
      {
        displayName: EconomySeedDisplayNameSchema,
        provenance: Type.String({
          maxLength: 80,
          minLength: 3,
          pattern: '^[a-z][a-z0-9._-]*$',
        }),
      },
      { additionalProperties: false },
    ),
    stableKey: EconomyStableKeySchema,
    transferable: Type.Boolean(),
    worldEntityLogicalKey: Type.Union([EconomyEntityLogicalKeySchema, Type.Null()]),
  },
  { $id: 'EconomySeedAssetV2', additionalProperties: false },
);

export const EconomySeedResourceV1Schema = Type.Object(
  {
    displayName: EconomySeedDisplayNameSchema,
    ...EconomySeedPrimitiveProvenanceFields,
    quantityScale: Type.Integer({ maximum: 6, minimum: 0 }),
    resourceSchemaVersion: Type.Literal(1),
    stableKey: EconomyStableKeySchema,
    tags: Type.Array(Type.String({ maxLength: 40, minLength: 1, pattern: '^[a-z0-9-]+$' }), {
      maxItems: 16,
      uniqueItems: true,
    }),
    unit: Type.String({ maxLength: 40, minLength: 1, pattern: '^[a-z][a-z0-9-]*$' }),
  },
  { $id: 'EconomySeedResourceV1', additionalProperties: false },
);

export const EconomySeedRecipeQuantityV1Schema = Type.Object(
  {
    quantity: EconomyCanonicalAmountSchema,
    resourceStableKey: EconomyStableKeySchema,
  },
  { additionalProperties: false },
);

export const EconomySeedRecipeVersionV1Schema = Type.Object(
  {
    checksum: EconomyHashSchema,
    durationTicks: EconomyPositiveMinorSchema,
    facilityAssetType: Type.String({
      maxLength: 80,
      minLength: 1,
      pattern: '^[a-z][a-z0-9_]*$',
    }),
    inputs: Type.Array(EconomySeedRecipeQuantityV1Schema, { maxItems: 16, minItems: 1 }),
    outputs: Type.Array(EconomySeedRecipeQuantityV1Schema, { maxItems: 16, minItems: 1 }),
    ...EconomySeedPrimitiveProvenanceFields,
    recipeVersionSchemaVersion: Type.Literal(1),
    stableKey: EconomyStableKeySchema,
    version: Type.Integer({ maximum: 1_000_000, minimum: 1 }),
  },
  { $id: 'EconomySeedRecipeVersionV1', additionalProperties: false },
);

export const EconomySeedInventoryV1Schema = Type.Object(
  {
    containerAssetStableKey: Type.Union([EconomyStableKeySchema, Type.Null()]),
    inventorySchemaVersion: Type.Literal(1),
    ownerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    quantity: EconomyCanonicalAmountSchema,
    resourceStableKey: EconomyStableKeySchema,
    stableKey: EconomyStableKeySchema,
  },
  { $id: 'EconomySeedInventoryV1', additionalProperties: false },
);

export const EconomySeedBusinessV1Schema = Type.Object(
  {
    businessSchemaVersion: Type.Literal(1),
    displayName: EconomySeedDisplayNameSchema,
    organizationEntityLogicalKey: EconomyEntityLogicalKeySchema,
    stableKey: EconomyStableKeySchema,
    status: Type.Literal('active'),
    walletStableKey: EconomyStableKeySchema,
  },
  { $id: 'EconomySeedBusinessV1', additionalProperties: false },
);

export const EconomySeedFacilityV1Schema = Type.Object(
  {
    assetStableKey: EconomyStableKeySchema,
    businessStableKey: EconomyStableKeySchema,
    facilitySchemaVersion: Type.Literal(1),
    recipeVersionStableKeys: Type.Array(EconomyStableKeySchema, {
      maxItems: 16,
      minItems: 1,
      uniqueItems: true,
    }),
    stableKey: EconomyStableKeySchema,
    status: Type.Literal('active'),
  },
  { $id: 'EconomySeedFacilityV1', additionalProperties: false },
);

export const EconomySeedEmploymentOfferV1Schema = Type.Object(
  {
    businessStableKey: EconomyStableKeySchema,
    cadenceTicks: EconomyPositiveMinorSchema,
    currencyStableKey: EconomyStableKeySchema,
    employmentOfferSchemaVersion: Type.Literal(1),
    maxPaymentsPerPeriod: Type.Integer({ maximum: 1_000, minimum: 1 }),
    roleKey: Type.String({ maxLength: 80, minLength: 1, pattern: '^[a-z][a-z0-9-]*$' }),
    stableKey: EconomyStableKeySchema,
    status: Type.Literal('open'),
    wageMinor: EconomyPositiveMinorSchema,
  },
  { $id: 'EconomySeedEmploymentOfferV1', additionalProperties: false },
);

const EconomySeedTaxPolicyCommonFields = {
  authorityEntityLogicalKey: EconomyEntityLogicalKeySchema,
  effectiveFromTick: EconomyTickSchema,
  effectiveUntilTick: Type.Union([EconomyTickSchema, Type.Null()]),
  ...EconomySeedPrimitiveProvenanceFields,
  roundingMode: Type.Literal('floor'),
  stableKey: EconomyStableKeySchema,
  status: Type.Literal('active'),
  taxPolicySchemaVersion: Type.Literal(1),
  treasuryWalletStableKey: EconomyStableKeySchema,
} as const;

export const EconomySeedTaxPolicyV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...EconomySeedTaxPolicyCommonFields,
        collectionMode: Type.Union([
          Type.Literal('added_to_payer'),
          Type.Literal('withheld_from_recipient'),
        ]),
        rateBps: Type.Integer({ maximum: 5_000, minimum: 0 }),
        taxType: Type.Literal('transaction'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...EconomySeedTaxPolicyCommonFields,
        collectionMode: Type.Union([
          Type.Literal('added_to_payer'),
          Type.Literal('withheld_from_recipient'),
        ]),
        rateBps: Type.Integer({ maximum: 5_000, minimum: 0 }),
        taxType: Type.Literal('sales'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...EconomySeedTaxPolicyCommonFields,
        collectionMode: Type.Literal('withheld_from_recipient'),
        rateBps: Type.Integer({ maximum: 5_000, minimum: 0 }),
        taxType: Type.Literal('payroll'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...EconomySeedTaxPolicyCommonFields,
        collectionMode: Type.Literal('withheld_from_recipient'),
        rateBps: Type.Integer({ maximum: 5_000, minimum: 0 }),
        taxType: Type.Literal('marketplace_fee'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...EconomySeedTaxPolicyCommonFields,
        collectionMode: Type.Literal('added_to_payer'),
        fixedAmountMinor: EconomyPositiveMinorSchema,
        intervalTicks: EconomyPositiveMinorSchema,
        payerEntityLogicalKey: EconomyEntityLogicalKeySchema,
        payerWalletStableKey: EconomyStableKeySchema,
        taxType: Type.Literal('periodic_flat'),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'EconomySeedTaxPolicyV1' },
);

export const EconomySeedTreasuryBindingV1Schema = Type.Object(
  {
    currencyStableKey: EconomyStableKeySchema,
    institutionEntityLogicalKey: EconomyEntityLogicalKeySchema,
    treasuryBindingSchemaVersion: Type.Literal(1),
    walletStableKey: EconomyStableKeySchema,
  },
  { $id: 'EconomySeedTreasuryBindingV1', additionalProperties: false },
);

export const EconomySeedPlanV2Schema = Type.Object(
  {
    assets: Type.Array(EconomySeedAssetV2Schema, { maxItems: 128, minItems: 2 }),
    businesses: Type.Array(EconomySeedBusinessV1Schema, { maxItems: 64, minItems: 1 }),
    currency: EconomySeedCurrencyV1Schema,
    economySeedPlanSchemaVersion: Type.Literal(ECONOMY_SEED_PLAN_SCHEMA_VERSION),
    employmentOffers: Type.Array(EconomySeedEmploymentOfferV1Schema, {
      maxItems: 128,
      minItems: 1,
    }),
    facilities: Type.Array(EconomySeedFacilityV1Schema, { maxItems: 128, minItems: 1 }),
    initialSupplyMinor: EconomyUnsignedMinorSchema,
    inventories: Type.Array(EconomySeedInventoryV1Schema, { maxItems: 512, minItems: 1 }),
    recipeVersions: Type.Array(EconomySeedRecipeVersionV1Schema, {
      maxItems: 64,
      minItems: 1,
    }),
    resources: Type.Array(EconomySeedResourceV1Schema, { maxItems: 64, minItems: 1 }),
    taxPolicies: Type.Array(EconomySeedTaxPolicyV1Schema, { maxItems: 64, minItems: 1 }),
    treasury: EconomySeedTreasuryBindingV1Schema,
    wallets: Type.Array(EconomySeedWalletV1Schema, { maxItems: 256, minItems: 3 }),
  },
  { $id: 'EconomySeedPlanV2', additionalProperties: false },
);

export const EconomySeedPlanSchema = Type.Union(
  [EconomySeedPlanV1Schema, EconomySeedPlanV2Schema],
  {
    $id: 'EconomySeedPlan',
  },
);

export const EconomySeedAdapterIdSchema = Type.Union([
  Type.Literal('CompiledEconomySeedAdapterV2'),
  Type.Literal('CompiledEconomySeedAdapterV1'),
  Type.Literal('LegacyEconomySeedAdapterV1'),
]);
export const EconomySeedAdapterVersionSchema = Type.Literal('1.0.0');
export const EconomySeedSourceV1Schema = Type.Union([
  Type.Object(
    {
      adapterId: Type.Literal('CompiledEconomySeedAdapterV1'),
      adapterVersion: EconomySeedAdapterVersionSchema,
      artifactHash: EconomyHashSchema,
      artifactSchemaVersion: Type.Literal(PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION),
      compilerVersion: Type.Literal(PREVIOUS_COMPILER_VERSION),
      planHash: EconomyHashSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      adapterId: Type.Literal('LegacyEconomySeedAdapterV1'),
      adapterVersion: EconomySeedAdapterVersionSchema,
      artifactHash: EconomyHashSchema,
      artifactSchemaVersion: Type.Literal(LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION),
      compilerVersion: Type.Literal(LEGACY_COMPILER_VERSION),
      planHash: EconomyHashSchema,
    },
    { additionalProperties: false },
  ),
]);

export const EconomySeedSourceV2Schema = Type.Object(
  {
    adapterId: Type.Literal('CompiledEconomySeedAdapterV2'),
    adapterVersion: EconomySeedAdapterVersionSchema,
    artifactHash: EconomyHashSchema,
    artifactSchemaVersion: Type.Literal(COMPILED_ARTIFACT_SCHEMA_VERSION),
    compilerVersion: Type.Literal(COMPILER_VERSION),
    planHash: EconomyHashSchema,
  },
  { $id: 'EconomySeedSourceV2', additionalProperties: false },
);

export const EconomyRepairBalanceDeltaV1Schema = Type.Object(
  {
    balanceAfterMinor: EconomyUnsignedMinorSchema,
    balanceBeforeMinor: EconomyUnsignedMinorSchema,
    balanceVersionAfter: EconomyPositiveVersionSchema,
    balanceVersionBefore: EconomyPositiveVersionSchema,
    compensationSignedAmountMinor: EconomyRepairNonZeroSignedMinorSchema,
    sourcePostingOrdinal: Type.Integer({ maximum: 100, minimum: 0 }),
    sourceSignedAmountMinor: EconomyRepairNonZeroSignedMinorSchema,
    walletId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);

export const EconomyRepairSupplyDeltaV1Schema = Type.Object(
  {
    compensationSupplyDeltaMinor: EconomySignedMinorSchema,
    currencyId: EconomyUuidSchema,
    sourceSupplyDeltaMinor: EconomySignedMinorSchema,
    supplyAfterMinor: EconomyUnsignedMinorSchema,
    supplyBeforeMinor: EconomyUnsignedMinorSchema,
    supplyVersionAfter: EconomyPositiveVersionSchema,
    supplyVersionBefore: EconomyPositiveVersionSchema,
  },
  { additionalProperties: false },
);

export const EconomyRepairFinancialDeltaV1Schema = Type.Object(
  {
    compensationTransactionId: EconomyUuidSchema,
    currencyId: EconomyUuidSchema,
    postings: Type.Array(EconomyRepairBalanceDeltaV1Schema, { maxItems: 2, minItems: 1 }),
    reversalOfTransactionId: EconomyUuidSchema,
    supply: EconomyRepairSupplyDeltaV1Schema,
  },
  { additionalProperties: false },
);

export const EconomyRepairTitleDeltaV1Schema = Type.Object(
  {
    assetId: EconomyUuidSchema,
    compensationTransferId: EconomyUuidSchema,
    fromOwnerEntityId: EconomyUuidSchema,
    ownershipVersionAfter: EconomyPositiveVersionSchema,
    ownershipVersionBefore: EconomyPositiveVersionSchema,
    reversalOfTransferId: EconomyUuidSchema,
    toOwnerEntityId: EconomyUuidSchema,
  },
  { additionalProperties: false },
);

export const EconomyRepairDeltaV1Schema = Type.Union(
  [
    Type.Object(
      {
        financialDelta: EconomyRepairFinancialDeltaV1Schema,
        repairKind: Type.Literal('reverse_financial_transaction'),
        titleDelta: Type.Null(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        financialDelta: Type.Null(),
        repairKind: Type.Literal('reverse_asset_transfer'),
        titleDelta: EconomyRepairTitleDeltaV1Schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        financialDelta: EconomyRepairFinancialDeltaV1Schema,
        repairKind: Type.Literal('reverse_asset_purchase'),
        titleDelta: EconomyRepairTitleDeltaV1Schema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'EconomyRepairDeltaV1' },
);

const EconomyRepairReasonSchema = Type.String({
  maxLength: 500,
  minLength: 8,
  pattern: '^(?! )(?!.* $)[^\\u0000-\\u001F\\u007F-\\u009F]+$',
});
const EconomyRepairPlanBodyFields = {
  delta: EconomyRepairDeltaV1Schema,
  domain: Type.Literal('worldgraph.economy-repair-plan.v1'),
  expiresAt: EconomyRepairCanonicalTimestampSchema,
  incidentReason: EconomyRepairReasonSchema,
  pitrNotUsedReason: EconomyRepairReasonSchema,
  preparedAt: EconomyRepairCanonicalTimestampSchema,
  preparedByUserId: EconomyUuidSchema,
  reasonCode: EconomyRepairReasonCodeSchema,
  repairKind: EconomyRepairKindSchema,
  repairPlanId: EconomyUuidSchema,
  repairPlanSchemaVersion: Type.Literal(1),
  reservedCommandId: EconomyUuidSchema,
  sourceCommandId: EconomyUuidSchema,
  sourceEconomyChecksum: EconomyHashSchema,
  sourceEconomyHeadVersion: EconomyPositiveVersionSchema,
  sourceEventSequence: EconomyPositiveVersionSchema,
  sourceReconciliationRunId: EconomyUuidSchema,
  sourceStateRevision: EconomyVersionSchema,
  sourceWorldVersion: EconomyPositiveVersionSchema,
  worldId: EconomyUuidSchema,
} as const;

export const EconomyRepairPlanBodyV1Schema = Type.Object(EconomyRepairPlanBodyFields, {
  $id: 'EconomyRepairPlanBodyV1',
  additionalProperties: false,
});
export const EconomyRepairPlanV1Schema = Type.Object(
  { ...EconomyRepairPlanBodyFields, planHash: EconomyHashSchema },
  { $id: 'EconomyRepairPlanV1', additionalProperties: false },
);

export const EconomyRepairApprovalRequestV1Schema = Type.Object(
  {
    approvalId: EconomyUuidSchema,
    authorityKind: EconomyRepairApprovalAuthorityKindSchema,
    confirmation: Type.Literal('APPROVE APPEND-ONLY ECONOMY REPAIR'),
    planHash: EconomyHashSchema,
  },
  { $id: 'EconomyRepairApprovalRequestV1', additionalProperties: false },
);
export const EconomyRepairApprovalV1Schema = Type.Union(
  [
    Type.Object(
      {
        approvalId: EconomyUuidSchema,
        approvedAt: EconomyRepairCanonicalTimestampSchema,
        approverUserId: EconomyUuidSchema,
        authorityKind: Type.Literal('creator'),
        creatorOverrideId: EconomyUuidSchema,
        planHash: EconomyHashSchema,
        repairPlanId: EconomyUuidSchema,
        worldId: EconomyUuidSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        approvalId: EconomyUuidSchema,
        approvedAt: EconomyRepairCanonicalTimestampSchema,
        approverUserId: EconomyUuidSchema,
        authorityKind: Type.Literal('platform_admin'),
        creatorOverrideId: Type.Null(),
        planHash: EconomyHashSchema,
        repairPlanId: EconomyUuidSchema,
        worldId: EconomyUuidSchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'EconomyRepairApprovalV1' },
);

const EconomyCommandCommonFields = {
  commandId: EconomyUuidSchema,
  expectedAggregateVersion: EconomyVersionSchema,
  expectedStateRevision: EconomyVersionSchema,
  expectedWorldVersion: EconomyPositiveVersionSchema,
  idempotencyKey: IdempotencyKeySchema,
  schemaVersion: Type.Literal(ECONOMY_SCHEMA_VERSION),
} as const;

function economyCommand<TType extends string, TPayload extends TSchema>(
  type: TType,
  payload: TPayload,
) {
  return Type.Object(
    { ...EconomyCommandCommonFields, payload, type: Type.Literal(type) },
    { additionalProperties: false },
  );
}

export const InitializeWorldEconomyPayloadV1Schema = Type.Object(
  {
    compiledWorldVersionId: EconomyUuidSchema,
    seedPlanHash: EconomyHashSchema,
  },
  { $id: 'InitializeWorldEconomyPayloadV1', additionalProperties: false },
);
export const InitializeWorldEconomyV1Schema = economyCommand(
  'InitializeWorldEconomyV1',
  InitializeWorldEconomyPayloadV1Schema,
);

export const AdoptLegacyEconomySeedPlanPayloadV1Schema = Type.Object(
  {
    adapterId: Type.Literal('LegacyEconomySeedAdapterV1'),
    adapterVersion: EconomySeedAdapterVersionSchema,
    compiledWorldVersionId: EconomyUuidSchema,
    legacyArtifactHash: EconomyHashSchema,
    legacyArtifactSchemaVersion: Type.Literal(LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION),
    legacyCompilerVersion: Type.Literal(LEGACY_COMPILER_VERSION),
    seedPlan: EconomySeedPlanV1Schema,
    seedPlanHash: EconomyHashSchema,
  },
  { $id: 'AdoptLegacyEconomySeedPlanPayloadV1', additionalProperties: false },
);
export const AdoptLegacyEconomySeedPlanV1Schema = economyCommand(
  'AdoptLegacyEconomySeedPlanV1',
  AdoptLegacyEconomySeedPlanPayloadV1Schema,
);

export const TransferCurrencyPayloadV1Schema = Type.Object(
  {
    amount: EconomyCanonicalAmountSchema,
    destinationWalletId: EconomyUuidSchema,
    expectedDestinationVersion: EconomyPositiveVersionSchema,
    expectedSourceVersion: EconomyPositiveVersionSchema,
    memo: Type.Optional(Type.String({ maxLength: 160, minLength: 1 })),
    sourceWalletId: EconomyUuidSchema,
  },
  { $id: 'TransferCurrencyPayloadV1', additionalProperties: false },
);
export const TransferCurrencyV1Schema = economyCommand(
  'TransferCurrencyV1',
  TransferCurrencyPayloadV1Schema,
);

export const IssueCurrencyPayloadV1Schema = Type.Object(
  {
    amount: EconomyCanonicalAmountSchema,
    confirmation: Type.Literal('ISSUE VIRTUAL CURRENCY'),
    expectedSupplyVersion: EconomyPositiveVersionSchema,
    reason: Type.String({ maxLength: 240, minLength: 8 }),
    treasuryWalletId: EconomyUuidSchema,
  },
  { $id: 'IssueCurrencyPayloadV1', additionalProperties: false },
);
export const IssueCurrencyV1Schema = economyCommand(
  'IssueCurrencyV1',
  IssueCurrencyPayloadV1Schema,
);

const CurrencyStatusCommandPayloadFields = {
  currencyId: EconomyUuidSchema,
  expectedCurrencyVersion: EconomyPositiveVersionSchema,
  reason: Type.String({ maxLength: 240, minLength: 8 }),
} as const;
export const FreezeCurrencyPayloadV1Schema = Type.Object(CurrencyStatusCommandPayloadFields, {
  $id: 'FreezeCurrencyPayloadV1',
  additionalProperties: false,
});
export const UnfreezeCurrencyPayloadV1Schema = Type.Object(CurrencyStatusCommandPayloadFields, {
  $id: 'UnfreezeCurrencyPayloadV1',
  additionalProperties: false,
});
export const FreezeCurrencyV1Schema = economyCommand(
  'FreezeCurrencyV1',
  FreezeCurrencyPayloadV1Schema,
);
export const UnfreezeCurrencyV1Schema = economyCommand(
  'UnfreezeCurrencyV1',
  UnfreezeCurrencyPayloadV1Schema,
);

const WalletStatusCommandPayloadFields = {
  expectedWalletVersion: EconomyPositiveVersionSchema,
  reason: Type.String({ maxLength: 240, minLength: 8 }),
  walletId: EconomyUuidSchema,
} as const;
export const FreezeWalletPayloadV1Schema = Type.Object(WalletStatusCommandPayloadFields, {
  $id: 'FreezeWalletPayloadV1',
  additionalProperties: false,
});
export const UnfreezeWalletPayloadV1Schema = Type.Object(WalletStatusCommandPayloadFields, {
  $id: 'UnfreezeWalletPayloadV1',
  additionalProperties: false,
});
export const FreezeWalletV1Schema = economyCommand('FreezeWalletV1', FreezeWalletPayloadV1Schema);
export const UnfreezeWalletV1Schema = economyCommand(
  'UnfreezeWalletV1',
  UnfreezeWalletPayloadV1Schema,
);

export const TransferAssetPayloadV1Schema = Type.Object(
  {
    assetKey: EconomyStableKeySchema,
    expectedOwnershipVersion: EconomyPositiveVersionSchema,
    toOwnerEntityKey: EconomyEntityLogicalKeySchema,
  },
  { $id: 'TransferAssetPayloadV1', additionalProperties: false },
);
export const TransferAssetV1Schema = economyCommand(
  'TransferAssetV1',
  TransferAssetPayloadV1Schema,
);

export const CreateAssetTransferOfferPayloadV1Schema = Type.Object(
  {
    assetKey: EconomyStableKeySchema,
    buyerEntityKey: Type.Union([EconomyEntityLogicalKeySchema, Type.Null()]),
    currencyId: EconomyUuidSchema,
    expectedOwnershipVersion: EconomyPositiveVersionSchema,
    expiresAtTick: EconomyTickSchema,
    price: EconomyCanonicalAmountSchema,
    sellerWalletId: EconomyUuidSchema,
  },
  { $id: 'CreateAssetTransferOfferPayloadV1', additionalProperties: false },
);
export const CreateAssetTransferOfferV1Schema = economyCommand(
  'CreateAssetTransferOfferV1',
  CreateAssetTransferOfferPayloadV1Schema,
);

export const CancelAssetTransferOfferPayloadV1Schema = Type.Object(
  {
    expectedOfferVersion: EconomyPositiveVersionSchema,
    offerId: EconomyUuidSchema,
  },
  { $id: 'CancelAssetTransferOfferPayloadV1', additionalProperties: false },
);
export const CancelAssetTransferOfferV1Schema = economyCommand(
  'CancelAssetTransferOfferV1',
  CancelAssetTransferOfferPayloadV1Schema,
);

export const AcceptAssetTransferOfferPayloadV1Schema = Type.Object(
  {
    buyerWalletId: EconomyUuidSchema,
    expectedBuyerWalletVersion: EconomyPositiveVersionSchema,
    expectedOfferVersion: EconomyPositiveVersionSchema,
    expectedOwnershipVersion: EconomyPositiveVersionSchema,
    expectedSellerWalletVersion: EconomyPositiveVersionSchema,
    offerId: EconomyUuidSchema,
    sellerWalletId: EconomyUuidSchema,
  },
  { $id: 'AcceptAssetTransferOfferPayloadV1', additionalProperties: false },
);
export const AcceptAssetTransferOfferV1Schema = economyCommand(
  'AcceptAssetTransferOfferV1',
  AcceptAssetTransferOfferPayloadV1Schema,
);

export const ReconcileWorldEconomyPayloadV1Schema = Type.Object(
  { expectedEconomyHeadVersion: EconomyPositiveVersionSchema },
  { $id: 'ReconcileWorldEconomyPayloadV1', additionalProperties: false },
);
export const ReconcileWorldEconomyV1Schema = economyCommand(
  'ReconcileWorldEconomyV1',
  ReconcileWorldEconomyPayloadV1Schema,
);

/** Owner/operator-only command. Public command transports must reject this type. */
export const RepairWorldEconomyPayloadV1Schema = Type.Object(
  {
    confirmation: Type.Literal('APPLY APPEND-ONLY ECONOMY REPAIR'),
    repairPlanHash: EconomyHashSchema,
    repairPlanId: EconomyUuidSchema,
    sourceCommandId: EconomyUuidSchema,
  },
  { $id: 'RepairWorldEconomyPayloadV1', additionalProperties: false },
);
export const RepairWorldEconomyV1Schema = economyCommand(
  'RepairWorldEconomyV1',
  RepairWorldEconomyPayloadV1Schema,
);

/** Server/scheduler-only command. Public transports must reject this type. */
export const ExpireAssetTransferOfferPayloadV1Schema = Type.Object(
  {
    expectedOfferVersion: EconomyPositiveVersionSchema,
    expectedTick: EconomyTickSchema,
    offerId: EconomyUuidSchema,
  },
  { $id: 'ExpireAssetTransferOfferPayloadV1', additionalProperties: false },
);
export const ExpireAssetTransferOfferV1Schema = economyCommand(
  'ExpireAssetTransferOfferV1',
  ExpireAssetTransferOfferPayloadV1Schema,
);

export const PublicEconomyCommandRequestV1Schema = Type.Union(
  [
    InitializeWorldEconomyV1Schema,
    AdoptLegacyEconomySeedPlanV1Schema,
    TransferCurrencyV1Schema,
    IssueCurrencyV1Schema,
    FreezeCurrencyV1Schema,
    UnfreezeCurrencyV1Schema,
    FreezeWalletV1Schema,
    UnfreezeWalletV1Schema,
    TransferAssetV1Schema,
    CreateAssetTransferOfferV1Schema,
    CancelAssetTransferOfferV1Schema,
    AcceptAssetTransferOfferV1Schema,
    ReconcileWorldEconomyV1Schema,
  ],
  { $id: 'PublicEconomyCommandRequestV1' },
);
export const EconomyCommandRequestV1Schema = Type.Union(
  [
    PublicEconomyCommandRequestV1Schema,
    ExpireAssetTransferOfferV1Schema,
    RepairWorldEconomyV1Schema,
  ],
  { $id: 'EconomyCommandRequestV1' },
);

export const LegacyEconomySeedPlanAdoptedPayloadV1Schema = Type.Object(
  {
    adapterId: Type.Literal('LegacyEconomySeedAdapterV1'),
    adapterVersion: EconomySeedAdapterVersionSchema,
    compiledWorldVersionId: EconomyUuidSchema,
    legacyArtifactHash: EconomyHashSchema,
    legacyArtifactSchemaVersion: Type.Literal(LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION),
    legacyCompilerVersion: Type.Literal(LEGACY_COMPILER_VERSION),
    seedPlanHash: EconomyHashSchema,
  },
  { $id: 'LegacyEconomySeedPlanAdoptedPayloadV1', additionalProperties: false },
);

export const WorldEconomyInitializedPayloadV1Schema = Type.Object(
  {
    assetCount: EconomyUnsignedMinorSchema,
    compiledWorldVersionId: EconomyUuidSchema,
    currencyId: EconomyUuidSchema,
    initialSupplyMinor: EconomyUnsignedMinorSchema,
    initializationTransactionId: EconomyUuidSchema,
    ownershipCount: EconomyUnsignedMinorSchema,
    seedPlanSchemaVersion: Type.Union([
      Type.Literal(LEGACY_ECONOMY_SEED_PLAN_SCHEMA_VERSION),
      Type.Literal(ECONOMY_SEED_PLAN_SCHEMA_VERSION),
    ]),
    seedPlanHash: EconomyHashSchema,
    walletCount: EconomyUnsignedMinorSchema,
  },
  { $id: 'WorldEconomyInitializedPayloadV1', additionalProperties: false },
);
export const WorldEconomyReconciledPayloadV1Schema = Type.Object(
  {
    checkedStateRevision: EconomyVersionSchema,
    liveProjectionChecksum: EconomyHashSchema,
    mismatchCount: EconomyUnsignedMinorSchema,
    rebuiltJournalChecksum: EconomyHashSchema,
    runId: EconomyUuidSchema,
    status: Type.Union([Type.Literal('matched'), Type.Literal('mismatched')]),
  },
  { $id: 'WorldEconomyReconciledPayloadV1', additionalProperties: false },
);
const WorldEconomyRepairedPayloadCommonFields = {
  reasonCode: EconomyRepairReasonCodeSchema,
  repairPlanHash: EconomyHashSchema,
  repairPlanId: EconomyUuidSchema,
  sourceCommandId: EconomyUuidSchema,
} as const;
export const WorldEconomyRepairedPayloadV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...WorldEconomyRepairedPayloadCommonFields,
        compensationTransactionId: EconomyUuidSchema,
        compensationTransferId: Type.Null(),
        repairKind: Type.Literal('reverse_financial_transaction'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...WorldEconomyRepairedPayloadCommonFields,
        compensationTransactionId: Type.Null(),
        compensationTransferId: EconomyUuidSchema,
        repairKind: Type.Literal('reverse_asset_transfer'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...WorldEconomyRepairedPayloadCommonFields,
        compensationTransactionId: EconomyUuidSchema,
        compensationTransferId: EconomyUuidSchema,
        repairKind: Type.Literal('reverse_asset_purchase'),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'WorldEconomyRepairedPayloadV1' },
);
export const CurrencyIssuedPayloadV1Schema = Type.Object(
  {
    amountMinor: EconomyPositiveMinorSchema,
    currencyId: EconomyUuidSchema,
    reason: Type.String({ maxLength: 240, minLength: 8 }),
    resultingSupplyMinor: EconomyUnsignedMinorSchema,
    transactionId: EconomyUuidSchema,
    treasuryWalletId: EconomyUuidSchema,
  },
  { $id: 'CurrencyIssuedPayloadV1', additionalProperties: false },
);
export const CurrencyTransferredPayloadV1Schema = Type.Object(
  {
    amountMinor: EconomyPositiveMinorSchema,
    currencyId: EconomyUuidSchema,
    destinationWalletId: EconomyUuidSchema,
    sourceWalletId: EconomyUuidSchema,
    transactionId: EconomyUuidSchema,
  },
  { $id: 'CurrencyTransferredPayloadV1', additionalProperties: false },
);

const CurrencyStatusEventPayloadFields = {
  currencyId: EconomyUuidSchema,
  currencyVersion: EconomyPositiveVersionSchema,
  reason: Type.String({ maxLength: 240, minLength: 8 }),
} as const;
export const CurrencyFrozenPayloadV1Schema = Type.Object(CurrencyStatusEventPayloadFields, {
  $id: 'CurrencyFrozenPayloadV1',
  additionalProperties: false,
});
export const CurrencyUnfrozenPayloadV1Schema = Type.Object(CurrencyStatusEventPayloadFields, {
  $id: 'CurrencyUnfrozenPayloadV1',
  additionalProperties: false,
});
const WalletStatusEventPayloadFields = {
  reason: Type.String({ maxLength: 240, minLength: 8 }),
  walletId: EconomyUuidSchema,
  walletVersion: EconomyPositiveVersionSchema,
} as const;
export const WalletFrozenPayloadV1Schema = Type.Object(WalletStatusEventPayloadFields, {
  $id: 'WalletFrozenPayloadV1',
  additionalProperties: false,
});
export const WalletUnfrozenPayloadV1Schema = Type.Object(WalletStatusEventPayloadFields, {
  $id: 'WalletUnfrozenPayloadV1',
  additionalProperties: false,
});

export const AssetOwnershipTransferredPayloadV1Schema = Type.Object(
  {
    assetId: EconomyUuidSchema,
    assetKey: EconomyStableKeySchema,
    financialTransactionId: Type.Union([EconomyUuidSchema, Type.Null()]),
    fromOwnerEntityLogicalKey: Type.Union([EconomyEntityLogicalKeySchema, Type.Null()]),
    ownershipVersion: EconomyPositiveVersionSchema,
    toOwnerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    transferKind: AssetTransferKindSchema,
  },
  { $id: 'AssetOwnershipTransferredPayloadV1', additionalProperties: false },
);
export const AssetTransferOfferCreatedPayloadV1Schema = Type.Object(
  {
    assetId: EconomyUuidSchema,
    buyerEntityLogicalKey: Type.Union([EconomyEntityLogicalKeySchema, Type.Null()]),
    currencyId: EconomyUuidSchema,
    expiresAtTick: EconomyTickSchema,
    offerId: EconomyUuidSchema,
    priceMinor: EconomyPositiveMinorSchema,
    sellerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    sellerWalletId: EconomyUuidSchema,
  },
  { $id: 'AssetTransferOfferCreatedPayloadV1', additionalProperties: false },
);
export const AssetTransferOfferCancelledPayloadV1Schema = Type.Object(
  {
    offerId: EconomyUuidSchema,
    offerVersion: EconomyPositiveVersionSchema,
  },
  { $id: 'AssetTransferOfferCancelledPayloadV1', additionalProperties: false },
);
export const AssetTransferOfferAcceptedPayloadV1Schema = Type.Object(
  {
    buyerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    offerId: EconomyUuidSchema,
    offerVersion: EconomyPositiveVersionSchema,
    sellerEntityLogicalKey: EconomyEntityLogicalKeySchema,
  },
  { $id: 'AssetTransferOfferAcceptedPayloadV1', additionalProperties: false },
);
export const AssetTransferOfferExpiredPayloadV1Schema = Type.Object(
  {
    expiredAtTick: EconomyTickSchema,
    offerId: EconomyUuidSchema,
    offerVersion: EconomyPositiveVersionSchema,
  },
  { $id: 'AssetTransferOfferExpiredPayloadV1', additionalProperties: false },
);
export const AssetPurchasedPayloadV1Schema = Type.Object(
  {
    assetId: EconomyUuidSchema,
    buyerEntityLogicalKey: EconomyEntityLogicalKeySchema,
    financialTransactionId: EconomyUuidSchema,
    offerId: EconomyUuidSchema,
    priceMinor: EconomyPositiveMinorSchema,
    sellerEntityLogicalKey: EconomyEntityLogicalKeySchema,
  },
  { $id: 'AssetPurchasedPayloadV1', additionalProperties: false },
);

export const EconomyReconciliationMismatchV1Schema = Type.Object(
  {
    actual: Type.Union([EconomySignedMinorSchema, EconomyHashSchema, Type.Null()]),
    expected: Type.Union([EconomySignedMinorSchema, EconomyHashSchema, Type.Null()]),
    key: Type.String({ maxLength: 240, minLength: 1 }),
    kind: Type.Union([
      Type.Literal('wallet_balance'),
      Type.Literal('currency_supply'),
      Type.Literal('asset_ownership'),
    ]),
  },
  { additionalProperties: false },
);
export const EconomyReconciliationDocumentV1Schema = Type.Object(
  {
    domain: Type.Literal('worldgraph.economy-reconciliation.v1'),
    economyReconciliationSchemaVersion: Type.Literal(
      PREVIOUS_ECONOMY_RECONCILIATION_SCHEMA_VERSION,
    ),
    ownership: Type.Array(
      Type.Object(
        {
          assetKey: EconomyStableKeySchema,
          ownerEntityLogicalKey: EconomyEntityLogicalKeySchema,
          ownershipVersion: EconomyPositiveVersionSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    supply: Type.Array(
      Type.Object(
        {
          currencyKey: EconomyStableKeySchema,
          currentSupplyMinor: EconomyUnsignedMinorSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    wallets: Type.Array(
      Type.Object(
        {
          availableMinor: EconomyUnsignedMinorSchema,
          walletId: EconomyUuidSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100_000 },
    ),
  },
  { $id: 'EconomyReconciliationDocumentV1', additionalProperties: false },
);
export const EconomyReconciliationReportV1Schema = Type.Object(
  {
    checkedStateRevision: EconomyVersionSchema,
    economyReconciliationSchemaVersion: Type.Literal(
      PREVIOUS_ECONOMY_RECONCILIATION_SCHEMA_VERSION,
    ),
    liveProjectionChecksum: EconomyHashSchema,
    mismatches: Type.Array(EconomyReconciliationMismatchV1Schema, { maxItems: 1_000 }),
    rebuiltJournalChecksum: EconomyHashSchema,
    runId: EconomyUuidSchema,
    status: Type.Union([Type.Literal('matched'), Type.Literal('mismatched')]),
    worldId: EconomyUuidSchema,
  },
  { $id: 'EconomyReconciliationReportV1', additionalProperties: false },
);

export type CurrencyStatus = Static<typeof CurrencyStatusSchema>;
export type WalletKind = Static<typeof WalletKindSchema>;
export type WalletStatus = Static<typeof WalletStatusSchema>;
export type FinancialTransactionKind = Static<typeof FinancialTransactionKindSchema>;
export type AssetStatus = Static<typeof AssetStatusSchema>;
export type AssetTransferKind = Static<typeof AssetTransferKindSchema>;
export type AssetTransferOfferStatus = Static<typeof AssetTransferOfferStatusSchema>;
export type EconomyRepairKind = Static<typeof EconomyRepairKindSchema>;
export type EconomyRepairReasonCode = Static<typeof EconomyRepairReasonCodeSchema>;
export type EconomyRepairApprovalAuthorityKind = Static<
  typeof EconomyRepairApprovalAuthorityKindSchema
>;
export type CurrencyV1 = Static<typeof CurrencyV1Schema>;
export type WalletV1 = Static<typeof WalletV1Schema>;
export type WalletBalanceV1 = Static<typeof WalletBalanceV1Schema>;
export type WalletPostingV1 = Static<typeof WalletPostingV1Schema>;
export type FinancialTransactionV1 = Static<typeof FinancialTransactionV1Schema>;
export type AssetMetadataV1 = Static<typeof AssetMetadataV1Schema>;
export type AssetV1 = Static<typeof AssetV1Schema>;
export type AssetOwnershipV1 = Static<typeof AssetOwnershipV1Schema>;
export type AssetTransferOfferV1 = Static<typeof AssetTransferOfferV1Schema>;
export type EconomySeedCurrencyV1 = Static<typeof EconomySeedCurrencyV1Schema>;
export type EconomySeedWalletV1 = Static<typeof EconomySeedWalletV1Schema>;
export type EconomySeedAssetV1 = Static<typeof EconomySeedAssetV1Schema>;
export type EconomySeedPlanV1 = Static<typeof EconomySeedPlanV1Schema>;
export type EconomySeedAssetV2 = Static<typeof EconomySeedAssetV2Schema>;
export type EconomySeedResourceV1 = Static<typeof EconomySeedResourceV1Schema>;
export type EconomySeedRecipeQuantityV1 = Static<typeof EconomySeedRecipeQuantityV1Schema>;
export type EconomySeedRecipeVersionV1 = Static<typeof EconomySeedRecipeVersionV1Schema>;
export type EconomySeedInventoryV1 = Static<typeof EconomySeedInventoryV1Schema>;
export type EconomySeedBusinessV1 = Static<typeof EconomySeedBusinessV1Schema>;
export type EconomySeedFacilityV1 = Static<typeof EconomySeedFacilityV1Schema>;
export type EconomySeedEmploymentOfferV1 = Static<typeof EconomySeedEmploymentOfferV1Schema>;
export type EconomySeedTaxPolicyV1 = Static<typeof EconomySeedTaxPolicyV1Schema>;
export type EconomySeedTreasuryBindingV1 = Static<typeof EconomySeedTreasuryBindingV1Schema>;
export type EconomySeedPlanV2 = Static<typeof EconomySeedPlanV2Schema>;
export type EconomySeedPlan = Static<typeof EconomySeedPlanSchema>;
export type EconomySeedSourceV1 = Static<typeof EconomySeedSourceV1Schema>;
export type EconomySeedSourceV2 = Static<typeof EconomySeedSourceV2Schema>;
export type EconomyRepairBalanceDeltaV1 = Static<typeof EconomyRepairBalanceDeltaV1Schema>;
export type EconomyRepairSupplyDeltaV1 = Static<typeof EconomyRepairSupplyDeltaV1Schema>;
export type EconomyRepairFinancialDeltaV1 = Static<typeof EconomyRepairFinancialDeltaV1Schema>;
export type EconomyRepairTitleDeltaV1 = Static<typeof EconomyRepairTitleDeltaV1Schema>;
export type EconomyRepairDeltaV1 = Static<typeof EconomyRepairDeltaV1Schema>;
export type EconomyRepairPlanBodyV1 = Static<typeof EconomyRepairPlanBodyV1Schema>;
export type EconomyRepairPlanV1 = Static<typeof EconomyRepairPlanV1Schema>;
export type EconomyRepairApprovalRequestV1 = Static<typeof EconomyRepairApprovalRequestV1Schema>;
export type EconomyRepairApprovalV1 = Static<typeof EconomyRepairApprovalV1Schema>;
export type InitializeWorldEconomyPayloadV1 = Static<typeof InitializeWorldEconomyPayloadV1Schema>;
export type InitializeWorldEconomyV1 = Static<typeof InitializeWorldEconomyV1Schema>;
export type AdoptLegacyEconomySeedPlanPayloadV1 = Static<
  typeof AdoptLegacyEconomySeedPlanPayloadV1Schema
>;
export type AdoptLegacyEconomySeedPlanV1 = Static<typeof AdoptLegacyEconomySeedPlanV1Schema>;
export type TransferCurrencyPayloadV1 = Static<typeof TransferCurrencyPayloadV1Schema>;
export type TransferCurrencyV1 = Static<typeof TransferCurrencyV1Schema>;
export type IssueCurrencyPayloadV1 = Static<typeof IssueCurrencyPayloadV1Schema>;
export type IssueCurrencyV1 = Static<typeof IssueCurrencyV1Schema>;
export type FreezeCurrencyPayloadV1 = Static<typeof FreezeCurrencyPayloadV1Schema>;
export type FreezeCurrencyV1 = Static<typeof FreezeCurrencyV1Schema>;
export type UnfreezeCurrencyPayloadV1 = Static<typeof UnfreezeCurrencyPayloadV1Schema>;
export type UnfreezeCurrencyV1 = Static<typeof UnfreezeCurrencyV1Schema>;
export type FreezeWalletPayloadV1 = Static<typeof FreezeWalletPayloadV1Schema>;
export type FreezeWalletV1 = Static<typeof FreezeWalletV1Schema>;
export type UnfreezeWalletPayloadV1 = Static<typeof UnfreezeWalletPayloadV1Schema>;
export type UnfreezeWalletV1 = Static<typeof UnfreezeWalletV1Schema>;
export type TransferAssetPayloadV1 = Static<typeof TransferAssetPayloadV1Schema>;
export type TransferAssetV1 = Static<typeof TransferAssetV1Schema>;
export type CreateAssetTransferOfferPayloadV1 = Static<
  typeof CreateAssetTransferOfferPayloadV1Schema
>;
export type CreateAssetTransferOfferV1 = Static<typeof CreateAssetTransferOfferV1Schema>;
export type CancelAssetTransferOfferPayloadV1 = Static<
  typeof CancelAssetTransferOfferPayloadV1Schema
>;
export type CancelAssetTransferOfferV1 = Static<typeof CancelAssetTransferOfferV1Schema>;
export type AcceptAssetTransferOfferPayloadV1 = Static<
  typeof AcceptAssetTransferOfferPayloadV1Schema
>;
export type AcceptAssetTransferOfferV1 = Static<typeof AcceptAssetTransferOfferV1Schema>;
export type ReconcileWorldEconomyPayloadV1 = Static<typeof ReconcileWorldEconomyPayloadV1Schema>;
export type ReconcileWorldEconomyV1 = Static<typeof ReconcileWorldEconomyV1Schema>;
export type RepairWorldEconomyPayloadV1 = Static<typeof RepairWorldEconomyPayloadV1Schema>;
export type RepairWorldEconomyV1 = Static<typeof RepairWorldEconomyV1Schema>;
export type ExpireAssetTransferOfferPayloadV1 = Static<
  typeof ExpireAssetTransferOfferPayloadV1Schema
>;
export type ExpireAssetTransferOfferV1 = Static<typeof ExpireAssetTransferOfferV1Schema>;
export type EconomyCommandRequestV1 = Static<typeof EconomyCommandRequestV1Schema>;
export type PublicEconomyCommandRequestV1 = Static<typeof PublicEconomyCommandRequestV1Schema>;
export type LegacyEconomySeedPlanAdoptedPayloadV1 = Static<
  typeof LegacyEconomySeedPlanAdoptedPayloadV1Schema
>;
export type WorldEconomyInitializedPayloadV1 = Static<
  typeof WorldEconomyInitializedPayloadV1Schema
>;
export type WorldEconomyReconciledPayloadV1 = Static<typeof WorldEconomyReconciledPayloadV1Schema>;
export type WorldEconomyRepairedPayloadV1 = Static<typeof WorldEconomyRepairedPayloadV1Schema>;
export type CurrencyIssuedPayloadV1 = Static<typeof CurrencyIssuedPayloadV1Schema>;
export type CurrencyTransferredPayloadV1 = Static<typeof CurrencyTransferredPayloadV1Schema>;
export type CurrencyFrozenPayloadV1 = Static<typeof CurrencyFrozenPayloadV1Schema>;
export type CurrencyUnfrozenPayloadV1 = Static<typeof CurrencyUnfrozenPayloadV1Schema>;
export type WalletFrozenPayloadV1 = Static<typeof WalletFrozenPayloadV1Schema>;
export type WalletUnfrozenPayloadV1 = Static<typeof WalletUnfrozenPayloadV1Schema>;
export type AssetOwnershipTransferredPayloadV1 = Static<
  typeof AssetOwnershipTransferredPayloadV1Schema
>;
export type AssetTransferOfferCreatedPayloadV1 = Static<
  typeof AssetTransferOfferCreatedPayloadV1Schema
>;
export type AssetTransferOfferCancelledPayloadV1 = Static<
  typeof AssetTransferOfferCancelledPayloadV1Schema
>;
export type AssetTransferOfferAcceptedPayloadV1 = Static<
  typeof AssetTransferOfferAcceptedPayloadV1Schema
>;
export type AssetTransferOfferExpiredPayloadV1 = Static<
  typeof AssetTransferOfferExpiredPayloadV1Schema
>;
export type AssetPurchasedPayloadV1 = Static<typeof AssetPurchasedPayloadV1Schema>;
export type EconomyReconciliationMismatchV1 = Static<typeof EconomyReconciliationMismatchV1Schema>;
export type EconomyReconciliationDocumentV1 = Static<typeof EconomyReconciliationDocumentV1Schema>;
export type EconomyReconciliationReportV1 = Static<typeof EconomyReconciliationReportV1Schema>;
