import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const pureModules = [
  'adapters.ts',
  'compatibility.ts',
  'diagnostics.ts',
  'economy-seed.ts',
  'emit.ts',
  'hash.ts',
  'index.ts',
  'input.ts',
  'invariants.ts',
  'keys.ts',
  'link.ts',
  'lower.ts',
  'normalize.ts',
  'pipeline.ts',
  'privacy.ts',
  'prng.ts',
  'resolve.ts',
  'types.ts',
  'validate.ts',
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

describe('pure compiler architecture boundary', () => {
  it('contains no infrastructure, network, ambient time, environment, or random access', async () => {
    for (const module of pureModules) {
      const source = await readFile(new URL(module, import.meta.url), 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${module} contains forbidden dependency ${pattern.source}`).not.toMatch(
          pattern,
        );
      }
    }
  });
});
