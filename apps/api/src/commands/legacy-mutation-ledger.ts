import { createHash } from 'node:crypto';

import type { QueryResult, QueryResultRow } from 'pg';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  DomainEventEnvelopeV1Schema,
  HISTORY_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  createValidator,
  type CommandEnvelope,
  type DomainEventEnvelopeV1,
  type LedgerActorType,
  type LedgerEntryV1,
  type LedgerPayloadClassification,
  type ManifestApprovedPayloadV1,
  type ManifestRevisionCreatedPayloadV1,
  type WorldInvitationAcceptedPayloadV1,
  type WorldInvitationCreatedPayloadV1,
  type WorldInvitationRevokedPayloadV1,
  type WorldMembershipRemovedPayloadV1,
  type WorldMembershipRoleChangedPayloadV1,
  type WorldRenamedPayloadV1,
} from '@worldgraph/contracts';
import {
  LEDGER_GENESIS_PREVIOUS_HASH,
  projectWorldHistoryEntryV1,
  sealDomainEventV1,
  sealLedgerEntryV1,
} from '@worldgraph/ledger';

import { ApplicationError } from '../application/errors.js';

export interface LegacyLedgerExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export type LegacyBuiltCommand = CommandEnvelope & { requestHashBytes: Buffer };

export interface LegacyMutationCommandContext {
  actorType: Extract<LedgerActorType, 'platform_admin' | 'user'>;
  authorizationRuleId: string;
  command: LegacyBuiltCommand;
  decidedAt: Date;
  overrideId?: string | null;
}

export type LegacyWorldMutationEvent =
  | {
      aggregateId: string;
      aggregateType: 'world';
      eventType: 'WorldRenamedV1';
      payload: WorldRenamedPayloadV1;
    }
  | {
      aggregateId: string;
      aggregateType: 'world_membership';
      eventType: 'WorldMembershipRoleChangedV1';
      payload: WorldMembershipRoleChangedPayloadV1;
    }
  | {
      aggregateId: string;
      aggregateType: 'world_membership';
      eventType: 'WorldMembershipRemovedV1';
      payload: WorldMembershipRemovedPayloadV1;
    }
  | {
      aggregateId: string;
      aggregateType: 'world_invitation';
      eventType: 'WorldInvitationCreatedV1';
      payload: WorldInvitationCreatedPayloadV1;
    }
  | {
      aggregateId: string;
      aggregateType: 'world_invitation';
      eventType: 'WorldInvitationRevokedV1';
      payload: WorldInvitationRevokedPayloadV1;
    }
  | {
      aggregateId: string;
      aggregateType: 'world_invitation';
      eventType: 'WorldInvitationAcceptedV1';
      payload: WorldInvitationAcceptedPayloadV1;
    }
  | {
      aggregateId: string;
      aggregateType: 'world_membership';
      eventType: 'CreatorOverrideUsedV1';
      payload: Extract<DomainEventEnvelopeV1, { eventType: 'CreatorOverrideUsedV1' }>['payload'];
    }
  | {
      aggregateId: string;
      aggregateType: 'manifest_revision';
      eventType: 'ManifestRevisionCreatedV1';
      payload: ManifestRevisionCreatedPayloadV1;
    }
  | {
      aggregateId: string;
      aggregateType: 'manifest_revision';
      eventType: 'ManifestApprovedV1';
      payload: ManifestApprovedPayloadV1;
    };

export interface AppendLegacyMutationInput extends LegacyMutationCommandContext {
  event: LegacyWorldMutationEvent;
  worldId: string;
}

export interface RejectLegacyMutationInput {
  actorType: Extract<LedgerActorType, 'platform_admin' | 'user'>;
  command: LegacyBuiltCommand;
  decidedAt: Date;
  rejectionCode: LegacyLedgerRejectionCode;
  worldId: string;
}

