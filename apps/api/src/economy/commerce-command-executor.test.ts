import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_SCHEDULED_ACTIONS_PER_TICK,
  MAX_SCHEDULED_ACTIONS_PER_WORLD,
} from '@worldgraph/contracts';

import {
  assertCommerceScheduleCapacity,
  commerceFeatureIsEnabled,
  commerceReconciliationStatusAllowsWrite,
  enforceCommercePolicy,
  listingSellerWalletIsActive,
  marketSelfTradeAttempt,
  parseDatabaseQuantity,
  readCommerceCommandTraceCorrelation,
  taxPolicyIsEnabled,
} from './commerce-command-executor.js';
import type { EconomySqlExecutor } from './command-executor.js';
import type { CommerceCommandExecutionInput } from '../commands/types.js';
import {
  CREATE_MARKET_LISTING_COMMAND,
  PERFORM_JOB_COMMAND,
  PURCHASE_MARKET_LISTING_COMMAND,
  START_PRODUCTION_RUN_COMMAND,
} from '../commands/registry.js';

function capacityExecutor(worldCount: number, tickCount: number) {
  const query = vi.fn().mockResolvedValue({
    rows: [{ tick_count: String(tickCount), world_count: String(worldCount) }],
  });
  return { executor: { query } as unknown as EconomySqlExecutor, query };
}

