SET CONSTRAINTS ALL DEFERRED;
--> statement-breakpoint
CREATE TYPE simulation_clock_mode AS ENUM ('paused', 'running', 'error');
--> statement-breakpoint
CREATE TYPE scheduled_action_status AS ENUM ('scheduled', 'completed', 'cancelled', 'failed');
--> statement-breakpoint
CREATE TYPE simulation_batch_status AS ENUM ('running', 'completed', 'failed');
--> statement-breakpoint
CREATE TYPE simulation_failure_status AS ENUM ('open', 'resolved');
--> statement-breakpoint
ALTER TABLE command_records
  ADD COLUMN expected_aggregate_version bigint,
  ADD CONSTRAINT command_records_expected_aggregate_version_valid
    CHECK (expected_aggregate_version IS NULL OR expected_aggregate_version >= 0);
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_command_expected_aggregate_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.expected_aggregate_version IS DISTINCT FROM OLD.expected_aggregate_version THEN
    RAISE EXCEPTION 'command expected aggregate version is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER command_records_expected_aggregate_version_protect
  BEFORE UPDATE ON command_records
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_command_expected_aggregate_version();
--> statement-breakpoint
CREATE TABLE world_simulation_clocks (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  clock_schema_version integer NOT NULL DEFAULT 1,
  epoch_at timestamptz NOT NULL,
  current_tick bigint NOT NULL DEFAULT 0,
  world_milliseconds_per_tick bigint NOT NULL,
  wall_cadence_milliseconds integer NOT NULL,
  mode simulation_clock_mode NOT NULL DEFAULT 'paused',
  max_batch_ticks integer NOT NULL,
  max_catch_up_ticks integer NOT NULL,
  prng_algorithm_version text NOT NULL,
  outcome_hash bytea NOT NULL,
  last_wall_anchor_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  updated_state_revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_simulation_clocks_schema_known CHECK (clock_schema_version = 1),
  CONSTRAINT world_simulation_clocks_tick_nonnegative CHECK (current_tick >= 0),
  CONSTRAINT world_simulation_clocks_world_tick_duration_bounded CHECK (
    world_milliseconds_per_tick BETWEEN 1 AND 31536000000
  ),
  CONSTRAINT world_simulation_clocks_cadence_bounded CHECK (
    wall_cadence_milliseconds BETWEEN 100 AND 86400000
  ),
  CONSTRAINT world_simulation_clocks_batch_bounds CHECK (
    max_batch_ticks BETWEEN 1 AND 256
    AND max_catch_up_ticks BETWEEN 1 AND 4096
    AND max_catch_up_ticks >= max_batch_ticks
  ),
  CONSTRAINT world_simulation_clocks_prng_known CHECK (
    prng_algorithm_version = 'xorshift32-sha256-v1'
  ),
  CONSTRAINT world_simulation_clocks_outcome_hash_length CHECK (
    octet_length(outcome_hash) = 32
  ),
  CONSTRAINT world_simulation_clocks_mode_anchor_shape CHECK (
    (mode = 'running' AND last_wall_anchor_at IS NOT NULL)
    OR (mode IN ('paused', 'error') AND last_wall_anchor_at IS NULL)
  ),
  CONSTRAINT world_simulation_clocks_versions_positive CHECK (
    row_version > 0 AND updated_state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE world_schedule_heads (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  next_schedule_sequence bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_schedule_heads_sequence_positive CHECK (next_schedule_sequence > 0)
);
--> statement-breakpoint
CREATE TABLE scheduled_actions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  schedule_sequence bigint NOT NULL,
  due_tick bigint NOT NULL,
  priority integer NOT NULL,
  action_type text NOT NULL,
  action_schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  payload_hash bytea NOT NULL,
  process_version text NOT NULL,
  status scheduled_action_status NOT NULL DEFAULT 'scheduled',
  created_by_actor_type command_actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_command_id uuid NOT NULL,
  completed_event_id uuid,
  cancelled_command_id uuid,
  created_state_revision bigint NOT NULL,
  completed_state_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_actions_world_identity UNIQUE (world_id, id),
  CONSTRAINT scheduled_actions_world_sequence_unique UNIQUE (world_id, schedule_sequence),
  CONSTRAINT scheduled_actions_completed_event_unique UNIQUE (completed_event_id),
  CONSTRAINT scheduled_actions_created_command_world_fk
    FOREIGN KEY (created_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_actions_completed_event_world_fk
    FOREIGN KEY (world_id, completed_event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_actions_cancelled_command_world_fk
    FOREIGN KEY (cancelled_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_actions_sequence_tick_valid CHECK (
    schedule_sequence > 0 AND due_tick >= 0
  ),
  CONSTRAINT scheduled_actions_priority_bounded CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT scheduled_actions_registry_known CHECK (
    action_type = 'EmitWorldNoticeV1'
    AND action_schema_version = 1
    AND process_version = '1.0.0'
  ),
  CONSTRAINT scheduled_actions_actor_bounded CHECK (
    created_by_actor_type IN ('user', 'system', 'platform_admin')
    AND char_length(created_by_actor_id) BETWEEN 3 AND 160
    AND created_by_actor_id = btrim(created_by_actor_id)
    AND created_by_actor_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT scheduled_actions_payload_safe CHECK (
    jsonb_typeof(payload) = 'object'
    AND pg_column_size(payload) <= 4096
    AND NOT worldgraph_jsonb_has_sensitive_key(payload)
    AND NOT worldgraph_jsonb_has_compiler_private_key(payload)
    AND payload = jsonb_build_object('text', payload ->> 'text', 'visibility', payload ->> 'visibility')
    AND char_length(payload ->> 'text') BETWEEN 1 AND 500
    AND translate(payload ->> 'text', E'\t\n\r', '') !~ '[[:cntrl:]]'
    AND payload ->> 'visibility' IN ('public', 'member', 'creator')
  ),
  CONSTRAINT scheduled_actions_payload_hash_valid CHECK (
    octet_length(payload_hash) = 32
    AND payload_hash = extensions.digest(
      convert_to(worldgraph_canonical_jsonb(payload), 'UTF8'), 'sha256'
    )
  ),
  CONSTRAINT scheduled_actions_revisions_valid CHECK (
    created_state_revision > 0
    AND (completed_state_revision IS NULL
      OR completed_state_revision >= created_state_revision)
  ),
  CONSTRAINT scheduled_actions_status_shape CHECK (
    (status = 'scheduled' AND completed_event_id IS NULL
      AND cancelled_command_id IS NULL AND completed_state_revision IS NULL)
    OR (status = 'completed' AND completed_event_id IS NOT NULL
      AND cancelled_command_id IS NULL AND completed_state_revision IS NOT NULL)
    OR (status = 'cancelled' AND completed_event_id IS NULL
      AND cancelled_command_id IS NOT NULL AND completed_state_revision IS NOT NULL)
    OR (status = 'failed' AND completed_event_id IS NULL
      AND cancelled_command_id IS NULL AND completed_state_revision IS NOT NULL)
  ),
  CONSTRAINT scheduled_actions_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE INDEX scheduled_actions_due_idx
  ON scheduled_actions (world_id, due_tick, priority, schedule_sequence, id)
  WHERE status = 'scheduled';
--> statement-breakpoint
CREATE INDEX scheduled_actions_world_status_cursor_idx
  ON scheduled_actions (world_id, status, due_tick, schedule_sequence, id);
--> statement-breakpoint
CREATE TABLE simulation_batch_runs (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  batch_schema_version integer NOT NULL DEFAULT 1,
  from_tick bigint NOT NULL,
  to_tick bigint NOT NULL,
  batch_key bytea NOT NULL,
  process_registry_version integer NOT NULL,
  input_checksum bytea NOT NULL,
  outcome_hash bytea,
  status simulation_batch_status NOT NULL DEFAULT 'running',
  attempts integer NOT NULL DEFAULT 1,
  command_id uuid,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT simulation_batch_runs_world_identity UNIQUE (world_id, id),
  CONSTRAINT simulation_batch_runs_batch_key_unique UNIQUE (world_id, batch_key),
  CONSTRAINT simulation_batch_runs_identity_unique UNIQUE (
    world_id, from_tick, to_tick, input_checksum, process_registry_version
  ),
  CONSTRAINT simulation_batch_runs_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT simulation_batch_runs_schema_known CHECK (batch_schema_version = 1),
  CONSTRAINT simulation_batch_runs_tick_range_valid CHECK (
    from_tick >= 0 AND (
      (to_tick > from_tick AND to_tick - from_tick BETWEEN 1 AND 256)
      OR (
        status = 'failed' AND to_tick = from_tick
        AND error_code = 'SIMULATION_INTEGER_OVERFLOW'
      )
    )
  ),
  CONSTRAINT simulation_batch_runs_registry_known CHECK (process_registry_version = 1),
  CONSTRAINT simulation_batch_runs_hash_lengths CHECK (
    octet_length(batch_key) = 32 AND octet_length(input_checksum) = 32
    AND (outcome_hash IS NULL OR octet_length(outcome_hash) = 32)
  ),
  CONSTRAINT simulation_batch_runs_attempts_bounded CHECK (attempts BETWEEN 1 AND 100),
  CONSTRAINT simulation_batch_runs_error_code_shape CHECK (
    error_code IS NULL OR (
      char_length(error_code) BETWEEN 3 AND 100
      AND error_code ~ '^[A-Z][A-Z0-9_]*$'
    )
  ),
  CONSTRAINT simulation_batch_runs_status_shape CHECK (
    (status = 'running' AND outcome_hash IS NULL AND error_code IS NULL
      AND completed_at IS NULL)
    OR (status = 'completed' AND outcome_hash IS NOT NULL AND command_id IS NOT NULL
      AND error_code IS NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND outcome_hash IS NULL AND error_code IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  CONSTRAINT simulation_batch_runs_timestamps_ordered CHECK (
    completed_at IS NULL OR completed_at >= started_at
  )
);
--> statement-breakpoint
CREATE INDEX simulation_batch_runs_world_cursor_idx
  ON simulation_batch_runs (world_id, started_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX simulation_batch_runs_running_idx
  ON simulation_batch_runs (started_at, world_id, id)
  WHERE status = 'running';
--> statement-breakpoint
CREATE TABLE simulation_worker_leases (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  lease_owner text NOT NULL,
  fencing_token bigint NOT NULL,
  leased_until timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  CONSTRAINT simulation_worker_leases_owner_bounded CHECK (
    char_length(lease_owner) BETWEEN 3 AND 160
    AND lease_owner = btrim(lease_owner)
    AND lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT simulation_worker_leases_fencing_positive CHECK (fencing_token > 0),
  CONSTRAINT simulation_worker_leases_timestamps_valid CHECK (leased_until >= heartbeat_at)
);
--> statement-breakpoint
CREATE INDEX simulation_worker_leases_expiry_idx
  ON simulation_worker_leases (leased_until, world_id);
--> statement-breakpoint
CREATE TABLE simulation_failures (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  failure_schema_version integer NOT NULL DEFAULT 1,
  batch_run_id uuid NOT NULL,
  tick bigint NOT NULL,
  schedule_id uuid,
  process_type text NOT NULL,
  process_version text NOT NULL,
  error_code text NOT NULL,
  redacted_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL,
  status simulation_failure_status NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_by_actor_id text,
  resolved_at timestamptz,
  resolution_command_id uuid,
  CONSTRAINT simulation_failures_world_identity UNIQUE (world_id, id),
  CONSTRAINT simulation_failures_batch_world_fk
    FOREIGN KEY (world_id, batch_run_id)
    REFERENCES simulation_batch_runs(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT simulation_failures_schedule_world_fk
    FOREIGN KEY (world_id, schedule_id)
    REFERENCES scheduled_actions(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT simulation_failures_resolution_command_world_fk
    FOREIGN KEY (resolution_command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT simulation_failures_schema_known CHECK (failure_schema_version = 1),
  CONSTRAINT simulation_failures_tick_nonnegative CHECK (tick >= 0),
  CONSTRAINT simulation_failures_process_known CHECK (
    (process_type = 'EmitWorldNoticeV1' AND process_version = '1.0.0')
    OR (
      process_type = 'WorldClockV1' AND process_version = '1.0.0'
      AND schedule_id IS NULL AND error_code = 'SIMULATION_INTEGER_OVERFLOW'
    )
  ),
  CONSTRAINT simulation_failures_error_code_shape CHECK (
    char_length(error_code) BETWEEN 3 AND 100
    AND error_code ~ '^[A-Z][A-Z0-9_]*$'
  ),
  CONSTRAINT simulation_failures_context_safe CHECK (
    jsonb_typeof(redacted_context) = 'object'
    AND pg_column_size(redacted_context) <= 16384
    AND NOT worldgraph_jsonb_has_sensitive_key(redacted_context)
    AND NOT worldgraph_jsonb_has_compiler_private_key(redacted_context)
  ),
  CONSTRAINT simulation_failures_attempts_bounded CHECK (attempts BETWEEN 1 AND 100),
  CONSTRAINT simulation_failures_status_shape CHECK (
    (status = 'open' AND resolved_by_actor_id IS NULL
      AND resolved_at IS NULL AND resolution_command_id IS NULL)
    OR (status = 'resolved' AND resolved_by_actor_id IS NOT NULL
      AND char_length(resolved_by_actor_id) BETWEEN 3 AND 160
      AND resolved_by_actor_id = btrim(resolved_by_actor_id)
      AND resolved_by_actor_id !~ '[[:cntrl:]]'
      AND resolved_at IS NOT NULL AND resolution_command_id IS NOT NULL)
  ),
  CONSTRAINT simulation_failures_timestamps_ordered CHECK (
    resolved_at IS NULL OR resolved_at >= opened_at
  )
);
--> statement-breakpoint
CREATE INDEX simulation_failures_open_world_idx
  ON simulation_failures (world_id, tick, opened_at, id)
  WHERE status = 'open';
--> statement-breakpoint
CREATE FUNCTION worldgraph_resolve_simulation_clock_config(checked_world_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source_record record;
  settings_value jsonb := '{}'::jsonb;
  parameters_value jsonb := '{}'::jsonb;
  epoch_value timestamptz := '2000-01-01T00:00:00.000Z'::timestamptz;
  world_milliseconds_value bigint := 86400000;
  wall_cadence_value integer := 10000;
  max_batch_value integer := 64;
  max_catch_up_value integer := 256;
  provenance_value text := 'm07_default';
  candidate text;
  source_found boolean := false;
  invalid_compiled boolean := false;
  explicit_max_batch boolean := false;
BEGIN
  SELECT simulation.state -> 'settings' AS settings,
    primitive.state -> 'parameters' AS parameters
  INTO source_record
  FROM public.world_entities simulation
  JOIN public.world_relationships relation
    ON relation.world_id = simulation.world_id
    AND relation.source_entity_id = simulation.id
    AND relation.relationship_type = 'uses_primitive'
    AND relation.retired_world_version_id IS NULL
  JOIN public.world_entities primitive
    ON primitive.world_id = relation.world_id
    AND primitive.id = relation.target_entity_id
    AND primitive.retired_world_version_id IS NULL
  WHERE simulation.world_id = checked_world_id
    AND simulation.entity_type = 'simulation_configuration'
    AND simulation.retired_world_version_id IS NULL
    AND primitive.entity_type = 'primitive_instance'
    AND primitive.state ->> 'behaviorRef' = 'simulation.discrete_clock'
  ORDER BY primitive.logical_key::text COLLATE "C", primitive.id
  LIMIT 1;

  IF FOUND THEN
    source_found := true;
    settings_value := COALESCE(source_record.settings, '{}'::jsonb);
    parameters_value := COALESCE(source_record.parameters, '{}'::jsonb);
    invalid_compiled := jsonb_typeof(settings_value) <> 'object'
      OR jsonb_typeof(parameters_value) <> 'object';
  END IF;

  IF source_found AND NOT invalid_compiled THEN
    IF settings_value ? 'epochAt' THEN
      candidate := settings_value ->> 'epochAt';
      IF candidate IS NULL OR candidate ~ '^0000-'
        OR candidate !~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' THEN
        invalid_compiled := true;
      ELSE
        BEGIN
          epoch_value := candidate::timestamptz;
        EXCEPTION WHEN OTHERS THEN
          invalid_compiled := true;
        END;
      END IF;
    END IF;

    IF settings_value ? 'worldMillisecondsPerTick' THEN
      candidate := settings_value ->> 'worldMillisecondsPerTick';
      IF candidate IS NULL OR candidate !~ '^[0-9]{1,11}$'
        OR candidate::bigint NOT BETWEEN 1 AND 31536000000 THEN
        invalid_compiled := true;
      ELSE
        world_milliseconds_value := candidate::bigint;
      END IF;
    ELSIF parameters_value ? 'tickDurationSeconds' THEN
      candidate := parameters_value ->> 'tickDurationSeconds';
      IF candidate IS NULL OR candidate !~ '^[0-9]{1,8}$'
        OR candidate::bigint NOT BETWEEN 1 AND 31536000 THEN
        invalid_compiled := true;
      ELSE
        world_milliseconds_value := candidate::bigint * 1000;
      END IF;
    END IF;

    IF settings_value ? 'wallCadenceMilliseconds' THEN
      candidate := settings_value ->> 'wallCadenceMilliseconds';
      IF candidate IS NULL OR candidate !~ '^[0-9]{1,8}$'
        OR candidate::integer NOT BETWEEN 100 AND 86400000 THEN
        invalid_compiled := true;
      ELSE
        wall_cadence_value := candidate::integer;
      END IF;
    END IF;

    IF settings_value ? 'maxCatchUpTicks' THEN
      candidate := settings_value ->> 'maxCatchUpTicks';
      IF candidate IS NULL OR candidate !~ '^[0-9]{1,4}$'
        OR candidate::integer NOT BETWEEN 1 AND 4096 THEN
        invalid_compiled := true;
      ELSE
        max_catch_up_value := candidate::integer;
      END IF;
    ELSIF parameters_value ? 'maxCatchUpTicks' THEN
      candidate := parameters_value ->> 'maxCatchUpTicks';
      IF candidate IS NULL OR candidate !~ '^[0-9]{1,4}$'
        OR candidate::integer NOT BETWEEN 1 AND 4096 THEN
        invalid_compiled := true;
      ELSE
        max_catch_up_value := candidate::integer;
      END IF;
    END IF;

    IF settings_value ? 'maxBatchTicks' THEN
      explicit_max_batch := true;
      candidate := settings_value ->> 'maxBatchTicks';
      IF candidate IS NULL OR candidate !~ '^[0-9]{1,3}$'
        OR candidate::integer NOT BETWEEN 1 AND 256 THEN
        invalid_compiled := true;
      ELSE
        max_batch_value := candidate::integer;
      END IF;
    END IF;

    IF explicit_max_batch AND max_batch_value > max_catch_up_value THEN
      invalid_compiled := true;
    ELSE
      max_batch_value := least(max_batch_value, max_catch_up_value);
    END IF;

    IF NOT invalid_compiled THEN
      BEGIN
        IF epoch_value + world_milliseconds_value * interval '1 millisecond'
          > timestamptz '9999-12-31 23:59:59.999+00' THEN
          invalid_compiled := true;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        invalid_compiled := true;
      END;
    END IF;
  END IF;

  IF source_found AND NOT invalid_compiled THEN
    provenance_value := 'compiled_configuration';
  ELSE
    epoch_value := '2000-01-01T00:00:00.000Z'::timestamptz;
    world_milliseconds_value := 86400000;
    wall_cadence_value := 10000;
    max_batch_value := 64;
    max_catch_up_value := 256;
    provenance_value := 'm07_default';
  END IF;

  RETURN jsonb_build_object(
    'configuration', jsonb_build_object(
      'epochAt', public.worldgraph_timestamp_text(epoch_value),
      'maxBatchTicks', max_batch_value,
      'maxCatchUpTicks', max_catch_up_value,
      'prngAlgorithmVersion', 'xorshift32-sha256-v1',
      'wallCadenceMilliseconds', wall_cadence_value,
      'worldMillisecondsPerTick', world_milliseconds_value
    ),
    'provenance', provenance_value
  );
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_initial_simulation_outcome_hash_v1(world_seed text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  world_seed_hash text;
BEGIN
  IF world_seed !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'world seed is not in the canonical bounded seed format'
      USING ERRCODE = '22023';
  END IF;
  world_seed_hash := encode(extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain', 'worldgraph.simulation.world-seed.v1',
      'worldSeed', world_seed
    )), 'UTF8'
  ), 'sha256'), 'hex');
  RETURN extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain', 'worldgraph.simulation.outcome.initial.v1',
      'outcomeSchemaVersion', 1,
      'prngAlgorithmVersion', 'xorshift32-sha256-v1',
      'processRegistryVersion', 1,
      'worldSeedHash', world_seed_hash
    )), 'UTF8'
  ), 'sha256');
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_initial_simulation_outcome_hash_v1(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_simulation_projection_document(checked_world_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN jsonb_build_object(
  'clock', (
    SELECT jsonb_build_object(
      'clockSchemaVersion', clock.clock_schema_version,
      'currentTick', clock.current_tick::text,
      'epochAt', public.worldgraph_timestamp_text(clock.epoch_at),
      'maxBatchTicks', clock.max_batch_ticks,
      'maxCatchUpTicks', clock.max_catch_up_ticks,
      'mode', clock.mode::text,
      'outcomeHash', encode(clock.outcome_hash, 'hex'),
      'prngAlgorithmVersion', clock.prng_algorithm_version,
      'wallCadenceMilliseconds', clock.wall_cadence_milliseconds,
      'worldMillisecondsPerTick', clock.world_milliseconds_per_tick::text
    )
    FROM public.world_simulation_clocks clock
    WHERE clock.world_id = checked_world_id
  ),
  'domain', 'worldgraph.simulation-projection.v1',
  'scheduleHead', (
    SELECT jsonb_build_object(
      'nextScheduleSequence', head.next_schedule_sequence::text
    )
    FROM public.world_schedule_heads head
    WHERE head.world_id = checked_world_id
  ),
  'scheduledActions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'actionSchemaVersion', action.action_schema_version,
      'actionType', action.action_type,
      'dueTick', action.due_tick::text,
      'payloadHash', encode(action.payload_hash, 'hex'),
      'priority', action.priority,
      'processVersion', action.process_version,
      'scheduleSequence', action.schedule_sequence::text,
      'status', action.status::text
    ) ORDER BY action.schedule_sequence)
    FROM public.scheduled_actions action
    WHERE action.world_id = checked_world_id
  ), '[]'::jsonb),
  'simulationProjectionSchemaVersion', 1
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_simulation_projection_checksum(checked_world_id uuid)
RETURNS bytea
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
RETURN extensions.digest(
  convert_to(public.worldgraph_canonical_jsonb(
    public.worldgraph_simulation_projection_document(checked_world_id)
  ), 'UTF8'),
  'sha256'
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_command_write_is_open(
  checked_world_id uuid,
  checked_command_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN NULLIF(current_setting('worldgraph.command_world_id', true), '') = checked_world_id::text
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
  );
--> statement-breakpoint
CREATE FUNCTION worldgraph_schedule_projection_is_contiguous(checked_world_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN EXISTS (
  SELECT 1
  FROM public.world_schedule_heads head
  WHERE head.world_id = checked_world_id
    AND head.next_schedule_sequence = 1 + (
      SELECT count(*) FROM public.scheduled_actions action
      WHERE action.world_id = checked_world_id
    )
    AND head.next_schedule_sequence = 1 + COALESCE((
      SELECT max(action.schedule_sequence) FROM public.scheduled_actions action
      WHERE action.world_id = checked_world_id
    ), 0)
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_schedule_projection_is_contiguous(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_jsonb_numbers_are_canonical_integers(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  valid boolean;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'number' THEN
      RETURN value::text ~ '^-?(0|[1-9][0-9]*)$';
    WHEN 'array' THEN
      SELECT COALESCE(bool_and(
        public.worldgraph_jsonb_numbers_are_canonical_integers(item)
      ), true)
      INTO valid
      FROM jsonb_array_elements(value) item;
      RETURN valid;
    WHEN 'object' THEN
      SELECT COALESCE(bool_and(
        public.worldgraph_jsonb_numbers_are_canonical_integers(item)
      ), true)
      INTO valid
      FROM jsonb_each(value) entry(key, item);
      RETURN valid;
    ELSE
      RETURN true;
  END CASE;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_jsonb_numbers_are_canonical_integers(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_require_simulation_checkpoint_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_id uuid;
BEGIN
  IF NEW.projection_name <> 'simulation_runtime' THEN
    RETURN NEW;
  END IF;

  checked_command_id := NULLIF(current_setting('worldgraph.command_id', true), '')::uuid;
  IF checked_command_id IS NULL
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id)
    OR NEW.projection_schema_version <> 1
    OR NEW.status <> 'current'::projection_checkpoint_status
    OR NEW.checksum IS DISTINCT FROM
      public.worldgraph_simulation_projection_checksum(NEW.world_id)
    OR NOT EXISTS (
      SELECT 1
      FROM public.domain_events event
      WHERE event.world_id = NEW.world_id
        AND event.command_id = checked_command_id
        AND event.world_event_sequence = NEW.last_event_sequence
    ) THEN
    RAISE EXCEPTION 'simulation checkpoint certification requires its matching open command event'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER projection_checkpoints_require_simulation_command
  BEFORE INSERT OR UPDATE ON projection_checkpoints
  FOR EACH ROW EXECUTE FUNCTION worldgraph_require_simulation_checkpoint_command();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_require_simulation_checkpoint_command() FROM PUBLIC;
--> statement-breakpoint
ALTER FUNCTION worldgraph_open_command_write(uuid, uuid)
  RENAME TO worldgraph_open_command_write_m06;
--> statement-breakpoint
ALTER FUNCTION worldgraph_open_command_write_m06(uuid, uuid) OWNER TO CURRENT_USER;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_simulation_projection_current(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.world_simulation_clocks clock
    JOIN public.world_schedule_heads schedule
      ON schedule.world_id = clock.world_id
    JOIN public.world_runtime_heads runtime
      ON runtime.world_id = clock.world_id
    JOIN public.projection_checkpoints checkpoint
      ON checkpoint.world_id = runtime.world_id
     AND checkpoint.projection_name = 'simulation_runtime'
    WHERE clock.world_id = checked_world_id
      AND checkpoint.projection_schema_version = 1
      AND checkpoint.status = 'current'::projection_checkpoint_status
      AND checkpoint.last_event_sequence = runtime.last_event_sequence
      AND checkpoint.checksum =
        public.worldgraph_simulation_projection_checksum(checked_world_id)
      AND public.worldgraph_schedule_projection_is_contiguous(checked_world_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.scheduled_actions action
        WHERE action.world_id = clock.world_id
          AND action.status = 'scheduled'::scheduled_action_status
          AND action.due_tick <= clock.current_tick
      )
  ) THEN
    RAISE EXCEPTION 'simulation projection authority is inconsistent; command writes are frozen'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_simulation_projection_current(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_open_command_write(checked_command_id uuid, checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_type text;
  simulation_state_exists boolean;
BEGIN
  SELECT command.command_type
  INTO checked_command_type
  FROM public.command_records command
  WHERE command.id = checked_command_id
    AND command.world_id = checked_world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'command write gate requires the matching received command'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.world_simulation_clocks clock
    WHERE clock.world_id = checked_world_id
  ) OR EXISTS (
    SELECT 1 FROM public.world_schedule_heads schedule
    WHERE schedule.world_id = checked_world_id
  ) OR EXISTS (
    SELECT 1 FROM public.projection_checkpoints checkpoint
    WHERE checkpoint.world_id = checked_world_id
      AND checkpoint.projection_name = 'simulation_runtime'
  )
  INTO simulation_state_exists;

  -- Compiled genesis and the one M07 initialization command are the only writes
  -- that may legitimately precede simulation state. Once any simulation state
  -- exists, every command is frozen until its complete semantic checkpoint is
  -- current and matches the live clock/schedule projection.
  IF simulation_state_exists
    OR checked_command_type NOT IN ('WorldCompiledGenesisV1', 'InitializeWorldSimulationV1') THEN
    PERFORM public.worldgraph_assert_simulation_projection_current(checked_world_id);
  END IF;

  PERFORM public.worldgraph_open_command_write_m06(checked_command_id, checked_world_id);
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_open_command_write(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_allocate_schedule_sequence(checked_world_id uuid)
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
    OR open_command_type NOT IN ('ScheduleWorldNoticeV1', 'AdvanceSimulationV1') THEN
    RAISE EXCEPTION 'schedule allocation requires its exact open simulation command'
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
REVOKE ALL ON FUNCTION worldgraph_allocate_schedule_sequence(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_acquire_simulation_lease(
  checked_world_id uuid,
  checked_lease_owner text,
  lease_milliseconds integer
)
RETURNS TABLE (fencing_token bigint, leased_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  now_value timestamptz := clock_timestamp();
BEGIN
  IF char_length(checked_lease_owner) NOT BETWEEN 3 AND 160
    OR checked_lease_owner <> btrim(checked_lease_owner)
    OR checked_lease_owner !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR lease_milliseconds NOT BETWEEN 1000 AND 300000 THEN
    RAISE EXCEPTION 'simulation lease request is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.world_simulation_clocks clock
    JOIN public.worlds world ON world.id = clock.world_id
    WHERE clock.world_id = checked_world_id
      AND world.lifecycle = 'active'::world_lifecycle
  ) THEN
    RAISE EXCEPTION 'simulation lease requires an initialized active world'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  INSERT INTO public.simulation_worker_leases(
    world_id, lease_owner, fencing_token, leased_until, heartbeat_at
  ) VALUES (
    checked_world_id, checked_lease_owner, 1,
    now_value + lease_milliseconds * interval '1 millisecond', now_value
  )
  ON CONFLICT (world_id) DO UPDATE
  SET lease_owner = EXCLUDED.lease_owner,
      fencing_token = simulation_worker_leases.fencing_token + 1,
      leased_until = EXCLUDED.leased_until,
      heartbeat_at = EXCLUDED.heartbeat_at
  WHERE simulation_worker_leases.leased_until <= now_value
  RETURNING simulation_worker_leases.fencing_token,
    simulation_worker_leases.leased_until;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_renew_simulation_lease(
  checked_world_id uuid,
  checked_lease_owner text,
  checked_fencing_token bigint,
  lease_milliseconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  now_value timestamptz := clock_timestamp();
BEGIN
  IF checked_fencing_token <= 0 OR lease_milliseconds NOT BETWEEN 1000 AND 300000 THEN
    RAISE EXCEPTION 'simulation lease renewal is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE public.simulation_worker_leases
  SET leased_until = now_value + lease_milliseconds * interval '1 millisecond',
      heartbeat_at = now_value
  WHERE world_id = checked_world_id
    AND lease_owner = checked_lease_owner
    AND fencing_token = checked_fencing_token
    AND leased_until > now_value;
  RETURN FOUND;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_release_simulation_lease(
  checked_world_id uuid,
  checked_lease_owner text,
  checked_fencing_token bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  now_value timestamptz := clock_timestamp();
BEGIN
  UPDATE public.simulation_worker_leases
  SET leased_until = now_value, heartbeat_at = now_value
  WHERE world_id = checked_world_id
    AND lease_owner = checked_lease_owner
    AND fencing_token = checked_fencing_token
    AND leased_until > now_value;
  RETURN FOUND;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_simulation_lease_is_current(
  checked_world_id uuid,
  checked_lease_owner text,
  checked_fencing_token bigint
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  lease_record record;
BEGIN
  SELECT lease.lease_owner, lease.fencing_token, lease.leased_until
  INTO lease_record
  FROM public.simulation_worker_leases lease
  WHERE lease.world_id = checked_world_id
  FOR UPDATE;
  RETURN FOUND AND COALESCE(
    lease_record.lease_owner = checked_lease_owner
      AND lease_record.fencing_token = checked_fencing_token
      AND lease_record.leased_until > clock_timestamp(),
    false
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_acquire_simulation_lease(uuid,text,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_renew_simulation_lease(uuid,text,bigint,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_release_simulation_lease(uuid,text,bigint) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_simulation_lease_is_current(uuid,text,bigint) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_simulation_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  open_command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world simulation clocks cannot be deleted'
      USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.current_tick <> 0 OR NEW.mode <> 'paused'::simulation_clock_mode
      OR NEW.last_wall_anchor_at IS NOT NULL OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'world simulation clocks must begin at tick zero paused'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT command.command_type INTO open_command_type
  FROM public.command_records command
  WHERE command.id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    AND command.world_id = NEW.world_id;

  IF NOT public.worldgraph_command_write_is_open(NEW.world_id)
    OR open_command_type IS NULL
    OR open_command_type NOT IN (
      'ConfigureWorldClockV1', 'StartWorldClockV1', 'PauseWorldClockV1',
      'AdvanceSimulationV1', 'AutoPauseWorldClockV1',
      'ResolveSimulationFailureV1'
    )
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.clock_schema_version IS DISTINCT FROM OLD.clock_schema_version
    OR NEW.prng_algorithm_version IS DISTINCT FROM OLD.prng_algorithm_version
    OR (NEW.mode IS DISTINCT FROM OLD.mode AND NOT (
      (OLD.mode = 'paused'::simulation_clock_mode
        AND NEW.mode = 'running'::simulation_clock_mode
        AND open_command_type = 'StartWorldClockV1')
      OR (OLD.mode = 'running'::simulation_clock_mode
        AND NEW.mode = 'paused'::simulation_clock_mode
        AND open_command_type = 'PauseWorldClockV1')
      OR (OLD.mode = 'running'::simulation_clock_mode
        AND NEW.mode = 'error'::simulation_clock_mode
        AND open_command_type = 'AutoPauseWorldClockV1')
      OR (OLD.mode = 'error'::simulation_clock_mode
        AND NEW.mode = 'paused'::simulation_clock_mode
        AND open_command_type = 'ResolveSimulationFailureV1')
    ))
    OR (NEW.current_tick IS DISTINCT FROM OLD.current_tick
      AND open_command_type IS DISTINCT FROM 'AdvanceSimulationV1')
    OR ((
      NEW.epoch_at IS DISTINCT FROM OLD.epoch_at
      OR NEW.world_milliseconds_per_tick IS DISTINCT FROM OLD.world_milliseconds_per_tick
      OR NEW.wall_cadence_milliseconds IS DISTINCT FROM OLD.wall_cadence_milliseconds
      OR NEW.max_batch_ticks IS DISTINCT FROM OLD.max_batch_ticks
      OR NEW.max_catch_up_ticks IS DISTINCT FROM OLD.max_catch_up_ticks
    ) AND open_command_type IS DISTINCT FROM 'ConfigureWorldClockV1')
    OR (NEW.outcome_hash IS DISTINCT FROM OLD.outcome_hash
      AND open_command_type IS DISTINCT FROM 'AdvanceSimulationV1')
    OR NEW.current_tick < OLD.current_tick
    OR NEW.current_tick - OLD.current_tick > OLD.max_batch_ticks
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.updated_state_revision <= OLD.updated_state_revision
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.current_tick > 0 AND (
      NEW.epoch_at IS DISTINCT FROM OLD.epoch_at
      OR NEW.world_milliseconds_per_tick IS DISTINCT FROM OLD.world_milliseconds_per_tick
      OR NEW.wall_cadence_milliseconds IS DISTINCT FROM OLD.wall_cadence_milliseconds
      OR NEW.max_batch_ticks IS DISTINCT FROM OLD.max_batch_ticks
      OR NEW.max_catch_up_ticks IS DISTINCT FROM OLD.max_catch_up_ticks
    ))
    OR (OLD.mode = 'error'::simulation_clock_mode
      AND NEW.mode = 'running'::simulation_clock_mode) THEN
    RAISE EXCEPTION 'world simulation clock transition is invalid or outside a command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_simulation_clocks_protect
  BEFORE INSERT OR UPDATE OR DELETE ON world_simulation_clocks
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_simulation_clock();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_simulation_clock_write()
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
        'processRegistryVersion', 1,
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
        'processRegistryVersion', 1,
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
CREATE CONSTRAINT TRIGGER world_simulation_clocks_require_accepted_command
  AFTER INSERT OR UPDATE ON world_simulation_clocks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_simulation_clock_write();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_schedule_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  open_command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world schedule heads cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT command.command_type
    INTO open_command_type
    FROM public.command_records command
    WHERE command.id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
      AND command.world_id = NEW.world_id;
    IF NOT public.worldgraph_command_write_is_open(NEW.world_id)
      OR open_command_type NOT IN ('ScheduleWorldNoticeV1', 'AdvanceSimulationV1')
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
CREATE TRIGGER world_schedule_heads_protect
  BEFORE UPDATE OR DELETE ON world_schedule_heads
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_schedule_head();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_scheduled_action()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_id uuid;
  open_command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'scheduled actions cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    SELECT command.command_type
    INTO open_command_type
    FROM public.command_records command
    WHERE command.id = NEW.created_command_id
      AND command.world_id = NEW.world_id;
    IF open_command_type NOT IN ('ScheduleWorldNoticeV1', 'AdvanceSimulationV1')
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
  SELECT command.command_type
  INTO open_command_type
  FROM public.command_records command
  WHERE command.id = checked_command_id
    AND command.world_id = NEW.world_id;
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
    open_command_type NOT IN ('CancelScheduledActionV1', 'ResolveSimulationFailureV1')
    OR NEW.cancelled_command_id IS DISTINCT FROM checked_command_id
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
CREATE TRIGGER scheduled_actions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON scheduled_actions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_scheduled_action();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_scheduled_action_command()
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
        AND command.command_type IN ('ScheduleWorldNoticeV1', 'AdvanceSimulationV1')
        AND command.status = 'accepted'::command_record_status
        AND command.resulting_state_revision = NEW.created_state_revision
        AND command.write_gate_opened_at >= transaction_timestamp()
        AND command.actor_type = NEW.created_by_actor_type
        AND command.actor_id = NEW.created_by_actor_id
        AND NEW.created_at = event.recorded_at
        AND NEW.updated_at = event.recorded_at
        AND event.aggregate_type = 'scheduled_action'
        AND event.aggregate_id = NEW.id::text
        AND event.event_type = 'ScheduledActionCreatedV1'
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
      AND command.command_type IN ('CancelScheduledActionV1', 'ResolveSimulationFailureV1')
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
          AND command.payload_hash = extensions.digest(convert_to(
            public.worldgraph_canonical_jsonb(jsonb_build_object(
              'scheduleId', NEW.id::text
            )), 'UTF8'
          ), 'sha256'))
        OR (command.command_type = 'ResolveSimulationFailureV1'
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
CREATE CONSTRAINT TRIGGER scheduled_actions_require_accepted_command
  AFTER INSERT OR UPDATE ON scheduled_actions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_scheduled_action_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_schedule_projection_contiguous()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT public.worldgraph_schedule_projection_is_contiguous(COALESCE(NEW.world_id, OLD.world_id))
  THEN
    RAISE EXCEPTION 'schedule allocation head is not contiguous with durable actions'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_schedule_projection_contiguous() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_schedule_heads_require_contiguous_actions
  AFTER INSERT OR UPDATE ON world_schedule_heads
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_schedule_projection_contiguous();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER scheduled_actions_require_contiguous_head
  AFTER INSERT OR DELETE ON scheduled_actions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_schedule_projection_contiguous();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_simulation_batch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_id uuid;
  open_command_type text;
BEGIN
  checked_command_id := NULLIF(current_setting('worldgraph.command_id', true), '')::uuid;
  SELECT command.command_type
  INTO open_command_type
  FROM public.command_records command
  WHERE command.id = checked_command_id
    AND command.world_id = COALESCE(NEW.world_id, OLD.world_id);

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'simulation batch runs cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status = 'running'::simulation_batch_status
      AND open_command_type IN ('AdvanceSimulationV1', 'AutoPauseWorldClockV1')
      AND public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id) THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'failed'::simulation_batch_status
      AND open_command_type = 'AutoPauseWorldClockV1'
      AND public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id)
      AND NEW.to_tick = NEW.from_tick
      AND NEW.error_code = 'SIMULATION_INTEGER_OVERFLOW'
      AND NEW.outcome_hash IS NULL
      AND NEW.command_id IS NULL
      AND NEW.completed_at IS NOT NULL
      THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'simulation batch creation requires its exact open advance or auto-pause command'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.batch_schema_version IS DISTINCT FROM OLD.batch_schema_version
    OR NEW.from_tick IS DISTINCT FROM OLD.from_tick
    OR NEW.to_tick IS DISTINCT FROM OLD.to_tick
    OR NEW.batch_key IS DISTINCT FROM OLD.batch_key
    OR NEW.process_registry_version IS DISTINCT FROM OLD.process_registry_version
    OR NEW.input_checksum IS DISTINCT FROM OLD.input_checksum
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'simulation batch transition changes immutable state'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'running'::simulation_batch_status THEN
    IF NEW.status = 'completed'::simulation_batch_status
      AND open_command_type = 'AdvanceSimulationV1'
      AND NEW.command_id = checked_command_id
      AND public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id) THEN
      RETURN NEW;
    ELSIF NEW.status = 'failed'::simulation_batch_status
      AND open_command_type = 'AutoPauseWorldClockV1'
      AND NEW.command_id IS NOT DISTINCT FROM OLD.command_id
      AND public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'running batch terminal transition requires its exact command'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'failed'::simulation_batch_status THEN
    IF NEW.attempts <= OLD.attempts
      OR (
        NEW.status = 'completed'::simulation_batch_status
        AND (
          open_command_type IS DISTINCT FROM 'AdvanceSimulationV1'
          OR NEW.command_id IS DISTINCT FROM checked_command_id
          OR NOT public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id)
        )
      )
      OR (
        NEW.status = 'failed'::simulation_batch_status
        AND (
          open_command_type IS DISTINCT FROM 'AutoPauseWorldClockV1'
          OR NEW.command_id IS DISTINCT FROM OLD.command_id
          OR NOT public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id)
        )
      )
      OR NEW.status NOT IN ('completed'::simulation_batch_status, 'failed'::simulation_batch_status)
      OR NOT EXISTS (
        SELECT 1
        FROM public.simulation_failures failure
        JOIN public.command_records resolution
          ON resolution.id = failure.resolution_command_id
         AND resolution.world_id = failure.world_id
         AND resolution.command_type = 'ResolveSimulationFailureV1'
         AND resolution.status = 'accepted'::command_record_status
        JOIN public.domain_events resolution_event
          ON resolution_event.command_id = resolution.id
         AND resolution_event.world_id = resolution.world_id
         AND resolution_event.aggregate_type = 'simulation_failure'
         AND resolution_event.aggregate_id = failure.id::text
         AND resolution_event.event_type = 'SimulationFailureResolvedV1'
        WHERE failure.world_id = OLD.world_id
          AND failure.batch_run_id = OLD.id
          AND failure.status = 'resolved'::simulation_failure_status
          AND resolution_event.payload ->> 'failureId' = failure.id::text
          AND resolution_event.payload ->> 'resolution' = 'retry_after_repair'
          AND failure.id = (
            SELECT latest_failure.id
            FROM public.simulation_failures latest_failure
            JOIN public.domain_events recorded_event
              ON recorded_event.world_id = latest_failure.world_id
             AND recorded_event.aggregate_type = 'simulation_failure'
             AND recorded_event.aggregate_id = latest_failure.id::text
             AND recorded_event.event_type = 'SimulationFailureRecordedV1'
            WHERE latest_failure.world_id = OLD.world_id
              AND latest_failure.batch_run_id = OLD.id
            ORDER BY recorded_event.world_event_sequence DESC
            LIMIT 1
          )
      ) THEN
      RAISE EXCEPTION 'failed simulation batch retry requires its latest audited repair resolution'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'simulation batch transition changes immutable state'
    USING ERRCODE = '55000';
END
$function$;
--> statement-breakpoint
CREATE TRIGGER simulation_batch_runs_protect
  BEFORE INSERT OR UPDATE OR DELETE ON simulation_batch_runs
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_simulation_batch();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_simulation_batch_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  batch_record record;
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
    JOIN public.world_simulation_clocks clock
      ON clock.world_id = command.world_id
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
        'processRegistryVersion', 1,
        'tickCount', (batch_record.to_tick - batch_record.from_tick)::integer,
        'toTick', batch_record.to_tick::text
      )
      AND batch_record.batch_schema_version = 1
      AND batch_record.process_registry_version = 1
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
      AND batch_record.process_registry_version = 1
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
CREATE CONSTRAINT TRIGGER simulation_batch_runs_require_accepted_command
  AFTER INSERT OR UPDATE ON simulation_batch_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_simulation_batch_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_simulation_failure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_id uuid;
  open_command_type text;
BEGIN
  checked_command_id := NULLIF(current_setting('worldgraph.command_id', true), '')::uuid;
  SELECT command.command_type
  INTO open_command_type
  FROM public.command_records command
  WHERE command.id = checked_command_id
    AND command.world_id = COALESCE(NEW.world_id, OLD.world_id);

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'simulation failures cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open'::simulation_failure_status
      OR open_command_type IS DISTINCT FROM 'AutoPauseWorldClockV1'
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id, checked_command_id) THEN
      RAISE EXCEPTION 'simulation failures must begin inside their open auto-pause command'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open'::simulation_failure_status
    OR NEW.status <> 'resolved'::simulation_failure_status
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.failure_schema_version IS DISTINCT FROM OLD.failure_schema_version
    OR NEW.batch_run_id IS DISTINCT FROM OLD.batch_run_id
    OR NEW.tick IS DISTINCT FROM OLD.tick
    OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
    OR NEW.process_type IS DISTINCT FROM OLD.process_type
    OR NEW.process_version IS DISTINCT FROM OLD.process_version
    OR NEW.error_code IS DISTINCT FROM OLD.error_code
    OR NEW.redacted_context IS DISTINCT FROM OLD.redacted_context
    OR NEW.attempts IS DISTINCT FROM OLD.attempts
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    OR open_command_type IS DISTINCT FROM 'ResolveSimulationFailureV1'
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.resolution_command_id) THEN
    RAISE EXCEPTION 'simulation failure transition is immutable, invalid, or outside a command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER simulation_failures_protect
  BEFORE INSERT OR UPDATE OR DELETE ON simulation_failures
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_simulation_failure();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_simulation_failure_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  failure_record record;
BEGIN
  SELECT * INTO failure_record
  FROM public.simulation_failures failure
  WHERE failure.id = NEW.id AND failure.world_id = NEW.world_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.domain_events event
    JOIN public.command_records command
      ON command.id = event.command_id AND command.world_id = event.world_id
    JOIN public.simulation_batch_runs batch
      ON batch.world_id = failure_record.world_id
     AND batch.id = failure_record.batch_run_id
    JOIN public.world_simulation_clocks clock
      ON clock.world_id = failure_record.world_id
    WHERE event.world_id = failure_record.world_id
      AND event.aggregate_type = 'simulation_failure'
      AND event.aggregate_id = failure_record.id::text
      AND event.event_type = 'SimulationFailureRecordedV1'
      AND event.payload = jsonb_build_object(
        'attempts', failure_record.attempts,
        'batchRunId', failure_record.batch_run_id::text,
        'errorCode', failure_record.error_code,
        'failureId', failure_record.id::text,
        'processType', failure_record.process_type,
        'processVersion', failure_record.process_version,
        'scheduleId', failure_record.schedule_id::text,
        'tick', failure_record.tick::text
      )
      AND command.command_type = 'AutoPauseWorldClockV1'
      AND command.status = 'accepted'::command_record_status
      AND command.command_schema_version = 1
      AND (command.payload IS NULL OR command.payload = jsonb_build_object(
        'errorCode', failure_record.error_code,
        'failureId', failure_record.id::text
      ))
      AND command.payload_hash = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(jsonb_build_object(
          'errorCode', failure_record.error_code,
          'failureId', failure_record.id::text
        )), 'UTF8'
      ), 'sha256')
      AND (TG_OP <> 'INSERT' OR command.write_gate_opened_at >= transaction_timestamp())
      AND failure_record.opened_at = event.recorded_at
      AND failure_record.failure_schema_version = 1
      AND batch.status = 'failed'::simulation_batch_status
      AND failure_record.error_code = batch.error_code
      AND batch.from_tick = clock.current_tick
      AND batch.to_tick - batch.from_tick BETWEEN 0 AND clock.max_batch_ticks
      AND (TG_OP <> 'INSERT' OR batch.completed_at = event.recorded_at)
      AND batch.attempts = (
        SELECT sum(linked.attempts)
        FROM public.simulation_failures linked
        WHERE linked.world_id = batch.world_id
          AND linked.batch_run_id = batch.id
      )
      AND (
        (failure_record.process_type = 'WorldClockV1'
          AND failure_record.process_version = '1.0.0'
          AND failure_record.schedule_id IS NULL
          AND failure_record.error_code = 'SIMULATION_INTEGER_OVERFLOW'
          AND failure_record.tick = batch.to_tick)
        OR (failure_record.process_type = 'EmitWorldNoticeV1'
          AND failure_record.process_version = '1.0.0'
          AND failure_record.tick > batch.from_tick
          AND failure_record.tick <= batch.to_tick
          AND failure_record.schedule_id IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM public.scheduled_actions action
              WHERE action.world_id = failure_record.world_id
                AND action.id = failure_record.schedule_id
                AND (
                  action.status = 'scheduled'::scheduled_action_status
                  OR (
                    failure_record.status = 'resolved'::simulation_failure_status
                    AND action.status = 'cancelled'::scheduled_action_status
                    AND action.cancelled_command_id = failure_record.resolution_command_id
                  )
                )
                AND action.due_tick = failure_record.tick
                AND action.action_type = failure_record.process_type
                AND action.process_version = failure_record.process_version
            ))
      )
  ) THEN
    RAISE EXCEPTION 'simulation failure requires its accepted auto-pause fact'
      USING ERRCODE = '55000';
  ELSIF failure_record.status = 'resolved'::simulation_failure_status AND NOT EXISTS (
    SELECT 1
    FROM public.command_records command
    JOIN public.domain_events event
      ON event.command_id = command.id AND event.world_id = command.world_id
    JOIN public.world_simulation_clocks clock
      ON clock.world_id = failure_record.world_id
    JOIN public.simulation_batch_runs resolution_batch
      ON resolution_batch.world_id = failure_record.world_id
     AND resolution_batch.id = failure_record.batch_run_id
    WHERE command.id = failure_record.resolution_command_id
      AND command.world_id = failure_record.world_id
      AND command.command_type = 'ResolveSimulationFailureV1'
      AND command.status = 'accepted'::command_record_status
      AND command.write_gate_opened_at >= transaction_timestamp()
      AND command.actor_id = failure_record.resolved_by_actor_id
      AND failure_record.resolved_at = event.recorded_at
      AND clock.mode = 'paused'::simulation_clock_mode
      AND clock.last_wall_anchor_at IS NULL
      AND clock.current_tick = resolution_batch.from_tick
      AND clock.updated_state_revision = event.resulting_state_revision
      AND clock.updated_at = event.recorded_at
      AND event.aggregate_type = 'simulation_failure'
      AND event.aggregate_id = failure_record.id::text
      AND event.event_type = 'SimulationFailureResolvedV1'
      AND event.event_ordinal = 0
      AND event.payload = jsonb_build_object(
        'failureId', failure_record.id::text,
        'resolution', event.payload ->> 'resolution',
        'scheduleId', failure_record.schedule_id::text,
        'tick', failure_record.tick::text
      )
      AND event.payload ->> 'resolution' IN ('cancel_action', 'retry_after_repair')
      AND (command.payload IS NULL OR command.payload = jsonb_build_object(
        'failureId', failure_record.id::text,
        'resolution', event.payload ->> 'resolution'
      ))
      AND command.payload_hash = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(jsonb_build_object(
          'failureId', failure_record.id::text,
          'resolution', event.payload ->> 'resolution'
        )), 'UTF8'
      ), 'sha256')
  ) THEN
    RAISE EXCEPTION 'resolved simulation failure requires its accepted resolution fact'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER simulation_failures_require_accepted_command
  AFTER INSERT OR UPDATE ON simulation_failures
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_simulation_failure_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_simulation_domain_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_command_type text;
  matrix_matches boolean;
BEGIN
  SELECT command.command_type
  INTO checked_command_type
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
      OR (checked_command_type = 'CancelScheduledActionV1'
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
CREATE TRIGGER domain_events_protect_simulation_namespace
  BEFORE INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_simulation_domain_event();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_simulation_domain_event()
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
            'processRegistryVersion', 1,
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
              'processRegistryVersion', 1,
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
                + 2 * (SELECT count(*) FROM public.domain_events event
                  WHERE event.command_id = NEW.command_id
                    AND event.event_type = 'ScheduledActionExecutedV1')
                + (SELECT count(*) FROM public.domain_events event
                  WHERE event.command_id = NEW.command_id
                    AND event.event_type = 'ScheduledActionCreatedV1')
            AND (SELECT count(*) FROM public.domain_events event
              WHERE event.command_id = NEW.command_id
                AND event.event_type = 'ScheduledActionExecutedV1') =
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
              WHERE executed.command_id = NEW.command_id
                AND executed.event_type = 'ScheduledActionExecutedV1'
                AND NOT EXISTS (
                  SELECT 1 FROM public.domain_events notice
                  WHERE notice.command_id = executed.command_id
                    AND notice.event_type = 'WorldNoticeEmittedV1'
                    AND notice.aggregate_id = executed.aggregate_id
                    AND notice.event_ordinal = executed.event_ordinal + 1
                )
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
              )) = 1
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
CREATE CONSTRAINT TRIGGER domain_events_require_simulation_fact
  AFTER INSERT ON domain_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_assert_simulation_domain_event();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_assert_simulation_domain_event() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_initialize_simulation(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  source_record record;
  resolved_config jsonb;
  configuration_value jsonb;
  provenance_value text;
  payload_value jsonb;
  metadata_value jsonb;
  command_id_value uuid;
  event_id_value uuid;
  ledger_entry_id_value uuid;
  outbox_id_value uuid;
  recorded_at_value timestamptz;
  next_state_revision bigint;
  next_event_sequence bigint;
  next_ledger_sequence bigint;
  event_hash_value bytea;
  entry_hash_value bytea;
  graph_checksum_value bytea;
  simulation_checksum_value bytea;
  initial_outcome_hash_value bytea;
BEGIN
  PERFORM public.worldgraph_lock_world_compilation(checked_world_id);
  SELECT runtime.state_revision, runtime.last_event_sequence,
    runtime.last_ledger_sequence, runtime.active_world_version_id,
    runtime.projection_checksum, version.version_number, version.seed,
    ledger.next_event_sequence, ledger.next_ledger_sequence,
    ledger.last_entry_hash
  INTO source_record
  FROM public.worlds world
  JOIN public.world_runtime_heads runtime ON runtime.world_id = world.id
  JOIN public.world_versions version
    ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
  JOIN public.world_ledger_heads ledger ON ledger.world_id = runtime.world_id
  WHERE world.id = checked_world_id
    AND world.lifecycle = 'active'::world_lifecycle
    AND world.active_world_version_id = runtime.active_world_version_id
    AND version.status = 'active'::world_version_status
    AND runtime.ledger_anchored_at IS NOT NULL
    AND runtime.ledger_anchor_event_id = ledger.anchor_event_id
    AND runtime.anchor_artifact_hash = ledger.anchor_artifact_hash
    AND ledger.anchored_at IS NOT NULL
    AND runtime.last_event_sequence = ledger.next_event_sequence - 1
    AND runtime.last_ledger_sequence = ledger.next_ledger_sequence - 1
  FOR UPDATE OF runtime, ledger;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simulation initialization requires an anchored active world'
      USING ERRCODE = '55000';
  END IF;

  command_id_value := substr(encode(extensions.digest(convert_to(
    'worldgraph:m07:simulation-init:command:' || checked_world_id::text, 'UTF8'
  ), 'sha256'), 'hex'), 1, 32)::uuid;
  event_id_value := substr(encode(extensions.digest(convert_to(
    'worldgraph:m07:simulation-init:event:' || checked_world_id::text, 'UTF8'
  ), 'sha256'), 'hex'), 1, 32)::uuid;
  ledger_entry_id_value := substr(encode(extensions.digest(convert_to(
    'worldgraph:m07:simulation-init:ledger:' || checked_world_id::text, 'UTF8'
  ), 'sha256'), 'hex'), 1, 32)::uuid;
  outbox_id_value := substr(encode(extensions.digest(convert_to(
    'worldgraph:m07:simulation-init:outbox:' || checked_world_id::text, 'UTF8'
  ), 'sha256'), 'hex'), 1, 32)::uuid;

  IF EXISTS (SELECT 1 FROM public.world_simulation_clocks WHERE world_id = checked_world_id)
    OR EXISTS (SELECT 1 FROM public.world_schedule_heads WHERE world_id = checked_world_id)
    OR EXISTS (SELECT 1 FROM public.command_records WHERE id = command_id_value)
    OR EXISTS (SELECT 1 FROM public.domain_events WHERE id = event_id_value)
    OR EXISTS (
      SELECT 1 FROM public.projection_checkpoints
      WHERE world_id = checked_world_id AND projection_name = 'simulation_runtime'
    ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.world_simulation_clocks clock
      JOIN public.world_schedule_heads schedule ON schedule.world_id = clock.world_id
      JOIN public.command_records command
        ON command.id = command_id_value AND command.world_id = clock.world_id
      JOIN public.domain_events event
        ON event.id = event_id_value AND event.world_id = clock.world_id
        AND event.command_id = command.id
      JOIN public.ledger_entries entry
        ON entry.world_id = event.world_id AND entry.event_id = event.id
        AND entry.command_id = command.id
      JOIN public.outbox_messages message
        ON message.world_id = event.world_id AND message.event_id = event.id
        AND message.message_type = 'DomainEventReferenceV1'
      JOIN public.world_history_entries history
        ON history.world_id = entry.world_id
        AND history.ledger_sequence = entry.ledger_sequence
        AND history.event_id = event.id
      JOIN public.projection_checkpoints checkpoint
        ON checkpoint.world_id = clock.world_id
        AND checkpoint.projection_name = 'simulation_runtime'
      WHERE clock.world_id = checked_world_id
        AND command.status = 'accepted'::command_record_status
        AND command.command_type = 'InitializeWorldSimulationV1'
        AND event.aggregate_type = 'simulation_clock'
        AND event.aggregate_version = 1
        AND event.event_type = 'WorldSimulationInitializedV1'
        AND checkpoint.projection_schema_version = 1
    ) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'partial simulation initialization requires forward repair'
      USING ERRCODE = '55000';
  END IF;

  IF source_record.projection_checksum IS DISTINCT FROM
      public.worldgraph_projection_checksum(checked_world_id, source_record.state_revision) THEN
    RAISE EXCEPTION 'simulation initialization refuses a divergent graph projection'
      USING ERRCODE = '55000';
  END IF;

  resolved_config := public.worldgraph_resolve_simulation_clock_config(checked_world_id);
  configuration_value := resolved_config -> 'configuration';
  provenance_value := resolved_config ->> 'provenance';
  initial_outcome_hash_value := public.worldgraph_initial_simulation_outcome_hash_v1(
    source_record.seed
  );
  payload_value := jsonb_build_object(
    'configuration', configuration_value,
    'currentTick', '0',
    'mode', 'paused',
    'processRegistryVersion', 1,
    'provenance', provenance_value
  );
  recorded_at_value := date_trunc('milliseconds', transaction_timestamp());
  next_state_revision := source_record.state_revision + 1;
  next_event_sequence := source_record.last_event_sequence + 1;
  next_ledger_sequence := source_record.last_ledger_sequence + 1;
  metadata_value := jsonb_build_object(
    'actor', jsonb_build_object(
      'actorId', 'worldgraph:simulation-bootstrap', 'actorType', 'system'
    ),
    'authorizationRuleId', 'system.simulation.initialize',
    'causationId', NULL,
    'commandSchemaVersion', 1,
    'commandType', 'InitializeWorldSimulationV1',
    'correlationId', command_id_value::text,
    'overrideId', NULL,
    'payloadClassification', 'member'
  );

  INSERT INTO public.command_records(
    id, world_id, command_type, command_schema_version, actor_type, actor_id,
    payload, payload_hash, payload_classification, idempotency_key, request_hash,
    expected_world_version, expected_state_revision, expected_aggregate_version,
    correlation_id, requested_at
  ) VALUES (
    command_id_value, checked_world_id, 'InitializeWorldSimulationV1', 1,
    'system', 'worldgraph:simulation-bootstrap', payload_value,
    extensions.digest(convert_to(public.worldgraph_canonical_jsonb(payload_value), 'UTF8'), 'sha256'),
    'member', 'm07-simulation-init',
    extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
      'commandType', 'InitializeWorldSimulationV1',
      'payload', payload_value,
      'worldId', checked_world_id::text
    )), 'UTF8'), 'sha256'),
    source_record.version_number, source_record.state_revision, 0,
    command_id_value, recorded_at_value
  );
  PERFORM public.worldgraph_open_command_write(command_id_value, checked_world_id);

  INSERT INTO public.world_simulation_clocks(
    world_id, clock_schema_version, epoch_at, current_tick,
    world_milliseconds_per_tick, wall_cadence_milliseconds, mode,
    max_batch_ticks, max_catch_up_ticks, prng_algorithm_version,
    outcome_hash, last_wall_anchor_at, row_version, updated_state_revision, updated_at
  ) VALUES (
    checked_world_id, 1, (configuration_value ->> 'epochAt')::timestamptz, 0,
    (configuration_value ->> 'worldMillisecondsPerTick')::bigint,
    (configuration_value ->> 'wallCadenceMilliseconds')::integer,
    'paused',
    (configuration_value ->> 'maxBatchTicks')::integer,
    (configuration_value ->> 'maxCatchUpTicks')::integer,
    configuration_value ->> 'prngAlgorithmVersion',
    initial_outcome_hash_value, NULL, 1, next_state_revision, recorded_at_value
  );
  INSERT INTO public.world_schedule_heads(world_id, next_schedule_sequence, updated_at)
  VALUES (checked_world_id, 1, recorded_at_value);

  event_hash_value := public.worldgraph_domain_event_hash_v1(
    event_id_value, checked_world_id, next_event_sequence, command_id_value, 0,
    'simulation_clock', checked_world_id::text, 1,
    'WorldSimulationInitializedV1', 1, payload_value, metadata_value,
    recorded_at_value, recorded_at_value, next_state_revision
  );
  INSERT INTO public.domain_events(
    id, world_id, world_event_sequence, command_id, event_ordinal,
    aggregate_type, aggregate_id, aggregate_version, event_type,
    event_schema_version, payload, metadata, event_hash, occurred_at,
    recorded_at, resulting_state_revision
  ) VALUES (
    event_id_value, checked_world_id, next_event_sequence, command_id_value, 0,
    'simulation_clock', checked_world_id::text, 1,
    'WorldSimulationInitializedV1', 1, payload_value, metadata_value,
    event_hash_value, recorded_at_value, recorded_at_value, next_state_revision
  );

  entry_hash_value := public.worldgraph_ledger_entry_hash_v1(
    ledger_entry_id_value, checked_world_id, next_ledger_sequence,
    'domain_event', command_id_value, event_id_value,
    'system', 'worldgraph:simulation-bootstrap',
    'WORLD_SIMULATION_INITIALIZED', jsonb_build_object(
      'eventType', 'WorldSimulationInitializedV1',
      'provenance', provenance_value
    ), source_record.last_entry_hash, recorded_at_value
  );
  INSERT INTO public.ledger_entries(
    id, world_id, ledger_sequence, entry_kind, command_id, event_id,
    actor_type, actor_id, public_summary_code, redacted_details,
    previous_hash, entry_hash, recorded_at
  ) VALUES (
    ledger_entry_id_value, checked_world_id, next_ledger_sequence,
    'domain_event', command_id_value, event_id_value,
    'system', 'worldgraph:simulation-bootstrap',
    'WORLD_SIMULATION_INITIALIZED', jsonb_build_object(
      'eventType', 'WorldSimulationInitializedV1',
      'provenance', provenance_value
    ), source_record.last_entry_hash, entry_hash_value, recorded_at_value
  );

  graph_checksum_value := public.worldgraph_projection_checksum(
    checked_world_id, next_state_revision
  );
  UPDATE public.world_runtime_heads
  SET state_revision = next_state_revision,
      last_event_sequence = next_event_sequence,
      last_ledger_sequence = next_ledger_sequence,
      projection_checksum = graph_checksum_value,
      updated_at = greatest(updated_at, recorded_at_value)
  WHERE world_id = checked_world_id;
  UPDATE public.projection_checkpoints
  SET last_event_sequence = next_event_sequence,
      checksum = graph_checksum_value,
      status = 'current',
      updated_at = greatest(updated_at, recorded_at_value)
  WHERE world_id = checked_world_id AND projection_name = 'world_graph';

  simulation_checksum_value := public.worldgraph_simulation_projection_checksum(checked_world_id);
  INSERT INTO public.projection_checkpoints(
    world_id, projection_name, projection_schema_version,
    last_event_sequence, checksum, status, updated_at
  ) VALUES (
    checked_world_id, 'simulation_runtime', 1,
    next_event_sequence, simulation_checksum_value, 'current', recorded_at_value
  );
  INSERT INTO public.outbox_messages(
    id, world_id, event_id, message_type, message_schema_version,
    payload, status, attempts, available_at, created_at
  ) VALUES (
    outbox_id_value, checked_world_id, event_id_value,
    'DomainEventReferenceV1', 1,
    jsonb_build_object(
      'eventId', event_id_value::text,
      'eventType', 'WorldSimulationInitializedV1',
      'worldEventSequence', next_event_sequence::text,
      'worldId', checked_world_id::text
    ), 'pending', 0, recorded_at_value, recorded_at_value
  );
  INSERT INTO public.world_history_entries(
    world_id, ledger_sequence, command_id, event_id, event_type, occurred_at,
    category, title_key, summary_args, actor_type, actor_id,
    target_type, target_id, visibility, correlation_id, resulting_state_revision
  ) VALUES (
    checked_world_id, next_ledger_sequence, command_id_value, event_id_value,
    'WorldSimulationInitializedV1', recorded_at_value,
    'simulation', 'history.simulation.initialized', jsonb_build_object(
      'currentTick', '0',
      'processRegistryVersion', 1,
      'provenance', provenance_value
    ), 'system', 'worldgraph:simulation-bootstrap',
    'world_simulation', checked_world_id::text, 'member',
    command_id_value, next_state_revision
  );
  UPDATE public.command_records
  SET status = 'accepted',
      authorization_rule_id = 'system.simulation.initialize',
      decided_at = recorded_at_value,
      resulting_state_revision = next_state_revision,
      response_summary = jsonb_build_object(
        'commandId', command_id_value::text,
        'eventIds', jsonb_build_array(event_id_value::text),
        'eventSequenceRange', jsonb_build_object(
          'from', next_event_sequence::text, 'to', next_event_sequence::text
        ),
        'ledgerSequenceRange', jsonb_build_object(
          'from', next_ledger_sequence::text, 'to', next_ledger_sequence::text
        ),
        'resultingStateRevision', next_state_revision::text,
        'schemaVersion', 1,
        'status', 'accepted'
      )
  WHERE id = command_id_value;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_initialize_simulation(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_simulation_command_terminal(checked_command_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_record record;
  runtime_record record;
  clock_record record;
  checkpoint_record record;
  primary_event record;
  latest_projection_revision bigint;
  expected_aggregate_type text;
BEGIN
  SELECT * INTO command_record FROM public.command_records WHERE id = checked_command_id;
  IF NOT FOUND OR command_record.command_type NOT IN (
    'InitializeWorldSimulationV1', 'ConfigureWorldClockV1',
    'StartWorldClockV1', 'PauseWorldClockV1', 'AdvanceSimulationV1',
    'ScheduleWorldNoticeV1', 'CancelScheduledActionV1',
    'AutoPauseWorldClockV1', 'ResolveSimulationFailureV1'
  ) OR command_record.status = 'received'::command_record_status THEN
    RETURN;
  END IF;
  IF command_record.world_id IS NULL OR command_record.expected_aggregate_version IS NULL THEN
    RAISE EXCEPTION 'simulation command requires world and expected aggregate version'
      USING ERRCODE = '55000';
  END IF;

  expected_aggregate_type := CASE command_record.command_type
    WHEN 'InitializeWorldSimulationV1' THEN 'simulation_clock'
    WHEN 'ConfigureWorldClockV1' THEN 'simulation_clock'
    WHEN 'StartWorldClockV1' THEN 'simulation_clock'
    WHEN 'PauseWorldClockV1' THEN 'simulation_clock'
    WHEN 'AdvanceSimulationV1' THEN 'simulation_clock'
    WHEN 'AutoPauseWorldClockV1' THEN 'simulation_clock'
    WHEN 'ScheduleWorldNoticeV1' THEN 'scheduled_action'
    WHEN 'CancelScheduledActionV1' THEN 'scheduled_action'
    WHEN 'ResolveSimulationFailureV1' THEN 'simulation_failure'
  END;
  IF command_record.status = 'accepted'::command_record_status THEN
    SELECT event.aggregate_type, event.aggregate_version, event.payload
    INTO primary_event
    FROM public.domain_events event
    WHERE event.command_id = command_record.id
    ORDER BY event.event_ordinal, event.world_event_sequence, event.id
    LIMIT 1;
    IF NOT FOUND OR primary_event.aggregate_type <> expected_aggregate_type
      OR primary_event.aggregate_version <> command_record.expected_aggregate_version + 1 THEN
      RAISE EXCEPTION 'simulation command primary event violates aggregate concurrency'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT * INTO runtime_record FROM public.world_runtime_heads
  WHERE world_id = command_record.world_id;
  SELECT * INTO clock_record FROM public.world_simulation_clocks
  WHERE world_id = command_record.world_id;
  SELECT * INTO checkpoint_record FROM public.projection_checkpoints
  WHERE world_id = command_record.world_id AND projection_name = 'simulation_runtime';
  IF runtime_record.world_id IS NULL OR clock_record.world_id IS NULL
    OR checkpoint_record.world_id IS NULL
    OR NOT public.worldgraph_schedule_projection_is_contiguous(command_record.world_id)
    OR EXISTS (
      SELECT 1 FROM public.scheduled_actions action
      WHERE action.world_id = command_record.world_id
        AND action.status = 'scheduled'::scheduled_action_status
        AND action.due_tick <= clock_record.current_tick
    )
    OR checkpoint_record.projection_schema_version <> 1
    OR checkpoint_record.status <> 'current'::projection_checkpoint_status
    OR checkpoint_record.last_event_sequence <> runtime_record.last_event_sequence
    OR checkpoint_record.checksum IS DISTINCT FROM
      public.worldgraph_simulation_projection_checksum(command_record.world_id) THEN
    RAISE EXCEPTION 'simulation command did not publish a current clock/schedule checkpoint'
      USING ERRCODE = '55000';
  END IF;

  IF command_record.status = 'accepted'::command_record_status THEN
    SELECT greatest(
      clock_record.updated_state_revision,
      COALESCE(max(action.created_state_revision), 0),
      COALESCE(max(action.completed_state_revision), 0)
    ) INTO latest_projection_revision
    FROM public.scheduled_actions action
    WHERE action.world_id = command_record.world_id;
    IF command_record.command_type = 'AdvanceSimulationV1' THEN
      IF primary_event.payload ->> 'outcomeHash' IS NULL
        OR primary_event.payload ->> 'outcomeHash' !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'accepted simulation advance has an invalid outcome hash fact'
          USING ERRCODE = '55000';
      END IF;
      IF decode(primary_event.payload ->> 'outcomeHash', 'hex')
        IS DISTINCT FROM clock_record.outcome_hash THEN
        RAISE EXCEPTION 'accepted simulation advance did not publish its clock outcome hash'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF runtime_record.state_revision <> command_record.resulting_state_revision THEN
      RAISE EXCEPTION 'accepted simulation command did not apply its resulting revision'
        USING ERRCODE = '55000';
    ELSIF command_record.command_type = 'ResolveSimulationFailureV1' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.simulation_failures failure
        WHERE failure.world_id = command_record.world_id
          AND failure.status = 'resolved'::simulation_failure_status
          AND failure.resolution_command_id = command_record.id
      ) THEN
        RAISE EXCEPTION 'accepted failure resolution did not resolve its target'
          USING ERRCODE = '55000';
      END IF;
    ELSIF latest_projection_revision <> command_record.resulting_state_revision THEN
      RAISE EXCEPTION 'accepted simulation command did not apply its resulting revision'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_simulation_command_terminal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.worldgraph_assert_simulation_command_terminal(NEW.id);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER command_records_require_simulation_terminal
  AFTER INSERT OR UPDATE ON command_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_simulation_command_terminal();
--> statement-breakpoint
CREATE FUNCTION worldgraph_advance_simulation_checkpoint_for_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.projection_checkpoints
  SET last_event_sequence = NEW.world_event_sequence,
      checksum = public.worldgraph_simulation_projection_checksum(NEW.world_id),
      status = 'current',
      updated_at = greatest(updated_at, NEW.recorded_at)
  WHERE world_id = NEW.world_id
    AND projection_name = 'simulation_runtime'
    AND last_event_sequence < NEW.world_event_sequence;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER domain_events_advance_simulation_checkpoint
  AFTER INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION worldgraph_advance_simulation_checkpoint_for_event();
--> statement-breakpoint
DO $initialize_existing_worlds$
DECLARE
  active_world record;
BEGIN
  FOR active_world IN
    SELECT world.id
    FROM worlds world
    JOIN world_runtime_heads runtime ON runtime.world_id = world.id
    JOIN world_ledger_heads ledger ON ledger.world_id = runtime.world_id
    WHERE world.lifecycle = 'active'
      AND runtime.ledger_anchored_at IS NOT NULL
      AND ledger.anchored_at IS NOT NULL
    ORDER BY world.id
  LOOP
    PERFORM public.worldgraph_initialize_simulation(active_world.id);
  END LOOP;
END
$initialize_existing_worlds$;
--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
CREATE FUNCTION worldgraph_initialize_simulation_after_activation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.lifecycle = 'active'::world_lifecycle THEN
    PERFORM public.worldgraph_initialize_simulation(NEW.id);
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER zz_worlds_initialize_simulation
  AFTER INSERT OR UPDATE ON worlds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_initialize_simulation_after_activation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_initialize_simulation_after_activation() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_active_world_simulation(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.worlds world
    WHERE world.id = checked_world_id AND world.lifecycle = 'active'::world_lifecycle
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.world_simulation_clocks clock
    JOIN public.world_schedule_heads schedule ON schedule.world_id = clock.world_id
    JOIN public.world_runtime_heads runtime ON runtime.world_id = clock.world_id
    JOIN public.projection_checkpoints checkpoint
      ON checkpoint.world_id = clock.world_id
      AND checkpoint.projection_name = 'simulation_runtime'
    WHERE clock.world_id = checked_world_id
      AND checkpoint.projection_schema_version = 1
      AND checkpoint.status = 'current'::projection_checkpoint_status
      AND checkpoint.last_event_sequence = runtime.last_event_sequence
      AND checkpoint.checksum = public.worldgraph_simulation_projection_checksum(checked_world_id)
      AND public.worldgraph_schedule_projection_is_contiguous(checked_world_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.scheduled_actions action
        WHERE action.world_id = clock.world_id
          AND action.status = 'scheduled'::scheduled_action_status
          AND action.due_tick <= clock.current_tick
      )
      AND EXISTS (
        SELECT 1
        FROM public.command_records command
        JOIN public.domain_events event ON event.command_id = command.id
        JOIN public.ledger_entries entry
          ON entry.event_id = event.id AND entry.command_id = command.id
        JOIN public.outbox_messages message
          ON message.event_id = event.id
          AND message.message_type = 'DomainEventReferenceV1'
        WHERE command.world_id = checked_world_id
          AND command.command_type = 'InitializeWorldSimulationV1'
          AND command.status = 'accepted'::command_record_status
          AND event.world_id = checked_world_id
          AND event.event_type = 'WorldSimulationInitializedV1'
          AND entry.world_id = checked_world_id
          AND message.world_id = checked_world_id
      )
  ) THEN
    RAISE EXCEPTION 'active world requires complete simulation initialization'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_active_world_simulation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.worldgraph_assert_active_world_simulation(COALESCE(NEW.id, OLD.id));
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER zzz_worlds_require_simulation
  AFTER INSERT OR UPDATE OR DELETE ON worlds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_active_world_simulation();
--> statement-breakpoint
DO $metadata$
DECLARE
  changed integer;
BEGIN
  UPDATE platform_metadata
  SET value = value || jsonb_build_object(
        'contracts', 7,
        'runtimeSchema', 7,
        'simulationBatchSchema', 1,
        'simulationClockSchema', 1,
        'simulationFailureSchema', 1,
        'simulationOutcomeSchema', 1,
        'simulationPrngAlgorithm', 'xorshift32-sha256-v1',
        'simulationPrngSchema', 1,
        'simulationProcessRegistry', 1,
        'simulationProcessSchema', 1,
        'simulationProjectionSchema', 1,
        'simulationQueueSchema', 1,
        'simulationScheduleSchema', 1
      ),
      value_schema_version = 7,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 6
    AND value ->> 'compiler' = '1.0.0'
    AND value ->> 'contracts' = '6'
    AND value ->> 'runtimeSchema' = '6'
    AND value ->> 'worldGraphSchema' = '1'
    AND value ->> 'commandSchema' = '1'
    AND value ->> 'domainEventSchema' = '1'
    AND value ->> 'ledgerSchema' = '1'
    AND value ->> 'projectionSchema' = '1'
    AND value ->> 'outboxSchema' = '1'
    AND value ->> 'historySchema' = '1'
    AND NOT value ?| ARRAY[
      'simulationBatchSchema', 'simulationClockSchema', 'simulationFailureSchema',
      'simulationOutcomeSchema', 'simulationPrngAlgorithm', 'simulationPrngSchema',
      'simulationProcessRegistry', 'simulationProcessSchema', 'simulationProjectionSchema',
      'simulationQueueSchema', 'simulationScheduleSchema'
    ];
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact sealed M06 compatibility state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT USAGE ON TYPE simulation_clock_mode, scheduled_action_status,
      simulation_batch_status, simulation_failure_status TO worldgraph_app;
    GRANT SELECT ON world_simulation_clocks, world_schedule_heads,
      scheduled_actions, simulation_batch_runs, simulation_worker_leases,
      simulation_failures TO worldgraph_app;
    GRANT INSERT (expected_aggregate_version) ON command_records TO worldgraph_app;
    GRANT UPDATE (
      epoch_at, current_tick, world_milliseconds_per_tick,
      wall_cadence_milliseconds, mode, max_batch_ticks, max_catch_up_ticks,
      outcome_hash, last_wall_anchor_at, row_version, updated_state_revision, updated_at
    ) ON world_simulation_clocks TO worldgraph_app;
    GRANT INSERT (
      id, world_id, schedule_sequence, due_tick, priority, action_type,
      action_schema_version, payload, payload_hash, process_version,
      created_by_actor_type, created_by_actor_id, created_command_id,
      created_state_revision, created_at, updated_at
    ) ON scheduled_actions TO worldgraph_app;
    GRANT UPDATE (
      status, completed_event_id, cancelled_command_id,
      completed_state_revision, updated_at
    ) ON scheduled_actions TO worldgraph_app;
    GRANT INSERT (
      id, world_id, batch_schema_version, from_tick, to_tick, batch_key,
      process_registry_version, input_checksum, attempts, status, error_code,
      started_at, completed_at
    ) ON simulation_batch_runs TO worldgraph_app;
    GRANT UPDATE (
      outcome_hash, status, attempts, command_id, error_code, completed_at
    ) ON simulation_batch_runs TO worldgraph_app;
    GRANT INSERT (
      id, world_id, failure_schema_version, batch_run_id, tick, schedule_id,
      process_type, process_version, error_code, redacted_context,
      attempts, opened_at
    ) ON simulation_failures TO worldgraph_app;
    GRANT UPDATE (
      status, resolved_by_actor_id, resolved_at, resolution_command_id
    ) ON simulation_failures TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION
      worldgraph_open_command_write(uuid,uuid),
      worldgraph_resolve_simulation_clock_config(uuid),
      worldgraph_initial_simulation_outcome_hash_v1(text),
      worldgraph_simulation_projection_document(uuid),
      worldgraph_simulation_projection_checksum(uuid),
      worldgraph_schedule_projection_is_contiguous(uuid),
      worldgraph_allocate_schedule_sequence(uuid),
      worldgraph_acquire_simulation_lease(uuid,text,integer),
      worldgraph_renew_simulation_lease(uuid,text,bigint,integer),
      worldgraph_release_simulation_lease(uuid,text,bigint),
      worldgraph_simulation_lease_is_current(uuid,text,bigint),
      worldgraph_assert_simulation_command_terminal(uuid)
      TO worldgraph_app;
    REVOKE EXECUTE ON FUNCTION worldgraph_open_command_write_m06(uuid,uuid)
      FROM worldgraph_app;
    REVOKE INSERT, UPDATE, DELETE ON world_schedule_heads,
      simulation_worker_leases FROM worldgraph_app;
    REVOKE INSERT, DELETE ON world_simulation_clocks FROM worldgraph_app;
    REVOKE DELETE ON scheduled_actions, simulation_batch_runs,
      simulation_failures FROM worldgraph_app;
  END IF;
END
$grant$;
