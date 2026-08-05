import type { QueryResult, QueryResultRow } from 'pg';

import type {
  BusinessFacilityViewV1,
  BusinessViewV1,
  CommerceTransactionSummaryViewV1,
  EmploymentContractViewV1,
  InventoryViewV1,
  MarketListingViewV1,
  MarketTradeViewV1,
  ProductionRecipeVersionViewV1,
  ProductionRunViewV1,
  ResourceTypeViewV1,
  TaxAssessmentViewV1,
  TreasurySummaryViewV1,
  WorldRole,
} from '@worldgraph/contracts';

import type {
  CommerceReconciliationSummaryV1,
  EmploymentCandidateViewV1,
  EmploymentOfferViewV1,
  JobRecordViewV1,
} from './commerce-read-contracts.js';

export interface CommerceReadExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface CommerceProjectionMeta {
  checkpointVersion: string;
  currentStateRevision: string;
  lagRevisions: string;
  status: 'catching_up' | 'current' | 'failed' | 'mismatch';
}

export interface CommerceReadPage<T> {
  items: T[];
  positions: string[];
  projection: CommerceProjectionMeta;
}

interface ReadContextRow extends QueryResultRow {
  checkpoint_version: string;
  current_state_revision: string;
  reconciliation_status: 'current' | 'failed' | 'mismatch' | 'pending';
  role: WorldRole;
}

export interface CommerceReadContext {
  projection: CommerceProjectionMeta;
  role: WorldRole;
}

interface ResourceRow extends QueryResultRow {
  created_state_revision: string;
  display_name: string;
  id: string;
  primitive_content_hash: Buffer;
  primitive_version_id: string;
  quantity_scale: number;
  stable_key: string;
  status: ResourceTypeViewV1['status'];
  unit_code: string;
  world_id: string;
}

interface RecipeRow extends QueryResultRow {
  canonical_inputs: ProductionRecipeVersionViewV1['inputs'];
  canonical_outputs: ProductionRecipeVersionViewV1['outputs'];
  checksum: Buffer;
  duration_ticks: string;
  facility_asset_type: string;
  id: string;
  recipe_id: string;
  stable_key: string;
  version: number;
  world_id: string;
}

interface InventoryRow extends QueryResultRow {
  available_quantity: string;
  container_asset_id: string | null;
  container_entity_key: string | null;
  controlled_by_actor: boolean;
  id: string;
  owner_entity_key: string;
  quantity: string;
  reserved_quantity: string;
  resource_created_state_revision: string;
  resource_display_name: string;
  resource_id: string;
  resource_primitive_content_hash: Buffer;
  resource_primitive_version_id: string;
  resource_quantity_scale: number;
  resource_stable_key: string;
  resource_status: ResourceTypeViewV1['status'];
  resource_unit_code: string;
  row_version: string;
  stable_key: string;
  updated_state_revision: string;
  world_id: string;
}

interface BusinessRow extends QueryResultRow {
  backing_organization_entity_key: string;
  can_manage: boolean;
  id: string;
  row_version: string;
  stable_key: string;
  status: BusinessViewV1['status'];
  wallet_id: string;
  world_id: string;
}

interface FacilityRow extends QueryResultRow {
  business_id: string;
  facility_asset_id: string;
  id: string;
  recipe_version_ids: string[];
  row_version: string;
  stable_key: string;
  status: BusinessFacilityViewV1['status'];
  world_id: string;
}

interface OfferRow extends QueryResultRow {
  business_id: string;
  cadence_ticks: string;
  currency_id: string;
  id: string;
  max_payments_per_period: number;
  role_code: string;
  row_version: string;
  stable_key: string;
  status: EmploymentOfferViewV1['status'];
  wage_minor: string;
  world_id: string;
}

interface EmploymentCandidateRow extends QueryResultRow {
  business_id: string;
  currency_id: string;
  worker_entity_key: string;
  worker_wallet_id: string;
}

interface ContractRow extends QueryResultRow {
  business_id: string;
  can_manage: boolean;
  can_work: boolean;
  effective_from_tick: string;
  effective_until_tick: string | null;
  id: string;
  role_code: string;
  row_version: string;
  stable_key: string;
  status: EmploymentContractViewV1['status'];
  wage_minor: string;
  worker_entity_key: string;
  world_id: string;
}

interface JobRow extends QueryResultRow {
  contract_id: string;
  gross_minor: string;
  id: string;
  payroll_error_code: string | null;
  payroll_gross_minor: string | null;
  payroll_id: string | null;
  payroll_net_minor: string | null;
  payroll_row_version: string | null;
  payroll_status: JobRecordViewV1['payroll'] extends { status: infer T } ? T : never;
  payroll_tax_minor: string | null;
  performed_tick: string;
  world_id: string;
}

interface ProductionRunRow extends QueryResultRow {
  business_id: string;
  due_tick: string;
  facility_id: string;
  failure_code: string | null;
  id: string;
  input_snapshot: ProductionRunViewV1['inputSnapshot'];
  output_snapshot: ProductionRunViewV1['outputSnapshot'];
  quantity: string;
  recipe_version_id: string;
  row_version: string;
  status: ProductionRunViewV1['status'];
  world_id: string;
}

interface ListingRow extends QueryResultRow {
  can_cancel: boolean;
  currency_id: string;
  expires_at_tick: string;
  id: string;
  offered_quantity: string;
  remaining_quantity: string;
  resource_created_state_revision: string;
  resource_display_name: string;
  resource_id: string;
  resource_primitive_content_hash: Buffer;
  resource_primitive_version_id: string;
  resource_quantity_scale: number;
  resource_stable_key: string;
  resource_status: ResourceTypeViewV1['status'];
  resource_unit_code: string;
  row_version: string;
  seller_entity_key: string;
  status: MarketListingViewV1['status'];
  unit_price_minor: string;
  world_id: string;
}

interface TradeRow extends QueryResultRow {
  buyer_total_minor: string;
  created_at: Date;
  fee_minor: string;
  gross_minor: string;
  id: string;
  listing_id: string;
  occurred_tick: string;
  quantity: string;
  seller_net_minor: string;
  tax_minor: string;
  unit_price_minor: string;
  world_id: string;
}

interface TaxRow extends QueryResultRow {
  amount_minor: string;
  basis_minor: string;
  created_at: Date;
  id: string;
  occurred_tick: string;
  policy_id: string;
  source_id: string;
  source_type: TaxAssessmentViewV1['sourceType'];
  world_id: string;
}

