import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('economy expiry command boundary', () => {
  it('does not depend on Redis, queues, HTTP, AI, client time, or random identifiers', async () => {
    const source = await readFile(new URL('postgres.ts', import.meta.url), 'utf8');
    for (const pattern of [
      /from ['"](?:bullmq|ioredis|fastify|next|openai)/u,
      /\bfetch\s*\(/u,
      /\bMath\.random\s*\(/u,
      /\bDate\.now\s*\(/u,
      /\bnew Date\s*\(\s*\)/u,
      /\bprocess\.env/u,
    ]) {
      expect(source).not.toMatch(pattern);
    }
    expect(source).toContain('worldgraph_open_command_write');
    expect(source).toContain('AssetTransferOfferExpiredV1');
    expect(source).toContain('worldgraph_economy_projection_checksum');
    expect(source).toContain("'world_graph'");
    expect(source).toContain("'simulation_runtime'");
    expect(source).toContain("'economy_runtime'");
    expect(source).toContain('worldgraph_simulation_projection_checksum');
    const runtimeLock = source.indexOf('for update of runtime');
    const economyLock = source.indexOf('from world_economy_heads');
    const clockLock = source.indexOf('from world_simulation_clocks');
    const offerLock = source.indexOf('from asset_transfer_offers offer');
    expect(runtimeLock).toBeGreaterThan(0);
    expect(economyLock).toBeGreaterThan(runtimeLock);
    expect(clockLock).toBeGreaterThan(economyLock);
    expect(offerLock).toBeGreaterThan(clockLock);
  });
});
