import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { applyMigrations, createDatabaseClient, importStarterPrimitives } from '@worldgraph/db';
import {
  createManifestGenerationEngine,
  createDeterministicFallback,
  manifestGenerationRequestHash,
  normalizeManifestPrompt,
  sha256,
  validateManifestGenerationEnvelope,
  type ManifestGenerationProvider,
  type ManifestProviderRequest,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDisabledManifestGenerationProvider } from './manifest-generation-provider.js';
import {
  PostgresManifestGenerationRepository,
  type ManifestGenerationRepository,
} from './manifest-generation-repository.js';
import {
  ManifestGenerationRunner,
  type ManifestGenerationMetrics,
} from './manifest-generation-worker.js';

const migrationRoot = resolve('packages/db/drizzle');
const providerConfigurationId = 'disabled-v1';
const prompt = normalizeManifestPrompt(
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.',
);
const seed = 'worker-integration-seed';
const creatorId = '018f0000-0000-7000-8000-000000009001';
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const worlds = {
  budgetA: '018f0000-0000-7000-8000-000000009107',
  budgetB: '018f0000-0000-7000-8000-000000009108',
  cancellation: '018f0000-0000-7000-8000-000000009102',
  cleanup: '018f0000-0000-7000-8000-000000009103',
  concurrencyA: '018f0000-0000-7000-8000-000000009104',
  concurrencyB: '018f0000-0000-7000-8000-000000009105',
  recovery: '018f0000-0000-7000-8000-000000009106',
  repairCap: '018f0000-0000-7000-8000-000000009110',
  retryAccounting: '018f0000-0000-7000-8000-000000009109',
  ledgerSafety: '018f0000-0000-7000-8000-000000009111',
  success: '018f0000-0000-7000-8000-000000009101',
} as const;
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'manifest-generation-integration-test',
});
const noOpMetrics: ManifestGenerationMetrics = {
  recordBacklog: () => undefined,
  recordDiagnostics: () => undefined,
  recordPromptCleanup: () => undefined,
  recordRetrieval: () => undefined,
  recordRun: () => undefined,
};

function applicationUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'worldgraph_app';
  url.password = 'worldgraph_app_local_only';
  return url.toString();
}

