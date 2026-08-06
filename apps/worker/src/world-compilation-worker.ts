import {
  compileGovernanceArtifactForCompatibility,
  compilePreviousArtifactForCompatibility,
  compileRetainedArtifactForCompatibility,
  compileWorld,
  createCompilerInputBundle,
  createGovernanceCompilerInputBundle,
  createPreviousCompilerInputBundle,
  createRetainedCompilerInputBundle,
  memberPrincipalKey,
  verifyCompiledArtifact,
} from '@worldgraph/compiler';
import {
  ApplicationNotificationSchema,
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  GOVERNANCE_COMPILER_VERSION,
  PREVIOUS_COMPILER_VERSION,
  RETAINED_COMPILER_VERSION,
  SystemClock,
  UuidV7Generator,
  createValidator,
  type ApplicationNotification,
  type Clock,
  type CompilerDiagnosticV1,
  type CompilerInputBundleV1,
  type GovernanceCompilerInputBundleV1,
  type IdGenerator,
  type PreviousCompilerInputBundleV1,
  type RetainedCompilerInputBundleV1,
  type Validator,
} from '@worldgraph/contracts';
import { telemetry, withSpan } from '@worldgraph/observability';
import type { Logger } from 'pino';

import {
  discardWorkerNotifications,
  type WorkerNotificationSink,
} from './application-notifications.js';
import {
  CompilationInputChangedError,
  type ClaimedWorldCompilation,
  type WorldCompilationRepository,
  type WorldCompilationSource,
} from './world-compilation-repository.js';

const notificationValidator: Validator<ApplicationNotification> =
  createValidator<ApplicationNotification>(ApplicationNotificationSchema);

export type WorldCompilationOutcome = 'failed' | 'idle' | 'lost_claim' | 'succeeded';

export interface WorldCompilationRunResult {
  code?: string;
  job: ClaimedWorldCompilation | null;
  outcome: WorldCompilationOutcome;
  worldVersionId?: string;
}

type ExecutableCompilerInputBundle =
  | CompilerInputBundleV1
  | GovernanceCompilerInputBundleV1
  | PreviousCompilerInputBundleV1
  | RetainedCompilerInputBundleV1;

type RunnableCompilerVersion =
  | typeof COMPILER_VERSION
  | typeof GOVERNANCE_COMPILER_VERSION
  | typeof PREVIOUS_COMPILER_VERSION
  | typeof RETAINED_COMPILER_VERSION;

export interface WorldCompilationMetrics {
  recordArtifact(entities: number, relationships: number): void;
  recordActivation(lockWaitMs: number, serializationRetries: number): void;
  recordBacklog(ready: number, running: number, oldestAgeMs: number): void;
  recordIntegrityFinding(
    check: 'activation_inconsistency' | 'hash_mismatch' | 'orphan' | 'reproducibility_failure',
  ): void;
  recordQueueLatency(durationMs: number): void;
  recordRun(outcome: WorldCompilationOutcome, durationMs?: number, code?: string): void;
  recordStage(
    stage: 'claim' | 'compile' | 'seed_activate' | 'validate',
    durationMs: number,
    outcome: 'failed' | 'lost_claim' | 'succeeded',
  ): void;
}

const discardMetrics: WorldCompilationMetrics = {
  recordArtifact: () => undefined,
  recordActivation: () => undefined,
  recordBacklog: () => undefined,
  recordIntegrityFinding: () => undefined,
  recordQueueLatency: () => undefined,
  recordRun: () => undefined,
  recordStage: () => undefined,
};

