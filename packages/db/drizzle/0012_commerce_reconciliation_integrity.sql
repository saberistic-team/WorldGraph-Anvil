CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
--> statement-breakpoint
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tax_policies left_policy
    JOIN public.tax_policies right_policy
      ON right_policy.world_id = left_policy.world_id
      AND right_policy.currency_id = left_policy.currency_id
      AND right_policy.tax_type = left_policy.tax_type
      AND right_policy.id > left_policy.id
      AND (
        CASE
          WHEN left_policy.tax_type = 'periodic_flat'::tax_policy_type
            THEN left_policy.applicability - 'intervalTicks'
          ELSE left_policy.applicability
        END
      ) = (
        CASE
          WHEN right_policy.tax_type = 'periodic_flat'::tax_policy_type
            THEN right_policy.applicability - 'intervalTicks'
          ELSE right_policy.applicability
        END
      )
    WHERE left_policy.status = 'active'::tax_policy_status
      AND right_policy.status = 'active'::tax_policy_status
      AND int8range(
        left_policy.effective_from_tick,
        left_policy.effective_until_tick,
        '[)'
      ) && int8range(
        right_policy.effective_from_tick,
        right_policy.effective_until_tick,
        '[)'
      )
  ) THEN
    RAISE EXCEPTION
      'existing active tax policies overlap for one identical semantic scope'
      USING ERRCODE = '23514',
        CONSTRAINT = 'tax_policies_active_scope_window_exclusion';
  END IF;
END
$migration$;
--> statement-breakpoint
ALTER TABLE public.tax_policies
  ADD CONSTRAINT tax_policies_active_scope_window_exclusion
  EXCLUDE USING gist (
    world_id WITH =,
    currency_id WITH =,
    tax_type WITH =,
    ((
      CASE
        WHEN tax_type = 'periodic_flat'::tax_policy_type
          THEN applicability - 'intervalTicks'
        ELSE applicability
      END
    )::text) WITH =,
    (int8range(effective_from_tick, effective_until_tick, '[)')) WITH &&
  )
  WHERE (status = 'active'::tax_policy_status);
--> statement-breakpoint
ALTER TABLE public.economy_expansion_command_write_snapshots
  ADD COLUMN opened_checkpoint_event_sequence bigint,
  ADD COLUMN opened_checkpoint_checksum bytea,
  ADD COLUMN opened_checkpoint_status projection_checkpoint_status;
--> statement-breakpoint
ALTER TABLE public.economy_expansion_command_write_snapshots
  ADD CONSTRAINT economy_expansion_command_snapshots_checkpoint_shape CHECK (
    (
      opened_checkpoint_event_sequence IS NULL
      AND opened_checkpoint_checksum IS NULL
      AND opened_checkpoint_status IS NULL
    )
    OR (
      expansion_state_exists
      AND opened_checkpoint_event_sequence IS NOT NULL
      AND opened_checkpoint_event_sequence >= 0
      AND opened_checkpoint_checksum IS NOT NULL
      AND octet_length(opened_checkpoint_checksum) = 32
      AND opened_checkpoint_status IS NOT NULL
    )
  );
--> statement-breakpoint
ALTER TABLE public.command_records
  ADD COLUMN rate_limit_scope_hash bytea,
  ADD CONSTRAINT command_records_rate_limit_scope_hash_valid CHECK (
    rate_limit_scope_hash IS NULL
      OR octet_length(rate_limit_scope_hash) = 32
  );
