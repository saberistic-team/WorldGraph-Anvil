import { createHash } from 'node:crypto';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  EMIT_WORLD_NOTICE_PROCESS_VERSION,
  LEDGER_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  SIMULATION_BATCH_SCHEMA_VERSION,
  SIMULATION_CLOCK_SCHEMA_VERSION,
  SIMULATION_FAILURE_SCHEMA_VERSION,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  SIMULATION_PROCESS_REGISTRY_VERSION,
  SIMULATION_PROJECTION_SCHEMA_VERSION,
  SIMULATION_SCHEDULE_SCHEMA_VERSION,
  WORLD_CLOCK_FAILURE_SOURCE_TYPE,
  WORLD_CLOCK_FAILURE_SOURCE_VERSION,
  AdvanceSimulationCommandV1Schema,
  ScheduledActionV1Schema,
  WorldCommandResultV1Schema,
  canonicalJson,
  createValidator,
  type AdvanceSimulationCommandV1,
  type DomainEventMetadataV1,
  type LedgerActorV1,
  type LedgerEntryV1,
  type ScheduledActionV1,
  type SimulationEventV1,
  type Validator,
  type WorldCommandResultV1,
  type WorldSimulationClockV1,
} from '@worldgraph/contracts';
import type { Pool } from '@worldgraph/db';
import {
  LEDGER_GENESIS_PREVIOUS_HASH,
  computeDomainEventHashV1,
  computeLedgerEntryHashV1,
  type DomainEventHashInputV1,
  type LedgerEntryHashInputV1,
} from '@worldgraph/ledger';

import { planSimulationAdvanceV1, type SimulationAdvancePlanV1 } from './planner.js';
import {
  SIMULATION_WORKER_ACTOR_ID,
  SIMULATION_WORKER_AUTHORIZATION_RULE_ID,
  type FencedSimulationAdvanceRequest,
  type FencedSimulationAdvanceResult,
  type FencedSimulationAutoPauseRequest,
  type FencedSimulationAutoPauseResult,
  type PostgresSimulationAdvanceCommandOptions,
  type SimulationAdvanceTelemetryV1,
  type SimulationAdvanceCommandPort,
} from './types.js';

interface Client {
  on?(event: 'error', listener: (error: Error) => void): void;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
  removeListener?(event: 'error', listener: (error: Error) => void): void;
  release(error?: Error): void;
}
type AcceptedCommandResult = Extract<WorldCommandResultV1, { status: 'accepted' }>;

interface LeaseRow {
  fencing_token: string;
  is_current: boolean;
  lease_owner: string;
  leased_until: Date;
}

interface StoredCommandRow {
  actor_id: string | null;
  actor_type: string;
  command_type: string;
  id: string;
  idempotency_key: string;
  request_hash: Buffer;
  response_summary: unknown;
  status: string;
  world_id: string;
}

interface SimulationContextRow {
  active_world_version_id: string;
  aggregate_version: string;
  anchor_artifact_hash: Buffer | null;
  archived_at: Date | null;
  clock_schema_version: number;
  current_tick: string;
  design_version: string;
  due_ticks: string;
  epoch_at: Date;
  graph_checkpoint_checksum: Buffer;
  graph_checkpoint_event_sequence: string;
  graph_checkpoint_status: string;
  last_event_sequence: string;
  last_ledger_sequence: string;
  last_wall_anchor_at: Date | null;
  ledger_anchored_at: Date | null;
  lifecycle: string;
  max_batch_ticks: number;
  max_catch_up_ticks: number;
  mode: 'error' | 'paused' | 'running';
  outcome_hash: Buffer;
  prng_algorithm_version: string;
  recorded_at: Date;
  row_version: string;
  simulation_checkpoint_checksum: Buffer;
  simulation_computed_checksum: Buffer;
  simulation_checkpoint_event_sequence: string;
  simulation_checkpoint_schema_version: number;
  simulation_checkpoint_status: string;
  state_revision: string;
  updated_at: Date;
  updated_state_revision: string;
  wall_cadence_milliseconds: number;
  world_id: string;
  world_milliseconds_per_tick: string;
  world_seed: string;
}

interface ScheduledActionRow {
  action_schema_version: number;
  action_type: ScheduledActionV1['actionType'];
  cancelled_command_id: string | null;
  completed_event_id: string | null;
  completed_state_revision: string | null;
  created_at: Date;
  created_by_actor_id: string;
  created_by_actor_type: 'platform_admin' | 'system' | 'user';
  created_command_id: string;
  created_state_revision: string;
  due_tick: string;
  id: string;
  payload: ScheduledActionV1['payload'];
  payload_hash: Buffer;
  priority: number;
  process_version: ScheduledActionV1['processVersion'];
  schedule_sequence: string;
  status: ScheduledActionV1['status'];
  updated_at: Date;
  world_id: string;
}

interface AllocationRow {
  last_entry_hash: Buffer | null;
  next_event_sequence: string;
  next_ledger_sequence: string;
}

interface PlannedEvent {
  aggregateId: string;
  aggregateType: 'scheduled_action' | 'simulation_clock' | 'simulation_failure' | 'world_notice';
  eventId: string;
  eventType: SimulationEventV1['eventType'];
  payload: SimulationEventV1['payload'];
}

interface PersistedEvent {
  event: DomainEventHashInputV1;
  eventHash: string;
}

interface TransactionResolution {
  commit: boolean;
  result: FencedSimulationAdvanceResult;
  telemetry?: SimulationAdvanceTelemetryV1;
}

interface AutoPauseTransactionResolution {
  commit: boolean;
  result: FencedSimulationAutoPauseResult;
}

interface AutoPauseIdentity {
  batchId: string;
  commandId: string;
  failureId: string;
  idempotencyKey: string;
  payload: { errorCode: string; failureId: string };
  payloadHash: Buffer;
  requestHash: Buffer;
}

interface PersistenceCommand {
  causationId: string | null;
  commandId: string;
  commandType: 'AdvanceSimulationV1' | 'AutoPauseWorldClockV1';
  worldId: string;
}

const advanceValidator: Validator<AdvanceSimulationCommandV1> =
  createValidator<AdvanceSimulationCommandV1>(AdvanceSimulationCommandV1Schema);
const commandResultValidator: Validator<WorldCommandResultV1> =
  createValidator<WorldCommandResultV1>(WorldCommandResultV1Schema);
const scheduledActionValidator: Validator<ScheduledActionV1> =
  createValidator<ScheduledActionV1>(ScheduledActionV1Schema);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEASE_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const POSITIVE_INT64_PATTERN = /^[1-9][0-9]{0,18}$/u;
const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n;

export function simulationAdvanceRequestHashV1(
  worldId: string,
  command: AdvanceSimulationCommandV1,
): Buffer {
  return sha256({
    expectedAggregateVersion: command.expectedAggregateVersion,
    expectedStateRevision: command.expectedStateRevision,
    expectedTick: command.expectedTick,
    expectedWorldVersion: command.expectedWorldVersion,
    payload: command.payload,
    schemaVersion: command.schemaVersion,
    type: command.type,
    worldId,
  });
}

/** PostgreSQL implementation of the worker's narrow, fenced command boundary. */
export class PostgresSimulationAdvanceCommand implements SimulationAdvanceCommandPort {
  private readonly maximumSerializationAttempts: number;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  public constructor(
    private readonly pool: Pool,
    private readonly options: PostgresSimulationAdvanceCommandOptions,
  ) {
    this.maximumSerializationAttempts = options.maximumSerializationAttempts ?? 3;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    if (
      !Number.isSafeInteger(this.maximumSerializationAttempts) ||
      this.maximumSerializationAttempts < 1 ||
      this.maximumSerializationAttempts > 5
    ) {
      throw new Error('SIMULATION_COMMAND_CONFIGURATION_INVALID');
    }
  }

