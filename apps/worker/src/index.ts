import Redis from 'ioredis';

import { createPrimitiveEmbeddingProfile } from '@worldgraph/catalog';
import { loadRuntimeConfig } from '@worldgraph/config';
import { SystemClock, UuidV7Generator } from '@worldgraph/contracts';
import { createDatabaseClient } from '@worldgraph/db';
import {
  createDeterministicHarborCityFallback,
  createManifestGenerationEngine,
} from '@worldgraph/manifests';
import { createLogger, initializeTelemetry } from '@worldgraph/observability';
import {
  PostgresCommerceScheduledCommand,
  PostgresEconomyOfferExpiryCommand,
} from '@worldgraph/economy-command';
import { PostgresSimulationAdvanceCommand } from '@worldgraph/simulation-command';

import { Heartbeat } from './heartbeat.js';
import { PostgresEconomyOfferRepository } from './economy-offer-repository.js';
import {
  createProductionEconomyOfferMetrics,
  EconomyOfferCoordinator,
  EconomyOfferRunner,
} from './economy-offer-worker.js';
import { PostgresCommerceScheduleRepository } from './commerce-schedule-repository.js';
import {
  CommerceScheduleCoordinator,
  CommerceScheduleRunner,
  createProductionCommerceScheduleMetrics,
} from './commerce-schedule-worker.js';
import {
  createProductionCommerceRealtimeMetrics,
  RedisCommerceRealtimePublisher,
} from './commerce-realtime.js';
import { createHealthServer } from './health-server.js';
import { createDisabledManifestGenerationProvider } from './manifest-generation-provider.js';
import { PostgresManifestGenerationRepository } from './manifest-generation-repository.js';
import { createManifestGenerationWakeWorker } from './manifest-generation-wake.js';
import {
  createProductionManifestGenerationMetrics,
  ManifestGenerationCoordinator,
  ManifestGenerationRunner,
} from './manifest-generation-worker.js';
import { discardWorkerNotifications } from './application-notifications.js';
import { PostgresOutboxRepository } from './outbox-repository.js';
import { createProductionOutboxMetrics, OutboxCoordinator, OutboxRunner } from './outbox-worker.js';
import { PostgresPrimitiveIndexRepository } from './primitive-index-repository.js';
import { reconcilePrimitiveIndexJobs } from './primitive-index-startup.js';
import { createPrimitiveIndexWakeWorker } from './primitive-index-wake.js';
import {
  createProductionPrimitiveIndexMetrics,
  PrimitiveIndexCoordinator,
  PrimitiveIndexRunner,
} from './primitive-index-worker.js';
import { createSmokeWorker } from './smoke-worker.js';
import { PostgresSimulationLeaseRepository } from './simulation-repository.js';
import { createSimulationWakeWorker } from './simulation-wake.js';
import {
  createProductionSimulationWorkerTracing,
  createProductionSimulationWorkerMetrics,
  createSimulationCommandObserver,
  SimulationCoordinator,
  SimulationRunner,
} from './simulation-worker.js';
import { PostgresWorldCompilationRepository } from './world-compilation-repository.js';
import { createWorldCompilationWakeWorker } from './world-compilation-wake.js';
import {
  createProductionWorldCompilationMetrics,
  WorldCompilationCoordinator,
  WorldCompilationRunner,
} from './world-compilation-worker.js';

