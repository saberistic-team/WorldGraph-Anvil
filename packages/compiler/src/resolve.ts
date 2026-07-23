import {
  primitiveContentHash,
  primitiveSemanticDocument,
  satisfiesVersionRange,
  validatePrimitive,
} from '@worldgraph/catalog';
import {
  CompilerInputBundleV1Schema,
  canonicalJson,
  createValidator,
  type CompilerDiagnosticV1,
  type CompilerInputBundleV1,
  type ExactPrimitiveInputV1,
} from '@worldgraph/contracts';

import { compilerAdapterFor } from './adapters.js';
import { compilerDiagnostic, hasCompilerErrors, sortCompilerDiagnostics } from './diagnostics.js';
import { compilerInputHash, sha256Utf8 } from './hash.js';
import type { ResolvedCompilerInput, StageResult } from './types.js';

const inputValidator = createValidator<CompilerInputBundleV1>(CompilerInputBundleV1Schema);

function resolvePrimitiveGraph(
  bundle: CompilerInputBundleV1,
  diagnostics: CompilerDiagnosticV1[],
): ExactPrimitiveInputV1[] {
  const byKey = new Map<string, ExactPrimitiveInputV1>();
  const indexByKey = new Map<string, number>();
  const versionIds = new Set<string>();
  bundle.primitives.forEach((primitive, index) => {
    const key = primitive.definition.key;
    const prior = byKey.get(key);
    if (prior) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'DUPLICATE_PRIMITIVE_KEY',
          `/primitives/${index}/definition/key`,
          'An exact primitive closure may contain only one version for each stable key.',
          { relatedKeys: [key] },
        ),
      );
    } else {
      byKey.set(key, primitive);
      indexByKey.set(key, index);
    }
    if (versionIds.has(primitive.primitiveVersionId)) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'DUPLICATE_PRIMITIVE_VERSION_ID',
          `/primitives/${index}/primitiveVersionId`,
          'Primitive version identifiers must be unique within the closure.',
          { relatedKeys: [primitive.primitiveVersionId] },
        ),
      );
    }
    versionIds.add(primitive.primitiveVersionId);
  });

  const roots = new Set<string>();
  bundle.manifest.primitiveRefs.forEach((reference, index) => {
    roots.add(reference.key);
    const primitive = byKey.get(reference.key);
    if (!primitive) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'PINNED_PRIMITIVE_MISSING',
          `/manifest/primitiveRefs/${index}`,
          'The exact primitive pinned by the approved manifest is missing.',
          { relatedKeys: [reference.key] },
        ),
      );
      return;
    }
    const definition = primitive.definition;
    if (
      primitive.primitiveVersionId !== reference.primitiveVersionId ||
      primitive.contentHash !== reference.contentHash ||
      definition.version !== reference.version ||
      definition.kind !== reference.kind
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'PINNED_PRIMITIVE_CHANGED',
          `/manifest/primitiveRefs/${index}`,
          'The exact primitive identity no longer matches the approved manifest pin.',
          { relatedKeys: [reference.key] },
        ),
      );
    }
  });

  for (const [key, primitive] of byKey) {
    const index = indexByKey.get(key)!;
    for (const [dependencyIndex, dependency] of primitive.definition.dependencies.entries()) {
      const target = byKey.get(dependency.key);
      if (!target) {
        if (dependency.required ?? true) {
          diagnostics.push(
            compilerDiagnostic(
              'resolve',
              'PRIMITIVE_DEPENDENCY_MISSING',
              `/primitives/${index}/definition/dependencies/${dependencyIndex}`,
              'A required exact primitive dependency is missing from the closure.',
              { relatedKeys: [key, dependency.key] },
            ),
          );
        }
      } else if (!satisfiesVersionRange(target.definition.version, dependency.versionRange)) {
        diagnostics.push(
          compilerDiagnostic(
            'resolve',
            'PRIMITIVE_DEPENDENCY_INCOMPATIBLE',
            `/primitives/${index}/definition/dependencies/${dependencyIndex}/versionRange`,
            'The exact dependency version does not satisfy the reviewed version range.',
            { relatedKeys: [key, dependency.key] },
          ),
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reachable = new Set<string>();
  const ordered: ExactPrimitiveInputV1[] = [];
  const visit = (key: string, path: readonly string[]): void => {
    if (visiting.has(key)) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'PRIMITIVE_DEPENDENCY_CYCLE',
          `/primitives/${indexByKey.get(key) ?? 0}/definition/dependencies`,
          'Primitive dependencies must form an acyclic graph.',
          { relatedKeys: [...path, key] },
        ),
      );
      return;
    }
    if (visited.has(key)) {
      reachable.add(key);
      return;
    }
    const primitive = byKey.get(key);
    if (!primitive) return;
    visiting.add(key);
    reachable.add(key);
    const dependencies = [...primitive.definition.dependencies]
      .filter((dependency) => byKey.has(dependency.key))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    for (const dependency of dependencies) visit(dependency.key, [...path, key]);
    visiting.delete(key);
    visited.add(key);
    ordered.push(primitive);
  };
  for (const key of [...roots].sort()) visit(key, []);
  for (const key of [...byKey.keys()].sort()) {
    if (!reachable.has(key)) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'PRIMITIVE_CLOSURE_EXTRANEOUS',
          `/primitives/${indexByKey.get(key) ?? 0}`,
          'The supplied primitive is not reachable from any approved manifest pin.',
          { relatedKeys: [key] },
        ),
      );
    }
  }
  return ordered;
}

