import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type {
  AssetStatus,
  AssetTransferOfferStatus,
  CurrencyStatus,
  FinancialTransactionKind,
  WalletKind,
  WalletStatus,
  WorldRole,
} from '@worldgraph/contracts';
import { createValidator } from '@worldgraph/contracts';

import { ApplicationError, isPostgresError } from '../application/errors.js';
import type {
  AssetViewTransport,
  ControlledWalletViewTransport,
  CurrencyViewTransport,
  EconomyRepairApprovalRequestTransport,
  EconomyRepairApprovalTransport,
  EconomyRepairPlanViewTransport,
  EconomySummaryTransport,
  OfferPageQueryTransport,
  OfferViewTransport,
  WalletTransactionViewTransport,
} from './api-contracts.js';
import {
  EconomyRepairApprovalV1Schema,
  EconomyRepairPlanViewTransportSchema,
} from './api-contracts.js';

export interface EconomyQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface EconomyPageResult<T> {
  items: T[];
  positions: string[];
}

export interface EconomyRepairApprovalInput extends EconomyRepairApprovalRequestTransport {
  actorId: string;
  auditRecordId: string;
  creatorOverrideId: string | null;
  planId: string;
  worldId: string;
}

interface MembershipRow extends QueryResultRow {
  role: WorldRole;
}

interface SummaryRow extends QueryResultRow {
  active_world_version_id: string;
  current_tick: string;
  design_version: string;
  economy_head_version: string | null;
  initialized_event_id: string | null;
  issuance_currency_code: string | null;
  issuance_currency_id: string | null;
  issuance_currency_version: string | null;
  issuance_current_supply_minor: string | null;
  issuance_max_supply_minor: string | null;
  issuance_minor_unit_scale: number | null;
  issuance_supply_version: string | null;
  issuance_treasury_balance_minor: string | null;
  issuance_treasury_balance_version: string | null;
  issuance_treasury_wallet_id: string | null;
  issuance_treasury_wallet_version: string | null;
  last_reconciled_at: Date | null;
  last_reconciled_state_revision: string | null;
  plan_hash: Buffer | null;
  projection_checksum: Buffer | null;
  reconciliation_status: 'current' | 'failed' | 'mismatch' | 'pending' | null;
  source_kind: 'compiler_1_1' | 'legacy_1_0_adapter' | null;
  state_revision: string;
  version_compiler_version: string;
  world_id: string;
}

interface CurrencyViewRow extends QueryResultRow {
  code: string;
  currency_id: string;
  currency_row_version: string;
  currency_schema_version: 1;
  current_supply_minor: string;
  issuer_entity_logical_key: string | null;
  max_supply_minor: string | null;
  minor_unit_scale: number;
  name: string;
  stable_key: string;
  status: CurrencyStatus;
  supply_version: string;
  updated_state_revision: string;
  world_id: string;
}

interface WalletViewRow extends QueryResultRow {
  available_minor: string;
  currency_code: string;
  currency_id: string;
  id: string;
  minor_unit_scale: number;
  owner_entity_logical_key: string;
  stable_key: string;
  status: WalletStatus;
  updated_state_revision: string;
  wallet_balance_version: string;
  wallet_kind: WalletKind;
  wallet_row_version: string;
  wallet_schema_version: 1;
  world_id: string;
}

interface TransactionRow extends QueryResultRow {
  command_id: string;
  created_at: Date;
  currency_id: string;
  id: string;
  memo_text: string | null;
  occurred_tick: string;
  postings: Array<{
    currencyId: string;
    postingOrdinal: number;
    signedAmountMinor: string;
    transactionId: string;
    walletId: string;
    worldId: string;
  }>;
  state_revision: string;
  supply_delta_minor: string;
  transaction_kind: FinancialTransactionKind;
  world_id: string;
}

