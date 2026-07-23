import type { CompilerDiagnosticV1, CompilerStage } from '@worldgraph/contracts';

const stageOrder: Readonly<Record<CompilerStage, number>> = {
  resolve: 0,
  validate: 1,
  normalize: 2,
  lower: 3,
  link: 4,
  emit: 5,
};

export function compilerDiagnostic(
  stage: CompilerStage,
  code: string,
  pointer: string,
  message: string,
  options: {
    relatedKeys?: readonly string[];
    retryable?: boolean;
    severity?: CompilerDiagnosticV1['severity'];
  } = {},
): CompilerDiagnosticV1 {
  return {
    code,
    message,
    pointer,
    relatedKeys: [...(options.relatedKeys ?? [])].sort(),
    retryable: options.retryable ?? false,
    severity: options.severity ?? 'error',
    stage,
  };
}

export function sortCompilerDiagnostics(
  diagnostics: readonly CompilerDiagnosticV1[],
): CompilerDiagnosticV1[] {
  const unique = new Map<string, CompilerDiagnosticV1>();
  for (const diagnostic of diagnostics) {
    const identity = [
      diagnostic.stage,
      diagnostic.code,
      diagnostic.pointer,
      diagnostic.message,
      diagnostic.relatedKeys.join('\0'),
    ].join('\0');
    unique.set(identity, diagnostic);
  }
  return [...unique.values()]
    .sort((left, right) => {
      const leftKey = `${String(stageOrder[left.stage]).padStart(2, '0')}\0${left.code}\0${left.pointer}\0${left.message}`;
      const rightKey = `${String(stageOrder[right.stage]).padStart(2, '0')}\0${right.code}\0${right.pointer}\0${right.message}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .slice(0, 128);
}

export function hasCompilerErrors(diagnostics: readonly CompilerDiagnosticV1[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
