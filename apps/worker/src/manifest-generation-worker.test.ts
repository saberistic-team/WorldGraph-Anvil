import {
  MAX_MANIFEST_GENERATION_WARNINGS,
  type ApplicationNotification,
} from '@worldgraph/contracts';
import {
  createManifestGenerationEngine,
  manifestCatalogSnapshotHash,
  manifestGenerationInputHash,
  manifestGenerationRequestHash,
  starterManifestCatalog,
  type ManifestGenerationEngine,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';
import { describe, expect, it, vi } from 'vitest';

import type { WorkerNotificationSink } from './application-notifications.js';
import { createDisabledManifestGenerationProvider } from './manifest-generation-provider.js';
import {
  type ClaimedManifestGenerationRun,
  type FrozenManifestCatalog,
  type ManifestGenerationBacklog,
  type ManifestGenerationFailureCode,
  type ManifestGenerationPublication,
  type ManifestGenerationPublicationResult,
  type ManifestGenerationRepository,
  type ManifestGenerationStage,
} from './manifest-generation-repository.js';
import {
  ManifestGenerationCoordinator,
  ManifestGenerationRunner,
  type ManifestGenerationMetrics,
} from './manifest-generation-worker.js';

const prompt =
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.';
const providerConfigurationId = 'disabled-v1';
const seed = 'test-seed';
const fixedNow = new Date('2026-07-21T12:00:00.000Z');
const catalog = starterManifestCatalog();
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'manifest-generation-test',
});

const ids = [
  '018f0000-0000-7000-8000-000000000001',
  '018f0000-0000-7000-8000-000000000002',
  '018f0000-0000-7000-8000-000000000003',
  '018f0000-0000-7000-8000-000000000004',
  '018f0000-0000-7000-8000-000000000005',
] as const;

const noOpMetrics: ManifestGenerationMetrics = {
  recordBacklog: () => undefined,
  recordDiagnostics: () => undefined,
  recordPromptCleanup: () => undefined,
  recordRetrieval: () => undefined,
  recordRun: () => undefined,
};

function baseJob(claimToken: string = ids[0]): ClaimedManifestGenerationRun {
  return {
    attempts: 1,
    claimToken,
    expectedParentContentHash: null,
    generatorSchemaVersion: 1,
    inputHash: manifestGenerationRequestHash({
      expectedParentContentHash: null,
      parentRevisionId: null,
      prompt,
      providerConfigurationId,
      seed,
    }),
    parentRevisionId: null,
    progressPercent: 5,
    promptSubmissionId: '018f0000-0000-7000-8000-000000000010',
    promptTemplateVersion: 1,
    providerConfigurationId,
    queuedAt: fixedNow,
    repairAttempts: 0,
    requestedByUserId: '018f0000-0000-7000-8000-000000000011',
    resolvedInputHash: null,
    runId: '018f0000-0000-7000-8000-000000000012',
    seed,
    worldId: '018f0000-0000-7000-8000-000000000013',
  };
}

class FakeRepository implements ManifestGenerationRepository {
  public claimCurrent = true;
  public cleaned = 0;
  public failure?: { code: ManifestGenerationFailureCode; retryable: boolean };
  public failureResult: 'failed' | 'lost_claim' | 'retry_scheduled' = 'failed';
  public inheritedWarnings: { code: string; message: string; pointer: string }[] = [];
  public publication?: ManifestGenerationPublication;
  public recovered = { failed: 0, retried: 0 };
  public readonly stages: ManifestGenerationStage[] = [];
  private claimed = false;

  public async claimNext(
    configurationId: string,
    claimToken: string,
  ): Promise<ClaimedManifestGenerationRun | null> {
    if (this.claimed || configurationId !== providerConfigurationId) return null;
    this.claimed = true;
    return baseJob(claimToken);
  }

  public async cleanupExpiredPrompts(): Promise<number> {
    return this.cleaned;
  }

  public async freezeCatalog(
    job: ClaimedManifestGenerationRun,
    inputPrompt: string,
  ): Promise<FrozenManifestCatalog | null> {
    if (!this.claimCurrent) return null;
    return {
      catalog,
      catalogSnapshotHash: manifestCatalogSnapshotHash(catalog),
      resolvedInputHash: manifestGenerationInputHash({
        catalog,
        expectedParentContentHash: job.expectedParentContentHash,
        parentRevisionId: job.parentRevisionId,
        prompt: inputPrompt,
        providerConfigurationId: job.providerConfigurationId,
        seed: job.seed,
      }),
      retrievalCount: catalog.primitives.length,
    };
  }

  public async heartbeat(): Promise<boolean> {
    return this.claimCurrent;
  }

