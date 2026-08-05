import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { RuntimeConfig } from '@worldgraph/config';
import {
  RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION,
  RETAINED_COMPILER_VERSION,
  SystemClock,
  UuidV7Generator,
  type ApplicationNotification,
  type CompiledArtifactV2,
  type CompiledWorldV2,
  type DomainEventEnvelopeV1,
} from '@worldgraph/contracts';
import { verifyCompiledArtifact } from '@worldgraph/compiler';
import {
  applyMigrations,
  createDatabaseClient,
  importStarterPrimitives,
  type DatabaseClient,
} from '@worldgraph/db';
import { createDeterministicFallback, starterManifestCatalog } from '@worldgraph/manifests';
import {
  compareWorldProjectionV1,
  createWorldProjectionV1,
  replayWorldProjectionV1,
} from '@worldgraph/ledger';
import { createLogger } from '@worldgraph/observability';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { CompilationRepository } from './compilation/repository.js';
import { CompilationService } from './compilation/service.js';
import { PostgresCommandRepository } from './commands/repository.js';
import { WorldCommandBus } from './commands/command-bus.js';
import { WorldCommandService } from './commands/service.js';
import { IdentityService, type AuthenticatedActor } from './identity/service.js';
import { Argon2idPasswordHasher, TEST_PASSWORD_HASH_OPTIONS } from './identity/security.js';
import { PostgresRepository } from './repositories/postgres-repository.js';
import { WorldService } from './worlds/service.js';

const origin = 'http://localhost:3000';
const password = 'Correct horse battery staple';
const cursorSecret = 'compiler-api-cursor-secret-at-least-32-characters';
const promptA =
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.';
const promptB =
  'A storm-battered floating city-state governed by lighthouse unions and ration councils.';

interface BrowserSession {
  cookie: string;
  csrf: string;
  userId: string;
}

interface ApprovedWorld {
  contentHash: string;
  revisionId: string;
  worldId: string;
}

interface CompilationStart {
  rowVersion: number;
  runId: string;
  stage: string;
  status: string;
}

interface EntityPage {
  items: Array<{ entityType: string; logicalKey: string; worldId: string }>;
  nextCursor: string | null;
  runtime: { activeWorldVersionId: string; stateRevision: number; worldVersionNumber: number };
}

interface RelationshipPage {
  items: Array<{ logicalKey: string; relationshipType: string; worldId: string }>;
  nextCursor: string | null;
}

interface WorkerRepositoryModule {
  PostgresWorldCompilationRepository: new (pool: Pool) => object;
}

interface WorkerRunnerModule {
  WorldCompilationRunner: new (
    repository: object,
    logger: ReturnType<typeof createLogger>,
    limits: { maxEntities: number; maxRelationships: number },
    options?: { maximumRunsPerReconciliation?: number },
  ) => {
    runOne(): Promise<{ code?: string; outcome: string; worldVersionId?: string }>;
  };
}

interface WorkerOutboxModule {
  PostgresOutboxRepository: new (pool: Pool) => {
    claim(
      workerId: string,
      limit: number,
      leaseMs: number,
    ): Promise<
      Array<{
        attempts: number;
        createdAt: Date;
        eventId: string | null;
        id: string;
        messageSchemaVersion: number;
        messageType: string;
        payload: unknown;
        worldId: string;
      }>
    >;
    publish(
      message: {
        attempts: number;
        createdAt: Date;
        eventId: string | null;
        id: string;
        messageSchemaVersion: number;
        messageType: string;
        payload: unknown;
        worldId: string;
      },
      workerId: string,
    ): Promise<boolean>;
  };
}

