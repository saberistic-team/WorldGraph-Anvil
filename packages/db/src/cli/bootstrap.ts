import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMigrations, createDatabaseClient } from '../index.js';
import { importStarterPrimitives } from '../primitive-seed.js';

const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required.');

const packageRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const client = createDatabaseClient(connectionString, 'worldgraph-bootstrap');

try {
  await applyMigrations(client, resolve(packageRoot, 'drizzle'));
  console.log('Database migrations are at head: 0014_governance_read_capabilities');
  const result = await importStarterPrimitives(client.pool);
  console.log(
    `Starter primitive catalog ready: imported=${result.imported} unchanged=${result.unchanged}.`,
  );
} finally {
  await client.pool.end();
}
