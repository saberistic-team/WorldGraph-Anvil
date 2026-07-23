import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  buildPrimitiveIndexDocument,
  assertHarborCityCatalogLock,
  assertStarterCatalogLock,
  parseSemver,
  primitiveContentHash,
  resolveDependencies,
  STARTER_PRIMITIVES,
  HARBOR_CITY_ECONOMY_PRIMITIVES,
  CATALOG_CURATOR_USER_ID,
  type PublishedPrimitiveRef,
  type StarterPrimitive,
} from '@worldgraph/catalog';
import type { PrimitiveDraftInput } from '@worldgraph/contracts';

export class PrimitiveSeedError extends Error {
  public constructor(
    public readonly code:
      | 'SEED_CATALOG_INVALID'
      | 'SEED_HASH_CONFLICT'
      | 'SEED_IDENTITY_CONFLICT'
      | 'SEED_INDEX_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'PrimitiveSeedError';
  }
}

export interface PrimitiveSeedResult {
  imported: number;
  unchanged: number;
}

interface ExistingVersionRow extends QueryResultRow {
  behavior_ref: string | null;
  compatibility: Record<string, unknown>;
  content_hash: Buffer;
  defaults: Record<string, unknown>;
  display_name: string;
  documentation: string;
  family_id: string;
  id: string;
  kind: PrimitiveDraftInput['kind'];
  lifecycle: 'deprecated' | 'draft' | 'published';
  parameter_schema: Record<string, unknown>;
  primitive_schema_version: 1;
  provenance: Record<string, unknown>;
  semver: string;
  stable_key: string;
  visual_hints: Record<string, unknown>;
}

const BUNDLED_PRIMITIVES: StarterPrimitive[] = [
  ...STARTER_PRIMITIVES,
  ...HARBOR_CITY_ECONOMY_PRIMITIVES,
];

const publishedCatalog: PublishedPrimitiveRef[] = BUNDLED_PRIMITIVES.map((primitive) => ({
  contentHash: primitive.contentHash,
  dependencies: primitive.input.dependencies,
  key: primitive.input.key,
  version: primitive.input.version,
  versionId: primitive.versionId,
}));

function publicationOrder(): StarterPrimitive[] {
  const remaining = new Map(
    BUNDLED_PRIMITIVES.map((primitive) => [primitive.input.key, primitive]),
  );
  const ordered: StarterPrimitive[] = [];
  const available = new Set<string>();
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((primitive) =>
        primitive.input.dependencies.every((dependency) => available.has(dependency.key)),
      )
      .sort((left, right) =>
        left.input.key < right.input.key ? -1 : left.input.key > right.input.key ? 1 : 0,
      );
    if (ready.length === 0)
      throw new PrimitiveSeedError(
        'SEED_CATALOG_INVALID',
        'Bundled seed dependency graph contains a cycle.',
      );
    for (const primitive of ready) {
      remaining.delete(primitive.input.key);
      available.add(primitive.input.key);
      ordered.push(primitive);
    }
  }
  return ordered;
}

async function existingInput(
  client: PoolClient,
  row: ExistingVersionRow,
): Promise<PrimitiveDraftInput> {
  const tags = await client.query<{ tag: string }>(
    'select tag::text from primitive_tags where primitive_version_id = $1 order by tag',
    [row.id],
  );
  const dependencies = await client.query<{
    key: string;
    parameter_mapping: Record<string, unknown>;
    required: boolean;
    version_range: string;
  }>(
    `select f.stable_key::text as key, d.version_range, d.required, d.parameter_mapping
       from primitive_dependencies d
       join primitive_families f on f.id = d.dependency_family_id
      where d.primitive_version_id = $1
      order by f.stable_key`,
    [row.id],
  );
  return {
    behaviorRef: row.behavior_ref,
    compatibility: row.compatibility,
    defaults: row.defaults,
    dependencies: dependencies.rows.map((dependency) => ({
      key: dependency.key,
      parameterMapping: dependency.parameter_mapping,
      required: dependency.required,
      versionRange: dependency.version_range,
    })),
    displayName: row.display_name,
    documentation: row.documentation,
    key: row.stable_key,
    kind: row.kind,
    parameterSchema: row.parameter_schema,
    primitiveSchemaVersion: row.primitive_schema_version,
    provenance: row.provenance,
    tags: tags.rows.map((tag) => tag.tag),
    version: row.semver,
    visualHints: row.visual_hints,
  };
}

