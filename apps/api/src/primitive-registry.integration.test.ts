import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STARTER_PRIMITIVES } from '@worldgraph/catalog';
import type { RuntimeConfig } from '@worldgraph/config';
import { SystemClock, UuidV7Generator } from '@worldgraph/contracts';
import {
  applyMigrations,
  createDatabaseClient,
  importStarterPrimitives,
  type DatabaseClient,
} from '@worldgraph/db';
import { createLogger } from '@worldgraph/observability';

import { buildApp } from './app.js';
import { IdentityService } from './identity/service.js';
import { Argon2idPasswordHasher, TEST_PASSWORD_HASH_OPTIONS } from './identity/security.js';
import { PrimitiveRepository } from './primitives/repository.js';
import { PrimitiveService, type LocalQueryVectorSource } from './primitives/service.js';
import { PostgresRepository } from './repositories/postgres-repository.js';
import { WorldService } from './worlds/service.js';

const origin = 'http://localhost:3000';
const password = 'Correct horse battery staple';

interface BrowserSession {
  cookie: string;
  csrf: string;
  userId: string;
}

class FixedLocalQueryVectors implements LocalQueryVectorSource {
  public behavior: 'invalid' | 'timeout' | 'valid' = 'valid';
  public readonly configurationId = 'fixed-local-v1';
  public enabled = false;
  public readonly execution = 'local' as const;
  public readonly model = 'fixed-v1';
  public readonly provider = 'local-test';

  public async vectorize(_normalizedText: string, signal: AbortSignal): Promise<readonly number[]> {
    if (this.behavior === 'invalid') return [1];
    if (this.behavior === 'timeout') {
      return new Promise<readonly number[]>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return [1, ...Array<number>(1535).fill(0)];
  }
}

describe('primitive registry API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let client: DatabaseClient;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  const queryVectors = new FixedLocalQueryVectors();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    client = createDatabaseClient(container.getConnectionUri(), 'primitive-registry-api-test');
    await applyMigrations(client, resolve('packages/db/drizzle'));
    await importStarterPrimitives(client.pool);
    const config = runtimeConfig();
    const ids = new UuidV7Generator();
    const repository = new PostgresRepository(client.pool);
    const identity = new IdentityService(
      repository,
      { ...config, authPepper: config.authPepper! },
      new SystemClock(),
      ids,
      new Argon2idPasswordHasher(config.authPepper!, TEST_PASSWORD_HASH_OPTIONS),
      { publish: async () => undefined },
    );
    const worlds = new WorldService(
      repository,
      new SystemClock(),
      ids,
      (id) => identity.invitationToken(id),
      (token) => identity.tokenHash(token, 'invitation'),
      { publish: async () => undefined },
    );
    const primitives = new PrimitiveService(
      new PrimitiveRepository(client.pool, 'fixed-local-v1'),
      new SystemClock(),
      ids,
      {
        publish: async () => {
          throw new Error('queue unavailable');
        },
      },
      config.authPepper!,
      queryVectors,
      { configurationId: 'fixed-local-v1', model: 'fixed-v1', provider: 'local-test' },
    );
    app = await buildApp({
      clock: new SystemClock(),
      config,
      domain: { identity, primitives, worlds },
      idGenerator: ids,
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'primitive-api-test',
      }),
      pool: client.pool,
      redis: {
        get: async () =>
          JSON.stringify({ at: new Date().toISOString(), buildRevision: 'test', schemaVersion: 1 }),
        ping: async () => 'PONG',
      },
      smokeQueue: {
        add: async () => ({ getState: async () => 'waiting' }),
        getJob: async () => undefined,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.pool.end();
    await container?.stop();
  });

