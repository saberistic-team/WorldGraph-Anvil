import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type {
  PrimitiveDependencyView,
  PrimitiveDraftInput,
  PrimitiveIndexState,
  PrimitiveKind,
  PrimitiveLifecycle,
  PrimitiveListItem,
  PrimitiveVersionView,
} from '@worldgraph/contracts';
import type { PrimitiveIndexDocument, PublishedPrimitiveRef } from '@worldgraph/catalog';

import { ApplicationError, isPostgresError } from '../application/errors.js';

interface Executor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface PrimitiveCursorTuple {
  id: string;
  key: string;
  sortKey: string;
  version: string;
}

export interface PrimitiveListFilter {
  cursor: PrimitiveCursorTuple | null;
  kinds: readonly PrimitiveKind[];
  lifecycle: PrimitiveLifecycle;
  limit: number;
  tags: readonly string[];
  tsquery: string | null;
}

export interface ResolvedDependencyWrite {
  dependencyFamilyId: string;
  parameterMapping: Record<string, unknown>;
  required: boolean;
  resolvedContentHash: string | null;
  resolvedVersionId: string | null;
  versionRange: string;
}

export interface PublishedCatalogEntry extends PublishedPrimitiveRef {
  familyId: string;
}

interface PrimitiveRow extends QueryResultRow {
  behavior_ref: string | null;
  compatibility: Record<string, unknown>;
  content_hash: Buffer;
  created_at: Date;
  defaults: Record<string, unknown>;
  deprecated_at: Date | null;
  deprecation_reason: string | null;
  display_name: string;
  documentation: string;
  family_id: string;
  id: string;
  index_error_code: string | null;
  index_state: PrimitiveIndexState;
  kind: PrimitiveKind;
  lifecycle: PrimitiveLifecycle;
  parameter_schema: Record<string, unknown>;
  primitive_schema_version: 1;
  provenance: Record<string, unknown>;
  published_at: Date | null;
  row_version: number;
  semver: string;
  stable_key: string;
  tags: string[];
  updated_at: Date;
  visual_hints: Record<string, unknown>;
}

export interface RetrievalRow extends PrimitiveRow {
  lexical_score: number;
  tag_score: number;
  last_error_code: string | null;
  model: string | null;
  normalized_text: string;
  provider: string | null;
  provider_configuration_id: string | null;
  retrieval_index_state: PrimitiveIndexState;
  vector_similarity: number | null;
}

export interface PrimitiveRetrievalFilter {
  compatibility: Record<string, unknown>;
  kinds: readonly PrimitiveKind[];
  model: string | null;
  provider: string | null;
  providerConfigurationId: string;
  queryVector: readonly number[] | null;
  tags: readonly string[];
  terms: readonly string[];
  tsquery: string;
}

function listItem(row: PrimitiveRow): PrimitiveListItem {
  return {
    contentHash: row.content_hash.toString('hex'),
    createdAt: row.created_at.toISOString(),
    displayName: row.display_name,
    id: row.id,
    indexErrorCode: row.index_error_code,
    indexState: row.index_state,
    key: row.stable_key,
    kind: row.kind,
    lifecycle: row.lifecycle,
    publishedAt: row.published_at?.toISOString() ?? null,
    rowVersion: row.row_version,
    tags: row.tags,
    updatedAt: row.updated_at.toISOString(),
    version: row.semver,
  };
}

