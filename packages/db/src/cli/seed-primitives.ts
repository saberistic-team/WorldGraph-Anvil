import { createDatabaseClient } from '../index.js';
import { importStarterPrimitives } from '../primitive-seed.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

const client = createDatabaseClient(connectionString, 'worldgraph-catalog-seed');
try {
  const result = await importStarterPrimitives(client.pool);
  console.log(
    `Starter primitive catalog ready: imported=${result.imported} unchanged=${result.unchanged}.`,
  );
} finally {
  await client.pool.end();
}
