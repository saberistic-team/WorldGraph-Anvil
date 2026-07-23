import { metrics } from '@opentelemetry/api';
import {
  assertEmbedding,
  buildPrimitiveIndexDocument,
  EmbeddingProviderError,
  validatePrimitive,
  type EmbeddingProvider,
  type EmbeddingResult,
} from '@worldgraph/catalog';
import {
  ApplicationNotificationSchema,
  createValidator,
  PRIMITIVE_INDEX_SCHEMA_VERSION,
  SystemClock,
  UuidV7Generator,
  type ApplicationNotification,
  type Clock,
  type IdGenerator,
  type Validator,
} from '@worldgraph/contracts';
import { withSpan } from '@worldgraph/observability';
import type { Logger } from 'pino';

import {
  discardWorkerNotifications,
  type WorkerNotificationSink,
} from './application-notifications.js';
import {
  type ClaimedPrimitiveIndexJob,
  type PrimitiveIndexFailureCode,
  type PrimitiveIndexRepository,
} from './primitive-index-repository.js';
import { supportsPrimitiveIndexJobDiscovery } from './primitive-index-startup.js';

const notificationValidator: Validator<ApplicationNotification> =
  createValidator<ApplicationNotification>(ApplicationNotificationSchema);

export type PrimitiveIndexOutcome =
  'cache_hit' | 'completed' | 'dead' | 'disabled' | 'failed' | 'idle' | 'lost_claim' | 'stale';

export interface PrimitiveIndexRunResult {
  job: ClaimedPrimitiveIndexJob | null;
  outcome: PrimitiveIndexOutcome;
}

export interface PrimitiveIndexMetrics {
  recordBacklog(ready: number, oldestAgeMs: number): void;
  recordCache(hit: boolean): void;
  recordJob(outcome: PrimitiveIndexOutcome, code?: PrimitiveIndexFailureCode): void;
  recordProvider(
    latencyMs: number,
    tokenEstimate: number | null,
    costEstimateMicrounits: number | null,
  ): void;
}

const discardPrimitiveIndexMetrics: PrimitiveIndexMetrics = {
  recordBacklog: () => undefined,
  recordCache: () => undefined,
  recordJob: () => undefined,
  recordProvider: () => undefined,
};

export function createProductionPrimitiveIndexMetrics(
  providerConfigurationId: string,
): PrimitiveIndexMetrics {
  if (!providerConfigurationId.trim() || providerConfigurationId.length > 120) {
    throw new Error('PRIMITIVE_INDEX_METRIC_CONFIGURATION_INVALID');
  }
  const meter = metrics.getMeter('worldgraph-worker');
  const profile = { provider_configuration: providerConfigurationId };
  const instruments = {
    backlog: meter.createHistogram('worldgraph_primitive_index_backlog'),
    backlogAge: meter.createHistogram('worldgraph_primitive_index_backlog_age_ms'),
    cache: meter.createCounter('worldgraph_primitive_index_cache_total'),
    jobs: meter.createCounter('worldgraph_primitive_index_jobs_total'),
    providerLatency: meter.createHistogram('worldgraph_primitive_index_provider_duration_ms'),
    providerCost: meter.createHistogram(
      'worldgraph_primitive_index_provider_cost_estimate_microunits',
    ),
    providerTokens: meter.createHistogram('worldgraph_primitive_index_provider_tokens'),
  };
  return {
    recordBacklog(ready, oldestAgeMs) {
      instruments.backlog.record(ready, profile);
      instruments.backlogAge.record(oldestAgeMs, profile);
    },
    recordCache(hit) {
      instruments.cache.add(1, { ...profile, outcome: hit ? 'hit' : 'miss' });
    },
    recordJob(outcome, code) {
      instruments.jobs.add(1, { ...profile, ...(code ? { code } : {}), outcome });
    },
    recordProvider(latencyMs, tokenEstimate, costEstimateMicrounits) {
      instruments.providerLatency.record(latencyMs, profile);
      if (tokenEstimate !== null) instruments.providerTokens.record(tokenEstimate, profile);
      if (costEstimateMicrounits !== null) {
        instruments.providerCost.record(costEstimateMicrounits, profile);
      }
    },
  };
}