export type LegacyLedgerRejectionCode =
  | 'VALIDATION_FAILED'
  | 'AUTHORIZATION_DENIED'
  | 'WORLD_NOT_ACTIVE'
  | 'WORLD_NOT_ANCHORED'
  | 'WORLD_VERSION_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'AGGREGATE_VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ENTITY_NOT_FOUND'
  | 'ENTITY_TYPE_NOT_RENAMEABLE'
  | 'DISPLAY_NAME_UNCHANGED'
  | 'COMMAND_TYPE_DISABLED'
  | 'INTERNAL_COMMAND_FAILED';

export type LegacyLedgerAppendResult =
  { kind: 'appended'; resultingStateRevision: string } | { kind: 'unanchored' };

interface HeadRow extends QueryResultRow {
  last_entry_hash: Buffer | null;
  ledger_anchored_at: Date | null;
  ledger_head_anchored_at: Date | null;
  next_event_sequence: string;
  next_ledger_sequence: string;
  state_revision: string;
}

interface AggregateRow extends QueryResultRow {
  aggregate_version: string;
}

const eventValidator = createValidator<DomainEventEnvelopeV1>(DomainEventEnvelopeV1Schema);

const legacyMutationRegistry = {
  'creator_override.use': {
    commandType: 'UseCreatorOverrideV1',
    eventType: 'CreatorOverrideUsedV1',
    payloadClassification: 'private',
    publicSummaryCode: 'CREATOR_OVERRIDE_USED',
  },
  'invitation.accept': {
    commandType: 'AcceptWorldInvitationV1',
    eventType: 'WorldInvitationAcceptedV1',
    payloadClassification: 'private',
    publicSummaryCode: 'WORLD_INVITATION_ACCEPTED',
  },
  'invitation.create': {
    commandType: 'CreateWorldInvitationV1',
    eventType: 'WorldInvitationCreatedV1',
    payloadClassification: 'private',
    publicSummaryCode: 'WORLD_INVITATION_CREATED',
  },
  'invitation.revoke': {
    commandType: 'RevokeWorldInvitationV1',
    eventType: 'WorldInvitationRevokedV1',
    payloadClassification: 'private',
    publicSummaryCode: 'WORLD_INVITATION_REVOKED',
  },
  'manifest.revision.approve': {
    commandType: 'ApproveManifestRevisionV1',
    eventType: 'ManifestApprovedV1',
    payloadClassification: 'member',
    publicSummaryCode: 'MANIFEST_APPROVED',
  },
  'manifest.revision.create': {
    commandType: 'CreateManifestRevisionV1',
    eventType: 'ManifestRevisionCreatedV1',
    payloadClassification: 'member',
    publicSummaryCode: 'MANIFEST_REVISION_CREATED',
  },
  'membership.change_role': {
    commandType: 'ChangeWorldMembershipRoleV1',
    eventType: 'WorldMembershipRoleChangedV1',
    payloadClassification: 'private',
    publicSummaryCode: 'WORLD_MEMBERSHIP_ROLE_CHANGED',
  },
  'membership.remove': {
    commandType: 'RemoveWorldMembershipV1',
    eventType: 'WorldMembershipRemovedV1',
    payloadClassification: 'private',
    publicSummaryCode: 'WORLD_MEMBERSHIP_REMOVED',
  },
  'world.rename': {
    commandType: 'RenameWorldV1',
    eventType: 'WorldRenamedV1',
    payloadClassification: 'member',
    publicSummaryCode: 'WORLD_RENAMED',
  },
} as const satisfies Record<
  string,
  {
    commandType: `${string}V1`;
    eventType: LegacyWorldMutationEvent['eventType'];
    payloadClassification: LedgerPayloadClassification;
    publicSummaryCode: string;
  }
>;

export const LEGACY_LEDGER_ADAPTED_ACTIONS = Object.freeze(
  Object.keys(legacyMutationRegistry).sort(),
);

const durableRejectionKey = 'worldgraphLedgerRejection';

