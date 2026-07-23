import type { CompilerDiagnosticV1 } from '@worldgraph/contracts';

import { sortCompilerDiagnostics } from './diagnostics.js';
import { emitCompiledArtifact } from './emit.js';
import { linkLoweredWorld } from './link.js';
import { lowerNormalizedInput } from './lower.js';
import { normalizeCompilerInput } from './normalize.js';
import { resolveCompilerInput } from './resolve.js';
import type { CompileWorldResult } from './types.js';
import { validateResolvedInput } from './validate.js';

function claimedInputHash(input: unknown): string {
  if (
    input !== null &&
    typeof input === 'object' &&
    'inputHash' in input &&
    typeof input.inputHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(input.inputHash)
  ) {
    return input.inputHash;
  }
  return '0'.repeat(64);
}

export function compileWorld(input: unknown): CompileWorldResult {
  const diagnostics: CompilerDiagnosticV1[] = [];
  const inputHash = claimedInputHash(input);
  const resolved = resolveCompilerInput(input);
  diagnostics.push(...resolved.diagnostics);
  if (!resolved.value) {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash,
      successfulStage: 'none',
    };
  }
  const validated = validateResolvedInput(resolved.value);
  diagnostics.push(...validated.diagnostics);
  if (!validated.value) {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash,
      successfulStage: 'resolve',
    };
  }
  const normalized = normalizeCompilerInput(validated.value);
  diagnostics.push(...normalized.diagnostics);
  if (!normalized.value) {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash,
      successfulStage: 'validate',
    };
  }
  const lowered = lowerNormalizedInput(normalized.value);
  diagnostics.push(...lowered.diagnostics);
  if (!lowered.value) {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash,
      successfulStage: 'normalize',
    };
  }
  const linked = linkLoweredWorld(lowered.value);
  diagnostics.push(...linked.diagnostics);
  if (!linked.value) {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash,
      successfulStage: 'lower',
    };
  }
  const emitted = emitCompiledArtifact(linked.value);
  diagnostics.push(...emitted.diagnostics);
  if (!emitted.value) {
    return {
      artifact: null,
      diagnostics: sortCompilerDiagnostics(diagnostics),
      inputHash,
      successfulStage: 'link',
    };
  }
  return {
    artifact: emitted.value,
    diagnostics: sortCompilerDiagnostics(diagnostics),
    inputHash,
    successfulStage: 'emit',
  };
}
