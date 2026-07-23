import type { EmbeddingResult, PrimitiveIndexDocument } from '@worldgraph/catalog';
import { PRIMITIVE_INDEX_SCHEMA_VERSION, type PrimitiveDraftInput } from '@worldgraph/contracts';
import type { Pool } from '@worldgraph/db';

export const MAX_PRIMITIVE_INDEX_ATTEMPTS = 5 as const;

export type PrimitiveIndexFailureCode =
  | 'CONTENT_STALE'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'VECTOR_INVALID';

export interface ClaimedPrimitiveIndexJob {
  attempts: number;
  contentHash: string;
  indexSchemaVersion: number;
  primitiveVersionId: string;
  providerConfigurationId: string;
  queuedAt: Date;
}

export interface PrimitiveIndexSource {
  contentHash: string;
  input: PrimitiveDraftInput;
  lifecycle: 'deprecated' | 'draft' | 'published';
}

export interface PrimitiveIndexBacklog {
  oldestAgeMs: number;
  ready: number;
}

export interface PrimitiveIndexJobDiscovery {
  inserted: number;
  remaining: number;
}

export interface PrimitiveIndexRepository {
  claimNext(
    providerConfigurationId: string,
    indexSchemaVersion?: number,
  ): Promise<ClaimedPrimitiveIndexJob | null>;
  completeFromCache(job: ClaimedPrimitiveIndexJob): Promise<boolean>;
  ensureCurrentJobs?(
    providerConfigurationId: string,
    indexSchemaVersion: number,
    limit: number,
  ): Promise<PrimitiveIndexJobDiscovery>;
  findCachedEmbedding(job: ClaimedPrimitiveIndexJob): Promise<boolean>;
  inspectBacklog(providerConfigurationId: string): Promise<PrimitiveIndexBacklog>;
  loadSource(primitiveVersionId: string): Promise<PrimitiveIndexSource | null>;
  markDisabled(job: ClaimedPrimitiveIndexJob): Promise<boolean>;
  markFailure(job: ClaimedPrimitiveIndexJob, code: PrimitiveIndexFailureCode): Promise<boolean>;
  markStale(job: ClaimedPrimitiveIndexJob): Promise<boolean>;
  recoverExpiredClaims(claimTimeoutMs: number): Promise<number>;
  storeEmbeddingAndComplete(
    job: ClaimedPrimitiveIndexJob,
    embeddingId: string,
    embedding: EmbeddingResult,
  ): Promise<boolean>;
  verifyLexicalDocument(
    job: ClaimedPrimitiveIndexJob,
    document: PrimitiveIndexDocument,
  ): Promise<boolean>;
}

interface ClaimedJobRow {
  attempts: number;
  content_hash: string;
  index_schema_version: number;
  primitive_version_id: string;
  provider_configuration_id: string;
  queued_at: Date;
}

interface SourceRow {
  behavior_ref: string | null;
  compatibility: Record<string, unknown>;
  content_hash: string;
  defaults: Record<string, unknown>;
  dependencies: PrimitiveDraftInput['dependencies'];
  display_name: string;
  documentation: string;
  kind: PrimitiveDraftInput['kind'];
  lifecycle: PrimitiveIndexSource['lifecycle'];
  parameter_schema: Record<string, unknown>;
  primitive_schema_version: 1;
  provenance: Record<string, unknown>;
  semver: string;
  stable_key: string;
  tags: string[];
  visual_hints: Record<string, unknown>;
}

