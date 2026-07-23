import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const pureModules = [
  'hash.ts',
  'history.ts',
  'index.ts',
  'privacy.ts',
  'projection.ts',
  'registry.ts',
  'rename-world-entity.ts',
  'replay.ts',
  'simulation-projection.ts',
  'simulation-replay.ts',
  'types.ts',
] as const;

const forbidden = [
  /from ['"]node:(?:fs|http|https|net|tls|dns|child_process|worker_threads)/u,
  /from ['"](?:@worldgraph\/db|@worldgraph\/config|bullmq|ioredis|pg|fastify|next)/u,
  /\bfetch\s*\(/u,
  /\bMath\.random\s*\(/u,
  /\bnew Date\s*\(/u,
  /\bDate\.now\s*\(/u,
  /\bperformance\.now\s*\(/u,
  /\bprocess\.(?:env|hrtime)/u,
] as const;

describe('pure ledger architecture boundary', () => {
  it('contains no framework, database, queue, network, ambient time, environment, or random access', async () => {
    for (const module of pureModules) {
      const source = await readFile(new URL(module, import.meta.url), 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${module} contains forbidden dependency ${pattern.source}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it('produces the same hashes in isolated timezone and locale processes', () => {
    const program = `
      import { createFixtureLedger, createFixtureProjection } from './packages/ledger/src/test-fixture.ts';
      import { computeWorldProjectionChecksumV1 } from './packages/ledger/src/projection.ts';
      const fixture = createFixtureLedger();
      process.stdout.write(JSON.stringify({
        entries: fixture.entries.map((entry) => entry.entryHash),
        events: fixture.events.map((event) => event.eventHash),
        projection: computeWorldProjectionChecksumV1(createFixtureProjection()),
      }));
    `;
    const run = (timezone: string, language: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, LANG: language, LC_ALL: language, TZ: timezone },
        timeout: 15_000,
      });
    const utc = run('UTC', 'C');
    const pacific = run('Pacific/Auckland', 'en_NZ.UTF-8');
    expect(utc.stderr).toBe('');
    expect(utc.status).toBe(0);
    expect(pacific.stderr).toBe('');
    expect(pacific.status).toBe(0);
    expect(pacific.stdout).toBe(utc.stdout);
  }, 30_000);
});
