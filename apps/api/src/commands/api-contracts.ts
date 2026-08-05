import { Type, type Static } from '@sinclair/typebox';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  IdempotencyKeySchema,
  ExecuteCreatorOverridePayloadV1Schema,
  LedgerHashSchema,
  LedgerNonNegativeIntegerStringSchema,
  LedgerPositiveIntegerStringSchema,
  LedgerUuidSchema,
  PasswordSchema,
  RepairGovernanceResultPayloadV1Schema,
  RenameWorldEntityPayloadV1Schema,
  ScheduledActionV1Schema,
  SimulationBatchRunV1Schema,
  SimulationFailureV1Schema,
  SimulationWorldTimeV1Schema,
  WorldSimulationClockV1Schema,
  WorldCommandResultV1Schema,
  WorldHistoryCategorySchema,
  WorldHistoryEntryV1Schema,
  type RenameWorldEntityPayloadV1,
  type WorldCommandResultV1,
  type WorldHistoryEntryV1,
} from '@worldgraph/contracts';

/**
 * The transport intentionally accepts a bounded discriminator rather than a union whose only
 * current member is RenameWorldEntityV1. That lets the command bus durably reject unknown or
 * disabled registered versions after authentication instead of Fastify silently short-circuiting
 * the authoritative pipeline. A resolved handler performs the exact payload validation.
 */
export const SubmitWorldCommandSchema = Type.Object(
  {
    commandId: LedgerUuidSchema,
    expectedAggregateVersion: LedgerNonNegativeIntegerStringSchema,
    expectedStateRevision: LedgerNonNegativeIntegerStringSchema,
    expectedTick: Type.Optional(LedgerNonNegativeIntegerStringSchema),
    expectedWorldVersion: LedgerPositiveIntegerStringSchema,
    idempotencyKey: IdempotencyKeySchema,
    payload: Type.Record(Type.String({ maxLength: 100, minLength: 1 }), Type.Unknown(), {
      maxProperties: 32,
    }),
    schemaVersion: Type.Integer({ maximum: 2_147_483_647, minimum: 1 }),
    type: Type.String({ maxLength: 120, minLength: 1, pattern: '^[A-Z][A-Za-z0-9]*V[1-9][0-9]*$' }),
  },
  { additionalProperties: false },
);

const RecentCredentialCommandBase = {
  commandId: LedgerUuidSchema,
  expectedAggregateVersion: LedgerNonNegativeIntegerStringSchema,
  expectedStateRevision: LedgerNonNegativeIntegerStringSchema,
  expectedTick: LedgerNonNegativeIntegerStringSchema,
  expectedWorldVersion: LedgerPositiveIntegerStringSchema,
  idempotencyKey: IdempotencyKeySchema,
  schemaVersion: Type.Literal(1),
} as const;

