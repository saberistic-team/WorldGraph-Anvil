import { Type, type Static } from '@sinclair/typebox';

import {
  AssetOwnershipV1Schema,
  AssetTransferOfferV1Schema,
  AssetV1Schema,
  CurrencyV1Schema,
  EconomyEntityLogicalKeySchema,
  EconomyHashSchema,
  EconomyPositiveVersionSchema,
  EconomyRepairApprovalRequestV1Schema,
  EconomyRepairApprovalV1Schema,
  EconomyRepairPlanV1Schema,
  EconomyUnsignedMinorSchema,
  EconomyVersionSchema,
  FinancialTransactionV1Schema,
  IdempotencyKeySchema,
  WalletBalanceV1Schema,
  WalletV1Schema,
} from '@worldgraph/contracts';

const CursorSchema = Type.String({ maxLength: 1_024, minLength: 16 });
const PageLimitSchema = Type.Optional(
  Type.Union([
    Type.Integer({ maximum: 100, minimum: 1 }),
    Type.String({ maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }),
  ]),
);

export const EconomyWorldParamsSchema = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
export const EconomyWalletParamsSchema = Type.Object(
  { id: Type.String({ format: 'uuid' }), walletId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
export const EconomyAssetParamsSchema = Type.Object(
  {
    assetKey: Type.String({
      maxLength: 240,
      minLength: 3,
      pattern: '^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$',
    }),
    id: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);
export const EconomyRepairPlanParamsSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    planId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);
export const EconomyRepairApprovalHeadersSchema = Type.Object(
  {
    'idempotency-key': IdempotencyKeySchema,
    'x-csrf-token': Type.Optional(Type.String({ maxLength: 128, minLength: 32 })),
  },
  { additionalProperties: true },
);

export const EconomyPageQuerySchema = Type.Object(
  { cursor: Type.Optional(CursorSchema), limit: PageLimitSchema },
  { additionalProperties: false },
);
export const AssetPageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: PageLimitSchema,
    owned: Type.Optional(Type.Union([Type.Boolean(), Type.Literal('true'), Type.Literal('false')])),
  },
  { additionalProperties: false },
);
export const OfferPageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: PageLimitSchema,
    offerId: Type.Optional(Type.String({ format: 'uuid' })),
    status: Type.Optional(
      Type.Union([
        Type.Literal('open'),
        Type.Literal('accepted'),
        Type.Literal('cancelled'),
        Type.Literal('expired'),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const EconomySummaryTransportSchema = Type.Object(
  {
    capabilities: Type.Object(
      {
        canAdoptLegacySeed: Type.Boolean(),
        canInitialize: Type.Boolean(),
        canIssue: Type.Boolean(),
        canReconcile: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    currentTick: EconomyVersionSchema,
    designVersion: EconomyPositiveVersionSchema,
    economyHeadVersion: Type.Union([EconomyPositiveVersionSchema, Type.Null()]),
    featurePolicy: Type.Object(
      {
        debitsFrozen: Type.Boolean(),
        issuanceEnabled: Type.Boolean(),
        offersEnabled: Type.Boolean(),
        transfersEnabled: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    initializedEventId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    issuanceTarget: Type.Union([
      Type.Object(
        {
          currencyCode: Type.String({ maxLength: 12, minLength: 3 }),
          currencyId: Type.String({ format: 'uuid' }),
          currencyVersion: EconomyPositiveVersionSchema,
          currentSupplyMinor: EconomyUnsignedMinorSchema,
          maxSupplyMinor: Type.Union([EconomyUnsignedMinorSchema, Type.Null()]),
          minorUnitScale: Type.Integer({ maximum: 6, minimum: 0 }),
          supplyVersion: EconomyPositiveVersionSchema,
          treasuryBalanceMinor: EconomyUnsignedMinorSchema,
          treasuryBalanceVersion: EconomyPositiveVersionSchema,
          treasuryWalletId: Type.String({ format: 'uuid' }),
          treasuryWalletVersion: EconomyPositiveVersionSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    projectionChecksum: Type.Union([EconomyHashSchema, Type.Null()]),
    reconciliation: Type.Object(
      {
        lastReconciledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
        lastReconciledStateRevision: Type.Union([EconomyVersionSchema, Type.Null()]),
        status: Type.Union([
          Type.Literal('not_run'),
          Type.Literal('current'),
          Type.Literal('reconciling'),
          Type.Literal('mismatched'),
        ]),
      },
      { additionalProperties: false },
    ),
    seedPlan: Type.Object(
      {
        available: Type.Boolean(),
        hash: Type.Union([EconomyHashSchema, Type.Null()]),
        sourceKind: Type.Union([
          Type.Literal('compiler_1_1'),
          Type.Literal('legacy_adapter'),
          Type.Null(),
        ]),
      },
      { additionalProperties: false },
    ),
    stateRevision: EconomyVersionSchema,
    status: Type.Union([
      Type.Literal('not_initialized'),
      Type.Literal('ready'),
      Type.Literal('reconciling'),
      Type.Literal('mismatched'),
    ]),
    virtualValueBoundary: Type.Object(
      { cashOutAllowed: Type.Literal(false), noCashValue: Type.Literal(true) },
      { additionalProperties: false },
    ),
    worldId: Type.String({ format: 'uuid' }),
  },
  { $id: 'EconomySummaryTransport', additionalProperties: false },
);

export const CurrencyViewTransportSchema = Type.Object(
  {
    currency: CurrencyV1Schema,
    currentSupplyMinor: EconomyUnsignedMinorSchema,
    supplyVersion: EconomyPositiveVersionSchema,
    updatedStateRevision: EconomyVersionSchema,
  },
  { additionalProperties: false },
);
export const CurrencyPageTransportSchema = Type.Object(
  { items: Type.Array(CurrencyViewTransportSchema, { maxItems: 100 }), nextCursor: Type.Null() },
  { additionalProperties: false },
);

export const ControlledWalletViewTransportSchema = Type.Object(
  {
    balance: WalletBalanceV1Schema,
    controlled: Type.Literal(true),
    currencyCode: Type.String({ maxLength: 12, minLength: 3 }),
    minorUnitScale: Type.Integer({ maximum: 6, minimum: 0 }),
    wallet: WalletV1Schema,
  },
  { additionalProperties: false },
);
export const ControlledWalletPageTransportSchema = Type.Object(
  {
    items: Type.Array(ControlledWalletViewTransportSchema, { maxItems: 100 }),
    nextCursor: Type.Union([CursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const WalletTransactionViewTransportSchema = Type.Object(
  {
    memo: Type.Union([Type.String({ maxLength: 280, minLength: 1 }), Type.Null()]),
    transaction: FinancialTransactionV1Schema,
  },
  { additionalProperties: false },
);
export const WalletTransactionPageTransportSchema = Type.Object(
  {
    items: Type.Array(WalletTransactionViewTransportSchema, { maxItems: 100 }),
    nextCursor: Type.Union([CursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const AssetViewTransportSchema = Type.Object(
  {
    asset: AssetV1Schema,
    controlledByActor: Type.Boolean(),
    ownership: AssetOwnershipV1Schema,
  },
  { additionalProperties: false },
);
export const AssetPageTransportSchema = Type.Object(
  {
    items: Type.Array(AssetViewTransportSchema, { maxItems: 100 }),
    nextCursor: Type.Union([CursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const OfferViewTransportSchema = Type.Object(
  {
    assetKey: Type.String({ maxLength: 240, minLength: 3 }),
    canAccept: Type.Boolean(),
    controlledBuyer: Type.Boolean(),
    controlledSeller: Type.Boolean(),
    eligibleBuyerWallet: Type.Union([
      Type.Object(
        {
          ownerEntityLogicalKey: EconomyEntityLogicalKeySchema,
          walletId: Type.String({ format: 'uuid' }),
          walletVersion: EconomyPositiveVersionSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    offer: AssetTransferOfferV1Schema,
    sellerWalletVersion: EconomyPositiveVersionSchema,
  },
  { additionalProperties: false },
);
export const OfferPageTransportSchema = Type.Object(
  {
    items: Type.Array(OfferViewTransportSchema, { maxItems: 100 }),
    nextCursor: Type.Union([CursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const EconomyRepairPlanViewTransportSchema = Type.Object(
  {
    ...EconomyRepairPlanV1Schema.properties,
    approvalStatus: Type.Object(
      { creator: Type.Boolean(), platformAdmin: Type.Boolean() },
      { additionalProperties: false },
    ),
    executed: Type.Boolean(),
  },
  { $id: 'EconomyRepairPlanViewTransport', additionalProperties: false },
);

export type EconomyPageQueryTransport = Static<typeof EconomyPageQuerySchema>;
export type AssetPageQueryTransport = Static<typeof AssetPageQuerySchema>;
export type OfferPageQueryTransport = Static<typeof OfferPageQuerySchema>;
export type EconomySummaryTransport = Static<typeof EconomySummaryTransportSchema>;
export type CurrencyViewTransport = Static<typeof CurrencyViewTransportSchema>;
export type ControlledWalletViewTransport = Static<typeof ControlledWalletViewTransportSchema>;
export type WalletTransactionViewTransport = Static<typeof WalletTransactionViewTransportSchema>;
export type AssetViewTransport = Static<typeof AssetViewTransportSchema>;
export type OfferViewTransport = Static<typeof OfferViewTransportSchema>;
export type EconomyRepairPlanViewTransport = Static<typeof EconomyRepairPlanViewTransportSchema>;
export type EconomyRepairApprovalRequestTransport = Static<
  typeof EconomyRepairApprovalRequestV1Schema
>;
export type EconomyRepairApprovalHeadersTransport = Static<
  typeof EconomyRepairApprovalHeadersSchema
>;
export type EconomyRepairApprovalTransport = Static<typeof EconomyRepairApprovalV1Schema>;

export { EconomyRepairApprovalRequestV1Schema, EconomyRepairApprovalV1Schema };
