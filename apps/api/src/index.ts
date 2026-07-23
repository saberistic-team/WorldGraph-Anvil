import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { loadRuntimeConfig } from '@worldgraph/config';
import {
  SYSTEM_SMOKE_QUEUE,
  MANIFEST_GENERATION_QUEUE,
  PRIMITIVE_INDEX_QUEUE,
  WORLD_COMPILATION_QUEUE,
  SystemClock,
  UuidV7Generator,
  type ManifestGenerationRequested,
  type PrimitiveIndexRequested,
  type SystemSmokeRequested,
  type WorldCompilationRequestedQueue,
} from '@worldgraph/contracts';
import { createDatabaseClient } from '@worldgraph/db';
import { createLogger, initializeTelemetry } from '@worldgraph/observability';

import { buildApp } from './app.js';
import { discardNotifications } from './application/notifications.js';
import { IdentityService } from './identity/service.js';
import {
  Argon2idPasswordHasher,
  PRODUCTION_PASSWORD_HASH_OPTIONS,
  TEST_PASSWORD_HASH_OPTIONS,
} from './identity/security.js';
import { PostgresRepository } from './repositories/postgres-repository.js';
import { createApiPrimitiveSemanticProfile } from './primitive-semantic-profile.js';
import { ManifestGenerationNotificationSink } from './manifests/generation-notifications.js';
import { ManifestRepository } from './manifests/repository.js';
import { ManifestService } from './manifests/service.js';
import { PrimitiveIndexNotificationSink } from './primitives/index-notifications.js';
import { PrimitiveRepository } from './primitives/repository.js';
import { PrimitiveService } from './primitives/service.js';
import { WorldService } from './worlds/service.js';
import { CompilationNotificationSink } from './compilation/notifications.js';
import { CompilationRepository } from './compilation/repository.js';
import { CompilationService } from './compilation/service.js';
import { PostgresCommandRepository } from './commands/repository.js';
import { WorldCommandBus } from './commands/command-bus.js';
import { WorldCommandService } from './commands/service.js';
import { PostgresEconomyQueryRepository } from './economy/repository.js';
import { EconomyQueryService } from './economy/service.js';
import { PostgresCommerceReadRepository } from './economy/commerce-read-repository.js';
import { CommerceReadService } from './economy/commerce-read-service.js';

