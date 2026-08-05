import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import {
  compileLegacyArtifactForCompatibility,
  compilePreviousArtifactForCompatibility,
  compileRetainedArtifactForCompatibility,
  compileWorld,
} from '../packages/compiler/src/index.js';
import {
  createGoldenCompilerInput,
  createLegacyGoldenCompilerInput,
  createPreviousGoldenCompilerInput,
  createRetainedGoldenCompilerInput,
} from '../packages/compiler/src/test-fixture.js';

const legacyGoldenPath = 'packages/compiler/src/fixtures/floating-guild-city.golden.json';
const retainedGoldenPath = 'packages/compiler/src/fixtures/floating-guild-city.m8.golden.json';
const previousGoldenPath = 'packages/compiler/src/fixtures/harbor-city.m9.golden.json';
const currentGoldenPath = 'packages/compiler/src/fixtures/harbor-city.m10.golden.json';

interface LegacyGoldenIdentity {
  artifactHash: string;
  canonicalByteLength: number;
  compilerConfigVersion: number;
  compilerVersion: string;
  counts: { controllers: number; entities: number; relationships: number };
  inputHash: string;
  manifestContentHash: string;
  worldGraphSchemaVersion: number;
}

interface CurrentGoldenIdentity extends LegacyGoldenIdentity {
  artifactSchemaVersion: number;
  economySeedPlanHash: string;
}

interface GovernanceGoldenIdentity extends CurrentGoldenIdentity {
  governanceSeedPlanHash: string;
}

function parseGolden<T>(bytes: string): T {
  return JSON.parse(bytes) as T;
}

