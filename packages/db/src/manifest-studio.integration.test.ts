import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  importStarterPrimitives,
  type DatabaseClient,
  readRuntimeVersions,
} from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const creatorId = '028f0000-0000-7000-8000-000000000401';
const administratorId = '028f0000-0000-7000-8000-000000000402';
const outsiderId = '028f0000-0000-7000-8000-000000000403';
const worlds = {
  a: '028f0000-0000-7000-8000-000000000501',
  b: '028f0000-0000-7000-8000-000000000502',
  c: '028f0000-0000-7000-8000-000000000503',
  d: '028f0000-0000-7000-8000-000000000504',
  e: '028f0000-0000-7000-8000-000000000505',
  generatedSafety: '028f0000-0000-7000-8000-000000000508',
  rootSafety: '028f0000-0000-7000-8000-000000000506',
  warningSafety: '028f0000-0000-7000-8000-000000000507',
} as const;
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';

function applicationUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'worldgraph_app';
  url.password = 'worldgraph_app_local_only';
  return url.toString();
}

async function transaction<T>(
  database: DatabaseClient,
  operation: (connection: PoolClient) => Promise<T>,
): Promise<T> {
  const connection = await database.pool.connect();
  try {
    await connection.query('begin');
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

async function expectDatabaseError(promise: Promise<unknown>, code?: string): Promise<void> {
  try {
    await promise;
    throw new Error('Expected the database operation to fail.');
  } catch (error) {
    if (error instanceof Error && error.message === 'Expected the database operation to fail.') {
      throw error;
    }
    if (code) expect((error as { code?: string }).code).toBe(code);
  }
}

async function insertPrompt(
  database: DatabaseClient,
  input: { id: string; worldId: string; userId?: string; hashByte?: number },
): Promise<void> {
  await database.pool.query(
    `insert into world_prompt_submissions(
       id, world_id, submitted_by_user_id, prompt_text, normalized_hash,
       client_seed, retention_until
     ) values ($1,$2,$3,$4,$5,'seed-v1',now() + interval '30 days')`,
    [
      input.id,
      input.worldId,
      input.userId ?? creatorId,
      'An energy-scarce floating city-state governed by competing guilds.',
      Buffer.alloc(32, input.hashByte ?? 11),
    ],
  );
}

async function insertRun(
  database: DatabaseClient,
  input: {
    id: string;
    worldId: string;
    promptId: string;
    hashByte?: number;
    parentRevisionId?: string;
    parentHash?: Buffer;
  },
): Promise<void> {
  await database.pool.query(
    `insert into manifest_generation_runs(
       id, world_id, prompt_submission_id, requested_by_user_id,
       generator_schema_version, prompt_template_version, provider_configuration_id,
       parent_revision_id, expected_parent_content_hash, seed, input_hash
     ) values ($1,$2,$3,$4,1,1,'disabled-v1',$5,$6,'seed-v1',$7)`,
    [
      input.id,
      input.worldId,
      input.promptId,
      creatorId,
      input.parentRevisionId ?? null,
      input.parentHash ?? null,
      Buffer.alloc(32, input.hashByte ?? 21),
    ],
  );
}

async function claimRun(
  database: DatabaseClient,
  runId: string,
  claimToken: string,
  stage = 'intent',
): Promise<number> {
  const claimed = await database.pool.query(
    `update manifest_generation_runs
        set status = 'running', stage = $3, progress_percent = greatest(progress_percent, 5),
            attempts = attempts + 1, claim_token = $2, claimed_at = now(),
            heartbeat_at = now(), started_at = coalesce(started_at, now()),
            updated_at = now(), row_version = row_version + 1
      where id = $1 and status = 'queued'
      returning id`,
    [runId, claimToken, stage],
  );
  return claimed.rowCount ?? 0;
}

async function freezeCatalog(
  database: DatabaseClient,
  runId: string,
  catalogByte = 31,
  resolvedByte = 32,
): Promise<void> {
  await database.pool.query(
    `update manifest_generation_runs
        set stage = 'retrieval', progress_percent = greatest(progress_percent, 20),
            primitive_catalog_snapshot_hash = $2, resolved_input_hash = $3,
            heartbeat_at = now(), updated_at = now(), row_version = row_version + 1
      where id = $1 and status = 'running'`,
    [runId, Buffer.alloc(32, catalogByte), Buffer.alloc(32, resolvedByte)],
  );
}

async function insertManualRevision(
  executor: DatabaseClient['pool'] | PoolClient,
  input: {
    id: string;
    worldId: string;
    revisionNumber: number;
    hashByte: number;
    parentRevisionId?: string;
  },
): Promise<void> {
  await executor.query(
    `insert into manifest_revisions(
       id, world_id, revision_number, parent_revision_id, manifest_schema_version,
       canonical_manifest, content_hash, source, created_by_user_id
     ) values ($1,$2,$3,$4,1,$5,$6,'manual',$7)`,
    [
      input.id,
      input.worldId,
      input.revisionNumber,
      input.parentRevisionId ?? null,
      { metadata: { key: `revision-${input.revisionNumber}` } },
      Buffer.alloc(32, input.hashByte),
      creatorId,
    ],
  );
}

async function insertValidReport(
  database: DatabaseClient,
  revisionId: string,
  id: string,
  hashByte: number,
): Promise<void> {
  await database.pool.query(
    `insert into manifest_validation_reports(
       id, manifest_revision_id, validator_version, primitive_catalog_snapshot_hash,
       valid, diagnostics, report_hash
     ) values ($1,$2,1,$3,true,'[]'::jsonb,$4)`,
    [id, revisionId, Buffer.alloc(32, hashByte), Buffer.alloc(32, hashByte + 1)],
  );
}

describe('manifest studio database contract', () => {
  let app: DatabaseClient;
  let client: DatabaseClient;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let primitive: { content_hash: Buffer; id: string };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    client = createDatabaseClient(container.getConnectionUri(), 'manifest-studio-owner-test');
    await migrate(client.db, { migrationsFolder: migrationRoot });
    await importStarterPrimitives(client.pool);

    await client.pool.query(
      `insert into users(id, email, password_hash, display_name)
       values
         ($1,'manifest-creator@example.test',$4,'Manifest Creator'),
         ($2,'manifest-admin@example.test',$4,'Manifest Administrator'),
         ($3,'manifest-outsider@example.test',$4,'Manifest Outsider')`,
      [creatorId, administratorId, outsiderId, passwordHash],
    );
    for (const [key, worldId] of Object.entries(worlds)) {
      await transaction(client, async (connection) => {
        await connection.query(
          `insert into worlds(id, slug, name, created_by_user_id)
           values ($1,$2,$3,$4)`,
          [worldId, `manifest-${key.toLowerCase()}`, `Manifest ${key.toUpperCase()}`, creatorId],
        );
        await connection.query(
          `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
           values ($1,$2,'creator',$2),($1,$3,'administrator',$2)`,
          [worldId, creatorId, administratorId],
        );
      });
    }
    const primitiveResult = await client.pool.query<{ content_hash: Buffer; id: string }>(
      `select id, content_hash from primitive_versions
       where lifecycle = 'published' order by id limit 1`,
    );
    primitive = primitiveResult.rows[0]!;
    app = createDatabaseClient(applicationUrl(container.getConnectionUri()), 'manifest-studio-app');
  });

  afterAll(async () => {
    await app?.pool.end();
    await client?.pool.end();
    await container?.stop();
  });

  it('installs the M04 schema with exact compatibility metadata and no production world data', async () => {
    await expect(readRuntimeVersions(client.pool)).resolves.toMatchObject({
      contracts: 8,
      manifestSchema: 1,
      primitiveSchema: 1,
      runtimeSchema: 8,
    });
    const tables = await client.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])
       order by table_name`,
      [
        [
          'generation_retrieval_items',
          'manifest_field_provenance',
          'manifest_generation_runs',
          'manifest_provider_calls',
          'manifest_revisions',
          'manifest_validation_reports',
          'world_prompt_submissions',
        ],
      ],
    );
    expect(tables.rowCount).toBe(7);
    const empty = await client.pool.query<{ prompts: string; revisions: string; runs: string }>(
      `select
         (select count(*) from world_prompt_submissions)::text as prompts,
         (select count(*) from manifest_generation_runs)::text as runs,
         (select count(*) from manifest_revisions)::text as revisions`,
    );
    expect(empty.rows[0]).toEqual({ prompts: '0', revisions: '0', runs: '0' });
    const worldCompatibility = await client.pool.query(
      `select current_approved_manifest_revision_id, manifest_schema_version
       from worlds where id = $1`,
      [worlds.a],
    );
    expect(worldCompatibility.rows[0]).toMatchObject({
      current_approved_manifest_revision_id: null,
      manifest_schema_version: null,
    });

    const deferrable = await client.pool.query<{
      condeferrable: boolean;
      condeferred: boolean;
      conname: string;
    }>(
      `select conname, condeferrable, condeferred from pg_constraint
       where conname = any($1::text[]) order by conname`,
      [
        [
          'manifest_generation_runs_output_world_fk',
          'worlds_current_approved_manifest_revision_world_fk',
          'worlds_require_current_approved_manifest',
          'manifest_revisions_require_world_pointer',
        ],
      ],
    );
    expect(deferrable.rows).toHaveLength(4);
    expect(deferrable.rows.every((row) => row.condeferrable && row.condeferred)).toBe(true);
  });

  it('upgrades the exact sealed M03 head without data loss', async () => {
    const database = 'worldgraph_m03_manifest_upgrade';
    await client.pool.query(`create database ${database}`);
    const upgradeUrl = new URL(container.getConnectionUri());
    upgradeUrl.pathname = `/${database}`;
    const upgrade = createDatabaseClient(upgradeUrl.toString(), 'manifest-m03-upgrade');
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'worldgraph-m03-migrations-'));
    try {
      await mkdir(join(temporaryRoot, 'meta'));
      await Promise.all(
        [1, 2, 3, 4].map((number) => {
          const tags = [
            '0001_platform_extensions',
            '0002_platform_metadata',
            '0003_identity_authority',
            '0004_primitive_registry',
          ];
          const tag = tags[number - 1]!;
          return cp(join(migrationRoot, `${tag}.sql`), join(temporaryRoot, `${tag}.sql`));
        }),
      );
      await writeFile(
        join(temporaryRoot, 'meta/_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [
            {
              idx: 0,
              version: '7',
              when: 1784635200000,
              tag: '0001_platform_extensions',
              breakpoints: true,
            },
            {
              idx: 1,
              version: '7',
              when: 1784635260000,
              tag: '0002_platform_metadata',
              breakpoints: true,
            },
            {
              idx: 2,
              version: '7',
              when: 1784635320000,
              tag: '0003_identity_authority',
              breakpoints: true,
            },
            {
              idx: 3,
              version: '7',
              when: 1784635380000,
              tag: '0004_primitive_registry',
              breakpoints: true,
            },
          ],
        }),
      );
      await migrate(upgrade.db, { migrationsFolder: temporaryRoot });
      await expect(readRuntimeVersions(upgrade.pool)).resolves.toMatchObject({
        contracts: 3,
        manifestSchema: 0,
        primitiveSchema: 1,
        runtimeSchema: 3,
      });
      await upgrade.pool.query(
        `insert into users(id,email,password_hash,display_name)
         values ($1,'m03-manifest-upgrade@example.test',$2,'M03 Preserved')`,
        [creatorId, passwordHash],
      );
      await transaction(upgrade, async (connection) => {
        await connection.query(
          `insert into worlds(id,slug,name,created_by_user_id)
           values ($1,'m03-manifest-preserved','M03 Preserved',$2)`,
          [worlds.a, creatorId],
        );
        await connection.query(
          `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
           values ($1,$2,'creator',$2)`,
          [worlds.a, creatorId],
        );
      });
      await importStarterPrimitives(upgrade.pool);
      const before = await upgrade.pool.query<{
        primitives: string;
        users: string;
        worlds: string;
      }>(
        `select (select count(*) from primitive_versions)::text as primitives,
                (select count(*) from users)::text as users,
                (select count(*) from worlds)::text as worlds`,
      );

      await migrate(upgrade.db, { migrationsFolder: migrationRoot });
      await expect(readRuntimeVersions(upgrade.pool)).resolves.toMatchObject({
        contracts: 8,
        manifestSchema: 1,
        primitiveSchema: 1,
        runtimeSchema: 8,
      });
      const after = await upgrade.pool.query<{
        manifest_rows: string;
        primitives: string;
        users: string;
        worlds: string;
      }>(
        `select (select count(*) from primitive_versions)::text as primitives,
                (select count(*) from users)::text as users,
                (select count(*) from worlds)::text as worlds,
                ((select count(*) from world_prompt_submissions)
                  + (select count(*) from manifest_generation_runs)
                  + (select count(*) from manifest_revisions))::text as manifest_rows`,
      );
      expect(after.rows[0]).toEqual({ ...before.rows[0], manifest_rows: '0' });
      await expect(
        upgrade.pool.query(
          `select current_approved_manifest_revision_id, manifest_schema_version
           from worlds where id = $1`,
          [worlds.a],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            current_approved_manifest_revision_id: null,
            manifest_schema_version: null,
          },
        ],
      });
    } finally {
      await upgrade.pool.end();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('retains prompt provenance while allowing only post-retention text erasure', async () => {
    const earlyPrompt = '028f0000-0000-7000-8000-000000000601';
    await insertPrompt(client, { id: earlyPrompt, worldId: worlds.a });
    await expectDatabaseError(
      insertPrompt(client, {
        hashByte: 18,
        id: '028f0000-0000-7000-8000-000000000609',
        userId: outsiderId,
        worldId: worlds.a,
      }),
      '55000',
    );
    await expectDatabaseError(
      client.pool.query(
        `update world_prompt_submissions
         set prompt_text = null, redacted_at = now() where id = $1`,
        [earlyPrompt],
      ),
      '55000',
    );
    await expectDatabaseError(
      client.pool.query(`delete from world_prompt_submissions where id = $1`, [earlyPrompt]),
      '55000',
    );

    const expiredPrompt = '028f0000-0000-7000-8000-000000000602';
    await client.pool.query(
      `insert into world_prompt_submissions(
         id,world_id,submitted_by_user_id,prompt_text,normalized_hash,created_at,retention_until
       ) values ($1,$2,$3,'Retained prompt provenance',$4,
         now() - interval '2 hours',now() - interval '1 hour')`,
      [expiredPrompt, worlds.a, creatorId, Buffer.alloc(32, 12)],
    );
    const activeRun = '028f0000-0000-7000-8000-000000000708';
    await insertRun(client, {
      hashByte: 28,
      id: activeRun,
      promptId: expiredPrompt,
      worldId: worlds.a,
    });
    await expectDatabaseError(
      client.pool.query(
        `update world_prompt_submissions
         set prompt_text = null, redacted_at = now() where id = $1`,
        [expiredPrompt],
      ),
      '55000',
    );
    await client.pool.query(
      `update manifest_generation_runs
          set status = 'cancelled', completed_at = now(), updated_at = now(),
              row_version = row_version + 1
        where id = $1`,
      [activeRun],
    );
    await client.pool.query(
      `update world_prompt_submissions
       set prompt_text = null, redacted_at = now() where id = $1`,
      [expiredPrompt],
    );
    const redacted = await client.pool.query(
      `select prompt_text, redacted_at is not null as redacted,
              octet_length(normalized_hash) as hash_length
       from world_prompt_submissions where id = $1`,
      [expiredPrompt],
    );
    expect(redacted.rows[0]).toEqual({ hash_length: 32, prompt_text: null, redacted: true });
    await expectDatabaseError(
      insertRun(client, {
        hashByte: 29,
        id: '028f0000-0000-7000-8000-000000000709',
        promptId: expiredPrompt,
        worldId: worlds.a,
      }),
      '55000',
    );
    await expectDatabaseError(
      client.pool.query(
        `update world_prompt_submissions
         set prompt_text = 'restored', redacted_at = null where id = $1`,
        [expiredPrompt],
      ),
      '55000',
    );
  });

  it('enforces queue claims, recovery, retry bounds, frozen retrieval and repeatable requests', async () => {
    const promptA = '028f0000-0000-7000-8000-000000000601';
    const promptB = '028f0000-0000-7000-8000-000000000603';
    const runA = '028f0000-0000-7000-8000-000000000701';
    const duplicateRun = '028f0000-0000-7000-8000-000000000702';
    const cancelledRun = '028f0000-0000-7000-8000-000000000703';
    const firstClaim = '028f0000-0000-7000-8000-000000000711';
    const competingClaim = '028f0000-0000-7000-8000-000000000712';
    const retryClaim = '028f0000-0000-7000-8000-000000000713';
    await insertPrompt(client, { id: promptB, worldId: worlds.b, hashByte: 13 });
    await insertRun(client, { id: runA, worldId: worlds.a, promptId: promptA, hashByte: 21 });

    const claims = await Promise.all([
      claimRun(client, runA, firstClaim),
      claimRun(client, runA, competingClaim),
    ]);
    expect(claims.sort()).toEqual([0, 1]);
    const claimed = await client.pool.query<{ claim_token: string }>(
      `select claim_token from manifest_generation_runs where id = $1`,
      [runA],
    );
    const activeClaim = claimed.rows[0]!.claim_token;

    await transaction(client, async (connection) => {
      await connection.query(
        `update manifest_generation_runs
            set stage = 'retrieval', progress_percent = 20,
                primitive_catalog_snapshot_hash = $2, resolved_input_hash = $3,
                heartbeat_at = now(), updated_at = now(), row_version = row_version + 1
          where id = $1 and claim_token = $4`,
        [runA, Buffer.alloc(32, 31), Buffer.alloc(32, 32), activeClaim],
      );
      await connection.query(
        `insert into generation_retrieval_items(
           run_id,rank,primitive_version_id,retrieval_score,reason,content_hash
         ) values ($1,1,$2,42.5,'{"match":"guild"}'::jsonb,$3)`,
        [runA, primitive.id, primitive.content_hash],
      );
    });
    const otherPrimitive = await client.pool.query<{ id: string }>(
      `select id from primitive_versions where lifecycle = 'published' and id <> $1
       order by id limit 1`,
      [primitive.id],
    );
    await expectDatabaseError(
      client.pool.query(
        `insert into generation_retrieval_items(
           run_id,rank,primitive_version_id,retrieval_score,reason,content_hash
        ) values ($1,2,$2,1,'{}'::jsonb,$3)`,
        [runA, otherPrimitive.rows[0]!.id, Buffer.alloc(32, 99)],
      ),
      '23503',
    );
    await expectDatabaseError(
      client.pool.query(
        `update generation_retrieval_items set retrieval_score = 43
         where run_id = $1 and rank = 1`,
        [runA],
      ),
      '55000',
    );
    await expectDatabaseError(
      client.pool.query(
        `update manifest_generation_runs
         set resolved_input_hash = $2, updated_at = now(), row_version = row_version + 1
         where id = $1`,
        [runA, Buffer.alloc(32, 98)],
      ),
      '55000',
    );

    await client.pool.query(
      `update manifest_generation_runs
          set stage = 'repair', progress_percent = 40, repair_attempts = repair_attempts + 1,
              heartbeat_at = now(), updated_at = now(), row_version = row_version + 1
        where id = $1 and claim_token = $2`,
      [runA, activeClaim],
    );
    await client.pool.query(
      `update manifest_generation_runs
          set status = 'queued', stage = 'queued', claim_token = null,
              next_attempt_at = now() + interval '1 second',
              updated_at = now(), row_version = row_version + 1
        where id = $1 and claim_token = $2`,
      [runA, activeClaim],
    );
    const stale = await client.pool.query(
      `update manifest_generation_runs
       set heartbeat_at = now(), updated_at = now(), row_version = row_version + 1
       where id = $1 and claim_token = $2 and status = 'running'`,
      [runA, activeClaim],
    );
    expect(stale.rowCount).toBe(0);
    await expect(claimRun(client, runA, retryClaim, 'generation')).resolves.toBe(1);
    await client.pool.query(
      `update manifest_generation_runs
          set generation_mode = 'provider', provider = 'schema-fake', model = 'manifest-v1',
              stage = 'generation', progress_percent = 60,
              heartbeat_at = now(), updated_at = now(), row_version = row_version + 1
        where id = $1 and claim_token = $2`,
      [runA, retryClaim],
    );
    await expectDatabaseError(
      client.pool.query(
        `update manifest_generation_runs
         set provider_configuration_id = 'changed-v1', updated_at = now(),
             row_version = row_version + 1 where id = $1`,
        [runA],
      ),
      '55000',
    );
    await client.pool.query(
      `update manifest_generation_runs
          set status = 'failed', claim_token = null, completed_at = now(),
              error_code = 'PROVIDER_FAILED', updated_at = now(), row_version = row_version + 1
        where id = $1 and claim_token = $2`,
      [runA, retryClaim],
    );
    await expectDatabaseError(
      client.pool.query(
        `update manifest_generation_runs
         set row_version = row_version + 1, updated_at = now() where id = $1`,
        [runA],
      ),
      '55000',
    );

    await insertRun(client, {
      id: duplicateRun,
      worldId: worlds.a,
      promptId: promptA,
      hashByte: 21,
    });
    const duplicateCount = await client.pool.query<{ count: string }>(
      `select count(*)::text as count from manifest_generation_runs
       where world_id = $1 and input_hash = $2`,
      [worlds.a, Buffer.alloc(32, 21)],
    );
    expect(duplicateCount.rows[0]!.count).toBe('2');

    await insertRun(client, {
      id: cancelledRun,
      worldId: worlds.b,
      promptId: promptB,
      hashByte: 22,
    });
    await client.pool.query(
      `update manifest_generation_runs
          set status = 'cancelled', completed_at = now(), updated_at = now(),
              row_version = row_version + 1
        where id = $1`,
      [cancelledRun],
    );
    await expectDatabaseError(
      client.pool.query(
        `update manifest_generation_runs set status = 'running', stage = 'intent',
          progress_percent = 5, attempts = 1, claim_token = $2, claimed_at = now(),
          heartbeat_at = now(), started_at = now(), completed_at = null,
          updated_at = now(), row_version = row_version + 1 where id = $1`,
        [cancelledRun, '028f0000-0000-7000-8000-000000000714'],
      ),
      '55000',
    );

    await expectDatabaseError(
      insertRun(client, {
        id: '028f0000-0000-7000-8000-000000000705',
        worldId: worlds.b,
        promptId: promptA,
        hashByte: 23,
      }),
      '55000',
    );
  });

  it('seals one generated output with exact run, claim, validation and field provenance', async () => {
    const promptId = '028f0000-0000-7000-8000-000000000604';
    const runId = '028f0000-0000-7000-8000-000000000704';
    const claimToken = '028f0000-0000-7000-8000-000000000715';
    const revisionId = '028f0000-0000-7000-8000-000000000801';
    const reportId = '028f0000-0000-7000-8000-000000000901';
    await insertPrompt(client, { id: promptId, worldId: worlds.generatedSafety, hashByte: 14 });
    await insertRun(client, { id: runId, worldId: worlds.generatedSafety, promptId, hashByte: 24 });
    await expect(claimRun(client, runId, claimToken)).resolves.toBe(1);
    await freezeCatalog(client, runId, 33, 34);

    await transaction(client, async (connection) => {
      await connection.query(
        `insert into generation_retrieval_items(
           run_id,rank,primitive_version_id,retrieval_score,reason,content_hash
         ) values ($1,1,$2,100,'{"selected":true}'::jsonb,$3)`,
        [runId, primitive.id, primitive.content_hash],
      );
      await connection.query(
        `insert into manifest_revisions(
           id,world_id,revision_number,parent_revision_id,manifest_schema_version,
           canonical_manifest,content_hash,source,generation_run_id,generation_claim_token,
           created_by_user_id
         ) values ($1,$2,1,null,1,$3,$4,'generation',$5,$6,$7)`,
        [
          revisionId,
          worlds.generatedSafety,
          { metadata: { key: 'generated-a' } },
          Buffer.alloc(32, 41),
          runId,
          claimToken,
          creatorId,
        ],
      );
      await connection.query(
        `insert into manifest_field_provenance(
           manifest_revision_id,json_pointer,source_type,source_ref,source_hash
         ) values ($1,'/metadata/key','prompt',$2,$3)`,
        [revisionId, promptId, Buffer.alloc(32, 14)],
      );
      await connection.query(
        `insert into manifest_validation_reports(
           id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
           valid,diagnostics,report_hash
         ) values ($1,$2,1,$3,true,'[]'::jsonb,$4)`,
        [reportId, revisionId, Buffer.alloc(32, 33), Buffer.alloc(32, 42)],
      );
      await connection.query(
        `update manifest_generation_runs
            set status = 'succeeded', stage = 'complete', progress_percent = 100,
                generation_mode = 'fallback', output_review = $2,
                output_revision_id = $3, claim_token = null, completed_at = now(),
                updated_at = now(), row_version = row_version + 1
          where id = $1 and claim_token = $4`,
        [
          runId,
          { assumptions: [], suggestedFixes: [], unresolvedQuestions: [], warnings: [] },
          revisionId,
          claimToken,
        ],
      );
    });
    const sealed = await client.pool.query(
      `select status::text,stage,generation_mode::text,output_revision_id,
              octet_length(resolved_input_hash) as resolved_hash_length
       from manifest_generation_runs where id = $1`,
      [runId],
    );
    expect(sealed.rows[0]).toEqual({
      generation_mode: 'fallback',
      output_revision_id: revisionId,
      resolved_hash_length: 32,
      stage: 'complete',
      status: 'succeeded',
    });
    await expectDatabaseError(
      client.pool.query(
        `update manifest_revisions set canonical_manifest = '{"changed":true}'::jsonb,
          row_version = row_version + 1 where id = $1`,
        [revisionId],
      ),
      '55000',
    );
    await expectDatabaseError(
      client.pool.query(`delete from manifest_validation_reports where id = $1`, [reportId]),
      '55000',
    );
    await expectDatabaseError(
      client.pool.query(
        `insert into manifest_field_provenance(
           manifest_revision_id,json_pointer,source_type,source_ref,source_hash
         ) values ($1,'/late','model','late',$2)`,
        [revisionId, Buffer.alloc(32, 43)],
      ),
      '55000',
    );
  });

  it('serializes cancellation against generated output publication', async () => {
    const promptId = '028f0000-0000-7000-8000-000000000605';
    const runId = '028f0000-0000-7000-8000-000000000706';
    const claimToken = '028f0000-0000-7000-8000-000000000716';
    const revisionId = '028f0000-0000-7000-8000-000000000802';
    await insertPrompt(client, { id: promptId, worldId: worlds.d, hashByte: 15 });
    await insertRun(client, { id: runId, worldId: worlds.d, promptId, hashByte: 25 });
    await claimRun(client, runId, claimToken);
    await freezeCatalog(client, runId, 35, 36);

    const [cancel, publish] = await Promise.allSettled([
      transaction(client, async (connection) => {
        await connection.query(
          `update manifest_generation_runs
              set status = 'cancelled', claim_token = null, completed_at = now(),
                  updated_at = now(), row_version = row_version + 1
            where id = $1 and status = 'running' and claim_token = $2`,
          [runId, claimToken],
        );
      }),
      transaction(client, async (connection) => {
        await connection.query(
          `insert into manifest_revisions(
             id,world_id,revision_number,manifest_schema_version,canonical_manifest,
             content_hash,source,generation_run_id,generation_claim_token,created_by_user_id
           ) values ($1,$2,1,1,'{"metadata":{"key":"race"}}'::jsonb,$3,
             'generation',$4,$5,$6)`,
          [revisionId, worlds.d, Buffer.alloc(32, 44), runId, claimToken, creatorId],
        );
      }),
    ]);
    expect([cancel, publish].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect([cancel, publish].filter((result) => result.status === 'rejected')).toHaveLength(1);

    const state = await client.pool.query<{ status: string }>(
      `select status::text from manifest_generation_runs where id = $1`,
      [runId],
    );
    const outputs = await client.pool.query<{ count: string }>(
      `select count(*)::text as count from manifest_revisions where generation_run_id = $1`,
      [runId],
    );
    if (state.rows[0]!.status === 'cancelled') {
      expect(outputs.rows[0]!.count).toBe('0');
      await expectDatabaseError(
        client.pool.query(
          `insert into manifest_revisions(
             id,world_id,revision_number,manifest_schema_version,canonical_manifest,
             content_hash,source,generation_run_id,generation_claim_token,created_by_user_id
           ) values ($1,$2,1,1,'{}'::jsonb,$3,'generation',$4,$5,$6)`,
          [revisionId, worlds.d, Buffer.alloc(32, 44), runId, claimToken, creatorId],
        ),
        '55000',
      );
    } else {
      expect(state.rows[0]!.status).toBe('running');
      expect(outputs.rows[0]!.count).toBe('1');
      await expectDatabaseError(
        client.pool.query(
          `update manifest_generation_runs
              set status = 'cancelled', claim_token = null, completed_at = now(),
                  updated_at = now(), row_version = row_version + 1
            where id = $1 and claim_token = $2`,
          [runId, claimToken],
        ),
        '55000',
      );
      await client.pool.query(
        `update manifest_generation_runs
            set status = 'succeeded', stage = 'complete', progress_percent = 100,
                generation_mode = 'fallback', output_review = $2,
                output_revision_id = $3, claim_token = null, completed_at = now(),
                updated_at = now(), row_version = row_version + 1
          where id = $1 and claim_token = $4`,
        [
          runId,
          { assumptions: [], suggestedFixes: [], unresolvedQuestions: [], warnings: [] },
          revisionId,
          claimToken,
        ],
      );
    }
  });

  it('locks each world stream so concurrent revisions remain immutable and monotonic', async () => {
    const firstRevision = '028f0000-0000-7000-8000-000000000803';
    const candidateA = '028f0000-0000-7000-8000-000000000804';
    const candidateB = '028f0000-0000-7000-8000-000000000805';
    await insertManualRevision(client.pool, {
      hashByte: 51,
      id: firstRevision,
      revisionNumber: 1,
      worldId: worlds.c,
    });
    const concurrent = await Promise.allSettled([
      insertManualRevision(client.pool, {
        hashByte: 52,
        id: candidateA,
        parentRevisionId: firstRevision,
        revisionNumber: 2,
        worldId: worlds.c,
      }),
      insertManualRevision(client.pool, {
        hashByte: 53,
        id: candidateB,
        parentRevisionId: firstRevision,
        revisionNumber: 2,
        worldId: worlds.c,
      }),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const revisions = await client.pool.query<{ id: string; revision_number: string }>(
      `select id,revision_number::text from manifest_revisions
       where world_id = $1 order by revision_number`,
      [worlds.c],
    );
    expect(revisions.rows.map((row) => row.revision_number)).toEqual(['1', '2']);

    await expectDatabaseError(
      insertManualRevision(client.pool, {
        hashByte: 54,
        id: '028f0000-0000-7000-8000-000000000806',
        parentRevisionId: firstRevision,
        revisionNumber: 1,
        worldId: worlds.b,
      }),
      '55000',
    );
    await expectDatabaseError(
      insertRun(client, {
        hashByte: 26,
        id: '028f0000-0000-7000-8000-000000000707',
        parentHash: Buffer.alloc(32, 51),
        parentRevisionId: firstRevision,
        promptId: '028f0000-0000-7000-8000-000000000603',
        worldId: worlds.b,
      }),
      '23503',
    );
    await expectDatabaseError(
      client.pool.query(`delete from manifest_revisions where id = $1`, [firstRevision]),
      '55000',
    );
  });

  it('admits only one active parentless generation per world under a direct database race', async () => {
    const promptIds = [
      '028f0000-0000-7000-8000-000000001601',
      '028f0000-0000-7000-8000-000000001602',
    ];
    const runIds = ['028f0000-0000-7000-8000-000000001701', '028f0000-0000-7000-8000-000000001702'];
    await Promise.all(
      promptIds.map((id, index) =>
        insertPrompt(client, { hashByte: 70 + index, id, worldId: worlds.rootSafety }),
      ),
    );
    const raced = await Promise.allSettled(
      runIds.map((id, index) =>
        insertRun(client, {
          hashByte: 80 + index,
          id,
          promptId: promptIds[index]!,
          worldId: worlds.rootSafety,
        }),
      ),
    );

    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = raced.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: '23505' } });
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      constraint: 'manifest_generation_runs_one_active_root_world_idx',
    });
    const active = await client.pool.query<{ count: string }>(
      `select count(*)::text as count from manifest_generation_runs
        where world_id = $1 and parent_revision_id is null
          and status in ('queued','running')`,
      [worlds.rootSafety],
    );
    expect(active.rows[0]?.count).toBe('1');
  });

  it('seals generation warnings onto revisions, inherits them, and rejects acknowledgement bypass', async () => {
    const promptId = '028f0000-0000-7000-8000-000000001611';
    const runId = '028f0000-0000-7000-8000-000000001711';
    const claimToken = '028f0000-0000-7000-8000-000000001811';
    const generatedRevision = '028f0000-0000-7000-8000-000000001911';
    const manualRevision = '028f0000-0000-7000-8000-000000001912';
    const generationWarnings = [
      {
        code: 'FALLBACK_TEMPLATE_USED',
        message: 'The deterministic fallback generated this draft.',
        pointer: '',
      },
      {
        code: 'HIGH_IMPACT_RULES_REQUIRE_REVIEW',
        message: 'Review high-impact rules before approval.',
        pointer: '/simulation',
      },
    ];
    await insertPrompt(client, { id: promptId, worldId: worlds.warningSafety });
    await insertRun(client, { id: runId, promptId, worldId: worlds.warningSafety });
    expect(await claimRun(client, runId, claimToken)).toBe(1);
    await freezeCatalog(client, runId);
    await expectDatabaseError(
      client.pool.query(
        `insert into manifest_revisions(
           id,world_id,revision_number,manifest_schema_version,canonical_manifest,
           content_hash,source,generation_run_id,generation_claim_token,created_by_user_id,
           generation_warnings
         ) values ($1,$2,1,1,$3,$4,'generation',$5,$6,$7,$8)`,
        [
          generatedRevision,
          worlds.warningSafety,
          { metadata: { key: 'oversized-generation-warning-root' } },
          Buffer.alloc(32, 90),
          runId,
          claimToken,
          creatorId,
          JSON.stringify(
            Array.from({ length: 33 }, (_, index) => ({
              code: `WARNING_${index}`,
              message: `Warning ${index}.`,
              pointer: '',
            })),
          ),
        ],
      ),
      '23514',
    );
    await client.pool.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,manifest_schema_version,canonical_manifest,
         content_hash,source,generation_run_id,generation_claim_token,created_by_user_id,
         generation_warnings
       ) values ($1,$2,1,1,$3,$4,'generation',$5,$6,$7,$8)`,
      [
        generatedRevision,
        worlds.warningSafety,
        { metadata: { key: 'generated-warning-root' } },
        Buffer.alloc(32, 91),
        runId,
        claimToken,
        creatorId,
        JSON.stringify(generationWarnings),
      ],
    );
    await insertValidReport(client, generatedRevision, '028f0000-0000-7000-8000-000000001921', 92);
    await client.pool.query(
      `update manifest_generation_runs
          set status = 'succeeded', stage = 'complete', progress_percent = 100,
              generation_mode = 'fallback', output_review = $2,
              output_revision_id = $3, claim_token = null, completed_at = now(),
              updated_at = now(), row_version = row_version + 1
        where id = $1 and claim_token = $4`,
      [
        runId,
        {
          assumptions: [],
          suggestedFixes: [],
          unresolvedQuestions: [],
          warnings: generationWarnings,
        },
        generatedRevision,
        claimToken,
      ],
    );

    await expectDatabaseError(
      insertManualRevision(client.pool, {
        hashByte: 93,
        id: manualRevision,
        parentRevisionId: generatedRevision,
        revisionNumber: 2,
        worldId: worlds.warningSafety,
      }),
      '55000',
    );
    await client.pool.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,parent_revision_id,manifest_schema_version,
         canonical_manifest,content_hash,source,created_by_user_id,generation_warnings
       ) values ($1,$2,2,$3,1,$4,$5,'manual',$6,$7)`,
      [
        manualRevision,
        worlds.warningSafety,
        generatedRevision,
        { metadata: { key: 'manual-warning-child' } },
        Buffer.alloc(32, 93),
        creatorId,
        JSON.stringify(generationWarnings),
      ],
    );
    await insertValidReport(client, manualRevision, '028f0000-0000-7000-8000-000000001922', 94);
    await expectDatabaseError(
      client.pool.query(
        `update manifest_revisions
            set approval_status = 'approved', approved_by_user_id = $2,
                approved_at = now(), row_version = row_version + 1
          where id = $1`,
        [manualRevision, creatorId],
      ),
      '55000',
    );
    await transaction(client, async (connection) => {
      await connection.query(
        `update manifest_revisions
            set approval_status = 'approved', approved_by_user_id = $2,
                approved_at = now(), warning_acknowledgements = $3,
                row_version = row_version + 1
          where id = $1`,
        [
          manualRevision,
          creatorId,
          JSON.stringify(['FALLBACK_TEMPLATE_USED', 'HIGH_IMPACT_RULES_REQUIRE_REVIEW']),
        ],
      );
      await connection.query(
        `update worlds
            set current_approved_manifest_revision_id = $2, manifest_schema_version = 1,
                row_version = row_version + 1, updated_at = now()
          where id = $1`,
        [worlds.warningSafety, manualRevision],
      );
    });
    const stored = await client.pool.query<{
      generation_warnings: unknown;
      warning_acknowledgements: unknown;
    }>(
      `select generation_warnings, warning_acknowledgements
         from manifest_revisions where id = $1`,
      [manualRevision],
    );
    expect(stored.rows[0]).toEqual({
      generation_warnings: generationWarnings,
      warning_acknowledgements: ['FALLBACK_TEMPLATE_USED', 'HIGH_IMPACT_RULES_REQUIRE_REVIEW'],
    });
  });

  it('requires the latest revision, latest valid report and creator approval', async () => {
    const firstRevision = '028f0000-0000-7000-8000-000000000803';
    const second = await client.pool.query<{ id: string }>(
      `select id from manifest_revisions where world_id = $1 and revision_number = 2`,
      [worlds.c],
    );
    const secondRevision = second.rows[0]!.id;

    await expectDatabaseError(
      transaction(client, async (connection) => {
        await connection.query(
          `update worlds set manifest_schema_version = 1,
            row_version = row_version + 1, updated_at = now() where id = $1`,
          [worlds.b],
        );
      }),
      '23514',
    );
    await client.pool.query(
      `insert into manifest_validation_reports(
         id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
         valid,diagnostics,report_hash
       ) values ($1,$2,1,$3,false,'[{"code":"INVALID"}]'::jsonb,$4)`,
      [
        '028f0000-0000-7000-8000-000000000902',
        firstRevision,
        Buffer.alloc(32, 61),
        Buffer.alloc(32, 62),
      ],
    );
    await expectDatabaseError(
      client.pool.query(
        `update manifest_revisions
            set approval_status = 'approved', approved_by_user_id = $2,
                approved_at = now(), row_version = row_version + 1
          where id = $1`,
        [firstRevision, creatorId],
      ),
      '55000',
    );
    await insertValidReport(client, firstRevision, '028f0000-0000-7000-8000-000000000903', 63);
    await expectDatabaseError(
      client.pool.query(
        `update manifest_revisions
            set approval_status = 'approved', approved_by_user_id = $2,
                approved_at = now(), row_version = row_version + 1
          where id = $1`,
        [firstRevision, administratorId],
      ),
      '55000',
    );
    await expectDatabaseError(
      client.pool.query(
        `update manifest_revisions
            set approval_status = 'approved', approved_by_user_id = $2,
                approved_at = now(), row_version = row_version + 1
          where id = $1`,
        [firstRevision, creatorId],
      ),
      '55000',
    );

    await insertValidReport(client, secondRevision, '028f0000-0000-7000-8000-000000000904', 65);
    await transaction(client, async (connection) => {
      await connection.query(
        `update manifest_revisions
            set approval_status = 'approved', approved_by_user_id = $2,
                approved_at = now(), row_version = row_version + 1
          where id = $1`,
        [secondRevision, creatorId],
      );
      await connection.query(
        `update worlds
            set current_approved_manifest_revision_id = $2, manifest_schema_version = 1,
                row_version = row_version + 1, updated_at = now()
          where id = $1`,
        [worlds.c, secondRevision],
      );
    });
    const pointer = await client.pool.query(
      `select w.current_approved_manifest_revision_id,w.manifest_schema_version,
              count(*) filter (where r.approval_status = 'approved')::integer as approved_count
       from worlds w left join manifest_revisions r on r.world_id = w.id
       where w.id = $1 group by w.id`,
      [worlds.c],
    );
    expect(pointer.rows[0]).toEqual({
      approved_count: 1,
      current_approved_manifest_revision_id: secondRevision,
      manifest_schema_version: 1,
    });
    await expectDatabaseError(
      client.pool.query(
        `update worlds set current_approved_manifest_revision_id = null,
          manifest_schema_version = null, row_version = row_version + 1,
          updated_at = now() where id = $1`,
        [worlds.c],
      ),
      '55000',
    );
    await expectDatabaseError(
      transaction(client, async (connection) => {
        await connection.query(
          `update worlds set current_approved_manifest_revision_id = $2,
            manifest_schema_version = 1, row_version = row_version + 1,
            updated_at = now() where id = $1`,
          [worlds.b, secondRevision],
        );
      }),
      '23503',
    );
  });

  it('serializes simultaneous first approvals to one revision and pointer', async () => {
    const revisionOne = '028f0000-0000-7000-8000-000000000807';
    const revisionTwo = '028f0000-0000-7000-8000-000000000808';
    await insertManualRevision(client.pool, {
      hashByte: 71,
      id: revisionOne,
      revisionNumber: 1,
      worldId: worlds.e,
    });
    await insertManualRevision(client.pool, {
      hashByte: 72,
      id: revisionTwo,
      parentRevisionId: revisionOne,
      revisionNumber: 2,
      worldId: worlds.e,
    });
    await insertValidReport(client, revisionOne, '028f0000-0000-7000-8000-000000000905', 73);
    await insertValidReport(client, revisionTwo, '028f0000-0000-7000-8000-000000000906', 75);
    const approve = (revisionId: string) =>
      transaction(client, async (connection) => {
        await connection.query(
          `update manifest_revisions
              set approval_status = 'approved', approved_by_user_id = $2,
                  approved_at = now(), row_version = row_version + 1
            where id = $1`,
          [revisionId, creatorId],
        );
        await connection.query(
          `update worlds
              set current_approved_manifest_revision_id = $2, manifest_schema_version = 1,
                  row_version = row_version + 1, updated_at = now()
            where id = $1`,
          [worlds.e, revisionId],
        );
      });
    const results = await Promise.allSettled([approve(revisionOne), approve(revisionTwo)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const state = await client.pool.query<{
      approved_count: number;
      current_approved_manifest_revision_id: string;
    }>(
      `select w.current_approved_manifest_revision_id,
              count(*) filter (where r.approval_status = 'approved')::integer as approved_count
       from worlds w join manifest_revisions r on r.world_id = w.id
       where w.id = $1 group by w.id`,
      [worlds.e],
    );
    expect(state.rows[0]!.approved_count).toBe(1);
    expect([revisionOne, revisionTwo]).toContain(
      state.rows[0]!.current_approved_manifest_revision_id,
    );
  });

  it('keeps runtime grants narrow while exposing the intended queue/status mutations', async () => {
    const privileges = await client.pool.query<{
      can_approve: boolean;
      can_claim: boolean;
      can_delete_prompt: boolean;
      can_edit_canonical: boolean;
      can_edit_provider_config: boolean;
      can_edit_prompt_hash: boolean;
      can_redact_prompt: boolean;
      can_update_world_table: boolean;
    }>(
      `select
         has_table_privilege('worldgraph_app','world_prompt_submissions','DELETE') as can_delete_prompt,
         has_column_privilege('worldgraph_app','world_prompt_submissions','normalized_hash','UPDATE') as can_edit_prompt_hash,
         has_column_privilege('worldgraph_app','world_prompt_submissions','prompt_text','UPDATE') as can_redact_prompt,
         has_column_privilege('worldgraph_app','manifest_generation_runs','claim_token','UPDATE') as can_claim,
         has_column_privilege('worldgraph_app','manifest_generation_runs','provider_configuration_id','UPDATE') as can_edit_provider_config,
         has_column_privilege('worldgraph_app','manifest_revisions','canonical_manifest','UPDATE') as can_edit_canonical,
         has_column_privilege('worldgraph_app','manifest_revisions','approval_status','UPDATE') as can_approve,
         has_table_privilege('worldgraph_app','worlds','UPDATE') as can_update_world_table`,
    );
    expect(privileges.rows[0]).toEqual({
      can_approve: true,
      can_claim: true,
      can_delete_prompt: false,
      can_edit_canonical: false,
      can_edit_prompt_hash: false,
      can_edit_provider_config: false,
      can_redact_prompt: true,
      can_update_world_table: false,
    });
    await expect(
      app.pool.query(`update world_prompt_submissions set normalized_hash = $2 where id = $1`, [
        '028f0000-0000-7000-8000-000000000601',
        Buffer.alloc(32, 99),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    const indexes = await client.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'
       and indexname = any($1::text[]) order by indexname`,
      [
        [
          'manifest_generation_runs_queue_idx',
          'manifest_generation_runs_one_active_root_world_idx',
          'manifest_generation_runs_running_lease_idx',
          'manifest_revisions_one_approved_world_idx',
          'manifest_validation_reports_revision_lookup_idx',
          'world_prompt_submissions_retention_idx',
        ],
      ],
    );
    expect(indexes.rowCount).toBe(6);
  });
});
