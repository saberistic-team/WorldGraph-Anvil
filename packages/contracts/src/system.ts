import { Type, type Static } from '@sinclair/typebox';

export const ComponentNameSchema = Type.Union([
  Type.Literal('api'),
  Type.Literal('postgresql'),
  Type.Literal('redis'),
  Type.Literal('worker'),
]);

export const ComponentStatusSchema = Type.Object(
  {
    code: Type.Optional(Type.String({ maxLength: 80 })),
    name: ComponentNameSchema,
    status: Type.Union([
      Type.Literal('healthy'),
      Type.Literal('degraded'),
      Type.Literal('unavailable'),
      Type.Literal('not_configured'),
    ]),
  },
  { additionalProperties: false },
);

export const LiveResponseSchema = Type.Object(
  { status: Type.Literal('ok') },
  { $id: 'LiveResponseV1', additionalProperties: false },
);

export const ReadyResponseSchema = Type.Object(
  {
    checkedAt: Type.String({ format: 'date-time' }),
    components: Type.Array(ComponentStatusSchema, { maxItems: 4, minItems: 4 }),
    status: Type.Literal('ready'),
  },
  { $id: 'ReadyResponseV1', additionalProperties: false },
);

export const SystemInfoSchema = Type.Object(
  {
    build: Type.Object(
      {
        api: Type.String({ maxLength: 100 }),
        web: Type.Optional(Type.String({ maxLength: 100 })),
      },
      { additionalProperties: false },
    ),
    codename: Type.Literal('Anvil'),
    features: Type.Object({ operationalSmoke: Type.Boolean() }, { additionalProperties: false }),
    name: Type.Literal('WorldGraph'),
    versions: Type.Object(
      {
        api: Type.Literal('v1'),
        authoritativeCommandSchema: Type.Integer({ minimum: 1 }),
        businessFacilitySchema: Type.Integer({ minimum: 1 }),
        businessSchema: Type.Integer({ minimum: 1 }),
        compiler: Type.String(),
        compilerArtifactSchema: Type.Integer({ minimum: 1 }),
        compilerConfigSchema: Type.Integer({ minimum: 1 }),
        compilationQueueSchema: Type.Integer({ minimum: 1 }),
        contracts: Type.Integer({ minimum: 1 }),
        domainEventSchema: Type.Integer({ minimum: 1 }),
        economyExpansionHeadSchema: Type.Integer({ minimum: 1 }),
        economyReconciliationSchema: Type.Integer({ minimum: 1 }),
        economySchema: Type.Integer({ minimum: 1 }),
        economySeedPlanSchema: Type.Integer({ minimum: 1 }),
        currencySchema: Type.Integer({ minimum: 1 }),
        financialTransactionSchema: Type.Integer({ minimum: 1 }),
        historySchema: Type.Integer({ minimum: 1 }),
        employmentContractSchema: Type.Integer({ minimum: 1 }),
        inventoryMovementSchema: Type.Integer({ minimum: 1 }),
        inventoryReservationSchema: Type.Integer({ minimum: 1 }),
        inventorySchema: Type.Integer({ minimum: 1 }),
        ledgerSchema: Type.Integer({ minimum: 1 }),
        manifestGeneratorSchema: Type.Integer({ minimum: 1 }),
        manifestPromptTemplate: Type.Integer({ minimum: 1 }),
        manifestQueueSchema: Type.Integer({ minimum: 1 }),
        manifestSchema: Type.Integer({ minimum: 0 }),
        manifestValidator: Type.Integer({ minimum: 1 }),
        marketListingSchema: Type.Integer({ minimum: 1 }),
        marketTradeSchema: Type.Integer({ minimum: 1 }),
        outboxSchema: Type.Integer({ minimum: 1 }),
        ownershipSchema: Type.Integer({ minimum: 1 }),
        payrollRecordSchema: Type.Integer({ minimum: 1 }),
        assetSchema: Type.Integer({ minimum: 1 }),
        assetTransferOfferSchema: Type.Integer({ minimum: 1 }),
        primitiveSchema: Type.Integer({ minimum: 0 }),
        projectionSchema: Type.Integer({ minimum: 1 }),
        productionRecipeSchema: Type.Integer({ minimum: 1 }),
        productionRecipeVersionSchema: Type.Integer({ minimum: 1 }),
        productionRunSchema: Type.Integer({ minimum: 1 }),
        resourceTypeSchema: Type.Integer({ minimum: 1 }),
        runtimeSchema: Type.Integer({ minimum: 1 }),
        simulationBatchSchema: Type.Integer({ minimum: 1 }),
        simulationClockSchema: Type.Integer({ minimum: 1 }),
        simulationFailureSchema: Type.Integer({ minimum: 1 }),
        simulationOutcomeSchema: Type.Integer({ minimum: 1 }),
        simulationPrngAlgorithm: Type.String({ maxLength: 80, minLength: 1 }),
        simulationPrngSchema: Type.Integer({ minimum: 1 }),
        simulationProcessSchema: Type.Integer({ minimum: 1 }),
        simulationProcessRegistry: Type.Integer({ minimum: 1 }),
        simulationProjectionSchema: Type.Integer({ minimum: 1 }),
        simulationQueueSchema: Type.Integer({ minimum: 1 }),
        simulationScheduleSchema: Type.Integer({ minimum: 1 }),
        taxAssessmentSchema: Type.Integer({ minimum: 1 }),
        taxPolicySchema: Type.Integer({ minimum: 1 }),
        workRecordSchema: Type.Integer({ minimum: 1 }),
        worldGraphSchema: Type.Integer({ minimum: 1 }),
        walletSchema: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'SystemInfoV1', additionalProperties: false },
);

export const SmokeJobAcceptedSchema = Type.Object(
  {
    jobId: Type.String({ maxLength: 128, minLength: 1 }),
    status: Type.Union([Type.Literal('queued'), Type.Literal('completed')]),
  },
  { $id: 'SmokeJobAcceptedV1', additionalProperties: false },
);

export type ComponentStatus = Static<typeof ComponentStatusSchema>;
export type LiveResponse = Static<typeof LiveResponseSchema>;
export type ReadyResponse = Static<typeof ReadyResponseSchema>;
export type SmokeJobAccepted = Static<typeof SmokeJobAcceptedSchema>;
export type SystemInfo = Static<typeof SystemInfoSchema>;
