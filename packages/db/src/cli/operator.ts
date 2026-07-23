import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg, { type Pool as PgPool, type PoolClient as PgPoolClient } from 'pg';

import {
  canonicalJson,
  CommerceProjectionRepairApprovalV1Schema,
  CommerceProjectionRepairExecutionReceiptV1Schema,
  createValidator,
  DomainEventEnvelopeV1Schema,
  EconomyRepairPlanV1Schema,
  LedgerEntryV1Schema,
  type CompiledWorldV1,
  type CommerceProjectionRepairApprovalV1,
  type CommerceProjectionRepairExecutionReceiptV1,
  type DomainEventEnvelopeV1,
  type EconomyRepairPlanV1,
  type LedgerEntryV1,
  type Validator,
} from '@worldgraph/contracts';
import {
  compareSimulationProjectionDocumentV1,
  createWorldProjectionV1,
  exportLedgerV1,
  replaySimulationProjectionV1,
  replayWorldProjectionV1,
  simulationProjectionDocumentV1,
  verifyLedgerChainV1,
  type SimulationProjectionDocumentV1,
  type WorldProjectionV1,
} from '@worldgraph/ledger';

import {
  assertOperatorCommerceProjectionRepairPlan,
  COMMERCE_PROJECTION_REPAIR_APPROVAL_CONFIRMATION,
  COMMERCE_PROJECTION_REPAIR_EXECUTION_CONFIRMATION,
  validateCommerceProjectionRepairReason,
} from './commerce-projection-repair.js';

const { Pool } = pg;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,18}$/u;
const ECONOMY_REPAIR_CONFIRMATION = 'APPLY APPEND-ONLY ECONOMY REPAIR';
const OUTBOX_RETRY_CONFIRMATION = 'RETRY DEAD OUTBOX MESSAGE';
const ECONOMY_REPAIR_REASON_CODES = new Set([
  'DUPLICATE_EFFECT',
  'ERRONEOUS_EFFECT',
  'INCIDENT_RECOVERY',
]);
const eventValidator: Validator<DomainEventEnvelopeV1> = createValidator<DomainEventEnvelopeV1>(
  DomainEventEnvelopeV1Schema,
);
const entryValidator: Validator<LedgerEntryV1> =
  createValidator<LedgerEntryV1>(LedgerEntryV1Schema);
const economyRepairPlanValidator: Validator<EconomyRepairPlanV1> =
  createValidator<EconomyRepairPlanV1>(EconomyRepairPlanV1Schema);
const commerceProjectionRepairApprovalValidator: Validator<CommerceProjectionRepairApprovalV1> =
  createValidator<CommerceProjectionRepairApprovalV1>(CommerceProjectionRepairApprovalV1Schema);
const commerceProjectionRepairExecutionReceiptValidator: Validator<CommerceProjectionRepairExecutionReceiptV1> =
  createValidator<CommerceProjectionRepairExecutionReceiptV1>(
    CommerceProjectionRepairExecutionReceiptV1Schema,
  );

interface Arguments {
  flags: Map<string, string[]>;
  operation: string;
  scope: string;
}

interface OperatorIdentity {
  actorUserId: string;
  databaseRole: string;
}

