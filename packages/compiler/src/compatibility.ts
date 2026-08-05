import {
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  CompiledArtifactV2Schema,
  CompiledArtifactV3Schema,
  CompiledArtifactV4Schema,
  GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION,
  GOVERNANCE_COMPILER_VERSION,
  LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION,
  LEGACY_COMPILER_VERSION,
  MANIFEST_SCHEMA_VERSION,
  WORLD_GRAPH_SCHEMA_VERSION,
  CompiledArtifactV1Schema,
  PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION,
  PREVIOUS_COMPILER_VERSION,
  RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION,
  RETAINED_COMPILER_VERSION,
  canonicalJson,
  createValidator,
  type CompiledArtifactV1,
  type CompiledArtifactV2,
  type CompiledArtifactV3,
  type CompiledArtifactV4,
  type CompiledWorldV1,
  type CompiledWorldV2,
  type CompiledWorldV3,
  type CompiledWorldV4,
  type CompilerDiagnosticV1,
  type CompilerInputBundleV1,
  type GovernanceCompilerInputBundleV1,
  type LegacyCompilerInputBundleV1,
  type PreviousCompilerInputBundleV1,
  type RetainedCompilerInputBundleV1,
} from '@worldgraph/contracts';

import { sortCompilerDiagnostics } from './diagnostics.js';
import { deriveLoweredGovernanceSeedPlanV1 } from './governance-seed.js';
import { compilerInputHash, sha256Utf8 } from './hash.js';
import { validateCompiledWorldSemantics } from './invariants.js';
import { linkLoweredWorld } from './link.js';
import { lowerNormalizedInput } from './lower.js';
import { normalizeCompilerInput } from './normalize.js';
import { resolveCompilerInput } from './resolve.js';
import type { LoweredWorld, StageResult } from './types.js';
import { validateResolvedInput } from './validate.js';
import { deriveLoweredEconomySeedPlanV1, deriveLoweredEconomySeedPlanV2 } from './economy-seed.js';

const legacyArtifactValidator = createValidator<CompiledArtifactV1>(CompiledArtifactV1Schema);
const retainedArtifactValidator = createValidator<CompiledArtifactV2>(CompiledArtifactV2Schema);
const previousArtifactValidator = createValidator<CompiledArtifactV3>(CompiledArtifactV3Schema);
const governanceArtifactValidator = createValidator<CompiledArtifactV4>(CompiledArtifactV4Schema);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function emitLegacyCompiledArtifact(
  lowered: LoweredWorld,
  legacyInputHash: string,
): StageResult<CompiledArtifactV1> {
  const world: CompiledWorldV1 = {
    artifactSchemaVersion: LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION,
    compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
    compilerVersion: LEGACY_COMPILER_VERSION,
    controllers: [...lowered.controllers].sort((left, right) =>
      compareText(left.principalKey, right.principalKey),
    ),
    counts: {
      controllers: lowered.controllers.length,
      entities: lowered.entities.length,
      relationships: lowered.relationships.length,
    },
    entities: [...lowered.entities].sort((left, right) =>
      compareText(left.logicalKey, right.logicalKey),
    ),
    inputHash: legacyInputHash,
    manifestContentHash: lowered.normalized.bundle.manifestContentHash,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    metadata: { ...lowered.normalized.manifest.metadata },
    relationships: [...lowered.relationships].sort((left, right) =>
      compareText(left.logicalKey, right.logicalKey),
    ),
    seed: lowered.normalized.bundle.seed,
    visualPlan: lowered.visualPlan,
    worldGraphSchemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
  };
  const diagnostics = validateCompiledWorldSemantics(world);
  if (diagnostics.length > 0) return { diagnostics, value: null };
  const canonicalBytes = canonicalJson(world);
  const artifact: CompiledArtifactV1 = {
    artifactKind: 'compiled_world',
    artifactSchemaVersion: LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION,
    canonicalBytes,
    contentHash: sha256Utf8(canonicalBytes),
    inputHash: legacyInputHash,
    world,
  };
  if (!legacyArtifactValidator.is(artifact)) {
    return {
      diagnostics: legacyArtifactValidator.issues(artifact).map((issue) => ({
        code: 'LEGACY_ARTIFACT_SCHEMA_INVALID',
        message: `Legacy compatibility emitter produced an invalid artifact: ${issue.message}`,
        pointer: issue.path,
        relatedKeys: [],
        retryable: false,
        severity: 'error',
        stage: 'emit',
      })),
      value: null,
    };
  }
  return { diagnostics: [], value: artifact };
}