--> statement-breakpoint
CREATE INDEX command_records_commerce_rate_scope_idx
  ON public.command_records(
    world_id, actor_type, actor_id, command_type,
    rate_limit_scope_hash, requested_at DESC
  )
  WHERE rate_limit_scope_hash IS NOT NULL
    AND command_type IN (
      'PerformJobV1','StartProductionRunV1',
      'CreateMarketListingV1','PurchaseMarketListingV1'
    );
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_require_command_rate_limit_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF (
    NEW.command_type IN (
      'PerformJobV1','StartProductionRunV1',
      'CreateMarketListingV1','PurchaseMarketListingV1'
    )
    AND NEW.rate_limit_scope_hash IS NULL
  ) OR (
    NEW.command_type NOT IN (
      'PerformJobV1','StartProductionRunV1',
      'CreateMarketListingV1','PurchaseMarketListingV1'
    )
    AND NEW.rate_limit_scope_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'command rate-limit scope does not match its command type'
      USING ERRCODE = '23514',
        CONSTRAINT = 'command_records_rate_limit_scope_required';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER command_records_require_rate_limit_scope
  BEFORE INSERT ON public.command_records
  FOR EACH ROW
  EXECUTE FUNCTION public.worldgraph_require_command_rate_limit_scope();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_require_command_rate_limit_scope()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_command_rate_limit_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.rate_limit_scope_hash IS DISTINCT FROM OLD.rate_limit_scope_hash THEN
    RAISE EXCEPTION 'command rate-limit scope is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER command_records_protect_rate_limit_scope
  BEFORE UPDATE OF rate_limit_scope_hash ON public.command_records
  FOR EACH ROW
  EXECUTE FUNCTION public.worldgraph_protect_command_rate_limit_scope();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_protect_command_rate_limit_scope()
  FROM PUBLIC;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT INSERT (rate_limit_scope_hash)
      ON public.command_records TO worldgraph_app;
  END IF;
END
$grant$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_open_command_write(
  checked_command_id uuid,
  checked_world_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command record;
  commerce_command boolean;
  has_core boolean;
  has_expansion boolean;
  head_row_version bigint;
  head_checksum bytea;
  checkpoint_event_sequence bigint;
  checkpoint_checksum bytea;
  checkpoint_status projection_checkpoint_status;
BEGIN
  SELECT command.* INTO checked_command
  FROM public.command_records command
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'command write gate requires the matching received command'
      USING ERRCODE = '55000';
  END IF;
  commerce_command := checked_command.command_type IN (
    'InitializeWorldCommerceV1','CreateBusinessV1','ConfigureBusinessFacilityV1',
    'CreateEmploymentContractV1','AcceptEmploymentContractV1',
    'EndEmploymentContractV1','PerformJobV1','StartProductionRunV1',
    'CreateMarketListingV1','CancelMarketListingV1','PurchaseMarketListingV1',
    'ReconcileWorldCommerceV1','CompleteProductionRunV1','SettlePayrollV1',
    'ExpireMarketListingV1','AssessPeriodicTaxV1','RepairEconomicProjectionV1'
  );
  PERFORM public.worldgraph_open_command_write_m08(checked_command_id, checked_world_id);
  IF NOT commerce_command THEN RETURN; END IF;

  IF checked_command.command_type = 'RepairEconomicProjectionV1' AND NOT (
    checked_command.actor_type = 'platform_admin'::command_actor_type
    AND checked_command.payload_classification = 'private'::payload_classification
    AND checked_command.payload ->> 'confirmation' = 'APPLY APPEND-ONLY COMMERCE REPAIR'
  ) THEN
    RAISE EXCEPTION 'commerce repair requires its private administrative gate'
      USING ERRCODE = '42501';
  END IF;
  has_core := public.worldgraph_economy_runtime_state_exists(checked_world_id);
  has_expansion := public.worldgraph_economy_expansion_runtime_state_exists(checked_world_id);
  IF NOT has_core THEN
    RAISE EXCEPTION 'world commerce requires an initialized M08 economy core'
      USING ERRCODE = '55000';
  ELSIF checked_command.command_type = 'InitializeWorldCommerceV1' AND has_expansion THEN
    RAISE EXCEPTION 'world commerce is already initialized' USING ERRCODE = '55000';
  ELSIF checked_command.command_type <> 'InitializeWorldCommerceV1'
    AND (NOT has_core OR NOT has_expansion) THEN
    RAISE EXCEPTION 'world commerce is not initialized' USING ERRCODE = '55000';
  END IF;
  IF has_core AND checked_command.command_type NOT IN (
      'ReconcileWorldCommerceV1','RepairEconomicProjectionV1'
    ) THEN
    PERFORM public.worldgraph_assert_economy_projection_current(checked_world_id);
  END IF;
  IF has_expansion AND checked_command.command_type NOT IN (
      'ReconcileWorldCommerceV1','RepairEconomicProjectionV1'
    ) THEN
    PERFORM public.worldgraph_assert_economy_expansion_projection_current(checked_world_id);
  END IF;
  IF has_expansion THEN
    SELECT head.row_version, head.checksum
      INTO head_row_version, head_checksum
    FROM public.world_economy_expansion_heads head
    WHERE head.world_id = checked_world_id;
    SELECT checkpoint.last_event_sequence, checkpoint.checksum, checkpoint.status
      INTO checkpoint_event_sequence, checkpoint_checksum, checkpoint_status
    FROM public.projection_checkpoints checkpoint
    WHERE checkpoint.world_id = checked_world_id
      AND checkpoint.projection_name = 'economy_closed_loop';
    IF checkpoint_event_sequence IS NULL OR checkpoint_checksum IS NULL
      OR checkpoint_status IS NULL THEN
      RAISE EXCEPTION 'commerce command write requires its projection checkpoint'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  INSERT INTO public.economy_expansion_command_write_snapshots(
    command_id, world_id, expansion_state_exists,
    opened_head_row_version, opened_head_checksum,
    opened_checkpoint_event_sequence, opened_checkpoint_checksum,
    opened_checkpoint_status
  ) VALUES (
    checked_command_id, checked_world_id, has_expansion,
    head_row_version, head_checksum,
    checkpoint_event_sequence, checkpoint_checksum, checkpoint_status
  ) ON CONFLICT (command_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public.economy_expansion_command_write_snapshots snapshot
    WHERE snapshot.command_id = checked_command_id
      AND snapshot.world_id = checked_world_id
      AND snapshot.expansion_state_exists = has_expansion
      AND snapshot.opened_head_row_version IS NOT DISTINCT FROM head_row_version
      AND snapshot.opened_head_checksum IS NOT DISTINCT FROM head_checksum
      AND snapshot.opened_checkpoint_event_sequence
        IS NOT DISTINCT FROM checkpoint_event_sequence
      AND snapshot.opened_checkpoint_checksum IS NOT DISTINCT FROM checkpoint_checksum
      AND snapshot.opened_checkpoint_status IS NOT DISTINCT FROM checkpoint_status
  ) THEN
    RAISE EXCEPTION 'commerce command write snapshot is inconsistent'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_open_command_write(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_protect_commerce_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  row_value jsonb := to_jsonb(NEW);
  checked_world_id uuid := (row_value ->> 'world_id')::uuid;
  checked_command_id uuid := COALESCE(
    (row_value ->> 'command_id')::uuid,
    (row_value ->> 'created_command_id')::uuid,
    (row_value ->> 'configured_command_id')::uuid,
    (row_value ->> 'start_command_id')::uuid
  );
  checked_command_type text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  checked_command_type := public.worldgraph_commerce_command_type(checked_world_id);
  IF checked_command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id', true), '')::uuid THEN
    RAISE EXCEPTION '% fact requires its exact open command', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF (TG_TABLE_NAME IN (
      'resource_types','production_recipes','production_recipe_versions',
      'employment_offers','tax_policies'
    ) AND checked_command_type IS DISTINCT FROM 'InitializeWorldCommerceV1')
    OR (TG_TABLE_NAME = 'business_facility_recipe_versions'
      AND checked_command_type NOT IN (
        'InitializeWorldCommerceV1','ConfigureBusinessFacilityV1'
      ))
    OR (TG_TABLE_NAME = 'inventory_movements' AND checked_command_type NOT IN (
      'InitializeWorldCommerceV1','CompleteProductionRunV1','PurchaseMarketListingV1',
      'RepairEconomicProjectionV1'
    ))
    OR (TG_TABLE_NAME = 'production_run_transitions' AND checked_command_type NOT IN (
      'StartProductionRunV1','CompleteProductionRunV1','RepairEconomicProjectionV1'
    ))
    OR (TG_TABLE_NAME = 'work_records'
      AND checked_command_type IS DISTINCT FROM 'PerformJobV1')
    OR (TG_TABLE_NAME = 'market_trades'
      AND checked_command_type IS DISTINCT FROM 'PurchaseMarketListingV1')
    OR (TG_TABLE_NAME = 'tax_assessments' AND checked_command_type NOT IN (
      'PurchaseMarketListingV1','SettlePayrollV1','AssessPeriodicTaxV1'
    ))
    OR (TG_TABLE_NAME = 'economy_expansion_reconciliation_runs'
      AND checked_command_type NOT IN (
        'ReconcileWorldCommerceV1','RepairEconomicProjectionV1'
      )) THEN
    RAISE EXCEPTION '% fact is outside its exact commerce command', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_commerce_fact() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_assert_economy_participant_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  history_record record;
  event_record record;
  expected_category text;
  expected_summary_code text;
  expected_summary_args jsonb;
  participant_binding_valid boolean;
BEGIN
  SELECT history.* INTO history_record
  FROM public.economy_participant_history history
  WHERE history.world_id = NEW.world_id
    AND history.ledger_sequence = NEW.ledger_sequence
    AND history.user_id = NEW.user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT event.* INTO event_record
  FROM public.command_records command
  JOIN public.domain_events event
    ON event.command_id = command.id AND event.world_id = command.world_id
  JOIN public.ledger_entries entry
    ON entry.world_id = event.world_id AND entry.event_id = event.id
   AND entry.command_id = command.id
   AND entry.entry_kind = CASE event.event_type
     WHEN 'WorldEconomyRepairedV1' THEN 'repair_anchor'::ledger_entry_kind
     ELSE 'domain_event'::ledger_entry_kind END
  WHERE command.id = history_record.command_id
    AND command.world_id = history_record.world_id
    AND command.status = 'accepted'::command_record_status
    AND command.resulting_state_revision = history_record.state_revision
    AND event.id = history_record.event_id
    AND event.resulting_state_revision = history_record.state_revision
    AND entry.ledger_sequence = history_record.ledger_sequence;
  IF NOT FOUND
    OR history_record.visibility <> 'participant'::economy_participant_visibility
    OR NOT public.worldgraph_user_controls_economy_entity_v1(
      history_record.world_id,
      history_record.user_id,
      history_record.participant_entity_id
    ) THEN
    RAISE EXCEPTION 'participant history lacks its exact accepted event/controller binding'
      USING ERRCODE = '55000';
  END IF;

  expected_category := CASE event_record.event_type
    WHEN 'CurrencyTransferredV1' THEN 'currency'
    WHEN 'WalletFrozenV1' THEN 'wallet'
    WHEN 'WalletUnfrozenV1' THEN 'wallet'
    WHEN 'AssetOwnershipTransferredV1' THEN 'asset'
    WHEN 'AssetTransferOfferCreatedV1' THEN 'offer'
    WHEN 'AssetTransferOfferCancelledV1' THEN 'offer'
    WHEN 'AssetTransferOfferAcceptedV1' THEN 'offer'
    WHEN 'AssetTransferOfferExpiredV1' THEN 'offer'
    WHEN 'AssetPurchasedV1' THEN 'asset'
    WHEN 'WorldEconomyRepairedV1' THEN 'repair'
  END;
  expected_summary_code := CASE event_record.event_type
    WHEN 'CurrencyTransferredV1' THEN 'CURRENCY_TRANSFERRED'
    WHEN 'WalletFrozenV1' THEN 'WALLET_FROZEN'
    WHEN 'WalletUnfrozenV1' THEN 'WALLET_UNFROZEN'
    WHEN 'AssetOwnershipTransferredV1' THEN 'ASSET_OWNERSHIP_TRANSFERRED'
    WHEN 'AssetTransferOfferCreatedV1' THEN 'ASSET_TRANSFER_OFFER_CREATED'
    WHEN 'AssetTransferOfferCancelledV1' THEN 'ASSET_TRANSFER_OFFER_CANCELLED'
    WHEN 'AssetTransferOfferAcceptedV1' THEN 'ASSET_TRANSFER_OFFER_ACCEPTED'
    WHEN 'AssetTransferOfferExpiredV1' THEN 'ASSET_TRANSFER_OFFER_EXPIRED'
    WHEN 'AssetPurchasedV1' THEN 'ASSET_PURCHASED'
    WHEN 'WorldEconomyRepairedV1' THEN 'WORLD_ECONOMY_REPAIRED'
  END;
  expected_summary_args := CASE event_record.event_type
    WHEN 'CurrencyTransferredV1' THEN jsonb_build_object(
      'transactionId', event_record.payload ->> 'transactionId')
    WHEN 'WalletFrozenV1' THEN jsonb_build_object(
      'walletVersion', event_record.payload ->> 'walletVersion')
    WHEN 'WalletUnfrozenV1' THEN jsonb_build_object(
      'walletVersion', event_record.payload ->> 'walletVersion')
    WHEN 'AssetOwnershipTransferredV1' THEN jsonb_build_object(
      'assetId', event_record.payload ->> 'assetId')
    WHEN 'AssetTransferOfferCreatedV1' THEN jsonb_build_object(
      'expiresAtTick', event_record.payload ->> 'expiresAtTick',
      'offerId', event_record.payload ->> 'offerId')
    WHEN 'AssetTransferOfferCancelledV1' THEN jsonb_build_object(
      'offerId', event_record.payload ->> 'offerId',
      'offerVersion', event_record.payload ->> 'offerVersion')
    WHEN 'AssetTransferOfferAcceptedV1' THEN jsonb_build_object(
      'offerId', event_record.payload ->> 'offerId',
      'offerVersion', event_record.payload ->> 'offerVersion')
    WHEN 'AssetTransferOfferExpiredV1' THEN jsonb_build_object(
      'offerId', event_record.payload ->> 'offerId',
      'offerVersion', event_record.payload ->> 'offerVersion',
      'expiredAtTick', event_record.payload ->> 'expiredAtTick')
    WHEN 'AssetPurchasedV1' THEN jsonb_build_object(
      'assetId', event_record.payload ->> 'assetId',
      'offerId', event_record.payload ->> 'offerId')
    WHEN 'WorldEconomyRepairedV1' THEN jsonb_build_object(
      'reasonCode', event_record.payload ->> 'reasonCode',
      'repairKind', event_record.payload ->> 'repairKind')
  END;

  participant_binding_valid := CASE event_record.event_type
    WHEN 'CurrencyTransferredV1' THEN EXISTS (
      SELECT 1
      FROM public.wallets source_wallet
      JOIN public.wallets destination_wallet
        ON destination_wallet.world_id = source_wallet.world_id
       AND destination_wallet.currency_id = source_wallet.currency_id
      WHERE source_wallet.world_id = history_record.world_id
        AND source_wallet.id::text = event_record.payload ->> 'sourceWalletId'
        AND destination_wallet.id::text = event_record.payload ->> 'destinationWalletId'
        AND (
          (history_record.participant_entity_id = source_wallet.owner_entity_id
            AND history_record.counterparty_entity_id = destination_wallet.owner_entity_id)
          OR
          (history_record.participant_entity_id = destination_wallet.owner_entity_id
            AND history_record.counterparty_entity_id = source_wallet.owner_entity_id)
        )
    )
    WHEN 'WalletFrozenV1' THEN EXISTS (
      SELECT 1 FROM public.wallets wallet
      WHERE wallet.world_id = history_record.world_id
        AND wallet.id::text = event_record.aggregate_id
        AND history_record.participant_entity_id = wallet.owner_entity_id
        AND history_record.counterparty_entity_id IS NULL
    )
    WHEN 'WalletUnfrozenV1' THEN EXISTS (
      SELECT 1 FROM public.wallets wallet
      WHERE wallet.world_id = history_record.world_id
        AND wallet.id::text = event_record.aggregate_id
        AND history_record.participant_entity_id = wallet.owner_entity_id
        AND history_record.counterparty_entity_id IS NULL
    )
    WHEN 'AssetOwnershipTransferredV1' THEN EXISTS (
      SELECT 1 FROM public.asset_transfers transfer
      WHERE transfer.world_id = history_record.world_id
        AND transfer.event_id = history_record.event_id
        AND (
          (history_record.participant_entity_id = transfer.from_owner_entity_id
            AND history_record.counterparty_entity_id = transfer.to_owner_entity_id)
          OR
          (history_record.participant_entity_id = transfer.to_owner_entity_id
            AND history_record.counterparty_entity_id = transfer.from_owner_entity_id)
        )
    )
    WHEN 'AssetTransferOfferCreatedV1' THEN EXISTS (
      SELECT 1 FROM public.asset_transfer_offers offer
      WHERE offer.world_id = history_record.world_id
        AND offer.created_event_id = history_record.event_id
        AND (
          (history_record.participant_entity_id = offer.seller_entity_id
            AND history_record.counterparty_entity_id IS NOT DISTINCT FROM offer.buyer_entity_id)
          OR (offer.buyer_entity_id IS NOT NULL
            AND history_record.participant_entity_id = offer.buyer_entity_id
            AND history_record.counterparty_entity_id = offer.seller_entity_id)
        )
    )
    WHEN 'AssetTransferOfferCancelledV1' THEN EXISTS (
      SELECT 1 FROM public.asset_transfer_offers offer
      WHERE offer.world_id = history_record.world_id
        AND offer.terminal_event_id = history_record.event_id
        AND (
          (history_record.participant_entity_id = offer.seller_entity_id
            AND history_record.counterparty_entity_id IS NOT DISTINCT FROM offer.buyer_entity_id)
          OR (offer.buyer_entity_id IS NOT NULL
            AND history_record.participant_entity_id = offer.buyer_entity_id
            AND history_record.counterparty_entity_id = offer.seller_entity_id)
        )
    )
    WHEN 'AssetTransferOfferAcceptedV1' THEN EXISTS (
      SELECT 1
      FROM public.asset_transfer_offers offer
      JOIN public.asset_transfers transfer
        ON transfer.world_id = offer.world_id
       AND transfer.id = offer.accepted_asset_transfer_id
      WHERE offer.world_id = history_record.world_id
        AND offer.terminal_event_id = history_record.event_id
        AND (
          (history_record.participant_entity_id = transfer.from_owner_entity_id
            AND history_record.counterparty_entity_id = transfer.to_owner_entity_id)
          OR
          (history_record.participant_entity_id = transfer.to_owner_entity_id
            AND history_record.counterparty_entity_id = transfer.from_owner_entity_id)
        )
    )
    WHEN 'AssetTransferOfferExpiredV1' THEN EXISTS (
      SELECT 1 FROM public.asset_transfer_offers offer
      WHERE offer.world_id = history_record.world_id
        AND offer.terminal_event_id = history_record.event_id
        AND (
          (history_record.participant_entity_id = offer.seller_entity_id
            AND history_record.counterparty_entity_id IS NOT DISTINCT FROM offer.buyer_entity_id)
          OR (offer.buyer_entity_id IS NOT NULL
            AND history_record.participant_entity_id = offer.buyer_entity_id
            AND history_record.counterparty_entity_id = offer.seller_entity_id)
        )
    )
    WHEN 'AssetPurchasedV1' THEN EXISTS (
      SELECT 1
      FROM public.asset_transfer_offers offer
      JOIN public.asset_transfers transfer
        ON transfer.world_id = offer.world_id
       AND transfer.id = offer.accepted_asset_transfer_id
      WHERE offer.world_id = history_record.world_id
        AND offer.terminal_command_id = history_record.command_id
        AND (
          (history_record.participant_entity_id = transfer.from_owner_entity_id
            AND history_record.counterparty_entity_id = transfer.to_owner_entity_id)
          OR
          (history_record.participant_entity_id = transfer.to_owner_entity_id
            AND history_record.counterparty_entity_id = transfer.from_owner_entity_id)
        )
    )
    WHEN 'WorldEconomyRepairedV1' THEN EXISTS (
      WITH affected_entities AS (
        SELECT wallet.owner_entity_id AS entity_id
        FROM public.economy_repair_executions execution
        JOIN public.economy_repair_plans plan
          ON plan.id = execution.repair_plan_id AND plan.world_id = execution.world_id
        JOIN public.wallet_postings posting
          ON posting.transaction_id = plan.source_financial_transaction_id
        JOIN public.wallets wallet
          ON wallet.world_id = posting.world_id
         AND wallet.currency_id = posting.currency_id
         AND wallet.id = posting.wallet_id
        WHERE execution.event_id = history_record.event_id
          AND execution.world_id = history_record.world_id
        UNION
        SELECT source.from_owner_entity_id
        FROM public.economy_repair_executions execution
        JOIN public.economy_repair_plans plan
          ON plan.id = execution.repair_plan_id AND plan.world_id = execution.world_id
        JOIN public.asset_transfers source
          ON source.world_id = plan.world_id AND source.id = plan.source_asset_transfer_id
        WHERE execution.event_id = history_record.event_id
          AND execution.world_id = history_record.world_id
        UNION
        SELECT source.to_owner_entity_id
        FROM public.economy_repair_executions execution
        JOIN public.economy_repair_plans plan
          ON plan.id = execution.repair_plan_id AND plan.world_id = execution.world_id
        JOIN public.asset_transfers source
          ON source.world_id = plan.world_id AND source.id = plan.source_asset_transfer_id
        WHERE execution.event_id = history_record.event_id
          AND execution.world_id = history_record.world_id
      )
      SELECT 1
      FROM affected_entities participant
      WHERE participant.entity_id = history_record.participant_entity_id
        AND history_record.counterparty_entity_id IS NULL
    )
    ELSE false
  END;
  IF expected_category IS NULL
    OR history_record.category IS DISTINCT FROM expected_category
    OR history_record.summary_code IS DISTINCT FROM expected_summary_code
    OR history_record.summary_args IS DISTINCT FROM expected_summary_args
    OR participant_binding_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'participant history is not the exact redacted event participant view'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_economy_participant_history() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_protect_commerce_projection_repair_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  row_value jsonb := to_jsonb(NEW);
  checked_plan_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  checked_plan_id := CASE TG_TABLE_NAME
    WHEN 'commerce_projection_repair_plans' THEN (row_value ->> 'id')::uuid
    ELSE (row_value ->> 'repair_plan_id')::uuid
  END;
  IF NULLIF(current_setting('worldgraph.commerce_projection_repair_plan_id', true), '')
      IS DISTINCT FROM checked_plan_id::text THEN
    RAISE EXCEPTION '% insert requires its exact owner repair workflow', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_commerce_projection_repair_evidence()
  FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.economy_expansion_reconciliation_items
  DROP CONSTRAINT economy_expansion_reconciliation_items_kind,
  ADD CONSTRAINT economy_expansion_reconciliation_items_kind CHECK (
    item_kind IN (
      'inventory_quantity','inventory_reservation','business','facility',
      'production','employment_contract','market_listing','market_trade',
      'payroll','tax_assessment','projection_checkpoint',
      'reservation_lifecycle','recipe_version','tax_policy'
    )
  );
--> statement-breakpoint
CREATE INDEX financial_transactions_commerce_timeline_idx
  ON public.financial_transactions
    (world_id, occurred_tick DESC, created_at DESC, id DESC)
  -- PostgreSQL cannot use enum values added earlier in this transaction. These
  -- are every sealed-M08 non-commerce kind; replace this predicate before adding
  -- any future non-commerce transaction kind.
  WHERE transaction_kind NOT IN (
    'initialization'::financial_transaction_kind,
    'issuance'::financial_transaction_kind,
    'transfer'::financial_transaction_kind,
    'asset_purchase'::financial_transaction_kind,
    'compensation'::financial_transaction_kind
  );
--> statement-breakpoint
CREATE INDEX tax_assessments_world_cursor_idx
  ON public.tax_assessments
    (world_id, occurred_tick DESC, id DESC);
--> statement-breakpoint
CREATE TABLE public.commerce_command_payload_facts (
  command_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  command_type text NOT NULL,
  payload jsonb NOT NULL,
  authority jsonb NOT NULL,
  evidence_source text NOT NULL,
  payload_hash bytea NOT NULL,
  authority_hash bytea NOT NULL,
  evidence_checksum bytea NOT NULL,
  boundary_event_sequence bigint NOT NULL,
  boundary_head_checksum bytea NOT NULL,
  boundary_checkpoint_checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_command_payload_facts_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES public.command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT commerce_command_payload_facts_type_valid CHECK (
    command_type IN (
      'CreateEmploymentContractV1','EndEmploymentContractV1',
      'StartProductionRunV1','CreateMarketListingV1',
      'PurchaseMarketListingV1'
    )
  ),
  CONSTRAINT commerce_command_payload_facts_source_valid CHECK (
    evidence_source IN ('migration_baseline','command_hash')
  ),
  CONSTRAINT commerce_command_payload_facts_payload_valid CHECK (
    jsonb_typeof(payload) = 'object'
      AND octet_length(convert_to(
        public.worldgraph_canonical_jsonb(payload), 'UTF8'
      )) <= 32768
      AND octet_length(payload_hash) = 32
      AND payload_hash = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(payload), 'UTF8'
      ), 'sha256')
      AND jsonb_typeof(authority) = 'object'
      AND octet_length(convert_to(
        public.worldgraph_canonical_jsonb(authority), 'UTF8'
      )) <= 65536
      AND octet_length(authority_hash) = 32
      AND authority_hash = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(authority), 'UTF8'
      ), 'sha256')
      AND boundary_event_sequence >= 0
      AND octet_length(boundary_head_checksum) = 32
      AND octet_length(boundary_checkpoint_checksum) = 32
  ),
  CONSTRAINT commerce_command_payload_facts_checksum_valid CHECK (
    octet_length(evidence_checksum) = 32
      AND evidence_checksum = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(jsonb_build_object(
          'commandId', command_id::text,
          'commandType', command_type,
          'evidenceSource', evidence_source,
          'authorityHash', encode(authority_hash, 'hex'),
          'boundaryCheckpointChecksum',
            encode(boundary_checkpoint_checksum, 'hex'),
          'boundaryEventSequence', boundary_event_sequence::text,
          'boundaryHeadChecksum', encode(boundary_head_checksum, 'hex'),
          'payloadHash', encode(payload_hash, 'hex'),
          'worldId', world_id::text
        )), 'UTF8'
      ), 'sha256')
  )
);
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_commerce_command_authority_document(
  checked_command_id uuid,
  checked_world_id uuid,
  checked_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  authority_document jsonb;
  checked_command_type text;
  expected_inventory_ids jsonb;
  actual_inventory_ids jsonb;
  evidence_count integer;
BEGIN
  SELECT command.command_type INTO checked_command_type
  FROM public.command_records command
  WHERE command.id = checked_command_id
    AND command.world_id = checked_world_id
    AND command.status IN (
      'received'::command_record_status,
      'accepted'::command_record_status
    );
  IF checked_command_type IS NULL
    OR checked_payload IS NULL
    OR jsonb_typeof(checked_payload) <> 'object' THEN
    RAISE EXCEPTION 'commerce command authority requires its bounded command payload'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_command_authority_payload_valid';
  END IF;

  CASE checked_command_type
    WHEN 'CreateEmploymentContractV1' THEN
      SELECT jsonb_build_object(
        'businessId', contract.business_id::text,
        'contractId', contract.id::text,
        'cooldownTicks', contract.cooldown_ticks::text,
        'createdEventId', contract.created_event_id::text,
        'createdStateRevision', contract.created_state_revision::text,
        'currencyId', contract.currency_id::text,
        'effectiveFromTick', contract.effective_from_tick::text,
        'effectiveToTick', contract.effective_until_tick::text,
        'employerEntityId', employer_wallet.owner_entity_id::text,
        'employerWalletId', contract.employer_wallet_id::text,
        'maxPerformancesPerPeriod', contract.max_payments_per_period,
        'periodTicks', contract.cadence_ticks::text,
        'rewardCapMinor', contract.reward_cap_minor::text,
        'roleCode', contract.role_code,
        'wageMinor', contract.wage_minor::text,
        'wageRuleKind', contract.wage_rule::text,
        'workerEntityId', contract.worker_entity_id::text,
        'workerEntityKey', worker.logical_key::text,
        'workerWalletId', contract.worker_wallet_id::text
      ) INTO authority_document
      FROM public.employment_contracts contract
      JOIN public.world_entities worker
        ON worker.world_id = contract.world_id
       AND worker.id = contract.worker_entity_id
      JOIN public.businesses business
        ON business.world_id = contract.world_id
       AND business.id = contract.business_id
      JOIN public.wallets employer_wallet
        ON employer_wallet.world_id = contract.world_id
       AND employer_wallet.id = contract.employer_wallet_id
       AND employer_wallet.owner_entity_id =
         business.backing_organization_entity_id
       AND employer_wallet.currency_id = contract.currency_id
      JOIN public.wallets worker_wallet
        ON worker_wallet.world_id = contract.world_id
       AND worker_wallet.id = contract.worker_wallet_id
       AND worker_wallet.owner_entity_id = contract.worker_entity_id
       AND worker_wallet.currency_id = contract.currency_id
      JOIN public.domain_events event
        ON event.world_id = contract.world_id
       AND event.id = contract.created_event_id
       AND event.command_id = contract.created_command_id
       AND event.aggregate_type = 'employment_contract'
       AND event.aggregate_id = contract.id::text
       AND event.aggregate_version = 1
       AND event.event_type = 'EmploymentContractCreatedV1'
       AND event.resulting_state_revision = contract.created_state_revision
       AND event.payload ->> 'businessId' = contract.business_id::text
       AND event.payload ->> 'contractId' = contract.id::text
       AND event.payload ->> 'workerEntityId' = contract.worker_entity_id::text
       AND event.payload ->> 'status' = 'offered'
      WHERE contract.world_id = checked_world_id
        AND contract.created_command_id = checked_command_id
        AND checked_payload ->> 'businessId' = contract.business_id::text
        AND (checked_payload ->> 'cooldownTicks')::bigint
          = contract.cooldown_ticks
        AND (checked_payload ->> 'effectiveFromTick')::bigint
          = contract.effective_from_tick
        AND (checked_payload ->> 'effectiveToTick')::bigint
          = contract.effective_until_tick
        AND checked_payload ->> 'employerWalletId'
          = contract.employer_wallet_id::text
        AND (checked_payload ->> 'maxPerformancesPerPeriod')::integer
          = contract.max_payments_per_period
        AND (checked_payload ->> 'periodTicks')::bigint
          = contract.cadence_ticks
        AND (checked_payload ->> 'rewardCapMinor')::bigint
          = contract.reward_cap_minor
        AND checked_payload ->> 'roleCode' = contract.role_code
        AND (checked_payload ->> 'wageMinor')::bigint = contract.wage_minor
        AND checked_payload ->> 'wageRuleKind' = contract.wage_rule::text
        AND checked_payload ->> 'workerEntityKey' = worker.logical_key::text
        AND checked_payload ->> 'workerWalletId'
          = contract.worker_wallet_id::text;
    WHEN 'EndEmploymentContractV1' THEN
      SELECT jsonb_build_object(
        'contractId', contract.id::text,
        'reason', contract.terminal_reason,
        'terminalEventId', contract.terminal_event_id::text,
        'terminalStateRevision', contract.terminal_state_revision::text
      ) INTO authority_document
      FROM public.employment_contracts contract
      JOIN public.domain_events event
        ON event.world_id = contract.world_id
       AND event.id = contract.terminal_event_id
       AND event.command_id = contract.terminal_command_id
       AND event.aggregate_type = 'employment_contract'
       AND event.aggregate_id = contract.id::text
       AND event.aggregate_version = contract.row_version
       AND event.event_type = 'EmploymentContractEndedV1'
       AND event.resulting_state_revision = contract.terminal_state_revision
       AND event.payload ->> 'contractId' = contract.id::text
       AND event.payload ->> 'status' = 'ended'
      WHERE contract.world_id = checked_world_id
        AND contract.terminal_command_id = checked_command_id
        AND contract.status = 'ended'::employment_contract_status
        AND checked_payload ->> 'contractId' = contract.id::text
        AND checked_payload ->> 'reason' = contract.terminal_reason;
    WHEN 'StartProductionRunV1' THEN
      SELECT COALESCE(jsonb_agg(
        expected.value ->> 'inventoryId'
        ORDER BY expected.value ->> 'inventoryId'
      ), '[]'::jsonb)
        INTO expected_inventory_ids
      FROM jsonb_array_elements(
        COALESCE(checked_payload -> 'expectedInventories', '[]'::jsonb)
      ) expected(value);
      SELECT COALESCE(jsonb_agg(
        reservation.inventory_id::text ORDER BY reservation.inventory_id
      ), '[]'::jsonb)
        INTO actual_inventory_ids
      FROM public.production_runs run
      JOIN public.inventory_reservations reservation
        ON reservation.world_id = run.world_id
       AND reservation.purpose_type = 'production_input'
       AND reservation.purpose_id = run.id
       AND reservation.created_command_id = run.start_command_id
       AND reservation.created_event_id = run.start_event_id
      WHERE run.world_id = checked_world_id
        AND run.start_command_id = checked_command_id;
      IF expected_inventory_ids IS DISTINCT FROM actual_inventory_ids THEN
        RAISE EXCEPTION 'production authority inventory binding is ambiguous'
          USING ERRCODE = '23514',
            CONSTRAINT = 'commerce_command_authority_production_inventory_exact';
      END IF;
      IF EXISTS (
        WITH expected AS (
          SELECT item.value ->> 'resourceTypeId' AS resource_type_id,
                 (item.value ->> 'quantity')::numeric AS quantity
          FROM public.production_runs run
          CROSS JOIN LATERAL jsonb_array_elements(run.input_snapshot) item(value)
          WHERE run.world_id = checked_world_id
            AND run.start_command_id = checked_command_id
        ),
        actual AS (
          SELECT inventory.resource_type_id::text AS resource_type_id,
                 sum(reservation.quantity)::numeric AS quantity
          FROM public.production_runs run
          JOIN public.inventory_reservations reservation
            ON reservation.world_id = run.world_id
           AND reservation.purpose_type = 'production_input'
           AND reservation.purpose_id = run.id
           AND reservation.created_command_id = run.start_command_id
           AND reservation.created_event_id = run.start_event_id
          JOIN public.inventories inventory
            ON inventory.world_id = reservation.world_id
           AND inventory.id = reservation.inventory_id
          WHERE run.world_id = checked_world_id
            AND run.start_command_id = checked_command_id
          GROUP BY inventory.resource_type_id
        )
        SELECT 1
        FROM expected
        FULL JOIN actual USING (resource_type_id)
        WHERE expected.resource_type_id IS NULL
          OR actual.resource_type_id IS NULL
          OR expected.quantity IS DISTINCT FROM actual.quantity
      ) THEN
        RAISE EXCEPTION 'production authority snapshot and reservations disagree'
          USING ERRCODE = '23514',
            CONSTRAINT = 'commerce_command_authority_production_snapshot_exact';
      END IF;
      SELECT jsonb_build_object(
        'businessId', run.business_id::text,
        'createdEventId', run.start_event_id::text,
        'createdStateRevision', run.created_state_revision::text,
        'dueTick', run.due_tick::text,
        'facilityId', run.facility_id::text,
        'inputInventoryBindings', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'inventoryId', reservation.inventory_id::text,
            'quantity', reservation.quantity::numeric(30,12)::text,
            'reservationId', reservation.id::text,
            'resourceTypeId', inventory.resource_type_id::text
          ) ORDER BY reservation.inventory_id)
          FROM public.inventory_reservations reservation
          JOIN public.inventories inventory
            ON inventory.world_id = reservation.world_id
           AND inventory.id = reservation.inventory_id
          WHERE reservation.world_id = run.world_id
            AND reservation.purpose_type = 'production_input'
            AND reservation.purpose_id = run.id
            AND reservation.created_command_id = run.start_command_id
            AND reservation.created_event_id = run.start_event_id
        ), '[]'::jsonb),
        'inputSnapshot', run.input_snapshot,
        'initialTransition', jsonb_build_object(
          'commandId', transition.command_id::text,
          'eventId', transition.event_id::text,
          'occurredTick', transition.occurred_tick::text,
          'snapshotChecksum', encode(transition.snapshot_hash, 'hex'),
          'stateRevision', transition.state_revision::text,
          'status', transition.status::text,
          'transitionVersion', transition.transition_version::text
        ),
        'outputSnapshot', run.output_snapshot,
        'productionRunId', run.id::text,
        'recipeVersionId', run.recipe_version_id::text,
        'runQuantity', run.quantity::numeric(30,12)::text,
        'scheduledActionId', run.scheduled_action_id::text,
        'snapshotChecksum', encode(run.snapshot_checksum, 'hex')
      ) INTO authority_document
      FROM public.production_runs run
      JOIN public.production_run_transitions transition
        ON transition.world_id = run.world_id
       AND transition.run_id = run.id
       AND transition.transition_version = 1
       AND transition.status = 'ready'::production_run_status
       AND transition.command_id = run.start_command_id
       AND transition.event_id = run.start_event_id
       AND transition.state_revision = run.created_state_revision
       AND transition.snapshot_hash = run.snapshot_checksum
      JOIN public.domain_events event
        ON event.world_id = run.world_id
       AND event.id = run.start_event_id
       AND event.command_id = run.start_command_id
       AND event.aggregate_type = 'production_run'
       AND event.aggregate_id = run.id::text
       AND event.aggregate_version = 1
       AND event.event_ordinal = 0
       AND event.event_type = 'ProductionRunStartedV1'
       AND event.resulting_state_revision = run.created_state_revision
       AND event.payload ->> 'productionRunId' = run.id::text
       AND event.payload ->> 'recipeVersionId' = run.recipe_version_id::text
       AND event.payload ->> 'scheduledActionId' = run.scheduled_action_id::text
       AND (event.payload ->> 'dueTick')::bigint = run.due_tick
       AND (event.payload ->> 'tick')::bigint = transition.occurred_tick
      JOIN public.scheduled_actions schedule
        ON schedule.world_id = run.world_id
       AND schedule.id = run.scheduled_action_id
       AND schedule.created_command_id = run.start_command_id
       AND schedule.action_type = 'CompleteProductionRunV1'
       AND schedule.due_tick = run.due_tick
       AND schedule.payload ->> 'productionRunId' = run.id::text
      JOIN public.domain_events schedule_event
        ON schedule_event.world_id = schedule.world_id
       AND schedule_event.command_id = schedule.created_command_id
       AND schedule_event.aggregate_type = 'scheduled_action'
       AND schedule_event.aggregate_id = schedule.id::text
       AND schedule_event.event_type = 'ScheduledActionCreatedV1'
       AND schedule_event.resulting_state_revision = run.created_state_revision
       AND schedule_event.payload ->> 'scheduleId' = schedule.id::text
       AND schedule_event.payload ->> 'actionType' = schedule.action_type::text
       AND (schedule_event.payload ->> 'dueTick')::bigint = schedule.due_tick
      WHERE run.world_id = checked_world_id
        AND run.start_command_id = checked_command_id
        AND checked_payload ->> 'businessId' = run.business_id::text
        AND checked_payload ->> 'facilityId' = run.facility_id::text
        AND checked_payload ->> 'recipeVersionId' = run.recipe_version_id::text
        AND (checked_payload ->> 'runQuantity')::numeric = run.quantity
        AND run.snapshot_checksum = extensions.digest(convert_to(
          public.worldgraph_canonical_jsonb(jsonb_build_object(
            'inputs', run.input_snapshot,
            'outputs', run.output_snapshot
          )), 'UTF8'
        ), 'sha256');
    WHEN 'CreateMarketListingV1' THEN
      SELECT count(*)::integer INTO evidence_count
      FROM public.market_listings listing
      JOIN public.inventory_reservations reservation
        ON reservation.world_id = listing.world_id
       AND reservation.purpose_type = 'market_listing'
       AND reservation.purpose_id = listing.id
       AND reservation.created_command_id = listing.created_command_id
       AND reservation.created_event_id = listing.created_event_id
      WHERE listing.world_id = checked_world_id
        AND listing.created_command_id = checked_command_id;
      IF evidence_count <> 1 THEN
        RAISE EXCEPTION 'market listing authority reservation is ambiguous'
          USING ERRCODE = '23514',
            CONSTRAINT = 'commerce_command_authority_listing_reservation_exact';
      END IF;
      SELECT jsonb_build_object(
        'createdEventId', listing.created_event_id::text,
        'createdStateRevision', listing.created_state_revision::text,
        'currencyId', listing.currency_id::text,
        'expiresAtTick', listing.expires_at_tick::text,
        'listingId', listing.id::text,
        'offeredQuantity', listing.offered_quantity::numeric(30,12)::text,
        'reservationId', reservation.id::text,
        'resourceTypeId', listing.resource_type_id::text,
        'scheduledActionId', listing.scheduled_action_id::text,
        'sellerEntityId', listing.seller_entity_id::text,
        'sellerInventoryId', listing.seller_inventory_id::text,
        'sellerWalletId', listing.seller_wallet_id::text,
        'unitPriceMinor', listing.unit_price_minor::text
      ) INTO authority_document
      FROM public.market_listings listing
      JOIN public.inventories inventory
        ON inventory.world_id = listing.world_id
       AND inventory.id = listing.seller_inventory_id
       AND inventory.owner_entity_id = listing.seller_entity_id
       AND inventory.resource_type_id = listing.resource_type_id
      JOIN public.wallets wallet
        ON wallet.world_id = listing.world_id
       AND wallet.id = listing.seller_wallet_id
       AND wallet.owner_entity_id = listing.seller_entity_id
       AND wallet.currency_id = listing.currency_id
      JOIN public.inventory_reservations reservation
        ON reservation.world_id = listing.world_id
       AND reservation.purpose_type = 'market_listing'
       AND reservation.purpose_id = listing.id
       AND reservation.inventory_id = listing.seller_inventory_id
       AND reservation.expires_at_tick = listing.expires_at_tick
       AND reservation.created_command_id = listing.created_command_id
       AND reservation.created_event_id = listing.created_event_id
      JOIN public.domain_events event
        ON event.world_id = listing.world_id
       AND event.id = listing.created_event_id
       AND event.command_id = listing.created_command_id
       AND event.aggregate_type = 'market_listing'
       AND event.aggregate_id = listing.id::text
       AND event.aggregate_version = 1
       AND event.event_type = 'MarketListingCreatedV1'
       AND event.resulting_state_revision = listing.created_state_revision
       AND event.payload ->> 'listingId' = listing.id::text
       AND (event.payload ->> 'remainingQuantity')::numeric
         = listing.offered_quantity
       AND event.payload ->> 'status' = 'open'
      JOIN LATERAL (
        SELECT lifecycle.id, lifecycle.command_id,
               lifecycle.aggregate_version, lifecycle.event_type,
               lifecycle.payload, lifecycle.resulting_state_revision
        FROM public.domain_events lifecycle
        WHERE lifecycle.world_id = listing.world_id
          AND lifecycle.aggregate_type = 'market_listing'
          AND lifecycle.aggregate_id = listing.id::text
          AND lifecycle.event_type IN (
            'MarketListingCreatedV1','MarketListingPartiallyFilledV1',
            'MarketListingFilledV1','MarketListingCancelledV1',
            'MarketListingExpiredV1'
          )
        ORDER BY lifecycle.aggregate_version DESC
        LIMIT 1
      ) latest ON true
      JOIN public.scheduled_actions schedule
        ON schedule.world_id = listing.world_id
       AND schedule.id = listing.scheduled_action_id
       AND schedule.created_command_id = listing.created_command_id
       AND schedule.action_type = 'ExpireMarketListingV1'
       AND schedule.due_tick = listing.expires_at_tick
       AND schedule.payload ->> 'listingId' = listing.id::text
      JOIN public.domain_events schedule_event
        ON schedule_event.world_id = schedule.world_id
       AND schedule_event.command_id = schedule.created_command_id
       AND schedule_event.aggregate_type = 'scheduled_action'
       AND schedule_event.aggregate_id = schedule.id::text
       AND schedule_event.event_type = 'ScheduledActionCreatedV1'
       AND schedule_event.resulting_state_revision = listing.created_state_revision
       AND schedule_event.payload ->> 'scheduleId' = schedule.id::text
       AND schedule_event.payload ->> 'actionType' = schedule.action_type::text
       AND (schedule_event.payload ->> 'dueTick')::bigint = schedule.due_tick
      WHERE listing.world_id = checked_world_id
        AND listing.created_command_id = checked_command_id
        AND (checked_payload ->> 'expiresAtTick')::bigint
          = listing.expires_at_tick
        AND (checked_payload ->> 'quantity')::numeric
          = listing.offered_quantity
        AND checked_payload ->> 'sellerInventoryId'
          = listing.seller_inventory_id::text
        AND checked_payload ->> 'sellerWalletId'
          = listing.seller_wallet_id::text
        AND (checked_payload ->> 'unitPriceMinor')::bigint
          = listing.unit_price_minor
        AND latest.aggregate_version = listing.row_version
        AND latest.payload ->> 'status' = listing.status::text
        AND (latest.payload ->> 'remainingQuantity')::numeric
          = listing.remaining_quantity
        AND reservation.row_version = latest.aggregate_version
        AND reservation.status = CASE latest.payload ->> 'status'
          WHEN 'filled' THEN 'consumed'::inventory_reservation_status
          WHEN 'cancelled' THEN 'released'::inventory_reservation_status
          WHEN 'expired' THEN 'expired'::inventory_reservation_status
          ELSE 'active'::inventory_reservation_status
        END
        AND reservation.quantity = CASE
          WHEN latest.payload ->> 'status' = 'filled' THEN (
            SELECT (trade.payload ->> 'quantity')::numeric
            FROM public.domain_events trade
            WHERE trade.world_id = listing.world_id
              AND trade.command_id = latest.command_id
              AND trade.event_type = 'MarketTradeCompletedV1'
            LIMIT 1
          )
          ELSE (latest.payload ->> 'remainingQuantity')::numeric
        END
        AND reservation.terminal_command_id IS NOT DISTINCT FROM CASE
          WHEN latest.payload ->> 'status' IN (
            'filled','cancelled','expired'
          ) THEN latest.command_id
          ELSE NULL
        END
        AND reservation.terminal_event_id IS NOT DISTINCT FROM CASE
          WHEN latest.payload ->> 'status' IN (
            'filled','cancelled','expired'
          ) THEN latest.id
          ELSE NULL
        END
        AND reservation.terminal_state_revision IS NOT DISTINCT FROM CASE
          WHEN latest.payload ->> 'status' IN (
            'filled','cancelled','expired'
          ) THEN latest.resulting_state_revision
          ELSE NULL
        END;
    WHEN 'PurchaseMarketListingV1' THEN
      SELECT count(*)::integer INTO evidence_count
      FROM public.market_trades trade
      JOIN public.inventory_movements movement
        ON movement.world_id = trade.world_id
       AND movement.source_type = 'market_trade'
       AND movement.source_id = trade.id
       AND movement.movement_kind = 'market_trade'
       AND movement.command_id = trade.command_id
      JOIN public.financial_transactions transaction
        ON transaction.world_id = trade.world_id
       AND transaction.id = trade.wallet_transaction_id
       AND transaction.command_id = trade.command_id
       AND transaction.transaction_kind::text = 'market_purchase'
      WHERE trade.world_id = checked_world_id
        AND trade.command_id = checked_command_id;
      IF evidence_count <> 1 THEN
        RAISE EXCEPTION 'market trade authority journal is ambiguous'
          USING ERRCODE = '23514',
            CONSTRAINT = 'commerce_command_authority_trade_journal_exact';
      END IF;
      SELECT jsonb_build_object(
        'buyerEntityId', trade.buyer_entity_id::text,
        'buyerInventoryId', trade.buyer_inventory_id::text,
        'buyerWalletId', buyer.wallet_id::text,
        'currencyId', trade.currency_id::text,
        'eventId', trade.event_id::text,
        'listingId', trade.listing_id::text,
        'movementId', movement.id::text,
        'quantity', trade.quantity::numeric(30,12)::text,
        'sellerEntityId', trade.seller_entity_id::text,
        'sellerInventoryId', trade.seller_inventory_id::text,
        'sellerWalletId', listing.seller_wallet_id::text,
        'stateRevision', trade.state_revision::text,
        'tradeId', trade.id::text,
        'unitPriceMinor', trade.unit_price_minor::text,
        'walletTransactionId', trade.wallet_transaction_id::text
      ) INTO authority_document
      FROM public.market_trades trade
      JOIN public.market_listings listing
        ON listing.world_id = trade.world_id
       AND listing.id = trade.listing_id
       AND listing.seller_entity_id = trade.seller_entity_id
       AND listing.seller_inventory_id = trade.seller_inventory_id
       AND listing.currency_id = trade.currency_id
      JOIN public.inventory_movements movement
        ON movement.world_id = trade.world_id
       AND movement.source_type = 'market_trade'
       AND movement.source_id = trade.id
       AND movement.source_ordinal = 0
       AND movement.movement_kind = 'market_trade'
       AND movement.command_id = trade.command_id
       AND movement.from_inventory_id = trade.seller_inventory_id
       AND movement.to_inventory_id = trade.buyer_inventory_id
       AND movement.resource_type_id = listing.resource_type_id
       AND movement.quantity = trade.quantity
       AND movement.state_revision = trade.state_revision
      JOIN public.domain_events event
        ON event.world_id = trade.world_id
       AND event.id = trade.event_id
       AND event.command_id = trade.command_id
       AND event.aggregate_type = 'market_trade'
       AND event.aggregate_id = trade.id::text
       AND event.aggregate_version = 1
       AND event.event_type = 'MarketTradeCompletedV1'
       AND event.resulting_state_revision = trade.state_revision
       AND event.payload ->> 'tradeId' = trade.id::text
       AND event.payload ->> 'listingId' = trade.listing_id::text
       AND (event.payload ->> 'quantity')::numeric = trade.quantity
       AND (event.payload ->> 'buyerTotalMinor')::bigint
         = trade.buyer_total_minor
       AND (event.payload ->> 'sellerNetMinor')::bigint
         = trade.seller_net_minor
      JOIN public.financial_transactions transaction
        ON transaction.world_id = trade.world_id
       AND transaction.id = trade.wallet_transaction_id
       AND transaction.command_id = trade.command_id
       AND transaction.transaction_kind::text = 'market_purchase'
       AND transaction.currency_id = trade.currency_id
       AND transaction.state_revision = trade.state_revision
       AND transaction.occurred_tick = trade.occurred_tick
      JOIN LATERAL (
        SELECT max(posting.wallet_id::text)::uuid AS wallet_id
        FROM public.wallet_postings posting
        JOIN public.wallets wallet
          ON wallet.world_id = trade.world_id
         AND wallet.id = posting.wallet_id
         AND wallet.owner_entity_id = trade.buyer_entity_id
        WHERE posting.transaction_id = transaction.id
          AND posting.signed_amount_minor < 0
        HAVING count(*) = 1
      ) buyer ON true
      WHERE trade.world_id = checked_world_id
        AND trade.command_id = checked_command_id
        AND checked_payload ->> 'buyerWalletId' = buyer.wallet_id::text
        AND checked_payload ->> 'listingId' = trade.listing_id::text
        AND (checked_payload ->> 'quantity')::numeric = trade.quantity
        AND (
          checked_payload ->> 'buyerInventoryId' IS NULL
          OR checked_payload ->> 'buyerInventoryId'
            = trade.buyer_inventory_id::text
        )
        AND EXISTS (
          SELECT 1
          FROM public.wallet_postings seller_posting
          WHERE seller_posting.transaction_id = transaction.id
            AND seller_posting.wallet_id = listing.seller_wallet_id
            AND seller_posting.signed_amount_minor =
              trade.seller_net_minor + COALESCE((
                SELECT sum((assessment.payload ->> 'amountMinor')::bigint)
                FROM public.domain_events assessment
                JOIN public.tax_policies policy
                  ON policy.world_id = assessment.world_id
                 AND policy.id =
                   (assessment.payload ->> 'policyId')::uuid
                 AND policy.treasury_wallet_id =
                   listing.seller_wallet_id
                WHERE assessment.world_id = trade.world_id
                  AND assessment.command_id = trade.command_id
                  AND assessment.event_type = 'TaxAssessedV1'
              ), 0)
        )
        AND (
          SELECT COALESCE(sum(posting.signed_amount_minor), 0)
          FROM public.wallet_postings posting
          WHERE posting.transaction_id = transaction.id
        ) = 0;
    ELSE
      RAISE EXCEPTION 'commerce command type has no payload authority model'
        USING ERRCODE = '23514',
          CONSTRAINT = 'commerce_command_authority_type_valid';
  END CASE;

  IF authority_document IS NULL THEN
    RAISE EXCEPTION 'commerce command authority evidence is inconsistent or incomplete'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_command_authority_evidence_exact';
  END IF;
  RETURN authority_document;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_commerce_command_authority_document(uuid,uuid,jsonb)
  FROM PUBLIC;
