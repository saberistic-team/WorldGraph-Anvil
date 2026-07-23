import { MAX_SIMULATION_BATCH_TICKS, MAX_SIMULATION_CATCH_UP_TICKS } from '@worldgraph/contracts';
import type { Pool } from '@worldgraph/db';

export interface DueSimulationWorld {
  nextDueAt: Date;
  worldId: string;
}

export interface SimulationLease {
  fencingToken: string;
  leaseOwner: string;
  leasedUntil: Date;
  worldId: string;
}

export interface SimulationAdvanceCandidate {
  backlogTicks: number;
  expectedAggregateVersion: string;
  expectedStateRevision: string;
  expectedTick: string;
  expectedWorldVersion: string;
  ticks: number;
  worldId: string;
}

export interface SimulationLeaseRepository {
  acquireLease(
    worldId: string,
    leaseOwner: string,
    leaseMs: number,
  ): Promise<SimulationLease | null>;
  discoverDueWorlds(limit: number): Promise<DueSimulationWorld[]>;
  isLeaseCurrent(lease: SimulationLease): Promise<boolean>;
  loadAdvanceCandidate(lease: SimulationLease): Promise<SimulationAdvanceCandidate | null>;
  releaseLease(lease: SimulationLease): Promise<boolean>;
  renewLease(lease: SimulationLease, leaseMs: number): Promise<SimulationLease | null>;
}

interface DueWorldRow {
  next_due_at: Date;
  world_id: string;
}

interface LeaseRow {
  fencing_token: string;
  leased_until: Date;
}

interface BooleanRow {
  value: boolean;
}

interface AdvanceCandidateRow {
  backlog_ticks: number;
  expected_aggregate_version: string;
  expected_state_revision: string;
  expected_tick: string;
  expected_world_version: string;
  ticks: number;
  world_id: string;
}

