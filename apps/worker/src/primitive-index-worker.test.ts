import { metrics, type Meter } from '@opentelemetry/api';
import type {
  EmbeddingProvider,
  EmbeddingResult,
  PrimitiveIndexDocument,
} from '@worldgraph/catalog';
import {
  buildPrimitiveIndexDocument,
  disabledEmbeddingProvider,
  STARTER_PRIMITIVES,
} from '@worldgraph/catalog';
import type { ApplicationNotification, IdGenerator } from '@worldgraph/contracts';
import { createLogger } from '@worldgraph/observability';
import { describe, expect, it, vi } from 'vitest';

import {
  type ClaimedPrimitiveIndexJob,
  type PrimitiveIndexBacklog,
  type PrimitiveIndexFailureCode,
  type PrimitiveIndexRepository,
  type PrimitiveIndexSource,
} from './primitive-index-repository.js';
import {
  createProductionPrimitiveIndexMetrics,
  PrimitiveIndexCoordinator,
  PrimitiveIndexRunner,
  type PrimitiveIndexMetrics,
} from './primitive-index-worker.js';
import type { WorkerNotificationSink } from './application-notifications.js';

const seed = STARTER_PRIMITIVES[0]!;
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'primitive-index-test',
});
const notificationId = '018f0000-0000-7000-8000-000000000998';
const occurredAt = '2026-07-21T12:00:00.000Z';

function job(providerConfigurationId = 'fake-v1', attempts = 1): ClaimedPrimitiveIndexJob {
  return {
    attempts,
    contentHash: seed.contentHash,
    indexSchemaVersion: 1,
    primitiveVersionId: seed.versionId,
    providerConfigurationId,
    queuedAt: new Date('2026-07-21T12:00:00.000Z'),
  };
}

function source(): PrimitiveIndexSource {
  return { contentHash: seed.contentHash, input: seed.input, lifecycle: 'published' };
}

const noOpMetrics: PrimitiveIndexMetrics = {
  recordBacklog: () => undefined,
  recordCache: () => undefined,
  recordJob: () => undefined,
  recordProvider: () => undefined,
};

describe('production primitive index metrics', () => {
  it('labels every sample with the selected provider configuration', () => {
    const add = vi.fn();
    const record = vi.fn();
    const getMeter = vi.spyOn(metrics, 'getMeter').mockReturnValue({
      createCounter: () => ({ add }),
      createHistogram: () => ({ record }),
    } as unknown as Meter);
    try {
      const productionMetrics = createProductionPrimitiveIndexMetrics('local-hash-1536-v1');
      productionMetrics.recordBacklog(2, 500);
      productionMetrics.recordCache(true);
      productionMetrics.recordJob('failed', 'PROVIDER_TIMEOUT');
      productionMetrics.recordProvider(10, 20, 0);

      expect(getMeter).toHaveBeenCalledWith('worldgraph-worker');
      expect([...add.mock.calls, ...record.mock.calls]).not.toHaveLength(0);
      for (const call of [...add.mock.calls, ...record.mock.calls]) {
        expect(call[1]).toMatchObject({ provider_configuration: 'local-hash-1536-v1' });
      }
    } finally {
      getMeter.mockRestore();
    }
  });
});

class FakeRepository implements PrimitiveIndexRepository {
  public cached = false;
  public completedFromCache = false;
  public disabled = false;
  public failureCode?: PrimitiveIndexFailureCode;
  public lexicalValid = true;
  public recovered = 0;
  public stale = false;
  public stored?: EmbeddingResult;
  public readonly seenDocuments: PrimitiveIndexDocument[] = [];
  private claimed = false;

  public constructor(
    private readonly claimedJob: ClaimedPrimitiveIndexJob,
    public currentSource: PrimitiveIndexSource | null = source(),
  ) {}

  public async claimNext(
    providerConfigurationId: string,
    indexSchemaVersion = 1,
  ): Promise<ClaimedPrimitiveIndexJob | null> {
    if (
      this.claimed ||
      providerConfigurationId !== this.claimedJob.providerConfigurationId ||
      indexSchemaVersion !== this.claimedJob.indexSchemaVersion
    ) {
      return null;
    }
    this.claimed = true;
    return this.claimedJob;
  }

