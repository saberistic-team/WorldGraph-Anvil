import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { IdempotencyKeySchema } from './commands.js';
import { ManifestJsonObjectSchema } from './manifests.js';
import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  SIMULATION_BATCH_SCHEMA_VERSION,
  SIMULATION_CLOCK_SCHEMA_VERSION,
  SIMULATION_FAILURE_SCHEMA_VERSION,
  SIMULATION_OUTCOME_SCHEMA_VERSION,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  LEGACY_SIMULATION_PROCESS_REGISTRY_VERSION,
  PREVIOUS_SIMULATION_PROCESS_REGISTRY_VERSION,
  SIMULATION_PROCESS_SCHEMA_VERSION,
  SIMULATION_PROCESS_REGISTRY_VERSION,
  SIMULATION_PROJECTION_SCHEMA_VERSION,
  SIMULATION_QUEUE_SCHEMA_VERSION,
  SIMULATION_SCHEDULE_SCHEMA_VERSION,
} from './versions.js';

export const EMIT_WORLD_NOTICE_PROCESS_VERSION = '1.0.0' as const;
export const COMPLETE_PRODUCTION_RUN_PROCESS_VERSION = '1.0.0' as const;
export const SETTLE_PAYROLL_PROCESS_VERSION = '1.0.0' as const;
export const EXPIRE_MARKET_LISTING_PROCESS_VERSION = '1.0.0' as const;
export const ASSESS_PERIODIC_TAX_PROCESS_VERSION = '1.0.0' as const;
export const GOVERNANCE_SCHEDULE_PROCESS_VERSION = '1.0.0' as const;
export const WORLD_CLOCK_FAILURE_SOURCE_TYPE = 'WorldClockV1' as const;
export const WORLD_CLOCK_FAILURE_SOURCE_VERSION = '1.0.0' as const;
export const DEFAULT_SIMULATION_EPOCH_AT = '2000-01-01T00:00:00.000Z' as const;
export const DEFAULT_WORLD_MILLISECONDS_PER_TICK = 86_400_000 as const;
export const DEFAULT_SIMULATION_WALL_CADENCE_MILLISECONDS = 10_000 as const;
export const DEFAULT_SIMULATION_MAX_BATCH_TICKS = 64 as const;
export const DEFAULT_SIMULATION_MAX_CATCH_UP_TICKS = 256 as const;

export const MAX_SIMULATION_WORLD_MILLISECONDS_PER_TICK = 31_536_000_000 as const;
export const MIN_SIMULATION_WALL_CADENCE_MILLISECONDS = 100 as const;
export const MAX_SIMULATION_WALL_CADENCE_MILLISECONDS = 86_400_000 as const;
export const MAX_SIMULATION_BATCH_TICKS = 256 as const;
export const MAX_SIMULATION_CATCH_UP_TICKS = 4_096 as const;
export const MAX_SIMULATION_EVENTS_PER_PROCESS = 64 as const;
export const MAX_SIMULATION_SCHEDULES_PER_PROCESS = 16 as const;
/** M06 event ordinals are 0..63, including the advance summary event. */
export const MAX_SIMULATION_EVENTS_PER_ADVANCE = 64 as const;
export const MAX_SIMULATION_SCHEDULES_PER_ADVANCE = 64 as const;
export const MAX_SCHEDULED_ACTIONS_PER_ACTOR = 1_000 as const;
/** Worst-case notice actions emit two events; one advance event reserves the remaining slot. */
export const MAX_SCHEDULED_ACTIONS_PER_TICK = 31 as const;
export const MAX_SCHEDULED_ACTIONS_PER_WORLD = 10_000 as const;
export const MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE = 1_000 as const;
export const MAX_WORLD_NOTICE_TEXT_LENGTH = 500 as const;

export const SimulationUuidSchema = Type.String({ format: 'uuid' });
export const SimulationHashSchema = Type.String({
  maxLength: 64,
  minLength: 64,
  pattern: '^[a-f0-9]{64}$',
});
export const SimulationTickSchema = Type.String({
  maxLength: 19,
  pattern: '^(?:0|[1-9][0-9]{0,18})$',
});
export const SimulationPositiveIntegerStringSchema = Type.String({
  maxLength: 19,
  pattern: '^[1-9][0-9]{0,18}$',
});
export const SimulationSignedIntegerStringSchema = Type.String({
  maxLength: 20,
  pattern: '^(?:0|-?[1-9][0-9]{0,18})$',
});
export const SimulationCanonicalTimestampSchema = Type.String({
  format: 'date-time',
  maxLength: 24,
  minLength: 24,
  pattern:
    '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$',
});
export const SimulationSafeTextSchema = Type.String({
  maxLength: MAX_WORLD_NOTICE_TEXT_LENGTH,
  minLength: 1,
  pattern: '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]+$',
});

export const SimulationClockModeSchema = Type.Union([
  Type.Literal('paused'),
  Type.Literal('running'),
  Type.Literal('error'),
]);
export const ScheduledActionStatusSchema = Type.Union([
  Type.Literal('scheduled'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
  Type.Literal('failed'),
]);
export const SimulationBatchStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);
export const SimulationFailureStatusSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('resolved'),
]);
export const SimulationFailureResolutionSchema = Type.Union([
  Type.Literal('cancel_action'),
  Type.Literal('retry_after_repair'),
]);
export const WorldNoticeVisibilitySchema = Type.Union([
  Type.Literal('public'),
  Type.Literal('member'),
  Type.Literal('creator'),
]);
export const SimulationActorTypeSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('system'),
  Type.Literal('platform_admin'),
]);
const SimulationSystemActorIdSchema = Type.String({
  maxLength: 160,
  minLength: 3,
  pattern: '^[a-z][a-z0-9._:-]*$',
});
export const SimulationSystemActorV1Schema = Type.Object(
  { actorId: SimulationSystemActorIdSchema, actorType: Type.Literal('system') },
  { additionalProperties: false },
);
export const SimulationActorV1Schema = Type.Union([
  Type.Object(
    { actorId: SimulationUuidSchema, actorType: Type.Literal('user') },
    { additionalProperties: false },
  ),
  Type.Object(
    { actorId: SimulationUuidSchema, actorType: Type.Literal('platform_admin') },
    { additionalProperties: false },
  ),
  SimulationSystemActorV1Schema,
]);
export const ScheduledActionTypeSchema = Type.Union([
  Type.Literal('EmitWorldNoticeV1'),
  Type.Literal('CompleteProductionRunV1'),
  Type.Literal('SettlePayrollV1'),
  Type.Literal('ExpireMarketListingV1'),
  Type.Literal('AssessPeriodicTaxV1'),
  Type.Literal('OpenProposalVotingV1'),
  Type.Literal('CloseAndTallyProposalV1'),
  Type.Literal('CertifyAndEnactProposalV1'),
  Type.Literal('OpenElectionV1'),
  Type.Literal('CloseAndTallyElectionV1'),
  Type.Literal('CertifyElectionV1'),
]);
export const CommerceScheduledActionTypeSchema = Type.Union([
  Type.Literal('CompleteProductionRunV1'),
  Type.Literal('SettlePayrollV1'),
  Type.Literal('ExpireMarketListingV1'),
  Type.Literal('AssessPeriodicTaxV1'),
]);
export const GovernanceScheduledActionTypeSchema = Type.Union([
  Type.Literal('OpenProposalVotingV1'),
  Type.Literal('CloseAndTallyProposalV1'),
  Type.Literal('CertifyAndEnactProposalV1'),
  Type.Literal('OpenElectionV1'),
  Type.Literal('CloseAndTallyElectionV1'),
  Type.Literal('CertifyElectionV1'),
]);
export const SimulationProcessTypeSchema = ScheduledActionTypeSchema;
export const SimulationProcessRegistryVersionSchema = Type.Union([
  Type.Literal(LEGACY_SIMULATION_PROCESS_REGISTRY_VERSION),
  Type.Literal(PREVIOUS_SIMULATION_PROCESS_REGISTRY_VERSION),
  Type.Literal(SIMULATION_PROCESS_REGISTRY_VERSION),
]);
export const SimulationFailureSourceTypeSchema = Type.Union([
  SimulationProcessTypeSchema,
  Type.Literal(WORLD_CLOCK_FAILURE_SOURCE_TYPE),
]);
export const SimulationFailureSourceVersionSchema = Type.Literal(
  WORLD_CLOCK_FAILURE_SOURCE_VERSION,
);

