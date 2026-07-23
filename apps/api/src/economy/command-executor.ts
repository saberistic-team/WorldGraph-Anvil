import { createHash } from 'node:crypto';

import type { QueryResult, QueryResultRow } from 'pg';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  ECONOMY_SCHEMA_VERSION,
  HISTORY_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  CompiledWorldV1Schema,
  canonicalJson,
  createValidator,
  type AcceptAssetTransferOfferPayloadV1,
  type AdoptLegacyEconomySeedPlanPayloadV1,
  type AssetOwnershipTransferredPayloadV1,
  type AssetPurchasedPayloadV1,
  type AssetTransferOfferAcceptedPayloadV1,
  type AssetTransferOfferCancelledPayloadV1,
  type AssetTransferOfferCreatedPayloadV1,
  type AssetTransferOfferStatus,
  type CancelAssetTransferOfferPayloadV1,
  type CompiledWorldV1,
  type CreateAssetTransferOfferPayloadV1,
  type CurrencyFrozenPayloadV1,
  type CurrencyIssuedPayloadV1,
  type CurrencyStatus,
  type CurrencyTransferredPayloadV1,
  type DomainEventEnvelopeV1,
  type DomainEventMetadataV1,
  type FreezeCurrencyPayloadV1,
  type FreezeWalletPayloadV1,
  type IdGenerator,
  type InitializeWorldEconomyPayloadV1,
  type IssueCurrencyPayloadV1,
  type JsonValue,
  type LedgerActorV1,
  type LedgerEntryV1,
  type LegacyEconomySeedPlanAdoptedPayloadV1,
  type ReconcileWorldEconomyPayloadV1,
  type TransferAssetPayloadV1,
  type TransferCurrencyPayloadV1,
  type WalletFrozenPayloadV1,
  type WalletStatus,
  type WorldCommandRejectionCode,
  type WorldEconomyInitializedPayloadV1,
  type WorldEconomyReconciledPayloadV1,
  type WorldHistoryEntryV1,
} from '@worldgraph/contracts';
import { deriveLegacyEconomySeedPlanV1 } from '@worldgraph/compiler';
import {
  EconomyDomainError,
  assertEconomySeedPlan,
  assertEconomySeedPlanV1,
  decideAcceptAssetTransferOffer,
  decideAssetGift,
  decideCancelAssetTransferOffer,
  decideCreateAssetTransferOffer,
  decideCurrencyIssuance,
  decideCurrencyStatusChange,
  decideCurrencyTransfer,
  decideWalletStatusChange,
  economySeedPlanHash,
  parseCanonicalAmount,
  type EconomyPosting,
} from '@worldgraph/economy';
import {
  LEDGER_GENESIS_PREVIOUS_HASH,
  computeDomainEventHashV1,
  computeLedgerEntryHashV1,
  projectWorldHistoryEntryV1,
  type DomainEventHashInputV1,
  type LedgerEntryHashInputV1,
} from '@worldgraph/ledger';
import { telemetry } from '@worldgraph/observability';

import { ApplicationError } from '../application/errors.js';
import {
  ACCEPT_ASSET_TRANSFER_OFFER_COMMAND,
  ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND,
  CANCEL_ASSET_TRANSFER_OFFER_COMMAND,
  CREATE_ASSET_TRANSFER_OFFER_COMMAND,
  FREEZE_CURRENCY_COMMAND,
  FREEZE_WALLET_COMMAND,
  INITIALIZE_WORLD_ECONOMY_COMMAND,
  ISSUE_CURRENCY_COMMAND,
  RECONCILE_WORLD_ECONOMY_COMMAND,
  TRANSFER_ASSET_COMMAND,
  TRANSFER_CURRENCY_COMMAND,
  UNFREEZE_CURRENCY_COMMAND,
  UNFREEZE_WALLET_COMMAND,
} from '../commands/registry.js';
import type { EconomyCommandExecutionInput, ReceivedCommandWrite } from '../commands/types.js';
import type { WorldCommandResultTransport } from '../commands/api-contracts.js';

const compiledWorldV1Validator = createValidator<CompiledWorldV1>(CompiledWorldV1Schema);

export interface EconomySqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

interface EconomyHeadRow extends QueryResultRow {
  checksum: Buffer;
  reconciliation_status: 'current' | 'failed' | 'mismatch' | 'pending';
  row_version: string;
  seed_plan_hash: Buffer;
  source_world_version_id: string;
  updated_state_revision: string;
}

interface ClockRow extends QueryResultRow {
  current_tick: string;
}

interface CurrencyRow extends QueryResultRow {
  code: string;
  current_supply_minor: string;
  currency_row_version: string;
  id: string;
  issuer_entity_id: string | null;
  max_supply_minor: string | null;
  minor_unit_scale: number;
  stable_key: string;
  status: CurrencyStatus;
  supply_row_version: string;
  world_id: string;
}

interface WalletRow extends QueryResultRow {
  available_minor: string;
  balance_row_version: string;
  controlled_by_actor: boolean;
  currency_id: string;
  id: string;
  owner_entity_id: string;
  owner_logical_key: string;
  stable_key: string;
  status: WalletStatus;
  wallet_kind: 'organization' | 'player' | 'treasury';
  wallet_row_version: string;
  world_id: string;
}

interface AssetRow extends QueryResultRow {
  active: boolean;
  controlled_by_actor: boolean;
  id: string;
  owner_entity_id: string;
  owner_logical_key: string;
  ownership_version: string;
  stable_key: string;
  transferable: boolean;
  world_id: string;
}

interface OfferRow extends QueryResultRow {
  aggregate_version: string;
  asset_id: string;
  buyer_entity_id: string | null;
  buyer_logical_key: string | null;
  currency_id: string;
  expires_at_tick: string;
  id: string;
  price_minor: string;
  row_version: string;
  seller_entity_id: string;
  seller_logical_key: string;
  seller_wallet_id: string;
  status: AssetTransferOfferStatus;
  world_id: string;
}

interface EntityRow extends QueryResultRow {
  id: string;
  logical_key: string;
}

interface AllocationRow extends QueryResultRow {
  last_entry_hash: Buffer | null;
  next_event_sequence: string;
  next_ledger_sequence: string;
}

export interface PlannedEconomyEvent {
  aggregateId: string;
  aggregateType: string;
  eventId: string;
  eventType: EconomyEventType;
  payload: Record<string, JsonValue>;
}

type EconomyEventType =
  | 'LegacyEconomySeedPlanAdoptedV1'
  | 'WorldEconomyInitializedV1'
  | 'WorldEconomyReconciledV1'
  | 'CurrencyIssuedV1'
  | 'CurrencyTransferredV1'
  | 'CurrencyFrozenV1'
  | 'CurrencyUnfrozenV1'
  | 'WalletFrozenV1'
  | 'WalletUnfrozenV1'
  | 'AssetOwnershipTransferredV1'
  | 'AssetTransferOfferCreatedV1'
  | 'AssetTransferOfferCancelledV1'
  | 'AssetTransferOfferAcceptedV1'
  | 'AssetPurchasedV1'
  | 'WorldCommerceInitializedV1'
  | 'BusinessCreatedV1'
  | 'BusinessFacilityConfiguredV1'
  | 'EmploymentContractCreatedV1'
  | 'EmploymentContractAcceptedV1'
  | 'EmploymentContractEndedV1'
  | 'WorkRecordedV1'
  | 'PayrollSettledV1'
  | 'PayrollFailedV1'
  | 'ProductionRunStartedV1'
  | 'ResourcesConsumedV1'
  | 'ResourcesProducedV1'
  | 'ProductionFailedV1'
  | 'MarketListingCreatedV1'
  | 'MarketListingCancelledV1'
  | 'MarketListingExpiredV1'
  | 'MarketListingPartiallyFilledV1'
  | 'MarketListingFilledV1'
  | 'InventoryTransferredV1'
  | 'MarketTradeCompletedV1'
  | 'TaxAssessedV1'
  | 'TreasuryRevenueRecordedV1'
  | 'ScheduledActionCreatedV1'
  | 'ScheduledActionCancelledV1'
  | 'WorldCommerceReconciledV1';

export interface ParticipantPlan {
  category:
    | 'asset'
    | 'business'
    | 'contract'
    | 'currency'
    | 'inventory'
    | 'listing'
    | 'offer'
    | 'production'
    | 'tax'
    | 'trade'
    | 'wallet';
  entities: ReadonlyArray<{ counterpartyEntityId: string | null; entityId: string }>;
  eventId: string;
  summaryArgs: Record<string, JsonValue>;
  summaryCode: string;
}

export interface PreparedEconomyCommand {
  commerceChecksum?: Buffer | null;
  economyChecksum: Buffer | null;
  events: PlannedEconomyEvent[];
  overrideId: string | null;
  participants: ParticipantPlan[];
}

export type EconomyFinalizationInput = Pick<
  EconomyCommandExecutionInput,
  'authorizationRuleId' | 'command' | 'decidedAt' | 'request' | 'world'
>;

interface LockedEconomyContext {
  clock: ClockRow;
  head: EconomyHeadRow;
}

interface PersistedEvent {
  envelope: DomainEventHashInputV1 & { eventHash: string };
  ledgerSequence: string;
}

interface ReconciliationSnapshot extends QueryResultRow {
  assetCount: number;
  currencyCount: number;
  liveOwnershipChecksum: string;
  liveProjectionChecksum: string;
  liveSupplyChecksum: string;
  liveWalletChecksum: string;
  matched: boolean;
  mismatchCount: number;
  rebuiltJournalChecksum: string;
  rebuiltOwnershipChecksum: string;
  rebuiltSupplyChecksum: string;
  rebuiltWalletChecksum: string;
  walletCount: number;
}

export class EconomyCommandExecutionError extends Error {
  public constructor(
    readonly code: WorldCommandRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'EconomyCommandExecutionError';
  }
}

export async function executePostgresEconomyCommand(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
): Promise<WorldCommandResultTransport> {
  await executor.query('savepoint worldgraph_economy_command_effects');
  try {
    const result = await executeEconomyCommandEffects(executor, ids, input);
    await executor.query('release savepoint worldgraph_economy_command_effects');
    return result;
  } catch (error) {
    await executor.query('rollback to savepoint worldgraph_economy_command_effects');
    await executor.query('release savepoint worldgraph_economy_command_effects');
    throw error;
  }
}

async function executeEconomyCommandEffects(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
): Promise<WorldCommandResultTransport> {
  const startedAt = performance.now();
  await enforceOperationalPolicy(executor, input);
  const resultingStateRevision = incrementDecimal(input.world.stateRevision);
  let prepared: PreparedEconomyCommand;
  switch (input.request.type) {
    case ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND:
      prepared = await adoptLegacySeedPlan(executor, ids, input, resultingStateRevision);
      break;
    case INITIALIZE_WORLD_ECONOMY_COMMAND:
      prepared = await initializeWorldEconomy(executor, ids, input, resultingStateRevision);
      break;
    case TRANSFER_CURRENCY_COMMAND:
      prepared = await transferCurrency(executor, ids, input, resultingStateRevision);
      break;
    case ISSUE_CURRENCY_COMMAND:
      prepared = await issueCurrency(executor, ids, input, resultingStateRevision);
      break;
    case FREEZE_CURRENCY_COMMAND:
    case UNFREEZE_CURRENCY_COMMAND:
      prepared = await changeCurrencyStatus(executor, ids, input, resultingStateRevision);
      break;
    case FREEZE_WALLET_COMMAND:
    case UNFREEZE_WALLET_COMMAND:
      prepared = await changeWalletStatus(executor, ids, input, resultingStateRevision);
      break;
    case TRANSFER_ASSET_COMMAND:
      prepared = await transferAsset(executor, ids, input, resultingStateRevision);
      break;
    case CREATE_ASSET_TRANSFER_OFFER_COMMAND:
      prepared = await createAssetOffer(executor, ids, input, resultingStateRevision);
      break;
    case CANCEL_ASSET_TRANSFER_OFFER_COMMAND:
      prepared = await cancelAssetOffer(executor, ids, input, resultingStateRevision);
      break;
    case ACCEPT_ASSET_TRANSFER_OFFER_COMMAND:
      prepared = await acceptAssetOffer(executor, ids, input, resultingStateRevision);
      break;
    case RECONCILE_WORLD_ECONOMY_COMMAND:
      prepared = await reconcileWorldEconomy(executor, ids, input, resultingStateRevision);
      break;
    default:
      throw new EconomyCommandExecutionError(
        'COMMAND_TYPE_DISABLED',
        'The economy command type is disabled.',
      );
  }
  const result = await finalizeEconomyCommand(
    executor,
    ids,
    input,
    prepared,
    resultingStateRevision,
  );
  if (input.request.type === RECONCILE_WORLD_ECONOMY_COMMAND) {
    const outcome = prepared.events[0]?.payload.status === 'matched' ? 'matched' : 'mismatch';
    telemetry.economyReconciliationRuns.add(1, { outcome, trigger: 'command' });
    telemetry.economyReconciliationDuration.record(performance.now() - startedAt, { outcome });
    if (outcome === 'mismatch') {
      telemetry.economyInvariantFindings.add(1, { check: 'reconciliation_mismatch' });
    }
  }
  return result;
}

