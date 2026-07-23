import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type {
  ManifestDiagnostic,
  ManifestFieldProvenance,
  ManifestGenerationWarning,
  ManifestGenerationRunView,
  ManifestRevisionSummary,
  ManifestRevisionView,
  ManifestValidationReportView,
  WorldManifestV1,
  WorldRole,
} from '@worldgraph/contracts';
import type { ManifestCatalogSnapshot, ManifestPrimitiveDefinition } from '@worldgraph/manifests';

import { ApplicationError, isPostgresError } from '../application/errors.js';
import {
  appendAcceptedLegacyMutation,
  appendRejectedLegacyMutation,
  type AppendLegacyMutationInput,
  type LegacyLedgerAppendResult,
  type RejectLegacyMutationInput,
} from '../commands/legacy-mutation-ledger.js';

interface Executor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface ManifestCommandIdentity {
  actorId: string;
  expiresAt: Date;
  key: string;
  requestHash: Buffer;
  scope: string;
}

export interface ManifestWorldAccess {
  currentApprovedManifestRevisionId: string | null;
  lifecycle: 'active' | 'compile_failed' | 'compiling' | 'draft' | 'manifest_approved';
  manifestSchemaVersion: 1 | null;
  name: string;
  role: WorldRole;
  rowVersion: number;
  worldId: string;
}

export type ManifestIdempotencyStart =
  { kind: 'new' } | { body: Record<string, unknown>; kind: 'replay'; status: number };

interface GenerationRunRow extends QueryResultRow {
  attempts: number;
  completed_at: Date | null;
  cost_estimate_microunits: string | number | null;
  error_code: string | null;
  generation_mode: 'provider' | 'fallback' | null;
  generator_schema_version: 1;
  id: string;
  input_hash: Buffer;
  input_token_count: number | null;
  model: string | null;
  output_review: {
    assumptions: string[];
    suggestedFixes: unknown[];
    unresolvedQuestions: string[];
    warnings: unknown[];
  } | null;
  output_revision_id: string | null;
  output_token_count: number | null;
  primitive_catalog_snapshot_hash: Buffer | null;
  progress_percent: number;
  prompt_template_version: 1;
  provider: string | null;
  provider_call_count: number;
  queued_at: Date;
  repair_attempts: number;
  resolved_input_hash: Buffer | null;
  row_version: number;
  stage:
    | 'queued'
    | 'intent'
    | 'retrieval'
    | 'generation'
    | 'repair'
    | 'fallback'
    | 'validation'
    | 'persisting'
    | 'complete';
  started_at: Date | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  world_id: string;
}

interface RevisionRow extends QueryResultRow {
  approval_status: 'draft' | 'approved' | 'superseded' | 'rejected';
  approved_at: Date | null;
  approved_by_user_id: string | null;
  canonical_manifest: WorldManifestV1;
  content_hash: Buffer;
  created_at: Date;
  created_by_user_id: string;
  generation_run_id: string | null;
  id: string;
  manifest_schema_version: 1;
  parent_revision_id: string | null;
  revision_number: string | number;
  row_version: number;
  source: 'generation' | 'manual' | 'import';
  world_id: string;
}

interface ReportRow extends QueryResultRow {
  created_at: Date;
  diagnostics: ManifestDiagnostic[];
  id: string;
  manifest_revision_id: string;
  primitive_catalog_snapshot_hash: Buffer;
  report_hash: Buffer;
  valid: boolean;
  validator_version: 1;
}

interface PrimitiveRow extends QueryResultRow {
  behavior_ref: string | null;
  compatibility: ManifestPrimitiveDefinition['compatibility'];
  content_hash: Buffer;
  defaults: ManifestPrimitiveDefinition['defaults'];
  id: string;
  kind: ManifestPrimitiveDefinition['kind'];
  lifecycle: 'published' | 'deprecated';
  parameter_schema: ManifestPrimitiveDefinition['parameterSchema'];
  semver: string;
  stable_key: string;
}

