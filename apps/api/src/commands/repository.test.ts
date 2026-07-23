import type { Pool, PoolClient, QueryResult } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SimulationBatchRunV1 } from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';

import { PostgresCommandRepository } from './repository.js';
import type { ReceivedCommandWrite } from './types.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';

afterEach(() => vi.restoreAllMocks());

describe('PostgresCommandRepository transaction retry policy', () => {
  it.each(['40001', '40P01'] as const)(
    'retries %s once with the same bounded world lock and fresh transaction',
    async (code) => {
      const harness = poolHarness();
      const repository = new PostgresCommandRepository(harness.pool, { next: () => worldId });
      const retryMetric = vi
        .spyOn(telemetry.commandSerializationRetries, 'add')
        .mockImplementation(() => undefined);
      let attempt = 0;
      const operation = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw postgresError(code);
        return 'committed';
      });

      await expect(repository.serializable(operation, worldId)).resolves.toBe('committed');

      expect(operation).toHaveBeenCalledTimes(2);
      expect(harness.connectionCount()).toBe(2);
      expect(harness.sql()).toEqual([
        'select pg_advisory_lock(hashtextextended($1,0))',
        'begin isolation level serializable',
        'rollback',
        'select pg_advisory_unlock(hashtextextended($1,0))',
        'select pg_advisory_lock(hashtextextended($1,0))',
        'begin isolation level serializable',
        'commit',
        'select pg_advisory_unlock(hashtextextended($1,0))',
      ]);
      expect(harness.releases).toHaveLength(2);
      expect(retryMetric).toHaveBeenCalledWith(1, {
        failure_class: code === '40P01' ? 'deadlock' : 'serialization',
        operation: 'command_transaction',
      });
    },
  );

  it('returns a stable retry-exhausted application error after three serialization failures', async () => {
    const harness = poolHarness();
    const repository = new PostgresCommandRepository(harness.pool, { next: () => worldId });
    const operation = vi.fn(async () => {
      throw postgresError('40001');
    });

    await expect(repository.serializable(operation, worldId)).rejects.toMatchObject({
      code: 'SERIALIZATION_RETRY_EXHAUSTED',
      statusCode: 503,
    });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(harness.sql().filter((sql) => sql === 'rollback')).toHaveLength(3);
    expect(harness.releases).toHaveLength(3);
  });

  it('counts the terminal deadlock attempt when the bounded retry budget is exhausted', async () => {
    const harness = poolHarness();
    const repository = new PostgresCommandRepository(harness.pool, { next: () => worldId });
    const retryMetric = vi
      .spyOn(telemetry.commandSerializationRetries, 'add')
      .mockImplementation(() => undefined);

    await expect(
      repository.serializable(async () => {
        throw postgresError('40P01');
      }, worldId),
    ).rejects.toMatchObject({ code: 'SERIALIZATION_RETRY_EXHAUSTED' });

    expect(retryMetric).toHaveBeenCalledTimes(3);
    expect(retryMetric).toHaveBeenLastCalledWith(1, {
      failure_class: 'deadlock',
      operation: 'command_transaction',
    });
  });

  it.each(['23503', '23505', '23514', '55000'])(
    'records a database invariant finding for economy failure %s',
    async (code) => {
      const harness = poolHarness();
      const repository = new PostgresCommandRepository(harness.pool, { next: () => worldId });
      const metric = vi
        .spyOn(telemetry.economyInvariantFindings, 'add')
        .mockImplementation(() => undefined);

      await expect(
        repository.serializable(async (transaction) => {
          await transaction.insertReceived(economyCommand());
          throw postgresError(code);
        }, worldId),
      ).rejects.toMatchObject({ code });

      expect(metric).toHaveBeenCalledOnce();
      expect(metric).toHaveBeenCalledWith(1, { check: 'database_constraint' });
    },
  );

  it('does not record retryable economy serialization failures as invariant findings', async () => {
    const harness = poolHarness();
    const repository = new PostgresCommandRepository(harness.pool, { next: () => worldId });
    const metric = vi
      .spyOn(telemetry.economyInvariantFindings, 'add')
      .mockImplementation(() => undefined);
    const retryMetric = vi
      .spyOn(telemetry.economySerializationRetries, 'add')
      .mockImplementation(() => undefined);

    await expect(
      repository.serializable(async (transaction) => {
        await transaction.insertReceived(economyCommand());
        throw postgresError('40001');
      }, worldId),
    ).rejects.toMatchObject({ code: 'SERIALIZATION_RETRY_EXHAUSTED' });

    expect(metric).not.toHaveBeenCalled();
    expect(retryMetric).toHaveBeenCalledTimes(3);
    expect(retryMetric).toHaveBeenCalledWith(1, {
      failure_class: 'serialization',
      operation: 'economy_command_transaction',
    });
  });
});