function primitiveSelect(providerConfigurationParameter: '$4' | '$7' | '$10'): string {
  return `
  select v.id, v.family_id, f.stable_key::text, f.kind, v.semver,
         v.primitive_schema_version, v.lifecycle, v.display_name, v.documentation,
         v.parameter_schema, v.defaults, v.compatibility, v.behavior_ref,
         v.visual_hints, v.provenance, v.content_hash, v.row_version,
         v.created_at, v.updated_at, v.published_at, v.deprecated_at,
         v.deprecation_reason,
         coalesce(array(
           select t.tag::text from primitive_tags t
            where t.primitive_version_id = v.id order by t.tag::text collate "C"
         ), array[]::text[]) as tags,
         coalesce((
           select j.status::text from primitive_index_jobs j
            where j.primitive_version_id = v.id and j.content_hash = v.content_hash
              and j.index_schema_version = 1
              and j.provider_configuration_id = ${providerConfigurationParameter}
            order by j.updated_at desc
           limit 1
         ), 'not_requested') as index_state,
         (
           select case when j.last_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
                       then j.last_error_code else null end
             from primitive_index_jobs j
            where j.primitive_version_id = v.id and j.content_hash = v.content_hash
              and j.index_schema_version = 1
              and j.provider_configuration_id = ${providerConfigurationParameter}
            order by j.updated_at desc
            limit 1
         ) as index_error_code`;
}

