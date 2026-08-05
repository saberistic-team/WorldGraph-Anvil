export const PRODUCT_NAME = 'WorldGraph' as const;
export const PRODUCT_CODENAME = 'Anvil' as const;
export const API_VERSION = 'v1' as const;
export const CONTRACT_SCHEMA_VERSION = 11 as const;
export const RUNTIME_SCHEMA_VERSION = 11 as const;
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_GENERATOR_SCHEMA_VERSION = 1 as const;
export const MANIFEST_PROMPT_TEMPLATE_VERSION = 1 as const;
export const MANIFEST_VALIDATOR_VERSION = 1 as const;
export const MANIFEST_QUEUE_SCHEMA_VERSION = 1 as const;
export const PRIMITIVE_SCHEMA_VERSION = 1 as const;
export const LEGACY_COMPILER_VERSION = '1.0.0' as const;
export const RETAINED_COMPILER_VERSION = '1.1.0' as const;
export const PREVIOUS_COMPILER_VERSION = '1.2.0' as const;
export const GOVERNANCE_COMPILER_VERSION = '1.3.0' as const;
export const COMPILER_VERSION = '1.4.0' as const;
export const COMPILER_CONFIG_SCHEMA_VERSION = 1 as const;
export const LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION = 3 as const;
export const GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION = 4 as const;
export const COMPILED_ARTIFACT_SCHEMA_VERSION = 5 as const;
export const WORLD_GRAPH_SCHEMA_VERSION = 1 as const;
export const WORLD_COMPILATION_QUEUE_SCHEMA_VERSION = 1 as const;
export const AUTHORITATIVE_COMMAND_SCHEMA_VERSION = 1 as const;
export const DOMAIN_EVENT_SCHEMA_VERSION = 1 as const;
export const LEDGER_SCHEMA_VERSION = 1 as const;
export const PROJECTION_SCHEMA_VERSION = 1 as const;
export const OUTBOX_SCHEMA_VERSION = 1 as const;
export const HISTORY_SCHEMA_VERSION = 1 as const;
export const SIMULATION_CLOCK_SCHEMA_VERSION = 1 as const;
export const SIMULATION_SCHEDULE_SCHEMA_VERSION = 1 as const;
export const SIMULATION_PROCESS_SCHEMA_VERSION = 1 as const;
export const LEGACY_SIMULATION_PROCESS_REGISTRY_VERSION = 1 as const;
export const PREVIOUS_SIMULATION_PROCESS_REGISTRY_VERSION = 2 as const;
export const SIMULATION_PROCESS_REGISTRY_VERSION = 3 as const;
export const SIMULATION_BATCH_SCHEMA_VERSION = 1 as const;
export const SIMULATION_FAILURE_SCHEMA_VERSION = 1 as const;
export const SIMULATION_QUEUE_SCHEMA_VERSION = 1 as const;
export const SIMULATION_PROJECTION_SCHEMA_VERSION = 1 as const;
export const SIMULATION_OUTCOME_SCHEMA_VERSION = 1 as const;
export const SIMULATION_PRNG_SCHEMA_VERSION = 1 as const;
export const SIMULATION_PRNG_ALGORITHM_VERSION = 'xorshift32-sha256-v1' as const;
export const ECONOMY_SCHEMA_VERSION = 1 as const;
export const LEGACY_ECONOMY_SEED_PLAN_SCHEMA_VERSION = 1 as const;
export const ECONOMY_SEED_PLAN_SCHEMA_VERSION = 2 as const;
export const CURRENCY_SCHEMA_VERSION = 1 as const;
export const WALLET_SCHEMA_VERSION = 1 as const;
export const FINANCIAL_TRANSACTION_SCHEMA_VERSION = 1 as const;
export const ASSET_SCHEMA_VERSION = 1 as const;
export const OWNERSHIP_SCHEMA_VERSION = 1 as const;
export const ASSET_TRANSFER_OFFER_SCHEMA_VERSION = 1 as const;
export const PREVIOUS_ECONOMY_RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const RETAINED_ECONOMY_RECONCILIATION_SCHEMA_VERSION = 2 as const;
export const ECONOMY_RECONCILIATION_SCHEMA_VERSION = 3 as const;
export const RESOURCE_TYPE_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_RECIPE_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_RECIPE_VERSION_SCHEMA_VERSION = 1 as const;
export const INVENTORY_SCHEMA_VERSION = 1 as const;
export const INVENTORY_RESERVATION_SCHEMA_VERSION = 1 as const;
export const INVENTORY_MOVEMENT_SCHEMA_VERSION = 1 as const;
export const BUSINESS_SCHEMA_VERSION = 1 as const;
export const BUSINESS_FACILITY_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_RUN_SCHEMA_VERSION = 1 as const;
export const EMPLOYMENT_CONTRACT_SCHEMA_VERSION = 1 as const;
export const WORK_RECORD_SCHEMA_VERSION = 1 as const;
export const PAYROLL_RECORD_SCHEMA_VERSION = 1 as const;
export const MARKET_LISTING_SCHEMA_VERSION = 1 as const;
export const MARKET_TRADE_SCHEMA_VERSION = 1 as const;
export const TAX_POLICY_SCHEMA_VERSION = 1 as const;
export const TAX_ASSESSMENT_SCHEMA_VERSION = 1 as const;
export const ECONOMY_EXPANSION_HEAD_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_POLICY_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_SEED_PLAN_SCHEMA_VERSION = 1 as const;
export const GEOGRAPHY_SCHEMA_VERSION = 1 as const;
export const GEOGRAPHY_SEED_PLAN_SCHEMA_VERSION = 1 as const;
export const VISUAL_SCENE_PLAN_SCHEMA_VERSION = 1 as const;
export const VISUAL_STYLE_KIT_VERSION = 1 as const;
export const VISUAL_ASSET_CATALOG_SCHEMA_VERSION = 1 as const;