  public async completeFromCache(): Promise<boolean> {
    this.completedFromCache = true;
    return true;
  }

  public async findCachedEmbedding(): Promise<boolean> {
    return this.cached;
  }

  public async inspectBacklog(): Promise<PrimitiveIndexBacklog> {
    return { oldestAgeMs: 0, ready: 0 };
  }

  public async loadSource(): Promise<PrimitiveIndexSource | null> {
    return this.currentSource;
  }

  public async markDisabled(): Promise<boolean> {
    this.disabled = true;
    return true;
  }

  public async markFailure(
    _job: ClaimedPrimitiveIndexJob,
    code: PrimitiveIndexFailureCode,
  ): Promise<boolean> {
    this.failureCode = code;
    return true;
  }

  public async markStale(): Promise<boolean> {
    this.stale = true;
    return true;
  }

  public async recoverExpiredClaims(): Promise<number> {
    return this.recovered;
  }

  public async storeEmbeddingAndComplete(
    _job: ClaimedPrimitiveIndexJob,
    _embeddingId: string,
    embedding: EmbeddingResult,
  ): Promise<boolean> {
    this.stored = embedding;
    return true;
  }

  public async verifyLexicalDocument(
    _job: ClaimedPrimitiveIndexJob,
    document: PrimitiveIndexDocument,
  ): Promise<boolean> {
    this.seenDocuments.push(document);
    return this.lexicalValid;
  }
}

function fixedResult(overrides: Partial<EmbeddingResult> = {}): EmbeddingResult {
  return {
    dimensions: 1536,
    latencyMs: 12,
    model: 'fixed-1536-v1',
    provider: 'test-fixed',
    tokenEstimate: 20,
    vector: Array.from({ length: 1536 }, (_, index) => (index + 1) / 10_000),
    ...overrides,
  };
}

function provider(
  embed: EmbeddingProvider['embed'],
  configurationId = 'fake-v1',
): EmbeddingProvider {
  return { configurationId, embed, enabled: true };
}

function runner(
  repository: PrimitiveIndexRepository,
  embeddingProvider: EmbeddingProvider,
  providerTimeoutMs = 100,
  notifications: ApplicationNotification[] = [],
  ids: IdGenerator = { next: () => notificationId },
  notificationSink: WorkerNotificationSink = {
    publish: async (notification) => {
      notifications.push(notification);
    },
  },
): PrimitiveIndexRunner {
  return new PrimitiveIndexRunner(repository, embeddingProvider, logger, {
    clock: { now: () => new Date(occurredAt) },
    ids,
    metrics: noOpMetrics,
    notifications: notificationSink,
    providerTimeoutMs,
  });
}

function completedNotification(): ApplicationNotification {
  return {
    id: notificationId,
    occurredAt,
    payload: { primitiveVersionId: seed.versionId },
    schemaVersion: 1,
    type: 'PrimitiveIndexCompleted',
  };
}

function failedNotification(errorCode: PrimitiveIndexFailureCode): ApplicationNotification {
  return {
    id: notificationId,
    occurredAt,
    payload: { errorCode, primitiveVersionId: seed.versionId },
    schemaVersion: 1,
    type: 'PrimitiveIndexFailed',
  };
}

