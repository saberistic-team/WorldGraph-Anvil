import { createHash } from 'node:crypto';

import {
  context,
  metrics,
  trace,
  type Attributes,
  type Span,
  SpanStatusCode,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import pino, { type Logger } from 'pino';

const sensitiveKey =
  /(authorization|cookie|credential|password|pepper|secret|session|token|invite(?:link)?|api[-_]?key)/i;
const privateContentKey =
  /^(?:amount|artifact[-_]?content|balance|canonical[-_]?(?:content|manifest)|counterparty(?:[-_]?id)?|entity[-_]?state|manifest|memo|minor[-_]?units|price|prompt|prompt[-_]?text|raw[-_]?model[-_]?(?:payload|response)|wallet(?:[-_]?id)?)$/i;
const REDACTED = '[REDACTED]' as const;
const MAX_TRACE_CORRELATION_IDS = 32;
const MAX_TRACE_CORRELATION_VALUE_LENGTH = 128;

function redactText(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(
      /(password|pepper|credential|secret|csrf|token|invite(?:link|url)?|api[-_]?key)(\s*[=:]\s*)[^\s,;]+/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
}

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  if (value instanceof Error) {
    return { message: redactText(value.message), name: value.name };
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sensitiveKey.test(key) || privateContentKey.test(key)
        ? REDACTED
        : redactSensitive(item, seen),
    ]),
  );
}

export interface LoggerContext {
  buildRevision: string;
  environment: string;
  level: string;
  service: string;
}

