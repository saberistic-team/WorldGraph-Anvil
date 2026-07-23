import type { PrimitiveDependencyInput } from '@worldgraph/contracts';

import { compareCodePoints } from './retrieval.js';
import { highestSatisfying, satisfiesVersionRange as satisfiesLocked } from './semver.js';

export interface PublishedPrimitiveRef {
  contentHash: string;
  dependencies: PrimitiveDependencyInput[];
  key: string;
  version: string;
  versionId: string;
}

export interface ResolvedDependency {
  contentHash: string | null;
  key: string;
  required: boolean;
  resolvedVersion: string | null;
  resolvedVersionId: string | null;
  versionRange: string;
}

export interface DependencyResolution {
  closure: { contentHash: string; key: string; version: string; versionId: string }[];
  issues: { code: string; key: string; path: string[]; versionRange: string }[];
  resolved: ResolvedDependency[];
}

export function resolveDependencies(
  rootKey: string,
  dependencies: readonly PrimitiveDependencyInput[],
  catalog: readonly PublishedPrimitiveRef[],
): DependencyResolution {
  const byKey = new Map<string, PublishedPrimitiveRef[]>();
  for (const primitive of catalog) {
    const versions = byKey.get(primitive.key) ?? [];
    versions.push(primitive);
    byKey.set(primitive.key, versions);
  }
  const issues: DependencyResolution['issues'] = [];
  const resolved: ResolvedDependency[] = [];
  const closure = new Map<string, PublishedPrimitiveRef>();
  const visiting = new Set<string>([rootKey]);
  const path = [rootKey];

  const walk = (owner: string, edges: readonly PrimitiveDependencyInput[]) => {
    for (const edge of [...edges].sort((left, right) => compareCodePoints(left.key, right.key))) {
      const required = edge.required ?? true;
      const available = byKey.get(edge.key) ?? [];
      const locked = closure.get(edge.key);
      if (locked && !satisfiesLocked(locked.version, edge.versionRange)) {
        issues.push({
          code: 'DEPENDENCY_VERSION_CONFLICT',
          key: edge.key,
          path: [...path, edge.key],
          versionRange: edge.versionRange,
        });
        if (owner === rootKey)
          resolved.push({
            contentHash: null,
            key: edge.key,
            required,
            resolvedVersion: null,
            resolvedVersionId: null,
            versionRange: edge.versionRange,
          });
        continue;
      }
      const version =
        locked?.version ??
        highestSatisfying(
          available.map((entry) => entry.version),
          edge.versionRange,
        );
      if (!version) {
        if (owner === rootKey)
          resolved.push({
            contentHash: null,
            key: edge.key,
            required,
            resolvedVersion: null,
            resolvedVersionId: null,
            versionRange: edge.versionRange,
          });
        if (required)
          issues.push({
            code: 'DEPENDENCY_UNRESOLVED',
            key: edge.key,
            path: [...path, edge.key],
            versionRange: edge.versionRange,
          });
        continue;
      }
      const target = locked ?? available.find((entry) => entry.version === version)!;
      if (owner === rootKey)
        resolved.push({
          contentHash: target.contentHash,
          key: edge.key,
          required,
          resolvedVersion: version,
          resolvedVersionId: target.versionId,
          versionRange: edge.versionRange,
        });
      if (visiting.has(edge.key)) {
        issues.push({
          code: 'DEPENDENCY_CYCLE',
          key: edge.key,
          path: [...path, edge.key],
          versionRange: edge.versionRange,
        });
        continue;
      }
      if (locked) {
        continue;
      }
      if (closure.size >= 128 || path.length >= 32) {
        issues.push({
          code: 'DEPENDENCY_GRAPH_LIMIT',
          key: edge.key,
          path: [...path, edge.key],
          versionRange: edge.versionRange,
        });
        continue;
      }
      closure.set(edge.key, target);
      visiting.add(edge.key);
      path.push(edge.key);
      walk(edge.key, target.dependencies);
      path.pop();
      visiting.delete(edge.key);
    }
  };

  walk(rootKey, dependencies);
  return {
    closure: [...closure]
      .map(([key, value]) => ({
        contentHash: value.contentHash,
        key,
        version: value.version,
        versionId: value.versionId,
      }))
      .sort((left, right) => compareCodePoints(left.key, right.key)),
    issues,
    resolved,
  };
}
