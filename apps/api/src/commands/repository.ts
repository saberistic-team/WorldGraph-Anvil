import { createHash } from 'node:crypto';

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  HISTORY_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  SIMULATION_BATCH_SCHEMA_VERSION,
  SIMULATION_CLOCK_SCHEMA_VERSION,
  SIMULATION_FAILURE_SCHEMA_VERSION,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  SIMULATION_PROJECTION_SCHEMA_VERSION,
  SIMULATION_SCHEDULE_SCHEMA_VERSION,
  ScheduledActionV1Schema,
  SimulationBatchRunV1Schema,
  SimulationEventV1Schema,
  WorldSimulationClockV1Schema,
  createValidator,
  WorldCommandResultV1Schema,
  type DomainEventMetadataV1,
  type IdGenerator,
  type LedgerActorV1,
  type LedgerEntryV1,
  type ScheduledActionV1,
  type SimulationBatchRunV1,
  type SimulationEventV1,
  type SimulationFailureV1,
  type Validator,
  type WorldCommandResultV1,
  type WorldEntityRenamedEventV1,
  type WorldSimulationClockV1,
} from '@worldgraph/contracts';
import {
  computeDomainEventHashV1,
  computeLedgerEntryHashV1,
  LEDGER_GENESIS_PREVIOUS_HASH,
  type DomainEventHashInputV1,
} from '@worldgraph/ledger';
import { telemetry } from '@worldgraph/observability';
import { deriveWorldTimeV1 } from '@worldgraph/simulation';

import { ApplicationError, isPostgresError } from '../application/errors.js';
import { executePostgresCommerceCommand } from '../economy/commerce-command-executor.js';
import { executePostgresEconomyCommand } from '../economy/command-executor.js';
import type {
  WorldCommandResultTransport,
  WorldHistoryDetailTransport,
  WorldHistoryEntryTransport,
  WorldRuntimeHeadTransport,
  SimulationClockViewTransport,
  ScheduledActionPageTransport,
  SimulationBatchPageTransport,
} from './api-contracts.js';
import type {
  CommandEntityRecord,
  CommandRepository,
  CommandRejectionWrite,
  CommandTransaction,
  CommandWorldContext,
  CommerceCommandExecutionInput,
  EconomyCommandExecutionInput,
  HistoryReadInput,
  ReceivedCommandWrite,
  RenameAcceptanceWrite,
  ScheduledActionRecord,
  SimulationAcceptanceWrite,
  SimulationClockRecord,
  SimulationFailureRecord,
  StoredCommandIdentity,
} from './types.js';

interface Executor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

interface CommandRow extends QueryResultRow {
  actor_id: string;
  actor_type: StoredCommandIdentity['actorType'];
  command_type: string;
  id: string;
  idempotency_key: string;
  request_hash: Buffer;
  response_summary: unknown;
  status: StoredCommandIdentity['status'];
  world_id: string;
}

interface WorldRow extends QueryResultRow {
  active_world_version_id: string;
  anchor_artifact_hash: Buffer | null;
  design_version: string;
  ledger_anchored_at: Date | null;
  lifecycle: string;
  membership_role: CommandWorldContext['membershipRole'];
  membership_status: CommandWorldContext['membershipStatus'];
  state_revision: string;
  world_id: string;
}

interface EntityRow extends QueryResultRow {
  entity_schema_version: number;
  entity_type: CommandEntityRecord['entityType'];
  entity_version: string;
  logical_key: string;
  state: Record<string, unknown>;
  storage_row_version: string;
  world_id: string;
}

interface AllocationRow extends QueryResultRow {
  aggregate_version: string;
  last_entry_hash: Buffer | null;
  next_event_sequence: string;
  next_ledger_sequence: string;
}

interface RuntimeHeadRow extends QueryResultRow {
  active_world_version_id: string;
  anchor_artifact_hash: Buffer;
  checksum: Buffer;
  design_version: string;
  last_event_sequence: string;
  last_ledger_sequence: string;
  ledger_anchored_at: Date;
  projection_last_event_sequence: string;
  projection_schema_version: number;
  projection_status: WorldRuntimeHeadTransport['projection']['status'];
  projection_updated_at: Date;
  state_revision: string;
  world_id: string;
}

interface HistoryRow extends QueryResultRow {
  actor_id: string;
  actor_type: WorldHistoryEntryTransport['actor']['actorType'];
  category: WorldHistoryEntryTransport['category'];
  command_id: string | null;
  correlation_id: string;
  event_id: string | null;
  event_type: string | null;
  history_schema_version: 1;
  ledger_sequence: string;
  occurred_at: Date;
  resulting_state_revision: string | null;
  summary_args: WorldHistoryEntryTransport['summaryArgs'];
  target_id: string | null;
  target_type: string | null;
  title_key: string;
  visibility: WorldHistoryEntryTransport['visibility'];
  world_id: string;
}

interface SimulationClockRow extends QueryResultRow {
  active_world_version_id: string;
  aggregate_version: string;
  clock_schema_version: number;
  current_tick: string;
  design_version: string;
  epoch_at: Date;
  last_wall_anchor_at: Date | null;
  max_batch_ticks: number;
  max_catch_up_ticks: number;
  membership_role: string;
  mode: 'error' | 'paused' | 'running';
  outcome_hash: Buffer;
  prng_algorithm_version: string;
  projection_schema_version: number;
  projection_checksum: Buffer;
  row_version: string;
  state_revision: string;
  updated_at: Date;
  updated_state_revision: string;
  wall_cadence_milliseconds: number;
  world_id: string;
  world_milliseconds_per_tick: string;
  world_seed: string;
}

interface ScheduledActionRow extends QueryResultRow {
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
  process_version: '1.0.0';
  schedule_sequence: string;
  status: ScheduledActionV1['status'];
  updated_at: Date;
  world_id: string;
}

interface SimulationBatchRow extends QueryResultRow {
  attempts: number;
  batch_key: Buffer;
  batch_schema_version: number;
  command_id: string | null;
  completed_at: Date | null;
  error_code: string | null;
  from_tick: string;
  id: string;
  input_checksum: Buffer;
  outcome_hash: Buffer | null;
  process_registry_version: SimulationBatchRunV1['processRegistryVersion'];
  started_at: Date;
  status: SimulationBatchRunV1['status'];
  to_tick: string;
  world_id: string;
}

interface SimulationBatchIdentityRow extends QueryResultRow {
  id: string;
}

interface SimulationFailureRow extends QueryResultRow {
  aggregate_version: string;
  attempts: number;
  batch_run_id: string;
  error_code: string;
  failure_schema_version: number;
  id: string;
  opened_at: Date;
  process_type: 'EmitWorldNoticeV1';
  process_version: '1.0.0';
  redacted_context: SimulationFailureV1['redactedContext'];
  resolution_command_id: string | null;
  resolved_at: Date | null;
  resolved_by_actor_id: string | null;
  schedule_id: string | null;
  status: SimulationFailureV1['status'];
  tick: string;
  world_id: string;
}

const resultValidator = createValidator<WorldCommandResultV1>(WorldCommandResultV1Schema);
const simulationEventValidator = createValidator<SimulationEventV1>(SimulationEventV1Schema);
const simulationClockValidator = createValidator<WorldSimulationClockV1>(
  WorldSimulationClockV1Schema,
);
const scheduledActionValidator: Validator<ScheduledActionV1> =
  createValidator<ScheduledActionV1>(ScheduledActionV1Schema);
const simulationBatchValidator = createValidator<SimulationBatchRunV1>(SimulationBatchRunV1Schema);

export class PostgresCommandRepository implements CommandRepository, CommandTransaction {
  private economyCommandObserved = false;

  public constructor(
    private readonly pool: Pool,
    private readonly ids: IdGenerator,
    private readonly executor: Executor = pool,
  ) {}

