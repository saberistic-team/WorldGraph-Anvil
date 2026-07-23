import { createHash } from 'node:crypto';

import {
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  CompiledArtifactV1Schema,
  CompiledArtifactV2Schema,
  CompiledArtifactV3Schema,
  LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION,
  LEGACY_COMPILER_VERSION,
  PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION,
  PREVIOUS_COMPILER_VERSION,
  WorldEntityStatePairV1Validator,
  WorldRelationshipAttributesPairV1Validator,
  canonicalJson,
  createValidator,
  type CompiledArtifactV1,
  type CompiledArtifactV2,
  type CompiledArtifactV3,
  type CompiledWorld,
  type CompilerDiagnosticV1,
  type CompilerInputBundleV1,
  type LegacyCompilerInputBundleV1,
  type PreviousCompilerInputBundleV1,
} from '@worldgraph/contracts';
import { assertEconomySeedPlanV2, economySeedPlanHash } from '@worldgraph/economy';

import { deriveEconomySeedPlanV1 } from './economy-seed.js';
import { validateCompiledWorldSemantics } from './invariants.js';

export function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Returns the semantic identity of a compiler input. `inputHash` itself is
 * deliberately omitted; every array whose source order is non-semantic is
 * code-point sorted before canonical serialization.
 */
export function compilerInputHash(
  bundle: CompilerInputBundleV1 | LegacyCompilerInputBundleV1 | PreviousCompilerInputBundleV1,
): string {
  return sha256Utf8(
    canonicalJson({
      activeMembers: [...bundle.activeMembers].sort((left, right) =>
        compareText(left.principalKey, right.principalKey),
      ),
      compilerConfig: bundle.compilerConfig,
      compilerConfigVersion: bundle.compilerConfigVersion,
      compilerVersion: bundle.compilerVersion,
      contract: 'CompilerInputBundle',
      manifestCanonicalBytes: bundle.manifestCanonicalBytes,
      manifestContentHash: bundle.manifestContentHash,
      manifestSchemaVersion: bundle.manifestSchemaVersion,
      primitiveSchemaVersion: bundle.primitiveSchemaVersion,
      primitives: [...bundle.primitives]
        .sort((left, right) => {
          const keyOrder = compareText(left.definition.key, right.definition.key);
          return keyOrder || compareText(left.definition.version, right.definition.version);
        })
        .map((primitive) => ({
          canonicalBytes: primitive.canonicalBytes,
          contentHash: primitive.contentHash,
          lifecycle: primitive.lifecycle,
          primitiveVersionId: primitive.primitiveVersionId,
        })),
      schemaVersion: 1,
      seed: bundle.seed,
    }),
  );
}

export function compiledArtifactHash(world: CompiledWorld): string {
  return sha256Utf8(canonicalJson(world));
}

export interface ArtifactVerificationResult {
  computedHash: string | null;
  diagnostics: CompilerDiagnosticV1[];
  valid: boolean;
}

const verificationDiagnostic = (
  code: string,
  message: string,
  pointer: string,
): CompilerDiagnosticV1 => ({
  code,
  message,
  pointer,
  relatedKeys: [],
  retryable: false,
  severity: 'error',
  stage: 'emit',
});

const legacyArtifactValidator = createValidator<CompiledArtifactV1>(CompiledArtifactV1Schema);
const previousArtifactValidator = createValidator<CompiledArtifactV2>(CompiledArtifactV2Schema);
const currentArtifactValidator = createValidator<CompiledArtifactV3>(CompiledArtifactV3Schema);