async function main(): Promise<void> {
  const legacyResult = compileLegacyArtifactForCompatibility(createLegacyGoldenCompilerInput());
  if (!legacyResult.artifact) {
    throw new Error(
      `Legacy golden compiler input failed: ${JSON.stringify(legacyResult.diagnostics)}`,
    );
  }
  const legacyActual: LegacyGoldenIdentity = {
    artifactHash: legacyResult.artifact.contentHash,
    canonicalByteLength: Buffer.byteLength(legacyResult.artifact.canonicalBytes, 'utf8'),
    compilerConfigVersion: legacyResult.artifact.world.compilerConfigVersion,
    compilerVersion: legacyResult.artifact.world.compilerVersion,
    counts: legacyResult.artifact.world.counts,
    inputHash: legacyResult.inputHash,
    manifestContentHash: legacyResult.artifact.world.manifestContentHash,
    worldGraphSchemaVersion: legacyResult.artifact.world.worldGraphSchemaVersion,
  };
  const legacyExpected = parseGolden<LegacyGoldenIdentity>(
    await readFile(legacyGoldenPath, 'utf8'),
  );
  if (!isDeepStrictEqual(legacyActual, legacyExpected)) {
    throw new Error(
      `Frozen compiler 1.0 golden changed.\nExpected ${JSON.stringify(legacyExpected)}\nActual   ${JSON.stringify(legacyActual)}`,
    );
  }

  const retainedResult = compileRetainedArtifactForCompatibility(
    createRetainedGoldenCompilerInput(),
  );
  if (!retainedResult.artifact) {
    throw new Error(
      `Retained golden compiler input failed: ${JSON.stringify(retainedResult.diagnostics)}`,
    );
  }
  const retainedActual: CurrentGoldenIdentity = {
    artifactHash: retainedResult.artifact.contentHash,
    artifactSchemaVersion: retainedResult.artifact.artifactSchemaVersion,
    canonicalByteLength: Buffer.byteLength(retainedResult.artifact.canonicalBytes, 'utf8'),
    compilerConfigVersion: retainedResult.artifact.world.compilerConfigVersion,
    compilerVersion: retainedResult.artifact.world.compilerVersion,
    counts: retainedResult.artifact.world.counts,
    economySeedPlanHash: retainedResult.artifact.world.economySeedPlanHash,
    inputHash: retainedResult.inputHash,
    manifestContentHash: retainedResult.artifact.world.manifestContentHash,
    worldGraphSchemaVersion: retainedResult.artifact.world.worldGraphSchemaVersion,
  };
  const retainedExpected = parseGolden<CurrentGoldenIdentity>(
    await readFile(retainedGoldenPath, 'utf8'),
  );
  if (!isDeepStrictEqual(retainedActual, retainedExpected)) {
    throw new Error(
      `Frozen compiler 1.1 golden changed.\nExpected ${JSON.stringify(retainedExpected)}\nActual   ${JSON.stringify(retainedActual)}`,
    );
  }

  const previousResult = compilePreviousArtifactForCompatibility(
    createPreviousGoldenCompilerInput(),
  );
  if (!previousResult.artifact) {
    throw new Error(
      `Previous golden compiler input failed: ${JSON.stringify(previousResult.diagnostics)}`,
    );
  }
  const previousActual: CurrentGoldenIdentity = {
    artifactHash: previousResult.artifact.contentHash,
    artifactSchemaVersion: previousResult.artifact.artifactSchemaVersion,
    canonicalByteLength: Buffer.byteLength(previousResult.artifact.canonicalBytes, 'utf8'),
    compilerConfigVersion: previousResult.artifact.world.compilerConfigVersion,
    compilerVersion: previousResult.artifact.world.compilerVersion,
    counts: previousResult.artifact.world.counts,
    economySeedPlanHash: previousResult.artifact.world.economySeedPlanHash,
    inputHash: previousResult.inputHash,
    manifestContentHash: previousResult.artifact.world.manifestContentHash,
    worldGraphSchemaVersion: previousResult.artifact.world.worldGraphSchemaVersion,
  };
  const previousExpected = parseGolden<CurrentGoldenIdentity>(
    await readFile(previousGoldenPath, 'utf8'),
  );
  if (!isDeepStrictEqual(previousActual, previousExpected)) {
    throw new Error(
      `Frozen compiler 1.2 golden changed.\nExpected ${JSON.stringify(previousExpected)}\nActual   ${JSON.stringify(previousActual)}`,
    );
  }

  const currentResult = compileWorld(createGoldenCompilerInput());
  if (!currentResult.artifact) {
    throw new Error(
      `Current golden compiler input failed: ${JSON.stringify(currentResult.diagnostics)}`,
    );
  }
  const currentActual: GovernanceGoldenIdentity = {
    artifactHash: currentResult.artifact.contentHash,
    artifactSchemaVersion: currentResult.artifact.artifactSchemaVersion,
    canonicalByteLength: Buffer.byteLength(currentResult.artifact.canonicalBytes, 'utf8'),
    compilerConfigVersion: currentResult.artifact.world.compilerConfigVersion,
    compilerVersion: currentResult.artifact.world.compilerVersion,
    counts: currentResult.artifact.world.counts,
    economySeedPlanHash: currentResult.artifact.world.economySeedPlanHash,
    governanceSeedPlanHash: currentResult.artifact.world.governanceSeedPlanHash,
    inputHash: currentResult.inputHash,
    manifestContentHash: currentResult.artifact.world.manifestContentHash,
    worldGraphSchemaVersion: currentResult.artifact.world.worldGraphSchemaVersion,
  };
  const currentExpected = parseGolden<GovernanceGoldenIdentity>(
    await readFile(currentGoldenPath, 'utf8'),
  );
  if (!isDeepStrictEqual(currentActual, currentExpected)) {
    throw new Error(
      `Compiler 1.3 Harbor City golden changed without updating the reviewed lock.\nExpected ${JSON.stringify(currentExpected)}\nActual   ${JSON.stringify(currentActual)}`,
    );
  }

  const baseRevision = process.env.COMPILER_GOLDEN_BASE_REVISION;
  if (baseRevision) {
    let previous: LegacyGoldenIdentity | null = null;
    try {
      previous = parseGolden<LegacyGoldenIdentity>(
        execFileSync('git', ['show', `${baseRevision}:${legacyGoldenPath}`], { encoding: 'utf8' }),
      );
    } catch {
      // The first release introducing the lock has no prior identity to compare.
    }
    if (previous && !isDeepStrictEqual(previous, legacyExpected)) {
      throw new Error('The frozen compiler 1.0 golden file may not be rewritten.');
    }
    let retainedM8: CurrentGoldenIdentity | null = null;
    try {
      retainedM8 = parseGolden<CurrentGoldenIdentity>(
        execFileSync('git', ['show', `${baseRevision}:${retainedGoldenPath}`], {
          encoding: 'utf8',
        }),
      );
    } catch {
      // The first release introducing the lock has no prior identity to compare.
    }
    if (retainedM8 && !isDeepStrictEqual(retainedM8, retainedExpected)) {
      throw new Error('The frozen compiler 1.1 golden file may not be rewritten.');
    }
    let previousM9: CurrentGoldenIdentity | null = null;
    try {
      previousM9 = parseGolden<CurrentGoldenIdentity>(
        execFileSync('git', ['show', `${baseRevision}:${previousGoldenPath}`], {
          encoding: 'utf8',
        }),
      );
    } catch {
      // The first release introducing the lock has no prior identity to compare.
    }
    if (previousM9 && !isDeepStrictEqual(previousM9, previousExpected)) {
      throw new Error('The frozen compiler 1.2 golden file may not be rewritten.');
    }
  }

  console.log(
    `Compiler goldens verified: legacy ${legacyActual.artifactHash}; retained ${retainedActual.artifactHash}; previous ${previousActual.artifactHash}; current ${currentActual.artifactHash}; economy plan ${currentActual.economySeedPlanHash}; governance plan ${currentActual.governanceSeedPlanHash}`,
  );
}

void main();