interface AssetViewRow extends QueryResultRow {
  acquired_event_id: string;
  asset_id: string;
  asset_schema_version: 1;
  asset_type: string;
  controlled_by_actor: boolean;
  metadata: { displayName: string; provenance: string };
  owner_entity_logical_key: string;
  ownership_version: string;
  stable_key: string;
  status: AssetStatus;
  transferable: boolean;
  updated_state_revision: string;
  world_entity_logical_key: string | null;
  world_id: string;
}

interface OfferViewRow extends QueryResultRow {
  asset_id: string;
  asset_key: string;
  buyer_entity_logical_key: string | null;
  can_accept: boolean;
  controlled_buyer: boolean;
  controlled_seller: boolean;
  created_at: Date;
  currency_id: string;
  eligible_buyer_owner_logical_key: string | null;
  eligible_buyer_wallet_id: string | null;
  eligible_buyer_wallet_version: string | null;
  expires_at_tick: string;
  id: string;
  price_minor: string;
  row_version: string;
  seller_entity_logical_key: string;
  seller_wallet_id: string;
  seller_wallet_version: string;
  status: AssetTransferOfferStatus;
  world_id: string;
}

interface RepairDocumentRow extends QueryResultRow {
  document: unknown;
}

const repairPlanValidator = createValidator<EconomyRepairPlanViewTransport>(
  EconomyRepairPlanViewTransportSchema,
);
const repairApprovalValidator = createValidator<EconomyRepairApprovalTransport>(
  EconomyRepairApprovalV1Schema,
);

