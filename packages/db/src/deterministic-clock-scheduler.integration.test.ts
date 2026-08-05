import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { canonicalJson } from '@worldgraph/contracts';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient, readRuntimeVersions } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const creatorId = '078f0000-0000-7000-8000-000000000001';
const worldId = '078f0000-0000-7000-8000-000000000101';
const revisionId = '078f0000-0000-7000-8000-000000000201';
const runId = '078f0000-0000-7000-8000-000000000301';
const versionId = '078f0000-0000-7000-8000-000000000401';
const simulationEntityId = '078f0000-0000-7000-8000-000000000501';
const clockPrimitiveEntityId = '078f0000-0000-7000-8000-000000000502';
const relationshipId = '078f0000-0000-7000-8000-000000000601';
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const artifactHash = Buffer.alloc(32, 72);
const manifestHash = Buffer.alloc(32, 73);

function javascriptInitialSimulationOutcomeHashV1(worldSeed: string): string {
  const worldSeedHash = createHash('sha256')
    .update(canonicalJson({ domain: 'worldgraph.simulation.world-seed.v1', worldSeed }), 'utf8')
    .digest('hex');
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: 'worldgraph.simulation.outcome.initial.v1',
        outcomeSchemaVersion: 1,
        prngAlgorithmVersion: 'xorshift32-sha256-v1',
        processRegistryVersion: 1,
        worldSeedHash,
      }),
      'utf8',
    )
    .digest('hex');
}

