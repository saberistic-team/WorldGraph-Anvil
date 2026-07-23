import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { WorldLogicalKeySchema } from './compiler.js';
import {
  BusinessCreatedPayloadV1Schema,
  BusinessFacilityConfiguredPayloadV1Schema,
  EmploymentContractLifecyclePayloadV1Schema,
  InventoryTransferredPayloadV1Schema,
  MarketListingLifecyclePayloadV1Schema,
  MarketTradeCompletedPayloadV1Schema,
  PayrollFailedPayloadV1Schema,
  PayrollSettledPayloadV1Schema,
  ProductionFailedPayloadV1Schema,
  ProductionResourcesPayloadV1Schema,
  ProductionRunStartedPayloadV1Schema,
  TaxAssessedPayloadV1Schema,
  TreasuryRevenueRecordedPayloadV1Schema,
  WorkRecordedPayloadV1Schema,
  WorldCommerceInitializedPayloadV1Schema,
  WorldCommerceProjectionRepairedPayloadV1Schema,
  WorldCommerceReconciledPayloadV1Schema,
} from './commerce.js';
import {
  AssetOwnershipTransferredPayloadV1Schema,
  AssetPurchasedPayloadV1Schema,
  AssetTransferOfferAcceptedPayloadV1Schema,
  AssetTransferOfferCancelledPayloadV1Schema,
  AssetTransferOfferCreatedPayloadV1Schema,
  AssetTransferOfferExpiredPayloadV1Schema,
  CurrencyFrozenPayloadV1Schema,
  CurrencyIssuedPayloadV1Schema,
  CurrencyTransferredPayloadV1Schema,
  CurrencyUnfrozenPayloadV1Schema,
  LegacyEconomySeedPlanAdoptedPayloadV1Schema,
  WalletFrozenPayloadV1Schema,
  WalletUnfrozenPayloadV1Schema,
  WorldEconomyInitializedPayloadV1Schema,
  WorldEconomyReconciledPayloadV1Schema,
  WorldEconomyRepairedPayloadV1Schema,
  type AssetOwnershipTransferredPayloadV1,
  type AssetPurchasedPayloadV1,
  type AssetTransferOfferAcceptedPayloadV1,
  type AssetTransferOfferCancelledPayloadV1,
  type AssetTransferOfferCreatedPayloadV1,
  type AssetTransferOfferExpiredPayloadV1,
  type CurrencyFrozenPayloadV1,
  type CurrencyIssuedPayloadV1,
  type CurrencyTransferredPayloadV1,
  type CurrencyUnfrozenPayloadV1,
  type LegacyEconomySeedPlanAdoptedPayloadV1,
  type WalletFrozenPayloadV1,
  type WalletUnfrozenPayloadV1,
  type WorldEconomyInitializedPayloadV1,
  type WorldEconomyReconciledPayloadV1,
  type WorldEconomyRepairedPayloadV1,
} from './economy.js';
import { ManifestJsonObjectSchema } from './manifests.js';
import { WorldRoleSchema } from './authority.js';
import {
  ScheduledActionCancelledPayloadV1Schema,
  ScheduledActionCreatedPayloadV1Schema,
  ScheduledActionExecutedPayloadV1Schema,
  SimulationAdvancedPayloadV1Schema,
  SimulationFailureRecordedPayloadV1Schema,
  SimulationFailureResolvedPayloadV1Schema,
  WorldClockAutoPausedPayloadV1Schema,
  WorldClockConfiguredPayloadV1Schema,
  WorldClockPausedPayloadV1Schema,
  WorldClockStartedPayloadV1Schema,
  WorldNoticeEmittedPayloadV1Schema,
  WorldSimulationInitializedPayloadV1Schema,
  type ScheduledActionCancelledPayloadV1,
  type ScheduledActionCreatedPayloadV1,
  type ScheduledActionExecutedPayloadV1,
  type SimulationAdvancedPayloadV1,
  type SimulationFailureRecordedPayloadV1,
  type SimulationFailureResolvedPayloadV1,
  type WorldClockAutoPausedPayloadV1,
  type WorldClockConfiguredPayloadV1,
  type WorldClockPausedPayloadV1,
  type WorldClockStartedPayloadV1,
  type WorldNoticeEmittedPayloadV1,
  type WorldSimulationInitializedPayloadV1,
} from './simulation.js';
import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  HISTORY_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
} from './versions.js';

export const LedgerUuidSchema = Type.String({ format: 'uuid' });
export const LedgerHashSchema = Type.String({
  maxLength: 64,
  minLength: 64,
  pattern: '^[a-f0-9]{64}$',
});
export const LedgerNonNegativeIntegerStringSchema = Type.String({
  maxLength: 19,
  pattern: '^(?:0|[1-9][0-9]{0,18})$',
});
export const LedgerPositiveIntegerStringSchema = Type.String({
  maxLength: 19,
  pattern: '^[1-9][0-9]{0,18}$',
});
export const LedgerCanonicalTimestampSchema = Type.String({
  format: 'date-time',
  maxLength: 24,
  minLength: 24,
  pattern:
    '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$',
});

export const LedgerActorTypeSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('system'),
  Type.Literal('ai'),
  Type.Literal('platform_admin'),
]);

const NonUserActorIdSchema = Type.String({
  maxLength: 160,
  minLength: 3,
  pattern: '^[a-z][a-z0-9._:-]*$',
});

export const LedgerActorV1Schema = Type.Union([
  Type.Object(
    { actorId: LedgerUuidSchema, actorType: Type.Literal('user') },
    { additionalProperties: false },
  ),
  Type.Object(
    { actorId: LedgerUuidSchema, actorType: Type.Literal('platform_admin') },
    { additionalProperties: false },
  ),
  Type.Object(
    { actorId: NonUserActorIdSchema, actorType: Type.Literal('system') },
    { additionalProperties: false },
  ),
  Type.Object(
    { actorId: NonUserActorIdSchema, actorType: Type.Literal('ai') },
    { additionalProperties: false },
  ),
]);

export const LedgerPayloadClassificationSchema = Type.Union([
  Type.Literal('public'),
  Type.Literal('member'),
  Type.Literal('private'),
  Type.Literal('secret'),
]);

export const LedgerVisibilitySchema = Type.Union([
  Type.Literal('public'),
  Type.Literal('member'),
  Type.Literal('participant'),
  Type.Literal('creator'),
  Type.Literal('operator'),
]);

export const RenameableWorldEntityTypeSchema = Type.Union([
  Type.Literal('district'),
  Type.Literal('institution'),
  Type.Literal('organization'),
  Type.Literal('actor_blueprint'),
  Type.Literal('player_character'),
]);

export const RenameWorldEntityPayloadV1Schema = Type.Object(
  {
    entityKey: WorldLogicalKeySchema,
    newDisplayName: Type.String({
      maxLength: 100,
      minLength: 1,
      pattern: '^[^\\u0000-\\u001F\\u007F]+$',
    }),
  },
  { $id: 'RenameWorldEntityPayloadV1', additionalProperties: false },
);

