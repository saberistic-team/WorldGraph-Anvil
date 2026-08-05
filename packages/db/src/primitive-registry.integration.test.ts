import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildPrimitiveIndexDocument,
  compareSemver,
  GOVERNANCE_PRIMITIVES,
  HARBOR_CITY_ECONOMY_PRIMITIVES,
  primitiveTagFrequencies,
  rankCandidates,
  retrievalTerms,
  scorePrimitiveIndex,
  scorePrimitiveTags,
  STARTER_PRIMITIVES,
} from '@worldgraph/catalog';

import { createDatabaseClient, importStarterPrimitives, type DatabaseClient } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const query = 'guild-led energy-scarce floating city with a council and closed-loop credits';
const curatorId = '155d9b48-4e26-5672-8854-9ff24f3262fd';
const bundledPrimitives = [
  ...STARTER_PRIMITIVES,
  ...HARBOR_CITY_ECONOMY_PRIMITIVES,
  ...GOVERNANCE_PRIMITIVES,
];

interface StarterOnlyEvidence {
  audits: string;
  harborVersions: string;
  versions: string;
}

function applicationUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'worldgraph_app';
  url.password = 'worldgraph_app_local_only';
  return url.toString();
}

describe('primitive registry migration and bundled catalog', () => {
  let app: DatabaseClient;
  let client: DatabaseClient;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let starterOnlyEvidence: StarterOnlyEvidence;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    client = createDatabaseClient(container.getConnectionUri(), 'primitive-registry-owner-test');
    await migrate(client.db, { migrationsFolder: migrationRoot });
    await expect(
      importStarterPrimitives(client.pool, { includeHarborCityEconomy: false }),
    ).resolves.toEqual({
      imported: STARTER_PRIMITIVES.length,
      unchanged: 0,
    });
    const starterOnly = await client.pool.query<StarterOnlyEvidence>(
      `select
        (select count(*) from primitive_versions where lifecycle = 'published')::text as versions,
        (select count(*) from primitive_versions where id = any($1::uuid[]))::text as "harborVersions",
        (select count(*) from security_audit_records where action = 'primitive.seed_published')::text as audits`,
      [HARBOR_CITY_ECONOMY_PRIMITIVES.map((primitive) => primitive.versionId)],
    );
    starterOnlyEvidence = starterOnly.rows[0]!;
    await expect(importStarterPrimitives(client.pool)).resolves.toEqual({
      imported: HARBOR_CITY_ECONOMY_PRIMITIVES.length + GOVERNANCE_PRIMITIVES.length,
      unchanged: STARTER_PRIMITIVES.length,
    });
    await expect(importStarterPrimitives(client.pool)).resolves.toEqual({
      imported: 0,
      unchanged: bundledPrimitives.length,
    });
    app = createDatabaseClient(
      applicationUrl(container.getConnectionUri()),
      'primitive-registry-app-test',
    );
  });

  afterAll(async () => {
    await app?.pool.end();
    await client?.pool.end();
    await container?.stop();
  });

  it('supports starter-only upgrades, then imports all reviewed defaults exactly once with accurate provenance', async () => {
    expect(starterOnlyEvidence).toEqual({
      audits: String(STARTER_PRIMITIVES.length),
      harborVersions: '0',
      versions: String(STARTER_PRIMITIVES.length),
    });
    const counts = await client.pool.query<{
      audits: string;
      dependencies: string;
      families: string;
      jobs: string;
      search_documents: string;
      tags: string;
      versions: string;
    }>(
      `select
        (select count(*) from primitive_families)::text as families,
        (select count(*) from primitive_versions where lifecycle = 'published')::text as versions,
        (select count(*) from primitive_tags)::text as tags,
        (select count(*) from primitive_dependencies)::text as dependencies,
        (select count(*) from primitive_search_documents)::text as search_documents,
        (select count(*) from primitive_index_jobs where provider_configuration_id = 'disabled-v1')::text as jobs,
        (select count(*) from security_audit_records where action = 'primitive.seed_published')::text as audits`,
    );
    expect(counts.rows[0]).toEqual({
      audits: String(bundledPrimitives.length),
      dependencies: String(
        bundledPrimitives.reduce((sum, entry) => sum + entry.input.dependencies.length, 0),
      ),
      families: String(new Set(bundledPrimitives.map((entry) => entry.familyId)).size),
      jobs: String(bundledPrimitives.length),
      search_documents: String(bundledPrimitives.length),
      tags: String(bundledPrimitives.reduce((sum, entry) => sum + entry.input.tags.length, 0)),
      versions: String(bundledPrimitives.length),
    });
    const audits = await client.pool.query<{
      key: string;
      redacted_metadata: Record<string, unknown>;
      semver: string;
    }>(
      `select f.stable_key::text as key,version.semver,audit.redacted_metadata
         from security_audit_records audit
         join primitive_versions version on version.id = audit.target_id
         join primitive_families f on f.id = version.family_id
        where audit.action = 'primitive.seed_published'
        order by f.stable_key,worldgraph_semver_sort_key(version.semver) collate "C",
          version.semver collate "C"`,
    );
    expect(audits.rows).toHaveLength(bundledPrimitives.length);
    for (const primitive of bundledPrimitives) {
      const provenance = primitive.input.provenance;
      expect(
        audits.rows.find(
          (audit) => audit.key === primitive.input.key && audit.semver === primitive.input.version,
        )?.redacted_metadata,
      ).toEqual({
        catalog: provenance.sourceId,
        contentHash: primitive.contentHash,
        review: { id: provenance.reviewId, status: provenance.reviewStatus },
        source: {
          id: provenance.sourceId,
          type: provenance.sourceType,
          version: provenance.sourceVersion,
        },
      });
    }
    const governance = GOVERNANCE_PRIMITIVES[0]!;
    await expect(
      client.pool.query<{ content_hash: string; family_id: string; version_id: string }>(
        `select encode(version.content_hash,'hex') as content_hash,
                family.id as family_id,version.id as version_id
           from primitive_versions version
           join primitive_families family on family.id=version.family_id
          where family.stable_key=$1 and version.semver=$2`,
        [governance.input.key, governance.input.version],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          content_hash: governance.contentHash,
          family_id: governance.familyId,
          version_id: governance.versionId,
        },
      ],
    });
    const electionFamilyVersions = await client.pool.query<{
      lifecycle: string;
      semver: string;
    }>(
      `select lifecycle::text,semver
         from primitive_versions
        where family_id=$1
        order by worldgraph_semver_sort_key(semver) collate "C",semver collate "C"`,
      [governance.familyId],
    );
    expect(electionFamilyVersions.rows).toEqual([
      { lifecycle: 'published', semver: '1.0.0' },
      { lifecycle: 'published', semver: '1.1.0' },
    ]);
    const locks = await client.pool.query<{ resolved: string; total: string }>(
      `select count(*)::text as total,
              count(*) filter (where resolved_version_id is not null and octet_length(resolved_content_hash) = 32)::text as resolved
         from primitive_dependencies`,
    );
    expect(locks.rows[0]?.resolved).toBe(locks.rows[0]?.total);
    const searchForeignKey = await client.pool.query<{
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `select condeferrable, condeferred
         from pg_constraint where conname = 'primitive_search_documents_version_hash_fk'`,
    );
    expect(searchForeignKey.rows[0]).toEqual({ condeferrable: true, condeferred: true });
    await expect(
      client.pool.query(
        `select status::text, platform_role::text
           from users where id = $1 and status = 'disabled' and platform_role = 'user'`,
        [curatorId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('matches the pure lexical scorer row-for-row through the production GIN/OR path', async () => {
    const terms = retrievalTerms(query).slice(0, 24);
    const tsquery = terms.join(' | ');
    const databaseScores = await client.pool.query<{ id: string; lexical_score: number }>(
      `with requested(term) as (select unnest($1::text[])),
            scored as (
              select d.primitive_version_id as id,
                     sum(case right(position.value, 1)
                       when 'A' then 4 when 'B' then 2 when 'C' then 1 else 1 end)::float8 as lexical_score
                from primitive_search_documents d
                cross join lateral regexp_matches(
                  d.search_vector::text,
                  '''([a-z0-9]+)'':([0-9A-D,]+)',
                  'g'
                ) as lexeme(parts)
                cross join lateral unnest(string_to_array(lexeme.parts[2], ',')) as position(value)
                join requested on requested.term = lexeme.parts[1]
               where d.primitive_version_id = any($3::uuid[])
                 and d.search_vector @@ to_tsquery('simple', $2)
               group by d.primitive_version_id
            )
       select id, lexical_score from scored order by id`,
      [terms, tsquery, STARTER_PRIMITIVES.map((entry) => entry.versionId)],
    );
    const actual = new Map(databaseScores.rows.map((row) => [row.id, row.lexical_score]));
    const frequencies = primitiveTagFrequencies(
      STARTER_PRIMITIVES.map((entry) => entry.input.tags),
    );
    const candidates = STARTER_PRIMITIVES.map((entry) => {
      const document = buildPrimitiveIndexDocument(entry.input);
      const lexicalScore = scorePrimitiveIndex(query, document);
      expect(actual.get(entry.versionId)).toBe(lexicalScore);
      const databaseScore = actual.get(entry.versionId);
      if (databaseScore === undefined)
        throw new Error(`Missing PostgreSQL score for ${entry.input.key}.`);
      return {
        id: entry.versionId,
        key: entry.input.key,
        kind: entry.input.kind,
        lexicalScore: databaseScore,
        normalizedText: document.normalizedText,
        tags: entry.input.tags,
        tagScore: scorePrimitiveTags(query, entry.input.tags, frequencies),
        version: entry.input.version,
      };
    });
    expect(databaseScores.rows).toHaveLength(16);
    expect(
      rankCandidates(query, candidates)
        .slice(0, 8)
        .map((entry) => entry.key),
    ).toEqual([
      'worldgraph.government.guild-council',
      'worldgraph.currency.closed-loop-credits',
      'worldgraph.resource.energy',
      'worldgraph.district.floating-mixed-use',
      'worldgraph.visual-style.low-poly-floating-city',
      'worldgraph.organization.guild',
      'worldgraph.terrain.floating-platform',
      'worldgraph.production-recipe.energy-reclamation',
    ]);
  });

  it('orders strict SemVer exactly like the shared comparator, including prereleases and build ties', async () => {
    const versions = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.2',
      '1.0.0-alpha.10',
      '1.0.0-beta',
      '1.0.0',
      '1.0.0+alpha',
      '1.0.0+zeta',
      '1.9.0',
      '1.10.0',
      '999999999999999999999.0.0',
    ];
    const result = await client.pool.query<{ version: string }>(
      `select version
         from unnest($1::text[]) as versions(version)
        order by worldgraph_semver_sort_key(version) collate "C" desc,
                 version collate "C" desc`,
      [versions],
    );
    expect(result.rows.map((row) => row.version)).toEqual(
      [...versions].sort((left, right) => compareSemver(right, left)),
    );
  });

  it('enforces published immutability and curator least privilege through the application role', async () => {
    const government = STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'government')!;
    const event = STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'event_template')!;
    const tax = STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'tax')!;
    await expect(
      app.pool.query(
        `update primitive_versions
            set documentation = 'changed', row_version = row_version + 1, updated_at = now()
          where id = $1`,
        [government.versionId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query('delete from primitive_versions where id = $1', [government.versionId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.pool.query('delete from primitive_versions where id = $1', [government.versionId]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query('insert into primitive_tags(primitive_version_id, tag) values ($1, $2)', [
        government.versionId,
        'new-tag',
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query('delete from primitive_tags where primitive_version_id = $1', [
        government.versionId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query(
        "update primitive_dependencies set version_range = '*' where primitive_version_id = $1",
        [event.versionId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query('delete from primitive_dependencies where primitive_version_id = $1', [
        event.versionId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query(
        "update primitive_search_documents set normalized_text = 'changed', updated_at = now() where primitive_version_id = $1",
        [government.versionId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query('delete from primitive_search_documents where primitive_version_id = $1', [
        government.versionId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.pool.query('delete from primitive_search_documents where primitive_version_id = $1', [
        government.versionId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query(
        "update primitive_families set display_name = 'Changed', updated_at = now() where id = $1",
        [government.familyId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      app.pool.query("update users set platform_role = 'platform_admin' where id = $1", [
        curatorId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    const deprecated = await app.pool.query<{ lifecycle: string }>(
      `update primitive_versions
          set lifecycle = 'deprecated', deprecated_by_user_id = $2,
              deprecated_at = now(), deprecation_reason = 'Superseded by reviewed replacement.',
              row_version = row_version + 1, updated_at = now()
        where id = $1 returning lifecycle::text`,
      [tax.versionId, curatorId],
    );
    expect(deprecated.rows[0]?.lifecycle).toBe('deprecated');
    await expect(
      app.pool.query(
        `update primitive_versions set deprecation_reason = 'Changed after deprecation.',
          row_version = row_version + 1, updated_at = now() where id = $1`,
        [tax.versionId],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    await expect(
      app.pool.query(
        `insert into primitive_versions (
          id, family_id, semver, semver_major, semver_minor, semver_patch,
          primitive_schema_version, lifecycle, display_name, documentation,
          parameter_schema, defaults, compatibility, visual_hints, provenance,
          content_hash, row_version, created_by_user_id, published_by_user_id, published_at
        )
        select $2, family_id, '9.0.0', 9, 0, 0, primitive_schema_version,
          'published', display_name, documentation, parameter_schema, defaults,
          compatibility, visual_hints, provenance, content_hash, 1,
          created_by_user_id, $3, now()
        from primitive_versions where id = $1`,
        [government.versionId, '90000000-0000-4000-8000-000000000001', curatorId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('rejects malformed SemVer decomposition, publication without an index, and invalid job states', async () => {
    const familyId = '90000000-0000-4000-8000-000000000010';
    await client.pool.query(
      `insert into primitive_families(id, stable_key, kind, display_name, created_by_user_id)
       values ($1, 'worldgraph.test.semver', 'organization', 'Semver', $2)`,
      [familyId, curatorId],
    );
    const insertDraft = (id: string, semver: string, major: string, prerelease: string | null) =>
      client.pool.query(
        `insert into primitive_versions (
          id, family_id, semver, semver_major, semver_minor, semver_patch,
          semver_prerelease, primitive_schema_version, display_name, documentation,
          parameter_schema, defaults, compatibility, visual_hints, provenance,
          content_hash, created_by_user_id
        ) values ($1,$2,$3,$4,0,0,$5,1,'Semver','# Semver','{"type":"object","additionalProperties":false}'::jsonb,
          '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$6,$7)`,
        [id, familyId, semver, major, prerelease, Buffer.alloc(32, Number(id.at(-1))), curatorId],
      );
    await expect(
      insertDraft('90000000-0000-4000-8000-000000000011', '1.0.0-01', '1', '01'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertDraft('90000000-0000-4000-8000-000000000012', '1.0.0', '1.5', null),
    ).rejects.toMatchObject({ code: '23514' });
    await insertDraft('90000000-0000-4000-8000-000000000013', '1.0.0', '1', null);
    await expect(
      client.pool.query(
        `update primitive_versions set lifecycle = 'published', published_by_user_id = $2,
           published_at = now(), row_version = 2, updated_at = now() where id = $1`,
        ['90000000-0000-4000-8000-000000000013', curatorId],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    const government = STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'government')!;
    await expect(
      client.pool.query(
        `insert into primitive_index_jobs(
          primitive_version_id, content_hash, index_schema_version,
          provider_configuration_id, status, attempts
        ) values ($1,$2,1,'invalid-state-test','running',0)`,
        [government.versionId, Buffer.from(government.contentHash, 'hex')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.pool.query(
        `insert into primitive_index_jobs(
          primitive_version_id, content_hash, index_schema_version, provider_configuration_id
        ) values ($1,$2,1,' padded-provider ')`,
        [government.versionId, Buffer.from(government.contentHash, 'hex')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an existing semantic hash conflict atomically', async () => {
    const target = STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'visual_style')!;
    const before = await client.pool.query<{ audits: string; families: string; versions: string }>(
      `select (select count(*) from primitive_families)::text as families,
              (select count(*) from primitive_versions)::text as versions,
              (select count(*) from security_audit_records)::text as audits`,
    );
    try {
      await client.pool.query(
        'alter table primitive_versions disable trigger primitive_versions_protect_published',
      );
      await client.pool.query(
        "update primitive_versions set documentation = '# Corrupted' where id = $1",
        [target.versionId],
      );
    } finally {
      await client.pool.query(
        'alter table primitive_versions enable trigger primitive_versions_protect_published',
      );
    }
    await expect(importStarterPrimitives(client.pool)).rejects.toMatchObject({
      code: 'SEED_HASH_CONFLICT',
    });
    const after = await client.pool.query<{ audits: string; families: string; versions: string }>(
      `select (select count(*) from primitive_families)::text as families,
              (select count(*) from primitive_versions)::text as versions,
              (select count(*) from security_audit_records)::text as audits`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
