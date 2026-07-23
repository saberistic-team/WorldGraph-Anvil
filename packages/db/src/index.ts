import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import * as schema from './schema.js';

const { Pool } = pg;

export interface DatabaseClient {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
}

export function createDatabaseClient(
  connectionString: string,
  applicationName: string,
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

export async function applyMigrations(
  client: DatabaseClient,
  migrationsFolder: string,
): Promise<void> {
  await migrate(client.db, { migrationsFolder });
}

export { schema };
export { importStarterPrimitives, PrimitiveSeedError } from './primitive-seed.js';
export type { Pool } from 'pg';