const WorldCommandRequestFields = {
  commandId: LedgerUuidSchema,
  expectedAggregateVersion: LedgerNonNegativeIntegerStringSchema,
  expectedStateRevision: LedgerNonNegativeIntegerStringSchema,
  expectedWorldVersion: LedgerPositiveIntegerStringSchema,
  idempotencyKey: Type.String({
    maxLength: 128,
    minLength: 8,
    pattern: '^[A-Za-z0-9._-]+$',
  }),
  payload: RenameWorldEntityPayloadV1Schema,
  schemaVersion: Type.Literal(AUTHORITATIVE_COMMAND_SCHEMA_VERSION),
  type: Type.Literal('RenameWorldEntityV1'),
} as const;

/** Public body. The server derives world, actor, correlation, causation and override metadata. */
export const WorldCommandRequestV1Schema = Type.Object(WorldCommandRequestFields, {
  $id: 'WorldCommandRequestV1',
  additionalProperties: false,
});

/** Fully bound command used by the command bus after transport authentication. */
export const WorldCommandEnvelopeV1Schema = Type.Object(
  {
    ...WorldCommandRequestFields,
    actor: LedgerActorV1Schema,
    causationId: Type.Union([LedgerUuidSchema, Type.Null()]),
    correlationId: LedgerUuidSchema,
    overrideId: Type.Union([LedgerUuidSchema, Type.Null()]),
    worldId: LedgerUuidSchema,
  },
  { $id: 'WorldCommandEnvelopeV1', additionalProperties: false },
);

export const WorldCommandRejectionCodeSchema = Type.Union([
  Type.Literal('VALIDATION_FAILED'),
  Type.Literal('AUTHORIZATION_DENIED'),
  Type.Literal('WORLD_NOT_ACTIVE'),
  Type.Literal('WORLD_NOT_ANCHORED'),
  Type.Literal('WORLD_VERSION_CONFLICT'),
  Type.Literal('REVISION_CONFLICT'),
  Type.Literal('AGGREGATE_VERSION_CONFLICT'),
  Type.Literal('IDEMPOTENCY_KEY_REUSED'),
  Type.Literal('ENTITY_NOT_FOUND'),
  Type.Literal('ENTITY_TYPE_NOT_RENAMEABLE'),
  Type.Literal('DISPLAY_NAME_UNCHANGED'),
  Type.Literal('COMMAND_TYPE_DISABLED'),
  Type.Literal('CLOCK_NOT_PAUSED'),
  Type.Literal('CLOCK_NOT_RUNNING'),
  Type.Literal('EXPECTED_TICK_MISMATCH'),
  Type.Literal('ADVANCE_LIMIT_EXCEEDED'),
  Type.Literal('SCHEDULE_IN_PAST'),
  Type.Literal('SCHEDULE_ALREADY_TERMINAL'),
  Type.Literal('SIMULATION_HANDLER_FAILED'),
  Type.Literal('SIMULATION_BUDGET_EXCEEDED'),
  Type.Literal('SIMULATION_INTEGER_OVERFLOW'),
  Type.Literal('SIMULATION_PROCESS_UNKNOWN'),
  Type.Literal('SIMULATION_PROCESS_VERSION_MISMATCH'),
  Type.Literal('ECONOMY_NOT_INITIALIZED'),
  Type.Literal('ECONOMY_ALREADY_INITIALIZED'),
  Type.Literal('SEED_PLAN_INCOMPATIBLE'),
  Type.Literal('SEED_PLAN_HASH_MISMATCH'),
  Type.Literal('INVALID_AMOUNT_FORMAT'),
  Type.Literal('INSUFFICIENT_FUNDS'),
  Type.Literal('INSUFFICIENT_INVENTORY'),
  Type.Literal('CURRENCY_FROZEN'),
  Type.Literal('WALLET_NOT_CONTROLLED'),
  Type.Literal('WALLET_FROZEN'),
  Type.Literal('CURRENCY_MISMATCH'),
  Type.Literal('SUPPLY_CAP_EXCEEDED'),
  Type.Literal('ASSET_NOT_OWNED'),
  Type.Literal('ASSET_NOT_TRANSFERABLE'),
  Type.Literal('OFFER_EXPIRED'),
  Type.Literal('OFFER_NOT_OPEN'),
  Type.Literal('OFFER_NOT_DUE'),
  Type.Literal('BUYER_MISMATCH'),
  Type.Literal('OWNERSHIP_CONFLICT'),
  Type.Literal('QUANTITY_INVALID'),
  Type.Literal('RECIPE_INVALID'),
  Type.Literal('PRODUCTION_STATE_INVALID'),
  Type.Literal('CONTRACT_STATE_INVALID'),
  Type.Literal('JOB_COOLDOWN'),
  Type.Literal('JOB_CAP_EXCEEDED'),
  Type.Literal('LISTING_STALE'),
  Type.Literal('LISTING_EXPIRED'),
  Type.Literal('LISTING_NOT_OPEN'),
  Type.Literal('POLICY_INVALID'),
  Type.Literal('CONFLICT'),
  Type.Literal('INTERNAL_COMMAND_FAILED'),
]);

const EmptyEventIdsSchema = Type.Array(LedgerUuidSchema, { maxItems: 0 });
const SequenceRangeSchema = Type.Object(
  { from: LedgerPositiveIntegerStringSchema, to: LedgerPositiveIntegerStringSchema },
  { additionalProperties: false },
);
const WorldCommandResultBase = {
  commandId: LedgerUuidSchema,
  schemaVersion: Type.Literal(AUTHORITATIVE_COMMAND_SCHEMA_VERSION),
} as const;

export const WorldCommandAcceptedResultV1Schema = Type.Object(
  {
    ...WorldCommandResultBase,
    eventIds: Type.Array(LedgerUuidSchema, { maxItems: 64, minItems: 1, uniqueItems: true }),
    eventSequenceRange: SequenceRangeSchema,
    ledgerSequenceRange: SequenceRangeSchema,
    resultingStateRevision: LedgerPositiveIntegerStringSchema,
    status: Type.Literal('accepted'),
  },
  { additionalProperties: false },
);

export const WorldCommandRejectedResultV1Schema = Type.Object(
  {
    ...WorldCommandResultBase,
    currentStateRevision: LedgerNonNegativeIntegerStringSchema,
    eventIds: EmptyEventIdsSchema,
    rejectionCode: WorldCommandRejectionCodeSchema,
    status: Type.Literal('rejected'),
  },
  { additionalProperties: false },
);

export const WorldCommandReceivedResultV1Schema = Type.Object(
  {
    ...WorldCommandResultBase,
    eventIds: EmptyEventIdsSchema,
    status: Type.Literal('received'),
  },
  { additionalProperties: false },
);

export const WorldCommandFailedResultV1Schema = Type.Object(
  {
    ...WorldCommandResultBase,
    eventIds: EmptyEventIdsSchema,
    rejectionCode: Type.Literal('INTERNAL_COMMAND_FAILED'),
    status: Type.Literal('failed'),
  },
  { additionalProperties: false },
);

export const WorldCommandResultV1Schema = Type.Union(
  [
    WorldCommandAcceptedResultV1Schema,
    WorldCommandRejectedResultV1Schema,
    WorldCommandReceivedResultV1Schema,
    WorldCommandFailedResultV1Schema,
  ],
  { $id: 'WorldCommandResultV1' },
);

