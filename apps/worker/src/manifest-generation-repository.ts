import { rankCandidates } from '@worldgraph/catalog';
import {
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_VALIDATOR_VERSION,
  canonicalizeJson,
  type JsonValue,
  type ManifestFieldProvenance,
  type ManifestGenerationWarning,
} from '@worldgraph/contracts';
import type { Pool } from '@worldgraph/db';
import {
  manifestCatalogSnapshotHash,
  manifestGenerationInputHash,
  type ManifestGenerationDurableUsage,
  type ManifestCatalogSnapshot,
  type ManifestGenerationOutcome,
  type ManifestProviderCallReservation,
  type ManifestProviderCallReservationRequest,
  type ManifestProviderCallSettlement,
  type ManifestPrimitiveDefinition,
  type ManifestValidationResult,
} from '@worldgraph/manifests';
import type { PoolClient } from 'pg';

export const MAX_MANIFEST_GENERATION_ATTEMPTS = 3 as const;
const MAX_MANIFEST_CATALOG_ITEMS = 500;

export type ManifestGenerationFailureCode =
  | 'CATALOG_SCOPE_EXCEEDED'
  | 'GENERATION_INPUT_MISMATCH'
  | 'GENERATION_OUTPUT_INVALID'
  | 'NO_COMPATIBLE_PRIMITIVES'
  | 'PROMPT_UNAVAILABLE'
  | 'PROVIDER_CONFIGURATION_MISMATCH'
  | 'WORKER_EXECUTION_FAILED'
  | 'WORKER_LEASE_EXPIRED';

export type ManifestGenerationStage =
  'intent' | 'retrieval' | 'generation' | 'repair' | 'fallback' | 'validation' | 'persisting';

export interface ClaimedManifestGenerationRun {
  attempts: number;
  claimToken: string;
  expectedParentContentHash: string | null;
  generatorSchemaVersion: number;
  inputHash: string;
  parentRevisionId: string | null;
  progressPercent: number;
  promptSubmissionId: string;
  promptTemplateVersion: number;
  providerConfigurationId: string;
  queuedAt: Date;
  repairAttempts: number;
  requestedByUserId: string;
  resolvedInputHash: string | null;
  runId: string;
  seed: string;
  worldId: string;
}

export interface ManifestGenerationInput {
  prompt: string;
}

export interface FrozenManifestCatalog {
  catalog: ManifestCatalogSnapshot;
  catalogSnapshotHash: string;
  resolvedInputHash: string;
  retrievalCount: number;
}

export interface ManifestGenerationBacklog {
  oldestAgeMs: number;
  ready: number;
  running: number;
}

export interface ManifestGenerationPublicationIds {
  reportId: string;
  revisionId: string;
}

export interface ManifestGenerationPublication {
  catalog: ManifestCatalogSnapshot;
  ids: ManifestGenerationPublicationIds;
  outcome: ManifestGenerationOutcome;
  validation: ManifestValidationResult;
}

export interface ManifestGenerationPublicationResult {
  contentHash: string;
  revisionId: string;
  revisionNumber: number;
}

export interface ManifestGenerationRepository {
  claimNext(
    providerConfigurationId: string,
    claimToken: string,
    maximumConcurrentPerWorld: number,
  ): Promise<ClaimedManifestGenerationRun | null>;
  cleanupExpiredPrompts(limit: number): Promise<number>;
  freezeCatalog(
    job: ClaimedManifestGenerationRun,
    prompt: string,
  ): Promise<FrozenManifestCatalog | null>;
  generationWarnings(
    worldId: string,
    revisionId: string | null,
  ): Promise<ManifestGenerationWarning[]>;
  heartbeat(job: ClaimedManifestGenerationRun): Promise<boolean>;
  inspectBacklog(providerConfigurationId: string): Promise<ManifestGenerationBacklog>;
  isClaimCurrent(job: ClaimedManifestGenerationRun): Promise<boolean>;
  loadInput(job: ClaimedManifestGenerationRun): Promise<ManifestGenerationInput | null>;
  loadProviderUsage(
    job: ClaimedManifestGenerationRun,
  ): Promise<ManifestGenerationDurableUsage | null>;
  markFailure(
    job: ClaimedManifestGenerationRun,
    code: ManifestGenerationFailureCode,
    retryable: boolean,
  ): Promise<'failed' | 'lost_claim' | 'retry_scheduled'>;
  publish(
    job: ClaimedManifestGenerationRun,
    publication: ManifestGenerationPublication,
  ): Promise<ManifestGenerationPublicationResult | null>;
  releaseProviderCall(
    job: ClaimedManifestGenerationRun,
    reservation: ManifestProviderCallReservation,
  ): Promise<boolean>;
  reserveProviderCall(
    job: ClaimedManifestGenerationRun,
    callId: string,
    dailyBudgetMicrounits: number,
    request: ManifestProviderCallReservationRequest,
  ): Promise<ManifestProviderCallReservation | null>;
  recoverExpiredClaims(claimTimeoutMs: number): Promise<{ failed: number; retried: number }>;
  settleProviderCall(
    job: ClaimedManifestGenerationRun,
    reservation: ManifestProviderCallReservation,
    settlement: ManifestProviderCallSettlement,
  ): Promise<boolean>;
  updateStage(
    job: ClaimedManifestGenerationRun,
    stage: ManifestGenerationStage,
    progressPercent: number,
  ): Promise<boolean>;
}

