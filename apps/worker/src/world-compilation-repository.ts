import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  canonicalJson,
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION,
  GOVERNANCE_COMPILER_VERSION,
  COMPILER_VERSION,
  PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION,
  PREVIOUS_COMPILER_VERSION,
  RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION,
  RETAINED_COMPILER_VERSION,
  type CompiledArtifactV2,
  type CompiledArtifactV3,
  type CompiledArtifactV4,
  type CompiledArtifactV5,
  type CompilerDiagnosticV1,
  type CompilerInputBundleV1,
  type GovernanceCompilerInputBundleV1,
  type PreviousCompilerInputBundleV1,
  type PrimitiveDraftInput,
  type RetainedCompilerInputBundleV1,
  type WorldManifestV1,
  type WorldRole,
} from '@worldgraph/contracts';
import { memberPrincipalKey, sha256Utf8 } from '@worldgraph/compiler';

export interface ClaimedWorldCompilation {
  attempts: number;
  claimToken: string;
  compilerConfigVersion: number;
  compilerVersion: string;
  inputHash: string;
  manifestContentHash: string;
  manifestRevisionId: string;
  progressPercent: number;
  queuedAt: Date;
  requestedByUserId: string;
  rowVersion: number;
  runId: string;
  seed: string;
  stage: 'compiling' | 'seeding' | 'validating';
  worldId: string;
}

export interface CompilationSourceMember {
  role: WorldRole;
  userId: string;
}

export interface CompilationSourcePrimitive {
  contentHash: string;
  definition: PrimitiveDraftInput;
  lifecycle: 'deprecated' | 'published';
  primitiveVersionId: string;
}

export interface WorldCompilationSource {
  manifest: WorldManifestV1;
  manifestContentHash: string;
  members: CompilationSourceMember[];
  primitives: CompilationSourcePrimitive[];
}

export interface WorldCompilationBacklog {
  oldestAgeMs: number;
  ready: number;
  running: number;
}

export interface WorldActivationResult {
  entityCount: number;
  lockWaitMs?: number;
  relationshipCount: number;
  serializationRetries?: number;
  worldVersionId: string;
}

export type ActivatableCompilerInputBundle =
  | CompilerInputBundleV1
  | GovernanceCompilerInputBundleV1
  | PreviousCompilerInputBundleV1
  | RetainedCompilerInputBundleV1;

export type ActivatableCompiledArtifact =
  CompiledArtifactV2 | CompiledArtifactV3 | CompiledArtifactV4 | CompiledArtifactV5;

/**
 * Persistence boundary used by the deterministic compiler runner. Keeping the
 * runner behind this narrow interface makes it possible to prove claim-loss
 * and input-mismatch behavior without weakening PostgreSQL authority in
 * production.
 */
export interface WorldCompilationRepository {
  activate(
    job: ClaimedWorldCompilation,
    bundle: ActivatableCompilerInputBundle,
    artifact: ActivatableCompiledArtifact,
    diagnostics: readonly CompilerDiagnosticV1[],
    nextId: () => string,
  ): Promise<WorldActivationResult | null>;
  claimNext(claimToken: string): Promise<ClaimedWorldCompilation | null>;
  heartbeat(job: ClaimedWorldCompilation): Promise<boolean>;
  inspectBacklog(): Promise<WorldCompilationBacklog>;
  isClaimCurrent(job: ClaimedWorldCompilation): Promise<boolean>;
  loadSource(job: ClaimedWorldCompilation): Promise<WorldCompilationSource | null>;
  markFailed(
    job: ClaimedWorldCompilation,
    diagnostics: readonly CompilerDiagnosticV1[],
  ): Promise<boolean>;
  recoverExpiredClaims(claimTimeoutMs: number): Promise<number>;
  updateStage(
    job: ClaimedWorldCompilation,
    stage: ClaimedWorldCompilation['stage'],
    progressPercent: number,
  ): Promise<ClaimedWorldCompilation | null>;
}