export function economyCommandRejectionCode(error: unknown): WorldCommandRejectionCode | null {
  if (error instanceof EconomyCommandExecutionError) return error.code;
  if (!(error instanceof EconomyDomainError)) return null;
  switch (error.code) {
    case 'ECONOMY_ALREADY_INITIALIZED':
    case 'ECONOMY_NOT_INITIALIZED':
    case 'SEED_PLAN_INCOMPATIBLE':
    case 'SEED_PLAN_HASH_MISMATCH':
    case 'INVALID_AMOUNT_FORMAT':
    case 'INSUFFICIENT_FUNDS':
    case 'CURRENCY_FROZEN':
    case 'WALLET_NOT_CONTROLLED':
    case 'WALLET_FROZEN':
    case 'CURRENCY_MISMATCH':
    case 'SUPPLY_CAP_EXCEEDED':
    case 'ASSET_NOT_OWNED':
    case 'ASSET_NOT_TRANSFERABLE':
    case 'OFFER_EXPIRED':
    case 'OFFER_NOT_OPEN':
    case 'OFFER_NOT_DUE':
    case 'BUYER_MISMATCH':
    case 'OWNERSHIP_CONFLICT':
    case 'INSUFFICIENT_INVENTORY':
    case 'QUANTITY_INVALID':
    case 'RECIPE_INVALID':
    case 'PRODUCTION_STATE_INVALID':
    case 'CONTRACT_STATE_INVALID':
    case 'JOB_COOLDOWN':
    case 'JOB_CAP_EXCEEDED':
    case 'LISTING_STALE':
    case 'LISTING_EXPIRED':
    case 'LISTING_NOT_OPEN':
    case 'POLICY_INVALID':
    case 'CONFLICT':
      return error.code;
    case 'STALE_VERSION':
      return 'AGGREGATE_VERSION_CONFLICT';
    case 'ECONOMY_INTEGER_OVERFLOW':
      return 'INVALID_AMOUNT_FORMAT';
    case 'ACCOUNTING_UNBALANCED':
      return 'VALIDATION_FAILED';
    default:
      return null;
  }
}

async function enforceOperationalPolicy(
  executor: EconomySqlExecutor,
  input: EconomyCommandExecutionInput,
): Promise<void> {
  const type = input.request.type;
  if (
    (type === TRANSFER_CURRENCY_COMMAND || type === ACCEPT_ASSET_TRANSFER_OFFER_COMMAND) &&
    (!input.policy.transfersEnabled || input.policy.debitsFrozen)
  ) {
    throw new EconomyCommandExecutionError(
      'COMMAND_TYPE_DISABLED',
      'Economy debits or transfers are temporarily disabled.',
    );
  }
  if (
    (type === CREATE_ASSET_TRANSFER_OFFER_COMMAND ||
      type === CANCEL_ASSET_TRANSFER_OFFER_COMMAND ||
      type === ACCEPT_ASSET_TRANSFER_OFFER_COMMAND) &&
    !input.policy.offersEnabled
  ) {
    throw new EconomyCommandExecutionError(
      'COMMAND_TYPE_DISABLED',
      'Asset transfer offers are temporarily disabled.',
    );
  }
  if (type === ISSUE_CURRENCY_COMMAND && !input.policy.issuanceEnabled) {
    throw new EconomyCommandExecutionError(
      'COMMAND_TYPE_DISABLED',
      'Currency issuance is temporarily disabled.',
    );
  }

  const rate =
    type === ISSUE_CURRENCY_COMMAND
      ? { count: input.policy.issuanceRateLimitPerHour, interval: '1 hour' }
      : type === CREATE_ASSET_TRANSFER_OFFER_COMMAND
        ? { count: input.policy.offerRateLimitPerMinute, interval: '1 minute' }
        : type === TRANSFER_CURRENCY_COMMAND || type === ACCEPT_ASSET_TRANSFER_OFFER_COMMAND
          ? { count: input.policy.transferRateLimitPerMinute, interval: '1 minute' }
          : null;
  if (!rate) return;
  const usage = await executor.query<{ command_count: string }>(
    `select count(*)::text as command_count
       from command_records
      where world_id = $1 and actor_type = $2 and actor_id = $3
        and command_type = $4 and id <> $5
        and requested_at >= $6::timestamptz - $7::interval`,
    [
      input.command.worldId,
      input.command.actorType,
      input.command.actorId,
      type,
      input.command.commandId,
      input.decidedAt,
      rate.interval,
    ],
  );
  if (Number(usage.rows[0]?.command_count ?? '0') >= rate.count) {
    throw new ApplicationError(
      'RATE_LIMITED',
      'The economy command velocity limit has been reached.',
      429,
    );
  }
}

async function lockEconomyContext(
  executor: EconomySqlExecutor,
  input: EconomyCommandExecutionInput,
  mode: 'must_exist' | 'must_not_exist',
): Promise<LockedEconomyContext | { clock: ClockRow; head: null }> {
  const headResult = await executor.query<EconomyHeadRow>(
    `select source_world_version_id, seed_plan_hash, checksum,
            row_version::text, updated_state_revision::text, reconciliation_status::text
       from world_economy_heads where world_id = $1 for update`,
    [input.command.worldId],
  );
  const head = headResult.rows[0] ?? null;
  const clockResult = await executor.query<ClockRow>(
    `select current_tick::text from world_simulation_clocks
      where world_id = $1 for update`,
    [input.command.worldId],
  );
  const clock = clockResult.rows[0];
  if (!clock) {
    throw new EconomyCommandExecutionError(
      'ECONOMY_NOT_INITIALIZED',
      'The authoritative world clock is unavailable.',
    );
  }
  if (
    input.request.expectedTick !== undefined &&
    input.request.expectedTick !== clock.current_tick
  ) {
    throw new EconomyCommandExecutionError(
      'EXPECTED_TICK_MISMATCH',
      'The authoritative world tick changed.',
    );
  }
  if (mode === 'must_exist' && !head) {
    throw new EconomyCommandExecutionError(
      'ECONOMY_NOT_INITIALIZED',
      'The world economy has not been initialized.',
    );
  }
  if (mode === 'must_not_exist' && head) {
    throw new EconomyCommandExecutionError(
      'ECONOMY_ALREADY_INITIALIZED',
      'The world economy is already initialized.',
    );
  }
  if (head && input.request.expectedAggregateVersion !== head.row_version) {
    throw new EconomyCommandExecutionError(
      'AGGREGATE_VERSION_CONFLICT',
      'The world economy head changed.',
    );
  }
  if (!head && input.request.expectedAggregateVersion !== '0') {
    throw new EconomyCommandExecutionError(
      'AGGREGATE_VERSION_CONFLICT',
      'An uninitialized economy must begin at aggregate version zero.',
    );
  }
  return { clock, head };
}