async function transaction<T>(pool: Pool, operation: (connection: PoolClient) => Promise<T>) {
  const connection = await pool.connect();
  try {
    await connection.query('begin');
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

async function migrationFolderThrough(lastIndex: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `worldgraph-m07-through-${lastIndex}-`));
  await mkdir(join(root, 'meta'));
  const tags = [
    '0001_platform_extensions',
    '0002_platform_metadata',
    '0003_identity_authority',
    '0004_primitive_registry',
    '0005_manifest_studio',
    '0006_deterministic_compiler',
    '0007_command_event_ledger',
  ].slice(0, lastIndex + 1);
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
  await transaction(pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into users(id,email,password_hash,display_name)
       values ($1,'m07-creator@example.test',$2,'M07 Creator')`,
      [creatorId, passwordHash],
    );
    await connection.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'m07-upgrade-world','M07 Upgrade World',$2)`,
      [worldId, creatorId],
    );
    await connection.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2)`,
      [worldId, creatorId],
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
          metadata: { key: 'm07-upgrade-world', name: 'M07 Upgrade World' },
          primitiveRefs: [],
        },
        manifestHash,
        creatorId,
      ],
    );
    await connection.query(
      `insert into world_compilation_runs(
         id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
         compiler_version,compiler_config_version,seed,status,stage,progress_percent,
         requested_by_user_id,idempotency_key,artifact_hash,attempts,next_attempt_at,
         claimed_at,heartbeat_at,queued_at,started_at,completed_at,updated_at
       ) values (
         $1,$2,$3,$4,$5,'1.0.0',1,'m07-seed','succeeded','activated',100,
         $6,'m07-genesis-request',$7,1,now(),now(),now(),now(),now(),now(),now()
       )`,
      [runId, worldId, revisionId, manifestHash, Buffer.alloc(32, 74), creatorId, artifactHash],
    );
    await connection.query(
      `insert into world_versions(
         id,world_id,version_number,manifest_revision_id,compilation_run_id,
         world_schema_version,compiler_version,compiler_config_version,seed,
         artifact_hash,status,created_by_user_id,activated_at
       ) values ($1,$2,1,$3,$4,1,'1.0.0',1,'m07-seed',$5,'active',$6,now())`,
      [versionId, worldId, revisionId, runId, artifactHash, creatorId],
    );
    await connection.query(
      `insert into world_entities(
         id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
       ) values
         ($1,$3,'simulation:configuration','simulation_configuration',1,$4,$6),
         ($2,$3,'primitive:clock','primitive_instance',1,$5,$6)`,
      [
        simulationEntityId,
        clockPrimitiveEntityId,
        worldId,
        { eventPrimitiveRefs: [], rulePrimitiveRefs: ['clock'], settings: {} },
        {
          behaviorRef: 'simulation.discrete_clock',
          contentHash: 'a'.repeat(64),
          key: 'worldgraph.simulation-rule.discrete-city-clock',
          kind: 'simulation_rule',
          parameters: { maxCatchUpTicks: 100, tickDurationSeconds: 60 },
          ref: 'clock',
          version: '1.0.0',
        },
        versionId,
      ],
    );
    await connection.query(
      `insert into world_relationships(
         id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
         relationship_schema_version,attributes,created_world_version_id
       ) values ($1,$2,'rel:uses_primitive:simulation-clock','uses_primitive',$3,$4,1,'{}',$5)`,
      [relationshipId, worldId, simulationEntityId, clockPrimitiveEntityId, versionId],
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

function deterministicMigrationId(kind: 'command' | 'event' | 'ledger' | 'outbox'): string {
  const hex = createHash('sha256')
    .update(`worldgraph:m07:simulation-init:${kind}:${worldId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

async function openClockGuardCommand(
  connection: PoolClient,
  commandId: string,
  commandType: string,
): Promise<void> {
  const snapshot = await connection.query<{
    aggregate_version: string;
    design_version: string;
    state_revision: string;
  }>(
    `select runtime.state_revision::text,version.version_number::text design_version,
            stream.current_version::text aggregate_version
       from world_runtime_heads runtime
       join world_versions version on version.id=runtime.active_world_version_id
       join aggregate_stream_heads stream on stream.world_id=runtime.world_id
        and stream.aggregate_type='simulation_clock'
        and stream.aggregate_id=runtime.world_id::text
      where runtime.world_id=$1`,
    [worldId],
  );
  const row = snapshot.rows[0];
  if (!row) throw new Error('clock guard snapshot is missing');
  await connection.query(
    `insert into command_records(
       id,world_id,command_type,command_schema_version,actor_type,actor_id,
       payload,payload_hash,payload_classification,idempotency_key,request_hash,
       expected_world_version,expected_state_revision,expected_aggregate_version,
       correlation_id,requested_at
     ) values (
       $1,$2,$3,1,'system','worldgraph:clock-guard-test',null,
       extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
       'member',$4,extensions.digest(convert_to($4,'UTF8'),'sha256'),
       $5::bigint,$6::bigint,$7::bigint,$1,
       date_trunc('milliseconds',transaction_timestamp())
     )`,
    [
      commandId,
      worldId,
      commandType,
      `clock-guard-${commandId}`,
      row.design_version,
      row.state_revision,
      row.aggregate_version,
    ],
  );
  await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
}

describe('M07 deterministic clock and scheduler migration', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;
  let app: DatabaseClient;
  let m05Root: string;
  let m06Root: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'm07-db-owner-test');
    m05Root = await migrationFolderThrough(5);
    m06Root = await migrationFolderThrough(6);
    await migrate(owner.db, { migrationsFolder: m05Root });
    await seedPreM06ActiveWorld(owner.pool);
    await migrate(owner.db, { migrationsFolder: m06Root });
    await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
      contracts: 6,
      runtimeSchema: 6,
    });
    await migrate(owner.db, { migrationsFolder: migrationRoot });
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    app = createDatabaseClient(appUrl.toString(), 'm07-db-app-test');
  });

  afterAll(async () => {
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
    if (m05Root) await rm(m05Root, { force: true, recursive: true });
    if (m06Root) await rm(m06Root, { force: true, recursive: true });
  });

  it('upgrades compatibility and appends one truthful paused initialization fact', async () => {
    await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
      contracts: 10,
      runtimeSchema: 10,
      simulationBatchSchema: 1,
      simulationClockSchema: 1,
      simulationFailureSchema: 1,
      simulationOutcomeSchema: 1,
      simulationPrngAlgorithm: 'xorshift32-sha256-v1',
      simulationPrngSchema: 1,
      simulationProcessRegistry: 3,
      simulationProcessSchema: 1,
      simulationProjectionSchema: 1,
      simulationQueueSchema: 1,
      simulationScheduleSchema: 1,
    });
    const state = await owner.pool.query<{
      current_tick: string;
      epoch_at: Date;
      last_event_sequence: string;
      last_ledger_sequence: string;
      max_batch_ticks: number;
      max_catch_up_ticks: number;
      mode: string;
      next_schedule_sequence: string;
      outcome_hash: string;
      state_revision: string;
      updated_state_revision: string;
      wall_cadence_milliseconds: number;
      world_milliseconds_per_tick: string;
    }>(
      `select clock.current_tick::text,clock.epoch_at,clock.mode::text,
        encode(clock.outcome_hash,'hex') outcome_hash,
        clock.world_milliseconds_per_tick::text,clock.wall_cadence_milliseconds,
        clock.max_batch_ticks,clock.max_catch_up_ticks,
        clock.updated_state_revision::text,schedule.next_schedule_sequence::text,
        runtime.state_revision::text,runtime.last_event_sequence::text,
        runtime.last_ledger_sequence::text
       from world_simulation_clocks clock
       join world_schedule_heads schedule on schedule.world_id=clock.world_id
       join world_runtime_heads runtime on runtime.world_id=clock.world_id
       where clock.world_id=$1`,
      [worldId],
    );
    expect(state.rows[0]).toMatchObject({
      current_tick: '0',
      last_event_sequence: '2',
      last_ledger_sequence: '2',
      max_batch_ticks: 64,
      max_catch_up_ticks: 100,
      mode: 'paused',
      next_schedule_sequence: '1',
      outcome_hash: javascriptInitialSimulationOutcomeHashV1('m07-seed'),
      state_revision: '2',
      updated_state_revision: '2',
      wall_cadence_milliseconds: 10_000,
      world_milliseconds_per_tick: '60000',
    });
    expect(state.rows[0]?.epoch_at.toISOString()).toBe('2000-01-01T00:00:00.000Z');

    const commandId = deterministicMigrationId('command');
    const eventId = deterministicMigrationId('event');
    const initialization = await owner.pool.query<{
      command_id: string;
      command_type: string;
      event_id: string;
      event_payload: Record<string, unknown>;
      history_summary: Record<string, unknown>;
      history_target_type: string;
      ledger_id: string;
      outbox_id: string;
      outbox_payload: Record<string, unknown>;
      status: string;
    }>(
      `select command.id command_id,command.command_type,event.id event_id,command.status::text,
        event.payload event_payload,entry.id ledger_id,message.id outbox_id,
        message.payload outbox_payload,history.summary_args history_summary,
        history.target_type history_target_type
       from command_records command
       join domain_events event on event.command_id=command.id
       join ledger_entries entry on entry.event_id=event.id
       join outbox_messages message on message.event_id=event.id
       join world_history_entries history on history.event_id=event.id
       where command.id=$1`,
      [commandId],
    );
    expect(initialization.rows[0]).toMatchObject({
      command_id: commandId,
      command_type: 'InitializeWorldSimulationV1',
      event_id: eventId,
      event_payload: {
        currentTick: '0',
        mode: 'paused',
        processRegistryVersion: 1,
        provenance: 'compiled_configuration',
      },
      history_summary: {
        currentTick: '0',
        processRegistryVersion: 1,
        provenance: 'compiled_configuration',
      },
      history_target_type: 'world_simulation',
      ledger_id: deterministicMigrationId('ledger'),
      outbox_id: deterministicMigrationId('outbox'),
      outbox_payload: {
        eventId,
        eventType: 'WorldSimulationInitializedV1',
        worldEventSequence: '2',
        worldId,
      },
      status: 'accepted',
    });
    await expect(
      owner.pool.query(`select worldgraph_assert_command_terminal($1)`, [commandId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      owner.pool.query(`select worldgraph_assert_simulation_command_terminal($1)`, [commandId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      owner.pool.query(`select worldgraph_assert_active_world_simulation($1)`, [worldId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    const gateOwners = await owner.pool.query<{ function_name: string; owner_name: string }>(
      `select procedure.proname function_name,
              pg_catalog.pg_get_userbyid(procedure.proowner) owner_name
         from pg_catalog.pg_proc procedure
        where procedure.oid in (
          'public.worldgraph_open_command_write(uuid,uuid)'::regprocedure,
          'public.worldgraph_open_command_write_m06(uuid,uuid)'::regprocedure
        )
        order by procedure.proname`,
    );
    expect(new Set(gateOwners.rows.map((row) => row.owner_name)).size).toBe(1);

    const checkpoints = await owner.pool.query<{
      checksum_matches: boolean;
      last_event_sequence: string;
      projection_name: string;
    }>(
      `select checkpoint.projection_name,checkpoint.last_event_sequence::text,
        case when checkpoint.projection_name='simulation_runtime'
          then checkpoint.checksum=worldgraph_simulation_projection_checksum($1)
          else checkpoint.checksum=worldgraph_projection_checksum($1,2)
        end checksum_matches
       from projection_checkpoints checkpoint where checkpoint.world_id=$1
       order by checkpoint.projection_name`,
      [worldId],
    );
    expect(checkpoints.rows).toEqual([
      { checksum_matches: true, last_event_sequence: '2', projection_name: 'simulation_runtime' },
      { checksum_matches: true, last_event_sequence: '2', projection_name: 'world_graph' },
    ]);
    const advances = await owner.pool.query<{ count: string }>(
      `select count(*)::text count from domain_events
       where world_id=$1 and event_type='SimulationAdvancedV1'`,
      [worldId],
    );
    expect(advances.rows[0]?.count).toBe('0');
  });

  it('matches the JavaScript initial cumulative outcome hash vector exactly', async () => {
    const seed = 'world.seed:Vector_01';
    const sql = await owner.pool.query<{ outcome_hash: string }>(
      `select encode(worldgraph_initial_simulation_outcome_hash_v1($1),'hex') outcome_hash`,
      [seed],
    );
    expect(javascriptInitialSimulationOutcomeHashV1(seed)).toBe(
      'bfce58a772a1767836158896409d0b07857f59d3a317cfc0568bf06ba6f8b2d1',
    );
    expect(sql.rows[0]?.outcome_hash).toBe(javascriptInitialSimulationOutcomeHashV1(seed));
  });

  it('rejects JSONB numeric spellings that compare equal but hash differently', async () => {
    const numeric = await owner.pool.query<{
      canonical_integer: string;
      canonical_scaled: string;
      integer_is_canonical: boolean;
      jsonb_equal: boolean;
      scaled_is_canonical: boolean;
    }>(
      `select
         '1'::jsonb = '1.0'::jsonb jsonb_equal,
         worldgraph_canonical_jsonb('1'::jsonb) canonical_integer,
         worldgraph_canonical_jsonb('1.0'::jsonb) canonical_scaled,
         worldgraph_jsonb_numbers_are_canonical_integers('1'::jsonb) integer_is_canonical,
         worldgraph_jsonb_numbers_are_canonical_integers('1.0'::jsonb) scaled_is_canonical`,
    );
    expect(numeric.rows[0]).toEqual({
      canonical_integer: '1',
      canonical_scaled: '1.0',
      integer_is_canonical: true,
      jsonb_equal: true,
      scaled_is_canonical: false,
    });
  });

  it('falls back atomically when an upgraded compiled clock cannot render its first tick', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update world_entities
            set state=jsonb_set(state,'{settings}',$2::jsonb)
          where id=$1`,
        [
          simulationEntityId,
          {
            epochAt: '9999-12-31T23:59:59.999Z',
            worldMillisecondsPerTick: 1,
          },
        ],
      );
      const exhausted = await connection.query<{ resolved: Record<string, unknown> }>(
        `select worldgraph_resolve_simulation_clock_config($1) resolved`,
        [worldId],
      );
      expect(exhausted.rows[0]?.resolved).toMatchObject({
        configuration: {
          epochAt: '2000-01-01T00:00:00.000Z',
          worldMillisecondsPerTick: 86_400_000,
        },
        provenance: 'm07_default',
      });

      await connection.query(
        `update world_entities set state=jsonb_set(state,'{settings}','{}'::jsonb) where id=$1`,
        [simulationEntityId],
      );
      await connection.query(
        `update world_entities
         set state=jsonb_set(state,'{parameters,tickDurationSeconds}','0'::jsonb)
         where id=$1`,
        [clockPrimitiveEntityId],
      );
      const resolved = await connection.query<{ resolved: Record<string, unknown> }>(
        `select worldgraph_resolve_simulation_clock_config($1) resolved`,
        [worldId],
      );
      expect(resolved.rows[0]?.resolved).toEqual({
        configuration: {
          epochAt: '2000-01-01T00:00:00.000Z',
          maxBatchTicks: 64,
          maxCatchUpTicks: 256,
          prngAlgorithmVersion: 'xorshift32-sha256-v1',
          wallCadenceMilliseconds: 10_000,
          worldMillisecondsPerTick: 86_400_000,
        },
        provenance: 'm07_default',
      });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('rejects a forged primary aggregate version at the simulation terminal guard', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(`update domain_events set aggregate_version=2 where id=$1`, [
        deterministicMigrationId('event'),
      ]);
      await expect(
        connection.query(`select worldgraph_assert_simulation_command_terminal($1)`, [
          deterministicMigrationId('command'),
        ]),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('binds every event ordinal to its exact opened world-sequence position', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      const commandId = '078f0000-0000-7000-8000-000000000785';
      const eventId = '078f0000-0000-7000-8000-000000000786';
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           opened_state_revision,opened_ledger_sequence,opened_event_sequence,
           opened_projection_checksum,write_gate_opened_at,status,authorization_rule_id,
           correlation_id,requested_at,decided_at,resulting_state_revision,response_summary
         ) values (
           $1::uuid,$2::uuid,'TestSequenceBindingV1',1,
           'system','worldgraph:sequence-binding-test',null,
           extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
           'member','m07-sequence-binding',
           extensions.digest(convert_to('m07-sequence-binding','UTF8'),'sha256'),
           2,2,2,null,date_trunc('milliseconds',transaction_timestamp()),
           'accepted','system.test.sequence_binding',$1::uuid,
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp()),3,
           jsonb_build_object(
             'commandId',$1::uuid::text,'eventIds',jsonb_build_array($3::uuid::text),
             'resultingStateRevision','3','schemaVersion',1,'status','accepted'
           )
         )`,
        [commandId, worldId, eventId],
      );
      await connection.query(
        `alter table domain_events
           enable always trigger domain_events_require_simulation_fact`,
      );
      await connection.query(
        `insert into domain_events(
           id,world_id,world_event_sequence,command_id,event_ordinal,
           aggregate_type,aggregate_id,aggregate_version,event_type,
           event_schema_version,payload,metadata,event_hash,occurred_at,
           recorded_at,resulting_state_revision
         ) values (
           $1::uuid,$2::uuid,3,$3::uuid,1,'test_projection',$3::uuid::text,1,
           'TestSequencePositionedV1',1,
           '{}','{}',extensions.digest(convert_to('m07-sequence-event','UTF8'),'sha256'),
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp()),3
         )`,
        [eventId, worldId, commandId],
      );
      await expect(
        connection.query(`set constraints domain_events_require_simulation_fact immediate`),
      ).rejects.toMatchObject({
        code: '55000',
        message: 'event ordinal must match its exact command world-sequence position',
      });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('recognizes the contract-correct auto-pause command as a clock aggregate command', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(`update command_records set command_type=$2 where id=$1`, [
        deterministicMigrationId('command'),
        'AutoPauseWorldClockV1',
      ]);
      await expect(
        connection.query(`select worldgraph_assert_simulation_command_terminal($1)`, [
          deterministicMigrationId('command'),
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await connection.query(
        `update domain_events set aggregate_type='scheduled_action' where id=$1`,
        [deterministicMigrationId('event')],
      );
      await expect(
        connection.query(`select worldgraph_assert_simulation_command_terminal($1)`, [
          deterministicMigrationId('command'),
        ]),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('keeps upgrade and initialization idempotent at the deterministic identities', async () => {
    await migrate(owner.db, { migrationsFolder: migrationRoot });
    const counts = await owner.pool.query<{
      clocks: string;
      commands: string;
      events: string;
      heads: string;
      init_events: string;
      outbox: string;
    }>(
      `select
        (select count(*)::text from world_simulation_clocks where world_id=$1) clocks,
        (select count(*)::text from world_schedule_heads where world_id=$1) heads,
        (select count(*)::text from command_records where world_id=$1) commands,
        (select count(*)::text from domain_events where world_id=$1) events,
        (select count(*)::text from domain_events where world_id=$1
          and event_type='WorldSimulationInitializedV1') init_events,
        (select count(*)::text from outbox_messages where world_id=$1) outbox`,
      [worldId],
    );
    expect(counts.rows[0]).toEqual({
      clocks: '1',
      commands: '2',
      events: '2',
      heads: '1',
      init_events: '1',
      outbox: '2',
    });
  });

  it('allocates schedule sequence deterministically and exposes the exact due order', async () => {
    const commandId = '078f0000-0000-7000-8000-000000000711';
    const connection = await app.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(
        `insert into command_records(
          id,world_id,command_type,command_schema_version,actor_type,actor_id,
          payload,payload_hash,payload_classification,idempotency_key,request_hash,
          expected_world_version,expected_state_revision,expected_aggregate_version,
          correlation_id,requested_at
        ) values (
          $1,$2,'ScheduleWorldNoticeV1',1,'user',$3,'{}',
          extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
          'member','m07-order-command',
          extensions.digest(convert_to('m07-order-command','UTF8'),'sha256'),
          1,2,1,$1,date_trunc('milliseconds',transaction_timestamp())
        )`,
        [commandId, worldId, creatorId],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
      const requested = [
        { dueTick: 3, id: '078f0000-0000-7000-8000-000000000721', priority: 5 },
        { dueTick: 2, id: '078f0000-0000-7000-8000-000000000722', priority: 10 },
        { dueTick: 3, id: '078f0000-0000-7000-8000-000000000723', priority: -1 },
      ];
      const allocated: string[] = [];
      for (const action of requested) {
        const sequence = await connection.query<{ sequence: string }>(
          `select worldgraph_allocate_schedule_sequence($1)::text sequence`,
          [worldId],
        );
        allocated.push(sequence.rows[0]!.sequence);
        await connection.query(
          `insert into scheduled_actions(
            id,world_id,schedule_sequence,due_tick,priority,action_type,
            action_schema_version,payload,payload_hash,process_version,
            created_by_actor_type,created_by_actor_id,created_command_id,
            created_state_revision,created_at,updated_at
          ) values (
            $1,$2,$3,$4,$5,'EmitWorldNoticeV1',1,$6,
            extensions.digest(convert_to(worldgraph_canonical_jsonb($6),'UTF8'),'sha256'),
            '1.0.0','user',$7,$8,3,
            date_trunc('milliseconds',transaction_timestamp()),
            date_trunc('milliseconds',transaction_timestamp())
          )`,
          [
            action.id,
            worldId,
            sequence.rows[0]!.sequence,
            action.dueTick,
            action.priority,
            { text: `Notice ${action.id.at(-1)}`, visibility: 'member' },
            creatorId,
            commandId,
          ],
        );
      }
      expect(allocated).toEqual(['1', '2', '3']);
      const due = await connection.query<{ id: string }>(
        `select id from scheduled_actions where world_id=$1 and status='scheduled'
         order by due_tick,priority,schedule_sequence,id`,
        [worldId],
      );
      expect(due.rows.map((row) => row.id)).toEqual([
        requested[1]!.id,
        requested[2]!.id,
        requested[0]!.id,
      ]);
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
    const head = await owner.pool.query<{ next_schedule_sequence: string }>(
      `select next_schedule_sequence::text from world_schedule_heads where world_id=$1`,
      [worldId],
    );
    expect(head.rows[0]?.next_schedule_sequence).toBe('1');
  });

  it('enforces the database schedule capacity at every due tick', async () => {
    const commandId = '078f0000-0000-7000-8000-000000000712';
    const connection = await app.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(
        `insert into command_records(
          id,world_id,command_type,command_schema_version,actor_type,actor_id,
          payload,payload_hash,payload_classification,idempotency_key,request_hash,
          expected_world_version,expected_state_revision,expected_aggregate_version,
          correlation_id,requested_at
        ) values (
          $1,$2,'ScheduleWorldNoticeV1',1,'user',$3,'{}',
          extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
          'member','m09-capacity-command',
          extensions.digest(convert_to('m09-capacity-command','UTF8'),'sha256'),
          1,2,1,$1,date_trunc('milliseconds',transaction_timestamp())
        )`,
        [commandId, worldId, creatorId],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
      const insertAtCapacity = async (ordinal: number) => {
        const sequence = await connection.query<{ sequence: string }>(
          `select worldgraph_allocate_schedule_sequence($1)::text sequence`,
          [worldId],
        );
        const actionId = `078f0000-0000-7000-8000-${String(800 + ordinal).padStart(12, '0')}`;
        const payload = { text: `Capacity notice ${ordinal}`, visibility: 'member' };
        return connection.query(
          `insert into scheduled_actions(
            id,world_id,schedule_sequence,due_tick,priority,action_type,
            action_schema_version,payload,payload_hash,process_version,
            created_by_actor_type,created_by_actor_id,created_command_id,
            created_state_revision,created_at,updated_at
          ) values (
            $1,$2,$3,10,0,'EmitWorldNoticeV1',1,$4,
            extensions.digest(convert_to(worldgraph_canonical_jsonb($4),'UTF8'),'sha256'),
            '1.0.0','user',$5,$6,3,
            date_trunc('milliseconds',transaction_timestamp()),
            date_trunc('milliseconds',transaction_timestamp())
          )`,
          [actionId, worldId, sequence.rows[0]!.sequence, payload, creatorId, commandId],
        );
      };
      for (let ordinal = 1; ordinal <= 31; ordinal += 1) {
        await insertAtCapacity(ordinal);
      }
      await expect(insertAtCapacity(32)).rejects.toMatchObject({
        code: '54000',
        constraint: 'scheduled_action_capacity_bounded',
      });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('binds schedule allocation to exact commands and rolls rejected gaps back atomically', async () => {
    const footprint = async () => {
      const result = await owner.pool.query<{
        actions: string;
        batches: string;
        checkpoint_checksum: string;
        events: string;
        next_schedule_sequence: string;
      }>(
        `select
          schedule.next_schedule_sequence::text,
          encode(checkpoint.checksum,'hex') checkpoint_checksum,
          (select count(*)::text from scheduled_actions action where action.world_id=$1) actions,
          (select count(*)::text from simulation_batch_runs batch where batch.world_id=$1) batches,
          (select count(*)::text from domain_events event where event.world_id=$1) events
         from world_schedule_heads schedule
         join projection_checkpoints checkpoint on checkpoint.world_id=schedule.world_id
          and checkpoint.projection_name='simulation_runtime'
         where schedule.world_id=$1`,
        [worldId],
      );
      return result.rows[0];
    };
    const before = await footprint();

    const wrongType = await app.pool.connect();
    try {
      await wrongType.query('begin');
      const commandId = '078f0000-0000-7000-8000-000000000760';
      await wrongType.query(
        `insert into command_records(
          id,world_id,command_type,command_schema_version,actor_type,actor_id,
          payload,payload_hash,payload_classification,idempotency_key,request_hash,
          expected_world_version,expected_state_revision,correlation_id,requested_at
        ) values (
          $1,$2,'RenameWorldV1',1,'system','worldgraph:schedule-guard-test','{}',
          extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
          'member','m07-wrong-schedule-command',
          extensions.digest(convert_to('m07-wrong-schedule-command','UTF8'),'sha256'),
          1,2,$1,date_trunc('milliseconds',transaction_timestamp())
        )`,
        [commandId, worldId],
      );
      await wrongType.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);

      const rejectAtSavepoint = async (savepoint: string, statement: string, values: unknown[]) => {
        await wrongType.query(`savepoint ${savepoint}`);
        await expect(wrongType.query(statement, values)).rejects.toMatchObject({ code: '55000' });
        await wrongType.query(`rollback to savepoint ${savepoint}`);
      };
      await rejectAtSavepoint(
        'wrong_schedule_allocator',
        `select worldgraph_allocate_schedule_sequence($1)`,
        [worldId],
      );
      await wrongType.query(`select set_config('worldgraph.schedule_world_id',$1,true)`, [worldId]);
      await wrongType.query(`select set_config('worldgraph.schedule_sequence','1',true)`);
      await rejectAtSavepoint(
        'wrong_schedule_insert',
        `insert into scheduled_actions(
          id,world_id,schedule_sequence,due_tick,priority,action_type,
          action_schema_version,payload,payload_hash,process_version,
          created_by_actor_type,created_by_actor_id,created_command_id,
          created_state_revision,created_at,updated_at
        ) values (
          '078f0000-0000-7000-8000-000000000762',$1,1,1,0,'EmitWorldNoticeV1',1,
          '{"text":"forged","visibility":"member"}'::jsonb,
          extensions.digest(convert_to(worldgraph_canonical_jsonb(
            '{"text":"forged","visibility":"member"}'::jsonb
          ),'UTF8'),'sha256'),
          '1.0.0','system','worldgraph:schedule-guard-test',$2,3,now(),now()
        )`,
        [worldId, commandId],
      );
      await rejectAtSavepoint(
        'wrong_batch_insert',
        `insert into simulation_batch_runs(
          id,world_id,from_tick,to_tick,batch_key,process_registry_version,
          input_checksum,attempts,started_at
        ) values (
          '078f0000-0000-7000-8000-000000000763',$1,10,11,
          extensions.digest(convert_to('wrong-command-batch','UTF8'),'sha256'),1,
          extensions.digest(convert_to('wrong-command-input','UTF8'),'sha256'),1,now()
        )`,
        [worldId],
      );
    } finally {
      await wrongType.query('rollback').catch(() => undefined);
      wrongType.release();
    }

    const rejected = await app.pool.connect();
    try {
      await rejected.query('begin');
      const commandId = '078f0000-0000-7000-8000-000000000761';
      await rejected.query(
        `insert into command_records(
          id,world_id,command_type,command_schema_version,actor_type,actor_id,
          payload,payload_hash,payload_classification,idempotency_key,request_hash,
          expected_world_version,expected_state_revision,expected_aggregate_version,
          correlation_id,requested_at
        ) values (
          $1,$2,'ScheduleWorldNoticeV1',1,'user',$3,'{}',
          extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
          'member','m07-rejected-schedule-gap',
          extensions.digest(convert_to('m07-rejected-schedule-gap','UTF8'),'sha256'),
          1,2,0,$1,date_trunc('milliseconds',transaction_timestamp())
        )`,
        [commandId, worldId, creatorId],
      );
      await rejected.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
      await expect(
        rejected.query<{ sequence: string }>(
          `select worldgraph_allocate_schedule_sequence($1)::text sequence`,
          [worldId],
        ),
      ).resolves.toMatchObject({ rows: [{ sequence: '1' }] });
      await rejected.query(
        `update command_records
            set status='rejected',rejection_code='VALIDATION_FAILED',
                authorization_rule_id='world.schedule',
                decided_at=date_trunc('milliseconds',transaction_timestamp()),
                response_summary=jsonb_build_object(
                  'commandId',$1::text,'eventIds','[]'::jsonb,
                  'rejectionCode','VALIDATION_FAILED','schemaVersion',1,'status','rejected'
                )
          where id=$1`,
        [commandId],
      );
      await expect(
        rejected.query(`set constraints world_schedule_heads_require_contiguous_actions immediate`),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await rejected.query('rollback').catch(() => undefined);
      rejected.release();
    }

    expect(await footprint()).toEqual(before);
  });

  it('rejects an advance-created action that is not future from the final clock', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(`set local role worldgraph_app`);
      const commandId = '078f0000-0000-7000-8000-000000000764';
      const actionId = '078f0000-0000-7000-8000-000000000765';
      const eventId = '078f0000-0000-7000-8000-000000000766';
      const primaryEventId = '078f0000-0000-7000-8000-000000000784';
      const actionPayload = { text: 'same-batch forged notice', visibility: 'member' };
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_world_version,expected_state_revision,expected_aggregate_version,
           correlation_id,requested_at
         ) values (
           $1,$2,'AdvanceSimulationV1',1,'system','worldgraph:advance-fact-test',null,
           extensions.digest(convert_to(worldgraph_canonical_jsonb('{"ticks":1}'::jsonb),'UTF8'),'sha256'),
           'member','m07-advance-created-not-future',
           extensions.digest(convert_to('m07-advance-created-not-future','UTF8'),'sha256'),
           1,2,1,$1,date_trunc('milliseconds',transaction_timestamp())
         )`,
        [commandId, worldId],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
      await connection.query(
        `update command_records
            set status='accepted',authorization_rule_id='system.simulation.advance',
                decided_at=date_trunc('milliseconds',transaction_timestamp()),
                resulting_state_revision=3,
                response_summary=jsonb_build_object(
                  'commandId',$1::text,'eventIds',jsonb_build_array($2::text),
                  'resultingStateRevision','3','schemaVersion',1,'status','accepted'
                )
          where id=$1`,
        [commandId, eventId],
      );
      await connection.query(
        `insert into scheduled_actions(
           id,world_id,schedule_sequence,due_tick,priority,action_type,
           action_schema_version,payload,payload_hash,process_version,
           created_by_actor_type,created_by_actor_id,created_command_id,
           created_state_revision,created_at,updated_at
         ) values (
           $1,$2,1,1,0,'EmitWorldNoticeV1',1,$3,
           extensions.digest(convert_to(worldgraph_canonical_jsonb($3),'UTF8'),'sha256'),
           '1.0.0','system','worldgraph:advance-fact-test',$4,3,
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp())
         )`,
        [actionId, worldId, actionPayload, commandId],
      );
      await connection.query(
        `update world_simulation_clocks
            set current_tick=1,row_version=row_version+1,updated_state_revision=3,
                updated_at=date_trunc('milliseconds',transaction_timestamp())
          where world_id=$1`,
        [worldId],
      );
      await connection.query(
        `insert into domain_events(
           id,world_id,world_event_sequence,command_id,event_ordinal,
           aggregate_type,aggregate_id,aggregate_version,event_type,
           event_schema_version,payload,metadata,event_hash,occurred_at,
           recorded_at,resulting_state_revision
         ) values (
           $1::uuid,$2::uuid,3,$3::uuid,0,'simulation_clock',$2::uuid::text,2,
           'SimulationAdvancedV1',1,
           '{}','{}',extensions.digest(convert_to('m07-forged-primary-event','UTF8'),'sha256'),
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp()),3
         )`,
        [primaryEventId, worldId, commandId],
      );
      await connection.query(`reset role`);
      await connection.query(
        `alter table domain_events
           enable always trigger domain_events_require_simulation_fact`,
      );
      await connection.query(`set local role worldgraph_app`);
      await connection.query(
        `insert into domain_events(
           id,world_id,world_event_sequence,command_id,event_ordinal,
           aggregate_type,aggregate_id,aggregate_version,event_type,
           event_schema_version,payload,metadata,event_hash,occurred_at,
           recorded_at,resulting_state_revision
         ) values (
           $1::uuid,$2::uuid,4,$3::uuid,1,'scheduled_action',$4::uuid::text,1,
           'ScheduledActionCreatedV1',1,
           jsonb_build_object(
             'actionSchemaVersion',1,'actionType','EmitWorldNoticeV1','dueTick','1',
             'payload',$5::jsonb,'payloadHash',encode(extensions.digest(convert_to(
               worldgraph_canonical_jsonb($5::jsonb),'UTF8'),'sha256'),'hex'),
             'priority',0,'processVersion','1.0.0','scheduleId',$4::uuid::text,
             'scheduleSequence','1'
           ),
           jsonb_build_object(
             'actor',jsonb_build_object(
               'actorId','worldgraph:advance-fact-test','actorType','system'
             ),
             'authorizationRuleId','system.simulation.advance','causationId',null,
             'commandSchemaVersion',1,'commandType','AdvanceSimulationV1',
             'correlationId',$3::uuid::text,'overrideId',null,
             'payloadClassification','member'
           ),
           extensions.digest(convert_to('m07-forged-created-event','UTF8'),'sha256'),
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp()),3
         )`,
        [eventId, worldId, commandId, actionId, actionPayload],
      );
      await expect(
        connection.query(`set constraints domain_events_require_simulation_fact immediate`),
      ).rejects.toMatchObject({
        code: '55000',
        message: 'schedule creation event has no exact action fact',
      });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
    await expect(
      owner.pool.query(`select count(*)::text count from scheduled_actions where id=$1`, [
        '078f0000-0000-7000-8000-000000000765',
      ]),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] });
  });

  it('rejects an EmitWorldNotice failure without its exact scheduled action', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(
        `alter table simulation_failures
           enable always trigger simulation_failures_require_accepted_command`,
      );
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(`set local role worldgraph_app`);
      const commandId = '078f0000-0000-7000-8000-000000000767';
      const batchId = '078f0000-0000-7000-8000-000000000768';
      const failureId = '078f0000-0000-7000-8000-000000000769';
      const eventId = '078f0000-0000-7000-8000-000000000770';
      const scheduleId = '078f0000-0000-7000-8000-000000000771';
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_world_version,expected_state_revision,expected_aggregate_version,
           correlation_id,requested_at
         ) values (
           $1,$2,'AutoPauseWorldClockV1',1,'system','worldgraph:failure-fact-test',null,
           extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
             'errorCode','SIMULATION_HANDLER_FAILED','failureId',$3::text
           )),'UTF8'),'sha256'),
           'member','m07-null-notice-failure',
           extensions.digest(convert_to('m07-null-notice-failure','UTF8'),'sha256'),
           1,2,1,$1,date_trunc('milliseconds',transaction_timestamp())
         )`,
        [commandId, worldId, failureId],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
      await connection.query(
        `insert into simulation_batch_runs(
           id,world_id,batch_schema_version,from_tick,to_tick,batch_key,
           process_registry_version,input_checksum,attempts,status,error_code,
           started_at,completed_at
         ) values (
           $1,$2,1,0,1,
           extensions.digest(convert_to('m07-null-failure-batch','UTF8'),'sha256'),1,
           extensions.digest(convert_to('m07-null-failure-input','UTF8'),'sha256'),
           1,'failed','SIMULATION_HANDLER_FAILED',
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp())
         )`,
        [batchId, worldId],
      );
      await connection.query(
        `insert into scheduled_actions(
           id,world_id,schedule_sequence,due_tick,priority,action_type,
           action_schema_version,payload,payload_hash,process_version,
           created_by_actor_type,created_by_actor_id,created_command_id,
           created_state_revision,created_at,updated_at
         ) values (
           $1,$2,997,2,0,'EmitWorldNoticeV1',1,$3,
           extensions.digest(convert_to(worldgraph_canonical_jsonb($3::jsonb),'UTF8'),'sha256'),
           '1.0.0','system','worldgraph:failure-fact-test',$4,2,
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp())
         )`,
        [
          scheduleId,
          worldId,
          { text: 'Mismatched due tick fixture.', visibility: 'member' },
          commandId,
        ],
      );
      await connection.query(
        `insert into simulation_failures(
           id,world_id,failure_schema_version,batch_run_id,tick,schedule_id,
           process_type,process_version,error_code,redacted_context,attempts,opened_at
         ) values (
           $1,$2,1,$3,1,$4,'EmitWorldNoticeV1','1.0.0',
           'SIMULATION_HANDLER_FAILED','{}',1,
           date_trunc('milliseconds',transaction_timestamp())
         )`,
        [failureId, worldId, batchId, scheduleId],
      );
      await connection.query(
        `insert into domain_events(
           id,world_id,world_event_sequence,command_id,event_ordinal,
           aggregate_type,aggregate_id,aggregate_version,event_type,
           event_schema_version,payload,metadata,event_hash,occurred_at,
           recorded_at,resulting_state_revision
         ) values (
           $1,$2,998,$3::uuid,1,'simulation_failure',$4,1,
           'SimulationFailureRecordedV1',1,
           jsonb_build_object(
             'attempts',1,'batchRunId',$5::text,'errorCode','SIMULATION_HANDLER_FAILED',
             'failureId',$4::text,'processType','EmitWorldNoticeV1',
             'processVersion','1.0.0','scheduleId',$6::uuid::text,'tick','1'
           ),
           jsonb_build_object(
             'actor',jsonb_build_object(
               'actorId','worldgraph:failure-fact-test','actorType','system'
             ),
             'authorizationRuleId','system.simulation.auto_pause','causationId',null,
             'commandSchemaVersion',1,'commandType','AutoPauseWorldClockV1',
             'correlationId',$3::text,'overrideId',null,'payloadClassification','member'
           ),
           extensions.digest(convert_to('m07-null-failure-event','UTF8'),'sha256'),
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp()),3
         )`,
        [eventId, worldId, commandId, failureId, batchId, scheduleId],
      );
      await connection.query(
        `update command_records
            set status='accepted',authorization_rule_id='system.simulation.auto_pause',
                decided_at=date_trunc('milliseconds',transaction_timestamp()),
                resulting_state_revision=3,
                response_summary=jsonb_build_object(
                  'commandId',$1::text,'eventIds',jsonb_build_array($2::text),
                  'resultingStateRevision','3','schemaVersion',1,'status','accepted'
                )
          where id=$1`,
        [commandId, eventId],
      );
      await expect(
        connection.query(`set constraints simulation_failures_require_accepted_command immediate`),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('rejects a later failure when its reused batch attempts were not advanced', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(
        `alter table simulation_failures
           enable always trigger simulation_failures_require_accepted_command`,
      );
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(`set local role worldgraph_app`);
      const firstCommandId = '078f0000-0000-7000-8000-000000000777';
      const secondCommandId = '078f0000-0000-7000-8000-000000000778';
      const batchId = '078f0000-0000-7000-8000-000000000779';
      const firstFailureId = '078f0000-0000-7000-8000-000000000780';
      const secondFailureId = '078f0000-0000-7000-8000-000000000781';
      const firstEventId = '078f0000-0000-7000-8000-000000000782';
      const secondEventId = '078f0000-0000-7000-8000-000000000783';
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_world_version,expected_state_revision,expected_aggregate_version,
           correlation_id,requested_at
         ) values
         ($1,$3,'AutoPauseWorldClockV1',1,'system','worldgraph:attempt-fact-test',null,
          extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
            'errorCode','SIMULATION_INTEGER_OVERFLOW','failureId',$4::text
          )),'UTF8'),'sha256'),'member','m07-attempt-first',
          extensions.digest(convert_to('m07-attempt-first','UTF8'),'sha256'),
          1,2,1,$1,date_trunc('milliseconds',transaction_timestamp())),
         ($2,$3,'AutoPauseWorldClockV1',1,'system','worldgraph:attempt-fact-test',null,
          extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
            'errorCode','SIMULATION_INTEGER_OVERFLOW','failureId',$5::text
          )),'UTF8'),'sha256'),'member','m07-attempt-second',
          extensions.digest(convert_to('m07-attempt-second','UTF8'),'sha256'),
          1,2,1,$2,date_trunc('milliseconds',transaction_timestamp()))`,
        [firstCommandId, secondCommandId, worldId, firstFailureId, secondFailureId],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [
        firstCommandId,
        worldId,
      ]);
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [
        secondCommandId,
        worldId,
      ]);
      await connection.query(
        `insert into simulation_batch_runs(
           id,world_id,batch_schema_version,from_tick,to_tick,batch_key,
           process_registry_version,input_checksum,attempts,status,error_code,
           started_at,completed_at
         ) values (
           $1,$2,1,0,0,
           extensions.digest(convert_to('m07-stale-attempt-batch','UTF8'),'sha256'),1,
           extensions.digest(convert_to('m07-stale-attempt-input','UTF8'),'sha256'),
           1,'failed','SIMULATION_INTEGER_OVERFLOW',
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp())
         )`,
        [batchId, worldId],
      );
      await connection.query(
        `insert into simulation_failures(
           id,world_id,failure_schema_version,batch_run_id,tick,schedule_id,
           process_type,process_version,error_code,redacted_context,attempts,opened_at
         ) values
         ($1,$3,1,$4,0,null,'WorldClockV1','1.0.0',
          'SIMULATION_INTEGER_OVERFLOW','{}',1,
          date_trunc('milliseconds',transaction_timestamp())),
         ($2,$3,1,$4,0,null,'WorldClockV1','1.0.0',
          'SIMULATION_INTEGER_OVERFLOW','{}',1,
          date_trunc('milliseconds',transaction_timestamp()))`,
        [firstFailureId, secondFailureId, worldId, batchId],
      );
      await connection.query(
        `insert into domain_events(
           id,world_id,world_event_sequence,command_id,event_ordinal,
           aggregate_type,aggregate_id,aggregate_version,event_type,
           event_schema_version,payload,metadata,event_hash,occurred_at,
           recorded_at,resulting_state_revision
         ) values
         ($1,$3,995,$4::uuid,1,'simulation_failure',$5,1,
          'SimulationFailureRecordedV1',1,jsonb_build_object(
            'attempts',1,'batchRunId',$6::text,'errorCode','SIMULATION_INTEGER_OVERFLOW',
            'failureId',$5::text,'processType','WorldClockV1','processVersion','1.0.0',
            'scheduleId',null,'tick','0'
          ),'{}',extensions.digest(convert_to('m07-attempt-event-first','UTF8'),'sha256'),
          date_trunc('milliseconds',transaction_timestamp()),
          date_trunc('milliseconds',transaction_timestamp()),3),
         ($2,$3,994,$7::uuid,1,'simulation_failure',$8,1,
          'SimulationFailureRecordedV1',1,jsonb_build_object(
            'attempts',1,'batchRunId',$6::text,'errorCode','SIMULATION_INTEGER_OVERFLOW',
            'failureId',$8::text,'processType','WorldClockV1','processVersion','1.0.0',
            'scheduleId',null,'tick','0'
          ),'{}',extensions.digest(convert_to('m07-attempt-event-second','UTF8'),'sha256'),
          date_trunc('milliseconds',transaction_timestamp()),
          date_trunc('milliseconds',transaction_timestamp()),3)`,
        [
          firstEventId,
          secondEventId,
          worldId,
          firstCommandId,
          firstFailureId,
          batchId,
          secondCommandId,
          secondFailureId,
        ],
      );
      await connection.query(
        `update command_records
            set status='accepted',authorization_rule_id='system.simulation.auto_pause',
                decided_at=date_trunc('milliseconds',transaction_timestamp()),
                resulting_state_revision=3,response_summary=jsonb_build_object(
                  'commandId',id::text,'eventIds',jsonb_build_array(
                    case when id=$1 then $3::text else $4::text end
                  ),'resultingStateRevision','3','schemaVersion',1,'status','accepted'
                )
          where id in ($1,$2)`,
        [firstCommandId, secondCommandId, firstEventId, secondEventId],
      );
      await expect(
        connection.query(`set constraints simulation_failures_require_accepted_command immediate`),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('rejects failure resolution that leaves the live clock in error', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(
        `alter table simulation_failures
           enable always trigger simulation_failures_require_accepted_command`,
      );
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(`set local role worldgraph_app`);
      const autoPauseCommandId = '078f0000-0000-7000-8000-000000000771';
      const resolveCommandId = '078f0000-0000-7000-8000-000000000772';
      const batchId = '078f0000-0000-7000-8000-000000000773';
      const failureId = '078f0000-0000-7000-8000-000000000774';
      const recordedEventId = '078f0000-0000-7000-8000-000000000775';
      const resolvedEventId = '078f0000-0000-7000-8000-000000000776';
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_world_version,expected_state_revision,expected_aggregate_version,
           correlation_id,requested_at
         ) values
         (
           $1,$3,'AutoPauseWorldClockV1',1,'system','worldgraph:resolve-fact-test',null,
           extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
             'errorCode','SIMULATION_INTEGER_OVERFLOW','failureId',$4::text
           )),'UTF8'),'sha256'),
           'member','m07-resolve-auto-pause',
           extensions.digest(convert_to('m07-resolve-auto-pause','UTF8'),'sha256'),
           1,2,1,$1,date_trunc('milliseconds',transaction_timestamp())
         ),
         (
           $2,$3,'ResolveSimulationFailureV1',1,'user',$5,null,
           extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
             'failureId',$4::text,'resolution','retry_after_repair'
           )),'UTF8'),'sha256'),
           'member','m07-resolve-without-clock',
           extensions.digest(convert_to('m07-resolve-without-clock','UTF8'),'sha256'),
           1,3,1,$2,date_trunc('milliseconds',transaction_timestamp())
         )`,
        [autoPauseCommandId, resolveCommandId, worldId, failureId, creatorId],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [
        autoPauseCommandId,
        worldId,
      ]);
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [
        resolveCommandId,
        worldId,
      ]);
      await connection.query(
        `insert into simulation_batch_runs(
           id,world_id,batch_schema_version,from_tick,to_tick,batch_key,
           process_registry_version,input_checksum,attempts,status,error_code,
           started_at,completed_at
         ) values (
           $1,$2,1,0,0,
           extensions.digest(convert_to('m07-resolve-batch','UTF8'),'sha256'),1,
           extensions.digest(convert_to('m07-resolve-input','UTF8'),'sha256'),
           1,'failed','SIMULATION_INTEGER_OVERFLOW',
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp())
         )`,
        [batchId, worldId],
      );
      await connection.query(
        `insert into simulation_failures(
           id,world_id,failure_schema_version,batch_run_id,tick,schedule_id,
           process_type,process_version,error_code,redacted_context,attempts,opened_at
         ) values (
           $1,$2,1,$3,0,null,'WorldClockV1','1.0.0',
           'SIMULATION_INTEGER_OVERFLOW','{}',1,
           date_trunc('milliseconds',transaction_timestamp())
         )`,
        [failureId, worldId, batchId],
      );
      await connection.query(
        `insert into domain_events(
           id,world_id,world_event_sequence,command_id,event_ordinal,
           aggregate_type,aggregate_id,aggregate_version,event_type,
           event_schema_version,payload,metadata,event_hash,occurred_at,
           recorded_at,resulting_state_revision
         ) values (
           $1,$2,997,$3::uuid,1,'simulation_failure',$4,1,
           'SimulationFailureRecordedV1',1,
           jsonb_build_object(
             'attempts',1,'batchRunId',$5::text,'errorCode','SIMULATION_INTEGER_OVERFLOW',
             'failureId',$4::text,'processType','WorldClockV1','processVersion','1.0.0',
             'scheduleId',null,'tick','0'
           ),
           jsonb_build_object(
             'actor',jsonb_build_object(
               'actorId','worldgraph:resolve-fact-test','actorType','system'
             ),
             'authorizationRuleId','system.simulation.auto_pause','causationId',null,
             'commandSchemaVersion',1,'commandType','AutoPauseWorldClockV1',
             'correlationId',$3::text,'overrideId',null,'payloadClassification','member'
           ),
           extensions.digest(convert_to('m07-resolve-recorded-event','UTF8'),'sha256'),
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp()),3
         )`,
        [recordedEventId, worldId, autoPauseCommandId, failureId, batchId],
      );
      await connection.query(
        `update world_simulation_clocks
            set mode='error',row_version=row_version+1,updated_state_revision=3,
                updated_at=date_trunc('milliseconds',transaction_timestamp())
          where world_id=$1`,
        [worldId],
      );
      await connection.query(
        `update command_records
            set status='accepted',authorization_rule_id='system.simulation.auto_pause',
                decided_at=date_trunc('milliseconds',transaction_timestamp()),
                resulting_state_revision=3,response_summary=jsonb_build_object(
                  'commandId',$1::text,'eventIds',jsonb_build_array($2::text),
                  'resultingStateRevision','3','schemaVersion',1,'status','accepted'
                )
          where id=$1`,
        [autoPauseCommandId, recordedEventId],
      );
      await connection.query(
        `insert into domain_events(
           id,world_id,world_event_sequence,command_id,event_ordinal,
           aggregate_type,aggregate_id,aggregate_version,event_type,
           event_schema_version,payload,metadata,event_hash,occurred_at,
           recorded_at,resulting_state_revision
         ) values (
           $1,$2,996,$3::uuid,0,'simulation_failure',$4,2,
           'SimulationFailureResolvedV1',1,
           jsonb_build_object(
             'failureId',$4::text,'resolution','retry_after_repair',
             'scheduleId',null,'tick','0'
           ),
           jsonb_build_object(
             'actor',jsonb_build_object('actorId',$5::text,'actorType','user'),
             'authorizationRuleId','world.simulation.failure.resolve','causationId',null,
             'commandSchemaVersion',1,'commandType','ResolveSimulationFailureV1',
             'correlationId',$3::text,'overrideId',null,'payloadClassification','member'
           ),
           extensions.digest(convert_to('m07-resolve-without-clock-event','UTF8'),'sha256'),
           date_trunc('milliseconds',transaction_timestamp()),
           date_trunc('milliseconds',transaction_timestamp()),4
         )`,
        [resolvedEventId, worldId, resolveCommandId, failureId, creatorId],
      );
      await connection.query(
        `update simulation_failures
            set status='resolved',resolved_by_actor_id=$2,
                resolved_at=date_trunc('milliseconds',transaction_timestamp()),
                resolution_command_id=$3
          where id=$1`,
        [failureId, creatorId, resolveCommandId],
      );
      await connection.query(
        `update command_records
            set status='accepted',authorization_rule_id='world.simulation.failure.resolve',
                decided_at=date_trunc('milliseconds',transaction_timestamp()),
                resulting_state_revision=4,response_summary=jsonb_build_object(
                  'commandId',$1::text,'eventIds',jsonb_build_array($2::text),
                  'resultingStateRevision','4','schemaVersion',1,'status','accepted'
                )
          where id=$1`,
        [resolveCommandId, resolvedEventId],
      );
      await expect(
        connection.query(`set constraints simulation_failures_require_accepted_command immediate`),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('allows only an open advance command to change the cumulative clock outcome hash', async () => {
    async function attempt(
      commandId: string,
      commandType: 'AdvanceSimulationV1' | 'PauseWorldClockV1',
      allowed: boolean,
    ): Promise<void> {
      const connection = await app.pool.connect();
      try {
        await connection.query('begin');
        await connection.query(
          `insert into command_records(
            id,world_id,command_type,command_schema_version,actor_type,actor_id,
            payload,payload_hash,payload_classification,idempotency_key,request_hash,
            expected_world_version,expected_state_revision,expected_aggregate_version,
            correlation_id,requested_at
          ) values (
            $1,$2,$3,1,'system','worldgraph:simulation-test','{}',
            extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
            'member',$4,
            extensions.digest(convert_to($4,'UTF8'),'sha256'),
            1,2,1,$1,date_trunc('milliseconds',transaction_timestamp())
          )`,
          [commandId, worldId, commandType, `outcome-${commandId.slice(-12)}`],
        );
        await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
        const update = connection.query(
          `update world_simulation_clocks
           set outcome_hash=extensions.digest(convert_to($2,'UTF8'),'sha256'),
             row_version=row_version+1,updated_state_revision=3,
             updated_at=greatest(updated_at,date_trunc('milliseconds',transaction_timestamp()))
           where world_id=$1`,
          [worldId, commandType],
        );
        if (allowed) {
          await expect(update).resolves.toMatchObject({ rowCount: 1 });
        } else {
          await expect(update).rejects.toMatchObject({ code: '55000' });
        }
      } finally {
        await connection.query('rollback').catch(() => undefined);
        connection.release();
      }
    }

    await attempt('078f0000-0000-7000-8000-000000000751', 'PauseWorldClockV1', false);
    await attempt('078f0000-0000-7000-8000-000000000752', 'AdvanceSimulationV1', true);
  });

  it('fences stale simulation workers and denies direct allocation-table writes', async () => {
    const first = await app.pool.query<{ fencing_token: string }>(
      `select fencing_token::text from worldgraph_acquire_simulation_lease($1,$2,1000)`,
      [worldId, 'worker-a'],
    );
    expect(first.rows[0]?.fencing_token).toBe('1');
    const busy = await app.pool.query(
      `select * from worldgraph_acquire_simulation_lease($1,$2,1000)`,
      [worldId, 'worker-b'],
    );
    expect(busy.rowCount).toBe(0);
    await owner.pool.query(
      `update simulation_worker_leases
       set leased_until=statement_timestamp(),heartbeat_at=statement_timestamp()
       where world_id=$1`,
      [worldId],
    );
    const second = await app.pool.query<{ fencing_token: string }>(
      `select fencing_token::text from worldgraph_acquire_simulation_lease($1,$2,1000)`,
      [worldId, 'worker-b'],
    );
    expect(second.rows[0]?.fencing_token).toBe('2');
    await expect(
      app.pool.query(`select worldgraph_renew_simulation_lease($1,$2,1,1000) renewed`, [
        worldId,
        'worker-a',
      ]),
    ).resolves.toMatchObject({ rows: [{ renewed: false }] });
    await expect(
      app.pool.query(`select worldgraph_simulation_lease_is_current($1,$2,2) current`, [
        worldId,
        'worker-b',
      ]),
    ).resolves.toMatchObject({ rows: [{ current: true }] });
    await expect(
      app.pool.query(`select worldgraph_release_simulation_lease($1,$2,2) released`, [
        worldId,
        'worker-b',
      ]),
    ).resolves.toMatchObject({ rows: [{ released: true }] });
    await expect(
      app.pool.query(`insert into world_schedule_heads(world_id) values ($1)`, [worldId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.pool.query(
        `insert into simulation_worker_leases(
          world_id,lease_owner,fencing_token,leased_until,heartbeat_at
        ) values ($1,'forged-worker',99,now()+interval '1 minute',now())`,
        [worldId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('binds every clock field transition to its exact open command type', async () => {
    const rejectedUpdate = async (
      commandId: string,
      commandType: string,
      update: string,
    ): Promise<void> => {
      const connection = await owner.pool.connect();
      try {
        await connection.query('begin');
        await openClockGuardCommand(connection, commandId, commandType);
        await expect(connection.query(update, [worldId])).rejects.toMatchObject({ code: '55000' });
      } finally {
        await connection.query('rollback').catch(() => undefined);
        connection.release();
      }
    };

    await rejectedUpdate(
      '078f0000-0000-7000-8000-000000000751',
      'ConfigureWorldClockV1',
      `update world_simulation_clocks
          set mode='running',last_wall_anchor_at=date_trunc('milliseconds',transaction_timestamp()),
              row_version=row_version+1,updated_state_revision=updated_state_revision+1,
              updated_at=greatest(updated_at,date_trunc('milliseconds',transaction_timestamp()))
        where world_id=$1`,
    );
    await rejectedUpdate(
      '078f0000-0000-7000-8000-000000000752',
      'PauseWorldClockV1',
      `update world_simulation_clocks
          set mode='running',last_wall_anchor_at=date_trunc('milliseconds',transaction_timestamp()),
              row_version=row_version+1,updated_state_revision=updated_state_revision+1,
              updated_at=greatest(updated_at,date_trunc('milliseconds',transaction_timestamp()))
        where world_id=$1`,
    );
    await rejectedUpdate(
      '078f0000-0000-7000-8000-000000000753',
      'AutoPauseWorldClockV1',
      `update world_simulation_clocks
          set mode='error',row_version=row_version+1,
              updated_state_revision=updated_state_revision+1,
              updated_at=greatest(updated_at,date_trunc('milliseconds',transaction_timestamp()))
        where world_id=$1`,
    );
    await rejectedUpdate(
      '078f0000-0000-7000-8000-000000000754',
      'StartWorldClockV1',
      `update world_simulation_clocks
          set current_tick=current_tick+1,row_version=row_version+1,
              updated_state_revision=updated_state_revision+1,
              updated_at=greatest(updated_at,date_trunc('milliseconds',transaction_timestamp()))
        where world_id=$1`,
    );
    await rejectedUpdate(
      '078f0000-0000-7000-8000-000000000755',
      'StartWorldClockV1',
      `update world_simulation_clocks
          set wall_cadence_milliseconds=wall_cadence_milliseconds+100,
              row_version=row_version+1,updated_state_revision=updated_state_revision+1,
              updated_at=greatest(updated_at,date_trunc('milliseconds',transaction_timestamp()))
        where world_id=$1`,
    );

    const configure = await owner.pool.connect();
    try {
      await configure.query('begin');
      await openClockGuardCommand(
        configure,
        '078f0000-0000-7000-8000-000000000756',
        'ConfigureWorldClockV1',
      );
      await expect(
        configure.query(
          `update world_simulation_clocks
              set wall_cadence_milliseconds=wall_cadence_milliseconds+100,
                  row_version=row_version+1,updated_state_revision=updated_state_revision+1,
                  updated_at=greatest(
                    updated_at,date_trunc('milliseconds',transaction_timestamp())
                  )
            where world_id=$1`,
          [worldId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await configure.query('rollback').catch(() => undefined);
      configure.release();
    }

    const advance = await owner.pool.connect();
    try {
      await advance.query('begin');
      await advance.query(`set local session_replication_role = 'replica'`);
      await advance.query(
        `update world_simulation_clocks
            set mode='running',last_wall_anchor_at=date_trunc(
              'milliseconds',transaction_timestamp()-interval '1 second'
            )
          where world_id=$1`,
        [worldId],
      );
      await advance.query(
        `update projection_checkpoints
            set checksum=worldgraph_simulation_projection_checksum($1)
          where world_id=$1 and projection_name='simulation_runtime'`,
        [worldId],
      );
      await advance.query(`set local session_replication_role = 'origin'`);
      await openClockGuardCommand(
        advance,
        '078f0000-0000-7000-8000-000000000757',
        'AdvanceSimulationV1',
      );
      await expect(
        advance.query(
          `update world_simulation_clocks
              set current_tick=current_tick+1,
                  outcome_hash=extensions.digest(convert_to('guard-advance','UTF8'),'sha256'),
                  last_wall_anchor_at=last_wall_anchor_at
                    + wall_cadence_milliseconds*interval '1 millisecond',
                  row_version=row_version+1,updated_state_revision=updated_state_revision+1,
                  updated_at=greatest(
                    updated_at,date_trunc('milliseconds',transaction_timestamp())
                  )
            where world_id=$1`,
          [worldId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await advance.query('rollback').catch(() => undefined);
      advance.release();
    }
  });

  it('keeps semantic projection checksums independent of workers and batch grouping', async () => {
    const before = await owner.pool.query<{ checksum: string; document: Record<string, unknown> }>(
      `select encode(worldgraph_simulation_projection_checksum($1),'hex') checksum,
        worldgraph_simulation_projection_document($1) document`,
      [worldId],
    );
    expect(JSON.stringify(before.rows[0]?.document)).not.toMatch(
      /worldId|rowVersion|StateRevision|CommandId|EventId|wallAnchor|worker|batchKey|batchRun/i,
    );
    expect(before.rows[0]?.document).toMatchObject({
      clock: { outcomeHash: javascriptInitialSimulationOutcomeHashV1('m07-seed') },
    });

    const firstLease = await app.pool.query<{ fencing_token: string }>(
      `select fencing_token::text from worldgraph_acquire_simulation_lease($1,$2,1000)`,
      [worldId, 'checksum-worker-a'],
    );
    expect(firstLease.rowCount).toBe(1);
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `insert into simulation_batch_runs(
          id,world_id,from_tick,to_tick,batch_key,process_registry_version,
          input_checksum,attempts,started_at
        ) values
          ('078f0000-0000-7000-8000-000000000731',$1,0,2,
            extensions.digest(convert_to('group-0-2','UTF8'),'sha256'),1,
            extensions.digest(convert_to('same-semantic-input','UTF8'),'sha256'),1,now()),
          ('078f0000-0000-7000-8000-000000000732',$1,0,1,
            extensions.digest(convert_to('group-0-1','UTF8'),'sha256'),1,
            extensions.digest(convert_to('same-semantic-input','UTF8'),'sha256'),1,now()),
          ('078f0000-0000-7000-8000-000000000733',$1,1,2,
            extensions.digest(convert_to('group-1-2','UTF8'),'sha256'),1,
            extensions.digest(convert_to('same-semantic-input','UTF8'),'sha256'),1,now())`,
        [worldId],
      );
    });
    await owner.pool.query(
      `update simulation_worker_leases
       set leased_until=transaction_timestamp(),heartbeat_at=transaction_timestamp()
       where world_id=$1`,
      [worldId],
    );
    const secondLease = await app.pool.query<{ fencing_token: string }>(
      `select fencing_token::text from worldgraph_acquire_simulation_lease($1,$2,1000)`,
      [worldId, 'checksum-worker-b'],
    );
    expect(secondLease.rowCount).toBe(1);
    const after = await owner.pool.query<{ checksum: string }>(
      `select encode(worldgraph_simulation_projection_checksum($1),'hex') checksum`,
      [worldId],
    );
    expect(after.rows[0]?.checksum).toBe(before.rows[0]?.checksum);
  });

  it('freezes the authoritative command gate on semantic simulation divergence', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update world_simulation_clocks
            set outcome_hash=extensions.digest(
              convert_to('deliberate-m07-projection-divergence','UTF8'),'sha256'
            )
          where world_id=$1`,
        [worldId],
      );
      await connection.query(`set local session_replication_role = 'origin'`);
      await expect(
        openClockGuardCommand(
          connection,
          '078f0000-0000-7000-8000-000000000758',
          'PauseWorldClockV1',
        ),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('denies forged app-role checkpoint certification without an owner-opened command', async () => {
    const commandId = '078f0000-0000-7000-8000-000000000759';
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update world_simulation_clocks
            set outcome_hash=extensions.digest(
              convert_to('forged-checkpoint-certification','UTF8'),'sha256'
            )
          where world_id=$1`,
        [worldId],
      );
      await connection.query(`set local session_replication_role = 'origin'`);

      const before = await connection.query<{
        checkpoint_checksum: string;
        event_count: string;
        live_checksum: string;
        next_schedule_sequence: string;
      }>(
        `select
          encode(checkpoint.checksum,'hex') checkpoint_checksum,
          encode(worldgraph_simulation_projection_checksum($1),'hex') live_checksum,
          schedule.next_schedule_sequence::text,
          (select count(*)::text from domain_events event where event.world_id=$1) event_count
         from projection_checkpoints checkpoint
         join world_schedule_heads schedule on schedule.world_id=checkpoint.world_id
         where checkpoint.world_id=$1 and checkpoint.projection_name='simulation_runtime'`,
        [worldId],
      );
      expect(before.rows[0]?.live_checksum).not.toBe(before.rows[0]?.checkpoint_checksum);

      await connection.query(`set local role worldgraph_app`);
      await connection.query(
        `insert into command_records(
          id,world_id,command_type,command_schema_version,actor_type,actor_id,
          payload,payload_hash,payload_classification,idempotency_key,request_hash,
          expected_world_version,expected_state_revision,expected_aggregate_version,
          correlation_id,requested_at
        ) values (
          $1,$2,'AdvanceSimulationV1',1,'system','worldgraph:forged-guc-test','{}',
          extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
          'member','m07-forged-guc-command',
          extensions.digest(convert_to('m07-forged-guc-command','UTF8'),'sha256'),
          1,2,1,$1,date_trunc('milliseconds',transaction_timestamp())
        )`,
        [commandId, worldId],
      );
      await connection.query(`select set_config('worldgraph.command_id',$1,true)`, [commandId]);
      await connection.query(`select set_config('worldgraph.command_world_id',$1,true)`, [worldId]);
      await expect(
        connection.query<{ is_open: boolean }>(
          `select worldgraph_command_write_is_open($1,$2) is_open`,
          [worldId, commandId],
        ),
      ).resolves.toMatchObject({ rows: [{ is_open: false }] });

      const expectAuthorityRejection = async (
        savepoint: string,
        statement: string,
        values: unknown[],
      ): Promise<void> => {
        await connection.query(`savepoint ${savepoint}`);
        await expect(connection.query(statement, values)).rejects.toMatchObject({ code: '55000' });
        await connection.query(`rollback to savepoint ${savepoint}`);
      };

      await expectAuthorityRejection(
        'forged_checkpoint_update',
        `update projection_checkpoints
            set checksum=worldgraph_simulation_projection_checksum($1),
                status='current',updated_at=greatest(updated_at,now())
          where world_id=$1 and projection_name='simulation_runtime'`,
        [worldId],
      );
      await expectAuthorityRejection(
        'forged_checkpoint_insert',
        `insert into projection_checkpoints(
           world_id,projection_name,projection_schema_version,
           last_event_sequence,checksum,status,updated_at
         ) select $1,'simulation_runtime',1,runtime.last_event_sequence,
             worldgraph_simulation_projection_checksum($1),'current',now()
           from world_runtime_heads runtime where runtime.world_id=$1`,
        [worldId],
      );
      await expectAuthorityRejection(
        'forged_schedule_allocation',
        `select worldgraph_allocate_schedule_sequence($1)`,
        [worldId],
      );
      await expectAuthorityRejection(
        'forged_clock_update',
        `update world_simulation_clocks
            set outcome_hash=extensions.digest(convert_to('forged-open-write','UTF8'),'sha256'),
                row_version=row_version+1,updated_state_revision=updated_state_revision+1,
                updated_at=greatest(updated_at,now())
          where world_id=$1`,
        [worldId],
      );

      await expect(
        connection.query(
          `update projection_checkpoints
              set checksum=checksum,status=status,updated_at=updated_at
            where world_id=$1 and projection_name='world_graph'`,
          [worldId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      const after = await connection.query<{
        checkpoint_checksum: string;
        event_count: string;
        live_checksum: string;
        next_schedule_sequence: string;
      }>(
        `select
          encode(checkpoint.checksum,'hex') checkpoint_checksum,
          encode(worldgraph_simulation_projection_checksum($1),'hex') live_checksum,
          schedule.next_schedule_sequence::text,
          (select count(*)::text from domain_events event where event.world_id=$1) event_count
         from projection_checkpoints checkpoint
         join world_schedule_heads schedule on schedule.world_id=checkpoint.world_id
         where checkpoint.world_id=$1 and checkpoint.projection_name='simulation_runtime'`,
        [worldId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);

      const checkpointTriggers = await connection.query<{ trigger_name: string }>(
        `select trigger.tgname trigger_name
           from pg_catalog.pg_trigger trigger
          where trigger.tgrelid='projection_checkpoints'::regclass
            and not trigger.tgisinternal
          order by trigger.tgname`,
      );
      expect(checkpointTriggers.rows).toEqual([
        { trigger_name: 'projection_checkpoints_protect' },
        { trigger_name: 'projection_checkpoints_require_commerce_command' },
        { trigger_name: 'projection_checkpoints_require_economy_command' },
        { trigger_name: 'projection_checkpoints_require_simulation_command' },
      ]);
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('rejects non-command batch and failure pre-seeding through the app role', async () => {
    await expect(
      app.pool.query(
        `insert into simulation_batch_runs(
          id,world_id,from_tick,to_tick,batch_key,process_registry_version,
          input_checksum,attempts,started_at
        ) values (
          '078f0000-0000-7000-8000-000000000764',$1,20,21,
          extensions.digest(convert_to('non-command-batch','UTF8'),'sha256'),1,
          extensions.digest(convert_to('non-command-input','UTF8'),'sha256'),1,now()
        )`,
        [worldId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query(
        `insert into simulation_failures(
          id,world_id,batch_run_id,tick,schedule_id,process_type,process_version,
          error_code,redacted_context,attempts,opened_at
        ) values (
          '078f0000-0000-7000-8000-000000000765',$1,
          '078f0000-0000-7000-8000-000000000731',0,null,
          'WorldClockV1','1.0.0','SIMULATION_INTEGER_OVERFLOW','{}',1,now()
        )`,
        [worldId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('rejects a zero-width failed batch outside an open auto-pause command', async () => {
    await expect(
      app.pool.query(
        `insert into simulation_batch_runs(
           id,world_id,from_tick,to_tick,batch_key,process_registry_version,
           input_checksum,attempts,status,error_code,started_at,completed_at
         ) values (
           '078f0000-0000-7000-8000-000000000739',$1,7,7,
           extensions.digest(convert_to('forged-zero-width','UTF8'),'sha256'),1,
           extensions.digest(convert_to('forged-input','UTF8'),'sha256'),1,
           'failed','SIMULATION_INTEGER_OVERFLOW',now(),now()
         )`,
        [worldId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('gates completed batches and defers their accepted-command proof to commit', async () => {
    await expect(
      app.pool.query(
        `update simulation_batch_runs set status='completed',
          outcome_hash=extensions.digest(convert_to('forged-outcome','UTF8'),'sha256'),
          command_id=$2,completed_at=now() where id=$1`,
        ['078f0000-0000-7000-8000-000000000731', deterministicMigrationId('command')],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    const commandId = '078f0000-0000-7000-8000-000000000741';
    const connection = await app.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(
        `insert into command_records(
          id,world_id,command_type,command_schema_version,actor_type,actor_id,
          payload,payload_hash,payload_classification,idempotency_key,request_hash,
          expected_world_version,expected_state_revision,expected_aggregate_version,
          correlation_id,requested_at
        ) values (
          $1,$2,'AdvanceSimulationV1',1,'system','worldgraph:simulation-worker','{}',
          extensions.digest(convert_to(worldgraph_canonical_jsonb('{}'),'UTF8'),'sha256'),
          'member','m07-batch-command',
          extensions.digest(convert_to('m07-batch-command','UTF8'),'sha256'),
          1,2,0,$1,date_trunc('milliseconds',transaction_timestamp())
        )`,
        [commandId, worldId],
      );
      await connection.query(`select worldgraph_open_command_write($1,$2)`, [commandId, worldId]);
      await expect(
        connection.query(
          `update simulation_batch_runs set status='completed',
            outcome_hash=extensions.digest(convert_to('gated-outcome','UTF8'),'sha256'),
            command_id=$2,completed_at=now() where id=$1`,
          ['078f0000-0000-7000-8000-000000000731', commandId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        connection.query(
          `set constraints simulation_batch_runs_require_accepted_command immediate`,
        ),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it('installs cleanly and exposes restrictive grants on a fresh database', async () => {
    const freshDatabase = 'worldgraph_m07_fresh';
    await owner.pool.query(`create database ${freshDatabase}`);
    const freshUrl = new URL(container.getConnectionUri());
    freshUrl.pathname = `/${freshDatabase}`;
    const fresh = createDatabaseClient(freshUrl.toString(), 'm07-fresh-test');
    try {
      await migrate(fresh.db, { migrationsFolder: migrationRoot });
      await expect(readRuntimeVersions(fresh.pool)).resolves.toMatchObject({
        contracts: 10,
        runtimeSchema: 10,
        simulationClockSchema: 1,
        simulationScheduleSchema: 1,
      });
      const privileges = await fresh.pool.query<{
        app_can_hash_initial_outcome: boolean;
        app_can_insert_clock: boolean;
        app_can_insert_lease: boolean;
        app_can_insert_schedule_id: boolean;
        app_has_table_insert_schedule: boolean;
        app_can_update_head: boolean;
        app_can_update_outcome: boolean;
        app_has_expected_aggregate: boolean;
        public_can_hash_initial_outcome: boolean;
      }>(
        `select
          has_function_privilege(
            'worldgraph_app',
            'public.worldgraph_initial_simulation_outcome_hash_v1(text)',
            'EXECUTE'
          ) app_can_hash_initial_outcome,
          has_table_privilege('worldgraph_app','world_simulation_clocks','INSERT') app_can_insert_clock,
          has_table_privilege('worldgraph_app','simulation_worker_leases','INSERT') app_can_insert_lease,
          has_column_privilege(
            'worldgraph_app','scheduled_actions','id','INSERT'
          ) app_can_insert_schedule_id,
          has_table_privilege(
            'worldgraph_app','scheduled_actions','INSERT'
          ) app_has_table_insert_schedule,
          has_table_privilege('worldgraph_app','world_schedule_heads','UPDATE') app_can_update_head,
          has_column_privilege(
            'worldgraph_app','world_simulation_clocks','outcome_hash','UPDATE'
          ) app_can_update_outcome,
          has_column_privilege(
            'worldgraph_app','command_records','expected_aggregate_version','INSERT'
          ) app_has_expected_aggregate,
          exists (
            select 1
              from information_schema.routine_privileges privilege
             where privilege.routine_schema = 'public'
               and privilege.routine_name = 'worldgraph_initial_simulation_outcome_hash_v1'
               and privilege.grantee = 'PUBLIC'
               and privilege.privilege_type = 'EXECUTE'
          ) public_can_hash_initial_outcome`,
      );
      expect(privileges.rows[0]).toEqual({
        app_can_hash_initial_outcome: true,
        app_can_insert_clock: false,
        app_can_insert_lease: false,
        app_can_insert_schedule_id: true,
        app_can_update_head: false,
        app_can_update_outcome: true,
        app_has_expected_aggregate: true,
        app_has_table_insert_schedule: false,
        public_can_hash_initial_outcome: false,
      });
      await seedPreM06ActiveWorld(fresh.pool);
      const boundary = await fresh.pool.connect();
      try {
        await boundary.query('begin');
        await boundary.query(`set local session_replication_role = 'replica'`);
        await boundary.query(
          `update world_entities
              set state=jsonb_set(state,'{settings}',$2::jsonb)
            where id=$1`,
          [
            simulationEntityId,
            {
              epochAt: '9999-12-31T23:59:59.999Z',
              worldMillisecondsPerTick: 1,
            },
          ],
        );
        const resolved = await boundary.query<{ resolved: Record<string, unknown> }>(
          `select worldgraph_resolve_simulation_clock_config($1) resolved`,
          [worldId],
        );
        expect(resolved.rows[0]?.resolved).toMatchObject({
          configuration: {
            epochAt: '2000-01-01T00:00:00.000Z',
            worldMillisecondsPerTick: 86_400_000,
          },
          provenance: 'm07_default',
        });
      } finally {
        await boundary.query('rollback').catch(() => undefined);
        boundary.release();
      }
      await migrate(fresh.db, { migrationsFolder: migrationRoot });
    } finally {
      await fresh.pool.end();
    }
  });
});