--> statement-breakpoint
WITH baseline_payloads AS (
  SELECT contract.created_command_id AS command_id, contract.world_id,
         'CreateEmploymentContractV1'::text AS command_type,
         jsonb_build_object(
           'businessId', contract.business_id::text,
           'cooldownTicks', contract.cooldown_ticks::text,
           'effectiveFromTick', contract.effective_from_tick::text,
           'effectiveToTick', contract.effective_until_tick::text,
           'employerWalletId', contract.employer_wallet_id::text,
           'maxPerformancesPerPeriod', contract.max_payments_per_period,
           'periodTicks', contract.cadence_ticks::text,
           'rewardCapMinor', contract.reward_cap_minor::text,
           'roleCode', contract.role_code,
           'wageMinor', contract.wage_minor::text,
           'wageRuleKind', contract.wage_rule::text,
           'workerEntityKey', worker.logical_key::text,
           'workerWalletId', contract.worker_wallet_id::text
         ) AS payload,
         contract.created_at
  FROM public.employment_contracts contract
  JOIN public.world_entities worker
    ON worker.world_id = contract.world_id
   AND worker.id = contract.worker_entity_id
  JOIN public.command_records command
    ON command.id = contract.created_command_id
   AND command.world_id = contract.world_id
   AND command.command_type = 'CreateEmploymentContractV1'
   AND command.status = 'accepted'::command_record_status
   AND command.payload IS NULL
  UNION ALL
  SELECT contract.terminal_command_id, contract.world_id,
         'EndEmploymentContractV1',
         jsonb_build_object(
           'contractId', contract.id::text,
           'reason', contract.terminal_reason
         ),
         contract.updated_at
  FROM public.employment_contracts contract
  JOIN public.command_records command
    ON command.id = contract.terminal_command_id
   AND command.world_id = contract.world_id
   AND command.command_type = 'EndEmploymentContractV1'
   AND command.status = 'accepted'::command_record_status
   AND command.payload IS NULL
  WHERE contract.terminal_command_id IS NOT NULL
    AND contract.terminal_reason IS NOT NULL
  UNION ALL
  SELECT run.start_command_id, run.world_id, 'StartProductionRunV1',
         jsonb_build_object(
           'businessId', run.business_id::text,
           'expectedInventories', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'inventoryId', reservation.inventory_id::text
             ) ORDER BY reservation.inventory_id)
             FROM public.inventory_reservations reservation
             WHERE reservation.world_id = run.world_id
               AND reservation.purpose_type = 'production_input'
               AND reservation.purpose_id = run.id
               AND reservation.created_command_id = run.start_command_id
           ), '[]'::jsonb),
           'facilityId', run.facility_id::text,
           'recipeVersionId', run.recipe_version_id::text,
           'runQuantity', run.quantity::numeric(30,12)::text
         ),
         run.created_at
  FROM public.production_runs run
  JOIN public.command_records command
    ON command.id = run.start_command_id
   AND command.world_id = run.world_id
   AND command.command_type = 'StartProductionRunV1'
   AND command.status = 'accepted'::command_record_status
   AND command.payload IS NULL
  UNION ALL
  SELECT listing.created_command_id, listing.world_id, 'CreateMarketListingV1',
         jsonb_build_object(
           'expiresAtTick', listing.expires_at_tick::text,
           'quantity', listing.offered_quantity::numeric(30,12)::text,
           'sellerInventoryId', listing.seller_inventory_id::text,
           'sellerWalletId', listing.seller_wallet_id::text,
           'unitPriceMinor', listing.unit_price_minor::text
         ),
         listing.created_at
  FROM public.market_listings listing
  JOIN public.command_records command
    ON command.id = listing.created_command_id
   AND command.world_id = listing.world_id
   AND command.command_type = 'CreateMarketListingV1'
   AND command.status = 'accepted'::command_record_status
   AND command.payload IS NULL
  UNION ALL
  SELECT trade.command_id, trade.world_id, 'PurchaseMarketListingV1',
         jsonb_build_object(
           'buyerInventoryId', trade.buyer_inventory_id::text,
           'buyerWalletId', buyer.wallet_id::text,
           'listingId', trade.listing_id::text,
           'quantity', trade.quantity::numeric(30,12)::text
         ),
         trade.created_at
  FROM public.market_trades trade
  JOIN public.command_records command
    ON command.id = trade.command_id
   AND command.world_id = trade.world_id
   AND command.command_type = 'PurchaseMarketListingV1'
   AND command.status = 'accepted'::command_record_status
   AND command.payload IS NULL
  JOIN LATERAL (
    SELECT max(posting.wallet_id::text)::uuid AS wallet_id
    FROM public.wallet_postings posting
    JOIN public.wallets wallet
      ON wallet.world_id = trade.world_id
     AND wallet.id = posting.wallet_id
     AND wallet.owner_entity_id = trade.buyer_entity_id
    WHERE posting.transaction_id = trade.wallet_transaction_id
      AND posting.signed_amount_minor < 0
    HAVING count(*) = 1
  ) buyer ON true
),
with_authority AS (
  SELECT baseline.*,
         public.worldgraph_commerce_command_authority_document(
           baseline.command_id, baseline.world_id, baseline.payload
         ) AS authority,
         runtime.last_event_sequence AS boundary_event_sequence,
         head.checksum AS boundary_head_checksum,
         checkpoint.checksum AS boundary_checkpoint_checksum
  FROM baseline_payloads baseline
  JOIN public.world_runtime_heads runtime
    ON runtime.world_id = baseline.world_id
  JOIN public.world_economy_expansion_heads head
    ON head.world_id = baseline.world_id
  JOIN public.projection_checkpoints checkpoint
    ON checkpoint.world_id = baseline.world_id
   AND checkpoint.projection_name = 'economy_closed_loop'
   AND checkpoint.status = 'current'::projection_checkpoint_status
   AND checkpoint.last_event_sequence = runtime.last_event_sequence
   AND checkpoint.checksum = head.checksum
),
normalized AS (
  SELECT authority.*,
         extensions.digest(convert_to(
           public.worldgraph_canonical_jsonb(authority.payload), 'UTF8'
         ), 'sha256') AS payload_hash,
         extensions.digest(convert_to(
           public.worldgraph_canonical_jsonb(authority.authority), 'UTF8'
         ), 'sha256') AS authority_hash
  FROM with_authority authority
)
INSERT INTO public.commerce_command_payload_facts(
  command_id, world_id, command_type, payload, authority,
  evidence_source, payload_hash, authority_hash, evidence_checksum,
  boundary_event_sequence, boundary_head_checksum,
  boundary_checkpoint_checksum, created_at
)
SELECT normalized.command_id, normalized.world_id, normalized.command_type,
       normalized.payload, normalized.authority, 'migration_baseline',
       normalized.payload_hash, normalized.authority_hash,
       extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
         jsonb_build_object(
           'commandId', normalized.command_id::text,
           'commandType', normalized.command_type,
           'evidenceSource', 'migration_baseline',
           'authorityHash', encode(normalized.authority_hash, 'hex'),
           'boundaryCheckpointChecksum',
             encode(normalized.boundary_checkpoint_checksum, 'hex'),
           'boundaryEventSequence',
             normalized.boundary_event_sequence::text,
           'boundaryHeadChecksum',
             encode(normalized.boundary_head_checksum, 'hex'),
           'payloadHash', encode(normalized.payload_hash, 'hex'),
           'worldId', normalized.world_id::text
         )
       ), 'UTF8'), 'sha256'),
       normalized.boundary_event_sequence,
       normalized.boundary_head_checksum,
       normalized.boundary_checkpoint_checksum,
       normalized.created_at
FROM normalized;
--> statement-breakpoint
DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.command_records command
    LEFT JOIN public.commerce_command_payload_facts fact
      ON fact.command_id = command.id
     AND fact.world_id = command.world_id
     AND fact.command_type = command.command_type
     AND fact.evidence_source = 'migration_baseline'
    WHERE command.status = 'accepted'::command_record_status
      AND command.command_type IN (
        'CreateEmploymentContractV1','EndEmploymentContractV1',
        'StartProductionRunV1','CreateMarketListingV1',
        'PurchaseMarketListingV1'
      )
      AND fact.command_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'M12 payload authority bootstrap is incomplete or ambiguous'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_command_payload_fact_bootstrap_complete';
  END IF;