const generationRunColumns = `
  r.id, r.world_id, r.status, r.stage, r.progress_percent,
  r.generator_schema_version, r.prompt_template_version, r.input_hash,
  r.resolved_input_hash, r.primitive_catalog_snapshot_hash, r.output_revision_id, r.attempts,
  r.repair_attempts, r.generation_mode, r.provider, r.model, r.output_review,
  case when r.provider_call_count = 0 then r.input_token_count else (
    select coalesce(sum(case
      when call.status = 'settled' then call.actual_input_tokens
      when call.status = 'reserved' then call.reserved_input_tokens else 0 end),0)::integer
      from manifest_provider_calls call where call.run_id = r.id
  ) end as input_token_count,
  case when r.provider_call_count = 0 then r.output_token_count else (
    select coalesce(sum(case
      when call.status = 'settled' then call.actual_output_tokens
      when call.status = 'reserved' then call.reserved_output_tokens else 0 end),0)::integer
      from manifest_provider_calls call where call.run_id = r.id
  ) end as output_token_count,
  case when r.provider_call_count = 0 then r.cost_estimate_microunits else (
    select coalesce(sum(case
      when call.status = 'settled' then call.actual_cost_microunits
      when call.status = 'reserved' then call.reserved_cost_microunits else 0 end),0)::bigint
      from manifest_provider_calls call where call.run_id = r.id
  ) end as cost_estimate_microunits,
  r.provider_call_count,
  r.error_code, r.queued_at, r.started_at, r.completed_at, r.row_version`;

const revisionColumns = `
  r.id, r.world_id, r.revision_number, r.parent_revision_id,
  r.manifest_schema_version, r.canonical_manifest, r.content_hash, r.source,
  r.generation_run_id, r.created_by_user_id, r.created_at, r.approval_status,
  r.approved_by_user_id, r.approved_at, r.row_version`;

function runView(row: GenerationRunRow): ManifestGenerationRunView {
  return {
    attempts: row.attempts,
    catalogSnapshotHash: row.primitive_catalog_snapshot_hash?.toString('hex') ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    costEstimateMicrounits:
      row.cost_estimate_microunits === null ? null : Number(row.cost_estimate_microunits),
    errorCode: row.error_code,
    generatorSchemaVersion: row.generator_schema_version,
    id: row.id,
    inputHash: row.input_hash.toString('hex'),
    inputTokenCount: row.input_token_count,
    model: row.model,
    outcome:
      row.generation_mode && row.output_review
        ? {
            assumptions: row.output_review.assumptions,
            mode: row.generation_mode,
            suggestedFixes: row.output_review.suggestedFixes,
            unresolvedQuestions: row.output_review.unresolvedQuestions,
            warnings: row.output_review.warnings,
          }
        : null,
    outputRevisionId: row.output_revision_id,
    outputTokenCount: row.output_token_count,
    progressPercent: row.progress_percent,
    promptTemplateVersion: row.prompt_template_version,
    provider: row.provider,
    providerCallCount: row.provider_call_count,
    queuedAt: row.queued_at.toISOString(),
    repairAttempts: row.repair_attempts,
    resolvedInputHash: row.resolved_input_hash?.toString('hex') ?? null,
    rowVersion: row.row_version,
    stage: row.stage,
    startedAt: row.started_at?.toISOString() ?? null,
    status: row.status,
    worldId: row.world_id,
  } as ManifestGenerationRunView;
}

function revisionSummary(row: RevisionRow): ManifestRevisionSummary {
  return {
    approvalStatus: row.approval_status,
    approvedAt: row.approved_at?.toISOString() ?? null,
    approvedBy: row.approved_by_user_id,
    contentHash: row.content_hash.toString('hex'),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by_user_id,
    generationRunId: row.generation_run_id,
    id: row.id,
    manifestSchemaVersion: row.manifest_schema_version,
    parentRevisionId: row.parent_revision_id,
    revisionNumber: Number(row.revision_number),
    rowVersion: row.row_version,
    source: row.source,
    worldId: row.world_id,
  };
}

function revisionView(row: RevisionRow): ManifestRevisionView {
  return { ...revisionSummary(row), manifest: row.canonical_manifest };
}

function reportView(row: ReportRow): ManifestValidationReportView {
  return {
    catalogSnapshotHash: row.primitive_catalog_snapshot_hash.toString('hex'),
    createdAt: row.created_at.toISOString(),
    diagnostics: row.diagnostics,
    id: row.id,
    manifestRevisionId: row.manifest_revision_id,
    reportHash: row.report_hash.toString('hex'),
    valid: row.valid,
    validatorVersion: row.validator_version,
  };
}

