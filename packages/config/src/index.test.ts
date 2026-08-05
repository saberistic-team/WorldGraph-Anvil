import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadRuntimeConfig } from './index.js';

const baseEnv: NodeJS.ProcessEnv = {
  ALLOWED_ORIGINS: 'http://localhost:3000',
  AUTH_PEPPER: 'test-only-auth-pepper-32-characters-long',
  DATABASE_URL: 'postgres://app:secret@localhost/worldgraph',
  NODE_ENV: 'test',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('runtime configuration', () => {
  it('parses bounded defaults', () => {
    const config = loadRuntimeConfig(baseEnv);
    expect(config.apiPort).toBe(4000);
    expect(config.enableOperationalSmoke).toBe(false);
    expect(config.enableLocalRegistration).toBe(true);
    expect(config.allowedOrigins).toEqual(['http://localhost:3000']);
    expect(config.primitiveSemanticProfile).toBe('disabled');
    expect(config.primitiveSemanticContributionEnabled).toBe(false);
    expect(config.primitiveEmbeddingProviderTimeoutMs).toBe(3_000);
    expect(config.primitiveEmbeddingCostBudgetMicrounits).toBe(0);
    expect(config.primitiveIndexMaxJobsPerReconciliation).toBe(25);
    expect(config.primitiveIndexReconciliationIntervalMs).toBe(5_000);
    expect(config).toMatchObject({
      compilerEnabled: true,
      compilerMaxEntities: 2_000,
      compilerMaxRelationships: 8_000,
      commerceScheduleBatchSize: 25,
      commerceScheduleEnabled: true,
      commerceScheduleReconciliationIntervalMs: 1_000,
      economyDebitsFrozen: false,
      economyDisabledTaxPolicyIds: [],
      economyIssuanceEnabled: true,
      economyIssuanceRateLimitPerHour: 3,
      economyJobsEnabled: true,
      economyListingRateLimitPerMinute: 10,
      economyListingsEnabled: true,
      economyOfferRateLimitPerMinute: 10,
      economyOfferReconciliationBatchSize: 25,
      economyOfferReconciliationIntervalMs: 1_000,
      economyOffersEnabled: true,
      economyProductionEnabled: true,
      economyProductionRateLimitPerMinute: 10,
      economyPurchaseRateLimitPerMinute: 20,
      economyPurchasesEnabled: true,
      economyTransferRateLimitPerMinute: 20,
      economyTransfersEnabled: true,
      economyWorkRateLimitPerMinute: 10,
      governanceContestRateLimitPerHour: 6,
      governanceContestsEnabled: true,
      governanceEnactmentEnabled: true,
      governanceNominationRateLimitPerMinute: 10,
      governanceOverridesEnabled: true,
      governanceScheduleBatchSize: 25,
      governanceScheduleEnabled: true,
      governanceScheduleReconciliationIntervalMs: 1_000,
      governanceSponsorRateLimitPerMinute: 20,
      governanceTwoPersonControlEnabled: false,
      governanceVoteRateLimitPerMinute: 30,
      governanceVotingEnabled: true,
      manifestGenerationDailyBudgetMicrounits: 0,
      manifestGenerationEnabled: true,
      manifestGenerationMaxConcurrentPerUser: 2,
      manifestGenerationMaxConcurrentPerWorld: 1,
      manifestGenerationOutputTokenLimit: 4_096,
      manifestGenerationProvider: 'disabled',
      manifestGenerationProviderTimeoutMs: 8_000,
      manifestGenerationReconciliationIntervalMs: 2_000,
      manifestPromptRetentionDays: 30,
      outboxBatchSize: 25,
      outboxLeaseMs: 30_000,
      outboxMaximumAttempts: 10,
      outboxReconciliationIntervalMs: 1_000,
      simulationContinuousEnabled: true,
      simulationLeaseMs: 30_000,
      simulationMaximumAttempts: 3,
      simulationMaximumBackoffMs: 5_000,
      simulationMaximumWorldsPerRun: 25,
      simulationReconciliationIntervalMs: 1_000,
      simulationRetryBaseMs: 250,
      worldCompilationReconciliationIntervalMs: 2_000,
    });
  });

  it('parses independent governance safety and scheduler controls', () => {
    expect(
      loadRuntimeConfig({
        ...baseEnv,
        GOVERNANCE_CONTEST_RATE_LIMIT_PER_HOUR: '8',
        GOVERNANCE_CONTESTS_ENABLED: 'false',
        GOVERNANCE_ENACTMENT_ENABLED: 'false',
        GOVERNANCE_NOMINATION_RATE_LIMIT_PER_MINUTE: '12',
        GOVERNANCE_OVERRIDES_ENABLED: 'false',
        GOVERNANCE_SCHEDULE_BATCH_SIZE: '40',
        GOVERNANCE_SCHEDULE_ENABLED: 'false',
        GOVERNANCE_SCHEDULE_RECONCILIATION_INTERVAL_MS: '750',
        GOVERNANCE_SPONSOR_RATE_LIMIT_PER_MINUTE: '22',
        GOVERNANCE_TALLY_DATABASE_URL: 'postgres://tally:secret@localhost/worldgraph',
        GOVERNANCE_TWO_PERSON_CONTROL_ENABLED: 'true',
        GOVERNANCE_VOTE_RATE_LIMIT_PER_MINUTE: '32',
        GOVERNANCE_VOTING_ENABLED: 'false',
      }),
    ).toMatchObject({
      governanceContestRateLimitPerHour: 8,
      governanceContestsEnabled: false,
      governanceEnactmentEnabled: false,
      governanceNominationRateLimitPerMinute: 12,
      governanceOverridesEnabled: false,
      governanceScheduleBatchSize: 40,
      governanceScheduleEnabled: false,
      governanceScheduleReconciliationIntervalMs: 750,
      governanceSponsorRateLimitPerMinute: 22,
      governanceTallyDatabaseUrl: 'postgres://tally:secret@localhost/worldgraph',
      governanceTwoPersonControlEnabled: true,
      governanceVoteRateLimitPerMinute: 32,
      governanceVotingEnabled: false,
    });
  });

  it.each([
    [{ GOVERNANCE_CONTESTS_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ GOVERNANCE_ENACTMENT_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ GOVERNANCE_OVERRIDES_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ GOVERNANCE_VOTING_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ GOVERNANCE_TWO_PERSON_CONTROL_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ GOVERNANCE_CONTEST_RATE_LIMIT_PER_HOUR: '0' }, '1 to 1000'],
    [{ GOVERNANCE_NOMINATION_RATE_LIMIT_PER_MINUTE: '1001' }, '1 to 1000'],
    [{ GOVERNANCE_SPONSOR_RATE_LIMIT_PER_MINUTE: '0' }, '1 to 1000'],
    [{ GOVERNANCE_VOTE_RATE_LIMIT_PER_MINUTE: '1001' }, '1 to 1000'],
    [{ GOVERNANCE_SCHEDULE_BATCH_SIZE: '0' }, '1 to 250'],
    [{ GOVERNANCE_SCHEDULE_RECONCILIATION_INTERVAL_MS: '99' }, '100 to 60000'],
    [{ GOVERNANCE_TALLY_DATABASE_URL: 'redis://localhost/0' }, 'must use postgres: or postgresql:'],
  ])('fails closed for invalid governance configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it('parses bounded commerce scheduler bridge controls', () => {
    expect(
      loadRuntimeConfig({
        ...baseEnv,
        COMMERCE_SCHEDULE_BATCH_SIZE: '40',
        COMMERCE_SCHEDULE_ENABLED: 'false',
        COMMERCE_SCHEDULE_RECONCILIATION_INTERVAL_MS: '750',
      }),
    ).toMatchObject({
      commerceScheduleBatchSize: 40,
      commerceScheduleEnabled: false,
      commerceScheduleReconciliationIntervalMs: 750,
    });
  });

  it.each([
    [{ COMMERCE_SCHEDULE_BATCH_SIZE: '0' }, '1 to 250'],
    [{ COMMERCE_SCHEDULE_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ COMMERCE_SCHEDULE_RECONCILIATION_INTERVAL_MS: '99' }, '100 to 60000'],
  ])('fails closed for invalid commerce scheduler configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it('parses bounded closed-loop economy controls independently of simulation scheduling', () => {
    expect(
      loadRuntimeConfig({
        ...baseEnv,
        ECONOMY_DEBITS_FROZEN: 'true',
        ECONOMY_ISSUANCE_ENABLED: 'false',
        ECONOMY_ISSUANCE_RATE_LIMIT_PER_HOUR: '4',
        ECONOMY_OFFER_RATE_LIMIT_PER_MINUTE: '12',
        ECONOMY_OFFER_RECONCILIATION_BATCH_SIZE: '40',
        ECONOMY_OFFER_RECONCILIATION_INTERVAL_MS: '750',
        ECONOMY_OFFERS_ENABLED: 'false',
        ECONOMY_TRANSFER_RATE_LIMIT_PER_MINUTE: '30',
        ECONOMY_TRANSFERS_ENABLED: 'false',
      }),
    ).toMatchObject({
      economyDebitsFrozen: true,
      economyIssuanceEnabled: false,
      economyIssuanceRateLimitPerHour: 4,
      economyOfferRateLimitPerMinute: 12,
      economyOfferReconciliationBatchSize: 40,
      economyOfferReconciliationIntervalMs: 750,
      economyOffersEnabled: false,
      economyTransferRateLimitPerMinute: 30,
      economyTransfersEnabled: false,
    });
  });

  it('parses bounded productive-commerce controls', () => {
    expect(
      loadRuntimeConfig({
        ...baseEnv,
        ECONOMY_DISABLED_TAX_POLICY_IDS:
          '019C2222-2222-7222-8222-222222222222, 019c1111-1111-7111-8111-111111111111',
        ECONOMY_JOBS_ENABLED: 'false',
        ECONOMY_LISTINGS_ENABLED: 'false',
        ECONOMY_LISTING_RATE_LIMIT_PER_MINUTE: '14',
        ECONOMY_PRODUCTION_ENABLED: 'false',
        ECONOMY_PRODUCTION_RATE_LIMIT_PER_MINUTE: '15',
        ECONOMY_PURCHASES_ENABLED: 'false',
        ECONOMY_PURCHASE_RATE_LIMIT_PER_MINUTE: '16',
        ECONOMY_WORK_RATE_LIMIT_PER_MINUTE: '17',
      }),
    ).toMatchObject({
      economyDisabledTaxPolicyIds: [
        '019c1111-1111-7111-8111-111111111111',
        '019c2222-2222-7222-8222-222222222222',
      ],
      economyJobsEnabled: false,
      economyListingRateLimitPerMinute: 14,
      economyListingsEnabled: false,
      economyProductionEnabled: false,
      economyProductionRateLimitPerMinute: 15,
      economyPurchaseRateLimitPerMinute: 16,
      economyPurchasesEnabled: false,
      economyWorkRateLimitPerMinute: 17,
    });
  });

  it.each([
    [{ ECONOMY_DISABLED_TAX_POLICY_IDS: 'not-a-uuid' }, 'at most 64 unique'],
    [
      {
        ECONOMY_DISABLED_TAX_POLICY_IDS:
          '019c1111-1111-7111-8111-111111111111,019c1111-1111-7111-8111-111111111111',
      },
      'at most 64 unique',
    ],
    [
      {
        ECONOMY_DISABLED_TAX_POLICY_IDS: Array.from(
          { length: 65 },
          (_, index) => `019c0000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
        ).join(','),
      },
      'at most 64 unique',
    ],
    [{ ECONOMY_JOBS_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ ECONOMY_LISTING_RATE_LIMIT_PER_MINUTE: '0' }, '1 to 1000'],
    [{ ECONOMY_PRODUCTION_RATE_LIMIT_PER_MINUTE: '1001' }, '1 to 1000'],
    [{ ECONOMY_PURCHASE_RATE_LIMIT_PER_MINUTE: '0' }, '1 to 1000'],
    [{ ECONOMY_WORK_RATE_LIMIT_PER_MINUTE: '1001' }, '1 to 1000'],
  ])('fails closed for invalid productive-commerce configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it.each([
    [{ ECONOMY_DEBITS_FROZEN: 'sometimes' }, 'must be true or false'],
    [{ ECONOMY_ISSUANCE_RATE_LIMIT_PER_HOUR: '0' }, '1 to 100'],
    [{ ECONOMY_OFFER_RATE_LIMIT_PER_MINUTE: '0' }, '1 to 1000'],
    [{ ECONOMY_OFFER_RECONCILIATION_BATCH_SIZE: '0' }, '1 to 250'],
    [{ ECONOMY_OFFER_RECONCILIATION_INTERVAL_MS: '99' }, '100 to 60000'],
    [{ ECONOMY_TRANSFER_RATE_LIMIT_PER_MINUTE: '1001' }, '1 to 1000'],
  ])('fails closed for invalid economy configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it('requires a long operations token when enabled', () => {
    expect(() =>
      loadRuntimeConfig({
        ...baseEnv,
        ENABLE_OPERATIONAL_SMOKE: 'true',
        OPERATIONS_TOKEN: 'short',
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects unsafe production defaults', () => {
    expect(() => loadRuntimeConfig({ ...baseEnv, NODE_ENV: 'production' })).toThrow(
      'Production refuses placeholder',
    );
    expect(() =>
      loadRuntimeConfig({
        ...baseEnv,
        AUTH_PEPPER: 'local-only-auth-pepper-change-before-production',
        BUILD_REVISION: 'release-2026-07-21',
        NODE_ENV: 'production',
      }),
    ).toThrow('Production refuses placeholder');
  });

  it('rejects wildcard origins', () => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ALLOWED_ORIGINS: '*' })).toThrow(
      'explicit origins',
    );
  });

  it('requires a strong pepper and consistent session lifetimes', () => {
    expect(() => loadRuntimeConfig({ ...baseEnv, AUTH_PEPPER: 'short' })).toThrow('AUTH_PEPPER');
    expect(() =>
      loadRuntimeConfig({
        ...baseEnv,
        SESSION_ABSOLUTE_TTL_SECONDS: '3600',
        SESSION_IDLE_TTL_SECONDS: '7200',
      }),
    ).toThrow('cannot exceed');
    expect(() => loadRuntimeConfig({ ...baseEnv, GOVERNANCE_STEP_UP_TTL_SECONDS: '901' })).toThrow(
      '30 to 900',
    );
    expect(loadRuntimeConfig(baseEnv).governanceStepUpTtlSeconds).toBe(300);
  });

  it('selects the local-only semantic profile with independently controlled contribution and bounded worker limits', () => {
    const config = loadRuntimeConfig({
      ...baseEnv,
      PRIMITIVE_EMBEDDING_COST_BUDGET_MICROUNITS: '0',
      PRIMITIVE_EMBEDDING_TIMEOUT_MS: '2500',
      PRIMITIVE_INDEX_MAX_JOBS_PER_RECONCILIATION: '12',
      PRIMITIVE_INDEX_RECONCILIATION_INTERVAL_MS: '6000',
      PRIMITIVE_SEMANTIC_CONTRIBUTION_ENABLED: 'true',
      PRIMITIVE_SEMANTIC_PROFILE: 'local_hash',
    });
    expect(config).toMatchObject({
      primitiveEmbeddingCostBudgetMicrounits: 0,
      primitiveEmbeddingProviderTimeoutMs: 2_500,
      primitiveIndexMaxJobsPerReconciliation: 12,
      primitiveIndexReconciliationIntervalMs: 6_000,
      primitiveSemanticContributionEnabled: true,
      primitiveSemanticProfile: 'local_hash',
    });
  });

  it.each([
    [{ PRIMITIVE_SEMANTIC_PROFILE: 'remote' }, 'must be disabled or local_hash'],
    [
      { PRIMITIVE_SEMANTIC_CONTRIBUTION_ENABLED: 'true' },
      'requires PRIMITIVE_SEMANTIC_PROFILE=local_hash',
    ],
    [{ PRIMITIVE_EMBEDDING_COST_BUDGET_MICROUNITS: '1' }, 'must be 0'],
    [{ PRIMITIVE_EMBEDDING_TIMEOUT_MS: '99' }, '100 to 10000'],
    [{ PRIMITIVE_INDEX_MAX_JOBS_PER_RECONCILIATION: '0' }, '1 to 250'],
    [{ PRIMITIVE_INDEX_RECONCILIATION_INTERVAL_MS: '100' }, '250 to 60000'],
  ])('fails closed for unsupported semantic configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it('parses bounded manifest generation fallback and retention controls', () => {
    expect(
      loadRuntimeConfig({
        ...baseEnv,
        MANIFEST_GENERATION_ENABLED: 'false',
        MANIFEST_GENERATION_MAX_CONCURRENT_PER_USER: '3',
        MANIFEST_GENERATION_MAX_CONCURRENT_PER_WORLD: '2',
        MANIFEST_GENERATION_OUTPUT_TOKEN_LIMIT: '2048',
        MANIFEST_GENERATION_PROVIDER_TIMEOUT_MS: '5000',
        MANIFEST_GENERATION_RECONCILIATION_INTERVAL_MS: '1500',
        MANIFEST_PROMPT_RETENTION_DAYS: '14',
      }),
    ).toMatchObject({
      manifestGenerationEnabled: false,
      manifestGenerationMaxConcurrentPerUser: 3,
      manifestGenerationMaxConcurrentPerWorld: 2,
      manifestGenerationOutputTokenLimit: 2_048,
      manifestGenerationProvider: 'disabled',
      manifestGenerationProviderTimeoutMs: 5_000,
      manifestGenerationReconciliationIntervalMs: 1_500,
      manifestPromptRetentionDays: 14,
    });
  });

  it.each([
    [{ MANIFEST_GENERATION_PROVIDER: 'remote' }, 'must be disabled'],
    [{ MANIFEST_GENERATION_DAILY_BUDGET_MICROUNITS: '1' }, 'must be 0'],
    [{ MANIFEST_GENERATION_MAX_CONCURRENT_PER_USER: '0' }, '1 to 10'],
    [{ MANIFEST_GENERATION_MAX_CONCURRENT_PER_WORLD: '0' }, '1 to 3'],
    [{ MANIFEST_GENERATION_OUTPUT_TOKEN_LIMIT: '511' }, '512 to 16384'],
    [{ MANIFEST_GENERATION_PROVIDER_TIMEOUT_MS: '499' }, '500 to 30000'],
    [{ MANIFEST_GENERATION_RECONCILIATION_INTERVAL_MS: '249' }, '250 to 60000'],
    [{ MANIFEST_PROMPT_RETENTION_DAYS: '0' }, '1 to 365'],
  ])('fails closed for unsupported manifest generation configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it('parses bounded transactional outbox controls', () => {
    expect(
      loadRuntimeConfig({
        ...baseEnv,
        OUTBOX_BATCH_SIZE: '40',
        OUTBOX_LEASE_MS: '45000',
        OUTBOX_MAXIMUM_ATTEMPTS: '12',
        OUTBOX_RECONCILIATION_INTERVAL_MS: '750',
      }),
    ).toMatchObject({
      outboxBatchSize: 40,
      outboxLeaseMs: 45_000,
      outboxMaximumAttempts: 12,
      outboxReconciliationIntervalMs: 750,
    });
  });

  it.each([
    [{ OUTBOX_BATCH_SIZE: '0' }, '1 to 250'],
    [{ OUTBOX_LEASE_MS: '999' }, '1000 to 300000'],
    [{ OUTBOX_MAXIMUM_ATTEMPTS: '101' }, '1 to 100'],
    [{ OUTBOX_RECONCILIATION_INTERVAL_MS: '249' }, '250 to 60000'],
  ])('fails closed for invalid outbox configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it('parses bounded deterministic simulation worker controls', () => {
    expect(
      loadRuntimeConfig({
        ...baseEnv,
        SIMULATION_CONTINUOUS_ENABLED: 'false',
        SIMULATION_LEASE_MS: '45000',
        SIMULATION_MAXIMUM_ATTEMPTS: '5',
        SIMULATION_MAXIMUM_BACKOFF_MS: '8000',
        SIMULATION_MAXIMUM_WORLDS_PER_RUN: '40',
        SIMULATION_RECONCILIATION_INTERVAL_MS: '750',
        SIMULATION_RETRY_BASE_MS: '500',
      }),
    ).toMatchObject({
      simulationContinuousEnabled: false,
      simulationLeaseMs: 45_000,
      simulationMaximumAttempts: 5,
      simulationMaximumBackoffMs: 8_000,
      simulationMaximumWorldsPerRun: 40,
      simulationReconciliationIntervalMs: 750,
      simulationRetryBaseMs: 500,
    });
  });

  it.each([
    [{ SIMULATION_CONTINUOUS_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ SIMULATION_LEASE_MS: '999' }, '1000 to 300000'],
    [{ SIMULATION_MAXIMUM_ATTEMPTS: '11' }, '1 to 10'],
    [{ SIMULATION_MAXIMUM_BACKOFF_MS: '99' }, '100 to 60000'],
    [{ SIMULATION_MAXIMUM_WORLDS_PER_RUN: '101' }, '1 to 100'],
    [{ SIMULATION_RECONCILIATION_INTERVAL_MS: '99' }, '100 to 60000'],
    [{ SIMULATION_RETRY_BASE_MS: '99' }, '100 to 60000'],
    [
      { SIMULATION_MAXIMUM_BACKOFF_MS: '500', SIMULATION_RETRY_BASE_MS: '501' },
      'cannot exceed SIMULATION_MAXIMUM_BACKOFF_MS',
    ],
  ])('fails closed for invalid simulation configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it('parses bounded deterministic compiler controls', () => {
    expect(
      loadRuntimeConfig({
        ...baseEnv,
        COMPILER_ENABLED: 'false',
        COMPILER_MAX_ENTITIES: '1200',
        COMPILER_MAX_RELATIONSHIPS: '4800',
        WORLD_COMPILATION_RECONCILIATION_INTERVAL_MS: '1500',
      }),
    ).toMatchObject({
      compilerEnabled: false,
      compilerMaxEntities: 1_200,
      compilerMaxRelationships: 4_800,
      worldCompilationReconciliationIntervalMs: 1_500,
    });
  });

  it.each([
    [{ COMPILER_ENABLED: 'sometimes' }, 'must be true or false'],
    [{ COMPILER_MAX_ENTITIES: '5001' }, '1 to 5000'],
    [{ COMPILER_MAX_RELATIONSHIPS: '10001' }, '1 to 10000'],
    [{ WORLD_COMPILATION_RECONCILIATION_INTERVAL_MS: '249' }, '250 to 60000'],
  ])('fails closed for invalid compiler configuration %#', (overrides, message) => {
    expect(() => loadRuntimeConfig({ ...baseEnv, ...overrides })).toThrow(message);
  });
});