export const GenesisProjectionVersionsV1Schema = Type.Object(
  {
    controllers: Type.Literal(PROJECTION_SCHEMA_VERSION),
    entities: Type.Literal(PROJECTION_SCHEMA_VERSION),
    relationships: Type.Literal(PROJECTION_SCHEMA_VERSION),
    runtimeHead: Type.Literal(PROJECTION_SCHEMA_VERSION),
  },
  { additionalProperties: false },
);

export const GenesisProjectionRowCountsV1Schema = Type.Object(
  {
    controllers: LedgerNonNegativeIntegerStringSchema,
    entities: LedgerNonNegativeIntegerStringSchema,
    relationships: LedgerNonNegativeIntegerStringSchema,
  },
  { additionalProperties: false },
);

const GenesisPayloadFields = {
  activeWorldVersionId: LedgerUuidSchema,
  artifactHash: LedgerHashSchema,
  projectionSchemaVersions: GenesisProjectionVersionsV1Schema,
  rowCounts: GenesisProjectionRowCountsV1Schema,
  stateChecksum: LedgerHashSchema,
  worldVersionNumber: LedgerPositiveIntegerStringSchema,
} as const;

export const WorldStateImportedPayloadV1Schema = Type.Object(GenesisPayloadFields, {
  $id: 'WorldStateImportedPayloadV1',
  additionalProperties: false,
});

export const WorldCompiledGenesisPayloadV1Schema = Type.Object(
  { ...GenesisPayloadFields, compilationRunId: LedgerUuidSchema },
  { $id: 'WorldCompiledGenesisPayloadV1', additionalProperties: false },
);

export const WorldEntityRenamedPayloadV1Schema = Type.Object(
  {
    entityKey: WorldLogicalKeySchema,
    entityType: RenameableWorldEntityTypeSchema,
    entityVersion: LedgerPositiveIntegerStringSchema,
    newDisplayName: RenameWorldEntityPayloadV1Schema.properties.newDisplayName,
    previousDisplayName: RenameWorldEntityPayloadV1Schema.properties.newDisplayName,
  },
  { $id: 'WorldEntityRenamedPayloadV1', additionalProperties: false },
);

const LedgerWorldNameSchema = Type.String({
  maxLength: 100,
  minLength: 2,
  pattern: '^[^\\u0000-\\u001F\\u007F]+$',
});
const InvitationRoleSchema = Type.Union([Type.Literal('player'), Type.Literal('observer')]);

/** Lifecycle events emitted by pre-M06 public routes once a world has a genesis anchor. */
export const WorldRenamedPayloadV1Schema = Type.Object(
  { newName: LedgerWorldNameSchema, previousName: LedgerWorldNameSchema },
  { $id: 'WorldRenamedPayloadV1', additionalProperties: false },
);

export const WorldMembershipRoleChangedPayloadV1Schema = Type.Object(
  {
    newRole: WorldRoleSchema,
    previousRole: WorldRoleSchema,
    targetUserId: LedgerUuidSchema,
  },
  { $id: 'WorldMembershipRoleChangedPayloadV1', additionalProperties: false },
);

export const WorldMembershipRemovedPayloadV1Schema = Type.Object(
  { previousRole: WorldRoleSchema, targetUserId: LedgerUuidSchema },
  { $id: 'WorldMembershipRemovedPayloadV1', additionalProperties: false },
);

export const WorldInvitationCreatedPayloadV1Schema = Type.Object(
  { intendedRole: InvitationRoleSchema, invitationId: LedgerUuidSchema },
  { $id: 'WorldInvitationCreatedPayloadV1', additionalProperties: false },
);

export const WorldInvitationRevokedPayloadV1Schema = Type.Object(
  { intendedRole: InvitationRoleSchema, invitationId: LedgerUuidSchema },
  { $id: 'WorldInvitationRevokedPayloadV1', additionalProperties: false },
);

export const WorldInvitationAcceptedPayloadV1Schema = Type.Object(
  {
    intendedRole: InvitationRoleSchema,
    invitationId: LedgerUuidSchema,
    targetUserId: LedgerUuidSchema,
  },
  { $id: 'WorldInvitationAcceptedPayloadV1', additionalProperties: false },
);

export const ManifestRevisionCreatedPayloadV1Schema = Type.Object(
  {
    contentHash: LedgerHashSchema,
    manifestSchemaVersion: Type.Literal(1),
    revisionId: LedgerUuidSchema,
    revisionNumber: LedgerPositiveIntegerStringSchema,
    source: Type.Literal('manual'),
  },
  { $id: 'ManifestRevisionCreatedPayloadV1', additionalProperties: false },
);

export const ManifestApprovedPayloadV1Schema = Type.Object(
  {
    contentHash: LedgerHashSchema,
    manifestSchemaVersion: Type.Literal(1),
    revisionId: LedgerUuidSchema,
  },
  { $id: 'ManifestApprovedPayloadV1', additionalProperties: false },
);

export const CreatorOverrideUsedPayloadV1Schema = Type.Object(
  {
    authorityRuleId: Type.String({ maxLength: 120, minLength: 1 }),
    commandType: Type.String({ maxLength: 120, minLength: 1 }),
    overrideId: LedgerUuidSchema,
    reasonCode: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    targetId: Type.String({ maxLength: 240, minLength: 1 }),
    targetType: Type.String({ maxLength: 100, minLength: 1, pattern: '^[a-z][a-z0-9_]*$' }),
  },
  { $id: 'CreatorOverrideUsedPayloadV1', additionalProperties: false },
);

export const ProjectionRepairAnchoredPayloadV1Schema = Type.Object(
  {
    fromChecksum: LedgerHashSchema,
    projectionName: Type.String({ maxLength: 120, minLength: 1, pattern: '^[a-z][a-z0-9._-]*$' }),
    reasonCode: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    toChecksum: LedgerHashSchema,
  },
  { $id: 'ProjectionRepairAnchoredPayloadV1', additionalProperties: false },
);

export const DomainEventMetadataV1Schema = Type.Object(
  {
    actor: LedgerActorV1Schema,
    authorizationRuleId: Type.String({ maxLength: 120, minLength: 1 }),
    causationId: Type.Union([LedgerUuidSchema, Type.Null()]),
    commandSchemaVersion: Type.Literal(AUTHORITATIVE_COMMAND_SCHEMA_VERSION),
    commandType: Type.String({ maxLength: 120, minLength: 1 }),
    correlationId: LedgerUuidSchema,
    overrideId: Type.Union([LedgerUuidSchema, Type.Null()]),
    payloadClassification: LedgerPayloadClassificationSchema,
  },
  { additionalProperties: false },
);

const DomainEventCommonFields = {
  aggregateId: Type.String({ maxLength: 240, minLength: 1 }),
  aggregateType: Type.String({ maxLength: 100, minLength: 1, pattern: '^[a-z][a-z0-9_]*$' }),
  aggregateVersion: LedgerPositiveIntegerStringSchema,
  commandId: LedgerUuidSchema,
  eventHash: LedgerHashSchema,
  eventId: LedgerUuidSchema,
  eventOrdinal: Type.Integer({ maximum: 63, minimum: 0 }),
  eventSchemaVersion: Type.Literal(DOMAIN_EVENT_SCHEMA_VERSION),
  metadata: DomainEventMetadataV1Schema,
  occurredAt: LedgerCanonicalTimestampSchema,
  recordedAt: LedgerCanonicalTimestampSchema,
  resultingStateRevision: LedgerNonNegativeIntegerStringSchema,
  worldEventSequence: LedgerPositiveIntegerStringSchema,
  worldId: LedgerUuidSchema,
} as const;

