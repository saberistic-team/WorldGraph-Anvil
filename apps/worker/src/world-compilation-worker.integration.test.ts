import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { HARBOR_CITY_ECONOMY_PRIMITIVES, STARTER_PRIMITIVES } from '@worldgraph/catalog';
import { compileWorld, createCompilerInputBundle, memberPrincipalKey } from '@worldgraph/compiler';
import {
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  COMPILER_VERSION,
  canonicalJson,
  type CompiledArtifactV3,
  type CompilerDiagnosticV1,
  type CompilerInputBundleV1,
} from '@worldgraph/contracts';
import { applyMigrations, createDatabaseClient, importStarterPrimitives } from '@worldgraph/db';
import {
  createDeterministicHarborCityFallback,
  harborCityManifestCatalog,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresWorldCompilationRepository,
  type ClaimedWorldCompilation,
  type WorldActivationResult,
} from './world-compilation-repository.js';
import { PostgresOutboxRepository, WORLD_HISTORY_CONSUMER } from './outbox-repository.js';
import { OutboxRunner } from './outbox-worker.js';
import {
  WorldCompilationRunner,
  type WorldCompilationMetrics,
} from './world-compilation-worker.js';

const migrationRoot = resolve('packages/db/drizzle');
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const creatorId = '068f0000-0000-7000-8000-000000000001';
const playerId = '068f0000-0000-7000-8000-000000000002';
const seed = 'worker-integration-seed';
const fallback = createDeterministicHarborCityFallback({
  catalog: harborCityManifestCatalog(),
  prompt:
    'A harbor city with guild workshops, iron and energy production, paid jobs, a fixed-price market, and public sales tax.',
  seed,
});
const pinnedPrimitiveKeys = new Set(
  fallback.envelope.manifest.primitiveRefs.map((entry) => entry.key),
);
const worlds = {
  duplicate: {
    revisionId: '068f0000-0000-7000-8000-000000000202',
    runId: '068f0000-0000-7000-8000-000000000302',
    worldId: '068f0000-0000-7000-8000-000000000102',
  },
  rollback: {
    revisionId: '068f0000-0000-7000-8000-000000000203',
    runId: '068f0000-0000-7000-8000-000000000303',
    worldId: '068f0000-0000-7000-8000-000000000103',
  },
  membershipChanged: {
    revisionId: '068f0000-0000-7000-8000-000000000204',
    runId: '068f0000-0000-7000-8000-000000000304',
    worldId: '068f0000-0000-7000-8000-000000000104',
  },
  recovery: {
    revisionId: '068f0000-0000-7000-8000-000000000205',
    runId: '068f0000-0000-7000-8000-000000000305',
    worldId: '068f0000-0000-7000-8000-000000000105',
  },
  cancellationRace: {
    revisionId: '068f0000-0000-7000-8000-000000000206',
    runId: '068f0000-0000-7000-8000-000000000306',
    worldId: '068f0000-0000-7000-8000-000000000106',
  },
  serializationRetry: {
    revisionId: '068f0000-0000-7000-8000-000000000207',
    runId: '068f0000-0000-7000-8000-000000000307',
    worldId: '068f0000-0000-7000-8000-000000000107',
  },
  entityRollback: {
    revisionId: '068f0000-0000-7000-8000-000000000208',
    runId: '068f0000-0000-7000-8000-000000000308',
    worldId: '068f0000-0000-7000-8000-000000000108',
  },
  relationshipRollback: {
    revisionId: '068f0000-0000-7000-8000-000000000209',
    runId: '068f0000-0000-7000-8000-000000000309',
    worldId: '068f0000-0000-7000-8000-000000000109',
  },
  primitiveChanged: {
    revisionId: '068f0000-0000-7000-8000-000000000210',
    runId: '068f0000-0000-7000-8000-000000000310',
    worldId: '068f0000-0000-7000-8000-000000000110',
  },
  success: {
    revisionId: '068f0000-0000-7000-8000-000000000201',
    runId: '068f0000-0000-7000-8000-000000000301',
    worldId: '068f0000-0000-7000-8000-000000000101',
  },
} as const;
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'world-compilation-integration-test',
});
const noOpMetrics: WorldCompilationMetrics = {
  recordArtifact: () => undefined,
  recordActivation: () => undefined,
  recordBacklog: () => undefined,
  recordIntegrityFinding: () => undefined,
  recordQueueLatency: () => undefined,
  recordRun: () => undefined,
  recordStage: () => undefined,
};

type QueryDelegate = (...arguments_: unknown[]) => Promise<unknown>;
type QueryInterceptor = (
  sql: string,
  query: QueryDelegate,
  arguments_: unknown[],
) => Promise<unknown>;

