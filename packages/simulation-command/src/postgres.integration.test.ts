import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { AdvanceSimulationCommandV1, IdGenerator } from '@worldgraph/contracts';
import {
  applyMigrations,
  createDatabaseClient,
  type DatabaseClient,
  type Pool,
} from '@worldgraph/db';
import { computeDomainEventHashV1, type DomainEventHashInputV1 } from '@worldgraph/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSimulationAdvanceCommand } from './postgres.js';
import type { SimulationAdvanceTelemetryV1 } from './types.js';

const migrationRoot = resolve('packages/db/drizzle');
const creatorId = '078f0000-0000-7000-8000-000000000001';
const worldId = '078f0000-0000-7000-8000-000000000101';
const revisionId = '078f0000-0000-7000-8000-000000000201';
const runId = '078f0000-0000-7000-8000-000000000301';
const versionId = '078f0000-0000-7000-8000-000000000401';
const scheduleId = '078f0000-0000-7000-8000-000000000501';
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const artifactHash = Buffer.alloc(32, 72);
const manifestHash = Buffer.alloc(32, 73);

interface Snapshot {
  aggregate_version: string;
  current_tick: string;
  design_version: string;
  outcome_hash: string;
  state_revision: string;
}

interface Connection {
  query: Pool['query'];
  release(error?: Error): void;
}

async function transaction<T>(pool: Pool, operation: (connection: Connection) => Promise<T>) {
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    const value = await operation(connection);
    await connection.query('commit');
    return value;
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function migrationFolderThrough(lastIndex: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `worldgraph-command-through-${lastIndex}-`));
  await mkdir(join(root, 'meta'));
  const tags = [
    '0001_platform_extensions',
    '0002_platform_metadata',
    '0003_identity_authority',
    '0004_primitive_registry',
    '0005_manifest_studio',
    '0006_deterministic_compiler',
    '0007_command_event_ledger',
  ].slice(0, lastIndex + 1);
  await Promise.all(
    tags.map((tag) => cp(join(migrationRoot, `${tag}.sql`), join(root, `${tag}.sql`))),
  );
  await writeFile(
    join(root, 'meta/_journal.json'),
    JSON.stringify({
      dialect: 'postgresql',
      entries: tags.map((tag, index) => ({
        breakpoints: true,
        idx: index,
        tag,
        version: '7',
        when: 1784635200000 + index * 60_000,
      })),
      version: '7',
    }),
  );
  return root;
}

async function seedPreLedgerActiveWorld(pool: Pool): Promise<void> {
  await transaction(pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into users(id,email,password_hash,display_name)
       values ($1,'simulation-command@example.test',$2,'Simulation Command')`,
      [creatorId, passwordHash],
    );
    await connection.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'simulation-command-world','Simulation Command World',$2)`,
      [worldId, creatorId],
    );
    await connection.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2)`,
      [worldId, creatorId],
    );
    await connection.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,manifest_schema_version,canonical_manifest,
         content_hash,source,created_by_user_id,approval_status,approved_by_user_id,approved_at
       ) values ($1,$2,1,1,$3,$4,'manual',$5,'approved',$5,now())`,
      [
        revisionId,
        worldId,
        { metadata: { key: 'simulation-command-world', name: 'Simulation Command World' } },
        manifestHash,
        creatorId,
      ],
    );
    await connection.query(
      `insert into world_compilation_runs(
         id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
         compiler_version,compiler_config_version,seed,status,stage,progress_percent,
         requested_by_user_id,idempotency_key,artifact_hash,attempts,next_attempt_at,
         claimed_at,heartbeat_at,queued_at,started_at,completed_at,updated_at
       ) values (
         $1,$2,$3,$4,$5,'1.0.0',1,'simulation-command-seed','succeeded','activated',100,
         $6,'simulation-command-genesis',$7,1,now(),now(),now(),now(),now(),now(),now()
       )`,
      [runId, worldId, revisionId, manifestHash, Buffer.alloc(32, 74), creatorId, artifactHash],
    );
    await connection.query(
      `insert into world_versions(
         id,world_id,version_number,manifest_revision_id,compilation_run_id,
         world_schema_version,compiler_version,compiler_config_version,seed,
         artifact_hash,status,created_by_user_id,activated_at
       ) values ($1,$2,1,$3,$4,1,'1.0.0',1,'simulation-command-seed',$5,'active',$6,now())`,
      [versionId, worldId, revisionId, runId, artifactHash, creatorId],
    );
    await connection.query(
      `insert into world_runtime_heads(world_id,active_world_version_id) values ($1,$2)`,
      [worldId, versionId],
    );
    await connection.query(
      `update worlds set lifecycle='active', current_approved_manifest_revision_id=$2,
         manifest_schema_version=1, active_world_version_id=$3, row_version=2, updated_at=now()
       where id=$1`,
      [worldId, revisionId, versionId],
    );
  });
}