const config = loadRuntimeConfig(process.env, 'worker');
const logger = createLogger({
  buildRevision: config.buildRevision,
  environment: config.environment,
  level: config.logLevel,
  service: 'worker',
});
const telemetryRuntime = await initializeTelemetry({
  ...(config.otelEndpoint ? { endpoint: config.otelEndpoint } : {}),
  logger,
  service: 'worldgraph-worker',
});
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const healthRedis = new Redis(config.redisUrl, {
  connectTimeout: config.dependencyTimeoutMs,
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const database = createDatabaseClient(config.databaseUrl, 'worldgraph-worker');
database.pool.on('error', () => {
  logger.error({ code: 'DATABASE_IDLE_CLIENT_ERROR' }, 'database.idle_client_error');
});
const clock = new SystemClock();
const ids = new UuidV7Generator();
const heartbeat = new Heartbeat(
  healthRedis,
  clock,
  config.buildRevision,
  config.workerHeartbeatIntervalMs,
  config.workerHeartbeatTtlMs,
  logger,
);
const smokeWorker = createSmokeWorker(redis, clock, logger);
const manifestGenerationProvider = createDisabledManifestGenerationProvider();
const manifestGenerationEngine = createManifestGenerationEngine(manifestGenerationProvider, {
  fallbackFactory: createDeterministicHarborCityFallback,
  policy: {
    maxCostMicrounits: config.manifestGenerationDailyBudgetMicrounits,
    maxOutputTokens: config.manifestGenerationOutputTokenLimit,
    providerTimeoutMs: config.manifestGenerationProviderTimeoutMs,
  },
});
const manifestGenerationRepository = new PostgresManifestGenerationRepository(database.pool);
const manifestGenerationRunner = new ManifestGenerationRunner(
  manifestGenerationRepository,
  manifestGenerationEngine,
  manifestGenerationProvider.configuration.configurationId,
  logger,
  {
    claimTimeoutMs: Math.max(30_000, config.manifestGenerationProviderTimeoutMs * 2),
    clock,
    dailyBudgetMicrounits: config.manifestGenerationDailyBudgetMicrounits,
    enabled: config.manifestGenerationEnabled,
    ids,
    maximumConcurrentPerWorld: config.manifestGenerationMaxConcurrentPerWorld,
    metrics: createProductionManifestGenerationMetrics(),
    notifications: discardWorkerNotifications,
  },
);
const manifestGenerationCoordinator = new ManifestGenerationCoordinator(
  manifestGenerationRunner,
  logger,
  { reconciliationIntervalMs: config.manifestGenerationReconciliationIntervalMs },
);
const manifestGenerationWakeWorker = createManifestGenerationWakeWorker(
  redis,
  manifestGenerationCoordinator,
  logger,
);
const primitiveIndexRepository = new PostgresPrimitiveIndexRepository(database.pool);
const primitiveEmbeddingProfile = createPrimitiveEmbeddingProfile(
  config.primitiveSemanticProfile,
  config.primitiveEmbeddingCostBudgetMicrounits,
);
const discoveredPrimitiveIndexJobs = await reconcilePrimitiveIndexJobs(
  primitiveIndexRepository,
  primitiveEmbeddingProfile.configurationId,
  config.primitiveIndexMaxJobsPerReconciliation,
);
logger.info(
  {
    discoveredJobs: discoveredPrimitiveIndexJobs,
    profile: primitiveEmbeddingProfile.profile,
    providerConfigurationId: primitiveEmbeddingProfile.configurationId,
  },
  'primitive_index.profile_ready',
);
const primitiveIndexRunner = new PrimitiveIndexRunner(
  primitiveIndexRepository,
  primitiveEmbeddingProfile,
  logger,
  {
    clock,
    ids,
    maximumJobsPerRun: config.primitiveIndexMaxJobsPerReconciliation,
    maximumProviderCostMicrounits: config.primitiveEmbeddingCostBudgetMicrounits,
    metrics: createProductionPrimitiveIndexMetrics(primitiveEmbeddingProfile.configurationId),
    notifications: discardWorkerNotifications,
    providerTimeoutMs: config.primitiveEmbeddingProviderTimeoutMs,
  },
);
const primitiveIndexCoordinator = new PrimitiveIndexCoordinator(primitiveIndexRunner, logger, {
  reconciliationIntervalMs: config.primitiveIndexReconciliationIntervalMs,
});
const primitiveIndexWakeWorker = createPrimitiveIndexWakeWorker(
  redis,
  primitiveIndexCoordinator,
  logger,
);
const worldCompilationRepository = new PostgresWorldCompilationRepository(database.pool);
const worldCompilationRunner = new WorldCompilationRunner(
  worldCompilationRepository,
  logger,
  {
    maxEntities: config.compilerMaxEntities ?? 2_000,
    maxRelationships: config.compilerMaxRelationships ?? 8_000,
  },
  {
    clock,
    enabled: config.compilerEnabled ?? true,
    ids,
    metrics: createProductionWorldCompilationMetrics(),
    notifications: discardWorkerNotifications,
  },
);
const worldCompilationCoordinator = new WorldCompilationCoordinator(
  worldCompilationRunner,
  logger,
  {
    reconciliationIntervalMs: config.worldCompilationReconciliationIntervalMs ?? 2_000,
  },
);
const worldCompilationWakeWorker = createWorldCompilationWakeWorker(
  redis,
  worldCompilationCoordinator,
  logger,
);
const commerceRealtime = new RedisCommerceRealtimePublisher(
  healthRedis,
  logger,
  createProductionCommerceRealtimeMetrics(),
);
const outboxRepository = new PostgresOutboxRepository(database.pool, commerceRealtime);
const outboxRunner = new OutboxRunner(
  outboxRepository,
  `worker:${process.pid}:${ids.next()}`,
  logger,
  {
    batchSize: config.outboxBatchSize ?? 25,
    leaseMs: config.outboxLeaseMs ?? 30_000,
    maximumAttempts: config.outboxMaximumAttempts ?? 10,
    metrics: createProductionOutboxMetrics(),
  },
);
const outboxCoordinator = new OutboxCoordinator(outboxRunner, logger, {
  reconciliationIntervalMs: config.outboxReconciliationIntervalMs ?? 1_000,
});
const simulationWorkerId = `worker:${process.pid}:${ids.next()}`;
const simulationRepository = new PostgresSimulationLeaseRepository(database.pool);
const simulationMetrics = createProductionSimulationWorkerMetrics();
const simulationTracing = createProductionSimulationWorkerTracing();
const simulationCommands = new PostgresSimulationAdvanceCommand(database.pool, {
  ids,
  observer: createSimulationCommandObserver(simulationMetrics, simulationTracing),
});
const simulationRunner = new SimulationRunner(
  simulationRepository,
  simulationCommands,
  simulationWorkerId,
  logger,
  {
    ids,
    leaseMs: config.simulationLeaseMs,
    maximumAttempts: config.simulationMaximumAttempts,
    maximumBackoffMs: config.simulationMaximumBackoffMs,
    maximumWorldsPerRun: config.simulationMaximumWorldsPerRun,
    metrics: simulationMetrics,
    retryBaseMs: config.simulationRetryBaseMs,
    tracing: simulationTracing,
  },
);
const simulationCoordinator = new SimulationCoordinator(simulationRunner, logger, {
  isAutomationAvailable: () => redis.status === 'ready',
  metrics: simulationMetrics,
  reconciliationIntervalMs: config.simulationReconciliationIntervalMs,
  tracing: simulationTracing,
});
const simulationWakeWorker = config.simulationContinuousEnabled
  ? createSimulationWakeWorker(redis, simulationCoordinator, logger, { metrics: simulationMetrics })
  : null;
const economyOfferRepository = new PostgresEconomyOfferRepository(database.pool);
const economyOfferCommands = new PostgresEconomyOfferExpiryCommand(database.pool, { ids });
const economyOfferRunner = new EconomyOfferRunner(
  economyOfferRepository,
  economyOfferCommands,
  logger,
  {
    batchSize: config.economyOfferReconciliationBatchSize,
    ids,
    metrics: createProductionEconomyOfferMetrics(),
  },
);
const economyOfferCoordinator = new EconomyOfferCoordinator(economyOfferRunner, logger, {
  reconciliationIntervalMs: config.economyOfferReconciliationIntervalMs,
});
const commerceScheduleRepository = new PostgresCommerceScheduleRepository(
  database.pool,
  config.economyDisabledTaxPolicyIds ?? [],
);
const commerceScheduledCommands = new PostgresCommerceScheduledCommand(database.pool, {
  disabledTaxPolicyIds: config.economyDisabledTaxPolicyIds ?? [],
  ids,
});
const commerceScheduleRunner = new CommerceScheduleRunner(
  commerceScheduleRepository,
  commerceScheduledCommands,
  logger,
  {
    batchSize: config.commerceScheduleBatchSize ?? 25,
    ids,
    metrics: createProductionCommerceScheduleMetrics(),
  },
);
const commerceScheduleCoordinator = new CommerceScheduleCoordinator(
  commerceScheduleRunner,
  logger,
  {
    reconciliationIntervalMs: config.commerceScheduleReconciliationIntervalMs ?? 1_000,
  },
);
const healthServer = createHealthServer(
  healthRedis,
  database.pool,
  logger,
  config.dependencyTimeoutMs,
);

await healthRedis.connect();
await heartbeat.start();
manifestGenerationCoordinator.start();
primitiveIndexCoordinator.start();
if (config.compilerEnabled ?? true) worldCompilationCoordinator.start();
outboxCoordinator.start();
economyOfferCoordinator.start();
if (config.commerceScheduleEnabled ?? true) commerceScheduleCoordinator.start();
if (config.simulationContinuousEnabled) simulationCoordinator.start();
await new Promise<void>((resolve, reject) => {
  healthServer.once('error', reject);
  healthServer.listen(config.workerHealthPort, config.workerHealthHost, () => resolve());
});
logger.info({ port: config.workerHealthPort }, 'worker.started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown.started');
  const timer = setTimeout(() => process.exit(1), 10_000).unref();
  heartbeat.stop();
  try {
    await manifestGenerationWakeWorker.close();
    await manifestGenerationCoordinator.stop();
    await primitiveIndexWakeWorker.close();
    await primitiveIndexCoordinator.stop();
    await worldCompilationWakeWorker.close();
    await worldCompilationCoordinator.stop();
    await simulationWakeWorker?.close();
    if (config.simulationContinuousEnabled) await simulationCoordinator.stop();
    if (config.commerceScheduleEnabled ?? true) await commerceScheduleCoordinator.stop();
    await economyOfferCoordinator.stop();
    await outboxCoordinator.stop();
    await smokeWorker.close();
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await healthRedis.del('worldgraph:system:worker:heartbeat').catch(() => undefined);
    await healthRedis.quit().catch(() => undefined);
    await redis.quit();
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

export { createSmokeProcessor, createSmokeWorker } from './smoke-worker.js';
export {
  discardWorkerNotifications,
  type WorkerNotificationSink,
} from './application-notifications.js';
export { PostgresPrimitiveIndexRepository } from './primitive-index-repository.js';
export { PostgresManifestGenerationRepository } from './manifest-generation-repository.js';
export { PostgresWorldCompilationRepository } from './world-compilation-repository.js';
export { PostgresOutboxRepository } from './outbox-repository.js';
export { PostgresEconomyOfferRepository } from './economy-offer-repository.js';
export { PostgresCommerceScheduleRepository } from './commerce-schedule-repository.js';
export {
  commerceNotificationsForEvent,
  commerceRealtimeChannelV1,
  createProductionCommerceRealtimeMetrics,
  RedisCommerceRealtimePublisher,
} from './commerce-realtime.js';
export {
  EconomyOfferCoordinator,
  EconomyOfferRunner,
  createProductionEconomyOfferMetrics,
} from './economy-offer-worker.js';
export {
  CommerceScheduleCoordinator,
  CommerceScheduleRunner,
  createProductionCommerceScheduleMetrics,
} from './commerce-schedule-worker.js';
export { OutboxCoordinator, OutboxRunner } from './outbox-worker.js';
export {
  createManifestGenerationWakeProcessor,
  createManifestGenerationWakeWorker,
} from './manifest-generation-wake.js';
export {
  ManifestGenerationCoordinator,
  ManifestGenerationRunner,
} from './manifest-generation-worker.js';
export {
  createPrimitiveIndexWakeProcessor,
  createPrimitiveIndexWakeWorker,
} from './primitive-index-wake.js';
export { PrimitiveIndexCoordinator, PrimitiveIndexRunner } from './primitive-index-worker.js';
export {
  createWorldCompilationWakeProcessor,
  createWorldCompilationWakeWorker,
} from './world-compilation-wake.js';
export { WorldCompilationCoordinator, WorldCompilationRunner } from './world-compilation-worker.js';
export {
  PostgresSimulationLeaseRepository,
  type DueSimulationWorld,
  type SimulationAdvanceCandidate,
  type SimulationLease,
  type SimulationLeaseRepository,
} from './simulation-repository.js';
export {
  SIMULATION_WAKE_QUEUE,
  createSimulationWakeProcessor,
  createSimulationWakeWorker,
} from './simulation-wake.js';
export {
  SimulationCoordinator,
  SimulationRunner,
  createProductionSimulationWorkerTracing,
  createProductionSimulationWorkerMetrics,
  createSimulationCommandObserver,
  type FencedSimulationAdvanceRequest,
  type FencedSimulationAdvanceResult,
  type SimulationAdvanceCommandPort,
  type SimulationRunOutcome,
  type SimulationRunResult,
  type SimulationWorkerMetrics,
  type SimulationWorkerTracing,
} from './simulation-worker.js';
