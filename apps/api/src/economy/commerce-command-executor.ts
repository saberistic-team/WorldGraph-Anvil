import { createHash } from 'node:crypto';

import type { QueryResultRow } from 'pg';

import {
  MAX_SCHEDULED_ACTIONS_PER_TICK,
  MAX_SCHEDULED_ACTIONS_PER_WORLD,
  canonicalJson,
  type AcceptEmploymentContractPayloadV1,
  type CancelMarketListingPayloadV1,
  type ConfigureBusinessFacilityPayloadV1,
  type CreateBusinessPayloadV1,
  type CreateEmploymentContractPayloadV1,
  type CreateMarketListingPayloadV1,
  type EndEmploymentContractPayloadV1,
  type IdGenerator,
  type InitializeWorldCommercePayloadV1,
  type JsonValue,
  type PerformJobPayloadV1,
  type PurchaseMarketListingPayloadV1,
  type ReconcileWorldCommercePayloadV1,
  type StartProductionRunPayloadV1,
} from '@worldgraph/contracts';
import {
  EconomyDomainError,
  decideJobPerformance,
  decideMarketPurchase,
  decideProductionReservation,
  formatQuantity,
  parseCanonicalQuantity,
  projectAccountingDecision,
  reserveInventory,
  type EconomyPosting,
  type EmploymentContractState,
  type InventoryState,
  type MarketListingState,
  type ProductionRecipeVersionState,
  type TaxAssessmentDecision,
  type TaxPolicyState,
} from '@worldgraph/economy';
import {
  annotateActiveEconomyCommandSpan,
  telemetry,
  type EconomyCommandTraceCorrelation,
} from '@worldgraph/observability';

import { ApplicationError } from '../application/errors.js';
import {
  ACCEPT_EMPLOYMENT_CONTRACT_COMMAND,
  CANCEL_MARKET_LISTING_COMMAND,
  CONFIGURE_BUSINESS_FACILITY_COMMAND,
  CREATE_BUSINESS_COMMAND,
  CREATE_EMPLOYMENT_CONTRACT_COMMAND,
  CREATE_MARKET_LISTING_COMMAND,
  END_EMPLOYMENT_CONTRACT_COMMAND,
  INITIALIZE_WORLD_COMMERCE_COMMAND,
  PERFORM_JOB_COMMAND,
  PURCHASE_MARKET_LISTING_COMMAND,
  RECONCILE_WORLD_COMMERCE_COMMAND,
  START_PRODUCTION_RUN_COMMAND,
} from '../commands/registry.js';
import type { WorldCommandResultTransport } from '../commands/api-contracts.js';
import type { CommerceCommandExecutionInput } from '../commands/types.js';
import {
  EconomyCommandExecutionError,
  finalizeEconomyCommand,
  type EconomySqlExecutor,
  type ParticipantPlan,
  type PlannedEconomyEvent,
  type PreparedEconomyCommand,
} from './command-executor.js';

interface CommerceHeadRow extends QueryResultRow {
  checksum: Buffer;
  reconciliation_status: 'current' | 'failed' | 'mismatch' | 'pending';
  row_version: string;
  seed_plan_hash: Buffer;
  source_world_version_id: string;
  updated_state_revision: string;
}

interface CommerceClockRow extends QueryResultRow {
  current_tick: string;
}

interface EntityRow extends QueryResultRow {
  controlled_by_actor: boolean;
  display_name: string | null;
  entity_type: string;
  id: string;
  logical_key: string;
}

interface BusinessRow extends QueryResultRow {
  backing_organization_entity_id: string;
  controlled_by_actor: boolean;
  id: string;
  row_version: string;
  status: 'active' | 'closed' | 'suspended';
  wallet_id: string;
  world_id: string;
}

interface WalletRow extends QueryResultRow {
  available_minor: string;
  balance_row_version: string;
  controlled_by_actor: boolean;
  currency_id: string;
  id: string;
  owner_entity_id: string;
  status: 'active' | 'closed' | 'frozen';
  wallet_kind: 'organization' | 'player' | 'treasury';
  wallet_row_version: string;
}

interface FacilityRow extends QueryResultRow {
  backing_organization_entity_id: string;
  business_id: string;
  controlled_by_actor: boolean;
  facility_asset_id: string;
  id: string;
  row_version: string;
  status: 'active' | 'disabled' | 'retired';
}

interface InventoryRow extends QueryResultRow {
  container_asset_id: string | null;
  controlled_by_actor: boolean;
  id: string;
  owner_entity_id: string;
  quantity: string;
  quantity_scale: number;
  reserved_quantity: string;
  resource_type_id: string;
  row_version: string;
  unit_code: string;
}

interface RecipeRow extends QueryResultRow {
  canonical_inputs: Array<{ quantity: string; resourceTypeId: string }>;
  canonical_outputs: Array<{ quantity: string; resourceTypeId: string }>;
  checksum: Buffer;
  duration_ticks: string;
  facility_asset_type: string;
  id: string;
  recipe_id: string;
  version: number;
}

interface ContractRow extends QueryResultRow {
  business_id: string;
  cooldown_ticks: string;
  effective_from_tick: string;
  effective_until_tick: string;
  employer_entity_id: string;
  employer_wallet_id: string;
  id: string;
  max_payments_per_period: number;
  cadence_ticks: string;
  reward_cap_minor: string;
  row_version: string;
  status: 'active' | 'cancelled' | 'ended' | 'offered';
  wage_minor: string;
  worker_controlled_by_actor: boolean;
  worker_entity_id: string;
  worker_wallet_id: string;
}

interface ListingRow extends QueryResultRow {
  currency_id: string;
  expires_at_tick: string;
  id: string;
  quantity_scale: number;
  remaining_quantity: string;
  reserved_quantity: string;
  resource_type_id: string;
  row_version: string;
  seller_entity_id: string;
  seller_inventory_id: string;
  seller_controlled_by_actor: boolean;
  seller_wallet_id: string;
  status: 'cancelled' | 'expired' | 'filled' | 'open';
  unit_price_minor: string;
  world_id: string;
}

interface TaxPolicyRow extends QueryResultRow {
  collection_mode: 'added_to_payer' | 'withheld_from_recipient';
  fixed_amount_minor: string | null;
  id: string;
  rate_basis_points: number | null;
  rounding_mode: 'floor';
  tax_type: 'marketplace_fee' | 'payroll' | 'periodic_flat' | 'sales' | 'transaction';
  treasury_wallet_id: string;
}

interface MaterializedCommerceRow extends QueryResultRow {
  result: {
    businessCount: number;
    checksum: string;
    facilityCount: number;
    inventoryCount: number;
    recipeVersionCount: number;
    resourceTypeCount: number;
    scheduledActions: Array<{
      actionType: 'AssessPeriodicTaxV1';
      dueTick: string;
      taxPolicyId: string;
    }>;
    taxPolicyCount: number;
  };
}

interface CommerceCommandTraceRow extends QueryResultRow {
  database_transaction_id: string;
  event_ids: string[];
  listing_ids: string[];
  outbox_message_ids: string[];
  run_ids: string[];
  tax_assessment_ids: string[];
  trade_ids: string[];
  wallet_transaction_ids: string[];
  wallet_ids: string[];
}

interface CommerceReconciliationSnapshot {
  assessmentCount: number;
  inventoryCount: number;
  itemCount: number;
  items: Array<{
    actualValue: string | null;
    expectedValue: string | null;
    itemKey: string;
    itemKind:
      | 'business'
      | 'employment_contract'
      | 'facility'
      | 'inventory_quantity'
      | 'inventory_reservation'
      | 'market_listing'
      | 'market_trade'
      | 'payroll'
      | 'production'
      | 'projection_checkpoint'
      | 'recipe_version'
      | 'reservation_lifecycle'
      | 'tax_assessment'
      | 'tax_policy';
    itemOrdinal: number;
    mismatchCode: string;
  }>;
  liveInventoryChecksum: string;
  livePayrollChecksum: string;
  liveProjectionChecksum: string;
  liveReservationChecksum: string;
  liveTaxChecksum: string;
  liveTradeChecksum: string;
  matched: boolean;
  mismatchCount: number;
  projectionChecksum: string;
  rebuiltInventoryChecksum: string;
  rebuiltJournalChecksum: string;
  rebuiltPayrollChecksum: string;
  rebuiltReservationChecksum: string;
  rebuiltTaxChecksum: string;
  rebuiltTradeChecksum: string;
  resourceCount: number;
  tradeCount: number;
}

interface CommerceContext {
  clock: CommerceClockRow;
  head: CommerceHeadRow;
}

interface UninitializedCommerceContext {
  clock: CommerceClockRow;
  head: null;
}

const MAX_RATE_WINDOW_COUNT = 10_000;
const COMMERCE_PAYLOAD_FACT_COMMAND_TYPES = new Set<string>([
  CREATE_EMPLOYMENT_CONTRACT_COMMAND,
  END_EMPLOYMENT_CONTRACT_COMMAND,
  START_PRODUCTION_RUN_COMMAND,
  CREATE_MARKET_LISTING_COMMAND,
  PURCHASE_MARKET_LISTING_COMMAND,
]);

type CommerceReconciliationStatus = CommerceHeadRow['reconciliation_status'];
type CommerceContextMode = 'must_exist' | 'must_not_exist' | 'reconcile';

export function commerceReconciliationStatusAllowsWrite(
  status: CommerceReconciliationStatus,
  mode: CommerceContextMode,
): boolean {
  return mode === 'reconcile' || (status !== 'failed' && status !== 'mismatch');
}

export function listingSellerWalletIsActive(status: 'active' | 'closed' | 'frozen'): boolean {
  return status === 'active';
}

export async function executePostgresCommerceCommand(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
): Promise<WorldCommandResultTransport> {
  await executor.query('savepoint worldgraph_commerce_command_effects');
  try {
    await enforceCommercePolicy(executor, input);
    const resultingStateRevision = increment(input.world.stateRevision);
    const prepared = await prepareCommerceCommand(executor, ids, input, resultingStateRevision);
    if (!prepared.economyChecksum) {
      prepared.economyChecksum = await currentCoreEconomyChecksum(executor, input.command.worldId);
    }
    const result = await finalizeEconomyCommand(
      executor,
      ids,
      input,
      prepared,
      resultingStateRevision,
    );
    if (COMMERCE_PAYLOAD_FACT_COMMAND_TYPES.has(input.request.type)) {
      await executor.query(
        `select worldgraph_record_commerce_command_payload_fact(
           $1::uuid,$2::uuid,$3::jsonb
         )`,
        [input.command.commandId, input.command.worldId, JSON.stringify(input.request.payload)],
      );
    }
    annotateActiveEconomyCommandSpan({
      actorId: input.command.actorId,
      commandId: input.command.commandId,
      commandType: input.command.commandType,
      correlationId: input.command.correlationId,
      idempotencyKey: input.command.idempotencyKey,
      ...(await readCommerceCommandTraceCorrelation(
        executor,
        input.command.worldId,
        input.command.commandId,
      )),
      ...(input.request.expectedTick ? { tick: input.request.expectedTick } : {}),
      worldId: input.command.worldId,
    });
    await executor.query('release savepoint worldgraph_commerce_command_effects');
    return result;
  } catch (error) {
    await executor.query('rollback to savepoint worldgraph_commerce_command_effects');
    await executor.query('release savepoint worldgraph_commerce_command_effects');
    throw error;
  }
}

export async function readCommerceCommandTraceCorrelation(
  executor: EconomySqlExecutor,
  worldId: string,
  commandId: string,
): Promise<EconomyCommandTraceCorrelation> {
  const result = await executor.query<CommerceCommandTraceRow>(
    `select
       txid_current()::text as database_transaction_id,
       array(
         select event.id::text
           from domain_events event
          where event.world_id=$1 and event.command_id=$2
          order by event.event_ordinal
       ) as event_ids,
       array(
         select listing.id::text
           from market_listings listing
          where listing.world_id=$1
            and (listing.created_command_id=$2 or listing.terminal_command_id=$2)
          order by listing.id
       ) as listing_ids,
       array(
         select message.id::text
           from outbox_messages message
           join domain_events event
             on event.world_id=message.world_id and event.id=message.event_id
          where event.world_id=$1 and event.command_id=$2
          order by message.id
       ) as outbox_message_ids,
       array(
         select correlated.id
           from (
             select run.id::text as id
               from production_runs run
              where run.world_id=$1
                and (run.start_command_id=$2 or run.terminal_command_id=$2)
             union
             select reconciliation.id::text as id
               from economy_expansion_reconciliation_runs reconciliation
              where reconciliation.world_id=$1 and reconciliation.command_id=$2
           ) correlated
          order by correlated.id
       ) as run_ids,
       array(
         select assessment.id::text
           from tax_assessments assessment
          where assessment.world_id=$1 and assessment.command_id=$2
          order by assessment.id
       ) as tax_assessment_ids,
       array(
         select trade.id::text
           from market_trades trade
          where trade.world_id=$1 and trade.command_id=$2
          order by trade.id
       ) as trade_ids,
       array(
         select financial.id::text
           from financial_transactions financial
          where financial.world_id=$1 and financial.command_id=$2
          order by financial.id
       ) as wallet_transaction_ids,
       array(
         select distinct posting.wallet_id::text as wallet_id
           from financial_transactions financial
           join wallet_postings posting
             on posting.world_id=financial.world_id
            and posting.transaction_id=financial.id
          where financial.world_id=$1 and financial.command_id=$2
          order by wallet_id
       ) as wallet_ids`,
    [worldId, commandId],
  );
  const row = result.rows[0];
  if (!row) return {};
  return {
    databaseTransactionId: row.database_transaction_id,
    eventIds: row.event_ids,
    listingIds: row.listing_ids,
    outboxMessageIds: row.outbox_message_ids,
    runIds: row.run_ids,
    taxAssessmentIds: row.tax_assessment_ids,
    tradeIds: row.trade_ids,
    walletIds: row.wallet_ids,
    walletTransactionIds: row.wallet_transaction_ids,
  };
}

