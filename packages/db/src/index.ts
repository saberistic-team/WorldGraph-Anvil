import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import * as schema from './schema.js';

const { Pool } = pg;
const migrationLockKey = 'worldgraph.schema-migration.v1';

type TimeoutConfigurablePoolClient = pg.PoolClient & {
  connectionParameters: { query_timeout: number | undefined };
};

export interface DatabaseClient {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
}

export type DatabasePoolErrorObserver = (error: Error) => void;

export interface DatabaseClientOptions {
  onCheckedOutClientError?: DatabasePoolErrorObserver;
  onIdleClientError?: DatabasePoolErrorObserver;
}

function notifyDatabasePoolErrorObserver(
  observer: DatabasePoolErrorObserver | undefined,
  error: Error,
): void {
  try {
    observer?.(error);
  } catch {
    // An observability failure must not restore the unhandled database error
    // that this guard exists to prevent.
  }
}

/**
 * pg-pool removes its idle error listener while a client is checked out. Code
 * using pool.connect() must therefore observe the Client error event in
 * addition to handling rejected queries. This pool-level guard covers every
 * manual checkout without changing repository release ownership.
 */
export function observeDatabasePoolErrors(
  pool: pg.Pool,
  observers: DatabaseClientOptions = {},
): () => void {
  const clientListeners = new Map<pg.PoolClient, (error: Error) => void>();

  const onIdleClientError = (error: Error): void => {
    notifyDatabasePoolErrorObserver(observers.onIdleClientError, error);
  };

  const onAcquire = (client: pg.PoolClient): void => {
    if (clientListeners.has(client)) return;
    const onError = (error: Error): void => {
      notifyDatabasePoolErrorObserver(observers.onCheckedOutClientError, error);
    };
    clientListeners.set(client, onError);
    client.on('error', onError);
  };

  const onRelease = (_error: Error, client: pg.PoolClient): void => {
    const listener = clientListeners.get(client);
    if (!listener) return;
    client.removeListener('error', listener);
    clientListeners.delete(client);
  };

  pool.on('error', onIdleClientError);
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);

  return () => {
    pool.removeListener('error', onIdleClientError);
    pool.removeListener('acquire', onAcquire);
    pool.removeListener('release', onRelease);
    for (const [client, listener] of clientListeners) {
      client.removeListener('error', listener);
    }
    clientListeners.clear();
  };
}

export function createDatabaseClient(
  connectionString: string,
  applicationName: string,
  options: DatabaseClientOptions = {},
): DatabaseClient {
  const pool = new Pool({
    application_name: applicationName,
    connectionString,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  observeDatabasePoolErrors(pool, options);
  return { db: drizzle(pool, { schema }), pool };
}

export async function readRuntimeVersions(pool: pg.Pool): Promise<Record<string, unknown>> {
  const result = await pool.query<{ value: Record<string, unknown> }>(
    "select value from platform_metadata where key = 'runtime_versions'",
  );
  const row = result.rows[0];
  if (!row) throw new Error('runtime_versions metadata is missing.');
  return row.value;
}

async function acquireMigrationLock(connection: pg.PoolClient): Promise<void> {
  let lockAcquired = false;
  await connection.query('begin');
  try {
    // A concurrent migrator is expected to wait. Disable only the transaction's
    // server timeout and this connection's client timer while acquiring the lock.
    await connection.query('set local statement_timeout = 0');
    await connection.query('set local lock_timeout = 0');
    // node-postgres treats a per-query zero as "use the connection default", so
    // temporarily clear that default to make this one expected wait unbounded.
    const timeoutConnection = connection as TimeoutConfigurablePoolClient;
    const queryTimeout = timeoutConnection.connectionParameters.query_timeout;
    timeoutConnection.connectionParameters.query_timeout = undefined;
    try {
      await connection.query(`select pg_advisory_lock(hashtextextended($1,0))`, [migrationLockKey]);
      lockAcquired = true;
    } finally {
      timeoutConnection.connectionParameters.query_timeout = queryTimeout;
    }
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    if (lockAcquired) {
      await connection
        .query(`select pg_advisory_unlock(hashtextextended($1,0))`, [migrationLockKey])
        .catch(() => undefined);
    }
    throw error;
  }
}

export async function applyMigrations(
  client: DatabaseClient,
  migrationsFolder: string,
): Promise<void> {
  const migrationConnection = await client.pool.connect();
  let lockAcquired = false;
  let operationError: unknown;
  let operationFailed = false;
  try {
    await acquireMigrationLock(migrationConnection);
    lockAcquired = true;
    // Use the locked physical connection for Drizzle's migration transaction.
    // Routing through the pool here deadlocks when the pool is intentionally max:1.
    const migrationDb = drizzle(migrationConnection, { schema });
    await migrate(migrationDb, { migrationsFolder });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let releaseError: Error | undefined;
  if (lockAcquired) {
    try {
      const unlocked = await migrationConnection.query<{ unlocked: boolean }>(
        `select pg_advisory_unlock(hashtextextended($1,0)) as unlocked`,
        [migrationLockKey],
      );
      if (unlocked.rows[0]?.unlocked !== true) {
        throw new Error('Database migration advisory lock was not held at release.');
      }
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error(String(error));
    }
  }
  migrationConnection.release(releaseError);

  if (operationFailed) throw operationError;
  if (releaseError) throw releaseError;
}

export { schema };
export { importStarterPrimitives, PrimitiveSeedError } from './primitive-seed.js';
export type { PrimitiveSeedOptions, PrimitiveSeedResult } from './primitive-seed.js';
export type { Pool } from 'pg';
