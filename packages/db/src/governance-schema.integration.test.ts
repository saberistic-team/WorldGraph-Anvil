import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalJson } from '@worldgraph/contracts';

import { createDatabaseClient, type DatabaseClient, readRuntimeVersions } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const governanceTables = [
  'ballot_choice_revisions',
  'ballot_effective_revisions',
  'ballot_participation',
  'ballot_receipts',
  'candidacies',
  'candidacy_transitions',
  'charter_authority_intervals',
  'compiled_governance_seed_plans',
  'election_contests',
  'election_results',
  'election_tallies',
  'election_tally_counts',
  'elections',
  'eligibility_snapshot_members',
  'eligibility_snapshots',
  'governance_authority_decision_sources',
  'governance_authority_decisions',
  'governance_contests',
  'governance_override_approvals',
  'governance_overrides',
  'governance_repair_approvals',
  'governance_repairs',
  'governance_schedule_occurrences',
  'governance_tax_policy_lineage',
  'governing_charter_versions',
  'governing_charters',
  'institution_powers',
  'institutions',
  'law_authority_intervals',
  'law_effectivity_transitions',
  'law_versions',
  'laws',
  'office_powers',
  'office_power_delegations',
  'office_seat_authority_intervals',
  'office_term_transitions',
  'office_terms',
  'political_office_seats',
  'political_offices',
  'proposal_action_enactments',
  'proposal_actions',
  'proposal_contests',
  'proposal_enactments',
  'proposal_results',
  'proposal_sponsors',
  'proposal_tallies',
  'proposal_tally_counts',
  'proposal_transitions',
  'proposals',
  'public_ballot_choices',
  'public_project_authorizations',
  'recent_credential_proof_consumptions',
  'recent_credential_proofs',
  'secret_ballot_choices',
  'tax_policy_authority_intervals',
  'treasury_encumbrance_facts',
  'treasury_encumbrance_projections',
  'treasury_encumbrances',
  'world_governance_heads',
] as const;

const governanceScheduledActions = [
  'CertifyAndEnactProposalV1',
  'CertifyElectionV1',
  'CloseAndTallyElectionV1',
  'CloseAndTallyProposalV1',
  'OpenElectionV1',
  'OpenProposalVotingV1',
] as const;

function governanceChecksum(domain: string, value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson({ domain, value }), 'utf8').digest();
}

