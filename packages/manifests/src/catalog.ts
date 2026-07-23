import { HARBOR_CITY_ECONOMY_PRIMITIVES, STARTER_PRIMITIVES } from '@worldgraph/catalog';
import {
  canonicalizeJson,
  type JsonValue,
  type PrimitiveKind,
  type WorldManifestV1,
} from '@worldgraph/contracts';

export interface ManifestPrimitiveDependency {
  key: string;
  required: boolean;
  versionRange: string;
}

export interface ManifestPrimitiveDefinition {
  behaviorRef: string | null;
  compatibility: Record<string, JsonValue>;
  contentHash: string;
  defaults: Record<string, JsonValue>;
  dependencies: readonly ManifestPrimitiveDependency[];
  key: string;
  kind: PrimitiveKind;
  lifecycle: 'deprecated' | 'published';
  parameterSchema: Record<string, JsonValue>;
  version: string;
  versionId: string;
}

export interface ManifestCatalogSnapshot {
  primitives: readonly ManifestPrimitiveDefinition[];
}

function jsonObject(input: unknown): Record<string, JsonValue> {
  const value = canonicalizeJson(input);
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('Expected a JSON object.');
  }
  return value;
}

export function starterManifestCatalog(): ManifestCatalogSnapshot {
  return {
    primitives: STARTER_PRIMITIVES.map((entry) => ({
      behaviorRef: entry.input.behaviorRef ?? null,
      compatibility: jsonObject(entry.input.compatibility),
      contentHash: entry.contentHash,
      defaults: jsonObject(entry.input.defaults),
      dependencies: entry.input.dependencies.map((dependency) => ({
        key: dependency.key,
        required: dependency.required ?? true,
        versionRange: dependency.versionRange,
      })),
      key: entry.input.key,
      kind: entry.input.kind,
      lifecycle: 'published' as const,
      parameterSchema: jsonObject(entry.input.parameterSchema),
      version: entry.input.version,
      versionId: entry.versionId,
    })),
  };
}

/**
 * M09 catalog snapshot. The M03 starter snapshot remains the original exact
 * 16 entries; this opt-in snapshot adds only the separately reviewed harbor
 * economy primitives.
 */
export function harborCityManifestCatalog(): ManifestCatalogSnapshot {
  return {
    primitives: [...STARTER_PRIMITIVES, ...HARBOR_CITY_ECONOMY_PRIMITIVES].map((entry) => ({
      behaviorRef: entry.input.behaviorRef ?? null,
      compatibility: jsonObject(entry.input.compatibility),
      contentHash: entry.contentHash,
      defaults: jsonObject(entry.input.defaults),
      dependencies: entry.input.dependencies.map((dependency) => ({
        key: dependency.key,
        required: dependency.required ?? true,
        versionRange: dependency.versionRange,
      })),
      key: entry.input.key,
      kind: entry.input.kind,
      lifecycle: 'published' as const,
      parameterSchema: jsonObject(entry.input.parameterSchema),
      version: entry.input.version,
      versionId: entry.versionId,
    })),
  };
}

export function manifestPrimitiveByRef(
  manifest: WorldManifestV1,
): ReadonlyMap<string, WorldManifestV1['primitiveRefs'][number]> {
  return new Map(manifest.primitiveRefs.map((primitive) => [primitive.ref, primitive]));
}
