import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabaseClient, readRuntimeVersions } from '@worldgraph/db';
import type { Pool } from 'pg';

interface GovernanceRestoreSnapshot {
  chainEvidence: Record<string, unknown>;
  counts: Record<string, number>;
  migrationCount: number;
  runtimeVersions: Record<string, unknown>;
}

interface GovernanceRestoreAccessEvidence {
  currentUsers: {
    app: string;
    tally: string;
  };
  directQueries: {
    appProposalsSelect: string;
    appSecretBallotChoicesSelect: string;
    tallyBallotParticipationSelect: string;
    tallySecretBallotChoicesSelect: string;
  };
  functionPrivileges: Array<{
    appCanExecute: boolean;
    publicCanExecute: boolean;
    signature: string;
    tallyCanExecute: boolean;
  }>;
  ownerPrivileges: {
    appBallotChoiceAssertionExecute: boolean;
    appBallotChoiceRevisionsSelect: boolean;
    appBallotEffectiveRevisionsSelect: boolean;
    appEffectiveRevisionAssertionExecute: boolean;
    appProposalsSelect: boolean;
    appSecretBallotChoicesSelect: boolean;
    tallyBallotParticipationSelect: boolean;
    tallyProposalTalliesMutation: boolean;
    tallySecretBallotChoicesSelect: boolean;
    tallyUsersSelect: boolean;
  };
}

/** Runs a real custom-format backup and restores it into an isolated database. */
export async function governanceBackupRestoreEvidence(
  container: StartedPostgreSqlContainer,
  source: Pool,
  worldId: string,
): Promise<{
  restored: GovernanceRestoreSnapshot;
  restoredAccess: GovernanceRestoreAccessEvidence;
  source: GovernanceRestoreSnapshot;
}> {
  const restoreDatabase = 'worldgraph_governance_restore';
  const dumpPath = '/tmp/worldgraph-governance.dump';
  const credentials = { PGPASSWORD: container.getPassword() };

  await checkedExec(
    container,
    [
      'pg_dump',
      '--username',
      container.getUsername(),
      '--dbname',
      container.getDatabase(),
      '--format=custom',
      '--no-owner',
      '--file',
      dumpPath,
    ],
    credentials,
  );
  await checkedExec(
    container,
    ['dropdb', '--if-exists', '--username', container.getUsername(), restoreDatabase],
    credentials,
  );
  await checkedExec(
    container,
    ['createdb', '--username', container.getUsername(), restoreDatabase],
    credentials,
  );
  await checkedExec(
    container,
    [
      'pg_restore',
      '--username',
      container.getUsername(),
      '--dbname',
      restoreDatabase,
      '--no-owner',
      '--exit-on-error',
      dumpPath,
    ],
    credentials,
  );

  const restoredUrl = new URL(container.getConnectionUri());
  restoredUrl.pathname = `/${restoreDatabase}`;
  const restored = createDatabaseClient(restoredUrl.toString(), 'governance-restore-verifier');
  const appUrl = new URL(restoredUrl.toString());
  appUrl.username = 'worldgraph_app';
  appUrl.password = 'worldgraph_app_local_only';
  const app = createDatabaseClient(appUrl.toString(), 'governance-restore-app-verifier');
  const tallyUrl = new URL(restoredUrl.toString());
  tallyUrl.username = 'worldgraph_governance_tally';
  tallyUrl.password = 'worldgraph_governance_tally_local_only';
  const tally = createDatabaseClient(tallyUrl.toString(), 'governance-restore-tally-verifier');
  try {
    return {
      restored: await restoreSnapshot(restored.pool, worldId),
      restoredAccess: await restoreAccessEvidence(restored.pool, app.pool, tally.pool, worldId),
      source: await restoreSnapshot(source, worldId),
    };
  } finally {
    await Promise.all([restored.pool.end(), app.pool.end(), tally.pool.end()]);
  }
}

async function checkedExec(
  container: StartedPostgreSqlContainer,
  command: string[],
  env: Record<string, string>,
): Promise<void> {
  const result = await container.exec(command, { env });
  if (result.exitCode !== 0) {
    throw new Error(`GOVERNANCE_BACKUP_RESTORE_COMMAND_FAILED: ${result.stderr || result.output}`);
  }
}

