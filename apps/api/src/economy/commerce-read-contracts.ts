import { Type, type Static, type TSchema } from '@sinclair/typebox';

import {
  BusinessFacilityViewV1Schema,
  BusinessViewV1Schema,
  CommerceCodeSchema,
  CommercePositiveQuantitySchema,
  CommerceProjectionMetaV1Schema,
  CommerceTransactionSummaryViewV1Schema,
  EconomyPositiveMinorSchema,
  EconomyPositiveVersionSchema,
  EconomyStableKeySchema,
  EconomyTickSchema,
  EconomyUnsignedMinorSchema,
  EconomyUuidSchema,
  EmploymentContractStatusSchema,
  EmploymentContractViewV1Schema,
  InventoryViewV1Schema,
  MarketListingStatusSchema,
  MarketListingViewV1Schema,
  MarketPurchasePreviewV1Schema,
  MarketTradeViewV1Schema,
  PayrollStatusSchema,
  ProductionRecipeVersionViewV1Schema,
  ProductionRunStatusSchema,
  ProductionRunViewV1Schema,
  ResourceTypeStatusSchema,
  ResourceTypeViewV1Schema,
  TaxAssessmentViewV1Schema,
  TreasurySummaryViewV1Schema,
} from '@worldgraph/contracts';

const CursorSchema = Type.String({ maxLength: 1_024, minLength: 16 });
const PageLimitSchema = Type.Optional(
  Type.Union([
    Type.Integer({ maximum: 100, minimum: 1 }),
    Type.String({ maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }),
  ]),
);

export const CommerceReadWorldParamsSchema = Type.Object(
  { id: EconomyUuidSchema },
  { additionalProperties: false },
);
export const CommerceReadListingParamsSchema = Type.Object(
  { id: EconomyUuidSchema, listingId: EconomyUuidSchema },
  { additionalProperties: false },
);
export const CommerceReadBusinessParamsSchema = Type.Object(
  { businessId: EconomyUuidSchema, id: EconomyUuidSchema },
  { additionalProperties: false },
);
export const CommerceReadPageQuerySchema = Type.Object(
  { cursor: Type.Optional(CursorSchema), limit: PageLimitSchema },
  { additionalProperties: false },
);
export const ResourcePageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: PageLimitSchema,
    status: Type.Optional(ResourceTypeStatusSchema),
  },
  { additionalProperties: false },
);
export const InventoryPageQuerySchema = Type.Object(
  {
    controlled: Type.Optional(
      Type.Union([Type.Boolean(), Type.Literal('true'), Type.Literal('false')]),
    ),
    cursor: Type.Optional(CursorSchema),
    limit: PageLimitSchema,
    resourceTypeId: Type.Optional(EconomyUuidSchema),
  },
  { additionalProperties: false },
);
export const EmploymentPageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: PageLimitSchema,
    status: Type.Optional(EmploymentContractStatusSchema),
  },
  { additionalProperties: false },
);
export const ProductionRunPageQuerySchema = Type.Object(
  {
    businessId: Type.Optional(EconomyUuidSchema),
    cursor: Type.Optional(CursorSchema),
    limit: PageLimitSchema,
    status: Type.Optional(ProductionRunStatusSchema),
  },
  { additionalProperties: false },
);
export const MarketListingPageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: PageLimitSchema,
    resourceTypeId: Type.Optional(EconomyUuidSchema),
    status: Type.Optional(MarketListingStatusSchema),
  },
  { additionalProperties: false },
);
export const MarketTradePageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: PageLimitSchema,
    listingId: Type.Optional(EconomyUuidSchema),
  },
  { additionalProperties: false },
);
export const PurchasePreviewQuerySchema = Type.Object(
  { quantity: CommercePositiveQuantitySchema },
  { additionalProperties: false },
);

export const EmploymentOfferViewV1Schema = Type.Object(
  {
    businessId: EconomyUuidSchema,
    cadenceTicks: EconomyTickSchema,
    currencyId: EconomyUuidSchema,
    id: EconomyUuidSchema,
    maxPaymentsPerPeriod: Type.Integer({ maximum: 1_000, minimum: 1 }),
    roleCode: CommerceCodeSchema,
    rowVersion: EconomyPositiveVersionSchema,
    stableKey: EconomyStableKeySchema,
    status: Type.Union([Type.Literal('open'), Type.Literal('closed'), Type.Literal('retired')]),
    wageMinor: EconomyPositiveMinorSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'EmploymentOfferViewV1', additionalProperties: false },
);

export const EmploymentCandidateViewV1Schema = Type.Object(
  {
    businessId: EconomyUuidSchema,
    currencyId: EconomyUuidSchema,
    workerEntityKey: EconomyStableKeySchema,
    workerWalletId: EconomyUuidSchema,
  },
  { $id: 'EmploymentCandidateViewV1', additionalProperties: false },
);

