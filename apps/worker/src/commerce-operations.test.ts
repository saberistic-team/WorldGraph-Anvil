import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('commerce operations artifacts', () => {
  it('references only emitted low-cardinality M09 worker metrics', async () => {
    const [rules, dashboardText] = await Promise.all([
      readFile(new URL('../../../deploy/alerts/economy-v1.rules.yml', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../deploy/dashboards/economy-v1.grafana.json', import.meta.url),
        'utf8',
      ),
    ]);
    const artifacts = `${rules}\n${dashboardText}`;
    const referenced = new Set(
      (artifacts.match(/worldgraph_commerce_[a-z0-9_]+/gu) ?? []).map((name) =>
        name.replace(/_(?:bucket|count|sum)$/u, ''),
      ),
    );
    const emitted = new Set([
      'worldgraph_commerce_inventory_reservation_max_age_ticks',
      'worldgraph_commerce_inventory_reservations_active',
      'worldgraph_commerce_market_volume_trades',
      'worldgraph_commerce_payroll_records_failed',
      'worldgraph_commerce_production_max_overdue_ticks',
      'worldgraph_commerce_production_runs_failed',
      'worldgraph_commerce_production_runs_overdue',
      'worldgraph_commerce_realtime_publications_total',
      'worldgraph_commerce_scheduled_command_duration_ms',
      'worldgraph_commerce_scheduled_commands_total',
      'worldgraph_commerce_scheduled_effects_pending',
      'worldgraph_commerce_scheduler_lag_ticks',
      'worldgraph_commerce_scheduler_sweep_duration_ms',
      'worldgraph_commerce_scheduler_sweeps_total',
      'worldgraph_commerce_stale_listings',
      'worldgraph_commerce_tax_settlements',
      'worldgraph_commerce_treasury_reconciliation_delta_minor',
      'worldgraph_commerce_treasury_reconciliation_mismatches',
    ]);

    expect([...referenced].filter((name) => !emitted.has(name))).toEqual([]);
    expect([...emitted].filter((name) => !referenced.has(name))).toEqual([]);
    expect(artifacts).not.toMatch(
      /\b(?:amount|business_id|command_id|contract_id|event_id|idempotency_key|inventory_id|listing_id|payroll_id|schedule_id|trade_id|user_id|wallet_id|world_id)\s*=/u,
    );
  });

  it('ships operational, scheduler, and realtime alerts with their actual worker source', async () => {
    const rules = await readFile(
      new URL('../../../deploy/alerts/economy-v1.rules.yml', import.meta.url),
      'utf8',
    );
    for (const alert of [
      'WorldGraphCommerceOperationalMetricsAbsent',
      'WorldGraphCommerceReservationStuck',
      'WorldGraphCommerceProductionOverdue',
      'WorldGraphCommerceProductionFailureBurst',
      'WorldGraphCommercePayrollFailureBurst',
      'WorldGraphCommerceStaleListings',
      'WorldGraphCommerceTreasuryReconciliationMismatch',
      'WorldGraphCommerceScheduledCommandFailing',
      'WorldGraphCommerceSchedulerSweepFailing',
      'WorldGraphCommerceSchedulerLagHigh',
      'WorldGraphCommerceSchedulerStalled',
      'WorldGraphCommerceRealtimePublishFailing',
    ]) {
      const block = rules
        .split(/(?= {6}- alert:)/u)
        .find((candidate) => candidate.includes(`alert: ${alert}`));
      expect(block).toContain('metric_source: commerce_worker_otlp');
    }
  });

  it('keeps the importable dashboard versioned with dedicated M09 panels', async () => {
    const dashboard = JSON.parse(
      await readFile(
        new URL('../../../deploy/dashboards/economy-v1.grafana.json', import.meta.url),
        'utf8',
      ),
    ) as { panels: { id: number; title: string }[]; uid: string; version: number };

    expect(dashboard.uid).toBe('worldgraph-economy-v1');
    expect(dashboard.version).toBe(4);
    expect(dashboard.panels.map((panel) => panel.title)).toEqual(
      expect.arrayContaining([
        'Commerce scheduled commands',
        'Commerce pending effects and tick lag',
        'Commerce scheduler sweeps',
        'Commerce realtime invalidations',
        'Inventory reservation health',
        'Production and payroll health',
        'Market and tax activity',
        'Treasury settlement reconciliation',
      ]),
    );
    expect(new Set(dashboard.panels.map((panel) => panel.id)).size).toBe(dashboard.panels.length);
  });
});
