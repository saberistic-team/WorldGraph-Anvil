import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Journal {
  entries: { idx: number; tag: string }[];
  dialect: string;
  version: string;
}

interface ChecksumManifest {
  algorithm: 'sha256';
  migrations: Record<string, string>;
}

const packageRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const migrationRoot = resolve(packageRoot, 'drizzle');
const files = (await readdir(migrationRoot)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
const journal = JSON.parse(
  await readFile(resolve(migrationRoot, 'meta/_journal.json'), 'utf8'),
) as Journal;
const checksumManifest = JSON.parse(
  await readFile(resolve(migrationRoot, 'meta/checksums.json'), 'utf8'),
) as ChecksumManifest;
const expected = journal.entries.map((entry) => `${entry.tag}.sql`);

if (journal.dialect !== 'postgresql' || journal.version !== '7') {
  throw new Error('The Drizzle migration journal has an unsupported format.');
}
if (new Set(files).size !== files.length || JSON.stringify(files) !== JSON.stringify(expected)) {
  throw new Error(
    `Migration drift detected. Files=${files.join(',')} journal=${expected.join(',')}`,
  );
}
if (
  checksumManifest.algorithm !== 'sha256' ||
  JSON.stringify(Object.keys(checksumManifest.migrations).sort()) !== JSON.stringify(expected)
) {
  throw new Error('Migration checksum manifest does not match the Drizzle journal.');
}
for (const [index, entry] of journal.entries.entries()) {
  if (entry.idx !== index) throw new Error(`Migration journal index ${entry.idx} is out of order.`);
}
for (const file of files) {
  const sql = await readFile(resolve(migrationRoot, file));
  const actual = createHash('sha256').update(sql).digest('hex');
  const expectedHash = checksumManifest.migrations[file];
  if (actual !== expectedHash) {
    throw new Error(
      `Migration content drift detected in ${file}. Append a migration; do not edit history.`,
    );
  }
}

console.log(`Migration journal is consistent at ${journal.entries.at(-1)?.tag ?? 'empty'}.`);