export class PrimitiveRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly activeProviderConfigurationId = 'disabled-v1',
    private readonly executor: Executor = pool,
  ) {}

  public async transaction<T>(
    operation: (repository: PrimitiveRepository) => Promise<T>,
  ): Promise<T> {
    const connection: PoolClient = await this.pool.connect();
    try {
      await connection.query('begin');
      const result = await operation(
        new PrimitiveRepository(this.pool, this.activeProviderConfigurationId, connection),
      );
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async catalogVersionCounts(): Promise<
    { count: number; kind: PrimitiveKind; lifecycle: PrimitiveLifecycle }[]
  > {
    const result = await this.executor.query<{
      count: string;
      kind: PrimitiveKind;
      lifecycle: PrimitiveLifecycle;
    }>(
      `select f.kind,v.lifecycle,count(*)::text as count
         from primitive_versions v join primitive_families f on f.id=v.family_id
        group by f.kind,v.lifecycle order by f.kind,v.lifecycle`,
    );
    return result.rows.map((row) => ({
      count: Number(row.count),
      kind: row.kind,
      lifecycle: row.lifecycle,
    }));
  }

  public async list(
    filter: PrimitiveListFilter,
  ): Promise<{ items: PrimitiveListItem[]; tail: PrimitiveCursorTuple | null }> {
    const cursor = filter.cursor;
    const result = await this.executor.query<PrimitiveRow & { semver_sort_key: string }>(
      `${primitiveSelect('$10')}, worldgraph_semver_sort_key(v.semver) as semver_sort_key,
         s.search_vector
       from primitive_versions v join primitive_families f on f.id = v.family_id
       join primitive_search_documents s on s.primitive_version_id = v.id
      where v.lifecycle = $1::primitive_lifecycle
        and (cardinality($2::text[]) = 0 or f.kind = any($2::primitive_kind[]))
        and not exists (
          select 1 from unnest($3::text[]) requested(tag)
           where not exists (
             select 1 from primitive_tags actual
              where actual.primitive_version_id = v.id and actual.tag = requested.tag
           )
        )
        and ($4::text is null or s.search_vector @@ to_tsquery('simple', $4))
        and ($5::text is null or
          f.stable_key::text collate "C" > $5 collate "C" or
          (f.stable_key::text collate "C" = $5 collate "C" and (
            worldgraph_semver_sort_key(v.semver) collate "C" < $6 collate "C" or
            (worldgraph_semver_sort_key(v.semver) collate "C" = $6 collate "C" and (
              v.semver collate "C" < $7 collate "C" or
              (v.semver collate "C" = $7 collate "C" and v.id < $8::uuid)
            ))
          ))
        )
      order by f.stable_key::text collate "C", worldgraph_semver_sort_key(v.semver) collate "C" desc,
               v.semver collate "C" desc, v.id desc
      limit $9`,
      [
        filter.lifecycle,
        [...filter.kinds],
        [...filter.tags],
        filter.tsquery,
        cursor?.key ?? null,
        cursor?.sortKey ?? null,
        cursor?.version ?? null,
        cursor?.id ?? null,
        filter.limit + 1,
        this.activeProviderConfigurationId,
      ],
    );
    const page = result.rows.slice(0, filter.limit);
    const last = page.at(-1);
    return {
      items: page.map(listItem),
      tail:
        result.rows.length > filter.limit && last
          ? {
              id: last.id,
              key: last.stable_key,
              sortKey: last.semver_sort_key,
              version: last.semver,
            }
          : null,
    };
  }

  public async getVersion(
    key: string,
    version: string,
    includeDraft: boolean,
    lock = false,
  ): Promise<PrimitiveVersionView | null> {
    const result = await this.executor.query<PrimitiveRow>(
      `${primitiveSelect('$4')}
        from primitive_versions v join primitive_families f on f.id = v.family_id
        where f.stable_key = $1 and v.semver = $2
          and (v.lifecycle <> 'draft' or $3::boolean)
        ${lock ? 'for update of v' : ''}`,
      [key, version, includeDraft, this.activeProviderConfigurationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.versionView(row, await this.dependencies(row.id));
  }

  public async dependencies(versionId: string): Promise<PrimitiveDependencyView[]> {
    const result = await this.executor.query<{
      dependency_family_id: string;
      key: string;
      parameter_mapping: Record<string, unknown>;
      required: boolean;
      resolved_content_hash: Buffer | null;
      resolved_version: string | null;
      resolved_version_id: string | null;
      version_range: string;
    }>(
      `select d.dependency_family_id, f.stable_key::text as key, d.version_range,
              d.required, d.parameter_mapping, d.resolved_version_id,
              d.resolved_content_hash, resolved.semver as resolved_version
         from primitive_dependencies d
         join primitive_families f on f.id = d.dependency_family_id
         left join primitive_versions resolved on resolved.id = d.resolved_version_id
        where d.primitive_version_id = $1
        order by f.stable_key::text collate "C"`,
      [versionId],
    );
    return result.rows.map((row) => ({
      dependencyFamilyId: row.dependency_family_id,
      key: row.key,
      parameterMapping: row.parameter_mapping,
      required: row.required,
      resolvedContentHash: row.resolved_content_hash?.toString('hex') ?? null,
      resolvedVersion: row.resolved_version,
      resolvedVersionId: row.resolved_version_id,
      versionRange: row.version_range,
    }));
  }

  public async loadPublishedCatalog(): Promise<PublishedCatalogEntry[]> {
    const result = await this.executor.query<{
      content_hash: Buffer;
      family_id: string;
      id: string;
      semver: string;
      stable_key: string;
    }>(
      `select v.id, v.family_id, f.stable_key::text, v.semver, v.content_hash
         from primitive_versions v join primitive_families f on f.id = v.family_id
        where v.lifecycle = 'published'
        order by f.stable_key::text collate "C", worldgraph_semver_sort_key(v.semver) collate "C" desc,
                 v.semver collate "C" desc`,
    );
    const catalog: PublishedCatalogEntry[] = [];
    for (const row of result.rows) {
      catalog.push({
        contentHash: row.content_hash.toString('hex'),
        dependencies: (await this.dependencies(row.id)).map((dependency) => ({
          key: dependency.key,
          parameterMapping: dependency.parameterMapping,
          required: dependency.required,
          versionRange: dependency.versionRange,
        })),
        familyId: row.family_id,
        key: row.stable_key,
        version: row.semver,
        versionId: row.id,
      });
    }
    return catalog;
  }

  public async family(
    key: string,
    lock = false,
  ): Promise<{
    displayName: string;
    id: string;
    kind: PrimitiveKind;
    published: boolean;
    versionCount: number;
  } | null> {
    const result = await this.executor.query<{
      display_name: string;
      id: string;
      kind: PrimitiveKind;
      published: boolean;
      version_count: string;
    }>(
      `select f.id, f.kind, f.display_name,
              exists(select 1 from primitive_versions v where v.family_id = f.id and v.lifecycle <> 'draft') as published,
              (select count(*)::text from primitive_versions v where v.family_id=f.id) as version_count
         from primitive_families f where f.stable_key = $1 ${lock ? 'for update of f' : ''}`,
      [key],
    );
    const row = result.rows[0];
    return row
      ? {
          displayName: row.display_name,
          id: row.id,
          kind: row.kind,
          published: row.published,
          versionCount: Number(row.version_count),
        }
      : null;
  }

  public async insertFamily(input: {
    actorUserId: string;
    displayName: string;
    id: string;
    key: string;
    kind: PrimitiveKind;
  }): Promise<void> {
    try {
      await this.executor.query(
        `insert into primitive_families(id,stable_key,kind,display_name,created_by_user_id)
         values ($1,$2,$3,$4,$5)`,
        [input.id, input.key, input.kind, input.displayName, input.actorUserId],
      );
    } catch (error) {
      if (isPostgresError(error, '23505'))
        throw new ApplicationError(
          'PRIMITIVE_VERSION_EXISTS',
          'That primitive version already exists.',
          409,
        );
      throw error;
    }
  }

  public async updateFamilyDisplay(familyId: string, displayName: string): Promise<void> {
    await this.executor.query(
      'update primitive_families set display_name = $2, updated_at = now() where id = $1',
      [familyId, displayName],
    );
  }

  public async insertDraft(input: {
    actorUserId: string;
    contentHash: string;
    familyId: string;
    id: string;
    parsed: { build: string[]; major: string; minor: string; patch: string; prerelease: string[] };
    primitive: PrimitiveDraftInput;
  }): Promise<void> {
    const p = input.primitive;
    try {
      await this.executor.query(
        `insert into primitive_versions(
          id,family_id,semver,semver_major,semver_minor,semver_patch,
          semver_prerelease,semver_build,primitive_schema_version,display_name,
          documentation,parameter_schema,defaults,compatibility,behavior_ref,
          visual_hints,provenance,content_hash,created_by_user_id
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          input.id,
          input.familyId,
          p.version,
          input.parsed.major,
          input.parsed.minor,
          input.parsed.patch,
          input.parsed.prerelease.join('.') || null,
          input.parsed.build.join('.') || null,
          p.displayName,
          p.documentation,
          JSON.stringify(p.parameterSchema),
          JSON.stringify(p.defaults),
          JSON.stringify(p.compatibility),
          p.behaviorRef ?? null,
          JSON.stringify(p.visualHints),
          JSON.stringify(p.provenance),
          Buffer.from(input.contentHash, 'hex'),
          input.actorUserId,
        ],
      );
    } catch (error) {
      if (isPostgresError(error, '23505'))
        throw new ApplicationError(
          'PRIMITIVE_VERSION_EXISTS',
          'That primitive version already exists.',
          409,
        );
      throw error;
    }
  }

  public async updateDraft(input: {
    contentHash: string;
    expectedRowVersion: number;
    parsed: { build: string[]; major: string; minor: string; patch: string; prerelease: string[] };
    primitive: PrimitiveDraftInput;
    versionId: string;
  }): Promise<void> {
    const p = input.primitive;
    const result = await this.executor.query(
      `update primitive_versions set
        semver=$3,semver_major=$4,semver_minor=$5,semver_patch=$6,
        semver_prerelease=$7,semver_build=$8,display_name=$9,documentation=$10,
        parameter_schema=$11,defaults=$12,compatibility=$13,behavior_ref=$14,
        visual_hints=$15,provenance=$16,content_hash=$17,
        row_version=row_version+1,updated_at=now()
       where id=$1 and lifecycle='draft' and row_version=$2`,
      [
        input.versionId,
        input.expectedRowVersion,
        p.version,
        input.parsed.major,
        input.parsed.minor,
        input.parsed.patch,
        input.parsed.prerelease.join('.') || null,
        input.parsed.build.join('.') || null,
        p.displayName,
        p.documentation,
        JSON.stringify(p.parameterSchema),
        JSON.stringify(p.defaults),
        JSON.stringify(p.compatibility),
        p.behaviorRef ?? null,
        JSON.stringify(p.visualHints),
        JSON.stringify(p.provenance),
        Buffer.from(input.contentHash, 'hex'),
      ],
    );
    if ((result.rowCount ?? 0) !== 1)
      throw new ApplicationError('STALE_VERSION', 'The primitive draft has changed.', 409);
  }

  public async replaceDerived(input: {
    contentHash: string;
    dependencies: readonly ResolvedDependencyWrite[];
    document: PrimitiveIndexDocument;
    tags: readonly string[];
    versionId: string;
  }): Promise<void> {
    await this.executor.query('delete from primitive_tags where primitive_version_id = $1', [
      input.versionId,
    ]);
    await this.executor.query(
      'delete from primitive_dependencies where primitive_version_id = $1',
      [input.versionId],
    );
    for (const tag of input.tags)
      await this.executor.query(
        'insert into primitive_tags(primitive_version_id,tag) values ($1,$2)',
        [input.versionId, tag],
      );
    for (const dependency of input.dependencies) {
      await this.executor.query(
        `insert into primitive_dependencies(
          primitive_version_id,dependency_family_id,version_range,required,
          parameter_mapping,resolved_version_id,resolved_content_hash
        ) values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.versionId,
          dependency.dependencyFamilyId,
          dependency.versionRange,
          dependency.required,
          JSON.stringify(dependency.parameterMapping),
          dependency.resolvedVersionId,
          dependency.resolvedContentHash
            ? Buffer.from(dependency.resolvedContentHash, 'hex')
            : null,
        ],
      );
    }
    await this.executor.query(
      `insert into primitive_search_documents(
        primitive_version_id,index_schema_version,content_hash,search_vector,normalized_text
      ) values ($1,1,$2,
        setweight(to_tsvector('simple',$3),'A') || setweight(to_tsvector('simple',$4),'B') ||
        setweight(to_tsvector('simple',$5),'C'),$6)
      on conflict (primitive_version_id) do update set
        index_schema_version=1,content_hash=excluded.content_hash,
        search_vector=excluded.search_vector,normalized_text=excluded.normalized_text,updated_at=now()`,
      [
        input.versionId,
        Buffer.from(input.contentHash, 'hex'),
        input.document.primary,
        input.document.tags,
        input.document.documentation,
        input.document.normalizedText,
      ],
    );
  }

  public async publish(
    versionId: string,
    actorUserId: string,
    expectedRowVersion: number,
  ): Promise<void> {
    const result = await this.executor.query(
      `update primitive_versions set lifecycle='published',published_by_user_id=$2,
        published_at=now(),row_version=row_version+1,updated_at=now()
       where id=$1 and lifecycle='draft' and row_version=$3`,
      [versionId, actorUserId, expectedRowVersion],
    );
    if ((result.rowCount ?? 0) !== 1)
      throw new ApplicationError('STALE_VERSION', 'The primitive draft has changed.', 409);
  }

  public async deprecate(
    versionId: string,
    actorUserId: string,
    expectedRowVersion: number,
    reason: string,
  ): Promise<void> {
    const result = await this.executor.query(
      `update primitive_versions set lifecycle='deprecated',deprecated_by_user_id=$2,
        deprecated_at=now(),deprecation_reason=$4,row_version=row_version+1,updated_at=now()
       where id=$1 and lifecycle='published' and row_version=$3`,
      [versionId, actorUserId, expectedRowVersion, reason],
    );
    if ((result.rowCount ?? 0) !== 1)
      throw new ApplicationError('STALE_VERSION', 'The primitive version has changed.', 409);
  }

  public async requestIndex(
    versionId: string,
    contentHash: string,
    providerConfigurationId: string,
  ): Promise<void> {
    await this.executor.query(
      `insert into primitive_index_jobs(
        primitive_version_id,content_hash,index_schema_version,provider_configuration_id
      ) values ($1,$2,1,$3)
      on conflict (primitive_version_id,content_hash,index_schema_version,provider_configuration_id)
      do update set status='pending',attempts=0,last_error_code=null,claimed_at=null,
                    queued_at=now(),next_attempt_at=now(),completed_at=null,updated_at=now()`,
      [versionId, Buffer.from(contentHash, 'hex'), providerConfigurationId],
    );
  }

  public async retrievalScopeSize(input: {
    compatibility: Record<string, unknown>;
    kinds: readonly PrimitiveKind[];
    tags: readonly string[];
  }): Promise<number> {
    const result = await this.executor.query<{ count: string }>(
      `select count(*)::text as count
         from primitive_versions v join primitive_families f on f.id=v.family_id
        where v.lifecycle='published'
          and (cardinality($1::text[])=0 or f.kind=any($1::primitive_kind[]))
          and not exists (
            select 1 from unnest($2::text[]) requested(tag)
             where not exists(
               select 1 from primitive_tags actual
                where actual.primitive_version_id=v.id and actual.tag=requested.tag
             )
          )
          and v.compatibility @> $3::jsonb`,
      [[...input.kinds], [...input.tags], JSON.stringify(input.compatibility)],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  public async retrievalSnapshot(
    input: PrimitiveRetrievalFilter,
  ): Promise<{ rows: RetrievalRow[]; scopeSize: number }> {
    const connection = await this.pool.connect();
    try {
      await connection.query('begin isolation level repeatable read read only');
      const repository = new PrimitiveRepository(
        this.pool,
        this.activeProviderConfigurationId,
        connection,
      );
      const scopeSize = await repository.retrievalScopeSize(input);
      const rows = scopeSize > 500 ? [] : await repository.retrieval(input);
      await connection.query('commit');
      return { rows, scopeSize };
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  private async retrieval(input: PrimitiveRetrievalFilter): Promise<RetrievalRow[]> {
    const queryVector = input.queryVector ? `[${input.queryVector.join(',')}]` : null;
    return (
      await this.executor.query<RetrievalRow>(
        `with request_parameters as (select $2::text as tsquery), filtered as (
         select v.id, f.stable_key::text as stable_key, v.semver,
                worldgraph_semver_sort_key(v.semver) as semver_sort_key,
                coalesce(scored.lexical_score, 0)::float8 as lexical_score,
                embedding.provider_configuration_id, embedding.provider, embedding.model,
                case when $6::text is null or embedding.embedding is null then null
                     else (1 - (embedding.embedding OPERATOR(extensions.<=>) $6::extensions.vector))::float8
                 end as vector_similarity,
                coalesce(job.status::text, 'not_requested') as retrieval_index_state,
                case when job.last_error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
                     then job.last_error_code else null end as last_error_code
           from primitive_versions v
           join primitive_families f on f.id = v.family_id
           join primitive_search_documents s on s.primitive_version_id = v.id
           left join lateral (
             select sum(case right(position.value,1)
               when 'A' then 4 when 'B' then 2 when 'C' then 1 else 1 end)::float8 as lexical_score
               from regexp_matches(s.search_vector::text, '''([a-z0-9]+)'':([0-9A-D,]+)', 'g') lexeme(parts)
               cross join lateral unnest(string_to_array(lexeme.parts[2],',')) position(value)
               join unnest($1::text[]) requested(term) on requested.term = lexeme.parts[1]
           ) scored on true
           left join lateral (
             select e.provider_configuration_id,e.provider,e.model,e.embedding
               from primitive_embeddings e
              where e.primitive_version_id=v.id and e.content_hash=v.content_hash
                and e.provider_configuration_id=$7
                and e.provider=$8 and e.model=$9
              order by e.created_at desc limit 1
           ) embedding on true
           left join lateral (
             select j.status,j.last_error_code from primitive_index_jobs j
              where j.primitive_version_id=v.id and j.content_hash=v.content_hash
                and j.index_schema_version=1 and j.provider_configuration_id=$7
              order by j.updated_at desc limit 1
           ) job on true
          where v.lifecycle='published'
            and (cardinality($3::text[])=0 or f.kind=any($3::primitive_kind[]))
            and not exists (
              select 1 from unnest($4::text[]) requested(tag)
               where not exists(select 1 from primitive_tags actual where actual.primitive_version_id=v.id and actual.tag=requested.tag)
            )
            and v.compatibility @> $5::jsonb
       ), tag_df as (
         select t.tag::text as tag, count(*)::float8 as document_frequency
           from filtered scope
           join primitive_tags t on t.primitive_version_id=scope.id
          group by t.tag
       ), eligible as (
         select filtered.*,
                coalesce((
                  select sum(cardinality(string_to_array(t.tag::text, '-'))::float8 / df.document_frequency)
                    from primitive_tags t join tag_df df on df.tag=t.tag::text
                   where t.primitive_version_id=filtered.id
                     and string_to_array(t.tag::text, '-') <@ $1::text[]
                ),0)::float8 as tag_score
           from filtered
          where filtered.vector_similarity is not null or filtered.lexical_score > 0 or exists (
            select 1 from primitive_tags query_tag
             where query_tag.primitive_version_id=filtered.id
               and string_to_array(query_tag.tag::text, '-') <@ $1::text[]
          )
       ), candidate_ids as (
         select id from (
           select id from eligible where lexical_score > 0
            order by lexical_score desc, stable_key collate "C", semver_sort_key collate "C" desc,
                     semver collate "C" desc, id desc limit 500
         ) lexical
         union
         select id from (
           select id from eligible where tag_score > 0
            order by tag_score desc, stable_key collate "C", semver_sort_key collate "C" desc,
                     semver collate "C" desc, id desc limit 500
         ) tags
         union
         select id from (
           select id from eligible where vector_similarity is not null
            order by vector_similarity desc, stable_key collate "C", semver_sort_key collate "C" desc,
                     semver collate "C" desc, id desc limit 500
         ) vectors
       )
       ${primitiveSelect('$7')}, eligible.lexical_score, eligible.tag_score, s.normalized_text,
          eligible.provider_configuration_id, eligible.provider, eligible.model,
          eligible.retrieval_index_state, eligible.last_error_code, eligible.vector_similarity
         from candidate_ids candidates
         join eligible on eligible.id=candidates.id
         join primitive_versions v on v.id=eligible.id
         join primitive_families f on f.id=v.family_id
         join primitive_search_documents s on s.primitive_version_id=v.id`,
        [
          [...input.terms],
          input.tsquery,
          [...input.kinds],
          [...input.tags],
          JSON.stringify(input.compatibility),
          queryVector,
          input.providerConfigurationId,
          input.provider,
          input.model,
        ],
      )
    ).rows;
  }

  public async dependencyClosure(versionId: string): Promise<
    {
      contentHash: string;
      familyId: string;
      key: string;
      primitiveVersionId: string;
      version: string;
    }[]
  > {
    const result = await this.executor.query<{
      content_hash: Buffer;
      family_id: string;
      id: string;
      key: string;
      semver: string;
    }>(
      `with recursive closure(id) as (
         select d.resolved_version_id from primitive_dependencies d
          where d.primitive_version_id=$1 and d.resolved_version_id is not null
         union
         select d.resolved_version_id from closure c join primitive_dependencies d on d.primitive_version_id=c.id
          where d.resolved_version_id is not null
       )
       select v.id,v.family_id,f.stable_key::text as key,v.semver,v.content_hash
         from closure c join primitive_versions v on v.id=c.id join primitive_families f on f.id=v.family_id
        order by f.stable_key::text collate "C", worldgraph_semver_sort_key(v.semver) collate "C" desc,
                 v.semver collate "C" desc`,
      [versionId],
    );
    return result.rows.map((row) => ({
      contentHash: row.content_hash.toString('hex'),
      familyId: row.family_id,
      key: row.key,
      primitiveVersionId: row.id,
      version: row.semver,
    }));
  }

  public async beginIdempotency(input: {
    actorId: string;
    expiresAt: Date;
    key: string;
    requestHash: Buffer;
    scope: string;
  }): Promise<{ body?: Record<string, unknown>; kind: 'new' | 'replay' }> {
    const inserted = await this.executor.query(
      `insert into idempotency_records(scope,actor_id,key,request_hash,state,created_at,expires_at)
       values ($1,$2,$3,$4,'processing',now(),$5) on conflict do nothing`,
      [input.scope, input.actorId, input.key, input.requestHash, input.expiresAt],
    );
    if ((inserted.rowCount ?? 0) === 1) return { kind: 'new' };
    const result = await this.executor.query<{
      request_hash: Buffer;
      response_body: Record<string, unknown> | null;
      state: string;
    }>(
      `select request_hash,response_body,state from idempotency_records
        where scope=$1 and actor_id=$2 and key=$3 for update`,
      [input.scope, input.actorId, input.key],
    );
    const row = result.rows[0];
    if (!row || !row.request_hash.equals(input.requestHash))
      throw new ApplicationError(
        'IDEMPOTENCY_KEY_REUSED',
        'The idempotency key was already used for a different request.',
        409,
      );
    if (row.state !== 'completed' || !row.response_body)
      throw new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        'The original request is still being processed.',
        409,
      );
    return { body: row.response_body, kind: 'replay' };
  }

  public async completeIdempotency(input: {
    actorId: string;
    body: Record<string, unknown>;
    key: string;
    scope: string;
    status: number;
  }): Promise<void> {
    await this.executor.query(
      `update idempotency_records set state='completed',response_status=$4,response_body=$5
        where scope=$1 and actor_id=$2 and key=$3 and state='processing'`,
      [input.scope, input.actorId, input.key, input.status, JSON.stringify(input.body)],
    );
  }

  public async insertAudit(input: {
    action: string;
    actorUserId: string;
    correlationId: string;
    id: string;
    metadata?: Record<string, unknown>;
    outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
    reasonCode: string;
    requestId: string;
    targetId?: string;
  }): Promise<void> {
    await this.executor.query(
      `insert into security_audit_records(
        id,actor_user_id,category,action,outcome,reason_code,target_type,target_id,
        request_id,correlation_id,redacted_metadata
      ) values ($1,$2,'primitive_registry',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.id,
        input.actorUserId,
        input.action,
        input.outcome,
        input.reasonCode,
        input.targetId ? 'primitive_version' : null,
        input.targetId ?? null,
        input.requestId,
        input.correlationId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  public toListItem(view: PrimitiveVersionView): PrimitiveListItem {
    return {
      contentHash: view.contentHash,
      createdAt: view.createdAt,
      displayName: view.displayName,
      id: view.id,
      indexErrorCode: view.indexErrorCode,
      indexState: view.indexState,
      key: view.key,
      kind: view.kind,
      lifecycle: view.lifecycle,
      publishedAt: view.publishedAt,
      rowVersion: view.rowVersion,
      tags: view.tags,
      updatedAt: view.updatedAt,
      version: view.version,
    };
  }

  private versionView(
    row: PrimitiveRow,
    dependencies: PrimitiveDependencyView[],
  ): PrimitiveVersionView {
    return {
      ...listItem(row),
      behaviorRef: row.behavior_ref,
      compatibility: row.compatibility,
      defaults: row.defaults,
      dependencies,
      deprecatedAt: row.deprecated_at?.toISOString() ?? null,
      deprecationReason: row.deprecation_reason,
      documentation: row.documentation,
      parameterSchema: row.parameter_schema,
      primitiveSchemaVersion: row.primitive_schema_version,
      provenance: row.provenance,
      visualHints: row.visual_hints,
    };
  }
}

export function retrievalListItem(row: RetrievalRow): PrimitiveListItem {
  return listItem(row);
}