interface CommerceTransactionRow extends QueryResultRow {
  amount_minor: string | null;
  basis_minor: string | null;
  buyer_total_minor: string | null;
  created_at: Date;
  currency_id: string;
  fee_minor: string | null;
  gross_minor: string | null;
  id: string;
  market_trade_id: string | null;
  net_minor: string | null;
  occurred_tick: string;
  payroll_record_id: string | null;
  seller_net_minor: string | null;
  tax_assessment_id: string | null;
  tax_minor: string | null;
  transaction_kind: CommerceTransactionSummaryViewV1['kind'];
  world_id: string;
}

interface TreasuryRow extends QueryResultRow {
  balance_minor: string;
  currency_id: string;
  last_revenue_tick: string | null;
  revenue_minor: string;
  treasury_wallet_id: string;
  world_id: string;
}

export interface PurchasePreviewSource {
  collectionMode: 'added_to_payer' | 'withheld_from_recipient' | null;
  currencyId: string;
  currentTick: string;
  expiresAtTick: string;
  fixedAmountMinor: string | null;
  feeCollectionMode: 'added_to_payer' | 'withheld_from_recipient' | null;
  feeFixedAmountMinor: string | null;
  feePolicyId: string | null;
  feeRateBasisPoints: number | null;
  feeRoundingMode: 'floor' | 'half_up' | null;
  listingId: string;
  listingVersion: string;
  quantityScale: number;
  rateBasisPoints: number | null;
  remainingQuantity: string;
  roundingMode: 'floor' | 'half_up' | null;
  taxPolicyId: string | null;
  taxType: 'flat_periodic' | 'payroll' | 'sales' | 'transaction' | null;
  unitPriceMinor: string;
}

interface PreviewRow extends QueryResultRow {
  collection_mode: PurchasePreviewSource['collectionMode'];
  currency_id: string;
  current_tick: string;
  expires_at_tick: string;
  fixed_amount_minor: string | null;
  fee_collection_mode: PurchasePreviewSource['feeCollectionMode'];
  fee_fixed_amount_minor: string | null;
  fee_policy_id: string | null;
  fee_rate_basis_points: number | null;
  fee_rounding_mode: PurchasePreviewSource['feeRoundingMode'];
  listing_id: string;
  listing_version: string;
  quantity_scale: number;
  rate_basis_points: number | null;
  remaining_quantity: string;
  rounding_mode: PurchasePreviewSource['roundingMode'];
  tax_policy_id: string | null;
  tax_type: PurchasePreviewSource['taxType'];
  unit_price_minor: string;
}

export class PostgresCommerceReadRepository {
  public constructor(private readonly executor: CommerceReadExecutor) {}

  public async context(actorId: string, worldId: string): Promise<CommerceReadContext | null> {
    const result = await this.executor.query<ReadContextRow>(
      `select membership.role::text,
              runtime.state_revision::text as current_state_revision,
              head.updated_state_revision::text as checkpoint_version,
              head.reconciliation_status::text
         from world_memberships membership
         join world_runtime_heads runtime on runtime.world_id = membership.world_id
         join world_economy_expansion_heads head on head.world_id = membership.world_id
        where membership.world_id = $1 and membership.user_id = $2
          and membership.status = 'active'`,
      [worldId, actorId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { projection: projectionMeta(row), role: row.role };
  }

  public async resources(input: {
    actorId: string;
    after: { id: string; key: string } | null;
    limit: number;
    status: ResourceTypeViewV1['status'] | null;
    worldId: string;
  }): Promise<CommerceReadPage<ResourceTypeViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<ResourceRow>(
      `select resource.id::text, resource.world_id::text, resource.stable_key::text,
              resource.display_name, resource.unit_code, resource.quantity_scale,
              resource.primitive_version_id::text, resource.primitive_content_hash,
              resource.status::text, resource.created_state_revision::text
         from resource_types resource
        where resource.world_id = $1
          and ($2::text is null or resource.status::text = $2)
          and ($3::text is null or (resource.stable_key::text collate "C", resource.id)
               > ($3::text collate "C", $4::uuid))
        order by resource.stable_key::text collate "C", resource.id
        limit $5`,
      [input.worldId, input.status, input.after?.key ?? null, input.after?.id ?? null, input.limit],
    );
    return page(context, result.rows.map(resourceView), result.rows.map(stablePosition));
  }

  public async recipes(input: {
    actorId: string;
    after: { id: string; key: string } | null;
    limit: number;
    worldId: string;
  }): Promise<CommerceReadPage<ProductionRecipeVersionViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<RecipeRow>(
      `select version.id::text, version.world_id::text, version.recipe_id::text,
              version.version, version.duration_ticks::text, version.canonical_inputs,
              version.canonical_outputs, version.checksum,
              version.facility_requirements ->> 'assetType' as facility_asset_type,
              recipe.stable_key::text
         from production_recipe_versions version
         join production_recipes recipe
           on recipe.world_id = version.world_id and recipe.id = version.recipe_id
        where version.world_id = $1
          and ($2::text is null or (recipe.stable_key::text collate "C", version.id)
               > ($2::text collate "C", $3::uuid))
        order by recipe.stable_key::text collate "C", version.id
        limit $4`,
      [input.worldId, input.after?.key ?? null, input.after?.id ?? null, input.limit],
    );
    return page(context, result.rows.map(recipeView), result.rows.map(stablePosition));
  }