export function legacyLedgerRejectionCode(error: ApplicationError): LegacyLedgerRejectionCode {
  switch (error.code) {
    case 'FORBIDDEN':
    case 'CREATOR_OVERRIDE_REQUIRED':
      return 'AUTHORIZATION_DENIED';
    case 'WORLD_NOT_ACTIVE':
      return 'WORLD_NOT_ACTIVE';
    case 'WORLD_NOT_ANCHORED':
      return 'WORLD_NOT_ANCHORED';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'IDEMPOTENCY_KEY_REUSED';
    case 'NOT_FOUND':
    case 'INVITATION_NOT_AVAILABLE':
      return 'ENTITY_NOT_FOUND';
    case 'STALE_VERSION':
    case 'STALE_MANIFEST_REVISION':
    case 'MANIFEST_APPROVAL_CONFLICT':
    case 'MANIFEST_NOT_LATEST':
    case 'MANIFEST_REVISION_CONFLICT':
      return 'REVISION_CONFLICT';
    case 'AGGREGATE_VERSION_CONFLICT':
      return 'AGGREGATE_VERSION_CONFLICT';
    case 'DISPLAY_NAME_UNCHANGED':
      return 'DISPLAY_NAME_UNCHANGED';
    case 'COMMAND_TYPE_DISABLED':
      return 'COMMAND_TYPE_DISABLED';
    default:
      return error.statusCode >= 500 ? 'INTERNAL_COMMAND_FAILED' : 'VALIDATION_FAILED';
  }
}

/** Safe idempotency body used to replay a committed legacy-route rejection. */
export function encodeDurableLegacyRejection(error: ApplicationError): Record<string, unknown> {
  const details = privacySafeJson(error.details, 0);
  const rejection = {
    code: error.code.slice(0, 120),
    ...(details && typeof details === 'object' && !Array.isArray(details) ? { details } : {}),
    message: error.message.slice(0, 500),
    statusCode: error.statusCode,
  };
  const body = { [durableRejectionKey]: rejection };
  return Buffer.byteLength(JSON.stringify(body), 'utf8') <= 60_000
    ? body
    : {
        [durableRejectionKey]: {
          code: rejection.code,
          message: rejection.message,
          statusCode: rejection.statusCode,
        },
      };
}

export function decodeDurableLegacyRejection(
  body: Record<string, unknown>,
): ApplicationError | null {
  const value = body[durableRejectionKey];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (
    typeof stored.code !== 'string' ||
    typeof stored.message !== 'string' ||
    typeof stored.statusCode !== 'number'
  ) {
    return null;
  }
  const details =
    stored.details && typeof stored.details === 'object' && !Array.isArray(stored.details)
      ? (stored.details as Record<string, unknown>)
      : undefined;
  return new ApplicationError(stored.code, stored.message, stored.statusCode, details);
}

/**
 * Appends the accepted command, one allowlisted event, ledger links, history,
 * outbox reference, projection checkpoint and runtime head in the caller's transaction.
 * Draft/pre-genesis worlds intentionally return `unanchored`.
 */