function isCanonicalInteger(value: string, positive: boolean): boolean {
  if (!/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) return false;
  return !positive || value !== '0';
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function assertLeaseInput(lease: SimulationLease): void {
  if (
    !lease.worldId ||
    !lease.leaseOwner ||
    !isCanonicalInteger(lease.fencingToken, true) ||
    !isValidDate(lease.leasedUntil)
  ) {
    throw new Error('SIMULATION_LEASE_INVALID');
  }
}

function mapLease(
  row: LeaseRow | undefined,
  worldId: string,
  leaseOwner: string,
): SimulationLease | null {
  if (!row) return null;
  if (!isCanonicalInteger(row.fencing_token, true) || !isValidDate(row.leased_until)) {
    throw new Error('SIMULATION_LEASE_ROW_INVALID');
  }
  return {
    fencingToken: row.fencing_token,
    leaseOwner,
    leasedUntil: row.leased_until,
    worldId,
  };
}

/**
 * PostgreSQL owns due discovery and fencing epochs. Redis/BullMQ callers may
 * wake reconciliation, but cannot create, renew, or validate a lease.
 */
export class PostgresSimulationLeaseRepository implements SimulationLeaseRepository {
  public constructor(private readonly pool: Pool) {}

  public async discoverDueWorlds(limit: number): Promise<DueSimulationWorld[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('SIMULATION_DISCOVERY_LIMIT_INVALID');
    }
    const result = await this.pool.query<DueWorldRow>(
      `select clock.world_id,
              clock.last_wall_anchor_at
                + clock.wall_cadence_milliseconds * interval '1 millisecond' as next_due_at
         from world_simulation_clocks clock
         join worlds world on world.id = clock.world_id
        where world.lifecycle = 'active'
          and clock.mode = 'running'
          and clock.last_wall_anchor_at is not null
          and clock.last_wall_anchor_at
                + clock.wall_cadence_milliseconds * interval '1 millisecond'
              <= statement_timestamp()
        order by next_due_at, clock.world_id
        limit $1`,
      [limit],
    );
    return result.rows.map((row) => {
      if (!row.world_id || !isValidDate(row.next_due_at)) {
        throw new Error('SIMULATION_DISCOVERY_ROW_INVALID');
      }
      return { nextDueAt: row.next_due_at, worldId: row.world_id };
    });
  }

  public async acquireLease(
    worldId: string,
    leaseOwner: string,
    leaseMs: number,
  ): Promise<SimulationLease | null> {
    const result = await this.pool.query<LeaseRow>(
      `select fencing_token::text, leased_until
         from worldgraph_acquire_simulation_lease($1,$2,$3)`,
      [worldId, leaseOwner, leaseMs],
    );
    return mapLease(result.rows[0], worldId, leaseOwner);
  }

  public async renewLease(
    lease: SimulationLease,
    leaseMs: number,
  ): Promise<SimulationLease | null> {
    assertLeaseInput(lease);
    const result = await this.pool.query<LeaseRow>(
      `with renewed as (
         select worldgraph_renew_simulation_lease($1,$2,$3::bigint,$4) as renewed
       )
       select lease.fencing_token::text, lease.leased_until
         from renewed
         join simulation_worker_leases lease
           on lease.world_id = $1
          and lease.lease_owner = $2
          and lease.fencing_token = $3::bigint
        where renewed.renewed`,
      [lease.worldId, lease.leaseOwner, lease.fencingToken, leaseMs],
    );
    return mapLease(result.rows[0], lease.worldId, lease.leaseOwner);
  }

  public async releaseLease(lease: SimulationLease): Promise<boolean> {
    assertLeaseInput(lease);
    const result = await this.pool.query<BooleanRow>(
      `select worldgraph_release_simulation_lease($1,$2,$3::bigint) as value`,
      [lease.worldId, lease.leaseOwner, lease.fencingToken],
    );
    return result.rows[0]?.value === true;
  }

  public async isLeaseCurrent(lease: SimulationLease): Promise<boolean> {
    assertLeaseInput(lease);
    const result = await this.pool.query<BooleanRow>(
      `select worldgraph_simulation_lease_is_current($1,$2,$3::bigint) as value`,
      [lease.worldId, lease.leaseOwner, lease.fencingToken],
    );
    return result.rows[0]?.value === true;
  }

  public async loadAdvanceCandidate(
    lease: SimulationLease,
  ): Promise<SimulationAdvanceCandidate | null> {
    assertLeaseInput(lease);
    const result = await this.pool.query<AdvanceCandidateRow>(
      `with candidate as (
         select clock.world_id,
                stream.current_version::text as expected_aggregate_version,
                runtime.state_revision::text as expected_state_revision,
                clock.current_tick::text as expected_tick,
                version.version_number::text as expected_world_version,
                clock.max_batch_ticks,
                clock.max_catch_up_ticks,
                floor(
                  extract(epoch from (statement_timestamp() - clock.last_wall_anchor_at))
                    * 1000 / clock.wall_cadence_milliseconds
                ) as due_ticks
           from world_simulation_clocks clock
           join worlds world on world.id = clock.world_id
           join world_runtime_heads runtime on runtime.world_id = clock.world_id
           join world_versions version
             on version.id = runtime.active_world_version_id
            and version.world_id = runtime.world_id
           join aggregate_stream_heads stream
             on stream.world_id = clock.world_id
            and stream.aggregate_type = 'simulation_clock'
            and stream.aggregate_id = clock.world_id::text
           join projection_checkpoints checkpoint
             on checkpoint.world_id = clock.world_id
            and checkpoint.projection_name = 'simulation_runtime'
          where clock.world_id = $1
            and world.lifecycle = 'active'
            and clock.mode = 'running'
            and clock.last_wall_anchor_at is not null
            and checkpoint.status = 'current'
            and checkpoint.last_event_sequence = runtime.last_event_sequence
            and checkpoint.checksum = worldgraph_simulation_projection_checksum(clock.world_id)
            and worldgraph_simulation_lease_is_current($1,$2,$3::bigint)
       ), bounded as (
         select candidate.*,
                least(due_ticks, max_batch_ticks)::bigint as maximum_ticks
           from candidate
          where due_ticks between 1 and max_catch_up_ticks
       ), capacity as (
         select bounded.*, overflow.due_tick as overflow_due_tick
           from bounded
           left join lateral (
             select action.due_tick
               from scheduled_actions action
              where action.world_id = bounded.world_id
                and action.status = 'scheduled'
                and action.due_tick > bounded.expected_tick::bigint
                and action.due_tick::numeric
                    <= bounded.expected_tick::numeric + bounded.maximum_ticks
              order by action.due_tick, action.priority,
                       action.schedule_sequence, action.id
              offset 31 limit 1
           ) overflow on true
       )
       select world_id, due_ticks::integer as backlog_ticks,
              expected_aggregate_version, expected_state_revision,
              expected_tick, expected_world_version,
              case when overflow_due_tick is null then maximum_ticks
                   else overflow_due_tick - expected_tick::bigint - 1
              end::integer as ticks
         from capacity
        where overflow_due_tick is null
           or overflow_due_tick::numeric > expected_tick::numeric + 1`,
      [lease.worldId, lease.leaseOwner, lease.fencingToken],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      row.world_id !== lease.worldId ||
      !Number.isSafeInteger(row.backlog_ticks) ||
      row.backlog_ticks < 1 ||
      row.backlog_ticks > MAX_SIMULATION_CATCH_UP_TICKS ||
      !isCanonicalInteger(row.expected_aggregate_version, true) ||
      !isCanonicalInteger(row.expected_state_revision, false) ||
      !isCanonicalInteger(row.expected_tick, false) ||
      !isCanonicalInteger(row.expected_world_version, true) ||
      !Number.isSafeInteger(row.ticks) ||
      row.ticks < 1 ||
      row.ticks > MAX_SIMULATION_BATCH_TICKS
    ) {
      throw new Error('SIMULATION_ADVANCE_CANDIDATE_INVALID');
    }
    return {
      backlogTicks: row.backlog_ticks,
      expectedAggregateVersion: row.expected_aggregate_version,
      expectedStateRevision: row.expected_state_revision,
      expectedTick: row.expected_tick,
      expectedWorldVersion: row.expected_world_version,
      ticks: row.ticks,
      worldId: row.world_id,
    };
  }
}
