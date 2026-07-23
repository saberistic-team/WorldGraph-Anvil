import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { EmbeddingProvider, EmbeddingResult } from '@worldgraph/catalog';
import {
  createPrimitiveEmbeddingProfile,
  disabledEmbeddingProvider,
  EmbeddingProviderError,
  STARTER_PRIMITIVES,
} from '@worldgraph/catalog';
import { applyMigrations, createDatabaseClient, importStarterPrimitives } from '@worldgraph/db';
import { createLogger } from '@worldgraph/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresPrimitiveIndexRepository } from './primitive-index-repository.js';
import { PrimitiveIndexRunner, type PrimitiveIndexMetrics } from './primitive-index-worker.js';

const migrationRoot = resolve('packages/db/drizzle');
const primary = STARTER_PRIMITIVES[0]!;
const secondary = STARTER_PRIMITIVES[1]!;
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'primitive-index-integration-test',
});
const noOpMetrics: PrimitiveIndexMetrics = {
  recordBacklog: () => undefined,
  recordCache: () => undefined,
  recordJob: () => undefined,
  recordProvider: () => undefined,
};

function fixedEmbedding(): EmbeddingResult {
  return {
    costEstimateMicrounits: 17,
    dimensions: 1536,
    latencyMs: 11,
    model: 'fixed-1536-v1',
    provider: 'test-fixed',
    tokenEstimate: 23,
    vector: Array.from({ length: 1536 }, (_, index) => (index + 1) / 100_000),
  };
}

function provider(
  embed: EmbeddingProvider['embed'],
  configurationId = 'fake-v1',
): EmbeddingProvider {
  return { configurationId, embed, enabled: true };
}

