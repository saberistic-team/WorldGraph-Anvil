import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDatabaseClient, type DatabaseClient } from './index.js';
import * as schema from './schema.js';

const { Pool } = pg;
const migrationRoot = resolve('packages/db/drizzle');
const migrationTags = [
  '0001_platform_extensions',
  '0002_platform_metadata',
  '0003_identity_authority',
  '0004_primitive_registry',
  '0005_manifest_studio',
  '0006_deterministic_compiler',
  '0007_command_event_ledger',
  '0008_deterministic_clock_scheduler',
  '0009_wallets_transfers_ownership',
  '0010_production_business_market_tax',
  '0011_commerce_projection_repair',
  '0012_commerce_reconciliation_integrity',
] as const;

async function createMigrationRootThrough(lastIndex: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-migration-runner-'));
  const tags = migrationTags.slice(0, lastIndex + 1);
  await mkdir(join(root, 'meta'));
  await Promise.all(
    tags.map((tag) => cp(join(migrationRoot, `${tag}.sql`), join(root, `${tag}.sql`))),
  );
  await writeFile(
    join(root, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({
        idx,
        version: '7',
        when: 1784635200000 + idx * 60_000,
        tag,
        breakpoints: true,
      })),
    }),
  );
  return root;
}

async function createLateFailingHeadRoot(): Promise<string> {
  const root = await createMigrationRootThrough(11);
  await appendFile(
    join(root, '0012_commerce_reconciliation_integrity.sql'),
    `
--> statement-breakpoint
DO $atomic_failure$
BEGIN
  RAISE EXCEPTION 'intentional atomic migration failure';
END
$atomic_failure$;
`,
  );
  return root;
}

