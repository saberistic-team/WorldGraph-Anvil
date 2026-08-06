import { Type, type Static } from '@sinclair/typebox';

import {
  COMPILER_VERSION,
  GOVERNANCE_COMPILER_VERSION,
  PREVIOUS_COMPILER_VERSION,
  RETAINED_COMPILER_VERSION,
} from './versions.js';

export const COMMAND_SCHEMA_VERSION = 1 as const;

export const IdempotencyKeySchema = Type.String({
  maxLength: 128,
  minLength: 8,
  pattern: '^[A-Za-z0-9._-]+$',
});

export const CommandEnvelopeSchema = Type.Object(
  {
    action: Type.String({ maxLength: 100, minLength: 1 }),
    actorUserId: Type.String({ format: 'uuid' }),
    commandId: Type.String({ format: 'uuid' }),
    correlationId: Type.String({ format: 'uuid' }),
    expectedRowVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    idempotencyKey: IdempotencyKeySchema,
    requestHash: Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' }),
    requestId: Type.String({ format: 'uuid' }),
    resourceId: Type.Optional(Type.String({ format: 'uuid' })),
    schemaVersion: Type.Literal(COMMAND_SCHEMA_VERSION),
  },
  { additionalProperties: false },
);

const NotificationId = Type.String({ format: 'uuid' });
const NotificationHash = Type.String({
  maxLength: 64,
  minLength: 64,
  pattern: '^[a-f0-9]{64}$',
});
const notification = <T extends string, P extends ReturnType<typeof Type.Object>>(
  type: T,
  payload: P,
) =>
  Type.Object(
    {
      id: NotificationId,
      occurredAt: Type.String({ format: 'date-time' }),
      payload,
      schemaVersion: Type.Literal(1),
      type: Type.Literal(type),
    },
    { additionalProperties: false },
  );

export const ApplicationNotificationSchema = Type.Union([
  notification(
    'IdentityRegistered',
    Type.Object({ userId: NotificationId }, { additionalProperties: false }),
  ),
  notification(
    'WorldCreated',
    Type.Object(
      { actorUserId: NotificationId, worldId: NotificationId },
      { additionalProperties: false },
    ),
  ),
  notification(
    'InvitationCreated',
    Type.Object(
      {
        actorUserId: NotificationId,
        intendedRole: Type.Union([Type.Literal('player'), Type.Literal('observer')]),
        invitationId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'InvitationAccepted',
    Type.Object(
      { actorUserId: NotificationId, worldId: NotificationId },
      { additionalProperties: false },
    ),
  ),
  notification(
    'InvitationRevoked',
    Type.Object(
      { actorUserId: NotificationId, invitationId: NotificationId, worldId: NotificationId },
      { additionalProperties: false },
    ),
  ),
  notification(
    'MembershipRoleChanged',
    Type.Object(
      {
        actorUserId: NotificationId,
        role: Type.Union([
          Type.Literal('administrator'),
          Type.Literal('player'),
          Type.Literal('observer'),
        ]),
        targetUserId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'MembershipRemoved',
    Type.Object(
      { actorUserId: NotificationId, targetUserId: NotificationId, worldId: NotificationId },
      { additionalProperties: false },
    ),
  ),
  notification(
    'CreatorOverrideUsed',
    Type.Object(
      {
        action: Type.Literal('membership.force_demote_administrator'),
        actorUserId: NotificationId,
        targetUserId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'PrimitiveVersionPublished',
    Type.Object(
      { actorUserId: NotificationId, primitiveVersionId: NotificationId },
      { additionalProperties: false },
    ),
  ),
  notification(
    'PrimitiveVersionDeprecated',
    Type.Object(
      { actorUserId: NotificationId, primitiveVersionId: NotificationId },
      { additionalProperties: false },
    ),
  ),
  notification(
    'PrimitiveIndexRequested',
    Type.Object(
      {
        actorUserId: NotificationId,
        contentHash: Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' }),
        indexSchemaVersion: Type.Literal(1),
        primitiveVersionId: NotificationId,
        providerConfigurationId: Type.String({ maxLength: 120, minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'PrimitiveIndexCompleted',
    Type.Object({ primitiveVersionId: NotificationId }, { additionalProperties: false }),
  ),
  notification(
    'PrimitiveIndexFailed',
    Type.Object(
      {
        errorCode: Type.String({ maxLength: 100, minLength: 1 }),
        primitiveVersionId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'ManifestGenerationRequested',
    Type.Object(
      {
        actorUserId: NotificationId,
        inputHash: NotificationHash,
        runId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'ManifestGenerationSucceeded',
    Type.Object(
      {
        contentHash: NotificationHash,
        revisionId: NotificationId,
        runId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'ManifestGenerationFailed',
    Type.Object(
      {
        errorCode: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
        runId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'ManifestRevisionCreated',
    Type.Object(
      {
        actorUserId: NotificationId,
        contentHash: NotificationHash,
        revisionId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'ManifestRevisionValidated',
    Type.Object(
      {
        reportHash: NotificationHash,
        reportId: NotificationId,
        revisionId: NotificationId,
        valid: Type.Boolean(),
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'ManifestApproved',
    Type.Object(
      {
        actorUserId: NotificationId,
        contentHash: NotificationHash,
        revisionId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'WorldCompilationRequested',
    Type.Object(
      {
        actorUserId: NotificationId,
        compilerVersion: Type.Optional(
          Type.Union([
            Type.Literal(RETAINED_COMPILER_VERSION),
            Type.Literal(PREVIOUS_COMPILER_VERSION),
            Type.Literal(GOVERNANCE_COMPILER_VERSION),
            Type.Literal(COMPILER_VERSION),
          ]),
        ),
        inputHash: NotificationHash,
        manifestRevisionId: NotificationId,
        runId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'WorldCompilationStarted',
    Type.Object(
      {
        inputHash: NotificationHash,
        runId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'WorldCompilationFailed',
    Type.Object(
      {
        errorCode: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
        inputHash: NotificationHash,
        runId: NotificationId,
        worldId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'WorldCompilationSucceeded',
    Type.Object(
      {
        artifactHash: NotificationHash,
        inputHash: NotificationHash,
        runId: NotificationId,
        worldId: NotificationId,
        worldVersionId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
  notification(
    'WorldActivated',
    Type.Object(
      {
        artifactHash: NotificationHash,
        runId: NotificationId,
        worldId: NotificationId,
        worldVersionId: NotificationId,
      },
      { additionalProperties: false },
    ),
  ),
]);

export type ApplicationNotification = Static<typeof ApplicationNotificationSchema>;
export type ApplicationNotificationType = ApplicationNotification['type'];

export type CommandEnvelope = Static<typeof CommandEnvelopeSchema>;