const config = loadRuntimeConfig();
if (!config.authPepper) throw new Error('API authentication configuration is unavailable.');
const identityConfig = { ...config, authPepper: config.authPepper };
const logger = createLogger({
  buildRevision: config.buildRevision,
  environment: config.environment,
  level: config.logLevel,
  service: 'api',
});
const telemetryRuntime = await initializeTelemetry({
  ...(config.otelEndpoint ? { endpoint: config.otelEndpoint } : {}),
  logger,
  service: 'worldgraph-api',
});
const database = createDatabaseClient(config.databaseUrl, 'worldgraph-api');
database.pool.on('error', (error) => {
  logger.error({ error }, 'database.idle_client_error');
});
const redis = new Redis(config.redisUrl, {
  connectTimeout: config.dependencyTimeoutMs,
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const queueRedis = new Redis(config.redisUrl, {
  connectTimeout: config.dependencyTimeoutMs,
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const smokeQueue = new Queue<SystemSmokeRequested>(SYSTEM_SMOKE_QUEUE, { connection: queueRedis });
const primitiveIndexQueue = new Queue<PrimitiveIndexRequested>(PRIMITIVE_INDEX_QUEUE, {
  connection: queueRedis,
});
const manifestGenerationQueue = new Queue<ManifestGenerationRequested>(MANIFEST_GENERATION_QUEUE, {
  connection: queueRedis,
});
const worldCompilationQueue = new Queue<WorldCompilationRequestedQueue>(WORLD_COMPILATION_QUEUE, {
  connection: queueRedis,
});
const idGenerator = new UuidV7Generator();
const clock = new SystemClock();
const repository = new PostgresRepository(database.pool);
const primitiveSemantic = createApiPrimitiveSemanticProfile(config);
const primitiveRepository = new PrimitiveRepository(
  database.pool,
  primitiveSemantic.indexProfile.configurationId,
);
const primitiveNotifications = new PrimitiveIndexNotificationSink(
  primitiveIndexQueue,
  discardNotifications,
);
const manifestNotifications = new ManifestGenerationNotificationSink(
  manifestGenerationQueue,
  `${config.manifestGenerationProvider}-v1`,
  discardNotifications,
);
const compilationNotifications = new CompilationNotificationSink(
  worldCompilationQueue,
  discardNotifications,
);
const passwordHasher = new Argon2idPasswordHasher(
  identityConfig.authPepper,
  config.environment === 'test' ? TEST_PASSWORD_HASH_OPTIONS : PRODUCTION_PASSWORD_HASH_OPTIONS,
);
const identity = new IdentityService(
  repository,
  identityConfig,
  clock,
  idGenerator,
  passwordHasher,
  discardNotifications,
);
const worlds = new WorldService(
  repository,
  clock,
  idGenerator,
  (invitationId) => identity.invitationToken(invitationId),
  (rawToken) => identity.tokenHash(rawToken, 'invitation'),
  discardNotifications,
);
const manifests = new ManifestService(
  new ManifestRepository(database.pool),
  config,
  clock,
  idGenerator,
  manifestNotifications,
  identityConfig.authPepper,
);
const compilation = new CompilationService(
  new CompilationRepository(database.pool),
  config,
  clock,
  idGenerator,
  compilationNotifications,
  identityConfig.authPepper,
);
const commandRepository = new PostgresCommandRepository(database.pool, idGenerator);
const commands = new WorldCommandService(
  new WorldCommandBus(
    commandRepository,
    idGenerator,
    undefined,
    {
      debitsFrozen: config.economyDebitsFrozen,
      issuanceEnabled: config.economyIssuanceEnabled,
      issuanceRateLimitPerHour: config.economyIssuanceRateLimitPerHour,
      offerRateLimitPerMinute: config.economyOfferRateLimitPerMinute,
      offersEnabled: config.economyOffersEnabled,
      transferRateLimitPerMinute: config.economyTransferRateLimitPerMinute,
      transfersEnabled: config.economyTransfersEnabled,
    },
    {
      disabledTaxPolicyIds: config.economyDisabledTaxPolicyIds ?? [],
      jobsEnabled: config.economyJobsEnabled ?? true,
      listingRateLimitPerMinute: config.economyListingRateLimitPerMinute ?? 10,
      listingsEnabled: config.economyListingsEnabled ?? true,
      productionEnabled: config.economyProductionEnabled ?? true,
      productionRateLimitPerMinute: config.economyProductionRateLimitPerMinute ?? 10,
      purchaseRateLimitPerMinute: config.economyPurchaseRateLimitPerMinute ?? 20,
      purchasesEnabled: config.economyPurchasesEnabled ?? true,
      workRateLimitPerMinute: config.economyWorkRateLimitPerMinute ?? 10,
    },
  ),
  commandRepository,
  clock,
  identityConfig.authPepper,
  () => redis.status === 'ready' && queueRedis.status === 'ready',
);
const economy = new EconomyQueryService(
  new PostgresEconomyQueryRepository(database.pool),
  identityConfig.authPepper,
  {
    debitsFrozen: config.economyDebitsFrozen,
    issuanceEnabled: config.economyIssuanceEnabled,
    offersEnabled: config.economyOffersEnabled,
    transfersEnabled: config.economyTransfersEnabled,
  },
);
const commerceReads = new CommerceReadService(
  new PostgresCommerceReadRepository(database.pool),
  identityConfig.authPepper,
  config.economyDisabledTaxPolicyIds ?? [],
);
const primitives = new PrimitiveService(
  primitiveRepository,
  clock,
  idGenerator,
  primitiveNotifications,
  identityConfig.authPepper,
  primitiveSemantic.queryVectors,
  primitiveSemantic.indexProfile,
  config.primitiveEmbeddingProviderTimeoutMs,
);
await primitives.refreshCatalogMetrics();

const app = await buildApp({
  clock,
  config,
  domain: {
    commands,
    commerceReads,
    compilation,
    economy,
    identity,
    manifests,
    primitives,
    worlds,
  },
  idGenerator,
  logger,
  pool: database.pool,
  redis,
  smokeQueue,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown.started');
  const timer = setTimeout(() => process.exit(1), 10_000).unref();
  try {
    await app.close();
    await worldCompilationQueue.close();
    await manifestGenerationQueue.close();
    await primitiveIndexQueue.close();
    await smokeQueue.close();
    await queueRedis.quit();
    await redis.quit().catch(() => undefined);
    await database.pool.end();
    await telemetryRuntime.shutdown();
    clearTimeout(timer);
    logger.info({ signal }, 'shutdown.completed');
    process.exit(0);
  } catch (error) {
    logger.error({ error, signal }, 'shutdown.failed');
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.apiHost, port: config.apiPort });
  logger.info({ port: config.apiPort }, 'api.started');
} catch (error) {
  logger.fatal({ error }, 'api.start_failed');
  await database.pool.end();
  await telemetryRuntime.shutdown();
  process.exit(1);
}

export { buildApp } from './app.js';