async function prepareCommerceCommand(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  switch (input.request.type) {
    case INITIALIZE_WORLD_COMMERCE_COMMAND:
      return initializeWorldCommerce(executor, ids, input, resultingStateRevision);
    case CREATE_BUSINESS_COMMAND:
      return createBusiness(executor, ids, input, resultingStateRevision);
    case CONFIGURE_BUSINESS_FACILITY_COMMAND:
      return configureFacility(executor, ids, input, resultingStateRevision);
    case CREATE_EMPLOYMENT_CONTRACT_COMMAND:
      return createEmploymentContract(executor, ids, input, resultingStateRevision);
    case ACCEPT_EMPLOYMENT_CONTRACT_COMMAND:
      return acceptEmploymentContract(executor, ids, input, resultingStateRevision);
    case END_EMPLOYMENT_CONTRACT_COMMAND:
      return endEmploymentContract(executor, ids, input, resultingStateRevision);
    case PERFORM_JOB_COMMAND:
      return performJob(executor, ids, input, resultingStateRevision);
    case START_PRODUCTION_RUN_COMMAND:
      return startProductionRun(executor, ids, input, resultingStateRevision);
    case CREATE_MARKET_LISTING_COMMAND:
      return createMarketListing(executor, ids, input, resultingStateRevision);
    case CANCEL_MARKET_LISTING_COMMAND:
      return cancelMarketListing(executor, ids, input, resultingStateRevision);
    case PURCHASE_MARKET_LISTING_COMMAND:
      return purchaseMarketListing(executor, ids, input, resultingStateRevision);
    case RECONCILE_WORLD_COMMERCE_COMMAND:
      return reconcileWorldCommerce(executor, ids, input, resultingStateRevision);
    default:
      throw new EconomyCommandExecutionError(
        'COMMAND_TYPE_DISABLED',
        'The commerce command type is disabled.',
      );
  }
}

async function initializeWorldCommerce(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as InitializeWorldCommercePayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_not_exist');
  const eventId = ids.next();
  const result = await executor.query<MaterializedCommerceRow>(
    `select worldgraph_materialize_world_commerce(
       $1::uuid,$2::uuid,decode($3,'hex'),$4::uuid,$5::uuid,$6::bigint,$7::timestamptz
     ) as result`,
    [
      input.command.worldId,
      payload.compiledWorldVersionId,
      payload.seedPlanHash,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const materialized = result.rows[0]?.result;
  if (!materialized || !/^[a-f0-9]{64}$/u.test(materialized.checksum)) {
    throw new EconomyCommandExecutionError(
      'SEED_PLAN_INCOMPATIBLE',
      'The compiled commerce seed plan could not be materialized.',
    );
  }
  if (!Array.isArray(materialized.scheduledActions) || materialized.scheduledActions.length > 15) {
    throw new EconomyCommandExecutionError(
      'SEED_PLAN_INCOMPATIBLE',
      'The compiled commerce schedule bootstrap exceeds the supported bound.',
    );
  }
  const scheduleEvents: PlannedEconomyEvent[] = [];
  const currentTick = BigInt(context.clock.current_tick);
  const scheduledPolicyIds = new Set<string>();
  for (const scheduled of materialized.scheduledActions) {
    if (
      scheduled.actionType !== 'AssessPeriodicTaxV1' ||
      scheduledPolicyIds.has(scheduled.taxPolicyId)
    ) {
      throw new EconomyCommandExecutionError(
        'SEED_PLAN_INCOMPATIBLE',
        'The compiled commerce schedule bootstrap is not canonical.',
      );
    }
    let dueTick: bigint;
    try {
      dueTick = BigInt(scheduled.dueTick);
    } catch {
      throw new EconomyCommandExecutionError(
        'SEED_PLAN_INCOMPATIBLE',
        'The compiled commerce schedule bootstrap has an invalid due tick.',
      );
    }
    if (dueTick <= currentTick || dueTick > 9_223_372_036_854_775_807n) {
      throw new EconomyCommandExecutionError(
        'SEED_PLAN_INCOMPATIBLE',
        'The compiled commerce schedule bootstrap is not in the bounded future.',
      );
    }
    scheduledPolicyIds.add(scheduled.taxPolicyId);
    scheduleEvents.push(
      await insertScheduledAction(executor, {
        actionType: 'AssessPeriodicTaxV1',
        actorId: input.command.actorId,
        actorType: input.command.actorType,
        commandId: input.command.commandId,
        decidedAt: input.decidedAt,
        dueTick,
        eventId: ids.next(),
        id: ids.next(),
        payload: { taxPolicyId: scheduled.taxPolicyId },
        resultingStateRevision,
        worldId: input.command.worldId,
      }),
    );
  }
  return prepared(
    [
      event(eventId, input.command.worldId, 'world_commerce', 'WorldCommerceInitializedV1', {
        aggregateVersion: '1',
        businessCount: materialized.businessCount,
        facilityCount: materialized.facilityCount,
        inventoryCount: materialized.inventoryCount,
        recipeVersionCount: materialized.recipeVersionCount,
        resourceTypeCount: materialized.resourceTypeCount,
        seedPlanHash: payload.seedPlanHash,
        taxPolicyCount: materialized.taxPolicyCount,
        tick: requiredExpectedTick(input),
      }),
      ...scheduleEvents,
    ],
    Buffer.from(materialized.checksum, 'hex'),
  );
}

async function createBusiness(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as CreateBusinessPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const organization = await lockEntity(
    executor,
    input.command.worldId,
    payload.backingOrganizationEntityKey,
    input.command.actorId,
  );
  if (organization.entity_type !== 'organization')
    invalid('Business backing entity is not an organization.');
  const displayName = entityDisplayName(organization.display_name);
  await requireManagerOrWorldAdministrator(executor, input, organization.controlled_by_actor);
  const wallet = await lockWallet(executor, input, payload.walletId);
  if (
    wallet.owner_entity_id !== organization.id ||
    wallet.wallet_kind !== 'organization' ||
    wallet.status !== 'active'
  ) {
    invalid('Business wallet must be an active organization wallet owned by the backing entity.');
  }
  const businessId = ids.next();
  const eventId = ids.next();
  const stableKey = replaceStableKeyNamespace(organization.logical_key, 'business');
  try {
    await executor.query(
      `insert into businesses(
         id,world_id,stable_key,display_name,backing_organization_entity_id,wallet_id,currency_id,
         status,metadata,business_schema_version,row_version,created_command_id,created_event_id,
         created_state_revision,updated_state_revision,created_at,updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,'active','{}'::jsonb,1,1,$8,$9,$10::bigint,
         $10::bigint,$11,$11)`,
      [
        businessId,
        input.command.worldId,
        stableKey,
        displayName,
        organization.id,
        wallet.id,
        wallet.currency_id,
        input.command.commandId,
        eventId,
        resultingStateRevision,
        input.decidedAt,
      ],
    );
  } catch (error) {
    if (postgresCode(error) === '23505') conflict('The organization already backs a business.');
    throw error;
  }
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, businessId, 'business', 'BusinessCreatedV1', {
        aggregateVersion: '1',
        backingOrganizationEntityId: organization.id,
        businessId,
        tick: context.clock.current_tick,
        walletId: wallet.id,
      }),
    ],
    checksum,
  );
}

async function configureFacility(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as ConfigureBusinessFacilityPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const business = await lockBusiness(executor, input, payload.businessId);
  requireBusinessVersionAndControl(business, payload.expectedBusinessVersion);
  const asset = await executor.query<{
    asset_stable_key: string;
    asset_type: string;
    asset_id: string;
    has_open_transfer_offer: boolean;
    owner_entity_id: string;
    ownership_version: string;
    transferable: boolean;
  }>(
    `select asset.id::text as asset_id,asset.stable_key::text as asset_stable_key,
            asset.asset_type::text,ownership.owner_entity_id::text,
            exists (
              select 1 from asset_transfer_offers offer
               where offer.world_id=asset.world_id and offer.asset_id=asset.id
                 and offer.status='open'
            ) as has_open_transfer_offer,
            ownership.ownership_version::text,asset.transferable
       from assets asset
       join asset_ownership ownership on ownership.world_id=asset.world_id
        and ownership.asset_id=asset.id
      where asset.world_id=$1 and asset.id=$2 and asset.status='active'
      for update of asset,ownership`,
    [input.command.worldId, payload.facilityAssetId],
  );
  const owned = asset.rows[0];
  if (
    !owned ||
    owned.owner_entity_id !== business.backing_organization_entity_id ||
    owned.ownership_version !== payload.expectedOwnershipVersion
  ) {
    throw new EconomyCommandExecutionError(
      'ASSET_NOT_OWNED',
      'The facility asset is not owned by the business.',
    );
  }
  if (owned.has_open_transfer_offer) {
    throw new EconomyCommandExecutionError(
      'OWNERSHIP_CONFLICT',
      'An open transfer offer must be cancelled before configuring this facility.',
    );
  }
  const recipes = await executor.query<{ facility_asset_type: string; id: string }>(
    `select id::text,facility_requirements ->> 'assetType' as facility_asset_type
       from production_recipe_versions
      where world_id=$1 and id=any($2::uuid[])
      order by id`,
    [input.command.worldId, [...payload.recipeVersionIds].sort()],
  );
  if (recipes.rows.length !== payload.recipeVersionIds.length)
    invalid('A recipe version is unavailable.');
  if (recipes.rows.some((recipe) => recipe.facility_asset_type !== owned.asset_type)) {
    invalid('The facility asset type does not satisfy every selected recipe.');
  }
  const facilityId = ids.next();
  const eventId = ids.next();
  const facilityStableKey = replaceStableKeyNamespace(owned.asset_stable_key, 'facility');
  await executor.query(
    `insert into business_facilities(
       id,world_id,stable_key,business_id,facility_asset_id,status,facility_schema_version,row_version,
       created_command_id,created_event_id,created_state_revision,updated_state_revision,
       created_at,updated_at
     ) values ($1,$2,$3,$4,$5,'active',1,1,$6,$7,$8::bigint,$8::bigint,$9,$9)`,
    [
      facilityId,
      input.command.worldId,
      facilityStableKey,
      business.id,
      payload.facilityAssetId,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  for (const recipeVersionId of [...payload.recipeVersionIds].sort()) {
    await executor.query(
      `insert into business_facility_recipe_versions(
         world_id,facility_id,recipe_version_id,configured_command_id,configured_event_id,created_at
       ) values ($1,$2,$3,$4,$5,$6)`,
      [
        input.command.worldId,
        facilityId,
        recipeVersionId,
        input.command.commandId,
        eventId,
        input.decidedAt,
      ],
    );
  }
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, facilityId, 'business_facility', 'BusinessFacilityConfiguredV1', {
        aggregateVersion: '1',
        businessId: business.id,
        facilityAssetId: payload.facilityAssetId,
        facilityId,
        recipeVersionIds: [...payload.recipeVersionIds].sort(),
        tick: context.clock.current_tick,
      }),
    ],
    checksum,
  );
}

async function createEmploymentContract(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as CreateEmploymentContractPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const business = await lockBusiness(executor, input, payload.businessId);
  requireBusinessVersionAndControl(business, payload.expectedBusinessVersion);
  const worker = await lockEntity(
    executor,
    input.command.worldId,
    payload.workerEntityKey,
    input.command.actorId,
  );
  if (worker.entity_type !== 'player_character')
    invalid('Employment worker must be a player character.');
  const employerWallet = await lockWallet(executor, input, payload.employerWalletId);
  const workerWallet = await lockWallet(executor, input, payload.workerWalletId);
  if (
    employerWallet.id !== business.wallet_id ||
    employerWallet.owner_entity_id !== business.backing_organization_entity_id ||
    workerWallet.owner_entity_id !== worker.id ||
    workerWallet.wallet_kind !== 'player' ||
    employerWallet.currency_id !== workerWallet.currency_id ||
    employerWallet.status !== 'active' ||
    workerWallet.status !== 'active'
  ) {
    invalid('Employment wallets do not match the employer, worker, and currency.');
  }
  const fromTick = BigInt(payload.effectiveFromTick);
  const toTick = BigInt(payload.effectiveToTick);
  const wage = BigInt(payload.wageMinor);
  if (
    fromTick < BigInt(context.clock.current_tick) ||
    toTick <= fromTick ||
    BigInt(payload.rewardCapMinor) < wage ||
    BigInt(payload.periodTicks) < 1n
  ) {
    invalid('Employment terms are outside bounded tick or reward limits.');
  }
  const contractId = ids.next();
  const eventId = ids.next();
  const stableKey = `employment-contract:${input.command.commandId}`;
  await executor.query(
    `insert into employment_contracts(
       id,world_id,stable_key,business_id,worker_entity_id,employer_wallet_id,worker_wallet_id,
       currency_id,role_code,wage_rule,wage_minor,cadence_ticks,output_rule,cooldown_ticks,
       reward_cap_minor,max_payments_per_period,effective_from_tick,effective_until_tick,status,
       employment_contract_schema_version,row_version,created_command_id,created_event_id,
       created_state_revision,created_at,updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,'per_shift',$10::bigint,$11::bigint,null,$12::bigint,
       $13::bigint,$14,$15::bigint,$16::bigint,'offered',1,1,$17,$18,$19::bigint,$20,$20
     )`,
    [
      contractId,
      input.command.worldId,
      stableKey,
      business.id,
      worker.id,
      employerWallet.id,
      workerWallet.id,
      employerWallet.currency_id,
      payload.roleCode,
      payload.wageMinor,
      payload.periodTicks,
      payload.cooldownTicks,
      payload.rewardCapMinor,
      payload.maxPerformancesPerPeriod,
      payload.effectiveFromTick,
      payload.effectiveToTick,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, contractId, 'employment_contract', 'EmploymentContractCreatedV1', {
        aggregateVersion: '1',
        businessId: business.id,
        contractId,
        status: 'offered',
        tick: context.clock.current_tick,
        workerEntityId: worker.id,
      }),
    ],
    checksum,
    [
      participant(
        eventId,
        'contract',
        'EMPLOYMENT_CONTRACT_CREATED',
        business.backing_organization_entity_id,
        worker.id,
      ),
    ],
  );
}

