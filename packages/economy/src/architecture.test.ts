import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createTransferDecision, economySeedPlanHash } from './index.js';

const pureModules = [
  'accounting.ts',
  'amount.ts',
  'errors.ts',
  'index.ts',
  'locks.ts',
  'ownership.ts',
  'reconciliation.ts',
  'repair.ts',
  'seed-plan.ts',
  'wallet.ts',
] as const;

const forbidden = [
  /from ['"]node:(?:fs|http|https|net|tls|dns|child_process|worker_threads)/u,
  /from ['"](?:@worldgraph\/db|@worldgraph\/config|bullmq|ioredis|pg|fastify|next)/u,
  /from ['"](?:openai|@anthropic-ai|ai)/u,
  /\bfetch\s*\(/u,
  /\bMath\.random\s*\(/u,
  /\bnew Date\s*\(/u,
  /\bDate\.now\s*\(/u,
  /\bperformance\.now\s*\(/u,
  /\bprocess\.(?:env|hrtime)/u,
  /\beval\s*\(/u,
  /\bFunction\s*\(/u,
] as const;

describe('pure economy architecture boundary', () => {
  it('contains no database, queue, network, AI, ambient time, environment, or random access', async () => {
    for (const module of pureModules) {
      const source = await readFile(new URL(module, import.meta.url), 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${module} contains forbidden dependency ${pattern.source}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it('does not consult ambient globals at decision and hashing boundaries', () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('ambient clock accessed');
    });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('ambient random accessed');
    });
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network accessed');
    });
    try {
      expect(createTransferDecision('a', 'b', 1n).supplyDeltaMinor).toBe(0n);
      expect(
        economySeedPlanHash({
          assets: [
            {
              assetSchemaVersion: 1,
              assetType: 'founding_seal',
              initialOwnerEntityLogicalKey: 'character:a',
              metadata: {
                displayName: 'Founding Seal',
                provenance: 'compiler-economy-adapter-v1',
              },
              stableKey: 'asset:founding-seal',
              transferable: true,
              worldEntityLogicalKey: null,
            },
          ],
          currency: {
            cashOutAllowed: false,
            code: 'GCR',
            currencySchemaVersion: 1,
            issuerEntityLogicalKey: 'institution:council',
            maxSupplyMinor: '1000',
            minorUnitScale: 2,
            name: 'Guild Credits',
            noCashValue: true,
            stableKey: 'currency:gcr',
          },
          economySeedPlanSchemaVersion: 1,
          initialSupplyMinor: '0',
          wallets: [
            {
              initialBalanceMinor: '0',
              ownerEntityLogicalKey: 'institution:council',
              stableKey: 'wallet:treasury:gcr',
              walletKind: 'treasury',
              walletSchemaVersion: 1,
            },
          ],
        }),
      ).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      clock.mockRestore();
      random.mockRestore();
      network.mockRestore();
    }
  });
});