export const WorldClockConfigurationV1Schema = Type.Object(
  {
    epochAt: SimulationCanonicalTimestampSchema,
    maxBatchTicks: Type.Integer({ maximum: MAX_SIMULATION_BATCH_TICKS, minimum: 1 }),
    maxCatchUpTicks: Type.Integer({ maximum: MAX_SIMULATION_CATCH_UP_TICKS, minimum: 1 }),
    prngAlgorithmVersion: Type.Literal(SIMULATION_PRNG_ALGORITHM_VERSION),
    wallCadenceMilliseconds: Type.Integer({
      maximum: MAX_SIMULATION_WALL_CADENCE_MILLISECONDS,
      minimum: MIN_SIMULATION_WALL_CADENCE_MILLISECONDS,
    }),
    worldMillisecondsPerTick: Type.Integer({
      maximum: MAX_SIMULATION_WORLD_MILLISECONDS_PER_TICK,
      minimum: 1,
    }),
  },
  { additionalProperties: false },
);

export const WorldSimulationClockV1Schema = Type.Object(
  {
    clockSchemaVersion: Type.Literal(SIMULATION_CLOCK_SCHEMA_VERSION),
    configuration: WorldClockConfigurationV1Schema,
    currentTick: SimulationTickSchema,
    lastWallAnchorAt: Type.Union([SimulationCanonicalTimestampSchema, Type.Null()]),
    mode: SimulationClockModeSchema,
    outcomeHash: SimulationHashSchema,
    projectionSchemaVersion: Type.Literal(SIMULATION_PROJECTION_SCHEMA_VERSION),
    rowVersion: SimulationPositiveIntegerStringSchema,
    updatedAt: SimulationCanonicalTimestampSchema,
    updatedStateRevision: SimulationTickSchema,
    worldId: SimulationUuidSchema,
  },
  { $id: 'WorldSimulationClockV1', additionalProperties: false },
);

export const SimulationWorldTimeV1Schema = Type.Object(
  {
    epochAt: SimulationCanonicalTimestampSchema,
    tick: SimulationTickSchema,
    worldTimeAt: SimulationCanonicalTimestampSchema,
    worldTimeUnixMilliseconds: SimulationSignedIntegerStringSchema,
  },
  { $id: 'SimulationWorldTimeV1', additionalProperties: false },
);

export const EmitWorldNoticePayloadV1Schema = Type.Object(
  {
    text: SimulationSafeTextSchema,
    visibility: WorldNoticeVisibilitySchema,
  },
  { $id: 'EmitWorldNoticePayloadV1', additionalProperties: false },
);

/** Scheduler payloads contain only immutable target identities. */
export const CompleteProductionRunScheduledActionPayloadV1Schema = Type.Object(
  { productionRunId: SimulationUuidSchema },
  { $id: 'CompleteProductionRunScheduledActionPayloadV1', additionalProperties: false },
);
export const SettlePayrollScheduledActionPayloadV1Schema = Type.Object(
  { payrollRecordId: SimulationUuidSchema },
  { $id: 'SettlePayrollScheduledActionPayloadV1', additionalProperties: false },
);
export const ExpireMarketListingScheduledActionPayloadV1Schema = Type.Object(
  { listingId: SimulationUuidSchema },
  { $id: 'ExpireMarketListingScheduledActionPayloadV1', additionalProperties: false },
);
export const AssessPeriodicTaxScheduledActionPayloadV1Schema = Type.Object(
  { taxPolicyId: SimulationUuidSchema },
  { $id: 'AssessPeriodicTaxScheduledActionPayloadV1', additionalProperties: false },
);
export const OpenProposalVotingScheduledActionPayloadV1Schema = Type.Object(
  { proposalId: SimulationUuidSchema },
  { $id: 'OpenProposalVotingScheduledActionPayloadV1', additionalProperties: false },
);
export const CloseAndTallyProposalScheduledActionPayloadV1Schema = Type.Object(
  { proposalId: SimulationUuidSchema },
  { $id: 'CloseAndTallyProposalScheduledActionPayloadV1', additionalProperties: false },
);
export const CertifyAndEnactProposalScheduledActionPayloadV1Schema = Type.Object(
  { proposalId: SimulationUuidSchema },
  { $id: 'CertifyAndEnactProposalScheduledActionPayloadV1', additionalProperties: false },
);
export const OpenElectionScheduledActionPayloadV1Schema = Type.Object(
  { electionId: SimulationUuidSchema },
  { $id: 'OpenElectionScheduledActionPayloadV1', additionalProperties: false },
);
export const CloseAndTallyElectionScheduledActionPayloadV1Schema = Type.Object(
  { electionId: SimulationUuidSchema },
  { $id: 'CloseAndTallyElectionScheduledActionPayloadV1', additionalProperties: false },
);
export const CertifyElectionScheduledActionPayloadV1Schema = Type.Object(
  { electionId: SimulationUuidSchema },
  { $id: 'CertifyElectionScheduledActionPayloadV1', additionalProperties: false },
);
export const CommerceScheduledActionPayloadV1Schema = Type.Union([
  CompleteProductionRunScheduledActionPayloadV1Schema,
  SettlePayrollScheduledActionPayloadV1Schema,
  ExpireMarketListingScheduledActionPayloadV1Schema,
  AssessPeriodicTaxScheduledActionPayloadV1Schema,
]);
export const GovernanceScheduledActionPayloadV1Schema = Type.Union([
  OpenProposalVotingScheduledActionPayloadV1Schema,
  CloseAndTallyProposalScheduledActionPayloadV1Schema,
  CertifyAndEnactProposalScheduledActionPayloadV1Schema,
  OpenElectionScheduledActionPayloadV1Schema,
  CloseAndTallyElectionScheduledActionPayloadV1Schema,
  CertifyElectionScheduledActionPayloadV1Schema,
]);

