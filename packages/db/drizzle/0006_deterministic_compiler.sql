CREATE TYPE world_lifecycle_m05 AS ENUM (
  'draft', 'manifest_approved', 'compiling', 'active', 'compile_failed'
);
--> statement-breakpoint
ALTER TABLE worlds ALTER COLUMN lifecycle DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE worlds
  ALTER COLUMN lifecycle TYPE world_lifecycle_m05
  USING lifecycle::text::world_lifecycle_m05;
--> statement-breakpoint
DROP TYPE world_lifecycle;
--> statement-breakpoint
ALTER TYPE world_lifecycle_m05 RENAME TO world_lifecycle;
--> statement-breakpoint
ALTER TABLE worlds ALTER COLUMN lifecycle SET DEFAULT 'draft'::world_lifecycle;
--> statement-breakpoint
CREATE TYPE world_compilation_status AS ENUM (
  'queued', 'running', 'succeeded', 'failed', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE world_compilation_stage AS ENUM (
  'queued', 'validating', 'compiling', 'seeding', 'activated', 'failed', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE world_version_status AS ENUM ('staging', 'active', 'superseded');
--> statement-breakpoint
CREATE FUNCTION worldgraph_jsonb_has_compiler_private_key(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  item_key text;
  normalized_key text;
  tokenized_key text;
  item_value jsonb;
BEGIN
  IF value IS NULL THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(value) = 'object' THEN
    FOR item_key, item_value IN SELECT key, val FROM jsonb_each(value) AS entry(key, val)
    LOOP
      normalized_key := lower(regexp_replace(item_key, '[^a-zA-Z0-9]', '', 'g'));
      tokenized_key := trim(both ' ' from lower(regexp_replace(
        regexp_replace(item_key, '([a-z0-9])([A-Z])', '\1 \2', 'g'),
        '[^a-zA-Z0-9]+', ' ', 'g'
      )));
      IF normalized_key = 'prompthash'
        AND jsonb_typeof(item_value) = 'string'
        AND (item_value #>> '{}') ~ '^[a-f0-9]{64}$' THEN
        CONTINUE;
      END IF;
      IF normalized_key = ANY (
        ARRAY[
          'email', 'emailaddress', 'ip', 'ipaddress', 'prompt', 'prompttext',
          'rawmodelresponse', 'rawproviderresponse', 'providerpayload', 'session',
          'sessionid', 'useragent', 'userid', 'actoruserid', 'requestedbyuserid'
        ]
      ) OR normalized_key ~ '^(apikey|csrf|email|invitation|invite|ipaddress|password|prompt|providerpayload|rawmodel|rawprovider|rawtoken|secret|session|useragent|userid)'
        OR normalized_key ~ '(credential|credentials|secret|token)$'
        OR (' ' || tokenized_key || ' ') ~ ' (authorization|cookie|credential|credentials|csrf|email|invitation|invite|ip|password|prompt|secret|session|token) '
        OR (' ' || tokenized_key || ' ') LIKE '% api key %'
        OR (' ' || tokenized_key || ' ') LIKE '% user id %'
        OR worldgraph_jsonb_has_compiler_private_key(item_value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR item_value IN SELECT element FROM jsonb_array_elements(value) AS entry(element)
    LOOP
      IF worldgraph_jsonb_has_compiler_private_key(item_value) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_jsonb_has_exact_keys(value jsonb, expected_keys text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(value) AS present(key)
      WHERE NOT (present.key = ANY (expected_keys))
    ) AND NOT EXISTS (
      SELECT 1 FROM unnest(expected_keys) AS expected(key)
      WHERE NOT (value ? expected.key)
    )
  END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_jsonb_string_matches(
  value jsonb,
  maximum_length integer,
  required_pattern text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'string' THEN false
    ELSE char_length(value #>> '{}') BETWEEN 1 AND maximum_length
      AND (value #>> '{}') ~ required_pattern
  END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_jsonb_unique_string_array_matches(
  value jsonb,
  maximum_items integer,
  maximum_item_length integer,
  required_pattern text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  item_count integer;
  distinct_item_count integer;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > maximum_items THEN
    RETURN false;
  END IF;
  SELECT count(*)::integer, count(DISTINCT item)::integer
  INTO item_count, distinct_item_count
  FROM jsonb_array_elements(value) AS entry(item);
  RETURN item_count = distinct_item_count AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) AS entry(item)
    WHERE NOT worldgraph_jsonb_string_matches(item, maximum_item_length, required_pattern)
  );
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_jsonb_integer_between(value jsonb, minimum_value integer, maximum_value integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'number' THEN false
    ELSE (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
      AND (value #>> '{}')::numeric BETWEEN minimum_value AND maximum_value
  END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_visual_plan_districts_are_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 32 THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) AS entry(item)
    WHERE NOT (
      worldgraph_jsonb_has_exact_keys(
        item,
        ARRAY['districtLogicalKey','rotationMilliDegrees','xMilliunits','yMilliunits']
      )
      AND worldgraph_jsonb_string_matches(
        item -> 'districtLogicalKey', 240,
        '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
      )
      AND worldgraph_jsonb_integer_between(item -> 'rotationMilliDegrees', 0, 359999)
      AND worldgraph_jsonb_integer_between(item -> 'xMilliunits', -1000000, 1000000)
      AND worldgraph_jsonb_integer_between(item -> 'yMilliunits', -1000000, 1000000)
    )
  );
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_world_entity_state_is_valid(
  checked_entity_type text,
  checked_schema_version integer,
  checked_state jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  logical_key_pattern constant text := '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$';
  local_key_pattern constant text := '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';
BEGIN
  IF checked_schema_version <> 1 OR jsonb_typeof(checked_state) <> 'object' THEN
    RETURN false;
  END IF;
  CASE checked_entity_type
    WHEN 'district' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state, ARRAY['name','parameters','primitiveRef']
        )
        AND worldgraph_jsonb_string_matches(checked_state -> 'name', 100, '^[^[:cntrl:]]+$')
        AND jsonb_typeof(checked_state -> 'parameters') = 'object'
        AND worldgraph_jsonb_string_matches(checked_state -> 'primitiveRef', 64, local_key_pattern);
    WHEN 'institution' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state,
          ARRAY['districtLogicalKey','name','organizationLogicalKeys','parameters','primitiveRef']
        )
        AND (
          checked_state -> 'districtLogicalKey' = 'null'::jsonb
          OR worldgraph_jsonb_string_matches(
            checked_state -> 'districtLogicalKey', 240, logical_key_pattern
          )
        )
        AND worldgraph_jsonb_string_matches(checked_state -> 'name', 100, '^[^[:cntrl:]]+$')
        AND worldgraph_jsonb_unique_string_array_matches(
          checked_state -> 'organizationLogicalKeys', 32, 240, logical_key_pattern
        )
        AND jsonb_typeof(checked_state -> 'parameters') = 'object'
        AND worldgraph_jsonb_string_matches(checked_state -> 'primitiveRef', 64, local_key_pattern);
    WHEN 'organization' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state, ARRAY['homeDistrictLogicalKey','name','parameters','primitiveRef']
        )
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'homeDistrictLogicalKey', 240, logical_key_pattern
        )
        AND worldgraph_jsonb_string_matches(checked_state -> 'name', 100, '^[^[:cntrl:]]+$')
        AND jsonb_typeof(checked_state -> 'parameters') = 'object'
        AND worldgraph_jsonb_string_matches(checked_state -> 'primitiveRef', 64, local_key_pattern);
    WHEN 'actor_blueprint' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state,
          ARRAY[
            'controller','homeDistrictLogicalKey','name','organizationLogicalKey',
            'parameters','rolePrimitiveRef'
          ]
        )
        AND jsonb_typeof(checked_state -> 'controller') = 'string'
        AND checked_state ->> 'controller' IN ('player', 'system')
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'homeDistrictLogicalKey', 240, logical_key_pattern
        )
        AND worldgraph_jsonb_string_matches(checked_state -> 'name', 100, '^[^[:cntrl:]]+$')
        AND (
          checked_state -> 'organizationLogicalKey' = 'null'::jsonb
          OR worldgraph_jsonb_string_matches(
            checked_state -> 'organizationLogicalKey', 240, logical_key_pattern
          )
        )
        AND jsonb_typeof(checked_state -> 'parameters') = 'object'
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'rolePrimitiveRef', 64, local_key_pattern
        );
    WHEN 'account_principal' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state, ARRAY['membershipRole','principalKey']
        )
        AND jsonb_typeof(checked_state -> 'membershipRole') = 'string'
        AND checked_state ->> 'membershipRole' IN ('creator', 'administrator', 'player')
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'principalKey', 39, '^member-[a-f0-9]{32}$'
        );
    WHEN 'player_character' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state,
          ARRAY[
            'blueprintLogicalKey','homeDistrictLogicalKey','membershipRole','name',
            'organizationLogicalKey'
          ]
        )
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'blueprintLogicalKey', 240, logical_key_pattern
        )
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'homeDistrictLogicalKey', 240, logical_key_pattern
        )
        AND jsonb_typeof(checked_state -> 'membershipRole') = 'string'
        AND checked_state ->> 'membershipRole' IN ('creator', 'administrator', 'player')
        AND worldgraph_jsonb_string_matches(checked_state -> 'name', 100, '^[^[:cntrl:]]+$')
        AND (
          checked_state -> 'organizationLogicalKey' = 'null'::jsonb
          OR worldgraph_jsonb_string_matches(
            checked_state -> 'organizationLogicalKey', 240, logical_key_pattern
          )
        );
    WHEN 'primitive_instance' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state,
          ARRAY['behaviorRef','contentHash','key','kind','parameters','ref','version']
        )
        AND (
          checked_state -> 'behaviorRef' = 'null'::jsonb
          OR worldgraph_jsonb_string_matches(checked_state -> 'behaviorRef', 160, '^.+$')
        )
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'contentHash', 64, '^[a-f0-9]{64}$'
        )
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'key', 160,
          '^[a-z][a-z0-9]*([.][a-z0-9]+(-[a-z0-9]+)*){2,}$'
        )
        AND jsonb_typeof(checked_state -> 'kind') = 'string'
        AND checked_state ->> 'kind' IN (
          'government','election','currency','tax','resource','production_recipe',
          'terrain','district','building','organization','office','legal_right',
          'player_role','visual_style','simulation_rule','event_template'
        )
        AND jsonb_typeof(checked_state -> 'parameters') = 'object'
        AND worldgraph_jsonb_string_matches(checked_state -> 'ref', 64, local_key_pattern)
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'version', 64, '^[0-9]+[.][0-9]+[.][0-9]+([+-][0-9A-Za-z.-]+)?$'
        );
    WHEN 'currency_definition_intent', 'resource_definition_intent',
         'production_definition_intent', 'tax_definition_intent' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state, ARRAY['parameters','primitiveRef']
        )
        AND jsonb_typeof(checked_state -> 'parameters') = 'object'
        AND worldgraph_jsonb_string_matches(checked_state -> 'primitiveRef', 64, local_key_pattern);
    WHEN 'economy_configuration' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state,
          ARRAY[
            'currencyLogicalKey','productionLogicalKeys','resourceLogicalKeys','taxLogicalKeys'
          ]
        )
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'currencyLogicalKey', 240, logical_key_pattern
        )
        AND worldgraph_jsonb_unique_string_array_matches(
          checked_state -> 'productionLogicalKeys', 16, 240, logical_key_pattern
        )
        AND worldgraph_jsonb_unique_string_array_matches(
          checked_state -> 'resourceLogicalKeys', 32, 240, logical_key_pattern
        )
        AND worldgraph_jsonb_unique_string_array_matches(
          checked_state -> 'taxLogicalKeys', 16, 240, logical_key_pattern
        );
    WHEN 'simulation_configuration' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state, ARRAY['eventPrimitiveRefs','rulePrimitiveRefs','settings']
        )
        AND worldgraph_jsonb_unique_string_array_matches(
          checked_state -> 'eventPrimitiveRefs', 32, 64, local_key_pattern
        )
        AND worldgraph_jsonb_unique_string_array_matches(
          checked_state -> 'rulePrimitiveRefs', 32, 64, local_key_pattern
        )
        AND jsonb_typeof(checked_state -> 'settings') = 'object';
    WHEN 'visual_plan' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_state,
          ARRAY[
            'direction','districts','schemaVersion','stylePrimitiveLogicalKey',
            'terrainPrimitiveLogicalKey'
          ]
        )
        AND worldgraph_jsonb_string_matches(checked_state -> 'direction', 500, '^.+$')
        AND worldgraph_visual_plan_districts_are_valid(checked_state -> 'districts')
        AND checked_state -> 'schemaVersion' = '1'::jsonb
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'stylePrimitiveLogicalKey', 240, logical_key_pattern
        )
        AND worldgraph_jsonb_string_matches(
          checked_state -> 'terrainPrimitiveLogicalKey', 240, logical_key_pattern
        );
    ELSE
      RETURN false;
  END CASE;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_world_relationship_attributes_are_valid(
  checked_relationship_type text,
  checked_schema_version integer,
  checked_attributes jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  local_key_pattern constant text := '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';
BEGIN
  IF checked_schema_version <> 1 OR jsonb_typeof(checked_attributes) <> 'object' THEN
    RETURN false;
  END IF;
  CASE checked_relationship_type
    WHEN 'account_controls', 'instantiates', 'uses_primitive' THEN
      RETURN checked_attributes = '{}'::jsonb;
    WHEN 'connected_to' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_attributes, ARRAY['bidirectional','connectionKind']
        )
        AND checked_attributes -> 'bidirectional' = 'true'::jsonb
        AND jsonb_typeof(checked_attributes -> 'connectionKind') = 'string'
        AND checked_attributes ->> 'connectionKind' IN ('walkway', 'transit', 'service');
    WHEN 'cooperates_with', 'governs', 'rivals', 'supplies' THEN
      RETURN worldgraph_jsonb_has_exact_keys(
          checked_attributes, ARRAY['manifestRelationshipKey']
        )
        AND worldgraph_jsonb_string_matches(
          checked_attributes -> 'manifestRelationshipKey', 64, local_key_pattern
        );
    WHEN 'located_in', 'member_of' THEN
      RETURN checked_attributes = '{}'::jsonb OR (
        worldgraph_jsonb_has_exact_keys(
          checked_attributes, ARRAY['manifestRelationshipKey']
        )
        AND worldgraph_jsonb_string_matches(
          checked_attributes -> 'manifestRelationshipKey', 64, local_key_pattern
        )
      );
    WHEN 'participates_in' THEN
      RETURN worldgraph_jsonb_has_exact_keys(checked_attributes, ARRAY['basis'])
        AND checked_attributes -> 'basis' = '"institution-participation"'::jsonb;
    ELSE
      RETURN false;
  END CASE;