function domainEventVariant<TType extends string, TPayload extends TSchema>(
  eventType: TType,
  payload: TPayload,
) {
  return Type.Object(
    { ...DomainEventCommonFields, eventType: Type.Literal(eventType), payload },
    { additionalProperties: false },
  );
}

export const WorldStateImportedEventV1Schema = domainEventVariant(
  'WorldStateImportedV1',
  WorldStateImportedPayloadV1Schema,
);
export const WorldCompiledGenesisEventV1Schema = domainEventVariant(
  'WorldCompiledGenesisV1',
  WorldCompiledGenesisPayloadV1Schema,
);
export const WorldEntityRenamedEventV1Schema = domainEventVariant(
  'WorldEntityRenamedV1',
  WorldEntityRenamedPayloadV1Schema,
);
export const WorldRenamedEventV1Schema = domainEventVariant(
  'WorldRenamedV1',
  WorldRenamedPayloadV1Schema,
);
export const WorldMembershipRoleChangedEventV1Schema = domainEventVariant(
  'WorldMembershipRoleChangedV1',
  WorldMembershipRoleChangedPayloadV1Schema,
);
export const WorldMembershipRemovedEventV1Schema = domainEventVariant(
  'WorldMembershipRemovedV1',
  WorldMembershipRemovedPayloadV1Schema,
);
export const WorldInvitationCreatedEventV1Schema = domainEventVariant(
  'WorldInvitationCreatedV1',
  WorldInvitationCreatedPayloadV1Schema,
);
export const WorldInvitationRevokedEventV1Schema = domainEventVariant(
  'WorldInvitationRevokedV1',
  WorldInvitationRevokedPayloadV1Schema,
);
export const WorldInvitationAcceptedEventV1Schema = domainEventVariant(
  'WorldInvitationAcceptedV1',
  WorldInvitationAcceptedPayloadV1Schema,
);
export const ManifestRevisionCreatedEventV1Schema = domainEventVariant(
  'ManifestRevisionCreatedV1',
  ManifestRevisionCreatedPayloadV1Schema,
);
export const ManifestApprovedEventV1Schema = domainEventVariant(
  'ManifestApprovedV1',
  ManifestApprovedPayloadV1Schema,
);
export const CreatorOverrideUsedEventV1Schema = domainEventVariant(
  'CreatorOverrideUsedV1',
  CreatorOverrideUsedPayloadV1Schema,
);
export const ProjectionRepairAnchoredEventV1Schema = domainEventVariant(
  'ProjectionRepairAnchoredV1',
  ProjectionRepairAnchoredPayloadV1Schema,
);
export const WorldSimulationInitializedEventV1Schema = domainEventVariant(
  'WorldSimulationInitializedV1',
  WorldSimulationInitializedPayloadV1Schema,
);
export const WorldClockConfiguredEventV1Schema = domainEventVariant(
  'WorldClockConfiguredV1',
  WorldClockConfiguredPayloadV1Schema,
);
export const WorldClockStartedEventV1Schema = domainEventVariant(
  'WorldClockStartedV1',
  WorldClockStartedPayloadV1Schema,
);
export const WorldClockPausedEventV1Schema = domainEventVariant(
  'WorldClockPausedV1',
  WorldClockPausedPayloadV1Schema,
);
export const SimulationAdvancedEventV1Schema = domainEventVariant(
  'SimulationAdvancedV1',
  SimulationAdvancedPayloadV1Schema,
);
export const ScheduledActionCreatedEventV1Schema = domainEventVariant(
  'ScheduledActionCreatedV1',
  ScheduledActionCreatedPayloadV1Schema,
);
export const ScheduledActionCancelledEventV1Schema = domainEventVariant(
  'ScheduledActionCancelledV1',
  ScheduledActionCancelledPayloadV1Schema,
);
export const ScheduledActionExecutedEventV1Schema = domainEventVariant(
  'ScheduledActionExecutedV1',
  ScheduledActionExecutedPayloadV1Schema,
);
export const WorldNoticeEmittedEventV1Schema = domainEventVariant(
  'WorldNoticeEmittedV1',
  WorldNoticeEmittedPayloadV1Schema,
);
export const SimulationFailureRecordedEventV1Schema = domainEventVariant(
  'SimulationFailureRecordedV1',
  SimulationFailureRecordedPayloadV1Schema,
);
export const SimulationFailureResolvedEventV1Schema = domainEventVariant(
  'SimulationFailureResolvedV1',
  SimulationFailureResolvedPayloadV1Schema,
);
export const WorldClockAutoPausedEventV1Schema = domainEventVariant(
  'WorldClockAutoPausedV1',
  WorldClockAutoPausedPayloadV1Schema,
);
export const LegacyEconomySeedPlanAdoptedEventV1Schema = domainEventVariant(
  'LegacyEconomySeedPlanAdoptedV1',
  LegacyEconomySeedPlanAdoptedPayloadV1Schema,
);
export const WorldEconomyInitializedEventV1Schema = domainEventVariant(
  'WorldEconomyInitializedV1',
  WorldEconomyInitializedPayloadV1Schema,
);
export const WorldEconomyReconciledEventV1Schema = domainEventVariant(
  'WorldEconomyReconciledV1',
  WorldEconomyReconciledPayloadV1Schema,
);
const WorldEconomyRepairedEventMetadataV1Schema = Type.Object(
  {
    actor: Type.Object(
      { actorId: LedgerUuidSchema, actorType: Type.Literal('platform_admin') },
      { additionalProperties: false },
    ),
    authorizationRuleId: Type.Literal('operations.economy.repair.execute'),
    causationId: LedgerUuidSchema,
    commandSchemaVersion: Type.Literal(AUTHORITATIVE_COMMAND_SCHEMA_VERSION),
    commandType: Type.Literal('RepairWorldEconomyV1'),
    correlationId: LedgerUuidSchema,
    overrideId: LedgerUuidSchema,
    payloadClassification: Type.Literal('private'),
  },
  { additionalProperties: false },
);
export const WorldEconomyRepairedEventV1Schema = Type.Object(
  {
    ...DomainEventCommonFields,
    eventType: Type.Literal('WorldEconomyRepairedV1'),
    metadata: WorldEconomyRepairedEventMetadataV1Schema,
    payload: WorldEconomyRepairedPayloadV1Schema,
  },
  { additionalProperties: false },
);
export const CurrencyIssuedEventV1Schema = domainEventVariant(
  'CurrencyIssuedV1',
  CurrencyIssuedPayloadV1Schema,
);
export const CurrencyTransferredEventV1Schema = domainEventVariant(
  'CurrencyTransferredV1',
  CurrencyTransferredPayloadV1Schema,
);
export const CurrencyFrozenEventV1Schema = domainEventVariant(
  'CurrencyFrozenV1',
  CurrencyFrozenPayloadV1Schema,
);
export const CurrencyUnfrozenEventV1Schema = domainEventVariant(
  'CurrencyUnfrozenV1',
  CurrencyUnfrozenPayloadV1Schema,
);
export const WalletFrozenEventV1Schema = domainEventVariant(
  'WalletFrozenV1',
  WalletFrozenPayloadV1Schema,
);
export const WalletUnfrozenEventV1Schema = domainEventVariant(
  'WalletUnfrozenV1',
  WalletUnfrozenPayloadV1Schema,
);
export const AssetOwnershipTransferredEventV1Schema = domainEventVariant(
  'AssetOwnershipTransferredV1',
  AssetOwnershipTransferredPayloadV1Schema,
);
export const AssetTransferOfferCreatedEventV1Schema = domainEventVariant(
  'AssetTransferOfferCreatedV1',
  AssetTransferOfferCreatedPayloadV1Schema,
);
export const AssetTransferOfferCancelledEventV1Schema = domainEventVariant(
  'AssetTransferOfferCancelledV1',
  AssetTransferOfferCancelledPayloadV1Schema,
);
export const AssetTransferOfferAcceptedEventV1Schema = domainEventVariant(
  'AssetTransferOfferAcceptedV1',
  AssetTransferOfferAcceptedPayloadV1Schema,
);
export const AssetTransferOfferExpiredEventV1Schema = domainEventVariant(
  'AssetTransferOfferExpiredV1',
  AssetTransferOfferExpiredPayloadV1Schema,
);
export const AssetPurchasedEventV1Schema = domainEventVariant(
  'AssetPurchasedV1',
  AssetPurchasedPayloadV1Schema,
);
export const WorldCommerceInitializedEventV1Schema = domainEventVariant(
  'WorldCommerceInitializedV1',
  WorldCommerceInitializedPayloadV1Schema,
);
export const BusinessCreatedEventV1Schema = domainEventVariant(
  'BusinessCreatedV1',
  BusinessCreatedPayloadV1Schema,
);
export const BusinessFacilityConfiguredEventV1Schema = domainEventVariant(
  'BusinessFacilityConfiguredV1',
  BusinessFacilityConfiguredPayloadV1Schema,
);
export const EmploymentContractCreatedEventV1Schema = domainEventVariant(
  'EmploymentContractCreatedV1',
  EmploymentContractLifecyclePayloadV1Schema,
);
export const EmploymentContractAcceptedEventV1Schema = domainEventVariant(
  'EmploymentContractAcceptedV1',
  EmploymentContractLifecyclePayloadV1Schema,
);
export const EmploymentContractEndedEventV1Schema = domainEventVariant(
  'EmploymentContractEndedV1',
  EmploymentContractLifecyclePayloadV1Schema,
);
export const WorkRecordedEventV1Schema = domainEventVariant(
  'WorkRecordedV1',
  WorkRecordedPayloadV1Schema,
);
export const PayrollSettledEventV1Schema = domainEventVariant(
  'PayrollSettledV1',
  PayrollSettledPayloadV1Schema,
);
export const PayrollFailedEventV1Schema = domainEventVariant(
  'PayrollFailedV1',
  PayrollFailedPayloadV1Schema,
);
export const ProductionRunStartedEventV1Schema = domainEventVariant(
  'ProductionRunStartedV1',
  ProductionRunStartedPayloadV1Schema,
);
export const ResourcesConsumedEventV1Schema = domainEventVariant(
  'ResourcesConsumedV1',
  ProductionResourcesPayloadV1Schema,
);
export const ResourcesProducedEventV1Schema = domainEventVariant(
  'ResourcesProducedV1',
  ProductionResourcesPayloadV1Schema,
);
export const ProductionFailedEventV1Schema = domainEventVariant(
  'ProductionFailedV1',
  ProductionFailedPayloadV1Schema,
);
export const MarketListingCreatedEventV1Schema = domainEventVariant(
  'MarketListingCreatedV1',
  MarketListingLifecyclePayloadV1Schema,
);
export const MarketListingCancelledEventV1Schema = domainEventVariant(
  'MarketListingCancelledV1',
  MarketListingLifecyclePayloadV1Schema,
);
export const MarketListingExpiredEventV1Schema = domainEventVariant(
  'MarketListingExpiredV1',
  MarketListingLifecyclePayloadV1Schema,
);
export const MarketListingPartiallyFilledEventV1Schema = domainEventVariant(
  'MarketListingPartiallyFilledV1',
  MarketListingLifecyclePayloadV1Schema,
);
export const MarketListingFilledEventV1Schema = domainEventVariant(
  'MarketListingFilledV1',
  MarketListingLifecyclePayloadV1Schema,
);
export const InventoryTransferredEventV1Schema = domainEventVariant(
  'InventoryTransferredV1',
  InventoryTransferredPayloadV1Schema,
);
export const MarketTradeCompletedEventV1Schema = domainEventVariant(
  'MarketTradeCompletedV1',
  MarketTradeCompletedPayloadV1Schema,
);
export const TaxAssessedEventV1Schema = domainEventVariant(
  'TaxAssessedV1',
  TaxAssessedPayloadV1Schema,
);
export const TreasuryRevenueRecordedEventV1Schema = domainEventVariant(
  'TreasuryRevenueRecordedV1',
  TreasuryRevenueRecordedPayloadV1Schema,
);
export const WorldCommerceReconciledEventV1Schema = domainEventVariant(
  'WorldCommerceReconciledV1',
  WorldCommerceReconciledPayloadV1Schema,
);
const WorldCommerceProjectionRepairedEventMetadataV1Schema = Type.Object(
  {
    actor: Type.Object(
      { actorId: LedgerUuidSchema, actorType: Type.Literal('platform_admin') },
      { additionalProperties: false },
    ),
    authorizationRuleId: Type.Literal('operations.commerce_projection.repair.execute'),
    causationId: LedgerUuidSchema,
    commandSchemaVersion: Type.Literal(AUTHORITATIVE_COMMAND_SCHEMA_VERSION),
    commandType: Type.Literal('RepairEconomicProjectionV1'),
    correlationId: LedgerUuidSchema,
    overrideId: LedgerUuidSchema,
    payloadClassification: Type.Literal('private'),
  },
  { additionalProperties: false },
);
export const WorldCommerceProjectionRepairedEventV1Schema = Type.Object(
  {
    ...DomainEventCommonFields,
    aggregateType: Type.Literal('world_commerce_repair'),
    eventType: Type.Literal('WorldCommerceProjectionRepairedV1'),
    metadata: WorldCommerceProjectionRepairedEventMetadataV1Schema,
    payload: WorldCommerceProjectionRepairedPayloadV1Schema,
  },
  { additionalProperties: false },
);

