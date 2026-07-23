import { primitiveContentHash, primitiveSemanticDocument } from '@worldgraph/catalog';
import {
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  MANIFEST_SCHEMA_VERSION,
  LEGACY_COMPILER_VERSION,
  PREVIOUS_COMPILER_VERSION,
  PRIMITIVE_SCHEMA_VERSION,
  canonicalJson,
  type ActiveMemberPrincipalV1,
  type CompilerConfigurationV1,
  type CompilerInputBundleV1,
  type ExactPrimitiveInputV1,
  type LegacyCompilerInputBundleV1,
  type PreviousCompilerInputBundleV1,
  type PrimitiveDraftInput,
  type WorldManifestV1,
} from '@worldgraph/contracts';

import { compilerInputHash, sha256Utf8 } from './hash.js';

export const DEFAULT_COMPILER_CONFIGURATION: CompilerConfigurationV1 = {
  adapterRegistryVersion: 1,
  deprecatedPrimitivePolicy: 'reject',
  maxEntities: 5_000,
  maxRelationships: 10_000,
};

export interface ExactPrimitiveSource {
  canonicalBytes?: string;
  contentHash?: string;
  definition: PrimitiveDraftInput;
  lifecycle: 'deprecated' | 'published';
  primitiveVersionId: string;
}

export interface CreateCompilerInputBundleOptions {
  activeMembers: readonly ActiveMemberPrincipalV1[];
  compilerConfig?: CompilerConfigurationV1;
  manifest: WorldManifestV1;
  primitives: readonly ExactPrimitiveSource[];
  seed: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactPrimitive(source: ExactPrimitiveSource): ExactPrimitiveInputV1 {
  const definition = JSON.parse(canonicalJson(source.definition)) as PrimitiveDraftInput;
  return {
    canonicalBytes: source.canonicalBytes ?? canonicalJson(primitiveSemanticDocument(definition)),
    contentHash: source.contentHash ?? primitiveContentHash(definition),
    definition,
    lifecycle: source.lifecycle,
    primitiveVersionId: source.primitiveVersionId,
  };
}

export function createCompilerInputBundle(
  options: CreateCompilerInputBundleOptions,
): CompilerInputBundleV1 {
  const manifest = JSON.parse(canonicalJson(options.manifest)) as WorldManifestV1;
  const manifestCanonicalBytes = canonicalJson(manifest);
  const provisional: CompilerInputBundleV1 = {
    activeMembers: options.activeMembers
      .map((member) => ({ ...member }))
      .sort((left, right) => compareText(left.principalKey, right.principalKey)),
    compilerConfig: { ...(options.compilerConfig ?? DEFAULT_COMPILER_CONFIGURATION) },
    compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    inputHash: '0'.repeat(64),
    manifest,
    manifestCanonicalBytes,
    manifestContentHash: sha256Utf8(manifestCanonicalBytes),
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    primitiveSchemaVersion: PRIMITIVE_SCHEMA_VERSION,
    primitives: options.primitives.map(exactPrimitive).sort((left, right) => {
      const keyOrder = compareText(left.definition.key, right.definition.key);
      return (
        keyOrder ||
        compareText(left.definition.version, right.definition.version) ||
        compareText(left.primitiveVersionId, right.primitiveVersionId)
      );
    }),
    seed: options.seed.normalize('NFC'),
  };
  return { ...provisional, inputHash: compilerInputHash(provisional) };
}

/** Produces the frozen 1.0 input identity for compatibility fixtures/adoption. */
export function createLegacyCompilerInputBundle(
  options: CreateCompilerInputBundleOptions,
): LegacyCompilerInputBundleV1 {
  const current = createCompilerInputBundle(options);
  const provisional: LegacyCompilerInputBundleV1 = {
    ...current,
    compilerVersion: LEGACY_COMPILER_VERSION,
    inputHash: '0'.repeat(64),
  };
  return { ...provisional, inputHash: compilerInputHash(provisional) };
}

/** Produces the frozen 1.1 input identity for artifact-2 compatibility. */
export function createPreviousCompilerInputBundle(
  options: CreateCompilerInputBundleOptions,
): PreviousCompilerInputBundleV1 {
  const current = createCompilerInputBundle(options);
  const provisional: PreviousCompilerInputBundleV1 = {
    ...current,
    compilerVersion: PREVIOUS_COMPILER_VERSION,
    inputHash: '0'.repeat(64),
  };
  return { ...provisional, inputHash: compilerInputHash(provisional) };
}
