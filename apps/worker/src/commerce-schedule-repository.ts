import type { Pool, QueryResultRow } from 'pg';

import type { CommerceScheduledCommandRequest } from '@worldgraph/economy-command';

type ScheduledEffectCandidate<T> = T extends CommerceScheduledCommandRequest
  ? Omit<T, 'commandId' | 'idempotencyKey'> & { currentTick: string }
  : never;

export type CommerceScheduledEffectCandidate =
  ScheduledEffectCandidate<CommerceScheduledCommandRequest>;

export interface CommerceScheduleRepository {
  findPendingEffects(limit: number): Promise<CommerceScheduledEffectCandidate[]>;
}

interface CommerceScheduleRow extends QueryResultRow {
  action_schema_version: number;
  action_type: CommerceScheduledCommandRequest['actionType'];
  completed_event_id: string;
  current_tick: string;
  due_tick: string;
  payload: unknown;
  process_version: string;
  schedule_sequence: string;
  scheduled_action_id: string;
  world_id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NONNEGATIVE_INT64 = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_INT64 = /^[1-9][0-9]{0,18}$/u;

/**
 * M7 completion is the durable trigger. Accepted system commands are linked
 * by the schedule's completion event and deterministic idempotency identity;
 * polling and competing workers therefore cannot create a second effect.
 */
export class PostgresCommerceScheduleRepository implements CommerceScheduleRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly disabledTaxPolicyIds: readonly string[] = [],
    private readonly worldIdScope?: string,
  ) {
    if (worldIdScope !== undefined && !UUID.test(worldIdScope)) {
      throw new Error('COMMERCE_SCHEDULE_WORLD_SCOPE_INVALID');
    }
  }

  public async findPendingEffects(limit: number): Promise<CommerceScheduledEffectCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
      throw new Error('COMMERCE_SCHEDULE_DISCOVERY_LIMIT_INVALID');
    }
    const result = await this.pool.query<CommerceScheduleRow>(
      `select action.world_id,
              action.id as scheduled_action_id,
              action.schedule_sequence::text,
              action.due_tick::text,
              action.action_type,
              action.action_schema_version,
              action.process_version,
              action.payload,
              action.completed_event_id,
              clock.current_tick::text
         from scheduled_actions action
         join worlds world on world.id = action.world_id
         join world_simulation_clocks clock on clock.world_id = action.world_id
        where world.lifecycle = 'active'
          and world.archived_at is null
          and action.status = 'completed'
          and action.completed_event_id is not null
          and action.action_type = any($1::text[])
          and action.action_schema_version = 1
          and action.process_version = '1.0.0'
          and ($3::uuid is null or action.world_id = $3::uuid)
          and case action.action_type
            when 'CompleteProductionRunV1' then exists (
              select 1 from production_runs run
               where run.world_id = action.world_id
                 and run.id = (action.payload ->> 'productionRunId')::uuid
                 and run.scheduled_action_id = action.id
                 and run.status = 'ready'
            )
            when 'SettlePayrollV1' then exists (
              select 1 from payroll_records payroll
               where payroll.world_id = action.world_id
                 and payroll.id = (action.payload ->> 'payrollRecordId')::uuid
                 and payroll.scheduled_action_id = action.id
                 and payroll.status = 'pending'
            )
            when 'ExpireMarketListingV1' then exists (
              select 1 from market_listings listing
               where listing.world_id = action.world_id
                 and listing.id = (action.payload ->> 'listingId')::uuid
                 and listing.scheduled_action_id = action.id
                 and listing.status = 'open'
            )
            when 'AssessPeriodicTaxV1' then exists (
              select 1 from worldgraph_tax_policy_effective_at_v2(
                action.world_id,'periodic_flat',clock.current_tick
              ) policy
               where policy.id = (action.payload ->> 'taxPolicyId')::uuid
                 and policy.status = 'active'
                 and not (policy.id = any($2::uuid[]))
            )
            else false
          end
          and not exists (
            select 1
              from command_records command
             where command.world_id = action.world_id
               and command.actor_type = 'system'
               and command.actor_id = 'worldgraph:commerce-scheduler'
               and command.command_type = action.action_type
               and command.causation_id = action.completed_event_id
               and command.status = 'accepted'
          )
        order by action.due_tick, action.priority, action.schedule_sequence, action.id
        limit $4`,
      [
        [
          'CompleteProductionRunV1',
          'SettlePayrollV1',
          'ExpireMarketListingV1',
          'AssessPeriodicTaxV1',
        ],
        this.disabledTaxPolicyIds,
        this.worldIdScope ?? null,
        limit,
      ],
    );
    return result.rows.map(mapCandidate);
  }
}

function mapCandidate(row: CommerceScheduleRow): CommerceScheduledEffectCandidate {
  if (
    !UUID.test(row.world_id) ||
    !UUID.test(row.scheduled_action_id) ||
    !UUID.test(row.completed_event_id) ||
    !NONNEGATIVE_INT64.test(row.current_tick) ||
    !NONNEGATIVE_INT64.test(row.due_tick) ||
    !POSITIVE_INT64.test(row.schedule_sequence) ||
    row.action_schema_version !== 1 ||
    row.process_version !== '1.0.0' ||
    BigInt(row.current_tick) < BigInt(row.due_tick)
  ) {
    throw new Error('COMMERCE_SCHEDULE_ROW_INVALID');
  }
  const targetId = targetIdFromPayload(row.action_type, row.payload);
  const common = {
    completedEventId: row.completed_event_id,
    currentTick: row.current_tick,
    dueTick: row.due_tick,
    scheduleSequence: row.schedule_sequence,
    scheduledActionId: row.scheduled_action_id,
    worldId: row.world_id,
  };
  switch (row.action_type) {
    case 'CompleteProductionRunV1':
      return { ...common, actionType: row.action_type, payload: { productionRunId: targetId } };
    case 'SettlePayrollV1':
      return { ...common, actionType: row.action_type, payload: { payrollRecordId: targetId } };
    case 'ExpireMarketListingV1':
      return { ...common, actionType: row.action_type, payload: { listingId: targetId } };
    case 'AssessPeriodicTaxV1':
      return { ...common, actionType: row.action_type, payload: { taxPolicyId: targetId } };
  }
}

function targetIdFromPayload(
  actionType: CommerceScheduledCommandRequest['actionType'],
  payload: unknown,
): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('COMMERCE_SCHEDULE_PAYLOAD_INVALID');
  }
  const record = payload as Record<string, unknown>;
  const key =
    actionType === 'CompleteProductionRunV1'
      ? 'productionRunId'
      : actionType === 'SettlePayrollV1'
        ? 'payrollRecordId'
        : actionType === 'ExpireMarketListingV1'
          ? 'listingId'
          : 'taxPolicyId';
  const value = record[key];
  if (Object.keys(record).length !== 1 || typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('COMMERCE_SCHEDULE_PAYLOAD_INVALID');
  }
  return value;
}