export const publicCompatibilityVersions = {
  api: API_VERSION,
  authoritativeCommandSchema: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  compiler: COMPILER_VERSION,
  compilerArtifactSchema: COMPILED_ARTIFACT_SCHEMA_VERSION,
  compilerConfigSchema: COMPILER_CONFIG_SCHEMA_VERSION,
  compilationQueueSchema: WORLD_COMPILATION_QUEUE_SCHEMA_VERSION,
  contracts: CONTRACT_SCHEMA_VERSION,
  businessFacilitySchema: BUSINESS_FACILITY_SCHEMA_VERSION,
  businessSchema: BUSINESS_SCHEMA_VERSION,
  domainEventSchema: DOMAIN_EVENT_SCHEMA_VERSION,
  economyExpansionHeadSchema: ECONOMY_EXPANSION_HEAD_SCHEMA_VERSION,
  economyReconciliationSchema: ECONOMY_RECONCILIATION_SCHEMA_VERSION,
  economySchema: ECONOMY_SCHEMA_VERSION,
  economySeedPlanSchema: ECONOMY_SEED_PLAN_SCHEMA_VERSION,
  currencySchema: CURRENCY_SCHEMA_VERSION,
  financialTransactionSchema: FINANCIAL_TRANSACTION_SCHEMA_VERSION,
  geographySchema: GEOGRAPHY_SCHEMA_VERSION,
  geographySeedPlanSchema: GEOGRAPHY_SEED_PLAN_SCHEMA_VERSION,
  governancePolicySchema: GOVERNANCE_POLICY_SCHEMA_VERSION,
  governanceSchema: GOVERNANCE_SCHEMA_VERSION,
  governanceSeedPlanSchema: GOVERNANCE_SEED_PLAN_SCHEMA_VERSION,
  historySchema: HISTORY_SCHEMA_VERSION,
  employmentContractSchema: EMPLOYMENT_CONTRACT_SCHEMA_VERSION,
  inventoryMovementSchema: INVENTORY_MOVEMENT_SCHEMA_VERSION,
  inventoryReservationSchema: INVENTORY_RESERVATION_SCHEMA_VERSION,
  inventorySchema: INVENTORY_SCHEMA_VERSION,
  ledgerSchema: LEDGER_SCHEMA_VERSION,
  manifestGeneratorSchema: MANIFEST_GENERATOR_SCHEMA_VERSION,
  manifestPromptTemplate: MANIFEST_PROMPT_TEMPLATE_VERSION,
  manifestQueueSchema: MANIFEST_QUEUE_SCHEMA_VERSION,
  manifestSchema: MANIFEST_SCHEMA_VERSION,
  manifestValidator: MANIFEST_VALIDATOR_VERSION,
  outboxSchema: OUTBOX_SCHEMA_VERSION,
  ownershipSchema: OWNERSHIP_SCHEMA_VERSION,
  marketListingSchema: MARKET_LISTING_SCHEMA_VERSION,
  marketTradeSchema: MARKET_TRADE_SCHEMA_VERSION,
  payrollRecordSchema: PAYROLL_RECORD_SCHEMA_VERSION,
  assetSchema: ASSET_SCHEMA_VERSION,
  assetTransferOfferSchema: ASSET_TRANSFER_OFFER_SCHEMA_VERSION,
  primitiveSchema: PRIMITIVE_SCHEMA_VERSION,
  projectionSchema: PROJECTION_SCHEMA_VERSION,
  productionRecipeSchema: PRODUCTION_RECIPE_SCHEMA_VERSION,
  productionRecipeVersionSchema: PRODUCTION_RECIPE_VERSION_SCHEMA_VERSION,
  productionRunSchema: PRODUCTION_RUN_SCHEMA_VERSION,
  resourceTypeSchema: RESOURCE_TYPE_SCHEMA_VERSION,
  runtimeSchema: RUNTIME_SCHEMA_VERSION,
  simulationBatchSchema: SIMULATION_BATCH_SCHEMA_VERSION,
  simulationClockSchema: SIMULATION_CLOCK_SCHEMA_VERSION,
  simulationFailureSchema: SIMULATION_FAILURE_SCHEMA_VERSION,
  simulationOutcomeSchema: SIMULATION_OUTCOME_SCHEMA_VERSION,
  simulationPrngAlgorithm: SIMULATION_PRNG_ALGORITHM_VERSION,
  simulationPrngSchema: SIMULATION_PRNG_SCHEMA_VERSION,
  simulationProcessSchema: SIMULATION_PROCESS_SCHEMA_VERSION,
  simulationProcessRegistry: SIMULATION_PROCESS_REGISTRY_VERSION,
  simulationProjectionSchema: SIMULATION_PROJECTION_SCHEMA_VERSION,
  simulationQueueSchema: SIMULATION_QUEUE_SCHEMA_VERSION,
  simulationScheduleSchema: SIMULATION_SCHEDULE_SCHEMA_VERSION,
  taxAssessmentSchema: TAX_ASSESSMENT_SCHEMA_VERSION,
  taxPolicySchema: TAX_POLICY_SCHEMA_VERSION,
  visualAssetCatalogSchema: VISUAL_ASSET_CATALOG_SCHEMA_VERSION,
  visualScenePlanSchema: VISUAL_SCENE_PLAN_SCHEMA_VERSION,
  visualStyleKitVersion: VISUAL_STYLE_KIT_VERSION,
  workRecordSchema: WORK_RECORD_SCHEMA_VERSION,
  worldGraphSchema: WORLD_GRAPH_SCHEMA_VERSION,
  walletSchema: WALLET_SCHEMA_VERSION,
} as const;