export function createProductionWorldCompilationMetrics(): WorldCompilationMetrics {
  return {
    recordArtifact(entities, relationships) {
      telemetry.worldCompilationArtifacts.record(entities, { kind: 'entity' });
      telemetry.worldCompilationArtifacts.record(relationships, { kind: 'relationship' });
    },
    recordActivation(lockWaitMs, serializationRetries) {
      telemetry.worldCompilationLockWait.record(lockWaitMs, { operation: 'seed_activate' });
      if (serializationRetries > 0) {
        telemetry.worldCompilationSerializationRetries.add(serializationRetries, {
          operation: 'seed_activate',
        });
      }
    },
    recordBacklog(ready, running, oldestAgeMs) {
      telemetry.worldCompilationBacklog.record(ready, { state: 'queued' });
      telemetry.worldCompilationBacklog.record(running, { state: 'running' });
      telemetry.worldCompilationBacklogAge.record(oldestAgeMs, { state: 'queued' });
    },
    recordIntegrityFinding(check) {
      telemetry.worldCompilationIntegrityFindings.add(1, { check });
    },
    recordQueueLatency(durationMs) {
      telemetry.worldCompilationQueueLatency.record(durationMs, { outcome: 'claimed' });
    },
    recordRun(outcome, durationMs, code) {
      telemetry.worldCompilationRuns.add(1, { ...(code ? { code } : {}), outcome });
      if (durationMs !== undefined) {
        telemetry.worldCompilationDuration.record(durationMs, { outcome });
      }
    },
    recordStage(stage, durationMs, outcome) {
      telemetry.worldCompilationStageDuration.record(durationMs, { outcome, stage });
    },
  };
}

export interface WorldCompilationRunnerOptions {
  claimTimeoutMs?: number;
  clock?: Clock;
  enabled?: boolean;
  ids?: IdGenerator;
  maximumRunsPerReconciliation?: number;
  metrics?: WorldCompilationMetrics;
  monotonicNow?: () => number;
  notifications?: WorkerNotificationSink;
}

function diagnostic(
  code: string,
  message: string,
  retryable: boolean,
  stage: CompilerDiagnosticV1['stage'] = 'validate',
): CompilerDiagnosticV1 {
  return {
    code,
    message,
    pointer: '',
    relatedKeys: [],
    retryable,
    severity: 'error',
    stage,
  };
}

function firstErrorCode(diagnostics: readonly CompilerDiagnosticV1[]): string {
  return diagnostics.find((entry) => entry.severity === 'error')?.code ?? 'COMPILATION_FAILED';
}

function isPostgresIntegrityFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^23/u.test((error as { code: string }).code)
  );
}

function hasHashMismatch(diagnostics: readonly CompilerDiagnosticV1[]): boolean {
  return diagnostics.some(
    (entry) =>
      entry.code.includes('HASH_MISMATCH') || entry.code === 'ARTIFACT_CANONICAL_BYTES_MISMATCH',
  );
}

function requiredCompilerVersion(
  manifest: WorldCompilationSource['manifest'],
): RunnableCompilerVersion {
  const governance = manifest.extensions['worldgraph.governance'];
  if (
    governance !== null &&
    typeof governance === 'object' &&
    !Array.isArray(governance) &&
    governance.schemaVersion === 1
  ) {
    return COMPILER_VERSION;
  }
  const economy = manifest.extensions['worldgraph.economy'];
  return economy !== null &&
    typeof economy === 'object' &&
    !Array.isArray(economy) &&
    economy.schemaVersion === 2
    ? PREVIOUS_COMPILER_VERSION
    : RETAINED_COMPILER_VERSION;
}

function compilerLaneMatches(
  manifest: WorldCompilationSource['manifest'],
  jobCompilerVersion: string,
): boolean {
  const required = requiredCompilerVersion(manifest);
  if (jobCompilerVersion === required) return true;
  const governance = manifest.extensions['worldgraph.governance'];
  // Exact retained governance lane (1.3.0/artifact 4) remains executable for
  // governance manifests while native compile advances to 1.4.0/artifact 5.
  return (
    required === COMPILER_VERSION &&
    jobCompilerVersion === GOVERNANCE_COMPILER_VERSION &&
    governance !== null &&
    typeof governance === 'object' &&
    !Array.isArray(governance) &&
    governance.schemaVersion === 1
  );
}

export class WorldCompilationRunner {
  private readonly claimTimeoutMs: number;
  private readonly clock: Clock;
  private readonly enabled: boolean;
  private readonly ids: IdGenerator;
  private readonly maximumRunsPerReconciliation: number;
  private readonly metrics: WorldCompilationMetrics;
  private readonly monotonicNow: () => number;
  private readonly notifications: WorkerNotificationSink;

