SET CONSTRAINTS ALL DEFERRED;
--> statement-breakpoint
ALTER TYPE economy_seed_plan_source ADD VALUE IF NOT EXISTS 'compiler_1_2';
--> statement-breakpoint
ALTER TYPE financial_transaction_kind ADD VALUE IF NOT EXISTS 'market_purchase';
--> statement-breakpoint
ALTER TYPE financial_transaction_kind ADD VALUE IF NOT EXISTS 'payroll';
--> statement-breakpoint
ALTER TYPE financial_transaction_kind ADD VALUE IF NOT EXISTS 'periodic_tax';
--> statement-breakpoint
ALTER TYPE economy_participant_visibility ADD VALUE IF NOT EXISTS 'business';
--> statement-breakpoint
ALTER TYPE economy_participant_visibility ADD VALUE IF NOT EXISTS 'contract';
--> statement-breakpoint
ALTER TYPE economy_participant_visibility ADD VALUE IF NOT EXISTS 'inventory';
--> statement-breakpoint
ALTER TYPE economy_participant_visibility ADD VALUE IF NOT EXISTS 'listing';
--> statement-breakpoint
ALTER TYPE economy_participant_visibility ADD VALUE IF NOT EXISTS 'production';
--> statement-breakpoint
ALTER TYPE economy_participant_visibility ADD VALUE IF NOT EXISTS 'trade';
--> statement-breakpoint
ALTER TYPE economy_participant_visibility ADD VALUE IF NOT EXISTS 'tax';
--> statement-breakpoint
CREATE TYPE resource_type_status AS ENUM ('active', 'retired');
--> statement-breakpoint
CREATE TYPE inventory_movement_kind AS ENUM (
  'initial', 'production_consume', 'production_output', 'market_trade'
);
--> statement-breakpoint
CREATE TYPE inventory_reservation_purpose AS ENUM ('production_input', 'market_listing');
--> statement-breakpoint
CREATE TYPE inventory_reservation_status AS ENUM ('active', 'consumed', 'released', 'expired');
--> statement-breakpoint
CREATE TYPE business_status AS ENUM ('active', 'suspended', 'closed');
--> statement-breakpoint
CREATE TYPE business_facility_status AS ENUM ('active', 'disabled', 'retired');
--> statement-breakpoint
CREATE TYPE production_run_status AS ENUM (
  'scheduled', 'reserving', 'ready', 'completed', 'failed', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE employment_offer_status AS ENUM ('open', 'closed', 'retired');
--> statement-breakpoint
CREATE TYPE employment_contract_status AS ENUM ('offered', 'active', 'ended', 'cancelled');
--> statement-breakpoint
CREATE TYPE wage_rule_kind AS ENUM ('per_shift', 'per_output');
--> statement-breakpoint
CREATE TYPE payroll_status AS ENUM ('pending', 'paid', 'failed');
--> statement-breakpoint
CREATE TYPE market_listing_status AS ENUM ('open', 'filled', 'cancelled', 'expired');
--> statement-breakpoint
CREATE TYPE tax_policy_type AS ENUM (
  'transaction', 'sales', 'payroll', 'periodic_flat', 'marketplace_fee'
);
--> statement-breakpoint
CREATE TYPE tax_collection_mode AS ENUM ('added_to_payer', 'withheld_from_recipient');
--> statement-breakpoint
CREATE TYPE tax_policy_status AS ENUM ('active', 'disabled', 'retired');
--> statement-breakpoint
ALTER TABLE scheduled_actions
  DROP CONSTRAINT scheduled_actions_registry_known,
  DROP CONSTRAINT scheduled_actions_payload_safe,
  ADD CONSTRAINT scheduled_actions_registry_known CHECK (
    action_schema_version = 1 AND process_version = '1.0.0'
    AND action_type IN (
      'EmitWorldNoticeV1','CompleteProductionRunV1','SettlePayrollV1',
      'ExpireMarketListingV1','AssessPeriodicTaxV1'
    )
  ),
  ADD CONSTRAINT scheduled_actions_payload_safe CHECK (
    jsonb_typeof(payload) = 'object'
    AND pg_column_size(payload) <= 4096
    AND NOT worldgraph_jsonb_has_sensitive_key(payload)
    AND NOT worldgraph_jsonb_has_compiler_private_key(payload)
    AND CASE action_type
      WHEN 'EmitWorldNoticeV1' THEN
        payload = jsonb_build_object(
          'text', payload ->> 'text', 'visibility', payload ->> 'visibility'
        )
        AND char_length(payload ->> 'text') BETWEEN 1 AND 500
        AND translate(payload ->> 'text', E'\t\n\r', '') !~ '[[:cntrl:]]'
        AND payload ->> 'visibility' IN ('public', 'member', 'creator')
      WHEN 'CompleteProductionRunV1' THEN
        payload = jsonb_build_object('productionRunId', payload ->> 'productionRunId')
        AND payload ->> 'productionRunId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'SettlePayrollV1' THEN
        payload = jsonb_build_object('payrollRecordId', payload ->> 'payrollRecordId')
        AND payload ->> 'payrollRecordId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'ExpireMarketListingV1' THEN
        payload = jsonb_build_object('listingId', payload ->> 'listingId')
        AND payload ->> 'listingId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'AssessPeriodicTaxV1' THEN
        payload = jsonb_build_object('taxPolicyId', payload ->> 'taxPolicyId')
        AND payload ->> 'taxPolicyId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ELSE false
    END
  );
--> statement-breakpoint
ALTER TABLE simulation_batch_runs
  DROP CONSTRAINT simulation_batch_runs_registry_known,
  ADD CONSTRAINT simulation_batch_runs_registry_known CHECK (
    process_registry_version IN (1, 2)
  );
--> statement-breakpoint
ALTER TABLE simulation_failures
  DROP CONSTRAINT simulation_failures_process_known,
  ADD CONSTRAINT simulation_failures_process_known CHECK (
    (process_type IN (
      'EmitWorldNoticeV1','CompleteProductionRunV1','SettlePayrollV1',
      'ExpireMarketListingV1','AssessPeriodicTaxV1'
    ) AND process_version = '1.0.0' AND schedule_id IS NOT NULL)
    OR (
      process_type = 'WorldClockV1' AND process_version = '1.0.0'
      AND schedule_id IS NULL AND error_code = 'SIMULATION_INTEGER_OVERFLOW'
    )
  );
--> statement-breakpoint
CREATE INDEX command_records_commerce_schedule_causation_idx
  ON command_records (world_id, causation_id, command_type, status)
  WHERE causation_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE world_compilation_runs
  DROP CONSTRAINT world_compilation_runs_compiler_known,
  ADD CONSTRAINT world_compilation_runs_compiler_known CHECK (
    compiler_config_version = 1 AND compiler_version IN ('1.0.0', '1.1.0', '1.2.0')
  );
--> statement-breakpoint
ALTER TABLE world_versions
  DROP CONSTRAINT world_versions_compiler_known,
  ADD CONSTRAINT world_versions_compiler_known CHECK (
    compiler_config_version = 1 AND compiler_version IN ('1.0.0', '1.1.0', '1.2.0')
  );
--> statement-breakpoint
ALTER TABLE compiled_world_artifacts
  DROP CONSTRAINT compiled_world_artifacts_schema_known,
  ADD CONSTRAINT compiled_world_artifacts_schema_known CHECK (
    (artifact_kind = 'compiled_world' AND artifact_schema_version IN (1, 2, 3))
    OR (artifact_kind IN ('compiler_input', 'visual_plan') AND artifact_schema_version = 1)
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_assert_compiler_artifact_version_pair()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_record record;
  plan_domain text;
BEGIN
  SELECT compiler_version, compiler_config_version
    INTO run_record
    FROM public.world_compilation_runs
   WHERE id = NEW.compilation_run_id AND world_id = NEW.world_id;
  IF NOT FOUND OR run_record.compiler_config_version <> 1 THEN
    RAISE EXCEPTION 'compiled artifact requires a known compiler run'
      USING ERRCODE = '55000';
  END IF;
  plan_domain := CASE NEW.artifact_schema_version
    WHEN 2 THEN 'worldgraph.economy-seed-plan.v1'
    WHEN 3 THEN 'worldgraph.economy-seed-plan.v2'
    ELSE NULL
  END;
  IF NEW.artifact_kind = 'compiled_world' AND NOT (
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
          'domain', plan_domain, 'plan', NEW.canonical_content -> 'economySeedPlan'
        )), 'UTF8'), 'sha256'))
    OR
    (run_record.compiler_version = '1.2.0' AND NEW.artifact_schema_version = 3
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '3'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.2.0'
      AND NEW.canonical_content ->> 'compilerConfigVersion' = '1'
      AND jsonb_typeof(NEW.canonical_content -> 'economySeedPlan') = 'object'
      AND NEW.canonical_content -> 'economySeedPlan' ->> 'economySeedPlanSchemaVersion' = '2'
      AND NEW.canonical_content ->> 'economySeedPlanHash' ~ '^[a-f0-9]{64}$'
      AND decode(NEW.canonical_content ->> 'economySeedPlanHash', 'hex') =
        extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
          'domain', plan_domain, 'plan', NEW.canonical_content -> 'economySeedPlan'
        )), 'UTF8'), 'sha256'))
  ) THEN
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
CREATE FUNCTION worldgraph_quantity_fits_scale_v1(value numeric, declared_scale smallint)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
RETURN declared_scale BETWEEN 0 AND 12
  AND value = trunc(value, declared_scale)
  AND abs(value) < 1000000000000000000::numeric;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_quantity_fits_scale_v1(numeric,smallint) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_tax_amount_v1(
  basis_minor bigint,
  rate_basis_points integer,
  fixed_minor bigint,
  checked_policy_type tax_policy_type
)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE result_value numeric;
BEGIN
  IF basis_minor < 0 OR rate_basis_points NOT BETWEEN 0 AND 5000 OR fixed_minor < 0 THEN
    RAISE EXCEPTION 'invalid tax calculation input' USING ERRCODE = '22003';
  END IF;
  result_value := CASE checked_policy_type
    WHEN 'periodic_flat'::public.tax_policy_type THEN fixed_minor::numeric
    ELSE floor((basis_minor::numeric * rate_basis_points::numeric) / 10000)
  END;
  IF result_value > 9223372036854775807::numeric THEN
    RAISE EXCEPTION 'tax calculation overflow' USING ERRCODE = '22003';
  END IF;
  RETURN result_value::bigint;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_tax_amount_v1(bigint,integer,bigint,tax_policy_type)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_user_controls_economy_entity_v1(
  checked_world_id uuid,
  checked_user_id uuid,
  checked_target_entity_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.world_memberships membership
    JOIN public.world_entities target
      ON target.world_id = membership.world_id
     AND target.id = checked_target_entity_id
     AND target.retired_world_version_id IS NULL
    WHERE membership.world_id = checked_world_id
      AND membership.user_id = checked_user_id
      AND membership.status = 'active'::membership_status
      AND (
        EXISTS (
          SELECT 1
          FROM public.world_entity_controllers controller
          JOIN public.world_entities controlled
            ON controlled.world_id = controller.world_id
           AND controlled.id = controller.entity_id
           AND controlled.retired_world_version_id IS NULL
          WHERE controller.world_id = checked_world_id
            AND controller.user_id = checked_user_id
            AND controller.entity_id = target.id
            AND controller.control_scope = 'primary'
            AND controller.revoked_at IS NULL
        )
        OR (
          target.entity_type = 'organization'
          AND EXISTS (
            SELECT 1
            FROM public.world_entity_controllers controller
            JOIN public.world_entities character
              ON character.world_id = controller.world_id
             AND character.id = controller.entity_id
             AND character.entity_type = 'player_character'
             AND character.retired_world_version_id IS NULL
            WHERE controller.world_id = checked_world_id
              AND controller.user_id = checked_user_id
              AND controller.control_scope = 'primary'
              AND controller.revoked_at IS NULL
              AND character.state ->> 'organizationLogicalKey' = target.logical_key::text
          )
        )
      )
  )
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_user_controls_economy_entity_v1(uuid,uuid,uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_resource_tags_are_valid_v1(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
RETURN cardinality(value) <= 16
  AND NOT EXISTS (
    SELECT 1 FROM unnest(value) tag
    WHERE char_length(tag) NOT BETWEEN 1 AND 40
      OR tag <> lower(tag) OR tag !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  )
  AND cardinality(value) = (SELECT count(DISTINCT tag) FROM unnest(value) tag);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_resource_tags_are_valid_v1(text[]) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE compiled_economy_seed_plans
  DROP CONSTRAINT compiled_economy_seed_plans_schema_known,
  DROP CONSTRAINT compiled_economy_seed_plans_source_shape,
  DROP CONSTRAINT compiled_economy_seed_plans_content_safe,
  DROP CONSTRAINT compiled_economy_seed_plans_plan_hash_valid,
  DROP CONSTRAINT compiled_economy_seed_plans_semantics_valid,
  ADD CONSTRAINT compiled_economy_seed_plans_schema_known CHECK (
    seed_plan_schema_version IN (1, 2)
  ),
  ADD CONSTRAINT compiled_economy_seed_plans_source_shape CHECK (
    (source_kind::text = 'compiler_1_1'
      AND seed_plan_schema_version = 1
      AND source_compiler_version = '1.1.0'
      AND source_adapter_id = 'CompiledEconomySeedAdapterV1'
      AND source_adapter_version = '1.0.0'
      AND adopted_command_id IS NULL AND adopted_event_id IS NULL)
    OR (source_kind::text = 'compiler_1_2'
      AND seed_plan_schema_version = 2
      AND source_compiler_version = '1.2.0'
      AND source_adapter_id = 'CompiledEconomySeedAdapterV2'
      AND source_adapter_version = '1.0.0'
      AND adopted_command_id IS NULL AND adopted_event_id IS NULL)
    OR (source_kind::text = 'legacy_1_0_adapter'
      AND seed_plan_schema_version = 1
      AND source_compiler_version = '1.0.0'
      AND source_adapter_id = 'LegacyEconomySeedAdapterV1'
      AND source_adapter_version = '1.0.0'
      AND adopted_command_id IS NOT NULL AND adopted_event_id IS NOT NULL)
  ),
  ADD CONSTRAINT compiled_economy_seed_plans_content_safe CHECK (
    jsonb_typeof(canonical_plan) = 'object'
      AND pg_column_size(canonical_plan) <= 1048576
      AND canonical_plan ->> 'economySeedPlanSchemaVersion' = seed_plan_schema_version::text
      AND NOT worldgraph_jsonb_has_sensitive_key(canonical_plan)
      AND NOT worldgraph_jsonb_has_compiler_private_key(canonical_plan)
  ),
  ADD CONSTRAINT compiled_economy_seed_plans_plan_hash_valid CHECK (
    plan_hash = extensions.digest(convert_to(worldgraph_canonical_jsonb(
      jsonb_build_object(
        'domain', CASE seed_plan_schema_version
          WHEN 1 THEN 'worldgraph.economy-seed-plan.v1'
          ELSE 'worldgraph.economy-seed-plan.v2'
        END,
        'plan', canonical_plan
      )
    ),'UTF8'),'sha256')
  );
--> statement-breakpoint
ALTER FUNCTION worldgraph_economy_seed_plan_is_valid(jsonb)
  RENAME TO worldgraph_economy_seed_plan_v1_is_valid;
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_seed_plan_v2_is_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE key_name text;
DECLARE array_value jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'object'
    OR value ->> 'economySeedPlanSchemaVersion' IS DISTINCT FROM '2'
    OR jsonb_typeof(value -> 'currency') <> 'object'
    OR jsonb_typeof(value -> 'wallets') <> 'array'
    OR jsonb_typeof(value -> 'assets') <> 'array'
    OR jsonb_typeof(value -> 'treasury') <> 'object'
    OR NOT public.worldgraph_jsonb_has_exact_keys(value, ARRAY[
      'assets','businesses','currency','economySeedPlanSchemaVersion',
      'employmentOffers','facilities','initialSupplyMinor','inventories',
      'recipeVersions','resources','taxPolicies','treasury','wallets'
    ])
    OR value ->> 'initialSupplyMinor' !~ '^(0|[1-9][0-9]{0,18})$'
    OR pg_column_size(value) > 1048576
    OR public.worldgraph_jsonb_has_sensitive_key(value)
    OR public.worldgraph_jsonb_has_compiler_private_key(value) THEN
    RETURN false;
  END IF;
  FOREACH key_name IN ARRAY ARRAY[
    'resources','recipeVersions','inventories','businesses','facilities',
    'employmentOffers','taxPolicies'
  ] LOOP
    array_value := value -> key_name;
    IF jsonb_typeof(array_value) <> 'array' OR jsonb_array_length(array_value) > 1000
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(array_value) item
        WHERE jsonb_typeof(item) <> 'object'
          OR pg_column_size(item) > 65536
      ) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF NOT public.worldgraph_economy_seed_plan_v1_is_valid(
    jsonb_build_object(
      'economySeedPlanSchemaVersion', 1,
      'currency', value -> 'currency',
      'wallets', value -> 'wallets',
      'assets', jsonb_path_query_array(
        value -> 'assets', '$[*] ? (@.stableKey == "asset:founding-seal")'
      ),
      'initialSupplyMinor', value -> 'initialSupplyMinor'
    )
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_seed_plan_v2_is_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_seed_plan_is_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
RETURN CASE value ->> 'economySeedPlanSchemaVersion'
  WHEN '1' THEN public.worldgraph_economy_seed_plan_v1_is_valid(value)
  WHEN '2' THEN public.worldgraph_economy_seed_plan_v2_is_valid(value)
  ELSE false
END;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_economy_seed_plan_is_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE compiled_economy_seed_plans
  ADD CONSTRAINT compiled_economy_seed_plans_semantics_valid
  CHECK (worldgraph_economy_seed_plan_is_valid(canonical_plan));
--> statement-breakpoint
CREATE TABLE world_economy_expansion_heads (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  source_world_version_id uuid NOT NULL,
  seed_plan_hash bytea NOT NULL,
  expansion_schema_version integer NOT NULL DEFAULT 1,
  projection_schema_version integer NOT NULL DEFAULT 1,
  checksum bytea NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  updated_state_revision bigint NOT NULL,
  initialized_command_id uuid NOT NULL UNIQUE,
  initialized_event_id uuid NOT NULL UNIQUE,
  reconciliation_status economy_reconciliation_status NOT NULL DEFAULT 'pending',
  last_reconciled_state_revision bigint,
  last_reconciliation_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_economy_expansion_heads_seed_fk
    FOREIGN KEY (world_id, source_world_version_id, seed_plan_hash)
    REFERENCES compiled_economy_seed_plans(world_id, world_version_id, plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT world_economy_expansion_heads_command_world_fk
    FOREIGN KEY (initialized_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT world_economy_expansion_heads_event_world_fk
    FOREIGN KEY (world_id, initialized_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT world_economy_expansion_heads_schema_known CHECK (
    expansion_schema_version = 1 AND projection_schema_version = 1
  ),
  CONSTRAINT world_economy_expansion_heads_hash_lengths CHECK (
    octet_length(seed_plan_hash) = 32 AND octet_length(checksum) = 32
  ),
  CONSTRAINT world_economy_expansion_heads_versions_positive CHECK (
    row_version > 0 AND updated_state_revision > 0
  ),
  CONSTRAINT world_economy_expansion_heads_reconciliation_shape CHECK (
    (reconciliation_status = 'pending' AND last_reconciled_state_revision IS NULL
      AND last_reconciliation_run_id IS NULL)
    OR (reconciliation_status IN ('current','mismatch','failed')
      AND last_reconciled_state_revision IS NOT NULL
      AND last_reconciliation_run_id IS NOT NULL)
  ),
  CONSTRAINT world_economy_expansion_heads_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE TABLE resource_types (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  display_name text NOT NULL,
  unit_code text NOT NULL,
  quantity_scale smallint NOT NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  primitive_ref text NOT NULL,
  primitive_key extensions.citext NOT NULL,
  primitive_version text NOT NULL,
  primitive_version_id uuid NOT NULL,
  primitive_content_hash bytea NOT NULL,
  source_world_version_id uuid NOT NULL,
  source_plan_hash bytea NOT NULL,
  resource_schema_version integer NOT NULL DEFAULT 1,
  status resource_type_status NOT NULL DEFAULT 'active',
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_types_world_identity UNIQUE (world_id, id),
  CONSTRAINT resource_types_world_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT resource_types_primitive_exact_fk
    FOREIGN KEY (primitive_version_id, primitive_content_hash)
    REFERENCES primitive_versions(id, content_hash) ON DELETE RESTRICT,
  CONSTRAINT resource_types_seed_fk
    FOREIGN KEY (world_id, source_world_version_id, source_plan_hash)
    REFERENCES compiled_economy_seed_plans(world_id, world_version_id, plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT resource_types_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT resource_types_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT resource_types_schema_known CHECK (resource_schema_version = 1),
  CONSTRAINT resource_types_scale_bounded CHECK (quantity_scale BETWEEN 0 AND 12),
  CONSTRAINT resource_types_tags_bounded CHECK (worldgraph_resource_tags_are_valid_v1(tags)),
  CONSTRAINT resource_types_primitive_provenance_shape CHECK (
    char_length(primitive_ref) BETWEEN 1 AND 160
      AND primitive_ref ~ '^[a-z][a-z0-9._-]*$'
      AND char_length(primitive_key::text) BETWEEN 5 AND 160
      AND primitive_key::text = lower(primitive_key::text)
      AND primitive_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT resource_types_hash_length CHECK (octet_length(primitive_content_hash) = 32
    AND octet_length(source_plan_hash) = 32),
  CONSTRAINT resource_types_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT resource_types_display_shape CHECK (
    char_length(display_name) BETWEEN 1 AND 100 AND display_name = btrim(display_name)
    AND display_name !~ '[[:cntrl:]]'
    AND char_length(unit_code) BETWEEN 1 AND 24 AND unit_code = btrim(unit_code)
    AND unit_code ~ '^[A-Za-z][A-Za-z0-9._/-]*$'
  ),
  CONSTRAINT resource_types_revision_positive CHECK (created_state_revision > 0)
);
--> statement-breakpoint
CREATE INDEX resource_types_world_status_idx
  ON resource_types (world_id, status, stable_key, id);
--> statement-breakpoint
CREATE TABLE production_recipes (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  display_name text NOT NULL,
  source_world_version_id uuid NOT NULL,
  source_plan_hash bytea NOT NULL,
  recipe_schema_version integer NOT NULL DEFAULT 1,
  status resource_type_status NOT NULL DEFAULT 'active',
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_recipes_world_identity UNIQUE (world_id, id),
  CONSTRAINT production_recipes_world_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT production_recipes_seed_fk
    FOREIGN KEY (world_id, source_world_version_id, source_plan_hash)
    REFERENCES compiled_economy_seed_plans(world_id, world_version_id, plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT production_recipes_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT production_recipes_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT production_recipes_schema_known CHECK (recipe_schema_version = 1),
  CONSTRAINT production_recipes_hash_length CHECK (octet_length(source_plan_hash) = 32),
  CONSTRAINT production_recipes_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT production_recipes_name_shape CHECK (
    char_length(display_name) BETWEEN 1 AND 100 AND display_name = btrim(display_name)
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT production_recipes_revision_positive CHECK (created_state_revision > 0)
);
--> statement-breakpoint
CREATE TABLE production_recipe_versions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  recipe_id uuid NOT NULL,
  version integer NOT NULL,
  recipe_version_schema_version integer NOT NULL DEFAULT 1,
  canonical_seed_inputs jsonb NOT NULL,
  canonical_seed_outputs jsonb NOT NULL,
  canonical_inputs jsonb NOT NULL,
  canonical_outputs jsonb NOT NULL,
  duration_ticks bigint NOT NULL,
  facility_requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  primitive_ref text NOT NULL,
  primitive_key extensions.citext NOT NULL,
  primitive_version text NOT NULL,
  primitive_version_id uuid NOT NULL,
  primitive_content_hash bytea NOT NULL,
  source_world_version_id uuid NOT NULL,
  source_plan_hash bytea NOT NULL,
  checksum bytea NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_recipe_versions_world_identity UNIQUE (world_id, id),
  CONSTRAINT production_recipe_versions_recipe_version_unique UNIQUE (recipe_id, version),
  CONSTRAINT production_recipe_versions_recipe_world_fk
    FOREIGN KEY (world_id, recipe_id)
    REFERENCES production_recipes(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT production_recipe_versions_primitive_exact_fk
    FOREIGN KEY (primitive_version_id, primitive_content_hash)
    REFERENCES primitive_versions(id, content_hash) ON DELETE RESTRICT,
  CONSTRAINT production_recipe_versions_seed_fk
    FOREIGN KEY (world_id, source_world_version_id, source_plan_hash)
    REFERENCES compiled_economy_seed_plans(world_id, world_version_id, plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT production_recipe_versions_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT production_recipe_versions_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT production_recipe_versions_schema_known CHECK (recipe_version_schema_version = 1),
  CONSTRAINT production_recipe_versions_numbers_valid CHECK (
    version BETWEEN 1 AND 2147483647 AND duration_ticks > 0
      AND created_state_revision > 0
  ),
  CONSTRAINT production_recipe_versions_primitive_provenance_shape CHECK (
    char_length(primitive_ref) BETWEEN 1 AND 160
      AND primitive_ref ~ '^[a-z][a-z0-9._-]*$'
      AND char_length(primitive_key::text) BETWEEN 5 AND 160
      AND primitive_key::text = lower(primitive_key::text)
      AND primitive_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT production_recipe_versions_hash_lengths CHECK (
    octet_length(primitive_content_hash) = 32 AND octet_length(source_plan_hash) = 32
      AND octet_length(checksum) = 32
  ),
  CONSTRAINT production_recipe_versions_json_bounded CHECK (
    jsonb_typeof(canonical_seed_inputs) = 'array'
      AND jsonb_typeof(canonical_seed_outputs) = 'array'
      AND jsonb_typeof(canonical_inputs) = 'array'
      AND jsonb_typeof(canonical_outputs) = 'array'
      AND jsonb_array_length(canonical_seed_inputs) BETWEEN 1 AND 64
      AND jsonb_array_length(canonical_seed_outputs) BETWEEN 1 AND 64
      AND jsonb_array_length(canonical_inputs) BETWEEN 1 AND 64
      AND jsonb_array_length(canonical_outputs) BETWEEN 1 AND 64
      AND jsonb_typeof(facility_requirements) = 'object'
      AND pg_column_size(canonical_seed_inputs) <= 32768
      AND pg_column_size(canonical_seed_outputs) <= 32768
      AND pg_column_size(canonical_inputs) <= 32768
      AND pg_column_size(canonical_outputs) <= 32768
      AND pg_column_size(facility_requirements) <= 8192
      AND NOT worldgraph_jsonb_has_sensitive_key(canonical_seed_inputs)
      AND NOT worldgraph_jsonb_has_sensitive_key(canonical_seed_outputs)
      AND NOT worldgraph_jsonb_has_sensitive_key(canonical_inputs)
      AND NOT worldgraph_jsonb_has_sensitive_key(canonical_outputs)
      AND NOT worldgraph_jsonb_has_sensitive_key(facility_requirements)
  )
);
--> statement-breakpoint
CREATE INDEX production_recipe_versions_world_recipe_idx
  ON production_recipe_versions (world_id, recipe_id, version DESC, id);
--> statement-breakpoint
CREATE TABLE inventories (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  owner_entity_id uuid NOT NULL,
  container_asset_id uuid,
  resource_type_id uuid NOT NULL,
  quantity numeric(30,12) NOT NULL DEFAULT 0,
  reserved_quantity numeric(30,12) NOT NULL DEFAULT 0,
  inventory_schema_version integer NOT NULL DEFAULT 1,
  row_version bigint NOT NULL DEFAULT 1,
  updated_state_revision bigint NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventories_world_identity UNIQUE (world_id, id),
  CONSTRAINT inventories_world_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT inventories_owner_world_fk
    FOREIGN KEY (world_id, owner_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventories_container_world_fk
    FOREIGN KEY (world_id, container_asset_id)
    REFERENCES assets(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventories_resource_world_fk
    FOREIGN KEY (world_id, resource_type_id)
    REFERENCES resource_types(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventories_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT inventories_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT inventories_schema_known CHECK (inventory_schema_version = 1),
  CONSTRAINT inventories_quantity_valid CHECK (
    quantity >= 0 AND reserved_quantity >= 0 AND reserved_quantity <= quantity
      AND quantity < 1000000000000000000::numeric
      AND reserved_quantity < 1000000000000000000::numeric
  ),
  CONSTRAINT inventories_versions_positive CHECK (
    row_version > 0 AND updated_state_revision > 0
  ),
  CONSTRAINT inventories_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT inventories_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX inventories_owner_container_resource_unique
  ON inventories (world_id, owner_entity_id, resource_type_id,
    COALESCE(container_asset_id, '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
CREATE INDEX inventories_owner_resource_idx
  ON inventories (world_id, owner_entity_id, resource_type_id, id);
--> statement-breakpoint
CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  resource_type_id uuid NOT NULL,
  from_inventory_id uuid,
  to_inventory_id uuid,
  quantity numeric(30,12) NOT NULL,
  movement_kind inventory_movement_kind NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_ordinal integer NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  occurred_tick bigint NOT NULL,
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movements_world_identity UNIQUE (world_id, id),
  CONSTRAINT inventory_movements_source_ordinal_unique
    UNIQUE (world_id, source_type, source_id, source_ordinal),
  CONSTRAINT inventory_movements_command_ordinal_unique UNIQUE (command_id, source_ordinal),
  CONSTRAINT inventory_movements_resource_world_fk
    FOREIGN KEY (world_id, resource_type_id)
    REFERENCES resource_types(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movements_from_world_fk
    FOREIGN KEY (world_id, from_inventory_id)
    REFERENCES inventories(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movements_to_world_fk
    FOREIGN KEY (world_id, to_inventory_id)
    REFERENCES inventories(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movements_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movements_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT inventory_movements_endpoints_valid CHECK (
    (from_inventory_id IS NOT NULL OR to_inventory_id IS NOT NULL)
      AND from_inventory_id IS DISTINCT FROM to_inventory_id
  ),
  CONSTRAINT inventory_movements_quantity_valid CHECK (
    quantity > 0 AND quantity < 1000000000000000000::numeric
  ),
  CONSTRAINT inventory_movements_source_shape CHECK (
    char_length(source_type) BETWEEN 3 AND 80
      AND source_type ~ '^[a-z][a-z0-9_]*$'
      AND source_ordinal BETWEEN 0 AND 9999
      AND occurred_tick >= 0 AND state_revision > 0
  )
);
--> statement-breakpoint
CREATE INDEX inventory_movements_inventory_cursor_idx
  ON inventory_movements (world_id, resource_type_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE businesses (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  display_name text NOT NULL,
  backing_organization_entity_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  status business_status NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_schema_version integer NOT NULL DEFAULT 1,
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  updated_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT businesses_world_identity UNIQUE (world_id, id),
  CONSTRAINT businesses_world_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT businesses_world_organization_unique UNIQUE (world_id, backing_organization_entity_id),
  CONSTRAINT businesses_wallet_unique UNIQUE (wallet_id),
  CONSTRAINT businesses_organization_world_fk
    FOREIGN KEY (world_id, backing_organization_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT businesses_wallet_world_currency_fk
    FOREIGN KEY (world_id, currency_id, wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT businesses_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT businesses_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT businesses_schema_known CHECK (business_schema_version = 1),
  CONSTRAINT businesses_versions_positive CHECK (
    row_version > 0 AND created_state_revision > 0
      AND updated_state_revision >= created_state_revision
  ),
  CONSTRAINT businesses_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT businesses_display_shape CHECK (
    char_length(display_name) BETWEEN 1 AND 100 AND display_name = btrim(display_name)
      AND display_name !~ '[[:cntrl:]]'
      AND jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384
      AND NOT worldgraph_jsonb_has_sensitive_key(metadata)
      AND NOT worldgraph_jsonb_has_compiler_private_key(metadata)
  ),
  CONSTRAINT businesses_status_shape CHECK (
    (status IN ('active','suspended') AND closed_at IS NULL)
      OR (status = 'closed' AND closed_at IS NOT NULL)
  ),
  CONSTRAINT businesses_timestamps_ordered CHECK (
    updated_at >= created_at AND (closed_at IS NULL OR closed_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX businesses_world_status_idx ON businesses (world_id, status, stable_key, id);
--> statement-breakpoint
CREATE TABLE business_facilities (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  business_id uuid NOT NULL,
  facility_asset_id uuid NOT NULL,
  facility_schema_version integer NOT NULL DEFAULT 1,
  status business_facility_status NOT NULL DEFAULT 'active',
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  updated_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_facilities_world_identity UNIQUE (world_id, id),
  CONSTRAINT business_facilities_world_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT business_facilities_world_asset_unique UNIQUE (world_id, facility_asset_id),
  CONSTRAINT business_facilities_business_world_fk
    FOREIGN KEY (world_id, business_id)
    REFERENCES businesses(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT business_facilities_asset_world_fk
    FOREIGN KEY (world_id, facility_asset_id)
    REFERENCES assets(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT business_facilities_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT business_facilities_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT business_facilities_schema_known CHECK (facility_schema_version = 1),
  CONSTRAINT business_facilities_versions_positive CHECK (
    row_version > 0 AND created_state_revision > 0
      AND updated_state_revision >= created_state_revision
  ),
  CONSTRAINT business_facilities_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT business_facilities_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE TABLE business_facility_recipe_versions (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  facility_id uuid NOT NULL,
  recipe_version_id uuid NOT NULL,
  configured_command_id uuid NOT NULL,
  configured_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, recipe_version_id),
  CONSTRAINT business_facility_recipes_facility_world_fk
    FOREIGN KEY (world_id, facility_id)
    REFERENCES business_facilities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT business_facility_recipes_recipe_world_fk
    FOREIGN KEY (world_id, recipe_version_id)
    REFERENCES production_recipe_versions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT business_facility_recipes_command_world_fk
    FOREIGN KEY (configured_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT business_facility_recipes_event_world_fk
    FOREIGN KEY (world_id, configured_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX business_facility_recipes_recipe_idx
  ON business_facility_recipe_versions (world_id, recipe_version_id, facility_id);
--> statement-breakpoint
CREATE TABLE production_runs (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL,
  facility_id uuid NOT NULL,
  recipe_version_id uuid NOT NULL,
  scheduled_action_id uuid NOT NULL,
  quantity numeric(30,12) NOT NULL,
  status production_run_status NOT NULL,
  due_tick bigint NOT NULL,
  input_snapshot jsonb NOT NULL,
  output_snapshot jsonb NOT NULL,
  snapshot_checksum bytea NOT NULL,
  failure_code text,
  production_run_schema_version integer NOT NULL DEFAULT 1,
  row_version bigint NOT NULL DEFAULT 1,
  start_command_id uuid NOT NULL UNIQUE,
  start_event_id uuid NOT NULL UNIQUE,
  terminal_command_id uuid UNIQUE,
  terminal_event_id uuid UNIQUE,
  created_state_revision bigint NOT NULL,
  terminal_state_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT production_runs_world_identity UNIQUE (world_id, id),
  CONSTRAINT production_runs_schedule_unique UNIQUE (scheduled_action_id),
  CONSTRAINT production_runs_business_world_fk
    FOREIGN KEY (world_id, business_id)
    REFERENCES businesses(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT production_runs_facility_world_fk
    FOREIGN KEY (world_id, facility_id)
    REFERENCES business_facilities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT production_runs_recipe_world_fk
    FOREIGN KEY (world_id, recipe_version_id)
    REFERENCES production_recipe_versions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT production_runs_schedule_world_fk
    FOREIGN KEY (world_id, scheduled_action_id)
    REFERENCES scheduled_actions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT production_runs_start_command_world_fk
    FOREIGN KEY (start_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT production_runs_terminal_command_world_fk
    FOREIGN KEY (terminal_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT production_runs_start_event_world_fk
    FOREIGN KEY (world_id, start_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT production_runs_terminal_event_world_fk
    FOREIGN KEY (world_id, terminal_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT production_runs_schema_known CHECK (production_run_schema_version = 1),
  CONSTRAINT production_runs_quantity_tick_valid CHECK (
    quantity > 0 AND quantity < 1000000000000000000::numeric
      AND due_tick >= 0 AND row_version > 0 AND created_state_revision > 0
  ),
  CONSTRAINT production_runs_snapshot_valid CHECK (
    jsonb_typeof(input_snapshot) = 'array' AND jsonb_typeof(output_snapshot) = 'array'
      AND pg_column_size(input_snapshot) <= 32768
      AND pg_column_size(output_snapshot) <= 32768
      AND octet_length(snapshot_checksum) = 32
      AND snapshot_checksum = extensions.digest(convert_to(worldgraph_canonical_jsonb(
        jsonb_build_object('inputs',input_snapshot,'outputs',output_snapshot)
      ),'UTF8'),'sha256')
  ),
  CONSTRAINT production_runs_failure_shape CHECK (
    failure_code IS NULL OR (
      char_length(failure_code) BETWEEN 3 AND 100
      AND failure_code ~ '^[A-Z][A-Z0-9_]*$'
    )
  ),
  CONSTRAINT production_runs_status_shape CHECK (
    (status IN ('scheduled','reserving','ready') AND terminal_command_id IS NULL
      AND terminal_event_id IS NULL AND terminal_state_revision IS NULL
      AND completed_at IS NULL AND failure_code IS NULL)
    OR (status = 'completed' AND terminal_command_id IS NOT NULL
      AND terminal_event_id IS NOT NULL AND terminal_state_revision IS NOT NULL
      AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR (status IN ('failed','cancelled') AND terminal_command_id IS NOT NULL
      AND terminal_event_id IS NOT NULL AND terminal_state_revision IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  CONSTRAINT production_runs_timestamps_ordered CHECK (
    updated_at >= created_at AND (completed_at IS NULL OR completed_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX production_runs_due_idx
  ON production_runs (due_tick, world_id, id) WHERE status = 'ready';
--> statement-breakpoint
CREATE INDEX production_runs_business_status_idx
  ON production_runs (world_id, business_id, status, due_tick, id);
--> statement-breakpoint
CREATE TABLE production_run_transitions (
  run_id uuid NOT NULL,
  world_id uuid NOT NULL,
  transition_version bigint NOT NULL,
  status production_run_status NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  occurred_tick bigint NOT NULL,
  state_revision bigint NOT NULL,
  snapshot_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, transition_version),
  CONSTRAINT production_run_transitions_event_unique UNIQUE (event_id),
  CONSTRAINT production_run_transitions_run_world_fk
    FOREIGN KEY (world_id, run_id)
    REFERENCES production_runs(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT production_run_transitions_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT production_run_transitions_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT production_run_transitions_values_valid CHECK (
    transition_version > 0 AND occurred_tick >= 0 AND state_revision > 0
      AND octet_length(snapshot_hash) = 32
  )
);
--> statement-breakpoint
CREATE TABLE employment_offers (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  business_id uuid NOT NULL,
  role_code text NOT NULL,
  wage_minor bigint NOT NULL,
  currency_id uuid NOT NULL,
  cadence_ticks bigint NOT NULL,
  max_payments_per_period integer NOT NULL,
  status employment_offer_status NOT NULL DEFAULT 'open',
  source_world_version_id uuid NOT NULL,
  source_plan_hash bytea NOT NULL,
  employment_offer_schema_version integer NOT NULL DEFAULT 1,
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT employment_offers_world_identity UNIQUE (world_id, id),
  CONSTRAINT employment_offers_world_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT employment_offers_business_world_fk
    FOREIGN KEY (world_id, business_id)
    REFERENCES businesses(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT employment_offers_currency_world_fk
    FOREIGN KEY (world_id, currency_id)
    REFERENCES currencies(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT employment_offers_seed_fk
    FOREIGN KEY (world_id, source_world_version_id, source_plan_hash)
    REFERENCES compiled_economy_seed_plans(world_id, world_version_id, plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT employment_offers_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT employment_offers_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT employment_offers_schema_known CHECK (employment_offer_schema_version = 1),
  CONSTRAINT employment_offers_values_valid CHECK (
    wage_minor > 0 AND cadence_ticks > 0
      AND max_payments_per_period BETWEEN 1 AND 1000
      AND row_version > 0 AND created_state_revision > 0
  ),
  CONSTRAINT employment_offers_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
      AND stable_key::text = lower(stable_key::text)
      AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
      AND char_length(role_code) BETWEEN 1 AND 80
      AND role_code ~ '^[a-z][a-z0-9-]*$'
  ),
  CONSTRAINT employment_offers_hash_length CHECK (octet_length(source_plan_hash) = 32),
  CONSTRAINT employment_offers_status_shape CHECK (
    (status = 'open' AND closed_at IS NULL)
      OR (status IN ('closed','retired') AND closed_at IS NOT NULL)
  ),
  CONSTRAINT employment_offers_timestamps_ordered CHECK (
    updated_at >= created_at AND (closed_at IS NULL OR closed_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX employment_offers_world_status_idx
  ON employment_offers (world_id, status, business_id, stable_key, id);
--> statement-breakpoint
CREATE TABLE employment_contracts (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  business_id uuid NOT NULL,
  source_offer_id uuid,
  worker_entity_id uuid NOT NULL,
  employer_wallet_id uuid NOT NULL,
  worker_wallet_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  role_code text NOT NULL,
  wage_rule wage_rule_kind NOT NULL,
  wage_minor bigint NOT NULL,
  cadence_ticks bigint,
  output_rule jsonb,
  cooldown_ticks bigint NOT NULL DEFAULT 0,
  reward_cap_minor bigint NOT NULL,
  max_payments_per_period integer NOT NULL DEFAULT 1,
  effective_from_tick bigint NOT NULL,
  effective_until_tick bigint,
  status employment_contract_status NOT NULL DEFAULT 'offered',
  exclusive_slot_key text,
  employment_contract_schema_version integer NOT NULL DEFAULT 1,
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL UNIQUE,
  created_event_id uuid NOT NULL UNIQUE,
  accepted_command_id uuid UNIQUE,
  accepted_event_id uuid UNIQUE,
  terminal_command_id uuid UNIQUE,
  terminal_event_id uuid UNIQUE,
  terminal_reason text,
  created_state_revision bigint NOT NULL,
  accepted_state_revision bigint,
  terminal_state_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT employment_contracts_world_identity UNIQUE (world_id, id),
  CONSTRAINT employment_contracts_world_key_unique UNIQUE (world_id, stable_key),
  CONSTRAINT employment_contracts_business_world_fk
    FOREIGN KEY (world_id, business_id)
    REFERENCES businesses(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT employment_contracts_offer_world_fk
    FOREIGN KEY (world_id, source_offer_id)
    REFERENCES employment_offers(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT employment_contracts_worker_world_fk
    FOREIGN KEY (world_id, worker_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT employment_contracts_employer_wallet_world_fk
    FOREIGN KEY (world_id, currency_id, employer_wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT employment_contracts_worker_wallet_world_fk
    FOREIGN KEY (world_id, currency_id, worker_wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT employment_contracts_created_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT employment_contracts_accepted_command_world_fk
    FOREIGN KEY (accepted_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT employment_contracts_terminal_command_world_fk
    FOREIGN KEY (terminal_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT employment_contracts_created_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT employment_contracts_accepted_event_world_fk
    FOREIGN KEY (world_id, accepted_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT employment_contracts_terminal_event_world_fk
    FOREIGN KEY (world_id, terminal_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT employment_contracts_schema_known CHECK (employment_contract_schema_version = 1),
  CONSTRAINT employment_contracts_amount_tick_valid CHECK (
    wage_minor > 0 AND reward_cap_minor >= wage_minor
      AND cooldown_ticks >= 0 AND effective_from_tick >= 0
      AND (effective_until_tick IS NULL OR effective_until_tick > effective_from_tick)
      AND max_payments_per_period BETWEEN 1 AND 1000
      AND row_version > 0 AND created_state_revision > 0
      AND (accepted_state_revision IS NULL OR accepted_state_revision >= created_state_revision)
      AND (terminal_state_revision IS NULL OR terminal_state_revision >= created_state_revision)
  ),
  CONSTRAINT employment_contracts_rule_shape CHECK (
    (wage_rule = 'per_shift' AND cadence_ticks IS NOT NULL AND cadence_ticks > 0
      AND output_rule IS NULL)
    OR (wage_rule = 'per_output' AND cadence_ticks IS NULL
      AND jsonb_typeof(output_rule) = 'object' AND pg_column_size(output_rule) <= 8192
      AND NOT worldgraph_jsonb_has_sensitive_key(output_rule))
  ),
  CONSTRAINT employment_contracts_role_shape CHECK (
    char_length(role_code) BETWEEN 1 AND 80 AND role_code ~ '^[a-z][a-z0-9._-]*$'
      AND (exclusive_slot_key IS NULL OR (
        char_length(exclusive_slot_key) BETWEEN 1 AND 80
        AND exclusive_slot_key ~ '^[a-z][a-z0-9._-]*$'
      ))
  ),
  CONSTRAINT employment_contracts_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT employment_contracts_status_shape CHECK (
    (status = 'offered' AND accepted_command_id IS NULL AND accepted_event_id IS NULL
      AND accepted_state_revision IS NULL
      AND terminal_command_id IS NULL AND terminal_event_id IS NULL
      AND terminal_reason IS NULL AND terminal_state_revision IS NULL AND ended_at IS NULL)
    OR (status = 'active' AND accepted_command_id IS NOT NULL AND accepted_event_id IS NOT NULL
      AND accepted_state_revision IS NOT NULL
      AND terminal_command_id IS NULL AND terminal_event_id IS NULL
      AND terminal_reason IS NULL AND terminal_state_revision IS NULL AND ended_at IS NULL)
    OR (status = 'ended' AND accepted_command_id IS NOT NULL
      AND accepted_event_id IS NOT NULL AND accepted_state_revision IS NOT NULL
      AND terminal_command_id IS NOT NULL
      AND terminal_event_id IS NOT NULL AND terminal_state_revision IS NOT NULL
      AND terminal_reason IS NOT NULL
      AND terminal_state_revision >= accepted_state_revision
      AND ended_at IS NOT NULL)
    OR (status = 'cancelled'
      AND ((accepted_command_id IS NULL AND accepted_event_id IS NULL
          AND accepted_state_revision IS NULL)
        OR (accepted_command_id IS NOT NULL AND accepted_event_id IS NOT NULL
          AND accepted_state_revision IS NOT NULL))
      AND terminal_command_id IS NOT NULL
      AND terminal_event_id IS NOT NULL AND terminal_state_revision IS NOT NULL
      AND terminal_reason IS NOT NULL
      AND ended_at IS NOT NULL)
  ),
  CONSTRAINT employment_contracts_terminal_reason_bounded CHECK (
    terminal_reason IS NULL OR (
      char_length(terminal_reason) BETWEEN 1 AND 240
      AND terminal_reason = btrim(terminal_reason)
      AND terminal_reason !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT employment_contracts_parties_distinct CHECK (employer_wallet_id <> worker_wallet_id),
  CONSTRAINT employment_contracts_timestamps_ordered CHECK (
    updated_at >= created_at AND (ended_at IS NULL OR ended_at >= created_at)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX employment_contracts_active_exclusive_slot_idx
  ON employment_contracts (world_id, worker_entity_id, exclusive_slot_key)
  WHERE status = 'active' AND exclusive_slot_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX employment_contracts_worker_status_idx
  ON employment_contracts (world_id, worker_entity_id, status, effective_from_tick, id);
--> statement-breakpoint
CREATE TABLE work_records (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL,
  work_key text NOT NULL,
  performed_tick bigint NOT NULL,
  validated_output jsonb NOT NULL DEFAULT '{}'::jsonb,
  gross_minor bigint NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_records_world_identity UNIQUE (world_id, id),
  CONSTRAINT work_records_contract_key_unique UNIQUE (contract_id, work_key),
  CONSTRAINT work_records_contract_world_fk
    FOREIGN KEY (world_id, contract_id)
    REFERENCES employment_contracts(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_records_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT work_records_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT work_records_values_valid CHECK (
    performed_tick >= 0 AND gross_minor > 0 AND state_revision > 0
      AND char_length(work_key) BETWEEN 8 AND 128
      AND work_key = btrim(work_key) AND work_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
      AND jsonb_typeof(validated_output) = 'object'
      AND pg_column_size(validated_output) <= 16384
      AND NOT worldgraph_jsonb_has_sensitive_key(validated_output)
      AND NOT worldgraph_jsonb_has_compiler_private_key(validated_output)
  )
);
--> statement-breakpoint
CREATE INDEX work_records_contract_tick_idx
  ON work_records (world_id, contract_id, performed_tick DESC, id DESC);
--> statement-breakpoint
CREATE TABLE payroll_records (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL,
  work_record_id uuid NOT NULL UNIQUE,
  scheduled_action_id uuid NOT NULL UNIQUE,
  pay_period_key text NOT NULL,
  gross_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  net_minor bigint NOT NULL,
  tax_policy_id uuid,
  financial_transaction_id uuid UNIQUE,
  status payroll_status NOT NULL,
  error_code text,
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL UNIQUE,
  created_event_id uuid NOT NULL UNIQUE,
  terminal_command_id uuid UNIQUE,
  terminal_event_id uuid UNIQUE,
  created_state_revision bigint NOT NULL,
  terminal_state_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT payroll_records_world_identity UNIQUE (world_id, id),
  CONSTRAINT payroll_records_contract_period_unique UNIQUE (contract_id, pay_period_key),
  CONSTRAINT payroll_records_contract_world_fk
    FOREIGN KEY (world_id, contract_id)
    REFERENCES employment_contracts(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_records_work_world_fk
    FOREIGN KEY (world_id, work_record_id)
    REFERENCES work_records(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_records_schedule_world_fk
    FOREIGN KEY (world_id, scheduled_action_id)
    REFERENCES scheduled_actions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_records_transaction_world_fk
    FOREIGN KEY (world_id, financial_transaction_id)
    REFERENCES financial_transactions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_records_created_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT payroll_records_terminal_command_world_fk
    FOREIGN KEY (terminal_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT payroll_records_created_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT payroll_records_terminal_event_world_fk
    FOREIGN KEY (world_id, terminal_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT payroll_records_amounts_valid CHECK (
    gross_minor > 0 AND tax_minor >= 0 AND net_minor >= 0
      AND gross_minor = tax_minor + net_minor
      AND ((tax_minor = 0 AND tax_policy_id IS NULL)
        OR (tax_minor > 0 AND tax_policy_id IS NOT NULL))
      AND row_version > 0 AND created_state_revision > 0
      AND (terminal_state_revision IS NULL
        OR terminal_state_revision >= created_state_revision)
  ),
  CONSTRAINT payroll_records_period_shape CHECK (
    char_length(pay_period_key) BETWEEN 3 AND 128
      AND pay_period_key = btrim(pay_period_key)
      AND pay_period_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT payroll_records_status_shape CHECK (
    (status = 'pending' AND financial_transaction_id IS NULL AND error_code IS NULL
      AND terminal_command_id IS NULL AND terminal_event_id IS NULL
      AND terminal_state_revision IS NULL AND terminal_at IS NULL)
    OR (status = 'paid' AND financial_transaction_id IS NOT NULL AND error_code IS NULL
      AND terminal_command_id IS NOT NULL AND terminal_event_id IS NOT NULL
      AND terminal_state_revision IS NOT NULL AND terminal_at IS NOT NULL)
    OR (status = 'failed' AND financial_transaction_id IS NULL
      AND char_length(error_code) BETWEEN 3 AND 100
      AND error_code ~ '^[A-Z][A-Z0-9_]*$'
      AND terminal_command_id IS NOT NULL AND terminal_event_id IS NOT NULL
      AND terminal_state_revision IS NOT NULL AND terminal_at IS NOT NULL)
  ),
  CONSTRAINT payroll_records_timestamps_ordered CHECK (
    updated_at >= created_at AND (terminal_at IS NULL OR terminal_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX payroll_records_status_idx
  ON payroll_records (world_id, status, created_at, id);
--> statement-breakpoint
CREATE TABLE tax_policies (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  policy_version integer NOT NULL,
  authority_entity_id uuid NOT NULL,
  treasury_wallet_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  tax_type tax_policy_type NOT NULL,
  collection_mode tax_collection_mode NOT NULL,
  rounding_mode text NOT NULL DEFAULT 'floor',
  rate_basis_points integer,
  fixed_amount_minor bigint,
  applicability jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from_tick bigint NOT NULL,
  effective_until_tick bigint,
  primitive_ref text NOT NULL,
  primitive_key extensions.citext NOT NULL,
  primitive_version text NOT NULL,
  primitive_version_id uuid NOT NULL,
  primitive_content_hash bytea NOT NULL,
  source_world_version_id uuid NOT NULL,
  source_plan_hash bytea NOT NULL,
  status tax_policy_status NOT NULL DEFAULT 'active',
  calculation_version integer NOT NULL DEFAULT 1,
  tax_policy_schema_version integer NOT NULL DEFAULT 1,
  checksum bytea NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_policies_world_identity UNIQUE (world_id, id),
  CONSTRAINT tax_policies_key_version_unique UNIQUE (world_id, stable_key, policy_version),
  CONSTRAINT tax_policies_authority_world_fk
    FOREIGN KEY (world_id, authority_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_policies_treasury_world_currency_fk
    FOREIGN KEY (world_id, currency_id, treasury_wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_policies_primitive_exact_fk
    FOREIGN KEY (primitive_version_id, primitive_content_hash)
    REFERENCES primitive_versions(id, content_hash) ON DELETE RESTRICT,
  CONSTRAINT tax_policies_seed_fk
    FOREIGN KEY (world_id, source_world_version_id, source_plan_hash)
    REFERENCES compiled_economy_seed_plans(world_id, world_version_id, plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT tax_policies_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT tax_policies_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT tax_policies_schema_known CHECK (
    calculation_version = 1 AND tax_policy_schema_version = 1
  ),
  CONSTRAINT tax_policies_rate_shape CHECK (
    (tax_type = 'periodic_flat' AND rate_basis_points IS NULL
      AND fixed_amount_minor IS NOT NULL AND fixed_amount_minor > 0)
    OR (tax_type <> 'periodic_flat' AND rate_basis_points BETWEEN 0 AND 5000
      AND fixed_amount_minor IS NULL)
  ),
  CONSTRAINT tax_policies_rounding_known CHECK (rounding_mode = 'floor'),
  CONSTRAINT tax_policies_collection_mode_exact CHECK (
    (tax_type IN ('payroll','marketplace_fee')
      AND collection_mode = 'withheld_from_recipient')
    OR (tax_type = 'periodic_flat' AND collection_mode = 'added_to_payer')
    OR tax_type IN ('sales','transaction')
  ),
  CONSTRAINT tax_policies_tick_valid CHECK (
    effective_from_tick >= 0
      AND (effective_until_tick IS NULL OR effective_until_tick > effective_from_tick)
      AND policy_version BETWEEN 1 AND 2147483647 AND created_state_revision > 0
  ),
  CONSTRAINT tax_policies_primitive_provenance_shape CHECK (
    char_length(primitive_ref) BETWEEN 1 AND 160
      AND primitive_ref ~ '^[a-z][a-z0-9._-]*$'
      AND char_length(primitive_key::text) BETWEEN 5 AND 160
      AND primitive_key::text = lower(primitive_key::text)
      AND primitive_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT tax_policies_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 3 AND 240
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT tax_policies_json_safe CHECK (
    jsonb_typeof(applicability) = 'object' AND pg_column_size(applicability) <= 16384
      AND NOT worldgraph_jsonb_has_sensitive_key(applicability)
      AND NOT worldgraph_jsonb_has_compiler_private_key(applicability)
  ),
  CONSTRAINT tax_policies_applicability_exact CHECK (
    (tax_type <> 'periodic_flat' AND applicability = '{}'::jsonb)
    OR (tax_type = 'periodic_flat'
      AND worldgraph_jsonb_has_exact_keys(
        applicability, ARRAY['intervalTicks','payerEntityId','payerWalletId']
      )
      AND applicability ->> 'intervalTicks' ~ '^[1-9][0-9]{0,18}$'
      AND (applicability ->> 'intervalTicks')::numeric
        BETWEEN 1 AND 9223372036854775807::numeric
      AND applicability ->> 'payerEntityId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND applicability ->> 'payerWalletId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  ),
  CONSTRAINT tax_policies_hash_lengths CHECK (
    octet_length(primitive_content_hash) = 32 AND octet_length(source_plan_hash) = 32
      AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE INDEX tax_policies_effective_idx
  ON tax_policies (world_id, tax_type, status, effective_from_tick, effective_until_tick, id);
--> statement-breakpoint
ALTER TABLE payroll_records
  ADD CONSTRAINT payroll_records_tax_policy_world_fk
  FOREIGN KEY (world_id, tax_policy_id)
  REFERENCES tax_policies(world_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE market_listings (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  seller_entity_id uuid NOT NULL,
  seller_inventory_id uuid NOT NULL,
  resource_type_id uuid NOT NULL,
  seller_wallet_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  scheduled_action_id uuid NOT NULL UNIQUE,
  offered_quantity numeric(30,12) NOT NULL,
  remaining_quantity numeric(30,12) NOT NULL,
  reserved_quantity numeric(30,12) NOT NULL,
  unit_price_minor bigint NOT NULL,
  status market_listing_status NOT NULL DEFAULT 'open',
  expires_at_tick bigint NOT NULL,
  market_listing_schema_version integer NOT NULL DEFAULT 1,
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL UNIQUE,
  created_event_id uuid NOT NULL UNIQUE,
  terminal_command_id uuid UNIQUE,
  terminal_event_id uuid UNIQUE,
  created_state_revision bigint NOT NULL,
  terminal_state_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT market_listings_world_identity UNIQUE (world_id, id),
  CONSTRAINT market_listings_seller_world_fk
    FOREIGN KEY (world_id, seller_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_listings_inventory_world_fk
    FOREIGN KEY (world_id, seller_inventory_id)
    REFERENCES inventories(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_listings_resource_world_fk
    FOREIGN KEY (world_id, resource_type_id)
    REFERENCES resource_types(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_listings_wallet_world_currency_fk
    FOREIGN KEY (world_id, currency_id, seller_wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_listings_schedule_world_fk
    FOREIGN KEY (world_id, scheduled_action_id)
    REFERENCES scheduled_actions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_listings_created_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT market_listings_terminal_command_world_fk
    FOREIGN KEY (terminal_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT market_listings_created_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT market_listings_terminal_event_world_fk
    FOREIGN KEY (world_id, terminal_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT market_listings_schema_known CHECK (market_listing_schema_version = 1),
  CONSTRAINT market_listings_values_valid CHECK (
    offered_quantity > 0 AND remaining_quantity >= 0
      AND remaining_quantity <= offered_quantity
      AND reserved_quantity >= 0 AND reserved_quantity <= remaining_quantity
      AND unit_price_minor > 0 AND expires_at_tick >= 0
      AND row_version > 0 AND created_state_revision > 0
  ),
  CONSTRAINT market_listings_status_shape CHECK (
    (status = 'open' AND remaining_quantity > 0 AND reserved_quantity = remaining_quantity
      AND terminal_command_id IS NULL AND terminal_event_id IS NULL
      AND terminal_state_revision IS NULL AND terminal_at IS NULL)
    OR (status = 'filled' AND remaining_quantity = 0 AND reserved_quantity = 0
      AND terminal_command_id IS NOT NULL AND terminal_event_id IS NOT NULL
      AND terminal_state_revision IS NOT NULL AND terminal_at IS NOT NULL)
    OR (status IN ('cancelled','expired') AND reserved_quantity = 0
      AND terminal_command_id IS NOT NULL AND terminal_event_id IS NOT NULL
      AND terminal_state_revision IS NOT NULL AND terminal_at IS NOT NULL)
  ),
  CONSTRAINT market_listings_timestamps_ordered CHECK (
    updated_at >= created_at AND (terminal_at IS NULL OR terminal_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX market_listings_due_idx
  ON market_listings (expires_at_tick, world_id, id) WHERE status = 'open';
--> statement-breakpoint
CREATE INDEX market_listings_discovery_idx
  ON market_listings (world_id, resource_type_id, status, unit_price_minor, id);
--> statement-breakpoint
CREATE INDEX market_listings_seller_idx
  ON market_listings (world_id, seller_entity_id, status, id);
--> statement-breakpoint
CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  inventory_id uuid NOT NULL,
  purpose_type inventory_reservation_purpose NOT NULL,
  purpose_id uuid NOT NULL,
  quantity numeric(30,12) NOT NULL,
  status inventory_reservation_status NOT NULL DEFAULT 'active',
  expires_at_tick bigint,
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  terminal_command_id uuid,
  terminal_event_id uuid,
  created_state_revision bigint NOT NULL,
  terminal_state_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT inventory_reservations_world_identity UNIQUE (world_id, id),
  CONSTRAINT inventory_reservations_purpose_inventory_unique
    UNIQUE (purpose_type, purpose_id, inventory_id),
  CONSTRAINT inventory_reservations_inventory_world_fk
    FOREIGN KEY (world_id, inventory_id)
    REFERENCES inventories(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_reservations_created_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_reservations_terminal_command_world_fk
    FOREIGN KEY (terminal_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_reservations_created_event_world_fk
    FOREIGN KEY (world_id, created_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT inventory_reservations_terminal_event_world_fk
    FOREIGN KEY (world_id, terminal_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT inventory_reservations_values_valid CHECK (
    quantity > 0 AND quantity < 1000000000000000000::numeric
      AND (expires_at_tick IS NULL OR expires_at_tick >= 0)
      AND row_version > 0 AND created_state_revision > 0
  ),
  CONSTRAINT inventory_reservations_purpose_shape CHECK (
    (purpose_type = 'market_listing' AND expires_at_tick IS NOT NULL)
      OR (purpose_type = 'production_input')
  ),
  CONSTRAINT inventory_reservations_status_shape CHECK (
    (status = 'active' AND terminal_command_id IS NULL AND terminal_event_id IS NULL
      AND terminal_state_revision IS NULL AND terminal_at IS NULL)
    OR (status <> 'active' AND terminal_command_id IS NOT NULL AND terminal_event_id IS NOT NULL
      AND terminal_state_revision IS NOT NULL AND terminal_at IS NOT NULL)
  ),
  CONSTRAINT inventory_reservations_timestamps_ordered CHECK (
    updated_at >= created_at AND (terminal_at IS NULL OR terminal_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX inventory_reservations_active_inventory_idx
  ON inventory_reservations (world_id, inventory_id, purpose_type, purpose_id)
  WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX inventory_reservations_expiry_idx
  ON inventory_reservations (expires_at_tick, world_id, id)
  WHERE status = 'active' AND expires_at_tick IS NOT NULL;
--> statement-breakpoint
CREATE TABLE market_trades (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL,
  buyer_entity_id uuid NOT NULL,
  seller_entity_id uuid NOT NULL,
  buyer_inventory_id uuid NOT NULL,
  seller_inventory_id uuid NOT NULL,
  quantity numeric(30,12) NOT NULL,
  unit_price_minor bigint NOT NULL,
  gross_minor bigint NOT NULL,
  buyer_total_minor bigint NOT NULL,
  seller_net_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  currency_id uuid NOT NULL,
  wallet_transaction_id uuid NOT NULL UNIQUE,
  occurred_tick bigint NOT NULL,
  idempotency_key text NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  state_revision bigint NOT NULL,
  rounding_policy_version integer NOT NULL DEFAULT 1,
  market_trade_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_trades_world_identity UNIQUE (world_id, id),
  CONSTRAINT market_trades_buyer_idempotency_unique
    UNIQUE (world_id, buyer_entity_id, idempotency_key),
  CONSTRAINT market_trades_listing_world_fk
    FOREIGN KEY (world_id, listing_id)
    REFERENCES market_listings(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_trades_buyer_world_fk
    FOREIGN KEY (world_id, buyer_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_trades_seller_world_fk
    FOREIGN KEY (world_id, seller_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_trades_buyer_inventory_world_fk
    FOREIGN KEY (world_id, buyer_inventory_id)
    REFERENCES inventories(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_trades_seller_inventory_world_fk
    FOREIGN KEY (world_id, seller_inventory_id)
    REFERENCES inventories(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_trades_transaction_world_currency_fk
    FOREIGN KEY (world_id, currency_id, wallet_transaction_id)
    REFERENCES financial_transactions(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT market_trades_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT market_trades_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT market_trades_schema_known CHECK (
    rounding_policy_version = 1 AND market_trade_schema_version = 1
  ),
  CONSTRAINT market_trades_values_valid CHECK (
    quantity > 0 AND unit_price_minor > 0 AND gross_minor > 0
      AND buyer_total_minor > 0 AND seller_net_minor >= 0
      AND tax_minor >= 0 AND fee_minor >= 0
      AND buyer_total_minor = seller_net_minor + tax_minor + fee_minor
      AND occurred_tick >= 0 AND state_revision > 0
  ),
  CONSTRAINT market_trades_parties_valid CHECK (
    buyer_entity_id <> seller_entity_id AND buyer_inventory_id <> seller_inventory_id
  ),
  CONSTRAINT market_trades_idempotency_shape CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 128
      AND idempotency_key = btrim(idempotency_key)
      AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  )
);
--> statement-breakpoint
CREATE INDEX market_trades_listing_cursor_idx
  ON market_trades (world_id, listing_id, occurred_tick DESC, id DESC);
--> statement-breakpoint
CREATE TABLE tax_assessments (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  policy_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  payer_entity_id uuid NOT NULL,
  payer_wallet_id uuid NOT NULL,
  treasury_wallet_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  basis_minor bigint NOT NULL,
  amount_minor bigint NOT NULL,
  settlement_transaction_id uuid NOT NULL,
  occurred_tick bigint NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  state_revision bigint NOT NULL,
  tax_assessment_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_assessments_world_identity UNIQUE (world_id, id),
  CONSTRAINT tax_assessments_source_payer_unique
    UNIQUE (policy_id, source_type, source_id, payer_entity_id),
  CONSTRAINT tax_assessments_transaction_policy_payer_unique
    UNIQUE (settlement_transaction_id, policy_id, payer_entity_id),
  CONSTRAINT tax_assessments_policy_world_fk
    FOREIGN KEY (world_id, policy_id)
    REFERENCES tax_policies(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_assessments_payer_world_fk
    FOREIGN KEY (world_id, payer_entity_id)
    REFERENCES world_entities(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_assessments_payer_wallet_world_currency_fk
    FOREIGN KEY (world_id, currency_id, payer_wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_assessments_treasury_wallet_world_currency_fk
    FOREIGN KEY (world_id, currency_id, treasury_wallet_id)
    REFERENCES wallets(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_assessments_transaction_world_currency_fk
    FOREIGN KEY (world_id, currency_id, settlement_transaction_id)
    REFERENCES financial_transactions(world_id, currency_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_assessments_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT tax_assessments_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT tax_assessments_schema_known CHECK (tax_assessment_schema_version = 1),
  CONSTRAINT tax_assessments_values_valid CHECK (
    basis_minor >= 0 AND amount_minor >= 0 AND amount_minor <= 9223372036854775807
      AND occurred_tick >= 0 AND state_revision > 0
      AND char_length(source_type) BETWEEN 3 AND 80
      AND source_type ~ '^[a-z][a-z0-9_]*$'
      AND source_type IN ('market_trade','payroll','periodic_tax')
      AND payer_wallet_id <> treasury_wallet_id
  )
);
--> statement-breakpoint
CREATE INDEX tax_assessments_source_idx
  ON tax_assessments (world_id, source_type, source_id, occurred_tick, id);
--> statement-breakpoint
CREATE TABLE economy_expansion_reconciliation_runs (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  reconciliation_schema_version integer NOT NULL DEFAULT 2,
  source_state_revision bigint NOT NULL,
  source_event_sequence bigint NOT NULL,
  status economy_reconciliation_run_status NOT NULL,
  live_inventory_checksum bytea NOT NULL,
  rebuilt_inventory_checksum bytea NOT NULL,
  live_reservation_checksum bytea NOT NULL,
  rebuilt_reservation_checksum bytea NOT NULL,
  live_trade_checksum bytea NOT NULL,
  rebuilt_trade_checksum bytea NOT NULL,
  live_payroll_checksum bytea NOT NULL,
  rebuilt_payroll_checksum bytea NOT NULL,
  live_tax_checksum bytea NOT NULL,
  rebuilt_tax_checksum bytea NOT NULL,
  live_projection_checksum bytea NOT NULL,
  rebuilt_journal_checksum bytea NOT NULL,
  resource_count integer NOT NULL,
  inventory_count integer NOT NULL,
  trade_count integer NOT NULL,
  assessment_count integer NOT NULL,
  mismatch_count integer NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT economy_expansion_reconciliation_world_identity UNIQUE (world_id, id),
  CONSTRAINT economy_expansion_reconciliation_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_expansion_reconciliation_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT economy_expansion_reconciliation_schema_known CHECK (
    reconciliation_schema_version = 2
  ),
  CONSTRAINT economy_expansion_reconciliation_source_valid CHECK (
    source_state_revision > 0 AND source_event_sequence > 0
  ),
  CONSTRAINT economy_expansion_reconciliation_hash_lengths CHECK (
    octet_length(live_inventory_checksum) = 32
      AND octet_length(rebuilt_inventory_checksum) = 32
      AND octet_length(live_reservation_checksum) = 32
      AND octet_length(rebuilt_reservation_checksum) = 32
      AND octet_length(live_trade_checksum) = 32
      AND octet_length(rebuilt_trade_checksum) = 32
      AND octet_length(live_payroll_checksum) = 32
      AND octet_length(rebuilt_payroll_checksum) = 32
      AND octet_length(live_tax_checksum) = 32
      AND octet_length(rebuilt_tax_checksum) = 32
      AND octet_length(live_projection_checksum) = 32
      AND octet_length(rebuilt_journal_checksum) = 32
  ),
  CONSTRAINT economy_expansion_reconciliation_counts_valid CHECK (
    resource_count >= 0 AND inventory_count >= 0 AND trade_count >= 0
      AND assessment_count >= 0 AND mismatch_count >= 0
      AND ((status = 'matched' AND mismatch_count = 0
          AND live_projection_checksum = rebuilt_journal_checksum)
        OR (status = 'mismatch' AND mismatch_count > 0
          AND live_projection_checksum <> rebuilt_journal_checksum))
  )
);
--> statement-breakpoint
CREATE INDEX economy_expansion_reconciliation_world_cursor_idx
  ON economy_expansion_reconciliation_runs
    (world_id, source_state_revision DESC, created_at DESC, id DESC);
--> statement-breakpoint
ALTER TABLE world_economy_expansion_heads
  ADD CONSTRAINT world_economy_expansion_heads_reconciliation_run_world_fk
  FOREIGN KEY (world_id, last_reconciliation_run_id)
  REFERENCES economy_expansion_reconciliation_runs(world_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE economy_expansion_reconciliation_items (
  run_id uuid NOT NULL REFERENCES economy_expansion_reconciliation_runs(id) ON DELETE RESTRICT,
  item_ordinal integer NOT NULL,
  item_kind text NOT NULL,
  item_key text NOT NULL,
  item_key_hash bytea NOT NULL,
  expected_value text,
  actual_value text,
  mismatch_code text NOT NULL,
  PRIMARY KEY (run_id, item_ordinal),
  CONSTRAINT economy_expansion_reconciliation_items_ordinal CHECK (
    item_ordinal BETWEEN 0 AND 9999
  ),
  CONSTRAINT economy_expansion_reconciliation_items_kind CHECK (
    item_kind IN (
      'inventory_quantity','inventory_reservation','market_trade',
      'payroll','tax_assessment','production'
    )
  ),
  CONSTRAINT economy_expansion_reconciliation_items_key CHECK (
    char_length(item_key) BETWEEN 1 AND 240 AND item_key = btrim(item_key)
      AND item_key !~ '[[:cntrl:]]' AND octet_length(item_key_hash) = 32
      AND item_key_hash = extensions.digest(convert_to(item_key,'UTF8'),'sha256')
  ),
  CONSTRAINT economy_expansion_reconciliation_items_value CHECK (
    (expected_value IS NULL OR expected_value ~ '^(0|-?[1-9][0-9]{0,29})(\.[0-9]{1,12})?$|^[a-f0-9]{64}$')
      AND (actual_value IS NULL OR actual_value ~ '^(0|-?[1-9][0-9]{0,29})(\.[0-9]{1,12})?$|^[a-f0-9]{64}$')
      AND expected_value IS DISTINCT FROM actual_value
  ),
  CONSTRAINT economy_expansion_reconciliation_items_code CHECK (
    char_length(mismatch_code) BETWEEN 3 AND 100
      AND mismatch_code ~ '^[A-Z][A-Z0-9_]*$'
  )
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_recipe_version_is_valid_v1(checked_recipe_version_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  WITH checked AS (
    SELECT version.id, version.world_id, version.canonical_seed_inputs,
           version.canonical_seed_outputs, version.canonical_inputs,
           version.canonical_outputs, version.facility_requirements
    FROM public.production_recipe_versions version
    WHERE version.id = checked_recipe_version_id
  ), seed_components AS (
    SELECT checked.world_id, 'input'::text AS direction, item.value, item.ordinality
    FROM checked, jsonb_array_elements(checked.canonical_seed_inputs)
      WITH ORDINALITY item(value, ordinality)
    UNION ALL
    SELECT checked.world_id, 'output'::text, item.value, item.ordinality
    FROM checked, jsonb_array_elements(checked.canonical_seed_outputs)
      WITH ORDINALITY item(value, ordinality)
  ), runtime_components AS (
    SELECT checked.world_id, 'input'::text AS direction, item.value, item.ordinality
    FROM checked, jsonb_array_elements(checked.canonical_inputs) WITH ORDINALITY item(value, ordinality)
    UNION ALL
    SELECT checked.world_id, 'output'::text, item.value, item.ordinality
    FROM checked, jsonb_array_elements(checked.canonical_outputs) WITH ORDINALITY item(value, ordinality)
  ), resolved AS (
    SELECT runtime_components.*, resource.id AS resource_id, resource.stable_key::text AS resource_key,
           resource.quantity_scale
    FROM runtime_components
    LEFT JOIN public.resource_types resource
      ON resource.world_id = runtime_components.world_id
     AND resource.id::text = runtime_components.value ->> 'resourceTypeId'
  ), paired AS (
    SELECT runtime.direction, runtime.ordinality, runtime.value runtime_value,
           seed.value seed_value, runtime.resource_id, runtime.resource_key,
           runtime.quantity_scale
    FROM resolved runtime
    LEFT JOIN seed_components seed
      ON seed.world_id = runtime.world_id
     AND seed.direction = runtime.direction
     AND seed.ordinality = runtime.ordinality
  )
  SELECT EXISTS (SELECT 1 FROM checked)
    AND (SELECT jsonb_array_length(canonical_seed_inputs) = jsonb_array_length(canonical_inputs)
      AND jsonb_array_length(canonical_seed_outputs) = jsonb_array_length(canonical_outputs)
      FROM checked)
    AND NOT EXISTS (
      SELECT 1 FROM paired
      WHERE jsonb_typeof(runtime_value) <> 'object'
        OR jsonb_typeof(seed_value) <> 'object'
        OR NOT public.worldgraph_jsonb_has_exact_keys(
          runtime_value, ARRAY['quantity','resourceTypeId']
        )
        OR NOT public.worldgraph_jsonb_has_exact_keys(
          seed_value, ARRAY['quantity','resourceStableKey']
        )
        OR seed_value ->> 'resourceStableKey'
          !~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
        OR runtime_value ->> 'resourceTypeId'
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR runtime_value ->> 'quantity' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$'
        OR seed_value ->> 'quantity' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$'
        OR (runtime_value ->> 'quantity')::numeric <= 0
        OR runtime_value ->> 'quantity' IS DISTINCT FROM seed_value ->> 'quantity'
        OR resource_id IS NULL
        OR resource_key IS DISTINCT FROM seed_value ->> 'resourceStableKey'
        OR NOT public.worldgraph_quantity_fits_scale_v1(
          (runtime_value ->> 'quantity')::numeric, quantity_scale
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM paired
      GROUP BY direction, runtime_value ->> 'resourceTypeId'
      HAVING count(*) > 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM paired current_item
      JOIN paired previous_item
        ON previous_item.direction = current_item.direction
       AND previous_item.ordinality + 1 = current_item.ordinality
      WHERE (previous_item.seed_value ->> 'resourceStableKey') COLLATE "C"
        > (current_item.seed_value ->> 'resourceStableKey') COLLATE "C"
    )
    AND (SELECT facility_requirements FROM checked) = jsonb_build_object(
      'assetType', (SELECT facility_requirements ->> 'assetType' FROM checked)
    )
    AND char_length((SELECT facility_requirements ->> 'assetType' FROM checked)) BETWEEN 1 AND 80
), false);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_recipe_version_is_valid_v1(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_recipe_version_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT public.worldgraph_recipe_version_is_valid_v1(NEW.id) THEN
    RAISE EXCEPTION 'production recipe version is not canonical or references invalid resources'
      USING ERRCODE = '23514', CONSTRAINT = 'production_recipe_version_semantics_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER production_recipe_versions_require_exact_semantics
  AFTER INSERT ON production_recipe_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_recipe_version_v1();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_wallet_kind_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE checked_entity_type text;
BEGIN
  SELECT entity.entity_type INTO checked_entity_type
  FROM public.world_entities entity
  WHERE entity.world_id = NEW.world_id AND entity.id = NEW.owner_entity_id
    AND entity.retired_world_version_id IS NULL;
  IF checked_entity_type IS NULL OR NOT (
    (NEW.wallet_kind = 'treasury'::wallet_kind AND checked_entity_type = 'institution')
    OR (NEW.wallet_kind = 'organization'::wallet_kind AND checked_entity_type = 'organization')
    OR (NEW.wallet_kind = 'player'::wallet_kind AND checked_entity_type = 'player_character')
  ) THEN
    RAISE EXCEPTION 'wallet kind does not match its active owner entity type'
      USING ERRCODE = '23514', CONSTRAINT = 'wallet_kind_owner_entity_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallets_require_exact_owner_kind
  AFTER INSERT OR UPDATE OF owner_entity_id, wallet_kind ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_wallet_kind_owner();
--> statement-breakpoint
DO $existing_wallets$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.wallets wallet
    LEFT JOIN public.world_entities entity
      ON entity.world_id = wallet.world_id AND entity.id = wallet.owner_entity_id
     AND entity.retired_world_version_id IS NULL
    WHERE entity.id IS NULL OR NOT (
      (wallet.wallet_kind = 'treasury'::wallet_kind AND entity.entity_type = 'institution')
      OR (wallet.wallet_kind = 'organization'::wallet_kind AND entity.entity_type = 'organization')
      OR (wallet.wallet_kind = 'player'::wallet_kind AND entity.entity_type = 'player_character')
    )
  ) THEN
    RAISE EXCEPTION 'sealed M08 wallet owner kinds are inconsistent'
      USING ERRCODE = '55000';
  END IF;
END
$existing_wallets$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_inventory_scale_and_journal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE checked_inventory_id uuid;
DECLARE inventory_record record;
DECLARE rebuilt numeric;
DECLARE row_value jsonb := to_jsonb(NEW);
BEGIN
  checked_inventory_id := CASE TG_TABLE_NAME
    WHEN 'inventories' THEN (row_value ->> 'id')::uuid
    ELSE COALESCE(
      (row_value ->> 'to_inventory_id')::uuid,
      (row_value ->> 'from_inventory_id')::uuid
    )
  END;
  FOR inventory_record IN
    SELECT inventory.*, resource.quantity_scale
    FROM public.inventories inventory
    JOIN public.resource_types resource
      ON resource.world_id = inventory.world_id AND resource.id = inventory.resource_type_id
    WHERE inventory.id IN (
      checked_inventory_id,
      CASE WHEN TG_TABLE_NAME = 'inventory_movements'
        THEN (row_value ->> 'from_inventory_id')::uuid ELSE NULL END,
      CASE WHEN TG_TABLE_NAME = 'inventory_movements'
        THEN (row_value ->> 'to_inventory_id')::uuid ELSE NULL END
    )
  LOOP
    IF NOT public.worldgraph_quantity_fits_scale_v1(
        inventory_record.quantity, inventory_record.quantity_scale
      ) OR NOT public.worldgraph_quantity_fits_scale_v1(
        inventory_record.reserved_quantity, inventory_record.quantity_scale
      ) THEN
      RAISE EXCEPTION 'inventory quantity exceeds its resource scale'
        USING ERRCODE = '23514', CONSTRAINT = 'inventory_quantity_scale_exact';
    END IF;
    SELECT COALESCE(sum(CASE
      WHEN movement.to_inventory_id = inventory_record.id THEN movement.quantity
      WHEN movement.from_inventory_id = inventory_record.id THEN -movement.quantity
      ELSE 0 END), 0)
      INTO rebuilt
    FROM public.inventory_movements movement
    WHERE movement.world_id = inventory_record.world_id
      AND (movement.from_inventory_id = inventory_record.id
        OR movement.to_inventory_id = inventory_record.id);
    IF rebuilt IS DISTINCT FROM inventory_record.quantity THEN
      RAISE EXCEPTION 'inventory projection does not equal its immutable movement journal'
        USING ERRCODE = '23514', CONSTRAINT = 'inventory_projection_equals_journal';
    END IF;
  END LOOP;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER inventories_require_scale_and_journal
  AFTER INSERT OR UPDATE OF quantity, resource_type_id ON inventories
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_inventory_scale_and_journal();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER inventory_movements_require_scale_and_journal
  AFTER INSERT ON inventory_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_inventory_scale_and_journal();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_inventory_reservation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE reservation_record record;
DECLARE inventory_record record;
DECLARE active_total numeric;
BEGIN
  SELECT reservation.* INTO reservation_record
  FROM public.inventory_reservations reservation WHERE reservation.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT inventory.*, resource.quantity_scale INTO inventory_record
  FROM public.inventories inventory
  JOIN public.resource_types resource
    ON resource.world_id = inventory.world_id AND resource.id = inventory.resource_type_id
  WHERE inventory.id = reservation_record.inventory_id
    AND inventory.world_id = reservation_record.world_id;
  IF inventory_record.id IS NULL
    OR NOT public.worldgraph_quantity_fits_scale_v1(
      reservation_record.quantity, inventory_record.quantity_scale
    )
    OR (reservation_record.purpose_type = 'production_input' AND NOT EXISTS (
      SELECT 1 FROM public.production_runs run
      WHERE run.id = reservation_record.purpose_id
        AND run.world_id = reservation_record.world_id
    ))
    OR (reservation_record.purpose_type = 'market_listing' AND NOT EXISTS (
      SELECT 1 FROM public.market_listings listing
      WHERE listing.id = reservation_record.purpose_id
        AND listing.world_id = reservation_record.world_id
        AND listing.seller_inventory_id = reservation_record.inventory_id
        AND listing.expires_at_tick = reservation_record.expires_at_tick
        AND (
          (reservation_record.status = 'active'::inventory_reservation_status
            AND listing.status = 'open'::market_listing_status
            AND listing.reserved_quantity = reservation_record.quantity)
          OR (reservation_record.status = 'consumed'::inventory_reservation_status
            AND listing.status = 'filled'::market_listing_status
            AND listing.reserved_quantity = 0)
          OR (reservation_record.status = 'released'::inventory_reservation_status
            AND listing.status = 'cancelled'::market_listing_status
            AND listing.reserved_quantity = 0)
          OR (reservation_record.status = 'expired'::inventory_reservation_status
            AND listing.status = 'expired'::market_listing_status
            AND listing.reserved_quantity = 0)
        )
    )) THEN
    RAISE EXCEPTION 'inventory reservation has invalid scale or purpose binding'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_binding_exact';
  END IF;
  SELECT COALESCE(sum(reservation.quantity), 0) INTO active_total
  FROM public.inventory_reservations reservation
  WHERE reservation.inventory_id = reservation_record.inventory_id
    AND reservation.status = 'active'::inventory_reservation_status;
  IF active_total IS DISTINCT FROM inventory_record.reserved_quantity THEN
    RAISE EXCEPTION 'inventory reserved projection does not equal active reservations'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_projection_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER inventory_reservations_require_exact_binding
  AFTER INSERT OR UPDATE ON inventory_reservations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_inventory_reservation();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_inventory_reserved_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE active_total numeric;
BEGIN
  SELECT COALESCE(sum(reservation.quantity), 0) INTO active_total
  FROM public.inventory_reservations reservation
  WHERE reservation.inventory_id = NEW.id
    AND reservation.status = 'active'::inventory_reservation_status;
  IF active_total IS DISTINCT FROM NEW.reserved_quantity THEN
    RAISE EXCEPTION 'inventory reserved projection does not equal active reservations'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_projection_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER inventories_require_reserved_projection
  AFTER INSERT OR UPDATE OF reserved_quantity ON inventories
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_inventory_reserved_projection();
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_expansion_projection_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN jsonb_build_object(
  'businesses', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'businessId', business.id::text,
      'organizationEntityId', business.backing_organization_entity_id::text,
      'rowVersion', business.row_version::text,
      'stableKey', business.stable_key::text,
      'status', business.status::text,
      'walletId', business.wallet_id::text
    ) ORDER BY business.stable_key::text COLLATE "C", business.id)
    FROM public.businesses business WHERE business.world_id = checked_world_id
  ), '[]'::jsonb),
  'contracts', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'businessId', contract.business_id::text,
      'contractId', contract.id::text,
      'rowVersion', contract.row_version::text,
      'status', contract.status::text,
      'workerEntityId', contract.worker_entity_id::text
    ) ORDER BY contract.stable_key::text COLLATE "C", contract.id)
    FROM public.employment_contracts contract WHERE contract.world_id = checked_world_id
  ), '[]'::jsonb),
  'domain', 'worldgraph.economy-closed-loop-projection.v1',
  'economyClosedLoopProjectionSchemaVersion', 1,
  'facilities', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'businessId', facility.business_id::text,
      'facilityAssetId', facility.facility_asset_id::text,
      'facilityId', facility.id::text,
      'rowVersion', facility.row_version::text,
      'status', facility.status::text
    ) ORDER BY facility.stable_key::text COLLATE "C", facility.id)
    FROM public.business_facilities facility WHERE facility.world_id = checked_world_id
  ), '[]'::jsonb),
  'inventories', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'containerAssetId', inventory.container_asset_id::text,
      'inventoryId', inventory.id::text,
      'ownerEntityId', inventory.owner_entity_id::text,
      'quantity', inventory.quantity::text,
      'reservedQuantity', inventory.reserved_quantity::text,
      'resourceTypeId', inventory.resource_type_id::text,
      'rowVersion', inventory.row_version::text,
      'stableKey', inventory.stable_key::text
    ) ORDER BY inventory.stable_key::text COLLATE "C", inventory.id)
    FROM public.inventories inventory WHERE inventory.world_id = checked_world_id
  ), '[]'::jsonb),
  'listings', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'listingId', listing.id::text,
      'remainingQuantity', listing.remaining_quantity::text,
      'reservedQuantity', listing.reserved_quantity::text,
      'rowVersion', listing.row_version::text,
      'status', listing.status::text
    ) ORDER BY listing.id)
    FROM public.market_listings listing WHERE listing.world_id = checked_world_id
  ), '[]'::jsonb),
  'productionRuns', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'dueTick', run.due_tick::text,
      'rowVersion', run.row_version::text,
      'runId', run.id::text,
      'status', run.status::text
    ) ORDER BY run.id)
    FROM public.production_runs run WHERE run.world_id = checked_world_id
  ), '[]'::jsonb),
  'resources', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'quantityScale', resource.quantity_scale,
      'resourceTypeId', resource.id::text,
      'stableKey', resource.stable_key::text,
      'status', resource.status::text,
      'unitCode', resource.unit_code
    ) ORDER BY resource.stable_key::text COLLATE "C", resource.id)
    FROM public.resource_types resource WHERE resource.world_id = checked_world_id
  ), '[]'::jsonb),
  'seed', (
    SELECT jsonb_build_object(
      'seedPlanHash', encode(head.seed_plan_hash,'hex'),
      'sourceWorldVersionId', head.source_world_version_id::text
    ) FROM public.world_economy_expansion_heads head
    WHERE head.world_id = checked_world_id
  ),
  'worldId', checked_world_id::text
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_expansion_projection_checksum(checked_world_id uuid)
RETURNS bytea
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
RETURN extensions.digest(convert_to(worldgraph_canonical_jsonb(
  worldgraph_economy_expansion_projection_document(checked_world_id)
), 'UTF8'), 'sha256');
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_inventory_live_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'inventoryId', inventory.id::text,
    'quantity', inventory.quantity::text
  ) ORDER BY inventory.id)
  FROM public.inventories inventory WHERE inventory.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_inventory_rebuilt_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'inventoryId', inventory.id::text,
    'quantity', COALESCE(movement.quantity, 0)::numeric(36,12)::text
  ) ORDER BY inventory.id)
  FROM public.inventories inventory
  LEFT JOIN (
    SELECT endpoint.inventory_id, sum(endpoint.quantity) quantity
    FROM (
      SELECT movement.to_inventory_id inventory_id, movement.quantity
      FROM public.inventory_movements movement
      WHERE movement.world_id = checked_world_id AND movement.to_inventory_id IS NOT NULL
      UNION ALL
      SELECT movement.from_inventory_id, -movement.quantity
      FROM public.inventory_movements movement
      WHERE movement.world_id = checked_world_id AND movement.from_inventory_id IS NOT NULL
    ) endpoint GROUP BY endpoint.inventory_id
  ) movement ON movement.inventory_id = inventory.id
  WHERE inventory.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_reservation_live_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'inventoryId', inventory.id::text,
    'reservedQuantity', inventory.reserved_quantity::text
  ) ORDER BY inventory.id)
  FROM public.inventories inventory WHERE inventory.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_reservation_rebuilt_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'inventoryId', inventory.id::text,
    'reservedQuantity', COALESCE(reservation.quantity, 0)::numeric(36,12)::text
  ) ORDER BY inventory.id)
  FROM public.inventories inventory
  LEFT JOIN (
    SELECT active.inventory_id, sum(active.quantity) quantity
    FROM public.inventory_reservations active
    WHERE active.world_id = checked_world_id
      AND active.status = 'active'::inventory_reservation_status
    GROUP BY active.inventory_id
  ) reservation ON reservation.inventory_id = inventory.id
  WHERE inventory.world_id = checked_world_id
), '[]'::jsonb);
--> statement-breakpoint
CREATE FUNCTION worldgraph_reconcile_economy_expansion(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
AS $function$
WITH documents AS (
  SELECT
    worldgraph_economy_inventory_live_document(checked_world_id) inventory_live,
    worldgraph_economy_inventory_rebuilt_document(checked_world_id) inventory_rebuilt,
    worldgraph_economy_reservation_live_document(checked_world_id) reservation_live,
    worldgraph_economy_reservation_rebuilt_document(checked_world_id) reservation_rebuilt,
    COALESCE((SELECT jsonb_agg(to_jsonb(trade) ORDER BY trade.id)
      FROM public.market_trades trade WHERE trade.world_id = checked_world_id),'[]'::jsonb) trade_live,
    COALESCE((SELECT jsonb_agg(to_jsonb(payroll) ORDER BY payroll.id)
      FROM public.payroll_records payroll WHERE payroll.world_id = checked_world_id),'[]'::jsonb) payroll_live,
    COALESCE((SELECT jsonb_agg(to_jsonb(assessment) ORDER BY assessment.id)
      FROM public.tax_assessments assessment WHERE assessment.world_id = checked_world_id),'[]'::jsonb) tax_live
), hashes AS (
  SELECT documents.*,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(inventory_live),'UTF8'),'sha256') inventory_live_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(inventory_rebuilt),'UTF8'),'sha256') inventory_rebuilt_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(reservation_live),'UTF8'),'sha256') reservation_live_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(reservation_rebuilt),'UTF8'),'sha256') reservation_rebuilt_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(trade_live),'UTF8'),'sha256') trade_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(payroll_live),'UTF8'),'sha256') payroll_hash,
    extensions.digest(convert_to(worldgraph_canonical_jsonb(tax_live),'UTF8'),'sha256') tax_hash
  FROM documents
)
SELECT jsonb_build_object(
  'assessmentCount', (SELECT count(*) FROM public.tax_assessments WHERE world_id = checked_world_id),
  'inventoryCount', (SELECT count(*) FROM public.inventories WHERE world_id = checked_world_id),
  'liveInventoryChecksum', encode(inventory_live_hash,'hex'),
  'livePayrollChecksum', encode(payroll_hash,'hex'),
  'liveReservationChecksum', encode(reservation_live_hash,'hex'),
  'liveTaxChecksum', encode(tax_hash,'hex'),
  'liveTradeChecksum', encode(trade_hash,'hex'),
  'matched', inventory_live = inventory_rebuilt AND reservation_live = reservation_rebuilt,
  'mismatchCount', (inventory_live <> inventory_rebuilt)::integer
    + (reservation_live <> reservation_rebuilt)::integer,
  'liveProjectionChecksum', encode(extensions.digest(convert_to(
    worldgraph_canonical_jsonb(jsonb_build_object(
      'inventoryChecksum', encode(inventory_live_hash,'hex'),
      'payrollChecksum', encode(payroll_hash,'hex'),
      'reservationChecksum', encode(reservation_live_hash,'hex'),
      'taxChecksum', encode(tax_hash,'hex'),
      'tradeChecksum', encode(trade_hash,'hex')
    )), 'UTF8'
  ), 'sha256'), 'hex'),
  'projectionChecksum', encode(worldgraph_economy_expansion_projection_checksum(checked_world_id),'hex'),
  'rebuiltJournalChecksum', encode(extensions.digest(convert_to(
    worldgraph_canonical_jsonb(jsonb_build_object(
      'inventoryChecksum', encode(inventory_rebuilt_hash,'hex'),
      'payrollChecksum', encode(payroll_hash,'hex'),
      'reservationChecksum', encode(reservation_rebuilt_hash,'hex'),
      'taxChecksum', encode(tax_hash,'hex'),
      'tradeChecksum', encode(trade_hash,'hex')
    )), 'UTF8'
  ), 'sha256'), 'hex'),
  'rebuiltInventoryChecksum', encode(inventory_rebuilt_hash,'hex'),
  'rebuiltPayrollChecksum', encode(payroll_hash,'hex'),
  'rebuiltReservationChecksum', encode(reservation_rebuilt_hash,'hex'),
  'rebuiltTaxChecksum', encode(tax_hash,'hex'),
  'rebuiltTradeChecksum', encode(trade_hash,'hex'),
  'resourceCount', (SELECT count(*) FROM public.resource_types WHERE world_id = checked_world_id),
  'tradeCount', (SELECT count(*) FROM public.market_trades WHERE world_id = checked_world_id)
) FROM hashes
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_economy_expansion_projection_document(uuid),
  worldgraph_economy_expansion_projection_checksum(uuid),
  worldgraph_economy_inventory_live_document(uuid),
  worldgraph_economy_inventory_rebuilt_document(uuid),
  worldgraph_economy_reservation_live_document(uuid),
  worldgraph_economy_reservation_rebuilt_document(uuid),
  worldgraph_reconcile_economy_expansion(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_assert_compiled_economy_seed_plan()
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

  IF plan_record.source_kind::text IN ('compiler_1_1', 'compiler_1_2') THEN
    IF plan_record.version_compiler_version IS DISTINCT FROM (
          CASE plan_record.source_kind::text
            WHEN 'compiler_1_1' THEN '1.1.0'
            ELSE '1.2.0' END)
      OR plan_record.run_compiler_version IS DISTINCT FROM (
          CASE plan_record.source_kind::text
            WHEN 'compiler_1_1' THEN '1.1.0'
            ELSE '1.2.0' END)
      OR plan_record.version_compiler_config_version IS DISTINCT FROM 1
      OR plan_record.run_compiler_config_version IS DISTINCT FROM 1
      OR plan_record.artifact_schema_version IS DISTINCT FROM plan_record.seed_plan_schema_version + 1
      OR plan_record.canonical_content ->> 'artifactSchemaVersion'
        IS DISTINCT FROM (plan_record.seed_plan_schema_version + 1)::text
      OR plan_record.canonical_content ->> 'compilerVersion'
        IS DISTINCT FROM plan_record.source_compiler_version
      OR plan_record.canonical_content ->> 'compilerConfigVersion' IS DISTINCT FROM '1'
      OR plan_record.canonical_content -> 'economySeedPlan'
        IS DISTINCT FROM plan_record.canonical_plan
      OR plan_record.canonical_content ->> 'economySeedPlanHash'
        IS DISTINCT FROM encode(plan_record.plan_hash, 'hex')
      OR plan_record.adopted_command_id IS NOT NULL
      OR plan_record.adopted_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'native economy seed plan does not exactly match its compiler artifact'
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
CREATE OR REPLACE FUNCTION worldgraph_assert_native_economy_plan_activation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_run_id uuid;
  checked_compiler_version text;
  expected_artifact_schema integer;
  expected_plan_schema integer;
  expected_source text;
BEGIN
  checked_run_id := CASE TG_TABLE_NAME
    WHEN 'world_compilation_runs' THEN NEW.id
    ELSE (to_jsonb(NEW) ->> 'compilation_run_id')::uuid
  END;
  SELECT run.compiler_version INTO checked_compiler_version
  FROM public.world_compilation_runs run WHERE run.id = checked_run_id;
  IF checked_compiler_version NOT IN ('1.1.0','1.2.0') THEN RETURN NULL; END IF;
  expected_artifact_schema := CASE checked_compiler_version WHEN '1.1.0' THEN 2 ELSE 3 END;
  expected_plan_schema := CASE checked_compiler_version WHEN '1.1.0' THEN 1 ELSE 2 END;
  expected_source := CASE checked_compiler_version
    WHEN '1.1.0' THEN 'compiler_1_1'
    ELSE 'compiler_1_2' END;

  IF EXISTS (
    SELECT 1 FROM public.world_compilation_runs run
    WHERE run.id = checked_run_id
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
      AND version.compiler_version = checked_compiler_version
      AND artifact.artifact_schema_version = expected_artifact_schema
      AND plan.seed_plan_schema_version = expected_plan_schema
      AND plan.source_kind::text = expected_source
      AND plan.plan_hash = decode(artifact.canonical_content ->> 'economySeedPlanHash', 'hex')
      AND plan.canonical_plan = artifact.canonical_content -> 'economySeedPlan'
      AND plan.source_artifact_hash = artifact.content_hash
  ) THEN
    RAISE EXCEPTION 'native compiler activation requires its exact economy seed plan'
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'world_versions'
    AND (to_jsonb(NEW) ->> 'status') = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM public.compiled_economy_seed_plans plan
      WHERE plan.world_id = NEW.world_id AND plan.world_version_id = NEW.id
        AND plan.source_kind::text = expected_source
        AND plan.seed_plan_schema_version = expected_plan_schema
        AND plan.plan_hash = (
          SELECT decode(artifact.canonical_content ->> 'economySeedPlanHash', 'hex')
          FROM public.compiled_world_artifacts artifact
          WHERE artifact.compilation_run_id = checked_run_id
            AND artifact.artifact_kind = 'compiled_world'
        )
    ) THEN
    RAISE EXCEPTION 'native compiler world version cannot activate without its exact economy plan'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
DROP TRIGGER domain_events_require_economy_fact ON domain_events;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER domain_events_require_economy_fact
  AFTER INSERT ON domain_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.event_type IS DISTINCT FROM 'WorldEconomyInitializedV1')
  EXECUTE FUNCTION worldgraph_assert_economy_domain_event();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_initialization_event_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_record record;
  head_record record;
  transaction_record record;
  plan_record record;
  materialized_core jsonb;
  planned_core jsonb;
BEGIN
  SELECT command.* INTO command_record
  FROM public.command_records command
  WHERE command.id = NEW.command_id AND command.world_id = NEW.world_id
    AND command.status = 'accepted'::command_record_status
    AND command.resulting_state_revision = NEW.resulting_state_revision;
  SELECT head.* INTO head_record
  FROM public.world_economy_heads head
  WHERE head.world_id = NEW.world_id;
  SELECT transaction.* INTO transaction_record
  FROM public.financial_transactions transaction
  WHERE transaction.world_id = NEW.world_id
    AND transaction.command_id = NEW.command_id
    AND transaction.transaction_kind = 'initialization'::financial_transaction_kind;
  SELECT plan.* INTO plan_record
  FROM public.compiled_economy_seed_plans plan
  WHERE plan.world_id = NEW.world_id
    AND plan.world_version_id = head_record.source_world_version_id
    AND plan.plan_hash = head_record.seed_plan_hash;

  IF plan_record.id IS NOT NULL THEN
    materialized_core := jsonb_set(
      public.worldgraph_materialized_economy_seed_plan(NEW.world_id),
      '{economySeedPlanSchemaVersion}',
      to_jsonb(plan_record.seed_plan_schema_version),
      false
    );
    planned_core := jsonb_build_object(
      'assets', plan_record.canonical_plan -> 'assets',
      'currency', plan_record.canonical_plan -> 'currency',
      'economySeedPlanSchemaVersion',
        plan_record.canonical_plan -> 'economySeedPlanSchemaVersion',
      'initialSupplyMinor', plan_record.canonical_plan -> 'initialSupplyMinor',
      'wallets', plan_record.canonical_plan -> 'wallets'
    );
  END IF;

  IF command_record.command_type IS DISTINCT FROM 'InitializeWorldEconomyV1'
    OR head_record.world_id IS NULL OR transaction_record.id IS NULL
    OR plan_record.id IS NULL
    OR plan_record.seed_plan_schema_version NOT IN (1, 2)
    OR planned_core IS DISTINCT FROM materialized_core
    OR NEW.aggregate_type <> 'world_economy' OR NEW.aggregate_id <> NEW.world_id::text
    OR NEW.event_ordinal <> 0 OR NEW.aggregate_version <> 1
    OR head_record.initialized_command_id IS DISTINCT FROM NEW.command_id
    OR head_record.initialized_event_id IS DISTINCT FROM NEW.id
    OR head_record.updated_state_revision <> NEW.resulting_state_revision
    OR head_record.checksum IS DISTINCT FROM
      public.worldgraph_economy_projection_checksum(NEW.world_id)
    OR NEW.payload <> jsonb_build_object(
      'assetCount', (SELECT count(*)::text FROM public.assets WHERE world_id = NEW.world_id),
      'compiledWorldVersionId', head_record.source_world_version_id::text,
      'currencyId', transaction_record.currency_id::text,
      'initialSupplyMinor', transaction_record.supply_delta_minor::text,
      'initializationTransactionId', transaction_record.id::text,
      'ownershipCount', (SELECT count(*)::text FROM public.asset_ownership WHERE world_id = NEW.world_id),
      'seedPlanSchemaVersion', plan_record.seed_plan_schema_version,
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
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_economy_initialization_event_v2() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER domain_events_require_economy_initialization_fact
  AFTER INSERT ON domain_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.event_type = 'WorldEconomyInitializedV1')
  EXECUTE FUNCTION worldgraph_assert_economy_initialization_event_v2();
--> statement-breakpoint
CREATE TABLE economy_expansion_command_write_snapshots (
  command_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  expansion_state_exists boolean NOT NULL,
  opened_head_row_version bigint,
  opened_head_checksum bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT economy_expansion_command_snapshots_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT economy_expansion_command_snapshots_shape CHECK (
    (expansion_state_exists AND opened_head_row_version > 0
      AND octet_length(opened_head_checksum) = 32)
    OR (NOT expansion_state_exists AND opened_head_row_version IS NULL
      AND opened_head_checksum IS NULL)
  )
);
--> statement-breakpoint
REVOKE ALL ON economy_expansion_command_write_snapshots FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_expansion_runtime_state_exists(checked_world_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN EXISTS (
  SELECT 1 FROM public.world_economy_expansion_heads head
  WHERE head.world_id = checked_world_id
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_economy_expansion_projection_current(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE head_record record;
BEGIN
  SELECT head.* INTO head_record
  FROM public.world_economy_expansion_heads head
  WHERE head.world_id = checked_world_id;
  IF NOT FOUND OR head_record.checksum IS DISTINCT FROM
      public.worldgraph_economy_expansion_projection_checksum(checked_world_id) THEN
    RAISE EXCEPTION 'commerce projection is missing or stale'
      USING ERRCODE = '23514', CONSTRAINT = 'economy_expansion_projection_current';
  END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_economy_expansion_runtime_state_exists(uuid),
  worldgraph_assert_economy_expansion_projection_current(uuid)
  FROM PUBLIC;
--> statement-breakpoint
ALTER FUNCTION worldgraph_open_command_write(uuid, uuid)
  RENAME TO worldgraph_open_command_write_m08;
--> statement-breakpoint
ALTER FUNCTION worldgraph_open_command_write_m08(uuid, uuid) OWNER TO CURRENT_USER;
--> statement-breakpoint
CREATE FUNCTION worldgraph_open_command_write(checked_command_id uuid, checked_world_id uuid)
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
    SELECT head.row_version, head.checksum INTO head_row_version, head_checksum
    FROM public.world_economy_expansion_heads head
    WHERE head.world_id = checked_world_id;
  END IF;
  INSERT INTO public.economy_expansion_command_write_snapshots(
    command_id, world_id, expansion_state_exists,
    opened_head_row_version, opened_head_checksum
  ) VALUES (
    checked_command_id, checked_world_id, has_expansion,
    head_row_version, head_checksum
  ) ON CONFLICT (command_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public.economy_expansion_command_write_snapshots snapshot
    WHERE snapshot.command_id = checked_command_id
      AND snapshot.world_id = checked_world_id
      AND snapshot.expansion_state_exists = has_expansion
      AND snapshot.opened_head_row_version IS NOT DISTINCT FROM head_row_version
      AND snapshot.opened_head_checksum IS NOT DISTINCT FROM head_checksum
  ) THEN
    RAISE EXCEPTION 'commerce command write snapshot is inconsistent'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_open_command_write(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_commerce_command_type(checked_world_id uuid)
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
REVOKE ALL ON FUNCTION worldgraph_commerce_command_type(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_schedule_pair_is_valid_v2(
  checked_command_type text,
  checked_action_type text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
RETURN CASE checked_action_type
  WHEN 'EmitWorldNoticeV1' THEN checked_command_type IN (
    'ScheduleWorldNoticeV1','AdvanceSimulationV1'
  )
  WHEN 'CompleteProductionRunV1' THEN checked_command_type = 'StartProductionRunV1'
  WHEN 'SettlePayrollV1' THEN checked_command_type = 'PerformJobV1'
  WHEN 'ExpireMarketListingV1' THEN checked_command_type = 'CreateMarketListingV1'
  WHEN 'AssessPeriodicTaxV1' THEN checked_command_type IN (
    'InitializeWorldCommerceV1','AssessPeriodicTaxV1'
  )
  ELSE false
END;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_schedule_pair_is_valid_v2(text,text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_allocate_schedule_sequence(checked_world_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  allocated_sequence bigint;
  open_command_type text;
BEGIN
  SELECT command.command_type
  INTO open_command_type
  FROM public.command_records command
  WHERE command.id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    AND command.world_id = checked_world_id;
  IF NOT public.worldgraph_command_write_is_open(checked_world_id)
    OR open_command_type NOT IN (
      'ScheduleWorldNoticeV1','AdvanceSimulationV1','InitializeWorldCommerceV1',
      'StartProductionRunV1','PerformJobV1','CreateMarketListingV1',
      'AssessPeriodicTaxV1'
    ) THEN
    RAISE EXCEPTION 'schedule allocation requires its exact open simulation or commerce command'
      USING ERRCODE = '55000';
  END IF;
  SELECT next_schedule_sequence INTO allocated_sequence
  FROM public.world_schedule_heads
  WHERE world_id = checked_world_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'world schedule head is missing' USING ERRCODE = '55000';
  END IF;
  UPDATE public.world_schedule_heads
  SET next_schedule_sequence = next_schedule_sequence + 1,
      updated_at = clock_timestamp()
  WHERE world_id = checked_world_id;
  PERFORM set_config('worldgraph.schedule_world_id', checked_world_id::text, true);
  PERFORM set_config('worldgraph.schedule_sequence', allocated_sequence::text, true);
  RETURN allocated_sequence;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_schedule_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE open_command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world schedule heads cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT command.command_type INTO open_command_type
    FROM public.command_records command
    WHERE command.id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
      AND command.world_id = NEW.world_id;
    IF NOT public.worldgraph_command_write_is_open(NEW.world_id)
      OR open_command_type NOT IN (
        'ScheduleWorldNoticeV1','AdvanceSimulationV1','InitializeWorldCommerceV1',
        'StartProductionRunV1','PerformJobV1','CreateMarketListingV1',
        'AssessPeriodicTaxV1'
      )
      OR NEW.world_id IS DISTINCT FROM OLD.world_id
      OR NEW.next_schedule_sequence <> OLD.next_schedule_sequence + 1
      OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'world schedule head allocation is invalid or outside its command'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_scheduled_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_id uuid;
  open_command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'scheduled actions cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    SELECT command.command_type INTO open_command_type
    FROM public.command_records command
    WHERE command.id = NEW.created_command_id AND command.world_id = NEW.world_id;
    IF NOT public.worldgraph_schedule_pair_is_valid_v2(open_command_type, NEW.action_type)
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.created_command_id)
      OR NEW.status <> 'scheduled'::scheduled_action_status
      OR NULLIF(current_setting('worldgraph.schedule_world_id', true), '')
        IS DISTINCT FROM NEW.world_id::text
      OR NULLIF(current_setting('worldgraph.schedule_sequence', true), '')
        IS DISTINCT FROM NEW.schedule_sequence::text
      OR NOT EXISTS (
        SELECT 1 FROM public.world_simulation_clocks clock
        WHERE clock.world_id = NEW.world_id AND NEW.due_tick > clock.current_tick
      ) THEN
      RAISE EXCEPTION 'scheduled action creation requires an allocated future position'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1
    FROM public.world_schedule_heads head
    WHERE head.world_id = NEW.world_id
    FOR UPDATE;
    IF NOT FOUND
      OR (SELECT count(*) FROM public.scheduled_actions action
          WHERE action.world_id = NEW.world_id
            AND action.status = 'scheduled'::scheduled_action_status) >= 10000
      OR (NEW.created_by_actor_type = 'user'::command_actor_type AND
          (SELECT count(*) FROM public.scheduled_actions action
           WHERE action.world_id = NEW.world_id
             AND action.status = 'scheduled'::scheduled_action_status
             AND action.created_by_actor_type = 'user'::command_actor_type
             AND action.created_by_actor_id = NEW.created_by_actor_id) >= 1000)
      OR (SELECT count(*) FROM public.scheduled_actions action
          WHERE action.world_id = NEW.world_id
            AND action.due_tick = NEW.due_tick
            AND action.status = 'scheduled'::scheduled_action_status) >= 31 THEN
      RAISE EXCEPTION 'scheduled action capacity is exhausted'
        USING ERRCODE = '54000', CONSTRAINT = 'scheduled_action_capacity_bounded';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'scheduled'::scheduled_action_status
    OR NEW.status NOT IN (
      'completed'::scheduled_action_status,
      'cancelled'::scheduled_action_status,
      'failed'::scheduled_action_status
    )
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.schedule_sequence IS DISTINCT FROM OLD.schedule_sequence
    OR NEW.due_tick IS DISTINCT FROM OLD.due_tick
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.action_type IS DISTINCT FROM OLD.action_type
    OR NEW.action_schema_version IS DISTINCT FROM OLD.action_schema_version
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.process_version IS DISTINCT FROM OLD.process_version
    OR NEW.created_by_actor_type IS DISTINCT FROM OLD.created_by_actor_type
    OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
    OR NEW.created_command_id IS DISTINCT FROM OLD.created_command_id
    OR NEW.created_state_revision IS DISTINCT FROM OLD.created_state_revision
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at < OLD.updated_at
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id) THEN
    RAISE EXCEPTION 'scheduled action transition is immutable, invalid, or outside a command'
      USING ERRCODE = '55000';
  END IF;

  checked_command_id := NULLIF(current_setting('worldgraph.command_id', true), '')::uuid;
  SELECT command.command_type INTO open_command_type
  FROM public.command_records command
  WHERE command.id = checked_command_id AND command.world_id = NEW.world_id;
  IF NEW.status = 'completed'::scheduled_action_status AND (
    open_command_type IS DISTINCT FROM 'AdvanceSimulationV1'
    OR NOT EXISTS (
      SELECT 1 FROM public.domain_events event
      WHERE event.id = NEW.completed_event_id AND event.world_id = NEW.world_id
        AND event.command_id = checked_command_id
        AND event.aggregate_type = 'scheduled_action'
        AND event.aggregate_id = NEW.id::text
        AND event.event_type = 'ScheduledActionExecutedV1'
    )
  ) THEN
    RAISE EXCEPTION 'completed schedule requires its open advance event'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'cancelled'::scheduled_action_status AND (
    open_command_type NOT IN (
      'CancelScheduledActionV1','ResolveSimulationFailureV1','CancelMarketListingV1'
    )
    OR NEW.cancelled_command_id IS DISTINCT FROM checked_command_id
    OR (open_command_type IN ('CancelScheduledActionV1','ResolveSimulationFailureV1')
      AND NEW.action_type <> 'EmitWorldNoticeV1')
    OR (open_command_type = 'CancelMarketListingV1' AND (
      NEW.action_type <> 'ExpireMarketListingV1'
      OR NOT EXISTS (
        SELECT 1 FROM public.market_listings listing
        WHERE listing.world_id = NEW.world_id
          AND listing.scheduled_action_id = NEW.id
          AND listing.id::text = NEW.payload ->> 'listingId'
          AND listing.terminal_command_id = checked_command_id
          AND listing.status = 'cancelled'::market_listing_status
      )
    ))
  ) THEN
    RAISE EXCEPTION 'cancelled schedule requires its exact open command'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'failed'::scheduled_action_status THEN
    RAISE EXCEPTION 'failed schedule transitions require a future versioned command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_assert_scheduled_action_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.command_records command
      JOIN public.domain_events event
        ON event.command_id = command.id AND event.world_id = command.world_id
      WHERE command.id = NEW.created_command_id AND command.world_id = NEW.world_id
        AND public.worldgraph_schedule_pair_is_valid_v2(
          command.command_type, NEW.action_type
        )
        AND command.status = 'accepted'::command_record_status
        AND command.resulting_state_revision = NEW.created_state_revision
        AND command.write_gate_opened_at >= transaction_timestamp()
        AND command.actor_type = NEW.created_by_actor_type
        AND command.actor_id = NEW.created_by_actor_id
        AND (NEW.action_type <> 'AssessPeriodicTaxV1' OR (
          command.command_type = 'InitializeWorldCommerceV1' AND EXISTS (
            SELECT 1 FROM public.tax_policies policy
            JOIN public.world_simulation_clocks clock
              ON clock.world_id = policy.world_id
            WHERE policy.world_id = NEW.world_id
              AND policy.id::text = NEW.payload ->> 'taxPolicyId'
              AND policy.created_command_id = command.id
              AND policy.created_state_revision = NEW.created_state_revision
              AND policy.tax_type = 'periodic_flat'::tax_policy_type
              AND policy.status = 'active'::tax_policy_status
              AND (policy.effective_until_tick IS NULL
                OR NEW.due_tick < policy.effective_until_tick)
              AND NEW.due_tick = greatest(
                policy.effective_from_tick::numeric,
                clock.current_tick::numeric
                  + (policy.applicability ->> 'intervalTicks')::numeric
              )::bigint
          )
          OR command.command_type = 'AssessPeriodicTaxV1' AND EXISTS (
            SELECT 1
            FROM public.tax_assessments assessment
            JOIN public.tax_policies policy
              ON policy.world_id = assessment.world_id
             AND policy.id = assessment.policy_id
            WHERE assessment.world_id = NEW.world_id
              AND assessment.command_id = command.id
              AND policy.id::text = NEW.payload ->> 'taxPolicyId'
              AND policy.tax_type = 'periodic_flat'::tax_policy_type
              AND policy.status = 'active'::tax_policy_status
              AND NEW.due_tick = assessment.occurred_tick
                + (policy.applicability ->> 'intervalTicks')::bigint
          )
        ))
        AND NEW.created_at = event.recorded_at
        AND NEW.updated_at = event.recorded_at
        AND event.aggregate_type = 'scheduled_action'
        AND event.aggregate_id = NEW.id::text
        AND event.event_type = 'ScheduledActionCreatedV1'
        AND event.resulting_state_revision = NEW.created_state_revision
        AND event.payload = jsonb_build_object(
          'actionSchemaVersion', NEW.action_schema_version,
          'actionType', NEW.action_type,
          'dueTick', NEW.due_tick::text,
          'payload', NEW.payload,
          'payloadHash', encode(NEW.payload_hash, 'hex'),
          'priority', NEW.priority,
          'processVersion', NEW.process_version,
          'scheduleId', NEW.id::text,
          'scheduleSequence', NEW.schedule_sequence::text
        )
        AND (command.command_type <> 'ScheduleWorldNoticeV1'
          OR command.payload_hash = extensions.digest(convert_to(
            public.worldgraph_canonical_jsonb(jsonb_build_object(
              'dueTick', NEW.due_tick::text,
              'priority', NEW.priority,
              'text', NEW.payload ->> 'text',
              'visibility', NEW.payload ->> 'visibility'
            )), 'UTF8'
          ), 'sha256'))
    ) THEN
      RAISE EXCEPTION 'scheduled action creation requires its accepted command'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.status = 'completed'::scheduled_action_status AND NOT EXISTS (
    SELECT 1 FROM public.domain_events event
    JOIN public.command_records command ON command.id = event.command_id
    WHERE event.id = NEW.completed_event_id AND event.world_id = NEW.world_id
      AND event.aggregate_type = 'scheduled_action'
      AND event.aggregate_id = NEW.id::text
      AND event.event_type = 'ScheduledActionExecutedV1'
      AND NEW.updated_at = event.recorded_at
      AND event.payload = jsonb_build_object(
        'actionType', NEW.action_type,
        'dueTick', NEW.due_tick::text,
        'outcomeHash', (
          SELECT encode(clock.outcome_hash, 'hex')
          FROM public.world_simulation_clocks clock
          WHERE clock.world_id = NEW.world_id
        ),
        'processVersion', NEW.process_version,
        'scheduleId', NEW.id::text,
        'scheduleSequence', NEW.schedule_sequence::text
      )
      AND command.command_type = 'AdvanceSimulationV1'
      AND command.status = 'accepted'::command_record_status
      AND command.resulting_state_revision = NEW.completed_state_revision
      AND command.write_gate_opened_at >= transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'scheduled action completion requires its accepted event command'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'cancelled'::scheduled_action_status AND NOT EXISTS (
    SELECT 1 FROM public.command_records command
    JOIN public.domain_events event
      ON event.command_id = command.id AND event.world_id = command.world_id
    WHERE command.id = NEW.cancelled_command_id AND command.world_id = NEW.world_id
      AND command.command_type IN (
        'CancelScheduledActionV1','ResolveSimulationFailureV1','CancelMarketListingV1'
      )
      AND command.status = 'accepted'::command_record_status
      AND command.resulting_state_revision = NEW.completed_state_revision
      AND command.write_gate_opened_at >= transaction_timestamp()
      AND event.aggregate_type = 'scheduled_action'
      AND event.aggregate_id = NEW.id::text
      AND event.event_type = 'ScheduledActionCancelledV1'
      AND NEW.updated_at = event.recorded_at
      AND event.payload = jsonb_build_object(
        'actionType', NEW.action_type,
        'dueTick', NEW.due_tick::text,
        'scheduleId', NEW.id::text,
        'scheduleSequence', NEW.schedule_sequence::text
      )
      AND (
        (command.command_type = 'CancelScheduledActionV1'
          AND NEW.action_type = 'EmitWorldNoticeV1'
          AND command.payload_hash = extensions.digest(convert_to(
            public.worldgraph_canonical_jsonb(jsonb_build_object(
              'scheduleId', NEW.id::text
            )), 'UTF8'
          ), 'sha256'))
        OR (command.command_type = 'ResolveSimulationFailureV1'
          AND NEW.action_type = 'EmitWorldNoticeV1'
          AND EXISTS (
            SELECT 1
            FROM public.simulation_failures failure
            JOIN public.domain_events resolution_event
              ON resolution_event.command_id = command.id
             AND resolution_event.world_id = command.world_id
             AND resolution_event.event_type = 'SimulationFailureResolvedV1'
             AND resolution_event.aggregate_id = failure.id::text
            WHERE failure.world_id = NEW.world_id
              AND failure.schedule_id = NEW.id
              AND failure.resolution_command_id = command.id
              AND resolution_event.payload ->> 'resolution' = 'cancel_action'
              AND command.payload_hash = extensions.digest(convert_to(
                public.worldgraph_canonical_jsonb(jsonb_build_object(
                  'failureId', failure.id::text,
                  'resolution', 'cancel_action'
                )), 'UTF8'
              ), 'sha256')
          ))
        OR (command.command_type = 'CancelMarketListingV1'
          AND NEW.action_type = 'ExpireMarketListingV1'
          AND EXISTS (
            SELECT 1 FROM public.market_listings listing
            WHERE listing.world_id = NEW.world_id
              AND listing.scheduled_action_id = NEW.id
              AND listing.id::text = NEW.payload ->> 'listingId'
              AND listing.terminal_command_id = command.id
              AND listing.terminal_event_id IS NOT NULL
              AND listing.status = 'cancelled'::market_listing_status
          ))
      )
  ) THEN
    RAISE EXCEPTION 'scheduled action cancellation requires its accepted command'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'failed'::scheduled_action_status THEN
    RAISE EXCEPTION 'failed schedule transitions require a future versioned command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_assert_simulation_batch_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE batch_record record;
BEGIN
  SELECT * INTO batch_record
  FROM public.simulation_batch_runs batch
  WHERE batch.id = NEW.id AND batch.world_id = NEW.world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simulation batch cannot commit without an audited terminal command'
      USING ERRCODE = '55000';
  END IF;
  IF batch_record.batch_key IS DISTINCT FROM extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'fromTick', batch_record.from_tick::text,
      'inputChecksum', encode(batch_record.input_checksum, 'hex'),
      'processRegistryVersion', batch_record.process_registry_version,
      'toTick', batch_record.to_tick::text,
      'worldId', batch_record.world_id::text
    )), 'UTF8'
  ), 'sha256') THEN
    RAISE EXCEPTION 'simulation batch key does not match its canonical input identity'
      USING ERRCODE = '55000';
  ELSIF batch_record.status = 'running'::simulation_batch_status THEN
    RAISE EXCEPTION 'simulation batch cannot commit without an audited terminal command'
      USING ERRCODE = '55000';
  ELSIF batch_record.status = 'completed'::simulation_batch_status AND NOT EXISTS (
    SELECT 1
    FROM public.command_records command
    JOIN public.domain_events event
      ON event.command_id = command.id AND event.world_id = command.world_id
    JOIN public.world_simulation_clocks clock ON clock.world_id = command.world_id
    WHERE command.id = batch_record.command_id
      AND command.world_id = batch_record.world_id
      AND command.command_type = 'AdvanceSimulationV1'
      AND command.status = 'accepted'::command_record_status
      AND command.write_gate_opened_at >= transaction_timestamp()
      AND command.command_schema_version = 1
      AND (command.payload IS NULL OR command.payload = jsonb_build_object(
        'ticks', (batch_record.to_tick - batch_record.from_tick)::integer
      ))
      AND command.payload_hash = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(jsonb_build_object(
          'ticks', (batch_record.to_tick - batch_record.from_tick)::integer
        )), 'UTF8'
      ), 'sha256')
      AND event.aggregate_type = 'simulation_clock'
      AND event.aggregate_id = batch_record.world_id::text
      AND event.event_type = 'SimulationAdvancedV1'
      AND event.event_ordinal = 0
      AND event.payload = jsonb_build_object(
        'executedScheduleCount', (
          SELECT count(*) FROM public.domain_events executed
          WHERE executed.command_id = command.id
            AND executed.event_type = 'ScheduledActionExecutedV1'
        ),
        'fromTick', batch_record.from_tick::text,
        'outcomeHash', encode(batch_record.outcome_hash, 'hex'),
        'processRegistryVersion', batch_record.process_registry_version,
        'tickCount', (batch_record.to_tick - batch_record.from_tick)::integer,
        'toTick', batch_record.to_tick::text
      )
      AND batch_record.batch_schema_version = 1
      AND batch_record.process_registry_version IN (1, 2)
      AND batch_record.to_tick = clock.current_tick
      AND batch_record.outcome_hash = clock.outcome_hash
      AND batch_record.completed_at = event.recorded_at
      AND batch_record.attempts = 1 + (
        SELECT COALESCE(sum(failure.attempts), 0)
        FROM public.simulation_failures failure
        WHERE failure.world_id = batch_record.world_id
          AND failure.batch_run_id = batch_record.id
      )
  ) THEN
    RAISE EXCEPTION 'completed simulation batch requires its accepted advance fact'
      USING ERRCODE = '55000';
  ELSIF batch_record.status = 'failed'::simulation_batch_status AND NOT EXISTS (
    SELECT 1
    FROM public.simulation_failures failure
    JOIN public.domain_events event
      ON event.world_id = failure.world_id
     AND event.aggregate_type = 'simulation_failure'
     AND event.aggregate_id = failure.id::text
     AND event.event_type = 'SimulationFailureRecordedV1'
    JOIN public.command_records command
      ON command.id = event.command_id AND command.world_id = event.world_id
    WHERE failure.world_id = batch_record.world_id
      AND failure.batch_run_id = batch_record.id
      AND failure.error_code = batch_record.error_code
      AND command.command_type = 'AutoPauseWorldClockV1'
      AND command.status = 'accepted'::command_record_status
      AND command.write_gate_opened_at >= transaction_timestamp()
      AND command.command_schema_version = 1
      AND (command.payload IS NULL OR command.payload = jsonb_build_object(
        'errorCode', failure.error_code,
        'failureId', failure.id::text
      ))
      AND command.payload_hash = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(jsonb_build_object(
          'errorCode', failure.error_code,
          'failureId', failure.id::text
        )), 'UTF8'
      ), 'sha256')
      AND event.payload = jsonb_build_object(
        'attempts', failure.attempts,
        'batchRunId', failure.batch_run_id::text,
        'errorCode', failure.error_code,
        'failureId', failure.id::text,
        'processType', failure.process_type,
        'processVersion', failure.process_version,
        'scheduleId', failure.schedule_id::text,
        'tick', failure.tick::text
      )
      AND batch_record.batch_schema_version = 1
      AND batch_record.process_registry_version IN (1, 2)
      AND batch_record.completed_at = event.recorded_at
      AND batch_record.attempts = (
        SELECT sum(linked.attempts)
        FROM public.simulation_failures linked
        WHERE linked.world_id = batch_record.world_id
          AND linked.batch_run_id = batch_record.id
      )
  ) THEN
    RAISE EXCEPTION 'failed simulation batch requires its accepted auto-pause fact'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_assert_simulation_clock_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  authority record;
  new_configuration jsonb;
  old_configuration jsonb;
BEGIN
  SELECT command.id command_id, command.command_type,
    command.payload AS command_payload, command.payload_hash,
    event.event_type, event.aggregate_type, event.aggregate_id,
    event.payload AS event_payload,
    event.recorded_at
  INTO authority
  FROM public.command_records command
  JOIN public.domain_events event
    ON event.command_id = command.id AND event.world_id = command.world_id
  WHERE command.world_id = NEW.world_id
    AND command.status = 'accepted'::command_record_status
    AND command.command_schema_version = 1
    AND command.resulting_state_revision = NEW.updated_state_revision
    AND command.write_gate_opened_at >= transaction_timestamp()
    AND event.event_ordinal = 0
    AND event.resulting_state_revision = NEW.updated_state_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simulation clock write requires its accepted command revision'
      USING ERRCODE = '55000';
  END IF;

  new_configuration := jsonb_build_object(
    'epochAt', public.worldgraph_timestamp_text(NEW.epoch_at),
    'maxBatchTicks', NEW.max_batch_ticks,
    'maxCatchUpTicks', NEW.max_catch_up_ticks,
    'prngAlgorithmVersion', NEW.prng_algorithm_version,
    'wallCadenceMilliseconds', NEW.wall_cadence_milliseconds,
    'worldMillisecondsPerTick', NEW.world_milliseconds_per_tick
  );
  IF TG_OP = 'INSERT' THEN
    IF authority.command_type <> 'InitializeWorldSimulationV1'
      OR authority.event_type <> 'WorldSimulationInitializedV1'
      OR authority.aggregate_type <> 'simulation_clock'
      OR authority.aggregate_id <> NEW.world_id::text
      OR authority.event_payload IS DISTINCT FROM jsonb_build_object(
        'configuration', new_configuration,
        'currentTick', NEW.current_tick::text,
        'mode', NEW.mode::text,
        'processRegistryVersion', COALESCE((
          SELECT batch.process_registry_version
          FROM public.simulation_batch_runs batch
          WHERE batch.world_id = NEW.world_id
            AND batch.command_id = authority.command_id
        ), 1),
        'provenance', public.worldgraph_resolve_simulation_clock_config(NEW.world_id) ->> 'provenance'
      )
      OR authority.payload_hash IS DISTINCT FROM extensions.digest(
        convert_to(public.worldgraph_canonical_jsonb(authority.event_payload), 'UTF8'), 'sha256'
      )
      OR authority.command_payload IS DISTINCT FROM authority.event_payload
      OR NEW.mode <> 'paused'::simulation_clock_mode
      OR NEW.epoch_at IS DISTINCT FROM date_trunc('milliseconds', NEW.epoch_at)
      OR NEW.outcome_hash IS DISTINCT FROM (
        SELECT public.worldgraph_initial_simulation_outcome_hash_v1(version.seed)
        FROM public.world_runtime_heads runtime
        JOIN public.world_versions version
          ON version.id = runtime.active_world_version_id
         AND version.world_id = runtime.world_id
        WHERE runtime.world_id = NEW.world_id
      )
      OR NEW.updated_at IS DISTINCT FROM authority.recorded_at THEN
      RAISE EXCEPTION 'simulation clock initialization fact does not match its row'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  old_configuration := jsonb_build_object(
    'epochAt', public.worldgraph_timestamp_text(OLD.epoch_at),
    'maxBatchTicks', OLD.max_batch_ticks,
    'maxCatchUpTicks', OLD.max_catch_up_ticks,
    'prngAlgorithmVersion', OLD.prng_algorithm_version,
    'wallCadenceMilliseconds', OLD.wall_cadence_milliseconds,
    'worldMillisecondsPerTick', OLD.world_milliseconds_per_tick
  );
  IF authority.command_type = 'ConfigureWorldClockV1' THEN
    IF authority.event_type <> 'WorldClockConfiguredV1'
      OR authority.aggregate_type <> 'simulation_clock'
      OR authority.aggregate_id <> NEW.world_id::text
      OR authority.event_payload IS DISTINCT FROM jsonb_build_object(
        'configuration', new_configuration,
        'previousConfiguration', old_configuration,
        'tick', NEW.current_tick::text
      )
      OR authority.payload_hash IS DISTINCT FROM extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(jsonb_build_object(
          'epoch', public.worldgraph_timestamp_text(NEW.epoch_at),
          'maxBatch', NEW.max_batch_ticks,
          'maxCatchUp', NEW.max_catch_up_ticks,
          'wallCadenceMs', NEW.wall_cadence_milliseconds,
          'worldMillisecondsPerTick', NEW.world_milliseconds_per_tick
        )), 'UTF8'
      ), 'sha256')
      OR (authority.command_payload IS NOT NULL
        AND authority.command_payload IS DISTINCT FROM jsonb_build_object(
        'epoch', public.worldgraph_timestamp_text(NEW.epoch_at),
        'maxBatch', NEW.max_batch_ticks,
        'maxCatchUp', NEW.max_catch_up_ticks,
        'wallCadenceMs', NEW.wall_cadence_milliseconds,
        'worldMillisecondsPerTick', NEW.world_milliseconds_per_tick
      ))
      OR NEW.current_tick <> 0
      OR NEW.epoch_at IS DISTINCT FROM date_trunc('milliseconds', NEW.epoch_at)
      OR OLD.mode <> 'paused'::simulation_clock_mode
      OR NEW.mode <> 'paused'::simulation_clock_mode
      OR NEW.updated_at IS DISTINCT FROM authority.recorded_at THEN
      RAISE EXCEPTION 'configured clock fact does not match its transition'
        USING ERRCODE = '55000';
    END IF;
  ELSIF authority.command_type = 'StartWorldClockV1' THEN
    IF authority.event_type <> 'WorldClockStartedV1'
      OR authority.aggregate_type <> 'simulation_clock'
      OR authority.aggregate_id <> NEW.world_id::text
      OR authority.event_payload IS DISTINCT FROM jsonb_build_object('tick', NEW.current_tick::text)
      OR authority.payload_hash IS DISTINCT FROM extensions.digest(
        convert_to(public.worldgraph_canonical_jsonb('{}'::jsonb), 'UTF8'), 'sha256'
      )
      OR (authority.command_payload IS NOT NULL AND authority.command_payload <> '{}'::jsonb)
      OR OLD.mode <> 'paused'::simulation_clock_mode
      OR NEW.mode <> 'running'::simulation_clock_mode
      OR NEW.last_wall_anchor_at IS DISTINCT FROM authority.recorded_at
      OR NEW.updated_at IS DISTINCT FROM authority.recorded_at THEN
      RAISE EXCEPTION 'started clock fact does not match its transition'
        USING ERRCODE = '55000';
    END IF;
  ELSIF authority.command_type = 'PauseWorldClockV1' THEN
    IF authority.event_type <> 'WorldClockPausedV1'
      OR authority.aggregate_type <> 'simulation_clock'
      OR authority.aggregate_id <> NEW.world_id::text
      OR authority.event_payload IS DISTINCT FROM jsonb_build_object(
        'reason', 'creator', 'tick', NEW.current_tick::text
      )
      OR authority.payload_hash IS DISTINCT FROM extensions.digest(
        convert_to(public.worldgraph_canonical_jsonb('{}'::jsonb), 'UTF8'), 'sha256'
      )
      OR (authority.command_payload IS NOT NULL AND authority.command_payload <> '{}'::jsonb)
      OR OLD.mode <> 'running'::simulation_clock_mode
      OR NEW.mode <> 'paused'::simulation_clock_mode
      OR NEW.last_wall_anchor_at IS NOT NULL
      OR NEW.updated_at IS DISTINCT FROM authority.recorded_at THEN
      RAISE EXCEPTION 'paused clock fact does not match its transition'
        USING ERRCODE = '55000';
    END IF;
  ELSIF authority.command_type = 'AdvanceSimulationV1' THEN
    IF authority.event_type <> 'SimulationAdvancedV1'
      OR authority.aggregate_type <> 'simulation_clock'
      OR authority.aggregate_id <> NEW.world_id::text
      OR authority.event_payload IS DISTINCT FROM jsonb_build_object(
        'executedScheduleCount', (
          SELECT count(*) FROM public.domain_events executed
          WHERE executed.command_id = authority.command_id
            AND executed.event_type = 'ScheduledActionExecutedV1'
        ),
        'fromTick', OLD.current_tick::text,
        'outcomeHash', encode(NEW.outcome_hash, 'hex'),
        'processRegistryVersion', COALESCE((
          SELECT batch.process_registry_version
          FROM public.simulation_batch_runs batch
          WHERE batch.world_id = NEW.world_id
            AND batch.command_id = authority.command_id
        ), 1),
        'tickCount', (NEW.current_tick - OLD.current_tick)::integer,
        'toTick', NEW.current_tick::text
      )
      OR NEW.current_tick - OLD.current_tick NOT BETWEEN 1 AND OLD.max_batch_ticks
      OR authority.payload_hash IS DISTINCT FROM extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(jsonb_build_object(
          'ticks', (NEW.current_tick - OLD.current_tick)::integer
        )), 'UTF8'
      ), 'sha256')
      OR (authority.command_payload IS NOT NULL
        AND authority.command_payload IS DISTINCT FROM jsonb_build_object(
        'ticks', (NEW.current_tick - OLD.current_tick)::integer
      ))
      OR OLD.mode IS DISTINCT FROM NEW.mode
      OR NEW.mode NOT IN ('paused'::simulation_clock_mode, 'running'::simulation_clock_mode)
      OR (NEW.mode = 'paused'::simulation_clock_mode AND (
        OLD.last_wall_anchor_at IS NOT NULL OR NEW.last_wall_anchor_at IS NOT NULL
      ))
      OR (NEW.mode = 'running'::simulation_clock_mode AND (
        OLD.last_wall_anchor_at IS NULL
        OR NEW.last_wall_anchor_at IS DISTINCT FROM OLD.last_wall_anchor_at
          + (NEW.current_tick - OLD.current_tick)
            * OLD.wall_cadence_milliseconds * interval '1 millisecond'
      ))
      OR NEW.updated_at IS DISTINCT FROM authority.recorded_at
      OR NOT EXISTS (
        SELECT 1 FROM public.simulation_batch_runs batch
        WHERE batch.world_id = NEW.world_id
          AND batch.command_id = authority.command_id
          AND batch.status = 'completed'::simulation_batch_status
          AND batch.from_tick = OLD.current_tick
          AND batch.to_tick = NEW.current_tick
          AND batch.outcome_hash = NEW.outcome_hash
      ) THEN
      RAISE EXCEPTION 'advanced clock fact does not match its transition'
        USING ERRCODE = '55000';
    END IF;
  ELSIF authority.command_type = 'AutoPauseWorldClockV1' THEN
    IF authority.event_type <> 'WorldClockAutoPausedV1'
      OR authority.aggregate_type <> 'simulation_clock'
      OR authority.aggregate_id <> NEW.world_id::text
      OR OLD.mode <> 'running'::simulation_clock_mode
      OR NEW.mode <> 'error'::simulation_clock_mode
      OR NEW.last_wall_anchor_at IS NOT NULL
      OR NEW.updated_at IS DISTINCT FROM authority.recorded_at
      OR NOT EXISTS (
        SELECT 1
        FROM public.simulation_failures failure
        JOIN public.domain_events failure_event
          ON failure_event.command_id = authority.command_id
         AND failure_event.world_id = failure.world_id
         AND failure_event.aggregate_type = 'simulation_failure'
         AND failure_event.aggregate_id = failure.id::text
         AND failure_event.event_type = 'SimulationFailureRecordedV1'
        WHERE failure.world_id = NEW.world_id
          AND failure.id::text = authority.event_payload ->> 'failureId'
          AND failure.error_code = authority.event_payload ->> 'errorCode'
          AND failure_event.payload ->> 'failureId' = failure.id::text
          AND authority.event_payload = jsonb_build_object(
            'errorCode', failure.error_code,
            'failureId', failure.id::text,
            'tick', NEW.current_tick::text
          )
          AND authority.payload_hash = extensions.digest(convert_to(
            public.worldgraph_canonical_jsonb(jsonb_build_object(
              'errorCode', failure.error_code,
              'failureId', failure.id::text
            )), 'UTF8'
          ), 'sha256')
          AND (authority.command_payload IS NULL
            OR authority.command_payload = jsonb_build_object(
            'errorCode', failure.error_code,
            'failureId', failure.id::text
          ))
      ) THEN
      RAISE EXCEPTION 'auto-paused clock fact does not match its failure'
        USING ERRCODE = '55000';
    END IF;
  ELSIF authority.command_type = 'ResolveSimulationFailureV1' THEN
    IF authority.event_type <> 'SimulationFailureResolvedV1'
      OR authority.aggregate_type <> 'simulation_failure'
      OR authority.event_payload ->> 'failureId' <> authority.aggregate_id
      OR OLD.mode <> 'error'::simulation_clock_mode
      OR NEW.mode <> 'paused'::simulation_clock_mode
      OR NEW.last_wall_anchor_at IS NOT NULL
      OR NEW.updated_at IS DISTINCT FROM authority.recorded_at
      OR NOT EXISTS (
        SELECT 1 FROM public.simulation_failures failure
        WHERE failure.world_id = NEW.world_id
          AND failure.id::text = authority.aggregate_id
          AND failure.resolution_command_id = authority.command_id
          AND failure.status = 'resolved'::simulation_failure_status
          AND authority.event_payload ->> 'tick' = failure.tick::text
          AND authority.event_payload = jsonb_build_object(
            'failureId', failure.id::text,
            'resolution', authority.event_payload ->> 'resolution',
            'scheduleId', failure.schedule_id::text,
            'tick', failure.tick::text
          )
          AND authority.payload_hash = extensions.digest(convert_to(
            public.worldgraph_canonical_jsonb(jsonb_build_object(
              'failureId', failure.id::text,
              'resolution', authority.event_payload ->> 'resolution'
            )), 'UTF8'
          ), 'sha256')
          AND (authority.command_payload IS NULL
            OR authority.command_payload = jsonb_build_object(
            'failureId', failure.id::text,
            'resolution', authority.event_payload ->> 'resolution'
          ))
      ) THEN
      RAISE EXCEPTION 'resolved clock fact does not match its failure transition'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'simulation clock write used an unsupported command type'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_simulation_domain_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_type text;
  matrix_matches boolean;
BEGIN
  SELECT command.command_type INTO checked_command_type
  FROM public.command_records command
  WHERE command.id = NEW.command_id AND command.world_id = NEW.world_id;

  IF checked_command_type IN (
      'InitializeWorldSimulationV1', 'ConfigureWorldClockV1',
      'StartWorldClockV1', 'PauseWorldClockV1', 'AdvanceSimulationV1',
      'ScheduleWorldNoticeV1', 'CancelScheduledActionV1',
      'AutoPauseWorldClockV1', 'ResolveSimulationFailureV1'
    ) OR NEW.aggregate_type IN (
      'simulation_clock', 'scheduled_action', 'simulation_failure', 'world_notice'
    ) OR NEW.event_type IN (
      'WorldSimulationInitializedV1', 'WorldClockConfiguredV1',
      'WorldClockStartedV1', 'WorldClockPausedV1', 'SimulationAdvancedV1',
      'ScheduledActionCreatedV1', 'ScheduledActionCancelledV1',
      'ScheduledActionExecutedV1', 'WorldNoticeEmittedV1',
      'WorldClockAutoPausedV1', 'SimulationFailureRecordedV1',
      'SimulationFailureResolvedV1'
    ) THEN
    matrix_matches :=
      (checked_command_type = 'InitializeWorldSimulationV1'
        AND NEW.event_type = 'WorldSimulationInitializedV1'
        AND NEW.aggregate_type = 'simulation_clock'
        AND NEW.aggregate_id = NEW.world_id::text)
      OR (checked_command_type = 'ConfigureWorldClockV1'
        AND NEW.event_type = 'WorldClockConfiguredV1'
        AND NEW.aggregate_type = 'simulation_clock'
        AND NEW.aggregate_id = NEW.world_id::text)
      OR (checked_command_type = 'StartWorldClockV1'
        AND NEW.event_type = 'WorldClockStartedV1'
        AND NEW.aggregate_type = 'simulation_clock'
        AND NEW.aggregate_id = NEW.world_id::text)
      OR (checked_command_type = 'PauseWorldClockV1'
        AND NEW.event_type = 'WorldClockPausedV1'
        AND NEW.aggregate_type = 'simulation_clock'
        AND NEW.aggregate_id = NEW.world_id::text)
      OR (checked_command_type = 'AdvanceSimulationV1' AND (
        (NEW.event_type = 'SimulationAdvancedV1'
          AND NEW.aggregate_type = 'simulation_clock'
          AND NEW.aggregate_id = NEW.world_id::text)
        OR (NEW.event_type IN ('ScheduledActionCreatedV1', 'ScheduledActionExecutedV1')
          AND NEW.aggregate_type = 'scheduled_action'
          AND NEW.aggregate_id = NEW.payload ->> 'scheduleId')
        OR (NEW.event_type = 'WorldNoticeEmittedV1'
          AND NEW.aggregate_type = 'world_notice'
          AND NEW.aggregate_id = NEW.payload ->> 'scheduleId')
      ))
      OR (checked_command_type = 'ScheduleWorldNoticeV1'
        AND NEW.event_type = 'ScheduledActionCreatedV1'
        AND NEW.aggregate_type = 'scheduled_action'
        AND NEW.aggregate_id = NEW.payload ->> 'scheduleId')
      OR (checked_command_type IN (
          'InitializeWorldCommerceV1','StartProductionRunV1','PerformJobV1',
          'CreateMarketListingV1','AssessPeriodicTaxV1'
        )
        AND NEW.event_type = 'ScheduledActionCreatedV1'
        AND NEW.aggregate_type = 'scheduled_action'
        AND NEW.aggregate_id = NEW.payload ->> 'scheduleId')
      OR (checked_command_type = 'CancelScheduledActionV1'
        AND NEW.event_type = 'ScheduledActionCancelledV1'
        AND NEW.aggregate_type = 'scheduled_action'
        AND NEW.aggregate_id = NEW.payload ->> 'scheduleId')
      OR (checked_command_type = 'CancelMarketListingV1'
        AND NEW.event_type = 'ScheduledActionCancelledV1'
        AND NEW.aggregate_type = 'scheduled_action'
        AND NEW.aggregate_id = NEW.payload ->> 'scheduleId')
      OR (checked_command_type = 'AutoPauseWorldClockV1' AND (
        (NEW.event_type = 'WorldClockAutoPausedV1'
          AND NEW.aggregate_type = 'simulation_clock'
          AND NEW.aggregate_id = NEW.world_id::text)
        OR (NEW.event_type = 'SimulationFailureRecordedV1'
          AND NEW.aggregate_type = 'simulation_failure'
          AND NEW.aggregate_id = NEW.payload ->> 'failureId')
      ))
      OR (checked_command_type = 'ResolveSimulationFailureV1' AND (
        (NEW.event_type = 'SimulationFailureResolvedV1'
          AND NEW.aggregate_type = 'simulation_failure'
          AND NEW.aggregate_id = NEW.payload ->> 'failureId')
        OR (NEW.event_type = 'ScheduledActionCancelledV1'
          AND NEW.aggregate_type = 'scheduled_action'
          AND NEW.aggregate_id = NEW.payload ->> 'scheduleId')
      ));
    IF NOT COALESCE(matrix_matches, false)
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.command_id) THEN
      RAISE EXCEPTION 'reserved simulation event namespace requires its exact open command'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_assert_simulation_domain_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_type text;
  command_record record;
  reserved_fact boolean;
BEGIN
  SELECT command.*
  INTO command_record
  FROM public.command_records command
  WHERE command.id = NEW.command_id
    AND command.world_id = NEW.world_id
    AND command.status = 'accepted'::command_record_status
    AND command.resulting_state_revision = NEW.resulting_state_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simulation event requires its accepted command revision'
      USING ERRCODE = '55000';
  END IF;
  checked_command_type := command_record.command_type;
  reserved_fact := checked_command_type IN (
      'InitializeWorldSimulationV1', 'ConfigureWorldClockV1',
      'StartWorldClockV1', 'PauseWorldClockV1', 'AdvanceSimulationV1',
      'ScheduleWorldNoticeV1', 'CancelScheduledActionV1',
      'AutoPauseWorldClockV1', 'ResolveSimulationFailureV1'
    ) OR NEW.aggregate_type IN (
      'simulation_clock', 'scheduled_action', 'simulation_failure', 'world_notice'
    ) OR NEW.event_type IN (
      'WorldSimulationInitializedV1', 'WorldClockConfiguredV1',
      'WorldClockStartedV1', 'WorldClockPausedV1', 'SimulationAdvancedV1',
      'ScheduledActionCreatedV1', 'ScheduledActionCancelledV1',
      'ScheduledActionExecutedV1', 'WorldNoticeEmittedV1',
      'WorldClockAutoPausedV1', 'SimulationFailureRecordedV1',
      'SimulationFailureResolvedV1'
    );
  IF NEW.event_ordinal NOT BETWEEN 0 AND 63
    OR command_record.opened_event_sequence IS NULL
    OR NEW.world_event_sequence < command_record.opened_event_sequence + 1
    OR NEW.world_event_sequence - command_record.opened_event_sequence - 1
      <> NEW.event_ordinal THEN
    RAISE EXCEPTION 'event ordinal must match its exact command world-sequence position'
      USING ERRCODE = '55000';
  END IF;
  IF reserved_fact AND (
    command_record.command_schema_version <> 1
    OR NOT public.worldgraph_jsonb_numbers_are_canonical_integers(NEW.payload)
    OR NOT public.worldgraph_jsonb_numbers_are_canonical_integers(NEW.metadata)
    OR (command_record.payload IS NOT NULL AND NOT
      public.worldgraph_jsonb_numbers_are_canonical_integers(command_record.payload))
    OR command_record.actor_type NOT IN (
      'user'::command_actor_type,
      'system'::command_actor_type,
      'platform_admin'::command_actor_type
    )
    OR CASE
      WHEN command_record.actor_type IN (
        'user'::command_actor_type, 'platform_admin'::command_actor_type
      ) THEN command_record.actor_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      WHEN command_record.actor_type = 'system'::command_actor_type THEN
        char_length(command_record.actor_id) NOT BETWEEN 3 AND 160
        OR command_record.actor_id !~ '^[a-z][a-z0-9._:-]*$'
      ELSE true
    END
    OR command_record.authorization_rule_id IS NULL
    OR char_length(command_record.authorization_rule_id) NOT BETWEEN 1 AND 120
    OR NOT EXISTS (
      SELECT 1
      FROM public.domain_events command_event
      WHERE command_event.command_id = NEW.command_id
      HAVING count(*) BETWEEN 1 AND 64
        AND min(command_event.event_ordinal) = 0
        AND max(command_event.event_ordinal) = count(*) - 1
    )
    OR NEW.occurred_at IS DISTINCT FROM command_record.decided_at
    OR NEW.recorded_at IS DISTINCT FROM command_record.decided_at
    OR NEW.recorded_at IS DISTINCT FROM date_trunc('milliseconds', NEW.recorded_at)
    OR NEW.metadata IS DISTINCT FROM jsonb_build_object(
      'actor', jsonb_build_object(
        'actorId', command_record.actor_id,
        'actorType', command_record.actor_type::text
      ),
      'authorizationRuleId', command_record.authorization_rule_id,
      'causationId', command_record.causation_id::text,
      'commandSchemaVersion', command_record.command_schema_version,
      'commandType', command_record.command_type,
      'correlationId', command_record.correlation_id::text,
      'overrideId', command_record.override_id::text,
      'payloadClassification', command_record.payload_classification::text
    )
  ) THEN
    RAISE EXCEPTION 'simulation event metadata or timestamps do not match its command'
      USING ERRCODE = '55000';
  END IF;

  CASE NEW.event_type
    WHEN 'WorldSimulationInitializedV1' THEN
      IF NEW.event_ordinal <> 0 OR NOT EXISTS (
        SELECT 1
        FROM public.world_simulation_clocks clock
        WHERE clock.world_id = NEW.world_id
          AND clock.updated_state_revision = NEW.resulting_state_revision
          AND NEW.aggregate_version = 1
          AND NEW.payload = jsonb_build_object(
            'configuration', jsonb_build_object(
              'epochAt', public.worldgraph_timestamp_text(clock.epoch_at),
              'maxBatchTicks', clock.max_batch_ticks,
              'maxCatchUpTicks', clock.max_catch_up_ticks,
              'prngAlgorithmVersion', clock.prng_algorithm_version,
              'wallCadenceMilliseconds', clock.wall_cadence_milliseconds,
              'worldMillisecondsPerTick', clock.world_milliseconds_per_tick
            ),
            'currentTick', clock.current_tick::text,
            'mode', clock.mode::text,
            'processRegistryVersion', COALESCE((
          SELECT batch.process_registry_version
          FROM public.simulation_batch_runs batch
          WHERE batch.world_id = NEW.world_id
            AND batch.command_id = NEW.command_id
        ), 1),
            'provenance', public.worldgraph_resolve_simulation_clock_config(NEW.world_id) ->> 'provenance'
          )
          AND command_record.payload = NEW.payload
          AND command_record.payload_hash = extensions.digest(
            convert_to(public.worldgraph_canonical_jsonb(NEW.payload), 'UTF8'), 'sha256'
          )
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id) = 1
      ) THEN
        RAISE EXCEPTION 'simulation initialization event has no exact clock fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WorldClockConfiguredV1' THEN
      IF NEW.event_ordinal <> 0 OR NOT EXISTS (
        SELECT 1
        FROM public.world_simulation_clocks clock
        WHERE clock.world_id = NEW.world_id
          AND clock.updated_state_revision = NEW.resulting_state_revision
          AND NEW.payload = jsonb_build_object(
            'configuration', jsonb_build_object(
              'epochAt', public.worldgraph_timestamp_text(clock.epoch_at),
              'maxBatchTicks', clock.max_batch_ticks,
              'maxCatchUpTicks', clock.max_catch_up_ticks,
              'prngAlgorithmVersion', clock.prng_algorithm_version,
              'wallCadenceMilliseconds', clock.wall_cadence_milliseconds,
              'worldMillisecondsPerTick', clock.world_milliseconds_per_tick
            ),
            'previousConfiguration', NEW.payload -> 'previousConfiguration',
            'tick', clock.current_tick::text
          )
          AND jsonb_typeof(NEW.payload -> 'previousConfiguration') = 'object'
          AND (command_record.payload IS NULL OR command_record.payload = jsonb_build_object(
            'epoch', public.worldgraph_timestamp_text(clock.epoch_at),
            'maxBatch', clock.max_batch_ticks,
            'maxCatchUp', clock.max_catch_up_ticks,
            'wallCadenceMs', clock.wall_cadence_milliseconds,
            'worldMillisecondsPerTick', clock.world_milliseconds_per_tick
          ))
          AND command_record.payload_hash = extensions.digest(convert_to(
            public.worldgraph_canonical_jsonb(jsonb_build_object(
              'epoch', public.worldgraph_timestamp_text(clock.epoch_at),
              'maxBatch', clock.max_batch_ticks,
              'maxCatchUp', clock.max_catch_up_ticks,
              'wallCadenceMs', clock.wall_cadence_milliseconds,
              'worldMillisecondsPerTick', clock.world_milliseconds_per_tick
            )), 'UTF8'
          ), 'sha256')
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id) = 1
      ) THEN
        RAISE EXCEPTION 'clock configuration event has no exact clock fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WorldClockStartedV1' THEN
      IF NEW.event_ordinal <> 0 OR NOT EXISTS (
        SELECT 1 FROM public.world_simulation_clocks clock
        WHERE clock.world_id = NEW.world_id
          AND clock.updated_state_revision = NEW.resulting_state_revision
          AND NEW.payload = jsonb_build_object('tick', clock.current_tick::text)
          AND clock.mode = 'running'::simulation_clock_mode
          AND (command_record.payload IS NULL OR command_record.payload = '{}'::jsonb)
          AND command_record.payload_hash = extensions.digest(
            convert_to(public.worldgraph_canonical_jsonb('{}'::jsonb), 'UTF8'), 'sha256'
          )
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id) = 1
      ) THEN
        RAISE EXCEPTION 'clock start event has no exact clock fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WorldClockPausedV1' THEN
      IF NEW.event_ordinal <> 0 OR NOT EXISTS (
        SELECT 1 FROM public.world_simulation_clocks clock
        WHERE clock.world_id = NEW.world_id
          AND clock.updated_state_revision = NEW.resulting_state_revision
          AND NEW.payload = jsonb_build_object(
            'reason', 'creator', 'tick', clock.current_tick::text
          )
          AND clock.mode = 'paused'::simulation_clock_mode
          AND (command_record.payload IS NULL OR command_record.payload = '{}'::jsonb)
          AND command_record.payload_hash = extensions.digest(
            convert_to(public.worldgraph_canonical_jsonb('{}'::jsonb), 'UTF8'), 'sha256'
          )
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id) = 1
      ) THEN
        RAISE EXCEPTION 'clock pause event has no exact clock fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'SimulationAdvancedV1' THEN
      IF NEW.event_ordinal <> 0 OR NOT EXISTS (
          SELECT 1
          FROM public.world_simulation_clocks clock
          JOIN public.simulation_batch_runs batch
            ON batch.world_id = clock.world_id AND batch.command_id = NEW.command_id
          WHERE clock.world_id = NEW.world_id
            AND clock.updated_state_revision = NEW.resulting_state_revision
            AND batch.status = 'completed'::simulation_batch_status
            AND batch.to_tick = clock.current_tick
            AND batch.outcome_hash = clock.outcome_hash
            AND NEW.payload = jsonb_build_object(
              'executedScheduleCount', (
                SELECT count(*) FROM public.domain_events event
                WHERE event.command_id = NEW.command_id
                  AND event.event_type = 'ScheduledActionExecutedV1'
              ),
              'fromTick', batch.from_tick::text,
              'outcomeHash', encode(clock.outcome_hash, 'hex'),
              'processRegistryVersion', COALESCE((
          SELECT batch.process_registry_version
          FROM public.simulation_batch_runs batch
          WHERE batch.world_id = NEW.world_id
            AND batch.command_id = NEW.command_id
        ), 1),
              'tickCount', (batch.to_tick - batch.from_tick)::integer,
              'toTick', batch.to_tick::text
            )
            AND (command_record.payload IS NULL OR command_record.payload = jsonb_build_object(
              'ticks', (batch.to_tick - batch.from_tick)::integer
            ))
            AND command_record.payload_hash = extensions.digest(convert_to(
              public.worldgraph_canonical_jsonb(jsonb_build_object(
                'ticks', (batch.to_tick - batch.from_tick)::integer
              )), 'UTF8'
            ), 'sha256')
            AND (SELECT count(*) FROM public.domain_events event
              WHERE event.command_id = NEW.command_id) = 1
                + (SELECT count(*) FROM public.domain_events event
                  WHERE event.command_id = NEW.command_id
                    AND event.event_type = 'ScheduledActionExecutedV1')
                + (SELECT count(*) FROM public.domain_events event
                  WHERE event.command_id = NEW.command_id
                    AND event.event_type = 'WorldNoticeEmittedV1')
                + (SELECT count(*) FROM public.domain_events event
                  WHERE event.command_id = NEW.command_id
                    AND event.event_type = 'ScheduledActionCreatedV1')
            AND (SELECT count(*)
              FROM public.domain_events executed
              JOIN public.scheduled_actions action
                ON action.world_id = executed.world_id
               AND action.id::text = executed.aggregate_id
              WHERE executed.command_id = NEW.command_id
                AND executed.event_type = 'ScheduledActionExecutedV1'
                AND action.action_type = 'EmitWorldNoticeV1') =
              (SELECT count(*) FROM public.domain_events event
                WHERE event.command_id = NEW.command_id
                  AND event.event_type = 'WorldNoticeEmittedV1')
            AND NOT EXISTS (
              SELECT 1 FROM public.scheduled_actions pending
              WHERE pending.world_id = NEW.world_id
                AND pending.status = 'scheduled'::scheduled_action_status
                AND pending.due_tick <= clock.current_tick
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.domain_events executed
              JOIN public.scheduled_actions action
                ON action.world_id = executed.world_id
               AND action.id::text = executed.aggregate_id
              WHERE executed.command_id = NEW.command_id
                AND executed.event_type = 'ScheduledActionExecutedV1'
                AND action.due_tick > clock.current_tick
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.domain_events executed
              JOIN public.scheduled_actions action
                ON action.world_id = executed.world_id
               AND action.id::text = executed.aggregate_id
              WHERE executed.command_id = NEW.command_id
                AND executed.event_type = 'ScheduledActionExecutedV1'
                AND (SELECT count(*)
                  FROM public.domain_events notice
                  WHERE notice.command_id = executed.command_id
                    AND notice.event_type = 'WorldNoticeEmittedV1'
                    AND notice.aggregate_id = executed.aggregate_id
                    AND notice.event_ordinal = executed.event_ordinal + 1
                ) <> CASE action.action_type
                  WHEN 'EmitWorldNoticeV1' THEN 1
                  ELSE 0
                END
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.domain_events created
              WHERE created.command_id = NEW.command_id
                AND created.event_type = 'ScheduledActionCreatedV1'
                AND created.event_ordinal <= 0
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.domain_events left_event
              JOIN public.scheduled_actions left_action
                ON left_action.world_id = left_event.world_id
               AND left_action.id::text = left_event.aggregate_id
              JOIN public.domain_events right_event
                ON right_event.command_id = left_event.command_id
               AND right_event.event_type = 'ScheduledActionExecutedV1'
               AND right_event.event_ordinal > left_event.event_ordinal
              JOIN public.scheduled_actions right_action
                ON right_action.world_id = right_event.world_id
               AND right_action.id::text = right_event.aggregate_id
              WHERE left_event.command_id = NEW.command_id
                AND left_event.event_type = 'ScheduledActionExecutedV1'
                AND (left_action.due_tick, left_action.priority,
                  left_action.schedule_sequence, left_action.id) >
                  (right_action.due_tick, right_action.priority,
                    right_action.schedule_sequence, right_action.id)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.domain_events left_event
              JOIN public.scheduled_actions left_action
                ON left_action.world_id = left_event.world_id
               AND left_action.id::text = left_event.aggregate_id
              JOIN public.domain_events right_event
                ON right_event.command_id = left_event.command_id
               AND right_event.event_type = 'ScheduledActionCreatedV1'
               AND right_event.event_ordinal > left_event.event_ordinal
              JOIN public.scheduled_actions right_action
                ON right_action.world_id = right_event.world_id
               AND right_action.id::text = right_event.aggregate_id
              WHERE left_event.command_id = NEW.command_id
                AND left_event.event_type = 'ScheduledActionCreatedV1'
                AND (left_event.event_ordinal <= 0
                  OR left_action.schedule_sequence > right_action.schedule_sequence)
            )
        ) THEN
        RAISE EXCEPTION 'simulation advance event has no exact clock/batch fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'ScheduledActionCreatedV1' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.scheduled_actions action
        JOIN public.command_records command ON command.id = action.created_command_id
        WHERE action.world_id = NEW.world_id
          AND action.id::text = NEW.aggregate_id
          AND NEW.aggregate_version = 1
          AND action.created_command_id = NEW.command_id
          AND action.created_state_revision = NEW.resulting_state_revision
          AND action.created_at = NEW.recorded_at
          AND action.updated_at = NEW.recorded_at
          AND NEW.payload = jsonb_build_object(
            'actionSchemaVersion', action.action_schema_version,
            'actionType', action.action_type,
            'dueTick', action.due_tick::text,
            'payload', action.payload,
            'payloadHash', encode(action.payload_hash, 'hex'),
            'priority', action.priority,
            'processVersion', action.process_version,
            'scheduleId', action.id::text,
            'scheduleSequence', action.schedule_sequence::text
          )
          AND action.created_by_actor_type = command.actor_type
          AND action.created_by_actor_id = command.actor_id
          AND (checked_command_type <> 'AdvanceSimulationV1' OR action.due_tick > (
            SELECT clock.current_tick
            FROM public.world_simulation_clocks clock
            WHERE clock.world_id = action.world_id
          ))
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id
              AND event.event_type = 'ScheduledActionCreatedV1'
              AND event.aggregate_id = action.id::text) = 1
          AND (checked_command_type <> 'ScheduleWorldNoticeV1' OR (
            SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id
          ) = 1)
          AND (checked_command_type <> 'ScheduleWorldNoticeV1' OR (
            (command_record.payload IS NULL OR command_record.payload = jsonb_build_object(
              'dueTick', action.due_tick::text,
              'priority', action.priority,
              'text', action.payload ->> 'text',
              'visibility', action.payload ->> 'visibility'
            ))
            AND command_record.payload_hash = extensions.digest(convert_to(
              public.worldgraph_canonical_jsonb(jsonb_build_object(
                'dueTick', action.due_tick::text,
                'priority', action.priority,
                'text', action.payload ->> 'text',
                'visibility', action.payload ->> 'visibility'
              )), 'UTF8'
            ), 'sha256')
          ))
      ) THEN
        RAISE EXCEPTION 'schedule creation event has no exact action fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'ScheduledActionExecutedV1' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.scheduled_actions action
        JOIN public.world_simulation_clocks clock ON clock.world_id = action.world_id
        WHERE action.world_id = NEW.world_id
          AND action.id::text = NEW.aggregate_id
          AND NEW.aggregate_version = 2
          AND action.status = 'completed'::scheduled_action_status
          AND action.completed_event_id = NEW.id
          AND action.completed_state_revision = NEW.resulting_state_revision
          AND action.updated_at = NEW.recorded_at
          AND action.due_tick <= clock.current_tick
          AND NEW.payload = jsonb_build_object(
            'actionType', action.action_type,
            'dueTick', action.due_tick::text,
            'outcomeHash', encode(clock.outcome_hash, 'hex'),
            'processVersion', action.process_version,
            'scheduleId', action.id::text,
            'scheduleSequence', action.schedule_sequence::text
          )
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id
              AND event.event_type = 'ScheduledActionExecutedV1'
              AND event.aggregate_id = action.id::text) = 1
          AND (SELECT count(*) FROM public.domain_events notice
            WHERE notice.command_id = NEW.command_id
              AND notice.event_type = 'WorldNoticeEmittedV1'
              AND notice.aggregate_id = action.id::text
              AND notice.event_ordinal = NEW.event_ordinal + 1
              AND notice.payload = jsonb_build_object(
                'emittedAtTick', action.due_tick::text,
                'scheduleId', action.id::text,
                'text', action.payload ->> 'text',
                'visibility', action.payload ->> 'visibility'
              )) = CASE action.action_type
                WHEN 'EmitWorldNoticeV1' THEN 1
                ELSE 0
              END
      ) THEN
        RAISE EXCEPTION 'schedule execution event has no exact action fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'ScheduledActionCancelledV1' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.scheduled_actions action
        WHERE action.world_id = NEW.world_id
          AND action.id::text = NEW.aggregate_id
          AND NEW.aggregate_version = 2
          AND action.status = 'cancelled'::scheduled_action_status
          AND action.cancelled_command_id = NEW.command_id
          AND action.completed_state_revision = NEW.resulting_state_revision
          AND action.updated_at = NEW.recorded_at
          AND NEW.payload = jsonb_build_object(
            'actionType', action.action_type,
            'dueTick', action.due_tick::text,
            'scheduleId', action.id::text,
            'scheduleSequence', action.schedule_sequence::text
          )
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id
              AND event.event_type = 'ScheduledActionCancelledV1'
              AND event.aggregate_id = action.id::text) = 1
          AND (checked_command_type <> 'CancelScheduledActionV1' OR (
            SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id
          ) = 1)
          AND (checked_command_type <> 'CancelScheduledActionV1' OR (
            (command_record.payload IS NULL OR command_record.payload = jsonb_build_object(
              'scheduleId', action.id::text
            ))
            AND command_record.payload_hash = extensions.digest(convert_to(
              public.worldgraph_canonical_jsonb(jsonb_build_object(
                'scheduleId', action.id::text
              )), 'UTF8'
            ), 'sha256')
          ))
      ) THEN
        RAISE EXCEPTION 'schedule cancellation event has no exact action fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WorldNoticeEmittedV1' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.scheduled_actions action
        JOIN public.domain_events executed ON executed.id = action.completed_event_id
        WHERE action.world_id = NEW.world_id
          AND action.id::text = NEW.aggregate_id
          AND NEW.aggregate_version = 1
          AND action.status = 'completed'::scheduled_action_status
          AND executed.command_id = NEW.command_id
          AND executed.event_type = 'ScheduledActionExecutedV1'
          AND NEW.event_ordinal = executed.event_ordinal + 1
          AND NEW.payload = jsonb_build_object(
            'emittedAtTick', action.due_tick::text,
            'scheduleId', action.id::text,
            'text', action.payload ->> 'text',
            'visibility', action.payload ->> 'visibility'
          )
          AND (SELECT count(*) FROM public.domain_events notice
            WHERE notice.command_id = NEW.command_id
              AND notice.event_type = 'WorldNoticeEmittedV1'
              AND notice.aggregate_id = action.id::text) = 1
      ) THEN
        RAISE EXCEPTION 'world notice event has no exact completed action fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'WorldClockAutoPausedV1' THEN
      IF NEW.event_ordinal <> 0 OR NOT EXISTS (
        SELECT 1 FROM public.world_simulation_clocks clock
        JOIN public.simulation_failures failure
          ON failure.world_id = clock.world_id
        WHERE clock.world_id = NEW.world_id
          AND clock.updated_state_revision = NEW.resulting_state_revision
          AND clock.mode = 'error'::simulation_clock_mode
          AND NEW.payload = jsonb_build_object(
            'errorCode', failure.error_code,
            'failureId', failure.id::text,
            'tick', clock.current_tick::text
          )
          AND (command_record.payload IS NULL OR command_record.payload = jsonb_build_object(
            'errorCode', failure.error_code,
            'failureId', failure.id::text
          ))
          AND command_record.payload_hash = extensions.digest(convert_to(
            public.worldgraph_canonical_jsonb(jsonb_build_object(
              'errorCode', failure.error_code,
              'failureId', failure.id::text
            )), 'UTF8'
          ), 'sha256')
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id) = 2
      ) THEN
        RAISE EXCEPTION 'auto-pause event has no exact clock/failure fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'SimulationFailureRecordedV1' THEN
      IF NEW.event_ordinal <> 1 OR NEW.aggregate_version <> 1 OR NOT EXISTS (
        SELECT 1 FROM public.simulation_failures failure
        JOIN public.simulation_batch_runs batch
          ON batch.world_id = failure.world_id
         AND batch.id = failure.batch_run_id
        JOIN public.world_simulation_clocks clock
          ON clock.world_id = failure.world_id
        WHERE failure.world_id = NEW.world_id
          AND failure.id::text = NEW.aggregate_id
          AND failure.opened_at = NEW.recorded_at
          AND NEW.payload = jsonb_build_object(
            'attempts', failure.attempts,
            'batchRunId', failure.batch_run_id::text,
            'errorCode', failure.error_code,
            'failureId', failure.id::text,
            'processType', failure.process_type,
            'processVersion', failure.process_version,
            'scheduleId', failure.schedule_id::text,
            'tick', failure.tick::text
          )
          AND (SELECT count(*) FROM public.domain_events event
            WHERE event.command_id = NEW.command_id) = 2
      ) THEN
        RAISE EXCEPTION 'failure-recorded event has no exact failure fact'
          USING ERRCODE = '55000';
      END IF;
    WHEN 'SimulationFailureResolvedV1' THEN
      IF NEW.event_ordinal <> 0 OR NEW.aggregate_version <> 2 OR NOT EXISTS (
        SELECT 1 FROM public.simulation_failures failure
        JOIN public.simulation_batch_runs batch
          ON batch.world_id = failure.world_id
         AND batch.id = failure.batch_run_id
        JOIN public.world_simulation_clocks clock
          ON clock.world_id = failure.world_id
        WHERE failure.world_id = NEW.world_id
          AND failure.id::text = NEW.aggregate_id
          AND failure.status = 'resolved'::simulation_failure_status
          AND failure.resolution_command_id = NEW.command_id
          AND failure.resolved_at = NEW.recorded_at
          AND clock.mode = 'paused'::simulation_clock_mode
          AND clock.last_wall_anchor_at IS NULL
          AND clock.current_tick = batch.from_tick
          AND clock.updated_state_revision = NEW.resulting_state_revision
          AND clock.updated_at = NEW.recorded_at
          AND NEW.payload = jsonb_build_object(
            'failureId', failure.id::text,
            'resolution', NEW.payload ->> 'resolution',
            'scheduleId', failure.schedule_id::text,
            'tick', failure.tick::text
          )
          AND NEW.payload ->> 'resolution' IN ('cancel_action', 'retry_after_repair')
          AND (command_record.payload IS NULL OR command_record.payload = jsonb_build_object(
            'failureId', failure.id::text,
            'resolution', NEW.payload ->> 'resolution'
          ))
          AND command_record.payload_hash = extensions.digest(convert_to(
            public.worldgraph_canonical_jsonb(jsonb_build_object(
              'failureId', failure.id::text,
              'resolution', NEW.payload ->> 'resolution'
            )), 'UTF8'
          ), 'sha256')
          AND (
            (NEW.payload ->> 'resolution' = 'cancel_action'
              AND failure.schedule_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.scheduled_actions action
                WHERE action.world_id = failure.world_id
                  AND action.id = failure.schedule_id
                  AND action.status = 'cancelled'::scheduled_action_status
                  AND action.cancelled_command_id = NEW.command_id
              )
              AND (SELECT count(*) FROM public.domain_events event
                WHERE event.command_id = NEW.command_id
                  AND event.event_type = 'ScheduledActionCancelledV1') = 1
              AND (SELECT count(*) FROM public.domain_events event
                WHERE event.command_id = NEW.command_id) = 2)
            OR (NEW.payload ->> 'resolution' = 'retry_after_repair'
              AND NOT EXISTS (
                SELECT 1 FROM public.scheduled_actions action
                WHERE action.cancelled_command_id = NEW.command_id
              )
              AND (SELECT count(*) FROM public.domain_events event
                WHERE event.command_id = NEW.command_id) = 1)
          )
      ) THEN
        RAISE EXCEPTION 'failure-resolution event has no exact resolution/action fact'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      IF NEW.aggregate_type IN (
        'simulation_clock', 'scheduled_action', 'simulation_failure', 'world_notice'
      ) OR checked_command_type IN (
        'InitializeWorldSimulationV1', 'ConfigureWorldClockV1',
        'StartWorldClockV1', 'PauseWorldClockV1', 'AdvanceSimulationV1',
        'ScheduleWorldNoticeV1', 'CancelScheduledActionV1',
        'AutoPauseWorldClockV1', 'ResolveSimulationFailureV1'
      ) THEN
        RAISE EXCEPTION 'reserved simulation aggregate has an unsupported event fact'
          USING ERRCODE = '55000';
      END IF;
  END CASE;
  RETURN NULL;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION worldgraph_protect_commerce_fact()
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
      'business_facility_recipe_versions','employment_offers','tax_policies'
    ) AND checked_command_type IS DISTINCT FROM 'InitializeWorldCommerceV1')
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
      AND checked_command_type IS DISTINCT FROM 'ReconcileWorldCommerceV1') THEN
    RAISE EXCEPTION '% fact is outside its exact commerce command', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER resource_types_protect
  BEFORE INSERT OR UPDATE OR DELETE ON resource_types
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER production_recipes_protect
  BEFORE INSERT OR UPDATE OR DELETE ON production_recipes
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER production_recipe_versions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON production_recipe_versions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER business_facility_recipe_versions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON business_facility_recipe_versions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER employment_offers_protect
  BEFORE INSERT OR UPDATE OR DELETE ON employment_offers
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER inventory_movements_protect
  BEFORE INSERT OR UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER production_run_transitions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON production_run_transitions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER work_records_protect
  BEFORE INSERT OR UPDATE OR DELETE ON work_records
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER market_trades_protect
  BEFORE INSERT OR UPDATE OR DELETE ON market_trades
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER tax_policies_protect
  BEFORE INSERT OR UPDATE OR DELETE ON tax_policies
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER tax_assessments_protect
  BEFORE INSERT OR UPDATE OR DELETE ON tax_assessments
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE TRIGGER economy_expansion_reconciliation_runs_protect
  BEFORE INSERT OR UPDATE OR DELETE ON economy_expansion_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_fact();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_economy_expansion_reconciliation_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' OR NOT EXISTS (
    SELECT 1 FROM public.economy_expansion_reconciliation_runs run
    WHERE run.id = NEW.run_id
      AND run.command_id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
      AND public.worldgraph_commerce_command_type(run.world_id) = 'ReconcileWorldCommerceV1'
  ) THEN
    RAISE EXCEPTION 'commerce reconciliation items are append-only command evidence'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER economy_expansion_reconciliation_items_protect
  BEFORE INSERT OR UPDATE OR DELETE ON economy_expansion_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_economy_expansion_reconciliation_item();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_commerce_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_world_id uuid := COALESCE(NEW.world_id, OLD.world_id);
  checked_command_type text;
  immutable_new jsonb;
  immutable_old jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% projection rows cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  checked_command_type := public.worldgraph_commerce_command_type(checked_world_id);
  IF checked_command_type IS NULL THEN
    RAISE EXCEPTION '% projection requires an open commerce command', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF COALESCE((to_jsonb(NEW) ->> 'row_version')::bigint, 1) <> 1 THEN
      RAISE EXCEPTION '% initial projection version must be one', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    IF (TG_TABLE_NAME = 'world_economy_expansion_heads'
        AND checked_command_type <> 'InitializeWorldCommerceV1')
      OR (TG_TABLE_NAME = 'businesses' AND checked_command_type NOT IN (
        'InitializeWorldCommerceV1','CreateBusinessV1'))
      OR (TG_TABLE_NAME = 'business_facilities' AND checked_command_type NOT IN (
        'InitializeWorldCommerceV1','ConfigureBusinessFacilityV1'))
      OR (TG_TABLE_NAME = 'inventories' AND checked_command_type NOT IN (
        'InitializeWorldCommerceV1','PurchaseMarketListingV1'))
      OR (TG_TABLE_NAME = 'production_runs'
        AND checked_command_type <> 'StartProductionRunV1')
      OR (TG_TABLE_NAME = 'employment_contracts'
        AND checked_command_type <> 'CreateEmploymentContractV1')
      OR (TG_TABLE_NAME = 'payroll_records' AND checked_command_type NOT IN (
        'PerformJobV1','SettlePayrollV1'))
      OR (TG_TABLE_NAME = 'market_listings'
        AND checked_command_type <> 'CreateMarketListingV1')
      OR (TG_TABLE_NAME = 'inventory_reservations' AND checked_command_type NOT IN (
        'StartProductionRunV1','CreateMarketListingV1')) THEN
      RAISE EXCEPTION '% projection insert is outside its exact command', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) ? 'row_version')
    AND (to_jsonb(NEW) ->> 'row_version')::bigint <>
      (to_jsonb(OLD) ->> 'row_version')::bigint + 1 THEN
    RAISE EXCEPTION '% projection version must advance exactly once', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  immutable_new := to_jsonb(NEW) - ARRAY[
    'status','row_version','updated_state_revision','updated_at','closed_at',
    'quantity','reserved_quantity','failure_code','terminal_command_id',
    'terminal_event_id','terminal_reason','terminal_state_revision','completed_at','accepted_command_id',
    'accepted_event_id','accepted_state_revision','ended_at','financial_transaction_id','error_code',
    'remaining_quantity','last_reconciled_state_revision','last_reconciliation_run_id',
    'reconciliation_status','checksum','terminal_at'
  ];
  immutable_old := to_jsonb(OLD) - ARRAY[
    'status','row_version','updated_state_revision','updated_at','closed_at',
    'quantity','reserved_quantity','failure_code','terminal_command_id',
    'terminal_event_id','terminal_reason','terminal_state_revision','completed_at','accepted_command_id',
    'accepted_event_id','accepted_state_revision','ended_at','financial_transaction_id','error_code',
    'remaining_quantity','last_reconciled_state_revision','last_reconciliation_run_id',
    'reconciliation_status','checksum','terminal_at'
  ];
  IF immutable_new IS DISTINCT FROM immutable_old THEN
    RAISE EXCEPTION '% immutable identity or terms changed', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF (TG_TABLE_NAME = 'businesses' AND checked_command_type NOT IN (
      'ConfigureBusinessFacilityV1','RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'business_facilities' AND checked_command_type NOT IN (
      'ConfigureBusinessFacilityV1','RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'inventories' AND checked_command_type NOT IN (
      'StartProductionRunV1','CompleteProductionRunV1','CreateMarketListingV1',
      'CancelMarketListingV1','PurchaseMarketListingV1','ExpireMarketListingV1',
      'RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'production_runs' AND checked_command_type NOT IN (
      'StartProductionRunV1','CompleteProductionRunV1','RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'employment_contracts' AND checked_command_type NOT IN (
      'AcceptEmploymentContractV1','EndEmploymentContractV1',
      'RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'payroll_records' AND checked_command_type NOT IN (
      'SettlePayrollV1','RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'market_listings' AND checked_command_type NOT IN (
      'PurchaseMarketListingV1','CancelMarketListingV1','ExpireMarketListingV1',
      'RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'inventory_reservations' AND checked_command_type NOT IN (
      'CompleteProductionRunV1','PurchaseMarketListingV1','CancelMarketListingV1',
      'ExpireMarketListingV1','RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'world_economy_expansion_heads'
      AND checked_command_type = 'InitializeWorldCommerceV1') THEN
    RAISE EXCEPTION '% projection update is outside its exact command', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_economy_expansion_heads_protect
  BEFORE INSERT OR UPDATE OR DELETE ON world_economy_expansion_heads
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE TRIGGER businesses_protect
  BEFORE INSERT OR UPDATE OR DELETE ON businesses
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE TRIGGER business_facilities_protect
  BEFORE INSERT OR UPDATE OR DELETE ON business_facilities
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE TRIGGER inventories_protect
  BEFORE INSERT OR UPDATE OR DELETE ON inventories
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE TRIGGER production_runs_protect
  BEFORE INSERT OR UPDATE OR DELETE ON production_runs
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE TRIGGER employment_contracts_protect
  BEFORE INSERT OR UPDATE OR DELETE ON employment_contracts
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE TRIGGER payroll_records_protect
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_records
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE TRIGGER market_listings_protect
  BEFORE INSERT OR UPDATE OR DELETE ON market_listings
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE TRIGGER inventory_reservations_protect
  BEFORE INSERT OR UPDATE OR DELETE ON inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_commerce_association()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE row_value jsonb := to_jsonb(NEW);
DECLARE checked_id uuid := (row_value ->> 'id')::uuid;
BEGIN
  IF TG_TABLE_NAME = 'resource_types' AND NOT EXISTS (
    SELECT 1
    FROM public.resource_types resource
    JOIN public.primitive_versions version
      ON version.id = resource.primitive_version_id
     AND version.content_hash = resource.primitive_content_hash
    JOIN public.primitive_families family ON family.id = version.family_id
    WHERE resource.id = checked_id
      AND family.stable_key::text = resource.primitive_key::text
      AND version.semver = resource.primitive_version
      AND version.lifecycle IN ('published','deprecated')
  ) THEN
    RAISE EXCEPTION 'resource provenance does not identify its exact primitive version'
      USING ERRCODE = '23514', CONSTRAINT = 'resource_primitive_provenance_exact';
  ELSIF TG_TABLE_NAME = 'production_recipe_versions' AND NOT EXISTS (
    SELECT 1
    FROM public.production_recipe_versions recipe
    JOIN public.primitive_versions version
      ON version.id = recipe.primitive_version_id
     AND version.content_hash = recipe.primitive_content_hash
    JOIN public.primitive_families family ON family.id = version.family_id
    WHERE recipe.id = checked_id
      AND family.stable_key::text = recipe.primitive_key::text
      AND version.semver = recipe.primitive_version
      AND version.lifecycle IN ('published','deprecated')
  ) THEN
    RAISE EXCEPTION 'recipe provenance does not identify its exact primitive version'
      USING ERRCODE = '23514', CONSTRAINT = 'recipe_primitive_provenance_exact';
  ELSIF TG_TABLE_NAME = 'businesses' AND NOT EXISTS (
    SELECT 1
    FROM public.businesses business
    JOIN public.world_entities organization
      ON organization.world_id = business.world_id
     AND organization.id = business.backing_organization_entity_id
    JOIN public.wallets wallet
      ON wallet.world_id = business.world_id AND wallet.id = business.wallet_id
     AND wallet.currency_id = business.currency_id
    WHERE business.id = checked_id
      AND organization.entity_type = 'organization'
      AND organization.retired_world_version_id IS NULL
      AND wallet.wallet_kind = 'organization'::wallet_kind
      AND wallet.owner_entity_id = organization.id
  ) THEN
    RAISE EXCEPTION 'business requires its active organization and organization wallet'
      USING ERRCODE = '23514', CONSTRAINT = 'business_organization_wallet_exact';
  ELSIF TG_TABLE_NAME = 'business_facilities' AND NOT EXISTS (
    SELECT 1
    FROM public.business_facilities facility
    JOIN public.businesses business
      ON business.world_id = facility.world_id AND business.id = facility.business_id
    JOIN public.asset_ownership ownership
      ON ownership.world_id = facility.world_id
     AND ownership.asset_id = facility.facility_asset_id
    WHERE facility.id = checked_id
      AND ownership.owner_entity_id = business.backing_organization_entity_id
  ) THEN
    RAISE EXCEPTION 'facility asset must be currently owned by its business organization'
      USING ERRCODE = '23514', CONSTRAINT = 'business_facility_ownership_exact';
  ELSIF TG_TABLE_NAME = 'business_facility_recipe_versions' AND NOT EXISTS (
    SELECT 1
    FROM public.business_facility_recipe_versions binding
    JOIN public.business_facilities facility
      ON facility.world_id = binding.world_id AND facility.id = binding.facility_id
    JOIN public.assets asset
      ON asset.world_id = facility.world_id AND asset.id = facility.facility_asset_id
    JOIN public.production_recipe_versions recipe
      ON recipe.world_id = binding.world_id AND recipe.id = binding.recipe_version_id
    WHERE binding.facility_id = (row_value ->> 'facility_id')::uuid
      AND binding.recipe_version_id = (row_value ->> 'recipe_version_id')::uuid
      AND recipe.facility_requirements ->> 'assetType' = asset.asset_type
  ) THEN
    RAISE EXCEPTION 'facility capability does not match the recipe asset requirement'
      USING ERRCODE = '23514', CONSTRAINT = 'facility_recipe_requirement_exact';
  ELSIF TG_TABLE_NAME = 'production_runs' AND NOT EXISTS (
    SELECT 1
    FROM public.production_runs run
    JOIN public.scheduled_actions action
      ON action.world_id = run.world_id AND action.id = run.scheduled_action_id
    WHERE run.id = checked_id
      AND action.created_command_id = run.start_command_id
      AND action.created_state_revision = run.created_state_revision
      AND action.action_type = 'CompleteProductionRunV1'
      AND action.action_schema_version = 1
      AND action.process_version = '1.0.0'
      AND action.priority = 50
      AND action.due_tick = run.due_tick
      AND action.payload = jsonb_build_object('productionRunId', run.id::text)
  ) THEN
    RAISE EXCEPTION 'production run requires its exact completion schedule'
      USING ERRCODE = '23514', CONSTRAINT = 'production_run_schedule_exact';
  ELSIF TG_TABLE_NAME = 'employment_offers' AND NOT EXISTS (
    SELECT 1
    FROM public.employment_offers offer
    JOIN public.businesses business
      ON business.world_id = offer.world_id AND business.id = offer.business_id
    WHERE offer.id = checked_id AND offer.currency_id = business.currency_id
  ) THEN
    RAISE EXCEPTION 'employment offer currency must match its business wallet currency'
      USING ERRCODE = '23514', CONSTRAINT = 'employment_offer_currency_exact';
  ELSIF TG_TABLE_NAME = 'employment_contracts' AND NOT EXISTS (
    SELECT 1
    FROM public.employment_contracts contract
    JOIN public.businesses business
      ON business.world_id = contract.world_id AND business.id = contract.business_id
    JOIN public.world_entities worker
      ON worker.world_id = contract.world_id AND worker.id = contract.worker_entity_id
    JOIN public.wallets employer
      ON employer.world_id = contract.world_id AND employer.id = contract.employer_wallet_id
     AND employer.currency_id = contract.currency_id
    JOIN public.wallets worker_wallet
      ON worker_wallet.world_id = contract.world_id AND worker_wallet.id = contract.worker_wallet_id
     AND worker_wallet.currency_id = contract.currency_id
    WHERE contract.id = checked_id
      AND worker.entity_type = 'player_character'
      AND worker.retired_world_version_id IS NULL
      AND employer.id = business.wallet_id
      AND worker_wallet.owner_entity_id = worker.id
      AND worker_wallet.wallet_kind = 'player'::wallet_kind
  ) THEN
    RAISE EXCEPTION 'employment contract parties and wallets are inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'employment_contract_parties_exact';
  ELSIF TG_TABLE_NAME = 'payroll_records' AND NOT EXISTS (
    SELECT 1
    FROM public.payroll_records payroll
    JOIN public.employment_contracts contract
      ON contract.world_id = payroll.world_id AND contract.id = payroll.contract_id
    JOIN public.work_records work
      ON work.world_id = payroll.world_id AND work.id = payroll.work_record_id
    JOIN public.scheduled_actions action
      ON action.world_id = payroll.world_id AND action.id = payroll.scheduled_action_id
    WHERE payroll.id = checked_id
      AND action.created_command_id = payroll.created_command_id
      AND action.created_state_revision = payroll.created_state_revision
      AND action.action_type = 'SettlePayrollV1'
      AND action.action_schema_version = 1
      AND action.process_version = '1.0.0'
      AND action.priority = 50
      AND action.payload = jsonb_build_object('payrollRecordId', payroll.id::text)
      AND (
        (payroll.tax_minor = 0 AND payroll.tax_policy_id IS NULL)
        OR EXISTS (
          SELECT 1 FROM public.tax_policies policy
          WHERE policy.world_id = payroll.world_id
            AND policy.id = payroll.tax_policy_id
            AND policy.currency_id = contract.currency_id
            AND policy.tax_type = 'payroll'::tax_policy_type
            AND policy.collection_mode = 'withheld_from_recipient'::tax_collection_mode
            AND work.performed_tick >= policy.effective_from_tick
            AND (policy.effective_until_tick IS NULL
              OR work.performed_tick < policy.effective_until_tick)
            AND payroll.tax_minor = public.worldgraph_tax_amount_v1(
              payroll.gross_minor, COALESCE(policy.rate_basis_points,0),
              COALESCE(policy.fixed_amount_minor,0), policy.tax_type
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'payroll record requires its exact settlement schedule'
      USING ERRCODE = '23514', CONSTRAINT = 'payroll_schedule_exact';
  ELSIF TG_TABLE_NAME = 'tax_policies' AND NOT EXISTS (
    SELECT 1
    FROM public.tax_policies policy
    JOIN public.world_entities authority
      ON authority.world_id = policy.world_id AND authority.id = policy.authority_entity_id
    JOIN public.wallets treasury
      ON treasury.world_id = policy.world_id AND treasury.id = policy.treasury_wallet_id
     AND treasury.currency_id = policy.currency_id
    JOIN public.primitive_versions version
      ON version.id = policy.primitive_version_id
     AND version.content_hash = policy.primitive_content_hash
    JOIN public.primitive_families family ON family.id = version.family_id
    WHERE policy.id = checked_id
      AND authority.entity_type = 'institution'
      AND authority.retired_world_version_id IS NULL
      AND treasury.wallet_kind = 'treasury'::wallet_kind
      AND treasury.owner_entity_id = authority.id
      AND family.stable_key::text = policy.primitive_key::text
      AND version.semver = policy.primitive_version
      AND (
        policy.tax_type <> 'periodic_flat'::tax_policy_type
        OR EXISTS (
          SELECT 1
          FROM public.world_entities payer
          JOIN public.wallets payer_wallet
            ON payer_wallet.world_id = payer.world_id
           AND payer_wallet.owner_entity_id = payer.id
          WHERE payer.world_id = policy.world_id
            AND payer.id = (policy.applicability ->> 'payerEntityId')::uuid
            AND payer.retired_world_version_id IS NULL
            AND payer_wallet.id = (policy.applicability ->> 'payerWalletId')::uuid
            AND payer_wallet.currency_id = policy.currency_id
            AND payer_wallet.status = 'active'::wallet_status
        )
        AND (
          (policy.status = 'active'::tax_policy_status AND (
            SELECT count(*) FROM public.scheduled_actions action
            WHERE action.world_id = policy.world_id
              AND action.created_command_id = policy.created_command_id
              AND action.created_state_revision = policy.created_state_revision
              AND action.action_type = 'AssessPeriodicTaxV1'
              AND action.action_schema_version = 1
              AND action.process_version = '1.0.0'
              AND action.priority = 50
              AND action.status = 'scheduled'::scheduled_action_status
              AND action.payload = jsonb_build_object('taxPolicyId', policy.id::text)
              AND (policy.effective_until_tick IS NULL
                OR action.due_tick < policy.effective_until_tick)
              AND action.due_tick = greatest(
                policy.effective_from_tick::numeric,
                (SELECT clock.current_tick::numeric
                   FROM public.world_simulation_clocks clock
                  WHERE clock.world_id = policy.world_id)
                  + (policy.applicability ->> 'intervalTicks')::numeric
              )::bigint
          ) = 1)
          OR (policy.status <> 'active'::tax_policy_status AND NOT EXISTS (
            SELECT 1 FROM public.scheduled_actions action
            WHERE action.world_id = policy.world_id
              AND action.created_command_id = policy.created_command_id
              AND action.action_type = 'AssessPeriodicTaxV1'
              AND action.payload = jsonb_build_object('taxPolicyId', policy.id::text)
          ))
        )
      )
  ) THEN
    RAISE EXCEPTION 'tax policy authority, treasury, or provenance is inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'tax_policy_authority_exact';
  ELSIF TG_TABLE_NAME = 'inventory_movements' AND NOT (
    ((row_value ->> 'from_inventory_id') IS NULL OR EXISTS (
      SELECT 1 FROM public.inventories inventory
      WHERE inventory.id = (row_value ->> 'from_inventory_id')::uuid
        AND inventory.world_id = (row_value ->> 'world_id')::uuid
        AND inventory.resource_type_id = (row_value ->> 'resource_type_id')::uuid
    )) AND ((row_value ->> 'to_inventory_id') IS NULL OR EXISTS (
      SELECT 1 FROM public.inventories inventory
      WHERE inventory.id = (row_value ->> 'to_inventory_id')::uuid
        AND inventory.world_id = (row_value ->> 'world_id')::uuid
        AND inventory.resource_type_id = (row_value ->> 'resource_type_id')::uuid
    ))
  ) THEN
    RAISE EXCEPTION 'inventory movement endpoints must carry the exact resource type'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_movement_resource_exact';
  ELSIF TG_TABLE_NAME = 'market_listings' AND NOT EXISTS (
    SELECT 1
    FROM public.market_listings listing
    JOIN public.inventories inventory
      ON inventory.world_id = listing.world_id AND inventory.id = listing.seller_inventory_id
    JOIN public.wallets wallet
      ON wallet.world_id = listing.world_id AND wallet.id = listing.seller_wallet_id
     AND wallet.currency_id = listing.currency_id
    JOIN public.resource_types resource
      ON resource.world_id = listing.world_id AND resource.id = listing.resource_type_id
    WHERE listing.id = checked_id
      AND inventory.owner_entity_id = listing.seller_entity_id
      AND inventory.resource_type_id = resource.id
      AND wallet.owner_entity_id = listing.seller_entity_id
      AND public.worldgraph_quantity_fits_scale_v1(
        listing.offered_quantity, resource.quantity_scale
      )
      AND public.worldgraph_quantity_fits_scale_v1(
        listing.remaining_quantity, resource.quantity_scale
      )
      AND EXISTS (
        SELECT 1 FROM public.scheduled_actions action
        WHERE action.world_id = listing.world_id
          AND action.id = listing.scheduled_action_id
          AND action.created_command_id = listing.created_command_id
          AND action.created_state_revision = listing.created_state_revision
          AND action.action_type = 'ExpireMarketListingV1'
          AND action.action_schema_version = 1
          AND action.process_version = '1.0.0'
          AND action.priority = 50
          AND action.due_tick = listing.expires_at_tick
          AND action.payload = jsonb_build_object('listingId', listing.id::text)
      )
  ) THEN
    RAISE EXCEPTION 'listing parties, scale, or expiry schedule is inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'market_listing_parties_exact';
  ELSIF TG_TABLE_NAME = 'market_trades' AND NOT EXISTS (
    SELECT 1
    FROM public.market_trades trade
    JOIN public.market_listings listing
      ON listing.world_id = trade.world_id AND listing.id = trade.listing_id
    JOIN public.financial_transactions transaction
      ON transaction.world_id = trade.world_id
     AND transaction.currency_id = trade.currency_id
     AND transaction.id = trade.wallet_transaction_id
    WHERE trade.id = checked_id
      AND trade.seller_entity_id = listing.seller_entity_id
      AND trade.seller_inventory_id = listing.seller_inventory_id
      AND trade.unit_price_minor = listing.unit_price_minor
      AND trade.currency_id = listing.currency_id
      AND transaction.transaction_kind::text = 'market_purchase'
      AND transaction.command_id = trade.command_id
      AND transaction.supply_delta_minor = 0
  ) THEN
    RAISE EXCEPTION 'market trade does not match its listing and balanced transaction'
      USING ERRCODE = '23514', CONSTRAINT = 'market_trade_settlement_exact';
  ELSIF TG_TABLE_NAME = 'tax_assessments' AND NOT EXISTS (
    SELECT 1
    FROM public.tax_assessments assessment
    JOIN public.tax_policies policy
      ON policy.world_id = assessment.world_id AND policy.id = assessment.policy_id
    JOIN public.wallets payer
      ON payer.world_id = assessment.world_id AND payer.id = assessment.payer_wallet_id
     AND payer.currency_id = assessment.currency_id
    JOIN public.financial_transactions transaction
      ON transaction.world_id = assessment.world_id
     AND transaction.currency_id = assessment.currency_id
     AND transaction.id = assessment.settlement_transaction_id
    WHERE assessment.id = checked_id
      AND assessment.treasury_wallet_id = policy.treasury_wallet_id
      AND payer.owner_entity_id = assessment.payer_entity_id
      AND assessment.occurred_tick >= policy.effective_from_tick
      AND (policy.effective_until_tick IS NULL
        OR assessment.occurred_tick < policy.effective_until_tick)
      AND assessment.amount_minor = public.worldgraph_tax_amount_v1(
        assessment.basis_minor, COALESCE(policy.rate_basis_points,0),
        COALESCE(policy.fixed_amount_minor,0), policy.tax_type
      )
      AND transaction.command_id = assessment.command_id
      AND transaction.transaction_kind::text = CASE assessment.source_type
        WHEN 'market_trade' THEN 'market_purchase'
        WHEN 'payroll' THEN 'payroll'
        WHEN 'periodic_tax' THEN 'periodic_tax'
      END
      AND (
        (assessment.source_type = 'market_trade' AND EXISTS (
          SELECT 1 FROM public.market_trades trade
          WHERE trade.world_id = assessment.world_id
            AND trade.id = assessment.source_id
            AND trade.command_id = assessment.command_id
            AND trade.wallet_transaction_id = assessment.settlement_transaction_id
            AND policy.tax_type IN ('sales','marketplace_fee')
        ))
        OR (assessment.source_type = 'payroll' AND EXISTS (
          SELECT 1 FROM public.payroll_records payroll
          WHERE payroll.world_id = assessment.world_id
            AND payroll.id = assessment.source_id
            AND payroll.terminal_command_id = assessment.command_id
            AND payroll.financial_transaction_id = assessment.settlement_transaction_id
            AND policy.tax_type = 'payroll'
        ))
        OR (assessment.source_type = 'periodic_tax' AND policy.tax_type = 'periodic_flat'
          AND EXISTS (
            SELECT 1
            FROM public.scheduled_actions source_action
            JOIN public.command_records command
              ON command.id = assessment.command_id
             AND command.world_id = assessment.world_id
            WHERE source_action.world_id = assessment.world_id
              AND source_action.id = assessment.source_id
              AND source_action.status = 'completed'::scheduled_action_status
              AND source_action.action_type = 'AssessPeriodicTaxV1'
              AND source_action.payload = jsonb_build_object(
                'taxPolicyId', policy.id::text
              )
              AND command.command_type = 'AssessPeriodicTaxV1'
              AND command.causation_id = source_action.completed_event_id
              AND command.actor_type = 'system'::command_actor_type
              AND command.actor_id = 'worldgraph:commerce-scheduler'
          )
          AND (policy.applicability ->> 'payerEntityId')::uuid = assessment.payer_entity_id
          AND (policy.applicability ->> 'payerWalletId')::uuid = assessment.payer_wallet_id
          AND CASE
            WHEN (policy.applicability ->> 'intervalTicks')::numeric
                > 9223372036854775807::numeric - assessment.occurred_tick THEN
              NOT EXISTS (
                SELECT 1 FROM public.scheduled_actions recurrence
                WHERE recurrence.world_id = assessment.world_id
                  AND recurrence.created_command_id = assessment.command_id
                  AND recurrence.action_type = 'AssessPeriodicTaxV1'
              )
            WHEN policy.status = 'active'::tax_policy_status
              AND (policy.effective_until_tick IS NULL OR
                assessment.occurred_tick
                  + (policy.applicability ->> 'intervalTicks')::bigint
                    < policy.effective_until_tick) THEN
              (SELECT count(*) FROM public.scheduled_actions recurrence
                WHERE recurrence.world_id = assessment.world_id
                  AND recurrence.created_command_id = assessment.command_id
                  AND recurrence.action_type = 'AssessPeriodicTaxV1'
                  AND recurrence.payload = jsonb_build_object(
                    'taxPolicyId', policy.id::text
                  )
                  AND recurrence.due_tick = assessment.occurred_tick
                    + (policy.applicability ->> 'intervalTicks')::bigint
              ) = 1
            ELSE
              NOT EXISTS (
                SELECT 1 FROM public.scheduled_actions recurrence
                WHERE recurrence.world_id = assessment.world_id
                  AND recurrence.created_command_id = assessment.command_id
                  AND recurrence.action_type = 'AssessPeriodicTaxV1'
              )
          END
        )
      )
  ) THEN
    RAISE EXCEPTION 'tax assessment does not match its policy, parties, or settlement'
      USING ERRCODE = '23514', CONSTRAINT = 'tax_assessment_settlement_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER resource_types_require_exact_association
  AFTER INSERT ON resource_types DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER production_recipe_versions_require_exact_association
  AFTER INSERT ON production_recipe_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER businesses_require_exact_association
  AFTER INSERT OR UPDATE ON businesses DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER business_facilities_require_exact_association
  AFTER INSERT OR UPDATE ON business_facilities DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER business_facility_recipes_require_exact_association
  AFTER INSERT ON business_facility_recipe_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER production_runs_require_exact_association
  AFTER INSERT OR UPDATE ON production_runs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER employment_offers_require_exact_association
  AFTER INSERT ON employment_offers DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER employment_contracts_require_exact_association
  AFTER INSERT OR UPDATE ON employment_contracts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payroll_records_require_exact_association
  AFTER INSERT OR UPDATE ON payroll_records DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tax_policies_require_exact_association
  AFTER INSERT ON tax_policies DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER inventory_movements_require_exact_association
  AFTER INSERT ON inventory_movements DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER market_listings_require_exact_association
  AFTER INSERT OR UPDATE ON market_listings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER market_trades_require_exact_association
  AFTER INSERT ON market_trades DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tax_assessments_require_exact_association
  AFTER INSERT ON tax_assessments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_association();
--> statement-breakpoint
CREATE FUNCTION worldgraph_economy_expansion_initial_projection_checksum(
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
    public.worldgraph_economy_expansion_projection_document(checked_world_id),
    '{seed}',
    jsonb_build_object(
      'seedPlanHash', encode(checked_seed_plan_hash, 'hex'),
      'sourceWorldVersionId', checked_world_version_id::text
    )
  )
), 'UTF8'), 'sha256');
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_economy_expansion_initial_projection_checksum(uuid,uuid,bytea)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_materialize_world_commerce(
  checked_world_id uuid,
  checked_world_version_id uuid,
  checked_plan_hash bytea,
  checked_command_id uuid,
  checked_event_id uuid,
  checked_state_revision bigint,
  checked_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  plan_record record;
  plan_value jsonb;
  currency_record record;
  initialization_transaction_id uuid;
  checksum_value bytea;
  current_tick_value bigint;
  resource_count integer;
  recipe_count integer;
  inventory_count integer;
  business_count integer;
  facility_count integer;
  offer_count integer;
  policy_count integer;
  organization_wallet_delta_total integer;
  organization_wallet_delta_existing integer;
  organization_wallet_delta_appended integer := 0;
  workshop_asset_delta_total integer;
  workshop_asset_delta_existing integer;
  workshop_asset_delta_appended integer := 0;
  updated_count integer;
BEGIN
  IF checked_world_id IS NULL OR checked_world_version_id IS NULL
    OR checked_plan_hash IS NULL OR octet_length(checked_plan_hash) <> 32
    OR checked_command_id IS NULL OR checked_event_id IS NULL
    OR checked_state_revision <= 0 OR checked_occurred_at IS NULL
    OR checked_occurred_at <> date_trunc('milliseconds', checked_occurred_at) THEN
    RAISE EXCEPTION 'commerce materialization arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF public.worldgraph_commerce_command_type(checked_world_id)
      IS DISTINCT FROM 'InitializeWorldCommerceV1'
    OR checked_command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    OR NOT EXISTS (
      SELECT 1 FROM public.command_records command
      WHERE command.id = checked_command_id AND command.world_id = checked_world_id
        AND command.command_type = 'InitializeWorldCommerceV1'
        AND command.status = 'received'::command_record_status
        AND (command.payload IS NULL OR command.payload = jsonb_build_object(
          'compiledWorldVersionId', checked_world_version_id::text,
          'seedPlanHash', encode(checked_plan_hash, 'hex')
        ))
        AND command.payload_hash = extensions.digest(convert_to(
          public.worldgraph_canonical_jsonb(jsonb_build_object(
            'compiledWorldVersionId', checked_world_version_id::text,
            'seedPlanHash', encode(checked_plan_hash, 'hex')
          )),
          'UTF8'
        ), 'sha256')
    ) THEN
    RAISE EXCEPTION 'commerce materialization requires its exact open initialization command'
      USING ERRCODE = '55000';
  END IF;
  IF public.worldgraph_economy_expansion_runtime_state_exists(checked_world_id) THEN
    RAISE EXCEPTION 'world commerce is already initialized' USING ERRCODE = '55000';
  END IF;
  PERFORM public.worldgraph_assert_economy_projection_current(checked_world_id);

  SELECT plan.*, version.status AS world_version_status,
         version.compiler_version, version.compiler_config_version,
         artifact.artifact_schema_version, artifact.canonical_content,
         artifact.content_hash
    INTO plan_record
    FROM public.compiled_economy_seed_plans plan
    JOIN public.world_versions version
      ON version.id = plan.world_version_id AND version.world_id = plan.world_id
    JOIN public.compiled_world_artifacts artifact
      ON artifact.id = plan.source_artifact_id
     AND artifact.world_id = plan.world_id
     AND artifact.compilation_run_id = plan.compilation_run_id
    WHERE plan.world_id = checked_world_id
      AND plan.world_version_id = checked_world_version_id
      AND plan.plan_hash = checked_plan_hash
      AND plan.seed_plan_schema_version = 2
      AND plan.source_kind::text = 'compiler_1_2'
      AND plan.source_compiler_version = '1.2.0'
      AND plan.source_adapter_id = 'CompiledEconomySeedAdapterV2'
      AND plan.source_adapter_version = '1.0.0'
      AND version.compiler_version = '1.2.0'
      AND version.compiler_config_version = 1
      AND artifact.artifact_kind = 'compiled_world'
      AND artifact.artifact_schema_version = 3
      AND artifact.content_hash = plan.source_artifact_hash
      AND artifact.canonical_content -> 'economySeedPlan' = plan.canonical_plan
      AND artifact.canonical_content ->> 'economySeedPlanHash' = encode(plan.plan_hash,'hex');
  IF NOT FOUND OR plan_record.world_version_status NOT IN (
      'active'::world_version_status, 'superseded'::world_version_status
    ) OR NOT public.worldgraph_economy_seed_plan_v2_is_valid(plan_record.canonical_plan) THEN
    RAISE EXCEPTION 'commerce initialization requires an exact compiler 1.2 artifact-3 plan-2'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_seed_plan_provenance_exact';
  END IF;
  plan_value := plan_record.canonical_plan;

  SELECT currency.* INTO currency_record
  FROM public.currencies currency
  JOIN public.world_entities issuer
    ON issuer.world_id = currency.world_id AND issuer.id = currency.issuer_entity_id
  WHERE currency.world_id = checked_world_id
    AND currency.stable_key::text = plan_value -> 'currency' ->> 'stableKey'
    AND currency.code::text = plan_value -> 'currency' ->> 'code'
    AND currency.name = plan_value -> 'currency' ->> 'name'
    AND currency.minor_unit_scale = (plan_value -> 'currency' ->> 'minorUnitScale')::smallint
    AND currency.max_supply_minor = (plan_value -> 'currency' ->> 'maxSupplyMinor')::bigint
    AND currency.currency_schema_version = 1
    AND issuer.logical_key::text = plan_value -> 'currency' ->> 'issuerEntityLogicalKey';
  IF NOT FOUND OR (SELECT count(*) FROM public.currencies WHERE world_id = checked_world_id) <> 1 THEN
    RAISE EXCEPTION 'M08 currency core is absent or incompatible with commerce plan'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_m08_currency_compatible';
  END IF;
  SELECT transaction.id INTO initialization_transaction_id
  FROM public.world_economy_heads head
  JOIN public.financial_transactions transaction
    ON transaction.world_id = head.world_id
   AND transaction.command_id = head.initialized_command_id
   AND transaction.event_id = head.initialized_event_id
  WHERE head.world_id = checked_world_id
    AND transaction.transaction_kind = 'initialization'::financial_transaction_kind
    AND transaction.currency_id = currency_record.id
    AND transaction.supply_delta_minor = (plan_value ->> 'initialSupplyMinor')::bigint;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M08 initialization journal is absent or incompatible with commerce plan'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_m08_initial_journal_compatible';
  END IF;
  SELECT clock.current_tick INTO current_tick_value
  FROM public.world_simulation_clocks clock WHERE clock.world_id = checked_world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce initialization requires an initialized simulation clock'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_simulation_clock_required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(plan_value -> 'wallets') wallet_plan
    LEFT JOIN public.world_entities owner
      ON owner.world_id = checked_world_id
     AND owner.logical_key::text = wallet_plan ->> 'ownerEntityLogicalKey'
    LEFT JOIN public.wallets wallet
      ON wallet.world_id = checked_world_id
     AND wallet.stable_key::text = wallet_plan ->> 'stableKey'
    WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(plan_value -> 'businesses') business_plan
        WHERE business_plan ->> 'walletStableKey' = wallet_plan ->> 'stableKey'
      ) AND (owner.id IS NULL OR wallet.id IS NULL
      OR wallet.owner_entity_id IS DISTINCT FROM owner.id
      OR wallet.currency_id IS DISTINCT FROM currency_record.id
      OR wallet.wallet_kind::text IS DISTINCT FROM wallet_plan ->> 'walletKind'
      OR wallet.wallet_schema_version IS DISTINCT FROM 1
      OR NOT (
        ((wallet_plan ->> 'initialBalanceMinor')::bigint = 0 AND NOT EXISTS (
          SELECT 1 FROM public.wallet_postings posting
          WHERE posting.transaction_id = initialization_transaction_id
            AND posting.wallet_id = wallet.id
        )) OR EXISTS (
          SELECT 1 FROM public.wallet_postings posting
          WHERE posting.transaction_id = initialization_transaction_id
            AND posting.wallet_id = wallet.id
            AND posting.signed_amount_minor =
              (wallet_plan ->> 'initialBalanceMinor')::bigint
        )
      ))
  ) OR EXISTS (
    SELECT 1 FROM public.wallets wallet
    WHERE wallet.world_id = checked_world_id AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(plan_value -> 'wallets') wallet_plan
      WHERE wallet_plan ->> 'stableKey' = wallet.stable_key::text
    )
  ) THEN
    RAISE EXCEPTION 'M08 wallet core is absent or incompatible with commerce plan'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_m08_wallets_compatible';
  END IF;
  SELECT count(*), count(wallet.id)
    INTO organization_wallet_delta_total, organization_wallet_delta_existing
  FROM jsonb_array_elements(plan_value -> 'businesses') business_plan
  JOIN jsonb_array_elements(plan_value -> 'wallets') wallet_plan
    ON wallet_plan ->> 'stableKey' = business_plan ->> 'walletStableKey'
  LEFT JOIN public.wallets wallet
    ON wallet.world_id = checked_world_id
   AND wallet.stable_key::text = wallet_plan ->> 'stableKey';
  IF organization_wallet_delta_total <> jsonb_array_length(plan_value -> 'businesses')
    OR organization_wallet_delta_existing NOT IN (0, organization_wallet_delta_total)
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(plan_value -> 'businesses') business_plan
      JOIN jsonb_array_elements(plan_value -> 'wallets') wallet_plan
        ON wallet_plan ->> 'stableKey' = business_plan ->> 'walletStableKey'
      LEFT JOIN public.world_entities organization
        ON organization.world_id = checked_world_id
       AND organization.logical_key::text = business_plan ->> 'organizationEntityLogicalKey'
      LEFT JOIN public.wallets wallet
        ON wallet.world_id = checked_world_id
       AND wallet.stable_key::text = wallet_plan ->> 'stableKey'
      LEFT JOIN public.wallet_balances balance
        ON balance.world_id = checked_world_id AND balance.wallet_id = wallet.id
      WHERE organization.id IS NULL
        OR wallet_plan ->> 'walletKind' IS DISTINCT FROM 'organization'
        OR wallet_plan ->> 'initialBalanceMinor' IS DISTINCT FROM '0'
        OR wallet_plan ->> 'ownerEntityLogicalKey'
          IS DISTINCT FROM business_plan ->> 'organizationEntityLogicalKey'
        OR (wallet.id IS NOT NULL AND (
          wallet.owner_entity_id IS DISTINCT FROM organization.id
          OR wallet.currency_id IS DISTINCT FROM currency_record.id
          OR wallet.wallet_kind IS DISTINCT FROM 'organization'::wallet_kind
          OR wallet.wallet_schema_version IS DISTINCT FROM 1
          OR balance.available_minor IS DISTINCT FROM 0
        ))
    ) THEN
    RAISE EXCEPTION 'M08 organization-wallet delta is partial or incompatible'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_m08_wallet_delta_compatible';
  END IF;
  IF organization_wallet_delta_existing = 0 THEN
    INSERT INTO public.wallets(
      id, world_id, currency_id, stable_key, owner_entity_id, wallet_kind,
      status, wallet_schema_version, row_version, created_event_id,
      created_at, updated_at
    )
    SELECT extensions.gen_random_uuid(), checked_world_id, currency_record.id,
           wallet_plan ->> 'stableKey', organization.id,
           'organization'::wallet_kind, 'active'::wallet_status, 1, 1,
           checked_event_id, checked_occurred_at, checked_occurred_at
    FROM jsonb_array_elements(plan_value -> 'businesses') business_plan
    JOIN jsonb_array_elements(plan_value -> 'wallets') wallet_plan
      ON wallet_plan ->> 'stableKey' = business_plan ->> 'walletStableKey'
    JOIN public.world_entities organization
      ON organization.world_id = checked_world_id
     AND organization.logical_key::text = business_plan ->> 'organizationEntityLogicalKey';
    GET DIAGNOSTICS organization_wallet_delta_appended = ROW_COUNT;
    INSERT INTO public.wallet_balances(
      wallet_id, world_id, currency_id, available_minor, row_version,
      updated_state_revision, updated_at
    )
    SELECT wallet.id, checked_world_id, currency_record.id, 0, 1,
           checked_state_revision, checked_occurred_at
    FROM public.wallets wallet
    JOIN jsonb_array_elements(plan_value -> 'businesses') business_plan
      ON business_plan ->> 'walletStableKey' = wallet.stable_key::text
    WHERE wallet.world_id = checked_world_id;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(plan_value -> 'assets') asset_plan
    LEFT JOIN public.assets asset
      ON asset.world_id = checked_world_id
     AND asset.stable_key::text = asset_plan ->> 'stableKey'
    LEFT JOIN public.world_entities linked_entity
      ON linked_entity.world_id = asset.world_id AND linked_entity.id = asset.world_entity_id
    LEFT JOIN public.world_entities initial_owner
      ON initial_owner.world_id = checked_world_id
     AND initial_owner.logical_key::text = asset_plan ->> 'initialOwnerEntityLogicalKey'
    WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(plan_value -> 'facilities') facility_plan
        WHERE facility_plan ->> 'assetStableKey' = asset_plan ->> 'stableKey'
      ) AND (asset.id IS NULL OR initial_owner.id IS NULL
      OR asset.asset_type IS DISTINCT FROM asset_plan ->> 'assetType'
      OR asset.asset_schema_version IS DISTINCT FROM 1
      OR asset.metadata IS DISTINCT FROM asset_plan -> 'metadata'
      OR asset.transferable IS DISTINCT FROM (asset_plan ->> 'transferable')::boolean
      OR linked_entity.logical_key::text IS DISTINCT FROM
        NULLIF(asset_plan ->> 'worldEntityLogicalKey','')
      OR NOT EXISTS (
        SELECT 1 FROM public.asset_transfers transfer
        WHERE transfer.world_id = checked_world_id AND transfer.asset_id = asset.id
          AND transfer.transfer_kind = 'initial'::asset_transfer_kind
          AND transfer.from_owner_entity_id IS NULL
          AND transfer.to_owner_entity_id = initial_owner.id
      ))
  ) OR EXISTS (
    SELECT 1 FROM public.assets asset
    WHERE asset.world_id = checked_world_id AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(plan_value -> 'assets') asset_plan
      WHERE asset_plan ->> 'stableKey' = asset.stable_key::text
    )
  ) THEN
    RAISE EXCEPTION 'M08 asset core is absent or incompatible with commerce plan'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_m08_assets_compatible';
  END IF;
  SELECT count(*), count(asset.id)
    INTO workshop_asset_delta_total, workshop_asset_delta_existing
  FROM jsonb_array_elements(plan_value -> 'facilities') facility_plan
  JOIN jsonb_array_elements(plan_value -> 'assets') asset_plan
    ON asset_plan ->> 'stableKey' = facility_plan ->> 'assetStableKey'
  LEFT JOIN public.assets asset
    ON asset.world_id = checked_world_id
   AND asset.stable_key::text = asset_plan ->> 'stableKey';
  IF workshop_asset_delta_total <> jsonb_array_length(plan_value -> 'facilities')
    OR workshop_asset_delta_existing NOT IN (0, workshop_asset_delta_total)
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(plan_value -> 'facilities') facility_plan
      JOIN jsonb_array_elements(plan_value -> 'assets') asset_plan
        ON asset_plan ->> 'stableKey' = facility_plan ->> 'assetStableKey'
      JOIN jsonb_array_elements(plan_value -> 'businesses') business_plan
        ON business_plan ->> 'stableKey' = facility_plan ->> 'businessStableKey'
      LEFT JOIN public.world_entities organization
        ON organization.world_id = checked_world_id
       AND organization.logical_key::text = business_plan ->> 'organizationEntityLogicalKey'
      LEFT JOIN public.assets asset
        ON asset.world_id = checked_world_id
       AND asset.stable_key::text = asset_plan ->> 'stableKey'
      LEFT JOIN public.asset_ownership ownership
        ON ownership.world_id = checked_world_id AND ownership.asset_id = asset.id
      WHERE organization.id IS NULL
        OR asset_plan ->> 'assetType' IS DISTINCT FROM 'workshop'
        OR asset_plan ->> 'initialOwnerEntityLogicalKey'
          IS DISTINCT FROM business_plan ->> 'organizationEntityLogicalKey'
        OR asset_plan -> 'worldEntityLogicalKey' IS DISTINCT FROM 'null'::jsonb
        OR (asset.id IS NOT NULL AND (
          asset.asset_type IS DISTINCT FROM asset_plan ->> 'assetType'
          OR asset.asset_schema_version IS DISTINCT FROM 1
          OR asset.metadata IS DISTINCT FROM asset_plan -> 'metadata'
          OR asset.transferable IS DISTINCT FROM (asset_plan ->> 'transferable')::boolean
          OR asset.world_entity_id IS NOT NULL
          OR ownership.owner_entity_id IS DISTINCT FROM organization.id
        ))
    ) THEN
    RAISE EXCEPTION 'M08 workshop-asset delta is partial or incompatible'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_m08_asset_delta_compatible';
  END IF;
  IF workshop_asset_delta_existing = 0 THEN
    INSERT INTO public.assets(
      id, world_id, stable_key, asset_type, world_entity_id,
      asset_schema_version, metadata, transferable, status,
      created_event_id, created_at
    )
    SELECT extensions.gen_random_uuid(), checked_world_id,
           asset_plan ->> 'stableKey', asset_plan ->> 'assetType', NULL, 1,
           asset_plan -> 'metadata', (asset_plan ->> 'transferable')::boolean,
           'active'::asset_status, checked_event_id, checked_occurred_at
    FROM jsonb_array_elements(plan_value -> 'facilities') facility_plan
    JOIN jsonb_array_elements(plan_value -> 'assets') asset_plan
      ON asset_plan ->> 'stableKey' = facility_plan ->> 'assetStableKey';
    GET DIAGNOSTICS workshop_asset_delta_appended = ROW_COUNT;
    INSERT INTO public.asset_ownership(
      asset_id, world_id, owner_entity_id, ownership_version,
      acquired_event_id, updated_state_revision, updated_at
    )
    SELECT asset.id, checked_world_id, organization.id, 1, checked_event_id,
           checked_state_revision, checked_occurred_at
    FROM jsonb_array_elements(plan_value -> 'facilities') facility_plan
    JOIN jsonb_array_elements(plan_value -> 'assets') asset_plan
      ON asset_plan ->> 'stableKey' = facility_plan ->> 'assetStableKey'
    JOIN jsonb_array_elements(plan_value -> 'businesses') business_plan
      ON business_plan ->> 'stableKey' = facility_plan ->> 'businessStableKey'
    JOIN public.assets asset
      ON asset.world_id = checked_world_id
     AND asset.stable_key::text = asset_plan ->> 'stableKey'
    JOIN public.world_entities organization
      ON organization.world_id = checked_world_id
     AND organization.logical_key::text = business_plan ->> 'organizationEntityLogicalKey';
    INSERT INTO public.asset_transfers(
      id, world_id, asset_id, from_owner_entity_id, to_owner_entity_id,
      transfer_kind, financial_transaction_id, command_id, event_id,
      occurred_tick, state_revision, created_at
    )
    SELECT extensions.gen_random_uuid(), checked_world_id, asset.id, NULL,
           ownership.owner_entity_id, 'initial'::asset_transfer_kind, NULL,
           checked_command_id, checked_event_id, current_tick_value,
           checked_state_revision, checked_occurred_at
    FROM public.assets asset
    JOIN public.asset_ownership ownership
      ON ownership.world_id = asset.world_id AND ownership.asset_id = asset.id
    JOIN jsonb_array_elements(plan_value -> 'facilities') facility_plan
      ON facility_plan ->> 'assetStableKey' = asset.stable_key::text
    WHERE asset.world_id = checked_world_id;
  END IF;
  UPDATE public.world_economy_heads head
     SET checksum = public.worldgraph_economy_projection_checksum(checked_world_id),
         row_version = head.row_version + 1,
         updated_state_revision = checked_state_revision,
         reconciliation_status = 'pending'::economy_reconciliation_status,
         last_reconciled_state_revision = NULL,
         last_reconciliation_run_id = NULL,
         updated_at = checked_occurred_at
   WHERE head.world_id = checked_world_id
     AND head.updated_state_revision < checked_state_revision;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION 'M08 economy head did not advance for commerce initialization'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.resource_types(
    id, world_id, stable_key, display_name, unit_code, quantity_scale, tags,
    primitive_ref, primitive_key, primitive_version,
    primitive_version_id, primitive_content_hash,
    source_world_version_id, source_plan_hash, resource_schema_version,
    status, created_command_id, created_event_id, created_state_revision, created_at
  )
  SELECT extensions.gen_random_uuid(), checked_world_id, item ->> 'stableKey',
         item ->> 'displayName', item ->> 'unit', (item ->> 'quantityScale')::smallint,
         ARRAY(SELECT jsonb_array_elements_text(item -> 'tags')),
         item ->> 'primitiveRef', item ->> 'primitiveKey', item ->> 'primitiveVersion',
         (item ->> 'primitiveVersionId')::uuid, decode(item ->> 'primitiveContentHash','hex'),
         checked_world_version_id, checked_plan_hash, 1,
         'active'::resource_type_status, checked_command_id, checked_event_id,
         checked_state_revision, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'resources') item;
  GET DIAGNOSTICS resource_count = ROW_COUNT;

  INSERT INTO public.production_recipes(
    id, world_id, stable_key, display_name, source_world_version_id,
    source_plan_hash, recipe_schema_version, status, created_command_id,
    created_event_id, created_state_revision, created_at
  )
  SELECT extensions.gen_random_uuid(), checked_world_id, item ->> 'stableKey',
         version.display_name, checked_world_version_id, checked_plan_hash, 1,
         'active'::resource_type_status, checked_command_id, checked_event_id,
         checked_state_revision, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'recipeVersions') item
  JOIN public.primitive_versions version ON version.id = (item ->> 'primitiveVersionId')::uuid;
  GET DIAGNOSTICS recipe_count = ROW_COUNT;

  INSERT INTO public.production_recipe_versions(
    id, world_id, recipe_id, version, recipe_version_schema_version,
    canonical_seed_inputs, canonical_seed_outputs, canonical_inputs,
    canonical_outputs, duration_ticks, facility_requirements,
    primitive_ref, primitive_key, primitive_version, primitive_version_id,
    primitive_content_hash, source_world_version_id, source_plan_hash, checksum,
    created_command_id, created_event_id, created_state_revision, created_at
  )
  SELECT extensions.gen_random_uuid(), checked_world_id, recipe.id,
         (item ->> 'version')::integer, 1, item -> 'inputs', item -> 'outputs',
         (
           SELECT jsonb_agg(jsonb_build_object(
             'quantity', line.value ->> 'quantity',
             'resourceTypeId', resource.id::text
           ) ORDER BY line.ordinality)
           FROM jsonb_array_elements(item -> 'inputs')
             WITH ORDINALITY line(value, ordinality)
           JOIN public.resource_types resource
             ON resource.world_id = checked_world_id
            AND resource.stable_key::text = line.value ->> 'resourceStableKey'
         ),
         (
           SELECT jsonb_agg(jsonb_build_object(
             'quantity', line.value ->> 'quantity',
             'resourceTypeId', resource.id::text
           ) ORDER BY line.ordinality)
           FROM jsonb_array_elements(item -> 'outputs')
             WITH ORDINALITY line(value, ordinality)
           JOIN public.resource_types resource
             ON resource.world_id = checked_world_id
            AND resource.stable_key::text = line.value ->> 'resourceStableKey'
         ),
         (item ->> 'durationTicks')::bigint,
         jsonb_build_object('assetType',item ->> 'facilityAssetType'),
         item ->> 'primitiveRef', item ->> 'primitiveKey', item ->> 'primitiveVersion',
         (item ->> 'primitiveVersionId')::uuid, decode(item ->> 'primitiveContentHash','hex'),
         checked_world_version_id, checked_plan_hash, decode(item ->> 'checksum','hex'),
         checked_command_id, checked_event_id, checked_state_revision, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'recipeVersions') item
  JOIN public.production_recipes recipe
    ON recipe.world_id = checked_world_id
   AND recipe.stable_key::text = item ->> 'stableKey';

  INSERT INTO public.inventories(
    id, world_id, stable_key, owner_entity_id, container_asset_id,
    resource_type_id, quantity, reserved_quantity, inventory_schema_version,
    row_version, updated_state_revision, created_command_id, created_event_id,
    created_at, updated_at
  )
  SELECT extensions.gen_random_uuid(), checked_world_id, item ->> 'stableKey',
         owner.id, container.id, resource.id, (item ->> 'quantity')::numeric,
         0, 1, 1, checked_state_revision, checked_command_id, checked_event_id,
         checked_occurred_at, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'inventories') item
  JOIN public.world_entities owner
    ON owner.world_id = checked_world_id
   AND owner.logical_key::text = item ->> 'ownerEntityLogicalKey'
  JOIN public.resource_types resource
    ON resource.world_id = checked_world_id
   AND resource.stable_key::text = item ->> 'resourceStableKey'
  LEFT JOIN public.assets container
    ON container.world_id = checked_world_id
   AND container.stable_key::text = item ->> 'containerAssetStableKey';
  GET DIAGNOSTICS inventory_count = ROW_COUNT;

  INSERT INTO public.inventory_movements(
    id, world_id, resource_type_id, from_inventory_id, to_inventory_id,
    quantity, movement_kind, source_type, source_id, source_ordinal,
    command_id, event_id, occurred_tick, state_revision, created_at
  )
  SELECT extensions.gen_random_uuid(), inventory.world_id, inventory.resource_type_id,
         NULL, inventory.id, inventory.quantity, 'initial'::inventory_movement_kind,
         'commerce_initialization', checked_command_id, (ordered.ordinality - 1)::integer,
         checked_command_id, checked_event_id, current_tick_value,
         checked_state_revision, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'inventories') WITH ORDINALITY ordered(item, ordinality)
  JOIN public.inventories inventory
    ON inventory.world_id = checked_world_id
   AND inventory.stable_key::text = ordered.item ->> 'stableKey'
  WHERE inventory.quantity > 0;

  INSERT INTO public.businesses(
    id, world_id, stable_key, display_name, backing_organization_entity_id,
    wallet_id, currency_id, status, metadata, business_schema_version,
    row_version, created_command_id, created_event_id, created_state_revision,
    updated_state_revision, created_at, updated_at
  )
  SELECT extensions.gen_random_uuid(), checked_world_id, item ->> 'stableKey',
         item ->> 'displayName', organization.id, wallet.id, wallet.currency_id,
         (item ->> 'status')::business_status, '{}'::jsonb, 1, 1,
         checked_command_id, checked_event_id, checked_state_revision,
         checked_state_revision, checked_occurred_at, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'businesses') item
  JOIN public.world_entities organization
    ON organization.world_id = checked_world_id
   AND organization.logical_key::text = item ->> 'organizationEntityLogicalKey'
  JOIN public.wallets wallet
    ON wallet.world_id = checked_world_id
   AND wallet.stable_key::text = item ->> 'walletStableKey';
  GET DIAGNOSTICS business_count = ROW_COUNT;

  INSERT INTO public.business_facilities(
    id, world_id, stable_key, business_id, facility_asset_id,
    facility_schema_version, status, row_version, created_command_id,
    created_event_id, created_state_revision, updated_state_revision,
    created_at, updated_at
  )
  SELECT extensions.gen_random_uuid(), checked_world_id, item ->> 'stableKey',
         business.id, asset.id, 1, (item ->> 'status')::business_facility_status,
         1, checked_command_id, checked_event_id, checked_state_revision,
         checked_state_revision, checked_occurred_at, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'facilities') item
  JOIN public.businesses business
    ON business.world_id = checked_world_id
   AND business.stable_key::text = item ->> 'businessStableKey'
  JOIN public.assets asset
    ON asset.world_id = checked_world_id
   AND asset.stable_key::text = item ->> 'assetStableKey';
  GET DIAGNOSTICS facility_count = ROW_COUNT;

  INSERT INTO public.business_facility_recipe_versions(
    world_id, facility_id, recipe_version_id,
    configured_command_id, configured_event_id, created_at
  )
  SELECT checked_world_id, facility.id, recipe_version.id,
         checked_command_id, checked_event_id, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'facilities') facility_plan
  JOIN public.business_facilities facility
    ON facility.world_id = checked_world_id
   AND facility.stable_key::text = facility_plan ->> 'stableKey'
  CROSS JOIN LATERAL jsonb_array_elements_text(
    facility_plan -> 'recipeVersionStableKeys'
  ) recipe_key
  JOIN public.production_recipes recipe
    ON recipe.world_id = checked_world_id AND recipe.stable_key::text = recipe_key
  JOIN public.production_recipe_versions recipe_version
    ON recipe_version.world_id = recipe.world_id AND recipe_version.recipe_id = recipe.id;

  INSERT INTO public.employment_offers(
    id, world_id, stable_key, business_id, role_code, wage_minor,
    currency_id, cadence_ticks, max_payments_per_period, status,
    source_world_version_id, source_plan_hash, employment_offer_schema_version,
    row_version, created_command_id, created_event_id, created_state_revision,
    created_at, updated_at
  )
  SELECT extensions.gen_random_uuid(), checked_world_id, item ->> 'stableKey',
         business.id, item ->> 'roleKey', (item ->> 'wageMinor')::bigint,
         currency_record.id, (item ->> 'cadenceTicks')::bigint,
         (item ->> 'maxPaymentsPerPeriod')::integer,
         (item ->> 'status')::employment_offer_status,
         checked_world_version_id, checked_plan_hash, 1, 1,
         checked_command_id, checked_event_id, checked_state_revision,
         checked_occurred_at, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'employmentOffers') item
  JOIN public.businesses business
    ON business.world_id = checked_world_id
   AND business.stable_key::text = item ->> 'businessStableKey';
  GET DIAGNOSTICS offer_count = ROW_COUNT;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(plan_value -> 'taxPolicies') item
    WHERE item ->> 'taxType' = 'periodic_flat'
      AND CASE
        WHEN item ->> 'intervalTicks' ~ '^[1-9][0-9]{0,18}$' THEN
          current_tick_value::numeric + (item ->> 'intervalTicks')::numeric
            > 9223372036854775807::numeric
        ELSE true
      END
  ) THEN
    RAISE EXCEPTION 'periodic tax bootstrap tick is invalid or overflows bigint'
      USING ERRCODE = '22003', CONSTRAINT = 'periodic_tax_bootstrap_tick_safe';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(plan_value -> 'taxPolicies') item
    WHERE item ->> 'taxType' = 'periodic_flat'
      AND item ->> 'status' = 'active'
      AND item -> 'effectiveUntilTick' <> 'null'::jsonb
      AND greatest(
        (item ->> 'effectiveFromTick')::numeric,
        current_tick_value::numeric + (item ->> 'intervalTicks')::numeric
      ) >= (item ->> 'effectiveUntilTick')::numeric
  ) THEN
    RAISE EXCEPTION 'active periodic tax policy has no in-window bootstrap occurrence'
      USING ERRCODE = '23514', CONSTRAINT = 'periodic_tax_bootstrap_window_valid';
  END IF;
  IF (SELECT count(*) FROM public.scheduled_actions action
      WHERE action.world_id = checked_world_id
        AND action.status = 'scheduled'::scheduled_action_status)
      + (SELECT count(*) FROM jsonb_array_elements(plan_value -> 'taxPolicies') item
         WHERE item ->> 'taxType' = 'periodic_flat'
           AND item ->> 'status' = 'active') > 10000
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT greatest(
          (item ->> 'effectiveFromTick')::numeric,
          current_tick_value::numeric + (item ->> 'intervalTicks')::numeric
        ) due_tick
        FROM jsonb_array_elements(plan_value -> 'taxPolicies') item
        WHERE item ->> 'taxType' = 'periodic_flat'
          AND item ->> 'status' = 'active'
      ) bootstrap
      GROUP BY bootstrap.due_tick
      HAVING count(*) + (
        SELECT count(*)
        FROM public.scheduled_actions action
        WHERE action.world_id = checked_world_id
          AND action.status = 'scheduled'::scheduled_action_status
          AND action.due_tick::numeric = bootstrap.due_tick
      ) > 31
    ) THEN
    RAISE EXCEPTION 'periodic tax bootstrap exceeds scheduled action capacity'
      USING ERRCODE = '54000', CONSTRAINT = 'scheduled_action_capacity_bounded';
  END IF;

  INSERT INTO public.tax_policies(
    id, world_id, stable_key, policy_version, authority_entity_id,
    treasury_wallet_id, currency_id, tax_type, collection_mode, rounding_mode,
    rate_basis_points, fixed_amount_minor, applicability, effective_from_tick,
    effective_until_tick, primitive_ref, primitive_key, primitive_version,
    primitive_version_id, primitive_content_hash, source_world_version_id,
    source_plan_hash, status, calculation_version, tax_policy_schema_version,
    checksum, created_command_id, created_event_id, created_state_revision, created_at
  )
  SELECT extensions.gen_random_uuid(), checked_world_id, item ->> 'stableKey', 1,
         authority.id, treasury.id, currency_record.id,
         (item ->> 'taxType')::tax_policy_type,
         (item ->> 'collectionMode')::tax_collection_mode, item ->> 'roundingMode',
         CASE WHEN item ? 'rateBps' THEN (item ->> 'rateBps')::integer ELSE NULL END,
         CASE WHEN item ? 'fixedAmountMinor'
           THEN (item ->> 'fixedAmountMinor')::bigint ELSE NULL END,
         CASE WHEN item ->> 'taxType' = 'periodic_flat' THEN jsonb_build_object(
           'intervalTicks', item ->> 'intervalTicks',
           'payerEntityId', payer.id::text,
           'payerWalletId', payer_wallet.id::text
         ) ELSE '{}'::jsonb END,
         (item ->> 'effectiveFromTick')::bigint,
         CASE WHEN item -> 'effectiveUntilTick' = 'null'::jsonb THEN NULL
           ELSE (item ->> 'effectiveUntilTick')::bigint END,
         item ->> 'primitiveRef', item ->> 'primitiveKey', item ->> 'primitiveVersion',
         (item ->> 'primitiveVersionId')::uuid,
         decode(item ->> 'primitiveContentHash','hex'), checked_world_version_id,
         checked_plan_hash, (item ->> 'status')::tax_policy_status, 1, 1,
         extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
           'domain','worldgraph.tax-policy.v1','policy',item
         )),'UTF8'),'sha256'), checked_command_id, checked_event_id,
         checked_state_revision, checked_occurred_at
  FROM jsonb_array_elements(plan_value -> 'taxPolicies') item
  JOIN public.world_entities authority
    ON authority.world_id = checked_world_id
   AND authority.logical_key::text = item ->> 'authorityEntityLogicalKey'
  JOIN public.wallets treasury
    ON treasury.world_id = checked_world_id
   AND treasury.stable_key::text = item ->> 'treasuryWalletStableKey'
  LEFT JOIN public.world_entities payer
    ON item ->> 'taxType' = 'periodic_flat'
   AND payer.world_id = checked_world_id
   AND payer.logical_key::text = item ->> 'payerEntityLogicalKey'
  LEFT JOIN public.wallets payer_wallet
    ON item ->> 'taxType' = 'periodic_flat'
   AND payer_wallet.world_id = checked_world_id
   AND payer_wallet.stable_key::text = item ->> 'payerWalletStableKey'
   AND payer_wallet.owner_entity_id = payer.id
   AND payer_wallet.currency_id = currency_record.id;
  GET DIAGNOSTICS policy_count = ROW_COUNT;

  IF resource_count <> jsonb_array_length(plan_value -> 'resources')
    OR recipe_count <> jsonb_array_length(plan_value -> 'recipeVersions')
    OR inventory_count <> jsonb_array_length(plan_value -> 'inventories')
    OR business_count <> jsonb_array_length(plan_value -> 'businesses')
    OR facility_count <> jsonb_array_length(plan_value -> 'facilities')
    OR offer_count <> jsonb_array_length(plan_value -> 'employmentOffers')
    OR policy_count <> jsonb_array_length(plan_value -> 'taxPolicies') THEN
    RAISE EXCEPTION 'commerce seed references did not materialize one-to-one'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_seed_materialization_cardinality';
  END IF;
  checksum_value := public.worldgraph_economy_expansion_initial_projection_checksum(
    checked_world_id, checked_world_version_id, checked_plan_hash
  );
  INSERT INTO public.world_economy_expansion_heads(
    world_id, source_world_version_id, seed_plan_hash,
    expansion_schema_version, projection_schema_version, checksum, row_version,
    updated_state_revision, initialized_command_id, initialized_event_id,
    reconciliation_status, created_at, updated_at
  ) VALUES (
    checked_world_id, checked_world_version_id, checked_plan_hash,
    1, 1, checksum_value, 1, checked_state_revision, checked_command_id,
    checked_event_id, 'pending'::economy_reconciliation_status,
    checked_occurred_at, checked_occurred_at
  );
  IF checksum_value IS DISTINCT FROM
      public.worldgraph_economy_expansion_projection_checksum(checked_world_id) THEN
    RAISE EXCEPTION 'commerce seed projection checksum is not exact'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_seed_projection_checksum_exact';
  END IF;
  RETURN jsonb_build_object(
    'businessCount', business_count,
    'checksum', encode(checksum_value,'hex'),
    'employmentOfferCount', offer_count,
    'facilityCount', facility_count,
    'inventoryCount', inventory_count,
    'organizationWalletsAppended', organization_wallet_delta_appended,
    'organizationWalletsReused',
      organization_wallet_delta_total - organization_wallet_delta_appended,
    'recipeVersionCount', recipe_count,
    'resourceTypeCount', resource_count,
    'scheduledActions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'actionType', 'AssessPeriodicTaxV1',
        'dueTick', greatest(
          policy.effective_from_tick::numeric,
          current_tick_value::numeric
            + (policy.applicability ->> 'intervalTicks')::numeric
        )::bigint::text,
        'taxPolicyId', policy.id::text
      ) ORDER BY policy.stable_key::text COLLATE "C")
      FROM public.tax_policies policy
      WHERE policy.world_id = checked_world_id
        AND policy.source_world_version_id = checked_world_version_id
        AND policy.source_plan_hash = checked_plan_hash
        AND policy.tax_type = 'periodic_flat'::tax_policy_type
        AND policy.status = 'active'::tax_policy_status
    ), '[]'::jsonb),
    'taxPolicyCount', policy_count,
    'workshopAssetsAppended', workshop_asset_delta_appended,
    'workshopAssetsReused',
      workshop_asset_delta_total - workshop_asset_delta_appended
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_materialize_world_commerce(
  uuid,uuid,bytea,uuid,uuid,bigint,timestamptz
) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_wallet()
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
    IF command_type NOT IN ('InitializeWorldEconomyV1','InitializeWorldCommerceV1')
      OR NEW.status <> 'active'::wallet_status OR NEW.row_version <> 1
      OR NEW.closed_at IS NOT NULL
      OR (command_type = 'InitializeWorldCommerceV1'
        AND NEW.wallet_kind <> 'organization'::wallet_kind) THEN
      RAISE EXCEPTION 'wallet creation requires its exact economy initialization'
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
CREATE OR REPLACE FUNCTION worldgraph_protect_economy_projection_row()
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
    IF command_type NOT IN ('InitializeWorldEconomyV1','InitializeWorldCommerceV1')
      OR NEW.row_version <> 1 OR NEW.updated_state_revision <= 0
      OR (command_type = 'InitializeWorldCommerceV1'
        AND TG_TABLE_NAME <> 'wallet_balances') THEN
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
      'PurchaseMarketListingV1','SettlePayrollV1','AssessPeriodicTaxV1',
      'RepairWorldEconomyV1','RepairEconomicProjectionV1'
    ) OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
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
CREATE OR REPLACE FUNCTION worldgraph_protect_asset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE command_type text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'asset identity and typed metadata are immutable'
      USING ERRCODE = '55000';
  END IF;
  command_type := public.worldgraph_economy_open_command_type(NEW.world_id);
  IF command_type NOT IN ('InitializeWorldEconomyV1','InitializeWorldCommerceV1')
    OR NEW.status <> 'active'::asset_status OR NEW.retired_at IS NOT NULL
    OR (command_type = 'InitializeWorldCommerceV1'
      AND (NEW.asset_type <> 'workshop' OR NEW.world_entity_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'asset creation requires its exact economy initialization'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_asset_ownership()
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
    IF command_type NOT IN ('InitializeWorldEconomyV1','InitializeWorldCommerceV1')
      OR NEW.ownership_version <> 1 OR NEW.updated_state_revision <= 0 THEN
      RAISE EXCEPTION 'initial ownership requires economy initialization'
        USING ERRCODE = '55000';
    END IF;
  ELSIF command_type IS NULL
    OR command_type NOT IN (
      'TransferAssetV1','AcceptAssetTransferOfferV1','RepairWorldEconomyV1'
    ) OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
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
CREATE OR REPLACE FUNCTION worldgraph_protect_world_economy_head()
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
      'RepairWorldEconomyV1','InitializeWorldCommerceV1','PurchaseMarketListingV1',
      'SettlePayrollV1','AssessPeriodicTaxV1','RepairEconomicProjectionV1'
    ) OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.economy_schema_version IS DISTINCT FROM OLD.economy_schema_version
    OR NEW.source_world_version_id IS DISTINCT FROM OLD.source_world_version_id
    OR NEW.seed_plan_hash IS DISTINCT FROM OLD.seed_plan_hash
    OR NEW.initialized_command_id IS DISTINCT FROM OLD.initialized_command_id
    OR NEW.initialized_event_id IS DISTINCT FROM OLD.initialized_event_id
    OR NEW.initialized_at IS DISTINCT FROM OLD.initialized_at
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.updated_state_revision <= OLD.updated_state_revision
    OR NEW.updated_at < OLD.updated_at
    OR NEW.checksum IS DISTINCT FROM public.worldgraph_economy_projection_checksum(NEW.world_id)
    OR (command_type NOT IN ('ReconcileWorldEconomyV1') AND NOT (
      NEW.reconciliation_status = 'pending'::economy_reconciliation_status
      AND NEW.last_reconciled_state_revision IS NULL
      AND NEW.last_reconciliation_run_id IS NULL
    )) OR (command_type = 'ReconcileWorldEconomyV1' AND NOT (
      NEW.reconciliation_status IN (
        'current'::economy_reconciliation_status,
        'mismatch'::economy_reconciliation_status
      ) AND NEW.last_reconciled_state_revision IS NOT NULL
      AND NEW.last_reconciliation_run_id IS NOT NULL
    )) THEN
    RAISE EXCEPTION 'economy head update is inconsistent or outside an economy command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_economy_fact()
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
      'AcceptAssetTransferOfferV1','RepairWorldEconomyV1',
      'PurchaseMarketListingV1','SettlePayrollV1','AssessPeriodicTaxV1',
      'RepairEconomicProjectionV1'
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
      'InitializeWorldEconomyV1','InitializeWorldCommerceV1','TransferAssetV1',
      'AcceptAssetTransferOfferV1','RepairWorldEconomyV1'
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
      'RepairWorldEconomyV1','InitializeWorldCommerceV1','CreateBusinessV1',
      'ConfigureBusinessFacilityV1','CreateEmploymentContractV1',
      'AcceptEmploymentContractV1','EndEmploymentContractV1','PerformJobV1',
      'StartProductionRunV1','CompleteProductionRunV1','SettlePayrollV1',
      'CreateMarketListingV1','CancelMarketListingV1','ExpireMarketListingV1',
      'PurchaseMarketListingV1','AssessPeriodicTaxV1','ReconcileWorldCommerceV1',
      'RepairEconomicProjectionV1'
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
CREATE OR REPLACE FUNCTION worldgraph_assert_asset_transfer()
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
            AND ((command.command_type = 'InitializeWorldEconomyV1'
              AND event.event_type = 'WorldEconomyInitializedV1')
              OR (command.command_type = 'InitializeWorldCommerceV1'
                AND event.event_type = 'WorldCommerceInitializedV1')))
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
CREATE OR REPLACE FUNCTION worldgraph_assert_financial_transaction()
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
          WHEN 'PurchaseMarketListingV1' THEN 'MarketTradeCompletedV1'
          WHEN 'SettlePayrollV1' THEN 'PayrollSettledV1'
          WHEN 'AssessPeriodicTaxV1' THEN 'TaxAssessedV1'
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
    OR (command_type = 'PurchaseMarketListingV1' AND NOT (
      transaction_record.transaction_kind::text = 'market_purchase'
      AND transaction_record.supply_delta_minor = 0
      AND posting_count BETWEEN 2 AND 4
      AND EXISTS (
        SELECT 1 FROM public.market_trades trade
        WHERE trade.world_id = transaction_record.world_id
          AND trade.wallet_transaction_id = transaction_record.id
          AND trade.command_id = transaction_record.command_id
          AND trade.event_id = transaction_record.event_id
          AND trade.currency_id = transaction_record.currency_id
      )))
    OR (command_type = 'SettlePayrollV1' AND NOT (
      transaction_record.transaction_kind::text = 'payroll'
      AND transaction_record.supply_delta_minor = 0
      AND posting_count BETWEEN 2 AND 3
      AND EXISTS (
        SELECT 1 FROM public.payroll_records payroll
        WHERE payroll.world_id = transaction_record.world_id
          AND payroll.financial_transaction_id = transaction_record.id
          AND payroll.terminal_command_id = transaction_record.command_id
          AND payroll.terminal_event_id = transaction_record.event_id
          AND payroll.terminal_state_revision = transaction_record.state_revision
          AND payroll.status = 'paid'::payroll_status
      )))
    OR (command_type = 'AssessPeriodicTaxV1' AND NOT (
      transaction_record.transaction_kind::text = 'periodic_tax'
      AND transaction_record.supply_delta_minor = 0
      AND posting_count = 2
      AND EXISTS (
        SELECT 1 FROM public.tax_assessments assessment
        JOIN public.tax_policies policy
          ON policy.world_id = assessment.world_id AND policy.id = assessment.policy_id
        WHERE assessment.world_id = transaction_record.world_id
          AND assessment.settlement_transaction_id = transaction_record.id
          AND assessment.command_id = transaction_record.command_id
          AND assessment.event_id = transaction_record.event_id
          AND assessment.state_revision = transaction_record.state_revision
          AND assessment.currency_id = transaction_record.currency_id
          AND assessment.source_type = 'periodic_tax'
          AND policy.tax_type = 'periodic_flat'::tax_policy_type
      )))
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
      'AcceptAssetTransferOfferV1','PurchaseMarketListingV1','SettlePayrollV1',
      'AssessPeriodicTaxV1','RepairWorldEconomyV1'
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

CREATE FUNCTION worldgraph_protect_commerce_domain_event()
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
    WHEN 'InitializeWorldCommerceV1' THEN NEW.event_type IN (
      'WorldCommerceInitializedV1','ScheduledActionCreatedV1'
    )
    WHEN 'CreateBusinessV1' THEN NEW.event_type = 'BusinessCreatedV1'
    WHEN 'ConfigureBusinessFacilityV1' THEN NEW.event_type = 'BusinessFacilityConfiguredV1'
    WHEN 'CreateEmploymentContractV1' THEN NEW.event_type = 'EmploymentContractCreatedV1'
    WHEN 'AcceptEmploymentContractV1' THEN NEW.event_type = 'EmploymentContractAcceptedV1'
    WHEN 'EndEmploymentContractV1' THEN NEW.event_type = 'EmploymentContractEndedV1'
    WHEN 'PerformJobV1' THEN NEW.event_type IN (
      'WorkRecordedV1','ScheduledActionCreatedV1'
    )
    WHEN 'SettlePayrollV1' THEN NEW.event_type IN ('PayrollSettledV1','PayrollFailedV1')
    WHEN 'StartProductionRunV1' THEN NEW.event_type IN (
      'ProductionRunStartedV1','ScheduledActionCreatedV1'
    )
    WHEN 'CompleteProductionRunV1' THEN NEW.event_type IN (
      'ResourcesConsumedV1','ResourcesProducedV1','ProductionFailedV1'
    )
    WHEN 'CreateMarketListingV1' THEN NEW.event_type IN (
      'MarketListingCreatedV1','ScheduledActionCreatedV1'
    )
    WHEN 'CancelMarketListingV1' THEN NEW.event_type IN (
      'MarketListingCancelledV1','ScheduledActionCancelledV1'
    )
    WHEN 'ExpireMarketListingV1' THEN NEW.event_type = 'MarketListingExpiredV1'
    WHEN 'PurchaseMarketListingV1' THEN NEW.event_type IN (
      'MarketListingPartiallyFilledV1','MarketListingFilledV1',
      'InventoryTransferredV1','MarketTradeCompletedV1','TaxAssessedV1',
      'TreasuryRevenueRecordedV1'
    )
    WHEN 'AssessPeriodicTaxV1' THEN NEW.event_type IN (
      'TaxAssessedV1','TreasuryRevenueRecordedV1','ScheduledActionCreatedV1'
    )
    WHEN 'ReconcileWorldCommerceV1' THEN NEW.event_type = 'WorldCommerceReconciledV1'
    WHEN 'RepairEconomicProjectionV1' THEN NEW.event_type = 'WorldCommerceReconciledV1'
    ELSE false
  END;
  IF command_type IN (
      'InitializeWorldCommerceV1','CreateBusinessV1','ConfigureBusinessFacilityV1',
      'CreateEmploymentContractV1','AcceptEmploymentContractV1',
      'EndEmploymentContractV1','PerformJobV1','SettlePayrollV1',
      'StartProductionRunV1','CompleteProductionRunV1','CreateMarketListingV1',
      'CancelMarketListingV1','ExpireMarketListingV1','PurchaseMarketListingV1',
      'AssessPeriodicTaxV1','ReconcileWorldCommerceV1','RepairEconomicProjectionV1'
    ) AND (NOT COALESCE(event_allowed,false)
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id,NEW.command_id)) THEN
    RAISE EXCEPTION 'commerce command emitted an unsupported or closed event fact'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.event_type IN (
      'WorldCommerceInitializedV1','BusinessCreatedV1','BusinessFacilityConfiguredV1',
      'EmploymentContractCreatedV1','EmploymentContractAcceptedV1',
      'EmploymentContractEndedV1','WorkRecordedV1','PayrollSettledV1','PayrollFailedV1',
      'ProductionRunStartedV1','ResourcesConsumedV1','ResourcesProducedV1',
      'ProductionFailedV1','MarketListingCreatedV1','MarketListingCancelledV1',
      'MarketListingExpiredV1','MarketListingPartiallyFilledV1','MarketListingFilledV1',
      'InventoryTransferredV1','MarketTradeCompletedV1','TaxAssessedV1',
      'TreasuryRevenueRecordedV1','WorldCommerceReconciledV1'
    ) AND (NOT COALESCE(event_allowed,false)
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id,NEW.command_id)) THEN
    RAISE EXCEPTION 'reserved commerce event namespace requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER domain_events_protect_commerce_namespace
  BEFORE INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_domain_event();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_commerce_initialization_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE command_record record;
DECLARE head_record record;
DECLARE tick_value bigint;
BEGIN
  IF NEW.event_type <> 'WorldCommerceInitializedV1' THEN RETURN NULL; END IF;
  SELECT command.* INTO command_record
  FROM public.command_records command
  WHERE command.id = NEW.command_id AND command.world_id = NEW.world_id;
  SELECT head.* INTO head_record
  FROM public.world_economy_expansion_heads head WHERE head.world_id = NEW.world_id;
  SELECT clock.current_tick INTO tick_value
  FROM public.world_simulation_clocks clock WHERE clock.world_id = NEW.world_id;
  IF command_record.id IS NULL
    OR command_record.command_type <> 'InitializeWorldCommerceV1'
    OR command_record.status <> 'accepted'::command_record_status
    OR command_record.resulting_state_revision <> NEW.resulting_state_revision
    OR head_record.world_id IS NULL
    OR head_record.initialized_command_id <> NEW.command_id
    OR head_record.initialized_event_id <> NEW.id
    OR head_record.updated_state_revision <> NEW.resulting_state_revision
    OR head_record.checksum <>
      public.worldgraph_economy_expansion_projection_checksum(NEW.world_id)
    OR NEW.event_ordinal <> 0 OR NEW.aggregate_type <> 'world_commerce'
    OR NEW.aggregate_id <> NEW.world_id::text OR NEW.aggregate_version <> 1
    OR NEW.payload <> jsonb_build_object(
      'aggregateVersion', '1',
      'businessCount', (SELECT count(*) FROM public.businesses WHERE world_id = NEW.world_id),
      'facilityCount', (SELECT count(*) FROM public.business_facilities WHERE world_id = NEW.world_id),
      'inventoryCount', (SELECT count(*) FROM public.inventories WHERE world_id = NEW.world_id),
      'recipeVersionCount', (SELECT count(*) FROM public.production_recipe_versions WHERE world_id = NEW.world_id),
      'resourceTypeCount', (SELECT count(*) FROM public.resource_types WHERE world_id = NEW.world_id),
      'seedPlanHash', encode(head_record.seed_plan_hash,'hex'),
      'taxPolicyCount', (SELECT count(*) FROM public.tax_policies WHERE world_id = NEW.world_id),
      'tick', tick_value::text
    ) THEN
    RAISE EXCEPTION 'commerce initialization event does not exactly anchor its seed projection'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_initialization_event_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER domain_events_require_commerce_initialization
  AFTER INSERT ON domain_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_initialization_event();
--> statement-breakpoint
CREATE FUNCTION worldgraph_require_commerce_checkpoint_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE checked_command_id uuid;
BEGIN
  IF NEW.projection_name <> 'economy_closed_loop' THEN RETURN NEW; END IF;
  checked_command_id := NULLIF(current_setting('worldgraph.command_id', true), '')::uuid;
  IF NEW.projection_schema_version <> 1
    OR NEW.status <> 'current'::projection_checkpoint_status
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id)
    OR NOT EXISTS (
      SELECT 1
      FROM public.world_economy_expansion_heads head
      JOIN public.domain_events event
        ON event.world_id = head.world_id
       AND event.command_id = checked_command_id
       AND event.world_event_sequence = NEW.last_event_sequence
      WHERE head.world_id = NEW.world_id
        AND head.checksum = NEW.checksum
        AND head.checksum =
          public.worldgraph_economy_expansion_projection_checksum(NEW.world_id)
    ) THEN
    RAISE EXCEPTION 'commerce checkpoint requires its exact open command event/head'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER projection_checkpoints_require_commerce_command
  BEFORE INSERT OR UPDATE ON projection_checkpoints
  FOR EACH ROW EXECUTE FUNCTION worldgraph_require_commerce_checkpoint_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_advance_commerce_checkpoint_for_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.world_economy_expansion_heads head
    WHERE head.world_id = NEW.world_id
  ) THEN
    INSERT INTO public.projection_checkpoints(
      world_id, projection_name, projection_schema_version,
      last_event_sequence, checksum, status, updated_at
    )
    SELECT NEW.world_id, 'economy_closed_loop', 1, NEW.world_event_sequence,
           head.checksum, 'current'::projection_checkpoint_status, NEW.recorded_at
    FROM public.world_economy_expansion_heads head WHERE head.world_id = NEW.world_id
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
CREATE TRIGGER domain_events_advance_commerce_checkpoint
  AFTER INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION worldgraph_advance_commerce_checkpoint_for_event();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_commerce_command_terminal(checked_command_id uuid)
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
BEGIN
  SELECT command.* INTO command_record
  FROM public.command_records command WHERE command.id = checked_command_id;
  IF NOT FOUND OR command_record.command_type NOT IN (
      'InitializeWorldCommerceV1','CreateBusinessV1','ConfigureBusinessFacilityV1',
      'CreateEmploymentContractV1','AcceptEmploymentContractV1',
      'EndEmploymentContractV1','PerformJobV1','StartProductionRunV1',
      'CreateMarketListingV1','CancelMarketListingV1','PurchaseMarketListingV1',
      'ReconcileWorldCommerceV1','CompleteProductionRunV1','SettlePayrollV1',
      'ExpireMarketListingV1','AssessPeriodicTaxV1','RepairEconomicProjectionV1'
    ) OR command_record.status = 'received'::command_record_status THEN
    RETURN;
  END IF;
  SELECT snapshot.* INTO snapshot_record
  FROM public.economy_expansion_command_write_snapshots snapshot
  WHERE snapshot.command_id = command_record.id
    AND snapshot.world_id = command_record.world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'terminal commerce command is missing its owner-written snapshot'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.status <> 'accepted'::command_record_status THEN
    IF NOT snapshot_record.expansion_state_exists THEN
      IF public.worldgraph_economy_expansion_runtime_state_exists(command_record.world_id) THEN
        RAISE EXCEPTION 'rejected commerce initialization left partial state'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.world_economy_expansion_heads head
      WHERE head.world_id = command_record.world_id
        AND head.row_version = snapshot_record.opened_head_row_version
        AND head.checksum = snapshot_record.opened_head_checksum
    ) THEN
      RAISE EXCEPTION 'rejected commerce command changed its expansion head'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;
  IF (command_record.command_type = 'InitializeWorldCommerceV1')
      IS DISTINCT FROM (NOT snapshot_record.expansion_state_exists) THEN
    RAISE EXCEPTION 'accepted commerce initialization state is inconsistent'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.command_type IN (
      'CompleteProductionRunV1','SettlePayrollV1',
      'ExpireMarketListingV1','AssessPeriodicTaxV1'
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.scheduled_actions action
      WHERE action.world_id = command_record.world_id
        AND action.completed_event_id = command_record.causation_id
        AND action.status = 'completed'::scheduled_action_status
        AND action.action_type = command_record.command_type
        AND action.action_schema_version = 1
        AND action.process_version = '1.0.0'
        AND command_record.actor_type = 'system'::command_actor_type
        AND command_record.actor_id = 'worldgraph:commerce-scheduler'
        AND command_record.command_schema_version = 1
        AND command_record.payload = action.payload || jsonb_build_object(
          'expectedTick', action.due_tick::text,
          'scheduledActionId', action.id::text
        )
        AND command_record.payload_hash = extensions.digest(convert_to(
          public.worldgraph_canonical_jsonb(command_record.payload), 'UTF8'
        ), 'sha256')
    ) THEN
    RAISE EXCEPTION 'scheduled commerce effect lacks its exact completed action causation'
      USING ERRCODE = '23514', CONSTRAINT = 'commerce_schedule_command_causation_exact';
  END IF;
  SELECT count(*) INTO event_count
  FROM public.domain_events event WHERE event.command_id = command_record.id;
  IF event_count NOT BETWEEN 1 AND 64 OR NOT EXISTS (
    SELECT 1 FROM public.domain_events event
    WHERE event.command_id = command_record.id
    HAVING min(event.event_ordinal) = 0
      AND max(event.event_ordinal) = event_count - 1
      AND count(DISTINCT event.event_ordinal) = event_count
      AND bool_and(event.resulting_state_revision = command_record.resulting_state_revision)
  ) THEN
    RAISE EXCEPTION 'accepted commerce command has an incomplete event set'
      USING ERRCODE = '55000';
  END IF;
  IF command_record.command_type = 'AssessPeriodicTaxV1' AND NOT (
    EXISTS (
      SELECT 1 FROM public.domain_events event
      WHERE event.command_id = command_record.id
        AND event.event_ordinal = 0 AND event.event_type = 'TaxAssessedV1'
    )
    AND EXISTS (
      SELECT 1 FROM public.domain_events event
      WHERE event.command_id = command_record.id
        AND event.event_ordinal = 1
        AND event.event_type = 'TreasuryRevenueRecordedV1'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.domain_events event
      WHERE event.command_id = command_record.id
        AND event.event_type = 'ScheduledActionCreatedV1'
        AND event.event_ordinal <> 2
    )
  ) THEN
    RAISE EXCEPTION 'periodic tax events are not in canonical assessment/revenue/recurrence order'
      USING ERRCODE = '23514', CONSTRAINT = 'periodic_tax_event_order_exact';
  END IF;
  SELECT runtime.* INTO runtime_record
  FROM public.world_runtime_heads runtime WHERE runtime.world_id = command_record.world_id;
  SELECT head.* INTO head_record
  FROM public.world_economy_expansion_heads head WHERE head.world_id = command_record.world_id;
  SELECT checkpoint.* INTO checkpoint_record
  FROM public.projection_checkpoints checkpoint
  WHERE checkpoint.world_id = command_record.world_id
    AND checkpoint.projection_name = 'economy_closed_loop';
  IF runtime_record.world_id IS NULL OR head_record.world_id IS NULL
    OR checkpoint_record.world_id IS NULL
    OR runtime_record.state_revision <> command_record.resulting_state_revision
    OR head_record.updated_state_revision <> command_record.resulting_state_revision
    OR head_record.checksum <>
      public.worldgraph_economy_expansion_projection_checksum(command_record.world_id)
    OR checkpoint_record.projection_schema_version <> 1
    OR checkpoint_record.status <> 'current'::projection_checkpoint_status
    OR checkpoint_record.last_event_sequence <> runtime_record.last_event_sequence
    OR checkpoint_record.checksum <> head_record.checksum THEN
    RAISE EXCEPTION 'accepted commerce command did not publish its exact current checkpoint'
      USING ERRCODE = '55000';
  END IF;
  PERFORM public.worldgraph_assert_economy_projection_current(command_record.world_id);
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_commerce_command_terminal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.worldgraph_assert_commerce_command_terminal(NEW.id);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER command_records_require_commerce_terminal
  AFTER INSERT OR UPDATE ON command_records DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_commerce_command_terminal();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_schedule_pair_is_valid_v2(text,text),
  worldgraph_commerce_command_type(uuid),
  worldgraph_economy_expansion_runtime_state_exists(uuid),
  worldgraph_assert_economy_expansion_projection_current(uuid),
  worldgraph_protect_commerce_fact(),
  worldgraph_protect_commerce_projection(),
  worldgraph_assert_commerce_association(),
  worldgraph_assert_recipe_version_v1(),
  worldgraph_assert_wallet_kind_owner(),
  worldgraph_assert_inventory_scale_and_journal(),
  worldgraph_assert_inventory_reservation(),
  worldgraph_assert_inventory_reserved_projection(),
  worldgraph_protect_economy_expansion_reconciliation_item(),
  worldgraph_protect_commerce_domain_event(),
  worldgraph_assert_commerce_initialization_event(),
  worldgraph_require_commerce_checkpoint_command(),
  worldgraph_advance_commerce_checkpoint_for_event(),
  worldgraph_assert_commerce_command_terminal(uuid),
  worldgraph_enforce_commerce_command_terminal()
  FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE economy_participant_history
  DROP CONSTRAINT economy_participant_history_category_shape,
  ADD CONSTRAINT economy_participant_history_category_shape CHECK (
    category IN (
      'currency','asset','offer','issuance','wallet','reconciliation','repair',
      'contract','listing','payroll','trade'
    )
  );