async function initializeRunningClock(owner: DatabaseClient): Promise<void> {
  await transaction(owner.pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    const initialization = await connection.query<{ command_id: string; state_revision: string }>(
      `select command.id command_id,runtime.state_revision::text
         from command_records command
         join world_runtime_heads runtime on runtime.world_id=command.world_id
        where command.world_id=$1 and command.command_type='InitializeWorldSimulationV1'`,
      [worldId],
    );
    const row = initialization.rows[0];
    if (!row) throw new Error('simulation initialization is missing');
    await connection.query(
      `update world_simulation_clocks
          set mode='running', wall_cadence_milliseconds=100,
              last_wall_anchor_at=date_trunc('milliseconds',clock_timestamp()-interval '10 seconds')
        where world_id=$1`,
      [worldId],
    );
    const payload = { text: 'A deterministic world notice', visibility: 'public' };
    await connection.query(
      `insert into scheduled_actions(
         id,world_id,schedule_sequence,due_tick,priority,action_type,
         action_schema_version,payload,payload_hash,process_version,status,
         created_by_actor_type,created_by_actor_id,created_command_id,
         created_state_revision,created_at,updated_at
       ) values (
         $1,$2,1,2,0,'EmitWorldNoticeV1',1,$3,
         extensions.digest(convert_to(worldgraph_canonical_jsonb($3),'UTF8'),'sha256'),
         '1.0.0','scheduled','system','worldgraph:simulation-bootstrap',$4,$5::bigint,
         date_trunc('milliseconds',transaction_timestamp()),
         date_trunc('milliseconds',transaction_timestamp())
       )`,
      [scheduleId, worldId, payload, row.command_id, row.state_revision],
    );
    await connection.query(
      `update world_schedule_heads set next_schedule_sequence=2 where world_id=$1`,
      [worldId],
    );
    await connection.query(
      `insert into aggregate_stream_heads(
         world_id,aggregate_type,aggregate_id,current_version,updated_at
       ) values (
         $1,'scheduled_action',$2,1,date_trunc('milliseconds',transaction_timestamp())
       )`,
      [worldId, scheduleId],
    );
    await connection.query(
      `update projection_checkpoints
          set checksum=worldgraph_simulation_projection_checksum($1)
        where world_id=$1 and projection_name='simulation_runtime'`,
      [worldId],
    );
  });
}

async function snapshot(pool: Pool): Promise<Snapshot> {
  const result = await pool.query<Snapshot>(
    `select runtime.state_revision::text,version.version_number::text design_version,
            clock.current_tick::text,encode(clock.outcome_hash,'hex') outcome_hash,
            stream.current_version::text aggregate_version
       from world_runtime_heads runtime
       join world_versions version on version.id=runtime.active_world_version_id
       join world_simulation_clocks clock on clock.world_id=runtime.world_id
       join aggregate_stream_heads stream on stream.world_id=runtime.world_id
        and stream.aggregate_type='simulation_clock'
        and stream.aggregate_id=runtime.world_id::text
      where runtime.world_id=$1`,
    [worldId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('simulation snapshot is missing');
  return row;
}

function command(
  value: Snapshot,
  commandId: string,
  idempotencyKey: string,
  ticks: number,
): AdvanceSimulationCommandV1 {
  return {
    commandId,
    expectedAggregateVersion: value.aggregate_version,
    expectedStateRevision: value.state_revision,
    expectedTick: value.current_tick,
    expectedWorldVersion: value.design_version,
    idempotencyKey,
    payload: { ticks },
    schemaVersion: 1,
    type: 'AdvanceSimulationV1',
  };
}

class SequentialIds implements IdGenerator {
  public constructor(private value = 800) {}

  public next(): string {
    const suffix = String(this.value).padStart(12, '0');
    this.value += 1;
    return `078f0000-0000-7000-8000-${suffix}`;
  }
}

function leaseVerificationSignalingPool(
  pool: Pool,
  verified: () => void,
  connected?: (backendPid: number) => void,
): Pool {
  return {
    async connect() {
      const client = await pool.connect();
      if (connected) {
        const backend = await client.query<{ backend_pid: number }>(
          'select pg_backend_pid() backend_pid',
        );
        connected(backend.rows[0]!.backend_pid);
      }
      let signaled = false;
      return {
        on(event: 'error', listener: (error: Error) => void) {
          client.on(event, listener);
        },
        async query(text: string, values?: readonly unknown[]) {
          const result = await client.query<Record<string, unknown>>(
            text,
            values ? [...values] : undefined,
          );
          if (!signaled && text.includes('worldgraph_simulation_lease_is_current')) {
            signaled = true;
            verified();
          }
          return result;
        },
        release(error?: Error) {
          client.release(error);
        },
        removeListener(event: 'error', listener: (error: Error) => void) {
          client.removeListener(event, listener);
        },
      };
    },
  } as unknown as Pool;
}

interface ReleaseTracker {
  activeConnections: number;
  lastCommittedConnectionId: number | null;
  nextConnectionId: number;
  releasedConnectionIds: Set<number>;
  releases: number;
}

function releaseTrackingPool(pool: Pool, tracker: ReleaseTracker): Pool {
  return {
    async connect() {
      const client = await pool.connect();
      const connectionId = tracker.nextConnectionId;
      tracker.nextConnectionId += 1;
      tracker.activeConnections += 1;
      let released = false;
      return {
        on(event: 'error', listener: (error: Error) => void) {
          client.on(event, listener);
        },
        async query(text: string, values?: readonly unknown[]) {
          const result = await client.query<Record<string, unknown>>(
            text,
            values ? [...values] : undefined,
          );
          if (text === 'commit') tracker.lastCommittedConnectionId = connectionId;
          return result;
        },
        release(error?: Error) {
          if (!released) {
            released = true;
            tracker.activeConnections -= 1;
            tracker.releasedConnectionIds.add(connectionId);
            tracker.releases += 1;
          }
          client.release(error);
        },
        removeListener(event: 'error', listener: (error: Error) => void) {
          client.removeListener(event, listener);
        },
      };
    },
  } as unknown as Pool;
}

function queryMutatingPool(
  pool: Pool,
  mutate: (text: string, values: readonly unknown[]) => unknown[],
): Pool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        on(event: 'error', listener: (error: Error) => void) {
          client.on(event, listener);
        },
        async query(text: string, values?: readonly unknown[]) {
          return client.query<Record<string, unknown>>(
            text,
            values ? mutate(text, values) : undefined,
          );
        },
        release(error?: Error) {
          client.release(error);
        },
        removeListener(event: 'error', listener: (error: Error) => void) {
          client.removeListener(event, listener);
        },
      };
    },
  } as unknown as Pool;
}