function parseArguments(values: readonly string[]): Arguments {
  const scope = values[0] ?? '';
  const operation = values[1] ?? '';
  const flags = new Map<string, string[]>();
  for (let index = 2; index < values.length; index += 1) {
    const token = values[index]!;
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split('=', 2);
    if (!name) fail('An option name is required.');
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) fail(`A value is required for --${name}.`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { flags, operation, scope };
}

function required(args: Arguments, name: string): string {
  const values = args.flags.get(name);
  if (values?.length !== 1 || !values[0]) fail(`Exactly one --${name} value is required.`);
  return values[0];
}

function optional(args: Arguments, name: string): string | undefined {
  const values = args.flags.get(name);
  if (!values) return undefined;
  if (values.length !== 1 || !values[0]) fail(`At most one --${name} value is allowed.`);
  return values[0];
}

function worldId(args: Arguments): string {
  const value = required(args, 'world');
  if (!UUID_PATTERN.test(value)) fail('--world must be a UUID.');
  return value.toLowerCase();
}

function actorUserId(args: Arguments): string {
  const value = required(args, 'actor');
  if (!UUID_PATTERN.test(value)) fail('--actor must be an active platform-administrator UUID.');
  return value.toLowerCase();
}

function uuid(args: Arguments, name: string): string {
  const value = required(args, name);
  if (!UUID_PATTERN.test(value)) fail(`--${name} must be a UUID.`);
  return value.toLowerCase();
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function economyRepairReason(args: Arguments, name: string): string {
  const value = required(args, name);
  const characterLength = [...value].length;
  if (
    characterLength < 8 ||
    characterLength > 500 ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    containsControlCharacter(value)
  ) {
    fail(
      `--${name} must contain 8-500 Unicode code points without edge ASCII spaces or C0/DEL/C1 controls.`,
    );
  }
  return value;
}

function outboxRetryReason(args: Arguments): string {
  const value = required(args, 'reason');
  const characterLength = [...value].length;
  if (
    characterLength < 20 ||
    characterLength > 1_000 ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    containsControlCharacter(value)
  ) {
    fail(
      '--reason must contain 20-1000 Unicode code points without edge ASCII spaces or C0/DEL/C1 controls.',
    );
  }
  return value;
}

function economyRepairReasonCode(args: Arguments): string {
  const value = required(args, 'reason-code');
  if (!ECONOMY_REPAIR_REASON_CODES.has(value)) {
    fail('--reason-code must be DUPLICATE_EFFECT, ERRONEOUS_EFFECT, or INCIDENT_RECOVERY.');
  }
  return value;
}

function economyRepairPlanHash(args: Arguments): string {
  const value = required(args, 'plan-hash');
  if (!SHA256_PATTERN.test(value)) fail('--plan-hash must be 64 lowercase hexadecimal characters.');
  return value;
}

function commerceProjectionRepairPlanHash(args: Arguments): string {
  const value = required(args, 'plan-hash');
  if (!SHA256_PATTERN.test(value)) {
    fail('--plan-hash must be 64 lowercase hexadecimal characters.');
  }
  return value;
}

function requireExactFlags(args: Arguments, allowed: readonly string[]): void {
  const allowedNames = new Set(allowed);
  const unknown = [...args.flags.keys()].filter((name) => !allowedNames.has(name)).sort();
  if (unknown.length > 0)
    fail(`Unexpected option for ${args.scope} ${args.operation}: --${unknown[0]}.`);
}

function positiveInteger(args: Arguments, name: string): string | undefined {
  const value = optional(args, name);
  if (value !== undefined && !POSITIVE_INTEGER_PATTERN.test(value)) {
    fail(`--${name} must be a positive decimal integer.`);
  }
  return value;
}

type OperatorProjectionName = 'simulation_runtime' | 'world_graph';

function projectionName(args: Arguments): OperatorProjectionName {
  const value = optional(args, 'projection') ?? 'world_graph';
  if (value !== 'world_graph' && value !== 'simulation_runtime') {
    fail('--projection must be world_graph or simulation_runtime.');
  }
  return value;
}

function connectionString(requireOperations = false): string {
  const value = requireOperations
    ? process.env.OPERATIONS_DATABASE_URL
    : (process.env.OPERATIONS_DATABASE_URL ?? process.env.DATABASE_URL);
  if (!value) {
    fail(
      requireOperations
        ? 'OPERATIONS_DATABASE_URL is required for this operator operation.'
        : 'OPERATIONS_DATABASE_URL or DATABASE_URL is required.',
    );
  }
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}

function bufferHash(value: Buffer | null): string | null {
  return value?.toString('hex') ?? null;
}

function canonicalTimestamp(value: Date): string {
  return value.toISOString();
}

async function requireOperatorAuthorization(
  pool: PgPool,
  args: Arguments,
): Promise<OperatorIdentity> {
  const checkedActorUserId = actorUserId(args);
  const result = await pool.query<{
    actor_authorized: boolean;
    database_authorized: boolean;
    database_role: string;
  }>(
    `select session_user::text as database_role,
            (
              current_user = pg_get_userbyid(database.datdba)
              or pg_has_role(current_user, database.datdba, 'MEMBER')
            ) as database_authorized,
            exists (
              select 1 from users
               where id = $1 and status = 'active' and platform_role = 'platform_admin'
            ) as actor_authorized
       from pg_database database
      where database.datname = current_database()`,
    [checkedActorUserId],
  );
  const authorization = result.rows[0];
  if (!authorization?.database_authorized) {
    fail('The connected database role is not authorized for operator operations.');
  }
  if (!authorization.actor_authorized) {
    fail('--actor must identify an active platform administrator.');
  }
  return {
    actorUserId: checkedActorUserId,
    databaseRole: authorization.database_role,
  };
}

interface EventRow {
  aggregate_id: string;
  aggregate_type: string;
  aggregate_version: string;
  command_id: string;
  event_hash: Buffer;
  event_ordinal: number;
  event_schema_version: number;
  event_type: string;
  id: string;
  metadata: DomainEventEnvelopeV1['metadata'];
  occurred_at: Date;
  payload: DomainEventEnvelopeV1['payload'];
  recorded_at: Date;
  resulting_state_revision: string;
  world_event_sequence: string;
  world_id: string;
}

function eventFromRow(row: EventRow): DomainEventEnvelopeV1 {
  const event = {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    aggregateVersion: row.aggregate_version,
    commandId: row.command_id,
    eventHash: row.event_hash.toString('hex'),
    eventId: row.id,
    eventOrdinal: row.event_ordinal,
    eventSchemaVersion: row.event_schema_version,
    eventType: row.event_type,
    metadata: row.metadata,
    occurredAt: canonicalTimestamp(row.occurred_at),
    payload: row.payload,
    recordedAt: canonicalTimestamp(row.recorded_at),
    resultingStateRevision: row.resulting_state_revision,
    worldEventSequence: row.world_event_sequence,
    worldId: row.world_id,
  } as DomainEventEnvelopeV1;
  eventValidator.assert(event);
  return event;
}

interface EntryRow {
  actor_id: string;
  actor_type: LedgerEntryV1['actor']['actorType'];
  command_id: string | null;
  entry_hash: Buffer;
  entry_kind: LedgerEntryV1['entryKind'];
  event_id: string | null;
  id: string;
  ledger_sequence: string;
  previous_hash: Buffer;
  public_summary_code: string;
  recorded_at: Date;
  redacted_details: Record<string, unknown>;
  world_id: string;
}

function entryFromRow(row: EntryRow): LedgerEntryV1 {
  const entry = {
    actor: { actorId: row.actor_id, actorType: row.actor_type },
    commandId: row.command_id,
    entryHash: row.entry_hash.toString('hex'),
    entryId: row.id,
    entryKind: row.entry_kind,
    eventId: row.event_id,
    ledgerSchemaVersion: 1,
    ledgerSequence: row.ledger_sequence,
    previousHash: row.previous_hash.toString('hex'),
    publicSummaryCode: row.public_summary_code,
    recordedAt: canonicalTimestamp(row.recorded_at),
    redactedDetails: row.redacted_details,
    worldId: row.world_id,
  } as LedgerEntryV1;
  entryValidator.assert(entry);
  return entry;
}

async function loadEvents(pool: PgPool, checkedWorldId: string): Promise<DomainEventEnvelopeV1[]> {
  const result = await pool.query<EventRow>(
    `select id, world_id, world_event_sequence::text, command_id, event_ordinal,
            aggregate_type, aggregate_id, aggregate_version::text, event_type,
            event_schema_version, payload, metadata, event_hash, occurred_at,
            recorded_at, resulting_state_revision::text
       from domain_events where world_id = $1 order by world_event_sequence`,
    [checkedWorldId],
  );
  return result.rows.map(eventFromRow);
}

async function loadEntries(pool: PgPool, checkedWorldId: string): Promise<LedgerEntryV1[]> {
  const result = await pool.query<EntryRow>(
    `select id, world_id, ledger_sequence::text, entry_kind, command_id, event_id,
            actor_type, actor_id, public_summary_code, redacted_details,
            previous_hash, entry_hash, recorded_at
       from ledger_entries where world_id = $1 order by ledger_sequence`,
    [checkedWorldId],
  );
  return result.rows.map(entryFromRow);
}

async function verify(pool: PgPool, checkedWorldId: string): Promise<void> {
  const [entries, events, heads] = await Promise.all([
    loadEntries(pool, checkedWorldId),
    loadEvents(pool, checkedWorldId),
    pool.query<{
      last_entry_hash: Buffer | null;
      last_event_sequence: string;
      last_ledger_sequence: string;
      next_event_sequence: string;
      next_ledger_sequence: string;
      projection_checksum: Buffer | null;
      recomputed_projection_checksum: Buffer;
      simulation_checkpoint_checksum: Buffer | null;
      simulation_checkpoint_sequence: string | null;
      simulation_checkpoint_status: string | null;
      simulation_recomputed_checksum: Buffer | null;
    }>(
      `select ledger.last_entry_hash, (ledger.next_event_sequence - 1)::text as next_event_sequence,
              (ledger.next_ledger_sequence - 1)::text as next_ledger_sequence,
              runtime.last_event_sequence::text, runtime.last_ledger_sequence::text,
              runtime.projection_checksum,
              worldgraph_projection_checksum($1) as recomputed_projection_checksum,
              simulation.checksum as simulation_checkpoint_checksum,
              simulation.last_event_sequence::text as simulation_checkpoint_sequence,
              simulation.status::text as simulation_checkpoint_status,
              worldgraph_simulation_projection_checksum($1) as simulation_recomputed_checksum
         from world_ledger_heads ledger
         join world_runtime_heads runtime on runtime.world_id = ledger.world_id
         left join projection_checkpoints simulation
           on simulation.world_id=runtime.world_id
          and simulation.projection_name='simulation_runtime'
        where ledger.world_id = $1`,
      [checkedWorldId],
    ),
  ]);
  const result = verifyLedgerChainV1({ entries, events, expectedWorldId: checkedWorldId });
  if (!result.valid) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 2;
    return;
  }
  const head = heads.rows[0];
  if (!head) fail('The world has no ledger/runtime head.');
  const failures: string[] = [];
  if (result.lastEntryHash !== bufferHash(head.last_entry_hash))
    failures.push('HEAD_HASH_MISMATCH');
  if (result.lastLedgerSequence !== head.next_ledger_sequence) failures.push('LEDGER_HEAD_GAP');
  if (result.lastLedgerSequence !== head.last_ledger_sequence) failures.push('RUNTIME_LEDGER_GAP');
  if (String(events.length) !== head.next_event_sequence) failures.push('EVENT_HEAD_GAP');
  if (String(events.length) !== head.last_event_sequence) failures.push('RUNTIME_EVENT_GAP');
  if (bufferHash(head.projection_checksum) !== bufferHash(head.recomputed_projection_checksum)) {
    failures.push('PROJECTION_CHECKSUM_MISMATCH');
  }
  if (
    head.simulation_checkpoint_checksum === null ||
    head.simulation_checkpoint_sequence === null ||
    head.simulation_checkpoint_status === null ||
    head.simulation_recomputed_checksum === null
  ) {
    failures.push('SIMULATION_CHECKPOINT_MISSING');
  } else {
    if (head.simulation_checkpoint_sequence !== head.last_event_sequence) {
      failures.push('SIMULATION_CHECKPOINT_EVENT_GAP');
    }
    if (head.simulation_checkpoint_status !== 'current') {
      failures.push('SIMULATION_CHECKPOINT_NOT_CURRENT');
    }
    if (
      bufferHash(head.simulation_checkpoint_checksum) !==
      bufferHash(head.simulation_recomputed_checksum)
    ) {
      failures.push('SIMULATION_PROJECTION_CHECKSUM_MISMATCH');
    }
  }
  const output = { ...result, failures, projectionChecksumValid: failures.length === 0 };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (failures.length > 0) process.exitCode = 2;
}

interface SimulationReplaySource {
  active_world_version_id: string;
  artifact_seed: string;
  artifact_hash: Buffer;
  last_event_sequence: string;
  projection_checksum: Buffer;
  projection_status: string;
  seed: string;
  version_number: string;
}

async function loadSimulationReplaySource(
  pool: PgPool,
  checkedWorldId: string,
  events: readonly DomainEventEnvelopeV1[],
): Promise<SimulationReplaySource> {
  const result = await pool.query<SimulationReplaySource>(
    `select runtime.active_world_version_id::text, runtime.last_event_sequence::text,
            version.version_number::text, version.seed, version.artifact_hash,
            artifact.canonical_content->>'seed' as artifact_seed,
            checkpoint.checksum as projection_checksum,
            checkpoint.status::text as projection_status
       from world_runtime_heads runtime
       join world_versions version
         on version.world_id=runtime.world_id and version.id=runtime.active_world_version_id
       join compiled_world_artifacts artifact
         on artifact.world_id=version.world_id
        and artifact.compilation_run_id=version.compilation_run_id
        and artifact.artifact_kind='compiled_world'
        and artifact.content_hash=version.artifact_hash
       join projection_checkpoints checkpoint
         on checkpoint.world_id=runtime.world_id
        and checkpoint.projection_name='simulation_runtime'
        and checkpoint.projection_schema_version=1
        and checkpoint.last_event_sequence=runtime.last_event_sequence
      where runtime.world_id=$1 and runtime.ledger_anchored_at is not null`,
    [checkedWorldId],
  );
  const source = result.rows[0];
  if (!source || source.projection_status !== 'current') {
    fail('The current simulation projection checkpoint is missing or not current.');
  }
  if (events.at(-1)?.worldEventSequence !== source.last_event_sequence) {
    fail('The loaded event stream does not end at the simulation checkpoint source head.');
  }
  const genesis = events[0];
  if (
    !genesis ||
    (genesis.eventType !== 'WorldCompiledGenesisV1' && genesis.eventType !== 'WorldStateImportedV1')
  ) {
    fail('The first world event is not a recognized genesis anchor.');
  }
  if (
    genesis.worldId !== checkedWorldId ||
    genesis.payload.activeWorldVersionId !== source.active_world_version_id ||
    genesis.payload.worldVersionNumber !== source.version_number ||
    genesis.payload.artifactHash !== source.artifact_hash.toString('hex') ||
    source.seed !== source.artifact_seed
  ) {
    fail('The active world seed/version does not match the honest genesis anchor.');
  }
  return source;
}

async function ledgerExport(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  const fromLedgerSequence = positiveInteger(args, 'from');
  const toLedgerSequence = positiveInteger(args, 'to');
  const outputPath = resolve(required(args, 'output'));
  const auditCorrelationId = randomUUID();
  await pool.query(
    `insert into security_audit_records(
       id, actor_user_id, world_id, category, action, outcome, reason_code,
       target_type, target_id, request_id, correlation_id, redacted_metadata
     ) values (
       $1::uuid, $2, $3, 'command_ledger', 'ledger.export.authorized', 'allowed',
       'OPERATOR_EXPORT_AUTHORIZED', 'world', $3,
       ($1::uuid)::text, ($1::uuid)::text, $4::jsonb
     )`,
    [
      auditCorrelationId,
      operator.actorUserId,
      checkedWorldId,
      JSON.stringify({
        databaseRole: operator.databaseRole,
        requestedFromLedgerSequence: fromLedgerSequence ?? null,
        requestedToLedgerSequence: toLedgerSequence ?? null,
      }),
    ],
  );
  const [entries, events] = await Promise.all([
    loadEntries(pool, checkedWorldId),
    loadEvents(pool, checkedWorldId),
  ]);
  const exported = exportLedgerV1({
    entries,
    events,
    ...(fromLedgerSequence ? { fromLedgerSequence } : {}),
    ...(toLedgerSequence ? { toLedgerSequence } : {}),
    worldId: checkedWorldId,
  });
  const handle = await open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJson(exported)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  const auditId = randomUUID();
  await pool.query(
    `insert into security_audit_records(
       id, actor_user_id, world_id, category, action, outcome, reason_code,
       target_type, target_id, request_id, correlation_id, redacted_metadata
     ) values (
       $1::uuid, $2, $3, 'command_ledger', 'ledger.export.completed', 'succeeded',
       'OPERATOR_EXPORT_COMPLETED', 'world', $3,
       ($1::uuid)::text, $4::text, $5::jsonb
     )`,
    [
      auditId,
      operator.actorUserId,
      checkedWorldId,
      auditCorrelationId,
      JSON.stringify({
        databaseRole: operator.databaseRole,
        entryCount: exported.entries.length,
        eventCount: exported.events.length,
        exportHash: exported.exportHash,
        fromLedgerSequence: exported.fromLedgerSequence,
        toLedgerSequence: exported.toLedgerSequence,
      }),
    ],
  );
  process.stdout.write(
    `${JSON.stringify({ auditCorrelationId, auditId, entryCount: exported.entries.length, eventCount: exported.events.length, exportHash: exported.exportHash, output: outputPath })}\n`,
  );
}

async function loadGenesisProjection(
  pool: PgPool,
  checkedWorldId: string,
  events: readonly DomainEventEnvelopeV1[],
): Promise<WorldProjectionV1> {
  const genesis = events[0];
  if (
    !genesis ||
    (genesis.eventType !== 'WorldCompiledGenesisV1' && genesis.eventType !== 'WorldStateImportedV1')
  ) {
    fail('The first world event is not a recognized genesis anchor.');
  }
  const artifact = await pool.query<{ canonical_content: CompiledWorldV1 }>(
    `select artifact.canonical_content
       from world_versions version
       join compiled_world_artifacts artifact
         on artifact.compilation_run_id = version.compilation_run_id
        and artifact.world_id = version.world_id and artifact.artifact_kind = 'compiled_world'
      where version.world_id = $1 and version.id = $2`,
    [checkedWorldId, genesis.payload.activeWorldVersionId],
  );
  const compiledWorld = artifact.rows[0]?.canonical_content;
  if (!compiledWorld) fail('The immutable compiled genesis artifact is missing.');
  return createWorldProjectionV1({
    activeWorldVersionId: genesis.payload.activeWorldVersionId,
    compiledWorld,
    stateRevision: genesis.resultingStateRevision,
    worldId: checkedWorldId,
    worldVersionNumber: genesis.payload.worldVersionNumber,
  });
}

function memberPrincipalKey(checkedWorldId: string, userId: string): string {
  const digest = createHash('sha256')
    .update(
      `worldgraph-member-principal-v1\0${checkedWorldId.toLowerCase()}\0${userId.toLowerCase()}`,
      'utf8',
    )
    .digest('hex');
  return `member-${digest.slice(0, 32)}`;
}

async function persistShadow(
  client: PgPoolClient,
  runId: string,
  projection: WorldProjectionV1,
): Promise<void> {
  const liveEntities = await client.query<{ id: string; logical_key: string }>(
    `select id, logical_key::text
       from world_entities
      where world_id=$1 and retired_world_version_id is null
      order by logical_key collate "C", id`,
    [projection.worldId],
  );
  const entityIds = new Map(liveEntities.rows.map((row) => [row.logical_key, row.id]));
  if (
    liveEntities.rowCount !== projection.entities.length ||
    projection.entities.some((entity) => !entityIds.has(entity.logicalKey))
  ) {
    fail('Replay entity identity set does not match the active projection.');
  }
  for (const entity of projection.entities) {
    const entityId = entityIds.get(entity.logicalKey)!;
    await client.query(
      `insert into shadow_world_entities
        (replay_run_id, world_id, entity_id, logical_key, entity_type,
         entity_schema_version, state, row_version)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        runId,
        projection.worldId,
        entityId,
        entity.logicalKey,
        entity.entityType,
        entity.entitySchemaVersion,
        JSON.stringify(entity.state),
        BigInt(entity.entityVersion) - 1n,
      ],
    );
  }
  const liveRelationships = await client.query<{ id: string; logical_key: string }>(
    `select id, logical_key::text
       from world_relationships
      where world_id=$1 and retired_world_version_id is null
      order by logical_key collate "C", id`,
    [projection.worldId],
  );
  const relationshipIds = new Map(liveRelationships.rows.map((row) => [row.logical_key, row.id]));
  if (
    liveRelationships.rowCount !== projection.relationships.length ||
    projection.relationships.some((relationship) => !relationshipIds.has(relationship.logicalKey))
  ) {
    fail('Replay relationship identity set does not match the active projection.');
  }
  for (const relationship of projection.relationships) {
    const sourceId = entityIds.get(relationship.sourceLogicalKey);
    const targetId = entityIds.get(relationship.targetLogicalKey);
    if (!sourceId || !targetId) fail('Replay produced a dangling relationship.');
    await client.query(
      `insert into shadow_world_relationships
        (replay_run_id, world_id, relationship_id, logical_key, relationship_type,
         source_entity_id, target_entity_id, relationship_schema_version, attributes, row_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,0)`,
      [
        runId,
        projection.worldId,
        relationshipIds.get(relationship.logicalKey),
        relationship.logicalKey,
        relationship.relationshipType,
        sourceId,
        targetId,
        relationship.relationshipSchemaVersion,
        JSON.stringify(relationship.attributes),
      ],
    );
  }
  const members = await client.query<{ user_id: string }>(
    `select user_id from world_memberships where world_id=$1 order by user_id`,
    [projection.worldId],
  );
  const usersByPrincipal = new Map(
    members.rows.map((row) => [memberPrincipalKey(projection.worldId, row.user_id), row.user_id]),
  );
  for (const controller of projection.controllers) {
    const userId = usersByPrincipal.get(controller.principalKey);
    const entityId = entityIds.get(controller.entityLogicalKey);
    if (!userId || !entityId) fail('Replay controller binding cannot be resolved truthfully.');
    await client.query(
      `insert into shadow_world_entity_controllers
        (replay_run_id, world_id, user_id, entity_id, control_scope,
         principal_key, entity_logical_key)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        runId,
        projection.worldId,
        userId,
        entityId,
        controller.controlScope,
        controller.principalKey,
        controller.entityLogicalKey,
      ],
    );
  }
}