describe('PostgreSQL-authoritative manifest generation worker', () => {
  let app: ReturnType<typeof createDatabaseClient>;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'manifest-generation-owner-test');
    await applyMigrations(owner, migrationRoot);
    await importStarterPrimitives(owner.pool);
    await owner.pool.query(
      `insert into users(id, email, password_hash, display_name)
       values ($1,'generation-worker@example.test',$2,'Generation Worker')`,
      [creatorId, passwordHash],
    );
    for (const [key, worldId] of Object.entries(worlds)) {
      const connection = await owner.pool.connect();
      try {
        await connection.query('begin');
        await connection.query(
          `insert into worlds(id, slug, name, created_by_user_id)
           values ($1,$2,$3,$4)`,
          [worldId, `generation-${key.toLowerCase()}`, `Generation ${key}`, creatorId],
        );
        await connection.query(
          `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
           values ($1,$2,'creator',$2)`,
          [worldId, creatorId],
        );
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    }
    app = createDatabaseClient(
      applicationUrl(container.getConnectionUri()),
      'manifest-generation-app-test',
    );
  }, 120_000);

  afterAll(async () => {
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
  });

  async function enqueue(input: {
    expectedParentContentHash?: string;
    parentRevisionId?: string;
    promptId: string;
    runId: string;
    worldId: string;
    providerId?: string;
  }): Promise<void> {
    const configurationId = input.providerId ?? providerConfigurationId;
    await owner.pool.query(
      `insert into world_prompt_submissions(
         id, world_id, submitted_by_user_id, prompt_text, normalized_hash,
         client_seed, retention_until
       ) values ($1,$2,$3,$4,decode($5,'hex'),$6,clock_timestamp() + interval '30 days')`,
      [input.promptId, input.worldId, creatorId, prompt, sha256(prompt), seed],
    );
    await owner.pool.query(
      `insert into manifest_generation_runs(
         id, world_id, prompt_submission_id, requested_by_user_id,
         generator_schema_version, prompt_template_version, provider_configuration_id,
         parent_revision_id, expected_parent_content_hash, seed, input_hash
       ) values ($1,$2,$3,$4,1,1,$5,$6,
          case when $7::text is null then null else decode($7,'hex') end,
          $8,decode($9,'hex'))`,
      [
        input.runId,
        input.worldId,
        input.promptId,
        creatorId,
        configurationId,
        input.parentRevisionId ?? null,
        input.expectedParentContentHash ?? null,
        seed,
        manifestGenerationRequestHash({
          expectedParentContentHash: input.expectedParentContentHash ?? null,
          parentRevisionId: input.parentRevisionId ?? null,
          prompt,
          providerConfigurationId: configurationId,
          seed,
        }),
      ],
    );
  }

  function repository(): PostgresManifestGenerationRepository {
    return new PostgresManifestGenerationRepository(app.pool, 0, 0);
  }

  it('atomically publishes one validated fallback revision, report, and field provenance set', async () => {
    const runId = '018f0000-0000-7000-8000-000000009301';
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009201',
      runId,
      worldId: worlds.success,
    });
    const outputIds = [
      '018f0000-0000-7000-8000-000000009401',
      '018f0000-0000-7000-8000-000000009501',
      '018f0000-0000-7000-8000-000000009601',
      '018f0000-0000-7000-8000-000000009701',
      '018f0000-0000-7000-8000-000000009402',
    ];
    let idIndex = 0;
    const runner = new ManifestGenerationRunner(
      repository(),
      createManifestGenerationEngine(createDisabledManifestGenerationProvider()),
      providerConfigurationId,
      logger,
      {
        ids: { next: () => outputIds[idIndex++]! },
        metrics: noOpMetrics,
      },
    );

    await expect(runner.runOne()).resolves.toMatchObject({
      outcome: 'succeeded',
      revisionId: outputIds[2],
    });
    await expect(runner.runOne()).resolves.toMatchObject({ job: null, outcome: 'idle' });

    const state = await owner.pool.query<{
      catalog_hash: string | null;
      generation_mode: string | null;
      output_revision_id: string | null;
      resolved_hash: string | null;
      stage: string;
      status: string;
    }>(
      `select status, stage, generation_mode, output_revision_id,
              encode(primitive_catalog_snapshot_hash,'hex') as catalog_hash,
              encode(resolved_input_hash,'hex') as resolved_hash
         from manifest_generation_runs where id = $1`,
      [runId],
    );
    expect(state.rows[0]).toMatchObject({
      generation_mode: 'fallback',
      output_revision_id: outputIds[2],
      stage: 'complete',
      status: 'succeeded',
    });
    expect(state.rows[0]?.catalog_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(state.rows[0]?.resolved_hash).toMatch(/^[a-f0-9]{64}$/u);
    const outputs = await owner.pool.query<{
      provenance_count: string;
      report_count: string;
      revision_count: string;
    }>(
      `select
         (select count(*)::text from manifest_revisions where generation_run_id = $1)
           as revision_count,
         (select count(*)::text from manifest_validation_reports report
           join manifest_revisions revision on revision.id = report.manifest_revision_id
          where revision.generation_run_id = $1) as report_count,
         (select count(*)::text from manifest_field_provenance provenance
           join manifest_revisions revision on revision.id = provenance.manifest_revision_id
          where revision.generation_run_id = $1) as provenance_count`,
      [runId],
    );
    expect(outputs.rows[0]).toMatchObject({ report_count: '1', revision_count: '1' });
    expect(Number(outputs.rows[0]?.provenance_count)).toBeGreaterThan(300);
    const reviewEvidence = await owner.pool.query<{
      diagnostics: { code: string; severity: string }[];
      pointers: string[];
    }>(
      `select report.diagnostics,
              array_agg(provenance.json_pointer order by provenance.json_pointer) as pointers
         from manifest_validation_reports report
         join manifest_revisions revision on revision.id = report.manifest_revision_id
         join manifest_field_provenance provenance
           on provenance.manifest_revision_id = revision.id
        where revision.generation_run_id = $1
        group by report.id`,
      [runId],
    );
    expect(reviewEvidence.rows[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FALLBACK_TEMPLATE_USED', severity: 'warning' }),
        expect.objectContaining({
          code: 'HIGH_IMPACT_RULES_REQUIRE_REVIEW',
          severity: 'warning',
        }),
      ]),
    );
    expect(reviewEvidence.rows[0]?.pointers).toEqual(
      expect.arrayContaining([
        '/actors/0/name',
        '/districts/0/name',
        '/institutions/0/name',
        '/organizations/0/name',
        '/relationships/0/type',
      ]),
    );
  });

  it('serializes world claims while allowing distinct worlds to progress concurrently', async () => {
    const configurationId = 'concurrency-v1';
    const parentHash = 'ab'.repeat(32);
    const parents = {
      [worlds.concurrencyA]: '018f0000-0000-7000-8000-000000009111',
      [worlds.concurrencyB]: '018f0000-0000-7000-8000-000000009112',
    };
    for (const [worldId, revisionId] of Object.entries(parents)) {
      await owner.pool.query(
        `insert into manifest_revisions(
           id,world_id,revision_number,manifest_schema_version,canonical_manifest,
           content_hash,source,created_by_user_id
         ) values ($1,$2,1,1,'{}'::jsonb,decode($3,'hex'),'manual',$4)`,
        [revisionId, worldId, parentHash, creatorId],
      );
    }
    await enqueue({
      expectedParentContentHash: parentHash,
      parentRevisionId: parents[worlds.concurrencyA],
      promptId: '018f0000-0000-7000-8000-000000009211',
      providerId: configurationId,
      runId: '018f0000-0000-7000-8000-000000009311',
      worldId: worlds.concurrencyA,
    });
    await enqueue({
      expectedParentContentHash: parentHash,
      parentRevisionId: parents[worlds.concurrencyA],
      promptId: '018f0000-0000-7000-8000-000000009212',
      providerId: configurationId,
      runId: '018f0000-0000-7000-8000-000000009312',
      worldId: worlds.concurrencyA,
    });
    await enqueue({
      expectedParentContentHash: parentHash,
      parentRevisionId: parents[worlds.concurrencyB],
      promptId: '018f0000-0000-7000-8000-000000009213',
      providerId: configurationId,
      runId: '018f0000-0000-7000-8000-000000009313',
      worldId: worlds.concurrencyB,
    });
    const firstRepository = repository();
    const secondRepository = repository();
    const [first, second] = await Promise.all([
      firstRepository.claimNext(configurationId, '018f0000-0000-7000-8000-000000009411', 1),
      secondRepository.claimNext(configurationId, '018f0000-0000-7000-8000-000000009412', 1),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.worldId).not.toBe(second?.worldId);
    await expect(
      repository().claimNext(configurationId, '018f0000-0000-7000-8000-000000009413', 1),
    ).resolves.toBeNull();

    await firstRepository.markFailure(first!, 'WORKER_EXECUTION_FAILED', false);
    await secondRepository.markFailure(second!, 'WORKER_EXECUTION_FAILED', false);
    const remaining = await repository().claimNext(
      configurationId,
      '018f0000-0000-7000-8000-000000009414',
      1,
    );
    expect(remaining?.worldId).toBe(worlds.concurrencyA);
    await repository().markFailure(remaining!, 'WORKER_EXECUTION_FAILED', false);
  });

  it('recovers an expired lease, reuses frozen retrieval, and rejects stale-token mutations', async () => {
    const configurationId = 'recovery-v1';
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009221',
      providerId: configurationId,
      runId: '018f0000-0000-7000-8000-000000009321',
      worldId: worlds.recovery,
    });
    const runRepository = repository();
    const stale = await runRepository.claimNext(
      configurationId,
      '018f0000-0000-7000-8000-000000009421',
      1,
    );
    expect(stale?.attempts).toBe(1);
    await runRepository.updateStage(stale!, 'retrieval', 20);
    const initialCatalog = await runRepository.freezeCatalog(stale!, prompt);
    expect(initialCatalog).not.toBeNull();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await expect(runRepository.recoverExpiredClaims(1)).resolves.toEqual({ failed: 0, retried: 1 });

    const current = await runRepository.claimNext(
      configurationId,
      '018f0000-0000-7000-8000-000000009422',
      1,
    );
    expect(current?.attempts).toBe(2);
    const recoveredCatalog = await runRepository.freezeCatalog(current!, prompt);
    expect(recoveredCatalog).toEqual(initialCatalog);
    await expect(runRepository.markFailure(stale!, 'WORKER_EXECUTION_FAILED', false)).resolves.toBe(
      'lost_claim',
    );
    await expect(runRepository.heartbeat(stale!)).resolves.toBe(false);
    await expect(
      runRepository.markFailure(current!, 'WORKER_EXECUTION_FAILED', true),
    ).resolves.toBe('retry_scheduled');
    const final = await runRepository.claimNext(
      configurationId,
      '018f0000-0000-7000-8000-000000009423',
      1,
    );
    expect(final?.attempts).toBe(3);
    await expect(runRepository.markFailure(final!, 'WORKER_EXECUTION_FAILED', true)).resolves.toBe(
      'failed',
    );
  });

  it('serializes UTC-day budget reservations, releases capacity, and rejects unsafe settlement', async () => {
    const configurationId = 'budget-v1';
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009251',
      providerId: configurationId,
      runId: '018f0000-0000-7000-8000-000000009351',
      worldId: worlds.budgetA,
    });
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009252',
      providerId: configurationId,
      runId: '018f0000-0000-7000-8000-000000009352',
      worldId: worlds.budgetB,
    });
    const firstRepository = repository();
    const secondRepository = repository();
    const first = await firstRepository.claimNext(
      configurationId,
      '018f0000-0000-7000-8000-000000009451',
      1,
    );
    const second = await secondRepository.claimNext(
      configurationId,
      '018f0000-0000-7000-8000-000000009452',
      1,
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const request = {
      kind: 'generate' as const,
      maxCostMicrounits: 80,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      model: 'budget-model-v1',
      provider: 'budget-provider',
      providerConfigurationId: configurationId,
    };
    const reservations = await Promise.all([
      firstRepository.reserveProviderCall(
        first!,
        '018f0000-0000-7000-8000-000000009551',
        100,
        request,
      ),
      secondRepository.reserveProviderCall(
        second!,
        '018f0000-0000-7000-8000-000000009552',
        100,
        request,
      ),
    ]);
    expect(reservations.map((entry) => entry?.maxCostMicrounits).sort((a, b) => a! - b!)).toEqual([
      20, 80,
    ]);
    const largeIndex = reservations[0]!.maxCostMicrounits === 80 ? 0 : 1;
    const smallIndex = 1 - largeIndex;
    const jobs = [first!, second!];
    const repositories = [firstRepository, secondRepository];
    await expect(
      repositories[largeIndex]!.settleProviderCall(jobs[largeIndex]!, reservations[largeIndex]!, {
        costMicrounits: 60,
        inputTokens: 10,
        outputTokens: 20,
      }),
    ).resolves.toBe(true);
    await expect(
      repositories[smallIndex]!.releaseProviderCall(jobs[smallIndex]!, reservations[smallIndex]!),
    ).resolves.toBe(true);
    const replacement = await repositories[smallIndex]!.reserveProviderCall(
      jobs[smallIndex]!,
      '018f0000-0000-7000-8000-000000009553',
      100,
      { ...request, maxCostMicrounits: 50 },
    );
    expect(replacement?.maxCostMicrounits).toBe(40);
    await expect(
      repositories[smallIndex]!.settleProviderCall(jobs[smallIndex]!, replacement!, {
        costMicrounits: 41,
        inputTokens: 10,
        outputTokens: 20,
      }),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      repositories[smallIndex]!.settleProviderCall(jobs[smallIndex]!, replacement!, {
        costMicrounits: 40,
        inputTokens: 10,
        outputTokens: 20,
      }),
    ).resolves.toBe(true);

    const unknown = await repositories[largeIndex]!.reserveProviderCall(
      jobs[largeIndex]!,
      '018f0000-0000-7000-8000-000000009554',
      100,
      { ...request, maxCostMicrounits: 0 },
    );
    expect(unknown?.maxCostMicrounits).toBe(0);
    await repositories[largeIndex]!.markFailure(
      jobs[largeIndex]!,
      'WORKER_EXECUTION_FAILED',
      false,
    );
    await expect(
      repositories[largeIndex]!.settleProviderCall(jobs[largeIndex]!, unknown!, {
        costMicrounits: 0,
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).rejects.toMatchObject({ code: '40001' });
    await repositories[smallIndex]!.markFailure(
      jobs[smallIndex]!,
      'WORKER_EXECUTION_FAILED',
      false,
    );

    const budget = await owner.pool.query<{
      effective_cost: string;
      usage_dates: string;
    }>(
      `select coalesce(sum(case
          when status = 'settled' then actual_cost_microunits
          when status = 'reserved' then reserved_cost_microunits else 0 end),0)::text
          as effective_cost,
        count(distinct usage_date)::text as usage_dates
       from manifest_provider_calls`,
    );
    expect(budget.rows[0]).toEqual({ effective_cost: '100', usage_dates: '1' });
  });

  it('caps repair provider calls at two durable non-released entries across races and retries', async () => {
    const configurationId = 'repair-cap-v1';
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009263',
      providerId: configurationId,
      runId: '018f0000-0000-7000-8000-000000009363',
      worldId: worlds.repairCap,
    });
    const firstRepository = repository();
    const first = await firstRepository.claimNext(
      configurationId,
      '018f0000-0000-7000-8000-000000009463',
      1,
    );
    expect(first).not.toBeNull();
    await expect(firstRepository.updateStage(first!, 'repair', 65)).resolves.toBe(true);
    const request = {
      kind: 'repair' as const,
      maxCostMicrounits: 0,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      model: 'repair-cap-model-v1',
      provider: 'repair-cap-provider',
      providerConfigurationId: configurationId,
    };
    const raced = await Promise.all(
      [
        '018f0000-0000-7000-8000-000000009563',
        '018f0000-0000-7000-8000-000000009564',
        '018f0000-0000-7000-8000-000000009565',
      ].map((id) => firstRepository.reserveProviderCall(first!, id, 0, request)),
    );
    const admitted = raced.filter((reservation) => reservation !== null);
    expect(admitted).toHaveLength(2);
    for (const reservation of admitted) {
      await expect(
        firstRepository.settleProviderCall(first!, reservation, {
          costMicrounits: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
      ).resolves.toBe(true);
    }
    await expect(
      firstRepository.markFailure(first!, 'WORKER_EXECUTION_FAILED', true),
    ).resolves.toBe('retry_scheduled');
    const retryRepository = repository();
    const retry = await retryRepository.claimNext(
      configurationId,
      '018f0000-0000-7000-8000-000000009464',
      1,
    );
    expect(retry).not.toBeNull();
    await expect(
      retryRepository.reserveProviderCall(
        retry!,
        '018f0000-0000-7000-8000-000000009566',
        0,
        request,
      ),
    ).resolves.toBeNull();
    const state = await owner.pool.query<{
      provider_call_count: number;
      repair_calls: string;
      repair_attempts: number;
    }>(
      `select run.provider_call_count, run.repair_attempts,
              count(call.id) filter (
                where call.call_kind = 'repair' and call.status <> 'released'
              )::text as repair_calls
         from manifest_generation_runs run
         left join manifest_provider_calls call on call.run_id = run.id
        where run.id = $1
        group by run.id`,
      [retry!.runId],
    );
    expect(state.rows[0]).toEqual({
      provider_call_count: 2,
      repair_attempts: 1,
      repair_calls: '2',
    });
    await retryRepository.markFailure(retry!, 'WORKER_EXECUTION_FAILED', false);
  });

  it('rejects disabled-config reservations and provider success without a settled ledger call', async () => {
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009264',
      runId: '018f0000-0000-7000-8000-000000009364',
      worldId: worlds.ledgerSafety,
    });
    const disabledRepository = repository();
    const disabled = await disabledRepository.claimNext(
      providerConfigurationId,
      '018f0000-0000-7000-8000-000000009465',
      1,
    );
    expect(disabled).not.toBeNull();
    await expect(
      disabledRepository.reserveProviderCall(
        disabled!,
        '018f0000-0000-7000-8000-000000009567',
        100,
        {
          kind: 'generate',
          maxCostMicrounits: 100,
          maxInputTokens: 100,
          maxOutputTokens: 100,
          model: 'disabled',
          provider: 'disabled',
          providerConfigurationId,
        },
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await disabledRepository.markFailure(disabled!, 'WORKER_EXECUTION_FAILED', false);

    const paidConfigurationId = 'ledger-provider-v1';
    const runId = '018f0000-0000-7000-8000-000000009365';
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009265',
      providerId: paidConfigurationId,
      runId,
      worldId: worlds.ledgerSafety,
    });
    const paidRepository = repository();
    const paid = await paidRepository.claimNext(
      paidConfigurationId,
      '018f0000-0000-7000-8000-000000009466',
      1,
    );
    expect(paid).not.toBeNull();
    const frozen = await paidRepository.freezeCatalog(paid!, prompt);
    expect(frozen).not.toBeNull();
    const fallback = createDeterministicFallback({
      catalog: frozen!.catalog,
      prompt,
      providerConfigurationId: paidConfigurationId,
      seed,
    });
    const revisionId = '018f0000-0000-7000-8000-000000009568';
    const forgeProviderSuccess = async (): Promise<void> => {
      const connection = await app.pool.connect();
      try {
        await connection.query('begin');
        await connection.query(
          `insert into manifest_revisions(
             id,world_id,revision_number,manifest_schema_version,canonical_manifest,
             content_hash,source,generation_run_id,generation_claim_token,created_by_user_id,
             generation_warnings
           ) values ($1,$2,1,1,$3,decode($4,'hex'),'generation',$5,$6,$7,$8)`,
          [
            revisionId,
            worlds.ledgerSafety,
            JSON.stringify(fallback.envelope.manifest),
            fallback.contentHash,
            runId,
            paid!.claimToken,
            creatorId,
            JSON.stringify(fallback.envelope.warnings),
          ],
        );
        await connection.query(
          `update manifest_generation_runs
              set status = 'succeeded', stage = 'complete', progress_percent = 100,
                  generation_mode = 'provider', provider = 'ledger-provider',
                  model = 'ledger-model-v1', output_review = $2,
                  output_revision_id = $3, input_token_count = 0,
                  output_token_count = 0, cost_estimate_microunits = 0,
                  claim_token = null, completed_at = clock_timestamp(),
                  updated_at = clock_timestamp(), row_version = row_version + 1
            where id = $1 and claim_token = $4`,
          [
            runId,
            JSON.stringify({
              assumptions: fallback.envelope.assumptions,
              suggestedFixes: fallback.envelope.suggestedFixes,
              unresolvedQuestions: fallback.envelope.unresolvedQuestions,
              warnings: fallback.envelope.warnings,
            }),
            revisionId,
            paid!.claimToken,
          ],
        );
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    };
    await expect(forgeProviderSuccess()).rejects.toMatchObject({ code: '55000' });
    const durable = await owner.pool.query<{ calls: string; revisions: string; status: string }>(
      `select run.status, count(distinct call.id)::text as calls,
              count(distinct revision.id)::text as revisions
         from manifest_generation_runs run
         left join manifest_provider_calls call on call.run_id = run.id
         left join manifest_revisions revision on revision.generation_run_id = run.id
        where run.id = $1 group by run.id`,
      [runId],
    );
    expect(durable.rows[0]).toEqual({ calls: '0', revisions: '0', status: 'running' });
    await paidRepository.markFailure(paid!, 'WORKER_EXECUTION_FAILED', false);
  });

  it('retains settled spend and the two-repair ceiling across publication failure and retry', async () => {
    const configurationId = 'durable-provider-v1';
    const providerRequests: ManifestProviderRequest[] = [];
    const provider: ManifestGenerationProvider = {
      configuration: {
        configurationId,
        enabled: true,
        model: 'durable-model-v1',
        modelCapabilities: { network: false, tools: false },
        provider: 'durable-provider',
      },
      async generate(request) {
        providerRequests.push(request);
        const generated = createDeterministicFallback({
          catalog: request.catalog,
          prompt: request.normalizedPrompt,
          providerConfigurationId: configurationId,
          seed: request.seed,
        });
        const envelope = {
          ...generated.envelope,
          provenance: [
            {
              pointer: '',
              sourceHash: 'b'.repeat(64),
              sourceRef: 'untrusted-provider-provenance',
              sourceType: 'model' as const,
            },
          ],
          warnings: [],
        };
        return {
          costMicrounits: 10,
          inputTokens: 100,
          model: 'durable-model-v1',
          output: JSON.stringify(
            request.kind === 'generate'
              ? { ...envelope, tool: { secret: 'must-not-persist' } }
              : envelope,
          ),
          outputTokens: 200,
          provider: 'durable-provider',
        };
      },
    };
    const runId = '018f0000-0000-7000-8000-000000009361';
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009261',
      providerId: configurationId,
      runId,
      worldId: worlds.retryAccounting,
    });
    const postgres = repository();
    let rejectFirstPublication = true;
    const publish = postgres.publish.bind(postgres);
    const observedUsage: Array<Awaited<ReturnType<typeof postgres.loadProviderUsage>>> = [];
    const durableRepository = new Proxy(postgres, {
      get(target, property, receiver) {
        if (property === 'publish') {
          return async (...args: Parameters<ManifestGenerationRepository['publish']>) => {
            if (rejectFirstPublication) {
              rejectFirstPublication = false;
              throw new Error('private publication failure detail');
            }
            return publish(...args);
          };
        }
        if (property === 'loadProviderUsage') {
          return async (...args: Parameters<ManifestGenerationRepository['loadProviderUsage']>) => {
            const usage = await target.loadProviderUsage(...args);
            observedUsage.push(usage);
            return usage;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value.bind(target) as unknown) : value;
      },
    }) as ManifestGenerationRepository;
    let idSequence = 9_801;
    const runner = new ManifestGenerationRunner(
      durableRepository,
      createManifestGenerationEngine(provider, {
        policy: {
          maxCostMicrounits: 2_000,
          maxCostMicrounitsPerCall: 50,
          maxInputTokens: 10_000,
          maxInputTokensPerCall: 1_000,
          maxOutputTokens: 1_000,
          maxTransientRetries: 0,
        },
      }),
      configurationId,
      logger,
      {
        dailyBudgetMicrounits: 2_000,
        ids: {
          next: () => `018f0000-0000-7000-8000-${String(idSequence++).padStart(12, '0')}`,
        },
        metrics: noOpMetrics,
      },
    );

    await expect(runner.runOne()).resolves.toMatchObject({ outcome: 'retry_scheduled' });
    const afterFailure = await owner.pool.query<{
      cost: string;
      provider_call_count: number;
      repair_attempts: number;
      status: string;
    }>(
      `select status, provider_call_count, repair_attempts,
              cost_estimate_microunits::text as cost
         from manifest_generation_runs where id = $1`,
      [runId],
    );
    expect(afterFailure.rows[0]).toEqual({
      cost: '20',
      provider_call_count: 2,
      repair_attempts: 1,
      status: 'queued',
    });

    await expect(runner.runOne()).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(observedUsage[1]).toEqual({
      costMicrounits: 20,
      inputTokens: 200,
      outputTokens: 400,
      providerCalls: 2,
      repairAttempts: 1,
    });
    expect(providerRequests.map((request) => request.kind)).toEqual([
      'generate',
      'repair',
      'generate',
      'repair',
    ]);
    const completed = await owner.pool.query<{
      attempts: number;
      cost: string;
      input_tokens: number;
      output_tokens: number;
      provider_call_count: number;
      repair_attempts: number;
      status: string;
    }>(
      `select status, attempts, provider_call_count, repair_attempts,
              input_token_count as input_tokens, output_token_count as output_tokens,
              cost_estimate_microunits::text as cost
         from manifest_generation_runs where id = $1`,
      [runId],
    );
    expect(completed.rows[0]).toEqual({
      attempts: 2,
      cost: '40',
      input_tokens: 400,
      output_tokens: 800,
      provider_call_count: 4,
      repair_attempts: 2,
      status: 'succeeded',
    });
    const accounting = await owner.pool.query<{
      calls: string;
      settled_cost: string;
    }>(
      `select count(*)::text as calls,
              sum(actual_cost_microunits)::text as settled_cost
         from manifest_provider_calls where run_id = $1 and status = 'settled'`,
      [runId],
    );
    expect(accounting.rows[0]).toEqual({ calls: '4', settled_cost: '40' });
    expect(JSON.stringify(completed.rows[0])).not.toContain('must-not-persist');
  });

  it('cannot publish after cancellation invalidates the active claim', async () => {
    const runId = '018f0000-0000-7000-8000-000000009331';
    await enqueue({
      promptId: '018f0000-0000-7000-8000-000000009231',
      runId,
      worldId: worlds.cancellation,
    });
    const runRepository = repository();
    const job = await runRepository.claimNext(
      providerConfigurationId,
      '018f0000-0000-7000-8000-000000009431',
      1,
    );
    expect(job).not.toBeNull();
    await runRepository.updateStage(job!, 'retrieval', 20);
    const frozen = await runRepository.freezeCatalog(job!, prompt);
    expect(frozen).not.toBeNull();
    const claimed = { ...job!, resolvedInputHash: frozen!.resolvedInputHash };
    const outcome = await createManifestGenerationEngine(
      createDisabledManifestGenerationProvider(),
    ).generate(
      {
        catalog: frozen!.catalog,
        expectedParentContentHash: null,
        parentRevisionId: null,
        prompt,
        seed,
      },
      new AbortController().signal,
    );
    const validation = validateManifestGenerationEnvelope(outcome.envelope, frozen!.catalog);
    await app.pool.query(
      `update manifest_generation_runs
          set status = 'cancelled', claim_token = null, completed_at = clock_timestamp(),
              updated_at = clock_timestamp(), row_version = row_version + 1
        where id = $1 and claim_token = $2`,
      [runId, job!.claimToken],
    );

    await expect(
      runRepository.publish(claimed, {
        catalog: frozen!.catalog,
        ids: {
          reportId: '018f0000-0000-7000-8000-000000009531',
          revisionId: '018f0000-0000-7000-8000-000000009532',
        },
        outcome,
        validation,
      }),
    ).resolves.toBeNull();
    const revisionCount = await owner.pool.query<{ count: string }>(
      'select count(*)::text as count from manifest_revisions where generation_run_id = $1',
      [runId],
    );
    expect(revisionCount.rows[0]?.count).toBe('0');
  });

  it('redacts expired prompt text only when no queued or running generation still needs it', async () => {
    const redactablePromptId = '018f0000-0000-7000-8000-000000009241';
    const activePromptId = '018f0000-0000-7000-8000-000000009242';
    for (const promptId of [redactablePromptId, activePromptId]) {
      await owner.pool.query(
        `insert into world_prompt_submissions(
           id, world_id, submitted_by_user_id, prompt_text, normalized_hash,
           client_seed, created_at, retention_until
         ) values (
           $1,$2,$3,$4,decode($5,'hex'),$6,
           clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'
         )`,
        [promptId, worlds.cleanup, creatorId, prompt, sha256(prompt), seed],
      );
    }
    await owner.pool.query(
      `insert into manifest_generation_runs(
         id, world_id, prompt_submission_id, requested_by_user_id,
         generator_schema_version, prompt_template_version, provider_configuration_id,
         parent_revision_id, expected_parent_content_hash, seed, input_hash
       ) values ($1,$2,$3,$4,1,1,$5,null,null,$6,decode($7,'hex'))`,
      [
        '018f0000-0000-7000-8000-000000009341',
        worlds.cleanup,
        activePromptId,
        creatorId,
        'cleanup-v1',
        seed,
        manifestGenerationRequestHash({
          expectedParentContentHash: null,
          parentRevisionId: null,
          prompt,
          providerConfigurationId: 'cleanup-v1',
          seed,
        }),
      ],
    );

    await expect(repository().cleanupExpiredPrompts(100)).resolves.toBe(1);
    const prompts = await owner.pool.query<{
      id: string;
      prompt_text: string | null;
      redacted_at: Date | null;
    }>(
      `select id, prompt_text, redacted_at from world_prompt_submissions
        where id = any($1::uuid[]) order by id`,
      [[redactablePromptId, activePromptId]],
    );
    expect(prompts.rows[0]).toMatchObject({ id: redactablePromptId, prompt_text: null });
    expect(prompts.rows[0]?.redacted_at).toBeInstanceOf(Date);
    expect(prompts.rows[1]).toEqual({ id: activePromptId, prompt_text: prompt, redacted_at: null });
  });
});
