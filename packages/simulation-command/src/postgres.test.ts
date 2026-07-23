import { describe, expect, it } from 'vitest';

import type { AdvanceSimulationCommandV1 } from '@worldgraph/contracts';
import type { Pool } from '@worldgraph/db';

import { PostgresSimulationAdvanceCommand, simulationAdvanceRequestHashV1 } from './postgres.js';
import type {
  FencedSimulationAdvanceRequest,
  SimulationAdvanceTelemetryV1,
  SimulationCommandObserver,
} from './types.js';

interface QueryCall {
  parameters: readonly unknown[] | undefined;
  text: string;
}

class FakeClient {
  public readonly calls: QueryCall[] = [];
  public readonly responses: Array<{ error?: Error; rowCount?: number; rows?: unknown[] }> = [];
  public released = false;
  public releasedWith: Error | undefined;

  public async query(text: string, parameters?: readonly unknown[]) {
    this.calls.push({ parameters, text });
    const response = this.responses.shift() ?? {};
    if (response.error) throw response.error;
    return { rowCount: response.rowCount ?? 0, rows: response.rows ?? [] };
  }

  public release(error?: Error): void {
    this.released = true;
    this.releasedWith = error;
  }
}

class FakePool {
  public constructor(public readonly client: FakeClient) {}
  public async connect(): Promise<FakeClient> {
    return this.client;
  }
}

const worldId = '078f0000-0000-7000-8000-000000000001';
const command: AdvanceSimulationCommandV1 = {
  commandId: '078f0000-0000-7000-8000-000000000002',
  expectedAggregateVersion: '3',
  expectedStateRevision: '8',
  expectedTick: '12',
  expectedWorldVersion: '2',
  idempotencyKey: 'simulation-auto.12.8.2',
  payload: { ticks: 2 },
  schemaVersion: 1,
  type: 'AdvanceSimulationV1',
};
const request: FencedSimulationAdvanceRequest = {
  command,
  leaseFencingToken: '7',
  leaseOwner: 'simulation-worker-a',
  worldId,
};

function adapter(
  client: FakeClient,
  observer?: SimulationCommandObserver,
): PostgresSimulationAdvanceCommand {
  return new PostgresSimulationAdvanceCommand(new FakePool(client) as unknown as Pool, {
    ids: { next: () => '078f0000-0000-7000-8000-000000000099' },
    ...(observer ? { observer } : {}),
  });
}

const telemetry: SimulationAdvanceTelemetryV1 = {
  executions: [],
  fromTick: '12',
  tickCount: 2,
  toTick: '14',
};

function replaceAdvanceTransaction(
  port: PostgresSimulationAdvanceCommand,
  commit: boolean,
  includeTelemetry = true,
): void {
  (
    port as unknown as {
      advanceTransaction(): Promise<{
        commit: boolean;
        result: { resultingTick: string; status: 'advanced' };
        telemetry?: SimulationAdvanceTelemetryV1;
      }>;
    }
  ).advanceTransaction = async () => ({
    commit,
    result: { resultingTick: '14', status: 'advanced' },
    ...(includeTelemetry ? { telemetry } : {}),
  });
}

describe('PostgreSQL fenced simulation command', () => {
  it('replays an exact accepted terminal before consulting an expired lease', async () => {
    const client = new FakeClient();
    client.responses.push(
      {},
      {},
      {
        rows: [
          {
            actor_id: 'worldgraph:simulation-worker',
            actor_type: 'system',
            command_type: 'AdvanceSimulationV1',
            id: command.commandId,
            idempotency_key: command.idempotencyKey,
            request_hash: simulationAdvanceRequestHashV1(worldId, command),
            response_summary: {
              commandId: command.commandId,
              eventIds: ['078f0000-0000-7000-8000-000000000010'],
              eventSequenceRange: { from: '9', to: '9' },
              ledgerSequenceRange: { from: '12', to: '13' },
              resultingStateRevision: '9',
              schemaVersion: 1,
              status: 'accepted',
            },
            status: 'accepted',
            world_id: worldId,
          },
        ],
      },
      {},
    );

    await expect(adapter(client).advance(request)).resolves.toEqual({
      resultingTick: '14',
      status: 'advanced',
    });
    expect(client.calls.some(({ text }) => text.includes('simulation_worker_leases'))).toBe(false);
    expect(client.calls.at(-1)?.text).toBe('rollback');
    expect(client.released).toBe(true);
  });

  it('rolls back a stale fencing tuple before inserting a command', async () => {
    const client = new FakeClient();
    client.responses.push({}, {}, { rows: [] }, { rows: [] }, { rows: [] }, {});

    await expect(adapter(client).advance(request)).resolves.toEqual({ status: 'fenced' });
    expect(client.calls.some(({ text }) => text.includes('insert into command_records'))).toBe(
      false,
    );
    expect(client.calls.at(-1)?.text).toBe('rollback');
  });

  it('discards a fatally terminated client without issuing an unsafe rollback', async () => {
    const client = new FakeClient();
    const fatal = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    client.responses.push({}, { error: fatal });

    await expect(adapter(client).advance(request)).rejects.toBe(fatal);
    expect(client.calls.map(({ text }) => text)).toEqual([
      'begin isolation level serializable',
      'select pg_advisory_xact_lock(hashtextextended($1,0))',
    ]);
    expect(client.releasedWith).toBe(fatal);
  });

  it('releases the database client before best-effort telemetry and ignores observer failures', async () => {
    const synchronousClient = new FakeClient();
    const releaseStates: boolean[] = [];
    const synchronous = adapter(synchronousClient, {
      onAdvanceCommitted() {
        releaseStates.push(synchronousClient.released);
        throw new Error('observer failed after commit');
      },
    });
    replaceAdvanceTransaction(synchronous, true);

    await expect(synchronous.advance(request)).resolves.toEqual({
      resultingTick: '14',
      status: 'advanced',
    });
    expect(releaseStates).toEqual([true]);

    const asynchronousClient = new FakeClient();
    const asynchronous = adapter(asynchronousClient, {
      onAdvanceCommitted: () => Promise.reject(new Error('async observer failed after commit')),
    });
    replaceAdvanceTransaction(asynchronous, true);
    await expect(asynchronous.advance(request)).resolves.toEqual({
      resultingTick: '14',
      status: 'advanced',
    });
    await Promise.resolve();

    const replayClient = new FakeClient();
    let replayObservations = 0;
    const replay = adapter(replayClient, {
      onAdvanceCommitted() {
        replayObservations += 1;
      },
    });
    replaceAdvanceTransaction(replay, false);
    await expect(replay.advance(request)).resolves.toEqual({
      resultingTick: '14',
      status: 'advanced',
    });
    expect(replayObservations).toBe(0);
  });
});