function invalidPayloadDiagnostics(input: unknown): CompilerDiagnosticV1[] {
  if (input === null || typeof input !== 'object' || !('world' in input)) return [];
  const world = input.world;
  if (world === null || typeof world !== 'object') return [];
  const diagnostics: CompilerDiagnosticV1[] = [];
  if ('entities' in world && Array.isArray(world.entities)) {
    const entities: readonly unknown[] = world.entities;
    for (const [index, entity] of entities.entries()) {
      if (entity === null || typeof entity !== 'object') continue;
      const pair = {
        entityType: 'entityType' in entity ? entity.entityType : undefined,
        state: 'state' in entity ? entity.state : undefined,
      };
      if (!WorldEntityStatePairV1Validator.is(pair)) {
        diagnostics.push(
          ...WorldEntityStatePairV1Validator.issues(pair).map((issue) =>
            verificationDiagnostic(
              'ARTIFACT_ENTITY_STATE_INVALID',
              `Entity state does not match its declared type: ${issue.message}`,
              `/world/entities/${index}${issue.path === '/' ? '' : issue.path}`,
            ),
          ),
        );
      }
    }
  }
  if ('relationships' in world && Array.isArray(world.relationships)) {
    const relationships: readonly unknown[] = world.relationships;
    for (const [index, relationship] of relationships.entries()) {
      if (relationship === null || typeof relationship !== 'object') continue;
      const pair = {
        attributes: 'attributes' in relationship ? relationship.attributes : undefined,
        relationshipType:
          'relationshipType' in relationship ? relationship.relationshipType : undefined,
      };
      if (!WorldRelationshipAttributesPairV1Validator.is(pair)) {
        diagnostics.push(
          ...WorldRelationshipAttributesPairV1Validator.issues(pair).map((issue) =>
            verificationDiagnostic(
              'ARTIFACT_RELATIONSHIP_ATTRIBUTES_INVALID',
              `Relationship attributes do not match its declared type: ${issue.message}`,
              `/world/relationships/${index}${issue.path === '/' ? '' : issue.path}`,
            ),
          ),
        );
      }
    }
  }
  return diagnostics.slice(0, 128);
}

function field(input: object | null, key: string): unknown {
  return input !== null && key in input ? (input as Record<string, unknown>)[key] : undefined;
}

function selectedValidator(
  input: unknown,
):
  | typeof legacyArtifactValidator
  | typeof previousArtifactValidator
  | typeof currentArtifactValidator
  | null {
  const artifact = input !== null && typeof input === 'object' ? input : null;
  const worldValue = field(artifact, 'world');
  const world = worldValue !== null && typeof worldValue === 'object' ? worldValue : null;
  const artifactSchemaVersion = field(artifact, 'artifactSchemaVersion');
  const worldArtifactSchemaVersion = field(world, 'artifactSchemaVersion');
  const compilerVersion = field(world, 'compilerVersion');
  if (
    artifactSchemaVersion === LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION &&
    worldArtifactSchemaVersion === LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION &&
    compilerVersion === LEGACY_COMPILER_VERSION
  ) {
    return legacyArtifactValidator;
  }
  if (
    artifactSchemaVersion === PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION &&
    worldArtifactSchemaVersion === PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION &&
    compilerVersion === PREVIOUS_COMPILER_VERSION
  ) {
    return previousArtifactValidator;
  }
  if (
    artifactSchemaVersion === COMPILED_ARTIFACT_SCHEMA_VERSION &&
    worldArtifactSchemaVersion === COMPILED_ARTIFACT_SCHEMA_VERSION &&
    compilerVersion === COMPILER_VERSION
  ) {
    return currentArtifactValidator;
  }
  return null;
}