--> statement-breakpoint
DROP TRIGGER economy_participant_history_require_exact_binding
  ON economy_participant_history;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER economy_participant_history_require_exact_binding
  AFTER INSERT ON economy_participant_history
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.category NOT IN (
    'contract','listing','payroll','trade'
  ))
  EXECUTE FUNCTION worldgraph_assert_economy_participant_history();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_commerce_participant_history()
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
   AND entry.command_id = command.id AND entry.entry_kind = 'domain_event'::ledger_entry_kind
  WHERE command.id = history_record.command_id
    AND command.world_id = history_record.world_id
    AND command.status = 'accepted'::command_record_status
    AND command.resulting_state_revision = history_record.state_revision
    AND event.id = history_record.event_id
    AND event.resulting_state_revision = history_record.state_revision
    AND entry.ledger_sequence = history_record.ledger_sequence;

  expected_category := CASE event_record.event_type
    WHEN 'EmploymentContractCreatedV1' THEN 'contract'
    WHEN 'EmploymentContractAcceptedV1' THEN 'contract'
    WHEN 'EmploymentContractEndedV1' THEN 'contract'
    WHEN 'WorkRecordedV1' THEN 'contract'
    WHEN 'MarketListingCreatedV1' THEN 'listing'
    WHEN 'MarketListingCancelledV1' THEN 'listing'
    WHEN 'MarketTradeCompletedV1' THEN 'trade'
  END;
  expected_summary_code := CASE event_record.event_type
    WHEN 'EmploymentContractCreatedV1' THEN 'EMPLOYMENT_CONTRACT_CREATED'
    WHEN 'EmploymentContractAcceptedV1' THEN 'EMPLOYMENT_CONTRACT_ACCEPTED'
    WHEN 'EmploymentContractEndedV1' THEN 'EMPLOYMENT_CONTRACT_ENDED'
    WHEN 'WorkRecordedV1' THEN 'WORK_RECORDED'
    WHEN 'MarketListingCreatedV1' THEN 'MARKET_LISTING_CREATED'
    WHEN 'MarketListingCancelledV1' THEN 'MARKET_LISTING_CANCELLED'
    WHEN 'MarketTradeCompletedV1' THEN 'MARKET_TRADE_COMPLETED'
  END;

  participant_binding_valid := CASE event_record.event_type
    WHEN 'EmploymentContractCreatedV1' THEN EXISTS (
      SELECT 1
      FROM public.employment_contracts contract
      JOIN public.businesses business
        ON business.world_id = contract.world_id AND business.id = contract.business_id
      WHERE contract.world_id = history_record.world_id
        AND contract.id::text = event_record.aggregate_id
        AND event_record.payload ->> 'contractId' = contract.id::text
        AND event_record.payload ->> 'businessId' = business.id::text
        AND event_record.payload ->> 'workerEntityId' = contract.worker_entity_id::text
        AND contract.created_command_id = history_record.command_id
        AND contract.created_event_id = history_record.event_id
        AND ((history_record.participant_entity_id = business.backing_organization_entity_id
              AND history_record.counterparty_entity_id = contract.worker_entity_id)
          OR (history_record.participant_entity_id = contract.worker_entity_id
              AND history_record.counterparty_entity_id = business.backing_organization_entity_id))
    )
    WHEN 'EmploymentContractAcceptedV1' THEN EXISTS (
      SELECT 1
      FROM public.employment_contracts contract
      JOIN public.businesses business
        ON business.world_id = contract.world_id AND business.id = contract.business_id
      WHERE contract.world_id = history_record.world_id
        AND contract.id::text = event_record.aggregate_id
        AND event_record.payload ->> 'contractId' = contract.id::text
        AND event_record.payload ->> 'businessId' = business.id::text
        AND event_record.payload ->> 'workerEntityId' = contract.worker_entity_id::text
        AND contract.accepted_command_id = history_record.command_id
        AND contract.accepted_event_id = history_record.event_id
        AND ((history_record.participant_entity_id = business.backing_organization_entity_id
              AND history_record.counterparty_entity_id = contract.worker_entity_id)
          OR (history_record.participant_entity_id = contract.worker_entity_id
              AND history_record.counterparty_entity_id = business.backing_organization_entity_id))
    )
    WHEN 'EmploymentContractEndedV1' THEN EXISTS (
      SELECT 1
      FROM public.employment_contracts contract
      JOIN public.businesses business
        ON business.world_id = contract.world_id AND business.id = contract.business_id
      WHERE contract.world_id = history_record.world_id
        AND contract.id::text = event_record.aggregate_id
        AND event_record.payload ->> 'contractId' = contract.id::text
        AND event_record.payload ->> 'businessId' = business.id::text
        AND event_record.payload ->> 'workerEntityId' = contract.worker_entity_id::text
        AND contract.terminal_command_id = history_record.command_id
        AND contract.terminal_event_id = history_record.event_id
        AND ((history_record.participant_entity_id = business.backing_organization_entity_id
              AND history_record.counterparty_entity_id = contract.worker_entity_id)
          OR (history_record.participant_entity_id = contract.worker_entity_id
              AND history_record.counterparty_entity_id = business.backing_organization_entity_id))
    )
    WHEN 'WorkRecordedV1' THEN EXISTS (
      SELECT 1
      FROM public.work_records work
      JOIN public.employment_contracts contract
        ON contract.world_id = work.world_id AND contract.id = work.contract_id
      JOIN public.businesses business
        ON business.world_id = contract.world_id AND business.id = contract.business_id
      WHERE work.world_id = history_record.world_id
        AND work.id::text = event_record.aggregate_id
        AND event_record.payload ->> 'workRecordId' = work.id::text
        AND event_record.payload ->> 'contractId' = contract.id::text
        AND work.command_id = history_record.command_id
        AND work.event_id = history_record.event_id
        AND ((history_record.participant_entity_id = business.backing_organization_entity_id
              AND history_record.counterparty_entity_id = contract.worker_entity_id)
          OR (history_record.participant_entity_id = contract.worker_entity_id
              AND history_record.counterparty_entity_id = business.backing_organization_entity_id))
    )
    WHEN 'MarketListingCreatedV1' THEN EXISTS (
      SELECT 1 FROM public.market_listings listing
      WHERE listing.world_id = history_record.world_id
        AND listing.id::text = event_record.aggregate_id
        AND event_record.payload ->> 'listingId' = listing.id::text
        AND listing.created_command_id = history_record.command_id
        AND listing.created_event_id = history_record.event_id
        AND history_record.participant_entity_id = listing.seller_entity_id
        AND history_record.counterparty_entity_id IS NULL
    )
    WHEN 'MarketListingCancelledV1' THEN EXISTS (
      SELECT 1 FROM public.market_listings listing
      WHERE listing.world_id = history_record.world_id
        AND listing.id::text = event_record.aggregate_id
        AND event_record.payload ->> 'listingId' = listing.id::text
        AND listing.terminal_command_id = history_record.command_id
        AND listing.terminal_event_id = history_record.event_id
        AND history_record.participant_entity_id = listing.seller_entity_id
        AND history_record.counterparty_entity_id IS NULL
    )
    WHEN 'MarketTradeCompletedV1' THEN EXISTS (
      SELECT 1 FROM public.market_trades trade
      WHERE trade.world_id = history_record.world_id
        AND trade.id::text = event_record.aggregate_id
        AND event_record.payload ->> 'tradeId' = trade.id::text
        AND event_record.payload ->> 'listingId' = trade.listing_id::text
        AND trade.command_id = history_record.command_id
        AND trade.event_id = history_record.event_id
        AND ((history_record.participant_entity_id = trade.seller_entity_id
              AND history_record.counterparty_entity_id = trade.buyer_entity_id)
          OR (history_record.participant_entity_id = trade.buyer_entity_id
              AND history_record.counterparty_entity_id = trade.seller_entity_id))
    )
    ELSE false
  END;

  IF event_record.id IS NULL
    OR history_record.visibility <> 'participant'::economy_participant_visibility
    OR expected_category IS NULL
    OR history_record.category IS DISTINCT FROM expected_category
    OR history_record.summary_code IS DISTINCT FROM expected_summary_code
    OR history_record.summary_args IS DISTINCT FROM '{}'::jsonb
    OR NOT public.worldgraph_user_controls_economy_entity_v1(
      history_record.world_id,
      history_record.user_id,
      history_record.participant_entity_id
    )
    OR participant_binding_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'commerce participant history is not the exact redacted event participant view'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER economy_participant_history_require_commerce_binding
  AFTER INSERT ON economy_participant_history
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.category IN (
    'contract','listing','trade'
  ))
  EXECUTE FUNCTION worldgraph_assert_commerce_participant_history();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_commerce_participant_history() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_payroll_participant_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  history_record record;
  event_record record;
  expected_summary_code text;
  expected_summary_args jsonb;
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
   AND entry.command_id = command.id AND entry.entry_kind = 'domain_event'::ledger_entry_kind
  WHERE command.id = history_record.command_id
    AND command.world_id = history_record.world_id
    AND command.status = 'accepted'::command_record_status
    AND command.resulting_state_revision = history_record.state_revision
    AND event.id = history_record.event_id
    AND event.resulting_state_revision = history_record.state_revision
    AND entry.ledger_sequence = history_record.ledger_sequence;

  expected_summary_code := CASE event_record.event_type
    WHEN 'PayrollSettledV1' THEN 'PAYROLL_SETTLED'
    WHEN 'PayrollFailedV1' THEN 'PAYROLL_FAILED'
  END;
  expected_summary_args := CASE event_record.event_type
    WHEN 'PayrollSettledV1' THEN jsonb_build_object(
      'contractId', event_record.payload ->> 'contractId',
      'payrollRecordId', event_record.payload ->> 'payrollRecordId',
      'status', 'paid')
    WHEN 'PayrollFailedV1' THEN jsonb_build_object(
      'contractId', event_record.payload ->> 'contractId',
      'payrollRecordId', event_record.payload ->> 'payrollRecordId',
      'status', 'failed')
  END;

  IF NOT FOUND
    OR history_record.visibility <> 'participant'::economy_participant_visibility
    OR history_record.category <> 'payroll'
    OR history_record.summary_code IS DISTINCT FROM expected_summary_code
    OR history_record.summary_args IS DISTINCT FROM expected_summary_args
    OR NOT public.worldgraph_user_controls_economy_entity_v1(
      history_record.world_id,
      history_record.user_id,
      history_record.participant_entity_id
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.payroll_records payroll
      JOIN public.employment_contracts contract
        ON contract.world_id = payroll.world_id AND contract.id = payroll.contract_id
      JOIN public.businesses business
        ON business.world_id = contract.world_id AND business.id = contract.business_id
      WHERE payroll.world_id = history_record.world_id
        AND payroll.id::text = event_record.payload ->> 'payrollRecordId'
        AND payroll.contract_id::text = event_record.payload ->> 'contractId'
        AND payroll.terminal_command_id = history_record.command_id
        AND payroll.terminal_event_id = history_record.event_id
        AND payroll.terminal_state_revision = history_record.state_revision
        AND payroll.status::text = expected_summary_args ->> 'status'
        AND event_record.aggregate_type = 'payroll_record'
        AND event_record.aggregate_id = payroll.id::text
        AND (
          (history_record.participant_entity_id = business.backing_organization_entity_id
            AND history_record.counterparty_entity_id = contract.worker_entity_id)
          OR
          (history_record.participant_entity_id = contract.worker_entity_id
            AND history_record.counterparty_entity_id = business.backing_organization_entity_id)
        )
    ) THEN
    RAISE EXCEPTION 'payroll participant history is not the exact redacted event participant view'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER economy_participant_history_require_payroll_binding
  AFTER INSERT ON economy_participant_history
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.category = 'payroll')
  EXECUTE FUNCTION worldgraph_assert_payroll_participant_history();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_payroll_participant_history() FROM PUBLIC;