describe('PostgresCommandRepository command rate scope persistence', () => {
  it('writes the server-derived target hash without persisting the private payload', async () => {
    const query = vi.fn().mockResolvedValue(result([]));
    const repository = new PostgresCommandRepository(
      {} as Pool,
      { next: () => worldId },
      { query },
    );
    const scopeHash = Buffer.alloc(32, 3);
    const command = {
      ...economyCommand(),
      commandType: 'PurchaseMarketListingV1',
      rateLimitScopeHash: scopeHash,
    };

    await repository.insertReceived(command);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      'payload, payload_hash, payload_classification, rate_limit_scope_hash',
    );
    expect(query.mock.calls[0]?.[0]).toContain('$1,$2,$3,$4,$5,$6,null,$7,$8,$9');
    expect(query.mock.calls[0]?.[1]).toEqual([
      command.commandId,
      command.worldId,
      command.commandType,
      command.schemaVersion,
      command.actorType,
      command.actorId,
      command.payloadHash,
      command.payloadClassification,
      scopeHash,
      command.idempotencyKey,
      command.requestHash,
      command.expectedWorldVersion,
      command.expectedStateRevision,
      command.expectedAggregateVersion,
      command.correlationId,
      command.causationId,
      command.requestedAt,
    ]);
  });
});

describe('PostgresCommandRepository simulation read privacy', () => {
  it('applies notice visibility before schedule pagination for non-creators', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ role: 'member' }]))
      .mockResolvedValueOnce(result([]));
    const repository = new PostgresCommandRepository(
      {} as Pool,
      { next: () => worldId },
      { query },
    );

    await expect(
      repository.listScheduledActions({
        actorId: '018f8652-3cb6-7d52-904b-cce7901d7e21',
        query: { cursor: '0', limit: 20 },
        worldId,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain(
      "action.payload ->> 'visibility' in ('public','member')",
    );
    expect(query.mock.calls[1]?.[1]).toEqual([worldId, null, 0, 21, false]);
  });

  it('scopes schedule detail to an active world and creator-aware visibility', async () => {
    const query = vi.fn().mockResolvedValue(result([]));
    const repository = new PostgresCommandRepository(
      {} as Pool,
      { next: () => worldId },
      { query },
    );

    await expect(
      repository.getScheduledAction(
        '018f8652-3cb6-7d52-904b-cce7901d7e21',
        worldId,
        '018f8652-3cb6-7d52-904b-cce7901d7e23',
      ),
    ).resolves.toBeNull();

    expect(query.mock.calls[0]?.[0]).toContain("world.lifecycle = 'active'");
    expect(query.mock.calls[0]?.[0]).toContain("membership.role = 'creator'");
    expect(query.mock.calls[0]?.[0]).toContain(
      "action.payload ->> 'visibility' in ('public','member')",
    );
  });
});