export function resolveCompilerInput(input: unknown): StageResult<ResolvedCompilerInput> {
  if (!inputValidator.is(input)) {
    const diagnostics = inputValidator
      .issues(input)
      .slice(0, 128)
      .map((issue) =>
        compilerDiagnostic(
          'resolve',
          'COMPILER_INPUT_SCHEMA_INVALID',
          issue.path,
          `Compiler input is invalid: ${issue.message}`,
        ),
      );
    return { diagnostics: sortCompilerDiagnostics(diagnostics), value: null };
  }
  const bundle = input;
  const diagnostics: CompilerDiagnosticV1[] = [];
  const canonicalManifest = canonicalJson(bundle.manifest);
  const semanticInputBytes =
    Buffer.byteLength(bundle.manifestCanonicalBytes, 'utf8') +
    bundle.primitives.reduce(
      (total, primitive) => total + Buffer.byteLength(primitive.canonicalBytes, 'utf8'),
      0,
    );
  if (semanticInputBytes > 8 * 1024 * 1024) {
    diagnostics.push(
      compilerDiagnostic(
        'resolve',
        'COMPILER_INPUT_TOO_LARGE',
        '/',
        'Canonical manifest and primitive input cannot exceed 8 MiB.',
      ),
    );
  }
  if (bundle.manifestCanonicalBytes !== canonicalManifest) {
    diagnostics.push(
      compilerDiagnostic(
        'resolve',
        'MANIFEST_CANONICAL_BYTES_MISMATCH',
        '/manifestCanonicalBytes',
        'Manifest bytes are not the exact canonical encoding of the approved manifest.',
      ),
    );
  }
  if (sha256Utf8(canonicalManifest) !== bundle.manifestContentHash) {
    diagnostics.push(
      compilerDiagnostic(
        'resolve',
        'MANIFEST_HASH_MISMATCH',
        '/manifestContentHash',
        'Manifest content hash does not match canonical manifest bytes.',
      ),
    );
  }
  if (compilerInputHash(bundle) !== bundle.inputHash) {
    diagnostics.push(
      compilerDiagnostic(
        'resolve',
        'COMPILER_INPUT_HASH_MISMATCH',
        '/inputHash',
        'Compiler input identity does not match its semantic bundle.',
      ),
    );
  }
  bundle.primitives.forEach((primitive, index) => {
    if (!compilerAdapterFor(primitive.definition)) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'UNSUPPORTED_PRIMITIVE_BEHAVIOR',
          `/primitives/${index}/definition/behaviorRef`,
          'No code-reviewed compiler adapter supports this primitive kind and behavior reference.',
          { relatedKeys: [primitive.definition.key] },
        ),
      );
    }
    const validation = validatePrimitive(primitive.definition);
    if (!validation.valid) {
      for (const issue of validation.issues.slice(0, 8)) {
        diagnostics.push(
          compilerDiagnostic(
            'resolve',
            'PRIMITIVE_DEFINITION_INVALID',
            `/primitives/${index}/definition${issue.pointer}`,
            `Exact primitive is invalid: ${issue.message}`,
            { relatedKeys: [primitive.definition.key] },
          ),
        );
      }
    }
    const expectedBytes = canonicalJson(primitiveSemanticDocument(primitive.definition));
    if (primitive.canonicalBytes !== expectedBytes) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'PRIMITIVE_CANONICAL_BYTES_MISMATCH',
          `/primitives/${index}/canonicalBytes`,
          'Primitive bytes are not the exact canonical semantic definition.',
          { relatedKeys: [primitive.definition.key] },
        ),
      );
    }
    if (
      primitive.contentHash !== sha256Utf8(expectedBytes) ||
      primitive.contentHash !== primitiveContentHash(primitive.definition)
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'PRIMITIVE_HASH_MISMATCH',
          `/primitives/${index}/contentHash`,
          'Primitive content hash does not match its exact canonical definition.',
          { relatedKeys: [primitive.definition.key] },
        ),
      );
    }
    if (primitive.lifecycle === 'deprecated') {
      diagnostics.push(
        compilerDiagnostic(
          'resolve',
          'DEPRECATED_PRIMITIVE_REJECTED',
          `/primitives/${index}/lifecycle`,
          'Compiler configuration rejects deprecated primitive versions.',
          { relatedKeys: [primitive.definition.key] },
        ),
      );
    }
  });
  const orderedPrimitives = resolvePrimitiveGraph(bundle, diagnostics);
  const sorted = sortCompilerDiagnostics(diagnostics);
  return {
    diagnostics: sorted,
    value: hasCompilerErrors(sorted) ? null : { bundle, orderedPrimitives },
  };
}
