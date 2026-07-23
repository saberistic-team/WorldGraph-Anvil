SET CONSTRAINTS ALL DEFERRED;
--> statement-breakpoint
ALTER TYPE history_visibility ADD VALUE IF NOT EXISTS 'participant';
--> statement-breakpoint
CREATE TYPE economy_seed_plan_source AS ENUM ('compiler_1_1', 'legacy_1_0_adapter');
--> statement-breakpoint
CREATE TYPE currency_status AS ENUM ('active', 'frozen', 'retired');
--> statement-breakpoint
CREATE TYPE wallet_kind AS ENUM ('player', 'organization', 'treasury');
--> statement-breakpoint
CREATE TYPE wallet_status AS ENUM ('active', 'frozen', 'closed');
--> statement-breakpoint
CREATE TYPE financial_transaction_kind AS ENUM (
  'initialization', 'issuance', 'transfer', 'asset_purchase', 'compensation'
);
--> statement-breakpoint
CREATE TYPE asset_status AS ENUM ('active', 'retired');
--> statement-breakpoint
CREATE TYPE asset_transfer_kind AS ENUM ('initial', 'grant', 'purchase', 'compensation');
--> statement-breakpoint
CREATE TYPE asset_transfer_offer_status AS ENUM ('open', 'accepted', 'cancelled', 'expired');
--> statement-breakpoint
CREATE TYPE economy_reconciliation_status AS ENUM ('pending', 'current', 'mismatch', 'failed');
--> statement-breakpoint
CREATE TYPE economy_reconciliation_run_status AS ENUM ('matched', 'mismatch');
--> statement-breakpoint
CREATE TYPE economy_participant_visibility AS ENUM ('participant', 'operator');
--> statement-breakpoint
CREATE TYPE economy_repair_kind AS ENUM (
  'reverse_financial_transaction', 'reverse_asset_transfer', 'reverse_asset_purchase'
);
--> statement-breakpoint
CREATE TYPE economy_repair_reason_code AS ENUM (
  'DUPLICATE_EFFECT', 'ERRONEOUS_EFFECT', 'INCIDENT_RECOVERY'
);
--> statement-breakpoint
CREATE TYPE economy_repair_approval_authority AS ENUM ('creator', 'platform_admin');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_command_write_is_open(
  checked_world_id uuid,
  checked_command_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE(
  NULLIF(current_setting('worldgraph.command_world_id', true), '') = checked_world_id::text
  AND (checked_command_id IS NULL
    OR NULLIF(current_setting('worldgraph.command_id', true), '') = checked_command_id::text)
  AND EXISTS (
    SELECT 1 FROM public.command_records command
    WHERE command.id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
      AND command.world_id = checked_world_id
      AND command.status = 'received'::command_record_status
      AND command.write_gate_opened_at >= transaction_timestamp()
      AND command.opened_state_revision IS NOT NULL
      AND command.opened_ledger_sequence IS NOT NULL
      AND command.opened_event_sequence IS NOT NULL
  ),
  false
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_command_write_is_open(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE world_compilation_runs
  DROP CONSTRAINT world_compilation_runs_compiler_known,
  ADD CONSTRAINT world_compilation_runs_compiler_known CHECK (
    compiler_config_version = 1 AND compiler_version IN ('1.0.0', '1.1.0')
  );
--> statement-breakpoint
ALTER TABLE world_versions
  DROP CONSTRAINT world_versions_compiler_known,
  ADD CONSTRAINT world_versions_compiler_known CHECK (
    compiler_config_version = 1 AND compiler_version IN ('1.0.0', '1.1.0')
  );
--> statement-breakpoint
ALTER TABLE compiled_world_artifacts
  DROP CONSTRAINT compiled_world_artifacts_schema_known,
  ADD CONSTRAINT compiled_world_artifacts_schema_known CHECK (
    (artifact_kind = 'compiled_world' AND artifact_schema_version IN (1, 2))
    OR (artifact_kind IN ('compiler_input', 'visual_plan') AND artifact_schema_version = 1)
  );
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_compiler_artifact_version_pair()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_record record;
BEGIN
  SELECT compiler_version, compiler_config_version
    INTO run_record
    FROM public.world_compilation_runs
   WHERE id = NEW.compilation_run_id AND world_id = NEW.world_id;
  IF NOT FOUND OR run_record.compiler_config_version <> 1 THEN
    RAISE EXCEPTION 'compiled artifact requires a known compiler run'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.artifact_kind = 'compiled_world' AND ((
    (run_record.compiler_version = '1.0.0' AND NEW.artifact_schema_version = 1
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '1'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.0.0'
      AND NEW.canonical_content ->> 'compilerConfigVersion' = '1'
      AND NOT NEW.canonical_content ? 'economySeedPlan')
    OR
    (run_record.compiler_version = '1.1.0' AND NEW.artifact_schema_version = 2
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '2'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.1.0'
      AND NEW.canonical_content ->> 'compilerConfigVersion' = '1'
      AND jsonb_typeof(NEW.canonical_content -> 'economySeedPlan') = 'object'
      AND NEW.canonical_content ->> 'economySeedPlanHash' ~ '^[a-f0-9]{64}$'
      AND decode(NEW.canonical_content ->> 'economySeedPlanHash', 'hex') =
        extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
          'domain', 'worldgraph.economy-seed-plan.v1',
          'plan', NEW.canonical_content -> 'economySeedPlan'
        )), 'UTF8'), 'sha256'))
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'compiled artifact schema does not match its compiler version'
      USING ERRCODE = '23514',
            CONSTRAINT = 'compiled_world_artifacts_compiler_schema_pair';
  ELSIF NEW.artifact_kind <> 'compiled_world' AND NEW.artifact_schema_version <> 1 THEN
    RAISE EXCEPTION 'supporting compiler artifacts remain schema version one'
      USING ERRCODE = '23514',
            CONSTRAINT = 'compiled_world_artifacts_compiler_schema_pair';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER compiled_world_artifacts_require_version_pair
  BEFORE INSERT ON compiled_world_artifacts
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_compiler_artifact_version_pair();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_compiler_artifact_version_pair() FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE compiled_economy_seed_plans (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  world_version_id uuid NOT NULL,
  compilation_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL REFERENCES compiled_world_artifacts(id) ON DELETE RESTRICT,
  seed_plan_schema_version integer NOT NULL,
  source_kind economy_seed_plan_source NOT NULL,
  source_compiler_version text NOT NULL,
  source_adapter_id text NOT NULL,
  source_adapter_version text NOT NULL,
  canonical_plan jsonb NOT NULL,
  plan_hash bytea NOT NULL,
  source_artifact_hash bytea NOT NULL,
  adopted_command_id uuid,
  adopted_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compiled_economy_seed_plans_world_version_unique UNIQUE (world_version_id),
  CONSTRAINT compiled_economy_seed_plans_world_identity UNIQUE (world_id, id),
  CONSTRAINT compiled_economy_seed_plans_world_version_hash_unique
    UNIQUE (world_id, world_version_id, plan_hash),
  CONSTRAINT compiled_economy_seed_plans_version_world_fk
    FOREIGN KEY (world_version_id, world_id)
    REFERENCES world_versions(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT compiled_economy_seed_plans_run_world_fk
    FOREIGN KEY (compilation_run_id, world_id)
    REFERENCES world_compilation_runs(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT compiled_economy_seed_plans_adoption_command_world_fk
    FOREIGN KEY (adopted_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT compiled_economy_seed_plans_adoption_event_world_fk
    FOREIGN KEY (world_id, adopted_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT compiled_economy_seed_plans_schema_known CHECK (seed_plan_schema_version = 1),
  CONSTRAINT compiled_economy_seed_plans_hash_lengths CHECK (
    octet_length(plan_hash) = 32 AND octet_length(source_artifact_hash) = 32
  ),
  CONSTRAINT compiled_economy_seed_plans_content_safe CHECK (
    jsonb_typeof(canonical_plan) = 'object'
    AND pg_column_size(canonical_plan) <= 262144
    AND canonical_plan ->> 'economySeedPlanSchemaVersion' = '1'
    AND NOT worldgraph_jsonb_has_sensitive_key(canonical_plan)
    AND NOT worldgraph_jsonb_has_compiler_private_key(canonical_plan)
  ),
  CONSTRAINT compiled_economy_seed_plans_plan_hash_valid CHECK (
    plan_hash = extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
      'domain', 'worldgraph.economy-seed-plan.v1', 'plan', canonical_plan
    )), 'UTF8'), 'sha256')
  ),
  CONSTRAINT compiled_economy_seed_plans_source_shape CHECK (
    (source_kind = 'compiler_1_1'
      AND source_compiler_version = '1.1.0'
      AND source_adapter_id = 'CompiledEconomySeedAdapterV1'
      AND source_adapter_version = '1.0.0'
      AND adopted_command_id IS NULL AND adopted_event_id IS NULL)
    OR
    (source_kind = 'legacy_1_0_adapter'
      AND source_compiler_version = '1.0.0'
      AND source_adapter_id = 'LegacyEconomySeedAdapterV1'
      AND source_adapter_version = '1.0.0'
      AND adopted_command_id IS NOT NULL AND adopted_event_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX compiled_economy_seed_plans_world_source_idx
  ON compiled_economy_seed_plans (world_id, source_kind, created_at, id);
--> statement-breakpoint
CREATE TABLE currencies (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  code extensions.citext NOT NULL,
  name text NOT NULL,
  minor_unit_scale smallint NOT NULL,
  max_supply_minor bigint,
  issuer_entity_id uuid,
  currency_schema_version integer NOT NULL DEFAULT 1,
  status currency_status NOT NULL DEFAULT 'active',
  row_version bigint NOT NULL DEFAULT 1,
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT currencies_world_identity UNIQUE (world_id, id),
  CONSTRAINT currencies_world_stable_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT currencies_world_code_unique UNIQUE (world_id, code),
  CONSTRAINT currencies_issuer_world_fk
    FOREIGN KEY (world_id, issuer_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT currencies_created_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT currencies_schema_known CHECK (currency_schema_version = 1),
  CONSTRAINT currencies_scale_bounded CHECK (minor_unit_scale BETWEEN 0 AND 6),
  CONSTRAINT currencies_supply_cap_nonnegative CHECK (
    max_supply_minor IS NULL OR max_supply_minor >= 0
  ),
  CONSTRAINT currencies_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT currencies_code_shape CHECK (
    code::text = upper(code::text) AND code::text ~ '^[A-Z][A-Z0-9]{2,11}$'
  ),
  CONSTRAINT currencies_name_bounded CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 100 AND name = btrim(name)
      AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT currencies_versions_positive CHECK (row_version > 0),
  CONSTRAINT currencies_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE TABLE currency_supply (
  currency_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  current_supply_minor bigint NOT NULL DEFAULT 0,
  row_version bigint NOT NULL DEFAULT 1,
  updated_state_revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT currency_supply_world_identity UNIQUE (world_id, currency_id),
  CONSTRAINT currency_supply_currency_world_fk
    FOREIGN KEY (world_id, currency_id)
    REFERENCES currencies(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT currency_supply_nonnegative CHECK (current_supply_minor >= 0),
  CONSTRAINT currency_supply_versions_positive CHECK (
    row_version > 0 AND updated_state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  currency_id uuid NOT NULL,
  stable_key extensions.citext NOT NULL,
  owner_entity_id uuid NOT NULL,
  wallet_kind wallet_kind NOT NULL,
  status wallet_status NOT NULL DEFAULT 'active',
  wallet_schema_version integer NOT NULL DEFAULT 1,
  row_version bigint NOT NULL DEFAULT 1,
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT wallets_world_identity UNIQUE (world_id, id),
  CONSTRAINT wallets_world_currency_identity UNIQUE (world_id, currency_id, id),
  CONSTRAINT wallets_world_stable_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT wallets_world_currency_owner_unique UNIQUE (world_id, currency_id, owner_entity_id),
  CONSTRAINT wallets_currency_world_fk
    FOREIGN KEY (world_id, currency_id)
    REFERENCES currencies(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT wallets_owner_world_fk
    FOREIGN KEY (world_id, owner_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT wallets_created_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT wallets_schema_known CHECK (wallet_schema_version = 1),
  CONSTRAINT wallets_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT wallets_versions_positive CHECK (row_version > 0),
  CONSTRAINT wallets_status_shape CHECK (
    (status IN ('active','frozen') AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL)
  ),
  CONSTRAINT wallets_timestamps_ordered CHECK (
    updated_at >= created_at AND (closed_at IS NULL OR closed_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX wallets_world_owner_status_idx
  ON wallets (world_id, owner_entity_id, status, currency_id, id);
--> statement-breakpoint
CREATE TABLE wallet_balances (
  wallet_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  available_minor bigint NOT NULL DEFAULT 0,
  row_version bigint NOT NULL DEFAULT 1,
  updated_state_revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_balances_world_currency_identity UNIQUE (world_id, currency_id, wallet_id),
  CONSTRAINT wallet_balances_wallet_world_currency_fk
    FOREIGN KEY (world_id, currency_id, wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT wallet_balances_nonnegative CHECK (available_minor >= 0),
  CONSTRAINT wallet_balances_versions_positive CHECK (
    row_version > 0 AND updated_state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE financial_transactions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  currency_id uuid NOT NULL,
  transaction_kind financial_transaction_kind NOT NULL,
  supply_delta_minor bigint NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  memo_code text NOT NULL,
  memo_text text,
  reversal_of_transaction_id uuid,
  occurred_tick bigint NOT NULL,
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_transactions_world_identity UNIQUE (world_id, id),
  CONSTRAINT financial_transactions_world_currency_identity UNIQUE (world_id, currency_id, id),
  CONSTRAINT financial_transactions_currency_world_fk
    FOREIGN KEY (world_id, currency_id)
    REFERENCES currencies(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT financial_transactions_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT financial_transactions_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT financial_transactions_reversal_world_currency_fk
    FOREIGN KEY (world_id, currency_id, reversal_of_transaction_id)
    REFERENCES financial_transactions(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT financial_transactions_tick_revision_valid CHECK (
    occurred_tick >= 0 AND state_revision > 0
  ),
  CONSTRAINT financial_transactions_memo_code_shape CHECK (
    char_length(memo_code) BETWEEN 1 AND 80 AND memo_code ~ '^[a-z][a-z0-9._-]*$'
  ),
  CONSTRAINT financial_transactions_memo_text_safe CHECK (
    memo_text IS NULL OR (
      char_length(memo_text) BETWEEN 1 AND 280
      AND memo_text = btrim(memo_text)
      AND translate(memo_text, E'\t\n\r', '') !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT financial_transactions_reversal_not_self CHECK (
    reversal_of_transaction_id IS NULL OR reversal_of_transaction_id <> id
  )
);
--> statement-breakpoint
CREATE INDEX financial_transactions_wallet_cursor_idx
  ON financial_transactions (world_id, currency_id, occurred_tick DESC, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE wallet_postings (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL,
  world_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  posting_ordinal integer NOT NULL,
  signed_amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_postings_transaction_ordinal_unique UNIQUE (transaction_id, posting_ordinal),
  CONSTRAINT wallet_postings_transaction_world_currency_fk
    FOREIGN KEY (world_id, currency_id, transaction_id)
    REFERENCES financial_transactions(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT wallet_postings_wallet_world_currency_fk
    FOREIGN KEY (world_id, currency_id, wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT wallet_postings_ordinal_valid CHECK (posting_ordinal BETWEEN 0 AND 100),
  CONSTRAINT wallet_postings_amount_nonzero CHECK (signed_amount_minor <> 0)
);
--> statement-breakpoint
CREATE INDEX wallet_postings_wallet_cursor_idx
  ON wallet_postings (world_id, wallet_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE assets (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  asset_type text NOT NULL,
  world_entity_id uuid,
  asset_schema_version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  transferable boolean NOT NULL,
  status asset_status NOT NULL DEFAULT 'active',
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT assets_world_identity UNIQUE (world_id, id),
  CONSTRAINT assets_world_stable_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT assets_world_entity_unique UNIQUE (world_id, world_entity_id),
  CONSTRAINT assets_entity_world_fk
    FOREIGN KEY (world_id, world_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT assets_created_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT assets_schema_known CHECK (asset_schema_version = 1),
  CONSTRAINT assets_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT assets_type_shape CHECK (
    char_length(asset_type) BETWEEN 1 AND 80 AND asset_type ~ '^[a-z][a-z0-9_]*$'
  ),
  CONSTRAINT assets_metadata_safe CHECK (
    jsonb_typeof(metadata) = 'object'
    AND worldgraph_jsonb_has_exact_keys(metadata, ARRAY['displayName','provenance'])
    AND char_length(metadata ->> 'displayName') BETWEEN 1 AND 100
    AND metadata ->> 'displayName' = btrim(metadata ->> 'displayName')
    AND (metadata ->> 'displayName') !~ '[[:cntrl:]]'
    AND char_length(metadata ->> 'provenance') BETWEEN 3 AND 80
    AND metadata ->> 'provenance' ~ '^[a-z][a-z0-9._-]*$'
  ),
  CONSTRAINT assets_status_shape CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  ),
  CONSTRAINT assets_timestamps_ordered CHECK (retired_at IS NULL OR retired_at >= created_at)
);
--> statement-breakpoint
CREATE INDEX assets_world_type_status_idx ON assets (world_id, asset_type, status, stable_key, id);
--> statement-breakpoint
CREATE TABLE asset_ownership (
  asset_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  owner_entity_id uuid NOT NULL,
  ownership_version bigint NOT NULL,
  acquired_event_id uuid NOT NULL,
  updated_state_revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_ownership_world_identity UNIQUE (world_id, asset_id),
  CONSTRAINT asset_ownership_event_asset_unique UNIQUE (acquired_event_id, asset_id),
  CONSTRAINT asset_ownership_asset_world_fk
    FOREIGN KEY (world_id, asset_id)
    REFERENCES assets(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_ownership_owner_world_fk
    FOREIGN KEY (world_id, owner_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_ownership_event_world_fk
    FOREIGN KEY (world_id, acquired_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT asset_ownership_versions_positive CHECK (
    ownership_version > 0 AND updated_state_revision > 0
  )
);
--> statement-breakpoint
CREATE INDEX asset_ownership_world_owner_idx
  ON asset_ownership (world_id, owner_entity_id, asset_id);
--> statement-breakpoint
CREATE UNIQUE INDEX asset_ownership_noninitial_event_unique
  ON asset_ownership (acquired_event_id) WHERE ownership_version > 1;
--> statement-breakpoint
CREATE TABLE asset_transfers (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL,
  from_owner_entity_id uuid,
  to_owner_entity_id uuid NOT NULL,
  transfer_kind asset_transfer_kind NOT NULL,
  financial_transaction_id uuid,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  occurred_tick bigint NOT NULL,
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_transfers_world_identity UNIQUE (world_id, id),
  CONSTRAINT asset_transfers_event_asset_unique UNIQUE (event_id, asset_id),
  CONSTRAINT asset_transfers_command_asset_unique UNIQUE (command_id, asset_id),
  CONSTRAINT asset_transfers_financial_transaction_unique UNIQUE (financial_transaction_id),
  CONSTRAINT asset_transfers_asset_world_fk
    FOREIGN KEY (world_id, asset_id)
    REFERENCES assets(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfers_from_owner_world_fk
    FOREIGN KEY (world_id, from_owner_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfers_to_owner_world_fk
    FOREIGN KEY (world_id, to_owner_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfers_financial_transaction_world_fk
    FOREIGN KEY (world_id, financial_transaction_id)
    REFERENCES financial_transactions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfers_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfers_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT asset_transfers_tick_revision_valid CHECK (
    occurred_tick >= 0 AND state_revision > 0
  ),
  CONSTRAINT asset_transfers_owner_shape CHECK (
    (transfer_kind = 'initial' AND from_owner_entity_id IS NULL
      AND financial_transaction_id IS NULL)
    OR (transfer_kind IN ('grant','compensation') AND from_owner_entity_id IS NOT NULL
      AND financial_transaction_id IS NULL)
    OR (transfer_kind = 'purchase' AND from_owner_entity_id IS NOT NULL
      AND financial_transaction_id IS NOT NULL)
  ),
  CONSTRAINT asset_transfers_owners_distinct CHECK (
    from_owner_entity_id IS NULL OR from_owner_entity_id <> to_owner_entity_id
  )
);
--> statement-breakpoint
CREATE INDEX asset_transfers_asset_cursor_idx
  ON asset_transfers (world_id, asset_id, state_revision DESC, created_at DESC, id DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX asset_transfers_noninitial_event_unique
  ON asset_transfers (event_id) WHERE transfer_kind <> 'initial';
--> statement-breakpoint
CREATE TABLE asset_transfer_offers (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL,
  seller_entity_id uuid NOT NULL,
  buyer_entity_id uuid,
  currency_id uuid NOT NULL,
  seller_wallet_id uuid NOT NULL,
  price_minor bigint NOT NULL,
  expires_at_tick bigint NOT NULL,
  created_at_tick bigint NOT NULL,
  status asset_transfer_offer_status NOT NULL DEFAULT 'open',
  created_command_id uuid NOT NULL UNIQUE,
  created_event_id uuid NOT NULL UNIQUE,
  terminal_command_id uuid UNIQUE,
  terminal_event_id uuid UNIQUE,
  accepted_financial_transaction_id uuid UNIQUE,
  accepted_asset_transfer_id uuid UNIQUE,
  row_version bigint NOT NULL DEFAULT 1,
  created_state_revision bigint NOT NULL,
  terminal_state_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_transfer_offers_world_identity UNIQUE (world_id, id),
  CONSTRAINT asset_transfer_offers_asset_world_fk
    FOREIGN KEY (world_id, asset_id)
    REFERENCES assets(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_seller_world_fk
    FOREIGN KEY (world_id, seller_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_buyer_world_fk
    FOREIGN KEY (world_id, buyer_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_currency_world_fk
    FOREIGN KEY (world_id, currency_id)
    REFERENCES currencies(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_seller_wallet_world_currency_fk
    FOREIGN KEY (world_id, currency_id, seller_wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_created_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_created_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT asset_transfer_offers_terminal_command_world_fk
    FOREIGN KEY (terminal_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_terminal_event_world_fk
    FOREIGN KEY (world_id, terminal_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT asset_transfer_offers_financial_transaction_world_fk
    FOREIGN KEY (world_id, accepted_financial_transaction_id)
    REFERENCES financial_transactions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_asset_transfer_world_fk
    FOREIGN KEY (world_id, accepted_asset_transfer_id)
    REFERENCES asset_transfers(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT asset_transfer_offers_price_tick_valid CHECK (
    price_minor > 0 AND created_at_tick >= 0 AND expires_at_tick > created_at_tick
  ),
  CONSTRAINT asset_transfer_offers_versions_positive CHECK (
    row_version > 0 AND created_state_revision > 0
    AND (terminal_state_revision IS NULL OR terminal_state_revision > created_state_revision)
  ),
  CONSTRAINT asset_transfer_offers_parties_distinct CHECK (
    buyer_entity_id IS NULL OR buyer_entity_id <> seller_entity_id
  ),
  CONSTRAINT asset_transfer_offers_status_shape CHECK (
    (status = 'open' AND terminal_command_id IS NULL AND terminal_event_id IS NULL
      AND terminal_state_revision IS NULL AND accepted_financial_transaction_id IS NULL
      AND accepted_asset_transfer_id IS NULL)
    OR (status = 'accepted' AND terminal_command_id IS NOT NULL
      AND terminal_event_id IS NOT NULL AND terminal_state_revision IS NOT NULL
      AND accepted_financial_transaction_id IS NOT NULL
      AND accepted_asset_transfer_id IS NOT NULL)
    OR (status IN ('cancelled','expired') AND terminal_command_id IS NOT NULL
      AND terminal_event_id IS NOT NULL AND terminal_state_revision IS NOT NULL
      AND accepted_financial_transaction_id IS NULL AND accepted_asset_transfer_id IS NULL)
  ),
  CONSTRAINT asset_transfer_offers_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX asset_transfer_offers_one_open_asset_idx
  ON asset_transfer_offers (world_id, asset_id) WHERE status = 'open';
--> statement-breakpoint
CREATE INDEX asset_transfer_offers_due_idx
  ON asset_transfer_offers (expires_at_tick, world_id, id) WHERE status = 'open';
--> statement-breakpoint
CREATE INDEX asset_transfer_offers_participant_idx
  ON asset_transfer_offers (world_id, seller_entity_id, buyer_entity_id, status, id);
--> statement-breakpoint
CREATE TABLE world_economy_heads (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  economy_schema_version integer NOT NULL DEFAULT 1,
  source_world_version_id uuid NOT NULL,
  seed_plan_hash bytea NOT NULL,
  initialized_command_id uuid NOT NULL UNIQUE,
  initialized_event_id uuid NOT NULL UNIQUE,
  checksum bytea NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  updated_state_revision bigint NOT NULL,
  reconciliation_status economy_reconciliation_status NOT NULL DEFAULT 'pending',
  last_reconciled_state_revision bigint,
  last_reconciliation_run_id uuid,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_economy_heads_plan_world_fk
    FOREIGN KEY (world_id, source_world_version_id, seed_plan_hash)
    REFERENCES compiled_economy_seed_plans(world_id, world_version_id, plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT world_economy_heads_command_world_fk
    FOREIGN KEY (initialized_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT world_economy_heads_event_world_fk
    FOREIGN KEY (world_id, initialized_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT world_economy_heads_schema_known CHECK (economy_schema_version = 1),
  CONSTRAINT world_economy_heads_hash_lengths CHECK (
    octet_length(seed_plan_hash) = 32 AND octet_length(checksum) = 32
  ),
  CONSTRAINT world_economy_heads_versions_positive CHECK (
    row_version > 0 AND updated_state_revision > 0
  ),
  CONSTRAINT world_economy_heads_reconciliation_shape CHECK (
    (reconciliation_status = 'pending' AND last_reconciled_state_revision IS NULL
      AND last_reconciliation_run_id IS NULL)
    OR (reconciliation_status IN ('current','mismatch','failed')
      AND last_reconciled_state_revision IS NOT NULL
      AND last_reconciliation_run_id IS NOT NULL)
  ),
  CONSTRAINT world_economy_heads_timestamps_ordered CHECK (updated_at >= initialized_at)
);
--> statement-breakpoint
CREATE TABLE economy_reconciliation_runs (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  reconciliation_schema_version integer NOT NULL DEFAULT 1,
  source_state_revision bigint NOT NULL,
  source_event_sequence bigint NOT NULL,
  status economy_reconciliation_run_status NOT NULL,
  live_wallet_checksum bytea NOT NULL,
  rebuilt_wallet_checksum bytea NOT NULL,
  live_supply_checksum bytea NOT NULL,
  rebuilt_supply_checksum bytea NOT NULL,
  live_ownership_checksum bytea NOT NULL,
  rebuilt_ownership_checksum bytea NOT NULL,
  live_projection_checksum bytea NOT NULL,
  rebuilt_journal_checksum bytea NOT NULL,
  wallet_count integer NOT NULL,
  currency_count integer NOT NULL,
  asset_count integer NOT NULL,
  mismatch_count integer NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT economy_reconciliation_runs_world_identity UNIQUE (world_id, id),
  CONSTRAINT economy_reconciliation_runs_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_reconciliation_runs_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT economy_reconciliation_runs_schema_known CHECK (
    reconciliation_schema_version = 1
  ),
  CONSTRAINT economy_reconciliation_runs_source_valid CHECK (
    source_state_revision > 0 AND source_event_sequence > 0
  ),
  CONSTRAINT economy_reconciliation_runs_hash_lengths CHECK (
    octet_length(live_wallet_checksum) = 32
    AND octet_length(rebuilt_wallet_checksum) = 32
    AND octet_length(live_supply_checksum) = 32
    AND octet_length(rebuilt_supply_checksum) = 32
    AND octet_length(live_ownership_checksum) = 32
    AND octet_length(rebuilt_ownership_checksum) = 32
    AND octet_length(live_projection_checksum) = 32
    AND octet_length(rebuilt_journal_checksum) = 32
  ),
  CONSTRAINT economy_reconciliation_runs_counts_valid CHECK (
    wallet_count >= 0 AND currency_count >= 0 AND asset_count >= 0
    AND mismatch_count >= 0
    AND ((status = 'matched' AND mismatch_count = 0)
      OR (status = 'mismatch' AND mismatch_count > 0))
  )
);
--> statement-breakpoint
CREATE INDEX economy_reconciliation_runs_world_cursor_idx
  ON economy_reconciliation_runs (world_id, source_state_revision DESC, created_at DESC, id DESC);
--> statement-breakpoint
ALTER TABLE world_economy_heads
  ADD CONSTRAINT world_economy_heads_reconciliation_run_world_fk
  FOREIGN KEY (world_id, last_reconciliation_run_id)
  REFERENCES economy_reconciliation_runs(world_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE economy_reconciliation_items (
  run_id uuid NOT NULL REFERENCES economy_reconciliation_runs(id) ON DELETE RESTRICT,
  item_ordinal integer NOT NULL,
  item_kind text NOT NULL,
  item_key text NOT NULL,
  item_key_hash bytea NOT NULL,
  expected_value text,
  actual_value text,
  mismatch_code text NOT NULL,
  PRIMARY KEY (run_id, item_ordinal),
  CONSTRAINT economy_reconciliation_items_ordinal_bounded CHECK (
    item_ordinal BETWEEN 0 AND 9999
  ),
  CONSTRAINT economy_reconciliation_items_kind_shape CHECK (
    item_kind IN ('wallet_balance','currency_supply','asset_ownership')
  ),
  CONSTRAINT economy_reconciliation_items_key_shape CHECK (
    char_length(item_key) BETWEEN 1 AND 240 AND item_key = btrim(item_key)
    AND item_key !~ '[[:cntrl:]]'
    AND item_key_hash = extensions.digest(convert_to(item_key, 'UTF8'), 'sha256')
  ),
  CONSTRAINT economy_reconciliation_items_value_shape CHECK (
    (expected_value IS NULL OR expected_value ~ '^(0|-?[1-9][0-9]{0,18}|[a-f0-9]{64})$')
    AND (actual_value IS NULL OR actual_value ~ '^(0|-?[1-9][0-9]{0,18}|[a-f0-9]{64})$')
    AND expected_value IS DISTINCT FROM actual_value
  ),
  CONSTRAINT economy_reconciliation_items_key_hash_length CHECK (
    octet_length(item_key_hash) = 32
  ),
  CONSTRAINT economy_reconciliation_items_code_shape CHECK (
    char_length(mismatch_code) BETWEEN 3 AND 100
    AND mismatch_code ~ '^[A-Z][A-Z0-9_]*$'
  )
);
--> statement-breakpoint
CREATE TABLE economy_participant_history (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  ledger_sequence bigint NOT NULL,
  user_id uuid NOT NULL,
  participant_entity_id uuid NOT NULL,
  counterparty_entity_id uuid,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  category text NOT NULL,
  summary_code text NOT NULL,
  summary_args jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility economy_participant_visibility NOT NULL DEFAULT 'participant',
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, ledger_sequence, user_id),
  CONSTRAINT economy_participant_history_membership_fk
    FOREIGN KEY (world_id, user_id)
    REFERENCES world_memberships(world_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT economy_participant_history_participant_world_fk
    FOREIGN KEY (world_id, participant_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_participant_history_counterparty_world_fk
    FOREIGN KEY (world_id, counterparty_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_participant_history_ledger_fk
    FOREIGN KEY (world_id, ledger_sequence)
    REFERENCES ledger_entries(world_id, ledger_sequence) ON DELETE RESTRICT,
  CONSTRAINT economy_participant_history_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_participant_history_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_participant_history_sequence_revision_positive CHECK (
    ledger_sequence > 0 AND state_revision > 0
  ),
  CONSTRAINT economy_participant_history_category_shape CHECK (
    category IN ('currency','asset','offer','issuance','wallet','reconciliation','repair')
  ),
  CONSTRAINT economy_participant_history_summary_code_shape CHECK (
    char_length(summary_code) BETWEEN 3 AND 100
    AND summary_code ~ '^[A-Z][A-Z0-9_]*$'
  ),
  CONSTRAINT economy_participant_history_summary_safe CHECK (
    jsonb_typeof(summary_args) = 'object' AND pg_column_size(summary_args) <= 4096
    AND NOT worldgraph_jsonb_has_sensitive_key(summary_args)
    AND NOT worldgraph_jsonb_has_compiler_private_key(summary_args)
    AND NOT summary_args ?| ARRAY['memo','memoText','balance','availableMinor']
  )
);
--> statement-breakpoint
CREATE INDEX economy_participant_history_user_cursor_idx
  ON economy_participant_history (world_id, user_id, ledger_sequence DESC);
--> statement-breakpoint
CREATE TABLE economy_command_write_snapshots (
  command_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  economy_state_exists boolean NOT NULL,
  opened_head_row_version bigint,
  opened_head_checksum bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT economy_command_write_snapshots_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_command_write_snapshots_head_shape CHECK (
    (NOT economy_state_exists
      AND opened_head_row_version IS NULL AND opened_head_checksum IS NULL)
    OR (economy_state_exists
      AND opened_head_row_version > 0
      AND octet_length(opened_head_checksum) = 32)
  )
);
--> statement-breakpoint
CREATE TABLE economy_command_mutations (
  command_id uuid NOT NULL,
  world_id uuid NOT NULL,
  mutation_kind text NOT NULL,
  target_id uuid NOT NULL,
  operation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (command_id, mutation_kind, target_id),
  CONSTRAINT economy_command_mutations_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_command_mutations_kind_known CHECK (
    mutation_kind IN (
      'currency','currency_supply','wallet','wallet_balance','asset',
      'asset_ownership','asset_transfer_offer','economy_head'
    )
  ),
  CONSTRAINT economy_command_mutations_operation_known CHECK (
    operation IN ('insert','update')
  )
);
--> statement-breakpoint
CREATE INDEX economy_command_mutations_world_command_idx
  ON economy_command_mutations (world_id, command_id, mutation_kind, target_id);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_repair_reason_is_valid(value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
  character_index integer;
  code_point integer;
BEGIN
  IF char_length(value) NOT BETWEEN 8 AND 500
    OR left(value, 1) = ' ' OR right(value, 1) = ' ' THEN
    RETURN false;
  END IF;
  FOR character_index IN 1..char_length(value) LOOP
    code_point := ascii(substr(value, character_index, 1));
    IF code_point BETWEEN 0 AND 31
      OR code_point BETWEEN 127 AND 159 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_repair_reason_is_valid(text) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE financial_transactions
  ADD CONSTRAINT financial_transactions_reversal_shape CHECK (
    (transaction_kind = 'compensation' AND reversal_of_transaction_id IS NOT NULL)
    OR (transaction_kind <> 'compensation' AND reversal_of_transaction_id IS NULL)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX financial_transactions_one_compensation_idx
  ON financial_transactions (reversal_of_transaction_id)
  WHERE reversal_of_transaction_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE asset_transfers
  ADD COLUMN reversal_of_transfer_id uuid,
  ADD CONSTRAINT asset_transfers_reversal_world_fk
    FOREIGN KEY (world_id, reversal_of_transfer_id)
    REFERENCES asset_transfers(world_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT asset_transfers_reversal_not_self CHECK (
    reversal_of_transfer_id IS NULL OR reversal_of_transfer_id <> id
  ),
  ADD CONSTRAINT asset_transfers_reversal_shape CHECK (
    (transfer_kind = 'compensation' AND reversal_of_transfer_id IS NOT NULL)
    OR (transfer_kind <> 'compensation' AND reversal_of_transfer_id IS NULL)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX asset_transfers_one_compensation_idx
  ON asset_transfers (reversal_of_transfer_id)
  WHERE reversal_of_transfer_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE economy_repair_plans (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  repair_plan_schema_version integer NOT NULL DEFAULT 1,
  reserved_command_id uuid NOT NULL UNIQUE,
  source_command_id uuid NOT NULL,
  repair_kind economy_repair_kind NOT NULL,
  source_financial_transaction_id uuid,
  source_asset_transfer_id uuid,
  compensation_transaction_id uuid,
  compensation_transfer_id uuid,
  source_world_version bigint NOT NULL,
  source_state_revision bigint NOT NULL,
  source_event_sequence bigint NOT NULL,
  source_economy_head_version bigint NOT NULL,
  source_economy_checksum bytea NOT NULL,
  source_reconciliation_run_id uuid NOT NULL,
  canonical_delta jsonb NOT NULL,
  delta_hash bytea NOT NULL,
  plan_hash bytea NOT NULL UNIQUE,
  reason_code economy_repair_reason_code NOT NULL,
  incident_reason text NOT NULL,
  pitr_not_used_reason text NOT NULL,
  prepared_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  preparation_audit_id uuid NOT NULL UNIQUE,
  prepared_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT economy_repair_plans_world_identity UNIQUE (world_id, id),
  CONSTRAINT economy_repair_plans_source_command_world_fk
    FOREIGN KEY (source_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_plans_source_financial_world_fk
    FOREIGN KEY (world_id, source_financial_transaction_id)
    REFERENCES financial_transactions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_plans_source_transfer_world_fk
    FOREIGN KEY (world_id, source_asset_transfer_id)
    REFERENCES asset_transfers(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_plans_reconciliation_world_fk
    FOREIGN KEY (world_id, source_reconciliation_run_id)
    REFERENCES economy_reconciliation_runs(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_plans_preparation_audit_fk
    FOREIGN KEY (preparation_audit_id, world_id, prepared_by_user_id)
    REFERENCES security_audit_records(id, world_id, actor_user_id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_plans_schema_known CHECK (repair_plan_schema_version = 1),
  CONSTRAINT economy_repair_plans_versions_valid CHECK (
    source_world_version > 0 AND source_state_revision >= 0
    AND source_event_sequence > 0 AND source_economy_head_version > 0
  ),
  CONSTRAINT economy_repair_plans_hash_lengths CHECK (
    octet_length(source_economy_checksum) = 32
    AND octet_length(delta_hash) = 32 AND octet_length(plan_hash) = 32
  ),
  CONSTRAINT economy_repair_plans_reason_shape CHECK (
    worldgraph_economy_repair_reason_is_valid(incident_reason)
    AND worldgraph_economy_repair_reason_is_valid(pitr_not_used_reason)
  ),
  CONSTRAINT economy_repair_plans_time_window_exact CHECK (
    prepared_at = date_trunc('milliseconds', prepared_at)
    AND expires_at = prepared_at + interval '24 hours'
  ),
  CONSTRAINT economy_repair_plans_identities_distinct CHECK (
    id <> reserved_command_id AND id <> source_command_id
    AND reserved_command_id <> source_command_id
    AND (compensation_transaction_id IS NULL OR compensation_transaction_id NOT IN (
      id, reserved_command_id, source_command_id
    ))
    AND (compensation_transfer_id IS NULL OR compensation_transfer_id NOT IN (
      id, reserved_command_id, source_command_id
    ))
    AND (compensation_transaction_id IS NULL OR compensation_transfer_id IS NULL
      OR compensation_transaction_id <> compensation_transfer_id)
  ),
  CONSTRAINT economy_repair_plans_kind_shape CHECK (
    (repair_kind = 'reverse_financial_transaction'
      AND source_financial_transaction_id IS NOT NULL
      AND source_asset_transfer_id IS NULL
      AND compensation_transaction_id IS NOT NULL
      AND compensation_transfer_id IS NULL)
    OR (repair_kind = 'reverse_asset_transfer'
      AND source_financial_transaction_id IS NULL
      AND source_asset_transfer_id IS NOT NULL
      AND compensation_transaction_id IS NULL
      AND compensation_transfer_id IS NOT NULL)
    OR (repair_kind = 'reverse_asset_purchase'
      AND source_financial_transaction_id IS NOT NULL
      AND source_asset_transfer_id IS NOT NULL
      AND compensation_transaction_id IS NOT NULL
      AND compensation_transfer_id IS NOT NULL)
  ),
  CONSTRAINT economy_repair_plans_delta_safe CHECK (
    jsonb_typeof(canonical_delta) = 'object'
    AND pg_column_size(canonical_delta) <= 32768
    AND NOT worldgraph_jsonb_has_sensitive_key(canonical_delta)
    AND NOT worldgraph_jsonb_has_compiler_private_key(canonical_delta)
  )
);
--> statement-breakpoint
CREATE INDEX economy_repair_plans_world_source_idx
  ON economy_repair_plans (world_id, source_command_id, prepared_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX economy_repair_plans_expiry_idx
  ON economy_repair_plans (expires_at, world_id, id);
--> statement-breakpoint
CREATE TABLE economy_repair_approvals (
  id uuid PRIMARY KEY,
  repair_plan_id uuid NOT NULL,
  world_id uuid NOT NULL,
  authority_kind economy_repair_approval_authority NOT NULL,
  approver_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creator_override_id uuid REFERENCES creator_override_records(id) ON DELETE RESTRICT,
  approved_plan_hash bytea NOT NULL,
  audit_record_id uuid NOT NULL UNIQUE,
  approved_at timestamptz NOT NULL,
  CONSTRAINT economy_repair_approvals_plan_authority_unique
    UNIQUE (repair_plan_id, authority_kind),
  CONSTRAINT economy_repair_approvals_plan_approver_unique
    UNIQUE (repair_plan_id, approver_user_id),
  CONSTRAINT economy_repair_approvals_creator_override_unique UNIQUE (creator_override_id),
  CONSTRAINT economy_repair_approvals_plan_world_fk
    FOREIGN KEY (world_id, repair_plan_id)
    REFERENCES economy_repair_plans(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_approvals_audit_fk
    FOREIGN KEY (audit_record_id, world_id, approver_user_id)
    REFERENCES security_audit_records(id, world_id, actor_user_id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_approvals_hash_length CHECK (
    octet_length(approved_plan_hash) = 32
  ),
  CONSTRAINT economy_repair_approvals_authority_shape CHECK (
    (authority_kind = 'creator' AND creator_override_id IS NOT NULL)
    OR (authority_kind = 'platform_admin' AND creator_override_id IS NULL)
  ),
  CONSTRAINT economy_repair_approvals_timestamp_canonical CHECK (
    approved_at = date_trunc('milliseconds', approved_at)
  )
);
--> statement-breakpoint
CREATE INDEX economy_repair_approvals_world_plan_idx
  ON economy_repair_approvals (world_id, repair_plan_id, authority_kind);
--> statement-breakpoint
CREATE TABLE economy_repair_executions (
  id uuid PRIMARY KEY,
  repair_plan_id uuid NOT NULL UNIQUE,
  world_id uuid NOT NULL,
  source_command_id uuid NOT NULL UNIQUE,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  ledger_entry_id uuid NOT NULL UNIQUE,
  financial_transaction_id uuid UNIQUE,
  asset_transfer_id uuid UNIQUE,
  executed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  execution_audit_id uuid NOT NULL UNIQUE,
  resulting_state_revision bigint NOT NULL,
  resulting_event_sequence bigint NOT NULL,
  resulting_ledger_sequence bigint NOT NULL,
  resulting_economy_head_version bigint NOT NULL,
  resulting_economy_checksum bytea NOT NULL,
  executed_at timestamptz NOT NULL,
  CONSTRAINT economy_repair_executions_world_identity UNIQUE (world_id, id),
  CONSTRAINT economy_repair_executions_plan_world_fk
    FOREIGN KEY (world_id, repair_plan_id)
    REFERENCES economy_repair_plans(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_executions_source_command_world_fk
    FOREIGN KEY (source_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_executions_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_executions_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_executions_ledger_world_fk
    FOREIGN KEY (world_id, ledger_entry_id)
    REFERENCES ledger_entries(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_executions_financial_world_fk
    FOREIGN KEY (world_id, financial_transaction_id)
    REFERENCES financial_transactions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_executions_transfer_world_fk
    FOREIGN KEY (world_id, asset_transfer_id)
    REFERENCES asset_transfers(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_executions_audit_fk
    FOREIGN KEY (execution_audit_id, world_id, executed_by_user_id)
    REFERENCES security_audit_records(id, world_id, actor_user_id) ON DELETE RESTRICT,
  CONSTRAINT economy_repair_executions_sequences_positive CHECK (
    resulting_state_revision > 0 AND resulting_event_sequence > 0
    AND resulting_ledger_sequence > 0 AND resulting_economy_head_version > 0
  ),
  CONSTRAINT economy_repair_executions_checksum_length CHECK (
    octet_length(resulting_economy_checksum) = 32
  ),
  CONSTRAINT economy_repair_executions_timestamp_canonical CHECK (
    executed_at = date_trunc('milliseconds', executed_at)
  )
);
--> statement-breakpoint
CREATE INDEX economy_repair_executions_world_cursor_idx
  ON economy_repair_executions (world_id, executed_at DESC, id DESC);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_seed_plan_is_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  currency_value jsonb;
  wallet_value jsonb;
  asset_value jsonb;
  initial_supply numeric;
  wallet_sum numeric := 0;
  wallet_count integer := 0;
  treasury_count integer := 0;
  player_count integer := 0;
  asset_count integer := 0;
BEGIN
  IF jsonb_typeof(value) <> 'object'
    OR NOT public.worldgraph_jsonb_has_exact_keys(value, ARRAY[
      'economySeedPlanSchemaVersion','currency','wallets','assets','initialSupplyMinor'
    ])
    OR value ->> 'economySeedPlanSchemaVersion' IS DISTINCT FROM '1'
    OR jsonb_typeof(value -> 'currency') <> 'object'
    OR jsonb_typeof(value -> 'wallets') <> 'array'
    OR jsonb_typeof(value -> 'assets') <> 'array'
    OR value ->> 'initialSupplyMinor' IS NULL
    OR value ->> 'initialSupplyMinor' !~ '^(0|[1-9][0-9]*)$' THEN
    RETURN false;
  END IF;
  initial_supply := (value ->> 'initialSupplyMinor')::numeric;
  IF initial_supply > 9223372036854775807::numeric THEN
    RETURN false;
  END IF;

  currency_value := value -> 'currency';
  IF NOT public.worldgraph_jsonb_has_exact_keys(currency_value, ARRAY[
      'currencySchemaVersion','stableKey','code','name','minorUnitScale',
      'maxSupplyMinor','issuerEntityLogicalKey','noCashValue','cashOutAllowed'
    ])
    OR currency_value ->> 'currencySchemaVersion' IS DISTINCT FROM '1'
    OR currency_value ->> 'stableKey' IS NULL
    OR char_length(currency_value ->> 'stableKey') NOT BETWEEN 3 AND 240
    OR currency_value ->> 'stableKey'
      !~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
    OR currency_value ->> 'code' IS NULL
    OR currency_value ->> 'code' !~ '^[A-Z][A-Z0-9]{2,11}$'
    OR currency_value ->> 'name' IS NULL
    OR char_length(currency_value ->> 'name') NOT BETWEEN 1 AND 100
    OR currency_value ->> 'minorUnitScale' IS NULL
    OR (currency_value ->> 'minorUnitScale') !~ '^[0-6]$'
    OR currency_value ->> 'maxSupplyMinor' IS NULL
    OR currency_value ->> 'maxSupplyMinor' !~ '^(0|[1-9][0-9]*)$'
    OR (currency_value ->> 'maxSupplyMinor')::numeric > 9223372036854775807::numeric
    OR (currency_value ->> 'maxSupplyMinor')::numeric < initial_supply
    OR currency_value ->> 'issuerEntityLogicalKey' IS NULL
    OR char_length(currency_value ->> 'issuerEntityLogicalKey') NOT BETWEEN 3 AND 240
    OR currency_value ->> 'issuerEntityLogicalKey'
      !~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
    OR currency_value -> 'noCashValue' IS DISTINCT FROM 'true'::jsonb
    OR currency_value -> 'cashOutAllowed' IS DISTINCT FROM 'false'::jsonb THEN
    RETURN false;
  END IF;

  FOR wallet_value IN SELECT item FROM jsonb_array_elements(value -> 'wallets') item LOOP
    wallet_count := wallet_count + 1;
    IF jsonb_typeof(wallet_value) <> 'object'
      OR NOT public.worldgraph_jsonb_has_exact_keys(wallet_value, ARRAY[
        'walletSchemaVersion','stableKey','ownerEntityLogicalKey',
        'walletKind','initialBalanceMinor'
      ])
      OR wallet_value ->> 'walletSchemaVersion' IS DISTINCT FROM '1'
      OR wallet_value ->> 'stableKey' IS NULL
      OR char_length(wallet_value ->> 'stableKey') NOT BETWEEN 3 AND 240
      OR wallet_value ->> 'stableKey'
        !~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
      OR wallet_value ->> 'ownerEntityLogicalKey' IS NULL
      OR char_length(wallet_value ->> 'ownerEntityLogicalKey') NOT BETWEEN 3 AND 240
      OR wallet_value ->> 'ownerEntityLogicalKey'
        !~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
      OR wallet_value ->> 'walletKind' IS NULL
      OR wallet_value ->> 'walletKind' NOT IN ('player','organization','treasury')
      OR wallet_value ->> 'initialBalanceMinor' IS NULL
      OR wallet_value ->> 'initialBalanceMinor' !~ '^(0|[1-9][0-9]*)$'
      OR (wallet_value ->> 'initialBalanceMinor')::numeric > 9223372036854775807::numeric THEN
      RETURN false;
    END IF;
    wallet_sum := wallet_sum + (wallet_value ->> 'initialBalanceMinor')::numeric;
    treasury_count := treasury_count + (wallet_value ->> 'walletKind' = 'treasury')::integer;
    player_count := player_count + (wallet_value ->> 'walletKind' = 'player')::integer;
  END LOOP;
  IF wallet_count NOT BETWEEN 2 AND 101 OR treasury_count <> 1 OR player_count < 1
    OR wallet_sum <> initial_supply
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(value -> 'wallets') item
      WHERE item ->> 'walletKind' = 'treasury'
        AND item ->> 'ownerEntityLogicalKey' = currency_value ->> 'issuerEntityLogicalKey'
        AND item ->> 'initialBalanceMinor' = '0'
    )
    OR (SELECT count(DISTINCT item ->> 'stableKey')
          FROM jsonb_array_elements(value -> 'wallets') item) <> wallet_count
    OR (SELECT count(DISTINCT item ->> 'ownerEntityLogicalKey')
          FROM jsonb_array_elements(value -> 'wallets') item) <> wallet_count
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value -> 'wallets') WITH ORDINALITY current_item(item, ordinal)
      JOIN jsonb_array_elements(value -> 'wallets') WITH ORDINALITY previous_item(item, ordinal)
        ON previous_item.ordinal + 1 = current_item.ordinal
      WHERE (previous_item.item ->> 'stableKey') COLLATE "C"
        > (current_item.item ->> 'stableKey') COLLATE "C"
    ) THEN
    RETURN false;
  END IF;

  FOR asset_value IN SELECT item FROM jsonb_array_elements(value -> 'assets') item LOOP
    asset_count := asset_count + 1;
    IF jsonb_typeof(asset_value) <> 'object'
      OR NOT public.worldgraph_jsonb_has_exact_keys(asset_value, ARRAY[
        'assetSchemaVersion','stableKey','assetType','worldEntityLogicalKey',
        'initialOwnerEntityLogicalKey','transferable','metadata'
      ])
      OR asset_value ->> 'assetSchemaVersion' IS DISTINCT FROM '1'
      OR char_length(asset_value ->> 'stableKey') NOT BETWEEN 3 AND 240
      OR asset_value ->> 'stableKey' IS DISTINCT FROM 'asset:founding-seal'
      OR asset_value ->> 'assetType' IS DISTINCT FROM 'founding_seal'
      OR asset_value -> 'worldEntityLogicalKey' IS DISTINCT FROM 'null'::jsonb
      OR asset_value ->> 'initialOwnerEntityLogicalKey' IS NULL
      OR char_length(asset_value ->> 'initialOwnerEntityLogicalKey') NOT BETWEEN 3 AND 240
      OR asset_value ->> 'initialOwnerEntityLogicalKey'
        !~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
      OR asset_value -> 'transferable' IS DISTINCT FROM 'true'::jsonb
      OR NOT public.worldgraph_jsonb_has_exact_keys(
        asset_value -> 'metadata', ARRAY['displayName','provenance']
      )
      OR asset_value -> 'metadata' IS DISTINCT FROM jsonb_build_object(
          'displayName', 'Founding Seal',
          'provenance', 'compiler-economy-adapter-v1'
        ) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF asset_count <> 1
    OR (SELECT count(DISTINCT item ->> 'stableKey')
          FROM jsonb_array_elements(value -> 'assets') item) <> asset_count
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value -> 'assets') WITH ORDINALITY current_item(item, ordinal)
      JOIN jsonb_array_elements(value -> 'assets') WITH ORDINALITY previous_item(item, ordinal)
        ON previous_item.ordinal + 1 = current_item.ordinal
      WHERE (previous_item.item ->> 'stableKey') COLLATE "C"
        > (current_item.item ->> 'stableKey') COLLATE "C"
    ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_seed_plan_is_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE compiled_economy_seed_plans
  ADD CONSTRAINT compiled_economy_seed_plans_semantics_valid
  CHECK (worldgraph_economy_seed_plan_is_valid(canonical_plan));
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_projection_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN jsonb_build_object(
  'assets', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'assetId', asset.id::text,
      'assetSchemaVersion', asset.asset_schema_version,
      'assetType', asset.asset_type,
      'metadata', asset.metadata,
      'ownerEntityId', ownership.owner_entity_id::text,
      'ownershipVersion', ownership.ownership_version::text,
      'stableKey', asset.stable_key::text,
      'status', asset.status::text,
      'transferable', asset.transferable,
      'worldEntityId', asset.world_entity_id::text
    ) ORDER BY asset.stable_key::text COLLATE "C", asset.id)
    FROM public.assets asset
    JOIN public.asset_ownership ownership
      ON ownership.world_id = asset.world_id AND ownership.asset_id = asset.id
    WHERE asset.world_id = checked_world_id
  ), '[]'::jsonb),
  'currencies', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'code', currency.code::text,
      'currencyId', currency.id::text,
      'currencySchemaVersion', currency.currency_schema_version,
      'currentSupplyMinor', supply.current_supply_minor::text,
      'issuerEntityId', currency.issuer_entity_id::text,
      'maxSupplyMinor', currency.max_supply_minor::text,
      'minorUnitScale', currency.minor_unit_scale,
      'rowVersion', supply.row_version::text,
      'stableKey', currency.stable_key::text,
      'status', currency.status::text
    ) ORDER BY currency.stable_key::text COLLATE "C", currency.id)
    FROM public.currencies currency
    JOIN public.currency_supply supply
      ON supply.world_id = currency.world_id AND supply.currency_id = currency.id
    WHERE currency.world_id = checked_world_id
  ), '[]'::jsonb),
  'domain', 'worldgraph.economy-projection.v1',
  'economyProjectionSchemaVersion', 1,
  'offers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'assetId', offer.asset_id::text,
      'buyerEntityId', offer.buyer_entity_id::text,
      'currencyId', offer.currency_id::text,
      'expiresAtTick', offer.expires_at_tick::text,
      'offerId', offer.id::text,
      'priceMinor', offer.price_minor::text,
      'rowVersion', offer.row_version::text,
      'sellerEntityId', offer.seller_entity_id::text,
      'sellerWalletId', offer.seller_wallet_id::text,
      'status', offer.status::text,
      'terminalStateRevision', offer.terminal_state_revision::text
    ) ORDER BY offer.id)
    FROM public.asset_transfer_offers offer WHERE offer.world_id = checked_world_id
  ), '[]'::jsonb),
  'seed', (
    SELECT jsonb_build_object(
      'seedPlanHash', encode(head.seed_plan_hash, 'hex'),
      'sourceWorldVersionId', head.source_world_version_id::text
    ) FROM public.world_economy_heads head WHERE head.world_id = checked_world_id
  ),
  'wallets', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'availableMinor', balance.available_minor::text,
      'currencyId', wallet.currency_id::text,
      'ownerEntityId', wallet.owner_entity_id::text,
      'rowVersion', balance.row_version::text,
      'stableKey', wallet.stable_key::text,
      'status', wallet.status::text,
      'walletId', wallet.id::text,
      'walletKind', wallet.wallet_kind::text,
      'walletSchemaVersion', wallet.wallet_schema_version
    ) ORDER BY wallet.stable_key::text COLLATE "C", wallet.id)
    FROM public.wallets wallet
    JOIN public.wallet_balances balance
      ON balance.world_id = wallet.world_id AND balance.wallet_id = wallet.id
    WHERE wallet.world_id = checked_world_id
  ), '[]'::jsonb),
  'worldId', checked_world_id::text
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_projection_checksum(checked_world_id uuid)
RETURNS bytea
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
RETURN extensions.digest(convert_to(worldgraph_canonical_jsonb(
  worldgraph_economy_projection_document(checked_world_id)
), 'UTF8'), 'sha256');
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_initial_projection_checksum(
  checked_world_id uuid,
  checked_world_version_id uuid,
  checked_seed_plan_hash bytea
)
RETURNS bytea
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
RETURN extensions.digest(convert_to(worldgraph_canonical_jsonb(
  jsonb_set(
    worldgraph_economy_projection_document(checked_world_id),
    '{seed}',
    jsonb_build_object(
      'seedPlanHash', encode(checked_seed_plan_hash, 'hex'),
      'sourceWorldVersionId', checked_world_version_id::text
    )
  )
), 'UTF8'), 'sha256');
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_wallet_live_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'availableMinor', balance.available_minor::text,
    'walletId', balance.wallet_id::text
  ) ORDER BY balance.wallet_id)
  FROM public.wallet_balances balance WHERE balance.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_wallet_rebuilt_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'availableMinor', COALESCE(posting.total, 0)::text,
    'walletId', wallet.id::text
  ) ORDER BY wallet.id)
  FROM public.wallets wallet
  LEFT JOIN (
    SELECT posting.wallet_id, sum(posting.signed_amount_minor) total
    FROM public.wallet_postings posting
    WHERE posting.world_id = checked_world_id GROUP BY posting.wallet_id
  ) posting ON posting.wallet_id = wallet.id
  WHERE wallet.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_supply_live_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'currencyKey', currency.stable_key::text,
    'currentSupplyMinor', supply.current_supply_minor::text
  ) ORDER BY currency.stable_key::text COLLATE "C")
  FROM public.currency_supply supply
  JOIN public.currencies currency
    ON currency.world_id = supply.world_id AND currency.id = supply.currency_id
  WHERE supply.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_supply_rebuilt_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'currencyKey', currency.stable_key::text,
    'currentSupplyMinor', COALESCE(transaction.total, 0)::text
  ) ORDER BY currency.stable_key::text COLLATE "C")
  FROM public.currencies currency
  LEFT JOIN (
    SELECT transaction.currency_id, sum(transaction.supply_delta_minor) total
    FROM public.financial_transactions transaction
    WHERE transaction.world_id = checked_world_id GROUP BY transaction.currency_id
  ) transaction ON transaction.currency_id = currency.id
  WHERE currency.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_ownership_live_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'assetKey', asset.stable_key::text,
    'ownerEntityLogicalKey', owner.logical_key::text,
    'ownershipVersion', ownership.ownership_version::text
  ) ORDER BY asset.stable_key::text COLLATE "C")
  FROM public.asset_ownership ownership
  JOIN public.assets asset
    ON asset.world_id = ownership.world_id AND asset.id = ownership.asset_id
  JOIN public.world_entities owner
    ON owner.world_id = ownership.world_id AND owner.id = ownership.owner_entity_id
  WHERE ownership.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_ownership_rebuilt_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'assetKey', latest.asset_key,
    'ownerEntityLogicalKey', latest.owner_logical_key,
    'ownershipVersion', latest.ownership_version::text
  ) ORDER BY latest.asset_key COLLATE "C")
  FROM (
    SELECT DISTINCT ON (transfer.asset_id)
      transfer.asset_id, transfer.to_owner_entity_id,
      asset.stable_key::text AS asset_key,
      owner.logical_key::text AS owner_logical_key,
      count(*) OVER (PARTITION BY transfer.asset_id) ownership_version
    FROM public.asset_transfers transfer
    JOIN public.assets asset
      ON asset.world_id = transfer.world_id AND asset.id = transfer.asset_id
    JOIN public.world_entities owner
      ON owner.world_id = transfer.world_id AND owner.id = transfer.to_owner_entity_id
    WHERE transfer.world_id = checked_world_id
    ORDER BY transfer.asset_id, transfer.state_revision DESC, transfer.created_at DESC, transfer.id DESC
  ) latest
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_reconciliation_snapshot(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
AS $function$
WITH documents AS (
  SELECT
    worldgraph_economy_wallet_live_document(checked_world_id) wallet_live,
    worldgraph_economy_wallet_rebuilt_document(checked_world_id) wallet_rebuilt,
    worldgraph_economy_supply_live_document(checked_world_id) supply_live,
    worldgraph_economy_supply_rebuilt_document(checked_world_id) supply_rebuilt,
    worldgraph_economy_ownership_live_document(checked_world_id) ownership_live,
    worldgraph_economy_ownership_rebuilt_document(checked_world_id) ownership_rebuilt
), canonical_documents AS (
  SELECT documents.*,
    jsonb_build_object(
      'domain', 'worldgraph.economy-reconciliation.v1',
      'economyReconciliationSchemaVersion', 1,
      'ownership', ownership_live,
      'supply', supply_live,
      'wallets', wallet_live
    ) live_document,
    jsonb_build_object(
      'domain', 'worldgraph.economy-reconciliation.v1',
      'economyReconciliationSchemaVersion', 1,
      'ownership', ownership_rebuilt,
      'supply', supply_rebuilt,
      'wallets', wallet_rebuilt
    ) rebuilt_document
  FROM documents
), hashes AS (
  SELECT canonical_documents.*,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(wallet_live),'UTF8'),'sha256') wallet_live_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(wallet_rebuilt),'UTF8'),'sha256') wallet_rebuilt_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(supply_live),'UTF8'),'sha256') supply_live_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(supply_rebuilt),'UTF8'),'sha256') supply_rebuilt_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(ownership_live),'UTF8'),'sha256') ownership_live_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(ownership_rebuilt),'UTF8'),'sha256') ownership_rebuilt_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(live_document),'UTF8'),'sha256') live_projection_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(rebuilt_document),'UTF8'),'sha256') rebuilt_projection_hash
  FROM canonical_documents
)
SELECT jsonb_build_object(
  'assetCount', (SELECT count(*) FROM public.assets WHERE world_id = checked_world_id),
  'currencyCount', (SELECT count(*) FROM public.currencies WHERE world_id = checked_world_id),
  'liveOwnershipChecksum', encode(ownership_live_hash,'hex'),
  'liveProjectionChecksum', encode(live_projection_hash,'hex'),
  'liveSupplyChecksum', encode(supply_live_hash,'hex'),
  'liveWalletChecksum', encode(wallet_live_hash,'hex'),
  'matched', wallet_live = wallet_rebuilt AND supply_live = supply_rebuilt
    AND ownership_live = ownership_rebuilt,
  'mismatchCount', (wallet_live <> wallet_rebuilt)::integer
    + (supply_live <> supply_rebuilt)::integer
    + (ownership_live <> ownership_rebuilt)::integer,
  'rebuiltOwnershipChecksum', encode(ownership_rebuilt_hash,'hex'),
  'rebuiltJournalChecksum', encode(rebuilt_projection_hash,'hex'),
  'rebuiltSupplyChecksum', encode(supply_rebuilt_hash,'hex'),
  'rebuiltWalletChecksum', encode(wallet_rebuilt_hash,'hex'),
  'walletCount', (SELECT count(*) FROM public.wallets WHERE world_id = checked_world_id)
) FROM hashes
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_runtime_state_exists(checked_world_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN EXISTS (SELECT 1 FROM public.world_economy_heads WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.currencies WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.currency_supply WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.wallets WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.wallet_balances WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.financial_transactions WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.wallet_postings WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.assets WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.asset_ownership WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.asset_transfers WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.asset_transfer_offers WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.economy_reconciliation_runs WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.economy_participant_history WHERE world_id = checked_world_id)
  OR EXISTS (SELECT 1 FROM public.projection_checkpoints
    WHERE world_id = checked_world_id AND projection_name = 'economy_runtime');
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_projection_current(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.world_economy_heads head
    JOIN public.world_runtime_heads runtime ON runtime.world_id = head.world_id
    JOIN public.projection_checkpoints checkpoint
      ON checkpoint.world_id = head.world_id AND checkpoint.projection_name = 'economy_runtime'
    WHERE head.world_id = checked_world_id
      AND head.economy_schema_version = 1
      AND head.reconciliation_status IN (
        'pending'::economy_reconciliation_status,
        'current'::economy_reconciliation_status
      )
      AND checkpoint.projection_schema_version = 1
      AND checkpoint.status = 'current'::projection_checkpoint_status
      AND checkpoint.last_event_sequence = runtime.last_event_sequence
      AND head.checksum = public.worldgraph_economy_projection_checksum(checked_world_id)
      AND checkpoint.checksum = head.checksum
  ) THEN
    RAISE EXCEPTION 'economy projection authority is inconsistent; command writes are frozen'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_economy_projection_current(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_due_asset_transfer_offers(
  checked_world_id uuid DEFAULT NULL,
  checked_limit integer DEFAULT 32
)
RETURNS TABLE (
  world_id uuid,
  offer_id uuid,
  current_tick bigint,
  offer_version bigint,
  expires_at_tick bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF checked_limit NOT BETWEEN 1 AND 250 THEN
    RAISE EXCEPTION 'offer expiry batch limit must be between 1 and 250'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT offer.world_id, offer.id, clock.current_tick,
           offer.row_version, offer.expires_at_tick
      FROM public.asset_transfer_offers offer
      JOIN public.world_simulation_clocks clock ON clock.world_id = offer.world_id
     WHERE offer.status = 'open'::asset_transfer_offer_status
       AND offer.expires_at_tick <= clock.current_tick
       AND (checked_world_id IS NULL OR offer.world_id = checked_world_id)
     ORDER BY offer.expires_at_tick, offer.world_id, offer.id
     LIMIT checked_limit;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_due_asset_transfer_offers(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_compiled_economy_seed_plan()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'compiled economy seed plans are immutable facts'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.source_kind = 'legacy_1_0_adapter'::economy_seed_plan_source AND (
    NEW.adopted_command_id IS NULL
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.adopted_command_id)
    OR NOT EXISTS (
      SELECT 1 FROM public.command_records command
      WHERE command.id = NEW.adopted_command_id AND command.world_id = NEW.world_id
        AND command.command_type = 'AdoptLegacyEconomySeedPlanV1'
        AND command.status = 'received'::command_record_status
    )
  ) THEN
    RAISE EXCEPTION 'legacy economy seed adoption requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER compiled_economy_seed_plans_protect
  BEFORE INSERT OR UPDATE OR DELETE ON compiled_economy_seed_plans
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_compiled_economy_seed_plan();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_compiled_economy_seed_plan()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  plan_record record;
BEGIN
  SELECT plan.*, version.compiler_version AS version_compiler_version,
         version.compiler_config_version AS version_compiler_config_version,
         version.artifact_hash AS version_artifact_hash,
         run.compiler_version AS run_compiler_version,
         run.compiler_config_version AS run_compiler_config_version,
         run.artifact_hash AS run_artifact_hash,
         artifact.artifact_kind, artifact.artifact_schema_version,
         artifact.canonical_content, artifact.content_hash
    INTO plan_record
    FROM public.compiled_economy_seed_plans plan
    JOIN public.world_versions version
      ON version.id = plan.world_version_id AND version.world_id = plan.world_id
    JOIN public.world_compilation_runs run
      ON run.id = plan.compilation_run_id AND run.world_id = plan.world_id
    JOIN public.compiled_world_artifacts artifact
      ON artifact.id = plan.source_artifact_id
     AND artifact.world_id = plan.world_id
     AND artifact.compilation_run_id = plan.compilation_run_id
   WHERE plan.id = NEW.id;
  IF NOT FOUND
    OR plan_record.artifact_kind IS DISTINCT FROM 'compiled_world'
    OR plan_record.version_artifact_hash IS DISTINCT FROM plan_record.source_artifact_hash
    OR plan_record.run_artifact_hash IS DISTINCT FROM plan_record.source_artifact_hash
    OR plan_record.content_hash IS DISTINCT FROM plan_record.source_artifact_hash
    OR plan_record.compilation_run_id IS DISTINCT FROM (
      SELECT version.compilation_run_id FROM public.world_versions version
      WHERE version.id = plan_record.world_version_id
    ) THEN
    RAISE EXCEPTION 'economy seed plan provenance does not match its exact artifact/run/version'
      USING ERRCODE = '55000';
  END IF;

  IF plan_record.source_kind = 'compiler_1_1'::economy_seed_plan_source THEN
    IF plan_record.version_compiler_version IS DISTINCT FROM '1.1.0'
      OR plan_record.run_compiler_version IS DISTINCT FROM '1.1.0'
      OR plan_record.version_compiler_config_version IS DISTINCT FROM 1
      OR plan_record.run_compiler_config_version IS DISTINCT FROM 1
      OR plan_record.artifact_schema_version IS DISTINCT FROM 2
      OR plan_record.canonical_content ->> 'artifactSchemaVersion' IS DISTINCT FROM '2'
      OR plan_record.canonical_content ->> 'compilerVersion' IS DISTINCT FROM '1.1.0'
      OR plan_record.canonical_content ->> 'compilerConfigVersion' IS DISTINCT FROM '1'
      OR plan_record.canonical_content -> 'economySeedPlan'
        IS DISTINCT FROM plan_record.canonical_plan
      OR plan_record.canonical_content ->> 'economySeedPlanHash'
        IS DISTINCT FROM encode(plan_record.plan_hash, 'hex')
      OR plan_record.adopted_command_id IS NOT NULL
      OR plan_record.adopted_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'native economy seed plan does not exactly match compiler 1.1 artifact'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF plan_record.version_compiler_version IS DISTINCT FROM '1.0.0'
      OR plan_record.run_compiler_version IS DISTINCT FROM '1.0.0'
      OR plan_record.version_compiler_config_version IS DISTINCT FROM 1
      OR plan_record.run_compiler_config_version IS DISTINCT FROM 1
      OR plan_record.artifact_schema_version IS DISTINCT FROM 1
      OR plan_record.canonical_content ->> 'artifactSchemaVersion' IS DISTINCT FROM '1'
      OR plan_record.canonical_content ->> 'compilerVersion' IS DISTINCT FROM '1.0.0'
      OR plan_record.canonical_content ? 'economySeedPlan'
      OR NOT EXISTS (
        SELECT 1
        FROM public.command_records command
        JOIN public.domain_events event
          ON event.world_id = command.world_id AND event.command_id = command.id
        WHERE command.id = plan_record.adopted_command_id
          AND command.world_id = plan_record.world_id
          AND command.command_type = 'AdoptLegacyEconomySeedPlanV1'
          AND command.status = 'accepted'::command_record_status
          AND command.resulting_state_revision = event.resulting_state_revision
          AND event.id = plan_record.adopted_event_id
          AND event.event_type = 'LegacyEconomySeedPlanAdoptedV1'
          AND event.aggregate_type = 'economy_seed_plan'
          AND event.aggregate_id = plan_record.id::text
          AND event.payload = jsonb_build_object(
            'adapterId', plan_record.source_adapter_id,
            'adapterVersion', plan_record.source_adapter_version,
            'compiledWorldVersionId', plan_record.world_version_id::text,
            'legacyArtifactHash', encode(plan_record.source_artifact_hash, 'hex'),
            'legacyArtifactSchemaVersion', 1,
            'legacyCompilerVersion', '1.0.0',
            'seedPlanHash', encode(plan_record.plan_hash, 'hex')
          )
      ) THEN
      RAISE EXCEPTION 'legacy economy seed plan lacks its exact audited adoption event'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER compiled_economy_seed_plans_require_provenance
  AFTER INSERT ON compiled_economy_seed_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_compiled_economy_seed_plan();
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_open_command_type(checked_world_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN (
  SELECT command.command_type
  FROM public.command_records command
  WHERE command.id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    AND command.world_id = checked_world_id
    AND public.worldgraph_command_write_is_open(checked_world_id, command.id)
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_open_command_type(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'currency rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  command_type := public.worldgraph_economy_open_command_type(COALESCE(NEW.world_id, OLD.world_id));
  IF TG_OP = 'INSERT' THEN
    IF command_type IS DISTINCT FROM 'InitializeWorldEconomyV1'
      OR NEW.status <> 'active'::currency_status OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'currency creation requires economy initialization'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF command_type IS NULL OR command_type NOT IN ('FreezeCurrencyV1','UnfreezeCurrencyV1')
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.stable_key IS DISTINCT FROM OLD.stable_key
    OR NEW.code IS DISTINCT FROM OLD.code OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.minor_unit_scale IS DISTINCT FROM OLD.minor_unit_scale
    OR NEW.max_supply_minor IS DISTINCT FROM OLD.max_supply_minor
    OR NEW.issuer_entity_id IS DISTINCT FROM OLD.issuer_entity_id
    OR NEW.currency_schema_version IS DISTINCT FROM OLD.currency_schema_version
    OR NEW.created_event_id IS DISTINCT FROM OLD.created_event_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at
    OR (command_type = 'FreezeCurrencyV1' AND NOT (
      OLD.status = 'active'::currency_status AND NEW.status = 'frozen'::currency_status))
    OR (command_type = 'UnfreezeCurrencyV1' AND NOT (
      OLD.status = 'frozen'::currency_status AND NEW.status = 'active'::currency_status)) THEN
    RAISE EXCEPTION 'currency update is immutable or outside its exact status command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER currencies_protect
  BEFORE INSERT OR UPDATE OR DELETE ON currencies
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_currency();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_wallet()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  command_type := public.worldgraph_economy_open_command_type(COALESCE(NEW.world_id, OLD.world_id));
  IF TG_OP = 'INSERT' THEN
    IF command_type IS DISTINCT FROM 'InitializeWorldEconomyV1'
      OR NEW.status <> 'active'::wallet_status OR NEW.row_version <> 1
      OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'wallet creation requires economy initialization'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF command_type IS NULL OR command_type NOT IN ('FreezeWalletV1','UnfreezeWalletV1')
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.currency_id IS DISTINCT FROM OLD.currency_id
    OR NEW.stable_key IS DISTINCT FROM OLD.stable_key
    OR NEW.owner_entity_id IS DISTINCT FROM OLD.owner_entity_id
    OR NEW.wallet_kind IS DISTINCT FROM OLD.wallet_kind
    OR NEW.wallet_schema_version IS DISTINCT FROM OLD.wallet_schema_version
    OR NEW.created_event_id IS DISTINCT FROM OLD.created_event_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
    OR NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at
    OR (command_type = 'FreezeWalletV1' AND NOT (
      OLD.status = 'active'::wallet_status AND NEW.status = 'frozen'::wallet_status))
    OR (command_type = 'UnfreezeWalletV1' AND NOT (
      OLD.status = 'frozen'::wallet_status AND NEW.status = 'active'::wallet_status)) THEN
    RAISE EXCEPTION 'wallet update is immutable or outside its exact status command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER wallets_protect
  BEFORE INSERT OR UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_wallet();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_economy_projection_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_world_id uuid := COALESCE(NEW.world_id, OLD.world_id);
  command_type text;
  cap_value bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% projection rows cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  command_type := public.worldgraph_economy_open_command_type(checked_world_id);
  IF TG_OP = 'INSERT' THEN
    IF command_type IS DISTINCT FROM 'InitializeWorldEconomyV1'
      OR NEW.row_version <> 1 OR NEW.updated_state_revision <= 0 THEN
      RAISE EXCEPTION '% creation requires economy initialization', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'currency_supply' THEN
    IF command_type IS NULL OR command_type NOT IN ('IssueCurrencyV1','RepairWorldEconomyV1')
      OR NEW.currency_id IS DISTINCT FROM OLD.currency_id
      OR NEW.world_id IS DISTINCT FROM OLD.world_id
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.updated_state_revision <= OLD.updated_state_revision
      OR (command_type = 'IssueCurrencyV1'
        AND NEW.current_supply_minor <= OLD.current_supply_minor)
      OR (command_type = 'RepairWorldEconomyV1'
        AND NEW.current_supply_minor >= OLD.current_supply_minor)
      OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'currency supply update is inconsistent or outside issuance'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF command_type IS NULL OR command_type NOT IN (
      'TransferCurrencyV1','IssueCurrencyV1','AcceptAssetTransferOfferV1',
      'RepairWorldEconomyV1'
    )
      OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
      OR NEW.world_id IS DISTINCT FROM OLD.world_id
      OR NEW.currency_id IS DISTINCT FROM OLD.currency_id
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.updated_state_revision <= OLD.updated_state_revision
      OR NEW.available_minor = OLD.available_minor
      OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'wallet balance update is inconsistent or outside a financial command'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'currency_supply' THEN
    SELECT currency.max_supply_minor INTO cap_value
    FROM public.currencies currency
    WHERE currency.world_id = NEW.world_id AND currency.id = NEW.currency_id;
    IF NOT FOUND OR (cap_value IS NOT NULL AND NEW.current_supply_minor > cap_value) THEN
      RAISE EXCEPTION 'currency supply exceeds its configured cap'
        USING ERRCODE = '23514', CONSTRAINT = 'currency_supply_within_cap';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER currency_supply_protect
  BEFORE INSERT OR UPDATE OR DELETE ON currency_supply
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_projection_row();
--> statement-breakpoint
CREATE TRIGGER wallet_balances_protect
  BEFORE INSERT OR UPDATE OR DELETE ON wallet_balances
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_projection_row();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_asset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'asset identity and typed metadata are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF public.worldgraph_economy_open_command_type(NEW.world_id)
      IS DISTINCT FROM 'InitializeWorldEconomyV1'
    OR NEW.status <> 'active'::asset_status OR NEW.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'asset creation requires economy initialization'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER assets_protect
  BEFORE INSERT OR UPDATE OR DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_asset();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_asset_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset ownership projection rows cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  command_type := public.worldgraph_economy_open_command_type(COALESCE(NEW.world_id, OLD.world_id));
  IF TG_OP = 'INSERT' THEN
    IF command_type IS DISTINCT FROM 'InitializeWorldEconomyV1'
      OR NEW.ownership_version <> 1 OR NEW.updated_state_revision <= 0 THEN
      RAISE EXCEPTION 'initial ownership requires economy initialization'
        USING ERRCODE = '55000';
    END IF;
  ELSIF command_type IS NULL
    OR command_type NOT IN (
      'TransferAssetV1','AcceptAssetTransferOfferV1','RepairWorldEconomyV1'
    )
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.owner_entity_id IS NOT DISTINCT FROM OLD.owner_entity_id
    OR NEW.ownership_version <> OLD.ownership_version + 1
    OR NEW.updated_state_revision <= OLD.updated_state_revision
    OR NEW.acquired_event_id IS NOT DISTINCT FROM OLD.acquired_event_id
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'asset ownership update is inconsistent or outside a title command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER asset_ownership_protect
  BEFORE INSERT OR UPDATE OR DELETE ON asset_ownership
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_asset_ownership();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_economy_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_world_id uuid := COALESCE(NEW.world_id, OLD.world_id);
  command_id_value uuid;
  command_type text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  command_type := public.worldgraph_economy_open_command_type(checked_world_id);
  IF TG_TABLE_NAME = 'financial_transactions' THEN
    command_id_value := NEW.command_id;
    IF command_type IS NULL OR command_type NOT IN (
      'InitializeWorldEconomyV1','TransferCurrencyV1','IssueCurrencyV1',
      'AcceptAssetTransferOfferV1','RepairWorldEconomyV1'
    ) OR command_id_value IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id', true), '')::uuid THEN
      RAISE EXCEPTION 'financial transaction requires its exact open economy command'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'wallet_postings' THEN
    IF command_type IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.financial_transactions transaction
      WHERE transaction.id = NEW.transaction_id
        AND transaction.world_id = NEW.world_id
        AND transaction.currency_id = NEW.currency_id
        AND transaction.command_id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    ) THEN
      RAISE EXCEPTION 'wallet posting requires its open command transaction'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'asset_transfers' THEN
    IF command_type IS NULL OR command_type NOT IN (
      'InitializeWorldEconomyV1','TransferAssetV1','AcceptAssetTransferOfferV1',
      'RepairWorldEconomyV1'
    ) OR NEW.command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id', true), '')::uuid THEN
      RAISE EXCEPTION 'asset transfer requires its exact open title command'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'economy_reconciliation_runs' THEN
    IF command_type IS DISTINCT FROM 'ReconcileWorldEconomyV1'
      OR NEW.command_id IS DISTINCT FROM
        NULLIF(current_setting('worldgraph.command_id', true), '')::uuid THEN
      RAISE EXCEPTION 'reconciliation run requires its exact open command'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'economy_participant_history' THEN
    IF command_type IS NULL OR command_type NOT IN (
      'InitializeWorldEconomyV1','TransferCurrencyV1','IssueCurrencyV1',
      'FreezeCurrencyV1','UnfreezeCurrencyV1','FreezeWalletV1','UnfreezeWalletV1',
      'TransferAssetV1','CreateAssetTransferOfferV1','CancelAssetTransferOfferV1',
      'AcceptAssetTransferOfferV1','ExpireAssetTransferOfferV1','ReconcileWorldEconomyV1',
      'RepairWorldEconomyV1'
    ) OR NEW.command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id', true), '')::uuid THEN
      RAISE EXCEPTION 'participant history requires its exact open economy command'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER financial_transactions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON financial_transactions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_fact();
--> statement-breakpoint
CREATE TRIGGER wallet_postings_protect
  BEFORE INSERT OR UPDATE OR DELETE ON wallet_postings
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_fact();
--> statement-breakpoint
CREATE TRIGGER asset_transfers_protect
  BEFORE INSERT OR UPDATE OR DELETE ON asset_transfers
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_fact();
--> statement-breakpoint
CREATE TRIGGER economy_reconciliation_runs_protect
  BEFORE INSERT OR UPDATE OR DELETE ON economy_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_fact();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_reconciliation_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' OR NOT EXISTS (
    SELECT 1 FROM public.economy_reconciliation_runs run
    WHERE run.id = NEW.run_id
      AND run.command_id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
      AND public.worldgraph_economy_open_command_type(run.world_id) = 'ReconcileWorldEconomyV1'
  ) THEN
    RAISE EXCEPTION 'reconciliation items are append-only command evidence'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER economy_reconciliation_items_protect
  BEFORE INSERT OR UPDATE OR DELETE ON economy_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_reconciliation_item();
--> statement-breakpoint
CREATE TRIGGER economy_participant_history_protect
  BEFORE INSERT OR UPDATE OR DELETE ON economy_participant_history
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_fact();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_participant_history()
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
    OR NOT EXISTS (
      SELECT 1
      FROM public.world_memberships membership
      JOIN public.world_entity_controllers controller
        ON controller.world_id = membership.world_id
       AND controller.user_id = membership.user_id
       AND controller.entity_id = history_record.participant_entity_id
       AND controller.revoked_at IS NULL
      WHERE membership.world_id = history_record.world_id
        AND membership.user_id = history_record.user_id
        AND membership.status = 'active'::membership_status
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
CREATE CONSTRAINT TRIGGER economy_participant_history_require_exact_binding
  AFTER INSERT ON economy_participant_history
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_economy_participant_history();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_economy_participant_history() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_asset_transfer_offer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset transfer offers cannot be deleted' USING ERRCODE = '55000';
  END IF;
  command_type := public.worldgraph_economy_open_command_type(COALESCE(NEW.world_id, OLD.world_id));
  IF TG_OP = 'INSERT' THEN
    IF command_type IS DISTINCT FROM 'CreateAssetTransferOfferV1'
      OR NEW.created_command_id IS DISTINCT FROM
        NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
      OR NEW.status <> 'open'::asset_transfer_offer_status OR NEW.row_version <> 1
      OR NEW.terminal_command_id IS NOT NULL OR NEW.terminal_event_id IS NOT NULL
      OR NEW.terminal_state_revision IS NOT NULL THEN
      RAISE EXCEPTION 'offer creation requires its exact open command'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open'::asset_transfer_offer_status
    OR command_type IS NULL OR command_type NOT IN (
      'CancelAssetTransferOfferV1','AcceptAssetTransferOfferV1','ExpireAssetTransferOfferV1'
    )
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.seller_entity_id IS DISTINCT FROM OLD.seller_entity_id
    OR NEW.buyer_entity_id IS DISTINCT FROM OLD.buyer_entity_id
    OR NEW.currency_id IS DISTINCT FROM OLD.currency_id
    OR NEW.seller_wallet_id IS DISTINCT FROM OLD.seller_wallet_id
    OR NEW.price_minor IS DISTINCT FROM OLD.price_minor
    OR NEW.expires_at_tick IS DISTINCT FROM OLD.expires_at_tick
    OR NEW.created_at_tick IS DISTINCT FROM OLD.created_at_tick
    OR NEW.created_command_id IS DISTINCT FROM OLD.created_command_id
    OR NEW.created_event_id IS DISTINCT FROM OLD.created_event_id
    OR NEW.created_state_revision IS DISTINCT FROM OLD.created_state_revision
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.terminal_state_revision <= OLD.created_state_revision
    OR NEW.terminal_command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    OR NEW.updated_at < OLD.updated_at
    OR (command_type = 'CancelAssetTransferOfferV1' AND NOT (
      NEW.status = 'cancelled'::asset_transfer_offer_status
      AND NEW.accepted_financial_transaction_id IS NULL
      AND NEW.accepted_asset_transfer_id IS NULL))
    OR (command_type = 'ExpireAssetTransferOfferV1' AND NOT (
      NEW.status = 'expired'::asset_transfer_offer_status
      AND NEW.accepted_financial_transaction_id IS NULL
      AND NEW.accepted_asset_transfer_id IS NULL
      AND EXISTS (
        SELECT 1 FROM public.world_simulation_clocks clock
        WHERE clock.world_id = NEW.world_id AND clock.current_tick >= NEW.expires_at_tick
      )))
    OR (command_type = 'AcceptAssetTransferOfferV1' AND NOT (
      NEW.status = 'accepted'::asset_transfer_offer_status
      AND NEW.accepted_financial_transaction_id IS NOT NULL
      AND NEW.accepted_asset_transfer_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.world_simulation_clocks clock
        WHERE clock.world_id = NEW.world_id AND clock.current_tick < NEW.expires_at_tick
      ))) THEN
    RAISE EXCEPTION 'offer terminal transition is immutable or outside its exact command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER asset_transfer_offers_protect
  BEFORE INSERT OR UPDATE OR DELETE ON asset_transfer_offers
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_asset_transfer_offer();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_world_economy_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world economy heads cannot be deleted' USING ERRCODE = '55000';
  END IF;
  command_type := public.worldgraph_economy_open_command_type(COALESCE(NEW.world_id, OLD.world_id));
  IF TG_OP = 'INSERT' THEN
    IF command_type IS DISTINCT FROM 'InitializeWorldEconomyV1'
      OR NEW.initialized_command_id IS DISTINCT FROM
        NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
      OR NEW.row_version <> 1 OR NEW.updated_state_revision <= 0
      OR NEW.checksum IS DISTINCT FROM public.worldgraph_economy_initial_projection_checksum(
        NEW.world_id, NEW.source_world_version_id, NEW.seed_plan_hash
      ) THEN
      RAISE EXCEPTION 'economy head creation requires exact initialized projection'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF command_type IS NULL OR command_type NOT IN (
      'TransferCurrencyV1','IssueCurrencyV1','FreezeCurrencyV1','UnfreezeCurrencyV1',
      'FreezeWalletV1','UnfreezeWalletV1','TransferAssetV1',
      'CreateAssetTransferOfferV1','CancelAssetTransferOfferV1',
      'AcceptAssetTransferOfferV1','ExpireAssetTransferOfferV1','ReconcileWorldEconomyV1',
      'RepairWorldEconomyV1'
    )
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.economy_schema_version IS DISTINCT FROM OLD.economy_schema_version
    OR NEW.source_world_version_id IS DISTINCT FROM OLD.source_world_version_id
    OR NEW.seed_plan_hash IS DISTINCT FROM OLD.seed_plan_hash
    OR NEW.initialized_command_id IS DISTINCT FROM OLD.initialized_command_id
    OR NEW.initialized_event_id IS DISTINCT FROM OLD.initialized_event_id
    OR NEW.initialized_at IS DISTINCT FROM OLD.initialized_at
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.updated_state_revision <= OLD.updated_state_revision
    OR NEW.updated_at < OLD.updated_at
    OR NEW.checksum IS DISTINCT FROM
      public.worldgraph_economy_projection_checksum(NEW.world_id)
    OR (command_type IS DISTINCT FROM 'ReconcileWorldEconomyV1' AND NOT (
      NEW.reconciliation_status = 'pending'::economy_reconciliation_status
      AND NEW.last_reconciled_state_revision IS NULL
      AND NEW.last_reconciliation_run_id IS NULL
    ))
    OR (command_type = 'ReconcileWorldEconomyV1' AND NOT (
      NEW.reconciliation_status IN (
        'current'::economy_reconciliation_status,
        'mismatch'::economy_reconciliation_status
      )
      AND NEW.last_reconciled_state_revision IS NOT NULL
      AND NEW.last_reconciliation_run_id IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'economy head update is inconsistent or outside an economy command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_economy_heads_protect
  BEFORE INSERT OR UPDATE OR DELETE ON world_economy_heads
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_world_economy_head();
--> statement-breakpoint
CREATE FUNCTION worldgraph_record_economy_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_id uuid := NULLIF(current_setting('worldgraph.command_id', true), '')::uuid;
  checked_world_id uuid := NEW.world_id;
  checked_target_id uuid;
  checked_kind text;
BEGIN
  IF TG_OP NOT IN ('INSERT','UPDATE')
    OR NOT public.worldgraph_command_write_is_open(checked_world_id, checked_command_id) THEN
    RAISE EXCEPTION 'economy mutation provenance requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  checked_kind := CASE TG_TABLE_NAME
    WHEN 'currencies' THEN 'currency'
    WHEN 'currency_supply' THEN 'currency_supply'
    WHEN 'wallets' THEN 'wallet'
    WHEN 'wallet_balances' THEN 'wallet_balance'
    WHEN 'assets' THEN 'asset'
    WHEN 'asset_ownership' THEN 'asset_ownership'
    WHEN 'asset_transfer_offers' THEN 'asset_transfer_offer'
    WHEN 'world_economy_heads' THEN 'economy_head'
  END;
  checked_target_id := CASE TG_TABLE_NAME
    WHEN 'currencies' THEN (to_jsonb(NEW) ->> 'id')::uuid
    WHEN 'currency_supply' THEN (to_jsonb(NEW) ->> 'currency_id')::uuid
    WHEN 'wallets' THEN (to_jsonb(NEW) ->> 'id')::uuid
    WHEN 'wallet_balances' THEN (to_jsonb(NEW) ->> 'wallet_id')::uuid
    WHEN 'assets' THEN (to_jsonb(NEW) ->> 'id')::uuid
    WHEN 'asset_ownership' THEN (to_jsonb(NEW) ->> 'asset_id')::uuid
    WHEN 'asset_transfer_offers' THEN (to_jsonb(NEW) ->> 'id')::uuid
    WHEN 'world_economy_heads' THEN (to_jsonb(NEW) ->> 'world_id')::uuid
  END;
  IF checked_kind IS NULL OR checked_target_id IS NULL THEN
    RAISE EXCEPTION 'unsupported economy mutation provenance target'
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.economy_command_mutations(
    command_id, world_id, mutation_kind, target_id, operation
  ) VALUES (
    checked_command_id, checked_world_id, checked_kind, checked_target_id, lower(TG_OP)
  );
  RETURN NULL;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'an economy command may mutate each authoritative row at most once'
      USING ERRCODE = '55000';
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_record_economy_command_mutation() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER currencies_record_command_mutation
  AFTER INSERT OR UPDATE ON currencies
  FOR EACH ROW EXECUTE FUNCTION worldgraph_record_economy_command_mutation();
--> statement-breakpoint
CREATE TRIGGER currency_supply_record_command_mutation
  AFTER INSERT OR UPDATE ON currency_supply
  FOR EACH ROW EXECUTE FUNCTION worldgraph_record_economy_command_mutation();
--> statement-breakpoint
CREATE TRIGGER wallets_record_command_mutation
  AFTER INSERT OR UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION worldgraph_record_economy_command_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_balances_record_command_mutation
  AFTER INSERT OR UPDATE ON wallet_balances
  FOR EACH ROW EXECUTE FUNCTION worldgraph_record_economy_command_mutation();
--> statement-breakpoint
CREATE TRIGGER assets_record_command_mutation
  AFTER INSERT ON assets
  FOR EACH ROW EXECUTE FUNCTION worldgraph_record_economy_command_mutation();
--> statement-breakpoint
CREATE TRIGGER asset_ownership_record_command_mutation
  AFTER INSERT OR UPDATE ON asset_ownership
  FOR EACH ROW EXECUTE FUNCTION worldgraph_record_economy_command_mutation();
--> statement-breakpoint
CREATE TRIGGER asset_transfer_offers_record_command_mutation
  AFTER INSERT OR UPDATE ON asset_transfer_offers
  FOR EACH ROW EXECUTE FUNCTION worldgraph_record_economy_command_mutation();
--> statement-breakpoint
CREATE TRIGGER world_economy_heads_record_command_mutation
  AFTER INSERT OR UPDATE ON world_economy_heads
  FOR EACH ROW EXECUTE FUNCTION worldgraph_record_economy_command_mutation();
--> statement-breakpoint
CREATE FUNCTION worldgraph_currency_issuance_override_is_valid(
  checked_command_id uuid,
  checked_currency_id uuid,
  checked_reason text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN EXISTS (
  SELECT 1
  FROM public.command_records command
  JOIN public.creator_override_records override
    ON override.id = command.override_id
   AND override.command_id = command.id
   AND override.world_id = command.world_id
  WHERE command.id = checked_command_id
    AND command.command_type = 'IssueCurrencyV1'
    AND command.actor_type = 'user'::command_actor_type
    AND override.actor_user_id::text = command.actor_id
    AND command.authorization_rule_id = 'economy.creator_explicit_issuance_override'
    AND override.action = 'economy.currency.issue'
    AND override.target_type = 'currency'
    AND override.target_id = checked_currency_id
    AND override.reason IS NOT DISTINCT FROM checked_reason
    AND override.authority_rule_id = 'economy.creator_explicit_issuance_override'
    AND override.authority_rule_id = command.authorization_rule_id
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_currency_issuance_override_is_valid(uuid,uuid,text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_financial_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  transaction_record record;
  posting_count integer;
  posting_sum numeric;
  command_type text;
BEGIN
  SELECT transaction.* INTO transaction_record
  FROM public.financial_transactions transaction WHERE transaction.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(sum(posting.signed_amount_minor), 0)
    INTO posting_count, posting_sum
    FROM public.wallet_postings posting
   WHERE posting.transaction_id = transaction_record.id;
  SELECT command.command_type INTO command_type
  FROM public.command_records command
  WHERE command.id = transaction_record.command_id
    AND command.world_id = transaction_record.world_id
    AND command.status = 'accepted'::command_record_status
    AND command.resulting_state_revision = transaction_record.state_revision;
  IF NOT FOUND OR posting_count NOT BETWEEN 1 AND 101
    OR posting_sum <> transaction_record.supply_delta_minor::numeric
    OR NOT EXISTS (
      SELECT 1 FROM public.wallet_postings posting
      WHERE posting.transaction_id = transaction_record.id
      HAVING min(posting.posting_ordinal) = 0
        AND max(posting.posting_ordinal) = count(*) - 1
        AND count(DISTINCT posting.wallet_id) = count(*)
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.domain_events event
      WHERE event.id = transaction_record.event_id
        AND event.world_id = transaction_record.world_id
        AND event.command_id = transaction_record.command_id
        AND event.resulting_state_revision = transaction_record.state_revision
        AND event.event_type = CASE command_type
          WHEN 'InitializeWorldEconomyV1' THEN 'WorldEconomyInitializedV1'
          WHEN 'IssueCurrencyV1' THEN 'CurrencyIssuedV1'
          WHEN 'TransferCurrencyV1' THEN 'CurrencyTransferredV1'
          WHEN 'AcceptAssetTransferOfferV1' THEN 'CurrencyTransferredV1'
          WHEN 'RepairWorldEconomyV1' THEN 'WorldEconomyRepairedV1'
        END
    )
    OR (command_type = 'InitializeWorldEconomyV1' AND NOT (
      transaction_record.transaction_kind = 'initialization'::financial_transaction_kind
      AND transaction_record.supply_delta_minor > 0))
    OR (command_type = 'IssueCurrencyV1' AND NOT (
      transaction_record.transaction_kind = 'issuance'::financial_transaction_kind
      AND transaction_record.supply_delta_minor > 0 AND posting_count = 1
      AND transaction_record.memo_text IS NOT NULL
      AND public.worldgraph_currency_issuance_override_is_valid(
        transaction_record.command_id,
        transaction_record.currency_id,
        transaction_record.memo_text
      )
      AND EXISTS (
        SELECT 1
        FROM public.wallet_postings posting
        JOIN public.wallets wallet
          ON wallet.world_id = posting.world_id
         AND wallet.currency_id = posting.currency_id
         AND wallet.id = posting.wallet_id
        JOIN public.currencies currency
          ON currency.world_id = posting.world_id
         AND currency.id = posting.currency_id
        WHERE posting.transaction_id = transaction_record.id
          AND posting.signed_amount_minor > 0
          AND wallet.wallet_kind = 'treasury'::wallet_kind
          AND wallet.status = 'active'::wallet_status
          AND wallet.owner_entity_id = currency.issuer_entity_id
      )))
    OR (command_type = 'TransferCurrencyV1' AND NOT (
      transaction_record.transaction_kind = 'transfer'::financial_transaction_kind
      AND transaction_record.supply_delta_minor = 0 AND posting_count = 2))
    OR (command_type = 'AcceptAssetTransferOfferV1' AND NOT (
      transaction_record.transaction_kind = 'asset_purchase'::financial_transaction_kind
      AND transaction_record.supply_delta_minor = 0 AND posting_count = 2))
    OR (command_type = 'RepairWorldEconomyV1' AND NOT (
      transaction_record.transaction_kind = 'compensation'::financial_transaction_kind
      AND transaction_record.reversal_of_transaction_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.economy_repair_plans plan
        JOIN public.economy_repair_executions execution
          ON execution.repair_plan_id = plan.id AND execution.world_id = plan.world_id
        JOIN public.financial_transactions source
          ON source.world_id = plan.world_id
         AND source.id = plan.source_financial_transaction_id
        WHERE execution.command_id = transaction_record.command_id
          AND execution.financial_transaction_id = transaction_record.id
          AND plan.compensation_transaction_id = transaction_record.id
          AND transaction_record.reversal_of_transaction_id = source.id
          AND transaction_record.currency_id = source.currency_id
          AND transaction_record.supply_delta_minor = -source.supply_delta_minor
          AND NOT EXISTS (
            (SELECT posting.posting_ordinal, posting.wallet_id,
                    posting.signed_amount_minor
             FROM public.wallet_postings posting
             WHERE posting.transaction_id = transaction_record.id
             EXCEPT
             SELECT posting.posting_ordinal, posting.wallet_id,
                    -posting.signed_amount_minor
             FROM public.wallet_postings posting
             WHERE posting.transaction_id = source.id)
            UNION ALL
            (SELECT posting.posting_ordinal, posting.wallet_id,
                    -posting.signed_amount_minor
             FROM public.wallet_postings posting
             WHERE posting.transaction_id = source.id
             EXCEPT
             SELECT posting.posting_ordinal, posting.wallet_id,
                    posting.signed_amount_minor
             FROM public.wallet_postings posting
             WHERE posting.transaction_id = transaction_record.id)
          )
      )))
    OR command_type NOT IN (
      'InitializeWorldEconomyV1','IssueCurrencyV1','TransferCurrencyV1',
      'AcceptAssetTransferOfferV1','RepairWorldEconomyV1'
    ) THEN
    RAISE EXCEPTION 'financial transaction is unbalanced or lacks its exact command/event'
      USING ERRCODE = '23514', CONSTRAINT = 'financial_transaction_balanced';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.wallet_balances balance
    JOIN public.wallets wallet
      ON wallet.world_id = balance.world_id AND wallet.id = balance.wallet_id
    WHERE balance.world_id = transaction_record.world_id
      AND balance.currency_id = transaction_record.currency_id
      AND balance.available_minor::numeric IS DISTINCT FROM COALESCE((
        SELECT sum(posting.signed_amount_minor)
        FROM public.wallet_postings posting
        WHERE posting.world_id = balance.world_id
          AND posting.currency_id = balance.currency_id
          AND posting.wallet_id = balance.wallet_id
      ), 0)
  ) OR EXISTS (
    SELECT 1
    FROM public.currency_supply supply
    JOIN public.currencies currency
      ON currency.world_id = supply.world_id AND currency.id = supply.currency_id
    WHERE supply.world_id = transaction_record.world_id
      AND supply.currency_id = transaction_record.currency_id
      AND (
        supply.current_supply_minor::numeric IS DISTINCT FROM COALESCE((
          SELECT sum(financial.supply_delta_minor)
          FROM public.financial_transactions financial
          WHERE financial.world_id = supply.world_id
            AND financial.currency_id = supply.currency_id
        ), 0)
        OR (currency.max_supply_minor IS NOT NULL
          AND supply.current_supply_minor > currency.max_supply_minor)
      )
  ) OR NOT EXISTS (
    SELECT 1 FROM public.currency_supply supply
    WHERE supply.world_id = transaction_record.world_id
      AND supply.currency_id = transaction_record.currency_id
  ) THEN
    RAISE EXCEPTION 'wallet or supply projection does not equal the immutable journal'
      USING ERRCODE = '23514', CONSTRAINT = 'economy_projection_equals_journal';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER financial_transactions_require_balanced_projection
  AFTER INSERT ON financial_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_financial_transaction();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_asset_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  transfer_record record;
  latest_record record;
  transfer_count bigint;
BEGIN
  SELECT transfer.* INTO transfer_record
  FROM public.asset_transfers transfer WHERE transfer.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT transfer.*, count(*) OVER (PARTITION BY transfer.asset_id)
    INTO latest_record
    FROM public.asset_transfers transfer
   WHERE transfer.world_id = transfer_record.world_id
     AND transfer.asset_id = transfer_record.asset_id
   ORDER BY transfer.state_revision DESC, transfer.created_at DESC, transfer.id DESC
   LIMIT 1;
  transfer_count := latest_record.count;
  IF NOT EXISTS (
      SELECT 1
      FROM public.command_records command
      JOIN public.domain_events event
        ON event.world_id = command.world_id AND event.command_id = command.id
      WHERE command.id = transfer_record.command_id
        AND command.world_id = transfer_record.world_id
        AND command.status = 'accepted'::command_record_status
        AND command.resulting_state_revision = transfer_record.state_revision
        AND event.id = transfer_record.event_id
        AND event.resulting_state_revision = transfer_record.state_revision
        AND (
          (transfer_record.transfer_kind = 'initial'::asset_transfer_kind
            AND command.command_type = 'InitializeWorldEconomyV1'
            AND event.event_type = 'WorldEconomyInitializedV1')
          OR (transfer_record.transfer_kind = 'grant'::asset_transfer_kind
            AND command.command_type = 'TransferAssetV1'
            AND event.event_type = 'AssetOwnershipTransferredV1')
          OR (transfer_record.transfer_kind = 'purchase'::asset_transfer_kind
            AND command.command_type = 'AcceptAssetTransferOfferV1'
            AND event.event_type = 'AssetOwnershipTransferredV1')
          OR (transfer_record.transfer_kind = 'compensation'::asset_transfer_kind
            AND command.command_type = 'RepairWorldEconomyV1'
            AND event.event_type = 'WorldEconomyRepairedV1')
        )
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.asset_ownership ownership
      WHERE ownership.world_id = transfer_record.world_id
        AND ownership.asset_id = transfer_record.asset_id
        AND ownership.owner_entity_id = latest_record.to_owner_entity_id
        AND ownership.ownership_version = transfer_count
        AND ownership.acquired_event_id = latest_record.event_id
        AND ownership.updated_state_revision = latest_record.state_revision
    ) OR (transfer_record.transfer_kind <> 'initial'::asset_transfer_kind AND NOT EXISTS (
      SELECT 1 FROM public.assets asset
      WHERE asset.world_id = transfer_record.world_id AND asset.id = transfer_record.asset_id
        AND asset.status = 'active'::asset_status AND asset.transferable
    )) OR (transfer_record.transfer_kind = 'purchase'::asset_transfer_kind AND NOT EXISTS (
      SELECT 1 FROM public.financial_transactions transaction
      WHERE transaction.id = transfer_record.financial_transaction_id
        AND transaction.world_id = transfer_record.world_id
        AND transaction.command_id = transfer_record.command_id
        AND transaction.transaction_kind = 'asset_purchase'::financial_transaction_kind
        AND transaction.supply_delta_minor = 0
        AND transaction.state_revision = transfer_record.state_revision
    )) OR (transfer_record.transfer_kind = 'compensation'::asset_transfer_kind AND NOT EXISTS (
      SELECT 1
      FROM public.economy_repair_plans plan
      JOIN public.economy_repair_executions execution
        ON execution.repair_plan_id = plan.id AND execution.world_id = plan.world_id
      JOIN public.asset_transfers source
        ON source.world_id = plan.world_id AND source.id = plan.source_asset_transfer_id
      WHERE execution.command_id = transfer_record.command_id
        AND execution.asset_transfer_id = transfer_record.id
        AND plan.compensation_transfer_id = transfer_record.id
        AND transfer_record.reversal_of_transfer_id = source.id
        AND transfer_record.asset_id = source.asset_id
        AND transfer_record.from_owner_entity_id = source.to_owner_entity_id
        AND transfer_record.to_owner_entity_id = source.from_owner_entity_id
        AND transfer_record.financial_transaction_id IS NULL
    )) THEN
    RAISE EXCEPTION 'asset transfer does not rebuild to its exact current owner/event'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_transfer_projection_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER asset_transfers_require_current_ownership
  AFTER INSERT ON asset_transfers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_asset_transfer();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_native_economy_plan_activation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE checked_run_id uuid;
BEGIN
  checked_run_id := CASE TG_TABLE_NAME
    WHEN 'world_compilation_runs' THEN NEW.id
    ELSE (to_jsonb(NEW) ->> 'compilation_run_id')::uuid
  END;
  IF EXISTS (
    SELECT 1 FROM public.world_compilation_runs run
    WHERE run.id = checked_run_id AND run.compiler_version = '1.1.0'
      AND run.status = 'succeeded'::world_compilation_status
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.world_compilation_runs run
    JOIN public.world_versions version
      ON version.compilation_run_id = run.id AND version.world_id = run.world_id
    JOIN public.compiled_world_artifacts artifact
      ON artifact.compilation_run_id = run.id AND artifact.world_id = run.world_id
     AND artifact.artifact_kind = 'compiled_world'
    JOIN public.compiled_economy_seed_plans plan
      ON plan.compilation_run_id = run.id AND plan.world_id = run.world_id
     AND plan.world_version_id = version.id AND plan.source_artifact_id = artifact.id
    WHERE run.id = checked_run_id
      AND version.compiler_version = '1.1.0'
      AND artifact.artifact_schema_version = 2
      AND plan.source_kind = 'compiler_1_1'::economy_seed_plan_source
      AND plan.plan_hash = decode(artifact.canonical_content ->> 'economySeedPlanHash', 'hex')
      AND plan.canonical_plan = artifact.canonical_content -> 'economySeedPlan'
      AND plan.source_artifact_hash = artifact.content_hash
  ) THEN
    RAISE EXCEPTION 'compiler 1.1 activation requires its exact native economy seed plan'
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'world_versions' AND (to_jsonb(NEW) ->> 'compiler_version') = '1.1.0'
    AND (to_jsonb(NEW) ->> 'status') = 'active' AND NOT EXISTS (
      SELECT 1 FROM public.compiled_economy_seed_plans plan
      WHERE plan.world_id = NEW.world_id AND plan.world_version_id = NEW.id
        AND plan.source_kind = 'compiler_1_1'::economy_seed_plan_source
        AND plan.plan_hash = (
          SELECT decode(artifact.canonical_content ->> 'economySeedPlanHash', 'hex')
          FROM public.compiled_world_artifacts artifact
          WHERE artifact.compilation_run_id = checked_run_id
            AND artifact.artifact_kind = 'compiled_world'
        )
    ) THEN
    RAISE EXCEPTION 'compiler 1.1 world version cannot activate without its native economy plan'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_compilation_runs_require_native_economy_plan
  AFTER INSERT OR UPDATE ON world_compilation_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_native_economy_plan_activation();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_versions_require_native_economy_plan
  AFTER INSERT OR UPDATE ON world_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_native_economy_plan_activation();
--> statement-breakpoint
CREATE FUNCTION worldgraph_materialized_economy_seed_plan(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN jsonb_build_object(
  'assets', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'assetSchemaVersion', asset.asset_schema_version,
      'assetType', asset.asset_type,
      'initialOwnerEntityLogicalKey', owner.logical_key::text,
      'metadata', asset.metadata,
      'stableKey', asset.stable_key::text,
      'transferable', asset.transferable,
      'worldEntityLogicalKey', world_entity.logical_key::text
    ) ORDER BY asset.stable_key::text COLLATE "C")
    FROM public.assets asset
    JOIN public.asset_ownership ownership
      ON ownership.world_id = asset.world_id AND ownership.asset_id = asset.id
    JOIN public.world_entities owner
      ON owner.world_id = ownership.world_id AND owner.id = ownership.owner_entity_id
    LEFT JOIN public.world_entities world_entity
      ON world_entity.world_id = asset.world_id AND world_entity.id = asset.world_entity_id
    WHERE asset.world_id = checked_world_id
  ), '[]'::jsonb),
  'currency', (
    SELECT jsonb_build_object(
      'cashOutAllowed', false,
      'code', currency.code::text,
      'currencySchemaVersion', currency.currency_schema_version,
      'issuerEntityLogicalKey', issuer.logical_key::text,
      'maxSupplyMinor', currency.max_supply_minor::text,
      'minorUnitScale', currency.minor_unit_scale,
      'name', currency.name,
      'noCashValue', true,
      'stableKey', currency.stable_key::text
    )
    FROM public.currencies currency
    JOIN public.world_entities issuer
      ON issuer.world_id = currency.world_id AND issuer.id = currency.issuer_entity_id
    WHERE currency.world_id = checked_world_id
  ),
  'economySeedPlanSchemaVersion', 1,
  'initialSupplyMinor', (
    SELECT supply.current_supply_minor::text
    FROM public.currency_supply supply WHERE supply.world_id = checked_world_id
  ),
  'wallets', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'initialBalanceMinor', balance.available_minor::text,
      'ownerEntityLogicalKey', owner.logical_key::text,
      'stableKey', wallet.stable_key::text,
      'walletKind', wallet.wallet_kind::text,
      'walletSchemaVersion', wallet.wallet_schema_version
    ) ORDER BY wallet.stable_key::text COLLATE "C")
    FROM public.wallets wallet
    JOIN public.wallet_balances balance
      ON balance.world_id = wallet.world_id AND balance.wallet_id = wallet.id
    JOIN public.world_entities owner
      ON owner.world_id = wallet.world_id AND owner.id = wallet.owner_entity_id
    WHERE wallet.world_id = checked_world_id
  ), '[]'::jsonb)
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_economy_domain_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE command_type text;
DECLARE event_allowed boolean;
BEGIN
  SELECT command.command_type INTO command_type
  FROM public.command_records command
  WHERE command.id = NEW.command_id AND command.world_id = NEW.world_id;
  event_allowed := CASE command_type
    WHEN 'AdoptLegacyEconomySeedPlanV1' THEN NEW.event_type = 'LegacyEconomySeedPlanAdoptedV1'
    WHEN 'InitializeWorldEconomyV1' THEN NEW.event_type = 'WorldEconomyInitializedV1'
    WHEN 'TransferCurrencyV1' THEN NEW.event_type = 'CurrencyTransferredV1'
    WHEN 'IssueCurrencyV1' THEN NEW.event_type = 'CurrencyIssuedV1'
    WHEN 'FreezeCurrencyV1' THEN NEW.event_type = 'CurrencyFrozenV1'
    WHEN 'UnfreezeCurrencyV1' THEN NEW.event_type = 'CurrencyUnfrozenV1'
    WHEN 'FreezeWalletV1' THEN NEW.event_type = 'WalletFrozenV1'
    WHEN 'UnfreezeWalletV1' THEN NEW.event_type = 'WalletUnfrozenV1'
    WHEN 'TransferAssetV1' THEN NEW.event_type = 'AssetOwnershipTransferredV1'
    WHEN 'CreateAssetTransferOfferV1' THEN NEW.event_type = 'AssetTransferOfferCreatedV1'
    WHEN 'CancelAssetTransferOfferV1' THEN NEW.event_type = 'AssetTransferOfferCancelledV1'
    WHEN 'ExpireAssetTransferOfferV1' THEN NEW.event_type = 'AssetTransferOfferExpiredV1'
    WHEN 'AcceptAssetTransferOfferV1' THEN NEW.event_type IN (
      'AssetPurchasedV1','CurrencyTransferredV1','AssetOwnershipTransferredV1',
      'AssetTransferOfferAcceptedV1'
    )
    WHEN 'ReconcileWorldEconomyV1' THEN NEW.event_type = 'WorldEconomyReconciledV1'
    WHEN 'RepairWorldEconomyV1' THEN NEW.event_type = 'WorldEconomyRepairedV1'
    ELSE false
  END;
  IF command_type IN (
      'AdoptLegacyEconomySeedPlanV1','InitializeWorldEconomyV1','TransferCurrencyV1',
      'IssueCurrencyV1','FreezeCurrencyV1','UnfreezeCurrencyV1','FreezeWalletV1',
      'UnfreezeWalletV1','TransferAssetV1','CreateAssetTransferOfferV1',
      'CancelAssetTransferOfferV1','AcceptAssetTransferOfferV1',
      'ExpireAssetTransferOfferV1','ReconcileWorldEconomyV1','RepairWorldEconomyV1'
    ) AND (NOT COALESCE(event_allowed, false)
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.command_id)) THEN
    RAISE EXCEPTION 'economy command emitted an unsupported or closed event fact'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.event_type IN (
      'LegacyEconomySeedPlanAdoptedV1','WorldEconomyInitializedV1',
      'WorldEconomyReconciledV1','CurrencyIssuedV1','CurrencyTransferredV1',
      'CurrencyFrozenV1','CurrencyUnfrozenV1','WalletFrozenV1','WalletUnfrozenV1',
      'AssetOwnershipTransferredV1','AssetTransferOfferCreatedV1',
      'AssetTransferOfferCancelledV1','AssetTransferOfferAcceptedV1',
      'AssetTransferOfferExpiredV1','AssetPurchasedV1','WorldEconomyRepairedV1'
    ) AND (NOT COALESCE(event_allowed, false)
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.command_id)) THEN
    RAISE EXCEPTION 'reserved economy event namespace requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER domain_events_protect_economy_namespace
  BEFORE INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_domain_event();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_domain_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_record record;
  head_record record;
  transaction_record record;
  transfer_record record;
  offer_record record;
  run_record record;
  repair_execution_record record;
  repair_plan_record record;
  negative_posting record;
  positive_posting record;
BEGIN
  SELECT command.* INTO command_record
  FROM public.command_records command
  WHERE command.id = NEW.command_id AND command.world_id = NEW.world_id
    AND command.status = 'accepted'::command_record_status
    AND command.resulting_state_revision = NEW.resulting_state_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy event requires its accepted command revision'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.event_type NOT IN (
      'LegacyEconomySeedPlanAdoptedV1','WorldEconomyInitializedV1',
      'WorldEconomyReconciledV1','CurrencyIssuedV1','CurrencyTransferredV1',
      'CurrencyFrozenV1','CurrencyUnfrozenV1','WalletFrozenV1','WalletUnfrozenV1',
      'AssetOwnershipTransferredV1','AssetTransferOfferCreatedV1',
      'AssetTransferOfferCancelledV1','AssetTransferOfferAcceptedV1',
      'AssetTransferOfferExpiredV1','AssetPurchasedV1','WorldEconomyRepairedV1'
    ) THEN RETURN NULL; END IF;

  CASE NEW.event_type
    WHEN 'LegacyEconomySeedPlanAdoptedV1' THEN
      IF command_record.command_type <> 'AdoptLegacyEconomySeedPlanV1'
        OR NEW.event_ordinal <> 0 OR NEW.aggregate_type <> 'economy_seed_plan'
        OR NOT EXISTS (
          SELECT 1 FROM public.compiled_economy_seed_plans plan
          WHERE plan.world_id = NEW.world_id AND plan.id::text = NEW.aggregate_id
            AND plan.source_kind = 'legacy_1_0_adapter'::economy_seed_plan_source
            AND plan.adopted_command_id = NEW.command_id
            AND plan.adopted_event_id = NEW.id
            AND NEW.payload = jsonb_build_object(
              'adapterId', plan.source_adapter_id,
              'adapterVersion', plan.source_adapter_version,
              'compiledWorldVersionId', plan.world_version_id::text,
              'legacyArtifactHash', encode(plan.source_artifact_hash, 'hex'),
              'legacyArtifactSchemaVersion', 1,
              'legacyCompilerVersion', plan.source_compiler_version,
              'seedPlanHash', encode(plan.plan_hash, 'hex')
            )
        ) THEN
        RAISE EXCEPTION 'legacy seed adoption event has no exact immutable plan fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WorldEconomyInitializedV1' THEN
      SELECT head.* INTO head_record FROM public.world_economy_heads head
      WHERE head.world_id = NEW.world_id;
      SELECT transaction.* INTO transaction_record
      FROM public.financial_transactions transaction
      WHERE transaction.world_id = NEW.world_id
        AND transaction.command_id = NEW.command_id
        AND transaction.transaction_kind = 'initialization'::financial_transaction_kind;
      IF command_record.command_type <> 'InitializeWorldEconomyV1'
        OR head_record.world_id IS NULL OR transaction_record.id IS NULL
        OR NEW.aggregate_type <> 'world_economy' OR NEW.aggregate_id <> NEW.world_id::text
        OR NEW.event_ordinal <> 0 OR NEW.aggregate_version <> 1
        OR head_record.initialized_command_id IS DISTINCT FROM NEW.command_id
        OR head_record.initialized_event_id IS DISTINCT FROM NEW.id
        OR head_record.updated_state_revision <> NEW.resulting_state_revision
        OR head_record.checksum IS DISTINCT FROM
          public.worldgraph_economy_projection_checksum(NEW.world_id)
        OR NOT EXISTS (
          SELECT 1 FROM public.compiled_economy_seed_plans plan
          WHERE plan.world_id = NEW.world_id
            AND plan.world_version_id = head_record.source_world_version_id
            AND plan.plan_hash = head_record.seed_plan_hash
            AND plan.canonical_plan = public.worldgraph_materialized_economy_seed_plan(NEW.world_id)
        )
        OR NEW.payload <> jsonb_build_object(
          'assetCount', (SELECT count(*)::text FROM public.assets WHERE world_id = NEW.world_id),
          'compiledWorldVersionId', head_record.source_world_version_id::text,
          'currencyId', transaction_record.currency_id::text,
          'initialSupplyMinor', transaction_record.supply_delta_minor::text,
          'initializationTransactionId', transaction_record.id::text,
          'ownershipCount', (SELECT count(*)::text FROM public.asset_ownership WHERE world_id = NEW.world_id),
          'seedPlanSchemaVersion', 1,
          'seedPlanHash', encode(head_record.seed_plan_hash, 'hex'),
          'walletCount', (SELECT count(*)::text FROM public.wallets WHERE world_id = NEW.world_id)
        )
        OR EXISTS (
          SELECT 1 FROM public.currencies currency
          WHERE currency.world_id = NEW.world_id
            AND (currency.created_event_id <> NEW.id OR currency.row_version <> 1
              OR currency.status <> 'active'::currency_status)
        ) OR EXISTS (
          SELECT 1 FROM public.wallets wallet
          WHERE wallet.world_id = NEW.world_id
            AND (wallet.created_event_id <> NEW.id OR wallet.row_version <> 1
              OR wallet.status <> 'active'::wallet_status)
        ) OR EXISTS (
          SELECT 1 FROM public.assets asset
          WHERE asset.world_id = NEW.world_id AND asset.created_event_id <> NEW.id
        ) OR EXISTS (
          SELECT 1 FROM public.asset_ownership ownership
          WHERE ownership.world_id = NEW.world_id
            AND (ownership.acquired_event_id <> NEW.id OR ownership.ownership_version <> 1)
        ) OR (SELECT count(*) FROM public.asset_transfers transfer
              WHERE transfer.world_id = NEW.world_id
                AND transfer.command_id = NEW.command_id
                AND transfer.event_id = NEW.id
                AND transfer.transfer_kind = 'initial'::asset_transfer_kind)
              <> (SELECT count(*) FROM public.assets WHERE world_id = NEW.world_id)
      THEN
        RAISE EXCEPTION 'economy initialization event does not exactly materialize its seed plan'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WorldEconomyReconciledV1' THEN
      SELECT run.* INTO run_record FROM public.economy_reconciliation_runs run
      WHERE run.world_id = NEW.world_id AND run.event_id = NEW.id
        AND run.command_id = NEW.command_id;
      SELECT head.* INTO head_record FROM public.world_economy_heads head
      WHERE head.world_id = NEW.world_id;
      IF command_record.command_type <> 'ReconcileWorldEconomyV1'
        OR NEW.aggregate_type <> 'world_economy' OR NEW.aggregate_id <> NEW.world_id::text
        OR NEW.event_ordinal <> 0
        OR run_record.id IS NULL OR head_record.world_id IS NULL
        OR head_record.last_reconciliation_run_id IS DISTINCT FROM run_record.id
        OR head_record.last_reconciled_state_revision IS DISTINCT FROM run_record.source_state_revision
        OR NEW.payload <> jsonb_build_object(
          'checkedStateRevision', run_record.source_state_revision::text,
          'liveProjectionChecksum', encode(run_record.live_projection_checksum, 'hex'),
          'mismatchCount', run_record.mismatch_count::text,
          'rebuiltJournalChecksum', encode(run_record.rebuilt_journal_checksum, 'hex'),
          'runId', run_record.id::text,
          'status', CASE run_record.status
            WHEN 'matched'::economy_reconciliation_run_status THEN 'matched'
            ELSE 'mismatched' END
        ) THEN
        RAISE EXCEPTION 'economy reconciliation event does not match immutable evidence'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'CurrencyIssuedV1' THEN
      SELECT transaction.* INTO transaction_record FROM public.financial_transactions transaction
      WHERE transaction.world_id = NEW.world_id AND transaction.event_id = NEW.id;
      SELECT posting.* INTO positive_posting FROM public.wallet_postings posting
      WHERE posting.transaction_id = transaction_record.id AND posting.signed_amount_minor > 0;
      IF command_record.command_type <> 'IssueCurrencyV1' OR transaction_record.id IS NULL
        OR positive_posting.id IS NULL
        OR NOT public.worldgraph_currency_issuance_override_is_valid(
          NEW.command_id,
          transaction_record.currency_id,
          transaction_record.memo_text
        )
        OR NOT EXISTS (
          SELECT 1
          FROM public.wallets wallet
          JOIN public.currencies currency
            ON currency.world_id = wallet.world_id
           AND currency.id = wallet.currency_id
          WHERE wallet.world_id = NEW.world_id
            AND wallet.currency_id = transaction_record.currency_id
            AND wallet.id = positive_posting.wallet_id
            AND wallet.wallet_kind = 'treasury'::wallet_kind
            AND wallet.status = 'active'::wallet_status
            AND wallet.owner_entity_id = currency.issuer_entity_id
        )
        OR NEW.aggregate_type <> 'currency'
        OR NEW.aggregate_id <> transaction_record.currency_id::text
        OR NEW.event_ordinal <> 0
        OR NEW.payload <> jsonb_build_object(
          'amountMinor', transaction_record.supply_delta_minor::text,
          'currencyId', transaction_record.currency_id::text,
          'reason', transaction_record.memo_text,
          'resultingSupplyMinor', (SELECT supply.current_supply_minor::text
            FROM public.currency_supply supply
            WHERE supply.world_id = NEW.world_id
              AND supply.currency_id = transaction_record.currency_id),
          'transactionId', transaction_record.id::text,
          'treasuryWalletId', positive_posting.wallet_id::text
        ) THEN
        RAISE EXCEPTION 'currency issuance event has no exact journal/supply fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'CurrencyTransferredV1' THEN
      SELECT transaction.* INTO transaction_record FROM public.financial_transactions transaction
      WHERE transaction.world_id = NEW.world_id AND transaction.event_id = NEW.id;
      SELECT posting.* INTO negative_posting FROM public.wallet_postings posting
      WHERE posting.transaction_id = transaction_record.id AND posting.signed_amount_minor < 0;
      SELECT posting.* INTO positive_posting FROM public.wallet_postings posting
      WHERE posting.transaction_id = transaction_record.id AND posting.signed_amount_minor > 0;
      IF command_record.command_type NOT IN ('TransferCurrencyV1','AcceptAssetTransferOfferV1')
        OR transaction_record.id IS NULL OR negative_posting.id IS NULL
        OR positive_posting.id IS NULL OR NEW.aggregate_type <> 'currency'
        OR NEW.aggregate_id <> transaction_record.currency_id::text
        OR NEW.event_ordinal <> 0
        OR NEW.payload <> jsonb_build_object(
          'amountMinor', (-negative_posting.signed_amount_minor::numeric)::text,
          'currencyId', transaction_record.currency_id::text,
          'destinationWalletId', positive_posting.wallet_id::text,
          'sourceWalletId', negative_posting.wallet_id::text,
          'transactionId', transaction_record.id::text
        ) THEN
        RAISE EXCEPTION 'currency transfer event has no exact balanced journal fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'CurrencyFrozenV1', 'CurrencyUnfrozenV1' THEN
      IF command_record.command_type NOT IN ('FreezeCurrencyV1','UnfreezeCurrencyV1')
        OR NEW.aggregate_type <> 'currency' OR NEW.event_ordinal <> 0 OR NOT EXISTS (
          SELECT 1 FROM public.currencies currency
          WHERE currency.world_id = NEW.world_id AND currency.id::text = NEW.aggregate_id
            AND currency.status = CASE NEW.event_type
              WHEN 'CurrencyFrozenV1' THEN 'frozen'::currency_status
              ELSE 'active'::currency_status END
            AND NEW.payload - ARRAY['reason'] = jsonb_build_object(
              'currencyId', currency.id::text,
              'currencyVersion', currency.row_version::text
            )
            AND char_length(NEW.payload ->> 'reason') BETWEEN 8 AND 240
            AND NEW.payload ->> 'reason' = btrim(NEW.payload ->> 'reason')
            AND (NEW.payload ->> 'reason') !~ '[[:cntrl:]]'
        ) THEN
        RAISE EXCEPTION 'currency status event has no exact projection fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WalletFrozenV1', 'WalletUnfrozenV1' THEN
      IF command_record.command_type NOT IN ('FreezeWalletV1','UnfreezeWalletV1')
        OR NEW.aggregate_type <> 'wallet' OR NEW.event_ordinal <> 0 OR NOT EXISTS (
          SELECT 1 FROM public.wallets wallet
          WHERE wallet.world_id = NEW.world_id AND wallet.id::text = NEW.aggregate_id
            AND wallet.status = CASE NEW.event_type
              WHEN 'WalletFrozenV1' THEN 'frozen'::wallet_status
              ELSE 'active'::wallet_status END
            AND NEW.payload - ARRAY['reason'] = jsonb_build_object(
              'walletId', wallet.id::text,
              'walletVersion', wallet.row_version::text
            )
            AND char_length(NEW.payload ->> 'reason') BETWEEN 8 AND 240
            AND NEW.payload ->> 'reason' = btrim(NEW.payload ->> 'reason')
            AND (NEW.payload ->> 'reason') !~ '[[:cntrl:]]'
        ) THEN
        RAISE EXCEPTION 'wallet status event has no exact projection fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'AssetOwnershipTransferredV1' THEN
      SELECT transfer.* INTO transfer_record FROM public.asset_transfers transfer
      WHERE transfer.world_id = NEW.world_id AND transfer.event_id = NEW.id;
      IF transfer_record.id IS NULL OR NEW.aggregate_type <> 'asset'
        OR NEW.aggregate_id <> transfer_record.asset_id::text
        OR NEW.event_ordinal <> (CASE command_record.command_type
          WHEN 'AcceptAssetTransferOfferV1' THEN 1 ELSE 0 END)
        OR NOT EXISTS (
          SELECT 1
          FROM public.assets asset
          JOIN public.asset_ownership ownership
            ON ownership.world_id = asset.world_id AND ownership.asset_id = asset.id
          JOIN public.world_entities target
            ON target.world_id = ownership.world_id AND target.id = ownership.owner_entity_id
          LEFT JOIN public.world_entities source
            ON source.world_id = transfer_record.world_id
           AND source.id = transfer_record.from_owner_entity_id
          WHERE asset.world_id = NEW.world_id AND asset.id = transfer_record.asset_id
            AND ownership.acquired_event_id = NEW.id
            AND NEW.payload = jsonb_build_object(
              'assetId', asset.id::text,
              'assetKey', asset.stable_key::text,
              'financialTransactionId', transfer_record.financial_transaction_id::text,
              'fromOwnerEntityLogicalKey', source.logical_key::text,
              'ownershipVersion', ownership.ownership_version::text,
              'toOwnerEntityLogicalKey', target.logical_key::text,
              'transferKind', transfer_record.transfer_kind::text
            )
        ) THEN
        RAISE EXCEPTION 'asset ownership event has no exact transfer/projection fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'AssetTransferOfferCreatedV1' THEN
      SELECT offer.* INTO offer_record FROM public.asset_transfer_offers offer
      WHERE offer.world_id = NEW.world_id AND offer.created_event_id = NEW.id;
      IF command_record.command_type <> 'CreateAssetTransferOfferV1'
        OR offer_record.id IS NULL OR NEW.event_ordinal <> 0
        OR NEW.aggregate_type <> 'asset_transfer_offer'
        OR NEW.aggregate_id <> offer_record.id::text OR NEW.aggregate_version <> offer_record.row_version
        OR NOT EXISTS (
          SELECT 1
          FROM public.world_entities seller
          JOIN public.wallets seller_wallet
            ON seller_wallet.world_id = seller.world_id
           AND seller_wallet.id = offer_record.seller_wallet_id
           AND seller_wallet.currency_id = offer_record.currency_id
           AND seller_wallet.owner_entity_id = seller.id
           AND seller_wallet.status = 'active'::wallet_status
          LEFT JOIN public.world_entities buyer
            ON buyer.world_id = offer_record.world_id
           AND buyer.id = offer_record.buyer_entity_id
          WHERE seller.world_id = offer_record.world_id
            AND seller.id = offer_record.seller_entity_id
            AND NEW.payload = jsonb_build_object(
              'assetId', offer_record.asset_id::text,
              'buyerEntityLogicalKey', buyer.logical_key::text,
              'currencyId', offer_record.currency_id::text,
              'expiresAtTick', offer_record.expires_at_tick::text,
              'offerId', offer_record.id::text,
              'priceMinor', offer_record.price_minor::text,
              'sellerEntityLogicalKey', seller.logical_key::text,
              'sellerWalletId', offer_record.seller_wallet_id::text
            )
        ) THEN
        RAISE EXCEPTION 'offer-created event has no exact open offer fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'AssetTransferOfferCancelledV1' THEN
      SELECT offer.* INTO offer_record FROM public.asset_transfer_offers offer
      WHERE offer.world_id = NEW.world_id AND offer.terminal_event_id = NEW.id;
      IF command_record.command_type <> 'CancelAssetTransferOfferV1'
        OR offer_record.id IS NULL
        OR offer_record.status <> 'cancelled'::asset_transfer_offer_status
        OR NEW.event_ordinal <> 0 OR NEW.aggregate_type <> 'asset_transfer_offer'
        OR NEW.aggregate_id <> offer_record.id::text
        OR NEW.aggregate_version <> offer_record.row_version
        OR NEW.payload <> jsonb_build_object(
          'offerId', offer_record.id::text,
          'offerVersion', offer_record.row_version::text
        ) THEN
        RAISE EXCEPTION 'offer-cancelled event has no exact terminal offer fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'AssetTransferOfferExpiredV1' THEN
      SELECT offer.* INTO offer_record FROM public.asset_transfer_offers offer
      WHERE offer.world_id = NEW.world_id AND offer.terminal_event_id = NEW.id;
      IF command_record.command_type <> 'ExpireAssetTransferOfferV1'
        OR offer_record.id IS NULL
        OR offer_record.status <> 'expired'::asset_transfer_offer_status
        OR NEW.event_ordinal <> 0 OR NEW.aggregate_type <> 'asset_transfer_offer'
        OR NEW.aggregate_id <> offer_record.id::text
        OR NEW.aggregate_version <> offer_record.row_version
        OR NEW.payload <> jsonb_build_object(
          'expiredAtTick', (SELECT clock.current_tick::text
            FROM public.world_simulation_clocks clock WHERE clock.world_id = NEW.world_id),
          'offerId', offer_record.id::text,
          'offerVersion', offer_record.row_version::text
        ) THEN
        RAISE EXCEPTION 'offer-expired event has no exact due terminal offer fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'AssetTransferOfferAcceptedV1' THEN
      SELECT offer.* INTO offer_record FROM public.asset_transfer_offers offer
      WHERE offer.world_id = NEW.world_id AND offer.terminal_event_id = NEW.id;
      IF command_record.command_type <> 'AcceptAssetTransferOfferV1'
        OR offer_record.id IS NULL
        OR offer_record.status <> 'accepted'::asset_transfer_offer_status
        OR NEW.event_ordinal <> 2 OR NEW.aggregate_type <> 'asset_transfer_offer'
        OR NEW.aggregate_id <> offer_record.id::text
        OR NEW.aggregate_version <> offer_record.row_version OR NOT EXISTS (
          SELECT 1
          FROM public.asset_transfers transfer
          JOIN public.world_entities seller
            ON seller.world_id = transfer.world_id
           AND seller.id = transfer.from_owner_entity_id
          JOIN public.world_entities buyer
            ON buyer.world_id = transfer.world_id
           AND buyer.id = transfer.to_owner_entity_id
          WHERE transfer.world_id = NEW.world_id
            AND transfer.id = offer_record.accepted_asset_transfer_id
            AND transfer.from_owner_entity_id = offer_record.seller_entity_id
            AND (offer_record.buyer_entity_id IS NULL
              OR transfer.to_owner_entity_id = offer_record.buyer_entity_id)
            AND transfer.financial_transaction_id = offer_record.accepted_financial_transaction_id
            AND NEW.payload = jsonb_build_object(
              'buyerEntityLogicalKey', buyer.logical_key::text,
              'offerId', offer_record.id::text,
              'offerVersion', offer_record.row_version::text,
              'sellerEntityLogicalKey', seller.logical_key::text
            )
        ) THEN
        RAISE EXCEPTION 'offer-accepted event has no exact purchase offer fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'AssetPurchasedV1' THEN
      SELECT offer.* INTO offer_record FROM public.asset_transfer_offers offer
      WHERE offer.world_id = NEW.world_id AND offer.terminal_command_id = NEW.command_id;
      IF command_record.command_type <> 'AcceptAssetTransferOfferV1'
        OR offer_record.id IS NULL
        OR offer_record.status <> 'accepted'::asset_transfer_offer_status
        OR NEW.event_ordinal <> 3 OR NEW.aggregate_type <> 'asset_purchase'
        OR NEW.aggregate_id <> offer_record.id::text OR NEW.aggregate_version <> 1 OR NOT EXISTS (
          SELECT 1
          FROM public.asset_transfers transfer
          JOIN public.world_entities seller
            ON seller.world_id = transfer.world_id
           AND seller.id = transfer.from_owner_entity_id
          JOIN public.world_entities buyer
            ON buyer.world_id = transfer.world_id
           AND buyer.id = transfer.to_owner_entity_id
          WHERE transfer.world_id = NEW.world_id
            AND transfer.id = offer_record.accepted_asset_transfer_id
            AND transfer.from_owner_entity_id = offer_record.seller_entity_id
            AND (offer_record.buyer_entity_id IS NULL
              OR transfer.to_owner_entity_id = offer_record.buyer_entity_id)
            AND transfer.financial_transaction_id = offer_record.accepted_financial_transaction_id
            AND EXISTS (
              SELECT 1
              FROM public.financial_transactions transaction
              JOIN public.wallet_postings posting
                ON posting.transaction_id = transaction.id
              WHERE transaction.id = transfer.financial_transaction_id
                AND transaction.world_id = offer_record.world_id
                AND transaction.currency_id = offer_record.currency_id
                AND posting.wallet_id = offer_record.seller_wallet_id
                AND posting.signed_amount_minor = offer_record.price_minor
            )
            AND EXISTS (
              SELECT 1
              FROM public.wallet_postings posting
              JOIN public.wallets buyer_wallet
                ON buyer_wallet.world_id = posting.world_id
               AND buyer_wallet.currency_id = posting.currency_id
               AND buyer_wallet.id = posting.wallet_id
              WHERE posting.transaction_id = transfer.financial_transaction_id
                AND posting.signed_amount_minor = -offer_record.price_minor
                AND buyer_wallet.owner_entity_id = transfer.to_owner_entity_id
            )
            AND NEW.payload = jsonb_build_object(
              'assetId', transfer.asset_id::text,
              'buyerEntityLogicalKey', buyer.logical_key::text,
              'financialTransactionId', transfer.financial_transaction_id::text,
              'offerId', offer_record.id::text,
              'priceMinor', offer_record.price_minor::text,
              'sellerEntityLogicalKey', seller.logical_key::text
            )
        ) THEN
        RAISE EXCEPTION 'asset-purchased event has no exact atomic payment/title fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WorldEconomyRepairedV1' THEN
      SELECT execution.* INTO repair_execution_record
      FROM public.economy_repair_executions execution
      WHERE execution.world_id = NEW.world_id AND execution.event_id = NEW.id;
      SELECT plan.* INTO repair_plan_record
      FROM public.economy_repair_plans plan
      WHERE plan.id = repair_execution_record.repair_plan_id
        AND plan.world_id = NEW.world_id;
      IF command_record.command_type <> 'RepairWorldEconomyV1'
        OR repair_execution_record.id IS NULL OR repair_plan_record.id IS NULL
        OR NEW.event_ordinal <> 0 OR NEW.aggregate_type <> 'world_economy'
        OR NEW.aggregate_id <> NEW.world_id::text
        OR NEW.payload <> jsonb_build_object(
          'compensationTransactionId', repair_plan_record.compensation_transaction_id::text,
          'compensationTransferId', repair_plan_record.compensation_transfer_id::text,
          'reasonCode', repair_plan_record.reason_code::text,
          'repairKind', repair_plan_record.repair_kind::text,
          'repairPlanHash', encode(repair_plan_record.plan_hash, 'hex'),
          'repairPlanId', repair_plan_record.id::text,
          'sourceCommandId', repair_plan_record.source_command_id::text
        )
        OR NEW.metadata <> jsonb_build_object(
          'actor', jsonb_build_object(
            'actorId', repair_execution_record.executed_by_user_id::text,
            'actorType', 'platform_admin'
          ),
          'authorizationRuleId', 'operations.economy.repair.execute',
          'causationId', repair_plan_record.source_command_id::text,
          'commandSchemaVersion', 1,
          'commandType', 'RepairWorldEconomyV1',
          'correlationId', command_record.id::text,
          'overrideId', (
            SELECT approval.creator_override_id::text
            FROM public.economy_repair_approvals approval
            WHERE approval.repair_plan_id = repair_plan_record.id
              AND approval.authority_kind = 'creator'
          ),
          'payloadClassification', 'private'
        ) THEN
        RAISE EXCEPTION 'economy repair event is not the exact private compensation anchor'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER domain_events_require_economy_fact
  AFTER INSERT ON domain_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_economy_domain_event();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_reconciliation_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_record record;
  command_record record;
  head_record record;
  snapshot jsonb;
  item_count integer;
BEGIN
  SELECT run.* INTO run_record FROM public.economy_reconciliation_runs run
  WHERE run.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT command.* INTO command_record FROM public.command_records command
  WHERE command.id = run_record.command_id AND command.world_id = run_record.world_id;
  SELECT head.* INTO head_record FROM public.world_economy_heads head
  WHERE head.world_id = run_record.world_id;
  snapshot := public.worldgraph_economy_reconciliation_snapshot(run_record.world_id);
  SELECT count(*) INTO item_count FROM public.economy_reconciliation_items item
  WHERE item.run_id = run_record.id;
  IF command_record.id IS NULL OR head_record.world_id IS NULL
    OR command_record.command_type IS DISTINCT FROM 'ReconcileWorldEconomyV1'
    OR command_record.status IS DISTINCT FROM 'accepted'::command_record_status
    OR run_record.source_state_revision IS DISTINCT FROM command_record.opened_state_revision
    OR run_record.source_event_sequence IS DISTINCT FROM command_record.opened_event_sequence
    OR run_record.live_wallet_checksum IS DISTINCT FROM decode(snapshot ->> 'liveWalletChecksum', 'hex')
    OR run_record.rebuilt_wallet_checksum IS DISTINCT FROM decode(snapshot ->> 'rebuiltWalletChecksum', 'hex')
    OR run_record.live_supply_checksum IS DISTINCT FROM decode(snapshot ->> 'liveSupplyChecksum', 'hex')
    OR run_record.rebuilt_supply_checksum IS DISTINCT FROM decode(snapshot ->> 'rebuiltSupplyChecksum', 'hex')
    OR run_record.live_ownership_checksum IS DISTINCT FROM decode(snapshot ->> 'liveOwnershipChecksum', 'hex')
    OR run_record.rebuilt_ownership_checksum IS DISTINCT FROM decode(snapshot ->> 'rebuiltOwnershipChecksum', 'hex')
    OR run_record.live_projection_checksum IS DISTINCT FROM decode(snapshot ->> 'liveProjectionChecksum', 'hex')
    OR run_record.rebuilt_journal_checksum IS DISTINCT FROM decode(snapshot ->> 'rebuiltJournalChecksum', 'hex')
    OR run_record.wallet_count IS DISTINCT FROM (snapshot ->> 'walletCount')::integer
    OR run_record.currency_count IS DISTINCT FROM (snapshot ->> 'currencyCount')::integer
    OR run_record.asset_count IS DISTINCT FROM (snapshot ->> 'assetCount')::integer
    OR run_record.mismatch_count IS DISTINCT FROM item_count
    OR (run_record.status = 'matched'::economy_reconciliation_run_status AND (
      item_count <> 0 OR run_record.live_projection_checksum <> run_record.rebuilt_journal_checksum))
    OR (run_record.status = 'mismatch'::economy_reconciliation_run_status AND (
      item_count = 0 OR run_record.live_projection_checksum = run_record.rebuilt_journal_checksum))
    OR EXISTS (
      WITH expected_items AS (
        SELECT (row_number() OVER (ORDER BY candidate.category_order) - 1)::integer item_ordinal,
               candidate.item_kind, candidate.item_key, candidate.expected_value,
               candidate.actual_value, candidate.mismatch_code
        FROM (VALUES
          (1, 'wallet_balance', 'wallets',
            encode(run_record.rebuilt_wallet_checksum, 'hex'),
            encode(run_record.live_wallet_checksum, 'hex'),
            'WALLET_BALANCE_CHECKSUM_MISMATCH'),
          (2, 'currency_supply', 'currencies',
            encode(run_record.rebuilt_supply_checksum, 'hex'),
            encode(run_record.live_supply_checksum, 'hex'),
            'CURRENCY_SUPPLY_CHECKSUM_MISMATCH'),
          (3, 'asset_ownership', 'assets',
            encode(run_record.rebuilt_ownership_checksum, 'hex'),
            encode(run_record.live_ownership_checksum, 'hex'),
            'ASSET_OWNERSHIP_CHECKSUM_MISMATCH')
        ) candidate(
          category_order, item_kind, item_key, expected_value, actual_value, mismatch_code
        )
        WHERE candidate.expected_value IS DISTINCT FROM candidate.actual_value
      ), actual_items AS (
        SELECT item.item_ordinal, item.item_kind, item.item_key,
               item.expected_value, item.actual_value, item.mismatch_code
        FROM public.economy_reconciliation_items item
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
    OR head_record.last_reconciled_state_revision IS DISTINCT FROM run_record.source_state_revision
    OR head_record.reconciliation_status IS DISTINCT FROM (CASE run_record.status
      WHEN 'matched'::economy_reconciliation_run_status THEN 'current'::economy_reconciliation_status
      ELSE 'mismatch'::economy_reconciliation_status END)
    OR NOT EXISTS (
      SELECT 1 FROM public.domain_events event
      WHERE event.id = run_record.event_id AND event.world_id = run_record.world_id
        AND event.command_id = run_record.command_id
        AND event.event_type = 'WorldEconomyReconciledV1'
    ) THEN
    RAISE EXCEPTION 'reconciliation run does not match canonical live/journal evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'economy_reconciliation_evidence_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER economy_reconciliation_runs_require_exact_evidence
  AFTER INSERT ON economy_reconciliation_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_economy_reconciliation_run();
--> statement-breakpoint
CREATE FUNCTION worldgraph_require_economy_checkpoint_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE checked_command_id uuid;
BEGIN
  IF NEW.projection_name <> 'economy_runtime' THEN RETURN NEW; END IF;
  checked_command_id := NULLIF(current_setting('worldgraph.command_id', true), '')::uuid;
  IF NEW.projection_schema_version <> 1
    OR NEW.status <> 'current'::projection_checkpoint_status
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id)
    OR NOT EXISTS (
      SELECT 1
      FROM public.world_economy_heads head
      JOIN public.domain_events event
        ON event.world_id = head.world_id
       AND event.command_id = checked_command_id
       AND event.world_event_sequence = NEW.last_event_sequence
      WHERE head.world_id = NEW.world_id
        AND head.checksum = NEW.checksum
        AND head.checksum = public.worldgraph_economy_projection_checksum(NEW.world_id)
    ) THEN
    RAISE EXCEPTION 'economy checkpoint certification requires its exact open command event/head'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER projection_checkpoints_require_economy_command
  BEFORE INSERT OR UPDATE ON projection_checkpoints
  FOR EACH ROW EXECUTE FUNCTION worldgraph_require_economy_checkpoint_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_advance_economy_checkpoint_for_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.world_economy_heads head WHERE head.world_id = NEW.world_id) THEN
    INSERT INTO public.projection_checkpoints(
      world_id, projection_name, projection_schema_version,
      last_event_sequence, checksum, status, updated_at
    )
    SELECT NEW.world_id, 'economy_runtime', 1, NEW.world_event_sequence,
           head.checksum, 'current'::projection_checkpoint_status, NEW.recorded_at
    FROM public.world_economy_heads head WHERE head.world_id = NEW.world_id
    ON CONFLICT (world_id, projection_name) DO UPDATE
      SET projection_schema_version = EXCLUDED.projection_schema_version,
          last_event_sequence = EXCLUDED.last_event_sequence,
          checksum = EXCLUDED.checksum,
          status = EXCLUDED.status,
          updated_at = greatest(projection_checkpoints.updated_at, EXCLUDED.updated_at)
      WHERE projection_checkpoints.last_event_sequence < EXCLUDED.last_event_sequence;
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER domain_events_advance_economy_checkpoint
  AFTER INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION worldgraph_advance_economy_checkpoint_for_event();
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_command_mutation_set_is_exact(checked_command_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN (
  WITH checked_command AS (
    SELECT command.id, command.world_id, command.command_type
    FROM public.command_records command
    WHERE command.id = checked_command_id
      AND command.command_type IN (
        'AdoptLegacyEconomySeedPlanV1','InitializeWorldEconomyV1',
        'TransferCurrencyV1','IssueCurrencyV1','FreezeCurrencyV1',
        'UnfreezeCurrencyV1','FreezeWalletV1','UnfreezeWalletV1',
        'TransferAssetV1','CreateAssetTransferOfferV1',
        'CancelAssetTransferOfferV1','AcceptAssetTransferOfferV1',
        'ExpireAssetTransferOfferV1','ReconcileWorldEconomyV1','RepairWorldEconomyV1'
      )
  ), expected AS (
    SELECT command.id AS command_id, command.world_id,
           'economy_head'::text AS mutation_kind,
           command.world_id AS target_id,
           CASE command.command_type
             WHEN 'InitializeWorldEconomyV1' THEN 'insert' ELSE 'update'
           END::text AS operation
    FROM checked_command command
    WHERE command.command_type <> 'AdoptLegacyEconomySeedPlanV1'
    UNION ALL
    SELECT command.id, command.world_id, 'currency', currency.id, 'insert'
    FROM checked_command command
    JOIN public.currencies currency ON currency.world_id = command.world_id
    WHERE command.command_type = 'InitializeWorldEconomyV1'
    UNION ALL
    SELECT command.id, command.world_id, 'currency_supply', supply.currency_id, 'insert'
    FROM checked_command command
    JOIN public.currency_supply supply ON supply.world_id = command.world_id
    WHERE command.command_type = 'InitializeWorldEconomyV1'
    UNION ALL
    SELECT command.id, command.world_id, 'wallet', wallet.id, 'insert'
    FROM checked_command command
    JOIN public.wallets wallet ON wallet.world_id = command.world_id
    WHERE command.command_type = 'InitializeWorldEconomyV1'
    UNION ALL
    SELECT command.id, command.world_id, 'wallet_balance', balance.wallet_id, 'insert'
    FROM checked_command command
    JOIN public.wallet_balances balance ON balance.world_id = command.world_id
    WHERE command.command_type = 'InitializeWorldEconomyV1'
    UNION ALL
    SELECT command.id, command.world_id, 'asset', asset.id, 'insert'
    FROM checked_command command
    JOIN public.assets asset ON asset.world_id = command.world_id
    WHERE command.command_type = 'InitializeWorldEconomyV1'
    UNION ALL
    SELECT command.id, command.world_id, 'asset_ownership', ownership.asset_id, 'insert'
    FROM checked_command command
    JOIN public.asset_ownership ownership ON ownership.world_id = command.world_id
    WHERE command.command_type = 'InitializeWorldEconomyV1'
    UNION ALL
    SELECT command.id, command.world_id, 'currency', currency.id, 'update'
    FROM checked_command command
    JOIN public.domain_events event ON event.command_id = command.id
      AND event.world_id = command.world_id
      AND event.event_type IN ('CurrencyFrozenV1','CurrencyUnfrozenV1')
    JOIN public.currencies currency ON currency.world_id = command.world_id
      AND currency.id::text = event.aggregate_id
    WHERE command.command_type IN ('FreezeCurrencyV1','UnfreezeCurrencyV1')
    UNION ALL
    SELECT command.id, command.world_id, 'wallet', wallet.id, 'update'
    FROM checked_command command
    JOIN public.domain_events event ON event.command_id = command.id
      AND event.world_id = command.world_id
      AND event.event_type IN ('WalletFrozenV1','WalletUnfrozenV1')
    JOIN public.wallets wallet ON wallet.world_id = command.world_id
      AND wallet.id::text = event.aggregate_id
    WHERE command.command_type IN ('FreezeWalletV1','UnfreezeWalletV1')
    UNION ALL
    SELECT command.id, command.world_id, 'currency_supply', transaction.currency_id, 'update'
    FROM checked_command command
    JOIN public.financial_transactions transaction
      ON transaction.command_id = command.id AND transaction.world_id = command.world_id
    WHERE command.command_type = 'IssueCurrencyV1'
      OR (command.command_type = 'RepairWorldEconomyV1'
        AND transaction.supply_delta_minor <> 0)
    UNION ALL
    SELECT DISTINCT command.id, command.world_id,
           'wallet_balance', posting.wallet_id, 'update'
    FROM checked_command command
    JOIN public.financial_transactions transaction
      ON transaction.command_id = command.id AND transaction.world_id = command.world_id
    JOIN public.wallet_postings posting
      ON posting.transaction_id = transaction.id AND posting.world_id = transaction.world_id
    WHERE command.command_type IN (
      'TransferCurrencyV1','IssueCurrencyV1','AcceptAssetTransferOfferV1'
      ,'RepairWorldEconomyV1'
    )
    UNION ALL
    SELECT command.id, command.world_id, 'asset_ownership', transfer.asset_id, 'update'
    FROM checked_command command
    JOIN public.asset_transfers transfer
      ON transfer.command_id = command.id AND transfer.world_id = command.world_id
    WHERE command.command_type IN (
      'TransferAssetV1','AcceptAssetTransferOfferV1','RepairWorldEconomyV1'
    )
    UNION ALL
    SELECT command.id, command.world_id, 'asset_transfer_offer', offer.id, 'insert'
    FROM checked_command command
    JOIN public.asset_transfer_offers offer
      ON offer.created_command_id = command.id AND offer.world_id = command.world_id
    WHERE command.command_type = 'CreateAssetTransferOfferV1'
    UNION ALL
    SELECT command.id, command.world_id, 'asset_transfer_offer', offer.id, 'update'
    FROM checked_command command
    JOIN public.asset_transfer_offers offer
      ON offer.terminal_command_id = command.id AND offer.world_id = command.world_id
    WHERE command.command_type IN (
      'CancelAssetTransferOfferV1','AcceptAssetTransferOfferV1',
      'ExpireAssetTransferOfferV1'
    )
  ), difference AS (
    (SELECT command_id, world_id, mutation_kind, target_id, operation
       FROM public.economy_command_mutations WHERE command_id = checked_command_id
     EXCEPT
     SELECT command_id, world_id, mutation_kind, target_id, operation FROM expected)
    UNION ALL
    (SELECT command_id, world_id, mutation_kind, target_id, operation FROM expected
     EXCEPT
     SELECT command_id, world_id, mutation_kind, target_id, operation
       FROM public.economy_command_mutations WHERE command_id = checked_command_id)
  )
  SELECT EXISTS (SELECT 1 FROM checked_command)
    AND NOT EXISTS (SELECT 1 FROM difference)
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_command_mutation_set_is_exact(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_derive_economy_repair_delta(
  checked_world_id uuid,
  checked_source_command_id uuid,
  checked_compensation_transaction_id uuid,
  checked_compensation_transfer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source_command record;
  source_transaction record;
  source_transfer record;
  source_ownership record;
  source_asset record;
  source_supply record;
  posting_count integer;
  posting_sum numeric;
  projected_supply numeric;
  financial_delta jsonb;
  title_delta jsonb;
  repair_kind economy_repair_kind;
BEGIN
  SELECT command.* INTO source_command
  FROM public.command_records command
  WHERE command.id = checked_source_command_id
    AND command.world_id = checked_world_id
    AND command.status = 'accepted'::command_record_status;
  IF NOT FOUND OR source_command.command_type NOT IN (
      'TransferCurrencyV1','IssueCurrencyV1','TransferAssetV1',
      'AcceptAssetTransferOfferV1'
    ) THEN
    RAISE EXCEPTION 'economy repair source must be one eligible accepted command'
      USING ERRCODE = '55000';
  END IF;
  repair_kind := CASE source_command.command_type
    WHEN 'TransferCurrencyV1' THEN 'reverse_financial_transaction'::economy_repair_kind
    WHEN 'IssueCurrencyV1' THEN 'reverse_financial_transaction'::economy_repair_kind
    WHEN 'TransferAssetV1' THEN 'reverse_asset_transfer'::economy_repair_kind
    WHEN 'AcceptAssetTransferOfferV1' THEN 'reverse_asset_purchase'::economy_repair_kind
  END;
  IF (repair_kind IN ('reverse_financial_transaction','reverse_asset_purchase'))
      IS DISTINCT FROM (checked_compensation_transaction_id IS NOT NULL)
    OR (repair_kind IN ('reverse_asset_transfer','reverse_asset_purchase'))
      IS DISTINCT FROM (checked_compensation_transfer_id IS NOT NULL) THEN
    RAISE EXCEPTION 'economy repair compensation identifiers do not match source kind'
      USING ERRCODE = '55000';
  END IF;

  IF repair_kind IN ('reverse_financial_transaction','reverse_asset_purchase') THEN
    SELECT transaction.* INTO source_transaction
    FROM public.financial_transactions transaction
    WHERE transaction.world_id = checked_world_id
      AND transaction.command_id = checked_source_command_id;
    IF NOT FOUND
      OR source_transaction.reversal_of_transaction_id IS NOT NULL
      OR source_transaction.id = checked_compensation_transaction_id
      OR EXISTS (
        SELECT 1 FROM public.financial_transactions compensation
        WHERE compensation.reversal_of_transaction_id = source_transaction.id
      )
      OR (source_command.command_type = 'IssueCurrencyV1' AND NOT (
        source_transaction.transaction_kind = 'issuance'::financial_transaction_kind
        AND source_transaction.supply_delta_minor > 0))
      OR (source_command.command_type = 'TransferCurrencyV1' AND NOT (
        source_transaction.transaction_kind = 'transfer'::financial_transaction_kind
        AND source_transaction.supply_delta_minor = 0))
      OR (source_command.command_type = 'AcceptAssetTransferOfferV1' AND NOT (
        source_transaction.transaction_kind = 'asset_purchase'::financial_transaction_kind
        AND source_transaction.supply_delta_minor = 0)) THEN
      RAISE EXCEPTION 'economy repair financial source is ineligible or already reversed'
        USING ERRCODE = '55000';
    END IF;
    SELECT count(*), COALESCE(sum(posting.signed_amount_minor), 0)
      INTO posting_count, posting_sum
    FROM public.wallet_postings posting
    WHERE posting.transaction_id = source_transaction.id;
    IF posting_count NOT BETWEEN 1 AND 2
      OR posting_sum <> source_transaction.supply_delta_minor::numeric
      OR (source_command.command_type = 'IssueCurrencyV1' AND posting_count <> 1)
      OR (source_command.command_type <> 'IssueCurrencyV1' AND posting_count <> 2)
      OR NOT EXISTS (
        SELECT 1 FROM public.wallet_postings posting
        WHERE posting.transaction_id = source_transaction.id
        HAVING min(posting.posting_ordinal) = 0
          AND max(posting.posting_ordinal) = count(*) - 1
          AND count(DISTINCT posting.wallet_id) = count(*)
          AND (source_command.command_type = 'IssueCurrencyV1'
            OR (count(*) FILTER (WHERE posting.signed_amount_minor < 0) = 1
              AND count(*) FILTER (WHERE posting.signed_amount_minor > 0) = 1))
      )
      OR EXISTS (
        SELECT 1
        FROM public.wallet_postings posting
        LEFT JOIN public.wallets wallet
          ON wallet.world_id = posting.world_id
         AND wallet.currency_id = posting.currency_id
         AND wallet.id = posting.wallet_id
        LEFT JOIN public.wallet_balances balance
          ON balance.world_id = wallet.world_id
         AND balance.currency_id = wallet.currency_id
         AND balance.wallet_id = wallet.id
        WHERE posting.transaction_id = source_transaction.id
          AND (wallet.id IS NULL OR balance.wallet_id IS NULL
            OR wallet.status = 'closed'::wallet_status
            OR balance.row_version >= 9223372036854775807
            OR balance.available_minor::numeric - posting.signed_amount_minor::numeric < 0
            OR balance.available_minor::numeric - posting.signed_amount_minor::numeric
              > 9223372036854775807::numeric)
      ) THEN
      RAISE EXCEPTION 'economy repair source postings or current balances are invalid'
        USING ERRCODE = '55000';
    END IF;
    SELECT supply.*, currency.max_supply_minor, currency.status AS currency_status
      INTO source_supply
    FROM public.currency_supply supply
    JOIN public.currencies currency
      ON currency.world_id = supply.world_id AND currency.id = supply.currency_id
    WHERE supply.world_id = checked_world_id
      AND supply.currency_id = source_transaction.currency_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'economy repair current currency supply is missing'
        USING ERRCODE = '55000';
    END IF;
    projected_supply := source_supply.current_supply_minor::numeric
      - source_transaction.supply_delta_minor::numeric;
    IF source_supply.currency_status = 'retired'::currency_status
      OR projected_supply < 0 OR projected_supply > 9223372036854775807::numeric
      OR (source_supply.max_supply_minor IS NOT NULL
        AND projected_supply > source_supply.max_supply_minor)
      OR (source_transaction.supply_delta_minor <> 0
        AND source_supply.row_version >= 9223372036854775807) THEN
      RAISE EXCEPTION 'economy repair current currency supply is invalid'
        USING ERRCODE = '55000';
    END IF;
    SELECT jsonb_build_object(
      'compensationTransactionId', checked_compensation_transaction_id::text,
      'currencyId', source_transaction.currency_id::text,
      'postings', jsonb_agg(jsonb_build_object(
        'balanceAfterMinor',
          (balance.available_minor::numeric - posting.signed_amount_minor::numeric)::text,
        'balanceBeforeMinor', balance.available_minor::text,
        'balanceVersionAfter', (balance.row_version + 1)::text,
        'balanceVersionBefore', balance.row_version::text,
        'compensationSignedAmountMinor', (-posting.signed_amount_minor::numeric)::text,
        'sourcePostingOrdinal', posting.posting_ordinal,
        'sourceSignedAmountMinor', posting.signed_amount_minor::text,
        'walletId', posting.wallet_id::text
      ) ORDER BY posting.posting_ordinal),
      'reversalOfTransactionId', source_transaction.id::text,
      'supply', jsonb_build_object(
        'compensationSupplyDeltaMinor', (-source_transaction.supply_delta_minor::numeric)::text,
        'currencyId', source_transaction.currency_id::text,
        'sourceSupplyDeltaMinor', source_transaction.supply_delta_minor::text,
        'supplyAfterMinor', projected_supply::text,
        'supplyBeforeMinor', source_supply.current_supply_minor::text,
        'supplyVersionAfter', (source_supply.row_version
          + (source_transaction.supply_delta_minor <> 0)::integer)::text,
        'supplyVersionBefore', source_supply.row_version::text
      )
    ) INTO financial_delta
    FROM public.wallet_postings posting
    JOIN public.wallet_balances balance
      ON balance.world_id = posting.world_id
     AND balance.currency_id = posting.currency_id
     AND balance.wallet_id = posting.wallet_id
    WHERE posting.transaction_id = source_transaction.id;
  END IF;

  IF repair_kind IN ('reverse_asset_transfer','reverse_asset_purchase') THEN
    SELECT transfer.* INTO source_transfer
    FROM public.asset_transfers transfer
    WHERE transfer.world_id = checked_world_id
      AND transfer.command_id = checked_source_command_id;
    SELECT ownership.* INTO source_ownership
    FROM public.asset_ownership ownership
    WHERE ownership.world_id = checked_world_id
      AND ownership.asset_id = source_transfer.asset_id;
    SELECT asset.* INTO source_asset
    FROM public.assets asset
    WHERE asset.world_id = checked_world_id AND asset.id = source_transfer.asset_id;
    IF source_transfer.id IS NULL OR source_ownership.asset_id IS NULL OR source_asset.id IS NULL
      OR source_transfer.from_owner_entity_id IS NULL
      OR source_transfer.from_owner_entity_id = source_transfer.to_owner_entity_id
      OR source_transfer.reversal_of_transfer_id IS NOT NULL
      OR source_transfer.id = checked_compensation_transfer_id
      OR source_asset.status <> 'active'::asset_status OR NOT source_asset.transferable
      OR source_ownership.owner_entity_id <> source_transfer.to_owner_entity_id
      OR source_ownership.acquired_event_id <> source_transfer.event_id
      OR source_ownership.ownership_version >= 9223372036854775807
      OR EXISTS (
        SELECT 1 FROM public.asset_transfers compensation
        WHERE compensation.reversal_of_transfer_id = source_transfer.id
      )
      OR EXISTS (
        SELECT 1 FROM public.asset_transfer_offers offer
        WHERE offer.world_id = checked_world_id
          AND offer.asset_id = source_transfer.asset_id
          AND offer.status = 'open'::asset_transfer_offer_status
      ) THEN
      RAISE EXCEPTION 'economy repair title source is not the latest eligible title'
        USING ERRCODE = '55000';
    END IF;
    IF source_command.command_type = 'TransferAssetV1' AND NOT (
      source_transfer.transfer_kind = 'grant'::asset_transfer_kind
      AND source_transfer.financial_transaction_id IS NULL
    ) THEN
      RAISE EXCEPTION 'economy repair title source is not the latest eligible title'
        USING ERRCODE = '55000';
    END IF;
    IF source_command.command_type = 'AcceptAssetTransferOfferV1' THEN
      IF NOT (
        source_transfer.transfer_kind = 'purchase'::asset_transfer_kind
        AND source_transfer.financial_transaction_id = source_transaction.id
      ) THEN
        RAISE EXCEPTION 'economy repair title source is not the latest eligible title'
          USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM public.wallet_postings debit
        JOIN public.wallets buyer_wallet
          ON buyer_wallet.world_id = debit.world_id
         AND buyer_wallet.currency_id = debit.currency_id
         AND buyer_wallet.id = debit.wallet_id
        JOIN public.wallet_postings credit
          ON credit.transaction_id = debit.transaction_id
         AND credit.signed_amount_minor = -debit.signed_amount_minor
        JOIN public.wallets seller_wallet
          ON seller_wallet.world_id = credit.world_id
         AND seller_wallet.currency_id = credit.currency_id
         AND seller_wallet.id = credit.wallet_id
        WHERE debit.transaction_id = source_transaction.id
          AND debit.signed_amount_minor < 0
          AND buyer_wallet.owner_entity_id = source_transfer.to_owner_entity_id
          AND seller_wallet.owner_entity_id = source_transfer.from_owner_entity_id
      ) THEN
        RAISE EXCEPTION 'economy purchase repair is not bound to its buyer payment and seller receipt'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    title_delta := jsonb_build_object(
      'assetId', source_transfer.asset_id::text,
      'compensationTransferId', checked_compensation_transfer_id::text,
      'fromOwnerEntityId', source_transfer.to_owner_entity_id::text,
      'ownershipVersionAfter', (source_ownership.ownership_version + 1)::text,
      'ownershipVersionBefore', source_ownership.ownership_version::text,
      'reversalOfTransferId', source_transfer.id::text,
      'toOwnerEntityId', source_transfer.from_owner_entity_id::text
    );
  END IF;

  RETURN jsonb_build_object(
    'financialDelta', financial_delta,
    'repairKind', repair_kind::text,
    'titleDelta', title_delta
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_derive_economy_repair_delta(uuid,uuid,uuid,uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_repair_plan_body(checked_repair_plan_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN (
  SELECT jsonb_build_object(
    'delta', plan.canonical_delta,
    'domain', 'worldgraph.economy-repair-plan.v1',
    'expiresAt', to_char(
      plan.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'incidentReason', plan.incident_reason,
    'pitrNotUsedReason', plan.pitr_not_used_reason,
    'preparedAt', to_char(
      plan.prepared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'preparedByUserId', plan.prepared_by_user_id::text,
    'reasonCode', plan.reason_code::text,
    'repairKind', plan.repair_kind::text,
    'repairPlanId', plan.id::text,
    'repairPlanSchemaVersion', plan.repair_plan_schema_version,
    'reservedCommandId', plan.reserved_command_id::text,
    'sourceCommandId', plan.source_command_id::text,
    'sourceEconomyChecksum', encode(plan.source_economy_checksum, 'hex'),
    'sourceEconomyHeadVersion', plan.source_economy_head_version::text,
    'sourceEventSequence', plan.source_event_sequence::text,
    'sourceReconciliationRunId', plan.source_reconciliation_run_id::text,
    'sourceStateRevision', plan.source_state_revision::text,
    'sourceWorldVersion', plan.source_world_version::text,
    'worldId', plan.world_id::text
  )
  FROM public.economy_repair_plans plan
  WHERE plan.id = checked_repair_plan_id
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_repair_plan_body(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_repair_plan_seal_is_valid(
  checked_repair_plan_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
RETURN COALESCE((
  SELECT plan.delta_hash IS NOT DISTINCT FROM extensions.digest(convert_to(
           public.worldgraph_canonical_jsonb(jsonb_build_object(
             'domain', 'worldgraph.economy-repair-delta.v1',
             'delta', plan.canonical_delta
           )), 'UTF8'
         ), 'sha256')
     AND plan.plan_hash IS NOT DISTINCT FROM extensions.digest(convert_to(
           public.worldgraph_canonical_jsonb(jsonb_build_object(
             'domain', 'worldgraph.economy-repair-plan-hash.v1',
             'plan', public.worldgraph_economy_repair_plan_body(plan.id)
           )), 'UTF8'
         ), 'sha256')
  FROM public.economy_repair_plans plan
  WHERE plan.id = checked_repair_plan_id
), false);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_repair_plan_seal_is_valid(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_repair_plan()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  plan_record record;
  plan_body jsonb;
  exact_delta jsonb;
BEGIN
  SELECT plan.* INTO plan_record
  FROM public.economy_repair_plans plan WHERE plan.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  plan_body := public.worldgraph_economy_repair_plan_body(plan_record.id);
  exact_delta := public.worldgraph_derive_economy_repair_delta(
    plan_record.world_id,
    plan_record.source_command_id,
    plan_record.compensation_transaction_id,
    plan_record.compensation_transfer_id
  );
  IF plan_record.canonical_delta IS DISTINCT FROM exact_delta
    OR plan_record.repair_kind::text IS DISTINCT FROM exact_delta ->> 'repairKind'
    OR plan_record.source_financial_transaction_id IS DISTINCT FROM
      (exact_delta -> 'financialDelta' ->> 'reversalOfTransactionId')::uuid
    OR plan_record.source_asset_transfer_id IS DISTINCT FROM
      (exact_delta -> 'titleDelta' ->> 'reversalOfTransferId')::uuid
    OR plan_record.delta_hash IS DISTINCT FROM extensions.digest(convert_to(
      public.worldgraph_canonical_jsonb(jsonb_build_object(
        'domain', 'worldgraph.economy-repair-delta.v1',
        'delta', exact_delta
      )), 'UTF8'
    ), 'sha256')
    OR plan_record.plan_hash IS DISTINCT FROM extensions.digest(convert_to(
      public.worldgraph_canonical_jsonb(jsonb_build_object(
        'domain', 'worldgraph.economy-repair-plan-hash.v1',
        'plan', plan_body
      )), 'UTF8'
    ), 'sha256')
    OR NOT EXISTS (
      SELECT 1 FROM public.security_audit_records audit
      WHERE audit.id = plan_record.preparation_audit_id
        AND audit.world_id = plan_record.world_id
        AND audit.actor_user_id = plan_record.prepared_by_user_id
        AND audit.category = 'economy_repair'
        AND audit.action = 'economy.repair.prepare'
        AND audit.outcome = 'succeeded'
        AND audit.reason_code = plan_record.reason_code::text
        AND audit.target_type = 'economy_repair_plan'
        AND audit.target_id = plan_record.id
        AND audit.redacted_metadata = jsonb_build_object(
          'planHash', encode(plan_record.plan_hash, 'hex'),
          'repairKind', plan_record.repair_kind::text,
          'sourceCommandId', plan_record.source_command_id::text
        )
    ) THEN
    RAISE EXCEPTION 'economy repair plan is not the exact sealed source reversal'
      USING ERRCODE = '23514', CONSTRAINT = 'economy_repair_plan_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER economy_repair_plans_require_exact_source
  AFTER INSERT ON economy_repair_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_economy_repair_plan();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_economy_repair_plan() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_prepare_economy_repair(
  checked_world_id uuid,
  checked_source_command_id uuid,
  checked_prepared_by_user_id uuid,
  checked_reason_code text,
  checked_incident_reason text,
  checked_pitr_not_used_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  authority record;
  snapshot jsonb;
  prepared_time timestamptz := date_trunc('milliseconds', clock_timestamp());
  repair_plan_id uuid := extensions.gen_random_uuid();
  reserved_command_id uuid := extensions.gen_random_uuid();
  preparation_audit_id uuid := extensions.gen_random_uuid();
  compensation_transaction_id uuid;
  compensation_transfer_id uuid;
  source_transaction_id uuid;
  source_transfer_id uuid;
  repair_kind economy_repair_kind;
  canonical_delta jsonb;
  delta_hash_value bytea;
  plan_body jsonb;
  plan_hash_value bytea;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'economy repair preparation requires the database owner session'
      USING ERRCODE = '42501';
  END IF;
  IF checked_world_id IS NULL OR checked_source_command_id IS NULL
    OR checked_prepared_by_user_id IS NULL THEN
    RAISE EXCEPTION 'economy repair world, source, and preparer are required'
      USING ERRCODE = '22023';
  END IF;
  IF checked_reason_code IS NULL OR checked_reason_code NOT IN (
      'DUPLICATE_EFFECT','ERRONEOUS_EFFECT','INCIDENT_RECOVERY'
    ) THEN
    RAISE EXCEPTION 'economy repair reason code is invalid' USING ERRCODE = '22023';
  END IF;
  IF checked_incident_reason IS NULL OR checked_pitr_not_used_reason IS NULL
    OR NOT public.worldgraph_economy_repair_reason_is_valid(checked_incident_reason)
    OR NOT public.worldgraph_economy_repair_reason_is_valid(
      checked_pitr_not_used_reason
    ) THEN
    RAISE EXCEPTION 'economy repair incident and PITR reasons must be exact and bounded'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users operator
    WHERE operator.id = checked_prepared_by_user_id
      AND operator.status = 'active'::user_status
      AND operator.platform_role = 'platform_admin'::platform_role
  ) THEN
    RAISE EXCEPTION 'economy repair preparer must be an active platform administrator'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.worldgraph_lock_world_compilation(checked_world_id);
  PERFORM public.worldgraph_assert_economy_projection_current(checked_world_id);
  snapshot := public.worldgraph_economy_reconciliation_snapshot(checked_world_id);
  SELECT runtime.state_revision, runtime.last_event_sequence,
         version.version_number AS world_version,
         head.row_version AS economy_head_version, head.checksum AS economy_checksum,
         head.updated_state_revision AS economy_updated_state_revision,
         head.last_reconciled_state_revision, head.last_reconciliation_run_id,
         run.id AS reconciliation_run_id,
         run.source_state_revision AS reconciliation_state_revision,
         run.source_event_sequence AS reconciliation_event_sequence,
         run.status AS reconciliation_status, run.mismatch_count,
         run.live_wallet_checksum, run.rebuilt_wallet_checksum,
         run.live_supply_checksum, run.rebuilt_supply_checksum,
         run.live_ownership_checksum, run.rebuilt_ownership_checksum,
         run.live_projection_checksum, run.rebuilt_journal_checksum,
         run.command_id AS reconciliation_command_id,
         run.event_id AS reconciliation_event_id
    INTO authority
  FROM public.world_runtime_heads runtime
  JOIN public.world_versions version
    ON version.world_id = runtime.world_id AND version.id = runtime.active_world_version_id
  JOIN public.world_economy_heads head ON head.world_id = runtime.world_id
  JOIN public.economy_reconciliation_runs run
    ON run.world_id = head.world_id AND run.id = head.last_reconciliation_run_id
  WHERE runtime.world_id = checked_world_id
  FOR UPDATE OF runtime, head, run;
  IF NOT FOUND
    OR authority.reconciliation_status <> 'matched'::economy_reconciliation_run_status
    OR authority.mismatch_count <> 0
    OR authority.economy_updated_state_revision <> authority.state_revision
    OR authority.last_reconciled_state_revision <> authority.reconciliation_state_revision
    OR authority.reconciliation_state_revision + 1 <> authority.state_revision
    OR authority.reconciliation_event_sequence + 1 <> authority.last_event_sequence
    OR authority.economy_checksum <> public.worldgraph_economy_projection_checksum(
      checked_world_id
    )
    OR authority.live_wallet_checksum <> authority.rebuilt_wallet_checksum
    OR authority.live_supply_checksum <> authority.rebuilt_supply_checksum
    OR authority.live_ownership_checksum <> authority.rebuilt_ownership_checksum
    OR authority.live_projection_checksum <> authority.rebuilt_journal_checksum
    OR authority.live_wallet_checksum <> decode(snapshot ->> 'liveWalletChecksum', 'hex')
    OR authority.live_supply_checksum <> decode(snapshot ->> 'liveSupplyChecksum', 'hex')
    OR authority.live_ownership_checksum <> decode(snapshot ->> 'liveOwnershipChecksum', 'hex')
    OR authority.live_projection_checksum <> decode(snapshot ->> 'liveProjectionChecksum', 'hex')
    OR NOT EXISTS (
      SELECT 1
      FROM public.command_records command
      JOIN public.domain_events event
        ON event.command_id = command.id AND event.world_id = command.world_id
      WHERE command.id = authority.reconciliation_command_id
        AND command.world_id = checked_world_id
        AND command.command_type = 'ReconcileWorldEconomyV1'
        AND command.status = 'accepted'::command_record_status
        AND command.resulting_state_revision = authority.state_revision
        AND event.id = authority.reconciliation_event_id
        AND event.event_type = 'WorldEconomyReconciledV1'
        AND event.world_event_sequence = authority.last_event_sequence
        AND event.resulting_state_revision = authority.state_revision
    ) THEN
    RAISE EXCEPTION 'economy repair requires the immediately-following matched reconciliation head'
      USING ERRCODE = '55000';
  END IF;

  SELECT CASE command.command_type
      WHEN 'TransferCurrencyV1' THEN 'reverse_financial_transaction'::economy_repair_kind
      WHEN 'IssueCurrencyV1' THEN 'reverse_financial_transaction'::economy_repair_kind
      WHEN 'TransferAssetV1' THEN 'reverse_asset_transfer'::economy_repair_kind
      WHEN 'AcceptAssetTransferOfferV1' THEN 'reverse_asset_purchase'::economy_repair_kind
    END
    INTO repair_kind
  FROM public.command_records command
  WHERE command.id = checked_source_command_id
    AND command.world_id = checked_world_id
    AND command.status = 'accepted'::command_record_status;
  IF repair_kind IS NULL THEN
    RAISE EXCEPTION 'economy repair source command is not eligible'
      USING ERRCODE = '55000';
  END IF;
  IF repair_kind IN ('reverse_financial_transaction','reverse_asset_purchase') THEN
    compensation_transaction_id := extensions.gen_random_uuid();
  END IF;
  IF repair_kind IN ('reverse_asset_transfer','reverse_asset_purchase') THEN
    compensation_transfer_id := extensions.gen_random_uuid();
  END IF;
  canonical_delta := public.worldgraph_derive_economy_repair_delta(
    checked_world_id, checked_source_command_id,
    compensation_transaction_id, compensation_transfer_id
  );
  source_transaction_id := (
    canonical_delta -> 'financialDelta' ->> 'reversalOfTransactionId'
  )::uuid;
  source_transfer_id := (
    canonical_delta -> 'titleDelta' ->> 'reversalOfTransferId'
  )::uuid;
  delta_hash_value := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain', 'worldgraph.economy-repair-delta.v1',
      'delta', canonical_delta
    )), 'UTF8'
  ), 'sha256');
  plan_body := jsonb_build_object(
    'delta', canonical_delta,
    'domain', 'worldgraph.economy-repair-plan.v1',
    'expiresAt', to_char(
      (prepared_time + interval '24 hours') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'incidentReason', checked_incident_reason,
    'pitrNotUsedReason', checked_pitr_not_used_reason,
    'preparedAt', to_char(
      prepared_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'preparedByUserId', checked_prepared_by_user_id::text,
    'reasonCode', checked_reason_code,
    'repairKind', repair_kind::text,
    'repairPlanId', repair_plan_id::text,
    'repairPlanSchemaVersion', 1,
    'reservedCommandId', reserved_command_id::text,
    'sourceCommandId', checked_source_command_id::text,
    'sourceEconomyChecksum', encode(authority.economy_checksum, 'hex'),
    'sourceEconomyHeadVersion', authority.economy_head_version::text,
    'sourceEventSequence', authority.last_event_sequence::text,
    'sourceReconciliationRunId', authority.reconciliation_run_id::text,
    'sourceStateRevision', authority.state_revision::text,
    'sourceWorldVersion', authority.world_version::text,
    'worldId', checked_world_id::text
  );
  plan_hash_value := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain', 'worldgraph.economy-repair-plan-hash.v1',
      'plan', plan_body
    )), 'UTF8'
  ), 'sha256');

  INSERT INTO public.security_audit_records(
    id, actor_user_id, world_id, category, action, outcome, reason_code,
    target_type, target_id, request_id, correlation_id, redacted_metadata,
    occurred_at
  ) VALUES (
    preparation_audit_id, checked_prepared_by_user_id, checked_world_id,
    'economy_repair', 'economy.repair.prepare', 'succeeded', checked_reason_code,
    'economy_repair_plan', repair_plan_id, repair_plan_id::text,
    repair_plan_id::text, jsonb_build_object(
      'planHash', encode(plan_hash_value, 'hex'),
      'repairKind', repair_kind::text,
      'sourceCommandId', checked_source_command_id::text
    ), prepared_time
  );
  PERFORM set_config('worldgraph.economy_repair_prepare_id', repair_plan_id::text, true);
  INSERT INTO public.economy_repair_plans(
    id, world_id, reserved_command_id, source_command_id, repair_kind,
    source_financial_transaction_id, source_asset_transfer_id,
    compensation_transaction_id, compensation_transfer_id,
    source_world_version, source_state_revision, source_event_sequence,
    source_economy_head_version, source_economy_checksum,
    source_reconciliation_run_id, canonical_delta, delta_hash, plan_hash,
    reason_code, incident_reason, pitr_not_used_reason, prepared_by_user_id,
    preparation_audit_id, prepared_at, expires_at
  ) VALUES (
    repair_plan_id, checked_world_id, reserved_command_id, checked_source_command_id,
    repair_kind, source_transaction_id, source_transfer_id,
    compensation_transaction_id, compensation_transfer_id,
    authority.world_version, authority.state_revision, authority.last_event_sequence,
    authority.economy_head_version, authority.economy_checksum,
    authority.reconciliation_run_id, canonical_delta, delta_hash_value, plan_hash_value,
    checked_reason_code::economy_repair_reason_code, checked_incident_reason,
    checked_pitr_not_used_reason, checked_prepared_by_user_id,
    preparation_audit_id, prepared_time, prepared_time + interval '24 hours'
  );
  RETURN plan_body || jsonb_build_object('planHash', encode(plan_hash_value, 'hex'));
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_prepare_economy_repair(uuid,uuid,uuid,text,text,text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_economy_repair_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE expected_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  expected_id := CASE TG_TABLE_NAME
    WHEN 'economy_repair_plans' THEN
      NULLIF(current_setting('worldgraph.economy_repair_prepare_id', true), '')::uuid
    WHEN 'economy_repair_approvals' THEN
      NULLIF(current_setting('worldgraph.economy_repair_approval_id', true), '')::uuid
    WHEN 'economy_repair_executions' THEN
      NULLIF(current_setting('worldgraph.economy_repair_execution_id', true), '')::uuid
  END;
  IF expected_id IS NULL OR NEW.id IS DISTINCT FROM expected_id THEN
    RAISE EXCEPTION '% insertion requires its narrow repair function', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER economy_repair_plans_protect
  BEFORE INSERT OR UPDATE OR DELETE ON economy_repair_plans
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_repair_evidence();
--> statement-breakpoint
CREATE TRIGGER economy_repair_approvals_protect
  BEFORE INSERT OR UPDATE OR DELETE ON economy_repair_approvals
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_repair_evidence();
--> statement-breakpoint
CREATE TRIGGER economy_repair_executions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON economy_repair_executions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_repair_evidence();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_protect_economy_repair_evidence() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_repair_plan(
  checked_repair_plan_id uuid,
  checked_requesting_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE plan_document jsonb;
BEGIN
  SELECT public.worldgraph_economy_repair_plan_body(plan.id)
      || jsonb_build_object(
        'planHash', encode(plan.plan_hash, 'hex'),
        'approvalStatus', jsonb_build_object(
          'creator', EXISTS (
            SELECT 1 FROM public.economy_repair_approvals approval
            WHERE approval.repair_plan_id = plan.id AND approval.authority_kind = 'creator'
          ),
          'platformAdmin', EXISTS (
            SELECT 1 FROM public.economy_repair_approvals approval
            WHERE approval.repair_plan_id = plan.id
              AND approval.authority_kind = 'platform_admin'
          )
        ),
        'executed', EXISTS (
          SELECT 1 FROM public.economy_repair_executions execution
          WHERE execution.repair_plan_id = plan.id
        )
      )
    INTO plan_document
  FROM public.economy_repair_plans plan
  WHERE plan.id = checked_repair_plan_id
    AND public.worldgraph_economy_repair_plan_seal_is_valid(plan.id)
    AND (
      EXISTS (
        SELECT 1 FROM public.users operator
        WHERE operator.id = checked_requesting_user_id
          AND operator.status = 'active'::user_status
          AND operator.platform_role = 'platform_admin'::platform_role
      )
      OR EXISTS (
        SELECT 1 FROM public.world_memberships membership
        WHERE membership.world_id = plan.world_id
          AND membership.user_id = checked_requesting_user_id
          AND membership.role = 'creator'::world_role
          AND membership.status = 'active'::membership_status
      )
    );
  IF plan_document IS NULL THEN
    RAISE EXCEPTION 'economy repair plan is unavailable to this actor'
      USING ERRCODE = '42501';
  END IF;
  RETURN plan_document;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_repair_plan(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_approve_economy_repair(
  checked_repair_plan_id uuid,
  checked_approver_user_id uuid,
  checked_authority_kind text,
  checked_approval_id uuid,
  checked_creator_override_id uuid,
  checked_audit_record_id uuid,
  checked_plan_hash text,
  checked_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  plan_record record;
  existing_approval record;
  approval_time timestamptz;
BEGIN
  IF checked_repair_plan_id IS NULL OR checked_approver_user_id IS NULL
    OR checked_approval_id IS NULL OR checked_audit_record_id IS NULL THEN
    RAISE EXCEPTION 'economy repair approval identities are required'
      USING ERRCODE = '22023';
  END IF;
  IF checked_confirmation IS DISTINCT FROM 'APPROVE APPEND-ONLY ECONOMY REPAIR'
    OR checked_plan_hash IS NULL OR checked_plan_hash !~ '^[a-f0-9]{64}$'
    OR checked_authority_kind IS NULL
    OR checked_authority_kind NOT IN ('creator','platform_admin') THEN
    RAISE EXCEPTION 'economy repair approval confirmation, hash, or authority is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF checked_approval_id IN (
      checked_repair_plan_id, checked_approver_user_id, checked_audit_record_id
    ) OR checked_audit_record_id IN (
      checked_repair_plan_id, checked_approver_user_id
    ) OR (checked_creator_override_id IS NOT NULL AND checked_creator_override_id IN (
      checked_repair_plan_id, checked_approver_user_id,
      checked_approval_id, checked_audit_record_id
    )) THEN
    RAISE EXCEPTION 'economy repair approval identities must be distinct'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(checked_approval_id::text, 578636432021::bigint)
  );
  SELECT approval.*, plan.plan_hash, plan.world_id AS plan_world_id
    INTO existing_approval
  FROM public.economy_repair_approvals approval
  JOIN public.economy_repair_plans plan ON plan.id = approval.repair_plan_id
  WHERE approval.id = checked_approval_id;
  IF FOUND THEN
    IF existing_approval.repair_plan_id IS DISTINCT FROM checked_repair_plan_id
      OR existing_approval.approver_user_id IS DISTINCT FROM checked_approver_user_id
      OR existing_approval.authority_kind::text IS DISTINCT FROM checked_authority_kind
      OR existing_approval.creator_override_id IS DISTINCT FROM checked_creator_override_id
      OR existing_approval.audit_record_id IS DISTINCT FROM checked_audit_record_id
      OR existing_approval.approved_plan_hash IS DISTINCT FROM decode(checked_plan_hash, 'hex')
      OR existing_approval.plan_hash IS DISTINCT FROM existing_approval.approved_plan_hash
      OR NOT public.worldgraph_economy_repair_plan_seal_is_valid(
        existing_approval.repair_plan_id
      ) THEN
      RAISE EXCEPTION 'economy repair approval id was reused with changed request bytes'
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'approvalId', existing_approval.id::text,
      'approvedAt', to_char(
        existing_approval.approved_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'approverUserId', existing_approval.approver_user_id::text,
      'authorityKind', existing_approval.authority_kind::text,
      'creatorOverrideId', existing_approval.creator_override_id::text,
      'planHash', encode(existing_approval.approved_plan_hash, 'hex'),
      'repairPlanId', existing_approval.repair_plan_id::text,
      'worldId', existing_approval.plan_world_id::text
    );
  END IF;

  SELECT plan.* INTO plan_record
  FROM public.economy_repair_plans plan
  WHERE plan.id = checked_repair_plan_id
  FOR UPDATE;
  approval_time := date_trunc('milliseconds', clock_timestamp());
  IF NOT FOUND
    OR NOT public.worldgraph_economy_repair_plan_seal_is_valid(plan_record.id)
    OR plan_record.plan_hash IS DISTINCT FROM decode(checked_plan_hash, 'hex')
    OR approval_time >= plan_record.expires_at
    OR EXISTS (
      SELECT 1 FROM public.economy_repair_executions execution
      WHERE execution.repair_plan_id = checked_repair_plan_id
    ) THEN
    RAISE EXCEPTION 'economy repair plan is missing, changed, expired, or executed'
      USING ERRCODE = '55000';
  END IF;
  PERFORM operator.id
  FROM public.users operator
  WHERE operator.id = checked_approver_user_id
  FOR UPDATE;
  IF checked_authority_kind = 'creator' THEN
    PERFORM membership.user_id
    FROM public.world_memberships membership
    WHERE membership.world_id = plan_record.world_id
      AND membership.user_id = checked_approver_user_id
    FOR UPDATE;
  END IF;
  IF checked_authority_kind = 'creator' THEN
    IF checked_creator_override_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.world_memberships membership
      WHERE membership.world_id = plan_record.world_id
        AND membership.user_id = checked_approver_user_id
        AND membership.role = 'creator'::world_role
        AND membership.status = 'active'::membership_status
    ) OR NOT EXISTS (
      SELECT 1 FROM public.users creator
      WHERE creator.id = checked_approver_user_id
        AND creator.status = 'active'::user_status
    ) THEN
      RAISE EXCEPTION 'creator repair approval requires an active world creator'
        USING ERRCODE = '42501';
    END IF;
  ELSIF checked_creator_override_id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM public.users operator
    WHERE operator.id = checked_approver_user_id
      AND operator.status = 'active'::user_status
      AND operator.platform_role = 'platform_admin'::platform_role
  ) THEN
    RAISE EXCEPTION 'platform repair approval requires an active platform administrator'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.economy_repair_approvals approval
    WHERE approval.repair_plan_id = plan_record.id
      AND (
        approval.authority_kind::text = checked_authority_kind
        OR approval.approver_user_id = checked_approver_user_id
      )
  ) THEN
    RAISE EXCEPTION 'economy repair plan already has this authority or approver'
      USING ERRCODE = '55000';
  END IF;
  approval_time := date_trunc('milliseconds', clock_timestamp());
  IF approval_time >= plan_record.expires_at THEN
    RAISE EXCEPTION 'economy repair plan is missing, changed, expired, or executed'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.security_audit_records(
    id, actor_user_id, world_id, category, action, outcome, reason_code,
    target_type, target_id, request_id, correlation_id, redacted_metadata,
    occurred_at
  ) VALUES (
    checked_audit_record_id, checked_approver_user_id, plan_record.world_id,
    'economy_repair', 'economy.repair.approve', 'allowed', 'ECONOMY_REPAIR_APPROVED',
    'economy_repair_plan', plan_record.id, checked_approval_id::text,
    plan_record.id::text, jsonb_build_object(
      'authorityKind', checked_authority_kind,
      'planHash', checked_plan_hash
    ), approval_time
  );
  IF checked_authority_kind = 'creator' THEN
    INSERT INTO public.creator_override_records(
      id, world_id, actor_user_id, action, target_type, target_id, reason,
      authority_rule_id, command_id, audit_record_id, created_at
    ) VALUES (
      checked_creator_override_id, plan_record.world_id, checked_approver_user_id,
      'economy.repair.approve', 'economy_repair_plan', plan_record.id,
      'Approved append-only economy repair', 'economy.creator_explicit_repair_approval',
      plan_record.reserved_command_id, checked_audit_record_id, approval_time
    );
  END IF;
  PERFORM set_config(
    'worldgraph.economy_repair_approval_id', checked_approval_id::text, true
  );
  INSERT INTO public.economy_repair_approvals(
    id, repair_plan_id, world_id, authority_kind, approver_user_id,
    creator_override_id, approved_plan_hash, audit_record_id, approved_at
  ) VALUES (
    checked_approval_id, plan_record.id, plan_record.world_id,
    checked_authority_kind::economy_repair_approval_authority,
    checked_approver_user_id, checked_creator_override_id,
    plan_record.plan_hash, checked_audit_record_id, approval_time
  );
  RETURN jsonb_build_object(
    'approvalId', checked_approval_id::text,
    'approvedAt', to_char(
      approval_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'approverUserId', checked_approver_user_id::text,
    'authorityKind', checked_authority_kind,
    'creatorOverrideId', checked_creator_override_id::text,
    'planHash', checked_plan_hash,
    'repairPlanId', plan_record.id::text,
    'worldId', plan_record.world_id::text
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_approve_economy_repair(
  uuid,uuid,text,uuid,uuid,uuid,text,text
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_repair_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  approval_record record;
  plan_record record;
BEGIN
  SELECT approval.* INTO approval_record
  FROM public.economy_repair_approvals approval
  WHERE approval.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT plan.* INTO plan_record
  FROM public.economy_repair_plans plan
  WHERE plan.id = approval_record.repair_plan_id;
  IF NOT FOUND
    OR NOT public.worldgraph_economy_repair_plan_seal_is_valid(plan_record.id)
    OR approval_record.world_id IS DISTINCT FROM plan_record.world_id
    OR approval_record.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash
    OR approval_record.approved_at < plan_record.prepared_at
    OR approval_record.approved_at >= plan_record.expires_at
    OR clock_timestamp() >= plan_record.expires_at THEN
    RAISE EXCEPTION 'economy repair approval missed its exact sealed review window'
      USING ERRCODE = '23514', CONSTRAINT = 'economy_repair_approval_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER economy_repair_approvals_require_exact_window
  AFTER INSERT ON economy_repair_approvals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_economy_repair_approval();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_economy_repair_approval() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_repair_write_is_open(
  checked_world_id uuid,
  checked_command_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE(
  NULLIF(current_setting('worldgraph.economy_repair_plan_id', true), '') IS NOT NULL
  AND pg_catalog.pg_has_role(session_user, pg_catalog.pg_get_userbyid((
    SELECT procedure.proowner
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'worldgraph_economy_repair_write_is_open'
      AND procedure.pronargs = 2
      AND procedure.proargtypes[0] = 'uuid'::regtype
      AND procedure.proargtypes[1] = 'uuid'::regtype
  )), 'MEMBER')
  AND EXISTS (
    SELECT 1
    FROM public.economy_repair_plans plan
    JOIN public.command_records command
      ON command.id = plan.reserved_command_id AND command.world_id = plan.world_id
    WHERE plan.id = NULLIF(
        current_setting('worldgraph.economy_repair_plan_id', true), ''
      )::uuid
      AND plan.world_id = checked_world_id
      AND plan.reserved_command_id = checked_command_id
      AND command.command_type = 'RepairWorldEconomyV1'
      AND command.actor_type = 'platform_admin'::command_actor_type
      AND command.status = 'received'::command_record_status
      AND command.payload_classification = 'private'::payload_classification
      AND command.payload = jsonb_build_object(
        'confirmation', 'APPLY APPEND-ONLY ECONOMY REPAIR',
        'repairPlanHash', encode(plan.plan_hash, 'hex'),
        'repairPlanId', plan.id::text,
        'sourceCommandId', plan.source_command_id::text
      )
  ),
  false
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_repair_write_is_open(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
ALTER FUNCTION worldgraph_open_command_write(uuid, uuid)
  RENAME TO worldgraph_open_command_write_m07;
--> statement-breakpoint
ALTER FUNCTION worldgraph_open_command_write_m07(uuid, uuid) OWNER TO CURRENT_USER;
--> statement-breakpoint
CREATE FUNCTION worldgraph_open_command_write(checked_command_id uuid, checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_type text;
  has_economy_state boolean;
  economy_command boolean;
  head_row_version bigint;
  head_checksum bytea;
BEGIN
  SELECT command.command_type INTO checked_command_type
  FROM public.command_records command
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'command write gate requires the matching received command'
      USING ERRCODE = '55000';
  END IF;
  economy_command := checked_command_type IN (
    'AdoptLegacyEconomySeedPlanV1','InitializeWorldEconomyV1','TransferCurrencyV1',
    'IssueCurrencyV1','FreezeCurrencyV1','UnfreezeCurrencyV1','FreezeWalletV1',
    'UnfreezeWalletV1','TransferAssetV1','CreateAssetTransferOfferV1',
    'CancelAssetTransferOfferV1','AcceptAssetTransferOfferV1',
    'ExpireAssetTransferOfferV1','ReconcileWorldEconomyV1','RepairWorldEconomyV1'
  );
  IF checked_command_type = 'RepairWorldEconomyV1'
    AND NOT public.worldgraph_economy_repair_write_is_open(
      checked_world_id, checked_command_id
    ) THEN
    RAISE EXCEPTION 'economy repair requires its private owner execution gate'
      USING ERRCODE = '42501';
  END IF;
  PERFORM public.worldgraph_open_command_write_m07(checked_command_id, checked_world_id);
  IF NOT economy_command THEN RETURN; END IF;

  has_economy_state := public.worldgraph_economy_runtime_state_exists(checked_world_id);
  IF has_economy_state AND checked_command_type IN (
      'AdoptLegacyEconomySeedPlanV1','InitializeWorldEconomyV1'
    ) THEN
    RAISE EXCEPTION 'economy is already initialized' USING ERRCODE = '55000';
  ELSIF has_economy_state AND checked_command_type <> 'ReconcileWorldEconomyV1' THEN
    PERFORM public.worldgraph_assert_economy_projection_current(checked_world_id);
  ELSIF NOT has_economy_state AND economy_command
    AND checked_command_type NOT IN (
      'AdoptLegacyEconomySeedPlanV1','InitializeWorldEconomyV1'
    ) THEN
    RAISE EXCEPTION 'economy is not initialized' USING ERRCODE = '55000';
  END IF;
  IF has_economy_state THEN
    SELECT head.row_version, head.checksum INTO head_row_version, head_checksum
    FROM public.world_economy_heads head WHERE head.world_id = checked_world_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'economy head is missing from initialized authority'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  INSERT INTO public.economy_command_write_snapshots(
    command_id, world_id, economy_state_exists,
    opened_head_row_version, opened_head_checksum
  ) VALUES (
    checked_command_id, checked_world_id, has_economy_state,
    head_row_version, head_checksum
  ) ON CONFLICT (command_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public.economy_command_write_snapshots snapshot
    WHERE snapshot.command_id = checked_command_id
      AND snapshot.world_id = checked_world_id
      AND snapshot.economy_state_exists = has_economy_state
      AND snapshot.opened_head_row_version IS NOT DISTINCT FROM head_row_version
      AND snapshot.opened_head_checksum IS NOT DISTINCT FROM head_checksum
  ) THEN
    RAISE EXCEPTION 'economy command write snapshot is inconsistent'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_open_command_write(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_execute_economy_repair(
  checked_repair_plan_id uuid,
  checked_executing_admin_user_id uuid,
  checked_plan_hash text,
  checked_confirmation text
)
RETURNS TABLE(
  repair_plan_id uuid,
  command_id uuid,
  event_id uuid,
  ledger_entry_id uuid,
  financial_transaction_id uuid,
  asset_transfer_id uuid,
  resulting_state_revision bigint,
  resulting_event_sequence bigint,
  resulting_ledger_sequence bigint,
  economy_checksum bytea
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  plan_record record;
  existing_execution record;
  creator_approval record;
  platform_approval record;
  authority record;
  exact_delta jsonb;
  command_payload jsonb;
  event_payload jsonb;
  event_metadata jsonb;
  ledger_details jsonb;
  execution_time timestamptz;
  execution_id_value uuid := extensions.gen_random_uuid();
  event_id_value uuid := extensions.gen_random_uuid();
  ledger_entry_id_value uuid := extensions.gen_random_uuid();
  outbox_id_value uuid := extensions.gen_random_uuid();
  execution_audit_id_value uuid := extensions.gen_random_uuid();
  next_state_revision_value bigint;
  next_event_sequence_value bigint;
  next_ledger_sequence_value bigint;
  aggregate_version_value bigint;
  current_tick_value bigint;
  economy_checksum_value bytea;
  graph_checksum_value bytea;
  ledger_previous_hash_value bytea;
  event_hash_value bytea;
  ledger_hash_value bytea;
  updated_count integer;
  expected_count integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'economy repair execution requires the database owner session'
      USING ERRCODE = '42501';
  END IF;
  IF checked_repair_plan_id IS NULL OR checked_executing_admin_user_id IS NULL THEN
    RAISE EXCEPTION 'economy repair plan and executing administrator are required'
      USING ERRCODE = '22023';
  END IF;
  IF checked_confirmation IS DISTINCT FROM 'APPLY APPEND-ONLY ECONOMY REPAIR'
    OR checked_plan_hash IS NULL OR checked_plan_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'economy repair execution confirmation or plan hash is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(checked_repair_plan_id::text, 578636432022::bigint)
  );
  SELECT plan.* INTO plan_record
  FROM public.economy_repair_plans plan
  WHERE plan.id = checked_repair_plan_id
  FOR UPDATE;
  IF NOT FOUND
    OR NOT public.worldgraph_economy_repair_plan_seal_is_valid(plan_record.id)
    OR plan_record.plan_hash IS DISTINCT FROM decode(checked_plan_hash, 'hex') THEN
    RAISE EXCEPTION 'economy repair plan is missing or its hash changed'
      USING ERRCODE = '55000';
  END IF;

  SELECT execution.* INTO existing_execution
  FROM public.economy_repair_executions execution
  WHERE execution.repair_plan_id = plan_record.id;
  IF FOUND THEN
    IF existing_execution.executed_by_user_id IS DISTINCT FROM checked_executing_admin_user_id
      OR existing_execution.command_id IS DISTINCT FROM plan_record.reserved_command_id
      OR existing_execution.source_command_id IS DISTINCT FROM plan_record.source_command_id
      OR NOT EXISTS (
        SELECT 1 FROM public.command_records command
        WHERE command.id = existing_execution.command_id
          AND command.world_id = existing_execution.world_id
          AND command.command_type = 'RepairWorldEconomyV1'
          AND command.actor_type = 'platform_admin'::command_actor_type
          AND command.actor_id = checked_executing_admin_user_id::text
          AND command.status = 'accepted'::command_record_status
          AND command.payload = jsonb_build_object(
            'confirmation', checked_confirmation,
            'repairPlanHash', checked_plan_hash,
            'repairPlanId', plan_record.id::text,
            'sourceCommandId', plan_record.source_command_id::text
          )
      ) THEN
      RAISE EXCEPTION 'economy repair execution replay changed the approved request'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT
      existing_execution.repair_plan_id,
      existing_execution.command_id,
      existing_execution.event_id,
      existing_execution.ledger_entry_id,
      existing_execution.financial_transaction_id,
      existing_execution.asset_transfer_id,
      existing_execution.resulting_state_revision,
      existing_execution.resulting_event_sequence,
      existing_execution.resulting_ledger_sequence,
      existing_execution.resulting_economy_checksum;
    RETURN;
  END IF;

  PERFORM public.worldgraph_lock_world_compilation(plan_record.world_id);
  SELECT approval.* INTO creator_approval
  FROM public.economy_repair_approvals approval
  WHERE approval.repair_plan_id = plan_record.id
    AND approval.authority_kind = 'creator'::economy_repair_approval_authority
  FOR UPDATE;
  SELECT approval.* INTO platform_approval
  FROM public.economy_repair_approvals approval
  WHERE approval.repair_plan_id = plan_record.id
    AND approval.authority_kind = 'platform_admin'::economy_repair_approval_authority
  FOR UPDATE;
  PERFORM operator.id
  FROM public.users operator
  WHERE operator.id IN (
    creator_approval.approver_user_id,
    platform_approval.approver_user_id
  )
  ORDER BY operator.id
  FOR UPDATE;
  PERFORM membership.user_id
  FROM public.world_memberships membership
  WHERE membership.world_id = plan_record.world_id
    AND membership.user_id = creator_approval.approver_user_id
  ORDER BY membership.user_id
  FOR UPDATE;
  execution_time := date_trunc('milliseconds', clock_timestamp());
  IF execution_time >= plan_record.expires_at THEN
    RAISE EXCEPTION 'economy repair plan has expired' USING ERRCODE = '55000';
  END IF;
  IF creator_approval.id IS NULL OR platform_approval.id IS NULL
    OR creator_approval.approver_user_id = platform_approval.approver_user_id
    OR creator_approval.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash
    OR platform_approval.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash
    OR platform_approval.approver_user_id IS DISTINCT FROM checked_executing_admin_user_id
    OR NOT EXISTS (
      SELECT 1 FROM public.users operator
      WHERE operator.id = checked_executing_admin_user_id
        AND operator.status = 'active'::user_status
        AND operator.platform_role = 'platform_admin'::platform_role
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.world_memberships membership
      WHERE membership.world_id = plan_record.world_id
        AND membership.user_id = creator_approval.approver_user_id
        AND membership.role = 'creator'::world_role
        AND membership.status = 'active'::membership_status
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.users creator
      WHERE creator.id = creator_approval.approver_user_id
        AND creator.status = 'active'::user_status
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.creator_override_records override
      JOIN public.security_audit_records audit
        ON audit.id = override.audit_record_id
       AND audit.world_id = override.world_id
       AND audit.actor_user_id = override.actor_user_id
      WHERE override.id = creator_approval.creator_override_id
        AND override.world_id = plan_record.world_id
        AND override.actor_user_id = creator_approval.approver_user_id
        AND override.action = 'economy.repair.approve'
        AND override.target_type = 'economy_repair_plan'
        AND override.target_id = plan_record.id
        AND override.reason = 'Approved append-only economy repair'
        AND override.authority_rule_id = 'economy.creator_explicit_repair_approval'
        AND override.command_id = plan_record.reserved_command_id
        AND override.audit_record_id = creator_approval.audit_record_id
        AND audit.category = 'economy_repair'
        AND audit.action = 'economy.repair.approve'
        AND audit.outcome = 'allowed'
        AND audit.reason_code = 'ECONOMY_REPAIR_APPROVED'
        AND audit.target_type = 'economy_repair_plan'
        AND audit.target_id = plan_record.id
        AND audit.redacted_metadata = jsonb_build_object(
          'authorityKind', 'creator', 'planHash', checked_plan_hash
        )
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.security_audit_records audit
      WHERE audit.id = platform_approval.audit_record_id
        AND audit.world_id = plan_record.world_id
        AND audit.actor_user_id = platform_approval.approver_user_id
        AND audit.category = 'economy_repair'
        AND audit.action = 'economy.repair.approve'
        AND audit.outcome = 'allowed'
        AND audit.reason_code = 'ECONOMY_REPAIR_APPROVED'
        AND audit.target_type = 'economy_repair_plan'
        AND audit.target_id = plan_record.id
        AND audit.redacted_metadata = jsonb_build_object(
          'authorityKind', 'platform_admin', 'planHash', checked_plan_hash
        )
    ) THEN
    RAISE EXCEPTION 'economy repair requires exact distinct creator and executing-admin approvals'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.worldgraph_assert_economy_projection_current(plan_record.world_id);
  SELECT runtime.state_revision, runtime.last_event_sequence,
         runtime.last_ledger_sequence, runtime.projection_checksum,
         version.version_number AS world_version,
         head.row_version AS economy_head_version, head.checksum AS economy_checksum,
         head.updated_state_revision AS economy_updated_state_revision,
         head.last_reconciliation_run_id,
         ledger.next_event_sequence, ledger.next_ledger_sequence,
         COALESCE(ledger.last_entry_hash, decode(repeat('00', 32), 'hex')) AS previous_hash,
         clock.current_tick,
         run.status AS reconciliation_status, run.mismatch_count
    INTO authority
  FROM public.world_runtime_heads runtime
  JOIN public.world_versions version
    ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
  JOIN public.world_economy_heads head ON head.world_id = runtime.world_id
  JOIN public.world_ledger_heads ledger ON ledger.world_id = runtime.world_id
  JOIN public.world_simulation_clocks clock ON clock.world_id = runtime.world_id
  JOIN public.economy_reconciliation_runs run
    ON run.world_id = head.world_id AND run.id = head.last_reconciliation_run_id
  WHERE runtime.world_id = plan_record.world_id
  FOR UPDATE OF runtime, head, ledger;
  execution_time := date_trunc('milliseconds', clock_timestamp());
  IF execution_time >= plan_record.expires_at THEN
    RAISE EXCEPTION 'economy repair plan has expired' USING ERRCODE = '55000';
  END IF;
  IF NOT FOUND
    OR authority.state_revision IS DISTINCT FROM plan_record.source_state_revision
    OR authority.last_event_sequence IS DISTINCT FROM plan_record.source_event_sequence
    OR authority.world_version IS DISTINCT FROM plan_record.source_world_version
    OR authority.economy_head_version IS DISTINCT FROM plan_record.source_economy_head_version
    OR authority.economy_checksum IS DISTINCT FROM plan_record.source_economy_checksum
    OR authority.economy_updated_state_revision IS DISTINCT FROM plan_record.source_state_revision
    OR authority.last_reconciliation_run_id IS DISTINCT FROM
      plan_record.source_reconciliation_run_id
    OR authority.reconciliation_status <> 'matched'::economy_reconciliation_run_status
    OR authority.mismatch_count <> 0
    OR authority.next_event_sequence <> authority.last_event_sequence + 1
    OR authority.next_ledger_sequence <> authority.last_ledger_sequence + 1
    OR authority.projection_checksum IS DISTINCT FROM
      public.worldgraph_projection_checksum(plan_record.world_id)
    OR EXISTS (
      SELECT 1 FROM public.command_records command
      WHERE command.id = plan_record.reserved_command_id
    ) THEN
    RAISE EXCEPTION 'economy repair authority changed after preparation'
      USING ERRCODE = '55000';
  END IF;
  exact_delta := public.worldgraph_derive_economy_repair_delta(
    plan_record.world_id,
    plan_record.source_command_id,
    plan_record.compensation_transaction_id,
    plan_record.compensation_transfer_id
  );
  IF exact_delta IS DISTINCT FROM plan_record.canonical_delta THEN
    RAISE EXCEPTION 'economy repair source or current compensation preconditions changed'
      USING ERRCODE = '55000';
  END IF;

  next_state_revision_value := authority.state_revision + 1;
  next_event_sequence_value := authority.next_event_sequence;
  next_ledger_sequence_value := authority.next_ledger_sequence;
  current_tick_value := authority.current_tick;
  ledger_previous_hash_value := authority.previous_hash;
  SELECT COALESCE((
    SELECT stream.current_version + 1
    FROM public.aggregate_stream_heads stream
    WHERE stream.world_id = plan_record.world_id
      AND stream.aggregate_type = 'world_economy'
      AND stream.aggregate_id = plan_record.world_id::text
  ), 1) INTO aggregate_version_value;

  command_payload := jsonb_build_object(
    'confirmation', checked_confirmation,
    'repairPlanHash', checked_plan_hash,
    'repairPlanId', plan_record.id::text,
    'sourceCommandId', plan_record.source_command_id::text
  );
  INSERT INTO public.command_records(
    id, world_id, command_type, command_schema_version, actor_type, actor_id,
    payload, payload_hash, payload_classification, idempotency_key, request_hash,
    expected_world_version, expected_state_revision, correlation_id, causation_id,
    requested_at
  ) VALUES (
    plan_record.reserved_command_id, plan_record.world_id,
    'RepairWorldEconomyV1', 1, 'platform_admin',
    checked_executing_admin_user_id::text, command_payload,
    extensions.digest(convert_to(
      public.worldgraph_canonical_jsonb(command_payload), 'UTF8'
    ), 'sha256'),
    'private', 'economy-repair-' || plan_record.id::text,
    extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
      'actorId', checked_executing_admin_user_id::text,
      'actorType', 'platform_admin',
      'commandType', 'RepairWorldEconomyV1',
      'payload', command_payload,
      'worldId', plan_record.world_id::text
    )), 'UTF8'), 'sha256'),
    plan_record.source_world_version, plan_record.source_state_revision,
    plan_record.reserved_command_id, plan_record.source_command_id, execution_time
  );
  PERFORM set_config('worldgraph.economy_repair_plan_id', plan_record.id::text, true);
  PERFORM public.worldgraph_open_command_write(
    plan_record.reserved_command_id, plan_record.world_id
  );

  IF plan_record.compensation_transaction_id IS NOT NULL THEN
    INSERT INTO public.financial_transactions(
      id, world_id, currency_id, transaction_kind, supply_delta_minor,
      command_id, event_id, memo_code, memo_text, reversal_of_transaction_id,
      occurred_tick, state_revision, created_at
    ) VALUES (
      plan_record.compensation_transaction_id, plan_record.world_id,
      (exact_delta -> 'financialDelta' ->> 'currencyId')::uuid,
      'compensation',
      (exact_delta -> 'financialDelta' -> 'supply'
        ->> 'compensationSupplyDeltaMinor')::bigint,
      plan_record.reserved_command_id, event_id_value,
      'economy_repair', NULL, plan_record.source_financial_transaction_id,
      current_tick_value, next_state_revision_value, execution_time
    );
    INSERT INTO public.wallet_postings(
      id, transaction_id, world_id, currency_id, wallet_id,
      posting_ordinal, signed_amount_minor, created_at
    )
    SELECT extensions.gen_random_uuid(), plan_record.compensation_transaction_id,
           plan_record.world_id,
           (exact_delta -> 'financialDelta' ->> 'currencyId')::uuid,
           (posting.value ->> 'walletId')::uuid,
           (posting.value ->> 'sourcePostingOrdinal')::integer,
           (posting.value ->> 'compensationSignedAmountMinor')::bigint,
           execution_time
    FROM jsonb_array_elements(
      exact_delta -> 'financialDelta' -> 'postings'
    ) WITH ORDINALITY posting(value, ordinal)
    ORDER BY posting.ordinal;

    WITH changes AS (
      SELECT (posting.value ->> 'walletId')::uuid AS wallet_id,
             (posting.value ->> 'balanceBeforeMinor')::bigint AS before_minor,
             (posting.value ->> 'balanceAfterMinor')::bigint AS after_minor,
             (posting.value ->> 'balanceVersionBefore')::bigint AS before_version,
             (posting.value ->> 'balanceVersionAfter')::bigint AS after_version
      FROM jsonb_array_elements(
        exact_delta -> 'financialDelta' -> 'postings'
      ) posting(value)
    )
    UPDATE public.wallet_balances balance
    SET available_minor = changes.after_minor,
        row_version = changes.after_version,
        updated_state_revision = next_state_revision_value,
        updated_at = greatest(balance.updated_at, execution_time)
    FROM changes
    WHERE balance.world_id = plan_record.world_id
      AND balance.wallet_id = changes.wallet_id
      AND balance.currency_id = (exact_delta -> 'financialDelta' ->> 'currencyId')::uuid
      AND balance.available_minor = changes.before_minor
      AND balance.row_version = changes.before_version;
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    expected_count := jsonb_array_length(exact_delta -> 'financialDelta' -> 'postings');
    IF updated_count <> expected_count THEN
      RAISE EXCEPTION 'economy repair wallet balances changed during execution'
        USING ERRCODE = '40001';
    END IF;

    IF (exact_delta -> 'financialDelta' -> 'supply'
        ->> 'compensationSupplyDeltaMinor')::bigint <> 0 THEN
      UPDATE public.currency_supply supply
      SET current_supply_minor = (
            exact_delta -> 'financialDelta' -> 'supply' ->> 'supplyAfterMinor'
          )::bigint,
          row_version = (
            exact_delta -> 'financialDelta' -> 'supply' ->> 'supplyVersionAfter'
          )::bigint,
          updated_state_revision = next_state_revision_value,
          updated_at = greatest(supply.updated_at, execution_time)
      WHERE supply.world_id = plan_record.world_id
        AND supply.currency_id = (
          exact_delta -> 'financialDelta' -> 'supply' ->> 'currencyId'
        )::uuid
        AND supply.current_supply_minor = (
          exact_delta -> 'financialDelta' -> 'supply' ->> 'supplyBeforeMinor'
        )::bigint
        AND supply.row_version = (
          exact_delta -> 'financialDelta' -> 'supply' ->> 'supplyVersionBefore'
        )::bigint;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'economy repair currency supply changed during execution'
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END IF;

  IF plan_record.compensation_transfer_id IS NOT NULL THEN
    INSERT INTO public.asset_transfers(
      id, world_id, asset_id, from_owner_entity_id, to_owner_entity_id,
      transfer_kind, financial_transaction_id, command_id, event_id,
      occurred_tick, state_revision, created_at, reversal_of_transfer_id
    ) VALUES (
      plan_record.compensation_transfer_id, plan_record.world_id,
      (exact_delta -> 'titleDelta' ->> 'assetId')::uuid,
      (exact_delta -> 'titleDelta' ->> 'fromOwnerEntityId')::uuid,
      (exact_delta -> 'titleDelta' ->> 'toOwnerEntityId')::uuid,
      'compensation', NULL, plan_record.reserved_command_id, event_id_value,
      current_tick_value, next_state_revision_value, execution_time,
      plan_record.source_asset_transfer_id
    );
    UPDATE public.asset_ownership ownership
    SET owner_entity_id = (exact_delta -> 'titleDelta' ->> 'toOwnerEntityId')::uuid,
        ownership_version = (
          exact_delta -> 'titleDelta' ->> 'ownershipVersionAfter'
        )::bigint,
        acquired_event_id = event_id_value,
        updated_state_revision = next_state_revision_value,
        updated_at = greatest(ownership.updated_at, execution_time)
    WHERE ownership.world_id = plan_record.world_id
      AND ownership.asset_id = (exact_delta -> 'titleDelta' ->> 'assetId')::uuid
      AND ownership.owner_entity_id = (
        exact_delta -> 'titleDelta' ->> 'fromOwnerEntityId'
      )::uuid
      AND ownership.ownership_version = (
        exact_delta -> 'titleDelta' ->> 'ownershipVersionBefore'
      )::bigint;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'economy repair asset title changed during execution'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  economy_checksum_value := public.worldgraph_economy_projection_checksum(
    plan_record.world_id
  );
  UPDATE public.world_economy_heads head
  SET checksum = economy_checksum_value,
      row_version = head.row_version + 1,
      updated_state_revision = next_state_revision_value,
      reconciliation_status = 'pending',
      last_reconciled_state_revision = NULL,
      last_reconciliation_run_id = NULL,
      updated_at = greatest(head.updated_at, execution_time)
  WHERE head.world_id = plan_record.world_id
    AND head.row_version = plan_record.source_economy_head_version
    AND head.checksum = plan_record.source_economy_checksum;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy repair head changed during execution'
      USING ERRCODE = '40001';
  END IF;

  event_payload := jsonb_build_object(
    'compensationTransactionId', plan_record.compensation_transaction_id::text,
    'compensationTransferId', plan_record.compensation_transfer_id::text,
    'reasonCode', plan_record.reason_code::text,
    'repairKind', plan_record.repair_kind::text,
    'repairPlanHash', checked_plan_hash,
    'repairPlanId', plan_record.id::text,
    'sourceCommandId', plan_record.source_command_id::text
  );
  event_metadata := jsonb_build_object(
    'actor', jsonb_build_object(
      'actorId', checked_executing_admin_user_id::text,
      'actorType', 'platform_admin'
    ),
    'authorizationRuleId', 'operations.economy.repair.execute',
    'causationId', plan_record.source_command_id::text,
    'commandSchemaVersion', 1,
    'commandType', 'RepairWorldEconomyV1',
    'correlationId', plan_record.reserved_command_id::text,
    'overrideId', creator_approval.creator_override_id::text,
    'payloadClassification', 'private'
  );
  event_hash_value := public.worldgraph_domain_event_hash_v1(
    event_id_value, plan_record.world_id, next_event_sequence_value,
    plan_record.reserved_command_id, 0, 'world_economy',
    plan_record.world_id::text, aggregate_version_value,
    'WorldEconomyRepairedV1', 1, event_payload, event_metadata,
    execution_time, execution_time, next_state_revision_value
  );
  INSERT INTO public.domain_events(
    id, world_id, world_event_sequence, command_id, event_ordinal,
    aggregate_type, aggregate_id, aggregate_version, event_type,
    event_schema_version, payload, metadata, event_hash, occurred_at,
    recorded_at, resulting_state_revision
  ) VALUES (
    event_id_value, plan_record.world_id, next_event_sequence_value,
    plan_record.reserved_command_id, 0, 'world_economy', plan_record.world_id::text,
    aggregate_version_value, 'WorldEconomyRepairedV1', 1,
    event_payload, event_metadata, event_hash_value,
    execution_time, execution_time, next_state_revision_value
  );

  ledger_details := jsonb_build_object(
    'creatorApprovalId', creator_approval.id::text,
    'eventType', 'WorldEconomyRepairedV1',
    'executedByUserId', checked_executing_admin_user_id::text,
    'platformAdminApprovalId', platform_approval.id::text,
    'repairKind', plan_record.repair_kind::text
  );
  ledger_hash_value := public.worldgraph_ledger_entry_hash_v1(
    ledger_entry_id_value, plan_record.world_id, next_ledger_sequence_value,
    'repair_anchor', plan_record.reserved_command_id, event_id_value,
    'platform_admin', checked_executing_admin_user_id::text,
    'WORLD_ECONOMY_REPAIRED', ledger_details,
    ledger_previous_hash_value, execution_time
  );
  INSERT INTO public.ledger_entries(
    id, world_id, ledger_sequence, entry_kind, command_id, event_id,
    actor_type, actor_id, public_summary_code, redacted_details,
    previous_hash, entry_hash, recorded_at
  ) VALUES (
    ledger_entry_id_value, plan_record.world_id, next_ledger_sequence_value,
    'repair_anchor', plan_record.reserved_command_id, event_id_value,
    'platform_admin', checked_executing_admin_user_id::text,
    'WORLD_ECONOMY_REPAIRED', ledger_details,
    ledger_previous_hash_value, ledger_hash_value, execution_time
  );

  graph_checksum_value := public.worldgraph_projection_checksum(
    plan_record.world_id, next_state_revision_value
  );
  UPDATE public.world_runtime_heads runtime
  SET state_revision = next_state_revision_value,
      last_event_sequence = next_event_sequence_value,
      last_ledger_sequence = next_ledger_sequence_value,
      projection_checksum = graph_checksum_value,
      updated_at = greatest(runtime.updated_at, execution_time)
  WHERE runtime.world_id = plan_record.world_id
    AND runtime.state_revision = plan_record.source_state_revision
    AND runtime.last_event_sequence = plan_record.source_event_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy repair runtime head changed during execution'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.projection_checkpoints checkpoint
  SET last_event_sequence = next_event_sequence_value,
      checksum = graph_checksum_value,
      status = 'current',
      updated_at = greatest(checkpoint.updated_at, execution_time)
  WHERE checkpoint.world_id = plan_record.world_id
    AND checkpoint.projection_name = 'world_graph';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy repair world graph checkpoint is missing'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.outbox_messages(
    id, world_id, event_id, message_type, message_schema_version,
    payload, status, attempts, available_at, created_at
  ) VALUES (
    outbox_id_value, plan_record.world_id, event_id_value,
    'DomainEventReferenceV1', 1, jsonb_build_object(
      'eventId', event_id_value::text,
      'eventType', 'WorldEconomyRepairedV1',
      'worldEventSequence', next_event_sequence_value::text,
      'worldId', plan_record.world_id::text
    ), 'pending', 0, execution_time, execution_time
  );
  INSERT INTO public.world_history_entries(
    world_id, ledger_sequence, command_id, event_id, event_type, occurred_at,
    category, title_key, summary_args, actor_type, actor_id,
    target_type, target_id, visibility, correlation_id, resulting_state_revision
  ) VALUES (
    plan_record.world_id, next_ledger_sequence_value,
    plan_record.reserved_command_id, event_id_value, 'WorldEconomyRepairedV1',
    execution_time, 'repair', 'history.economy.repair_applied',
    jsonb_build_object(
      'reasonCode', plan_record.reason_code::text,
      'repairKind', plan_record.repair_kind::text
    ), 'platform_admin', checked_executing_admin_user_id::text,
    'world_economy', plan_record.world_id::text, 'member',
    plan_record.reserved_command_id, next_state_revision_value
  );

  WITH affected_entities AS (
    SELECT wallet.owner_entity_id AS entity_id
    FROM public.wallet_postings posting
    JOIN public.wallets wallet
      ON wallet.world_id = posting.world_id
     AND wallet.currency_id = posting.currency_id
     AND wallet.id = posting.wallet_id
    WHERE posting.transaction_id = plan_record.source_financial_transaction_id
    UNION
    SELECT source.from_owner_entity_id
    FROM public.asset_transfers source
    WHERE source.world_id = plan_record.world_id
      AND source.id = plan_record.source_asset_transfer_id
    UNION
    SELECT source.to_owner_entity_id
    FROM public.asset_transfers source
    WHERE source.world_id = plan_record.world_id
      AND source.id = plan_record.source_asset_transfer_id
  ), controlled_participants AS (
    SELECT DISTINCT ON (controller.user_id)
           controller.user_id, affected.entity_id
    FROM affected_entities affected
    JOIN public.world_entity_controllers controller
      ON controller.world_id = plan_record.world_id
     AND controller.entity_id = affected.entity_id
     AND controller.revoked_at IS NULL
    JOIN public.world_memberships membership
      ON membership.world_id = controller.world_id
     AND membership.user_id = controller.user_id
     AND membership.status = 'active'::membership_status
    WHERE affected.entity_id IS NOT NULL
    ORDER BY controller.user_id, affected.entity_id
  )
  INSERT INTO public.economy_participant_history(
    world_id, ledger_sequence, user_id, participant_entity_id,
    counterparty_entity_id, command_id, event_id, category,
    summary_code, summary_args, visibility, state_revision, created_at
  )
  SELECT plan_record.world_id, next_ledger_sequence_value,
         participant.user_id, participant.entity_id, NULL,
         plan_record.reserved_command_id, event_id_value, 'repair',
         'WORLD_ECONOMY_REPAIRED', jsonb_build_object(
           'reasonCode', plan_record.reason_code::text,
           'repairKind', plan_record.repair_kind::text
         ), 'participant', next_state_revision_value, execution_time
  FROM controlled_participants participant;

  INSERT INTO public.security_audit_records(
    id, actor_user_id, world_id, category, action, outcome, reason_code,
    target_type, target_id, request_id, correlation_id, redacted_metadata,
    occurred_at
  ) VALUES (
    execution_audit_id_value, checked_executing_admin_user_id,
    plan_record.world_id, 'economy_repair', 'economy.repair.execute',
    'succeeded', plan_record.reason_code::text, 'economy_repair_plan',
    plan_record.id, plan_record.reserved_command_id::text, plan_record.id::text,
    jsonb_build_object(
      'planHash', checked_plan_hash,
      'repairKind', plan_record.repair_kind::text,
      'sourceCommandId', plan_record.source_command_id::text
    ), execution_time
  );
  PERFORM set_config(
    'worldgraph.economy_repair_execution_id', execution_id_value::text, true
  );
  INSERT INTO public.economy_repair_executions(
    id, repair_plan_id, world_id, source_command_id, command_id, event_id,
    ledger_entry_id, financial_transaction_id, asset_transfer_id,
    executed_by_user_id, execution_audit_id, resulting_state_revision,
    resulting_event_sequence, resulting_ledger_sequence,
    resulting_economy_head_version, resulting_economy_checksum, executed_at
  ) VALUES (
    execution_id_value, plan_record.id, plan_record.world_id,
    plan_record.source_command_id, plan_record.reserved_command_id,
    event_id_value, ledger_entry_id_value, plan_record.compensation_transaction_id,
    plan_record.compensation_transfer_id, checked_executing_admin_user_id,
    execution_audit_id_value, next_state_revision_value,
    next_event_sequence_value, next_ledger_sequence_value,
    plan_record.source_economy_head_version + 1,
    economy_checksum_value, execution_time
  );

  UPDATE public.command_records command
  SET status = 'accepted',
      authorization_rule_id = 'operations.economy.repair.execute',
      override_id = creator_approval.creator_override_id,
      decided_at = execution_time,
      resulting_state_revision = next_state_revision_value,
      response_summary = jsonb_build_object(
        'commandId', plan_record.reserved_command_id::text,
        'eventIds', jsonb_build_array(event_id_value::text),
        'eventSequenceRange', jsonb_build_object(
          'from', next_event_sequence_value::text,
          'to', next_event_sequence_value::text
        ),
        'ledgerSequenceRange', jsonb_build_object(
          'from', next_ledger_sequence_value::text,
          'to', next_ledger_sequence_value::text
        ),
        'repairPlanId', plan_record.id::text,
        'resultingStateRevision', next_state_revision_value::text,
        'schemaVersion', 1,
        'status', 'accepted'
      )
  WHERE command.id = plan_record.reserved_command_id
    AND command.world_id = plan_record.world_id
    AND command.status = 'received'::command_record_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'economy repair command could not reach its terminal state'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY SELECT
    plan_record.id,
    plan_record.reserved_command_id,
    event_id_value,
    ledger_entry_id_value,
    plan_record.compensation_transaction_id,
    plan_record.compensation_transfer_id,
    next_state_revision_value,
    next_event_sequence_value,
    next_ledger_sequence_value,
    economy_checksum_value;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_execute_economy_repair(uuid,uuid,text,text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_repair_execution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  execution_record record;
  plan_record record;
  command_record record;
  event_record record;
  ledger_record record;
  creator_approval record;
  platform_approval record;
  runtime_record record;
  head_record record;
BEGIN
  SELECT execution.* INTO execution_record
  FROM public.economy_repair_executions execution
  WHERE execution.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT plan.* INTO plan_record
  FROM public.economy_repair_plans plan
  WHERE plan.id = execution_record.repair_plan_id
    AND plan.world_id = execution_record.world_id;
  SELECT command.* INTO command_record
  FROM public.command_records command
  WHERE command.id = execution_record.command_id
    AND command.world_id = execution_record.world_id;
  SELECT event.* INTO event_record
  FROM public.domain_events event
  WHERE event.id = execution_record.event_id
    AND event.world_id = execution_record.world_id;
  SELECT entry.* INTO ledger_record
  FROM public.ledger_entries entry
  WHERE entry.id = execution_record.ledger_entry_id
    AND entry.world_id = execution_record.world_id;
  SELECT approval.* INTO creator_approval
  FROM public.economy_repair_approvals approval
  WHERE approval.repair_plan_id = execution_record.repair_plan_id
    AND approval.authority_kind = 'creator'::economy_repair_approval_authority;
  SELECT approval.* INTO platform_approval
  FROM public.economy_repair_approvals approval
  WHERE approval.repair_plan_id = execution_record.repair_plan_id
    AND approval.authority_kind = 'platform_admin'::economy_repair_approval_authority;
  SELECT runtime.* INTO runtime_record
  FROM public.world_runtime_heads runtime
  WHERE runtime.world_id = execution_record.world_id;
  SELECT head.* INTO head_record
  FROM public.world_economy_heads head
  WHERE head.world_id = execution_record.world_id;

  IF plan_record.id IS NULL OR command_record.id IS NULL OR event_record.id IS NULL
    OR ledger_record.id IS NULL OR creator_approval.id IS NULL
    OR platform_approval.id IS NULL OR runtime_record.world_id IS NULL
    OR head_record.world_id IS NULL
    OR execution_record.source_command_id IS DISTINCT FROM plan_record.source_command_id
    OR execution_record.command_id IS DISTINCT FROM plan_record.reserved_command_id
    OR execution_record.financial_transaction_id IS DISTINCT FROM
      plan_record.compensation_transaction_id
    OR execution_record.asset_transfer_id IS DISTINCT FROM plan_record.compensation_transfer_id
    OR execution_record.executed_at < plan_record.prepared_at
    OR execution_record.executed_at >= plan_record.expires_at
    OR clock_timestamp() >= plan_record.expires_at
    OR execution_record.resulting_state_revision <> plan_record.source_state_revision + 1
    OR execution_record.resulting_event_sequence <> plan_record.source_event_sequence + 1
    OR execution_record.resulting_economy_head_version <>
      plan_record.source_economy_head_version + 1
    OR execution_record.executed_by_user_id IS DISTINCT FROM
      platform_approval.approver_user_id
    OR creator_approval.approver_user_id = platform_approval.approver_user_id
    OR creator_approval.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash
    OR platform_approval.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash
    OR command_record.command_type <> 'RepairWorldEconomyV1'
    OR command_record.command_schema_version <> 1
    OR command_record.actor_type <> 'platform_admin'::command_actor_type
    OR command_record.actor_id <> execution_record.executed_by_user_id::text
    OR command_record.payload_classification <> 'private'::payload_classification
    OR command_record.payload <> jsonb_build_object(
      'confirmation', 'APPLY APPEND-ONLY ECONOMY REPAIR',
      'repairPlanHash', encode(plan_record.plan_hash, 'hex'),
      'repairPlanId', plan_record.id::text,
      'sourceCommandId', plan_record.source_command_id::text
    )
    OR command_record.status <> 'accepted'::command_record_status
    OR command_record.authorization_rule_id <> 'operations.economy.repair.execute'
    OR command_record.override_id IS DISTINCT FROM creator_approval.creator_override_id
    OR command_record.correlation_id IS DISTINCT FROM plan_record.reserved_command_id
    OR command_record.causation_id IS DISTINCT FROM plan_record.source_command_id
    OR command_record.resulting_state_revision IS DISTINCT FROM
      execution_record.resulting_state_revision
    OR event_record.command_id IS DISTINCT FROM execution_record.command_id
    OR event_record.event_ordinal <> 0
    OR event_record.event_type <> 'WorldEconomyRepairedV1'
    OR event_record.aggregate_type <> 'world_economy'
    OR event_record.aggregate_id <> execution_record.world_id::text
    OR event_record.world_event_sequence <>
      execution_record.resulting_event_sequence
    OR event_record.resulting_state_revision <>
      execution_record.resulting_state_revision
    OR event_record.recorded_at IS DISTINCT FROM execution_record.executed_at
    OR ledger_record.ledger_sequence <> execution_record.resulting_ledger_sequence
    OR ledger_record.entry_kind <> 'repair_anchor'::ledger_entry_kind
    OR ledger_record.command_id IS DISTINCT FROM execution_record.command_id
    OR ledger_record.event_id IS DISTINCT FROM execution_record.event_id
    OR ledger_record.actor_type <> 'platform_admin'::command_actor_type
    OR ledger_record.actor_id <> execution_record.executed_by_user_id::text
    OR ledger_record.public_summary_code <> 'WORLD_ECONOMY_REPAIRED'
    OR ledger_record.redacted_details <> jsonb_build_object(
      'creatorApprovalId', creator_approval.id::text,
      'eventType', 'WorldEconomyRepairedV1',
      'executedByUserId', execution_record.executed_by_user_id::text,
      'platformAdminApprovalId', platform_approval.id::text,
      'repairKind', plan_record.repair_kind::text
    )
    OR ledger_record.recorded_at IS DISTINCT FROM execution_record.executed_at
    OR runtime_record.state_revision <> execution_record.resulting_state_revision
    OR runtime_record.last_event_sequence <> execution_record.resulting_event_sequence
    OR runtime_record.last_ledger_sequence <> execution_record.resulting_ledger_sequence
    OR runtime_record.projection_checksum IS DISTINCT FROM
      public.worldgraph_projection_checksum(execution_record.world_id)
    OR head_record.row_version <> execution_record.resulting_economy_head_version
    OR head_record.updated_state_revision <> execution_record.resulting_state_revision
    OR head_record.checksum IS DISTINCT FROM execution_record.resulting_economy_checksum
    OR head_record.checksum IS DISTINCT FROM
      public.worldgraph_economy_projection_checksum(execution_record.world_id)
    OR head_record.reconciliation_status <> 'pending'::economy_reconciliation_status
    OR head_record.last_reconciled_state_revision IS NOT NULL
    OR head_record.last_reconciliation_run_id IS NOT NULL
    OR (SELECT count(*) FROM public.domain_events event
        WHERE event.command_id = execution_record.command_id) <> 1
    OR (SELECT count(*) FROM public.ledger_entries entry
        WHERE entry.command_id = execution_record.command_id) <> 1
    OR NOT public.worldgraph_economy_command_mutation_set_is_exact(
      execution_record.command_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.projection_checkpoints checkpoint
      WHERE checkpoint.world_id = execution_record.world_id
        AND checkpoint.projection_name = 'world_graph'
        AND checkpoint.projection_schema_version = 1
        AND checkpoint.status = 'current'::projection_checkpoint_status
        AND checkpoint.last_event_sequence = execution_record.resulting_event_sequence
        AND checkpoint.checksum = runtime_record.projection_checksum
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.projection_checkpoints checkpoint
      WHERE checkpoint.world_id = execution_record.world_id
        AND checkpoint.projection_name = 'simulation_runtime'
        AND checkpoint.projection_schema_version = 1
        AND checkpoint.status = 'current'::projection_checkpoint_status
        AND checkpoint.last_event_sequence = execution_record.resulting_event_sequence
        AND checkpoint.checksum =
          public.worldgraph_simulation_projection_checksum(execution_record.world_id)
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.projection_checkpoints checkpoint
      WHERE checkpoint.world_id = execution_record.world_id
        AND checkpoint.projection_name = 'economy_runtime'
        AND checkpoint.projection_schema_version = 1
        AND checkpoint.status = 'current'::projection_checkpoint_status
        AND checkpoint.last_event_sequence = execution_record.resulting_event_sequence
        AND checkpoint.checksum = execution_record.resulting_economy_checksum
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.security_audit_records audit
      WHERE audit.id = execution_record.execution_audit_id
        AND audit.world_id = execution_record.world_id
        AND audit.actor_user_id = execution_record.executed_by_user_id
        AND audit.category = 'economy_repair'
        AND audit.action = 'economy.repair.execute'
        AND audit.outcome = 'succeeded'
        AND audit.reason_code = plan_record.reason_code::text
        AND audit.target_type = 'economy_repair_plan'
        AND audit.target_id = plan_record.id
        AND audit.request_id = execution_record.command_id::text
        AND audit.correlation_id = plan_record.id::text
        AND audit.redacted_metadata = jsonb_build_object(
          'planHash', encode(plan_record.plan_hash, 'hex'),
          'repairKind', plan_record.repair_kind::text,
          'sourceCommandId', plan_record.source_command_id::text
        )
        AND audit.occurred_at = execution_record.executed_at
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.outbox_messages message
      WHERE message.world_id = execution_record.world_id
        AND message.event_id = execution_record.event_id
        AND message.message_type = 'DomainEventReferenceV1'
        AND message.message_schema_version = 1
        AND message.payload = jsonb_build_object(
          'eventId', execution_record.event_id::text,
          'eventType', 'WorldEconomyRepairedV1',
          'worldEventSequence', execution_record.resulting_event_sequence::text,
          'worldId', execution_record.world_id::text
        )
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.world_history_entries history
      WHERE history.world_id = execution_record.world_id
        AND history.ledger_sequence = execution_record.resulting_ledger_sequence
        AND history.command_id = execution_record.command_id
        AND history.event_id = execution_record.event_id
        AND history.event_type = 'WorldEconomyRepairedV1'
        AND history.occurred_at = execution_record.executed_at
        AND history.category = 'repair'
        AND history.title_key = 'history.economy.repair_applied'
        AND history.summary_args = jsonb_build_object(
          'reasonCode', plan_record.reason_code::text,
          'repairKind', plan_record.repair_kind::text
        )
        AND history.actor_type = 'platform_admin'::command_actor_type
        AND history.actor_id = execution_record.executed_by_user_id::text
        AND history.target_type = 'world_economy'
        AND history.target_id = execution_record.world_id::text
        AND history.visibility = 'member'::history_visibility
        AND history.correlation_id = execution_record.command_id
        AND history.resulting_state_revision = execution_record.resulting_state_revision
    ) THEN
    RAISE EXCEPTION 'economy repair execution is missing exact command/event/ledger authority'
      USING ERRCODE = '23514', CONSTRAINT = 'economy_repair_execution_exact';
  END IF;

  IF (plan_record.compensation_transaction_id IS NULL) IS DISTINCT FROM NOT EXISTS (
      SELECT 1 FROM public.financial_transactions transaction
      WHERE transaction.command_id = execution_record.command_id
        AND transaction.world_id = execution_record.world_id
    )
    OR (plan_record.compensation_transfer_id IS NULL) IS DISTINCT FROM NOT EXISTS (
      SELECT 1 FROM public.asset_transfers transfer
      WHERE transfer.command_id = execution_record.command_id
        AND transfer.world_id = execution_record.world_id
    ) THEN
    RAISE EXCEPTION 'economy repair execution has an incomplete compensation fact set'
      USING ERRCODE = '23514', CONSTRAINT = 'economy_repair_execution_facts_exact';
  END IF;

  IF EXISTS (
    WITH affected_entities AS (
      SELECT wallet.owner_entity_id AS entity_id
      FROM public.wallet_postings posting
      JOIN public.wallets wallet
        ON wallet.world_id = posting.world_id
       AND wallet.currency_id = posting.currency_id
       AND wallet.id = posting.wallet_id
      WHERE posting.transaction_id = plan_record.source_financial_transaction_id
      UNION
      SELECT source.from_owner_entity_id
      FROM public.asset_transfers source
      WHERE source.world_id = plan_record.world_id
        AND source.id = plan_record.source_asset_transfer_id
      UNION
      SELECT source.to_owner_entity_id
      FROM public.asset_transfers source
      WHERE source.world_id = plan_record.world_id
        AND source.id = plan_record.source_asset_transfer_id
    ), expected_controllers AS (
      SELECT DISTINCT ON (controller.user_id)
             controller.user_id, affected.entity_id
      FROM affected_entities affected
      JOIN public.world_entity_controllers controller
        ON controller.world_id = plan_record.world_id
       AND controller.entity_id = affected.entity_id
       AND controller.revoked_at IS NULL
      JOIN public.world_memberships membership
        ON membership.world_id = controller.world_id
       AND membership.user_id = controller.user_id
       AND membership.status = 'active'::membership_status
      WHERE affected.entity_id IS NOT NULL
      ORDER BY controller.user_id, affected.entity_id
    ), expected AS (
      SELECT plan_record.world_id AS world_id,
             execution_record.resulting_ledger_sequence AS ledger_sequence,
             controller.user_id, controller.entity_id AS participant_entity_id,
             NULL::uuid AS counterparty_entity_id,
             execution_record.command_id AS command_id,
             execution_record.event_id AS event_id,
             'repair'::text AS category,
             'WORLD_ECONOMY_REPAIRED'::text AS summary_code,
             jsonb_build_object(
               'reasonCode', plan_record.reason_code::text,
               'repairKind', plan_record.repair_kind::text
             ) AS summary_args,
             'participant'::economy_participant_visibility AS visibility,
             execution_record.resulting_state_revision AS state_revision,
             execution_record.executed_at AS created_at
      FROM expected_controllers controller
    ), actual AS (
      SELECT history.world_id, history.ledger_sequence, history.user_id,
             history.participant_entity_id, history.counterparty_entity_id,
             history.command_id, history.event_id, history.category,
             history.summary_code, history.summary_args, history.visibility,
             history.state_revision, history.created_at
      FROM public.economy_participant_history history
      WHERE history.world_id = execution_record.world_id
        AND history.ledger_sequence = execution_record.resulting_ledger_sequence
    ), difference AS (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    )
    SELECT 1 FROM difference
  ) THEN
    RAISE EXCEPTION 'economy repair participant history is not the deterministic controller set'
      USING ERRCODE = '23514', CONSTRAINT = 'economy_repair_participants_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER economy_repair_executions_require_exact_effect
  AFTER INSERT ON economy_repair_executions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_economy_repair_execution();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_economy_repair_execution() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_command_terminal(checked_command_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_record record;
  snapshot_record record;
  runtime_record record;
  head_record record;
  checkpoint_record record;
  event_count integer;
  expected_event_count integer;
BEGIN
  SELECT command.* INTO command_record FROM public.command_records command
  WHERE command.id = checked_command_id;
  IF NOT FOUND OR command_record.command_type NOT IN (
      'AdoptLegacyEconomySeedPlanV1','InitializeWorldEconomyV1','TransferCurrencyV1',
      'IssueCurrencyV1','FreezeCurrencyV1','UnfreezeCurrencyV1','FreezeWalletV1',
      'UnfreezeWalletV1','TransferAssetV1','CreateAssetTransferOfferV1',
      'CancelAssetTransferOfferV1','AcceptAssetTransferOfferV1',
      'ExpireAssetTransferOfferV1','ReconcileWorldEconomyV1','RepairWorldEconomyV1'
    ) OR command_record.status = 'received'::command_record_status THEN
    RETURN;
  END IF;
  SELECT snapshot.* INTO snapshot_record
  FROM public.economy_command_write_snapshots snapshot
  WHERE snapshot.command_id = command_record.id
    AND snapshot.world_id = command_record.world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'terminal economy command is missing its owner-written economy snapshot'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.status <> 'accepted'::command_record_status THEN
    IF EXISTS (
      SELECT 1 FROM public.economy_command_mutations mutation
      WHERE mutation.command_id = command_record.id
    ) THEN
      RAISE EXCEPTION 'rejected or failed economy command recorded authoritative mutations'
        USING ERRCODE = '55000';
    END IF;
    IF NOT snapshot_record.economy_state_exists THEN
      IF public.worldgraph_economy_runtime_state_exists(command_record.world_id) THEN
        RAISE EXCEPTION 'rejected or failed initialization left partial economy state'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.world_economy_heads head
      WHERE head.world_id = command_record.world_id
        AND head.row_version = snapshot_record.opened_head_row_version
        AND head.checksum = snapshot_record.opened_head_checksum
    ) THEN
      RAISE EXCEPTION 'rejected or failed economy command changed its economy head'
        USING ERRCODE = '55000';
    ELSIF command_record.command_type <> 'ReconcileWorldEconomyV1' THEN
      PERFORM public.worldgraph_assert_economy_projection_current(command_record.world_id);
    END IF;
    RETURN;
  END IF;
  IF (command_record.command_type IN (
      'AdoptLegacyEconomySeedPlanV1','InitializeWorldEconomyV1'
    )) IS DISTINCT FROM (NOT snapshot_record.economy_state_exists)
    OR NOT public.worldgraph_economy_command_mutation_set_is_exact(command_record.id) THEN
    RAISE EXCEPTION 'accepted economy command mutated rows outside its exact fact-derived scope'
      USING ERRCODE = '55000';
  END IF;
  expected_event_count := CASE command_record.command_type
    WHEN 'AcceptAssetTransferOfferV1' THEN 4 ELSE 1 END;
  SELECT count(*) INTO event_count FROM public.domain_events event
  WHERE event.command_id = command_record.id;
  IF event_count <> expected_event_count OR NOT EXISTS (
    SELECT 1 FROM public.domain_events event
    WHERE event.command_id = command_record.id
    HAVING min(event.event_ordinal) = 0
      AND max(event.event_ordinal) = expected_event_count - 1
      AND count(DISTINCT event.event_ordinal) = expected_event_count
      AND bool_and(event.resulting_state_revision = command_record.resulting_state_revision)
  ) THEN
    RAISE EXCEPTION 'accepted economy command has an incomplete event set'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.command_type = 'RepairWorldEconomyV1' AND NOT EXISTS (
    SELECT 1 FROM public.economy_repair_executions execution
    WHERE execution.command_id = command_record.id
      AND execution.world_id = command_record.world_id
      AND execution.repair_plan_id IN (
        SELECT plan.id FROM public.economy_repair_plans plan
        WHERE plan.reserved_command_id = command_record.id
          AND plan.world_id = command_record.world_id
      )
  ) THEN
    RAISE EXCEPTION 'accepted economy repair is missing its exact execution evidence'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.command_type = 'AdoptLegacyEconomySeedPlanV1' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.compiled_economy_seed_plans plan
      WHERE plan.world_id = command_record.world_id
        AND plan.adopted_command_id = command_record.id
        AND plan.source_kind = 'legacy_1_0_adapter'::economy_seed_plan_source
    ) THEN
      RAISE EXCEPTION 'accepted legacy adoption did not persist its exact plan'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;
  SELECT runtime.* INTO runtime_record FROM public.world_runtime_heads runtime
  WHERE runtime.world_id = command_record.world_id;
  SELECT head.* INTO head_record FROM public.world_economy_heads head
  WHERE head.world_id = command_record.world_id;
  SELECT checkpoint.* INTO checkpoint_record FROM public.projection_checkpoints checkpoint
  WHERE checkpoint.world_id = command_record.world_id
    AND checkpoint.projection_name = 'economy_runtime';
  IF runtime_record.world_id IS NULL OR head_record.world_id IS NULL
    OR checkpoint_record.world_id IS NULL
    OR runtime_record.state_revision <> command_record.resulting_state_revision
    OR head_record.updated_state_revision <> command_record.resulting_state_revision
    OR head_record.checksum <> public.worldgraph_economy_projection_checksum(command_record.world_id)
    OR checkpoint_record.projection_schema_version <> 1
    OR checkpoint_record.status <> 'current'::projection_checkpoint_status
    OR checkpoint_record.last_event_sequence <> runtime_record.last_event_sequence
    OR checkpoint_record.checksum <> head_record.checksum THEN
    RAISE EXCEPTION 'accepted economy command did not publish its exact current checkpoint'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.command_type = 'AcceptAssetTransferOfferV1' AND NOT EXISTS (
    SELECT 1 FROM public.domain_events event
    WHERE event.command_id = command_record.id
    GROUP BY event.command_id
    HAVING array_agg(event.event_type ORDER BY event.event_ordinal) = ARRAY[
      'CurrencyTransferredV1','AssetOwnershipTransferredV1',
      'AssetTransferOfferAcceptedV1','AssetPurchasedV1'
    ]::text[]
  ) THEN
    RAISE EXCEPTION 'accepted asset purchase has an invalid atomic event order'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.command_type = 'IssueCurrencyV1' AND NOT EXISTS (
    SELECT 1
    FROM public.financial_transactions transaction
    WHERE transaction.world_id = command_record.world_id
      AND transaction.command_id = command_record.id
      AND transaction.transaction_kind = 'issuance'::financial_transaction_kind
      AND public.worldgraph_currency_issuance_override_is_valid(
        command_record.id,
        transaction.currency_id,
        transaction.memo_text
      )
  ) THEN
    RAISE EXCEPTION 'accepted currency issuance lacks its exact creator override'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_economy_command_terminal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.worldgraph_assert_economy_command_terminal(NEW.id);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER command_records_require_economy_terminal
  AFTER INSERT OR UPDATE ON command_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_economy_command_terminal();
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_last_repair_timestamp_seconds()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT floor(extract(epoch FROM max(execution.executed_at)))::bigint
  FROM public.economy_repair_executions execution
), 0::bigint);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_last_repair_timestamp_seconds()
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_economy_repair_reason_is_valid(text),
  worldgraph_economy_seed_plan_is_valid(jsonb),
  worldgraph_economy_projection_document(uuid),
  worldgraph_economy_projection_checksum(uuid),
  worldgraph_economy_initial_projection_checksum(uuid,uuid,bytea),
  worldgraph_economy_wallet_live_document(uuid),
  worldgraph_economy_wallet_rebuilt_document(uuid),
  worldgraph_economy_supply_live_document(uuid),
  worldgraph_economy_supply_rebuilt_document(uuid),
  worldgraph_economy_ownership_live_document(uuid),
  worldgraph_economy_ownership_rebuilt_document(uuid),
  worldgraph_economy_reconciliation_snapshot(uuid),
  worldgraph_economy_runtime_state_exists(uuid),
  worldgraph_assert_economy_projection_current(uuid),
  worldgraph_due_asset_transfer_offers(uuid,integer),
  worldgraph_protect_compiled_economy_seed_plan(),
  worldgraph_assert_compiled_economy_seed_plan(),
  worldgraph_economy_open_command_type(uuid),
  worldgraph_protect_currency(),
  worldgraph_protect_wallet(),
  worldgraph_protect_economy_projection_row(),
  worldgraph_protect_asset(),
  worldgraph_protect_asset_ownership(),
  worldgraph_protect_economy_fact(),
  worldgraph_protect_reconciliation_item(),
  worldgraph_protect_asset_transfer_offer(),
  worldgraph_protect_world_economy_head(),
  worldgraph_currency_issuance_override_is_valid(uuid,uuid,text),
  worldgraph_assert_financial_transaction(),
  worldgraph_assert_asset_transfer(),
  worldgraph_assert_native_economy_plan_activation(),
  worldgraph_materialized_economy_seed_plan(uuid),
  worldgraph_protect_economy_domain_event(),
  worldgraph_assert_economy_domain_event(),
  worldgraph_assert_economy_reconciliation_run(),
  worldgraph_require_economy_checkpoint_command(),
  worldgraph_advance_economy_checkpoint_for_event(),
  worldgraph_assert_economy_repair_execution(),
  worldgraph_assert_economy_command_terminal(uuid),
  worldgraph_enforce_economy_command_terminal()
  FROM PUBLIC;
--> statement-breakpoint
DO $metadata$
DECLARE changed integer;
BEGIN
  UPDATE platform_metadata
  SET value = value || jsonb_build_object(
        'assetSchema', 1,
        'assetTransferOfferSchema', 1,
        'compiler', '1.1.0',
        'compilerArtifactSchema', 2,
        'contracts', 8,
        'currencySchema', 1,
        'economyReconciliationSchema', 1,
        'economySchema', 1,
        'economySeedPlanSchema', 1,
        'financialTransactionSchema', 1,
        'ownershipSchema', 1,
        'runtimeSchema', 8,
        'walletSchema', 1
      ),
      value_schema_version = 8,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 7
    AND value ->> 'compiler' = '1.0.0'
    AND value ->> 'compilerArtifactSchema' = '1'
    AND value ->> 'contracts' = '7'
    AND value ->> 'runtimeSchema' = '7'
    AND value ->> 'simulationProjectionSchema' = '1'
    AND NOT value ?| ARRAY[
      'assetSchema','assetTransferOfferSchema','currencySchema',
      'economyReconciliationSchema','economySchema','economySeedPlanSchema',
      'financialTransactionSchema','ownershipSchema','walletSchema'
    ];
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact sealed M07 compatibility state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT USAGE ON TYPE
      economy_seed_plan_source, currency_status, wallet_kind, wallet_status,
      financial_transaction_kind, asset_status, asset_transfer_kind,
      asset_transfer_offer_status, economy_reconciliation_status,
      economy_reconciliation_run_status, economy_participant_visibility
      TO worldgraph_app;
    GRANT SELECT ON
      compiled_economy_seed_plans, currencies, currency_supply, wallets,
      wallet_balances, financial_transactions, wallet_postings, assets,
      asset_ownership, asset_transfers, asset_transfer_offers,
      world_economy_heads, economy_reconciliation_runs,
      economy_reconciliation_items, economy_participant_history
      TO worldgraph_app;
    GRANT INSERT ON compiled_economy_seed_plans, currencies, currency_supply,
      wallets, wallet_balances, financial_transactions, wallet_postings,
      assets, asset_ownership, asset_transfers, asset_transfer_offers,
      world_economy_heads, economy_reconciliation_runs,
      economy_reconciliation_items, economy_participant_history
      TO worldgraph_app;
    GRANT UPDATE (status, row_version, updated_at) ON currencies TO worldgraph_app;
    GRANT UPDATE (status, row_version, updated_at) ON wallets TO worldgraph_app;
    GRANT UPDATE (
      current_supply_minor, row_version, updated_state_revision, updated_at
    ) ON currency_supply TO worldgraph_app;
    GRANT UPDATE (
      available_minor, row_version, updated_state_revision, updated_at
    ) ON wallet_balances TO worldgraph_app;
    GRANT UPDATE (
      owner_entity_id, ownership_version, acquired_event_id,
      updated_state_revision, updated_at
    ) ON asset_ownership TO worldgraph_app;
    GRANT UPDATE (
      status, terminal_command_id, terminal_event_id,
      accepted_financial_transaction_id, accepted_asset_transfer_id,
      row_version, terminal_state_revision, updated_at
    ) ON asset_transfer_offers TO worldgraph_app;
    GRANT UPDATE (
      checksum, row_version, updated_state_revision, reconciliation_status,
      last_reconciled_state_revision, last_reconciliation_run_id, updated_at
    ) ON world_economy_heads TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION
      worldgraph_open_command_write(uuid,uuid),
      worldgraph_economy_seed_plan_is_valid(jsonb),
      worldgraph_economy_projection_document(uuid),
      worldgraph_economy_projection_checksum(uuid),
      worldgraph_economy_initial_projection_checksum(uuid,uuid,bytea),
      worldgraph_economy_wallet_live_document(uuid),
      worldgraph_economy_wallet_rebuilt_document(uuid),
      worldgraph_economy_supply_live_document(uuid),
      worldgraph_economy_supply_rebuilt_document(uuid),
      worldgraph_economy_ownership_live_document(uuid),
      worldgraph_economy_ownership_rebuilt_document(uuid),
      worldgraph_economy_reconciliation_snapshot(uuid),
      worldgraph_due_asset_transfer_offers(uuid,integer),
      worldgraph_economy_open_command_type(uuid),
      worldgraph_materialized_economy_seed_plan(uuid),
      worldgraph_economy_repair_plan(uuid,uuid),
      worldgraph_approve_economy_repair(uuid,uuid,text,uuid,uuid,uuid,text,text),
      worldgraph_economy_last_repair_timestamp_seconds(),
      worldgraph_assert_economy_command_terminal(uuid)
      TO worldgraph_app;
    REVOKE EXECUTE ON FUNCTION worldgraph_open_command_write_m07(uuid,uuid)
      FROM worldgraph_app;
    REVOKE UPDATE, DELETE ON compiled_economy_seed_plans, financial_transactions,
      wallet_postings, assets, asset_transfers, economy_reconciliation_runs,
      economy_reconciliation_items, economy_participant_history
      FROM worldgraph_app;
    REVOKE ALL ON economy_command_write_snapshots, economy_command_mutations
      FROM worldgraph_app;
    REVOKE ALL ON economy_repair_plans, economy_repair_approvals,
      economy_repair_executions FROM worldgraph_app;
    REVOKE EXECUTE ON FUNCTION
      worldgraph_prepare_economy_repair(uuid,uuid,uuid,text,text,text),
      worldgraph_execute_economy_repair(uuid,uuid,text,text)
      FROM worldgraph_app;
    REVOKE DELETE ON currencies, currency_supply, wallets, wallet_balances,
      asset_ownership, asset_transfer_offers, world_economy_heads
      FROM worldgraph_app;
  END IF;
END
$grant$;
--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
