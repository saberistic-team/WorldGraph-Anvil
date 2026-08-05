import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalJson } from '../packages/contracts/src/index.js';
import {
  compileGovernanceArtifactForCompatibility,
  compileLegacyArtifactForCompatibility,
  compilePreviousArtifactForCompatibility,
  compileRetainedArtifactForCompatibility,
} from '../packages/compiler/src/compatibility.js';
import {
  createGoldenCompilerInput,
  createGovernanceGoldenCompilerInput,
  createLegacyGoldenCompilerInput,
  createPreviousGoldenCompilerInput,
  createRetainedGoldenCompilerInput,
} from '../packages/compiler/src/test-fixture.js';

interface GoldenIdentity {
  artifactHash: string;
  inputHash: string;
}

const cliPath = resolve('packages/compiler/dist/cli.js');

function runCli(entryPath: string, args: readonly string[]): string {
  return execFileSync(process.execPath, [entryPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'worldgraph-compiler-cli-'));

  try {
    const input = createGoldenCompilerInput();
    const manifestPath = join(directory, 'manifest.json');
    const catalogPath = join(directory, 'catalog.json');
    const membersPath = join(directory, 'members.json');
    const firstDirectory = join(directory, 'first');
    const secondDirectory = join(directory, 'second');
    const linkedCliPath = join(directory, 'worldgraph');
    const legacyArtifactPath = join(directory, 'legacy-artifact.json');
    const retainedArtifactPath = join(directory, 'retained-artifact.json');
    const previousArtifactPath = join(directory, 'previous-artifact.json');
    const governanceArtifactPath = join(directory, 'governance-artifact.json');
    const legacyArtifact = compileLegacyArtifactForCompatibility(
      createLegacyGoldenCompilerInput(),
    ).artifact;
    if (!legacyArtifact) throw new Error('Frozen compiler 1.0 compatibility artifact failed.');
    const retainedArtifact = compileRetainedArtifactForCompatibility(
      createRetainedGoldenCompilerInput(),
    ).artifact;
    if (!retainedArtifact) throw new Error('Frozen compiler 1.1 compatibility artifact failed.');
    const previousArtifact = compilePreviousArtifactForCompatibility(
      createPreviousGoldenCompilerInput(),
    ).artifact;
    if (!previousArtifact) throw new Error('Frozen compiler 1.2 compatibility artifact failed.');
    const governanceArtifact = compileGovernanceArtifactForCompatibility(
      createGovernanceGoldenCompilerInput(),
    ).artifact;
    if (!governanceArtifact) throw new Error('Frozen compiler 1.3 compatibility artifact failed.');

    await Promise.all([
      writeFile(manifestPath, JSON.stringify(input.manifest), 'utf8'),
      writeFile(catalogPath, JSON.stringify({ primitives: input.primitives }), 'utf8'),
      writeFile(membersPath, JSON.stringify(input.activeMembers), 'utf8'),
      writeFile(legacyArtifactPath, canonicalJson(legacyArtifact), 'utf8'),
      writeFile(retainedArtifactPath, canonicalJson(retainedArtifact), 'utf8'),
      writeFile(previousArtifactPath, canonicalJson(previousArtifact), 'utf8'),
      writeFile(governanceArtifactPath, canonicalJson(governanceArtifact), 'utf8'),
      symlink(cliPath, linkedCliPath),
    ]);

    const commonArguments = [
      'compile',
      '--manifest',
      manifestPath,
      '--catalog',
      catalogPath,
      '--members',
      membersPath,
      '--seed',
      input.seed,
      '--output',
    ] as const;
    const first = JSON.parse(
      runCli(linkedCliPath, [...commonArguments, firstDirectory]),
    ) as GoldenIdentity;
    const second = JSON.parse(
      runCli(linkedCliPath, [...commonArguments, secondDirectory]),
    ) as GoldenIdentity;
    const verification = JSON.parse(
      runCli(linkedCliPath, [
        'verify-artifact',
        '--artifact',
        join(firstDirectory, 'compiled-artifact.json'),
      ]),
    ) as GoldenIdentity & { valid: boolean };
    const legacyVerification = JSON.parse(
      runCli(linkedCliPath, ['verify-artifact', '--artifact', legacyArtifactPath]),
    ) as GoldenIdentity & { valid: boolean };
    const retainedVerification = JSON.parse(
      runCli(linkedCliPath, ['verify-artifact', '--artifact', retainedArtifactPath]),
    ) as GoldenIdentity & { valid: boolean };
    const previousVerification = JSON.parse(
      runCli(linkedCliPath, ['verify-artifact', '--artifact', previousArtifactPath]),
    ) as GoldenIdentity & { valid: boolean };
    const governanceVerification = JSON.parse(
      runCli(linkedCliPath, ['verify-artifact', '--artifact', governanceArtifactPath]),
    ) as GoldenIdentity & { valid: boolean };
    const golden = JSON.parse(
      await readFile('packages/compiler/src/fixtures/harbor-city.m11.golden.json', 'utf8'),
    ) as GoldenIdentity;
    const governanceGolden = JSON.parse(
      await readFile('packages/compiler/src/fixtures/harbor-city.m10.golden.json', 'utf8'),
    ) as GoldenIdentity;
    const previousGolden = JSON.parse(
      await readFile('packages/compiler/src/fixtures/harbor-city.m9.golden.json', 'utf8'),
    ) as GoldenIdentity;
    const retainedGolden = JSON.parse(
      await readFile('packages/compiler/src/fixtures/floating-guild-city.m8.golden.json', 'utf8'),
    ) as GoldenIdentity;
    const legacyGolden = JSON.parse(
      await readFile('packages/compiler/src/fixtures/floating-guild-city.golden.json', 'utf8'),
    ) as GoldenIdentity;

    for (const filename of [
      'compiler-input.json',
      'compiled-artifact.json',
      'compiled-world.json',
    ]) {
      const [firstBytes, secondBytes] = await Promise.all([
        readFile(join(firstDirectory, filename)),
        readFile(join(secondDirectory, filename)),
      ]);
      if (!firstBytes.equals(secondBytes)) {
        throw new Error(`Offline compiler output differs across processes: ${filename}.`);
      }
    }

    if (
      first.inputHash !== golden.inputHash ||
      first.artifactHash !== golden.artifactHash ||
      second.inputHash !== golden.inputHash ||
      second.artifactHash !== golden.artifactHash ||
      verification.valid !== true ||
      verification.artifactHash !== golden.artifactHash ||
      governanceVerification.valid !== true ||
      governanceVerification.artifactHash !== governanceGolden.artifactHash ||
      previousVerification.valid !== true ||
      previousVerification.artifactHash !== previousGolden.artifactHash ||
      retainedVerification.valid !== true ||
      retainedVerification.artifactHash !== retainedGolden.artifactHash ||
      legacyVerification.valid !== true ||
      legacyVerification.artifactHash !== legacyGolden.artifactHash
    ) {
      throw new Error('Offline compiler CLI identity does not match the reviewed golden identity.');
    }

    console.log(
      `Offline compiler CLI verified current ${golden.artifactHash}, governance ${governanceGolden.artifactHash}, previous ${previousGolden.artifactHash}, retained ${retainedGolden.artifactHash}, and legacy ${legacyGolden.artifactHash} across separate processes.`,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

void main();