const ScheduledActionCommonFields = {
  actionSchemaVersion: Type.Literal(SIMULATION_SCHEDULE_SCHEMA_VERSION),
  cancelledCommandId: Type.Union([SimulationUuidSchema, Type.Null()]),
  completedEventId: Type.Union([SimulationUuidSchema, Type.Null()]),
  completedStateRevision: Type.Union([SimulationPositiveIntegerStringSchema, Type.Null()]),
  createdAt: SimulationCanonicalTimestampSchema,
  createdBy: SimulationActorV1Schema,
  createdCommandId: SimulationUuidSchema,
  createdStateRevision: SimulationPositiveIntegerStringSchema,
  dueTick: SimulationTickSchema,
  id: SimulationUuidSchema,
  payloadHash: SimulationHashSchema,
  priority: Type.Integer({
    maximum: MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE,
    minimum: -MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE,
  }),
  scheduleSchemaVersion: Type.Literal(SIMULATION_SCHEDULE_SCHEMA_VERSION),
  scheduleSequence: SimulationPositiveIntegerStringSchema,
  status: ScheduledActionStatusSchema,
  updatedAt: SimulationCanonicalTimestampSchema,
  worldId: SimulationUuidSchema,
} as const;

function scheduledActionVariant<TType extends string, TPayload extends TSchema>(
  actionType: TType,
  payload: TPayload,
) {
  return Type.Object(
    {
      ...ScheduledActionCommonFields,
      actionType: Type.Literal(actionType),
      payload,
      processVersion: Type.Literal('1.0.0'),
    },
    { additionalProperties: false },
  );
}

export const ScheduledActionActorV1Schema = SimulationActorV1Schema;

export const ScheduledActionV1Schema = Type.Union(
  [
    scheduledActionVariant('EmitWorldNoticeV1', EmitWorldNoticePayloadV1Schema),
    scheduledActionVariant(
      'CompleteProductionRunV1',
      CompleteProductionRunScheduledActionPayloadV1Schema,
    ),
    scheduledActionVariant('SettlePayrollV1', SettlePayrollScheduledActionPayloadV1Schema),
    scheduledActionVariant(
      'ExpireMarketListingV1',
      ExpireMarketListingScheduledActionPayloadV1Schema,
    ),
    scheduledActionVariant('AssessPeriodicTaxV1', AssessPeriodicTaxScheduledActionPayloadV1Schema),
    scheduledActionVariant(
      'OpenProposalVotingV1',
      OpenProposalVotingScheduledActionPayloadV1Schema,
    ),
    scheduledActionVariant(
      'CloseAndTallyProposalV1',
      CloseAndTallyProposalScheduledActionPayloadV1Schema,
    ),
    scheduledActionVariant(
      'CertifyAndEnactProposalV1',
      CertifyAndEnactProposalScheduledActionPayloadV1Schema,
    ),
    scheduledActionVariant('OpenElectionV1', OpenElectionScheduledActionPayloadV1Schema),
    scheduledActionVariant(
      'CloseAndTallyElectionV1',
      CloseAndTallyElectionScheduledActionPayloadV1Schema,
    ),
    scheduledActionVariant('CertifyElectionV1', CertifyElectionScheduledActionPayloadV1Schema),
  ],
  { $id: 'ScheduledActionV1' },
);

export const SimulationBatchRunV1Schema = Type.Object(
  {
    attempts: Type.Integer({ maximum: 100, minimum: 1 }),
    batchKey: SimulationHashSchema,
    batchSchemaVersion: Type.Literal(SIMULATION_BATCH_SCHEMA_VERSION),
    commandId: Type.Union([SimulationUuidSchema, Type.Null()]),
    completedAt: Type.Union([SimulationCanonicalTimestampSchema, Type.Null()]),
    errorCode: Type.Union([
      Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
      Type.Null(),
    ]),
    fromTick: SimulationTickSchema,
    id: SimulationUuidSchema,
    inputChecksum: SimulationHashSchema,
    outcomeHash: Type.Union([SimulationHashSchema, Type.Null()]),
    processRegistryVersion: SimulationProcessRegistryVersionSchema,
    startedAt: SimulationCanonicalTimestampSchema,
    status: SimulationBatchStatusSchema,
    toTick: SimulationTickSchema,
    worldId: SimulationUuidSchema,
  },
  { $id: 'SimulationBatchRunV1', additionalProperties: false },
);

export const SimulationFailureV1Schema = Type.Object(
  {
    aggregateVersion: SimulationPositiveIntegerStringSchema,
    attempts: Type.Integer({ maximum: 100, minimum: 1 }),
    batchRunId: SimulationUuidSchema,
    errorCode: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    failureSchemaVersion: Type.Literal(SIMULATION_FAILURE_SCHEMA_VERSION),
    id: SimulationUuidSchema,
    openedAt: SimulationCanonicalTimestampSchema,
    processType: SimulationFailureSourceTypeSchema,
    processVersion: SimulationFailureSourceVersionSchema,
    redactedContext: ManifestJsonObjectSchema,
    resolutionCommandId: Type.Union([SimulationUuidSchema, Type.Null()]),
    resolvedAt: Type.Union([SimulationCanonicalTimestampSchema, Type.Null()]),
    resolvedByActorId: Type.Union([Type.String({ maxLength: 160, minLength: 3 }), Type.Null()]),
    scheduleId: Type.Union([SimulationUuidSchema, Type.Null()]),
    status: SimulationFailureStatusSchema,
    tick: SimulationTickSchema,
    worldId: SimulationUuidSchema,
  },
  { $id: 'SimulationFailureV1', additionalProperties: false },
);