function interceptedPool(
  pool: Pool,
  interceptor: QueryInterceptor,
  applicationName?: string,
): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      if (applicationName) {
        await client.query("select set_config('application_name', $1, false)", [applicationName]);
      }
      return new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === 'query') {
            const query = (target.query as unknown as QueryDelegate).bind(target);
            return (...arguments_: unknown[]) =>
              interceptor(
                typeof arguments_[0] === 'string' ? arguments_[0] : '',
                query,
                arguments_,
              );
          }
          return typeof value === 'function'
            ? (value as (...arguments_: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
    query: pool.query.bind(pool),
  } as unknown as Pool;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for PostgreSQL race state.');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function within<T>(promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Concurrent operation deadlocked.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class CapturingActivationRepository extends PostgresWorldCompilationRepository {
  public error: unknown;

  public override async activate(
    job: ClaimedWorldCompilation,
    bundle: CompilerInputBundleV1,
    artifact: CompiledArtifactV3,
    diagnostics: readonly CompilerDiagnosticV1[],
    nextId: () => string,
  ): Promise<WorldActivationResult | null> {
    try {
      return await super.activate(job, bundle, artifact, diagnostics, nextId);
    } catch (error) {
      this.error = error;
      throw error;
    }
  }
}

function duplicateAtIdGenerator(failureCall: number, namespace: string) {
  let calls = 0;
  let previous = '';
  return {
    next(): string {
      calls += 1;
      if (calls === failureCall) return previous;
      previous = `068f0000-0000-7000-${namespace}-${String(calls).padStart(12, '0')}`;
      return previous;
    },
  };
}

function applicationUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'worldgraph_app';
  url.password = 'worldgraph_app_local_only';
  return url.toString();
}

function exactInput(worldId: string) {
  return createCompilerInputBundle({
    activeMembers: [
      { principalKey: memberPrincipalKey(worldId, creatorId), role: 'creator' },
      { principalKey: memberPrincipalKey(worldId, playerId), role: 'player' },
    ],
    compilerConfig: {
      adapterRegistryVersion: 1,
      deprecatedPrimitivePolicy: 'reject',
      maxEntities: 2_000,
      maxRelationships: 8_000,
    },
    manifest: fallback.envelope.manifest,
    primitives: [...STARTER_PRIMITIVES, ...HARBOR_CITY_ECONOMY_PRIMITIVES]
      .filter((primitive) => pinnedPrimitiveKeys.has(primitive.input.key))
      .map((primitive) => ({
        contentHash: primitive.contentHash,
        definition: primitive.input,
        lifecycle: 'published' as const,
        primitiveVersionId: primitive.versionId,
      })),
    seed,
  });
}

async function createApprovedWorld(
  pool: Pool,
  input: (typeof worlds)[keyof typeof worlds],
  ordinal: number,
): Promise<void> {
  const reportId = `068f0000-0000-7000-8000-0000000009${String(ordinal).padStart(2, '0')}`;
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    await connection.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,$2,$3,$4)`,
      [input.worldId, `compiled-worker-${ordinal}`, `Compiled Worker ${ordinal}`, creatorId],
    );
    await connection.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2),($1,$3,'player',$2)`,
      [input.worldId, creatorId, playerId],
    );
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }

  await pool.query(
    `insert into manifest_revisions(
       id,world_id,revision_number,manifest_schema_version,canonical_manifest,
       content_hash,source,created_by_user_id
     ) values ($1,$2,1,1,$3,decode($4,'hex'),'manual',$5)`,
    [
      input.revisionId,
      input.worldId,
      JSON.stringify(fallback.envelope.manifest),
      fallback.contentHash,
      creatorId,
    ],
  );
  await pool.query(
    `insert into manifest_validation_reports(
       id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
       valid,diagnostics,report_hash
     ) values ($1,$2,1,decode($3,'hex'),true,'[]'::jsonb,decode($4,'hex'))`,
    [reportId, input.revisionId, 'a'.repeat(64), 'b'.repeat(64)],
  );

  const approval = await pool.connect();
  try {
    await approval.query('begin');
    await approval.query(
      `update manifest_revisions
          set approval_status = 'approved', approved_by_user_id = $2,
              approved_at = now(), row_version = row_version + 1
        where id = $1`,
      [input.revisionId, creatorId],
    );
    await approval.query(
      `update worlds
          set current_approved_manifest_revision_id = $2, manifest_schema_version = 1,
              lifecycle = 'manifest_approved', row_version = row_version + 1,
              updated_at = now()
        where id = $1`,
      [input.worldId, input.revisionId],
    );
    await approval.query('commit');
  } catch (error) {
    await approval.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    approval.release();
  }
}