export function emitRetainedCompiledArtifact(
  lowered: LoweredWorld,
  retainedInputHash: string,
): StageResult<CompiledArtifactV2> {
  const seedPlan = deriveLoweredEconomySeedPlanV1(lowered);
  if (!seedPlan.value) return { diagnostics: seedPlan.diagnostics, value: null };
  const world: CompiledWorldV2 = {
    artifactSchemaVersion: RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION,
    compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
    compilerVersion: RETAINED_COMPILER_VERSION,
    controllers: [...lowered.controllers].sort((left, right) =>
      compareText(left.principalKey, right.principalKey),
    ),
    counts: {
      controllers: lowered.controllers.length,
      entities: lowered.entities.length,
      relationships: lowered.relationships.length,
    },
    entities: [...lowered.entities].sort((left, right) =>
      compareText(left.logicalKey, right.logicalKey),
    ),
    economySeedPlan: seedPlan.value.plan,
    economySeedPlanHash: seedPlan.value.hash,
    inputHash: retainedInputHash,
    manifestContentHash: lowered.normalized.bundle.manifestContentHash,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    metadata: { ...lowered.normalized.manifest.metadata },
    relationships: [...lowered.relationships].sort((left, right) =>
      compareText(left.logicalKey, right.logicalKey),
    ),
    seed: lowered.normalized.bundle.seed,
    visualPlan: lowered.visualPlan,
    worldGraphSchemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
  };
  const diagnostics = validateCompiledWorldSemantics(world);
  if (diagnostics.length > 0) return { diagnostics, value: null };
  const canonicalBytes = canonicalJson(world);
  const artifact: CompiledArtifactV2 = {
    artifactKind: 'compiled_world',
    artifactSchemaVersion: RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION,
    canonicalBytes,
    contentHash: sha256Utf8(canonicalBytes),
    inputHash: retainedInputHash,
    world,
  };
  if (!retainedArtifactValidator.is(artifact)) {
    return {
      diagnostics: retainedArtifactValidator.issues(artifact).map((issue) => ({
        code: 'RETAINED_ARTIFACT_SCHEMA_INVALID',
        message: `Compiler 1.1 compatibility emitter produced an invalid artifact: ${issue.message}`,
        pointer: issue.path,
        relatedKeys: [],
        retryable: false,
        severity: 'error',
        stage: 'emit',
      })),
      value: null,
    };
  }
  return { diagnostics: [], value: artifact };
}

export function emitPreviousCompiledArtifact(
  lowered: LoweredWorld,
  previousInputHash: string,
): StageResult<CompiledArtifactV3> {
  const seedPlan = deriveLoweredEconomySeedPlanV2(lowered);
  if (!seedPlan.value) return { diagnostics: seedPlan.diagnostics, value: null };
  const world: CompiledWorldV3 = {
    artifactSchemaVersion: PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION,
    compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
    compilerVersion: PREVIOUS_COMPILER_VERSION,
    controllers: [...lowered.controllers].sort((left, right) =>
      compareText(left.principalKey, right.principalKey),
    ),
    counts: {
      controllers: lowered.controllers.length,
      entities: lowered.entities.length,
      relationships: lowered.relationships.length,
    },
    economySeedPlan: seedPlan.value.plan,
    economySeedPlanHash: seedPlan.value.hash,
    entities: [...lowered.entities].sort((left, right) =>
      compareText(left.logicalKey, right.logicalKey),
    ),
    inputHash: previousInputHash,
    manifestContentHash: lowered.normalized.bundle.manifestContentHash,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    metadata: { ...lowered.normalized.manifest.metadata },
    relationships: [...lowered.relationships].sort((left, right) =>
      compareText(left.logicalKey, right.logicalKey),
    ),
    seed: lowered.normalized.bundle.seed,
    visualPlan: lowered.visualPlan,
    worldGraphSchemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
  };
  const diagnostics = validateCompiledWorldSemantics(world);
  if (diagnostics.length > 0) return { diagnostics, value: null };
  const canonicalBytes = canonicalJson(world);
  const artifact: CompiledArtifactV3 = {
    artifactKind: 'compiled_world',
    artifactSchemaVersion: PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION,
    canonicalBytes,
    contentHash: sha256Utf8(canonicalBytes),
    inputHash: previousInputHash,
    world,
  };
  if (!previousArtifactValidator.is(artifact)) {
    return {
      diagnostics: previousArtifactValidator.issues(artifact).map((issue) => ({
        code: 'PREVIOUS_ARTIFACT_SCHEMA_INVALID',
        message: `Compiler 1.2 compatibility emitter produced an invalid artifact: ${issue.message}`,
        pointer: issue.path,
        relatedKeys: [],
        retryable: false,
        severity: 'error',
        stage: 'emit',
      })),
      value: null,
    };
  }
  return { diagnostics: [], value: artifact };
}