  public async advance(
    request: FencedSimulationAdvanceRequest,
  ): Promise<FencedSimulationAdvanceResult> {
    assertAdvanceRequest(request);
    const payloadHash = sha256(request.command.payload);
    const requestHash = simulationAdvanceRequestHashV1(request.worldId, request.command);

    for (let attempt = 0; attempt < this.maximumSerializationAttempts; attempt += 1) {
      const client = (await this.pool.connect()) as unknown as Client;
      let completed: TransactionResolution | undefined;
      let releaseError: Error | undefined;
      const recordConnectionError = (error: Error): void => {
        releaseError ??= error;
      };
      client.on?.('error', recordConnectionError);
      try {
        await client.query('begin isolation level serializable');
        const resolution = await this.advanceTransaction(client, request, payloadHash, requestHash);
        await client.query(resolution.commit ? 'commit' : 'rollback');
        completed = resolution;
      } catch (error) {
        releaseError ??= fatalConnectionError(error);
        if (!releaseError) {
          try {
            await client.query('rollback');
          } catch (rollbackError) {
            releaseError = fatalConnectionError(rollbackError) ?? asError(rollbackError);
          }
        }
        if (isRetryableTransactionError(error) && attempt + 1 < this.maximumSerializationAttempts) {
          await this.retryDelay(attempt);
          continue;
        }
        throw error;
      } finally {
        client.removeListener?.('error', recordConnectionError);
        client.release(releaseError);
      }
      if (!completed) continue;
      if (completed.commit && completed.telemetry) {
        this.notifyAdvanceCommitted(completed.telemetry);
      }
      return completed.result;
    }
    throw Object.assign(new Error('Simulation command serialization retries exhausted.'), {
      code: 'SERIALIZATION_FAILURE',
    });
  }

  private notifyAdvanceCommitted(summary: SimulationAdvanceTelemetryV1): void {
    try {
      const notification = this.options.observer?.onAdvanceCommitted(summary);
      if (notification) void notification.catch(() => undefined);
    } catch {
      // Authority is committed and the checked-out client is released. Telemetry is best-effort.
    }
  }

  public async recordFailureAndAutoPause(
    request: FencedSimulationAutoPauseRequest,
  ): Promise<FencedSimulationAutoPauseResult> {
    assertAutoPauseRequest(request);
    const identity = autoPauseIdentity(request);
    for (let attempt = 0; attempt < this.maximumSerializationAttempts; attempt += 1) {
      const client = (await this.pool.connect()) as unknown as Client;
      let releaseError: Error | undefined;
      const recordConnectionError = (error: Error): void => {
        releaseError ??= error;
      };
      client.on?.('error', recordConnectionError);
      try {
        await client.query('begin isolation level serializable');
        const resolution = await this.autoPauseTransaction(client, request, identity);
        await client.query(resolution.commit ? 'commit' : 'rollback');
        return resolution.result;
      } catch (error) {
        releaseError ??= fatalConnectionError(error);
        if (!releaseError) {
          try {
            await client.query('rollback');
          } catch (rollbackError) {
            releaseError = fatalConnectionError(rollbackError) ?? asError(rollbackError);
          }
        }
        if (isRetryableTransactionError(error) && attempt + 1 < this.maximumSerializationAttempts) {
          await this.retryDelay(attempt);
          continue;
        }
        throw error;
      } finally {
        client.removeListener?.('error', recordConnectionError);
        client.release(releaseError);
      }
    }
    throw Object.assign(new Error('Simulation auto-pause serialization retries exhausted.'), {
      code: 'SERIALIZATION_FAILURE',
    });
  }