async function projectionReplay(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  const selectedProjection = projectionName(args);
  const target = required(args, 'target');
  if (
    (selectedProjection === 'world_graph' && target !== 'shadow') ||
    (selectedProjection === 'simulation_runtime' && target !== 'verify')
  ) {
    fail(
      selectedProjection === 'world_graph'
        ? '--target must be shadow for world_graph.'
        : '--target must be verify for simulation_runtime.',
    );
  }
  const reason = required(args, 'reason').trim();
  if (reason.length < 1 || reason.length > 500) {
    fail('Replay reason is outside the audited bounds.');
  }
  const events = await loadEvents(pool, checkedWorldId);
  if (selectedProjection === 'simulation_runtime') {
    return await simulationProjectionReplay(pool, checkedWorldId, operator, reason, events);
  }
  const genesisProjection = await loadGenesisProjection(pool, checkedWorldId, events);
  const head = await pool.query<{ projection_checksum: Buffer; last_event_sequence: string }>(
    `select projection_checksum, last_event_sequence::text
       from world_runtime_heads where world_id = $1 and ledger_anchored_at is not null`,
    [checkedWorldId],
  );
  const runtime = head.rows[0];
  if (!runtime) fail('The world is not ledger anchored.');
  const runId = randomUUID();
  await pool.query(
    `insert into projection_replay_runs
      (id, world_id, projection_name, target_schema_version,
       requested_by_actor_type, requested_by_actor_id, from_event_sequence,
       to_event_sequence, source_checksum, reason)
     values ($1,$2,'world_graph',1,'platform_admin',$3,1,$4,$5,$6)`,
    [
      runId,
      checkedWorldId,
      operator.actorUserId,
      runtime.last_event_sequence,
      runtime.projection_checksum,
      reason,
    ],
  );
  await pool.query(
    `update projection_replay_runs set status='running', started_at=clock_timestamp(),
      updated_at=clock_timestamp() where id=$1 and status='pending'`,
    [runId],
  );
  try {
    const replayed = replayWorldProjectionV1({ events, genesisProjection });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await persistShadow(client, runId, replayed.projection);
      await client.query(
        `update projection_replay_runs
            set status='succeeded', replay_checksum=decode($2,'hex'),
                completed_at=clock_timestamp(), updated_at=clock_timestamp()
          where id=$1 and status='running'`,
        [runId, replayed.checksum],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    process.stdout.write(
      `${JSON.stringify({ checksum: replayed.checksum, eventCount: replayed.eventCount, lastEventSequence: replayed.lastEventSequence, projectionName: selectedProjection, runId, target: 'shadow' })}\n`,
    );
  } catch (error) {
    await pool.query(
      `update projection_replay_runs set status='failed', failure_code='REPLAY_FAILED',
        completed_at=clock_timestamp(), updated_at=clock_timestamp()
       where id=$1 and status='running'`,
      [runId],
    );
    throw error;
  }
}

async function simulationProjectionReplay(
  pool: PgPool,
  checkedWorldId: string,
  operator: OperatorIdentity,
  reason: string,
  events: readonly DomainEventEnvelopeV1[],
): Promise<void> {
  const source = await loadSimulationReplaySource(pool, checkedWorldId, events);
  const runId = randomUUID();
  await pool.query(
    `insert into projection_replay_runs
      (id, world_id, projection_name, target_schema_version,
       requested_by_actor_type, requested_by_actor_id, from_event_sequence,
       to_event_sequence, source_checksum, reason)
     values ($1,$2,'simulation_runtime',1,'platform_admin',$3,1,$4,$5,$6)`,
    [
      runId,
      checkedWorldId,
      operator.actorUserId,
      source.last_event_sequence,
      source.projection_checksum,
      reason,
    ],
  );
  await pool.query(
    `update projection_replay_runs set status='running', started_at=clock_timestamp(),
      updated_at=clock_timestamp() where id=$1 and status='pending'`,
    [runId],
  );
  try {
    const replayed = replaySimulationProjectionV1({
      events,
      worldId: checkedWorldId,
      worldSeed: source.seed,
    });
    await pool.query(
      `update projection_replay_runs
          set status='succeeded', replay_checksum=decode($2,'hex'),
              completed_at=clock_timestamp(), updated_at=clock_timestamp()
        where id=$1 and status='running'`,
      [runId, replayed.checksum],
    );
    process.stdout.write(
      `${JSON.stringify({ checksum: replayed.checksum, eventCount: replayed.eventCount, lastEventSequence: replayed.lastEventSequence, projectionName: 'simulation_runtime', runId, simulationEventCount: replayed.simulationEventCount, sourceChecksum: source.projection_checksum.toString('hex'), sourceMatchesReplay: source.projection_checksum.toString('hex') === replayed.checksum, target: 'verify' })}\n`,
    );
  } catch (error) {
    await pool.query(
      `update projection_replay_runs set status='failed', failure_code='REPLAY_FAILED',
        completed_at=clock_timestamp(), updated_at=clock_timestamp()
       where id=$1 and status='running'`,
      [runId],
    );
    throw error;
  }
}

async function projectionCompare(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
): Promise<void> {
  const runId = required(args, 'run');
  if (!UUID_PATTERN.test(runId)) fail('--run must be a UUID.');
  const result = await pool.query<{
    current_event_sequence: string;
    live_checksum: Buffer;
    projection_name: OperatorProjectionName;
    replay_checksum: Buffer;
    source_checksum: Buffer;
    to_event_sequence: string;
  }>(
    `select case run.projection_name
              when 'world_graph' then worldgraph_projection_checksum(run.world_id)
              when 'simulation_runtime' then worldgraph_simulation_projection_checksum(run.world_id)
            end as live_checksum,
            run.projection_name, run.replay_checksum, run.source_checksum,
            run.to_event_sequence::text,
            runtime.last_event_sequence::text as current_event_sequence
      from projection_replay_runs run
       join world_runtime_heads runtime on runtime.world_id=run.world_id
      where run.id=$1 and run.world_id=$2 and run.status='succeeded'
        and run.projection_name in ('world_graph','simulation_runtime')`,
    [runId, checkedWorldId],
  );
  const row = result.rows[0];
  if (!row) fail('The successful replay run was not found.');
  const requestedProjection = optional(args, 'projection');
  if (requestedProjection !== undefined && requestedProjection !== row.projection_name) {
    fail('The replay run projection does not match --projection.');
  }
  const liveChecksum = row.live_checksum.toString('hex');
  const replayChecksum = row.replay_checksum.toString('hex');
  const sourceChecksum = row.source_checksum.toString('hex');
  const sourceMatchesReplay = row.source_checksum.equals(row.replay_checksum);
  const liveMatchesReplay = liveChecksum === replayChecksum;
  const sourceHeadUnchanged = row.current_event_sequence === row.to_event_sequence;
  if (!sourceHeadUnchanged) {
    process.stdout.write(
      `${JSON.stringify({ currentEventSequence: row.current_event_sequence, equal: false, firstDivergencePath: null, liveChecksum, liveMatchesReplay, projectionName: row.projection_name, replayChecksum, runId, sourceChecksum, sourceEventSequence: row.to_event_sequence, sourceHeadUnchanged, sourceMatchesReplay, worldId: checkedWorldId })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  let equal = liveMatchesReplay;
  let firstDivergencePath: string | null = equal ? null : '/';
  if (row.projection_name === 'simulation_runtime') {
    const events = await loadEvents(pool, checkedWorldId);
    const source = await loadSimulationReplaySource(pool, checkedWorldId, events);
    const replayed = replaySimulationProjectionV1({
      events,
      worldId: checkedWorldId,
      worldSeed: source.seed,
    });
    if (replayed.checksum !== replayChecksum) {
      fail('The durable simulation replay checksum cannot be reproduced at its source head.');
    }
    const liveDocument = await pool.query<{ document: SimulationProjectionDocumentV1 }>(
      'select worldgraph_simulation_projection_document($1) as document',
      [checkedWorldId],
    );
    const document = liveDocument.rows[0]?.document;
    if (!document) fail('The live simulation projection document is missing.');
    const comparison = compareSimulationProjectionDocumentV1(
      document,
      simulationProjectionDocumentV1(replayed.projection),
    );
    if (comparison.liveChecksum !== liveChecksum) {
      fail('JavaScript and PostgreSQL simulation projection checksums differ.');
    }
    equal = comparison.equal;
    firstDivergencePath = comparison.firstDivergencePath;
  }
  process.stdout.write(
    `${JSON.stringify({ equal, firstDivergencePath, liveChecksum, liveMatchesReplay: equal, projectionName: row.projection_name, replayChecksum, runId, sourceChecksum, sourceHeadUnchanged, sourceMatchesReplay, worldId: checkedWorldId })}\n`,
  );
  if (!equal || !sourceMatchesReplay) process.exitCode = 2;
}

async function projectionRepairSwap(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  if (required(args, 'confirm') !== 'REPAIR-SWAP') fail('--confirm=REPAIR-SWAP is required.');
  const approvals = args.flags.get('approved-by') ?? [];
  if (
    approvals.length !== 2 ||
    approvals[0] === approvals[1] ||
    approvals.some((approval) => !UUID_PATTERN.test(approval))
  ) {
    fail('Exactly two distinct UUID --approved-by values are required.');
  }
  const runId = required(args, 'run');
  const reason = required(args, 'reason').trim();
  if (!UUID_PATTERN.test(runId) || reason.length < 1 || reason.length > 500) {
    fail('Repair run/reason is invalid.');
  }
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const result = await pool.query<{
    ledger_sequence: string;
    projection_checksum: Buffer;
    resulting_state_revision: string;
  }>(`select * from worldgraph_projection_repair_swap($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
    runId,
    checkedWorldId,
    reason,
    operator.actorUserId,
    approvals[0],
    approvals[1],
    ...ids,
  ]);
  const repaired = result.rows[0];
  if (!repaired) fail('Projection repair did not return an audited result.');
  process.stdout.write(
    `${JSON.stringify({ ledgerSequence: repaired.ledger_sequence, projectionChecksum: repaired.projection_checksum.toString('hex'), resultingStateRevision: repaired.resulting_state_revision, runId, worldId: checkedWorldId })}\n`,
  );
}

interface EconomyRepairPreparationRow {
  repair_plan: unknown;
}

function assertOperatorEconomyRepairPlan(value: unknown): EconomyRepairPlanV1 {
  economyRepairPlanValidator.assert(value);
  const plan = value;
  const preparedAt = Date.parse(plan.preparedAt);
  const expiresAt = Date.parse(plan.expiresAt);
  const reservedIds = [plan.repairPlanId, plan.reservedCommandId, plan.sourceCommandId];
  const compensationIds = [
    plan.delta.financialDelta?.compensationTransactionId,
    plan.delta.titleDelta?.compensationTransferId,
  ].filter((id): id is string => id !== undefined);
  if (
    plan.repairKind !== plan.delta.repairKind ||
    expiresAt - preparedAt !== 86_400_000 ||
    new Set(reservedIds).size !== reservedIds.length ||
    compensationIds.some((id) => reservedIds.includes(id)) ||
    new Set(compensationIds).size !== compensationIds.length
  ) {
    fail('Economy repair preparation returned a semantically invalid plan.');
  }
  const { planHash, ...planBody } = plan;
  const computedHash = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'worldgraph.economy-repair-plan-hash.v1',
        plan: planBody,
      }),
      'utf8',
    )
    .digest('hex');
  if (computedHash !== planHash) {
    fail('Economy repair preparation returned a plan with an invalid canonical hash.');
  }
  return plan;
}

