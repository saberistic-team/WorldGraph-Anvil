import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  canonicalJson,
  type CommerceProjectionRepairPlanV1,
  type CompiledWorldV1,
  type EconomyRepairPlanV1,
} from '@worldgraph/contracts';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const operatorEntry = resolve('packages/db/src/cli/operator.ts');
const workspaceRoot = resolve('.');
const creatorId = '078f0000-0000-7000-8000-000000000001';
const firstAdminId = '078f0000-0000-7000-8000-000000000002';
const secondAdminId = '078f0000-0000-7000-8000-000000000003';
const thirdAdminId = '078f0000-0000-7000-8000-000000000004';
const worldId = '078f0000-0000-7000-8000-000000000101';
const revisionId = '078f0000-0000-7000-8000-000000000201';
const compilationRunId = '078f0000-0000-7000-8000-000000000301';
const versionId = '078f0000-0000-7000-8000-000000000401';
const accountId = '078f0000-0000-7000-8000-000000000501';
const characterId = '078f0000-0000-7000-8000-000000000502';
const relationshipId = '078f0000-0000-7000-8000-000000000601';
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const replayReason = 'INCIDENT-OPERATOR-REPLAY verified shadow restoration';

interface CliResult {
  code: number;
  stderr: string;
  stdout: string;
}

function memberPrincipalKey(checkedWorldId: string, userId: string): string {
  return `member-${createHash('sha256')
    .update(
      `worldgraph-member-principal-v1\0${checkedWorldId.toLowerCase()}\0${userId.toLowerCase()}`,
    )
    .digest('hex')
    .slice(0, 32)}`;
}

async function transaction<T>(pool: Pool, operation: (connection: PoolClient) => Promise<T>) {
  const connection = await pool.connect();
  try {
    await connection.query('begin isolation level serializable');
    const result = await operation(connection);
    await connection.query('commit');
    return result;
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function runOperator(
  args: readonly string[],
  urls: { database?: string; operations?: string },
): Promise<CliResult> {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.OPERATIONS_DATABASE_URL;
  if (urls.database) environment.DATABASE_URL = urls.database;
  if (urls.operations) environment.OPERATIONS_DATABASE_URL = urls.operations;
  return await new Promise<CliResult>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', operatorEntry, ...args], {
      cwd: workspaceRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolveResult({ code: code ?? 1, stderr, stdout });
    });
  });
}

function outputJson<T>(result: CliResult): T {
  const line = result.stdout.trim().split('\n').at(-1);
  if (!line) throw new Error(`Operator command produced no JSON output: ${result.stderr}`);
  return JSON.parse(line) as T;
}