export const RecentCredentialGovernanceCommandTransportSchema = Type.Union([
  Type.Object(
    {
      ...RecentCredentialCommandBase,
      payload: ExecuteCreatorOverridePayloadV1Schema,
      type: Type.Literal('ExecuteCreatorOverrideV1'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...RecentCredentialCommandBase,
      payload: RepairGovernanceResultPayloadV1Schema,
      type: Type.Literal('RepairGovernanceResultV1'),
    },
    { additionalProperties: false },
  ),
]);

export const GovernanceApprovalCommandTransportSchema = Type.Union([
  Type.Object(
    {
      ...RecentCredentialCommandBase,
      actorMode: Type.Union([Type.Literal('creator'), Type.Literal('administrator')]),
      payload: ExecuteCreatorOverridePayloadV1Schema,
      type: Type.Literal('ExecuteCreatorOverrideV1'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...RecentCredentialCommandBase,
      actorMode: Type.Union([Type.Literal('creator'), Type.Literal('administrator')]),
      payload: RepairGovernanceResultPayloadV1Schema,
      type: Type.Literal('RepairGovernanceResultV1'),
    },
    { additionalProperties: false },
  ),
]);

export const RecentCredentialRequestTransportSchema = Type.Object(
  {
    command: RecentCredentialGovernanceCommandTransportSchema,
    password: PasswordSchema,
    worldId: LedgerUuidSchema,
  },
  { additionalProperties: false },
);

export const GovernanceApprovalRequestTransportSchema = Type.Object(
  {
    command: GovernanceApprovalCommandTransportSchema,
    password: PasswordSchema,
    worldId: LedgerUuidSchema,
  },
  { additionalProperties: false },
);

export const GovernanceApprovalResponseTransportSchema = Type.Object(
  {
    approvalId: LedgerUuidSchema,
    commandId: LedgerUuidSchema,
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export const RenameWorldEntityPayloadTransportSchema = RenameWorldEntityPayloadV1Schema;
export const WorldCommandResultTransportSchema = WorldCommandResultV1Schema;
export const WorldHistoryEntryTransportSchema = WorldHistoryEntryV1Schema;
export const WorldHistoryQueryTransportSchema = Type.Object(
  {
    actorId: Type.Optional(
      Type.String({ maxLength: 160, minLength: 3, pattern: '^[A-Za-z0-9._:-]+$' }),
    ),
    category: Type.Optional(WorldHistoryCategorySchema),
    cursor: Type.Optional(Type.String({ maxLength: 1_024, minLength: 16 })),
    eventType: Type.Optional(Type.String({ maxLength: 120, minLength: 1 })),
    limit: Type.Optional(
      Type.Union([
        Type.Integer({ maximum: 100, minimum: 1 }),
        Type.String({ maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }),
      ]),
    ),
    targetId: Type.Optional(Type.String({ maxLength: 240, minLength: 1 })),
    targetType: Type.Optional(
      Type.String({ maxLength: 100, minLength: 1, pattern: '^[a-z][a-z0-9_]*$' }),
    ),
  },
  { additionalProperties: false },
);
export const WorldHistoryPageTransportSchema = Type.Object(
  {
    items: Type.Array(WorldHistoryEntryV1Schema, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String({ maxLength: 1_024, minLength: 16 }), Type.Null()]),
  },
  { additionalProperties: false },
);
const WorldHistoryCommandContextSchema = Type.Object(
  {
    authorizationRuleId: Type.Union([Type.String({ maxLength: 120, minLength: 1 }), Type.Null()]),
    commandId: LedgerUuidSchema,
    commandType: Type.String({ maxLength: 120, minLength: 1 }),
    decidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    expectedAggregateVersion: Type.Union([LedgerNonNegativeIntegerStringSchema, Type.Null()]),
    expectedStateRevision: LedgerNonNegativeIntegerStringSchema,
    expectedWorldVersion: LedgerPositiveIntegerStringSchema,
    overrideId: Type.Union([LedgerUuidSchema, Type.Null()]),
    requestedAt: Type.String({ format: 'date-time' }),
    schemaVersion: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal('received'),
      Type.Literal('accepted'),
      Type.Literal('rejected'),
      Type.Literal('failed'),
    ]),
  },
  { additionalProperties: false },
);
const WorldHistoryEventContextSchema = Type.Object(
  {
    aggregateId: Type.String({ maxLength: 240, minLength: 1 }),
    aggregateType: Type.String({ maxLength: 100, minLength: 1 }),
    aggregateVersion: LedgerPositiveIntegerStringSchema,
    eventId: LedgerUuidSchema,
    eventSchemaVersion: Type.Integer({ minimum: 1 }),
    eventType: Type.String({ maxLength: 120, minLength: 1 }),
    worldEventSequence: LedgerPositiveIntegerStringSchema,
  },
  { additionalProperties: false },
);
export const WorldHistoryDetailTransportSchema = Type.Object(
  {
    command: Type.Union([WorldHistoryCommandContextSchema, Type.Null()]),
    entry: WorldHistoryEntryV1Schema,
    event: Type.Union([WorldHistoryEventContextSchema, Type.Null()]),
    projection: Type.Object(
      { resultingStateRevision: Type.Union([LedgerPositiveIntegerStringSchema, Type.Null()]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const WorldRuntimeHeadTransportSchema = Type.Object(
  {
    activeWorldVersionId: LedgerUuidSchema,
    anchorArtifactHash: LedgerHashSchema,
    designVersion: LedgerPositiveIntegerStringSchema,
    lastEventSequence: LedgerNonNegativeIntegerStringSchema,
    lastLedgerSequence: LedgerNonNegativeIntegerStringSchema,
    ledgerAnchoredAt: Type.String({ format: 'date-time' }),
    projection: Type.Object(
      {
        checksum: LedgerHashSchema,
        lastEventSequence: LedgerNonNegativeIntegerStringSchema,
        schemaVersion: Type.Integer({ minimum: 1 }),
        status: Type.Union([
          Type.Literal('current'),
          Type.Literal('rebuilding'),
          Type.Literal('diverged'),
          Type.Literal('failed'),
        ]),
        updatedAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
    stateRevision: LedgerNonNegativeIntegerStringSchema,
    worldId: LedgerUuidSchema,
  },
  { additionalProperties: false },
);

export const SimulationClockViewTransportSchema = Type.Object(
  {
    aggregateVersion: LedgerPositiveIntegerStringSchema,
    backlogCount: Type.Integer({ maximum: 100_000, minimum: 0 }),
    canManage: Type.Boolean(),
    canSchedule: Type.Boolean(),
    clock: WorldSimulationClockV1Schema,
    degradedWake: Type.Boolean(),
    designVersion: LedgerPositiveIntegerStringSchema,
    lastBatch: Type.Union([SimulationBatchRunV1Schema, Type.Null()]),
    nextDueAction: Type.Union([ScheduledActionV1Schema, Type.Null()]),
    stateRevision: LedgerNonNegativeIntegerStringSchema,
    worldTime: SimulationWorldTimeV1Schema,
  },
  { $id: 'SimulationClockViewTransport', additionalProperties: false },
);

export const SimulationListQueryTransportSchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 1_024, minLength: 1 })),
    limit: Type.Optional(
      Type.Union([
        Type.Integer({ maximum: 100, minimum: 1 }),
        Type.String({ maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }),
      ]),
    ),
    status: Type.Optional(Type.String({ maxLength: 32, minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ScheduledActionPageTransportSchema = Type.Object(
  {
    items: Type.Array(ScheduledActionV1Schema, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String({ maxLength: 1_024, minLength: 1 }), Type.Null()]),
  },
  { $id: 'ScheduledActionPageTransport', additionalProperties: false },
);

export const SimulationBatchPageTransportSchema = Type.Object(
  {
    failures: Type.Array(SimulationFailureV1Schema, { maxItems: 100 }),
    items: Type.Array(SimulationBatchRunV1Schema, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String({ maxLength: 1_024, minLength: 1 }), Type.Null()]),
  },
  { $id: 'SimulationBatchPageTransport', additionalProperties: false },
);

export type RenameWorldEntityPayloadTransport = RenameWorldEntityPayloadV1;
export type RecentCredentialGovernanceCommandTransport = Static<
  typeof RecentCredentialGovernanceCommandTransportSchema
>;
export type GovernanceApprovalCommandTransport = Static<
  typeof GovernanceApprovalCommandTransportSchema
>;
export type RecentCredentialRequestTransport = Static<
  typeof RecentCredentialRequestTransportSchema
>;
export type GovernanceApprovalRequestTransport = Static<
  typeof GovernanceApprovalRequestTransportSchema
>;
export type GovernanceApprovalResponseTransport = Static<
  typeof GovernanceApprovalResponseTransportSchema
>;
export type SubmitWorldCommand = Static<typeof SubmitWorldCommandSchema>;
export type WorldCommandResultTransport = WorldCommandResultV1;
export type WorldHistoryEntryTransport = WorldHistoryEntryV1;
export type WorldHistoryQueryTransport = Static<typeof WorldHistoryQueryTransportSchema>;
export type WorldHistoryDetailTransport = Static<typeof WorldHistoryDetailTransportSchema>;
export type WorldRuntimeHeadTransport = Static<typeof WorldRuntimeHeadTransportSchema>;
export type SimulationClockViewTransport = Static<typeof SimulationClockViewTransportSchema>;
export type SimulationListQueryTransport = Static<typeof SimulationListQueryTransportSchema>;
export type ScheduledActionPageTransport = Static<typeof ScheduledActionPageTransportSchema>;
export type SimulationBatchPageTransport = Static<typeof SimulationBatchPageTransportSchema>;

export const COMMAND_SCHEMA_VERSION = AUTHORITATIVE_COMMAND_SCHEMA_VERSION;