  public constructor(
    private readonly repository: WorldCompilationRepository,
    private readonly logger: Logger,
    private readonly limits: { maxEntities: number; maxRelationships: number },
    options: WorldCompilationRunnerOptions = {},
  ) {
    this.claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
    this.clock = options.clock ?? new SystemClock();
    this.enabled = options.enabled ?? true;
    this.ids = options.ids ?? new UuidV7Generator();
    this.maximumRunsPerReconciliation = options.maximumRunsPerReconciliation ?? 5;
    this.metrics = options.metrics ?? discardMetrics;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.notifications = options.notifications ?? discardWorkerNotifications;
  }

  public async runOne(): Promise<WorldCompilationRunResult> {
    if (!this.enabled) return { job: null, outcome: 'idle' };
    return withSpan('world.compilation.execute', async (span) => {
      const started = this.monotonicNow();
      const claimStarted = this.monotonicNow();
      let job: ClaimedWorldCompilation | null;
      try {
        job = await withSpan('world.compilation.claim', async (claimSpan) => {
          const claimed = await this.repository.claimNext(this.ids.next());
          if (claimed) {
            claimSpan.setAttributes({
              'world.compilation.run_id': claimed.runId,
              'world.id': claimed.worldId,
            });
          }
          return claimed;
        });
      } catch (error) {
        const durationMs = Math.max(0, this.monotonicNow() - claimStarted);
        this.metrics.recordStage('claim', durationMs, 'failed');
        this.logger.error(
          { code: 'WORLD_COMPILATION_CLAIM_FAILED', durationMs, stage: 'claim' },
          'world_compilation.stage_failed',
        );
        throw error;
      }
      if (!job) return { job: null, outcome: 'idle' };
      const claimDurationMs = Math.max(0, this.monotonicNow() - claimStarted);
      this.metrics.recordStage('claim', claimDurationMs, 'succeeded');
      this.metrics.recordQueueLatency(
        Math.max(0, this.clock.now().getTime() - job.queuedAt.getTime()),
      );
      this.logger.info(
        {
          compilerConfigVersion: job.compilerConfigVersion,
          compilerVersion: job.compilerVersion,
          durationMs: claimDurationMs,
          inputHash: job.inputHash,
          outcome: 'succeeded',
          runId: job.runId,
          stage: 'claim',
          worldId: job.worldId,
        },
        'world_compilation.stage_completed',
      );
      span.setAttributes({
        'world.compilation.compiler_config_version': job.compilerConfigVersion,
        'world.compilation.compiler_version': job.compilerVersion,
        'world.compilation.input_hash': job.inputHash,
        'world.compilation.run_id': job.runId,
        'world.id': job.worldId,
      });
      await this.publishBestEffort('WorldCompilationStarted', {
        inputHash: job.inputHash,
        runId: job.runId,
        worldId: job.worldId,
      });
      let result: WorldCompilationRunResult;
      try {
        result = await this.execute(job);
      } catch (error) {
        if (error instanceof CompilationInputChangedError) {
          this.metrics.recordIntegrityFinding('hash_mismatch');
          result = await this.fail(job, [
            diagnostic(
              'COMPILATION_INPUT_CHANGED',
              'The exact authoritative compiler input changed before activation.',
              false,
            ),
          ]);
        } else {
          if (isPostgresIntegrityFailure(error)) {
            this.metrics.recordIntegrityFinding('activation_inconsistency');
          }
          this.logger.error(
            { code: 'WORLD_COMPILATION_EXECUTION_FAILED', runId: job.runId, worldId: job.worldId },
            'world_compilation.execution_failed',
          );
          if (!(await this.repository.isClaimCurrent(job).catch(() => false))) {
            result = { job, outcome: 'lost_claim' };
          } else {
            const failure = diagnostic(
              'WORKER_EXECUTION_FAILED',
              'The compilation worker could not complete atomic activation.',
              true,
              'emit',
            );
            result = await this.fail(job, [failure]);
          }
        }
      }
      const durationMs = Math.max(0, this.monotonicNow() - started);
      this.metrics.recordRun(result.outcome, durationMs, result.code);
      span.setAttribute('world.compilation.outcome', result.outcome);
      return result;
    });
  }

