import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { canonicalJson, type CompiledArtifactV4 } from '@worldgraph/contracts';

import { runWorldgraphCli } from './cli.js';
import { sha256Utf8 } from './hash.js';
import { compileWorld } from './pipeline.js';
import { createGoldenCompilerInput } from './test-fixture.js';
import golden from './fixtures/harbor-city.m10.golden.json';

function resignArtifact(artifact: CompiledArtifactV4): CompiledArtifactV4 {
  artifact.canonicalBytes = canonicalJson(artifact.world);
  artifact.contentHash = sha256Utf8(artifact.canonicalBytes);
  return artifact;
}

describe('offline compiler CLI adapter', () => {
  it('compiles twice and verifies a content-addressed artifact', async () => {
    const directory = await mkdtemp(`${tmpdir()}/worldgraph-compiler-`);
    const input = createGoldenCompilerInput();
    const manifestPath = `${directory}/manifest.json`;
    const catalogPath = `${directory}/catalog.json`;
    const membersPath = `${directory}/members.json`;
    await Promise.all([
      writeFile(manifestPath, JSON.stringify(input.manifest), 'utf8'),
      writeFile(catalogPath, JSON.stringify({ primitives: input.primitives }), 'utf8'),
      writeFile(membersPath, JSON.stringify(input.activeMembers), 'utf8'),
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      error: (message: string) => errors.push(message),
      output: (message: string) => output.push(message),
    };
    for (const target of ['first', 'second']) {
      expect(
        await runWorldgraphCli(
          [
            'compile',
            '--manifest',
            manifestPath,
            '--catalog',
            catalogPath,
            '--seed',
            input.seed,
            '--output',
            `${directory}/${target}`,
            '--members',
            membersPath,
          ],
          io,
        ),
      ).toBe(0);
    }
    const first = await readFile(`${directory}/first/compiled-artifact.json`, 'utf8');
    const second = await readFile(`${directory}/second/compiled-artifact.json`, 'utf8');
    expect(second).toBe(first);
    expect(
      await runWorldgraphCli(
        ['verify-artifact', '--artifact', `${directory}/first/compiled-artifact.json`],
        io,
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(output.join('\n')).toContain(golden.artifactHash);
  });

  it('rejects re-hashed artifacts with invalid graph semantics', async () => {
    const directory = await mkdtemp(`${tmpdir()}/worldgraph-verifier-`);
    const artifact = structuredClone(compileWorld(createGoldenCompilerInput()).artifact!);
    artifact.world.relationships[0]!.targetLogicalKey = 'district:missing';
    const path = `${directory}/dangling.json`;
    await writeFile(path, canonicalJson(resignArtifact(artifact)), 'utf8');
    const errors: string[] = [];

    expect(
      await runWorldgraphCli(['verify-artifact', '--artifact', path], {
        error: (message) => errors.push(message),
        output: () => undefined,
      }),
    ).toBe(2);
    expect(errors.join('\n')).toContain('DANGLING_RELATIONSHIP_ENDPOINT');
  }, 20_000);
});
