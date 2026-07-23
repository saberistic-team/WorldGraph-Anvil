import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { canonicalJson } from '@worldgraph/contracts';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient, readRuntimeVersions } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const creatorId = '038f0000-0000-7000-8000-000000000001';
const memberId = '038f0000-0000-7000-8000-000000000002';
const observerId = '038f0000-0000-7000-8000-000000000003';
const postActivationPlayerId = '038f0000-0000-7000-8000-000000000004';
const worldA = '038f0000-0000-7000-8000-000000000101';
const worldB = '038f0000-0000-7000-8000-000000000102';
const worldConcurrency = '038f0000-0000-7000-8000-000000000103';
const worldRollback = '038f0000-0000-7000-8000-000000000104';
const treasuryLogicalKey = 'institution:compiler-test-treasury';

function initialSimulationOutcomeHashV1(worldSeed: string): string {
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

interface ApprovedWorld {
  hash: Buffer;
  revisionId: string;
  worldId: string;
}

interface SeedIds {
  accountEntityId: string;
  characterEntityId: string;
  relationshipId: string;
  runId: string;
  versionId: string;
}

function memberPrincipalKey(worldId: string, userId: string): string {
  return `member-${createHash('sha256')
    .update(`worldgraph-member-principal-v1\0${worldId.toLowerCase()}\0${userId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function validAccountState(principalKey: string, role = 'creator'): Record<string, string> {
  return { membershipRole: role, principalKey };
}

function validCharacterState(role = 'creator'): Record<string, string | null> {
  return {
    blueprintLogicalKey: 'actor-blueprint:compiler-test',
    homeDistrictLogicalKey: 'district:compiler-test',
    membershipRole: role,
    name: 'Compiler Test Character',
    organizationLogicalKey: null,
  };
}

function validTreasuryState() {
  return {
    districtLogicalKey: null,
    name: 'Compiler Test Treasury',
    organizationLogicalKeys: [],
    parameters: {},
    primitiveRef: 'compiler-test',
  };
}

function economySeedPlan(worldId: string) {
  const wallets = [
    {
      initialBalanceMinor: '10000',
      ownerEntityLogicalKey: `character:${memberPrincipalKey(worldId, creatorId)}`,
      stableKey: `wallet:player:character:${memberPrincipalKey(worldId, creatorId)}:gcr`,
      walletKind: 'player',
      walletSchemaVersion: 1,
    },
    {
      initialBalanceMinor: '10000',
      ownerEntityLogicalKey: `character:${memberPrincipalKey(worldId, memberId)}`,
      stableKey: `wallet:player:character:${memberPrincipalKey(worldId, memberId)}:gcr`,
      walletKind: 'player',
      walletSchemaVersion: 1,
    },
    {
      initialBalanceMinor: '0',
      ownerEntityLogicalKey: treasuryLogicalKey,
      stableKey: 'wallet:treasury:gcr',
      walletKind: 'treasury',
      walletSchemaVersion: 1,
    },
  ].sort((left, right) =>
    left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0,
  );
  return {
    assets: [
      {
        assetSchemaVersion: 1,
        assetType: 'founding_seal',
        initialOwnerEntityLogicalKey: `character:${memberPrincipalKey(worldId, creatorId)}`,
        metadata: {
          displayName: 'Founding Seal',
          provenance: 'compiler-economy-adapter-v1',
        },
        stableKey: 'asset:founding-seal',
        transferable: true,
        worldEntityLogicalKey: null,
      },
    ],
    currency: {
      cashOutAllowed: false,
      code: 'GCR',
      currencySchemaVersion: 1,
      issuerEntityLogicalKey: treasuryLogicalKey,
      maxSupplyMinor: '10000000000',
      minorUnitScale: 2,
      name: 'Guild Credits',
      noCashValue: true,
      stableKey: 'currency:gcr',
    },
    economySeedPlanSchemaVersion: 1,
    initialSupplyMinor: '20000',
    wallets,
  };
}

function economySeedPlanHash(plan: ReturnType<typeof economySeedPlan>): string {
  return createHash('sha256')
    .update(canonicalJson({ domain: 'worldgraph.economy-seed-plan.v1', plan }), 'utf8')
    .digest('hex');
}

async function transaction<T>(
  pool: Pool,
  operation: (connection: PoolClient) => Promise<T>,
  isolation = false,
): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query(isolation ? 'begin isolation level serializable' : 'begin');
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

async function createApprovedWorld(
  pool: Pool,
  input: {
    hashByte: number;
    revisionId: string;
    slug: string;
    worldId: string;
    lifecycleAvailable?: boolean;
  },
): Promise<ApprovedWorld> {
  const hash = Buffer.alloc(32, input.hashByte);
  const reportId = input.revisionId.replace('0000000002', '0000000009');
  await transaction(pool, async (connection) => {
    await connection.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,$2,$3,$4)`,
      [input.worldId, input.slug, `World ${input.hashByte}`, creatorId],
    );
    await connection.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2),($1,$3,'player',$2)`,
      [input.worldId, creatorId, memberId],
    );
  });
  await pool.query(
    `insert into manifest_revisions(
       id,world_id,revision_number,manifest_schema_version,canonical_manifest,
       content_hash,source,created_by_user_id
     ) values ($1,$2,1,1,$3,$4,'manual',$5)`,
    [
      input.revisionId,
      input.worldId,
      { metadata: { key: input.slug, name: `World ${input.hashByte}` }, primitiveRefs: [] },
      hash,
      creatorId,
    ],
  );
  await pool.query(
    `insert into manifest_validation_reports(
       id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
       valid,diagnostics,report_hash
     ) values ($1,$2,1,$3,true,'[]'::jsonb,$4)`,
    [
      reportId,
      input.revisionId,
      Buffer.alloc(32, input.hashByte + 1),
      Buffer.alloc(32, input.hashByte + 2),
    ],
  );
  await transaction(pool, async (connection) => {
    await connection.query(
      `update manifest_revisions
          set approval_status = 'approved', approved_by_user_id = $2,
              approved_at = now(), row_version = row_version + 1
        where id = $1`,
      [input.revisionId, creatorId],
    );
    await connection.query(
      `update worlds
          set current_approved_manifest_revision_id = $2, manifest_schema_version = 1,
              ${input.lifecycleAvailable === false ? '' : "lifecycle = 'manifest_approved',"}
              row_version = row_version + 1, updated_at = now()
        where id = $1`,
      [input.worldId, input.revisionId],
    );
  });
  return { hash, revisionId: input.revisionId, worldId: input.worldId };
}

async function createRun(
  pool: Pool,
  approved: ApprovedWorld,
  input: { hashByte: number; idempotencyKey: string; runId: string },
): Promise<void> {
  await pool.query(
    `insert into world_compilation_runs(
       id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
       compiler_version,compiler_config_version,seed,requested_by_user_id,idempotency_key
     ) values ($1,$2,$3,$4,$5,'1.1.0',1,$6,$7,$8)`,
    [
      input.runId,
      approved.worldId,
      approved.revisionId,
      approved.hash,
      Buffer.alloc(32, input.hashByte),
      `seed-${input.hashByte}`,
      creatorId,
      input.idempotencyKey,
    ],
  );
}

async function markWorldCompiling(pool: Pool, worldId: string): Promise<void> {
  await pool.query(
    `update worlds set lifecycle = 'compiling', row_version = row_version + 1,
       updated_at = now() where id = $1`,
    [worldId],
  );
}

async function claimAndReachSeeding(pool: Pool, runId: string, claimToken: string): Promise<void> {
  await pool.query(
    `update world_compilation_runs
        set status = 'running', stage = 'validating', progress_percent = 10,
            attempts = case when attempts = 0 then 1 else attempts end,
            claim_token = $2, claimed_at = now(), heartbeat_at = now(),
            started_at = now(), updated_at = now(), row_version = row_version + 1
      where id = $1`,
    [runId, claimToken],
  );
  await pool.query(
    `update world_compilation_runs
        set stage = 'compiling', progress_percent = 50, heartbeat_at = now(),
            updated_at = now(), row_version = row_version + 1
      where id = $1`,
    [runId],
  );
  await pool.query(
    `update world_compilation_runs
        set stage = 'seeding', progress_percent = 80, heartbeat_at = now(),
            updated_at = now(), row_version = row_version + 1
      where id = $1`,
    [runId],
  );
}

function compilerTestUuid(suffix: number): string {
  return `038f0000-0000-7000-8000-${suffix.toString().padStart(12, '0')}`;
}

async function insertStagingVersion(
  connection: PoolClient,
  approved: ApprovedWorld,
  runId: string,
  versionId: string,
): Promise<void> {
  await connection.query(
    `insert into world_versions(
       id,world_id,version_number,manifest_revision_id,compilation_run_id,
       world_schema_version,compiler_version,compiler_config_version,seed,
       artifact_hash,status,created_by_user_id
     ) values ($1,$2,1,$3,$4,1,'1.1.0',1,'seed-40',$5,'staging',$6)`,
    [versionId, approved.worldId, approved.revisionId, runId, Buffer.alloc(32, 40), creatorId],
  );
}

async function insertControllerTriple(
  connection: PoolClient,
  input: {
    accountEntityId: string;
    characterPrincipalOverride?: string;
    characterEntityId: string;
    relationshipId: string;
    role: 'creator' | 'player';
    userId: string;
    versionId: string;
    worldId: string;
  },
): Promise<void> {
  const principalKey = memberPrincipalKey(input.worldId, input.userId);
  await connection.query(
    `insert into world_entities(
       id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
     ) values
       ($1,$3,$4,'account_principal',1,$5,$8),
       ($2,$3,$6,'player_character',1,$7,$8)`,
    [
      input.accountEntityId,
      input.characterEntityId,
      input.worldId,
      `account:${principalKey}`,
      validAccountState(principalKey, input.role),
      `character:${input.characterPrincipalOverride ?? principalKey}`,
      validCharacterState(input.role),
      input.versionId,
    ],
  );
  await connection.query(
    `insert into world_relationships(
       id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
       relationship_schema_version,attributes,created_world_version_id
     ) values ($1,$2,$3,'account_controls',$4,$5,1,'{}',$6)`,
    [
      input.relationshipId,
      input.worldId,
      `rel:account_controls:${principalKey}`,
      input.accountEntityId,
      input.characterEntityId,
      input.versionId,
    ],
  );
  await connection.query(
    `insert into world_entity_controllers(
       world_id,user_id,entity_id,control_scope,granted_world_version_id
     ) values ($1,$2,$3,'primary',$4)`,
    [input.worldId, input.userId, input.characterEntityId, input.versionId],
  );
}

async function activateWorld(
  pool: Pool,
  approved: ApprovedWorld,
  ids: SeedIds,
  artifactHash: Buffer,
  options: { includePlayer?: boolean } = {},
): Promise<void> {
  const seedPlan = economySeedPlan(approved.worldId);
  const seedPlanHash = economySeedPlanHash(seedPlan);
  const playableMembers = [
    {
      accountEntityId: ids.accountEntityId,
      characterEntityId: ids.characterEntityId,
      principalKey: memberPrincipalKey(approved.worldId, creatorId),
      relationshipId: ids.relationshipId,
      role: 'creator',
      userId: creatorId,
    },
    {
      accountEntityId: '038f0000-0000-7000-8000-000000000603',
      characterEntityId: '038f0000-0000-7000-8000-000000000604',
      principalKey: memberPrincipalKey(approved.worldId, memberId),
      relationshipId: '038f0000-0000-7000-8000-000000000702',
      role: 'player',
      userId: memberId,
    },
  ].filter((member) => member.role === 'creator' || options.includePlayer !== false);
  await transaction(
    pool,
    async (connection) => {
      await connection.query('select worldgraph_lock_world_compilation($1)', [approved.worldId]);
      await connection.query(
        `insert into compiled_world_artifacts(
           id,world_id,compilation_run_id,artifact_kind,artifact_schema_version,
           canonical_content,content_hash
         ) values
           ($1,$4,$5,'compiler_input',1,$6,$7),
           ($2,$4,$5,'compiled_world',2,$8,$9),
           ($3,$4,$5,'visual_plan',1,$10,$11)`,
        [
          '038f0000-0000-7000-8000-000000000501',
          '038f0000-0000-7000-8000-000000000502',
          '038f0000-0000-7000-8000-000000000503',
          approved.worldId,
          ids.runId,
          { inputHash: 'deterministic-input' },
          Buffer.alloc(32, 41),
          {
            artifactSchemaVersion: 2,
            compilerConfigVersion: 1,
            compilerVersion: '1.1.0',
            economySeedPlan: seedPlan,
            economySeedPlanHash: seedPlanHash,
            entityCount: 5,
            relationshipCount: 2,
            schemaVersion: 1,
          },
          artifactHash,
          { projection: 'declarative' },
          Buffer.alloc(32, 43),
        ],
      );
      await connection.query(
        `insert into world_versions(
           id,world_id,version_number,manifest_revision_id,compilation_run_id,
           world_schema_version,compiler_version,compiler_config_version,seed,
           artifact_hash,status,created_by_user_id
         ) values ($1,$2,1,$3,$4,1,'1.1.0',1,$5,$6,'staging',$7)`,
        [
          ids.versionId,
          approved.worldId,
          approved.revisionId,
          ids.runId,
          'seed-40',
          artifactHash,
          creatorId,
        ],
      );
      await connection.query(
        `insert into world_entities(
           id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id
         ) values ($1,$2,$3,'institution',1,$4,$5)`,
        [
          '038f0000-0000-7000-8000-000000000605',
          approved.worldId,
          treasuryLogicalKey,
          validTreasuryState(),
          ids.versionId,
        ],
      );
      for (const member of playableMembers) {
        await connection.query(
          `insert into world_entities(
             id,world_id,logical_key,entity_type,entity_schema_version,state,
             created_world_version_id
           ) values
             ($1,$3,$4,'account_principal',1,$5,$8),
             ($2,$3,$6,'player_character',1,$7,$8)`,
          [
            member.accountEntityId,
            member.characterEntityId,
            approved.worldId,
            `account:${member.principalKey}`,
            validAccountState(member.principalKey, member.role),
            `character:${member.principalKey}`,
            validCharacterState(member.role),
            ids.versionId,
          ],
        );
        await connection.query(
          `insert into world_relationships(
             id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
             relationship_schema_version,attributes,created_world_version_id
           ) values ($1,$2,$3,'account_controls',$4,$5,1,'{}',$6)`,
          [
            member.relationshipId,
            approved.worldId,
            `rel:account_controls:${member.principalKey}`,
            member.accountEntityId,
            member.characterEntityId,
            ids.versionId,
          ],
        );
        await connection.query(
          `insert into world_entity_controllers(
             world_id,user_id,entity_id,control_scope,granted_world_version_id
           ) values ($1,$2,$3,'primary',$4)`,
          [approved.worldId, member.userId, member.characterEntityId, ids.versionId],
        );
      }
      await connection.query(
        `insert into compiled_economy_seed_plans(
           id,world_id,world_version_id,compilation_run_id,source_artifact_id,
           seed_plan_schema_version,source_kind,source_compiler_version,
           source_adapter_id,source_adapter_version,canonical_plan,plan_hash,
           source_artifact_hash
         ) values ($1,$2,$3,$4,$5,1,'compiler_1_1','1.1.0',
           'CompiledEconomySeedAdapterV1','1.0.0',$6::jsonb,$7,$8)`,
        [
          '038f0000-0000-7000-8000-000000000505',
          approved.worldId,
          ids.versionId,
          ids.runId,
          '038f0000-0000-7000-8000-000000000502',
          JSON.stringify(seedPlan),
          Buffer.from(seedPlanHash, 'hex'),
          artifactHash,
        ],
      );
      await connection.query(
        `insert into world_runtime_heads(world_id,active_world_version_id)
         values ($1,$2)`,
        [approved.worldId, ids.versionId],
      );
      await connection.query(
        `select * from worldgraph_append_compiled_genesis($1,$2,$3,$4,$5,$6,$7)`,
        [
          approved.worldId,
          ids.versionId,
          ids.runId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ],
      );
      await connection.query(
        `update world_versions set status = 'active', activated_at = now()
         where id = $1`,
        [ids.versionId],
      );
      await connection.query(
        `update worlds
            set lifecycle = 'active', active_world_version_id = $2,
                row_version = row_version + 1, updated_at = now()
          where id = $1`,
        [approved.worldId, ids.versionId],
      );
      await connection.query(
        `update world_compilation_runs
            set status = 'succeeded', stage = 'activated', progress_percent = 100,
                artifact_hash = $2, claim_token = null, completed_at = now(),
                updated_at = now(), row_version = row_version + 1
          where id = $1`,
        [ids.runId, artifactHash],
      );
    },
    true,
  );
}

describe('deterministic compiler WorldGraph persistence', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;
  let app: DatabaseClient;
  let approvedA: ApprovedWorld;
  let approvedB: ApprovedWorld;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'compiler-db-owner-test');
    await migrate(owner.db, { migrationsFolder: migrationRoot });
    await owner.pool.query(
      `insert into users(id,email,password_hash,display_name) values
       ($1,'compiler-creator@example.test',$3,'Compiler Creator'),
       ($2,'compiler-member@example.test',$3,'Compiler Member'),
       ($4,'compiler-observer@example.test',$3,'Compiler Observer'),
       ($5,'compiler-post-active@example.test',$3,'Post-activation Player')`,
      [creatorId, memberId, passwordHash, observerId, postActivationPlayerId],
    );
    approvedA = await createApprovedWorld(owner.pool, {
      hashByte: 10,
      revisionId: '038f0000-0000-7000-8000-000000000201',
      slug: 'compiler-world-a',
      worldId: worldA,
    });
    approvedB = await createApprovedWorld(owner.pool, {
      hashByte: 20,
      revisionId: '038f0000-0000-7000-8000-000000000202',
      slug: 'compiler-world-b',
      worldId: worldB,
    });
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'worldgraph_app';
    runtimeUrl.password = 'worldgraph_app_local_only';
    app = createDatabaseClient(runtimeUrl.toString(), 'compiler-db-app-test');
  });

  afterAll(async () => {
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
  });

  it('upgrades the exact 0005 head without compiling and advances compatibility exactly', async () => {
    const database = 'worldgraph_exact_m04_upgrade';
    await owner.pool.query(`create database ${database}`);
    const upgradeUrl = new URL(container.getConnectionUri());
    upgradeUrl.pathname = `/${database}`;
    const upgrade = createDatabaseClient(upgradeUrl.toString(), 'compiler-exact-m04-upgrade');
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'worldgraph-m04-migrations-'));
    try {
      await mkdir(join(temporaryRoot, 'meta'));
      const tags = [
        '0001_platform_extensions',
        '0002_platform_metadata',
        '0003_identity_authority',
        '0004_primitive_registry',
        '0005_manifest_studio',
      ];
      await Promise.all(
        tags.map((tag) => cp(join(migrationRoot, `${tag}.sql`), join(temporaryRoot, `${tag}.sql`))),
      );
      await writeFile(
        join(temporaryRoot, 'meta/_journal.json'),
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
      await migrate(upgrade.db, { migrationsFolder: temporaryRoot });
      await expect(readRuntimeVersions(upgrade.pool)).resolves.toMatchObject({
        compiler: '0.0.0',
        contracts: 4,
        runtimeSchema: 4,
      });
      await upgrade.pool.query(
        `insert into users(id,email,password_hash,display_name) values
         ($1,'upgrade-compiler@example.test',$3,'Upgrade Compiler'),
         ($2,'upgrade-member@example.test',$3,'Upgrade Member')`,
        [creatorId, memberId, passwordHash],
      );
      const approved = await createApprovedWorld(upgrade.pool, {
        hashByte: 70,
        lifecycleAvailable: false,
        revisionId: '038f0000-0000-7000-8000-000000000270',
        slug: 'exact-m04-approved',
        worldId: '038f0000-0000-7000-8000-000000000170',
      });
      await migrate(upgrade.db, { migrationsFolder: migrationRoot });
      await expect(readRuntimeVersions(upgrade.pool)).resolves.toMatchObject({
        compiler: '1.1.0',
        compilerArtifactSchema: 2,
        compilerConfigSchema: 1,
        compilationQueueSchema: 1,
        contracts: 8,
        runtimeSchema: 8,
        worldGraphSchema: 1,
      });
      const state = await upgrade.pool.query<{
        artifacts: string;
        lifecycle: string;
        runs: string;
        versions: string;
      }>(
        `select lifecycle::text,
          (select count(*) from world_compilation_runs)::text as runs,
          (select count(*) from compiled_world_artifacts)::text as artifacts,
          (select count(*) from world_versions)::text as versions
         from worlds where id = $1`,
        [approved.worldId],
      );
      expect(state.rows[0]).toEqual({
        artifacts: '0',
        lifecycle: 'manifest_approved',
        runs: '0',
        versions: '0',
      });
      await migrate(upgrade.db, { migrationsFolder: migrationRoot });
    } finally {
      await upgrade.pool.end();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('enforces discriminated entity state and relationship attribute contracts in PostgreSQL', async () => {
    const entityChecks = await owner.pool.query<{
      extra_key: boolean;
      mismatch: boolean;
      valid: boolean;
    }>(
      `select
        worldgraph_world_entity_state_is_valid(
          'district', 1,
          '{"name":"Civic Platform","parameters":{},"primitiveRef":"civic-district"}'::jsonb
        ) as valid,
        worldgraph_world_entity_state_is_valid(
          'district', 1,
          '{"name":"Civic Platform","parameters":{},"primitiveRef":"civic-district","x":1}'::jsonb
        ) as extra_key,
        worldgraph_world_entity_state_is_valid(
          'account_principal', 1,
          '{"name":"Civic Platform","parameters":{},"primitiveRef":"civic-district"}'::jsonb
        ) as mismatch`,
    );
    expect(entityChecks.rows[0]).toEqual({ extra_key: false, mismatch: false, valid: true });

    const relationshipChecks = await owner.pool.query<{
      missing_required: boolean;
      untyped_payload: boolean;
      valid: boolean;
    }>(
      `select
        worldgraph_world_relationship_attributes_are_valid(
          'connected_to', 1,
          '{"bidirectional":true,"connectionKind":"transit"}'::jsonb
        ) as valid,
        worldgraph_world_relationship_attributes_are_valid(
          'connected_to', 1, '{"connectionKind":"transit"}'::jsonb
        ) as missing_required,
        worldgraph_world_relationship_attributes_are_valid(
          'uses_primitive', 1, '{"arbitrary":"payload"}'::jsonb
        ) as untyped_payload`,
    );
    expect(relationshipChecks.rows[0]).toEqual({
      missing_required: false,
      untyped_payload: false,
      valid: true,
    });

    const constraints = await owner.pool.query<{ conname: string }>(
      `select conname from pg_constraint
       where conname in (
         'world_entities_state_matches_type',
         'world_relationships_attributes_match_type'
       ) order by conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      'world_entities_state_matches_type',
      'world_relationships_attributes_match_type',
    ]);
    const pairIndex = await owner.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'public'
         and indexname = 'world_relationships_active_account_control_pair_idx'`,
    );
    expect(pairIndex.rows[0]?.indexdef).toContain('(world_id, source_entity_id, target_entity_id)');
    expect(pairIndex.rows[0]?.indexdef).toContain("relationship_type = 'account_controls'");
  });

  it('keeps the SQL compiler private-key policy aligned with compound names', async () => {
    for (const key of [
      'accessToken',
      'serviceCredential',
      'apiKeyHint',
      'sessionIdentifier',
      'inviteReference',
      'promptStyle',
      'userIdAlias',
      'emailNotification',
      'privateEmail',
      'authorizationHeader',
      'cookieValue',
    ]) {
      const result = await owner.pool.query<{ detected: boolean }>(
        'select worldgraph_jsonb_has_compiler_private_key($1::jsonb) as detected',
        [JSON.stringify({ [key]: 'opaque-value' })],
      );
      expect(result.rows[0]?.detected, key).toBe(true);
    }
    const reviewedHash = await owner.pool.query<{ detected: boolean }>(
      'select worldgraph_jsonb_has_compiler_private_key($1::jsonb) as detected',
      [JSON.stringify({ promptHash: 'a'.repeat(64) })],
    );
    expect(reviewedHash.rows[0]?.detected).toBe(false);
    const unreviewedHash = await owner.pool.query<{ detected: boolean }>(
      'select worldgraph_jsonb_has_compiler_private_key($1::jsonb) as detected',
      [JSON.stringify({ promptHash: 'not-a-reviewed-hash' })],
    );
    expect(unreviewedHash.rows[0]?.detected).toBe(true);
  });

  it('serializes concurrent starts and retains exactly one active run', async () => {
    const approved = await createApprovedWorld(owner.pool, {
      hashByte: 30,
      revisionId: '038f0000-0000-7000-8000-000000000203',
      slug: 'compiler-concurrency',
      worldId: worldConcurrency,
    });
    const starts = [31, 32].map((hashByte, index) =>
      transaction(owner.pool, async (connection) => {
        await connection.query(
          `insert into world_compilation_runs(
             id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
             compiler_version,compiler_config_version,seed,requested_by_user_id,idempotency_key
           ) values ($1,$2,$3,$4,$5,'1.1.0',1,$6,$7,$8)`,
          [
            `038f0000-0000-7000-8000-00000000030${index + 1}`,
            approved.worldId,
            approved.revisionId,
            approved.hash,
            Buffer.alloc(32, hashByte),
            `seed-${hashByte}`,
            creatorId,
            `concurrency-key-${index}`,
          ],
        );
      }),
    );
    const results = await Promise.allSettled(starts);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stored = await owner.pool.query<{ count: string }>(
      `select count(*)::text as count from world_compilation_runs
       where world_id = $1 and status in ('queued','running')`,
      [approved.worldId],
    );
    expect(stored.rows[0]?.count).toBe('1');
  });

  it('enforces retry, pre-seeding cancellation, and terminal reset transitions', async () => {
    await createRun(owner.pool, approvedB, {
      hashByte: 35,
      idempotencyKey: 'retry-state-key',
      runId: '038f0000-0000-7000-8000-000000000305',
    });
    await markWorldCompiling(owner.pool, approvedB.worldId);
    const claim = '038f0000-0000-7000-8000-000000000405';
    await owner.pool.query(
      `update world_compilation_runs
          set status = 'running', stage = 'validating', progress_percent = 10,
              attempts = 1, claim_token = $2, claimed_at = now(), heartbeat_at = now(),
              started_at = now(), updated_at = now(), row_version = row_version + 1
        where id = $1`,
      ['038f0000-0000-7000-8000-000000000305', claim],
    );
    await transaction(owner.pool, async (connection) => {
      await connection.query(
        `update world_compilation_runs
            set status = 'failed', stage = 'failed', progress_percent = 40,
                diagnostics = $2, claim_token = null, completed_at = now(),
                updated_at = now(), row_version = row_version + 1
          where id = $1`,
        [
          '038f0000-0000-7000-8000-000000000305',
          JSON.stringify([{ code: 'INVALID_REFERENCE', message: 'Reference is invalid.' }]),
        ],
      );
      await connection.query(
        `update worlds set lifecycle = 'compile_failed', row_version = row_version + 1,
           updated_at = now() where id = $1`,
        [approvedB.worldId],
      );
    });
    await transaction(owner.pool, async (connection) => {
      await connection.query(
        `update world_compilation_runs
            set status = 'queued', stage = 'queued', progress_percent = 0,
                diagnostics = '[]', attempts = attempts + 1, next_attempt_at = now(),
                claim_token = null, claimed_at = null, heartbeat_at = null,
                started_at = null, completed_at = null, updated_at = now(),
                row_version = row_version + 1
          where id = $1`,
        ['038f0000-0000-7000-8000-000000000305'],
      );
      await connection.query(
        `update worlds set lifecycle = 'compiling', row_version = row_version + 1,
           updated_at = now() where id = $1`,
        [approvedB.worldId],
      );
    });
    await transaction(owner.pool, async (connection) => {
      await connection.query(
        `update world_compilation_runs
            set status = 'cancelled', stage = 'cancelled', progress_percent = 100,
                completed_at = now(), updated_at = now(), row_version = row_version + 1
          where id = $1`,
        ['038f0000-0000-7000-8000-000000000305'],
      );
      await connection.query(
        `update worlds set lifecycle = 'manifest_approved', row_version = row_version + 1,
           updated_at = now() where id = $1`,
        [approvedB.worldId],
      );
    });
    const state = await owner.pool.query<{
      attempts: number;
      diagnostics: unknown[];
      lifecycle: string;
      status: string;
    }>(
      `select run.status::text, run.attempts, run.diagnostics, world.lifecycle::text
       from world_compilation_runs run join worlds world on world.id = run.world_id
       where run.id = $1`,
      ['038f0000-0000-7000-8000-000000000305'],
    );
    expect(state.rows[0]).toEqual({
      attempts: 2,
      diagnostics: [],
      lifecycle: 'manifest_approved',
      status: 'cancelled',
    });
  });

  it('rolls back injected partial seed work and rejects a partial commit', async () => {
    const approved = await createApprovedWorld(owner.pool, {
      hashByte: 40,
      revisionId: '038f0000-0000-7000-8000-000000000204',
      slug: 'compiler-rollback',
      worldId: worldRollback,
    });
    const runId = '038f0000-0000-7000-8000-000000000304';
    await createRun(owner.pool, approved, {
      hashByte: 40,
      idempotencyKey: 'rollback-state-key',
      runId,
    });
    await markWorldCompiling(owner.pool, approved.worldId);
    await claimAndReachSeeding(owner.pool, runId, '038f0000-0000-7000-8000-000000000404');
    await expect(
      owner.pool.query(
        `insert into compiled_world_artifacts(
           id,world_id,compilation_run_id,artifact_kind,artifact_schema_version,
           canonical_content,content_hash
         ) values ($1,$2,$3,'compiler_input',1,$4,$5)`,
        [
          '038f0000-0000-7000-8000-000000000514',
          approved.worldId,
          runId,
          { userId: creatorId },
          Buffer.alloc(32, 44),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      transaction(owner.pool, async (connection) => {
        await connection.query(
          `insert into compiled_world_artifacts(
             id,world_id,compilation_run_id,artifact_kind,artifact_schema_version,
             canonical_content,content_hash
           ) values ($1,$2,$3,'compiled_world',2,'{"partial":true}',$4)`,
          ['038f0000-0000-7000-8000-000000000504', approved.worldId, runId, Buffer.alloc(32, 40)],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    const counts = await owner.pool.query<{ artifacts: string; versions: string }>(
      `select (select count(*) from compiled_world_artifacts where compilation_run_id = $1)::text as artifacts,
              (select count(*) from world_versions where compilation_run_id = $1)::text as versions`,
      [runId],
    );
    expect(counts.rows[0]).toEqual({ artifacts: '0', versions: '0' });
  });

  it('rejects initial activation when another valid controller masks a missing playable member', async () => {
    const approved: ApprovedWorld = {
      hash: Buffer.alloc(32, 40),
      revisionId: '038f0000-0000-7000-8000-000000000204',
      worldId: worldRollback,
    };
    await expect(
      activateWorld(
        owner.pool,
        approved,
        {
          accountEntityId: compilerTestUuid(9_400),
          characterEntityId: compilerTestUuid(9_401),
          relationshipId: compilerTestUuid(9_402),
          runId: '038f0000-0000-7000-8000-000000000304',
          versionId: compilerTestUuid(9_403),
        },
        Buffer.alloc(32, 40),
        { includePlayer: false },
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'world_compilation_runs_terminal_graph_consistent',
    });
  });

  it('rejects wrong-principal bindings and orphan account or character rows', async () => {
    const approved: ApprovedWorld = {
      hash: Buffer.alloc(32, 40),
      revisionId: '038f0000-0000-7000-8000-000000000204',
      worldId: worldRollback,
    };
    const runId = '038f0000-0000-7000-8000-000000000304';
    const cases = ['wrong-character-principal', 'orphan-account', 'orphan-character'] as const;
    for (const [index, testCase] of cases.entries()) {
      await expect(
        transaction(owner.pool, async (connection) => {
          const versionId = compilerTestUuid(9_100 + index);
          const base = 9_200 + index * 10;
          await insertStagingVersion(connection, approved, runId, versionId);
          await insertControllerTriple(connection, {
            accountEntityId: compilerTestUuid(base),
            characterEntityId: compilerTestUuid(base + 1),
            relationshipId: compilerTestUuid(base + 2),
            role: 'creator',
            userId: creatorId,
            versionId,
            worldId: approved.worldId,
          });
          await insertControllerTriple(connection, {
            accountEntityId: compilerTestUuid(base + 3),
            characterEntityId: compilerTestUuid(base + 4),
            relationshipId: compilerTestUuid(base + 5),
            role: 'player',
            userId: memberId,
            versionId,
            worldId: approved.worldId,
            ...(testCase === 'wrong-character-principal'
              ? { characterPrincipalOverride: `member-${'e'.repeat(32)}` }
              : {}),
          });
          if (testCase === 'orphan-account') {
            const orphanPrincipal = `member-${'c'.repeat(32)}`;
            await connection.query(
              `insert into world_entities(
                 id,world_id,logical_key,entity_type,entity_schema_version,state,
                 created_world_version_id
               ) values ($1,$2,$3,'account_principal',1,$4,$5)`,
              [
                compilerTestUuid(base + 6),
                approved.worldId,
                `account:${orphanPrincipal}`,
                validAccountState(orphanPrincipal, 'player'),
                versionId,
              ],
            );
          } else if (testCase === 'orphan-character') {
            const orphanPrincipal = `member-${'d'.repeat(32)}`;
            await connection.query(
              `insert into world_entities(
                 id,world_id,logical_key,entity_type,entity_schema_version,state,
                 created_world_version_id
               ) values ($1,$2,$3,'player_character',1,$4,$5)`,
              [
                compilerTestUuid(base + 6),
                approved.worldId,
                `character:${orphanPrincipal}`,
                validCharacterState('player'),
                versionId,
              ],
            );
          }
          await connection.query('set constraints world_entity_controllers_require_edge immediate');
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'world_entity_controllers_edge_consistent',
      });
    }
  });

  it('atomically activates one graph and rejects mutation, cross-world edges, and late cancel', async () => {
    const runId = '038f0000-0000-7000-8000-000000000311';
    await owner.pool.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'observer',$3)`,
      [approvedA.worldId, observerId, creatorId],
    );
    await createRun(owner.pool, approvedA, {
      hashByte: 40,
      idempotencyKey: 'activation-state-key',
      runId,
    });
    await markWorldCompiling(owner.pool, approvedA.worldId);
    await claimAndReachSeeding(owner.pool, runId, '038f0000-0000-7000-8000-000000000401');
    await expect(
      owner.pool.query(
        `update world_compilation_runs
            set status = 'cancelled', stage = 'cancelled', progress_percent = 100,
                claim_token = null, completed_at = now(), updated_at = now(),
                row_version = row_version + 1
          where id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    const ids: SeedIds = {
      accountEntityId: '038f0000-0000-7000-8000-000000000601',
      characterEntityId: '038f0000-0000-7000-8000-000000000602',
      relationshipId: '038f0000-0000-7000-8000-000000000701',
      runId,
      versionId: '038f0000-0000-7000-8000-000000000401',
    };
    const artifactHash = Buffer.alloc(32, 42);
    await activateWorld(app.pool, approvedA, ids, artifactHash);
    const state = await owner.pool.query<{
      controllers: string;
      entities: string;
      lifecycle: string;
      relationships: string;
      status: string;
    }>(
      `select world.lifecycle::text, run.status::text,
        (select count(*) from world_entities where world_id = world.id)::text as entities,
        (select count(*) from world_relationships where world_id = world.id)::text as relationships,
        (select count(*) from world_entity_controllers where world_id = world.id)::text as controllers
       from worlds world join world_compilation_runs run on run.world_id = world.id
       where world.id = $1`,
      [approvedA.worldId],
    );
    expect(state.rows[0]).toEqual({
      controllers: '2',
      entities: '5',
      lifecycle: 'active',
      relationships: '2',
      status: 'succeeded',
    });
    const simulation = await owner.pool.query<{
      current_tick: string;
      event_types: string[];
      init_commands: string;
      mode: string;
      outcome_hash: string;
      state_revision: string;
    }>(
      `select clock.current_tick::text,clock.mode::text,runtime.state_revision::text,
        encode(clock.outcome_hash,'hex') outcome_hash,
        array(
          select event.event_type from domain_events event
          where event.world_id=clock.world_id order by event.world_event_sequence
        ) event_types,
        (select count(*)::text from command_records command
          where command.world_id=clock.world_id
            and command.command_type='InitializeWorldSimulationV1'
            and command.status='accepted') init_commands
       from world_simulation_clocks clock
       join world_runtime_heads runtime on runtime.world_id=clock.world_id
       where clock.world_id=$1`,
      [approvedA.worldId],
    );
    expect(simulation.rows[0]).toEqual({
      current_tick: '0',
      event_types: ['WorldCompiledGenesisV1', 'WorldSimulationInitializedV1'],
      init_commands: '1',
      mode: 'paused',
      outcome_hash: initialSimulationOutcomeHashV1('seed-40'),
      state_revision: '2',
    });
    const economy = await owner.pool.query<{
      economy_heads: string;
      initial_supply_minor: string;
      plan_hash: string;
      source_compiler_version: string;
      source_kind: string;
      wallet_count: number;
    }>(
      `select plan.source_kind::text,plan.source_compiler_version,
              encode(plan.plan_hash,'hex') as plan_hash,
              plan.canonical_plan ->> 'initialSupplyMinor' as initial_supply_minor,
              jsonb_array_length(plan.canonical_plan -> 'wallets') as wallet_count,
              (select count(*)::text from world_economy_heads
                where world_id=plan.world_id) as economy_heads
         from compiled_economy_seed_plans plan where plan.world_id=$1`,
      [approvedA.worldId],
    );
    expect(economy.rows[0]).toEqual({
      economy_heads: '0',
      initial_supply_minor: '20000',
      plan_hash: economySeedPlanHash(economySeedPlan(approvedA.worldId)),
      source_compiler_version: '1.1.0',
      source_kind: 'compiler_1_1',
      wallet_count: 3,
    });
    const observerPrincipal = memberPrincipalKey(approvedA.worldId, observerId);
    const observerGraph = await owner.pool.query<{ controllers: string; entities: string }>(
      `select
         (select count(*) from world_entities
          where world_id = $1 and logical_key::text in ($2,$3))::text as entities,
         (select count(*) from world_entity_controllers
          where world_id = $1 and user_id = $4 and revoked_at is null)::text as controllers`,
      [
        approvedA.worldId,
        `account:${observerPrincipal}`,
        `character:${observerPrincipal}`,
        observerId,
      ],
    );
    expect(observerGraph.rows[0]).toEqual({ controllers: '0', entities: '0' });
    await expect(
      owner.pool.query(`update world_entities set state = '{"changed":true}' where id = $1`, [
        ids.characterEntityId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.pool.query('delete from compiled_world_artifacts where compilation_run_id = $1', [
        runId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      transaction(owner.pool, async (connection) => {
        const rollbackVersion = '038f0000-0000-7000-8000-000000000409';
        const rollbackEntity = '038f0000-0000-7000-8000-000000000609';
        await connection.query(
          `insert into world_versions(
             id,world_id,version_number,manifest_revision_id,compilation_run_id,
             world_schema_version,compiler_version,compiler_config_version,seed,
             artifact_hash,status,created_by_user_id
           ) values ($1,$2,1,$3,$4,1,'1.1.0',1,'seed-40',$5,'staging',$6)`,
          [
            rollbackVersion,
            worldRollback,
            '038f0000-0000-7000-8000-000000000204',
            '038f0000-0000-7000-8000-000000000304',
            Buffer.alloc(32, 40),
            creatorId,
          ],
        );
        await connection.query(
          `insert into world_entities(
           id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id
           ) values ($1,$2,'account:rollback','account_principal',1,$4,$3)`,
          [
            rollbackEntity,
            worldRollback,
            rollbackVersion,
            validAccountState(`member-${'a'.repeat(32)}`),
          ],
        );
        await connection.query(
          `insert into world_relationships(
             id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
             relationship_schema_version,attributes,created_world_version_id
           ) values (
             $1,$2,'rel:connected_to:cross','connected_to',$3,$4,1,
             '{"bidirectional":true,"connectionKind":"transit"}'::jsonb,$5
           )`,
          [
            '038f0000-0000-7000-8000-000000000709',
            worldRollback,
            rollbackEntity,
            ids.characterEntityId,
            rollbackVersion,
          ],
        );
      }),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      transaction(owner.pool, async (connection) => {
        const mismatchVersion = '038f0000-0000-7000-8000-000000000419';
        const mismatchAccount = '038f0000-0000-7000-8000-000000000619';
        const mismatchCharacter = '038f0000-0000-7000-8000-000000000629';
        const mismatchPrincipal = memberPrincipalKey(worldRollback, creatorId);
        const mismatchedCharacterPrincipal = `member-${'c'.repeat(32)}`;
        await connection.query(
          `insert into world_versions(
             id,world_id,version_number,manifest_revision_id,compilation_run_id,
             world_schema_version,compiler_version,compiler_config_version,seed,
             artifact_hash,status,created_by_user_id
           ) values ($1,$2,1,$3,$4,1,'1.1.0',1,'seed-40',$5,'staging',$6)`,
          [
            mismatchVersion,
            worldRollback,
            '038f0000-0000-7000-8000-000000000204',
            '038f0000-0000-7000-8000-000000000304',
            Buffer.alloc(32, 40),
            creatorId,
          ],
        );
        await connection.query(
          `insert into world_entities(
             id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id
           ) values
             ($1,$3,$4,'account_principal',1,$5,$8),
             ($2,$3,$6,'player_character',1,$7,$8)`,
          [
            mismatchAccount,
            mismatchCharacter,
            worldRollback,
            `account:${mismatchPrincipal}`,
            validAccountState(mismatchPrincipal),
            `character:${mismatchedCharacterPrincipal}`,
            validCharacterState(),
            mismatchVersion,
          ],
        );
        await connection.query(
          `insert into world_relationships(
             id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
             relationship_schema_version,created_world_version_id
           ) values ($1,$2,'rel:account_controls:mismatch','account_controls',$3,$4,1,$5)`,
          [
            '038f0000-0000-7000-8000-000000000719',
            worldRollback,
            mismatchAccount,
            mismatchCharacter,
            mismatchVersion,
          ],
        );
        await connection.query(
          `insert into world_entity_controllers(
             world_id,user_id,entity_id,control_scope,granted_world_version_id
           ) values ($1,$2,$3,'primary',$4)`,
          [worldRollback, creatorId, mismatchCharacter, mismatchVersion],
        );
        await connection.query('select worldgraph_assert_controller_edges($1)', [worldRollback]);
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'world_entity_controllers_edge_consistent',
    });
    await expect(
      transaction(owner.pool, async (connection) => {
        const endpointVersion = '038f0000-0000-7000-8000-000000000429';
        const districtEntity = '038f0000-0000-7000-8000-000000000639';
        const organizationEntity = '038f0000-0000-7000-8000-000000000649';
        await connection.query(
          `insert into world_versions(
             id,world_id,version_number,manifest_revision_id,compilation_run_id,
             world_schema_version,compiler_version,compiler_config_version,seed,
             artifact_hash,status,created_by_user_id
           ) values ($1,$2,1,$3,$4,1,'1.1.0',1,'seed-40',$5,'staging',$6)`,
          [
            endpointVersion,
            worldRollback,
            '038f0000-0000-7000-8000-000000000204',
            '038f0000-0000-7000-8000-000000000304',
            Buffer.alloc(32, 40),
            creatorId,
          ],
        );
        await connection.query(
          `insert into world_entities(
             id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id
           ) values
             ($1,$3,'district:invalid-source','district',1,$4,$6),
             ($2,$3,'organization:invalid-target','organization',1,$5,$6)`,
          [
            districtEntity,
            organizationEntity,
            worldRollback,
            { name: 'Invalid Source', parameters: {}, primitiveRef: 'compiler-test' },
            {
              homeDistrictLogicalKey: 'district:invalid-source',
              name: 'Invalid Target',
              parameters: {},
              primitiveRef: 'compiler-test',
            },
            endpointVersion,
          ],
        );
        await connection.query(
          `insert into world_relationships(
             id,world_id,logical_key,relationship_type,source_entity_id,target_entity_id,
             relationship_schema_version,created_world_version_id
           ) values ($1,$2,'rel:located_in:invalid','located_in',$3,$4,1,$5)`,
          [
            '038f0000-0000-7000-8000-000000000729',
            worldRollback,
            districtEntity,
            organizationEntity,
            endpointVersion,
          ],
        );
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'world_relationships_endpoint_types_valid',
    });
  });

  it('blocks uncommanded active-world membership writes without synthesizing graph rows', async () => {
    await expect(
      transaction(owner.pool, async (connection) => {
        await connection.query(`set local role worldgraph_app`);
        await connection.query(
          `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
           values ($1,$2,'player',$3)`,
          [approvedA.worldId, postActivationPlayerId, creatorId],
        );
      }),
    ).rejects.toMatchObject({ code: '55000' });
    const principalKey = memberPrincipalKey(approvedA.worldId, postActivationPlayerId);
    const graph = await owner.pool.query<{
      controllers: string;
      entities: string;
      memberships: string;
    }>(
      `select
         (select count(*) from world_entities
          where world_id = $1 and logical_key::text in ($2,$3))::text as entities,
         (select count(*) from world_entity_controllers
          where world_id = $1 and user_id = $4 and revoked_at is null)::text as controllers,
         (select count(*) from world_memberships
          where world_id = $1 and user_id = $4)::text as memberships`,
      [
        approvedA.worldId,
        `account:${principalKey}`,
        `character:${principalKey}`,
        postActivationPlayerId,
      ],
    );
    expect(graph.rows[0]).toEqual({ controllers: '0', entities: '0', memberships: '0' });
  });

  it('gives the runtime role only the compiler and economy persistence capabilities it needs', async () => {
    const grants = await owner.pool.query<{ privilege_type: string; table_name: string }>(
      `select table_name, privilege_type
       from information_schema.role_table_grants
       where grantee = 'worldgraph_app'
         and table_name in (
           'world_compilation_runs','compiled_world_artifacts','world_versions',
           'world_entities','world_relationships','world_entity_controllers','world_runtime_heads',
           'compiled_economy_seed_plans','wallet_balances','financial_transactions',
           'wallet_postings','assets','asset_transfers','economy_repair_plans'
         )
       order by table_name, privilege_type`,
    );
    const capabilities = await owner.pool.query<{
      compiled_plan_mutable: boolean;
      repair_plans_visible: boolean;
      run_status_mutable: boolean;
      wallet_balance_mutable: boolean;
    }>(
      `select
         has_column_privilege(
           'worldgraph_app','world_compilation_runs','status','UPDATE'
         ) as run_status_mutable,
         has_column_privilege(
           'worldgraph_app','wallet_balances','available_minor','UPDATE'
         ) as wallet_balance_mutable,
         has_column_privilege(
           'worldgraph_app','compiled_economy_seed_plans','canonical_plan','UPDATE'
         ) as compiled_plan_mutable,
         has_table_privilege(
           'worldgraph_app','economy_repair_plans','SELECT'
         ) as repair_plans_visible`,
    );
    expect(capabilities.rows[0]).toEqual({
      compiled_plan_mutable: false,
      repair_plans_visible: false,
      run_status_mutable: true,
      wallet_balance_mutable: true,
    });
    expect(grants.rows).toContainEqual({
      privilege_type: 'INSERT',
      table_name: 'compiled_economy_seed_plans',
    });
    expect(grants.rows).toContainEqual({
      privilege_type: 'SELECT',
      table_name: 'compiled_economy_seed_plans',
    });
    expect(grants.rows).not.toContainEqual({
      privilege_type: 'UPDATE',
      table_name: 'world_entities',
    });
    expect(grants.rows).not.toContainEqual({
      privilege_type: 'UPDATE',
      table_name: 'compiled_economy_seed_plans',
    });
    expect(grants.rows).not.toContainEqual({
      privilege_type: 'SELECT',
      table_name: 'economy_repair_plans',
    });
    await expect(
      app.pool.query(`update world_entities set state = '{"changed":true}' where world_id = $1`, [
        approvedA.worldId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query('update world_compilation_runs set input_hash = $2 where id = $1', [
        '038f0000-0000-7000-8000-000000000311',
        Buffer.alloc(32, 99),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
