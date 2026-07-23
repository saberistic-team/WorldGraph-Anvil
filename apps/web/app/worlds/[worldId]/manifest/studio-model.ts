import type {
  GetManifestRevisionResponse,
  ManifestDiagnostic,
  ManifestGenerationRunView,
  PrimitiveListItem,
  World,
  WorldManifestV1,
} from '@worldgraph/contracts';

export const STUDIO_STAGES = ['describe', 'draft', 'validate', 'review', 'approve'] as const;
export type StudioStage = (typeof STUDIO_STAGES)[number];

export function manifestEditAllowed(world: World | null): boolean {
  return world?.role === 'creator' || world?.role === 'administrator';
}

export function generationRunForRevision(
  run: ManifestGenerationRunView | null,
  detail: GetManifestRevisionResponse | null,
): ManifestGenerationRunView | null {
  return run && detail?.revision.generationRunId === run.id ? run : null;
}

type CanonicalValue = boolean | null | number | string | CanonicalValue[] | CanonicalObject;
interface CanonicalObject {
  [key: string]: CanonicalValue;
}

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError('Value is not canonical JSON.');
  if (ancestors.has(value)) throw new TypeError('Canonical JSON cannot contain cycles.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, ancestors));
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON requires plain objects.');
    }
    const entries = Object.keys(value as Record<string, unknown>).map(
      (key) => [key, key.normalize('NFC')] as const,
    );
    if (new Set(entries.map(([, normalized]) => normalized)).size !== entries.length) {
      throw new TypeError('Canonical JSON keys collide after normalization.');
    }
    return Object.fromEntries(
      entries
        .sort((left, right) => (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0))
        .map(([source, normalized]) => [
          normalized,
          canonicalize((value as Record<string, unknown>)[source], ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalManifestJson(value: unknown): string {
  const serialize = (item: CanonicalValue): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(serialize).join(',')}]`;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(item[key]!)}`)
      .join(',')}}`;
  };
  return serialize(canonicalize(value, new Set()));
}

export function stageLabel(stage: StudioStage): string {
  return stage[0]!.toUpperCase() + stage.slice(1);
}

export function stageAvailable(
  stage: StudioStage,
  detail: GetManifestRevisionResponse | null,
): boolean {
  return stage === 'describe' || detail !== null;
}

export function pollDelay(
  pollCount: number,
  visibility: DocumentVisibilityState = 'visible',
): number {
  if (visibility === 'hidden') return 10_000;
  return Math.min(5_000, 750 * 1.55 ** Math.max(0, pollCount));
}

export function generationStatus(run: ManifestGenerationRunView): string {
  if (run.status === 'succeeded') {
    return run.outcome?.mode === 'fallback'
      ? 'Draft ready using the deterministic fallback.'
      : 'Generated draft ready for review.';
  }
  if (run.status === 'failed')
    return `Generation failed (${run.errorCode ?? 'GENERATION_FAILED'}).`;
  if (run.status === 'cancelled') return 'Generation cancelled. No draft was published.';
  return `${stageLabel(run.stage === 'complete' ? 'review' : normalizeRunStage(run.stage))}: ${run.progressPercent}%`;
}

function normalizeRunStage(stage: ManifestGenerationRunView['stage']): StudioStage {
  if (stage === 'validation') return 'validate';
  if (stage === 'complete' || stage === 'persisting') return 'review';
  if (stage === 'generation' || stage === 'intent' || stage === 'retrieval') return 'draft';
  return 'describe';
}

export function warningCodes(diagnostics: readonly ManifestDiagnostic[]): string[] {
  return [
    ...new Set(
      diagnostics
        .filter((diagnostic) => diagnostic.severity === 'warning')
        .map((diagnostic) => diagnostic.code),
    ),
  ].sort();
}

export function approvalReady(input: {
  acknowledgedCodes: ReadonlySet<string>;
  confirmationName: string;
  detail: GetManifestRevisionResponse | null;
  world: World | null;
}): boolean {
  if (
    !input.detail?.report?.valid ||
    input.detail.revision.approvalStatus !== 'draft' ||
    input.world?.role !== 'creator' ||
    input.confirmationName.normalize('NFC') !== input.world.name
  ) {
    return false;
  }
  const required = warningCodes(input.detail.report.diagnostics);
  return (
    required.length === input.acknowledgedCodes.size &&
    required.every((code) => input.acknowledgedCodes.has(code))
  );
}

export function diagnosticFieldId(pointer: string): string {
  if (pointer === '/metadata/name') return 'manifest-name';
  if (pointer === '/metadata/description') return 'manifest-description';
  if (pointer === '/visual/direction') return 'manifest-visual-direction';
  return 'manifest-yaml-editor';
}

export function sourceOffset(
  source: string,
  location: { column: number; line: number } | null,
): number {
  if (!location) return 0;
  const lines = source.split('\n');
  const lineIndex = Math.max(0, Math.min(lines.length - 1, location.line - 1));
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) offset += lines[index]!.length + 1;
  return Math.min(source.length, offset + Math.max(0, location.column - 1));
}

export function nextStage(
  current: StudioStage,
  direction: 'end' | 'home' | 'next' | 'previous',
  detail: GetManifestRevisionResponse | null,
): StudioStage {
  const available = STUDIO_STAGES.filter((stage) => stageAvailable(stage, detail));
  if (direction === 'home') return available[0]!;
  if (direction === 'end') return available.at(-1)!;
  const index = Math.max(0, available.indexOf(current));
  const delta = direction === 'next' ? 1 : -1;
  return available[(index + delta + available.length) % available.length]!;
}

export function replacePrimitivePin(
  manifest: WorldManifestV1,
  targetRef: string,
  candidate: PrimitiveListItem,
): WorldManifestV1 {
  const current = manifest.primitiveRefs.find((primitive) => primitive.ref === targetRef);
  if (!current) throw new Error('The selected manifest pin no longer exists.');
  if (candidate.lifecycle !== 'published' || candidate.kind !== current.kind) {
    throw new Error('Replacement pins must be a published primitive of the same kind.');
  }
  return {
    ...manifest,
    primitiveRefs: manifest.primitiveRefs.map((primitive) =>
      primitive.ref === targetRef
        ? {
            ...primitive,
            contentHash: candidate.contentHash,
            key: candidate.key,
            kind: candidate.kind,
            parameters: { ...primitive.parameters },
            primitiveVersionId: candidate.id,
            version: candidate.version,
          }
        : primitive,
    ),
  };
}