export function createLogger(loggerContext: LoggerContext): Logger {
  return pino({
    base: {
      buildRevision: loggerContext.buildRevision,
      environment: loggerContext.environment,
      service: loggerContext.service,
    },
    formatters: {
      log(object) {
        return redactSensitive(object) as Record<string, unknown>;
      },
    },
    level: loggerContext.level,
    messageKey: 'message',
    mixin() {
      const span = trace.getSpan(context.active());
      return span ? { traceId: span.spanContext().traceId } : {};
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export interface EconomyCommandTraceCorrelation {
  actorId?: string;
  commandId?: string;
  commandType?: string;
  correlationId?: string;
  databaseTransactionId?: string;
  eventIds?: readonly string[];
  idempotencyKey?: string;
  listingIds?: readonly string[];
  outboxMessageIds?: readonly string[];
  runIds?: readonly string[];
  taxAssessmentIds?: readonly string[];
  tick?: string;
  tradeIds?: readonly string[];
  walletIds?: readonly string[];
  walletTransactionIds?: readonly string[];
  worldId?: string;
}

/**
 * Builds high-cardinality trace-only correlation attributes for an economy command.
 *
 * Actor, world, wallet and idempotency identities are converted to stable,
 * domain-separated references before leaving the process. Financial values and
 * command payloads are deliberately outside this contract.
 */
export function economyCommandTraceAttributes(input: EconomyCommandTraceCorrelation): Attributes {
  const attributes: Attributes = {};
  setTraceValue(attributes, 'world.economy.command_id', input.commandId);
  setTraceValue(attributes, 'world.economy.command_type', input.commandType);
  setTraceValue(attributes, 'world.economy.correlation_id', input.correlationId);
  setTraceValue(attributes, 'world.economy.database_transaction_id', input.databaseTransactionId);
  setTraceValue(attributes, 'world.economy.tick', input.tick);
  setTraceReference(attributes, 'world.economy.actor_ref', 'actor', input.actorId);
  setTraceReference(
    attributes,
    'world.economy.idempotency_key_ref',
    'idempotency-key',
    input.idempotencyKey,
  );
  setTraceReference(attributes, 'world.economy.world_ref', 'world', input.worldId);
  setTraceValues(attributes, 'world.economy.event_ids', input.eventIds);
  setTraceValues(attributes, 'world.economy.listing_ids', input.listingIds);
  setTraceValues(attributes, 'world.economy.outbox_message_ids', input.outboxMessageIds);
  setTraceValues(attributes, 'world.economy.run_ids', input.runIds);
  setTraceValues(attributes, 'world.economy.tax_assessment_ids', input.taxAssessmentIds);
  setTraceValues(attributes, 'world.economy.trade_ids', input.tradeIds);
  setTraceValues(attributes, 'world.economy.wallet_transaction_ids', input.walletTransactionIds);
  setTraceValues(
    attributes,
    'world.economy.wallet_refs',
    input.walletIds?.map((walletId) => traceReference('wallet', walletId)),
  );
  return attributes;
}

export function annotateActiveEconomyCommandSpan(input: EconomyCommandTraceCorrelation): void {
  trace.getSpan(context.active())?.setAttributes(economyCommandTraceAttributes(input));
}

function setTraceValue(attributes: Attributes, key: string, value: string | undefined): void {
  const normalized = traceCorrelationValue(value);
  if (normalized !== undefined) attributes[key] = normalized;
}

function setTraceReference(
  attributes: Attributes,
  key: string,
  kind: string,
  value: string | undefined,
): void {
  const normalized = traceCorrelationValue(value);
  if (normalized !== undefined) attributes[key] = traceReference(kind, normalized);
}

function setTraceValues(
  attributes: Attributes,
  key: string,
  values: readonly string[] | undefined,
): void {
  if (!values) return;
  const normalized = [
    ...new Set(
      values
        .map((value) => traceCorrelationValue(value))
        .filter((value): value is string => value !== undefined),
    ),
  ]
    .sort()
    .slice(0, MAX_TRACE_CORRELATION_IDS);
  if (normalized.length > 0) attributes[key] = normalized;
}

function traceCorrelationValue(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > MAX_TRACE_CORRELATION_VALUE_LENGTH ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return undefined;
  }
  return value;
}

function traceReference(kind: string, value: string): string {
  return createHash('sha256')
    .update('worldgraph.observability.reference.v1', 'utf8')
    .update('\0', 'utf8')
    .update(kind, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

const tracer = trace.getTracer('worldgraph');
const readinessValues = new Map<string, number>();
const primitiveCatalogVersionValues = new Map<
  string,
  { kind: string; lifecycle: string; value: number }
>();
const economyObjectCountValues = new Map<string, number>();
let economyLastRepairTimestampSecondsValue: number | undefined;
let economyOpenExpiredOffersValue: number | undefined;
let economyReconciliationMismatchesValue: number | undefined;
let commerceActiveReservationCountValue: number | undefined;
let commerceFailedPayrollCountValue: number | undefined;
let commerceFailedProductionRunCountValue: number | undefined;
let commerceMarketVolumeTradesValue: number | undefined;
let commerceMaxProductionOverdueTicksValue: number | undefined;
let commerceMaxReservationAgeTicksValue: number | undefined;
let commerceOverdueProductionRunCountValue: number | undefined;
let commerceStaleListingCountValue: number | undefined;
let commerceTaxSettlementCountValue: number | undefined;
let commerceTreasuryReconciliationDeltaMinorValue: number | undefined;
let commerceTreasuryReconciliationMismatchCountValue: number | undefined;

interface CounterFacade {
  add(value: number, attributes?: Attributes): void;
}

interface HistogramFacade {
  record(value: number, attributes?: Attributes): void;
}

function bindCounter(name: keyof TelemetryInstruments): CounterFacade {
  return {
    add(value, attributes) {
      const instrument = currentTelemetryInstruments()[name];
      if (!('add' in instrument)) throw new Error('TELEMETRY_COUNTER_BINDING_INVALID');
      instrument.add(value, attributes);
    },
  };
}

function bindHistogram(name: keyof TelemetryInstruments): HistogramFacade {
  return {
    record(value, attributes) {
      const instrument = currentTelemetryInstruments()[name];
      if (!('record' in instrument)) throw new Error('TELEMETRY_HISTOGRAM_BINDING_INVALID');
      instrument.record(value, attributes);
    },
  };
}

function createTelemetryInstruments() {
  const meter = metrics.getMeter('worldgraph');
  const readinessGauge = meter.createObservableGauge('worldgraph_readiness', {
    description: 'Whether a process is currently ready (1) or unavailable (0).',
  });
  readinessGauge.addCallback((result) => {
    for (const [service, value] of readinessValues) result.observe(value, { service });
  });
  const primitiveCatalogVersionsGauge = meter.createObservableGauge(
    'worldgraph_primitive_catalog_versions',
    {
      description: 'Current primitive version count by bounded kind and lifecycle.',
    },
  );
  primitiveCatalogVersionsGauge.addCallback((result) => {
    for (const entry of primitiveCatalogVersionValues.values()) {
      result.observe(entry.value, { kind: entry.kind, lifecycle: entry.lifecycle });
    }
  });
  const economyObjectCountGauge = meter.createObservableGauge('worldgraph_economy_object_count', {
    description: 'Current closed-loop economy object count by bounded kind.',
  });
  economyObjectCountGauge.addCallback((result) => {
    for (const [kind, value] of economyObjectCountValues) result.observe(value, { kind });
  });
  const economyLastRepairTimestampSecondsGauge = meter.createObservableGauge(
    'worldgraph_economy_last_repair_timestamp_seconds',
    { description: 'Unix timestamp of the latest accepted append-only economy repair, or zero.' },
  );
  economyLastRepairTimestampSecondsGauge.addCallback((result) => {
    if (economyLastRepairTimestampSecondsValue !== undefined) {
      result.observe(economyLastRepairTimestampSecondsValue);
    }
  });
  const economyOpenExpiredOffersGauge = meter.createObservableGauge(
    'worldgraph_economy_open_expired_offers',
    { description: 'Open offers at or behind their authoritative world tick.' },
  );
  economyOpenExpiredOffersGauge.addCallback((result) => {
    if (economyOpenExpiredOffersValue !== undefined) {
      result.observe(economyOpenExpiredOffersValue);
    }
  });
  const economyReconciliationMismatchesGauge = meter.createObservableGauge(
    'worldgraph_economy_reconciliation_mismatches',
    { description: 'World economy heads currently frozen by mismatch or failed reconciliation.' },
  );
  economyReconciliationMismatchesGauge.addCallback((result) => {
    if (economyReconciliationMismatchesValue !== undefined) {
      result.observe(economyReconciliationMismatchesValue);
    }
  });
  const commerceActiveReservationsGauge = meter.createObservableGauge(
    'worldgraph_commerce_inventory_reservations_active',
    { description: 'Active inventory reservations in the authoritative economy snapshot.' },
  );
  commerceActiveReservationsGauge.addCallback((result) => {
    if (commerceActiveReservationCountValue !== undefined) {
      result.observe(commerceActiveReservationCountValue);
    }
  });
  const commerceMaxReservationAgeTicksGauge = meter.createObservableGauge(
    'worldgraph_commerce_inventory_reservation_max_age_ticks',
    {
      description:
        'Maximum active inventory-reservation age in authoritative world ticks; values above the exact telemetry integer range are saturated.',
    },
  );
  commerceMaxReservationAgeTicksGauge.addCallback((result) => {
    if (commerceMaxReservationAgeTicksValue !== undefined) {
      result.observe(commerceMaxReservationAgeTicksValue);
    }
  });
  const commerceOverdueProductionRunsGauge = meter.createObservableGauge(
    'worldgraph_commerce_production_runs_overdue',
    { description: 'Ready production runs whose due tick is behind the authoritative world tick.' },
  );
  commerceOverdueProductionRunsGauge.addCallback((result) => {
    if (commerceOverdueProductionRunCountValue !== undefined) {
      result.observe(commerceOverdueProductionRunCountValue);
    }
  });
  const commerceMaxProductionOverdueTicksGauge = meter.createObservableGauge(
    'worldgraph_commerce_production_max_overdue_ticks',
    {
      description:
        'Maximum ready production-run lag in authoritative world ticks; values above the exact telemetry integer range are saturated.',
    },
  );
  commerceMaxProductionOverdueTicksGauge.addCallback((result) => {
    if (commerceMaxProductionOverdueTicksValue !== undefined) {
      result.observe(commerceMaxProductionOverdueTicksValue);
    }
  });
  const commerceFailedProductionRunsGauge = meter.createObservableGauge(
    'worldgraph_commerce_production_runs_failed',
    { description: 'Cumulative failed production-run records in PostgreSQL.' },
  );
  commerceFailedProductionRunsGauge.addCallback((result) => {
    if (commerceFailedProductionRunCountValue !== undefined) {
      result.observe(commerceFailedProductionRunCountValue);
    }
  });
  const commerceFailedPayrollGauge = meter.createObservableGauge(
    'worldgraph_commerce_payroll_records_failed',
    { description: 'Cumulative failed payroll records in PostgreSQL.' },
  );
  commerceFailedPayrollGauge.addCallback((result) => {
    if (commerceFailedPayrollCountValue !== undefined) {
      result.observe(commerceFailedPayrollCountValue);
    }
  });
  const commerceMarketVolumeGauge = meter.createObservableGauge(
    'worldgraph_commerce_market_volume_trades',
    {
      description:
        'Cumulative completed market-trade count; quantities and financial amounts are intentionally excluded.',
    },
  );
  commerceMarketVolumeGauge.addCallback((result) => {
    if (commerceMarketVolumeTradesValue !== undefined) {
      result.observe(commerceMarketVolumeTradesValue);
    }
  });
  const commerceStaleListingsGauge = meter.createObservableGauge(
    'worldgraph_commerce_stale_listings',
    {
      description:
        'Open listings at or behind their expiry tick in the authoritative PostgreSQL snapshot.',
    },
  );
  commerceStaleListingsGauge.addCallback((result) => {
    if (commerceStaleListingCountValue !== undefined) {
      result.observe(commerceStaleListingCountValue);
    }
  });
  const commerceTaxSettlementsGauge = meter.createObservableGauge(
    'worldgraph_commerce_tax_settlements',
    {
      description:
        'Cumulative immutable tax assessments bound to commerce settlement transactions.',
    },
  );
  commerceTaxSettlementsGauge.addCallback((result) => {
    if (commerceTaxSettlementCountValue !== undefined) {
      result.observe(commerceTaxSettlementCountValue);
    }
  });
  const commerceTreasuryReconciliationDeltaGauge = meter.createObservableGauge(
    'worldgraph_commerce_treasury_reconciliation_delta_minor',
    {
      description:
        'Global absolute minor-unit delta between treasury balance projections and immutable postings; values above the exact telemetry integer range are saturated.',
    },
  );
  commerceTreasuryReconciliationDeltaGauge.addCallback((result) => {
    if (commerceTreasuryReconciliationDeltaMinorValue !== undefined) {
      result.observe(commerceTreasuryReconciliationDeltaMinorValue);
    }
  });
  const commerceTreasuryReconciliationMismatchesGauge = meter.createObservableGauge(
    'worldgraph_commerce_treasury_reconciliation_mismatches',
    {
      description:
        'Treasury wallets whose balance projection differs from their immutable posting sum.',
    },
  );
  commerceTreasuryReconciliationMismatchesGauge.addCallback((result) => {
    if (commerceTreasuryReconciliationMismatchCountValue !== undefined) {
      result.observe(commerceTreasuryReconciliationMismatchCountValue);
    }
  });
  return {
    authorizationDecisions: meter.createCounter('worldgraph_authorization_decisions_total'),
    commandConflicts: meter.createCounter('worldgraph_command_conflicts_total'),
    commandDuration: meter.createHistogram('worldgraph_command_duration_ms'),
    commandEvents: meter.createHistogram('worldgraph_command_events'),
    commandOutcomes: meter.createCounter('worldgraph_command_outcomes_total'),
    commandSerializationRetries: meter.createCounter(
      'worldgraph_command_serialization_retries_total',
    ),
    creatorOverrides: meter.createCounter('worldgraph_creator_overrides_total'),
    dependencyLatency: meter.createHistogram('worldgraph_dependency_probe_duration_ms'),
    economyAbuseSignals: meter.createCounter('worldgraph_economy_abuse_signals_total'),
    economyCommands: meter.createCounter('worldgraph_economy_commands_total'),
    economyDueOffers: meter.createHistogram('worldgraph_economy_due_offers'),
    economyExpiredOfferTickLag: meter.createHistogram('worldgraph_economy_expired_offer_tick_lag'),
    economyInitialization: meter.createCounter('worldgraph_economy_initialization_total'),
    economyInvariantFindings: meter.createCounter('worldgraph_economy_invariant_findings_total'),
    economyIssuanceOverrides: meter.createCounter('worldgraph_economy_issuance_overrides_total'),
    economyOfferSweepDuration: meter.createHistogram('worldgraph_economy_offer_sweep_duration_ms'),
    economyOfferSweeps: meter.createCounter('worldgraph_economy_offer_sweeps_total'),
    economyReconciliationDuration: meter.createHistogram(
      'worldgraph_economy_reconciliation_duration_ms',
    ),
    economyReconciliationRuns: meter.createCounter('worldgraph_economy_reconciliation_runs_total'),
    economySerializationRetries: meter.createCounter(
      'worldgraph_economy_serialization_retries_total',
    ),
    httpDuration: meter.createHistogram('worldgraph_http_request_duration_ms'),
    identityAttempts: meter.createCounter('worldgraph_identity_attempts_total'),
    idempotency: meter.createCounter('worldgraph_idempotency_total'),
    invitationLifecycle: meter.createCounter('worldgraph_invitation_lifecycle_total'),
    manifestApprovals: meter.createCounter('worldgraph_manifest_approvals_total'),
    manifestGenerationCost: meter.createHistogram('worldgraph_manifest_generation_cost_microunits'),
    manifestGenerationDuration: meter.createHistogram('worldgraph_manifest_generation_duration_ms'),
    manifestGenerationQueueWait: meter.createHistogram(
      'worldgraph_manifest_generation_queue_wait_ms',
    ),
    manifestGenerationRetrievalCount: meter.createHistogram(
      'worldgraph_manifest_generation_retrieval_count',
    ),
    manifestGenerationRuns: meter.createCounter('worldgraph_manifest_generation_runs_total'),
    manifestPromptCleanup: meter.createCounter('worldgraph_manifest_prompt_cleanup_total'),
    manifestStaleConflicts: meter.createCounter('worldgraph_manifest_stale_conflicts_total'),
    manifestValidationDiagnostics: meter.createCounter(
      'worldgraph_manifest_validation_diagnostics_total',
    ),
    worldCompilationArtifacts: meter.createHistogram('worldgraph_compilation_artifact_items'),
    worldCompilationBacklog: meter.createHistogram('worldgraph_compilation_backlog'),
    worldCompilationBacklogAge: meter.createHistogram('worldgraph_compilation_backlog_age_ms'),
    worldCompilationDuration: meter.createHistogram('worldgraph_compilation_duration_ms'),
    worldCompilationIntegrityFindings: meter.createCounter(
      'worldgraph_compilation_integrity_findings_total',
    ),
    worldCompilationLockWait: meter.createHistogram('worldgraph_compilation_lock_wait_ms'),
    worldCompilationQueueLatency: meter.createHistogram('worldgraph_compilation_queue_latency_ms'),
    worldCompilationRuns: meter.createCounter('worldgraph_compilation_runs_total'),
    worldCompilationSerializationRetries: meter.createCounter(
      'worldgraph_compilation_serialization_retries_total',
    ),
    worldCompilationStageDuration: meter.createHistogram(
      'worldgraph_compilation_stage_duration_ms',
    ),
    primitiveNotifications: meter.createCounter('worldgraph_primitive_notifications_total'),
    primitiveCommandAuditWriteFailures: meter.createCounter(
      'worldgraph_primitive_command_audit_write_failures_total',
    ),
    primitiveCatalogQueries: meter.createCounter('worldgraph_primitive_catalog_queries_total'),
    primitiveMutationFailures: meter.createCounter('worldgraph_primitive_mutation_failures_total'),
    primitivePublishValidationFailures: meter.createCounter(
      'worldgraph_primitive_publish_validation_failures_total',
    ),
    primitiveRetrievalDuration: meter.createHistogram('worldgraph_primitive_retrieval_duration_ms'),
    primitiveRetrievalResults: meter.createHistogram('worldgraph_primitive_retrieval_results'),
    primitiveRetrievals: meter.createCounter('worldgraph_primitive_retrievals_total'),
    sessionLifecycle: meter.createCounter('worldgraph_session_lifecycle_total'),
    smokeJobs: meter.createCounter('worldgraph_system_smoke_jobs_total'),
  };
}

type TelemetryInstruments = ReturnType<typeof createTelemetryInstruments>;
let telemetryInstruments: TelemetryInstruments | undefined;

function currentTelemetryInstruments(): TelemetryInstruments {
  telemetryInstruments ??= createTelemetryInstruments();
  return telemetryInstruments;
}

function rebindTelemetryInstruments(): void {
  telemetryInstruments = createTelemetryInstruments();
}

export const telemetry = {
  authorizationDecisions: bindCounter('authorizationDecisions'),
  commandConflicts: bindCounter('commandConflicts'),
  commandDuration: bindHistogram('commandDuration'),
  commandEvents: bindHistogram('commandEvents'),
  commandOutcomes: bindCounter('commandOutcomes'),
  commandSerializationRetries: bindCounter('commandSerializationRetries'),
  creatorOverrides: bindCounter('creatorOverrides'),
  dependencyLatency: bindHistogram('dependencyLatency'),
  economyAbuseSignals: bindCounter('economyAbuseSignals'),
  economyCommands: bindCounter('economyCommands'),
  economyDueOffers: bindHistogram('economyDueOffers'),
  economyExpiredOfferTickLag: bindHistogram('economyExpiredOfferTickLag'),
  economyInitialization: bindCounter('economyInitialization'),
  economyInvariantFindings: bindCounter('economyInvariantFindings'),
  economyIssuanceOverrides: bindCounter('economyIssuanceOverrides'),
  economyOfferSweepDuration: bindHistogram('economyOfferSweepDuration'),
  economyOfferSweeps: bindCounter('economyOfferSweeps'),
  economyReconciliationDuration: bindHistogram('economyReconciliationDuration'),
  economyReconciliationRuns: bindCounter('economyReconciliationRuns'),
  economySerializationRetries: bindCounter('economySerializationRetries'),
  httpDuration: bindHistogram('httpDuration'),
  identityAttempts: bindCounter('identityAttempts'),
  idempotency: bindCounter('idempotency'),
  invitationLifecycle: bindCounter('invitationLifecycle'),
  manifestApprovals: bindCounter('manifestApprovals'),
  manifestGenerationCost: bindHistogram('manifestGenerationCost'),
  manifestGenerationDuration: bindHistogram('manifestGenerationDuration'),
  manifestGenerationQueueWait: bindHistogram('manifestGenerationQueueWait'),
  manifestGenerationRetrievalCount: bindHistogram('manifestGenerationRetrievalCount'),
  manifestGenerationRuns: bindCounter('manifestGenerationRuns'),
  manifestPromptCleanup: bindCounter('manifestPromptCleanup'),
  manifestStaleConflicts: bindCounter('manifestStaleConflicts'),
  manifestValidationDiagnostics: bindCounter('manifestValidationDiagnostics'),
  worldCompilationArtifacts: bindHistogram('worldCompilationArtifacts'),
  worldCompilationBacklog: bindHistogram('worldCompilationBacklog'),
  worldCompilationBacklogAge: bindHistogram('worldCompilationBacklogAge'),
  worldCompilationDuration: bindHistogram('worldCompilationDuration'),
  worldCompilationIntegrityFindings: bindCounter('worldCompilationIntegrityFindings'),
  worldCompilationLockWait: bindHistogram('worldCompilationLockWait'),
  worldCompilationQueueLatency: bindHistogram('worldCompilationQueueLatency'),
  worldCompilationRuns: bindCounter('worldCompilationRuns'),
  worldCompilationSerializationRetries: bindCounter('worldCompilationSerializationRetries'),
  worldCompilationStageDuration: bindHistogram('worldCompilationStageDuration'),
  primitiveNotifications: bindCounter('primitiveNotifications'),
  primitiveCommandAuditWriteFailures: bindCounter('primitiveCommandAuditWriteFailures'),
  primitiveCatalogQueries: bindCounter('primitiveCatalogQueries'),
  primitiveMutationFailures: bindCounter('primitiveMutationFailures'),
  primitivePublishValidationFailures: bindCounter('primitivePublishValidationFailures'),
  primitiveRetrievalDuration: bindHistogram('primitiveRetrievalDuration'),
  primitiveRetrievalResults: bindHistogram('primitiveRetrievalResults'),
  primitiveRetrievals: bindCounter('primitiveRetrievals'),
  setPrimitiveCatalogVersions(
    entries: readonly { count: number; kind: string; lifecycle: string }[],
  ): void {
    primitiveCatalogVersionValues.clear();
    for (const entry of entries) {
      primitiveCatalogVersionValues.set(`${entry.kind}:${entry.lifecycle}`, {
        kind: entry.kind,
        lifecycle: entry.lifecycle,
        value: entry.count,
      });
    }
  },
  setEconomyOperationalState(input: {
    activeReservationCount: number;
    assetCount: number;
    currencyCount: number;
    failedPayrollCount: number;
    failedProductionRunCount: number;
    lastRepairTimestampSeconds: number;
    marketVolumeTrades: number;
    maxProductionOverdueTicks: number;
    maxReservationAgeTicks: number;
    openExpiredOfferCount: number;
    openOfferCount: number;
    overdueProductionRunCount: number;
    reconciliationMismatchCount: number;
    staleListingCount: number;
    taxSettlementCount: number;
    treasuryReconciliationDeltaMinor: number;
    treasuryReconciliationMismatchCount: number;
    walletCount: number;
  }): void {
    economyObjectCountValues.clear();
    economyObjectCountValues.set('asset', input.assetCount);
    economyObjectCountValues.set('currency', input.currencyCount);
    economyObjectCountValues.set('open_offer', input.openOfferCount);
    economyObjectCountValues.set('wallet', input.walletCount);
    economyLastRepairTimestampSecondsValue = input.lastRepairTimestampSeconds;
    economyOpenExpiredOffersValue = input.openExpiredOfferCount;
    economyReconciliationMismatchesValue = input.reconciliationMismatchCount;
    commerceActiveReservationCountValue = input.activeReservationCount;
    commerceFailedPayrollCountValue = input.failedPayrollCount;
    commerceFailedProductionRunCountValue = input.failedProductionRunCount;
    commerceMarketVolumeTradesValue = input.marketVolumeTrades;
    commerceMaxProductionOverdueTicksValue = input.maxProductionOverdueTicks;
    commerceMaxReservationAgeTicksValue = input.maxReservationAgeTicks;
    commerceOverdueProductionRunCountValue = input.overdueProductionRunCount;
    commerceStaleListingCountValue = input.staleListingCount;
    commerceTaxSettlementCountValue = input.taxSettlementCount;
    commerceTreasuryReconciliationDeltaMinorValue = input.treasuryReconciliationDeltaMinor;
    commerceTreasuryReconciliationMismatchCountValue = input.treasuryReconciliationMismatchCount;
  },
  sessionLifecycle: bindCounter('sessionLifecycle'),
  setReadiness(service: string, ready: boolean): void {
    readinessValues.set(service, ready ? 1 : 0);
  },
  smokeJobs: bindCounter('smokeJobs'),
};

export interface TelemetryRuntime {
  shutdown(): Promise<void>;
}

function exportUrl(base: string, signal: 'metrics' | 'traces'): string {
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return new URL(`v1/${signal}`, normalized).toString();
}

export async function initializeTelemetry(options: {
  endpoint?: string;
  logger: Logger;
  metricReader?: MetricReader;
  service: string;
}): Promise<TelemetryRuntime> {
  if (!options.endpoint && !options.metricReader) {
    options.logger.info({ exporter: 'none', service: options.service }, 'telemetry.local_noop');
    return { shutdown: async () => undefined };
  }

  const sdk = new NodeSDK({
    metricReader:
      options.metricReader ??
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: exportUrl(options.endpoint!, 'metrics') }),
        exportIntervalMillis: 30_000,
      }),
    serviceName: options.service,
    ...(options.endpoint
      ? { traceExporter: new OTLPTraceExporter({ url: exportUrl(options.endpoint, 'traces') }) }
      : {}),
  });
  sdk.start();
  rebindTelemetryInstruments();
  options.logger.info(
    { exporter: options.endpoint ? 'otlp-http' : 'injected', service: options.service },
    'telemetry.started',
  );
  return {
    async shutdown(): Promise<void> {
      await sdk.shutdown();
    },
  };
}

export async function withSpan<T>(name: string, operation: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function withSpanSync<T>(name: string, operation: (span: Span) => T): T {
  return tracer.startActiveSpan(name, (span) => {
    try {
      const result = operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