export const DomainEventEnvelopeV1Schema = Type.Union(
  [
    WorldStateImportedEventV1Schema,
    WorldCompiledGenesisEventV1Schema,
    WorldEntityRenamedEventV1Schema,
    WorldRenamedEventV1Schema,
    WorldMembershipRoleChangedEventV1Schema,
    WorldMembershipRemovedEventV1Schema,
    WorldInvitationCreatedEventV1Schema,
    WorldInvitationRevokedEventV1Schema,
    WorldInvitationAcceptedEventV1Schema,
    ManifestRevisionCreatedEventV1Schema,
    ManifestApprovedEventV1Schema,
    CreatorOverrideUsedEventV1Schema,
    ProjectionRepairAnchoredEventV1Schema,
    WorldSimulationInitializedEventV1Schema,
    WorldClockConfiguredEventV1Schema,
    WorldClockStartedEventV1Schema,
    WorldClockPausedEventV1Schema,
    SimulationAdvancedEventV1Schema,
    ScheduledActionCreatedEventV1Schema,
    ScheduledActionCancelledEventV1Schema,
    ScheduledActionExecutedEventV1Schema,
    WorldNoticeEmittedEventV1Schema,
    SimulationFailureRecordedEventV1Schema,
    SimulationFailureResolvedEventV1Schema,
    WorldClockAutoPausedEventV1Schema,
    LegacyEconomySeedPlanAdoptedEventV1Schema,
    WorldEconomyInitializedEventV1Schema,
    WorldEconomyReconciledEventV1Schema,
    WorldEconomyRepairedEventV1Schema,
    CurrencyIssuedEventV1Schema,
    CurrencyTransferredEventV1Schema,
    CurrencyFrozenEventV1Schema,
    CurrencyUnfrozenEventV1Schema,
    WalletFrozenEventV1Schema,
    WalletUnfrozenEventV1Schema,
    AssetOwnershipTransferredEventV1Schema,
    AssetTransferOfferCreatedEventV1Schema,
    AssetTransferOfferCancelledEventV1Schema,
    AssetTransferOfferAcceptedEventV1Schema,
    AssetTransferOfferExpiredEventV1Schema,
    AssetPurchasedEventV1Schema,
    WorldCommerceInitializedEventV1Schema,
    BusinessCreatedEventV1Schema,
    BusinessFacilityConfiguredEventV1Schema,
    EmploymentContractCreatedEventV1Schema,
    EmploymentContractAcceptedEventV1Schema,
    EmploymentContractEndedEventV1Schema,
    WorkRecordedEventV1Schema,
    PayrollSettledEventV1Schema,
    PayrollFailedEventV1Schema,
    ProductionRunStartedEventV1Schema,
    ResourcesConsumedEventV1Schema,
    ResourcesProducedEventV1Schema,
    ProductionFailedEventV1Schema,
    MarketListingCreatedEventV1Schema,
    MarketListingCancelledEventV1Schema,
    MarketListingExpiredEventV1Schema,
    MarketListingPartiallyFilledEventV1Schema,
    MarketListingFilledEventV1Schema,
    InventoryTransferredEventV1Schema,
    MarketTradeCompletedEventV1Schema,
    TaxAssessedEventV1Schema,
    TreasuryRevenueRecordedEventV1Schema,
    WorldCommerceReconciledEventV1Schema,
    WorldCommerceProjectionRepairedEventV1Schema,
  ],
  { $id: 'DomainEventEnvelopeV1' },
);