export const SimulationProcessDescriptorV1Schema = Type.Object(
  {
    actionSchemaVersion: Type.Literal(SIMULATION_SCHEDULE_SCHEMA_VERSION),
    actionType: ScheduledActionTypeSchema,
    authorityPolicy: Type.Union([
      Type.Literal('creator_or_administrator'),
      Type.Literal('system_scheduler'),
    ]),
    compatibility: Type.Object(
      {
        maximumActionSchemaVersion: Type.Literal(SIMULATION_SCHEDULE_SCHEMA_VERSION),
        minimumActionSchemaVersion: Type.Literal(SIMULATION_SCHEDULE_SCHEMA_VERSION),
        prngAlgorithmVersions: Type.Tuple([Type.Literal(SIMULATION_PRNG_ALGORITHM_VERSION)]),
      },
      { additionalProperties: false },
    ),
    maxEvents: Type.Integer({ maximum: MAX_SIMULATION_EVENTS_PER_PROCESS, minimum: 0 }),
    maxSchedules: Type.Integer({ maximum: MAX_SIMULATION_SCHEDULES_PER_PROCESS, minimum: 0 }),
    payloadSchemaId: Type.Union([
      Type.Literal('EmitWorldNoticePayloadV1'),
      Type.Literal('CompleteProductionRunScheduledActionPayloadV1'),
      Type.Literal('SettlePayrollScheduledActionPayloadV1'),
      Type.Literal('ExpireMarketListingScheduledActionPayloadV1'),
      Type.Literal('AssessPeriodicTaxScheduledActionPayloadV1'),
      Type.Literal('OpenProposalVotingScheduledActionPayloadV1'),
      Type.Literal('CloseAndTallyProposalScheduledActionPayloadV1'),
      Type.Literal('CertifyAndEnactProposalScheduledActionPayloadV1'),
      Type.Literal('OpenElectionScheduledActionPayloadV1'),
      Type.Literal('CloseAndTallyElectionScheduledActionPayloadV1'),
      Type.Literal('CertifyElectionScheduledActionPayloadV1'),
    ]),
    processSchemaVersion: Type.Literal(SIMULATION_PROCESS_SCHEMA_VERSION),
    processType: SimulationProcessTypeSchema,
    processVersion: Type.Literal(EMIT_WORLD_NOTICE_PROCESS_VERSION),
    registryVersion: Type.Literal(SIMULATION_PROCESS_REGISTRY_VERSION),
    resultSchemaId: Type.Literal('SimulationProcessResultV1'),
  },
  { $id: 'SimulationProcessDescriptorV1', additionalProperties: false },
);

export const SimulationProcessContextV1Schema = Type.Object(
  {
    currentProjectionChecksum: SimulationHashSchema,
    processSchemaVersion: Type.Literal(SIMULATION_PROCESS_SCHEMA_VERSION),
    scheduleSequence: SimulationPositiveIntegerStringSchema,
    state: ManifestJsonObjectSchema,
    stableProcessKey: Type.String({
      maxLength: 28,
      minLength: 10,
      pattern: '^schedule:[1-9][0-9]{0,18}$',
    }),
    tick: SimulationTickSchema,
    worldSeed: Type.String({ maxLength: 128, minLength: 1, pattern: '^[A-Za-z0-9._:-]+$' }),
    worldTimeUnixMilliseconds: SimulationSignedIntegerStringSchema,
  },
  { $id: 'SimulationProcessContextV1', additionalProperties: false },
);