interface ClaimRow extends QueryResultRow {
  attempts: number;
  claim_token: string;
  compiler_config_version: number;
  compiler_version: string;
  input_hash: Buffer;
  manifest_content_hash: Buffer;
  manifest_revision_id: string;
  progress_percent: number;
  queued_at: Date;
  requested_by_user_id: string;
  row_version: number;
  seed: string;
  stage: ClaimedWorldCompilation['stage'];
  id: string;
  world_id: string;
}

function claimed(row: ClaimRow): ClaimedWorldCompilation {
  return {
    attempts: row.attempts,
    claimToken: row.claim_token,
    compilerConfigVersion: row.compiler_config_version,
    compilerVersion: row.compiler_version,
    inputHash: row.input_hash.toString('hex'),
    manifestContentHash: row.manifest_content_hash.toString('hex'),
    manifestRevisionId: row.manifest_revision_id,
    progressPercent: row.progress_percent,
    queuedAt: row.queued_at,
    requestedByUserId: row.requested_by_user_id,
    rowVersion: row.row_version,
    runId: row.id,
    seed: row.seed,
    stage: row.stage,
    worldId: row.world_id,
  };
}

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '40001'
  );
}

export class CompilationInputChangedError extends Error {
  public constructor() {
    super('The authoritative compiler input changed before atomic activation.');
    this.name = 'CompilationInputChangedError';
  }
}

async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  const batchSize = 250;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = batch.flat();
    const tuples = batch
      .map((_, rowIndex) => {
        const base = rowIndex * columns.length;
        return `(${columns.map((__, columnIndex) => `$${base + columnIndex + 1}`).join(',')})`;
      })
      .join(',');
    await client.query(`insert into ${table} (${columns.join(',')}) values ${tuples}`, values);
  }
}

interface CompiledSeedPlanActivationIdentity {
  compilationRunId: string;
  compiledArtifactId: string;
  worldId: string;
  worldVersionId: string;
}

/**
 * Persists the compiler-owned economy and governance seed sources through the
 * caller's activation transaction. Artifact 4 adds governance while retained
 * artifact 2 and previous artifact 3 continue to write only their sealed
 * economy-plan identities.
 */
export async function persistCompiledSeedPlansInActivationTransaction(
  client: Pick<PoolClient, 'query'>,
  identity: CompiledSeedPlanActivationIdentity,
  artifact: ActivatableCompiledArtifact,
  nextId: () => string,
): Promise<void> {
  const seedPlanSource =
    artifact.artifactSchemaVersion === RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION
      ? {
          adapterId: 'CompiledEconomySeedAdapterV1',
          compilerVersion: RETAINED_COMPILER_VERSION,
          planSchemaVersion: 1,
          sourceKind: 'compiler_1_1',
        }
      : {
          adapterId: 'CompiledEconomySeedAdapterV2',
          compilerVersion:
            artifact.artifactSchemaVersion === PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION
              ? PREVIOUS_COMPILER_VERSION
              : artifact.artifactSchemaVersion === GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION
                ? GOVERNANCE_COMPILER_VERSION
                : COMPILER_VERSION,
          planSchemaVersion: 2,
          sourceKind: 'compiler_1_2',
        };

  await client.query(
    `insert into compiled_economy_seed_plans(
       id, world_id, world_version_id, compilation_run_id, source_artifact_id,
       seed_plan_schema_version, source_kind, source_compiler_version,
       source_adapter_id, source_adapter_version, canonical_plan, plan_hash,
       source_artifact_hash
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,
       $9,'1.0.0',$10,decode($11,'hex'),decode($12,'hex')
     )`,
    [
      nextId(),
      identity.worldId,
      identity.worldVersionId,
      identity.compilationRunId,
      identity.compiledArtifactId,
      seedPlanSource.planSchemaVersion,
      seedPlanSource.sourceKind,
      seedPlanSource.compilerVersion,
      seedPlanSource.adapterId,
      JSON.stringify(artifact.world.economySeedPlan),
      artifact.world.economySeedPlanHash,
      artifact.contentHash,
    ],
  );

  if (
    artifact.artifactSchemaVersion !== COMPILED_ARTIFACT_SCHEMA_VERSION &&
    artifact.artifactSchemaVersion !== GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION
  ) {
    return;
  }
  if (!('governanceSeedPlan' in artifact.world) || !artifact.world.governanceSeedPlan) {
    return;
  }
  await client.query(
    `insert into compiled_governance_seed_plans(
       id, world_id, world_version_id, source_kind, source_compiler_version,
       source_artifact_hash, governance_seed_plan_schema_version, canonical_plan,
       plan_hash, adopted_command_id, adopted_event_id
     ) values (
       $1,$2,$3,'compiler_1_3',$4,decode($5,'hex'),1,$6,
       decode($7,'hex'),null,null
     )`,
    [
      nextId(),
      identity.worldId,
      identity.worldVersionId,
      artifact.artifactSchemaVersion === COMPILED_ARTIFACT_SCHEMA_VERSION
        ? COMPILER_VERSION
        : GOVERNANCE_COMPILER_VERSION,
      artifact.contentHash,
      JSON.stringify(artifact.world.governanceSeedPlan),
      artifact.world.governanceSeedPlanHash,
    ],
  );
}