export class ManifestRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  public async transaction<T>(
    operation: (repository: ManifestRepository) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client: PoolClient = await this.pool.connect();
      try {
        await client.query('begin isolation level serializable');
        const result = await operation(new ManifestRepository(this.pool, client));
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if ((isPostgresError(error, '40001') || isPostgresError(error, '40P01')) && attempt < 2) {
          await boundedRetryDelay(attempt);
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw new ApplicationError(
      'SERIALIZATION_RETRY_EXHAUSTED',
      'The mutation could not be ordered safely. Retry with the same idempotency key.',
      503,
    );
  }

  public async appendLegacyMutation(
    input: AppendLegacyMutationInput,
  ): Promise<LegacyLedgerAppendResult> {
    return appendAcceptedLegacyMutation(this.executor, input);
  }

  public async rejectLegacyMutation(
    input: RejectLegacyMutationInput,
  ): Promise<LegacyLedgerAppendResult> {
    return appendRejectedLegacyMutation(this.executor, input);
  }

  public async getWorldAccess(
    actorUserId: string,
    worldId: string,
    lock = false,
  ): Promise<ManifestWorldAccess | null> {
    const result = await this.executor.query<{
      current_approved_manifest_revision_id: string | null;
      lifecycle: ManifestWorldAccess['lifecycle'];
      manifest_schema_version: 1 | null;
      name: string;
      role: WorldRole;
      row_version: number;
      world_id: string;
    }>(
      `select w.id as world_id, w.name, w.lifecycle, w.row_version,
              w.current_approved_manifest_revision_id, w.manifest_schema_version, m.role
         from worlds w
         join world_memberships m on m.world_id = w.id
          and m.user_id = $2 and m.status = 'active'
        where w.id = $1 and w.archived_at is null
        ${lock ? 'for update of w' : ''}`,
      [worldId, actorUserId],
    );
    const row = result.rows[0];
    return row
      ? {
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

  public async beginIdempotency(input: ManifestCommandIdentity): Promise<ManifestIdempotencyStart> {
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
      state: 'processing' | 'completed';
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
    input: ManifestCommandIdentity,
    status: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > 65_536) {
      throw new Error('Manifest command response exceeds the idempotency response limit.');
    }
    await this.executor.query(
      `update idempotency_records
          set state = 'completed', response_status = $4, response_body = $5
        where scope = $1 and actor_id = $2 and key = $3 and state = 'processing'`,
      [input.scope, input.actorId, input.key, status, encoded],
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
       values ($1,$2,$3,'manifest',$4,$5,$6,$7,$8,$9,$10,$11)`,
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

  public async activeGenerationCounts(
    worldId: string,
    actorUserId: string,
  ): Promise<{ user: number; world: number }> {
    const result = await this.executor.query<{ user_count: string; world_count: string }>(
      `select count(*) filter (where world_id = $1)::text as world_count,
              count(*) filter (where requested_by_user_id = $2)::text as user_count
         from manifest_generation_runs where status in ('queued','running')`,
      [worldId, actorUserId],
    );
    return {
      user: Number(result.rows[0]?.user_count ?? 0),
      world: Number(result.rows[0]?.world_count ?? 0),
    };
  }

  public async lockGenerationUser(actorUserId: string): Promise<void> {
    await this.executor.query(
      `select pg_advisory_xact_lock(hashtextextended('manifest-generation-user:' || $1::text, 0))`,
      [actorUserId],
    );
  }

  public async createGeneration(input: {
    actorUserId: string;
    expectedParentContentHash: string | null;
    inputHash: string;
    normalizedHash: string;
    parentRevisionId: string | null;
    prompt: string;
    promptId: string;
    providerConfigurationId: string;
    retentionUntil: Date;
    runId: string;
    seed: string;
    worldId: string;
  }): Promise<ManifestGenerationRunView> {
    await this.executor.query(
      `insert into world_prompt_submissions
        (id, world_id, submitted_by_user_id, prompt_text, normalized_hash,
         client_seed, retention_until)
       values ($1,$2,$3,$4,decode($5,'hex'),$6,$7)`,
      [
        input.promptId,
        input.worldId,
        input.actorUserId,
        input.prompt,
        input.normalizedHash,
        input.seed,
        input.retentionUntil,
      ],
    );
    let result: QueryResult<GenerationRunRow>;
    try {
      result = await this.executor.query<GenerationRunRow>(
        `insert into manifest_generation_runs
        (id, world_id, prompt_submission_id, requested_by_user_id,
         generator_schema_version, prompt_template_version, provider_configuration_id,
         parent_revision_id, expected_parent_content_hash, seed, input_hash)
       values ($1,$2,$3,$4,1,1,$5,$6,
               case when $7::text is null then null else decode($7,'hex') end,
               $8,decode($9,'hex'))
       returning ${generationRunColumns.replaceAll('r.', '')}`,
        [
          input.runId,
          input.worldId,
          input.promptId,
          input.actorUserId,
          input.providerConfigurationId,
          input.parentRevisionId,
          input.expectedParentContentHash,
          input.seed,
          input.inputHash,
        ],
      );
    } catch (error) {
      if (
        input.parentRevisionId === null &&
        isPostgresError(error, '23505') &&
        (error as { constraint?: unknown }).constraint ===
          'manifest_generation_runs_one_active_root_world_idx'
      ) {
        throw new ApplicationError(
          'GENERATION_LIMIT',
          'The first manifest revision is already being generated.',
          429,
        );
      }
      throw error;
    }
    return runView(result.rows[0]!);
  }

  public async findGenerationByInput(
    worldId: string,
    inputHash: string,
  ): Promise<ManifestGenerationRunView | null> {
    const result = await this.executor.query<GenerationRunRow>(
      `select ${generationRunColumns}
         from manifest_generation_runs r
        where r.world_id = $1 and r.input_hash = decode($2,'hex')
          and r.prompt_template_version = 1
          and r.status in ('queued','running','succeeded')
        order by case r.status
                   when 'succeeded' then 0
                   when 'running' then 1
                   else 2
                 end,
                 r.queued_at desc, r.id desc
        limit 1`,
      [worldId, inputHash],
    );
    return result.rows[0] ? runView(result.rows[0]) : null;
  }

  public async getGenerationRun(
    actorUserId: string,
    runId: string,
    lock = false,
  ): Promise<ManifestGenerationRunView | null> {
    const result = await this.executor.query<GenerationRunRow>(
      `select ${generationRunColumns}
         from manifest_generation_runs r
         join world_memberships m on m.world_id = r.world_id
          and m.user_id = $2 and m.status = 'active'
        where r.id = $1 ${lock ? 'for update of r' : ''}`,
      [runId, actorUserId],
    );
    return result.rows[0] ? runView(result.rows[0]) : null;
  }

  public async cancelGeneration(
    actorUserId: string,
    runId: string,
    expectedRowVersion: number,
  ): Promise<ManifestGenerationRunView | null> {
    const result = await this.executor.query<GenerationRunRow>(
      `update manifest_generation_runs r
          set status = 'cancelled', completed_at = now(), claim_token = null,
              updated_at = now(), row_version = r.row_version + 1
         from world_memberships m
        where r.id = $1 and r.row_version = $2 and r.status in ('queued','running')
          and m.world_id = r.world_id and m.user_id = $3 and m.status = 'active'
       returning ${generationRunColumns}`,
      [runId, expectedRowVersion, actorUserId],
    );
    return result.rows[0] ? runView(result.rows[0]) : null;
  }

  public async getRevision(
    worldId: string,
    revisionId: string,
    lock = false,
  ): Promise<ManifestRevisionView | null> {
    const result = await this.executor.query<RevisionRow>(
      `select ${revisionColumns} from manifest_revisions r
        where r.id = $1 and r.world_id = $2 ${lock ? 'for update' : ''}`,
      [revisionId, worldId],
    );
    return result.rows[0] ? revisionView(result.rows[0]) : null;
  }

  public async latestRevisionNumber(worldId: string): Promise<number> {
    const result = await this.executor.query<{ revision_number: string | null }>(
      `select max(revision_number)::text as revision_number
         from manifest_revisions where world_id = $1`,
      [worldId],
    );
    return Number(result.rows[0]?.revision_number ?? 0);
  }

  public async listRevisions(input: {
    cursor: { id: string; revisionNumber: number } | null;
    limit: number;
    worldId: string;
  }): Promise<{ items: ManifestRevisionSummary[]; tail: ManifestRevisionSummary | null }> {
    const result = await this.executor.query<RevisionRow>(
      `select ${revisionColumns} from manifest_revisions r
        where r.world_id = $1
          and ($2::bigint is null or (r.revision_number, r.id) < ($2::bigint, $3::uuid))
        order by r.revision_number desc, r.id desc limit $4`,
      [
        input.worldId,
        input.cursor?.revisionNumber ?? null,
        input.cursor?.id ?? null,
        input.limit + 1,
      ],
    );
    const page = result.rows.slice(0, input.limit).map(revisionSummary);
    return {
      items: page,
      tail: result.rows.length > input.limit ? (page.at(-1) ?? null) : null,
    };
  }

  public async insertManualRevision(input: {
    contentHash: string;
    createdBy: string;
    id: string;
    manifest: WorldManifestV1;
    generationWarnings: readonly ManifestGenerationWarning[];
    parentRevisionId: string | null;
    revisionNumber: number;
    worldId: string;
  }): Promise<ManifestRevisionSummary> {
    try {
      const result = await this.executor.query<RevisionRow>(
        `insert into manifest_revisions
          (id, world_id, revision_number, parent_revision_id, manifest_schema_version,
           canonical_manifest, content_hash, source, created_by_user_id, generation_warnings)
         values ($1,$2,$3,$4,1,$5,decode($6,'hex'),'manual',$7,$8)
         returning ${revisionColumns.replaceAll('r.', '')}`,
        [
          input.id,
          input.worldId,
          input.revisionNumber,
          input.parentRevisionId,
          JSON.stringify(input.manifest),
          input.contentHash,
          input.createdBy,
          JSON.stringify(input.generationWarnings),
        ],
      );
      return revisionSummary(result.rows[0]!);
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        throw new ApplicationError(
          'MANIFEST_REVISION_CONFLICT',
          'That manifest revision already exists.',
          409,
        );
      }
      throw error;
    }
  }

  public async generationWarnings(
    worldId: string,
    revisionId: string,
  ): Promise<ManifestGenerationWarning[]> {
    const result = await this.executor.query<{ generation_warnings: ManifestGenerationWarning[] }>(
      `select generation_warnings from manifest_revisions
        where id = $1 and world_id = $2`,
      [revisionId, worldId],
    );
    return result.rows[0]?.generation_warnings ?? [];
  }

  public async insertProvenance(
    revisionId: string,
    entries: readonly ManifestFieldProvenance[],
  ): Promise<void> {
    for (const entry of entries) {
      await this.executor.query(
        `insert into manifest_field_provenance
          (manifest_revision_id, json_pointer, source_type, source_ref, source_hash)
         values ($1,$2,$3,$4,decode($5,'hex')) on conflict do nothing`,
        [revisionId, entry.pointer, entry.sourceType, entry.sourceRef, entry.sourceHash],
      );
    }
  }

  public async provenance(revisionId: string): Promise<ManifestFieldProvenance[]> {
    const result = await this.executor.query<{
      json_pointer: string;
      source_hash: Buffer;
      source_ref: string;
      source_type: ManifestFieldProvenance['sourceType'];
    }>(
      `select json_pointer, source_type, source_ref, source_hash
         from manifest_field_provenance where manifest_revision_id = $1
        order by json_pointer collate "C", source_type, source_ref collate "C"`,
      [revisionId],
    );
    return result.rows.map((row) => ({
      pointer: row.json_pointer,
      sourceHash: row.source_hash.toString('hex'),
      sourceRef: row.source_ref,
      sourceType: row.source_type,
    }));
  }

  public async putValidationReport(input: {
    catalogSnapshotHash: string;
    diagnostics: readonly ManifestDiagnostic[];
    id: string;
    reportHash: string;
    revisionId: string;
    valid: boolean;
  }): Promise<ManifestValidationReportView> {
    const inserted = await this.executor.query<ReportRow>(
      `insert into manifest_validation_reports
        (id, manifest_revision_id, validator_version, primitive_catalog_snapshot_hash,
         valid, diagnostics, report_hash)
       values ($1,$2,1,decode($3,'hex'),$4,$5,decode($6,'hex'))
       on conflict (manifest_revision_id, validator_version, primitive_catalog_snapshot_hash)
       do nothing
       returning id, manifest_revision_id, validator_version,
                 primitive_catalog_snapshot_hash, valid, diagnostics, report_hash, created_at`,
      [
        input.id,
        input.revisionId,
        input.catalogSnapshotHash,
        input.valid,
        JSON.stringify(input.diagnostics),
        input.reportHash,
      ],
    );
    if (inserted.rows[0]) return reportView(inserted.rows[0]);
    const existing = await this.executor.query<ReportRow>(
      `select id, manifest_revision_id, validator_version,
              primitive_catalog_snapshot_hash, valid, diagnostics, report_hash, created_at
         from manifest_validation_reports
        where manifest_revision_id = $1 and validator_version = 1
          and primitive_catalog_snapshot_hash = decode($2,'hex')`,
      [input.revisionId, input.catalogSnapshotHash],
    );
    if (!existing.rows[0]) throw new Error('Validation report conflict could not be reloaded.');
    const existingReport = reportView(existing.rows[0]);
    if (existingReport.reportHash !== input.reportHash || existingReport.valid !== input.valid) {
      throw new ApplicationError(
        'MANIFEST_VALIDATION_REPORT_CONFLICT',
        'The immutable validation report does not match this deterministic validation result.',
        409,
      );
    }
    return existingReport;
  }

  public async latestValidationReport(
    revisionId: string,
  ): Promise<ManifestValidationReportView | null> {
    const result = await this.executor.query<ReportRow>(
      `select id, manifest_revision_id, validator_version,
              primitive_catalog_snapshot_hash, valid, diagnostics, report_hash, created_at
         from manifest_validation_reports where manifest_revision_id = $1
        order by created_at desc, id desc limit 1`,
      [revisionId],
    );
    return result.rows[0] ? reportView(result.rows[0]) : null;
  }

  public async catalogForManifest(manifest: WorldManifestV1): Promise<ManifestCatalogSnapshot> {
    const ids = [
      ...new Set(manifest.primitiveRefs.map((reference) => reference.primitiveVersionId)),
    ];
    const primitives = await this.executor.query<PrimitiveRow>(
      `select v.id, f.stable_key::text, f.kind, v.semver, v.lifecycle,
              v.parameter_schema, v.defaults, v.compatibility, v.behavior_ref, v.content_hash
         from primitive_versions v join primitive_families f on f.id = v.family_id
        where v.id = any($1::uuid[]) and v.lifecycle in ('published','deprecated')`,
      [ids],
    );
    const dependencies = await this.executor.query<{
      primitive_version_id: string;
      required: boolean;
      stable_key: string;
      version_range: string;
    }>(
      `select d.primitive_version_id, f.stable_key::text, d.required, d.version_range
         from primitive_dependencies d
         join primitive_families f on f.id = d.dependency_family_id
        where d.primitive_version_id = any($1::uuid[])
        order by d.primitive_version_id, f.stable_key::text collate "C"`,
      [ids],
    );
    const dependenciesById = new Map<string, ManifestPrimitiveDefinition['dependencies']>();
    for (const row of dependencies.rows) {
      const existing = dependenciesById.get(row.primitive_version_id) ?? [];
      dependenciesById.set(row.primitive_version_id, [
        ...existing,
        { key: row.stable_key, required: row.required, versionRange: row.version_range },
      ]);
    }
    return {
      primitives: primitives.rows.map((row) => ({
        behaviorRef: row.behavior_ref,
        compatibility: row.compatibility,
        contentHash: row.content_hash.toString('hex'),
        defaults: row.defaults,
        dependencies: dependenciesById.get(row.id) ?? [],
        key: row.stable_key,
        kind: row.kind,
        lifecycle: row.lifecycle,
        parameterSchema: row.parameter_schema,
        version: row.semver,
        versionId: row.id,
      })),
    };
  }

  public async approveRevision(input: {
    acknowledgedWarningCodes: readonly string[];
    actorUserId: string;
    expectedWorldVersion: number;
    revisionId: string;
    worldId: string;
  }): Promise<number> {
    await this.executor.query(
      `update manifest_revisions
          set approval_status = 'superseded', row_version = row_version + 1
        where world_id = $1 and approval_status = 'approved' and id <> $2`,
      [input.worldId, input.revisionId],
    );
    const approved = await this.executor.query(
      `update manifest_revisions
          set approval_status = 'approved', approved_by_user_id = $3, approved_at = now(),
              warning_acknowledgements = $4, row_version = row_version + 1
        where id = $2 and world_id = $1 and approval_status = 'draft'`,
      [
        input.worldId,
        input.revisionId,
        input.actorUserId,
        JSON.stringify([...input.acknowledgedWarningCodes].sort()),
      ],
    );
    if ((approved.rowCount ?? 0) !== 1) {
      throw new ApplicationError(
        'MANIFEST_APPROVAL_CONFLICT',
        'The revision cannot be approved.',
        409,
      );
    }
    const world = await this.executor.query<{ row_version: number }>(
      `update worlds
          set current_approved_manifest_revision_id = $2, manifest_schema_version = 1,
              lifecycle = 'manifest_approved', row_version = row_version + 1, updated_at = now()
        where id = $1 and row_version = $3
          and lifecycle in ('draft', 'manifest_approved', 'compile_failed')
          and active_world_version_id is null
       returning row_version`,
      [input.worldId, input.revisionId, input.expectedWorldVersion],
    );
    if (!world.rows[0]) {
      throw new ApplicationError('STALE_VERSION', 'The world has changed.', 409);
    }
    return world.rows[0].row_version;
  }
}

async function boundedRetryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 5 : 20));
}