  public async generationWarnings(): Promise<{ code: string; message: string; pointer: string }[]> {
    return this.inheritedWarnings;
  }

  public async inspectBacklog(): Promise<ManifestGenerationBacklog> {
    return { oldestAgeMs: 0, ready: 0, running: 0 };
  }

  public async isClaimCurrent(): Promise<boolean> {
    return this.claimCurrent;
  }

  public async loadInput(): Promise<{ prompt: string } | null> {
    return this.claimCurrent ? { prompt } : null;
  }

  public async loadProviderUsage() {
    return this.claimCurrent
      ? {
          costMicrounits: 0,
          inputTokens: 0,
          outputTokens: 0,
          providerCalls: 0,
          repairAttempts: 0,
        }
      : null;
  }

  public async markFailure(
    _job: ClaimedManifestGenerationRun,
    code: ManifestGenerationFailureCode,
    retryable: boolean,
  ): Promise<'failed' | 'lost_claim' | 'retry_scheduled'> {
    this.failure = { code, retryable };
    return this.failureResult;
  }

  public async publish(
    _job: ClaimedManifestGenerationRun,
    publication: ManifestGenerationPublication,
  ): Promise<ManifestGenerationPublicationResult | null> {
    if (!this.claimCurrent) return null;
    this.publication = publication;
    return {
      contentHash: publication.outcome.contentHash,
      revisionId: publication.ids.revisionId,
      revisionNumber: 1,
    };
  }

  public async releaseProviderCall(): Promise<boolean> {
    return this.claimCurrent;
  }

  public async reserveProviderCall() {
    return null;
  }

  public async recoverExpiredClaims(): Promise<{ failed: number; retried: number }> {
    return this.recovered;
  }

  public async settleProviderCall(): Promise<boolean> {
    return this.claimCurrent;
  }

  public async updateStage(
    _job: ClaimedManifestGenerationRun,
    stage: ManifestGenerationStage,
    _progressPercent: number,
  ): Promise<boolean> {
    this.stages.push(stage);
    return this.claimCurrent;
  }
}

function runner(
  repository: FakeRepository,
  engine: ManifestGenerationEngine = createManifestGenerationEngine(
    createDisabledManifestGenerationProvider(),
    { now: () => fixedNow.getTime() },
  ),
  notifications: ApplicationNotification[] = [],
  notificationSink: WorkerNotificationSink = {
    publish: async (notification) => void notifications.push(notification),
  },
): ManifestGenerationRunner {
  let index = 0;
  return new ManifestGenerationRunner(repository, engine, providerConfigurationId, logger, {
    claimHeartbeatIntervalMs: 10_000,
    claimTimeoutMs: 30_000,
    clock: { now: () => new Date(fixedNow) },
    ids: { next: () => ids[index++]! },
    maximumRunsPerReconciliation: 2,
    metrics: noOpMetrics,
    notifications: notificationSink,
  });
}