  private async autoPauseTransaction(
    client: Client,
    request: FencedSimulationAutoPauseRequest,
    identity: AutoPauseIdentity,
  ): Promise<AutoPauseTransactionResolution> {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `worldgraph-command-v1:${request.worldId}`,
    ]);
    const replay = await this.replayAutoPause(client, request, identity);
    if (replay) return { commit: false, result: replay };
    if (!(await this.leaseIsCurrent(client, request))) {
      return { commit: false, result: { status: 'fenced' } };
    }
    await this.insertAutoPauseReceivedCommand(client, request, identity);
    await client.query('select worldgraph_open_command_write($1,$2)', [
      identity.commandId,
      request.worldId,
    ]);
    const context = await this.loadContext(client, request.worldId);
    if (!context || context.lifecycle !== 'active' || context.archived_at !== null) {
      return { commit: false, result: { status: 'conflict' } };
    }
    if (!matchesExpectedSnapshot(context, request.failedCommand)) {
      return { commit: false, result: { status: 'conflict' } };
    }
    if (context.mode !== 'running') {
      return { commit: false, result: { status: 'clock_not_running' } };
    }
    assertContextIntegrity(context);
    const attemptedTargetTick =
      BigInt(request.failedCommand.expectedTick) + BigInt(request.failedCommand.payload.ticks);
    const targetTick = (
      attemptedTargetTick <= SIGNED_INT64_MAX
        ? attemptedTargetTick
        : BigInt(request.failedCommand.expectedTick)
    ).toString(10);
    const batchRunId = await this.recordFailedBatch(client, request, identity, context, targetTick);
    await this.recordSimulationFailure(client, request, identity, context, batchRunId);

    const resultingStateRevision = addDecimal(context.state_revision, 1);
    const events: PlannedEvent[] = [
      {
        aggregateId: request.worldId,
        aggregateType: 'simulation_clock',
        eventId: this.options.ids.next(),
        eventType: 'WorldClockAutoPausedV1',
        payload: {
          errorCode: request.failure.errorCode,
          failureId: identity.failureId,
          tick: request.failedCommand.expectedTick,
        },
      },
      {
        aggregateId: identity.failureId,
        aggregateType: 'simulation_failure',
        eventId: this.options.ids.next(),
        eventType: 'SimulationFailureRecordedV1',
        payload: {
          attempts: request.attempts,
          batchRunId,
          errorCode: request.failure.errorCode,
          failureId: identity.failureId,
          processType: request.failure.processType,
          processVersion: request.failure.processVersion,
          scheduleId: request.failure.scheduleId,
          tick: request.failure.tick,
        },
      },
    ];
    const persistenceCommand: PersistenceCommand = {
      causationId: request.failedCommand.commandId,
      commandId: identity.commandId,
      commandType: 'AutoPauseWorldClockV1',
      worldId: request.worldId,
    };
    const allocation = await this.loadAllocation(client, request.worldId);
    const persistedEvents = await this.appendEvents(
      client,
      persistenceCommand,
      context.recorded_at,
      resultingStateRevision,
      allocation,
      events,
    );
    await this.appendLedger(
      client,
      persistenceCommand,
      context.recorded_at,
      allocation,
      persistedEvents,
    );
    await this.autoPauseClock(client, request, context, resultingStateRevision);
    const lastEventSequence = addDecimal(
      allocation.next_event_sequence,
      persistedEvents.length - 1,
    );
    const lastLedgerSequence = addDecimal(allocation.next_ledger_sequence, persistedEvents.length);
    const checksums = await this.publishCheckpoints(
      client,
      request.worldId,
      resultingStateRevision,
      lastEventSequence,
      context.recorded_at,
    );
    await this.publishOutbox(client, persistenceCommand, context.recorded_at, persistedEvents);
    await this.advanceRuntimeHead(
      client,
      request.worldId,
      context.state_revision,
      resultingStateRevision,
      lastLedgerSequence,
      lastEventSequence,
      checksums.graph,
      context.recorded_at,
    );
    if (!(await this.leaseIsCurrent(client, request))) {
      return { commit: false, result: { status: 'fenced' } };
    }
    const result: AcceptedCommandResult = {
      commandId: identity.commandId,
      eventIds: persistedEvents.map(({ event }) => event.eventId),
      eventSequenceRange: {
        from: allocation.next_event_sequence,
        to: lastEventSequence,
      },
      ledgerSequenceRange: {
        from: allocation.next_ledger_sequence,
        to: lastLedgerSequence,
      },
      resultingStateRevision,
      schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      status: 'accepted',
    };
    const accepted = await client.query(
      `update command_records
          set status = 'accepted', authorization_rule_id = $2, decided_at = $3,
              resulting_state_revision = $4::bigint, response_summary = $5
        where id = $1 and status = 'received'`,
      [
        identity.commandId,
        SIMULATION_WORKER_AUTHORIZATION_RULE_ID,
        context.recorded_at,
        resultingStateRevision,
        JSON.stringify(result),
      ],
    );
    if ((accepted.rowCount ?? 0) !== 1) throw new Error('SIMULATION_COMMAND_ACCEPT_FAILED');
    return {
      commit: true,
      result: { failureId: identity.failureId, status: 'auto_paused' },
    };
  }

  private async advanceTransaction(
    client: Client,
    request: FencedSimulationAdvanceRequest,
    payloadHash: Buffer,
    requestHash: Buffer,
  ): Promise<TransactionResolution> {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `worldgraph-command-v1:${request.worldId}`,
    ]);
    const replay = await this.replay(client, request, requestHash);
    if (replay) return { commit: false, result: replay };
    if (!(await this.leaseIsCurrent(client, request))) {
      return { commit: false, result: { status: 'fenced' } };
    }

    await this.insertReceivedCommand(client, request, payloadHash, requestHash);
    await client.query('select worldgraph_open_command_write($1,$2)', [
      request.command.commandId,
      request.worldId,
    ]);

    const context = await this.loadContext(client, request.worldId);
    if (!context || context.lifecycle !== 'active' || context.archived_at !== null) {
      return { commit: false, result: { status: 'conflict' } };
    }
    if (!matchesExpectedSnapshot(context, request.command)) {
      return { commit: false, result: { status: 'conflict' } };
    }
    if (context.mode !== 'running') {
      return { commit: false, result: { status: 'clock_not_running' } };
    }
    if (
      context.last_wall_anchor_at === null ||
      BigInt(context.due_ticks) < BigInt(request.command.payload.ticks)
    ) {
      return { commit: false, result: { status: 'not_due' } };
    }
    assertContextIntegrity(context);

    const clock = simulationClock(context);
    const attemptedTargetTick =
      BigInt(request.command.expectedTick) + BigInt(request.command.payload.ticks);
    const queryTargetTick = (
      attemptedTargetTick <= SIGNED_INT64_MAX
        ? attemptedTargetTick
        : BigInt(request.command.expectedTick)
    ).toString(10);
    const dueActions = await this.loadDueActions(client, request.worldId, queryTargetTick);
    const plan = planSimulationAdvanceV1({
      clock,
      dueActions,
      startingProjectionChecksum: context.simulation_checkpoint_checksum.toString('hex'),
      ticks: request.command.payload.ticks,
      worldSeed: context.world_seed,
    });
    const resultingStateRevision = addDecimal(context.state_revision, 1);
    const events = await this.materializeEventsAndSchedules(
      client,
      request,
      context,
      plan,
      resultingStateRevision,
    );
    const allocation = await this.loadAllocation(client, request.worldId);
    const persistenceCommand: PersistenceCommand = {
      causationId: null,
      commandId: request.command.commandId,
      commandType: request.command.type,
      worldId: request.worldId,
    };
    const persistedEvents = await this.appendEvents(
      client,
      persistenceCommand,
      context.recorded_at,
      resultingStateRevision,
      allocation,
      events,
    );
    await this.appendLedger(
      client,
      persistenceCommand,
      context.recorded_at,
      allocation,
      persistedEvents,
    );
    await this.updateClock(client, request, context, plan, resultingStateRevision);
    await this.completeSchedules(
      client,
      request,
      context.recorded_at,
      resultingStateRevision,
      plan,
      events,
    );
    await this.completeBatch(client, request, context, plan);
    const lastEventSequence = addDecimal(
      allocation.next_event_sequence,
      persistedEvents.length - 1,
    );
    const lastLedgerSequence = addDecimal(allocation.next_ledger_sequence, persistedEvents.length);
    const checksums = await this.publishCheckpoints(
      client,
      request.worldId,
      resultingStateRevision,
      lastEventSequence,
      context.recorded_at,
    );
    await this.publishOutbox(client, persistenceCommand, context.recorded_at, persistedEvents);
    await this.advanceRuntimeHead(
      client,
      request.worldId,
      context.state_revision,
      resultingStateRevision,
      lastLedgerSequence,
      lastEventSequence,
      checksums.graph,
      context.recorded_at,
    );

    // A lease that expired while pure work ran rolls every command mutation back.
    if (!(await this.leaseIsCurrent(client, request))) {
      return { commit: false, result: { status: 'fenced' } };
    }
    const result: AcceptedCommandResult = {
      commandId: request.command.commandId,
      eventIds: persistedEvents.map(({ event }) => event.eventId),
      eventSequenceRange: {
        from: allocation.next_event_sequence,
        to: lastEventSequence,
      },
      ledgerSequenceRange: {
        from: allocation.next_ledger_sequence,
        to: lastLedgerSequence,
      },
      resultingStateRevision,
      schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      status: 'accepted',
    };
    const accepted = await client.query(
      `update command_records
          set status = 'accepted', authorization_rule_id = $2, decided_at = $3,
              resulting_state_revision = $4::bigint, response_summary = $5
        where id = $1 and status = 'received'`,
      [
        request.command.commandId,
        SIMULATION_WORKER_AUTHORIZATION_RULE_ID,
        context.recorded_at,
        resultingStateRevision,
        JSON.stringify(result),
      ],
    );
    if ((accepted.rowCount ?? 0) !== 1) throw new Error('SIMULATION_COMMAND_ACCEPT_FAILED');
    return {
      commit: true,
      result: { resultingTick: plan.nextClockState.currentTick, status: 'advanced' },
      telemetry: {
        executions: plan.executions.map(({ action, processResult, tick }) => ({
          eventCount: processResult.events.length,
          processType: action.actionType,
          processVersion: action.processVersion,
          proposedScheduleCount: processResult.schedules.length,
          tick,
        })),
        fromTick: request.command.expectedTick,
        tickCount: request.command.payload.ticks,
        toTick: plan.nextClockState.currentTick,
      },
    };
  }

  private async leaseIsCurrent(
    client: Client,
    request: Pick<FencedSimulationAdvanceRequest, 'leaseFencingToken' | 'leaseOwner' | 'worldId'>,
  ): Promise<boolean> {
    const result = await client.query(
      `select lease.lease_owner, lease.fencing_token::text, lease.leased_until,
              worldgraph_simulation_lease_is_current($1,$2,$3::bigint) as is_current
         from simulation_worker_leases lease
        where lease.world_id = $1`,
      [request.worldId, request.leaseOwner, request.leaseFencingToken],
    );
    const row = result.rows[0] as LeaseRow | undefined;
    return (
      row?.is_current === true &&
      row.lease_owner === request.leaseOwner &&
      row.fencing_token === request.leaseFencingToken &&
      validDate(row.leased_until)
    );
  }

  private async replay(
    client: Client,
    request: FencedSimulationAdvanceRequest,
    requestHash: Buffer,
  ): Promise<FencedSimulationAdvanceResult | null> {
    const byId = await client.query(
      `select id, world_id, command_type, actor_type, actor_id, idempotency_key,
              request_hash, status, response_summary
         from command_records where id = $1 for update`,
      [request.command.commandId],
    );
    const storedById = byId.rows[0] as StoredCommandRow | undefined;
    if (storedById) return replayStoredAdvance(storedById, request, requestHash);
    const byKey = await client.query(
      `select id, world_id, command_type, actor_type, actor_id, idempotency_key,
              request_hash, status, response_summary
         from command_records
        where world_id = $1 and actor_type = 'system' and actor_id = $2
          and command_type = 'AdvanceSimulationV1' and idempotency_key = $3
        for update`,
      [request.worldId, SIMULATION_WORKER_ACTOR_ID, request.command.idempotencyKey],
    );
    const storedByKey = byKey.rows[0] as StoredCommandRow | undefined;
    return storedByKey ? replayStoredAdvance(storedByKey, request, requestHash) : null;
  }

  private async replayAutoPause(
    client: Client,
    request: FencedSimulationAutoPauseRequest,
    identity: AutoPauseIdentity,
  ): Promise<FencedSimulationAutoPauseResult | null> {
    const byId = await client.query(
      `select id, world_id, command_type, actor_type, actor_id, idempotency_key,
              request_hash, status, response_summary
         from command_records where id = $1 for update`,
      [identity.commandId],
    );
    const storedById = byId.rows[0] as StoredCommandRow | undefined;
    if (storedById) return replayStoredAutoPause(storedById, request, identity);
    const byKey = await client.query(
      `select id, world_id, command_type, actor_type, actor_id, idempotency_key,
              request_hash, status, response_summary
         from command_records
        where world_id = $1 and actor_type = 'system' and actor_id = $2
          and command_type = 'AutoPauseWorldClockV1' and idempotency_key = $3
        for update`,
      [request.worldId, SIMULATION_WORKER_ACTOR_ID, identity.idempotencyKey],
    );
    const storedByKey = byKey.rows[0] as StoredCommandRow | undefined;
    return storedByKey ? replayStoredAutoPause(storedByKey, request, identity) : null;
  }

  private async insertReceivedCommand(
    client: Client,
    request: FencedSimulationAdvanceRequest,
    payloadHash: Buffer,
    requestHash: Buffer,
  ): Promise<void> {
    await client.query(
      `insert into command_records(
         id, world_id, command_type, command_schema_version, actor_type, actor_id,
         payload, payload_hash, payload_classification, idempotency_key, request_hash,
         expected_world_version, expected_state_revision, expected_aggregate_version,
         correlation_id, causation_id, requested_at
       ) values (
         $1,$2,'AdvanceSimulationV1',$3,'system',$4,null,$5,'member',$6,$7,
         $8::bigint,$9::bigint,$10::bigint,$1,null,
         date_trunc('milliseconds',transaction_timestamp())
       )`,
      [
        request.command.commandId,
        request.worldId,
        AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
        SIMULATION_WORKER_ACTOR_ID,
        payloadHash,
        request.command.idempotencyKey,
        requestHash,
        request.command.expectedWorldVersion,
        request.command.expectedStateRevision,
        request.command.expectedAggregateVersion,
      ],
    );
  }

  private async insertAutoPauseReceivedCommand(
    client: Client,
    request: FencedSimulationAutoPauseRequest,
    identity: AutoPauseIdentity,
  ): Promise<void> {
    await client.query(
      `insert into command_records(
         id, world_id, command_type, command_schema_version, actor_type, actor_id,
         payload, payload_hash, payload_classification, idempotency_key, request_hash,
         expected_world_version, expected_state_revision, expected_aggregate_version,
         correlation_id, causation_id, requested_at
       ) values (
         $1,$2,'AutoPauseWorldClockV1',$3,'system',$4,null,$5,'member',$6,$7,
         $8::bigint,$9::bigint,$10::bigint,$1,$11,
         date_trunc('milliseconds',transaction_timestamp())
       )`,
      [
        identity.commandId,
        request.worldId,
        AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
        SIMULATION_WORKER_ACTOR_ID,
        identity.payloadHash,
        identity.idempotencyKey,
        identity.requestHash,
        request.failedCommand.expectedWorldVersion,
        request.failedCommand.expectedStateRevision,
        request.failedCommand.expectedAggregateVersion,
        request.failedCommand.commandId,
      ],
    );
  }

  private async loadContext(client: Client, worldId: string): Promise<SimulationContextRow | null> {
    const result = await client.query(
      `select world.id as world_id, world.lifecycle::text, world.archived_at,
              runtime.active_world_version_id, runtime.state_revision::text,
              runtime.last_event_sequence::text, runtime.last_ledger_sequence::text,
              runtime.ledger_anchored_at, runtime.anchor_artifact_hash,
              version.version_number::text as design_version, version.seed as world_seed,
              clock.clock_schema_version, clock.epoch_at, clock.current_tick::text,
              clock.world_milliseconds_per_tick::text, clock.wall_cadence_milliseconds,
              clock.mode::text, clock.max_batch_ticks, clock.max_catch_up_ticks,
              clock.prng_algorithm_version, clock.outcome_hash, clock.last_wall_anchor_at,
              clock.row_version::text, clock.updated_state_revision::text, clock.updated_at,
              stream.current_version::text as aggregate_version,
              simulation_checkpoint.projection_schema_version
                as simulation_checkpoint_schema_version,
              simulation_checkpoint.last_event_sequence::text
                as simulation_checkpoint_event_sequence,
              simulation_checkpoint.checksum as simulation_checkpoint_checksum,
              worldgraph_simulation_projection_checksum(world.id)
                as simulation_computed_checksum,
              simulation_checkpoint.status::text as simulation_checkpoint_status,
              graph_checkpoint.last_event_sequence::text as graph_checkpoint_event_sequence,
              graph_checkpoint.checksum as graph_checkpoint_checksum,
              graph_checkpoint.status::text as graph_checkpoint_status,
              date_trunc('milliseconds',transaction_timestamp()) as recorded_at,
              greatest(0, floor(extract(epoch from (
                transaction_timestamp() - clock.last_wall_anchor_at
              )) * 1000 / clock.wall_cadence_milliseconds))::bigint::text as due_ticks
         from worlds world
         join world_runtime_heads runtime on runtime.world_id = world.id
         join world_versions version on version.id = runtime.active_world_version_id
          and version.world_id = runtime.world_id
         join world_simulation_clocks clock on clock.world_id = world.id
         join aggregate_stream_heads stream on stream.world_id = world.id
          and stream.aggregate_type = 'simulation_clock'
          and stream.aggregate_id = world.id::text
         join projection_checkpoints simulation_checkpoint
          on simulation_checkpoint.world_id = world.id
          and simulation_checkpoint.projection_name = 'simulation_runtime'
         join projection_checkpoints graph_checkpoint
          on graph_checkpoint.world_id = world.id
          and graph_checkpoint.projection_name = 'world_graph'
        where world.id = $1
        for update of clock, simulation_checkpoint, graph_checkpoint`,
      [worldId],
    );
    return (result.rows[0] as SimulationContextRow | undefined) ?? null;
  }

  private async loadDueActions(
    client: Client,
    worldId: string,
    targetTick: string,
  ): Promise<ScheduledActionV1[]> {
    const result = await client.query(
      `select action.id, action.world_id, action.schedule_sequence::text,
              action.due_tick::text, action.priority, action.action_type,
              action.action_schema_version, action.process_version, action.payload,
              action.payload_hash, action.status::text, action.created_command_id,
              action.cancelled_command_id, action.completed_event_id,
              action.created_by_actor_type::text, action.created_by_actor_id,
              action.created_state_revision::text, action.completed_state_revision::text,
              action.created_at, action.updated_at
         from scheduled_actions action
        where action.world_id = $1 and action.status = 'scheduled'
          and action.due_tick <= $2::bigint
        order by action.due_tick, action.priority, action.schedule_sequence, action.id
        limit 65
        for update of action`,
      [worldId, targetTick],
    );
    return (result.rows as unknown as ScheduledActionRow[]).map(scheduledAction);
  }

  private async materializeEventsAndSchedules(
    client: Client,
    request: FencedSimulationAdvanceRequest,
    context: SimulationContextRow,
    plan: SimulationAdvancePlanV1,
    resultingStateRevision: string,
  ): Promise<PlannedEvent[]> {
    const events: PlannedEvent[] = [
      {
        aggregateId: request.worldId,
        aggregateType: 'simulation_clock',
        eventId: this.options.ids.next(),
        eventType: 'SimulationAdvancedV1',
        payload: {
          executedScheduleCount: plan.executions.length,
          fromTick: request.command.expectedTick,
          outcomeHash: plan.outcome.outcomeHash,
          processRegistryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
          tickCount: request.command.payload.ticks,
          toTick: plan.nextClockState.currentTick,
        },
      },
    ];
    for (const execution of plan.executions) {
      events.push({
        aggregateId: execution.action.id,
        aggregateType: 'scheduled_action',
        eventId: this.options.ids.next(),
        eventType: 'ScheduledActionExecutedV1',
        payload: {
          actionType: execution.action.actionType,
          dueTick: execution.action.dueTick,
          outcomeHash: plan.outcome.outcomeHash,
          processVersion: execution.action.processVersion,
          scheduleId: execution.action.id,
          scheduleSequence: execution.action.scheduleSequence,
        },
      });
      for (const returned of execution.processResult.events) {
        events.push({
          aggregateId: execution.action.id,
          aggregateType: 'world_notice',
          eventId: this.options.ids.next(),
          eventType: returned.eventType,
          payload: { ...returned.payload, scheduleId: execution.action.id },
        });
      }
      for (const proposed of execution.processResult.schedules) {
        const allocated = await client.query(
          'select worldgraph_allocate_schedule_sequence($1)::text as schedule_sequence',
          [request.worldId],
        );
        const scheduleSequence = (allocated.rows[0] as { schedule_sequence?: string } | undefined)
          ?.schedule_sequence;
        if (!scheduleSequence) throw new Error('SIMULATION_SCHEDULE_ALLOCATION_FAILED');
        const scheduleId = this.options.ids.next();
        const payloadHash = sha256(proposed.payload);
        await client.query(
          `insert into scheduled_actions(
             id, world_id, schedule_sequence, due_tick, priority, action_type,
             action_schema_version, payload, payload_hash, process_version,
             created_by_actor_type, created_by_actor_id, created_command_id,
             created_state_revision, created_at, updated_at
           ) values (
             $1,$2,$3::bigint,$4::bigint,$5,$6,$7,$8,$9,$10,
             'system',$11,$12,$13::bigint,$14,$14
           )`,
          [
            scheduleId,
            request.worldId,
            scheduleSequence,
            proposed.dueTick,
            proposed.priority,
            proposed.actionType,
            proposed.actionSchemaVersion,
            JSON.stringify(proposed.payload),
            payloadHash,
            proposed.processVersion,
            SIMULATION_WORKER_ACTOR_ID,
            request.command.commandId,
            resultingStateRevision,
            context.recorded_at,
          ],
        );
        events.push({
          aggregateId: scheduleId,
          aggregateType: 'scheduled_action',
          eventId: this.options.ids.next(),
          eventType: 'ScheduledActionCreatedV1',
          payload: {
            actionSchemaVersion: SIMULATION_SCHEDULE_SCHEMA_VERSION,
            actionType: proposed.actionType,
            dueTick: proposed.dueTick,
            payload: proposed.payload,
            payloadHash: payloadHash.toString('hex'),
            priority: proposed.priority,
            processVersion: proposed.processVersion,
            scheduleId,
            scheduleSequence,
          },
        });
      }
    }
    if (events.length < 1 || events.length > 64) {
      throw new Error('SIMULATION_BUDGET_EXCEEDED');
    }
    return events;
  }

  private async loadAllocation(client: Client, worldId: string): Promise<AllocationRow> {
    const result = await client.query(
      `select next_event_sequence::text, next_ledger_sequence::text, last_entry_hash
         from world_ledger_heads where world_id = $1`,
      [worldId],
    );
    const row = result.rows[0] as AllocationRow | undefined;
    if (!row) throw new Error('SIMULATION_LEDGER_HEAD_MISSING');
    return row;
  }

  private async appendEvents(
    client: Client,
    command: PersistenceCommand,
    recordedAtDate: Date,
    resultingStateRevision: string,
    allocation: AllocationRow,
    events: readonly PlannedEvent[],
  ): Promise<PersistedEvent[]> {
    const recordedAt = recordedAtDate.toISOString();
    const metadata: DomainEventMetadataV1 = {
      actor: { actorId: SIMULATION_WORKER_ACTOR_ID, actorType: 'system' },
      authorizationRuleId: SIMULATION_WORKER_AUTHORIZATION_RULE_ID,
      causationId: command.causationId,
      commandSchemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      commandType: command.commandType,
      correlationId: command.commandId,
      overrideId: null,
      payloadClassification: 'member',
    };
    const persisted: PersistedEvent[] = [];
    for (const [ordinal, planned] of events.entries()) {
      const aggregateVersionResult = await client.query(
        `select coalesce((select current_version + 1 from aggregate_stream_heads
          where world_id = $1 and aggregate_type = $2 and aggregate_id = $3),1)::text
            as next_version`,
        [command.worldId, planned.aggregateType, planned.aggregateId],
      );
      const aggregateVersion = (
        aggregateVersionResult.rows[0] as { next_version?: string } | undefined
      )?.next_version;
      if (!aggregateVersion) throw new Error('SIMULATION_AGGREGATE_HEAD_MISSING');
      const event: DomainEventHashInputV1 = {
        aggregateId: planned.aggregateId,
        aggregateType: planned.aggregateType,
        aggregateVersion,
        commandId: command.commandId,
        eventId: planned.eventId,
        eventOrdinal: ordinal,
        eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
        eventType: planned.eventType,
        metadata,
        occurredAt: recordedAt,
        payload: planned.payload,
        recordedAt,
        resultingStateRevision,
        worldEventSequence: addDecimal(allocation.next_event_sequence, ordinal),
        worldId: command.worldId,
      };
      const eventHash = computeDomainEventHashV1(event);
      await client.query(
        `insert into domain_events(
           id, world_id, world_event_sequence, command_id, event_ordinal,
           aggregate_type, aggregate_id, aggregate_version, event_type,
           event_schema_version, payload, metadata, event_hash, occurred_at,
           recorded_at, resulting_state_revision
         ) values (
           $1,$2,$3::bigint,$4,$5,$6,$7,$8::bigint,$9,$10,$11,$12,$13,$14,$14,$15::bigint
         )`,
        [
          event.eventId,
          event.worldId,
          event.worldEventSequence,
          event.commandId,
          event.eventOrdinal,
          event.aggregateType,
          event.aggregateId,
          event.aggregateVersion,
          event.eventType,
          event.eventSchemaVersion,
          JSON.stringify(event.payload),
          JSON.stringify(event.metadata),
          Buffer.from(eventHash, 'hex'),
          recordedAtDate,
          event.resultingStateRevision,
        ],
      );
      persisted.push({ event, eventHash });
    }
    return persisted;
  }

  private async appendLedger(
    client: Client,
    command: PersistenceCommand,
    recordedAtDate: Date,
    allocation: AllocationRow,
    events: readonly PersistedEvent[],
  ): Promise<void> {
    const actor: LedgerActorV1 = {
      actorId: SIMULATION_WORKER_ACTOR_ID,
      actorType: 'system',
    };
    const recordedAt = recordedAtDate.toISOString();
    const accepted = ledgerEntry(this.options.ids.next(), {
      actor,
      commandId: command.commandId,
      entryKind: 'command_accepted',
      eventId: null,
      ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
      ledgerSequence: allocation.next_ledger_sequence,
      previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
      publicSummaryCode: 'COMMAND_ACCEPTED',
      recordedAt,
      redactedDetails: {
        authorizationRuleId: SIMULATION_WORKER_AUTHORIZATION_RULE_ID,
        commandType: command.commandType,
      },
      worldId: command.worldId,
    });
    await insertLedgerEntry(client, accepted);
    let previousHash = accepted.entryHash;
    for (const [index, persisted] of events.entries()) {
      const entry = ledgerEntry(this.options.ids.next(), {
        actor,
        commandId: command.commandId,
        entryKind: 'domain_event',
        eventId: persisted.event.eventId,
        ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
        ledgerSequence: addDecimal(allocation.next_ledger_sequence, index + 1),
        previousHash,
        publicSummaryCode: summaryCode(persisted.event.eventType),
        recordedAt,
        redactedDetails: {
          aggregateType: persisted.event.aggregateType,
          eventType: persisted.event.eventType,
          targetHash: sha256Text(persisted.event.aggregateId),
        },
        worldId: command.worldId,
      });
      await insertLedgerEntry(client, entry);
      previousHash = entry.entryHash;
    }
  }

  private async updateClock(
    client: Client,
    request: FencedSimulationAdvanceRequest,
    context: SimulationContextRow,
    plan: SimulationAdvancePlanV1,
    resultingStateRevision: string,
  ): Promise<void> {
    if (!context.last_wall_anchor_at) throw new Error('CLOCK_NOT_RUNNING');
    const advancedAnchor = advanceWallAnchor(
      context.last_wall_anchor_at,
      request.command.payload.ticks,
      context.wall_cadence_milliseconds,
    );
    const updated = await client.query(
      `update world_simulation_clocks
          set current_tick = $2::bigint, last_wall_anchor_at = $3,
              outcome_hash = $4,
              row_version = row_version + 1,
              updated_state_revision = $5::bigint,
              updated_at = greatest(updated_at,$6)
        where world_id = $1 and row_version = $7::bigint
          and current_tick = $8::bigint and mode = 'running'
       returning world_id`,
      [
        request.worldId,
        plan.nextClockState.currentTick,
        advancedAnchor,
        Buffer.from(plan.outcome.outcomeHash, 'hex'),
        resultingStateRevision,
        context.recorded_at,
        context.row_version,
        request.command.expectedTick,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error('SIMULATION_CLOCK_CONFLICT');
  }

  private async autoPauseClock(
    client: Client,
    request: FencedSimulationAutoPauseRequest,
    context: SimulationContextRow,
    resultingStateRevision: string,
  ): Promise<void> {
    const updated = await client.query(
      `update world_simulation_clocks
          set mode = 'error', last_wall_anchor_at = null,
              row_version = row_version + 1,
              updated_state_revision = $2::bigint,
              updated_at = greatest(updated_at,$3)
        where world_id = $1 and row_version = $4::bigint
          and current_tick = $5::bigint and mode = 'running'
       returning world_id`,
      [
        request.worldId,
        resultingStateRevision,
        context.recorded_at,
        context.row_version,
        request.failedCommand.expectedTick,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error('SIMULATION_CLOCK_CONFLICT');
  }

  private async completeSchedules(
    client: Client,
    request: FencedSimulationAdvanceRequest,
    recordedAt: Date,
    resultingStateRevision: string,
    plan: SimulationAdvancePlanV1,
    events: readonly PlannedEvent[],
  ): Promise<void> {
    for (const execution of plan.executions) {
      const event = events.find(
        (candidate) =>
          candidate.eventType === 'ScheduledActionExecutedV1' &&
          candidate.aggregateId === execution.action.id,
      );
      if (!event) throw new Error('SIMULATION_EXECUTION_EVENT_MISSING');
      const updated = await client.query(
        `update scheduled_actions
            set status = 'completed', completed_event_id = $3,
                completed_state_revision = $4::bigint,
                updated_at = greatest(updated_at,$5)
          where world_id = $1 and id = $2 and status = 'scheduled'
         returning id`,
        [request.worldId, execution.action.id, event.eventId, resultingStateRevision, recordedAt],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error('SCHEDULE_ALREADY_TERMINAL');
    }
  }

  private async completeBatch(
    client: Client,
    request: FencedSimulationAdvanceRequest,
    context: SimulationContextRow,
    plan: SimulationAdvancePlanV1,
  ): Promise<void> {
    const batchId = this.options.ids.next();
    const inputChecksum = context.simulation_checkpoint_checksum.toString('hex');
    const batchKey = sha256({
      fromTick: request.command.expectedTick,
      inputChecksum,
      processRegistryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
      toTick: plan.nextClockState.currentTick,
      worldId: request.worldId,
    });
    const prepared = await client.query(
      `insert into simulation_batch_runs(
         id, world_id, batch_schema_version, from_tick, to_tick, batch_key,
         process_registry_version, input_checksum, attempts, started_at
       ) values ($1,$2,$3,$4::bigint,$5::bigint,$6,$7,$8,1,$9)
       on conflict on constraint simulation_batch_runs_identity_unique do update
         set outcome_hash = $10, status = 'completed', command_id = $11,
             error_code = null, attempts = simulation_batch_runs.attempts + 1,
             completed_at = $9
       where simulation_batch_runs.status = 'failed'
         and simulation_batch_runs.attempts < 100
         and simulation_batch_runs.batch_key = excluded.batch_key
       returning id,status::text`,
      [
        batchId,
        request.worldId,
        SIMULATION_BATCH_SCHEMA_VERSION,
        request.command.expectedTick,
        plan.nextClockState.currentTick,
        batchKey,
        SIMULATION_PROCESS_REGISTRY_VERSION,
        Buffer.from(inputChecksum, 'hex'),
        context.recorded_at,
        Buffer.from(plan.outcome.outcomeHash, 'hex'),
        request.command.commandId,
      ],
    );
    const preparedBatch = prepared.rows[0] as { id?: string; status?: string } | undefined;
    if (!preparedBatch?.id) throw new Error('SIMULATION_BATCH_CONFLICT');
    if (preparedBatch.status === 'completed') return;
    if (preparedBatch.status !== 'running') throw new Error('SIMULATION_BATCH_CONFLICT');
    const updated = await client.query(
      `update simulation_batch_runs
          set outcome_hash = $3, status = 'completed', command_id = $4,
              completed_at = $5
        where world_id = $1 and id = $2 and status = 'running'`,
      [
        request.worldId,
        preparedBatch.id,
        Buffer.from(plan.outcome.outcomeHash, 'hex'),
        request.command.commandId,
        context.recorded_at,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error('SIMULATION_BATCH_CONFLICT');
  }

  private async recordFailedBatch(
    client: Client,
    request: FencedSimulationAutoPauseRequest,
    identity: AutoPauseIdentity,
    context: SimulationContextRow,
    targetTick: string,
  ): Promise<string> {
    const inputChecksum = context.simulation_checkpoint_checksum.toString('hex');
    const zeroWidthClockBoundary = targetTick === request.failedCommand.expectedTick;
    const batchKey = sha256({
      fromTick: request.failedCommand.expectedTick,
      inputChecksum,
      processRegistryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
      toTick: targetTick,
      worldId: request.worldId,
    });
    if (zeroWidthClockBoundary) {
      const failed = await client.query(
        `insert into simulation_batch_runs(
           id, world_id, batch_schema_version, from_tick, to_tick, batch_key,
           process_registry_version, input_checksum, attempts, status, error_code,
           started_at, completed_at
         ) values ($1,$2,$3,$4::bigint,$5::bigint,$6,$7,$8,$9,'failed',$11,$10,$10)
         on conflict on constraint simulation_batch_runs_identity_unique do update
           set attempts = simulation_batch_runs.attempts + excluded.attempts,
               completed_at = $10
         where simulation_batch_runs.status = 'failed'
           and simulation_batch_runs.error_code = 'SIMULATION_INTEGER_OVERFLOW'
           and simulation_batch_runs.attempts <= 100 - excluded.attempts
           and simulation_batch_runs.batch_key = excluded.batch_key
         returning id,status::text`,
        [
          identity.batchId,
          request.worldId,
          SIMULATION_BATCH_SCHEMA_VERSION,
          request.failedCommand.expectedTick,
          targetTick,
          batchKey,
          SIMULATION_PROCESS_REGISTRY_VERSION,
          Buffer.from(inputChecksum, 'hex'),
          request.attempts,
          context.recorded_at,
          request.failure.errorCode,
        ],
      );
      const failedBatch = failed.rows[0] as { id?: string; status?: string } | undefined;
      if (!failedBatch?.id || failedBatch.status !== 'failed') {
        throw new Error('SIMULATION_BATCH_CONFLICT');
      }
      return failedBatch.id;
    }
    const prepared = await client.query(
      `insert into simulation_batch_runs(
         id, world_id, batch_schema_version, from_tick, to_tick, batch_key,
         process_registry_version, input_checksum, attempts, started_at
       ) values ($1,$2,$3,$4::bigint,$5::bigint,$6,$7,$8,$9,$10)
       on conflict on constraint simulation_batch_runs_identity_unique do update
         set status = 'failed', error_code = $11,
             attempts = simulation_batch_runs.attempts + excluded.attempts,
             completed_at = $10
       where simulation_batch_runs.status = 'failed'
         and simulation_batch_runs.attempts <= 100 - excluded.attempts
         and simulation_batch_runs.batch_key = excluded.batch_key
       returning id,status::text`,
      [
        identity.batchId,
        request.worldId,
        SIMULATION_BATCH_SCHEMA_VERSION,
        request.failedCommand.expectedTick,
        targetTick,
        batchKey,
        SIMULATION_PROCESS_REGISTRY_VERSION,
        Buffer.from(inputChecksum, 'hex'),
        request.attempts,
        context.recorded_at,
        request.failure.errorCode,
      ],
    );
    const preparedBatch = prepared.rows[0] as { id?: string; status?: string } | undefined;
    if (!preparedBatch?.id) throw new Error('SIMULATION_BATCH_CONFLICT');
    if (preparedBatch.status === 'failed') return preparedBatch.id;
    if (preparedBatch.status !== 'running') throw new Error('SIMULATION_BATCH_CONFLICT');
    const updated = await client.query(
      `update simulation_batch_runs
          set status = 'failed', error_code = $3, completed_at = $4
        where world_id = $1 and id = $2 and status = 'running'`,
      [request.worldId, preparedBatch.id, request.failure.errorCode, context.recorded_at],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error('SIMULATION_BATCH_CONFLICT');
    return preparedBatch.id;
  }

  private async recordSimulationFailure(
    client: Client,
    request: FencedSimulationAutoPauseRequest,
    identity: AutoPauseIdentity,
    context: SimulationContextRow,
    batchRunId: string,
  ): Promise<void> {
    await client.query(
      `insert into simulation_failures(
         id, world_id, failure_schema_version, batch_run_id, tick, schedule_id,
         process_type, process_version, error_code, redacted_context, attempts, opened_at
       ) values ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12)`,
      [
        identity.failureId,
        request.worldId,
        SIMULATION_FAILURE_SCHEMA_VERSION,
        batchRunId,
        request.failure.tick,
        request.failure.scheduleId,
        request.failure.processType,
        request.failure.processVersion,
        request.failure.errorCode,
        JSON.stringify({
          expectedStateRevision: request.failedCommand.expectedStateRevision,
          expectedTick: request.failedCommand.expectedTick,
          failedCommandType: request.failedCommand.type,
        }),
        request.attempts,
        context.recorded_at,
      ],
    );
  }

  private async publishCheckpoints(
    client: Client,
    worldId: string,
    resultingStateRevision: string,
    lastEventSequence: string,
    recordedAt: Date,
  ): Promise<{ graph: Buffer; simulation: Buffer }> {
    const graphResult = await client.query(
      'select worldgraph_projection_checksum($1,$2::bigint) as checksum',
      [worldId, resultingStateRevision],
    );
    const simulationResult = await client.query(
      'select worldgraph_simulation_projection_checksum($1) as checksum',
      [worldId],
    );
    const graph = (graphResult.rows[0] as { checksum?: Buffer } | undefined)?.checksum;
    const simulation = (simulationResult.rows[0] as { checksum?: Buffer } | undefined)?.checksum;
    if (!graph || !simulation) throw new Error('SIMULATION_CHECKSUM_FAILED');
    await updateCheckpoint(
      client,
      worldId,
      'world_graph',
      PROJECTION_SCHEMA_VERSION,
      lastEventSequence,
      graph,
      recordedAt,
    );
    await updateCheckpoint(
      client,
      worldId,
      'simulation_runtime',
      SIMULATION_PROJECTION_SCHEMA_VERSION,
      lastEventSequence,
      simulation,
      recordedAt,
    );
    return { graph, simulation };
  }

  private async publishOutbox(
    client: Client,
    command: PersistenceCommand,
    recordedAt: Date,
    events: readonly PersistedEvent[],
  ): Promise<void> {
    for (const persisted of events) {
      await client.query(
        `insert into outbox_messages(
           id, world_id, event_id, message_type, message_schema_version,
           payload, status, attempts, available_at, created_at
         ) values ($1,$2,$3,'DomainEventReferenceV1',$4,$5,'pending',0,$6,$6)`,
        [
          this.options.ids.next(),
          command.worldId,
          persisted.event.eventId,
          OUTBOX_SCHEMA_VERSION,
          JSON.stringify({
            eventId: persisted.event.eventId,
            eventType: persisted.event.eventType,
            worldEventSequence: persisted.event.worldEventSequence,
            worldId: command.worldId,
          }),
          recordedAt,
        ],
      );
    }
  }

  private async advanceRuntimeHead(
    client: Client,
    worldId: string,
    expectedStateRevision: string,
    resultingStateRevision: string,
    lastLedgerSequence: string,
    lastEventSequence: string,
    graphChecksum: Buffer,
    recordedAt: Date,
  ): Promise<void> {
    const updated = await client.query(
      `update world_runtime_heads
          set state_revision = $3::bigint, last_ledger_sequence = $4::bigint,
              last_event_sequence = $5::bigint, projection_checksum = $6,
              updated_at = greatest(updated_at,$7)
        where world_id = $1 and state_revision = $2::bigint`,
      [
        worldId,
        expectedStateRevision,
        resultingStateRevision,
        lastLedgerSequence,
        lastEventSequence,
        graphChecksum,
        recordedAt,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error('SIMULATION_RUNTIME_CONFLICT');
  }
}

function assertAdvanceRequest(request: FencedSimulationAdvanceRequest): void {
  advanceValidator.assert(request.command);
  if (
    !UUID_PATTERN.test(request.worldId) ||
    !LEASE_OWNER_PATTERN.test(request.leaseOwner) ||
    !POSITIVE_INT64_PATTERN.test(request.leaseFencingToken)
  ) {
    throw new Error('SIMULATION_ADVANCE_REQUEST_INVALID');
  }
}

function assertAutoPauseRequest(request: FencedSimulationAutoPauseRequest): void {
  advanceValidator.assert(request.failedCommand);
  const targetTick =
    BigInt(request.failedCommand.expectedTick) + BigInt(request.failedCommand.payload.ticks);
  const persistedFailureTick =
    targetTick <= SIGNED_INT64_MAX ? targetTick : BigInt(request.failedCommand.expectedTick);
  const knownFailureSource =
    (request.failure.processType !== WORLD_CLOCK_FAILURE_SOURCE_TYPE &&
      request.failure.processVersion === EMIT_WORLD_NOTICE_PROCESS_VERSION) ||
    (request.failure.processType === WORLD_CLOCK_FAILURE_SOURCE_TYPE &&
      request.failure.processVersion === WORLD_CLOCK_FAILURE_SOURCE_VERSION &&
      request.failure.scheduleId === null &&
      request.failure.errorCode === 'SIMULATION_INTEGER_OVERFLOW');
  if (
    !UUID_PATTERN.test(request.worldId) ||
    !LEASE_OWNER_PATTERN.test(request.leaseOwner) ||
    !POSITIVE_INT64_PATTERN.test(request.leaseFencingToken) ||
    !Number.isSafeInteger(request.attempts) ||
    request.attempts < 1 ||
    request.attempts > 100 ||
    !/^[A-Z][A-Z0-9_]{2,99}$/u.test(request.failure.errorCode) ||
    !knownFailureSource ||
    (request.failure.scheduleId !== null && !UUID_PATTERN.test(request.failure.scheduleId)) ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(request.failure.tick) ||
    BigInt(request.failure.tick) < BigInt(request.failedCommand.expectedTick) ||
    BigInt(request.failure.tick) > targetTick ||
    (request.failure.processType === WORLD_CLOCK_FAILURE_SOURCE_TYPE &&
      BigInt(request.failure.tick) !== persistedFailureTick)
  ) {
    throw new Error('SIMULATION_AUTO_PAUSE_REQUEST_INVALID');
  }
}

function autoPauseIdentity(request: FencedSimulationAutoPauseRequest): AutoPauseIdentity {
  const keyMaterial = {
    errorCode: request.failure.errorCode,
    expectedAggregateVersion: request.failedCommand.expectedAggregateVersion,
    expectedStateRevision: request.failedCommand.expectedStateRevision,
    expectedTick: request.failedCommand.expectedTick,
    expectedWorldVersion: request.failedCommand.expectedWorldVersion,
    failureProcessType: request.failure.processType,
    failureProcessVersion: request.failure.processVersion,
    failureScheduleId: request.failure.scheduleId,
    failureTick: request.failure.tick,
    worldId: request.worldId,
  };
  const identityHash = sha256(keyMaterial).toString('hex');
  const commandId = deterministicUuidV8(`worldgraph.simulation.auto-pause.command:${identityHash}`);
  const failureId = deterministicUuidV8(`worldgraph.simulation.auto-pause.failure:${identityHash}`);
  const batchId = deterministicUuidV8(`worldgraph.simulation.auto-pause.batch:${identityHash}`);
  const payload = { errorCode: request.failure.errorCode, failureId };
  const idempotencyKey = `simulation-auto-pause.${identityHash}`;
  const requestHash = sha256({
    expectedAggregateVersion: request.failedCommand.expectedAggregateVersion,
    expectedStateRevision: request.failedCommand.expectedStateRevision,
    expectedTick: request.failedCommand.expectedTick,
    expectedWorldVersion: request.failedCommand.expectedWorldVersion,
    payload,
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    type: 'AutoPauseWorldClockV1',
    worldId: request.worldId,
  });
  return {
    batchId,
    commandId,
    failureId,
    idempotencyKey,
    payload,
    payloadHash: sha256(payload),
    requestHash,
  };
}

function replayStoredAdvance(
  stored: StoredCommandRow,
  request: FencedSimulationAdvanceRequest,
  requestHash: Buffer,
): FencedSimulationAdvanceResult {
  if (
    stored.world_id !== request.worldId ||
    stored.actor_type !== 'system' ||
    stored.actor_id !== SIMULATION_WORKER_ACTOR_ID ||
    stored.command_type !== request.command.type ||
    stored.idempotency_key !== request.command.idempotencyKey ||
    !stored.request_hash.equals(requestHash)
  ) {
    return { status: 'conflict' };
  }
  if (
    stored.status !== 'accepted' ||
    !commandResultValidator.is(stored.response_summary) ||
    stored.response_summary.status !== 'accepted' ||
    stored.response_summary.commandId !== stored.id
  ) {
    return { status: 'conflict' };
  }
  return {
    resultingTick: (
      BigInt(request.command.expectedTick) + BigInt(request.command.payload.ticks)
    ).toString(10),
    status: 'advanced',
  };
}

function replayStoredAutoPause(
  stored: StoredCommandRow,
  request: FencedSimulationAutoPauseRequest,
  identity: AutoPauseIdentity,
): FencedSimulationAutoPauseResult {
  if (
    stored.world_id !== request.worldId ||
    stored.actor_type !== 'system' ||
    stored.actor_id !== SIMULATION_WORKER_ACTOR_ID ||
    stored.command_type !== 'AutoPauseWorldClockV1' ||
    stored.idempotency_key !== identity.idempotencyKey ||
    !stored.request_hash.equals(identity.requestHash)
  ) {
    return { status: 'conflict' };
  }
  if (
    stored.status !== 'accepted' ||
    !commandResultValidator.is(stored.response_summary) ||
    stored.response_summary.status !== 'accepted' ||
    stored.response_summary.commandId !== stored.id
  ) {
    return { status: 'conflict' };
  }
  return { failureId: identity.failureId, status: 'auto_paused' };
}

function matchesExpectedSnapshot(
  context: SimulationContextRow,
  command: AdvanceSimulationCommandV1,
): boolean {
  return (
    context.design_version === command.expectedWorldVersion &&
    context.state_revision === command.expectedStateRevision &&
    context.aggregate_version === command.expectedAggregateVersion &&
    context.current_tick === command.expectedTick
  );
}

function assertContextIntegrity(context: SimulationContextRow): void {
  if (
    context.ledger_anchored_at === null ||
    context.anchor_artifact_hash === null ||
    context.clock_schema_version !== SIMULATION_CLOCK_SCHEMA_VERSION ||
    context.prng_algorithm_version !== SIMULATION_PRNG_ALGORITHM_VERSION ||
    context.simulation_checkpoint_schema_version !== SIMULATION_PROJECTION_SCHEMA_VERSION ||
    context.simulation_checkpoint_status !== 'current' ||
    context.graph_checkpoint_status !== 'current' ||
    context.simulation_checkpoint_event_sequence !== context.last_event_sequence ||
    context.graph_checkpoint_event_sequence !== context.last_event_sequence ||
    context.simulation_checkpoint_checksum.length !== 32 ||
    context.simulation_computed_checksum.length !== 32 ||
    !context.simulation_checkpoint_checksum.equals(context.simulation_computed_checksum) ||
    context.outcome_hash.length !== 32 ||
    !validDate(context.recorded_at) ||
    !validDate(context.epoch_at) ||
    !Number.isSafeInteger(Number(context.world_milliseconds_per_tick))
  ) {
    throw new Error('SIMULATION_PROJECTION_INTEGRITY_FAILED');
  }
}

function simulationClock(row: SimulationContextRow): WorldSimulationClockV1 {
  return {
    clockSchemaVersion: SIMULATION_CLOCK_SCHEMA_VERSION,
    configuration: {
      epochAt: row.epoch_at.toISOString(),
      maxBatchTicks: row.max_batch_ticks,
      maxCatchUpTicks: row.max_catch_up_ticks,
      prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
      wallCadenceMilliseconds: row.wall_cadence_milliseconds,
      worldMillisecondsPerTick: Number(row.world_milliseconds_per_tick),
    },
    currentTick: row.current_tick,
    lastWallAnchorAt: row.last_wall_anchor_at?.toISOString() ?? null,
    mode: row.mode,
    outcomeHash: row.outcome_hash.toString('hex'),
    projectionSchemaVersion: SIMULATION_PROJECTION_SCHEMA_VERSION,
    rowVersion: row.row_version,
    updatedAt: row.updated_at.toISOString(),
    updatedStateRevision: row.updated_state_revision,
    worldId: row.world_id,
  };
}

function scheduledAction(row: ScheduledActionRow): ScheduledActionV1 {
  const candidate: unknown = {
    actionSchemaVersion: SIMULATION_SCHEDULE_SCHEMA_VERSION,
    actionType: row.action_type,
    cancelledCommandId: row.cancelled_command_id,
    completedEventId: row.completed_event_id,
    completedStateRevision: row.completed_state_revision,
    createdAt: row.created_at.toISOString(),
    createdBy: { actorId: row.created_by_actor_id, actorType: row.created_by_actor_type },
    createdCommandId: row.created_command_id,
    createdStateRevision: row.created_state_revision,
    dueTick: row.due_tick,
    id: row.id,
    payload: row.payload,
    payloadHash: row.payload_hash.toString('hex'),
    priority: row.priority,
    processVersion: row.process_version,
    scheduleSchemaVersion: SIMULATION_SCHEDULE_SCHEMA_VERSION,
    scheduleSequence: row.schedule_sequence,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
    worldId: row.world_id,
  };
  scheduledActionValidator.assert(candidate);
  return candidate;
}

function ledgerEntry(
  entryId: string,
  input: Omit<LedgerEntryHashInputV1, 'entryId'>,
): LedgerEntryV1 {
  const withoutHash: LedgerEntryHashInputV1 = { ...input, entryId };
  return {
    ...withoutHash,
    entryHash: computeLedgerEntryHashV1(withoutHash),
  } as LedgerEntryV1;
}

async function insertLedgerEntry(client: Client, entry: LedgerEntryV1): Promise<void> {
  await client.query(
    `insert into ledger_entries(
       id, world_id, ledger_sequence, entry_kind, command_id, event_id,
       actor_type, actor_id, public_summary_code, redacted_details,
       previous_hash, entry_hash, recorded_at
     ) values ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      entry.entryId,
      entry.worldId,
      entry.ledgerSequence,
      entry.entryKind,
      entry.commandId,
      entry.eventId,
      entry.actor.actorType,
      entry.actor.actorId,
      entry.publicSummaryCode,
      JSON.stringify(entry.redactedDetails),
      Buffer.from(entry.previousHash, 'hex'),
      Buffer.from(entry.entryHash, 'hex'),
      new Date(entry.recordedAt),
    ],
  );
}

async function updateCheckpoint(
  client: Client,
  worldId: string,
  projectionName: 'simulation_runtime' | 'world_graph',
  projectionSchemaVersion: number,
  lastEventSequence: string,
  checksum: Buffer,
  recordedAt: Date,
): Promise<void> {
  await client.query(
    `insert into projection_checkpoints(
       world_id, projection_name, projection_schema_version,
       last_event_sequence, checksum, status, updated_at
     ) values ($1,$2,$3,$4::bigint,$5,'current',$6)
     on conflict (world_id, projection_name) do update
       set projection_schema_version = excluded.projection_schema_version,
           last_event_sequence = excluded.last_event_sequence,
           checksum = excluded.checksum, status = excluded.status,
           updated_at = greatest(projection_checkpoints.updated_at,excluded.updated_at)`,
    [worldId, projectionName, projectionSchemaVersion, lastEventSequence, checksum, recordedAt],
  );
}

function sha256(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deterministicUuidV8(material: string): string {
  const hex = sha256Text(material).slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20)}`;
}

function addDecimal(value: string, amount: number): string {
  return (BigInt(value) + BigInt(amount)).toString(10);
}

function summaryCode(eventType: string): string {
  return eventType
    .replace(/V[1-9][0-9]*$/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toUpperCase();
}

function advanceWallAnchor(anchor: Date, ticks: number, cadenceMilliseconds: number): Date {
  const next = new Date(anchor.getTime() + ticks * cadenceMilliseconds);
  if (!validDate(next)) throw new Error('SIMULATION_WALL_ANCHOR_OVERFLOW');
  return next;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === '40001' || code === '40P01';
}

function fatalConnectionError(error: unknown): Error | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (
    code.startsWith('08') ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    /connection (?:error|terminated|closed)|server closed the connection/iu.test(message) ||
    /client (?:has encountered a connection error|was closed) and is not queryable/iu.test(message)
  ) {
    return asError(error);
  }
  return undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function defaultRetryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 5 : 20));
}