async function acceptEmploymentContract(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as AcceptEmploymentContractPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const contract = await lockContract(executor, input, payload.contractId);
  if (!contract.worker_controlled_by_actor)
    forbidden('Only the controlled worker can accept this contract.');
  if (contract.status !== 'offered') contractConflict('Employment contract is not offered.');
  if (contract.row_version !== payload.expectedContractVersion)
    aggregateConflict('Employment contract version changed.');
  const nextVersion = increment(contract.row_version);
  const eventId = ids.next();
  const contractUpdated = await executor.query(
    `update employment_contracts set status='active',row_version=row_version+1,
       accepted_command_id=$3,accepted_event_id=$4,accepted_state_revision=$5::bigint,
       updated_at=greatest(updated_at,$6)
     where world_id=$1 and id=$2 and status='offered' and row_version=$7::bigint`,
    [
      input.command.worldId,
      contract.id,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
      payload.expectedContractVersion,
    ],
  );
  if ((contractUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Employment contract changed during acceptance.');
  }
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, contract.id, 'employment_contract', 'EmploymentContractAcceptedV1', {
        aggregateVersion: nextVersion,
        businessId: contract.business_id,
        contractId: contract.id,
        status: 'active',
        tick: context.clock.current_tick,
        workerEntityId: contract.worker_entity_id,
      }),
    ],
    checksum,
    [
      participant(
        eventId,
        'contract',
        'EMPLOYMENT_CONTRACT_ACCEPTED',
        contract.employer_entity_id,
        contract.worker_entity_id,
      ),
    ],
  );
}

async function endEmploymentContract(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as EndEmploymentContractPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const contract = await lockContract(executor, input, payload.contractId);
  const business = await lockBusiness(executor, input, contract.business_id);
  if (!contract.worker_controlled_by_actor && !business.controlled_by_actor) {
    forbidden('Only the worker or business manager can end this contract.');
  }
  if (contract.status !== 'active') contractConflict('Employment contract is not active.');
  if (contract.row_version !== payload.expectedContractVersion)
    aggregateConflict('Employment contract version changed.');
  const nextVersion = increment(contract.row_version);
  const eventId = ids.next();
  const contractUpdated = await executor.query(
    `update employment_contracts set status='ended',row_version=row_version+1,
       terminal_command_id=$3,terminal_event_id=$4,terminal_state_revision=$5::bigint,
       terminal_reason=$6,ended_at=$7,updated_at=greatest(updated_at,$7)
     where world_id=$1 and id=$2 and status='active' and row_version=$8::bigint`,
    [
      input.command.worldId,
      contract.id,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      payload.reason,
      input.decidedAt,
      payload.expectedContractVersion,
    ],
  );
  if ((contractUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Employment contract changed during termination.');
  }
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, contract.id, 'employment_contract', 'EmploymentContractEndedV1', {
        aggregateVersion: nextVersion,
        businessId: contract.business_id,
        contractId: contract.id,
        status: 'ended',
        tick: context.clock.current_tick,
        workerEntityId: contract.worker_entity_id,
      }),
    ],
    checksum,
    [
      participant(
        eventId,
        'contract',
        'EMPLOYMENT_CONTRACT_ENDED',
        contract.employer_entity_id,
        contract.worker_entity_id,
      ),
    ],
  );
}

