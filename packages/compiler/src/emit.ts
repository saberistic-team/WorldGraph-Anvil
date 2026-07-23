import {
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  CompiledArtifactV3Schema,
  MANIFEST_SCHEMA_VERSION,
  WORLD_GRAPH_SCHEMA_VERSION,
  WorldEntityStatePairV1Validator,
  WorldRelationshipAttributesPairV1Validator,
  canonicalJson,
  createValidator,
  type CompiledArtifactV3,
  type CompiledWorldV3,
  type CompilerDiagnosticV1,
} from '@worldgraph/contracts';

import { compilerDiagnostic, sortCompilerDiagnostics } from './diagnostics.js';
import { deriveLoweredEconomySeedPlanV2 } from './economy-seed.js';
import { compiledArtifactHash } from './hash.js';
import { validateCompiledWorldSemantics } from './invariants.js';
import type { LoweredWorld, StageResult } from './types.js';

const artifactValidator = createValidator<CompiledArtifactV3>(CompiledArtifactV3Schema);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function emitCompiledArtifact(lowered: LoweredWorld): StageResult<CompiledArtifactV3> {
  const seedPlan = deriveLoweredEconomySeedPlanV2(lowered);
  if (!seedPlan.value) return { diagnostics: seedPlan.diagnostics, value: null };
  const world: CompiledWorldV3 = {
    artifactSchemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
    compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
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
    inputHash: lowered.normalized.bundle.inputHash,
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
  const semanticDiagnostics = validateCompiledWorldSemantics(world);
  if (semanticDiagnostics.length > 0) {
    return { diagnostics: semanticDiagnostics, value: null };
  }
  const canonicalBytes = canonicalJson(world);
  const artifact: CompiledArtifactV3 = {
    artifactKind: 'compiled_world',
    artifactSchemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
    canonicalBytes,
    contentHash: compiledArtifactHash(world),
    inputHash: world.inputHash,
    world,
  };
  if (!artifactValidator.is(artifact)) {
    const diagnostics: CompilerDiagnosticV1[] = [];
    for (const [index, entity] of lowered.entities.entries()) {
      const pair = { entityType: entity.entityType, state: entity.state };
      if (!WorldEntityStatePairV1Validator.is(pair)) {
        diagnostics.push(
          ...WorldEntityStatePairV1Validator.issues(pair).map((issue) =>
            compilerDiagnostic(
              'emit',
              'COMPILED_ENTITY_STATE_INVALID',
              `/entities/${index}${issue.path === '/' ? '' : issue.path}`,
              `Compiler emitted state that does not match its entity type: ${issue.message}`,
              { relatedKeys: [entity.logicalKey] },
            ),
          ),
        );
      }
    }
    for (const [index, relationship] of lowered.relationships.entries()) {
      const pair = {
        attributes: relationship.attributes,
        relationshipType: relationship.relationshipType,
      };
      if (!WorldRelationshipAttributesPairV1Validator.is(pair)) {
        diagnostics.push(
          ...WorldRelationshipAttributesPairV1Validator.issues(pair).map((issue) =>
            compilerDiagnostic(
              'emit',
              'COMPILED_RELATIONSHIP_ATTRIBUTES_INVALID',
              `/relationships/${index}${issue.path === '/' ? '' : issue.path}`,
              `Compiler emitted attributes that do not match their relationship type: ${issue.message}`,
              { relatedKeys: [relationship.logicalKey] },
            ),
          ),
        );
      }
    }
    diagnostics.push(
      ...artifactValidator
        .issues(artifact)
        .map((issue) =>
          compilerDiagnostic(
            'emit',
            'COMPILED_ARTIFACT_SCHEMA_INVALID',
            issue.path,
            `Compiler emitted an invalid artifact: ${issue.message}`,
          ),
        ),
    );
    return { diagnostics: sortCompilerDiagnostics(diagnostics).slice(0, 128), value: null };
  }
  return { diagnostics: [], value: artifact };
}