describe('primitive index runner', () => {
  it('verifies immutable lexical provenance then records provider-disabled without an embedding call', async () => {
    const repository = new FakeRepository(job('disabled-v1'));
    const notifications: ApplicationNotification[] = [];

    const result = await runner(repository, disabledEmbeddingProvider, 100, notifications).runOne();

    expect(result.outcome).toBe('disabled');
    expect(repository.disabled).toBe(true);
    expect(repository.stored).toBeUndefined();
    expect(repository.seenDocuments).toEqual([buildPrimitiveIndexDocument(seed.input)]);
    expect(notifications).toEqual([failedNotification('PROVIDER_DISABLED')]);
  });

  it('marks a missing or mismatched publication lexical document stale and never calls the provider', async () => {
    const repository = new FakeRepository(job());
    repository.lexicalValid = false;
    const embed = vi.fn<EmbeddingProvider['embed']>();
    const notifications: ApplicationNotification[] = [];

    const result = await runner(repository, provider(embed), 100, notifications).runOne();

    expect(result.outcome).toBe('stale');
    expect(repository.stale).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    expect(notifications).toEqual([failedNotification('CONTENT_STALE')]);
  });

  it('uses a content-hash/provider cache without calling the provider', async () => {
    const repository = new FakeRepository(job());
    repository.cached = true;
    const embed = vi.fn<EmbeddingProvider['embed']>();
    const notifications: ApplicationNotification[] = [];

    const result = await runner(repository, provider(embed), 100, notifications).runOne();

    expect(result.outcome).toBe('cache_hit');
    expect(repository.completedFromCache).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    expect(notifications).toEqual([completedNotification()]);
  });

  it('stores a valid fixed embedding and exposes only bounded index text to the provider', async () => {
    const repository = new FakeRepository(job());
    const embed = vi.fn<EmbeddingProvider['embed']>().mockResolvedValue(fixedResult());
    const notifications: ApplicationNotification[] = [];

    const result = await runner(repository, provider(embed), 100, notifications).runOne();

    expect(result.outcome).toBe('completed');
    expect(repository.stored).toEqual(fixedResult());
    expect(embed).toHaveBeenCalledOnce();
    expect(embed.mock.calls[0]?.[0]).toEqual({
      contentHash: seed.contentHash,
      normalizedText: buildPrimitiveIndexDocument(seed.input).normalizedText,
    });
    expect(notifications).toEqual([completedNotification()]);
  });

  it.each([
    ['wrong dimensions', fixedResult({ dimensions: 1536, vector: [1, 2, 3] })],
    [
      'nonfinite vector',
      fixedResult({
        vector: [Number.NaN, ...Array.from({ length: 1535 }, () => 0.1)],
      }),
    ],
    ['zero vector', fixedResult({ vector: Array.from({ length: 1536 }, () => 0) })],
  ])('safely records VECTOR_INVALID for a %s', async (_label, invalid) => {
    const repository = new FakeRepository(job());
    const embeddingProvider = provider(async () => invalid);
    const notifications: ApplicationNotification[] = [];

    const result = await runner(repository, embeddingProvider, 100, notifications).runOne();

    expect(result.outcome).toBe('failed');
    expect(repository.failureCode).toBe('VECTOR_INVALID');
    expect(repository.stored).toBeUndefined();
    expect(notifications).toEqual([failedNotification('VECTOR_INVALID')]);
  });

  it('bounds providers that ignore abort signals and records a retryable timeout', async () => {
    const repository = new FakeRepository(job());
    const embeddingProvider = provider(() => new Promise<EmbeddingResult>(() => undefined));
    const notifications: ApplicationNotification[] = [];

    const result = await runner(repository, embeddingProvider, 5, notifications).runOne();

    expect(result.outcome).toBe('failed');
    expect(repository.failureCode).toBe('PROVIDER_TIMEOUT');
    expect(notifications).toEqual([failedNotification('PROVIDER_TIMEOUT')]);
  });

  it('does not let a provider receive stale source content', async () => {
    const repository = new FakeRepository(job(), {
      ...source(),
      contentHash: 'f'.repeat(64),
    });
    const embed = vi.fn<EmbeddingProvider['embed']>();
    const notifications: ApplicationNotification[] = [];

    const result = await runner(repository, provider(embed), 100, notifications).runOne();

    expect(result.outcome).toBe('stale');
    expect(repository.stale).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    expect(notifications).toEqual([failedNotification('CONTENT_STALE')]);
  });

  it('emits a sanitized failed notification when the fifth attempt becomes dead', async () => {
    const repository = new FakeRepository(job('fake-v1', 5));
    const notifications: ApplicationNotification[] = [];
    const secretError = Object.assign(new Error('secret provider body'), {
      code: 'PROVIDER_RATE_LIMITED',
    });

    const result = await runner(
      repository,
      provider(async () => {
        throw secretError;
      }),
      100,
      notifications,
    ).runOne();

    expect(result.outcome).toBe('dead');
    expect(notifications).toEqual([failedNotification('PROVIDER_RATE_LIMITED')]);
    expect(JSON.stringify(notifications)).not.toContain('secret provider body');
  });

  it('keeps a guarded completion successful when best-effort notification delivery fails', async () => {
    const repository = new FakeRepository(job());
    const notificationSink: WorkerNotificationSink = {
      publish: async () => {
        throw new Error('private downstream notification failure');
      },
    };

    const result = await runner(
      repository,
      provider(async () => fixedResult()),
      100,
      [],
      { next: () => notificationId },
      notificationSink,
    ).runOne();

    expect(result.outcome).toBe('completed');
    expect(repository.stored).toEqual(fixedResult());
  });

  it('fails closed when a provider result exceeds the explicit production cost budget', async () => {
    const repository = new FakeRepository(job());
    const indexRunner = new PrimitiveIndexRunner(
      repository,
      provider(async () => fixedResult({ costEstimateMicrounits: 1 })),
      logger,
      {
        clock: { now: () => new Date(occurredAt) },
        ids: { next: () => notificationId },
        maximumProviderCostMicrounits: 0,
        metrics: noOpMetrics,
        providerTimeoutMs: 100,
      },
    );

    await expect(indexRunner.runOne()).resolves.toMatchObject({ outcome: 'failed' });
    expect(repository.failureCode).toBe('PROVIDER_FAILED');
    expect(repository.stored).toBeUndefined();
  });

  it('runtime-validates a terminal notification before calling the injected sink', async () => {
    const repository = new FakeRepository(job());
    repository.cached = true;
    const publish = vi.fn<WorkerNotificationSink['publish']>();

    const result = await runner(
      repository,
      provider(vi.fn<EmbeddingProvider['embed']>()),
      100,
      [],
      { next: () => 'not-a-uuid' },
      { publish },
    ).runOne();

    expect(result.outcome).toBe('cache_hit');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('primitive index coordinator', () => {
  it('coalesces concurrent BullMQ and timer wakes into one PostgreSQL reconciliation', async () => {
    let resolveReconciliation: ((value: []) => void) | undefined;
    const reconcile = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveReconciliation = resolve;
        }),
    );
    const coordinator = new PrimitiveIndexCoordinator({ reconcile }, logger);

    const first = coordinator.wake();
    const duplicate = coordinator.wake();
    expect(reconcile).toHaveBeenCalledOnce();
    resolveReconciliation?.([]);

    await expect(first).resolves.toEqual([]);
    await expect(duplicate).resolves.toEqual([]);
    await coordinator.stop();
  });

  it('rate-limits sequential duplicate wakes to the configured reconciliation interval', async () => {
    let now = 10_000;
    const reconcile = vi.fn(async () => []);
    const coordinator = new PrimitiveIndexCoordinator({ reconcile }, logger, {
      monotonicNow: () => now,
      reconciliationIntervalMs: 5_000,
    });

    await expect(coordinator.wake()).resolves.toEqual([]);
    now += 4_999;
    await expect(coordinator.wake()).resolves.toEqual([]);
    expect(reconcile).toHaveBeenCalledOnce();
    now += 1;
    await expect(coordinator.wake()).resolves.toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it('observes reconciliation rejection cleanup and permits a later recovery wake', async () => {
    let now = 10_000;
    const reconcile = vi
      .fn<() => Promise<[]>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce([]);
    const coordinator = new PrimitiveIndexCoordinator({ reconcile }, logger, {
      monotonicNow: () => now,
      reconciliationIntervalMs: 5_000,
    });

    await expect(coordinator.wake()).rejects.toThrow('database unavailable');
    now += 5_000;
    await expect(coordinator.wake()).resolves.toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });
});
