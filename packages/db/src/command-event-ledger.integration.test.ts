import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalJson } from '@worldgraph/contracts';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient, readRuntimeVersions } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const creatorId = '068f0000-0000-7000-8000-000000000001';
const memberId = '068f0000-0000-7000-8000-000000000002';
const invitedUserId = '068f0000-0000-7000-8000-000000000003';
const administratorId = '068f0000-0000-7000-8000-000000000004';
const worldId = '068f0000-0000-7000-8000-000000000101';
const revisionId = '068f0000-0000-7000-8000-000000000201';
const draftRevisionId = '068f0000-0000-7000-8000-000000000202';
const draftValidationReportId = '068f0000-0000-7000-8000-000000000203';
const pendingInvitationId = '068f0000-0000-7000-8000-000000000801';
const expiredInvitationId = '068f0000-0000-7000-8000-000000000802';
const runId = '068f0000-0000-7000-8000-000000000301';
const versionId = '068f0000-0000-7000-8000-000000000401';
const accountId = '068f0000-0000-7000-8000-000000000501';
const characterId = '068f0000-0000-7000-8000-000000000502';
const relationshipId = '068f0000-0000-7000-8000-000000000601';
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const artifactHash = Buffer.alloc(32, 42);
const manifestHash = Buffer.alloc(32, 43);

function memberPrincipalKey(checkedWorldId: string, userId: string): string {
  return `member-${createHash('sha256')
    .update(
      `worldgraph-member-principal-v1\0${checkedWorldId.toLowerCase()}\0${userId.toLowerCase()}`,
    )
    .digest('hex')
    .slice(0, 32)}`;
}

function sha256Canonical(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

function m06UpgradeRecordId(
  kind: 'command' | 'event' | 'ledger' | 'outbox',
  checkedWorldId: string,
): string {
  const hex = createHash('sha256')
    .update(`worldgraph:m06:upgrade:${kind}:${checkedWorldId.toLowerCase()}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

async function transaction<T>(pool: Pool, operation: (connection: PoolClient) => Promise<T>) {
  const connection = await pool.connect();
  try {
    await connection.query('begin isolation level serializable');
    const value = await operation(connection);
    await connection.query('commit');
    return value;
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

interface LifecycleFactInput {
  aggregateId: string;
  aggregateType: 'manifest_revision' | 'world' | 'world_invitation' | 'world_membership';
  actorId?: string;
  commandId: string;
  commandType: string;
  eventId: string;
  eventType: string;
  firstLedgerEntryId: string;
  outboxId: string;
  overrideId?: string;
  payload: Record<string, unknown>;
  secondLedgerEntryId: string;
}

async function appendAcceptedLifecycleFact(
  connection: PoolClient,
  input: LifecycleFactInput,
): Promise<void> {
  const at = new Date();
  const actorId = input.actorId ?? creatorId;
  const head = await connection.query<{
    last_entry_hash: Buffer;
    next_event_sequence: string;
    next_ledger_sequence: string;
    state_revision: string;
  }>(
    `select ledger.next_event_sequence::text,ledger.next_ledger_sequence::text,
            ledger.last_entry_hash,runtime.state_revision::text
       from world_ledger_heads ledger
       join world_runtime_heads runtime on runtime.world_id=ledger.world_id
      where ledger.world_id=$1`,
    [worldId],
  );
  const allocation = head.rows[0]!;
  const nextStateRevision = String(BigInt(allocation.state_revision) + 1n);
  const nextEventSequence = allocation.next_event_sequence;
  const acceptedLedgerSequence = allocation.next_ledger_sequence;
  const eventLedgerSequence = String(BigInt(acceptedLedgerSequence) + 1n);
  const aggregate = await connection.query<{ version: string }>(
    `select coalesce((select current_version+1 from aggregate_stream_heads
      where world_id=$1 and aggregate_type=$2 and aggregate_id=$3),1)::text version`,
    [worldId, input.aggregateType, input.aggregateId],
  );
  const aggregateVersion = aggregate.rows[0]!.version;
  const metadata = {
    actor: { actorId, actorType: 'user' },
    authorizationRuleId: 'test.lifecycle.exact',
    causationId: null,
    commandSchemaVersion: 1,
    commandType: input.commandType,
    correlationId: input.commandId,
    overrideId: input.overrideId ?? null,
    payloadClassification: 'member',
  };
  const requestHash = sha256Canonical({
    aggregateId: input.aggregateId,
    commandType: input.commandType,
    payload: input.payload,
  });
  await connection.query(
    `insert into command_records(
       id,world_id,command_type,command_schema_version,actor_type,actor_id,
       payload,payload_hash,payload_classification,idempotency_key,request_hash,
       expected_state_revision,correlation_id,requested_at
     ) values ($1,$2,$3,1,'user',$4,null,$5,'member',$6,$5,$7::bigint,$1,$8)`,
    [
      input.commandId,
      worldId,
      input.commandType,
      actorId,
      requestHash,
      `lifecycle-${input.commandId.slice(-12)}`,
      allocation.state_revision,
      at,
    ],
  );
  await connection.query(`select worldgraph_open_command_write($1,$2)`, [input.commandId, worldId]);
  const eventHash = await connection.query<{ hash: Buffer }>(
    `select worldgraph_domain_event_hash_v1(
       $1,$2,$3::bigint,$4,0,$5,$6,$7::bigint,$8,1,$9,$10,$11,$11,$12::bigint
     ) hash`,
    [
      input.eventId,
      worldId,
      nextEventSequence,
      input.commandId,
      input.aggregateType,
      input.aggregateId,
      aggregateVersion,
      input.eventType,
      input.payload,
      metadata,
      at,
      nextStateRevision,
    ],
  );
  await connection.query(
    `insert into domain_events(
       id,world_id,world_event_sequence,command_id,event_ordinal,aggregate_type,
       aggregate_id,aggregate_version,event_type,event_schema_version,payload,metadata,
       event_hash,occurred_at,recorded_at,resulting_state_revision
     ) values ($1,$2,$3::bigint,$4,0,$5,$6,$7::bigint,$8,1,$9,$10,$11,$12,$12,$13::bigint)`,
    [
      input.eventId,
      worldId,
      nextEventSequence,
      input.commandId,
      input.aggregateType,
      input.aggregateId,
      aggregateVersion,
      input.eventType,
      input.payload,
      metadata,
      eventHash.rows[0]!.hash,
      at,
      nextStateRevision,
    ],
  );

  const acceptedDetails = { commandType: input.commandType };
  const acceptedHash = await connection.query<{ hash: Buffer }>(
    `select worldgraph_ledger_entry_hash_v1(
       $1,$2,$3::bigint,'command_accepted',$4,null,'user',$5,
       'COMMAND_ACCEPTED',$6,$7,$8
     ) hash`,
    [
      input.firstLedgerEntryId,
      worldId,
      acceptedLedgerSequence,
      input.commandId,
      actorId,
      acceptedDetails,
      allocation.last_entry_hash,
      at,
    ],
  );
  await connection.query(
    `insert into ledger_entries(
       id,world_id,ledger_sequence,entry_kind,command_id,event_id,actor_type,
       actor_id,public_summary_code,redacted_details,previous_hash,entry_hash,recorded_at
     ) values ($1,$2,$3::bigint,'command_accepted',$4,null,'user',$5,
       'COMMAND_ACCEPTED',$6,$7,$8,$9)`,
    [
      input.firstLedgerEntryId,
      worldId,
      acceptedLedgerSequence,
      input.commandId,
      actorId,
      acceptedDetails,
      allocation.last_entry_hash,
      acceptedHash.rows[0]!.hash,
      at,
    ],
  );
  const eventDetails = { aggregateType: input.aggregateType, eventType: input.eventType };
  const eventHashEntry = await connection.query<{ hash: Buffer }>(
    `select worldgraph_ledger_entry_hash_v1(
       $1,$2,$3::bigint,$4,$5,$6,'user',$7,$8,$9,$10,$11
     ) hash`,
    [
      input.secondLedgerEntryId,
      worldId,
      eventLedgerSequence,
      input.eventType === 'CreatorOverrideUsedV1' ? 'override' : 'domain_event',
      input.commandId,
      input.eventId,
      actorId,
      input.eventType
        .replace(/V1$/, '')
        .replaceAll(/([a-z])([A-Z])/g, '$1_$2')
        .toUpperCase(),
      eventDetails,
      acceptedHash.rows[0]!.hash,
      at,
    ],
  );
  await connection.query(
    `insert into ledger_entries(
       id,world_id,ledger_sequence,entry_kind,command_id,event_id,actor_type,
       actor_id,public_summary_code,redacted_details,previous_hash,entry_hash,recorded_at
     ) values ($1,$2,$3::bigint,$4,$5,$6,'user',$7,$8,$9,$10,$11,$12)`,
    [
      input.secondLedgerEntryId,
      worldId,
      eventLedgerSequence,
      input.eventType === 'CreatorOverrideUsedV1' ? 'override' : 'domain_event',
      input.commandId,
      input.eventId,
      actorId,
      input.eventType
        .replace(/V1$/, '')
        .replaceAll(/([a-z])([A-Z])/g, '$1_$2')
        .toUpperCase(),
      eventDetails,
      acceptedHash.rows[0]!.hash,
      eventHashEntry.rows[0]!.hash,
      at,
    ],
  );
  await connection.query(
    `insert into outbox_messages(
       id,world_id,event_id,message_type,message_schema_version,payload,available_at,created_at
     ) values ($1,$2,$3,'DomainEventReferenceV1',1,$4,$5,$5)`,
    [
      input.outboxId,
      worldId,
      input.eventId,
      {
        eventId: input.eventId,
        eventType: input.eventType,
        worldEventSequence: nextEventSequence,
        worldId,
      },
      at,
    ],
  );
  await connection.query(
    `insert into world_history_entries(
       world_id,ledger_sequence,command_id,event_id,event_type,occurred_at,category,
       title_key,summary_args,actor_type,actor_id,target_type,target_id,visibility,
       correlation_id,resulting_state_revision
     ) values ($1,$2::bigint,$3,$4,$5,$6,'command','history.test.lifecycle',$7,
       'user',$8,$9,$10,'member',$3,$11::bigint)`,
    [
      worldId,
      eventLedgerSequence,
      input.commandId,
      input.eventId,
      input.eventType,
      at,
      input.payload,
      actorId,
      input.aggregateType,
      input.aggregateId,
      nextStateRevision,
    ],
  );
  const checksum = await connection.query<{ checksum: Buffer }>(
    `select worldgraph_projection_checksum($1,$2::bigint) checksum`,
    [worldId, nextStateRevision],
  );
  await connection.query(
    `update projection_checkpoints set last_event_sequence=$2::bigint,checksum=$3,
       status='current',updated_at=$4 where world_id=$1 and projection_name='world_graph'`,
    [worldId, nextEventSequence, checksum.rows[0]!.checksum, at],
  );
  await connection.query(
    `update world_runtime_heads set state_revision=$2::bigint,last_ledger_sequence=$3::bigint,
       last_event_sequence=$4::bigint,projection_checksum=$5,updated_at=$6 where world_id=$1`,
    [
      worldId,
      nextStateRevision,
      eventLedgerSequence,
      nextEventSequence,
      checksum.rows[0]!.checksum,
      at,
    ],
  );
  await connection.query(
    `update command_records set status='accepted',authorization_rule_id='test.lifecycle.exact',
       override_id=$2,decided_at=$3,resulting_state_revision=$4::bigint,response_summary=$5
     where id=$1`,
    [
      input.commandId,
      input.overrideId ?? null,
      at,
      nextStateRevision,
      {
        commandId: input.commandId,
        eventIds: [input.eventId],
        eventSequenceRange: { from: nextEventSequence, to: nextEventSequence },
        ledgerSequenceRange: { from: acceptedLedgerSequence, to: eventLedgerSequence },
        resultingStateRevision: nextStateRevision,
        schemaVersion: 1,
        status: 'accepted',
      },
    ],
  );
}

async function m05MigrationFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-m05-ledger-upgrade-'));
  await mkdir(join(root, 'meta'));
  const tags = [
    '0001_platform_extensions',
    '0002_platform_metadata',
    '0003_identity_authority',
    '0004_primitive_registry',
    '0005_manifest_studio',
    '0006_deterministic_compiler',
  ];
  await Promise.all(
    tags.map((tag) => cp(join(migrationRoot, `${tag}.sql`), join(root, `${tag}.sql`))),
  );
  await writeFile(
    join(root, 'meta/_journal.json'),
    JSON.stringify({
      dialect: 'postgresql',
      entries: tags.map((tag, index) => ({
        breakpoints: true,
        idx: index,
        tag,
        version: '7',
        when: 1784635200000 + index * 60000,
      })),
      version: '7',
    }),
  );
  return root;
}

async function m06MigrationFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-m06-ledger-head-'));
  await mkdir(join(root, 'meta'));
  const tags = [
    '0001_platform_extensions',
    '0002_platform_metadata',
    '0003_identity_authority',
    '0004_primitive_registry',
    '0005_manifest_studio',
    '0006_deterministic_compiler',
    '0007_command_event_ledger',
  ];
  await Promise.all(
    tags.map((tag) => cp(join(migrationRoot, `${tag}.sql`), join(root, `${tag}.sql`))),
  );
  await writeFile(
    join(root, 'meta/_journal.json'),
    JSON.stringify({
      dialect: 'postgresql',
      entries: tags.map((tag, index) => ({
        breakpoints: true,
        idx: index,
        tag,
        version: '7',
        when: 1784635200000 + index * 60000,
      })),
      version: '7',
    }),
  );
  return root;
}

async function seedPreM06ActiveWorld(pool: Pool): Promise<void> {
  const principalKey = 'member-0123456789abcdef0123456789abcdef';
  await transaction(pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into users(id,email,password_hash,display_name) values
         ($1,'ledger-creator@example.test',$5,'Ledger Creator'),
         ($2,'ledger-member@example.test',$5,'Ledger Member'),
         ($3,'ledger-invited@example.test',$5,'Ledger Invited'),
         ($4,'ledger-administrator@example.test',$5,'Ledger Administrator')`,
      [creatorId, memberId, invitedUserId, administratorId, passwordHash],
    );
    await connection.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'ledger-upgrade-world','Ledger Upgrade World',$2)`,
      [worldId, creatorId],
    );
    await connection.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2),($1,$3,'player',$2),($1,$4,'administrator',$2)`,
      [worldId, creatorId, memberId, administratorId],
    );
    await connection.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,manifest_schema_version,canonical_manifest,
         content_hash,source,created_by_user_id,approval_status,approved_by_user_id,approved_at
       ) values ($1,$2,1,1,$3,$4,'manual',$5,'approved',$5,now())`,
      [
        revisionId,
        worldId,
        {
          metadata: { key: 'ledger-upgrade-world', name: 'Ledger Upgrade World' },
          primitiveRefs: [],
        },
        manifestHash,
        creatorId,
      ],
    );
    await connection.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,parent_revision_id,manifest_schema_version,
         canonical_manifest,content_hash,source,created_by_user_id
       ) values ($1,$2,2,$3,1,$4,$5,'manual',$6)`,
      [
        draftRevisionId,
        worldId,
        revisionId,
        {
          metadata: { key: 'ledger-upgrade-world-v2', name: 'Ledger Upgrade World V2' },
          primitiveRefs: [],
        },
        Buffer.alloc(32, 45),
        creatorId,
      ],
    );
    await connection.query(
      `insert into manifest_validation_reports(
         id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
         valid,diagnostics,report_hash
       ) values ($1,$2,1,$3,true,'[]',$4)`,
      [draftValidationReportId, draftRevisionId, Buffer.alloc(32, 46), Buffer.alloc(32, 47)],
    );
    await connection.query(
      `insert into world_invitations(
         id,world_id,email,intended_role,token_hash,expires_at,created_by_user_id,created_at
       ) values
         ($1,$3,'ledger-invited@example.test','observer',$4,now()+interval '1 day',$5,now()),
         ($2,$3,'ledger-expired@example.test','player',$6,now()-interval '1 day',$5,
          now()-interval '2 days')`,
      [
        pendingInvitationId,
        expiredInvitationId,
        worldId,
        Buffer.alloc(32, 81),
        creatorId,
        Buffer.alloc(32, 82),
      ],
    );
    await connection.query(
      `insert into world_compilation_runs(
         id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
         compiler_version,compiler_config_version,seed,status,stage,progress_percent,
         requested_by_user_id,idempotency_key,artifact_hash,attempts,next_attempt_at,
         claimed_at,heartbeat_at,queued_at,started_at,completed_at,updated_at
       ) values (
         $1,$2,$3,$4,$5,'1.0.0',1,'ledger-seed','succeeded','activated',100,
         $6,'ledger-genesis-request',$7,1,now(),now(),now(),now(),now(),now(),now()
       )`,
      [runId, worldId, revisionId, manifestHash, Buffer.alloc(32, 44), creatorId, artifactHash],
    );
    await connection.query(
      `insert into world_versions(
         id,world_id,version_number,manifest_revision_id,compilation_run_id,
         world_schema_version,compiler_version,compiler_config_version,seed,
         artifact_hash,status,created_by_user_id,activated_at
       ) values ($1,$2,1,$3,$4,1,'1.0.0',1,'ledger-seed',$5,'active',$6,now())`,
      [versionId, worldId, revisionId, runId, artifactHash, creatorId],
    );
    await connection.query(
      `insert into world_entities(
         id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
       ) values
         ($1,$3,$4,'account_principal',1,$5,$7),
         ($2,$3,$6,'player_character',1,$8,$7)`,
      [
        accountId,
        characterId,
        worldId,
        `account:${principalKey}`,
        { membershipRole: 'creator', principalKey },
        `character:${principalKey}`,
        versionId,
        {
          blueprintLogicalKey: 'actor-blueprint:ledger',
          homeDistrictLogicalKey: 'district:ledger',
          membershipRole: 'creator',
          name: 'Ledger Character',
          organizationLogicalKey: null,
        },
      ],
    );
    await connection.query(
      `insert into world_relationships(
         id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
         relationship_schema_version,attributes,created_world_version_id
       ) values ($1,$2,$3,'account_controls',$4,$5,1,'{}',$6)`,
      [
        relationshipId,
        worldId,
        `rel:account_controls:${principalKey}`,
        accountId,
        characterId,
        versionId,
      ],
    );
    await connection.query(
      `insert into world_entity_controllers(
         world_id,user_id,entity_id,control_scope,granted_world_version_id
       ) values ($1,$2,$3,'primary',$4)`,
      [worldId, creatorId, characterId, versionId],
    );
    await connection.query(
      `insert into world_runtime_heads(world_id,active_world_version_id) values ($1,$2)`,
      [worldId, versionId],
    );
    await connection.query(
      `update worlds set lifecycle='active', current_approved_manifest_revision_id=$2,
         manifest_schema_version=1, active_world_version_id=$3, row_version=2, updated_at=now()
       where id=$1`,
      [worldId, revisionId, versionId],
    );
  });
}

