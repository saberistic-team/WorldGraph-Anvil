export type Environment = 'development' | 'production' | 'test';
export type ManifestGenerationProvider = 'disabled';
export type PrimitiveSemanticProfile = 'disabled' | 'local_hash';

export interface RuntimeConfig {
  allowedOrigins: string[];
  apiHost: string;
  apiPort: number;
  authPepper?: string;
  buildRevision: string;
  compilerEnabled: boolean;
  compilerMaxEntities: number;
  compilerMaxRelationships: number;
  commerceScheduleBatchSize?: number;
  commerceScheduleEnabled?: boolean;
  commerceScheduleReconciliationIntervalMs?: number;
  databaseUrl: string;
  dependencyTimeoutMs: number;
  economyDebitsFrozen: boolean;
  economyDisabledTaxPolicyIds?: string[];
  economyIssuanceEnabled: boolean;
  economyIssuanceRateLimitPerHour: number;
  economyJobsEnabled?: boolean;
  economyListingRateLimitPerMinute?: number;
  economyListingsEnabled?: boolean;
  economyOfferRateLimitPerMinute: number;
  economyOfferReconciliationBatchSize: number;
  economyOfferReconciliationIntervalMs: number;
  economyOffersEnabled: boolean;
  economyProductionEnabled?: boolean;
  economyProductionRateLimitPerMinute?: number;
  economyPurchaseRateLimitPerMinute?: number;
  economyPurchasesEnabled?: boolean;
  economyTransferRateLimitPerMinute: number;
  economyTransfersEnabled: boolean;
  economyWorkRateLimitPerMinute?: number;
  enableLocalRegistration: boolean;
  enableOperationalSmoke: boolean;
  environment: Environment;
  logLevel: 'debug' | 'error' | 'fatal' | 'info' | 'trace' | 'warn';
  manifestGenerationDailyBudgetMicrounits: number;
  manifestGenerationEnabled: boolean;
  manifestGenerationMaxConcurrentPerUser: number;
  manifestGenerationMaxConcurrentPerWorld: number;
  manifestGenerationOutputTokenLimit: number;
  manifestGenerationProvider: ManifestGenerationProvider;
  manifestGenerationProviderTimeoutMs: number;
  manifestGenerationReconciliationIntervalMs: number;
  manifestPromptRetentionDays: number;
  outboxBatchSize?: number;
  outboxLeaseMs?: number;
  outboxMaximumAttempts?: number;
  outboxReconciliationIntervalMs?: number;
  operationsToken?: string;
  otelEndpoint?: string;
  primitiveEmbeddingCostBudgetMicrounits: number;
  primitiveEmbeddingProviderTimeoutMs: number;
  primitiveIndexMaxJobsPerReconciliation: number;
  primitiveIndexReconciliationIntervalMs: number;
  primitiveSemanticContributionEnabled: boolean;
  primitiveSemanticProfile: PrimitiveSemanticProfile;
  redisUrl: string;
  requestTimeoutMs: number;
  sessionAbsoluteTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  simulationContinuousEnabled: boolean;
  simulationLeaseMs: number;
  simulationMaximumAttempts: number;
  simulationMaximumBackoffMs: number;
  simulationMaximumWorldsPerRun: number;
  simulationReconciliationIntervalMs: number;
  simulationRetryBaseMs: number;
  workerHeartbeatIntervalMs: number;
  workerHeartbeatTtlMs: number;
  workerHealthHost: string;
  workerHealthPort: number;
  worldCompilationReconciliationIntervalMs: number;
}

export class ConfigurationError extends Error {
  public readonly code = 'INVALID_CONFIGURATION';

  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const UUID_ALLOWLIST_LIMIT = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigurationError(`${key} is required.`);
  return value;
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function parseBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigurationError(`${key} must be true or false.`);
}