  public async reconcile(): Promise<WorldCompilationRunResult[]> {
    if (!this.enabled) {
      const backlog = await this.repository.inspectBacklog();
      this.metrics.recordBacklog(backlog.ready, backlog.running, backlog.oldestAgeMs);
      return [];
    }
    const recovered = await this.repository.recoverExpiredClaims(this.claimTimeoutMs);
    if (recovered > 0) {
      this.logger.warn({ recovered }, 'world_compilation.expired_claims_recovered');
    }
    const results: WorldCompilationRunResult[] = [];
    for (let index = 0; index < this.maximumRunsPerReconciliation; index += 1) {
      const result = await this.runOne();
      if (result.outcome === 'idle') break;
      results.push(result);
    }
    const backlog = await this.repository.inspectBacklog();
    this.metrics.recordBacklog(backlog.ready, backlog.running, backlog.oldestAgeMs);
    return results;
  }

  private async execute(job: ClaimedWorldCompilation): Promise<WorldCompilationRunResult> {
    const validation = await this.observeStage(
      job,
      'validate',
      async () => {
        if (
          (job.compilerVersion !== RETAINED_COMPILER_VERSION &&
            job.compilerVersion !== PREVIOUS_COMPILER_VERSION &&
            job.compilerVersion !== GOVERNANCE_COMPILER_VERSION &&
            job.compilerVersion !== COMPILER_VERSION) ||
          job.compilerConfigVersion !== COMPILER_CONFIG_SCHEMA_VERSION
        ) {
          return { kind: 'version_mismatch' } as const;
        }
        const source = await this.repository.loadSource(job);
        if (!source) {
          return (await this.repository.isClaimCurrent(job))
            ? ({ kind: 'source_stale' } as const)
            : ({ kind: 'lost_claim' } as const);
        }
        if (!compilerLaneMatches(source.manifest, job.compilerVersion)) {
          return { kind: 'version_mismatch' } as const;
        }
        const bundle = this.bundle(job, source);
        if (
          bundle.manifestContentHash !== job.manifestContentHash ||
          bundle.inputHash !== job.inputHash
        ) {
          return { kind: 'hash_mismatch' } as const;
        }
        const compiling = await this.repository.updateStage(job, 'compiling', 45);
        return compiling
          ? ({ bundle, compiling, kind: 'ready' } as const)
          : ({ kind: 'lost_claim' } as const);
      },
      (result) =>
        result.kind === 'ready'
          ? 'succeeded'
          : result.kind === 'lost_claim'
            ? 'lost_claim'
            : 'failed',
    );
    if (validation.kind === 'version_mismatch') {
      return this.fail(job, [
        diagnostic(
          'COMPILER_VERSION_MISMATCH',
          'The queued run does not match the active compiler configuration.',
          false,
        ),
      ]);
    }
    if (validation.kind === 'source_stale') {
      return this.fail(job, [
        diagnostic(
          'COMPILATION_SOURCE_STALE',
          'The approved manifest or authoritative world input is no longer current.',
          false,
        ),
      ]);
    }
    if (validation.kind === 'hash_mismatch') {
      return this.fail(job, [
        diagnostic(
          'COMPILATION_INPUT_HASH_MISMATCH',
          'The exact manifest, primitive, or membership input differs from the queued identity.',
          false,
        ),
      ]);
    }
    if (validation.kind === 'lost_claim') return { job, outcome: 'lost_claim' };

    const { bundle, compiling } = validation;
    const compilation = await this.observeStage(
      compiling,
      'compile',
      () => {
        const compiled =
          bundle.compilerVersion === RETAINED_COMPILER_VERSION
            ? compileRetainedArtifactForCompatibility(bundle)
            : bundle.compilerVersion === PREVIOUS_COMPILER_VERSION
              ? compilePreviousArtifactForCompatibility(bundle)
              : bundle.compilerVersion === GOVERNANCE_COMPILER_VERSION
                ? compileGovernanceArtifactForCompatibility(bundle)
                : compileWorld(bundle);
        if (!compiled.artifact) {
          return { diagnostics: compiled.diagnostics, kind: 'compile_failed' } as const;
        }
        const verification = verifyCompiledArtifact(compiled.artifact);
        if (!verification.valid) {
          return { diagnostics: verification.diagnostics, kind: 'verification_failed' } as const;
        }
        return {
          artifact: compiled.artifact,
          diagnostics: compiled.diagnostics,
          kind: 'ready',
        } as const;
      },
      (result) => (result.kind === 'ready' ? 'succeeded' : 'failed'),
    );
    if (compilation.kind === 'compile_failed') {
      return this.fail(compiling, compilation.diagnostics);
    }
    if (compilation.kind === 'verification_failed') {
      this.metrics.recordIntegrityFinding('reproducibility_failure');
      return this.fail(compiling, compilation.diagnostics);
    }

    const { artifact, diagnostics } = compilation;
    const persistence = await this.observeStage(
      compiling,
      'seed_activate',
      async () => {
        const seeding = await this.repository.updateStage(compiling, 'seeding', 80);
        if (!seeding) return { kind: 'lost_claim' } as const;
        const activation = await this.repository.activate(
          seeding,
          bundle,
          artifact,
          diagnostics,
          () => this.ids.next(),
        );
        return activation
          ? ({ activation, kind: 'activated' } as const)
          : ({ kind: 'lost_claim' } as const);
      },
      (result) => (result.kind === 'activated' ? 'succeeded' : 'lost_claim'),
    );
    if (persistence.kind === 'lost_claim') return { job, outcome: 'lost_claim' };
    const { activation } = persistence;
    this.metrics.recordActivation(activation.lockWaitMs ?? 0, activation.serializationRetries ?? 0);
    this.metrics.recordArtifact(activation.entityCount, activation.relationshipCount);
    await this.publishBestEffort('WorldCompilationSucceeded', {
      artifactHash: artifact.contentHash,
      inputHash: bundle.inputHash,
      runId: job.runId,
      worldId: job.worldId,
      worldVersionId: activation.worldVersionId,
    });
    await this.publishBestEffort('WorldActivated', {
      artifactHash: artifact.contentHash,
      runId: job.runId,
      worldId: job.worldId,
      worldVersionId: activation.worldVersionId,
    });
    this.logger.info(
      {
        artifactHash: artifact.contentHash,
        entities: activation.entityCount,
        inputHash: bundle.inputHash,
        relationships: activation.relationshipCount,
        runId: job.runId,
        worldId: job.worldId,
        worldVersionId: activation.worldVersionId,
      },
      'world_compilation.activated',
    );
    return { job, outcome: 'succeeded', worldVersionId: activation.worldVersionId };
  }