export async function appendAcceptedLegacyMutation(
  executor: LegacyLedgerExecutor,
  input: AppendLegacyMutationInput,
): Promise<LegacyLedgerAppendResult> {
  const registration = registrationFor(input.command.action);
  if (!registration || registration.eventType !== input.event.eventType) {
    throw new TypeError('Legacy mutation action/event registration mismatch.');
  }
  assertWorldBinding(input.command, input.worldId);
  const head = await lockAnchoredHead(executor, input.worldId);
  if (!head) return { kind: 'unanchored' };

  const recordedAt = input.decidedAt.toISOString();
  const resultingStateRevision = incrementDecimal(head.state_revision);
  await insertReceivedCommand(executor, {
    actorType: input.actorType,
    command: input.command,
    commandType: registration.commandType,
    expectedStateRevision: head.state_revision,
    payloadClassification: registration.payloadClassification,
    recordedAt: input.decidedAt,
    worldId: input.worldId,
  });
  await executor.query('select worldgraph_open_command_write($1,$2)', [
    input.command.commandId,
    input.worldId,
  ]);

  const aggregate = await executor.query<AggregateRow>(
    `select coalesce((
       select current_version + 1 from aggregate_stream_heads
        where world_id = $1 and aggregate_type = $2 and aggregate_id = $3
     ), 1)::text as aggregate_version`,
    [input.worldId, input.event.aggregateType, input.event.aggregateId],
  );
  const aggregateVersion = aggregate.rows[0]?.aggregate_version;
  if (!aggregateVersion) throw new Error('Could not allocate legacy aggregate version.');

  const actor = { actorId: input.command.actorUserId, actorType: input.actorType } as const;
  const eventId = derivedUuid(input.command.commandId, 'event:0');
  const event = sealDomainEventV1({
    aggregateId: input.event.aggregateId,
    aggregateType: input.event.aggregateType,
    aggregateVersion,
    commandId: input.command.commandId,
    eventId,
    eventOrdinal: 0,
    eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
    eventType: input.event.eventType,
    metadata: {
      actor,
      authorizationRuleId: input.authorizationRuleId,
      causationId: null,
      commandSchemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      commandType: registration.commandType,
      correlationId: input.command.correlationId,
      overrideId: input.overrideId ?? null,
      payloadClassification: registration.payloadClassification,
    },
    occurredAt: recordedAt,
    payload: input.event.payload,
    recordedAt,
    resultingStateRevision,
    worldEventSequence: head.next_event_sequence,
    worldId: input.worldId,
  });
  if (!eventValidator.is(event)) throw new TypeError('Invalid adapted domain event contract.');

  await executor.query(
    `insert into domain_events(
       id, world_id, world_event_sequence, command_id, event_ordinal,
       aggregate_type, aggregate_id, aggregate_version, event_type,
       event_schema_version, payload, metadata, event_hash, occurred_at,
       recorded_at, resulting_state_revision
     ) values ($1,$2,$3::bigint,$4,0,$5,$6,$7::bigint,$8,$9,$10,$11,$12,$13,$13,$14::bigint)`,
    [
      event.eventId,
      input.worldId,
      event.worldEventSequence,
      input.command.commandId,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.eventType,
      event.eventSchemaVersion,
      JSON.stringify(event.payload),
      JSON.stringify(event.metadata),
      Buffer.from(event.eventHash, 'hex'),
      input.decidedAt,
      event.resultingStateRevision,
    ],
  );

  const acceptedEntry = sealLedgerEntryV1({
    actor,
    commandId: input.command.commandId,
    entryId: derivedUuid(input.command.commandId, 'ledger:accepted'),
    entryKind: 'command_accepted',
    eventId: null,
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    ledgerSequence: head.next_ledger_sequence,
    previousHash: head.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
    publicSummaryCode: 'COMMAND_ACCEPTED',
    recordedAt,
    redactedDetails: {
      authorizationRuleId: input.authorizationRuleId,
      commandType: registration.commandType,
    },
    worldId: input.worldId,
  });
  await insertLedgerEntry(executor, acceptedEntry);
  const eventLedgerSequence = incrementDecimal(head.next_ledger_sequence);
  const eventEntry = sealLedgerEntryV1({
    actor,
    commandId: input.command.commandId,
    entryId: derivedUuid(input.command.commandId, 'ledger:event:0'),
    entryKind: event.eventType === 'CreatorOverrideUsedV1' ? 'override' : 'domain_event',
    eventId: event.eventId,
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    ledgerSequence: eventLedgerSequence,
    previousHash: acceptedEntry.entryHash,
    publicSummaryCode: registration.publicSummaryCode,
    recordedAt,
    redactedDetails: {
      aggregateType: event.aggregateType,
      eventType: event.eventType,
      targetHash: sha256(event.aggregateId),
    },
    worldId: input.worldId,
  });
  await insertLedgerEntry(executor, eventEntry);

  const history = projectWorldHistoryEntryV1(event, eventEntry);
  await executor.query(
    `insert into world_history_entries(
       world_id, ledger_sequence, command_id, event_id, event_type,
       history_schema_version, occurred_at, category, title_key, summary_args,
       actor_type, actor_id, target_type, target_id, visibility, correlation_id,
       resulting_state_revision
     ) values ($1,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::bigint)`,
    [
      history.worldId,
      history.ledgerSequence,
      history.commandId,
      history.eventId,
      history.eventType,
      HISTORY_SCHEMA_VERSION,
      input.decidedAt,
      history.category,
      history.titleKey,
      JSON.stringify(history.summaryArgs),
      history.actor.actorType,
      history.actor.actorId,
      history.targetType,
      history.targetId,
      history.visibility,
      history.correlationId,
      history.resultingStateRevision,
    ],
  );
  await executor.query(
    `insert into outbox_messages(
       id, world_id, event_id, message_type, message_schema_version,
       payload, status, attempts, available_at, created_at
     ) values ($1,$2,$3,'DomainEventReferenceV1',$4,$5,'pending',0,$6,$6)`,
    [
      derivedUuid(input.command.commandId, 'outbox:event:0'),
      input.worldId,
      event.eventId,
      OUTBOX_SCHEMA_VERSION,
      JSON.stringify({
        eventId: event.eventId,
        eventType: event.eventType,
        worldEventSequence: event.worldEventSequence,
        worldId: input.worldId,
      }),
      input.decidedAt,
    ],
  );

  const checksumResult = await executor.query<{ checksum: Buffer } & QueryResultRow>(
    'select worldgraph_projection_checksum($1,$2::bigint) as checksum',
    [input.worldId, resultingStateRevision],
  );
  const checksum = checksumResult.rows[0]?.checksum;
  if (!checksum) throw new Error('Could not compute adapted projection checksum.');
  const checkpoint = await executor.query(
    `update projection_checkpoints
        set projection_schema_version = $2,
            last_event_sequence = $3::bigint,
            checksum = $4,
            status = 'current',
            updated_at = greatest(updated_at, $5)
      where world_id = $1 and projection_name = 'world_graph'`,
    [input.worldId, PROJECTION_SCHEMA_VERSION, event.worldEventSequence, checksum, input.decidedAt],
  );
  if ((checkpoint.rowCount ?? 0) !== 1) throw new Error('World projection checkpoint is missing.');
  const runtime = await executor.query(
    `update world_runtime_heads
        set state_revision = $2::bigint,
            last_ledger_sequence = $3::bigint,
            last_event_sequence = $4::bigint,
            projection_checksum = $5,
            updated_at = greatest(updated_at, $6)
      where world_id = $1 and state_revision = $7::bigint`,
    [
      input.worldId,
      resultingStateRevision,
      eventLedgerSequence,
      event.worldEventSequence,
      checksum,
      input.decidedAt,
      head.state_revision,
    ],
  );
  if ((runtime.rowCount ?? 0) !== 1) {
    throw new ApplicationError('REVISION_CONFLICT', 'The world state changed.', 409);
  }

  const result = {
    commandId: input.command.commandId,
    eventIds: [event.eventId],
    eventSequenceRange: { from: event.worldEventSequence, to: event.worldEventSequence },
    ledgerSequenceRange: { from: head.next_ledger_sequence, to: eventLedgerSequence },
    resultingStateRevision,
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    status: 'accepted',
  } as const;
  const terminal = await executor.query(
    `update command_records
        set status = 'accepted', authorization_rule_id = $2, override_id = $3,
            decided_at = $4, resulting_state_revision = $5::bigint, response_summary = $6
      where id = $1 and status = 'received'`,
    [
      input.command.commandId,
      input.authorizationRuleId,
      input.overrideId ?? null,
      input.decidedAt,
      resultingStateRevision,
      JSON.stringify(result),
    ],
  );
  if ((terminal.rowCount ?? 0) !== 1) throw new Error('Legacy command did not become accepted.');
  return { kind: 'appended', resultingStateRevision };
}