function parseUuidAllowlist(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key]?.trim();
  if (!raw) return [];
  const values = raw.split(',').map((value) => value.trim().toLowerCase());
  if (
    values.length > UUID_ALLOWLIST_LIMIT ||
    values.some((value) => !UUID_PATTERN.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new ConfigurationError(
      `${key} must contain at most ${UUID_ALLOWLIST_LIMIT} unique comma-separated UUIDs.`,
    );
  }
  return values.sort();
}

function parseUrl(value: string, key: string, protocols: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${key} must be a valid URL.`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new ConfigurationError(`${key} must use ${protocols.join(' or ')}.`);
  }
  return url.toString();
}

function parseOrigins(env: NodeJS.ProcessEnv): string[] {
  const values = requireValue(env, 'ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.includes('*')) {
    throw new ConfigurationError('ALLOWED_ORIGINS must contain explicit origins.');
  }
  return values.map(
    (value) => new URL(parseUrl(value, 'ALLOWED_ORIGINS', ['http:', 'https:'])).origin,
  );
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  service: 'api' | 'worker' = 'api',
): RuntimeConfig {
  const environment = (env.NODE_ENV ?? 'development') as Environment;
  if (!['development', 'production', 'test'].includes(environment)) {
    throw new ConfigurationError('NODE_ENV must be development, test, or production.');
  }

  const buildRevision = env.BUILD_REVISION?.trim() || 'local-dev';
  const authPepper = env.AUTH_PEPPER?.trim();
  if (service === 'api' && (!authPepper || authPepper.length < 32)) {
    throw new ConfigurationError('AUTH_PEPPER must contain at least 32 characters.');
  }
  const enableOperationalSmoke = parseBoolean(env, 'ENABLE_OPERATIONAL_SMOKE', false);
  const enableLocalRegistration = parseBoolean(
    env,
    'ENABLE_LOCAL_REGISTRATION',
    environment !== 'production',
  );
  const operationsToken = env.OPERATIONS_TOKEN?.trim();
  const dependencyTimeoutMs = parseInteger(env, 'DEPENDENCY_TIMEOUT_MS', 1_500, 100, 10_000);
  const workerHeartbeatIntervalMs = parseInteger(
    env,
    'WORKER_HEARTBEAT_INTERVAL_MS',
    5_000,
    500,
    60_000,
  );
  const workerHeartbeatTtlMs = parseInteger(env, 'WORKER_HEARTBEAT_TTL_MS', 15_000, 2_000, 300_000);
  const primitiveSemanticProfile = (env.PRIMITIVE_SEMANTIC_PROFILE?.trim() ||
    'disabled') as PrimitiveSemanticProfile;
  if (!['disabled', 'local_hash'].includes(primitiveSemanticProfile)) {
    throw new ConfigurationError('PRIMITIVE_SEMANTIC_PROFILE must be disabled or local_hash.');
  }
  const primitiveSemanticContributionEnabled = parseBoolean(
    env,
    'PRIMITIVE_SEMANTIC_CONTRIBUTION_ENABLED',
    false,
  );
  if (primitiveSemanticProfile === 'disabled' && primitiveSemanticContributionEnabled) {
    throw new ConfigurationError(
      'PRIMITIVE_SEMANTIC_CONTRIBUTION_ENABLED requires PRIMITIVE_SEMANTIC_PROFILE=local_hash.',
    );
  }
  const primitiveEmbeddingCostBudgetMicrounits = parseInteger(
    env,
    'PRIMITIVE_EMBEDDING_COST_BUDGET_MICROUNITS',
    0,
    0,
    2_147_483_647,
  );
  if (primitiveEmbeddingCostBudgetMicrounits !== 0) {
    throw new ConfigurationError(
      'PRIMITIVE_EMBEDDING_COST_BUDGET_MICROUNITS must be 0 for supported local profiles.',
    );
  }
  const manifestGenerationEnabled = parseBoolean(env, 'MANIFEST_GENERATION_ENABLED', true);
  const manifestGenerationProvider = (env.MANIFEST_GENERATION_PROVIDER?.trim() ||
    'disabled') as ManifestGenerationProvider;
  if (manifestGenerationProvider !== 'disabled') {
    throw new ConfigurationError(
      'MANIFEST_GENERATION_PROVIDER must be disabled until a reviewed provider adapter is configured.',
    );
  }
  const manifestGenerationDailyBudgetMicrounits = parseInteger(
    env,
    'MANIFEST_GENERATION_DAILY_BUDGET_MICROUNITS',
    0,
    0,
    2_147_483_647,
  );
  if (manifestGenerationProvider === 'disabled' && manifestGenerationDailyBudgetMicrounits !== 0) {
    throw new ConfigurationError(
      'MANIFEST_GENERATION_DAILY_BUDGET_MICROUNITS must be 0 when the provider is disabled.',
    );
  }

  if (workerHeartbeatTtlMs < workerHeartbeatIntervalMs * 2) {
    throw new ConfigurationError('WORKER_HEARTBEAT_TTL_MS must be at least twice the interval.');
  }
  if (enableOperationalSmoke && (!operationsToken || operationsToken.length < 32)) {
    throw new ConfigurationError(
      'OPERATIONS_TOKEN must contain at least 32 characters when smoke jobs are enabled.',
    );
  }
  if (
    environment === 'production' &&
    (buildRevision === 'local-dev' ||
      operationsToken?.includes('replace-with') ||
      authPepper?.includes('replace-with') ||
      authPepper?.includes('local-only'))
  ) {
    throw new ConfigurationError('Production refuses placeholder build or security credentials.');
  }

  const logLevel = (env.LOG_LEVEL ?? 'info') as RuntimeConfig['logLevel'];
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(logLevel)) {
    throw new ConfigurationError('LOG_LEVEL is invalid.');
  }

  const otelEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (otelEndpoint) parseUrl(otelEndpoint, 'OTEL_EXPORTER_OTLP_ENDPOINT', ['http:', 'https:']);

  const sessionAbsoluteTtlSeconds = parseInteger(
    env,
    'SESSION_ABSOLUTE_TTL_SECONDS',
    2_592_000,
    3_600,
    7_776_000,
  );
  const sessionIdleTtlSeconds = parseInteger(
    env,
    'SESSION_IDLE_TTL_SECONDS',
    604_800,
    900,
    2_592_000,
  );
  if (sessionIdleTtlSeconds > sessionAbsoluteTtlSeconds) {
    throw new ConfigurationError('SESSION_IDLE_TTL_SECONDS cannot exceed the absolute TTL.');
  }
  const simulationMaximumBackoffMs = parseInteger(
    env,
    'SIMULATION_MAXIMUM_BACKOFF_MS',
    5_000,
    100,
    60_000,
  );
  const simulationRetryBaseMs = parseInteger(env, 'SIMULATION_RETRY_BASE_MS', 250, 100, 60_000);
  if (simulationRetryBaseMs > simulationMaximumBackoffMs) {
    throw new ConfigurationError(
      'SIMULATION_RETRY_BASE_MS cannot exceed SIMULATION_MAXIMUM_BACKOFF_MS.',
    );
  }

  return {
    allowedOrigins: parseOrigins(env),
    apiHost: env.API_HOST?.trim() || '0.0.0.0',
    apiPort: parseInteger(env, 'API_PORT', 4_000, 1, 65_535),
    ...(authPepper ? { authPepper } : {}),
    buildRevision,
    compilerEnabled: parseBoolean(env, 'COMPILER_ENABLED', true),
    compilerMaxEntities: parseInteger(env, 'COMPILER_MAX_ENTITIES', 2_000, 1, 5_000),
    compilerMaxRelationships: parseInteger(env, 'COMPILER_MAX_RELATIONSHIPS', 8_000, 1, 10_000),
    commerceScheduleBatchSize: parseInteger(env, 'COMMERCE_SCHEDULE_BATCH_SIZE', 25, 1, 250),
    commerceScheduleEnabled: parseBoolean(env, 'COMMERCE_SCHEDULE_ENABLED', true),
    commerceScheduleReconciliationIntervalMs: parseInteger(
      env,
      'COMMERCE_SCHEDULE_RECONCILIATION_INTERVAL_MS',
      1_000,
      100,
      60_000,
    ),
    databaseUrl: parseUrl(requireValue(env, 'DATABASE_URL'), 'DATABASE_URL', [
      'postgres:',
      'postgresql:',
    ]),
    dependencyTimeoutMs,
    economyDebitsFrozen: parseBoolean(env, 'ECONOMY_DEBITS_FROZEN', false),
    economyDisabledTaxPolicyIds: parseUuidAllowlist(env, 'ECONOMY_DISABLED_TAX_POLICY_IDS'),
    economyIssuanceEnabled: parseBoolean(env, 'ECONOMY_ISSUANCE_ENABLED', true),
    economyIssuanceRateLimitPerHour: parseInteger(
      env,
      'ECONOMY_ISSUANCE_RATE_LIMIT_PER_HOUR',
      3,
      1,
      100,
    ),
    economyJobsEnabled: parseBoolean(env, 'ECONOMY_JOBS_ENABLED', true),
    economyListingRateLimitPerMinute: parseInteger(
      env,
      'ECONOMY_LISTING_RATE_LIMIT_PER_MINUTE',
      10,
      1,
      1_000,
    ),
    economyListingsEnabled: parseBoolean(env, 'ECONOMY_LISTINGS_ENABLED', true),
    economyOfferRateLimitPerMinute: parseInteger(
      env,
      'ECONOMY_OFFER_RATE_LIMIT_PER_MINUTE',
      10,
      1,
      1_000,
    ),
    economyOfferReconciliationBatchSize: parseInteger(
      env,
      'ECONOMY_OFFER_RECONCILIATION_BATCH_SIZE',
      25,
      1,
      250,
    ),
    economyOfferReconciliationIntervalMs: parseInteger(
      env,
      'ECONOMY_OFFER_RECONCILIATION_INTERVAL_MS',
      1_000,
      100,
      60_000,
    ),
    economyOffersEnabled: parseBoolean(env, 'ECONOMY_OFFERS_ENABLED', true),
    economyProductionEnabled: parseBoolean(env, 'ECONOMY_PRODUCTION_ENABLED', true),
    economyProductionRateLimitPerMinute: parseInteger(
      env,
      'ECONOMY_PRODUCTION_RATE_LIMIT_PER_MINUTE',
      10,
      1,
      1_000,
    ),
    economyPurchaseRateLimitPerMinute: parseInteger(
      env,
      'ECONOMY_PURCHASE_RATE_LIMIT_PER_MINUTE',
      20,
      1,
      1_000,
    ),
    economyPurchasesEnabled: parseBoolean(env, 'ECONOMY_PURCHASES_ENABLED', true),
    economyTransferRateLimitPerMinute: parseInteger(
      env,
      'ECONOMY_TRANSFER_RATE_LIMIT_PER_MINUTE',
      20,
      1,
      1_000,
    ),
    economyTransfersEnabled: parseBoolean(env, 'ECONOMY_TRANSFERS_ENABLED', true),
    economyWorkRateLimitPerMinute: parseInteger(
      env,
      'ECONOMY_WORK_RATE_LIMIT_PER_MINUTE',
      10,
      1,
      1_000,
    ),
    enableLocalRegistration,
    enableOperationalSmoke,
    environment,
    logLevel,
    manifestGenerationDailyBudgetMicrounits,
    manifestGenerationEnabled,
    manifestGenerationMaxConcurrentPerUser: parseInteger(
      env,
      'MANIFEST_GENERATION_MAX_CONCURRENT_PER_USER',
      2,
      1,
      10,
    ),
    manifestGenerationMaxConcurrentPerWorld: parseInteger(
      env,
      'MANIFEST_GENERATION_MAX_CONCURRENT_PER_WORLD',
      1,
      1,
      3,
    ),
    manifestGenerationOutputTokenLimit: parseInteger(
      env,
      'MANIFEST_GENERATION_OUTPUT_TOKEN_LIMIT',
      4_096,
      512,
      16_384,
    ),
    manifestGenerationProvider,
    manifestGenerationProviderTimeoutMs: parseInteger(
      env,
      'MANIFEST_GENERATION_PROVIDER_TIMEOUT_MS',
      8_000,
      500,
      30_000,
    ),
    manifestGenerationReconciliationIntervalMs: parseInteger(
      env,
      'MANIFEST_GENERATION_RECONCILIATION_INTERVAL_MS',
      2_000,
      250,
      60_000,
    ),
    manifestPromptRetentionDays: parseInteger(env, 'MANIFEST_PROMPT_RETENTION_DAYS', 30, 1, 365),
    outboxBatchSize: parseInteger(env, 'OUTBOX_BATCH_SIZE', 25, 1, 250),
    outboxLeaseMs: parseInteger(env, 'OUTBOX_LEASE_MS', 30_000, 1_000, 300_000),
    outboxMaximumAttempts: parseInteger(env, 'OUTBOX_MAXIMUM_ATTEMPTS', 10, 1, 100),
    outboxReconciliationIntervalMs: parseInteger(
      env,
      'OUTBOX_RECONCILIATION_INTERVAL_MS',
      1_000,
      250,
      60_000,
    ),
    ...(operationsToken ? { operationsToken } : {}),
    ...(otelEndpoint ? { otelEndpoint } : {}),
    primitiveEmbeddingCostBudgetMicrounits,
    primitiveEmbeddingProviderTimeoutMs: parseInteger(
      env,
      'PRIMITIVE_EMBEDDING_TIMEOUT_MS',
      3_000,
      100,
      10_000,
    ),
    primitiveIndexMaxJobsPerReconciliation: parseInteger(
      env,
      'PRIMITIVE_INDEX_MAX_JOBS_PER_RECONCILIATION',
      25,
      1,
      250,
    ),
    primitiveIndexReconciliationIntervalMs: parseInteger(
      env,
      'PRIMITIVE_INDEX_RECONCILIATION_INTERVAL_MS',
      5_000,
      250,
      60_000,
    ),
    primitiveSemanticContributionEnabled,
    primitiveSemanticProfile,
    redisUrl: parseUrl(requireValue(env, 'REDIS_URL'), 'REDIS_URL', ['redis:', 'rediss:']),
    requestTimeoutMs: parseInteger(env, 'REQUEST_TIMEOUT_MS', 10_000, 500, 60_000),
    sessionAbsoluteTtlSeconds,
    sessionIdleTtlSeconds,
    simulationContinuousEnabled: parseBoolean(env, 'SIMULATION_CONTINUOUS_ENABLED', true),
    simulationLeaseMs: parseInteger(env, 'SIMULATION_LEASE_MS', 30_000, 1_000, 300_000),
    simulationMaximumAttempts: parseInteger(env, 'SIMULATION_MAXIMUM_ATTEMPTS', 3, 1, 10),
    simulationMaximumBackoffMs,
    simulationMaximumWorldsPerRun: parseInteger(
      env,
      'SIMULATION_MAXIMUM_WORLDS_PER_RUN',
      25,
      1,
      100,
    ),
    simulationReconciliationIntervalMs: parseInteger(
      env,
      'SIMULATION_RECONCILIATION_INTERVAL_MS',
      1_000,
      100,
      60_000,
    ),
    simulationRetryBaseMs,
    workerHeartbeatIntervalMs,
    workerHeartbeatTtlMs,
    workerHealthHost: env.WORKER_HEALTH_HOST?.trim() || '0.0.0.0',
    workerHealthPort: parseInteger(env, 'WORKER_HEALTH_PORT', 4_001, 1, 65_535),
    worldCompilationReconciliationIntervalMs: parseInteger(
      env,
      'WORLD_COMPILATION_RECONCILIATION_INTERVAL_MS',
      2_000,
      250,
      60_000,
    ),
  };
}