async function economyRepairPrepare(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  requireExactFlags(args, [
    'actor',
    'incident-reason',
    'pitr-not-used-reason',
    'reason-code',
    'source-command',
    'world',
  ]);
  const sourceCommandId = uuid(args, 'source-command');
  const reasonCode = economyRepairReasonCode(args);
  const incidentReason = economyRepairReason(args, 'incident-reason');
  const pitrNotUsedReason = economyRepairReason(args, 'pitr-not-used-reason');
  const result = await pool.query<EconomyRepairPreparationRow>(
    `select worldgraph_prepare_economy_repair($1,$2,$3,$4,$5,$6) as repair_plan`,
    [
      checkedWorldId,
      sourceCommandId,
      operator.actorUserId,
      reasonCode,
      incidentReason,
      pitrNotUsedReason,
    ],
  );
  const plan = assertOperatorEconomyRepairPlan(result.rows[0]?.repair_plan);
  if (
    plan.worldId !== checkedWorldId ||
    plan.sourceCommandId !== sourceCommandId ||
    plan.preparedByUserId !== operator.actorUserId ||
    plan.reasonCode !== reasonCode ||
    plan.incidentReason !== incidentReason ||
    plan.pitrNotUsedReason !== pitrNotUsedReason
  ) {
    fail('Economy repair preparation returned a mismatched plan identity.');
  }
  process.stdout.write(`${canonicalJson(plan)}\n`);
}

