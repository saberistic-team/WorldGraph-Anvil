import type { Pool, QueryResultRow } from 'pg';

const CANONICAL_NONNEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface DueAssetTransferOffer {
  currentTick: string;
  expectedOfferVersion: string;
  expectedStateRevision: string;
  expectedWorldVersion: string;
  expiresAtTick: string;
  offerId: string;
  worldId: string;
}

export interface EconomyOperationalSnapshot {
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
}

export interface EconomyOfferRepository {
  findDueOffers(limit: number): Promise<DueAssetTransferOffer[]>;
  readOperationalSnapshot(): Promise<EconomyOperationalSnapshot>;
}

interface DueOfferRow extends QueryResultRow {
  current_tick: string;
  expected_offer_version: string;
  expected_state_revision: string;
  expected_world_version: string;
  expires_at_tick: string;
  offer_id: string;
  world_id: string;
}

interface EconomyOperationalRow extends QueryResultRow {
  active_reservation_count: string;
  asset_count: string;
  currency_count: string;
  failed_payroll_count: string;
  failed_production_run_count: string;
  last_repair_timestamp_seconds: string;
  market_volume_trades: string;
  max_production_overdue_ticks: string;
  max_reservation_age_ticks: string;
  open_expired_offer_count: string;
  open_offer_count: string;
  overdue_production_run_count: string;
  reconciliation_mismatch_count: string;
  stale_listing_count: string;
  tax_settlement_count: string;
  treasury_reconciliation_delta_minor: string;
  treasury_reconciliation_mismatch_count: string;
  wallet_count: string;
}

/**
 * Discovery is deliberately PostgreSQL/tick based. The polling cadence wakes the
 * query but is never consulted to decide whether an offer is due.
 */
export class PostgresEconomyOfferRepository implements EconomyOfferRepository {
  public constructor(private readonly pool: Pool) {}