function toClaimedJob(row: ClaimedJobRow): ClaimedPrimitiveIndexJob {
  return {
    attempts: row.attempts,
    contentHash: row.content_hash,
    indexSchemaVersion: row.index_schema_version,
    primitiveVersionId: row.primitive_version_id,
    providerConfigurationId: row.provider_configuration_id,
    queuedAt: row.queued_at,
  };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export interface PostgresPrimitiveIndexRepositoryOptions {
  baseBackoffMs?: number;
  maximumBackoffMs?: number;
}

/**
 * PostgreSQL owns queue state. BullMQ only wakes a reconciler; every claim and
 * terminal transition is guarded by the durable row and the claim attempt.
 */
export class PostgresPrimitiveIndexRepository implements PrimitiveIndexRepository {
  private readonly baseBackoffMs: number;
  private readonly maximumBackoffMs: number;

  public constructor(
    private readonly pool: Pool,
    options: PostgresPrimitiveIndexRepositoryOptions = {},
  ) {
    this.baseBackoffMs = options.baseBackoffMs ?? 5_000;
    this.maximumBackoffMs = options.maximumBackoffMs ?? 300_000;
  }

  public async ensureCurrentJobs(
    providerConfigurationId: string,
    indexSchemaVersion: number = PRIMITIVE_INDEX_SCHEMA_VERSION,
    limit = 250,
  ): Promise<PrimitiveIndexJobDiscovery> {
    if (
      !providerConfigurationId.trim() ||
      providerConfigurationId.length > 120 ||
      indexSchemaVersion !== PRIMITIVE_INDEX_SCHEMA_VERSION ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 250
    ) {
      throw new Error('PRIMITIVE_INDEX_DISCOVERY_CONFIGURATION_INVALID');
    }
    const result = await this.pool.query<{ inserted: string; remaining: string }>(
      `with missing as materialized (
         select version.id as primitive_version_id, version.content_hash
           from primitive_versions version
          where version.lifecycle in ('published', 'deprecated')
            and not exists (
              select 1
                from primitive_index_jobs job
               where job.primitive_version_id = version.id
                 and job.content_hash = version.content_hash
                 and job.index_schema_version = $2
                 and job.provider_configuration_id = $1
            )
          order by version.id
       ), selected as (
         select primitive_version_id, content_hash
           from missing
          limit $3
       ), inserted as (
         insert into primitive_index_jobs
           (primitive_version_id, content_hash, index_schema_version,
            provider_configuration_id)
         select primitive_version_id, content_hash, $2, $1
           from selected
         on conflict do nothing
         returning 1
       )
       select (select count(*)::text from inserted) as inserted,
              greatest(
                (select count(*) from missing) - (select count(*) from inserted),
                0
              )::text as remaining`,
      [providerConfigurationId, indexSchemaVersion, limit],
    );
    return {
      inserted: Number(result.rows[0]?.inserted ?? 0),
      remaining: Number(result.rows[0]?.remaining ?? 0),
    };
  }

  public async claimNext(
    providerConfigurationId: string,
    indexSchemaVersion = PRIMITIVE_INDEX_SCHEMA_VERSION,
  ): Promise<ClaimedPrimitiveIndexJob | null> {
    const result = await this.pool.query<ClaimedJobRow>(
      `with selected as (
         select primitive_version_id, content_hash, index_schema_version,
                provider_configuration_id
           from primitive_index_jobs
          where provider_configuration_id = $1
            and index_schema_version = $2
            and status in ('pending', 'failed')
            and next_attempt_at <= clock_timestamp()
            and attempts < $3
          order by next_attempt_at, queued_at, primitive_version_id, encode(content_hash, 'hex')
          for update skip locked
          limit 1
       )
       update primitive_index_jobs as job
          set status = 'running',
              attempts = job.attempts + 1,
              last_error_code = null,
              claimed_at = clock_timestamp(),
              completed_at = null,
              updated_at = clock_timestamp()
         from selected
        where job.primitive_version_id = selected.primitive_version_id
          and job.content_hash = selected.content_hash
          and job.index_schema_version = selected.index_schema_version
          and job.provider_configuration_id = selected.provider_configuration_id
       returning job.primitive_version_id,
                 encode(job.content_hash, 'hex') as content_hash,
                 job.index_schema_version, job.provider_configuration_id,
                 job.attempts, job.queued_at`,
      [providerConfigurationId, indexSchemaVersion, MAX_PRIMITIVE_INDEX_ATTEMPTS],
    );
    const row = result.rows[0];
    return row ? toClaimedJob(row) : null;
  }

  public async recoverExpiredClaims(claimTimeoutMs: number): Promise<number> {
    const result = await this.pool.query(
      `update primitive_index_jobs
          set status = case when attempts >= $2 then 'dead'::primitive_index_status
                            else 'failed'::primitive_index_status end,
              last_error_code = 'PROVIDER_FAILED',
              next_attempt_at = clock_timestamp() +
                (least($4::double precision,
                  $3::double precision * power(2, greatest(attempts - 1, 0))) *
                 interval '1 millisecond'),
              completed_at = case when attempts >= $2 then clock_timestamp() else null end,
              updated_at = clock_timestamp()
        where status = 'running'
          and claimed_at <= clock_timestamp() - ($1::double precision * interval '1 millisecond')`,
      [claimTimeoutMs, MAX_PRIMITIVE_INDEX_ATTEMPTS, this.baseBackoffMs, this.maximumBackoffMs],
    );
    return result.rowCount ?? 0;
  }

  public async loadSource(primitiveVersionId: string): Promise<PrimitiveIndexSource | null> {
    const result = await this.pool.query<SourceRow>(
      `select v.semver, v.primitive_schema_version, v.lifecycle, v.display_name,
              v.documentation, v.parameter_schema, v.defaults, v.compatibility,
              v.behavior_ref, v.visual_hints, v.provenance,
              encode(v.content_hash, 'hex') as content_hash,
              f.stable_key::text as stable_key, f.kind,
              coalesce(
                (select jsonb_agg(t.tag::text order by t.tag::text)
                   from primitive_tags t
                  where t.primitive_version_id = v.id),
                '[]'::jsonb
              ) as tags,
              coalesce(
                (select jsonb_agg(
                   jsonb_build_object(
                     'key', dependency_family.stable_key::text,
                     'versionRange', dependency.version_range,
                     'required', dependency.required,
                     'parameterMapping', dependency.parameter_mapping
                   ) order by dependency_family.stable_key::text)
                   from primitive_dependencies dependency
                   join primitive_families dependency_family
                     on dependency_family.id = dependency.dependency_family_id
                  where dependency.primitive_version_id = v.id),
                '[]'::jsonb
              ) as dependencies
         from primitive_versions v
         join primitive_families f on f.id = v.family_id
        where v.id = $1`,
      [primitiveVersionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      contentHash: row.content_hash,
      input: {
        behaviorRef: row.behavior_ref,
        compatibility: row.compatibility,
        defaults: row.defaults,
        dependencies: row.dependencies,
        displayName: row.display_name,
        documentation: row.documentation,
        key: row.stable_key,
        kind: row.kind,
        parameterSchema: row.parameter_schema,
        primitiveSchemaVersion: row.primitive_schema_version,
        provenance: row.provenance,
        tags: row.tags,
        version: row.semver,
        visualHints: row.visual_hints,
      },
      lifecycle: row.lifecycle,
    };
  }

  public async verifyLexicalDocument(
    job: ClaimedPrimitiveIndexJob,
    document: PrimitiveIndexDocument,
  ): Promise<boolean> {
    const result = await this.pool.query<{ valid: boolean }>(
      `select exists (
         select 1
           from primitive_index_jobs job
           join primitive_versions version
             on version.id = job.primitive_version_id
           join primitive_search_documents document
             on document.primitive_version_id = version.id
          where job.primitive_version_id = $1
            and job.content_hash = decode($2, 'hex')
            and job.index_schema_version = $3
            and job.provider_configuration_id = $4
            and job.status = 'running'
            and job.attempts = $5
            and version.lifecycle in ('published', 'deprecated')
            and version.content_hash = job.content_hash
            and document.content_hash = job.content_hash
            and document.index_schema_version = job.index_schema_version
            and document.normalized_text = $6
            and document.search_vector =
              setweight(to_tsvector('simple', $7), 'A') ||
              setweight(to_tsvector('simple', $8), 'B') ||
              setweight(to_tsvector('simple', $9), 'C')
       ) as valid`,
      [
        job.primitiveVersionId,
        job.contentHash,
        job.indexSchemaVersion,
        job.providerConfigurationId,
        job.attempts,
        document.normalizedText,
        document.primary,
        document.tags,
        document.documentation,
      ],
    );
    return result.rows[0]?.valid === true;
  }

  public async findCachedEmbedding(job: ClaimedPrimitiveIndexJob): Promise<boolean> {
    const result = await this.pool.query<{ cached: boolean }>(
      `select exists (
         select 1 from primitive_embeddings embedding
          where embedding.primitive_version_id = $1
            and embedding.provider_configuration_id = $2
            and embedding.content_hash = decode($3, 'hex')
            and embedding.dimensions = 1536
       ) as cached`,
      [job.primitiveVersionId, job.providerConfigurationId, job.contentHash],
    );
    return result.rows[0]?.cached === true;
  }

  public async completeFromCache(job: ClaimedPrimitiveIndexJob): Promise<boolean> {
    const result = await this.pool.query(
      `update primitive_index_jobs job
          set status = 'completed', last_error_code = null,
              completed_at = clock_timestamp(), updated_at = clock_timestamp()
        where job.primitive_version_id = $1
          and job.content_hash = decode($2, 'hex')
          and job.index_schema_version = $3
          and job.provider_configuration_id = $4
          and job.status = 'running'
          and job.attempts = $5
          and exists (
            select 1 from primitive_versions version
             where version.id = job.primitive_version_id
               and version.lifecycle in ('published', 'deprecated')
               and version.content_hash = job.content_hash
          )
          and exists (
            select 1 from primitive_search_documents document
             where document.primitive_version_id = job.primitive_version_id
               and document.content_hash = job.content_hash
               and document.index_schema_version = job.index_schema_version
          )
          and exists (
            select 1 from primitive_embeddings embedding
             where embedding.primitive_version_id = job.primitive_version_id
               and embedding.provider_configuration_id = job.provider_configuration_id
               and embedding.content_hash = job.content_hash
               and embedding.dimensions = 1536
          )`,
      this.jobParameters(job),
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async storeEmbeddingAndComplete(
    job: ClaimedPrimitiveIndexJob,
    embeddingId: string,
    embedding: EmbeddingResult,
  ): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      await connection.query('begin');
      const current = await connection.query<{ current: number }>(
        `select 1 as current
           from primitive_index_jobs job
           join primitive_versions version
             on version.id = job.primitive_version_id
           join primitive_search_documents document
             on document.primitive_version_id = version.id
          where job.primitive_version_id = $1
            and job.content_hash = decode($2, 'hex')
            and job.index_schema_version = $3
            and job.provider_configuration_id = $4
            and job.status = 'running'
            and job.attempts = $5
            and version.lifecycle in ('published', 'deprecated')
            and version.content_hash = job.content_hash
            and document.content_hash = job.content_hash
            and document.index_schema_version = job.index_schema_version
          for update of job, version`,
        this.jobParameters(job),
      );
      if (current.rows[0]?.current !== 1) {
        await connection.query('rollback');
        return false;
      }
      await connection.query(
        `insert into primitive_embeddings
          (id, primitive_version_id, provider_configuration_id, provider, model,
           dimensions, content_hash, embedding, token_estimate,
           cost_estimate_microunits, latency_ms)
         values ($1,$2,$3,$4,$5,1536,decode($6, 'hex'),$7::extensions.vector,$8,$9,$10)
         on conflict
          (primitive_version_id, provider_configuration_id, model, content_hash)
         do nothing`,
        [
          embeddingId,
          job.primitiveVersionId,
          job.providerConfigurationId,
          embedding.provider,
          embedding.model,
          job.contentHash,
          vectorLiteral(embedding.vector),
          embedding.tokenEstimate,
          embedding.costEstimateMicrounits ?? null,
          Math.round(embedding.latencyMs),
        ],
      );
      const completed = await connection.query(
        `update primitive_index_jobs
            set status = 'completed', last_error_code = null,
                completed_at = clock_timestamp(), updated_at = clock_timestamp()
          where primitive_version_id = $1
            and content_hash = decode($2, 'hex')
            and index_schema_version = $3
            and provider_configuration_id = $4
            and status = 'running'
            and attempts = $5`,
        this.jobParameters(job),
      );
      if ((completed.rowCount ?? 0) !== 1) {
        await connection.query('rollback');
        return false;
      }
      await connection.query('commit');
      return true;
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async markDisabled(job: ClaimedPrimitiveIndexJob): Promise<boolean> {
    return this.markTerminal(job, 'disabled', 'PROVIDER_DISABLED');
  }

  public async markStale(job: ClaimedPrimitiveIndexJob): Promise<boolean> {
    return this.markTerminal(job, 'stale', 'CONTENT_STALE');
  }

  public async markFailure(
    job: ClaimedPrimitiveIndexJob,
    code: PrimitiveIndexFailureCode,
  ): Promise<boolean> {
    if (code === 'CONTENT_STALE') return this.markStale(job);
    if (code === 'PROVIDER_DISABLED') return this.markDisabled(job);
    const terminal = job.attempts >= MAX_PRIMITIVE_INDEX_ATTEMPTS;
    const result = await this.pool.query(
      `update primitive_index_jobs
          set status = case when $6::boolean then 'dead'::primitive_index_status
                            else 'failed'::primitive_index_status end,
              last_error_code = $7,
              next_attempt_at = clock_timestamp() +
                (least($9::double precision,
                  $8::double precision * power(2, greatest(attempts - 1, 0))) *
                 interval '1 millisecond'),
              completed_at = case when $6::boolean then clock_timestamp() else null end,
              updated_at = clock_timestamp()
        where primitive_version_id = $1
          and content_hash = decode($2, 'hex')
          and index_schema_version = $3
          and provider_configuration_id = $4
          and status = 'running'
          and attempts = $5`,
      [...this.jobParameters(job), terminal, code, this.baseBackoffMs, this.maximumBackoffMs],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async inspectBacklog(providerConfigurationId: string): Promise<PrimitiveIndexBacklog> {
    const result = await this.pool.query<{ oldest_age_ms: number | string | null; ready: string }>(
      `select count(*)::text as ready,
              extract(epoch from
                (clock_timestamp() - min(queued_at))) * 1000 as oldest_age_ms
         from primitive_index_jobs
        where provider_configuration_id = $1
          and status in ('pending', 'failed', 'running')`,
      [providerConfigurationId],
    );
    const row = result.rows[0];
    return {
      oldestAgeMs: Math.max(0, Number(row?.oldest_age_ms ?? 0)),
      ready: Number(row?.ready ?? 0),
    };
  }

  private jobParameters(job: ClaimedPrimitiveIndexJob): unknown[] {
    return [
      job.primitiveVersionId,
      job.contentHash,
      job.indexSchemaVersion,
      job.providerConfigurationId,
      job.attempts,
    ];
  }

  private async markTerminal(
    job: ClaimedPrimitiveIndexJob,
    status: 'disabled' | 'stale',
    code: 'CONTENT_STALE' | 'PROVIDER_DISABLED',
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update primitive_index_jobs
          set status = $6::primitive_index_status, last_error_code = $7,
              completed_at = clock_timestamp(), updated_at = clock_timestamp()
        where primitive_version_id = $1
          and content_hash = decode($2, 'hex')
          and index_schema_version = $3
          and provider_configuration_id = $4
          and status = 'running'
          and attempts = $5`,
      [...this.jobParameters(job), status, code],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