  public async serializable<T>(
    operation: (transaction: CommandTransaction) => Promise<T>,
    worldId?: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client: PoolClient = await this.pool.connect();
      const commandLockKey = worldId ? `worldgraph-command-v1:${worldId}` : undefined;
      let advisoryLocked = false;
      let releaseError: Error | undefined;
      const transaction = new PostgresCommandRepository(this.pool, this.ids, client);
      try {
        if (commandLockKey) {
          await client.query('select pg_advisory_lock(hashtextextended($1,0))', [commandLockKey]);
          advisoryLocked = true;
        }
        await client.query('begin isolation level serializable');
        const result = await operation(transaction);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if (isPostgresError(error, '40001') || isPostgresError(error, '40P01')) {
          const failureClass = isPostgresError(error, '40P01') ? 'deadlock' : 'serialization';
          telemetry.commandSerializationRetries.add(1, {
            failure_class: failureClass,
            operation: 'command_transaction',
          });
          if (transaction.economyCommandObserved) {
            telemetry.economySerializationRetries.add(1, {
              failure_class: failureClass,
              operation: 'economy_command_transaction',
            });
          }
          if (attempt < 2) {
            await boundedRetryDelay(attempt);
            continue;
          }
          throw serializationRetryExhausted();
        }
        if (transaction.economyCommandObserved && isEconomyDatabaseInvariantFailure(error)) {
          telemetry.economyInvariantFindings.add(1, { check: 'database_constraint' });
        }
        throw error;
      } finally {
        if (advisoryLocked) {
          try {
            await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [
              commandLockKey,
            ]);
          } catch (error) {
            releaseError = error instanceof Error ? error : new Error('Advisory unlock failed.');
          }
        }
        client.release(releaseError);
      }
    }
    throw serializationRetryExhausted();
  }

  public async findCommandById(commandId: string): Promise<StoredCommandIdentity | null> {
    const result = await this.executor.query<CommandRow>(
      `select id, world_id, command_type, actor_type, actor_id, idempotency_key,
              request_hash, status, response_summary
         from command_records where id = $1 for update`,
      [commandId],
    );
    return result.rows[0] ? storedCommand(result.rows[0]) : null;
  }

  public async findCommandByIdempotency(input: {
    actorId: string;
    actorType: ReceivedCommandWrite['actorType'];
    commandType: string;
    idempotencyKey: string;
    worldId: string;
  }): Promise<StoredCommandIdentity | null> {
    const result = await this.executor.query<CommandRow>(
      `select id, world_id, command_type, actor_type, actor_id, idempotency_key,
              request_hash, status, response_summary
         from command_records
        where world_id = $1 and actor_type = $2 and actor_id = $3
          and command_type = $4 and idempotency_key = $5
        for update`,
      [input.worldId, input.actorType, input.actorId, input.commandType, input.idempotencyKey],
    );
    return result.rows[0] ? storedCommand(result.rows[0]) : null;
  }

  public async insertReceived(input: ReceivedCommandWrite): Promise<void> {
    this.economyCommandObserved = isEconomyCommandType(input.commandType);
    try {
      await this.executor.query(
        `insert into command_records(
           id, world_id, command_type, command_schema_version, actor_type, actor_id,
           payload, payload_hash, payload_classification, rate_limit_scope_hash,
           idempotency_key, request_hash,
           expected_world_version, expected_state_revision, expected_aggregate_version,
           correlation_id, causation_id, requested_at
         ) values (
           $1,$2,$3,$4,$5,$6,null,$7,$8,$9,$10,$11,$12::bigint,$13::bigint,$14::bigint,
           $15,$16,$17
         )`,
        [
          input.commandId,
          input.worldId,
          input.commandType,
          input.schemaVersion,
          input.actorType,
          input.actorId,
          input.payloadHash,
          input.payloadClassification,
          input.rateLimitScopeHash,
          input.idempotencyKey,
          input.requestHash,
          input.expectedWorldVersion,
          input.expectedStateRevision,
          input.expectedAggregateVersion,
          input.correlationId,
          input.causationId,
          input.requestedAt,
        ],
      );
    } catch (error) {
      if (isPostgresError(error, '23503')) this.notFound();
      if (isPostgresError(error, '55000')) {
        throw new ApplicationError(
          'WORLD_NOT_ANCHORED',
          'Authoritative world writes are unavailable until the ledger anchor is verified.',
          503,
        );
      }
      throw error;
    }
  }

  public async lockWorld(
    worldId: string,
    actorId: string,
    commandId: string,
  ): Promise<CommandWorldContext | null> {
    await this.executor.query('select worldgraph_open_command_write($1,$2)', [commandId, worldId]);
    const result = await this.executor.query<WorldRow>(
      `select world.id as world_id, world.lifecycle,
              runtime.active_world_version_id, runtime.state_revision::text,
              runtime.ledger_anchored_at, runtime.anchor_artifact_hash,
              version.version_number::text as design_version,
              membership.role as membership_role, membership.status as membership_status
         from worlds world
         join world_runtime_heads runtime on runtime.world_id = world.id
         join world_versions version on version.id = runtime.active_world_version_id
          and version.world_id = runtime.world_id
         left join world_memberships membership on membership.world_id = world.id
          and membership.user_id = $2
        where world.id = $1 and world.archived_at is null
        for update of runtime`,
      [worldId, actorId],
    );
    const row = result.rows[0];
    return row
      ? {
          activeWorldVersionId: row.active_world_version_id,
          anchorArtifactHash: row.anchor_artifact_hash?.toString('hex') ?? null,
          designVersion: row.design_version,
          ledgerAnchoredAt: row.ledger_anchored_at,
          lifecycle: row.lifecycle,
          membershipRole: row.membership_role,
          membershipStatus: row.membership_status,
          stateRevision: row.state_revision,
          worldId: row.world_id,
        }
      : null;
  }

  public async lockEntity(worldId: string, entityKey: string): Promise<CommandEntityRecord | null> {
    const result = await this.executor.query<EntityRow>(
      `select world_id, logical_key::text, entity_type, entity_schema_version, state,
              row_version::text as storage_row_version,
              (row_version + 1)::text as entity_version
         from world_entities
        where world_id = $1 and logical_key = $2 and retired_world_version_id is null
        for update`,
      [worldId, entityKey],
    );
    const row = result.rows[0];
    return row
      ? {
          entitySchemaVersion: row.entity_schema_version,
          entityType: row.entity_type,
          entityVersion: row.entity_version,
          logicalKey: row.logical_key,
          state: row.state,
          storageRowVersion: row.storage_row_version,
          worldId: row.world_id,
        }
      : null;
  }

  public async lockSimulationClock(worldId: string): Promise<SimulationClockRecord | null> {
    const result = await this.executor.query<SimulationClockRow>(
      `select clock.world_id, clock.clock_schema_version, clock.epoch_at,
              clock.current_tick::text, clock.world_milliseconds_per_tick::text,
              clock.wall_cadence_milliseconds, clock.mode, clock.max_batch_ticks,
              clock.max_catch_up_ticks, clock.prng_algorithm_version,
              clock.outcome_hash, clock.last_wall_anchor_at, clock.row_version::text,
              clock.updated_state_revision::text, clock.updated_at,
              stream.current_version::text as aggregate_version,
              checkpoint.projection_schema_version,
              checkpoint.checksum as projection_checksum,
              version.seed as world_seed,
              runtime.state_revision::text, runtime.active_world_version_id,
              version.version_number::text as design_version,
              'creator'::text as membership_role
         from world_simulation_clocks clock
         join world_runtime_heads runtime on runtime.world_id = clock.world_id
         join world_versions version on version.id = runtime.active_world_version_id
          and version.world_id = runtime.world_id
         join aggregate_stream_heads stream on stream.world_id = clock.world_id
          and stream.aggregate_type = 'simulation_clock'
          and stream.aggregate_id = clock.world_id::text
         join projection_checkpoints checkpoint on checkpoint.world_id = clock.world_id
          and checkpoint.projection_name = 'simulation_runtime'
        where clock.world_id = $1
          and checkpoint.projection_schema_version = 1
          and checkpoint.status = 'current'
          and checkpoint.last_event_sequence = runtime.last_event_sequence
          and checkpoint.checksum = worldgraph_simulation_projection_checksum(clock.world_id)
        for update of clock, checkpoint`,
      [worldId],
    );
    const row = result.rows[0];
    return row
      ? {
          aggregateVersion: row.aggregate_version,
          clock: simulationClock(row),
          projectionChecksum: row.projection_checksum.toString('hex'),
          worldSeed: row.world_seed,
        }
      : null;
  }

  public async lockScheduledAction(
    worldId: string,
    scheduleId: string,
  ): Promise<ScheduledActionRecord | null> {
    const result = await this.executor.query<ScheduledActionRow>(
      `${scheduledActionSelect()}
        where action.world_id = $1 and action.id = $2
        for update of action`,
      [worldId, scheduleId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const stream = await this.executor.query<{ aggregate_version: string }>(
      `select current_version::text as aggregate_version
        from aggregate_stream_heads
        where world_id = $1 and aggregate_type = 'scheduled_action' and aggregate_id = $2`,
      [worldId, scheduleId],
    );
    const aggregateVersion = stream.rows[0]?.aggregate_version;
    if (!aggregateVersion) this.notFound();
    return { action: scheduledAction(row), aggregateVersion };
  }

  public async lockSimulationFailure(
    worldId: string,
    failureId: string,
  ): Promise<SimulationFailureRecord | null> {
    const result = await this.executor.query<SimulationFailureRow>(
      `${simulationFailureSelect()}
        join aggregate_stream_heads stream on stream.world_id = failure.world_id
         and stream.aggregate_type = 'simulation_failure'
         and stream.aggregate_id = failure.id::text
       where failure.world_id = $1 and failure.id = $2
       for update of failure`,
      [worldId, failureId],
    );
    const row = result.rows[0];
    return row
      ? { aggregateVersion: row.aggregate_version, failure: simulationFailure(row) }
      : null;
  }

  public async lockDueScheduledActions(
    worldId: string,
    toTick: string,
  ): Promise<ScheduledActionV1[]> {
    const result = await this.executor.query<ScheduledActionRow>(
      `${scheduledActionSelect()}
        where action.world_id = $1 and action.status = 'scheduled'
          and action.due_tick <= $2::bigint
        order by action.due_tick, action.priority, action.schedule_sequence, action.id
        limit 32
        for update of action`,
      [worldId, toTick],
    );
    return result.rows.map(scheduledAction);
  }

  public async allocateScheduleSequence(worldId: string): Promise<string> {
    const result = await this.executor.query<{ schedule_sequence: string }>(
      'select worldgraph_allocate_schedule_sequence($1)::text as schedule_sequence',
      [worldId],
    );
    const value = result.rows[0]?.schedule_sequence;
    if (!value) this.notFound();
    return value;
  }

  public async countScheduledActionsAtTick(worldId: string, dueTick: string): Promise<number> {
    const result = await this.executor.query<{ count: string }>(
      `select count(*)::text as count from scheduled_actions
        where world_id = $1 and due_tick = $2::bigint and status = 'scheduled'`,
      [worldId, dueTick],
    );
    return boundedCount(result.rows[0]?.count);
  }

  public async countScheduledActionsForWorldAndActor(
    worldId: string,
    actorId: string,
  ): Promise<{ actorCount: number; worldCount: number }> {
    const result = await this.executor.query<{ actor_count: string; world_count: string }>(
      `select count(*)::text as world_count,
              count(*) filter (
                where created_by_actor_type = 'user' and created_by_actor_id = $2
              )::text as actor_count
         from scheduled_actions
        where world_id = $1 and status = 'scheduled'`,
      [worldId, actorId],
    );
    return {
      actorCount: boundedCount(result.rows[0]?.actor_count),
      worldCount: boundedCount(result.rows[0]?.world_count),
    };
  }

  public async acceptRename(input: RenameAcceptanceWrite): Promise<WorldCommandResultTransport> {
    const allocation = await this.allocation(input.command.worldId, input.entity.logicalKey);
    const recordedAt = canonicalTimestamp(input.decidedAt);
    const actor = commandActor(input.command);
    const metadata: DomainEventMetadataV1 = {
      actor,
      authorizationRuleId: input.authorizationRuleId,
      causationId: input.command.causationId,
      commandSchemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      commandType: input.command.commandType,
      correlationId: input.command.correlationId,
      overrideId: null,
      payloadClassification: input.command.payloadClassification,
    };
    const eventWithoutHash = {
      aggregateId: input.entity.logicalKey,
      aggregateType: 'world_entity' as const,
      aggregateVersion: allocation.aggregate_version,
      commandId: input.command.commandId,
      eventId: input.eventId,
      eventOrdinal: 0,
      eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
      eventType: input.eventType,
      metadata,
      occurredAt: recordedAt,
      payload: input.eventPayload as WorldEntityRenamedEventV1['payload'],
      recordedAt,
      resultingStateRevision: input.resultingStateRevision,
      worldEventSequence: allocation.next_event_sequence,
      worldId: input.command.worldId,
    };
    const eventHash = computeDomainEventHashV1(eventWithoutHash);
    await this.executor.query(
      `insert into domain_events(
         id, world_id, world_event_sequence, command_id, event_ordinal,
         aggregate_type, aggregate_id, aggregate_version, event_type,
         event_schema_version, payload, metadata, event_hash, occurred_at,
         recorded_at, resulting_state_revision
       ) values (
         $1,$2,$3::bigint,$4,0,$5,$6,$7::bigint,$8,$9,$10,$11,$12,$13,$13,$14::bigint
       )`,
      [
        input.eventId,
        input.command.worldId,
        allocation.next_event_sequence,
        input.command.commandId,
        eventWithoutHash.aggregateType,
        eventWithoutHash.aggregateId,
        eventWithoutHash.aggregateVersion,
        input.eventType,
        DOMAIN_EVENT_SCHEMA_VERSION,
        JSON.stringify(input.eventPayload),
        JSON.stringify(metadata),
        Buffer.from(eventHash, 'hex'),
        input.decidedAt,
        input.resultingStateRevision,
      ],
    );

    const acceptedEntry = this.ledgerEntry({
      actor,
      commandId: input.command.commandId,
      entryKind: 'command_accepted',
      eventId: null,
      ledgerSequence: allocation.next_ledger_sequence,
      previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
      publicSummaryCode: 'COMMAND_ACCEPTED',
      recordedAt,
      redactedDetails: {
        authorizationRuleId: input.authorizationRuleId,
        commandType: input.command.commandType,
      },
      worldId: input.command.worldId,
    });
    await this.insertLedgerEntry(acceptedEntry);
    const eventLedgerSequence = incrementDecimal(allocation.next_ledger_sequence);
    const eventEntry = this.ledgerEntry({
      actor,
      commandId: input.command.commandId,
      entryKind: 'domain_event',
      eventId: input.eventId,
      ledgerSequence: eventLedgerSequence,
      previousHash: acceptedEntry.entryHash,
      publicSummaryCode: 'WORLD_ENTITY_RENAMED',
      recordedAt,
      redactedDetails: {
        aggregateType: 'world_entity',
        eventType: input.eventType,
        targetHash: hashLogicalTarget(input.entity.logicalKey),
      },
      worldId: input.command.worldId,
    });
    await this.insertLedgerEntry(eventEntry);

    const projection = await this.executor.query(
      `update world_entities
          set state = $3, row_version = $4::bigint, updated_at = greatest(updated_at, $5)
        where world_id = $1 and logical_key = $2 and row_version = $6::bigint
          and retired_world_version_id is null
       returning logical_key`,
      [
        input.command.worldId,
        input.entity.logicalKey,
        JSON.stringify(input.nextState),
        decrementDecimal(input.resultingEntityVersion),
        input.decidedAt,
        input.entity.storageRowVersion,
      ],
    );
    if ((projection.rowCount ?? 0) !== 1) {
      throw new ApplicationError('AGGREGATE_VERSION_CONFLICT', 'The entity changed.', 409);
    }
    const checksumResult = await this.executor.query<{ checksum: Buffer }>(
      'select worldgraph_projection_checksum($1,$2::bigint) as checksum',
      [input.command.worldId, input.resultingStateRevision],
    );
    const checksum = checksumResult.rows[0]?.checksum;
    if (!checksum) throw new ApplicationError('INTERNAL_COMMAND_FAILED', 'Projection failed.', 500);

    await this.executor.query(
      `insert into projection_checkpoints(
         world_id, projection_name, projection_schema_version,
         last_event_sequence, checksum, status, updated_at
       ) values ($1,'world_graph',$2,$3::bigint,$4,'current',$5)
       on conflict (world_id, projection_name) do update
         set projection_schema_version = excluded.projection_schema_version,
             last_event_sequence = excluded.last_event_sequence,
             checksum = excluded.checksum,
             status = excluded.status,
             updated_at = greatest(projection_checkpoints.updated_at, excluded.updated_at)`,
      [
        input.command.worldId,
        PROJECTION_SCHEMA_VERSION,
        allocation.next_event_sequence,
        checksum,
        input.decidedAt,
      ],
    );
    await this.executor.query(
      `insert into outbox_messages(
         id, world_id, event_id, message_type, message_schema_version,
         payload, status, attempts, available_at, created_at
       ) values ($1,$2,$3,'DomainEventReferenceV1',$4,$5,'pending',0,$6,$6)`,
      [
        this.ids.next(),
        input.command.worldId,
        input.eventId,
        OUTBOX_SCHEMA_VERSION,
        JSON.stringify({
          eventId: input.eventId,
          eventType: input.eventType,
          worldEventSequence: allocation.next_event_sequence,
          worldId: input.command.worldId,
        }),
        input.decidedAt,
      ],
    );
    await this.executor.query(
      `update world_runtime_heads
          set state_revision = $2::bigint,
              last_ledger_sequence = $3::bigint,
              last_event_sequence = $4::bigint,
              projection_checksum = $5,
              updated_at = greatest(updated_at, $6)
        where world_id = $1`,
      [
        input.command.worldId,
        input.resultingStateRevision,
        eventLedgerSequence,
        allocation.next_event_sequence,
        checksum,
        input.decidedAt,
      ],
    );

    const result: WorldCommandResultTransport = {
      commandId: input.command.commandId,
      eventIds: [input.eventId],
      eventSequenceRange: {
        from: allocation.next_event_sequence,
        to: allocation.next_event_sequence,
      },
      ledgerSequenceRange: { from: allocation.next_ledger_sequence, to: eventLedgerSequence },
      resultingStateRevision: input.resultingStateRevision,
      schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      status: 'accepted',
    };
    await this.executor.query(
      `update command_records
          set status = 'accepted', authorization_rule_id = $2, decided_at = $3,
              resulting_state_revision = $4::bigint, response_summary = $5
        where id = $1 and status = 'received'`,
      [
        input.command.commandId,
        input.authorizationRuleId,
        input.decidedAt,
        input.resultingStateRevision,
        JSON.stringify(result),
      ],
    );
    return result;
  }

  public async acceptSimulation(
    input: SimulationAcceptanceWrite,
  ): Promise<WorldCommandResultTransport> {
    if (input.events.length < 1 || input.events.length > 64) {
      throw new ApplicationError(
        'SIMULATION_BUDGET_EXCEEDED',
        'A simulation command must emit between one and 64 facts.',
        409,
      );
    }
    if (
      (input.clock && !simulationClockValidator.is(input.clock)) ||
      (input.batch && !simulationBatchValidator.is(input.batch)) ||
      (input.scheduleCreates ?? []).some((action) => !scheduledActionValidator.is(action)) ||
      input.events.some(
        (event) =>
          !simulationEventValidator.is({
            eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
            eventType: event.eventType,
            payload: event.payload,
          }),
      )
    ) {
      throw new ApplicationError(
        'INTERNAL_COMMAND_FAILED',
        'The simulation command produced an invalid typed fact or projection.',
        500,
      );
    }
    const allocation = await this.allocation(input.command.worldId);
    const recordedAt = canonicalTimestamp(input.decidedAt);
    const actor = commandActor(input.command);
    const metadata: DomainEventMetadataV1 = {
      actor,
      authorizationRuleId: input.authorizationRuleId,
      causationId: input.command.causationId,
      commandSchemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      commandType: input.command.commandType,
      correlationId: input.command.correlationId,
      overrideId: null,
      payloadClassification: input.command.payloadClassification,
    };
    const persistedEvents: Array<{
      event: DomainEventHashInputV1;
      eventHash: string;
    }> = [];
    for (const [eventOrdinal, planned] of input.events.entries()) {
      const aggregateVersion = await this.nextAggregateVersion(
        input.command.worldId,
        planned.aggregateType,
        planned.aggregateId,
      );
      const event: DomainEventHashInputV1 = {
        aggregateId: planned.aggregateId,
        aggregateType: planned.aggregateType,
        aggregateVersion,
        commandId: input.command.commandId,
        eventId: planned.eventId,
        eventOrdinal,
        eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
        eventType: planned.eventType,
        metadata,
        occurredAt: recordedAt,
        payload: planned.payload,
        recordedAt,
        resultingStateRevision: input.resultingStateRevision,
        worldEventSequence: addDecimal(allocation.next_event_sequence, eventOrdinal),
        worldId: input.command.worldId,
      };
      const eventHash = computeDomainEventHashV1(event);
      await this.executor.query(
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
          input.decidedAt,
          event.resultingStateRevision,
        ],
      );
      persistedEvents.push({ event, eventHash });
    }

    const acceptedEntry = this.ledgerEntry({
      actor,
      commandId: input.command.commandId,
      entryKind: 'command_accepted',
      eventId: null,
      ledgerSequence: allocation.next_ledger_sequence,
      previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
      publicSummaryCode: 'COMMAND_ACCEPTED',
      recordedAt,
      redactedDetails: {
        authorizationRuleId: input.authorizationRuleId,
        commandType: input.command.commandType,
      },
      worldId: input.command.worldId,
    });
    await this.insertLedgerEntry(acceptedEntry);
    let previousHash = acceptedEntry.entryHash;
    for (const [index, persisted] of persistedEvents.entries()) {
      const entry = this.ledgerEntry({
        actor,
        commandId: input.command.commandId,
        entryKind: 'domain_event',
        eventId: persisted.event.eventId,
        ledgerSequence: addDecimal(allocation.next_ledger_sequence, index + 1),
        previousHash,
        publicSummaryCode: simulationSummaryCode(persisted.event.eventType),
        recordedAt,
        redactedDetails: {
          aggregateType: persisted.event.aggregateType,
          eventType: persisted.event.eventType,
          targetHash: hashLogicalTarget(persisted.event.aggregateId),
        },
        worldId: input.command.worldId,
      });
      await this.insertLedgerEntry(entry);
      previousHash = entry.entryHash;
    }

    if (input.clock) {
      const updated = await this.executor.query(
        `update world_simulation_clocks
            set epoch_at = $2, current_tick = $3::bigint,
                world_milliseconds_per_tick = $4::bigint,
                wall_cadence_milliseconds = $5, mode = $6,
                max_batch_ticks = $7, max_catch_up_ticks = $8,
                outcome_hash = $9, last_wall_anchor_at = $10,
                row_version = $11::bigint, updated_state_revision = $12::bigint,
                updated_at = greatest(updated_at, $13)
          where world_id = $1 and row_version + 1 = $11::bigint
         returning world_id`,
        [
          input.command.worldId,
          new Date(input.clock.configuration.epochAt),
          input.clock.currentTick,
          input.clock.configuration.worldMillisecondsPerTick,
          input.clock.configuration.wallCadenceMilliseconds,
          input.clock.mode,
          input.clock.configuration.maxBatchTicks,
          input.clock.configuration.maxCatchUpTicks,
          Buffer.from(input.clock.outcomeHash, 'hex'),
          input.clock.lastWallAnchorAt ? new Date(input.clock.lastWallAnchorAt) : null,
          input.clock.rowVersion,
          input.resultingStateRevision,
          input.decidedAt,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new ApplicationError('AGGREGATE_VERSION_CONFLICT', 'The clock changed.', 409);
      }
    }

    for (const action of input.scheduleCreates ?? []) {
      await this.executor.query(
        `insert into scheduled_actions(
           id, world_id, schedule_sequence, due_tick, priority, action_type,
           action_schema_version, payload, payload_hash, process_version,
           created_by_actor_type, created_by_actor_id, created_command_id,
           created_state_revision, created_at, updated_at
         ) values (
           $1,$2,$3::bigint,$4::bigint,$5,$6,$7,$8,$9,$10,
           $11,$12,$13,$14::bigint,$15,$15
         )`,
        [
          action.id,
          action.worldId,
          action.scheduleSequence,
          action.dueTick,
          action.priority,
          action.actionType,
          action.actionSchemaVersion,
          JSON.stringify(action.payload),
          Buffer.from(action.payloadHash, 'hex'),
          action.processVersion,
          action.createdBy.actorType,
          action.createdBy.actorId,
          action.createdCommandId,
          action.createdStateRevision,
          new Date(action.createdAt),
        ],
      );
    }
    for (const terminal of input.scheduleTerminals ?? []) {
      const updated = await this.executor.query(
        `update scheduled_actions
            set status = $3, cancelled_command_id = $4,
                completed_event_id = $5,
                completed_state_revision = $6::bigint,
                updated_at = greatest(updated_at, $7)
          where world_id = $1 and id = $2 and status = 'scheduled'
         returning id`,
        [
          input.command.worldId,
          terminal.id,
          terminal.status,
          terminal.cancelledCommandId,
          terminal.completedEventId,
          terminal.completedStateRevision,
          input.decidedAt,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new ApplicationError(
          'SCHEDULE_ALREADY_TERMINAL',
          'The scheduled action is already terminal.',
          409,
        );
      }
    }
    if (input.failureResolution) {
      const resolved = await this.executor.query(
        `update simulation_failures
            set status = 'resolved', resolved_by_actor_id = $3,
                resolved_at = $4, resolution_command_id = $5
          where world_id = $1 and id = $2 and status = 'open'
         returning id`,
        [
          input.command.worldId,
          input.failureResolution.failureId,
          input.failureResolution.resolvedByActorId,
          input.failureResolution.resolvedAt,
          input.failureResolution.resolutionCommandId,
        ],
      );
      if ((resolved.rowCount ?? 0) !== 1) {
        throw new ApplicationError(
          'AGGREGATE_VERSION_CONFLICT',
          'The simulation failure is already resolved.',
          409,
        );
      }
    }
    if (input.batch) {
      await this.completeSimulationBatch(input.batch, input.command.commandId, input.decidedAt);
    }

    const lastEventSequence = addDecimal(
      allocation.next_event_sequence,
      persistedEvents.length - 1,
    );
    const lastLedgerSequence = addDecimal(allocation.next_ledger_sequence, persistedEvents.length);
    const graphChecksumResult = await this.executor.query<{ checksum: Buffer }>(
      'select worldgraph_projection_checksum($1,$2::bigint) as checksum',
      [input.command.worldId, input.resultingStateRevision],
    );
    const simulationChecksumResult = await this.executor.query<{ checksum: Buffer }>(
      'select worldgraph_simulation_projection_checksum($1) as checksum',
      [input.command.worldId],
    );
    const graphChecksum = graphChecksumResult.rows[0]?.checksum;
    const simulationChecksum = simulationChecksumResult.rows[0]?.checksum;
    if (!graphChecksum || !simulationChecksum) {
      throw new ApplicationError('INTERNAL_COMMAND_FAILED', 'Projection failed.', 500);
    }
    await this.updateCheckpoint({
      checksum: graphChecksum,
      lastEventSequence,
      projectionName: 'world_graph',
      projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
      updatedAt: input.decidedAt,
      worldId: input.command.worldId,
    });
    await this.updateCheckpoint({
      checksum: simulationChecksum,
      lastEventSequence,
      projectionName: 'simulation_runtime',
      projectionSchemaVersion: SIMULATION_PROJECTION_SCHEMA_VERSION,
      updatedAt: input.decidedAt,
      worldId: input.command.worldId,
    });
    for (const persisted of persistedEvents) {
      await this.executor.query(
        `insert into outbox_messages(
           id, world_id, event_id, message_type, message_schema_version,
           payload, status, attempts, available_at, created_at
         ) values ($1,$2,$3,'DomainEventReferenceV1',$4,$5,'pending',0,$6,$6)`,
        [
          this.ids.next(),
          input.command.worldId,
          persisted.event.eventId,
          OUTBOX_SCHEMA_VERSION,
          JSON.stringify({
            eventId: persisted.event.eventId,
            eventType: persisted.event.eventType,
            worldEventSequence: persisted.event.worldEventSequence,
            worldId: input.command.worldId,
          }),
          input.decidedAt,
        ],
      );
    }
    await this.executor.query(
      `update world_runtime_heads
          set state_revision = $2::bigint, last_ledger_sequence = $3::bigint,
              last_event_sequence = $4::bigint, projection_checksum = $5,
              updated_at = greatest(updated_at, $6)
        where world_id = $1`,
      [
        input.command.worldId,
        input.resultingStateRevision,
        lastLedgerSequence,
        lastEventSequence,
        graphChecksum,
        input.decidedAt,
      ],
    );
    const result: WorldCommandResultTransport = {
      commandId: input.command.commandId,
      eventIds: persistedEvents.map(({ event }) => event.eventId),
      eventSequenceRange: { from: allocation.next_event_sequence, to: lastEventSequence },
      ledgerSequenceRange: { from: allocation.next_ledger_sequence, to: lastLedgerSequence },
      resultingStateRevision: input.resultingStateRevision,
      schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      status: 'accepted',
    };
    await this.executor.query(
      `update command_records
          set status = 'accepted', authorization_rule_id = $2, decided_at = $3,
              resulting_state_revision = $4::bigint, response_summary = $5
        where id = $1 and status = 'received'`,
      [
        input.command.commandId,
        input.authorizationRuleId,
        input.decidedAt,
        input.resultingStateRevision,
        JSON.stringify(result),
      ],
    );
    return result;
  }

  public async executeEconomy(
    input: EconomyCommandExecutionInput,
  ): Promise<WorldCommandResultTransport> {
    return executePostgresEconomyCommand(this.executor, this.ids, input);
  }

  public async executeCommerce(
    input: CommerceCommandExecutionInput,
  ): Promise<WorldCommandResultTransport> {
    return executePostgresCommerceCommand(this.executor, this.ids, input);
  }

  private async completeSimulationBatch(
    batch: SimulationBatchRunV1,
    commandId: string,
    decidedAt: Date,
  ): Promise<void> {
    const inputChecksum = Buffer.from(batch.inputChecksum, 'hex');
    const batchKey = Buffer.from(batch.batchKey, 'hex');
    const inserted = await this.executor.query<SimulationBatchIdentityRow>(
      `insert into simulation_batch_runs(
         id, world_id, batch_schema_version, from_tick, to_tick, batch_key,
         process_registry_version, input_checksum, status,
         attempts, error_code, started_at, completed_at
       ) values (
         $1,$2,$3,$4::bigint,$5::bigint,$6,$7,$8,'running',$9,null,$10,null
       )
       on conflict (world_id, from_tick, to_tick, input_checksum, process_registry_version)
       do nothing
       returning id`,
      [
        batch.id,
        batch.worldId,
        batch.batchSchemaVersion,
        batch.fromTick,
        batch.toTick,
        batchKey,
        batch.processRegistryVersion,
        inputChecksum,
        batch.attempts,
        new Date(batch.startedAt),
      ],
    );
    const completedAt = batch.completedAt ? new Date(batch.completedAt) : decidedAt;
    const outcomeHash = Buffer.from(batch.outcomeHash!, 'hex');
    const insertedBatchId = inserted.rows[0]?.id;
    const completed = insertedBatchId
      ? await this.executor.query<SimulationBatchIdentityRow>(
          `update simulation_batch_runs
              set outcome_hash = $3, status = 'completed', command_id = $4,
                  completed_at = $5
            where world_id = $1 and id = $2 and status = 'running'
           returning id`,
          [batch.worldId, insertedBatchId, outcomeHash, commandId, completedAt],
        )
      : await this.executor.query<SimulationBatchIdentityRow>(
          `update simulation_batch_runs
              set outcome_hash = $7, status = 'completed',
                  attempts = attempts + $8::integer, command_id = $9,
                  error_code = null, completed_at = $10
            where world_id = $1 and from_tick = $2::bigint and to_tick = $3::bigint
              and input_checksum = $4 and process_registry_version = $5
              and batch_key = $6 and status = 'failed'
              and attempts <= 100 - $8::integer
           returning id`,
          [
            batch.worldId,
            batch.fromTick,
            batch.toTick,
            inputChecksum,
            batch.processRegistryVersion,
            batchKey,
            outcomeHash,
            batch.attempts,
            commandId,
            completedAt,
          ],
        );
    if ((completed.rowCount ?? 0) !== 1) {
      throw new ApplicationError(
        'AGGREGATE_VERSION_CONFLICT',
        'The simulation batch identity cannot be completed.',
        409,
      );
    }
  }

  public async reject(input: CommandRejectionWrite): Promise<WorldCommandResultTransport> {
    const allocation = await this.allocation(input.command.worldId);
    const actor = commandActor(input.command);
    const recordedAt = canonicalTimestamp(input.decidedAt);
    const entry = this.ledgerEntry({
      actor,
      commandId: input.command.commandId,
      entryKind: 'command_rejected',
      eventId: null,
      ledgerSequence: allocation.next_ledger_sequence,
      previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
      publicSummaryCode: 'COMMAND_REJECTED',
      recordedAt,
      redactedDetails: {
        commandType: input.command.commandType,
        rejectionCode: input.code,
        ...(input.redactedTargetHash ? { targetHash: input.redactedTargetHash } : {}),
      },
      worldId: input.command.worldId,
    });
    await this.insertLedgerEntry(entry);

    const current = await this.executor.query<{ state_revision: string }>(
      `update world_runtime_heads
          set last_ledger_sequence = $2::bigint, updated_at = greatest(updated_at, $3)
        where world_id = $1
       returning state_revision::text`,
      [input.command.worldId, allocation.next_ledger_sequence, input.decidedAt],
    );
    const currentStateRevision = input.currentStateRevision ?? current.rows[0]?.state_revision;
    if (currentStateRevision === undefined) this.notFound();
    const result: WorldCommandResultTransport = {
      commandId: input.command.commandId,
      currentStateRevision,
      eventIds: [],
      rejectionCode: input.code,
      schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      status: 'rejected',
    };

    if (input.historyTargetId)
      await this.executor.query(
        `insert into world_history_entries(
         world_id, ledger_sequence, command_id, event_id, event_type,
         history_schema_version, occurred_at, category, title_key, summary_args,
         actor_type, actor_id, target_type, target_id, visibility, correlation_id,
         resulting_state_revision
       ) values (
         $1,$2::bigint,$3,null,null,$4,$5,'command','history.command.rejected',$6,
         $7,$8,'world_entity',$9,'creator',$10,null
       )`,
        [
          input.command.worldId,
          allocation.next_ledger_sequence,
          input.command.commandId,
          HISTORY_SCHEMA_VERSION,
          input.decidedAt,
          JSON.stringify({
            commandType: input.command.commandType,
            entityKey: input.historyTargetId,
            rejectionCode: input.code,
          }),
          input.command.actorType,
          input.command.actorId,
          input.historyTargetId,
          input.command.correlationId,
        ],
      );
    await this.executor.query(
      `update command_records
          set status = 'rejected', rejection_code = $2,
              authorization_rule_id = $3, decided_at = $4, response_summary = $5
        where id = $1 and status = 'received'`,
      [
        input.command.commandId,
        input.code,
        input.authorizationRuleId,
        input.decidedAt,
        JSON.stringify(result),
      ],
    );
    return result;
  }

  public async getCommand(
    actorId: string,
    commandId: string,
  ): Promise<WorldCommandResultTransport | null> {
    const result = await this.executor.query<CommandRow>(
      `select command.id, command.world_id, command.command_type, command.actor_type,
              command.actor_id, command.idempotency_key, command.request_hash,
              command.status, command.response_summary
         from command_records command
        where command.id = $2
          and (
            command.actor_id = $1::text
            or exists (
              select 1 from world_memberships membership
              where membership.world_id = command.world_id
                and membership.user_id = $1::uuid and membership.status = 'active'
            )
          )`,
      [actorId, commandId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const stored = storedCommand(row);
    return stored.result ?? receivedResult(stored.commandId);
  }

  public async getRuntimeHead(
    actorId: string,
    worldId: string,
  ): Promise<WorldRuntimeHeadTransport | null> {
    const result = await this.executor.query<RuntimeHeadRow>(
      `select runtime.world_id, runtime.active_world_version_id,
              version.version_number::text as design_version,
              runtime.state_revision::text, runtime.last_ledger_sequence::text,
              runtime.last_event_sequence::text, runtime.ledger_anchored_at,
              runtime.anchor_artifact_hash,
              checkpoint.projection_schema_version,
              checkpoint.last_event_sequence::text as projection_last_event_sequence,
              checkpoint.checksum, checkpoint.status as projection_status,
              checkpoint.updated_at as projection_updated_at
         from world_runtime_heads runtime
         join world_versions version on version.id = runtime.active_world_version_id
          and version.world_id = runtime.world_id
         join projection_checkpoints checkpoint on checkpoint.world_id = runtime.world_id
          and checkpoint.projection_name = 'world_graph'
         join world_memberships membership on membership.world_id = runtime.world_id
          and membership.user_id = $2 and membership.status = 'active'
        where runtime.world_id = $1 and runtime.ledger_anchored_at is not null`,
      [worldId, actorId],
    );
    const row = result.rows[0];
    return row
      ? {
          activeWorldVersionId: row.active_world_version_id,
          anchorArtifactHash: row.anchor_artifact_hash.toString('hex'),
          designVersion: row.design_version,
          lastEventSequence: row.last_event_sequence,
          lastLedgerSequence: row.last_ledger_sequence,
          ledgerAnchoredAt: row.ledger_anchored_at.toISOString(),
          projection: {
            checksum: row.checksum.toString('hex'),
            lastEventSequence: row.projection_last_event_sequence,
            schemaVersion: row.projection_schema_version,
            status: row.projection_status,
            updatedAt: row.projection_updated_at.toISOString(),
          },
          stateRevision: row.state_revision,
          worldId: row.world_id,
        }
      : null;
  }

  public async getSimulationClock(
    actorId: string,
    worldId: string,
  ): Promise<SimulationClockViewTransport | null> {
    const result = await this.executor.query<SimulationClockRow>(
      `select clock.world_id, clock.clock_schema_version,
              clock.epoch_at, clock.current_tick::text,
              clock.world_milliseconds_per_tick::text,
              clock.wall_cadence_milliseconds, clock.mode,
              clock.max_batch_ticks, clock.max_catch_up_ticks,
              clock.prng_algorithm_version, clock.outcome_hash, clock.last_wall_anchor_at,
              clock.row_version::text, clock.updated_state_revision::text,
              clock.updated_at, runtime.state_revision::text,
              runtime.active_world_version_id,
              version.version_number::text as design_version,
              membership.role as membership_role,
              stream.current_version::text as aggregate_version,
              $3::integer as projection_schema_version
         from world_simulation_clocks clock
         join worlds world on world.id = clock.world_id
          and world.lifecycle = 'active' and world.archived_at is null
         join world_runtime_heads runtime on runtime.world_id = clock.world_id
         join world_versions version on version.id = runtime.active_world_version_id
          and version.world_id = runtime.world_id
         join world_memberships membership on membership.world_id = clock.world_id
          and membership.user_id = $2 and membership.status = 'active'
         join aggregate_stream_heads stream on stream.world_id = clock.world_id
          and stream.aggregate_type = 'simulation_clock'
          and stream.aggregate_id = clock.world_id::text
        where clock.world_id = $1`,
      [worldId, actorId, SIMULATION_PROJECTION_SCHEMA_VERSION],
    );
    const row = result.rows[0];
    if (!row) return null;
    const [nextDueAction, batchResult, backlogResult] = await Promise.all([
      this.executor.query<ScheduledActionRow>(
        `${scheduledActionSelect()}
          where action.world_id = $1 and action.status = 'scheduled'
            and action.due_tick > $2::bigint
            and ($3::boolean or action.payload ->> 'visibility' in ('public','member'))
          order by action.due_tick, action.priority, action.schedule_sequence, action.id
          limit 1`,
        [worldId, row.current_tick, row.membership_role === 'creator'],
      ),
      this.executor.query<SimulationBatchRow>(
        `${simulationBatchSelect()}
          where batch.world_id = $1
          order by batch.started_at desc, batch.id desc
          limit 1`,
        [worldId],
      ),
      this.executor.query<{ count: string }>(
        `select case
           when last_wall_anchor_at is null or mode <> 'running' then '0'
           else greatest(0, floor(
             extract(epoch from (statement_timestamp() - last_wall_anchor_at))
               * 1000 / wall_cadence_milliseconds
           ))::bigint::text
         end as count
           from world_simulation_clocks
          where world_id = $1`,
        [worldId],
      ),
    ]);
    const clock = simulationClock(row);
    return {
      aggregateVersion: row.aggregate_version,
      backlogCount: boundedCount(backlogResult.rows[0]?.count),
      canManage: row.membership_role === 'creator',
      canSchedule: row.membership_role === 'creator' || row.membership_role === 'administrator',
      clock,
      degradedWake: false,
      designVersion: row.design_version,
      lastBatch: batchResult.rows[0] ? simulationBatch(batchResult.rows[0]) : null,
      nextDueAction: nextDueAction.rows[0] ? scheduledAction(nextDueAction.rows[0]) : null,
      stateRevision: row.state_revision,
      worldTime: deriveWorldTimeV1(
        clock.configuration.epochAt,
        clock.currentTick,
        clock.configuration.worldMillisecondsPerTick,
      ),
    };
  }

  public async getScheduledAction(
    actorId: string,
    worldId: string,
    scheduleId: string,
  ): Promise<ScheduledActionV1 | null> {
    const result = await this.executor.query<ScheduledActionRow>(
      `${scheduledActionSelect()}
        join world_memberships membership on membership.world_id = action.world_id
         and membership.user_id = $2 and membership.status = 'active'
        join worlds world on world.id = action.world_id
         and world.lifecycle = 'active' and world.archived_at is null
       where action.world_id = $1 and action.id = $3
         and (membership.role = 'creator'
           or action.payload ->> 'visibility' in ('public','member'))`,
      [worldId, actorId, scheduleId],
    );
    return result.rows[0] ? scheduledAction(result.rows[0]) : null;
  }

  public async listScheduledActions(input: {
    actorId: string;
    query: { cursor?: string; limit?: number; status?: string };
    worldId: string;
  }): Promise<ScheduledActionPageTransport | null> {
    const membership = await this.executor.query<{ role: string }>(
      `select membership.role::text as role from world_memberships membership
        join worlds world on world.id = membership.world_id
       where membership.world_id = $1 and membership.user_id = $2
         and membership.status = 'active' and world.lifecycle = 'active'
         and world.archived_at is null`,
      [input.worldId, input.actorId],
    );
    if ((membership.rowCount ?? 0) !== 1) return null;
    const limit = Math.min(100, Math.max(1, Number(input.query.limit ?? 50)));
    const offset = parseListOffset(input.query.cursor);
    const status = scheduledStatus(input.query.status);
    const result = await this.executor.query<ScheduledActionRow>(
      `${scheduledActionSelect()}
        where action.world_id = $1 and ($2::text is null or action.status::text = $2)
          and ($5::boolean or action.payload ->> 'visibility' in ('public','member'))
        order by action.due_tick, action.priority, action.schedule_sequence, action.id
        offset $3 limit $4`,
      [input.worldId, status, offset, limit + 1, membership.rows[0]?.role === 'creator'],
    );
    const hasMore = result.rows.length > limit;
    return {
      items: result.rows.slice(0, limit).map(scheduledAction),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  }

  public async listSimulationBatches(input: {
    actorId: string;
    query: { cursor?: string; limit?: number; status?: string };
    worldId: string;
  }): Promise<SimulationBatchPageTransport | null> {
    const membership = await this.executor.query(
      `select 1 from world_memberships membership
        join worlds world on world.id = membership.world_id
       where membership.world_id = $1 and membership.user_id = $2
         and membership.status = 'active' and world.lifecycle = 'active'
         and world.archived_at is null`,
      [input.worldId, input.actorId],
    );
    if ((membership.rowCount ?? 0) !== 1) return null;
    const limit = Math.min(100, Math.max(1, Number(input.query.limit ?? 20)));
    const offset = parseListOffset(input.query.cursor);
    const status = batchStatus(input.query.status);
    const result = await this.executor.query<SimulationBatchRow>(
      `${simulationBatchSelect()}
        where batch.world_id = $1 and ($2::text is null or batch.status::text = $2)
        order by batch.started_at desc, batch.id desc
        offset $3 limit $4`,
      [input.worldId, status, offset, limit + 1],
    );
    const failures = await this.executor.query<SimulationFailureRow>(
      `${simulationFailureSelect()}
        join aggregate_stream_heads stream on stream.world_id = failure.world_id
         and stream.aggregate_type = 'simulation_failure'
         and stream.aggregate_id = failure.id::text
       where failure.world_id = $1
       order by (failure.status = 'open') desc, failure.opened_at desc, failure.id desc
       limit 100`,
      [input.worldId],
    );
    const hasMore = result.rows.length > limit;
    return {
      failures: failures.rows.map(simulationFailure),
      items: result.rows.slice(0, limit).map(simulationBatch),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  }

  public async listHistory(input: HistoryReadInput): Promise<WorldHistoryEntryTransport[]> {
    const result = await this.executor.query<HistoryRow>(
      `select history.*
         from world_history_entries history
         join world_memberships membership on membership.world_id = history.world_id
          and membership.user_id = $2 and membership.status = 'active'
        where history.world_id = $1
          and (
            history.visibility in ('public','member')
            or (history.visibility = 'creator' and membership.role = 'creator')
            or (history.visibility = 'operator' and $3::boolean)
            or (history.visibility = 'participant' and exists (
              select 1 from economy_participant_history participant
               where participant.world_id = history.world_id
                 and participant.ledger_sequence = history.ledger_sequence
                 and participant.user_id = $2
            ))
          )
          and ($4::bigint is null or history.ledger_sequence < $4::bigint)
          and ($5::text is null or history.actor_id = $5::text)
          and ($6::text is null or history.category = $6)
          and ($7::text is null or history.event_type = $7)
          and ($8::text is null or history.target_id = $8)
          and ($9::text is null or history.target_type = $9)
        order by history.ledger_sequence desc
        limit $10`,
      [
        input.worldId,
        input.actorId,
        input.platformAdmin,
        input.beforeLedgerSequence ?? null,
        input.query.actorId ?? null,
        input.query.category ?? null,
        input.query.eventType ?? null,
        input.query.targetId ?? null,
        input.query.targetType ?? null,
        input.limit,
      ],
    );
    return result.rows.map(historyEntry);
  }

  public async getHistoryEntry(
    actorId: string,
    platformAdmin: boolean,
    worldId: string,
    ledgerSequence: string,
  ): Promise<WorldHistoryDetailTransport | null> {
    const result = await this.executor.query<HistoryRow & QueryResultRow>(
      `select history.*,
              command.command_type, command.command_schema_version,
              command.expected_world_version::text,
              command.expected_state_revision::text,
              command.expected_aggregate_version::text,
              command.status as command_status,
              command.authorization_rule_id, command.override_id,
              command.requested_at, command.decided_at,
              event.aggregate_type, event.aggregate_id, event.aggregate_version::text,
              event.event_schema_version, event.world_event_sequence::text
         from world_history_entries history
         join world_memberships membership on membership.world_id = history.world_id
          and membership.user_id = $2 and membership.status = 'active'
         left join command_records command on command.id = history.command_id
          and command.world_id = history.world_id
         left join domain_events event on event.id = history.event_id
          and event.world_id = history.world_id
        where history.world_id = $1 and history.ledger_sequence = $3::bigint
          and (
            history.visibility in ('public','member')
            or (history.visibility = 'creator' and membership.role = 'creator')
            or (history.visibility = 'operator' and $4::boolean)
            or (history.visibility = 'participant' and exists (
              select 1 from economy_participant_history participant
               where participant.world_id = history.world_id
                 and participant.ledger_sequence = history.ledger_sequence
                 and participant.user_id = $2
            ))
          )`,
      [worldId, actorId, ledgerSequence, platformAdmin],
    );
    const row = result.rows[0] as (HistoryRow & Record<string, unknown>) | undefined;
    if (!row) return null;
    const entry = historyEntry(row);
    return {
      command: row.command_id
        ? {
            authorizationRuleId: (row.authorization_rule_id as string | null) ?? null,
            commandId: row.command_id,
            commandType: row.command_type as string,
            decidedAt: (row.decided_at as Date | null)?.toISOString() ?? null,
            expectedAggregateVersion: (row.expected_aggregate_version as string | null) ?? null,
            expectedStateRevision: (row.expected_state_revision as string | null) ?? '0',
            expectedWorldVersion: (row.expected_world_version as string | null) ?? '1',
            overrideId: (row.override_id as string | null) ?? null,
            requestedAt: (row.requested_at as Date).toISOString(),
            schemaVersion: Number(row.command_schema_version),
            status: row.command_status as 'accepted' | 'failed' | 'received' | 'rejected',
          }
        : null,
      entry,
      event: row.event_id
        ? {
            aggregateId: row.aggregate_id as string,
            aggregateType: row.aggregate_type as string,
            aggregateVersion: row.aggregate_version as string,
            eventId: row.event_id,
            eventSchemaVersion: Number(row.event_schema_version),
            eventType: row.event_type!,
            worldEventSequence: row.world_event_sequence as string,
          }
        : null,
      projection: { resultingStateRevision: row.resulting_state_revision },
    };
  }

  private async allocation(worldId: string, aggregateId?: string): Promise<AllocationRow> {
    const result = await this.executor.query<AllocationRow>(
      `select ledger.next_event_sequence::text, ledger.next_ledger_sequence::text,
              ledger.last_entry_hash,
              coalesce(stream.current_version + 1, 1)::text as aggregate_version
         from world_ledger_heads ledger
         left join aggregate_stream_heads stream on stream.world_id = ledger.world_id
          and stream.aggregate_type = 'world_entity' and stream.aggregate_id = $2
        where ledger.world_id = $1`,
      [worldId, aggregateId ?? 'world'],
    );
    const row = result.rows[0];
    if (!row) this.notFound();
    return row;
  }

  private async nextAggregateVersion(
    worldId: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<string> {
    const result = await this.executor.query<{ next_version: string }>(
      `select coalesce((
         select current_version + 1 from aggregate_stream_heads
          where world_id = $1 and aggregate_type = $2 and aggregate_id = $3
       ), 1)::text as next_version`,
      [worldId, aggregateType, aggregateId],
    );
    const value = result.rows[0]?.next_version;
    if (!value) this.notFound();
    return value;
  }

  private async updateCheckpoint(input: {
    checksum: Buffer;
    lastEventSequence: string;
    projectionName: string;
    projectionSchemaVersion: number;
    updatedAt: Date;
    worldId: string;
  }): Promise<void> {
    await this.executor.query(
      `insert into projection_checkpoints(
         world_id, projection_name, projection_schema_version,
         last_event_sequence, checksum, status, updated_at
       ) values ($1,$2,$3,$4::bigint,$5,'current',$6)
       on conflict (world_id, projection_name) do update
         set projection_schema_version = excluded.projection_schema_version,
             last_event_sequence = excluded.last_event_sequence,
             checksum = excluded.checksum, status = excluded.status,
             updated_at = greatest(projection_checkpoints.updated_at, excluded.updated_at)`,
      [
        input.worldId,
        input.projectionName,
        input.projectionSchemaVersion,
        input.lastEventSequence,
        input.checksum,
        input.updatedAt,
      ],
    );
  }

  private ledgerEntry(
    input: Omit<LedgerEntryV1, 'entryHash' | 'entryId' | 'ledgerSchemaVersion'>,
  ): LedgerEntryV1 {
    const withoutHash = {
      ...input,
      entryId: this.ids.next(),
      ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    };
    return { ...withoutHash, entryHash: computeLedgerEntryHashV1(withoutHash) } as LedgerEntryV1;
  }

  private async insertLedgerEntry(entry: LedgerEntryV1): Promise<void> {
    await this.executor.query(
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

  private notFound(): never {
    throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
  }
}

function storedCommand(row: CommandRow): StoredCommandIdentity {
  return {
    actorId: row.actor_id,
    actorType: row.actor_type,
    commandId: row.id,
    commandType: row.command_type,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    result: resultValidator.is(row.response_summary) ? row.response_summary : null,
    status: row.status,
    worldId: row.world_id,
  };
}

function receivedResult(commandId: string): WorldCommandResultTransport {
  return {
    commandId,
    eventIds: [],
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    status: 'received',
  };
}

function commandActor(command: ReceivedCommandWrite): LedgerActorV1 {
  return { actorId: command.actorId, actorType: command.actorType };
}

function historyEntry(row: HistoryRow): WorldHistoryEntryTransport {
  return {
    actor: {
      actorId: row.actor_id,
      actorType: row.actor_type,
    },
    category: row.category,
    commandId: row.command_id,
    correlationId: row.correlation_id,
    eventId: row.event_id,
    eventType: row.event_type,
    historySchemaVersion: row.history_schema_version,
    ledgerSequence: row.ledger_sequence,
    occurredAt: row.occurred_at.toISOString(),
    resultingStateRevision: row.resulting_state_revision,
    summaryArgs: row.summary_args,
    targetId: row.target_id,
    targetType: row.target_type,
    titleKey: row.title_key,
    visibility: row.visibility,
    worldId: row.world_id,
  };
}

function scheduledActionSelect(): string {
  return `select action.id, action.world_id, action.schedule_sequence::text,
                 action.due_tick::text, action.priority, action.action_type,
                 action.action_schema_version, action.process_version, action.payload,
                 action.payload_hash, action.status, action.created_command_id,
                 action.cancelled_command_id, action.completed_event_id,
                 action.created_by_actor_type, action.created_by_actor_id,
                 action.created_state_revision::text,
                 action.completed_state_revision::text,
                 action.created_at, action.updated_at
            from scheduled_actions action`;
}

function simulationBatchSelect(): string {
  return `select batch.id, batch.world_id, batch.batch_key, batch.from_tick::text,
                 batch.to_tick::text, batch.input_checksum, batch.outcome_hash,
                 batch.process_registry_version, batch.batch_schema_version,
                 batch.status, batch.command_id, batch.attempts, batch.error_code,
                 batch.started_at, batch.completed_at
            from simulation_batch_runs batch`;
}

function simulationFailureSelect(): string {
  return `select failure.id, failure.world_id, failure.failure_schema_version,
                 failure.batch_run_id, failure.tick::text, failure.schedule_id,
                 failure.process_type, failure.process_version, failure.error_code,
                 failure.redacted_context, failure.attempts, failure.status,
                 failure.opened_at, failure.resolved_by_actor_id, failure.resolved_at,
                 failure.resolution_command_id,
                 stream.current_version::text as aggregate_version
            from simulation_failures failure`;
}

function simulationClock(row: SimulationClockRow): WorldSimulationClockV1 {
  const worldMillisecondsPerTick = safeInteger(
    row.world_milliseconds_per_tick,
    'world_milliseconds_per_tick',
  );
  return {
    clockSchemaVersion: SIMULATION_CLOCK_SCHEMA_VERSION,
    configuration: {
      epochAt: row.epoch_at.toISOString(),
      maxBatchTicks: row.max_batch_ticks,
      maxCatchUpTicks: row.max_catch_up_ticks,
      prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
      wallCadenceMilliseconds: row.wall_cadence_milliseconds,
      worldMillisecondsPerTick,
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
    createdBy: {
      actorId: row.created_by_actor_id,
      actorType: row.created_by_actor_type,
    },
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

function simulationBatch(row: SimulationBatchRow): SimulationBatchRunV1 {
  return {
    attempts: row.attempts,
    batchKey: row.batch_key.toString('hex'),
    batchSchemaVersion: SIMULATION_BATCH_SCHEMA_VERSION,
    commandId: row.command_id,
    completedAt: row.completed_at?.toISOString() ?? null,
    errorCode: row.error_code,
    fromTick: row.from_tick,
    id: row.id,
    inputChecksum: row.input_checksum.toString('hex'),
    outcomeHash: row.outcome_hash?.toString('hex') ?? null,
    processRegistryVersion: 1,
    startedAt: row.started_at.toISOString(),
    status: row.status,
    toTick: row.to_tick,
    worldId: row.world_id,
  };
}

function simulationFailure(row: SimulationFailureRow): SimulationFailureV1 {
  return {
    aggregateVersion: row.aggregate_version,
    attempts: row.attempts,
    batchRunId: row.batch_run_id,
    errorCode: row.error_code,
    failureSchemaVersion: SIMULATION_FAILURE_SCHEMA_VERSION,
    id: row.id,
    openedAt: row.opened_at.toISOString(),
    processType: row.process_type,
    processVersion: row.process_version,
    redactedContext: row.redacted_context,
    resolutionCommandId: row.resolution_command_id,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedByActorId: row.resolved_by_actor_id,
    scheduleId: row.schedule_id,
    status: row.status,
    tick: row.tick,
    worldId: row.world_id,
  };
}

function parseListOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]{0,5})$/.test(cursor)) {
    throw new ApplicationError('INVALID_CURSOR', 'The pagination cursor is invalid.', 400);
  }
  return Number(cursor);
}

function scheduledStatus(value: string | undefined): ScheduledActionV1['status'] | null {
  if (value === undefined) return null;
  if (value === 'scheduled' || value === 'completed' || value === 'cancelled' || value === 'failed')
    return value;
  throw new ApplicationError('INVALID_QUERY', 'The schedule status filter is invalid.', 400);
}

function batchStatus(value: string | undefined): SimulationBatchRunV1['status'] | null {
  if (value === undefined) return null;
  if (value === 'running' || value === 'completed' || value === 'failed') return value;
  throw new ApplicationError('INVALID_QUERY', 'The batch status filter is invalid.', 400);
}

function boundedCount(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, 100_000) : 100_000;
}

function safeInteger(value: string, column: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApplicationError(
      'INTERNAL_COMMAND_FAILED',
      `The stored ${column} value is outside the supported range.`,
      500,
    );
  }
  return parsed;
}

function canonicalTimestamp(value: Date): string {
  return value.toISOString();
}

function incrementDecimal(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

function addDecimal(value: string, amount: number): string {
  return (BigInt(value) + BigInt(amount)).toString(10);
}

function decrementDecimal(value: string): string {
  return (BigInt(value) - 1n).toString(10);
}

function hashLogicalTarget(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function simulationSummaryCode(eventType: string): string {
  return eventType
    .replace(/V[1-9][0-9]*$/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toUpperCase();
}

async function boundedRetryDelay(attempt: number): Promise<void> {
  const milliseconds = attempt === 0 ? 5 : 20;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serializationRetryExhausted(): ApplicationError {
  return new ApplicationError(
    'SERIALIZATION_RETRY_EXHAUSTED',
    'The command could not be ordered safely. Retry with the same command identity.',
    503,
  );
}

function isEconomyCommandType(commandType: string): boolean {
  return new Set([
    'AcceptAssetTransferOfferV1',
    'AdoptLegacyEconomySeedPlanV1',
    'CancelAssetTransferOfferV1',
    'CreateAssetTransferOfferV1',
    'FreezeCurrencyV1',
    'FreezeWalletV1',
    'InitializeWorldEconomyV1',
    'IssueCurrencyV1',
    'ReconcileWorldEconomyV1',
    'TransferAssetV1',
    'TransferCurrencyV1',
    'UnfreezeCurrencyV1',
    'UnfreezeWalletV1',
  ]).has(commandType);
}

function isEconomyDatabaseInvariantFailure(error: unknown): boolean {
  return ['23503', '23505', '23514', '55000'].some((code) => isPostgresError(error, code));
}