export interface CompileLegacyCompatibilityResult {
  artifact: CompiledArtifactV1 | null;
  diagnostics: CompilerDiagnosticV1[];
  inputHash: string;
  successfulStage: 'none' | 'resolve' | 'validate' | 'normalize' | 'lower' | 'link' | 'emit';
}

export interface CompilePreviousCompatibilityResult {
  artifact: CompiledArtifactV3 | null;
  diagnostics: CompilerDiagnosticV1[];
  inputHash: string;
  successfulStage: 'none' | 'resolve' | 'validate' | 'normalize' | 'lower' | 'link' | 'emit';
}

export interface CompileGovernanceCompatibilityResult {
  artifact: CompiledArtifactV4 | null;
  diagnostics: CompilerDiagnosticV1[];
  inputHash: string;
  successfulStage: 'none' | 'resolve' | 'validate' | 'normalize' | 'lower' | 'link' | 'emit';
}

export interface CompileRetainedCompatibilityResult {
  artifact: CompiledArtifactV2 | null;
  diagnostics: CompilerDiagnosticV1[];
  inputHash: string;
  successfulStage: 'none' | 'resolve' | 'validate' | 'normalize' | 'lower' | 'link' | 'emit';
}

export function emitGovernanceCompiledArtifact(
  lowered: LoweredWorld,
  governanceInputHash: string,
): StageResult<CompiledArtifactV4> {
  const seedPlan = deriveLoweredEconomySeedPlanV2(lowered);
  if (!seedPlan.value) return { diagnostics: seedPlan.diagnostics, value: null };
  const governanceSeedPlan = deriveLoweredGovernanceSeedPlanV1(lowered);
  if (!governanceSeedPlan.value) {
    return { diagnostics: governanceSeedPlan.diagnostics, value: null };
  }
  const world: CompiledWorldV4 = {
    artifactSchemaVersion: GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION,
    compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
    compilerVersion: GOVERNANCE_COMPILER_VERSION,
    controllers: [...lowered.controllers].sort((left, right) =>
      compareText(left.principalKey, right.principalKey),
    ),
    counts: {
      controllers: lowered.controllers.length,
      entities: lowered.entities.length,
      relationships: lowered.relationships.length,
    },
    economySeedPlan: seedPlan.value.plan,
    economySeedPlanHash: seedPlan.value.hash,
    entities: [...lowered.entities].sort((left, right) =>
      compareText(left.logicalKey, right.logicalKey),
    ),
    governanceSeedPlan: governanceSeedPlan.value.plan,
    governanceSeedPlanHash: governanceSeedPlan.value.hash,
    inputHash: governanceInputHash,
    manifestContentHash: lowered.normalized.bundle.manifestContentHash,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    metadata: { ...lowered.normalized.manifest.metadata },
    relationships: [...lowered.relationships].sort((left, right) =>
      compareText(left.logicalKey, right.logicalKey),
    ),
    seed: lowered.normalized.bundle.seed,
    visualPlan: lowered.visualPlan,
    worldGraphSchemaVersion: WORLD_GRAPH_SCHEMA_VERSION,
  };
  const diagnostics = validateCompiledWorldSemantics(world);
  if (diagnostics.length > 0) return { diagnostics, value: null };
  const canonicalBytes = canonicalJson(world);
  const artifact: CompiledArtifactV4 = {
    artifactKind: 'compiled_world',
    artifactSchemaVersion: GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION,
    canonicalBytes,
    contentHash: sha256Utf8(canonicalBytes),
    inputHash: governanceInputHash,
    world,
  };
  if (!governanceArtifactValidator.is(artifact)) {
    return {
      diagnostics: governanceArtifactValidator.issues(artifact).map((issue) => ({
        code: 'GOVERNANCE_ARTIFACT_SCHEMA_INVALID',
        message: `Compiler 1.3 compatibility emitter produced an invalid artifact: ${issue.message}`,
        pointer: issue.path,
        relatedKeys: [],
        retryable: false,
        severity: 'error',
        stage: 'emit',
      })),
      value: null,
    };
  }
  return { diagnostics: [], value: artifact };
}

