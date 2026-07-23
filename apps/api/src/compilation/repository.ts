import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type { WorldManifestV1, WorldRole } from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';

interface Executor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface CompilationCommandIdentity {
  actorId: string;
  expiresAt: Date;
  key: string;
  requestHash: Buffer;
  scope: string;
}

export type CompilationIdempotencyStart =
  { kind: 'new' } | { body: Record<string, unknown>; kind: 'replay'; status: number };

export interface CompilationWorldAccess {
  activeWorldVersionId: string | null;
  currentApprovedManifestRevisionId: string | null;
  lifecycle: 'active' | 'compile_failed' | 'compiling' | 'draft' | 'manifest_approved';
  manifestSchemaVersion: number | null;
  name: string;
  role: WorldRole;
  rowVersion: number;
  worldId: string;
}

export interface ApprovedManifestRecord {
  approvalStatus: 'approved' | 'draft' | 'rejected' | 'superseded';
  contentHash: string;
  manifest: WorldManifestV1;
  manifestSchemaVersion: number;
  revisionId: string;
  revisionNumber: number;
  worldId: string;
}

export interface CompilationPrimitiveDependencyRecord {
  contentHash: string | null;
  familyKey: string;
  parameterMapping: Record<string, unknown>;
  required: boolean;
  versionId: string | null;
  versionRange: string;
}

export interface CompilationPrimitiveRecord {
  behaviorRef: string | null;
  compatibility: Record<string, unknown>;
  contentHash: string;
  defaults: Record<string, unknown>;
  dependencies: CompilationPrimitiveDependencyRecord[];
  displayName: string;
  documentation: string;
  key: string;
  kind: string;
  lifecycle: 'deprecated' | 'published';
  parameterSchema: Record<string, unknown>;
  primitiveSchemaVersion: number;
  provenance: Record<string, unknown>;
  tags: string[];
  version: string;
  versionId: string;
  visualHints: Record<string, unknown>;
}

export interface CompilationMemberRecord {
  role: WorldRole;
  userId: string;
}

export interface CompilationRunRecord {
  artifactHash: string | null;
  attempts: number;
  completedAt: Date | null;
  compilerConfigVersion: number;
  compilerVersion: string;
  diagnostics: unknown[];
  heartbeatAt: Date | null;
  id: string;
  inputHash: string;
  manifestContentHash: string;
  manifestRevisionId: string;
  nextAttemptAt: Date;
  progressPercent: number;
  queuedAt: Date;
  requestedByUserId: string;
  rowVersion: number;
  seed: string;
  stage: 'activated' | 'cancelled' | 'compiling' | 'failed' | 'queued' | 'seeding' | 'validating';
  startedAt: Date | null;
  status: 'cancelled' | 'failed' | 'queued' | 'running' | 'succeeded';
  updatedAt: Date;
  worldId: string;
}

export interface CompiledArtifactRecord extends QueryResultRow {
  artifact_schema_version: number;
  canonical_content: unknown;
  content_hash: string;
  input_hash: string;
}

interface CompilationRunRow extends QueryResultRow {
  artifact_hash: Buffer | null;
  attempts: number;
  completed_at: Date | null;
  compiler_config_version: number;
  compiler_version: string;
  diagnostics: unknown[];
  heartbeat_at: Date | null;
  id: string;
  input_hash: Buffer;
  manifest_content_hash: Buffer;
  manifest_revision_id: string;
  next_attempt_at: Date;
  progress_percent: number;
  queued_at: Date;
  requested_by_user_id: string;
  row_version: number;
  seed: string;
  stage: CompilationRunRecord['stage'];
  started_at: Date | null;
  status: CompilationRunRecord['status'];
  updated_at: Date;
  world_id: string;
}

const runColumns = `
  id, world_id, manifest_revision_id, manifest_content_hash, input_hash,
  compiler_version, compiler_config_version, seed, status, stage, progress_percent,
  requested_by_user_id, diagnostics, artifact_hash, attempts, next_attempt_at,
  queued_at, started_at, completed_at, heartbeat_at, updated_at, row_version`;