END
$block$;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_record_commerce_command_payload_fact(
  checked_command_id uuid,
  checked_world_id uuid,
  checked_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  command_record record;
  checked_authority jsonb;
  checked_payload_hash bytea;
  checked_authority_hash bytea;
  checked_evidence_checksum bytea;
  checked_boundary_event_sequence bigint;
  checked_boundary_head_checksum bytea;
  checked_boundary_checkpoint_checksum bytea;
BEGIN
  SELECT command.id, command.world_id, command.command_type,
         command.status, command.payload, command.payload_hash,
         command.write_gate_opened_at
    INTO command_record
  FROM public.command_records command
  WHERE command.id = checked_command_id
    AND command.world_id = checked_world_id;
  IF NOT FOUND
    OR NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
      IS DISTINCT FROM checked_command_id
    OR NULLIF(current_setting('worldgraph.command_world_id', true), '')::uuid
      IS DISTINCT FROM checked_world_id
    OR command_record.status <> 'accepted'::command_record_status
    OR command_record.payload IS NOT NULL
    OR command_record.write_gate_opened_at IS NULL THEN
    RAISE EXCEPTION 'commerce command payload fact requires its open accepted command'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.command_type NOT IN (
    'CreateEmploymentContractV1','EndEmploymentContractV1',
    'StartProductionRunV1','CreateMarketListingV1',
    'PurchaseMarketListingV1'
  ) THEN
    RETURN;
  END IF;
  IF checked_payload IS NULL OR jsonb_typeof(checked_payload) <> 'object'
    OR octet_length(convert_to(
      public.worldgraph_canonical_jsonb(checked_payload), 'UTF8'
    )) > 32768 THEN
    RAISE EXCEPTION 'commerce command payload fact is not a bounded object'
      USING ERRCODE = '22023';
  END IF;
  checked_payload_hash := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(checked_payload), 'UTF8'
  ), 'sha256');
  IF checked_payload_hash IS DISTINCT FROM command_record.payload_hash THEN
    RAISE EXCEPTION 'commerce command payload fact does not match its command hash'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_command_payload_fact_command_hash_exact';
  END IF;
  checked_authority :=
    public.worldgraph_commerce_command_authority_document(
      checked_command_id, checked_world_id, checked_payload
    );
  checked_authority_hash := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(checked_authority), 'UTF8'
  ), 'sha256');
  SELECT runtime.last_event_sequence, head.checksum, checkpoint.checksum
    INTO checked_boundary_event_sequence, checked_boundary_head_checksum,
         checked_boundary_checkpoint_checksum
  FROM public.world_runtime_heads runtime
  JOIN public.world_economy_expansion_heads head
    ON head.world_id = runtime.world_id
  JOIN public.projection_checkpoints checkpoint
    ON checkpoint.world_id = runtime.world_id
   AND checkpoint.projection_name = 'economy_closed_loop'
   AND checkpoint.status = 'current'::projection_checkpoint_status
   AND checkpoint.last_event_sequence = runtime.last_event_sequence
   AND checkpoint.checksum = head.checksum
  WHERE runtime.world_id = checked_world_id;
  IF checked_boundary_event_sequence IS NULL
    OR checked_boundary_head_checksum IS NULL
    OR checked_boundary_checkpoint_checksum IS NULL THEN
    RAISE EXCEPTION 'commerce command payload fact lacks its publication boundary'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_command_payload_fact_boundary_exact';
  END IF;
  checked_evidence_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'commandId', checked_command_id::text,
      'commandType', command_record.command_type,
      'evidenceSource', 'command_hash',
      'authorityHash', encode(checked_authority_hash, 'hex'),
      'boundaryCheckpointChecksum',
        encode(checked_boundary_checkpoint_checksum, 'hex'),
      'boundaryEventSequence', checked_boundary_event_sequence::text,
      'boundaryHeadChecksum', encode(checked_boundary_head_checksum, 'hex'),
      'payloadHash', encode(checked_payload_hash, 'hex'),
      'worldId', checked_world_id::text
    )), 'UTF8'
  ), 'sha256');
  INSERT INTO public.commerce_command_payload_facts(
    command_id, world_id, command_type, payload, authority,
    evidence_source, payload_hash, authority_hash, evidence_checksum,
    boundary_event_sequence, boundary_head_checksum,
    boundary_checkpoint_checksum
  ) VALUES (
    checked_command_id, checked_world_id, command_record.command_type,
    checked_payload, checked_authority, 'command_hash',
    checked_payload_hash, checked_authority_hash,
    checked_evidence_checksum, checked_boundary_event_sequence,
    checked_boundary_head_checksum, checked_boundary_checkpoint_checksum
  ) ON CONFLICT (command_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1
    FROM public.commerce_command_payload_facts fact
    WHERE fact.command_id = checked_command_id
      AND fact.world_id = checked_world_id
      AND fact.command_type = command_record.command_type
      AND fact.payload = checked_payload
      AND fact.authority = checked_authority
      AND fact.evidence_source = 'command_hash'
      AND fact.payload_hash = checked_payload_hash
      AND fact.authority_hash = checked_authority_hash
      AND fact.evidence_checksum = checked_evidence_checksum
      AND fact.boundary_event_sequence = checked_boundary_event_sequence
      AND fact.boundary_head_checksum = checked_boundary_head_checksum
      AND fact.boundary_checkpoint_checksum =
        checked_boundary_checkpoint_checksum
  ) THEN
    RAISE EXCEPTION 'commerce command payload fact conflicts with prior evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_command_payload_fact_identity_exact';
  END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_record_commerce_command_payload_fact(uuid,uuid,jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_commerce_command_payload_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'INSERT'
    OR NEW.evidence_source <> 'command_hash'
    OR NEW.command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    OR NEW.world_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_world_id', true), '')::uuid THEN
    RAISE EXCEPTION 'commerce command payload evidence is append-only command authority'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER commerce_command_payload_facts_protect
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.commerce_command_payload_facts
  FOR EACH ROW
  EXECUTE FUNCTION public.worldgraph_protect_commerce_command_payload_fact();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_protect_commerce_command_payload_fact()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_commerce_command_payload_fact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.command_records command
    WHERE command.id = NEW.command_id
      AND command.world_id = NEW.world_id
      AND command.command_type = NEW.command_type
      AND command.status = 'accepted'::command_record_status
      AND command.payload IS NULL
      AND (
        NEW.evidence_source = 'migration_baseline'
        OR (
          NEW.evidence_source = 'command_hash'
          AND command.payload_hash = NEW.payload_hash
          AND NEW.authority =
            public.worldgraph_commerce_command_authority_document(
              NEW.command_id, NEW.world_id, NEW.payload
            )
          AND NEW.boundary_event_sequence = (
            SELECT max(event.world_event_sequence)
            FROM public.domain_events event
            WHERE event.world_id = NEW.world_id
              AND event.command_id = NEW.command_id
          )
          AND EXISTS (
            SELECT 1
            FROM public.world_economy_expansion_heads head
            JOIN public.projection_checkpoints checkpoint
              ON checkpoint.world_id = head.world_id
             AND checkpoint.projection_name = 'economy_closed_loop'
             AND checkpoint.status = 'current'::projection_checkpoint_status
             AND checkpoint.last_event_sequence =
               NEW.boundary_event_sequence
             AND checkpoint.checksum =
               NEW.boundary_checkpoint_checksum
            WHERE head.world_id = NEW.world_id
              AND head.checksum = NEW.boundary_head_checksum
              AND head.checksum = checkpoint.checksum
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'commerce command payload fact lacks its exact accepted command'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_command_payload_fact_command_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commerce_command_payload_facts_require_exact_command
  AFTER INSERT ON public.commerce_command_payload_facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.worldgraph_assert_commerce_command_payload_fact();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_require_commerce_command_payload_fact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.status = 'accepted'::command_record_status
    AND NEW.command_type IN (
      'CreateEmploymentContractV1','EndEmploymentContractV1',
      'StartProductionRunV1','CreateMarketListingV1',
      'PurchaseMarketListingV1'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.commerce_command_payload_facts fact
      WHERE fact.command_id = NEW.id
        AND fact.world_id = NEW.world_id
        AND fact.command_type = NEW.command_type
        AND fact.evidence_source = 'command_hash'
        AND fact.payload_hash = NEW.payload_hash
    ) THEN
    RAISE EXCEPTION 'accepted commerce command lacks its immutable payload fact'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_command_payload_fact_required';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER command_records_require_commerce_payload_fact
  AFTER INSERT OR UPDATE OF status ON public.command_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.worldgraph_require_commerce_command_payload_fact();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_assert_commerce_command_payload_fact()
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_require_commerce_command_payload_fact()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE public.payroll_policy_selection_facts (
  payroll_record_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  work_record_id uuid NOT NULL UNIQUE,
  tax_policy_id uuid,
  gross_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  net_minor bigint NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  state_revision bigint NOT NULL,
  evidence_checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_policy_selection_payroll_world_fk
    FOREIGN KEY (world_id, payroll_record_id)
    REFERENCES public.payroll_records(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_policy_selection_work_world_fk
    FOREIGN KEY (world_id, work_record_id)
    REFERENCES public.work_records(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_policy_selection_policy_world_fk
    FOREIGN KEY (world_id, tax_policy_id)
    REFERENCES public.tax_policies(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_policy_selection_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES public.command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT payroll_policy_selection_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES public.domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT payroll_policy_selection_amounts_valid CHECK (
    gross_minor > 0 AND tax_minor >= 0 AND net_minor >= 0
      AND gross_minor = tax_minor + net_minor
      AND ((tax_minor = 0 AND tax_policy_id IS NULL)
        OR (tax_minor > 0 AND tax_policy_id IS NOT NULL))
      AND state_revision > 0
  ),
  CONSTRAINT payroll_policy_selection_checksum_valid CHECK (
    octet_length(evidence_checksum) = 32
      AND evidence_checksum = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(jsonb_build_object(
          'commandId', command_id::text,
          'eventId', event_id::text,
          'grossMinor', gross_minor::text,
          'netMinor', net_minor::text,
          'payrollRecordId', payroll_record_id::text,
          'stateRevision', state_revision::text,
          'taxMinor', tax_minor::text,
          'taxPolicyId', tax_policy_id::text,
          'workRecordId', work_record_id::text,
          'worldId', world_id::text
        )), 'UTF8'
      ), 'sha256')
  )
);
--> statement-breakpoint
INSERT INTO public.payroll_policy_selection_facts(
  payroll_record_id, world_id, work_record_id, tax_policy_id,
  gross_minor, tax_minor, net_minor, command_id, event_id,
  state_revision, evidence_checksum, created_at
)
SELECT payroll.id, payroll.world_id, payroll.work_record_id,
       payroll.tax_policy_id, payroll.gross_minor, payroll.tax_minor,
       payroll.net_minor, payroll.created_command_id,
       payroll.created_event_id, payroll.created_state_revision,
       extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
         jsonb_build_object(
           'commandId', payroll.created_command_id::text,
           'eventId', payroll.created_event_id::text,
           'grossMinor', payroll.gross_minor::text,
           'netMinor', payroll.net_minor::text,
           'payrollRecordId', payroll.id::text,
           'stateRevision', payroll.created_state_revision::text,
           'taxMinor', payroll.tax_minor::text,
           'taxPolicyId', payroll.tax_policy_id::text,
           'workRecordId', payroll.work_record_id::text,
           'worldId', payroll.world_id::text
         )
       ), 'UTF8'), 'sha256'),
       payroll.created_at
FROM public.payroll_records payroll
JOIN public.work_records work
  ON work.world_id = payroll.world_id
 AND work.id = payroll.work_record_id
 AND work.contract_id = payroll.contract_id
 AND work.command_id = payroll.created_command_id
 AND work.event_id = payroll.created_event_id
 AND work.state_revision = payroll.created_state_revision
 AND work.gross_minor = payroll.gross_minor
JOIN public.domain_events event
  ON event.world_id = payroll.world_id
 AND event.id = payroll.created_event_id
 AND event.command_id = payroll.created_command_id
 AND event.aggregate_type = 'work_record'
 AND event.aggregate_id = payroll.work_record_id::text
 AND event.aggregate_version = 1
 AND event.event_type = 'WorkRecordedV1'
 AND event.resulting_state_revision = payroll.created_state_revision
 AND event.payload ->> 'contractId' = payroll.contract_id::text
 AND event.payload ->> 'payrollRecordId' = payroll.id::text
 AND event.payload ->> 'workRecordId' = payroll.work_record_id::text
 AND event.payload ? 'taxPolicyId'
 AND event.payload ->> 'taxPolicyId'
   IS NOT DISTINCT FROM payroll.tax_policy_id::text
 AND (event.payload ->> 'tick')::bigint = work.performed_tick
JOIN public.command_records command
  ON command.id = payroll.created_command_id
 AND command.world_id = payroll.world_id
 AND command.command_type = 'PerformJobV1'
 AND command.status = 'accepted'::command_record_status;
--> statement-breakpoint
DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.payroll_records payroll
    LEFT JOIN public.payroll_policy_selection_facts selection
      ON selection.payroll_record_id = payroll.id
     AND selection.world_id = payroll.world_id
     AND selection.work_record_id = payroll.work_record_id
     AND selection.command_id = payroll.created_command_id
     AND selection.event_id = payroll.created_event_id
     AND selection.state_revision = payroll.created_state_revision
     AND selection.gross_minor = payroll.gross_minor
     AND selection.tax_minor = payroll.tax_minor
     AND selection.net_minor = payroll.net_minor
     AND selection.tax_policy_id IS NOT DISTINCT FROM payroll.tax_policy_id
    WHERE selection.payroll_record_id IS NULL
  ) THEN
    RAISE EXCEPTION 'M12 payroll selection bootstrap is incomplete or ambiguous'
      USING ERRCODE = '23514',
        CONSTRAINT = 'payroll_policy_selection_bootstrap_complete';
  END IF;
END
$block$;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_payroll_policy_selection_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'INSERT'
    OR public.worldgraph_commerce_command_type(NEW.world_id)
      IS DISTINCT FROM 'PerformJobV1'
    OR NEW.command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id', true), '')::uuid THEN
    RAISE EXCEPTION 'payroll policy selection evidence is append-only PerformJob authority'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER payroll_policy_selection_facts_protect
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.payroll_policy_selection_facts
  FOR EACH ROW
  EXECUTE FUNCTION public.worldgraph_protect_payroll_policy_selection_fact();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_protect_payroll_policy_selection_fact()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_payroll_policy_selection_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.domain_events event
    JOIN public.work_records work
      ON work.world_id = event.world_id
     AND work.id = NEW.work_record_id
     AND work.command_id = NEW.command_id
     AND work.event_id = NEW.event_id
     AND work.gross_minor = NEW.gross_minor
     AND work.state_revision = NEW.state_revision
    JOIN public.payroll_records payroll
      ON payroll.world_id = event.world_id
     AND payroll.id = NEW.payroll_record_id
     AND payroll.contract_id = work.contract_id
     AND payroll.work_record_id = NEW.work_record_id
     AND payroll.created_command_id = NEW.command_id
     AND payroll.created_event_id = NEW.event_id
     AND payroll.created_state_revision = NEW.state_revision
     AND payroll.gross_minor = NEW.gross_minor
     AND payroll.tax_minor = NEW.tax_minor
     AND payroll.net_minor = NEW.net_minor
     AND payroll.tax_policy_id IS NOT DISTINCT FROM NEW.tax_policy_id
    WHERE event.world_id = NEW.world_id
      AND event.id = NEW.event_id
      AND event.command_id = NEW.command_id
      AND event.aggregate_type = 'work_record'
      AND event.aggregate_id = NEW.work_record_id::text
      AND event.aggregate_version = 1
      AND event.event_type = 'WorkRecordedV1'
      AND event.resulting_state_revision = NEW.state_revision
      AND event.payload ? 'taxPolicyId'
      AND event.payload ->> 'contractId' = work.contract_id::text
      AND event.payload ->> 'workRecordId' = NEW.work_record_id::text
      AND event.payload ->> 'payrollRecordId' = NEW.payroll_record_id::text
      AND event.payload ->> 'taxPolicyId'
        IS NOT DISTINCT FROM NEW.tax_policy_id::text
      AND (event.payload ->> 'tick')::bigint = work.performed_tick
  ) THEN
    RAISE EXCEPTION 'payroll policy selection fact lacks its exact WorkRecorded evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'payroll_policy_selection_evidence_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_policy_selection_facts_require_exact_evidence
  AFTER INSERT ON public.payroll_policy_selection_facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.worldgraph_assert_payroll_policy_selection_fact();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_assert_payroll_policy_selection_fact()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_require_payroll_policy_selection_fact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.payroll_policy_selection_facts selection
    WHERE selection.payroll_record_id = NEW.id
      AND selection.world_id = NEW.world_id
      AND selection.work_record_id = NEW.work_record_id
      AND selection.tax_policy_id IS NOT DISTINCT FROM NEW.tax_policy_id
      AND selection.gross_minor = NEW.gross_minor
      AND selection.tax_minor = NEW.tax_minor
      AND selection.net_minor = NEW.net_minor
      AND selection.command_id = NEW.created_command_id
      AND selection.event_id = NEW.created_event_id
      AND selection.state_revision = NEW.created_state_revision
  ) THEN
    RAISE EXCEPTION 'payroll record lacks its immutable policy selection fact'
      USING ERRCODE = '23514',
        CONSTRAINT = 'payroll_policy_selection_fact_required';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_records_require_policy_selection_fact
  AFTER INSERT OR UPDATE ON public.payroll_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.worldgraph_require_payroll_policy_selection_fact();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_require_payroll_policy_selection_fact()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_economy_reconciliation_documents_v2(
  checked_world_id uuid,
  evidence_command_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
AS $function$
WITH
evidence_context AS (
  SELECT command.command_type,
         command.opened_event_sequence,
         snapshot.opened_head_checksum,
         snapshot.opened_checkpoint_event_sequence,
         snapshot.opened_checkpoint_checksum,
         snapshot.opened_checkpoint_status
  FROM (SELECT evidence_command_id AS command_id) requested
  LEFT JOIN public.command_records command
    ON command.id = requested.command_id
   AND command.world_id = checked_world_id
  LEFT JOIN public.economy_expansion_command_write_snapshots snapshot
    ON snapshot.command_id = command.id
   AND snapshot.world_id = command.world_id
),
seed_authority AS (
  SELECT head.initialized_command_id, head.initialized_event_id,
         initialized.resulting_state_revision AS initialized_state_revision,
         plan.world_version_id, plan.plan_hash, plan.canonical_plan
  FROM public.world_economy_expansion_heads head
  JOIN public.compiled_economy_seed_plans plan
    ON plan.world_id = head.world_id
   AND plan.world_version_id = head.source_world_version_id
   AND plan.plan_hash = head.seed_plan_hash
  JOIN public.domain_events initialized
    ON initialized.world_id = head.world_id
   AND initialized.id = head.initialized_event_id
   AND initialized.command_id = head.initialized_command_id
   AND initialized.event_type = 'WorldCommerceInitializedV1'
  WHERE head.world_id = checked_world_id
),
inventory_ids AS (
  SELECT inventory.id
  FROM public.inventories inventory
  WHERE inventory.world_id = checked_world_id
  UNION
  SELECT movement.from_inventory_id
  FROM public.inventory_movements movement
  WHERE movement.world_id = checked_world_id
    AND movement.from_inventory_id IS NOT NULL
  UNION
  SELECT movement.to_inventory_id
  FROM public.inventory_movements movement
  WHERE movement.world_id = checked_world_id
    AND movement.to_inventory_id IS NOT NULL
),
inventory_movement_totals AS (
  SELECT endpoint.inventory_id, sum(endpoint.quantity)::numeric(36,12) AS quantity
  FROM (
    SELECT movement.to_inventory_id AS inventory_id, movement.quantity
    FROM public.inventory_movements movement
    WHERE movement.world_id = checked_world_id
      AND movement.to_inventory_id IS NOT NULL
    UNION ALL
    SELECT movement.from_inventory_id, -movement.quantity
    FROM public.inventory_movements movement
    WHERE movement.world_id = checked_world_id
      AND movement.from_inventory_id IS NOT NULL
  ) endpoint
  GROUP BY endpoint.inventory_id
),
inventory_live_rows AS (
  SELECT ids.id,
         inventory.quantity::numeric(36,12)::text AS quantity
  FROM inventory_ids ids
  LEFT JOIN public.inventories inventory
    ON inventory.world_id = checked_world_id AND inventory.id = ids.id
),
inventory_rebuilt_rows AS (
  SELECT ids.id,
         COALESCE(total.quantity, 0::numeric)::numeric(36,12)::text AS quantity
  FROM inventory_ids ids
  LEFT JOIN inventory_movement_totals total ON total.inventory_id = ids.id
),
production_latest AS (
  SELECT DISTINCT ON (transition.run_id)
         transition.run_id, transition.transition_version, transition.status,
         transition.command_id, transition.event_id, transition.state_revision,
         transition.snapshot_hash, transition.occurred_tick
  FROM public.production_run_transitions transition
  WHERE transition.world_id = checked_world_id
  ORDER BY transition.run_id, transition.transition_version DESC
),
listing_latest AS (
  SELECT DISTINCT ON (event.aggregate_id)
         event.aggregate_id::uuid AS listing_id, event.id, event.command_id,
         event.aggregate_version, event.event_type, event.payload,
         event.resulting_state_revision
  FROM public.domain_events event
  WHERE event.world_id = checked_world_id
    AND event.aggregate_type = 'market_listing'
    AND event.event_type IN (
      'MarketListingCreatedV1','MarketListingPartiallyFilledV1',
      'MarketListingFilledV1','MarketListingCancelledV1',
      'MarketListingExpiredV1'
    )
  ORDER BY event.aggregate_id, event.aggregate_version DESC
),
production_expected_inputs AS (
  SELECT latest.run_id,
         (binding.value ->> 'inventoryId')::uuid AS inventory_id,
         snapshot.value ->> 'resourceTypeId' AS resource_type_id,
         snapshot.ordinality,
         (snapshot.value ->> 'quantity')::numeric(30,12) AS quantity,
         (snapshot.value ->> 'quantity')::numeric(30,12)::text
           AS quantity_text
  FROM production_latest latest
  JOIN public.production_run_transitions initial
    ON initial.world_id = checked_world_id
   AND initial.run_id = latest.run_id
   AND initial.transition_version = 1
  JOIN public.commerce_command_payload_facts command_fact
    ON command_fact.world_id = initial.world_id
   AND command_fact.command_id = initial.command_id
   AND command_fact.command_type = 'StartProductionRunV1'
  CROSS JOIN LATERAL jsonb_array_elements(
    command_fact.authority -> 'inputSnapshot'
  ) WITH ORDINALITY snapshot(value, ordinality)
  JOIN LATERAL jsonb_array_elements(
    command_fact.authority -> 'inputInventoryBindings'
  ) binding(value)
    ON binding.value ->> 'resourceTypeId' =
      snapshot.value ->> 'resourceTypeId'
),
production_expected_outputs AS (
  SELECT latest.run_id,
         component.value ->> 'resourceTypeId' AS resource_type_id,
         component.ordinality,
         (component.value ->> 'quantity')::numeric(30,12)::text
           AS quantity_text
  FROM production_latest latest
  JOIN public.production_run_transitions initial
    ON initial.world_id = checked_world_id
   AND initial.run_id = latest.run_id
   AND initial.transition_version = 1
  JOIN public.commerce_command_payload_facts command_fact
    ON command_fact.world_id = initial.world_id
   AND command_fact.command_id = initial.command_id
   AND command_fact.command_type = 'StartProductionRunV1'
  CROSS JOIN LATERAL jsonb_array_elements(
    command_fact.authority -> 'outputSnapshot'
  )
    WITH ORDINALITY component(value, ordinality)
),
production_expected_snapshots AS (
  SELECT latest.run_id, jsonb_build_object(
           'inputs', command_fact.authority -> 'inputSnapshot',
           'outputs', command_fact.authority -> 'outputSnapshot'
         ) AS snapshot
  FROM production_latest latest
  JOIN public.production_run_transitions initial
    ON initial.world_id = checked_world_id
   AND initial.run_id = latest.run_id
   AND initial.transition_version = 1
  JOIN public.commerce_command_payload_facts command_fact
    ON command_fact.world_id = initial.world_id
   AND command_fact.command_id = initial.command_id
   AND command_fact.command_type = 'StartProductionRunV1'
),
production_reserved_expected AS (
  SELECT expected.inventory_id,
         sum(expected.quantity)::numeric(36,12) AS quantity
  FROM production_latest latest
  JOIN production_expected_inputs expected ON expected.run_id = latest.run_id
  WHERE latest.status IN ('scheduled','reserving','ready')
  GROUP BY expected.inventory_id
),
listing_reserved_expected AS (
  SELECT (created_fact.authority ->> 'sellerInventoryId')::uuid AS inventory_id,
         sum((latest.payload ->> 'remainingQuantity')::numeric)::numeric(36,12) AS quantity
  FROM listing_latest latest
  JOIN public.domain_events created_event
    ON created_event.world_id = checked_world_id
   AND created_event.aggregate_type = 'market_listing'
   AND created_event.aggregate_id = latest.listing_id::text
   AND created_event.event_type = 'MarketListingCreatedV1'
  JOIN public.commerce_command_payload_facts created_fact
    ON created_fact.command_id = created_event.command_id
   AND created_fact.world_id = created_event.world_id
   AND created_fact.command_type = 'CreateMarketListingV1'
  WHERE latest.payload ->> 'status' = 'open'
  GROUP BY created_fact.authority ->> 'sellerInventoryId'
),
reservation_expected_totals AS (
  SELECT combined.inventory_id,
         sum(combined.quantity)::numeric(36,12) AS quantity
  FROM (
    SELECT inventory_id, quantity FROM production_reserved_expected
    UNION ALL
    SELECT inventory_id, quantity FROM listing_reserved_expected
  ) combined
  GROUP BY combined.inventory_id
),
reservation_live_rows AS (
  SELECT ids.id,
         inventory.reserved_quantity::numeric(36,12)::text AS quantity
  FROM inventory_ids ids
  LEFT JOIN public.inventories inventory
    ON inventory.world_id = checked_world_id AND inventory.id = ids.id
),
reservation_rebuilt_rows AS (
  SELECT ids.id,
         COALESCE(total.quantity, 0::numeric)::numeric(36,12)::text AS quantity
  FROM inventory_ids ids
  LEFT JOIN reservation_expected_totals total ON total.inventory_id = ids.id
),
reservation_record_live_rows AS (
  SELECT concat_ws(
           ':', reservation.purpose_type::text, reservation.purpose_id::text,
           reservation.inventory_id::text
         ) AS id,
         jsonb_build_object(
           'createdCommandId', reservation.created_command_id::text,
           'createdEventId', reservation.created_event_id::text,
           'createdStateRevision', reservation.created_state_revision::text,
           'expiresAtTick', reservation.expires_at_tick::text,
           'inventoryId', reservation.inventory_id::text,
           'purposeId', reservation.purpose_id::text,
           'purposeType', reservation.purpose_type::text,
           'quantity', reservation.quantity::numeric(30,12)::text,
           'rowVersion', reservation.row_version::text,
           'status', reservation.status::text,
           'terminalCommandId', reservation.terminal_command_id::text,
           'terminalEventId', reservation.terminal_event_id::text,
           'terminalStateRevision', reservation.terminal_state_revision::text
         ) AS document
  FROM public.inventory_reservations reservation
  WHERE reservation.world_id = checked_world_id
),
reservation_record_rebuilt_rows AS (
  SELECT concat_ws(
           ':', 'production_input', expected.run_id::text,
           expected.inventory_id::text
         ) AS id,
         jsonb_build_object(
           'createdCommandId', initial.command_id::text,
           'createdEventId', initial.event_id::text,
           'createdStateRevision', initial.state_revision::text,
           'expiresAtTick', NULL,
           'inventoryId', expected.inventory_id::text,
           'purposeId', expected.run_id::text,
           'purposeType', 'production_input',
           'quantity', expected.quantity::numeric(30,12)::text,
           'rowVersion', CASE
             WHEN latest.status IN ('completed','failed','cancelled') THEN '2'
             ELSE '1'
           END,
           'status', CASE latest.status
             WHEN 'completed'::production_run_status THEN 'consumed'
             WHEN 'failed'::production_run_status THEN 'released'
             WHEN 'cancelled'::production_run_status THEN 'released'
             ELSE 'active'
           END,
           'terminalCommandId', CASE
             WHEN latest.status IN ('completed','failed','cancelled')
               THEN latest.command_id::text
             ELSE NULL
           END,
           'terminalEventId', CASE
             WHEN latest.status = 'completed'::production_run_status THEN (
               SELECT consumed.id::text
               FROM public.domain_events consumed
               WHERE consumed.world_id = checked_world_id
                 AND consumed.command_id = latest.command_id
                 AND consumed.aggregate_type = 'production_run'
                 AND consumed.aggregate_id = latest.run_id::text
                 AND consumed.event_type = 'ResourcesConsumedV1'
               LIMIT 1
             )
             WHEN latest.status IN ('failed','cancelled')
               THEN latest.event_id::text
             ELSE NULL
           END,
           'terminalStateRevision', CASE
             WHEN latest.status IN ('completed','failed','cancelled')
               THEN latest.state_revision::text
             ELSE NULL
           END
         ) AS document
  FROM production_expected_inputs expected
  JOIN production_latest latest ON latest.run_id = expected.run_id
  JOIN public.production_run_transitions initial
    ON initial.world_id = checked_world_id
   AND initial.run_id = expected.run_id
   AND initial.transition_version = 1
  UNION ALL
  SELECT concat_ws(
           ':', 'market_listing', created.aggregate_id,
           created_fact.authority ->> 'sellerInventoryId'
         ) AS id,
         jsonb_build_object(
           'createdCommandId', created.command_id::text,
           'createdEventId', created.id::text,
           'createdStateRevision', created.resulting_state_revision::text,
           'expiresAtTick', created_fact.authority ->> 'expiresAtTick',
           'inventoryId', created_fact.authority ->> 'sellerInventoryId',
           'purposeId', created.aggregate_id,
           'purposeType', 'market_listing',
           'quantity', (
             CASE
               WHEN latest.payload ->> 'status' = 'filled' THEN (
                 SELECT (trade.payload ->> 'quantity')::numeric
                 FROM public.domain_events trade
                 WHERE trade.world_id = checked_world_id
                   AND trade.command_id = latest.command_id
                   AND trade.event_type = 'MarketTradeCompletedV1'
                 LIMIT 1
               )
               ELSE (latest.payload ->> 'remainingQuantity')::numeric
             END
           )::numeric(30,12)::text,
           'rowVersion', latest.aggregate_version::text,
           'status', CASE latest.payload ->> 'status'
             WHEN 'filled' THEN 'consumed'
             WHEN 'cancelled' THEN 'released'
             WHEN 'expired' THEN 'expired'
             ELSE 'active'
           END,
           'terminalCommandId', CASE
             WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
               THEN latest.command_id::text
             ELSE NULL
           END,
           'terminalEventId', CASE
             WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
               THEN latest.id::text
             ELSE NULL
           END,
           'terminalStateRevision', CASE
             WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
               THEN latest.resulting_state_revision::text
             ELSE NULL
           END
         ) AS document
  FROM public.domain_events created
  JOIN listing_latest latest
    ON latest.listing_id = created.aggregate_id::uuid
  JOIN public.commerce_command_payload_facts created_fact
    ON created_fact.world_id = created.world_id
   AND created_fact.command_id = created.command_id
   AND created_fact.command_type = 'CreateMarketListingV1'
  WHERE created.world_id = checked_world_id
    AND created.aggregate_type = 'market_listing'
    AND created.event_type = 'MarketListingCreatedV1'
),
business_live_rows AS (
  SELECT business.stable_key::text AS id,
         jsonb_build_object(
           'backingOrganizationEntityId',
             business.backing_organization_entity_id::text,
           'backingOrganizationEntityKey', organization.logical_key::text,
           'createdCommandId', business.created_command_id::text,
           'createdEventId', business.created_event_id::text,
           'currencyId', business.currency_id::text,
           'currencyStableKey', currency.stable_key::text,
           'metadataHash', encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(business.metadata), 'UTF8'
           ), 'sha256'), 'hex'),
           'rowVersion', business.row_version::text,
           'stableKey', business.stable_key::text,
           'status', business.status::text,
           'walletId', business.wallet_id::text,
           'walletStableKey', wallet.stable_key::text
         ) AS document
  FROM public.businesses business
  LEFT JOIN public.world_entities organization
    ON organization.world_id = business.world_id
   AND organization.id = business.backing_organization_entity_id
  LEFT JOIN public.wallets wallet
    ON wallet.world_id = business.world_id AND wallet.id = business.wallet_id
  LEFT JOIN public.currencies currency
    ON currency.world_id = business.world_id AND currency.id = business.currency_id
  WHERE business.world_id = checked_world_id
),
business_rebuilt_rows AS (
  SELECT item.value ->> 'stableKey' AS id,
         jsonb_build_object(
           'backingOrganizationEntityId', organization.id::text,
           'backingOrganizationEntityKey',
             item.value ->> 'organizationEntityLogicalKey',
           'createdCommandId', seed.initialized_command_id::text,
           'createdEventId', seed.initialized_event_id::text,
           'currencyId', wallet.currency_id::text,
           'currencyStableKey', currency.stable_key::text,
           'metadataHash', encode(extensions.digest(
             convert_to(public.worldgraph_canonical_jsonb('{}'::jsonb),'UTF8'),
             'sha256'
           ), 'hex'),
           'rowVersion', '1',
           'stableKey', item.value ->> 'stableKey',
           'status', item.value ->> 'status',
           'walletId', wallet.id::text,
           'walletStableKey', item.value ->> 'walletStableKey'
         ) AS document
  FROM seed_authority seed
  CROSS JOIN LATERAL jsonb_array_elements(
    seed.canonical_plan -> 'businesses'
  ) item
  LEFT JOIN public.world_entities organization
    ON organization.world_id = checked_world_id
   AND organization.logical_key::text =
     item.value ->> 'organizationEntityLogicalKey'
  LEFT JOIN public.wallets wallet
    ON wallet.world_id = checked_world_id
   AND wallet.stable_key::text = item.value ->> 'walletStableKey'
  LEFT JOIN public.currencies currency
    ON currency.world_id = wallet.world_id AND currency.id = wallet.currency_id
  UNION ALL
  SELECT COALESCE(
           regexp_replace(organization.logical_key::text, '^[^:]+', 'business'),
           event.aggregate_id
         ) AS id,
         jsonb_build_object(
           'backingOrganizationEntityId', event.payload ->> 'backingOrganizationEntityId',
           'backingOrganizationEntityKey', organization.logical_key::text,
           'createdCommandId', event.command_id::text,
           'createdEventId', event.id::text,
           'currencyId', wallet.currency_id::text,
           'currencyStableKey', currency.stable_key::text,
           'metadataHash', encode(extensions.digest(
             convert_to(public.worldgraph_canonical_jsonb('{}'::jsonb),'UTF8'),
             'sha256'
           ), 'hex'),
           'rowVersion', event.aggregate_version::text,
           'stableKey',
             regexp_replace(organization.logical_key::text, '^[^:]+', 'business'),
           'status', 'active',
           'walletId', event.payload ->> 'walletId',
           'walletStableKey', wallet.stable_key::text
         ) AS document
  FROM public.domain_events event
  JOIN public.command_records command
    ON command.world_id = event.world_id AND command.id = event.command_id
   AND command.command_type = 'CreateBusinessV1'
   AND command.status = 'accepted'::command_record_status
  LEFT JOIN public.world_entities organization
    ON organization.world_id = event.world_id
   AND organization.id =
     (event.payload ->> 'backingOrganizationEntityId')::uuid
  LEFT JOIN public.wallets wallet
    ON wallet.world_id = event.world_id
   AND wallet.id = (event.payload ->> 'walletId')::uuid
  LEFT JOIN public.currencies currency
    ON currency.world_id = wallet.world_id AND currency.id = wallet.currency_id
  WHERE event.world_id = checked_world_id
    AND event.event_type = 'BusinessCreatedV1'
),
facility_live_rows AS (
  SELECT facility.stable_key::text AS id,
         jsonb_build_object(
           'assetStableKey', asset.stable_key::text,
           'businessStableKey', business.stable_key::text,
           'createdCommandId', facility.created_command_id::text,
           'createdEventId', facility.created_event_id::text,
           'facilityAssetId', facility.facility_asset_id::text,
           'recipeVersionIds', COALESCE((
             SELECT jsonb_agg(binding.recipe_version_id::text ORDER BY binding.recipe_version_id)
             FROM public.business_facility_recipe_versions binding
             WHERE binding.world_id = facility.world_id
               AND binding.facility_id = facility.id
           ), '[]'::jsonb),
           'rowVersion', facility.row_version::text,
           'stableKey', facility.stable_key::text,
           'status', facility.status::text
         ) AS document
  FROM public.business_facilities facility
  LEFT JOIN public.businesses business
    ON business.world_id = facility.world_id AND business.id = facility.business_id
  LEFT JOIN public.assets asset
    ON asset.world_id = facility.world_id AND asset.id = facility.facility_asset_id
  WHERE facility.world_id = checked_world_id
),
facility_rebuilt_rows AS (
  SELECT item.value ->> 'stableKey' AS id,
         jsonb_build_object(
           'assetStableKey', item.value ->> 'assetStableKey',
           'businessStableKey', item.value ->> 'businessStableKey',
           'createdCommandId', seed.initialized_command_id::text,
           'createdEventId', seed.initialized_event_id::text,
           'facilityAssetId', asset.id::text,
           'recipeVersionIds', (
             SELECT jsonb_agg(version.id::text ORDER BY version.id)
             FROM jsonb_array_elements_text(
               item.value -> 'recipeVersionStableKeys'
             ) recipe_key
             JOIN public.production_recipes recipe
               ON recipe.world_id = checked_world_id
              AND recipe.stable_key::text = recipe_key
             JOIN public.production_recipe_versions version
               ON version.world_id = recipe.world_id
              AND version.recipe_id = recipe.id
           ),
           'rowVersion', '1',
           'stableKey', item.value ->> 'stableKey',
           'status', item.value ->> 'status'
         ) AS document
  FROM seed_authority seed
  CROSS JOIN LATERAL jsonb_array_elements(
    seed.canonical_plan -> 'facilities'
  ) item
  LEFT JOIN public.businesses business
    ON business.world_id = checked_world_id
   AND business.stable_key::text = item.value ->> 'businessStableKey'
  LEFT JOIN public.assets asset
    ON asset.world_id = checked_world_id
   AND asset.stable_key::text = item.value ->> 'assetStableKey'
  UNION ALL
  SELECT COALESCE(
           regexp_replace(asset.stable_key::text, '^[^:]+', 'facility'),
           event.aggregate_id
         ) AS id,
         jsonb_build_object(
           'assetStableKey', asset.stable_key::text,
           'businessStableKey', business.stable_key::text,
           'createdCommandId', event.command_id::text,
           'createdEventId', event.id::text,
           'facilityAssetId', event.payload ->> 'facilityAssetId',
           'recipeVersionIds', event.payload -> 'recipeVersionIds',
           'rowVersion', event.aggregate_version::text,
           'stableKey', regexp_replace(asset.stable_key::text, '^[^:]+', 'facility'),
           'status', 'active'
         ) AS document
  FROM public.domain_events event
  JOIN public.command_records command
    ON command.world_id = event.world_id AND command.id = event.command_id
   AND command.command_type = 'ConfigureBusinessFacilityV1'
   AND command.status = 'accepted'::command_record_status
  LEFT JOIN public.assets asset
    ON asset.world_id = event.world_id
   AND asset.id = (event.payload ->> 'facilityAssetId')::uuid
  LEFT JOIN public.businesses business
    ON business.world_id = event.world_id
   AND business.id = (event.payload ->> 'businessId')::uuid
  WHERE event.world_id = checked_world_id
    AND event.event_type = 'BusinessFacilityConfiguredV1'
),
recipe_version_live_rows AS (
  SELECT concat(recipe.stable_key::text, ':v', version.version::text) AS id,
         jsonb_build_object(
           'canonicalInputs', version.canonical_inputs,
           'canonicalOutputs', version.canonical_outputs,
           'canonicalSeedInputs', version.canonical_seed_inputs,
           'canonicalSeedOutputs', version.canonical_seed_outputs,
           'checksum', encode(version.checksum, 'hex'),
           'createdCommandId', version.created_command_id::text,
           'createdEventId', version.created_event_id::text,
           'createdStateRevision', version.created_state_revision::text,
           'durationTicks', version.duration_ticks::text,
           'facilityRequirements', version.facility_requirements,
           'primitiveContentHash', encode(version.primitive_content_hash, 'hex'),
           'primitiveKey', version.primitive_key::text,
           'primitiveRef', version.primitive_ref,
           'primitiveVersion', version.primitive_version,
           'primitiveVersionId', version.primitive_version_id::text,
           'recipeDisplayName', recipe.display_name,
           'recipeId', version.recipe_id::text,
           'recipeSchemaVersion', recipe.recipe_schema_version,
           'recipeStatus', recipe.status::text,
           'recipeVersionSchemaVersion', version.recipe_version_schema_version,
           'sourcePlanHash', encode(version.source_plan_hash, 'hex'),
           'sourceWorldVersionId', version.source_world_version_id::text,
           'stableKey', recipe.stable_key::text,
           'version', version.version
         ) AS document
  FROM public.production_recipe_versions version
  JOIN public.production_recipes recipe
    ON recipe.world_id = version.world_id AND recipe.id = version.recipe_id
  WHERE version.world_id = checked_world_id
),
recipe_version_rebuilt_rows AS (
  SELECT concat(item.value ->> 'stableKey', ':v', item.value ->> 'version') AS id,
         jsonb_build_object(
           'canonicalInputs', (
             SELECT jsonb_agg(jsonb_build_object(
               'quantity', component.value ->> 'quantity',
               'resourceTypeId', resource.id::text
             ) ORDER BY component.ordinality)
             FROM jsonb_array_elements(item.value -> 'inputs')
               WITH ORDINALITY component(value, ordinality)
             LEFT JOIN public.resource_types resource
               ON resource.world_id = checked_world_id
              AND resource.stable_key::text =
                component.value ->> 'resourceStableKey'
           ),
           'canonicalOutputs', (
             SELECT jsonb_agg(jsonb_build_object(
               'quantity', component.value ->> 'quantity',
               'resourceTypeId', resource.id::text
             ) ORDER BY component.ordinality)
             FROM jsonb_array_elements(item.value -> 'outputs')
               WITH ORDINALITY component(value, ordinality)
             LEFT JOIN public.resource_types resource
               ON resource.world_id = checked_world_id
              AND resource.stable_key::text =
                component.value ->> 'resourceStableKey'
           ),
           'canonicalSeedInputs', item.value -> 'inputs',
           'canonicalSeedOutputs', item.value -> 'outputs',
           'checksum', item.value ->> 'checksum',
           'createdCommandId', seed.initialized_command_id::text,
           'createdEventId', seed.initialized_event_id::text,
           'createdStateRevision', seed.initialized_state_revision::text,
           'durationTicks', item.value ->> 'durationTicks',
           'facilityRequirements', jsonb_build_object(
             'assetType', item.value ->> 'facilityAssetType'
           ),
           'primitiveContentHash', item.value ->> 'primitiveContentHash',
           'primitiveKey', item.value ->> 'primitiveKey',
           'primitiveRef', item.value ->> 'primitiveRef',
           'primitiveVersion', item.value ->> 'primitiveVersion',
           'primitiveVersionId', item.value ->> 'primitiveVersionId',
           'recipeDisplayName', primitive.display_name,
           'recipeId', recipe.id::text,
           'recipeSchemaVersion', 1,
           'recipeStatus', 'active',
           'recipeVersionSchemaVersion',
             (item.value ->> 'recipeVersionSchemaVersion')::integer,
           'sourcePlanHash', encode(seed.plan_hash, 'hex'),
           'sourceWorldVersionId', seed.world_version_id::text,
           'stableKey', item.value ->> 'stableKey',
           'version', (item.value ->> 'version')::integer
         ) AS document
  FROM seed_authority seed
  CROSS JOIN LATERAL jsonb_array_elements(
    seed.canonical_plan -> 'recipeVersions'
  ) item(value)
  LEFT JOIN public.production_recipes recipe
    ON recipe.world_id = checked_world_id
   AND recipe.stable_key::text = item.value ->> 'stableKey'
  LEFT JOIN public.primitive_versions primitive
    ON primitive.id = (item.value ->> 'primitiveVersionId')::uuid
   AND primitive.content_hash = decode(
     item.value ->> 'primitiveContentHash', 'hex'
   )
),
tax_policy_live_rows AS (
  SELECT concat(policy.stable_key::text, ':v', policy.policy_version::text) AS id,
         jsonb_build_object(
           'applicability', policy.applicability,
           'calculationVersion', policy.calculation_version,
           'checksum', encode(policy.checksum, 'hex'),
           'createdCommandId', policy.created_command_id::text,
           'createdEventId', policy.created_event_id::text,
           'createdStateRevision', policy.created_state_revision::text,
           'currencyStableKey', currency.stable_key::text,
           'policy', jsonb_build_object(
             'authorityEntityLogicalKey', authority.logical_key::text,
             'collectionMode', policy.collection_mode::text,
             'effectiveFromTick', policy.effective_from_tick::text,
             'effectiveUntilTick', policy.effective_until_tick::text,
             'primitiveContentHash', encode(policy.primitive_content_hash, 'hex'),
             'primitiveKey', policy.primitive_key::text,
             'primitiveRef', policy.primitive_ref,
             'primitiveVersion', policy.primitive_version,
             'primitiveVersionId', policy.primitive_version_id::text,
             'roundingMode', policy.rounding_mode,
             'stableKey', policy.stable_key::text,
             'status', policy.status::text,
             'taxPolicySchemaVersion', policy.tax_policy_schema_version,
             'treasuryWalletStableKey', treasury.stable_key::text
           ) || CASE
             WHEN policy.tax_type = 'periodic_flat'::tax_policy_type
             THEN jsonb_build_object(
               'fixedAmountMinor', policy.fixed_amount_minor::text,
               'intervalTicks', policy.applicability ->> 'intervalTicks',
               'payerEntityLogicalKey', payer.logical_key::text,
               'payerWalletStableKey', payer_wallet.stable_key::text,
               'taxType', policy.tax_type::text
             )
             ELSE jsonb_build_object(
               'rateBps', policy.rate_basis_points,
               'taxType', policy.tax_type::text
             )
           END,
           'policyVersion', policy.policy_version,
           'sourcePlanHash', encode(policy.source_plan_hash, 'hex'),
           'sourceWorldVersionId', policy.source_world_version_id::text
         ) AS document
  FROM public.tax_policies policy
  LEFT JOIN public.world_entities authority
    ON authority.world_id = policy.world_id
   AND authority.id = policy.authority_entity_id
  LEFT JOIN public.wallets treasury
    ON treasury.world_id = policy.world_id
   AND treasury.id = policy.treasury_wallet_id
  LEFT JOIN public.currencies currency
    ON currency.world_id = policy.world_id AND currency.id = policy.currency_id
  LEFT JOIN public.world_entities payer
    ON payer.world_id = policy.world_id
   AND payer.id::text = policy.applicability ->> 'payerEntityId'
  LEFT JOIN public.wallets payer_wallet
    ON payer_wallet.world_id = policy.world_id
   AND payer_wallet.id::text = policy.applicability ->> 'payerWalletId'
  WHERE policy.world_id = checked_world_id
),
tax_policy_rebuilt_rows AS (
  SELECT concat(item.value ->> 'stableKey', ':v1') AS id,
         jsonb_build_object(
           'applicability', CASE
             WHEN item.value ->> 'taxType' = 'periodic_flat'
             THEN jsonb_build_object(
               'intervalTicks', item.value ->> 'intervalTicks',
               'payerEntityId', payer.id::text,
               'payerWalletId', payer_wallet.id::text
             )
             ELSE '{}'::jsonb
           END,
           'calculationVersion', 1,
           'checksum', encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(jsonb_build_object(
               'domain', 'worldgraph.tax-policy.v1',
               'policy', item.value
             )), 'UTF8'
           ), 'sha256'), 'hex'),
           'createdCommandId', seed.initialized_command_id::text,
           'createdEventId', seed.initialized_event_id::text,
           'createdStateRevision', seed.initialized_state_revision::text,
           'currencyStableKey',
             seed.canonical_plan -> 'currency' ->> 'stableKey',
           'policy', item.value,
           'policyVersion', 1,
           'sourcePlanHash', encode(seed.plan_hash, 'hex'),
           'sourceWorldVersionId', seed.world_version_id::text
         ) AS document
  FROM seed_authority seed
  CROSS JOIN LATERAL jsonb_array_elements(
    seed.canonical_plan -> 'taxPolicies'
  ) item(value)
  LEFT JOIN public.world_entities payer
    ON item.value ->> 'taxType' = 'periodic_flat'
   AND payer.world_id = checked_world_id
   AND payer.logical_key::text = item.value ->> 'payerEntityLogicalKey'
  LEFT JOIN public.wallets payer_wallet
    ON item.value ->> 'taxType' = 'periodic_flat'
   AND payer_wallet.world_id = checked_world_id
   AND payer_wallet.stable_key::text = item.value ->> 'payerWalletStableKey'
),
production_live_rows AS (
  SELECT run.id,
         jsonb_build_object(
           'businessId', run.business_id::text,
           'completionEvents', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'aggregateId', event.aggregate_id,
               'aggregateType', event.aggregate_type,
               'aggregateVersion', event.aggregate_version::text,
               'commandId', event.command_id::text,
               'eventId', event.id::text,
               'eventOrdinal', event.event_ordinal,
               'eventType', event.event_type,
               'payload', event.payload,
               'stateRevision', event.resulting_state_revision::text
             ) ORDER BY event.event_ordinal, event.id)
             FROM public.domain_events event
             WHERE event.world_id = run.world_id
               AND (
                 (
                   run.terminal_command_id IS NOT NULL
                   AND event.command_id = run.terminal_command_id
                 )
                 OR (
                   event.aggregate_type = 'production_run'
                   AND event.aggregate_id = run.id::text
                   AND event.event_type IN (
                     'ResourcesConsumedV1','ResourcesProducedV1',
                     'ProductionFailedV1'
                   )
                 )
               )
           ), '[]'::jsonb),
           'dueTick', run.due_tick::text,
           'facilityId', run.facility_id::text,
           'failureCode', run.failure_code,
           'inputSnapshot', run.input_snapshot,
           'initialTransition', jsonb_build_object(
             'commandId', initial.command_id::text,
             'eventId', initial.event_id::text,
             'occurredTick', initial.occurred_tick::text,
             'snapshotChecksum', encode(initial.snapshot_hash, 'hex'),
             'stateRevision', initial.state_revision::text,
             'status', initial.status::text,
             'transitionVersion', initial.transition_version::text
           ),
           'outputSnapshot', run.output_snapshot,
           'productionMovements', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'commandId', movement.command_id::text,
               'eventId', movement.event_id::text,
               'fromInventoryId', movement.from_inventory_id::text,
               'movementKind', movement.movement_kind::text,
               'quantity', movement.quantity::numeric(30,12)::text,
               'resourceTypeId', movement.resource_type_id::text,
               'sourceId', movement.source_id::text,
               'sourceOrdinal', movement.source_ordinal,
               'sourceType', movement.source_type,
               'stateRevision', movement.state_revision::text,
               'occurredTick', movement.occurred_tick::text,
               'toInventoryId', movement.to_inventory_id::text
             ) ORDER BY movement.source_ordinal)
             FROM public.inventory_movements movement
             WHERE movement.world_id = run.world_id
               AND (
                 movement.command_id = run.terminal_command_id
                 OR (
                   movement.source_type = 'production_run'
                   AND movement.source_id = run.id
                 )
               )
           ), '[]'::jsonb),
           'productionRunId', run.id::text,
           'quantity', run.quantity::numeric(30,12)::text,
           'recipeVersionId', run.recipe_version_id::text,
           'reservations', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'inventoryId', reservation.inventory_id::text,
               'quantity', reservation.quantity::numeric(30,12)::text,
               'rowVersion', reservation.row_version::text,
               'status', reservation.status::text,
               'terminalCommandId', reservation.terminal_command_id::text,
               'terminalEventId', reservation.terminal_event_id::text,
               'terminalStateRevision', reservation.terminal_state_revision::text
             ) ORDER BY reservation.inventory_id)
             FROM public.inventory_reservations reservation
             WHERE reservation.world_id = run.world_id
               AND reservation.purpose_type = 'production_input'
               AND reservation.purpose_id = run.id
           ), '[]'::jsonb),
           'rowVersion', run.row_version::text,
           'scheduledActionId', run.scheduled_action_id::text,
           'snapshotChecksum', encode(run.snapshot_checksum, 'hex'),
           'status', run.status::text,
           'terminalCommandId', run.terminal_command_id::text,
           'terminalEventId', run.terminal_event_id::text,
           'terminalStateRevision', run.terminal_state_revision::text,
           'transitionSnapshotChecksum', encode(latest.snapshot_hash, 'hex')
         ) AS document
  FROM public.production_runs run
  LEFT JOIN production_latest latest ON latest.run_id = run.id
  LEFT JOIN public.production_run_transitions initial
    ON initial.world_id = run.world_id
   AND initial.run_id = run.id
   AND initial.transition_version = 1
  WHERE run.world_id = checked_world_id
),
production_rebuilt_rows AS (
  SELECT latest.run_id AS id,
         jsonb_build_object(
           'businessId', command_fact.authority ->> 'businessId',
           'completionEvents', CASE
             WHEN latest.status = 'completed'::production_run_status
             THEN jsonb_build_array(
               jsonb_build_object(
                 'aggregateId', latest.run_id::text,
                 'aggregateType', 'production_run',
                 'aggregateVersion', '2',
                 'commandId', latest.command_id::text,
                 'eventId', consumed_event.id::text,
                 'eventOrdinal', 0,
                 'eventType', 'ResourcesConsumedV1',
                 'payload', jsonb_build_object(
                   'aggregateVersion', '2',
                   'productionRunId', latest.run_id::text,
                   'resources', command_fact.authority -> 'inputSnapshot',
                   'tick', latest.occurred_tick::text
                 ),
                 'stateRevision', latest.state_revision::text
               ),
               jsonb_build_object(
                 'aggregateId', latest.run_id::text,
                 'aggregateType', 'production_run',
                 'aggregateVersion', '3',
                 'commandId', latest.command_id::text,
                 'eventId', terminal_event.id::text,
                 'eventOrdinal', 1,
                 'eventType', 'ResourcesProducedV1',
                 'payload', jsonb_build_object(
                   'aggregateVersion', '3',
                   'productionRunId', latest.run_id::text,
                   'resources', command_fact.authority -> 'outputSnapshot',
                   'tick', latest.occurred_tick::text
                 ),
                 'stateRevision', latest.state_revision::text
               )
             )
             WHEN latest.status = 'failed'::production_run_status
             THEN jsonb_build_array(jsonb_build_object(
               'aggregateId', latest.run_id::text,
               'aggregateType', 'production_run',
               'aggregateVersion', '2',
               'commandId', latest.command_id::text,
               'eventId', terminal_event.id::text,
               'eventOrdinal', 0,
               'eventType', 'ProductionFailedV1',
               'payload', jsonb_build_object(
                 'aggregateVersion', '2',
                 'errorCode', terminal_event.payload ->> 'errorCode',
                 'productionRunId', latest.run_id::text,
                 'tick', latest.occurred_tick::text
               ),
               'stateRevision', latest.state_revision::text
             ))
             ELSE '[]'::jsonb
           END,
           'dueTick', command_fact.authority ->> 'dueTick',
           'facilityId', command_fact.authority ->> 'facilityId',
           'failureCode', CASE
             WHEN latest.status = 'failed'::production_run_status
               THEN terminal_event.payload ->> 'errorCode'
             ELSE NULL
           END,
           'inputSnapshot', command_fact.authority -> 'inputSnapshot',
           'initialTransition', command_fact.authority -> 'initialTransition',
           'outputSnapshot', command_fact.authority -> 'outputSnapshot',
           'productionMovements', CASE
             WHEN latest.status = 'completed'::production_run_status
             THEN COALESCE((
               SELECT jsonb_agg(effect.document ORDER BY effect.ordinal)
               FROM (
                 SELECT (expected.ordinality - 1)::integer AS ordinal,
                        jsonb_build_object(
                          'commandId', latest.command_id::text,
                          'eventId', consumed_event.id::text,
                          'fromInventoryId', expected.inventory_id::text,
                          'movementKind', 'production_consume',
                          'quantity', expected.quantity_text,
                          'resourceTypeId', expected.resource_type_id,
                          'sourceId', latest.run_id::text,
                          'sourceOrdinal',
                            (expected.ordinality - 1)::integer,
                          'sourceType', 'production_run',
                          'stateRevision', latest.state_revision::text,
                          'occurredTick', latest.occurred_tick::text,
                          'toInventoryId', NULL
                        ) AS document
                 FROM production_expected_inputs expected
                 WHERE expected.run_id = latest.run_id
                 UNION ALL
                 SELECT (
                          (SELECT count(*)
                             FROM production_expected_inputs input
                            WHERE input.run_id = latest.run_id)
                          + expected.ordinality - 1
                        )::integer AS ordinal,
                        jsonb_build_object(
                          'commandId', latest.command_id::text,
                          'eventId', terminal_event.id::text,
                          'fromInventoryId', NULL,
                          'movementKind', 'production_output',
                          'quantity', expected.quantity_text,
                          'resourceTypeId', expected.resource_type_id,
                          'sourceId', latest.run_id::text,
                          'sourceOrdinal', (
                            (SELECT count(*)
                               FROM production_expected_inputs input
                              WHERE input.run_id = latest.run_id)
                            + expected.ordinality - 1
                          )::integer,
                          'sourceType', 'production_run',
                          'stateRevision', latest.state_revision::text,
                          'occurredTick', latest.occurred_tick::text,
                          'toInventoryId', inventory.id::text
                        ) AS document
                 FROM production_expected_outputs expected
                 LEFT JOIN public.businesses business
                   ON business.world_id = checked_world_id
                  AND business.id =
                    (command_fact.authority ->> 'businessId')::uuid
                 LEFT JOIN public.business_facilities facility
                   ON facility.world_id = checked_world_id
                  AND facility.id =
                    (command_fact.authority ->> 'facilityId')::uuid
                 LEFT JOIN public.inventories inventory
                   ON inventory.world_id = checked_world_id
                  AND inventory.owner_entity_id =
                    business.backing_organization_entity_id
                  AND inventory.container_asset_id = facility.facility_asset_id
                  AND inventory.resource_type_id::text =
                    expected.resource_type_id
                 WHERE expected.run_id = latest.run_id
               ) effect
             ), '[]'::jsonb)
             ELSE '[]'::jsonb
           END,
           'productionRunId', latest.run_id::text,
           'quantity',
             (command_fact.authority ->> 'runQuantity')::numeric(30,12)::text,
           'recipeVersionId', command_fact.authority ->> 'recipeVersionId',
           'reservations', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'inventoryId', expected.inventory_id::text,
               'quantity', expected.quantity::numeric(30,12)::text,
               'rowVersion', CASE
                 WHEN latest.status IN ('completed','failed','cancelled') THEN '2'
                 ELSE '1'
               END,
               'status', CASE latest.status
                 WHEN 'completed'::production_run_status THEN 'consumed'
                 WHEN 'failed'::production_run_status THEN 'released'
                 WHEN 'cancelled'::production_run_status THEN 'released'
                 ELSE 'active'
               END,
               'terminalCommandId', CASE
                 WHEN latest.status IN ('completed','failed','cancelled')
                   THEN latest.command_id::text
                 ELSE NULL
               END,
               'terminalEventId', CASE
                 WHEN latest.status = 'completed'::production_run_status
                   THEN consumed_event.id::text
                 WHEN latest.status IN ('failed','cancelled')
                   THEN latest.event_id::text
                 ELSE NULL
               END,
               'terminalStateRevision', CASE
                 WHEN latest.status IN ('completed','failed','cancelled')
                   THEN latest.state_revision::text
                 ELSE NULL
               END
             ) ORDER BY expected.inventory_id)
             FROM production_expected_inputs expected
             WHERE expected.run_id = latest.run_id
           ), '[]'::jsonb),
           'rowVersion', latest.transition_version::text,
           'scheduledActionId',
             command_fact.authority ->> 'scheduledActionId',
           'snapshotChecksum',
             command_fact.authority ->> 'snapshotChecksum',
           'status', latest.status::text,
           'terminalCommandId', CASE
             WHEN latest.status IN ('completed','failed','cancelled')
               THEN latest.command_id::text
             ELSE NULL
           END,
           'terminalEventId', CASE
             WHEN latest.status IN ('completed','failed','cancelled')
               THEN latest.event_id::text
             ELSE NULL
           END,
           'terminalStateRevision', CASE
             WHEN latest.status IN ('completed','failed','cancelled')
               THEN latest.state_revision::text
             ELSE NULL
           END,
           'transitionSnapshotChecksum',
             command_fact.authority ->> 'snapshotChecksum'
         ) AS document
  FROM production_latest latest
  JOIN public.production_run_transitions initial
    ON initial.world_id = checked_world_id
   AND initial.run_id = latest.run_id
   AND initial.transition_version = 1
  JOIN public.domain_events started
    ON started.world_id = initial.world_id AND started.id = initial.event_id
   AND started.event_type = 'ProductionRunStartedV1'
  JOIN public.commerce_command_payload_facts command_fact
    ON command_fact.world_id = initial.world_id
   AND command_fact.command_id = initial.command_id
   AND command_fact.command_type = 'StartProductionRunV1'
  JOIN production_expected_snapshots snapshot
    ON snapshot.run_id = latest.run_id
  LEFT JOIN public.domain_events terminal_event
    ON terminal_event.world_id = checked_world_id
   AND terminal_event.id = latest.event_id
  LEFT JOIN public.domain_events consumed_event
    ON consumed_event.world_id = checked_world_id
   AND consumed_event.command_id = latest.command_id
   AND consumed_event.event_ordinal = 0
   AND consumed_event.aggregate_type = 'production_run'
   AND consumed_event.aggregate_id = latest.run_id::text
   AND consumed_event.event_type = 'ResourcesConsumedV1'
),
contract_latest AS (
  SELECT DISTINCT ON (event.aggregate_id)
         event.aggregate_id::uuid AS contract_id, event.id, event.command_id,
         event.aggregate_version, event.event_type, event.payload,
         event.resulting_state_revision
  FROM public.domain_events event
  WHERE event.world_id = checked_world_id
    AND event.aggregate_type = 'employment_contract'
    AND event.event_type IN (
      'EmploymentContractCreatedV1','EmploymentContractAcceptedV1',
      'EmploymentContractEndedV1'
    )
  ORDER BY event.aggregate_id, event.aggregate_version DESC
),
contract_live_rows AS (
  SELECT contract.id,
         jsonb_build_object(
           'acceptedCommandId', contract.accepted_command_id::text,
           'acceptedEventId', contract.accepted_event_id::text,
           'acceptedStateRevision', contract.accepted_state_revision::text,
           'businessId', contract.business_id::text,
           'contractId', contract.id::text,
           'currencyId', contract.currency_id::text,
           'rowVersion', contract.row_version::text,
           'status', contract.status::text,
           'terminalCommandId', contract.terminal_command_id::text,
           'terminalEventId', contract.terminal_event_id::text,
           'terminalReason', contract.terminal_reason,
           'terminalStateRevision', contract.terminal_state_revision::text,
           'termsHash', encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(jsonb_build_object(
               'businessId', contract.business_id::text,
               'cooldownTicks', contract.cooldown_ticks::text,
               'currencyId', contract.currency_id::text,
               'effectiveFromTick', contract.effective_from_tick::text,
               'effectiveToTick', contract.effective_until_tick::text,
               'employerWalletId', contract.employer_wallet_id::text,
               'maxPerformancesPerPeriod', contract.max_payments_per_period,
               'periodTicks', contract.cadence_ticks::text,
               'rewardCapMinor', contract.reward_cap_minor::text,
               'roleCode', contract.role_code,
               'wageMinor', contract.wage_minor::text,
               'wageRuleKind', contract.wage_rule::text,
               'workerEntityKey', worker.logical_key::text,
               'workerWalletId', contract.worker_wallet_id::text
             )), 'UTF8'
           ), 'sha256'), 'hex'),
           'workerEntityId', contract.worker_entity_id::text
         ) AS document
  FROM public.employment_contracts contract
  JOIN public.world_entities worker
    ON worker.world_id = contract.world_id AND worker.id = contract.worker_entity_id
  WHERE contract.world_id = checked_world_id
),
contract_rebuilt_rows AS (
  SELECT created.aggregate_id::uuid AS id,
         jsonb_build_object(
           'acceptedCommandId', accepted.command_id::text,
           'acceptedEventId', accepted.id::text,
           'acceptedStateRevision', accepted.resulting_state_revision::text,
           'businessId', created_fact.authority ->> 'businessId',
           'contractId', created.aggregate_id,
           'currencyId', created_fact.authority ->> 'currencyId',
           'rowVersion', latest.aggregate_version::text,
           'status', latest.payload ->> 'status',
           'terminalCommandId', CASE
             WHEN latest.event_type = 'EmploymentContractEndedV1'
               THEN latest.command_id::text
             ELSE NULL
           END,
           'terminalEventId', CASE
             WHEN latest.event_type = 'EmploymentContractEndedV1'
               THEN latest.id::text
             ELSE NULL
           END,
           'terminalReason', CASE
             WHEN latest.event_type = 'EmploymentContractEndedV1'
               THEN terminal_fact.authority ->> 'reason'
             ELSE NULL
           END,
           'terminalStateRevision', CASE
             WHEN latest.event_type = 'EmploymentContractEndedV1'
               THEN latest.resulting_state_revision::text
             ELSE NULL
           END,
           'termsHash', encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(jsonb_build_object(
               'businessId', created_fact.authority ->> 'businessId',
               'cooldownTicks',
                 created_fact.authority ->> 'cooldownTicks',
               'currencyId', created_fact.authority ->> 'currencyId',
               'effectiveFromTick',
                 created_fact.authority ->> 'effectiveFromTick',
               'effectiveToTick',
                 created_fact.authority ->> 'effectiveToTick',
               'employerWalletId',
                 created_fact.authority ->> 'employerWalletId',
               'maxPerformancesPerPeriod',
                 (created_fact.authority
                   ->> 'maxPerformancesPerPeriod')::integer,
               'periodTicks', created_fact.authority ->> 'periodTicks',
               'rewardCapMinor',
                 created_fact.authority ->> 'rewardCapMinor',
               'roleCode', created_fact.authority ->> 'roleCode',
               'wageMinor', created_fact.authority ->> 'wageMinor',
               'wageRuleKind',
                 created_fact.authority ->> 'wageRuleKind',
               'workerEntityKey',
                 created_fact.authority ->> 'workerEntityKey',
               'workerWalletId',
                 created_fact.authority ->> 'workerWalletId'
             )), 'UTF8'
           ), 'sha256'), 'hex'),
           'workerEntityId',
             created_fact.authority ->> 'workerEntityId'
         ) AS document
  FROM public.domain_events created
  JOIN contract_latest latest
    ON latest.contract_id = created.aggregate_id::uuid
  JOIN public.commerce_command_payload_facts created_fact
    ON created_fact.world_id = created.world_id
   AND created_fact.command_id = created.command_id
   AND created_fact.command_type = 'CreateEmploymentContractV1'
  LEFT JOIN public.domain_events accepted
    ON accepted.world_id = created.world_id
   AND accepted.aggregate_type = 'employment_contract'
   AND accepted.aggregate_id = created.aggregate_id
   AND accepted.event_type = 'EmploymentContractAcceptedV1'
  LEFT JOIN public.commerce_command_payload_facts terminal_fact
    ON terminal_fact.world_id = created.world_id
   AND terminal_fact.command_id = latest.command_id
   AND terminal_fact.command_type = 'EndEmploymentContractV1'
  WHERE created.world_id = checked_world_id
    AND created.aggregate_type = 'employment_contract'
    AND created.event_type = 'EmploymentContractCreatedV1'
),
listing_live_rows AS (
  SELECT listing.id,
         jsonb_build_object(
           'createdCommandId', listing.created_command_id::text,
           'createdEventId', listing.created_event_id::text,
           'createdStateRevision', listing.created_state_revision::text,
           'currencyId', listing.currency_id::text,
           'listingId', listing.id::text,
           'offeredQuantity', listing.offered_quantity::numeric(30,12)::text,
           'remainingQuantity', listing.remaining_quantity::numeric(30,12)::text,
           'reservation', COALESCE((
             SELECT jsonb_build_object(
               'inventoryId', reservation.inventory_id::text,
               'quantity', reservation.quantity::numeric(30,12)::text,
               'rowVersion', reservation.row_version::text,
               'status', reservation.status::text,
               'terminalCommandId', reservation.terminal_command_id::text,
               'terminalEventId', reservation.terminal_event_id::text,
               'terminalStateRevision', reservation.terminal_state_revision::text
             )
             FROM public.inventory_reservations reservation
             WHERE reservation.world_id = listing.world_id
               AND reservation.purpose_type = 'market_listing'
               AND reservation.purpose_id = listing.id
           ), '{}'::jsonb),
           'resourceTypeId', listing.resource_type_id::text,
           'reservedQuantity', listing.reserved_quantity::numeric(30,12)::text,
           'rowVersion', listing.row_version::text,
           'scheduledActionId', listing.scheduled_action_id::text,
           'schemaVersion', listing.market_listing_schema_version::text,
           'sellerEntityId', listing.seller_entity_id::text,
           'sellerInventoryId', listing.seller_inventory_id::text,
           'sellerWalletId', listing.seller_wallet_id::text,
           'status', listing.status::text,
           'terminalCommandId', listing.terminal_command_id::text,
           'terminalEventId', listing.terminal_event_id::text,
           'terminalStateRevision', listing.terminal_state_revision::text,
           'termsHash', encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(jsonb_build_object(
               'expiresAtTick', listing.expires_at_tick::text,
               'quantity', listing.offered_quantity::numeric(30,12)::text,
               'sellerInventoryId', listing.seller_inventory_id::text,
               'sellerWalletId', listing.seller_wallet_id::text,
               'unitPriceMinor', listing.unit_price_minor::text
             )), 'UTF8'
           ), 'sha256'), 'hex')
         ) AS document
  FROM public.market_listings listing
  WHERE listing.world_id = checked_world_id
),
listing_rebuilt_rows AS (
  SELECT created.aggregate_id::uuid AS id,
         jsonb_build_object(
           'createdCommandId', created.command_id::text,
           'createdEventId', created.id::text,
           'createdStateRevision', created.resulting_state_revision::text,
           'currencyId', created_fact.authority ->> 'currencyId',
           'listingId', created.aggregate_id,
           'offeredQuantity',
             (created_fact.authority
               ->> 'offeredQuantity')::numeric(30,12)::text,
           'remainingQuantity',
             (latest.payload ->> 'remainingQuantity')::numeric(30,12)::text,
           'reservation', jsonb_build_object(
             'inventoryId',
               created_fact.authority ->> 'sellerInventoryId',
             'quantity', (
               CASE
                 WHEN latest.payload ->> 'status' = 'filled' THEN (
                   SELECT (trade.payload ->> 'quantity')::numeric
                   FROM public.domain_events trade
                   WHERE trade.world_id = checked_world_id
                     AND trade.command_id = latest.command_id
                     AND trade.event_type = 'MarketTradeCompletedV1'
                   LIMIT 1
                 )
                 ELSE (latest.payload ->> 'remainingQuantity')::numeric
               END
             )::numeric(30,12)::text,
             'rowVersion', latest.aggregate_version::text,
             'status', CASE latest.payload ->> 'status'
               WHEN 'filled' THEN 'consumed'
               WHEN 'cancelled' THEN 'released'
               WHEN 'expired' THEN 'expired'
               ELSE 'active'
             END,
             'terminalCommandId', CASE
               WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
                 THEN latest.command_id::text
               ELSE NULL
             END,
             'terminalEventId', CASE
               WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
                 THEN latest.id::text
               ELSE NULL
             END,
             'terminalStateRevision', CASE
               WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
                 THEN latest.resulting_state_revision::text
               ELSE NULL
             END
           ),
           'resourceTypeId',
             created_fact.authority ->> 'resourceTypeId',
           'reservedQuantity', CASE
             WHEN latest.payload ->> 'status' = 'open'
               THEN (latest.payload ->> 'remainingQuantity')::numeric(30,12)::text
             ELSE 0::numeric(30,12)::text
           END,
           'rowVersion', latest.aggregate_version::text,
           'scheduledActionId',
             created_fact.authority ->> 'scheduledActionId',
           'schemaVersion', '1',
           'sellerEntityId',
             created_fact.authority ->> 'sellerEntityId',
           'sellerInventoryId',
             created_fact.authority ->> 'sellerInventoryId',
           'sellerWalletId',
             created_fact.authority ->> 'sellerWalletId',
           'status', latest.payload ->> 'status',
           'terminalCommandId', CASE
             WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
               THEN latest.command_id::text
             ELSE NULL
           END,
           'terminalEventId', CASE
             WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
               THEN latest.id::text
             ELSE NULL
           END,
           'terminalStateRevision', CASE
             WHEN latest.payload ->> 'status' IN ('filled','cancelled','expired')
               THEN latest.resulting_state_revision::text
             ELSE NULL
           END,
           'termsHash', encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(jsonb_build_object(
               'expiresAtTick',
                 created_fact.authority ->> 'expiresAtTick',
               'quantity',
                 (created_fact.authority
                   ->> 'offeredQuantity')::numeric(30,12)::text,
               'sellerInventoryId',
                 created_fact.authority ->> 'sellerInventoryId',
               'sellerWalletId',
                 created_fact.authority ->> 'sellerWalletId',
               'unitPriceMinor',
                 created_fact.authority ->> 'unitPriceMinor'
             )), 'UTF8'
           ), 'sha256'), 'hex')
         ) AS document
  FROM public.domain_events created
  JOIN listing_latest latest
    ON latest.listing_id = created.aggregate_id::uuid
  JOIN public.commerce_command_payload_facts created_fact
    ON created_fact.world_id = created.world_id
   AND created_fact.command_id = created.command_id
   AND created_fact.command_type = 'CreateMarketListingV1'
  WHERE created.world_id = checked_world_id
    AND created.aggregate_type = 'market_listing'
    AND created.event_type = 'MarketListingCreatedV1'
),
trade_live_rows AS (
  SELECT trade.id,
         jsonb_build_object(
           'buyerEntityId', trade.buyer_entity_id::text,
           'buyerInventoryId', trade.buyer_inventory_id::text,
           'buyerTotalMinor', trade.buyer_total_minor::text,
           'commandId', trade.command_id::text,
           'currencyId', trade.currency_id::text,
           'eventId', trade.event_id::text,
           'feeMinor', trade.fee_minor::text,
           'grossMinor', trade.gross_minor::text,
           'idempotencyKey', trade.idempotency_key,
           'listingId', trade.listing_id::text,
           'occurredTick', trade.occurred_tick::text,
           'postingsHash', encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'ordinal', posting.posting_ordinal,
                 'signedAmountMinor', posting.signed_amount_minor::text,
                 'walletId', posting.wallet_id::text
               ) ORDER BY posting.posting_ordinal)
               FROM public.wallet_postings posting
               WHERE posting.transaction_id = trade.wallet_transaction_id
             ), '[]'::jsonb)), 'UTF8'
           ), 'sha256'), 'hex'),
           'quantity', trade.quantity::numeric(30,12)::text,
           'roundingPolicyVersion', trade.rounding_policy_version::text,
           'schemaVersion', trade.market_trade_schema_version::text,
           'sellerEntityId', trade.seller_entity_id::text,
           'sellerInventoryId', trade.seller_inventory_id::text,
           'sellerNetMinor', trade.seller_net_minor::text,
           'stateRevision', trade.state_revision::text,
           'taxMinor', trade.tax_minor::text,
           'tradeId', trade.id::text,
           'unitPriceMinor', trade.unit_price_minor::text,
           'walletTransactionId', trade.wallet_transaction_id::text
         ) AS document
  FROM public.market_trades trade
  WHERE trade.world_id = checked_world_id
),
trade_rebuilt_rows AS (
  SELECT event.aggregate_id::uuid AS id,
         jsonb_build_object(
           'buyerEntityId',
             command_fact.authority ->> 'buyerEntityId',
           'buyerInventoryId',
             command_fact.authority ->> 'buyerInventoryId',
           'buyerTotalMinor', event.payload ->> 'buyerTotalMinor',
           'commandId', event.command_id::text,
           'currencyId', command_fact.authority ->> 'currencyId',
           'eventId', event.id::text,
           'feeMinor', event.payload ->> 'feeMinor',
           'grossMinor', event.payload ->> 'grossMinor',
           'idempotencyKey', command.idempotency_key,
           'listingId', event.payload ->> 'listingId',
           'occurredTick', transaction.occurred_tick::text,
           'postingsHash', encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'ordinal', expected_posting.ordinal - 1,
                 'signedAmountMinor', expected_posting.signed_amount_minor::text,
                 'walletId', expected_posting.wallet_id::text
               ) ORDER BY expected_posting.ordinal)
               FROM (
                 SELECT combined.wallet_id,
                        sum(combined.signed_amount_minor)::bigint
                          AS signed_amount_minor,
                        row_number() OVER (ORDER BY combined.wallet_id) AS ordinal
                 FROM (
                   SELECT
                     (command_fact.authority ->> 'buyerWalletId')::uuid
                       AS wallet_id,
                          -(event.payload ->> 'buyerTotalMinor')::bigint
                            AS signed_amount_minor
                   UNION ALL
                   SELECT
                     (command_fact.authority ->> 'sellerWalletId')::uuid,
                          (event.payload ->> 'sellerNetMinor')::bigint
                   UNION ALL
                   SELECT policy.treasury_wallet_id,
                          (assessment.payload ->> 'amountMinor')::bigint
                   FROM public.domain_events assessment
                   JOIN public.tax_policies policy
                     ON policy.world_id = assessment.world_id
                    AND policy.id = (assessment.payload ->> 'policyId')::uuid
                   WHERE assessment.world_id = event.world_id
                     AND assessment.command_id = event.command_id
                     AND assessment.event_type = 'TaxAssessedV1'
                     AND (assessment.payload ->> 'amountMinor')::bigint > 0
                 ) combined
                 GROUP BY combined.wallet_id
                 HAVING sum(combined.signed_amount_minor) <> 0
               ) expected_posting
             ), '[]'::jsonb)), 'UTF8'
           ), 'sha256'), 'hex'),
           'quantity', (event.payload ->> 'quantity')::numeric(30,12)::text,
           'roundingPolicyVersion', '1',
           'schemaVersion', '1',
           'sellerEntityId',
             command_fact.authority ->> 'sellerEntityId',
           'sellerInventoryId',
             command_fact.authority ->> 'sellerInventoryId',
           'sellerNetMinor', event.payload ->> 'sellerNetMinor',
           'stateRevision', event.resulting_state_revision::text,
           'taxMinor', event.payload ->> 'taxMinor',
           'tradeId', event.aggregate_id,
           'unitPriceMinor',
             command_fact.authority ->> 'unitPriceMinor',
           'walletTransactionId',
             command_fact.authority ->> 'walletTransactionId'
         ) AS document
  FROM public.domain_events event
  JOIN public.command_records command
    ON command.world_id = event.world_id AND command.id = event.command_id
   AND command.command_type = 'PurchaseMarketListingV1'
   AND command.status = 'accepted'::command_record_status
  JOIN public.commerce_command_payload_facts command_fact
    ON command_fact.world_id = command.world_id
   AND command_fact.command_id = command.id
   AND command_fact.command_type = 'PurchaseMarketListingV1'
  JOIN public.inventory_movements movement
    ON movement.world_id = event.world_id
   AND movement.id =
     (command_fact.authority ->> 'movementId')::uuid
   AND movement.source_type = 'market_trade'
   AND movement.source_id = event.aggregate_id::uuid
   AND movement.movement_kind = 'market_trade'
   AND movement.from_inventory_id =
     (command_fact.authority ->> 'sellerInventoryId')::uuid
   AND movement.to_inventory_id =
     (command_fact.authority ->> 'buyerInventoryId')::uuid
   AND movement.quantity =
     (command_fact.authority ->> 'quantity')::numeric
  JOIN public.financial_transactions transaction
    ON transaction.world_id = event.world_id
   AND transaction.id =
     (command_fact.authority ->> 'walletTransactionId')::uuid
   AND transaction.command_id = event.command_id
   AND transaction.transaction_kind::text = 'market_purchase'
  WHERE event.world_id = checked_world_id
    AND event.aggregate_type = 'market_trade'
    AND event.event_type = 'MarketTradeCompletedV1'
),
payroll_terminal AS (
  SELECT DISTINCT ON (event.aggregate_id)
         event.aggregate_id::uuid AS payroll_id, event.id, event.command_id,
         event.event_type, event.payload, event.resulting_state_revision
  FROM public.domain_events event
  WHERE event.world_id = checked_world_id
    AND event.aggregate_type = 'payroll_record'
    AND event.event_type IN ('PayrollSettledV1','PayrollFailedV1')
  ORDER BY event.aggregate_id, event.aggregate_version DESC
),
payroll_live_rows AS (
  SELECT payroll.id,
         jsonb_build_object(
           'contractId', payroll.contract_id::text,
           'createdCommandId', payroll.created_command_id::text,
           'createdEventId', payroll.created_event_id::text,
           'createdStateRevision', payroll.created_state_revision::text,
           'financialTransactionId', payroll.financial_transaction_id::text,
           'grossMinor', payroll.gross_minor::text,
           'netMinor', payroll.net_minor::text,
           'payPeriodKey', payroll.pay_period_key,
           'payrollRecordId', payroll.id::text,
           'postingsHash', CASE
             WHEN payroll.financial_transaction_id IS NULL THEN NULL
             ELSE encode(extensions.digest(convert_to(
               public.worldgraph_canonical_jsonb(COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'ordinal', posting.posting_ordinal,
                   'signedAmountMinor', posting.signed_amount_minor::text,
                   'walletId', posting.wallet_id::text
                 ) ORDER BY posting.posting_ordinal)
                 FROM public.wallet_postings posting
                 WHERE posting.transaction_id = payroll.financial_transaction_id
               ), '[]'::jsonb)), 'UTF8'
             ), 'sha256'), 'hex')
           END,
           'rowVersion', payroll.row_version::text,
           'scheduledActionId', payroll.scheduled_action_id::text,
           'status', payroll.status::text,
           'taxMinor', payroll.tax_minor::text,
           'taxPolicyId', payroll.tax_policy_id::text,
           'terminalCommandId', payroll.terminal_command_id::text,
           'terminalErrorCode', payroll.error_code,
           'terminalEventId', payroll.terminal_event_id::text,
           'terminalStateRevision', payroll.terminal_state_revision::text,
           'workRecordId', payroll.work_record_id::text
         ) AS document
  FROM public.payroll_records payroll
  WHERE payroll.world_id = checked_world_id
),
payroll_rebuilt_rows AS (
  SELECT (recorded.payload ->> 'payrollRecordId')::uuid AS id,
         jsonb_build_object(
           'contractId', recorded.payload ->> 'contractId',
           'createdCommandId', recorded.command_id::text,
           'createdEventId', recorded.id::text,
           'createdStateRevision', recorded.resulting_state_revision::text,
           'financialTransactionId', CASE
             WHEN terminal.event_type = 'PayrollSettledV1'
               THEN terminal.payload ->> 'financialTransactionId'
             ELSE NULL
           END,
           'grossMinor', selection.gross_minor::text,
           'netMinor', selection.net_minor::text,
           'payPeriodKey',
             (
               (
                 work.performed_tick
                 / (contract_fact.authority ->> 'periodTicks')::bigint
               )
               * (contract_fact.authority ->> 'periodTicks')::bigint
             )::text
             || ':' || (recorded.payload ->> 'contractId')
             || ':' || work.id::text,
           'payrollRecordId', recorded.payload ->> 'payrollRecordId',
           'postingsHash', CASE
             WHEN terminal.event_type IS DISTINCT FROM 'PayrollSettledV1' THEN NULL
             ELSE encode(extensions.digest(convert_to(
               public.worldgraph_canonical_jsonb(COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'ordinal', expected_posting.ordinal - 1,
                   'signedAmountMinor', expected_posting.signed_amount_minor::text,
                   'walletId', expected_posting.wallet_id::text
                 ) ORDER BY expected_posting.ordinal)
                 FROM (
                   SELECT combined.wallet_id,
                          sum(combined.signed_amount_minor)::bigint
                            AS signed_amount_minor,
                          row_number() OVER (ORDER BY combined.wallet_id) AS ordinal
                   FROM (
                     SELECT
                       (contract_fact.authority
                         ->> 'employerWalletId')::uuid
                         AS wallet_id,
                       -(terminal.payload ->> 'grossMinor')::bigint
                         AS signed_amount_minor
                     UNION ALL
                     SELECT
                       (contract_fact.authority
                         ->> 'workerWalletId')::uuid,
                       (terminal.payload ->> 'netMinor')::bigint
                     UNION ALL
                     SELECT policy.treasury_wallet_id,
                            (terminal.payload ->> 'taxMinor')::bigint
                     WHERE policy.id IS NOT NULL
                       AND (terminal.payload ->> 'taxMinor')::bigint > 0
                   ) combined
                   GROUP BY combined.wallet_id
                   HAVING sum(combined.signed_amount_minor) <> 0
                 ) expected_posting
               ), '[]'::jsonb)), 'UTF8'
             ), 'sha256'), 'hex')
           END,
           'rowVersion', CASE WHEN terminal.id IS NULL THEN '1' ELSE '2' END,
           'scheduledActionId', schedule.id::text,
           'status', CASE terminal.event_type
             WHEN 'PayrollSettledV1' THEN 'paid'
             WHEN 'PayrollFailedV1' THEN 'failed'
             ELSE 'pending'
           END,
           'taxMinor', selection.tax_minor::text,
           'taxPolicyId', policy.id::text,
           'terminalCommandId', terminal.command_id::text,
           'terminalErrorCode', CASE
             WHEN terminal.event_type = 'PayrollFailedV1'
               THEN terminal.payload ->> 'errorCode'
             ELSE NULL
           END,
           'terminalEventId', terminal.id::text,
           'terminalStateRevision', terminal.resulting_state_revision::text,
           'workRecordId', work.id::text
         ) AS document
  FROM public.domain_events recorded
  JOIN public.work_records work
    ON work.world_id = recorded.world_id
   AND work.id = (recorded.payload ->> 'workRecordId')::uuid
  JOIN public.payroll_policy_selection_facts selection
    ON selection.world_id = recorded.world_id
   AND selection.payroll_record_id =
     (recorded.payload ->> 'payrollRecordId')::uuid
   AND selection.work_record_id = work.id
   AND selection.command_id = recorded.command_id
   AND selection.event_id = recorded.id
  JOIN public.domain_events contract_created
    ON contract_created.world_id = recorded.world_id
   AND contract_created.aggregate_type = 'employment_contract'
   AND contract_created.aggregate_id = (recorded.payload ->> 'contractId')
   AND contract_created.event_type = 'EmploymentContractCreatedV1'
  JOIN public.commerce_command_payload_facts contract_fact
    ON contract_fact.world_id = contract_created.world_id
   AND contract_fact.command_id = contract_created.command_id
   AND contract_fact.command_type = 'CreateEmploymentContractV1'
  LEFT JOIN public.tax_policies policy
    ON policy.world_id = selection.world_id AND policy.id = selection.tax_policy_id
  LEFT JOIN payroll_terminal terminal
    ON terminal.payroll_id = (recorded.payload ->> 'payrollRecordId')::uuid
  LEFT JOIN public.scheduled_actions schedule
    ON schedule.world_id = recorded.world_id
   AND schedule.created_command_id = recorded.command_id
   AND schedule.action_type = 'SettlePayrollV1'
   AND schedule.payload ->> 'payrollRecordId' = recorded.payload ->> 'payrollRecordId'
  WHERE recorded.world_id = checked_world_id
    AND recorded.aggregate_type = 'work_record'
    AND recorded.event_type = 'WorkRecordedV1'
),
tax_live_rows AS (
  SELECT assessment.source_type || ':' || assessment.source_id::text
           || ':' || assessment.policy_id::text
           || ':' || assessment.payer_wallet_id::text AS id,
         jsonb_build_object(
           'amountMinor', assessment.amount_minor::text,
           'basisMinor', assessment.basis_minor::text,
           'commandId', assessment.command_id::text,
           'currencyId', assessment.currency_id::text,
           'eventId', assessment.event_id::text,
           'occurredTick', assessment.occurred_tick::text,
           'payerEntityId', assessment.payer_entity_id::text,
           'payerWalletId', assessment.payer_wallet_id::text,
           'policyId', assessment.policy_id::text,
           'schemaVersion', assessment.tax_assessment_schema_version::text,
           'settlementTransactionId', assessment.settlement_transaction_id::text,
           'sourceId', assessment.source_id::text,
           'sourceType', assessment.source_type,
           'stateRevision', assessment.state_revision::text,
           'treasuryPostingMinor', COALESCE((
             SELECT sum(posting.signed_amount_minor)::text
             FROM public.wallet_postings posting
             WHERE posting.transaction_id = assessment.settlement_transaction_id
               AND posting.wallet_id = assessment.treasury_wallet_id
           ), '0'),
           'treasuryWalletId', assessment.treasury_wallet_id::text
         ) AS document
  FROM public.tax_assessments assessment
  WHERE assessment.world_id = checked_world_id
),
tax_rebuilt_rows AS (
  SELECT (CASE command.command_type
           WHEN 'PurchaseMarketListingV1' THEN 'market_trade'
           WHEN 'AssessPeriodicTaxV1' THEN 'periodic_tax'
         END) || ':' || (event.payload ->> 'sourceId')
         || ':' || (event.payload ->> 'policyId')
         || ':' || payer_authority.wallet_id AS id,
         jsonb_build_object(
           'amountMinor', event.payload ->> 'amountMinor',
           'basisMinor', event.payload ->> 'basisMinor',
           'commandId', event.command_id::text,
           'currencyId', transaction.currency_id::text,
           'eventId', event.id::text,
           'occurredTick', transaction.occurred_tick::text,
           'payerEntityId', CASE command.command_type
             WHEN 'AssessPeriodicTaxV1'
               THEN policy.applicability ->> 'payerEntityId'
             ELSE payer_authority.entity_id
           END,
           'payerWalletId', payer_authority.wallet_id,
           'policyId', event.payload ->> 'policyId',
           'schemaVersion', '1',
           'settlementTransactionId', transaction.id::text,
           'sourceId', event.payload ->> 'sourceId',
           'sourceType', CASE command.command_type
             WHEN 'PurchaseMarketListingV1' THEN 'market_trade'
             WHEN 'SettlePayrollV1' THEN 'payroll'
             WHEN 'AssessPeriodicTaxV1' THEN 'periodic_tax'
           END,
           'stateRevision', event.resulting_state_revision::text,
           'treasuryPostingMinor', COALESCE((
             SELECT sum((other.payload ->> 'amountMinor')::bigint)::text
             FROM public.domain_events other
             JOIN public.tax_policies other_policy
               ON other_policy.world_id = other.world_id
              AND other_policy.id = (other.payload ->> 'policyId')::uuid
             WHERE other.world_id = event.world_id
               AND other.command_id = event.command_id
               AND other.event_type = 'TaxAssessedV1'
               AND other_policy.treasury_wallet_id = policy.treasury_wallet_id
           ), '0'),
           'treasuryWalletId', policy.treasury_wallet_id::text
         ) AS document
  FROM public.domain_events event
  JOIN public.command_records command
   ON command.world_id = event.world_id AND command.id = event.command_id
   AND command.status = 'accepted'::command_record_status
  LEFT JOIN public.commerce_command_payload_facts command_fact
    ON command_fact.world_id = command.world_id
   AND command_fact.command_id = command.id
   AND command_fact.command_type = 'PurchaseMarketListingV1'
  JOIN public.tax_policies policy
    ON policy.world_id = event.world_id
   AND policy.id = (event.payload ->> 'policyId')::uuid
  JOIN public.financial_transactions transaction
    ON transaction.world_id = event.world_id
   AND transaction.command_id = event.command_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN command.command_type = 'PurchaseMarketListingV1'
        AND policy.tax_type = 'marketplace_fee'::tax_policy_type
        THEN command_fact.authority ->> 'sellerWalletId'
      WHEN command.command_type = 'PurchaseMarketListingV1'
        THEN command_fact.authority ->> 'buyerWalletId'
      WHEN command.command_type = 'AssessPeriodicTaxV1'
        THEN policy.applicability ->> 'payerWalletId'
    END AS wallet_id,
    CASE
      WHEN command.command_type = 'PurchaseMarketListingV1'
        AND policy.tax_type = 'marketplace_fee'::tax_policy_type
        THEN command_fact.authority ->> 'sellerEntityId'
      WHEN command.command_type = 'PurchaseMarketListingV1'
        THEN command_fact.authority ->> 'buyerEntityId'
      WHEN command.command_type = 'AssessPeriodicTaxV1'
        THEN policy.applicability ->> 'payerEntityId'
    END AS entity_id
  ) payer_authority
  WHERE event.world_id = checked_world_id
    AND event.aggregate_type = 'tax_assessment'
    AND event.event_type = 'TaxAssessedV1'
    AND command.command_type IN (
      'PurchaseMarketListingV1','AssessPeriodicTaxV1'
    )
    AND (
      command.command_type <> 'PurchaseMarketListingV1'
      OR command_fact.command_id IS NOT NULL
    )
  UNION ALL
  SELECT 'payroll:' || (event.payload ->> 'payrollRecordId')
           || ':' || selection.tax_policy_id::text
           || ':' || (contract_fact.authority ->> 'employerWalletId') AS id,
         jsonb_build_object(
           'amountMinor', event.payload ->> 'taxMinor',
           'basisMinor', event.payload ->> 'grossMinor',
           'commandId', event.command_id::text,
           'currencyId', transaction.currency_id::text,
           'eventId', event.id::text,
           'occurredTick', work.performed_tick::text,
           'payerEntityId',
             contract_fact.authority ->> 'employerEntityId',
           'payerWalletId',
             contract_fact.authority ->> 'employerWalletId',
           'policyId', selection.tax_policy_id::text,
           'schemaVersion', '1',
           'settlementTransactionId',
             event.payload ->> 'financialTransactionId',
           'sourceId', event.payload ->> 'payrollRecordId',
           'sourceType', 'payroll',
           'stateRevision', event.resulting_state_revision::text,
           'treasuryPostingMinor', event.payload ->> 'taxMinor',
           'treasuryWalletId', policy.treasury_wallet_id::text
         ) AS document
  FROM public.domain_events event
  JOIN public.payroll_policy_selection_facts selection
    ON selection.world_id = event.world_id
   AND selection.payroll_record_id =
     (event.payload ->> 'payrollRecordId')::uuid
   AND selection.tax_minor > 0
  JOIN public.work_records work
    ON work.world_id = selection.world_id
   AND work.id = selection.work_record_id
  JOIN public.domain_events recorded
    ON recorded.world_id = selection.world_id
   AND recorded.id = selection.event_id
   AND recorded.event_type = 'WorkRecordedV1'
  JOIN public.domain_events contract_created
    ON contract_created.world_id = recorded.world_id
   AND contract_created.aggregate_type = 'employment_contract'
   AND contract_created.aggregate_id = recorded.payload ->> 'contractId'
   AND contract_created.event_type = 'EmploymentContractCreatedV1'
  JOIN public.commerce_command_payload_facts contract_fact
    ON contract_fact.world_id = contract_created.world_id
   AND contract_fact.command_id = contract_created.command_id
   AND contract_fact.command_type = 'CreateEmploymentContractV1'
  JOIN public.tax_policies policy
    ON policy.world_id = selection.world_id
   AND policy.id = selection.tax_policy_id
  JOIN public.financial_transactions transaction
    ON transaction.world_id = event.world_id
   AND transaction.id =
     (event.payload ->> 'financialTransactionId')::uuid
  WHERE event.world_id = checked_world_id
    AND event.aggregate_type = 'payroll_record'
    AND event.event_type = 'PayrollSettledV1'
    AND (event.payload ->> 'taxMinor')::bigint > 0
),
live_cursor AS (
  SELECT CASE
      WHEN context.command_type = 'ReconcileWorldCommerceV1'
        THEN context.opened_head_checksum
      ELSE head.checksum
    END AS head_checksum,
    CASE
      WHEN context.command_type = 'ReconcileWorldCommerceV1'
        THEN context.opened_checkpoint_event_sequence
      ELSE checkpoint.last_event_sequence
    END AS checkpoint_event_sequence,
    CASE
      WHEN context.command_type = 'ReconcileWorldCommerceV1'
        THEN context.opened_checkpoint_checksum
      ELSE checkpoint.checksum
    END AS checkpoint_checksum,
    CASE
      WHEN context.command_type = 'ReconcileWorldCommerceV1'
        THEN context.opened_checkpoint_status
      ELSE checkpoint.status
    END AS checkpoint_status,
    context.command_type,
    context.opened_event_sequence
  FROM evidence_context context
  LEFT JOIN public.world_economy_expansion_heads head
    ON head.world_id = checked_world_id
  LEFT JOIN public.projection_checkpoints checkpoint
    ON checkpoint.world_id = checked_world_id
   AND checkpoint.projection_name = 'economy_closed_loop'
),
checkpoint_documents AS (
  SELECT CASE
      WHEN cursor.command_type = 'RepairEconomicProjectionV1' THEN
        jsonb_build_object('repairSnapshot', true)
      ELSE jsonb_build_object(
        'checkpointChecksum', encode(cursor.checkpoint_checksum, 'hex'),
        'checkpointEventSequence', cursor.checkpoint_event_sequence::text,
        'checkpointStatus', cursor.checkpoint_status::text,
        'headChecksum', encode(cursor.head_checksum, 'hex')
      )
    END AS live_document,
    CASE
      WHEN cursor.command_type = 'RepairEconomicProjectionV1' THEN
        jsonb_build_object('repairSnapshot', true)
      WHEN cursor.command_type = 'ReconcileWorldCommerceV1'
        AND cursor.head_checksum IS NOT DISTINCT FROM cursor.checkpoint_checksum
        AND cursor.checkpoint_status = 'current'::projection_checkpoint_status
        AND cursor.checkpoint_event_sequence = cursor.opened_event_sequence
        AND (
          EXISTS (
            SELECT 1
            FROM inventory_live_rows live
            FULL JOIN inventory_rebuilt_rows rebuilt USING (id)
            WHERE live.quantity IS DISTINCT FROM rebuilt.quantity
          )
          OR EXISTS (
            SELECT 1
            FROM reservation_live_rows live
            FULL JOIN reservation_rebuilt_rows rebuilt USING (id)
            WHERE live.quantity IS DISTINCT FROM rebuilt.quantity
          )
        ) THEN jsonb_build_object(
          'checkpointChecksum', encode(cursor.checkpoint_checksum, 'hex'),
          'checkpointEventSequence', cursor.checkpoint_event_sequence::text,
          'checkpointStatus', cursor.checkpoint_status::text,
          'headChecksum', encode(cursor.head_checksum, 'hex')
        )
      ELSE jsonb_build_object(
        'checkpointChecksum', encode(
          public.worldgraph_economy_expansion_projection_checksum(checked_world_id),
          'hex'
        ),
        'checkpointEventSequence', COALESCE(
          CASE
            WHEN cursor.command_type = 'ReconcileWorldCommerceV1'
              THEN cursor.opened_event_sequence::text
            ELSE runtime.last_event_sequence::text
          END,
          '0'
        ),
        'checkpointStatus', 'current',
        'headChecksum', encode(
          public.worldgraph_economy_expansion_projection_checksum(checked_world_id),
          'hex'
        )
      )
    END AS rebuilt_document
  FROM live_cursor cursor
  LEFT JOIN public.world_runtime_heads runtime
    ON runtime.world_id = checked_world_id
),
documents AS (
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'inventoryId', row.id::text, 'quantity', row.quantity
    ) ORDER BY row.id) FROM inventory_live_rows row), '[]'::jsonb)
      AS inventory_live,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'inventoryId', row.id::text, 'quantity', row.quantity
    ) ORDER BY row.id) FROM inventory_rebuilt_rows row), '[]'::jsonb)
      AS inventory_rebuilt,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'inventoryId', row.id::text, 'reservedQuantity', row.quantity
    ) ORDER BY row.id) FROM reservation_live_rows row), '[]'::jsonb)
      AS reservation_live,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'inventoryId', row.id::text, 'reservedQuantity', row.quantity
    ) ORDER BY row.id) FROM reservation_rebuilt_rows row), '[]'::jsonb)
      AS reservation_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM reservation_record_live_rows row), '[]'::jsonb)
      AS reservation_record_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM reservation_record_rebuilt_rows row), '[]'::jsonb)
      AS reservation_record_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM business_live_rows row), '[]'::jsonb) AS business_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM business_rebuilt_rows row), '[]'::jsonb) AS business_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM facility_live_rows row), '[]'::jsonb) AS facility_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM facility_rebuilt_rows row), '[]'::jsonb) AS facility_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM recipe_version_live_rows row), '[]'::jsonb) AS recipe_version_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM recipe_version_rebuilt_rows row), '[]'::jsonb) AS recipe_version_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM tax_policy_live_rows row), '[]'::jsonb) AS tax_policy_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM tax_policy_rebuilt_rows row), '[]'::jsonb) AS tax_policy_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM production_live_rows row), '[]'::jsonb) AS production_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM production_rebuilt_rows row), '[]'::jsonb) AS production_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM contract_live_rows row), '[]'::jsonb) AS contract_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM contract_rebuilt_rows row), '[]'::jsonb) AS contract_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM listing_live_rows row), '[]'::jsonb) AS listing_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM listing_rebuilt_rows row), '[]'::jsonb) AS listing_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM trade_live_rows row), '[]'::jsonb) AS trade_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM trade_rebuilt_rows row), '[]'::jsonb) AS trade_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM payroll_live_rows row), '[]'::jsonb) AS payroll_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id)
      FROM payroll_rebuilt_rows row), '[]'::jsonb) AS payroll_rebuilt,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM tax_live_rows row), '[]'::jsonb) AS tax_live,
    COALESCE((SELECT jsonb_agg(row.document ORDER BY row.id COLLATE "C")
      FROM tax_rebuilt_rows row), '[]'::jsonb) AS tax_rebuilt,
    (SELECT live_document FROM checkpoint_documents) AS checkpoint_live,
    (SELECT rebuilt_document FROM checkpoint_documents) AS checkpoint_rebuilt
)
SELECT jsonb_build_object(
  'businessLive', business_live,
  'businessRebuilt', business_rebuilt,
  'checkpointLive', checkpoint_live,
  'checkpointRebuilt', checkpoint_rebuilt,
  'contractLive', contract_live,
  'contractRebuilt', contract_rebuilt,
  'facilityLive', facility_live,
  'facilityRebuilt', facility_rebuilt,
  'inventoryLive', inventory_live,
  'inventoryRebuilt', inventory_rebuilt,
  'listingLive', listing_live,
  'listingRebuilt', listing_rebuilt,
  'payrollLive', payroll_live,
  'payrollRebuilt', payroll_rebuilt,
  'productionLive', production_live,
  'productionRebuilt', production_rebuilt,
  'recipeVersionLive', recipe_version_live,
  'recipeVersionRebuilt', recipe_version_rebuilt,
  'reservationLive', reservation_live,
  'reservationRebuilt', reservation_rebuilt,
  'reservationRecordLive', reservation_record_live,
  'reservationRecordRebuilt', reservation_record_rebuilt,
  'taxLive', tax_live,
  'taxRebuilt', tax_rebuilt,
  'taxPolicyLive', tax_policy_live,
  'taxPolicyRebuilt', tax_policy_rebuilt,
  'tradeLive', trade_live,
  'tradeRebuilt', trade_rebuilt
)
FROM documents
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_economy_reconciliation_documents_v2(uuid,uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_reconcile_economy_expansion_v2(
  checked_world_id uuid,
  evidence_command_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  result jsonb;
  result_item_count integer;
BEGIN
  WITH documents AS (
    SELECT public.worldgraph_economy_reconciliation_documents_v2(
      checked_world_id, evidence_command_id
    ) AS value
  ),
  hashes AS (
    SELECT
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'businessLive'
      ), 'UTF8'), 'sha256') AS business_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'businessRebuilt'
      ), 'UTF8'), 'sha256') AS business_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'checkpointLive'
      ), 'UTF8'), 'sha256') AS checkpoint_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'checkpointRebuilt'
      ), 'UTF8'), 'sha256') AS checkpoint_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'contractLive'
      ), 'UTF8'), 'sha256') AS contract_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'contractRebuilt'
      ), 'UTF8'), 'sha256') AS contract_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'facilityLive'
      ), 'UTF8'), 'sha256') AS facility_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'facilityRebuilt'
      ), 'UTF8'), 'sha256') AS facility_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'inventoryLive'
      ), 'UTF8'), 'sha256') AS inventory_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'inventoryRebuilt'
      ), 'UTF8'), 'sha256') AS inventory_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'listingLive'
      ), 'UTF8'), 'sha256') AS listing_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'listingRebuilt'
      ), 'UTF8'), 'sha256') AS listing_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'payrollLive'
      ), 'UTF8'), 'sha256') AS payroll_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'payrollRebuilt'
      ), 'UTF8'), 'sha256') AS payroll_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'productionLive'
      ), 'UTF8'), 'sha256') AS production_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'productionRebuilt'
      ), 'UTF8'), 'sha256') AS production_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'recipeVersionLive'
      ), 'UTF8'), 'sha256') AS recipe_version_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'recipeVersionRebuilt'
      ), 'UTF8'), 'sha256') AS recipe_version_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'reservationLive'
      ), 'UTF8'), 'sha256') AS reservation_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'reservationRebuilt'
      ), 'UTF8'), 'sha256') AS reservation_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'reservationRecordLive'
      ), 'UTF8'), 'sha256') AS reservation_record_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'reservationRecordRebuilt'
      ), 'UTF8'), 'sha256') AS reservation_record_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'taxLive'
      ), 'UTF8'), 'sha256') AS tax_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'taxRebuilt'
      ), 'UTF8'), 'sha256') AS tax_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'taxPolicyLive'
      ), 'UTF8'), 'sha256') AS tax_policy_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'taxPolicyRebuilt'
      ), 'UTF8'), 'sha256') AS tax_policy_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'tradeLive'
      ), 'UTF8'), 'sha256') AS trade_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        value -> 'tradeRebuilt'
      ), 'UTF8'), 'sha256') AS trade_rebuilt
    FROM documents
  ),
  inventory_live AS (
    SELECT row."inventoryId" AS item_key, row.quantity AS actual_value
    FROM documents,
      jsonb_to_recordset(documents.value -> 'inventoryLive')
        AS row("inventoryId" text, quantity text)
  ),
  inventory_rebuilt AS (
    SELECT row."inventoryId" AS item_key, row.quantity AS expected_value
    FROM documents,
      jsonb_to_recordset(documents.value -> 'inventoryRebuilt')
        AS row("inventoryId" text, quantity text)
  ),
  reservation_live AS (
    SELECT row."inventoryId" AS item_key,
           row."reservedQuantity" AS actual_value
    FROM documents,
      jsonb_to_recordset(documents.value -> 'reservationLive')
        AS row("inventoryId" text, "reservedQuantity" text)
  ),
  reservation_rebuilt AS (
    SELECT row."inventoryId" AS item_key,
           row."reservedQuantity" AS expected_value
    FROM documents,
      jsonb_to_recordset(documents.value -> 'reservationRebuilt')
        AS row("inventoryId" text, "reservedQuantity" text)
  ),
  item_candidates AS (
    SELECT 1 AS category_order, 'inventory_quantity'::text AS item_kind,
           COALESCE(expected.item_key, actual.item_key) AS item_key,
           expected.expected_value, actual.actual_value,
           'INVENTORY_QUANTITY_MISMATCH'::text AS mismatch_code
    FROM inventory_rebuilt expected
    FULL JOIN inventory_live actual USING (item_key)
    WHERE expected.expected_value IS DISTINCT FROM actual.actual_value
    UNION ALL
    SELECT 2, 'inventory_reservation',
           COALESCE(expected.item_key, actual.item_key),
           expected.expected_value, actual.actual_value,
           'INVENTORY_RESERVATION_MISMATCH'
    FROM reservation_rebuilt expected
    FULL JOIN reservation_live actual USING (item_key)
    WHERE expected.expected_value IS DISTINCT FROM actual.actual_value
    UNION ALL
    SELECT aggregate.category_order, aggregate.item_kind, aggregate.item_key,
           encode(aggregate.expected_hash, 'hex'),
           encode(aggregate.actual_hash, 'hex'), aggregate.mismatch_code
    FROM hashes,
      LATERAL (VALUES
        (3, 'reservation_lifecycle', 'inventory_reservations',
          hashes.reservation_record_rebuilt, hashes.reservation_record_live,
          'RESERVATION_LIFECYCLE_CHECKSUM_MISMATCH'),
        (8, 'recipe_version', 'production_recipe_versions',
          hashes.recipe_version_rebuilt, hashes.recipe_version_live,
          'RECIPE_VERSION_CHECKSUM_MISMATCH'),
        (9, 'tax_policy', 'tax_policies',
          hashes.tax_policy_rebuilt, hashes.tax_policy_live,
          'TAX_POLICY_CHECKSUM_MISMATCH'),
        (10, 'business', 'businesses',
          hashes.business_rebuilt, hashes.business_live,
          'BUSINESS_CHECKSUM_MISMATCH'),
        (11, 'facility', 'facilities',
          hashes.facility_rebuilt, hashes.facility_live,
          'FACILITY_CHECKSUM_MISMATCH'),
        (12, 'production', 'production_runs',
          hashes.production_rebuilt, hashes.production_live,
          'PRODUCTION_CHECKSUM_MISMATCH'),
        (13, 'employment_contract', 'employment_contracts',
          hashes.contract_rebuilt, hashes.contract_live,
          'EMPLOYMENT_CONTRACT_CHECKSUM_MISMATCH'),
        (14, 'market_listing', 'market_listings',
          hashes.listing_rebuilt, hashes.listing_live,
          'MARKET_LISTING_CHECKSUM_MISMATCH'),
        (15, 'market_trade', 'market_trades',
          hashes.trade_rebuilt, hashes.trade_live,
          'MARKET_TRADE_CHECKSUM_MISMATCH'),
        (16, 'payroll', 'payroll_records',
          hashes.payroll_rebuilt, hashes.payroll_live,
          'PAYROLL_CHECKSUM_MISMATCH'),
        (17, 'tax_assessment', 'tax_assessments',
          hashes.tax_rebuilt, hashes.tax_live,
          'TAX_ASSESSMENT_CHECKSUM_MISMATCH'),
        (18, 'projection_checkpoint', 'economy_closed_loop',
          hashes.checkpoint_rebuilt, hashes.checkpoint_live,
          'PROJECTION_CHECKPOINT_CHECKSUM_MISMATCH')
    ) aggregate(
      category_order, item_kind, item_key, expected_hash, actual_hash,
      mismatch_code
    )
    WHERE aggregate.expected_hash IS DISTINCT FROM aggregate.actual_hash
  ),
  candidate_count AS (
    SELECT least(count(*), 10001)::integer AS item_count
    FROM item_candidates
  ),
  ordered_items AS (
    SELECT (row_number() OVER (
             ORDER BY candidate.category_order, candidate.item_key COLLATE "C"
           ) - 1)::integer AS item_ordinal,
           candidate.item_kind, candidate.item_key,
           candidate.expected_value, candidate.actual_value,
           candidate.mismatch_code
    FROM item_candidates candidate, candidate_count
    WHERE candidate_count.item_count <= 10000
  ),
  item_document AS (
    SELECT candidate_count.item_count,
           COALESCE(jsonb_agg(jsonb_build_object(
             'actualValue', item.actual_value,
             'expectedValue', item.expected_value,
             'itemKey', item.item_key,
             'itemKind', item.item_kind,
             'itemOrdinal', item.item_ordinal,
             'mismatchCode', item.mismatch_code
           ) ORDER BY item.item_ordinal)
             FILTER (WHERE item.item_ordinal IS NOT NULL), '[]'::jsonb) AS items
    FROM candidate_count
    LEFT JOIN ordered_items item
      ON candidate_count.item_count <= 10000
    GROUP BY candidate_count.item_count
  ),
  projection_hashes AS (
    SELECT hashes.*,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        jsonb_build_object(
          'businessChecksum', encode(hashes.business_live, 'hex'),
          'checkpointChecksum', encode(hashes.checkpoint_live, 'hex'),
          'contractChecksum', encode(hashes.contract_live, 'hex'),
          'facilityChecksum', encode(hashes.facility_live, 'hex'),
          'inventoryChecksum', encode(hashes.inventory_live, 'hex'),
          'listingChecksum', encode(hashes.listing_live, 'hex'),
          'payrollChecksum', encode(hashes.payroll_live, 'hex'),
          'productionChecksum', encode(hashes.production_live, 'hex'),
          'recipeVersionChecksum', encode(hashes.recipe_version_live, 'hex'),
          'reservationChecksum', encode(hashes.reservation_live, 'hex'),
          'reservationRecordChecksum',
            encode(hashes.reservation_record_live, 'hex'),
          'taxChecksum', encode(hashes.tax_live, 'hex'),
          'taxPolicyChecksum', encode(hashes.tax_policy_live, 'hex'),
          'tradeChecksum', encode(hashes.trade_live, 'hex')
        )
      ), 'UTF8'), 'sha256') AS live_projection,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        jsonb_build_object(
          'businessChecksum', encode(hashes.business_rebuilt, 'hex'),
          'checkpointChecksum', encode(hashes.checkpoint_rebuilt, 'hex'),
          'contractChecksum', encode(hashes.contract_rebuilt, 'hex'),
          'facilityChecksum', encode(hashes.facility_rebuilt, 'hex'),
          'inventoryChecksum', encode(hashes.inventory_rebuilt, 'hex'),
          'listingChecksum', encode(hashes.listing_rebuilt, 'hex'),
          'payrollChecksum', encode(hashes.payroll_rebuilt, 'hex'),
          'productionChecksum', encode(hashes.production_rebuilt, 'hex'),
          'recipeVersionChecksum', encode(hashes.recipe_version_rebuilt, 'hex'),
          'reservationChecksum', encode(hashes.reservation_rebuilt, 'hex'),
          'reservationRecordChecksum',
            encode(hashes.reservation_record_rebuilt, 'hex'),
          'taxChecksum', encode(hashes.tax_rebuilt, 'hex'),
          'taxPolicyChecksum', encode(hashes.tax_policy_rebuilt, 'hex'),
          'tradeChecksum', encode(hashes.trade_rebuilt, 'hex')
        )
      ), 'UTF8'), 'sha256') AS rebuilt_projection
    FROM hashes
  )
  SELECT jsonb_build_object(
    'assessmentCount', (
      SELECT count(*) FROM public.tax_assessments
      WHERE world_id = checked_world_id
    ),
    'inventoryCount', (
      SELECT count(*) FROM public.inventories
      WHERE world_id = checked_world_id
    ),
    'itemCount', item_document.item_count,
    'items', item_document.items,
    'liveInventoryChecksum', encode(inventory_live, 'hex'),
    'livePayrollChecksum', encode(payroll_live, 'hex'),
    'liveProjectionChecksum', encode(live_projection, 'hex'),
    'liveReservationChecksum', encode(reservation_live, 'hex'),
    'liveTaxChecksum', encode(tax_live, 'hex'),
    'liveTradeChecksum', encode(trade_live, 'hex'),
    'matched', item_document.item_count = 0
      AND live_projection = rebuilt_projection,
    'mismatchCount', item_document.item_count,
    'projectionChecksum', encode(
      public.worldgraph_economy_expansion_projection_checksum(checked_world_id),
      'hex'
    ),
    'rebuiltInventoryChecksum', encode(inventory_rebuilt, 'hex'),
    'rebuiltJournalChecksum', encode(rebuilt_projection, 'hex'),
    'rebuiltPayrollChecksum', encode(payroll_rebuilt, 'hex'),
    'rebuiltReservationChecksum', encode(reservation_rebuilt, 'hex'),
    'rebuiltTaxChecksum', encode(tax_rebuilt, 'hex'),
    'rebuiltTradeChecksum', encode(trade_rebuilt, 'hex'),
    'resourceCount', (
      SELECT count(*) FROM public.resource_types
      WHERE world_id = checked_world_id
    ),
    'tradeCount', (
      SELECT count(*) FROM public.market_trades
      WHERE world_id = checked_world_id
    )
  ), item_document.item_count
    INTO result, result_item_count
  FROM projection_hashes, item_document;

  IF result_item_count > 10000 THEN
    RAISE EXCEPTION 'commerce reconciliation mismatch evidence exceeds the bounded limit'
      USING ERRCODE = '54000',
        CONSTRAINT = 'economy_expansion_reconciliation_items_bounded';
  END IF;
  RETURN result;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_reconcile_economy_expansion_v2(uuid,uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_reconcile_economy_expansion(
  checked_world_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  evidence_command_id uuid :=
    NULLIF(current_setting('worldgraph.command_id', true), '')::uuid;
BEGIN
  IF checked_world_id IS NULL OR evidence_command_id IS NULL
    OR NULLIF(current_setting('worldgraph.command_world_id', true), '')
      IS DISTINCT FROM checked_world_id::text
    OR NOT EXISTS (
      SELECT 1
      FROM public.command_records command
      JOIN public.economy_expansion_command_write_snapshots snapshot
        ON snapshot.command_id = command.id
       AND snapshot.world_id = command.world_id
      WHERE command.id = evidence_command_id
        AND command.world_id = checked_world_id
        AND command.command_type IN (
          'ReconcileWorldCommerceV1','RepairEconomicProjectionV1'
        )
        AND command.status IN (
          'received'::command_record_status,
          'accepted'::command_record_status
        )
        AND command.write_gate_opened_at >= transaction_timestamp()
    ) THEN
    RAISE EXCEPTION 'commerce reconciliation requires its current command write gate'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.worldgraph_reconcile_economy_expansion_v2(
    checked_world_id, evidence_command_id
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_reconcile_economy_expansion(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_economy_expansion_reconciliation_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  run_record record;
  command_record record;
  event_record record;
  head_record record;
  checkpoint_record record;
  snapshot jsonb;
  item_count integer;
  clock_tick bigint;
BEGIN
  SELECT run.* INTO run_record
  FROM public.economy_expansion_reconciliation_runs run
  WHERE run.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT command.* INTO command_record
  FROM public.command_records command
  WHERE command.id = run_record.command_id
    AND command.world_id = run_record.world_id;
  SELECT event.* INTO event_record
  FROM public.domain_events event
  WHERE event.id = run_record.event_id
    AND event.world_id = run_record.world_id;
  SELECT head.* INTO head_record
  FROM public.world_economy_expansion_heads head
  WHERE head.world_id = run_record.world_id;
  SELECT checkpoint.* INTO checkpoint_record
  FROM public.projection_checkpoints checkpoint
  WHERE checkpoint.world_id = run_record.world_id
    AND checkpoint.projection_name = 'economy_closed_loop';
  SELECT clock.current_tick INTO clock_tick
  FROM public.world_simulation_clocks clock
  WHERE clock.world_id = run_record.world_id;
  snapshot := public.worldgraph_reconcile_economy_expansion_v2(
    run_record.world_id, run_record.command_id
  );
  SELECT count(*)::integer INTO item_count
  FROM public.economy_expansion_reconciliation_items item
  WHERE item.run_id = run_record.id;

  IF command_record.id IS NULL OR event_record.id IS NULL
    OR head_record.world_id IS NULL OR checkpoint_record.world_id IS NULL
    OR clock_tick IS NULL
    OR run_record.reconciliation_schema_version <> 2
    OR command_record.status <> 'accepted'::command_record_status
    OR command_record.command_type NOT IN (
      'ReconcileWorldCommerceV1','RepairEconomicProjectionV1'
    )
    OR (
      command_record.command_type = 'ReconcileWorldCommerceV1'
      AND (
        run_record.source_state_revision
          IS DISTINCT FROM command_record.opened_state_revision
        OR run_record.source_event_sequence
          IS DISTINCT FROM command_record.opened_event_sequence
        OR event_record.event_type <> 'WorldCommerceReconciledV1'
        OR event_record.event_schema_version <> 1
        OR event_record.event_ordinal <> 0
        OR event_record.world_event_sequence <>
          run_record.source_event_sequence + 1
        OR event_record.world_event_sequence IS DISTINCT FROM (
          SELECT runtime.last_event_sequence
          FROM public.world_runtime_heads runtime
          WHERE runtime.world_id = run_record.world_id
        )
        OR event_record.aggregate_type <> 'world_commerce'
        OR event_record.aggregate_id <> run_record.world_id::text
        OR event_record.aggregate_version IS DISTINCT FROM (
          SELECT stream.current_version
          FROM public.aggregate_stream_heads stream
          WHERE stream.world_id = run_record.world_id
            AND stream.aggregate_type = 'world_commerce'
            AND stream.aggregate_id = run_record.world_id::text
        )
        OR event_record.occurred_at IS DISTINCT FROM command_record.decided_at
        OR event_record.recorded_at IS DISTINCT FROM command_record.decided_at
        OR event_record.payload IS DISTINCT FROM jsonb_build_object(
          'aggregateVersion', head_record.row_version::text,
          'checksum', snapshot ->> 'projectionChecksum',
          'mismatchCount', run_record.mismatch_count,
          'reconciliationRunId', run_record.id::text,
          'status', run_record.status::text,
          'tick', clock_tick::text
        )
      )
    )
    OR (
      command_record.command_type = 'RepairEconomicProjectionV1'
      AND (
        run_record.source_state_revision
          IS DISTINCT FROM command_record.resulting_state_revision
        OR run_record.source_event_sequence
          IS DISTINCT FROM event_record.world_event_sequence
        OR event_record.event_type <> 'WorldCommerceProjectionRepairedV1'
      )
    )
    OR event_record.command_id IS DISTINCT FROM run_record.command_id
    OR event_record.resulting_state_revision
      IS DISTINCT FROM command_record.resulting_state_revision
    OR run_record.live_inventory_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveInventoryChecksum', 'hex')
    OR run_record.rebuilt_inventory_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltInventoryChecksum', 'hex')
    OR run_record.live_reservation_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveReservationChecksum', 'hex')
    OR run_record.rebuilt_reservation_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltReservationChecksum', 'hex')
    OR run_record.live_trade_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveTradeChecksum', 'hex')
    OR run_record.rebuilt_trade_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltTradeChecksum', 'hex')
    OR run_record.live_payroll_checksum IS DISTINCT FROM
      decode(snapshot ->> 'livePayrollChecksum', 'hex')
    OR run_record.rebuilt_payroll_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltPayrollChecksum', 'hex')
    OR run_record.live_tax_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveTaxChecksum', 'hex')
    OR run_record.rebuilt_tax_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltTaxChecksum', 'hex')
    OR run_record.live_projection_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveProjectionChecksum', 'hex')
    OR run_record.rebuilt_journal_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltJournalChecksum', 'hex')
    OR run_record.resource_count IS DISTINCT FROM
      (snapshot ->> 'resourceCount')::integer
    OR run_record.inventory_count IS DISTINCT FROM
      (snapshot ->> 'inventoryCount')::integer
    OR run_record.trade_count IS DISTINCT FROM
      (snapshot ->> 'tradeCount')::integer
    OR run_record.assessment_count IS DISTINCT FROM
      (snapshot ->> 'assessmentCount')::integer
    OR run_record.mismatch_count IS DISTINCT FROM
      (snapshot ->> 'mismatchCount')::integer
    OR run_record.mismatch_count IS DISTINCT FROM item_count
    OR item_count IS DISTINCT FROM (snapshot ->> 'itemCount')::integer
    OR run_record.status IS DISTINCT FROM (CASE
      WHEN (snapshot ->> 'matched')::boolean
        THEN 'matched'::economy_reconciliation_run_status
      ELSE 'mismatch'::economy_reconciliation_run_status
    END)
    OR EXISTS (
      WITH expected_items AS (
        SELECT expected."itemOrdinal" AS item_ordinal,
               expected."itemKind" AS item_kind,
               expected."itemKey" AS item_key,
               expected."expectedValue" AS expected_value,
               expected."actualValue" AS actual_value,
               expected."mismatchCode" AS mismatch_code
        FROM jsonb_to_recordset(snapshot -> 'items') AS expected(
          "actualValue" text,
          "expectedValue" text,
          "itemKey" text,
          "itemKind" text,
          "itemOrdinal" integer,
          "mismatchCode" text
        )
      ),
      actual_items AS (
        SELECT item.item_ordinal, item.item_kind, item.item_key,
               item.expected_value, item.actual_value, item.mismatch_code
        FROM public.economy_expansion_reconciliation_items item
        WHERE item.run_id = run_record.id
      )
      SELECT 1
      FROM expected_items expected
      FULL JOIN actual_items actual USING (item_ordinal)
      WHERE expected.item_ordinal IS NULL OR actual.item_ordinal IS NULL
        OR actual.item_kind IS DISTINCT FROM expected.item_kind
        OR actual.item_key IS DISTINCT FROM expected.item_key
        OR actual.expected_value IS DISTINCT FROM expected.expected_value
        OR actual.actual_value IS DISTINCT FROM expected.actual_value
        OR actual.mismatch_code IS DISTINCT FROM expected.mismatch_code
    )
    OR head_record.last_reconciliation_run_id IS DISTINCT FROM run_record.id
    OR head_record.last_reconciled_state_revision
      IS DISTINCT FROM run_record.source_state_revision
    OR head_record.reconciliation_status IS DISTINCT FROM (CASE run_record.status
      WHEN 'matched'::economy_reconciliation_run_status
        THEN 'current'::economy_reconciliation_status
      ELSE 'mismatch'::economy_reconciliation_status
    END)
    OR head_record.checksum IS DISTINCT FROM
      public.worldgraph_economy_expansion_projection_checksum(run_record.world_id)
    OR checkpoint_record.projection_schema_version <> 1
    OR checkpoint_record.status <> 'current'::projection_checkpoint_status
    OR checkpoint_record.checksum IS DISTINCT FROM head_record.checksum
    OR checkpoint_record.last_event_sequence IS DISTINCT FROM (
      SELECT runtime.last_event_sequence
      FROM public.world_runtime_heads runtime
      WHERE runtime.world_id = run_record.world_id
    )
    OR (
      command_record.command_type = 'ReconcileWorldCommerceV1'
      AND (
        event_record.payload ->> 'reconciliationRunId'
          IS DISTINCT FROM run_record.id::text
        OR (event_record.payload ->> 'mismatchCount')::integer
          IS DISTINCT FROM run_record.mismatch_count
        OR event_record.payload ->> 'checksum'
          IS DISTINCT FROM snapshot ->> 'projectionChecksum'
        OR event_record.payload ->> 'status'
          IS DISTINCT FROM run_record.status::text
      )
    ) THEN
    RAISE EXCEPTION 'commerce reconciliation run lacks exact canonical evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'economy_expansion_reconciliation_evidence_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER
  economy_expansion_reconciliation_runs_require_exact_evidence
  AFTER INSERT ON public.economy_expansion_reconciliation_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION
    public.worldgraph_assert_economy_expansion_reconciliation_run();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_assert_economy_expansion_reconciliation_run()
  FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.outbox_messages
  ADD CONSTRAINT outbox_messages_world_identity UNIQUE (world_id, id);
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_outbox_retry_reason_is_valid(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT public.worldgraph_commerce_projection_repair_reason_is_valid(value)
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_outbox_retry_reason_is_valid(text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE public.outbox_retry_intents (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id) ON DELETE RESTRICT,
  outbox_message_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  audit_id uuid NOT NULL,
  reason text NOT NULL,
  previous_attempts integer NOT NULL,
  execution_gate_hash bytea NOT NULL,
  requeued_at timestamptz NOT NULL,
  CONSTRAINT outbox_retry_intents_message_world_fk
    FOREIGN KEY (world_id, outbox_message_id)
    REFERENCES public.outbox_messages(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_retry_intents_audit_fk
    FOREIGN KEY (audit_id, world_id, actor_user_id)
    REFERENCES public.security_audit_records(id, world_id, actor_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT outbox_retry_intents_reason_valid CHECK (
    public.worldgraph_outbox_retry_reason_is_valid(reason)
  ),
  CONSTRAINT outbox_retry_intents_attempts_positive CHECK (previous_attempts > 0),
  CONSTRAINT outbox_retry_intents_gate_hash_length CHECK (
    octet_length(execution_gate_hash) = 32
  ),
  CONSTRAINT outbox_retry_intents_timestamp_canonical CHECK (
    requeued_at = date_trunc('milliseconds', requeued_at)
  )
);
--> statement-breakpoint
CREATE INDEX outbox_retry_intents_world_cursor_idx
  ON public.outbox_retry_intents (world_id, requeued_at DESC, id DESC);
--> statement-breakpoint
CREATE TRIGGER outbox_retry_intents_append_only
  BEFORE UPDATE OR DELETE ON public.outbox_retry_intents
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_reject_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_protect_outbox_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  retry_gate text := NULLIF(
    current_setting('worldgraph.outbox_retry_execution_gate', true), ''
  );
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox messages cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'dead'::outbox_message_status
    AND NEW.status = 'pending'::outbox_message_status
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.world_id IS NOT DISTINCT FROM OLD.world_id
    AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
    AND NEW.message_type IS NOT DISTINCT FROM OLD.message_type
    AND NEW.message_schema_version IS NOT DISTINCT FROM OLD.message_schema_version
    AND NEW.payload IS NOT DISTINCT FROM OLD.payload
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NEW.attempts IS NOT DISTINCT FROM OLD.attempts
    AND NEW.locked_at IS NULL
    AND NEW.locked_by IS NULL
    AND NEW.published_at IS NULL
    AND retry_gate IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.outbox_retry_intents intent
      WHERE intent.outbox_message_id = OLD.id
        AND intent.world_id = OLD.world_id
        AND intent.previous_attempts = OLD.attempts
        AND intent.requeued_at = NEW.available_at
        AND intent.execution_gate_hash =
          extensions.digest(convert_to(retry_gate, 'UTF8'), 'sha256')
    ) THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.message_type IS DISTINCT FROM OLD.message_type
    OR NEW.message_schema_version IS DISTINCT FROM OLD.message_schema_version
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.attempts < OLD.attempts
    OR OLD.status IN ('published'::outbox_message_status, 'dead'::outbox_message_status) THEN
    RAISE EXCEPTION 'outbox transition changes immutable fields or terminal status'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_outbox_message()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_retry_dead_outbox_message(
  checked_world_id uuid,
  checked_outbox_message_id uuid,
  checked_retry_intent_id uuid,
  checked_actor_user_id uuid,
  checked_reason text,
  checked_confirmation text
)
RETURNS TABLE (
  world_id uuid,
  outbox_message_id uuid,
  retry_intent_id uuid,
  previous_attempts integer,
  requeued_at timestamptz,
  current_status outbox_message_status,
  current_attempts integer,
  idempotent_replay boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  existing_intent record;
  message_record record;
  requeue_time timestamptz := date_trunc('milliseconds', clock_timestamp());
  execution_gate text := extensions.gen_random_uuid()::text;
  changed integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'outbox retry requires the database owner session'
      USING ERRCODE = '42501';
  END IF;
  IF checked_world_id IS NULL OR checked_outbox_message_id IS NULL
    OR checked_retry_intent_id IS NULL OR checked_actor_user_id IS NULL
    OR checked_confirmation IS DISTINCT FROM 'RETRY DEAD OUTBOX MESSAGE'
    OR checked_reason IS NULL
    OR NOT public.worldgraph_outbox_retry_reason_is_valid(checked_reason) THEN
    RAISE EXCEPTION 'outbox retry inputs or confirmation are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF checked_retry_intent_id IN (
    checked_world_id, checked_outbox_message_id, checked_actor_user_id
  ) OR checked_world_id IN (checked_outbox_message_id, checked_actor_user_id)
    OR checked_outbox_message_id = checked_actor_user_id THEN
    RAISE EXCEPTION 'outbox retry identities must be distinct'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.users operator
    WHERE operator.id = checked_actor_user_id
      AND operator.status = 'active'::user_status
      AND operator.platform_role = 'platform_admin'::platform_role
  ) THEN
    RAISE EXCEPTION 'outbox retry actor must be an active platform administrator'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'worldgraph-command-v1:' || checked_world_id::text, 0
    )
  );
  SELECT intent.*, message.status AS current_status,
         message.attempts AS current_attempts
  INTO existing_intent
  FROM public.outbox_retry_intents intent
  JOIN public.outbox_messages message
    ON message.id = intent.outbox_message_id
   AND message.world_id = intent.world_id
  WHERE intent.id = checked_retry_intent_id;
  IF FOUND THEN
    IF existing_intent.world_id IS DISTINCT FROM checked_world_id
      OR existing_intent.outbox_message_id IS DISTINCT FROM checked_outbox_message_id
      OR existing_intent.actor_user_id IS DISTINCT FROM checked_actor_user_id
      OR existing_intent.audit_id IS DISTINCT FROM checked_retry_intent_id
      OR existing_intent.reason IS DISTINCT FROM checked_reason THEN
      RAISE EXCEPTION 'outbox retry identity was reused with different inputs'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT checked_world_id, checked_outbox_message_id,
      checked_retry_intent_id, existing_intent.previous_attempts::integer,
      existing_intent.requeued_at::timestamptz,
      existing_intent.current_status::outbox_message_status,
      existing_intent.current_attempts::integer, true;
    RETURN;
  END IF;

  SELECT message.* INTO message_record
  FROM public.outbox_messages message
  WHERE message.id = checked_outbox_message_id
    AND message.world_id = checked_world_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbox message does not exist in the requested world'
      USING ERRCODE = '22023';
  END IF;
  IF message_record.status <> 'dead'::outbox_message_status
    OR message_record.attempts < 1 OR message_record.locked_at IS NOT NULL
    OR message_record.locked_by IS NOT NULL OR message_record.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'only an unlocked dead outbox message can be retried'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.security_audit_records(
    id, actor_user_id, world_id, category, action, outcome, reason_code,
    target_type, target_id, request_id, correlation_id, redacted_metadata
  ) VALUES (
    checked_retry_intent_id, checked_actor_user_id, checked_world_id,
    'command_ledger', 'outbox.retry.authorized', 'succeeded',
    'OPERATOR_OUTBOX_RETRY', 'outbox_message', checked_outbox_message_id,
    checked_retry_intent_id::text, checked_retry_intent_id::text,
    jsonb_build_object(
      'databaseRole', session_user::text,
      'previousAttempts', message_record.attempts,
      'retryIntentId', checked_retry_intent_id::text
    )
  );
  INSERT INTO public.outbox_retry_intents(
    id, world_id, outbox_message_id, actor_user_id, audit_id, reason,
    previous_attempts, execution_gate_hash, requeued_at
  ) VALUES (
    checked_retry_intent_id, checked_world_id, checked_outbox_message_id,
    checked_actor_user_id, checked_retry_intent_id, checked_reason,
    message_record.attempts,
    extensions.digest(convert_to(execution_gate, 'UTF8'), 'sha256'), requeue_time
  );
  PERFORM set_config('worldgraph.outbox_retry_execution_gate', execution_gate, true);
  UPDATE public.outbox_messages message
  SET status = 'pending'::outbox_message_status,
      available_at = requeue_time,
      locked_at = NULL,
      locked_by = NULL,
      published_at = NULL
  WHERE message.id = checked_outbox_message_id
    AND message.world_id = checked_world_id
    AND message.status = 'dead'::outbox_message_status
    AND message.attempts = message_record.attempts;
  GET DIAGNOSTICS changed = ROW_COUNT;
  PERFORM set_config('worldgraph.outbox_retry_execution_gate', '', true);
  IF changed <> 1 THEN
    RAISE EXCEPTION 'outbox retry lost its exact terminal message'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT checked_world_id, checked_outbox_message_id,
    checked_retry_intent_id, message_record.attempts::integer, requeue_time,
    'pending'::outbox_message_status, message_record.attempts::integer, false;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_retry_dead_outbox_message(
  uuid,uuid,uuid,uuid,text,text
) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.world_economy_expansion_heads
  DISABLE TRIGGER world_economy_expansion_heads_protect;
--> statement-breakpoint
UPDATE public.world_economy_expansion_heads
SET reconciliation_status = 'pending'::economy_reconciliation_status,
    last_reconciled_state_revision = NULL,
    last_reconciliation_run_id = NULL
WHERE reconciliation_status = 'current'::economy_reconciliation_status;
--> statement-breakpoint
ALTER TABLE public.world_economy_expansion_heads
  ENABLE TRIGGER world_economy_expansion_heads_protect;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    REVOKE ALL ON public.commerce_command_payload_facts FROM worldgraph_app;
    REVOKE ALL ON public.payroll_policy_selection_facts FROM worldgraph_app;
    REVOKE ALL ON public.outbox_retry_intents FROM worldgraph_app;
    REVOKE ALL ON FUNCTION public.worldgraph_protect_outbox_message()
      FROM worldgraph_app;
    GRANT INSERT ON public.payroll_policy_selection_facts TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION
      public.worldgraph_record_commerce_command_payload_fact(uuid,uuid,jsonb)
      TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION
      public.worldgraph_reconcile_economy_expansion(uuid)
      TO worldgraph_app;
  END IF;
END
$grant$;
