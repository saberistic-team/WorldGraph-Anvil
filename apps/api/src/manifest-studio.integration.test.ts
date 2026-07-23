import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RuntimeConfig } from '@worldgraph/config';
import { SystemClock, UuidV7Generator, type ApplicationNotification } from '@worldgraph/contracts';
import {
  applyMigrations,
  createDatabaseClient,
  importStarterPrimitives,
  type DatabaseClient,
} from '@worldgraph/db';
import {
  createDeterministicFallback,
  starterManifestCatalog,
  validateWorldManifest,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';

import { buildApp } from './app.js';
import { IdentityService } from './identity/service.js';
import { Argon2idPasswordHasher, TEST_PASSWORD_HASH_OPTIONS } from './identity/security.js';
import { ManifestRepository } from './manifests/repository.js';
import { ManifestService } from './manifests/service.js';
import { PostgresRepository } from './repositories/postgres-repository.js';
import { WorldService } from './worlds/service.js';

const origin = 'http://localhost:3000';
const password = 'Correct horse battery staple';
const prompt =
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.';

interface BrowserSession {
  cookie: string;
  csrf: string;
  userId: string;
}

describe('manifest studio API and approval boundary', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let client: DatabaseClient;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  const notifications: ApplicationNotification[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    client = createDatabaseClient(container.getConnectionUri(), 'manifest-studio-api-test');
    await applyMigrations(client, resolve('packages/db/drizzle'));
    await importStarterPrimitives(client.pool);
    const config = runtimeConfig();
    const ids = new UuidV7Generator();
    const repository = new PostgresRepository(client.pool);
    const sink = {
      publish: async (notification: ApplicationNotification) => {
        notifications.push(notification);
      },
    };
    const identity = new IdentityService(
      repository,
      { ...config, authPepper: config.authPepper! },
      new SystemClock(),
      ids,
      new Argon2idPasswordHasher(config.authPepper!, TEST_PASSWORD_HASH_OPTIONS),
      sink,
    );
    const worlds = new WorldService(
      repository,
      new SystemClock(),
      ids,
      (id) => identity.invitationToken(id),
      (token) => identity.tokenHash(token, 'invitation'),
      sink,
    );
    const manifests = new ManifestService(
      new ManifestRepository(client.pool),
      config,
      new SystemClock(),
      ids,
      sink,
      config.authPepper!,
    );
    app = await buildApp({
      clock: new SystemClock(),
      config,
      domain: { identity, manifests, worlds },
      idGenerator: ids,
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'manifest-api-test',
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await client?.pool.end();
    await container?.stop();
  });

  it('starts, scopes, cancels, validates, diffs, and approves immutable revisions', async () => {
    const alice = await register('manifest-alice@example.test', 'Manifest Alice');
    const bob = await register('manifest-bob@example.test', 'Manifest Bob');
    const createdWorld = await app.inject({
      headers: mutationHeaders(alice, 'manifest-world-create'),
      method: 'POST',
      payload: { name: 'Floating Guild City' },
      url: '/api/v1/worlds',
    });
    expect(createdWorld.statusCode).toBe(201);
    const world = createdWorld.json<{ world: { id: string; rowVersion: number } }>().world;

    const startHeaders = mutationHeaders(alice, 'manifest-generation-start');
    const start = await app.inject({
      headers: startHeaders,
      method: 'POST',
      payload: { prompt },
      url: `/api/v1/worlds/${world.id}/manifest-generations`,
    });
    expect(start.statusCode).toBe(202);
    const run = start.json<{ rowVersion: number; runId: string; status: string }>();
    expect(run.status).toBe('queued');
    const replay = await app.inject({
      headers: startHeaders,
      method: 'POST',
      payload: { prompt },
      url: `/api/v1/worlds/${world.id}/manifest-generations`,
    });
    expect(replay.json()).toEqual(start.json());
    const cached = await app.inject({
      headers: mutationHeaders(alice, 'manifest-generation-cached'),
      method: 'POST',
      payload: { prompt },
      url: `/api/v1/worlds/${world.id}/manifest-generations`,
    });
    expect(cached.statusCode, cached.body).toBe(202);
    expect(cached.json()).toEqual(start.json());
    const storedRun = await client.pool.query<{
      input_hash: Buffer;
      prompt_text: string;
      provider_configuration_id: string;
      seed: string;
    }>(
      `select r.input_hash, r.provider_configuration_id, r.seed, p.prompt_text
         from manifest_generation_runs r
         join world_prompt_submissions p on p.id = r.prompt_submission_id
        where r.id = $1`,
      [run.runId],
    );
    expect(storedRun.rows[0]).toMatchObject({
      prompt_text: prompt,
      provider_configuration_id: 'disabled-v1',
    });
    expect(storedRun.rows[0]!.seed).toMatch(/^request-[a-f0-9]{32}$/u);
    expect(storedRun.rows[0]!.input_hash).toHaveLength(32);
    expect(
      notifications.find(
        (notification) =>
          notification.type === 'ManifestGenerationRequested' &&
          notification.payload.runId === run.runId,
      ),
    ).toBeDefined();
    expect(JSON.stringify(notifications)).not.toContain(prompt);

    const hiddenRun = await app.inject({
      headers: { cookie: bob.cookie },
      method: 'GET',
      url: `/api/v1/manifest-generations/${run.runId}`,
    });
    expect(hiddenRun.statusCode).toBe(404);
    const cancel = await app.inject({
      headers: mutationHeaders(alice, 'manifest-generation-cancel'),
      method: 'POST',
      payload: { expectedRowVersion: run.rowVersion },
      url: `/api/v1/manifest-generations/${run.runId}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ status: 'cancelled' });

    const fallback = createDeterministicFallback({
      catalog: starterManifestCatalog(),
      prompt,
      providerConfigurationId: 'disabled-v1',
      seed: 'manifest-api-seed',
    });
    const createRevision = await app.inject({
      headers: mutationHeaders(alice, 'manifest-revision-create'),
      method: 'POST',
      payload: {
        baseRevisionId: null,
        expectedHash: null,
        format: 'json',
        jsonOrYaml: fallback.envelope.manifest,
      },
      url: `/api/v1/worlds/${world.id}/manifest-revisions`,
    });
    expect(createRevision.statusCode, createRevision.body).toBe(201);
    const validRevision = createRevision.json<{
      revision: { contentHash: string; id: string; revisionNumber: number };
      validationReportId: string;
    }>();
    expect(validRevision.revision.revisionNumber).toBe(1);

    const parentlessRevision = await app.inject({
      headers: mutationHeaders(alice, 'manifest-parentless-revision'),
      method: 'POST',
      payload: {
        baseRevisionId: null,
        expectedHash: null,
        format: 'json',
        jsonOrYaml: fallback.envelope.manifest,
      },
      url: `/api/v1/worlds/${world.id}/manifest-revisions`,
    });
    expect(parentlessRevision.statusCode).toBe(409);
    expect(parentlessRevision.json()).toMatchObject({
      error: { code: 'MANIFEST_PARENT_REQUIRED' },
    });
    const parentlessGeneration = await app.inject({
      headers: mutationHeaders(alice, 'manifest-parentless-generation'),
      method: 'POST',
      payload: { prompt, seed: 'parentless-after-first-revision' },
      url: `/api/v1/worlds/${world.id}/manifest-generations`,
    });
    expect(parentlessGeneration.statusCode).toBe(409);
    expect(parentlessGeneration.json()).toMatchObject({
      error: { code: 'MANIFEST_PARENT_REQUIRED' },
    });

    const detail = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/manifest-revisions/${validRevision.revision.id}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      report: { valid: true },
      revision: { contentHash: validRevision.revision.contentHash },
    });
    expect(detail.body).toContain('manifestSchemaVersion');

    const validation = validateWorldManifest(fallback.envelope.manifest, starterManifestCatalog());
    const warningCodes = [
      ...new Set(
        validation.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'warning')
          .map((diagnostic) => diagnostic.code),
      ),
    ];
    const approve = await app.inject({
      headers: mutationHeaders(alice, 'manifest-revision-approve'),
      method: 'POST',
      payload: {
        acknowledgedWarningCodes: warningCodes,
        confirmationName: 'Floating Guild City',
        expectedContentHash: validRevision.revision.contentHash,
        expectedWorldVersion: world.rowVersion,
      },
      url: `/api/v1/worlds/${world.id}/manifest-revisions/${validRevision.revision.id}/approve`,
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json()).toMatchObject({
      revisionId: validRevision.revision.id,
      worldId: world.id,
      worldRowVersion: 2,
    });

    const invalidManifest = structuredClone(fallback.envelope.manifest);
    (invalidManifest.districts[1] as { key: string }).key = invalidManifest.districts[0]!.key;
    invalidManifest.metadata.description = `${invalidManifest.metadata.description} Conflicting edit.`;
    const invalidRevisionResponse = await app.inject({
      headers: mutationHeaders(alice, 'manifest-invalid-child'),
      method: 'POST',
      payload: {
        baseRevisionId: validRevision.revision.id,
        expectedHash: validRevision.revision.contentHash,
        format: 'json',
        jsonOrYaml: invalidManifest,
      },
      url: `/api/v1/worlds/${world.id}/manifest-revisions`,
    });
    expect(invalidRevisionResponse.statusCode, invalidRevisionResponse.body).toBe(201);
    const invalidRevision = invalidRevisionResponse.json<{
      revision: { contentHash: string; id: string };
    }>().revision;
    const invalidDetail = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/manifest-revisions/${invalidRevision.id}`,
    });
    expect(invalidDetail.json()).toMatchObject({ report: { valid: false } });
    expect(invalidDetail.body).toContain('MANIFEST_DUPLICATE_LOCAL_KEY');

    const invalidApprove = await app.inject({
      headers: mutationHeaders(alice, 'manifest-invalid-approve'),
      method: 'POST',
      payload: {
        acknowledgedWarningCodes: [],
        confirmationName: 'Floating Guild City',
        expectedContentHash: invalidRevision.contentHash,
        expectedWorldVersion: 2,
      },
      url: `/api/v1/worlds/${world.id}/manifest-revisions/${invalidRevision.id}/approve`,
    });
    expect(invalidApprove.statusCode).toBe(409);
    expect(invalidApprove.json()).toMatchObject({
      error: { code: 'MANIFEST_VALIDATION_FAILED' },
    });
    const pointer = await client.pool.query<{
      current_approved_manifest_revision_id: string;
    }>('select current_approved_manifest_revision_id from worlds where id = $1', [world.id]);
    expect(pointer.rows[0]!.current_approved_manifest_revision_id).toBe(validRevision.revision.id);

    const history = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/manifest-revisions?limit=1`,
    });
    expect(history.statusCode, history.body).toBe(200);
    const firstHistoryPage = history.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(firstHistoryPage.items).toHaveLength(1);
    expect(firstHistoryPage.nextCursor).not.toBeNull();
    const nextHistory = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/manifest-revisions?${new URLSearchParams({
        cursor: firstHistoryPage.nextCursor!,
        limit: '1',
      })}`,
    });
    expect(nextHistory.statusCode, nextHistory.body).toBe(200);
    expect(nextHistory.json()).toMatchObject({ nextCursor: null });

    const diff = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/manifest-revisions/diff?fromRevisionId=${validRevision.revision.id}&toRevisionId=${invalidRevision.id}&limit=1`,
    });
    expect(diff.statusCode, diff.body).toBe(200);
    const firstDiffPage = diff.json<{
      counts: { changed: number };
      entries: unknown[];
      nextCursor: string | null;
    }>();
    expect(firstDiffPage.counts.changed).toBe(2);
    expect(firstDiffPage.entries).toHaveLength(1);
    expect(firstDiffPage.nextCursor).not.toBeNull();
    const secondDiff = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/manifest-revisions/diff?${new URLSearchParams({
        cursor: firstDiffPage.nextCursor!,
        fromRevisionId: validRevision.revision.id,
        limit: '1',
        toRevisionId: invalidRevision.id,
      })}`,
    });
    expect(secondDiff.statusCode, secondDiff.body).toBe(200);
    expect(secondDiff.json()).toMatchObject({
      counts: { changed: 2 },
      nextCursor: null,
    });

    await client.pool.query(
      `insert into world_memberships
        (world_id,user_id,role,status,granted_by_user_id)
       values ($1,$2,'administrator','active',$3)`,
      [world.id, bob.userId, alice.userId],
    );
    const adminApproval = await app.inject({
      headers: mutationHeaders(bob, 'manifest-admin-approve'),
      method: 'POST',
      payload: {
        acknowledgedWarningCodes: [],
        confirmationName: 'Floating Guild City',
        expectedContentHash: invalidRevision.contentHash,
        expectedWorldVersion: 2,
      },
      url: `/api/v1/worlds/${world.id}/manifest-revisions/${invalidRevision.id}/approve`,
    });
    expect(adminApproval.statusCode).toBe(403);

    await expect(
      client.pool.query(
        `update manifest_revisions set canonical_manifest = '{}'::jsonb where id = $1`,
        [validRevision.revision.id],
      ),
    ).rejects.toThrow();
  }, 60_000);

  it('starts fresh work after cancelled and failed input-cache candidates', async () => {
    const creator = await register('manifest-cache@example.test', 'Manifest Cache Creator');
    const createdWorld = await app.inject({
      headers: mutationHeaders(creator, 'manifest-cache-world'),
      method: 'POST',
      payload: { name: 'Manifest Cache World' },
      url: '/api/v1/worlds',
    });
    expect(createdWorld.statusCode, createdWorld.body).toBe(201);
    const world = createdWorld.json<{ world: { id: string } }>().world;

    const start = await app.inject({
      headers: mutationHeaders(creator, 'manifest-cache-start'),
      method: 'POST',
      payload: { prompt },
      url: `/api/v1/worlds/${world.id}/manifest-generations`,
    });
    expect(start.statusCode, start.body).toBe(202);
    const first = start.json<{ rowVersion: number; runId: string }>();
    const cancel = await app.inject({
      headers: mutationHeaders(creator, 'manifest-cache-cancel'),
      method: 'POST',
      payload: { expectedRowVersion: first.rowVersion },
      url: `/api/v1/manifest-generations/${first.runId}/cancel`,
    });
    expect(cancel.statusCode, cancel.body).toBe(200);

    const afterCancellation = await app.inject({
      headers: mutationHeaders(creator, 'manifest-cache-after-cancel'),
      method: 'POST',
      payload: { prompt },
      url: `/api/v1/worlds/${world.id}/manifest-generations`,
    });
    expect(afterCancellation.statusCode, afterCancellation.body).toBe(202);
    const second = afterCancellation.json<{ runId: string }>();
    expect(second.runId).not.toBe(first.runId);

    const claimToken = '018f8652-3cb6-7d52-904b-cce7901d7e99';
    await client.pool.query(
      `with stamp as (select clock_timestamp() as at)
       update manifest_generation_runs r
          set status = 'running', stage = 'intent', progress_percent = 10,
              attempts = 1, claim_token = $2, claimed_at = stamp.at,
              heartbeat_at = stamp.at, started_at = stamp.at, updated_at = stamp.at,
              row_version = r.row_version + 1
         from stamp
        where r.id = $1`,
      [second.runId, claimToken],
    );
    await client.pool.query(
      `with stamp as (select clock_timestamp() as at)
       update manifest_generation_runs r
          set status = 'failed', error_code = 'WORKER_EXECUTION_FAILED',
              claim_token = null, completed_at = stamp.at, updated_at = stamp.at,
              row_version = r.row_version + 1
         from stamp
        where r.id = $1`,
      [second.runId],
    );

    const afterFailure = await app.inject({
      headers: mutationHeaders(creator, 'manifest-cache-after-failure'),
      method: 'POST',
      payload: { prompt },
      url: `/api/v1/worlds/${world.id}/manifest-generations`,
    });
    expect(afterFailure.statusCode, afterFailure.body).toBe(202);
    const third = afterFailure.json<{ runId: string; status: string }>();
    expect(third).toMatchObject({ status: 'queued' });
    expect(third.runId).not.toBe(second.runId);
  }, 60_000);

  it('serializes one user across worlds before enforcing the independent user limit', async () => {
    const creator = await register('manifest-concurrency@example.test', 'Concurrency Creator');
    const worlds: { id: string }[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({
        headers: mutationHeaders(creator, `manifest-concurrency-world-${index}`),
        method: 'POST',
        payload: { name: `Concurrency World ${index + 1}` },
        url: '/api/v1/worlds',
      });
      expect(response.statusCode, response.body).toBe(201);
      worlds.push(response.json<{ world: { id: string } }>().world);
    }

    const starts = await Promise.all(
      worlds.map((world, index) =>
        app.inject({
          headers: mutationHeaders(creator, `manifest-concurrency-run-${index}`),
          method: 'POST',
          payload: { prompt, seed: `manifest-concurrency-${index}` },
          url: `/api/v1/worlds/${world.id}/manifest-generations`,
        }),
      ),
    );
    expect(starts.map((response) => response.statusCode).sort()).toEqual([202, 202, 429]);
    expect(starts.find((response) => response.statusCode === 429)?.json()).toMatchObject({
      error: { code: 'GENERATION_LIMIT' },
    });
  }, 60_000);

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
    const csrf = pairs.find((cookie) => cookie.startsWith('wg_csrf='))!;
    return {
      cookie: pairs.join('; '),
      csrf: decodeURIComponent(csrf.slice('wg_csrf='.length)),
      userId: response.json<{ user: { id: string } }>().user.id,
    };
  }
});

function mutationHeaders(session: BrowserSession, key: string) {
  return {
    cookie: session.cookie,
    'idempotency-key': key,
    origin,
    'x-csrf-token': session.csrf,
  };
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