describe('M06 command/event ledger migration and invariants', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;
  let app: DatabaseClient;
  let temporaryRoot: string;
  let m06Root: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'ledger-db-owner-test');
    temporaryRoot = await m05MigrationFolder();
    await migrate(owner.db, { migrationsFolder: temporaryRoot });
    await seedPreM06ActiveWorld(owner.pool);
    m06Root = await m06MigrationFolder();
    await migrate(owner.db, { migrationsFolder: m06Root });
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    app = createDatabaseClient(appUrl.toString(), 'ledger-db-app-test');
  });

  afterAll(async () => {
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
    if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
    if (m06Root) await rm(m06Root, { force: true, recursive: true });
  });

  it('anchors a pre-M06 active world exactly once with honest import facts', async () => {
    await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
      commandSchema: 1,
      contracts: 6,
      domainEventSchema: 1,
      historySchema: 1,
      ledgerSchema: 1,
      outboxSchema: 1,
      projectionSchema: 1,
      runtimeSchema: 6,
    });
    const state = await owner.pool.query<{
      commands: string;
      events: string;
      history: string;
      last_event_sequence: string;
      last_ledger_sequence: string;
      ledger_entries: string;
      outbox: string;
      state_revision: string;
    }>(
      `select runtime.state_revision::text, runtime.last_event_sequence::text,
        runtime.last_ledger_sequence::text,
        (select count(*)::text from command_records where world_id=runtime.world_id) commands,
        (select count(*)::text from domain_events where world_id=runtime.world_id) events,
        (select count(*)::text from ledger_entries where world_id=runtime.world_id) ledger_entries,
        (select count(*)::text from outbox_messages where world_id=runtime.world_id) outbox,
        (select count(*)::text from world_history_entries where world_id=runtime.world_id) history
       from world_runtime_heads runtime where runtime.world_id=$1`,
      [worldId],
    );
    expect(state.rows[0]).toEqual({
      commands: '1',
      events: '1',
      history: '1',
      last_event_sequence: '1',
      last_ledger_sequence: '1',
      ledger_entries: '1',
      outbox: '1',
      state_revision: '1',
    });
    const commandId = m06UpgradeRecordId('command', worldId);
    const eventId = m06UpgradeRecordId('event', worldId);
    const command = await owner.pool.query<{
      expected_state_revision: string;
      expected_world_version: string;
      id: string;
      opened_event_sequence: string;
      opened_ledger_sequence: string;
      opened_projection_checksum: Buffer | null;
      opened_state_revision: string;
      requested_at: Date;
      status: string;
      write_gate_opened_at: Date;
    }>(
      `select id,status,expected_world_version::text,expected_state_revision::text,
        opened_state_revision::text,opened_ledger_sequence::text,
        opened_event_sequence::text,opened_projection_checksum,
        write_gate_opened_at,requested_at
       from command_records where world_id=$1`,
      [worldId],
    );
    expect(command.rows[0]).toMatchObject({
      expected_state_revision: '0',
      expected_world_version: '1',
      id: commandId,
      opened_event_sequence: '0',
      opened_ledger_sequence: '0',
      opened_projection_checksum: null,
      opened_state_revision: '0',
      status: 'accepted',
    });
    expect(command.rows[0]?.write_gate_opened_at).toEqual(command.rows[0]?.requested_at);

    const event = await owner.pool.query<{
      command_id: string;
      event_type: string;
      id: string;
      payload: Record<string, unknown>;
    }>(`select id,command_id,event_type,payload from domain_events where world_id=$1`, [worldId]);
    expect(event.rows[0]).toMatchObject({
      command_id: commandId,
      event_type: 'WorldStateImportedV1',
      id: eventId,
      payload: {
        activeWorldVersionId: versionId,
        artifactHash: artifactHash.toString('hex'),
        rowCounts: { controllers: '1', entities: '2', relationships: '1' },
        worldVersionNumber: '1',
      },
    });
    const outbox = await owner.pool.query<{
      attempts: number;
      event_id: string;
      id: string;
      message_schema_version: number;
      message_type: string;
      payload: Record<string, unknown>;
      status: string;
    }>(
      `select id,event_id,message_type,message_schema_version,payload,status,attempts
       from outbox_messages where world_id=$1`,
      [worldId],
    );
    expect(outbox.rows[0]).toEqual({
      attempts: 0,
      event_id: eventId,
      id: m06UpgradeRecordId('outbox', worldId),
      message_schema_version: 1,
      message_type: 'DomainEventReferenceV1',
      payload: {
        eventId,
        eventType: 'WorldStateImportedV1',
        worldEventSequence: '1',
        worldId,
      },
      status: 'pending',
    });
    const ledger = await owner.pool.query<{ command_id: string; event_id: string; id: string }>(
      `select id,command_id,event_id from ledger_entries where world_id=$1`,
      [worldId],
    );
    expect(ledger.rows[0]).toEqual({
      command_id: commandId,
      event_id: eventId,
      id: m06UpgradeRecordId('ledger', worldId),
    });
    await expect(
      owner.pool.query(`select worldgraph_assert_command_terminal($1)`, [commandId]),
    ).resolves.toMatchObject({ rowCount: 1 });

    await migrate(owner.db, { migrationsFolder: m06Root });
    const repeated = await owner.pool.query<{
      commands: string;
      events: string;
      ledger_entries: string;
      outbox: string;
    }>(
      `select
        (select count(*)::text from command_records where world_id=$1) commands,
        (select count(*)::text from domain_events where world_id=$1) events,
        (select count(*)::text from ledger_entries where world_id=$1) ledger_entries,
        (select count(*)::text from outbox_messages where world_id=$1) outbox`,
      [worldId],
    );
    expect(repeated.rows[0]).toEqual({
      commands: '1',
      events: '1',
      ledger_entries: '1',
      outbox: '1',
    });
  });

  it('matches canonical event, ledger, and projection hashes across SQL and JavaScript', async () => {
    const projection = await owner.pool.query<{
      checksum: string;
      document: Record<string, unknown>;
    }>(
      `select encode(worldgraph_projection_checksum($1),'hex') checksum,
        worldgraph_projection_document($1) document`,
      [worldId],
    );
    expect(projection.rows[0]?.checksum).toBe(
      sha256Canonical(projection.rows[0]?.document).toString('hex'),
    );

    const event = await owner.pool.query<{
      aggregate_id: string;
      aggregate_type: string;
      aggregate_version: string;
      command_id: string;
      event_hash: string;
      event_ordinal: number;
      event_schema_version: number;
      event_type: string;
      id: string;
      metadata: Record<string, unknown>;
      occurred_at: Date;
      payload: Record<string, unknown>;
      recorded_at: Date;
      resulting_state_revision: string;
      world_event_sequence: string;
      world_id: string;
    }>(
      `select id,world_id,world_event_sequence::text,command_id,event_ordinal,
        aggregate_type,aggregate_id,aggregate_version::text,event_type,event_schema_version,
        payload,metadata,encode(event_hash,'hex') event_hash,occurred_at,recorded_at,
        resulting_state_revision::text
       from domain_events where world_id=$1 and world_event_sequence=1`,
      [worldId],
    );
    const row = event.rows[0]!;
    const eventMaterial = {
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      aggregateVersion: row.aggregate_version,
      commandId: row.command_id,
      domain: 'worldgraph.domain-event.v1',
      eventId: row.id,
      eventOrdinal: row.event_ordinal,
      eventSchemaVersion: row.event_schema_version,
      eventType: row.event_type,
      metadata: row.metadata,
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
      recordedAt: row.recorded_at.toISOString(),
      resultingStateRevision: row.resulting_state_revision,
      worldEventSequence: row.world_event_sequence,
      worldId: row.world_id,
    };
    expect(row.event_hash).toBe(sha256Canonical(eventMaterial).toString('hex'));

    const entry = await owner.pool.query<{
      actor_id: string;
      actor_type: string;
      command_id: string | null;
      entry_hash: string;
      entry_kind: string;
      event_id: string | null;
      id: string;
      ledger_sequence: string;
      previous_hash: string;
      public_summary_code: string;
      recorded_at: Date;
      redacted_details: Record<string, unknown>;
      world_id: string;
    }>(
      `select id,world_id,ledger_sequence::text,entry_kind::text,command_id,event_id,
        actor_type::text,actor_id,public_summary_code,redacted_details,
        encode(previous_hash,'hex') previous_hash,encode(entry_hash,'hex') entry_hash,recorded_at
       from ledger_entries where world_id=$1 and ledger_sequence=1`,
      [worldId],
    );
    const ledger = entry.rows[0]!;
    expect(ledger.entry_hash).toBe(
      sha256Canonical({
        actorId: ledger.actor_id,
        actorType: ledger.actor_type,
        commandId: ledger.command_id,
        domain: 'worldgraph.ledger-entry.v1',
        entryId: ledger.id,
        entryKind: ledger.entry_kind,
        eventId: ledger.event_id,
        ledgerSchemaVersion: 1,
        ledgerSequence: ledger.ledger_sequence,
        previousHash: ledger.previous_hash,
        publicSummaryCode: ledger.public_summary_code,
        recordedAt: ledger.recorded_at.toISOString(),
        redactedDetails: ledger.redacted_details,
        worldId: ledger.world_id,
      }).toString('hex'),
    );
  });

  it('matches the pure ledger kernel fixed event and entry golden hashes', async () => {
    const fixtureWorldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
    const fixtureCommandId = '018f8652-3cb6-7d52-904b-cce7901d7e29';
    const fixtureEventId = '018f8652-3cb6-7d52-904b-cce7901d7e30';
    const fixtureVersionId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
    const at = new Date('2026-07-22T00:00:00.000Z');
    const metadata = {
      actor: { actorId: 'worldgraph.backfill', actorType: 'system' },
      authorizationRuleId: 'ledger.genesis.backfill',
      causationId: null,
      commandSchemaVersion: 1,
      commandType: 'AnchorWorldStateV1',
      correlationId: fixtureCommandId,
      overrideId: null,
      payloadClassification: 'member',
    };
    const payload = {
      activeWorldVersionId: fixtureVersionId,
      artifactHash: 'a'.repeat(64),
      projectionSchemaVersions: {
        controllers: 1,
        entities: 1,
        relationships: 1,
        runtimeHead: 1,
      },
      rowCounts: { controllers: '0', entities: '2', relationships: '1' },
      stateChecksum: '46bc6184f79a60ab90f7552244f7f77b605e8da0f06339078b92f862cdd1a397',
      worldVersionNumber: '1',
    };
    const event = await owner.pool.query<{ hash: string }>(
      `select encode(worldgraph_domain_event_hash_v1(
        $1,$2,1,$3,0,'world',$2::uuid::text,1,'WorldStateImportedV1',1,$4,$5,$6,$6,0
      ),'hex') hash`,
      [fixtureEventId, fixtureWorldId, fixtureCommandId, payload, metadata, at],
    );
    expect(event.rows[0]?.hash).toBe(
      'faea0f28a9aa63b705828dc415a3f7a79292f9459d34f022bd1cbf5b98c561c0',
    );
    const entry = await owner.pool.query<{ hash: string }>(
      `select encode(worldgraph_ledger_entry_hash_v1(
        $1,$2,1,'domain_event',$3,$4,'system','worldgraph.backfill',
        'WORLD_STATE_IMPORTED',$5,$6,$7
      ),'hex') hash`,
      [
        '018f8652-3cb6-7d52-904b-cce7901d7e32',
        fixtureWorldId,
        fixtureCommandId,
        fixtureEventId,
        { eventType: 'WorldStateImportedV1' },
        Buffer.alloc(32),
        at,
      ],
    );
    expect(entry.rows[0]?.hash).toBe(
      '26e288085d139b051066eaa15aa8e3990c9d4a6492da36b1ba22a06ccbab3b88',
    );
  });

  it('writes a fresh compiled genesis through the guarded activation helper', async () => {
    const freshWorldId = '068f0000-0000-7000-8000-000000000111';
    const freshRevisionId = '068f0000-0000-7000-8000-000000000211';
    const freshRunId = '068f0000-0000-7000-8000-000000000311';
    const freshVersionId = '068f0000-0000-7000-8000-000000000411';
    const freshAccountId = '068f0000-0000-7000-8000-000000000511';
    const freshCharacterId = '068f0000-0000-7000-8000-000000000512';
    const freshRelationshipId = '068f0000-0000-7000-8000-000000000611';
    const commandId = '068f0000-0000-7000-8000-000000000741';
    const eventId = '068f0000-0000-7000-8000-000000000742';
    const entryId = '068f0000-0000-7000-8000-000000000743';
    const outboxId = '068f0000-0000-7000-8000-000000000744';
    const hash = Buffer.alloc(32, 91);
    const principalKey = memberPrincipalKey(freshWorldId, creatorId);
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `insert into worlds(id,slug,name,lifecycle,created_by_user_id)
         values ($1,'ledger-fresh-world','Ledger Fresh World','compiling',$2)`,
        [freshWorldId, creatorId],
      );
      await connection.query(
        `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
         values ($1,$2,'creator',$2)`,
        [freshWorldId, creatorId],
      );
      await connection.query(
        `insert into manifest_revisions(
          id,world_id,revision_number,manifest_schema_version,canonical_manifest,
          content_hash,source,created_by_user_id,approval_status,approved_by_user_id,approved_at
        ) values ($1,$2,1,1,$3,$4,'manual',$5,'approved',$5,now())`,
        [
          freshRevisionId,
          freshWorldId,
          {
            metadata: { key: 'ledger-fresh-world', name: 'Ledger Fresh World' },
            primitiveRefs: [],
          },
          hash,
          creatorId,
        ],
      );
      await connection.query(
        `update worlds set current_approved_manifest_revision_id=$2,manifest_schema_version=1
         where id=$1`,
        [freshWorldId, freshRevisionId],
      );
      await connection.query(
        `insert into world_compilation_runs(
          id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
          compiler_version,compiler_config_version,seed,status,stage,progress_percent,
          requested_by_user_id,idempotency_key,attempts,claim_token,claimed_at,
          heartbeat_at,started_at,updated_at
        ) values ($1,$2,$3,$4,$5,'1.0.0',1,'fresh-ledger-seed','running','seeding',90,
          $6,'fresh-ledger-request',1,$7,now(),now(),now(),now())`,
        [
          freshRunId,
          freshWorldId,
          freshRevisionId,
          hash,
          Buffer.alloc(32, 92),
          creatorId,
          '068f0000-0000-7000-8000-000000000745',
        ],
      );
      await connection.query(
        `insert into compiled_world_artifacts(
          id,world_id,compilation_run_id,artifact_kind,artifact_schema_version,
          canonical_content,content_hash
        ) values
          ($1,$4,$5,'compiler_input',1,'{}',$6),
          ($2,$4,$5,'compiled_world',1,'{}',$7),
          ($3,$4,$5,'visual_plan',1,'{}',$8)`,
        [
          '068f0000-0000-7000-8000-000000000751',
          '068f0000-0000-7000-8000-000000000752',
          '068f0000-0000-7000-8000-000000000753',
          freshWorldId,
          freshRunId,
          Buffer.alloc(32, 93),
          hash,
          Buffer.alloc(32, 94),
        ],
      );
      await connection.query(
        `insert into world_versions(
          id,world_id,version_number,manifest_revision_id,compilation_run_id,
          world_schema_version,compiler_version,compiler_config_version,seed,
          artifact_hash,status,created_by_user_id
        ) values ($1,$2,1,$3,$4,1,'1.0.0',1,'fresh-ledger-seed',$5,'staging',$6)`,
        [freshVersionId, freshWorldId, freshRevisionId, freshRunId, hash, creatorId],
      );
      await connection.query(
        `insert into world_entities(
          id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
        ) values
          ($1,$3,$4,'account_principal',1,$5,$7),
          ($2,$3,$6,'player_character',1,$8,$7)`,
        [
          freshAccountId,
          freshCharacterId,
          freshWorldId,
          `account:${principalKey}`,
          { membershipRole: 'creator', principalKey },
          `character:${principalKey}`,
          freshVersionId,
          {
            blueprintLogicalKey: 'actor-blueprint:fresh-ledger',
            homeDistrictLogicalKey: 'district:fresh-ledger',
            membershipRole: 'creator',
            name: 'Fresh Ledger Character',
            organizationLogicalKey: null,
          },
        ],
      );
      await connection.query(
        `insert into world_relationships(
          id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
          relationship_schema_version,attributes,created_world_version_id
        ) values ($1,$2,$3,'account_controls',$4,$5,1,'{}',$6)`,
        [
          freshRelationshipId,
          freshWorldId,
          `rel:account_controls:${principalKey}`,
          freshAccountId,
          freshCharacterId,
          freshVersionId,
        ],
      );
      await connection.query(
        `insert into world_entity_controllers(
          world_id,user_id,entity_id,control_scope,granted_world_version_id
        ) values ($1,$2,$3,'primary',$4)`,
        [freshWorldId, creatorId, freshCharacterId, freshVersionId],
      );
      await connection.query(
        `insert into world_runtime_heads(world_id,active_world_version_id) values ($1,$2)`,
        [freshWorldId, freshVersionId],
      );
      await connection.query(`set local session_replication_role = 'origin'`);
      const genesis = await connection.query<{ resulting_state_revision: string }>(
        `select resulting_state_revision::text from worldgraph_append_compiled_genesis(
          $1,$2,$3,$4,$5,$6,$7
        )`,
        [freshWorldId, freshVersionId, freshRunId, commandId, eventId, entryId, outboxId],
      );
      expect(genesis.rows[0]?.resulting_state_revision).toBe('1');
      await connection.query(
        `update world_versions set status='active',activated_at=now() where id=$1`,
        [freshVersionId],
      );
      await connection.query(
        `update worlds set lifecycle='active',active_world_version_id=$2,
          row_version=row_version+1,updated_at=now() where id=$1`,
        [freshWorldId, freshVersionId],
      );
      await connection.query(
        `update world_compilation_runs set status='succeeded',stage='activated',
          progress_percent=100,artifact_hash=$2,claim_token=null,completed_at=now(),
          updated_at=now(),row_version=row_version+1 where id=$1`,
        [freshRunId, hash],
      );
    });
    const state = await owner.pool.query<{
      event_type: string;
      history: string;
      state_revision: string;
    }>(
      `select event.event_type,
        (select state_revision::text from world_runtime_heads where world_id=$1),
        (select count(*)::text from world_history_entries
          where world_id=$1 and title_key='history.genesis.compiled') history
       from domain_events event where event.world_id=$1`,
      [freshWorldId],
    );
    expect(state.rows[0]).toEqual({
      event_type: 'WorldCompiledGenesisV1',
      history: '1',
      state_revision: '1',
    });
  });

  it('commits one rename event, projection, ledger entry, outbox, history, and head atomically', async () => {
    const commandId = '068f0000-0000-7000-8000-000000000701';
    const eventId = '068f0000-0000-7000-8000-000000000702';
    const entryId = '068f0000-0000-7000-8000-000000000703';
    const outboxId = '068f0000-0000-7000-8000-000000000704';
    await transaction(app.pool, async (connection) => {
      const at = new Date();
      const payload = {
        entityKey: `character:member-0123456789abcdef0123456789abcdef`,
        newDisplayName: 'Renamed Character',
      };
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_world_version,expected_state_revision,correlation_id,requested_at
         ) values ($1,$2,'RenameWorldEntityV1',1,'user',$3,$4,$5,'member',
           'rename-character-0001',$6,1,1,$1,$7)`,
        [
          commandId,
          worldId,
          creatorId,
          payload,
          sha256Canonical(payload),
          sha256Canonical({ payload, worldId }),
          at,
        ],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
      await connection.query(
        `update world_entities set state=jsonb_set(state,'{name}',to_jsonb($2::text)),
          row_version=row_version+1,updated_at=$3 where world_id=$1 and id=$4`,
        [worldId, 'Renamed Character', at, characterId],
      );
      const metadata = {
        actor: { actorId: creatorId, actorType: 'user' },
        authorizationRuleId: 'world.creator.entity.rename',
        causationId: null,
        commandSchemaVersion: 1,
        commandType: 'RenameWorldEntityV1',
        correlationId: commandId,
        overrideId: null,
        payloadClassification: 'member',
      };
      const eventPayload = {
        entityKey: payload.entityKey,
        entityType: 'player_character',
        entityVersion: '2',
        newDisplayName: 'Renamed Character',
        previousDisplayName: 'Ledger Character',
      };
      const eventHash = await connection.query<{ hash: Buffer }>(
        `select worldgraph_domain_event_hash_v1(
          $1,$2,2,$3,0,'world_entity',$4,1,'WorldEntityRenamedV1',1,$5,$6,$7,$7,2
        ) hash`,
        [eventId, worldId, commandId, payload.entityKey, eventPayload, metadata, at],
      );
      await connection.query(
        `insert into domain_events(
          id,world_id,world_event_sequence,command_id,event_ordinal,aggregate_type,
          aggregate_id,aggregate_version,event_type,event_schema_version,payload,
          metadata,event_hash,occurred_at,recorded_at,resulting_state_revision
        ) values ($1,$2,2,$3,0,'world_entity',$4,1,'WorldEntityRenamedV1',1,
          $5,$6,$7,$8,$8,2)`,
        [
          eventId,
          worldId,
          commandId,
          payload.entityKey,
          eventPayload,
          metadata,
          eventHash.rows[0]!.hash,
          at,
        ],
      );
      const head = await connection.query<{ last_entry_hash: Buffer }>(
        `select last_entry_hash from world_ledger_heads where world_id=$1`,
        [worldId],
      );
      const details = { entityKey: payload.entityKey, eventType: 'WorldEntityRenamedV1' };
      const entryHash = await connection.query<{ hash: Buffer }>(
        `select worldgraph_ledger_entry_hash_v1(
          $1,$2,2,'domain_event',$3,$4,'user',$5,'WORLD_ENTITY_RENAMED',$6,$7,$8
        ) hash`,
        [
          entryId,
          worldId,
          commandId,
          eventId,
          creatorId,
          details,
          head.rows[0]!.last_entry_hash,
          at,
        ],
      );
      await connection.query(
        `insert into ledger_entries(
          id,world_id,ledger_sequence,entry_kind,command_id,event_id,actor_type,
          actor_id,public_summary_code,redacted_details,previous_hash,entry_hash,recorded_at
        ) values ($1,$2,2,'domain_event',$3,$4,'user',$5,'WORLD_ENTITY_RENAMED',$6,$7,$8,$9)`,
        [
          entryId,
          worldId,
          commandId,
          eventId,
          creatorId,
          details,
          head.rows[0]!.last_entry_hash,
          entryHash.rows[0]!.hash,
          at,
        ],
      );
      const checksum = await connection.query<{ checksum: Buffer }>(
        `select worldgraph_projection_checksum($1,2) checksum`,
        [worldId],
      );
      await connection.query(
        `update world_runtime_heads set state_revision=2,last_event_sequence=2,
          last_ledger_sequence=2,projection_checksum=$2,updated_at=$3 where world_id=$1`,
        [worldId, checksum.rows[0]!.checksum, at],
      );
      await connection.query(
        `update projection_checkpoints set last_event_sequence=2,checksum=$2,
          status='current',updated_at=$3 where world_id=$1 and projection_name='world_graph'`,
        [worldId, checksum.rows[0]!.checksum, at],
      );
      await connection.query(
        `insert into outbox_messages(
          id,world_id,event_id,message_type,message_schema_version,payload,
          available_at,created_at
        ) values ($1,$2,$3,'DomainEventReferenceV1',1,$4,$5,$5)`,
        [
          outboxId,
          worldId,
          eventId,
          { eventId, eventType: 'WorldEntityRenamedV1', worldEventSequence: '2', worldId },
          at,
        ],
      );
      await connection.query(
        `insert into world_history_entries(
          world_id,ledger_sequence,command_id,event_id,event_type,occurred_at,
          category,title_key,summary_args,actor_type,actor_id,target_type,target_id,
          visibility,correlation_id,resulting_state_revision
        ) values ($1,2,$2,$3,'WorldEntityRenamedV1',$4,'entity',
          'history.world_entity_renamed',$5,'user',$6,'world_entity',$7,'member',$2,2)`,
        [
          worldId,
          commandId,
          eventId,
          at,
          { entityKey: payload.entityKey },
          creatorId,
          payload.entityKey,
        ],
      );
      await connection.query(
        `update command_records set status='accepted',authorization_rule_id=$2,
          decided_at=$3,resulting_state_revision=2,response_summary=$4 where id=$1`,
        [
          commandId,
          'world.creator.entity.rename',
          at,
          {
            commandId,
            eventIds: [eventId],
            eventSequenceRange: { from: '2', to: '2' },
            ledgerSequenceRange: { from: '2', to: '2' },
            resultingStateRevision: '2',
            schemaVersion: 1,
            status: 'accepted',
          },
        ],
      );
    });
    const result = await owner.pool.query<{
      events: string;
      history: string;
      name: string;
      outbox: string;
      state_revision: string;
    }>(
      `select state->>'name' name,
        (select state_revision::text from world_runtime_heads where world_id=$1),
        (select count(*)::text from domain_events where command_id=$2) events,
        (select count(*)::text from outbox_messages where event_id=$3) outbox,
        (select count(*)::text from world_history_entries where command_id=$2) history
       from world_entities where world_id=$1 and id=$4`,
      [worldId, commandId, eventId, characterId],
    );
    expect(result.rows[0]).toEqual({
      events: '1',
      history: '1',
      name: 'Renamed Character',
      outbox: '1',
      state_revision: '2',
    });
  });

  it('records a stale rejection without an event or projection mutation', async () => {
    const commandId = '068f0000-0000-7000-8000-000000000711';
    const entryId = '068f0000-0000-7000-8000-000000000712';
    await transaction(app.pool, async (connection) => {
      const at = new Date();
      const payload = {
        entityKey: `character:member-0123456789abcdef0123456789abcdef`,
        newDisplayName: 'Stale Name',
      };
      await connection.query(
        `insert into command_records(
          id,world_id,command_type,command_schema_version,actor_type,actor_id,payload,
          payload_hash,payload_classification,idempotency_key,request_hash,
          expected_world_version,expected_state_revision,correlation_id,requested_at
        ) values ($1,$2,'RenameWorldEntityV1',1,'user',$3,$4,$5,'member',
          'rename-character-stale',$6,1,1,$1,$7)`,
        [
          commandId,
          worldId,
          creatorId,
          payload,
          sha256Canonical(payload),
          sha256Canonical({ payload, worldId }),
          at,
        ],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
      const head = await connection.query<{ last_entry_hash: Buffer }>(
        `select last_entry_hash from world_ledger_heads where world_id=$1`,
        [worldId],
      );
      const details = { rejectionCode: 'REVISION_CONFLICT' };
      const hash = await connection.query<{ hash: Buffer }>(
        `select worldgraph_ledger_entry_hash_v1(
          $1,$2,3,'command_rejected',$3,null,'user',$4,'COMMAND_REJECTED',$5,$6,$7
        ) hash`,
        [entryId, worldId, commandId, creatorId, details, head.rows[0]!.last_entry_hash, at],
      );
      await connection.query(
        `insert into ledger_entries(
          id,world_id,ledger_sequence,entry_kind,command_id,event_id,actor_type,actor_id,
          public_summary_code,redacted_details,previous_hash,entry_hash,recorded_at
        ) values ($1,$2,3,'command_rejected',$3,null,'user',$4,'COMMAND_REJECTED',$5,$6,$7,$8)`,
        [
          entryId,
          worldId,
          commandId,
          creatorId,
          details,
          head.rows[0]!.last_entry_hash,
          hash.rows[0]!.hash,
          at,
        ],
      );
      await connection.query(
        `update world_runtime_heads set last_ledger_sequence=3,updated_at=$2 where world_id=$1`,
        [worldId, at],
      );
      await connection.query(
        `insert into world_history_entries(
          world_id,ledger_sequence,command_id,occurred_at,category,title_key,summary_args,
          actor_type,actor_id,target_type,target_id,visibility,correlation_id
        ) values ($1,3,$2,$3,'entity','history.command_rejected',$4,'user',$5,
          'world_entity',$6,'creator',$2)`,
        [worldId, commandId, at, details, creatorId, payload.entityKey],
      );
      await connection.query(
        `update command_records set status='rejected',rejection_code='REVISION_CONFLICT',
          authorization_rule_id='world.creator.entity.rename',decided_at=$2,response_summary=$3
          where id=$1`,
        [
          commandId,
          at,
          {
            commandId,
            currentStateRevision: '2',
            eventIds: [],
            rejectionCode: 'REVISION_CONFLICT',
            schemaVersion: 1,
            status: 'rejected',
          },
        ],
      );
    });
    const state = await owner.pool.query<{
      events: string;
      last_ledger_sequence: string;
      name: string;
      state_revision: string;
    }>(
      `select state->>'name' name,
        (select state_revision::text from world_runtime_heads where world_id=$1),
        (select last_ledger_sequence::text from world_runtime_heads where world_id=$1),
        (select count(*)::text from domain_events where command_id=$2) events
       from world_entities where world_id=$1 and id=$3`,
      [worldId, commandId, characterId],
    );
    expect(state.rows[0]).toEqual({
      events: '0',
      last_ledger_sequence: '3',
      name: 'Renamed Character',
      state_revision: '2',
    });
  });

  it('enforces nullable-world idempotency and stores unknown command versions for durable rejection', async () => {
    const insert = (id: string, hashByte: number) =>
      owner.pool.query(
        `insert into command_records(
          id,world_id,command_type,command_schema_version,actor_type,actor_id,payload,
          payload_hash,payload_classification,idempotency_key,request_hash,correlation_id
        ) values ($1,null,'UnknownPlatformCommandV9',9,'system','worldgraph:test',
          '{}'::jsonb,$2,'private','global-command-key',$3,$1)`,
        [id, Buffer.alloc(32, hashByte), Buffer.alloc(32, hashByte + 1)],
      );
    await insert('068f0000-0000-7000-8000-000000000721', 70);
    await expect(insert('068f0000-0000-7000-8000-000000000722', 72)).rejects.toMatchObject({
      code: '23505',
      constraint: 'command_records_idempotency_unique',
    });
  });

  it('fails closed on direct projection writes and update/delete of immutable history', async () => {
    await expect(
      app.pool.query(`update world_entities set state=state where world_id=$1 and id=$2`, [
        worldId,
        characterId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.pool.query(`update domain_events set payload=payload where world_id=$1`, [worldId]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.pool.query(`delete from ledger_entries where world_id=$1`, [worldId]),
    ).rejects.toMatchObject({ code: '55000' });
    expect(
      await owner.pool.query(
        `select has_table_privilege('worldgraph_app','domain_events','UPDATE') allowed`,
      ),
    ).toMatchObject({ rows: [{ allowed: false }] });
    expect(
      await owner.pool.query(
        `select has_table_privilege('worldgraph_app','ledger_entries','DELETE') allowed`,
      ),
    ).toMatchObject({ rows: [{ allowed: false }] });
    expect(
      await owner.pool.query(
        `select has_table_privilege('worldgraph_app','world_ledger_heads','UPDATE') allowed`,
      ),
    ).toMatchObject({ rows: [{ allowed: false }] });
    expect(
      await owner.pool.query(
        `select has_table_privilege('worldgraph_app','aggregate_stream_heads','UPDATE') allowed`,
      ),
    ).toMatchObject({ rows: [{ allowed: false }] });
    for (const table of [
      'projection_replay_runs',
      'shadow_world_entities',
      'shadow_world_relationships',
      'shadow_world_entity_controllers',
    ]) {
      expect(
        await owner.pool.query(`select has_table_privilege('worldgraph_app',$1,'INSERT') allowed`, [
          table,
        ]),
      ).toMatchObject({ rows: [{ allowed: false }] });
    }
    expect(
      await owner.pool.query(
        `select has_table_privilege('worldgraph_app','projection_replay_runs','UPDATE') allowed`,
      ),
    ).toMatchObject({ rows: [{ allowed: false }] });
  });

  it('accepts exact anchored lifecycle facts for every world, membership, invitation, and manifest branch', async () => {
    await transaction(app.pool, async (connection) => {
      await connection.query(
        `update worlds set name='Lifecycle Command World',row_version=row_version+1,
           updated_at=now() where id=$1 and name='Ledger Upgrade World'`,
        [worldId],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: worldId,
        aggregateType: 'world',
        commandId: '077f0000-0000-7000-8000-000000000001',
        commandType: 'RenameWorldV1',
        eventId: '077f0000-0000-7000-8000-000000000002',
        eventType: 'WorldRenamedV1',
        firstLedgerEntryId: '077f0000-0000-7000-8000-000000000003',
        outboxId: '077f0000-0000-7000-8000-000000000005',
        payload: { newName: 'Lifecycle Command World', previousName: 'Ledger Upgrade World' },
        secondLedgerEntryId: '077f0000-0000-7000-8000-000000000004',
      });
      await connection.query('set constraints worlds_require_lifecycle_command immediate');
    });

    await transaction(app.pool, async (connection) => {
      await connection.query(
        `update world_memberships set role='observer',row_version=row_version+1,updated_at=now()
          where world_id=$1 and user_id=$2 and role='player' and status='active'`,
        [worldId, memberId],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: memberId,
        aggregateType: 'world_membership',
        commandId: '078f0000-0000-7000-8000-000000000001',
        commandType: 'ChangeWorldMembershipRoleV1',
        eventId: '078f0000-0000-7000-8000-000000000002',
        eventType: 'WorldMembershipRoleChangedV1',
        firstLedgerEntryId: '078f0000-0000-7000-8000-000000000003',
        outboxId: '078f0000-0000-7000-8000-000000000005',
        payload: { newRole: 'observer', previousRole: 'player', targetUserId: memberId },
        secondLedgerEntryId: '078f0000-0000-7000-8000-000000000004',
      });
      await connection.query(
        'set constraints world_memberships_require_lifecycle_command immediate',
      );
    });

    await transaction(app.pool, async (connection) => {
      await connection.query(
        `update world_memberships set status='removed',removed_at=now(),
           row_version=row_version+1,updated_at=now()
          where world_id=$1 and user_id=$2 and role='observer' and status='active'`,
        [worldId, memberId],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: memberId,
        aggregateType: 'world_membership',
        commandId: '078f0000-0000-7000-8000-000000000011',
        commandType: 'RemoveWorldMembershipV1',
        eventId: '078f0000-0000-7000-8000-000000000012',
        eventType: 'WorldMembershipRemovedV1',
        firstLedgerEntryId: '078f0000-0000-7000-8000-000000000013',
        outboxId: '078f0000-0000-7000-8000-000000000015',
        payload: { previousRole: 'observer', targetUserId: memberId },
        secondLedgerEntryId: '078f0000-0000-7000-8000-000000000014',
      });
      await connection.query(
        'set constraints world_memberships_require_lifecycle_command immediate',
      );
    });

    await transaction(app.pool, async (connection) => {
      const auditId = '078f0000-0000-7000-8000-000000000026';
      const overrideId = '078f0000-0000-7000-8000-000000000027';
      const commandId = '078f0000-0000-7000-8000-000000000021';
      await connection.query(
        `update world_memberships set role='player',row_version=row_version+1,updated_at=now()
          where world_id=$1 and user_id=$2 and role='administrator' and status='active'`,
        [worldId, administratorId],
      );
      await connection.query(
        `insert into security_audit_records(
           id,actor_user_id,world_id,category,action,outcome,reason_code,target_type,
           target_id,request_id,correlation_id
         ) values ($1,$2,$3,'creator_override','membership.force_demote_administrator',
           'allowed','CREATOR_OVERRIDE_USED','world_membership',$4,$5,$5)`,
        [auditId, creatorId, worldId, administratorId, commandId],
      );
      await connection.query(
        `insert into creator_override_records(
           id,world_id,actor_user_id,action,target_type,target_id,reason,
           authority_rule_id,command_id,audit_record_id
         ) values ($1,$2,$3,'membership.force_demote_administrator','world_membership',$4,
           'Exact lifecycle integration coverage','test.lifecycle.exact',$5,$6)`,
        [overrideId, worldId, creatorId, administratorId, commandId, auditId],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: administratorId,
        aggregateType: 'world_membership',
        commandId,
        commandType: 'UseCreatorOverrideV1',
        eventId: '078f0000-0000-7000-8000-000000000022',
        eventType: 'CreatorOverrideUsedV1',
        firstLedgerEntryId: '078f0000-0000-7000-8000-000000000023',
        outboxId: '078f0000-0000-7000-8000-000000000025',
        overrideId,
        payload: {
          authorityRuleId: 'test.lifecycle.exact',
          commandType: 'UseCreatorOverrideV1',
          overrideId,
          reasonCode: 'CREATOR_OVERRIDE_USED',
          targetId: administratorId,
          targetType: 'world_membership',
        },
        secondLedgerEntryId: '078f0000-0000-7000-8000-000000000024',
      });
      await connection.query(
        'set constraints world_memberships_require_lifecycle_command immediate',
      );
    });

    const revokedInvitationId = '078f0000-0000-7000-8000-000000000031';
    await transaction(app.pool, async (connection) => {
      await connection.query(
        `insert into world_invitations(
           id,world_id,email,intended_role,token_hash,expires_at,created_by_user_id
         ) values ($1,$2,'lifecycle-revoke@example.test','player',$3,now()+interval '1 day',$4)`,
        [revokedInvitationId, worldId, Buffer.alloc(32, 131), creatorId],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: revokedInvitationId,
        aggregateType: 'world_invitation',
        commandId: '078f0000-0000-7000-8000-000000000032',
        commandType: 'CreateWorldInvitationV1',
        eventId: '078f0000-0000-7000-8000-000000000033',
        eventType: 'WorldInvitationCreatedV1',
        firstLedgerEntryId: '078f0000-0000-7000-8000-000000000034',
        outboxId: '078f0000-0000-7000-8000-000000000036',
        payload: { intendedRole: 'player', invitationId: revokedInvitationId },
        secondLedgerEntryId: '078f0000-0000-7000-8000-000000000035',
      });
      await connection.query(
        'set constraints world_invitations_require_lifecycle_command immediate',
      );
    });
    await transaction(app.pool, async (connection) => {
      await connection.query(
        `update world_invitations set status='revoked',revoked_at=now(),
           row_version=row_version+1 where id=$1 and world_id=$2 and status='pending'`,
        [revokedInvitationId, worldId],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: revokedInvitationId,
        aggregateType: 'world_invitation',
        commandId: '078f0000-0000-7000-8000-000000000041',
        commandType: 'RevokeWorldInvitationV1',
        eventId: '078f0000-0000-7000-8000-000000000042',
        eventType: 'WorldInvitationRevokedV1',
        firstLedgerEntryId: '078f0000-0000-7000-8000-000000000043',
        outboxId: '078f0000-0000-7000-8000-000000000045',
        payload: { intendedRole: 'player', invitationId: revokedInvitationId },
        secondLedgerEntryId: '078f0000-0000-7000-8000-000000000044',
      });
      await connection.query(
        'set constraints world_invitations_require_lifecycle_command immediate',
      );
    });

    const acceptedInvitationId = '078f0000-0000-7000-8000-000000000051';
    await transaction(app.pool, async (connection) => {
      await connection.query(
        `insert into world_invitations(
           id,world_id,email,intended_role,token_hash,expires_at,created_by_user_id
         ) values ($1,$2,'lifecycle-accepted@example.test','player',$3,
           now()+interval '1 day',$4)`,
        [acceptedInvitationId, worldId, Buffer.alloc(32, 132), creatorId],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: acceptedInvitationId,
        aggregateType: 'world_invitation',
        commandId: '078f0000-0000-7000-8000-000000000052',
        commandType: 'CreateWorldInvitationV1',
        eventId: '078f0000-0000-7000-8000-000000000053',
        eventType: 'WorldInvitationCreatedV1',
        firstLedgerEntryId: '078f0000-0000-7000-8000-000000000054',
        outboxId: '078f0000-0000-7000-8000-000000000056',
        payload: { intendedRole: 'player', invitationId: acceptedInvitationId },
        secondLedgerEntryId: '078f0000-0000-7000-8000-000000000055',
      });
      await connection.query(
        'set constraints world_invitations_require_lifecycle_command immediate',
      );
    });
    await transaction(app.pool, async (connection) => {
      await connection.query(
        `insert into world_memberships(world_id,user_id,role,status,granted_by_user_id)
         values ($1,$2,'player','active',$3)`,
        [worldId, invitedUserId, creatorId],
      );
      await connection.query(
        `update world_invitations set status='accepted',accepted_by_user_id=$2,
           accepted_at=now(),row_version=row_version+1 where id=$1 and status='pending'`,
        [acceptedInvitationId, invitedUserId],
      );
      await appendAcceptedLifecycleFact(connection, {
        actorId: invitedUserId,
        aggregateId: acceptedInvitationId,
        aggregateType: 'world_invitation',
        commandId: '078f0000-0000-7000-8000-000000000061',
        commandType: 'AcceptWorldInvitationV1',
        eventId: '078f0000-0000-7000-8000-000000000062',
        eventType: 'WorldInvitationAcceptedV1',
        firstLedgerEntryId: '078f0000-0000-7000-8000-000000000063',
        outboxId: '078f0000-0000-7000-8000-000000000065',
        payload: {
          intendedRole: 'player',
          invitationId: acceptedInvitationId,
          targetUserId: invitedUserId,
        },
        secondLedgerEntryId: '078f0000-0000-7000-8000-000000000064',
      });
      await connection.query(
        'set constraints world_invitations_require_lifecycle_command immediate',
      );
      await connection.query(
        'set constraints world_memberships_require_lifecycle_command immediate',
      );
    });

    const manualRevisionId = '078f0000-0000-7000-8000-000000000071';
    const manualHash = Buffer.alloc(32, 133);
    await transaction(app.pool, async (connection) => {
      await connection.query(
        `insert into manifest_revisions(
           id,world_id,revision_number,parent_revision_id,manifest_schema_version,
           canonical_manifest,content_hash,source,created_by_user_id
         ) values ($1,$2,3,$3,1,$4,$5,'manual',$6)`,
        [
          manualRevisionId,
          worldId,
          draftRevisionId,
          {
            metadata: { key: 'ledger-manual-v3', name: 'Ledger Manual V3' },
            primitiveRefs: [],
          },
          manualHash,
          creatorId,
        ],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: manualRevisionId,
        aggregateType: 'manifest_revision',
        commandId: '078f0000-0000-7000-8000-000000000072',
        commandType: 'CreateManifestRevisionV1',
        eventId: '078f0000-0000-7000-8000-000000000073',
        eventType: 'ManifestRevisionCreatedV1',
        firstLedgerEntryId: '078f0000-0000-7000-8000-000000000074',
        outboxId: '078f0000-0000-7000-8000-000000000076',
        payload: {
          contentHash: manualHash.toString('hex'),
          manifestSchemaVersion: 1,
          revisionId: manualRevisionId,
          revisionNumber: '3',
          source: 'manual',
        },
        secondLedgerEntryId: '078f0000-0000-7000-8000-000000000075',
      });
      await connection.query(
        'set constraints manifest_revisions_require_lifecycle_command immediate',
      );
    });

    await expect(
      owner.pool.query(
        `select (select role::text from world_memberships where world_id=$1 and user_id=$2) member_role,
                (select status::text from world_memberships where world_id=$1 and user_id=$3) invited_status,
                (select approval_status::text from manifest_revisions where id=$4) manifest_status`,
        [worldId, administratorId, invitedUserId, manualRevisionId],
      ),
    ).resolves.toMatchObject({
      rows: [{ invited_status: 'active', manifest_status: 'draft', member_role: 'player' }],
    });
    const invitedPrincipal = memberPrincipalKey(worldId, invitedUserId);
    await expect(
      owner.pool.query(
        `select
          (select count(*)::text from world_entities
            where world_id=$1 and logical_key::text in ($2,$3)) entities,
          (select count(*)::text from world_entity_controllers
            where world_id=$1 and user_id=$4 and revoked_at is null) controllers`,
        [worldId, `account:${invitedPrincipal}`, `character:${invitedPrincipal}`, invitedUserId],
      ),
    ).resolves.toMatchObject({ rows: [{ controllers: '0', entities: '0' }] });
  });

  it('preserves pre-genesis creator bootstrap and bounded derived invitation expiration', async () => {
    const draftWorldId = '078f0000-0000-7000-8000-000000000101';
    await expect(
      transaction(app.pool, async (connection) => {
        await connection.query(
          `insert into worlds(id,slug,name,created_by_user_id)
           values ($1,'lifecycle-draft-bootstrap','Lifecycle Draft Bootstrap',$2)`,
          [draftWorldId, creatorId],
        );
        await connection.query(
          `insert into world_memberships(world_id,user_id,role,status,granted_by_user_id)
           values ($1,$2,'creator','active',$2)`,
          [draftWorldId, creatorId],
        );
      }),
    ).resolves.toBeUndefined();

    await expect(
      transaction(app.pool, async (connection) => {
        await connection.query(
          `update world_invitations set status='expired',row_version=row_version+1
            where id=$1 and world_id=$2 and status='pending' and expires_at<=now()`,
          [expiredInvitationId, worldId],
        );
        await connection.query(
          'set constraints world_invitations_require_lifecycle_command immediate',
        );
      }),
    ).resolves.toBeUndefined();
  });

  it('rolls back direct app-role lifecycle DML for every protected table and action category', async () => {
    const expectGateRejection = async (
      constraint: string,
      mutation: (connection: PoolClient) => Promise<unknown>,
    ) => {
      await expect(
        transaction(app.pool, async (connection) => {
          await mutation(connection);
          await connection.query(`set constraints ${constraint} immediate`);
        }),
      ).rejects.toMatchObject({ code: '55000' });
    };

    await expectGateRejection('worlds_require_lifecycle_command', (connection) =>
      connection.query(
        `update worlds set name='Direct lifecycle bypass',row_version=row_version+1,
           updated_at=now() where id=$1`,
        [worldId],
      ),
    );
    await expectGateRejection('worlds_require_lifecycle_command', (connection) =>
      connection.query(`update worlds set slug='direct-lifecycle-slug' where id=$1`, [worldId]),
    );
    await expectGateRejection('worlds_require_lifecycle_command', (connection) =>
      connection.query(`update worlds set archived_at=now() where id=$1`, [worldId]),
    );
    await expectGateRejection('worlds_require_lifecycle_command', (connection) =>
      connection.query(`update worlds set row_version=row_version+1 where id=$1`, [worldId]),
    );
    await expectGateRejection('worlds_require_lifecycle_command', (connection) =>
      connection.query(
        `update worlds set name='Mixed lifecycle bypass',slug='mixed-lifecycle-bypass',
           row_version=row_version+1,updated_at=now() where id=$1`,
        [worldId],
      ),
    );
    await expectGateRejection('worlds_require_lifecycle_command', async (connection) => {
      await connection.query(
        `update worlds set name='Mixed exact-event bypass',slug='mixed-exact-event-bypass',
           row_version=row_version+1,updated_at=now() where id=$1`,
        [worldId],
      );
      await appendAcceptedLifecycleFact(connection, {
        aggregateId: worldId,
        aggregateType: 'world',
        commandId: '077f0000-0000-7000-8000-000000000011',
        commandType: 'RenameWorldV1',
        eventId: '077f0000-0000-7000-8000-000000000012',
        eventType: 'WorldRenamedV1',
        firstLedgerEntryId: '077f0000-0000-7000-8000-000000000013',
        outboxId: '077f0000-0000-7000-8000-000000000015',
        payload: {
          newName: 'Mixed exact-event bypass',
          previousName: 'Lifecycle Command World',
        },
        secondLedgerEntryId: '077f0000-0000-7000-8000-000000000014',
      });
    });

    await expectGateRejection('world_memberships_require_lifecycle_command', (connection) =>
      connection.query(
        `update world_memberships set role='observer',row_version=row_version+1,updated_at=now()
          where world_id=$1 and user_id=$2 and status='active'`,
        [worldId, administratorId],
      ),
    );
    await expectGateRejection('world_memberships_require_lifecycle_command', (connection) =>
      connection.query(
        `update world_memberships set status='removed',removed_at=now(),
           row_version=row_version+1,updated_at=now()
          where world_id=$1 and user_id=$2 and status='active'`,
        [worldId, administratorId],
      ),
    );

    await expectGateRejection('world_invitations_require_lifecycle_command', (connection) =>
      connection.query(
        `insert into world_invitations(
           id,world_id,email,intended_role,token_hash,expires_at,created_by_user_id
         ) values ('078f0000-0000-7000-8000-000000000111',$1,
           'direct-invite@example.test','player',$2,now()+interval '1 day',$3)`,
        [worldId, Buffer.alloc(32, 141), creatorId],
      ),
    );
    await expectGateRejection('world_invitations_require_lifecycle_command', (connection) =>
      connection.query(
        `update world_invitations set status='revoked',revoked_at=now(),
           row_version=row_version+1 where id=$1 and status='pending'`,
        [pendingInvitationId],
      ),
    );
    await expectGateRejection('world_invitations_require_lifecycle_command', (connection) =>
      connection.query(
        `update world_invitations set status='accepted',accepted_by_user_id=$2,
           accepted_at=now(),row_version=row_version+1 where id=$1 and status='pending'`,
        [pendingInvitationId, invitedUserId],
      ),
    );

    const directManifestId = '078f0000-0000-7000-8000-000000000121';
    await expectGateRejection('manifest_revisions_require_lifecycle_command', (connection) =>
      connection.query(
        `insert into manifest_revisions(
           id,world_id,revision_number,parent_revision_id,manifest_schema_version,
           canonical_manifest,content_hash,source,created_by_user_id
         ) values ($1,$2,4,$3,1,$4,$5,'manual',$6)`,
        [
          directManifestId,
          worldId,
          '078f0000-0000-7000-8000-000000000071',
          {
            metadata: { key: 'direct-manifest-v4', name: 'Direct Manifest V4' },
            primitiveRefs: [],
          },
          Buffer.alloc(32, 142),
          creatorId,
        ],
      ),
    );

    const reportId = '078f0000-0000-7000-8000-000000000122';
    await app.pool.query(
      `insert into manifest_validation_reports(
         id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
         valid,diagnostics,report_hash
       ) values ($1,$2,1,$3,true,'[]',$4)`,
      [
        reportId,
        '078f0000-0000-7000-8000-000000000071',
        Buffer.alloc(32, 143),
        Buffer.alloc(32, 144),
      ],
    );
    await expectGateRejection(
      'manifest_revisions_require_lifecycle_command',
      async (connection) => {
        await connection.query(
          `update manifest_revisions set approval_status='superseded',row_version=row_version+1
          where id=$1 and approval_status='approved'`,
          [revisionId],
        );
        await connection.query(
          `update manifest_revisions set approval_status='approved',approved_by_user_id=$2,
           approved_at=now(),row_version=row_version+1
          where id=$1 and approval_status='draft'`,
          ['078f0000-0000-7000-8000-000000000071', creatorId],
        );
        await connection.query(
          `update worlds set current_approved_manifest_revision_id=$2,
           row_version=row_version+1,updated_at=now() where id=$1`,
          [worldId, '078f0000-0000-7000-8000-000000000071'],
        );
      },
    );
  });

  it('fails closed for active-world lifecycle DML when ledger authority is missing', async () => {
    const expectCorruptAuthorityRejection = async (
      constraint: string,
      mutation: (connection: PoolClient) => Promise<unknown>,
    ) => {
      await expect(
        transaction(owner.pool, async (connection) => {
          await connection.query(`set local session_replication_role='replica'`);
          await connection.query(`delete from world_runtime_heads where world_id=$1`, [worldId]);
          await connection.query(`delete from world_ledger_heads where world_id=$1`, [worldId]);
          await connection.query(`set local session_replication_role='origin'`);
          await connection.query(`set local role worldgraph_app`);
          await mutation(connection);
          await connection.query(`set constraints ${constraint} immediate`);
        }),
      ).rejects.toMatchObject({ code: '55000' });
    };

    await expectCorruptAuthorityRejection(
      'world_memberships_require_lifecycle_command',
      (connection) =>
        connection.query(
          `update world_memberships set role='observer',row_version=row_version+1,
             updated_at=now() where world_id=$1 and user_id=$2 and status='active'`,
          [worldId, administratorId],
        ),
    );
    await expectCorruptAuthorityRejection(
      'world_invitations_require_lifecycle_command',
      (connection) =>
        connection.query(
          `update world_invitations set status='revoked',revoked_at=now(),
             row_version=row_version+1 where id=$1 and status='pending'`,
          [pendingInvitationId],
        ),
    );
    await expectCorruptAuthorityRejection(
      'manifest_revisions_require_lifecycle_command',
      (connection) =>
        connection.query(
          `insert into manifest_revisions(
             id,world_id,revision_number,parent_revision_id,manifest_schema_version,
             canonical_manifest,content_hash,source,created_by_user_id
           ) values ('078f0000-0000-7000-8000-000000000131',$1,4,$2,1,$3,$4,
             'manual',$5)`,
          [
            worldId,
            '078f0000-0000-7000-8000-000000000071',
            {
              metadata: { key: 'corrupt-authority-v4', name: 'Corrupt Authority V4' },
              primitiveRefs: [],
            },
            Buffer.alloc(32, 145),
            creatorId,
          ],
        ),
    );
  });

  it('freezes ordinary commands on anchor, ledger-head, or live-projection corruption', async () => {
    const commandIds = [
      '068f0000-0000-7000-8000-0000000007a1',
      '068f0000-0000-7000-8000-0000000007a2',
      '068f0000-0000-7000-8000-0000000007a3',
    ];
    const before = await owner.pool.query<{
      anchor_details: Record<string, unknown>;
      last_ledger_sequence: string;
      name: string;
    }>(
      `select
        (select redacted_details from ledger_entries
          where world_id=$1 and ledger_sequence=1) anchor_details,
        runtime.last_ledger_sequence::text,
        entity.state->>'name' name
       from world_runtime_heads runtime
       join world_entities entity on entity.world_id=runtime.world_id and entity.id=$2
       where runtime.world_id=$1`,
      [worldId, characterId],
    );
    expect(BigInt(before.rows[0]!.last_ledger_sequence)).toBeGreaterThan(1n);

    const expectCommandFreeze = async (
      commandIndex: number,
      corrupt: (connection: PoolClient) => Promise<unknown>,
    ) => {
      const commandId = commandIds[commandIndex]!;
      await expect(
        transaction(owner.pool, async (connection) => {
          await connection.query(`set local session_replication_role='replica'`);
          await corrupt(connection);
          await connection.query(`set local session_replication_role='origin'`);
          await connection.query(`set local role worldgraph_app`);
          await connection.query(
            `insert into command_records(
              id,world_id,command_type,command_schema_version,actor_type,actor_id,payload,
              payload_hash,payload_classification,idempotency_key,request_hash,correlation_id
            ) values ($1,$2,'RenameWorldEntityV1',1,'user',$3,'{}',$4,'member',$5,$6,$1)`,
            [
              commandId,
              worldId,
              creatorId,
              Buffer.alloc(32, 150 + commandIndex),
              `corruption-freeze-${commandIndex}`,
              Buffer.alloc(32, 160 + commandIndex),
            ],
          );
          await connection.query(`select worldgraph_open_command_write($1,$2)`, [
            commandId,
            worldId,
          ]);
        }),
      ).rejects.toMatchObject({ code: '55000' });
    };

    await expectCommandFreeze(0, (connection) =>
      connection.query(
        `update ledger_entries
            set redacted_details=redacted_details || '{"corruptedAnchor":true}'::jsonb
          where world_id=$1 and ledger_sequence=1`,
        [worldId],
      ),
    );
    await expectCommandFreeze(1, (connection) =>
      connection.query(
        `update world_ledger_heads set last_entry_hash=decode(repeat('ab',32),'hex')
          where world_id=$1`,
        [worldId],
      ),
    );
    await expectCommandFreeze(2, (connection) =>
      connection.query(
        `update world_entities set state=jsonb_set(state,'{name}','"Corrupted live state"')
          where world_id=$1 and id=$2`,
        [worldId, characterId],
      ),
    );

    const after = await owner.pool.query<{
      anchor_details: Record<string, unknown>;
      commands: string;
      last_ledger_sequence: string;
      name: string;
    }>(
      `select
        (select redacted_details from ledger_entries
          where world_id=$1 and ledger_sequence=1) anchor_details,
        (select count(*)::text from command_records where id=any($3::uuid[])) commands,
        runtime.last_ledger_sequence::text,
        entity.state->>'name' name
       from world_runtime_heads runtime
       join world_entities entity on entity.world_id=runtime.world_id and entity.id=$2
       where runtime.world_id=$1`,
      [worldId, characterId, commandIds],
    );
    expect(after.rows[0]).toEqual({ ...before.rows[0], commands: '0' });
  });

  it('rolls back a projection mutation disguised as a rejected command', async () => {
    const commandId = '068f0000-0000-7000-8000-000000000791';
    const entryId = '068f0000-0000-7000-8000-000000000792';
    const before = await owner.pool.query<{
      checksum: Buffer;
      last_ledger_sequence: string;
      name: string;
      row_version: string;
    }>(
      `select entity.state->>'name' name, entity.row_version::text,
              runtime.last_ledger_sequence::text, runtime.projection_checksum checksum
         from world_entities entity
         join world_runtime_heads runtime on runtime.world_id = entity.world_id
        where entity.world_id=$1 and entity.id=$2`,
      [worldId, characterId],
    );

    await expect(
      transaction(app.pool, async (connection) => {
        const at = new Date();
        await connection.query(
          `insert into command_records(
            id,world_id,command_type,command_schema_version,actor_type,actor_id,payload,
            payload_hash,payload_classification,idempotency_key,request_hash,
            expected_world_version,expected_state_revision,correlation_id,requested_at
          ) values ($1,$2,'RenameWorldEntityV1',1,'user',$3,'{}',$4,'member',
            'forged-rejection-001',$5,1,2,$1,$6)`,
          [commandId, worldId, creatorId, Buffer.alloc(32, 90), Buffer.alloc(32, 91), at],
        );
        await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
        await connection.query(
          `update world_entities
              set state=jsonb_set(state,'{name}','"Forged rejection"'),
                  row_version=row_version+1,updated_at=$3
            where world_id=$1 and id=$2`,
          [worldId, characterId, at],
        );
        const allocation = await connection.query<{
          last_entry_hash: Buffer;
          next_ledger_sequence: string;
        }>(
          `select last_entry_hash,next_ledger_sequence::text
             from world_ledger_heads where world_id=$1`,
          [worldId],
        );
        const sequence = allocation.rows[0]!.next_ledger_sequence;
        const details = { rejectionCode: 'REVISION_CONFLICT' };
        const hash = await connection.query<{ hash: Buffer }>(
          `select worldgraph_ledger_entry_hash_v1(
            $1,$2,$3::bigint,'command_rejected',$4,null,'user',$5,
            'COMMAND_REJECTED',$6,$7,$8
          ) hash`,
          [
            entryId,
            worldId,
            sequence,
            commandId,
            creatorId,
            details,
            allocation.rows[0]!.last_entry_hash,
            at,
          ],
        );
        await connection.query(
          `insert into ledger_entries(
            id,world_id,ledger_sequence,entry_kind,command_id,event_id,actor_type,
            actor_id,public_summary_code,redacted_details,previous_hash,entry_hash,recorded_at
          ) values ($1,$2,$3::bigint,'command_rejected',$4,null,'user',$5,
            'COMMAND_REJECTED',$6,$7,$8,$9)`,
          [
            entryId,
            worldId,
            sequence,
            commandId,
            creatorId,
            details,
            allocation.rows[0]!.last_entry_hash,
            hash.rows[0]!.hash,
            at,
          ],
        );
        const forgedChecksum = await connection.query<{ checksum: Buffer }>(
          `select worldgraph_projection_checksum($1,2) checksum`,
          [worldId],
        );
        await connection.query(
          `update world_runtime_heads
              set last_ledger_sequence=$2::bigint,projection_checksum=$3,updated_at=$4
            where world_id=$1`,
          [worldId, sequence, forgedChecksum.rows[0]!.checksum, at],
        );
        await connection.query(
          `update projection_checkpoints set checksum=$2,updated_at=$3
            where world_id=$1 and projection_name='world_graph'`,
          [worldId, forgedChecksum.rows[0]!.checksum, at],
        );
        await connection.query(
          `update command_records
              set status='rejected',rejection_code='REVISION_CONFLICT',decided_at=$2,
                  response_summary=$3
            where id=$1`,
          [
            commandId,
            at,
            {
              commandId,
              currentStateRevision: '2',
              eventIds: [],
              rejectionCode: 'REVISION_CONFLICT',
              schemaVersion: 1,
              status: 'rejected',
            },
          ],
        );
      }),
    ).rejects.toMatchObject({ code: '55000' });

    const after = await owner.pool.query<{
      checksum: Buffer;
      last_ledger_sequence: string;
      name: string;
      row_version: string;
    }>(
      `select entity.state->>'name' name, entity.row_version::text,
              runtime.last_ledger_sequence::text, runtime.projection_checksum checksum
         from world_entities entity
         join world_runtime_heads runtime on runtime.world_id = entity.world_id
        where entity.world_id=$1 and entity.id=$2`,
      [worldId, characterId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(
      await owner.pool.query(`select count(*)::text count from command_records where id=$1`, [
        commandId,
      ]),
    ).toMatchObject({ rows: [{ count: '0' }] });
  });

  it('rolls back every ledger allocation and projection change on transaction failure', async () => {
    const before = await owner.pool.query<{ events: string; ledger: string; name: string }>(
      `select (select count(*)::text from domain_events where world_id=$1) events,
        (select count(*)::text from ledger_entries where world_id=$1) ledger,
        (select state->>'name' from world_entities where world_id=$1 and id=$2) name`,
      [worldId, characterId],
    );
    await expect(
      transaction(app.pool, async (connection) => {
        const commandId = '068f0000-0000-7000-8000-000000000731';
        await connection.query(
          `insert into command_records(
            id,world_id,command_type,command_schema_version,actor_type,actor_id,payload,
            payload_hash,payload_classification,idempotency_key,request_hash,
            expected_world_version,expected_state_revision,correlation_id
          ) values ($1,$2,'RenameWorldEntityV1',1,'user',$3,'{}',$4,'member',
            'rollback-command-001',$5,1,2,$1)`,
          [commandId, worldId, creatorId, Buffer.alloc(32, 80), Buffer.alloc(32, 81)],
        );
        await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
        await connection.query(
          `update world_entities set state=jsonb_set(state,'{name}','"Rolled Back"'),
            row_version=row_version+1,updated_at=now() where world_id=$1 and id=$2`,
          [worldId, characterId],
        );
        throw new Error('injected failure');
      }),
    ).rejects.toThrow('injected failure');
    const after = await owner.pool.query<{ events: string; ledger: string; name: string }>(
      `select (select count(*)::text from domain_events where world_id=$1) events,
        (select count(*)::text from ledger_entries where world_id=$1) ledger,
        (select state->>'name' from world_entities where world_id=$1 and id=$2) name`,
      [worldId, characterId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('repairs a diverged projection from a completed durable shadow with two-person approval', async () => {
    const firstAdmin = '068f0000-0000-7000-8000-000000000801';
    const secondAdmin = '068f0000-0000-7000-8000-000000000802';
    const replayId = '068f0000-0000-7000-8000-000000000811';
    const commandId = '068f0000-0000-7000-8000-000000000812';
    const eventId = '068f0000-0000-7000-8000-000000000813';
    const entryId = '068f0000-0000-7000-8000-000000000814';
    const outboxId = '068f0000-0000-7000-8000-000000000815';
    const head = await owner.pool.query<{
      checksum: Buffer;
      last_event_sequence: string;
      state_revision: string;
    }>(
      `select projection_checksum checksum,last_event_sequence::text,state_revision::text
       from world_runtime_heads where world_id=$1`,
      [worldId],
    );
    const expectedRepairRevision = String(BigInt(head.rows[0]!.state_revision) + 1n);
    await transaction(owner.pool, async (connection) => {
      await connection.query(
        `insert into users(id,email,password_hash,platform_role) values
          ($1,'repair-admin-1@example.test',$3,'platform_admin'),
          ($2,'repair-admin-2@example.test',$3,'platform_admin')`,
        [firstAdmin, secondAdmin, passwordHash],
      );
      await connection.query(
        `insert into projection_replay_runs(
          id,world_id,projection_name,target_schema_version,requested_by_actor_type,
          requested_by_actor_id,from_event_sequence,to_event_sequence,status,
          source_checksum,replay_checksum,reason,started_at,completed_at
        ) values ($1,$2,'world_graph',1,'platform_admin',$3,1,$4,'succeeded',
          $5,$5,'repair integration test',now(),now())`,
        [replayId, worldId, firstAdmin, head.rows[0]!.last_event_sequence, head.rows[0]!.checksum],
      );
      await connection.query(
        `insert into shadow_world_entities(
          replay_run_id,world_id,entity_id,logical_key,entity_type,
          entity_schema_version,state,row_version
        ) select $1,world_id,id,logical_key::text,entity_type,
          entity_schema_version,state,row_version
          from world_entities where world_id=$2 and retired_world_version_id is null`,
        [replayId, worldId],
      );
      await connection.query(
        `insert into shadow_world_relationships(
          replay_run_id,world_id,relationship_id,logical_key,relationship_type,
          source_entity_id,target_entity_id,relationship_schema_version,attributes,row_version
        ) select $1,world_id,id,logical_key::text,relationship_type,source_entity_id,
          target_entity_id,relationship_schema_version,attributes,row_version
          from world_relationships where world_id=$2 and retired_world_version_id is null`,
        [replayId, worldId],
      );
      await connection.query(
        `insert into shadow_world_entity_controllers(
          replay_run_id,world_id,user_id,entity_id,control_scope,principal_key,entity_logical_key
        ) select $1,controller.world_id,controller.user_id,controller.entity_id,
          controller.control_scope,account.state->>'principalKey',character.logical_key::text
        from world_entity_controllers controller
        join world_entities character on character.world_id=controller.world_id
          and character.id=controller.entity_id
        join world_relationships edge on edge.world_id=controller.world_id
          and edge.target_entity_id=controller.entity_id
          and edge.relationship_type='account_controls' and edge.retired_world_version_id is null
        join world_entities account on account.world_id=edge.world_id
          and account.id=edge.source_entity_id
        where controller.world_id=$2 and controller.revoked_at is null`,
        [replayId, worldId],
      );
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update world_entities set state=jsonb_set(state,'{name}','"Corrupted Character"')
         where world_id=$1 and id=$2`,
        [worldId, characterId],
      );
    });
    await expect(
      owner.pool.query(
        `select * from worldgraph_projection_repair_swap(
          $1,$2,$3,$4,$4,$4,$5,$6,$7,$8
        )`,
        [
          replayId,
          worldId,
          'repair integration test',
          firstAdmin,
          commandId,
          eventId,
          entryId,
          outboxId,
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    const repaired = await owner.pool.query<{
      projection_checksum: Buffer;
      resulting_state_revision: string;
    }>(
      `select projection_checksum,resulting_state_revision::text
       from worldgraph_projection_repair_swap($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        replayId,
        worldId,
        'repair integration test',
        firstAdmin,
        firstAdmin,
        secondAdmin,
        commandId,
        eventId,
        entryId,
        outboxId,
      ],
    );
    expect(repaired.rows[0]?.resulting_state_revision).toBe(expectedRepairRevision);
    const state = await owner.pool.query<{
      event_type: string;
      name: string;
      payload_checksum: string;
      runtime_checksum: string;
      state_revision: string;
    }>(
      `select entity.state->>'name' name,event.event_type,
        event.payload->>'toChecksum' payload_checksum,
        encode(runtime.projection_checksum,'hex') runtime_checksum,
        runtime.state_revision::text
       from world_entities entity
       join world_runtime_heads runtime on runtime.world_id=entity.world_id
       join domain_events event on event.world_id=entity.world_id
         and event.event_type='ProjectionRepairAnchoredV1'
       where entity.world_id=$1 and entity.id=$2`,
      [worldId, characterId],
    );
    expect(state.rows[0]).toMatchObject({
      event_type: 'ProjectionRepairAnchoredV1',
      name: 'Renamed Character',
      state_revision: expectedRepairRevision,
    });
    expect(state.rows[0]?.payload_checksum).toBe(state.rows[0]?.runtime_checksum);
    expect(repaired.rows[0]?.projection_checksum.toString('hex')).toBe(
      state.rows[0]?.runtime_checksum,
    );
  });

  it('executes the exact anchored manifest approval branch before isolated rollback', async () => {
    const manualRevisionId = '078f0000-0000-7000-8000-000000000071';
    const manualHash = Buffer.alloc(32, 133);
    await expect(
      transaction(owner.pool, async (connection) => {
        // Anchored worlds are active in the current product lifecycle, so approval
        // normally occurs before genesis. Isolate the post-anchor branch by moving
        // only this transaction's OLD row to the valid pre-approval state with
        // owner-only trigger suppression, then execute the application path and
        // force both lifecycle constraints before rolling the fixture back.
        await connection.query(`set local role worldgraph_app`);
        await appendAcceptedLifecycleFact(connection, {
          aggregateId: manualRevisionId,
          aggregateType: 'manifest_revision',
          commandId: '078f0000-0000-7000-8000-000000000081',
          commandType: 'ApproveManifestRevisionV1',
          eventId: '078f0000-0000-7000-8000-000000000082',
          eventType: 'ManifestApprovedV1',
          firstLedgerEntryId: '078f0000-0000-7000-8000-000000000083',
          outboxId: '078f0000-0000-7000-8000-000000000085',
          payload: {
            contentHash: manualHash.toString('hex'),
            manifestSchemaVersion: 1,
            revisionId: manualRevisionId,
          },
          secondLedgerEntryId: '078f0000-0000-7000-8000-000000000084',
        });
        await connection.query(`reset role`);
        await connection.query(`set local session_replication_role='replica'`);
        await connection.query(
          `update worlds set lifecycle='draft',active_world_version_id=null,
             row_version=row_version+1,updated_at=now() where id=$1`,
          [worldId],
        );
        await connection.query(`set local session_replication_role='origin'`);
        await connection.query(`set local role worldgraph_app`);
        await connection.query(
          `update manifest_revisions set approval_status='superseded',row_version=row_version+1
            where id=$1 and world_id=$2 and approval_status='approved'`,
          [revisionId, worldId],
        );
        await connection.query(
          `update manifest_revisions set approval_status='approved',approved_by_user_id=$2,
             approved_at=now(),row_version=row_version+1
            where id=$1 and world_id=$3 and approval_status='draft'`,
          [manualRevisionId, creatorId, worldId],
        );
        await connection.query(
          `update worlds set current_approved_manifest_revision_id=$2,
             manifest_schema_version=1,lifecycle='manifest_approved',
             row_version=row_version+1,updated_at=now() where id=$1`,
          [worldId, manualRevisionId],
        );
        await connection.query(
          'set constraints manifest_revisions_require_lifecycle_command immediate',
        );
        await connection.query('set constraints worlds_require_lifecycle_command immediate');
        throw new Error('VALID_APPROVAL_BRANCH_ROLLBACK');
      }),
    ).rejects.toThrow('VALID_APPROVAL_BRANCH_ROLLBACK');
  });
});