export const LedgerEntryKindSchema = Type.Union([
  Type.Literal('command_accepted'),
  Type.Literal('command_rejected'),
  Type.Literal('domain_event'),
  Type.Literal('override'),
  Type.Literal('repair_anchor'),
]);

const LedgerEntryCommonFields = {
  actor: LedgerActorV1Schema,
  entryHash: LedgerHashSchema,
  entryId: LedgerUuidSchema,
  ledgerSchemaVersion: Type.Literal(LEDGER_SCHEMA_VERSION),
  ledgerSequence: LedgerPositiveIntegerStringSchema,
  previousHash: LedgerHashSchema,
  publicSummaryCode: Type.String({
    maxLength: 100,
    minLength: 1,
    pattern: '^[A-Z][A-Z0-9_]*$',
  }),
  recordedAt: LedgerCanonicalTimestampSchema,
  redactedDetails: ManifestJsonObjectSchema,
  worldId: LedgerUuidSchema,
} as const;

const commandLedgerEntry = (kind: 'command_accepted' | 'command_rejected') =>
  Type.Object(
    {
      ...LedgerEntryCommonFields,
      commandId: LedgerUuidSchema,
      entryKind: Type.Literal(kind),
      eventId: Type.Null(),
    },
    { additionalProperties: false },
  );

const eventLedgerEntry = (kind: 'domain_event' | 'override' | 'repair_anchor') =>
  Type.Object(
    {
      ...LedgerEntryCommonFields,
      commandId: Type.Union([LedgerUuidSchema, Type.Null()]),
      entryKind: Type.Literal(kind),
      eventId: LedgerUuidSchema,
    },
    { additionalProperties: false },
  );

export const LedgerEntryV1Schema = Type.Union(
  [
    commandLedgerEntry('command_accepted'),
    commandLedgerEntry('command_rejected'),
    eventLedgerEntry('domain_event'),
    eventLedgerEntry('override'),
    eventLedgerEntry('repair_anchor'),
  ],
  { $id: 'LedgerEntryV1' },
);

export const ProjectionCheckpointV1Schema = Type.Object(
  {
    checksum: LedgerHashSchema,
    lastEventSequence: LedgerNonNegativeIntegerStringSchema,
    projectionName: Type.String({ maxLength: 120, minLength: 1, pattern: '^[a-z][a-z0-9._-]*$' }),
    projectionSchemaVersion: Type.Literal(PROJECTION_SCHEMA_VERSION),
    status: Type.Union([
      Type.Literal('current'),
      Type.Literal('rebuilding'),
      Type.Literal('diverged'),
      Type.Literal('failed'),
    ]),
    updatedAt: LedgerCanonicalTimestampSchema,
    worldId: LedgerUuidSchema,
  },
  { $id: 'ProjectionCheckpointV1', additionalProperties: false },
);

export const DomainEventReferenceMessageV1Schema = Type.Object(
  {
    eventId: LedgerUuidSchema,
    eventType: Type.String({ maxLength: 120, minLength: 1 }),
    worldEventSequence: LedgerPositiveIntegerStringSchema,
    worldId: LedgerUuidSchema,
  },
  { additionalProperties: false },
);

export const OutboxMessageV1Schema = Type.Object(
  {
    messageId: LedgerUuidSchema,
    messageSchemaVersion: Type.Literal(OUTBOX_SCHEMA_VERSION),
    messageType: Type.Literal('DomainEventReferenceV1'),
    payload: DomainEventReferenceMessageV1Schema,
  },
  { $id: 'OutboxMessageV1', additionalProperties: false },
);

export const WorldHistoryCategorySchema = Type.Union([
  Type.Literal('command'),
  Type.Literal('genesis'),
  Type.Literal('world'),
  Type.Literal('entity'),
  Type.Literal('membership'),
  Type.Literal('invitation'),
  Type.Literal('manifest'),
  Type.Literal('authority'),
  Type.Literal('system'),
  Type.Literal('repair'),
  Type.Literal('simulation'),
  Type.Literal('economy'),
  Type.Literal('ownership'),
]);