  public async inventories(input: {
    actorId: string;
    after: { id: string; key: string } | null;
    controlled: boolean | null;
    limit: number;
    resourceTypeId: string | null;
    worldId: string;
  }): Promise<CommerceReadPage<InventoryViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<InventoryRow>(
      `select inventory.id::text, inventory.world_id::text, inventory.stable_key::text,
              inventory.quantity::text, inventory.reserved_quantity::text,
              (inventory.quantity - inventory.reserved_quantity)::text as available_quantity,
              inventory.row_version::text, inventory.updated_state_revision::text,
              owner.logical_key::text as owner_entity_key,
              inventory.container_asset_id::text,
              container.stable_key::text as container_entity_key,
              worldgraph_user_controls_economy_entity_v1(
                inventory.world_id,$2,inventory.owner_entity_id
              ) as controlled_by_actor,
              resource.id::text as resource_id,
              resource.stable_key::text as resource_stable_key,
              resource.display_name as resource_display_name,
              resource.unit_code as resource_unit_code,
              resource.quantity_scale as resource_quantity_scale,
              resource.primitive_version_id::text as resource_primitive_version_id,
              resource.primitive_content_hash as resource_primitive_content_hash,
              resource.status::text as resource_status,
              resource.created_state_revision::text as resource_created_state_revision
         from inventories inventory
         join world_entities owner
           on owner.world_id = inventory.world_id and owner.id = inventory.owner_entity_id
         left join assets container
           on container.world_id = inventory.world_id and container.id = inventory.container_asset_id
         join resource_types resource
           on resource.world_id = inventory.world_id and resource.id = inventory.resource_type_id
        where inventory.world_id = $1
          and ($3::boolean is null or $3 = worldgraph_user_controls_economy_entity_v1(
            inventory.world_id,$2,inventory.owner_entity_id
          ))
          and ($4::uuid is null or inventory.resource_type_id = $4)
          and ($5::text is null or (inventory.stable_key::text collate "C", inventory.id)
               > ($5::text collate "C", $6::uuid))
        order by inventory.stable_key::text collate "C", inventory.id
        limit $7`,
      [
        input.worldId,
        input.actorId,
        input.controlled,
        input.resourceTypeId,
        input.after?.key ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(context, result.rows.map(inventoryView), result.rows.map(stablePosition));
  }

  public async businesses(input: {
    actorId: string;
    after: { id: string; key: string } | null;
    limit: number;
    worldId: string;
  }): Promise<CommerceReadPage<BusinessViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<BusinessRow>(
      `select business.id::text, business.world_id::text, business.stable_key::text,
              organization.logical_key::text as backing_organization_entity_key,
              business.wallet_id::text, business.status::text, business.row_version::text,
              worldgraph_user_controls_economy_entity_v1(
                business.world_id,$2,business.backing_organization_entity_id
              ) as can_manage
         from businesses business
         join world_entities organization
           on organization.world_id = business.world_id
          and organization.id = business.backing_organization_entity_id
        where business.world_id = $1
          and ($3::text is null or (business.stable_key::text collate "C", business.id)
               > ($3::text collate "C", $4::uuid))
        order by business.stable_key::text collate "C", business.id
        limit $5`,
      [
        input.worldId,
        input.actorId,
        input.after?.key ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(context, result.rows.map(businessView), result.rows.map(stablePosition));
  }

  public async facilities(input: {
    actorId: string;
    after: { id: string; key: string } | null;
    limit: number;
    worldId: string;
  }): Promise<CommerceReadPage<BusinessFacilityViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<FacilityRow>(
      `select facility.id::text, facility.world_id::text, facility.stable_key::text,
              facility.business_id::text, facility.facility_asset_id::text,
              facility.status::text, facility.row_version::text,
              coalesce(array_agg(binding.recipe_version_id::text order by binding.recipe_version_id)
                filter (where binding.recipe_version_id is not null), '{}'::text[]) as recipe_version_ids
         from business_facilities facility
         left join business_facility_recipe_versions binding
           on binding.world_id = facility.world_id and binding.facility_id = facility.id
        where facility.world_id = $1
          and ($2::text is null or (facility.stable_key::text collate "C", facility.id)
               > ($2::text collate "C", $3::uuid))
        group by facility.id
        order by facility.stable_key::text collate "C", facility.id
        limit $4`,
      [input.worldId, input.after?.key ?? null, input.after?.id ?? null, input.limit],
    );
    return page(context, result.rows.map(facilityView), result.rows.map(stablePosition));
  }

  public async employmentOffers(input: {
    actorId: string;
    after: { id: string; key: string } | null;
    limit: number;
    worldId: string;
  }): Promise<CommerceReadPage<EmploymentOfferViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<OfferRow>(
      `select offer.id::text, offer.world_id::text, offer.stable_key::text,
              offer.business_id::text, offer.role_code, offer.wage_minor::text,
              offer.currency_id::text, offer.cadence_ticks::text,
              offer.max_payments_per_period, offer.status::text, offer.row_version::text
         from employment_offers offer
        where offer.world_id = $1
          and ($2::text is null or (offer.stable_key::text collate "C", offer.id)
               > ($2::text collate "C", $3::uuid))
        order by offer.stable_key::text collate "C", offer.id
        limit $4`,
      [input.worldId, input.after?.key ?? null, input.after?.id ?? null, input.limit],
    );
    return page(context, result.rows.map(offerView), result.rows.map(stablePosition));
  }

