import {
  validateWorldManifest,
  type ManifestCatalogSnapshot,
} from '@worldgraph/manifests/validation';
import type { CompilerDiagnosticV1, JsonValue } from '@worldgraph/contracts';

import { compilerAdapterFor } from './adapters.js';
import { compilerDiagnostic, hasCompilerErrors, sortCompilerDiagnostics } from './diagnostics.js';
import { validateCompilerPrivateContent } from './privacy.js';
import type { ResolvedCompilerInput, StageResult } from './types.js';

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function unsafeNumbers(value: unknown, pointer: string, diagnostics: CompilerDiagnosticV1[]): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      diagnostics.push(
        compilerDiagnostic(
          'validate',
          'UNSAFE_NUMERIC_INPUT',
          pointer,
          'Compiler semantic numbers must be safe integers; use bounded decimal strings otherwise.',
        ),
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => unsafeNumbers(item, `${pointer}/${index}`, diagnostics));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      unsafeNumbers(item, `${pointer}/${pointerToken(key)}`, diagnostics);
    }
  }
}

function catalogSnapshot(input: ResolvedCompilerInput): ManifestCatalogSnapshot {
  return {
    primitives: input.orderedPrimitives.map((primitive) => ({
      behaviorRef: primitive.definition.behaviorRef ?? null,
      compatibility: primitive.definition.compatibility as Record<string, JsonValue>,
      contentHash: primitive.contentHash,
      defaults: primitive.definition.defaults as Record<string, JsonValue>,
      dependencies: primitive.definition.dependencies.map((dependency) => ({
        key: dependency.key,
        required: dependency.required ?? true,
        versionRange: dependency.versionRange,
      })),
      key: primitive.definition.key,
      kind: primitive.definition.kind,
      lifecycle: primitive.lifecycle,
      parameterSchema: primitive.definition.parameterSchema as Record<string, JsonValue>,
      version: primitive.definition.version,
      versionId: primitive.primitiveVersionId,
    })),
  };
}

export function validateResolvedInput(
  resolved: ResolvedCompilerInput,
): StageResult<ResolvedCompilerInput> {
  const diagnostics: CompilerDiagnosticV1[] = [];
  const manifestValidation = validateWorldManifest(
    resolved.bundle.manifest,
    catalogSnapshot(resolved),
  );
  for (const diagnostic of manifestValidation.diagnostics) {
    diagnostics.push(
      compilerDiagnostic(
        'validate',
        diagnostic.code,
        `/manifest${diagnostic.pointer}`,
        diagnostic.message,
        { severity: diagnostic.severity },
      ),
    );
  }
  resolved.orderedPrimitives.forEach((primitive, index) => {
    if (!compilerAdapterFor(primitive.definition)) {
      diagnostics.push(
        compilerDiagnostic(
          'validate',
          'UNSUPPORTED_PRIMITIVE_BEHAVIOR',
          `/primitives/${index}/definition/behaviorRef`,
          'No code-reviewed compiler adapter supports this primitive kind and behavior reference.',
          { relatedKeys: [primitive.definition.key] },
        ),
      );
    }
    unsafeNumbers(primitive.definition, `/primitives/${index}/definition`, diagnostics);
  });
  unsafeNumbers(resolved.bundle.manifest, '/manifest', diagnostics);
  diagnostics.push(
    ...validateCompilerPrivateContent(resolved.bundle.manifest, '/manifest', 'validate'),
  );
  resolved.orderedPrimitives.forEach((primitive, index) => {
    diagnostics.push(
      ...validateCompilerPrivateContent(
        primitive.definition,
        `/primitives/${index}/definition`,
        'validate',
      ),
    );
  });

  const principalKeys = new Set<string>();
  resolved.bundle.activeMembers.forEach((member, index) => {
    if (principalKeys.has(member.principalKey)) {
      diagnostics.push(
        compilerDiagnostic(
          'validate',
          'DUPLICATE_MEMBER_PRINCIPAL',
          `/activeMembers/${index}/principalKey`,
          'Each active member principal may be compiled only once.',
          { relatedKeys: [member.principalKey] },
        ),
      );
    }
    principalKeys.add(member.principalKey);
  });
  if (
    resolved.bundle.activeMembers.length > 0 &&
    !resolved.bundle.manifest.actors.some((actor) => actor.controller === 'player')
  ) {
    diagnostics.push(
      compilerDiagnostic(
        'validate',
        'PLAYER_ACTOR_BLUEPRINT_MISSING',
        '/manifest/actors',
        'At least one player actor blueprint is required for active member characters.',
      ),
    );
  }

  const playableMemberCount = resolved.bundle.activeMembers.filter(
    (member) => member.role !== 'observer',
  ).length;
  const estimatedEntities =
    resolved.bundle.manifest.primitiveRefs.length +
    resolved.bundle.manifest.districts.length +
    resolved.bundle.manifest.institutions.length +
    resolved.bundle.manifest.organizations.length +
    resolved.bundle.manifest.actors.length +
    playableMemberCount * 2 +
    resolved.bundle.manifest.economy.resourcePrimitiveRefs.length +
    resolved.bundle.manifest.economy.productionPrimitiveRefs.length +
    resolved.bundle.manifest.economy.taxPrimitiveRefs.length +
    4;
  if (estimatedEntities > resolved.bundle.compilerConfig.maxEntities) {
    diagnostics.push(
      compilerDiagnostic(
        'validate',
        'ENTITY_LIMIT_EXCEEDED',
        '/compilerConfig/maxEntities',
        'The compiled world would exceed the configured entity limit.',
      ),
    );
  }
  const sorted = sortCompilerDiagnostics(diagnostics);
  return { diagnostics: sorted, value: hasCompilerErrors(sorted) ? null : resolved };
}