describe('PostgreSQL-authoritative primitive indexing', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let database: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    database = createDatabaseClient(container.getConnectionUri(), 'primitive-index-integration');
    await applyMigrations(database, migrationRoot);
    await importStarterPrimitives(database.pool);
  });

  afterAll(async () => {
    await database?.pool.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await database.pool.query('delete from primitive_embeddings');
    await database.pool.query('delete from primitive_index_jobs');
  });

  async function addJob(
    seed: (typeof STARTER_PRIMITIVES)[number] = primary,
    providerConfigurationId = 'fake-v1',
    contentHash = seed.contentHash,
  ): Promise<void> {
    await database.pool.query(
      `insert into primitive_index_jobs
        (primitive_version_id, content_hash, index_schema_version, provider_configuration_id)
       values ($1, decode($2, 'hex'), 1, $3)`,
      [seed.versionId, contentHash, providerConfigurationId],
    );
  }

  function repository(): PostgresPrimitiveIndexRepository {
    return new PostgresPrimitiveIndexRepository(database.pool, {
      baseBackoffMs: 0,
      maximumBackoffMs: 0,
    });
  }

  function runner(
    indexRepository: PostgresPrimitiveIndexRepository,
    embeddingProvider: EmbeddingProvider,
  ): PrimitiveIndexRunner {
    return new PrimitiveIndexRunner(indexRepository, embeddingProvider, logger, {
      claimTimeoutMs: 0,
      clock: { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids: { next: () => '018f0000-0000-7000-8000-000000000999' },
      maximumJobsPerRun: 25,
      metrics: noOpMetrics,
      providerTimeoutMs: 50,
    });
  }

  it('discovers side-by-side profile jobs for every published version without resetting terminal work', async () => {
    const indexRepository = repository();
    await expect(indexRepository.ensureCurrentJobs('disabled-v1', 1, 250)).resolves.toEqual({
      inserted: 16,
      remaining: 0,
    });
    await expect(indexRepository.ensureCurrentJobs('local-hash-1536-v1', 1, 250)).resolves.toEqual({
      inserted: 16,
      remaining: 0,
    });

    await expect(
      runner(indexRepository, disabledEmbeddingProvider).runOne(),
    ).resolves.toMatchObject({
      outcome: 'disabled',
    });
    await expect(
      runner(indexRepository, createPrimitiveEmbeddingProfile('local_hash', 0)).runOne(),
    ).resolves.toMatchObject({ outcome: 'completed' });

    await expect(indexRepository.ensureCurrentJobs('disabled-v1', 1, 250)).resolves.toEqual({
      inserted: 0,
      remaining: 0,
    });
    await expect(indexRepository.ensureCurrentJobs('local-hash-1536-v1', 1, 250)).resolves.toEqual({
      inserted: 0,
      remaining: 0,
    });
    const state = await database.pool.query<{
      completed: string;
      disabled: string;
      jobs: string;
      provider_configuration_id: string;
    }>(
      `select provider_configuration_id, count(*)::text as jobs,
              count(*) filter (where status = 'completed')::text as completed,
              count(*) filter (where status = 'disabled')::text as disabled
         from primitive_index_jobs
        group by provider_configuration_id
        order by provider_configuration_id`,
    );
    expect(state.rows).toEqual([
      { completed: '0', disabled: '1', jobs: '16', provider_configuration_id: 'disabled-v1' },
      {
        completed: '1',
        disabled: '0',
        jobs: '16',
        provider_configuration_id: 'local-hash-1536-v1',
      },
    ]);
  });

  it('atomically claims distinct jobs with SKIP LOCKED under concurrent workers', async () => {
    await addJob(primary);
    await addJob(secondary);
    const firstRepository = repository();
    const secondRepository = repository();

    const [first, second] = await Promise.all([
      firstRepository.claimNext('fake-v1'),
      secondRepository.claimNext('fake-v1'),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.primitiveVersionId).not.toBe(second?.primitiveVersionId);
    const states = await database.pool.query<{ attempts: number; status: string }>(
      `select attempts, status from primitive_index_jobs order by primitive_version_id`,
    );
    expect(states.rows).toEqual([
      { attempts: 1, status: 'running' },
      { attempts: 1, status: 'running' },
    ]);
  });

  it('recovers an expired running claim with backoff state and permits an attempt-token retry', async () => {
    await addJob();
    const indexRepository = repository();
    const first = await indexRepository.claimNext('fake-v1');
    expect(first?.attempts).toBe(1);

    await expect(indexRepository.recoverExpiredClaims(0)).resolves.toBe(1);
    const failed = await database.pool.query<{
      attempts: number;
      last_error_code: string;
      status: string;
    }>('select attempts, last_error_code, status from primitive_index_jobs');
    expect(failed.rows[0]).toEqual({
      attempts: 1,
      last_error_code: 'PROVIDER_FAILED',
      status: 'failed',
    });

    const retried = await indexRepository.claimNext('fake-v1');
    expect(retried?.attempts).toBe(2);
    expect(await indexRepository.markFailure(first!, 'PROVIDER_FAILED')).toBe(false);
    const current = await database.pool.query<{ attempts: number; status: string }>(
      'select attempts, status from primitive_index_jobs',
    );
    expect(current.rows[0]).toEqual({ attempts: 2, status: 'running' });
  });

  it('keeps publication lexical state unchanged and records a disabled provider terminally', async () => {
    await addJob(primary, 'disabled-v1');
    const before = await database.pool.query<{
      content_hash: string;
      index_schema_version: number;
      normalized_text: string;
      updated_at: Date;
    }>(
      `select encode(content_hash, 'hex') as content_hash, index_schema_version,
              normalized_text, updated_at
         from primitive_search_documents where primitive_version_id = $1`,
      [primary.versionId],
    );

    const result = await runner(repository(), disabledEmbeddingProvider).runOne();

    expect(result.outcome).toBe('disabled');
    const state = await database.pool.query<{
      attempts: number;
      completed_at: Date | null;
      last_error_code: string;
      status: string;
    }>('select attempts, completed_at, last_error_code, status from primitive_index_jobs');
    expect(state.rows[0]).toMatchObject({
      attempts: 1,
      last_error_code: 'PROVIDER_DISABLED',
      status: 'disabled',
    });
    expect(state.rows[0]?.completed_at).toBeInstanceOf(Date);
    const after = await database.pool.query(
      `select encode(content_hash, 'hex') as content_hash, index_schema_version,
              normalized_text, updated_at
         from primitive_search_documents where primitive_version_id = $1`,
      [primary.versionId],
    );
    expect(after.rows).toEqual(before.rows);
    const embeddings = await database.pool.query<{ count: string }>(
      'select count(*)::text as count from primitive_embeddings',
    );
    expect(embeddings.rows[0]?.count).toBe('0');
  });

  it('executes the guarded store transaction and reuses its persisted cache after a simulated crash', async () => {
    await addJob();
    const embed = vi.fn<EmbeddingProvider['embed']>().mockResolvedValue(fixedEmbedding());
    const indexRepository = repository();
    const indexRunner = runner(indexRepository, provider(embed));

    await expect(indexRunner.runOne()).resolves.toMatchObject({ outcome: 'completed' });
    const stored = await database.pool.query<{
      cost_estimate_microunits: string;
      dimensions: number;
      latency_ms: number;
      status: string;
      token_estimate: number;
    }>(
      `select embedding.dimensions, embedding.token_estimate,
              embedding.cost_estimate_microunits::text, embedding.latency_ms,
              job.status
         from primitive_embeddings embedding
         join primitive_index_jobs job
           on job.primitive_version_id = embedding.primitive_version_id
          and job.content_hash = embedding.content_hash`,
    );
    expect(stored.rows[0]).toEqual({
      cost_estimate_microunits: '17',
      dimensions: 1536,
      latency_ms: 11,
      status: 'completed',
      token_estimate: 23,
    });

    // Simulate recovery after an embedding commit whose job completion was not observed.
    await database.pool.query(
      `update primitive_index_jobs
          set status = 'failed', last_error_code = 'PROVIDER_FAILED',
              completed_at = null, next_attempt_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where primitive_version_id = $1`,
      [primary.versionId],
    );
    await expect(indexRunner.runOne()).resolves.toMatchObject({ outcome: 'cache_hit' });
    expect(embed).toHaveBeenCalledOnce();
    const final = await database.pool.query<{ attempts: number; status: string }>(
      'select attempts, status from primitive_index_jobs',
    );
    expect(final.rows[0]).toEqual({ attempts: 2, status: 'completed' });
  });

  it('bounds retries and moves the fifth provider failure to dead-letter state', async () => {
    await addJob();
    const indexRunner = runner(
      repository(),
      provider(async () => {
        throw new EmbeddingProviderError('PROVIDER_RATE_LIMITED');
      }),
    );

    const outcomes = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      outcomes.push((await indexRunner.runOne()).outcome);
    }

    expect(outcomes).toEqual(['failed', 'failed', 'failed', 'failed', 'dead']);
    const state = await database.pool.query<{
      attempts: number;
      completed_at: Date | null;
      last_error_code: string;
      status: string;
    }>('select attempts, completed_at, last_error_code, status from primitive_index_jobs');
    expect(state.rows[0]).toMatchObject({
      attempts: 5,
      last_error_code: 'PROVIDER_RATE_LIMITED',
      status: 'dead',
    });
    expect(state.rows[0]?.completed_at).toBeInstanceOf(Date);
  });

  it('records malformed nonfinite provider output without writing a vector', async () => {
    await addJob();
    const invalid = fixedEmbedding();
    invalid.vector[0] = Number.POSITIVE_INFINITY;

    await expect(
      runner(
        repository(),
        provider(async () => invalid),
      ).runOne(),
    ).resolves.toMatchObject({ outcome: 'failed' });

    const state = await database.pool.query<{ last_error_code: string; status: string }>(
      'select last_error_code, status from primitive_index_jobs',
    );
    expect(state.rows[0]).toEqual({ last_error_code: 'VECTOR_INVALID', status: 'failed' });
    const embeddings = await database.pool.query<{ count: string }>(
      'select count(*)::text as count from primitive_embeddings',
    );
    expect(embeddings.rows[0]?.count).toBe('0');
  });

  it('marks content-hash drift stale before the provider receives any text', async () => {
    await addJob(primary, 'fake-v1', 'f'.repeat(64));
    const embed = vi.fn<EmbeddingProvider['embed']>();

    await expect(runner(repository(), provider(embed)).runOne()).resolves.toMatchObject({
      outcome: 'stale',
    });

    expect(embed).not.toHaveBeenCalled();
    const state = await database.pool.query<{ last_error_code: string; status: string }>(
      'select last_error_code, status from primitive_index_jobs',
    );
    expect(state.rows[0]).toEqual({ last_error_code: 'CONTENT_STALE', status: 'stale' });
  });
});