--> statement-breakpoint
DO $metadata$
DECLARE changed integer;
BEGIN
  UPDATE platform_metadata
  SET value = value || jsonb_build_object(
        'businessSchema', 1,
        'commerceSchema', 1,
        'compiler', '1.2.0',
        'compilerArtifactSchema', 3,
        'contracts', 9,
        'economyExpansionReconciliationSchema', 2,
        'economyExpansionSchema', 1,
        'economySeedPlanSchema', 2,
        'employmentSchema', 1,
        'inventorySchema', 1,
        'marketSchema', 1,
        'productionSchema', 1,
        'resourceSchema', 1,
        'runtimeSchema', 9,
        'simulationProcessRegistry', 2,
        'taxSchema', 1
      ),
      value_schema_version = 9,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 8
    AND value ->> 'compiler' = '1.1.0'
    AND value ->> 'compilerArtifactSchema' = '2'
    AND value ->> 'contracts' = '8'
    AND value ->> 'economySeedPlanSchema' = '1'
    AND value ->> 'runtimeSchema' = '8'
    AND value ->> 'simulationProcessRegistry' = '1'
    AND NOT value ?| ARRAY[
      'businessSchema','commerceSchema','economyExpansionReconciliationSchema',
      'economyExpansionSchema','employmentSchema','inventorySchema','marketSchema',
      'productionSchema','resourceSchema','taxSchema'
    ];
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact sealed M08 compatibility state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT USAGE ON TYPE
      resource_type_status, inventory_movement_kind,
      inventory_reservation_purpose, inventory_reservation_status,
      business_status, business_facility_status, production_run_status,
      employment_offer_status, employment_contract_status, wage_rule_kind,
      payroll_status, market_listing_status, tax_policy_type,
      tax_collection_mode, tax_policy_status
      TO worldgraph_app;
    GRANT SELECT ON
      world_economy_expansion_heads, resource_types, production_recipes,
      production_recipe_versions, inventories, inventory_movements, businesses,
      business_facilities, business_facility_recipe_versions, production_runs,
      production_run_transitions, employment_offers, employment_contracts,
      work_records, payroll_records, tax_policies, market_listings,
      inventory_reservations, market_trades, tax_assessments,
      economy_expansion_reconciliation_runs,
      economy_expansion_reconciliation_items
      TO worldgraph_app;
    GRANT INSERT ON
      world_economy_expansion_heads, resource_types, production_recipes,
      production_recipe_versions, inventories, inventory_movements, businesses,
      business_facilities, business_facility_recipe_versions, production_runs,
      production_run_transitions, employment_offers, employment_contracts,
      work_records, payroll_records, tax_policies, market_listings,
      inventory_reservations, market_trades, tax_assessments,
      economy_expansion_reconciliation_runs,
      economy_expansion_reconciliation_items
      TO worldgraph_app;
    GRANT UPDATE (
      checksum, row_version, updated_state_revision, reconciliation_status,
      last_reconciled_state_revision, last_reconciliation_run_id, updated_at
    ) ON world_economy_expansion_heads TO worldgraph_app;
    GRANT UPDATE (
      status, metadata, row_version, updated_state_revision, updated_at, closed_at
    )
      ON businesses TO worldgraph_app;
    GRANT UPDATE (status, row_version, updated_state_revision, updated_at)
      ON business_facilities TO worldgraph_app;
    GRANT UPDATE (
      quantity, reserved_quantity, row_version, updated_state_revision, updated_at
    ) ON inventories TO worldgraph_app;
    GRANT UPDATE (
      status, failure_code, row_version, terminal_command_id, terminal_event_id,
      terminal_state_revision, updated_at, completed_at
    ) ON production_runs TO worldgraph_app;
    GRANT UPDATE (
      status, accepted_command_id, accepted_event_id, accepted_state_revision,
      terminal_command_id, terminal_event_id, terminal_reason,
      terminal_state_revision, row_version, updated_at, ended_at
    ) ON employment_contracts TO worldgraph_app;
    GRANT UPDATE (
      status, financial_transaction_id, error_code, terminal_command_id,
      terminal_event_id, terminal_state_revision, row_version, updated_at, terminal_at
    ) ON payroll_records TO worldgraph_app;
    GRANT UPDATE (
      status, remaining_quantity, reserved_quantity, terminal_command_id,
      terminal_event_id, terminal_state_revision, row_version, updated_at, terminal_at
    ) ON market_listings TO worldgraph_app;
    GRANT UPDATE (
      quantity, status, terminal_command_id, terminal_event_id, terminal_state_revision,
      row_version, updated_at, terminal_at
    ) ON inventory_reservations TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION
      worldgraph_open_command_write(uuid,uuid),
      worldgraph_commerce_command_type(uuid),
      worldgraph_schedule_pair_is_valid_v2(text,text),
      worldgraph_allocate_schedule_sequence(uuid),
      worldgraph_quantity_fits_scale_v1(numeric,smallint),
      worldgraph_resource_tags_are_valid_v1(text[]),
      worldgraph_recipe_version_is_valid_v1(uuid),
      worldgraph_economy_seed_plan_is_valid(jsonb),
      worldgraph_economy_seed_plan_v2_is_valid(jsonb),
      worldgraph_economy_expansion_projection_document(uuid),
      worldgraph_economy_expansion_projection_checksum(uuid),
      worldgraph_economy_expansion_initial_projection_checksum(uuid,uuid,bytea),
      worldgraph_economy_inventory_live_document(uuid),
      worldgraph_economy_inventory_rebuilt_document(uuid),
      worldgraph_economy_reservation_live_document(uuid),
      worldgraph_economy_reservation_rebuilt_document(uuid),
      worldgraph_reconcile_economy_expansion(uuid),
      worldgraph_materialize_world_commerce(uuid,uuid,bytea,uuid,uuid,bigint,timestamptz),
      worldgraph_tax_amount_v1(bigint,integer,bigint,tax_policy_type),
      worldgraph_user_controls_economy_entity_v1(uuid,uuid,uuid),
      worldgraph_assert_commerce_command_terminal(uuid)
      TO worldgraph_app;
    REVOKE EXECUTE ON FUNCTION worldgraph_open_command_write_m08(uuid,uuid)
      FROM worldgraph_app;
    REVOKE UPDATE, DELETE ON
      resource_types, production_recipes, production_recipe_versions,
      inventory_movements, business_facility_recipe_versions,
      production_run_transitions, employment_offers, work_records, tax_policies,
      market_trades, tax_assessments, economy_expansion_reconciliation_runs,
      economy_expansion_reconciliation_items
      FROM worldgraph_app;
    REVOKE ALL ON economy_expansion_command_write_snapshots
      FROM worldgraph_app;
    REVOKE DELETE ON
      world_economy_expansion_heads, inventories, businesses, business_facilities,
      production_runs, employment_contracts, payroll_records, market_listings,
      inventory_reservations
      FROM worldgraph_app;
  END IF;
END
$grant$;
--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
