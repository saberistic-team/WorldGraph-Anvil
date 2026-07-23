import { HARBOR_CITY_ECONOMY_PRIMITIVES, STARTER_PRIMITIVES } from '@worldgraph/catalog';
import {
  createCompilerInputBundle,
  createPreviousCompilerInputBundle,
  memberPrincipalKey,
} from '@worldgraph/compiler';
import {
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  PREVIOUS_COMPILER_VERSION,
  type ApplicationNotification,
  type CompilerDiagnosticV1,
  type CompilerInputBundleV1,
  type PreviousCompilerInputBundleV1,
} from '@worldgraph/contracts';
import {
  createDeterministicFallback,
  createDeterministicHarborCityFallback,
  harborCityManifestCatalog,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';
import { describe, expect, it, vi } from 'vitest';

import type { WorkerNotificationSink } from './application-notifications.js';
import type {
  ActivatableCompiledArtifact,
  ActivatableCompilerInputBundle,
  ClaimedWorldCompilation,
  CompilationSourcePrimitive,
  WorldActivationResult,
  WorldCompilationBacklog,
  WorldCompilationRepository,
  WorldCompilationSource,
} from './world-compilation-repository.js';
import {
  WorldCompilationCoordinator,
  WorldCompilationRunner,
  type WorldCompilationMetrics,
} from './world-compilation-worker.js';

const fixedNow = new Date('2026-07-22T12:00:00.000Z');
const worldId = '048f0000-0000-7000-8000-000000000001';
const creatorId = '048f0000-0000-7000-8000-000000000002';
const revisionId = '048f0000-0000-7000-8000-000000000003';
const runId = '048f0000-0000-7000-8000-000000000004';
const worldVersionId = '048f0000-0000-7000-8000-000000000005';
const generatedId = '048f0000-0000-7000-8000-000000000006';
const seed = 'worker-unit-seed';
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'world-compilation-unit-test',
});

const noOpMetrics: WorldCompilationMetrics = {
  recordArtifact: () => undefined,
  recordActivation: () => undefined,
  recordBacklog: () => undefined,
  recordIntegrityFinding: () => undefined,
  recordQueueLatency: () => undefined,
  recordRun: () => undefined,
  recordStage: () => undefined,
};

function recordingMetrics() {
  return {
    recordActivation: vi.fn(),
    recordArtifact: vi.fn(),
    recordBacklog: vi.fn(),
    recordIntegrityFinding: vi.fn(),
    recordQueueLatency: vi.fn(),
    recordRun: vi.fn(),
    recordStage: vi.fn(),
  };
}

function exactPrimitives(): CompilationSourcePrimitive[] {
  const fallback = harborFallback();
  const pinned = new Set(fallback.envelope.manifest.primitiveRefs.map((entry) => entry.key));
  return [...STARTER_PRIMITIVES, ...HARBOR_CITY_ECONOMY_PRIMITIVES]
    .filter((primitive) => pinned.has(primitive.input.key))
    .map((primitive) => ({
      contentHash: primitive.contentHash,
      definition: primitive.input,
      lifecycle: 'published',
      primitiveVersionId: primitive.versionId,
    }));
}

function harborFallback() {
  return createDeterministicHarborCityFallback({
    catalog: harborCityManifestCatalog(),
    prompt:
      'A harbor city with guild workshops, iron and energy production, paid jobs, a fixed-price market, and public sales tax.',
    seed,
  });
}

function previousFallback() {
  return createDeterministicFallback({
    catalog: harborCityManifestCatalog(),
    prompt: 'A deterministic harbor city with guild workshops and public institutions.',
    seed,
  });
}

function source(
  primitives: CompilationSourcePrimitive[] = exactPrimitives(),
): WorldCompilationSource {
  const fallback = harborFallback();
  return {
    manifest: fallback.envelope.manifest,
    manifestContentHash: fallback.contentHash,
    members: [{ role: 'creator', userId: creatorId }],
    primitives,
  };
}

function previousSource(): WorldCompilationSource {
  const fallback = previousFallback();
  const pinned = new Set(fallback.envelope.manifest.primitiveRefs.map((entry) => entry.key));
  return {
    manifest: fallback.envelope.manifest,
    manifestContentHash: fallback.contentHash,
    members: [{ role: 'creator', userId: creatorId }],
    primitives: [...STARTER_PRIMITIVES, ...HARBOR_CITY_ECONOMY_PRIMITIVES]
      .filter((primitive) => pinned.has(primitive.input.key))
      .map((primitive) => ({
        contentHash: primitive.contentHash,
        definition: primitive.input,
        lifecycle: 'published',
        primitiveVersionId: primitive.versionId,
      })),
  };
}