describe('commerce command executor guards', () => {
  it('disables only new listing creation while preserving cancellation', () => {
    const policy = {
      disabledTaxPolicyIds: [],
      jobsEnabled: true,
      listingRateLimitPerMinute: 10,
      listingsEnabled: false,
      productionEnabled: true,
      productionRateLimitPerMinute: 10,
      purchaseRateLimitPerMinute: 20,
      purchasesEnabled: true,
      workRateLimitPerMinute: 10,
    };

    expect(commerceFeatureIsEnabled('CreateMarketListingV1', policy)).toBe(false);
    expect(commerceFeatureIsEnabled('CancelMarketListingV1', policy)).toBe(true);
    expect(commerceFeatureIsEnabled('ExpireMarketListingV1', policy)).toBe(true);
  });

  it('excludes disabled policies while allowing the next eligible job or market policy', async () => {
    const disabledPolicyId = '019c1111-1111-7111-8111-111111111111';
    expect(taxPolicyIsEnabled(disabledPolicyId, [disabledPolicyId])).toBe(false);
    expect(taxPolicyIsEnabled('019c2222-2222-7222-8222-222222222222', [disabledPolicyId])).toBe(
      true,
    );

    const source = await readFile(new URL('commerce-command-executor.ts', import.meta.url), 'utf8');
    const policyLookup = source.slice(
      source.indexOf('async function activeTaxPolicy('),
      source.indexOf('async function findInventoryId('),
    );
    expect(policyLookup).toContain('and not (id = any($4::uuid[]))');
    expect(policyLookup).toContain('and not (id = any($3::uuid[]))');
    expect(policyLookup).toContain('order by policy_version desc,id limit 1');
    expect(policyLookup).toContain(
      "order by case tax_type when 'sales' then 0 else 1 end,policy_version desc,id",
    );
  });

  it('reserves the shared world and due-tick scheduler budget before insertion', async () => {
    const available = capacityExecutor(
      MAX_SCHEDULED_ACTIONS_PER_WORLD - 1,
      MAX_SCHEDULED_ACTIONS_PER_TICK - 1,
    );
    await expect(
      assertCommerceScheduleCapacity(available.executor, 'world-id', 42n),
    ).resolves.toBeUndefined();
    expect(available.query).toHaveBeenCalledWith(expect.stringContaining("status='scheduled'"), [
      'world-id',
      '42',
    ]);

    for (const [worldCount, tickCount] of [
      [MAX_SCHEDULED_ACTIONS_PER_WORLD, 0],
      [0, MAX_SCHEDULED_ACTIONS_PER_TICK],
    ] as const) {
      const full = capacityExecutor(worldCount, tickCount);
      await expect(
        assertCommerceScheduleCapacity(full.executor, 'world-id', 42n),
      ).rejects.toMatchObject({ code: 'SIMULATION_BUDGET_EXCEEDED' });
    }
  });

  it('lets reconciliation inspect mismatch states without opening normal writes', () => {
    for (const status of ['failed', 'mismatch'] as const) {
      expect(commerceReconciliationStatusAllowsWrite(status, 'must_exist')).toBe(false);
      expect(commerceReconciliationStatusAllowsWrite(status, 'must_not_exist')).toBe(false);
      expect(commerceReconciliationStatusAllowsWrite(status, 'reconcile')).toBe(true);
    }
    for (const status of ['current', 'pending'] as const) {
      expect(commerceReconciliationStatusAllowsWrite(status, 'must_exist')).toBe(true);
    }
  });

  it('requires an active seller wallet for new listings', () => {
    expect(listingSellerWalletIsActive('active')).toBe(true);
    expect(listingSellerWalletIsActive('frozen')).toBe(false);
    expect(listingSellerWalletIsActive('closed')).toBe(false);
  });

  it('accepts PostgreSQL numeric padding only when it is zero beyond the resource scale', () => {
    expect(parseDatabaseQuantity('100.000000000000', 0)).toBe(100n);
    expect(parseDatabaseQuantity('1.230000000000', 2)).toBe(123n);
    expect(() => parseDatabaseQuantity('1.230100000000', 2)).toThrow(
      'Database quantity exceeds its declared scale.',
    );
  });

  it('emits bounded abuse signals without attaching participant or financial identifiers', async () => {
    const [commerceSource, economySource] = await Promise.all([
      readFile(new URL('commerce-command-executor.ts', import.meta.url), 'utf8'),
      readFile(new URL('command-executor.ts', import.meta.url), 'utf8'),
    ]);

    expect(commerceSource).toContain(
      "telemetry.economyAbuseSignals.add(1, { signal: 'self_trade_attempt' })",
    );
    expect(economySource).toContain(
      "telemetry.economyAbuseSignals.add(1, { signal: 'rapid_circular_transfer' })",
    );
    expect(economySource).toContain("and tx.transaction_kind = 'transfer'");
    expect(economySource).toContain('with recursive recent_edges');
    expect(economySource).toContain(
      'join reachable path on edge.source_wallet_id = path.wallet_id',
    );
    expect(economySource).toContain(
      'tx.occurred_tick between greatest($4::bigint - 10, 0) and $4::bigint',
    );
  });

  it('classifies self-trade attempts only after buyer control and across actor-controlled entities', () => {
    expect(
      marketSelfTradeAttempt({
        buyerEntityId: 'character:buyer',
        buyerWalletControlled: false,
        sellerControlledByActor: true,
        sellerEntityId: 'organization:seller',
      }),
    ).toBe(false);
    expect(
      marketSelfTradeAttempt({
        buyerEntityId: 'character:buyer',
        buyerWalletControlled: true,
        sellerControlledByActor: true,
        sellerEntityId: 'organization:seller',
      }),
    ).toBe(true);
    expect(
      marketSelfTradeAttempt({
        buyerEntityId: 'organization:seller',
        buyerWalletControlled: true,
        sellerControlledByActor: false,
        sellerEntityId: 'organization:seller',
      }),
    ).toBe(true);
    expect(
      marketSelfTradeAttempt({
        buyerEntityId: 'character:buyer',
        buyerWalletControlled: true,
        sellerControlledByActor: false,
        sellerEntityId: 'organization:seller',
      }),
    ).toBe(false);
  });

  it('enforces each public commerce mutation velocity limit from durable command usage', async () => {
    const decidedAt = new Date('2026-07-22T12:00:00.000Z');
    const scopeHash = Buffer.alloc(32, 1);
    const policy = {
      disabledTaxPolicyIds: [],
      jobsEnabled: true,
      listingRateLimitPerMinute: 1,
      listingsEnabled: true,
      productionEnabled: true,
      productionRateLimitPerMinute: 1,
      purchaseRateLimitPerMinute: 1,
      purchasesEnabled: true,
      workRateLimitPerMinute: 1,
    };
    for (const type of [
      PERFORM_JOB_COMMAND,
      START_PRODUCTION_RUN_COMMAND,
      CREATE_MARKET_LISTING_COMMAND,
      PURCHASE_MARKET_LISTING_COMMAND,
    ]) {
      const query = vi.fn().mockResolvedValue({ rows: [{ command_count: '1' }] });
      const input = {
        command: {
          actorId: 'actor-id',
          actorType: 'user',
          commandId: 'command-id',
          rateLimitScopeHash: scopeHash,
          worldId: 'world-id',
        },
        decidedAt,
        policy,
        request: { type },
      } as unknown as CommerceCommandExecutionInput;

      await expect(
        enforceCommercePolicy({ query } as EconomySqlExecutor, input),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
      expect(query).toHaveBeenCalledWith(expect.stringContaining("interval '1 minute'"), [
        'world-id',
        'user',
        'actor-id',
        type,
        'command-id',
        scopeHash,
        decidedAt,
      ]);
    }
  });

  it('exhausts one world and target scope without consuming another world or target', async () => {
    const decidedAt = new Date('2026-07-22T12:00:00.000Z');
    const exhaustedScope = Buffer.alloc(32, 1);
    const independentScope = Buffer.alloc(32, 2);
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows: [
        {
          command_count:
            values?.[0] === 'world-a' && Buffer.from(values?.[5] as Buffer).equals(exhaustedScope)
              ? '1'
              : '0',
        },
      ],
    }));
    const policy = {
      disabledTaxPolicyIds: [],
      jobsEnabled: true,
      listingRateLimitPerMinute: 1,
      listingsEnabled: true,
      productionEnabled: true,
      productionRateLimitPerMinute: 1,
      purchaseRateLimitPerMinute: 1,
      purchasesEnabled: true,
      workRateLimitPerMinute: 1,
    };
    const input = (rateLimitScopeHash: Buffer, worldId = 'world-a') =>
      ({
        command: {
          actorId: 'actor-id',
          actorType: 'user',
          commandId: 'command-id',
          rateLimitScopeHash,
          worldId,
        },
        decidedAt,
        policy,
        request: { type: CREATE_MARKET_LISTING_COMMAND },
      }) as unknown as CommerceCommandExecutionInput;

    await expect(
      enforceCommercePolicy({ query } as unknown as EconomySqlExecutor, input(exhaustedScope)),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
    await expect(
      enforceCommercePolicy({ query } as unknown as EconomySqlExecutor, input(independentScope)),
    ).resolves.toBeUndefined();
    await expect(
      enforceCommercePolicy(
        { query } as unknown as EconomySqlExecutor,
        input(exhaustedScope, 'world-b'),
      ),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toContain('where world_id=$1');
    expect(query.mock.calls[0]?.[0]).toContain('requested_at <= $7::timestamptz');
  });

  it('fails closed when a limited command has no valid server-derived target scope', async () => {
    const query = vi.fn();
    await expect(
      enforceCommercePolicy({ query }, {
        command: {
          actorId: 'actor-id',
          actorType: 'user',
          commandId: 'command-id',
          rateLimitScopeHash: null,
          worldId: 'world-id',
        },
        decidedAt: new Date('2026-07-22T12:00:00.000Z'),
        policy: {
          disabledTaxPolicyIds: [],
          jobsEnabled: true,
          listingRateLimitPerMinute: 1,
          listingsEnabled: true,
          productionEnabled: true,
          productionRateLimitPerMinute: 1,
          purchaseRateLimitPerMinute: 1,
          purchasesEnabled: true,
          workRateLimitPerMinute: 1,
        },
        request: { type: PERFORM_JOB_COMMAND },
      } as unknown as CommerceCommandExecutionInput),
    ).rejects.toThrow('COMMERCE_RATE_LIMIT_SCOPE_INVALID');
    expect(query).not.toHaveBeenCalled();
  });

  it('loads committed economy trace correlation without selecting private financial values', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          database_transaction_id: '9821',
          event_ids: ['event-id'],
          listing_ids: ['listing-id'],
          outbox_message_ids: ['outbox-id'],
          run_ids: ['production-run-id'],
          tax_assessment_ids: ['tax-assessment-id'],
          trade_ids: ['trade-id'],
          wallet_ids: ['wallet-id'],
          wallet_transaction_ids: ['wallet-transaction-id'],
        },
      ],
    });

    await expect(
      readCommerceCommandTraceCorrelation({ query }, 'world-id', 'command-id'),
    ).resolves.toEqual({
      databaseTransactionId: '9821',
      eventIds: ['event-id'],
      listingIds: ['listing-id'],
      outboxMessageIds: ['outbox-id'],
      runIds: ['production-run-id'],
      taxAssessmentIds: ['tax-assessment-id'],
      tradeIds: ['trade-id'],
      walletIds: ['wallet-id'],
      walletTransactionIds: ['wallet-transaction-id'],
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('txid_current()'), [
      'world-id',
      'command-id',
    ]);
    for (const table of [
      'domain_events',
      'economy_expansion_reconciliation_runs',
      'financial_transactions',
      'market_listings',
      'market_trades',
      'outbox_messages',
      'production_runs',
      'tax_assessments',
      'wallet_postings',
    ]) {
      expect(sql).toContain(table);
    }
    expect(sql).not.toMatch(/\b(?:amount|balance|memo|payload|price|quantity)_/u);
  });
});