async function createPreM10MigrationRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-pre-m10-'));
  await mkdir(join(root, 'meta'));
  const journal = JSON.parse(await readFile(join(migrationRoot, 'meta/_journal.json'), 'utf8')) as {
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
    version: string;
  };
  const entries = journal.entries.filter((entry) => entry.idx < 12);
  await Promise.all(
    entries.map((entry) =>
      cp(join(migrationRoot, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`)),
    ),
  );
  await writeFile(join(root, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return root;
}

async function createExactM10MigrationRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-exact-m10-'));
  await mkdir(join(root, 'meta'));
  const journal = JSON.parse(await readFile(join(migrationRoot, 'meta/_journal.json'), 'utf8')) as {
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
    version: string;
  };
  const entries = journal.entries.filter((entry) => entry.idx < 13);
  await Promise.all(
    entries.map((entry) =>
      cp(join(migrationRoot, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`)),
    ),
  );
  await writeFile(join(root, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return root;
}

describe('M10 governance, law, election, and treasury schema', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'governance-schema-owner');
    await migrate(owner.db, { migrationsFolder: migrationRoot });
  }, 120_000);

  afterAll(async () => {
    await owner?.pool.end();
    await container?.stop();
  });

  it('installs the complete governance surface and advances sealed versions', async () => {
    const tables = await owner.pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_name = any($1::text[])
        order by table_name`,
      [[...governanceTables]],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...governanceTables].sort());

    const crossWorldForeignKeys = await owner.pool.query<{ conname: string }>(
      `select constraint_record.conname
         from pg_constraint constraint_record
         join pg_class source_table on source_table.oid = constraint_record.conrelid
         join pg_class target_table on target_table.oid = constraint_record.confrelid
        where constraint_record.contype = 'f'
          and source_table.relname = any($1::text[])
          and exists (
            select 1 from pg_attribute target_world
             where target_world.attrelid = target_table.oid
               and target_world.attname = 'world_id'
               and not target_world.attisdropped
          )
          and not exists (
            select 1
              from unnest(constraint_record.conkey) with ordinality source_key(attnum,ordinality)
              join unnest(constraint_record.confkey) with ordinality target_key(attnum,ordinality)
                using (ordinality)
              join pg_attribute source_column
                on source_column.attrelid = source_table.oid
               and source_column.attnum = source_key.attnum
              join pg_attribute target_column
                on target_column.attrelid = target_table.oid
               and target_column.attnum = target_key.attnum
             where source_column.attname = 'world_id'
               and target_column.attname = 'world_id'
          )
        order by constraint_record.conname`,
      [[...governanceTables]],
    );
    expect(crossWorldForeignKeys.rows).toEqual([]);

    await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
      compiler: '1.3.0',
      compilerArtifactSchema: 4,
      contracts: 10,
      governancePolicySchema: 1,
      governanceSchema: 1,
      governanceSeedPlanSchema: 1,
      runtimeSchema: 10,
      simulationProcessRegistry: 3,
    });

    const migrationCount = await owner.pool.query<{ migration_count: number }>(
      `select count(*)::integer as migration_count from drizzle.__drizzle_migrations`,
    );
    expect(migrationCount.rows).toEqual([{ migration_count: 14 }]);

    const retainedRepairGuards = await owner.pool.query<{
      exact_effect_guard: string;
      execution_function: string;
    }>(
      `select
         pg_get_functiondef(
           'worldgraph_assert_commerce_projection_repair_execution()'::regprocedure
         ) as exact_effect_guard,
         pg_get_functiondef(
           'worldgraph_execute_commerce_projection_repair(uuid,uuid,text,text)'
             ::regprocedure
         ) as execution_function`,
    );
    expect(retainedRepairGuards.rows[0]?.exact_effect_guard).toContain(
      'run_record.reconciliation_schema_version <> 3',
    );
    expect(retainedRepairGuards.rows[0]?.exact_effect_guard).not.toContain(
      'run_record.reconciliation_schema_version <> 2',
    );
    expect(retainedRepairGuards.rows[0]?.execution_function).toContain(
      'reconciliation_run_id_value, plan_record.world_id, 3',
    );

    const capabilityBoundary = await owner.pool.query<{
      app_can_execute: boolean;
      app_can_read_snapshot_members: boolean;
      proconfig: string[];
      prosecdef: boolean;
      provolatile: string;
      public_can_execute: boolean;
      tally_can_execute: boolean;
    }>(
      `select procedure.prosecdef,procedure.provolatile,procedure.proconfig,
         has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
           as app_can_execute,
         has_function_privilege('worldgraph_governance_tally',procedure.oid,'EXECUTE')
           as tally_can_execute,
         coalesce(aclcontains(
           procedure.proacl,makeaclitem(0,procedure.proowner,'EXECUTE',false)
         ),false) as public_can_execute,
         has_table_privilege(
           'worldgraph_app','eligibility_snapshot_members','SELECT'
         ) as app_can_read_snapshot_members
       from pg_proc procedure
      where procedure.oid =
        'worldgraph_governance_actor_capability_v1(uuid,uuid,text,uuid,uuid)'
          ::regprocedure`,
    );
    expect(capabilityBoundary.rows).toEqual([
      {
        app_can_execute: true,
        app_can_read_snapshot_members: false,
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
        provolatile: 's',
        public_can_execute: false,
        tally_can_execute: false,
      },
    ]);

    const expectedTick = await owner.pool.query<{
      column_name: string;
      definition: string;
      validated: boolean;
    }>(
      `select column_record.column_name,constraint_record.convalidated as validated,
         pg_get_constraintdef(constraint_record.oid) as definition
       from information_schema.columns column_record
       join pg_constraint constraint_record
         on constraint_record.conrelid = 'command_records'::regclass
        and constraint_record.conname = 'command_records_governance_expected_tick_required'
      where column_record.table_schema = 'public'
        and column_record.table_name = 'command_records'
        and column_record.column_name = 'expected_tick'`,
    );
    expect(expectedTick.rows).toHaveLength(1);
    expect(expectedTick.rows[0]).toMatchObject({
      column_name: 'expected_tick',
      validated: false,
    });
    expect(expectedTick.rows[0]?.definition).toContain('CloseAndTallyProposalV1');
    expect(expectedTick.rows[0]?.definition).toContain('RepairGovernanceResultV1');

    const expectedTickPrivilege = await owner.pool.query<{
      app_can_insert_expected_tick: boolean;
      app_can_insert_whole_record: boolean;
    }>(
      `select
         has_column_privilege(
           'worldgraph_app','command_records','expected_tick','INSERT'
         ) as app_can_insert_expected_tick,
         has_table_privilege('worldgraph_app','command_records','INSERT')
           as app_can_insert_whole_record`,
    );
    expect(expectedTickPrivilege.rows).toEqual([
      {
        app_can_insert_expected_tick: true,
        app_can_insert_whole_record: false,
      },
    ]);

    const projectionPrivileges = await owner.pool.query<{
      app_can_read_eligibility_members: boolean;
      app_can_read_recent_proofs: boolean;
      app_can_update_candidacy_identity: boolean;
      app_can_update_law_range: boolean;
      app_can_update_proposal_status: boolean;
      app_can_update_proposal_table: boolean;
      app_can_update_proposal_window: boolean;
      app_can_update_treasury_projection: boolean;
    }>(
      `select
         has_table_privilege(
           'worldgraph_app','eligibility_snapshot_members','SELECT'
         ) as app_can_read_eligibility_members,
         has_table_privilege(
           'worldgraph_app','recent_credential_proofs','SELECT'
         ) as app_can_read_recent_proofs,
         has_table_privilege(
           'worldgraph_app','treasury_encumbrance_projections','UPDATE'
         ) as app_can_update_treasury_projection,
         has_table_privilege('worldgraph_app','proposals','UPDATE')
           as app_can_update_proposal_table,
         has_column_privilege('worldgraph_app','proposals','status','UPDATE')
           as app_can_update_proposal_status,
         has_column_privilege(
           'worldgraph_app','proposals','voting_closes_tick','UPDATE'
         ) as app_can_update_proposal_window,
         has_column_privilege(
           'worldgraph_app','candidacies','candidate_entity_id','UPDATE'
         ) as app_can_update_candidacy_identity,
         has_column_privilege(
           'worldgraph_app','law_authority_intervals','effective_ticks','UPDATE'
         ) as app_can_update_law_range`,
    );
    expect(projectionPrivileges.rows).toEqual([
      {
        app_can_read_eligibility_members: false,
        app_can_read_recent_proofs: false,
        app_can_update_candidacy_identity: false,
        app_can_update_law_range: true,
        app_can_update_proposal_status: true,
        app_can_update_proposal_table: false,
        app_can_update_proposal_window: false,
        app_can_update_treasury_projection: false,
      },
    ]);

    const streamSeedBoundary = await owner.pool.query<{
      app_can_execute: boolean;
      app_can_insert_heads: boolean;
      app_can_update_heads: boolean;
      proconfig: string[];
      prosecdef: boolean;
      public_can_execute: boolean;
    }>(
      `select procedure.prosecdef,procedure.proconfig,
         has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
           as app_can_execute,
         aclcontains(
           procedure.proacl,makeaclitem(0,procedure.proowner,'EXECUTE',false)
         ) as public_can_execute,
         has_table_privilege('worldgraph_app','aggregate_stream_heads','INSERT')
           as app_can_insert_heads,
         has_table_privilege('worldgraph_app','aggregate_stream_heads','UPDATE')
           as app_can_update_heads
       from pg_proc procedure
      where procedure.oid =
        'worldgraph_seed_governance_aggregate_stream_v1(uuid,uuid,text,text)'
          ::regprocedure`,
    );
    expect(streamSeedBoundary.rows).toEqual([
      {
        app_can_execute: true,
        app_can_insert_heads: false,
        app_can_update_heads: false,
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
        public_can_execute: false,
      },
    ]);
  });

  it('detects nested sensitive keys under a restricted caller search path', async () => {
    const catalog = await owner.pool.query<{
      app_can_execute: boolean;
      owner_name: string;
      proconfig: string[];
      proparallel: string;
      prosecdef: boolean;
      provolatile: string;
      public_can_execute: boolean;
      tally_can_execute: boolean;
    }>(
      `select pg_get_userbyid(procedure.proowner) as owner_name,
         procedure.proconfig,procedure.proparallel,procedure.prosecdef,
         procedure.provolatile,
         has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
           as app_can_execute,
         has_function_privilege(
           'worldgraph_governance_tally',procedure.oid,'EXECUTE'
         ) as tally_can_execute,
         coalesce(aclcontains(
           procedure.proacl,makeaclitem(0,procedure.proowner,'EXECUTE',false)
         ),false) as public_can_execute
       from pg_proc procedure
       where procedure.oid =
         'worldgraph_jsonb_has_sensitive_key(jsonb)'::regprocedure`,
    );
    expect(catalog.rows).toEqual([
      {
        app_can_execute: true,
        owner_name: 'worldgraph_owner',
        proconfig: ['search_path=pg_catalog'],
        proparallel: 's',
        prosecdef: false,
        provolatile: 'i',
        public_can_execute: false,
        tally_can_execute: false,
      },
    ]);

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    const app = createDatabaseClient(appUrl.toString(), 'restricted-sensitive-key-app');
    const connection = await app.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local search_path = pg_catalog`);
      await expect(
        connection.query<{
          nested_array: boolean;
          nested_object: boolean;
          safe_document: boolean;
        }>(
          `select
             public.worldgraph_jsonb_has_sensitive_key(
               '{"outer":{"Password":"redacted"}}'::jsonb
             ) as nested_object,
             public.worldgraph_jsonb_has_sensitive_key(
               '[{"outer":[{"api_key":"redacted"}]}]'::jsonb
             ) as nested_array,
             public.worldgraph_jsonb_has_sensitive_key(
               '{"outer":[{"displayName":"Safe"}]}'::jsonb
             ) as safe_document`,
        ),
      ).resolves.toMatchObject({
        rows: [{ nested_array: true, nested_object: true, safe_document: false }],
      });
      await connection.query('rollback');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
      await app.pool.end();
    }
  });

  it('projects exact frozen eligibility and replacement state without granting source-table reads', async () => {
    const userId = '018f0000-0000-7000-8000-00000000aa01';
    const worldId = '018f0000-0000-7000-8000-00000000aa02';
    const versionId = '018f0000-0000-7000-8000-00000000aa03';
    const entityId = '018f0000-0000-7000-8000-00000000aa04';
    const proposalId = '018f0000-0000-7000-8000-00000000aa05';
    const contestId = '018f0000-0000-7000-8000-00000000aa06';
    const snapshotId = '018f0000-0000-7000-8000-00000000aa07';
    const otherSnapshotId = '018f0000-0000-7000-8000-00000000aa08';
    const commandId = '018f0000-0000-7000-8000-00000000aa09';
    const eventId = '018f0000-0000-7000-8000-00000000aa10';
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `insert into users(id,email,password_hash,display_name)
         values ($1,'capability-reader@example.test',$2,'Capability Reader')`,
        [userId, passwordHash],
      );
      await connection.query(
        `insert into worlds(
           id,slug,name,lifecycle,created_by_user_id,active_world_version_id
         ) values ($1,'capability-reader','Capability Reader','active',$2,$3)`,
        [worldId, userId, versionId],
      );
      await connection.query(
        `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
         values ($1,$2,'player',$2)`,
        [worldId, userId],
      );
      await connection.query(
        `insert into world_entities(
           id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id,row_version
         ) values (
           $1,$2,'character:capability-reader','player_character',1,
           '{"blueprintLogicalKey":"actor:resident",
             "homeDistrictLogicalKey":"district:civic-platform",
             "membershipRole":"player","name":"Capability Reader",
             "organizationLogicalKey":null}'::jsonb,$3,0
         )`,
        [entityId, worldId, versionId],
      );
      await connection.query(
        `insert into world_entity_controllers(
           world_id,user_id,entity_id,control_scope,granted_world_version_id
         ) values ($1,$2,$3,'primary',$4)`,
        [worldId, userId, entityId, versionId],
      );
      await connection.query(
        `insert into world_governance_heads(
           world_id,source_world_version_id,seed_plan_hash,checksum,
           updated_state_revision,initialized_command_id,initialized_event_id
         ) values ($1,$2,decode(repeat('a1',32),'hex'),decode(repeat('a2',32),'hex'),
                   1,$3,$4)`,
        [worldId, versionId, commandId, eventId],
      );
      await connection.query(
        `insert into proposals(
           id,world_id,institution_id,jurisdiction_entity_id,proposer_entity_id,
           proposal_type,title,body,status,sponsorship_closes_tick,
           debate_closes_tick,voting_opens_tick,voting_closes_tick,
           minimum_sponsors,quorum_numerator,quorum_denominator,
           threshold_numerator,threshold_denominator,ballot_mode,
           ballot_disclosure,allow_ballot_replacement,target_versions,
           aggregate_version,created_command_id,created_event_id,created_state_revision
         ) values (
           $1,$2,'018f0000-0000-7000-8000-00000000aa11',
           '018f0000-0000-7000-8000-00000000aa12',$3,'ordinary',
           'Capability projection','Exact frozen voter evidence.','open',0,0,1,20,
           0,0,10000,5001,10000,'public','choice_totals',true,'{}'::jsonb,
           1,$4,$5,1
         )`,
        [proposalId, worldId, entityId, commandId, eventId],
      );
      await connection.query(
        `insert into governance_contests(
           id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
           opens_tick,closes_tick,allow_replacement,aggregate_version,
           created_command_id,created_event_id,created_state_revision
         ) values ($1,$2,'proposal','public','choice_totals','open',1,20,true,1,$3,$4,1)`,
        [contestId, worldId, commandId, eventId],
      );
      await connection.query(
        `insert into proposal_contests(contest_id,world_id,proposal_id,question)
         values ($1,$2,$3,'Is this exact voter eligible?')`,
        [contestId, worldId, proposalId],
      );
      await connection.query(
        `insert into eligibility_snapshots(
           id,world_id,contest_id,snapshot_tick,source_state_revision,
           source_membership_cursor,eligible_count,rule_snapshot,checksum,
           generated_command_id,generated_event_id
         ) values ($1,$2,$3,1,1,1,1,'{}'::jsonb,
                   decode(repeat('a3',32),'hex'),$4,$5)`,
        [snapshotId, worldId, contestId, commandId, eventId],
      );
      await connection.query(
        `insert into eligibility_snapshot_members(
           id,world_id,snapshot_id,contest_id,voter_entity_id,voting_weight,
           eligibility_basis,member_hash
         ) values (
           '018f0000-0000-7000-8000-00000000aa13',$1,$2,$3,$4,1,
           '{}'::jsonb,decode(repeat('a4',32),'hex')
         )`,
        [worldId, snapshotId, contestId, entityId],
      );
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    const app = createDatabaseClient(appUrl.toString(), 'governance-capability-reader-app');
    const read = (checkedSnapshotId: string) =>
      app.pool.query<{
        actor_entity_id: string | null;
        actor_entity_key: string | null;
        ballot_replacement_allowed: boolean;
        candidate_eligible: boolean;
        eligible: boolean;
        has_ballot: boolean;
        membership_role: string;
      }>(
        `select actor_entity_id::text,actor_entity_key,membership_role,eligible,
                candidate_eligible,has_ballot,ballot_replacement_allowed
           from worldgraph_governance_actor_capability_v1($1,$2,'proposal',$3,$4)`,
        [worldId, userId, proposalId, checkedSnapshotId],
      );
    try {
      await expect(read(snapshotId)).resolves.toMatchObject({
        rows: [
          {
            actor_entity_id: entityId,
            actor_entity_key: 'character:capability-reader',
            ballot_replacement_allowed: false,
            candidate_eligible: false,
            eligible: true,
            has_ballot: false,
            membership_role: 'player',
          },
        ],
      });
      await expect(read(otherSnapshotId)).resolves.toMatchObject({
        rows: [{ eligible: false, has_ballot: false }],
      });

      const ballot = await owner.pool.connect();
      try {
        await ballot.query('begin');
        await ballot.query(`set local session_replication_role = 'replica'`);
        await ballot.query(
          `insert into ballot_participation(
             id,world_id,contest_id,eligibility_snapshot_id,voter_entity_id,
             ballot_mode,current_revision,aggregate_version,first_cast_tick,last_cast_tick
           ) values (
             '018f0000-0000-7000-8000-00000000aa14',$1,$2,$3,$4,
             'public',1,1,2,2
           )`,
          [worldId, contestId, snapshotId, entityId],
        );
        await ballot.query('commit');
      } catch (error) {
        await ballot.query('rollback');
        throw error;
      } finally {
        ballot.release();
      }
      await expect(read(snapshotId)).resolves.toMatchObject({
        rows: [{ ballot_replacement_allowed: true, eligible: true, has_ballot: true }],
      });
    } finally {
      await app.pool.end();
    }
  });

  it('seals compiler lanes and exactly six governance scheduler actions', async () => {
    const catalog = await owner.pool.query<{
      artifact_guard: string;
      schedule_constraint: string;
    }>(
      `select
         pg_get_functiondef(
           'worldgraph_assert_compiler_artifact_version_pair()'::regprocedure
         ) as artifact_guard,
         pg_get_constraintdef(constraint_record.oid) as schedule_constraint
       from pg_constraint constraint_record
       where constraint_record.conrelid = 'scheduled_actions'::regclass
         and constraint_record.conname = 'scheduled_actions_registry_known'`,
    );
    expect(catalog.rows).toHaveLength(1);
    for (const [compilerVersion, artifactVersion] of [
      ['1.0.0', '1'],
      ['1.1.0', '2'],
      ['1.2.0', '3'],
      ['1.3.0', '4'],
    ]) {
      expect(catalog.rows[0]?.artifact_guard).toContain(`compiler_version = '${compilerVersion}'`);
      expect(catalog.rows[0]?.artifact_guard).toContain(
        `artifact_schema_version = ${artifactVersion}`,
      );
    }
    const scheduled = governanceScheduledActions.filter((action) =>
      catalog.rows[0]?.schedule_constraint.includes(`'${action}'`),
    );
    expect(scheduled).toEqual(governanceScheduledActions);
    expect(catalog.rows[0]?.schedule_constraint).toContain("process_version = '1.0.0'");

    const schedulePairs = await owner.pool.query<{
      adopt_close: boolean;
      adopt_open: boolean;
      create_certify: boolean;
      initialize_certify: boolean;
      unrelated: boolean;
    }>(
      `select
         worldgraph_schedule_pair_is_valid_v2(
           'CreateProposalV1','CertifyAndEnactProposalV1'
         ) as create_certify,
         worldgraph_schedule_pair_is_valid_v2(
           'AdoptGovernanceSeedPlanV1','OpenElectionV1'
         ) as adopt_open,
         worldgraph_schedule_pair_is_valid_v2(
           'AdoptGovernanceSeedPlanV1','CloseAndTallyElectionV1'
         ) as adopt_close,
         worldgraph_schedule_pair_is_valid_v2(
           'InitializeWorldGovernanceV1','CertifyElectionV1'
         ) as initialize_certify,
         worldgraph_schedule_pair_is_valid_v2(
           'CreateProposalV1','CertifyElectionV1'
         ) as unrelated`,
    );
    expect(schedulePairs.rows).toEqual([
      {
        adopt_close: true,
        adopt_open: true,
        create_certify: true,
        initialize_certify: true,
        unrelated: false,
      },
    ]);
    const scheduleGuards = await owner.pool.query<{
      allocation_guard: string;
      creation_guard: string;
      head_guard: string;
    }>(
      `select
         pg_get_functiondef(
           'worldgraph_allocate_schedule_sequence(uuid)'::regprocedure
         ) as allocation_guard,
         pg_get_functiondef(
           'worldgraph_protect_schedule_head()'::regprocedure
         ) as head_guard,
         pg_get_functiondef(
           'worldgraph_assert_scheduled_action_command()'::regprocedure
         ) as creation_guard`,
    );
    expect(scheduleGuards.rows[0]?.allocation_guard).toContain('AdoptGovernanceSeedPlanV1');
    expect(scheduleGuards.rows[0]?.head_guard).toContain('AdoptGovernanceSeedPlanV1');
    expect(scheduleGuards.rows[0]?.creation_guard).toContain('ScheduledActionCreatedV1');
    expect(scheduleGuards.rows[0]?.creation_guard).toContain("command.status = 'accepted'");

    const payloadConstraint = await owner.pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'scheduled_actions'::regclass
          and conname = 'scheduled_actions_payload_safe'`,
    );
    expect(payloadConstraint.rows[0]?.definition).toContain('proposalId');
    expect(payloadConstraint.rows[0]?.definition).toContain('electionId');
    expect(payloadConstraint.rows[0]?.definition).not.toContain('choicePayload');
  });

  it('enforces the dedicated tally-role and secret-ballot privilege boundary', async () => {
    const role = await owner.pool.query<{
      rolcanlogin: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
    }>(
      `select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit
         from pg_roles where rolname = 'worldgraph_governance_tally'`,
    );
    expect(role.rows).toEqual([
      {
        rolcanlogin: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolsuper: false,
      },
    ]);

    const functions = await owner.pool.query<{
      name: string;
      proconfig: string[];
      prosecdef: boolean;
    }>(
      `select proname as name,prosecdef,proconfig
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in (
            'worldgraph_cast_governance_ballot_v1',
            'worldgraph_election_tally_for_certification_v1',
            'worldgraph_governance_ballot_receipt_v1',
            'worldgraph_governance_election_result_counts_v1',
            'worldgraph_governance_election_result_v1',
            'worldgraph_governance_proposal_result_v1',
            'worldgraph_assert_ballot_choice_storage_v1',
            'worldgraph_assert_effective_ballot_revision_v1',
            'worldgraph_persist_election_tally_v1',
            'worldgraph_persist_proposal_tally_v1',
            'worldgraph_recount_election_result_v1',
            'worldgraph_recount_proposal_result_v1',
            'worldgraph_proposal_tally_for_certification_v1'
          )
        order by proname`,
    );
    expect(functions.rows).toEqual([
      {
        name: 'worldgraph_assert_ballot_choice_storage_v1',
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_assert_effective_ballot_revision_v1',
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_cast_governance_ballot_v1',
        proconfig: ['search_path=pg_catalog, public, extensions'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_election_tally_for_certification_v1',
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_governance_ballot_receipt_v1',
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_governance_election_result_counts_v1',
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_governance_election_result_v1',
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_governance_proposal_result_v1',
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_persist_election_tally_v1',
        proconfig: ['search_path=pg_catalog, public, extensions'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_persist_proposal_tally_v1',
        proconfig: ['search_path=pg_catalog, public, extensions'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_proposal_tally_for_certification_v1',
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_recount_election_result_v1',
        proconfig: ['search_path=pg_catalog, public, extensions'],
        prosecdef: true,
      },
      {
        name: 'worldgraph_recount_proposal_result_v1',
        proconfig: ['search_path=pg_catalog, public, extensions'],
        prosecdef: true,
      },
    ]);

    const tallyPrivileges = await owner.pool.query<{
      app_can_execute: boolean;
      app_can_insert: boolean;
      public_can_execute: boolean;
      tally_can_insert: boolean;
    }>(
      `select
         has_function_privilege(
           'worldgraph_app',
           'worldgraph_persist_proposal_tally_v1(uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,integer,integer,integer,integer,bytea,bytea,bigint,uuid,uuid,uuid,uuid)',
           'EXECUTE'
         ) as app_can_execute,
         has_table_privilege('worldgraph_app','proposal_tallies','INSERT')
           as app_can_insert,
         coalesce(aclcontains(
           proacl,makeaclitem(0,proowner,'EXECUTE',false)
         ),false) as public_can_execute,
         has_table_privilege(
           'worldgraph_governance_tally','proposal_tallies','INSERT'
         ) as tally_can_insert
       from pg_proc
      where oid = 'worldgraph_persist_proposal_tally_v1(uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,integer,integer,integer,integer,bytea,bytea,bigint,uuid,uuid,uuid,uuid)'::regprocedure`,
    );
    expect(tallyPrivileges.rows).toEqual([
      {
        app_can_execute: true,
        app_can_insert: false,
        public_can_execute: false,
        tally_can_insert: false,
      },
    ]);
    const narrowFunctions = await owner.pool.query<{
      app_can_execute: boolean;
      name: string;
      public_can_execute: boolean;
      tally_can_execute: boolean;
    }>(
      `select procedure.proname as name,
         has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
           as app_can_execute,
         has_function_privilege(
           'worldgraph_governance_tally',procedure.oid,'EXECUTE'
         ) as tally_can_execute,
         aclcontains(
           procedure.proacl,makeaclitem(0,procedure.proowner,'EXECUTE',false)
         ) as public_can_execute
       from pg_proc procedure
      where procedure.pronamespace = 'public'::regnamespace
        and procedure.proname in (
          'worldgraph_persist_proposal_tally_v1',
          'worldgraph_persist_election_tally_v1',
          'worldgraph_recount_proposal_result_v1',
          'worldgraph_recount_election_result_v1',
          'worldgraph_proposal_tally_for_certification_v1',
          'worldgraph_election_tally_for_certification_v1',
          'worldgraph_governance_proposal_result_v1',
          'worldgraph_governance_election_result_v1',
          'worldgraph_governance_election_result_counts_v1'
        )
      order by procedure.proname`,
    );
    expect(narrowFunctions.rows).toEqual(
      [
        'worldgraph_election_tally_for_certification_v1',
        'worldgraph_governance_election_result_counts_v1',
        'worldgraph_governance_election_result_v1',
        'worldgraph_governance_proposal_result_v1',
        'worldgraph_persist_election_tally_v1',
        'worldgraph_persist_proposal_tally_v1',
        'worldgraph_proposal_tally_for_certification_v1',
        'worldgraph_recount_election_result_v1',
        'worldgraph_recount_proposal_result_v1',
      ].map((name) => ({
        app_can_execute: true,
        name,
        public_can_execute: false,
        tally_can_execute: false,
      })),
    );
    const recountResults = await owner.pool.query<{ name: string; result_type: string }>(
      `select proname as name,pg_get_function_result(oid) as result_type
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in (
            'worldgraph_recount_proposal_result_v1',
            'worldgraph_recount_election_result_v1'
          )
        order by proname`,
    );
    expect(recountResults.rows).toEqual([
      {
        name: 'worldgraph_recount_election_result_v1',
        result_type:
          'TABLE(result_id uuid, tally_id uuid, input_checksum bytea, result_checksum bytea, outcome text, winning_candidacy_id uuid)',
      },
      {
        name: 'worldgraph_recount_proposal_result_v1',
        result_type:
          'TABLE(result_id uuid, tally_id uuid, input_checksum bytea, result_checksum bytea, outcome text, quorum_met boolean, threshold_met boolean)',
      },
    ]);
    for (const result of recountResults.rows) {
      expect(result.result_type).not.toMatch(/ballot|choice|voter/i);
    }
    const publicResultReads = await owner.pool.query<{ name: string; result_type: string }>(
      `select proname as name,pg_get_function_result(oid) as result_type
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in (
            'worldgraph_governance_proposal_result_v1',
            'worldgraph_governance_election_result_v1',
            'worldgraph_governance_election_result_counts_v1'
          )
        order by proname`,
    );
    expect(publicResultReads.rows).toEqual([
      {
        name: 'worldgraph_governance_election_result_counts_v1',
        result_type: 'TABLE(count_kind text, ballot_count integer, candidate_key text)',
      },
      {
        name: 'worldgraph_governance_election_result_v1',
        result_type:
          'TABLE(result_id uuid, election_id uuid, outcome text, result_checksum bytea, input_checksum bytea, eligible_count integer, turnout_count integer, winner_candidate_key text, abstain_count integer)',
      },
      {
        name: 'worldgraph_governance_proposal_result_v1',
        result_type:
          'TABLE(result_id uuid, proposal_id uuid, outcome text, result_checksum bytea, input_checksum bytea, eligible_count integer, turnout_count integer, yes_count integer, no_count integer, abstain_count integer)',
      },
    ]);
    const publicResultArguments = await owner.pool.query<{
      argument_names: string[];
      name: string;
      owner_name: string;
      proconfig: string[];
      proisstrict: boolean;
      prosecdef: boolean;
      provolatile: string;
    }>(
      `select proname as name,proargnames[1:pronargs] as argument_names,
              pg_get_userbyid(proowner) as owner_name,proconfig,proisstrict,
              prosecdef,provolatile
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in (
            'worldgraph_governance_proposal_result_v1',
            'worldgraph_governance_election_result_v1',
            'worldgraph_governance_election_result_counts_v1'
          )
        order by proname`,
    );
    expect(publicResultArguments.rows).toEqual([
      {
        argument_names: ['checked_world_id', 'checked_actor_user_id', 'checked_result_id'],
        name: 'worldgraph_governance_election_result_counts_v1',
        owner_name: 'worldgraph_owner',
        proconfig: ['search_path=pg_catalog, public'],
        proisstrict: true,
        prosecdef: true,
        provolatile: 's',
      },
      {
        argument_names: ['checked_world_id', 'checked_actor_user_id', 'checked_election_id'],
        name: 'worldgraph_governance_election_result_v1',
        owner_name: 'worldgraph_owner',
        proconfig: ['search_path=pg_catalog, public'],
        proisstrict: true,
        prosecdef: true,
        provolatile: 's',
      },
      {
        argument_names: ['checked_world_id', 'checked_actor_user_id', 'checked_proposal_id'],
        name: 'worldgraph_governance_proposal_result_v1',
        owner_name: 'worldgraph_owner',
        proconfig: ['search_path=pg_catalog, public'],
        proisstrict: true,
        prosecdef: true,
        provolatile: 's',
      },
    ]);
    const tallyWrites = await owner.pool.query<{ table_name: string }>(
      `select distinct table_name
         from information_schema.role_table_grants
        where grantee = 'worldgraph_governance_tally'
          and table_schema = 'public'
          and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER')
        order by table_name`,
    );
    expect(tallyWrites.rows).toEqual([]);

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    const app = createDatabaseClient(appUrl.toString(), 'governance-app-boundary');
    const tallyUrl = new URL(container.getConnectionUri());
    tallyUrl.username = 'worldgraph_governance_tally';
    tallyUrl.password = 'worldgraph_governance_tally_local_only';
    const tally = createDatabaseClient(tallyUrl.toString(), 'governance-tally-boundary');
    try {
      await expect(
        app.pool.query('select count(*) from secret_ballot_choices'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query('select count(*) from ballot_choice_revisions'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query('select count(*) from ballot_effective_revisions'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query('select worldgraph_assert_ballot_choice_storage_v1()'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query('select worldgraph_assert_effective_ballot_revision_v1()'),
      ).rejects.toMatchObject({ code: '42501' });
      for (const table of [
        'proposal_tallies',
        'proposal_tally_counts',
        'election_tallies',
        'election_tally_counts',
      ]) {
        await expect(app.pool.query(`select count(*) from ${table}`)).rejects.toMatchObject({
          code: '42501',
        });
      }
      await expect(
        app.pool.query(
          `insert into aggregate_stream_heads(
             world_id,aggregate_type,aggregate_id,current_version
           ) values (
             '018f0000-0000-7000-8000-00000000aa01','election',
             '018f0000-0000-7000-8000-00000000aa02',1
           )`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query(`update aggregate_stream_heads set current_version=current_version`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query(
          `select * from worldgraph_recount_proposal_result_v1(
             null::uuid,null::uuid,null::uuid,null::uuid,null::uuid,null::uuid,
             null::uuid,null::bytea,null::bytea,null::uuid,null::uuid,
             null::bigint,null::bigint
           )`,
        ),
      ).rejects.toMatchObject({ code: '22023' });
      await expect(
        tally.pool.query('select count(*) from secret_ballot_choices'),
      ).resolves.toBeDefined();
      await expect(
        tally.pool.query('select count(*) from ballot_participation'),
      ).rejects.toMatchObject({ code: '42501' });
      for (const functionName of [
        'worldgraph_governance_proposal_result_v1',
        'worldgraph_governance_election_result_v1',
        'worldgraph_governance_election_result_counts_v1',
      ]) {
        await expect(
          tally.pool.query(
            `select * from ${functionName}(
               '018f0000-0000-7000-8000-00000000aa01'::uuid,
               '018f0000-0000-7000-8000-00000000aa02'::uuid,
               '018f0000-0000-7000-8000-00000000aa03'::uuid
             )`,
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }
      await expect(
        tally.pool.query('insert into proposal_tallies default values'),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(tally.pool.query('select count(*) from users')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(tally.pool.query('select count(*) from wallet_balances')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        tally.pool.query(
          `select * from worldgraph_recount_proposal_result_v1(
             null::uuid,null::uuid,null::uuid,null::uuid,null::uuid,null::uuid,
             null::uuid,null::bytea,null::bytea,null::uuid,null::uuid,
             null::bigint,null::bigint
           )`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await Promise.all([app.pool.end(), tally.pool.end()]);
    }
  });

  it('serves only current aggregate governance results to active same-world members', async () => {
    const ids = {
      activeUser: '018f0000-0000-7000-8000-00000000ac02',
      alphaCandidacy: '018f0000-0000-7000-8000-00000000ac29',
      alphaEntity: '018f0000-0000-7000-8000-00000000ac27',
      command: '018f0000-0000-7000-8000-00000000ac07',
      election: '018f0000-0000-7000-8000-00000000ac20',
      electionContest: '018f0000-0000-7000-8000-00000000ac21',
      electionReplacementResult: '018f0000-0000-7000-8000-00000000ac26',
      electionReplacementTally: '018f0000-0000-7000-8000-00000000ac24',
      electionSnapshot: '018f0000-0000-7000-8000-00000000ac22',
      electionSourceResult: '018f0000-0000-7000-8000-00000000ac25',
      electionSourceTally: '018f0000-0000-7000-8000-00000000ac23',
      event: '018f0000-0000-7000-8000-00000000ac08',
      nonmemberUser: '018f0000-0000-7000-8000-00000000ac04',
      proposal: '018f0000-0000-7000-8000-00000000ac10',
      proposalContest: '018f0000-0000-7000-8000-00000000ac11',
      proposalReplacementResult: '018f0000-0000-7000-8000-00000000ac16',
      proposalReplacementTally: '018f0000-0000-7000-8000-00000000ac14',
      proposalSnapshot: '018f0000-0000-7000-8000-00000000ac12',
      proposalSourceResult: '018f0000-0000-7000-8000-00000000ac15',
      proposalSourceTally: '018f0000-0000-7000-8000-00000000ac13',
      removedUser: '018f0000-0000-7000-8000-00000000ac03',
      sourceWorldVersion: '018f0000-0000-7000-8000-00000000ac06',
      world: '018f0000-0000-7000-8000-00000000ac01',
      wrongWorld: '018f0000-0000-7000-8000-00000000ac05',
      zuluCandidacy: '018f0000-0000-7000-8000-00000000ac2a',
      zuluEntity: '018f0000-0000-7000-8000-00000000ac28',
    } as const;

    const fixture = await owner.pool.connect();
    try {
      await fixture.query('begin');
      await fixture.query(`set local session_replication_role = 'replica'`);
      await fixture.query(
        `insert into world_memberships(
           world_id,user_id,role,status,removed_at,granted_by_user_id
         ) values
         ($1,$2,'player','active',null,$2),
         ($1,$3,'player','removed',transaction_timestamp(),$3)`,
        [ids.world, ids.activeUser, ids.removedUser],
      );
      await fixture.query(
        `insert into world_governance_heads(
           world_id,source_world_version_id,seed_plan_hash,checksum,
           updated_state_revision,initialized_command_id,initialized_event_id
         ) values (
           $1,$2,decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),
           1,$3,$4
         )`,
        [ids.world, ids.sourceWorldVersion, ids.command, ids.event],
      );
      await fixture.query(
        `insert into world_entities(
           id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id,row_version
         ) values
         ($1,$3,'character:alpha','player_character',1,$4,$5,1),
         ($2,$3,'character:zulu','player_character',1,$6,$5,1)`,
        [
          ids.alphaEntity,
          ids.zuluEntity,
          ids.world,
          {
            blueprintLogicalKey: 'blueprint:citizen',
            homeDistrictLogicalKey: 'district:test',
            membershipRole: 'player',
            name: 'Alpha Candidate',
            organizationLogicalKey: null,
          },
          ids.sourceWorldVersion,
          {
            blueprintLogicalKey: 'blueprint:citizen',
            homeDistrictLogicalKey: 'district:test',
            membershipRole: 'player',
            name: 'Zulu Candidate',
            organizationLogicalKey: null,
          },
        ],
      );
      await fixture.query(
        `insert into candidacies(
           id,world_id,election_id,contest_id,candidate_entity_id,status,
           nomination_tick,aggregate_version,nominated_command_id,
           nominated_event_id,accepted_command_id,accepted_event_id
         ) values
         ($1,$3,$4,$5,$6,'accepted',1,2,$7,$8,$7,$8),
         ($2,$3,$4,$5,$9,'accepted',1,2,$7,$8,$7,$8)`,
        [
          ids.alphaCandidacy,
          ids.zuluCandidacy,
          ids.world,
          ids.election,
          ids.electionContest,
          ids.alphaEntity,
          ids.command,
          ids.event,
          ids.zuluEntity,
        ],
      );
      await fixture.query(
        `insert into proposal_tallies(
           id,world_id,contest_id,proposal_id,eligibility_snapshot_id,
           tally_version,algorithm_version,eligible_count,participating_count,
           quorum_required,approval_required,input_checksum,output_checksum,
           recount_of_tally_id,tallied_tick
         ) values
         ($1,$3,$4,$5,$6,1,'proposal_yes_no_v1',5,2,2,1,
          decode(repeat('11',32),'hex'),decode(repeat('12',32),'hex'),null,10),
         ($2,$3,$4,$5,$6,2,'proposal_yes_no_v1',5,5,2,2,
          decode(repeat('21',32),'hex'),decode(repeat('22',32),'hex'),$1,11)`,
        [
          ids.proposalSourceTally,
          ids.proposalReplacementTally,
          ids.world,
          ids.proposalContest,
          ids.proposal,
          ids.proposalSnapshot,
        ],
      );
      await fixture.query(
        `insert into proposal_tally_counts(
           id,world_id,tally_id,choice_code,ballot_count,weighted_count
         ) values
         ('018f0000-0000-7000-8000-00000000ac17',$1,$2,'yes',1,1),
         ('018f0000-0000-7000-8000-00000000ac18',$1,$2,'no',1,1),
         ('018f0000-0000-7000-8000-00000000ac19',$1,$2,'abstain',0,0),
         ('018f0000-0000-7000-8000-00000000ac1a',$1,$3,'yes',3,3),
         ('018f0000-0000-7000-8000-00000000ac1b',$1,$3,'no',1,1),
         ('018f0000-0000-7000-8000-00000000ac1c',$1,$3,'abstain',1,1)`,
        [ids.world, ids.proposalSourceTally, ids.proposalReplacementTally],
      );
      await fixture.query(
        `insert into proposal_results(
           id,world_id,contest_id,proposal_id,tally_id,outcome,quorum_met,
           threshold_met,result_checksum,certified_command_id,certified_event_id,
           certified_state_revision,certified_tick,repair_of_result_id
         ) values
         ($1,$3,$4,$5,$6,'rejected_threshold',true,false,
          decode(repeat('12',32),'hex'),$7,$8,1,10,null),
         ($2,$3,$4,$5,$9,'passed',true,true,
          decode(repeat('22',32),'hex'),$7,$8,2,11,$1)`,
        [
          ids.proposalSourceResult,
          ids.proposalReplacementResult,
          ids.world,
          ids.proposalContest,
          ids.proposal,
          ids.proposalSourceTally,
          ids.command,
          ids.event,
          ids.proposalReplacementTally,
        ],
      );
      await fixture.query(
        `insert into election_tallies(
           id,world_id,contest_id,election_id,eligibility_snapshot_id,
           tally_version,algorithm_version,eligible_count,participating_count,
           input_checksum,output_checksum,recount_of_tally_id,tallied_tick
         ) values
         ($1,$3,$4,$5,$6,1,'election_plurality_v1',8,3,
          decode(repeat('31',32),'hex'),decode(repeat('32',32),'hex'),null,10),
         ($2,$3,$4,$5,$6,2,'election_plurality_v1',8,6,
          decode(repeat('41',32),'hex'),decode(repeat('42',32),'hex'),$1,11)`,
        [
          ids.electionSourceTally,
          ids.electionReplacementTally,
          ids.world,
          ids.electionContest,
          ids.election,
          ids.electionSnapshot,
        ],
      );
      await fixture.query(
        `insert into election_tally_counts(
           id,world_id,tally_id,candidacy_id,count_kind,ballot_count,weighted_count
         ) values
         ('018f0000-0000-7000-8000-00000000ac2b',$1,$2,$4,'candidate',1,1),
         ('018f0000-0000-7000-8000-00000000ac2c',$1,$2,$5,'candidate',1,1),
         ('018f0000-0000-7000-8000-00000000ac2d',$1,$2,null,'abstain',1,1),
         ('018f0000-0000-7000-8000-00000000ac2e',$1,$3,$5,'candidate',1,1),
         ('018f0000-0000-7000-8000-00000000ac2f',$1,$3,null,'abstain',1,1),
         ('018f0000-0000-7000-8000-00000000ac30',$1,$3,$4,'candidate',4,4)`,
        [
          ids.world,
          ids.electionSourceTally,
          ids.electionReplacementTally,
          ids.alphaCandidacy,
          ids.zuluCandidacy,
        ],
      );
      await fixture.query(
        `insert into election_results(
           id,world_id,contest_id,election_id,tally_id,outcome,
           winning_candidacy_id,result_checksum,certified_command_id,
           certified_event_id,certified_state_revision,certified_tick,
           repair_of_result_id
         ) values
         ($1,$3,$4,$5,$6,'vacant_tie',null,decode(repeat('32',32),'hex'),
          $7,$8,1,10,null),
         ($2,$3,$4,$5,$9,'elected',$10,decode(repeat('42',32),'hex'),
          $7,$8,2,11,$1)`,
        [
          ids.electionSourceResult,
          ids.electionReplacementResult,
          ids.world,
          ids.electionContest,
          ids.election,
          ids.electionSourceTally,
          ids.command,
          ids.event,
          ids.electionReplacementTally,
          ids.alphaCandidacy,
        ],
      );
      await fixture.query('commit');
    } catch (error) {
      await fixture.query('rollback');
      throw error;
    } finally {
      fixture.release();
    }

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    const app = createDatabaseClient(appUrl.toString(), 'governance-result-read-behavior');
    try {
      const proposal = await app.pool.query<{
        abstain_count: number;
        eligible_count: number;
        input_checksum: string;
        no_count: number;
        outcome: string;
        proposal_id: string;
        result_checksum: string;
        result_id: string;
        turnout_count: number;
        yes_count: number;
      }>(
        `select result_id::text,proposal_id::text,outcome,
                encode(result_checksum,'hex') as result_checksum,
                encode(input_checksum,'hex') as input_checksum,
                eligible_count,turnout_count,yes_count,no_count,abstain_count
           from worldgraph_governance_proposal_result_v1($1,$2,$3)`,
        [ids.world, ids.activeUser, ids.proposal],
      );
      expect(proposal.rows).toEqual([
        {
          abstain_count: 1,
          eligible_count: 5,
          input_checksum: '21'.repeat(32),
          no_count: 1,
          outcome: 'passed',
          proposal_id: ids.proposal,
          result_checksum: '22'.repeat(32),
          result_id: ids.proposalReplacementResult,
          turnout_count: 5,
          yes_count: 3,
        },
      ]);

      const election = await app.pool.query<{
        abstain_count: number;
        election_id: string;
        eligible_count: number;
        input_checksum: string;
        outcome: string;
        result_checksum: string;
        result_id: string;
        turnout_count: number;
        winner_candidate_key: string;
      }>(
        `select result_id::text,election_id::text,outcome,
                encode(result_checksum,'hex') as result_checksum,
                encode(input_checksum,'hex') as input_checksum,
                eligible_count,turnout_count,winner_candidate_key,abstain_count
           from worldgraph_governance_election_result_v1($1,$2,$3)`,
        [ids.world, ids.activeUser, ids.election],
      );
      expect(election.rows).toEqual([
        {
          abstain_count: 1,
          election_id: ids.election,
          eligible_count: 8,
          input_checksum: '41'.repeat(32),
          outcome: 'elected',
          result_checksum: '42'.repeat(32),
          result_id: ids.electionReplacementResult,
          turnout_count: 6,
          winner_candidate_key: 'character:alpha',
        },
      ]);

      const counts = await app.pool.query<{
        ballot_count: number;
        candidate_key: string | null;
        count_kind: string;
      }>(
        `select count_kind,ballot_count,candidate_key
           from worldgraph_governance_election_result_counts_v1($1,$2,$3)`,
        [ids.world, ids.activeUser, ids.electionReplacementResult],
      );
      expect(counts.rows).toEqual([
        { ballot_count: 4, candidate_key: 'character:alpha', count_kind: 'candidate' },
        { ballot_count: 1, candidate_key: 'character:zulu', count_kind: 'candidate' },
        { ballot_count: 1, candidate_key: null, count_kind: 'abstain' },
      ]);
      await expect(
        app.pool.query(`select * from worldgraph_governance_election_result_counts_v1($1,$2,$3)`, [
          ids.world,
          ids.activeUser,
          ids.electionSourceResult,
        ]),
      ).resolves.toMatchObject({ rows: [] });

      for (const access of [
        { actor: ids.nonmemberUser, world: ids.world },
        { actor: ids.activeUser, world: ids.wrongWorld },
        { actor: ids.removedUser, world: ids.world },
      ]) {
        await expect(
          app.pool.query(`select * from worldgraph_governance_proposal_result_v1($1,$2,$3)`, [
            access.world,
            access.actor,
            ids.proposal,
          ]),
        ).resolves.toMatchObject({ rows: [] });
        await expect(
          app.pool.query(`select * from worldgraph_governance_election_result_v1($1,$2,$3)`, [
            access.world,
            access.actor,
            ids.election,
          ]),
        ).resolves.toMatchObject({ rows: [] });
        await expect(
          app.pool.query(
            `select * from worldgraph_governance_election_result_counts_v1($1,$2,$3)`,
            [access.world, access.actor, ids.electionReplacementResult],
          ),
        ).resolves.toMatchObject({ rows: [] });
      }
    } finally {
      await app.pool.end();
    }
  });

  it('evaluates the finite governance policy DSL in SQL and fails closed', async () => {
    const policy = {
      kind: 'all',
      operands: [
        { kind: 'actor_mode', mode: 'in_world' },
        { kind: 'membership_role', role: 'player' },
        { kind: 'member_of_organization', organizationKey: 'organization:harbor-guild' },
        { action: 'governance.vote', kind: 'action' },
        { kind: 'resource', resourceKey: null, resourceType: 'proposal' },
        { fromTick: '10', kind: 'tick_between', untilTick: '20' },
        {
          kind: 'any',
          operands: [
            { kind: 'holds_office', officeKey: 'office:council-speaker' },
            {
              kind: 'not',
              operand: { kind: 'membership_role', role: 'suspended' },
            },
          ],
        },
      ],
    };
    const seedPlan = {
      charter: {
        citizenEligibilityPolicy: { kind: 'membership_role', role: 'player' },
        effectiveFromTick: '0',
        effectiveUntilTick: null,
        proposalRules: {
          approvalThresholdBps: 5_001,
          ballotPolicy: {
            ballotMode: 'public',
            disclosure: 'choice_totals',
            replacementAllowed: true,
          },
          debateTicks: '1',
          minimumSponsors: 0,
          quorumBps: 0,
          sponsorshipTicks: '1',
          votingTicks: '1',
        },
        stableKey: 'charter:integration-test',
        summary: 'A bounded integration-test charter.',
        title: 'Integration Test Charter',
      },
      governanceSeedPlanSchemaVersion: 1,
      initialLaws: [],
      institutions: [
        {
          displayName: 'Integration Council',
          institutionType: 'council',
          jurisdictionEntityKey: 'jurisdiction:integration-test',
          powers: [],
          stableKey: 'institution:integration-council',
          worldEntityKey: 'entity:integration-council',
        },
      ],
      offices: [
        {
          ballotPolicy: {
            ballotMode: 'public',
            disclosure: 'choice_totals',
            replacementAllowed: true,
          },
          displayName: 'Integration Speaker',
          electionCadenceTicks: '10',
          eligibilityPolicy: { kind: 'membership_role', role: 'player' },
          institutionKey: 'institution:integration-council',
          powers: [],
          seats: 1,
          stableKey: 'office:integration-speaker',
          termDurationTicks: '10',
          tieRule: 'vacancy',
          transitionDelayTicks: '0',
        },
      ],
    };
    const evaluateSql = `select worldgraph_governance_policy_matches_v1(
      $1::jsonb,$2::text,$3::text[],$4::text[],$5::text[],$6::text,$7::text,
      $8::text,$9::bigint
    ) as allowed`;
    const evaluate = (
      checkedPolicy: unknown,
      overrides: Partial<{
        action: string;
        actorMode: string;
        heldOfficeKeys: string[];
        membershipRoles: string[];
        organizationKeys: string[];
        resourceKey: string | null;
        resourceType: string;
        tick: string;
      }> = {},
    ) =>
      owner.pool.query<{ allowed: boolean }>(evaluateSql, [
        checkedPolicy,
        overrides.actorMode ?? 'in_world',
        overrides.membershipRoles ?? ['player'],
        overrides.heldOfficeKeys ?? [],
        overrides.organizationKeys ?? ['organization:harbor-guild'],
        overrides.action ?? 'governance.vote',
        overrides.resourceType ?? 'proposal',
        overrides.resourceKey ?? null,
        overrides.tick ?? '10',
      ]);

    await expect(evaluate(policy)).resolves.toMatchObject({ rows: [{ allowed: true }] });
    await expect(evaluate(policy, { actorMode: 'creator' })).resolves.toMatchObject({
      rows: [{ allowed: false }],
    });
    await expect(evaluate(policy, { tick: '20' })).resolves.toMatchObject({
      rows: [{ allowed: false }],
    });
    await expect(evaluate(policy, { organizationKeys: [] })).resolves.toMatchObject({
      rows: [{ allowed: false }],
    });
    await expect(evaluate({ kind: 'arbitrary_code' })).resolves.toMatchObject({
      rows: [{ allowed: false }],
    });
    await expect(
      evaluate({ kind: 'actor_mode', mode: 'in_world', unexpected: true }),
    ).resolves.toMatchObject({ rows: [{ allowed: false }] });

    let tooDeep: unknown = { kind: 'actor_mode', mode: 'in_world' };
    for (let depth = 0; depth < 4; depth += 1) {
      tooDeep = { kind: 'not', operand: tooDeep };
    }
    await expect(evaluate(tooDeep)).resolves.toMatchObject({ rows: [{ allowed: false }] });
    const tooManyNodes = {
      kind: 'all',
      operands: Array.from({ length: 8 }, () => ({
        kind: 'any',
        operands: Array.from({ length: 8 }, () => ({
          kind: 'actor_mode',
          mode: 'in_world',
        })),
      })),
    };
    await expect(evaluate(tooManyNodes)).resolves.toMatchObject({
      rows: [{ allowed: false }],
    });
    await expect(
      evaluate(policy, { membershipRoles: ['player', 'player'] }),
    ).resolves.toMatchObject({ rows: [{ allowed: false }] });

    const catalog = await owner.pool.query<{
      app_can_execute: boolean;
      proconfig: string[];
      prosecdef: boolean;
      public_can_execute: boolean;
    }>(
      `select procedure.prosecdef,procedure.proconfig,
         has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
           as app_can_execute,
         coalesce(aclcontains(
           procedure.proacl,makeaclitem(0,procedure.proowner,'EXECUTE',false)
         ),false) as public_can_execute
       from pg_proc procedure
       where procedure.oid =
         'worldgraph_governance_policy_matches_v1(jsonb,text,text[],text[],text[],text,text,text,bigint)'::regprocedure`,
    );
    expect(catalog.rows).toEqual([
      {
        app_can_execute: true,
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
        public_can_execute: false,
      },
    ]);
    const seedValidatorCatalog = await owner.pool.query<{
      app_can_execute: boolean;
      helper_is_private: boolean;
      proconfig: string[];
      prosecdef: boolean;
      public_can_execute: boolean;
    }>(
      `select procedure.prosecdef,procedure.proconfig,
         has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
           as app_can_execute,
         not has_function_privilege(
           'worldgraph_app',
           'worldgraph_governance_policy_v1_is_valid(jsonb)',
           'EXECUTE'
         ) as helper_is_private,
         coalesce(aclcontains(
           procedure.proacl,makeaclitem(0,procedure.proowner,'EXECUTE',false)
         ),false) as public_can_execute
       from pg_proc procedure
       where procedure.oid =
         'worldgraph_governance_seed_plan_v1_is_valid(jsonb)'::regprocedure`,
    );
    expect(seedValidatorCatalog.rows).toEqual([
      {
        app_can_execute: true,
        helper_is_private: true,
        proconfig: ['search_path=pg_catalog, public'],
        prosecdef: true,
        public_can_execute: false,
      },
    ]);

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    const app = createDatabaseClient(appUrl.toString(), 'governance-policy-app');
    try {
      await expect(
        app.pool.query<{ allowed: boolean }>(evaluateSql, [
          policy,
          'in_world',
          ['player'],
          [],
          ['organization:harbor-guild'],
          'governance.vote',
          'proposal',
          null,
          '10',
        ]),
      ).resolves.toMatchObject({ rows: [{ allowed: true }] });
      await expect(
        app.pool.query<{ valid: boolean }>(
          `select worldgraph_governance_seed_plan_v1_is_valid($1::jsonb) as valid`,
          [seedPlan],
        ),
      ).resolves.toMatchObject({ rows: [{ valid: true }] });
      await expect(
        app.pool.query(
          `select worldgraph_governance_policy_v1_is_valid(
             '{"kind":"membership_role","role":"player"}'::jsonb
           )`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query(
          `select worldgraph_governance_policy_node_matches_v1(
             '{}'::jsonb,'in_world',array[]::text[],array[]::text[],
             array[]::text[],'governance.vote','proposal',null,10,0
           )`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.pool.end();
    }
  });

  it('revalidates an allowed membership authority source at commit', async () => {
    const userId = '018f0000-0000-7000-8000-00000000d501';
    const worldId = '018f0000-0000-7000-8000-00000000d502';
    const commandId = '018f0000-0000-7000-8000-00000000d503';
    const decisionId = '018f0000-0000-7000-8000-00000000d504';
    const sourceId = '018f0000-0000-7000-8000-00000000d505';
    const sourceChecksum = createHash('sha256')
      .update(
        canonicalJson({
          role: 'creator',
          rowVersion: '1',
          status: 'active',
          userId,
          worldId,
        }),
        'utf8',
      )
      .digest();
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `insert into users(id,email,password_hash,display_name)
         values ($1,'governance-authority-source@example.test',$2,
           'Governance Authority Source')`,
        [userId, passwordHash],
      );
      await connection.query(
        `insert into worlds(id,slug,name,created_by_user_id)
         values ($1,'governance-authority-source','Governance Authority Source',$2)`,
        [worldId, userId],
      );
      await connection.query(
        `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
         values ($1,$2,'creator',$2)`,
        [worldId, userId],
      );
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           status,correlation_id
         ) values (
           $1,$2,'MembershipAuthorityProbeV1',1,'user',$3,'{}'::jsonb,
           decode(repeat('d1',32),'hex'),'private','membership-authority-probe-v1',
           decode(repeat('d2',32),'hex'),'received',
           '018f0000-0000-7000-8000-00000000d506'
         )`,
        [commandId, worldId, userId],
      );
      await connection.query(`set local session_replication_role = 'origin'`);
      await connection.query(
        `insert into governance_authority_decisions(
           id,world_id,command_id,actor_mode,actor_type,actor_id,actor_entity_id,
           action_code,resource_type,resource_id,evaluated_tick,decision,reason_code,
           input_context,input_checksum,decision_checksum
         ) values (
           $1,$2,$3,'creator','user',$4,null,'world.override','world',$2::uuid::text,
           0,'allow','ALLOWED','{}'::jsonb,decode(repeat('d3',32),'hex'),
           decode(repeat('d4',32),'hex')
         )`,
        [decisionId, worldId, commandId, userId],
      );
      await connection.query(
        `insert into governance_authority_decision_sources(
           id,world_id,decision_id,source_ordinal,source_kind,source_id,
           source_version,source_effective_ticks,source_checksum,contribution
         ) values ($1,$2,$3,0,'membership_role',$4,1,null,$5,'context')`,
        [sourceId, worldId, decisionId, userId, sourceChecksum],
      );
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }

    await expect(
      owner.pool.query<{ count: number }>(
        `select count(*)::integer as count
           from governance_authority_decisions
          where world_id=$1 and id=$2 and decision='allow'`,
        [worldId, decisionId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it('bounds recent-credential verification clock skew without extending proof lifetime', async () => {
    const userId = '018f0000-0000-7000-8000-00000000d601';
    const worldId = '018f0000-0000-7000-8000-00000000d602';
    const sessionId = '018f0000-0000-7000-8000-00000000d603';
    const acceptedProofId = '018f0000-0000-7000-8000-00000000d604';
    const acceptedCommandId = '018f0000-0000-7000-8000-00000000d605';
    const acceptedAuditId = '018f0000-0000-7000-8000-00000000d606';
    const rejectedProofId = '018f0000-0000-7000-8000-00000000d607';
    const rejectedCommandId = '018f0000-0000-7000-8000-00000000d608';
    const rejectedAuditId = '018f0000-0000-7000-8000-00000000d609';
    const commandRequestHash = Buffer.alloc(32, 0xd6);
    const seed = await owner.pool.connect();
    try {
      await seed.query('begin');
      await seed.query(
        `insert into users(id,email,password_hash,display_name)
         values ($1,'recent-credential-skew@example.test',$2,
           'Recent Credential Skew')`,
        [userId, passwordHash],
      );
      await seed.query(
        `insert into worlds(id,slug,name,created_by_user_id)
         values ($1,'recent-credential-skew','Recent Credential Skew',$2)`,
        [worldId, userId],
      );
      await seed.query(
        `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
         values ($1,$2,'creator',$2)`,
        [worldId, userId],
      );
      await seed.query(
        `insert into sessions(
           id,user_id,token_hash,csrf_hash,auth_version,idle_expires_at,
           absolute_expires_at
         ) values (
           $1,$2,decode(repeat('d7',32),'hex'),decode(repeat('d8',32),'hex'),1,
           now()+interval '1 day',now()+interval '2 days'
         )`,
        [sessionId, userId],
      );
      await seed.query(
        `insert into security_audit_records(
           id,actor_user_id,world_id,category,action,outcome,reason_code,
           target_type,target_id,request_id,correlation_id,redacted_metadata
         ) values
         ($1,$3,$4,'identity','identity.reauthenticate','allowed',
          'RECENT_CREDENTIAL_VERIFIED','recent_credential_proof',$5,
          'future-skew-accepted','future-skew-accepted',
          jsonb_build_object(
            'commandId',$6::text,'commandType','ExecuteCreatorOverrideV1',
            'commandRequestHash',$7::text,'method','password'
          )),
         ($2,$3,$4,'identity','identity.reauthenticate','allowed',
          'RECENT_CREDENTIAL_VERIFIED','recent_credential_proof',$8,
          'future-skew-rejected','future-skew-rejected',
          jsonb_build_object(
            'commandId',$9::text,'commandType','ExecuteCreatorOverrideV1',
            'commandRequestHash',$7::text,'method','password'
          ))`,
        [
          acceptedAuditId,
          rejectedAuditId,
          userId,
          worldId,
          acceptedProofId,
          acceptedCommandId,
          commandRequestHash.toString('hex'),
          rejectedProofId,
          rejectedCommandId,
        ],
      );
      await seed.query('commit');
    } catch (error) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
    }

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    const app = createDatabaseClient(appUrl.toString(), 'recent-credential-skew-app');
    const issueSql = (
      verifiedOffset: string,
      expiresOffset: string,
    ): string => `select worldgraph_issue_recent_credential_proof_v1(
      $1,$2,$3,$4,$5,$6,'ExecuteCreatorOverrideV1',$7,
      transaction_timestamp()+interval '${verifiedOffset}',
      transaction_timestamp()+interval '${expiresOffset}',$8,$9
    )::text as proof_id`;
    try {
      await expect(
        app.pool.query<{ proof_id: string }>(issueSql('30 seconds', '330 seconds'), [
          acceptedProofId,
          Buffer.alloc(32, 0xd9),
          sessionId,
          userId,
          worldId,
          acceptedCommandId,
          commandRequestHash,
          'future-skew-accepted',
          acceptedAuditId,
        ]),
      ).resolves.toMatchObject({ rows: [{ proof_id: acceptedProofId }] });
      await expect(
        app.pool.query(issueSql('61 seconds', '361 seconds'), [
          rejectedProofId,
          Buffer.alloc(32, 0xda),
          sessionId,
          userId,
          worldId,
          rejectedCommandId,
          commandRequestHash,
          'future-skew-rejected',
          rejectedAuditId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query(issueSql('30 seconds', '931 seconds'), [
          rejectedProofId,
          Buffer.alloc(32, 0xda),
          sessionId,
          userId,
          worldId,
          rejectedCommandId,
          commandRequestHash,
          'future-skew-rejected',
          rejectedAuditId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.pool.end();
    }

    await expect(
      owner.pool.query<{
        creation_is_ordered: boolean;
        rejected_count: number;
      }>(
        `select
           (select created_at=verified_at from recent_credential_proofs where id=$1)
             as creation_is_ordered,
           (select count(*)::integer from recent_credential_proofs where id=$2)
             as rejected_count`,
        [acceptedProofId, rejectedProofId],
      ),
    ).resolves.toMatchObject({
      rows: [{ creation_is_ordered: true, rejected_count: 0 }],
    });
  });

  it('salts secret receipt choice hashes with the unreadable revision identity', async () => {
    const worldId = '018f0000-0000-7000-8000-00000000b101';
    const proposalId = '018f0000-0000-7000-8000-00000000b102';
    const contestId = '018f0000-0000-7000-8000-00000000b103';
    const snapshotId = '018f0000-0000-7000-8000-00000000b104';
    const voterEntityId = '018f0000-0000-7000-8000-00000000b105';
    const commandId = '018f0000-0000-7000-8000-00000000b106';
    const eventId = '018f0000-0000-7000-8000-00000000b107';
    const participationId = '018f0000-0000-7000-8000-00000000b108';
    const choiceRevisionId = '018f0000-0000-7000-8000-00000000b109';
    const receiptId = '018f0000-0000-7000-8000-00000000b110';
    const receiptHash = Buffer.alloc(32, 0xb1);
    const linkageNonceHash = Buffer.alloc(32, 0xb2);
    const choicePayload = { choice: 'yes' };

    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `insert into world_simulation_clocks(
           world_id,epoch_at,current_tick,world_milliseconds_per_tick,
           wall_cadence_milliseconds,mode,max_batch_ticks,max_catch_up_ticks,
           prng_algorithm_version,outcome_hash,row_version,updated_state_revision
         ) values ($1,now(),10,1000,1000,'paused',16,32,'xorshift32-sha256-v1',
           decode(repeat('b1',32),'hex'),1,1)`,
        [worldId],
      );
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_tick,status,correlation_id
         ) values (
           $1,$2,'CastProposalBallotV1',1,'user','secret-hash-voter',
           jsonb_build_object(
             'eligibilitySnapshotId',$3::text,'expectedProposalVersion','1',
             'proposalId',$4::text,'replaceExisting',false
           ),decode(repeat('b2',32),'hex'),'public','secret-hash-cast-v1',
           decode(repeat('b3',32),'hex'),10,'received',$5
         )`,
        [commandId, worldId, snapshotId, proposalId, '018f0000-0000-7000-8000-00000000b111'],
      );
      await connection.query(
        `insert into proposals(
           id,world_id,institution_id,jurisdiction_entity_id,proposer_entity_id,
           proposal_type,title,body,status,sponsorship_closes_tick,
           debate_closes_tick,voting_opens_tick,voting_closes_tick,
           minimum_sponsors,quorum_numerator,quorum_denominator,
           threshold_numerator,threshold_denominator,ballot_mode,
           ballot_disclosure,allow_ballot_replacement,target_versions,
           aggregate_version,created_command_id,created_event_id,
           created_state_revision
         ) values (
           $1,$2,'018f0000-0000-7000-8000-00000000b120',
           '018f0000-0000-7000-8000-00000000b121',
           '018f0000-0000-7000-8000-00000000b122','ordinary',
           'Secret hash test','Dictionary resistance for a bounded choice domain.',
           'open',0,0,1,11,0,0,10000,5001,10000,'secret','aggregate_only',
           false,'{}'::jsonb,1,$3,'018f0000-0000-7000-8000-00000000b123',1
         )`,
        [proposalId, worldId, commandId],
      );
      await connection.query(
        `insert into governance_contests(
           id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
           opens_tick,closes_tick,allow_replacement,aggregate_version,
           created_command_id,created_event_id,created_state_revision
         ) values (
           $1,$2,'proposal','secret','aggregate_only','open',1,11,false,1,$3,
           '018f0000-0000-7000-8000-00000000b124',1
         )`,
        [contestId, worldId, commandId],
      );
      await connection.query(
        `insert into proposal_contests(contest_id,world_id,proposal_id,question)
         values ($1,$2,$3,'Does the secret hash resist a tiny choice dictionary?')`,
        [contestId, worldId, proposalId],
      );
      await connection.query(
        `insert into eligibility_snapshots(
           id,world_id,contest_id,snapshot_tick,source_state_revision,
           source_membership_cursor,eligible_count,rule_snapshot,checksum,
           generated_command_id,generated_event_id
         ) values ($1,$2,$3,1,1,1,1,'{}'::jsonb,
           decode(repeat('b4',32),'hex'),$4,
           '018f0000-0000-7000-8000-00000000b125')`,
        [snapshotId, worldId, contestId, commandId],
      );
      await connection.query(
        `insert into eligibility_snapshot_members(
           id,world_id,snapshot_id,contest_id,voter_entity_id,voting_weight,
           eligibility_basis,member_hash
         ) values (
           '018f0000-0000-7000-8000-00000000b126',$1,$2,$3,$4,1,
           '{}'::jsonb,decode(repeat('b5',32),'hex')
         )`,
        [worldId, snapshotId, contestId, voterEntityId],
      );
      await connection.query(
        `update command_records
            set opened_state_revision=1,opened_ledger_sequence=1,
                opened_event_sequence=1,write_gate_opened_at=transaction_timestamp()
          where id=$1 and world_id=$2`,
        [commandId, worldId],
      );
      await connection.query(
        `select set_config('worldgraph.command_world_id',$1,true),
                set_config('worldgraph.command_id',$2,true)`,
        [worldId, commandId],
      );
      await connection.query('set local role worldgraph_app');
      await connection.query(
        `select * from worldgraph_cast_governance_ballot_v1(
           $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,
           $8::bytea,$9::bytea,$10::jsonb,1,false,10,$11::uuid,$12::uuid,1
         )`,
        [
          worldId,
          contestId,
          snapshotId,
          voterEntityId,
          participationId,
          choiceRevisionId,
          receiptId,
          receiptHash,
          linkageNonceHash,
          choicePayload,
          commandId,
          eventId,
        ],
      );
      // Keep the ordinary application role active through COMMIT so every
      // deferred ballot-integrity trigger executes across the real privilege
      // boundary. The assertion functions remain non-invocable by that role
      // and obtain only their migration-owner read authority while running.
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }

    const receipt = await owner.pool.query<{ choice_hash: Buffer }>(
      `select choice_hash from ballot_receipts where world_id=$1 and id=$2`,
      [worldId, receiptId],
    );
    const choiceHash = receipt.rows[0]!.choice_hash;
    const unsaltedCandidates = ['yes', 'no', 'abstain'].map((choice) =>
      createHash('sha256').update(canonicalJson({ choice }), 'utf8').digest('hex'),
    );
    expect(choiceHash.toString('hex')).toBe(
      governanceChecksum('worldgraph.governance.secret-ballot-choice-hash.v1', {
        choicePayload,
        choiceRevisionId,
      }).toString('hex'),
    );
    expect(unsaltedCandidates).not.toContain(choiceHash.toString('hex'));

    const storageGuards = await owner.pool.query<{
      check_definition: string;
      trigger_definition: string;
    }>(
      `select pg_get_constraintdef(constraint_record.oid) as check_definition,
         pg_get_functiondef(
           'worldgraph_assert_ballot_choice_storage_v1()'::regprocedure
         ) as trigger_definition
       from pg_constraint constraint_record
       where constraint_record.conrelid='secret_ballot_choices'::regclass
         and constraint_record.conname='secret_ballot_choices_payload_valid'`,
    );
    expect(storageGuards.rows[0]?.check_definition).toContain(
      'worldgraph.governance.secret-ballot-choice-hash.v1',
    );
    expect(storageGuards.rows[0]?.check_definition).toContain('choiceRevisionId');
    expect(storageGuards.rows[0]?.trigger_definition).toContain(
      'worldgraph.governance.secret-ballot-choice-hash.v1',
    );
    expect(storageGuards.rows[0]?.trigger_definition).toContain('choiceRevisionId');

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    const app = createDatabaseClient(appUrl.toString(), 'secret-choice-hash-app');
    try {
      await expect(
        app.pool.query<{ choice_hash: Buffer }>(
          `select choice_hash from ballot_receipts where world_id=$1 and id=$2`,
          [worldId, receiptId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        app.pool.query(
          `select id from ballot_choice_revisions
            where world_id=$1 and participation_id=$2`,
          [worldId, participationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.pool.end();
    }
  });

  it('persists a verified tally atomically and rejects forgery and duplicates', async () => {
    const worldId = '018f0000-0000-7000-8000-00000000a101';
    const proposalId = '018f0000-0000-7000-8000-00000000a102';
    const contestId = '018f0000-0000-7000-8000-00000000a103';
    const snapshotId = '018f0000-0000-7000-8000-00000000a104';
    const commandId = '018f0000-0000-7000-8000-00000000a105';
    const inputChecksum = governanceChecksum('worldgraph.governance.proposal-tally-input.v1', {
      algorithmVersion: 'proposal_yes_no_v1',
      approvalThresholdBps: 5001,
      ballots: [],
      eligibleCount: 0,
      quorumBps: 0,
    });
    const outputChecksum = governanceChecksum('worldgraph.governance.proposal-tally-result.v1', {
      abstainCount: 0,
      algorithmVersion: 'proposal_yes_no_v1',
      approvalThresholdBps: 5001,
      eligibleCount: 0,
      inputChecksum: inputChecksum.toString('hex'),
      noCount: 0,
      outcome: 'rejected_threshold',
      quorumBps: 0,
      quorumSatisfied: true,
      thresholdSatisfied: false,
      turnoutCount: 0,
      yesCount: 0,
    });
    const identities = {
      abstainCountId: '018f0000-0000-7000-8000-00000000a113',
      noCountId: '018f0000-0000-7000-8000-00000000a112',
      tallyId: '018f0000-0000-7000-8000-00000000a110',
      yesCountId: '018f0000-0000-7000-8000-00000000a111',
    };
    const argumentsFor = (participatingCount: number, yesCount: number) => [
      identities.tallyId,
      worldId,
      contestId,
      proposalId,
      snapshotId,
      '1',
      'proposal_yes_no_v1',
      0,
      participatingCount,
      0,
      0,
      yesCount,
      0,
      0,
      inputChecksum,
      outputChecksum,
      '10',
      commandId,
      identities.yesCountId,
      identities.noCountId,
      identities.abstainCountId,
    ];
    const persistSql = `select worldgraph_persist_proposal_tally_v1(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,
      $8::integer,$9::integer,$10::integer,$11::integer,$12::integer,
      $13::integer,$14::integer,$15::bytea,$16::bytea,$17::bigint,$18::uuid,
      $19::uuid,$20::uuid,$21::uuid
    ) as tally_id`;

    const seed = await owner.pool.connect();
    try {
      await seed.query('begin');
      await seed.query(`set local session_replication_role = 'replica'`);
      await seed.query(
        `insert into world_simulation_clocks(
           world_id,epoch_at,current_tick,world_milliseconds_per_tick,
           wall_cadence_milliseconds,mode,max_batch_ticks,max_catch_up_ticks,
           prng_algorithm_version,outcome_hash,row_version,updated_state_revision
         ) values ($1,now(),10,1000,1000,'paused',16,32,'xorshift32-sha256-v1',
           decode(repeat('01',32),'hex'),1,1)`,
        [worldId],
      );
      await seed.query(
        `insert into world_runtime_heads(
           world_id,active_world_version_id,state_revision,last_ledger_sequence,
           last_event_sequence
         ) values (
           $1,'018f0000-0000-7000-8000-00000000a100',1,0,0
         )`,
        [worldId],
      );
      await seed.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_tick,status,correlation_id
         ) values (
           $1,$2,'CloseAndTallyProposalV1',1,'system','worldgraph:test',
           jsonb_build_object(
             'algorithmVersion','proposal_yes_no_v1',
             'eligibilitySnapshotId',$3::text,
             'expectedProposalVersion','1',
             'occurrenceKey','proposal:test:close',
             'proposalId',$4::text
           ),decode(repeat('02',32),'hex'),'public','governance-test-tally',
           decode(repeat('03',32),'hex'),10,'received',$5)`,
        [commandId, worldId, snapshotId, proposalId, '018f0000-0000-7000-8000-00000000a106'],
      );
      await seed.query(
        `insert into proposals(
           id,world_id,institution_id,jurisdiction_entity_id,proposer_entity_id,
           proposal_type,title,body,status,sponsorship_closes_tick,
           debate_closes_tick,voting_opens_tick,voting_closes_tick,
           minimum_sponsors,quorum_numerator,quorum_denominator,
           threshold_numerator,threshold_denominator,ballot_mode,
           ballot_disclosure,allow_ballot_replacement,target_versions,
           aggregate_version,created_command_id,created_event_id,
           created_state_revision
         ) values (
           $1,$2,'018f0000-0000-7000-8000-00000000a120',
           '018f0000-0000-7000-8000-00000000a121',
           '018f0000-0000-7000-8000-00000000a122','ordinary',
           'Atomic tally test','No voters are eligible in this frozen fixture.',
           'open',0,0,1,10,0,0,10000,5001,10000,'secret','aggregate_only',
           false,'{}'::jsonb,1,$3,
           '018f0000-0000-7000-8000-00000000a123',1
         )`,
        [proposalId, worldId, commandId],
      );
      await seed.query(
        `insert into governance_contests(
           id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
           opens_tick,closes_tick,allow_replacement,aggregate_version,
           created_command_id,created_event_id,created_state_revision
         ) values (
           $1,$2,'proposal','secret','aggregate_only','open',1,10,false,1,$3,
           '018f0000-0000-7000-8000-00000000a124',1
         )`,
        [contestId, worldId, commandId],
      );
      await seed.query(
        `insert into proposal_contests(contest_id,world_id,proposal_id,question)
         values ($1,$2,$3,'Should the empty fixture pass?')`,
        [contestId, worldId, proposalId],
      );
      await seed.query(
        `insert into eligibility_snapshots(
           id,world_id,contest_id,snapshot_tick,source_state_revision,
           source_membership_cursor,eligible_count,rule_snapshot,checksum,
           generated_command_id,generated_event_id
         ) values ($1,$2,$3,1,1,0,0,'{}'::jsonb,
           decode(repeat('04',32),'hex'),$4,
           '018f0000-0000-7000-8000-00000000a125')`,
        [snapshotId, worldId, contestId, commandId],
      );
      await seed.query('commit');
    } catch (error) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
    }

    const invokeAsApp = async (values: unknown[], finish: 'commit' | 'rollback'): Promise<void> => {
      const connection = await owner.pool.connect();
      try {
        await connection.query('begin');
        await connection.query(`set local session_replication_role = 'replica'`);
        await connection.query(
          `update command_records
              set opened_state_revision=1,opened_ledger_sequence=1,
                  opened_event_sequence=1,write_gate_opened_at=transaction_timestamp()
            where id=$1 and world_id=$2`,
          [commandId, worldId],
        );
        await connection.query(
          `select set_config('worldgraph.command_world_id',$1,true),
                  set_config('worldgraph.command_id',$2,true)`,
          [worldId, commandId],
        );
        await connection.query('set local role worldgraph_app');
        await connection.query(persistSql, values);
        await connection.query('reset role');
        await connection.query(finish);
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
    };

    await expect(invokeAsApp(argumentsFor(1, 1), 'rollback')).rejects.toMatchObject({
      code: '22023',
    });
    await expect(
      owner.pool.query(`select count(*)::integer as count from proposal_tallies where id=$1`, [
        identities.tallyId,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await invokeAsApp(argumentsFor(0, 0), 'rollback');
    await expect(
      owner.pool.query(`select count(*)::integer as count from proposal_tallies where id=$1`, [
        identities.tallyId,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await invokeAsApp(argumentsFor(0, 0), 'commit');
    await expect(invokeAsApp(argumentsFor(0, 0), 'rollback')).rejects.toMatchObject({
      code: '23505',
      constraint: 'proposal_tallies_version_unique',
    });
    const persisted = await owner.pool.query<{
      count_rows: number;
      tally_rows: number;
    }>(
      `select
         (select count(*)::integer from proposal_tallies where id=$1) as tally_rows,
         (select count(*)::integer from proposal_tally_counts where tally_id=$1)
           as count_rows`,
      [identities.tallyId],
    );
    expect(persisted.rows).toEqual([{ count_rows: 3, tally_rows: 1 }]);

    const sourceResultId = '018f0000-0000-7000-8000-00000000a130';
    const replacementResultId = '018f0000-0000-7000-8000-00000000a132';
    const replacementTallyId = '018f0000-0000-7000-8000-00000000a133';
    const recountCommandId = '018f0000-0000-7000-8000-00000000a137';
    const recount = await owner.pool.connect();
    try {
      await recount.query('begin');
      await recount.query(`set local session_replication_role = 'replica'`);
      await recount.query(`update proposals set status='rejected' where world_id=$1 and id=$2`, [
        worldId,
        proposalId,
      ]);
      await recount.query(
        `update governance_contests set status='certified' where world_id=$1 and id=$2`,
        [worldId, contestId],
      );
      await recount.query(
        `insert into proposal_results(
           id,world_id,contest_id,proposal_id,tally_id,outcome,quorum_met,
           threshold_met,result_checksum,certified_command_id,certified_event_id,
           certified_state_revision,certified_tick
         ) values (
           $1,$2,$3,$4,$5,'rejected_threshold',true,false,$6,$7,
           '018f0000-0000-7000-8000-00000000a131',1,10
         )`,
        [
          sourceResultId,
          worldId,
          contestId,
          proposalId,
          identities.tallyId,
          outputChecksum,
          commandId,
        ],
      );
      await recount.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_tick,status,correlation_id,opened_state_revision,
           opened_ledger_sequence,opened_event_sequence,write_gate_opened_at
         ) values (
           $1,$2,'RepairGovernanceResultV1',1,'user','governance-repair-user',
           jsonb_build_object(
             'approvalId',null,'confirmation','APPEND LINKED GOVERNANCE REPAIR',
             'expectedCurrentResultChecksum',$3::text,'reason',
             'Recount confirms the immutable tally.','repairKind','proposal_recount',
             'replacementResultChecksum',$3::text,'sourceResultId',$4::text
           ),decode(repeat('05',32),'hex'),'private','governance-test-recount',
           decode(repeat('06',32),'hex'),10,'received',
           '018f0000-0000-7000-8000-00000000a139',1,0,0,
           transaction_timestamp()
         )`,
        [recountCommandId, worldId, outputChecksum.toString('hex'), sourceResultId],
      );
      await recount.query(
        `select set_config('worldgraph.command_world_id',$1,true),
                set_config('worldgraph.command_id',$2,true)`,
        [worldId, recountCommandId],
      );
      await recount.query('set local role worldgraph_app');
      const recounted = await recount.query<{
        input_checksum: Buffer;
        outcome: string;
        quorum_met: boolean;
        result_checksum: Buffer;
        result_id: string;
        tally_id: string;
        threshold_met: boolean;
      }>(
        `select * from worldgraph_recount_proposal_result_v1(
           $1,$2,$3,$4,
           '018f0000-0000-7000-8000-00000000a134',
           '018f0000-0000-7000-8000-00000000a135',
           '018f0000-0000-7000-8000-00000000a136',
           $5,$5,$6,'018f0000-0000-7000-8000-00000000a138',2,10
         )`,
        [
          worldId,
          sourceResultId,
          replacementResultId,
          replacementTallyId,
          outputChecksum,
          recountCommandId,
        ],
      );
      expect(recounted.rows).toEqual([
        {
          input_checksum: inputChecksum,
          outcome: 'rejected_threshold',
          quorum_met: true,
          result_checksum: outputChecksum,
          result_id: replacementResultId,
          tally_id: replacementTallyId,
          threshold_met: false,
        },
      ]);
      await recount.query('reset role');
      await recount.query('commit');
    } catch (error) {
      await recount.query('rollback');
      throw error;
    } finally {
      recount.release();
    }
    const linkedRecount = await owner.pool.query<{
      recount_of_tally_id: string;
      repair_of_result_id: string;
      result_checksum: Buffer;
      tally_version: number;
    }>(
      `select tally.tally_version,tally.recount_of_tally_id::text,
         result.repair_of_result_id::text,result.result_checksum
       from proposal_results result
       join proposal_tallies tally
         on tally.world_id=result.world_id and tally.id=result.tally_id
      where result.world_id=$1 and result.id=$2`,
      [worldId, replacementResultId],
    );
    expect(linkedRecount.rows).toEqual([
      {
        recount_of_tally_id: identities.tallyId,
        repair_of_result_id: sourceResultId,
        result_checksum: outputChecksum,
        tally_version: 2,
      },
    ]);

    const electionId = '018f0000-0000-7000-8000-00000000a201';
    const electionContestId = '018f0000-0000-7000-8000-00000000a202';
    const electionSnapshotId = '018f0000-0000-7000-8000-00000000a203';
    const candidateEntityId = '018f0000-0000-7000-8000-00000000a204';
    const candidacyId = '018f0000-0000-7000-8000-00000000a205';
    const electionSourceTallyId = '018f0000-0000-7000-8000-00000000a206';
    const electionSourceResultId = '018f0000-0000-7000-8000-00000000a209';
    const electionRecountCommandId = '018f0000-0000-7000-8000-00000000a210';
    const electionReplacementResultId = '018f0000-0000-7000-8000-00000000a211';
    const electionReplacementTallyId = '018f0000-0000-7000-8000-00000000a212';
    const candidateKey = 'player:election-recount';
    const electionInputChecksum = governanceChecksum(
      'worldgraph.governance.election-tally-input.v1',
      {
        algorithmVersion: 'election_plurality_v1',
        ballots: [],
        candidateKeys: [candidateKey],
        eligibleCount: 0,
        quorumBps: 0,
        tieRule: 'vacancy',
      },
    );
    const electionOutputChecksum = governanceChecksum(
      'worldgraph.governance.election-tally-result.v1',
      {
        abstainCount: 0,
        algorithmVersion: 'election_plurality_v1',
        candidateTotals: [{ candidateKey, voteCount: 0 }],
        eligibleCount: 0,
        inputChecksum: electionInputChecksum.toString('hex'),
        outcome: 'vacant_no_votes',
        quorumBps: 0,
        quorumSatisfied: true,
        tieRule: 'vacancy',
        tiedCandidateKeys: [],
        turnoutCount: 0,
        winnerCandidateKey: null,
      },
    );
    const electionRecount = await owner.pool.connect();
    try {
      await electionRecount.query('begin');
      await electionRecount.query(`set local session_replication_role = 'replica'`);
      await electionRecount.query(
        `insert into world_entities(
           id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id,row_version
         ) values ($1,$2,$3,'player_character',1,$4,
           '018f0000-0000-7000-8000-00000000a100',1)`,
        [
          candidateEntityId,
          worldId,
          candidateKey,
          {
            blueprintLogicalKey: 'blueprint:citizen',
            homeDistrictLogicalKey: 'district:civic-platform',
            membershipRole: 'player',
            name: 'Election Recount Candidate',
            organizationLogicalKey: null,
          },
        ],
      );
      await electionRecount.query(
        `insert into elections(
           id,world_id,institution_id,office_id,seat_id,election_kind,status,
           nomination_opens_tick,nomination_closes_tick,voting_opens_tick,
           voting_closes_tick,certification_tick,term_starts_tick,
           quorum_numerator,quorum_denominator,tie_rule,ballot_mode,
           ballot_disclosure,allow_ballot_replacement,election_rule_snapshot,
           aggregate_version,created_command_id,created_event_id,created_state_revision
         ) values (
           $1,$2,'018f0000-0000-7000-8000-00000000a220',
           '018f0000-0000-7000-8000-00000000a221',
           '018f0000-0000-7000-8000-00000000a222','regular','certified',
           0,1,1,10,10,10,0,10000,'vacancy','secret','aggregate_only',false,
           '{}'::jsonb,3,$3,'018f0000-0000-7000-8000-00000000a223',1
         )`,
        [electionId, worldId, commandId],
      );
      await electionRecount.query(
        `insert into governance_contests(
           id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
           opens_tick,closes_tick,allow_replacement,aggregate_version,
           created_command_id,created_event_id,created_state_revision
         ) values (
           $1,$2,'election','secret','aggregate_only','certified',1,10,false,3,
           $3,'018f0000-0000-7000-8000-00000000a224',1
         )`,
        [electionContestId, worldId, commandId],
      );
      await electionRecount.query(
        `insert into election_contests(
           contest_id,world_id,election_id,office_id,seat_id,
           contest_ordinal,seats_to_fill
         ) values (
           $1,$2,$3,'018f0000-0000-7000-8000-00000000a221',
           '018f0000-0000-7000-8000-00000000a222',1,1
         )`,
        [electionContestId, worldId, electionId],
      );
      await electionRecount.query(
        `insert into candidacies(
           id,world_id,election_id,contest_id,candidate_entity_id,status,
           nomination_tick,aggregate_version,nominated_command_id,
           nominated_event_id,accepted_command_id,accepted_event_id
         ) values (
           $1,$2,$3,$4,$5,'accepted',0,2,$6,
           '018f0000-0000-7000-8000-00000000a225',$6,
           '018f0000-0000-7000-8000-00000000a226'
         )`,
        [candidacyId, worldId, electionId, electionContestId, candidateEntityId, commandId],
      );
      await electionRecount.query(
        `insert into eligibility_snapshots(
           id,world_id,contest_id,snapshot_tick,source_state_revision,
           source_membership_cursor,eligible_count,rule_snapshot,checksum,
           generated_command_id,generated_event_id
         ) values (
           $1,$2,$3,1,1,0,0,'{}'::jsonb,decode(repeat('07',32),'hex'),$4,
           '018f0000-0000-7000-8000-00000000a227'
         )`,
        [electionSnapshotId, worldId, electionContestId, commandId],
      );
      await electionRecount.query(
        `insert into election_tallies(
           id,world_id,contest_id,election_id,eligibility_snapshot_id,
           tally_version,algorithm_version,eligible_count,participating_count,
           input_checksum,output_checksum,recount_of_tally_id,tallied_tick
         ) values (
           $1,$2,$3,$4,$5,1,'election_plurality_v1',0,0,$6,$7,null,10
         )`,
        [
          electionSourceTallyId,
          worldId,
          electionContestId,
          electionId,
          electionSnapshotId,
          electionInputChecksum,
          electionOutputChecksum,
        ],
      );
      await electionRecount.query(
        `insert into election_tally_counts(
           id,world_id,tally_id,candidacy_id,count_kind,ballot_count,weighted_count
         ) values
         ('018f0000-0000-7000-8000-00000000a207',$1,$2,$3,'candidate',0,0),
         ('018f0000-0000-7000-8000-00000000a208',$1,$2,null,'abstain',0,0)`,
        [worldId, electionSourceTallyId, candidacyId],
      );
      await electionRecount.query(
        `insert into election_results(
           id,world_id,contest_id,election_id,tally_id,outcome,
           winning_candidacy_id,result_checksum,certified_command_id,
           certified_event_id,certified_state_revision,certified_tick
         ) values (
           $1,$2,$3,$4,$5,'vacant_no_votes',null,$6,$7,
           '018f0000-0000-7000-8000-00000000a228',1,10
         )`,
        [
          electionSourceResultId,
          worldId,
          electionContestId,
          electionId,
          electionSourceTallyId,
          electionOutputChecksum,
          commandId,
        ],
      );
      await electionRecount.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_tick,status,correlation_id,opened_state_revision,
           opened_ledger_sequence,opened_event_sequence,write_gate_opened_at
         ) values (
           $1,$2,'RepairGovernanceResultV1',1,'user','governance-repair-user',
           jsonb_build_object(
             'approvalId',null,'confirmation','APPEND LINKED GOVERNANCE REPAIR',
             'expectedCurrentResultChecksum',$3::text,'reason',
             'Election recount confirms the immutable tally.',
             'repairKind','election_recount',
             'replacementResultChecksum',$3::text,'sourceResultId',$4::text
           ),decode(repeat('08',32),'hex'),'private','governance-election-recount',
           decode(repeat('09',32),'hex'),10,'received',
           '018f0000-0000-7000-8000-00000000a216',1,0,0,
           transaction_timestamp()
         )`,
        [
          electionRecountCommandId,
          worldId,
          electionOutputChecksum.toString('hex'),
          electionSourceResultId,
        ],
      );
      await electionRecount.query(
        `select set_config('worldgraph.command_world_id',$1,true),
                set_config('worldgraph.command_id',$2,true)`,
        [worldId, electionRecountCommandId],
      );
      await electionRecount.query('set local role worldgraph_app');
      const electionRecounted = await electionRecount.query<{
        input_checksum: Buffer;
        outcome: string;
        result_checksum: Buffer;
        result_id: string;
        tally_id: string;
        winning_candidacy_id: string | null;
      }>(
        `select * from worldgraph_recount_election_result_v1(
           $1,$2,$3,$4,$5::jsonb,
           '018f0000-0000-7000-8000-00000000a214',$6,$6,$7,
           '018f0000-0000-7000-8000-00000000a215',2,10
         )`,
        [
          worldId,
          electionSourceResultId,
          electionReplacementResultId,
          electionReplacementTallyId,
          JSON.stringify([{ candidacyId, countId: '018f0000-0000-7000-8000-00000000a213' }]),
          electionOutputChecksum,
          electionRecountCommandId,
        ],
      );
      expect(electionRecounted.rows).toEqual([
        {
          input_checksum: electionInputChecksum,
          outcome: 'vacant_no_votes',
          result_checksum: electionOutputChecksum,
          result_id: electionReplacementResultId,
          tally_id: electionReplacementTallyId,
          winning_candidacy_id: null,
        },
      ]);
      await electionRecount.query('reset role');
      await electionRecount.query('commit');
    } catch (error) {
      await electionRecount.query('rollback');
      throw error;
    } finally {
      electionRecount.release();
    }
    const linkedElectionRecount = await owner.pool.query<{
      count_rows: number;
      recount_of_tally_id: string;
      repair_of_result_id: string;
      tally_version: number;
    }>(
      `select tally.tally_version,tally.recount_of_tally_id::text,
         result.repair_of_result_id::text,
         (select count(*)::integer from election_tally_counts tally_count
           where tally_count.tally_id=tally.id) as count_rows
       from election_results result
       join election_tallies tally
         on tally.world_id=result.world_id and tally.id=result.tally_id
      where result.world_id=$1 and result.id=$2`,
      [worldId, electionReplacementResultId],
    );
    expect(linkedElectionRecount.rows).toEqual([
      {
        count_rows: 2,
        recount_of_tally_id: electionSourceTallyId,
        repair_of_result_id: electionSourceResultId,
        tally_version: 2,
      },
    ]);
  });

  it('keeps certified results append-only while permitting single-chain recount replacements', async () => {
    const indexes = await owner.pool.query<{ indexdef: string; indexname: string }>(
      `select indexname,indexdef
         from pg_indexes
        where schemaname = 'public'
          and indexname = any($1::text[])
        order by indexname`,
      [
        [
          'election_results_repair_parent_unique',
          'election_results_root_contest_unique',
          'election_results_root_election_unique',
          'proposal_results_repair_parent_unique',
          'proposal_results_root_contest_unique',
          'proposal_results_root_proposal_unique',
        ],
      ],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'election_results_repair_parent_unique',
      'election_results_root_contest_unique',
      'election_results_root_election_unique',
      'proposal_results_repair_parent_unique',
      'proposal_results_root_contest_unique',
      'proposal_results_root_proposal_unique',
    ]);
    for (const row of indexes.rows) {
      expect(row.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(row.indexdef).toContain(
        row.indexname.includes('repair_parent')
          ? 'repair_of_result_id IS NOT NULL'
          : 'repair_of_result_id IS NULL',
      );
    }

    const constraints = await owner.pool.query<{ conname: string; definition: string }>(
      `select conname,pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname in (
          'proposal_results_repair_lineage_fk',
          'election_results_repair_lineage_fk',
          'governance_repairs_shape_valid'
        )
        order by conname`,
    );
    expect(constraints.rows).toHaveLength(3);
    const definitions = Object.fromEntries(
      constraints.rows.map((row) => [row.conname, row.definition]),
    );
    expect(definitions.election_results_repair_lineage_fk).toContain(
      'FOREIGN KEY (world_id, repair_of_result_id, election_id, contest_id)',
    );
    expect(definitions.election_results_repair_lineage_fk).toContain(
      'REFERENCES election_results(world_id, id, election_id, contest_id)',
    );
    expect(definitions.proposal_results_repair_lineage_fk).toContain(
      'FOREIGN KEY (world_id, repair_of_result_id, proposal_id, contest_id)',
    );
    expect(definitions.proposal_results_repair_lineage_fk).toContain(
      'REFERENCES proposal_results(world_id, id, proposal_id, contest_id)',
    );
    expect(definitions.governance_repairs_shape_valid).toContain("repair_kind = 'recount'::text");
    expect(definitions.governance_repairs_shape_valid).toContain(
      'before_checksum <> after_checksum',
    );

    const triggers = await owner.pool.query<{ table_name: string }>(
      `select tgrelid::regclass::text as table_name
         from pg_trigger
        where not tgisinternal
          and tgname in (
            'proposal_results_append_only',
            'election_results_append_only',
            'governance_repairs_append_only'
          )
        order by table_name`,
    );
    expect(triggers.rows.map((row) => row.table_name)).toEqual([
      'election_results',
      'governance_repairs',
      'proposal_results',
    ]);

    const proposalRootId = '018f0000-0000-7000-8000-00000000e101';
    const proposalRepairId = '018f0000-0000-7000-8000-00000000e102';
    const electionRootId = '018f0000-0000-7000-8000-00000000f101';
    const electionRepairId = '018f0000-0000-7000-8000-00000000f102';
    const governanceRepairId = '018f0000-0000-7000-8000-00000000d101';
    const fixture = await owner.pool.connect();
    try {
      await fixture.query('begin');
      await fixture.query(`set local session_replication_role = 'replica'`);
      await fixture.query(
        `insert into proposal_results(
           id,world_id,contest_id,proposal_id,tally_id,outcome,quorum_met,
           threshold_met,result_checksum,certified_command_id,certified_event_id,
           certified_state_revision,certified_tick,repair_of_result_id
         ) values
         ($1,'018f0000-0000-7000-8000-00000000e103',
           '018f0000-0000-7000-8000-00000000e104',
           '018f0000-0000-7000-8000-00000000e105',
           '018f0000-0000-7000-8000-00000000e106','rejected_quorum',false,false,
           decode(repeat('ab',32),'hex'),'018f0000-0000-7000-8000-00000000e107',
           '018f0000-0000-7000-8000-00000000e108',1,0,null),
         ($2,'018f0000-0000-7000-8000-00000000e103',
           '018f0000-0000-7000-8000-00000000e104',
           '018f0000-0000-7000-8000-00000000e105',
           '018f0000-0000-7000-8000-00000000e109','rejected_quorum',false,false,
           decode(repeat('ab',32),'hex'),'018f0000-0000-7000-8000-00000000e110',
           '018f0000-0000-7000-8000-00000000e111',2,1,$1)`,
        [proposalRootId, proposalRepairId],
      );
      await fixture.query(
        `insert into election_results(
           id,world_id,contest_id,election_id,tally_id,outcome,result_checksum,
           certified_command_id,certified_event_id,certified_state_revision,
           certified_tick,repair_of_result_id
         ) values
         ($1,'018f0000-0000-7000-8000-00000000f103',
           '018f0000-0000-7000-8000-00000000f104',
           '018f0000-0000-7000-8000-00000000f105',
           '018f0000-0000-7000-8000-00000000f106','vacant_no_quorum',
           decode(repeat('cd',32),'hex'),'018f0000-0000-7000-8000-00000000f107',
           '018f0000-0000-7000-8000-00000000f108',1,0,null),
         ($2,'018f0000-0000-7000-8000-00000000f103',
           '018f0000-0000-7000-8000-00000000f104',
           '018f0000-0000-7000-8000-00000000f105',
           '018f0000-0000-7000-8000-00000000f109','vacant_no_quorum',
           decode(repeat('cd',32),'hex'),'018f0000-0000-7000-8000-00000000f110',
           '018f0000-0000-7000-8000-00000000f111',2,1,$1)`,
        [electionRootId, electionRepairId],
      );

      for (const [kind, tableName, rootId] of [
        ['proposal', 'proposal_results', proposalRootId],
        ['election', 'election_results', electionRootId],
      ] as const) {
        await fixture.query(`savepoint duplicate_${kind}_parent`);
        const columns =
          kind === 'proposal'
            ? `id,world_id,contest_id,proposal_id,tally_id,outcome,quorum_met,
               threshold_met,result_checksum,certified_command_id,certified_event_id,
               certified_state_revision,certified_tick,repair_of_result_id`
            : `id,world_id,contest_id,election_id,tally_id,outcome,result_checksum,
               certified_command_id,certified_event_id,certified_state_revision,
               certified_tick,repair_of_result_id`;
        const values =
          kind === 'proposal'
            ? `('018f0000-0000-7000-8000-00000000e112',
                 '018f0000-0000-7000-8000-00000000e103',
                 '018f0000-0000-7000-8000-00000000e104',
                 '018f0000-0000-7000-8000-00000000e105',
                 '018f0000-0000-7000-8000-00000000e113','rejected_quorum',false,false,
                 decode(repeat('ab',32),'hex'),
                 '018f0000-0000-7000-8000-00000000e114',
                 '018f0000-0000-7000-8000-00000000e115',3,2,$1)`
            : `('018f0000-0000-7000-8000-00000000f112',
                 '018f0000-0000-7000-8000-00000000f103',
                 '018f0000-0000-7000-8000-00000000f104',
                 '018f0000-0000-7000-8000-00000000f105',
                 '018f0000-0000-7000-8000-00000000f113','vacant_no_quorum',
                 decode(repeat('cd',32),'hex'),
                 '018f0000-0000-7000-8000-00000000f114',
                 '018f0000-0000-7000-8000-00000000f115',3,2,$1)`;
        await expect(
          fixture.query(`insert into ${tableName}(${columns}) values ${values}`, [rootId]),
        ).rejects.toMatchObject({
          code: '23505',
          constraint: `${kind}_results_repair_parent_unique`,
        });
        await fixture.query(`rollback to savepoint duplicate_${kind}_parent`);
      }

      await fixture.query('savepoint invalid_equal_repair');
      await expect(
        fixture.query(
          `insert into governance_repairs(
             id,world_id,target_kind,target_id,repair_kind,reason,
             before_checksum,after_checksum,command_id,event_id,ledger_entry_id,
             actor_user_id,state_revision
           ) values (
             '018f0000-0000-7000-8000-00000000d102',
             '018f0000-0000-7000-8000-00000000d103','proposal_result',$1,
             'replace_result','Replacement must change the certified checksum.',
             decode(repeat('ef',32),'hex'),decode(repeat('ef',32),'hex'),
             '018f0000-0000-7000-8000-00000000d104',
             '018f0000-0000-7000-8000-00000000d105',
             '018f0000-0000-7000-8000-00000000d106',
             '018f0000-0000-7000-8000-00000000d107',1)`,
          [proposalRootId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'governance_repairs_shape_valid',
      });
      await fixture.query('rollback to savepoint invalid_equal_repair');
      await fixture.query(
        `insert into governance_repairs(
           id,world_id,target_kind,target_id,repair_kind,reason,before_checksum,
           after_checksum,replacement_result_id,command_id,event_id,ledger_entry_id,
           actor_user_id,state_revision
         ) values (
           $1,'018f0000-0000-7000-8000-00000000d103','proposal_result',$2,
           'recount','Recount confirms the previously certified checksum.',
           decode(repeat('ef',32),'hex'),decode(repeat('ef',32),'hex'),$3,
           '018f0000-0000-7000-8000-00000000d108',
           '018f0000-0000-7000-8000-00000000d109',
           '018f0000-0000-7000-8000-00000000d110',
           '018f0000-0000-7000-8000-00000000d111',2)`,
        [governanceRepairId, proposalRootId, proposalRepairId],
      );
      await fixture.query('commit');
    } catch (error) {
      await fixture.query('rollback');
      throw error;
    } finally {
      fixture.release();
    }

    const cleanupFixtures = async (): Promise<void> => {
      const cleanup = await owner.pool.connect();
      try {
        await cleanup.query('begin');
        await cleanup.query(`set local session_replication_role = 'replica'`);
        await cleanup.query(`delete from governance_repairs where id=$1`, [governanceRepairId]);
        await cleanup.query(`delete from proposal_results where id=any($1::uuid[])`, [
          [proposalRootId, proposalRepairId],
        ]);
        await cleanup.query(`delete from election_results where id=any($1::uuid[])`, [
          [electionRootId, electionRepairId],
        ]);
        await cleanup.query('commit');
      } catch (error) {
        await cleanup.query('rollback');
        throw error;
      } finally {
        cleanup.release();
      }
    };

    try {
      for (const [tableName, id] of [
        ['proposal_results', proposalRepairId],
        ['election_results', electionRepairId],
      ] as const) {
        await expect(
          owner.pool.query(`update ${tableName} set certified_tick = 2 where id = $1`, [id]),
        ).rejects.toMatchObject({ code: '55000' });
      }
      await expect(
        owner.pool.query(
          `update governance_repairs set reason = reason || ' amended' where id=$1`,
          [governanceRepairId],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await cleanupFixtures();
    }
  });

  it('permits direct and proposal appointments while keeping election term provenance exact', async () => {
    const connection = await owner.pool.connect();
    const insertTerm = (
      id: string,
      seatId: string,
      sourceKind: 'appointment' | 'election',
      sourceElectionResultId: string | null,
      sourceProposalResultId: string | null,
    ) =>
      connection.query(
        `insert into office_terms(
           id,world_id,office_id,seat_id,holder_entity_id,source_kind,
           source_election_result_id,source_proposal_result_id,status,starts_tick,
           planned_ends_tick,term_number,checksum,created_command_id,
           created_event_id,created_state_revision
         ) values (
           $1,'018f0000-0000-7000-8000-00000000a300',
           '018f0000-0000-7000-8000-00000000a301',$2,
           '018f0000-0000-7000-8000-00000000a302',$3,$4,$5,'active',10,20,1,
           decode(repeat('a3',32),'hex'),
           '018f0000-0000-7000-8000-00000000a303',
           '018f0000-0000-7000-8000-00000000a304',1
         )`,
        [id, seatId, sourceKind, sourceElectionResultId, sourceProposalResultId],
      );
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await insertTerm(
        '018f0000-0000-7000-8000-00000000a310',
        '018f0000-0000-7000-8000-00000000a311',
        'appointment',
        null,
        null,
      );
      await insertTerm(
        '018f0000-0000-7000-8000-00000000a312',
        '018f0000-0000-7000-8000-00000000a313',
        'appointment',
        null,
        '018f0000-0000-7000-8000-00000000a314',
      );
      await insertTerm(
        '018f0000-0000-7000-8000-00000000a315',
        '018f0000-0000-7000-8000-00000000a316',
        'election',
        '018f0000-0000-7000-8000-00000000a317',
        null,
      );

      await connection.query('savepoint invalid_election_proposal');
      await expect(
        insertTerm(
          '018f0000-0000-7000-8000-00000000a318',
          '018f0000-0000-7000-8000-00000000a319',
          'election',
          '018f0000-0000-7000-8000-00000000a320',
          '018f0000-0000-7000-8000-00000000a321',
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'office_terms_shape_valid' });
      await connection.query('rollback to savepoint invalid_election_proposal');

      await connection.query('savepoint invalid_appointment_election');
      await expect(
        insertTerm(
          '018f0000-0000-7000-8000-00000000a322',
          '018f0000-0000-7000-8000-00000000a323',
          'appointment',
          '018f0000-0000-7000-8000-00000000a324',
          null,
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'office_terms_shape_valid' });
      await connection.query('rollback to savepoint invalid_appointment_election');

      await expect(
        connection.query<{ count: number }>(
          `select count(*)::integer as count from office_terms
            where world_id='018f0000-0000-7000-8000-00000000a300'`,
        ),
      ).resolves.toMatchObject({ rows: [{ count: 3 }] });
      await connection.query('rollback');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  });

  it('allows only command-bound law and office authority interval closures', async () => {
    const worldId = '018f0000-0000-7000-8000-00000000f501';
    const lawCommandId = '018f0000-0000-7000-8000-00000000f502';
    const officeCommandId = '018f0000-0000-7000-8000-00000000f503';
    const lawIntervalId = '018f0000-0000-7000-8000-00000000f504';
    const officeIntervalId = '018f0000-0000-7000-8000-00000000f505';
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_tick,opened_state_revision,opened_ledger_sequence,
           opened_event_sequence,write_gate_opened_at,status,correlation_id
         ) values
         ($1,$3,'CertifyAndEnactProposalV1',1,'system','worldgraph:scheduler',
          '{}'::jsonb,decode(repeat('f1',32),'hex'),'private',
          'law-authority-close-v1',decode(repeat('f2',32),'hex'),10,0,0,0,
          transaction_timestamp(),'received',
          '018f0000-0000-7000-8000-00000000f506'),
         ($2,$3,'CertifyElectionV1',1,'system','worldgraph:scheduler',
          '{}'::jsonb,decode(repeat('f3',32),'hex'),'private',
          'office-authority-close-v1',decode(repeat('f4',32),'hex'),10,0,0,0,
          transaction_timestamp(),'received',
          '018f0000-0000-7000-8000-00000000f507')`,
        [lawCommandId, officeCommandId, worldId],
      );
      await connection.query(
        `insert into world_entities(
           id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id,row_version
         ) values (
           '018f0000-0000-7000-8000-00000000f513',$1,
           'player:interval-guard','player_character',1,
           jsonb_build_object(
             'blueprintLogicalKey','blueprint:citizen',
             'homeDistrictLogicalKey','district:interval-guard',
             'membershipRole','player','name','Interval Guard Holder',
             'organizationLogicalKey',null
           ),'018f0000-0000-7000-8000-00000000f516',1
         )`,
        [worldId],
      );
      await connection.query(
        `insert into laws(
           id,world_id,jurisdiction_entity_id,stable_key,title,created_command_id,
           created_event_id,created_state_revision
         ) values (
           '018f0000-0000-7000-8000-00000000f508',$1,
           '018f0000-0000-7000-8000-00000000f517','law:interval-guard',
           'Interval Guard Law',$2,'018f0000-0000-7000-8000-00000000f518',1
         )`,
        [worldId, lawCommandId],
      );
      await connection.query(
        `insert into law_versions(
           id,world_id,law_id,law_version,version_kind,initial_status,title,
           summary,policy_ast,action_effects,effective_from_tick,checksum,
           created_command_id,created_event_id,created_state_revision
         ) values (
           '018f0000-0000-7000-8000-00000000f509',$1,
           '018f0000-0000-7000-8000-00000000f508',1,'create','active',
           'Interval Guard Law','Exercises authority interval closure.','{}'::jsonb,
           '{}'::jsonb,0,decode(repeat('f5',32),'hex'),$2,
           '018f0000-0000-7000-8000-00000000f519',1
         )`,
        [worldId, lawCommandId],
      );
      await connection.query(
        `insert into political_offices(
           id,world_id,institution_id,charter_version_id,stable_key,title,
           selection_method,seat_count,term_ticks,eligibility_policy,tie_policy,
           vacancy_policy,row_version,created_command_id,created_event_id,
           created_state_revision
         ) values (
           '018f0000-0000-7000-8000-00000000f510',$1,
           '018f0000-0000-7000-8000-00000000f520',
           '018f0000-0000-7000-8000-00000000f521','office:interval-guard',
           'Interval Guard Office','election',1,20,'{}'::jsonb,'vacancy',
           'special_election',1,$2,'018f0000-0000-7000-8000-00000000f522',1
         )`,
        [worldId, officeCommandId],
      );
      await connection.query(
        `insert into political_office_seats(
           id,world_id,office_id,seat_ordinal,stable_key,status,
           created_command_id,created_event_id
         ) values (
           '018f0000-0000-7000-8000-00000000f511',$1,
           '018f0000-0000-7000-8000-00000000f510',1,
           'office:interval-guard:seat:1','active',$2,
           '018f0000-0000-7000-8000-00000000f523'
         )`,
        [worldId, officeCommandId],
      );
      await connection.query(
        `insert into office_terms(
           id,world_id,office_id,seat_id,holder_entity_id,source_kind,status,
           starts_tick,planned_ends_tick,term_number,checksum,created_command_id,
           created_event_id,created_state_revision
         ) values (
           '018f0000-0000-7000-8000-00000000f512',$1,
           '018f0000-0000-7000-8000-00000000f510',
           '018f0000-0000-7000-8000-00000000f511',
           '018f0000-0000-7000-8000-00000000f513','initial','active',0,20,1,
           decode(repeat('f6',32),'hex'),$2,
           '018f0000-0000-7000-8000-00000000f524',1
         )`,
        [worldId, officeCommandId],
      );
      await connection.query(
        `insert into law_authority_intervals(
           id,world_id,law_id,law_version_id,effective_ticks,
           created_command_id,updated_command_id,row_version
         ) values (
           $1,$2,'018f0000-0000-7000-8000-00000000f508',
           '018f0000-0000-7000-8000-00000000f509',int8range(0,null,'[)'),
           $3,$3,1
         )`,
        [lawIntervalId, worldId, lawCommandId],
      );
      await connection.query(
        `insert into office_seat_authority_intervals(
           id,world_id,office_id,seat_id,term_id,holder_entity_id,effective_ticks,
           created_command_id,updated_command_id,row_version
         ) values (
           $1,$2,'018f0000-0000-7000-8000-00000000f510',
           '018f0000-0000-7000-8000-00000000f511',
           '018f0000-0000-7000-8000-00000000f512',
           '018f0000-0000-7000-8000-00000000f513',int8range(0,null,'[)'),
           $3,$3,1
         )`,
        [officeIntervalId, worldId, officeCommandId],
      );
      await connection.query(`set local session_replication_role = 'origin'`);

      await connection.query(
        `select set_config('worldgraph.command_world_id',$1,true),
                set_config('worldgraph.command_id',$2,true)`,
        [worldId, lawCommandId],
      );
      await connection.query('savepoint forbidden_law_identity');
      await expect(
        connection.query(
          `update law_authority_intervals
              set law_id='018f0000-0000-7000-8000-00000000f514',
                  effective_ticks=int8range(lower(effective_ticks),10,'[)'),
                  updated_command_id=$2,row_version=row_version+1,
                  updated_at=clock_timestamp()
            where world_id=$1 and id=$3`,
          [worldId, lawCommandId, lawIntervalId],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await connection.query('rollback to savepoint forbidden_law_identity');
      await expect(
        connection.query<{ effective_ticks: string; row_version: string }>(
          `update law_authority_intervals
              set effective_ticks=int8range(lower(effective_ticks),10,'[)'),
                  updated_command_id=$2,row_version=row_version+1,
                  updated_at=clock_timestamp()
            where world_id=$1 and id=$3
          returning effective_ticks::text,row_version::text`,
          [worldId, lawCommandId, lawIntervalId],
        ),
      ).resolves.toMatchObject({ rows: [{ effective_ticks: '[0,10)', row_version: '2' }] });

      await connection.query(`select set_config('worldgraph.command_id',$1,true)`, [
        officeCommandId,
      ]);
      await connection.query('savepoint forbidden_office_holder');
      await expect(
        connection.query(
          `update office_seat_authority_intervals
              set holder_entity_id='018f0000-0000-7000-8000-00000000f515',
                  effective_ticks=int8range(lower(effective_ticks),10,'[)'),
                  updated_command_id=$2,row_version=row_version+1,
                  updated_at=clock_timestamp()
            where world_id=$1 and id=$3`,
          [worldId, officeCommandId, officeIntervalId],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await connection.query('rollback to savepoint forbidden_office_holder');
      await expect(
        connection.query<{ effective_ticks: string; row_version: string }>(
          `update office_seat_authority_intervals
              set effective_ticks=int8range(lower(effective_ticks),10,'[)'),
                  updated_command_id=$2,row_version=row_version+1,
                  updated_at=clock_timestamp()
            where world_id=$1 and id=$3
          returning effective_ticks::text,row_version::text`,
          [worldId, officeCommandId, officeIntervalId],
        ),
      ).resolves.toMatchObject({ rows: [{ effective_ticks: '[0,10)', row_version: '2' }] });
      await connection.query('rollback');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  });

  it('enforces half-open authority ranges and append-only governance facts', async () => {
    const exclusionConstraints = await owner.pool.query<{ conname: string }>(
      `select conname from pg_constraint
        where contype = 'x' and conname = any($1::text[])
        order by conname`,
      [
        [
          'charter_authority_intervals_no_overlap',
          'law_authority_intervals_no_overlap',
          'office_seat_authority_intervals_no_overlap',
          'tax_policy_authority_intervals_no_overlap',
        ],
      ],
    );
    expect(exclusionConstraints.rows.map((row) => row.conname)).toEqual([
      'charter_authority_intervals_no_overlap',
      'law_authority_intervals_no_overlap',
      'office_seat_authority_intervals_no_overlap',
      'tax_policy_authority_intervals_no_overlap',
    ]);

    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `insert into tax_policy_authority_intervals(
           id,world_id,tax_policy_id,currency_id,tax_type,semantic_scope_key,
           effective_ticks,created_command_id,updated_command_id
         ) values (
           '018f0000-0000-7000-8000-00000000e001',
           '018f0000-0000-7000-8000-00000000e002',
           '018f0000-0000-7000-8000-00000000e003',
           '018f0000-0000-7000-8000-00000000e004','sales',repeat('a',64),
           int8range(0,10,'[)'),
           '018f0000-0000-7000-8000-00000000e005',
           '018f0000-0000-7000-8000-00000000e005'
         )`,
      );
      await expect(
        connection.query(
          `insert into tax_policy_authority_intervals(
             id,world_id,tax_policy_id,currency_id,tax_type,semantic_scope_key,
             effective_ticks,created_command_id,updated_command_id
           ) values (
             '018f0000-0000-7000-8000-00000000e011',
             '018f0000-0000-7000-8000-00000000e002',
             '018f0000-0000-7000-8000-00000000e013',
             '018f0000-0000-7000-8000-00000000e004','sales',repeat('a',64),
             int8range(9,20,'[)'),
             '018f0000-0000-7000-8000-00000000e005',
             '018f0000-0000-7000-8000-00000000e005'
           )`,
        ),
      ).rejects.toMatchObject({
        code: '23P01',
        constraint: 'tax_policy_authority_intervals_no_overlap',
      });
    } finally {
      await connection.query('rollback');
      connection.release();
    }

    const factConnection = await owner.pool.connect();
    try {
      await factConnection.query('begin');
      await factConnection.query(`set local session_replication_role = 'replica'`);
      await factConnection.query(
        `insert into treasury_encumbrance_facts(
           id,world_id,encumbrance_id,fact_sequence,fact_kind,amount_minor,
           command_id,event_id,state_revision,occurred_tick,checksum
         ) values (
           '018f0000-0000-7000-8000-00000000e021',
           '018f0000-0000-7000-8000-00000000e022',
           '018f0000-0000-7000-8000-00000000e023',1,'authorize',100,
           '018f0000-0000-7000-8000-00000000e024',
           '018f0000-0000-7000-8000-00000000e025',1,0,
           decode(repeat('ab',32),'hex')
         )`,
      );
      await factConnection.query('commit');
    } catch (error) {
      await factConnection.query('rollback');
      throw error;
    } finally {
      factConnection.release();
    }
    await expect(
      owner.pool.query(
        `update treasury_encumbrance_facts set amount_minor = 99
          where id = '018f0000-0000-7000-8000-00000000e021'`,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    const cleanupConnection = await owner.pool.connect();
    try {
      await cleanupConnection.query('begin');
      await cleanupConnection.query(`set local session_replication_role = 'replica'`);
      await cleanupConnection.query(
        `delete from treasury_encumbrance_facts
          where id = '018f0000-0000-7000-8000-00000000e021'`,
      );
      await cleanupConnection.query('commit');
    } catch (error) {
      await cleanupConnection.query('rollback');
      throw error;
    } finally {
      cleanupConnection.release();
    }
  });

  it('upgrades the exact sealed 0013 head through the additive capability boundary', async () => {
    const databaseName = 'worldgraph_exact_m10_capability_upgrade';
    await owner.pool.query(`create database ${databaseName}`);
    const url = new URL(container.getConnectionUri());
    url.pathname = `/${databaseName}`;
    const upgrade = createDatabaseClient(url.toString(), 'governance-capability-upgrade-owner');
    const exactM10Root = await createExactM10MigrationRoot();
    const userId = '018f0000-0000-7000-8000-00000000f101';
    const worldId = '018f0000-0000-7000-8000-00000000f102';
    try {
      await migrate(upgrade.db, { migrationsFolder: exactM10Root });
      await expect(
        upgrade.pool.query<{ migration_count: number; procedure_name: string | null }>(
          `select
             (select count(*)::integer from drizzle.__drizzle_migrations) as migration_count,
             to_regprocedure(
               'worldgraph_governance_actor_capability_v1(uuid,uuid,text,uuid,uuid)'
             )::text as procedure_name`,
        ),
      ).resolves.toMatchObject({ rows: [{ migration_count: 13, procedure_name: null }] });
      await upgrade.pool.query(
        `insert into users(id,email,password_hash,display_name)
         values ($1,'exact-m10@example.test',$2,'Exact M10 Creator')`,
        [userId, passwordHash],
      );
      const connection = await upgrade.pool.connect();
      try {
        await connection.query('begin');
        await connection.query(
          `insert into worlds(id,slug,name,created_by_user_id)
           values ($1,'exact-m10-world','Exact M10 World',$2)`,
          [worldId, userId],
        );
        await connection.query(
          `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
           values ($1,$2,'creator',$2)`,
          [worldId, userId],
        );
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }

      await migrate(upgrade.db, { migrationsFolder: migrationRoot });
      const result = await upgrade.pool.query<{
        membership_count: number;
        migration_count: number;
        procedure_name: string | null;
      }>(
        `select
           (select count(*)::integer from drizzle.__drizzle_migrations) as migration_count,
           (select count(*)::integer from world_memberships
             where world_id=$1 and user_id=$2) as membership_count,
           to_regprocedure(
             'worldgraph_governance_actor_capability_v1(uuid,uuid,text,uuid,uuid)'
           )::text as procedure_name`,
        [worldId, userId],
      );
      expect(result.rows).toEqual([
        {
          membership_count: 1,
          migration_count: 14,
          procedure_name: 'worldgraph_governance_actor_capability_v1(uuid,uuid,text,uuid,uuid)',
        },
      ]);
    } finally {
      await upgrade.pool.query('drop owned by worldgraph_governance_tally');
      await upgrade.pool.end();
      await rm(exactM10Root, { force: true, recursive: true });
    }
  }, 120_000);

  it('upgrades the exact M09/0012 head without silently inventing governance state', async () => {
    const databaseName = 'worldgraph_pre_m10_upgrade';
    await owner.pool.query(`create database ${databaseName}`);
    const url = new URL(container.getConnectionUri());
    url.pathname = `/${databaseName}`;
    const upgrade = createDatabaseClient(url.toString(), 'governance-upgrade-owner');
    const preM10Root = await createPreM10MigrationRoot();
    const userId = '018f0000-0000-7000-8000-00000000f001';
    const worldId = '018f0000-0000-7000-8000-00000000f002';
    try {
      await migrate(upgrade.db, { migrationsFolder: preM10Root });
      const connection = await upgrade.pool.connect();
      try {
        await connection.query('begin');
        await connection.query(
          `insert into users(id,email,password_hash,display_name)
           values ($1,'pre-m10@example.test',$2,'Pre M10 Creator')`,
          [userId, passwordHash],
        );
        await connection.query(
          `insert into worlds(id,slug,name,created_by_user_id)
           values ($1,'pre-m10-world','Pre M10 World',$2)`,
          [worldId, userId],
        );
        await connection.query(
          `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
           values ($1,$2,'creator',$2)`,
          [worldId, userId],
        );
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }

      await owner.pool.query('drop owned by worldgraph_governance_tally');
      await upgrade.pool.query('drop owned by worldgraph_governance_tally');
      await owner.pool.query('drop role worldgraph_governance_tally');
      await expect(migrate(upgrade.db, { migrationsFolder: migrationRoot })).rejects.toThrow(
        /worldgraph_governance_tally must be a LOGIN NOSUPERUSER/u,
      );
      await owner.pool.query(
        `create role worldgraph_governance_tally login password
           'worldgraph_governance_tally_local_only'
           nosuperuser nocreatedb nocreaterole noinherit`,
      );
      await migrate(upgrade.db, { migrationsFolder: migrationRoot });
      const result = await upgrade.pool.query<{
        governance_rows: number;
        migration_count: number;
        world_count: number;
      }>(
        `select
           (select count(*)::integer from drizzle.__drizzle_migrations) as migration_count,
           (select count(*)::integer from worlds where id = $1) as world_count,
           (
             (select count(*) from world_governance_heads where world_id = $1) +
             (select count(*) from compiled_governance_seed_plans where world_id = $1) +
             (select count(*) from governing_charters where world_id = $1) +
             (select count(*) from institutions where world_id = $1) +
             (select count(*) from laws where world_id = $1) +
             (select count(*) from political_offices where world_id = $1) +
             (select count(*) from proposals where world_id = $1) +
             (select count(*) from elections where world_id = $1)
           )::integer as governance_rows`,
        [worldId],
      );
      expect(result.rows).toEqual([{ governance_rows: 0, migration_count: 14, world_count: 1 }]);
      await expect(readRuntimeVersions(upgrade.pool)).resolves.toMatchObject({
        contracts: 10,
        governanceSchema: 1,
        runtimeSchema: 10,
      });
    } finally {
      await upgrade.pool.end();
      await rm(preM10Root, { force: true, recursive: true });
    }
  }, 120_000);
});
