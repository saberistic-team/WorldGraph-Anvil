import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RuntimeConfig } from '@worldgraph/config';
import { SystemClock, UuidV7Generator, type ApplicationNotification } from '@worldgraph/contracts';
import { applyMigrations, createDatabaseClient, type DatabaseClient } from '@worldgraph/db';
import { createLogger } from '@worldgraph/observability';

import { buildApp } from './app.js';
import { IdentityService } from './identity/service.js';
import { Argon2idPasswordHasher, TEST_PASSWORD_HASH_OPTIONS } from './identity/security.js';
import { PostgresRepository } from './repositories/postgres-repository.js';
import { WorldService } from './worlds/service.js';

const origin = 'http://localhost:3000';
const password = 'Correct horse battery staple';

interface BrowserSession {
  cookie: string;
  csrf: string;
  userId: string;
}

describe('identity, membership, and authority API', () => {
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
    client = createDatabaseClient(container.getConnectionUri(), 'identity-authority-api-test');
    await applyMigrations(client, resolve('packages/db/drizzle'));
    const config = runtimeConfig();
    const ids = new UuidV7Generator();
    const repository = new PostgresRepository(client.pool);
    const notificationSink = {
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
      notificationSink,
    );
    const worlds = new WorldService(
      repository,
      new SystemClock(),
      ids,
      (id) => identity.invitationToken(id),
      (token) => identity.tokenHash(token, 'invitation'),
      notificationSink,
    );
    app = await buildApp({
      clock: new SystemClock(),
      config,
      domain: { identity, worlds },
      idGenerator: ids,
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'identity-api-test',
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

  it('runs the two-user, denial, idempotency, and override lifecycle', async () => {
    const alice = await register('alice@example.test', 'Alice');
    const bob = await register('bob@example.test', 'Bob');
    const charlie = await register('charlie@example.test', 'Charlie');

    const me = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: '/api/v1/auth/me',
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).not.toHaveProperty('user.passwordHash');

    const unauthenticatedMutation = await app.inject({
      headers: { 'idempotency-key': 'world-no-auth' },
      method: 'POST',
      payload: { name: 'Rejected World' },
      url: '/api/v1/worlds',
    });
    expect(unauthenticatedMutation.statusCode).toBe(401);
    expect(unauthenticatedMutation.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    const unauthenticatedCsrfRotation = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/csrf',
    });
    expect(unauthenticatedCsrfRotation.statusCode).toBe(401);

    const crossOriginMutation = await app.inject({
      headers: {
        ...mutationHeaders(alice, 'world-cross-origin'),
        origin: 'https://attacker.example',
      },
      method: 'POST',
      payload: { name: 'Rejected World' },
      url: '/api/v1/worlds',
    });
    expect(crossOriginMutation.statusCode).toBe(403);
    expect(crossOriginMutation.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });

    const missingCsrf = await app.inject({
      headers: { cookie: alice.cookie, 'idempotency-key': 'world-no-csrf', origin },
      method: 'POST',
      payload: { name: 'Rejected World' },
      url: '/api/v1/worlds',
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });

    const createHeaders = mutationHeaders(alice, 'world-create-001');
    const create = await app.inject({
      headers: createHeaders,
      method: 'POST',
      payload: { name: 'Floating Guild City' },
      url: '/api/v1/worlds',
    });
    expect(create.statusCode).toBe(201);
    const world = create.json<{ world: { id: string; rowVersion: number } }>().world;

    const replay = await app.inject({
      headers: createHeaders,
      method: 'POST',
      payload: { name: 'Floating Guild City' },
      url: '/api/v1/worlds',
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(create.json());
    expect(
      Number(
        (
          await client.pool.query<{ count: string }>(
            "select count(*) from security_audit_records where action = 'world.created'",
          )
        ).rows[0]!.count,
      ),
    ).toBe(1);

    const conflicting = await app.inject({
      headers: createHeaders,
      method: 'POST',
      payload: { name: 'Different World' },
      url: '/api/v1/worlds',
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });

    const hidden = await app.inject({
      headers: { cookie: bob.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}`,
    });
    expect(hidden.statusCode).toBe(404);

    const invitationResponse = await app.inject({
      headers: mutationHeaders(alice, 'invite-bob-001'),
      method: 'POST',
      payload: { email: 'BOB@example.test', expiresIn: 3600, role: 'player' },
      url: `/api/v1/worlds/${world.id}/invitations`,
    });
    expect(invitationResponse.statusCode).toBe(201);
    const invitation = invitationResponse.json<{
      invitation: { id: string };
      rawToken: string;
    }>();
    const storedInvite = await client.pool.query<{ token_hash: Buffer }>(
      'select token_hash from world_invitations where id = $1',
      [invitation.invitation.id],
    );
    expect(storedInvite.rows[0]!.token_hash).toHaveLength(32);
    expect(storedInvite.rows[0]!.token_hash.toString()).not.toContain(invitation.rawToken);

    const accepted = await app.inject({
      headers: mutationHeaders(bob, 'accept-invite-001'),
      method: 'POST',
      payload: { rawToken: invitation.rawToken },
      url: '/api/v1/invitations/accept',
    });
    expect(accepted.statusCode).toBe(200);
    const acceptedReplay = await app.inject({
      headers: mutationHeaders(bob, 'accept-invite-001'),
      method: 'POST',
      payload: { rawToken: invitation.rawToken },
      url: '/api/v1/invitations/accept',
    });
    expect(acceptedReplay.json()).toEqual(accepted.json());

    const forbiddenRename = await app.inject({
      headers: mutationHeaders(bob, 'bob-rename-001'),
      method: 'PATCH',
      payload: { expectedRowVersion: 1, name: 'Stolen Name' },
      url: `/api/v1/worlds/${world.id}`,
    });
    expect(forbiddenRename.statusCode).toBe(403);
    expect(
      Number(
        (
          await client.pool.query<{ count: string }>(
            "select count(*) from security_audit_records where actor_user_id = $1 and action = 'world.rename' and outcome = 'denied'",
            [bob.userId],
          )
        ).rows[0]!.count,
      ),
    ).toBe(1);

    const members = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/memberships`,
    });
    const bobMembership = members
      .json<{ items: { role: string; rowVersion: number; user: { id: string } }[] }>()
      .items.find((membership) => membership.user.id === bob.userId)!;
    expect(bobMembership.role).toBe('player');
    expect(members.body).not.toContain('bob@example.test');

    const promoted = await app.inject({
      headers: mutationHeaders(alice, 'promote-bob-001'),
      method: 'PATCH',
      payload: { expectedRowVersion: bobMembership.rowVersion, role: 'administrator' },
      url: `/api/v1/worlds/${world.id}/memberships/${bob.userId}`,
    });
    expect(promoted.statusCode).toBe(200);
    const promotedVersion = promoted.json<{ membership: { rowVersion: number } }>().membership
      .rowVersion;

    const adminInvite = await app.inject({
      headers: mutationHeaders(bob, 'admin-invite-001'),
      method: 'POST',
      payload: { email: 'third@example.test', expiresIn: 3600, role: 'observer' },
      url: `/api/v1/worlds/${world.id}/invitations`,
    });
    expect(adminInvite.statusCode).toBe(201);
    const adminInvitation = adminInvite.json<{ invitation: { id: string } }>().invitation;
    const adminRevoke = await app.inject({
      headers: mutationHeaders(bob, 'admin-revoke-001'),
      method: 'POST',
      url: `/api/v1/worlds/${world.id}/invitations/${adminInvitation.id}/revoke`,
    });
    expect(adminRevoke.statusCode).toBe(200);

    const charlieInvite = await app.inject({
      headers: mutationHeaders(bob, 'admin-invite-charlie'),
      method: 'POST',
      payload: { email: 'charlie@example.test', expiresIn: 3600, role: 'observer' },
      url: `/api/v1/worlds/${world.id}/invitations`,
    });
    const charlieToken = charlieInvite.json<{ rawToken: string }>().rawToken;
    expect(
      (
        await app.inject({
          headers: mutationHeaders(charlie, 'accept-charlie-001'),
          method: 'POST',
          payload: { rawToken: charlieToken },
          url: '/api/v1/invitations/accept',
        })
      ).statusCode,
    ).toBe(200);
    const membersWithCharlie = await app.inject({
      headers: { cookie: bob.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/memberships`,
    });
    const charlieMembership = membersWithCharlie
      .json<{ items: { rowVersion: number; user: { id: string } }[] }>()
      .items.find((membership) => membership.user.id === charlie.userId)!;
    expect(
      (
        await app.inject({
          headers: mutationHeaders(bob, 'admin-remove-charlie'),
          method: 'DELETE',
          payload: { expectedRowVersion: charlieMembership.rowVersion },
          url: `/api/v1/worlds/${world.id}/memberships/${charlie.userId}`,
        })
      ).statusCode,
    ).toBe(200);

    const ordinaryDemotion = await app.inject({
      headers: mutationHeaders(alice, 'demote-bob-ordinary'),
      method: 'PATCH',
      payload: { expectedRowVersion: promotedVersion, role: 'player' },
      url: `/api/v1/worlds/${world.id}/memberships/${bob.userId}`,
    });
    expect(ordinaryDemotion.statusCode).toBe(403);
    expect(ordinaryDemotion.json()).toMatchObject({ error: { code: 'CREATOR_OVERRIDE_REQUIRED' } });

    const overrideHeaders = mutationHeaders(alice, 'override-bob-001');
    const overridePayload = {
      action: 'membership.force_demote_administrator',
      confirmation: 'USE CREATOR OVERRIDE',
      expectedRowVersion: promotedVersion,
      reason: '  Administrator access is no longer appropriate.  ',
      targetUserId: bob.userId,
    };
    for (const [key, reason] of [
      ['override-short-reason', '   short   '],
      ['override-control-reason', 'Administrator access\nwas removed.'],
    ] as const) {
      const invalidOverride = await app.inject({
        headers: mutationHeaders(alice, key),
        method: 'POST',
        payload: { ...overridePayload, reason },
        url: `/api/v1/worlds/${world.id}/creator-overrides`,
      });
      expect(invalidOverride.statusCode).toBe(400);
      expect(invalidOverride.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
    const override = await app.inject({
      headers: overrideHeaders,
      method: 'POST',
      payload: overridePayload,
      url: `/api/v1/worlds/${world.id}/creator-overrides`,
    });
    expect(override.statusCode).toBe(200);
    const overriddenVersion = override.json<{ membership: { rowVersion: number } }>().membership
      .rowVersion;
    const overrideReplay = await app.inject({
      headers: overrideHeaders,
      method: 'POST',
      payload: overridePayload,
      url: `/api/v1/worlds/${world.id}/creator-overrides`,
    });
    expect(overrideReplay.json()).toEqual(override.json());
    const storedOverrides = await client.pool.query<{ reason: string }>(
      'select reason from creator_override_records',
    );
    expect(storedOverrides.rows).toEqual([
      { reason: 'Administrator access is no longer appropriate.' },
    ]);

    const targetDenial = await client.pool.query<{
      reason_code: string;
      target_type: string;
    }>(
      `select reason_code, target_type
         from security_audit_records
        where actor_user_id = $1 and action = 'membership.change_role' and outcome = 'denied'
        order by occurred_at desc limit 1`,
      [alice.userId],
    );
    expect(targetDenial.rows[0]).toEqual({
      reason_code: 'CREATOR_OVERRIDE_REQUIRED',
      target_type: 'world_membership',
    });

    const successfulDecision = await client.pool.query<{
      redacted_metadata: Record<string, unknown>;
    }>("select redacted_metadata from security_audit_records where action = 'world.created'");
    expect(successfulDecision.rows[0]!.redacted_metadata).toMatchObject({
      authorityReasonCode: 'ALLOWED',
      authorityRuleId: 'identity.active.create_world',
    });

    const dana = await register('dana@example.test', 'Dana');
    await client.pool.query("update users set platform_role = 'platform_admin' where id = $1", [
      dana.userId,
    ]);
    const platformAdminView = await app.inject({
      headers: { cookie: dana.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}`,
    });
    expect(platformAdminView.statusCode).toBe(200);
    expect(platformAdminView.json()).toMatchObject({ world: { role: null } });

    const promotedAgain = await app.inject({
      headers: mutationHeaders(alice, 'promote-bob-again'),
      method: 'PATCH',
      payload: { expectedRowVersion: overriddenVersion, role: 'administrator' },
      url: `/api/v1/worlds/${world.id}/memberships/${bob.userId}`,
    });
    expect(promotedAgain.statusCode).toBe(200);
    const platformOverride = await app.inject({
      headers: mutationHeaders(dana, 'platform-override-bob'),
      method: 'POST',
      payload: {
        ...overridePayload,
        expectedRowVersion: promotedAgain.json<{ membership: { rowVersion: number } }>().membership
          .rowVersion,
      },
      url: `/api/v1/worlds/${world.id}/creator-overrides`,
    });
    expect(platformOverride.statusCode).toBe(200);

    const audit = await app.inject({
      headers: { cookie: alice.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.id}/authority/audit`,
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).toContain('membership.force_demote_administrator');
    const counts = notifications.reduce<Record<string, number>>((result, notification) => {
      result[notification.type] = (result[notification.type] ?? 0) + 1;
      return result;
    }, {});
    expect(counts).toMatchObject({
      CreatorOverrideUsed: 2,
      IdentityRegistered: 4,
      InvitationAccepted: 2,
      InvitationCreated: 3,
      InvitationRevoked: 1,
      MembershipRemoved: 1,
      MembershipRoleChanged: 2,
      WorldCreated: 1,
    });
  });

  it('rotates presented sessions, makes logout retry-safe, and throttles normalized accounts', async () => {
    const erin = await register('erin@example.test', 'Erin');
    const login = await app.inject({
      headers: { cookie: erin.cookie, origin },
      method: 'POST',
      payload: { email: 'ERIN@example.test', password },
      url: '/api/v1/auth/login',
    });
    expect(login.statusCode).toBe(200);
    const rotated = sessionFromResponse(login);
    expect(
      (
        await app.inject({
          headers: { cookie: erin.cookie },
          method: 'GET',
          url: '/api/v1/auth/me',
        })
      ).statusCode,
    ).toBe(401);
    const crossOriginLogout = await app.inject({
      headers: {
        ...mutationHeaders(rotated, 'logout-cross-origin'),
        origin: 'https://attacker.example',
      },
      method: 'POST',
      url: '/api/v1/auth/logout',
    });
    expect(crossOriginLogout.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          headers: { cookie: rotated.cookie },
          method: 'GET',
          url: '/api/v1/auth/me',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          headers: mutationHeaders(rotated, 'logout-unused'),
          method: 'POST',
          url: '/api/v1/auth/logout',
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          headers: mutationHeaders(rotated, 'logout-retry-unused'),
          method: 'POST',
          url: '/api/v1/auth/logout',
        })
      ).statusCode,
    ).toBe(204);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const denied = await app.inject({
        headers: { origin },
        method: 'POST',
        payload: {
          email: attempt % 2 === 0 ? 'ALICE@example.test' : 'alice@example.test',
          password: 'Incorrect password value',
        },
        url: '/api/v1/auth/login',
      });
      expect(denied.statusCode).toBe(401);
    }
    const limited = await app.inject({
      headers: { origin },
      method: 'POST',
      payload: { email: 'Alice@example.test', password: 'Incorrect password value' },
      url: '/api/v1/auth/login',
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('maps service-level identity validation failures to stable client errors', async () => {
    for (const payload of [
      {
        displayName: 'Valid name',
        email: 'weak-password@example.test',
        password: 'abcdefghijkl',
      },
      {
        displayName: '   ',
        email: 'blank-display@example.test',
        password,
      },
    ]) {
      const response = await app.inject({
        headers: { origin },
        method: 'POST',
        payload,
        url: '/api/v1/auth/register',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
  });

  async function register(email: string, displayName: string): Promise<BrowserSession> {
    const response = await app.inject({
      headers: { origin },
      method: 'POST',
      payload: { displayName, email, password },
      url: '/api/v1/auth/register',
    });
    expect(response.statusCode).toBe(201);
    const session = sessionFromResponse(response);
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    expect(cookies.find((cookie) => cookie.startsWith('wg_session='))).toContain('HttpOnly');
    expect(cookies.every((cookie) => cookie.includes('SameSite=Lax'))).toBe(true);
    return {
      ...session,
      userId: response.json<{ user: { id: string } }>().user.id,
    };
  }
});

function sessionFromResponse(response: {
  headers: Record<string, number | string | string[] | undefined>;
}): BrowserSession {
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
    userId: '',
  };
}

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