interface EconomyRepairExecutionRow {
  asset_transfer_id: string | null;
  command_id: string;
  economy_checksum: Buffer;
  event_id: string;
  financial_transaction_id: string | null;
  ledger_entry_id: string;
  repair_plan_id: string;
  resulting_event_sequence: string;
  resulting_ledger_sequence: string;
  resulting_state_revision: string;
}

async function economyRepairExecute(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  requireExactFlags(args, ['actor', 'confirm', 'plan', 'plan-hash', 'world']);
  const repairPlanId = uuid(args, 'plan');
  const planHash = economyRepairPlanHash(args);
  if (required(args, 'confirm') !== ECONOMY_REPAIR_CONFIRMATION) {
    fail(`--confirm=${ECONOMY_REPAIR_CONFIRMATION} is required.`);
  }
  const scopedPlan = await pool.query(
    `select 1 from economy_repair_plans
      where id=$1 and world_id=$2 and plan_hash=decode($3,'hex')`,
    [repairPlanId, checkedWorldId, planHash],
  );
  if (scopedPlan.rowCount !== 1) {
    fail('The exact economy repair plan/hash was not found in this world.');
  }
  const result = await pool.query<EconomyRepairExecutionRow>(
    `select * from worldgraph_execute_economy_repair($1,$2,$3,$4)`,
    [repairPlanId, operator.actorUserId, planHash, ECONOMY_REPAIR_CONFIRMATION],
  );
  const repaired = result.rows[0];
  if (
    !repaired ||
    repaired.repair_plan_id.toLowerCase() !== repairPlanId ||
    !UUID_PATTERN.test(repaired.command_id) ||
    !UUID_PATTERN.test(repaired.event_id) ||
    !UUID_PATTERN.test(repaired.ledger_entry_id) ||
    (repaired.financial_transaction_id !== null &&
      !UUID_PATTERN.test(repaired.financial_transaction_id)) ||
    (repaired.asset_transfer_id !== null && !UUID_PATTERN.test(repaired.asset_transfer_id)) ||
    (repaired.financial_transaction_id === null && repaired.asset_transfer_id === null) ||
    !POSITIVE_INTEGER_PATTERN.test(repaired.resulting_state_revision) ||
    !POSITIVE_INTEGER_PATTERN.test(repaired.resulting_event_sequence) ||
    !POSITIVE_INTEGER_PATTERN.test(repaired.resulting_ledger_sequence) ||
    repaired.economy_checksum.length !== 32
  ) {
    fail('Economy repair execution did not return its exact audited result.');
  }
  process.stdout.write(
    `${JSON.stringify({
      assetTransferId: repaired.asset_transfer_id,
      commandId: repaired.command_id,
      economyChecksum: repaired.economy_checksum.toString('hex'),
      eventId: repaired.event_id,
      financialTransactionId: repaired.financial_transaction_id,
      ledgerEntryId: repaired.ledger_entry_id,
      repairPlanId,
      resultingEventSequence: repaired.resulting_event_sequence,
      resultingLedgerSequence: repaired.resulting_ledger_sequence,
      resultingStateRevision: repaired.resulting_state_revision,
      worldId: checkedWorldId,
    })}\n`,
  );
}

