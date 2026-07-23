import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('simulation command package boundary', () => {
  it('never imports API, Redis, BullMQ, AI, or network adapters', async () => {
    const source = await readFile(new URL('./postgres.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/apps\/api|@worldgraph\/api|bullmq|ioredis|openai|fetch\(/u);
  });
});