describe.sequential('compiler and runtime API security boundary', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let appClient: DatabaseClient;
  let client: DatabaseClient;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let creator: BrowserSession;
  let commands: WorldCommandService;
  let member: BrowserSession;
  let outsider: BrowserSession;
  let worldA: ApprovedWorld;
  let worldB: ApprovedWorld;
  let runA: CompilationStart;
  let runB: CompilationStart;
  const notifications: ApplicationNotification[] = [];
  const ids = new UuidV7Generator();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    client = createDatabaseClient(container.getConnectionUri(), 'compiler-runtime-api-test');
    await applyMigrations(client, resolve('packages/db/drizzle'));
    await importStarterPrimitives(client.pool);
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    appClient = createDatabaseClient(appUrl.toString(), 'compiler-runtime-api-app-role-test');
    appClient.pool.options.connectionTimeoutMillis = 60_000;

    const config = runtimeConfig();
    const clock = new SystemClock();
    const repository = new PostgresRepository(appClient.pool);
    const sink = {
      publish: async (notification: ApplicationNotification) => {
        notifications.push(notification);
      },
    };
    const identity = new IdentityService(
      repository,
      { ...config, authPepper: config.authPepper! },
      clock,
      ids,
      new Argon2idPasswordHasher(config.authPepper!, TEST_PASSWORD_HASH_OPTIONS),
      sink,
    );
    const worlds = new WorldService(
      repository,
      clock,
      ids,
      (id) => identity.invitationToken(id),
      (token) => identity.tokenHash(token, 'invitation'),
      sink,
    );
    const compilation = new CompilationService(
      new CompilationRepository(appClient.pool),
      config,
      clock,
      ids,
      sink,
      cursorSecret,
    );
    const commandRepository = new PostgresCommandRepository(appClient.pool, ids);
    commands = new WorldCommandService(
      new WorldCommandBus(commandRepository, ids),
      commandRepository,
      clock,
      cursorSecret,
    );
    app = await buildApp({
      clock,
      config,
      domain: { commands, compilation, identity, worlds },
      idGenerator: ids,
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'compiler-runtime-api-test',
      }),
      pool: appClient.pool,
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

    creator = await register('compiler-creator@example.test', 'Compiler Creator');
    member = await register('compiler-member@example.test', 'Compiler Member');
    outsider = await register('compiler-outsider@example.test', 'Compiler Outsider');
    worldA = await createApprovedWorld(
      creator,
      'Compiler Security Alpha',
      promptA,
      'api-security-world-a',
    );
    worldB = await createApprovedWorld(
      creator,
      'Compiler Security Beta',
      promptB,
      'api-security-world-b',
    );
    await client.pool.query(
      `insert into world_memberships(world_id,user_id,role,status,granted_by_user_id)
       values ($1,$2,'player','active',$3)`,
      [worldA.worldId, member.userId, creator.userId],
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await appClient?.pool.end();
    await client?.pool.end();
    await container?.stop();
  });

  it('enforces creator authority, exact manifest identity, client-input rejection, and idempotency', async () => {
    expect(worldA.contentHash).not.toBe(worldB.contentHash);
    const validPayload = {
      expectedManifestHash: worldA.contentHash,
      manifestRevisionId: worldA.revisionId,
      seed: 'compiler-api-security-seed-a',
    };

    const memberStart = await app.inject({
      headers: mutationHeaders(member, 'compiler-member-start'),
      method: 'POST',
      payload: validPayload,
      url: `/api/v1/worlds/${worldA.worldId}/compilations`,
    });
    expect(memberStart.statusCode, memberStart.body).toBe(403);
    expect(memberStart.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const outsiderStart = await app.inject({
      headers: mutationHeaders(outsider, 'compiler-outsider-start'),
      method: 'POST',
      payload: validPayload,
      url: `/api/v1/worlds/${worldA.worldId}/compilations`,
    });
    expect(outsiderStart.statusCode, outsiderStart.body).toBe(404);
    expect(outsiderStart.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const injectionMarker = 'CLIENT_ARTIFACT_MUST_NEVER_BECOME_AUTHORITY';
    const injected = await app.inject({
      headers: mutationHeaders(creator, 'compiler-client-artifact-injection'),
      method: 'POST',
      payload: {
        ...validPayload,
        clientCompiledArtifact: { canonicalBytes: injectionMarker, contentHash: '0'.repeat(64) },
      },
      url: `/api/v1/worlds/${worldA.worldId}/compilations`,
    });
    expect(injected.statusCode, injected.body).toBe(400);
    expect(injected.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(injected.body).not.toContain(injectionMarker);
    const rejectedInjection = await client.pool.query<{ count: string }>(
      `select count(*)::text as count from idempotency_records
        where actor_id = $1 and key = 'compiler-client-artifact-injection'`,
      [creator.userId],
    );
    expect(Number(rejectedInjection.rows[0]?.count ?? 0)).toBe(0);

    const swappedRevision = await app.inject({
      headers: mutationHeaders(creator, 'compiler-swapped-revision'),
      method: 'POST',
      payload: {
        expectedManifestHash: worldB.contentHash,
        manifestRevisionId: worldB.revisionId,
        seed: validPayload.seed,
      },
      url: `/api/v1/worlds/${worldA.worldId}/compilations`,
    });
    expect(swappedRevision.statusCode, swappedRevision.body).toBe(409);
    expect(swappedRevision.json()).toMatchObject({ error: { code: 'MANIFEST_NOT_CURRENT' } });

    const swappedHash = await app.inject({
      headers: mutationHeaders(creator, 'compiler-swapped-hash'),
      method: 'POST',
      payload: { ...validPayload, expectedManifestHash: worldB.contentHash },
      url: `/api/v1/worlds/${worldA.worldId}/compilations`,
    });
    expect(swappedHash.statusCode, swappedHash.body).toBe(409);
    expect(swappedHash.json()).toMatchObject({ error: { code: 'MANIFEST_NOT_CURRENT' } });

    const headers = mutationHeaders(creator, 'compiler-exact-replay');
    const start = await app.inject({
      headers,
      method: 'POST',
      payload: validPayload,
      url: `/api/v1/worlds/${worldA.worldId}/compilations`,
    });
    expect(start.statusCode, start.body).toBe(202);
    runA = start.json<CompilationStart>();
    expect(runA).toMatchObject({ stage: 'queued', status: 'queued' });

    const replay = await app.inject({
      headers,
      method: 'POST',
      payload: validPayload,
      url: `/api/v1/worlds/${worldA.worldId}/compilations`,
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toEqual(start.json());

    const conflict = await app.inject({
      headers,
      method: 'POST',
      payload: { ...validPayload, seed: 'compiler-api-security-seed-conflict' },
      url: `/api/v1/worlds/${worldA.worldId}/compilations`,
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });

    const persisted = await client.pool.query<{ idempotency_count: string; run_count: string }>(
      `select
         (select count(*) from world_compilation_runs where world_id = $1)::text as run_count,
         (select count(*) from idempotency_records
           where actor_id = $2 and scope = 'world.compilation.start'
             and key = 'compiler-exact-replay' and state = 'completed')::text as idempotency_count`,
      [worldA.worldId, creator.userId],
    );
    expect(persisted.rows[0]).toEqual({ idempotency_count: '1', run_count: '1' });

    const memberRead = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/compilations/${runA.runId}`,
    });
    expect(memberRead.statusCode, memberRead.body).toBe(200);
    expect(memberRead.json()).toMatchObject({ id: runA.runId, worldId: worldA.worldId });

    const outsiderRead = await app.inject({
      headers: { cookie: outsider.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/compilations/${runA.runId}`,
    });
    expect(outsiderRead.statusCode, outsiderRead.body).toBe(404);

    const crossWorldRead = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldB.worldId}/compilations/${runA.runId}`,
    });
    expect(crossWorldRead.statusCode, crossWorldRead.body).toBe(404);

    expect(
      notifications.filter(
        (notification) =>
          notification.type === 'WorldCompilationRequested' &&
          notification.payload.runId === runA.runId,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(notifications)).not.toContain(promptA);
    expect(JSON.stringify(notifications)).not.toContain('compiler-creator@example.test');
  }, 60_000);

  it('activates real compiled worlds and keeps runtime reads tenant-scoped', async () => {
    await expect(runWorkerOnce(client.pool)).resolves.toMatchObject({ outcome: 'succeeded' });

    const startB = await app.inject({
      headers: mutationHeaders(creator, 'compiler-world-b-start'),
      method: 'POST',
      payload: {
        expectedManifestHash: worldB.contentHash,
        manifestRevisionId: worldB.revisionId,
        seed: 'compiler-api-security-seed-b',
      },
      url: `/api/v1/worlds/${worldB.worldId}/compilations`,
    });
    expect(startB.statusCode, startB.body).toBe(202);
    runB = startB.json<CompilationStart>();
    await expect(runWorkerOnce(client.pool)).resolves.toMatchObject({ outcome: 'succeeded' });

    const summaryA = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/runtime-summary`,
    });
    expect(summaryA.statusCode, summaryA.body).toBe(200);
    expect(summaryA.json()).toMatchObject({
      lifecycle: 'active',
      manifestContentHash: worldA.contentHash,
      manifestRevisionId: worldA.revisionId,
      worldId: worldA.worldId,
      worldVersionNumber: 1,
    });
    expect(summaryA.json<{ activeWorldVersionId: string }>().activeWorldVersionId).toMatch(
      /^[a-f0-9-]{36}$/u,
    );

    const summaryB = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldB.worldId}/runtime-summary`,
    });
    expect(summaryB.statusCode, summaryB.body).toBe(200);
    expect(summaryB.json()).toMatchObject({
      lifecycle: 'active',
      manifestContentHash: worldB.contentHash,
      worldId: worldB.worldId,
    });
    expect(summaryB.json<{ artifactHash: string }>().artifactHash).not.toBe(
      summaryA.json<{ artifactHash: string }>().artifactHash,
    );

    const outsiderSummary = await app.inject({
      headers: { cookie: outsider.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/runtime-summary`,
    });
    expect(outsiderSummary.statusCode, outsiderSummary.body).toBe(404);

    const memberCrossWorld = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldB.worldId}/runtime-summary`,
    });
    expect(memberCrossWorld.statusCode, memberCrossWorld.body).toBe(404);

    const worldALocalKey = await client.pool.query<{ logical_key: string }>(
      `select alpha.logical_key::text
         from world_entities alpha
        where alpha.world_id = $1
          and not exists (
            select 1 from world_entities beta
             where beta.world_id = $2 and beta.logical_key = alpha.logical_key
          )
        order by alpha.logical_key::text collate "C" limit 1`,
      [worldA.worldId, worldB.worldId],
    );
    expect(worldALocalKey.rows[0]).toBeDefined();
    const crossWorldEntity = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldB.worldId}/entities/${encodeURIComponent(
        worldALocalKey.rows[0]!.logical_key,
      )}`,
    });
    expect(crossWorldEntity.statusCode, crossWorldEntity.body).toBe(404);

    const crossWorldArtifact = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldB.worldId}/compilations/${runA.runId}/artifact`,
    });
    expect(crossWorldArtifact.statusCode, crossWorldArtifact.body).toBe(404);
  }, 60_000);

  it('adapts an anchored legacy route through replay, rejection, outbox and projection replay', async () => {
    const beforeWorld = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(beforeWorld.statusCode, beforeWorld.body).toBe(200);
    const original = beforeWorld.json<{ world: { name: string; rowVersion: number } }>().world;

    const deniedHeaders = mutationHeaders(member, 'legacy-world-rename-visible-denial');
    const deniedPayload = {
      expectedRowVersion: original.rowVersion,
      name: 'Player Must Not Rename This World',
    };
    const denied = await app.inject({
      headers: deniedHeaders,
      method: 'PATCH',
      payload: deniedPayload,
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const deniedReplay = await app.inject({
      headers: deniedHeaders,
      method: 'PATCH',
      payload: deniedPayload,
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(deniedReplay.statusCode, deniedReplay.body).toBe(403);
    expect(withoutRequestId(deniedReplay.json())).toEqual(withoutRequestId(denied.json()));
    const durableDenial = await client.pool.query<{
      commands: string;
      events: string;
      ledger: string;
      rejection_code: string;
    }>(
      `select command.rejection_code,
              count(distinct command.id)::text commands,
              count(distinct event.id)::text events,
              count(distinct entry.id)::text ledger
         from command_records command
         left join domain_events event on event.command_id=command.id
         left join ledger_entries entry on entry.command_id=command.id
        where command.world_id=$1
          and command.idempotency_key='legacy-world-rename-visible-denial'
          and command.status='rejected'
        group by command.rejection_code`,
      [worldA.worldId],
    );
    expect(durableDenial.rows[0]).toEqual({
      commands: '1',
      events: '0',
      ledger: '1',
      rejection_code: 'AUTHORIZATION_DENIED',
    });
    const afterDenial = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(afterDenial.json()).toMatchObject({ world: original });

    const beforeHead = await runtimeHead(worldA.worldId);
    const acceptedHeaders = mutationHeaders(creator, 'legacy-world-rename-accepted');
    const acceptedPayload = {
      expectedRowVersion: original.rowVersion,
      name: 'Compiler Security Alpha Renamed',
    };
    const accepted = await app.inject({
      headers: acceptedHeaders,
      method: 'PATCH',
      payload: acceptedPayload,
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      world: {
        name: acceptedPayload.name,
        rowVersion: original.rowVersion + 1,
      },
    });
    const acceptedReplay = await app.inject({
      headers: acceptedHeaders,
      method: 'PATCH',
      payload: acceptedPayload,
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(acceptedReplay.statusCode, acceptedReplay.body).toBe(200);
    expect(acceptedReplay.json()).toEqual(accepted.json());

    const staleHeaders = mutationHeaders(creator, 'legacy-world-rename-stale');
    const stalePayload = { expectedRowVersion: original.rowVersion, name: 'Stale Legacy Name' };
    const stale = await app.inject({
      headers: staleHeaders,
      method: 'PATCH',
      payload: stalePayload,
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'STALE_VERSION' } });
    const staleReplay = await app.inject({
      headers: staleHeaders,
      method: 'PATCH',
      payload: stalePayload,
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(staleReplay.statusCode, staleReplay.body).toBe(409);
    expect(withoutRequestId(staleReplay.json())).toEqual(withoutRequestId(stale.json()));

    const afterHead = await runtimeHead(worldA.worldId);
    expect(afterHead.stateRevision).toBe(String(BigInt(beforeHead.stateRevision) + 1n));
    expect(afterHead.lastEventSequence).toBe(String(BigInt(beforeHead.lastEventSequence) + 1n));
    expect(afterHead.lastLedgerSequence).toBe(String(BigInt(beforeHead.lastLedgerSequence) + 3n));
    const persisted = await client.pool.query<{
      accepted_commands: string;
      accepted_events: string;
      accepted_history: string;
      accepted_ledger: string;
      outbox_messages: string;
      rejected_commands: string;
      rejected_events: string;
      rejected_history: string;
      rejected_ledger: string;
    }>(
      `select
         (select count(*) from command_records where world_id=$1 and command_type='RenameWorldV1'
           and idempotency_key='legacy-world-rename-accepted' and status='accepted')::text
           as accepted_commands,
         (select count(*) from domain_events event join command_records command
           on command.id=event.command_id where event.world_id=$1
           and command.idempotency_key='legacy-world-rename-accepted'
           and event.event_type='WorldRenamedV1')::text as accepted_events,
         (select count(*) from ledger_entries entry join command_records command
           on command.id=entry.command_id where entry.world_id=$1
           and command.idempotency_key='legacy-world-rename-accepted')::text as accepted_ledger,
         (select count(*) from world_history_entries history join command_records command
           on command.id=history.command_id where history.world_id=$1
           and command.idempotency_key='legacy-world-rename-accepted'
           and history.title_key='history.world.renamed')::text as accepted_history,
         (select count(*) from outbox_messages outbox join domain_events event
           on event.id=outbox.event_id join command_records command on command.id=event.command_id
           where outbox.world_id=$1
           and command.idempotency_key='legacy-world-rename-accepted')::text as outbox_messages,
         (select count(*) from command_records where world_id=$1 and command_type='RenameWorldV1'
           and idempotency_key='legacy-world-rename-stale' and status='rejected')::text
           as rejected_commands,
         (select count(*) from domain_events event join command_records command
           on command.id=event.command_id where event.world_id=$1
           and command.idempotency_key='legacy-world-rename-stale')::text as rejected_events,
         (select count(*) from ledger_entries entry join command_records command
           on command.id=entry.command_id where entry.world_id=$1
           and command.idempotency_key='legacy-world-rename-stale'
           and entry.entry_kind='command_rejected')::text as rejected_ledger,
         (select count(*) from world_history_entries history join command_records command
           on command.id=history.command_id where history.world_id=$1
           and command.idempotency_key='legacy-world-rename-stale'
           and history.title_key='history.command.rejected')::text as rejected_history`,
      [worldA.worldId],
    );
    expect(persisted.rows[0]).toEqual({
      accepted_commands: '1',
      accepted_events: '1',
      accepted_history: '1',
      accepted_ledger: '2',
      outbox_messages: '1',
      rejected_commands: '1',
      rejected_events: '0',
      rejected_history: '1',
      rejected_ledger: '1',
    });

    const adaptedOutboxId = await client.pool.query<{ id: string }>(
      `select outbox.id from outbox_messages outbox
       join domain_events event on event.id=outbox.event_id
       join command_records command on command.id=event.command_id
       where command.world_id=$1 and command.idempotency_key='legacy-world-rename-accepted'`,
      [worldA.worldId],
    );
    await consumePendingOutbox();
    const consumed = await client.pool.query<{
      history_count: string;
      receipt_count: string;
      status: string;
    }>(
      `select outbox.status::text,
         (select count(*) from world_history_entries history
           where history.event_id=outbox.event_id)::text as history_count,
         (select count(*) from event_consumer_receipts receipt
           where receipt.event_id=outbox.event_id and receipt.consumer_name='world_history_v1')::text
           as receipt_count
       from outbox_messages outbox where outbox.id=$1`,
      [adaptedOutboxId.rows[0]!.id],
    );
    expect(consumed.rows[0]).toEqual({
      history_count: '1',
      receipt_count: '1',
      status: 'published',
    });

    const replay = await replayProjection(worldA.worldId);
    expect(replay.eventTypes).toContain('WorldRenamedV1');
    expect(replay.lastEventSequence).toBe(afterHead.lastEventSequence);
    expect(replay.replayedChecksum).toBe(replay.liveChecksum);
    expect(replay.comparison.equal).toBe(true);

    const anchoredWorld = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(anchoredWorld.statusCode, anchoredWorld.body).toBe(200);
    const beforeAnchorFailure = anchoredWorld.json<{
      world: { name: string; rowVersion: number };
    }>().world;
    const anchor = await client.pool.query<{
      anchor_artifact_hash: Buffer;
      anchor_event_id: string;
      anchored_at: Date;
    }>(
      `select anchored_at, anchor_event_id, anchor_artifact_hash
         from world_ledger_heads where world_id=$1`,
      [worldA.worldId],
    );
    const savedAnchor = anchor.rows[0]!;
    await client.pool.query(
      'alter table world_ledger_heads disable trigger world_ledger_heads_protect',
    );
    try {
      await client.pool.query(
        `update world_ledger_heads
            set anchored_at=null, anchor_event_id=null, anchor_artifact_hash=null
          where world_id=$1`,
        [worldA.worldId],
      );
    } finally {
      await client.pool.query(
        'alter table world_ledger_heads enable trigger world_ledger_heads_protect',
      );
    }
    try {
      const failClosed = await app.inject({
        headers: mutationHeaders(creator, 'legacy-world-rename-corrupt-anchor'),
        method: 'PATCH',
        payload: {
          expectedRowVersion: beforeAnchorFailure.rowVersion,
          name: 'Must Roll Back Without A Valid Anchor',
        },
        url: `/api/v1/worlds/${worldA.worldId}`,
      });
      expect(failClosed.statusCode, failClosed.body).toBe(503);
      expect(failClosed.json()).toMatchObject({ error: { code: 'WORLD_NOT_ANCHORED' } });
    } finally {
      await client.pool.query(
        'alter table world_ledger_heads disable trigger world_ledger_heads_protect',
      );
      try {
        await client.pool.query(
          `update world_ledger_heads
              set anchored_at=$2, anchor_event_id=$3, anchor_artifact_hash=$4
            where world_id=$1`,
          [
            worldA.worldId,
            savedAnchor.anchored_at,
            savedAnchor.anchor_event_id,
            savedAnchor.anchor_artifact_hash,
          ],
        );
      } finally {
        await client.pool.query(
          'alter table world_ledger_heads enable trigger world_ledger_heads_protect',
        );
      }
    }
    const afterAnchorFailure = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}`,
    });
    expect(afterAnchorFailure.statusCode, afterAnchorFailure.body).toBe(200);
    expect(afterAnchorFailure.json()).toMatchObject({ world: beforeAnchorFailure });
    const rolledBackAnchorCommand = await client.pool.query<{ count: string }>(
      `select count(*)::text from command_records
        where world_id=$1 and idempotency_key='legacy-world-rename-corrupt-anchor'`,
      [worldA.worldId],
    );
    expect(rolledBackAnchorCommand.rows[0]?.count).toBe('0');
  }, 60_000);

  it('atomically accepts, replays and durably rejects world commands against real PostgreSQL', async () => {
    const entityResponse = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities?entityType=district&limit=1`,
    });
    expect(entityResponse.statusCode, entityResponse.body).toBe(200);
    const entity = entityResponse.json<{
      items: Array<{ logicalKey: string; rowVersion: number; state: { name: string } }>;
    }>().items[0]!;
    const headResponse = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/runtime-head`,
    });
    expect(headResponse.statusCode, headResponse.body).toBe(200);
    const head = headResponse.json<{
      designVersion: string;
      lastEventSequence: string;
      lastLedgerSequence: string;
      stateRevision: string;
    }>();
    const acceptedCommandId = ids.next();
    const acceptedPayload = {
      commandId: acceptedCommandId,
      expectedAggregateVersion: String(entity.rowVersion + 1),
      expectedStateRevision: head.stateRevision,
      expectedWorldVersion: head.designVersion,
      idempotencyKey: 'real-db-rename-accepted',
      payload: { entityKey: entity.logicalKey, newDisplayName: 'Harbor Commons' },
      schemaVersion: 1,
      type: 'RenameWorldEntityV1',
    };
    const accepted = await app.inject({
      headers: mutationHeaders(creator, 'transport-key-unused'),
      method: 'POST',
      payload: acceptedPayload,
      url: `/api/v1/worlds/${worldA.worldId}/commands`,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const acceptedResult = accepted.json<{
      eventIds: string[];
      ledgerSequenceRange: { from: string; to: string };
      resultingStateRevision: string;
      status: string;
    }>();
    expect(acceptedResult).toMatchObject({
      resultingStateRevision: String(BigInt(head.stateRevision) + 1n),
      status: 'accepted',
    });
    expect(acceptedResult.eventIds).toHaveLength(1);
    expect(
      BigInt(acceptedResult.ledgerSequenceRange.to) -
        BigInt(acceptedResult.ledgerSequenceRange.from),
    ).toBe(1n);

    const replay = await app.inject({
      headers: mutationHeaders(creator, 'transport-key-unused-again'),
      method: 'POST',
      payload: acceptedPayload,
      url: `/api/v1/worlds/${worldA.worldId}/commands`,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(accepted.json());

    const staleCommandId = ids.next();
    const stale = await app.inject({
      headers: mutationHeaders(creator, 'transport-key-unused-stale'),
      method: 'POST',
      payload: {
        ...acceptedPayload,
        commandId: staleCommandId,
        idempotencyKey: 'real-db-rename-stale',
        payload: { entityKey: entity.logicalKey, newDisplayName: 'Stale Harbor Name' },
      },
      url: `/api/v1/worlds/${worldA.worldId}/commands`,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({
      commandId: staleCommandId,
      currentStateRevision: acceptedResult.resultingStateRevision,
      eventIds: [],
      rejectionCode: 'REVISION_CONFLICT',
      status: 'rejected',
    });

    const persisted = await client.pool.query<{
      accepted_commands: string;
      accepted_events: string;
      accepted_ledger: string;
      outbox_messages: string;
      projected_name: string;
      rejected_commands: string;
      rejected_events: string;
      rejected_history: string;
      rejected_ledger: string;
    }>(
      `select
         (select count(*) from command_records where id = $2 and status = 'accepted')::text
           as accepted_commands,
         (select count(*) from domain_events where command_id = $2)::text as accepted_events,
         (select count(*) from ledger_entries where command_id = $2)::text as accepted_ledger,
         (select count(*) from outbox_messages where event_id = any($4::uuid[]))::text
           as outbox_messages,
         (select state ->> 'name' from world_entities
           where world_id = $1 and logical_key = $5)::text as projected_name,
         (select count(*) from command_records where id = $3 and status = 'rejected')::text
           as rejected_commands,
         (select count(*) from domain_events where command_id = $3)::text as rejected_events,
         (select count(*) from ledger_entries
           where command_id = $3 and entry_kind = 'command_rejected')::text as rejected_ledger,
         (select count(*) from world_history_entries
           where command_id = $3 and title_key = 'history.command.rejected')::text
           as rejected_history`,
      [
        worldA.worldId,
        acceptedCommandId,
        staleCommandId,
        acceptedResult.eventIds,
        entity.logicalKey,
      ],
    );
    expect(persisted.rows[0]).toEqual({
      accepted_commands: '1',
      accepted_events: '1',
      accepted_ledger: '2',
      outbox_messages: '1',
      projected_name: 'Harbor Commons',
      rejected_commands: '1',
      rejected_events: '0',
      rejected_history: '1',
      rejected_ledger: '1',
    });

    const commandStatus = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/commands/${acceptedCommandId}`,
    });
    expect(commandStatus.statusCode, commandStatus.body).toBe(200);
    expect(commandStatus.json()).toEqual(accepted.json());
    const history = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/history?${new URLSearchParams({
        actorId: creator.userId,
        targetId: entity.logicalKey,
      })}`,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json()).toMatchObject({
      items: [
        {
          commandId: staleCommandId,
          summaryArgs: {
            commandType: 'RenameWorldEntityV1',
            entityKey: entity.logicalKey,
            rejectionCode: 'REVISION_CONFLICT',
          },
          visibility: 'creator',
        },
      ],
    });
    expect(history.body).not.toContain('Stale Harbor Name');
    expect(history.body).not.toContain('private.person@example.test');

    const concurrentCommandIds = Array.from({ length: 50 }, () => ids.next());
    const concurrentActor = {
      user: { id: creator.userId, platformRole: 'user' },
    } as AuthenticatedActor;
    const concurrent = await Promise.all(
      concurrentCommandIds.map((concurrentCommandId, index) =>
        commands.submit(
          concurrentActor,
          worldA.worldId,
          {
            ...acceptedPayload,
            commandId: concurrentCommandId,
            expectedAggregateVersion: '2',
            expectedStateRevision: acceptedResult.resultingStateRevision,
            idempotencyKey: `real-db-rename-race-${String(index)}`,
            payload: {
              entityKey: entity.logicalKey,
              newDisplayName: index === 0 ? 'North Harbor Commons' : 'South Harbor Commons',
            },
          },
          ids.next(),
        ),
      ),
    );
    expect(concurrent.filter((outcome) => outcome.result.status === 'accepted')).toHaveLength(1);
    expect(concurrent.filter((outcome) => outcome.result.status === 'rejected')).toHaveLength(49);
    const concurrentPersistence = await client.pool.query<{
      accepted: string;
      events: string;
      rejected: string;
      row_version: string;
    }>(
      `select
         count(*) filter (where status = 'accepted')::text as accepted,
         count(*) filter (where status = 'rejected')::text as rejected,
         (select count(*) from domain_events
           where command_id = any($1::uuid[]))::text as events,
         (select row_version::text from world_entities
           where world_id = $2 and logical_key = $3) as row_version
       from command_records where id = any($1::uuid[])`,
      [concurrentCommandIds, worldA.worldId, entity.logicalKey],
    );
    expect(concurrentPersistence.rows[0]).toEqual({
      accepted: '1',
      events: '1',
      rejected: '49',
      row_version: '2',
    });

    const outsiderHistory = await app.inject({
      headers: { cookie: outsider.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/history`,
    });
    expect(outsiderHistory.statusCode, outsiderHistory.body).toBe(404);
    expect(outsiderHistory.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  }, 60_000);

  it('bounds and cryptographically binds entity, relationship, and neighbor cursors', async () => {
    const firstEntities = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities?limit=1`,
    });
    expect(firstEntities.statusCode, firstEntities.body).toBe(200);
    const entityPage = firstEntities.json<EntityPage>();
    expect(entityPage.items).toHaveLength(1);
    expect(entityPage.items[0]!.worldId).toBe(worldA.worldId);
    expect(entityPage.nextCursor).not.toBeNull();
    expect(entityPage.nextCursor!.length).toBeLessThanOrEqual(1_024);

    const nextEntities = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities?${new URLSearchParams({
        cursor: entityPage.nextCursor!,
        limit: '1',
      })}`,
    });
    expect(nextEntities.statusCode, nextEntities.body).toBe(200);
    expect(nextEntities.json<EntityPage>().items[0]!.logicalKey).not.toBe(
      entityPage.items[0]!.logicalKey,
    );

    const tamperedEntityCursor = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities?${new URLSearchParams({
        cursor: tamper(entityPage.nextCursor!),
        limit: '1',
      })}`,
    });
    expect(tamperedEntityCursor.statusCode, tamperedEntityCursor.body).toBe(400);
    expect(tamperedEntityCursor.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });

    const filterBoundEntityCursor = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities?${new URLSearchParams({
        cursor: entityPage.nextCursor!,
        entityType: entityPage.items[0]!.entityType,
        limit: '1',
      })}`,
    });
    expect(filterBoundEntityCursor.statusCode, filterBoundEntityCursor.body).toBe(400);
    expect(filterBoundEntityCursor.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });

    const worldBoundEntityCursor = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldB.worldId}/entities?${new URLSearchParams({
        cursor: entityPage.nextCursor!,
        limit: '1',
      })}`,
    });
    expect(worldBoundEntityCursor.statusCode, worldBoundEntityCursor.body).toBe(400);
    expect(worldBoundEntityCursor.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });

    const overLimit = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities?limit=101`,
    });
    expect(overLimit.statusCode, overLimit.body).toBe(400);
    expect(overLimit.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const maximumPage = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities?limit=100`,
    });
    expect(maximumPage.statusCode, maximumPage.body).toBe(200);
    expect(maximumPage.json<EntityPage>().items.length).toBeLessThanOrEqual(100);

    const firstRelationships = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/relationships?limit=1`,
    });
    expect(firstRelationships.statusCode, firstRelationships.body).toBe(200);
    const relationshipPage = firstRelationships.json<RelationshipPage>();
    expect(relationshipPage.items).toHaveLength(1);
    expect(relationshipPage.items[0]!.worldId).toBe(worldA.worldId);
    expect(relationshipPage.nextCursor).not.toBeNull();
    expect(relationshipPage.nextCursor!.length).toBeLessThanOrEqual(1_024);
    const filterBoundRelationshipCursor = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/relationships?${new URLSearchParams({
        cursor: relationshipPage.nextCursor!,
        limit: '1',
        relationshipType: relationshipPage.items[0]!.relationshipType,
      })}`,
    });
    expect(filterBoundRelationshipCursor.statusCode, filterBoundRelationshipCursor.body).toBe(400);
    expect(filterBoundRelationshipCursor.json()).toMatchObject({
      error: { code: 'INVALID_CURSOR' },
    });

    const roots = await client.pool.query<{ logical_key: string }>(
      `select entity.logical_key::text as logical_key
         from world_entities entity
         join world_relationships relationship
           on relationship.world_id = entity.world_id
          and (relationship.source_entity_id = entity.id or relationship.target_entity_id = entity.id)
        where entity.world_id = $1 and relationship.retired_world_version_id is null
        group by entity.logical_key
        order by count(*) desc, entity.logical_key::text collate "C"
        limit 2`,
      [worldA.worldId],
    );
    expect(roots.rows).toHaveLength(2);
    const firstRoot = roots.rows[0]!.logical_key;
    const secondRoot = roots.rows[1]!.logical_key;
    const firstNeighbors = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities/${encodeURIComponent(
        firstRoot,
      )}/neighbors?limit=1`,
    });
    expect(firstNeighbors.statusCode, firstNeighbors.body).toBe(200);
    const neighborPage = firstNeighbors.json<{
      items: Array<{ neighbor: { worldId: string }; relationship: { worldId: string } }>;
      nextCursor: string | null;
    }>();
    expect(neighborPage.items).toHaveLength(1);
    expect(neighborPage.items[0]).toMatchObject({
      neighbor: { worldId: worldA.worldId },
      relationship: { worldId: worldA.worldId },
    });
    expect(neighborPage.nextCursor).not.toBeNull();
    expect(neighborPage.nextCursor!.length).toBeLessThanOrEqual(1_024);

    const rootBoundCursor = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities/${encodeURIComponent(
        secondRoot,
      )}/neighbors?${new URLSearchParams({ cursor: neighborPage.nextCursor!, limit: '1' })}`,
    });
    expect(rootBoundCursor.statusCode, rootBoundCursor.body).toBe(400);
    expect(rootBoundCursor.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });

    const directionBoundCursor = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/entities/${encodeURIComponent(
        firstRoot,
      )}/neighbors?${new URLSearchParams({
        cursor: neighborPage.nextCursor!,
        direction: 'inbound',
        limit: '1',
      })}`,
    });
    expect(directionBoundCursor.statusCode, directionBoundCursor.body).toBe(400);
    expect(directionBoundCursor.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  }, 60_000);

  it('verifies artifacts on read and redacts injected corruption', async () => {
    const artifactResponse = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/compilations/${runA.runId}/artifact`,
    });
    expect(artifactResponse.statusCode, artifactResponse.body).toBe(200);
    const artifact = artifactResponse.json<CompiledArtifactV2>();
    expect(artifact).toMatchObject({
      artifactSchemaVersion: RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION,
      world: {
        artifactSchemaVersion: RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION,
        compilerVersion: RETAINED_COMPILER_VERSION,
        economySeedPlan: { economySeedPlanSchemaVersion: 1 },
      },
    });
    expect(artifact.world.economySeedPlanHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(verifyCompiledArtifact(artifact)).toMatchObject({ valid: true });
    expect(artifactResponse.body).not.toContain('compiler-creator@example.test');
    expect(artifactResponse.body).not.toContain('compiler-member@example.test');
    expect(artifactResponse.body).not.toContain(password);
    expect(artifactResponse.body).not.toContain(promptA);

    const outsiderArtifact = await app.inject({
      headers: { cookie: outsider.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/compilations/${runA.runId}/artifact`,
    });
    expect(outsiderArtifact.statusCode, outsiderArtifact.body).toBe(404);

    const corruptionMarker = 'PRIVATE_CORRUPTED_ARTIFACT_BYTES_MUST_BE_REDACTED';
    const connection = await client.pool.connect();
    try {
      await connection.query("set session_replication_role = 'replica'");
      await connection.query(
        `update compiled_world_artifacts
            set canonical_content = jsonb_set(
              canonical_content,
              '{metadata,description}',
              to_jsonb($3::text),
              false
            )
          where world_id = $1 and compilation_run_id = $2
            and artifact_kind = 'compiled_world'`,
        [worldA.worldId, runA.runId, corruptionMarker],
      );
    } finally {
      await connection.query("set session_replication_role = 'origin'").catch(() => undefined);
      connection.release();
    }

    const corrupted = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/compilations/${runA.runId}/artifact`,
    });
    expect(corrupted.statusCode, corrupted.body).toBe(500);
    expect(corrupted.json()).toMatchObject({ error: { code: 'ARTIFACT_CORRUPT' } });
    expect(corrupted.body).not.toContain(corruptionMarker);
    expect(corrupted.body).not.toContain('ARTIFACT_HASH_MISMATCH');
    expect(corrupted.body).not.toContain('canonicalBytes');

    const runStillScoped = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldB.worldId}/compilations/${runB.runId}`,
    });
    expect(runStillScoped.statusCode, runStillScoped.body).toBe(200);
    expect(runStillScoped.json()).toMatchObject({ id: runB.runId, worldId: worldB.worldId });
  }, 60_000);

  async function runtimeHead(checkedWorldId: string): Promise<{
    lastEventSequence: string;
    lastLedgerSequence: string;
    stateRevision: string;
  }> {
    const result = await client.pool.query<{
      last_event_sequence: string;
      last_ledger_sequence: string;
      state_revision: string;
    }>(
      `select last_event_sequence::text, last_ledger_sequence::text, state_revision::text
         from world_runtime_heads where world_id=$1`,
      [checkedWorldId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Missing runtime head.');
    return {
      lastEventSequence: row.last_event_sequence,
      lastLedgerSequence: row.last_ledger_sequence,
      stateRevision: row.state_revision,
    };
  }

  async function consumePendingOutbox(): Promise<void> {
    const repositoryPath = new URL(
      ['..', '..', 'worker', 'src', 'outbox-repository.ts'].join('/'),
      import.meta.url,
    ).href;
    const module = (await import(repositoryPath)) as unknown as WorkerOutboxModule;
    const repository = new module.PostgresOutboxRepository(client.pool);
    const workerId = 'legacy-adapter-outbox-integration';
    const messages = await repository.claim(workerId, 100, 30_000);
    for (const message of messages) {
      await expect(repository.publish(message, workerId)).resolves.toBe(true);
    }
  }

  async function replayProjection(checkedWorldId: string): Promise<{
    comparison: ReturnType<typeof compareWorldProjectionV1>;
    eventTypes: string[];
    lastEventSequence: string;
    liveChecksum: string;
    replayedChecksum: string;
  }> {
    const storedEvents = await client.pool.query<{
      aggregate_id: string;
      aggregate_type: string;
      aggregate_version: string;
      command_id: string;
      event_hash: Buffer;
      event_ordinal: number;
      event_schema_version: number;
      event_type: string;
      id: string;
      metadata: DomainEventEnvelopeV1['metadata'];
      occurred_at: Date;
      payload: DomainEventEnvelopeV1['payload'];
      recorded_at: Date;
      resulting_state_revision: string;
      world_event_sequence: string;
      world_id: string;
    }>(
      `select id,world_id,world_event_sequence::text,command_id,event_ordinal,
              aggregate_type,aggregate_id,aggregate_version::text,event_type,
              event_schema_version,payload,metadata,event_hash,occurred_at,recorded_at,
              resulting_state_revision::text
         from domain_events where world_id=$1 order by world_event_sequence`,
      [checkedWorldId],
    );
    const events = storedEvents.rows.map(
      (row) =>
        ({
          aggregateId: row.aggregate_id,
          aggregateType: row.aggregate_type,
          aggregateVersion: row.aggregate_version,
          commandId: row.command_id,
          eventHash: row.event_hash.toString('hex'),
          eventId: row.id,
          eventOrdinal: row.event_ordinal,
          eventSchemaVersion: row.event_schema_version,
          eventType: row.event_type,
          metadata: row.metadata,
          occurredAt: row.occurred_at.toISOString(),
          payload: row.payload,
          recordedAt: row.recorded_at.toISOString(),
          resultingStateRevision: row.resulting_state_revision,
          worldEventSequence: row.world_event_sequence,
          worldId: row.world_id,
        }) as DomainEventEnvelopeV1,
    );
    const genesis = events[0];
    if (
      !genesis ||
      (genesis.eventType !== 'WorldCompiledGenesisV1' &&
        genesis.eventType !== 'WorldStateImportedV1')
    ) {
      throw new Error('Missing replay genesis.');
    }
    const artifact = await client.pool.query<{ canonical_content: CompiledWorldV2 }>(
      `select artifact.canonical_content
         from world_versions version
         join compiled_world_artifacts artifact
           on artifact.compilation_run_id=version.compilation_run_id
          and artifact.world_id=version.world_id and artifact.artifact_kind='compiled_world'
        where version.world_id=$1 and version.id=$2`,
      [checkedWorldId, genesis.payload.activeWorldVersionId],
    );
    const compiledWorld = artifact.rows[0]?.canonical_content;
    if (!compiledWorld) throw new Error('Missing replay artifact.');
    const genesisProjection = createWorldProjectionV1({
      activeWorldVersionId: genesis.payload.activeWorldVersionId,
      compiledWorld,
      stateRevision: genesis.resultingStateRevision,
      worldId: checkedWorldId,
      worldVersionNumber: genesis.payload.worldVersionNumber,
    });
    const replayed = replayWorldProjectionV1({ events, genesisProjection });
    const runtime = await client.pool.query<{
      projection_checksum: Buffer;
      state_revision: string;
    }>(
      `select worldgraph_projection_checksum($1) as projection_checksum,state_revision::text
         from world_runtime_heads where world_id=$1`,
      [checkedWorldId],
    );
    const live = createWorldProjectionV1({
      activeWorldVersionId: genesis.payload.activeWorldVersionId,
      compiledWorld,
      stateRevision: runtime.rows[0]!.state_revision,
      worldId: checkedWorldId,
      worldVersionNumber: genesis.payload.worldVersionNumber,
    });
    return {
      comparison: compareWorldProjectionV1(live, replayed.projection),
      eventTypes: events.map((event) => event.eventType),
      lastEventSequence: replayed.lastEventSequence,
      liveChecksum: runtime.rows[0]!.projection_checksum.toString('hex'),
      replayedChecksum: replayed.checksum,
    };
  }

  async function register(email: string, displayName: string): Promise<BrowserSession> {
    const response = await app.inject({
      headers: { origin },
      method: 'POST',
      payload: { displayName, email, password },
      url: '/api/v1/auth/register',
    });
    expect(response.statusCode, response.body).toBe(201);
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

  async function createApprovedWorld(
    session: BrowserSession,
    name: string,
    prompt: string,
    fallbackSeed: string,
  ): Promise<ApprovedWorld> {
    const response = await app.inject({
      headers: mutationHeaders(session, `create-${fallbackSeed}`),
      method: 'POST',
      payload: { name },
      url: '/api/v1/worlds',
    });
    expect(response.statusCode, response.body).toBe(201);
    const worldId = response.json<{ world: { id: string } }>().world.id;
    const revisionId = ids.next();
    const validationReportId = ids.next();
    const fallback = createDeterministicFallback({
      catalog: starterManifestCatalog(),
      prompt,
      providerConfigurationId: 'disabled-v1',
      seed: fallbackSeed,
    });
    await client.pool.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,manifest_schema_version,canonical_manifest,
         content_hash,source,created_by_user_id
       ) values ($1,$2,1,1,$3,decode($4,'hex'),'manual',$5)`,
      [
        revisionId,
        worldId,
        JSON.stringify(fallback.envelope.manifest),
        fallback.contentHash,
        session.userId,
      ],
    );
    await client.pool.query(
      `insert into manifest_validation_reports(
         id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
         valid,diagnostics,report_hash
       ) values ($1,$2,1,decode($3,'hex'),true,'[]'::jsonb,decode($4,'hex'))`,
      [validationReportId, revisionId, 'a'.repeat(64), 'b'.repeat(64)],
    );
    const approval = await client.pool.connect();
    try {
      await approval.query('begin');
      await approval.query(
        `update manifest_revisions
            set approval_status = 'approved', approved_by_user_id = $2,
                approved_at = now(), row_version = row_version + 1
          where id = $1`,
        [revisionId, session.userId],
      );
      await approval.query(
        `update worlds
            set current_approved_manifest_revision_id = $2, manifest_schema_version = 1,
                lifecycle = 'manifest_approved', row_version = row_version + 1,
                updated_at = now()
          where id = $1`,
        [worldId, revisionId],
      );
      await approval.query('commit');
    } catch (error) {
      await approval.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      approval.release();
    }
    return { contentHash: fallback.contentHash, revisionId, worldId };
  }
});