export function verifyCompiledArtifact(input: unknown): ArtifactVerificationResult {
  const validator = selectedValidator(input);
  if (validator === null) {
    return {
      computedHash: null,
      diagnostics: [
        ...invalidPayloadDiagnostics(input),
        verificationDiagnostic(
          'ARTIFACT_VERSION_PAIR_UNSUPPORTED',
          'Artifact must use the exact supported pair 1/1.0.0, 2/1.1.0, or 3/1.2.0.',
          '/artifactSchemaVersion',
        ),
      ].slice(0, 128),
      valid: false,
    };
  }
  if (!validator.is(input)) {
    return {
      computedHash: null,
      diagnostics: [
        ...invalidPayloadDiagnostics(input),
        ...validator
          .issues(input)
          .map((issue) =>
            verificationDiagnostic(
              'ARTIFACT_SCHEMA_INVALID',
              `Artifact is invalid: ${issue.message}`,
              issue.path,
            ),
          ),
      ].slice(0, 128),
      valid: false,
    };
  }
  const artifact = input;
  const diagnostics: CompilerDiagnosticV1[] = [];
  diagnostics.push(...validateCompiledWorldSemantics(artifact.world));
  if (artifact.world.compilerConfigVersion !== COMPILER_CONFIG_SCHEMA_VERSION) {
    diagnostics.push(
      verificationDiagnostic(
        'COMPILER_CONFIG_VERSION_MISMATCH',
        'Artifact compiler configuration version is not supported by this verifier.',
        '/world/compilerConfigVersion',
      ),
    );
  }
  const canonicalBytes = canonicalJson(artifact.world);
  if (canonicalBytes !== artifact.canonicalBytes) {
    diagnostics.push(
      verificationDiagnostic(
        'ARTIFACT_CANONICAL_BYTES_MISMATCH',
        'Artifact canonical bytes do not exactly encode the embedded compiled world.',
        '/canonicalBytes',
      ),
    );
  }
  const computedHash = sha256Utf8(canonicalBytes);
  if (computedHash !== artifact.contentHash) {
    diagnostics.push(
      verificationDiagnostic(
        'ARTIFACT_HASH_MISMATCH',
        'Artifact content hash does not match the canonical compiled world.',
        '/contentHash',
      ),
    );
  }
  if (artifact.inputHash !== artifact.world.inputHash) {
    diagnostics.push(
      verificationDiagnostic(
        'ARTIFACT_INPUT_HASH_MISMATCH',
        'Artifact wrapper and compiled world disagree on input identity.',
        '/inputHash',
      ),
    );
  }
  if (artifact.world.artifactSchemaVersion === PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION) {
    const planHash = economySeedPlanHash(artifact.world.economySeedPlan);
    if (planHash !== artifact.world.economySeedPlanHash) {
      diagnostics.push(
        verificationDiagnostic(
          'ECONOMY_SEED_PLAN_HASH_MISMATCH',
          'Economy seed plan hash does not match the embedded semantic plan.',
          '/world/economySeedPlanHash',
        ),
      );
    }
    const derived = deriveEconomySeedPlanV1(artifact.world);
    diagnostics.push(...derived.diagnostics);
    if (
      derived.value &&
      canonicalJson(derived.value.plan) !== canonicalJson(artifact.world.economySeedPlan)
    ) {
      diagnostics.push(
        verificationDiagnostic(
          'ECONOMY_SEED_PLAN_GRAPH_MISMATCH',
          'Embedded economy seed plan is not the exact deterministic plan for this graph.',
          '/world/economySeedPlan',
        ),
      );
    }
  } else if (artifact.world.artifactSchemaVersion === COMPILED_ARTIFACT_SCHEMA_VERSION) {
    const planHash = economySeedPlanHash(artifact.world.economySeedPlan);
    if (planHash !== artifact.world.economySeedPlanHash) {
      diagnostics.push(
        verificationDiagnostic(
          'ECONOMY_SEED_PLAN_HASH_MISMATCH',
          'Economy seed plan hash does not match the embedded semantic plan.',
          '/world/economySeedPlanHash',
        ),
      );
    }
    try {
      assertEconomySeedPlanV2(artifact.world.economySeedPlan);
    } catch {
      diagnostics.push(
        verificationDiagnostic(
          'ECONOMY_SEED_PLAN_INVALID',
          'Economy seed plan does not satisfy the V2 closure invariants.',
          '/world/economySeedPlan',
        ),
      );
    }
  }
  return { computedHash, diagnostics, valid: diagnostics.length === 0 };
}
