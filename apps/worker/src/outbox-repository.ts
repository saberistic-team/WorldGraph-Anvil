import type { Pool, QueryResultRow } from 'pg';

import {
  HISTORY_SCHEMA_VERSION,
  type DomainEventEnvelopeV1,
  type LedgerEntryV1,
} from '@worldgraph/contracts';
import { projectWorldHistoryEntryV1 } from '@worldgraph/ledger';

import {
  commerceNotificationsForEvent,
  type CommerceRealtimePublisher,
} from './commerce-realtime.js';

export const WORLD_HISTORY_CONSUMER = 'world_history_v1';

export interface ClaimedOutboxMessage {
  attempts: number;
  createdAt: Date;
  eventId: string | null;
  id: string;
  messageSchemaVersion: number;
  messageType: string;
  payload: unknown;
  worldId: string;
}

export interface OutboxBacklog {
  dead: number;
  oldestReadyAgeMs: number;
  ready: number;
}

export interface OutboxRepository {
  claim(workerId: string, limit: number, leaseMs: number): Promise<ClaimedOutboxMessage[]>;
  inspectBacklog(): Promise<OutboxBacklog>;
  markFailed(
    message: ClaimedOutboxMessage,
    workerId: string,
    maximumAttempts: number,
    retryDelayMs: number,
  ): Promise<'dead' | 'lost_claim' | 'pending'>;
  publish(message: ClaimedOutboxMessage, workerId: string): Promise<boolean>;
}

interface OutboxRow extends QueryResultRow {
  attempts: number;
  created_at: Date;
  event_id: string | null;
  id: string;
  message_schema_version: number;
  message_type: string;
  payload: unknown;
  world_id: string;
}

function claimed(row: OutboxRow): ClaimedOutboxMessage {
  return {
    attempts: row.attempts,
    createdAt: row.created_at,
    eventId: row.event_id,
    id: row.id,
    messageSchemaVersion: row.message_schema_version,
    messageType: row.message_type,
    payload: row.payload,
    worldId: row.world_id,
  };
}

/**
 * PostgreSQL remains the durable queue. A lease may be reclaimed after worker
 * death, and completion is fenced by both worker id and attempt number.
 */