async function restoreAccessEvidence(
  owner: Pool,
  app: Pool,
  tally: Pool,
  worldId: string,
): Promise<GovernanceRestoreAccessEvidence> {
  const [ownerPrivileges, functionPrivileges, appCurrentUser, tallyCurrentUser] = await Promise.all(
    [
      owner.query<GovernanceRestoreAccessEvidence['ownerPrivileges']>(
        `select
           has_table_privilege('worldgraph_app','proposals','SELECT')
             as "appProposalsSelect",
           has_table_privilege('worldgraph_app','secret_ballot_choices','SELECT')
             as "appSecretBallotChoicesSelect",
           has_table_privilege('worldgraph_app','ballot_choice_revisions','SELECT')
             as "appBallotChoiceRevisionsSelect",
           has_table_privilege('worldgraph_app','ballot_effective_revisions','SELECT')
             as "appBallotEffectiveRevisionsSelect",
           has_table_privilege(
             'worldgraph_governance_tally','secret_ballot_choices','SELECT'
           ) as "tallySecretBallotChoicesSelect",
           has_table_privilege(
             'worldgraph_governance_tally','ballot_participation','SELECT'
           ) as "tallyBallotParticipationSelect",
           has_table_privilege('worldgraph_governance_tally','users','SELECT')
             as "tallyUsersSelect",
           (
             has_table_privilege(
               'worldgraph_governance_tally','proposal_tallies','INSERT'
             )
             or has_table_privilege(
               'worldgraph_governance_tally','proposal_tallies','UPDATE'
             )
             or has_table_privilege(
               'worldgraph_governance_tally','proposal_tallies','DELETE'
             )
             or has_table_privilege(
               'worldgraph_governance_tally','proposal_tallies','TRUNCATE'
             )
             or has_table_privilege(
               'worldgraph_governance_tally','proposal_tallies','TRIGGER'
             )
           ) as "tallyProposalTalliesMutation",
           has_function_privilege(
             'worldgraph_app','worldgraph_assert_ballot_choice_storage_v1()',
             'EXECUTE'
           ) as "appBallotChoiceAssertionExecute",
           has_function_privilege(
             'worldgraph_app','worldgraph_assert_effective_ballot_revision_v1()',
             'EXECUTE'
           ) as "appEffectiveRevisionAssertionExecute"`,
      ),
      owner.query<GovernanceRestoreAccessEvidence['functionPrivileges'][number]>(
        `with expected(signature,procedure_oid) as (
           values
           (
             'public.worldgraph_cast_governance_ballot_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,jsonb,bigint,boolean,bigint,uuid,uuid,bigint)',
             'public.worldgraph_cast_governance_ballot_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,jsonb,bigint,boolean,bigint,uuid,uuid,bigint)'::regprocedure
           ),
           (
             'public.worldgraph_persist_proposal_tally_v1(uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,integer,integer,integer,integer,bytea,bytea,bigint,uuid,uuid,uuid,uuid)',
             'public.worldgraph_persist_proposal_tally_v1(uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,integer,integer,integer,integer,bytea,bytea,bigint,uuid,uuid,uuid,uuid)'::regprocedure
           ),
           (
             'public.worldgraph_persist_election_tally_v1(uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,bytea,bytea,bigint,uuid,jsonb,uuid)',
             'public.worldgraph_persist_election_tally_v1(uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,bytea,bytea,bigint,uuid,jsonb,uuid)'::regprocedure
           ),
           (
             'public.worldgraph_recount_proposal_result_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,uuid,uuid,bigint,bigint)',
             'public.worldgraph_recount_proposal_result_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,uuid,uuid,bigint,bigint)'::regprocedure
           ),
           (
             'public.worldgraph_recount_election_result_v1(uuid,uuid,uuid,uuid,jsonb,uuid,bytea,bytea,uuid,uuid,bigint,bigint)',
             'public.worldgraph_recount_election_result_v1(uuid,uuid,uuid,uuid,jsonb,uuid,bytea,bytea,uuid,uuid,bigint,bigint)'::regprocedure
           )
         )
         select expected.signature,
           has_function_privilege(
             'worldgraph_app',expected.procedure_oid,'EXECUTE'
           ) as "appCanExecute",
           has_function_privilege(
             'worldgraph_governance_tally',expected.procedure_oid,'EXECUTE'
           ) as "tallyCanExecute",
           coalesce(aclcontains(
             procedure.proacl,
             makeaclitem(0,procedure.proowner,'EXECUTE',false)
           ),false) as "publicCanExecute"
         from expected
         join pg_proc procedure on procedure.oid=expected.procedure_oid
         order by expected.signature`,
      ),
      currentUser(app),
      currentUser(tally),
    ],
  );
  const ownerPrivilegeRow = ownerPrivileges.rows[0];
  if (!ownerPrivilegeRow) throw new Error('GOVERNANCE_RESTORE_PRIVILEGE_MATRIX_MISSING');

  const [appProposalsSelect, appSecretBallotChoicesSelect] = await Promise.all([
    queryOutcome(app, 'select count(*) from proposals where world_id=$1', [worldId]),
    queryOutcome(app, 'select count(*) from secret_ballot_choices where world_id=$1', [worldId]),
  ]);
  const [tallySecretBallotChoicesSelect, tallyBallotParticipationSelect] = await Promise.all([
    queryOutcome(tally, 'select count(*) from secret_ballot_choices where world_id=$1', [worldId]),
    queryOutcome(tally, 'select count(*) from ballot_participation where world_id=$1', [worldId]),
  ]);

  return {
    currentUsers: { app: appCurrentUser, tally: tallyCurrentUser },
    directQueries: {
      appProposalsSelect,
      appSecretBallotChoicesSelect,
      tallyBallotParticipationSelect,
      tallySecretBallotChoicesSelect,
    },
    functionPrivileges: functionPrivileges.rows,
    ownerPrivileges: ownerPrivilegeRow,
  };
}

