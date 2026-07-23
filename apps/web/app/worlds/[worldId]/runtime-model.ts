import type { World, WorldCompilationStage } from '@worldgraph/contracts';

export const COMPILATION_STAGES = [
  'queued',
  'validating',
  'compiling',
  'seeding',
  'activated',
] as const;

export type CompilationStage = WorldCompilationStage;

export interface CompilationRunLike {
  diagnostics?: readonly { retryable: boolean; severity?: string }[];
  stage: CompilationStage;
  status: 'cancelled' | 'failed' | 'queued' | 'running' | 'succeeded';
}

export interface CompileEligibilityInput {
  revision: {
    approvalStatus: string;
    id: string;
  } | null;
  world: World | null;
}

export function compilationStageIndex(stage: CompilationStage): number {
  if (stage === 'cancelled' || stage === 'failed') return -1;
  return COMPILATION_STAGES.indexOf(stage);
}

export function compilationProgress(stage: CompilationStage): number {
  const index = compilationStageIndex(stage);
  return index < 0 ? 0 : Math.round((index / (COMPILATION_STAGES.length - 1)) * 100);
}

export function compilationTerminal(run: CompilationRunLike): boolean {
  return ['cancelled', 'failed', 'succeeded'].includes(run.status);
}

export function compilationCanCancel(run: CompilationRunLike): boolean {
  return !compilationTerminal(run) && ['queued', 'validating', 'compiling'].includes(run.stage);
}

export function compilationCanRetry(run: CompilationRunLike): boolean {
  if (run.status !== 'failed' || !run.diagnostics) return false;
  const errors = run.diagnostics.filter(
    (item) => item.severity === undefined || item.severity === 'error',
  );
  return errors.every((item) => item.retryable);
}

export function compilationPollDelay(
  pollCount: number,
  visibility: DocumentVisibilityState = 'visible',
): number {
  if (visibility === 'hidden') return 10_000;
  return Math.min(5_000, Math.round(800 * 1.5 ** Math.max(0, pollCount)));
}

export function compileIneligibleReason(input: CompileEligibilityInput): string | null {
  if (!input.revision) return 'Select an approved manifest revision first.';
  if (input.world?.role !== 'creator') {
    return 'Only the active world creator can compile this approved manifest.';
  }
  if (input.revision.approvalStatus !== 'approved') {
    return 'Compilation requires an approved immutable manifest revision.';
  }
  if (input.world.currentApprovedManifestRevisionId !== input.revision.id) {
    return 'Only the world’s current approved manifest revision can be compiled.';
  }
  if (input.world.lifecycle === 'compiling') {
    return 'A durable compilation is already in progress for this world.';
  }
  if (String(input.world.lifecycle) === 'active') {
    return 'This world is already active. Initial compilation cannot replace an active world.';
  }
  if (input.world.lifecycle === 'compile_failed') {
    return 'Open the failed durable run to review diagnostics and use its safe retry action.';
  }
  if (input.world.lifecycle !== 'manifest_approved') {
    return 'The world lifecycle has not advanced to an approved manifest.';
  }
  return null;
}

export function shortRuntimeHash(hash: string | null, head = 12, tail = 10): string {
  if (!hash) return 'Pending';
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function humanizeGraphType(value: string): string {
  return value.replaceAll(/[_:.-]+/gu, ' ').replaceAll(/\b\w/gu, (letter) => letter.toUpperCase());
}

interface EntityQueryInput {
  cursor?: string | null;
  entityType?: string;
  limit?: number;
  search?: string;
}

interface RelationshipQueryInput {
  cursor?: string | null;
  limit?: number;
  relationshipType?: string;
  sourceLogicalKey?: string;
  targetLogicalKey?: string;
}

function boundedLimit(limit = 25): string {
  return String(Math.max(1, Math.min(100, Math.trunc(limit))));
}

export function entityQuery(input: EntityQueryInput): string {
  const query = new URLSearchParams({ limit: boundedLimit(input.limit) });
  const search = input.search?.trim();
  const entityType = input.entityType?.trim();
  if (search) query.set('query', search);
  if (entityType) query.set('entityType', entityType);
  if (input.cursor) query.set('cursor', input.cursor);
  return query.toString();
}

export function relationshipQuery(input: RelationshipQueryInput): string {
  const query = new URLSearchParams({ limit: boundedLimit(input.limit) });
  const relationshipType = input.relationshipType?.trim();
  if (relationshipType) query.set('relationshipType', relationshipType);
  const sourceLogicalKey = input.sourceLogicalKey?.trim();
  const targetLogicalKey = input.targetLogicalKey?.trim();
  if (sourceLogicalKey) query.set('sourceLogicalKey', sourceLogicalKey);
  if (targetLogicalKey) query.set('targetLogicalKey', targetLogicalKey);
  if (input.cursor) query.set('cursor', input.cursor);
  return query.toString();
}