function addSimulationAdvancePayloadKey(text: string, values: readonly unknown[]): unknown[] {
  const changed = [...values];
  if (!text.includes('insert into domain_events') || values[8] !== 'SimulationAdvancedV1') {
    return changed;
  }
  const payload = { ...(JSON.parse(String(values[10])) as Record<string, unknown>), forged: true };
  const metadata = JSON.parse(String(values[11])) as DomainEventHashInputV1['metadata'];
  const recordedAt = (values[13] as Date).toISOString();
  const event = {
    aggregateId: String(values[6]),
    aggregateType: String(values[5]),
    aggregateVersion: String(values[7]),
    commandId: String(values[3]),
    eventId: String(values[0]),
    eventOrdinal: Number(values[4]),
    eventSchemaVersion: Number(values[9]),
    eventType: String(values[8]),
    metadata,
    occurredAt: recordedAt,
    payload,
    recordedAt,
    resultingStateRevision: String(values[14]),
    worldEventSequence: String(values[2]),
    worldId: String(values[1]),
  } as unknown as DomainEventHashInputV1;
  changed[10] = JSON.stringify(payload);
  changed[12] = Buffer.from(computeDomainEventHashV1(event), 'hex');
  return changed;
}

function replaceAdvanceCommandPayloadHash(text: string, values: readonly unknown[]): unknown[] {
  const changed = [...values];
  if (text.includes('insert into command_records') && text.includes("'AdvanceSimulationV1'")) {
    changed[4] = Buffer.alloc(32, 0);
  }
  return changed;
}