/** Records a durable, privacy-safe rejection when an adapted route fails inside its transaction. */
export async function appendRejectedLegacyMutation(
  executor: LegacyLedgerExecutor,
  input: RejectLegacyMutationInput,
): Promise<LegacyLedgerAppendResult> {
  const registration = registrationFor(input.command.action);
  if (!registration) return { kind: 'unanchored' };
  assertWorldBinding(input.command, input.worldId);
  const head = await lockAnchoredHead(executor, input.worldId);
  if (!head) return { kind: 'unanchored' };

  await insertReceivedCommand(executor, {
    actorType: input.actorType,
    command: input.command,
    commandType: registration.commandType,
    expectedStateRevision: head.state_revision,
    payloadClassification: registration.payloadClassification,
    recordedAt: input.decidedAt,
    worldId: input.worldId,
  });
  await executor.query('select worldgraph_open_command_write($1,$2)', [
    input.command.commandId,
    input.worldId,
  ]);
  const recordedAt = input.decidedAt.toISOString();
  const actor = { actorId: input.command.actorUserId, actorType: input.actorType } as const;
  const rejectedEntry = sealLedgerEntryV1({
    actor,
    commandId: input.command.commandId,
    entryId: derivedUuid(input.command.commandId, 'ledger:rejected'),
    entryKind: 'command_rejected',
    eventId: null,
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    ledgerSequence: head.next_ledger_sequence,
    previousHash: head.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
    publicSummaryCode: 'COMMAND_REJECTED',
    recordedAt,
    redactedDetails: {
      commandType: registration.commandType,
      rejectionCode: input.rejectionCode,
      targetHash: sha256(input.worldId),
    },
    worldId: input.worldId,
  });
  await insertLedgerEntry(executor, rejectedEntry);
  await executor.query(
    `insert into world_history_entries(
       world_id, ledger_sequence, command_id, event_id, event_type,
       history_schema_version, occurred_at, category, title_key, summary_args,
       actor_type, actor_id, target_type, target_id, visibility, correlation_id,
       resulting_state_revision
     ) values (
       $1,$2::bigint,$3,null,null,$4,$5,'command','history.command.rejected',$6,
       $7,$8,'world',($1::uuid)::text,'creator',$9,null
     )`,
    [
      input.worldId,
      head.next_ledger_sequence,
      input.command.commandId,
      HISTORY_SCHEMA_VERSION,
      input.decidedAt,
      JSON.stringify({ commandType: registration.commandType, rejectionCode: input.rejectionCode }),
      input.actorType,
      input.command.actorUserId,
      input.command.correlationId,
    ],
  );
  const runtime = await executor.query(
    `update world_runtime_heads
        set last_ledger_sequence = $2::bigint,
            updated_at = greatest(updated_at, $3)
      where world_id = $1 and state_revision = $4::bigint`,
    [input.worldId, head.next_ledger_sequence, input.decidedAt, head.state_revision],
  );
  if ((runtime.rowCount ?? 0) !== 1) {
    throw new ApplicationError('REVISION_CONFLICT', 'The world state changed.', 409);
  }
  const result = {
    commandId: input.command.commandId,
    currentStateRevision: head.state_revision,
    eventIds: [],
    rejectionCode: input.rejectionCode,
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    status: 'rejected',
  } as const;
  const terminal = await executor.query(
    `update command_records
        set status = 'rejected', rejection_code = $2,
            decided_at = $3, response_summary = $4
      where id = $1 and status = 'received'`,
    [input.command.commandId, input.rejectionCode, input.decidedAt, JSON.stringify(result)],
  );
  if ((terminal.rowCount ?? 0) !== 1) throw new Error('Legacy command did not become rejected.');
  return { kind: 'appended', resultingStateRevision: head.state_revision };
}

