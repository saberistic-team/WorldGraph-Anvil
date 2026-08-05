import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient, readRuntimeVersions } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const geographyTables = [
  'building_placements',
  'districts',
  'parcels',
  'points_of_interest',
  'roads',
  'spatial_reference_systems',
  'spawn_points',
  'territories',
  'visual_asset_catalog',
  'visual_scene_plans',
  'world_geography_heads',
] as const;

async function createExactM10MigrationRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-exact-m10-geo-'));
  await mkdir(join(root, 'meta'));
  const journal = JSON.parse(await readFile(join(migrationRoot, 'meta/_journal.json'), 'utf8')) as {
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
    version: string;
  };
  const entries = journal.entries.filter((entry) => entry.idx < 14);
  await Promise.all(
    entries.map((entry) =>
      cp(join(migrationRoot, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`)),
    ),
  );
  await writeFile(join(root, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return root;
}

async function insertWorldWithCreator(
  client: DatabaseClient,
  worldId: string,
  creatorId: string,
  slug: string,
): Promise<void> {
  const connection = await client.pool.connect();
  try {
    await connection.query('begin');
    await connection.query(
      `insert into worlds(id, slug, name, created_by_user_id)
       values ($1, $2, $3, $4)`,
      [worldId, slug, slug, creatorId],
    );
    await connection.query(
      `insert into world_memberships(world_id, user_id, role, granted_by_user_id)
       values ($1, $2, 'creator', $2)`,
      [worldId, creatorId],
    );
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

describe('M11 geography and visual scene schema', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'geography-schema-owner');
    await migrate(owner.db, { migrationsFolder: migrationRoot });
  }, 120_000);

  afterAll(async () => {
    await owner?.pool.end();
    await container?.stop();
  });

  it('installs geography tables, PostGIS indexes, and M11 runtime metadata', async () => {
    const tables = await owner.pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_name = any($1::text[])
        order by table_name`,
      [geographyTables],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...geographyTables].sort());

    const gist = await owner.pool.query<{ indexname: string }>(
      `select indexname
         from pg_indexes
        where schemaname = 'public'
          and indexname in (
            'territories_geom_gix','districts_geom_gix','parcels_geom_gix',
            'roads_geom_gix','building_placements_centroid_gix','spawn_points_gix'
          )
        order by indexname`,
    );
    expect(gist.rows.map((row) => row.indexname)).toEqual([
      'building_placements_centroid_gix',
      'districts_geom_gix',
      'parcels_geom_gix',
      'roads_geom_gix',
      'spawn_points_gix',
      'territories_geom_gix',
    ]);

    const catalog = await owner.pool.query<{ count: string }>(
      `select count(*)::text as count from visual_asset_catalog`,
    );
    expect(catalog.rows).toEqual([{ count: '4' }]);

    await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
      compiler: '1.4.0',
      compilerArtifactSchema: 5,
      contracts: 11,
      geographySchema: 1,
      geographySeedPlanSchema: 1,
      runtimeSchema: 11,
      visualScenePlanSchema: 1,
    });
  });

  it('upgrades exact sealed M10 (0014) without inventing geography', async () => {
    const upgradeDatabase = 'worldgraph_m11_geo_upgrade';
    await owner.pool.query(`create database ${upgradeDatabase}`);
    const upgradeUrl = new URL(container.getConnectionUri());
    upgradeUrl.pathname = `/${upgradeDatabase}`;
    const upgrade = createDatabaseClient(upgradeUrl.toString(), 'm11-geo-upgrade');
    const temporaryRoot = await createExactM10MigrationRoot();
    const worldId = '018f0000-0000-7000-8000-00000000d101';
    const userId = '018f0000-0000-7000-8000-00000000d001';
    try {
      await migrate(upgrade.db, { migrationsFolder: temporaryRoot });
      await expect(readRuntimeVersions(upgrade.pool)).resolves.toMatchObject({
        compiler: '1.3.0',
        compilerArtifactSchema: 4,
        contracts: 10,
        runtimeSchema: 10,
      });

      await upgrade.pool.query(
        `insert into users(id,email,password_hash,display_name)
         values ($1,'m11-geo@example.test',$2,'M11 Geo')`,
        [userId, passwordHash],
      );
      await insertWorldWithCreator(upgrade, worldId, userId, 'harbor-history');

      await migrate(upgrade.db, { migrationsFolder: migrationRoot });
      await expect(readRuntimeVersions(upgrade.pool)).resolves.toMatchObject({
        compiler: '1.4.0',
        compilerArtifactSchema: 5,
        contracts: 11,
        geographySchema: 1,
        runtimeSchema: 11,
      });

      const heads = await upgrade.pool.query<{ count: string }>(
        `select count(*)::text as count from world_geography_heads`,
      );
      const territories = await upgrade.pool.query<{ count: string }>(
        `select count(*)::text as count from territories`,
      );
      const scenes = await upgrade.pool.query<{ count: string }>(
        `select count(*)::text as count from visual_scene_plans`,
      );
      expect(heads.rows).toEqual([{ count: '0' }]);
      expect(territories.rows).toEqual([{ count: '0' }]);
      expect(scenes.rows).toEqual([{ count: '0' }]);
    } finally {
      await upgrade.pool.end();
      await rm(temporaryRoot, { force: true, recursive: true });
      await owner.pool.query(`drop database if exists ${upgradeDatabase}`);
    }
  }, 120_000);

  it('rejects invalid district geometry and enforces scene-plan immutability', async () => {
    const worldId = '018f0000-0000-7000-8000-00000000d301';
    const userId = '018f0000-0000-7000-8000-00000000d003';
    await owner.pool.query(
      `insert into users(id,email,password_hash,display_name)
       values ($1,'m11-geom@example.test',$2,'M11 Geom')
       on conflict do nothing`,
      [userId, passwordHash],
    );
    await insertWorldWithCreator(owner, worldId, userId, 'geo-probe');

    await owner.pool.query(
      `insert into territories(
         id, world_id, stable_key, geom, geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, 'territory:probe',
         ST_Multi(ST_GeomFromText('POLYGON((0 0,10 0,10 10,0 10,0 0))', 3857)),
         1, $1::uuid
       )`,
      ['018f0000-0000-7000-8000-00000000d401', worldId],
    );

    await expect(
      owner.pool.query(
        `insert into districts(
           id, world_id, territory_id, stable_key, zoning, geom,
           geography_version, created_command_id
         ) values (
           $1::uuid, $2::uuid, $3::uuid, 'district:bad', 'mixed',
           ST_GeomFromText('POLYGON((0 0,2 2,2 0,0 2,0 0))', 3857),
           1, $1::uuid
         )`,
        ['018f0000-0000-7000-8000-00000000d402', worldId, '018f0000-0000-7000-8000-00000000d401'],
      ),
    ).rejects.toBeTruthy();

    const planId = '018f0000-0000-7000-8000-00000000d501';
    await owner.pool.query(
      `insert into visual_scene_plans(
         id, world_id, geography_version, style_kit_version, compiler_version, seed,
         canonical_json, checksum, status, warnings, provenance, published_tick,
         created_command_id, created_event_id, created_state_revision
       ) values (
         $1::uuid, $2::uuid, 1, 1, '1.4.0', 'probe',
         '{"nodes":[]}'::jsonb, decode(repeat('ab',32),'hex'), 'published',
         '[]'::jsonb, '{}'::jsonb, 0, $1::uuid, $1::uuid, 1
       )`,
      [planId, worldId],
    );
    await expect(
      owner.pool.query(`update visual_scene_plans set seed = 'mutated' where id = $1::uuid`, [
        planId,
      ]),
    ).rejects.toMatchObject({ code: '25006' });
  });
});