interface CommerceProjectionRepairPreparationRow {
  repair_plan: unknown;
}

async function commerceProjectionRepairPrepare(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  requireExactFlags(args, ['actor', 'reason', 'world']);
  const reason = validateCommerceProjectionRepairReason(required(args, 'reason'));
  const result = await pool.query<CommerceProjectionRepairPreparationRow>(
    `select worldgraph_prepare_commerce_projection_repair($1,$2,$3) as repair_plan`,
    [checkedWorldId, operator.actorUserId, reason],
  );
  const plan = assertOperatorCommerceProjectionRepairPlan(result.rows[0]?.repair_plan);
  if (
    plan.worldId !== checkedWorldId ||
    plan.preparedByUserId !== operator.actorUserId ||
    plan.reason !== reason
  ) {
    fail('Commerce projection repair preparation returned a mismatched plan identity.');
  }
  process.stdout.write(`${canonicalJson(plan)}\n`);
}

async function scopedCommerceProjectionRepairPlan(
  pool: PgPool,
  repairPlanId: string,
  checkedWorldId: string,
  planHash: string,
): Promise<{ prepared_by_user_id: string }> {
  const result = await pool.query<{ prepared_by_user_id: string }>(
    `select prepared_by_user_id
       from commerce_projection_repair_plans
      where id=$1 and world_id=$2 and plan_hash=decode($3,'hex')`,
    [repairPlanId, checkedWorldId, planHash],
  );
  const plan = result.rows[0];
  if (!plan) fail('The exact commerce projection repair plan/hash was not found in this world.');
  return plan;
}