async function assertExistingVersion(
  client: PoolClient,
  seed: StarterPrimitive,
  row: ExistingVersionRow,
): Promise<void> {
  if (row.id !== seed.versionId || row.family_id !== seed.familyId || row.lifecycle === 'draft') {
    throw new PrimitiveSeedError(
      'SEED_IDENTITY_CONFLICT',
      `Bundled identity conflicts with ${seed.input.key}@${seed.input.version}.`,
    );
  }
  const reconstructedHash = primitiveContentHash(await existingInput(client, row));
  if (
    reconstructedHash !== seed.contentHash ||
    row.content_hash.toString('hex') !== reconstructedHash
  ) {
    throw new PrimitiveSeedError(
      'SEED_HASH_CONFLICT',
      `Published bundled content differs for ${seed.input.key}@${seed.input.version}.`,
    );
  }
  const resolution = resolveDependencies(seed.input.key, seed.input.dependencies, publishedCatalog);
  const expected = new Map(resolution.resolved.map((item) => [item.key, item]));
  const actual = await client.query<{
    key: string;
    resolved_content_hash: Buffer | null;
    resolved_version_id: string | null;
  }>(
    `select f.stable_key::text as key, d.resolved_version_id, d.resolved_content_hash
       from primitive_dependencies d
       join primitive_families f on f.id = d.dependency_family_id
      where d.primitive_version_id = $1`,
    [row.id],
  );
  if (actual.rows.length !== expected.size) {
    throw new PrimitiveSeedError(
      'SEED_HASH_CONFLICT',
      `Dependency lock count differs for ${seed.input.key}@${seed.input.version}.`,
    );
  }
  const seen = new Set<string>();
  for (const dependency of actual.rows) {
    const locked = expected.get(dependency.key);
    if (
      !locked ||
      dependency.resolved_version_id !== locked.resolvedVersionId ||
      dependency.resolved_content_hash?.toString('hex') !== locked.contentHash
    ) {
      throw new PrimitiveSeedError(
        'SEED_HASH_CONFLICT',
        `Dependency lock differs for ${seed.input.key}@${seed.input.version}.`,
      );
    }
    seen.add(dependency.key);
  }
  if ([...expected.keys()].some((key) => !seen.has(key))) {
    throw new PrimitiveSeedError(
      'SEED_HASH_CONFLICT',
      `Dependency lock is missing for ${seed.input.key}@${seed.input.version}.`,
    );
  }
  const expectedDocument = buildPrimitiveIndexDocument(seed.input);
  const search = await client.query<{
    content_hash: Buffer;
    index_schema_version: number;
    normalized_text: string;
    vector_matches: boolean;
  }>(
    `select content_hash, index_schema_version, normalized_text,
            search_vector = (
              setweight(to_tsvector('simple', $2), 'A') ||
              setweight(to_tsvector('simple', $3), 'B') ||
              setweight(to_tsvector('simple', $4), 'C')
            ) as vector_matches
       from primitive_search_documents
      where primitive_version_id = $1`,
    [row.id, expectedDocument.primary, expectedDocument.tags, expectedDocument.documentation],
  );
  if (
    search.rows.length !== 1 ||
    search.rows[0]?.content_hash.toString('hex') !== seed.contentHash ||
    search.rows[0]?.index_schema_version !== 1 ||
    search.rows[0]?.normalized_text !== expectedDocument.normalizedText ||
    search.rows[0]?.vector_matches !== true
  ) {
    throw new PrimitiveSeedError(
      'SEED_INDEX_CONFLICT',
      `Lexical index is missing or stale for ${seed.input.key}@${seed.input.version}.`,
    );
  }
  const jobs = await client.query<{ status: string }>(
    `select status::text
       from primitive_index_jobs
      where primitive_version_id = $1
        and content_hash = $2
        and index_schema_version = 1
        and provider_configuration_id = 'disabled-v1'`,
    [row.id, Buffer.from(seed.contentHash, 'hex')],
  );
  if (
    jobs.rows.length !== 1 ||
    !['pending', 'running', 'completed', 'failed', 'dead', 'stale', 'disabled'].includes(
      jobs.rows[0]!.status,
    )
  ) {
    throw new PrimitiveSeedError(
      'SEED_INDEX_CONFLICT',
      `Durable index intent is missing for ${seed.input.key}@${seed.input.version}.`,
    );
  }
}