export interface PrimitiveIndexRunnerOptions {
  claimTimeoutMs?: number;
  clock?: Clock;
  ids?: IdGenerator;
  maximumJobsPerRun?: number;
  maximumProviderCostMicrounits?: number;
  metrics?: PrimitiveIndexMetrics;
  notifications?: WorkerNotificationSink;
  providerTimeoutMs?: number;
}

class SafeProviderFailure extends Error {
  public constructor(public readonly code: PrimitiveIndexFailureCode) {
    super(code);
    this.name = 'SafeProviderFailure';
  }
}

function providerFailureCode(error: unknown, timedOut: boolean): PrimitiveIndexFailureCode {
  if (timedOut) return 'PROVIDER_TIMEOUT';
  if (error instanceof EmbeddingProviderError) return error.code;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === 'PROVIDER_DISABLED' ||
      code === 'PROVIDER_FAILED' ||
      code === 'PROVIDER_RATE_LIMITED' ||
      code === 'PROVIDER_TIMEOUT' ||
      code === 'VECTOR_INVALID'
    ) {
      return code;
    }
  }
  return 'PROVIDER_FAILED';
}

function assertProviderMetadata(result: EmbeddingResult): EmbeddingResult {
  const hasControlCharacter = (value: string): boolean =>
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    });
  const printable = (value: string, maximum: number): boolean =>
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !hasControlCharacter(value);
  if (
    !printable(result.provider, 120) ||
    !printable(result.model, 160) ||
    result.latencyMs > 2_147_483_647 ||
    (result.tokenEstimate !== null && result.tokenEstimate > 2_147_483_647)
  ) {
    throw new SafeProviderFailure('VECTOR_INVALID');
  }
  return result;
}