describe('PostgresCommandRepository simulation batch retry lineage', () => {
  it('completes a newly inserted semantic batch by its generated identity', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ id: batchId }]))
      .mockResolvedValueOnce(result([{ id: batchId }]));
    const repository = new PostgresCommandRepository(
      {} as Pool,
      { next: () => worldId },
      { query },
    );

    await expect(
      batchCompleter(repository).completeSimulationBatch(batch(), commandId, now),
    ).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain(
      'on conflict (world_id, from_tick, to_tick, input_checksum, process_registry_version)',
    );
    expect(query.mock.calls[1]?.[0]).toContain("id = $2 and status = 'running'");
    expect(query.mock.calls[1]?.[1]).toEqual([
      worldId,
      batchId,
      Buffer.from('c'.repeat(64), 'hex'),
      commandId,
      now,
    ]);
  });

  it('reuses a failed semantic batch identity and accumulates its attempts', async () => {
    const existingBatchId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ id: existingBatchId }]));
    const repository = new PostgresCommandRepository(
      {} as Pool,
      { next: () => worldId },
      { query },
    );

    await expect(
      batchCompleter(repository).completeSimulationBatch(batch(), commandId, now),
    ).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('attempts = attempts + $8::integer');
    expect(query.mock.calls[1]?.[0]).toContain("batch_key = $6 and status = 'failed'");
    expect(query.mock.calls[1]?.[1]).toEqual([
      worldId,
      '4',
      '5',
      Buffer.from('a'.repeat(64), 'hex'),
      1,
      Buffer.from('b'.repeat(64), 'hex'),
      Buffer.from('c'.repeat(64), 'hex'),
      1,
      commandId,
      now,
    ]);
    expect(query.mock.calls[1]?.[1]).not.toContain(batchId);
  });

  it('rejects an identity that is neither new nor an eligible failed retry', async () => {
    const query = vi.fn().mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]));
    const repository = new PostgresCommandRepository(
      {} as Pool,
      { next: () => worldId },
      { query },
    );

    await expect(
      batchCompleter(repository).completeSimulationBatch(batch(), commandId, now),
    ).rejects.toMatchObject({ code: 'AGGREGATE_VERSION_CONFLICT', statusCode: 409 });
  });
});

const batchId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const now = new Date('2025-01-02T03:04:05.000Z');

function batch(): SimulationBatchRunV1 {
  return {
    attempts: 1,
    batchKey: 'b'.repeat(64),
    batchSchemaVersion: 1,
    commandId,
    completedAt: now.toISOString(),
    errorCode: null,
    fromTick: '4',
    id: batchId,
    inputChecksum: 'a'.repeat(64),
    outcomeHash: 'c'.repeat(64),
    processRegistryVersion: 1,
    startedAt: now.toISOString(),
    status: 'completed',
    toTick: '5',
    worldId,
  };
}

function batchCompleter(repository: PostgresCommandRepository): {
  completeSimulationBatch(
    batch: SimulationBatchRunV1,
    commandId: string,
    decidedAt: Date,
  ): Promise<void>;
} {
  return repository as unknown as ReturnType<typeof batchCompleter>;
}

function result<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { command: 'SELECT', fields: [], oid: 0, rowCount: rows.length, rows };
}

function poolHarness(): {
  pool: Pool;
  releases: unknown[][];
  connectionCount(): number;
  sql(): string[];
} {
  const queries: string[] = [];
  const releases: unknown[][] = [];
  const connect = vi.fn(async () => {
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      return { command: 'SELECT', fields: [], oid: 0, rowCount: 0, rows: [] } as QueryResult;
    });
    return {
      query,
      release: (...args: unknown[]) => releases.push(args),
    } as unknown as PoolClient;
  });
  return {
    pool: { connect } as unknown as Pool,
    releases,
    connectionCount: () => connect.mock.calls.length,
    sql: () => queries,
  };
}

function postgresError(code: string): Error & { code: string } {
  return Object.assign(new Error(`PostgreSQL ${code}`), { code });
}

function economyCommand(): ReceivedCommandWrite {
  return {
    actorId: '018f8652-3cb6-7d52-904b-cce7901d7e21',
    actorType: 'user',
    causationId: null,
    commandId,
    commandType: 'TransferCurrencyV1',
    correlationId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
    expectedAggregateVersion: '1',
    expectedStateRevision: '1',
    expectedWorldVersion: '1',
    idempotencyKey: 'economy-invariant-test',
    payloadClassification: 'member',
    payloadHash: Buffer.alloc(32, 1),
    rateLimitScopeHash: null,
    requestHash: Buffer.alloc(32, 2),
    requestedAt: now,
    schemaVersion: 1,
    worldId,
  };
}
