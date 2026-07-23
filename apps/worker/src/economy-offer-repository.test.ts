import { describe, expect, it, vi } from 'vitest';

import { PostgresEconomyOfferRepository } from './economy-offer-repository.js';

describe('Postgres authoritative offer discovery', () => {
  it('orders and bounds due offers using the persisted simulation tick', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({
      rows: [
        {
          current_tick: '12',
          expected_offer_version: '2',
          expected_state_revision: '7',
          expected_world_version: '1',
          expires_at_tick: '10',
          offer_id: '018f8652-3cb6-7d52-904b-cce7901d7e24',
          world_id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        },
      ],
    }));
    const repository = new PostgresEconomyOfferRepository({ query } as never);
    await expect(repository.findDueOffers(25)).resolves.toEqual([
      expect.objectContaining({ currentTick: '12', expiresAtTick: '10' }),
    ]);
    expect(query.mock.calls[0]?.[0]).toContain('worldgraph_due_asset_transfer_offers(null,$1)');
    expect(query.mock.calls[0]?.[0]).toContain(
      'order by due.expires_at_tick, due.world_id, due.offer_id',
    );
    expect(query.mock.calls[0]?.[0]).not.toMatch(/statement_timestamp|current_timestamp|now\(\)/iu);
    expect(query.mock.calls[0]?.[1]).toEqual([25]);
  });

  it('rejects malformed or not-yet-due database rows', async () => {
    const repository = new PostgresEconomyOfferRepository({
      query: vi.fn(async () => ({
        rows: [
          {
            current_tick: '9',
            expected_offer_version: '1',
            expected_state_revision: '1',
            expected_world_version: '1',
            expires_at_tick: '10',
            offer_id: '018f8652-3cb6-7d52-904b-cce7901d7e24',
            world_id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
          },
        ],
      })),
    } as never);
    await expect(repository.findDueOffers(1)).rejects.toThrow('ECONOMY_DUE_OFFER_ROW_INVALID');
    await expect(repository.findDueOffers(0)).rejects.toThrow(
      'ECONOMY_OFFER_DISCOVERY_LIMIT_INVALID',
    );
  });

  it('reads bounded global operational counts from authoritative tables and ticks', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({
      rows: [
        {
          active_reservation_count: '5',
          asset_count: '3',
          currency_count: '1',
          failed_payroll_count: '2',
          failed_production_run_count: '1',
          last_repair_timestamp_seconds: '1784750400',
          market_volume_trades: '12',
          max_production_overdue_ticks: '4',
          max_reservation_age_ticks: '7',
          open_expired_offer_count: '2',
          open_offer_count: '4',
          overdue_production_run_count: '3',
          reconciliation_mismatch_count: '1',
          stale_listing_count: '2',
          tax_settlement_count: '9',
          treasury_reconciliation_delta_minor: '6',
          treasury_reconciliation_mismatch_count: '1',
          wallet_count: '8',
        },
      ],
    }));
    const repository = new PostgresEconomyOfferRepository({ query } as never);
    await expect(repository.readOperationalSnapshot()).resolves.toEqual({
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
    expect(query.mock.calls[0]?.[0]).toContain(
      "clock.current_tick - (created_event.payload ->> 'tick')::bigint",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "run.status = 'ready' and run.due_tick < clock.current_tick",
    );
    expect(query.mock.calls[0]?.[0]).toContain('offer.expires_at_tick <= clock.current_tick');
    expect(query.mock.calls[0]?.[0]).toContain(
      "listing.status = 'open' and listing.expires_at_tick <= clock.current_tick",
    );
    expect(query.mock.calls[0]?.[0]).toContain('sum(posting.signed_amount_minor::numeric)');
    expect(query.mock.calls[0]?.[0]).toContain(
      'coalesce(balance.available_minor,0)::numeric - coalesce(posted.posted_minor,0)',
    );
    expect(query.mock.calls[0]?.[0]).toContain('where balance.wallet_id is null');
    expect(query.mock.calls[0]?.[0]).toContain(
      'worldgraph_economy_last_repair_timestamp_seconds()',
    );
    expect(query.mock.calls[0]?.[0]).not.toMatch(/statement_timestamp|current_timestamp|now\(\)/iu);
  });

  it('saturates oversized tick and treasury observations without accepting oversized counts', async () => {
    const row = {
      active_reservation_count: '0',
      asset_count: '0',
      currency_count: '0',
      failed_payroll_count: '0',
      failed_production_run_count: '0',
      last_repair_timestamp_seconds: '0',
      market_volume_trades: '0',
      max_production_overdue_ticks: '9223372036854775807',
      max_reservation_age_ticks: '9223372036854775807',
      open_expired_offer_count: '0',
      open_offer_count: '0',
      overdue_production_run_count: '0',
      reconciliation_mismatch_count: '0',
      stale_listing_count: '0',
      tax_settlement_count: '0',
      treasury_reconciliation_delta_minor: '18446744073709551614',
      treasury_reconciliation_mismatch_count: '0',
      wallet_count: '0',
    };
    const repository = new PostgresEconomyOfferRepository({
      query: vi.fn(async () => ({ rows: [row] })),
    } as never);
    await expect(repository.readOperationalSnapshot()).resolves.toMatchObject({
      maxProductionOverdueTicks: Number.MAX_SAFE_INTEGER,
      maxReservationAgeTicks: Number.MAX_SAFE_INTEGER,
      treasuryReconciliationDeltaMinor: Number.MAX_SAFE_INTEGER,
    });

    const invalidRepository = new PostgresEconomyOfferRepository({
      query: vi.fn(async () => ({
        rows: [{ ...row, active_reservation_count: '9007199254740992' }],
      })),
    } as never);
    await expect(invalidRepository.readOperationalSnapshot()).rejects.toThrow(
      'ECONOMY_OPERATIONAL_SNAPSHOT_INVALID',
    );
  });
});