  public async findDueOffers(limit: number): Promise<DueAssetTransferOffer[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
      throw new Error('ECONOMY_OFFER_DISCOVERY_LIMIT_INVALID');
    }
    const result = await this.pool.query<DueOfferRow>(
      `select due.world_id,
              due.offer_id,
              due.expires_at_tick::text,
              due.offer_version::text as expected_offer_version,
              due.current_tick::text,
              runtime.state_revision::text as expected_state_revision,
              version.version_number::text as expected_world_version
         from worldgraph_due_asset_transfer_offers(null,$1) due
         join worlds world on world.id = due.world_id
         join world_runtime_heads runtime on runtime.world_id = due.world_id
         join world_versions version
           on version.id = runtime.active_world_version_id
           and version.world_id = runtime.world_id
         join world_economy_heads economy on economy.world_id = due.world_id
        where world.lifecycle = 'active'
          and world.archived_at is null
          and economy.initialized_event_id is not null
        order by due.expires_at_tick, due.world_id, due.offer_id`,
      [limit],
    );
    return result.rows.map(mapDueOffer);
  }

  public async readOperationalSnapshot(): Promise<EconomyOperationalSnapshot> {
    const result = await this.pool.query<EconomyOperationalRow>(
      `with active_reservation_state as (
         select count(*)::text as active_reservation_count,
                coalesce(max(greatest(
                  clock.current_tick - (created_event.payload ->> 'tick')::bigint,
                  0
                )),0)::text as max_reservation_age_ticks
           from inventory_reservations reservation
           join world_simulation_clocks clock on clock.world_id = reservation.world_id
           join domain_events created_event
             on created_event.world_id = reservation.world_id
            and created_event.id = reservation.created_event_id
          where reservation.status = 'active'
       ),
       production_state as (
         select count(*) filter (where run.status = 'failed')::text
                  as failed_production_run_count,
                count(*) filter (
                  where run.status = 'ready' and run.due_tick < clock.current_tick
                )::text as overdue_production_run_count,
                coalesce(max(
                  case when run.status = 'ready' and run.due_tick < clock.current_tick
                    then clock.current_tick - run.due_tick else 0 end
                ),0)::text as max_production_overdue_ticks
           from production_runs run
           join world_simulation_clocks clock on clock.world_id = run.world_id
       ),
       treasury_posted as (
         select posting.world_id, posting.currency_id, posting.wallet_id,
                sum(posting.signed_amount_minor::numeric) as posted_minor
           from wallet_postings posting
           join wallets treasury_wallet
             on treasury_wallet.world_id = posting.world_id
            and treasury_wallet.currency_id = posting.currency_id
            and treasury_wallet.id = posting.wallet_id
            and treasury_wallet.wallet_kind = 'treasury'
          group by posting.world_id, posting.currency_id, posting.wallet_id
       ),
       treasury_reconciliation as (
         select coalesce(sum(abs(
                  coalesce(balance.available_minor,0)::numeric - coalesce(posted.posted_minor,0)
                )),0)::text as treasury_reconciliation_delta_minor,
                count(*) filter (
                  where balance.wallet_id is null
                    or balance.available_minor::numeric
                    <> coalesce(posted.posted_minor,0)
                )::text as treasury_reconciliation_mismatch_count
           from wallets wallet
           left join wallet_balances balance
             on balance.world_id = wallet.world_id
            and balance.currency_id = wallet.currency_id
            and balance.wallet_id = wallet.id
           left join treasury_posted posted
             on posted.world_id = wallet.world_id
            and posted.currency_id = wallet.currency_id
            and posted.wallet_id = wallet.id
          where wallet.wallet_kind = 'treasury'
       )
       select
         (select active_reservation_count from active_reservation_state)
           as active_reservation_count,
         (select count(*)::text from assets) as asset_count,
         (select count(*)::text from currencies) as currency_count,
         (select failed_payroll_count from (
           select count(*) filter (where status = 'failed')::text as failed_payroll_count
             from payroll_records
         ) payroll_state) as failed_payroll_count,
         (select failed_production_run_count from production_state)
           as failed_production_run_count,
         (select count(*)::text from asset_transfer_offers
           where status = 'open') as open_offer_count,
         (select count(*)::text
            from asset_transfer_offers offer
            join world_simulation_clocks clock on clock.world_id = offer.world_id
           where offer.status = 'open' and offer.expires_at_tick <= clock.current_tick
         ) as open_expired_offer_count,
         (select count(*)::text from market_trades) as market_volume_trades,
         (select max_production_overdue_ticks from production_state)
           as max_production_overdue_ticks,
         (select max_reservation_age_ticks from active_reservation_state)
           as max_reservation_age_ticks,
         (select overdue_production_run_count from production_state)
           as overdue_production_run_count,
         (select count(*)::text from world_economy_heads
           where reconciliation_status in ('mismatch','failed')
         ) as reconciliation_mismatch_count,
         (select count(*)::text
            from market_listings listing
            join world_simulation_clocks clock on clock.world_id = listing.world_id
           where listing.status = 'open' and listing.expires_at_tick <= clock.current_tick
         ) as stale_listing_count,
         (select count(*)::text from tax_assessments) as tax_settlement_count,
         (select treasury_reconciliation_delta_minor from treasury_reconciliation)
           as treasury_reconciliation_delta_minor,
         (select treasury_reconciliation_mismatch_count from treasury_reconciliation)
           as treasury_reconciliation_mismatch_count,
         worldgraph_economy_last_repair_timestamp_seconds()::text
           as last_repair_timestamp_seconds,
         (select count(*)::text from wallets) as wallet_count`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('ECONOMY_OPERATIONAL_SNAPSHOT_UNAVAILABLE');
    return {
      activeReservationCount: safeCount(row.active_reservation_count),
      assetCount: safeCount(row.asset_count),
      currencyCount: safeCount(row.currency_count),
      failedPayrollCount: safeCount(row.failed_payroll_count),
      failedProductionRunCount: safeCount(row.failed_production_run_count),
      lastRepairTimestampSeconds: safeCount(row.last_repair_timestamp_seconds),
      marketVolumeTrades: safeCount(row.market_volume_trades),
      maxProductionOverdueTicks: safeObservedInteger(row.max_production_overdue_ticks),
      maxReservationAgeTicks: safeObservedInteger(row.max_reservation_age_ticks),
      openExpiredOfferCount: safeCount(row.open_expired_offer_count),
      openOfferCount: safeCount(row.open_offer_count),
      overdueProductionRunCount: safeCount(row.overdue_production_run_count),
      reconciliationMismatchCount: safeCount(row.reconciliation_mismatch_count),
      staleListingCount: safeCount(row.stale_listing_count),
      taxSettlementCount: safeCount(row.tax_settlement_count),
      treasuryReconciliationDeltaMinor: safeObservedInteger(
        row.treasury_reconciliation_delta_minor,
      ),
      treasuryReconciliationMismatchCount: safeCount(row.treasury_reconciliation_mismatch_count),
      walletCount: safeCount(row.wallet_count),
    };
  }
}

function mapDueOffer(row: DueOfferRow): DueAssetTransferOffer {
  if (
    !UUID.test(row.world_id) ||
    !UUID.test(row.offer_id) ||
    !isInteger(row.current_tick) ||
    !isInteger(row.expected_offer_version) ||
    row.expected_offer_version === '0' ||
    !isInteger(row.expected_state_revision) ||
    !isInteger(row.expected_world_version) ||
    row.expected_world_version === '0' ||
    !isInteger(row.expires_at_tick) ||
    BigInt(row.expires_at_tick) > BigInt(row.current_tick)
  ) {
    throw new Error('ECONOMY_DUE_OFFER_ROW_INVALID');
  }
  return {
    currentTick: row.current_tick,
    expectedOfferVersion: row.expected_offer_version,
    expectedStateRevision: row.expected_state_revision,
    expectedWorldVersion: row.expected_world_version,
    expiresAtTick: row.expires_at_tick,
    offerId: row.offer_id,
    worldId: row.world_id,
  };
}

function isInteger(value: string): boolean {
  return CANONICAL_NONNEGATIVE_INTEGER.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function safeCount(value: string): number {
  if (!CANONICAL_NONNEGATIVE_INTEGER.test(value)) {
    throw new Error('ECONOMY_OPERATIONAL_SNAPSHOT_INVALID');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('ECONOMY_OPERATIONAL_SNAPSHOT_INVALID');
  return parsed;
}

function safeObservedInteger(value: string): number {
  if (!CANONICAL_NONNEGATIVE_INTEGER.test(value)) {
    throw new Error('ECONOMY_OPERATIONAL_SNAPSHOT_INVALID');
  }
  const parsed = BigInt(value);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
}
