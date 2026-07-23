import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import legacyGolden from './fixtures/floating-guild-city.golden.json';
import previousGolden from './fixtures/floating-guild-city.m8.golden.json';
import currentGolden from './fixtures/harbor-city.m9.golden.json';

const currentProgram = `
  import { compileWorld } from './packages/compiler/src/pipeline.ts';
  import { createGoldenCompilerInput } from './packages/compiler/src/test-fixture.ts';
  const result = compileWorld(createGoldenCompilerInput());
  if (!result.artifact) throw new Error(JSON.stringify(result.diagnostics));
  process.stdout.write(JSON.stringify({
    artifactHash: result.artifact.contentHash,
    canonicalBytes: result.artifact.canonicalBytes,
    inputHash: result.inputHash,
  }));
`;

const legacyProgram = `
  import { compileLegacyArtifactForCompatibility } from './packages/compiler/src/compatibility.ts';
  import { createLegacyGoldenCompilerInput } from './packages/compiler/src/test-fixture.ts';
  const result = compileLegacyArtifactForCompatibility(createLegacyGoldenCompilerInput());
  if (!result.artifact) throw new Error(JSON.stringify(result.diagnostics));
  process.stdout.write(JSON.stringify({
    artifactHash: result.artifact.contentHash,
    canonicalBytes: result.artifact.canonicalBytes,
    inputHash: result.inputHash,
  }));
`;

const previousProgram = `
  import { compilePreviousArtifactForCompatibility } from './packages/compiler/src/compatibility.ts';
  import { createPreviousGoldenCompilerInput } from './packages/compiler/src/test-fixture.ts';
  const result = compilePreviousArtifactForCompatibility(createPreviousGoldenCompilerInput());
  if (!result.artifact) throw new Error(JSON.stringify(result.diagnostics));
  process.stdout.write(JSON.stringify({
    artifactHash: result.artifact.contentHash,
    canonicalBytes: result.artifact.canonicalBytes,
    inputHash: result.inputHash,
  }));
`;

function isolatedCompile(program: string, timezone: string, language: string): string {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', program],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, LANG: language, LC_ALL: language, TZ: timezone },
      timeout: 30_000,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || `Compiler process exited ${result.status}`);
  return result.stdout;
}

function assertReproducible(program: string, golden: { artifactHash: string; inputHash: string }) {
  const utc = isolatedCompile(program, 'UTC', 'C');
  const pacific = isolatedCompile(program, 'Pacific/Auckland', 'en_NZ.UTF-8');
  expect(pacific).toBe(utc);
  expect(JSON.parse(utc)).toMatchObject({
    artifactHash: golden.artifactHash,
    inputHash: golden.inputHash,
  });
}

describe('compiler process reproducibility', () => {
  it('preserves compiler 1.0/artifact 1 bytes across isolated timezone and locale settings', () => {
    assertReproducible(legacyProgram, legacyGolden);
  }, 70_000);

  it('preserves compiler 1.1/artifact 2 bytes across isolated timezone and locale settings', () => {
    assertReproducible(previousProgram, previousGolden);
  }, 70_000);

  it('emits compiler 1.2/artifact 3 bytes across isolated timezone and locale settings', () => {
    assertReproducible(currentProgram, currentGolden);
  }, 70_000);
});