async function runWorkerOnce(pool: Pool) {
  const repositoryPath = new URL(
    ['..', '..', 'worker', 'src', 'world-compilation-repository.ts'].join('/'),
    import.meta.url,
  ).href;
  const runnerPath = new URL(
    ['..', '..', 'worker', 'src', 'world-compilation-worker.ts'].join('/'),
    import.meta.url,
  ).href;
  const repositoryModule = (await import(repositoryPath)) as unknown as WorkerRepositoryModule;
  const runnerModule = (await import(runnerPath)) as unknown as WorkerRunnerModule;
  const runner = new runnerModule.WorldCompilationRunner(
    new repositoryModule.PostgresWorldCompilationRepository(pool),
    createLogger({
      buildRevision: 'test',
      environment: 'test',
      level: 'fatal',
      service: 'compiler-runtime-api-worker-test',
    }),
    { maxEntities: 2_000, maxRelationships: 8_000 },
    { maximumRunsPerReconciliation: 1 },
  );
  return runner.runOne();
}

function tamper(cursor: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = cursor.at(-1)!;
  const index = alphabet.indexOf(last);
  return `${cursor.slice(0, -1)}${alphabet[index ^ 1]}`;
}

function mutationHeaders(session: BrowserSession, key: string) {
  return {
    cookie: session.cookie,
    'idempotency-key': key,
    origin,
    'x-csrf-token': session.csrf,
  };
}

function withoutRequestId(value: unknown): unknown {
  const copy = structuredClone(value) as { error?: { requestId?: unknown } };
  if (copy.error) delete copy.error.requestId;
  return copy;
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