function registrationFor(action: string) {
  return legacyMutationRegistry[action as keyof typeof legacyMutationRegistry];
}

async function lockAnchoredHead(
  executor: LegacyLedgerExecutor,
  worldId: string,
): Promise<HeadRow | null> {
  const result = await executor.query<HeadRow>(
    `select runtime.state_revision::text,
            runtime.ledger_anchored_at,
            ledger.anchored_at as ledger_head_anchored_at,
            ledger.next_event_sequence::text,
            ledger.next_ledger_sequence::text,
            ledger.last_entry_hash
       from world_runtime_heads runtime
       join world_ledger_heads ledger on ledger.world_id = runtime.world_id
      where runtime.world_id = $1`,
    [worldId],
  );
  const head = result.rows[0];
  if (!head) {
    const world = await executor.query<{ lifecycle: string } & QueryResultRow>(
      'select lifecycle::text from worlds where id = $1',
      [worldId],
    );
    if (world.rows[0]?.lifecycle === 'active') {
      throw new ApplicationError(
        'WORLD_NOT_ANCHORED',
        'The active world ledger anchor is unavailable.',
        503,
      );
    }
    return null;
  }
  if (!head.ledger_anchored_at && !head.ledger_head_anchored_at) return null;
  if (!head.ledger_anchored_at || !head.ledger_head_anchored_at) {
    throw new ApplicationError(
      'WORLD_NOT_ANCHORED',
      'The world ledger anchor is inconsistent.',
      503,
    );
  }
  return head;
}