interface ClaimedRunRow {
  attempts: number;
  claim_token: string;
  expected_parent_content_hash: Buffer | null;
  generator_schema_version: number;
  input_hash: Buffer;
  parent_revision_id: string | null;
  progress_percent: number;
  prompt_submission_id: string;
  prompt_template_version: number;
  provider_configuration_id: string;
  queued_at: Date;
  repair_attempts: number;
  requested_by_user_id: string;
  resolved_input_hash: Buffer | null;
  run_id: string;
  seed: string;
  world_id: string;
}

interface CatalogRow {
  behavior_ref: string | null;
  compatibility: unknown;
  content_hash: Buffer;
  defaults: unknown;
  dependencies: unknown;
  id: string;
  kind: ManifestPrimitiveDefinition['kind'];
  normalized_text: string;
  parameter_schema: unknown;
  semver: string;
  stable_key: string;
  tags: string[];
}

interface RankedCatalogEntry {
  definition: ManifestPrimitiveDefinition;
  reason: Record<string, JsonValue>;
  score: number;
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  const canonical = canonicalizeJson(value);
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== 'object') {
    throw new Error('MANIFEST_CATALOG_JSON_INVALID');
  }
  return canonical;
}

function dependencies(value: unknown): ManifestPrimitiveDefinition['dependencies'] {
  const canonical = canonicalizeJson(value);
  if (!Array.isArray(canonical)) throw new Error('MANIFEST_CATALOG_DEPENDENCIES_INVALID');
  return canonical.map((entry) => {
    if (
      entry === null ||
      Array.isArray(entry) ||
      typeof entry !== 'object' ||
      typeof entry.key !== 'string' ||
      typeof entry.required !== 'boolean' ||
      typeof entry.versionRange !== 'string'
    ) {
      throw new Error('MANIFEST_CATALOG_DEPENDENCIES_INVALID');
    }
    return {
      key: entry.key,
      required: entry.required,
      versionRange: entry.versionRange,
    };
  });
}

function definition(row: CatalogRow): ManifestPrimitiveDefinition {
  return {
    behaviorRef: row.behavior_ref,
    compatibility: jsonObject(row.compatibility),
    contentHash: row.content_hash.toString('hex'),
    defaults: jsonObject(row.defaults),
    dependencies: dependencies(row.dependencies),
    key: row.stable_key,
    kind: row.kind,
    // Retrieval admits only published rows. This freezes lifecycle-at-retrieval
    // even if an exact immutable version is deprecated before a retry.
    lifecycle: 'published',
    parameterSchema: jsonObject(row.parameter_schema),
    version: row.semver,
    versionId: row.id,
  };
}

function toClaimedRun(row: ClaimedRunRow): ClaimedManifestGenerationRun {
  return {
    attempts: row.attempts,
    claimToken: row.claim_token,
    expectedParentContentHash: row.expected_parent_content_hash?.toString('hex') ?? null,
    generatorSchemaVersion: row.generator_schema_version,
    inputHash: row.input_hash.toString('hex'),
    parentRevisionId: row.parent_revision_id,
    progressPercent: row.progress_percent,
    promptSubmissionId: row.prompt_submission_id,
    promptTemplateVersion: row.prompt_template_version,
    providerConfigurationId: row.provider_configuration_id,
    queuedAt: row.queued_at,
    repairAttempts: row.repair_attempts,
    requestedByUserId: row.requested_by_user_id,
    resolvedInputHash: row.resolved_input_hash?.toString('hex') ?? null,
    runId: row.run_id,
    seed: row.seed,
    worldId: row.world_id,
  };
}

function assertConfigurationId(value: string): void {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (!value || value.length > 120 || value !== value.trim() || hasControlCharacter) {
    throw new Error('MANIFEST_PROVIDER_CONFIGURATION_INVALID');
  }
}

function assertUuid(value: string, code: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(code);
  }
}

function claimParameters(job: ClaimedManifestGenerationRun): unknown[] {
  return [job.runId, job.claimToken, job.attempts];
}

/**
 * PostgreSQL owns generation state. BullMQ only wakes reconciliation; every
 * mutation is guarded by the run's attempt and unguessable claim token.
 */
