import { describe, expect, it } from 'vitest';

import type { Pool } from '@worldgraph/db';

import {
  PostgresSimulationLeaseRepository,
  type SimulationLease,
} from './simulation-repository.js';

interface QueryCall {
  parameters: readonly unknown[] | undefined;
  text: string;
}

class FakePool {
  public readonly calls: QueryCall[] = [];
  public readonly responses: unknown[][] = [];

  public async query(text: string, parameters?: readonly unknown[]) {
    this.calls.push({ parameters, text });
    return { rows: this.responses.shift() ?? [] };
  }
}

const worldId = '078f0000-0000-7000-8000-000000000001';
const leasedUntil = new Date('2026-07-22T00:00:30.000Z');
const lease: SimulationLease = {
  fencingToken: '7',
  leaseOwner: 'simulation-worker-a',
  leasedUntil,
  worldId,
};

function repository(pool: FakePool): PostgresSimulationLeaseRepository {
  return new PostgresSimulationLeaseRepository(pool as unknown as Pool);
}

describe('PostgreSQL simulation lease repository', () => {
  it('discovers due running worlds in database-defined due-time and UUID order', async () => {
    const pool = new FakePool();
    const nextDueAt = new Date('2026-07-22T00:00:10.000Z');
    pool.responses.push([{ next_due_at: nextDueAt, world_id: worldId }]);

    await expect(repository(pool).discoverDueWorlds(25)).resolves.toEqual([{ nextDueAt, worldId }]);
    expect(pool.calls[0]?.text).toContain("clock.mode = 'running'");
    expect(pool.calls[0]?.text).toContain('order by next_due_at, clock.world_id');
    expect(pool.calls[0]?.parameters).toEqual([25]);
  });

  it('rejects unbounded discovery before querying PostgreSQL', async () => {
    const pool = new FakePool();
    await expect(repository(pool).discoverDueWorlds(101)).rejects.toThrow(
      'SIMULATION_DISCOVERY_LIMIT_INVALID',
    );
    expect(pool.calls).toEqual([]);
  });

  it('uses only security-definer lease functions and preserves the fencing epoch', async () => {
    const pool = new FakePool();
    pool.responses.push(
      [{ fencing_token: '7', leased_until: leasedUntil }],
      [{ fencing_token: '7', leased_until: leasedUntil }],
      [{ value: true }],
      [{ value: true }],
    );
    const adapter = repository(pool);

    await expect(adapter.acquireLease(worldId, 'simulation-worker-a', 30_000)).resolves.toEqual(
      lease,
    );
    await expect(adapter.renewLease(lease, 30_000)).resolves.toEqual(lease);
    await expect(adapter.isLeaseCurrent(lease)).resolves.toBe(true);
    await expect(adapter.releaseLease(lease)).resolves.toBe(true);

    expect(pool.calls.map((call) => call.text)).toEqual([
      expect.stringContaining('worldgraph_acquire_simulation_lease'),
      expect.stringContaining('worldgraph_renew_simulation_lease'),
      expect.stringContaining('worldgraph_simulation_lease_is_current'),
      expect.stringContaining('worldgraph_release_simulation_lease'),
    ]);
    expect(pool.calls[1]?.parameters).toEqual([worldId, 'simulation-worker-a', '7', 30_000]);
  });

  it('returns no authority when acquisition or renewal loses a race', async () => {
    const pool = new FakePool();
    pool.responses.push([], []);
    const adapter = repository(pool);

    await expect(adapter.acquireLease(worldId, 'simulation-worker-b', 30_000)).resolves.toBeNull();
    await expect(adapter.renewLease(lease, 30_000)).resolves.toBeNull();
  });

  it('loads a bounded candidate only while the exact owner/token remains current', async () => {
    const pool = new FakePool();
    pool.responses.push([
      {
        backlog_ticks: 80,
        expected_aggregate_version: '4',
        expected_state_revision: '9',
        expected_tick: '12',
        expected_world_version: '2',
        ticks: 64,
        world_id: worldId,
      },
    ]);

    await expect(repository(pool).loadAdvanceCandidate(lease)).resolves.toEqual({
      backlogTicks: 80,
      expectedAggregateVersion: '4',
      expectedStateRevision: '9',
      expectedTick: '12',
      expectedWorldVersion: '2',
      ticks: 64,
      worldId,
    });
    expect(pool.calls[0]?.text).toContain('worldgraph_simulation_lease_is_current');
    expect(pool.calls[0]?.text).toContain('stream.current_version');
    expect(pool.calls[0]?.text).toContain("checkpoint.projection_name = 'simulation_runtime'");
    expect(pool.calls[0]?.text).toContain('due_ticks between 1 and max_catch_up_ticks');
    expect(pool.calls[0]?.text).not.toContain(
      'clock.updated_state_revision = runtime.state_revision',
    );
    expect(pool.calls[0]?.text).toContain('offset 31 limit 1');
    expect(pool.calls[0]?.parameters).toEqual([worldId, 'simulation-worker-a', '7']);
  });

  it('bounds a dense notice backlog to a deterministic whole-tick prefix', async () => {
    const pool = new FakePool();
    pool.responses.push([
      {
        backlog_ticks: 3,
        expected_aggregate_version: '8',
        expected_state_revision: '21',
        expected_tick: '12',
        expected_world_version: '2',
        ticks: 2,
        world_id: worldId,
      },
    ]);

    await expect(repository(pool).loadAdvanceCandidate(lease)).resolves.toMatchObject({
      backlogTicks: 3,
      expectedAggregateVersion: '8',
      expectedStateRevision: '21',
      expectedTick: '12',
      ticks: 2,
    });
    expect(pool.calls[0]?.text).toContain('overflow_due_tick - expected_tick::bigint - 1');
  });

  it('fails closed instead of draining a catch-up window across repeated wakes', async () => {
    const pool = new FakePool();
    pool.responses.push([], []);
    const adapter = repository(pool);

    await expect(adapter.loadAdvanceCandidate(lease)).resolves.toBeNull();
    await expect(adapter.loadAdvanceCandidate(lease)).resolves.toBeNull();

    expect(pool.calls).toHaveLength(2);
    for (const call of pool.calls) {
      expect(call.text).toContain('due_ticks between 1 and max_catch_up_ticks');
      expect(call.parameters).toEqual([worldId, 'simulation-worker-a', '7']);
    }
  });

  it('fails closed on an invalid or over-budget database candidate', async () => {
    const pool = new FakePool();
    pool.responses.push([
      {
        backlog_ticks: 257,
        expected_aggregate_version: '4',
        expected_state_revision: '9',
        expected_tick: '12',
        expected_world_version: '2',
        ticks: 257,
        world_id: worldId,
      },
    ]);
    await expect(repository(pool).loadAdvanceCandidate(lease)).rejects.toThrow(
      'SIMULATION_ADVANCE_CANDIDATE_INVALID',
    );
  });
});
