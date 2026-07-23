import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { EMIT_WORLD_NOTICE_PROCESS_VERSION } from '@worldgraph/contracts';

import { runSimulationProcessV1 } from './registry.js';

const pureModules = [
  'arithmetic.ts',
  'budgets.ts',
  'clock.ts',
  'errors.ts',
  'index.ts',
  'outcome.ts',
  'prng.ts',
  'registry.ts',
  'schedule.ts',
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

describe('pure simulation architecture boundary', () => {
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

  it('does not consult ambient clock, random, or network globals at the handler boundary', () => {
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
      expect(
        runSimulationProcessV1({
          actionSchemaVersion: 1,
          actionType: 'EmitWorldNoticeV1',
          context: {
            currentProjectionChecksum: 'a'.repeat(64),
            processSchemaVersion: 1,
            scheduleSequence: '1',
            stableProcessKey: 'schedule:1',
            state: {},
            tick: '3',
            worldSeed: 'golden-seed',
            worldTimeUnixMilliseconds: '946944000000',
          },
          payload: { text: 'Guild Founding Day', visibility: 'public' },
          processVersion: EMIT_WORLD_NOTICE_PROCESS_VERSION,
        }).events,
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
      random.mockRestore();
      network.mockRestore();
    }
  });

  it('produces the same PRNG and outcome vectors across timezone and locale processes', () => {
    const program = `
      import { SimulationPrngV1, computeInitialSimulationOutcomeHashV1, computeSemanticSimulationOutcomeHashV1 } from './packages/simulation/src/index.ts';
      import { SIMULATION_PRNG_ALGORITHM_VERSION } from './packages/contracts/src/index.ts';
      const prng = new SimulationPrngV1({
        processType: 'EmitWorldNoticeV1', processVersion: '1.0.0',
        stableProcessKey: 'schedule:1', tick: '3', worldSeed: 'golden-seed'
      });
      const worldSeedHash = 'b'.repeat(64);
      const hash = computeSemanticSimulationOutcomeHashV1({
        prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
        processRegistryVersion: 1,
        startingOutcomeHash: computeInitialSimulationOutcomeHashV1({
          prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
          processRegistryVersion: 1,
          worldSeedHash
        }),
        startingProjectionChecksum: 'a'.repeat(64),
        ticks: [{ createdSchedules: [], dueActions: [], returnedEvents: [], tick: '3' }],
        worldSeedHash
      });
      process.stdout.write(JSON.stringify({ hash, random: [prng.nextUint32(), prng.nextUint32()] }));
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
