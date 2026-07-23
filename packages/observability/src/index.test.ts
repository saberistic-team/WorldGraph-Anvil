import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

import {
  createLogger,
  economyCommandTraceAttributes,
  initializeTelemetry,
  redactSensitive,
  telemetry,
} from './index.js';

describe('telemetry redaction', () => {
  it('correlates economy traces without exposing actor, wallet, world, or idempotency identity', () => {
    const attributes = economyCommandTraceAttributes({
      actorId: 'actor-private-identity',
      commandId: 'command-id',
      commandType: 'PurchaseMarketListingV1',
      correlationId: 'correlation-id',
      databaseTransactionId: '9821',
      eventIds: ['event-b', 'event-a'],
      idempotencyKey: 'purchase-private-idempotency-key',
      listingIds: ['listing-id'],
      outboxMessageIds: ['outbox-id'],
      runIds: ['run-id'],
      taxAssessmentIds: ['tax-assessment-id'],
      tick: '42',
      tradeIds: ['trade-id'],
      walletIds: ['wallet-private-b', 'wallet-private-a', 'wallet-private-a'],
      walletTransactionIds: ['wallet-transaction-id'],
      worldId: 'world-private-identity',
    });

    expect(attributes).toMatchObject({
      'world.economy.command_id': 'command-id',
      'world.economy.command_type': 'PurchaseMarketListingV1',
      'world.economy.correlation_id': 'correlation-id',
      'world.economy.database_transaction_id': '9821',
      'world.economy.event_ids': ['event-a', 'event-b'],
      'world.economy.listing_ids': ['listing-id'],
      'world.economy.outbox_message_ids': ['outbox-id'],
      'world.economy.run_ids': ['run-id'],
      'world.economy.tax_assessment_ids': ['tax-assessment-id'],
      'world.economy.tick': '42',
      'world.economy.trade_ids': ['trade-id'],
      'world.economy.wallet_transaction_ids': ['wallet-transaction-id'],
    });
    for (const key of [
      'world.economy.actor_ref',
      'world.economy.idempotency_key_ref',
      'world.economy.world_ref',
    ]) {
      expect(attributes[key]).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(attributes['world.economy.wallet_refs']).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    const serialized = JSON.stringify(attributes);
    for (const privateValue of [
      'actor-private-identity',
      'purchase-private-idempotency-key',
      'wallet-private-a',
      'wallet-private-b',
      'world-private-identity',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toMatch(/amount|balance|memo|payload|price/u);
  });

  it('bounds and sanitizes economy trace correlation collections', () => {
    const attributes = economyCommandTraceAttributes({
      actorId: `a`.repeat(129),
      eventIds: [
        ...Array.from({ length: 40 }, (_, index) => `event-${String(index).padStart(2, '0')}`),
        'event-00',
        'event-with-control\u0000',
      ],
    });

    expect(attributes['world.economy.actor_ref']).toBeUndefined();
    expect(attributes['world.economy.event_ids']).toHaveLength(32);
    expect(attributes['world.economy.event_ids']).toEqual(
      Array.from({ length: 32 }, (_, index) => `event-${String(index).padStart(2, '0')}`),
    );
  });

  it('redacts nested sensitive keys without changing safe values', () => {
    expect(
      redactSensitive({
        authorization: 'Bearer hidden',
        canonical_manifest: { private: 'world design' },
        entity_state: { private: 'runtime state' },
        memo: 'private transfer note',
        nested: { cookie: 'hidden', requestId: 'safe' },
        passwordHash: 'hidden',
        price: '12.50',
        promptText: 'private creator prompt',
        walletId: 'private-wallet',
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      canonical_manifest: '[REDACTED]',
      entity_state: '[REDACTED]',
      memo: '[REDACTED]',
      nested: { cookie: '[REDACTED]', requestId: 'safe' },
      passwordHash: '[REDACTED]',
      price: '[REDACTED]',
      promptText: '[REDACTED]',
      walletId: '[REDACTED]',
    });
  });

  it('removes credentials embedded in error text and omits stack traces', () => {
    const redacted = redactSensitive(
      new Error('request Bearer abc123 failed at postgres://user:pass@db/world'),
    );
    expect(redacted).toEqual({
      message: 'request Bearer [REDACTED] failed at postgres://[REDACTED]@db/world',
      name: 'Error',
    });
  });

  it('redacts credential material in root strings', () => {
    expect(redactSensitive('request failed: authPepper=do-not-log token=secret')).toBe(
      'request failed: authPepper=[REDACTED] token=[REDACTED]',
    );
  });

  it('binds application instruments after SDK registration and exports recorded values', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const runtime = await initializeTelemetry({
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'observability-test',
      }),
      metricReader: reader,
      service: 'worldgraph-observability-test',
    });

    telemetry.primitiveMutationFailures.add(1, {
      action: 'primitive.version.publish',
      reason_code: 'UNEXPECTED_FAILURE',
    });
    telemetry.manifestGenerationRuns.add(1, {
      fallback: 'true',
      outcome: 'succeeded',
      provider: 'disabled',
    });
    telemetry.worldCompilationBacklogAge.record(2_500, { state: 'queued' });
    telemetry.worldCompilationIntegrityFindings.add(1, { check: 'hash_mismatch' });
    telemetry.worldCompilationLockWait.record(17, { operation: 'activate' });
    telemetry.worldCompilationQueueLatency.record(800, { outcome: 'claimed' });
    telemetry.worldCompilationSerializationRetries.add(1, { operation: 'activate' });
    telemetry.worldCompilationStageDuration.record(24, {
      outcome: 'succeeded',
      stage: 'compile',
    });
    telemetry.commandOutcomes.add(1, {
      command_type: 'RenameWorldEntityV1',
      outcome: 'accepted',
      rejection_code: 'none',
    });
    telemetry.commandDuration.record(12, { command_type: 'RenameWorldEntityV1' });
    telemetry.commandEvents.record(1, {
      command_type: 'RenameWorldEntityV1',
      outcome: 'accepted',
    });
    telemetry.economyReconciliationRuns.add(1, {
      outcome: 'matched',
      trigger: 'command',
    });
    telemetry.economyReconciliationDuration.record(8, { outcome: 'matched' });
    telemetry.economyOfferSweeps.add(1, { outcome: 'succeeded' });
    telemetry.economyOfferSweepDuration.record(6, { outcome: 'succeeded' });
    telemetry.economyDueOffers.record(2, { outcome: 'discovered' });
    telemetry.economyExpiredOfferTickLag.record(1, { outcome: 'expired' });
    telemetry.economyAbuseSignals.add(1, { signal: 'self_trade_attempt' });
    telemetry.setEconomyOperationalState({
      activeReservationCount: 5,
      assetCount: 3,
      currencyCount: 1,
      failedPayrollCount: 2,
      failedProductionRunCount: 1,
      lastRepairTimestampSeconds: 1_784_750_400,
      marketVolumeTrades: 12,
      maxProductionOverdueTicks: 4,
      maxReservationAgeTicks: 7,
      openExpiredOfferCount: 2,
      openOfferCount: 4,
      overdueProductionRunCount: 3,
      reconciliationMismatchCount: 1,
      staleListingCount: 2,
      taxSettlementCount: 9,
      treasuryReconciliationDeltaMinor: 6,
      treasuryReconciliationMismatchCount: 1,
      walletCount: 8,
    });
    telemetry.setPrimitiveCatalogVersions([
      { count: 16, kind: 'government', lifecycle: 'published' },
    ]);
    await reader.forceFlush();

    const names = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .map((metric) => metric.descriptor.name);
    expect(names).toContain('worldgraph_primitive_mutation_failures_total');
    expect(names).toContain('worldgraph_primitive_catalog_versions');
    expect(names).toContain('worldgraph_manifest_generation_runs_total');
    expect(names).toContain('worldgraph_compilation_backlog_age_ms');
    expect(names).toContain('worldgraph_compilation_integrity_findings_total');
    expect(names).toContain('worldgraph_compilation_lock_wait_ms');
    expect(names).toContain('worldgraph_compilation_queue_latency_ms');
    expect(names).toContain('worldgraph_compilation_serialization_retries_total');
    expect(names).toContain('worldgraph_compilation_stage_duration_ms');
    expect(names).toContain('worldgraph_command_outcomes_total');
    expect(names).toContain('worldgraph_command_duration_ms');
    expect(names).toContain('worldgraph_command_events');
    expect(names).toContain('worldgraph_economy_reconciliation_runs_total');
    expect(names).toContain('worldgraph_economy_reconciliation_duration_ms');
    expect(names).toContain('worldgraph_economy_offer_sweeps_total');
    expect(names).toContain('worldgraph_economy_offer_sweep_duration_ms');
    expect(names).toContain('worldgraph_economy_due_offers');
    expect(names).toContain('worldgraph_economy_expired_offer_tick_lag');
    expect(names).toContain('worldgraph_economy_abuse_signals_total');
    expect(names).toContain('worldgraph_economy_object_count');
    expect(names).toContain('worldgraph_economy_last_repair_timestamp_seconds');
    expect(names).toContain('worldgraph_economy_open_expired_offers');
    expect(names).toContain('worldgraph_economy_reconciliation_mismatches');
    for (const name of [
      'worldgraph_commerce_inventory_reservations_active',
      'worldgraph_commerce_inventory_reservation_max_age_ticks',
      'worldgraph_commerce_production_runs_overdue',
      'worldgraph_commerce_production_max_overdue_ticks',
      'worldgraph_commerce_production_runs_failed',
      'worldgraph_commerce_payroll_records_failed',
      'worldgraph_commerce_market_volume_trades',
      'worldgraph_commerce_stale_listings',
      'worldgraph_commerce_tax_settlements',
      'worldgraph_commerce_treasury_reconciliation_delta_minor',
      'worldgraph_commerce_treasury_reconciliation_mismatches',
    ]) {
      expect(names).toContain(name);
    }
    const snapshotMetrics = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name.startsWith('worldgraph_commerce_'));
    for (const metric of snapshotMetrics) {
      const points = (
        metric as unknown as {
          dataPoints: { attributes: Record<string, unknown>; value: number }[];
        }
      ).dataPoints;
      expect(points).toHaveLength(1);
      expect(points[0]?.attributes).toEqual({});
    }
    expect(
      Object.fromEntries(
        snapshotMetrics.map((metric) => [
          metric.descriptor.name,
          (
            metric as unknown as {
              dataPoints: { value: number }[];
            }
          ).dataPoints[0]?.value,
        ]),
      ),
    ).toMatchObject({
      worldgraph_commerce_inventory_reservation_max_age_ticks: 7,
      worldgraph_commerce_inventory_reservations_active: 5,
      worldgraph_commerce_market_volume_trades: 12,
      worldgraph_commerce_payroll_records_failed: 2,
      worldgraph_commerce_production_max_overdue_ticks: 4,
      worldgraph_commerce_production_runs_failed: 1,
      worldgraph_commerce_production_runs_overdue: 3,
      worldgraph_commerce_stale_listings: 2,
      worldgraph_commerce_tax_settlements: 9,
      worldgraph_commerce_treasury_reconciliation_delta_minor: 6,
      worldgraph_commerce_treasury_reconciliation_mismatches: 1,
    });
    await runtime.shutdown();
  });

  it('ships versioned compiler alerts over exported low-cardinality metrics', async () => {
    const rules = await readFile(
      new URL('../../../deploy/alerts/deterministic-compiler-v1.rules.yml', import.meta.url),
      'utf8',
    );

    for (const alert of [
      'WorldGraphCompilationBacklogStuck',
      'WorldGraphCompilationFailureSpike',
      'WorldGraphCompilationUnsupportedAdapter',
      'WorldGraphCompilationLockWaitHigh',
      'WorldGraphCompilationArtifactUnusuallyLarge',
      'WorldGraphCompilationActivationInconsistent',
      'WorldGraphCompilationDeterminismRegression',
    ]) {
      expect(rules).toContain(`alert: ${alert}`);
    }
    for (const metric of [
      'worldgraph_compilation_artifact_items_bucket',
      'worldgraph_compilation_backlog_age_ms_sum',
      'worldgraph_compilation_integrity_findings_total',
      'worldgraph_compilation_lock_wait_ms_bucket',
      'worldgraph_compilation_runs_total',
      'worldgraph_compilation_serialization_retries_total',
    ]) {
      expect(rules).toContain(metric);
    }
    expect(rules).not.toMatch(/\b(?:artifact_hash|input_hash|run_id|world_id)\s*=/u);
  });

  it('ships command and outbox alerts without high-cardinality world identifiers', async () => {
    const rules = await readFile(
      new URL('../../../deploy/alerts/command-ledger-v1.rules.yml', import.meta.url),
      'utf8',
    );
    for (const alert of [
      'WorldGraphCommandFailureSpike',
      'WorldGraphCommandSerializationContention',
      'WorldGraphCommandConflictSpike',
      'WorldGraphOutboxStuck',
      'WorldGraphOutboxDeadLetter',
    ]) {
      expect(rules).toContain(`alert: ${alert}`);
    }
    for (const metric of [
      'worldgraph_command_conflicts_total',
      'worldgraph_command_outcomes_total',
      'worldgraph_command_serialization_retries_total',
      'worldgraph_outbox_dead_sum',
      'worldgraph_outbox_oldest_age_ms_sum',
    ]) {
      expect(rules).toContain(metric);
    }
    expect(rules).not.toMatch(/\b(?:command_id|event_id|world_id)\s*=/u);
  });

  it('ships economy panels and alerts only for metrics with production producers', async () => {
    const [rules, dashboard] = await Promise.all([
      readFile(new URL('../../../deploy/alerts/economy-v1.rules.yml', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../deploy/dashboards/economy-v1.grafana.json', import.meta.url),
        'utf8',
      ),
    ]);
    const deployed = `${rules}\n${dashboard}`;
    for (const metric of [
      'worldgraph_economy_object_count',
      'worldgraph_economy_last_repair_timestamp_seconds',
      'worldgraph_economy_offer_sweeps_total',
      'worldgraph_economy_abuse_signals_total',
      'worldgraph_economy_open_expired_offers',
      'worldgraph_economy_reconciliation_mismatches',
      'worldgraph_commerce_inventory_reservations_active',
      'worldgraph_commerce_inventory_reservation_max_age_ticks',
      'worldgraph_commerce_production_runs_overdue',
      'worldgraph_commerce_production_max_overdue_ticks',
      'worldgraph_commerce_production_runs_failed',
      'worldgraph_commerce_payroll_records_failed',
      'worldgraph_commerce_market_volume_trades',
      'worldgraph_commerce_stale_listings',
      'worldgraph_commerce_tax_settlements',
      'worldgraph_commerce_treasury_reconciliation_delta_minor',
      'worldgraph_commerce_treasury_reconciliation_mismatches',
    ]) {
      expect(deployed).toContain(metric);
    }
    expect(deployed).not.toContain('worldgraph_postgres_economy_');
    expect(rules).toContain('alert: WorldGraphEconomyMetricsAbsent');
    expect(rules).toContain('alert: WorldGraphEconomyOfferSweepFailing');
    expect(rules).toContain('alert: WorldGraphEconomyAbuseSignalBurst');
    expect(rules).toContain('alert: WorldGraphEconomyRepairExecuted');
    expect(rules).not.toContain('operation="repair"');
  });
});