export async function importStarterPrimitives(pool: Pool): Promise<PrimitiveSeedResult> {
  assertStarterCatalogLock();
  assertHarborCityCatalogLock();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('worldgraph.catalog.seed.v1', 0))",
    );

    for (const seed of BUNDLED_PRIMITIVES) {
      const resolution = resolveDependencies(
        seed.input.key,
        seed.input.dependencies,
        publishedCatalog,
      );
      if (resolution.issues.length > 0)
        throw new PrimitiveSeedError('SEED_CATALOG_INVALID', JSON.stringify(resolution.issues));
      const family = await client.query<{
        created_by_user_id: string;
        display_name: string;
        id: string;
        kind: string;
        stable_key: string;
      }>(
        'select id, stable_key::text, kind, display_name, created_by_user_id from primitive_families where id = $1 or stable_key = $2',
        [seed.familyId, seed.input.key],
      );
      const row = family.rows[0];
      if (family.rows.length > 1) {
        throw new PrimitiveSeedError(
          'SEED_IDENTITY_CONFLICT',
          `Bundled family has a dual identity collision for ${seed.input.key}.`,
        );
      }
      if (
        row &&
        (row.id !== seed.familyId ||
          row.stable_key !== seed.input.key ||
          row.kind !== seed.input.kind ||
          row.display_name !== seed.input.displayName ||
          row.created_by_user_id !== CATALOG_CURATOR_USER_ID)
      ) {
        throw new PrimitiveSeedError(
          'SEED_IDENTITY_CONFLICT',
          `Bundled family conflicts with ${seed.input.key}.`,
        );
      }
      const existing = await client.query<ExistingVersionRow>(
        `select v.*, f.stable_key::text, f.kind
           from primitive_versions v join primitive_families f on f.id = v.family_id
          where v.id = $1 or (v.family_id = $2 and v.semver = $3)`,
        [seed.versionId, seed.familyId, seed.input.version],
      );
      if (existing.rows.length > 1) {
        throw new PrimitiveSeedError(
          'SEED_IDENTITY_CONFLICT',
          `Bundled version has a dual identity collision for ${seed.input.key}@${seed.input.version}.`,
        );
      }
      if (existing.rows[0]) await assertExistingVersion(client, seed, existing.rows[0]);
    }

    const existingIds = new Set<string>();
    const existingResult = await client.query<{ id: string }>(
      'select id from primitive_versions where id = any($1::uuid[])',
      [BUNDLED_PRIMITIVES.map((primitive) => primitive.versionId)],
    );
    existingResult.rows.forEach((row) => existingIds.add(row.id));
    const planned = BUNDLED_PRIMITIVES.filter((primitive) => !existingIds.has(primitive.versionId));

    for (const seed of BUNDLED_PRIMITIVES) {
      await client.query(
        `insert into primitive_families
          (id, stable_key, kind, display_name, created_by_user_id)
         values ($1,$2,$3,$4,$5)
         on conflict (id) do nothing`,
        [
          seed.familyId,
          seed.input.key,
          seed.input.kind,
          seed.input.displayName,
          CATALOG_CURATOR_USER_ID,
        ],
      );
    }
    for (const seed of planned) {
      const parsed = parseSemver(seed.input.version)!;
      await client.query(
        `insert into primitive_versions
          (id, family_id, semver, semver_major, semver_minor, semver_patch,
           semver_prerelease, semver_build, primitive_schema_version, lifecycle,
           display_name, documentation, parameter_schema, defaults, compatibility,
           behavior_ref, visual_hints, provenance, content_hash, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,1,'draft',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          seed.versionId,
          seed.familyId,
          seed.input.version,
          parsed.major,
          parsed.minor,
          parsed.patch,
          parsed.prerelease.join('.') || null,
          parsed.build.join('.') || null,
          seed.input.displayName,
          seed.input.documentation,
          JSON.stringify(seed.input.parameterSchema),
          JSON.stringify(seed.input.defaults),
          JSON.stringify(seed.input.compatibility),
          seed.input.behaviorRef ?? null,
          JSON.stringify(seed.input.visualHints),
          JSON.stringify(seed.input.provenance),
          Buffer.from(seed.contentHash, 'hex'),
          CATALOG_CURATOR_USER_ID,
        ],
      );
      for (const tag of seed.input.tags) {
        await client.query(
          'insert into primitive_tags (primitive_version_id, tag) values ($1,$2)',
          [seed.versionId, tag],
        );
      }
    }

    for (const seed of planned) {
      const resolution = resolveDependencies(
        seed.input.key,
        seed.input.dependencies,
        publishedCatalog,
      );
      const direct = new Map(resolution.resolved.map((dependency) => [dependency.key, dependency]));
      for (const dependency of seed.input.dependencies) {
        const target = direct.get(dependency.key)!;
        const targetSeed = BUNDLED_PRIMITIVES.find((entry) => entry.input.key === dependency.key)!;
        await client.query(
          `insert into primitive_dependencies
            (primitive_version_id, dependency_family_id, version_range, required,
             parameter_mapping, resolved_version_id, resolved_content_hash)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            seed.versionId,
            targetSeed.familyId,
            dependency.versionRange,
            dependency.required ?? true,
            JSON.stringify(dependency.parameterMapping ?? {}),
            target.resolvedVersionId,
            Buffer.from(target.contentHash!, 'hex'),
          ],
        );
      }
    }

    const plannedIds = new Set(planned.map((primitive) => primitive.versionId));
    for (const seed of publicationOrder()) {
      if (!plannedIds.has(seed.versionId)) continue;
      const text = buildPrimitiveIndexDocument(seed.input);
      await client.query(
        `insert into primitive_search_documents
          (primitive_version_id, index_schema_version, content_hash, search_vector, normalized_text)
         values ($1,1,$2,
           setweight(to_tsvector('simple', $3), 'A') ||
           setweight(to_tsvector('simple', $4), 'B') ||
           setweight(to_tsvector('simple', $5), 'C'), $6)`,
        [
          seed.versionId,
          Buffer.from(seed.contentHash, 'hex'),
          text.primary,
          text.tags,
          text.documentation,
          text.normalizedText,
        ],
      );
      const published = await client.query(
        `update primitive_versions
            set lifecycle = 'published', published_by_user_id = $2, published_at = now(),
                row_version = row_version + 1, updated_at = now()
          where id = $1 and lifecycle = 'draft'`,
        [seed.versionId, CATALOG_CURATOR_USER_ID],
      );
      if ((published.rowCount ?? 0) !== 1)
        throw new PrimitiveSeedError(
          'SEED_IDENTITY_CONFLICT',
          `Could not publish ${seed.input.key}.`,
        );
      await client.query(
        `insert into primitive_index_jobs
          (primitive_version_id, content_hash, index_schema_version, provider_configuration_id)
         values ($1,$2,1,'disabled-v1')`,
        [seed.versionId, Buffer.from(seed.contentHash, 'hex')],
      );
      const requestId = randomUUID();
      await client.query(
        `insert into security_audit_records
          (id, actor_user_id, category, action, outcome, reason_code,
           target_type, target_id, request_id, correlation_id, redacted_metadata)
         values ($1,$2,'primitive_registry','primitive.seed_published','succeeded',
           'BUNDLED_SEED_PUBLISHED','primitive_version',$3,$4,$4,$5)`,
        [
          randomUUID(),
          CATALOG_CURATOR_USER_ID,
          seed.versionId,
          requestId,
          JSON.stringify({
            catalog: 'worldgraph.city-state-starter',
            contentHash: seed.contentHash,
          }),
        ],
      );
    }
    await client.query('commit');
    return { imported: planned.length, unchanged: BUNDLED_PRIMITIVES.length - planned.length };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