  it('serves bounded deterministic reads and the authorized immutable command lifecycle', async () => {
    const admin = await register('registry-admin@example.test', 'Registry Admin');
    const normal = await register('registry-reader@example.test', 'Registry Reader');
    await client.pool.query(
      "update users set platform_role='platform_admin', row_version=row_version+1, updated_at=now() where id=$1",
      [admin.userId],
    );

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/primitives' });
    expect(unauthenticated.statusCode).toBe(401);

    const filtered = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'GET',
      url: '/api/v1/primitives?kinds=government&tags=city-state&limit=8',
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json<{ items: { kind: string }[] }>().items).toHaveLength(1);
    expect(filtered.json<{ items: { kind: string }[] }>().items[0]?.kind).toBe('government');
    const emptyKind = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'GET',
      url: '/api/v1/primitives?kinds=government&tags=energy&limit=8',
    });
    expect(emptyKind.statusCode).toBe(200);
    expect(emptyKind.json<{ items: unknown[] }>().items).toEqual([]);

    const firstPage = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'GET',
      url: '/api/v1/primitives?limit=3',
    });
    const cursor = firstPage.json<{ nextCursor: string }>().nextCursor;
    expect(cursor.length).toBeLessThanOrEqual(1024);
    const nextPage = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'GET',
      url: `/api/v1/primitives?limit=3&cursor=${cursor}`,
    });
    expect(nextPage.statusCode).toBe(200);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    expect(
      (
        await app.inject({
          headers: { cookie: normal.cookie },
          method: 'GET',
          url: `/api/v1/primitives?limit=3&cursor=${tampered}`,
        })
      ).json(),
    ).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
    expect(
      (
        await app.inject({
          headers: { cookie: normal.cookie },
          method: 'GET',
          url: `/api/v1/primitives?limit=3&tags=city-state&cursor=${cursor}`,
        })
      ).json(),
    ).toMatchObject({ error: { code: 'INVALID_CURSOR' } });

    const draft = structuredClone(
      STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'government')!.input,
    );
    draft.key = 'worldgraph.government.harbor-council';
    draft.displayName = 'Harbor Council';
    draft.version = '1.0.0';
    draft.dependencies = [{ key: 'worldgraph.government.guild-council', versionRange: '>=99.0.0' }];
    const badOrigin = await app.inject({
      headers: {
        ...mutationHeaders(admin, 'primitive-bad-origin'),
        origin: 'https://untrusted.example',
      },
      method: 'POST',
      payload: draft,
      url: '/api/v1/admin/primitives/drafts',
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
    const badCsrf = await app.inject({
      headers: { ...mutationHeaders(admin, 'primitive-bad-csrf'), 'x-csrf-token': 'x'.repeat(32) },
      method: 'POST',
      payload: draft,
      url: '/api/v1/admin/primitives/drafts',
    });
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
    const deniedCreate = await app.inject({
      headers: mutationHeaders(normal, 'primitive-denied-create'),
      method: 'POST',
      payload: draft,
      url: '/api/v1/admin/primitives/drafts',
    });
    expect(deniedCreate.statusCode).toBe(403);

    const createHeaders = mutationHeaders(admin, 'primitive-create-harbor');
    const created = await app.inject({
      headers: createHeaders,
      method: 'POST',
      payload: draft,
      url: '/api/v1/admin/primitives/drafts',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      primitive: { lifecycle: 'draft', rowVersion: 1 },
      validation: {
        issues: [{ code: 'DEPENDENCY_UNRESOLVED', pointer: '/dependencies/0/versionRange' }],
        valid: false,
      },
    });
    const conflictingFamilyDraft = {
      ...structuredClone(draft),
      displayName: 'Conflicting Harbor Council',
      version: '1.0.1',
    };
    const familyConflict = await app.inject({
      headers: mutationHeaders(admin, 'primitive-create-family-conflict'),
      method: 'POST',
      payload: conflictingFamilyDraft,
      url: '/api/v1/admin/primitives/drafts',
    });
    expect(familyConflict.statusCode).toBe(409);
    expect(familyConflict.json()).toMatchObject({ error: { code: 'PRIMITIVE_FAMILY_CONFLICT' } });
    expect(
      await failedIdempotencyCount(
        'primitive.draft.create',
        'primitive-create-family-conflict',
        admin.userId,
      ),
    ).toBe(0);
    expect(await failedAuditReason('primitive.draft.create', 'PRIMITIVE_FAMILY_CONFLICT')).toBe(
      true,
    );
    expect(
      (
        await app.inject({
          headers: { cookie: normal.cookie },
          method: 'GET',
          url: `/api/v1/primitives/${draft.key}/versions/${draft.version}`,
        })
      ).statusCode,
    ).toBe(404);

    const failedPublish = await app.inject({
      headers: mutationHeaders(admin, 'primitive-publish-invalid'),
      method: 'POST',
      payload: { expectedRowVersion: 1 },
      url: `/api/v1/admin/primitives/${draft.key}/versions/${draft.version}/publish`,
    });
    expect(failedPublish.statusCode).toBe(400);
    expect(failedPublish.json()).toMatchObject({
      error: { details: { issues: [{ pointer: '/dependencies/0/versionRange' }] } },
    });
    expect(
      await failedIdempotencyCount(
        'primitive.version.publish',
        'primitive-publish-invalid',
        admin.userId,
      ),
    ).toBe(0);
    expect(await failedAuditReason('primitive.version.publish', 'VALIDATION_FAILED')).toBe(true);
    const afterFailedPublish = await client.pool.query<{ lifecycle: string; row_version: number }>(
      `select v.lifecycle,v.row_version from primitive_versions v
        join primitive_families f on f.id=v.family_id where f.stable_key=$1 and v.semver=$2`,
      [draft.key, draft.version],
    );
    expect(afterFailedPublish.rows[0]).toMatchObject({ lifecycle: 'draft', row_version: 1 });

    draft.dependencies = [{ key: 'worldgraph.government.guild-council', versionRange: '^1.0.0' }];
    const updated = await app.inject({
      headers: mutationHeaders(admin, 'primitive-update-harbor'),
      method: 'PUT',
      payload: { draft, expectedRowVersion: 1 },
      url: `/api/v1/admin/primitives/${draft.key}/versions/${draft.version}/draft`,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      primitive: { rowVersion: 2 },
      validation: { issues: [], valid: true },
    });
    const staleUpdate = await app.inject({
      headers: mutationHeaders(admin, 'primitive-update-stale'),
      method: 'PUT',
      payload: { draft, expectedRowVersion: 1 },
      url: `/api/v1/admin/primitives/${draft.key}/versions/${draft.version}/draft`,
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json()).toMatchObject({ error: { code: 'STALE_VERSION' } });
    expect(
      await failedIdempotencyCount(
        'primitive.draft.update',
        'primitive-update-stale',
        admin.userId,
      ),
    ).toBe(0);
    expect(await failedAuditReason('primitive.draft.update', 'STALE_VERSION')).toBe(true);
    const afterStaleUpdate = await client.pool.query<{ lifecycle: string; row_version: number }>(
      `select v.lifecycle,v.row_version from primitive_versions v
        join primitive_families f on f.id=v.family_id where f.stable_key=$1 and v.semver=$2`,
      [draft.key, draft.version],
    );
    expect(afterStaleUpdate.rows[0]).toMatchObject({ lifecycle: 'draft', row_version: 2 });

    const publishHeaders = mutationHeaders(admin, 'primitive-publish-harbor');
    const published = await app.inject({
      headers: publishHeaders,
      method: 'POST',
      payload: { expectedRowVersion: 2 },
      url: `/api/v1/admin/primitives/${draft.key}/versions/${draft.version}/publish`,
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      primitive: { lifecycle: 'published', rowVersion: 3 },
    });
    const configuredJob = await client.pool.query<{ provider_configuration_id: string }>(
      `select provider_configuration_id from primitive_index_jobs
        where primitive_version_id=$1 and content_hash=$2`,
      [
        published.json<{ primitive: { id: string; contentHash: string } }>().primitive.id,
        Buffer.from(
          published.json<{ primitive: { contentHash: string } }>().primitive.contentHash,
          'hex',
        ),
      ],
    );
    expect(configuredJob.rows[0]?.provider_configuration_id).toBe('fixed-local-v1');
    const publishReplay = await app.inject({
      headers: publishHeaders,
      method: 'POST',
      payload: { expectedRowVersion: 2 },
      url: `/api/v1/admin/primitives/${draft.key}/versions/${draft.version}/publish`,
    });
    expect(publishReplay.statusCode).toBe(200);
    expect(publishReplay.json()).toEqual(published.json());
    const immutableUpdate = await app.inject({
      headers: mutationHeaders(admin, 'primitive-update-immutable'),
      method: 'PUT',
      payload: { draft, expectedRowVersion: 3 },
      url: `/api/v1/admin/primitives/${draft.key}/versions/${draft.version}/draft`,
    });
    expect(immutableUpdate.statusCode).toBe(409);
    expect(immutableUpdate.json()).toMatchObject({ error: { code: 'PRIMITIVE_IMMUTABLE' } });
    const deprecated = await app.inject({
      headers: mutationHeaders(admin, 'primitive-deprecate-harbor'),
      method: 'POST',
      payload: {
        expectedRowVersion: 3,
        reason: 'Superseded by the reviewed harbor governance design.',
      },
      url: `/api/v1/admin/primitives/${draft.key}/versions/${draft.version}/deprecate`,
    });
    expect(deprecated.statusCode).toBe(200);
    expect(deprecated.json()).toMatchObject({
      primitive: { lifecycle: 'deprecated', rowVersion: 4 },
    });

    const seedDetails = await Promise.all(
      STARTER_PRIMITIVES.slice(0, 2).map(async (seed) =>
        (
          await app.inject({
            headers: { cookie: admin.cookie },
            method: 'GET',
            url: `/api/v1/primitives/${seed.input.key}/versions/${seed.input.version}`,
          })
        ).json<{ indexState: string; rowVersion: number }>(),
      ),
    );
    expect(seedDetails.map((detail) => detail.indexState)).toEqual([
      'not_requested',
      'not_requested',
    ]);
    const firstReindex = await app.inject({
      headers: mutationHeaders(admin, 'cross-resource-reindex'),
      method: 'POST',
      payload: { expectedRowVersion: seedDetails[0]!.rowVersion },
      url: `/api/v1/admin/primitives/${STARTER_PRIMITIVES[0]!.input.key}/versions/${STARTER_PRIMITIVES[0]!.input.version}/reindex`,
    });
    expect(firstReindex.statusCode).toBe(202);
    expect(firstReindex.json()).toMatchObject({
      index: {
        providerConfigurationId: 'fixed-local-v1',
        status: 'pending',
      },
    });
    const sameReindexReplay = await app.inject({
      headers: mutationHeaders(admin, 'cross-resource-reindex'),
      method: 'POST',
      payload: { expectedRowVersion: seedDetails[0]!.rowVersion },
      url: `/api/v1/admin/primitives/${STARTER_PRIMITIVES[0]!.input.key}/versions/${STARTER_PRIMITIVES[0]!.input.version}/reindex`,
    });
    expect(sameReindexReplay.statusCode).toBe(202);
    expect(sameReindexReplay.json()).toEqual(firstReindex.json());
    const crossResource = await app.inject({
      headers: mutationHeaders(admin, 'cross-resource-reindex'),
      method: 'POST',
      payload: { expectedRowVersion: seedDetails[1]!.rowVersion },
      url: `/api/v1/admin/primitives/${STARTER_PRIMITIVES[1]!.input.key}/versions/${STARTER_PRIMITIVES[1]!.input.version}/reindex`,
    });
    expect(crossResource.statusCode).toBe(409);
    expect(crossResource.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });

    const firstSeed = STARTER_PRIMITIVES[0]!;
    await client.pool.query(
      `update primitive_index_jobs set status='failed',attempts=1,last_error_code='PROVIDER_FAILED',
              queued_at=now()-interval '1 hour',claimed_at=now()-interval '50 minutes',
              next_attempt_at=now()+interval '10 minutes',completed_at=null,updated_at=now()
        where primitive_version_id=$1 and content_hash=$2 and provider_configuration_id='fixed-local-v1'`,
      [firstSeed.versionId, Buffer.from(firstSeed.contentHash, 'hex')],
    );
    const oldQueue = await client.pool.query<{ queued_at: Date }>(
      `select queued_at from primitive_index_jobs
        where primitive_version_id=$1 and content_hash=$2 and provider_configuration_id='fixed-local-v1'`,
      [firstSeed.versionId, Buffer.from(firstSeed.contentHash, 'hex')],
    );
    const resetReindex = await app.inject({
      headers: mutationHeaders(admin, 'reset-failed-reindex'),
      method: 'POST',
      payload: { expectedRowVersion: seedDetails[0]!.rowVersion },
      url: `/api/v1/admin/primitives/${firstSeed.input.key}/versions/${firstSeed.input.version}/reindex`,
    });
    expect(resetReindex.statusCode).toBe(202);
    const resetQueue = await client.pool.query<{
      claimed_at: Date | null;
      queued_at: Date;
      status: string;
    }>(
      `select status,queued_at,claimed_at from primitive_index_jobs
        where primitive_version_id=$1 and content_hash=$2 and provider_configuration_id='fixed-local-v1'`,
      [firstSeed.versionId, Buffer.from(firstSeed.contentHash, 'hex')],
    );
    expect(resetQueue.rows[0]).toMatchObject({ claimed_at: null, status: 'pending' });
    expect(resetQueue.rows[0]!.queued_at.getTime()).toBeGreaterThan(
      oldQueue.rows[0]!.queued_at.getTime(),
    );

    const degraded = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'POST',
      payload: { query: 'guild council city-state', limit: 5 },
      url: '/api/v1/primitive-retrievals',
    });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({
      provider: { degradedReason: 'PROVIDER_DISABLED', semanticAvailable: false },
    });
    expect(
      degraded.json<{ results: { reason: { matchedTerms: string[] } }[] }>().results[0]?.reason
        .matchedTerms.length,
    ).toBeGreaterThan(0);
    const oversized = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'POST',
      payload: { query: 'q'.repeat(12_001) },
      url: '/api/v1/primitive-retrievals',
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({ error: { code: 'QUERY_TOO_LARGE' } });
    let deeplyNestedCompatibility: Record<string, unknown> = {};
    for (let depth = 0; depth < 14; depth += 1) {
      deeplyNestedCompatibility = { nested: deeplyNestedCompatibility };
    }
    const unsafeCompatibility = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'POST',
      payload: { compatibility: deeplyNestedCompatibility, query: 'guild council' },
      url: '/api/v1/primitive-retrievals',
    });
    expect(unsafeCompatibility.statusCode).toBe(400);
    expect(unsafeCompatibility.json()).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: { issues: [{ code: 'JSON_DEPTH_EXCEEDED' }] },
      },
    });

    queryVectors.enabled = true;
    const noCurrentEmbedding = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'POST',
      payload: { query: 'semanticneedle', limit: 2 },
      url: '/api/v1/primitive-retrievals',
    });
    expect(noCurrentEmbedding.statusCode).toBe(404);
    expect(noCurrentEmbedding.json()).toMatchObject({
      error: { code: 'NO_COMPATIBLE_PRIMITIVES' },
    });
    await insertFixedEmbeddings();
    const semantic = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'POST',
      payload: { query: 'semanticneedle', limit: 2 },
      url: '/api/v1/primitive-retrievals',
    });
    expect(semantic.statusCode).toBe(200);
    expect(semantic.json()).toMatchObject({
      provider: {
        configurationId: 'fixed-local-v1',
        model: 'fixed-v1',
        name: 'local-test',
        semanticAvailable: true,
      },
    });
    expect(
      semantic
        .json<{ results: { primitive: { key: string }; reason: { vectorRank: number } }[] }>()
        .results.map((result) => result.primitive.key),
    ).toEqual([STARTER_PRIMITIVES[0]!.input.key, STARTER_PRIMITIVES[1]!.input.key]);
    queryVectors.behavior = 'invalid';
    const invalidVectorFallback = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'POST',
      payload: { query: 'guild council city-state', limit: 5 },
      url: '/api/v1/primitive-retrievals',
    });
    expect(invalidVectorFallback.statusCode).toBe(200);
    expect(invalidVectorFallback.json()).toMatchObject({
      provider: {
        degradedReason: 'QUERY_VECTOR_FAILED',
        semanticAvailable: false,
      },
    });
    queryVectors.behavior = 'timeout';
    const timeoutFallback = await app.inject({
      headers: { cookie: normal.cookie },
      method: 'POST',
      payload: { query: 'guild council city-state', limit: 5 },
      url: '/api/v1/primitive-retrievals',
    });
    expect(timeoutFallback.statusCode).toBe(200);
    expect(timeoutFallback.json()).toMatchObject({
      provider: {
        degradedReason: 'QUERY_VECTOR_TIMEOUT',
        semanticAvailable: false,
      },
    });
    queryVectors.behavior = 'valid';
    const audits = await client.pool.query<{ outcome: string }>(
      "select outcome from security_audit_records where action like 'primitive.%' and outcome='succeeded'",
    );
    expect(audits.rows.length).toBeGreaterThanOrEqual(4);
  });

  async function insertFixedEmbeddings(): Promise<void> {
    const vectors = [
      [1, ...Array<number>(1535).fill(0)],
      [0, 1, ...Array<number>(1534).fill(0)],
    ];
    for (const [index, seed] of STARTER_PRIMITIVES.slice(0, 2).entries()) {
      await client.pool.query(
        `insert into primitive_embeddings(
           id,primitive_version_id,provider_configuration_id,provider,model,dimensions,
           content_hash,embedding,token_estimate,latency_ms
         ) values(gen_random_uuid(),$1,'fixed-local-v1','local-test','fixed-v1',1536,$2,$3::extensions.vector,1,1)`,
        [seed.versionId, Buffer.from(seed.contentHash, 'hex'), `[${vectors[index]!.join(',')}]`],
      );
    }
  }

  async function failedIdempotencyCount(
    scope: string,
    key: string,
    actorId: string,
  ): Promise<number> {
    const result = await client.pool.query<{ count: string }>(
      'select count(*)::text as count from idempotency_records where scope=$1 and key=$2 and actor_id=$3',
      [scope, key, actorId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function failedAuditReason(action: string, reasonCode: string): Promise<boolean> {
    const result = await client.pool.query<{ redacted_metadata: Record<string, unknown> }>(
      `select redacted_metadata from security_audit_records
        where category='primitive_registry' and action=$1 and outcome='failed' and reason_code=$2
        order by occurred_at desc limit 1`,
      [action, reasonCode],
    );
    const metadata = result.rows[0]?.redacted_metadata;
    expect(metadata?.action).toBe(action);
    expect(metadata?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(metadata ?? {}).sort()).toEqual(
      expect.arrayContaining(['action', 'requestHash']),
    );
    return result.rowCount === 1;
  }

  async function register(email: string, displayName: string): Promise<BrowserSession> {
    const response = await app.inject({
      headers: { origin },
      method: 'POST',
      payload: { displayName, email, password },
      url: '/api/v1/auth/register',
    });
    expect(response.statusCode).toBe(201);
    const rawCookies = response.headers['set-cookie'];
    const cookies = Array.isArray(rawCookies)
      ? rawCookies
      : typeof rawCookies === 'string'
        ? [rawCookies]
        : [];
    const pairs = cookies.map((cookie) => cookie.split(';')[0]!);
    const csrfPair = pairs.find((cookie) => cookie.startsWith('wg_csrf='))!;
    return {
      cookie: pairs.join('; '),
      csrf: decodeURIComponent(csrfPair.slice('wg_csrf='.length)),
      userId: response.json<{ user: { id: string } }>().user.id,
    };
  }
});

function mutationHeaders(session: BrowserSession, key: string) {
  return { cookie: session.cookie, 'idempotency-key': key, origin, 'x-csrf-token': session.csrf };
}

function runtimeConfig(): RuntimeConfig {
  return {
    allowedOrigins: [origin],
    apiHost: '127.0.0.1',
    apiPort: 4000,
    authPepper: 'test-only-auth-pepper-32-characters-long',
    buildRevision: 'test',
    compilerEnabled: true,
    compilerMaxEntities: 2_000,
    compilerMaxRelationships: 8_000,
    databaseUrl: 'postgres://unused',
    dependencyTimeoutMs: 1_000,
    economyDebitsFrozen: false,
    economyIssuanceEnabled: true,
    economyIssuanceRateLimitPerHour: 3,
    economyOfferRateLimitPerMinute: 10,
    economyOfferReconciliationBatchSize: 25,
    economyOfferReconciliationIntervalMs: 1_000,
    economyOffersEnabled: true,
    economyTransferRateLimitPerMinute: 20,
    economyTransfersEnabled: true,
    enableLocalRegistration: true,
    enableOperationalSmoke: false,
    environment: 'test',
    logLevel: 'fatal',
    manifestGenerationDailyBudgetMicrounits: 0,
    manifestGenerationEnabled: true,
    manifestGenerationMaxConcurrentPerUser: 2,
    manifestGenerationMaxConcurrentPerWorld: 1,
    manifestGenerationOutputTokenLimit: 4_096,
    manifestGenerationProvider: 'disabled',
    manifestGenerationProviderTimeoutMs: 8_000,
    manifestGenerationReconciliationIntervalMs: 2_000,
    manifestPromptRetentionDays: 30,
    primitiveEmbeddingCostBudgetMicrounits: 0,
    primitiveEmbeddingProviderTimeoutMs: 3_000,
    primitiveIndexMaxJobsPerReconciliation: 25,
    primitiveIndexReconciliationIntervalMs: 5_000,
    primitiveSemanticContributionEnabled: false,
    primitiveSemanticProfile: 'disabled',
    redisUrl: 'redis://unused',
    requestTimeoutMs: 5_000,
    simulationContinuousEnabled: true,
    simulationLeaseMs: 30_000,
    simulationMaximumAttempts: 3,
    simulationMaximumBackoffMs: 5_000,
    simulationMaximumWorldsPerRun: 25,
    simulationReconciliationIntervalMs: 1_000,
    simulationRetryBaseMs: 250,
    sessionAbsoluteTtlSeconds: 86_400,
    sessionIdleTtlSeconds: 3_600,
    workerHeartbeatIntervalMs: 1_000,
    workerHeartbeatTtlMs: 5_000,
    workerHealthHost: '127.0.0.1',
    workerHealthPort: 4001,
    worldCompilationReconciliationIntervalMs: 2_000,
  };
}