export class PostgresEconomyQueryRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly executor: EconomyQueryExecutor = pool,
  ) {}

  public async membershipRole(actorId: string, worldId: string): Promise<WorldRole | null> {
    const result = await this.executor.query<MembershipRow>(
      `select role::text from world_memberships
        where world_id = $1 and user_id = $2 and status = 'active'`,
      [worldId, actorId],
    );
    return result.rows[0]?.role ?? null;
  }

  public async repairPlan(
    actorId: string,
    planId: string,
  ): Promise<EconomyRepairPlanViewTransport> {
    return this.loadRepairPlan(this.executor, actorId, planId);
  }

  public async approveRepair(
    input: EconomyRepairApprovalInput,
  ): Promise<EconomyRepairApprovalTransport | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('begin');
      let plan: EconomyRepairPlanViewTransport;
      try {
        plan = await this.loadRepairPlan(client, input.actorId, input.planId);
      } catch (error) {
        if (isPostgresError(error, '42501')) throw repairPlanNotFound();
        throw error;
      }
      if (plan.worldId !== input.worldId) {
        await client.query('rollback');
        return null;
      }
      const result = await client.query<RepairDocumentRow>(
        `select worldgraph_approve_economy_repair(
           $1::uuid, $2::uuid, $3::text, $4::uuid,
           $5::uuid, $6::uuid, $7::text, $8::text
         ) as document`,
        [
          input.planId,
          input.actorId,
          input.authorityKind,
          input.approvalId,
          input.creatorOverrideId,
          input.auditRecordId,
          input.planHash,
          input.confirmation,
        ],
      );
      const approval = validatedRepairDocument(repairApprovalValidator, result.rows[0]?.document);
      await client.query('commit');
      return approval;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async summary(
    actorId: string,
    worldId: string,
    policy: {
      debitsFrozen: boolean;
      issuanceEnabled: boolean;
      offersEnabled: boolean;
      transfersEnabled: boolean;
    },
  ): Promise<EconomySummaryTransport | null> {
    const result = await this.executor.query<SummaryRow>(
      `select runtime.world_id::text, runtime.active_world_version_id::text,
              runtime.state_revision::text, version.version_number::text as design_version,
              version.compiler_version as version_compiler_version,
              clock.current_tick::text,
              head.row_version::text as economy_head_version,
              head.initialized_event_id::text, head.checksum as projection_checksum,
              head.reconciliation_status::text,
              reconciliation_run.created_at as last_reconciled_at,
              head.last_reconciled_state_revision::text,
              plan.plan_hash, plan.source_kind::text,
              issuance.currency_id::text as issuance_currency_id,
              issuance.currency_code as issuance_currency_code,
              issuance.currency_version::text as issuance_currency_version,
              issuance.current_supply_minor::text as issuance_current_supply_minor,
              issuance.max_supply_minor::text as issuance_max_supply_minor,
              issuance.minor_unit_scale as issuance_minor_unit_scale,
              issuance.supply_version::text as issuance_supply_version,
              issuance.treasury_balance_minor::text as issuance_treasury_balance_minor,
              issuance.treasury_balance_version::text as issuance_treasury_balance_version,
              issuance.treasury_wallet_id::text as issuance_treasury_wallet_id,
              issuance.treasury_wallet_version::text as issuance_treasury_wallet_version
         from world_runtime_heads runtime
         join world_versions version
           on version.world_id = runtime.world_id and version.id = runtime.active_world_version_id
         join world_simulation_clocks clock on clock.world_id = runtime.world_id
         join world_memberships membership
           on membership.world_id = runtime.world_id and membership.user_id = $2
          and membership.status = 'active'
         left join world_economy_heads head on head.world_id = runtime.world_id
         left join economy_reconciliation_runs reconciliation_run
           on reconciliation_run.id = head.last_reconciliation_run_id
          and reconciliation_run.world_id = runtime.world_id
         left join compiled_economy_seed_plans plan
           on plan.world_id = runtime.world_id
          and plan.world_version_id = runtime.active_world_version_id
         left join lateral (
           select currency.id as currency_id, currency.code::text as currency_code,
                  currency.row_version as currency_version,
                  currency.max_supply_minor, currency.minor_unit_scale,
                  supply.current_supply_minor, supply.row_version as supply_version,
                  wallet.id as treasury_wallet_id,
                  wallet.row_version as treasury_wallet_version,
                  balance.available_minor as treasury_balance_minor,
                  balance.row_version as treasury_balance_version
             from wallets wallet
             join currencies currency
               on currency.world_id = wallet.world_id and currency.id = wallet.currency_id
             join currency_supply supply
               on supply.world_id = currency.world_id and supply.currency_id = currency.id
             join wallet_balances balance
               on balance.world_id = wallet.world_id and balance.wallet_id = wallet.id
            where wallet.world_id = runtime.world_id
              and membership.role = 'creator'
              and wallet.wallet_kind = 'treasury'
              and wallet.status <> 'closed'
            order by currency.stable_key::text collate "C", wallet.stable_key::text collate "C"
            limit 1
         ) issuance on true
        where runtime.world_id = $1
        order by plan.created_at desc nulls last, plan.id desc nulls last
        limit 1`,
      [worldId, actorId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const role = await this.membershipRole(actorId, worldId);
    if (!role) return null;
    const initialized = row.economy_head_version !== null;
    const creator = role === 'creator';
    const reconciler = creator || role === 'administrator';
    const status = !initialized
      ? 'not_initialized'
      : row.reconciliation_status === 'mismatch' || row.reconciliation_status === 'failed'
        ? 'mismatched'
        : row.reconciliation_status === 'pending'
          ? 'reconciling'
          : 'ready';
    return {
      capabilities: {
        canAdoptLegacySeed:
          creator &&
          !initialized &&
          row.version_compiler_version === '1.0.0' &&
          row.plan_hash === null,
        canInitialize: creator && !initialized && row.plan_hash !== null,
        canIssue: creator && initialized && policy.issuanceEnabled,
        canReconcile: reconciler && initialized,
      },
      currentTick: row.current_tick,
      designVersion: row.design_version,
      economyHeadVersion: row.economy_head_version,
      featurePolicy: policy,
      initializedEventId: row.initialized_event_id,
      issuanceTarget:
        creator &&
        row.issuance_currency_id &&
        row.issuance_currency_code &&
        row.issuance_currency_version &&
        row.issuance_current_supply_minor &&
        row.issuance_minor_unit_scale !== null &&
        row.issuance_supply_version &&
        row.issuance_treasury_balance_minor &&
        row.issuance_treasury_balance_version &&
        row.issuance_treasury_wallet_id &&
        row.issuance_treasury_wallet_version
          ? {
              currencyCode: row.issuance_currency_code,
              currencyId: row.issuance_currency_id,
              currencyVersion: row.issuance_currency_version,
              currentSupplyMinor: row.issuance_current_supply_minor,
              maxSupplyMinor: row.issuance_max_supply_minor,
              minorUnitScale: row.issuance_minor_unit_scale,
              supplyVersion: row.issuance_supply_version,
              treasuryBalanceMinor: row.issuance_treasury_balance_minor,
              treasuryBalanceVersion: row.issuance_treasury_balance_version,
              treasuryWalletId: row.issuance_treasury_wallet_id,
              treasuryWalletVersion: row.issuance_treasury_wallet_version,
            }
          : null,
      projectionChecksum: row.projection_checksum?.toString('hex') ?? null,
      reconciliation: {
        lastReconciledAt: row.last_reconciled_at?.toISOString() ?? null,
        lastReconciledStateRevision: row.last_reconciled_state_revision,
        status: !initialized
          ? 'not_run'
          : row.reconciliation_status === 'current'
            ? 'current'
            : row.reconciliation_status === 'pending'
              ? 'reconciling'
              : 'mismatched',
      },
      seedPlan: {
        available: row.plan_hash !== null,
        hash: row.plan_hash?.toString('hex') ?? null,
        sourceKind:
          row.source_kind === 'compiler_1_1'
            ? 'compiler_1_1'
            : row.source_kind === 'legacy_1_0_adapter'
              ? 'legacy_adapter'
              : null,
      },
      stateRevision: row.state_revision,
      status,
      virtualValueBoundary: { cashOutAllowed: false, noCashValue: true },
      worldId: row.world_id,
    };
  }

  public async currencies(
    actorId: string,
    worldId: string,
  ): Promise<CurrencyViewTransport[] | null> {
    if (!(await this.membershipRole(actorId, worldId))) return null;
    const result = await this.executor.query<CurrencyViewRow>(
      `select currency.id::text as currency_id, currency.world_id::text,
              currency.stable_key::text, currency.code::text, currency.name,
              currency.minor_unit_scale, currency.max_supply_minor::text,
              issuer.logical_key::text as issuer_entity_logical_key,
              currency.currency_schema_version, currency.status::text,
              currency.row_version::text as currency_row_version,
              supply.current_supply_minor::text, supply.row_version::text as supply_version,
              supply.updated_state_revision::text
         from currencies currency
         join currency_supply supply
           on supply.world_id = currency.world_id and supply.currency_id = currency.id
         left join world_entities issuer
           on issuer.world_id = currency.world_id and issuer.id = currency.issuer_entity_id
        where currency.world_id = $1
        order by currency.stable_key::text collate "C", currency.id`,
      [worldId],
    );
    return result.rows.map(currencyView);
  }

  public async wallets(input: {
    actorId: string;
    after: { id: string; stableKey: string } | null;
    limit: number;
    worldId: string;
  }): Promise<EconomyPageResult<ControlledWalletViewTransport> | null> {
    if (!(await this.membershipRole(input.actorId, input.worldId))) return null;
    const result = await this.executor.query<WalletViewRow>(
      `select wallet.id::text, wallet.world_id::text, wallet.currency_id::text,
              wallet.stable_key::text, owner.logical_key::text as owner_entity_logical_key,
              wallet.wallet_kind::text, wallet.status::text,
              wallet.wallet_schema_version, wallet.row_version::text as wallet_row_version,
              balance.available_minor::text,
              balance.row_version::text as wallet_balance_version,
              balance.updated_state_revision::text,
              currency.code::text as currency_code, currency.minor_unit_scale
         from wallets wallet
         join wallet_balances balance
           on balance.world_id = wallet.world_id and balance.wallet_id = wallet.id
         join currencies currency
           on currency.world_id = wallet.world_id and currency.id = wallet.currency_id
         join world_entities owner
           on owner.world_id = wallet.world_id and owner.id = wallet.owner_entity_id
        where wallet.world_id = $1
          and worldgraph_user_controls_economy_entity_v1(
            wallet.world_id,$2,wallet.owner_entity_id
          )
          and ($3::text is null or (wallet.stable_key::text collate "C", wallet.id)
               > ($3::text collate "C", $4::uuid))
        order by wallet.stable_key::text collate "C", wallet.id
        limit $5`,
      [
        input.worldId,
        input.actorId,
        input.after?.stableKey ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return {
      items: result.rows.map(walletView),
      positions: result.rows.map((row) => `${row.stable_key}|${row.id}`),
    };
  }

  public async walletTransactions(input: {
    actorId: string;
    after: { createdAt: Date; id: string; tick: string } | null;
    limit: number;
    walletId: string;
    worldId: string;
  }): Promise<EconomyPageResult<WalletTransactionViewTransport> | null> {
    if (!(await this.membershipRole(input.actorId, input.worldId))) return null;
    const visibility = await this.executor.query<{ current_control: boolean; visible: boolean }>(
      `select
         exists (
           select 1 from wallets wallet
           where wallet.world_id = $1 and wallet.id = $2
             and worldgraph_user_controls_economy_entity_v1(
               wallet.world_id,$3,wallet.owner_entity_id
             )
         ) as current_control,
         exists (
           select 1 from wallet_postings posting
           join financial_transactions transaction on transaction.id = posting.transaction_id
           join economy_participant_history participant
             on participant.world_id = transaction.world_id
            and participant.event_id = transaction.event_id and participant.user_id = $3
           where posting.world_id = $1 and posting.wallet_id = $2
         ) as visible`,
      [input.worldId, input.walletId, input.actorId],
    );
    const access = visibility.rows[0];
    if (!access || (!access.current_control && !access.visible)) return null;
    const result = await this.executor.query<TransactionRow>(
      `select transaction.id::text, transaction.world_id::text,
              transaction.currency_id::text, transaction.transaction_kind::text,
              transaction.supply_delta_minor::text, transaction.command_id::text,
              transaction.memo_text, transaction.occurred_tick::text,
              transaction.state_revision::text, transaction.created_at,
              jsonb_agg(jsonb_build_object(
                'currencyId', posting.currency_id::text,
                'postingOrdinal', posting.posting_ordinal,
                'signedAmountMinor', posting.signed_amount_minor::text,
                'transactionId', posting.transaction_id::text,
                'walletId', posting.wallet_id::text,
                'worldId', posting.world_id::text
              ) order by posting.posting_ordinal) as postings
         from financial_transactions transaction
         join wallet_postings selected
           on selected.transaction_id = transaction.id and selected.wallet_id = $2
         join wallet_postings posting on posting.transaction_id = transaction.id
        where transaction.world_id = $1
          and ($3::boolean or exists (
            select 1 from economy_participant_history participant
             where participant.world_id = transaction.world_id
               and participant.event_id = transaction.event_id
               and participant.user_id = $4
          ))
          and ($5::bigint is null or
               (transaction.occurred_tick, transaction.created_at, transaction.id)
               < ($5::bigint,$6::timestamptz,$7::uuid))
        group by transaction.id
        order by transaction.occurred_tick desc, transaction.created_at desc, transaction.id desc
        limit $8`,
      [
        input.worldId,
        input.walletId,
        access.current_control,
        input.actorId,
        input.after?.tick ?? null,
        input.after?.createdAt ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return {
      items: result.rows.map(transactionView),
      positions: result.rows.map(
        (row) => `${row.occurred_tick}|${row.created_at.toISOString()}|${row.id}`,
      ),
    };
  }

  public async assets(input: {
    actorId: string;
    after: { id: string; stableKey: string } | null;
    limit: number;
    owned: boolean | null;
    worldId: string;
  }): Promise<EconomyPageResult<AssetViewTransport> | null> {
    if (!(await this.membershipRole(input.actorId, input.worldId))) return null;
    const result = await this.executor.query<AssetViewRow>(
      `${assetSelect()}
        where asset.world_id = $1
          and ($3::boolean is null or $3::boolean =
            worldgraph_user_controls_economy_entity_v1(
              ownership.world_id,$2,ownership.owner_entity_id
            ))
          and ($4::text is null or (asset.stable_key::text collate "C", asset.id)
               > ($4::text collate "C",$5::uuid))
        order by asset.stable_key::text collate "C", asset.id
        limit $6`,
      [
        input.worldId,
        input.actorId,
        input.owned,
        input.after?.stableKey ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return {
      items: result.rows.map(assetView),
      positions: result.rows.map((row) => `${row.stable_key}|${row.asset_id}`),
    };
  }

  public async asset(
    actorId: string,
    worldId: string,
    assetKey: string,
  ): Promise<AssetViewTransport | null> {
    if (!(await this.membershipRole(actorId, worldId))) return null;
    const result = await this.executor.query<AssetViewRow>(
      `${assetSelect()} where asset.world_id = $1 and asset.stable_key = $3`,
      [worldId, actorId, assetKey],
    );
    return result.rows[0] ? assetView(result.rows[0]) : null;
  }

  public async offers(input: {
    actorId: string;
    after: { createdAt: Date; id: string } | null;
    limit: number;
    query: Omit<OfferPageQueryTransport, 'cursor' | 'limit'>;
    worldId: string;
  }): Promise<EconomyPageResult<OfferViewTransport> | null> {
    if (!(await this.membershipRole(input.actorId, input.worldId))) return null;
    const result = await this.executor.query<OfferViewRow>(
      `select offer.id::text, offer.world_id::text, offer.asset_id::text,
              asset.stable_key::text as asset_key,
              seller.logical_key::text as seller_entity_logical_key,
              buyer.logical_key::text as buyer_entity_logical_key,
              offer.currency_id::text, offer.seller_wallet_id::text,
              offer.price_minor::text, offer.expires_at_tick::text,
              offer.status::text, offer.row_version::text, offer.created_at,
              seller_balance.row_version::text as seller_wallet_version,
              eligible.wallet_id::text as eligible_buyer_wallet_id,
              eligible.wallet_version::text as eligible_buyer_wallet_version,
              eligible.owner_logical_key::text as eligible_buyer_owner_logical_key,
              (offer.status = 'open' and offer.expires_at_tick > clock.current_tick
                and eligible.wallet_id is not null) as can_accept,
              worldgraph_user_controls_economy_entity_v1(
                offer.world_id,$2,offer.seller_entity_id
              ) as controlled_seller,
              coalesce(worldgraph_user_controls_economy_entity_v1(
                offer.world_id,$2,offer.buyer_entity_id
              ),false) as controlled_buyer
         from asset_transfer_offers offer
         join assets asset on asset.world_id = offer.world_id and asset.id = offer.asset_id
         join world_entities seller
           on seller.world_id = offer.world_id and seller.id = offer.seller_entity_id
         left join world_entities buyer
           on buyer.world_id = offer.world_id and buyer.id = offer.buyer_entity_id
         join wallet_balances seller_balance
           on seller_balance.world_id = offer.world_id
          and seller_balance.wallet_id = offer.seller_wallet_id
         join world_simulation_clocks clock on clock.world_id = offer.world_id
         left join lateral (
           select wallet.id as wallet_id, balance.row_version as wallet_version,
                  owner.logical_key as owner_logical_key
             from wallets wallet
             join wallet_balances balance
               on balance.world_id = wallet.world_id and balance.wallet_id = wallet.id
             join world_entities owner
               on owner.world_id = wallet.world_id and owner.id = wallet.owner_entity_id
             join currencies currency
               on currency.world_id = wallet.world_id and currency.id = wallet.currency_id
            where wallet.world_id = offer.world_id
              and wallet.currency_id = offer.currency_id
              and wallet.owner_entity_id <> offer.seller_entity_id
              and worldgraph_user_controls_economy_entity_v1(
                wallet.world_id,$2,wallet.owner_entity_id
              )
              and (offer.buyer_entity_id is null
                   or wallet.owner_entity_id = offer.buyer_entity_id)
              and wallet.status = 'active' and currency.status = 'active'
            order by wallet.stable_key::text collate "C", wallet.id
            limit 1
         ) eligible on true
        where offer.world_id = $1
          and (
            worldgraph_user_controls_economy_entity_v1(
              offer.world_id,$2,offer.seller_entity_id
            )
            or coalesce(worldgraph_user_controls_economy_entity_v1(
              offer.world_id,$2,offer.buyer_entity_id
            ),false)
            or (
              $3::uuid is not null and offer.id = $3::uuid
              and offer.buyer_entity_id is null and offer.status = 'open'
            )
          )
          and ($3::uuid is null or offer.id = $3::uuid)
          and ($4::text is null or offer.status::text = $4)
          and ($5::timestamptz is null or (offer.created_at,offer.id) < ($5::timestamptz,$6::uuid))
        order by offer.created_at desc, offer.id desc
        limit $7`,
      [
        input.worldId,
        input.actorId,
        input.query.offerId ?? null,
        input.query.status ?? null,
        input.after?.createdAt ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return {
      items: result.rows.map(offerView),
      positions: result.rows.map((row) => `${row.created_at.toISOString()}|${row.id}`),
    };
  }

  private async loadRepairPlan(
    executor: EconomyQueryExecutor,
    actorId: string,
    planId: string,
  ): Promise<EconomyRepairPlanViewTransport> {
    const result = await executor.query<RepairDocumentRow>(
      `select worldgraph_economy_repair_plan($1::uuid, $2::uuid) as document`,
      [planId, actorId],
    );
    return validatedRepairDocument(repairPlanValidator, result.rows[0]?.document);
  }
}

function repairPlanNotFound(): ApplicationError {
  return new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
}

function validatedRepairDocument<T>(
  validator: { is(value: unknown): value is T },
  value: unknown,
): T {
  if (!validator.is(value)) {
    throw new Error('The database returned an invalid economy repair document.');
  }
  return value;
}

function currencyView(row: CurrencyViewRow): CurrencyViewTransport {
  return {
    currency: {
      cashOutAllowed: false,
      code: row.code,
      currencySchemaVersion: 1,
      id: row.currency_id,
      issuerEntityLogicalKey: row.issuer_entity_logical_key,
      maxSupplyMinor: row.max_supply_minor,
      minorUnitScale: row.minor_unit_scale,
      name: row.name,
      noCashValue: true,
      rowVersion: row.currency_row_version,
      stableKey: row.stable_key,
      status: row.status,
      worldId: row.world_id,
    },
    currentSupplyMinor: row.current_supply_minor,
    supplyVersion: row.supply_version,
    updatedStateRevision: row.updated_state_revision,
  };
}

function walletView(row: WalletViewRow): ControlledWalletViewTransport {
  return {
    balance: {
      availableMinor: row.available_minor,
      rowVersion: row.wallet_balance_version,
      updatedStateRevision: row.updated_state_revision,
      walletId: row.id,
    },
    controlled: true,
    currencyCode: row.currency_code,
    minorUnitScale: row.minor_unit_scale,
    wallet: {
      currencyId: row.currency_id,
      id: row.id,
      ownerEntityLogicalKey: row.owner_entity_logical_key,
      rowVersion: row.wallet_row_version,
      stableKey: row.stable_key,
      status: row.status,
      walletKind: row.wallet_kind,
      walletSchemaVersion: 1,
      worldId: row.world_id,
    },
  };
}

function transactionView(row: TransactionRow): WalletTransactionViewTransport {
  return {
    memo: row.memo_text,
    transaction: {
      commandId: row.command_id,
      currencyId: row.currency_id,
      financialTransactionSchemaVersion: 1,
      id: row.id,
      kind: row.transaction_kind,
      occurredTick: row.occurred_tick,
      postings: row.postings,
      stateRevision: row.state_revision,
      supplyDeltaMinor: row.supply_delta_minor,
      worldId: row.world_id,
    },
  };
}

function assetSelect(): string {
  return `select asset.id::text as asset_id, asset.world_id::text,
                 asset.stable_key::text, asset.asset_type, asset.asset_schema_version,
                 asset.metadata,
                 (asset.transferable and not exists (
                   select 1
                     from business_facilities facility
                    where facility.world_id = asset.world_id
                      and facility.facility_asset_id = asset.id
                      and facility.status in ('active','disabled')
                 )) as transferable,
                 asset.status::text,
                 world_entity.logical_key::text as world_entity_logical_key,
                 ownership.owner_entity_id::text,
                 owner.logical_key::text as owner_entity_logical_key,
                 ownership.ownership_version::text, ownership.acquired_event_id::text,
                 ownership.updated_state_revision::text,
                 worldgraph_user_controls_economy_entity_v1(
                   ownership.world_id,$2,ownership.owner_entity_id
                 ) as controlled_by_actor
            from assets asset
            join asset_ownership ownership
              on ownership.world_id = asset.world_id and ownership.asset_id = asset.id
            join world_entities owner
              on owner.world_id = ownership.world_id and owner.id = ownership.owner_entity_id
            left join world_entities world_entity
              on world_entity.world_id = asset.world_id and world_entity.id = asset.world_entity_id`;
}

function assetView(row: AssetViewRow): AssetViewTransport {
  return {
    asset: {
      assetSchemaVersion: 1,
      assetType: row.asset_type,
      id: row.asset_id,
      metadata: row.metadata,
      stableKey: row.stable_key,
      status: row.status,
      transferable: row.transferable,
      worldEntityLogicalKey: row.world_entity_logical_key,
      worldId: row.world_id,
    },
    controlledByActor: row.controlled_by_actor,
    ownership: {
      acquiredEventId: row.acquired_event_id,
      assetId: row.asset_id,
      ownerEntityLogicalKey: row.owner_entity_logical_key,
      ownershipSchemaVersion: 1,
      ownershipVersion: row.ownership_version,
      updatedStateRevision: row.updated_state_revision,
      worldId: row.world_id,
    },
  };
}

function offerView(row: OfferViewRow): OfferViewTransport {
  return {
    assetKey: row.asset_key,
    canAccept: row.can_accept,
    controlledBuyer: row.controlled_buyer,
    controlledSeller: row.controlled_seller,
    eligibleBuyerWallet:
      row.eligible_buyer_wallet_id &&
      row.eligible_buyer_wallet_version &&
      row.eligible_buyer_owner_logical_key
        ? {
            ownerEntityLogicalKey: row.eligible_buyer_owner_logical_key,
            walletId: row.eligible_buyer_wallet_id,
            walletVersion: row.eligible_buyer_wallet_version,
          }
        : null,
    offer: {
      assetId: row.asset_id,
      buyerEntityLogicalKey: row.buyer_entity_logical_key,
      currencyId: row.currency_id,
      expiresAtTick: row.expires_at_tick,
      id: row.id,
      offerSchemaVersion: 1,
      priceMinor: row.price_minor,
      rowVersion: row.row_version,
      sellerEntityLogicalKey: row.seller_entity_logical_key,
      sellerWalletId: row.seller_wallet_id,
      status: row.status,
      worldId: row.world_id,
    },
    sellerWalletVersion: row.seller_wallet_version,
  };
}
