CREATE FUNCTION worldgraph_commerce_projection_repair_reason_is_valid(value text)
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
  IF char_length(value) NOT BETWEEN 20 AND 1000
    OR left(value, 1) = ' ' OR right(value, 1) = ' ' THEN
    RETURN false;
  END IF;
  FOR character_index IN 1..char_length(value) LOOP
    code_point := ascii(substr(value, character_index, 1));
    IF code_point BETWEEN 0 AND 31 OR code_point BETWEEN 127 AND 159 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_commerce_projection_repair_reason_is_valid(text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_commerce_projection_repair_inventory_snapshot(
  checked_world_id uuid
)
RETURNS TABLE (
  inventory_id uuid,
  expected_row_version bigint,
  actual_quantity numeric(30,12),
  actual_reserved_quantity numeric(30,12),
  repaired_quantity numeric(30,12),
  repaired_reserved_quantity numeric(30,12),
  mismatch_kinds text[]
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
WITH movement AS (
  SELECT endpoint.inventory_id, sum(endpoint.quantity)::numeric AS quantity
  FROM (
    SELECT item.to_inventory_id AS inventory_id, item.quantity
    FROM public.inventory_movements item
    WHERE item.world_id = checked_world_id AND item.to_inventory_id IS NOT NULL
    UNION ALL
    SELECT item.from_inventory_id AS inventory_id, -item.quantity
    FROM public.inventory_movements item
    WHERE item.world_id = checked_world_id AND item.from_inventory_id IS NOT NULL
  ) endpoint
  GROUP BY endpoint.inventory_id
), reservation AS (
  SELECT item.inventory_id, sum(item.quantity)::numeric AS quantity
  FROM public.inventory_reservations item
  WHERE item.world_id = checked_world_id
    AND item.status = 'active'::inventory_reservation_status
  GROUP BY item.inventory_id
), differences AS (
  SELECT inventory.id AS inventory_id,
         inventory.row_version AS expected_row_version,
         inventory.quantity AS actual_quantity,
         inventory.reserved_quantity AS actual_reserved_quantity,
         COALESCE(movement.quantity, 0)::numeric(30,12) AS repaired_quantity,
         COALESCE(reservation.quantity, 0)::numeric(30,12) AS repaired_reserved_quantity
  FROM public.inventories inventory
  LEFT JOIN movement ON movement.inventory_id = inventory.id
  LEFT JOIN reservation ON reservation.inventory_id = inventory.id
  WHERE inventory.world_id = checked_world_id
)
SELECT differences.inventory_id,
       differences.expected_row_version,
       differences.actual_quantity,
       differences.actual_reserved_quantity,
       differences.repaired_quantity,
       differences.repaired_reserved_quantity,
       array_remove(ARRAY[
         CASE WHEN differences.actual_quantity IS DISTINCT FROM
             differences.repaired_quantity THEN 'quantity' END,
         CASE WHEN differences.actual_reserved_quantity IS DISTINCT FROM
             differences.repaired_reserved_quantity THEN 'reservation' END
       ], NULL)::text[] AS mismatch_kinds
FROM differences
WHERE differences.actual_quantity IS DISTINCT FROM differences.repaired_quantity
   OR differences.actual_reserved_quantity IS DISTINCT FROM
      differences.repaired_reserved_quantity
ORDER BY differences.inventory_id
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_commerce_projection_repair_inventory_snapshot(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE commerce_projection_repair_plans (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  repair_plan_schema_version integer NOT NULL DEFAULT 1,
  reserved_command_id uuid NOT NULL UNIQUE,
  reserved_event_id uuid NOT NULL UNIQUE,
  reserved_ledger_entry_id uuid NOT NULL UNIQUE,
  source_world_version bigint NOT NULL,
  source_state_revision bigint NOT NULL,
  source_event_sequence bigint NOT NULL,
  source_ledger_sequence bigint NOT NULL,
  source_economy_head_version bigint NOT NULL,
  source_economy_checksum bytea NOT NULL,
  source_expansion_head_version bigint NOT NULL,
  source_expansion_checksum bytea NOT NULL,
  source_reconciliation_run_id uuid NOT NULL,
  source_reconciliation_live_checksum bytea NOT NULL,
  source_reconciliation_rebuilt_checksum bytea NOT NULL,
  reason text NOT NULL,
  prepared_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  preparation_audit_id uuid NOT NULL UNIQUE,
  plan_hash bytea NOT NULL UNIQUE,
  prepared_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT commerce_projection_repair_plans_world_identity UNIQUE (world_id, id),
  CONSTRAINT commerce_projection_repair_plans_reconciliation_world_fk
    FOREIGN KEY (world_id, source_reconciliation_run_id)
    REFERENCES economy_expansion_reconciliation_runs(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_plans_audit_fk
    FOREIGN KEY (preparation_audit_id, world_id, prepared_by_user_id)
    REFERENCES security_audit_records(id, world_id, actor_user_id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_plans_schema_known CHECK (
    repair_plan_schema_version = 1
  ),
  CONSTRAINT commerce_projection_repair_plans_versions_positive CHECK (
    source_world_version > 0 AND source_state_revision > 0
      AND source_event_sequence > 0 AND source_ledger_sequence > 0
      AND source_economy_head_version > 0 AND source_expansion_head_version > 0
  ),
  CONSTRAINT commerce_projection_repair_plans_hash_lengths CHECK (
    octet_length(source_economy_checksum) = 32
      AND octet_length(source_expansion_checksum) = 32
      AND octet_length(source_reconciliation_live_checksum) = 32
      AND octet_length(source_reconciliation_rebuilt_checksum) = 32
      AND octet_length(plan_hash) = 32
  ),
  CONSTRAINT commerce_projection_repair_plans_mismatch_bound CHECK (
    source_reconciliation_live_checksum <> source_reconciliation_rebuilt_checksum
  ),
  CONSTRAINT commerce_projection_repair_plans_reason_valid CHECK (
    worldgraph_commerce_projection_repair_reason_is_valid(reason)
  ),
  CONSTRAINT commerce_projection_repair_plans_time_window_exact CHECK (
    prepared_at = date_trunc('milliseconds', prepared_at)
      AND expires_at = prepared_at + interval '15 minutes'
  ),
  CONSTRAINT commerce_projection_repair_plans_reserved_ids_distinct CHECK (
    id <> reserved_command_id AND id <> reserved_event_id
      AND id <> reserved_ledger_entry_id
      AND reserved_command_id <> reserved_event_id
      AND reserved_command_id <> reserved_ledger_entry_id
      AND reserved_event_id <> reserved_ledger_entry_id
  )
);
--> statement-breakpoint
CREATE INDEX commerce_projection_repair_plans_world_prepared_idx
  ON commerce_projection_repair_plans (world_id, prepared_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX commerce_projection_repair_plans_expiry_idx
  ON commerce_projection_repair_plans (expires_at, world_id, id);
--> statement-breakpoint
CREATE TABLE commerce_projection_repair_plan_items (
  repair_plan_id uuid NOT NULL,
  world_id uuid NOT NULL,
  item_ordinal integer NOT NULL,
  inventory_id uuid NOT NULL,
  repair_fact_id uuid NOT NULL UNIQUE,
  expected_row_version bigint NOT NULL,
  actual_quantity numeric(30,12) NOT NULL,
  actual_reserved_quantity numeric(30,12) NOT NULL,
  repaired_quantity numeric(30,12) NOT NULL,
  repaired_reserved_quantity numeric(30,12) NOT NULL,
  mismatch_kinds text[] NOT NULL,
  PRIMARY KEY (repair_plan_id, item_ordinal),
  CONSTRAINT commerce_projection_repair_plan_items_inventory_unique
    UNIQUE (repair_plan_id, inventory_id),
  CONSTRAINT commerce_projection_repair_plan_items_plan_world_fk
    FOREIGN KEY (world_id, repair_plan_id)
    REFERENCES commerce_projection_repair_plans(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_plan_items_inventory_world_fk
    FOREIGN KEY (world_id, inventory_id)
    REFERENCES inventories(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_plan_items_ordinal CHECK (
    item_ordinal BETWEEN 0 AND 9999
  ),
  CONSTRAINT commerce_projection_repair_plan_items_values CHECK (
    expected_row_version > 0
      AND actual_quantity >= 0 AND actual_reserved_quantity >= 0
      AND repaired_quantity >= 0 AND repaired_reserved_quantity >= 0
      AND actual_reserved_quantity <= actual_quantity
      AND repaired_reserved_quantity <= repaired_quantity
      AND actual_quantity < 1000000000000000000::numeric
      AND actual_reserved_quantity < 1000000000000000000::numeric
      AND repaired_quantity < 1000000000000000000::numeric
      AND repaired_reserved_quantity < 1000000000000000000::numeric
  ),
  CONSTRAINT commerce_projection_repair_plan_items_mismatch_exact CHECK (
    mismatch_kinds = array_remove(ARRAY[
      CASE WHEN actual_quantity IS DISTINCT FROM repaired_quantity THEN 'quantity' END,
      CASE WHEN actual_reserved_quantity IS DISTINCT FROM repaired_reserved_quantity
        THEN 'reservation' END
    ], NULL)::text[]
    AND cardinality(mismatch_kinds) BETWEEN 1 AND 2
  )
);
--> statement-breakpoint
CREATE INDEX commerce_projection_repair_plan_items_inventory_idx
  ON commerce_projection_repair_plan_items (world_id, inventory_id, repair_plan_id);
--> statement-breakpoint
CREATE TABLE commerce_projection_repair_approvals (
  id uuid PRIMARY KEY,
  repair_plan_id uuid NOT NULL UNIQUE,
  world_id uuid NOT NULL,
  approver_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_plan_hash bytea NOT NULL,
  override_id uuid NOT NULL UNIQUE REFERENCES creator_override_records(id) ON DELETE RESTRICT,
  audit_record_id uuid NOT NULL UNIQUE,
  approved_at timestamptz NOT NULL,
  CONSTRAINT commerce_projection_repair_approvals_plan_world_fk
    FOREIGN KEY (world_id, repair_plan_id)
    REFERENCES commerce_projection_repair_plans(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_approvals_audit_fk
    FOREIGN KEY (audit_record_id, world_id, approver_user_id)
    REFERENCES security_audit_records(id, world_id, actor_user_id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_approvals_hash_length CHECK (
    octet_length(approved_plan_hash) = 32
  ),
  CONSTRAINT commerce_projection_repair_approvals_identity CHECK (id = override_id),
  CONSTRAINT commerce_projection_repair_approvals_timestamp CHECK (
    approved_at = date_trunc('milliseconds', approved_at)
  )
);
--> statement-breakpoint
CREATE TABLE commerce_projection_repair_facts (
  id uuid PRIMARY KEY,
  repair_plan_id uuid NOT NULL,
  world_id uuid NOT NULL,
  item_ordinal integer NOT NULL,
  inventory_id uuid NOT NULL,
  actual_quantity numeric(30,12) NOT NULL,
  actual_reserved_quantity numeric(30,12) NOT NULL,
  repaired_quantity numeric(30,12) NOT NULL,
  repaired_reserved_quantity numeric(30,12) NOT NULL,
  mismatch_kinds text[] NOT NULL,
  source_reconciliation_run_id uuid NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  resulting_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT commerce_projection_repair_facts_plan_item_unique
    UNIQUE (repair_plan_id, item_ordinal),
  CONSTRAINT commerce_projection_repair_facts_inventory_unique
    UNIQUE (repair_plan_id, inventory_id),
  CONSTRAINT commerce_projection_repair_facts_plan_world_fk
    FOREIGN KEY (world_id, repair_plan_id)
    REFERENCES commerce_projection_repair_plans(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_facts_plan_item_fk
    FOREIGN KEY (repair_plan_id, item_ordinal)
    REFERENCES commerce_projection_repair_plan_items(repair_plan_id, item_ordinal)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_facts_inventory_world_fk
    FOREIGN KEY (world_id, inventory_id)
    REFERENCES inventories(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_facts_reconciliation_world_fk
    FOREIGN KEY (world_id, source_reconciliation_run_id)
    REFERENCES economy_expansion_reconciliation_runs(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_facts_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_facts_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT commerce_projection_repair_facts_values CHECK (
    resulting_state_revision > 0
      AND actual_quantity >= 0 AND actual_reserved_quantity >= 0
      AND repaired_quantity >= 0 AND repaired_reserved_quantity >= 0
      AND actual_reserved_quantity <= actual_quantity
      AND repaired_reserved_quantity <= repaired_quantity
      AND cardinality(mismatch_kinds) BETWEEN 1 AND 2
  ),
  CONSTRAINT commerce_projection_repair_facts_timestamp CHECK (
    created_at = date_trunc('milliseconds', created_at)
  )
);
--> statement-breakpoint
CREATE TABLE commerce_projection_repair_executions (
  id uuid PRIMARY KEY,
  repair_plan_id uuid NOT NULL UNIQUE,
  world_id uuid NOT NULL,
  approval_id uuid NOT NULL UNIQUE,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  ledger_entry_id uuid NOT NULL UNIQUE,
  reconciliation_run_id uuid NOT NULL UNIQUE,
  executed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  execution_audit_id uuid NOT NULL UNIQUE,
  repair_fact_count integer NOT NULL,
  resulting_state_revision bigint NOT NULL,
  resulting_event_sequence bigint NOT NULL,
  resulting_ledger_sequence bigint NOT NULL,
  resulting_expansion_head_version bigint NOT NULL,
  resulting_checksum bytea NOT NULL,
  executed_at timestamptz NOT NULL,
  CONSTRAINT commerce_projection_repair_executions_plan_world_fk
    FOREIGN KEY (world_id, repair_plan_id)
    REFERENCES commerce_projection_repair_plans(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_executions_approval_fk
    FOREIGN KEY (approval_id) REFERENCES commerce_projection_repair_approvals(id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_executions_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_executions_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_executions_ledger_world_fk
    FOREIGN KEY (world_id, ledger_entry_id)
    REFERENCES ledger_entries(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_executions_reconciliation_world_fk
    FOREIGN KEY (world_id, reconciliation_run_id)
    REFERENCES economy_expansion_reconciliation_runs(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_executions_audit_fk
    FOREIGN KEY (execution_audit_id, world_id, executed_by_user_id)
    REFERENCES security_audit_records(id, world_id, actor_user_id) ON DELETE RESTRICT,
  CONSTRAINT commerce_projection_repair_executions_values CHECK (
    repair_fact_count BETWEEN 1 AND 10000
      AND resulting_state_revision > 0 AND resulting_event_sequence > 0
      AND resulting_ledger_sequence > 0 AND resulting_expansion_head_version > 0
      AND octet_length(resulting_checksum) = 32
  ),
  CONSTRAINT commerce_projection_repair_executions_timestamp CHECK (
    executed_at = date_trunc('milliseconds', executed_at)
  )
);
--> statement-breakpoint
REVOKE ALL ON
  commerce_projection_repair_plans,
  commerce_projection_repair_plan_items,
  commerce_projection_repair_approvals,
  commerce_projection_repair_facts,
  commerce_projection_repair_executions
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_commerce_projection_repair_plan_document(
  checked_repair_plan_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN (
  SELECT jsonb_build_object(
    'domain', 'worldgraph.commerce-projection-repair-plan.v1',
    'expiresAt', to_char(
      plan.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'actualQuantity', item.actual_quantity::numeric(30,12)::text,
        'actualReservedQuantity', item.actual_reserved_quantity::numeric(30,12)::text,
        'expectedRowVersion', item.expected_row_version::text,
        'inventoryId', item.inventory_id::text,
        'itemOrdinal', item.item_ordinal,
        'mismatchKinds', to_jsonb(item.mismatch_kinds),
        'repairFactId', item.repair_fact_id::text,
        'repairedQuantity', item.repaired_quantity::numeric(30,12)::text,
        'repairedReservedQuantity',
          item.repaired_reserved_quantity::numeric(30,12)::text
      ) ORDER BY item.item_ordinal)
      FROM public.commerce_projection_repair_plan_items item
      WHERE item.repair_plan_id = plan.id
    ), '[]'::jsonb),
    'preparedAt', to_char(
      plan.prepared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'preparedByUserId', plan.prepared_by_user_id::text,
    'reason', plan.reason,
    'repairPlanId', plan.id::text,
    'repairPlanSchemaVersion', plan.repair_plan_schema_version,
    'reservedCommandId', plan.reserved_command_id::text,
    'reservedEventId', plan.reserved_event_id::text,
    'reservedLedgerEntryId', plan.reserved_ledger_entry_id::text,
    'sourceEconomyChecksum', encode(plan.source_economy_checksum, 'hex'),
    'sourceEconomyHeadVersion', plan.source_economy_head_version::text,
    'sourceEventSequence', plan.source_event_sequence::text,
    'sourceExpansionChecksum', encode(plan.source_expansion_checksum, 'hex'),
    'sourceExpansionHeadVersion', plan.source_expansion_head_version::text,
    'sourceLedgerSequence', plan.source_ledger_sequence::text,
    'sourceReconciliationLiveChecksum',
      encode(plan.source_reconciliation_live_checksum, 'hex'),
    'sourceReconciliationRebuiltChecksum',
      encode(plan.source_reconciliation_rebuilt_checksum, 'hex'),
    'sourceReconciliationRunId', plan.source_reconciliation_run_id::text,
    'sourceStateRevision', plan.source_state_revision::text,
    'sourceWorldVersion', plan.source_world_version::text,
    'worldId', plan.world_id::text
  )
  FROM public.commerce_projection_repair_plans plan
  WHERE plan.id = checked_repair_plan_id
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_commerce_projection_repair_plan_document(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_commerce_projection_repair_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_plan_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  checked_plan_id := CASE TG_TABLE_NAME
    WHEN 'commerce_projection_repair_plans' THEN NEW.id
    ELSE NEW.repair_plan_id
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
CREATE TRIGGER commerce_projection_repair_plans_protect
  BEFORE INSERT OR UPDATE OR DELETE ON commerce_projection_repair_plans
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection_repair_evidence();
--> statement-breakpoint
CREATE TRIGGER commerce_projection_repair_plan_items_protect
  BEFORE INSERT OR UPDATE OR DELETE ON commerce_projection_repair_plan_items
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection_repair_evidence();
--> statement-breakpoint
CREATE TRIGGER commerce_projection_repair_approvals_protect
  BEFORE INSERT OR UPDATE OR DELETE ON commerce_projection_repair_approvals
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection_repair_evidence();
--> statement-breakpoint
CREATE TRIGGER commerce_projection_repair_facts_protect
  BEFORE INSERT OR UPDATE OR DELETE ON commerce_projection_repair_facts
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection_repair_evidence();
--> statement-breakpoint
CREATE TRIGGER commerce_projection_repair_executions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON commerce_projection_repair_executions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_commerce_projection_repair_evidence();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_protect_commerce_projection_repair_evidence()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_commerce_projection_repair_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  plan_record record;
  plan_document jsonb;
  expected_hash bytea;
  item_count integer;
BEGIN
  SELECT plan.* INTO plan_record
  FROM public.commerce_projection_repair_plans plan WHERE plan.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  plan_document := public.worldgraph_commerce_projection_repair_plan_document(plan_record.id);
  expected_hash := extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
    jsonb_build_object(
      'domain', 'worldgraph.commerce-projection-repair-plan-hash.v1',
      'plan', plan_document
    )
  ), 'UTF8'), 'sha256');
  SELECT count(*) INTO item_count
  FROM public.commerce_projection_repair_plan_items item
  WHERE item.repair_plan_id = plan_record.id;
  IF item_count NOT BETWEEN 1 AND 10000
    OR plan_record.plan_hash IS DISTINCT FROM expected_hash
    OR plan_document IS NULL
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT source.*,
               (row_number() OVER (ORDER BY source.inventory_id) - 1)::integer
                 AS expected_ordinal
        FROM public.commerce_projection_repair_plan_items source
        WHERE source.repair_plan_id = plan_record.id
      ) item
      JOIN public.resource_types resource
        ON resource.world_id = item.world_id
      JOIN public.inventories inventory
        ON inventory.world_id = item.world_id AND inventory.id = item.inventory_id
       AND inventory.resource_type_id = resource.id
      WHERE item.item_ordinal <> item.expected_ordinal
          OR NOT public.worldgraph_quantity_fits_scale_v1(
            item.actual_quantity, resource.quantity_scale
          )
          OR NOT public.worldgraph_quantity_fits_scale_v1(
            item.actual_reserved_quantity, resource.quantity_scale
          )
          OR NOT public.worldgraph_quantity_fits_scale_v1(
            item.repaired_quantity, resource.quantity_scale
          )
          OR NOT public.worldgraph_quantity_fits_scale_v1(
            item.repaired_reserved_quantity, resource.quantity_scale
          )
    )
    OR EXISTS (
      SELECT 1
      FROM public.commerce_projection_repair_plan_items item
      WHERE item.repair_plan_id = plan_record.id
        AND item.repair_fact_id IN (
          plan_record.id, plan_record.reserved_command_id,
          plan_record.reserved_event_id, plan_record.reserved_ledger_entry_id
        )
    )
    OR plan_record.source_expansion_checksum IS DISTINCT FROM (
      SELECT decode(event.payload ->> 'checksum', 'hex')
      FROM public.economy_expansion_reconciliation_runs run
      JOIN public.domain_events event
        ON event.world_id = run.world_id AND event.id = run.event_id
      WHERE run.id = plan_record.source_reconciliation_run_id
        AND run.world_id = plan_record.world_id
        AND run.status = 'mismatch'::economy_reconciliation_run_status
        AND event.event_type = 'WorldCommerceReconciledV1'
    )
    OR plan_record.source_reconciliation_live_checksum IS DISTINCT FROM (
      SELECT run.live_projection_checksum
      FROM public.economy_expansion_reconciliation_runs run
      WHERE run.id = plan_record.source_reconciliation_run_id
        AND run.world_id = plan_record.world_id
    )
    OR plan_record.source_reconciliation_rebuilt_checksum IS DISTINCT FROM (
      SELECT run.rebuilt_journal_checksum
      FROM public.economy_expansion_reconciliation_runs run
      WHERE run.id = plan_record.source_reconciliation_run_id
        AND run.world_id = plan_record.world_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.security_audit_records audit
      WHERE audit.id = plan_record.preparation_audit_id
        AND audit.world_id = plan_record.world_id
        AND audit.actor_user_id = plan_record.prepared_by_user_id
        AND audit.category = 'commerce_projection_repair'
        AND audit.action = 'commerce_projection.repair.prepare'
        AND audit.outcome = 'succeeded'
        AND audit.reason_code = 'COMMERCE_PROJECTION_REPAIR_PREPARED'
        AND audit.target_type = 'commerce_projection_repair_plan'
        AND audit.target_id = plan_record.id
        AND audit.redacted_metadata = jsonb_build_object(
          'affectedInventoryCount', item_count,
          'planHash', encode(plan_record.plan_hash, 'hex'),
          'sourceReconciliationRunId', plan_record.source_reconciliation_run_id::text
        )
    ) THEN
    RAISE EXCEPTION 'commerce projection repair plan is not its exact canonical mismatch seal'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_projection_repair_plan_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commerce_projection_repair_plans_require_exact_seal
  AFTER INSERT ON commerce_projection_repair_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_projection_repair_plan();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_commerce_projection_repair_plan()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_prepare_commerce_projection_repair(
  checked_world_id uuid,
  checked_prepared_by_user_id uuid,
  checked_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  authority record;
  repair_plan_id uuid := extensions.gen_random_uuid();
  reserved_command_id uuid := extensions.gen_random_uuid();
  reserved_event_id uuid := extensions.gen_random_uuid();
  reserved_ledger_entry_id uuid := extensions.gen_random_uuid();
  preparation_audit_id uuid := extensions.gen_random_uuid();
  prepared_time timestamptz := date_trunc('milliseconds', clock_timestamp());
  plan_items jsonb;
  plan_body jsonb;
  plan_hash_value bytea;
  live_reconciliation_checksum bytea;
  rebuilt_reconciliation_checksum bytea;
  repairable_count integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'commerce projection repair preparation requires the database owner session'
      USING ERRCODE = '42501';
  END IF;
  IF checked_world_id IS NULL OR checked_prepared_by_user_id IS NULL
    OR checked_reason IS NULL
    OR NOT public.worldgraph_commerce_projection_repair_reason_is_valid(checked_reason) THEN
    RAISE EXCEPTION 'commerce projection repair world, preparer, and bounded reason are required'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users operator
    WHERE operator.id = checked_prepared_by_user_id
      AND operator.status = 'active'::user_status
      AND operator.platform_role = 'platform_admin'::platform_role
  ) THEN
    RAISE EXCEPTION 'commerce projection repair preparer must be an active platform administrator'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.worldgraph_lock_world_compilation(checked_world_id);
  SELECT runtime.state_revision, runtime.last_event_sequence,
         runtime.last_ledger_sequence, runtime.projection_checksum,
         version.version_number AS world_version,
         economy.row_version AS economy_head_version,
         economy.checksum AS economy_checksum,
         expansion.row_version AS expansion_head_version,
         expansion.checksum AS expansion_checksum,
         expansion.updated_state_revision AS expansion_state_revision,
         expansion.last_reconciled_state_revision,
         expansion.last_reconciliation_run_id,
         run.id AS reconciliation_run_id,
         run.source_state_revision AS reconciliation_source_state_revision,
         run.source_event_sequence AS reconciliation_source_event_sequence,
         run.status AS reconciliation_status,
         run.mismatch_count,
         run.live_inventory_checksum, run.rebuilt_inventory_checksum,
         run.live_reservation_checksum, run.rebuilt_reservation_checksum,
         run.live_projection_checksum, run.rebuilt_journal_checksum,
         run.command_id AS reconciliation_command_id,
         run.event_id AS reconciliation_event_id,
         ledger.next_event_sequence, ledger.next_ledger_sequence
    INTO authority
  FROM public.world_runtime_heads runtime
  JOIN public.world_versions version
    ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
  JOIN public.world_economy_heads economy ON economy.world_id = runtime.world_id
  JOIN public.world_economy_expansion_heads expansion ON expansion.world_id = runtime.world_id
  JOIN public.economy_expansion_reconciliation_runs run
    ON run.world_id = expansion.world_id AND run.id = expansion.last_reconciliation_run_id
  JOIN public.world_ledger_heads ledger ON ledger.world_id = runtime.world_id
  WHERE runtime.world_id = checked_world_id
  FOR UPDATE OF runtime, economy, expansion, run, ledger;
  live_reconciliation_checksum := authority.live_projection_checksum;
  rebuilt_reconciliation_checksum := authority.rebuilt_journal_checksum;
  IF NOT FOUND
    OR authority.reconciliation_status <> 'mismatch'::economy_reconciliation_run_status
    OR authority.mismatch_count < 1
    OR authority.last_reconciliation_run_id IS DISTINCT FROM authority.reconciliation_run_id
    OR authority.last_reconciled_state_revision IS DISTINCT FROM
      authority.reconciliation_source_state_revision
    OR authority.expansion_state_revision IS DISTINCT FROM authority.state_revision
    OR authority.reconciliation_source_state_revision + 1 <> authority.state_revision
    OR authority.reconciliation_source_event_sequence + 1 <> authority.last_event_sequence
    OR authority.next_event_sequence <> authority.last_event_sequence + 1
    OR authority.next_ledger_sequence <> authority.last_ledger_sequence + 1
    OR authority.economy_checksum IS DISTINCT FROM
      public.worldgraph_economy_projection_checksum(checked_world_id)
    OR authority.expansion_checksum IS DISTINCT FROM
      public.worldgraph_economy_expansion_projection_checksum(checked_world_id)
    OR authority.projection_checksum IS DISTINCT FROM
      public.worldgraph_projection_checksum(checked_world_id, authority.state_revision)
    OR live_reconciliation_checksum = rebuilt_reconciliation_checksum
    OR NOT EXISTS (
      SELECT 1
      FROM public.command_records command
      JOIN public.domain_events event
        ON event.world_id = command.world_id AND event.command_id = command.id
      WHERE command.id = authority.reconciliation_command_id
        AND command.world_id = checked_world_id
        AND command.command_type = 'ReconcileWorldCommerceV1'
        AND command.status = 'accepted'::command_record_status
        AND command.resulting_state_revision = authority.state_revision
        AND event.id = authority.reconciliation_event_id
        AND event.event_type = 'WorldCommerceReconciledV1'
        AND event.world_event_sequence = authority.last_event_sequence
        AND event.resulting_state_revision = authority.state_revision
    )
    OR EXISTS (
      SELECT 1
      FROM public.economy_expansion_reconciliation_items evidence
      WHERE evidence.run_id = authority.reconciliation_run_id
        AND evidence.item_kind NOT IN ('inventory_quantity','inventory_reservation')
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.economy_expansion_reconciliation_items evidence
        WHERE evidence.run_id = authority.reconciliation_run_id
      ) AND (
        (SELECT count(*) FROM public.economy_expansion_reconciliation_items evidence
          WHERE evidence.run_id = authority.reconciliation_run_id) <>
        (SELECT COALESCE(sum(cardinality(item.mismatch_kinds)), 0)
          FROM public.worldgraph_commerce_projection_repair_inventory_snapshot(
            checked_world_id
          ) item)
        OR EXISTS (
          SELECT 1
          FROM public.economy_expansion_reconciliation_items evidence
          LEFT JOIN public.worldgraph_commerce_projection_repair_inventory_snapshot(
            checked_world_id
          ) item ON item.inventory_id::text = evidence.item_key
          WHERE evidence.run_id = authority.reconciliation_run_id
            AND (
              item.inventory_id IS NULL
              OR (evidence.item_kind = 'inventory_quantity' AND (
                evidence.expected_value::numeric IS DISTINCT FROM item.repaired_quantity
                OR evidence.actual_value::numeric IS DISTINCT FROM item.actual_quantity
                OR NOT ('quantity' = ANY(item.mismatch_kinds))
              ))
              OR (evidence.item_kind = 'inventory_reservation' AND (
                evidence.expected_value::numeric IS DISTINCT FROM
                  item.repaired_reserved_quantity
                OR evidence.actual_value::numeric IS DISTINCT FROM
                  item.actual_reserved_quantity
                OR NOT ('reservation' = ANY(item.mismatch_kinds))
              ))
            )
        )
      )
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.projection_checkpoints checkpoint
      WHERE checkpoint.world_id = checked_world_id
        AND checkpoint.projection_name = 'economy_runtime'
        AND checkpoint.last_event_sequence = authority.last_event_sequence
        AND checkpoint.checksum = authority.economy_checksum
        AND checkpoint.status = 'current'::projection_checkpoint_status
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.projection_checkpoints checkpoint
      WHERE checkpoint.world_id = checked_world_id
        AND checkpoint.projection_name = 'economy_closed_loop'
        AND checkpoint.last_event_sequence = authority.last_event_sequence
        AND checkpoint.checksum = authority.expansion_checksum
        AND checkpoint.status = 'current'::projection_checkpoint_status
    ) THEN
    RAISE EXCEPTION 'commerce projection repair requires the unchanged latest mismatch authority'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO repairable_count
  FROM public.worldgraph_commerce_projection_repair_inventory_snapshot(checked_world_id);
  IF repairable_count NOT BETWEEN 1 AND 10000 OR EXISTS (
    SELECT 1
    FROM public.worldgraph_commerce_projection_repair_inventory_snapshot(checked_world_id) item
    JOIN public.inventories inventory ON inventory.id = item.inventory_id
    JOIN public.resource_types resource
      ON resource.world_id = inventory.world_id AND resource.id = inventory.resource_type_id
    WHERE item.repaired_quantity < 0
      OR item.repaired_reserved_quantity < 0
      OR item.repaired_reserved_quantity > item.repaired_quantity
      OR item.repaired_quantity >= 1000000000000000000::numeric
      OR item.repaired_reserved_quantity >= 1000000000000000000::numeric
      OR NOT public.worldgraph_quantity_fits_scale_v1(
        item.repaired_quantity, resource.quantity_scale
      )
      OR NOT public.worldgraph_quantity_fits_scale_v1(
        item.repaired_reserved_quantity, resource.quantity_scale
      )
  ) THEN
    RAISE EXCEPTION 'commerce mismatch is not a bounded inventory projection repair'
      USING ERRCODE = '55000';
  END IF;
  SELECT jsonb_agg(jsonb_build_object(
    'actualQuantity', item.actual_quantity::numeric(30,12)::text,
    'actualReservedQuantity', item.actual_reserved_quantity::numeric(30,12)::text,
    'expectedRowVersion', item.expected_row_version::text,
    'inventoryId', item.inventory_id::text,
    'itemOrdinal', item.item_ordinal,
    'mismatchKinds', to_jsonb(item.mismatch_kinds),
    'repairFactId', item.repair_fact_id::text,
    'repairedQuantity', item.repaired_quantity::numeric(30,12)::text,
    'repairedReservedQuantity', item.repaired_reserved_quantity::numeric(30,12)::text
  ) ORDER BY item.inventory_id)
  INTO plan_items
  FROM (
    SELECT snapshot.*,
           (row_number() OVER (ORDER BY snapshot.inventory_id) - 1)::integer AS item_ordinal,
           extensions.gen_random_uuid() AS repair_fact_id
    FROM public.worldgraph_commerce_projection_repair_inventory_snapshot(
      checked_world_id
    ) snapshot
  ) item;
  plan_body := jsonb_build_object(
    'domain', 'worldgraph.commerce-projection-repair-plan.v1',
    'expiresAt', to_char(
      (prepared_time + interval '15 minutes') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'items', plan_items,
    'preparedAt', to_char(
      prepared_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'preparedByUserId', checked_prepared_by_user_id::text,
    'reason', checked_reason,
    'repairPlanId', repair_plan_id::text,
    'repairPlanSchemaVersion', 1,
    'reservedCommandId', reserved_command_id::text,
    'reservedEventId', reserved_event_id::text,
    'reservedLedgerEntryId', reserved_ledger_entry_id::text,
    'sourceEconomyChecksum', encode(authority.economy_checksum, 'hex'),
    'sourceEconomyHeadVersion', authority.economy_head_version::text,
    'sourceEventSequence', authority.last_event_sequence::text,
    'sourceExpansionChecksum', encode(authority.expansion_checksum, 'hex'),
    'sourceExpansionHeadVersion', authority.expansion_head_version::text,
    'sourceLedgerSequence', authority.last_ledger_sequence::text,
    'sourceReconciliationLiveChecksum', encode(live_reconciliation_checksum, 'hex'),
    'sourceReconciliationRebuiltChecksum', encode(rebuilt_reconciliation_checksum, 'hex'),
    'sourceReconciliationRunId', authority.reconciliation_run_id::text,
    'sourceStateRevision', authority.state_revision::text,
    'sourceWorldVersion', authority.world_version::text,
    'worldId', checked_world_id::text
  );
  plan_hash_value := extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
    jsonb_build_object(
      'domain', 'worldgraph.commerce-projection-repair-plan-hash.v1',
      'plan', plan_body
    )
  ), 'UTF8'), 'sha256');

  INSERT INTO public.security_audit_records(
    id, actor_user_id, world_id, category, action, outcome, reason_code,
    target_type, target_id, request_id, correlation_id, redacted_metadata,
    occurred_at
  ) VALUES (
    preparation_audit_id, checked_prepared_by_user_id, checked_world_id,
    'commerce_projection_repair', 'commerce_projection.repair.prepare',
    'succeeded', 'COMMERCE_PROJECTION_REPAIR_PREPARED',
    'commerce_projection_repair_plan', repair_plan_id, repair_plan_id::text,
    repair_plan_id::text, jsonb_build_object(
      'affectedInventoryCount', repairable_count,
      'planHash', encode(plan_hash_value, 'hex'),
      'sourceReconciliationRunId', authority.reconciliation_run_id::text
    ), prepared_time
  );
  PERFORM set_config(
    'worldgraph.commerce_projection_repair_plan_id', repair_plan_id::text, true
  );
  INSERT INTO public.commerce_projection_repair_plans(
    id, world_id, repair_plan_schema_version,
    reserved_command_id, reserved_event_id, reserved_ledger_entry_id,
    source_world_version, source_state_revision, source_event_sequence,
    source_ledger_sequence, source_economy_head_version, source_economy_checksum,
    source_expansion_head_version, source_expansion_checksum,
    source_reconciliation_run_id, source_reconciliation_live_checksum,
    source_reconciliation_rebuilt_checksum, reason, prepared_by_user_id,
    preparation_audit_id, plan_hash, prepared_at, expires_at
  ) VALUES (
    repair_plan_id, checked_world_id, 1,
    reserved_command_id, reserved_event_id, reserved_ledger_entry_id,
    authority.world_version, authority.state_revision, authority.last_event_sequence,
    authority.last_ledger_sequence, authority.economy_head_version,
    authority.economy_checksum, authority.expansion_head_version,
    authority.expansion_checksum, authority.reconciliation_run_id,
    live_reconciliation_checksum, rebuilt_reconciliation_checksum, checked_reason,
    checked_prepared_by_user_id, preparation_audit_id, plan_hash_value,
    prepared_time, prepared_time + interval '15 minutes'
  );
  INSERT INTO public.commerce_projection_repair_plan_items(
    repair_plan_id, world_id, item_ordinal, inventory_id, repair_fact_id,
    expected_row_version, actual_quantity, actual_reserved_quantity,
    repaired_quantity, repaired_reserved_quantity, mismatch_kinds
  )
  SELECT repair_plan_id, checked_world_id,
         (item.value ->> 'itemOrdinal')::integer,
         (item.value ->> 'inventoryId')::uuid,
         (item.value ->> 'repairFactId')::uuid,
         (item.value ->> 'expectedRowVersion')::bigint,
         (item.value ->> 'actualQuantity')::numeric,
         (item.value ->> 'actualReservedQuantity')::numeric,
         (item.value ->> 'repairedQuantity')::numeric,
         (item.value ->> 'repairedReservedQuantity')::numeric,
         ARRAY(SELECT jsonb_array_elements_text(item.value -> 'mismatchKinds'))
  FROM jsonb_array_elements(plan_items) item(value)
  ORDER BY (item.value ->> 'itemOrdinal')::integer;
  RETURN plan_body || jsonb_build_object('planHash', encode(plan_hash_value, 'hex'));
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_prepare_commerce_projection_repair(uuid,uuid,text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_approve_commerce_projection_repair(
  checked_repair_plan_id uuid,
  checked_approver_user_id uuid,
  checked_approval_id uuid,
  checked_plan_hash text,
  checked_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  plan_record record;
  existing_approval record;
  approval_audit_id uuid := extensions.gen_random_uuid();
  approval_time timestamptz := date_trunc('milliseconds', clock_timestamp());
  approval_document jsonb;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'commerce projection repair approval requires the database owner session'
      USING ERRCODE = '42501';
  END IF;
  IF checked_repair_plan_id IS NULL OR checked_approver_user_id IS NULL
    OR checked_approval_id IS NULL
    OR checked_plan_hash IS NULL OR checked_plan_hash !~ '^[a-f0-9]{64}$'
    OR checked_confirmation IS DISTINCT FROM 'APPROVE APPEND-ONLY COMMERCE REPAIR' THEN
    RAISE EXCEPTION 'commerce projection repair approval inputs are invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT plan.* INTO plan_record
  FROM public.commerce_projection_repair_plans plan
  WHERE plan.id = checked_repair_plan_id FOR UPDATE;
  IF NOT FOUND OR plan_record.plan_hash IS DISTINCT FROM decode(checked_plan_hash, 'hex') THEN
    RAISE EXCEPTION 'commerce projection repair plan hash does not match'
      USING ERRCODE = '55000';
  END IF;
  SELECT approval.* INTO existing_approval
  FROM public.commerce_projection_repair_approvals approval
  WHERE approval.repair_plan_id = plan_record.id;
  IF FOUND THEN
    IF existing_approval.id IS DISTINCT FROM checked_approval_id
      OR existing_approval.approver_user_id IS DISTINCT FROM checked_approver_user_id
      OR existing_approval.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash THEN
      RAISE EXCEPTION 'commerce projection repair plan already has another approval'
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'approvalId', existing_approval.id::text,
      'approvedAt', to_char(existing_approval.approved_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'approverUserId', existing_approval.approver_user_id::text,
      'planHash', encode(existing_approval.approved_plan_hash, 'hex'),
      'repairPlanId', plan_record.id::text,
      'worldId', plan_record.world_id::text
    );
  END IF;
  IF approval_time >= plan_record.expires_at
    OR checked_approver_user_id = plan_record.prepared_by_user_id
    OR checked_approval_id IN (
      plan_record.id, plan_record.reserved_command_id,
      plan_record.reserved_event_id, plan_record.reserved_ledger_entry_id
    )
    OR EXISTS (
      SELECT 1 FROM public.commerce_projection_repair_plan_items item
      WHERE item.repair_plan_id = plan_record.id
        AND item.repair_fact_id = checked_approval_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.users operator
      WHERE operator.id = checked_approver_user_id
        AND operator.status = 'active'::user_status
        AND operator.platform_role = 'platform_admin'::platform_role
    ) THEN
    RAISE EXCEPTION 'commerce projection repair approval requires a distinct active administrator'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.security_audit_records(
    id, actor_user_id, world_id, category, action, outcome, reason_code,
    target_type, target_id, request_id, correlation_id, redacted_metadata,
    occurred_at
  ) VALUES (
    approval_audit_id, checked_approver_user_id, plan_record.world_id,
    'commerce_projection_repair', 'commerce_projection.repair.approve',
    'allowed', 'COMMERCE_PROJECTION_REPAIR_APPROVED',
    'commerce_projection_repair_plan', plan_record.id, checked_approval_id::text,
    plan_record.id::text, jsonb_build_object(
      'approvalId', checked_approval_id::text,
      'planHash', checked_plan_hash
    ), approval_time
  );
  INSERT INTO public.creator_override_records(
    id, world_id, actor_user_id, action, target_type, target_id, reason,
    authority_rule_id, command_id, audit_record_id, created_at
  ) VALUES (
    checked_approval_id, plan_record.world_id, checked_approver_user_id,
    'commerce_projection.repair.approve', 'commerce_projection_repair_plan',
    plan_record.id, 'Approved append-only commerce projection repair',
    'operations.commerce_projection.repair.execute',
    plan_record.reserved_command_id, approval_audit_id, approval_time
  );
  PERFORM set_config(
    'worldgraph.commerce_projection_repair_plan_id', plan_record.id::text, true
  );
  INSERT INTO public.commerce_projection_repair_approvals(
    id, repair_plan_id, world_id, approver_user_id, approved_plan_hash,
    override_id, audit_record_id, approved_at
  ) VALUES (
    checked_approval_id, plan_record.id, plan_record.world_id,
    checked_approver_user_id, plan_record.plan_hash, checked_approval_id,
    approval_audit_id, approval_time
  );
  approval_document := jsonb_build_object(
    'approvalId', checked_approval_id::text,
    'approvedAt', to_char(approval_time AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'approverUserId', checked_approver_user_id::text,
    'planHash', checked_plan_hash,
    'repairPlanId', plan_record.id::text,
    'worldId', plan_record.world_id::text
  );
  RETURN approval_document;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_approve_commerce_projection_repair(uuid,uuid,uuid,text,text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_commerce_projection_repair_approval()
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
  FROM public.commerce_projection_repair_approvals approval WHERE approval.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT plan.* INTO plan_record
  FROM public.commerce_projection_repair_plans plan
  WHERE plan.id = approval_record.repair_plan_id
    AND plan.world_id = approval_record.world_id;
  IF plan_record.id IS NULL
    OR approval_record.approver_user_id = plan_record.prepared_by_user_id
    OR approval_record.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash
    OR approval_record.approved_at < plan_record.prepared_at
    OR approval_record.approved_at >= plan_record.expires_at
    OR NOT EXISTS (
      SELECT 1 FROM public.users operator
      WHERE operator.id = approval_record.approver_user_id
        AND operator.status = 'active'::user_status
        AND operator.platform_role = 'platform_admin'::platform_role
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.creator_override_records override
      JOIN public.security_audit_records audit
        ON audit.id = override.audit_record_id
       AND audit.world_id = override.world_id
       AND audit.actor_user_id = override.actor_user_id
      WHERE override.id = approval_record.override_id
        AND override.world_id = approval_record.world_id
        AND override.actor_user_id = approval_record.approver_user_id
        AND override.action = 'commerce_projection.repair.approve'
        AND override.target_type = 'commerce_projection_repair_plan'
        AND override.target_id = approval_record.repair_plan_id
        AND override.reason = 'Approved append-only commerce projection repair'
        AND override.authority_rule_id =
          'operations.commerce_projection.repair.execute'
        AND override.command_id = plan_record.reserved_command_id
        AND override.audit_record_id = approval_record.audit_record_id
        AND override.created_at = approval_record.approved_at
        AND audit.category = 'commerce_projection_repair'
        AND audit.action = 'commerce_projection.repair.approve'
        AND audit.outcome = 'allowed'
        AND audit.reason_code = 'COMMERCE_PROJECTION_REPAIR_APPROVED'
        AND audit.target_type = 'commerce_projection_repair_plan'
        AND audit.target_id = approval_record.repair_plan_id
        AND audit.redacted_metadata = jsonb_build_object(
          'approvalId', approval_record.id::text,
          'planHash', encode(approval_record.approved_plan_hash, 'hex')
        )
    ) THEN
    RAISE EXCEPTION 'commerce projection repair approval is not its exact independent seal'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_projection_repair_approval_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commerce_projection_repair_approvals_require_exact_seal
  AFTER INSERT ON commerce_projection_repair_approvals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_projection_repair_approval();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_commerce_projection_repair_approval()
  FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_commerce_fact()
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
      'InitializeWorldCommerceV1','CompleteProductionRunV1','PurchaseMarketListingV1'
    ))
    OR (TG_TABLE_NAME = 'production_run_transitions' AND checked_command_type NOT IN (
      'StartProductionRunV1','CompleteProductionRunV1'
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
REVOKE ALL ON FUNCTION worldgraph_protect_commerce_fact() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_commerce_projection()
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
    'terminal_event_id','terminal_reason','terminal_state_revision','completed_at',
    'accepted_command_id','accepted_event_id','accepted_state_revision','ended_at',
    'financial_transaction_id','error_code','remaining_quantity',
    'last_reconciled_state_revision','last_reconciliation_run_id',
    'reconciliation_status','checksum','terminal_at'
  ];
  immutable_old := to_jsonb(OLD) - ARRAY[
    'status','row_version','updated_state_revision','updated_at','closed_at',
    'quantity','reserved_quantity','failure_code','terminal_command_id',
    'terminal_event_id','terminal_reason','terminal_state_revision','completed_at',
    'accepted_command_id','accepted_event_id','accepted_state_revision','ended_at',
    'financial_transaction_id','error_code','remaining_quantity',
    'last_reconciled_state_revision','last_reconciliation_run_id',
    'reconciliation_status','checksum','terminal_at'
  ];
  IF immutable_new IS DISTINCT FROM immutable_old THEN
    RAISE EXCEPTION '% immutable identity or terms changed', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF checked_command_type = 'RepairEconomicProjectionV1'
    AND TG_TABLE_NAME NOT IN ('inventories','world_economy_expansion_heads') THEN
    RAISE EXCEPTION 'commerce projection repair may update only inventories and its head'
      USING ERRCODE = '55000';
  END IF;
  IF (TG_TABLE_NAME = 'businesses'
      AND checked_command_type <> 'ConfigureBusinessFacilityV1')
    OR (TG_TABLE_NAME = 'business_facilities'
      AND checked_command_type <> 'ConfigureBusinessFacilityV1')
    OR (TG_TABLE_NAME = 'inventories' AND checked_command_type NOT IN (
      'StartProductionRunV1','CompleteProductionRunV1','CreateMarketListingV1',
      'CancelMarketListingV1','PurchaseMarketListingV1','ExpireMarketListingV1',
      'RepairEconomicProjectionV1'))
    OR (TG_TABLE_NAME = 'production_runs' AND checked_command_type NOT IN (
      'StartProductionRunV1','CompleteProductionRunV1'))
    OR (TG_TABLE_NAME = 'employment_contracts' AND checked_command_type NOT IN (
      'AcceptEmploymentContractV1','EndEmploymentContractV1'))
    OR (TG_TABLE_NAME = 'payroll_records'
      AND checked_command_type <> 'SettlePayrollV1')
    OR (TG_TABLE_NAME = 'market_listings' AND checked_command_type NOT IN (
      'PurchaseMarketListingV1','CancelMarketListingV1','ExpireMarketListingV1'))
    OR (TG_TABLE_NAME = 'inventory_reservations' AND checked_command_type NOT IN (
      'CompleteProductionRunV1','PurchaseMarketListingV1','CancelMarketListingV1',
      'ExpireMarketListingV1'))
    OR (TG_TABLE_NAME = 'world_economy_expansion_heads'
      AND checked_command_type = 'InitializeWorldCommerceV1') THEN
    RAISE EXCEPTION '% projection update is outside its exact command', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_protect_commerce_projection() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  row_value jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  checked_world_id uuid := (row_value ->> 'world_id')::uuid;
  checked_command_type text;
BEGIN
  SELECT command.command_type INTO checked_command_type
  FROM public.command_records command
  WHERE command.id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    AND command.world_id = checked_world_id
    AND command.status = 'received'::command_record_status;
  IF checked_command_type = 'RepairEconomicProjectionV1' THEN
    RAISE EXCEPTION 'commerce projection repair cannot mutate M08 core economy state'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER currencies_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON currencies
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER currency_supply_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON currency_supply
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER wallets_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_balances_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON wallet_balances
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER financial_transactions_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON financial_transactions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_postings_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON wallet_postings
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER assets_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER asset_ownership_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON asset_ownership
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER asset_transfers_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON asset_transfers
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER asset_transfer_offers_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON asset_transfer_offers
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER world_economy_heads_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON world_economy_heads
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER economy_reconciliation_runs_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON economy_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
CREATE TRIGGER economy_participant_history_block_commerce_projection_repair
  BEFORE INSERT OR UPDATE OR DELETE ON economy_participant_history
  FOR EACH ROW EXECUTE FUNCTION worldgraph_block_commerce_projection_repair_core_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_block_commerce_projection_repair_core_mutation()
  FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_commerce_domain_event()
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
    WHEN 'PerformJobV1' THEN NEW.event_type IN ('WorkRecordedV1','ScheduledActionCreatedV1')
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
    WHEN 'RepairEconomicProjectionV1' THEN
      NEW.event_type = 'WorldCommerceProjectionRepairedV1'
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
      'TreasuryRevenueRecordedV1','WorldCommerceReconciledV1',
      'WorldCommerceProjectionRepairedV1'
    ) AND (NOT COALESCE(event_allowed,false)
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id,NEW.command_id)) THEN
    RAISE EXCEPTION 'reserved commerce event namespace requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_protect_commerce_domain_event() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_execute_commerce_projection_repair(
  checked_repair_plan_id uuid,
  checked_executing_user_id uuid,
  checked_plan_hash text,
  checked_confirmation text
)
RETURNS TABLE (
  repair_plan_id uuid,
  command_id uuid,
  event_id uuid,
  ledger_entry_id uuid,
  reconciliation_run_id uuid,
  repair_fact_count integer,
  resulting_checksum bytea,
  resulting_event_sequence bigint,
  resulting_ledger_sequence bigint,
  resulting_state_revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  plan_record record;
  approval_record record;
  prior_execution record;
  authority record;
  execution_id_value uuid := extensions.gen_random_uuid();
  reconciliation_run_id_value uuid := extensions.gen_random_uuid();
  execution_audit_id_value uuid := extensions.gen_random_uuid();
  outbox_id_value uuid := extensions.gen_random_uuid();
  execution_time timestamptz;
  next_state_revision_value bigint;
  next_event_sequence_value bigint;
  next_ledger_sequence_value bigint;
  aggregate_version_value bigint;
  current_tick_value bigint;
  expected_count integer;
  changed_count integer;
  current_items jsonb;
  plan_document jsonb;
  command_payload jsonb;
  event_payload jsonb;
  event_metadata jsonb;
  event_hash_value bytea;
  ledger_details jsonb;
  ledger_hash_value bytea;
  graph_checksum_value bytea;
  expansion_checksum_value bytea;
  reconciliation_snapshot jsonb;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'commerce projection repair execution requires the database owner session'
      USING ERRCODE = '42501';
  END IF;
  IF checked_repair_plan_id IS NULL OR checked_executing_user_id IS NULL
    OR checked_plan_hash IS NULL OR checked_plan_hash !~ '^[a-f0-9]{64}$'
    OR checked_confirmation IS DISTINCT FROM 'APPLY APPEND-ONLY COMMERCE REPAIR' THEN
    RAISE EXCEPTION 'commerce projection repair execution inputs are invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT plan.* INTO plan_record
  FROM public.commerce_projection_repair_plans plan
  WHERE plan.id = checked_repair_plan_id FOR UPDATE;
  IF NOT FOUND OR plan_record.plan_hash IS DISTINCT FROM decode(checked_plan_hash, 'hex') THEN
    RAISE EXCEPTION 'commerce projection repair plan hash does not match'
      USING ERRCODE = '55000';
  END IF;
  SELECT execution.* INTO prior_execution
  FROM public.commerce_projection_repair_executions execution
  WHERE execution.repair_plan_id = plan_record.id;
  IF FOUND THEN
    IF prior_execution.executed_by_user_id IS DISTINCT FROM checked_executing_user_id THEN
      RAISE EXCEPTION 'commerce projection repair was executed by another administrator'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT
      prior_execution.repair_plan_id,
      prior_execution.command_id,
      prior_execution.event_id,
      prior_execution.ledger_entry_id,
      prior_execution.reconciliation_run_id,
      prior_execution.repair_fact_count,
      prior_execution.resulting_checksum,
      prior_execution.resulting_event_sequence,
      prior_execution.resulting_ledger_sequence,
      prior_execution.resulting_state_revision;
    RETURN;
  END IF;
  SELECT approval.* INTO approval_record
  FROM public.commerce_projection_repair_approvals approval
  WHERE approval.repair_plan_id = plan_record.id FOR UPDATE;
  IF NOT FOUND
    OR approval_record.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash
    OR approval_record.approver_user_id IS DISTINCT FROM checked_executing_user_id
    OR checked_executing_user_id = plan_record.prepared_by_user_id
    OR NOT EXISTS (
      SELECT 1 FROM public.users operator
      WHERE operator.id = checked_executing_user_id
        AND operator.status = 'active'::user_status
        AND operator.platform_role = 'platform_admin'::platform_role
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.users preparer
      WHERE preparer.id = plan_record.prepared_by_user_id
        AND preparer.status = 'active'::user_status
        AND preparer.platform_role = 'platform_admin'::platform_role
    ) THEN
    RAISE EXCEPTION 'commerce projection repair execution requires its active independent approver'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.worldgraph_lock_world_compilation(plan_record.world_id);
  SELECT runtime.state_revision, runtime.last_event_sequence,
         runtime.last_ledger_sequence, runtime.projection_checksum,
         version.version_number AS world_version,
         economy.row_version AS economy_head_version,
         economy.checksum AS economy_checksum,
         expansion.row_version AS expansion_head_version,
         expansion.checksum AS expansion_checksum,
         expansion.updated_state_revision AS expansion_state_revision,
         expansion.last_reconciliation_run_id,
         expansion.last_reconciled_state_revision,
         run.status AS reconciliation_status,
         run.live_inventory_checksum, run.rebuilt_inventory_checksum,
         run.live_reservation_checksum, run.rebuilt_reservation_checksum,
         run.live_projection_checksum, run.rebuilt_journal_checksum,
         run.event_id AS source_reconciliation_event_id,
         ledger.next_event_sequence, ledger.next_ledger_sequence,
         COALESCE(ledger.last_entry_hash, decode(repeat('00',32),'hex'))
           AS previous_ledger_hash,
         clock.current_tick
    INTO authority
  FROM public.world_runtime_heads runtime
  JOIN public.world_versions version
    ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
  JOIN public.world_economy_heads economy ON economy.world_id = runtime.world_id
  JOIN public.world_economy_expansion_heads expansion ON expansion.world_id = runtime.world_id
  JOIN public.economy_expansion_reconciliation_runs run
    ON run.world_id = expansion.world_id AND run.id = expansion.last_reconciliation_run_id
  JOIN public.world_ledger_heads ledger ON ledger.world_id = runtime.world_id
  JOIN public.world_simulation_clocks clock ON clock.world_id = runtime.world_id
  WHERE runtime.world_id = plan_record.world_id
  FOR UPDATE OF runtime, economy, expansion, run, ledger, clock;
  execution_time := date_trunc('milliseconds', clock_timestamp());
  IF execution_time >= plan_record.expires_at THEN
    RAISE EXCEPTION 'commerce projection repair plan has expired' USING ERRCODE = '55000';
  END IF;
  IF authority.state_revision IS NULL
    OR authority.state_revision IS DISTINCT FROM plan_record.source_state_revision
    OR authority.last_event_sequence IS DISTINCT FROM plan_record.source_event_sequence
    OR authority.last_ledger_sequence IS DISTINCT FROM plan_record.source_ledger_sequence
    OR authority.world_version IS DISTINCT FROM plan_record.source_world_version
    OR authority.economy_head_version IS DISTINCT FROM
      plan_record.source_economy_head_version
    OR authority.economy_checksum IS DISTINCT FROM plan_record.source_economy_checksum
    OR authority.expansion_head_version IS DISTINCT FROM
      plan_record.source_expansion_head_version
    OR authority.expansion_checksum IS DISTINCT FROM plan_record.source_expansion_checksum
    OR authority.expansion_state_revision IS DISTINCT FROM plan_record.source_state_revision
    OR authority.last_reconciliation_run_id IS DISTINCT FROM
      plan_record.source_reconciliation_run_id
    OR authority.reconciliation_status <> 'mismatch'::economy_reconciliation_run_status
    OR authority.live_projection_checksum IS DISTINCT FROM
      plan_record.source_reconciliation_live_checksum
    OR authority.rebuilt_journal_checksum IS DISTINCT FROM
      plan_record.source_reconciliation_rebuilt_checksum
    OR authority.next_event_sequence <> authority.last_event_sequence + 1
    OR authority.next_ledger_sequence <> authority.last_ledger_sequence + 1
    OR authority.projection_checksum IS DISTINCT FROM
      public.worldgraph_projection_checksum(plan_record.world_id, authority.state_revision)
    OR authority.economy_checksum IS DISTINCT FROM
      public.worldgraph_economy_projection_checksum(plan_record.world_id)
    OR authority.expansion_checksum IS DISTINCT FROM
      public.worldgraph_economy_expansion_projection_checksum(plan_record.world_id)
    OR EXISTS (
      SELECT 1 FROM public.command_records command
      WHERE command.id = plan_record.reserved_command_id
    ) THEN
    RAISE EXCEPTION 'commerce projection repair authority changed after preparation'
      USING ERRCODE = '55000';
  END IF;

  plan_document := public.worldgraph_commerce_projection_repair_plan_document(plan_record.id);
  SELECT jsonb_agg(jsonb_build_object(
    'actualQuantity', snapshot.actual_quantity::numeric(30,12)::text,
    'actualReservedQuantity', snapshot.actual_reserved_quantity::numeric(30,12)::text,
    'expectedRowVersion', snapshot.expected_row_version::text,
    'inventoryId', snapshot.inventory_id::text,
    'itemOrdinal', item.item_ordinal,
    'mismatchKinds', to_jsonb(snapshot.mismatch_kinds),
    'repairFactId', item.repair_fact_id::text,
    'repairedQuantity', snapshot.repaired_quantity::numeric(30,12)::text,
    'repairedReservedQuantity',
      snapshot.repaired_reserved_quantity::numeric(30,12)::text
  ) ORDER BY snapshot.inventory_id), count(*)
  INTO current_items, changed_count
  FROM public.worldgraph_commerce_projection_repair_inventory_snapshot(
    plan_record.world_id
  ) snapshot
  JOIN public.commerce_projection_repair_plan_items item
    ON item.repair_plan_id = plan_record.id
   AND item.inventory_id = snapshot.inventory_id;
  SELECT count(*) INTO expected_count
  FROM public.commerce_projection_repair_plan_items item
  WHERE item.repair_plan_id = plan_record.id;
  IF changed_count <> expected_count
    OR current_items IS DISTINCT FROM plan_document -> 'items' THEN
    RAISE EXCEPTION 'commerce projection repair inventory deltas changed after preparation'
      USING ERRCODE = '40001';
  END IF;

  next_state_revision_value := authority.state_revision + 1;
  next_event_sequence_value := authority.next_event_sequence;
  next_ledger_sequence_value := authority.next_ledger_sequence;
  current_tick_value := authority.current_tick;
  aggregate_version_value := 1;
  IF EXISTS (
    SELECT 1 FROM public.aggregate_stream_heads stream
    WHERE stream.world_id = plan_record.world_id
      AND stream.aggregate_type = 'world_commerce_repair'
      AND stream.aggregate_id = plan_record.id::text
  ) THEN
    RAISE EXCEPTION 'commerce projection repair aggregate identity is already allocated'
      USING ERRCODE = '55000';
  END IF;
  command_payload := jsonb_build_object(
    'confirmation', checked_confirmation,
    'repairPlanHash', checked_plan_hash,
    'repairPlanId', plan_record.id::text,
    'sourceReconciliationRunId', plan_record.source_reconciliation_run_id::text
  );
  INSERT INTO public.command_records(
    id, world_id, command_type, command_schema_version, actor_type, actor_id,
    payload, payload_hash, payload_classification, idempotency_key, request_hash,
    expected_world_version, expected_state_revision, expected_aggregate_version,
    correlation_id, causation_id, requested_at
  ) VALUES (
    plan_record.reserved_command_id, plan_record.world_id,
    'RepairEconomicProjectionV1', 1, 'platform_admin',
    checked_executing_user_id::text, command_payload,
    extensions.digest(convert_to(
      public.worldgraph_canonical_jsonb(command_payload), 'UTF8'
    ), 'sha256'), 'private',
    'commerce-projection-repair-' || plan_record.id::text,
    extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
      jsonb_build_object(
        'actorId', checked_executing_user_id::text,
        'actorType', 'platform_admin',
        'commandType', 'RepairEconomicProjectionV1',
        'payload', command_payload,
        'worldId', plan_record.world_id::text
      )
    ), 'UTF8'), 'sha256'),
    plan_record.source_world_version, plan_record.source_state_revision, 0,
    plan_record.reserved_command_id, plan_record.id, execution_time
  );
  PERFORM public.worldgraph_open_command_write(
    plan_record.reserved_command_id, plan_record.world_id
  );
  PERFORM set_config(
    'worldgraph.commerce_projection_repair_plan_id', plan_record.id::text, true
  );

  UPDATE public.inventories inventory
  SET quantity = item.repaired_quantity,
      reserved_quantity = item.repaired_reserved_quantity,
      row_version = inventory.row_version + 1,
      updated_state_revision = next_state_revision_value,
      updated_at = greatest(inventory.updated_at, execution_time)
  FROM public.commerce_projection_repair_plan_items item
  WHERE item.repair_plan_id = plan_record.id
    AND inventory.world_id = plan_record.world_id
    AND inventory.id = item.inventory_id
    AND inventory.row_version = item.expected_row_version
    AND inventory.quantity = item.actual_quantity
    AND inventory.reserved_quantity = item.actual_reserved_quantity;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> expected_count THEN
    RAISE EXCEPTION 'commerce projection repair inventory rows changed during execution'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.commerce_projection_repair_facts(
    id, repair_plan_id, world_id, item_ordinal, inventory_id,
    actual_quantity, actual_reserved_quantity, repaired_quantity,
    repaired_reserved_quantity, mismatch_kinds, source_reconciliation_run_id,
    command_id, event_id, resulting_state_revision, created_at
  )
  SELECT item.repair_fact_id, item.repair_plan_id, item.world_id,
         item.item_ordinal, item.inventory_id, item.actual_quantity,
         item.actual_reserved_quantity, item.repaired_quantity,
         item.repaired_reserved_quantity, item.mismatch_kinds,
         plan_record.source_reconciliation_run_id,
         plan_record.reserved_command_id, plan_record.reserved_event_id,
         next_state_revision_value, execution_time
  FROM public.commerce_projection_repair_plan_items item
  WHERE item.repair_plan_id = plan_record.id
  ORDER BY item.item_ordinal;

  reconciliation_snapshot :=
    public.worldgraph_reconcile_economy_expansion(plan_record.world_id);
  IF (reconciliation_snapshot ->> 'matched')::boolean IS DISTINCT FROM true
    OR (reconciliation_snapshot ->> 'mismatchCount')::integer <> 0 THEN
    RAISE EXCEPTION 'commerce projection repair did not rebuild to a matched projection'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_projection_repair_reconciles';
  END IF;
  expansion_checksum_value :=
    public.worldgraph_economy_expansion_projection_checksum(plan_record.world_id);
  INSERT INTO public.economy_expansion_reconciliation_runs(
    id, world_id, reconciliation_schema_version, source_state_revision,
    source_event_sequence, status, live_inventory_checksum,
    rebuilt_inventory_checksum, live_reservation_checksum,
    rebuilt_reservation_checksum, live_trade_checksum, rebuilt_trade_checksum,
    live_payroll_checksum, rebuilt_payroll_checksum, live_tax_checksum,
    rebuilt_tax_checksum, live_projection_checksum, rebuilt_journal_checksum,
    resource_count, inventory_count, trade_count, assessment_count,
    mismatch_count, command_id, event_id, created_at
  ) VALUES (
    reconciliation_run_id_value, plan_record.world_id, 2,
    next_state_revision_value, next_event_sequence_value,
    'matched',
    decode(reconciliation_snapshot ->> 'liveInventoryChecksum','hex'),
    decode(reconciliation_snapshot ->> 'rebuiltInventoryChecksum','hex'),
    decode(reconciliation_snapshot ->> 'liveReservationChecksum','hex'),
    decode(reconciliation_snapshot ->> 'rebuiltReservationChecksum','hex'),
    decode(reconciliation_snapshot ->> 'liveTradeChecksum','hex'),
    decode(reconciliation_snapshot ->> 'rebuiltTradeChecksum','hex'),
    decode(reconciliation_snapshot ->> 'livePayrollChecksum','hex'),
    decode(reconciliation_snapshot ->> 'rebuiltPayrollChecksum','hex'),
    decode(reconciliation_snapshot ->> 'liveTaxChecksum','hex'),
    decode(reconciliation_snapshot ->> 'rebuiltTaxChecksum','hex'),
    decode(reconciliation_snapshot ->> 'liveProjectionChecksum','hex'),
    decode(reconciliation_snapshot ->> 'rebuiltJournalChecksum','hex'),
    (reconciliation_snapshot ->> 'resourceCount')::integer,
    (reconciliation_snapshot ->> 'inventoryCount')::integer,
    (reconciliation_snapshot ->> 'tradeCount')::integer,
    (reconciliation_snapshot ->> 'assessmentCount')::integer,
    0, plan_record.reserved_command_id, plan_record.reserved_event_id,
    execution_time
  );
  UPDATE public.world_economy_expansion_heads expansion
  SET checksum = expansion_checksum_value,
      row_version = expansion.row_version + 1,
      updated_state_revision = next_state_revision_value,
      reconciliation_status = 'current',
      last_reconciled_state_revision = next_state_revision_value,
      last_reconciliation_run_id = reconciliation_run_id_value,
      updated_at = greatest(expansion.updated_at, execution_time)
  WHERE expansion.world_id = plan_record.world_id
    AND expansion.row_version = plan_record.source_expansion_head_version
    AND expansion.checksum = plan_record.source_expansion_checksum;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce projection repair head changed during execution'
      USING ERRCODE = '40001';
  END IF;

  event_payload := jsonb_build_object(
    'affectedInventoryCount', expected_count,
    'aggregateVersion', aggregate_version_value::text,
    'repairFactCount', expected_count,
    'repairPlanHash', checked_plan_hash,
    'repairPlanId', plan_record.id::text,
    'repairedProjectionChecksum', encode(expansion_checksum_value, 'hex'),
    'sourceReconciliationRunId', plan_record.source_reconciliation_run_id::text,
    'tick', current_tick_value::text
  );
  event_metadata := jsonb_build_object(
    'actor', jsonb_build_object(
      'actorId', checked_executing_user_id::text,
      'actorType', 'platform_admin'
    ),
    'authorizationRuleId', 'operations.commerce_projection.repair.execute',
    'causationId', plan_record.id::text,
    'commandSchemaVersion', 1,
    'commandType', 'RepairEconomicProjectionV1',
    'correlationId', plan_record.reserved_command_id::text,
    'overrideId', approval_record.override_id::text,
    'payloadClassification', 'private'
  );
  event_hash_value := public.worldgraph_domain_event_hash_v1(
    plan_record.reserved_event_id, plan_record.world_id,
    next_event_sequence_value, plan_record.reserved_command_id, 0,
    'world_commerce_repair', plan_record.id::text, aggregate_version_value,
    'WorldCommerceProjectionRepairedV1', 1, event_payload, event_metadata,
    execution_time, execution_time, next_state_revision_value
  );
  INSERT INTO public.domain_events(
    id, world_id, world_event_sequence, command_id, event_ordinal,
    aggregate_type, aggregate_id, aggregate_version, event_type,
    event_schema_version, payload, metadata, event_hash, occurred_at,
    recorded_at, resulting_state_revision
  ) VALUES (
    plan_record.reserved_event_id, plan_record.world_id,
    next_event_sequence_value, plan_record.reserved_command_id, 0,
    'world_commerce_repair', plan_record.id::text, aggregate_version_value,
    'WorldCommerceProjectionRepairedV1', 1, event_payload, event_metadata,
    event_hash_value, execution_time, execution_time, next_state_revision_value
  );

  ledger_details := jsonb_build_object(
    'affectedInventoryCount', expected_count,
    'repairPlanId', plan_record.id::text
  );
  ledger_hash_value := public.worldgraph_ledger_entry_hash_v1(
    plan_record.reserved_ledger_entry_id, plan_record.world_id,
    next_ledger_sequence_value, 'repair_anchor', plan_record.reserved_command_id,
    plan_record.reserved_event_id, 'platform_admin',
    checked_executing_user_id::text, 'COMMERCE_PROJECTION_REPAIRED',
    ledger_details, authority.previous_ledger_hash, execution_time
  );
  INSERT INTO public.ledger_entries(
    id, world_id, ledger_sequence, entry_kind, command_id, event_id,
    actor_type, actor_id, public_summary_code, redacted_details,
    previous_hash, entry_hash, recorded_at
  ) VALUES (
    plan_record.reserved_ledger_entry_id, plan_record.world_id,
    next_ledger_sequence_value, 'repair_anchor', plan_record.reserved_command_id,
    plan_record.reserved_event_id, 'platform_admin',
    checked_executing_user_id::text, 'COMMERCE_PROJECTION_REPAIRED',
    ledger_details, authority.previous_ledger_hash, ledger_hash_value,
    execution_time
  );
  INSERT INTO public.world_history_entries(
    world_id, ledger_sequence, command_id, event_id, event_type,
    history_schema_version, occurred_at, category, title_key, summary_args,
    actor_type, actor_id, target_type, target_id, visibility, correlation_id,
    resulting_state_revision
  ) VALUES (
    plan_record.world_id, next_ledger_sequence_value,
    plan_record.reserved_command_id, plan_record.reserved_event_id,
    'WorldCommerceProjectionRepairedV1', 1, execution_time, 'repair',
    'history.commerce.projection_repaired',
    jsonb_build_object('repairFactCount', expected_count),
    'platform_admin', checked_executing_user_id::text,
    'commerce_projection_repair', plan_record.id::text, 'operator',
    plan_record.reserved_command_id, next_state_revision_value
  );
  INSERT INTO public.outbox_messages(
    id, world_id, event_id, message_type, message_schema_version,
    payload, status, attempts, available_at, created_at
  ) VALUES (
    outbox_id_value, plan_record.world_id, plan_record.reserved_event_id,
    'DomainEventReferenceV1', 1, jsonb_build_object(
      'eventId', plan_record.reserved_event_id::text,
      'eventType', 'WorldCommerceProjectionRepairedV1',
      'worldEventSequence', next_event_sequence_value::text,
      'worldId', plan_record.world_id::text
    ), 'pending', 0, execution_time, execution_time
  );

  graph_checksum_value := public.worldgraph_projection_checksum(
    plan_record.world_id, next_state_revision_value
  );
  UPDATE public.projection_checkpoints checkpoint
  SET last_event_sequence = next_event_sequence_value,
      checksum = graph_checksum_value,
      status = 'current',
      updated_at = greatest(checkpoint.updated_at, execution_time)
  WHERE checkpoint.world_id = plan_record.world_id
    AND checkpoint.projection_name = 'world_graph';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce projection repair world graph checkpoint is missing'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.world_runtime_heads runtime
  SET state_revision = next_state_revision_value,
      last_event_sequence = next_event_sequence_value,
      last_ledger_sequence = next_ledger_sequence_value,
      projection_checksum = graph_checksum_value,
      updated_at = greatest(runtime.updated_at, execution_time)
  WHERE runtime.world_id = plan_record.world_id
    AND runtime.state_revision = plan_record.source_state_revision
    AND runtime.last_event_sequence = plan_record.source_event_sequence
    AND runtime.last_ledger_sequence = plan_record.source_ledger_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce projection repair runtime head changed during publication'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.security_audit_records(
    id, actor_user_id, world_id, category, action, outcome, reason_code,
    target_type, target_id, request_id, correlation_id, redacted_metadata,
    occurred_at
  ) VALUES (
    execution_audit_id_value, checked_executing_user_id, plan_record.world_id,
    'commerce_projection_repair', 'commerce_projection.repair.execute',
    'succeeded', 'COMMERCE_PROJECTION_REPAIR_EXECUTED',
    'commerce_projection_repair_plan', plan_record.id,
    plan_record.reserved_command_id::text, plan_record.id::text,
    jsonb_build_object(
      'affectedInventoryCount', expected_count,
      'planHash', checked_plan_hash,
      'reconciliationRunId', reconciliation_run_id_value::text
    ), execution_time
  );
  INSERT INTO public.commerce_projection_repair_executions(
    id, repair_plan_id, world_id, approval_id, command_id, event_id,
    ledger_entry_id, reconciliation_run_id, executed_by_user_id,
    execution_audit_id, repair_fact_count, resulting_state_revision,
    resulting_event_sequence, resulting_ledger_sequence,
    resulting_expansion_head_version, resulting_checksum, executed_at
  ) VALUES (
    execution_id_value, plan_record.id, plan_record.world_id,
    approval_record.id, plan_record.reserved_command_id,
    plan_record.reserved_event_id, plan_record.reserved_ledger_entry_id,
    reconciliation_run_id_value, checked_executing_user_id,
    execution_audit_id_value, expected_count, next_state_revision_value,
    next_event_sequence_value, next_ledger_sequence_value,
    plan_record.source_expansion_head_version + 1,
    expansion_checksum_value, execution_time
  );
  UPDATE public.command_records command
  SET status = 'accepted',
      authorization_rule_id = 'operations.commerce_projection.repair.execute',
      override_id = approval_record.override_id,
      decided_at = execution_time,
      resulting_state_revision = next_state_revision_value,
      response_summary = jsonb_build_object(
        'commandId', plan_record.reserved_command_id::text,
        'eventIds', jsonb_build_array(plan_record.reserved_event_id::text),
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
    RAISE EXCEPTION 'commerce projection repair command could not reach its terminal state'
      USING ERRCODE = '55000';
  END IF;
  PERFORM public.worldgraph_assert_commerce_command_terminal(
    plan_record.reserved_command_id
  );
  RETURN QUERY SELECT
    plan_record.id,
    plan_record.reserved_command_id,
    plan_record.reserved_event_id,
    plan_record.reserved_ledger_entry_id,
    reconciliation_run_id_value,
    expected_count,
    expansion_checksum_value,
    next_event_sequence_value,
    next_ledger_sequence_value,
    next_state_revision_value;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_execute_commerce_projection_repair(uuid,uuid,text,text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_commerce_projection_repair_execution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  execution_record record;
  plan_record record;
  approval_record record;
  command_record record;
  event_record record;
  ledger_record record;
  run_record record;
  runtime_record record;
  head_record record;
  clock_tick bigint;
  snapshot jsonb;
BEGIN
  SELECT execution.* INTO execution_record
  FROM public.commerce_projection_repair_executions execution
  WHERE execution.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT plan.* INTO plan_record
  FROM public.commerce_projection_repair_plans plan
  WHERE plan.id = execution_record.repair_plan_id
    AND plan.world_id = execution_record.world_id;
  SELECT approval.* INTO approval_record
  FROM public.commerce_projection_repair_approvals approval
  WHERE approval.id = execution_record.approval_id
    AND approval.repair_plan_id = execution_record.repair_plan_id;
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
  SELECT run.* INTO run_record
  FROM public.economy_expansion_reconciliation_runs run
  WHERE run.id = execution_record.reconciliation_run_id
    AND run.world_id = execution_record.world_id;
  SELECT runtime.* INTO runtime_record
  FROM public.world_runtime_heads runtime
  WHERE runtime.world_id = execution_record.world_id;
  SELECT head.* INTO head_record
  FROM public.world_economy_expansion_heads head
  WHERE head.world_id = execution_record.world_id;
  SELECT clock.current_tick INTO clock_tick
  FROM public.world_simulation_clocks clock
  WHERE clock.world_id = execution_record.world_id;
  snapshot := public.worldgraph_reconcile_economy_expansion(execution_record.world_id);

  IF plan_record.id IS NULL OR approval_record.id IS NULL
    OR command_record.id IS NULL OR event_record.id IS NULL
    OR ledger_record.id IS NULL OR run_record.id IS NULL
    OR runtime_record.world_id IS NULL OR head_record.world_id IS NULL
    OR clock_tick IS NULL
    OR execution_record.command_id IS DISTINCT FROM plan_record.reserved_command_id
    OR execution_record.event_id IS DISTINCT FROM plan_record.reserved_event_id
    OR execution_record.ledger_entry_id IS DISTINCT FROM
      plan_record.reserved_ledger_entry_id
    OR execution_record.executed_by_user_id IS DISTINCT FROM
      approval_record.approver_user_id
    OR execution_record.executed_by_user_id = plan_record.prepared_by_user_id
    OR approval_record.approved_plan_hash IS DISTINCT FROM plan_record.plan_hash
    OR execution_record.executed_at < approval_record.approved_at
    OR execution_record.executed_at >= plan_record.expires_at
    OR execution_record.resulting_state_revision <>
      plan_record.source_state_revision + 1
    OR execution_record.resulting_event_sequence <>
      plan_record.source_event_sequence + 1
    OR execution_record.resulting_ledger_sequence <>
      plan_record.source_ledger_sequence + 1
    OR execution_record.resulting_expansion_head_version <>
      plan_record.source_expansion_head_version + 1
    OR execution_record.repair_fact_count <> (
      SELECT count(*) FROM public.commerce_projection_repair_plan_items item
      WHERE item.repair_plan_id = plan_record.id
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.users operator
      WHERE operator.id = execution_record.executed_by_user_id
        AND operator.status = 'active'::user_status
        AND operator.platform_role = 'platform_admin'::platform_role
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.users preparer
      WHERE preparer.id = plan_record.prepared_by_user_id
        AND preparer.status = 'active'::user_status
        AND preparer.platform_role = 'platform_admin'::platform_role
    )
    OR command_record.command_type <> 'RepairEconomicProjectionV1'
    OR command_record.command_schema_version <> 1
    OR command_record.actor_type <> 'platform_admin'::command_actor_type
    OR command_record.actor_id <> execution_record.executed_by_user_id::text
    OR command_record.payload_classification <> 'private'::payload_classification
    OR command_record.payload <> jsonb_build_object(
      'confirmation', 'APPLY APPEND-ONLY COMMERCE REPAIR',
      'repairPlanHash', encode(plan_record.plan_hash, 'hex'),
      'repairPlanId', plan_record.id::text,
      'sourceReconciliationRunId', plan_record.source_reconciliation_run_id::text
    )
    OR command_record.payload_hash IS DISTINCT FROM extensions.digest(convert_to(
      public.worldgraph_canonical_jsonb(command_record.payload), 'UTF8'
    ), 'sha256')
    OR command_record.expected_world_version IS DISTINCT FROM plan_record.source_world_version
    OR command_record.expected_state_revision IS DISTINCT FROM
      plan_record.source_state_revision
    OR command_record.expected_aggregate_version IS DISTINCT FROM 0
    OR command_record.opened_state_revision IS DISTINCT FROM plan_record.source_state_revision
    OR command_record.opened_event_sequence IS DISTINCT FROM plan_record.source_event_sequence
    OR command_record.opened_ledger_sequence IS DISTINCT FROM plan_record.source_ledger_sequence
    OR command_record.opened_projection_checksum IS DISTINCT FROM
      public.worldgraph_projection_checksum(
        execution_record.world_id, plan_record.source_state_revision
      )
    OR command_record.status <> 'accepted'::command_record_status
    OR command_record.authorization_rule_id <>
      'operations.commerce_projection.repair.execute'
    OR command_record.override_id IS DISTINCT FROM approval_record.override_id
    OR command_record.correlation_id IS DISTINCT FROM plan_record.reserved_command_id
    OR command_record.causation_id IS DISTINCT FROM plan_record.id
    OR command_record.decided_at IS DISTINCT FROM execution_record.executed_at
    OR command_record.resulting_state_revision IS DISTINCT FROM
      execution_record.resulting_state_revision
    OR event_record.command_id IS DISTINCT FROM execution_record.command_id
    OR event_record.world_event_sequence <> execution_record.resulting_event_sequence
    OR event_record.event_ordinal <> 0
    OR event_record.aggregate_type <> 'world_commerce_repair'
    OR event_record.aggregate_id <> plan_record.id::text
    OR event_record.aggregate_version <> 1
    OR event_record.event_type <> 'WorldCommerceProjectionRepairedV1'
    OR event_record.event_schema_version <> 1
    OR event_record.payload <> jsonb_build_object(
      'affectedInventoryCount', execution_record.repair_fact_count,
      'aggregateVersion', '1',
      'repairFactCount', execution_record.repair_fact_count,
      'repairPlanHash', encode(plan_record.plan_hash, 'hex'),
      'repairPlanId', plan_record.id::text,
      'repairedProjectionChecksum', encode(execution_record.resulting_checksum, 'hex'),
      'sourceReconciliationRunId', plan_record.source_reconciliation_run_id::text,
      'tick', clock_tick::text
    )
    OR event_record.metadata <> jsonb_build_object(
      'actor', jsonb_build_object(
        'actorId', execution_record.executed_by_user_id::text,
        'actorType', 'platform_admin'
      ),
      'authorizationRuleId', 'operations.commerce_projection.repair.execute',
      'causationId', plan_record.id::text,
      'commandSchemaVersion', 1,
      'commandType', 'RepairEconomicProjectionV1',
      'correlationId', plan_record.reserved_command_id::text,
      'overrideId', approval_record.override_id::text,
      'payloadClassification', 'private'
    )
    OR event_record.occurred_at IS DISTINCT FROM execution_record.executed_at
    OR event_record.recorded_at IS DISTINCT FROM execution_record.executed_at
    OR event_record.resulting_state_revision <>
      execution_record.resulting_state_revision
    OR ledger_record.ledger_sequence <> execution_record.resulting_ledger_sequence
    OR ledger_record.entry_kind <> 'repair_anchor'::ledger_entry_kind
    OR ledger_record.command_id IS DISTINCT FROM execution_record.command_id
    OR ledger_record.event_id IS DISTINCT FROM execution_record.event_id
    OR ledger_record.actor_type <> 'platform_admin'::command_actor_type
    OR ledger_record.actor_id <> execution_record.executed_by_user_id::text
    OR ledger_record.public_summary_code <> 'COMMERCE_PROJECTION_REPAIRED'
    OR ledger_record.redacted_details <> jsonb_build_object(
      'affectedInventoryCount', execution_record.repair_fact_count,
      'repairPlanId', plan_record.id::text
    )
    OR ledger_record.recorded_at IS DISTINCT FROM execution_record.executed_at
    OR run_record.command_id IS DISTINCT FROM execution_record.command_id
    OR run_record.event_id IS DISTINCT FROM execution_record.event_id
    OR run_record.reconciliation_schema_version <> 2
    OR run_record.source_state_revision <> execution_record.resulting_state_revision
    OR run_record.source_event_sequence <> execution_record.resulting_event_sequence
    OR run_record.status <> 'matched'::economy_reconciliation_run_status
    OR run_record.mismatch_count <> 0
    OR run_record.live_inventory_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveInventoryChecksum','hex')
    OR run_record.rebuilt_inventory_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltInventoryChecksum','hex')
    OR run_record.live_reservation_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveReservationChecksum','hex')
    OR run_record.rebuilt_reservation_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltReservationChecksum','hex')
    OR run_record.live_trade_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveTradeChecksum','hex')
    OR run_record.rebuilt_trade_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltTradeChecksum','hex')
    OR run_record.live_payroll_checksum IS DISTINCT FROM
      decode(snapshot ->> 'livePayrollChecksum','hex')
    OR run_record.rebuilt_payroll_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltPayrollChecksum','hex')
    OR run_record.live_tax_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveTaxChecksum','hex')
    OR run_record.rebuilt_tax_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltTaxChecksum','hex')
    OR run_record.live_projection_checksum IS DISTINCT FROM
      decode(snapshot ->> 'liveProjectionChecksum','hex')
    OR run_record.rebuilt_journal_checksum IS DISTINCT FROM
      decode(snapshot ->> 'rebuiltJournalChecksum','hex')
    OR run_record.resource_count <> (snapshot ->> 'resourceCount')::integer
    OR run_record.inventory_count <> (snapshot ->> 'inventoryCount')::integer
    OR run_record.trade_count <> (snapshot ->> 'tradeCount')::integer
    OR run_record.assessment_count <> (snapshot ->> 'assessmentCount')::integer
    OR (snapshot ->> 'matched')::boolean IS DISTINCT FROM true
    OR (snapshot ->> 'mismatchCount')::integer <> 0
    OR head_record.row_version <> execution_record.resulting_expansion_head_version
    OR head_record.updated_state_revision <> execution_record.resulting_state_revision
    OR head_record.checksum IS DISTINCT FROM execution_record.resulting_checksum
    OR head_record.checksum IS DISTINCT FROM
      public.worldgraph_economy_expansion_projection_checksum(execution_record.world_id)
    OR head_record.reconciliation_status <> 'current'::economy_reconciliation_status
    OR head_record.last_reconciled_state_revision <>
      execution_record.resulting_state_revision
    OR head_record.last_reconciliation_run_id IS DISTINCT FROM
      execution_record.reconciliation_run_id
    OR runtime_record.state_revision <> execution_record.resulting_state_revision
    OR runtime_record.last_event_sequence <> execution_record.resulting_event_sequence
    OR runtime_record.last_ledger_sequence <> execution_record.resulting_ledger_sequence
    OR runtime_record.projection_checksum IS DISTINCT FROM
      public.worldgraph_projection_checksum(execution_record.world_id,
        execution_record.resulting_state_revision)
    OR EXISTS (
      SELECT 1
      FROM public.commerce_projection_repair_plan_items item
      LEFT JOIN public.commerce_projection_repair_facts fact
        ON fact.repair_plan_id = item.repair_plan_id
       AND fact.item_ordinal = item.item_ordinal
      LEFT JOIN public.inventories inventory
        ON inventory.world_id = item.world_id AND inventory.id = item.inventory_id
      WHERE item.repair_plan_id = plan_record.id
        AND (
          fact.id IS NULL OR fact.id <> item.repair_fact_id
          OR fact.world_id <> item.world_id
          OR fact.inventory_id <> item.inventory_id
          OR fact.actual_quantity <> item.actual_quantity
          OR fact.actual_reserved_quantity <> item.actual_reserved_quantity
          OR fact.repaired_quantity <> item.repaired_quantity
          OR fact.repaired_reserved_quantity <> item.repaired_reserved_quantity
          OR fact.mismatch_kinds <> item.mismatch_kinds
          OR fact.source_reconciliation_run_id <>
            plan_record.source_reconciliation_run_id
          OR fact.command_id <> execution_record.command_id
          OR fact.event_id <> execution_record.event_id
          OR fact.resulting_state_revision <> execution_record.resulting_state_revision
          OR fact.created_at <> execution_record.executed_at
          OR inventory.quantity <> item.repaired_quantity
          OR inventory.reserved_quantity <> item.repaired_reserved_quantity
          OR inventory.row_version <> item.expected_row_version + 1
          OR inventory.updated_state_revision <>
            execution_record.resulting_state_revision
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.inventories inventory
      WHERE inventory.world_id = execution_record.world_id
        AND inventory.updated_state_revision = execution_record.resulting_state_revision
        AND NOT EXISTS (
          SELECT 1 FROM public.commerce_projection_repair_facts fact
          WHERE fact.repair_plan_id = plan_record.id
            AND fact.inventory_id = inventory.id
        )
    )
    OR (SELECT count(*) FROM public.commerce_projection_repair_facts fact
        WHERE fact.repair_plan_id = plan_record.id) <>
      execution_record.repair_fact_count
    OR EXISTS (
      SELECT 1 FROM public.inventory_movements movement
      WHERE movement.command_id = execution_record.command_id
    )
    OR EXISTS (
      SELECT 1 FROM public.production_run_transitions transition
      WHERE transition.command_id = execution_record.command_id
    )
    OR (SELECT count(*) FROM public.domain_events event
        WHERE event.command_id = execution_record.command_id) <> 1
    OR (SELECT count(*) FROM public.ledger_entries entry
        WHERE entry.command_id = execution_record.command_id) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM public.world_history_entries history
      WHERE history.world_id = execution_record.world_id
        AND history.ledger_sequence = execution_record.resulting_ledger_sequence
        AND history.command_id = execution_record.command_id
        AND history.event_id = execution_record.event_id
        AND history.event_type = 'WorldCommerceProjectionRepairedV1'
        AND history.category = 'repair'
        AND history.title_key = 'history.commerce.projection_repaired'
        AND history.summary_args = jsonb_build_object(
          'repairFactCount', execution_record.repair_fact_count
        )
        AND history.actor_type = 'platform_admin'::command_actor_type
        AND history.actor_id = execution_record.executed_by_user_id::text
        AND history.target_type = 'commerce_projection_repair'
        AND history.target_id = plan_record.id::text
        AND history.visibility = 'operator'::history_visibility
        AND history.correlation_id = plan_record.reserved_command_id
        AND history.resulting_state_revision = execution_record.resulting_state_revision
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.outbox_messages message
      WHERE message.world_id = execution_record.world_id
        AND message.event_id = execution_record.event_id
        AND message.message_type = 'DomainEventReferenceV1'
        AND message.message_schema_version = 1
        AND message.payload = jsonb_build_object(
          'eventId', execution_record.event_id::text,
          'eventType', 'WorldCommerceProjectionRepairedV1',
          'worldEventSequence', execution_record.resulting_event_sequence::text,
          'worldId', execution_record.world_id::text
        )
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.security_audit_records audit
      WHERE audit.id = execution_record.execution_audit_id
        AND audit.world_id = execution_record.world_id
        AND audit.actor_user_id = execution_record.executed_by_user_id
        AND audit.category = 'commerce_projection_repair'
        AND audit.action = 'commerce_projection.repair.execute'
        AND audit.outcome = 'succeeded'
        AND audit.reason_code = 'COMMERCE_PROJECTION_REPAIR_EXECUTED'
        AND audit.target_type = 'commerce_projection_repair_plan'
        AND audit.target_id = plan_record.id
        AND audit.redacted_metadata = jsonb_build_object(
          'affectedInventoryCount', execution_record.repair_fact_count,
          'planHash', encode(plan_record.plan_hash, 'hex'),
          'reconciliationRunId', execution_record.reconciliation_run_id::text
        )
    )
    OR EXISTS (
      SELECT checkpoint.projection_name
      FROM public.projection_checkpoints checkpoint
      WHERE checkpoint.world_id = execution_record.world_id
        AND checkpoint.projection_name IN (
          'world_graph','simulation_runtime','economy_runtime','economy_closed_loop'
        )
      GROUP BY checkpoint.projection_name
      HAVING bool_or(
        checkpoint.status <> 'current'::projection_checkpoint_status
        OR checkpoint.last_event_sequence <> execution_record.resulting_event_sequence
      )
    )
    OR (SELECT count(*) FROM public.projection_checkpoints checkpoint
        WHERE checkpoint.world_id = execution_record.world_id
          AND checkpoint.projection_name IN (
            'world_graph','simulation_runtime','economy_runtime','economy_closed_loop'
          )) <> 4
  THEN
    RAISE EXCEPTION 'commerce projection repair execution is not its exact append-only effect'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_projection_repair_execution_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER commerce_projection_repair_executions_require_exact_effect
  AFTER INSERT ON commerce_projection_repair_executions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_commerce_projection_repair_execution();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_commerce_projection_repair_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.event_type = 'WorldCommerceProjectionRepairedV1' AND NOT EXISTS (
    SELECT 1 FROM public.commerce_projection_repair_executions execution
    WHERE execution.world_id = NEW.world_id
      AND execution.command_id = NEW.command_id
      AND execution.event_id = NEW.id
      AND execution.resulting_event_sequence = NEW.world_event_sequence
      AND execution.resulting_state_revision = NEW.resulting_state_revision
  ) THEN
    RAISE EXCEPTION 'commerce projection repair event lacks its exact execution receipt'
      USING ERRCODE = '23514',
        CONSTRAINT = 'commerce_projection_repair_event_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER domain_events_require_commerce_projection_repair
  AFTER INSERT ON domain_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.event_type = 'WorldCommerceProjectionRepairedV1')
  EXECUTE FUNCTION worldgraph_assert_commerce_projection_repair_event();
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  worldgraph_assert_commerce_projection_repair_execution(),
  worldgraph_assert_commerce_projection_repair_event()
  FROM PUBLIC;
--> statement-breakpoint
DO $metadata$
DECLARE changed integer;
BEGIN
  UPDATE platform_metadata
  SET value = value || jsonb_build_object('commerceProjectionRepairSchema', 1),
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 9
    AND value ->> 'runtimeSchema' = '9'
    AND value ->> 'commerceSchema' = '1'
    AND NOT value ? 'commerceProjectionRepairSchema';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact sealed M09 commerce state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_facility_asset_title_preserved()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.business_facilities facility
    JOIN public.businesses business
      ON business.world_id = facility.world_id
     AND business.id = facility.business_id
    WHERE facility.world_id = NEW.world_id
      AND facility.facility_asset_id = NEW.asset_id
      AND facility.status IN (
        'active'::business_facility_status,
        'disabled'::business_facility_status
      )
      AND business.backing_organization_entity_id <> NEW.owner_entity_id
  ) THEN
    RAISE EXCEPTION 'an assigned facility asset must remain titled to its business organization'
      USING ERRCODE = '23514',
        CONSTRAINT = 'asset_ownership_facility_title_preserved';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER asset_ownership_preserves_facility_title
  AFTER UPDATE ON asset_ownership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.owner_entity_id IS DISTINCT FROM NEW.owner_entity_id)
  EXECUTE FUNCTION worldgraph_assert_facility_asset_title_preserved();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_facility_asset_title_preserved() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_protect_scheduled_action() FROM PUBLIC;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    REVOKE ALL ON
      commerce_projection_repair_plans,
      commerce_projection_repair_plan_items,
      commerce_projection_repair_approvals,
      commerce_projection_repair_facts,
      commerce_projection_repair_executions
      FROM worldgraph_app;
    REVOKE EXECUTE ON FUNCTION
      worldgraph_commerce_projection_repair_reason_is_valid(text),
      worldgraph_commerce_projection_repair_inventory_snapshot(uuid),
      worldgraph_commerce_projection_repair_plan_document(uuid),
      worldgraph_prepare_commerce_projection_repair(uuid,uuid,text),
      worldgraph_approve_commerce_projection_repair(uuid,uuid,uuid,text,text),
      worldgraph_execute_commerce_projection_repair(uuid,uuid,text,text)
      FROM worldgraph_app;
  END IF;
END
$grant$;
--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