async function insertReceivedCommand(
  executor: LegacyLedgerExecutor,
  input: {
    actorType: 'platform_admin' | 'user';
    command: LegacyBuiltCommand;
    commandType: string;
    expectedStateRevision: string;
    payloadClassification: LedgerPayloadClassification;
    recordedAt: Date;
    worldId: string;
  },
): Promise<void> {
  await executor.query(
    `insert into command_records(
       id, world_id, command_type, command_schema_version, actor_type, actor_id,
       payload, payload_hash, payload_classification, idempotency_key, request_hash,
       expected_world_version, expected_state_revision, correlation_id, causation_id,
       requested_at
     ) values (
       $1,$2,$3,$4,$5,$6,null,$7,$8,$9,$7,$10::bigint,$11::bigint,
       $12,null,$13
     )`,
    [
      input.command.commandId,
      input.worldId,
      input.commandType,
      AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      input.actorType,
      input.command.actorUserId,
      input.command.requestHashBytes,
      input.payloadClassification,
      input.command.idempotencyKey,
      input.command.expectedRowVersion ?? null,
      input.expectedStateRevision,
      input.command.correlationId,
      input.recordedAt,
    ],
  );
}

async function insertLedgerEntry(
  executor: LegacyLedgerExecutor,
  entry: LedgerEntryV1,
): Promise<void> {
  await executor.query(
    `insert into ledger_entries(
       id, world_id, ledger_sequence, entry_kind, command_id, event_id,
       actor_type, actor_id, public_summary_code, redacted_details,
       previous_hash, entry_hash, recorded_at
     ) values ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      entry.entryId,
      entry.worldId,
      entry.ledgerSequence,
      entry.entryKind,
      entry.commandId,
      entry.eventId,
      entry.actor.actorType,
      entry.actor.actorId,
      entry.publicSummaryCode,
      JSON.stringify(entry.redactedDetails),
      Buffer.from(entry.previousHash, 'hex'),
      Buffer.from(entry.entryHash, 'hex'),
      new Date(entry.recordedAt),
    ],
  );
}

function assertWorldBinding(command: LegacyBuiltCommand, worldId: string): void {
  if (command.resourceId && command.resourceId !== worldId) {
    throw new TypeError('Legacy command world binding mismatch.');
  }
}

function incrementDecimal(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable child identities make retries reproduce the same immutable rows. */
export function derivedLegacyLedgerUuid(commandId: string, purpose: string): string {
  return derivedUuid(commandId, purpose);
}

function derivedUuid(commandId: string, purpose: string): string {
  const bytes = createHash('sha256')
    .update('worldgraph.legacy-ledger-id.v1\0', 'utf8')
    .update(commandId, 'utf8')
    .update('\0', 'utf8')
    .update(purpose, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sensitiveKeys = new Set([
  'authorization',
  'apikey',
  'api_key',
  'cookie',
  'credential',
  'credentials',
  'csrf',
  'password',
  'passwordhash',
  'password_hash',
  'rawtoken',
  'raw_token',
  'secret',
  'sessiontoken',
  'session_token',
  'token',
]);

function privacySafeJson(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 1_000);
  if (depth >= 6) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => privacySafeJson(item, depth + 1) ?? null);
  }
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveKeys.has(key.toLocaleLowerCase('en-US')))
      .slice(0, 100)
      .flatMap(([key, item]) => {
        const safe = privacySafeJson(item, depth + 1);
        return safe === undefined ? [] : [[key.slice(0, 160), safe]];
      }),
  );
}