export class PostgresWorldCompilationRepository implements WorldCompilationRepository {
  public constructor(private readonly pool: Pool) {}

  public async claimNext(claimToken: string): Promise<ClaimedWorldCompilation | null> {
    const result = await this.pool.query<ClaimRow>(
      `with candidate as (
         select id
           from world_compilation_runs
          where status = 'queued' and next_attempt_at <= now()
          order by next_attempt_at, queued_at, id
          for update skip locked
          limit 1
       )
       update world_compilation_runs run
          set status = 'running', stage = 'validating', progress_percent = 10,
              attempts = case when run.attempts = 0 then 1 else run.attempts end,
              claim_token = $1, claimed_at = now(), heartbeat_at = now(),
              started_at = now(), updated_at = now(), row_version = run.row_version + 1
         from candidate
        where run.id = candidate.id
       returning run.id, run.world_id, run.manifest_revision_id,
                 run.manifest_content_hash, run.input_hash, run.compiler_version,
                 run.compiler_config_version, run.seed, run.requested_by_user_id,
                 run.attempts, run.claim_token, run.stage, run.progress_percent,
                 run.queued_at, run.row_version`,
      [claimToken],
    );
    return result.rows[0] ? claimed(result.rows[0]) : null;
  }

  public async isClaimCurrent(job: ClaimedWorldCompilation): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from world_compilation_runs
        where id = $1 and world_id = $2 and status = 'running'
          and claim_token = $3 and input_hash = decode($4,'hex')`,
      [job.runId, job.worldId, job.claimToken, job.inputHash],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async heartbeat(job: ClaimedWorldCompilation): Promise<boolean> {
    const result = await this.pool.query(
      `update world_compilation_runs
          set heartbeat_at = now(), updated_at = now(), row_version = row_version + 1
        where id = $1 and world_id = $2 and status = 'running' and claim_token = $3`,
      [job.runId, job.worldId, job.claimToken],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async updateStage(
    job: ClaimedWorldCompilation,
    stage: ClaimedWorldCompilation['stage'],
    progressPercent: number,
  ): Promise<ClaimedWorldCompilation | null> {
    const result = await this.pool.query<ClaimRow>(
      `update world_compilation_runs
          set stage = $4, progress_percent = $5, heartbeat_at = now(),
              updated_at = now(), row_version = row_version + 1
        where id = $1 and world_id = $2 and status = 'running' and claim_token = $3
       returning id, world_id, manifest_revision_id, manifest_content_hash, input_hash,
                 compiler_version, compiler_config_version, seed, requested_by_user_id,
                 attempts, claim_token, stage, progress_percent, queued_at, row_version`,
      [job.runId, job.worldId, job.claimToken, stage, progressPercent],
    );
    return result.rows[0] ? claimed(result.rows[0]) : null;
  }

  public async loadSource(job: ClaimedWorldCompilation): Promise<WorldCompilationSource | null> {
    const revision = await this.pool.query<{
      canonical_manifest: WorldManifestV1;
      content_hash: Buffer;
    }>(
      `select revision.canonical_manifest, revision.content_hash
         from world_compilation_runs run
         join worlds world on world.id = run.world_id
         join manifest_revisions revision on revision.id = run.manifest_revision_id
          and revision.world_id = run.world_id
        where run.id = $1 and run.world_id = $2 and run.status = 'running'
          and run.claim_token = $3 and run.input_hash = decode($4,'hex')
          and world.lifecycle = 'compiling' and world.active_world_version_id is null
          and world.current_approved_manifest_revision_id = run.manifest_revision_id
          and revision.approval_status = 'approved'
          and revision.content_hash = run.manifest_content_hash`,
      [job.runId, job.worldId, job.claimToken, job.inputHash],
    );
    const source = revision.rows[0];
    if (!source) return null;
    const [primitives, members] = await Promise.all([
      this.loadPrimitives(source.canonical_manifest),
      this.pool.query<{ role: WorldRole; user_id: string }>(
        `select user_id, role
           from world_memberships
          where world_id = $1 and status = 'active'
          order by role::text collate "C", user_id`,
        [job.worldId],
      ),
    ]);
    if (!(await this.isClaimCurrent(job))) return null;
    return {
      manifest: source.canonical_manifest,
      manifestContentHash: source.content_hash.toString('hex'),
      members: members.rows.map((member) => ({ role: member.role, userId: member.user_id })),
      primitives,
    };
  }

  public async markFailed(
    job: ClaimedWorldCompilation,
    diagnostics: readonly CompilerDiagnosticV1[],
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select worldgraph_lock_world_compilation($1)', [job.worldId]);
      const result = await client.query(
        `update world_compilation_runs
            set status = 'failed', stage = 'failed',
                progress_percent = greatest(1, least(progress_percent, 99)),
                diagnostics = $4::jsonb, claim_token = null,
                completed_at = now(), updated_at = now(), row_version = row_version + 1
          where id = $1 and world_id = $2 and status = 'running' and claim_token = $3`,
        [job.runId, job.worldId, job.claimToken, JSON.stringify(diagnostics.slice(0, 128))],
      );
      if ((result.rowCount ?? 0) === 1) {
        await client.query(
          `update worlds
              set lifecycle = 'compile_failed', row_version = row_version + 1, updated_at = now()
            where id = $1 and lifecycle = 'compiling' and active_world_version_id is null`,
          [job.worldId],
        );
      }
      await client.query('commit');
      return (result.rowCount ?? 0) === 1;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async activate(
    job: ClaimedWorldCompilation,
    bundle: ActivatableCompilerInputBundle,
    artifact: ActivatableCompiledArtifact,
    diagnostics: readonly CompilerDiagnosticV1[],
    nextId: () => string,
  ): Promise<WorldActivationResult | null> {
    const retainedCompiler =
      job.compilerVersion === RETAINED_COMPILER_VERSION &&
      bundle.compilerVersion === RETAINED_COMPILER_VERSION &&
      artifact.artifactSchemaVersion === RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION &&
      artifact.world.compilerVersion === RETAINED_COMPILER_VERSION;
    const previousCompiler =
      job.compilerVersion === PREVIOUS_COMPILER_VERSION &&
      bundle.compilerVersion === PREVIOUS_COMPILER_VERSION &&
      artifact.artifactSchemaVersion === PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION &&
      artifact.world.compilerVersion === PREVIOUS_COMPILER_VERSION;
    const governanceCompiler =
      job.compilerVersion === GOVERNANCE_COMPILER_VERSION &&
      bundle.compilerVersion === GOVERNANCE_COMPILER_VERSION &&
      artifact.artifactSchemaVersion === GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION &&
      artifact.world.compilerVersion === GOVERNANCE_COMPILER_VERSION;
    const currentCompiler =
      job.compilerVersion === COMPILER_VERSION &&
      bundle.compilerVersion === COMPILER_VERSION &&
      artifact.artifactSchemaVersion === COMPILED_ARTIFACT_SCHEMA_VERSION &&
      artifact.world.compilerVersion === COMPILER_VERSION;
    if (!retainedCompiler && !previousCompiler && !governanceCompiler && !currentCompiler) {
      throw new Error('COMPILATION_ARTIFACT_VERSION_MISMATCH');
    }
    let lockWaitMs = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.pool.connect();
      try {
        // READ COMMITTED + SHARE table locks: wait for concurrent membership/
        // primitive writers, then observe their committed rows. SERIALIZABLE
        // snapshots can be assigned before a waited LOCK TABLE returns, which
        // would miss exactly the input change this gate must reject.
        await client.query('begin');
        const lockStarted = performance.now();
        await client.query('lock table world_memberships, primitive_versions in share mode');
        await client.query('select worldgraph_lock_world_compilation($1)', [job.worldId]);
        lockWaitMs += Math.max(0, performance.now() - lockStarted);
        const current = await client.query<{
          requested_by_user_id: string;
        }>(
          `select run.requested_by_user_id
             from world_compilation_runs run
             join worlds world on world.id = run.world_id
             join manifest_revisions revision on revision.id = run.manifest_revision_id
              and revision.world_id = run.world_id
            where run.id = $1 and run.world_id = $2 and run.status = 'running'
              and run.stage = 'seeding' and run.claim_token = $3
              and run.input_hash = decode($4,'hex')
              and run.manifest_content_hash = decode($5,'hex')
              and world.lifecycle = 'compiling' and world.active_world_version_id is null
              and world.current_approved_manifest_revision_id = run.manifest_revision_id
              and revision.approval_status = 'approved'
            for update of run, world, revision`,
          [job.runId, job.worldId, job.claimToken, bundle.inputHash, bundle.manifestContentHash],
        );
        const locked = current.rows[0];
        if (!locked) {
          const claim = await client.query(
            `select 1 from world_compilation_runs
              where id = $1 and world_id = $2 and status = 'running'
                and claim_token = $3 and input_hash = decode($4,'hex')
              for update`,
            [job.runId, job.worldId, job.claimToken, bundle.inputHash],
          );
          if ((claim.rowCount ?? 0) === 1) throw new CompilationInputChangedError();
          await client.query('rollback');
          return null;
        }

        // FOR UPDATE waits on concurrent membership writers even if a table
        // SHARE lock was compatible with an unexpected lock mode.
        const activeMembers = await client.query<{ role: WorldRole; user_id: string }>(
          `select user_id, role
             from world_memberships
            where world_id = $1 and status = 'active'
            order by role::text collate "C", user_id
            for update`,
          [job.worldId],
        );
        const currentMembers = activeMembers.rows
          .map((member) => ({
            principalKey: memberPrincipalKey(job.worldId, member.user_id),
            role: member.role,
            userId: member.user_id,
          }))
          .sort((left, right) =>
            left.principalKey < right.principalKey
              ? -1
              : left.principalKey > right.principalKey
                ? 1
                : 0,
          );
        const currentMemberDocument = canonicalJson(
          currentMembers.map(({ principalKey, role }) => ({ principalKey, role })),
        );
        const bundleMemberDocument = canonicalJson(bundle.activeMembers);
        if (currentMemberDocument !== bundleMemberDocument) {
          throw new CompilationInputChangedError();
        }
        const primitiveVersions = await client.query<{
          content_hash: Buffer | null;
          id: string;
          lifecycle: 'deprecated' | 'published';
        }>(
          `select id, lifecycle, content_hash
             from primitive_versions
            where id = any($1::uuid[])
            order by id
            for share`,
          [bundle.primitives.map((primitive) => primitive.primitiveVersionId)],
        );
        const expectedPrimitives = [...bundle.primitives]
          .map((primitive) => ({
            contentHash: primitive.contentHash,
            id: primitive.primitiveVersionId,
            lifecycle: primitive.lifecycle,
          }))
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        const currentPrimitives = primitiveVersions.rows.map((primitive) => ({
          contentHash: primitive.content_hash?.toString('hex') ?? null,
          id: primitive.id,
          lifecycle: primitive.lifecycle,
        }));
        if (canonicalJson(currentPrimitives) !== canonicalJson(expectedPrimitives)) {
          throw new CompilationInputChangedError();
        }

        const worldVersionId = nextId();
        const compiledArtifactId = nextId();
        const inputArtifactId = nextId();
        const visualArtifactId = nextId();
        const visualHash = sha256Utf8(canonicalJson(artifact.world.visualPlan));

        await insertRows(
          client,
          'compiled_world_artifacts',
          [
            'id',
            'world_id',
            'compilation_run_id',
            'artifact_kind',
            'artifact_schema_version',
            'canonical_content',
            'content_hash',
          ],
          [
            [
              inputArtifactId,
              job.worldId,
              job.runId,
              'compiler_input',
              1,
              JSON.stringify(bundle),
              Buffer.from(sha256Utf8(canonicalJson(bundle)), 'hex'),
            ],
            [
              compiledArtifactId,
              job.worldId,
              job.runId,
              'compiled_world',
              artifact.artifactSchemaVersion,
              JSON.stringify(artifact.world),
              Buffer.from(artifact.contentHash, 'hex'),
            ],
            [
              visualArtifactId,
              job.worldId,
              job.runId,
              'visual_plan',
              artifact.world.visualPlan.schemaVersion,
              JSON.stringify(artifact.world.visualPlan),
              Buffer.from(visualHash, 'hex'),
            ],
          ],
        );

        await client.query(
          `insert into world_versions
            (id, world_id, version_number, parent_world_version_id,
             manifest_revision_id, compilation_run_id, world_schema_version,
             compiler_version, compiler_config_version, seed, artifact_hash,
             status, created_by_user_id)
           values ($1,$2,1,null,$3,$4,1,$5,$6,$7,decode($8,'hex'),'staging',$9)`,
          [
            worldVersionId,
            job.worldId,
            job.manifestRevisionId,
            job.runId,
            job.compilerVersion,
            job.compilerConfigVersion,
            job.seed,
            artifact.contentHash,
            locked.requested_by_user_id,
          ],
        );

        await persistCompiledSeedPlansInActivationTransaction(
          client,
          {
            compilationRunId: job.runId,
            compiledArtifactId,
            worldId: job.worldId,
            worldVersionId,
          },
          artifact,
          nextId,
        );

        const entityIds = new Map<string, string>();
        const entityRows = artifact.world.entities.map((entity) => {
          const id = nextId();
          entityIds.set(entity.logicalKey, id);
          return [
            id,
            job.worldId,
            entity.logicalKey,
            entity.entityType,
            entity.entitySchemaVersion,
            JSON.stringify(entity.state),
            worldVersionId,
          ];
        });
        await insertRows(
          client,
          'world_entities',
          [
            'id',
            'world_id',
            'logical_key',
            'entity_type',
            'entity_schema_version',
            'state',
            'created_world_version_id',
          ],
          entityRows,
        );

        const relationshipRows = artifact.world.relationships.map((relationship) => {
          const sourceId = entityIds.get(relationship.sourceLogicalKey);
          const targetId = entityIds.get(relationship.targetLogicalKey);
          if (!sourceId || !targetId) throw new Error('COMPILER_DANGLING_RELATIONSHIP');
          return [
            nextId(),
            job.worldId,
            relationship.logicalKey,
            relationship.relationshipType,
            sourceId,
            targetId,
            relationship.relationshipSchemaVersion,
            JSON.stringify(relationship.attributes),
            worldVersionId,
          ];
        });
        await insertRows(
          client,
          'world_relationships',
          [
            'id',
            'world_id',
            'logical_key',
            'relationship_type',
            'source_entity_id',
            'target_entity_id',
            'relationship_schema_version',
            'attributes',
            'created_world_version_id',
          ],
          relationshipRows,
        );

        const usersByPrincipal = new Map(
          currentMembers.map((member) => [member.principalKey, member.userId]),
        );
        const controllerRows = artifact.world.controllers.map((controller) => {
          const userId = usersByPrincipal.get(controller.principalKey);
          const entityId = entityIds.get(controller.entityLogicalKey);
          if (!userId || !entityId) throw new Error('COMPILER_CONTROLLER_BINDING_INVALID');
          return [job.worldId, userId, entityId, controller.controlScope, worldVersionId];
        });
        await insertRows(
          client,
          'world_entity_controllers',
          ['world_id', 'user_id', 'entity_id', 'control_scope', 'granted_world_version_id'],
          controllerRows,
        );
        await client.query(
          `insert into world_runtime_heads
            (world_id, active_world_version_id, state_revision, last_ledger_sequence)
           values ($1,$2,0,0)`,
          [job.worldId, worldVersionId],
        );
        // The compiler is the sole non-command projection seed path. Before a
        // world can become active, bind that exact seeded graph to a truthful
        // immutable genesis event and ledger anchor in this same transaction.
        await client.query(
          `select * from worldgraph_append_compiled_genesis($1,$2,$3,$4,$5,$6,$7)`,
          [job.worldId, worldVersionId, job.runId, nextId(), nextId(), nextId(), nextId()],
        );
        await client.query(
          `update world_versions set status = 'active', activated_at = now()
            where id = $1 and world_id = $2 and status = 'staging'`,
          [worldVersionId, job.worldId],
        );
        await client.query(
          `update worlds
              set active_world_version_id = $2, lifecycle = 'active',
                  row_version = row_version + 1, updated_at = now()
            where id = $1 and lifecycle = 'compiling' and active_world_version_id is null`,
          [job.worldId, worldVersionId],
        );
        const completed = await client.query(
          `update world_compilation_runs
              set status = 'succeeded', stage = 'activated', progress_percent = 100,
                  artifact_hash = decode($4,'hex'), diagnostics = $5::jsonb,
                  claim_token = null, completed_at = now(), updated_at = now(),
                  row_version = row_version + 1
            where id = $1 and world_id = $2 and status = 'running' and claim_token = $3`,
          [
            job.runId,
            job.worldId,
            job.claimToken,
            artifact.contentHash,
            JSON.stringify(diagnostics.slice(0, 128)),
          ],
        );
        if ((completed.rowCount ?? 0) !== 1) throw new Error('COMPILATION_CLAIM_LOST');
        await client.query('commit');
        return {
          entityCount: artifact.world.entities.length,
          lockWaitMs,
          relationshipCount: artifact.world.relationships.length,
          serializationRetries: attempt,
          worldVersionId,
        };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if (isSerializationFailure(error) && attempt < 2) continue;
        throw error;
      } finally {
        client.release();
      }
    }
    return null;
  }

  public async recoverExpiredClaims(claimTimeoutMs: number): Promise<number> {
    const diagnostic: CompilerDiagnosticV1 = {
      code: 'COMPILATION_CLAIM_EXPIRED',
      message: 'The compilation worker lease expired before activation completed.',
      pointer: '',
      relatedKeys: [],
      retryable: true,
      severity: 'error',
      stage: 'emit',
    };
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const expired = await client.query<{ world_id: string }>(
        `update world_compilation_runs
            set status = 'failed', stage = 'failed',
                progress_percent = greatest(1, least(progress_percent, 99)),
                diagnostics = $2::jsonb, claim_token = null,
                completed_at = now(), updated_at = now(), row_version = row_version + 1
          where status = 'running'
            and heartbeat_at < now() - ($1::integer * interval '1 millisecond')
         returning world_id`,
        [claimTimeoutMs, JSON.stringify([diagnostic])],
      );
      const worldIds = [...new Set(expired.rows.map((row) => row.world_id))];
      if (worldIds.length > 0) {
        await client.query(
          `update worlds set lifecycle = 'compile_failed',
              row_version = row_version + 1, updated_at = now()
            where id = any($1::uuid[]) and lifecycle = 'compiling'
              and active_world_version_id is null`,
          [worldIds],
        );
      }
      await client.query('commit');
      return expired.rowCount ?? 0;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async inspectBacklog(): Promise<WorldCompilationBacklog> {
    const result = await this.pool.query<{
      oldest_age_ms: string | number | null;
      ready: string | number;
      running: string | number;
    }>(
      `select count(*) filter (where status = 'queued' and next_attempt_at <= now()) as ready,
              count(*) filter (where status = 'running') as running,
              extract(epoch from (now() - min(queued_at)
                filter (where status = 'queued'))) * 1000 as oldest_age_ms
         from world_compilation_runs
        where status in ('queued','running')`,
    );
    const row = result.rows[0];
    return {
      oldestAgeMs: Math.max(0, Number(row?.oldest_age_ms ?? 0)),
      ready: Number(row?.ready ?? 0),
      running: Number(row?.running ?? 0),
    };
  }

  private async loadPrimitives(manifest: WorldManifestV1): Promise<CompilationSourcePrimitive[]> {
    const requestedIds = [
      ...new Set(manifest.primitiveRefs.map((reference) => reference.primitiveVersionId)),
    ];
    const primitives = await this.pool.query<{
      behavior_ref: string | null;
      compatibility: PrimitiveDraftInput['compatibility'];
      content_hash: Buffer;
      defaults: PrimitiveDraftInput['defaults'];
      display_name: string;
      documentation: string;
      id: string;
      kind: PrimitiveDraftInput['kind'];
      lifecycle: 'deprecated' | 'published';
      parameter_schema: PrimitiveDraftInput['parameterSchema'];
      primitive_schema_version: 1;
      provenance: PrimitiveDraftInput['provenance'];
      semver: string;
      stable_key: string;
      visual_hints: PrimitiveDraftInput['visualHints'];
    }>(
      `with recursive closure(id) as (
         select unnest($1::uuid[])
         union
         select dependency.resolved_version_id
           from primitive_dependencies dependency
           join closure parent on parent.id = dependency.primitive_version_id
          where dependency.required and dependency.resolved_version_id is not null
       )
       select version.id, family.stable_key::text, family.kind, version.semver,
              version.primitive_schema_version, version.lifecycle, version.display_name,
              version.documentation, version.parameter_schema, version.defaults,
              version.compatibility, version.behavior_ref, version.visual_hints,
              version.provenance, version.content_hash
         from closure
         join primitive_versions version on version.id = closure.id
         join primitive_families family on family.id = version.family_id
        order by family.stable_key::text collate "C", version.semver collate "C", version.id`,
      [requestedIds],
    );
    const ids = primitives.rows.map((primitive) => primitive.id);
    const [tags, dependencies] = await Promise.all([
      this.pool.query<{ primitive_version_id: string; tag: string }>(
        `select primitive_version_id, tag::text
           from primitive_tags where primitive_version_id = any($1::uuid[])
          order by primitive_version_id, tag::text collate "C"`,
        [ids],
      ),
      this.pool.query<{
        dependency_key: string;
        parameter_mapping: Record<string, unknown>;
        primitive_version_id: string;
        required: boolean;
        version_range: string;
      }>(
        `select dependency.primitive_version_id, family.stable_key::text as dependency_key,
                dependency.version_range, dependency.required, dependency.parameter_mapping
           from primitive_dependencies dependency
           join primitive_families family on family.id = dependency.dependency_family_id
          where dependency.primitive_version_id = any($1::uuid[])
          order by dependency.primitive_version_id, family.stable_key::text collate "C"`,
        [ids],
      ),
    ]);
    return primitives.rows.map((primitive) => ({
      contentHash: primitive.content_hash.toString('hex'),
      definition: {
        behaviorRef: primitive.behavior_ref,
        compatibility: primitive.compatibility,
        defaults: primitive.defaults,
        dependencies: dependencies.rows
          .filter((dependency) => dependency.primitive_version_id === primitive.id)
          .map((dependency) => ({
            key: dependency.dependency_key,
            parameterMapping: dependency.parameter_mapping,
            required: dependency.required,
            versionRange: dependency.version_range,
          })),
        displayName: primitive.display_name,
        documentation: primitive.documentation,
        key: primitive.stable_key,
        kind: primitive.kind,
        parameterSchema: primitive.parameter_schema,
        primitiveSchemaVersion: primitive.primitive_schema_version,
        provenance: primitive.provenance,
        tags: tags.rows
          .filter((tag) => tag.primitive_version_id === primitive.id)
          .map((tag) => tag.tag),
        version: primitive.semver,
        visualHints: primitive.visual_hints,
      },
      lifecycle: primitive.lifecycle,
      primitiveVersionId: primitive.id,
    }));
  }
}