  private async observeStage<T>(
    job: ClaimedWorldCompilation,
    stage: 'compile' | 'seed_activate' | 'validate',
    operation: () => Promise<T> | T,
    outcomeFor: (result: T) => 'failed' | 'lost_claim' | 'succeeded',
  ): Promise<T> {
    return withSpan(`world.compilation.${stage}`, async (span) => {
      const started = this.monotonicNow();
      let outcome: 'failed' | 'lost_claim' | 'succeeded' = 'failed';
      span.setAttributes({
        'world.compilation.compiler_config_version': job.compilerConfigVersion,
        'world.compilation.compiler_version': job.compilerVersion,
        'world.compilation.input_hash': job.inputHash,
        'world.compilation.run_id': job.runId,
        'world.compilation.stage': stage,
        'world.id': job.worldId,
      });
      try {
        const result = await operation();
        outcome = outcomeFor(result);
        return result;
      } finally {
        const durationMs = Math.max(0, this.monotonicNow() - started);
        this.metrics.recordStage(stage, durationMs, outcome);
        span.setAttributes({
          'world.compilation.stage_duration_ms': durationMs,
          'world.compilation.stage_outcome': outcome,
        });
        const context = {
          compilerConfigVersion: job.compilerConfigVersion,
          compilerVersion: job.compilerVersion,
          durationMs,
          inputHash: job.inputHash,
          outcome,
          runId: job.runId,
          stage,
          worldId: job.worldId,
        };
        if (outcome === 'failed') {
          this.logger.warn(context, 'world_compilation.stage_failed');
        } else {
          this.logger.info(context, 'world_compilation.stage_completed');
        }
      }
    });
  }