interface CommerceProjectionRepairApprovalRow {
  approval: unknown;
}

async function commerceProjectionRepairApprove(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  requireExactFlags(args, ['actor', 'approval', 'confirm', 'plan', 'plan-hash', 'world']);
  const repairPlanId = uuid(args, 'plan');
  const approvalId = uuid(args, 'approval');
  const planHash = commerceProjectionRepairPlanHash(args);
  if (required(args, 'confirm') !== COMMERCE_PROJECTION_REPAIR_APPROVAL_CONFIRMATION) {
    fail(`--confirm=${COMMERCE_PROJECTION_REPAIR_APPROVAL_CONFIRMATION} is required.`);
  }
  const plan = await scopedCommerceProjectionRepairPlan(
    pool,
    repairPlanId,
    checkedWorldId,
    planHash,
  );
  if (plan.prepared_by_user_id === operator.actorUserId) {
    fail('Commerce projection repair approval requires an administrator distinct from preparer.');
  }
  const result = await pool.query<CommerceProjectionRepairApprovalRow>(
    `select worldgraph_approve_commerce_projection_repair($1,$2,$3,$4,$5) as approval`,
    [
      repairPlanId,
      operator.actorUserId,
      approvalId,
      planHash,
      COMMERCE_PROJECTION_REPAIR_APPROVAL_CONFIRMATION,
    ],
  );
  const approval = result.rows[0]?.approval;
  commerceProjectionRepairApprovalValidator.assert(approval);
  if (
    approval.approvalId !== approvalId ||
    approval.approverUserId !== operator.actorUserId ||
    approval.planHash !== planHash ||
    approval.repairPlanId !== repairPlanId ||
    approval.worldId !== checkedWorldId
  ) {
    fail('Commerce projection repair approval returned a mismatched sealed identity.');
  }
  process.stdout.write(`${canonicalJson(approval)}\n`);
}

interface CommerceProjectionRepairExecutionRow {
  command_id: string;
  event_id: string;
  ledger_entry_id: string;
  reconciliation_run_id: string;
  repair_fact_count: number;
  repair_plan_id: string;
  resulting_checksum: Buffer;
  resulting_event_sequence: string;
  resulting_ledger_sequence: string;
  resulting_state_revision: string;
}