function runRecord(row: CompilationRunRow): CompilationRunRecord {
  return {
    artifactHash: row.artifact_hash?.toString('hex') ?? null,
    attempts: row.attempts,
    completedAt: row.completed_at,
    compilerConfigVersion: row.compiler_config_version,
    compilerVersion: row.compiler_version,
    diagnostics: row.diagnostics,
    heartbeatAt: row.heartbeat_at,
    id: row.id,
    inputHash: row.input_hash.toString('hex'),
    manifestContentHash: row.manifest_content_hash.toString('hex'),
    manifestRevisionId: row.manifest_revision_id,
    nextAttemptAt: row.next_attempt_at,
    progressPercent: row.progress_percent,
    queuedAt: row.queued_at,
    requestedByUserId: row.requested_by_user_id,
    rowVersion: row.row_version,
    seed: row.seed,
    stage: row.stage,
    startedAt: row.started_at,
    status: row.status,
    updatedAt: row.updated_at,
    worldId: row.world_id,
  };
}

export class CompilationRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  public async transaction<T>(
    operation: (repository: CompilationRepository) => Promise<T>,
  ): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await operation(new CompilationRepository(this.pool, client));
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async lockWorldCompilation(worldId: string): Promise<void> {
    await this.executor.query('select worldgraph_lock_world_compilation($1)', [worldId]);
  }

  public async getWorldAccess(
    actorUserId: string,
    worldId: string,
    lock = false,
  ): Promise<CompilationWorldAccess | null> {
    const result = await this.executor.query<{
      active_world_version_id: string | null;
      current_approved_manifest_revision_id: string | null;
      lifecycle: CompilationWorldAccess['lifecycle'];
      manifest_schema_version: number | null;
      name: string;
      role: WorldRole;
      row_version: number;
      world_id: string;
    }>(
      `select w.id as world_id, w.name, w.lifecycle, w.row_version,
              w.current_approved_manifest_revision_id, w.active_world_version_id,
              w.manifest_schema_version, membership.role
         from worlds w
         join world_memberships membership on membership.world_id = w.id
          and membership.user_id = $2 and membership.status = 'active'
        where w.id = $1 and w.archived_at is null
        ${lock ? 'for update of w' : ''}`,
      [worldId, actorUserId],
    );
    const row = result.rows[0];
    return row
      ? {
          activeWorldVersionId: row.active_world_version_id,
          currentApprovedManifestRevisionId: row.current_approved_manifest_revision_id,
          lifecycle: row.lifecycle,
          manifestSchemaVersion: row.manifest_schema_version,
          name: row.name,
          role: row.role,
          rowVersion: row.row_version,
          worldId: row.world_id,
        }
      : null;
  }

  public async approvedManifest(
    worldId: string,
    revisionId: string,
    lock = false,
  ): Promise<ApprovedManifestRecord | null> {
    const result = await this.executor.query<{
      approval_status: ApprovedManifestRecord['approvalStatus'];
      canonical_manifest: WorldManifestV1;
      content_hash: Buffer;
      id: string;
      manifest_schema_version: number;
      revision_number: string | number;
      world_id: string;
    }>(
      `select id, world_id, revision_number, manifest_schema_version, canonical_manifest,
              content_hash, approval_status
         from manifest_revisions
        where id = $2 and world_id = $1
        ${lock ? 'for share' : ''}`,
      [worldId, revisionId],
    );
    const row = result.rows[0];
    return row
      ? {
          approvalStatus: row.approval_status,
          contentHash: row.content_hash.toString('hex'),
          manifest: row.canonical_manifest,
          manifestSchemaVersion: row.manifest_schema_version,
          revisionId: row.id,
          revisionNumber: Number(row.revision_number),
          worldId: row.world_id,
        }
      : null;
  }

  public async compilationPrimitives(
    manifest: WorldManifestV1,
  ): Promise<CompilationPrimitiveRecord[]> {
    const requestedIds = [
      ...new Set(manifest.primitiveRefs.map((reference) => reference.primitiveVersionId)),
    ];
    if (requestedIds.length === 0) return [];
    const primitives = await this.executor.query<{
      behavior_ref: string | null;
      compatibility: Record<string, unknown>;
      content_hash: Buffer;
      defaults: Record<string, unknown>;
      documentation: string;
      display_name: string;
      id: string;
      kind: string;
      lifecycle: 'deprecated' | 'published';
      parameter_schema: Record<string, unknown>;
      primitive_schema_version: number;
      provenance: Record<string, unknown>;
      semver: string;
      stable_key: string;
      visual_hints: Record<string, unknown>;
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
              version.primitive_schema_version, version.lifecycle, version.documentation,
              version.display_name,
              version.parameter_schema, version.defaults, version.compatibility,
              version.behavior_ref, version.visual_hints, version.provenance,
              version.content_hash
         from closure
         join primitive_versions version on version.id = closure.id
         join primitive_families family on family.id = version.family_id
        order by family.stable_key::text collate "C", version.semver collate "C", version.id`,
      [requestedIds],
    );
    const ids = primitives.rows.map((row) => row.id);
    const tags = await this.executor.query<{ primitive_version_id: string; tag: string }>(
      `select primitive_version_id, tag::text
         from primitive_tags
        where primitive_version_id = any($1::uuid[])
        order by primitive_version_id, tag::text collate "C"`,
      [ids],
    );
    const dependencies = await this.executor.query<{
      dependency_key: string;
      parameter_mapping: Record<string, unknown>;
      primitive_version_id: string;
      required: boolean;
      resolved_content_hash: Buffer | null;
      resolved_version_id: string | null;
      version_range: string;
    }>(
      `select dependency.primitive_version_id, family.stable_key::text as dependency_key,
              dependency.version_range, dependency.required, dependency.parameter_mapping,
              dependency.resolved_version_id, dependency.resolved_content_hash
         from primitive_dependencies dependency
         join primitive_families family on family.id = dependency.dependency_family_id
        where dependency.primitive_version_id = any($1::uuid[])
        order by dependency.primitive_version_id, family.stable_key::text collate "C"`,
      [ids],
    );
    const tagsById = new Map<string, string[]>();
    for (const row of tags.rows) {
      tagsById.set(row.primitive_version_id, [
        ...(tagsById.get(row.primitive_version_id) ?? []),
        row.tag,
      ]);
    }
    const dependenciesById = new Map<string, CompilationPrimitiveDependencyRecord[]>();
    for (const row of dependencies.rows) {
      dependenciesById.set(row.primitive_version_id, [
        ...(dependenciesById.get(row.primitive_version_id) ?? []),
        {
          contentHash: row.resolved_content_hash?.toString('hex') ?? null,
          familyKey: row.dependency_key,
          parameterMapping: row.parameter_mapping,
          required: row.required,
          versionId: row.resolved_version_id,
          versionRange: row.version_range,
        },
      ]);
    }
    return primitives.rows.map((row) => ({
      behaviorRef: row.behavior_ref,
      compatibility: row.compatibility,
      contentHash: row.content_hash.toString('hex'),
      defaults: row.defaults,
      dependencies: dependenciesById.get(row.id) ?? [],
      displayName: row.display_name,
      documentation: row.documentation,
      key: row.stable_key,
      kind: row.kind,
      lifecycle: row.lifecycle,
      parameterSchema: row.parameter_schema,
      primitiveSchemaVersion: row.primitive_schema_version,
      provenance: row.provenance,
      tags: tagsById.get(row.id) ?? [],
      version: row.semver,
      versionId: row.id,
      visualHints: row.visual_hints,
    }));
  }

  public async activeMembers(worldId: string): Promise<CompilationMemberRecord[]> {
    const result = await this.executor.query<{
      role: WorldRole;
      user_id: string;
    }>(
      `select user_id, role
         from world_memberships
        where world_id = $1 and status = 'active'
        order by role::text collate "C", user_id`,
      [worldId],
    );
    return result.rows.map((row) => ({ role: row.role, userId: row.user_id }));
  }

  public async beginIdempotency(
    input: CompilationCommandIdentity,
  ): Promise<CompilationIdempotencyStart> {
    const inserted = await this.executor.query(
      `insert into idempotency_records
        (scope, actor_id, key, request_hash, state, created_at, expires_at)
       values ($1,$2,$3,$4,'processing',now(),$5)
       on conflict do nothing`,
      [input.scope, input.actorId, input.key, input.requestHash, input.expiresAt],
    );
    if ((inserted.rowCount ?? 0) === 1) return { kind: 'new' };
    const existing = await this.executor.query<{
      request_hash: Buffer;
      response_body: Record<string, unknown> | null;
      response_status: number | null;
      state: 'completed' | 'processing';
    }>(
      `select request_hash, response_status, response_body, state
         from idempotency_records
        where scope = $1 and actor_id = $2 and key = $3 for update`,
      [input.scope, input.actorId, input.key],
    );
    const row = existing.rows[0];
    if (!row || !row.request_hash.equals(input.requestHash)) {
      throw new ApplicationError(
        'IDEMPOTENCY_KEY_REUSED',
        'The idempotency key was already used for a different request.',
        409,
      );
    }
    if (row.state !== 'completed' || row.response_status === null || row.response_body === null) {
      throw new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        'The original request is still being processed.',
        409,
      );
    }
    return { body: row.response_body, kind: 'replay', status: row.response_status };
  }

  public async completeIdempotency(
    input: CompilationCommandIdentity,
    status: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > 65_536) {
      throw new Error('Compilation command response exceeds the idempotency response limit.');
    }
    await this.executor.query(
      `update idempotency_records
          set state = 'completed', response_status = $4, response_body = $5
        where scope = $1 and actor_id = $2 and key = $3 and state = 'processing'`,
      [input.scope, input.actorId, input.key, status, encoded],
    );
  }

  public async createRun(input: {
    actorUserId: string;
    compilerConfigVersion: number;
    compilerVersion: string;
    idempotencyKey: string;
    inputHash: string;
    manifestContentHash: string;
    manifestRevisionId: string;
    runId: string;
    seed: string;
    worldId: string;
  }): Promise<CompilationRunRecord> {
    const result = await this.executor.query<CompilationRunRow>(
      `insert into world_compilation_runs
        (id, world_id, manifest_revision_id, manifest_content_hash, input_hash,
         compiler_version, compiler_config_version, seed, requested_by_user_id,
         idempotency_key)
       values ($1,$2,$3,decode($4,'hex'),decode($5,'hex'),$6,$7,$8,$9,$10)
       returning ${runColumns}`,
      [
        input.runId,
        input.worldId,
        input.manifestRevisionId,
        input.manifestContentHash,
        input.inputHash,
        input.compilerVersion,
        input.compilerConfigVersion,
        input.seed,
        input.actorUserId,
        input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Compilation run insertion did not return a row.');
    return runRecord(row);
  }

  public async getRun(
    worldId: string,
    runId: string,
    lock = false,
  ): Promise<CompilationRunRecord | null> {
    const result = await this.executor.query<CompilationRunRow>(
      `select ${runColumns}
         from world_compilation_runs
        where id = $2 and world_id = $1
        ${lock ? 'for update' : ''}`,
      [worldId, runId],
    );
    return result.rows[0] ? runRecord(result.rows[0]) : null;
  }

  public async currentRun(worldId: string): Promise<CompilationRunRecord | null> {
    const result = await this.executor.query<CompilationRunRow>(
      `select ${runColumns}
         from world_compilation_runs
        where world_id = $1 and status in ('queued','running','failed')
        order by case status when 'running' then 0 when 'queued' then 1 else 2 end,
                 updated_at desc, id desc
        limit 1`,
      [worldId],
    );
    return result.rows[0] ? runRecord(result.rows[0]) : null;
  }

  public async findRunByInput(input: {
    compilerConfigVersion: number;
    compilerVersion: string;
    inputHash: string;
    seed: string;
    worldId: string;
  }): Promise<CompilationRunRecord | null> {
    const result = await this.executor.query<CompilationRunRow>(
      `select ${runColumns}
         from world_compilation_runs
        where world_id = $1 and input_hash = decode($2,'hex')
          and compiler_version = $3 and compiler_config_version = $4 and seed = $5
        order by queued_at desc, id desc limit 1`,
      [
        input.worldId,
        input.inputHash,
        input.compilerVersion,
        input.compilerConfigVersion,
        input.seed,
      ],
    );
    return result.rows[0] ? runRecord(result.rows[0]) : null;
  }

  public async markWorldCompiling(worldId: string, expectedRowVersion: number): Promise<number> {
    const result = await this.executor.query<{ row_version: number }>(
      `update worlds
          set lifecycle = 'compiling', row_version = row_version + 1, updated_at = now()
        where id = $1 and row_version = $2 and lifecycle in ('manifest_approved','compile_failed')
          and active_world_version_id is null
       returning row_version`,
      [worldId, expectedRowVersion],
    );
    if (!result.rows[0]) throw new ApplicationError('STALE_VERSION', 'The world has changed.', 409);
    return result.rows[0].row_version;
  }

  public async cancelRun(
    worldId: string,
    runId: string,
    expectedRowVersion: number,
  ): Promise<CompilationRunRecord | null> {
    const result = await this.executor.query<CompilationRunRow>(
      `update world_compilation_runs
          set status = 'cancelled', stage = 'cancelled', progress_percent = 100,
              claim_token = null, claimed_at = null, heartbeat_at = null,
              completed_at = now(), updated_at = now(), row_version = row_version + 1
        where id = $2 and world_id = $1 and row_version = $3
          and status in ('queued','running') and stage in ('queued','validating','compiling')
       returning ${runColumns}`,
      [worldId, runId, expectedRowVersion],
    );
    return result.rows[0] ? runRecord(result.rows[0]) : null;
  }

  public async retryRun(
    worldId: string,
    runId: string,
    expectedRowVersion: number,
  ): Promise<CompilationRunRecord | null> {
    const result = await this.executor.query<CompilationRunRow>(
      `update world_compilation_runs
          set status = 'queued', stage = 'queued', progress_percent = 0,
              diagnostics = '[]'::jsonb, artifact_hash = null, next_attempt_at = now(),
              claim_token = null, claimed_at = null, heartbeat_at = null,
              started_at = null, completed_at = null, updated_at = now(),
              attempts = attempts + 1, row_version = row_version + 1
        where id = $2 and world_id = $1 and row_version = $3
          and status = 'failed' and attempts < 3
       returning ${runColumns}`,
      [worldId, runId, expectedRowVersion],
    );
    return result.rows[0] ? runRecord(result.rows[0]) : null;
  }

  public async restoreWorldAfterCancellation(worldId: string): Promise<void> {
    await this.executor.query(
      `update worlds
          set lifecycle = 'manifest_approved', row_version = row_version + 1, updated_at = now()
        where id = $1 and lifecycle = 'compiling' and active_world_version_id is null
          and not exists (
            select 1 from world_compilation_runs run
             where run.world_id = worlds.id and run.status in ('queued','running')
          )`,
      [worldId],
    );
  }

  public async insertAudit(input: {
    action: string;
    actorUserId: string;
    correlationId: string;
    id: string;
    metadata?: Record<string, unknown>;
    outcome?: 'allowed' | 'denied';
    reasonCode: string;
    requestId: string;
    targetId: string;
    targetType: string;
    worldId: string;
  }): Promise<void> {
    await this.executor.query(
      `insert into security_audit_records
        (id, actor_user_id, world_id, category, action, outcome, reason_code,
         target_type, target_id, request_id, correlation_id, redacted_metadata)
       values ($1,$2,$3,'compiler',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.id,
        input.actorUserId,
        input.worldId,
        input.action,
        input.outcome ?? 'allowed',
        input.reasonCode,
        input.targetType,
        input.targetId,
        input.requestId,
        input.correlationId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  public async runtimeSummary(worldId: string): Promise<QueryResultRow | null> {
    const result = await this.executor.query(
      `select w.id as world_id, w.name as world_name, w.lifecycle,
              head.state_revision, head.last_ledger_sequence,
              head.active_world_version_id, version.version_number,
              version.manifest_revision_id, revision.revision_number as manifest_revision_number,
              encode(revision.content_hash,'hex') as manifest_hash,
              revision.manifest_schema_version, version.world_schema_version,
              version.compiler_version, version.compiler_config_version, version.seed,
              encode(version.artifact_hash,'hex') as artifact_hash, version.activated_at,
              (select count(*)::integer from world_entities entity
                where entity.world_id = w.id and entity.retired_world_version_id is null) as entity_count,
              (select count(*)::integer from world_relationships relationship
                where relationship.world_id = w.id
                  and relationship.retired_world_version_id is null) as relationship_count,
              (select count(*)::integer from world_entity_controllers controller
                where controller.world_id = w.id and controller.revoked_at is null) as controller_count
         from worlds w
         join world_runtime_heads head on head.world_id = w.id
         join world_versions version on version.id = head.active_world_version_id
         join manifest_revisions revision on revision.id = version.manifest_revision_id
        where w.id = $1 and w.active_world_version_id = version.id
          and version.status = 'active' and w.archived_at is null`,
      [worldId],
    );
    return result.rows[0] ?? null;
  }

  public async compiledArtifact(
    worldId: string,
    runId: string,
  ): Promise<CompiledArtifactRecord | null> {
    const result = await this.executor.query<CompiledArtifactRecord>(
      `select artifact.artifact_schema_version, artifact.canonical_content,
              encode(artifact.content_hash,'hex') as content_hash,
              encode(run.input_hash,'hex') as input_hash
         from compiled_world_artifacts artifact
         join world_compilation_runs run on run.id = artifact.compilation_run_id
          and run.world_id = artifact.world_id
        where artifact.world_id = $1 and artifact.compilation_run_id = $2
          and artifact.artifact_kind = 'compiled_world' and run.status = 'succeeded'`,
      [worldId, runId],
    );
    return result.rows[0] ?? null;
  }

  public async runtimeMetadata(worldId: string): Promise<QueryResultRow | null> {
    const result = await this.executor.query(
      `select head.active_world_version_id, head.state_revision, version.version_number
         from world_runtime_heads head
         join world_versions version on version.id = head.active_world_version_id
        where head.world_id = $1 and version.world_id = $1 and version.status = 'active'`,
      [worldId],
    );
    return result.rows[0] ?? null;
  }

  public async entities(input: {
    after?: string;
    entityType?: string;
    limit: number;
    query?: string;
    worldId: string;
  }): Promise<QueryResultRow[]> {
    const result = await this.executor.query(
      `select entity.logical_key::text, entity.entity_type, entity.entity_schema_version,
              entity.state, entity.row_version, entity.world_id,
              entity.created_world_version_id, entity.retired_world_version_id,
              version.version_number, head.active_world_version_id, head.state_revision
         from world_entities entity
         join world_versions version on version.id = entity.created_world_version_id
         join world_runtime_heads head on head.world_id = entity.world_id
        where entity.world_id = $1 and entity.retired_world_version_id is null
          and ($2::text is null or entity.entity_type = $2)
          and ($3::text is null or entity.logical_key::text > $3 collate "C")
          and ($4::text is null or position(lower($4) in lower(entity.logical_key::text)) > 0)
        order by entity.logical_key::text collate "C"
        limit $5`,
      [
        input.worldId,
        input.entityType ?? null,
        input.after ?? null,
        input.query ?? null,
        input.limit,
      ],
    );
    return result.rows;
  }

  public async entity(worldId: string, logicalKey: string): Promise<QueryResultRow | null> {
    const result = await this.executor.query(
      `select entity.logical_key::text, entity.entity_type, entity.entity_schema_version,
              entity.state, entity.row_version, entity.world_id,
              entity.created_world_version_id, entity.retired_world_version_id,
              version.version_number, head.active_world_version_id, head.state_revision
         from world_entities entity
         join world_versions version on version.id = entity.created_world_version_id
         join world_runtime_heads head on head.world_id = entity.world_id
        where entity.world_id = $1 and entity.logical_key = $2
          and entity.retired_world_version_id is null`,
      [worldId, logicalKey],
    );
    return result.rows[0] ?? null;
  }

  public async relationships(input: {
    after?: string;
    limit: number;
    relationshipType?: string;
    sourceLogicalKey?: string;
    targetLogicalKey?: string;
    worldId: string;
  }): Promise<QueryResultRow[]> {
    const result = await this.executor.query(
      `select relationship.logical_key::text, relationship.relationship_type,
              source.logical_key::text as source_logical_key,
              target.logical_key::text as target_logical_key,
              relationship.relationship_schema_version, relationship.attributes,
              relationship.row_version, relationship.world_id,
              relationship.created_world_version_id, relationship.retired_world_version_id,
              version.version_number, head.active_world_version_id, head.state_revision
         from world_relationships relationship
         join world_entities source on source.world_id = relationship.world_id
          and source.id = relationship.source_entity_id
         join world_entities target on target.world_id = relationship.world_id
          and target.id = relationship.target_entity_id
         join world_versions version on version.id = relationship.created_world_version_id
         join world_runtime_heads head on head.world_id = relationship.world_id
        where relationship.world_id = $1 and relationship.retired_world_version_id is null
          and ($2::text is null or relationship.relationship_type = $2)
          and ($3::text is null or relationship.logical_key::text > $3 collate "C")
          and ($4::text is null or source.logical_key = $4)
          and ($5::text is null or target.logical_key = $5)
        order by relationship.logical_key::text collate "C"
        limit $6`,
      [
        input.worldId,
        input.relationshipType ?? null,
        input.after ?? null,
        input.sourceLogicalKey ?? null,
        input.targetLogicalKey ?? null,
        input.limit,
      ],
    );
    return result.rows;
  }

  public async neighbors(
    worldId: string,
    logicalKey: string,
    limit: number,
    options: {
      after?: string;
      direction?: 'both' | 'inbound' | 'outbound';
      relationshipType?: string;
    } = {},
  ): Promise<{
    entity: QueryResultRow | null;
    inbound: QueryResultRow[];
    outbound: QueryResultRow[];
  }> {
    const entity = await this.entity(worldId, logicalKey);
    if (!entity) return { entity: null, inbound: [], outbound: [] };
    const result = await this.executor.query(
      `select relationship.logical_key::text, relationship.relationship_type,
              source.logical_key::text as source_logical_key,
              target.logical_key::text as target_logical_key,
              relationship.relationship_schema_version, relationship.attributes,
              relationship.row_version, relationship.world_id,
              relationship.created_world_version_id, relationship.retired_world_version_id,
              version.version_number, head.active_world_version_id, head.state_revision,
              case when target.logical_key = $2 then 'inbound' else 'outbound' end as direction,
              source.entity_type as source_entity_type,
              source.entity_schema_version as source_entity_schema_version,
              source.state as source_state, source.row_version as source_row_version,
              source.created_world_version_id as source_created_world_version_id,
              source.retired_world_version_id as source_retired_world_version_id,
              target.entity_type as target_entity_type,
              target.entity_schema_version as target_entity_schema_version,
              target.state as target_state, target.row_version as target_row_version,
              target.created_world_version_id as target_created_world_version_id,
              target.retired_world_version_id as target_retired_world_version_id
         from world_relationships relationship
         join world_entities source on source.world_id = relationship.world_id
          and source.id = relationship.source_entity_id
         join world_entities target on target.world_id = relationship.world_id
          and target.id = relationship.target_entity_id
         join world_versions version on version.id = relationship.created_world_version_id
         join world_runtime_heads head on head.world_id = relationship.world_id
        where relationship.world_id = $1 and relationship.retired_world_version_id is null
          and (source.logical_key = $2 or target.logical_key = $2)
          and ($3::text is null or relationship.relationship_type = $3)
          and ($4::text is null or relationship.logical_key::text > $4 collate "C")
          and ($5::text = 'both'
            or ($5::text = 'inbound' and target.logical_key = $2)
            or ($5::text = 'outbound' and source.logical_key = $2))
        order by relationship.logical_key::text collate "C"
        limit $6`,
      [
        worldId,
        logicalKey,
        options.relationshipType ?? null,
        options.after ?? null,
        options.direction ?? 'both',
        limit + 1,
      ],
    );
    return {
      entity,
      inbound: result.rows.filter((row) => row.direction === 'inbound'),
      outbound: result.rows.filter((row) => row.direction === 'outbound'),
    };
  }
}