function previousSourceWithEconomyV1(): WorldCompilationSource {
  const value = previousSource();
  value.manifest.extensions['worldgraph.economy'] = { schemaVersion: 1 };
  return {
    ...value,
    manifestContentHash: previousBundleFor(value).manifestContentHash,
  };
}

function bundleFor(value: WorldCompilationSource): CompilerInputBundleV1 {
  return createCompilerInputBundle({
    activeMembers: [{ principalKey: memberPrincipalKey(worldId, creatorId), role: 'creator' }],
    compilerConfig: {
      adapterRegistryVersion: 1,
      deprecatedPrimitivePolicy: 'reject',
      maxEntities: 2_000,
      maxRelationships: 8_000,
    },
    manifest: value.manifest,
    primitives: value.primitives,
    seed,
  });
}

function previousBundleFor(value: WorldCompilationSource): PreviousCompilerInputBundleV1 {
  return createPreviousCompilerInputBundle({
    activeMembers: [{ principalKey: memberPrincipalKey(worldId, creatorId), role: 'creator' }],
    compilerConfig: {
      adapterRegistryVersion: 1,
      deprecatedPrimitivePolicy: 'reject',
      maxEntities: 2_000,
      maxRelationships: 8_000,
    },
    manifest: value.manifest,
    primitives: value.primitives,
    seed,
  });
}

function jobFor(value: WorldCompilationSource, inputHash = bundleFor(value).inputHash) {
  const bundle = bundleFor(value);
  const job: ClaimedWorldCompilation = {
    attempts: 1,
    claimToken: generatedId,
    compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    inputHash,
    manifestContentHash: bundle.manifestContentHash,
    manifestRevisionId: revisionId,
    progressPercent: 10,
    queuedAt: fixedNow,
    requestedByUserId: creatorId,
    rowVersion: 2,
    runId,
    seed,
    stage: 'validating',
    worldId,
  };
  return job;
}

function previousJobFor(value: WorldCompilationSource): ClaimedWorldCompilation {
  const bundle = previousBundleFor(value);
  return {
    ...jobFor(value),
    compilerVersion: PREVIOUS_COMPILER_VERSION,
    inputHash: bundle.inputHash,
    manifestContentHash: bundle.manifestContentHash,
  };
}

class FakeCompilationRepository implements WorldCompilationRepository {
  public activation?: {
    artifact: ActivatableCompiledArtifact;
    bundle: ActivatableCompilerInputBundle;
    diagnostics: readonly CompilerDiagnosticV1[];
    members: readonly { principalKey: string; userId: string }[];
  };
  public activationResult: WorldActivationResult | null = {
    entityCount: 1,
    lockWaitMs: 17,
    relationshipCount: 1,
    serializationRetries: 2,
    worldVersionId,
  };
  public claimCurrent = true;
  public failedDiagnostics: readonly CompilerDiagnosticV1[] = [];
  public recovered = 0;
  public readonly stages: ClaimedWorldCompilation['stage'][] = [];
  private claimed = false;

  public constructor(
    public readonly sourceValue: WorldCompilationSource,
    public readonly jobValue: ClaimedWorldCompilation = jobFor(sourceValue),
  ) {}

  public async activate(
    _job: ClaimedWorldCompilation,
    bundle: ActivatableCompilerInputBundle,
    artifact: ActivatableCompiledArtifact,
    diagnostics: readonly CompilerDiagnosticV1[],
  ): Promise<WorldActivationResult | null> {
    this.activation = {
      artifact,
      bundle,
      diagnostics,
      members: this.sourceValue.members.map((member) => ({
        principalKey: memberPrincipalKey(worldId, member.userId),
        userId: member.userId,
      })),
    };
    return this.claimCurrent ? this.activationResult : null;
  }

  public async claimNext(claimToken: string): Promise<ClaimedWorldCompilation | null> {
    if (this.claimed) return null;
    this.claimed = true;
    return { ...this.jobValue, claimToken };
  }

  public async heartbeat(): Promise<boolean> {
    return this.claimCurrent;
  }

  public async inspectBacklog(): Promise<WorldCompilationBacklog> {
    return { oldestAgeMs: 0, ready: 0, running: 0 };
  }

  public async isClaimCurrent(): Promise<boolean> {
    return this.claimCurrent;
  }

  public async loadSource(): Promise<WorldCompilationSource | null> {
    return this.claimCurrent ? this.sourceValue : null;
  }

  public async markFailed(
    _job: ClaimedWorldCompilation,
    diagnostics: readonly CompilerDiagnosticV1[],
  ): Promise<boolean> {
    this.failedDiagnostics = diagnostics;
    return this.claimCurrent;
  }

  public async recoverExpiredClaims(): Promise<number> {
    return this.recovered;
  }