export const JobRecordViewV1Schema = Type.Object(
  {
    contractId: EconomyUuidSchema,
    grossMinor: EconomyPositiveMinorSchema,
    id: EconomyUuidSchema,
    payroll: Type.Union([
      Type.Object(
        {
          errorCode: Type.Union([CommerceCodeSchema, Type.Null()]),
          grossMinor: EconomyPositiveMinorSchema,
          id: EconomyUuidSchema,
          netMinor: EconomyUnsignedMinorSchema,
          rowVersion: EconomyPositiveVersionSchema,
          status: PayrollStatusSchema,
          taxMinor: EconomyUnsignedMinorSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    performedTick: EconomyTickSchema,
    worldId: EconomyUuidSchema,
  },
  { $id: 'JobRecordViewV1', additionalProperties: false },
);

export const CommerceReconciliationSummaryV1Schema = Type.Object(
  {
    expansionVersion: EconomyPositiveVersionSchema,
    lastRun: Type.Union([
      Type.Object(
        {
          assessmentCount: Type.Integer({ minimum: 0 }),
          id: EconomyUuidSchema,
          inventoryCount: Type.Integer({ minimum: 0 }),
          mismatchCount: Type.Integer({ minimum: 0 }),
          resourceCount: Type.Integer({ minimum: 0 }),
          sourceStateRevision: EconomyPositiveVersionSchema,
          status: Type.Union([Type.Literal('matched'), Type.Literal('mismatch')]),
          tradeCount: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    projection: CommerceProjectionMetaV1Schema,
    projectionChecksum: Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' }),
    worldId: EconomyUuidSchema,
  },
  { $id: 'CommerceReconciliationSummaryV1', additionalProperties: false },
);

function commerceReadPage<T extends TSchema>(item: T, id: string) {
  return Type.Object(
    {
      items: Type.Array(item, { maxItems: 100 }),
      nextCursor: Type.Union([CursorSchema, Type.Null()]),
      projection: CommerceProjectionMetaV1Schema,
    },
    { $id: id, additionalProperties: false },
  );
}

export const CommerceResourcePageSchema = commerceReadPage(
  ResourceTypeViewV1Schema,
  'CommerceResourcePage',
);
export const CommerceRecipePageSchema = commerceReadPage(
  ProductionRecipeVersionViewV1Schema,
  'CommerceRecipePage',
);
export const CommerceInventoryPageSchema = commerceReadPage(
  InventoryViewV1Schema,
  'CommerceInventoryPage',
);
export const CommerceBusinessPageSchema = commerceReadPage(
  BusinessViewV1Schema,
  'CommerceBusinessPage',
);
export const CommerceFacilityPageSchema = commerceReadPage(
  BusinessFacilityViewV1Schema,
  'CommerceFacilityPage',
);
export const CommerceEmploymentOfferPageSchema = commerceReadPage(
  EmploymentOfferViewV1Schema,
  'CommerceEmploymentOfferPage',
);
export const CommerceEmploymentCandidatePageSchema = commerceReadPage(
  EmploymentCandidateViewV1Schema,
  'CommerceEmploymentCandidatePage',
);
export const CommerceEmploymentContractPageSchema = commerceReadPage(
  EmploymentContractViewV1Schema,
  'CommerceEmploymentContractPage',
);
export const CommerceJobPageSchema = commerceReadPage(JobRecordViewV1Schema, 'CommerceJobPage');
export const CommerceProductionRunPageSchema = commerceReadPage(
  ProductionRunViewV1Schema,
  'CommerceProductionRunPage',
);
export const CommerceMarketListingPageSchema = commerceReadPage(
  MarketListingViewV1Schema,
  'CommerceMarketListingPage',
);
export const CommerceMarketTradePageSchema = commerceReadPage(
  MarketTradeViewV1Schema,
  'CommerceMarketTradePage',
);
export const CommerceTaxAssessmentPageSchema = commerceReadPage(
  TaxAssessmentViewV1Schema,
  'CommerceTaxAssessmentPage',
);
export const CommerceTransactionPageSchema = commerceReadPage(
  CommerceTransactionSummaryViewV1Schema,
  'CommerceTransactionPage',
);
export const CommercePurchasePreviewSchema = Type.Object(
  { preview: MarketPurchasePreviewV1Schema, projection: CommerceProjectionMetaV1Schema },
  { $id: 'CommercePurchasePreview', additionalProperties: false },
);
export const CommerceTreasurySummarySchema = Type.Object(
  { projection: CommerceProjectionMetaV1Schema, treasury: TreasurySummaryViewV1Schema },
  { $id: 'CommerceTreasurySummary', additionalProperties: false },
);

export type CommerceReadPageQuery = Static<typeof CommerceReadPageQuerySchema>;
export type ResourcePageQuery = Static<typeof ResourcePageQuerySchema>;
export type InventoryPageQuery = Static<typeof InventoryPageQuerySchema>;
export type EmploymentPageQuery = Static<typeof EmploymentPageQuerySchema>;
export type ProductionRunPageQuery = Static<typeof ProductionRunPageQuerySchema>;
export type MarketListingPageQuery = Static<typeof MarketListingPageQuerySchema>;
export type MarketTradePageQuery = Static<typeof MarketTradePageQuerySchema>;
export type PurchasePreviewQuery = Static<typeof PurchasePreviewQuerySchema>;
export type EmploymentOfferViewV1 = Static<typeof EmploymentOfferViewV1Schema>;
export type EmploymentCandidateViewV1 = Static<typeof EmploymentCandidateViewV1Schema>;
export type JobRecordViewV1 = Static<typeof JobRecordViewV1Schema>;
export type CommerceReconciliationSummaryV1 = Static<typeof CommerceReconciliationSummaryV1Schema>;