async function callProvider(
  provider: EmbeddingProvider,
  request: { contentHash: string; normalizedText: string },
  timeoutMs: number,
): Promise<EmbeddingResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('PROVIDER_TIMEOUT'));
      reject(new SafeProviderFailure('PROVIDER_TIMEOUT'));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    const result = await Promise.race([provider.embed(request, controller.signal), deadline]);
    return assertProviderMetadata(assertEmbedding(result));
  } catch (error) {
    throw new SafeProviderFailure(providerFailureCode(error, timedOut));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class PrimitiveIndexRunner {
  private readonly claimTimeoutMs: number;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly maximumJobsPerRun: number;
  private readonly maximumProviderCostMicrounits: number | undefined;
  private readonly metrics: PrimitiveIndexMetrics;
  private readonly notifications: WorkerNotificationSink;
  private readonly providerTimeoutMs: number;

  public constructor(
    private readonly repository: PrimitiveIndexRepository,
    private readonly provider: EmbeddingProvider,
    private readonly logger: Logger,
    options: PrimitiveIndexRunnerOptions = {},
  ) {
    this.claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new UuidV7Generator();
    this.maximumJobsPerRun = options.maximumJobsPerRun ?? 25;
    this.maximumProviderCostMicrounits = options.maximumProviderCostMicrounits;
    if (
      this.maximumProviderCostMicrounits !== undefined &&
      (!Number.isSafeInteger(this.maximumProviderCostMicrounits) ||
        this.maximumProviderCostMicrounits < 0)
    ) {
      throw new Error('PRIMITIVE_EMBEDDING_COST_BUDGET_INVALID');
    }
    this.metrics = options.metrics ?? discardPrimitiveIndexMetrics;
    this.notifications = options.notifications ?? discardWorkerNotifications;
    this.providerTimeoutMs = options.providerTimeoutMs ?? 5_000;
  }

  public async runOne(): Promise<PrimitiveIndexRunResult> {
    return withSpan('primitive.index.execute', async (span) => {
      span.setAttributes({
        'primitive.index.outcome': 'failed',
        'primitive.index.provider_configuration': this.provider.configurationId,
        'primitive.index.schema_version': PRIMITIVE_INDEX_SCHEMA_VERSION,
      });
      const result = await this.executeOne();
      span.setAttribute('primitive.index.outcome', result.outcome);
      if (result.job) {
        span.setAttributes({
          'primitive.index.attempt': result.job.attempts,
          'primitive.version.id': result.job.primitiveVersionId,
        });
      }
      return result;
    });
  }

  private async executeOne(): Promise<PrimitiveIndexRunResult> {
    const job = await this.repository.claimNext(
      this.provider.configurationId,
      PRIMITIVE_INDEX_SCHEMA_VERSION,
    );
    if (!job) return { job: null, outcome: 'idle' };

    if (
      job.indexSchemaVersion !== PRIMITIVE_INDEX_SCHEMA_VERSION ||
      job.providerConfigurationId !== this.provider.configurationId
    ) {
      const changed = await this.repository.markStale(job);
      return this.record(
        job,
        changed ? 'stale' : 'lost_claim',
        changed ? 'CONTENT_STALE' : undefined,
      );
    }

    const source = await this.repository.loadSource(job.primitiveVersionId);
    if (!source || source.lifecycle === 'draft') {
      const changed = await this.repository.markStale(job);
      return this.record(
        job,
        changed ? 'stale' : 'lost_claim',
        changed ? 'CONTENT_STALE' : undefined,
      );
    }
    const validation = validatePrimitive(source.input);
    if (
      !validation.valid ||
      validation.contentHash !== source.contentHash ||
      source.contentHash !== job.contentHash
    ) {
      const changed = await this.repository.markStale(job);
      return this.record(
        job,
        changed ? 'stale' : 'lost_claim',
        changed ? 'CONTENT_STALE' : undefined,
      );
    }

    // Schema-v1 lexical documents are deterministic publication output and are
    // DB-immutable. The worker verifies their full provenance and never rewrites them.
    const document = buildPrimitiveIndexDocument(source.input);
    if (!(await this.repository.verifyLexicalDocument(job, document))) {
      const changed = await this.repository.markStale(job);
      return this.record(
        job,
        changed ? 'stale' : 'lost_claim',
        changed ? 'CONTENT_STALE' : undefined,
      );
    }

    if (!this.provider.enabled) {
      const changed = await this.repository.markDisabled(job);
      return this.record(
        job,
        changed ? 'disabled' : 'lost_claim',
        changed ? 'PROVIDER_DISABLED' : undefined,
      );
    }

    const cached = await this.repository.findCachedEmbedding(job);
    this.metrics.recordCache(cached);
    if (cached) {
      const changed = await this.repository.completeFromCache(job);
      return this.record(job, changed ? 'cache_hit' : 'lost_claim');
    }

    let embedding: EmbeddingResult;
    try {
      embedding = await callProvider(
        this.provider,
        { contentHash: job.contentHash, normalizedText: document.normalizedText },
        this.providerTimeoutMs,
      );
      if (
        this.maximumProviderCostMicrounits !== undefined &&
        (embedding.costEstimateMicrounits === undefined ||
          embedding.costEstimateMicrounits === null ||
          embedding.costEstimateMicrounits > this.maximumProviderCostMicrounits)
      ) {
        throw new SafeProviderFailure('PROVIDER_FAILED');
      }
    } catch (error) {
      const code = error instanceof SafeProviderFailure ? error.code : 'PROVIDER_FAILED';
      const changed = await this.repository.markFailure(job, code);
      const outcome = !changed ? 'lost_claim' : job.attempts >= 5 ? 'dead' : 'failed';
      return this.record(job, outcome, changed ? code : undefined);
    }

    this.metrics.recordProvider(
      embedding.latencyMs,
      embedding.tokenEstimate,
      embedding.costEstimateMicrounits ?? null,
    );
    const changed = await this.repository.storeEmbeddingAndComplete(
      job,
      this.ids.next(),
      embedding,
    );
    return this.record(job, changed ? 'completed' : 'lost_claim');
  }

  public async reconcile(): Promise<PrimitiveIndexRunResult[]> {
    if (supportsPrimitiveIndexJobDiscovery(this.repository)) {
      const discovery = await this.repository.ensureCurrentJobs(
        this.provider.configurationId,
        PRIMITIVE_INDEX_SCHEMA_VERSION,
        this.maximumJobsPerRun,
      );
      if (discovery.inserted > 0) {
        this.logger.info(
          { inserted: discovery.inserted, remaining: discovery.remaining },
          'primitive_index.jobs_discovered',
        );
      }
    }
    const recovered = await this.repository.recoverExpiredClaims(this.claimTimeoutMs);
    if (recovered > 0) {
      this.logger.warn({ recovered }, 'primitive_index.expired_claims_recovered');
    }
    const results: PrimitiveIndexRunResult[] = [];
    for (let index = 0; index < this.maximumJobsPerRun; index += 1) {
      const result = await this.runOne();
      if (result.outcome === 'idle') break;
      results.push(result);
    }
    const backlog = await this.repository.inspectBacklog(this.provider.configurationId);
    this.metrics.recordBacklog(backlog.ready, backlog.oldestAgeMs);
    return results;
  }

  private async record(
    job: ClaimedPrimitiveIndexJob,
    outcome: PrimitiveIndexOutcome,
    code?: PrimitiveIndexFailureCode,
  ): Promise<PrimitiveIndexRunResult> {
    await this.publishBestEffort(job, outcome, code);
    this.metrics.recordJob(outcome, code);
    const context = {
      attempts: job.attempts,
      ...(code ? { code } : {}),
      indexSchemaVersion: job.indexSchemaVersion,
      outcome,
      primitiveVersionId: job.primitiveVersionId,
    };
    if (outcome === 'failed' || outcome === 'dead' || outcome === 'stale') {
      this.logger.warn(context, 'primitive_index.finished');
    } else {
      this.logger.info(context, 'primitive_index.finished');
    }
    return { job, outcome };
  }

  private async publishBestEffort(
    job: ClaimedPrimitiveIndexJob,
    outcome: PrimitiveIndexOutcome,
    code?: PrimitiveIndexFailureCode,
  ): Promise<void> {
    let notification: ApplicationNotification | null = null;
    if (outcome === 'completed' || outcome === 'cache_hit') {
      notification = {
        id: this.ids.next(),
        occurredAt: this.clock.now().toISOString(),
        payload: { primitiveVersionId: job.primitiveVersionId },
        schemaVersion: 1,
        type: 'PrimitiveIndexCompleted',
      };
    } else if (
      code &&
      (outcome === 'failed' || outcome === 'dead' || outcome === 'stale' || outcome === 'disabled')
    ) {
      notification = {
        id: this.ids.next(),
        occurredAt: this.clock.now().toISOString(),
        payload: { errorCode: code, primitiveVersionId: job.primitiveVersionId },
        schemaVersion: 1,
        type: 'PrimitiveIndexFailed',
      };
    }
    if (!notification) return;
    try {
      notificationValidator.assert(notification);
      await this.notifications.publish(notification);
    } catch {
      this.logger.warn(
        {
          code: 'NOTIFICATION_PUBLISH_FAILED',
          notificationType: notification.type,
          primitiveVersionId: job.primitiveVersionId,
        },
        'primitive_index.notification_failed',
      );
    }
  }
}

export interface PrimitiveIndexCoordinatorOptions {
  reconciliationIntervalMs?: number;
  monotonicNow?: () => number;
}

export interface PrimitiveIndexReconciler {
  reconcile(): Promise<PrimitiveIndexRunResult[]>;
}

export class PrimitiveIndexCoordinator {
  private active: Promise<PrimitiveIndexRunResult[]> | undefined;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly reconciliationIntervalMs: number;
  private readonly monotonicNow: () => number;
  private lastReconciliationStartedAt = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly runner: PrimitiveIndexReconciler,
    private readonly logger: Logger,
    options: PrimitiveIndexCoordinatorOptions = {},
  ) {
    this.reconciliationIntervalMs = options.reconciliationIntervalMs ?? 5_000;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  public start(): void {
    if (this.stopped || this.timer) return;
    void this.wake().catch(() => {
      this.logger.error({ code: 'RECONCILIATION_FAILED' }, 'primitive_index.reconciliation_failed');
    });
    this.timer = setInterval(() => {
      void this.wake().catch(() => {
        this.logger.error(
          { code: 'RECONCILIATION_FAILED' },
          'primitive_index.reconciliation_failed',
        );
      });
    }, this.reconciliationIntervalMs);
    this.timer.unref();
  }

  public wake(): Promise<PrimitiveIndexRunResult[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.active) return this.active;
    const now = this.monotonicNow();
    if (now - this.lastReconciliationStartedAt < this.reconciliationIntervalMs) {
      return Promise.resolve([]);
    }
    this.lastReconciliationStartedAt = now;
    const active = this.runner.reconcile();
    this.active = active;
    const clearActive = (): void => {
      if (this.active === active) this.active = undefined;
    };
    void active.then(clearActive, clearActive);
    return active;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