  public async updateStage(
    job: ClaimedWorldCompilation,
    stage: ClaimedWorldCompilation['stage'],
    progressPercent: number,
  ): Promise<ClaimedWorldCompilation | null> {
    this.stages.push(stage);
    return this.claimCurrent
      ? { ...job, progressPercent, rowVersion: job.rowVersion + 1, stage }
      : null;
  }
}

function runner(
  repository: FakeCompilationRepository,
  notifications: ApplicationNotification[] = [],
  notificationSink: WorkerNotificationSink = {
    publish: async (notification) => void notifications.push(notification),
  },
  metrics: WorldCompilationMetrics = noOpMetrics,
): WorldCompilationRunner {
  return new WorldCompilationRunner(
    repository,
    logger,
    {
      maxEntities: 2_000,
      maxRelationships: 8_000,
    },
    {
      clock: { now: () => new Date(fixedNow) },
      ids: { next: () => generatedId },
      metrics,
      notifications: notificationSink,
    },
  );
}

describe('world compilation runner', () => {
  it('recomputes the exact input, compiles, verifies, and activates controller bindings', async () => {
    const repository = new FakeCompilationRepository(source());
    const notifications: ApplicationNotification[] = [];

    await expect(runner(repository, notifications).runOne()).resolves.toMatchObject({
      outcome: 'succeeded',
      worldVersionId,
    });

    expect(repository.stages).toEqual(['compiling', 'seeding']);
    expect(repository.activation?.artifact.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(repository.activation?.bundle.inputHash).toBe(repository.jobValue.inputHash);
    expect(repository.activation?.members).toEqual([
      { principalKey: memberPrincipalKey(worldId, creatorId), userId: creatorId },
    ]);
    expect(
      repository.activation?.artifact.world.relationships.some(
        (relationship) => relationship.relationshipType === 'account_controls',
      ),
    ).toBe(true);
    expect(notifications.map((notification) => notification.type)).toEqual([
      'WorldCompilationStarted',
      'WorldCompilationSucceeded',
      'WorldActivated',
    ]);
  });

  it('executes a sealed compiler 1.1 run and activates its artifact-2 output', async () => {
    const sourceValue = previousSourceWithEconomyV1();
    const repository = new FakeCompilationRepository(sourceValue, previousJobFor(sourceValue));

    const result = await runner(repository).runOne();
    expect(result, JSON.stringify(repository.failedDiagnostics)).toMatchObject({
      outcome: 'succeeded',
      worldVersionId,
    });

    expect(repository.stages).toEqual(['compiling', 'seeding']);
    expect(repository.activation?.bundle.compilerVersion).toBe(PREVIOUS_COMPILER_VERSION);
    expect(repository.activation?.artifact.artifactSchemaVersion).toBe(2);
    expect(repository.activation?.artifact.world.compilerVersion).toBe(PREVIOUS_COMPILER_VERSION);
  });

  it('fails closed for an unsupported compiler version before loading or compiling source', async () => {
    const sourceValue = source();
    const repository = new FakeCompilationRepository(sourceValue, {
      ...jobFor(sourceValue),
      compilerVersion: '9.9.9',
    });

    await expect(runner(repository).runOne()).resolves.toMatchObject({
      code: 'COMPILER_VERSION_MISMATCH',
      outcome: 'failed',
    });

    expect(repository.stages).toEqual([]);
    expect(repository.activation).toBeUndefined();
  });

  it.each([
    ['compiler 1.1 with an economy-v2 manifest', source(), PREVIOUS_COMPILER_VERSION],
    ['compiler 1.2 without an economy-v2 manifest', previousSource(), COMPILER_VERSION],
  ])('rejects the source lane mismatch: %s', async (_label, sourceValue, compilerVersion) => {
    const bundle =
      compilerVersion === PREVIOUS_COMPILER_VERSION
        ? previousBundleFor(sourceValue)
        : bundleFor(sourceValue);
    const repository = new FakeCompilationRepository(sourceValue, {
      ...jobFor(sourceValue),
      compilerVersion,
      inputHash: bundle.inputHash,
      manifestContentHash: bundle.manifestContentHash,
    });

    await expect(runner(repository).runOne()).resolves.toMatchObject({
      code: 'COMPILER_VERSION_MISMATCH',
      outcome: 'failed',
    });
    expect(repository.stages).toEqual([]);
    expect(repository.activation).toBeUndefined();
  });

  it('records low-cardinality queue, stage, activation, and artifact measurements', async () => {
    const repository = new FakeCompilationRepository(source());
    const metrics = recordingMetrics();

    await expect(runner(repository, [], undefined, metrics).runOne()).resolves.toMatchObject({
      outcome: 'succeeded',
    });

    expect(metrics.recordQueueLatency).toHaveBeenCalledWith(0);
    expect(metrics.recordStage).toHaveBeenNthCalledWith(
      1,
      'claim',
      expect.any(Number),
      'succeeded',
    );
    expect(metrics.recordStage).toHaveBeenNthCalledWith(
      2,
      'validate',
      expect.any(Number),
      'succeeded',
    );
    expect(metrics.recordStage).toHaveBeenNthCalledWith(
      3,
      'compile',
      expect.any(Number),
      'succeeded',
    );
    expect(metrics.recordStage).toHaveBeenNthCalledWith(
      4,
      'seed_activate',
      expect.any(Number),
      'succeeded',
    );
    expect(metrics.recordActivation).toHaveBeenCalledWith(17, 2);
    expect(metrics.recordArtifact).toHaveBeenCalledWith(1, 1);
    expect(metrics.recordIntegrityFinding).not.toHaveBeenCalled();
  });

  it('fails closed before compilation when the authoritative input hash changed', async () => {
    const sourceValue = source();
    const repository = new FakeCompilationRepository(
      sourceValue,
      jobFor(sourceValue, 'f'.repeat(64)),
    );
    const notifications: ApplicationNotification[] = [];

    await expect(runner(repository, notifications).runOne()).resolves.toMatchObject({
      code: 'COMPILATION_INPUT_HASH_MISMATCH',
      outcome: 'failed',
    });

    expect(repository.stages).toEqual([]);
    expect(repository.activation).toBeUndefined();
    expect(repository.failedDiagnostics.map((entry) => entry.code)).toEqual([
      'COMPILATION_INPUT_HASH_MISMATCH',
    ]);
    expect(notifications.map((notification) => notification.type)).toEqual([
      'WorldCompilationStarted',
      'WorldCompilationFailed',
    ]);
  });

  it('emits an integrity finding for an authoritative input hash mismatch', async () => {
    const sourceValue = source();
    const repository = new FakeCompilationRepository(
      sourceValue,
      jobFor(sourceValue, 'f'.repeat(64)),
    );
    const metrics = recordingMetrics();

    await expect(runner(repository, [], undefined, metrics).runOne()).resolves.toMatchObject({
      code: 'COMPILATION_INPUT_HASH_MISMATCH',
      outcome: 'failed',
    });

    expect(metrics.recordIntegrityFinding).toHaveBeenCalledExactlyOnceWith('hash_mismatch');
    expect(metrics.recordStage).toHaveBeenCalledWith('validate', expect.any(Number), 'failed');
  });

  it('persists deterministic compiler diagnostics and never begins seeding on compile failure', async () => {
    const primitives = exactPrimitives();
    primitives[0] = { ...primitives[0]!, lifecycle: 'deprecated' };
    const sourceValue = source(primitives);
    const repository = new FakeCompilationRepository(sourceValue);

    await expect(runner(repository).runOne()).resolves.toMatchObject({
      outcome: 'failed',
    });

    expect(repository.stages).toEqual(['compiling']);
    expect(repository.activation).toBeUndefined();
    expect(repository.failedDiagnostics.some((entry) => entry.severity === 'error')).toBe(true);
    expect(repository.failedDiagnostics.map((entry) => entry.code)).toContain(
      'DEPRECATED_PRIMITIVE_REJECTED',
    );
  });

  it('reports a lost claim without writing failure state when a stage CAS loses', async () => {
    const repository = new FakeCompilationRepository(source());
    repository.claimCurrent = false;

    await expect(runner(repository).runOne()).resolves.toMatchObject({ outcome: 'lost_claim' });
    expect(repository.activation).toBeUndefined();
    expect(repository.failedDiagnostics).toEqual([]);
  });

  it('contains best-effort notification failures after authoritative activation', async () => {
    const repository = new FakeCompilationRepository(source());
    const publish = vi.fn().mockRejectedValue(new Error('notification unavailable'));

    await expect(runner(repository, [], { publish }).runOne()).resolves.toMatchObject({
      outcome: 'succeeded',
    });
    expect(publish).toHaveBeenCalledTimes(3);
    expect(repository.activation).toBeDefined();
  });
});

describe('world compilation coordinator', () => {
  it('coalesces concurrent wakeups and applies monotonic reconciliation pacing', async () => {
    let now = 0;
    let release!: (value: []) => void;
    const first = new Promise<[]>((resolve) => {
      release = resolve;
    });
    const reconcile = vi.fn().mockReturnValueOnce(first).mockResolvedValue([]);
    const coordinator = new WorldCompilationCoordinator({ reconcile }, logger, {
      monotonicNow: () => now,
      reconciliationIntervalMs: 1_000,
    });

    const firstWake = coordinator.wake();
    const duplicateWake = coordinator.wake();
    expect(duplicateWake).toBe(firstWake);
    expect(reconcile).toHaveBeenCalledTimes(1);
    release([]);
    await firstWake;

    now = 999;
    await expect(coordinator.wake()).resolves.toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    now = 1_000;
    await expect(coordinator.wake()).resolves.toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });
});