/** Reproduces the exact sealed compiler 1.3/artifact-4 identity. */
export function compileGovernanceArtifactForCompatibility(
  governance: GovernanceCompilerInputBundleV1,
): CompileGovernanceCompatibilityResult {
  const currentProvisional: CompilerInputBundleV1 = {
    ...governance,
    compilerVersion: COMPILER_VERSION,
    inputHash: '0'.repeat(64),
  };
  const current: CompilerInputBundleV1 = {
    ...currentProvisional,
    inputHash: compilerInputHash(currentProvisional),
  };
  const diagnostics: CompilerDiagnosticV1[] = [];
  const resolved = resolveCompilerInput(current);
  diagnostics.push(...resolved.diagnostics);
  if (!resolved.value) return result('none');
  const validated = validateResolvedInput(resolved.value);
  diagnostics.push(...validated.diagnostics);
  if (!validated.value) return result('resolve');
  const normalized = normalizeCompilerInput(validated.value);
  diagnostics.push(...normalized.diagnostics);
  if (!normalized.value) return result('validate');
  const lowered = lowerNormalizedInput(normalized.value);
  diagnostics.push(...lowered.diagnostics);
  if (!lowered.value) return result('normalize');
  const linked = linkLoweredWorld(lowered.value);
  diagnostics.push(...linked.diagnostics);
  if (!linked.value) return result('lower');
  const emitted = emitGovernanceCompiledArtifact(linked.value, governance.inputHash);
  diagnostics.push(...emitted.diagnostics);
  if (!emitted.value) return result('link');
  return {
    artifact: emitted.value,
    diagnostics: sortCompilerDiagnostics(diagnostics),
    inputHash: governance.inputHash,
    successfulStage: 'emit',
  };

  function result(
    successfulStage: CompileGovernanceCompatibilityResult['successfulStage'],
  ): CompileGovernanceCompatibilityResult {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash: governance.inputHash,
      successfulStage,
    };
  }
}

/** Reproduces the exact sealed compiler 1.1/artifact-2 identity. */
export function compileRetainedArtifactForCompatibility(
  retained: RetainedCompilerInputBundleV1,
): CompileRetainedCompatibilityResult {
  const currentProvisional: CompilerInputBundleV1 = {
    ...retained,
    compilerVersion: COMPILER_VERSION,
    inputHash: '0'.repeat(64),
  };
  const current: CompilerInputBundleV1 = {
    ...currentProvisional,
    inputHash: compilerInputHash(currentProvisional),
  };
  const diagnostics: CompilerDiagnosticV1[] = [];
  const resolved = resolveCompilerInput(current);
  diagnostics.push(...resolved.diagnostics);
  if (!resolved.value) return result('none');
  const validated = validateResolvedInput(resolved.value);
  diagnostics.push(...validated.diagnostics);
  if (!validated.value) return result('resolve');
  const normalized = normalizeCompilerInput(validated.value);
  diagnostics.push(...normalized.diagnostics);
  if (!normalized.value) return result('validate');
  const lowered = lowerNormalizedInput(normalized.value);
  diagnostics.push(...lowered.diagnostics);
  if (!lowered.value) return result('normalize');
  const linked = linkLoweredWorld(lowered.value);
  diagnostics.push(...linked.diagnostics);
  if (!linked.value) return result('lower');
  const emitted = emitRetainedCompiledArtifact(linked.value, retained.inputHash);
  diagnostics.push(...emitted.diagnostics);
  if (!emitted.value) return result('link');
  return {
    artifact: emitted.value,
    diagnostics: sortCompilerDiagnostics(diagnostics),
    inputHash: retained.inputHash,
    successfulStage: 'emit',
  };

  function result(
    successfulStage: CompileRetainedCompatibilityResult['successfulStage'],
  ): CompileRetainedCompatibilityResult {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash: retained.inputHash,
      successfulStage,
    };
  }
}