export const ProposedWorldNoticeEventV1Schema = Type.Object(
  {
    eventSchemaVersion: Type.Literal(DOMAIN_EVENT_SCHEMA_VERSION),
    eventType: Type.Literal('WorldNoticeEmittedV1'),
    payload: Type.Object(
      {
        emittedAtTick: SimulationTickSchema,
        text: SimulationSafeTextSchema,
        visibility: WorldNoticeVisibilitySchema,
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'ProposedWorldNoticeEventV1', additionalProperties: false },
);

function proposedScheduledActionVariant<TType extends string, TPayload extends TSchema>(
  actionType: TType,
  payload: TPayload,
) {
  return Type.Object(
    {
      actionSchemaVersion: Type.Literal(SIMULATION_SCHEDULE_SCHEMA_VERSION),
      actionType: Type.Literal(actionType),
      dueTick: SimulationTickSchema,
      payload,
      priority: Type.Integer({
        maximum: MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE,
        minimum: -MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE,
      }),
      processVersion: Type.Literal('1.0.0'),
    },
    { additionalProperties: false },
  );
}

export const ProposedScheduledActionV1Schema = Type.Union(
  [
    proposedScheduledActionVariant('EmitWorldNoticeV1', EmitWorldNoticePayloadV1Schema),
    proposedScheduledActionVariant(
      'CompleteProductionRunV1',
      CompleteProductionRunScheduledActionPayloadV1Schema,
    ),
    proposedScheduledActionVariant('SettlePayrollV1', SettlePayrollScheduledActionPayloadV1Schema),
    proposedScheduledActionVariant(
      'ExpireMarketListingV1',
      ExpireMarketListingScheduledActionPayloadV1Schema,
    ),
    proposedScheduledActionVariant(
      'AssessPeriodicTaxV1',
      AssessPeriodicTaxScheduledActionPayloadV1Schema,
    ),
    proposedScheduledActionVariant(
      'OpenProposalVotingV1',
      OpenProposalVotingScheduledActionPayloadV1Schema,
    ),
    proposedScheduledActionVariant(
      'CloseAndTallyProposalV1',
      CloseAndTallyProposalScheduledActionPayloadV1Schema,
    ),
    proposedScheduledActionVariant(
      'CertifyAndEnactProposalV1',
      CertifyAndEnactProposalScheduledActionPayloadV1Schema,
    ),
    proposedScheduledActionVariant('OpenElectionV1', OpenElectionScheduledActionPayloadV1Schema),
    proposedScheduledActionVariant(
      'CloseAndTallyElectionV1',
      CloseAndTallyElectionScheduledActionPayloadV1Schema,
    ),
    proposedScheduledActionVariant(
      'CertifyElectionV1',
      CertifyElectionScheduledActionPayloadV1Schema,
    ),
  ],
  { $id: 'ProposedScheduledActionV1' },
);

export const SimulationProcessResultV1Schema = Type.Object(
  {
    events: Type.Array(ProposedWorldNoticeEventV1Schema, {
      maxItems: MAX_SIMULATION_EVENTS_PER_PROCESS,
    }),
    processSchemaVersion: Type.Literal(SIMULATION_PROCESS_SCHEMA_VERSION),
    schedules: Type.Array(ProposedScheduledActionV1Schema, {
      maxItems: MAX_SIMULATION_SCHEDULES_PER_PROCESS,
    }),
  },
  { $id: 'SimulationProcessResultV1', additionalProperties: false },
);

const SimulationCommandCommonFields = {
  commandId: SimulationUuidSchema,
  expectedAggregateVersion: SimulationTickSchema,
  expectedStateRevision: SimulationTickSchema,
  expectedTick: SimulationTickSchema,
  expectedWorldVersion: SimulationPositiveIntegerStringSchema,
  idempotencyKey: IdempotencyKeySchema,
  schemaVersion: Type.Literal(AUTHORITATIVE_COMMAND_SCHEMA_VERSION),
} as const;

function simulationCommand<TType extends string, TPayload extends TSchema>(
  type: TType,
  payload: TPayload,
) {
  return Type.Object(
    { ...SimulationCommandCommonFields, payload, type: Type.Literal(type) },
    { additionalProperties: false },
  );
}

export const ConfigureWorldClockPayloadV1Schema = Type.Object(
  {
    epoch: SimulationCanonicalTimestampSchema,
    maxBatch: Type.Integer({ maximum: MAX_SIMULATION_BATCH_TICKS, minimum: 1 }),
    maxCatchUp: Type.Integer({ maximum: MAX_SIMULATION_CATCH_UP_TICKS, minimum: 1 }),
    wallCadenceMs: Type.Integer({
      maximum: MAX_SIMULATION_WALL_CADENCE_MILLISECONDS,
      minimum: MIN_SIMULATION_WALL_CADENCE_MILLISECONDS,
    }),
    worldMillisecondsPerTick: Type.Integer({
      maximum: MAX_SIMULATION_WORLD_MILLISECONDS_PER_TICK,
      minimum: 1,
    }),
  },
  { $id: 'ConfigureWorldClockPayloadV1', additionalProperties: false },
);
export const AdvanceSimulationPayloadV1Schema = Type.Object(
  { ticks: Type.Integer({ maximum: MAX_SIMULATION_BATCH_TICKS, minimum: 1 }) },
  { $id: 'AdvanceSimulationPayloadV1', additionalProperties: false },
);
export const ScheduleWorldNoticePayloadV1Schema = Type.Object(
  {
    dueTick: SimulationTickSchema,
    priority: Type.Integer({
      maximum: MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE,
      minimum: -MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE,
    }),
    text: SimulationSafeTextSchema,
    visibility: WorldNoticeVisibilitySchema,
  },
  { $id: 'ScheduleWorldNoticePayloadV1', additionalProperties: false },
);
export const CancelScheduledActionPayloadV1Schema = Type.Object(
  { scheduleId: SimulationUuidSchema },
  { $id: 'CancelScheduledActionPayloadV1', additionalProperties: false },
);
export const ResolveSimulationFailurePayloadV1Schema = Type.Object(
  {
    failureId: SimulationUuidSchema,
    resolution: SimulationFailureResolutionSchema,
  },
  { $id: 'ResolveSimulationFailurePayloadV1', additionalProperties: false },
);
const EmptySimulationCommandPayloadSchema = Type.Object({}, { additionalProperties: false });

export const ConfigureWorldClockCommandV1Schema = simulationCommand(
  'ConfigureWorldClockV1',
  ConfigureWorldClockPayloadV1Schema,
);
export const StartWorldClockCommandV1Schema = simulationCommand(
  'StartWorldClockV1',
  EmptySimulationCommandPayloadSchema,
);
export const PauseWorldClockCommandV1Schema = simulationCommand(
  'PauseWorldClockV1',
  EmptySimulationCommandPayloadSchema,
);
export const AdvanceSimulationCommandV1Schema = simulationCommand(
  'AdvanceSimulationV1',
  AdvanceSimulationPayloadV1Schema,
);
export const ScheduleWorldNoticeCommandV1Schema = simulationCommand(
  'ScheduleWorldNoticeV1',
  ScheduleWorldNoticePayloadV1Schema,
);
export const CancelScheduledActionCommandV1Schema = simulationCommand(
  'CancelScheduledActionV1',
  CancelScheduledActionPayloadV1Schema,
);
export const ResolveSimulationFailureCommandV1Schema = simulationCommand(
  'ResolveSimulationFailureV1',
  ResolveSimulationFailurePayloadV1Schema,
);

export const SimulationCommandRequestV1Schema = Type.Union(
  [
    ConfigureWorldClockCommandV1Schema,
    StartWorldClockCommandV1Schema,
    PauseWorldClockCommandV1Schema,
    AdvanceSimulationCommandV1Schema,
    ScheduleWorldNoticeCommandV1Schema,
    CancelScheduledActionCommandV1Schema,
    ResolveSimulationFailureCommandV1Schema,
  ],
  { $id: 'SimulationCommandRequestV1' },
);

const SimulationCommandBindingFields = {
  actor: SimulationActorV1Schema,
  causationId: Type.Union([SimulationUuidSchema, Type.Null()]),
  correlationId: SimulationUuidSchema,
  overrideId: Type.Union([SimulationUuidSchema, Type.Null()]),
  worldId: SimulationUuidSchema,
} as const;

function boundSimulationCommand<TType extends string, TPayload extends TSchema>(
  type: TType,
  payload: TPayload,
) {
  return Type.Object(
    {
      ...SimulationCommandCommonFields,
      ...SimulationCommandBindingFields,
      payload,
      type: Type.Literal(type),
    },
    { additionalProperties: false },
  );
}

/** Fully server-bound commands; public clients submit SimulationCommandRequestV1 only. */
export const SimulationCommandEnvelopeV1Schema = Type.Union(
  [
    boundSimulationCommand('ConfigureWorldClockV1', ConfigureWorldClockPayloadV1Schema),
    boundSimulationCommand('StartWorldClockV1', EmptySimulationCommandPayloadSchema),
    boundSimulationCommand('PauseWorldClockV1', EmptySimulationCommandPayloadSchema),
    boundSimulationCommand('AdvanceSimulationV1', AdvanceSimulationPayloadV1Schema),
    boundSimulationCommand('ScheduleWorldNoticeV1', ScheduleWorldNoticePayloadV1Schema),
    boundSimulationCommand('CancelScheduledActionV1', CancelScheduledActionPayloadV1Schema),
    boundSimulationCommand('ResolveSimulationFailureV1', ResolveSimulationFailurePayloadV1Schema),
  ],
  { $id: 'SimulationCommandEnvelopeV1' },
);

export const SimulationErrorCodeSchema = Type.Union([
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
  Type.Literal('WORLD_NOT_ACTIVE'),
]);
export const SimulationErrorCodes = {
  advanceLimitExceeded: 'ADVANCE_LIMIT_EXCEEDED',
  budgetExceeded: 'SIMULATION_BUDGET_EXCEEDED',
  clockNotPaused: 'CLOCK_NOT_PAUSED',
  clockNotRunning: 'CLOCK_NOT_RUNNING',
  expectedTickMismatch: 'EXPECTED_TICK_MISMATCH',
  handlerFailed: 'SIMULATION_HANDLER_FAILED',
  integerOverflow: 'SIMULATION_INTEGER_OVERFLOW',
  processUnknown: 'SIMULATION_PROCESS_UNKNOWN',
  processVersionMismatch: 'SIMULATION_PROCESS_VERSION_MISMATCH',
  scheduleAlreadyTerminal: 'SCHEDULE_ALREADY_TERMINAL',
  scheduleInPast: 'SCHEDULE_IN_PAST',
  worldNotActive: 'WORLD_NOT_ACTIVE',
} as const;

export const WorldSimulationInitializedPayloadV1Schema = Type.Object(
  {
    configuration: WorldClockConfigurationV1Schema,
    currentTick: Type.Literal('0'),
    mode: Type.Literal('paused'),
    provenance: Type.Union([Type.Literal('compiled_configuration'), Type.Literal('m07_default')]),
    processRegistryVersion: SimulationProcessRegistryVersionSchema,
  },
  { $id: 'WorldSimulationInitializedPayloadV1', additionalProperties: false },
);
export const WorldClockConfiguredPayloadV1Schema = Type.Object(
  {
    configuration: WorldClockConfigurationV1Schema,
    previousConfiguration: WorldClockConfigurationV1Schema,
    tick: Type.Literal('0'),
  },
  { $id: 'WorldClockConfiguredPayloadV1', additionalProperties: false },
);
export const WorldClockStartedPayloadV1Schema = Type.Object(
  { tick: SimulationTickSchema },
  { $id: 'WorldClockStartedPayloadV1', additionalProperties: false },
);
export const WorldClockPausedPayloadV1Schema = Type.Object(
  {
    reason: Type.Union([
      Type.Literal('creator'),
      Type.Literal('operator'),
      Type.Literal('automatic_failure'),
    ]),
    tick: SimulationTickSchema,
  },
  { $id: 'WorldClockPausedPayloadV1', additionalProperties: false },
);
export const SimulationAdvancedPayloadV1Schema = Type.Object(
  {
    executedScheduleCount: Type.Integer({ maximum: MAX_SIMULATION_EVENTS_PER_ADVANCE, minimum: 0 }),
    fromTick: SimulationTickSchema,
    outcomeHash: SimulationHashSchema,
    processRegistryVersion: SimulationProcessRegistryVersionSchema,
    tickCount: Type.Integer({ maximum: MAX_SIMULATION_BATCH_TICKS, minimum: 1 }),
    toTick: SimulationTickSchema,
  },
  { $id: 'SimulationAdvancedPayloadV1', additionalProperties: false },
);
const ScheduledActionCreatedCommonFields = {
  actionSchemaVersion: Type.Literal(SIMULATION_SCHEDULE_SCHEMA_VERSION),
  dueTick: SimulationTickSchema,
  payloadHash: SimulationHashSchema,
  priority: Type.Integer({
    maximum: MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE,
    minimum: -MAX_SCHEDULED_ACTION_PRIORITY_ABSOLUTE,
  }),
  processVersion: Type.Literal('1.0.0'),
  scheduleId: SimulationUuidSchema,
  scheduleSequence: SimulationPositiveIntegerStringSchema,
} as const;

function scheduledActionCreatedVariant<TType extends string, TPayload extends TSchema>(
  actionType: TType,
  payload: TPayload,
) {
  return Type.Object(
    { ...ScheduledActionCreatedCommonFields, actionType: Type.Literal(actionType), payload },
    { additionalProperties: false },
  );
}

export const ScheduledActionCreatedPayloadV1Schema = Type.Union(
  [
    scheduledActionCreatedVariant('EmitWorldNoticeV1', EmitWorldNoticePayloadV1Schema),
    scheduledActionCreatedVariant(
      'CompleteProductionRunV1',
      CompleteProductionRunScheduledActionPayloadV1Schema,
    ),
    scheduledActionCreatedVariant('SettlePayrollV1', SettlePayrollScheduledActionPayloadV1Schema),
    scheduledActionCreatedVariant(
      'ExpireMarketListingV1',
      ExpireMarketListingScheduledActionPayloadV1Schema,
    ),
    scheduledActionCreatedVariant(
      'AssessPeriodicTaxV1',
      AssessPeriodicTaxScheduledActionPayloadV1Schema,
    ),
    scheduledActionCreatedVariant(
      'OpenProposalVotingV1',
      OpenProposalVotingScheduledActionPayloadV1Schema,
    ),
    scheduledActionCreatedVariant(
      'CloseAndTallyProposalV1',
      CloseAndTallyProposalScheduledActionPayloadV1Schema,
    ),
    scheduledActionCreatedVariant(
      'CertifyAndEnactProposalV1',
      CertifyAndEnactProposalScheduledActionPayloadV1Schema,
    ),
    scheduledActionCreatedVariant('OpenElectionV1', OpenElectionScheduledActionPayloadV1Schema),
    scheduledActionCreatedVariant(
      'CloseAndTallyElectionV1',
      CloseAndTallyElectionScheduledActionPayloadV1Schema,
    ),
    scheduledActionCreatedVariant(
      'CertifyElectionV1',
      CertifyElectionScheduledActionPayloadV1Schema,
    ),
  ],
  { $id: 'ScheduledActionCreatedPayloadV1' },
);
export const ScheduledActionCancelledPayloadV1Schema = Type.Object(
  {
    actionType: ScheduledActionTypeSchema,
    dueTick: SimulationTickSchema,
    scheduleId: SimulationUuidSchema,
    scheduleSequence: SimulationPositiveIntegerStringSchema,
  },
  { $id: 'ScheduledActionCancelledPayloadV1', additionalProperties: false },
);
export const ScheduledActionExecutedPayloadV1Schema = Type.Object(
  {
    actionType: ScheduledActionTypeSchema,
    dueTick: SimulationTickSchema,
    outcomeHash: SimulationHashSchema,
    processVersion: Type.Literal(EMIT_WORLD_NOTICE_PROCESS_VERSION),
    scheduleId: SimulationUuidSchema,
    scheduleSequence: SimulationPositiveIntegerStringSchema,
  },
  { $id: 'ScheduledActionExecutedPayloadV1', additionalProperties: false },
);
export const WorldNoticeEmittedPayloadV1Schema = Type.Object(
  {
    emittedAtTick: SimulationTickSchema,
    scheduleId: SimulationUuidSchema,
    text: SimulationSafeTextSchema,
    visibility: WorldNoticeVisibilitySchema,
  },
  { $id: 'WorldNoticeEmittedPayloadV1', additionalProperties: false },
);
export const SimulationFailureRecordedPayloadV1Schema = Type.Object(
  {
    attempts: Type.Integer({ maximum: 100, minimum: 1 }),
    batchRunId: SimulationUuidSchema,
    errorCode: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    failureId: SimulationUuidSchema,
    processType: SimulationFailureSourceTypeSchema,
    processVersion: SimulationFailureSourceVersionSchema,
    scheduleId: Type.Union([SimulationUuidSchema, Type.Null()]),
    tick: SimulationTickSchema,
  },
  { $id: 'SimulationFailureRecordedPayloadV1', additionalProperties: false },
);
export const SimulationFailureResolvedPayloadV1Schema = Type.Object(
  {
    failureId: SimulationUuidSchema,
    resolution: SimulationFailureResolutionSchema,
    scheduleId: Type.Union([SimulationUuidSchema, Type.Null()]),
    tick: SimulationTickSchema,
  },
  { $id: 'SimulationFailureResolvedPayloadV1', additionalProperties: false },
);
export const WorldClockAutoPausedPayloadV1Schema = Type.Object(
  {
    errorCode: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    failureId: SimulationUuidSchema,
    tick: SimulationTickSchema,
  },
  { $id: 'WorldClockAutoPausedPayloadV1', additionalProperties: false },
);

export const InitializeWorldSimulationCommandV1Schema = Type.Object(
  {
    ...SimulationCommandCommonFields,
    ...SimulationCommandBindingFields,
    actor: SimulationSystemActorV1Schema,
    payload: WorldSimulationInitializedPayloadV1Schema,
    type: Type.Literal('InitializeWorldSimulationV1'),
  },
  { $id: 'InitializeWorldSimulationCommandV1', additionalProperties: false },
);
export const AutoPauseWorldClockCommandPayloadV1Schema = Type.Object(
  {
    errorCode: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    failureId: SimulationUuidSchema,
  },
  { additionalProperties: false },
);
export const AutoPauseWorldClockCommandV1Schema = Type.Object(
  {
    ...SimulationCommandCommonFields,
    ...SimulationCommandBindingFields,
    actor: SimulationSystemActorV1Schema,
    payload: AutoPauseWorldClockCommandPayloadV1Schema,
    type: Type.Literal('AutoPauseWorldClockV1'),
  },
  { $id: 'AutoPauseWorldClockCommandV1', additionalProperties: false },
);
export const SimulationSystemCommandEnvelopeV1Schema = Type.Union(
  [InitializeWorldSimulationCommandV1Schema, AutoPauseWorldClockCommandV1Schema],
  { $id: 'SimulationSystemCommandEnvelopeV1' },
);

function simulationEvent<TType extends string, TPayload extends TSchema>(
  eventType: TType,
  payload: TPayload,
) {
  return Type.Object(
    {
      eventSchemaVersion: Type.Literal(DOMAIN_EVENT_SCHEMA_VERSION),
      eventType: Type.Literal(eventType),
      payload,
    },
    { additionalProperties: false },
  );
}

export const SimulationEventV1Schema = Type.Union(
  [
    simulationEvent('WorldSimulationInitializedV1', WorldSimulationInitializedPayloadV1Schema),
    simulationEvent('WorldClockConfiguredV1', WorldClockConfiguredPayloadV1Schema),
    simulationEvent('WorldClockStartedV1', WorldClockStartedPayloadV1Schema),
    simulationEvent('WorldClockPausedV1', WorldClockPausedPayloadV1Schema),
    simulationEvent('SimulationAdvancedV1', SimulationAdvancedPayloadV1Schema),
    simulationEvent('ScheduledActionCreatedV1', ScheduledActionCreatedPayloadV1Schema),
    simulationEvent('ScheduledActionCancelledV1', ScheduledActionCancelledPayloadV1Schema),
    simulationEvent('ScheduledActionExecutedV1', ScheduledActionExecutedPayloadV1Schema),
    simulationEvent('WorldNoticeEmittedV1', WorldNoticeEmittedPayloadV1Schema),
    simulationEvent('SimulationFailureRecordedV1', SimulationFailureRecordedPayloadV1Schema),
    simulationEvent('SimulationFailureResolvedV1', SimulationFailureResolvedPayloadV1Schema),
    simulationEvent('WorldClockAutoPausedV1', WorldClockAutoPausedPayloadV1Schema),
  ],
  { $id: 'SimulationEventV1' },
);

export const SimulationOutcomeV1Schema = Type.Object(
  {
    fromTick: SimulationTickSchema,
    inputChecksum: SimulationHashSchema,
    outcomeHash: SimulationHashSchema,
    outcomeSchemaVersion: Type.Literal(SIMULATION_OUTCOME_SCHEMA_VERSION),
    prngAlgorithmVersion: Type.Literal(SIMULATION_PRNG_ALGORITHM_VERSION),
    processRegistryVersion: SimulationProcessRegistryVersionSchema,
    toTick: SimulationTickSchema,
    worldSeedHash: SimulationHashSchema,
  },
  { $id: 'SimulationOutcomeV1', additionalProperties: false },
);

export const SimulationWakeMessageV1Schema = Type.Object(
  {
    expectedLeaseFencingToken: SimulationPositiveIntegerStringSchema,
    messageSchemaVersion: Type.Literal(SIMULATION_QUEUE_SCHEMA_VERSION),
    messageType: Type.Literal('SimulationWakeV1'),
    worldId: SimulationUuidSchema,
  },
  { $id: 'SimulationWakeMessageV1', additionalProperties: false },
);

export type SimulationClockMode = Static<typeof SimulationClockModeSchema>;
export type SimulationActorV1 = Static<typeof SimulationActorV1Schema>;
export type SimulationSystemActorV1 = Static<typeof SimulationSystemActorV1Schema>;
export type ScheduledActionType = Static<typeof ScheduledActionTypeSchema>;
export type CommerceScheduledActionType = Static<typeof CommerceScheduledActionTypeSchema>;
export type GovernanceScheduledActionType = Static<typeof GovernanceScheduledActionTypeSchema>;
export type SimulationProcessRegistryVersion = Static<
  typeof SimulationProcessRegistryVersionSchema
>;
export type ScheduledActionStatus = Static<typeof ScheduledActionStatusSchema>;
export type SimulationBatchStatus = Static<typeof SimulationBatchStatusSchema>;
export type SimulationFailureStatus = Static<typeof SimulationFailureStatusSchema>;
export type SimulationFailureResolution = Static<typeof SimulationFailureResolutionSchema>;
export type SimulationFailureSourceType = Static<typeof SimulationFailureSourceTypeSchema>;
export type SimulationFailureSourceVersion = Static<typeof SimulationFailureSourceVersionSchema>;
export type WorldNoticeVisibility = Static<typeof WorldNoticeVisibilitySchema>;
export type WorldClockConfigurationV1 = Static<typeof WorldClockConfigurationV1Schema>;
export type WorldSimulationClockV1 = Static<typeof WorldSimulationClockV1Schema>;
export type SimulationWorldTimeV1 = Static<typeof SimulationWorldTimeV1Schema>;
export type EmitWorldNoticePayloadV1 = Static<typeof EmitWorldNoticePayloadV1Schema>;
export type CompleteProductionRunScheduledActionPayloadV1 = Static<
  typeof CompleteProductionRunScheduledActionPayloadV1Schema
>;
export type SettlePayrollScheduledActionPayloadV1 = Static<
  typeof SettlePayrollScheduledActionPayloadV1Schema
>;
export type ExpireMarketListingScheduledActionPayloadV1 = Static<
  typeof ExpireMarketListingScheduledActionPayloadV1Schema
>;
export type AssessPeriodicTaxScheduledActionPayloadV1 = Static<
  typeof AssessPeriodicTaxScheduledActionPayloadV1Schema
>;
export type OpenProposalVotingScheduledActionPayloadV1 = Static<
  typeof OpenProposalVotingScheduledActionPayloadV1Schema
>;
export type CloseAndTallyProposalScheduledActionPayloadV1 = Static<
  typeof CloseAndTallyProposalScheduledActionPayloadV1Schema
>;
export type CertifyAndEnactProposalScheduledActionPayloadV1 = Static<
  typeof CertifyAndEnactProposalScheduledActionPayloadV1Schema
>;
export type OpenElectionScheduledActionPayloadV1 = Static<
  typeof OpenElectionScheduledActionPayloadV1Schema
>;
export type CloseAndTallyElectionScheduledActionPayloadV1 = Static<
  typeof CloseAndTallyElectionScheduledActionPayloadV1Schema
>;
export type CertifyElectionScheduledActionPayloadV1 = Static<
  typeof CertifyElectionScheduledActionPayloadV1Schema
>;
export type CommerceScheduledActionPayloadV1 = Static<
  typeof CommerceScheduledActionPayloadV1Schema
>;
export type GovernanceScheduledActionPayloadV1 = Static<
  typeof GovernanceScheduledActionPayloadV1Schema
>;
export type ScheduledActionV1 = Static<typeof ScheduledActionV1Schema>;
export type SimulationBatchRunV1 = Static<typeof SimulationBatchRunV1Schema>;
export type SimulationFailureV1 = Static<typeof SimulationFailureV1Schema>;
export type SimulationProcessDescriptorV1 = Static<typeof SimulationProcessDescriptorV1Schema>;
export type SimulationProcessContextV1 = Static<typeof SimulationProcessContextV1Schema>;
export type ProposedWorldNoticeEventV1 = Static<typeof ProposedWorldNoticeEventV1Schema>;
export type ProposedScheduledActionV1 = Static<typeof ProposedScheduledActionV1Schema>;
export type SimulationProcessResultV1 = Static<typeof SimulationProcessResultV1Schema>;
export type ConfigureWorldClockPayloadV1 = Static<typeof ConfigureWorldClockPayloadV1Schema>;
export type AdvanceSimulationPayloadV1 = Static<typeof AdvanceSimulationPayloadV1Schema>;
export type ScheduleWorldNoticePayloadV1 = Static<typeof ScheduleWorldNoticePayloadV1Schema>;
export type CancelScheduledActionPayloadV1 = Static<typeof CancelScheduledActionPayloadV1Schema>;
export type ResolveSimulationFailurePayloadV1 = Static<
  typeof ResolveSimulationFailurePayloadV1Schema
>;
export type ConfigureWorldClockCommandV1 = Static<typeof ConfigureWorldClockCommandV1Schema>;
export type StartWorldClockCommandV1 = Static<typeof StartWorldClockCommandV1Schema>;
export type PauseWorldClockCommandV1 = Static<typeof PauseWorldClockCommandV1Schema>;
export type AdvanceSimulationCommandV1 = Static<typeof AdvanceSimulationCommandV1Schema>;
export type ScheduleWorldNoticeCommandV1 = Static<typeof ScheduleWorldNoticeCommandV1Schema>;
export type CancelScheduledActionCommandV1 = Static<typeof CancelScheduledActionCommandV1Schema>;
export type ResolveSimulationFailureCommandV1 = Static<
  typeof ResolveSimulationFailureCommandV1Schema
>;
export type SimulationCommandRequestV1 = Static<typeof SimulationCommandRequestV1Schema>;
export type SimulationCommandEnvelopeV1 = Static<typeof SimulationCommandEnvelopeV1Schema>;
export type SimulationErrorCode = Static<typeof SimulationErrorCodeSchema>;
export type WorldSimulationInitializedPayloadV1 = Static<
  typeof WorldSimulationInitializedPayloadV1Schema
>;
export type WorldClockConfiguredPayloadV1 = Static<typeof WorldClockConfiguredPayloadV1Schema>;
export type WorldClockStartedPayloadV1 = Static<typeof WorldClockStartedPayloadV1Schema>;
export type WorldClockPausedPayloadV1 = Static<typeof WorldClockPausedPayloadV1Schema>;
export type SimulationAdvancedPayloadV1 = Static<typeof SimulationAdvancedPayloadV1Schema>;
export type ScheduledActionCreatedPayloadV1 = Static<typeof ScheduledActionCreatedPayloadV1Schema>;
export type ScheduledActionCancelledPayloadV1 = Static<
  typeof ScheduledActionCancelledPayloadV1Schema
>;
export type ScheduledActionExecutedPayloadV1 = Static<
  typeof ScheduledActionExecutedPayloadV1Schema
>;
export type WorldNoticeEmittedPayloadV1 = Static<typeof WorldNoticeEmittedPayloadV1Schema>;
export type SimulationFailureRecordedPayloadV1 = Static<
  typeof SimulationFailureRecordedPayloadV1Schema
>;
export type SimulationFailureResolvedPayloadV1 = Static<
  typeof SimulationFailureResolvedPayloadV1Schema
>;
export type WorldClockAutoPausedPayloadV1 = Static<typeof WorldClockAutoPausedPayloadV1Schema>;
export type InitializeWorldSimulationCommandV1 = Static<
  typeof InitializeWorldSimulationCommandV1Schema
>;
export type AutoPauseWorldClockCommandPayloadV1 = Static<
  typeof AutoPauseWorldClockCommandPayloadV1Schema
>;
export type AutoPauseWorldClockCommandV1 = Static<typeof AutoPauseWorldClockCommandV1Schema>;
export type SimulationSystemCommandEnvelopeV1 = Static<
  typeof SimulationSystemCommandEnvelopeV1Schema
>;
export type SimulationEventV1 = Static<typeof SimulationEventV1Schema>;
export type SimulationOutcomeV1 = Static<typeof SimulationOutcomeV1Schema>;
export type SimulationWakeMessageV1 = Static<typeof SimulationWakeMessageV1Schema>;