export const WorldHistoryEntryV1Schema = Type.Object(
  {
    actor: LedgerActorV1Schema,
    category: WorldHistoryCategorySchema,
    commandId: Type.Union([LedgerUuidSchema, Type.Null()]),
    correlationId: LedgerUuidSchema,
    eventId: Type.Union([LedgerUuidSchema, Type.Null()]),
    eventType: Type.Union([Type.String({ maxLength: 120, minLength: 1 }), Type.Null()]),
    historySchemaVersion: Type.Literal(HISTORY_SCHEMA_VERSION),
    ledgerSequence: LedgerPositiveIntegerStringSchema,
    occurredAt: LedgerCanonicalTimestampSchema,
    resultingStateRevision: Type.Union([LedgerNonNegativeIntegerStringSchema, Type.Null()]),
    summaryArgs: ManifestJsonObjectSchema,
    targetId: Type.Union([Type.String({ maxLength: 240, minLength: 1 }), Type.Null()]),
    targetType: Type.Union([
      Type.String({ maxLength: 100, minLength: 1, pattern: '^[a-z][a-z0-9_]*$' }),
      Type.Null(),
    ]),
    titleKey: Type.String({
      maxLength: 160,
      minLength: 3,
      pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$',
    }),
    visibility: LedgerVisibilitySchema,
    worldId: LedgerUuidSchema,
  },
  { $id: 'WorldHistoryEntryV1', additionalProperties: false },
);

export const WorldHistoryListQueryV1Schema = Type.Object(
  {
    actorId: Type.Optional(Type.String({ maxLength: 160, minLength: 3 })),
    actorType: Type.Optional(LedgerActorTypeSchema),
    category: Type.Optional(WorldHistoryCategorySchema),
    cursor: Type.Optional(Type.String({ maxLength: 1_024, minLength: 16 })),
    eventType: Type.Optional(Type.String({ maxLength: 120, minLength: 1 })),
    limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
    targetId: Type.Optional(Type.String({ maxLength: 240, minLength: 1 })),
    targetType: Type.Optional(
      Type.String({ maxLength: 100, minLength: 1, pattern: '^[a-z][a-z0-9_]*$' }),
    ),
  },
  { additionalProperties: false },
);

export const WorldHistoryListResponseV1Schema = Type.Object(
  {
    items: Type.Array(WorldHistoryEntryV1Schema, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String({ maxLength: 1_024, minLength: 16 }), Type.Null()]),
  },
  { $id: 'WorldHistoryListResponseV1', additionalProperties: false },
);

export type LedgerActorType = Static<typeof LedgerActorTypeSchema>;
export type LedgerActorV1 = Static<typeof LedgerActorV1Schema>;
export type LedgerPayloadClassification = Static<typeof LedgerPayloadClassificationSchema>;
export type LedgerVisibility = Static<typeof LedgerVisibilitySchema>;
export type RenameableWorldEntityType = Static<typeof RenameableWorldEntityTypeSchema>;
export type RenameWorldEntityPayloadV1 = Static<typeof RenameWorldEntityPayloadV1Schema>;
export type WorldCommandRequestV1 = Static<typeof WorldCommandRequestV1Schema>;
export type WorldCommandEnvelopeV1 = Static<typeof WorldCommandEnvelopeV1Schema>;
export type WorldCommandRejectionCode = Static<typeof WorldCommandRejectionCodeSchema>;
export type WorldCommandAcceptedResultV1 = Static<typeof WorldCommandAcceptedResultV1Schema>;
export type WorldCommandRejectedResultV1 = Static<typeof WorldCommandRejectedResultV1Schema>;
export type WorldCommandResultV1 = Static<typeof WorldCommandResultV1Schema>;
export type WorldStateImportedPayloadV1 = Static<typeof WorldStateImportedPayloadV1Schema>;
export type WorldCompiledGenesisPayloadV1 = Static<typeof WorldCompiledGenesisPayloadV1Schema>;
export type WorldEntityRenamedPayloadV1 = Static<typeof WorldEntityRenamedPayloadV1Schema>;
export type WorldRenamedPayloadV1 = Static<typeof WorldRenamedPayloadV1Schema>;
export type WorldMembershipRoleChangedPayloadV1 = Static<
  typeof WorldMembershipRoleChangedPayloadV1Schema
>;
export type WorldMembershipRemovedPayloadV1 = Static<typeof WorldMembershipRemovedPayloadV1Schema>;
export type WorldInvitationCreatedPayloadV1 = Static<typeof WorldInvitationCreatedPayloadV1Schema>;
export type WorldInvitationRevokedPayloadV1 = Static<typeof WorldInvitationRevokedPayloadV1Schema>;
export type WorldInvitationAcceptedPayloadV1 = Static<
  typeof WorldInvitationAcceptedPayloadV1Schema
>;
export type ManifestRevisionCreatedPayloadV1 = Static<
  typeof ManifestRevisionCreatedPayloadV1Schema
>;
export type ManifestApprovedPayloadV1 = Static<typeof ManifestApprovedPayloadV1Schema>;
export type CreatorOverrideUsedPayloadV1 = Static<typeof CreatorOverrideUsedPayloadV1Schema>;
export type ProjectionRepairAnchoredPayloadV1 = Static<
  typeof ProjectionRepairAnchoredPayloadV1Schema
>;
export type {
  ScheduledActionCancelledPayloadV1,
  ScheduledActionCreatedPayloadV1,
  ScheduledActionExecutedPayloadV1,
  SimulationAdvancedPayloadV1,
  SimulationFailureRecordedPayloadV1,
  SimulationFailureResolvedPayloadV1,
  WorldClockAutoPausedPayloadV1,
  WorldClockConfiguredPayloadV1,
  WorldClockPausedPayloadV1,
  WorldClockStartedPayloadV1,
  WorldNoticeEmittedPayloadV1,
  WorldSimulationInitializedPayloadV1,
};
export type DomainEventMetadataV1 = Static<typeof DomainEventMetadataV1Schema>;
export type WorldStateImportedEventV1 = Static<typeof WorldStateImportedEventV1Schema>;
export type WorldCompiledGenesisEventV1 = Static<typeof WorldCompiledGenesisEventV1Schema>;
export type WorldEntityRenamedEventV1 = Static<typeof WorldEntityRenamedEventV1Schema>;
export type WorldRenamedEventV1 = Static<typeof WorldRenamedEventV1Schema>;
export type WorldMembershipRoleChangedEventV1 = Static<
  typeof WorldMembershipRoleChangedEventV1Schema
>;
export type WorldMembershipRemovedEventV1 = Static<typeof WorldMembershipRemovedEventV1Schema>;
export type WorldInvitationCreatedEventV1 = Static<typeof WorldInvitationCreatedEventV1Schema>;
export type WorldInvitationRevokedEventV1 = Static<typeof WorldInvitationRevokedEventV1Schema>;
export type WorldInvitationAcceptedEventV1 = Static<typeof WorldInvitationAcceptedEventV1Schema>;
export type ManifestRevisionCreatedEventV1 = Static<typeof ManifestRevisionCreatedEventV1Schema>;
export type ManifestApprovedEventV1 = Static<typeof ManifestApprovedEventV1Schema>;
export type WorldSimulationInitializedEventV1 = Static<
  typeof WorldSimulationInitializedEventV1Schema