async function enqueue(
  pool: Pool,
  input: (typeof worlds)[keyof typeof worlds],
  ordinal: number,
): Promise<void> {
  const bundle = exactInput(input.worldId);
  expect(bundle.manifestCanonicalBytes).toBe(canonicalJson(fallback.envelope.manifest));
  expect(bundle.manifestContentHash).toBe(fallback.contentHash);
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    await connection.query(
      `insert into world_compilation_runs(
         id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
         compiler_version,compiler_config_version,seed,requested_by_user_id,idempotency_key
       ) values ($1,$2,$3,decode($4,'hex'),decode($5,'hex'),$6,1,$7,$8,$9)`,
      [
        input.runId,
        input.worldId,
        input.revisionId,
        bundle.manifestContentHash,
        bundle.inputHash,
        COMPILER_VERSION,
        seed,
        creatorId,
        `compilation-integration-${ordinal}`,
      ],
    );
    await connection.query(
      `update worlds
          set lifecycle = 'compiling', row_version = row_version + 1, updated_at = now()
        where id = $1`,
      [input.worldId],
    );
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function expectNoSeed(
  pool: Pool,
  input: (typeof worlds)[keyof typeof worlds],
  expected: { code: string; lifecycle?: string },
): Promise<void> {
  const state = await pool.query<{
    artifact_count: number;
    controller_count: number;
    diagnostics: CompilerDiagnosticV1[];
    entity_count: number;
    head_count: number;
    lifecycle: string;
    relationship_count: number;
    stage: string;
    status: string;
    version_count: number;
  }>(
    `select world.lifecycle, run.status, run.stage, run.diagnostics,
            (select count(*)::integer from compiled_world_artifacts artifact
              where artifact.compilation_run_id = run.id) as artifact_count,
            (select count(*)::integer from world_versions version
              where version.compilation_run_id = run.id) as version_count,
            (select count(*)::integer from world_entities entity
              where entity.world_id = world.id) as entity_count,
            (select count(*)::integer from world_relationships relationship
              where relationship.world_id = world.id) as relationship_count,
            (select count(*)::integer from world_entity_controllers controller
              where controller.world_id = world.id) as controller_count,
            (select count(*)::integer from world_runtime_heads head
              where head.world_id = world.id) as head_count
       from worlds world
       join world_compilation_runs run on run.world_id = world.id
      where world.id = $1 and run.id = $2`,
    [input.worldId, input.runId],
  );
  expect(state.rows[0]).toMatchObject({
    artifact_count: 0,
    controller_count: 0,
    entity_count: 0,
    head_count: 0,
    lifecycle: expected.lifecycle ?? 'compile_failed',
    relationship_count: 0,
    stage: 'failed',
    status: 'failed',
    version_count: 0,
  });
  expect(state.rows[0]?.diagnostics).toEqual([
    expect.objectContaining({
      code: expected.code,
      pointer: '',
      relatedKeys: [],
      severity: 'error',
    }),
  ]);
}

describe('PostgreSQL-authoritative world compilation worker', () => {
  let app: ReturnType<typeof createDatabaseClient>;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'compilation-worker-owner-test');
    await applyMigrations(owner, migrationRoot);
    await importStarterPrimitives(owner.pool);
    await owner.pool.query(
      `insert into users(id,email,password_hash,display_name) values
       ($1,'compilation-creator@example.test',$3,'Compilation Creator'),
       ($2,'compilation-player@example.test',$3,'Compilation Player')`,
      [creatorId, playerId, passwordHash],
    );
    await createApprovedWorld(owner.pool, worlds.success, 1);
    await createApprovedWorld(owner.pool, worlds.duplicate, 2);
    await createApprovedWorld(owner.pool, worlds.rollback, 3);
    await createApprovedWorld(owner.pool, worlds.membershipChanged, 4);
    await createApprovedWorld(owner.pool, worlds.recovery, 5);
    await createApprovedWorld(owner.pool, worlds.cancellationRace, 6);
    await createApprovedWorld(owner.pool, worlds.serializationRetry, 7);
    await createApprovedWorld(owner.pool, worlds.entityRollback, 8);
    await createApprovedWorld(owner.pool, worlds.relationshipRollback, 9);
    await createApprovedWorld(owner.pool, worlds.primitiveChanged, 10);
    await enqueue(owner.pool, worlds.success, 1);
    await enqueue(owner.pool, worlds.duplicate, 2);
    app = createDatabaseClient(
      applicationUrl(container.getConnectionUri()),
      'compilation-worker-app-test',
    );
  }, 120_000);

  afterAll(async () => {
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
  });

  it('atomically activates a verified graph with matching controller edges', async () => {
    const repository = new CapturingActivationRepository(app.pool);
    const runner = new WorldCompilationRunner(
      repository,
      logger,
      { maxEntities: 2_000, maxRelationships: 8_000 },
      { maximumRunsPerReconciliation: 1, metrics: noOpMetrics },
    );

    const result = await runner.runOne();
    expect(repository.error).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'succeeded' });

    const state = await owner.pool.query<{
      active_world_version_id: string;
      artifact_count: number;
      controller_count: number;
      controller_edge_count: number;
      compiled_artifact_has_native_seed_plan: boolean;
      compiled_artifact_schema_version: number;
      entity_count: number;
      lifecycle: string;
      native_seed_plan_count: number;
      relationship_count: number;
      run_artifact_hash: string;
      run_compiler_version: string;
      stage: string;
      status: string;
      version_id: string;
    }>(
      `select world.lifecycle, world.active_world_version_id,
              run.status, run.stage, run.compiler_version as run_compiler_version,
              encode(run.artifact_hash,'hex') as run_artifact_hash,
              version.id as version_id,
              (select artifact.artifact_schema_version
                 from compiled_world_artifacts artifact
                where artifact.compilation_run_id = run.id
                  and artifact.artifact_kind = 'compiled_world')
                as compiled_artifact_schema_version,
              (select artifact.canonical_content ? 'economySeedPlan'
                        and artifact.canonical_content ? 'economySeedPlanHash'
                 from compiled_world_artifacts artifact
                where artifact.compilation_run_id = run.id
                  and artifact.artifact_kind = 'compiled_world')
                as compiled_artifact_has_native_seed_plan,
              (select count(*)::integer from compiled_economy_seed_plans plan
                where plan.compilation_run_id = run.id
                  and plan.source_kind = 'compiler_1_2'
                  and plan.source_compiler_version = $3) as native_seed_plan_count,
              (select count(*)::integer from compiled_world_artifacts artifact
                where artifact.compilation_run_id = run.id) as artifact_count,
              (select count(*)::integer from world_entities entity
                where entity.world_id = world.id) as entity_count,
              (select count(*)::integer from world_relationships relationship
                where relationship.world_id = world.id) as relationship_count,
              (select count(*)::integer from world_entity_controllers controller
                where controller.world_id = world.id and controller.revoked_at is null)
                as controller_count,
              (select count(*)::integer
                 from world_entity_controllers controller
                 join world_relationships relationship
                   on relationship.world_id = controller.world_id
                  and relationship.target_entity_id = controller.entity_id
                  and relationship.relationship_type = 'account_controls'
                  and relationship.retired_world_version_id is null
                where controller.world_id = world.id and controller.revoked_at is null)
                as controller_edge_count
         from worlds world
         join world_compilation_runs run on run.world_id = world.id
         join world_versions version on version.compilation_run_id = run.id
         join world_runtime_heads head on head.world_id = world.id
          and head.active_world_version_id = version.id
        where world.id = $1 and run.id = $2`,
      [worlds.success.worldId, worlds.success.runId, COMPILER_VERSION],
    );
    expect(state.rows[0]).toMatchObject({
      artifact_count: 3,
      compiled_artifact_has_native_seed_plan: true,
      compiled_artifact_schema_version: COMPILED_ARTIFACT_SCHEMA_VERSION,
      controller_count: 2,
      controller_edge_count: 2,
      lifecycle: 'active',
      native_seed_plan_count: 1,
      stage: 'activated',
      status: 'succeeded',
    });
    expect(state.rows[0]!.active_world_version_id).toBe(state.rows[0]!.version_id);
    expect(state.rows[0]!.run_compiler_version).toBe(COMPILER_VERSION);
    expect(state.rows[0]!.entity_count).toBeGreaterThan(0);
    expect(state.rows[0]!.relationship_count).toBeGreaterThan(0);
    expect(state.rows[0]!.run_artifact_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('allows one concurrent claimant and rejects every operation from the lost claim', async () => {
    const first = new PostgresWorldCompilationRepository(app.pool);
    const second = new PostgresWorldCompilationRepository(app.pool);
    const tokenA = '068f0000-0000-7000-8000-000000000401';
    const tokenB = '068f0000-0000-7000-8000-000000000402';
    const claims = await Promise.all([first.claimNext(tokenA), second.claimNext(tokenB)]);
    const winner = claims.find((claim) => claim?.runId === worlds.duplicate.runId);
    expect(claims.filter((claim) => claim?.runId === worlds.duplicate.runId)).toHaveLength(1);
    expect(winner).toBeDefined();

    await owner.pool.query(
      `update world_compilation_runs
          set status = 'cancelled', stage = 'cancelled', progress_percent = 100,
              claim_token = null, completed_at = now(), updated_at = now(),
              row_version = row_version + 1
        where id = $1 and status = 'running'`,
      [worlds.duplicate.runId],
    );
    await owner.pool.query(
      `update worlds
          set lifecycle = 'manifest_approved', row_version = row_version + 1, updated_at = now()
        where id = $1`,
      [worlds.duplicate.worldId],
    );

    await expect(first.isClaimCurrent(winner!)).resolves.toBe(false);
    await expect(first.updateStage(winner!, 'compiling', 45)).resolves.toBeNull();
  });

  it('rolls back every artifact and graph row when activation fails after seeding begins', async () => {
    const duplicateId = '068f0000-0000-7000-8000-000000000499';
    await enqueue(owner.pool, worlds.rollback, 3);
    const runner = new WorldCompilationRunner(
      new PostgresWorldCompilationRepository(app.pool),
      logger,
      { maxEntities: 2_000, maxRelationships: 8_000 },
      {
        ids: { next: () => duplicateId },
        maximumRunsPerReconciliation: 1,
        metrics: noOpMetrics,
      },
    );

    await expect(runner.runOne()).resolves.toMatchObject({
      code: 'WORKER_EXECUTION_FAILED',
      outcome: 'failed',
    });

    const state = await owner.pool.query<{
      artifact_count: number;
      controller_count: number;
      entity_count: number;
      head_count: number;
      lifecycle: string;
      relationship_count: number;
      stage: string;
      status: string;
      version_count: number;
    }>(
      `select world.lifecycle, run.status, run.stage,
              (select count(*)::integer from compiled_world_artifacts artifact
                where artifact.compilation_run_id = run.id) as artifact_count,
              (select count(*)::integer from world_versions version
                where version.compilation_run_id = run.id) as version_count,
              (select count(*)::integer from world_entities entity
                where entity.world_id = world.id) as entity_count,
              (select count(*)::integer from world_relationships relationship
                where relationship.world_id = world.id) as relationship_count,
              (select count(*)::integer from world_entity_controllers controller
                where controller.world_id = world.id) as controller_count,
              (select count(*)::integer from world_runtime_heads head
                where head.world_id = world.id) as head_count
         from worlds world
         join world_compilation_runs run on run.world_id = world.id
        where world.id = $1 and run.id = $2`,
      [worlds.rollback.worldId, worlds.rollback.runId],
    );
    expect(state.rows[0]).toEqual({
      artifact_count: 0,
      controller_count: 0,
      entity_count: 0,
      head_count: 0,
      lifecycle: 'compile_failed',
      relationship_count: 0,
      stage: 'failed',
      status: 'failed',
      version_count: 0,
    });
  });

  it('waits for a membership writer, observes its commit, and fails sanitized with no seed', async () => {
    await enqueue(owner.pool, worlds.membershipChanged, 4);
    const writer = await owner.pool.connect();
    let activation: Promise<Awaited<ReturnType<WorldCompilationRunner['runOne']>>> | undefined;
    let writerCommitted = false;
    try {
      await writer.query('begin');
      await writer.query(
        `update world_memberships
            set role = 'observer', row_version = row_version + 1, updated_at = now()
          where world_id = $1 and user_id = $2 and status = 'active'`,
        [worlds.membershipChanged.worldId, playerId],
      );
      const racePool = interceptedPool(
        app.pool,
        (_sql, query, arguments_) => query(...arguments_),
        'm5-membership-writer-first',
      );
      const runner = new WorldCompilationRunner(
        new PostgresWorldCompilationRepository(racePool),
        logger,
        { maxEntities: 2_000, maxRelationships: 8_000 },
        { maximumRunsPerReconciliation: 1, metrics: noOpMetrics },
      );
      activation = runner.runOne();
      await waitFor(async () => {
        const waiting = await owner.pool.query<{ waiting: boolean }>(
          `select exists(
             select 1 from pg_stat_activity
              where application_name = 'm5-membership-writer-first'
                and wait_event_type = 'Lock'
                and query ilike 'lock table world_memberships%'
           ) as waiting`,
        );
        return waiting.rows[0]?.waiting ?? false;
      });

      await writer.query('commit');
      writerCommitted = true;
      await expect(within(activation)).resolves.toMatchObject({
        code: 'COMPILATION_INPUT_CHANGED',
        outcome: 'failed',
      });
      await expectNoSeed(owner.pool, worlds.membershipChanged, {
        code: 'COMPILATION_INPUT_CHANGED',
      });
      const diagnostics = await owner.pool.query<{ diagnostics: CompilerDiagnosticV1[] }>(
        'select diagnostics from world_compilation_runs where id = $1',
        [worlds.membershipChanged.runId],
      );
      expect(diagnostics.rows[0]?.diagnostics).toEqual([
        {
          code: 'COMPILATION_INPUT_CHANGED',
          message: 'The exact authoritative compiler input changed before activation.',
          pointer: '',
          relatedKeys: [],
          retryable: false,
          severity: 'error',
          stage: 'validate',
        },
      ]);
      expect(JSON.stringify(diagnostics.rows[0]?.diagnostics)).not.toContain(playerId);
      expect(JSON.stringify(diagnostics.rows[0]?.diagnostics)).not.toContain(
        worlds.membershipChanged.worldId,
      );
    } finally {
      if (!writerCommitted) await writer.query('rollback').catch(() => undefined);
      writer.release();
      await activation?.catch(() => undefined);
    }
  });

  it('recovers an expired claim to a terminal failure without leaving seed rows', async () => {
    await enqueue(owner.pool, worlds.recovery, 5);
    const repository = new PostgresWorldCompilationRepository(app.pool);
    const claimed = await repository.claimNext('068f0000-0000-7000-8000-000000000405');
    expect(claimed).toMatchObject({ runId: worlds.recovery.runId, stage: 'validating' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));

    await expect(repository.recoverExpiredClaims(1)).resolves.toBe(1);
    await expectNoSeed(owner.pool, worlds.recovery, {
      code: 'COMPILATION_CLAIM_EXPIRED',
    });
    await expect(repository.isClaimCurrent(claimed!)).resolves.toBe(false);
  });

  it('serializes a late cancellation behind activation without deadlock or a second terminal outcome', async () => {
    await enqueue(owner.pool, worlds.cancellationRace, 6);
    const advisoryAcquired = deferred();
    const continueActivation = deferred();
    let paused = false;
    const racePool = interceptedPool(app.pool, async (sql, query, arguments_) => {
      const result = await query(...arguments_);
      if (!paused && sql.includes('select worldgraph_lock_world_compilation')) {
        paused = true;
        advisoryAcquired.resolve();
        await continueActivation.promise;
      }
      return result;
    });
    const runner = new WorldCompilationRunner(
      new PostgresWorldCompilationRepository(racePool),
      logger,
      { maxEntities: 2_000, maxRelationships: 8_000 },
      { maximumRunsPerReconciliation: 1, metrics: noOpMetrics },
    );
    const activation = runner.runOne();
    await advisoryAcquired.promise;

    const cancellation = (async () => {
      const client = await owner.pool.connect();
      try {
        await client.query("set application_name = 'm5-late-compilation-cancel'");
        await client.query('begin');
        await client.query("set local lock_timeout = '8s'");
        await client.query('select worldgraph_lock_world_compilation($1)', [
          worlds.cancellationRace.worldId,
        ]);
        const current = await client.query<{ stage: string; status: string }>(
          `select stage::text, status::text
             from world_compilation_runs
            where id = $1 and world_id = $2
            for update`,
          [worlds.cancellationRace.runId, worlds.cancellationRace.worldId],
        );
        if (
          current.rows[0]?.status === 'running' &&
          ['queued', 'validating', 'compiling'].includes(current.rows[0].stage)
        ) {
          await client.query(
            `update world_compilation_runs
                set status = 'cancelled', stage = 'cancelled', progress_percent = 100,
                    claim_token = null, completed_at = now(), updated_at = now(),
                    row_version = row_version + 1
              where id = $1`,
            [worlds.cancellationRace.runId],
          );
        }
        await client.query('commit');
        return current.rows[0];
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    })();

    await waitFor(async () => {
      const waiting = await owner.pool.query<{ waiting: boolean }>(
        `select exists(
           select 1 from pg_stat_activity
            where application_name = 'm5-late-compilation-cancel'
              and wait_event_type = 'Lock'
         ) as waiting`,
      );
      return waiting.rows[0]?.waiting ?? false;
    });
    continueActivation.resolve();

    const [activationResult, cancellationView] = await within(
      Promise.all([activation, cancellation]),
    );
    expect(activationResult).toMatchObject({ outcome: 'succeeded' });
    expect(cancellationView).toEqual({ stage: 'activated', status: 'succeeded' });
    const terminal = await owner.pool.query<{
      active_versions: number;
      cancelled_runs: number;
      succeeded_runs: number;
    }>(
      `select
         (select count(*)::integer from world_versions
           where world_id = $1 and status = 'active') as active_versions,
         (select count(*)::integer from world_compilation_runs
           where world_id = $1 and status = 'cancelled') as cancelled_runs,
         (select count(*)::integer from world_compilation_runs
           where world_id = $1 and status = 'succeeded') as succeeded_runs`,
      [worlds.cancellationRace.worldId],
    );
    expect(terminal.rows[0]).toEqual({
      active_versions: 1,
      cancelled_runs: 0,
      succeeded_runs: 1,
    });
  });

  it('retries a simulated serialization failure after partial seeding and activates exactly once', async () => {
    await enqueue(owner.pool, worlds.serializationRetry, 7);
    let faulted = false;
    const retryPool = interceptedPool(app.pool, async (sql, query, arguments_) => {
      if (
        !faulted &&
        sql.includes('update worlds') &&
        sql.includes('active_world_version_id = $2')
      ) {
        faulted = true;
        throw Object.assign(new Error('forced serialization retry'), { code: '40001' });
      }
      return query(...arguments_);
    });
    const activations: { retries: number }[] = [];
    const metrics: WorldCompilationMetrics = {
      ...noOpMetrics,
      recordActivation: (_lockWaitMs, retries) => void activations.push({ retries }),
    };
    const runner = new WorldCompilationRunner(
      new PostgresWorldCompilationRepository(retryPool),
      logger,
      { maxEntities: 2_000, maxRelationships: 8_000 },
      { maximumRunsPerReconciliation: 1, metrics },
    );

    await expect(runner.runOne()).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(faulted).toBe(true);
    expect(activations).toEqual([{ retries: 1 }]);
    const expected = compileWorld(exactInput(worlds.serializationRetry.worldId)).artifact;
    expect(expected).toBeDefined();
    const state = await owner.pool.query<{
      active_versions: number;
      artifact_count: number;
      entity_count: number;
      head_count: number;
      relationship_count: number;
      staging_versions: number;
      version_count: number;
    }>(
      `select
         (select count(*)::integer from compiled_world_artifacts
           where compilation_run_id = $2) as artifact_count,
         (select count(*)::integer from world_versions
           where compilation_run_id = $2) as version_count,
         (select count(*)::integer from world_versions
           where compilation_run_id = $2 and status = 'active') as active_versions,
         (select count(*)::integer from world_versions
           where compilation_run_id = $2 and status = 'staging') as staging_versions,
         (select count(*)::integer from world_entities where world_id = $1) as entity_count,
         (select count(*)::integer from world_relationships where world_id = $1)
           as relationship_count,
         (select count(*)::integer from world_runtime_heads where world_id = $1) as head_count`,
      [worlds.serializationRetry.worldId, worlds.serializationRetry.runId],
    );
    expect(state.rows[0]).toEqual({
      active_versions: 1,
      artifact_count: 3,
      entity_count: expected!.world.entities.length,
      head_count: 1,
      relationship_count: expected!.world.relationships.length,
      staging_versions: 0,
      version_count: 1,
    });
  });

  it.each([
    {
      failureCall: 9,
      input: worlds.entityRollback,
      namespace: '8108',
      ordinal: 8,
      phase: 'entity insertion',
    },
    {
      failureCall:
        9 +
        (compileWorld(exactInput(worlds.relationshipRollback.worldId)).artifact?.world.entities
          .length ?? 0),
      input: worlds.relationshipRollback,
      namespace: '8109',
      ordinal: 9,
      phase: 'relationship insertion',
    },
  ])('rolls back artifacts, version, and graph after duplicate ID at $phase', async (testCase) => {
    await enqueue(owner.pool, testCase.input, testCase.ordinal);
    const runner = new WorldCompilationRunner(
      new PostgresWorldCompilationRepository(app.pool),
      logger,
      { maxEntities: 2_000, maxRelationships: 8_000 },
      {
        ids: duplicateAtIdGenerator(testCase.failureCall, testCase.namespace),
        maximumRunsPerReconciliation: 1,
        metrics: noOpMetrics,
      },
    );

    await expect(runner.runOne()).resolves.toMatchObject({
      code: 'WORKER_EXECUTION_FAILED',
      outcome: 'failed',
    });
    await expectNoSeed(owner.pool, testCase.input, { code: 'WORKER_EXECUTION_FAILED' });
  });

  it('waits for a primitive writer, observes its commit, and fails sanitized with no seed', async () => {
    await enqueue(owner.pool, worlds.primitiveChanged, 10);
    const changedPrimitiveId = STARTER_PRIMITIVES[0]!.versionId;
    const writer = await owner.pool.connect();
    let activation: Promise<Awaited<ReturnType<WorldCompilationRunner['runOne']>>> | undefined;
    let writerCommitted = false;
    try {
      await writer.query('begin');
      await writer.query(
        `update primitive_versions
            set lifecycle = 'deprecated', deprecated_by_user_id = $2,
                deprecated_at = now(), deprecation_reason = 'Deprecated during activation race.',
                row_version = row_version + 1, updated_at = now()
          where id = $1 and lifecycle = 'published'`,
        [changedPrimitiveId, creatorId],
      );
      const racePool = interceptedPool(
        app.pool,
        (_sql, query, arguments_) => query(...arguments_),
        'm5-primitive-writer-first',
      );
      const runner = new WorldCompilationRunner(
        new PostgresWorldCompilationRepository(racePool),
        logger,
        { maxEntities: 2_000, maxRelationships: 8_000 },
        { maximumRunsPerReconciliation: 1, metrics: noOpMetrics },
      );
      activation = runner.runOne();
      await waitFor(async () => {
        const waiting = await owner.pool.query<{ waiting: boolean }>(
          `select exists(
             select 1 from pg_stat_activity
              where application_name = 'm5-primitive-writer-first'
                and wait_event_type = 'Lock'
                and query ilike 'lock table world_memberships%'
           ) as waiting`,
        );
        return waiting.rows[0]?.waiting ?? false;
      });

      await writer.query('commit');
      writerCommitted = true;
      await expect(within(activation)).resolves.toMatchObject({
        code: 'COMPILATION_INPUT_CHANGED',
        outcome: 'failed',
      });
      await expectNoSeed(owner.pool, worlds.primitiveChanged, {
        code: 'COMPILATION_INPUT_CHANGED',
      });
      const diagnostics = await owner.pool.query<{ diagnostics: CompilerDiagnosticV1[] }>(
        'select diagnostics from world_compilation_runs where id = $1',
        [worlds.primitiveChanged.runId],
      );
      expect(diagnostics.rows[0]?.diagnostics).toEqual([
        {
          code: 'COMPILATION_INPUT_CHANGED',
          message: 'The exact authoritative compiler input changed before activation.',
          pointer: '',
          relatedKeys: [],
          retryable: false,
          severity: 'error',
          stage: 'validate',
        },
      ]);
      expect(JSON.stringify(diagnostics.rows[0]?.diagnostics)).not.toContain(changedPrimitiveId);
    } finally {
      if (!writerCommitted) await writer.query('rollback').catch(() => undefined);
      writer.release();
      await activation?.catch(() => undefined);
    }
  });

  it('dispatches the genesis outbox idempotently and fences leases, retries, and dead letters', async () => {
    const repository = new PostgresOutboxRepository(app.pool);
    const dispatched = await new OutboxRunner(repository, 'outbox-worker-a', logger, {
      batchSize: 50,
      leaseMs: 1_000,
      maximumAttempts: 3,
      retryBaseMs: 100,
    }).reconcile();
    const genesis = dispatched.find((result) => result.message?.worldId === worlds.success.worldId);
    expect(genesis).toMatchObject({ outcome: 'published' });
    expect(genesis?.message && (await repository.publish(genesis.message, 'outbox-worker-a'))).toBe(
      false,
    );

    const projected = await owner.pool.query<{
      history_count: string;
      receipt_count: string;
      status: string;
    }>(
      `select message.status,
        (select count(*)::text from world_history_entries history
          where history.world_id=$1 and history.event_id=message.event_id) history_count,
        (select count(*)::text from event_consumer_receipts receipt
          where receipt.consumer_name=$2 and receipt.event_id=message.event_id) receipt_count
       from outbox_messages message
       where message.id=$3`,
      [worlds.success.worldId, WORLD_HISTORY_CONSUMER, genesis!.message!.id],
    );
    expect(projected.rows[0]).toEqual({
      history_count: '1',
      receipt_count: '1',
      status: 'published',
    });

    const deadId = '068f0000-0000-7000-8000-000000000901';
    await owner.pool.query(
      `insert into outbox_messages(id,world_id,message_type,message_schema_version,payload)
       values ($1,$2,'UnregisteredMessageV1',1,'{}'::jsonb)`,
      [deadId, worlds.success.worldId],
    );
    const dead = await new OutboxRunner(repository, 'outbox-worker-dead', logger, {
      batchSize: 1,
      leaseMs: 1_000,
      maximumAttempts: 1,
      retryBaseMs: 100,
    }).reconcile();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ outcome: 'dead' });
    expect(dead[0]?.message).toMatchObject({ id: deadId });

    const leaseId = '068f0000-0000-7000-8000-000000000902';
    await owner.pool.query(
      `with ready as (
         select clock_timestamp()-interval '10 seconds' as at
       ) insert into outbox_messages(
         id,world_id,message_type,message_schema_version,payload,available_at,created_at
       ) select
         $1,$2,'UnregisteredMessageV2',1,'{}'::jsonb,
         ready.at,ready.at
       from ready`,
      [leaseId, worlds.success.worldId],
    );
    const firstClaim = (await repository.claim('outbox-worker-lease-a', 1, 1_000))[0]!;
    expect(firstClaim.id).toBe(leaseId);
    await owner.pool.query(
      `update outbox_messages set locked_at=created_at+interval '1 second' where id=$1`,
      [leaseId],
    );
    const reclaimed = (await repository.claim('outbox-worker-lease-b', 1, 1_000))[0]!;
    expect(reclaimed).toMatchObject({ attempts: 2, id: leaseId });
    await expect(repository.publish(firstClaim, 'outbox-worker-lease-a')).resolves.toBe(false);
    await expect(repository.markFailed(reclaimed, 'outbox-worker-lease-b', 2, 100)).resolves.toBe(
      'dead',
    );
    await expect(repository.inspectBacklog()).resolves.toMatchObject({ dead: 2 });
  });
});