/** Reproduces the exact sealed compiler 1.2/artifact-3 identity. */
export function compilePreviousArtifactForCompatibility(
  previous: PreviousCompilerInputBundleV1,
): CompilePreviousCompatibilityResult {
  const currentProvisional: CompilerInputBundleV1 = {
    ...previous,
    compilerVersion: COMPILER_VERSION,
    inputHash: '0'.repeat(64),
  };
  const current: CompilerInputBundleV1 = {
    ...currentProvisional,
    inputHash: compilerInputHash(currentProvisional),
  };
  const diagnostics: CompilerDiagnosticV1[] = [];
  const resolved = resolveCompilerInput(current);
  diagnostics.push(...resolved.diagnostics);
  if (!resolved.value) return result('none');
  const validated = validateResolvedInput(resolved.value);
  diagnostics.push(...validated.diagnostics);
  if (!validated.value) return result('resolve');
  const normalized = normalizeCompilerInput(validated.value);
  diagnostics.push(...normalized.diagnostics);
  if (!normalized.value) return result('validate');
  const lowered = lowerNormalizedInput(normalized.value);
  diagnostics.push(...lowered.diagnostics);
  if (!lowered.value) return result('normalize');
  const linked = linkLoweredWorld(lowered.value);
  diagnostics.push(...linked.diagnostics);
  if (!linked.value) return result('lower');
  const emitted = emitPreviousCompiledArtifact(linked.value, previous.inputHash);
  diagnostics.push(...emitted.diagnostics);
  if (!emitted.value) return result('link');
  return {
    artifact: emitted.value,
    diagnostics: sortCompilerDiagnostics(diagnostics),
    inputHash: previous.inputHash,
    successfulStage: 'emit',
  };

  function result(
    successfulStage: CompilePreviousCompatibilityResult['successfulStage'],
  ): CompilePreviousCompatibilityResult {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash: previous.inputHash,
      successfulStage,
    };
  }
}

/**
 * Compatibility-only generator used to prove the frozen 1.0 schema/hash. New
 * production compilation always enters `compileWorld` and emits artifact V4.
 */
export function compileLegacyArtifactForCompatibility(
  legacy: LegacyCompilerInputBundleV1,
): CompileLegacyCompatibilityResult {
  const currentProvisional: CompilerInputBundleV1 = {
    ...legacy,
    compilerVersion: COMPILER_VERSION,
    inputHash: '0'.repeat(64),
  };
  const current: CompilerInputBundleV1 = {
    ...currentProvisional,
    inputHash: compilerInputHash(currentProvisional),
  };
  const diagnostics: CompilerDiagnosticV1[] = [];
  const resolved = resolveCompilerInput(current);
  diagnostics.push(...resolved.diagnostics);
  if (!resolved.value) return result('none');
  const validated = validateResolvedInput(resolved.value);
  diagnostics.push(...validated.diagnostics);
  if (!validated.value) return result('resolve');
  const normalized = normalizeCompilerInput(validated.value);
  diagnostics.push(...normalized.diagnostics);
  if (!normalized.value) return result('validate');
  const lowered = lowerNormalizedInput(normalized.value);
  diagnostics.push(...lowered.diagnostics);
  if (!lowered.value) return result('normalize');
  const linked = linkLoweredWorld(lowered.value);
  diagnostics.push(...linked.diagnostics);
  if (!linked.value) return result('lower');
  const emitted = emitLegacyCompiledArtifact(linked.value, legacy.inputHash);
  diagnostics.push(...emitted.diagnostics);
  if (!emitted.value) return result('link');
  return {
    artifact: emitted.value,
    diagnostics: sortCompilerDiagnostics(diagnostics),
    inputHash: legacy.inputHash,
    successfulStage: 'emit',
  };

  function result(
    successfulStage: CompileLegacyCompatibilityResult['successfulStage'],
  ): CompileLegacyCompatibilityResult {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash: legacy.inputHash,
      successfulStage,
    };
  }
}
