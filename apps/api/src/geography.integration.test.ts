import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { RuntimeConfig } from '@worldgraph/config';
import { SystemClock, UuidV7Generator } from '@worldgraph/contracts';
import { applyMigrations, createDatabaseClient, type DatabaseClient } from '@worldgraph/db';
import { createLogger } from '@worldgraph/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { IdentityService } from './identity/service.js';
import { Argon2idPasswordHasher, TEST_PASSWORD_HASH_OPTIONS } from './identity/security.js';
import { PostgresRepository } from './repositories/postgres-repository.js';
import { WorldService } from './worlds/service.js';

const origin = 'http://localhost:3000';
const password = 'Correct horse battery staple';
const migrationRoot = resolve('packages/db/drizzle');

interface BrowserSession {
  cookie: string;
  csrf: string;
  userId: string;
}

describe.sequential('M11 geography API membership and bounds', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;
  let appClient: DatabaseClient;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let creator: BrowserSession;
  let outsider: BrowserSession;
  let worldId: string;
  let otherWorldId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'm11-geography-api-owner');
    await applyMigrations(owner, migrationRoot);

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    appClient = createDatabaseClient(appUrl.toString(), 'm11-geography-api-app');

    const config = runtimeConfig();
    const ids = new UuidV7Generator();
    const clock = new SystemClock();
    const repository = new PostgresRepository(appClient.pool);
    const notifications = { publish: async () => undefined };
    const identity = new IdentityService(
      repository,
      { ...config, authPepper: config.authPepper! },
      clock,
      ids,
      new Argon2idPasswordHasher(config.authPepper!, TEST_PASSWORD_HASH_OPTIONS),
      notifications,
    );
    const worlds = new WorldService(
      repository,
      clock,
      ids,
      (id) => identity.invitationToken(id),
      (token) => identity.tokenHash(token, 'invitation'),
      notifications,
    );

    app = await buildApp({
      clock,
      config,
      domain: { identity, pool: appClient.pool, worlds },
      idGenerator: ids,
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'm11-geography-api',
      }),
      pool: appClient.pool,
      redis: {
        get: async () => null,
        ping: async () => 'PONG',
      },
      smokeQueue: {
        add: async () => ({ getState: async () => 'waiting' }),
        getJob: async () => undefined,
      },
    });

    creator = await register('m11-geo-creator@example.test', 'M11 Geo Creator');
    outsider = await register('m11-geo-outsider@example.test', 'M11 Geo Outsider');
    worldId = await createWorld(creator, 'Geography API Alpha');
    otherWorldId = await createWorld(outsider, 'Geography API Beta');
    await seedGeography(worldId);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await appClient?.pool.end();
    await owner?.pool.end();
    await container?.stop();
  });

  it('returns bounded geography to members and hides it from non-members', async () => {
    const memberRead = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/geography?minXMilli=-50000&minYMilli=-50000&maxXMilli=50000&maxYMilli=50000&layers=spawn`,
      headers: { cookie: creator.cookie, origin },
    });
    expect(memberRead.statusCode, memberRead.body).toBe(200);
    const body = memberRead.json<{ features: unknown[]; geographyVersion: string }>();
    expect(body.geographyVersion).toBe('1');
    expect(body.features.length).toBeGreaterThan(0);
    expect(body.features.length).toBeLessThanOrEqual(32);

    const outsiderRead = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/geography?minXMilli=-50000&minYMilli=-50000&maxXMilli=50000&maxYMilli=50000&layers=spawn`,
      headers: { cookie: outsider.cookie, origin },
    });
    expect(outsiderRead.statusCode).toBe(404);

    const otherWorld = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${otherWorldId}/geography?minXMilli=-50000&minYMilli=-50000&maxXMilli=50000&maxYMilli=50000&layers=spawn`,
      headers: { cookie: creator.cookie, origin },
    });
    expect(otherWorld.statusCode).toBe(404);
  });

  it('serves scene plan and spawn points only to members', async () => {
    const scene = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/visual-scene-plan`,
      headers: { cookie: creator.cookie, origin },
    });
    expect(scene.statusCode, scene.body).toBe(200);
    expect(scene.json()).toMatchObject({
      geographyVersion: '1',
      plan: { visualScenePlanSchemaVersion: 1 },
    });

    const spawns = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/spawn-points`,
      headers: { cookie: creator.cookie, origin },
    });
    expect(spawns.statusCode, spawns.body).toBe(200);
    expect(spawns.json()).toMatchObject({
      geographyVersion: '1',
      spawnPoints: [{ stableKey: 'spawn:plaza' }],
    });

    const outsiderScene = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/visual-scene-plan`,
      headers: { cookie: outsider.cookie, origin },
    });
    expect(outsiderScene.statusCode).toBe(404);
  });

  async function register(email: string, displayName: string): Promise<BrowserSession> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin },
      payload: { displayName, email, password },
    });
    expect(response.statusCode).toBe(201);
    const setCookie = response.headers['set-cookie'];
    const pairs = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).map(
      (entry) => entry.split(';')[0] ?? entry,
    );
    const csrfPair = pairs.find((cookie) => cookie.startsWith('wg_csrf='))!;
    return {
      cookie: pairs.join('; '),
      csrf: decodeURIComponent(csrfPair.slice('wg_csrf='.length)),
      userId: response.json<{ user: { id: string } }>().user.id,
    };
  }

  async function createWorld(session: BrowserSession, name: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/worlds',
      headers: {
        cookie: session.cookie,
        origin,
        'idempotency-key': `create-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
        'x-csrf-token': session.csrf,
      },
      payload: { name },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ world: { id: string } }>().world.id;
  }

  async function seedGeography(id: string): Promise<void> {
    const commandId = '018f0000-0000-7000-8000-00000000f001';
    const eventId = '018f0000-0000-7000-8000-00000000f011';
    const versionId = '018f0000-0000-7000-8000-00000000f021';
    const territoryId = '018f0000-0000-7000-8000-00000000f002';
    const districtId = '018f0000-0000-7000-8000-00000000f003';
    const spawnId = '018f0000-0000-7000-8000-00000000f004';
    const planId = '018f0000-0000-7000-8000-00000000f005';
    const sceneJson = {
      bounds: {
        maxXMilli: 20_000,
        maxYMilli: 20_000,
        minXMilli: -20_000,
        minYMilli: -20_000,
      },
      nodes: [
        {
          archetype: 'district.block',
          entityLogicalKey: 'district:harbor',
          layer: 'district',
          lodHint: 'low',
          materialToken: 'material.harbor',
          provenance: { sourceStableKey: 'district:harbor' },
          transform: {
            scaleMilli: 1000,
            xMilli: 0,
            yMilli: 0,
            yawMilliDegrees: 0,
            zMilli: 0,
          },
        },
      ],
      styleKitVersion: 1,
      visualScenePlanSchemaVersion: 1,
      warnings: [],
    };

    await owner.pool.query(
      `insert into spatial_reference_systems(
         world_id, units, origin_x_milli, origin_y_milli,
         bounds_min_x_milli, bounds_min_y_milli, bounds_max_x_milli, bounds_max_y_milli, srid,
         geography_version, seed_plan_hash, source_artifact_hash, compiled_world_version_id,
         created_command_id, created_event_id, created_state_revision
       ) values (
         $1,'meters',0,0,-50000,-50000,50000,50000,3857,
         1, decode(repeat('ab',32),'hex'), decode(repeat('11',32),'hex'), $2::uuid,
         $3::uuid, $4::uuid, 1
       )`,
      [id, versionId, commandId, eventId],
    );
    await owner.pool.query(
      `insert into territories(
         id, world_id, stable_key, geom, geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, 'territory:main',
         extensions.ST_Multi(extensions.ST_GeomFromText('POLYGON((-40 -40,40 -40,40 40,-40 40,-40 -40))', 3857)),
         1, $3::uuid
       )`,
      [territoryId, id, commandId],
    );
    await owner.pool.query(
      `insert into districts(
         id, world_id, territory_id, stable_key, zoning, geom,
         geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'district:harbor', 'mixed',
         extensions.ST_GeomFromText('POLYGON((-20 -20,20 -20,20 20,-20 20,-20 -20))', 3857),
         1, $4::uuid
       )`,
      [districtId, id, territoryId, commandId],
    );
    await owner.pool.query(
      `insert into spawn_points(
         id, world_id, stable_key, location, radius_milli, access_policy, priority,
         geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, 'spawn:plaza',
         extensions.ST_GeomFromText('POINT(0 0)', 3857), 1500, 'public', 1, 1, $3::uuid
       )`,
      [spawnId, id, commandId],
    );
    await owner.pool.query(
      `insert into visual_scene_plans(
         id, world_id, geography_version, style_kit_version, compiler_version, seed,
         canonical_json, checksum, status, warnings, provenance, published_tick,
         created_command_id, created_event_id, created_state_revision
       ) values (
         $1::uuid, $2::uuid, 1, 1, '1.4.0', 'fixture', $3::jsonb,
         decode(repeat('cd',32),'hex'), 'published', '[]'::jsonb, '{}'::jsonb,
         0, $4::uuid, $5::uuid, 1
       )`,
      [planId, id, JSON.stringify(sceneJson), commandId, eventId],
    );
    await owner.pool.query(
      `insert into world_geography_heads(
         world_id, geography_version, geography_state_revision, seed_plan_hash,
         active_scene_plan_id, active_scene_plan_checksum, initialized_at
       ) values (
         $1::uuid, 1, 1, decode(repeat('ab',32),'hex'), $2::uuid,
         decode(repeat('cd',32),'hex'), now()
       )`,
      [id, planId],
    );
  }
});

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
    webOrigin: origin,
  } as unknown as RuntimeConfig;
}