async function lockCurrency(
  executor: EconomySqlExecutor,
  worldId: string,
  currencyId: string,
): Promise<CurrencyRow> {
  const result = await executor.query<CurrencyRow>(
    `select currency.id::text, currency.world_id::text,
            currency.stable_key::text, currency.code::text,
            currency.minor_unit_scale, currency.max_supply_minor::text,
            currency.issuer_entity_id::text, currency.status::text,
            currency.row_version::text as currency_row_version,
            supply.current_supply_minor::text,
            supply.row_version::text as supply_row_version
       from currencies currency
       join currency_supply supply
         on supply.world_id = currency.world_id and supply.currency_id = currency.id
      where currency.world_id = $1 and currency.id = $2
      for update of currency, supply`,
    [worldId, currencyId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new EconomyCommandExecutionError('VALIDATION_FAILED', 'The currency was not found.');
  }
  return row;
}

async function lockWallets(
  executor: EconomySqlExecutor,
  worldId: string,
  walletIds: readonly string[],
  actorId: string,
): Promise<Map<string, WalletRow>> {
  const unique = [...new Set(walletIds)].sort();
  const result = await executor.query<WalletRow>(
    `select wallet.id::text, wallet.world_id::text, wallet.currency_id::text,
            wallet.stable_key::text, wallet.owner_entity_id::text,
            owner.logical_key::text as owner_logical_key,
            wallet.wallet_kind::text, wallet.status::text,
            wallet.row_version::text as wallet_row_version,
            balance.available_minor::text,
            balance.row_version::text as balance_row_version,
            worldgraph_user_controls_economy_entity_v1(
              wallet.world_id,$3,wallet.owner_entity_id
            ) as controlled_by_actor
       from wallets wallet
       join wallet_balances balance
         on balance.world_id = wallet.world_id and balance.wallet_id = wallet.id
       join world_entities owner
         on owner.world_id = wallet.world_id and owner.id = wallet.owner_entity_id
      where wallet.world_id = $1 and wallet.id = any($2::uuid[])
        and owner.retired_world_version_id is null
      order by wallet.id
      for update of wallet, balance`,
    [worldId, unique, actorId],
  );
  if (result.rows.length !== unique.length) {
    throw new EconomyCommandExecutionError(
      'WALLET_NOT_CONTROLLED',
      'One or more wallets are unavailable.',
    );
  }
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function lockAsset(
  executor: EconomySqlExecutor,
  worldId: string,
  assetKey: string,
  actorId: string,
): Promise<AssetRow> {
  const result = await executor.query<AssetRow>(
    `select asset.id::text, asset.world_id::text, asset.stable_key::text,
            (asset.transferable and not exists (
              select 1 from business_facilities facility
               where facility.world_id=asset.world_id and facility.facility_asset_id=asset.id
                 and facility.status in ('active','disabled')
            )) as transferable, asset.status = 'active' as active,
            ownership.owner_entity_id::text,
            owner.logical_key::text as owner_logical_key,
            ownership.ownership_version::text,
            worldgraph_user_controls_economy_entity_v1(
              asset.world_id,$3,ownership.owner_entity_id
            ) as controlled_by_actor
       from assets asset
       join asset_ownership ownership
         on ownership.world_id = asset.world_id and ownership.asset_id = asset.id
       join world_entities owner
         on owner.world_id = ownership.world_id and owner.id = ownership.owner_entity_id
      where asset.world_id = $1 and asset.stable_key = $2
        and owner.retired_world_version_id is null
      for update of ownership`,
    [worldId, assetKey, actorId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new EconomyCommandExecutionError('ASSET_NOT_OWNED', 'The asset is unavailable.');
  }
  return row;
}

async function lockOffer(
  executor: EconomySqlExecutor,
  worldId: string,
  offerId: string,
): Promise<OfferRow> {
  const result = await executor.query<OfferRow>(
    `select offer.id::text, offer.world_id::text, offer.asset_id::text,
            offer.seller_entity_id::text, seller.logical_key::text as seller_logical_key,
            offer.buyer_entity_id::text, buyer.logical_key::text as buyer_logical_key,
            offer.currency_id::text, offer.price_minor::text,
            offer.expires_at_tick::text, offer.status::text,
            offer.seller_wallet_id::text, offer.row_version::text,
            stream.current_version::text as aggregate_version
       from asset_transfer_offers offer
       join world_entities seller
         on seller.world_id = offer.world_id and seller.id = offer.seller_entity_id
       left join world_entities buyer
         on buyer.world_id = offer.world_id and buyer.id = offer.buyer_entity_id
       join aggregate_stream_heads stream
         on stream.world_id = offer.world_id
        and stream.aggregate_type = 'asset_transfer_offer'
        and stream.aggregate_id = offer.id::text
      where offer.world_id = $1 and offer.id = $2
        and seller.retired_world_version_id is null
        and (buyer.id is null or buyer.retired_world_version_id is null)
      for update of offer`,
    [worldId, offerId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new EconomyCommandExecutionError('OFFER_NOT_OPEN', 'The offer is unavailable.');
  }
  return row;
}

async function entityByLogicalKey(
  executor: EconomySqlExecutor,
  worldId: string,
  logicalKey: string,
): Promise<EntityRow> {
  const result = await executor.query<EntityRow>(
    `select id::text, logical_key::text from world_entities
      where world_id = $1 and logical_key = $2 and retired_world_version_id is null
      for share`,
    [worldId, logicalKey],
  );
  const row = result.rows[0];
  if (!row) {
    throw new EconomyCommandExecutionError('ENTITY_NOT_FOUND', 'The world entity was not found.');
  }
  return row;
}

function currencyDecision(row: CurrencyRow) {
  return {
    currentSupplyMinor: BigInt(row.current_supply_minor),
    id: row.id,
    maxSupplyMinor: row.max_supply_minor === null ? null : BigInt(row.max_supply_minor),
    rowVersion: BigInt(row.supply_row_version),
    status: row.status,
    worldId: row.world_id,
  };
}

function walletDecision(row: WalletRow, controlledByActor = row.controlled_by_actor) {
  return {
    availableMinor: BigInt(row.available_minor),
    controlledByActor,
    currencyId: row.currency_id,
    id: row.id,
    rowVersion: BigInt(row.balance_row_version),
    status: row.status,
    worldId: row.world_id,
  };
}

function assetDecision(row: AssetRow) {
  return {
    active: row.active,
    controlledByActor: row.controlled_by_actor,
    id: row.id,
    ownerEntityLogicalKey: row.owner_logical_key,
    ownershipVersion: BigInt(row.ownership_version),
    transferable: row.transferable,
    worldId: row.world_id,
  };
}

function offerDecision(row: OfferRow) {
  return {
    assetId: row.asset_id,
    buyerEntityLogicalKey: row.buyer_logical_key,
    currencyId: row.currency_id,
    expiresAtTick: BigInt(row.expires_at_tick),
    id: row.id,
    priceMinor: BigInt(row.price_minor),
    rowVersion: BigInt(row.row_version),
    sellerEntityLogicalKey: row.seller_logical_key,
    sellerWalletId: row.seller_wallet_id,
    status: row.status,
    worldId: row.world_id,
  };
}

async function adoptLegacySeedPlan(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  _resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  await lockEconomyContext(executor, input, 'must_not_exist');
  const payload = input.request.payload as AdoptLegacyEconomySeedPlanPayloadV1;
  if (payload.compiledWorldVersionId !== input.world.activeWorldVersionId) {
    throw new EconomyCommandExecutionError(
      'WORLD_VERSION_CONFLICT',
      'The legacy artifact is not the active world version.',
    );
  }
  const plan = assertEconomySeedPlanV1(payload.seedPlan);
  if (economySeedPlanHash(plan) !== payload.seedPlanHash) {
    throw new EconomyDomainError(
      'SEED_PLAN_HASH_MISMATCH',
      'The reviewed legacy seed plan hash does not match its canonical content.',
    );
  }
  const source = await executor.query<{
    artifact_hash: Buffer;
    artifact_schema_version: number;
    canonical_content: unknown;
    compilation_run_id: string;
    compiler_version: string;
    source_artifact_id: string;
  }>(
    `select version.compilation_run_id::text,
            version.compiler_version,
            artifact.id::text as source_artifact_id,
            artifact.artifact_schema_version,
            artifact.content_hash as artifact_hash,
            artifact.canonical_content
       from world_versions version
       join world_compilation_runs run
         on run.id = version.compilation_run_id and run.world_id = version.world_id
       join compiled_world_artifacts artifact
         on artifact.compilation_run_id = run.id and artifact.world_id = run.world_id
        and artifact.artifact_kind = 'compiled_world'
      where version.world_id = $1 and version.id = $2
        and version.compiler_version = '1.0.0'
        and run.compiler_version = '1.0.0'
        and artifact.artifact_schema_version = 1`,
    [input.command.worldId, payload.compiledWorldVersionId],
  );
  const artifact = source.rows[0];
  if (
    !artifact ||
    artifact.compiler_version !== payload.legacyCompilerVersion ||
    artifact.artifact_schema_version !== payload.legacyArtifactSchemaVersion ||
    artifact.artifact_hash.toString('hex') !== payload.legacyArtifactHash
  ) {
    throw new EconomyDomainError(
      'SEED_PLAN_INCOMPATIBLE',
      'The legacy seed adapter does not match the active immutable artifact.',
    );
  }
  if (!compiledWorldV1Validator.is(artifact.canonical_content)) {
    throw new EconomyDomainError(
      'SEED_PLAN_INCOMPATIBLE',
      'The immutable legacy artifact does not satisfy the reviewed v1 schema.',
    );
  }
  const computedArtifactHash = createHash('sha256')
    .update(canonicalJson(artifact.canonical_content), 'utf8')
    .digest('hex');
  if (
    computedArtifactHash !== payload.legacyArtifactHash ||
    computedArtifactHash !== artifact.artifact_hash.toString('hex')
  ) {
    throw new EconomyDomainError(
      'SEED_PLAN_INCOMPATIBLE',
      'The immutable legacy artifact hash does not match its canonical content.',
    );
  }
  const derived = deriveLegacyEconomySeedPlanV1(artifact.canonical_content);
  if (
    derived.value === null ||
    derived.value.hash !== payload.seedPlanHash ||
    canonicalJson(derived.value.plan) !== canonicalJson(plan)
  ) {
    throw new EconomyDomainError(
      'SEED_PLAN_INCOMPATIBLE',
      'The submitted seed plan is not the deterministic plan derived from the legacy artifact.',
    );
  }
  const planId = ids.next();
  const eventId = ids.next();
  await executor.query(
    `insert into compiled_economy_seed_plans(
       id, world_id, world_version_id, compilation_run_id, source_artifact_id,
       seed_plan_schema_version, source_kind, source_compiler_version,
       source_adapter_id, source_adapter_version, canonical_plan, plan_hash,
       source_artifact_hash, adopted_command_id, adopted_event_id, created_at
     ) values (
       $1,$2,$3,$4,$5,1,'legacy_1_0_adapter','1.0.0',
       $6,$7,$8,$9,$10,$11,$12,$13
     )`,
    [
      planId,
      input.command.worldId,
      payload.compiledWorldVersionId,
      artifact.compilation_run_id,
      artifact.source_artifact_id,
      payload.adapterId,
      payload.adapterVersion,
      JSON.stringify(plan),
      Buffer.from(payload.seedPlanHash, 'hex'),
      artifact.artifact_hash,
      input.command.commandId,
      eventId,
      input.decidedAt,
    ],
  );
  const eventPayload: LegacyEconomySeedPlanAdoptedPayloadV1 = {
    adapterId: payload.adapterId,
    adapterVersion: payload.adapterVersion,
    compiledWorldVersionId: payload.compiledWorldVersionId,
    legacyArtifactHash: payload.legacyArtifactHash,
    legacyArtifactSchemaVersion: payload.legacyArtifactSchemaVersion,
    legacyCompilerVersion: payload.legacyCompilerVersion,
    seedPlanHash: payload.seedPlanHash,
  };
  return {
    economyChecksum: null,
    events: [
      {
        aggregateId: planId,
        aggregateType: 'economy_seed_plan',
        eventId,
        eventType: 'LegacyEconomySeedPlanAdoptedV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [],
  };
}

async function initializeWorldEconomy(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_not_exist');
  const payload = input.request.payload as InitializeWorldEconomyPayloadV1;
  if (payload.compiledWorldVersionId !== input.world.activeWorldVersionId) {
    throw new EconomyCommandExecutionError(
      'WORLD_VERSION_CONFLICT',
      'The economy seed plan is not for the active world version.',
    );
  }
  const planResult = await executor.query<{
    canonical_plan: unknown;
    plan_hash: Buffer;
  }>(
    `select canonical_plan, plan_hash
       from compiled_economy_seed_plans
      where world_id = $1 and world_version_id = $2 and plan_hash = $3`,
    [
      input.command.worldId,
      payload.compiledWorldVersionId,
      Buffer.from(payload.seedPlanHash, 'hex'),
    ],
  );
  const planRow = planResult.rows[0];
  if (!planRow) {
    throw new EconomyDomainError(
      'SEED_PLAN_HASH_MISMATCH',
      'The selected compiled economy seed plan is unavailable.',
    );
  }
  const plan = assertEconomySeedPlan(planRow.canonical_plan);
  if (
    planRow.plan_hash.toString('hex') !== payload.seedPlanHash ||
    economySeedPlanHash(plan) !== payload.seedPlanHash
  ) {
    throw new EconomyDomainError(
      'SEED_PLAN_HASH_MISMATCH',
      'The selected compiled economy seed plan hash is invalid.',
    );
  }
  if (BigInt(plan.initialSupplyMinor) <= 0n) {
    throw new EconomyDomainError(
      'SEED_PLAN_INCOMPATIBLE',
      'The accounting journal requires a positive initial supply.',
    );
  }

  const logicalKeys = new Set<string>([
    plan.currency.issuerEntityLogicalKey,
    ...plan.wallets.map((wallet) => wallet.ownerEntityLogicalKey),
    ...plan.assets.map((asset) => asset.initialOwnerEntityLogicalKey),
    ...plan.assets.flatMap((asset) =>
      asset.worldEntityLogicalKey === null ? [] : [asset.worldEntityLogicalKey],
    ),
  ]);
  const entityResult = await executor.query<EntityRow>(
    `select id::text, logical_key::text from world_entities
      where world_id = $1 and logical_key::text = any($2::text[])
        and retired_world_version_id is null
      order by id for share`,
    [input.command.worldId, [...logicalKeys]],
  );
  const entities = new Map(entityResult.rows.map((row) => [row.logical_key, row.id]));
  if (entities.size !== logicalKeys.size) {
    throw new EconomyDomainError(
      'SEED_PLAN_INCOMPATIBLE',
      'The seed plan references an entity outside the active world projection.',
    );
  }

  const eventId = ids.next();
  const currencyId = ids.next();
  const transactionId = ids.next();
  const issuerEntityId = requiredEntity(entities, plan.currency.issuerEntityLogicalKey);
  await executor.query(
    `insert into currencies(
       id, world_id, stable_key, code, name, minor_unit_scale,
       max_supply_minor, issuer_entity_id, currency_schema_version,
       status, row_version, created_event_id, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7::bigint,$8,1,'active',1,$9,$10,$10)`,
    [
      currencyId,
      input.command.worldId,
      plan.currency.stableKey,
      plan.currency.code,
      plan.currency.name,
      plan.currency.minorUnitScale,
      plan.currency.maxSupplyMinor,
      issuerEntityId,
      eventId,
      input.decidedAt,
    ],
  );
  await executor.query(
    `insert into currency_supply(
       currency_id, world_id, current_supply_minor, row_version,
       updated_state_revision, updated_at
     ) values ($1,$2,$3::bigint,1,$4::bigint,$5)`,
    [
      currencyId,
      input.command.worldId,
      plan.initialSupplyMinor,
      resultingStateRevision,
      input.decidedAt,
    ],
  );

  const walletIds = new Map<string, string>();
  const positiveWallets: Array<{ balance: string; id: string }> = [];
  for (const wallet of plan.wallets) {
    const walletId = ids.next();
    walletIds.set(wallet.stableKey, walletId);
    await executor.query(
      `insert into wallets(
         id, world_id, currency_id, stable_key, owner_entity_id,
         wallet_kind, status, wallet_schema_version, row_version,
         created_event_id, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,'active',1,1,$7,$8,$8)`,
      [
        walletId,
        input.command.worldId,
        currencyId,
        wallet.stableKey,
        requiredEntity(entities, wallet.ownerEntityLogicalKey),
        wallet.walletKind,
        eventId,
        input.decidedAt,
      ],
    );
    await executor.query(
      `insert into wallet_balances(
         wallet_id, world_id, currency_id, available_minor,
         row_version, updated_state_revision, updated_at
       ) values ($1,$2,$3,$4::bigint,1,$5::bigint,$6)`,
      [
        walletId,
        input.command.worldId,
        currencyId,
        wallet.initialBalanceMinor,
        resultingStateRevision,
        input.decidedAt,
      ],
    );
    if (BigInt(wallet.initialBalanceMinor) > 0n) {
      positiveWallets.push({ balance: wallet.initialBalanceMinor, id: walletId });
    }
  }
  if (positiveWallets.length < 1 || positiveWallets.length > 101) {
    throw new EconomyDomainError(
      'SEED_PLAN_INCOMPATIBLE',
      'The initialization journal posting set is outside the v1 bounds.',
    );
  }
  await executor.query(
    `insert into financial_transactions(
       id, world_id, currency_id, transaction_kind, supply_delta_minor,
       command_id, event_id, memo_code, memo_text,
       occurred_tick, state_revision, created_at
     ) values ($1,$2,$3,'initialization',$4::bigint,$5,$6,
               'economy_initialization',null,$7::bigint,$8::bigint,$9)`,
    [
      transactionId,
      input.command.worldId,
      currencyId,
      plan.initialSupplyMinor,
      input.command.commandId,
      eventId,
      context.clock.current_tick,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  for (const [postingOrdinal, wallet] of positiveWallets.entries()) {
    await executor.query(
      `insert into wallet_postings(
         id, transaction_id, world_id, currency_id, wallet_id,
         posting_ordinal, signed_amount_minor, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7::bigint,$8)`,
      [
        ids.next(),
        transactionId,
        input.command.worldId,
        currencyId,
        wallet.id,
        postingOrdinal,
        wallet.balance,
        input.decidedAt,
      ],
    );
  }

  const assetRows: Array<{ assetId: string; transferId: string }> = [];
  for (const asset of plan.assets) {
    const assetId = ids.next();
    const transferId = ids.next();
    const ownerEntityId = requiredEntity(entities, asset.initialOwnerEntityLogicalKey);
    assetRows.push({ assetId, transferId });
    await executor.query(
      `insert into assets(
         id, world_id, stable_key, asset_type, world_entity_id,
         asset_schema_version, metadata, transferable, status,
         created_event_id, created_at
       ) values ($1,$2,$3,$4,$5,1,$6,$7,'active',$8,$9)`,
      [
        assetId,
        input.command.worldId,
        asset.stableKey,
        asset.assetType,
        asset.worldEntityLogicalKey === null
          ? null
          : requiredEntity(entities, asset.worldEntityLogicalKey),
        JSON.stringify(asset.metadata),
        asset.transferable,
        eventId,
        input.decidedAt,
      ],
    );
    await executor.query(
      `insert into asset_ownership(
         asset_id, world_id, owner_entity_id, ownership_version,
         acquired_event_id, updated_state_revision, updated_at
       ) values ($1,$2,$3,1,$4,$5::bigint,$6)`,
      [
        assetId,
        input.command.worldId,
        ownerEntityId,
        eventId,
        resultingStateRevision,
        input.decidedAt,
      ],
    );
    await executor.query(
      `insert into asset_transfers(
         id, world_id, asset_id, from_owner_entity_id, to_owner_entity_id,
         transfer_kind, financial_transaction_id, command_id, event_id,
         occurred_tick, state_revision, created_at
       ) values ($1,$2,$3,null,$4,'initial',null,$5,$6,$7::bigint,$8::bigint,$9)`,
      [
        transferId,
        input.command.worldId,
        assetId,
        ownerEntityId,
        input.command.commandId,
        eventId,
        context.clock.current_tick,
        resultingStateRevision,
        input.decidedAt,
      ],
    );
  }

  const checksumResult = await executor.query<{ checksum: Buffer }>(
    `select worldgraph_economy_initial_projection_checksum($1,$2,$3) as checksum`,
    [
      input.command.worldId,
      payload.compiledWorldVersionId,
      Buffer.from(payload.seedPlanHash, 'hex'),
    ],
  );
  const economyChecksum = requiredChecksum(checksumResult.rows[0]?.checksum);
  await executor.query(
    `insert into world_economy_heads(
       world_id, economy_schema_version, source_world_version_id, seed_plan_hash,
       initialized_command_id, initialized_event_id, checksum, row_version,
       updated_state_revision, reconciliation_status, initialized_at, updated_at
     ) values ($1,1,$2,$3,$4,$5,$6,1,$7::bigint,'pending',$8,$8)`,
    [
      input.command.worldId,
      payload.compiledWorldVersionId,
      Buffer.from(payload.seedPlanHash, 'hex'),
      input.command.commandId,
      eventId,
      economyChecksum,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const eventPayload: WorldEconomyInitializedPayloadV1 = {
    assetCount: String(assetRows.length),
    compiledWorldVersionId: payload.compiledWorldVersionId,
    currencyId,
    initialSupplyMinor: plan.initialSupplyMinor,
    initializationTransactionId: transactionId,
    ownershipCount: String(assetRows.length),
    seedPlanHash: payload.seedPlanHash,
    seedPlanSchemaVersion: plan.economySeedPlanSchemaVersion,
    walletCount: String(plan.wallets.length),
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: input.command.worldId,
        aggregateType: 'world_economy',
        eventId,
        eventType: 'WorldEconomyInitializedV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [],
  };
}

async function transferCurrency(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  assertMutationHeadAvailable(head);
  const payload = input.request.payload as TransferCurrencyPayloadV1;
  const identities = await executor.query<{ currency_id: string; id: string }>(
    `select id::text, currency_id::text from wallets
      where world_id = $1 and id = any($2::uuid[])`,
    [input.command.worldId, [payload.sourceWalletId, payload.destinationWalletId]],
  );
  const sourceIdentity = identities.rows.find((row) => row.id === payload.sourceWalletId);
  if (!sourceIdentity) {
    throw new EconomyDomainError('WALLET_NOT_CONTROLLED', 'The source wallet is unavailable.');
  }
  const currency = await lockCurrency(executor, input.command.worldId, sourceIdentity.currency_id);
  const wallets = await lockWallets(
    executor,
    input.command.worldId,
    [payload.sourceWalletId, payload.destinationWalletId],
    input.command.actorId,
  );
  const source = wallets.get(payload.sourceWalletId)!;
  const destination = wallets.get(payload.destinationWalletId)!;
  const amountMinor = parseCanonicalAmount(payload.amount, currency.minor_unit_scale);
  const decision = decideCurrencyTransfer({
    amountMinor,
    currency: currencyDecision(currency),
    destination: walletDecision(destination, false),
    expectedDestinationVersion: BigInt(payload.expectedDestinationVersion),
    expectedSourceVersion: BigInt(payload.expectedSourceVersion),
    source: walletDecision(source),
  });
  const rapidCycle = await executor.query<{ cycle_recent: boolean }>(
    `with recursive recent_edges(source_wallet_id,destination_wallet_id) as (
       select outgoing.wallet_id,incoming.wallet_id
       from financial_transactions tx
       join wallet_postings outgoing
         on outgoing.transaction_id = tx.id
        and outgoing.signed_amount_minor < 0
       join wallet_postings incoming
         on incoming.transaction_id = tx.id
        and incoming.signed_amount_minor > 0
       where tx.world_id = $1
         and tx.transaction_kind = 'transfer'
         and tx.currency_id = $5
         and tx.occurred_tick between greatest($4::bigint - 10, 0) and $4::bigint
     ), reachable(wallet_id) as (
       select $2::uuid
       union
       select edge.destination_wallet_id
       from recent_edges edge
       join reachable path on edge.source_wallet_id = path.wallet_id
     )
     select exists (
       select 1 from reachable
       where wallet_id = $3::uuid and $2::uuid <> $3::uuid
     ) as cycle_recent`,
    [input.command.worldId, destination.id, source.id, context.clock.current_tick, currency.id],
  );
  if (rapidCycle.rows[0]?.cycle_recent === true) {
    telemetry.economyAbuseSignals.add(1, { signal: 'rapid_circular_transfer' });
  }
  const eventId = ids.next();
  const transactionId = ids.next();
  await updateBalance(executor, input, source, decision.sourceBalanceMinor, resultingStateRevision);
  await updateBalance(
    executor,
    input,
    destination,
    decision.destinationBalanceMinor,
    resultingStateRevision,
  );
  await insertFinancialTransaction(
    executor,
    {
      command: input.command,
      createdAt: input.decidedAt,
      currencyId: currency.id,
      eventId,
      id: transactionId,
      kind: 'transfer',
      memoCode: 'member_transfer',
      memoText: payload.memo ?? null,
      occurredTick: context.clock.current_tick,
      postings: decision.transaction.postings,
      resultingStateRevision,
      supplyDeltaMinor: decision.transaction.supplyDeltaMinor,
    },
    ids,
  );
  const economyChecksum = await updateEconomyHead(executor, input, head, resultingStateRevision);
  const eventPayload: CurrencyTransferredPayloadV1 = {
    amountMinor: amountMinor.toString(),
    currencyId: currency.id,
    destinationWalletId: destination.id,
    sourceWalletId: source.id,
    transactionId,
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: currency.id,
        aggregateType: 'currency',
        eventId,
        eventType: 'CurrencyTransferredV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [
      participantPlan(
        eventId,
        'currency',
        'CURRENCY_TRANSFERRED',
        { transactionId },
        source.owner_entity_id,
        destination.owner_entity_id,
      ),
    ],
  };
}

async function issueCurrency(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  assertMutationHeadAvailable(head);
  const payload = input.request.payload as IssueCurrencyPayloadV1;
  const walletIdentity = await executor.query<{ currency_id: string }>(
    `select currency_id::text from wallets where world_id = $1 and id = $2`,
    [input.command.worldId, payload.treasuryWalletId],
  );
  const currencyId = walletIdentity.rows[0]?.currency_id;
  if (!currencyId) {
    throw new EconomyDomainError('WALLET_NOT_CONTROLLED', 'The treasury wallet is unavailable.');
  }
  const currency = await lockCurrency(executor, input.command.worldId, currencyId);
  const wallets = await lockWallets(
    executor,
    input.command.worldId,
    [payload.treasuryWalletId],
    input.command.actorId,
  );
  const treasury = wallets.get(payload.treasuryWalletId)!;
  if (
    treasury.wallet_kind !== 'treasury' ||
    treasury.owner_entity_id !== currency.issuer_entity_id
  ) {
    throw new EconomyDomainError(
      'WALLET_NOT_CONTROLLED',
      'Issuance requires the currency issuer treasury.',
    );
  }
  const amountMinor = parseCanonicalAmount(payload.amount, currency.minor_unit_scale);
  const decision = decideCurrencyIssuance({
    amountMinor,
    currency: currencyDecision(currency),
    expectedSupplyVersion: BigInt(payload.expectedSupplyVersion),
    treasury: walletDecision(treasury, true),
  });
  const eventId = ids.next();
  const transactionId = ids.next();
  await updateBalance(
    executor,
    input,
    treasury,
    BigInt(treasury.available_minor) + amountMinor,
    resultingStateRevision,
  );
  const supply = await executor.query(
    `update currency_supply
        set current_supply_minor = $3::bigint, row_version = row_version + 1,
            updated_state_revision = $4::bigint,
            updated_at = greatest(updated_at,$5)
      where world_id = $1 and currency_id = $2 and row_version = $6::bigint`,
    [
      input.command.worldId,
      currency.id,
      decision.resultingSupplyMinor.toString(),
      resultingStateRevision,
      input.decidedAt,
      payload.expectedSupplyVersion,
    ],
  );
  if ((supply.rowCount ?? 0) !== 1) stale('The currency supply changed.');
  await insertFinancialTransaction(
    executor,
    {
      command: input.command,
      createdAt: input.decidedAt,
      currencyId: currency.id,
      eventId,
      id: transactionId,
      kind: 'issuance',
      memoCode: 'creator_issuance',
      memoText: payload.reason,
      occurredTick: context.clock.current_tick,
      postings: decision.transaction.postings,
      resultingStateRevision,
      supplyDeltaMinor: decision.transaction.supplyDeltaMinor,
    },
    ids,
  );
  const overrideId = await insertIssuanceOverride(
    executor,
    ids,
    input,
    currency.id,
    payload.reason,
  );
  const economyChecksum = await updateEconomyHead(executor, input, head, resultingStateRevision);
  const eventPayload: CurrencyIssuedPayloadV1 = {
    amountMinor: amountMinor.toString(),
    currencyId: currency.id,
    reason: payload.reason,
    resultingSupplyMinor: decision.resultingSupplyMinor.toString(),
    transactionId,
    treasuryWalletId: treasury.id,
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: currency.id,
        aggregateType: 'currency',
        eventId,
        eventType: 'CurrencyIssuedV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId,
    participants: [],
  };
}

async function changeCurrencyStatus(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  assertMutationHeadAvailable(head);
  const payload = input.request.payload as FreezeCurrencyPayloadV1;
  const currency = await lockCurrency(executor, input.command.worldId, payload.currencyId);
  if (currency.currency_row_version !== payload.expectedCurrencyVersion) {
    stale('The currency status version changed.');
  }
  const requested = input.request.type === FREEZE_CURRENCY_COMMAND ? 'frozen' : 'active';
  const status = decideCurrencyStatusChange(currency.status, requested);
  const result = await executor.query<{ row_version: string }>(
    `update currencies
        set status = $3, row_version = row_version + 1,
            updated_at = greatest(updated_at,$4)
      where world_id = $1 and id = $2 and row_version = $5::bigint
      returning row_version::text`,
    [input.command.worldId, currency.id, status, input.decidedAt, payload.expectedCurrencyVersion],
  );
  const currencyVersion = result.rows[0]?.row_version;
  if (!currencyVersion) stale('The currency status changed.');
  const economyChecksum = await updateEconomyHead(executor, input, head, resultingStateRevision);
  const eventId = ids.next();
  const eventPayload: CurrencyFrozenPayloadV1 = {
    currencyId: currency.id,
    currencyVersion,
    reason: payload.reason,
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: currency.id,
        aggregateType: 'currency',
        eventId,
        eventType:
          input.request.type === FREEZE_CURRENCY_COMMAND
            ? 'CurrencyFrozenV1'
            : 'CurrencyUnfrozenV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [],
  };
}

async function changeWalletStatus(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  assertMutationHeadAvailable(head);
  const payload = input.request.payload as FreezeWalletPayloadV1;
  const identity = await executor.query<{ currency_id: string }>(
    `select currency_id::text from wallets where world_id = $1 and id = $2`,
    [input.command.worldId, payload.walletId],
  );
  const currencyId = identity.rows[0]?.currency_id;
  if (!currencyId) {
    throw new EconomyDomainError('WALLET_NOT_CONTROLLED', 'The wallet is unavailable.');
  }
  await lockCurrency(executor, input.command.worldId, currencyId);
  const wallets = await lockWallets(
    executor,
    input.command.worldId,
    [payload.walletId],
    input.command.actorId,
  );
  const wallet = wallets.get(payload.walletId)!;
  if (wallet.wallet_row_version !== payload.expectedWalletVersion) {
    stale('The wallet status version changed.');
  }
  const requested = input.request.type === FREEZE_WALLET_COMMAND ? 'frozen' : 'active';
  const status = decideWalletStatusChange(wallet.status, requested);
  const result = await executor.query<{ row_version: string }>(
    `update wallets
        set status = $3, row_version = row_version + 1,
            updated_at = greatest(updated_at,$4)
      where world_id = $1 and id = $2 and row_version = $5::bigint
      returning row_version::text`,
    [input.command.worldId, wallet.id, status, input.decidedAt, payload.expectedWalletVersion],
  );
  const walletVersion = result.rows[0]?.row_version;
  if (!walletVersion) stale('The wallet status changed.');
  const economyChecksum = await updateEconomyHead(executor, input, head, resultingStateRevision);
  const eventId = ids.next();
  const eventPayload: WalletFrozenPayloadV1 = {
    reason: payload.reason,
    walletId: wallet.id,
    walletVersion,
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: wallet.id,
        aggregateType: 'wallet',
        eventId,
        eventType:
          input.request.type === FREEZE_WALLET_COMMAND ? 'WalletFrozenV1' : 'WalletUnfrozenV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [
      {
        category: 'wallet',
        entities: [{ counterpartyEntityId: null, entityId: wallet.owner_entity_id }],
        eventId,
        summaryArgs: { walletVersion },
        summaryCode:
          input.request.type === FREEZE_WALLET_COMMAND ? 'WALLET_FROZEN' : 'WALLET_UNFROZEN',
      },
    ],
  };
}

async function transferAsset(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  assertMutationHeadAvailable(head);
  const payload = input.request.payload as TransferAssetPayloadV1;
  const identity = await executor.query<{ id: string }>(
    `select id::text from assets where world_id = $1 and stable_key = $2`,
    [input.command.worldId, payload.assetKey],
  );
  const assetId = identity.rows[0]?.id;
  if (!assetId) {
    throw new EconomyDomainError('ASSET_NOT_OWNED', 'The asset is unavailable.');
  }
  const openOffer = await executor.query<{ id: string }>(
    `select id::text from asset_transfer_offers
      where world_id = $1 and asset_id = $2 and status = 'open'
      for update`,
    [input.command.worldId, assetId],
  );
  if (openOffer.rows[0]) {
    throw new EconomyDomainError(
      'OWNERSHIP_CONFLICT',
      'An open transfer offer must be cancelled before gifting this asset.',
    );
  }
  const asset = await lockAsset(
    executor,
    input.command.worldId,
    payload.assetKey,
    input.command.actorId,
  );
  const recipient = await entityByLogicalKey(
    executor,
    input.command.worldId,
    payload.toOwnerEntityKey,
  );
  const decision = decideAssetGift({
    asset: assetDecision(asset),
    expectedOwnershipVersion: BigInt(payload.expectedOwnershipVersion),
    recipientEntityLogicalKey: recipient.logical_key,
  });
  const eventId = ids.next();
  const transferId = ids.next();
  const updated = await executor.query(
    `update asset_ownership
        set owner_entity_id = $3, ownership_version = ownership_version + 1,
            acquired_event_id = $4, updated_state_revision = $5::bigint,
            updated_at = greatest(updated_at,$6)
      where world_id = $1 and asset_id = $2 and ownership_version = $7::bigint`,
    [
      input.command.worldId,
      asset.id,
      recipient.id,
      eventId,
      resultingStateRevision,
      input.decidedAt,
      payload.expectedOwnershipVersion,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) stale('The asset owner changed.');
  await executor.query(
    `insert into asset_transfers(
       id, world_id, asset_id, from_owner_entity_id, to_owner_entity_id,
       transfer_kind, financial_transaction_id, command_id, event_id,
       occurred_tick, state_revision, created_at
     ) values ($1,$2,$3,$4,$5,'grant',null,$6,$7,$8::bigint,$9::bigint,$10)`,
    [
      transferId,
      input.command.worldId,
      asset.id,
      asset.owner_entity_id,
      recipient.id,
      input.command.commandId,
      eventId,
      context.clock.current_tick,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const economyChecksum = await updateEconomyHead(executor, input, head, resultingStateRevision);
  const eventPayload: AssetOwnershipTransferredPayloadV1 = {
    assetId: asset.id,
    assetKey: asset.stable_key,
    financialTransactionId: null,
    fromOwnerEntityLogicalKey: decision.fromOwnerEntityLogicalKey,
    ownershipVersion: decision.ownershipVersion.toString(),
    toOwnerEntityLogicalKey: decision.toOwnerEntityLogicalKey,
    transferKind: 'grant',
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: asset.id,
        aggregateType: 'asset',
        eventId,
        eventType: 'AssetOwnershipTransferredV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [],
  };
}

async function createAssetOffer(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  assertMutationHeadAvailable(head);
  const payload = input.request.payload as CreateAssetTransferOfferPayloadV1;
  const currency = await lockCurrency(executor, input.command.worldId, payload.currencyId);
  const identity = await executor.query<{ id: string }>(
    `select id::text from assets where world_id = $1 and stable_key = $2`,
    [input.command.worldId, payload.assetKey],
  );
  const assetId = identity.rows[0]?.id;
  if (!assetId) {
    throw new EconomyDomainError('ASSET_NOT_OWNED', 'The asset is unavailable.');
  }
  const existing = await executor.query<{ id: string }>(
    `select id::text from asset_transfer_offers
      where world_id = $1 and asset_id = $2 and status = 'open'
      for update`,
    [input.command.worldId, assetId],
  );
  if (existing.rows[0]) {
    throw new EconomyDomainError('OFFER_NOT_OPEN', 'The asset already has an open offer.');
  }
  const asset = await lockAsset(
    executor,
    input.command.worldId,
    payload.assetKey,
    input.command.actorId,
  );
  const wallets = await lockWallets(
    executor,
    input.command.worldId,
    [payload.sellerWalletId],
    input.command.actorId,
  );
  const sellerWallet = wallets.get(payload.sellerWalletId)!;
  if (
    !sellerWallet.controlled_by_actor ||
    sellerWallet.owner_entity_id !== asset.owner_entity_id ||
    sellerWallet.currency_id !== currency.id ||
    sellerWallet.status !== 'active'
  ) {
    throw new EconomyDomainError(
      'WALLET_NOT_CONTROLLED',
      'The seller wallet must be active, controlled, and owned by the asset seller.',
    );
  }
  const buyer =
    payload.buyerEntityKey === null
      ? null
      : await entityByLogicalKey(executor, input.command.worldId, payload.buyerEntityKey);
  if (buyer?.id === asset.owner_entity_id) {
    throw new EconomyDomainError('BUYER_MISMATCH', 'The seller cannot be the offer buyer.');
  }
  const priceMinor = parseCanonicalAmount(payload.price, currency.minor_unit_scale);
  decideCreateAssetTransferOffer({
    asset: assetDecision(asset),
    currentTick: BigInt(context.clock.current_tick),
    expectedOwnershipVersion: BigInt(payload.expectedOwnershipVersion),
    expiresAtTick: BigInt(payload.expiresAtTick),
    priceMinor,
  });
  const offerId = ids.next();
  const eventId = ids.next();
  await executor.query(
    `insert into asset_transfer_offers(
       id, world_id, asset_id, seller_entity_id, buyer_entity_id,
       currency_id, seller_wallet_id, price_minor, expires_at_tick, created_at_tick,
       status, created_command_id, created_event_id, row_version,
       created_state_revision, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9::bigint,$10::bigint,
               'open',$11,$12,1,$13::bigint,$14,$14)`,
    [
      offerId,
      input.command.worldId,
      asset.id,
      asset.owner_entity_id,
      buyer?.id ?? null,
      currency.id,
      sellerWallet.id,
      priceMinor.toString(),
      payload.expiresAtTick,
      context.clock.current_tick,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const economyChecksum = await updateEconomyHead(executor, input, head, resultingStateRevision);
  const eventPayload: AssetTransferOfferCreatedPayloadV1 = {
    assetId: asset.id,
    buyerEntityLogicalKey: buyer?.logical_key ?? null,
    currencyId: currency.id,
    expiresAtTick: payload.expiresAtTick,
    offerId,
    priceMinor: priceMinor.toString(),
    sellerEntityLogicalKey: asset.owner_logical_key,
    sellerWalletId: sellerWallet.id,
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: offerId,
        aggregateType: 'asset_transfer_offer',
        eventId,
        eventType: 'AssetTransferOfferCreatedV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [
      participantPlan(
        eventId,
        'offer',
        'ASSET_TRANSFER_OFFER_CREATED',
        { expiresAtTick: payload.expiresAtTick, offerId },
        asset.owner_entity_id,
        buyer?.id ?? null,
      ),
    ],
  };
}

async function cancelAssetOffer(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  assertMutationHeadAvailable(head);
  const payload = input.request.payload as CancelAssetTransferOfferPayloadV1;
  const identity = await executor.query<{ currency_id: string }>(
    `select currency_id::text from asset_transfer_offers where world_id = $1 and id = $2`,
    [input.command.worldId, payload.offerId],
  );
  const currencyId = identity.rows[0]?.currency_id;
  if (!currencyId) {
    throw new EconomyDomainError('OFFER_NOT_OPEN', 'The offer is unavailable.');
  }
  await lockCurrency(executor, input.command.worldId, currencyId);
  const offer = await lockOffer(executor, input.command.worldId, payload.offerId);
  const controlsSeller = await actorControlsEntity(
    executor,
    input.command.worldId,
    input.command.actorId,
    offer.seller_entity_id,
  );
  decideCancelAssetTransferOffer({
    actorControlsSeller: controlsSeller,
    expectedOfferVersion: BigInt(payload.expectedOfferVersion),
    offer: offerDecision(offer),
  });
  const eventId = ids.next();
  const terminal = await executor.query<{ row_version: string }>(
    `update asset_transfer_offers
        set status = 'cancelled', row_version = row_version + 1,
            terminal_command_id = $3, terminal_event_id = $4,
            terminal_state_revision = $5::bigint,
            accepted_financial_transaction_id = null,
            accepted_asset_transfer_id = null,
            updated_at = greatest(updated_at,$6)
      where world_id = $1 and id = $2 and status = 'open'
        and row_version = $7::bigint
      returning row_version::text`,
    [
      input.command.worldId,
      offer.id,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
      payload.expectedOfferVersion,
    ],
  );
  const offerVersion = terminal.rows[0]?.row_version;
  if (!offerVersion) stale('The offer changed.');
  const economyChecksum = await updateEconomyHead(executor, input, head, resultingStateRevision);
  const eventPayload: AssetTransferOfferCancelledPayloadV1 = {
    offerId: offer.id,
    offerVersion,
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: offer.id,
        aggregateType: 'asset_transfer_offer',
        eventId,
        eventType: 'AssetTransferOfferCancelledV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [
      participantPlan(
        eventId,
        'offer',
        'ASSET_TRANSFER_OFFER_CANCELLED',
        { offerId: offer.id, offerVersion },
        offer.seller_entity_id,
        offer.buyer_entity_id,
      ),
    ],
  };
}

async function acceptAssetOffer(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  assertMutationHeadAvailable(head);
  const payload = input.request.payload as AcceptAssetTransferOfferPayloadV1;
  const identity = await executor.query<{ asset_key: string; currency_id: string }>(
    `select asset.stable_key::text as asset_key, offer.currency_id::text
       from asset_transfer_offers offer
       join assets asset on asset.world_id = offer.world_id and asset.id = offer.asset_id
      where offer.world_id = $1 and offer.id = $2`,
    [input.command.worldId, payload.offerId],
  );
  const offerIdentity = identity.rows[0];
  if (!offerIdentity) {
    throw new EconomyDomainError('OFFER_NOT_OPEN', 'The offer is unavailable.');
  }
  const currency = await lockCurrency(executor, input.command.worldId, offerIdentity.currency_id);
  const offer = await lockOffer(executor, input.command.worldId, payload.offerId);
  if (payload.sellerWalletId !== offer.seller_wallet_id) {
    throw new EconomyDomainError(
      'WALLET_NOT_CONTROLLED',
      'The seller wallet does not match the offer.',
    );
  }
  const asset = await lockAsset(
    executor,
    input.command.worldId,
    offerIdentity.asset_key,
    input.command.actorId,
  );
  const wallets = await lockWallets(
    executor,
    input.command.worldId,
    [payload.buyerWalletId, payload.sellerWalletId],
    input.command.actorId,
  );
  const buyerWallet = wallets.get(payload.buyerWalletId)!;
  const sellerWallet = wallets.get(payload.sellerWalletId)!;
  if (!buyerWallet.controlled_by_actor) {
    throw new EconomyDomainError(
      'WALLET_NOT_CONTROLLED',
      'The buyer wallet must be controlled by the accepting actor.',
    );
  }
  if (
    buyerWallet.owner_entity_id === offer.seller_entity_id ||
    sellerWallet.owner_entity_id !== offer.seller_entity_id ||
    buyerWallet.currency_id !== currency.id ||
    sellerWallet.currency_id !== currency.id
  ) {
    throw new EconomyDomainError(
      'BUYER_MISMATCH',
      'The buyer and seller wallets do not match the offer parties and currency.',
    );
  }

  const paymentDecision = decideCurrencyTransfer({
    amountMinor: BigInt(offer.price_minor),
    currency: currencyDecision(currency),
    destination: walletDecision(sellerWallet, false),
    expectedDestinationVersion: BigInt(payload.expectedSellerWalletVersion),
    expectedSourceVersion: BigInt(payload.expectedBuyerWalletVersion),
    source: walletDecision(buyerWallet, true),
  });
  const offerDecisionResult = decideAcceptAssetTransferOffer({
    asset: assetDecision(asset),
    buyerEntityLogicalKey: buyerWallet.owner_logical_key,
    buyerWalletId: buyerWallet.id,
    currentTick: BigInt(context.clock.current_tick),
    expectedOfferVersion: BigInt(payload.expectedOfferVersion),
    expectedOwnershipVersion: BigInt(payload.expectedOwnershipVersion),
    offer: offerDecision(offer),
  });
  if (
    offerDecisionResult.payment.postings.length !== paymentDecision.transaction.postings.length ||
    offerDecisionResult.payment.postings.some((posting, index) => {
      const compared = paymentDecision.transaction.postings[index];
      return (
        !compared ||
        posting.walletId !== compared.walletId ||
        posting.signedAmountMinor !== compared.signedAmountMinor
      );
    })
  ) {
    throw new EconomyCommandExecutionError(
      'VALIDATION_FAILED',
      'The ownership and payment decisions are inconsistent.',
    );
  }

  const currencyEventId = ids.next();
  const ownershipEventId = ids.next();
  const offerEventId = ids.next();
  const purchaseEventId = ids.next();
  const transactionId = ids.next();
  const transferId = ids.next();
  await updateBalance(
    executor,
    input,
    buyerWallet,
    paymentDecision.sourceBalanceMinor,
    resultingStateRevision,
  );
  await updateBalance(
    executor,
    input,
    sellerWallet,
    paymentDecision.destinationBalanceMinor,
    resultingStateRevision,
  );
  await insertFinancialTransaction(
    executor,
    {
      command: input.command,
      createdAt: input.decidedAt,
      currencyId: currency.id,
      eventId: currencyEventId,
      id: transactionId,
      kind: 'asset_purchase',
      memoCode: 'asset_purchase',
      memoText: null,
      occurredTick: context.clock.current_tick,
      postings: paymentDecision.transaction.postings,
      resultingStateRevision,
      supplyDeltaMinor: paymentDecision.transaction.supplyDeltaMinor,
    },
    ids,
  );
  const ownership = await executor.query<{ ownership_version: string }>(
    `update asset_ownership
        set owner_entity_id = $3, ownership_version = ownership_version + 1,
            acquired_event_id = $4, updated_state_revision = $5::bigint,
            updated_at = greatest(updated_at,$6)
      where world_id = $1 and asset_id = $2 and ownership_version = $7::bigint
      returning ownership_version::text`,
    [
      input.command.worldId,
      asset.id,
      buyerWallet.owner_entity_id,
      ownershipEventId,
      resultingStateRevision,
      input.decidedAt,
      payload.expectedOwnershipVersion,
    ],
  );
  const ownershipVersion = ownership.rows[0]?.ownership_version;
  if (!ownershipVersion) stale('The asset owner changed.');
  await executor.query(
    `insert into asset_transfers(
       id, world_id, asset_id, from_owner_entity_id, to_owner_entity_id,
       transfer_kind, financial_transaction_id, command_id, event_id,
       occurred_tick, state_revision, created_at
     ) values ($1,$2,$3,$4,$5,'purchase',$6,$7,$8,$9::bigint,$10::bigint,$11)`,
    [
      transferId,
      input.command.worldId,
      asset.id,
      offer.seller_entity_id,
      buyerWallet.owner_entity_id,
      transactionId,
      input.command.commandId,
      ownershipEventId,
      context.clock.current_tick,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const terminal = await executor.query<{ row_version: string }>(
    `update asset_transfer_offers
        set status = 'accepted', row_version = row_version + 1,
            terminal_command_id = $3, terminal_event_id = $4,
            terminal_state_revision = $5::bigint,
            accepted_financial_transaction_id = $6,
            accepted_asset_transfer_id = $7,
            updated_at = greatest(updated_at,$8)
      where world_id = $1 and id = $2 and status = 'open'
        and row_version = $9::bigint
      returning row_version::text`,
    [
      input.command.worldId,
      offer.id,
      input.command.commandId,
      offerEventId,
      resultingStateRevision,
      transactionId,
      transferId,
      input.decidedAt,
      payload.expectedOfferVersion,
    ],
  );
  const offerVersion = terminal.rows[0]?.row_version;
  if (!offerVersion) stale('The offer changed.');
  const economyChecksum = await updateEconomyHead(executor, input, head, resultingStateRevision);

  const currencyPayload: CurrencyTransferredPayloadV1 = {
    amountMinor: offer.price_minor,
    currencyId: currency.id,
    destinationWalletId: sellerWallet.id,
    sourceWalletId: buyerWallet.id,
    transactionId,
  };
  const ownershipPayload: AssetOwnershipTransferredPayloadV1 = {
    assetId: asset.id,
    assetKey: asset.stable_key,
    financialTransactionId: transactionId,
    fromOwnerEntityLogicalKey: offerDecisionResult.ownership.fromOwnerEntityLogicalKey,
    ownershipVersion,
    toOwnerEntityLogicalKey: offerDecisionResult.ownership.toOwnerEntityLogicalKey,
    transferKind: 'purchase',
  };
  const acceptedPayload: AssetTransferOfferAcceptedPayloadV1 = {
    buyerEntityLogicalKey: buyerWallet.owner_logical_key,
    offerId: offer.id,
    offerVersion,
    sellerEntityLogicalKey: offer.seller_logical_key,
  };
  const purchasePayload: AssetPurchasedPayloadV1 = {
    assetId: asset.id,
    buyerEntityLogicalKey: buyerWallet.owner_logical_key,
    financialTransactionId: transactionId,
    offerId: offer.id,
    priceMinor: offer.price_minor,
    sellerEntityLogicalKey: offer.seller_logical_key,
  };
  const parties = [offer.seller_entity_id, buyerWallet.owner_entity_id] as const;
  return {
    economyChecksum,
    events: [
      {
        aggregateId: currency.id,
        aggregateType: 'currency',
        eventId: currencyEventId,
        eventType: 'CurrencyTransferredV1',
        payload: jsonPayload(currencyPayload),
      },
      {
        aggregateId: asset.id,
        aggregateType: 'asset',
        eventId: ownershipEventId,
        eventType: 'AssetOwnershipTransferredV1',
        payload: jsonPayload(ownershipPayload),
      },
      {
        aggregateId: offer.id,
        aggregateType: 'asset_transfer_offer',
        eventId: offerEventId,
        eventType: 'AssetTransferOfferAcceptedV1',
        payload: jsonPayload(acceptedPayload),
      },
      {
        aggregateId: offer.id,
        aggregateType: 'asset_purchase',
        eventId: purchaseEventId,
        eventType: 'AssetPurchasedV1',
        payload: jsonPayload(purchasePayload),
      },
    ],
    overrideId: null,
    participants: [
      participantPlan(
        currencyEventId,
        'currency',
        'CURRENCY_TRANSFERRED',
        { transactionId },
        ...parties,
      ),
      participantPlan(
        ownershipEventId,
        'asset',
        'ASSET_OWNERSHIP_TRANSFERRED',
        { assetId: asset.id },
        ...parties,
      ),
      participantPlan(
        offerEventId,
        'offer',
        'ASSET_TRANSFER_OFFER_ACCEPTED',
        { offerId: offer.id, offerVersion },
        ...parties,
      ),
      participantPlan(
        purchaseEventId,
        'asset',
        'ASSET_PURCHASED',
        { assetId: asset.id, offerId: offer.id },
        ...parties,
      ),
    ],
  };
}

async function reconcileWorldEconomy(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const context = await lockEconomyContext(executor, input, 'must_exist');
  const head = requiredHead(context);
  const payload = input.request.payload as ReconcileWorldEconomyPayloadV1;
  if (payload.expectedEconomyHeadVersion !== head.row_version) {
    stale('The economy head changed before reconciliation.');
  }
  const opened = await executor.query<{
    opened_event_sequence: string;
    opened_state_revision: string;
  }>(
    `select opened_event_sequence::text, opened_state_revision::text
       from command_records where id = $1 and world_id = $2 for update`,
    [input.command.commandId, input.command.worldId],
  );
  const commandSnapshot = opened.rows[0];
  if (!commandSnapshot || commandSnapshot.opened_state_revision !== input.world.stateRevision) {
    throw new EconomyCommandExecutionError(
      'REVISION_CONFLICT',
      'The command write-gate snapshot changed.',
    );
  }
  const snapshotResult = await executor.query<{ snapshot: ReconciliationSnapshot }>(
    `select worldgraph_economy_reconciliation_snapshot($1) as snapshot`,
    [input.command.worldId],
  );
  const snapshot = snapshotResult.rows[0]?.snapshot;
  if (!snapshot) {
    throw new EconomyCommandExecutionError(
      'VALIDATION_FAILED',
      'The economy reconciliation snapshot is unavailable.',
    );
  }
  const runId = ids.next();
  const eventId = ids.next();
  const status = snapshot.matched ? 'matched' : 'mismatch';
  await executor.query(
    `insert into economy_reconciliation_runs(
       id, world_id, reconciliation_schema_version,
       source_state_revision, source_event_sequence, status,
       live_wallet_checksum, rebuilt_wallet_checksum,
       live_supply_checksum, rebuilt_supply_checksum,
       live_ownership_checksum, rebuilt_ownership_checksum,
       live_projection_checksum, rebuilt_journal_checksum,
       wallet_count, currency_count, asset_count, mismatch_count,
       command_id, event_id, created_at
     ) values (
       $1,$2,1,$3::bigint,$4::bigint,$5,
       $6,$7,$8,$9,$10,$11,$12,$13,
       $14,$15,$16,$17,$18,$19,$20
     )`,
    [
      runId,
      input.command.worldId,
      commandSnapshot.opened_state_revision,
      commandSnapshot.opened_event_sequence,
      status,
      Buffer.from(snapshot.liveWalletChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltWalletChecksum, 'hex'),
      Buffer.from(snapshot.liveSupplyChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltSupplyChecksum, 'hex'),
      Buffer.from(snapshot.liveOwnershipChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltOwnershipChecksum, 'hex'),
      Buffer.from(snapshot.liveProjectionChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltJournalChecksum, 'hex'),
      snapshot.walletCount,
      snapshot.currencyCount,
      snapshot.assetCount,
      snapshot.mismatchCount,
      input.command.commandId,
      eventId,
      input.decidedAt,
    ],
  );
  const comparisons = [
    {
      actual: snapshot.liveWalletChecksum,
      code: 'WALLET_BALANCE_CHECKSUM_MISMATCH',
      expected: snapshot.rebuiltWalletChecksum,
      key: 'wallets',
      kind: 'wallet_balance',
    },
    {
      actual: snapshot.liveSupplyChecksum,
      code: 'CURRENCY_SUPPLY_CHECKSUM_MISMATCH',
      expected: snapshot.rebuiltSupplyChecksum,
      key: 'currencies',
      kind: 'currency_supply',
    },
    {
      actual: snapshot.liveOwnershipChecksum,
      code: 'ASSET_OWNERSHIP_CHECKSUM_MISMATCH',
      expected: snapshot.rebuiltOwnershipChecksum,
      key: 'assets',
      kind: 'asset_ownership',
    },
  ] as const;
  let ordinal = 0;
  for (const mismatch of comparisons) {
    if (mismatch.actual === mismatch.expected) continue;
    await executor.query(
      `insert into economy_reconciliation_items(
         run_id, item_ordinal, item_kind, item_key, item_key_hash,
         expected_value, actual_value, mismatch_code
       ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        runId,
        ordinal,
        mismatch.kind,
        mismatch.key,
        createHash('sha256').update(mismatch.key, 'utf8').digest(),
        mismatch.expected,
        mismatch.actual,
        mismatch.code,
      ],
    );
    ordinal += 1;
  }
  if (ordinal !== snapshot.mismatchCount) {
    throw new EconomyCommandExecutionError(
      'VALIDATION_FAILED',
      'The reconciliation mismatch evidence is internally inconsistent.',
    );
  }
  const checksumResult = await executor.query<{ checksum: Buffer }>(
    `select worldgraph_economy_projection_checksum($1) as checksum`,
    [input.command.worldId],
  );
  const economyChecksum = requiredChecksum(checksumResult.rows[0]?.checksum);
  const updated = await executor.query(
    `update world_economy_heads
        set checksum = $3, row_version = row_version + 1,
            updated_state_revision = $4::bigint,
            reconciliation_status = $5,
            last_reconciled_state_revision = $6::bigint,
            last_reconciliation_run_id = $7,
            updated_at = greatest(updated_at,$8)
      where world_id = $1 and row_version = $2::bigint`,
    [
      input.command.worldId,
      head.row_version,
      economyChecksum,
      resultingStateRevision,
      snapshot.matched ? 'current' : 'mismatch',
      commandSnapshot.opened_state_revision,
      runId,
      input.decidedAt,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) stale('The economy head changed.');
  const eventPayload: WorldEconomyReconciledPayloadV1 = {
    checkedStateRevision: commandSnapshot.opened_state_revision,
    liveProjectionChecksum: snapshot.liveProjectionChecksum,
    mismatchCount: String(snapshot.mismatchCount),
    rebuiltJournalChecksum: snapshot.rebuiltJournalChecksum,
    runId,
    status: snapshot.matched ? 'matched' : 'mismatched',
  };
  return {
    economyChecksum,
    events: [
      {
        aggregateId: input.command.worldId,
        aggregateType: 'world_economy',
        eventId,
        eventType: 'WorldEconomyReconciledV1',
        payload: jsonPayload(eventPayload),
      },
    ],
    overrideId: null,
    participants: [],
  };
}

function requiredEntity(entities: ReadonlyMap<string, string>, logicalKey: string): string {
  const entityId = entities.get(logicalKey);
  if (!entityId) {
    throw new EconomyDomainError(
      'SEED_PLAN_INCOMPATIBLE',
      `The seed plan entity ${logicalKey} is unavailable.`,
    );
  }
  return entityId;
}

function requiredChecksum(value: Buffer | null | undefined): Buffer {
  if (!value || value.length !== 32) {
    throw new EconomyCommandExecutionError(
      'VALIDATION_FAILED',
      'The economy projection checksum is unavailable.',
    );
  }
  return value;
}

function jsonPayload(value: object): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function requiredHead(
  context: LockedEconomyContext | { clock: ClockRow; head: null },
): EconomyHeadRow {
  if (!context.head) {
    throw new EconomyCommandExecutionError(
      'ECONOMY_NOT_INITIALIZED',
      'The world economy has not been initialized.',
    );
  }
  return context.head;
}

function assertMutationHeadAvailable(head: EconomyHeadRow): void {
  if (head.reconciliation_status === 'mismatch' || head.reconciliation_status === 'failed') {
    throw new EconomyCommandExecutionError(
      'COMMAND_TYPE_DISABLED',
      'Economy writes are frozen until reconciliation evidence is resolved.',
    );
  }
}

async function updateBalance(
  executor: EconomySqlExecutor,
  input: EconomyCommandExecutionInput,
  wallet: WalletRow,
  availableMinor: bigint,
  resultingStateRevision: string,
): Promise<void> {
  const result = await executor.query(
    `update wallet_balances
        set available_minor = $3::bigint, row_version = row_version + 1,
            updated_state_revision = $4::bigint,
            updated_at = greatest(updated_at,$5)
      where world_id = $1 and wallet_id = $2 and row_version = $6::bigint`,
    [
      input.command.worldId,
      wallet.id,
      availableMinor.toString(),
      resultingStateRevision,
      input.decidedAt,
      wallet.balance_row_version,
    ],
  );
  if ((result.rowCount ?? 0) !== 1) stale('The wallet balance changed.');
}

async function insertFinancialTransaction(
  executor: EconomySqlExecutor,
  input: {
    command: ReceivedCommandWrite;
    createdAt: Date;
    currencyId: string;
    eventId: string;
    id: string;
    kind: 'asset_purchase' | 'issuance' | 'transfer';
    memoCode: string;
    memoText: string | null;
    occurredTick: string;
    postings: readonly EconomyPosting[];
    resultingStateRevision: string;
    supplyDeltaMinor: bigint;
  },
  ids: IdGenerator,
): Promise<void> {
  if (input.postings.length < 1 || input.postings.length > 101) {
    throw new EconomyDomainError(
      'ACCOUNTING_UNBALANCED',
      'The financial transaction posting set is outside the supported bounds.',
    );
  }
  await executor.query(
    `insert into financial_transactions(
       id, world_id, currency_id, transaction_kind, supply_delta_minor,
       command_id, event_id, memo_code, memo_text,
       occurred_tick, state_revision, created_at
     ) values ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10::bigint,$11::bigint,$12)`,
    [
      input.id,
      input.command.worldId,
      input.currencyId,
      input.kind,
      input.supplyDeltaMinor.toString(),
      input.command.commandId,
      input.eventId,
      input.memoCode,
      input.memoText,
      input.occurredTick,
      input.resultingStateRevision,
      input.createdAt,
    ],
  );
  for (const [ordinal, posting] of input.postings.entries()) {
    await executor.query(
      `insert into wallet_postings(
         id, transaction_id, world_id, currency_id, wallet_id,
         posting_ordinal, signed_amount_minor, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7::bigint,$8)`,
      [
        ids.next(),
        input.id,
        input.command.worldId,
        input.currencyId,
        posting.walletId,
        ordinal,
        posting.signedAmountMinor.toString(),
        input.createdAt,
      ],
    );
  }
}

async function updateEconomyHead(
  executor: EconomySqlExecutor,
  input: EconomyCommandExecutionInput,
  head: EconomyHeadRow,
  resultingStateRevision: string,
): Promise<Buffer> {
  const checksumResult = await executor.query<{ checksum: Buffer }>(
    `select worldgraph_economy_projection_checksum($1) as checksum`,
    [input.command.worldId],
  );
  const checksum = requiredChecksum(checksumResult.rows[0]?.checksum);
  const result = await executor.query(
    `update world_economy_heads
        set checksum = $3, row_version = row_version + 1,
            updated_state_revision = $4::bigint,
            reconciliation_status = 'pending',
            last_reconciled_state_revision = null,
            last_reconciliation_run_id = null,
            updated_at = greatest(updated_at,$5)
      where world_id = $1 and row_version = $2::bigint`,
    [input.command.worldId, head.row_version, checksum, resultingStateRevision, input.decidedAt],
  );
  if ((result.rowCount ?? 0) !== 1) stale('The economy head changed.');
  return checksum;
}

async function insertIssuanceOverride(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyCommandExecutionInput,
  currencyId: string,
  reason: string,
): Promise<string> {
  if (
    input.command.actorType !== 'user' ||
    input.authorizationRuleId !== 'economy.creator_explicit_issuance_override'
  ) {
    throw new EconomyCommandExecutionError(
      'VALIDATION_FAILED',
      'Currency issuance requires an explicit creator override.',
    );
  }
  const payload = input.request.payload as IssueCurrencyPayloadV1;
  if (payload.confirmation !== 'ISSUE VIRTUAL CURRENCY') {
    throw new EconomyCommandExecutionError(
      'VALIDATION_FAILED',
      'Currency issuance requires the exact confirmation phrase.',
    );
  }
  const auditId = ids.next();
  const overrideId = ids.next();
  await executor.query(
    `insert into security_audit_records(
       id, actor_user_id, world_id, category, action, outcome, reason_code,
       target_type, target_id, request_id, correlation_id, redacted_metadata,
       occurred_at
     ) values ($1,$2,$3,'creator_override','economy.currency.issue','allowed',
               'CREATOR_EXPLICIT_ISSUANCE','currency',$4,$5,$6,$7,$8)`,
    [
      auditId,
      input.command.actorId,
      input.command.worldId,
      currencyId,
      input.command.commandId,
      input.command.correlationId,
      JSON.stringify({
        authorityRuleId: input.authorizationRuleId,
        commandType: input.command.commandType,
      }),
      input.decidedAt,
    ],
  );
  await executor.query(
    `insert into creator_override_records(
       id, world_id, actor_user_id, action, target_type, target_id,
       reason, authority_rule_id, command_id, audit_record_id, created_at
     ) values ($1,$2,$3,'economy.currency.issue','currency',$4,$5,$6,$7,$8,$9)`,
    [
      overrideId,
      input.command.worldId,
      input.command.actorId,
      currencyId,
      reason,
      input.authorizationRuleId,
      input.command.commandId,
      auditId,
      input.decidedAt,
    ],
  );
  return overrideId;
}

function participantPlan(
  eventId: string,
  category: ParticipantPlan['category'],
  summaryCode: string,
  summaryArgs: Record<string, JsonValue>,
  firstEntityId: string,
  secondEntityId: string | null,
): ParticipantPlan {
  return {
    category,
    entities: [
      { counterpartyEntityId: secondEntityId, entityId: firstEntityId },
      ...(secondEntityId === null
        ? []
        : [{ counterpartyEntityId: firstEntityId, entityId: secondEntityId }]),
    ],
    eventId,
    summaryArgs,
    summaryCode,
  };
}

async function actorControlsEntity(
  executor: EconomySqlExecutor,
  worldId: string,
  actorId: string,
  entityId: string,
): Promise<boolean> {
  const result = await executor.query<{ controlled: boolean }>(
    `select worldgraph_user_controls_economy_entity_v1($1,$3,$2) as controlled`,
    [worldId, entityId, actorId],
  );
  return result.rows[0]?.controlled === true;
}

function stale(message: string): never {
  throw new EconomyDomainError('STALE_VERSION', message);
}

export async function finalizeEconomyCommand(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: EconomyFinalizationInput,
  prepared: PreparedEconomyCommand,
  resultingStateRevision: string,
): Promise<WorldCommandResultTransport> {
  if (prepared.events.length < 1 || prepared.events.length > 16) {
    throw new EconomyCommandExecutionError(
      'VALIDATION_FAILED',
      'An economy command must emit between one and sixteen typed facts.',
    );
  }
  const allocationResult = await executor.query<AllocationRow>(
    `select next_event_sequence::text, next_ledger_sequence::text, last_entry_hash
       from world_ledger_heads where world_id = $1`,
    [input.command.worldId],
  );
  const allocation = allocationResult.rows[0];
  if (!allocation) {
    throw new EconomyCommandExecutionError('VALIDATION_FAILED', 'The world ledger is unavailable.');
  }
  const recordedAt = input.decidedAt.toISOString();
  const actor: LedgerActorV1 = {
    actorId: input.command.actorId,
    actorType: input.command.actorType,
  };
  const metadata: DomainEventMetadataV1 = {
    actor,
    authorizationRuleId: input.authorizationRuleId,
    causationId: input.command.causationId,
    commandSchemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    commandType: input.command.commandType,
    correlationId: input.command.correlationId,
    overrideId: prepared.overrideId,
    payloadClassification: input.command.payloadClassification,
  };
  const persistedEvents: PersistedEvent[] = [];
  for (const [eventOrdinal, planned] of prepared.events.entries()) {
    const aggregate = await executor.query<{ aggregate_version: string }>(
      `select coalesce((
         select current_version + 1 from aggregate_stream_heads
          where world_id = $1 and aggregate_type = $2 and aggregate_id = $3
       ),1)::text as aggregate_version`,
      [input.command.worldId, planned.aggregateType, planned.aggregateId],
    );
    const aggregateVersion = aggregate.rows[0]?.aggregate_version;
    if (!aggregateVersion) {
      throw new EconomyCommandExecutionError(
        'VALIDATION_FAILED',
        'The aggregate stream version is unavailable.',
      );
    }
    const envelope: DomainEventHashInputV1 = {
      aggregateId: planned.aggregateId,
      aggregateType: planned.aggregateType,
      aggregateVersion,
      commandId: input.command.commandId,
      eventId: planned.eventId,
      eventOrdinal,
      eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
      eventType: planned.eventType,
      metadata,
      occurredAt: recordedAt,
      payload: planned.payload as DomainEventHashInputV1['payload'],
      recordedAt,
      resultingStateRevision,
      worldEventSequence: incrementDecimalBy(allocation.next_event_sequence, eventOrdinal),
      worldId: input.command.worldId,
    };
    const eventHash = computeDomainEventHashV1(envelope);
    await executor.query(
      `insert into domain_events(
         id, world_id, world_event_sequence, command_id, event_ordinal,
         aggregate_type, aggregate_id, aggregate_version, event_type,
         event_schema_version, payload, metadata, event_hash, occurred_at,
         recorded_at, resulting_state_revision
       ) values (
         $1,$2,$3::bigint,$4,$5,$6,$7,$8::bigint,$9,$10,$11,$12,$13,$14,$14,$15::bigint
       )`,
      [
        envelope.eventId,
        envelope.worldId,
        envelope.worldEventSequence,
        envelope.commandId,
        envelope.eventOrdinal,
        envelope.aggregateType,
        envelope.aggregateId,
        envelope.aggregateVersion,
        envelope.eventType,
        envelope.eventSchemaVersion,
        JSON.stringify(envelope.payload),
        JSON.stringify(envelope.metadata),
        Buffer.from(eventHash, 'hex'),
        input.decidedAt,
        envelope.resultingStateRevision,
      ],
    );
    persistedEvents.push({
      envelope: { ...envelope, eventHash },
      ledgerSequence: incrementDecimalBy(allocation.next_ledger_sequence, eventOrdinal + 1),
    });
  }

  const acceptedEntry = economyLedgerEntry(ids, {
    actor,
    commandId: input.command.commandId,
    entryKind: 'command_accepted',
    eventId: null,
    ledgerSequence: allocation.next_ledger_sequence,
    previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
    publicSummaryCode: 'COMMAND_ACCEPTED',
    recordedAt,
    redactedDetails: {
      authorizationRuleId: input.authorizationRuleId,
      commandType: input.command.commandType,
    },
    worldId: input.command.worldId,
  });
  await insertEconomyLedgerEntry(executor, acceptedEntry);
  let previousHash = acceptedEntry.entryHash;
  for (const persisted of persistedEvents) {
    const eventEntry = economyLedgerEntry(ids, {
      actor,
      commandId: input.command.commandId,
      entryKind: 'domain_event',
      eventId: persisted.envelope.eventId,
      ledgerSequence: persisted.ledgerSequence,
      previousHash,
      publicSummaryCode: economySummaryCode(persisted.envelope.eventType),
      recordedAt,
      redactedDetails: {
        aggregateType: persisted.envelope.aggregateType,
        eventType: persisted.envelope.eventType,
        targetHash: createHash('sha256')
          .update(persisted.envelope.aggregateId, 'utf8')
          .digest('hex'),
      },
      worldId: input.command.worldId,
    });
    await insertEconomyLedgerEntry(executor, eventEntry);
    previousHash = eventEntry.entryHash;
    const history = projectWorldHistoryEntryV1(
      persisted.envelope as DomainEventEnvelopeV1,
      eventEntry,
    );
    await insertEconomyHistory(executor, history);
    const participant = prepared.participants.find(
      (candidate) => candidate.eventId === persisted.envelope.eventId,
    );
    if (participant) {
      await insertParticipantHistory(
        executor,
        input,
        participant,
        persisted.ledgerSequence,
        resultingStateRevision,
      );
    }
    await executor.query(
      `insert into outbox_messages(
         id, world_id, event_id, message_type, message_schema_version,
         payload, status, attempts, available_at, created_at
       ) values ($1,$2,$3,'DomainEventReferenceV1',$4,$5,'pending',0,$6,$6)`,
      [
        ids.next(),
        input.command.worldId,
        persisted.envelope.eventId,
        OUTBOX_SCHEMA_VERSION,
        JSON.stringify({
          eventId: persisted.envelope.eventId,
          eventType: persisted.envelope.eventType,
          worldEventSequence: persisted.envelope.worldEventSequence,
          worldId: input.command.worldId,
        }),
        input.decidedAt,
      ],
    );
  }

  const lastEventSequence = persistedEvents.at(-1)!.envelope.worldEventSequence;
  const lastLedgerSequence = persistedEvents.at(-1)!.ledgerSequence;
  const graphChecksumResult = await executor.query<{ checksum: Buffer }>(
    `select worldgraph_projection_checksum($1,$2::bigint) as checksum`,
    [input.command.worldId, resultingStateRevision],
  );
  const simulationChecksumResult = await executor.query<{ checksum: Buffer }>(
    `select worldgraph_simulation_projection_checksum($1) as checksum`,
    [input.command.worldId],
  );
  const graphChecksum = requiredChecksum(graphChecksumResult.rows[0]?.checksum);
  const simulationChecksum = requiredChecksum(simulationChecksumResult.rows[0]?.checksum);
  await upsertCheckpoint(
    executor,
    input.command.worldId,
    'world_graph',
    PROJECTION_SCHEMA_VERSION,
    lastEventSequence,
    graphChecksum,
    input.decidedAt,
  );
  await upsertCheckpoint(
    executor,
    input.command.worldId,
    'simulation_runtime',
    1,
    lastEventSequence,
    simulationChecksum,
    input.decidedAt,
  );
  if (prepared.economyChecksum) {
    await upsertCheckpoint(
      executor,
      input.command.worldId,
      'economy_runtime',
      ECONOMY_SCHEMA_VERSION,
      lastEventSequence,
      prepared.economyChecksum,
      input.decidedAt,
    );
  }
  if (prepared.commerceChecksum) {
    await upsertCheckpoint(
      executor,
      input.command.worldId,
      'economy_closed_loop',
      1,
      lastEventSequence,
      prepared.commerceChecksum,
      input.decidedAt,
    );
  }
  const runtimeUpdated = await executor.query(
    `update world_runtime_heads
        set state_revision = $2::bigint,
            last_ledger_sequence = $3::bigint,
            last_event_sequence = $4::bigint,
            projection_checksum = $5,
            updated_at = greatest(updated_at,$6)
      where world_id = $1 and state_revision = $7::bigint`,
    [
      input.command.worldId,
      resultingStateRevision,
      lastLedgerSequence,
      lastEventSequence,
      graphChecksum,
      input.decidedAt,
      input.world.stateRevision,
    ],
  );
  if ((runtimeUpdated.rowCount ?? 0) !== 1) {
    throw new EconomyCommandExecutionError(
      'REVISION_CONFLICT',
      'The world runtime head changed before publication.',
    );
  }
  const result: WorldCommandResultTransport = {
    commandId: input.command.commandId,
    eventIds: persistedEvents.map((event) => event.envelope.eventId),
    eventSequenceRange: { from: allocation.next_event_sequence, to: lastEventSequence },
    ledgerSequenceRange: { from: allocation.next_ledger_sequence, to: lastLedgerSequence },
    resultingStateRevision,
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    status: 'accepted',
  };
  const accepted = await executor.query(
    `update command_records
        set status = 'accepted', authorization_rule_id = $2,
            override_id = $3, decided_at = $4,
            resulting_state_revision = $5::bigint, response_summary = $6
      where id = $1 and world_id = $7 and status = 'received'`,
    [
      input.command.commandId,
      input.authorizationRuleId,
      prepared.overrideId,
      input.decidedAt,
      resultingStateRevision,
      JSON.stringify(result),
      input.command.worldId,
    ],
  );
  if ((accepted.rowCount ?? 0) !== 1) stale('The command already became terminal.');
  await executor.query(`select worldgraph_assert_economy_command_terminal($1)`, [
    input.command.commandId,
  ]);
  return result;
}

function economyLedgerEntry(
  ids: IdGenerator,
  input: Omit<LedgerEntryV1, 'entryHash' | 'entryId' | 'ledgerSchemaVersion'>,
): LedgerEntryV1 {
  const withoutHash: LedgerEntryHashInputV1 = {
    ...input,
    entryId: ids.next(),
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
  };
  return {
    ...withoutHash,
    entryHash: computeLedgerEntryHashV1(withoutHash),
  } as LedgerEntryV1;
}

async function insertEconomyLedgerEntry(
  executor: EconomySqlExecutor,
  entry: LedgerEntryV1,
): Promise<void> {
  await executor.query(
    `insert into ledger_entries(
       id, world_id, ledger_sequence, entry_kind, command_id, event_id,
       actor_type, actor_id, public_summary_code, redacted_details,
       previous_hash, entry_hash, recorded_at
     ) values ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      entry.entryId,
      entry.worldId,
      entry.ledgerSequence,
      entry.entryKind,
      entry.commandId,
      entry.eventId,
      entry.actor.actorType,
      entry.actor.actorId,
      entry.publicSummaryCode,
      JSON.stringify(entry.redactedDetails),
      Buffer.from(entry.previousHash, 'hex'),
      Buffer.from(entry.entryHash, 'hex'),
      new Date(entry.recordedAt),
    ],
  );
}

async function insertEconomyHistory(
  executor: EconomySqlExecutor,
  history: WorldHistoryEntryV1,
): Promise<void> {
  await executor.query(
    `insert into world_history_entries(
       world_id, ledger_sequence, command_id, event_id, event_type,
       history_schema_version, occurred_at, category, title_key, summary_args,
       actor_type, actor_id, target_type, target_id, visibility, correlation_id,
       resulting_state_revision
     ) values (
       $1,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::bigint
     )`,
    [
      history.worldId,
      history.ledgerSequence,
      history.commandId,
      history.eventId,
      history.eventType,
      HISTORY_SCHEMA_VERSION,
      new Date(history.occurredAt),
      history.category,
      history.titleKey,
      JSON.stringify(history.summaryArgs),
      history.actor.actorType,
      history.actor.actorId,
      history.targetType,
      history.targetId,
      history.visibility,
      history.correlationId,
      history.resultingStateRevision,
    ],
  );
}

async function insertParticipantHistory(
  executor: EconomySqlExecutor,
  input: EconomyFinalizationInput,
  participant: ParticipantPlan,
  ledgerSequence: string,
  resultingStateRevision: string,
): Promise<void> {
  for (const entity of participant.entities) {
    await executor.query(
      `insert into economy_participant_history(
         world_id, ledger_sequence, user_id, participant_entity_id,
         counterparty_entity_id, command_id, event_id, category,
         summary_code, summary_args, visibility, state_revision, created_at
       )
       select $1,$2::bigint,controller.user_id,$3,$4,$5,$6,$7,$8,$9,
              'participant',$10::bigint,$11
         from world_entity_controllers controller
         join world_memberships membership
           on membership.world_id = controller.world_id
          and membership.user_id = controller.user_id
          and membership.status = 'active'
         join world_entities controlled
           on controlled.world_id = controller.world_id
          and controlled.id = controller.entity_id
          and controlled.retired_world_version_id is null
         join world_entities target
           on target.world_id = controller.world_id
          and target.id = $3
          and target.retired_world_version_id is null
        where controller.world_id = $1 and controller.revoked_at is null
          and (controlled.id = target.id or (
            target.entity_type = 'organization'
            and controlled.entity_type = 'player_character'
            and controlled.state ->> 'organizationLogicalKey' = target.logical_key::text
          ))
       on conflict (world_id, ledger_sequence, user_id) do nothing`,
      [
        input.command.worldId,
        ledgerSequence,
        entity.entityId,
        entity.counterpartyEntityId,
        input.command.commandId,
        participant.eventId,
        participant.category,
        participant.summaryCode,
        JSON.stringify(participant.summaryArgs),
        resultingStateRevision,
        input.decidedAt,
      ],
    );
  }
}

async function upsertCheckpoint(
  executor: EconomySqlExecutor,
  worldId: string,
  projectionName: 'economy_closed_loop' | 'economy_runtime' | 'simulation_runtime' | 'world_graph',
  projectionSchemaVersion: number,
  lastEventSequence: string,
  checksum: Buffer,
  updatedAt: Date,
): Promise<void> {
  await executor.query(
    `insert into projection_checkpoints(
       world_id, projection_name, projection_schema_version,
       last_event_sequence, checksum, status, updated_at
     ) values ($1,$2,$3,$4::bigint,$5,'current',$6)
     on conflict (world_id, projection_name) do update
       set projection_schema_version = excluded.projection_schema_version,
           last_event_sequence = excluded.last_event_sequence,
           checksum = excluded.checksum, status = excluded.status,
           updated_at = greatest(projection_checkpoints.updated_at, excluded.updated_at)`,
    [worldId, projectionName, projectionSchemaVersion, lastEventSequence, checksum, updatedAt],
  );
}

function economySummaryCode(eventType: string): string {
  return eventType
    .replace(/V[1-9][0-9]*$/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toUpperCase();
}

function incrementDecimal(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

function incrementDecimalBy(value: string, amount: number): string {
  return (BigInt(value) + BigInt(amount)).toString(10);
}