function createSingleConnectionClient(connectionString: string, applicationName: string) {
  const pool = new Pool({
    application_name: applicationName,
    connectionString,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    max: 1,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  return { db: drizzle(pool, { schema }), pool } satisfies DatabaseClient;
}

async function readM08State(client: DatabaseClient) {
  const result = await client.pool.query<{
    enum_labels: string[];
    migration_count: number;
    runtime_versions: Record<string, unknown>;
    runtime_versions_updated_at: string;
  }>(
    `select
       (select count(*)::integer from drizzle.__drizzle_migrations) as migration_count,
       (select value from platform_metadata where key='runtime_versions')
         as runtime_versions,
       (select updated_at::text from platform_metadata where key='runtime_versions')
         as runtime_versions_updated_at,
       (
         select array_agg(type.typname || ':' || enum.enumlabel
                          order by type.typname, enum.enumsortorder)
           from pg_enum enum
           join pg_type type on type.oid=enum.enumtypid
          where type.typname in (
            'economy_seed_plan_source',
            'financial_transaction_kind',
            'economy_participant_visibility'
          )
       ) as enum_labels`,
  );
  return result.rows[0];
}

describe('production migration runner', () => {
  let admin: DatabaseClient;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let m08Root: string;
  let headRoot: string;
  let lateFailingHeadRoot: string;

  beforeAll(async () => {
    [m08Root, headRoot, lateFailingHeadRoot] = await Promise.all([
      createMigrationRootThrough(8),
      createMigrationRootThrough(11),
      createLateFailingHeadRoot(),
    ]);
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    admin = createDatabaseClient(container.getConnectionUri(), 'migration-runner-admin');
  });

  afterAll(async () => {
    await admin?.pool.end();
    await container?.stop();
    await Promise.all([
      m08Root ? rm(m08Root, { force: true, recursive: true }) : Promise.resolve(),
      headRoot ? rm(headRoot, { force: true, recursive: true }) : Promise.resolve(),
      lateFailingHeadRoot
        ? rm(lateFailingHeadRoot, { force: true, recursive: true })
        : Promise.resolve(),
    ]);
  });

  async function createTestClient(database: string, applicationName: string) {
    await admin.pool.query(`create database ${database}`);
    const url = new URL(container.getConnectionUri());
    url.pathname = `/${database}`;
    return {
      client: createSingleConnectionClient(url.toString(), applicationName),
      url: url.toString(),
    };
  }

  it('upgrades an exact M08 database to head with a max-one pool', async () => {
    const { client } = await createTestClient('migration_runner_max_one', 'migration-max-one');
    try {
      await migrate(client.db, { migrationsFolder: m08Root });
      await applyMigrations(client, headRoot);

      const state = await client.pool.query<{
        compiler: string;
        contracts: string;
        compiler_1_2: boolean;
        market_purchase: boolean;
        migration_count: number;
        runtime_schema: string;
      }>(
        `select
           (select count(*)::integer from drizzle.__drizzle_migrations)
             as migration_count,
           (select value ->> 'compiler' from platform_metadata
             where key='runtime_versions') as compiler,
           (select value ->> 'contracts' from platform_metadata
             where key='runtime_versions') as contracts,
           (select value ->> 'runtimeSchema' from platform_metadata
             where key='runtime_versions') as runtime_schema,
           exists (
             select 1 from pg_enum enum join pg_type type on type.oid=enum.enumtypid
              where type.typname='economy_seed_plan_source'
                and enum.enumlabel='compiler_1_2'
           ) as compiler_1_2,
           exists (
             select 1 from pg_enum enum join pg_type type on type.oid=enum.enumtypid
              where type.typname='financial_transaction_kind'
                and enum.enumlabel='market_purchase'
           ) as market_purchase`,
      );
      expect(state.rows).toEqual([
        {
          compiler: '1.2.0',
          compiler_1_2: true,
          contracts: '9',
          market_purchase: true,
          migration_count: 12,
          runtime_schema: '9',
        },
      ]);
    } finally {
      await client.pool.end();
    }
  }, 240_000);

  it('atomically rolls back every M09 change when the final migration statement fails', async () => {
    const { client } = await createTestClient(
      'migration_runner_atomic_failure',
      'migration-atomic-failure',
    );
    try {
      await migrate(client.db, { migrationsFolder: m08Root });
      const before = await readM08State(client);
      expect(before).toMatchObject({
        enum_labels: [
          'economy_participant_visibility:participant',
          'economy_participant_visibility:operator',
          'economy_seed_plan_source:compiler_1_1',
          'economy_seed_plan_source:legacy_1_0_adapter',
          'financial_transaction_kind:initialization',
          'financial_transaction_kind:issuance',
          'financial_transaction_kind:transfer',
          'financial_transaction_kind:asset_purchase',
          'financial_transaction_kind:compensation',
        ],
        migration_count: 9,
        runtime_versions: {
          compiler: '1.1.0',
          contracts: 8,
          runtimeSchema: 8,
        },
      });

      await expect(applyMigrations(client, lateFailingHeadRoot)).rejects.toThrow(
        'intentional atomic migration failure',
      );
      await expect(readM08State(client)).resolves.toEqual(before);
      await expect(
        client.pool.query(`select to_regclass('public.resource_types')::text as resource_table`),
      ).resolves.toMatchObject({ rows: [{ resource_table: null }] });
    } finally {
      await client.pool.end();
    }
  }, 240_000);

  it('waits beyond normal query timeout and leaves no-op or corrupt M08 state unchanged', async () => {
    const { client, url } = await createTestClient(
      'migration_runner_guardrails',
      'migration-guardrails',
    );
    const lockHolder = createSingleConnectionClient(url, 'migration-lock-holder');
    try {
      await migrate(client.db, { migrationsFolder: m08Root });
      const beforeNoOp = await readM08State(client);
      const holderConnection = await lockHolder.pool.connect();
      let pending: Promise<{ error?: unknown; ok: boolean }> | undefined;
      try {
        await holderConnection.query(`select pg_advisory_lock(hashtextextended($1,0))`, [
          'worldgraph.schema-migration.v1',
        ]);
        pending = applyMigrations(client, m08Root).then(
          () => ({ ok: true }),
          (error: unknown) => ({ error, ok: false }),
        );
        await delay(5_250);
        const stillWaiting = await Promise.race([pending.then(() => false), delay(25, true)]);
        expect(stillWaiting).toBe(true);
      } finally {
        await holderConnection
          .query(`select pg_advisory_unlock(hashtextextended($1,0))`, [
            'worldgraph.schema-migration.v1',
          ])
          .catch(() => undefined);
        holderConnection.release();
      }
      await expect(pending).resolves.toEqual({ ok: true });
      await expect(readM08State(client)).resolves.toEqual(beforeNoOp);

      await client.pool.query(
        `update platform_metadata
            set value=jsonb_set(value, '{compiler}', '"corrupt"'::jsonb)
          where key='runtime_versions'`,
      );
      const corruptBefore = await readM08State(client);
      await expect(applyMigrations(client, headRoot)).rejects.toBeDefined();
      await expect(readM08State(client)).resolves.toEqual(corruptBefore);
      const partialState = await client.pool.query<{ resource_table: string | null }>(
        `select to_regclass('public.resource_types')::text as resource_table`,
      );
      expect(partialState.rows).toEqual([{ resource_table: null }]);
    } finally {
      await lockHolder.pool.end();
      await client.pool.end();
    }
  }, 240_000);
});