export class PostgresOutboxRepository implements OutboxRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly commerceRealtime?: CommerceRealtimePublisher,
  ) {}

  public async claim(
    workerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<ClaimedOutboxMessage[]> {
    const result = await this.pool.query<OutboxRow>(
      `with candidates as (
         select id
           from outbox_messages
          where status = 'pending'
            and available_at <= clock_timestamp()
            and (locked_at is null
              or locked_at < clock_timestamp() - ($3::integer * interval '1 millisecond'))
          order by available_at, created_at, id
          for update skip locked
          limit $2
       )
       update outbox_messages message
          set locked_at = clock_timestamp(), locked_by = $1, attempts = message.attempts + 1
         from candidates
        where message.id = candidates.id
       returning message.id, message.world_id, message.event_id, message.message_type,
                 message.message_schema_version, message.payload, message.attempts,
                 message.created_at`,
      [workerId, limit, leaseMs],
    );
    return result.rows.map(claimed);
  }

  public async inspectBacklog(): Promise<OutboxBacklog> {
    const result = await this.pool.query<{
      dead: string;
      oldest_ready_age_ms: number | null;
      ready: string;
    }>(
      `select count(*) filter (where status = 'pending' and available_at <= clock_timestamp())::text as ready,
              count(*) filter (where status = 'dead')::text as dead,
              coalesce(extract(epoch from (clock_timestamp() - min(created_at) filter
                (where status = 'pending' and available_at <= clock_timestamp()))) * 1000, 0)
                as oldest_ready_age_ms
         from outbox_messages`,
    );
    const row = result.rows[0];
    return {
      dead: Number(row?.dead ?? 0),
      oldestReadyAgeMs: Math.max(0, Number(row?.oldest_ready_age_ms ?? 0)),
      ready: Number(row?.ready ?? 0),
    };
  }

  public async markFailed(
    message: ClaimedOutboxMessage,
    workerId: string,
    maximumAttempts: number,
    retryDelayMs: number,
  ): Promise<'dead' | 'lost_claim' | 'pending'> {
    const terminal = message.attempts >= maximumAttempts;
    const result = await this.pool.query<{ status: 'dead' | 'pending' }>(
      `update outbox_messages
          set status = case when $4::boolean then 'dead'::outbox_message_status
                            else 'pending'::outbox_message_status end,
              available_at = case when $4::boolean then available_at
                else clock_timestamp() + ($5::integer * interval '1 millisecond') end,
              locked_at = null, locked_by = null,
              published_at = case when $4::boolean then null else published_at end
        where id = $1 and status = 'pending' and locked_by = $2 and attempts = $3
       returning status`,
      [message.id, workerId, message.attempts, terminal, retryDelayMs],
    );
    return result.rows[0]?.status ?? 'lost_claim';
  }

  public async publish(message: ClaimedOutboxMessage, workerId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const current = await client.query<{ event_id: string | null; message_type: string }>(
        `select event_id, message_type
           from outbox_messages
          where id = $1 and status = 'pending' and locked_by = $2 and attempts = $3
          for update`,
        [message.id, workerId, message.attempts],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query('rollback');
        return false;
      }
      if (row.message_type !== 'DomainEventReferenceV1' || !row.event_id) {
        throw new Error('OUTBOX_MESSAGE_TYPE_UNREGISTERED');
      }

      const event = await client.query<{
        aggregate_id: string;
        aggregate_type: string;
        aggregate_version: string;
        command_id: string;
        entry_hash: Buffer;
        entry_id: string;
        entry_kind: LedgerEntryV1['entryKind'];
        event_hash: Buffer;
        event_id: string;
        event_ordinal: number;
        event_recorded_at: Date;
        event_schema_version: number;
        event_type: string;
        ledger_actor_id: string;
        ledger_actor_type: LedgerEntryV1['actor']['actorType'];
        ledger_command_id: string | null;
        ledger_recorded_at: Date;
        ledger_sequence: string;
        metadata: Record<string, unknown>;
        occurred_at: Date;
        payload: Record<string, unknown>;
        previous_hash: Buffer;
        public_summary_code: string;
        redacted_details: Record<string, unknown>;
        resulting_state_revision: string;
        world_event_sequence: string;
        world_id: string;
      }>(
        `select event.id as event_id, event.world_event_sequence::text,
                event.command_id, event.event_ordinal, event.aggregate_id,
                event.aggregate_type, event.aggregate_version::text, event.event_type,
                event.event_schema_version, event.payload, event.metadata, event.event_hash,
                event.occurred_at, event.recorded_at as event_recorded_at,
                event.resulting_state_revision::text, event.world_id,
                ledger.id as entry_id, ledger.ledger_sequence::text, ledger.entry_kind,
                ledger.command_id as ledger_command_id, ledger.actor_type as ledger_actor_type,
                ledger.actor_id as ledger_actor_id, ledger.public_summary_code,
                ledger.redacted_details, ledger.previous_hash, ledger.entry_hash,
                ledger.recorded_at as ledger_recorded_at
           from domain_events event
           join ledger_entries ledger on ledger.event_id = event.id
          where event.id = $1 and event.world_id = $2`,
        [row.event_id, message.worldId],
      );
      const fact = event.rows[0];
      if (!fact) throw new Error('OUTBOX_EVENT_REFERENCE_INVALID');

      const domainEvent = {
        aggregateId: fact.aggregate_id,
        aggregateType: fact.aggregate_type,
        aggregateVersion: fact.aggregate_version,
        commandId: fact.command_id,
        eventHash: fact.event_hash.toString('hex'),
        eventId: fact.event_id,
        eventOrdinal: fact.event_ordinal,
        eventSchemaVersion: fact.event_schema_version,
        eventType: fact.event_type,
        metadata: fact.metadata,
        occurredAt: fact.occurred_at.toISOString(),
        payload: fact.payload,
        recordedAt: fact.event_recorded_at.toISOString(),
        resultingStateRevision: fact.resulting_state_revision,
        worldEventSequence: fact.world_event_sequence,
        worldId: fact.world_id,
      } as DomainEventEnvelopeV1;
      const ledgerEntry = {
        actor: { actorId: fact.ledger_actor_id, actorType: fact.ledger_actor_type },
        commandId: fact.ledger_command_id,
        entryHash: fact.entry_hash.toString('hex'),
        entryId: fact.entry_id,
        entryKind: fact.entry_kind,
        eventId: fact.event_id,
        ledgerSchemaVersion: 1,
        ledgerSequence: fact.ledger_sequence,
        previousHash: fact.previous_hash.toString('hex'),
        publicSummaryCode: fact.public_summary_code,
        recordedAt: fact.ledger_recorded_at.toISOString(),
        redactedDetails: fact.redacted_details,
        worldId: fact.world_id,
      } as LedgerEntryV1;
      const history = projectWorldHistoryEntryV1(domainEvent, ledgerEntry);

      await client.query(
        `insert into world_history_entries
          (world_id, ledger_sequence, command_id, event_id, event_type,
           history_schema_version, occurred_at, category, title_key,
           summary_args, actor_type, actor_id, target_type, target_id, visibility,
           correlation_id, resulting_state_revision)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::command_actor_type,$12,$13,$14,
                 $15::history_visibility,$16,$17)
         on conflict (world_id, ledger_sequence) do nothing`,
        [
          history.worldId,
          history.ledgerSequence,
          history.commandId,
          history.eventId,
          history.eventType,
          HISTORY_SCHEMA_VERSION,
          new Date(history.occurredAt),
          history.category,
          history.titleKey,
          JSON.stringify(history.summaryArgs),
          history.actor.actorType,
          history.actor.actorId,
          history.targetType,
          history.targetId,
          history.visibility,
          history.correlationId,
          history.resultingStateRevision,
        ],
      );
      const exact = await client.query<{ exact: boolean }>(
        `select (
           history.command_id is not distinct from $3::uuid
           and history.event_id is not distinct from $4::uuid
           and history.event_type is not distinct from $5::text
           and history.history_schema_version = $6
           and history.occurred_at = $7
           and history.category = $8
           and history.title_key = $9
           and history.summary_args = $10::jsonb
           and history.actor_type = $11::command_actor_type
           and history.actor_id = $12
           and history.target_type is not distinct from $13::text
           and history.target_id is not distinct from $14::text
           and history.visibility = $15::history_visibility
           and history.correlation_id = $16::uuid
           and history.resulting_state_revision is not distinct from $17::bigint
         ) as exact
           from world_history_entries history
          where history.world_id = $1 and history.ledger_sequence = $2::bigint`,
        [
          history.worldId,
          history.ledgerSequence,
          history.commandId,
          history.eventId,
          history.eventType,
          HISTORY_SCHEMA_VERSION,
          new Date(history.occurredAt),
          history.category,
          history.titleKey,
          JSON.stringify(history.summaryArgs),
          history.actor.actorType,
          history.actor.actorId,
          history.targetType,
          history.targetId,
          history.visibility,
          history.correlationId,
          history.resultingStateRevision,
        ],
      );
      if (exact.rows[0]?.exact !== true) throw new Error('OUTBOX_HISTORY_CONFLICT');
      if (this.commerceRealtime) {
        const notifications = await commerceNotificationsForEvent(client, domainEvent);
        for (const notification of notifications) {
          await this.commerceRealtime.publish(notification);
        }
      }
      await client.query(
        `insert into event_consumer_receipts(consumer_name,event_id)
         values ($1,$2) on conflict do nothing`,
        [WORLD_HISTORY_CONSUMER, row.event_id],
      );
      const published = await client.query(
        `update outbox_messages
            set status = 'published', published_at = clock_timestamp(),
                locked_at = null, locked_by = null
          where id = $1 and status = 'pending' and locked_by = $2 and attempts = $3`,
        [message.id, workerId, message.attempts],
      );
      if ((published.rowCount ?? 0) !== 1) {
        await client.query('rollback');
        return false;
      }
      await client.query('commit');
      return true;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
