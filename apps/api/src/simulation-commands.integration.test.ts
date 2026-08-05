import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { RuntimeConfig } from '@worldgraph/config';
import {
  SystemClock,
  SIMULATION_PROCESS_REGISTRY_VERSION,
  UuidV7Generator,
  type ApplicationNotification,
  type DomainEventEnvelopeV1,
} from '@worldgraph/contracts';
import {
  applyMigrations,
  createDatabaseClient,
  importStarterPrimitives,
  type DatabaseClient,
} from '@worldgraph/db';
import { createDeterministicFallback, starterManifestCatalog } from '@worldgraph/manifests';
import { replaySimulationProjectionV1 } from '@worldgraph/ledger';
import { createLogger } from '@worldgraph/observability';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { CompilationRepository } from './compilation/repository.js';
import { CompilationService } from './compilation/service.js';
import type {
  SimulationClockViewTransport,
  SubmitWorldCommand,
  WorldCommandResultTransport,
} from './commands/api-contracts.js';
import { WorldCommandBus } from './commands/command-bus.js';
import { PostgresCommandRepository } from './commands/repository.js';
import { WorldCommandService } from './commands/service.js';
import { IdentityService } from './identity/service.js';
import { Argon2idPasswordHasher, TEST_PASSWORD_HASH_OPTIONS } from './identity/security.js';
import { PostgresRepository } from './repositories/postgres-repository.js';
import { WorldService } from './worlds/service.js';

const origin = 'http://localhost:3000';
const password = 'Correct horse battery staple';
const cursorSecret = 'simulation-command-cursor-secret-at-least-32-characters';

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

interface ScheduledIdentity {
  scheduleId: string;
  scheduleSequence: string;
}

type AcceptedCommandResult = Extract<WorldCommandResultTransport, { status: 'accepted' }>;

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

interface SimulationFailureFixturePort {
  advance(request: {
    command: SubmitWorldCommand;
    leaseFencingToken: string;
    leaseOwner: string;
    worldId: string;
  }): Promise<
    | { resultingTick: string; status: 'advanced' }
    | { status: 'clock_not_running' | 'conflict' | 'fenced' | 'not_due' }
  >;
  recordFailureAndAutoPause(request: {
    attempts: number;
    failedCommand: SubmitWorldCommand;
    failure:
      | {
          errorCode: string;
          processType: 'EmitWorldNoticeV1';
          processVersion: '1.0.0';
          scheduleId: string | null;
          tick: string;
        }
      | {
          errorCode: 'SIMULATION_INTEGER_OVERFLOW';
          processType: 'WorldClockV1';
          processVersion: '1.0.0';
          scheduleId: null;
          tick: string;
        };
    leaseFencingToken: string;
    leaseOwner: string;
    worldId: string;
  }): Promise<
    | { failureId: string; status: 'auto_paused' }
    | { status: 'clock_not_running' | 'conflict' | 'fenced' }
  >;
}

interface SimulationCommandModule {
  PostgresSimulationAdvanceCommand: new (
    pool: Pool,
    options: { ids: { next(): string }; retryDelay: () => Promise<void> },
  ) => SimulationFailureFixturePort;
}

interface SimulationRepositoryModule {
  PostgresSimulationLeaseRepository: new (pool: Pool) => object;
}

interface SimulationWorkerModule {
  SimulationCoordinator: new (
    runner: object,
    logger: ReturnType<typeof createLogger>,
    options: {
      isAutomationAvailable: () => boolean;
      reconciliationIntervalMs: number;
    },
  ) => {
    stop(): Promise<void>;
    wake(): Promise<Array<{ attempts: number; outcome: string; worldId: string | null }>>;
  };
  SimulationRunner: new (
    repository: object,
    commands: SimulationFailureFixturePort,
    workerId: string,
    logger: ReturnType<typeof createLogger>,
    options: {
      ids: { next(): string };
      leaseMs: number;
      maximumAttempts: number;
      maximumWorldsPerRun: number;
      wait: (milliseconds: number) => Promise<void>;
    },
  ) => {
    reconcile(): Promise<Array<{ attempts: number; outcome: string; worldId: string | null }>>;
  };
}