  private bundle(
    job: ClaimedWorldCompilation,
    source: WorldCompilationSource,
  ): ExecutableCompilerInputBundle {
    const options = {
      activeMembers: source.members.map((member) => ({
        principalKey: memberPrincipalKey(job.worldId, member.userId),
        role: member.role,
      })),
      compilerConfig: {
        adapterRegistryVersion: 1 as const,
        deprecatedPrimitivePolicy: 'reject' as const,
        maxEntities: this.limits.maxEntities,
        maxRelationships: this.limits.maxRelationships,
      },
      manifest: source.manifest,
      primitives: source.primitives,
      seed: job.seed,
    };
    if (job.compilerVersion === RETAINED_COMPILER_VERSION) {
      return createRetainedCompilerInputBundle(options);
    }
    if (job.compilerVersion === PREVIOUS_COMPILER_VERSION) {
      return createPreviousCompilerInputBundle(options);
    }
    if (job.compilerVersion === GOVERNANCE_COMPILER_VERSION) {
      return createGovernanceCompilerInputBundle(options);
    }
    if (job.compilerVersion === COMPILER_VERSION) {
      return createCompilerInputBundle(options);
    }
    throw new Error('UNSUPPORTED_WORLD_COMPILATION_VERSION');
  }

  private async fail(
    job: ClaimedWorldCompilation,
    diagnostics: readonly CompilerDiagnosticV1[],
  ): Promise<WorldCompilationRunResult> {
    const bounded = diagnostics.slice(0, 128);
    if (hasHashMismatch(bounded)) this.metrics.recordIntegrityFinding('hash_mismatch');
    const changed = await this.repository.markFailed(
      job,
      bounded.length > 0
        ? bounded
        : [diagnostic('COMPILATION_FAILED', 'Compilation failed safely.', false)],
    );
    if (!changed) return { job, outcome: 'lost_claim' };
    const code = firstErrorCode(bounded);
    await this.publishBestEffort('WorldCompilationFailed', {
      errorCode: code,
      inputHash: job.inputHash,
      runId: job.runId,
      worldId: job.worldId,
    });
    this.logger.warn(
      { code, inputHash: job.inputHash, runId: job.runId, worldId: job.worldId },
      'world_compilation.failed',
    );
    return { code, job, outcome: 'failed' };
  }

  private async publishBestEffort<T extends ApplicationNotification['type']>(
    type: T,
    payload: Extract<ApplicationNotification, { type: T }>['payload'],
  ): Promise<void> {
    const notification = {
      id: this.ids.next(),
      occurredAt: this.clock.now().toISOString(),
      payload,
      schemaVersion: 1,
      type,
    } as Extract<ApplicationNotification, { type: T }>;
    try {
      notificationValidator.assert(notification);
      await this.notifications.publish(notification);
    } catch {
      this.logger.warn(
        { code: 'NOTIFICATION_PUBLISH_FAILED', notificationType: type },
        'world_compilation.notification_failed',
      );
    }
  }
}

export interface WorldCompilationCoordinatorOptions {
  monotonicNow?: () => number;
  reconciliationIntervalMs?: number;
}

export interface WorldCompilationReconciler {
  reconcile(): Promise<WorldCompilationRunResult[]>;
}

export class WorldCompilationCoordinator {
  private active: Promise<WorldCompilationRunResult[]> | undefined;
  private lastReconciliationStartedAt = Number.NEGATIVE_INFINITY;
  private readonly monotonicNow: () => number;
  private readonly reconciliationIntervalMs: number;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly runner: WorldCompilationReconciler,
    private readonly logger: Logger,
    options: WorldCompilationCoordinatorOptions = {},
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.reconciliationIntervalMs = options.reconciliationIntervalMs ?? 2_000;
  }

  public start(): void {
    if (this.stopped || this.timer) return;
    void this.wake().catch(() => {
      this.logger.error(
        { code: 'RECONCILIATION_FAILED' },
        'world_compilation.reconciliation_failed',
      );
    });
    this.timer = setInterval(() => {
      void this.wake().catch(() => {
        this.logger.error(
          { code: 'RECONCILIATION_FAILED' },
          'world_compilation.reconciliation_failed',
        );
      });
    }, this.reconciliationIntervalMs);
    this.timer.unref();
  }

  public wake(): Promise<WorldCompilationRunResult[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.active) return this.active;
    const now = this.monotonicNow();
    if (now - this.lastReconciliationStartedAt < this.reconciliationIntervalMs) {
      return Promise.resolve([]);
    }
    this.lastReconciliationStartedAt = now;
    const active = this.runner.reconcile();
    this.active = active;
    const clear = (): void => {
      if (this.active === active) this.active = undefined;
    };
    void active.then(clear, clear);
    return active;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