function deterministicMigrationId(kind: 'command'): string {
  const hex = createHash('sha256')
    .update(`worldgraph:m07:simulation-init:${kind}:${worldId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

describe('PostgreSQL simulation advance command', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;
  let app: DatabaseClient;
  let throughCompilerRoot: string;
  let throughLedgerRoot: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'simulation-command-owner-test');
    throughCompilerRoot = await migrationFolderThrough(5);
    throughLedgerRoot = await migrationFolderThrough(6);
    await applyMigrations(owner, throughCompilerRoot);
    await seedPreLedgerActiveWorld(owner.pool);
    await applyMigrations(owner, throughLedgerRoot);
    await applyMigrations(owner, migrationRoot);
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    app = createDatabaseClient(appUrl.toString(), 'simulation-command-app-test');
    await initializeRunningClock(owner);
  });

  afterAll(async () => {
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
    if (throughCompilerRoot) await rm(throughCompilerRoot, { force: true, recursive: true });
    if (throughLedgerRoot) await rm(throughLedgerRoot, { force: true, recursive: true });
  });

  it('advances atomically, fences a concurrent stale worker, replays, and auto-pauses', async () => {
    const leaseOwner = 'simulation-command-worker-a';
    const acquired = await app.pool.query<{ fencing_token: string }>(
      `select fencing_token::text from worldgraph_acquire_simulation_lease($1,$2,60000)`,
      [worldId, leaseOwner],
    );
    const leaseFencingToken = acquired.rows[0]?.fencing_token;
    expect(leaseFencingToken).toBe('1');
    const observedAdvances: SimulationAdvanceTelemetryV1[] = [];
    const observerConnectionCounts: number[] = [];
    const observerConnectionsReleased: boolean[] = [];
    const poolTracker: ReleaseTracker = {
      activeConnections: 0,
      lastCommittedConnectionId: null,
      nextConnectionId: 1,
      releasedConnectionIds: new Set(),
      releases: 0,
    };
    const port = new PostgresSimulationAdvanceCommand(releaseTrackingPool(app.pool, poolTracker), {
      ids: new SequentialIds(),
      observer: {
        onAdvanceCommitted(summary) {
          observedAdvances.push(summary);
          observerConnectionCounts.push(poolTracker.activeConnections);
          observerConnectionsReleased.push(
            poolTracker.lastCommittedConnectionId !== null &&
              poolTracker.releasedConnectionIds.has(poolTracker.lastCommittedConnectionId),
          );
          if (observedAdvances.length === 1) throw new Error('best-effort observer failure');
          if (observedAdvances.length === 2) {
            return Promise.reject(new Error('best-effort asynchronous observer failure'));
          }
        },
      },
      retryDelay: async () => undefined,
    });

    const initial = await snapshot(app.pool);
    expect(initial.current_tick).toBe('0');
    expect(initial.outcome_hash).toMatch(/^[a-f0-9]{64}$/u);
    const forgedHashCommand = command(
      initial,
      '078f0000-0000-7000-8000-000000000599',
      'simulation-command-forged-payload-hash',
      1,
    );
    const forgedHashPort = new PostgresSimulationAdvanceCommand(
      queryMutatingPool(app.pool, replaceAdvanceCommandPayloadHash),
      { ids: new SequentialIds(40_000), retryDelay: async () => undefined },
    );
    await expect(
      forgedHashPort.advance({
        command: forgedHashCommand,
        leaseFencingToken: leaseFencingToken!,
        leaseOwner,
        worldId,
      }),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await snapshot(app.pool)).toEqual(initial);

    const forgedPayloadCommand = command(
      initial,
      '078f0000-0000-7000-8000-000000000600',
      'simulation-command-forged-event-payload',
      1,
    );
    const forgedPayloadPort = new PostgresSimulationAdvanceCommand(
      queryMutatingPool(app.pool, addSimulationAdvancePayloadKey),
      { ids: new SequentialIds(50_000), retryDelay: async () => undefined },
    );
    await expect(
      forgedPayloadPort.advance({
        command: forgedPayloadCommand,
        leaseFencingToken: leaseFencingToken!,
        leaseOwner,
        worldId,
      }),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await snapshot(app.pool)).toEqual(initial);
    await expect(
      owner.pool.query(`select count(*)::text count from command_records where id=$1`, [
        forgedPayloadCommand.commandId,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] });

    const firstCommand = command(
      initial,
      '078f0000-0000-7000-8000-000000000601',
      'simulation-command-first',
      3,
    );
    const firstRequest = {
      command: firstCommand,
      leaseFencingToken: leaseFencingToken!,
      leaseOwner,
      worldId,
    };
    await expect(port.advance(firstRequest)).resolves.toEqual({
      resultingTick: '3',
      status: 'advanced',
    });
    expect(observedAdvances).toEqual([
      {
        executions: [
          {
            eventCount: 1,
            processType: 'EmitWorldNoticeV1',
            processVersion: '1.0.0',
            proposedScheduleCount: 0,
            tick: '2',
          },
        ],
        fromTick: '0',
        tickCount: 3,
        toTick: '3',
      },
    ]);
    expect(observerConnectionCounts).toEqual([0]);
    expect(observerConnectionsReleased).toEqual([true]);
    expect(poolTracker.activeConnections).toBe(0);

    const firstEvents = await owner.pool.query<{
      aggregate_type: string;
      aggregate_version: string;
      event_ordinal: number;
      event_type: string;
      resulting_state_revision: string;
    }>(
      `select aggregate_type,aggregate_version::text,event_ordinal,event_type,
              resulting_state_revision::text
         from domain_events where command_id=$1 order by event_ordinal`,
      [firstCommand.commandId],
    );
    expect(firstEvents.rows.map(({ event_type }) => event_type)).toEqual([
      'SimulationAdvancedV1',
      'ScheduledActionExecutedV1',
      'WorldNoticeEmittedV1',
    ]);
    expect(firstEvents.rows[0]).toMatchObject({
      aggregate_type: 'simulation_clock',
      aggregate_version: (BigInt(initial.aggregate_version) + 1n).toString(10),
      event_ordinal: 0,
      resulting_state_revision: (BigInt(initial.state_revision) + 1n).toString(10),
    });
    expect(
      new Set(firstEvents.rows.map(({ resulting_state_revision }) => resulting_state_revision)),
    ).toEqual(new Set([(BigInt(initial.state_revision) + 1n).toString(10)]));
    const firstPersisted = await owner.pool.query<{
      batch_outcome_hash: string;
      clock_outcome_hash: string;
      command_status: string;
      current_tick: string;
      outbox_count: string;
      schedule_status: string;
      simulation_checksum_matches: boolean;
    }>(
      `select clock.current_tick::text,encode(clock.outcome_hash,'hex') clock_outcome_hash,
              action.status::text schedule_status,command.status::text command_status,
              encode(batch.outcome_hash,'hex') batch_outcome_hash,
              checkpoint.checksum=worldgraph_simulation_projection_checksum($1)
                simulation_checksum_matches,
              (select count(*)::text from outbox_messages message
                join domain_events event on event.id=message.event_id
               where event.command_id=$2) outbox_count
         from world_simulation_clocks clock
         join scheduled_actions action on action.world_id=clock.world_id and action.id=$3
         join command_records command on command.world_id=clock.world_id and command.id=$2
         join simulation_batch_runs batch
           on batch.world_id=clock.world_id and batch.command_id=command.id
         join projection_checkpoints checkpoint on checkpoint.world_id=clock.world_id
          and checkpoint.projection_name='simulation_runtime'
        where clock.world_id=$1`,
      [worldId, firstCommand.commandId, scheduleId],
    );
    expect(firstPersisted.rows[0]).toMatchObject({
      batch_outcome_hash: firstPersisted.rows[0]?.clock_outcome_hash,
      command_status: 'accepted',
      current_tick: '3',
      outbox_count: '3',
      schedule_status: 'completed',
      simulation_checksum_matches: true,
    });
    expect(firstPersisted.rows[0]?.clock_outcome_hash).not.toBe(initial.outcome_hash);
    await expect(
      owner.pool.query(`select worldgraph_assert_simulation_command_terminal($1)`, [
        firstCommand.commandId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });

    const countBeforeReplay = await owner.pool.query<{ commands: string; events: string }>(
      `select (select count(*)::text from command_records where world_id=$1) commands,
              (select count(*)::text from domain_events where world_id=$1) events`,
      [worldId],
    );
    await expect(
      port.advance({ ...firstRequest, leaseFencingToken: '999', leaseOwner: 'stale-worker' }),
    ).resolves.toEqual({ resultingTick: '3', status: 'advanced' });
    expect(observedAdvances).toHaveLength(1);
    const countAfterReplay = await owner.pool.query<{ commands: string; events: string }>(
      `select (select count(*)::text from command_records where world_id=$1) commands,
              (select count(*)::text from domain_events where world_id=$1) events`,
      [worldId],
    );
    expect(countAfterReplay.rows[0]).toEqual(countBeforeReplay.rows[0]);

    const beforeRace = await snapshot(app.pool);
    const winningCommand = command(
      beforeRace,
      '078f0000-0000-7000-8000-000000000602',
      'simulation-command-race-winner',
      1,
    );
    const staleCommand = command(
      beforeRace,
      '078f0000-0000-7000-8000-000000000603',
      'simulation-command-race-stale',
      1,
    );
    const [winning, fenced] = await Promise.all([
      port.advance({
        command: winningCommand,
        leaseFencingToken: leaseFencingToken!,
        leaseOwner,
        worldId,
      }),
      port.advance({
        command: staleCommand,
        leaseFencingToken: leaseFencingToken!,
        leaseOwner: 'simulation-command-worker-b',
        worldId,
      }),
    ]);
    expect(winning).toEqual({ resultingTick: '4', status: 'advanced' });
    expect(fenced).toEqual({ status: 'fenced' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observedAdvances).toHaveLength(2);
    expect(observerConnectionsReleased).toEqual([true, true]);
    expect(poolTracker.activeConnections).toBe(0);
    const afterRace = await snapshot(app.pool);
    expect(afterRace.current_tick).toBe('4');
    expect(afterRace.state_revision).toBe((BigInt(beforeRace.state_revision) + 1n).toString(10));
    await expect(
      owner.pool.query(`select count(*)::text count from command_records where id=$1`, [
        staleCommand.commandId,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] });

    await expect(
      app.pool.query(`select worldgraph_release_simulation_lease($1,$2,$3::bigint) released`, [
        worldId,
        leaseOwner,
        leaseFencingToken,
      ]),
    ).resolves.toMatchObject({ rows: [{ released: true }] });

    const contenderOwners = Array.from(
      { length: 10 },
      (_, index) => `simulation-command-contender-${index + 1}`,
    );
    const contenderLeases = await Promise.all(
      contenderOwners.map(async (contenderOwner) => ({
        contenderOwner,
        result: await app.pool.query<{ fencing_token: string; leased_until: Date }>(
          `select fencing_token::text,leased_until
             from worldgraph_acquire_simulation_lease($1,$2,60000)`,
          [worldId, contenderOwner],
        ),
      })),
    );
    const tenWorkerWinner = contenderLeases.find(({ result }) => result.rowCount === 1);
    expect(contenderLeases.filter(({ result }) => result.rowCount === 1)).toHaveLength(1);
    expect(tenWorkerWinner?.result.rows[0]?.fencing_token).toBe('2');
    if (!tenWorkerWinner) throw new Error('ten-worker lease race had no winner');
    const tenWorkerCommands = contenderOwners.map((_, index) =>
      command(
        afterRace,
        `078f0000-0000-7000-8000-${String(700 + index).padStart(12, '0')}`,
        `simulation-command-ten-worker-${index + 1}`,
        1,
      ),
    );
    const tenWorkerResults = await Promise.all(
      contenderOwners.map((contenderOwner, index) =>
        port.advance({
          command: tenWorkerCommands[index]!,
          leaseFencingToken: tenWorkerWinner.result.rows[0]!.fencing_token,
          leaseOwner: contenderOwner,
          worldId,
        }),
      ),
    );
    expect(tenWorkerResults.filter(({ status }) => status === 'advanced')).toEqual([
      { resultingTick: '5', status: 'advanced' },
    ]);
    expect(tenWorkerResults.filter(({ status }) => status === 'fenced')).toHaveLength(9);
    const afterTenWorkers = await snapshot(app.pool);
    expect(afterTenWorkers.current_tick).toBe('5');
    expect(afterTenWorkers.state_revision).toBe(
      (BigInt(afterRace.state_revision) + 1n).toString(10),
    );
    await expect(
      owner.pool.query<{ accepted: string; commands: string }>(
        `select count(*)::text commands,
                count(*) filter (where status='accepted')::text accepted
           from command_records where id=any($1::uuid[])`,
        [tenWorkerCommands.map(({ commandId }) => commandId)],
      ),
    ).resolves.toMatchObject({ rows: [{ accepted: '1', commands: '1' }] });
    await expect(
      app.pool.query(`select worldgraph_release_simulation_lease($1,$2,$3::bigint) released`, [
        worldId,
        tenWorkerWinner.contenderOwner,
        tenWorkerWinner.result.rows[0]!.fencing_token,
      ]),
    ).resolves.toMatchObject({ rows: [{ released: true }] });

    const expiringLeaseOwner = 'simulation-command-expiring-worker';
    const expiringLease = await app.pool.query<{
      fencing_token: string;
      leased_until: Date;
    }>(
      `select fencing_token::text,leased_until
         from worldgraph_acquire_simulation_lease($1,$2,1000)`,
      [worldId, expiringLeaseOwner],
    );
    expect(expiringLease.rows[0]?.fencing_token).toBe('3');
    const blocker = await owner.pool.connect();
    let blockerReleased = false;
    const expiringCommand = command(
      afterTenWorkers,
      '078f0000-0000-7000-8000-000000000605',
      'simulation-command-expiring-lease',
      1,
    );
    let signalVerified!: () => void;
    const leaseVerified = new Promise<void>((resolve) => {
      signalVerified = resolve;
    });
    const expiringPort = new PostgresSimulationAdvanceCommand(
      leaseVerificationSignalingPool(app.pool, signalVerified),
      { ids: new SequentialIds(2_000), retryDelay: async () => undefined },
    );
    try {
      await blocker.query('begin');
      await blocker.query(
        `select world_id from world_simulation_clocks where world_id=$1 for update`,
        [worldId],
      );
      const expiringAdvance = expiringPort.advance({
        command: expiringCommand,
        leaseFencingToken: expiringLease.rows[0]!.fencing_token,
        leaseOwner: expiringLeaseOwner,
        worldId,
      });
      await leaseVerified;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, expiringLease.rows[0]!.leased_until.getTime() - Date.now() + 25),
        ),
      );

      const successorLeaseOwner = 'simulation-command-successor-worker';
      const successorLease = app.pool.query<{ fencing_token: string; leased_until: Date }>(
        `select fencing_token::text,leased_until
           from worldgraph_acquire_simulation_lease($1,$2,60000)`,
        [worldId, successorLeaseOwner],
      );
      await expect(
        Promise.race([
          successorLease.then(() => 'issued'),
          new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
        ]),
      ).resolves.toBe('blocked');

      await blocker.query('commit');
      blockerReleased = true;
      await expect(expiringAdvance).resolves.toEqual({ status: 'fenced' });
      const successor = await successorLease;
      expect(successor.rows[0]?.fencing_token).toBe('4');
      await expect(
        port.advance({
          command: expiringCommand,
          leaseFencingToken: expiringLease.rows[0]!.fencing_token,
          leaseOwner: expiringLeaseOwner,
          worldId,
        }),
      ).resolves.toEqual({ status: 'fenced' });
      expect(await snapshot(app.pool)).toEqual(afterTenWorkers);
      await expect(
        owner.pool.query(`select count(*)::text count from command_records where id=$1`, [
          expiringCommand.commandId,
        ]),
      ).resolves.toMatchObject({ rows: [{ count: '0' }] });

      await expect(
        app.pool.query(`select worldgraph_release_simulation_lease($1,$2,$3::bigint) released`, [
          worldId,
          successorLeaseOwner,
          successor.rows[0]!.fencing_token,
        ]),
      ).resolves.toMatchObject({ rows: [{ released: true }] });

      const crashLeaseOwner = 'simulation-command-crash-before-worker';
      const crashLease = await app.pool.query<{ fencing_token: string; leased_until: Date }>(
        `select fencing_token::text,leased_until
           from worldgraph_acquire_simulation_lease($1,$2,1000)`,
        [worldId, crashLeaseOwner],
      );
      expect(crashLease.rows[0]?.fencing_token).toBe('5');
      const crashCommand = command(
        afterTenWorkers,
        '078f0000-0000-7000-8000-000000000606',
        'simulation-command-crash-boundary',
        1,
      );
      const crashBlocker = await owner.pool.connect();
      let crashBlockerReleased = false;
      let crashBackendPid = 0;
      let signalCrashVerified!: () => void;
      const crashLeaseVerified = new Promise<void>((resolve) => {
        signalCrashVerified = resolve;
      });
      const crashingPort = new PostgresSimulationAdvanceCommand(
        leaseVerificationSignalingPool(app.pool, signalCrashVerified, (backendPid) => {
          crashBackendPid = backendPid;
        }),
        { ids: new SequentialIds(3_000), retryDelay: async () => undefined },
      );
      try {
        await crashBlocker.query('begin');
        await crashBlocker.query(
          `select world_id from world_simulation_clocks where world_id=$1 for update`,
          [worldId],
        );
        const crashingAdvance = crashingPort.advance({
          command: crashCommand,
          leaseFencingToken: crashLease.rows[0]!.fencing_token,
          leaseOwner: crashLeaseOwner,
          worldId,
        });
        const crashRejected = expect(crashingAdvance).rejects.toBeDefined();
        await crashLeaseVerified;
        expect(crashBackendPid).toBeGreaterThan(0);
        await expect(
          owner.pool.query<{ terminated: boolean }>('select pg_terminate_backend($1) terminated', [
            crashBackendPid,
          ]),
        ).resolves.toMatchObject({ rows: [{ terminated: true }] });
        await crashRejected;
        await crashBlocker.query('rollback');
        crashBlockerReleased = true;
      } finally {
        if (!crashBlockerReleased) {
          await crashBlocker.query('rollback').catch(() => undefined);
        }
        crashBlocker.release();
      }
      expect(await snapshot(app.pool)).toEqual(afterTenWorkers);
      await expect(
        owner.pool.query(`select count(*)::text count from command_records where id=$1`, [
          crashCommand.commandId,
        ]),
      ).resolves.toMatchObject({ rows: [{ count: '0' }] });

      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, crashLease.rows[0]!.leased_until.getTime() - Date.now() + 25),
        ),
      );
      const crashRecoveryOwner = 'simulation-command-crash-recovery-worker';
      const crashRecoveryLease = await app.pool.query<{
        fencing_token: string;
        leased_until: Date;
      }>(
        `select fencing_token::text,leased_until
           from worldgraph_acquire_simulation_lease($1,$2,1000)`,
        [worldId, crashRecoveryOwner],
      );
      expect(crashRecoveryLease.rows[0]?.fencing_token).toBe('6');
      const committedAfterCrash = await port.advance({
        command: crashCommand,
        leaseFencingToken: crashRecoveryLease.rows[0]!.fencing_token,
        leaseOwner: crashRecoveryOwner,
        worldId,
      });
      expect(committedAfterCrash).toEqual({ resultingTick: '6', status: 'advanced' });
      const committedFootprint = await owner.pool.query<{
        commands: string;
        events: string;
        state_revision: string;
      }>(
        `select (select count(*)::text from command_records where id=$1) commands,
                (select count(*)::text from domain_events where command_id=$1) events,
                (select state_revision::text from world_runtime_heads where world_id=$2)
                  state_revision`,
        [crashCommand.commandId, worldId],
      );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, crashRecoveryLease.rows[0]!.leased_until.getTime() - Date.now() + 25),
        ),
      );
      const postCommitOwner = 'simulation-command-post-commit-worker';
      const postCommitLease = await app.pool.query<{ fencing_token: string }>(
        `select fencing_token::text
           from worldgraph_acquire_simulation_lease($1,$2,60000)`,
        [worldId, postCommitOwner],
      );
      expect(postCommitLease.rows[0]?.fencing_token).toBe('7');
      await expect(
        port.advance({
          command: crashCommand,
          leaseFencingToken: postCommitLease.rows[0]!.fencing_token,
          leaseOwner: postCommitOwner,
          worldId,
        }),
      ).resolves.toEqual(committedAfterCrash);
      await expect(
        owner.pool.query<{
          commands: string;
          events: string;
          state_revision: string;
        }>(
          `select (select count(*)::text from command_records where id=$1) commands,
                  (select count(*)::text from domain_events where command_id=$1) events,
                  (select state_revision::text from world_runtime_heads where world_id=$2)
                    state_revision`,
          [crashCommand.commandId, worldId],
        ),
      ).resolves.toMatchObject({ rows: committedFootprint.rows });
      const afterCrashRecovery = await snapshot(app.pool);

      const failedCommand = command(
        afterCrashRecovery,
        '078f0000-0000-7000-8000-000000000604',
        'simulation-command-terminal-failure',
        1,
      );
      const autoPauseRequest = {
        attempts: 3,
        failedCommand,
        failure: {
          errorCode: 'SIMULATION_INTEGER_OVERFLOW',
          processType: 'WorldClockV1' as const,
          processVersion: '1.0.0' as const,
          scheduleId: null,
          tick: (BigInt(afterCrashRecovery.current_tick) + 1n).toString(10),
        },
        leaseFencingToken: postCommitLease.rows[0]!.fencing_token,
        leaseOwner: postCommitOwner,
        worldId,
      };
      const autoPaused = await port.recordFailureAndAutoPause(autoPauseRequest);
      expect(autoPaused.status).toBe('auto_paused');
      if (autoPaused.status !== 'auto_paused') throw new Error('auto-pause was not accepted');

      const terminal = await owner.pool.query<{
        attempts: number;
        batch_status: string;
        causation_ids: string[];
        clock_outcome_hash: string;
        command_id: string;
        command_status: string;
        error_code: string;
        event_types: string[];
        failure_id: string;
        failure_status: string;
        mode: string;
        revision_count: string;
        state_revision: string;
      }>(
        `select command.id command_id,command.status::text command_status,
              clock.mode::text,encode(clock.outcome_hash,'hex') clock_outcome_hash,
              runtime.state_revision::text,failure.id::text failure_id,
              failure.status::text failure_status,failure.error_code,failure.attempts,
              batch.status::text batch_status,
              array_agg(event.event_type order by event.event_ordinal) event_types,
              array_agg(event.metadata->>'causationId' order by event.event_ordinal)
                causation_ids,
              count(distinct event.resulting_state_revision)::text revision_count
         from command_records command
         join world_simulation_clocks clock on clock.world_id=command.world_id
         join world_runtime_heads runtime on runtime.world_id=command.world_id
         join simulation_failures failure on failure.world_id=command.world_id
         join simulation_batch_runs batch on batch.id=failure.batch_run_id
         join domain_events event on event.command_id=command.id
        where command.world_id=$1 and command.command_type='AutoPauseWorldClockV1'
        group by command.id,clock.world_id,runtime.world_id,failure.id,batch.id`,
        [worldId],
      );
      expect(terminal.rows[0]).toMatchObject({
        attempts: 3,
        batch_status: 'failed',
        causation_ids: [failedCommand.commandId, failedCommand.commandId],
        clock_outcome_hash: afterCrashRecovery.outcome_hash,
        command_status: 'accepted',
        error_code: 'SIMULATION_INTEGER_OVERFLOW',
        event_types: ['WorldClockAutoPausedV1', 'SimulationFailureRecordedV1'],
        failure_id: autoPaused.failureId,
        failure_status: 'open',
        mode: 'error',
        revision_count: '1',
        state_revision: (BigInt(afterCrashRecovery.state_revision) + 1n).toString(10),
      });
      await expect(
        owner.pool.query(`select worldgraph_assert_simulation_command_terminal($1)`, [
          terminal.rows[0]!.command_id,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        port.recordFailureAndAutoPause({
          ...autoPauseRequest,
          leaseFencingToken: '999',
          leaseOwner: 'stale-worker',
        }),
      ).resolves.toEqual({ failureId: autoPaused.failureId, status: 'auto_paused' });
      expect(deterministicMigrationId('command')).not.toBe(terminal.rows[0]?.command_id);
    } finally {
      if (!blockerReleased) await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
  });
});