  public async employmentContracts(input: {
    actorId: string;
    after: { id: string; key: string } | null;
    limit: number;
    status: EmploymentContractViewV1['status'] | null;
    worldId: string;
  }): Promise<CommerceReadPage<EmploymentContractViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<ContractRow>(
      `select contract.id::text, contract.world_id::text, contract.stable_key::text,
              contract.business_id::text, worker.logical_key::text as worker_entity_key,
              contract.role_code, contract.wage_minor::text,
              contract.effective_from_tick::text, contract.effective_until_tick::text,
              contract.status::text, contract.row_version::text,
              worldgraph_user_controls_economy_entity_v1(
                contract.world_id,$2,business.backing_organization_entity_id
              ) as can_manage,
              worldgraph_user_controls_economy_entity_v1(
                contract.world_id,$2,contract.worker_entity_id
              ) as can_work
         from employment_contracts contract
         join businesses business
           on business.world_id = contract.world_id and business.id = contract.business_id
         join world_entities worker
           on worker.world_id = contract.world_id and worker.id = contract.worker_entity_id
         join world_memberships membership
           on membership.world_id = contract.world_id and membership.user_id = $2
          and membership.status = 'active'
        where contract.world_id = $1
          and (membership.role in ('creator','administrator')
            or worldgraph_user_controls_economy_entity_v1(
              contract.world_id,$2,contract.worker_entity_id
            )
            or worldgraph_user_controls_economy_entity_v1(
              contract.world_id,$2,business.backing_organization_entity_id
            ))
          and ($3::text is null or contract.status::text = $3)
          and ($4::text is null or (contract.stable_key::text collate "C", contract.id)
               > ($4::text collate "C", $5::uuid))
        order by contract.stable_key::text collate "C", contract.id
        limit $6`,
      [
        input.worldId,
        input.actorId,
        input.status,
        input.after?.key ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(context, result.rows.map(contractView), result.rows.map(stablePosition));
  }

  public async employmentCandidates(input: {
    actorId: string;
    after: { id: string; key: string } | null;
    businessId: string;
    limit: number;
    worldId: string;
  }): Promise<CommerceReadPage<EmploymentCandidateViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const authorization = await this.executor.query<{ id: string }>(
      `select business.id::text
         from businesses business
        where business.world_id = $1 and business.id = $2 and business.status = 'active'
          and worldgraph_user_controls_economy_entity_v1(
            business.world_id,$3,business.backing_organization_entity_id
          )`,
      [input.worldId, input.businessId, input.actorId],
    );
    if (!authorization.rows[0]) return null;
    const result = await this.executor.query<EmploymentCandidateRow>(
      `select business.id::text as business_id, business.currency_id::text,
              worker.logical_key::text as worker_entity_key,
              wallet.id::text as worker_wallet_id
         from businesses business
         join world_entities worker
           on worker.world_id = business.world_id
          and worker.entity_type = 'player_character'
          and worker.retired_world_version_id is null
         join world_entity_controllers controller
           on controller.world_id = worker.world_id and controller.entity_id = worker.id
          and controller.control_scope = 'primary' and controller.revoked_at is null
         join world_memberships candidate_membership
           on candidate_membership.world_id = controller.world_id
          and candidate_membership.user_id = controller.user_id
          and candidate_membership.status = 'active'
         join wallets wallet
           on wallet.world_id = worker.world_id and wallet.owner_entity_id = worker.id
          and wallet.wallet_kind = 'player' and wallet.status = 'active'
          and wallet.currency_id = business.currency_id
        where business.world_id = $1 and business.id = $2 and business.status = 'active'
          and worldgraph_user_controls_economy_entity_v1(
            business.world_id,$3,business.backing_organization_entity_id
          )
          and ($4::text is null or (worker.logical_key::text collate "C", wallet.id)
               > ($4::text collate "C", $5::uuid))
        order by worker.logical_key::text collate "C", wallet.id
        limit $6`,
      [
        input.worldId,
        input.businessId,
        input.actorId,
        input.after?.key ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(
      context,
      result.rows.map(employmentCandidateView),
      result.rows.map((row) => `${row.worker_entity_key}|${row.worker_wallet_id}`),
    );
  }

  public async jobs(input: {
    actorId: string;
    after: { id: string; tick: string } | null;
    limit: number;
    worldId: string;
  }): Promise<CommerceReadPage<JobRecordViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<JobRow>(
      `select work.id::text, work.world_id::text, work.contract_id::text,
              work.performed_tick::text, work.gross_minor::text,
              payroll.id::text as payroll_id, payroll.status::text as payroll_status,
              payroll.gross_minor::text as payroll_gross_minor,
              payroll.tax_minor::text as payroll_tax_minor,
              payroll.net_minor::text as payroll_net_minor,
              payroll.error_code as payroll_error_code,
              payroll.row_version::text as payroll_row_version
         from work_records work
         join employment_contracts contract
           on contract.world_id = work.world_id and contract.id = work.contract_id
         join businesses business
           on business.world_id = contract.world_id and business.id = contract.business_id
         join world_memberships membership
           on membership.world_id = contract.world_id and membership.user_id = $2
          and membership.status = 'active'
         left join payroll_records payroll
           on payroll.world_id = work.world_id and payroll.work_record_id = work.id
        where work.world_id = $1
          and (membership.role in ('creator','administrator')
            or worldgraph_user_controls_economy_entity_v1(
              contract.world_id,$2,contract.worker_entity_id
            )
            or worldgraph_user_controls_economy_entity_v1(
              contract.world_id,$2,business.backing_organization_entity_id
            ))
          and ($3::bigint is null or (work.performed_tick, work.id) < ($3::bigint, $4::uuid))
        order by work.performed_tick desc, work.id desc
        limit $5`,
      [
        input.worldId,
        input.actorId,
        input.after?.tick ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(
      context,
      result.rows.map(jobView),
      result.rows.map((row) => `${row.performed_tick}|${row.id}`),
    );
  }

  public async productionRuns(input: {
    actorId: string;
    after: { id: string; tick: string } | null;
    businessId: string | null;
    limit: number;
    status: ProductionRunViewV1['status'] | null;
    worldId: string;
  }): Promise<CommerceReadPage<ProductionRunViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<ProductionRunRow>(
      `select run.id::text, run.world_id::text, run.business_id::text,
              run.facility_id::text, run.recipe_version_id::text, run.quantity::text,
              run.status::text, run.due_tick::text, run.input_snapshot,
              run.output_snapshot, run.failure_code, run.row_version::text
         from production_runs run
        where run.world_id = $1
          and ($2::uuid is null or run.business_id = $2)
          and ($3::text is null or run.status::text = $3)
          and ($4::bigint is null or (run.due_tick, run.id) < ($4::bigint, $5::uuid))
        order by run.due_tick desc, run.id desc
        limit $6`,
      [
        input.worldId,
        input.businessId,
        input.status,
        input.after?.tick ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(
      context,
      result.rows.map(productionRunView),
      result.rows.map((row) => `${row.due_tick}|${row.id}`),
    );
  }

  public async marketListings(input: {
    actorId: string;
    after: { id: string; price: string } | null;
    limit: number;
    resourceTypeId: string | null;
    status: MarketListingViewV1['status'] | null;
    worldId: string;
  }): Promise<CommerceReadPage<MarketListingViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<ListingRow>(
      `select listing.id::text, listing.world_id::text, listing.currency_id::text,
              listing.offered_quantity::text, listing.remaining_quantity::text,
              listing.unit_price_minor::text, listing.status::text,
              listing.expires_at_tick::text, listing.row_version::text,
              seller.logical_key::text as seller_entity_key,
              worldgraph_user_controls_economy_entity_v1(
                listing.world_id,$2,listing.seller_entity_id
              ) as can_cancel,
              resource.id::text as resource_id,
              resource.stable_key::text as resource_stable_key,
              resource.display_name as resource_display_name,
              resource.unit_code as resource_unit_code,
              resource.quantity_scale as resource_quantity_scale,
              resource.primitive_version_id::text as resource_primitive_version_id,
              resource.primitive_content_hash as resource_primitive_content_hash,
              resource.status::text as resource_status,
              resource.created_state_revision::text as resource_created_state_revision
         from market_listings listing
         join world_entities seller
           on seller.world_id = listing.world_id and seller.id = listing.seller_entity_id
         join resource_types resource
           on resource.world_id = listing.world_id and resource.id = listing.resource_type_id
        where listing.world_id = $1
          and ($3::uuid is null or listing.resource_type_id = $3)
          and ($4::text is null or listing.status::text = $4)
          and ($5::bigint is null or (listing.unit_price_minor, listing.id) > ($5::bigint, $6::uuid))
        order by listing.unit_price_minor, listing.id
        limit $7`,
      [
        input.worldId,
        input.actorId,
        input.resourceTypeId,
        input.status,
        input.after?.price ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(
      context,
      result.rows.map(listingView),
      result.rows.map((row) => `${row.unit_price_minor}|${row.id}`),
    );
  }

  public async marketTrades(input: {
    actorId: string;
    after: { id: string; tick: string } | null;
    limit: number;
    listingId: string | null;
    worldId: string;
  }): Promise<CommerceReadPage<MarketTradeViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<TradeRow>(
      `select trade.id::text, trade.world_id::text, trade.listing_id::text,
              trade.quantity::text, trade.unit_price_minor::text, trade.gross_minor::text,
              trade.buyer_total_minor::text, trade.seller_net_minor::text,
              trade.tax_minor::text, trade.fee_minor::text,
              trade.occurred_tick::text, trade.created_at
         from market_trades trade
        where trade.world_id = $1
          and ($2::uuid is null or trade.listing_id = $2)
          and ($3::bigint is null or (trade.occurred_tick, trade.id) < ($3::bigint, $4::uuid))
        order by trade.occurred_tick desc, trade.id desc
        limit $5`,
      [
        input.worldId,
        input.listingId,
        input.after?.tick ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(
      context,
      result.rows.map(tradeView),
      result.rows.map((row) => `${row.occurred_tick}|${row.id}`),
    );
  }

  public async transactions(input: {
    actorId: string;
    after: { createdAt: Date; id: string; tick: string } | null;
    limit: number;
    worldId: string;
  }): Promise<CommerceReadPage<CommerceTransactionSummaryViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<CommerceTransactionRow>(
      `select transaction.id::text, transaction.world_id::text,
              transaction.currency_id::text, transaction.transaction_kind::text,
              transaction.occurred_tick::text, transaction.created_at,
              trade.id::text as market_trade_id,
              case transaction.transaction_kind
                when 'market_purchase' then trade.gross_minor::text
                when 'payroll' then payroll.gross_minor::text
              end as gross_minor,
              trade.buyer_total_minor::text, trade.seller_net_minor::text,
              trade.fee_minor::text,
              case transaction.transaction_kind
                when 'market_purchase' then trade.tax_minor::text
                when 'payroll' then payroll.tax_minor::text
              end as tax_minor,
              payroll.id::text as payroll_record_id, payroll.net_minor::text,
              periodic.id::text as tax_assessment_id,
              periodic.basis_minor::text, periodic.amount_minor::text
         from financial_transactions transaction
         join world_memberships membership
           on membership.world_id = transaction.world_id and membership.user_id = $2
          and membership.status = 'active'
         left join market_trades trade
           on trade.world_id = transaction.world_id
          and trade.wallet_transaction_id = transaction.id
         left join payroll_records payroll
           on payroll.world_id = transaction.world_id
          and payroll.financial_transaction_id = transaction.id
         left join employment_contracts contract
           on contract.world_id = payroll.world_id and contract.id = payroll.contract_id
         left join businesses business
           on business.world_id = contract.world_id and business.id = contract.business_id
         left join tax_assessments periodic
           on periodic.world_id = transaction.world_id
          and periodic.settlement_transaction_id = transaction.id
          and periodic.source_type = 'periodic_tax'
        where transaction.world_id = $1
          and transaction.transaction_kind in ('market_purchase','payroll','periodic_tax')
          and (
            (transaction.transaction_kind = 'market_purchase' and trade.id is not null)
            or (transaction.transaction_kind = 'periodic_tax' and periodic.id is not null)
            or (
              transaction.transaction_kind = 'payroll' and payroll.id is not null
              and (
                membership.role in ('creator','administrator')
                or exists (
                  select 1
                    from economy_participant_history participant
                   where participant.world_id = transaction.world_id
                     and participant.event_id = transaction.event_id
                     and participant.user_id = $2
                     and participant.visibility = 'participant'
                     and participant.category = 'payroll'
                )
                or worldgraph_user_controls_economy_entity_v1(
                  contract.world_id,$2,contract.worker_entity_id
                )
                or worldgraph_user_controls_economy_entity_v1(
                  business.world_id,$2,business.backing_organization_entity_id
                )
              )
            )
          )
          and ($3::bigint is null or
               (transaction.occurred_tick, transaction.created_at, transaction.id)
               < ($3::bigint,$4::timestamptz,$5::uuid))
        order by transaction.occurred_tick desc, transaction.created_at desc,
                 transaction.id desc
        limit $6`,
      [
        input.worldId,
        input.actorId,
        input.after?.tick ?? null,
        input.after?.createdAt ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(
      context,
      result.rows.map(transactionSummaryView),
      result.rows.map((row) => `${row.occurred_tick}|${row.created_at.toISOString()}|${row.id}`),
    );
  }

  public async taxAssessments(input: {
    actorId: string;
    after: { id: string; tick: string } | null;
    limit: number;
    worldId: string;
  }): Promise<CommerceReadPage<TaxAssessmentViewV1> | null> {
    const context = await this.context(input.actorId, input.worldId);
    if (!context) return null;
    const result = await this.executor.query<TaxRow>(
      `select assessment.id::text, assessment.world_id::text,
              assessment.policy_id::text, assessment.source_type,
              assessment.source_id::text, assessment.basis_minor::text,
              assessment.amount_minor::text, assessment.occurred_tick::text,
              assessment.created_at
         from tax_assessments assessment
         join world_memberships membership
           on membership.world_id = assessment.world_id and membership.user_id = $2
          and membership.status = 'active'
        where assessment.world_id = $1
          and (
            assessment.source_type <> 'payroll'
            or exists (
              select 1
                from payroll_records payroll
                join employment_contracts contract
                  on contract.world_id = payroll.world_id and contract.id = payroll.contract_id
                join businesses business
                  on business.world_id = contract.world_id
                 and business.id = contract.business_id
               where payroll.world_id = assessment.world_id
                 and payroll.id = assessment.source_id
                 and payroll.status = 'paid'
                 and payroll.financial_transaction_id = assessment.settlement_transaction_id
                 and payroll.terminal_event_id = assessment.event_id
                 and (
                   membership.role in ('creator','administrator')
                   or exists (
                     select 1
                       from economy_participant_history participant
                      where participant.world_id = assessment.world_id
                        and participant.event_id = assessment.event_id
                        and participant.user_id = $2
                        and participant.visibility = 'participant'
                        and participant.category = 'payroll'
                   )
                   or worldgraph_user_controls_economy_entity_v1(
                     contract.world_id,$2,contract.worker_entity_id
                   )
                   or worldgraph_user_controls_economy_entity_v1(
                     business.world_id,$2,business.backing_organization_entity_id
                   )
                 )
            )
          )
          and ($3::bigint is null or (assessment.occurred_tick, assessment.id)
               < ($3::bigint, $4::uuid))
        order by assessment.occurred_tick desc, assessment.id desc
        limit $5`,
      [
        input.worldId,
        input.actorId,
        input.after?.tick ?? null,
        input.after?.id ?? null,
        input.limit,
      ],
    );
    return page(
      context,
      result.rows.map(taxView),
      result.rows.map((row) => `${row.occurred_tick}|${row.id}`),
    );
  }

  public async treasury(
    actorId: string,
    worldId: string,
  ): Promise<{ projection: CommerceProjectionMeta; treasury: TreasurySummaryViewV1 } | null> {
    const context = await this.context(actorId, worldId);
    if (!context) return null;
    const result = await this.executor.query<TreasuryRow>(
      `select wallet.world_id::text, wallet.id::text as treasury_wallet_id,
              wallet.currency_id::text, balance.available_minor::text as balance_minor,
              coalesce(sum(assessment.amount_minor),0)::text as revenue_minor,
              max(assessment.occurred_tick)::text as last_revenue_tick
         from wallets wallet
         join wallet_balances balance
           on balance.world_id = wallet.world_id and balance.wallet_id = wallet.id
         left join tax_assessments assessment
           on assessment.world_id = wallet.world_id
          and assessment.treasury_wallet_id = wallet.id
        where wallet.world_id = $1 and wallet.wallet_kind = 'treasury'
          and wallet.status <> 'closed'
        group by wallet.world_id, wallet.id, wallet.currency_id, balance.available_minor
        order by wallet.stable_key::text collate "C", wallet.id
        limit 1`,
      [worldId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { projection: context.projection, treasury: treasuryView(row) };
  }

  public async purchasePreviewSource(
    actorId: string,
    worldId: string,
    listingId: string,
    disabledTaxPolicyIds: readonly string[],
  ): Promise<{ projection: CommerceProjectionMeta; source: PurchasePreviewSource } | null> {
    const context = await this.context(actorId, worldId);
    if (!context) return null;
    const result = await this.executor.query<PreviewRow>(
      `select listing.id::text as listing_id, listing.currency_id::text,
              listing.row_version::text as listing_version,
              listing.remaining_quantity::text, listing.unit_price_minor::text,
              listing.expires_at_tick::text, resource.quantity_scale,
              clock.current_tick::text, policy.id::text as tax_policy_id,
              policy.tax_type::text, policy.collection_mode::text,
              policy.rounding_mode, policy.rate_basis_points,
              policy.fixed_amount_minor::text,
              fee_policy.id::text as fee_policy_id,
              fee_policy.collection_mode::text as fee_collection_mode,
              fee_policy.rounding_mode as fee_rounding_mode,
              fee_policy.rate_basis_points as fee_rate_basis_points,
              fee_policy.fixed_amount_minor::text as fee_fixed_amount_minor
         from market_listings listing
         join resource_types resource
           on resource.world_id = listing.world_id and resource.id = listing.resource_type_id
         join world_simulation_clocks clock on clock.world_id = listing.world_id
         left join lateral (
           select tax.* from (
             select candidate.*,0 as tax_priority
               from worldgraph_tax_policy_effective_at_v2(
                 listing.world_id,'sales',clock.current_tick
               ) candidate
             union all
             select candidate.*,1 as tax_priority
               from worldgraph_tax_policy_effective_at_v2(
                 listing.world_id,'transaction',clock.current_tick
               ) candidate
           ) tax
            where tax.currency_id = listing.currency_id
              and tax.status = 'active'
              and not (tax.id = any($3::uuid[]))
            order by tax.tax_priority, tax.policy_version desc, tax.id
            limit 1
         ) policy on true
         left join lateral (
           select tax.* from worldgraph_tax_policy_effective_at_v2(
             listing.world_id,'marketplace_fee',clock.current_tick
           ) tax
            where tax.currency_id = listing.currency_id and tax.status = 'active'
              and not (tax.id = any($3::uuid[]))
            order by tax.policy_version desc, tax.id
            limit 1
         ) fee_policy on true
        where listing.world_id = $1 and listing.id = $2 and listing.status = 'open'`,
      [worldId, listingId, disabledTaxPolicyIds],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      projection: context.projection,
      source: {
        collectionMode: row.collection_mode,
        currencyId: row.currency_id,
        currentTick: row.current_tick,
        expiresAtTick: row.expires_at_tick,
        fixedAmountMinor: row.fixed_amount_minor,
        feeCollectionMode: row.fee_collection_mode,
        feeFixedAmountMinor: row.fee_fixed_amount_minor,
        feePolicyId: row.fee_policy_id,
        feeRateBasisPoints: row.fee_rate_basis_points,
        feeRoundingMode: row.fee_rounding_mode,
        listingId: row.listing_id,
        listingVersion: row.listing_version,
        quantityScale: row.quantity_scale,
        rateBasisPoints: row.rate_basis_points,
        remainingQuantity: canonicalQuantity(row.remaining_quantity, row.quantity_scale),
        roundingMode: row.rounding_mode,
        taxPolicyId: row.tax_policy_id,
        taxType: row.tax_type,
        unitPriceMinor: row.unit_price_minor,
      },
    };
  }

  public async reconciliation(
    actorId: string,
    worldId: string,
  ): Promise<CommerceReconciliationSummaryV1 | null> {
    const context = await this.context(actorId, worldId);
    if (!context) return null;
    const result = await this.executor.query<
      QueryResultRow & {
        assessment_count: number | null;
        expansion_version: string;
        inventory_count: number | null;
        mismatch_count: number | null;
        projection_checksum: Buffer;
        reconciliation_id: string | null;
        reconciliation_status: 'matched' | 'mismatch' | null;
        resource_count: number | null;
        source_state_revision: string | null;
        trade_count: number | null;
        world_id: string;
      }
    >(
      `select head.world_id::text, head.row_version::text as expansion_version,
              head.checksum as projection_checksum, run.id::text as reconciliation_id,
              run.status::text as reconciliation_status,
              run.source_state_revision::text, run.resource_count,
              run.inventory_count, run.trade_count, run.assessment_count,
              run.mismatch_count
         from world_economy_expansion_heads head
         left join economy_expansion_reconciliation_runs run
           on run.world_id = head.world_id and run.id = head.last_reconciliation_run_id
        where head.world_id = $1`,
      [worldId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      expansionVersion: row.expansion_version,
      lastRun:
        row.reconciliation_id &&
        row.reconciliation_status &&
        row.source_state_revision !== null &&
        row.resource_count !== null &&
        row.inventory_count !== null &&
        row.trade_count !== null &&
        row.assessment_count !== null &&
        row.mismatch_count !== null
          ? {
              assessmentCount: row.assessment_count,
              id: row.reconciliation_id,
              inventoryCount: row.inventory_count,
              mismatchCount: row.mismatch_count,
              resourceCount: row.resource_count,
              sourceStateRevision: row.source_state_revision,
              status: row.reconciliation_status,
              tradeCount: row.trade_count,
            }
          : null,
      projection: context.projection,
      projectionChecksum: row.projection_checksum.toString('hex'),
      worldId: row.world_id,
    };
  }
}

function projectionMeta(row: ReadContextRow): CommerceProjectionMeta {
  const current = BigInt(row.current_state_revision);
  const checkpoint = BigInt(row.checkpoint_version);
  const lag = current > checkpoint ? current - checkpoint : 0n;
  return {
    checkpointVersion: row.checkpoint_version,
    currentStateRevision: row.current_state_revision,
    lagRevisions: lag.toString(),
    status:
      row.reconciliation_status === 'failed'
        ? 'failed'
        : row.reconciliation_status === 'mismatch'
          ? 'mismatch'
          : row.reconciliation_status === 'current' && lag === 0n
            ? 'current'
            : 'catching_up',
  };
}

function page<T>(
  context: CommerceReadContext,
  items: T[],
  positions: string[],
): CommerceReadPage<T> {
  return { items, positions, projection: context.projection };
}

function resourceView(row: ResourceRow): ResourceTypeViewV1 {
  return {
    displayName: row.display_name,
    id: row.id,
    primitiveContentHash: row.primitive_content_hash.toString('hex'),
    primitiveVersionId: row.primitive_version_id,
    quantityScale: row.quantity_scale,
    rowVersion: row.created_state_revision,
    schemaVersion: 1,
    stableKey: row.stable_key,
    status: row.status,
    unitCode: row.unit_code.toLowerCase(),
    worldId: row.world_id,
  };
}

function recipeView(row: RecipeRow): ProductionRecipeVersionViewV1 {
  return {
    checksum: row.checksum.toString('hex'),
    durationTicks: row.duration_ticks,
    facilityAssetType: row.facility_asset_type,
    id: row.id,
    inputs: row.canonical_inputs,
    outputs: row.canonical_outputs,
    recipeId: row.recipe_id,
    schemaVersion: 1,
    version: row.version,
    worldId: row.world_id,
  };
}

function inventoryView(row: InventoryRow): InventoryViewV1 {
  const resource = resourceView({
    created_state_revision: row.resource_created_state_revision,
    display_name: row.resource_display_name,
    id: row.resource_id,
    primitive_content_hash: row.resource_primitive_content_hash,
    primitive_version_id: row.resource_primitive_version_id,
    quantity_scale: row.resource_quantity_scale,
    stable_key: row.resource_stable_key,
    status: row.resource_status,
    unit_code: row.resource_unit_code,
    world_id: row.world_id,
  });
  return {
    availableQuantity: canonicalQuantity(row.available_quantity, row.resource_quantity_scale),
    containerAssetId: row.container_asset_id,
    containerEntityKey: row.container_entity_key,
    controlledByActor: row.controlled_by_actor,
    id: row.id,
    ownerEntityKey: row.owner_entity_key,
    quantity: canonicalQuantity(row.quantity, row.resource_quantity_scale),
    reservedQuantity: canonicalQuantity(row.reserved_quantity, row.resource_quantity_scale),
    resourceType: resource,
    rowVersion: row.row_version,
    updatedStateRevision: row.updated_state_revision,
    worldId: row.world_id,
  };
}

function employmentCandidateView(row: EmploymentCandidateRow): EmploymentCandidateViewV1 {
  return {
    businessId: row.business_id,
    currencyId: row.currency_id,
    workerEntityKey: row.worker_entity_key,
    workerWalletId: row.worker_wallet_id,
  };
}

function businessView(row: BusinessRow): BusinessViewV1 {
  return {
    backingOrganizationEntityKey: row.backing_organization_entity_key,
    canManage: row.can_manage,
    id: row.id,
    rowVersion: row.row_version,
    schemaVersion: 1,
    status: row.status,
    walletId: row.wallet_id,
    worldId: row.world_id,
  };
}

function facilityView(row: FacilityRow): BusinessFacilityViewV1 {
  return {
    businessId: row.business_id,
    facilityAssetId: row.facility_asset_id,
    id: row.id,
    recipeVersionIds: row.recipe_version_ids,
    rowVersion: row.row_version,
    schemaVersion: 1,
    status: row.status,
    worldId: row.world_id,
  };
}

function offerView(row: OfferRow): EmploymentOfferViewV1 {
  return {
    businessId: row.business_id,
    cadenceTicks: row.cadence_ticks,
    currencyId: row.currency_id,
    id: row.id,
    maxPaymentsPerPeriod: row.max_payments_per_period,
    roleCode: row.role_code.replaceAll('-', '_'),
    rowVersion: row.row_version,
    stableKey: row.stable_key,
    status: row.status,
    wageMinor: row.wage_minor,
    worldId: row.world_id,
  };
}

function contractView(row: ContractRow): EmploymentContractViewV1 {
  return {
    businessId: row.business_id,
    canManage: row.can_manage,
    canWork: row.can_work,
    effectiveFromTick: row.effective_from_tick,
    effectiveToTick: row.effective_until_tick ?? '9223372036854775807',
    id: row.id,
    privateTermsVisible: true,
    roleCode: row.role_code,
    rowVersion: row.row_version,
    status: row.status,
    wageMinor: row.wage_minor,
    workerEntityKey: row.worker_entity_key,
    worldId: row.world_id,
  };
}

function jobView(row: JobRow): JobRecordViewV1 {
  return {
    contractId: row.contract_id,
    grossMinor: row.gross_minor,
    id: row.id,
    payroll:
      row.payroll_id &&
      row.payroll_status &&
      row.payroll_gross_minor &&
      row.payroll_tax_minor !== null &&
      row.payroll_net_minor !== null &&
      row.payroll_row_version
        ? {
            errorCode: row.payroll_error_code?.toLowerCase() ?? null,
            grossMinor: row.payroll_gross_minor,
            id: row.payroll_id,
            netMinor: row.payroll_net_minor,
            rowVersion: row.payroll_row_version,
            status: row.payroll_status,
            taxMinor: row.payroll_tax_minor,
          }
        : null,
    performedTick: row.performed_tick,
    worldId: row.world_id,
  };
}

function productionRunView(row: ProductionRunRow): ProductionRunViewV1 {
  return {
    businessId: row.business_id,
    dueTick: row.due_tick,
    facilityId: row.facility_id,
    failureCode: row.failure_code?.toLowerCase() ?? null,
    id: row.id,
    inputSnapshot: row.input_snapshot,
    outputSnapshot: row.output_snapshot,
    recipeVersionId: row.recipe_version_id,
    rowVersion: row.row_version,
    runQuantity: canonicalQuantity(row.quantity, 12),
    status: row.status,
    worldId: row.world_id,
  };
}

function listingView(row: ListingRow): MarketListingViewV1 {
  return {
    canCancel: row.can_cancel,
    currencyId: row.currency_id,
    expiresAtTick: row.expires_at_tick,
    id: row.id,
    offeredQuantity: canonicalQuantity(row.offered_quantity, row.resource_quantity_scale),
    remainingQuantity: canonicalQuantity(row.remaining_quantity, row.resource_quantity_scale),
    resourceType: resourceView({
      created_state_revision: row.resource_created_state_revision,
      display_name: row.resource_display_name,
      id: row.resource_id,
      primitive_content_hash: row.resource_primitive_content_hash,
      primitive_version_id: row.resource_primitive_version_id,
      quantity_scale: row.resource_quantity_scale,
      stable_key: row.resource_stable_key,
      status: row.resource_status,
      unit_code: row.resource_unit_code,
      world_id: row.world_id,
    }),
    rowVersion: row.row_version,
    sellerEntityKey: row.seller_entity_key,
    status: row.status,
    unitPriceMinor: row.unit_price_minor,
    worldId: row.world_id,
  };
}

function tradeView(row: TradeRow): MarketTradeViewV1 {
  return {
    buyerTotalMinor: row.buyer_total_minor,
    createdTick: row.occurred_tick,
    feeMinor: row.fee_minor,
    grossMinor: row.gross_minor,
    id: row.id,
    listingId: row.listing_id,
    quantity: canonicalQuantity(row.quantity, 12),
    sellerNetMinor: row.seller_net_minor,
    taxMinor: row.tax_minor,
    unitPriceMinor: row.unit_price_minor,
    worldId: row.world_id,
  };
}

function transactionSummaryView(row: CommerceTransactionRow): CommerceTransactionSummaryViewV1 {
  const common = {
    currencyId: row.currency_id,
    id: row.id,
    occurredTick: row.occurred_tick,
    worldId: row.world_id,
  };
  if (row.transaction_kind === 'market_purchase') {
    if (
      row.market_trade_id === null ||
      row.buyer_total_minor === null ||
      row.fee_minor === null ||
      row.gross_minor === null ||
      row.seller_net_minor === null ||
      row.tax_minor === null
    ) {
      return malformedTransactionSummary();
    }
    return {
      ...common,
      buyerTotalMinor: row.buyer_total_minor,
      feeMinor: row.fee_minor,
      grossMinor: row.gross_minor,
      kind: 'market_purchase',
      marketTradeId: row.market_trade_id,
      sellerNetMinor: row.seller_net_minor,
      taxMinor: row.tax_minor,
    };
  }
  if (row.transaction_kind === 'payroll') {
    if (
      row.gross_minor === null ||
      row.net_minor === null ||
      row.payroll_record_id === null ||
      row.tax_minor === null
    ) {
      return malformedTransactionSummary();
    }
    return {
      ...common,
      grossMinor: row.gross_minor,
      kind: 'payroll',
      netMinor: row.net_minor,
      payrollRecordId: row.payroll_record_id,
      taxMinor: row.tax_minor,
    };
  }
  if (row.amount_minor === null || row.basis_minor === null || row.tax_assessment_id === null) {
    return malformedTransactionSummary();
  }
  return {
    ...common,
    amountMinor: row.amount_minor,
    basisMinor: row.basis_minor,
    kind: 'periodic_tax',
    taxAssessmentId: row.tax_assessment_id,
  };
}

function malformedTransactionSummary(): never {
  throw new Error('Commerce transaction source evidence is incomplete.');
}

function taxView(row: TaxRow): TaxAssessmentViewV1 {
  return {
    amountMinor: row.amount_minor,
    basisMinor: row.basis_minor,
    id: row.id,
    policyId: row.policy_id,
    sourceId: row.source_id,
    sourceType: row.source_type,
    tick: row.occurred_tick,
    worldId: row.world_id,
  };
}

function treasuryView(row: TreasuryRow): TreasurySummaryViewV1 {
  return {
    balanceMinor: row.balance_minor,
    currencyId: row.currency_id,
    lastRevenueTick: row.last_revenue_tick,
    noCashValue: true,
    revenueMinor: row.revenue_minor,
    treasuryWalletId: row.treasury_wallet_id,
    worldId: row.world_id,
  };
}

function stablePosition(row: { id: string; stable_key: string }): string {
  return `${row.stable_key}|${row.id}`;
}

export function canonicalQuantity(value: string, scale: number): string {
  const [whole = '0', rawFraction = ''] = value.split('.');
  const fraction = rawFraction.slice(0, scale).replace(/0+$/u, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