describe('manifest generation runner', () => {
  it('publishes one validated deterministic fallback revision and a sanitized notification', async () => {
    const repository = new FakeRepository();
    const notifications: ApplicationNotification[] = [];

    const result = await runner(repository, undefined, notifications).runOne();

    expect(result).toMatchObject({ outcome: 'succeeded', revisionId: ids[2] });
    expect(repository.stages).toEqual(['retrieval', 'fallback', 'persisting']);
    expect(repository.publication?.outcome.mode).toBe('fallback');
    expect(repository.publication?.validation.valid).toBe(true);
    expect(repository.publication?.outcome.inputHash).toBe(baseJob().inputHash);
    expect(notifications).toEqual([
      {
        id: ids[3],
        occurredAt: fixedNow.toISOString(),
        payload: {
          contentHash: repository.publication?.outcome.contentHash,
          revisionId: ids[2],
          runId: baseJob().runId,
          worldId: baseJob().worldId,
        },
        schemaVersion: 1,
        type: 'ManifestGenerationSucceeded',
      },
    ]);
    expect(JSON.stringify(notifications)).not.toContain(prompt);
  });

  it('retains immutable ancestor warning requirements in child generation output and validation', async () => {
    const repository = new FakeRepository();
    repository.inheritedWarnings = [
      {
        code: 'ANCESTOR_HIGH_IMPACT_REVIEW',
        message: 'Review the inherited high-impact mechanics.',
        pointer: '/simulation',
      },
    ];
    repository.claimNext = async (_configurationId, claimToken) => ({
      ...baseJob(claimToken),
      expectedParentContentHash: 'a'.repeat(64),
      parentRevisionId: '018f0000-0000-7000-8000-000000000099',
      inputHash: manifestGenerationRequestHash({
        expectedParentContentHash: 'a'.repeat(64),
        parentRevisionId: '018f0000-0000-7000-8000-000000000099',
        prompt,
        providerConfigurationId,
        seed,
      }),
    });

    await expect(runner(repository).runOne()).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(repository.publication?.outcome.envelope.warnings).toEqual(
      expect.arrayContaining(repository.inheritedWarnings),
    );
    expect(repository.publication?.validation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ANCESTOR_HIGH_IMPACT_REVIEW', severity: 'warning' }),
      ]),
    );
  });

  it('publishes at the shared warning ceiling and fails closed above it', async () => {
    const inherited = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        code: `ANCESTOR_WARNING_${index}`,
        message: `Review inherited warning ${index}.`,
        pointer: '/simulation',
      }));
    const atLimit = new FakeRepository();
    atLimit.inheritedWarnings = inherited(MAX_MANIFEST_GENERATION_WARNINGS - 2);

    await expect(runner(atLimit).runOne()).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(atLimit.publication?.outcome.envelope.warnings).toHaveLength(
      MAX_MANIFEST_GENERATION_WARNINGS,
    );

    const overLimit = new FakeRepository();
    overLimit.inheritedWarnings = inherited(MAX_MANIFEST_GENERATION_WARNINGS - 1);
    await expect(runner(overLimit).runOne()).resolves.toMatchObject({ outcome: 'failed' });
    expect(overLimit.failure).toEqual({ code: 'GENERATION_OUTPUT_INVALID', retryable: false });
    expect(overLimit.publication).toBeUndefined();
  });

  it('does not publish when cancellation invalidates the claim before persistence', async () => {
    const repository = new FakeRepository();
    const originalUpdate = repository.updateStage.bind(repository);
    repository.updateStage = async (job, stage, progress) => {
      if (stage === 'persisting') {
        repository.claimCurrent = false;
        return false;
      }
      return originalUpdate(job, stage, progress);
    };

    await expect(runner(repository).runOne()).resolves.toMatchObject({ outcome: 'lost_claim' });
    expect(repository.publication).toBeUndefined();
  });

  it('fails terminally before generation when immutable base input provenance mismatches', async () => {
    const repository = new FakeRepository();
    repository.claimNext = async (_configurationId, claimToken) => ({
      ...baseJob(claimToken),
      inputHash: 'f'.repeat(64),
    });

    await expect(runner(repository).runOne()).resolves.toMatchObject({ outcome: 'failed' });
    expect(repository.failure).toEqual({ code: 'GENERATION_INPUT_MISMATCH', retryable: false });
    expect(repository.publication).toBeUndefined();
  });

  it('schedules a guarded retry for an unexpected engine failure without leaking its message', async () => {
    const repository = new FakeRepository();
    repository.failureResult = 'retry_scheduled';
    const engine: ManifestGenerationEngine = {
      generate: async () => {
        throw new Error('private provider payload secret=do-not-log');
      },
    };

    await expect(runner(repository, engine).runOne()).resolves.toMatchObject({
      outcome: 'retry_scheduled',
    });
    expect(repository.failure).toEqual({ code: 'WORKER_EXECUTION_FAILED', retryable: true });
  });

  it('runs prompt cleanup and lease recovery even while generation is feature-disabled', async () => {
    const repository = new FakeRepository();
    repository.cleaned = 3;
    repository.recovered = { failed: 1, retried: 2 };
    const cleanupMetric = vi.fn();
    const metrics: ManifestGenerationMetrics = {
      ...noOpMetrics,
      recordPromptCleanup: cleanupMetric,
    };
    const worker = new ManifestGenerationRunner(
      repository,
      createManifestGenerationEngine(createDisabledManifestGenerationProvider()),
      providerConfigurationId,
      logger,
      { enabled: false, metrics },
    );

    await expect(worker.reconcile()).resolves.toEqual([]);
    expect(cleanupMetric).toHaveBeenCalledWith(3, 'completed');
  });
});

describe('manifest generation coordinator', () => {
  it('coalesces overlapping BullMQ and timer wakes into one reconciliation', async () => {
    let release!: (value: []) => void;
    const active = new Promise<[]>((resolve) => {
      release = resolve;
    });
    const reconcile = vi.fn(() => active);
    const coordinator = new ManifestGenerationCoordinator({ reconcile }, logger, {
      monotonicNow: () => 10_000,
      reconciliationIntervalMs: 1,
    });

    const first = coordinator.wake();
    const second = coordinator.wake();
    expect(second).toBe(first);
    expect(reconcile).toHaveBeenCalledOnce();
    release([]);
    await first;
    await coordinator.stop();
  });
});