END
$function$;
--> statement-breakpoint
ALTER TABLE worlds ADD COLUMN active_world_version_id uuid;
--> statement-breakpoint
CREATE TABLE world_compilation_runs (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  manifest_revision_id uuid NOT NULL,
  manifest_content_hash bytea NOT NULL,
  input_hash bytea NOT NULL,
  compiler_version text NOT NULL,
  compiler_config_version integer NOT NULL,
  seed text NOT NULL,
  status world_compilation_status NOT NULL DEFAULT 'queued',
  stage world_compilation_stage NOT NULL DEFAULT 'queued',
  progress_percent integer NOT NULL DEFAULT 0,
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  artifact_hash bytea,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT world_compilation_runs_world_identity UNIQUE (id, world_id),
  CONSTRAINT world_compilation_runs_exact_identity UNIQUE (
    id, world_id, manifest_revision_id, compiler_version,
    compiler_config_version, seed, artifact_hash
  ),
  CONSTRAINT world_compilation_runs_input_identity UNIQUE (
    world_id, input_hash, compiler_version, compiler_config_version, seed
  ),
  CONSTRAINT world_compilation_runs_idempotency_unique UNIQUE (
    world_id, requested_by_user_id, idempotency_key
  ),
  CONSTRAINT world_compilation_runs_manifest_exact_fk
    FOREIGN KEY (manifest_revision_id, world_id, manifest_content_hash)
    REFERENCES manifest_revisions(id, world_id, content_hash)
    ON DELETE RESTRICT,
  CONSTRAINT world_compilation_runs_requester_membership_fk
    FOREIGN KEY (world_id, requested_by_user_id)
    REFERENCES world_memberships(world_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_compilation_runs_hash_lengths CHECK (
    octet_length(manifest_content_hash) = 32
    AND octet_length(input_hash) = 32
    AND (artifact_hash IS NULL OR octet_length(artifact_hash) = 32)
  ),
  CONSTRAINT world_compilation_runs_compiler_known CHECK (
    compiler_version = '1.0.0' AND compiler_config_version = 1
  ),
  CONSTRAINT world_compilation_runs_seed_bounded CHECK (
    char_length(seed) BETWEEN 1 AND 128
    AND seed = btrim(seed)
    AND seed !~ '[[:cntrl:]]'
  ),
  CONSTRAINT world_compilation_runs_idempotency_bounded CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key = btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT world_compilation_runs_diagnostics_bounded CHECK (
    jsonb_typeof(diagnostics) = 'array'
    AND jsonb_array_length(diagnostics) <= 256
    AND pg_column_size(diagnostics) <= 262144
    AND NOT worldgraph_jsonb_has_sensitive_key(diagnostics)
    AND NOT worldgraph_jsonb_has_compiler_private_key(diagnostics)
  ),
  CONSTRAINT world_compilation_runs_attempts_bounded CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT world_compilation_runs_progress_bounded CHECK (progress_percent BETWEEN 0 AND 100),
  CONSTRAINT world_compilation_runs_row_version_positive CHECK (row_version > 0),
  CONSTRAINT world_compilation_runs_state_consistent CHECK (
    (
      status = 'queued' AND stage = 'queued' AND progress_percent = 0
      AND diagnostics = '[]'::jsonb AND artifact_hash IS NULL
      AND claim_token IS NULL AND claimed_at IS NULL AND heartbeat_at IS NULL
      AND started_at IS NULL AND completed_at IS NULL
    )
    OR (
      status = 'running' AND stage IN ('validating', 'compiling', 'seeding')
      AND progress_percent BETWEEN 1 AND 99 AND attempts BETWEEN 1 AND 3
      AND artifact_hash IS NULL AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND completed_at IS NULL
    )
    OR (
      status = 'succeeded' AND stage = 'activated' AND progress_percent = 100
      AND attempts BETWEEN 1 AND 3 AND artifact_hash IS NOT NULL
      AND claim_token IS NULL AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND completed_at IS NOT NULL
    )
    OR (
      status = 'failed' AND stage = 'failed' AND progress_percent BETWEEN 1 AND 99
      AND attempts BETWEEN 1 AND 3 AND artifact_hash IS NULL
      AND jsonb_array_length(diagnostics) > 0 AND claim_token IS NULL
      AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL
      AND started_at IS NOT NULL AND completed_at IS NOT NULL
    )
    OR (
      status = 'cancelled' AND stage = 'cancelled' AND progress_percent BETWEEN 0 AND 100
      AND artifact_hash IS NULL AND claim_token IS NULL AND completed_at IS NOT NULL
      AND (
        (attempts = 0 AND claimed_at IS NULL AND heartbeat_at IS NULL AND started_at IS NULL)
        OR (attempts BETWEEN 1 AND 3)
      )
    )
  ),
  CONSTRAINT world_compilation_runs_timestamps_ordered CHECK (
    next_attempt_at >= queued_at AND updated_at >= queued_at
    AND (claimed_at IS NULL OR claimed_at >= queued_at)
    AND (heartbeat_at IS NULL OR claimed_at IS NULL OR heartbeat_at >= claimed_at)
    AND (started_at IS NULL OR started_at >= queued_at)
    AND (completed_at IS NULL OR completed_at >= queued_at)
    AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    AND (heartbeat_at IS NULL OR updated_at >= heartbeat_at)
    AND (completed_at IS NULL OR updated_at >= completed_at)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX world_compilation_runs_one_active_world_idx
  ON world_compilation_runs (world_id)
  WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE UNIQUE INDEX world_compilation_runs_claim_token_unique_idx
  ON world_compilation_runs (claim_token)
  WHERE claim_token IS NOT NULL;
--> statement-breakpoint
CREATE INDEX world_compilation_runs_queue_idx
  ON world_compilation_runs (next_attempt_at, queued_at, id)
  WHERE status = 'queued';
--> statement-breakpoint
CREATE INDEX world_compilation_runs_running_lease_idx
  ON world_compilation_runs (heartbeat_at, claimed_at, id)
  WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX world_compilation_runs_world_cursor_idx
  ON world_compilation_runs (world_id, queued_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE compiled_world_artifacts (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  compilation_run_id uuid NOT NULL,
  artifact_kind text NOT NULL,
  artifact_schema_version integer NOT NULL,
  canonical_content jsonb NOT NULL,
  content_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compiled_world_artifacts_run_kind_unique UNIQUE (
    compilation_run_id, artifact_kind
  ),
  CONSTRAINT compiled_world_artifacts_run_world_fk
    FOREIGN KEY (compilation_run_id, world_id)
    REFERENCES world_compilation_runs(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT compiled_world_artifacts_kind_known CHECK (
    artifact_kind IN ('compiler_input', 'compiled_world', 'visual_plan')
  ),
  CONSTRAINT compiled_world_artifacts_schema_known CHECK (artifact_schema_version = 1),
  CONSTRAINT compiled_world_artifacts_content_bounded CHECK (
    jsonb_typeof(canonical_content) = 'object'
    AND pg_column_size(canonical_content) <= CASE artifact_kind
      WHEN 'compiler_input' THEN 67108864
      WHEN 'compiled_world' THEN 8388608
      WHEN 'visual_plan' THEN 1048576
      ELSE 0
    END
    AND NOT worldgraph_jsonb_has_sensitive_key(canonical_content)
    AND NOT worldgraph_jsonb_has_compiler_private_key(canonical_content)
  ),
  CONSTRAINT compiled_world_artifacts_hash_length CHECK (octet_length(content_hash) = 32)
);
--> statement-breakpoint
CREATE INDEX compiled_world_artifacts_world_idx
  ON compiled_world_artifacts (world_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE world_versions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  version_number bigint NOT NULL,
  parent_world_version_id uuid,
  manifest_revision_id uuid NOT NULL,
  compilation_run_id uuid NOT NULL,
  world_schema_version integer NOT NULL,
  compiler_version text NOT NULL,
  compiler_config_version integer NOT NULL,
  seed text NOT NULL,
  artifact_hash bytea NOT NULL,
  status world_version_status NOT NULL DEFAULT 'staging',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CONSTRAINT world_versions_world_identity UNIQUE (id, world_id),
  CONSTRAINT world_versions_world_number_unique UNIQUE (world_id, version_number),
  CONSTRAINT world_versions_compilation_run_unique UNIQUE (compilation_run_id),
  CONSTRAINT world_versions_parent_world_fk
    FOREIGN KEY (parent_world_version_id, world_id)
    REFERENCES world_versions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_versions_manifest_world_fk
    FOREIGN KEY (manifest_revision_id, world_id)
    REFERENCES manifest_revisions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_versions_creator_membership_fk
    FOREIGN KEY (world_id, created_by_user_id)
    REFERENCES world_memberships(world_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_versions_run_exact_fk
    FOREIGN KEY (
      compilation_run_id, world_id, manifest_revision_id,
      compiler_version, compiler_config_version, seed, artifact_hash
    )
    REFERENCES world_compilation_runs(
      id, world_id, manifest_revision_id,
      compiler_version, compiler_config_version, seed, artifact_hash
    )
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT world_versions_number_parent_consistent CHECK (
    version_number BETWEEN 1 AND 2147483647
    AND ((version_number = 1 AND parent_world_version_id IS NULL)
      OR (version_number > 1 AND parent_world_version_id IS NOT NULL))
  ),
  CONSTRAINT world_versions_schema_known CHECK (world_schema_version = 1),
  CONSTRAINT world_versions_compiler_known CHECK (
    compiler_version = '1.0.0' AND compiler_config_version = 1
  ),
  CONSTRAINT world_versions_seed_bounded CHECK (
    char_length(seed) BETWEEN 1 AND 128
    AND seed = btrim(seed)
    AND seed !~ '[[:cntrl:]]'
  ),
  CONSTRAINT world_versions_artifact_hash_length CHECK (octet_length(artifact_hash) = 32),
  CONSTRAINT world_versions_status_consistent CHECK (
    (status = 'staging' AND activated_at IS NULL)
    OR (status IN ('active', 'superseded') AND activated_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX world_versions_one_active_world_idx
  ON world_versions (world_id)
  WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX world_versions_world_cursor_idx
  ON world_versions (world_id, version_number DESC, id DESC);
--> statement-breakpoint
ALTER TABLE worlds
  ADD CONSTRAINT worlds_active_world_version_world_fk
  FOREIGN KEY (active_world_version_id, id)
  REFERENCES world_versions(id, world_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE world_entities (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  logical_key extensions.citext NOT NULL,
  entity_type text NOT NULL,
  entity_schema_version integer NOT NULL,
  state jsonb NOT NULL,
  created_world_version_id uuid NOT NULL,
  retired_world_version_id uuid,
  row_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_entities_world_logical_key_unique UNIQUE (world_id, logical_key),
  CONSTRAINT world_entities_world_identity UNIQUE (world_id, id),
  CONSTRAINT world_entities_created_version_world_fk
    FOREIGN KEY (created_world_version_id, world_id)
    REFERENCES world_versions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_entities_retired_version_world_fk
    FOREIGN KEY (retired_world_version_id, world_id)
    REFERENCES world_versions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_entities_logical_key_shape CHECK (
    char_length(logical_key::text) BETWEEN 3 AND 240
    AND logical_key::text = lower(logical_key::text)
    AND logical_key::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
  ),
  CONSTRAINT world_entities_type_shape CHECK (
    char_length(entity_type) BETWEEN 1 AND 80
    AND entity_type ~ '^[a-z][a-z0-9_]*$'
  ),
  CONSTRAINT world_entities_type_known CHECK (
    entity_type IN (
      'district', 'institution', 'organization', 'actor_blueprint',
      'account_principal', 'player_character', 'primitive_instance',
      'currency_definition_intent', 'resource_definition_intent',
      'production_definition_intent', 'tax_definition_intent',
      'economy_configuration', 'simulation_configuration', 'visual_plan'
    )
  ),
  CONSTRAINT world_entities_schema_known CHECK (entity_schema_version = 1),
  CONSTRAINT world_entities_state_bounded CHECK (
    jsonb_typeof(state) = 'object'
    AND pg_column_size(state) <= 262144
    AND NOT worldgraph_jsonb_has_sensitive_key(state)
    AND NOT worldgraph_jsonb_has_compiler_private_key(state)
  ),
  CONSTRAINT world_entities_state_matches_type CHECK (
    worldgraph_world_entity_state_is_valid(entity_type, entity_schema_version, state)
  ),
  CONSTRAINT world_entities_versions_distinct CHECK (
    retired_world_version_id IS NULL OR retired_world_version_id <> created_world_version_id
  ),
  CONSTRAINT world_entities_row_version_nonnegative CHECK (row_version >= 0),
  CONSTRAINT world_entities_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE INDEX world_entities_world_type_key_idx
  ON world_entities (world_id, entity_type, logical_key);
--> statement-breakpoint
CREATE INDEX world_entities_world_active_key_idx
  ON world_entities (world_id, logical_key)
  WHERE retired_world_version_id IS NULL;
--> statement-breakpoint
CREATE INDEX world_entities_world_display_name_idx
  ON world_entities (world_id, ((state ->> 'displayName')) COLLATE "C", logical_key)
  WHERE retired_world_version_id IS NULL AND state ? 'displayName';
--> statement-breakpoint
CREATE TABLE world_relationships (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  logical_key extensions.citext NOT NULL,
  relationship_type text NOT NULL,
  source_entity_id uuid NOT NULL,
  target_entity_id uuid NOT NULL,
  relationship_schema_version integer NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_world_version_id uuid NOT NULL,
  retired_world_version_id uuid,
  row_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_relationships_world_logical_key_unique UNIQUE (world_id, logical_key),
  CONSTRAINT world_relationships_world_identity UNIQUE (world_id, id),
  CONSTRAINT world_relationships_source_world_fk
    FOREIGN KEY (world_id, source_entity_id)
    REFERENCES world_entities(world_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT world_relationships_target_world_fk
    FOREIGN KEY (world_id, target_entity_id)
    REFERENCES world_entities(world_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT world_relationships_created_version_world_fk
    FOREIGN KEY (created_world_version_id, world_id)
    REFERENCES world_versions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_relationships_retired_version_world_fk
    FOREIGN KEY (retired_world_version_id, world_id)
    REFERENCES world_versions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_relationships_logical_key_shape CHECK (
    char_length(logical_key::text) BETWEEN 5 AND 240
    AND logical_key::text = lower(logical_key::text)
    AND logical_key::text ~ '^rel:[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*$'
  ),
  CONSTRAINT world_relationships_type_shape CHECK (
    char_length(relationship_type) BETWEEN 1 AND 80
    AND relationship_type ~ '^[a-z][a-z0-9_]*$'
  ),
  CONSTRAINT world_relationships_type_known CHECK (
    relationship_type IN (
      'account_controls', 'connected_to', 'cooperates_with', 'governs',
      'instantiates', 'located_in', 'member_of', 'participates_in',
      'rivals', 'supplies', 'uses_primitive'
    )
  ),
  CONSTRAINT world_relationships_schema_known CHECK (relationship_schema_version = 1),
  CONSTRAINT world_relationships_attributes_bounded CHECK (
    jsonb_typeof(attributes) = 'object'
    AND pg_column_size(attributes) <= 65536
    AND NOT worldgraph_jsonb_has_sensitive_key(attributes)
    AND NOT worldgraph_jsonb_has_compiler_private_key(attributes)
  ),
  CONSTRAINT world_relationships_attributes_match_type CHECK (
    worldgraph_world_relationship_attributes_are_valid(
      relationship_type, relationship_schema_version, attributes
    )
  ),
  CONSTRAINT world_relationships_versions_distinct CHECK (
    retired_world_version_id IS NULL OR retired_world_version_id <> created_world_version_id
  ),
  CONSTRAINT world_relationships_row_version_nonnegative CHECK (row_version >= 0),
  CONSTRAINT world_relationships_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE INDEX world_relationships_source_type_idx
  ON world_relationships (world_id, source_entity_id, relationship_type, logical_key);
--> statement-breakpoint
CREATE INDEX world_relationships_target_type_idx
  ON world_relationships (world_id, target_entity_id, relationship_type, logical_key);
--> statement-breakpoint
CREATE INDEX world_relationships_active_type_idx
  ON world_relationships (world_id, relationship_type, logical_key)
  WHERE retired_world_version_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX world_relationships_active_account_control_target_idx
  ON world_relationships (world_id, target_entity_id)
  WHERE relationship_type = 'account_controls' AND retired_world_version_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX world_relationships_active_account_control_pair_idx
  ON world_relationships (world_id, source_entity_id, target_entity_id)
  WHERE relationship_type = 'account_controls' AND retired_world_version_id IS NULL;
--> statement-breakpoint
CREATE TABLE world_entity_controllers (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entity_id uuid NOT NULL,
  control_scope text NOT NULL,
  granted_world_version_id uuid NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (world_id, user_id, entity_id, control_scope),
  CONSTRAINT world_entity_controllers_membership_fk
    FOREIGN KEY (world_id, user_id)
    REFERENCES world_memberships(world_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_entity_controllers_entity_world_fk
    FOREIGN KEY (world_id, entity_id)
    REFERENCES world_entities(world_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT world_entity_controllers_version_world_fk
    FOREIGN KEY (granted_world_version_id, world_id)
    REFERENCES world_versions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT world_entity_controllers_scope_known CHECK (control_scope = 'primary')
);
--> statement-breakpoint
CREATE UNIQUE INDEX world_entity_controllers_one_active_entity_idx
  ON world_entity_controllers (world_id, entity_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX world_entity_controllers_user_active_idx
  ON world_entity_controllers (world_id, user_id, entity_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE world_runtime_heads (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  active_world_version_id uuid NOT NULL,
  state_revision bigint NOT NULL DEFAULT 0,
  last_ledger_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_runtime_heads_active_version_world_fk
    FOREIGN KEY (active_world_version_id, world_id)
    REFERENCES world_versions(id, world_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT world_runtime_heads_revisions_nonnegative CHECK (
    state_revision >= 0 AND last_ledger_sequence >= 0
  )
);
--> statement-breakpoint
UPDATE worlds
SET lifecycle = 'manifest_approved',
    row_version = row_version + 1,
    updated_at = greatest(updated_at, now())
WHERE lifecycle = 'draft' AND current_approved_manifest_revision_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION worldgraph_lock_world_compilation(locked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(locked_world_id::text, 578636432019::bigint));
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_lock_world_compilation(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_compilation_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  old_stage_order integer;
  new_stage_order integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world compilation runs are durable'
      USING ERRCODE = '55000';
  END IF;
  PERFORM public.worldgraph_lock_world_compilation(NEW.world_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued'::world_compilation_status
      OR NEW.stage <> 'queued'::world_compilation_stage
      OR NEW.progress_percent <> 0 OR NEW.attempts <> 0
      OR NEW.diagnostics <> '[]'::jsonb OR NEW.row_version <> 1
      OR NEW.claim_token IS NOT NULL OR NEW.claimed_at IS NOT NULL
      OR NEW.heartbeat_at IS NOT NULL OR NEW.started_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL OR NEW.artifact_hash IS NOT NULL THEN
      RAISE EXCEPTION 'world compilation runs must be inserted as pristine queued work'
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.worlds world
      JOIN public.manifest_revisions revision
        ON revision.id = world.current_approved_manifest_revision_id
       AND revision.world_id = world.id
      JOIN public.world_memberships membership
        ON membership.world_id = world.id AND membership.user_id = NEW.requested_by_user_id
      WHERE world.id = NEW.world_id AND world.archived_at IS NULL
        AND world.active_world_version_id IS NULL
        AND world.lifecycle IN (
          'manifest_approved'::world_lifecycle,
          'compiling'::world_lifecycle,
          'compile_failed'::world_lifecycle
        )
        AND revision.id = NEW.manifest_revision_id
        AND revision.content_hash = NEW.manifest_content_hash
        AND revision.approval_status = 'approved'::manifest_approval_status
        AND membership.status = 'active'::membership_status
        AND membership.role = 'creator'::world_role
    ) THEN
      RAISE EXCEPTION 'compilation requires the current approved manifest and active creator'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.manifest_revision_id IS DISTINCT FROM OLD.manifest_revision_id
    OR NEW.manifest_content_hash IS DISTINCT FROM OLD.manifest_content_hash
    OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.compiler_version IS DISTINCT FROM OLD.compiler_version
    OR NEW.compiler_config_version IS DISTINCT FROM OLD.compiler_config_version
    OR NEW.seed IS DISTINCT FROM OLD.seed
    OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.queued_at IS DISTINCT FROM OLD.queued_at THEN
    RAISE EXCEPTION 'world compilation input identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'world compilation updates must advance row version and timestamp'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'queued'::world_compilation_status
    AND NEW.status = 'running'::world_compilation_status THEN
    IF NEW.stage <> 'validating'::world_compilation_stage
      OR NEW.attempts <> (CASE WHEN OLD.attempts = 0 THEN 1 ELSE OLD.attempts END)
      OR NEW.claim_token IS NULL OR NEW.claimed_at IS NULL
      OR NEW.heartbeat_at IS NULL OR NEW.started_at IS NULL
      OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'queued compilation claim is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'queued'::world_compilation_status
    AND NEW.status = 'cancelled'::world_compilation_status THEN
    IF NEW.stage <> 'cancelled'::world_compilation_stage
      OR NEW.attempts <> OLD.attempts OR NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'queued compilation cancellation is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'running'::world_compilation_status
    AND NEW.status = 'running'::world_compilation_status THEN
    old_stage_order := CASE OLD.stage WHEN 'validating' THEN 1 WHEN 'compiling' THEN 2 WHEN 'seeding' THEN 3 ELSE 0 END;
    new_stage_order := CASE NEW.stage WHEN 'validating' THEN 1 WHEN 'compiling' THEN 2 WHEN 'seeding' THEN 3 ELSE 0 END;
    IF NEW.attempts <> OLD.attempts
      OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
      OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.heartbeat_at < OLD.heartbeat_at
      OR new_stage_order < old_stage_order
      OR NEW.progress_percent < OLD.progress_percent THEN
      RAISE EXCEPTION 'running compilation cannot regress or change its claim'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'running'::world_compilation_status
    AND NEW.status = 'succeeded'::world_compilation_status THEN
    IF OLD.stage <> 'seeding'::world_compilation_stage
      OR NEW.stage <> 'activated'::world_compilation_stage
      OR NEW.attempts <> OLD.attempts OR NEW.completed_at IS NULL
      OR NEW.artifact_hash IS NULL OR NEW.claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'compilation success requires completed seeding'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'running'::world_compilation_status
    AND NEW.status = 'failed'::world_compilation_status THEN
    IF NEW.stage <> 'failed'::world_compilation_stage
      OR NEW.attempts <> OLD.attempts OR NEW.completed_at IS NULL
      OR NEW.artifact_hash IS NOT NULL OR NEW.claim_token IS NOT NULL
      OR jsonb_array_length(NEW.diagnostics) = 0 THEN
      RAISE EXCEPTION 'compilation failure requires terminal diagnostics'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'running'::world_compilation_status
    AND NEW.status = 'cancelled'::world_compilation_status THEN
    IF OLD.stage NOT IN ('validating'::world_compilation_stage, 'compiling'::world_compilation_stage)
      OR NEW.stage <> 'cancelled'::world_compilation_stage
      OR NEW.attempts <> OLD.attempts OR NEW.completed_at IS NULL
      OR NEW.artifact_hash IS NOT NULL OR NEW.claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'compilation cannot be cancelled after seeding begins'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'failed'::world_compilation_status
    AND NEW.status = 'queued'::world_compilation_status THEN
    IF OLD.attempts >= 3 OR NEW.attempts <> OLD.attempts + 1
      OR NEW.stage <> 'queued'::world_compilation_stage
      OR NEW.progress_percent <> 0 OR NEW.diagnostics <> '[]'::jsonb
      OR NEW.artifact_hash IS NOT NULL OR NEW.claim_token IS NOT NULL
      OR NEW.claimed_at IS NOT NULL OR NEW.heartbeat_at IS NOT NULL
      OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'failed compilation retry reset is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'world compilation status transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_compilation_runs_protect
  BEFORE INSERT OR UPDATE OR DELETE ON world_compilation_runs
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_compilation_run();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_compiled_artifact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_record record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'compiled artifacts are immutable' USING ERRCODE = '55000';
  END IF;
  SELECT world_id, status, stage INTO run_record
  FROM public.world_compilation_runs
  WHERE id = COALESCE(NEW.compilation_run_id, OLD.compilation_run_id)
  FOR UPDATE;
  IF TG_OP = 'DELETE' THEN
    IF run_record.status = 'succeeded'::world_compilation_status THEN
      RAISE EXCEPTION 'successful compiled artifacts cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM public.worldgraph_lock_world_compilation(NEW.world_id);
  IF run_record.world_id IS DISTINCT FROM NEW.world_id
    OR run_record.status <> 'running'::world_compilation_status
    OR run_record.stage NOT IN ('compiling'::world_compilation_stage, 'seeding'::world_compilation_stage) THEN
    RAISE EXCEPTION 'artifacts may only be inserted by the matching active compilation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER compiled_world_artifacts_protect
  BEFORE INSERT OR UPDATE OR DELETE ON compiled_world_artifacts
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_compiled_artifact();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_world_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_record record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world versions are immutable' USING ERRCODE = '55000';
  END IF;
  PERFORM public.worldgraph_lock_world_compilation(NEW.world_id);
  IF TG_OP = 'INSERT' THEN
    SELECT world_id, status, stage INTO run_record
    FROM public.world_compilation_runs WHERE id = NEW.compilation_run_id FOR UPDATE;
    IF NEW.status <> 'staging'::world_version_status OR NEW.activated_at IS NOT NULL
      OR run_record.world_id IS DISTINCT FROM NEW.world_id
      OR run_record.status <> 'running'::world_compilation_status
      OR run_record.stage <> 'seeding'::world_compilation_stage
      OR EXISTS (
        SELECT 1 FROM public.worlds
        WHERE id = NEW.world_id AND active_world_version_id IS NOT NULL
      ) THEN
      RAISE EXCEPTION 'world version must be staged by the matching seeding compilation'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.version_number IS DISTINCT FROM OLD.version_number
    OR NEW.parent_world_version_id IS DISTINCT FROM OLD.parent_world_version_id
    OR NEW.manifest_revision_id IS DISTINCT FROM OLD.manifest_revision_id
    OR NEW.compilation_run_id IS DISTINCT FROM OLD.compilation_run_id
    OR NEW.world_schema_version IS DISTINCT FROM OLD.world_schema_version
    OR NEW.compiler_version IS DISTINCT FROM OLD.compiler_version
    OR NEW.compiler_config_version IS DISTINCT FROM OLD.compiler_config_version
    OR NEW.seed IS DISTINCT FROM OLD.seed OR NEW.artifact_hash IS DISTINCT FROM OLD.artifact_hash
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'world version provenance is immutable' USING ERRCODE = '55000';
  END IF;
  SELECT status, stage INTO run_record
  FROM public.world_compilation_runs WHERE id = NEW.compilation_run_id FOR UPDATE;
  IF OLD.status = 'staging'::world_version_status
    AND NEW.status = 'active'::world_version_status
    AND NEW.activated_at IS NOT NULL
    AND run_record.status = 'running'::world_compilation_status
    AND run_record.stage = 'seeding'::world_compilation_stage THEN
    RETURN NEW;
  ELSIF OLD.status = 'active'::world_version_status
    AND NEW.status = 'superseded'::world_version_status
    AND NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'world version status transition is invalid' USING ERRCODE = '55000';
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_versions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON world_versions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_world_version();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_compiler_seed_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_version_id uuid;
  checked_world_id uuid;
  membership_record record;
  source_entity_type text;
  target_entity_type text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is immutable until the command ledger owns mutation', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  checked_world_id := NEW.world_id;
  IF TG_TABLE_NAME IN ('world_entities', 'world_relationships') THEN
    checked_version_id := NEW.created_world_version_id;
    IF NEW.retired_world_version_id IS NOT NULL OR NEW.row_version <> 0 THEN
      RAISE EXCEPTION 'compiler seed rows must begin active at row version zero'
      USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'world_relationships' THEN
      SELECT entity_type INTO source_entity_type
      FROM public.world_entities
      WHERE world_id = NEW.world_id AND id = NEW.source_entity_id;
      SELECT entity_type INTO target_entity_type
      FROM public.world_entities
      WHERE world_id = NEW.world_id AND id = NEW.target_entity_id;
      IF source_entity_type IS NOT NULL AND target_entity_type IS NOT NULL AND NOT (
        (NEW.relationship_type = 'account_controls'
          AND source_entity_type = 'account_principal'
          AND target_entity_type = 'player_character')
        OR (NEW.relationship_type = 'connected_to'
          AND source_entity_type = 'district' AND target_entity_type = 'district')
        OR (NEW.relationship_type = 'cooperates_with'
          AND source_entity_type = 'organization' AND target_entity_type = 'organization')
        OR (NEW.relationship_type = 'governs'
          AND source_entity_type = 'institution'
          AND target_entity_type IN ('district', 'organization'))
        OR (NEW.relationship_type = 'instantiates'
          AND source_entity_type = 'player_character'
          AND target_entity_type = 'actor_blueprint')
        OR (NEW.relationship_type = 'located_in'
          AND source_entity_type IN (
            'actor_blueprint', 'institution', 'organization', 'player_character'
          )
          AND target_entity_type = 'district')
        OR (NEW.relationship_type = 'member_of'
          AND source_entity_type IN ('actor_blueprint', 'player_character')
          AND target_entity_type = 'organization')
        OR (NEW.relationship_type = 'participates_in'
          AND source_entity_type = 'organization' AND target_entity_type = 'institution')
        OR (NEW.relationship_type = 'rivals'
          AND source_entity_type = 'organization' AND target_entity_type = 'organization')
        OR (NEW.relationship_type = 'supplies'
          AND source_entity_type = 'organization'
          AND target_entity_type IN ('district', 'institution', 'organization'))
        OR (NEW.relationship_type = 'uses_primitive'
          AND target_entity_type = 'primitive_instance')
      ) THEN
        RAISE EXCEPTION 'relationship endpoints do not match relationship type %',
          NEW.relationship_type
          USING ERRCODE = '23514',
                CONSTRAINT = 'world_relationships_endpoint_types_valid';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'world_entity_controllers' THEN
    checked_version_id := NEW.granted_world_version_id;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'compiler controller bindings must begin active'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    checked_version_id := NEW.active_world_version_id;
    IF NEW.state_revision <> 0 OR NEW.last_ledger_sequence <> 0 THEN
      RAISE EXCEPTION 'compiler runtime heads must begin at revision zero'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  PERFORM public.worldgraph_lock_world_compilation(checked_world_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.world_versions version
    JOIN public.world_compilation_runs run ON run.id = version.compilation_run_id
    WHERE version.id = checked_version_id AND version.world_id = checked_world_id
      AND version.status = 'staging'::world_version_status
      AND run.status = 'running'::world_compilation_status
      AND run.stage = 'seeding'::world_compilation_stage
  ) THEN
    RAISE EXCEPTION '% may only be inserted by the matching seeding compilation', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'world_entity_controllers' THEN
    SELECT status, role INTO membership_record
    FROM public.world_memberships
    WHERE world_id = NEW.world_id AND user_id = NEW.user_id;
    IF membership_record.status IS DISTINCT FROM 'active'::membership_status
      OR membership_record.role NOT IN (
        'creator'::world_role, 'administrator'::world_role, 'player'::world_role
      ) THEN
      RAISE EXCEPTION 'controller bindings require an active playable membership'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_entities_compiler_seed_only
  BEFORE INSERT OR UPDATE OR DELETE ON world_entities
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_compiler_seed_row();
--> statement-breakpoint
CREATE TRIGGER world_relationships_compiler_seed_only
  BEFORE INSERT OR UPDATE OR DELETE ON world_relationships
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_compiler_seed_row();
--> statement-breakpoint
CREATE TRIGGER world_entity_controllers_compiler_seed_only
  BEFORE INSERT OR UPDATE OR DELETE ON world_entity_controllers
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_compiler_seed_row();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_runtime_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.worldgraph_lock_world_compilation(NEW.world_id);
    IF NOT EXISTS (
      SELECT 1 FROM public.world_versions version
      JOIN public.world_compilation_runs run ON run.id = version.compilation_run_id
      WHERE version.id = NEW.active_world_version_id AND version.world_id = NEW.world_id
        AND version.status = 'staging'::world_version_status
        AND run.status = 'running'::world_compilation_status
        AND run.stage = 'seeding'::world_compilation_stage
    ) THEN
      RAISE EXCEPTION 'world runtime head may only be inserted by the matching seeding compilation'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world runtime heads cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.active_world_version_id IS DISTINCT FROM OLD.active_world_version_id
    OR NEW.state_revision < OLD.state_revision
    OR NEW.last_ledger_sequence < OLD.last_ledger_sequence
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'world runtime head update is inconsistent' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_runtime_heads_protect
  BEFORE INSERT OR UPDATE OR DELETE ON world_runtime_heads
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_runtime_head();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_world_compiler_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.lifecycle IS NOT DISTINCT FROM OLD.lifecycle
    AND NEW.active_world_version_id IS NOT DISTINCT FROM OLD.active_world_version_id THEN
    RETURN NEW;
  END IF;
  PERFORM public.worldgraph_lock_world_compilation(NEW.id);
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'world compiler state update must advance row version and timestamp'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.active_world_version_id IS DISTINCT FROM OLD.active_world_version_id THEN
    IF OLD.active_world_version_id IS NOT NULL OR NEW.active_world_version_id IS NULL
      OR NEW.lifecycle <> 'active'::world_lifecycle THEN
      RAISE EXCEPTION 'active world version pointer is set once during activation'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle AND NOT (
    (OLD.lifecycle = 'draft'::world_lifecycle
      AND NEW.lifecycle = 'manifest_approved'::world_lifecycle)
    OR (OLD.lifecycle = 'manifest_approved'::world_lifecycle
      AND NEW.lifecycle = 'compiling'::world_lifecycle)
    OR (OLD.lifecycle = 'compiling'::world_lifecycle
      AND NEW.lifecycle IN (
        'active'::world_lifecycle, 'compile_failed'::world_lifecycle,
        'manifest_approved'::world_lifecycle
      ))
    OR (OLD.lifecycle = 'compile_failed'::world_lifecycle
      AND NEW.lifecycle IN ('compiling'::world_lifecycle, 'manifest_approved'::world_lifecycle))
  ) THEN
    RAISE EXCEPTION 'world compiler lifecycle transition is invalid' USING ERRCODE = '55000';
  END IF;
  IF NEW.lifecycle IN (
      'manifest_approved'::world_lifecycle, 'compiling'::world_lifecycle,
      'compile_failed'::world_lifecycle, 'active'::world_lifecycle
    ) AND NEW.current_approved_manifest_revision_id IS NULL THEN
    RAISE EXCEPTION 'compiler lifecycle requires an approved manifest pointer'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.lifecycle = 'active'::world_lifecycle AND NEW.active_world_version_id IS NULL THEN
    RAISE EXCEPTION 'active lifecycle requires an active world version'
      USING ERRCODE = '55000';
  ELSIF NEW.lifecycle <> 'active'::world_lifecycle AND NEW.active_world_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'only active lifecycle may hold an active world version'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER worlds_protect_compiler_state
  BEFORE UPDATE OF lifecycle, active_world_version_id ON worlds
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_world_compiler_state();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_compilation_run_consistency(checked_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_record record;
  version_id uuid;
  version_count integer;
  compiled_artifact_count integer;
  seed_entity_count integer;
  controller_count integer;
BEGIN
  SELECT * INTO run_record FROM public.world_compilation_runs
  WHERE id = checked_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count(*)::integer,
         min(id::text)::uuid
  INTO version_count, version_id
  FROM public.world_versions
  WHERE compilation_run_id = checked_run_id;
  SELECT count(*)::integer INTO compiled_artifact_count
  FROM public.compiled_world_artifacts
  WHERE compilation_run_id = checked_run_id
    AND artifact_kind = 'compiled_world'
    AND content_hash = run_record.artifact_hash;
  IF run_record.status = 'succeeded'::world_compilation_status THEN
    PERFORM public.worldgraph_assert_controller_edges(run_record.world_id);
    IF version_count <> 1 OR compiled_artifact_count <> 1
      OR NOT EXISTS (
        SELECT 1 FROM public.world_versions version
        JOIN public.worlds world ON world.id = version.world_id
        JOIN public.world_runtime_heads head ON head.world_id = version.world_id
        WHERE version.id = version_id AND version.status = 'active'::world_version_status
          AND world.active_world_version_id = version.id
          AND world.lifecycle = 'active'::world_lifecycle
          AND head.active_world_version_id = version.id
      ) THEN
      RAISE EXCEPTION 'successful compilation requires one matching artifact and active graph'
        USING ERRCODE = '23514',
              CONSTRAINT = 'world_compilation_runs_terminal_graph_consistent';
    END IF;
    SELECT count(*)::integer INTO seed_entity_count
    FROM public.world_entities WHERE world_id = run_record.world_id
      AND created_world_version_id = version_id;
    SELECT count(*)::integer INTO controller_count
    FROM public.world_entity_controllers WHERE world_id = run_record.world_id
      AND granted_world_version_id = version_id AND revoked_at IS NULL;
    IF seed_entity_count = 0 OR controller_count = 0 THEN
      RAISE EXCEPTION 'active compiled graph requires seeded entities and a controller binding'
        USING ERRCODE = '23514',
              CONSTRAINT = 'world_compilation_runs_terminal_graph_consistent';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.world_memberships membership
      WHERE membership.world_id = run_record.world_id
        AND membership.status = 'active'::membership_status
        AND membership.role IN (
          'creator'::world_role, 'administrator'::world_role, 'player'::world_role
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.world_entity_controllers controller
          JOIN public.world_entities target
            ON target.world_id = controller.world_id AND target.id = controller.entity_id
          JOIN public.world_relationships relationship
            ON relationship.world_id = controller.world_id
           AND relationship.target_entity_id = controller.entity_id
           AND relationship.relationship_type = 'account_controls'
           AND relationship.retired_world_version_id IS NULL
           AND relationship.created_world_version_id = controller.granted_world_version_id
          JOIN public.world_entities source
            ON source.world_id = relationship.world_id
           AND source.id = relationship.source_entity_id
          WHERE controller.world_id = membership.world_id
            AND controller.user_id = membership.user_id
            AND controller.granted_world_version_id = version_id
            AND controller.revoked_at IS NULL
            AND source.entity_type = 'account_principal'
            AND source.created_world_version_id = version_id
            AND source.retired_world_version_id IS NULL
            AND target.entity_type = 'player_character'
            AND target.created_world_version_id = version_id
            AND target.retired_world_version_id IS NULL
            AND source.logical_key::text = 'account:' || (source.state ->> 'principalKey')
            AND target.logical_key::text = 'character:' || (source.state ->> 'principalKey')
            AND (source.state ->> 'membershipRole') = membership.role::text
            AND (target.state ->> 'membershipRole') = membership.role::text
            AND (source.state ->> 'principalKey') = 'member-' || left(encode(
              extensions.digest(
                convert_to('worldgraph-member-principal-v1', 'UTF8')
                  || decode('00', 'hex')
                  || convert_to(lower(membership.world_id::text), 'UTF8')
                  || decode('00', 'hex')
                  || convert_to(lower(membership.user_id::text), 'UTF8'),
                'sha256'
              ),
              'hex'
            ), 32)
        )
    ) THEN
      RAISE EXCEPTION 'initial activation must cover every active playable membership'
        USING ERRCODE = '23514',
              CONSTRAINT = 'world_compilation_runs_terminal_graph_consistent';
    END IF;
  ELSIF version_count <> 0 OR EXISTS (
    SELECT 1 FROM public.compiled_world_artifacts WHERE compilation_run_id = checked_run_id
  ) THEN
    RAISE EXCEPTION 'non-successful compilation cannot retain artifact or graph state'
      USING ERRCODE = '23514',
            CONSTRAINT = 'world_compilation_runs_terminal_graph_consistent';
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_compilation_run_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_run_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'world_compilation_runs' THEN
    checked_run_id := COALESCE(NEW.id, OLD.id);
  ELSE
    checked_run_id := COALESCE(NEW.compilation_run_id, OLD.compilation_run_id);
  END IF;
  PERFORM public.worldgraph_assert_compilation_run_consistency(checked_run_id);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_compilation_runs_require_terminal_graph
  AFTER INSERT OR UPDATE OR DELETE ON world_compilation_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_compilation_run_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER compiled_world_artifacts_require_terminal_run
  AFTER INSERT OR UPDATE OR DELETE ON compiled_world_artifacts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_compilation_run_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_versions_require_terminal_run
  AFTER INSERT OR UPDATE OR DELETE ON world_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_compilation_run_consistency();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_active_world_graph(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  world_record record;
  active_count integer;
  head_version_id uuid;
BEGIN
  SELECT lifecycle, active_world_version_id, current_approved_manifest_revision_id
  INTO world_record FROM public.worlds
  WHERE id = checked_world_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count(*)::integer INTO active_count
  FROM public.world_versions
  WHERE world_id = checked_world_id AND status = 'active'::world_version_status;
  SELECT active_world_version_id INTO head_version_id
  FROM public.world_runtime_heads WHERE world_id = checked_world_id;
  IF world_record.active_world_version_id IS NULL THEN
    IF world_record.lifecycle = 'active'::world_lifecycle
      OR active_count <> 0 OR head_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'inactive world cannot retain active graph state'
        USING ERRCODE = '23514', CONSTRAINT = 'worlds_active_graph_consistent';
    END IF;
  ELSIF world_record.lifecycle <> 'active'::world_lifecycle
    OR world_record.current_approved_manifest_revision_id IS NULL
    OR active_count <> 1
    OR head_version_id IS DISTINCT FROM world_record.active_world_version_id
    OR NOT EXISTS (
      SELECT 1 FROM public.world_versions
      WHERE id = world_record.active_world_version_id
        AND world_id = checked_world_id AND status = 'active'::world_version_status
    ) THEN
    RAISE EXCEPTION 'active world pointer, version, lifecycle, and runtime head disagree'
      USING ERRCODE = '23514', CONSTRAINT = 'worlds_active_graph_consistent';
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_active_world_graph()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_world_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'worlds' THEN
    checked_world_id := COALESCE(NEW.id, OLD.id);
  ELSE
    checked_world_id := COALESCE(NEW.world_id, OLD.world_id);
  END IF;
  PERFORM public.worldgraph_assert_active_world_graph(checked_world_id);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER worlds_require_active_graph
  AFTER INSERT OR UPDATE ON worlds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_active_world_graph();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_versions_require_active_pointer
  AFTER INSERT OR UPDATE OR DELETE ON world_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_active_world_graph();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_runtime_heads_require_active_pointer
  AFTER INSERT OR UPDATE OR DELETE ON world_runtime_heads
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_active_world_graph();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_controller_edges(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.world_entity_controllers controller
    JOIN public.world_entities target
      ON target.world_id = controller.world_id AND target.id = controller.entity_id
    WHERE controller.world_id = checked_world_id AND controller.revoked_at IS NULL
      AND (
        target.entity_type <> 'player_character'
        OR target.logical_key::text !~ '^character:'
        OR NOT EXISTS (
          SELECT 1
          FROM public.world_relationships relationship
          JOIN public.world_entities source
            ON source.world_id = relationship.world_id
           AND source.id = relationship.source_entity_id
          WHERE relationship.world_id = controller.world_id
            AND relationship.target_entity_id = controller.entity_id
            AND relationship.relationship_type = 'account_controls'
            AND relationship.retired_world_version_id IS NULL
            AND relationship.created_world_version_id = controller.granted_world_version_id
            AND source.entity_type = 'account_principal'
            AND source.logical_key::text ~ '^account:'
            AND source.logical_key::text = 'account:' || (source.state ->> 'principalKey')
            AND target.logical_key::text = 'character:' || (source.state ->> 'principalKey')
            AND (target.state ->> 'membershipRole') = (source.state ->> 'membershipRole')
            AND (source.state ->> 'principalKey') = 'member-' || left(encode(
              extensions.digest(
                convert_to('worldgraph-member-principal-v1', 'UTF8')
                  || decode('00', 'hex')
                  || convert_to(lower(controller.world_id::text), 'UTF8')
                  || decode('00', 'hex')
                  || convert_to(lower(controller.user_id::text), 'UTF8'),
                'sha256'
              ),
              'hex'
            ), 32)
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.world_relationships relationship
    JOIN public.world_entities source
      ON source.world_id = relationship.world_id AND source.id = relationship.source_entity_id
    JOIN public.world_entities target
      ON target.world_id = relationship.world_id AND target.id = relationship.target_entity_id
    WHERE relationship.world_id = checked_world_id
      AND relationship.relationship_type = 'account_controls'
      AND relationship.retired_world_version_id IS NULL
      AND (
        source.entity_type <> 'account_principal' OR source.logical_key::text !~ '^account:'
        OR target.entity_type <> 'player_character' OR target.logical_key::text !~ '^character:'
        OR NOT EXISTS (
          SELECT 1 FROM public.world_entity_controllers controller
          WHERE controller.world_id = relationship.world_id
            AND controller.entity_id = relationship.target_entity_id
            AND controller.granted_world_version_id = relationship.created_world_version_id
            AND controller.revoked_at IS NULL
            AND source.logical_key::text = 'account:' || (source.state ->> 'principalKey')
            AND target.logical_key::text = 'character:' || (source.state ->> 'principalKey')
            AND (target.state ->> 'membershipRole') = (source.state ->> 'membershipRole')
            AND (source.state ->> 'principalKey') = 'member-' || left(encode(
              extensions.digest(
                convert_to('worldgraph-member-principal-v1', 'UTF8')
                  || decode('00', 'hex')
                  || convert_to(lower(controller.world_id::text), 'UTF8')
                  || decode('00', 'hex')
                  || convert_to(lower(controller.user_id::text), 'UTF8'),
                'sha256'
              ),
              'hex'
            ), 32)
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.world_entities entity
    WHERE entity.world_id = checked_world_id
      AND entity.retired_world_version_id IS NULL
      AND entity.entity_type IN ('account_principal', 'player_character')
      AND NOT EXISTS (
        SELECT 1
        FROM public.world_relationships relationship
        JOIN public.world_entities source
          ON source.world_id = relationship.world_id
         AND source.id = relationship.source_entity_id
        JOIN public.world_entities target
          ON target.world_id = relationship.world_id
         AND target.id = relationship.target_entity_id
        JOIN public.world_entity_controllers controller
          ON controller.world_id = relationship.world_id
         AND controller.entity_id = relationship.target_entity_id
         AND controller.granted_world_version_id = relationship.created_world_version_id
         AND controller.revoked_at IS NULL
        WHERE relationship.world_id = entity.world_id
          AND relationship.relationship_type = 'account_controls'
          AND relationship.retired_world_version_id IS NULL
          AND source.entity_type = 'account_principal'
          AND source.retired_world_version_id IS NULL
          AND target.entity_type = 'player_character'
          AND target.retired_world_version_id IS NULL
          AND source.created_world_version_id = relationship.created_world_version_id
          AND target.created_world_version_id = relationship.created_world_version_id
          AND source.logical_key::text = 'account:' || (source.state ->> 'principalKey')
          AND target.logical_key::text = 'character:' || (source.state ->> 'principalKey')
          AND (target.state ->> 'membershipRole') = (source.state ->> 'membershipRole')
          AND (source.state ->> 'principalKey') = 'member-' || left(encode(
            extensions.digest(
              convert_to('worldgraph-member-principal-v1', 'UTF8')
                || decode('00', 'hex')
                || convert_to(lower(controller.world_id::text), 'UTF8')
                || decode('00', 'hex')
                || convert_to(lower(controller.user_id::text), 'UTF8'),
              'sha256'
            ),
            'hex'
          ), 32)
          AND (
            (entity.entity_type = 'account_principal'
              AND relationship.source_entity_id = entity.id)
            OR (entity.entity_type = 'player_character'
              AND relationship.target_entity_id = entity.id)
          )
      )
  ) THEN
    RAISE EXCEPTION 'controller bindings and account_controls edges must correspond'
      USING ERRCODE = '23514', CONSTRAINT = 'world_entity_controllers_edge_consistent';
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_controller_edges()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.worldgraph_assert_controller_edges(COALESCE(NEW.world_id, OLD.world_id));
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_entity_controllers_require_edge
  AFTER INSERT OR UPDATE OR DELETE ON world_entity_controllers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_controller_edges();
--> statement-breakpoint
DO $metadata$
DECLARE
  changed integer;
BEGIN
  UPDATE platform_metadata
  SET value = value || jsonb_build_object(
        'compiler', '1.0.0',
        'compilerArtifactSchema', 1,
        'compilerConfigSchema', 1,
        'compilationQueueSchema', 1,
        'contracts', 5,
        'runtimeSchema', 5,
        'worldGraphSchema', 1
      ),
      value_schema_version = 5,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 4
    AND value ->> 'compiler' = '0.0.0'
    AND value ->> 'contracts' = '4'
    AND value ->> 'runtimeSchema' = '4'
    AND value ->> 'manifestSchema' = '1'
    AND value ->> 'primitiveSchema' = '1';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact M04 compatibility state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT USAGE ON TYPE world_lifecycle, world_compilation_status,
      world_compilation_stage, world_version_status TO worldgraph_app;
    GRANT SELECT ON world_compilation_runs, compiled_world_artifacts, world_versions,
      world_entities, world_relationships, world_entity_controllers, world_runtime_heads
      TO worldgraph_app;
    GRANT INSERT ON world_compilation_runs, compiled_world_artifacts, world_versions,
      world_entities, world_relationships, world_entity_controllers, world_runtime_heads
      TO worldgraph_app;
    GRANT UPDATE (
      status, stage, progress_percent, diagnostics, artifact_hash, attempts,
      next_attempt_at, claim_token, claimed_at, heartbeat_at, started_at,
      completed_at, updated_at, row_version
    ) ON world_compilation_runs TO worldgraph_app;
    GRANT UPDATE (status, activated_at) ON world_versions TO worldgraph_app;
    REVOKE UPDATE ON worlds FROM worldgraph_app;
    GRANT UPDATE (
      slug, name, lifecycle, row_version, updated_at, archived_at,
      current_approved_manifest_revision_id, manifest_schema_version,
      active_world_version_id
    ) ON worlds TO worldgraph_app;
    -- PostgreSQL requires LOCK TABLE to be the first statement in a
    -- SERIALIZABLE activation transaction. MAINTAIN grants that capability
    -- without broadening row mutation privileges.
    GRANT MAINTAIN ON world_memberships, primitive_versions TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION worldgraph_jsonb_has_compiler_private_key(jsonb),
      worldgraph_lock_world_compilation(uuid), worldgraph_protect_compilation_run(),
      worldgraph_protect_compiled_artifact(), worldgraph_protect_world_version(),
      worldgraph_protect_compiler_seed_row(), worldgraph_protect_runtime_head(),
      worldgraph_protect_world_compiler_state(),
      worldgraph_assert_compilation_run_consistency(uuid),
      worldgraph_enforce_compilation_run_consistency(),
      worldgraph_assert_active_world_graph(uuid), worldgraph_enforce_active_world_graph(),
      worldgraph_assert_controller_edges(uuid), worldgraph_enforce_controller_edges()
      TO worldgraph_app;
  END IF;
END
$grant$;
