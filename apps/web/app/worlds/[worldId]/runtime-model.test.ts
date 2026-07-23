import { describe, expect, it } from 'vitest';

import type { World } from '@worldgraph/contracts';

import {
  compilationCanCancel,
  compilationCanRetry,
  compilationPollDelay,
  compilationProgress,
  compileIneligibleReason,
  entityQuery,
  humanizeGraphType,
  relationshipQuery,
  shortRuntimeHash,
} from './runtime-model';

const world = {
  currentApprovedManifestRevisionId: 'revision-current',
  lifecycle: 'manifest_approved',
  role: 'creator',
} as unknown as World;

describe('world compilation and graph UI model', () => {
  it('allows only the creator and exact current approved revision to compile', () => {
    const revision = { approvalStatus: 'approved', id: 'revision-current' };
    expect(compileIneligibleReason({ revision, world })).toBeNull();
    expect(
      compileIneligibleReason({
        revision,
        world: { ...world, role: 'administrator' },
      }),
    ).toMatch(/Only the active world creator/u);
    expect(
      compileIneligibleReason({
        revision: { ...revision, id: 'revision-stale' },
        world,
      }),
    ).toMatch(/current approved/u);
    expect(
      compileIneligibleReason({
        revision,
        world: { ...world, lifecycle: 'active' },
      }),
    ).toMatch(/already active/u);
    expect(
      compileIneligibleReason({
        revision,
        world: { ...world, lifecycle: 'compiling' },
      }),
    ).toMatch(/already in progress/u);
  });

  it('permits cancellation strictly before seeding and retry only for retryable failures', () => {
    expect(compilationCanCancel({ stage: 'queued', status: 'queued' })).toBe(true);
    expect(compilationCanCancel({ stage: 'compiling', status: 'running' })).toBe(true);
    expect(compilationCanCancel({ stage: 'seeding', status: 'running' })).toBe(false);
    expect(compilationCanCancel({ stage: 'activated', status: 'succeeded' })).toBe(false);
    expect(
      compilationCanRetry({
        diagnostics: [{ retryable: true }],
        stage: 'failed',
        status: 'failed',
      }),
    ).toBe(true);
    expect(
      compilationCanRetry({
        diagnostics: [{ retryable: true }, { retryable: false }],
        stage: 'failed',
        status: 'failed',
      }),
    ).toBe(false);
  });

  it('exposes stable stage progress and capped polling', () => {
    expect(compilationProgress('queued')).toBe(0);
    expect(compilationProgress('compiling')).toBe(50);
    expect(compilationProgress('activated')).toBe(100);
    expect(compilationPollDelay(99)).toBe(5_000);
    expect(compilationPollDelay(0, 'hidden')).toBe(10_000);
  });

  it('builds trimmed, encoded, cursor-bound graph queries with a bounded page size', () => {
    expect(
      entityQuery({
        cursor: 'signed.cursor',
        entityType: ' district ',
        limit: 1_000,
        search: ' guild ',
      }),
    ).toBe('limit=100&query=guild&entityType=district&cursor=signed.cursor');
    expect(
      relationshipQuery({
        relationshipType: 'located_in',
        sourceLogicalKey: 'district:sky-forge',
      }),
    ).toBe('limit=25&relationshipType=located_in&sourceLogicalKey=district%3Asky-forge');
  });

  it('formats hashes and graph type labels without changing the source values', () => {
    expect(shortRuntimeHash('a'.repeat(64))).toBe(`${'a'.repeat(12)}…${'a'.repeat(10)}`);
    expect(humanizeGraphType('account_controls')).toBe('Account Controls');
  });
});