>;
export type WorldClockConfiguredEventV1 = Static<typeof WorldClockConfiguredEventV1Schema>;
export type WorldClockStartedEventV1 = Static<typeof WorldClockStartedEventV1Schema>;
export type WorldClockPausedEventV1 = Static<typeof WorldClockPausedEventV1Schema>;
export type SimulationAdvancedEventV1 = Static<typeof SimulationAdvancedEventV1Schema>;
export type ScheduledActionCreatedEventV1 = Static<typeof ScheduledActionCreatedEventV1Schema>;
export type ScheduledActionCancelledEventV1 = Static<typeof ScheduledActionCancelledEventV1Schema>;
export type ScheduledActionExecutedEventV1 = Static<typeof ScheduledActionExecutedEventV1Schema>;
export type WorldNoticeEmittedEventV1 = Static<typeof WorldNoticeEmittedEventV1Schema>;
export type SimulationFailureRecordedEventV1 = Static<
  typeof SimulationFailureRecordedEventV1Schema
>;
export type SimulationFailureResolvedEventV1 = Static<
  typeof SimulationFailureResolvedEventV1Schema
>;
export type WorldClockAutoPausedEventV1 = Static<typeof WorldClockAutoPausedEventV1Schema>;
export type {
  AssetOwnershipTransferredPayloadV1,
  AssetPurchasedPayloadV1,
  AssetTransferOfferAcceptedPayloadV1,
  AssetTransferOfferCancelledPayloadV1,
  AssetTransferOfferCreatedPayloadV1,
  AssetTransferOfferExpiredPayloadV1,
  CurrencyFrozenPayloadV1,
  CurrencyIssuedPayloadV1,
  CurrencyTransferredPayloadV1,
  CurrencyUnfrozenPayloadV1,
  LegacyEconomySeedPlanAdoptedPayloadV1,
  WalletFrozenPayloadV1,
  WalletUnfrozenPayloadV1,
  WorldEconomyInitializedPayloadV1,
  WorldEconomyReconciledPayloadV1,
  WorldEconomyRepairedPayloadV1,
};
export type LegacyEconomySeedPlanAdoptedEventV1 = Static<
  typeof LegacyEconomySeedPlanAdoptedEventV1Schema
>;
export type WorldEconomyInitializedEventV1 = Static<typeof WorldEconomyInitializedEventV1Schema>;
export type WorldEconomyReconciledEventV1 = Static<typeof WorldEconomyReconciledEventV1Schema>;
export type WorldEconomyRepairedEventV1 = Static<typeof WorldEconomyRepairedEventV1Schema>;
export type CurrencyIssuedEventV1 = Static<typeof CurrencyIssuedEventV1Schema>;
export type CurrencyTransferredEventV1 = Static<typeof CurrencyTransferredEventV1Schema>;
export type CurrencyFrozenEventV1 = Static<typeof CurrencyFrozenEventV1Schema>;
export type CurrencyUnfrozenEventV1 = Static<typeof CurrencyUnfrozenEventV1Schema>;
export type WalletFrozenEventV1 = Static<typeof WalletFrozenEventV1Schema>;
export type WalletUnfrozenEventV1 = Static<typeof WalletUnfrozenEventV1Schema>;
export type AssetOwnershipTransferredEventV1 = Static<
  typeof AssetOwnershipTransferredEventV1Schema
>;
export type AssetTransferOfferCreatedEventV1 = Static<
  typeof AssetTransferOfferCreatedEventV1Schema
>;
export type AssetTransferOfferCancelledEventV1 = Static<
  typeof AssetTransferOfferCancelledEventV1Schema
>;
export type AssetTransferOfferAcceptedEventV1 = Static<
  typeof AssetTransferOfferAcceptedEventV1Schema
>;
export type AssetTransferOfferExpiredEventV1 = Static<
  typeof AssetTransferOfferExpiredEventV1Schema
>;
export type AssetPurchasedEventV1 = Static<typeof AssetPurchasedEventV1Schema>;
export type WorldCommerceInitializedEventV1 = Static<typeof WorldCommerceInitializedEventV1Schema>;
export type BusinessCreatedEventV1 = Static<typeof BusinessCreatedEventV1Schema>;
export type BusinessFacilityConfiguredEventV1 = Static<
  typeof BusinessFacilityConfiguredEventV1Schema
>;
export type EmploymentContractCreatedEventV1 = Static<
  typeof EmploymentContractCreatedEventV1Schema
>;
export type EmploymentContractAcceptedEventV1 = Static<
  typeof EmploymentContractAcceptedEventV1Schema
>;
export type EmploymentContractEndedEventV1 = Static<typeof EmploymentContractEndedEventV1Schema>;
export type WorkRecordedEventV1 = Static<typeof WorkRecordedEventV1Schema>;
export type PayrollSettledEventV1 = Static<typeof PayrollSettledEventV1Schema>;
export type PayrollFailedEventV1 = Static<typeof PayrollFailedEventV1Schema>;
export type ProductionRunStartedEventV1 = Static<typeof ProductionRunStartedEventV1Schema>;
export type ResourcesConsumedEventV1 = Static<typeof ResourcesConsumedEventV1Schema>;
export type ResourcesProducedEventV1 = Static<typeof ResourcesProducedEventV1Schema>;
export type ProductionFailedEventV1 = Static<typeof ProductionFailedEventV1Schema>;
export type MarketListingCreatedEventV1 = Static<typeof MarketListingCreatedEventV1Schema>;
export type MarketListingCancelledEventV1 = Static<typeof MarketListingCancelledEventV1Schema>;
export type MarketListingExpiredEventV1 = Static<typeof MarketListingExpiredEventV1Schema>;
export type MarketListingPartiallyFilledEventV1 = Static<
  typeof MarketListingPartiallyFilledEventV1Schema
>;
export type MarketListingFilledEventV1 = Static<typeof MarketListingFilledEventV1Schema>;
export type InventoryTransferredEventV1 = Static<typeof InventoryTransferredEventV1Schema>;
export type MarketTradeCompletedEventV1 = Static<typeof MarketTradeCompletedEventV1Schema>;
export type TaxAssessedEventV1 = Static<typeof TaxAssessedEventV1Schema>;
export type TreasuryRevenueRecordedEventV1 = Static<typeof TreasuryRevenueRecordedEventV1Schema>;
export type WorldCommerceReconciledEventV1 = Static<typeof WorldCommerceReconciledEventV1Schema>;
export type WorldCommerceProjectionRepairedEventV1 = Static<
  typeof WorldCommerceProjectionRepairedEventV1Schema
>;
export type DomainEventEnvelopeV1 = Static<typeof DomainEventEnvelopeV1Schema>;
export type LedgerEntryKind = Static<typeof LedgerEntryKindSchema>;
export type LedgerEntryV1 = Static<typeof LedgerEntryV1Schema>;
export type ProjectionCheckpointV1 = Static<typeof ProjectionCheckpointV1Schema>;
export type OutboxMessageV1 = Static<typeof OutboxMessageV1Schema>;
export type WorldHistoryCategory = Static<typeof WorldHistoryCategorySchema>;
export type WorldHistoryEntryV1 = Static<typeof WorldHistoryEntryV1Schema>;
export type WorldHistoryListQueryV1 = Static<typeof WorldHistoryListQueryV1Schema>;
export type WorldHistoryListResponseV1 = Static<typeof WorldHistoryListResponseV1Schema>;
