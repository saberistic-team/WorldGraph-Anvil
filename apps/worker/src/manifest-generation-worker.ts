import { metrics } from '@opentelemetry/api';
import {
  ApplicationNotificationSchema,
  MANIFEST_GENERATOR_SCHEMA_VERSION,
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  SystemClock,
  UuidV7Generator,
  createValidator,
  type ApplicationNotification,
  type Clock,
  type IdGenerator,
  type Validator,
} from '@worldgraph/contracts';
import {
  DeterministicFallbackUnavailableError,
  ManifestGenerationCancelledError,
  manifestGenerationRequestHash,
  mergeManifestGenerationWarnings,
  validateManifestGenerationEnvelope,
  type ManifestGenerationEngine,
  type ManifestGenerationOutcome,
  type ManifestGenerationStageCallback,
} from '@worldgraph/manifests';
import { telemetry, withSpan } from '@worldgraph/observability';
import type { Logger } from 'pino';

import {
  discardWorkerNotifications,
  type WorkerNotificationSink,
} from './application-notifications.js';
import {
  type ClaimedManifestGenerationRun,
  type FrozenManifestCatalog,
  type ManifestGenerationFailureCode,
  type ManifestGenerationRepository,
} from './manifest-generation-repository.js';

const notificationValidator: Validator<ApplicationNotification> =
  createValidator<ApplicationNotification>(ApplicationNotificationSchema);

export type ManifestGenerationWorkerOutcome =
  'failed' | 'idle' | 'lost_claim' | 'retry_scheduled' | 'succeeded';

export interface ManifestGenerationRunResult {
  job: ClaimedManifestGenerationRun | null;
  outcome: ManifestGenerationWorkerOutcome;
  revisionId?: string;
}

export interface ManifestGenerationMetrics {
  recordBacklog(ready: number, running: number, oldestAgeMs: number): void;
  recordDiagnostics(diagnostics: readonly { code: string; severity: string }[]): void;
  recordPromptCleanup(count: number, outcome: 'completed' | 'failed'): void;
  recordRetrieval(count: number): void;
  recordRun(
    outcome: ManifestGenerationWorkerOutcome,
    options?: {
      code?: ManifestGenerationFailureCode;
      costMicrounits?: number;
      durationMs?: number;
      mode?: 'fallback' | 'provider';
      queueWaitMs?: number;
    },
  ): void;
}

const discardManifestGenerationMetrics: ManifestGenerationMetrics = {
  recordBacklog: () => undefined,
  recordDiagnostics: () => undefined,
  recordPromptCleanup: () => undefined,
  recordRetrieval: () => undefined,
  recordRun: () => undefined,
};