async function commerceProjectionRepairExecute(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  requireExactFlags(args, ['actor', 'confirm', 'plan', 'plan-hash', 'world']);
  const repairPlanId = uuid(args, 'plan');
  const planHash = commerceProjectionRepairPlanHash(args);
  if (required(args, 'confirm') !== COMMERCE_PROJECTION_REPAIR_EXECUTION_CONFIRMATION) {
    fail(`--confirm=${COMMERCE_PROJECTION_REPAIR_EXECUTION_CONFIRMATION} is required.`);
  }
  await scopedCommerceProjectionRepairPlan(pool, repairPlanId, checkedWorldId, planHash);
  const result = await pool.query<CommerceProjectionRepairExecutionRow>(
    `select * from worldgraph_execute_commerce_projection_repair($1,$2,$3,$4)`,
    [
      repairPlanId,
      operator.actorUserId,
      planHash,
      COMMERCE_PROJECTION_REPAIR_EXECUTION_CONFIRMATION,
    ],
  );
  const repaired = result.rows[0];
  if (
    !repaired ||
    typeof repaired.repair_plan_id !== 'string' ||
    repaired.repair_plan_id.toLowerCase() !== repairPlanId ||
    !UUID_PATTERN.test(repaired.command_id) ||
    !UUID_PATTERN.test(repaired.event_id) ||
    !UUID_PATTERN.test(repaired.ledger_entry_id) ||
    !UUID_PATTERN.test(repaired.reconciliation_run_id) ||
    !Number.isSafeInteger(repaired.repair_fact_count) ||
    repaired.repair_fact_count < 1 ||
    repaired.repair_fact_count > 10_000 ||
    !POSITIVE_INTEGER_PATTERN.test(repaired.resulting_state_revision) ||
    !POSITIVE_INTEGER_PATTERN.test(repaired.resulting_event_sequence) ||
    !POSITIVE_INTEGER_PATTERN.test(repaired.resulting_ledger_sequence) ||
    !Buffer.isBuffer(repaired.resulting_checksum) ||
    repaired.resulting_checksum.length !== 32
  ) {
    fail('Commerce projection repair execution did not return its exact audited result.');
  }
  const receipt: CommerceProjectionRepairExecutionReceiptV1 = {
    commandId: repaired.command_id,
    eventId: repaired.event_id,
    ledgerEntryId: repaired.ledger_entry_id,
    reconciliationRunId: repaired.reconciliation_run_id,
    repairFactCount: repaired.repair_fact_count,
    repairPlanId,
    resultingChecksum: repaired.resulting_checksum.toString('hex'),
    resultingEventSequence: repaired.resulting_event_sequence,
    resultingLedgerSequence: repaired.resulting_ledger_sequence,
    resultingStateRevision: repaired.resulting_state_revision,
    schemaVersion: 1,
    worldId: checkedWorldId,
  };
  commerceProjectionRepairExecutionReceiptValidator.assert(receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

interface OutboxRetryRow {
  current_attempts: number;
  current_status: 'dead' | 'pending' | 'published';
  idempotent_replay: boolean;
  outbox_message_id: string;
  previous_attempts: number;
  requeued_at: Date;
  retry_intent_id: string;
  world_id: string;
}

async function outboxRetry(
  pool: PgPool,
  args: Arguments,
  checkedWorldId: string,
  operator: OperatorIdentity,
): Promise<void> {
  requireExactFlags(args, ['actor', 'confirm', 'message', 'reason', 'retry', 'world']);
  const outboxMessageId = uuid(args, 'message');
  const retryIntentId = uuid(args, 'retry');
  const reason = outboxRetryReason(args);
  if (required(args, 'confirm') !== OUTBOX_RETRY_CONFIRMATION) {
    fail(`--confirm=${OUTBOX_RETRY_CONFIRMATION} is required.`);
  }
  const result = await pool.query<OutboxRetryRow>(
    `select * from worldgraph_retry_dead_outbox_message($1,$2,$3,$4,$5,$6)`,
    [
      checkedWorldId,
      outboxMessageId,
      retryIntentId,
      operator.actorUserId,
      reason,
      OUTBOX_RETRY_CONFIRMATION,
    ],
  );
  const retried = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !retried ||
    retried.world_id.toLowerCase() !== checkedWorldId ||
    retried.outbox_message_id.toLowerCase() !== outboxMessageId ||
    retried.retry_intent_id.toLowerCase() !== retryIntentId ||
    !Number.isSafeInteger(retried.previous_attempts) ||
    retried.previous_attempts < 1 ||
    !Number.isSafeInteger(retried.current_attempts) ||
    retried.current_attempts < retried.previous_attempts ||
    !(retried.requeued_at instanceof Date) ||
    Number.isNaN(retried.requeued_at.getTime()) ||
    typeof retried.idempotent_replay !== 'boolean' ||
    !['dead', 'pending', 'published'].includes(retried.current_status) ||
    (!retried.idempotent_replay &&
      (retried.current_status !== 'pending' ||
        retried.current_attempts !== retried.previous_attempts))
  ) {
    fail('Outbox retry did not return its exact audited result.');
  }
  if (retried.idempotent_replay && retried.current_status === 'dead') {
    fail(
      'This retry identity was already used and the outbox message is dead again; review the new failure and use a new --retry identity.',
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      currentAttempts: retried.current_attempts,
      currentStatus: retried.current_status,
      idempotentReplay: retried.idempotent_replay,
      outboxMessageId,
      previousAttempts: retried.previous_attempts,
      requeuedAt: canonicalTimestamp(retried.requeued_at),
      retryIntentId,
      schemaVersion: 1,
      worldId: checkedWorldId,
    })}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const checkedWorldId = worldId(args);
  const projectionRepair = args.scope === 'projection' && args.operation === 'repair-swap';
  const readOnlyVerification = args.scope === 'ledger' && args.operation === 'verify';
  const pool = new Pool({
    application_name: 'worldgraph-operator-cli',
    connectionString: connectionString(!readOnlyVerification),
    connectionTimeoutMillis: 5_000,
    max: 2,
    query_timeout: 60_000,
    statement_timeout: 60_000,
  });
  try {
    if (args.scope === 'ledger' && args.operation === 'verify')
      return await verify(pool, checkedWorldId);
    const operator = await requireOperatorAuthorization(pool, args);
    if (args.scope === 'ledger' && args.operation === 'export')
      return await ledgerExport(pool, args, checkedWorldId, operator);
    if (args.scope === 'outbox' && args.operation === 'retry')
      return await outboxRetry(pool, args, checkedWorldId, operator);
    if (args.scope === 'projection' && args.operation === 'replay')
      return await projectionReplay(pool, args, checkedWorldId, operator);
    if (args.scope === 'projection' && args.operation === 'compare')
      return await projectionCompare(pool, args, checkedWorldId);
    if (projectionRepair) return await projectionRepairSwap(pool, args, checkedWorldId, operator);
    if (args.scope === 'economy' && args.operation === 'repair-prepare')
      return await economyRepairPrepare(pool, args, checkedWorldId, operator);
    if (args.scope === 'economy' && args.operation === 'repair-execute')
      return await economyRepairExecute(pool, args, checkedWorldId, operator);
    if (args.scope === 'economy' && args.operation === 'projection-repair-prepare')
      return await commerceProjectionRepairPrepare(pool, args, checkedWorldId, operator);
    if (args.scope === 'economy' && args.operation === 'projection-repair-approve')
      return await commerceProjectionRepairApprove(pool, args, checkedWorldId, operator);
    if (args.scope === 'economy' && args.operation === 'projection-repair-execute')
      return await commerceProjectionRepairExecute(pool, args, checkedWorldId, operator);
    fail(
      'Usage: ledger verify|export, outbox retry, projection replay|compare|repair-swap, or economy repair-prepare|repair-execute|projection-repair-prepare|projection-repair-approve|projection-repair-execute.',
    );
  } finally {
    await pool.end();
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Operator command failed.';
  process.stderr.write(`${JSON.stringify({ code: 'OPERATOR_COMMAND_FAILED', message })}\n`);
  process.exitCode = 1;
});