async function currentUser(pool: Pool): Promise<string> {
  const result = await pool.query<{ current_user: string }>(
    'select current_user::text as current_user',
  );
  const user = result.rows[0]?.current_user;
  if (!user) throw new Error('GOVERNANCE_RESTORE_CURRENT_USER_MISSING');
  return user;
}

async function queryOutcome(pool: Pool, sql: string, values: unknown[]): Promise<string> {
  try {
    await pool.query(sql, values);
    return 'allowed';
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code;
    }
    throw error;
  }
}

async function restoreSnapshot(pool: Pool, worldId: string): Promise<GovernanceRestoreSnapshot> {
  const [migration, evidence, runtimeVersions] = await Promise.all([
    pool.query<{ migration_count: number }>(
      'select count(*)::integer as migration_count from drizzle.__drizzle_migrations',
    ),
    pool.query<{
      chain_evidence: Record<string, unknown>;
      counts: Record<string, number>;
    }>(
      `select jsonb_build_object(
          'runtimeStateRevision',runtime.state_revision::text,
          'governanceChecksum',encode(governance.checksum,'hex'),
          'lastEventSequence',runtime.last_event_sequence::text,
          'lastLedgerSequence',runtime.last_ledger_sequence::text,
          'lastLedgerHash',encode(ledger.last_entry_hash,'hex'),
          'commandHash',(
            select encode(extensions.digest(convert_to(coalesce(string_agg(
              command.id::text || ':' || command.status || ':' || encode(command.request_hash,'hex'),
              '|' order by command.id
            ),''),'UTF8'),'sha256'),'hex')
              from command_records command where command.world_id=$1
          ),
          'eventHash',(
            select encode(extensions.digest(convert_to(coalesce(string_agg(
              event.id::text || ':' || encode(event.event_hash,'hex'),
              '|' order by event.world_event_sequence
            ),''),'UTF8'),'sha256'),'hex')
              from domain_events event where event.world_id=$1
          ),
          'ledgerHash',(
            select encode(extensions.digest(convert_to(coalesce(string_agg(
              entry.id::text || ':' || encode(entry.entry_hash,'hex'),
              '|' order by entry.ledger_sequence
            ),''),'UTF8'),'sha256'),'hex')
              from ledger_entries entry where entry.world_id=$1
          ),
          'taxLineageHash',(
            select encode(extensions.digest(convert_to(coalesce(string_agg(
              lineage.id::text || ':' || encode(lineage.checksum,'hex'),
              '|' order by lineage.id
            ),''),'UTF8'),'sha256'),'hex')
              from governance_tax_policy_lineage lineage where lineage.world_id=$1
          )
        ) as chain_evidence,
        jsonb_build_object(
          'commands',(select count(*)::integer from command_records where world_id=$1),
          'events',(select count(*)::integer from domain_events where world_id=$1),
          'ledger',(select count(*)::integer from ledger_entries where world_id=$1),
          'history',(select count(*)::integer from world_history_entries where world_id=$1),
          'outbox',(select count(*)::integer from outbox_messages where world_id=$1),
          'proposals',(select count(*)::integer from proposals where world_id=$1),
          'proposalResults',(select count(*)::integer from proposal_results where world_id=$1),
          'elections',(select count(*)::integer from elections where world_id=$1),
          'electionResults',(select count(*)::integer from election_results where world_id=$1),
          'officeTerms',(select count(*)::integer from office_terms where world_id=$1),
          'laws',(select count(*)::integer from laws where world_id=$1),
          'taxAuthority',(select count(*)::integer from tax_policy_authority_intervals where world_id=$1),
          'taxLineage',(select count(*)::integer from governance_tax_policy_lineage where world_id=$1),
          'publicChoices',(select count(*)::integer from public_ballot_choices where world_id=$1),
          'secretChoices',(select count(*)::integer from secret_ballot_choices where world_id=$1),
          'recentProofs',(select count(*)::integer from recent_credential_proofs where world_id=$1),
          'proofConsumptions',(select count(*)::integer
            from recent_credential_proof_consumptions where world_id=$1)
        ) as counts
       from world_runtime_heads runtime
       join world_ledger_heads ledger on ledger.world_id=runtime.world_id
       join world_governance_heads governance on governance.world_id=runtime.world_id
      where runtime.world_id=$1`,
      [worldId],
    ),
    readRuntimeVersions(pool),
  ]);
  const row = evidence.rows[0];
  if (!row) throw new Error('GOVERNANCE_BACKUP_RESTORE_WORLD_MISSING');
  return {
    chainEvidence: row.chain_evidence,
    counts: row.counts,
    migrationCount: migration.rows[0]?.migration_count ?? 0,
    runtimeVersions,
  };
}