export function createProductionManifestGenerationMetrics(): ManifestGenerationMetrics {
  const meter = metrics.getMeter('worldgraph-worker');
  const backlog = meter.createHistogram('worldgraph_manifest_generation_backlog');
  const backlogAge = meter.createHistogram('worldgraph_manifest_generation_backlog_age_ms');
  return {
    recordBacklog(ready, running, oldestAgeMs) {
      backlog.record(ready, { state: 'queued' });
      backlog.record(running, { state: 'running' });
      backlogAge.record(oldestAgeMs);
    },
    recordDiagnostics(diagnostics) {
      for (const diagnostic of diagnostics) {
        telemetry.manifestValidationDiagnostics.add(1, {
          code: diagnostic.code,
          severity: diagnostic.severity,
          source: 'generation',
        });
      }
    },
    recordPromptCleanup(count, outcome) {
      telemetry.manifestPromptCleanup.add(outcome === 'failed' ? 1 : count, { outcome });
    },
    recordRetrieval(count) {
      telemetry.manifestGenerationRetrievalCount.record(count);
    },
    recordRun(outcome, options = {}) {
      telemetry.manifestGenerationRuns.add(1, {
        ...(options.code ? { code: options.code } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        outcome,
      });
      if (options.queueWaitMs !== undefined) {
        telemetry.manifestGenerationQueueWait.record(options.queueWaitMs);
      }
      if (options.durationMs !== undefined) {
        telemetry.manifestGenerationDuration.record(options.durationMs, {
          ...(options.mode ? { mode: options.mode } : {}),
          outcome,
        });
      }
      if (options.costMicrounits !== undefined) {
        telemetry.manifestGenerationCost.record(options.costMicrounits, {
          ...(options.mode ? { mode: options.mode } : {}),
          outcome,
        });
      }
    },
  };
}

export interface ManifestGenerationRunnerOptions {
  claimHeartbeatIntervalMs?: number;
  claimTimeoutMs?: number;
  clock?: Clock;
  dailyBudgetMicrounits?: number;
  enabled?: boolean;
  ids?: IdGenerator;
  maximumConcurrentPerWorld?: number;
  maximumRunsPerReconciliation?: number;
  metrics?: ManifestGenerationMetrics;
  notifications?: WorkerNotificationSink;
  promptCleanupBatchSize?: number;
}

class ClaimLostError extends Error {
  public constructor() {
    super('MANIFEST_GENERATION_CLAIM_LOST');
    this.name = 'ClaimLostError';
  }
}

const stageProgress: Readonly<Record<Parameters<ManifestGenerationStageCallback>[0], number>> = {
  fallback: 60,
  generation: 40,
  repair: 65,
  validation: 75,
};

function failureCode(error: unknown): ManifestGenerationFailureCode {
  if (error instanceof DeterministicFallbackUnavailableError) {
    return 'NO_COMPATIBLE_PRIMITIVES';
  }
  if (error instanceof Error) {
    if (error.message === 'CATALOG_SCOPE_EXCEEDED') return 'CATALOG_SCOPE_EXCEEDED';
    if (error.message === 'NO_COMPATIBLE_PRIMITIVES') return 'NO_COMPATIBLE_PRIMITIVES';
    if (error.message === 'GENERATION_OUTPUT_INVALID') return 'GENERATION_OUTPUT_INVALID';
    if (error.message === 'MANIFEST_GENERATION_WARNING_LIMIT') {
      return 'GENERATION_OUTPUT_INVALID';
    }
  }
  return 'WORKER_EXECUTION_FAILED';
}

function isTerminalFailure(code: ManifestGenerationFailureCode): boolean {
  return (
    code === 'CATALOG_SCOPE_EXCEEDED' ||
    code === 'GENERATION_INPUT_MISMATCH' ||
    code === 'GENERATION_OUTPUT_INVALID' ||
    code === 'NO_COMPATIBLE_PRIMITIVES' ||
    code === 'PROMPT_UNAVAILABLE' ||
    code === 'PROVIDER_CONFIGURATION_MISMATCH'
  );
}

export class ManifestGenerationRunner {
  private readonly claimHeartbeatIntervalMs: number;
  private readonly claimTimeoutMs: number;
  private readonly clock: Clock;
  private readonly dailyBudgetMicrounits: number;
  private readonly enabled: boolean;
  private readonly ids: IdGenerator;
  private readonly maximumConcurrentPerWorld: number;
  private readonly maximumRunsPerReconciliation: number;
  private readonly metrics: ManifestGenerationMetrics;
  private readonly notifications: WorkerNotificationSink;
  private readonly promptCleanupBatchSize: number;

  public constructor(
    private readonly repository: ManifestGenerationRepository,
    private readonly engine: ManifestGenerationEngine,
    private readonly providerConfigurationId: string,
    private readonly logger: Logger,
    options: ManifestGenerationRunnerOptions = {},
  ) {
    this.claimTimeoutMs = options.claimTimeoutMs ?? 30_000;
    this.claimHeartbeatIntervalMs =
      options.claimHeartbeatIntervalMs ?? Math.max(250, Math.min(5_000, this.claimTimeoutMs / 3));
    this.clock = options.clock ?? new SystemClock();
    this.dailyBudgetMicrounits = options.dailyBudgetMicrounits ?? 0;
    if (
      !Number.isSafeInteger(this.dailyBudgetMicrounits) ||
      this.dailyBudgetMicrounits < 0 ||
      this.dailyBudgetMicrounits > 2_147_483_647
    ) {
      throw new RangeError('dailyBudgetMicrounits must be 0..2147483647.');
    }
    this.enabled = options.enabled ?? true;
    this.ids = options.ids ?? new UuidV7Generator();
    this.maximumConcurrentPerWorld = options.maximumConcurrentPerWorld ?? 1;
    this.maximumRunsPerReconciliation = options.maximumRunsPerReconciliation ?? 10;
    this.metrics = options.metrics ?? discardManifestGenerationMetrics;
    this.notifications = options.notifications ?? discardWorkerNotifications;
    this.promptCleanupBatchSize = options.promptCleanupBatchSize ?? 100;
  }

  public async runOne(): Promise<ManifestGenerationRunResult> {
    return withSpan('manifest.generation.execute', async (span) => {
      span.setAttributes({
        'manifest.generation.outcome': 'failed',
        'manifest.generation.provider_configuration': this.providerConfigurationId,
        'manifest.generation.schema_version': MANIFEST_GENERATOR_SCHEMA_VERSION,
      });
      const result = await this.executeOne();
      span.setAttribute('manifest.generation.outcome', result.outcome);
      if (result.job) {
        span.setAttributes({
          'manifest.generation.attempt': result.job.attempts,
          'manifest.generation.run_id': result.job.runId,
          'world.id': result.job.worldId,
        });
      }
      if (result.revisionId) span.setAttribute('manifest.revision.id', result.revisionId);
      return result;
    });
  }

  private async executeOne(): Promise<ManifestGenerationRunResult> {
    const job = await this.repository.claimNext(
      this.providerConfigurationId,
      this.ids.next(),
      this.maximumConcurrentPerWorld,
    );
    if (!job) return { job: null, outcome: 'idle' };
    const queueWaitMs = Math.max(0, this.clock.now().getTime() - job.queuedAt.getTime());
    if (
      job.generatorSchemaVersion !== MANIFEST_GENERATOR_SCHEMA_VERSION ||
      job.promptTemplateVersion !== MANIFEST_PROMPT_TEMPLATE_VERSION ||
      job.providerConfigurationId !== this.providerConfigurationId
    ) {
      return this.fail(job, 'PROVIDER_CONFIGURATION_MISMATCH', false, queueWaitMs);
    }
    const input = await this.repository.loadInput(job);
    if (!input) {
      if (!(await this.repository.isClaimCurrent(job))) {
        return this.record(job, 'lost_claim', { queueWaitMs });
      }
      return this.fail(job, 'PROMPT_UNAVAILABLE', false, queueWaitMs);
    }
    const expectedBaseHash = manifestGenerationRequestHash({
      expectedParentContentHash: job.expectedParentContentHash,
      parentRevisionId: job.parentRevisionId,
      prompt: input.prompt,
      providerConfigurationId: job.providerConfigurationId,
      seed: job.seed,
    });
    if (expectedBaseHash !== job.inputHash) {
      return this.fail(job, 'GENERATION_INPUT_MISMATCH', false, queueWaitMs);
    }

    let frozen: FrozenManifestCatalog;
    try {
      if (!(await this.repository.updateStage(job, 'retrieval', 20))) {
        return this.record(job, 'lost_claim', { queueWaitMs });
      }
      const result = await this.repository.freezeCatalog(job, input.prompt);
      if (!result) return this.record(job, 'lost_claim', { queueWaitMs });
      frozen = result;
      this.metrics.recordRetrieval(result.retrievalCount);
    } catch (error) {
      const code = failureCode(error);
      return this.fail(job, code, !isTerminalFailure(code), queueWaitMs);
    }

    const claimed = { ...job, resolvedInputHash: frozen.resolvedInputHash };
    const initialUsage = await this.repository.loadProviderUsage(claimed);
    if (!initialUsage) return this.record(claimed, 'lost_claim', { queueWaitMs });
    let outcome: ManifestGenerationOutcome;
    const controller = new AbortController();
    let heartbeatActive = false;
    const heartbeat = setInterval(() => {
      if (heartbeatActive) return;
      heartbeatActive = true;
      void this.repository
        .heartbeat(claimed)
        .then((current) => {
          if (!current) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => {
          heartbeatActive = false;
        });
    }, this.claimHeartbeatIntervalMs);
    heartbeat.unref();
    const onStage: ManifestGenerationStageCallback = async (stage) => {
      const current = await this.repository.updateStage(claimed, stage, stageProgress[stage]);
      if (!current) {
        controller.abort();
        throw new ClaimLostError();
      }
    };
    try {
      outcome = await this.engine.generate(
        {
          catalog: frozen.catalog,
          expectedParentContentHash: claimed.expectedParentContentHash,
          parentRevisionId: claimed.parentRevisionId,
          prompt: input.prompt,
          seed: claimed.seed,
        },
        controller.signal,
        onStage,
        {
          initialUsage,
          releaseProviderCall: async (reservation) => {
            if (!(await this.repository.releaseProviderCall(claimed, reservation))) {
              throw new ClaimLostError();
            }
          },
          reserveProviderCall: (request) =>
            this.repository.reserveProviderCall(
              claimed,
              this.ids.next(),
              this.dailyBudgetMicrounits,
              request,
            ),
          settleProviderCall: async (reservation, settlement) => {
            if (!(await this.repository.settleProviderCall(claimed, reservation, settlement))) {
              throw new ClaimLostError();
            }
          },
        },
      );
    } catch (error) {
      clearInterval(heartbeat);
      if (
        error instanceof ClaimLostError ||
        error instanceof ManifestGenerationCancelledError ||
        controller.signal.aborted
      ) {
        if (!(await this.repository.isClaimCurrent(claimed))) {
          return this.record(claimed, 'lost_claim', { queueWaitMs });
        }
      }
      const code = failureCode(error);
      return this.fail(claimed, code, !isTerminalFailure(code), queueWaitMs);
    } finally {
      clearInterval(heartbeat);
    }

    if (
      outcome.inputHash !== claimed.inputHash ||
      outcome.resolvedInputHash !== frozen.resolvedInputHash ||
      outcome.catalogSnapshotHash !== frozen.catalogSnapshotHash ||
      outcome.providerConfigurationId !== claimed.providerConfigurationId ||
      outcome.seed !== claimed.seed
    ) {
      return this.fail(claimed, 'GENERATION_OUTPUT_INVALID', false, queueWaitMs);
    }
    let effectiveOutcome: ManifestGenerationOutcome;
    try {
      const inheritedWarnings = await this.repository.generationWarnings(
        claimed.worldId,
        claimed.parentRevisionId,
      );
      effectiveOutcome = {
        ...outcome,
        envelope: {
          ...outcome.envelope,
          warnings: mergeManifestGenerationWarnings(inheritedWarnings, outcome.envelope.warnings),
        },
      };
    } catch (error) {
      const code = failureCode(error);
      return this.fail(claimed, code, !isTerminalFailure(code), queueWaitMs);
    }
    const validation = validateManifestGenerationEnvelope(
      effectiveOutcome.envelope,
      frozen.catalog,
    );
    if (!validation.valid || validation.contentHash !== outcome.contentHash) {
      return this.fail(claimed, 'GENERATION_OUTPUT_INVALID', false, queueWaitMs);
    }
    if (!(await this.repository.updateStage(claimed, 'persisting', 90))) {
      return this.record(claimed, 'lost_claim', { queueWaitMs });
    }
    try {
      const published = await this.repository.publish(claimed, {
        catalog: frozen.catalog,
        ids: { reportId: this.ids.next(), revisionId: this.ids.next() },
        outcome: effectiveOutcome,
        validation,
      });
      if (!published) return this.record(claimed, 'lost_claim', { queueWaitMs });
      this.metrics.recordDiagnostics(validation.diagnostics);
      await this.publishBestEffort(claimed, effectiveOutcome, {
        contentHash: published.contentHash,
        revisionId: published.revisionId,
      });
      return this.record(claimed, 'succeeded', {
        costMicrounits: effectiveOutcome.costMicrounits,
        durationMs: effectiveOutcome.latencyMs,
        mode: effectiveOutcome.mode,
        queueWaitMs,
        revisionId: published.revisionId,
      });
    } catch (error) {
      const code = failureCode(error);
      return this.fail(claimed, code, !isTerminalFailure(code), queueWaitMs);
    }
  }

  public async reconcile(): Promise<ManifestGenerationRunResult[]> {
    try {
      const cleaned = await this.repository.cleanupExpiredPrompts(this.promptCleanupBatchSize);
      this.metrics.recordPromptCleanup(cleaned, 'completed');
      if (cleaned > 0) this.logger.info({ cleaned }, 'manifest_generation.prompts_redacted');
    } catch {
      this.metrics.recordPromptCleanup(0, 'failed');
      this.logger.warn(
        { code: 'PROMPT_CLEANUP_FAILED' },
        'manifest_generation.prompt_cleanup_failed',
      );
    }
    const recovered = await this.repository.recoverExpiredClaims(this.claimTimeoutMs);
    if (recovered.failed > 0 || recovered.retried > 0) {
      this.logger.warn(recovered, 'manifest_generation.expired_claims_recovered');
    }
    const results: ManifestGenerationRunResult[] = [];
    if (this.enabled) {
      for (let index = 0; index < this.maximumRunsPerReconciliation; index += 1) {
        const result = await this.runOne();
        if (result.outcome === 'idle') break;
        results.push(result);
      }
    }
    const backlog = await this.repository.inspectBacklog(this.providerConfigurationId);
    this.metrics.recordBacklog(backlog.ready, backlog.running, backlog.oldestAgeMs);
    return results;
  }

  private async fail(
    job: ClaimedManifestGenerationRun,
    code: ManifestGenerationFailureCode,
    retryable: boolean,
    queueWaitMs: number,
  ): Promise<ManifestGenerationRunResult> {
    const result = await this.repository.markFailure(job, code, retryable);
    if (result === 'lost_claim') return this.record(job, 'lost_claim', { queueWaitMs });
    if (result === 'retry_scheduled') {
      return this.record(job, 'retry_scheduled', { code, queueWaitMs });
    }
    await this.publishBestEffort(job, null, { errorCode: code });
    return this.record(job, 'failed', { code, queueWaitMs });
  }

  private record(
    job: ClaimedManifestGenerationRun,
    outcome: ManifestGenerationWorkerOutcome,
    options: {
      code?: ManifestGenerationFailureCode;
      costMicrounits?: number;
      durationMs?: number;
      mode?: 'fallback' | 'provider';
      queueWaitMs?: number;
      revisionId?: string;
    } = {},
  ): ManifestGenerationRunResult {
    this.metrics.recordRun(outcome, options);
    const context = {
      attempts: job.attempts,
      ...(options.code ? { code: options.code } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      outcome,
      runId: job.runId,
      worldId: job.worldId,
    };
    if (outcome === 'failed' || outcome === 'retry_scheduled') {
      this.logger.warn(context, 'manifest_generation.finished');
    } else {
      this.logger.info(context, 'manifest_generation.finished');
    }
    return {
      job,
      outcome,
      ...(options.revisionId ? { revisionId: options.revisionId } : {}),
    };
  }

  private async publishBestEffort(
    job: ClaimedManifestGenerationRun,
    outcome: ManifestGenerationOutcome | null,
    result: { contentHash: string; revisionId: string } | { errorCode: string },
  ): Promise<void> {
    const notification: ApplicationNotification =
      'revisionId' in result
        ? {
            id: this.ids.next(),
            occurredAt: this.clock.now().toISOString(),
            payload: {
              contentHash: result.contentHash,
              revisionId: result.revisionId,
              runId: job.runId,
              worldId: job.worldId,
            },
            schemaVersion: 1,
            type: 'ManifestGenerationSucceeded',
          }
        : {
            id: this.ids.next(),
            occurredAt: this.clock.now().toISOString(),
            payload: { errorCode: result.errorCode, runId: job.runId, worldId: job.worldId },
            schemaVersion: 1,
            type: 'ManifestGenerationFailed',
          };
    try {
      notificationValidator.assert(notification);
      await this.notifications.publish(notification);
    } catch {
      this.logger.warn(
        {
          code: 'NOTIFICATION_PUBLISH_FAILED',
          notificationType: notification.type,
          runId: job.runId,
        },
        'manifest_generation.notification_failed',
      );
    }
    if (outcome?.failures.length) {
      this.logger.info(
        {
          mode: outcome.mode,
          providerFailureCodes: outcome.failures,
          runId: job.runId,
        },
        'manifest_generation.provider_path',
      );
    }
  }
}

export interface ManifestGenerationCoordinatorOptions {
  monotonicNow?: () => number;
  reconciliationIntervalMs?: number;
}

export interface ManifestGenerationReconciler {
  reconcile(): Promise<ManifestGenerationRunResult[]>;
}

export class ManifestGenerationCoordinator {
  private active: Promise<ManifestGenerationRunResult[]> | undefined;
  private lastReconciliationStartedAt = Number.NEGATIVE_INFINITY;
  private readonly monotonicNow: () => number;
  private readonly reconciliationIntervalMs: number;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly runner: ManifestGenerationReconciler,
    private readonly logger: Logger,
    options: ManifestGenerationCoordinatorOptions = {},
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.reconciliationIntervalMs = options.reconciliationIntervalMs ?? 2_000;
  }

  public start(): void {
    if (this.stopped || this.timer) return;
    void this.wake().catch(() => {
      this.logger.error(
        { code: 'RECONCILIATION_FAILED' },
        'manifest_generation.reconciliation_failed',
      );
    });
    this.timer = setInterval(() => {
      void this.wake().catch(() => {
        this.logger.error(
          { code: 'RECONCILIATION_FAILED' },
          'manifest_generation.reconciliation_failed',
        );
      });
    }, this.reconciliationIntervalMs);
    this.timer.unref();
  }

  public wake(): Promise<ManifestGenerationRunResult[]> {
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