async function performJob(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as PerformJobPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const contract = await lockContract(executor, input, payload.contractId);
  if (!contract.worker_controlled_by_actor)
    forbidden('Only the controlled worker can perform this job.');
  if (contract.row_version !== payload.expectedContractVersion)
    aggregateConflict('Employment contract version changed.');
  const currentTick = BigInt(context.clock.current_tick);
  const periodStart =
    (currentTick / BigInt(contract.cadence_ticks)) * BigInt(contract.cadence_ticks);
  const usage = await executor.query<{ last_tick: string | null; period_count: string }>(
    `select max(performed_tick)::text as last_tick,
            count(*) filter (where performed_tick >= $3::bigint)::text as period_count
       from work_records where world_id=$1 and contract_id=$2`,
    [input.command.worldId, contract.id, periodStart.toString()],
  );
  const policy = await activeTaxPolicy(
    executor,
    input.command.worldId,
    'payroll',
    context.clock.current_tick,
    input.policy.disabledTaxPolicyIds,
  );
  if (policy && policy.collection_mode !== 'withheld_from_recipient') {
    policyInvalid('Payroll tax must be withheld from worker proceeds.');
  }
  const decision = decideJobPerformance({
    contract: contractState(contract),
    currentTick,
    lastPerformedTick: usage.rows[0]?.last_tick ? BigInt(usage.rows[0].last_tick) : null,
    performancesInPeriod: Number(usage.rows[0]?.period_count ?? '0'),
    taxPolicy: policy ? taxPolicyState(policy) : null,
  });
  const workRecordId = ids.next();
  const payrollRecordId = ids.next();
  const scheduledActionId = ids.next();
  const eventId = ids.next();
  const scheduleEventId = ids.next();
  const payPeriodKey = `${periodStart.toString()}:${contract.id}:${workRecordId}`;
  await executor.query(
    `insert into work_records(
       id,world_id,contract_id,work_key,performed_tick,validated_output,gross_minor,
       command_id,event_id,state_revision,created_at
     ) values ($1,$2,$3,$4,$5::bigint,$6,$7::bigint,$8,$9,$10::bigint,$11)`,
    [
      workRecordId,
      input.command.worldId,
      contract.id,
      input.command.idempotencyKey,
      context.clock.current_tick,
      JSON.stringify({}),
      decision.grossMinor.toString(),
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const scheduledEvent = await insertScheduledAction(executor, {
    actionType: 'SettlePayrollV1',
    actorId: input.command.actorId,
    actorType: input.command.actorType,
    commandId: input.command.commandId,
    decidedAt: input.decidedAt,
    dueTick: currentTick + 1n,
    eventId: scheduleEventId,
    id: scheduledActionId,
    payload: { payrollRecordId },
    resultingStateRevision,
    worldId: input.command.worldId,
  });
  await executor.query(
    `insert into payroll_records(
       id,world_id,contract_id,work_record_id,pay_period_key,gross_minor,tax_minor,net_minor,
       status,row_version,scheduled_action_id,tax_policy_id,created_command_id,created_event_id,
       created_state_revision,created_at,updated_at
     ) values ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8::bigint,'pending',1,$9,$10,$11,$12,
       $13::bigint,$14,$14)`,
    [
      payrollRecordId,
      input.command.worldId,
      contract.id,
      workRecordId,
      payPeriodKey,
      decision.grossMinor.toString(),
      decision.tax?.amountMinor.toString() ?? '0',
      decision.netMinor.toString(),
      scheduledActionId,
      decision.tax && decision.tax.amountMinor > 0n ? (policy?.id ?? null) : null,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  await executor.query(
    `insert into payroll_policy_selection_facts(
       payroll_record_id,world_id,work_record_id,tax_policy_id,
       gross_minor,tax_minor,net_minor,command_id,event_id,state_revision,
       evidence_checksum,created_at
     ) values (
       $1,$2,$3,$4,$5::bigint,$6::bigint,$7::bigint,$8,$9,$10::bigint,
       extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
         'commandId',$8::uuid::text,
         'eventId',$9::uuid::text,
         'grossMinor',$5::bigint::text,
         'netMinor',$7::bigint::text,
         'payrollRecordId',$1::uuid::text,
         'stateRevision',$10::bigint::text,
         'taxMinor',$6::bigint::text,
         'taxPolicyId',$4::uuid::text,
         'workRecordId',$3::uuid::text,
         'worldId',$2::uuid::text
       )),'UTF8'),'sha256'),$11
     )`,
    [
      payrollRecordId,
      input.command.worldId,
      workRecordId,
      decision.tax && decision.tax.amountMinor > 0n ? (policy?.id ?? null) : null,
      decision.grossMinor.toString(),
      decision.tax?.amountMinor.toString() ?? '0',
      decision.netMinor.toString(),
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, workRecordId, 'work_record', 'WorkRecordedV1', {
        aggregateVersion: '1',
        contractId: contract.id,
        payrollRecordId,
        taxPolicyId: decision.tax && decision.tax.amountMinor > 0n ? (policy?.id ?? null) : null,
        tick: context.clock.current_tick,
        workRecordId,
      }),
      scheduledEvent,
    ],
    checksum,
    [
      participant(
        eventId,
        'contract',
        'WORK_RECORDED',
        contract.employer_entity_id,
        contract.worker_entity_id,
      ),
    ],
  );
}

async function startProductionRun(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as StartProductionRunPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const business = await lockBusiness(executor, input, payload.businessId);
  requireBusinessVersionAndControl(business, payload.expectedBusinessVersion);
  const facility = await lockFacility(executor, input, payload.facilityId);
  if (
    facility.business_id !== business.id ||
    facility.row_version !== payload.expectedFacilityVersion ||
    facility.status !== 'active'
  ) {
    aggregateConflict('Business facility version or status changed.');
  }
  const recipe = await loadRecipe(
    executor,
    input.command.worldId,
    facility.id,
    payload.recipeVersionId,
  );
  const inputs = await lockProductionInventories(executor, input, business, facility, recipe);
  const expected = new Map(
    payload.expectedInventories.map((item) => [item.inventoryId, item.rowVersion]),
  );
  if (expected.size !== inputs.size) {
    aggregateConflict('Expected inventory set does not match the recipe inputs.');
  }
  for (const inventory of inputs.values()) {
    if (expected.get(inventory.id) !== inventory.row_version)
      aggregateConflict('Inventory version changed.');
  }
  const scales = await resourceScales(
    executor,
    input.command.worldId,
    [...recipe.canonical_inputs, ...recipe.canonical_outputs].map((item) => item.resourceTypeId),
  );
  const recipeState = recipeStateFromRows(recipe, scales);
  const runQuantity = parseCanonicalQuantity(payload.runQuantity, 0, { positive: true });
  const decision = decideProductionReservation({
    currentTick: BigInt(context.clock.current_tick),
    inputInventories: new Map(
      [...inputs.values()].map((row) => [row.resource_type_id, inventoryState(row)]),
    ),
    recipe: recipeState,
    runQuantity,
  });
  const runId = ids.next();
  const scheduledActionId = ids.next();
  const eventId = ids.next();
  const scheduleEventId = ids.next();
  const inputSnapshot = decision.inputs.map((item) => ({
    quantity: formatQuantity(item.quantityAtoms, inputs.get(item.resourceTypeId)!.quantity_scale),
    resourceTypeId: item.resourceTypeId,
  }));
  const outputSnapshot = decision.outputs.map((item) => ({
    quantity: formatQuantity(item.quantityAtoms, scales.get(item.resourceTypeId)!),
    resourceTypeId: item.resourceTypeId,
  }));
  const snapshotChecksum = hashHex({ inputs: inputSnapshot, outputs: outputSnapshot });
  const scheduledEvent = await insertScheduledAction(executor, {
    actionType: 'CompleteProductionRunV1',
    actorId: input.command.actorId,
    actorType: input.command.actorType,
    commandId: input.command.commandId,
    decidedAt: input.decidedAt,
    dueTick: decision.dueTick,
    eventId: scheduleEventId,
    id: scheduledActionId,
    payload: { productionRunId: runId },
    resultingStateRevision,
    worldId: input.command.worldId,
  });
  await executor.query(
    `insert into production_runs(
       id,world_id,business_id,facility_id,recipe_version_id,scheduled_action_id,quantity,status,
       due_tick,input_snapshot,output_snapshot,snapshot_checksum,row_version,start_command_id,
       start_event_id,created_state_revision,created_at,updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7::numeric,'ready',$8::bigint,$9,$10,decode($11,'hex'),1,
       $12,$13,$14::bigint,$15,$15)`,
    [
      runId,
      input.command.worldId,
      business.id,
      facility.id,
      recipe.id,
      scheduledActionId,
      payload.runQuantity,
      decision.dueTick.toString(),
      JSON.stringify(inputSnapshot),
      JSON.stringify(outputSnapshot),
      snapshotChecksum,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  await executor.query(
    `insert into production_run_transitions(
       run_id,world_id,transition_version,status,command_id,event_id,occurred_tick,
       state_revision,snapshot_hash,created_at
     ) values ($1,$2,1,'ready',$3,$4,$5::bigint,$6::bigint,decode($7,'hex'),$8)`,
    [
      runId,
      input.command.worldId,
      input.command.commandId,
      eventId,
      context.clock.current_tick,
      resultingStateRevision,
      snapshotChecksum,
      input.decidedAt,
    ],
  );
  for (const requirement of decision.inputs) {
    const inventory = inputs.get(requirement.resourceTypeId)!;
    const mutation = reserveInventory(
      inventoryState(inventory),
      requirement.quantityAtoms,
      BigInt(inventory.row_version),
    );
    const inventoryUpdated = await executor.query(
      `update inventories set reserved_quantity=$3::numeric,row_version=$4::bigint,
         updated_state_revision=$5::bigint,updated_at=greatest(updated_at,$6)
       where world_id=$1 and id=$2 and row_version=$7::bigint`,
      [
        input.command.worldId,
        inventory.id,
        formatQuantity(mutation.reservedAtoms, inventory.quantity_scale),
        mutation.rowVersion.toString(),
        resultingStateRevision,
        input.decidedAt,
        inventory.row_version,
      ],
    );
    if ((inventoryUpdated.rowCount ?? 0) !== 1) {
      aggregateConflict('Production input inventory changed during reservation.');
    }
    await executor.query(
      `insert into inventory_reservations(
       id,world_id,inventory_id,purpose_type,purpose_id,quantity,status,row_version,
         created_command_id,created_event_id,created_state_revision,created_at,updated_at
       ) values ($1,$2,$3,'production_input',$4,$5::numeric,'active',1,$6,$7,$8::bigint,$9,$9)`,
      [
        ids.next(),
        input.command.worldId,
        inventory.id,
        runId,
        formatQuantity(requirement.quantityAtoms, inventory.quantity_scale),
        input.command.commandId,
        eventId,
        resultingStateRevision,
        input.decidedAt,
      ],
    );
  }
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, runId, 'production_run', 'ProductionRunStartedV1', {
        aggregateVersion: '1',
        dueTick: decision.dueTick.toString(),
        productionRunId: runId,
        recipeVersionId: recipe.id,
        scheduledActionId,
        tick: context.clock.current_tick,
      }),
      scheduledEvent,
    ],
    checksum,
  );
}

async function createMarketListing(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as CreateMarketListingPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const inventory = await lockInventory(executor, input, payload.sellerInventoryId);
  if (!inventory.controlled_by_actor)
    forbidden('The seller inventory is not controlled by the actor.');
  if (inventory.row_version !== payload.expectedInventoryVersion)
    aggregateConflict('Inventory version changed.');
  const wallet = await lockWallet(executor, input, payload.sellerWalletId);
  if (!wallet.controlled_by_actor || wallet.owner_entity_id !== inventory.owner_entity_id) {
    forbidden('The seller wallet and inventory must have the same controlled owner.');
  }
  if (!listingSellerWalletIsActive(wallet.status)) {
    invalid('The seller wallet must be active to create a market listing.');
  }
  const quantityAtoms = parseCanonicalQuantity(payload.quantity, inventory.quantity_scale, {
    positive: true,
  });
  const mutation = reserveInventory(
    inventoryState(inventory),
    quantityAtoms,
    BigInt(inventory.row_version),
  );
  const currentTick = BigInt(context.clock.current_tick);
  const expiresAtTick = BigInt(payload.expiresAtTick);
  if (expiresAtTick <= currentTick || expiresAtTick - currentTick > 1_000_000n) {
    throw new EconomyCommandExecutionError(
      'SCHEDULE_IN_PAST',
      'Listing expiry must be a bounded future tick.',
    );
  }
  const listingId = ids.next();
  const reservationId = ids.next();
  const scheduledActionId = ids.next();
  const eventId = ids.next();
  const scheduleEventId = ids.next();
  const inventoryUpdated = await executor.query(
    `update inventories set reserved_quantity=$3::numeric,row_version=$4::bigint,
       updated_state_revision=$5::bigint,updated_at=greatest(updated_at,$6)
     where world_id=$1 and id=$2 and row_version=$7::bigint`,
    [
      input.command.worldId,
      inventory.id,
      formatQuantity(mutation.reservedAtoms, inventory.quantity_scale),
      mutation.rowVersion.toString(),
      resultingStateRevision,
      input.decidedAt,
      inventory.row_version,
    ],
  );
  if ((inventoryUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Seller inventory changed during listing reservation.');
  }
  const scheduledEvent = await insertScheduledAction(executor, {
    actionType: 'ExpireMarketListingV1',
    actorId: input.command.actorId,
    actorType: input.command.actorType,
    commandId: input.command.commandId,
    decidedAt: input.decidedAt,
    dueTick: expiresAtTick,
    eventId: scheduleEventId,
    id: scheduledActionId,
    payload: { listingId },
    resultingStateRevision,
    worldId: input.command.worldId,
  });
  await executor.query(
    `insert into market_listings(
       id,world_id,seller_entity_id,seller_inventory_id,resource_type_id,seller_wallet_id,currency_id,
       offered_quantity,remaining_quantity,reserved_quantity,unit_price_minor,status,expires_at_tick,
       scheduled_action_id,row_version,created_command_id,created_event_id,created_state_revision,
       created_at,updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$8::numeric,$8::numeric,$9::bigint,'open',
       $10::bigint,$11,1,$12,$13,$14::bigint,$15,$15)`,
    [
      listingId,
      input.command.worldId,
      inventory.owner_entity_id,
      inventory.id,
      inventory.resource_type_id,
      wallet.id,
      wallet.currency_id,
      payload.quantity,
      payload.unitPriceMinor,
      payload.expiresAtTick,
      scheduledActionId,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  await executor.query(
    `insert into inventory_reservations(
       id,world_id,inventory_id,purpose_type,purpose_id,quantity,status,expires_at_tick,row_version,
       created_command_id,created_event_id,created_state_revision,created_at,updated_at
     ) values ($1,$2,$3,'market_listing',$4,$5::numeric,'active',$6::bigint,1,$7,$8,$9::bigint,$10,$10)`,
    [
      reservationId,
      input.command.worldId,
      inventory.id,
      listingId,
      payload.quantity,
      payload.expiresAtTick,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, listingId, 'market_listing', 'MarketListingCreatedV1', {
        aggregateVersion: '1',
        listingId,
        remainingQuantity: payload.quantity,
        status: 'open',
        tick: context.clock.current_tick,
      }),
      scheduledEvent,
    ],
    checksum,
    [participant(eventId, 'listing', 'MARKET_LISTING_CREATED', inventory.owner_entity_id, null)],
  );
}

async function cancelMarketListing(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as CancelMarketListingPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const listing = await lockListing(executor, input, payload.listingId);
  if (listing.row_version !== payload.expectedListingVersion) listingStale();
  if (listing.status !== 'open') listingNotOpen();
  const reservation = await activeReservation(
    executor,
    input.command.worldId,
    'market_listing',
    listing.id,
  );
  if (!reservation) conflict('Listing reservation is unavailable.');
  const inventory = await lockInventory(executor, input, listing.seller_inventory_id);
  if (!inventory.controlled_by_actor) forbidden('Only the seller can cancel this listing.');
  const releasedAtoms = parseDatabaseQuantity(listing.remaining_quantity, listing.quantity_scale);
  const reservationAtoms = parseDatabaseQuantity(reservation.quantity, listing.quantity_scale);
  const reservedAtoms = parseDatabaseQuantity(
    inventory.reserved_quantity,
    inventory.quantity_scale,
  );
  if (reservationAtoms !== releasedAtoms || reservedAtoms < releasedAtoms)
    conflict('Listing reservation is inconsistent.');
  const eventId = ids.next();
  const scheduleEventId = ids.next();
  const nextVersion = increment(listing.row_version);
  const listingUpdated = await executor.query(
    `update market_listings set status='cancelled',remaining_quantity=remaining_quantity,
       reserved_quantity=0,row_version=row_version+1,terminal_command_id=$3,terminal_event_id=$4,
       terminal_state_revision=$5::bigint,terminal_at=$6,updated_at=greatest(updated_at,$6)
     where world_id=$1 and id=$2 and status='open' and row_version=$7::bigint`,
    [
      input.command.worldId,
      listing.id,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
      payload.expectedListingVersion,
    ],
  );
  if ((listingUpdated.rowCount ?? 0) !== 1) listingStale();
  const inventoryUpdated = await executor.query(
    `update inventories set reserved_quantity=$3::numeric,row_version=row_version+1,
       updated_state_revision=$4::bigint,updated_at=greatest(updated_at,$5)
     where world_id=$1 and id=$2 and row_version=$6::bigint`,
    [
      input.command.worldId,
      inventory.id,
      formatQuantity(reservedAtoms - releasedAtoms, inventory.quantity_scale),
      resultingStateRevision,
      input.decidedAt,
      inventory.row_version,
    ],
  );
  if ((inventoryUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Seller inventory changed during listing cancellation.');
  }
  const reservationUpdated = await executor.query(
    `update inventory_reservations set status='released',row_version=row_version+1,
       terminal_command_id=$3,terminal_event_id=$4,terminal_state_revision=$5::bigint,
       terminal_at=$6,updated_at=greatest(updated_at,$6)
     where world_id=$1 and id=$2 and status='active'`,
    [
      input.command.worldId,
      reservation.id,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  if ((reservationUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Listing reservation changed during cancellation.');
  }
  const scheduleUpdated = await executor.query(
    `update scheduled_actions set status='cancelled',cancelled_command_id=$3,
       completed_state_revision=$4::bigint,updated_at=$5
     where world_id=$1 and id=$2 and status='scheduled'`,
    [
      input.command.worldId,
      reservation.scheduled_action_id,
      input.command.commandId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  if ((scheduleUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Listing expiry schedule is already terminal.');
  }
  const scheduleCancelledEvent = event(
    scheduleEventId,
    reservation.scheduled_action_id,
    'scheduled_action',
    'ScheduledActionCancelledV1',
    {
      actionType: reservation.action_type,
      dueTick: reservation.due_tick,
      scheduleId: reservation.scheduled_action_id,
      scheduleSequence: reservation.schedule_sequence,
    },
  );
  const checksum = await advanceCommerceHead(executor, input, context.head, resultingStateRevision);
  return prepared(
    [
      event(eventId, listing.id, 'market_listing', 'MarketListingCancelledV1', {
        aggregateVersion: nextVersion,
        listingId: listing.id,
        remainingQuantity: listing.remaining_quantity,
        status: 'cancelled',
        tick: context.clock.current_tick,
      }),
      scheduleCancelledEvent,
    ],
    checksum,
    [participant(eventId, 'listing', 'MARKET_LISTING_CANCELLED', listing.seller_entity_id, null)],
  );
}

async function purchaseMarketListing(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as PurchaseMarketListingPayloadV1;
  const context = await lockCommerceContext(executor, input, 'must_exist');
  const listing = await lockListing(executor, input, payload.listingId);
  const supply = await currentSupply(executor, input.command.worldId, listing.currency_id);
  const reservation = await activeReservation(
    executor,
    input.command.worldId,
    'market_listing',
    listing.id,
  );
  if (!reservation) conflict('Listing reservation is unavailable.');
  const buyerWalletIdentity = await readWallet(executor, input, payload.buyerWalletId);
  const taxRow = await activeMarketTaxPolicy(
    executor,
    input.command.worldId,
    context.clock.current_tick,
    input.policy.disabledTaxPolicyIds,
  );
  const feeRow = await activeTaxPolicy(
    executor,
    input.command.worldId,
    'marketplace_fee',
    context.clock.current_tick,
    input.policy.disabledTaxPolicyIds,
  );
  const existingBuyerInventoryId =
    payload.buyerInventoryId ??
    (await findInventoryId(
      executor,
      input.command.worldId,
      buyerWalletIdentity.owner_entity_id,
      listing.resource_type_id,
    ));
  const inventories = await lockInventories(
    executor,
    input,
    existingBuyerInventoryId
      ? [listing.seller_inventory_id, existingBuyerInventoryId]
      : [listing.seller_inventory_id],
  );
  const sellerInventory = inventories.get(listing.seller_inventory_id)!;
  const inventoryEventId = ids.next();
  const buyerInventory = existingBuyerInventoryId
    ? inventories.get(existingBuyerInventoryId)!
    : await createBuyerInventory(
        executor,
        input,
        listing,
        buyerWalletIdentity.owner_entity_id,
        resultingStateRevision,
        inventoryEventId,
      );
  validateBuyerInventory(payload, listing, buyerWalletIdentity.owner_entity_id, buyerInventory);
  const wallets = await lockWallets(executor, input, [
    payload.buyerWalletId,
    listing.seller_wallet_id,
    ...(taxRow ? [taxRow.treasury_wallet_id] : []),
    ...(feeRow ? [feeRow.treasury_wallet_id] : []),
  ]);
  const buyerWallet = wallets.get(payload.buyerWalletId)!;
  if (!buyerWallet.controlled_by_actor || buyerWallet.status !== 'active') {
    throw new EconomyCommandExecutionError(
      'WALLET_NOT_CONTROLLED',
      'Buyer wallet is not controlled and active.',
    );
  }
  if (
    marketSelfTradeAttempt({
      buyerEntityId: buyerWallet.owner_entity_id,
      buyerWalletControlled: buyerWallet.controlled_by_actor,
      sellerControlledByActor: listing.seller_controlled_by_actor,
      sellerEntityId: listing.seller_entity_id,
    })
  ) {
    telemetry.economyAbuseSignals.add(1, { signal: 'self_trade_attempt' });
  }
  if (buyerWallet.owner_entity_id === listing.seller_entity_id) {
    invalid('A market participant cannot purchase its own listing.');
  }
  if (buyerWallet.balance_row_version !== payload.expectedBuyerWalletVersion)
    aggregateConflict('Buyer wallet version changed.');
  if (buyerWallet.currency_id !== listing.currency_id) currencyMismatch();
  const sellerWallet = wallets.get(listing.seller_wallet_id)!;
  if (
    sellerWallet.owner_entity_id !== listing.seller_entity_id ||
    sellerWallet.currency_id !== listing.currency_id ||
    sellerWallet.status !== 'active'
  ) {
    conflict('Listing seller wallet is no longer active for the seller and currency.');
  }
  const tax = taxRow ? taxPolicyState(taxRow) : null;
  const fee = feeRow ? taxPolicyState(feeRow) : null;
  const quantityAtoms = parseCanonicalQuantity(payload.quantity, listing.quantity_scale, {
    positive: true,
  });
  const listingReserved = parseDatabaseQuantity(listing.reserved_quantity, listing.quantity_scale);
  const reservationAtoms = parseDatabaseQuantity(reservation.quantity, listing.quantity_scale);
  const listingRemaining = parseDatabaseQuantity(
    listing.remaining_quantity,
    listing.quantity_scale,
  );
  if (listingReserved !== listingRemaining || reservationAtoms !== listingRemaining) {
    conflict('Listing and reservation quantities are inconsistent.');
  }
  const decision = decideMarketPurchase({
    buyerEntityId: buyerWallet.owner_entity_id,
    buyerWalletId: buyerWallet.id,
    currentTick: BigInt(context.clock.current_tick),
    expectedListingVersion: BigInt(payload.expectedListingVersion),
    feePolicy: fee,
    listing: listingState(listing),
    quantityAtoms,
    taxPolicy: tax,
  });
  for (const policy of [taxRow, feeRow]) {
    if (!policy) continue;
    const treasury = wallets.get(policy.treasury_wallet_id)!;
    if (
      treasury.currency_id !== listing.currency_id ||
      treasury.wallet_kind !== 'treasury' ||
      treasury.status !== 'active'
    ) {
      throw new EconomyCommandExecutionError(
        'POLICY_INVALID',
        'An active tax or fee policy treasury wallet is unavailable.',
      );
    }
  }
  const projected = projectAccountingDecision({
    currentBalances: new Map(
      [...wallets].map(([id, wallet]) => [id, BigInt(wallet.available_minor)]),
    ),
    currentSupplyMinor: supply,
    decision: decision.settlement,
    maxSupplyMinor: null,
  });
  const tradeId = ids.next();
  const financialTransactionId = ids.next();
  const movementId = ids.next();
  const tradeEventId = ids.next();
  const listingEventId = ids.next();
  const assessments: Array<{
    assessment: TaxAssessmentDecision;
    assessmentId: string;
    eventId: string;
    payerEntityId: string;
    payerWalletId: string;
    policy: TaxPolicyRow;
    treasuryEventId: string | null;
  }> = [];
  if (decision.tax && taxRow) {
    assessments.push({
      assessment: decision.tax,
      assessmentId: ids.next(),
      eventId: ids.next(),
      payerEntityId: buyerWallet.owner_entity_id,
      payerWalletId: buyerWallet.id,
      policy: taxRow,
      treasuryEventId: decision.tax.amountMinor > 0n ? ids.next() : null,
    });
  }
  if (decision.fee && feeRow) {
    assessments.push({
      assessment: decision.fee,
      assessmentId: ids.next(),
      eventId: ids.next(),
      payerEntityId: listing.seller_entity_id,
      payerWalletId: sellerWallet.id,
      policy: feeRow,
      treasuryEventId: decision.fee.amountMinor > 0n ? ids.next() : null,
    });
  }
  await applyWalletSettlement(
    executor,
    ids,
    input,
    financialTransactionId,
    tradeEventId,
    listing.currency_id,
    decision.settlement.postings,
    wallets,
    projected.balances,
    context.clock.current_tick,
    resultingStateRevision,
  );
  const sellerQuantity = parseDatabaseQuantity(sellerInventory.quantity, listing.quantity_scale);
  const sellerReserved = parseDatabaseQuantity(
    sellerInventory.reserved_quantity,
    listing.quantity_scale,
  );
  const buyerQuantity = parseDatabaseQuantity(buyerInventory.quantity, listing.quantity_scale);
  if (sellerQuantity < quantityAtoms || sellerReserved < quantityAtoms) insufficientInventory();
  const sellerInventoryUpdated = await executor.query(
    `update inventories set quantity=$3::numeric,reserved_quantity=$4::numeric,
       row_version=row_version+1,updated_state_revision=$5::bigint,updated_at=greatest(updated_at,$6)
     where world_id=$1 and id=$2 and row_version=$7::bigint`,
    [
      input.command.worldId,
      sellerInventory.id,
      formatQuantity(sellerQuantity - quantityAtoms, listing.quantity_scale),
      formatQuantity(sellerReserved - quantityAtoms, listing.quantity_scale),
      resultingStateRevision,
      input.decidedAt,
      sellerInventory.row_version,
    ],
  );
  if ((sellerInventoryUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Seller inventory changed during settlement.');
  }
  const buyerInventoryUpdated = await executor.query(
    `update inventories set quantity=$3::numeric,row_version=row_version+1,
       updated_state_revision=$4::bigint,updated_at=greatest(updated_at,$5)
     where world_id=$1 and id=$2 and row_version=$6::bigint`,
    [
      input.command.worldId,
      buyerInventory.id,
      formatQuantity(buyerQuantity + quantityAtoms, listing.quantity_scale),
      resultingStateRevision,
      input.decidedAt,
      buyerInventory.row_version,
    ],
  );
  if ((buyerInventoryUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Buyer inventory changed during settlement.');
  }
  await executor.query(
    `insert into inventory_movements(
       id,world_id,resource_type_id,from_inventory_id,to_inventory_id,quantity,movement_kind,
       source_type,source_id,source_ordinal,command_id,event_id,occurred_tick,state_revision,created_at
     ) values ($1,$2,$3,$4,$5,$6::numeric,'market_trade','market_trade',$7,0,$8,$9,$10::bigint,$11::bigint,$12)`,
    [
      movementId,
      input.command.worldId,
      listing.resource_type_id,
      sellerInventory.id,
      buyerInventory.id,
      payload.quantity,
      tradeId,
      input.command.commandId,
      inventoryEventId,
      context.clock.current_tick,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  const listingStatus = decision.status;
  const marketListingUpdated = await executor.query(
    `update market_listings set remaining_quantity=$3::numeric,reserved_quantity=$3::numeric,
       status=$4::market_listing_status,row_version=row_version+1,
       terminal_command_id=case when $4::market_listing_status='filled' then $5::uuid else null end,
       terminal_event_id=case when $4::market_listing_status='filled' then $6::uuid else null end,
       terminal_state_revision=case when $4::market_listing_status='filled' then $7::bigint else null end,
       terminal_at=case when $4::market_listing_status='filled' then $8::timestamptz else null end,
       updated_at=greatest(updated_at,$8::timestamptz)
     where world_id=$1 and id=$2 and status='open' and row_version=$9::bigint`,
    [
      input.command.worldId,
      listing.id,
      formatQuantity(decision.remainingAtoms, listing.quantity_scale),
      listingStatus,
      input.command.commandId,
      listingEventId,
      resultingStateRevision,
      input.decidedAt,
      payload.expectedListingVersion,
    ],
  );
  if ((marketListingUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Market listing changed during settlement.');
  }
  const marketReservationUpdated = await executor.query(
    `update inventory_reservations set
       quantity=case when $3::numeric=0 then quantity else $3::numeric end,
       status=case when $3::numeric=0
         then 'consumed'::inventory_reservation_status
         else 'active'::inventory_reservation_status
       end,
       row_version=row_version+1,
       terminal_command_id=case when $3::numeric=0 then $4::uuid else null end,
       terminal_event_id=case when $3::numeric=0 then $5::uuid else null end,
       terminal_state_revision=case when $3::numeric=0 then $6::bigint else null end,
       terminal_at=case when $3::numeric=0 then $7::timestamptz else null end,
       updated_at=greatest(updated_at,$7::timestamptz)
     where world_id=$1 and id=$2 and status='active'`,
    [
      input.command.worldId,
      reservation.id,
      formatQuantity(decision.remainingAtoms, listing.quantity_scale),
      input.command.commandId,
      listingEventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  if ((marketReservationUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Market inventory reservation changed during settlement.');
  }
  const taxMinor = decision.tax?.amountMinor ?? 0n;
  const feeMinor = decision.fee?.amountMinor ?? 0n;
  const buyerTotalMinor =
    decision.tax?.collectionMode === 'added_to_payer'
      ? decision.grossMinor + taxMinor
      : decision.grossMinor;
  const sellerNetMinor =
    decision.tax?.collectionMode === 'added_to_payer'
      ? decision.grossMinor - feeMinor
      : decision.grossMinor - taxMinor - feeMinor;
  await executor.query(
    `insert into market_trades(
       id,world_id,listing_id,buyer_entity_id,seller_entity_id,buyer_inventory_id,
       seller_inventory_id,quantity,unit_price_minor,gross_minor,buyer_total_minor,seller_net_minor,
       tax_minor,fee_minor,currency_id,wallet_transaction_id,occurred_tick,idempotency_key,command_id,
       event_id,state_revision,rounding_policy_version,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::bigint,$10::bigint,$11::bigint,$12::bigint,
       $13::bigint,$14::bigint,$15,$16,$17::bigint,$18,$19,$20,$21::bigint,1,$22)`,
    [
      tradeId,
      input.command.worldId,
      listing.id,
      buyerWallet.owner_entity_id,
      listing.seller_entity_id,
      buyerInventory.id,
      sellerInventory.id,
      payload.quantity,
      listing.unit_price_minor,
      decision.grossMinor.toString(),
      buyerTotalMinor.toString(),
      sellerNetMinor.toString(),
      taxMinor.toString(),
      feeMinor.toString(),
      listing.currency_id,
      financialTransactionId,
      context.clock.current_tick,
      input.command.idempotencyKey,
      input.command.commandId,
      tradeEventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  for (const item of assessments) {
    await executor.query(
      `insert into tax_assessments(
         id,world_id,policy_id,source_type,source_id,payer_entity_id,payer_wallet_id,
         treasury_wallet_id,currency_id,basis_minor,amount_minor,settlement_transaction_id,
         occurred_tick,command_id,event_id,state_revision,created_at
       ) values ($1,$2,$3,'market_trade',$4,$5,$6,$7,$8,$9::bigint,$10::bigint,$11,
         $12::bigint,$13,$14,$15::bigint,$16)`,
      [
        item.assessmentId,
        input.command.worldId,
        item.policy.id,
        tradeId,
        item.payerEntityId,
        item.payerWalletId,
        item.policy.treasury_wallet_id,
        listing.currency_id,
        item.assessment.basisMinor.toString(),
        item.assessment.amountMinor.toString(),
        financialTransactionId,
        context.clock.current_tick,
        input.command.commandId,
        item.eventId,
        resultingStateRevision,
        input.decidedAt,
      ],
    );
  }
  const coreChecksum = await advanceCoreEconomyHead(executor, input, resultingStateRevision);
  const commerceChecksum = await advanceCommerceHead(
    executor,
    input,
    context.head,
    resultingStateRevision,
  );
  const events: PlannedEconomyEvent[] = [
    event(inventoryEventId, movementId, 'inventory_movement', 'InventoryTransferredV1', {
      aggregateVersion: '1',
      fromInventoryId: sellerInventory.id,
      quantity: payload.quantity,
      resourceTypeId: listing.resource_type_id,
      tick: context.clock.current_tick,
      toInventoryId: buyerInventory.id,
      tradeId,
    }),
    event(
      listingEventId,
      listing.id,
      'market_listing',
      listingStatus === 'filled' ? 'MarketListingFilledV1' : 'MarketListingPartiallyFilledV1',
      {
        aggregateVersion: decision.listingVersion.toString(),
        listingId: listing.id,
        remainingQuantity: formatQuantity(decision.remainingAtoms, listing.quantity_scale),
        status: listingStatus,
        tick: context.clock.current_tick,
      },
    ),
    event(tradeEventId, tradeId, 'market_trade', 'MarketTradeCompletedV1', {
      aggregateVersion: '1',
      buyerTotalMinor: buyerTotalMinor.toString(),
      feeMinor: feeMinor.toString(),
      grossMinor: decision.grossMinor.toString(),
      listingId: listing.id,
      quantity: payload.quantity,
      sellerNetMinor: sellerNetMinor.toString(),
      taxMinor: taxMinor.toString(),
      tick: context.clock.current_tick,
      tradeId,
    }),
  ];
  for (const item of assessments) {
    events.push(
      event(item.eventId, item.assessmentId, 'tax_assessment', 'TaxAssessedV1', {
        aggregateVersion: '1',
        amountMinor: item.assessment.amountMinor.toString(),
        assessmentId: item.assessmentId,
        basisMinor: item.assessment.basisMinor.toString(),
        policyId: item.policy.id,
        sourceId: tradeId,
        tick: context.clock.current_tick,
      }),
    );
    if (item.treasuryEventId && item.assessment.amountMinor > 0n) {
      events.push(
        event(
          item.treasuryEventId,
          item.assessmentId,
          'tax_assessment',
          'TreasuryRevenueRecordedV1',
          {
            aggregateVersion: '2',
            amountMinor: item.assessment.amountMinor.toString(),
            assessmentId: item.assessmentId,
            tick: context.clock.current_tick,
            treasuryWalletId: item.policy.treasury_wallet_id,
          },
        ),
      );
    }
  }
  return {
    commerceChecksum,
    economyChecksum: coreChecksum,
    events,
    overrideId: null,
    participants: [
      participant(
        tradeEventId,
        'trade',
        'MARKET_TRADE_COMPLETED',
        listing.seller_entity_id,
        buyerWallet.owner_entity_id,
      ),
    ],
  };
}

async function reconcileWorldCommerce(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<PreparedEconomyCommand> {
  const payload = input.request.payload as ReconcileWorldCommercePayloadV1;
  const context = await lockCommerceContext(executor, input, 'reconcile');
  if (context.head.row_version !== payload.expectedExpansionVersion)
    aggregateConflict('Expansion head version changed.');
  const runId = ids.next();
  const eventId = ids.next();
  const opened = await executor.query<{
    opened_event_sequence: string;
    opened_state_revision: string;
  }>(
    `select opened_event_sequence::text,opened_state_revision::text
       from command_records where id=$1 and world_id=$2 for update`,
    [input.command.commandId, input.command.worldId],
  );
  const commandSnapshot = opened.rows[0];
  if (!commandSnapshot || commandSnapshot.opened_state_revision !== input.world.stateRevision) {
    aggregateConflict('Commerce reconciliation command snapshot changed.');
  }
  const result = await executor.query<{ snapshot: CommerceReconciliationSnapshot }>(
    `select worldgraph_reconcile_economy_expansion($1) as snapshot`,
    [input.command.worldId],
  );
  const snapshot = result.rows[0]?.snapshot;
  if (!snapshot) invalid('Commerce reconciliation snapshot is unavailable.');
  const checksum = Buffer.from(snapshot.projectionChecksum, 'hex');
  await executor.query(
    `insert into economy_expansion_reconciliation_runs(
       id,world_id,reconciliation_schema_version,source_state_revision,source_event_sequence,status,
       live_inventory_checksum,rebuilt_inventory_checksum,live_reservation_checksum,
       rebuilt_reservation_checksum,live_trade_checksum,rebuilt_trade_checksum,
       live_payroll_checksum,rebuilt_payroll_checksum,live_tax_checksum,rebuilt_tax_checksum,
       live_projection_checksum,rebuilt_journal_checksum,resource_count,inventory_count,
       trade_count,assessment_count,mismatch_count,command_id,event_id,created_at
     ) values ($1,$2,2,$3::bigint,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
       $16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [
      runId,
      input.command.worldId,
      commandSnapshot.opened_state_revision,
      commandSnapshot.opened_event_sequence,
      snapshot.matched ? 'matched' : 'mismatch',
      Buffer.from(snapshot.liveInventoryChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltInventoryChecksum, 'hex'),
      Buffer.from(snapshot.liveReservationChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltReservationChecksum, 'hex'),
      Buffer.from(snapshot.liveTradeChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltTradeChecksum, 'hex'),
      Buffer.from(snapshot.livePayrollChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltPayrollChecksum, 'hex'),
      Buffer.from(snapshot.liveTaxChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltTaxChecksum, 'hex'),
      Buffer.from(snapshot.liveProjectionChecksum, 'hex'),
      Buffer.from(snapshot.rebuiltJournalChecksum, 'hex'),
      snapshot.resourceCount,
      snapshot.inventoryCount,
      snapshot.tradeCount,
      snapshot.assessmentCount,
      snapshot.mismatchCount,
      input.command.commandId,
      eventId,
      input.decidedAt,
    ],
  );
  if (
    snapshot.itemCount !== snapshot.mismatchCount ||
    snapshot.items.length !== snapshot.itemCount ||
    snapshot.itemCount > 10_000
  ) {
    invalid('Commerce reconciliation mismatch evidence is internally inconsistent.');
  }
  if (snapshot.items.length > 0) {
    const inserted = await executor.query(
      `insert into economy_expansion_reconciliation_items(
         run_id,item_ordinal,item_kind,item_key,item_key_hash,
         expected_value,actual_value,mismatch_code
       )
       select $1,evidence.item_ordinal,evidence.item_kind,evidence.item_key,
              extensions.digest(convert_to(evidence.item_key,'UTF8'),'sha256'),
              evidence.expected_value,evidence.actual_value,evidence.mismatch_code
       from jsonb_to_recordset($2::jsonb) as evidence(
         item_ordinal integer,item_kind text,item_key text,
         expected_value text,actual_value text,mismatch_code text
       )
       order by evidence.item_ordinal`,
      [
        runId,
        JSON.stringify(
          snapshot.items.map((item) => ({
            actual_value: item.actualValue,
            expected_value: item.expectedValue,
            item_key: item.itemKey,
            item_kind: item.itemKind,
            item_ordinal: item.itemOrdinal,
            mismatch_code: item.mismatchCode,
          })),
        ),
      ],
    );
    if ((inserted.rowCount ?? 0) !== snapshot.itemCount) {
      invalid('Commerce reconciliation mismatch evidence could not be persisted exactly.');
    }
  }
  const nextVersion = increment(context.head.row_version);
  const headUpdated = await executor.query(
    `update world_economy_expansion_heads set checksum=$2,row_version=row_version+1,
       updated_state_revision=$3::bigint,reconciliation_status=$4,
       last_reconciliation_run_id=$5,last_reconciled_state_revision=$6::bigint,
       updated_at=greatest(updated_at,$7)
     where world_id=$1 and row_version=$8::bigint`,
    [
      input.command.worldId,
      checksum,
      resultingStateRevision,
      snapshot.matched ? 'current' : 'mismatch',
      runId,
      input.world.stateRevision,
      input.decidedAt,
      context.head.row_version,
    ],
  );
  if ((headUpdated.rowCount ?? 0) !== 1) {
    aggregateConflict('Closed-loop economy head changed during reconciliation.');
  }
  return prepared(
    [
      event(eventId, input.command.worldId, 'world_commerce', 'WorldCommerceReconciledV1', {
        aggregateVersion: nextVersion,
        checksum: snapshot.projectionChecksum,
        mismatchCount: snapshot.mismatchCount,
        reconciliationRunId: runId,
        status: snapshot.matched ? 'matched' : 'mismatch',
        tick: context.clock.current_tick,
      }),
    ],
    checksum,
  );
}

function lockCommerceContext(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  mode: 'must_exist',
): Promise<CommerceContext>;
function lockCommerceContext(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  mode: 'reconcile',
): Promise<CommerceContext>;
function lockCommerceContext(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  mode: 'must_not_exist',
): Promise<UninitializedCommerceContext>;
async function lockCommerceContext(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  mode: 'must_exist' | 'must_not_exist' | 'reconcile',
): Promise<CommerceContext | UninitializedCommerceContext> {
  const core = await executor.query<{
    checksum: Buffer;
    reconciliation_status: 'current' | 'failed' | 'mismatch' | 'pending';
    row_version: string;
  }>(
    `select checksum,reconciliation_status::text,row_version::text
       from world_economy_heads where world_id=$1 for update`,
    [input.command.worldId],
  );
  const coreHead = core.rows[0];
  if (!coreHead) {
    throw new EconomyCommandExecutionError(
      'ECONOMY_NOT_INITIALIZED',
      'The Milestone 8 monetary core must be initialized first.',
    );
  }
  if (!commerceReconciliationStatusAllowsWrite(coreHead.reconciliation_status, mode)) {
    disabled('Core economy writes are frozen until reconciliation is resolved.');
  }
  const headResult = await executor.query<CommerceHeadRow>(
    `select source_world_version_id,seed_plan_hash,checksum,row_version::text,
            updated_state_revision::text,reconciliation_status::text
       from world_economy_expansion_heads where world_id=$1 for update`,
    [input.command.worldId],
  );
  const clockResult = await executor.query<CommerceClockRow>(
    `select current_tick::text from world_simulation_clocks where world_id=$1 for update`,
    [input.command.worldId],
  );
  const clock = clockResult.rows[0];
  if (!clock) invalid('The authoritative simulation clock is unavailable.');
  const expectedTick = requiredExpectedTick(input);
  if (expectedTick !== clock.current_tick) {
    throw new EconomyCommandExecutionError(
      'EXPECTED_TICK_MISMATCH',
      'The authoritative tick changed.',
    );
  }
  const head = headResult.rows[0];
  if ((mode === 'must_exist' || mode === 'reconcile') && !head) {
    throw new EconomyCommandExecutionError(
      'ECONOMY_NOT_INITIALIZED',
      'Closed-loop production and commerce have not been initialized.',
    );
  }
  if (head && !commerceReconciliationStatusAllowsWrite(head.reconciliation_status, mode)) {
    disabled('Closed-loop economy writes are frozen until reconciliation is resolved.');
  }
  if (mode === 'must_not_exist' && head) {
    throw new EconomyCommandExecutionError(
      'ECONOMY_ALREADY_INITIALIZED',
      'Closed-loop production and commerce are already initialized.',
    );
  }
  if (head && input.request.expectedAggregateVersion !== head.row_version) {
    aggregateConflict('Closed-loop economy head version changed.');
  }
  if (!head && input.request.expectedAggregateVersion !== '0') {
    aggregateConflict('Uninitialized closed-loop economy must begin at version zero.');
  }
  return { clock, head: head ?? null };
}

async function currentCoreEconomyChecksum(
  executor: EconomySqlExecutor,
  worldId: string,
): Promise<Buffer> {
  const result = await executor.query<{ checksum: Buffer }>(
    `select checksum from world_economy_heads where world_id=$1`,
    [worldId],
  );
  const checksum = result.rows[0]?.checksum;
  if (!checksum || checksum.length !== 32) invalid('Core economy checksum is unavailable.');
  return checksum;
}

async function advanceCommerceHead(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  head: CommerceHeadRow,
  resultingStateRevision: string,
): Promise<Buffer> {
  const checksumResult = await executor.query<{ checksum: Buffer }>(
    `select worldgraph_economy_expansion_projection_checksum($1) as checksum`,
    [input.command.worldId],
  );
  const checksum = checksumResult.rows[0]?.checksum;
  if (!checksum || checksum.length !== 32)
    invalid('Closed-loop projection checksum is unavailable.');
  const updated = await executor.query(
    `update world_economy_expansion_heads set checksum=$2,row_version=row_version+1,
       updated_state_revision=$3::bigint,reconciliation_status='pending',
       last_reconciliation_run_id=null,last_reconciled_state_revision=null,
       updated_at=greatest(updated_at,$4)
     where world_id=$1 and row_version=$5::bigint`,
    [input.command.worldId, checksum, resultingStateRevision, input.decidedAt, head.row_version],
  );
  if ((updated.rowCount ?? 0) !== 1) aggregateConflict('Closed-loop economy head changed.');
  return checksum;
}

async function advanceCoreEconomyHead(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  resultingStateRevision: string,
): Promise<Buffer> {
  const checksumResult = await executor.query<{ checksum: Buffer }>(
    `select worldgraph_economy_projection_checksum($1) as checksum`,
    [input.command.worldId],
  );
  const checksum = checksumResult.rows[0]?.checksum;
  if (!checksum || checksum.length !== 32) invalid('Core economy checksum is unavailable.');
  const updated = await executor.query(
    `update world_economy_heads set checksum=$2,row_version=row_version+1,
       updated_state_revision=$3::bigint,reconciliation_status='pending',
       last_reconciliation_run_id=null,last_reconciled_state_revision=null,
       updated_at=greatest(updated_at,$4) where world_id=$1`,
    [input.command.worldId, checksum, resultingStateRevision, input.decidedAt],
  );
  if ((updated.rowCount ?? 0) !== 1) aggregateConflict('Core economy head changed.');
  return checksum;
}

async function lockEntity(
  executor: EconomySqlExecutor,
  worldId: string,
  logicalKey: string,
  actorId: string,
): Promise<EntityRow> {
  const result = await executor.query<EntityRow>(
    `select entity.id::text,entity.logical_key::text,entity.entity_type::text,
            coalesce(entity.state ->> 'name',entity.state ->> 'displayName') as display_name,
            worldgraph_user_controls_economy_entity_v1(
              entity.world_id,$3,entity.id
            ) as controlled_by_actor
       from world_entities entity
      where entity.world_id=$1 and entity.logical_key=$2 and entity.retired_world_version_id is null
      for update of entity`,
    [worldId, logicalKey, actorId],
  );
  const row = result.rows[0];
  if (!row) invalid('The referenced world entity was not found.');
  return row;
}

async function lockBusiness(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  businessId: string,
): Promise<BusinessRow> {
  const result = await executor.query<BusinessRow>(
    `select business.id::text,business.world_id::text,
            business.backing_organization_entity_id::text,business.wallet_id::text,
            business.status::text,business.row_version::text,
            worldgraph_user_controls_economy_entity_v1(
              business.world_id,$3,business.backing_organization_entity_id
            ) as controlled_by_actor
       from businesses business where business.world_id=$1 and business.id=$2
       for update of business`,
    [input.command.worldId, businessId, input.command.actorId],
  );
  const row = result.rows[0];
  if (!row) invalid('Business was not found.');
  return row;
}

async function lockWallet(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  walletId: string,
): Promise<WalletRow> {
  return (await lockWallets(executor, input, [walletId])).get(walletId)!;
}

async function readWallet(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  walletId: string,
): Promise<WalletRow> {
  const result = await executor.query<WalletRow>(
    `select wallet.id::text,wallet.currency_id::text,wallet.owner_entity_id::text,
            wallet.wallet_kind::text,wallet.status::text,
            wallet.row_version::text as wallet_row_version,balance.available_minor::text,
            balance.row_version::text as balance_row_version,
            worldgraph_user_controls_economy_entity_v1(
              wallet.world_id,$3,wallet.owner_entity_id
            ) as controlled_by_actor
       from wallets wallet join wallet_balances balance
         on balance.world_id=wallet.world_id and balance.wallet_id=wallet.id
      where wallet.world_id=$1 and wallet.id=$2`,
    [input.command.worldId, walletId, input.command.actorId],
  );
  const row = result.rows[0];
  if (!row) invalid('Wallet was not found.');
  return row;
}

async function lockWallets(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  walletIds: readonly string[],
): Promise<Map<string, WalletRow>> {
  const ids = [...new Set(walletIds)].sort();
  const result = await executor.query<WalletRow>(
    `select wallet.id::text,wallet.currency_id::text,wallet.owner_entity_id::text,
            wallet.wallet_kind::text,wallet.status::text,
            wallet.row_version::text as wallet_row_version,balance.available_minor::text,
            balance.row_version::text as balance_row_version,
            worldgraph_user_controls_economy_entity_v1(
              wallet.world_id,$3,wallet.owner_entity_id
            ) as controlled_by_actor
       from wallets wallet join wallet_balances balance
         on balance.world_id=wallet.world_id and balance.wallet_id=wallet.id
      where wallet.world_id=$1 and wallet.id=any($2::uuid[])
      order by wallet.id for update of wallet,balance`,
    [input.command.worldId, ids, input.command.actorId],
  );
  if (result.rows.length !== ids.length) invalid('One or more wallets were not found.');
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function lockFacility(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  facilityId: string,
): Promise<FacilityRow> {
  const result = await executor.query<FacilityRow>(
    `select facility.id::text,facility.business_id::text,facility.facility_asset_id::text,
            facility.status::text,facility.row_version::text,
            business.backing_organization_entity_id::text,
            worldgraph_user_controls_economy_entity_v1(
              facility.world_id,$3,business.backing_organization_entity_id
            ) as controlled_by_actor
       from business_facilities facility join businesses business
         on business.world_id=facility.world_id and business.id=facility.business_id
      where facility.world_id=$1 and facility.id=$2 for update of facility,business`,
    [input.command.worldId, facilityId, input.command.actorId],
  );
  const row = result.rows[0];
  if (!row) invalid('Business facility was not found.');
  if (!row.controlled_by_actor) forbidden('The facility business is not managed by the actor.');
  return row;
}

async function lockInventory(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  inventoryId: string,
): Promise<InventoryRow> {
  return (await lockInventories(executor, input, [inventoryId])).get(inventoryId)!;
}

async function lockInventories(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  inventoryIds: readonly string[],
): Promise<Map<string, InventoryRow>> {
  const ids = [...new Set(inventoryIds)].sort();
  const result = await executor.query<InventoryRow>(
    `${inventorySelect()}
      where inventory.world_id=$1 and inventory.id=any($2::uuid[])
      order by inventory.id
      for update of inventory`,
    [input.command.worldId, ids, input.command.actorId],
  );
  if (result.rows.length !== ids.length) invalid('One or more inventories were not found.');
  return new Map(result.rows.map((row) => [row.id, row]));
}

function inventorySelect(): string {
  return `select inventory.id::text,inventory.owner_entity_id::text,
          inventory.container_asset_id::text,inventory.resource_type_id::text,
          inventory.quantity::text,inventory.reserved_quantity::text,
          inventory.row_version::text,resource.quantity_scale,resource.unit_code::text,
          worldgraph_user_controls_economy_entity_v1(
            inventory.world_id,$3,inventory.owner_entity_id
          ) as controlled_by_actor
     from inventories inventory join resource_types resource
       on resource.world_id=inventory.world_id and resource.id=inventory.resource_type_id`;
}

async function lockContract(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  contractId: string,
): Promise<ContractRow> {
  const result = await executor.query<ContractRow>(
    `select contract.id::text,contract.business_id::text,contract.worker_entity_id::text,
            contract.employer_wallet_id::text,contract.worker_wallet_id::text,
            contract.wage_minor::text,contract.cooldown_ticks::text,
            contract.reward_cap_minor::text,contract.max_payments_per_period,
            contract.cadence_ticks::text,contract.effective_from_tick::text,
            contract.effective_until_tick::text,contract.status::text,contract.row_version::text,
            business.backing_organization_entity_id::text as employer_entity_id,
            worldgraph_user_controls_economy_entity_v1(
              contract.world_id,$3,contract.worker_entity_id
            ) as worker_controlled_by_actor
       from employment_contracts contract join businesses business
         on business.world_id=contract.world_id and business.id=contract.business_id
      where contract.world_id=$1 and contract.id=$2 for update of contract,business`,
    [input.command.worldId, contractId, input.command.actorId],
  );
  const row = result.rows[0];
  if (!row) invalid('Employment contract was not found.');
  return row;
}

async function lockListing(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  listingId: string,
): Promise<ListingRow> {
  const result = await executor.query<ListingRow>(
    `select listing.id::text,listing.world_id::text,listing.seller_entity_id::text,
            listing.seller_inventory_id::text,listing.resource_type_id::text,
            listing.seller_wallet_id::text,listing.currency_id::text,
            listing.remaining_quantity::text,listing.reserved_quantity::text,
            listing.unit_price_minor::text,listing.status::text,listing.expires_at_tick::text,
            listing.row_version::text,resource.quantity_scale,
            worldgraph_user_controls_economy_entity_v1(
              listing.world_id,$3,listing.seller_entity_id
            ) as seller_controlled_by_actor
       from market_listings listing join resource_types resource
         on resource.world_id=listing.world_id and resource.id=listing.resource_type_id
      where listing.world_id=$1 and listing.id=$2 for update of listing`,
    [input.command.worldId, listingId, input.command.actorId],
  );
  const row = result.rows[0];
  if (!row) invalid('Market listing was not found.');
  return row;
}

async function activeReservation(
  executor: EconomySqlExecutor,
  worldId: string,
  purposeType: 'market_listing' | 'production_input',
  purposeId: string,
): Promise<{
  action_type: 'CompleteProductionRunV1' | 'ExpireMarketListingV1' | 'SettlePayrollV1';
  due_tick: string;
  id: string;
  quantity: string;
  scheduled_action_id: string;
  schedule_sequence: string;
} | null> {
  const result = await executor.query<{
    action_type: 'CompleteProductionRunV1' | 'ExpireMarketListingV1' | 'SettlePayrollV1';
    due_tick: string;
    id: string;
    quantity: string;
    scheduled_action_id: string;
    schedule_sequence: string;
  }>(
    `select reservation.id::text,reservation.quantity::text,
            coalesce(listing.scheduled_action_id,run.scheduled_action_id)::text
            as scheduled_action_id,action.action_type::text,action.due_tick::text,
            action.schedule_sequence::text
       from inventory_reservations reservation
       left join market_listings listing on reservation.purpose_type='market_listing'
        and listing.world_id=reservation.world_id and listing.id=reservation.purpose_id
       left join production_runs run on reservation.purpose_type='production_input'
        and run.world_id=reservation.world_id and run.id=reservation.purpose_id
       join scheduled_actions action on action.world_id=reservation.world_id
        and action.id=coalesce(listing.scheduled_action_id,run.scheduled_action_id)
      where reservation.world_id=$1 and reservation.purpose_type=$2
        and reservation.purpose_id=$3 and reservation.status='active'
      order by reservation.inventory_id for update of reservation`,
    [worldId, purposeType, purposeId],
  );
  return result.rows[0] ?? null;
}

async function loadRecipe(
  executor: EconomySqlExecutor,
  worldId: string,
  facilityId: string,
  recipeVersionId: string,
): Promise<RecipeRow> {
  const result = await executor.query<RecipeRow>(
    `select version.id::text,version.recipe_id::text,version.version,
            version.duration_ticks::text,version.canonical_inputs,version.canonical_outputs,
            version.facility_requirements ->> 'assetType' as facility_asset_type,version.checksum
       from production_recipe_versions version
       join business_facility_recipe_versions capability
         on capability.world_id=version.world_id and capability.recipe_version_id=version.id
      where version.world_id=$1 and capability.facility_id=$2 and version.id=$3`,
    [worldId, facilityId, recipeVersionId],
  );
  const row = result.rows[0];
  if (!row) invalid('Recipe is not enabled for this facility.');
  return row;
}

async function lockProductionInventories(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  business: BusinessRow,
  facility: FacilityRow,
  recipe: RecipeRow,
): Promise<Map<string, InventoryRow>> {
  const resourceIds = recipe.canonical_inputs.map((item) => item.resourceTypeId).sort();
  const result = await executor.query<InventoryRow>(
    `${inventorySelect()}
      where inventory.world_id=$1 and inventory.owner_entity_id=$4
        and inventory.container_asset_id=$5
        and inventory.resource_type_id=any($2::uuid[])
      order by inventory.id for update of inventory`,
    [
      input.command.worldId,
      resourceIds,
      input.command.actorId,
      business.backing_organization_entity_id,
      facility.facility_asset_id,
    ],
  );
  if (result.rows.length !== resourceIds.length) insufficientInventory();
  return new Map(result.rows.map((row) => [row.resource_type_id, row]));
}

async function resourceScales(
  executor: EconomySqlExecutor,
  worldId: string,
  resourceIds: readonly string[],
): Promise<Map<string, number>> {
  const result = await executor.query<{ id: string; quantity_scale: number }>(
    `select id::text,quantity_scale from resource_types
      where world_id=$1 and id=any($2::uuid[]) order by id`,
    [worldId, [...new Set(resourceIds)].sort()],
  );
  const map = new Map(result.rows.map((row) => [row.id, row.quantity_scale]));
  if (map.size !== new Set(resourceIds).size) invalid('Recipe output resource is unavailable.');
  return map;
}

async function activeTaxPolicy(
  executor: EconomySqlExecutor,
  worldId: string,
  taxType: 'marketplace_fee' | 'payroll' | 'sales',
  tick: string,
  disabledTaxPolicyIds: readonly string[],
): Promise<TaxPolicyRow | null> {
  const result = await executor.query<TaxPolicyRow>(
    `select id::text,tax_type::text,collection_mode::text,rate_basis_points,
            fixed_amount_minor::text,rounding_mode::text,treasury_wallet_id::text
       from tax_policies where world_id=$1 and tax_type=$2 and status='active'
        and effective_from_tick <= $3::bigint
        and (effective_until_tick is null or effective_until_tick > $3::bigint)
        and not (id = any($4::uuid[]))
      order by policy_version desc,id limit 1`,
    [worldId, taxType, tick, disabledTaxPolicyIds],
  );
  const policy = result.rows[0] ?? null;
  return policy && taxPolicyIsEnabled(policy.id, disabledTaxPolicyIds) ? policy : null;
}

async function activeMarketTaxPolicy(
  executor: EconomySqlExecutor,
  worldId: string,
  tick: string,
  disabledTaxPolicyIds: readonly string[],
): Promise<TaxPolicyRow | null> {
  const result = await executor.query<TaxPolicyRow>(
    `select id::text,tax_type::text,collection_mode::text,rate_basis_points,
            fixed_amount_minor::text,rounding_mode::text,treasury_wallet_id::text
      from tax_policies where world_id=$1 and tax_type in ('sales','transaction')
        and status='active' and effective_from_tick <= $2::bigint
        and (effective_until_tick is null or effective_until_tick > $2::bigint)
        and not (id = any($3::uuid[]))
      order by case tax_type when 'sales' then 0 else 1 end,policy_version desc,id
      limit 1`,
    [worldId, tick, disabledTaxPolicyIds],
  );
  const policy = result.rows[0] ?? null;
  return policy && taxPolicyIsEnabled(policy.id, disabledTaxPolicyIds) ? policy : null;
}

export function taxPolicyIsEnabled(
  policyId: string,
  disabledTaxPolicyIds: readonly string[],
): boolean {
  const normalizedPolicyId = policyId.toLowerCase();
  return !disabledTaxPolicyIds.some(
    (disabledPolicyId) => disabledPolicyId.toLowerCase() === normalizedPolicyId,
  );
}

async function findInventoryId(
  executor: EconomySqlExecutor,
  worldId: string,
  ownerEntityId: string,
  resourceTypeId: string,
): Promise<string | null> {
  const result = await executor.query<{ id: string }>(
    `select id::text from inventories
      where world_id=$1 and owner_entity_id=$2 and resource_type_id=$3
        and container_asset_id is null
      order by id limit 1`,
    [worldId, ownerEntityId, resourceTypeId],
  );
  return result.rows[0]?.id ?? null;
}

async function createBuyerInventory(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  listing: ListingRow,
  buyerEntityId: string,
  resultingStateRevision: string,
  createdEventId: string,
): Promise<InventoryRow> {
  const inventoryId = createDeterministicUuid(
    `${input.command.worldId}:inventory:${buyerEntityId}:${listing.resource_type_id}:root`,
  );
  await executor.query(
    `insert into inventories(
       id,world_id,stable_key,owner_entity_id,container_asset_id,resource_type_id,
       quantity,reserved_quantity,inventory_schema_version,row_version,updated_state_revision,
       created_command_id,created_event_id,created_at,updated_at
     ) values ($1,$2,$3,$4,null,$5,0,0,1,1,$6::bigint,$7,$8,$9,$9)`,
    [
      inventoryId,
      input.command.worldId,
      `inventory:${buyerEntityId}:${listing.resource_type_id}:root`,
      buyerEntityId,
      listing.resource_type_id,
      resultingStateRevision,
      input.command.commandId,
      createdEventId,
      input.decidedAt,
    ],
  );
  return {
    container_asset_id: null,
    controlled_by_actor: true,
    id: inventoryId,
    owner_entity_id: buyerEntityId,
    quantity: formatQuantity(0n, listing.quantity_scale),
    quantity_scale: listing.quantity_scale,
    reserved_quantity: formatQuantity(0n, listing.quantity_scale),
    resource_type_id: listing.resource_type_id,
    row_version: '1',
    unit_code: '',
  };
}

function validateBuyerInventory(
  payload: PurchaseMarketListingPayloadV1,
  listing: ListingRow,
  buyerEntityId: string,
  inventory: InventoryRow,
): void {
  if (
    !inventory.controlled_by_actor ||
    inventory.owner_entity_id !== buyerEntityId ||
    inventory.resource_type_id !== listing.resource_type_id
  ) {
    aggregateConflict('Buyer inventory owner or resource changed.');
  }
  if (payload.buyerInventoryId) {
    if (
      payload.expectedBuyerInventoryVersion === null ||
      inventory.row_version !== payload.expectedBuyerInventoryVersion
    ) {
      aggregateConflict('Buyer inventory version changed.');
    }
  } else if (payload.expectedBuyerInventoryVersion !== null) {
    invalid('An automatically selected buyer inventory cannot have an expected version.');
  }
}

async function applyWalletSettlement(
  executor: EconomySqlExecutor,
  ids: IdGenerator,
  input: CommerceCommandExecutionInput,
  transactionId: string,
  eventId: string,
  currencyId: string,
  postings: readonly EconomyPosting[],
  wallets: ReadonlyMap<string, WalletRow>,
  balances: ReadonlyMap<string, bigint>,
  tick: string,
  resultingStateRevision: string,
): Promise<void> {
  await executor.query(
    `insert into financial_transactions(
       id,world_id,currency_id,transaction_kind,supply_delta_minor,occurred_tick,
       command_id,event_id,memo_code,memo_text,state_revision,created_at
     ) values ($1,$2,$3,'market_purchase',0,$4::bigint,$5,$6,'market_purchase',null,
       $7::bigint,$8)`,
    [
      transactionId,
      input.command.worldId,
      currencyId,
      tick,
      input.command.commandId,
      eventId,
      resultingStateRevision,
      input.decidedAt,
    ],
  );
  for (const [ordinal, posting] of postings.entries()) {
    await executor.query(
      `insert into wallet_postings(
         id,world_id,transaction_id,posting_ordinal,wallet_id,currency_id,
         signed_amount_minor,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7::bigint,$8)`,
      [
        ids.next(),
        input.command.worldId,
        transactionId,
        ordinal,
        posting.walletId,
        currencyId,
        posting.signedAmountMinor.toString(),
        input.decidedAt,
      ],
    );
    const updated = await executor.query(
      `update wallet_balances set available_minor=$3::bigint,row_version=row_version+1,
         updated_state_revision=$4::bigint,updated_at=greatest(updated_at,$5)
       where world_id=$1 and wallet_id=$2 and row_version=$6::bigint`,
      [
        input.command.worldId,
        posting.walletId,
        balances.get(posting.walletId)!.toString(),
        resultingStateRevision,
        input.decidedAt,
        wallets.get(posting.walletId)!.balance_row_version,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) aggregateConflict('Wallet balance changed.');
  }
}

async function currentSupply(
  executor: EconomySqlExecutor,
  worldId: string,
  currencyId: string,
): Promise<bigint> {
  const result = await executor.query<{ current_supply_minor: string }>(
    `select current_supply_minor::text from currency_supply
      where world_id=$1 and currency_id=$2 for share`,
    [worldId, currencyId],
  );
  const value = result.rows[0]?.current_supply_minor;
  if (!value) invalid('Currency supply is unavailable.');
  return BigInt(value);
}

export async function assertCommerceScheduleCapacity(
  executor: EconomySqlExecutor,
  worldId: string,
  dueTick: bigint,
): Promise<void> {
  const result = await executor.query<{ tick_count: string; world_count: string }>(
    `select count(*)::text as world_count,
            count(*) filter (where due_tick=$2::bigint)::text as tick_count
       from scheduled_actions
      where world_id=$1 and status='scheduled'`,
    [worldId, dueTick.toString()],
  );
  const row = result.rows[0];
  if (
    !row ||
    !/^(?:0|[1-9][0-9]*)$/u.test(row.world_count) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(row.tick_count)
  ) {
    invalid('Scheduled action capacity is unavailable.');
  }
  if (
    BigInt(row.world_count) >= BigInt(MAX_SCHEDULED_ACTIONS_PER_WORLD) ||
    BigInt(row.tick_count) >= BigInt(MAX_SCHEDULED_ACTIONS_PER_TICK)
  ) {
    throw new EconomyCommandExecutionError(
      'SIMULATION_BUDGET_EXCEEDED',
      'The active scheduled action budget has been reached.',
    );
  }
}

async function insertScheduledAction(
  executor: EconomySqlExecutor,
  input: {
    actionType:
      | 'AssessPeriodicTaxV1'
      | 'CompleteProductionRunV1'
      | 'ExpireMarketListingV1'
      | 'SettlePayrollV1';
    actorId: string;
    actorType: 'platform_admin' | 'user';
    commandId: string;
    decidedAt: Date;
    dueTick: bigint;
    eventId: string;
    id: string;
    payload: Record<string, string>;
    resultingStateRevision: string;
    worldId: string;
  },
): Promise<PlannedEconomyEvent> {
  await assertCommerceScheduleCapacity(executor, input.worldId, input.dueTick);
  const sequence = await executor.query<{ sequence: string }>(
    `select worldgraph_allocate_schedule_sequence($1)::text as sequence`,
    [input.worldId],
  );
  const scheduleSequence = sequence.rows[0]?.sequence;
  if (!scheduleSequence) invalid('Schedule sequence is unavailable.');
  const payloadHash = createHash('sha256').update(canonicalJson(input.payload)).digest();
  await executor.query(
    `insert into scheduled_actions(
       id,world_id,schedule_sequence,due_tick,priority,action_type,action_schema_version,
       payload,payload_hash,process_version,created_by_actor_type,created_by_actor_id,
       created_command_id,created_state_revision,created_at,updated_at
     ) values ($1,$2,$3::bigint,$4::bigint,50,$5,1,$6,$7,'1.0.0',$8,$9,$10,$11::bigint,$12,$12)`,
    [
      input.id,
      input.worldId,
      scheduleSequence,
      input.dueTick.toString(),
      input.actionType,
      JSON.stringify(input.payload),
      payloadHash,
      input.actorType,
      input.actorId,
      input.commandId,
      input.resultingStateRevision,
      input.decidedAt,
    ],
  );
  return event(input.eventId, input.id, 'scheduled_action', 'ScheduledActionCreatedV1', {
    actionSchemaVersion: 1,
    actionType: input.actionType,
    dueTick: input.dueTick.toString(),
    payload: input.payload,
    payloadHash: payloadHash.toString('hex'),
    priority: 50,
    processVersion: '1.0.0',
    scheduleId: input.id,
    scheduleSequence,
  });
}

export async function enforceCommercePolicy(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
): Promise<void> {
  const type = input.request.type;
  if (type === PERFORM_JOB_COMMAND && !commerceFeatureIsEnabled(type, input.policy))
    disabled('Job rewards are disabled.');
  if (type === START_PRODUCTION_RUN_COMMAND && !commerceFeatureIsEnabled(type, input.policy)) {
    disabled('Production scheduling is disabled.');
  }
  if (type === CREATE_MARKET_LISTING_COMMAND && !commerceFeatureIsEnabled(type, input.policy)) {
    disabled('New listings are disabled.');
  }
  if (type === PURCHASE_MARKET_LISTING_COMMAND && !commerceFeatureIsEnabled(type, input.policy)) {
    disabled('Marketplace purchases are disabled.');
  }
  const limit =
    type === PERFORM_JOB_COMMAND
      ? input.policy.workRateLimitPerMinute
      : type === START_PRODUCTION_RUN_COMMAND
        ? input.policy.productionRateLimitPerMinute
        : type === CREATE_MARKET_LISTING_COMMAND
          ? input.policy.listingRateLimitPerMinute
          : type === PURCHASE_MARKET_LISTING_COMMAND
            ? input.policy.purchaseRateLimitPerMinute
            : null;
  if (limit === null) return;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RATE_WINDOW_COUNT) {
    throw new Error('COMMERCE_RATE_LIMIT_CONFIGURATION_INVALID');
  }
  if (
    !Buffer.isBuffer(input.command.rateLimitScopeHash) ||
    input.command.rateLimitScopeHash.byteLength !== 32
  ) {
    throw new Error('COMMERCE_RATE_LIMIT_SCOPE_INVALID');
  }
  const usage = await executor.query<{ command_count: string }>(
    `select count(*)::text as command_count from command_records
      where world_id=$1 and actor_type=$2 and actor_id=$3 and command_type=$4 and id<>$5
        and rate_limit_scope_hash=$6
        and requested_at >= $7::timestamptz - interval '1 minute'
        and requested_at <= $7::timestamptz`,
    [
      input.command.worldId,
      input.command.actorType,
      input.command.actorId,
      type,
      input.command.commandId,
      input.command.rateLimitScopeHash,
      input.decidedAt,
    ],
  );
  if (Number(usage.rows[0]?.command_count ?? '0') >= limit) {
    throw new ApplicationError('RATE_LIMITED', 'Commerce command velocity limit was reached.', 429);
  }
}

/**
 * Operational creation flags must never strand already-committed obligations.
 * In particular, disabling new listings still permits cancellation/expiry so
 * their inventory reservations can be released safely.
 */
export function commerceFeatureIsEnabled(
  commandType: string,
  policy: CommerceCommandExecutionInput['policy'],
): boolean {
  switch (commandType) {
    case PERFORM_JOB_COMMAND:
      return policy.jobsEnabled;
    case START_PRODUCTION_RUN_COMMAND:
      return policy.productionEnabled;
    case CREATE_MARKET_LISTING_COMMAND:
      return policy.listingsEnabled;
    case PURCHASE_MARKET_LISTING_COMMAND:
      return policy.purchasesEnabled;
    default:
      return true;
  }
}

async function requireManagerOrWorldAdministrator(
  executor: EconomySqlExecutor,
  input: CommerceCommandExecutionInput,
  controlled: boolean,
): Promise<void> {
  if (controlled) return;
  const result = await executor.query<{ role: string }>(
    `select role::text from world_memberships
      where world_id=$1 and user_id=$2 and status='active'`,
    [input.command.worldId, input.command.actorId],
  );
  if (!['administrator', 'creator'].includes(result.rows[0]?.role ?? '')) {
    forbidden('Business creation requires organization control or world management authority.');
  }
}

function requireBusinessVersionAndControl(business: BusinessRow, expectedVersion: string): void {
  if (!business.controlled_by_actor) forbidden('The business is not managed by the actor.');
  if (business.status !== 'active') conflict('The business is not active.');
  if (business.row_version !== expectedVersion) aggregateConflict('Business version changed.');
}

function contractState(row: ContractRow): EmploymentContractState {
  return {
    activeFromTick: BigInt(row.effective_from_tick),
    activeUntilTick: BigInt(row.effective_until_tick),
    cooldownTicks: BigInt(row.cooldown_ticks),
    employerWalletId: row.employer_wallet_id,
    id: row.id,
    maxPerformancesPerPeriod: row.max_payments_per_period,
    periodTicks: BigInt(row.cadence_ticks),
    rowVersion: BigInt(row.row_version),
    status: row.status,
    wageMinor: BigInt(row.wage_minor),
    workerWalletId: row.worker_wallet_id,
  };
}

function taxPolicyState(row: TaxPolicyRow): TaxPolicyState {
  const taxType = row.tax_type === 'periodic_flat' ? 'flat_periodic' : row.tax_type;
  return {
    basisPoints: row.rate_basis_points,
    collectionMode: row.collection_mode,
    fixedMinor: row.fixed_amount_minor === null ? null : BigInt(row.fixed_amount_minor),
    id: row.id,
    roundingMode: row.rounding_mode,
    status: 'active',
    taxType,
    treasuryWalletId: row.treasury_wallet_id,
  };
}

function listingState(row: ListingRow): MarketListingState {
  return {
    currencyId: row.currency_id,
    expiresAtTick: BigInt(row.expires_at_tick),
    id: row.id,
    quantityScale: row.quantity_scale,
    remainingAtoms: parseDatabaseQuantity(row.remaining_quantity, row.quantity_scale),
    rowVersion: BigInt(row.row_version),
    sellerEntityId: row.seller_entity_id,
    sellerWalletId: row.seller_wallet_id,
    status: row.status,
    unitPriceMinor: BigInt(row.unit_price_minor),
    worldId: row.world_id,
  };
}

export function marketSelfTradeAttempt(input: {
  buyerEntityId: string;
  buyerWalletControlled: boolean;
  sellerControlledByActor: boolean;
  sellerEntityId: string;
}): boolean {
  return (
    input.buyerWalletControlled &&
    (input.buyerEntityId === input.sellerEntityId || input.sellerControlledByActor)
  );
}

function inventoryState(row: InventoryRow): InventoryState {
  return {
    id: row.id,
    quantityAtoms: parseDatabaseQuantity(row.quantity, row.quantity_scale),
    reservedAtoms: parseDatabaseQuantity(row.reserved_quantity, row.quantity_scale),
    rowVersion: BigInt(row.row_version),
  };
}

function recipeStateFromRows(
  row: RecipeRow,
  scales: ReadonlyMap<string, number>,
): ProductionRecipeVersionState {
  const parse = (item: { quantity: string; resourceTypeId: string }, scale: number) => ({
    quantityAtoms: parseCanonicalQuantity(item.quantity, scale, { positive: true }),
    resourceTypeId: item.resourceTypeId,
  });
  const input = {
    durationTicks: BigInt(row.duration_ticks),
    inputs: row.canonical_inputs.map((item) =>
      parse(item, requiredScale(scales, item.resourceTypeId)),
    ),
    outputs: row.canonical_outputs.map((item) =>
      parse(item, requiredScale(scales, item.resourceTypeId)),
    ),
    recipeId: row.recipe_id,
    version: row.version,
  };
  return input;
}

export function parseDatabaseQuantity(value: string, scale: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  const excess = fraction.slice(scale);
  if (/[1-9]/u.test(excess)) invalid('Database quantity exceeds its declared scale.');
  const declaredFraction = fraction.slice(0, scale).padEnd(scale, '0');
  const canonical = scale === 0 ? whole! : `${whole!}.${declaredFraction}`;
  return parseCanonicalQuantity(canonical, scale);
}

function requiredScale(scales: ReadonlyMap<string, number>, resourceTypeId: string): number {
  const scale = scales.get(resourceTypeId);
  if (scale === undefined) invalid('Recipe resource scale is unavailable.');
  return scale;
}

function prepared(
  events: PlannedEconomyEvent[],
  commerceChecksum: Buffer,
  participants: ParticipantPlan[] = [],
): PreparedEconomyCommand {
  return { commerceChecksum, economyChecksum: null, events, overrideId: null, participants };
}

function event(
  eventId: string,
  aggregateId: string,
  aggregateType: string,
  eventType: PlannedEconomyEvent['eventType'],
  payload: Record<string, JsonValue>,
): PlannedEconomyEvent {
  return { aggregateId, aggregateType, eventId, eventType, payload };
}

function participant(
  eventId: string,
  category: ParticipantPlan['category'],
  summaryCode: string,
  firstEntityId: string,
  secondEntityId: string | null,
): ParticipantPlan {
  return {
    category,
    entities: [
      { counterpartyEntityId: secondEntityId, entityId: firstEntityId },
      ...(secondEntityId
        ? [{ counterpartyEntityId: firstEntityId, entityId: secondEntityId }]
        : []),
    ],
    eventId,
    summaryArgs: {},
    summaryCode,
  };
}

function requiredExpectedTick(input: CommerceCommandExecutionInput): string {
  const tick = input.request.expectedTick;
  if (tick === undefined) invalid('Commerce commands require the authoritative expected tick.');
  return tick;
}

function createDeterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function replaceStableKeyNamespace(stableKey: string, namespace: string): string {
  const separator = stableKey.indexOf(':');
  if (separator < 1) invalid('Stable key has no namespace.');
  return `${namespace}:${stableKey.slice(separator + 1)}`;
}

function hashHex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function increment(value: string): string {
  return (BigInt(value) + 1n).toString();
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
}

function entityDisplayName(value: string | null): string {
  const normalized = value?.trim();
  const containsControl = normalized
    ? [...normalized].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    : false;
  if (!normalized || normalized.length > 100 || containsControl) {
    invalid('The backing organization has no safe display name.');
  }
  return normalized;
}

function disabled(message: string): never {
  throw new EconomyCommandExecutionError('COMMAND_TYPE_DISABLED', message);
}

function invalid(message: string): never {
  throw new EconomyCommandExecutionError('VALIDATION_FAILED', message);
}

function forbidden(message: string): never {
  throw new EconomyCommandExecutionError('AUTHORIZATION_DENIED', message);
}

function conflict(message: string): never {
  throw new EconomyCommandExecutionError('CONFLICT', message);
}

function aggregateConflict(message: string): never {
  throw new EconomyCommandExecutionError('AGGREGATE_VERSION_CONFLICT', message);
}

function contractConflict(message: string): never {
  throw new EconomyDomainError('CONTRACT_STATE_INVALID', message);
}

function policyInvalid(message: string): never {
  throw new EconomyDomainError('POLICY_INVALID', message);
}

function listingStale(): never {
  throw new EconomyDomainError('LISTING_STALE', 'Market listing version changed.');
}

function listingNotOpen(): never {
  throw new EconomyDomainError('LISTING_NOT_OPEN', 'Market listing is not open.');
}

function insufficientInventory(): never {
  throw new EconomyDomainError('INSUFFICIENT_INVENTORY', 'Inventory is insufficient.');
}

function currencyMismatch(): never {
  throw new EconomyDomainError('CURRENCY_MISMATCH', 'Wallet currency does not match the listing.');
}