async function seedOperatorWorld(pool: Pool): Promise<void> {
  const principalKey = memberPrincipalKey(worldId, creatorId);
  const accountLogicalKey = `account:${principalKey}`;
  const characterLogicalKey = `character:${principalKey}`;
  const relationshipLogicalKey = `rel:account_controls:${principalKey}`;
  const accountState = { membershipRole: 'creator' as const, principalKey };
  const characterState = {
    blueprintLogicalKey: 'actor-blueprint:operator',
    homeDistrictLogicalKey: 'district:operator',
    membershipRole: 'creator' as const,
    name: 'Operator Character',
    organizationLogicalKey: null,
  };
  const manifestHash = Buffer.alloc(32, 21);
  const inputHash = Buffer.alloc(32, 22);
  const artifactHash = Buffer.alloc(32, 23);
  const compiledWorld = {
    artifactSchemaVersion: 1,
    compilerConfigVersion: 1,
    compilerVersion: '1.0.0',
    controllers: [
      {
        controlScope: 'primary',
        entityLogicalKey: characterLogicalKey,
        principalKey,
      },
    ],
    counts: { controllers: 1, entities: 2, relationships: 1 },
    entities: [
      {
        entitySchemaVersion: 1,
        entityType: 'account_principal',
        logicalKey: accountLogicalKey,
        state: accountState,
      },
      {
        entitySchemaVersion: 1,
        entityType: 'player_character',
        logicalKey: characterLogicalKey,
        state: characterState,
      },
    ],
    inputHash: inputHash.toString('hex'),
    manifestContentHash: manifestHash.toString('hex'),
    manifestSchemaVersion: 1,
    metadata: {
      archetype: 'city-state',
      description: 'A deterministic operator integration world.',
      name: 'Operator World',
    },
    relationships: [
      {
        attributes: {},
        logicalKey: relationshipLogicalKey,
        relationshipSchemaVersion: 1,
        relationshipType: 'account_controls',
        sourceLogicalKey: accountLogicalKey,
        targetLogicalKey: characterLogicalKey,
      },
    ],
    seed: 'operator-integration-seed',
    visualPlan: {
      direction: 'Operator integration visual plan.',
      districts: [],
      schemaVersion: 1,
      stylePrimitiveLogicalKey: 'primitive:operator-style',
      terrainPrimitiveLogicalKey: 'primitive:operator-terrain',
    },
    worldGraphSchemaVersion: 1,
  } satisfies CompiledWorldV1;

  await transaction(pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into users(id,email,password_hash,display_name,platform_role) values
        ($1,'operator-creator@example.test',$5,'Operator Creator','user'),
        ($2,'operator-admin-1@example.test',$5,'Operator Admin One','platform_admin'),
        ($3,'operator-admin-2@example.test',$5,'Operator Admin Two','platform_admin'),
        ($4,'operator-admin-3@example.test',$5,'Operator Admin Three','platform_admin')`,
      [creatorId, firstAdminId, secondAdminId, thirdAdminId, passwordHash],
    );
    await connection.query(
      `insert into worlds(id,slug,name,lifecycle,created_by_user_id)
       values ($1,'operator-world','Operator World','compiling',$2)`,
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
          metadata: { key: 'operator-world', name: 'Operator World' },
          primitiveRefs: [],
        },
        manifestHash,
        creatorId,
      ],
    );
    await connection.query(
      `update worlds set current_approved_manifest_revision_id=$2,manifest_schema_version=1
       where id=$1`,
      [worldId, revisionId],
    );
    await connection.query(
      `insert into world_compilation_runs(
        id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
        compiler_version,compiler_config_version,seed,status,stage,progress_percent,
        requested_by_user_id,idempotency_key,attempts,claim_token,claimed_at,
        heartbeat_at,started_at,updated_at
      ) values ($1,$2,$3,$4,$5,'1.0.0',1,'operator-integration-seed',
        'running','seeding',90,$6,'operator-integration-compilation',1,$7,
        now(),now(),now(),now())`,
      [
        compilationRunId,
        worldId,
        revisionId,
        manifestHash,
        inputHash,
        creatorId,
        '078f0000-0000-7000-8000-000000000701',
      ],
    );
    await connection.query(
      `insert into compiled_world_artifacts(
        id,world_id,compilation_run_id,artifact_kind,artifact_schema_version,
        canonical_content,content_hash
      ) values
        ($1,$4,$5,'compiler_input',1,'{}',$6),
        ($2,$4,$5,'compiled_world',1,$7,$8),
        ($3,$4,$5,'visual_plan',1,'{}',$9)`,
      [
        '078f0000-0000-7000-8000-000000000711',
        '078f0000-0000-7000-8000-000000000712',
        '078f0000-0000-7000-8000-000000000713',
        worldId,
        compilationRunId,
        Buffer.alloc(32, 24),
        compiledWorld,
        artifactHash,
        Buffer.alloc(32, 25),
      ],
    );
    await connection.query(
      `insert into world_versions(
        id,world_id,version_number,manifest_revision_id,compilation_run_id,
        world_schema_version,compiler_version,compiler_config_version,seed,
        artifact_hash,status,created_by_user_id
      ) values ($1,$2,1,$3,$4,1,'1.0.0',1,'operator-integration-seed',$5,'staging',$6)`,
      [versionId, worldId, revisionId, compilationRunId, artifactHash, creatorId],
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
        accountLogicalKey,
        accountState,
        characterLogicalKey,
        versionId,
        characterState,
      ],
    );
    await connection.query(
      `insert into world_relationships(
        id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
        relationship_schema_version,attributes,created_world_version_id
      ) values ($1,$2,$3,'account_controls',$4,$5,1,'{}',$6)`,
      [relationshipId, worldId, relationshipLogicalKey, accountId, characterId, versionId],
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
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(
      `select * from worldgraph_append_compiled_genesis($1,$2,$3,$4,$5,$6,$7)`,
      [
        worldId,
        versionId,
        compilationRunId,
        '078f0000-0000-7000-8000-000000000721',
        '078f0000-0000-7000-8000-000000000722',
        '078f0000-0000-7000-8000-000000000723',
        '078f0000-0000-7000-8000-000000000724',
      ],
    );
    await connection.query(
      `update world_versions set status='active',activated_at=now() where id=$1`,
      [versionId],
    );
    await connection.query(
      `update worlds set lifecycle='active',active_world_version_id=$2,
        row_version=row_version+1,updated_at=now() where id=$1`,
      [worldId, versionId],
    );
    await connection.query(
      `update world_compilation_runs set status='succeeded',stage='activated',
        progress_percent=100,artifact_hash=$2,claim_token=null,completed_at=now(),
        updated_at=now(),row_version=row_version+1 where id=$1`,
      [compilationRunId, artifactHash],
    );
  });
}

describe.sequential('M06 operator ledger/replay CLI against PostgreSQL', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;
  let ownerUrl: string;
  let appUrl: string;
  let replayRunId: string;
  let simulationReplayRunId: string;
  let exportRoot: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    ownerUrl = container.getConnectionUri();
    owner = createDatabaseClient(ownerUrl, 'operator-cli-owner-test');
    await migrate(owner.db, { migrationsFolder: migrationRoot });
    await seedOperatorWorld(owner.pool);
    const appConnection = new URL(ownerUrl);
    appConnection.username = 'worldgraph_app';
    appConnection.password = 'worldgraph_app_local_only';
    appUrl = appConnection.toString();
    exportRoot = await mkdtemp(join(tmpdir(), 'worldgraph-operator-export-'));
  });

  afterAll(async () => {
    await owner?.pool.end();
    await container?.stop();
    if (exportRoot) await rm(exportRoot, { force: true, recursive: true });
  });

  it('verifies an anchored live world with read-only application credentials', async () => {
    const result = await runOperator(['ledger', 'verify', '--world', worldId], {
      database: appUrl,
    });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(outputJson(result)).toMatchObject({
      entryCount: 2,
      eventCount: 2,
      failures: [],
      lastLedgerSequence: '2',
      projectionChecksumValid: true,
      valid: true,
      worldId,
    });
  });

  it('requeues one dead outbox message through an owner-only audited intent', async () => {
    const retryIntentId = '078f0000-0000-7000-8000-000000000725';
    const reason = 'INCIDENT-OUTBOX-001 compatible publisher restored after transport failure';
    const selected = await owner.pool.query<{ id: string }>(
      `select id from outbox_messages where world_id=$1 order by created_at,id limit 1`,
      [worldId],
    );
    const outboxMessageId = selected.rows[0]?.id;
    expect(outboxMessageId).toBeDefined();
    await owner.pool.query(
      `update outbox_messages
          set status='dead', attempts=1, locked_at=null, locked_by=null, published_at=null
        where id=$1 and world_id=$2`,
      [outboxMessageId, worldId],
    );
    const args = [
      'outbox',
      'retry',
      '--world',
      worldId,
      '--message',
      outboxMessageId!,
      '--retry',
      retryIntentId,
      '--reason',
      reason,
      '--confirm',
      'RETRY DEAD OUTBOX MESSAGE',
      '--actor',
      firstAdminId,
    ] as const;

    const applicationRole = await runOperator(args, { operations: appUrl });
    expect(applicationRole.code).toBe(1);
    expect(applicationRole.stderr).toContain('database role is not authorized');

    const wrongConfirmation = await runOperator(
      args.map((value) => (value === 'RETRY DEAD OUTBOX MESSAGE' ? 'RETRY' : value)),
      { operations: ownerUrl },
    );
    expect(wrongConfirmation.code).toBe(1);
    expect(wrongConfirmation.stderr).toContain('--confirm=RETRY DEAD OUTBOX MESSAGE is required');

    const retried = await runOperator(args, { operations: ownerUrl });
    expect(retried).toMatchObject({ code: 0, stderr: '' });
    const firstReceipt = outputJson<{
      currentAttempts: number;
      currentStatus: string;
      idempotentReplay: boolean;
      outboxMessageId: string;
      previousAttempts: number;
      requeuedAt: string;
      retryIntentId: string;
      schemaVersion: number;
      worldId: string;
    }>(retried);
    expect(firstReceipt).toMatchObject({
      currentAttempts: 1,
      currentStatus: 'pending',
      idempotentReplay: false,
      outboxMessageId,
      previousAttempts: 1,
      retryIntentId,
      schemaVersion: 1,
      worldId,
    });
    expect(new Date(firstReceipt.requeuedAt).toISOString()).toBe(firstReceipt.requeuedAt);
    expect(retried.stdout).not.toContain(reason);

    const evidence = await owner.pool.query<{
      action: string;
      attempts: number;
      intent_count: number;
      reason_code: string;
      status: string;
    }>(
      `select message.status::text as status, message.attempts,
              audit.action, audit.reason_code,
              count(*) over ()::integer as intent_count
         from outbox_retry_intents intent
         join outbox_messages message
           on message.id=intent.outbox_message_id and message.world_id=intent.world_id
         join security_audit_records audit
           on audit.id=intent.audit_id and audit.world_id=intent.world_id
          and audit.actor_user_id=intent.actor_user_id
        where intent.id=$1 and intent.world_id=$2`,
      [retryIntentId, worldId],
    );
    expect(evidence.rows).toEqual([
      {
        action: 'outbox.retry.authorized',
        attempts: 1,
        intent_count: 1,
        reason_code: 'OPERATOR_OUTBOX_RETRY',
        status: 'pending',
      },
    ]);

    const exactReplay = await runOperator(args, { operations: ownerUrl });
    expect(exactReplay).toMatchObject({ code: 0, stderr: '' });
    expect(outputJson(exactReplay)).toEqual({
      ...firstReceipt,
      idempotentReplay: true,
    });
    const changedReplay = await runOperator(
      args.map((value) => (value === reason ? `${reason} with changed evidence` : value)),
      { operations: ownerUrl },
    );
    expect(changedReplay.code).toBe(1);
    expect(changedReplay.stderr).toContain('reused with different inputs');

    const application = createDatabaseClient(appUrl, 'outbox-retry-application-test');
    try {
      await expect(
        transaction(application.pool, async (connection) => {
          await connection.query(
            `update outbox_messages
                set status='dead',locked_at=null,locked_by=null,published_at=null
              where id=$1 and world_id=$2`,
            [outboxMessageId, worldId],
          );
          await connection.query(
            `select set_config('worldgraph.outbox_retry_execution_gate','forged',true)`,
          );
          await connection.query(
            `update outbox_messages set status='pending'
              where id=$1 and world_id=$2`,
            [outboxMessageId, worldId],
          );
        }),
      ).rejects.toMatchObject({ code: '55000' });
      const claimed = await application.pool.query<{ attempts: number }>(
        `update outbox_messages
            set attempts=attempts+1,locked_at=clock_timestamp(),locked_by='operator-test-worker'
          where id=$1 and world_id=$2 and status='pending'
          returning attempts`,
        [outboxMessageId, worldId],
      );
      expect(claimed.rows).toEqual([{ attempts: 2 }]);
      await expect(
        application.pool.query(
          `update outbox_messages
              set status='dead',locked_at=null,locked_by=null,published_at=null
            where id=$1 and world_id=$2 and status='pending'
              and locked_by='operator-test-worker' and attempts=2`,
          [outboxMessageId, worldId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      const exhaustedReplay = await runOperator(args, { operations: ownerUrl });
      expect(exhaustedReplay.code).toBe(1);
      expect(exhaustedReplay.stderr).toContain(
        'message is dead again; review the new failure and use a new --retry identity',
      );
      const nextRetryIntentId = '078f0000-0000-7000-8000-000000000726';
      const nextArgs = args.map((value) => (value === retryIntentId ? nextRetryIntentId : value));
      const nextRetry = await runOperator(nextArgs, { operations: ownerUrl });
      expect(nextRetry).toMatchObject({ code: 0, stderr: '' });
      expect(outputJson(nextRetry)).toMatchObject({
        currentAttempts: 2,
        currentStatus: 'pending',
        idempotentReplay: false,
        outboxMessageId,
        previousAttempts: 2,
        retryIntentId: nextRetryIntentId,
        schemaVersion: 1,
        worldId,
      });
      const nextClaim = await application.pool.query<{ attempts: number }>(
        `update outbox_messages
            set attempts=attempts+1,locked_at=clock_timestamp(),locked_by='operator-test-worker'
          where id=$1 and world_id=$2 and status='pending'
          returning attempts`,
        [outboxMessageId, worldId],
      );
      expect(nextClaim.rows).toEqual([{ attempts: 3 }]);
      await expect(
        application.pool.query(
          `update outbox_messages
              set status='published',published_at=clock_timestamp(),locked_at=null,locked_by=null
            where id=$1 and world_id=$2 and status='pending'
              and locked_by='operator-test-worker' and attempts=3`,
          [outboxMessageId, worldId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await application.pool.end();
    }
    const privileges = await owner.pool.query<{
      app_can_delete_intents: boolean;
      app_can_execute: boolean;
      app_can_execute_trigger: boolean;
      app_can_insert_intents: boolean;
      app_can_read_intents: boolean;
      app_can_update_intents: boolean;
      public_can_execute_trigger: boolean;
    }>(
      `select
         has_function_privilege(
           'worldgraph_app',
           'worldgraph_retry_dead_outbox_message(uuid,uuid,uuid,uuid,text,text)',
           'EXECUTE'
         ) as app_can_execute,
         has_function_privilege(
           'worldgraph_app', 'worldgraph_protect_outbox_message()', 'EXECUTE'
         ) as app_can_execute_trigger,
         exists (
           select 1
             from pg_proc procedure
             cross join lateral aclexplode(
               coalesce(procedure.proacl, acldefault('f',procedure.proowner))
             ) privilege
            where procedure.oid='worldgraph_protect_outbox_message()'::regprocedure
              and privilege.grantee=0 and privilege.privilege_type='EXECUTE'
         ) as public_can_execute_trigger,
         has_table_privilege('worldgraph_app','outbox_retry_intents','SELECT')
           as app_can_read_intents,
         has_table_privilege('worldgraph_app','outbox_retry_intents','INSERT')
           as app_can_insert_intents,
         has_table_privilege('worldgraph_app','outbox_retry_intents','UPDATE')
           as app_can_update_intents,
         has_table_privilege('worldgraph_app','outbox_retry_intents','DELETE')
           as app_can_delete_intents`,
    );
    expect(privileges.rows).toEqual([
      {
        app_can_delete_intents: false,
        app_can_execute: false,
        app_can_execute_trigger: false,
        app_can_insert_intents: false,
        app_can_read_intents: false,
        app_can_update_intents: false,
        public_can_execute_trigger: false,
      },
    ]);
  });

  it('fails closed on economy repair credentials and malformed operator input', async () => {
    const prepareArgs = [
      'economy',
      'repair-prepare',
      '--world',
      worldId,
      '--source-command',
      '078f0000-0000-7000-8000-000000000901',
      '--reason-code',
      'INCIDENT_RECOVERY',
      '--incident-reason',
      'INCIDENT-ECONOMY-001 exact source effect requires compensation',
      '--pitr-not-used-reason',
      'PITR exceeds the approved recovery objective for this isolated effect',
      '--actor',
      firstAdminId,
    ] as const;
    const missingOperations = await runOperator(prepareArgs, { database: appUrl });
    expect(missingOperations.code).toBe(1);
    expect(missingOperations.stderr).toContain('OPERATIONS_DATABASE_URL is required');

    const appRole = await runOperator(prepareArgs, { operations: appUrl });
    expect(appRole.code).toBe(1);
    expect(appRole.stderr).toContain('database role is not authorized');

    const inactiveAuthority = await runOperator(
      prepareArgs.map((value) => (value === firstAdminId ? creatorId : value)),
      { operations: ownerUrl },
    );
    expect(inactiveAuthority.code).toBe(1);
    expect(inactiveAuthority.stderr).toContain('active platform administrator');

    const malformedSource = await runOperator(
      prepareArgs.map((value) =>
        value === '078f0000-0000-7000-8000-000000000901' ? 'not-a-command-id' : value,
      ),
      { operations: ownerUrl },
    );
    expect(malformedSource.code).toBe(1);
    expect(malformedSource.stderr).toContain('--source-command must be a UUID');

    const unknownReasonCode = await runOperator(
      prepareArgs.map((value) => (value === 'INCIDENT_RECOVERY' ? 'MANUAL_EDIT' : value)),
      { operations: ownerUrl },
    );
    expect(unknownReasonCode.code).toBe(1);
    expect(unknownReasonCode.stderr).toContain(
      '--reason-code must be DUPLICATE_EFFECT, ERRONEOUS_EFFECT, or INCIDENT_RECOVERY',
    );

    const untrimmedReason = await runOperator(
      prepareArgs.map((value) =>
        value === 'INCIDENT-ECONOMY-001 exact source effect requires compensation'
          ? ' incident reason must not be normalized by the CLI'
          : value,
      ),
      { operations: ownerUrl },
    );
    expect(untrimmedReason.code).toBe(1);
    expect(untrimmedReason.stderr).toContain(
      'must contain 8-500 Unicode code points without edge ASCII spaces or C0/DEL/C1 controls',
    );

    for (const invalidReason of [
      'incident reason must not end with an ASCII space ',
      '😀'.repeat(501),
      'incident reason contains C0\u001fcontrol',
      'incident reason contains DEL\u007fcontrol',
      'incident reason contains C1\u0085control',
    ]) {
      const invalidReasonResult = await runOperator(
        prepareArgs.map((value) =>
          value === 'INCIDENT-ECONOMY-001 exact source effect requires compensation'
            ? invalidReason
            : value,
        ),
        { operations: ownerUrl },
      );
      expect(invalidReasonResult.code).toBe(1);
      expect(invalidReasonResult.stderr).toContain(
        'must contain 8-500 Unicode code points without edge ASCII spaces or C0/DEL/C1 controls',
      );
    }

    const unknownOption = await runOperator([...prepareArgs, '--delta', '1'], {
      operations: ownerUrl,
    });
    expect(unknownOption.code).toBe(1);
    expect(unknownOption.stderr).toContain('Unexpected option for economy repair-prepare: --delta');

    const executeArgs = [
      'economy',
      'repair-execute',
      '--world',
      worldId,
      '--plan',
      '078f0000-0000-7000-8000-000000000902',
      '--plan-hash',
      'A'.repeat(64),
      '--confirm',
      'APPLY APPEND-ONLY ECONOMY REPAIR',
      '--actor',
      firstAdminId,
    ] as const;
    const uppercaseHash = await runOperator(executeArgs, { operations: ownerUrl });
    expect(uppercaseHash.code).toBe(1);
    expect(uppercaseHash.stderr).toContain(
      '--plan-hash must be 64 lowercase hexadecimal characters',
    );

    const wrongConfirmation = await runOperator(
      executeArgs.map((value) => {
        if (value === 'A'.repeat(64)) return 'a'.repeat(64);
        if (value === 'APPLY APPEND-ONLY ECONOMY REPAIR') return 'REPAIR';
        return value;
      }),
      { operations: ownerUrl },
    );
    expect(wrongConfirmation.code).toBe(1);
    expect(wrongConfirmation.stderr).toContain(
      '--confirm=APPLY APPEND-ONLY ECONOMY REPAIR is required',
    );
  });

  it('fails closed on commerce projection repair credentials and malformed review input', async () => {
    const prepareArgs = [
      'economy',
      'projection-repair-prepare',
      '--world',
      worldId,
      '--reason',
      'INCIDENT-COMMERCE-001 immutable journal and inventory projection differ',
      '--actor',
      firstAdminId,
    ] as const;
    const missingOperations = await runOperator(prepareArgs, { database: appUrl });
    expect(missingOperations.code).toBe(1);
    expect(missingOperations.stderr).toContain('OPERATIONS_DATABASE_URL is required');

    const appRole = await runOperator(prepareArgs, { operations: appUrl });
    expect(appRole.code).toBe(1);
    expect(appRole.stderr).toContain('database role is not authorized');

    const shortReason = await runOperator(
      prepareArgs.map((value) =>
        value === 'INCIDENT-COMMERCE-001 immutable journal and inventory projection differ'
          ? 'too short'
          : value,
      ),
      { operations: ownerUrl },
    );
    expect(shortReason.code).toBe(1);
    expect(shortReason.stderr).toContain('20-1000 Unicode code points');

    const unknownOption = await runOperator([...prepareArgs, '--inventory', worldId], {
      operations: ownerUrl,
    });
    expect(unknownOption.code).toBe(1);
    expect(unknownOption.stderr).toContain(
      'Unexpected option for economy projection-repair-prepare: --inventory',
    );

    const approvalArgs = [
      'economy',
      'projection-repair-approve',
      '--world',
      worldId,
      '--plan',
      '078f0000-0000-7000-8000-000000000921',
      '--approval',
      '078f0000-0000-7000-8000-000000000922',
      '--plan-hash',
      'A'.repeat(64),
      '--confirm',
      'APPROVE APPEND-ONLY COMMERCE REPAIR',
      '--actor',
      secondAdminId,
    ] as const;
    const uppercaseHash = await runOperator(approvalArgs, { operations: ownerUrl });
    expect(uppercaseHash.code).toBe(1);
    expect(uppercaseHash.stderr).toContain(
      '--plan-hash must be 64 lowercase hexadecimal characters',
    );

    const wrongApproval = await runOperator(
      approvalArgs.map((value) => {
        if (value === 'A'.repeat(64)) return 'a'.repeat(64);
        if (value === 'APPROVE APPEND-ONLY COMMERCE REPAIR') return 'approve';
        return value;
      }),
      { operations: ownerUrl },
    );
    expect(wrongApproval.code).toBe(1);
    expect(wrongApproval.stderr).toContain(
      '--confirm=APPROVE APPEND-ONLY COMMERCE REPAIR is required',
    );

    const executionArgs = [
      'economy',
      'projection-repair-execute',
      '--world',
      worldId,
      '--plan',
      '078f0000-0000-7000-8000-000000000921',
      '--plan-hash',
      'a'.repeat(64),
      '--confirm',
      'REPAIR',
      '--actor',
      firstAdminId,
    ] as const;
    const wrongExecution = await runOperator(executionArgs, { operations: ownerUrl });
    expect(wrongExecution.code).toBe(1);
    expect(wrongExecution.stderr).toContain(
      '--confirm=APPLY APPEND-ONLY COMMERCE REPAIR is required',
    );
  });

  it('accepts an owner-member operator, validates the private plan, and emits a safe receipt', async () => {
    const operationsMemberRole = 'worldgraph_operations_test';
    const operationsMemberPassword = 'worldgraph_operations_test_password';
    const operationsMemberConnection = new URL(ownerUrl);
    operationsMemberConnection.username = operationsMemberRole;
    operationsMemberConnection.password = operationsMemberPassword;
    const operationsMemberUrl = operationsMemberConnection.toString();
    const sourceCommandId = '078f0000-0000-7000-8000-000000000901';
    const repairPlanId = '078f0000-0000-7000-8000-000000000902';
    const reservedCommandId = '078f0000-0000-7000-8000-000000000903';
    const compensationTransactionId = '078f0000-0000-7000-8000-000000000904';
    const currencyId = '078f0000-0000-7000-8000-000000000905';
    const walletId = '078f0000-0000-7000-8000-000000000906';
    const sourceTransactionId = '078f0000-0000-7000-8000-000000000907';
    const reconciliationRunId = '078f0000-0000-7000-8000-000000000908';
    const repairCommandId = '078f0000-0000-7000-8000-000000000909';
    const repairEventId = '078f0000-0000-7000-8000-000000000910';
    const repairLedgerEntryId = '078f0000-0000-7000-8000-000000000911';
    const incidentReason = 'INCIDENT-ECONOMY-001 exact source effect requires compensation';
    const pitrNotUsedReason =
      'PITR exceeds the approved recovery objective for this isolated effect';
    const planBody = {
      delta: {
        financialDelta: {
          compensationTransactionId,
          currencyId,
          postings: [
            {
              balanceAfterMinor: '0',
              balanceBeforeMinor: '10',
              balanceVersionAfter: '2',
              balanceVersionBefore: '1',
              compensationSignedAmountMinor: '-10',
              sourcePostingOrdinal: 0,
              sourceSignedAmountMinor: '10',
              walletId,
            },
          ],
          reversalOfTransactionId: sourceTransactionId,
          supply: {
            compensationSupplyDeltaMinor: '-10',
            currencyId,
            sourceSupplyDeltaMinor: '10',
            supplyAfterMinor: '0',
            supplyBeforeMinor: '10',
            supplyVersionAfter: '2',
            supplyVersionBefore: '1',
          },
        },
        repairKind: 'reverse_financial_transaction',
        titleDelta: null,
      },
      domain: 'worldgraph.economy-repair-plan.v1',
      expiresAt: '2026-07-23T15:00:00.000Z',
      incidentReason,
      pitrNotUsedReason,
      preparedAt: '2026-07-22T15:00:00.000Z',
      preparedByUserId: firstAdminId,
      reasonCode: 'INCIDENT_RECOVERY',
      repairKind: 'reverse_financial_transaction',
      repairPlanId,
      repairPlanSchemaVersion: 1,
      reservedCommandId,
      sourceCommandId,
      sourceEconomyChecksum: 'b'.repeat(64),
      sourceEconomyHeadVersion: '4',
      sourceEventSequence: '8',
      sourceReconciliationRunId: reconciliationRunId,
      sourceStateRevision: '8',
      sourceWorldVersion: '1',
      worldId,
    } as const satisfies Omit<EconomyRepairPlanV1, 'planHash'>;
    const plan: EconomyRepairPlanV1 = {
      ...planBody,
      planHash: createHash('sha256')
        .update(
          canonicalJson({
            domain: 'worldgraph.economy-repair-plan-hash.v1',
            plan: planBody,
          }),
        )
        .digest('hex'),
    };

    await owner.pool.query(
      `create role worldgraph_operations_test login
         password 'worldgraph_operations_test_password';
       grant worldgraph_owner to worldgraph_operations_test;
       create schema operator_repair_stub authorization worldgraph_owner`,
    );
    try {
      await owner.pool.query(
        `create table operator_repair_stub.repair_fixture(
           world_id uuid not null,
           source_command_id uuid not null,
           prepared_by_user_id uuid not null,
           reason_code text not null,
           incident_reason text not null,
           pitr_not_used_reason text not null,
           plan jsonb not null
         );
         create table operator_repair_stub.economy_repair_plans(
           id uuid primary key, world_id uuid not null, plan_hash bytea not null
         );
         create table operator_repair_stub.execution_fixture(
           repair_plan_id uuid not null,
           executing_admin_user_id uuid not null,
           plan_hash text not null,
           command_id uuid not null,
           event_id uuid not null,
           ledger_entry_id uuid not null,
           financial_transaction_id uuid not null
         )`,
      );
      await owner.pool.query(
        `insert into operator_repair_stub.repair_fixture values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          worldId,
          sourceCommandId,
          firstAdminId,
          'INCIDENT_RECOVERY',
          incidentReason,
          pitrNotUsedReason,
          plan,
        ],
      );
      await owner.pool.query(
        `insert into operator_repair_stub.economy_repair_plans
           values ($1,$2,decode($3,'hex'))`,
        [repairPlanId, worldId, plan.planHash],
      );
      await owner.pool.query(
        `insert into operator_repair_stub.execution_fixture
           values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          repairPlanId,
          firstAdminId,
          plan.planHash,
          repairCommandId,
          repairEventId,
          repairLedgerEntryId,
          compensationTransactionId,
        ],
      );
      await owner.pool.query(
        `create function operator_repair_stub.worldgraph_prepare_economy_repair(
           checked_world_id uuid, checked_source_command_id uuid,
           checked_prepared_by_user_id uuid, checked_reason_code text,
           checked_incident_reason text, checked_pitr_not_used_reason text
         ) returns jsonb language plpgsql as $function$
         declare fixture operator_repair_stub.repair_fixture%rowtype;
         begin
           select * into strict fixture from operator_repair_stub.repair_fixture;
           if checked_world_id is distinct from fixture.world_id
             or checked_source_command_id is distinct from fixture.source_command_id
             or checked_prepared_by_user_id is distinct from fixture.prepared_by_user_id
             or checked_reason_code is distinct from fixture.reason_code
             or checked_incident_reason is distinct from fixture.incident_reason
             or checked_pitr_not_used_reason is distinct from fixture.pitr_not_used_reason then
             raise exception 'operator prepare request mismatch';
           end if;
           return fixture.plan;
         end
         $function$;
         create function operator_repair_stub.worldgraph_execute_economy_repair(
           checked_repair_plan_id uuid, checked_executing_admin_user_id uuid,
           checked_plan_hash text, checked_confirmation text
         ) returns table(
           repair_plan_id uuid, command_id uuid, event_id uuid, ledger_entry_id uuid,
           financial_transaction_id uuid, asset_transfer_id uuid,
           resulting_state_revision bigint, resulting_event_sequence bigint,
           resulting_ledger_sequence bigint, economy_checksum bytea
         ) language plpgsql as $function$
         declare fixture operator_repair_stub.execution_fixture%rowtype;
         begin
           select execution.* into strict fixture
             from operator_repair_stub.execution_fixture execution;
           if checked_repair_plan_id is distinct from fixture.repair_plan_id
             or checked_executing_admin_user_id is distinct from fixture.executing_admin_user_id
             or checked_plan_hash is distinct from fixture.plan_hash
             or checked_confirmation is distinct from 'APPLY APPEND-ONLY ECONOMY REPAIR' then
             raise exception 'operator execute request mismatch';
           end if;
           return query select fixture.repair_plan_id, fixture.command_id,
             fixture.event_id, fixture.ledger_entry_id, fixture.financial_transaction_id,
             null::uuid, 9::bigint, 9::bigint, 9::bigint, decode(repeat('d',64),'hex');
         end
         $function$`,
      );
      await owner.pool.query(
        `alter role worldgraph_operations_test in database worldgraph
           set search_path to operator_repair_stub, public`,
      );

      const prepared = await runOperator(
        [
          'economy',
          'repair-prepare',
          '--world',
          worldId,
          '--source-command',
          sourceCommandId,
          '--reason-code',
          'INCIDENT_RECOVERY',
          '--incident-reason',
          incidentReason,
          '--pitr-not-used-reason',
          pitrNotUsedReason,
          '--actor',
          firstAdminId,
        ],
        { operations: operationsMemberUrl },
      );
      expect(prepared).toMatchObject({ code: 0, stderr: '' });
      expect(outputJson<EconomyRepairPlanV1>(prepared)).toEqual(plan);

      const astralIncidentReason = '😀'.repeat(300);
      const astralPlanBody = { ...planBody, incidentReason: astralIncidentReason };
      const astralPlan: EconomyRepairPlanV1 = {
        ...astralPlanBody,
        planHash: createHash('sha256')
          .update(
            canonicalJson({
              domain: 'worldgraph.economy-repair-plan-hash.v1',
              plan: astralPlanBody,
            }),
          )
          .digest('hex'),
      };
      await owner.pool.query(
        `update operator_repair_stub.repair_fixture set incident_reason=$1, plan=$2`,
        [astralIncidentReason, astralPlan],
      );
      const astralPrepared = await runOperator(
        [
          'economy',
          'repair-prepare',
          '--world',
          worldId,
          '--source-command',
          sourceCommandId,
          '--reason-code',
          'INCIDENT_RECOVERY',
          '--incident-reason',
          astralIncidentReason,
          '--pitr-not-used-reason',
          pitrNotUsedReason,
          '--actor',
          firstAdminId,
        ],
        { operations: operationsMemberUrl },
      );
      expect(astralPrepared).toMatchObject({ code: 0, stderr: '' });
      expect(outputJson<EconomyRepairPlanV1>(astralPrepared)).toEqual(astralPlan);
      await owner.pool.query(
        `update operator_repair_stub.repair_fixture set incident_reason=$1, plan=$2`,
        [incidentReason, plan],
      );

      await owner.pool.query(`update operator_repair_stub.repair_fixture set plan=plan-'delta'`);
      const incompletePlan = await runOperator(
        [
          'economy',
          'repair-prepare',
          '--world',
          worldId,
          '--source-command',
          sourceCommandId,
          '--reason-code',
          'INCIDENT_RECOVERY',
          '--incident-reason',
          incidentReason,
          '--pitr-not-used-reason',
          pitrNotUsedReason,
          '--actor',
          firstAdminId,
        ],
        { operations: operationsMemberUrl },
      );
      expect(incompletePlan.code).toBe(1);
      expect(incompletePlan.stdout).toBe('');
      const incompleteError = JSON.parse(incompletePlan.stderr) as {
        code: string;
        message: string;
      };
      expect(incompleteError.code).toBe('OPERATOR_COMMAND_FAILED');
      expect(incompleteError.message).toContain('"keyword":"required"');
      await owner.pool.query(`update operator_repair_stub.repair_fixture set plan=$1`, [plan]);

      await owner.pool.query(
        `update operator_repair_stub.repair_fixture
            set plan=jsonb_set(plan,'{planHash}',to_jsonb($1::text))`,
        ['c'.repeat(64)],
      );
      const invalidPlan = await runOperator(
        [
          'economy',
          'repair-prepare',
          '--world',
          worldId,
          '--source-command',
          sourceCommandId,
          '--reason-code',
          'INCIDENT_RECOVERY',
          '--incident-reason',
          incidentReason,
          '--pitr-not-used-reason',
          pitrNotUsedReason,
          '--actor',
          firstAdminId,
        ],
        { operations: operationsMemberUrl },
      );
      expect(invalidPlan.code).toBe(1);
      expect(invalidPlan.stderr).toContain('plan with an invalid canonical hash');
      await owner.pool.query(`update operator_repair_stub.repair_fixture set plan=$1`, [plan]);

      const executed = await runOperator(
        [
          'economy',
          'repair-execute',
          '--world',
          worldId,
          '--plan',
          repairPlanId,
          '--plan-hash',
          plan.planHash,
          '--confirm',
          'APPLY APPEND-ONLY ECONOMY REPAIR',
          '--actor',
          firstAdminId,
        ],
        { operations: operationsMemberUrl },
      );
      expect(executed).toMatchObject({ code: 0, stderr: '' });
      expect(outputJson(executed)).toEqual({
        assetTransferId: null,
        commandId: repairCommandId,
        economyChecksum: 'd'.repeat(64),
        eventId: repairEventId,
        financialTransactionId: compensationTransactionId,
        ledgerEntryId: repairLedgerEntryId,
        repairPlanId,
        resultingEventSequence: '9',
        resultingLedgerSequence: '9',
        resultingStateRevision: '9',
        worldId,
      });
      expect(executed.stdout).not.toContain(incidentReason);
      expect(executed.stdout).not.toContain(pitrNotUsedReason);
      expect(executed.stdout).not.toContain(walletId);
      expect(executed.stdout).not.toContain(plan.planHash);
      expect(executed.stdout).not.toContain('reasonCode');
      expect(executed.stdout).not.toContain('repairKind');
      expect(executed.stdout).not.toContain('approval');
      expect(executed.stdout).not.toContain('delta');
    } finally {
      await owner.pool.query(
        `alter role worldgraph_operations_test in database worldgraph reset search_path`,
      );
      await owner.pool.query(`drop schema if exists operator_repair_stub cascade`);
      await owner.pool.query(
        `revoke worldgraph_owner from worldgraph_operations_test;
         drop role if exists worldgraph_operations_test`,
      );
    }
  });

  it('prepares, independently approves, and executes a commerce projection repair through the owner CLI', async () => {
    const operationsMemberRole = 'worldgraph_commerce_repair_operator_test';
    const operationsMemberPassword = 'worldgraph_commerce_repair_operator_password';
    const operationsMemberConnection = new URL(ownerUrl);
    operationsMemberConnection.username = operationsMemberRole;
    operationsMemberConnection.password = operationsMemberPassword;
    const operationsMemberUrl = operationsMemberConnection.toString();
    const repairPlanId = '078f0000-0000-7000-8000-000000000931';
    const repairCommandId = '078f0000-0000-7000-8000-000000000932';
    const repairEventId = '078f0000-0000-7000-8000-000000000933';
    const repairLedgerEntryId = '078f0000-0000-7000-8000-000000000934';
    const repairFactId = '078f0000-0000-7000-8000-000000000935';
    const sourceReconciliationRunId = '078f0000-0000-7000-8000-000000000936';
    const postRepairReconciliationRunId = '078f0000-0000-7000-8000-000000000937';
    const approvalId = '078f0000-0000-7000-8000-000000000938';
    const inventoryId = '078f0000-0000-7000-8000-000000000939';
    const reason = 'INCIDENT-COMMERCE-001 immutable journal and inventory projection differ';
    const planBody = {
      domain: 'worldgraph.commerce-projection-repair-plan.v1',
      expiresAt: '2026-07-22T15:15:00.000Z',
      items: [
        {
          actualQuantity: '8',
          actualReservedQuantity: '3',
          expectedRowVersion: '7',
          inventoryId,
          itemOrdinal: 0,
          mismatchKinds: ['quantity', 'reservation'],
          repairFactId,
          repairedQuantity: '10',
          repairedReservedQuantity: '2',
        },
      ],
      preparedAt: '2026-07-22T15:00:00.000Z',
      preparedByUserId: firstAdminId,
      reason,
      repairPlanId,
      repairPlanSchemaVersion: 1,
      reservedCommandId: repairCommandId,
      reservedEventId: repairEventId,
      reservedLedgerEntryId: repairLedgerEntryId,
      sourceEconomyChecksum: 'a'.repeat(64),
      sourceEconomyHeadVersion: '4',
      sourceEventSequence: '8',
      sourceExpansionChecksum: 'b'.repeat(64),
      sourceExpansionHeadVersion: '5',
      sourceLedgerSequence: '9',
      sourceReconciliationLiveChecksum: 'd'.repeat(64),
      sourceReconciliationRebuiltChecksum: 'c'.repeat(64),
      sourceReconciliationRunId,
      sourceStateRevision: '8',
      sourceWorldVersion: '1',
      worldId,
    } as const satisfies Omit<CommerceProjectionRepairPlanV1, 'planHash'>;
    const plan: CommerceProjectionRepairPlanV1 = {
      ...planBody,
      planHash: createHash('sha256')
        .update(
          canonicalJson({
            domain: 'worldgraph.commerce-projection-repair-plan-hash.v1',
            plan: planBody,
          }),
        )
        .digest('hex'),
    };
    const approval = {
      approvalId,
      approvedAt: '2026-07-22T15:03:00.000Z',
      approverUserId: secondAdminId,
      planHash: plan.planHash,
      repairPlanId,
      worldId,
    };

    await owner.pool.query(
      `create role worldgraph_commerce_repair_operator_test login
         password 'worldgraph_commerce_repair_operator_password';
       grant worldgraph_owner to worldgraph_commerce_repair_operator_test;
       create schema operator_commerce_repair_stub authorization worldgraph_owner`,
    );
    try {
      await owner.pool.query(
        `create table operator_commerce_repair_stub.prepare_fixture(
           world_id uuid not null, prepared_by_user_id uuid not null,
           reason text not null, plan jsonb not null
         );
         create table operator_commerce_repair_stub.commerce_projection_repair_plans(
           id uuid primary key, world_id uuid not null,
           plan_hash bytea not null, prepared_by_user_id uuid not null
         );
         create table operator_commerce_repair_stub.approval_fixture(
           repair_plan_id uuid not null, approver_user_id uuid not null,
           approval_id uuid not null, plan_hash text not null, approval jsonb not null
         );
         create table operator_commerce_repair_stub.execution_fixture(
           repair_plan_id uuid not null, executing_admin_user_id uuid not null,
           plan_hash text not null, command_id uuid not null, event_id uuid not null,
           ledger_entry_id uuid not null, reconciliation_run_id uuid not null
         )`,
      );
      await owner.pool.query(
        `insert into operator_commerce_repair_stub.prepare_fixture values ($1,$2,$3,$4);
         insert into operator_commerce_repair_stub.commerce_projection_repair_plans
           values ($5,$1,decode($6,'hex'),$2);
         insert into operator_commerce_repair_stub.approval_fixture
           values ($5,$7,$8,$6,$9);
         insert into operator_commerce_repair_stub.execution_fixture
           values ($5,$7,$6,$10,$11,$12,$13)`,
        [
          worldId,
          firstAdminId,
          reason,
          plan,
          repairPlanId,
          plan.planHash,
          secondAdminId,
          approvalId,
          approval,
          repairCommandId,
          repairEventId,
          repairLedgerEntryId,
          postRepairReconciliationRunId,
        ],
      );
      await owner.pool.query(
        `create function operator_commerce_repair_stub.worldgraph_prepare_commerce_projection_repair(
           checked_world_id uuid, checked_prepared_by_user_id uuid, checked_reason text
         ) returns jsonb language plpgsql as $function$
         declare fixture operator_commerce_repair_stub.prepare_fixture%rowtype;
         begin
           select * into strict fixture from operator_commerce_repair_stub.prepare_fixture;
           if checked_world_id is distinct from fixture.world_id
             or checked_prepared_by_user_id is distinct from fixture.prepared_by_user_id
             or checked_reason is distinct from fixture.reason then
             raise exception 'commerce projection repair prepare request mismatch';
           end if;
           return fixture.plan;
         end
         $function$;
         create function operator_commerce_repair_stub.worldgraph_approve_commerce_projection_repair(
           checked_repair_plan_id uuid, checked_approver_user_id uuid,
           checked_approval_id uuid, checked_plan_hash text, checked_confirmation text
         ) returns jsonb language plpgsql as $function$
         declare fixture operator_commerce_repair_stub.approval_fixture%rowtype;
         begin
           select * into strict fixture from operator_commerce_repair_stub.approval_fixture;
           if checked_repair_plan_id is distinct from fixture.repair_plan_id
             or checked_approver_user_id is distinct from fixture.approver_user_id
             or checked_approval_id is distinct from fixture.approval_id
             or checked_plan_hash is distinct from fixture.plan_hash
             or checked_confirmation is distinct from 'APPROVE APPEND-ONLY COMMERCE REPAIR' then
             raise exception 'commerce projection repair approval request mismatch';
           end if;
           return fixture.approval;
         end
         $function$;
         create function operator_commerce_repair_stub.worldgraph_execute_commerce_projection_repair(
           checked_repair_plan_id uuid, checked_executing_admin_user_id uuid,
           checked_plan_hash text, checked_confirmation text
         ) returns table(
           repair_plan_id uuid, command_id uuid, event_id uuid, ledger_entry_id uuid,
           repair_fact_count integer, reconciliation_run_id uuid,
           resulting_checksum bytea, resulting_state_revision bigint,
           resulting_event_sequence bigint, resulting_ledger_sequence bigint
         ) language plpgsql as $function$
         declare fixture operator_commerce_repair_stub.execution_fixture%rowtype;
         begin
           select execution.* into strict fixture
             from operator_commerce_repair_stub.execution_fixture execution;
           if checked_repair_plan_id is distinct from fixture.repair_plan_id
             or checked_executing_admin_user_id is distinct from fixture.executing_admin_user_id
             or checked_plan_hash is distinct from fixture.plan_hash
             or checked_confirmation is distinct from 'APPLY APPEND-ONLY COMMERCE REPAIR' then
             raise exception 'commerce projection repair execution request mismatch';
           end if;
           return query select fixture.repair_plan_id, fixture.command_id,
             fixture.event_id, fixture.ledger_entry_id, 1, fixture.reconciliation_run_id,
             decode(repeat('d',64),'hex'), 9::bigint, 9::bigint, 10::bigint;
         end
         $function$`,
      );
      await owner.pool.query(
        `alter role worldgraph_commerce_repair_operator_test in database worldgraph
           set search_path to operator_commerce_repair_stub, public`,
      );

      const prepared = await runOperator(
        [
          'economy',
          'projection-repair-prepare',
          '--world',
          worldId,
          '--reason',
          reason,
          '--actor',
          firstAdminId,
        ],
        { operations: operationsMemberUrl },
      );
      expect(prepared).toMatchObject({ code: 0, stderr: '' });
      expect(outputJson<CommerceProjectionRepairPlanV1>(prepared)).toEqual(plan);

      const approved = await runOperator(
        [
          'economy',
          'projection-repair-approve',
          '--world',
          worldId,
          '--plan',
          repairPlanId,
          '--plan-hash',
          plan.planHash,
          '--approval',
          approvalId,
          '--confirm',
          'APPROVE APPEND-ONLY COMMERCE REPAIR',
          '--actor',
          secondAdminId,
        ],
        { operations: operationsMemberUrl },
      );
      expect(approved).toMatchObject({ code: 0, stderr: '' });
      expect(outputJson(approved)).toEqual(approval);

      const executed = await runOperator(
        [
          'economy',
          'projection-repair-execute',
          '--world',
          worldId,
          '--plan',
          repairPlanId,
          '--plan-hash',
          plan.planHash,
          '--confirm',
          'APPLY APPEND-ONLY COMMERCE REPAIR',
          '--actor',
          secondAdminId,
        ],
        { operations: operationsMemberUrl },
      );
      expect(executed).toMatchObject({ code: 0, stderr: '' });
      expect(outputJson(executed)).toEqual({
        commandId: repairCommandId,
        eventId: repairEventId,
        ledgerEntryId: repairLedgerEntryId,
        reconciliationRunId: postRepairReconciliationRunId,
        repairFactCount: 1,
        repairPlanId,
        resultingChecksum: 'd'.repeat(64),
        resultingEventSequence: '9',
        resultingLedgerSequence: '10',
        resultingStateRevision: '9',
        schemaVersion: 1,
        worldId,
      });
      expect(executed.stdout).not.toContain(reason);
      expect(executed.stdout).not.toContain(inventoryId);
      expect(executed.stdout).not.toContain(plan.planHash);
      expect(executed.stdout).not.toContain(repairFactId);
    } finally {
      await owner.pool.query(
        `alter role worldgraph_commerce_repair_operator_test in database worldgraph reset search_path`,
      );
      await owner.pool.query(`drop schema if exists operator_commerce_repair_stub cascade`);
      await owner.pool.query(
        `revoke worldgraph_owner from worldgraph_commerce_repair_operator_test;
         drop role if exists worldgraph_commerce_repair_operator_test`,
      );
    }
  });

  it('replays and compares the ID-free simulation document against PostgreSQL', async () => {
    const replayed = await runOperator(
      [
        'projection',
        'replay',
        '--world',
        worldId,
        '--projection',
        'simulation_runtime',
        '--target',
        'verify',
        '--reason',
        'INCIDENT-SIMULATION-VERIFY deterministic replay comparison',
        '--actor',
        firstAdminId,
      ],
      { operations: ownerUrl },
    );
    expect(replayed).toMatchObject({ code: 0, stderr: '' });
    const output = outputJson<{
      eventCount: number;
      lastEventSequence: string;
      projectionName: string;
      runId: string;
      simulationEventCount: number;
      target: string;
    }>(replayed);
    expect(output).toMatchObject({
      eventCount: 2,
      lastEventSequence: '2',
      projectionName: 'simulation_runtime',
      simulationEventCount: 1,
      target: 'verify',
    });
    expect(replayed.stdout).not.toContain('operator-integration-seed');
    simulationReplayRunId = output.runId;

    const compared = await runOperator(
      [
        'projection',
        'compare',
        '--world',
        worldId,
        '--projection',
        'simulation_runtime',
        '--run',
        simulationReplayRunId,
        '--actor',
        firstAdminId,
      ],
      { operations: ownerUrl },
    );
    expect(compared).toMatchObject({ code: 0, stderr: '' });
    expect(outputJson(compared)).toMatchObject({
      equal: true,
      firstDivergencePath: null,
      projectionName: 'simulation_runtime',
      runId: simulationReplayRunId,
      sourceHeadUnchanged: true,
      worldId,
    });

    const wrongProjection = await runOperator(
      [
        'projection',
        'compare',
        '--world',
        worldId,
        '--projection',
        'world_graph',
        '--run',
        simulationReplayRunId,
        '--actor',
        firstAdminId,
      ],
      { operations: ownerUrl },
    );
    expect(wrongProjection.code).toBe(1);
    expect(wrongProjection.stderr).toContain(
      'The replay run projection does not match --projection.',
    );

    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update world_simulation_clocks set current_tick=9 where world_id=$1`,
        [worldId],
      );
    });
    const diverged = await runOperator(
      [
        'projection',
        'compare',
        '--world',
        worldId,
        '--projection',
        'simulation_runtime',
        '--run',
        simulationReplayRunId,
        '--actor',
        firstAdminId,
      ],
      { operations: ownerUrl },
    );
    expect(diverged.code).toBe(2);
    expect(outputJson(diverged)).toMatchObject({
      equal: false,
      firstDivergencePath: '/clock/currentTick',
      sourceHeadUnchanged: true,
    });
    const verification = await runOperator(['ledger', 'verify', '--world', worldId], {
      database: appUrl,
    });
    expect(verification.code).toBe(2);
    expect(outputJson<{ failures: string[] }>(verification).failures).toContain(
      'SIMULATION_PROJECTION_CHECKSUM_MISMATCH',
    );
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update world_simulation_clocks set current_tick=0 where world_id=$1`,
        [worldId],
      );
    });
  });

  it('requires the operations connection for replay and persists repairable live identities', async () => {
    const denied = await runOperator(
      ['projection', 'replay', '--world', worldId, '--target', 'shadow', '--reason', replayReason],
      { database: appUrl },
    );
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('OPERATIONS_DATABASE_URL is required');

    const roleDenied = await runOperator(
      [
        'projection',
        'replay',
        '--world',
        worldId,
        '--target',
        'shadow',
        '--reason',
        replayReason,
        '--actor',
        firstAdminId,
      ],
      { operations: appUrl },
    );
    expect(roleDenied.code).toBe(1);
    expect(roleDenied.stderr).toContain('database role is not authorized');

    const identityDenied = await runOperator(
      [
        'projection',
        'replay',
        '--world',
        worldId,
        '--target',
        'shadow',
        '--reason',
        replayReason,
        '--actor',
        creatorId,
      ],
      { operations: ownerUrl },
    );
    expect(identityDenied.code).toBe(1);
    expect(identityDenied.stderr).toContain('active platform administrator');

    const replayed = await runOperator(
      [
        'projection',
        'replay',
        '--world',
        worldId,
        '--target',
        'shadow',
        '--reason',
        replayReason,
        '--actor',
        firstAdminId,
      ],
      { operations: ownerUrl },
    );
    expect(replayed).toMatchObject({ code: 0, stderr: '' });
    const output = outputJson<{
      checksum: string;
      eventCount: number;
      lastEventSequence: string;
      runId: string;
    }>(replayed);
    expect(output).toMatchObject({ eventCount: 2, lastEventSequence: '2' });
    replayRunId = output.runId;

    const identities = await owner.pool.query<{
      live_entities: string[];
      live_relationships: string[];
      requested_by_actor_id: string;
      requested_by_actor_type: string;
      shadow_entities: string[];
      shadow_relationships: string[];
    }>(
      `select
        array(select id::text from world_entities where world_id=$1 order by id) live_entities,
        array(select entity_id::text from shadow_world_entities
          where replay_run_id=$2 order by entity_id) shadow_entities,
        array(select id::text from world_relationships where world_id=$1 order by id) live_relationships,
        array(select relationship_id::text from shadow_world_relationships
          where replay_run_id=$2 order by relationship_id) shadow_relationships,
        (select requested_by_actor_type::text from projection_replay_runs
          where id=$2) requested_by_actor_type,
        (select requested_by_actor_id from projection_replay_runs
          where id=$2) requested_by_actor_id`,
      [worldId, replayRunId],
    );
    expect(identities.rows[0]).toMatchObject({
      requested_by_actor_id: firstAdminId,
      requested_by_actor_type: 'platform_admin',
    });
    expect(identities.rows[0]?.shadow_entities).toEqual(identities.rows[0]?.live_entities);
    expect(identities.rows[0]?.shadow_relationships).toEqual(
      identities.rows[0]?.live_relationships,
    );

    const compared = await runOperator(
      ['projection', 'compare', '--world', worldId, '--run', replayRunId, '--actor', firstAdminId],
      { operations: ownerUrl },
    );
    expect(compared.code).toBe(0);
    expect(outputJson(compared)).toMatchObject({ equal: true, runId: replayRunId, worldId });
  });

  it('detects projection divergence and enforces owner-only, two-person repair', async () => {
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update world_entities set state=jsonb_set(state,'{name}','"Corrupted Operator"')
         where world_id=$1 and id=$2`,
        [worldId, characterId],
      );
    });
    const compared = await runOperator(
      ['projection', 'compare', '--world', worldId, '--run', replayRunId, '--actor', firstAdminId],
      { operations: ownerUrl },
    );
    expect(compared.code).toBe(2);
    const difference = outputJson<{ equal: boolean; liveChecksum: string; replayChecksum: string }>(
      compared,
    );
    expect(difference.equal).toBe(false);
    expect(difference.liveChecksum).not.toBe(difference.replayChecksum);

    const repairArgs = [
      'projection',
      'repair-swap',
      '--world',
      worldId,
      '--run',
      replayRunId,
      '--reason',
      replayReason,
      '--approved-by',
      firstAdminId,
      '--approved-by',
      secondAdminId,
      '--confirm',
      'REPAIR-SWAP',
      '--actor',
      thirdAdminId,
    ] as const;
    const appDenied = await runOperator(repairArgs, { operations: appUrl });
    expect(appDenied.code).toBe(1);
    expect(appDenied.stderr).toContain('database role is not authorized');

    const sameApproverDenied = await runOperator(
      repairArgs.map((value) => (value === secondAdminId ? firstAdminId : value)),
      { operations: ownerUrl },
    );
    expect(sameApproverDenied.code).toBe(1);
    expect(sameApproverDenied.stderr).toContain('Exactly two distinct UUID --approved-by values');

    const repaired = await runOperator(repairArgs, { operations: ownerUrl });
    expect(repaired).toMatchObject({ code: 0, stderr: '' });
    expect(outputJson(repaired)).toMatchObject({
      ledgerSequence: '3',
      resultingStateRevision: '3',
      runId: replayRunId,
      worldId,
    });
    const live = await owner.pool.query<{
      actor_id: string;
      event_actor_id: string;
      events: string;
      ledger: string;
      name: string;
      repair_approvals: Record<string, unknown>;
      repairs: string;
      revision: string;
    }>(
      `select state->>'name' name,
        (select state_revision::text from world_runtime_heads where world_id=$1) revision,
        (select count(*)::text from domain_events where world_id=$1) events,
        (select count(*)::text from ledger_entries where world_id=$1) ledger,
        (select count(*)::text from domain_events
          where world_id=$1 and event_type='ProjectionRepairAnchoredV1') repairs,
        (select actor_id from command_records
          where world_id=$1 and command_type='ProjectionRepairAnchoredV1') actor_id,
        (select metadata->'actor'->>'actorId' from domain_events
          where world_id=$1 and event_type='ProjectionRepairAnchoredV1') event_actor_id,
        (select redacted_details from ledger_entries
          where world_id=$1 and entry_kind='repair_anchor') repair_approvals
       from world_entities where world_id=$1 and id=$2`,
      [worldId, characterId],
    );
    expect(live.rows[0]).toEqual({
      actor_id: thirdAdminId,
      event_actor_id: thirdAdminId,
      events: '3',
      ledger: '3',
      name: 'Operator Character',
      repair_approvals: {
        approvedByFirst: firstAdminId,
        approvedBySecond: secondAdminId,
        executedByActor: thirdAdminId,
        projectionName: 'world_graph',
        replayRunId,
      },
      repairs: '1',
      revision: '3',
    });
  });

  it('exports an operations-authorized range to a new mode-0600 file and refuses overwrite', async () => {
    const outputPath = join(exportRoot, 'ledger-3.json');
    const args = [
      'ledger',
      'export',
      '--world',
      worldId,
      '--from',
      '3',
      '--to',
      '3',
      '--output',
      outputPath,
      '--actor',
      firstAdminId,
    ] as const;
    const denied = await runOperator(args, { database: appUrl });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('OPERATIONS_DATABASE_URL is required');

    const appDenied = await runOperator(args, { operations: appUrl });
    expect(appDenied.code).toBe(1);
    expect(appDenied.stderr).toContain('database role is not authorized');

    const exported = await runOperator(args, { operations: ownerUrl });
    expect(exported).toMatchObject({ code: 0, stderr: '' });
    const summary = outputJson<{
      entryCount: number;
      eventCount: number;
      exportHash: string;
      auditCorrelationId: string;
      auditId: string;
      output: string;
    }>(exported);
    expect(summary).toMatchObject({ entryCount: 1, eventCount: 1, output: outputPath });
    const file = JSON.parse(await readFile(outputPath, 'utf8')) as {
      entries: unknown[];
      events: unknown[];
      exportHash: string;
      fromLedgerSequence: string;
      toLedgerSequence: string;
    };
    expect(file).toMatchObject({
      exportHash: summary.exportHash,
      fromLedgerSequence: '3',
      toLedgerSequence: '3',
    });
    expect(file.entries).toHaveLength(1);
    expect(file.events).toHaveLength(1);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);

    const audit = await owner.pool.query<{
      action: string;
      actor_user_id: string;
      audit_records: string;
      authorized_records: string;
      ledger_entries: string;
      outcome: string;
      reason_code: string;
      redacted_metadata: Record<string, unknown>;
    }>(
      `select audit.action, audit.actor_user_id, audit.outcome, audit.reason_code,
              audit.redacted_metadata,
              (select count(*)::text from security_audit_records
                where correlation_id=$3) audit_records,
              (select count(*)::text from security_audit_records
                where correlation_id=$3 and action='ledger.export.authorized'
                  and outcome='allowed') authorized_records,
              (select count(*)::text from ledger_entries where world_id=$2) ledger_entries
         from security_audit_records audit
        where audit.id=$1 and audit.world_id=$2`,
      [summary.auditId, worldId, summary.auditCorrelationId],
    );
    expect(audit.rows[0]).toMatchObject({
      action: 'ledger.export.completed',
      actor_user_id: firstAdminId,
      audit_records: '2',
      authorized_records: '1',
      ledger_entries: '3',
      outcome: 'succeeded',
      reason_code: 'OPERATOR_EXPORT_COMPLETED',
      redacted_metadata: {
        entryCount: 1,
        eventCount: 1,
        exportHash: summary.exportHash,
        fromLedgerSequence: '3',
        toLedgerSequence: '3',
      },
    });

    const overwrite = await runOperator(args, { operations: ownerUrl });
    expect(overwrite.code).toBe(1);
    expect(overwrite.stderr).toContain('EEXIST');
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(file);
  });

  it('reports the exact first bad ledger sequence for event and chain corruption', async () => {
    const valid = await runOperator(['ledger', 'verify', '--world', worldId], {
      database: appUrl,
    });
    expect(valid.code).toBe(0);
    expect(outputJson(valid)).toMatchObject({
      entryCount: 3,
      eventCount: 3,
      lastLedgerSequence: '3',
      valid: true,
    });

    const original = await owner.pool.query<{ event_hash: Buffer; previous_hash: Buffer }>(
      `select event.event_hash,entry.previous_hash
       from domain_events event
       join ledger_entries entry on entry.event_id=event.id
       where event.world_id=$1 and event.world_event_sequence=2`,
      [worldId],
    );
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update domain_events set event_hash=$2 where world_id=$1 and world_event_sequence=2`,
        [worldId, Buffer.alloc(32, 61)],
      );
    });
    const badEvent = await runOperator(['ledger', 'verify', '--world', worldId], {
      database: appUrl,
    });
    expect(badEvent.code).toBe(2);
    expect(outputJson(badEvent)).toMatchObject({
      code: 'EVENT_HASH_MISMATCH',
      firstBadLedgerSequence: '2',
      valid: false,
      worldId,
    });
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update domain_events set event_hash=$2 where world_id=$1 and world_event_sequence=2`,
        [worldId, original.rows[0]!.event_hash],
      );
      await connection.query(
        `update ledger_entries set previous_hash=$2 where world_id=$1 and ledger_sequence=2`,
        [worldId, Buffer.alloc(32, 62)],
      );
    });
    const badChain = await runOperator(['ledger', 'verify', '--world', worldId], {
      database: appUrl,
    });
    expect(badChain.code).toBe(2);
    expect(outputJson(badChain)).toMatchObject({
      code: 'PREVIOUS_HASH_MISMATCH',
      firstBadLedgerSequence: '2',
      valid: false,
      worldId,
    });
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `update ledger_entries set previous_hash=$2 where world_id=$1 and ledger_sequence=2`,
        [worldId, original.rows[0]!.previous_hash],
      );
    });
    const restored = await runOperator(['ledger', 'verify', '--world', worldId], {
      database: appUrl,
    });
    expect(restored.code).toBe(0);
    expect(outputJson(restored)).toMatchObject({ valid: true, lastLedgerSequence: '3' });
  });
});