export class PostgresManifestGenerationRepository implements ManifestGenerationRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly baseBackoffMs = 1_000,
    private readonly maximumBackoffMs = 30_000,
  ) {}

  public async claimNext(
    providerConfigurationId: string,
    claimToken: string,
    maximumConcurrentPerWorld: number,
  ): Promise<ClaimedManifestGenerationRun | null> {
    assertConfigurationId(providerConfigurationId);
    assertUuid(claimToken, 'MANIFEST_CLAIM_TOKEN_INVALID');
    if (
      !Number.isSafeInteger(maximumConcurrentPerWorld) ||
      maximumConcurrentPerWorld < 1 ||
      maximumConcurrentPerWorld > 3
    ) {
      throw new Error('MANIFEST_WORLD_CONCURRENCY_INVALID');
    }
    const connection = await this.pool.connect();
    try {
      await connection.query('begin');
      const world = await connection.query<{ world_id: string }>(
        `select world.id as world_id
           from worlds world
           join lateral (
             select run.next_attempt_at, run.queued_at, run.id
               from manifest_generation_runs run
              where run.world_id = world.id
                and run.provider_configuration_id = $1
                and run.status = 'queued'
                and run.next_attempt_at <= clock_timestamp()
                and run.attempts < $2
              order by run.next_attempt_at, run.queued_at, run.id
              limit 1
           ) candidate on true
          where world.archived_at is null
            and (
              select count(*) from manifest_generation_runs active
               where active.world_id = world.id and active.status = 'running'
            ) < $3
          order by candidate.next_attempt_at, candidate.queued_at, candidate.id
          for update of world skip locked
          limit 1`,
        [providerConfigurationId, MAX_MANIFEST_GENERATION_ATTEMPTS, maximumConcurrentPerWorld],
      );
      const worldId = world.rows[0]?.world_id;
      if (!worldId) {
        await connection.query('commit');
        return null;
      }
      const claimed = await connection.query<ClaimedRunRow>(
        `with selected as (
           select id from manifest_generation_runs
            where world_id = $1
              and provider_configuration_id = $2
              and status = 'queued'
              and next_attempt_at <= clock_timestamp()
              and attempts < $3
            order by next_attempt_at, queued_at, id
            for update skip locked
            limit 1
         )
         update manifest_generation_runs run
            set status = 'running', stage = 'intent',
                progress_percent = greatest(run.progress_percent, 5),
                attempts = run.attempts + 1,
                claim_token = $4, claimed_at = clock_timestamp(),
                heartbeat_at = clock_timestamp(),
                started_at = coalesce(run.started_at, clock_timestamp()),
                updated_at = clock_timestamp(), row_version = run.row_version + 1
           from selected
          where run.id = selected.id
        returning run.id as run_id, run.world_id, run.prompt_submission_id,
                  run.requested_by_user_id, run.generator_schema_version,
                  run.prompt_template_version, run.provider_configuration_id,
                  run.parent_revision_id, run.expected_parent_content_hash,
                  run.seed, run.input_hash, run.resolved_input_hash,
                  run.attempts, run.repair_attempts, run.claim_token,
                  run.progress_percent, run.queued_at`,
        [worldId, providerConfigurationId, MAX_MANIFEST_GENERATION_ATTEMPTS, claimToken],
      );
      await connection.query('commit');
      const row = claimed.rows[0];
      return row ? toClaimedRun(row) : null;
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async loadInput(
    job: ClaimedManifestGenerationRun,
  ): Promise<ManifestGenerationInput | null> {
    const result = await this.pool.query<{ prompt_text: string | null }>(
      `select prompt.prompt_text
         from manifest_generation_runs run
         join world_prompt_submissions prompt
           on prompt.id = run.prompt_submission_id and prompt.world_id = run.world_id
        where run.id = $1 and run.status = 'running'
          and run.claim_token = $2 and run.attempts = $3`,
      claimParameters(job),
    );
    const prompt = result.rows[0]?.prompt_text;
    return typeof prompt === 'string' ? { prompt } : null;
  }

  public async loadProviderUsage(
    job: ClaimedManifestGenerationRun,
  ): Promise<ManifestGenerationDurableUsage | null> {
    const result = await this.pool.query<{
      cost_microunits: string;
      input_tokens: string;
      output_tokens: string;
      provider_calls: string;
      repair_attempts: number;
    }>(
      `select run.repair_attempts,
              run.provider_call_count::text as provider_calls,
              coalesce(sum(case
                when call.status = 'settled' then call.actual_cost_microunits
                when call.status = 'reserved' then call.reserved_cost_microunits
                else 0
              end),0)::text as cost_microunits,
              coalesce(sum(case
                when call.status = 'settled' then call.actual_input_tokens
                when call.status = 'reserved' then call.reserved_input_tokens
                else 0
              end),0)::text as input_tokens,
              coalesce(sum(case
                when call.status = 'settled' then call.actual_output_tokens
                when call.status = 'reserved' then call.reserved_output_tokens
                else 0
              end),0)::text as output_tokens
         from manifest_generation_runs run
         left join manifest_provider_calls call on call.run_id = run.id
        where run.id = $1 and run.status = 'running'
          and run.claim_token = $2 and run.attempts = $3
        group by run.id, run.repair_attempts, run.provider_call_count`,
      claimParameters(job),
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      costMicrounits: Number(row.cost_microunits),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      providerCalls: Number(row.provider_calls),
      repairAttempts: row.repair_attempts,
    };
  }

  public async reserveProviderCall(
    job: ClaimedManifestGenerationRun,
    callId: string,
    dailyBudgetMicrounits: number,
    request: ManifestProviderCallReservationRequest,
  ): Promise<ManifestProviderCallReservation | null> {
    assertUuid(callId, 'MANIFEST_PROVIDER_CALL_ID_INVALID');
    if (
      !Number.isSafeInteger(dailyBudgetMicrounits) ||
      dailyBudgetMicrounits < 0 ||
      dailyBudgetMicrounits > 2_147_483_647
    ) {
      throw new Error('MANIFEST_DAILY_BUDGET_INVALID');
    }
    const result = await this.pool.query<{
      id: string;
      max_cost_microunits: string;
      max_input_tokens: number;
      max_output_tokens: number;
    }>(
      `select id, reserved_cost_microunits::text as max_cost_microunits,
              reserved_input_tokens as max_input_tokens,
              reserved_output_tokens as max_output_tokens
         from worldgraph_reserve_manifest_provider_call(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
         )`,
      [
        callId,
        job.runId,
        job.claimToken,
        job.attempts,
        request.kind,
        request.providerConfigurationId,
        request.provider,
        request.model,
        dailyBudgetMicrounits,
        request.maxCostMicrounits,
        request.maxInputTokens,
        request.maxOutputTokens,
        9,
      ],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          maxCostMicrounits: Number(row.max_cost_microunits),
          maxInputTokens: row.max_input_tokens,
          maxOutputTokens: row.max_output_tokens,
        }
      : null;
  }

  public async settleProviderCall(
    job: ClaimedManifestGenerationRun,
    reservation: ManifestProviderCallReservation,
    settlement: ManifestProviderCallSettlement,
  ): Promise<boolean> {
    const result = await this.pool.query<{ settled: boolean }>(
      `select worldgraph_settle_manifest_provider_call(
         $1,$2,$3,$4,$5,$6,$7
       ) as settled`,
      [
        reservation.id,
        job.runId,
        job.claimToken,
        job.attempts,
        settlement.costMicrounits,
        settlement.inputTokens,
        settlement.outputTokens,
      ],
    );
    return result.rows[0]?.settled === true;
  }

  public async releaseProviderCall(
    job: ClaimedManifestGenerationRun,
    reservation: ManifestProviderCallReservation,
  ): Promise<boolean> {
    const result = await this.pool.query<{ released: boolean }>(
      `select worldgraph_release_manifest_provider_call($1,$2,$3,$4) as released`,
      [reservation.id, job.runId, job.claimToken, job.attempts],
    );
    return result.rows[0]?.released === true;
  }

  public async isClaimCurrent(job: ClaimedManifestGenerationRun): Promise<boolean> {
    const result = await this.pool.query<{ current: boolean }>(
      `select exists (
         select 1 from manifest_generation_runs
          where id = $1 and status = 'running'
            and claim_token = $2 and attempts = $3
       ) as current`,
      claimParameters(job),
    );
    return result.rows[0]?.current === true;
  }

  public async heartbeat(job: ClaimedManifestGenerationRun): Promise<boolean> {
    const result = await this.pool.query(
      `update manifest_generation_runs
          set heartbeat_at = clock_timestamp(), updated_at = clock_timestamp(),
              row_version = row_version + 1
        where id = $1 and status = 'running'
          and claim_token = $2 and attempts = $3`,
      claimParameters(job),
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async updateStage(
    job: ClaimedManifestGenerationRun,
    stage: ManifestGenerationStage,
    progressPercent: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(progressPercent) || progressPercent < 1 || progressPercent > 99) {
      throw new Error('MANIFEST_PROGRESS_INVALID');
    }
    const result = await this.pool.query(
      `update manifest_generation_runs
          set stage = $4,
              progress_percent = greatest(progress_percent, $5),
              repair_attempts = case when $4 = 'repair'
                then least(repair_attempts + 1, 2) else repair_attempts end,
              heartbeat_at = clock_timestamp(), updated_at = clock_timestamp(),
              row_version = row_version + 1
        where id = $1 and status = 'running'
          and claim_token = $2 and attempts = $3`,
      [...claimParameters(job), stage, progressPercent],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async freezeCatalog(
    job: ClaimedManifestGenerationRun,
    prompt: string,
  ): Promise<FrozenManifestCatalog | null> {
    const connection = await this.pool.connect();
    try {
      await connection.query('begin');
      const current = await connection.query<{
        primitive_catalog_snapshot_hash: Buffer | null;
        resolved_input_hash: Buffer | null;
      }>(
        `select primitive_catalog_snapshot_hash, resolved_input_hash
           from manifest_generation_runs
          where id = $1 and status = 'running'
            and claim_token = $2 and attempts = $3
          for update`,
        claimParameters(job),
      );
      const run = current.rows[0];
      if (!run) {
        await connection.query('rollback');
        return null;
      }
      const existing = await this.loadFrozenCatalogRows(connection, job.runId);
      if (existing.length > 0) {
        const catalog = { primitives: existing.map(definition) } satisfies ManifestCatalogSnapshot;
        const catalogSnapshotHash = manifestCatalogSnapshotHash(catalog);
        const resolvedInputHash = manifestGenerationInputHash({
          catalog,
          expectedParentContentHash: job.expectedParentContentHash,
          parentRevisionId: job.parentRevisionId,
          prompt,
          providerConfigurationId: job.providerConfigurationId,
          seed: job.seed,
        });
        if (
          run.primitive_catalog_snapshot_hash?.toString('hex') !== catalogSnapshotHash ||
          run.resolved_input_hash?.toString('hex') !== resolvedInputHash
        ) {
          throw new Error('MANIFEST_FROZEN_CATALOG_MISMATCH');
        }
        await connection.query('commit');
        return {
          catalog,
          catalogSnapshotHash,
          resolvedInputHash,
          retrievalCount: existing.length,
        };
      }
      if (run.primitive_catalog_snapshot_hash || run.resolved_input_hash) {
        throw new Error('MANIFEST_FROZEN_CATALOG_MISSING');
      }
      const rows = await this.loadPublishedCatalogRows(connection);
      if (rows.length > MAX_MANIFEST_CATALOG_ITEMS) {
        throw new Error('CATALOG_SCOPE_EXCEEDED');
      }
      if (rows.length === 0) throw new Error('NO_COMPATIBLE_PRIMITIVES');
      const ranked = this.rankCatalog(prompt, rows);
      const catalog = {
        primitives: ranked.map((entry) => entry.definition),
      } satisfies ManifestCatalogSnapshot;
      const catalogSnapshotHash = manifestCatalogSnapshotHash(catalog);
      const resolvedInputHash = manifestGenerationInputHash({
        catalog,
        expectedParentContentHash: job.expectedParentContentHash,
        parentRevisionId: job.parentRevisionId,
        prompt,
        providerConfigurationId: job.providerConfigurationId,
        seed: job.seed,
      });
      for (const [index, entry] of ranked.entries()) {
        await connection.query(
          `insert into generation_retrieval_items
            (run_id, rank, primitive_version_id, retrieval_score, reason, content_hash)
           values ($1,$2,$3,$4,$5::jsonb,decode($6,'hex'))`,
          [
            job.runId,
            index + 1,
            entry.definition.versionId,
            entry.score,
            JSON.stringify(entry.reason),
            entry.definition.contentHash,
          ],
        );
      }
      const frozen = await connection.query(
        `update manifest_generation_runs
            set primitive_catalog_snapshot_hash = decode($4,'hex'),
                resolved_input_hash = decode($5,'hex'),
                heartbeat_at = clock_timestamp(), updated_at = clock_timestamp(),
                row_version = row_version + 1
          where id = $1 and status = 'running'
            and claim_token = $2 and attempts = $3
            and primitive_catalog_snapshot_hash is null and resolved_input_hash is null`,
        [...claimParameters(job), catalogSnapshotHash, resolvedInputHash],
      );
      if ((frozen.rowCount ?? 0) !== 1) {
        await connection.query('rollback');
        return null;
      }
      await connection.query('commit');
      return {
        catalog,
        catalogSnapshotHash,
        resolvedInputHash,
        retrievalCount: ranked.length,
      };
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async publish(
    job: ClaimedManifestGenerationRun,
    publication: ManifestGenerationPublication,
  ): Promise<ManifestGenerationPublicationResult | null> {
    this.assertPublication(job, publication);
    const connection = await this.pool.connect();
    try {
      await connection.query('begin');
      const world = await connection.query<{ id: string }>(
        `select id from worlds where id = $1 and archived_at is null for update`,
        [job.worldId],
      );
      if (!world.rows[0]) {
        await connection.query('rollback');
        return null;
      }
      const current = await connection.query<{
        cost_microunits: string;
        current: number;
        input_tokens: string;
        output_tokens: string;
        provider_call_count: number;
        repair_attempts: number;
      }>(
        `select 1 as current, run.provider_call_count, run.repair_attempts,
                coalesce((select sum(case
                  when call.status = 'settled' then call.actual_cost_microunits
                  when call.status = 'reserved' then call.reserved_cost_microunits
                  else 0 end)
                  from manifest_provider_calls call where call.run_id = run.id),0)::text
                  as cost_microunits,
                coalesce((select sum(case
                  when call.status = 'settled' then call.actual_input_tokens
                  when call.status = 'reserved' then call.reserved_input_tokens
                  else 0 end)
                  from manifest_provider_calls call where call.run_id = run.id),0)::text
                  as input_tokens,
                coalesce((select sum(case
                  when call.status = 'settled' then call.actual_output_tokens
                  when call.status = 'reserved' then call.reserved_output_tokens
                  else 0 end)
                  from manifest_provider_calls call where call.run_id = run.id),0)::text
                  as output_tokens
           from manifest_generation_runs run
          where run.id = $1 and run.world_id = $4 and run.status = 'running'
            and run.claim_token = $2 and run.attempts = $3
            and run.primitive_catalog_snapshot_hash = decode($5,'hex')
            and run.resolved_input_hash = decode($6,'hex')
          for update`,
        [
          ...claimParameters(job),
          job.worldId,
          publication.outcome.catalogSnapshotHash,
          publication.outcome.resolvedInputHash,
        ],
      );
      const currentRun = current.rows[0];
      if (currentRun?.current !== 1) {
        await connection.query('rollback');
        return null;
      }
      if (
        currentRun.provider_call_count !== publication.outcome.providerCalls ||
        currentRun.repair_attempts !== publication.outcome.repairAttempts ||
        Number(currentRun.cost_microunits) !== publication.outcome.costMicrounits ||
        Number(currentRun.input_tokens) !== publication.outcome.inputTokens ||
        Number(currentRun.output_tokens) !== publication.outcome.outputTokens
      ) {
        throw new Error('GENERATION_OUTPUT_INVALID');
      }
      const next = await connection.query<{ revision_number: string }>(
        `select (coalesce(max(revision_number),0) + 1)::text as revision_number
           from manifest_revisions where world_id = $1`,
        [job.worldId],
      );
      const revisionNumber = Number(next.rows[0]?.revision_number ?? 1);
      await connection.query(
        `insert into manifest_revisions
          (id, world_id, revision_number, parent_revision_id,
           manifest_schema_version, canonical_manifest, content_hash, source,
           generation_run_id, generation_claim_token, created_by_user_id, generation_warnings)
         values ($1,$2,$3,$4,$5,$6::jsonb,decode($7,'hex'),'generation',$8,$9,$10,$11::jsonb)`,
        [
          publication.ids.revisionId,
          job.worldId,
          revisionNumber,
          job.parentRevisionId,
          MANIFEST_SCHEMA_VERSION,
          JSON.stringify(publication.outcome.envelope.manifest),
          publication.outcome.contentHash,
          job.runId,
          job.claimToken,
          job.requestedByUserId,
          JSON.stringify(publication.outcome.envelope.warnings),
        ],
      );
      await connection.query(
        `insert into manifest_validation_reports
          (id, manifest_revision_id, validator_version,
           primitive_catalog_snapshot_hash, valid, diagnostics, report_hash)
         values ($1,$2,$3,decode($4,'hex'),$5,$6::jsonb,decode($7,'hex'))`,
        [
          publication.ids.reportId,
          publication.ids.revisionId,
          MANIFEST_VALIDATOR_VERSION,
          publication.validation.catalogSnapshotHash,
          publication.validation.valid,
          JSON.stringify(publication.validation.diagnostics),
          publication.validation.reportHash,
        ],
      );
      for (const entry of this.uniqueProvenance(publication.outcome.envelope.provenance)) {
        await connection.query(
          `insert into manifest_field_provenance
            (manifest_revision_id, json_pointer, source_type, source_ref, source_hash)
           values ($1,$2,$3,$4,decode($5,'hex'))`,
          [
            publication.ids.revisionId,
            entry.pointer,
            entry.sourceType,
            entry.sourceRef,
            entry.sourceHash,
          ],
        );
      }
      const review = {
        assumptions: publication.outcome.envelope.assumptions,
        mode: publication.outcome.mode,
        suggestedFixes: publication.outcome.envelope.suggestedFixes,
        unresolvedQuestions: publication.outcome.envelope.unresolvedQuestions,
        warnings: publication.outcome.envelope.warnings,
      };
      const completed = await connection.query(
        `update manifest_generation_runs
            set status = 'succeeded', stage = 'complete', progress_percent = 100,
                generation_mode = $4, provider = $5, model = $6,
                output_review = $7::jsonb, output_revision_id = $8,
                input_token_count = $9, output_token_count = $10,
                cost_estimate_microunits = $11, latency_ms = $12,
                claim_token = null, completed_at = clock_timestamp(),
                updated_at = clock_timestamp(),
                row_version = row_version + 1
          where id = $1 and status = 'running'
            and claim_token = $2 and attempts = $3`,
        [
          ...claimParameters(job),
          publication.outcome.mode,
          publication.outcome.provider,
          publication.outcome.model,
          JSON.stringify(review),
          publication.ids.revisionId,
          publication.outcome.inputTokens,
          publication.outcome.outputTokens,
          publication.outcome.costMicrounits,
          Math.round(publication.outcome.latencyMs),
        ],
      );
      if ((completed.rowCount ?? 0) !== 1) {
        await connection.query('rollback');
        return null;
      }
      await connection.query('commit');
      return {
        contentHash: publication.outcome.contentHash,
        revisionId: publication.ids.revisionId,
        revisionNumber,
      };
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async generationWarnings(
    worldId: string,
    revisionId: string | null,
  ): Promise<ManifestGenerationWarning[]> {
    if (!revisionId) return [];
    const result = await this.pool.query<{ generation_warnings: ManifestGenerationWarning[] }>(
      `select generation_warnings from manifest_revisions
        where id = $1 and world_id = $2`,
      [revisionId, worldId],
    );
    if (!result.rows[0]) throw new Error('GENERATION_INPUT_MISMATCH');
    return result.rows[0].generation_warnings;
  }

  public async markFailure(
    job: ClaimedManifestGenerationRun,
    code: ManifestGenerationFailureCode,
    retryable: boolean,
  ): Promise<'failed' | 'lost_claim' | 'retry_scheduled'> {
    const scheduleRetry = retryable && job.attempts < MAX_MANIFEST_GENERATION_ATTEMPTS;
    const result = await this.pool.query(
      `update manifest_generation_runs
          set status = case when $4 then 'queued'::manifest_generation_status
                            else 'failed'::manifest_generation_status end,
              stage = case when $4 then 'queued' else stage end,
              progress_percent = greatest(progress_percent, 1),
              error_code = case when $4 then null else $5 end,
              next_attempt_at = case when $4 then greatest(
                next_attempt_at,
                statement_timestamp() +
                  (least($7::double precision,
                    $6::double precision * power(2, greatest(attempts - 1, 0))) *
                   interval '1 millisecond')
              ) else next_attempt_at end,
              claim_token = null,
              completed_at = case when $4 then null else statement_timestamp() end,
              updated_at = statement_timestamp(),
              row_version = row_version + 1
        where id = $1 and status = 'running'
          and claim_token = $2 and attempts = $3`,
      [...claimParameters(job), scheduleRetry, code, this.baseBackoffMs, this.maximumBackoffMs],
    );
    if ((result.rowCount ?? 0) !== 1) return 'lost_claim';
    return scheduleRetry ? 'retry_scheduled' : 'failed';
  }

  public async recoverExpiredClaims(
    claimTimeoutMs: number,
  ): Promise<{ failed: number; retried: number }> {
    if (!Number.isSafeInteger(claimTimeoutMs) || claimTimeoutMs < 1) {
      throw new Error('MANIFEST_CLAIM_TIMEOUT_INVALID');
    }
    const result = await this.pool.query<{ attempts: number }>(
      `update manifest_generation_runs
          set status = case when attempts < $2 then 'queued'::manifest_generation_status
                            else 'failed'::manifest_generation_status end,
              stage = case when attempts < $2 then 'queued' else stage end,
              progress_percent = greatest(progress_percent, 1),
              error_code = case when attempts < $2 then null else 'WORKER_LEASE_EXPIRED' end,
              next_attempt_at = case when attempts < $2 then greatest(
                next_attempt_at,
                statement_timestamp() +
                  (least($4::double precision,
                    $3::double precision * power(2, greatest(attempts - 1, 0))) *
                   interval '1 millisecond')
              ) else next_attempt_at end,
              claim_token = null,
              completed_at = case when attempts < $2 then null else statement_timestamp() end,
              updated_at = statement_timestamp(), row_version = row_version + 1
        where status = 'running'
          and heartbeat_at <=
            clock_timestamp() - ($1::double precision * interval '1 millisecond')
      returning attempts`,
      [claimTimeoutMs, MAX_MANIFEST_GENERATION_ATTEMPTS, this.baseBackoffMs, this.maximumBackoffMs],
    );
    return {
      failed: result.rows.filter((row) => row.attempts >= MAX_MANIFEST_GENERATION_ATTEMPTS).length,
      retried: result.rows.filter((row) => row.attempts < MAX_MANIFEST_GENERATION_ATTEMPTS).length,
    };
  }

  public async cleanupExpiredPrompts(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('MANIFEST_PROMPT_CLEANUP_LIMIT_INVALID');
    }
    const result = await this.pool.query(
      `with selected as (
         select prompt.id
           from world_prompt_submissions prompt
          where prompt.prompt_text is not null
            and prompt.retention_until <= clock_timestamp()
            and not exists (
              select 1 from manifest_generation_runs run
               where run.prompt_submission_id = prompt.id
                 and run.status in ('queued','running')
            )
          order by prompt.retention_until, prompt.id
          for update skip locked
          limit $1
       )
       update world_prompt_submissions prompt
          set prompt_text = null, redacted_at = clock_timestamp()
         from selected where prompt.id = selected.id`,
      [limit],
    );
    return result.rowCount ?? 0;
  }

  public async inspectBacklog(providerConfigurationId: string): Promise<ManifestGenerationBacklog> {
    const result = await this.pool.query<{
      oldest_age_ms: number | string | null;
      ready: string;
      running: string;
    }>(
      `select count(*) filter (where status = 'queued')::text as ready,
              count(*) filter (where status = 'running')::text as running,
              extract(epoch from (clock_timestamp() - min(queued_at))) * 1000
                as oldest_age_ms
         from manifest_generation_runs
        where provider_configuration_id = $1 and status in ('queued','running')`,
      [providerConfigurationId],
    );
    const row = result.rows[0];
    return {
      oldestAgeMs: Math.max(0, Number(row?.oldest_age_ms ?? 0)),
      ready: Number(row?.ready ?? 0),
      running: Number(row?.running ?? 0),
    };
  }

  private async loadPublishedCatalogRows(connection: PoolClient): Promise<CatalogRow[]> {
    const result = await connection.query<CatalogRow>(
      `with eligible as (
         select version.*,
                row_number() over (
                  partition by version.family_id
                  order by worldgraph_semver_sort_key(version.semver) collate "C" desc,
                           version.semver collate "C" desc, version.id desc
                ) as family_rank
           from primitive_versions version
          where version.lifecycle = 'published'
            and version.compatibility @>
              '{"archetype":"city-state","engine":"anvil","mvp":true}'::jsonb
       )
       select version.id, family.stable_key::text as stable_key, family.kind,
              version.semver, version.parameter_schema, version.defaults,
              version.compatibility, version.behavior_ref, version.content_hash,
              document.normalized_text,
              coalesce(array(
                select tag.tag::text from primitive_tags tag
                 where tag.primitive_version_id = version.id
                 order by tag.tag::text collate "C"
              ), array[]::text[]) as tags,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'key', dependency_family.stable_key::text,
                  'required', dependency.required,
                  'versionRange', dependency.version_range
                ) order by dependency_family.stable_key::text collate "C")
                  from primitive_dependencies dependency
                  join primitive_families dependency_family
                    on dependency_family.id = dependency.dependency_family_id
                 where dependency.primitive_version_id = version.id
              ), '[]'::jsonb) as dependencies,
              null::jsonb as reason, null::double precision as retrieval_score
         from eligible version
         join primitive_families family on family.id = version.family_id
         join primitive_search_documents document on document.primitive_version_id = version.id
        where version.family_rank = 1
        order by family.stable_key::text collate "C", version.semver collate "C" desc,
                 version.id desc
        limit $1`,
      [MAX_MANIFEST_CATALOG_ITEMS + 1],
    );
    return result.rows;
  }

  private async loadFrozenCatalogRows(
    connection: PoolClient,
    runId: string,
  ): Promise<CatalogRow[]> {
    const result = await connection.query<CatalogRow>(
      `select version.id, family.stable_key::text as stable_key, family.kind,
              version.semver, version.parameter_schema, version.defaults,
              version.compatibility, version.behavior_ref, item.content_hash,
              document.normalized_text, item.reason, item.retrieval_score,
              coalesce(array(
                select tag.tag::text from primitive_tags tag
                 where tag.primitive_version_id = version.id
                 order by tag.tag::text collate "C"
              ), array[]::text[]) as tags,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'key', dependency_family.stable_key::text,
                  'required', dependency.required,
                  'versionRange', dependency.version_range
                ) order by dependency_family.stable_key::text collate "C")
                  from primitive_dependencies dependency
                  join primitive_families dependency_family
                    on dependency_family.id = dependency.dependency_family_id
                 where dependency.primitive_version_id = version.id
              ), '[]'::jsonb) as dependencies
         from generation_retrieval_items item
         join primitive_versions version on version.id = item.primitive_version_id
          and version.content_hash = item.content_hash
         join primitive_families family on family.id = version.family_id
         join primitive_search_documents document on document.primitive_version_id = version.id
        where item.run_id = $1
        order by item.rank`,
      [runId],
    );
    return result.rows;
  }

  private rankCatalog(prompt: string, rows: readonly CatalogRow[]): RankedCatalogEntry[] {
    const ranked = rankCandidates(
      prompt,
      rows.map((row) => ({
        id: row.id,
        key: row.stable_key,
        kind: row.kind,
        normalizedText: row.normalized_text,
        tags: row.tags,
        version: row.semver,
      })),
    );
    const byId = new Map(ranked.map((entry, index) => [entry.id, { entry, index }]));
    return [...rows]
      .sort((left, right) => {
        const leftRank = byId.get(left.id)?.index ?? Number.POSITIVE_INFINITY;
        const rightRank = byId.get(right.id)?.index ?? Number.POSITIVE_INFINITY;
        return (
          leftRank - rightRank ||
          (left.stable_key < right.stable_key ? -1 : left.stable_key > right.stable_key ? 1 : 0) ||
          (left.semver < right.semver ? 1 : left.semver > right.semver ? -1 : 0) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        );
      })
      .map((row) => {
        const retrieval = byId.get(row.id)?.entry;
        return {
          definition: definition(row),
          reason: {
            lexicalRank: retrieval?.lexicalRank ?? null,
            matchedTags: retrieval?.matchedTags ?? [],
            matchedTerms: retrieval?.matchedTerms ?? [],
            requiredCatalogInclusion: retrieval === undefined,
            strategy: 'manifest-v1-lexical-tag',
            tagRank: retrieval?.tagRank ?? null,
          },
          score: retrieval?.score ?? 0,
        };
      });
  }

  private assertPublication(
    job: ClaimedManifestGenerationRun,
    publication: ManifestGenerationPublication,
  ): void {
    const { outcome, validation } = publication;
    if (
      !validation.valid ||
      validation.contentHash !== outcome.contentHash ||
      validation.catalogSnapshotHash !== outcome.catalogSnapshotHash ||
      manifestCatalogSnapshotHash(publication.catalog) !== outcome.catalogSnapshotHash ||
      outcome.inputHash !== job.inputHash ||
      job.resolvedInputHash === null ||
      outcome.resolvedInputHash !== job.resolvedInputHash ||
      outcome.providerConfigurationId !== job.providerConfigurationId ||
      outcome.seed !== job.seed ||
      !outcome.provider ||
      !outcome.model
    ) {
      throw new Error('GENERATION_OUTPUT_INVALID');
    }
    assertUuid(publication.ids.revisionId, 'MANIFEST_REVISION_ID_INVALID');
    assertUuid(publication.ids.reportId, 'MANIFEST_REPORT_ID_INVALID');
  }

  private uniqueProvenance(entries: readonly ManifestFieldProvenance[]): ManifestFieldProvenance[] {
    const unique = new Map<string, ManifestFieldProvenance>();
    for (const entry of entries) {
      unique.set(`${entry.pointer}\u0000${entry.sourceType}\u0000${entry.sourceRef}`, entry);
    }
    return [...unique.values()];
  }
}