describe.sequential('M07 manual simulation commands with real PostgreSQL', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let appClient: DatabaseClient;
  let client: DatabaseClient;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let creator: BrowserSession;
  let member: BrowserSession;
  let outsider: BrowserSession;
  let redis: Redis;
  let redisContainer: Awaited<ReturnType<RedisContainer['start']>>;
  let worldA: ApprovedWorld;
  let worldB: ApprovedWorld;
  let convergenceWorldA: ApprovedWorld;
  let convergenceWorldB: ApprovedWorld;
  const ids = new UuidV7Generator();
  const notifications: ApplicationNotification[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    redisContainer = await new RedisContainer('redis:8.4.5-alpine3.22').start();
    redis = new Redis(redisContainer.getConnectionUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    await redis.connect();
    client = createDatabaseClient(container.getConnectionUri(), 'm07-api-command-test');
    await applyMigrations(client, resolve('packages/db/drizzle'));
    await importStarterPrimitives(client.pool);
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    appClient = createDatabaseClient(appUrl.toString(), 'm07-api-command-app-role-test');

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
    const commands = new WorldCommandService(
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
        service: 'm07-api-command-test',
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

    creator = await register('m07-command-creator@example.test', 'M07 Command Creator');
    member = await register('m07-command-member@example.test', 'M07 Command Member');
    outsider = await register('m07-command-outsider@example.test', 'M07 Command Outsider');
    worldA = await createApprovedWorld(
      creator,
      'M07 Simulation Alpha',
      'A clockwork city schedules guild notices while the world clock is paused.',
      'm07-command-world-alpha',
    );
    await client.pool.query(
      `insert into world_memberships(world_id,user_id,role,status,granted_by_user_id)
       values ($1,$2,'player','active',$3)`,
      [worldA.worldId, member.userId, creator.userId],
    );
    await compileAndActivate(worldA, 'm07-command-compile-alpha');

    worldB = await createApprovedWorld(
      creator,
      'M07 Simulation Beta',
      'A separate clockwork harbor provides a cross-world authorization boundary.',
      'm07-command-world-beta',
    );
    await compileAndActivate(worldB, 'm07-command-compile-beta');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect(false);
    await appClient?.pool.end();
    await client?.pool.end();
    await redisContainer?.stop();
    await container?.stop();
  });

  it('commits deterministic manual advances once and fences conflicts, identities, and private reads', async () => {
    const initialized = await readClock(creator, worldA.worldId);
    expect(initialized).toMatchObject({
      aggregateVersion: '1',
      clock: { currentTick: '0', mode: 'paused' },
      designVersion: '1',
      stateRevision: '2',
    });
    expect(initialized.clock.outcomeHash).toMatch(/^[a-f0-9]{64}$/u);

    const tickThreeNotice = command(initialized, 'ScheduleWorldNoticeV1', {
      dueTick: '3',
      priority: 0,
      text: 'Guild Founding Day begins now.',
      visibility: 'member',
    });
    const scheduledAtThree = await submit(creator, worldA.worldId, tickThreeNotice);
    expect(scheduledAtThree.statusCode, scheduledAtThree.body).toBe(200);
    const scheduledAtThreeResult = scheduledAtThree.json<AcceptedCommandResult>();
    expect(scheduledAtThreeResult).toMatchObject({
      eventIds: [expect.stringMatching(/^[a-f0-9-]{36}$/u)],
      resultingStateRevision: '3',
      status: 'accepted',
    });
    const tickThreeIdentity = await scheduledIdentity(tickThreeNotice.commandId);
    expect(tickThreeIdentity.scheduleSequence).toBe('1');
    await expectSchedule(tickThreeIdentity.scheduleId, 'scheduled', null);

    for (const targetTick of ['1', '2']) {
      const before = await readClock(creator, worldA.worldId);
      expect(before.clock.mode).toBe('paused');
      const response = await submit(
        creator,
        worldA.worldId,
        command(before, 'AdvanceSimulationV1', { ticks: 1 }),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<AcceptedCommandResult>().eventIds).toHaveLength(1);
      const after = await readClock(creator, worldA.worldId);
      expect(after.clock).toMatchObject({ currentTick: targetTick, mode: 'paused' });
      expect(after.clock.outcomeHash).not.toBe(before.clock.outcomeHash);
      await expectSchedule(tickThreeIdentity.scheduleId, 'scheduled', null);
    }

    const beforeTickThree = await readClock(creator, worldA.worldId);
    const advanceTickThree = command(beforeTickThree, 'AdvanceSimulationV1', { ticks: 1 });
    const tickThreeResponse = await submit(creator, worldA.worldId, advanceTickThree);
    expect(tickThreeResponse.statusCode, tickThreeResponse.body).toBe(200);
    const tickThreeResult = tickThreeResponse.json<AcceptedCommandResult>();
    expect(tickThreeResult).toMatchObject({
      eventIds: [
        expect.stringMatching(/^[a-f0-9-]{36}$/u),
        expect.stringMatching(/^[a-f0-9-]{36}$/u),
        expect.stringMatching(/^[a-f0-9-]{36}$/u),
      ],
      resultingStateRevision: (BigInt(beforeTickThree.stateRevision) + 1n).toString(10),
      status: 'accepted',
    });

    const tickThreeEvents = await client.pool.query<{
      aggregate_id: string;
      aggregate_type: string;
      event_ordinal: number;
      event_type: string;
      payload: Record<string, unknown>;
      resulting_state_revision: string;
      world_event_sequence: string;
    }>(
      `select aggregate_id,aggregate_type,event_ordinal,event_type,payload,
              resulting_state_revision::text,world_event_sequence::text
         from domain_events where command_id=$1 order by event_ordinal`,
      [advanceTickThree.commandId],
    );
    expect(tickThreeEvents.rows.map((event) => event.event_type)).toEqual([
      'SimulationAdvancedV1',
      'ScheduledActionExecutedV1',
      'WorldNoticeEmittedV1',
    ]);
    expect(tickThreeEvents.rows.map((event) => event.event_ordinal)).toEqual([0, 1, 2]);
    expect(new Set(tickThreeEvents.rows.map((event) => event.resulting_state_revision))).toEqual(
      new Set([tickThreeResult.resultingStateRevision]),
    );
    expect(tickThreeEvents.rows[0]).toMatchObject({
      aggregate_id: worldA.worldId,
      aggregate_type: 'simulation_clock',
      payload: { executedScheduleCount: 1, fromTick: '2', tickCount: 1, toTick: '3' },
    });
    expect(tickThreeEvents.rows[1]).toMatchObject({
      aggregate_id: tickThreeIdentity.scheduleId,
      aggregate_type: 'scheduled_action',
      payload: {
        dueTick: '3',
        scheduleId: tickThreeIdentity.scheduleId,
        scheduleSequence: tickThreeIdentity.scheduleSequence,
      },
    });
    expect(tickThreeEvents.rows[2]).toMatchObject({
      aggregate_id: tickThreeIdentity.scheduleId,
      aggregate_type: 'world_notice',
      payload: {
        emittedAtTick: '3',
        scheduleId: tickThreeIdentity.scheduleId,
        text: 'Guild Founding Day begins now.',
        visibility: 'member',
      },
    });
    await expectSchedule(
      tickThreeIdentity.scheduleId,
      'completed',
      tickThreeResult.resultingStateRevision,
    );

    const batch = await client.pool.query<{
      command_id: string;
      from_tick: string;
      outcome_hash: Buffer;
      status: string;
      to_tick: string;
    }>(
      `select command_id,from_tick::text,to_tick::text,status::text,outcome_hash
         from simulation_batch_runs where command_id=$1`,
      [advanceTickThree.commandId],
    );
    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0]).toMatchObject({
      command_id: advanceTickThree.commandId,
      from_tick: '2',
      status: 'completed',
      to_tick: '3',
    });
    expect(batch.rows[0]?.outcome_hash).toHaveLength(32);
    expect((await readClock(creator, worldA.worldId)).clock.outcomeHash).toBe(
      batch.rows[0]?.outcome_hash.toString('hex'),
    );

    const integrity = await client.pool.query<{
      checksum: string;
      expected_checksum: string;
      last_event_sequence: string;
      projection_name: string;
    }>(
      `select checkpoint.projection_name,
              checkpoint.last_event_sequence::text,
              encode(checkpoint.checksum,'hex') as checksum,
              encode(case checkpoint.projection_name
                when 'world_graph' then worldgraph_projection_checksum($1,$2::bigint)
                else worldgraph_simulation_projection_checksum($1)
              end,'hex') as expected_checksum
         from projection_checkpoints checkpoint
        where checkpoint.world_id=$1
          and checkpoint.projection_name in ('world_graph','simulation_runtime')
        order by checkpoint.projection_name`,
      [worldA.worldId, tickThreeResult.resultingStateRevision],
    );
    expect(integrity.rows).toHaveLength(2);
    for (const checkpoint of integrity.rows) {
      expect(checkpoint.last_event_sequence).toBe(tickThreeResult.eventSequenceRange?.to);
      expect(checkpoint.checksum).toBe(checkpoint.expected_checksum);
    }

    const ledger = await client.pool.query<{
      entry_kind: string;
      event_id: string | null;
      ledger_sequence: string;
    }>(
      `select entry.entry_kind::text,entry.event_id,entry.ledger_sequence::text
         from ledger_entries entry where entry.command_id=$1 order by entry.ledger_sequence`,
      [advanceTickThree.commandId],
    );
    expect(ledger.rows.map((entry) => entry.entry_kind)).toEqual([
      'command_accepted',
      'domain_event',
      'domain_event',
      'domain_event',
    ]);
    expect(ledger.rows.slice(1).map((entry) => entry.event_id)).toEqual(tickThreeResult.eventIds);
    expect(ledger.rows[0]?.ledger_sequence).toBe(tickThreeResult.ledgerSequenceRange?.from);
    expect(ledger.rows.at(-1)?.ledger_sequence).toBe(tickThreeResult.ledgerSequenceRange?.to);

    const outbox = await client.pool.query<{ event_id: string; status: string }>(
      `select event_id,status::text from outbox_messages
        where world_id=$1 and event_id=any($2::uuid[]) order by event_id`,
      [worldA.worldId, tickThreeResult.eventIds],
    );
    expect(outbox.rows).toHaveLength(3);
    expect(outbox.rows.every((message) => message.status === 'pending')).toBe(true);
    expect(outbox.rows.map((message) => message.event_id).sort()).toEqual(
      [...tickThreeResult.eventIds].sort(),
    );

    const beforeReplay = await commandFootprint(advanceTickThree.commandId);
    const exactReplay = await submit(creator, worldA.worldId, advanceTickThree);
    expect(exactReplay.statusCode, exactReplay.body).toBe(200);
    expect(exactReplay.json()).toEqual(tickThreeResult);
    await expect(commandFootprint(advanceTickThree.commandId)).resolves.toEqual(beforeReplay);

    const beforeTickFour = await readClock(creator, worldA.worldId);
    const tickFour = await submit(
      creator,
      worldA.worldId,
      command(beforeTickFour, 'AdvanceSimulationV1', { ticks: 1 }),
    );
    expect(tickFour.statusCode, tickFour.body).toBe(200);
    expect(tickFour.json<AcceptedCommandResult>().eventIds).toHaveLength(1);
    expect((await readClock(creator, worldA.worldId)).clock.currentTick).toBe('4');
    await expect(executionCount(tickThreeIdentity.scheduleId)).resolves.toEqual({
      executed: '1',
      notices: '1',
    });

    const highPriority = await createNoticeAtCurrentTick('5', 10, 'Created first, runs last.');
    const lowPriorityFirst = await createNoticeAtCurrentTick('5', -10, 'Low priority first.');
    const lowPrioritySecond = await createNoticeAtCurrentTick('5', -10, 'Low priority second.');
    expect(BigInt(highPriority.scheduleSequence)).toBeLessThan(
      BigInt(lowPriorityFirst.scheduleSequence),
    );
    expect(BigInt(lowPriorityFirst.scheduleSequence)).toBeLessThan(
      BigInt(lowPrioritySecond.scheduleSequence),
    );

    const beforeOrderedAdvance = await readClock(creator, worldA.worldId);
    const orderedAdvance = command(beforeOrderedAdvance, 'AdvanceSimulationV1', { ticks: 1 });
    const orderedResponse = await submit(creator, worldA.worldId, orderedAdvance);
    expect(orderedResponse.statusCode, orderedResponse.body).toBe(200);
    const orderedResult = orderedResponse.json<AcceptedCommandResult>();
    expect(orderedResult.eventIds).toHaveLength(7);
    const orderedEvents = await client.pool.query<{
      event_ordinal: number;
      event_type: string;
      payload: { scheduleId?: string; scheduleSequence?: string };
      resulting_state_revision: string;
    }>(
      `select event_ordinal,event_type,payload,resulting_state_revision::text
         from domain_events where command_id=$1 order by event_ordinal`,
      [orderedAdvance.commandId],
    );
    expect(orderedEvents.rows.map((event) => event.event_type)).toEqual([
      'SimulationAdvancedV1',
      'ScheduledActionExecutedV1',
      'WorldNoticeEmittedV1',
      'ScheduledActionExecutedV1',
      'WorldNoticeEmittedV1',
      'ScheduledActionExecutedV1',
      'WorldNoticeEmittedV1',
    ]);
    expect(
      orderedEvents.rows
        .filter((event) => event.event_type === 'ScheduledActionExecutedV1')
        .map((event) => event.payload.scheduleId),
    ).toEqual([lowPriorityFirst.scheduleId, lowPrioritySecond.scheduleId, highPriority.scheduleId]);
    expect(new Set(orderedEvents.rows.map((event) => event.resulting_state_revision))).toEqual(
      new Set([orderedResult.resultingStateRevision]),
    );

    const conflictClock = await readClock(creator, worldA.worldId);
    const beforeConflicts = await authoritativeFootprint(worldA.worldId);
    const staleTick = await submit(
      creator,
      worldA.worldId,
      command(
        conflictClock,
        'AdvanceSimulationV1',
        { ticks: 1 },
        {
          expectedTick: (BigInt(conflictClock.clock.currentTick) - 1n).toString(10),
        },
      ),
    );
    expect(staleTick.statusCode, staleTick.body).toBe(409);
    expect(staleTick.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'EXPECTED_TICK_MISMATCH',
      status: 'rejected',
    });
    const staleState = await submit(
      creator,
      worldA.worldId,
      command(
        conflictClock,
        'AdvanceSimulationV1',
        { ticks: 1 },
        {
          expectedStateRevision: (BigInt(conflictClock.stateRevision) - 1n).toString(10),
        },
      ),
    );
    expect(staleState.statusCode, staleState.body).toBe(409);
    expect(staleState.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'REVISION_CONFLICT',
      status: 'rejected',
    });
    const staleAggregate = await submit(
      creator,
      worldA.worldId,
      command(
        conflictClock,
        'AdvanceSimulationV1',
        { ticks: 1 },
        {
          expectedAggregateVersion: (BigInt(conflictClock.aggregateVersion) - 1n).toString(10),
        },
      ),
    );
    expect(staleAggregate.statusCode, staleAggregate.body).toBe(409);
    expect(staleAggregate.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'AGGREGATE_VERSION_CONFLICT',
      status: 'rejected',
    });
    await expect(authoritativeFootprint(worldA.worldId)).resolves.toEqual(beforeConflicts);

    const memberClock = await readClock(member, worldA.worldId);
    const memberAdvance = await submit(
      member,
      worldA.worldId,
      command(memberClock, 'AdvanceSimulationV1', { ticks: 1 }),
    );
    expect(memberAdvance.statusCode, memberAdvance.body).toBe(403);
    expect(memberAdvance.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'AUTHORIZATION_DENIED',
      status: 'rejected',
    });
    expect((await readClock(creator, worldA.worldId)).clock.currentTick).toBe('5');

    const forgedClock = await readClock(creator, worldA.worldId);
    const forgedSystem = await submit(
      creator,
      worldA.worldId,
      command(forgedClock, 'AutoPauseWorldClockV1', {}),
    );
    expect(forgedSystem.statusCode, forgedSystem.body).toBe(422);
    expect(forgedSystem.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'COMMAND_TYPE_DISABLED',
      status: 'rejected',
    });

    const privateNotice = await createNoticeAtCurrentTick(
      '6',
      0,
      'Creator-only operational notice.',
      'creator',
    );
    const creatorDetail = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/simulation/schedule/${privateNotice.scheduleId}`,
    });
    expect(creatorDetail.statusCode, creatorDetail.body).toBe(200);
    expect(creatorDetail.json()).toMatchObject({
      id: privateNotice.scheduleId,
      payload: { text: 'Creator-only operational notice.', visibility: 'creator' },
    });
    const memberDetail = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/simulation/schedule/${privateNotice.scheduleId}`,
    });
    expect(memberDetail.statusCode, memberDetail.body).toBe(404);
    const memberSchedule = await app.inject({
      headers: { cookie: member.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/simulation/schedule?status=scheduled`,
    });
    expect(memberSchedule.statusCode, memberSchedule.body).toBe(200);
    expect(memberSchedule.json<{ items: Array<{ id: string }> }>().items).not.toContainEqual(
      expect.objectContaining({ id: privateNotice.scheduleId }),
    );
    const outsiderClock = await app.inject({
      headers: { cookie: outsider.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldA.worldId}/simulation/clock`,
    });
    expect(outsiderClock.statusCode, outsiderClock.body).toBe(404);

    const worldBClock = await readClock(creator, worldB.worldId);
    const crossWorldCommand = command(worldBClock, 'CancelScheduledActionV1', {
      scheduleId: privateNotice.scheduleId,
    });
    const crossWorld = await submit(creator, worldB.worldId, crossWorldCommand);
    expect(crossWorld.statusCode, crossWorld.body).toBe(404);
    expect(crossWorld.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const crossWorldRecord = await client.pool.query('select 1 from command_records where id=$1', [
      crossWorldCommand.commandId,
    ]);
    expect(crossWorldRecord.rows).toHaveLength(0);
    await expectSchedule(privateNotice.scheduleId, 'scheduled', null);
    const crossWorldRead = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldB.worldId}/simulation/schedule/${privateNotice.scheduleId}`,
    });
    expect(crossWorldRead.statusCode, crossWorldRead.body).toBe(404);
  }, 180_000);

  it('audits creator recovery of a fenced auto-pause failure without replaying side effects', async () => {
    const paused = await readClock(creator, worldA.worldId);
    expect(paused.clock).toMatchObject({ currentTick: '5', mode: 'paused' });
    const failureTick = (BigInt(paused.clock.currentTick) + 1n).toString(10);
    const failedSchedule = await createNoticeAtCurrentTick(
      failureTick,
      -20,
      'This notice is cancelled by audited recovery.',
      'member',
    );

    const beforeStart = await readClock(creator, worldA.worldId);
    const startCommand = command(beforeStart, 'StartWorldClockV1', {});
    const started = await submit(creator, worldA.worldId, startCommand);
    expect(started.statusCode, started.body).toBe(200);
    const running = await readClock(creator, worldA.worldId);
    expect(running.clock).toMatchObject({ currentTick: '5', mode: 'running' });

    const leaseOwner = 'm07-api-recovery-worker';
    const lease = await client.pool.query<{ fencing_token: string }>(
      `select fencing_token::text
         from worldgraph_acquire_simulation_lease($1,$2,60000)`,
      [worldA.worldId, leaseOwner],
    );
    const leaseFencingToken = lease.rows[0]?.fencing_token;
    expect(leaseFencingToken).toMatch(/^[1-9][0-9]*$/u);
    if (!leaseFencingToken) throw new Error('The simulation recovery lease was not acquired.');

    const fixtureModule = (await import(
      new URL(
        ['..', '..', '..', 'packages', 'simulation-command', 'src', 'postgres.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationCommandModule;
    const fixturePort = new fixtureModule.PostgresSimulationAdvanceCommand(client.pool, {
      ids,
      retryDelay: async () => undefined,
    });
    const failedCommand = command(running, 'AdvanceSimulationV1', { ticks: 1 });
    const autoPaused = await fixturePort.recordFailureAndAutoPause({
      attempts: 3,
      failedCommand,
      failure: {
        errorCode: 'SIMULATION_HANDLER_FAILED',
        processType: 'EmitWorldNoticeV1',
        processVersion: '1.0.0',
        scheduleId: failedSchedule.scheduleId,
        tick: failureTick,
      },
      leaseFencingToken,
      leaseOwner,
      worldId: worldA.worldId,
    });
    expect(autoPaused.status).toBe('auto_paused');
    if (autoPaused.status !== 'auto_paused') throw new Error('The fixture did not auto-pause.');

    const errorClock = await readClock(creator, worldA.worldId);
    expect(errorClock.clock).toMatchObject({ currentTick: '5', mode: 'error' });
    expect(errorClock.clock.outcomeHash).toBe(running.clock.outcomeHash);
    expect(errorClock.stateRevision).toBe((BigInt(running.stateRevision) + 1n).toString(10));
    const openFailure = await client.pool.query<{
      aggregate_version: string;
      attempts: number;
      batch_status: string;
      error_code: string;
      resolution_command_id: string | null;
      resolved_by_actor_id: string | null;
      schedule_id: string | null;
      schedule_status: string;
      status: string;
      tick: string;
    }>(
      `select stream.current_version::text aggregate_version,
              failure.attempts,failure.error_code,failure.tick::text,
              failure.schedule_id,failure.status::text,
              failure.resolved_by_actor_id,failure.resolution_command_id,
              batch.status::text batch_status,action.status::text schedule_status
         from simulation_failures failure
         join aggregate_stream_heads stream on stream.world_id=failure.world_id
          and stream.aggregate_type='simulation_failure'
          and stream.aggregate_id=failure.id::text
         join simulation_batch_runs batch on batch.id=failure.batch_run_id
          and batch.world_id=failure.world_id
         join scheduled_actions action on action.id=failure.schedule_id
          and action.world_id=failure.world_id
        where failure.world_id=$1 and failure.id=$2`,
      [worldA.worldId, autoPaused.failureId],
    );
    expect(openFailure.rows).toHaveLength(1);
    expect(openFailure.rows[0]).toMatchObject({
      aggregate_version: '1',
      attempts: 3,
      batch_status: 'failed',
      error_code: 'SIMULATION_HANDLER_FAILED',
      resolution_command_id: null,
      resolved_by_actor_id: null,
      schedule_id: failedSchedule.scheduleId,
      schedule_status: 'scheduled',
      status: 'open',
      tick: failureTick,
    });

    const beforeDenials = await recoveryFootprint(autoPaused.failureId, failedSchedule.scheduleId);
    const memberClock = await readClock(member, worldA.worldId);
    const memberResolution = command(
      memberClock,
      'ResolveSimulationFailureV1',
      { failureId: autoPaused.failureId, resolution: 'cancel_action' },
      { expectedAggregateVersion: openFailure.rows[0]!.aggregate_version },
    );
    const denied = await submit(member, worldA.worldId, memberResolution);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'AUTHORIZATION_DENIED',
      status: 'rejected',
    });
    await expect(
      recoveryFootprint(autoPaused.failureId, failedSchedule.scheduleId),
    ).resolves.toEqual(beforeDenials);

    const staleResolution = command(
      errorClock,
      'ResolveSimulationFailureV1',
      { failureId: autoPaused.failureId, resolution: 'cancel_action' },
      { expectedAggregateVersion: '0' },
    );
    const stale = await submit(creator, worldA.worldId, staleResolution);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'AGGREGATE_VERSION_CONFLICT',
      status: 'rejected',
    });
    await expect(
      recoveryFootprint(autoPaused.failureId, failedSchedule.scheduleId),
    ).resolves.toEqual(beforeDenials);

    const recoveryCommand = command(
      errorClock,
      'ResolveSimulationFailureV1',
      { failureId: autoPaused.failureId, resolution: 'cancel_action' },
      { expectedAggregateVersion: openFailure.rows[0]!.aggregate_version },
    );
    const recovered = await submit(creator, worldA.worldId, recoveryCommand);
    expect(recovered.statusCode, recovered.body).toBe(200);
    const recoveryResult = recovered.json<AcceptedCommandResult>();
    expect(recoveryResult).toMatchObject({
      eventIds: [
        expect.stringMatching(/^[a-f0-9-]{36}$/u),
        expect.stringMatching(/^[a-f0-9-]{36}$/u),
      ],
      resultingStateRevision: (BigInt(errorClock.stateRevision) + 1n).toString(10),
      status: 'accepted',
    });

    const recoveryEvents = await client.pool.query<{
      aggregate_id: string;
      aggregate_type: string;
      aggregate_version: string;
      event_ordinal: number;
      event_type: string;
      payload: Record<string, unknown>;
      resulting_state_revision: string;
    }>(
      `select aggregate_id,aggregate_type,aggregate_version::text,event_ordinal,
              event_type,payload,resulting_state_revision::text
         from domain_events where command_id=$1 order by event_ordinal`,
      [recoveryCommand.commandId],
    );
    expect(recoveryEvents.rows.map((event) => event.event_type)).toEqual([
      'SimulationFailureResolvedV1',
      'ScheduledActionCancelledV1',
    ]);
    expect(recoveryEvents.rows[0]).toMatchObject({
      aggregate_id: autoPaused.failureId,
      aggregate_type: 'simulation_failure',
      aggregate_version: '2',
      event_ordinal: 0,
      payload: {
        failureId: autoPaused.failureId,
        resolution: 'cancel_action',
        scheduleId: failedSchedule.scheduleId,
        tick: failureTick,
      },
    });
    expect(recoveryEvents.rows[1]).toMatchObject({
      aggregate_id: failedSchedule.scheduleId,
      aggregate_type: 'scheduled_action',
      aggregate_version: '2',
      event_ordinal: 1,
      payload: { scheduleId: failedSchedule.scheduleId },
    });
    expect(new Set(recoveryEvents.rows.map((event) => event.resulting_state_revision))).toEqual(
      new Set([recoveryResult.resultingStateRevision]),
    );

    const audit = await client.pool.query<{
      actor_id: string;
      actor_type: string;
      authorization_rule_id: string;
      cancelled_command_id: string | null;
      clock_mode: string;
      clock_outcome_hash: string;
      command_status: string;
      completed_state_revision: string | null;
      failure_status: string;
      graph_checksum_matches: boolean;
      graph_sequence: string;
      ledger_count: string;
      outbox_count: string;
      resolved_at: Date | null;
      resolved_by_actor_id: string | null;
      resolution_command_id: string | null;
      runtime_state_revision: string;
      schedule_status: string;
      simulation_checksum_matches: boolean;
      simulation_sequence: string;
    }>(
      `select command.actor_id,command.actor_type::text,
              command.authorization_rule_id,command.status::text command_status,
              failure.status::text failure_status,failure.resolved_by_actor_id,
              failure.resolved_at,failure.resolution_command_id,
              action.status::text schedule_status,action.cancelled_command_id,
              action.completed_state_revision::text,
              clock.mode::text clock_mode,encode(clock.outcome_hash,'hex') clock_outcome_hash,
              runtime.state_revision::text runtime_state_revision,
              graph.last_event_sequence::text graph_sequence,
              simulation.last_event_sequence::text simulation_sequence,
              graph.checksum=worldgraph_projection_checksum($1,runtime.state_revision)
                graph_checksum_matches,
              simulation.checksum=worldgraph_simulation_projection_checksum($1)
                simulation_checksum_matches,
              (select count(*)::text from ledger_entries where command_id=$2) ledger_count,
              (select count(*)::text from outbox_messages message
                join domain_events event on event.id=message.event_id
               where event.command_id=$2) outbox_count
         from command_records command
         join simulation_failures failure on failure.world_id=command.world_id
          and failure.id=$3
         join scheduled_actions action on action.world_id=failure.world_id
          and action.id=failure.schedule_id
         join world_simulation_clocks clock on clock.world_id=command.world_id
         join world_runtime_heads runtime on runtime.world_id=command.world_id
         join projection_checkpoints graph on graph.world_id=command.world_id
          and graph.projection_name='world_graph'
         join projection_checkpoints simulation on simulation.world_id=command.world_id
          and simulation.projection_name='simulation_runtime'
        where command.id=$2 and command.world_id=$1`,
      [worldA.worldId, recoveryCommand.commandId, autoPaused.failureId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: creator.userId,
      actor_type: 'user',
      authorization_rule_id: 'simulation.creator_manage',
      cancelled_command_id: recoveryCommand.commandId,
      clock_mode: 'paused',
      clock_outcome_hash: errorClock.clock.outcomeHash,
      command_status: 'accepted',
      completed_state_revision: recoveryResult.resultingStateRevision,
      failure_status: 'resolved',
      graph_checksum_matches: true,
      graph_sequence: recoveryResult.eventSequenceRange.to,
      ledger_count: '3',
      outbox_count: '2',
      resolved_by_actor_id: creator.userId,
      resolution_command_id: recoveryCommand.commandId,
      runtime_state_revision: recoveryResult.resultingStateRevision,
      schedule_status: 'cancelled',
      simulation_checksum_matches: true,
      simulation_sequence: recoveryResult.eventSequenceRange.to,
    });
    expect(audit.rows[0]?.resolved_at).toBeInstanceOf(Date);

    const recoveryLedger = await client.pool.query<{
      entry_kind: string;
      event_id: string | null;
      ledger_sequence: string;
    }>(
      `select entry.entry_kind::text,entry.event_id,entry.ledger_sequence::text
         from ledger_entries entry
        where entry.command_id=$1 order by entry.ledger_sequence`,
      [recoveryCommand.commandId],
    );
    expect(recoveryLedger.rows.map((entry) => entry.entry_kind)).toEqual([
      'command_accepted',
      'domain_event',
      'domain_event',
    ]);
    expect(recoveryLedger.rows.slice(1).map((entry) => entry.event_id)).toEqual(
      recoveryResult.eventIds,
    );
    await expect(
      client.pool.query('select worldgraph_assert_simulation_command_terminal($1)', [
        recoveryCommand.commandId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });

    const beforeReplay = {
      command: await commandFootprint(recoveryCommand.commandId),
      recovery: await recoveryFootprint(autoPaused.failureId, failedSchedule.scheduleId),
    };
    const replay = await submit(creator, worldA.worldId, recoveryCommand);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(recoveryResult);
    await expect(commandFootprint(recoveryCommand.commandId)).resolves.toEqual(
      beforeReplay.command,
    );
    await expect(
      recoveryFootprint(autoPaused.failureId, failedSchedule.scheduleId),
    ).resolves.toEqual(beforeReplay.recovery);
  }, 180_000);

  it('reuses one audited batch across repeated repair retries for worker and manual advances', async () => {
    creator = await login('m07-command-creator@example.test');
    const existingLease = await client.pool.query<{
      fencing_token: string;
      lease_owner: string;
    }>(
      `select fencing_token::text,lease_owner
         from simulation_worker_leases where world_id=$1`,
      [worldA.worldId],
    );
    if (existingLease.rows[0]) {
      await client.pool.query(`select worldgraph_release_simulation_lease($1,$2,$3::bigint)`, [
        worldA.worldId,
        existingLease.rows[0].lease_owner,
        existingLease.rows[0].fencing_token,
      ]);
    }

    const leaseOwner = 'm07-repair-retry-worker';
    const lease = await client.pool.query<{ fencing_token: string }>(
      `select fencing_token::text
         from worldgraph_acquire_simulation_lease($1,$2,60000)`,
      [worldA.worldId, leaseOwner],
    );
    const leaseFencingToken = lease.rows[0]?.fencing_token;
    if (!leaseFencingToken) throw new Error('The repair-retry lease was not acquired.');

    const fixtureModule = (await import(
      new URL(
        ['..', '..', '..', 'packages', 'simulation-command', 'src', 'postgres.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationCommandModule;
    const fixturePort = new fixtureModule.PostgresSimulationAdvanceCommand(client.pool, {
      ids,
      retryDelay: async () => undefined,
    });

    const batchForFailure = async (failureId: string) => {
      const result = await client.pool.query<{
        attempts: number;
        batch_id: string;
        batch_key: string;
        input_checksum: string;
        started_at: Date;
        status: string;
      }>(
        `select batch.id batch_id,batch.attempts,batch.status::text,
                encode(batch.batch_key,'hex') batch_key,
                encode(batch.input_checksum,'hex') input_checksum,batch.started_at
           from simulation_failures failure
           join simulation_batch_runs batch on batch.world_id=failure.world_id
            and batch.id=failure.batch_run_id
          where failure.world_id=$1 and failure.id=$2`,
        [worldA.worldId, failureId],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Missing failed batch for ${failureId}.`);
      return row;
    };
    const resolveForRepair = async (failureId: string) => {
      const aggregate = await client.pool.query<{ aggregate_version: string }>(
        `select current_version::text aggregate_version
           from aggregate_stream_heads
          where world_id=$1 and aggregate_type='simulation_failure' and aggregate_id=$2`,
        [worldA.worldId, failureId],
      );
      const errorClock = await readClock(creator, worldA.worldId);
      expect(errorClock.clock.mode).toBe('error');
      const resolution = command(
        errorClock,
        'ResolveSimulationFailureV1',
        { failureId, resolution: 'retry_after_repair' },
        { expectedAggregateVersion: aggregate.rows[0]!.aggregate_version },
      );
      const response = await submit(creator, worldA.worldId, resolution);
      expect(response.statusCode, response.body).toBe(200);
      const repaired = await readClock(creator, worldA.worldId);
      expect(repaired.clock.mode).toBe('paused');
      return { repaired, resolution };
    };
    const start = async (paused: SimulationClockViewTransport, waitUntilDue = false) => {
      const response = await submit(
        creator,
        worldA.worldId,
        command(paused, 'StartWorldClockV1', {}),
      );
      expect(response.statusCode, response.body).toBe(200);
      if (waitUntilDue) {
        await new Promise((resolve) =>
          setTimeout(resolve, paused.clock.configuration.wallCadenceMilliseconds + 50),
        );
      }
      const running = await readClock(creator, worldA.worldId);
      expect(running.clock.mode).toBe('running');
      return running;
    };

    try {
      const paused = await readClock(creator, worldA.worldId);
      expect(paused.clock.mode).toBe('paused');
      const dueTick = (BigInt(paused.clock.currentTick) + 1n).toString(10);
      const schedule = await createNoticeAtCurrentTick(
        dueTick,
        -30,
        'A repaired process emits this notice exactly once.',
        'member',
      );
      let running = await start(await readClock(creator, worldA.worldId));
      const firstFailedCommand = command(running, 'AdvanceSimulationV1', { ticks: 1 });
      const firstFailure = await fixturePort.recordFailureAndAutoPause({
        attempts: 3,
        failedCommand: firstFailedCommand,
        failure: {
          errorCode: 'SIMULATION_HANDLER_FAILED',
          processType: 'EmitWorldNoticeV1',
          processVersion: '1.0.0',
          scheduleId: schedule.scheduleId,
          tick: dueTick,
        },
        leaseFencingToken,
        leaseOwner,
        worldId: worldA.worldId,
      });
      expect(firstFailure.status).toBe('auto_paused');
      if (firstFailure.status !== 'auto_paused') throw new Error('First failure was not recorded.');
      const originalBatch = await batchForFailure(firstFailure.failureId);
      expect(originalBatch).toMatchObject({ attempts: 3, status: 'failed' });

      const firstRepair = await resolveForRepair(firstFailure.failureId);
      running = await start(firstRepair.repaired);
      const secondFailedCommand = command(running, 'AdvanceSimulationV1', { ticks: 1 });
      const secondFailure = await fixturePort.recordFailureAndAutoPause({
        attempts: 2,
        failedCommand: secondFailedCommand,
        failure: {
          errorCode: 'SIMULATION_HANDLER_FAILED',
          processType: 'EmitWorldNoticeV1',
          processVersion: '1.0.0',
          scheduleId: schedule.scheduleId,
          tick: dueTick,
        },
        leaseFencingToken,
        leaseOwner,
        worldId: worldA.worldId,
      });
      expect(secondFailure.status).toBe('auto_paused');
      if (secondFailure.status !== 'auto_paused') {
        throw new Error('Repeated failure was not recorded.');
      }
      const repeatedBatch = await batchForFailure(secondFailure.failureId);
      expect(repeatedBatch).toMatchObject({
        attempts: 5,
        batch_id: originalBatch.batch_id,
        batch_key: originalBatch.batch_key,
        input_checksum: originalBatch.input_checksum,
        started_at: originalBatch.started_at,
        status: 'failed',
      });
      await expect(
        client.pool.query(
          `select count(*)::text count from simulation_batch_runs
            where world_id=$1 and from_tick=$2::bigint and to_tick=$3::bigint
              and input_checksum=decode($4,'hex') and process_registry_version=$5`,
          [
            worldA.worldId,
            paused.clock.currentTick,
            dueTick,
            originalBatch.input_checksum,
            SIMULATION_PROCESS_REGISTRY_VERSION,
          ],
        ),
      ).resolves.toMatchObject({ rows: [{ count: '1' }] });

      const secondRepair = await resolveForRepair(secondFailure.failureId);
      running = await start(secondRepair.repaired, true);
      const workerCommands = [
        command(running, 'AdvanceSimulationV1', { ticks: 1 }),
        command(running, 'AdvanceSimulationV1', { ticks: 1 }),
      ];
      const workerResults = await Promise.all(
        workerCommands.map((workerCommand) =>
          fixturePort.advance({
            command: workerCommand,
            leaseFencingToken,
            leaseOwner,
            worldId: worldA.worldId,
          }),
        ),
      );
      expect(workerResults.filter(({ status }) => status === 'advanced')).toHaveLength(1);
      expect(workerResults.filter(({ status }) => status === 'conflict')).toHaveLength(1);
      const completedWorkerBatch = await client.pool.query<{
        attempts: number;
        command_id: string;
        failure_count: string;
        id: string;
        status: string;
      }>(
        `select batch.id,batch.attempts,batch.status::text,batch.command_id,
                count(failure.id)::text failure_count
           from simulation_batch_runs batch
           left join simulation_failures failure on failure.world_id=batch.world_id
            and failure.batch_run_id=batch.id
          where batch.world_id=$1 and batch.id=$2
          group by batch.id`,
        [worldA.worldId, originalBatch.batch_id],
      );
      expect(completedWorkerBatch.rows[0]).toMatchObject({
        attempts: 6,
        failure_count: '2',
        id: originalBatch.batch_id,
        status: 'completed',
      });
      expect(workerCommands.map(({ commandId }) => commandId)).toContain(
        completedWorkerBatch.rows[0]?.command_id,
      );
      await expect(executionCount(schedule.scheduleId)).resolves.toEqual({
        executed: '1',
        notices: '1',
      });

      const afterWorker = await readClock(creator, worldA.worldId);
      const pausedAfterWorker = await submit(
        creator,
        worldA.worldId,
        command(afterWorker, 'PauseWorldClockV1', {}),
      );
      expect(pausedAfterWorker.statusCode, pausedAfterWorker.body).toBe(200);
      const beforeManualFailure = await readClock(creator, worldA.worldId);
      const manualDueTick = (BigInt(beforeManualFailure.clock.currentTick) + 1n).toString(10);
      const manualSchedule = await createNoticeAtCurrentTick(
        manualDueTick,
        -31,
        'The manual adapter reuses its repaired batch identity.',
        'member',
      );
      running = await start(await readClock(creator, worldA.worldId));
      const manualFailedCommand = command(running, 'AdvanceSimulationV1', { ticks: 1 });
      const manualFailure = await fixturePort.recordFailureAndAutoPause({
        attempts: 4,
        failedCommand: manualFailedCommand,
        failure: {
          errorCode: 'SIMULATION_HANDLER_FAILED',
          processType: 'EmitWorldNoticeV1',
          processVersion: '1.0.0',
          scheduleId: manualSchedule.scheduleId,
          tick: manualDueTick,
        },
        leaseFencingToken,
        leaseOwner,
        worldId: worldA.worldId,
      });
      expect(manualFailure.status).toBe('auto_paused');
      if (manualFailure.status !== 'auto_paused') {
        throw new Error('Manual-adapter fixture failure was not recorded.');
      }
      const manualBatch = await batchForFailure(manualFailure.failureId);
      const manualRepair = await resolveForRepair(manualFailure.failureId);
      running = await start(manualRepair.repaired);
      const manualAdvance = command(running, 'AdvanceSimulationV1', { ticks: 1 });
      const manualResponse = await submit(creator, worldA.worldId, manualAdvance);
      expect(manualResponse.statusCode, manualResponse.body).toBe(200);
      await expect(
        client.pool.query(
          `select id,attempts,status::text,command_id
             from simulation_batch_runs where world_id=$1 and id=$2`,
          [worldA.worldId, manualBatch.batch_id],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            attempts: 5,
            command_id: manualAdvance.commandId,
            id: manualBatch.batch_id,
            status: 'completed',
          },
        ],
      });
      await expect(executionCount(manualSchedule.scheduleId)).resolves.toEqual({
        executed: '1',
        notices: '1',
      });
      const afterManual = await readClock(creator, worldA.worldId);
      const cleanup = await submit(
        creator,
        worldA.worldId,
        command(afterManual, 'PauseWorldClockV1', {}),
      );
      expect(cleanup.statusCode, cleanup.body).toBe(200);
    } finally {
      await client.pool.query(`select worldgraph_release_simulation_lease($1,$2,$3::bigint)`, [
        worldA.worldId,
        leaseOwner,
        leaseFencingToken,
      ]);
    }
  }, 180_000);

  it('serializes a real creator pause against a continuously due worker advance', async () => {
    const initialized = await readClock(creator, worldB.worldId);
    const configured = await submit(
      creator,
      worldB.worldId,
      command(initialized, 'ConfigureWorldClockV1', {
        epoch: initialized.clock.configuration.epochAt,
        maxBatch: 64,
        maxCatchUp: 256,
        wallCadenceMs: 100,
        worldMillisecondsPerTick: initialized.clock.configuration.worldMillisecondsPerTick,
      }),
    );
    expect(configured.statusCode, configured.body).toBe(200);
    const beforeStart = await readClock(creator, worldB.worldId);
    const started = await submit(
      creator,
      worldB.worldId,
      command(beforeStart, 'StartWorldClockV1', {}),
    );
    expect(started.statusCode, started.body).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const running = await readClock(creator, worldB.worldId);
    expect(running.clock.mode).toBe('running');
    const leaseOwner = 'm07-api-pause-race-worker';
    const lease = await client.pool.query<{ fencing_token: string }>(
      `select fencing_token::text
         from worldgraph_acquire_simulation_lease($1,$2,60000)`,
      [worldB.worldId, leaseOwner],
    );
    const leaseFencingToken = lease.rows[0]?.fencing_token;
    if (!leaseFencingToken) throw new Error('pause-race lease acquisition failed');
    const fixtureModule = (await import(
      new URL(
        ['..', '..', '..', 'packages', 'simulation-command', 'src', 'postgres.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationCommandModule;
    const fixturePort = new fixtureModule.PostgresSimulationAdvanceCommand(client.pool, {
      ids,
      retryDelay: async () => undefined,
    });
    const workerCommand = command(running, 'AdvanceSimulationV1', { ticks: 1 });
    const pauseCommand = command(running, 'PauseWorldClockV1', {});

    const [workerResult, pauseResponse] = await Promise.all([
      fixturePort.advance({
        command: workerCommand,
        leaseFencingToken,
        leaseOwner,
        worldId: worldB.worldId,
      }),
      submit(creator, worldB.worldId, pauseCommand),
    ]);
    const workerWon = workerResult.status === 'advanced';
    const pauseWon = pauseResponse.statusCode === 200;
    expect(Number(workerWon) + Number(pauseWon)).toBe(1);
    if (!pauseWon) expect(pauseResponse.statusCode, pauseResponse.body).toBe(409);
    if (!workerWon) expect(workerResult.status).toBe('conflict');

    const accepted = await client.pool.query<{ count: string }>(
      `select count(*)::text count from command_records
        where id=any($1::uuid[]) and status='accepted'`,
      [[workerCommand.commandId, pauseCommand.commandId]],
    );
    expect(accepted.rows[0]?.count).toBe('1');
    const after = await readClock(creator, worldB.worldId);
    expect(after.stateRevision).toBe((BigInt(running.stateRevision) + 1n).toString(10));
    expect(after.aggregateVersion).toBe((BigInt(running.aggregateVersion) + 1n).toString(10));
    if (workerWon) {
      expect(after.clock).toMatchObject({ currentTick: '1', mode: 'running' });
      const cleanup = await submit(
        creator,
        worldB.worldId,
        command(after, 'PauseWorldClockV1', {}),
      );
      expect(cleanup.statusCode, cleanup.body).toBe(200);
    } else {
      expect(after.clock).toMatchObject({ currentTick: '0', mode: 'paused' });
    }
    await expect(
      client.pool.query(`select worldgraph_release_simulation_lease($1,$2,$3::bigint) released`, [
        worldB.worldId,
        leaseOwner,
        leaseFencingToken,
      ]),
    ).resolves.toMatchObject({ rows: [{ released: true }] });
    expect((await readClock(creator, worldB.worldId)).clock.mode).toBe('paused');
  }, 180_000);

  it('stops on a real Redis disconnect and resumes from PostgreSQL authority on reconnect', async () => {
    const paused = await readClock(creator, worldB.worldId);
    expect(paused.clock.mode).toBe('paused');
    const started = await submit(creator, worldB.worldId, command(paused, 'StartWorldClockV1', {}));
    expect(started.statusCode, started.body).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const repositoryModule = (await import(
      new URL(
        ['..', '..', '..', 'apps', 'worker', 'src', 'simulation-repository.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationRepositoryModule;
    const workerModule = (await import(
      new URL(
        ['..', '..', '..', 'apps', 'worker', 'src', 'simulation-worker.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationWorkerModule;
    const commandModule = (await import(
      new URL(
        ['..', '..', '..', 'packages', 'simulation-command', 'src', 'postgres.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationCommandModule;
    const logger = createLogger({
      buildRevision: 'test',
      environment: 'test',
      level: 'fatal',
      service: 'm07-real-redis-recovery-test',
    });
    const repository = new repositoryModule.PostgresSimulationLeaseRepository(client.pool);
    const commandPort = new commandModule.PostgresSimulationAdvanceCommand(client.pool, {
      ids,
      retryDelay: async () => undefined,
    });
    const runner = new workerModule.SimulationRunner(
      repository,
      commandPort,
      'm07-real-redis-recovery-worker',
      logger,
      {
        ids,
        leaseMs: 30_000,
        maximumAttempts: 1,
        maximumWorldsPerRun: 10,
        wait: async () => undefined,
      },
    );
    const coordinator = new workerModule.SimulationCoordinator(runner, logger, {
      isAutomationAvailable: () => redis.status === 'ready',
      reconciliationIntervalMs: 100,
    });
    try {
      const beforeLoss = await readClock(creator, worldB.worldId);
      const redisEnded = new Promise<void>((resolve) => redis.once('end', resolve));
      redis.disconnect(false);
      await redisEnded;
      expect(redis.status).toBe('end');
      await expect(coordinator.wake()).resolves.toEqual([]);
      await expect(readClock(creator, worldB.worldId)).resolves.toEqual(beforeLoss);

      await redis.connect();
      await expect(redis.ping()).resolves.toBe('PONG');
      const recovered = await coordinator.wake();
      expect(recovered).toContainEqual(
        expect.objectContaining({ outcome: 'advanced', worldId: worldB.worldId }),
      );
      const afterRecovery = await readClock(creator, worldB.worldId);
      expect(BigInt(afterRecovery.clock.currentTick)).toBeGreaterThan(
        BigInt(beforeLoss.clock.currentTick),
      );
      expect(afterRecovery.stateRevision).toBe(
        (BigInt(beforeLoss.stateRevision) + 1n).toString(10),
      );
      const cleanup = await submit(
        creator,
        worldB.worldId,
        command(afterRecovery, 'PauseWorldClockV1', {}),
      );
      expect(cleanup.statusCode, cleanup.body).toBe(200);
    } finally {
      await coordinator.stop();
      if (redis.status !== 'ready') await redis.connect();
    }
  }, 180_000);

  it('converges identical worlds across one three-tick batch and three one-tick batches', async () => {
    creator = await login('m07-command-creator@example.test');
    const prompt = 'Twin deterministic observatories publish the same scheduled notice.';
    convergenceWorldA = await createApprovedWorld(
      creator,
      'M07 Convergence One',
      prompt,
      'm07-convergence-manifest-seed',
      'm07-convergence-world-one',
    );
    convergenceWorldB = await createApprovedWorld(
      creator,
      'M07 Convergence Two',
      prompt,
      'm07-convergence-manifest-seed',
      'm07-convergence-world-two',
    );
    expect(convergenceWorldA.worldId).not.toBe(convergenceWorldB.worldId);
    expect(convergenceWorldA.contentHash).toBe(convergenceWorldB.contentHash);
    await compileAndActivate(
      convergenceWorldA,
      'm07-convergence-compile-one',
      'm07-convergence-runtime-seed',
    );
    await compileAndActivate(
      convergenceWorldB,
      'm07-convergence-compile-two',
      'm07-convergence-runtime-seed',
    );

    const clockA = await readClock(creator, convergenceWorldA.worldId);
    const clockB = await readClock(creator, convergenceWorldB.worldId);
    expect(clockA.clock.configuration).toEqual(clockB.clock.configuration);
    expect(clockA.clock.outcomeHash).toBe(clockB.clock.outcomeHash);
    const scheduleA = await createNoticeForWorld(
      creator,
      convergenceWorldA.worldId,
      '2',
      -7,
      'The observatory bells agree.',
      'public',
    );
    const scheduleB = await createNoticeForWorld(
      creator,
      convergenceWorldB.worldId,
      '2',
      -7,
      'The observatory bells agree.',
      'public',
    );
    expect(scheduleA.scheduleId).not.toBe(scheduleB.scheduleId);
    expect(scheduleA.commandId).not.toBe(scheduleB.commandId);
    expect(scheduleA.scheduleSequence).toBe(scheduleB.scheduleSequence);

    const semanticSnapshot = async (worldId: string) => {
      const result = await client.pool.query<{
        checkpoint_checksum: string;
        computed_checksum: string;
        current_tick: string;
        outcome_hash: string;
        world_seed: string;
      }>(
        `select clock.current_tick::text,encode(clock.outcome_hash,'hex') outcome_hash,
                version.seed world_seed,
                encode(checkpoint.checksum,'hex') checkpoint_checksum,
                encode(worldgraph_simulation_projection_checksum($1),'hex') computed_checksum
           from world_simulation_clocks clock
           join world_runtime_heads runtime on runtime.world_id=clock.world_id
           join world_versions version on version.id=runtime.active_world_version_id
            and version.world_id=runtime.world_id
           join projection_checkpoints checkpoint on checkpoint.world_id=clock.world_id
            and checkpoint.projection_name='simulation_runtime'
          where clock.world_id=$1`,
        [worldId],
      );
      return result.rows[0]!;
    };
    const replaySnapshot = async (worldId: string) => {
      const replaySource = await client.pool.query<{ seed: string }>(
        `select version.seed
           from world_runtime_heads runtime
           join world_versions version on version.id=runtime.active_world_version_id
            and version.world_id=runtime.world_id
          where runtime.world_id=$1`,
        [worldId],
      );
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
        [worldId],
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
      return replaySimulationProjectionV1({
        events,
        worldId,
        worldSeed: replaySource.rows[0]!.seed,
      });
    };
    const beforeA = await semanticSnapshot(convergenceWorldA.worldId);
    const beforeB = await semanticSnapshot(convergenceWorldB.worldId);
    expect(beforeA).toEqual(beforeB);
    expect(beforeA.checkpoint_checksum).toBe(beforeA.computed_checksum);

    const threeTickCommand = command(
      await readClock(creator, convergenceWorldA.worldId),
      'AdvanceSimulationV1',
      { ticks: 3 },
    );
    const threeTickResponse = await submit(creator, convergenceWorldA.worldId, threeTickCommand);
    expect(threeTickResponse.statusCode, threeTickResponse.body).toBe(200);
    const singleTickCommandIds: string[] = [];
    for (let tick = 1; tick <= 3; tick += 1) {
      const singleTickCommand = command(
        await readClock(creator, convergenceWorldB.worldId),
        'AdvanceSimulationV1',
        { ticks: 1 },
      );
      singleTickCommandIds.push(singleTickCommand.commandId);
      const response = await submit(creator, convergenceWorldB.worldId, singleTickCommand);
      expect(response.statusCode, response.body).toBe(200);
    }

    const afterA = await semanticSnapshot(convergenceWorldA.worldId);
    const afterB = await semanticSnapshot(convergenceWorldB.worldId);
    expect(afterA).toEqual(afterB);
    expect(afterA).toMatchObject({ current_tick: '3' });
    expect(afterA.outcome_hash).not.toBe(beforeA.outcome_hash);
    expect(afterA.checkpoint_checksum).toBe(afterA.computed_checksum);
    const replayA = await replaySnapshot(convergenceWorldA.worldId);
    const replayB = await replaySnapshot(convergenceWorldB.worldId);
    expect(replayA.checksum).toBe(afterA.computed_checksum);
    expect(replayB.checksum).toBe(afterB.computed_checksum);
    expect(replayA.checksum).toBe(replayB.checksum);
    expect(replayA.projection.clock).toMatchObject({
      currentTick: '3',
      outcomeHash: afterA.outcome_hash,
    });
    expect(replayA.projection.scheduledActions).toHaveLength(1);
    expect(replayA.projection.scheduledActions[0]).toMatchObject({
      dueTick: '2',
      status: 'completed',
    });
    const batches = await client.pool.query<{
      command_id: string;
      from_tick: string;
      id: string;
      to_tick: string;
      world_id: string;
    }>(
      `select id,world_id,command_id,from_tick::text,to_tick::text
         from simulation_batch_runs
        where world_id=any($1::uuid[]) and status='completed'
        order by world_id,from_tick`,
      [[convergenceWorldA.worldId, convergenceWorldB.worldId]],
    );
    const worldABatches = batches.rows.filter(
      ({ world_id: worldId }) => worldId === convergenceWorldA.worldId,
    );
    const worldBBatches = batches.rows.filter(
      ({ world_id: worldId }) => worldId === convergenceWorldB.worldId,
    );
    expect(worldABatches.map(({ from_tick, to_tick }) => [from_tick, to_tick])).toEqual([
      ['0', '3'],
    ]);
    expect(worldBBatches.map(({ from_tick, to_tick }) => [from_tick, to_tick])).toEqual([
      ['0', '1'],
      ['1', '2'],
      ['2', '3'],
    ]);
    expect(new Set(batches.rows.map(({ id }) => id)).size).toBe(4);
    expect(worldABatches[0]?.command_id).toBe(threeTickCommand.commandId);
    expect(worldBBatches.map(({ command_id }) => command_id)).toEqual(singleTickCommandIds);
  }, 180_000);

  it('serializes two real runners into monotonic nonduplicated PostgreSQL batches', async () => {
    creator = await login('m07-command-creator@example.test');
    const paused = await readClock(creator, worldB.worldId);
    expect(paused.clock.mode).toBe('paused');
    const started = await submit(creator, worldB.worldId, command(paused, 'StartWorldClockV1', {}));
    expect(started.statusCode, started.body).toBe(200);
    const running = await readClock(creator, worldB.worldId);
    const runnerA = await realSimulationRunner('m07-real-runner-a');
    const runnerB = await realSimulationRunner('m07-real-runner-b');

    const runContendedRound = async () => {
      await ageWallAnchor(worldB.worldId, 350);
      const rounds = await Promise.all([runnerA.reconcile(), runnerB.reconcile()]);
      const results = rounds.flat();
      expect(
        results.filter(
          ({ outcome, worldId }) => outcome === 'advanced' && worldId === worldB.worldId,
        ),
      ).toHaveLength(1);
      expect(results.filter(({ outcome }) => outcome === 'failed')).toHaveLength(0);
      return results;
    };
    await runContendedRound();
    await runContendedRound();

    const after = await readClock(creator, worldB.worldId);
    const batches = await client.pool.query<{
      command_id: string;
      from_tick: string;
      id: string;
      to_tick: string;
    }>(
      `select id,command_id,from_tick::text,to_tick::text
         from simulation_batch_runs
        where world_id=$1 and status='completed' and from_tick >= $2::bigint
        order by from_tick,to_tick,id`,
      [worldB.worldId, running.clock.currentTick],
    );
    expect(batches.rows).toHaveLength(2);
    expect(batches.rows[0]?.from_tick).toBe(running.clock.currentTick);
    expect(batches.rows[1]?.from_tick).toBe(batches.rows[0]?.to_tick);
    expect(batches.rows[1]?.to_tick).toBe(after.clock.currentTick);
    expect(new Set(batches.rows.map(({ id }) => id)).size).toBe(2);
    expect(new Set(batches.rows.map(({ command_id }) => command_id)).size).toBe(2);
    expect(after.stateRevision).toBe((BigInt(running.stateRevision) + 2n).toString(10));
    const cleanup = await submit(creator, worldB.worldId, command(after, 'PauseWorldClockV1', {}));
    expect(cleanup.statusCode, cleanup.body).toBe(200);
  }, 180_000);

  it('rejects a stale worker write after a creator pause has committed', async () => {
    creator = await login('m07-command-creator@example.test');
    const paused = await readClock(creator, worldB.worldId);
    expect(paused.clock.mode).toBe('paused');
    const startResponse = await submit(
      creator,
      worldB.worldId,
      command(paused, 'StartWorldClockV1', {}),
    );
    expect(startResponse.statusCode, startResponse.body).toBe(200);
    const running = await readClock(creator, worldB.worldId);
    const leaseOwner = 'm07-stale-after-pause-worker';
    const lease = await client.pool.query<{ fencing_token: string }>(
      `select fencing_token::text
         from worldgraph_acquire_simulation_lease($1,$2,60000)`,
      [worldB.worldId, leaseOwner],
    );
    const fencingToken = lease.rows[0]?.fencing_token;
    if (!fencingToken) throw new Error('The stale-after-pause lease was not acquired.');
    const staleCommand = command(running, 'AdvanceSimulationV1', { ticks: 1 });
    const pauseResponse = await submit(
      creator,
      worldB.worldId,
      command(running, 'PauseWorldClockV1', {}),
    );
    expect(pauseResponse.statusCode, pauseResponse.body).toBe(200);
    const afterPause = await authoritativeFootprint(worldB.worldId);
    const commandModule = (await import(
      new URL(
        ['..', '..', '..', 'packages', 'simulation-command', 'src', 'postgres.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationCommandModule;
    const port = new commandModule.PostgresSimulationAdvanceCommand(client.pool, {
      ids: new UuidV7Generator(),
      retryDelay: async () => undefined,
    });
    await expect(
      port.advance({
        command: staleCommand,
        leaseFencingToken: fencingToken,
        leaseOwner,
        worldId: worldB.worldId,
      }),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(authoritativeFootprint(worldB.worldId)).resolves.toEqual(afterPause);
    await expect(commandFootprint(staleCommand.commandId)).resolves.toEqual({
      batches: '0',
      commands: '0',
      events: '0',
      ledger: '0',
      outbox: '0',
    });
    await client.pool.query(`select worldgraph_release_simulation_lease($1,$2,$3::bigint)`, [
      worldB.worldId,
      leaseOwner,
      fencingToken,
    ]);
  }, 180_000);

  it('serializes cancel versus execute into exactly one terminal schedule path', async () => {
    creator = await login('m07-command-creator@example.test');
    const paused = await readClock(creator, worldB.worldId);
    expect(paused.clock.mode).toBe('paused');
    const dueTick = (BigInt(paused.clock.currentTick) + 1n).toString(10);
    const schedule = await createNoticeForWorld(
      creator,
      worldB.worldId,
      dueTick,
      -40,
      'Cancel and execute contend for this notice.',
      'public',
    );
    const beforeStart = await readClock(creator, worldB.worldId);
    const startResponse = await submit(
      creator,
      worldB.worldId,
      command(beforeStart, 'StartWorldClockV1', {}),
    );
    expect(startResponse.statusCode, startResponse.body).toBe(200);
    await ageWallAnchor(worldB.worldId, 150);
    const running = await readClock(creator, worldB.worldId);
    const leaseOwner = 'm07-cancel-execute-worker';
    const lease = await client.pool.query<{ fencing_token: string }>(
      `select fencing_token::text
         from worldgraph_acquire_simulation_lease($1,$2,60000)`,
      [worldB.worldId, leaseOwner],
    );
    const fencingToken = lease.rows[0]?.fencing_token;
    if (!fencingToken) throw new Error('The cancel-execute lease was not acquired.');
    const commandModule = (await import(
      new URL(
        ['..', '..', '..', 'packages', 'simulation-command', 'src', 'postgres.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationCommandModule;
    const port = new commandModule.PostgresSimulationAdvanceCommand(client.pool, {
      ids: new UuidV7Generator(),
      retryDelay: async () => undefined,
    });
    const workerCommand = command(running, 'AdvanceSimulationV1', { ticks: 1 });
    const scheduleStream = await client.pool.query<{ aggregate_version: string }>(
      `select current_version::text aggregate_version
         from aggregate_stream_heads
        where world_id=$1 and aggregate_type='scheduled_action' and aggregate_id=$2`,
      [worldB.worldId, schedule.scheduleId],
    );
    const cancelCommand = command(
      running,
      'CancelScheduledActionV1',
      { scheduleId: schedule.scheduleId },
      { expectedAggregateVersion: scheduleStream.rows[0]!.aggregate_version },
    );
    const [workerResult, cancelResponse] = await Promise.all([
      port.advance({
        command: workerCommand,
        leaseFencingToken: fencingToken,
        leaseOwner,
        worldId: worldB.worldId,
      }),
      submit(creator, worldB.worldId, cancelCommand),
    ]);
    const workerAccepted = workerResult.status === 'advanced';
    const cancelAccepted = cancelResponse.statusCode === 200;
    expect(Number(workerAccepted) + Number(cancelAccepted)).toBe(1);
    if (!workerAccepted) expect(workerResult.status).toBe('conflict');
    if (!cancelAccepted) expect(cancelResponse.statusCode, cancelResponse.body).toBe(409);
    const accepted = await client.pool.query<{ accepted: string }>(
      `select count(*) filter (where status='accepted')::text accepted
         from command_records where id=any($1::uuid[])`,
      [[workerCommand.commandId, cancelCommand.commandId]],
    );
    expect(accepted.rows[0]?.accepted).toBe('1');
    const terminal = await client.pool.query<{
      cancelled_command_id: string | null;
      completed_event_id: string | null;
      status: string;
    }>(
      `select status::text,cancelled_command_id,completed_event_id
         from scheduled_actions where world_id=$1 and id=$2`,
      [worldB.worldId, schedule.scheduleId],
    );
    expect(['cancelled', 'completed']).toContain(terminal.rows[0]?.status);
    const sideEffects = await client.pool.query<{ executed: string; notices: string }>(
      `select count(*) filter (where event_type='ScheduledActionExecutedV1')::text executed,
              count(*) filter (where event_type='WorldNoticeEmittedV1')::text notices
         from domain_events
        where world_id=$1 and payload->>'scheduleId'=$2`,
      [worldB.worldId, schedule.scheduleId],
    );
    expect(sideEffects.rows[0]).toEqual(
      terminal.rows[0]?.status === 'completed'
        ? { executed: '1', notices: '1' }
        : { executed: '0', notices: '0' },
    );
    expect(Number(sideEffects.rows[0]!.notices)).toBeLessThanOrEqual(1);
    await client.pool.query(`select worldgraph_release_simulation_lease($1,$2,$3::bigint)`, [
      worldB.worldId,
      leaseOwner,
      fencingToken,
    ]);
    const afterRace = await readClock(creator, worldB.worldId);
    expect(afterRace.stateRevision).toBe((BigInt(running.stateRevision) + 1n).toString(10));
    const cleanup = await submit(
      creator,
      worldB.worldId,
      command(afterRace, 'PauseWorldClockV1', {}),
    );
    expect(cleanup.statusCode, cleanup.body).toBe(200);
  }, 180_000);

  it('fails closed above max catch-up until bounded manual recovery resets the anchor', async () => {
    creator = await login('m07-command-creator@example.test');
    const initial = await readClock(creator, convergenceWorldA.worldId);
    expect(initial.clock).toMatchObject({ currentTick: '3', mode: 'paused' });
    const start = await submit(
      creator,
      convergenceWorldA.worldId,
      command(initial, 'StartWorldClockV1', {}),
    );
    expect(start.statusCode, start.body).toBe(200);
    await ageWallAnchor(
      convergenceWorldA.worldId,
      initial.clock.configuration.wallCadenceMilliseconds *
        (initial.clock.configuration.maxCatchUpTicks + 2),
    );
    const overdue = await client.pool.query<{ due_ticks: string; max_catch_up_ticks: number }>(
      `select floor(extract(epoch from (clock_timestamp()-last_wall_anchor_at))*1000
                    / wall_cadence_milliseconds)::bigint::text due_ticks,
              max_catch_up_ticks
         from world_simulation_clocks where world_id=$1`,
      [convergenceWorldA.worldId],
    );
    expect(BigInt(overdue.rows[0]!.due_ticks)).toBeGreaterThan(
      BigInt(overdue.rows[0]!.max_catch_up_ticks),
    );
    const beforeWakes = await authoritativeFootprint(convergenceWorldA.worldId);
    const runner = await realSimulationRunner('m07-max-catch-up-worker');
    for (let wake = 0; wake < 2; wake += 1) {
      await expect(runner.reconcile()).resolves.toContainEqual({
        attempts: 0,
        outcome: 'not_due',
        worldId: convergenceWorldA.worldId,
      });
    }
    await expect(authoritativeFootprint(convergenceWorldA.worldId)).resolves.toEqual(beforeWakes);

    const overdueClock = await readClock(creator, convergenceWorldA.worldId);
    const pause = await submit(
      creator,
      convergenceWorldA.worldId,
      command(overdueClock, 'PauseWorldClockV1', {}),
    );
    expect(pause.statusCode, pause.body).toBe(200);
    const paused = await readClock(creator, convergenceWorldA.worldId);
    const manualAdvance = command(paused, 'AdvanceSimulationV1', { ticks: 1 });
    const manual = await submit(creator, convergenceWorldA.worldId, manualAdvance);
    expect(manual.statusCode, manual.body).toBe(200);
    const manuallyAdvanced = await readClock(creator, convergenceWorldA.worldId);
    expect(manuallyAdvanced.clock).toMatchObject({ currentTick: '4', mode: 'paused' });
    const restart = await submit(
      creator,
      convergenceWorldA.worldId,
      command(manuallyAdvanced, 'StartWorldClockV1', {}),
    );
    expect(restart.statusCode, restart.body).toBe(200);
    await ageWallAnchor(
      convergenceWorldA.worldId,
      initial.clock.configuration.wallCadenceMilliseconds + 50,
    );
    await expect(runner.reconcile()).resolves.toContainEqual({
      attempts: 1,
      outcome: 'advanced',
      worldId: convergenceWorldA.worldId,
    });
    const recovered = await readClock(creator, convergenceWorldA.worldId);
    expect(recovered.clock.currentTick).toBe('5');
    const recoveredBatches = await client.pool.query<{
      from_tick: string;
      to_tick: string;
    }>(
      `select from_tick::text,to_tick::text from simulation_batch_runs
        where world_id=$1 and from_tick >= 3 order by from_tick`,
      [convergenceWorldA.worldId],
    );
    expect(recoveredBatches.rows).toEqual([
      { from_tick: '3', to_tick: '4' },
      { from_tick: '4', to_tick: '5' },
    ]);
    const cleanup = await submit(
      creator,
      convergenceWorldA.worldId,
      command(recovered, 'PauseWorldClockV1', {}),
    );
    expect(cleanup.statusCode, cleanup.body).toBe(200);
  }, 180_000);

  it('rejects unrenderable time without state writes and auto-pauses worker clock exhaustion', async () => {
    creator = await login('m07-command-creator@example.test');
    const boundaryWorld = await createApprovedWorld(
      creator,
      'M07 Clock Boundary',
      'A deterministic observatory reaches the final renderable millisecond of world time.',
      'm07-clock-boundary-manifest-seed',
      'm07-clock-boundary-world',
    );
    await compileAndActivate(boundaryWorld, 'm07-clock-boundary-compile');

    const initial = await readClock(creator, boundaryWorld.worldId);
    const beforeInvalidConfiguration = await authoritativeFootprint(boundaryWorld.worldId);
    const invalidConfiguration = command(initial, 'ConfigureWorldClockV1', {
      epoch: '9999-12-31T23:59:59.999Z',
      maxBatch: 1,
      maxCatchUp: 1,
      wallCadenceMs: 100,
      worldMillisecondsPerTick: 1,
    });
    const invalidConfigurationResponse = await submit(
      creator,
      boundaryWorld.worldId,
      invalidConfiguration,
    );
    expect(invalidConfigurationResponse.statusCode, invalidConfigurationResponse.body).toBe(409);
    expect(invalidConfigurationResponse.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'SIMULATION_INTEGER_OVERFLOW',
      status: 'rejected',
    });
    await expect(authoritativeFootprint(boundaryWorld.worldId)).resolves.toEqual(
      beforeInvalidConfiguration,
    );
    await expect(commandFootprint(invalidConfiguration.commandId)).resolves.toEqual({
      batches: '0',
      commands: '1',
      events: '0',
      ledger: '1',
      outbox: '0',
    });

    const validConfiguration = command(initial, 'ConfigureWorldClockV1', {
      epoch: '9999-12-31T23:59:59.997Z',
      maxBatch: 1,
      maxCatchUp: 1,
      wallCadenceMs: 100,
      worldMillisecondsPerTick: 1,
    });
    const validConfigurationResponse = await submit(
      creator,
      boundaryWorld.worldId,
      validConfiguration,
    );
    expect(validConfigurationResponse.statusCode, validConfigurationResponse.body).toBe(200);

    for (const targetTick of ['1', '2']) {
      const before = await readClock(creator, boundaryWorld.worldId);
      const response = await submit(
        creator,
        boundaryWorld.worldId,
        command(before, 'AdvanceSimulationV1', { ticks: 1 }),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect((await readClock(creator, boundaryWorld.worldId)).clock.currentTick).toBe(targetTick);
    }
    const atBoundary = await readClock(creator, boundaryWorld.worldId);
    expect(atBoundary.worldTime).toMatchObject({
      tick: '2',
      worldTimeAt: '9999-12-31T23:59:59.999Z',
    });

    const beforeManualOverflow = await authoritativeFootprint(boundaryWorld.worldId);
    const manualOverflow = command(atBoundary, 'AdvanceSimulationV1', { ticks: 1 });
    const manualOverflowResponse = await submit(creator, boundaryWorld.worldId, manualOverflow);
    expect(manualOverflowResponse.statusCode, manualOverflowResponse.body).toBe(409);
    expect(manualOverflowResponse.json()).toMatchObject({
      eventIds: [],
      rejectionCode: 'SIMULATION_INTEGER_OVERFLOW',
      status: 'rejected',
    });
    await expect(authoritativeFootprint(boundaryWorld.worldId)).resolves.toEqual(
      beforeManualOverflow,
    );
    await expect(commandFootprint(manualOverflow.commandId)).resolves.toEqual({
      batches: '0',
      commands: '1',
      events: '0',
      ledger: '1',
      outbox: '0',
    });

    const startResponse = await submit(
      creator,
      boundaryWorld.worldId,
      command(atBoundary, 'StartWorldClockV1', {}),
    );
    expect(startResponse.statusCode, startResponse.body).toBe(200);
    await ageWallAnchor(boundaryWorld.worldId, 150);
    const runner = await realSimulationRunner('m07-clock-boundary-worker');
    await expect(runner.reconcile()).resolves.toContainEqual({
      attempts: 1,
      outcome: 'auto_paused',
      worldId: boundaryWorld.worldId,
    });

    const exhausted = await readClock(creator, boundaryWorld.worldId);
    expect(exhausted.clock).toMatchObject({ currentTick: '2', mode: 'error' });
    expect(exhausted.worldTime).toMatchObject({
      tick: '2',
      worldTimeAt: '9999-12-31T23:59:59.999Z',
    });
    const failure = await client.pool.query<{
      error_code: string;
      failure_tick: string;
      from_tick: string;
      process_type: string;
      process_version: string;
      schedule_id: string | null;
      status: string;
      to_tick: string;
    }>(
      `select failure.error_code,failure.tick::text failure_tick,
              failure.process_type,failure.process_version,failure.schedule_id,
              batch.from_tick::text,batch.to_tick::text,batch.status::text
         from simulation_failures failure
         join simulation_batch_runs batch on batch.world_id=failure.world_id
          and batch.id=failure.batch_run_id
        where failure.world_id=$1 and failure.status='open'`,
      [boundaryWorld.worldId],
    );
    expect(failure.rows).toEqual([
      {
        error_code: 'SIMULATION_INTEGER_OVERFLOW',
        failure_tick: '3',
        from_tick: '2',
        process_type: 'WorldClockV1',
        process_version: '1.0.0',
        schedule_id: null,
        status: 'failed',
        to_tick: '3',
      },
    ]);
    const failedAdvanceEvents = await client.pool.query<{ count: string }>(
      `select count(*)::text count from domain_events
        where world_id=$1 and event_type='SimulationAdvancedV1'
          and payload->>'fromTick'='2'`,
      [boundaryWorld.worldId],
    );
    expect(failedAdvanceEvents.rows).toEqual([{ count: '0' }]);

    const signedInt64Boundary = '9223372036854775807';
    const forcedBoundary = await client.pool.connect();
    try {
      await forcedBoundary.query('begin');
      await forcedBoundary.query(`set local session_replication_role = 'replica'`);
      await forcedBoundary.query(
        `update world_simulation_clocks
            set current_tick=$2::bigint,mode='running',
                last_wall_anchor_at=date_trunc(
                  'milliseconds',clock_timestamp()-interval '150 milliseconds'
                )
          where world_id=$1`,
        [boundaryWorld.worldId, signedInt64Boundary],
      );
      await forcedBoundary.query(
        `update projection_checkpoints
            set checksum=worldgraph_simulation_projection_checksum($1)
          where world_id=$1 and projection_name='simulation_runtime'`,
        [boundaryWorld.worldId],
      );
      await forcedBoundary.query('commit');
    } catch (error) {
      await forcedBoundary.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      forcedBoundary.release();
    }

    const zeroWidthRunner = await realSimulationRunner('m07-signed-int64-boundary-worker');
    await expect(zeroWidthRunner.reconcile()).resolves.toContainEqual({
      attempts: 1,
      outcome: 'auto_paused',
      worldId: boundaryWorld.worldId,
    });
    const zeroWidthFailure = await client.pool.query<{
      current_tick: string;
      error_code: string;
      failure_tick: string;
      from_tick: string;
      mode: string;
      process_type: string;
      schedule_id: string | null;
      to_tick: string;
    }>(
      `select clock.current_tick::text,clock.mode::text,
              failure.error_code,failure.tick::text failure_tick,
              failure.process_type,failure.schedule_id,
              batch.from_tick::text,batch.to_tick::text
         from simulation_failures failure
         join simulation_batch_runs batch on batch.world_id=failure.world_id
          and batch.id=failure.batch_run_id
         join world_simulation_clocks clock on clock.world_id=failure.world_id
        where failure.world_id=$1 and failure.tick=$2::bigint`,
      [boundaryWorld.worldId, signedInt64Boundary],
    );
    expect(zeroWidthFailure.rows).toEqual([
      {
        current_tick: signedInt64Boundary,
        error_code: 'SIMULATION_INTEGER_OVERFLOW',
        failure_tick: signedInt64Boundary,
        from_tick: signedInt64Boundary,
        mode: 'error',
        process_type: 'WorldClockV1',
        schedule_id: null,
        to_tick: signedInt64Boundary,
      },
    ]);
  }, 180_000);

  it('freezes manual and automatic authority while the semantic simulation checkpoint diverges', async () => {
    creator = await login('m07-command-creator@example.test');
    const targetWorldId = convergenceWorldB.worldId;
    const paused = await readClock(creator, targetWorldId);
    expect(paused.clock.mode).toBe('paused');
    const startResponse = await submit(
      creator,
      targetWorldId,
      command(paused, 'StartWorldClockV1', {}),
    );
    expect(startResponse.statusCode, startResponse.body).toBe(200);
    const running = await readClock(creator, targetWorldId);
    await ageWallAnchor(targetWorldId, running.clock.configuration.wallCadenceMilliseconds + 50);

    const original = await client.pool.query<{ outcome_hash: Buffer }>(
      `select outcome_hash from world_simulation_clocks where world_id=$1`,
      [targetWorldId],
    );
    const originalOutcomeHash = original.rows[0]!.outcome_hash;
    const restoreOutcomeHash = async (): Promise<void> => {
      const restore = await client.pool.connect();
      try {
        await restore.query('begin');
        await restore.query(`set local session_replication_role = 'replica'`);
        await restore.query(
          `update world_simulation_clocks set outcome_hash=$2 where world_id=$1`,
          [targetWorldId, originalOutcomeHash],
        );
        await restore.query('commit');
      } catch (error) {
        await restore.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        restore.release();
      }
    };
    const corruption = await client.pool.connect();
    try {
      await corruption.query('begin');
      await corruption.query(`set local session_replication_role = 'replica'`);
      await corruption.query(
        `update world_simulation_clocks
            set outcome_hash=extensions.digest(
              convert_to('m07-deliberate-simulation-corruption','UTF8'),'sha256'
            )
          where world_id=$1`,
        [targetWorldId],
      );
      await corruption.query('commit');
    } catch (error) {
      await corruption.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      corruption.release();
    }

    try {
      const divergent = await authoritativeFootprint(targetWorldId);
      expect(divergent.simulation_checksum).not.toBe(divergent.simulation_checkpoint);
      const replayChecksum = await simulationReplayChecksum(targetWorldId);
      expect(replayChecksum).toBe(divergent.simulation_checkpoint);
      expect(replayChecksum).not.toBe(divergent.simulation_checksum);

      const blockedPause = command(
        await readClock(creator, targetWorldId),
        'PauseWorldClockV1',
        {},
      );
      const blockedPauseResponse = await submit(creator, targetWorldId, blockedPause);
      expect(blockedPauseResponse.statusCode, blockedPauseResponse.body).toBe(500);
      await expect(commandFootprint(blockedPause.commandId)).resolves.toEqual({
        batches: '0',
        commands: '0',
        events: '0',
        ledger: '0',
        outbox: '0',
      });
      await expect(authoritativeFootprint(targetWorldId)).resolves.toEqual(divergent);

      const runner = await realSimulationRunner('m07-corrupt-projection-worker');
      await expect(runner.reconcile()).resolves.toContainEqual({
        attempts: 0,
        outcome: 'not_due',
        worldId: targetWorldId,
      });
      await expect(authoritativeFootprint(targetWorldId)).resolves.toEqual(divergent);
      expect(await simulationReplayChecksum(targetWorldId)).toBe(replayChecksum);
    } finally {
      await restoreOutcomeHash();
    }

    const restored = await authoritativeFootprint(targetWorldId);
    expect(restored.simulation_checksum).toBe(restored.simulation_checkpoint);
    const cleanup = await submit(
      creator,
      targetWorldId,
      command(await readClock(creator, targetWorldId), 'PauseWorldClockV1', {}),
    );
    expect(cleanup.statusCode, cleanup.body).toBe(200);
  }, 180_000);

  function command(
    clock: SimulationClockViewTransport,
    type: string,
    payload: Record<string, unknown>,
    overrides: Partial<SubmitWorldCommand> = {},
  ): SubmitWorldCommand {
    const commandId = ids.next();
    return {
      commandId,
      expectedAggregateVersion: type === 'ScheduleWorldNoticeV1' ? '0' : clock.aggregateVersion,
      expectedStateRevision: clock.stateRevision,
      expectedTick: clock.clock.currentTick,
      expectedWorldVersion: clock.designVersion,
      idempotencyKey: `m07-${type.toLowerCase()}-${commandId}`,
      payload,
      schemaVersion: 1,
      type,
      ...overrides,
    };
  }

  async function submit(session: BrowserSession, worldId: string, body: SubmitWorldCommand) {
    return app.inject({
      headers: mutationHeaders(session, body.idempotencyKey),
      method: 'POST',
      payload: body,
      url: `/api/v1/worlds/${worldId}/commands`,
    });
  }

  async function readClock(
    session: BrowserSession,
    worldId: string,
  ): Promise<SimulationClockViewTransport> {
    const response = await app.inject({
      headers: { cookie: session.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/simulation/clock`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SimulationClockViewTransport>();
  }

  async function scheduledIdentity(commandId: string): Promise<ScheduledIdentity> {
    const result = await client.pool.query<{
      schedule_id: string;
      schedule_sequence: string;
    }>(
      `select payload->>'scheduleId' as schedule_id,
              payload->>'scheduleSequence' as schedule_sequence
         from domain_events
        where command_id=$1 and event_type='ScheduledActionCreatedV1'`,
      [commandId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Missing schedule creation for command ${commandId}.`);
    return { scheduleId: row.schedule_id, scheduleSequence: row.schedule_sequence };
  }

  async function expectSchedule(
    scheduleId: string,
    status: 'scheduled' | 'completed',
    completedStateRevision: string | null,
  ): Promise<void> {
    const result = await client.pool.query<{
      completed_event_id: string | null;
      completed_state_revision: string | null;
      status: string;
    }>(
      `select status::text,completed_event_id,completed_state_revision::text
         from scheduled_actions where world_id=$1 and id=$2`,
      [worldA.worldId, scheduleId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      completed_state_revision: completedStateRevision,
      status,
    });
    if (status === 'completed')
      expect(result.rows[0]?.completed_event_id).toEqual(expect.any(String));
    else expect(result.rows[0]?.completed_event_id).toBeNull();
  }

  async function createNoticeAtCurrentTick(
    dueTick: string,
    priority: number,
    text: string,
    visibility: 'creator' | 'member' | 'public' = 'member',
  ): Promise<ScheduledIdentity> {
    const clock = await readClock(creator, worldA.worldId);
    const body = command(clock, 'ScheduleWorldNoticeV1', {
      dueTick,
      priority,
      text,
      visibility,
    });
    const response = await submit(creator, worldA.worldId, body);
    expect(response.statusCode, response.body).toBe(200);
    return scheduledIdentity(body.commandId);
  }

  async function createNoticeForWorld(
    session: BrowserSession,
    worldId: string,
    dueTick: string,
    priority: number,
    text: string,
    visibility: 'creator' | 'member' | 'public' = 'member',
  ): Promise<ScheduledIdentity & { commandId: string }> {
    const clock = await readClock(session, worldId);
    const body = command(clock, 'ScheduleWorldNoticeV1', {
      dueTick,
      priority,
      text,
      visibility,
    });
    const response = await submit(session, worldId, body);
    expect(response.statusCode, response.body).toBe(200);
    return { ...(await scheduledIdentity(body.commandId)), commandId: body.commandId };
  }

  async function ageWallAnchor(worldId: string, milliseconds: number): Promise<void> {
    const connection = await client.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      const updated = await connection.query(
        `update world_simulation_clocks
            set last_wall_anchor_at = date_trunc(
              'milliseconds',clock_timestamp() - $2::integer * interval '1 millisecond'
            )
          where world_id=$1 and mode='running'`,
        [worldId, milliseconds],
      );
      expect(updated.rowCount).toBe(1);
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async function realSimulationRunner(workerId: string) {
    const repositoryModule = (await import(
      new URL(
        ['..', '..', '..', 'apps', 'worker', 'src', 'simulation-repository.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationRepositoryModule;
    const workerModule = (await import(
      new URL(
        ['..', '..', '..', 'apps', 'worker', 'src', 'simulation-worker.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationWorkerModule;
    const commandModule = (await import(
      new URL(
        ['..', '..', '..', 'packages', 'simulation-command', 'src', 'postgres.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as SimulationCommandModule;
    return new workerModule.SimulationRunner(
      new repositoryModule.PostgresSimulationLeaseRepository(client.pool),
      new commandModule.PostgresSimulationAdvanceCommand(client.pool, {
        ids: new UuidV7Generator(),
        retryDelay: async () => undefined,
      }),
      workerId,
      createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: `${workerId}-test`,
      }),
      {
        ids: new UuidV7Generator(),
        leaseMs: 30_000,
        maximumAttempts: 1,
        maximumWorldsPerRun: 25,
        wait: async () => undefined,
      },
    );
  }

  async function executionCount(scheduleId: string): Promise<{
    executed: string;
    notices: string;
  }> {
    const result = await client.pool.query<{ executed: string; notices: string }>(
      `select
         count(*) filter (where event_type='ScheduledActionExecutedV1')::text as executed,
         count(*) filter (where event_type='WorldNoticeEmittedV1')::text as notices
       from domain_events
       where world_id=$1 and payload->>'scheduleId'=$2`,
      [worldA.worldId, scheduleId],
    );
    return result.rows[0]!;
  }

  async function commandFootprint(commandId: string): Promise<Record<string, string>> {
    const result = await client.pool.query<Record<string, string>>(
      `select
         (select count(*) from command_records where id=$1)::text as commands,
         (select count(*) from domain_events where command_id=$1)::text as events,
         (select count(*) from ledger_entries where command_id=$1)::text as ledger,
         (select count(*) from simulation_batch_runs where command_id=$1)::text as batches,
         (select count(*) from outbox_messages outbox
           join domain_events event on event.id=outbox.event_id
          where event.command_id=$1)::text as outbox`,
      [commandId],
    );
    return result.rows[0]!;
  }

  async function authoritativeFootprint(worldId: string): Promise<Record<string, string>> {
    const result = await client.pool.query<Record<string, string>>(
      `select runtime.state_revision::text,
              runtime.last_event_sequence::text,
              clock.current_tick::text,
              clock.row_version::text as clock_row_version,
              clock.mode::text,
              (select count(*) from domain_events where world_id=$1)::text as events,
              (select count(*) from outbox_messages where world_id=$1)::text as outbox,
              (select count(*) from scheduled_actions where world_id=$1)::text as schedules,
              (select count(*) from simulation_batch_runs where world_id=$1)::text as batches,
              encode(worldgraph_projection_checksum($1,runtime.state_revision),'hex') as graph_checksum,
              encode(worldgraph_simulation_projection_checksum($1),'hex') as simulation_checksum,
              encode(graph.checksum,'hex') as graph_checkpoint,
              encode(simulation.checksum,'hex') as simulation_checkpoint,
              graph.last_event_sequence::text as graph_checkpoint_sequence,
              simulation.last_event_sequence::text as simulation_checkpoint_sequence
         from world_runtime_heads runtime
         join world_simulation_clocks clock on clock.world_id=runtime.world_id
         join projection_checkpoints graph on graph.world_id=runtime.world_id
          and graph.projection_name='world_graph'
         join projection_checkpoints simulation on simulation.world_id=runtime.world_id
          and simulation.projection_name='simulation_runtime'
        where runtime.world_id=$1`,
      [worldId],
    );
    return result.rows[0]!;
  }

  async function simulationReplayChecksum(worldId: string): Promise<string> {
    const source = await client.pool.query<{ seed: string }>(
      `select version.seed
         from world_runtime_heads runtime
         join world_versions version on version.id=runtime.active_world_version_id
          and version.world_id=runtime.world_id
        where runtime.world_id=$1`,
      [worldId],
    );
    const stored = await client.pool.query<{
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
      [worldId],
    );
    const events = stored.rows.map(
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
    return replaySimulationProjectionV1({
      events,
      worldId,
      worldSeed: source.rows[0]!.seed,
    }).checksum;
  }

  async function recoveryFootprint(
    failureId: string,
    scheduleId: string,
  ): Promise<Record<string, string | null>> {
    const result = await client.pool.query<Record<string, string | null>>(
      `select runtime.state_revision::text,
              runtime.last_event_sequence::text,
              clock.current_tick::text,
              clock.row_version::text clock_row_version,
              clock.mode::text clock_mode,
              encode(clock.outcome_hash,'hex') outcome_hash,
              failure.status::text failure_status,
              failure.resolved_by_actor_id,
              failure.resolution_command_id,
              action.status::text schedule_status,
              action.cancelled_command_id,
              action.completed_state_revision::text,
              graph.last_event_sequence::text graph_sequence,
              simulation.last_event_sequence::text simulation_sequence,
              encode(graph.checksum,'hex') graph_checksum,
              encode(simulation.checksum,'hex') simulation_checksum,
              (select count(*)::text from domain_events where world_id=$1) event_count,
              (select count(*)::text from outbox_messages where world_id=$1) outbox_count,
              (select count(*)::text from simulation_batch_runs where world_id=$1) batch_count
         from world_runtime_heads runtime
         join world_simulation_clocks clock on clock.world_id=runtime.world_id
         join simulation_failures failure on failure.world_id=runtime.world_id
          and failure.id=$2
         join scheduled_actions action on action.world_id=runtime.world_id
          and action.id=$3
         join projection_checkpoints graph on graph.world_id=runtime.world_id
          and graph.projection_name='world_graph'
         join projection_checkpoints simulation on simulation.world_id=runtime.world_id
          and simulation.projection_name='simulation_runtime'
        where runtime.world_id=$1`,
      [worldA.worldId, failureId, scheduleId],
    );
    return result.rows[0]!;
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

  async function login(email: string): Promise<BrowserSession> {
    const response = await app.inject({
      headers: { origin },
      method: 'POST',
      payload: { email, password },
      url: '/api/v1/auth/login',
    });
    expect(response.statusCode, response.body).toBe(200);
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
    creationKey = fallbackSeed,
  ): Promise<ApprovedWorld> {
    const response = await app.inject({
      headers: mutationHeaders(session, `create-${creationKey}`),
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
            set approval_status='approved',approved_by_user_id=$2,
                approved_at=now(),row_version=row_version+1
          where id=$1`,
        [revisionId, session.userId],
      );
      await approval.query(
        `update worlds
            set current_approved_manifest_revision_id=$2,manifest_schema_version=1,
                lifecycle='manifest_approved',row_version=row_version+1,updated_at=now()
          where id=$1`,
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

  async function compileAndActivate(
    world: ApprovedWorld,
    key: string,
    compilationSeed = `${key}-seed`,
  ): Promise<void> {
    const response = await app.inject({
      headers: mutationHeaders(creator, key),
      method: 'POST',
      payload: {
        expectedManifestHash: world.contentHash,
        manifestRevisionId: world.revisionId,
        seed: compilationSeed,
      },
      url: `/api/v1/worlds/${world.worldId}/compilations`,
    });
    expect(response.statusCode, response.body).toBe(202);
    await expect(runWorkerOnce(client.pool)).resolves.toMatchObject({ outcome: 'succeeded' });
    const clock = await readClock(creator, world.worldId);
    expect(clock).toMatchObject({
      aggregateVersion: '1',
      clock: { currentTick: '0', mode: 'paused' },
      stateRevision: '2',
    });
    expect(clock.clock.outcomeHash).toMatch(/^[a-f0-9]{64}$/u);
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
      service: 'm07-api-command-worker-test',
    }),
    { maxEntities: 2_000, maxRelationships: 8_000 },
    { maximumRunsPerReconciliation: 1 },
  );
  return runner.runOne();
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
