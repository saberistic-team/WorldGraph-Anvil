SET CONSTRAINTS ALL DEFERRED;
--> statement-breakpoint
DO $role_check$
DECLARE role_record record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit
    INTO role_record
    FROM pg_catalog.pg_roles
   WHERE rolname = 'worldgraph_governance_tally';
  IF NOT FOUND OR NOT role_record.rolcanlogin OR role_record.rolsuper
    OR role_record.rolcreatedb OR role_record.rolcreaterole OR role_record.rolinherit THEN
    RAISE EXCEPTION
      'worldgraph_governance_tally must be a LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT role'
      USING ERRCODE = '42501';
  END IF;
END
$role_check$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_jsonb_has_sensitive_key(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
  item_key text;
  item_value jsonb;
BEGIN
  IF value IS NULL THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(value) = 'object' THEN
    FOR item_key,item_value IN
      SELECT entry.key,entry.val
      FROM pg_catalog.jsonb_each(value) AS entry(key,val)
    LOOP
      IF pg_catalog.lower(item_key) = ANY (
        ARRAY[
          'authorization',
          'apikey',
          'api_key',
          'authpepper',
          'auth_pepper',
          'cookie',
          'credential',
          'credentials',
          'csrf',
          'csrftoken',
          'csrf_token',
          'invitationlink',
          'invitationurl',
          'invitation_link',
          'invitation_url',
          'invitelink',
          'inviteurl',
          'invite_link',
          'invite_url',
          'password',
          'passwordhash',
          'password_hash',
          'rawtoken',
          'raw_token',
          'sessiontoken',
          'session_token',
          'secret',
          'token'
        ]
      ) OR public.worldgraph_jsonb_has_sensitive_key(item_value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF pg_catalog.jsonb_typeof(value) = 'array' THEN
    FOR item_value IN
      SELECT entry.element
      FROM pg_catalog.jsonb_array_elements(value) AS entry(element)
    LOOP
      IF public.worldgraph_jsonb_has_sensitive_key(item_value) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;

  RETURN false;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_jsonb_has_sensitive_key(jsonb)
  FROM PUBLIC,worldgraph_governance_tally;
--> statement-breakpoint
DO $sensitive_key_grant$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'worldgraph_app'
  ) THEN
    GRANT EXECUTE ON FUNCTION public.worldgraph_jsonb_has_sensitive_key(jsonb)
      TO worldgraph_app;
  END IF;
END
$sensitive_key_grant$;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_json_is_safe_v1(
  checked_value jsonb,
  maximum_bytes integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
RETURN jsonb_typeof(checked_value) = 'object'
  AND maximum_bytes BETWEEN 2 AND 1048576
  AND pg_column_size(checked_value) <= maximum_bytes
  AND NOT public.worldgraph_jsonb_has_sensitive_key(checked_value)
  AND NOT public.worldgraph_jsonb_has_compiler_private_key(checked_value);
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_json_is_safe_v1(jsonb,integer)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_key_is_valid_v1(checked_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
RETURN char_length(checked_key) BETWEEN 3 AND 240
  AND checked_key = lower(checked_key)
  AND checked_key ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$';
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_key_is_valid_v1(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_tick_text_is_valid_v1(checked_tick text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
RETURN checked_tick ~ '^(0|[1-9][0-9]{0,18})$'
  AND (
    char_length(checked_tick) < 19
    OR checked_tick COLLATE "C" <= '9223372036854775807' COLLATE "C"
  );
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_tick_text_is_valid_v1(text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_jsonb_key_count_v1(checked_value jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
RETURN (SELECT count(*)::integer FROM jsonb_object_keys(checked_value));
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_jsonb_key_count_v1(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_policy_node_matches_v1(
  checked_node jsonb,
  checked_actor_mode text,
  checked_membership_roles text[],
  checked_held_office_keys text[],
  checked_organization_keys text[],
  checked_action text,
  checked_resource_type text,
  checked_resource_key text,
  checked_tick bigint,
  checked_depth integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  child jsonb;
  kind text := checked_node ->> 'kind';
BEGIN
  IF checked_depth > 3 THEN RETURN false; END IF;
  CASE kind
    WHEN 'all' THEN
      FOR child IN SELECT value FROM jsonb_array_elements(checked_node -> 'operands') LOOP
        IF NOT public.worldgraph_governance_policy_node_matches_v1(
          child,checked_actor_mode,checked_membership_roles,checked_held_office_keys,
          checked_organization_keys,checked_action,checked_resource_type,
          checked_resource_key,checked_tick,
          checked_depth + 1
        ) THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    WHEN 'any' THEN
      FOR child IN SELECT value FROM jsonb_array_elements(checked_node -> 'operands') LOOP
        IF public.worldgraph_governance_policy_node_matches_v1(
          child,checked_actor_mode,checked_membership_roles,checked_held_office_keys,
          checked_organization_keys,checked_action,checked_resource_type,
          checked_resource_key,checked_tick,
          checked_depth + 1
        ) THEN RETURN true; END IF;
      END LOOP;
      RETURN false;
    WHEN 'not' THEN
      RETURN NOT public.worldgraph_governance_policy_node_matches_v1(
        checked_node -> 'operand',checked_actor_mode,checked_membership_roles,
        checked_held_office_keys,checked_organization_keys,checked_action,
        checked_resource_type,checked_resource_key,checked_tick,checked_depth + 1
      );
    WHEN 'actor_mode' THEN
      RETURN checked_actor_mode = checked_node ->> 'mode';
    WHEN 'membership_role' THEN
      RETURN checked_node ->> 'role' = ANY(checked_membership_roles);
    WHEN 'holds_office' THEN
      RETURN checked_node ->> 'officeKey' = ANY(checked_held_office_keys);
    WHEN 'member_of_organization' THEN
      RETURN checked_node ->> 'organizationKey' = ANY(checked_organization_keys);
    WHEN 'action' THEN
      RETURN checked_action = checked_node ->> 'action';
    WHEN 'resource' THEN
      RETURN checked_resource_type = checked_node ->> 'resourceType'
        AND (
          checked_node -> 'resourceKey' = 'null'::jsonb
          OR checked_resource_key = checked_node ->> 'resourceKey'
        );
    WHEN 'tick_at_or_after' THEN
      RETURN checked_tick >= (checked_node ->> 'tick')::bigint;
    WHEN 'tick_before' THEN
      RETURN checked_tick < (checked_node ->> 'tick')::bigint;
    WHEN 'tick_between' THEN
      RETURN checked_tick >= (checked_node ->> 'fromTick')::bigint
        AND checked_tick < (checked_node ->> 'untilTick')::bigint;
    ELSE RETURN false;
  END CASE;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_policy_node_matches_v1(
  jsonb,text,text[],text[],text[],text,text,text,bigint,integer
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_policy_v1_is_valid(
  checked_policy jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  node_count integer := 0;
  node_record record;
  node_kind text;
  value_text text;
BEGIN
  IF NOT public.worldgraph_governance_json_is_safe_v1(checked_policy,65536) THEN
    RETURN false;
  END IF;
  FOR node_record IN
    WITH RECURSIVE policy_nodes(node,depth) AS (
      SELECT checked_policy,0
      UNION ALL
      SELECT child_record.child,parent.depth + 1
      FROM policy_nodes parent
      CROSS JOIN LATERAL (
        SELECT child.value
        FROM jsonb_array_elements(
          CASE
            WHEN parent.node ->> 'kind' IN ('all','any')
              AND jsonb_typeof(parent.node -> 'operands') = 'array'
              THEN parent.node -> 'operands'
            ELSE '[]'::jsonb
          END
        ) child(value)
        UNION ALL
        SELECT parent.node -> 'operand'
        WHERE parent.node ->> 'kind' = 'not'
          AND jsonb_typeof(parent.node -> 'operand') = 'object'
      ) child_record(child)
      WHERE parent.depth <= 3
    )
    SELECT node,depth FROM policy_nodes
  LOOP
    node_count := node_count + 1;
    IF node_count > 64 OR node_record.depth > 3
      OR jsonb_typeof(node_record.node) <> 'object' THEN
      RETURN false;
    END IF;
    node_kind := node_record.node ->> 'kind';
    CASE node_kind
      WHEN 'all','any' THEN
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'operands') <> 'array'
          OR jsonb_array_length(node_record.node -> 'operands') NOT BETWEEN 1 AND 8 THEN
          RETURN false;
        END IF;
      WHEN 'not' THEN
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'operand') <> 'object' THEN
          RETURN false;
        END IF;
      WHEN 'actor_mode' THEN
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'mode') <> 'string'
          OR node_record.node ->> 'mode' NOT IN (
            'in_world','creator','administrator','system'
          ) THEN RETURN false; END IF;
      WHEN 'membership_role' THEN
        value_text := node_record.node ->> 'role';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'role') <> 'string'
          OR char_length(value_text) NOT BETWEEN 1 AND 100
          OR value_text !~ '^[a-z][a-z0-9._-]*$' THEN RETURN false; END IF;
      WHEN 'holds_office' THEN
        value_text := node_record.node ->> 'officeKey';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'officeKey') <> 'string'
          OR NOT public.worldgraph_governance_key_is_valid_v1(value_text) THEN
          RETURN false;
        END IF;
      WHEN 'member_of_organization' THEN
        value_text := node_record.node ->> 'organizationKey';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'organizationKey') <> 'string'
          OR NOT public.worldgraph_governance_key_is_valid_v1(value_text) THEN
          RETURN false;
        END IF;
      WHEN 'action' THEN
        value_text := node_record.node ->> 'action';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'action') <> 'string'
          OR char_length(value_text) NOT BETWEEN 1 AND 100
          OR value_text !~ '^[a-z][a-z0-9._-]*$' THEN RETURN false; END IF;
      WHEN 'resource' THEN
        value_text := node_record.node ->> 'resourceType';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 3
          OR jsonb_typeof(node_record.node -> 'resourceType') <> 'string'
          OR char_length(value_text) NOT BETWEEN 1 AND 100
          OR value_text !~ '^[a-z][a-z0-9._-]*$'
          OR NOT node_record.node ? 'resourceKey'
          OR NOT (
            node_record.node -> 'resourceKey' = 'null'::jsonb
            OR (
              jsonb_typeof(node_record.node -> 'resourceKey') = 'string'
              AND public.worldgraph_governance_key_is_valid_v1(
                node_record.node ->> 'resourceKey'
              )
            )
          ) THEN RETURN false; END IF;
      WHEN 'tick_at_or_after','tick_before' THEN
        value_text := node_record.node ->> 'tick';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'tick') <> 'string'
          OR NOT public.worldgraph_governance_tick_text_is_valid_v1(value_text) THEN
          RETURN false;
        END IF;
      WHEN 'tick_between' THEN
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 3
          OR jsonb_typeof(node_record.node -> 'fromTick') <> 'string'
          OR jsonb_typeof(node_record.node -> 'untilTick') <> 'string'
          OR NOT public.worldgraph_governance_tick_text_is_valid_v1(
            node_record.node ->> 'fromTick'
          )
          OR NOT public.worldgraph_governance_tick_text_is_valid_v1(
            node_record.node ->> 'untilTick'
          )
          OR (node_record.node ->> 'fromTick')::bigint
            >= (node_record.node ->> 'untilTick')::bigint THEN
          RETURN false;
        END IF;
      ELSE RETURN false;
    END CASE;
  END LOOP;
  RETURN node_count > 0;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_policy_v1_is_valid(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_policy_matches_v1(
  checked_policy jsonb,
  checked_actor_mode text,
  checked_membership_roles text[],
  checked_held_office_keys text[],
  checked_organization_keys text[],
  checked_action text,
  checked_resource_type text,
  checked_resource_key text,
  checked_tick bigint
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  context_valid boolean;
  node_count integer := 0;
  node_record record;
  node_kind text;
  value_text text;
BEGIN
  IF checked_policy IS NULL
    OR NOT public.worldgraph_governance_policy_v1_is_valid(checked_policy)
    OR checked_actor_mode NOT IN ('in_world','creator','administrator','system')
    OR checked_membership_roles IS NULL
    OR checked_held_office_keys IS NULL
    OR checked_organization_keys IS NULL
    OR cardinality(checked_membership_roles) > 32
    OR cardinality(checked_held_office_keys) > 64
    OR cardinality(checked_organization_keys) > 64
    OR (array_ndims(checked_membership_roles) IS NOT NULL
      AND array_ndims(checked_membership_roles) <> 1)
    OR (array_ndims(checked_held_office_keys) IS NOT NULL
      AND array_ndims(checked_held_office_keys) <> 1)
    OR (array_ndims(checked_organization_keys) IS NOT NULL
      AND array_ndims(checked_organization_keys) <> 1)
    OR checked_action IS NULL OR char_length(checked_action) NOT BETWEEN 1 AND 100
    OR checked_action !~ '^[a-z][a-z0-9._-]*$'
    OR checked_resource_type IS NULL
    OR char_length(checked_resource_type) NOT BETWEEN 1 AND 100
    OR checked_resource_type !~ '^[a-z][a-z0-9._-]*$'
    OR (checked_resource_key IS NOT NULL
      AND NOT public.worldgraph_governance_key_is_valid_v1(checked_resource_key))
    OR checked_tick IS NULL OR checked_tick < 0 THEN
    RETURN false;
  END IF;

  SELECT count(*) = count(role)
      AND count(*) = count(DISTINCT role)
      AND COALESCE(bool_and(
        char_length(role) BETWEEN 1 AND 100
        AND role ~ '^[a-z][a-z0-9._-]*$'
      ),true)
    INTO context_valid
  FROM unnest(checked_membership_roles) role;
  IF NOT COALESCE(context_valid,false) THEN RETURN false; END IF;

  SELECT count(*) = count(office_key)
      AND count(*) = count(DISTINCT office_key)
      AND COALESCE(bool_and(
        public.worldgraph_governance_key_is_valid_v1(office_key)
      ),true)
    INTO context_valid
  FROM unnest(checked_held_office_keys) office_key;
  IF NOT COALESCE(context_valid,false) THEN RETURN false; END IF;

  SELECT count(*) = count(organization_key)
      AND count(*) = count(DISTINCT organization_key)
      AND COALESCE(bool_and(
        public.worldgraph_governance_key_is_valid_v1(organization_key)
      ),true)
    INTO context_valid
  FROM unnest(checked_organization_keys) organization_key;
  IF NOT COALESCE(context_valid,false) THEN RETURN false; END IF;

  FOR node_record IN
    WITH RECURSIVE policy_nodes(node,depth) AS (
      SELECT checked_policy,0
      UNION ALL
      SELECT child_record.child,parent.depth + 1
      FROM policy_nodes parent
      CROSS JOIN LATERAL (
        SELECT child.value
        FROM jsonb_array_elements(
          CASE
            WHEN parent.node ->> 'kind' IN ('all','any')
              AND jsonb_typeof(parent.node -> 'operands') = 'array'
              THEN parent.node -> 'operands'
            ELSE '[]'::jsonb
          END
        ) child(value)
        UNION ALL
        SELECT parent.node -> 'operand'
        WHERE parent.node ->> 'kind' = 'not'
          AND jsonb_typeof(parent.node -> 'operand') = 'object'
      ) child_record(child)
      WHERE parent.depth <= 3
    )
    SELECT node,depth FROM policy_nodes
  LOOP
    node_count := node_count + 1;
    IF node_count > 64 OR node_record.depth > 3
      OR jsonb_typeof(node_record.node) <> 'object' THEN
      RETURN false;
    END IF;
    node_kind := node_record.node ->> 'kind';
    CASE node_kind
      WHEN 'all','any' THEN
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR NOT node_record.node ? 'operands'
          OR jsonb_typeof(node_record.node -> 'operands') <> 'array'
          OR jsonb_array_length(node_record.node -> 'operands') NOT BETWEEN 1 AND 8 THEN
          RETURN false;
        END IF;
      WHEN 'not' THEN
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR NOT node_record.node ? 'operand'
          OR jsonb_typeof(node_record.node -> 'operand') <> 'object' THEN
          RETURN false;
        END IF;
      WHEN 'actor_mode' THEN
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'mode') <> 'string'
          OR node_record.node ->> 'mode' NOT IN (
            'in_world','creator','administrator','system'
          ) THEN RETURN false; END IF;
      WHEN 'membership_role' THEN
        value_text := node_record.node ->> 'role';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'role') <> 'string'
          OR char_length(value_text) NOT BETWEEN 1 AND 100
          OR value_text !~ '^[a-z][a-z0-9._-]*$' THEN RETURN false; END IF;
      WHEN 'holds_office' THEN
        value_text := node_record.node ->> 'officeKey';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'officeKey') <> 'string'
          OR NOT public.worldgraph_governance_key_is_valid_v1(value_text) THEN
          RETURN false;
        END IF;
      WHEN 'member_of_organization' THEN
        value_text := node_record.node ->> 'organizationKey';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'organizationKey') <> 'string'
          OR NOT public.worldgraph_governance_key_is_valid_v1(value_text) THEN
          RETURN false;
        END IF;
      WHEN 'action' THEN
        value_text := node_record.node ->> 'action';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'action') <> 'string'
          OR char_length(value_text) NOT BETWEEN 1 AND 100
          OR value_text !~ '^[a-z][a-z0-9._-]*$' THEN RETURN false; END IF;
      WHEN 'resource' THEN
        value_text := node_record.node ->> 'resourceType';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 3
          OR jsonb_typeof(node_record.node -> 'resourceType') <> 'string'
          OR char_length(value_text) NOT BETWEEN 1 AND 100
          OR value_text !~ '^[a-z][a-z0-9._-]*$'
          OR NOT node_record.node ? 'resourceKey'
          OR NOT (
            node_record.node -> 'resourceKey' = 'null'::jsonb
            OR (
              jsonb_typeof(node_record.node -> 'resourceKey') = 'string'
              AND public.worldgraph_governance_key_is_valid_v1(
                node_record.node ->> 'resourceKey'
              )
            )
          ) THEN RETURN false; END IF;
      WHEN 'tick_at_or_after','tick_before' THEN
        value_text := node_record.node ->> 'tick';
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 2
          OR jsonb_typeof(node_record.node -> 'tick') <> 'string'
          OR NOT public.worldgraph_governance_tick_text_is_valid_v1(value_text) THEN
          RETURN false;
        END IF;
      WHEN 'tick_between' THEN
        IF public.worldgraph_governance_jsonb_key_count_v1(node_record.node) <> 3
          OR jsonb_typeof(node_record.node -> 'fromTick') <> 'string'
          OR jsonb_typeof(node_record.node -> 'untilTick') <> 'string'
          OR NOT public.worldgraph_governance_tick_text_is_valid_v1(
            node_record.node ->> 'fromTick'
          )
          OR NOT public.worldgraph_governance_tick_text_is_valid_v1(
            node_record.node ->> 'untilTick'
          )
          OR (node_record.node ->> 'fromTick')::bigint
            >= (node_record.node ->> 'untilTick')::bigint THEN
          RETURN false;
        END IF;
      ELSE RETURN false;
    END CASE;
  END LOOP;

  RETURN public.worldgraph_governance_policy_node_matches_v1(
    checked_policy,checked_actor_mode,checked_membership_roles,
    checked_held_office_keys,checked_organization_keys,checked_action,
    checked_resource_type,checked_resource_key,checked_tick,0
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_policy_matches_v1(
  jsonb,text,text[],text[],text[],text,text,text,bigint
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_range_is_valid_v1(checked_range int8range)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
RETURN NOT isempty(checked_range)
  AND lower(checked_range) >= 0
  AND lower_inc(checked_range)
  AND NOT upper_inc(checked_range)
  AND (upper(checked_range) IS NULL OR upper(checked_range) > lower(checked_range));
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_range_is_valid_v1(int8range)
  FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.world_compilation_runs
  DROP CONSTRAINT world_compilation_runs_compiler_known,
  ADD CONSTRAINT world_compilation_runs_compiler_known CHECK (
    compiler_config_version = 1
    AND compiler_version IN ('1.0.0','1.1.0','1.2.0','1.3.0')
  );
--> statement-breakpoint
ALTER TABLE public.world_versions
  DROP CONSTRAINT world_versions_compiler_known,
  ADD CONSTRAINT world_versions_compiler_known CHECK (
    compiler_config_version = 1
    AND compiler_version IN ('1.0.0','1.1.0','1.2.0','1.3.0')
  );
--> statement-breakpoint
ALTER TABLE public.compiled_world_artifacts
  DROP CONSTRAINT compiled_world_artifacts_schema_known,
  ADD CONSTRAINT compiled_world_artifacts_schema_known CHECK (
    (artifact_kind = 'compiled_world' AND artifact_schema_version IN (1,2,3,4))
    OR (artifact_kind IN ('compiler_input','visual_plan') AND artifact_schema_version = 1)
  );
--> statement-breakpoint
ALTER TABLE public.compiled_economy_seed_plans
  DROP CONSTRAINT compiled_economy_seed_plans_source_shape,
  ADD CONSTRAINT compiled_economy_seed_plans_source_shape CHECK (
    (source_kind::text = 'compiler_1_1'
      AND seed_plan_schema_version = 1
      AND source_compiler_version = '1.1.0'
      AND source_adapter_id = 'CompiledEconomySeedAdapterV1'
      AND source_adapter_version = '1.0.0'
      AND adopted_command_id IS NULL AND adopted_event_id IS NULL)
    OR (source_kind::text = 'compiler_1_2'
      AND seed_plan_schema_version = 2
      AND source_compiler_version IN ('1.2.0','1.3.0')
      AND source_adapter_id = 'CompiledEconomySeedAdapterV2'
      AND source_adapter_version = '1.0.0'
      AND adopted_command_id IS NULL AND adopted_event_id IS NULL)
    OR (source_kind::text = 'legacy_1_0_adapter'
      AND seed_plan_schema_version = 1
      AND source_compiler_version = '1.0.0'
      AND source_adapter_id = 'LegacyEconomySeedAdapterV1'
      AND source_adapter_version = '1.0.0'
      AND adopted_command_id IS NOT NULL AND adopted_event_id IS NOT NULL)
  );
--> statement-breakpoint
DO $economy_plan_provenance$
DECLARE
  function_definition text;
  updated_definition text;
  previous_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.worldgraph_assert_compiled_economy_seed_plan()'::regprocedure
  ) INTO function_definition;
  previous_definition := function_definition;
  updated_definition := replace(
    previous_definition,
    $needle$ELSE '1.2.0' END)$needle$,
    'ELSE plan_record.source_compiler_version END)'
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'economy plan provenance lacks the sealed compiler-1.2 clause'
      USING ERRCODE = '55000';
  END IF;
  previous_definition := updated_definition;
  updated_definition := replace(
    previous_definition,
    'plan_record.artifact_schema_version IS DISTINCT FROM plan_record.seed_plan_schema_version + 1',
    $replacement$plan_record.artifact_schema_version IS DISTINCT FROM (
        CASE plan_record.source_compiler_version
          WHEN '1.3.0' THEN 4
          ELSE plan_record.seed_plan_schema_version + 1 END
      )$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'economy plan provenance lacks the sealed artifact-schema clause'
      USING ERRCODE = '55000';
  END IF;
  previous_definition := updated_definition;
  updated_definition := replace(
    previous_definition,
    '(plan_record.seed_plan_schema_version + 1)::text',
    $replacement$(CASE plan_record.source_compiler_version
          WHEN '1.3.0' THEN 4
          ELSE plan_record.seed_plan_schema_version + 1 END)::text$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'economy plan provenance lacks the canonical artifact-schema clause'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'public.worldgraph_assert_native_economy_plan_activation()'::regprocedure
  ) INTO function_definition;
  previous_definition := function_definition;
  updated_definition := replace(
    previous_definition,
    $needle$IF checked_compiler_version NOT IN ('1.1.0','1.2.0') THEN RETURN NULL; END IF;$needle$,
    $replacement$IF checked_compiler_version NOT IN ('1.1.0','1.2.0','1.3.0') THEN RETURN NULL; END IF;$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'economy activation lacks the sealed compiler registry clause'
      USING ERRCODE = '55000';
  END IF;
  previous_definition := updated_definition;
  updated_definition := replace(
    previous_definition,
    $needle$expected_artifact_schema := CASE checked_compiler_version WHEN '1.1.0' THEN 2 ELSE 3 END;$needle$,
    $replacement$expected_artifact_schema := CASE checked_compiler_version WHEN '1.1.0' THEN 2 WHEN '1.2.0' THEN 3 ELSE 4 END;$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'economy activation lacks the sealed artifact registry clause'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'public.worldgraph_materialize_world_commerce(uuid,uuid,bytea,uuid,uuid,bigint,timestamptz)'::regprocedure
  ) INTO function_definition;
  previous_definition := function_definition;
  updated_definition := replace(
    previous_definition,
    $needle$plan.source_compiler_version = '1.2.0'$needle$,
    'plan.source_compiler_version = version.compiler_version'
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'commerce materializer lacks the sealed plan compiler clause'
      USING ERRCODE = '55000';
  END IF;
  previous_definition := updated_definition;
  updated_definition := replace(
    previous_definition,
    $needle$version.compiler_version = '1.2.0'$needle$,
    $replacement$version.compiler_version IN ('1.2.0','1.3.0')$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'commerce materializer lacks the sealed compiler clause'
      USING ERRCODE = '55000';
  END IF;
  previous_definition := updated_definition;
  updated_definition := replace(
    previous_definition,
    'artifact.artifact_schema_version = 3',
    $replacement$artifact.artifact_schema_version = CASE version.compiler_version
        WHEN '1.2.0' THEN 3 WHEN '1.3.0' THEN 4 END$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'commerce materializer lacks the sealed artifact clause'
      USING ERRCODE = '55000';
  END IF;
  updated_definition := replace(
    updated_definition,
    'commerce initialization requires an exact compiler 1.2 artifact-3 plan-2',
    'commerce initialization requires exact compiler/artifact 1.2/3 or 1.3/4 plan-2 provenance'
  );
  EXECUTE updated_definition;
END
$economy_plan_provenance$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_protect_simulation_domain_event()
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
      'InitializeWorldSimulationV1','ConfigureWorldClockV1','StartWorldClockV1',
      'PauseWorldClockV1','AdvanceSimulationV1','ScheduleWorldNoticeV1',
      'CancelScheduledActionV1','AutoPauseWorldClockV1','ResolveSimulationFailureV1'
    ) OR NEW.aggregate_type IN (
      'simulation_clock','scheduled_action','simulation_failure','world_notice'
    ) OR NEW.event_type IN (
      'WorldSimulationInitializedV1','WorldClockConfiguredV1','WorldClockStartedV1',
      'WorldClockPausedV1','SimulationAdvancedV1','ScheduledActionCreatedV1',
      'ScheduledActionCancelledV1','ScheduledActionExecutedV1','WorldNoticeEmittedV1',
      'WorldClockAutoPausedV1','SimulationFailureRecordedV1',
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
        OR (NEW.event_type IN ('ScheduledActionCreatedV1','ScheduledActionExecutedV1')
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
          'CreateMarketListingV1','AssessPeriodicTaxV1',
          'InitializeWorldGovernanceV1','CreateProposalV1','OpenProposalVotingV1',
          'CloseAndTallyProposalV1','OpenElectionV1','CloseAndTallyElectionV1',
          'CertifyElectionV1'
        )
        AND NEW.event_type = 'ScheduledActionCreatedV1'
        AND NEW.aggregate_type = 'scheduled_action'
        AND NEW.aggregate_id = NEW.payload ->> 'scheduleId')
      OR (checked_command_type IN ('CancelScheduledActionV1','CancelMarketListingV1')
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
    IF NOT COALESCE(matrix_matches,false)
      OR NOT public.worldgraph_command_write_is_open(NEW.world_id,NEW.command_id) THEN
      RAISE EXCEPTION 'reserved simulation event namespace requires its exact open command'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_simulation_domain_event()
  FROM PUBLIC;
--> statement-breakpoint
CREATE INDEX command_records_governance_rate_scope_idx
  ON public.command_records (
    world_id,actor_type,actor_id,command_type,rate_limit_scope_hash,requested_at DESC
  )
  WHERE rate_limit_scope_hash IS NOT NULL
    AND command_type IN (
      'CreateProposalV1','SponsorProposalV1','CastProposalBallotV1',
      'NominateCandidateV1','AcceptNominationV1','CastElectionBallotV1'
    );
--> statement-breakpoint
ALTER TABLE public.command_records
  ADD COLUMN expected_tick bigint,
  ADD CONSTRAINT command_records_expected_tick_nonnegative CHECK (
    expected_tick IS NULL OR expected_tick >= 0
  ),
  ADD CONSTRAINT command_records_governance_expected_tick_required CHECK (
    command_type NOT IN (
      'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1',
      'CreateProposalV1','SponsorProposalV1','WithdrawProposalV1',
      'CastProposalBallotV1','NominateCandidateV1','AcceptNominationV1',
      'CastElectionBallotV1','AppointOfficeholderV1','RemoveOfficeholderV1',
      'ExecuteCreatorOverrideV1','RepairGovernanceResultV1',
      'OpenProposalVotingV1','CloseAndTallyProposalV1',
      'CertifyAndEnactProposalV1','OpenElectionV1',
      'CloseAndTallyElectionV1','CertifyElectionV1'
    ) OR expected_tick IS NOT NULL
  ) NOT VALID;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_command_expected_tick_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.expected_tick IS DISTINCT FROM OLD.expected_tick THEN
    RAISE EXCEPTION 'command expected tick is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_command_expected_tick_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER command_records_expected_tick_protect
  BEFORE UPDATE ON public.command_records
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_command_expected_tick_v1();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_require_command_rate_limit_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  rate_limited boolean := NEW.command_type IN (
    'PerformJobV1','StartProductionRunV1','CreateMarketListingV1',
    'PurchaseMarketListingV1','CreateProposalV1','SponsorProposalV1',
    'CastProposalBallotV1','NominateCandidateV1','AcceptNominationV1',
    'CastElectionBallotV1'
  );
BEGIN
  IF (rate_limited AND NEW.rate_limit_scope_hash IS NULL)
    OR (NOT rate_limited AND NEW.rate_limit_scope_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'command rate-limit scope does not match its command type'
      USING ERRCODE = '23514',
        CONSTRAINT = 'command_records_rate_limit_scope_required';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_require_command_rate_limit_scope()
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_treasury_encumbrance_projection_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_row jsonb := to_jsonb(NEW);
  checked_world_id uuid := (changed_row ->> 'world_id')::uuid;
  checked_encumbrance_id uuid := COALESCE(
    (changed_row ->> 'encumbrance_id')::uuid,
    (changed_row ->> 'id')::uuid
  );
  aggregate_record record;
BEGIN
  SELECT encumbrance.maximum_minor,
    count(fact.id) FILTER (WHERE fact.fact_kind = 'authorize') AS authorize_count,
    COALESCE(sum(fact.amount_minor) FILTER (WHERE fact.fact_kind = 'authorize'),0)::bigint
      AS authorized_minor,
    COALESCE(sum(fact.amount_minor) FILTER (WHERE fact.fact_kind = 'consume'),0)::bigint
      AS consumed_minor,
    COALESCE(sum(fact.amount_minor) FILTER (WHERE fact.fact_kind = 'release'),0)::bigint
      AS released_minor,
    count(fact.id)::integer AS fact_count,
    COALESCE(max(fact.fact_sequence),0)::integer AS last_fact_sequence,
    projection.authorized_minor AS projected_authorized_minor,
    projection.consumed_minor AS projected_consumed_minor,
    projection.released_minor AS projected_released_minor,
    projection.active_minor AS projected_active_minor,
    projection.last_fact_sequence AS projected_last_fact_sequence
  INTO aggregate_record
  FROM public.treasury_encumbrances encumbrance
  LEFT JOIN public.treasury_encumbrance_facts fact
    ON fact.world_id = encumbrance.world_id AND fact.encumbrance_id = encumbrance.id
  LEFT JOIN public.treasury_encumbrance_projections projection
    ON projection.world_id = encumbrance.world_id
   AND projection.encumbrance_id = encumbrance.id
  WHERE encumbrance.world_id = checked_world_id
    AND encumbrance.id = checked_encumbrance_id
  GROUP BY encumbrance.maximum_minor,projection.authorized_minor,
    projection.consumed_minor,projection.released_minor,projection.active_minor,
    projection.last_fact_sequence;
  IF NOT FOUND OR aggregate_record.authorize_count <> 1
    OR aggregate_record.authorized_minor <> aggregate_record.maximum_minor
    OR aggregate_record.fact_count <> aggregate_record.last_fact_sequence
    OR aggregate_record.projected_authorized_minor IS DISTINCT FROM
      aggregate_record.authorized_minor
    OR aggregate_record.projected_consumed_minor IS DISTINCT FROM
      aggregate_record.consumed_minor
    OR aggregate_record.projected_released_minor IS DISTINCT FROM
      aggregate_record.released_minor
    OR aggregate_record.projected_active_minor IS DISTINCT FROM
      aggregate_record.authorized_minor - aggregate_record.consumed_minor
        - aggregate_record.released_minor
    OR aggregate_record.projected_last_fact_sequence IS DISTINCT FROM
      aggregate_record.last_fact_sequence THEN
    RAISE EXCEPTION 'treasury encumbrance projection does not match append-only facts'
      USING ERRCODE = '23514',
        CONSTRAINT = 'treasury_encumbrance_projection_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_treasury_encumbrance_projection_v1()
  FROM PUBLIC;
--> statement-breakpoint
-- The real treasury projection constraint triggers are installed after their
-- M10 tables are created.
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_json_has_ballot_linkage_v1(
  checked_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE item_key text; item_value jsonb;
BEGIN
  IF checked_value IS NULL THEN RETURN false; END IF;
  IF jsonb_typeof(checked_value) = 'object' THEN
    FOR item_key,item_value IN SELECT key,value FROM jsonb_each(checked_value) LOOP
      IF lower(item_key) = ANY(ARRAY[
        'choice','choicetype','candidatekey','voterentitykey','voterentityid',
        'choicehash','linkagenoncehash','participationid','choicerevisionid',
        'effectiverevision'
      ]) OR public.worldgraph_governance_json_has_ballot_linkage_v1(item_value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(checked_value) = 'array' THEN
    FOR item_value IN SELECT value FROM jsonb_array_elements(checked_value) LOOP
      IF public.worldgraph_governance_json_has_ballot_linkage_v1(item_value) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_json_has_ballot_linkage_v1(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_command_is_secret_ballot_v1(
  checked_world_id uuid,
  checked_command_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
SELECT false
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_command_is_secret_ballot_v1(uuid,uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_secret_ballot_command_payload_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE secret_ballot boolean := false;
BEGIN
  IF NEW.command_type = 'CastProposalBallotV1' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.proposals proposal
      WHERE proposal.world_id = NEW.world_id
        AND proposal.id::text = NEW.payload ->> 'proposalId'
        AND proposal.ballot_mode = 'secret'
    ) INTO secret_ballot;
  ELSIF NEW.command_type = 'CastElectionBallotV1' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.elections election
      WHERE election.world_id = NEW.world_id
        AND election.id::text = NEW.payload ->> 'electionId'
        AND election.ballot_mode = 'secret'
    ) INTO secret_ballot;
  END IF;
  IF secret_ballot AND (
    public.worldgraph_governance_json_has_ballot_linkage_v1(NEW.payload)
    OR public.worldgraph_governance_json_has_ballot_linkage_v1(NEW.response_summary)
  ) THEN
    RAISE EXCEPTION 'secret ballot selection or voter-choice linkage cannot enter command storage'
      USING ERRCODE = '22023',
        CONSTRAINT = 'command_records_secret_ballot_redacted';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_secret_ballot_command_payload_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER command_records_protect_secret_ballot_payload
  BEFORE INSERT OR UPDATE OF payload,response_summary ON public.command_records
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_secret_ballot_command_payload_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_secret_ballot_public_surfaces_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_row jsonb := to_jsonb(NEW);
  checked_world_id uuid := (changed_row ->> 'world_id')::uuid;
  checked_command_id uuid := (changed_row ->> 'command_id')::uuid;
  checked_event_id uuid := (changed_row ->> 'event_id')::uuid;
  checked_payload jsonb;
  secret_ballot boolean := false;
  checked_event_type text := changed_row ->> 'event_type';
BEGIN
  IF checked_command_id IS NULL AND checked_event_id IS NOT NULL THEN
    SELECT event.command_id,event.event_type
      INTO checked_command_id,checked_event_type
    FROM public.domain_events event
    WHERE event.world_id = checked_world_id AND event.id = checked_event_id;
  END IF;
  IF checked_event_type IN (
    'ProposalBallotRecordedSecretV1','ElectionBallotRecordedSecretV1'
  ) THEN
    secret_ballot := true;
  ELSE
    secret_ballot := public.worldgraph_governance_command_is_secret_ballot_v1(
      checked_world_id,checked_command_id
    );
  END IF;
  checked_payload := CASE TG_TABLE_NAME
    WHEN 'domain_events' THEN changed_row -> 'payload'
    WHEN 'outbox_messages' THEN changed_row -> 'payload'
    WHEN 'ledger_entries' THEN changed_row -> 'redacted_details'
    WHEN 'world_history_entries' THEN changed_row -> 'summary_args'
    ELSE '{}'::jsonb
  END;
  IF secret_ballot
    AND public.worldgraph_governance_json_has_ballot_linkage_v1(checked_payload) THEN
    RAISE EXCEPTION 'secret ballot voter-choice linkage cannot enter public ledger surfaces'
      USING ERRCODE = '22023',
        CONSTRAINT = 'governance_secret_ballot_public_surface_redacted';
  END IF;
  IF TG_TABLE_NAME = 'domain_events'
    AND checked_event_type = 'ProposalBallotRecordedSecretV1'
    AND NOT (
      public.worldgraph_jsonb_has_exact_keys(checked_payload,ARRAY[
        'aggregateVersion','ballotMode','disclosure','eventType','proposalId','receiptHash'
      ])
      AND checked_payload ->> 'ballotMode' = 'secret'
      AND checked_payload ->> 'disclosure' = 'aggregate_only'
      AND checked_payload ->> 'eventType' = checked_event_type
      AND checked_payload ->> 'receiptHash' ~ '^[a-f0-9]{64}$'
    ) THEN
    RAISE EXCEPTION 'secret proposal ballot event is not the exact redacted contract'
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'domain_events'
    AND checked_event_type = 'ElectionBallotRecordedSecretV1'
    AND NOT (
      public.worldgraph_jsonb_has_exact_keys(checked_payload,ARRAY[
        'aggregateVersion','ballotMode','disclosure','electionId','eventType','receiptHash'
      ])
      AND checked_payload ->> 'ballotMode' = 'secret'
      AND checked_payload ->> 'disclosure' = 'aggregate_only'
      AND checked_payload ->> 'eventType' = checked_event_type
      AND checked_payload ->> 'receiptHash' ~ '^[a-f0-9]{64}$'
    ) THEN
    RAISE EXCEPTION 'secret election ballot event is not the exact redacted contract'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_secret_ballot_public_surfaces_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER domain_events_protect_secret_ballot_payload
  BEFORE INSERT ON public.domain_events
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_secret_ballot_public_surfaces_v1();
--> statement-breakpoint
CREATE TRIGGER outbox_messages_protect_secret_ballot_payload
  BEFORE INSERT OR UPDATE OF payload ON public.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_secret_ballot_public_surfaces_v1();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_protect_secret_ballot_details
  BEFORE INSERT ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_secret_ballot_public_surfaces_v1();
--> statement-breakpoint
CREATE TRIGGER world_history_protect_secret_ballot_summary
  BEFORE INSERT ON public.world_history_entries
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_secret_ballot_public_surfaces_v1();
--> statement-breakpoint
DO $retained_reconciliation_metadata$
DECLARE changed integer;
BEGIN
  UPDATE public.platform_metadata
  SET value=value || jsonb_build_object('economyReconciliationSchema',2),
      updated_at=now()
  WHERE key='runtime_versions' AND value_schema_version=9
    AND value ->> 'economyReconciliationSchema' IN ('1','2');
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN
    RAISE EXCEPTION 'retained reconciliation metadata is not at a supported M09 state'
      USING ERRCODE='55000';
  END IF;
END
$retained_reconciliation_metadata$;
--> statement-breakpoint
DO $metadata$
DECLARE changed integer;
BEGIN
  UPDATE public.platform_metadata
  SET value = value || jsonb_build_object(
        'compiler','1.3.0',
        'compilerArtifactSchema',4,
        'contracts',10,
        'economyReconciliationSchema',3,
        'governancePolicySchema',1,
        'governanceSchema',1,
        'governanceSeedPlanSchema',1,
        'runtimeSchema',10,
        'simulationProcessRegistry',3
      ),
      value_schema_version = 10,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 9
    AND value ->> 'compiler' = '1.2.0'
    AND value ->> 'compilerArtifactSchema' = '3'
    AND value ->> 'contracts' = '9'
    AND value ->> 'economySeedPlanSchema' = '2'
    AND value ->> 'economyReconciliationSchema' = '2'
    AND value ->> 'runtimeSchema' = '9'
    AND value ->> 'simulationProcessRegistry' = '2'
    AND value ->> 'commerceProjectionRepairSchema' = '1'
    AND NOT value ?| ARRAY[
      'governancePolicySchema','governanceSchema','governanceSeedPlanSchema'
    ];
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact sealed M09 compatibility state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_apply_governance_grants_v1()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $grants$
BEGIN
  GRANT USAGE ON SCHEMA public TO worldgraph_governance_tally;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM worldgraph_governance_tally;

  GRANT SELECT ON public.governance_contests,public.proposal_contests,
    public.election_contests,public.proposals,public.elections,public.candidacies,
    public.eligibility_snapshots,public.eligibility_snapshot_members,
    public.ballot_choice_revisions,public.ballot_effective_revisions,
    public.public_ballot_choices,
    public.secret_ballot_choices,public.proposal_tallies,
    public.proposal_tally_counts,public.election_tallies,
    public.election_tally_counts
    TO worldgraph_governance_tally;
  REVOKE INSERT,UPDATE,DELETE ON public.proposal_tallies,
    public.proposal_tally_counts,public.election_tallies,
    public.election_tally_counts FROM worldgraph_governance_tally;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT INSERT (expected_tick) ON public.command_records TO worldgraph_app;

    GRANT SELECT ON
      public.compiled_governance_seed_plans,public.world_governance_heads,
      public.governing_charters,public.governing_charter_versions,
      public.charter_authority_intervals,public.institutions,public.institution_powers,
      public.laws,public.law_versions,public.law_effectivity_transitions,
      public.law_authority_intervals,public.political_offices,
      public.political_office_seats,public.office_powers,public.office_terms,
      public.office_power_delegations,
      public.office_term_transitions,public.office_seat_authority_intervals,
      public.proposals,public.proposal_actions,public.proposal_sponsors,
      public.proposal_transitions,public.proposal_enactments,
      public.proposal_action_enactments,public.governance_contests,
      public.proposal_contests,public.election_contests,public.eligibility_snapshots,
      public.ballot_participation,
      public.ballot_receipts,public.public_ballot_choices,public.proposal_results,
      public.elections,public.candidacies,public.candidacy_transitions,
      public.election_results,public.governance_authority_decisions,
      public.governance_authority_decision_sources,
      public.governance_schedule_occurrences,public.governance_overrides,
      public.governance_override_approvals,public.governance_repairs,
      public.governance_repair_approvals,public.public_project_authorizations,
      public.treasury_encumbrances,public.treasury_encumbrance_facts,
      public.treasury_encumbrance_projections,
      public.tax_policy_authority_intervals,public.governance_tax_policy_lineage
      TO worldgraph_app;

    GRANT INSERT ON
      public.compiled_governance_seed_plans,public.world_governance_heads,
      public.governing_charters,public.governing_charter_versions,
      public.charter_authority_intervals,public.institutions,public.institution_powers,
      public.laws,public.law_versions,public.law_effectivity_transitions,
      public.law_authority_intervals,public.political_offices,
      public.political_office_seats,public.office_powers,public.office_terms,
      public.office_power_delegations,
      public.office_term_transitions,public.office_seat_authority_intervals,
      public.proposals,public.proposal_actions,public.proposal_sponsors,
      public.proposal_transitions,public.proposal_enactments,
      public.proposal_action_enactments,public.governance_contests,
      public.proposal_contests,public.election_contests,public.eligibility_snapshots,
      public.eligibility_snapshot_members,public.proposal_results,public.elections,
      public.candidacies,public.candidacy_transitions,public.election_results,
      public.governance_authority_decisions,
      public.governance_authority_decision_sources,
      public.governance_schedule_occurrences,public.governance_overrides,
      public.governance_override_approvals,public.governance_repairs,
      public.governance_repair_approvals,public.public_project_authorizations,
      public.treasury_encumbrances,public.treasury_encumbrance_facts,
      public.treasury_encumbrance_projections,public.governance_tax_policy_lineage
      TO worldgraph_app;

    REVOKE UPDATE ON public.world_governance_heads,public.charter_authority_intervals,
      public.institutions,public.political_offices,public.proposals,public.elections,
      public.candidacies,public.governance_contests,public.law_authority_intervals,
      public.office_seat_authority_intervals,
      public.treasury_encumbrance_projections
      FROM worldgraph_app;
    GRANT UPDATE (checksum,row_version,updated_state_revision,updated_at)
      ON public.world_governance_heads TO worldgraph_app;
    GRANT UPDATE (row_version,updated_at)
      ON public.political_offices TO worldgraph_app;
    GRANT UPDATE (status,aggregate_version,updated_at)
      ON public.proposals,public.elections,public.governance_contests
      TO worldgraph_app;
    GRANT UPDATE (
      status,aggregate_version,accepted_command_id,accepted_event_id,updated_at
    ) ON public.candidacies TO worldgraph_app;
    GRANT UPDATE (effective_ticks,updated_command_id,row_version,updated_at)
      ON public.law_authority_intervals,public.office_seat_authority_intervals
      TO worldgraph_app;
    REVOKE UPDATE ON public.tax_policy_authority_intervals FROM worldgraph_app;

    GRANT EXECUTE ON FUNCTION
      public.worldgraph_governance_json_is_safe_v1(jsonb,integer),
      public.worldgraph_governance_key_is_valid_v1(text),
      public.worldgraph_governance_policy_matches_v1(
        jsonb,text,text[],text[],text[],text,text,text,bigint
      ),
      public.worldgraph_governance_range_is_valid_v1(int8range),
      public.worldgraph_governance_seed_plan_v1_is_valid(jsonb),
      public.worldgraph_schedule_pair_is_valid_v2(text,text),
      public.worldgraph_allocate_schedule_sequence(uuid),
      public.worldgraph_cast_governance_ballot_v1(
        uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,jsonb,bigint,boolean,
        bigint,uuid,uuid,bigint
      ),
      public.worldgraph_governance_ballot_receipt_v1(uuid,uuid,bytea),
      public.worldgraph_seed_governance_aggregate_stream_v1(
        uuid,uuid,text,text
      ),
      public.worldgraph_persist_proposal_tally_v1(
        uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,integer,
        integer,integer,integer,bytea,bytea,bigint,uuid,uuid,uuid,uuid
      ),
      public.worldgraph_persist_election_tally_v1(
        uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,bytea,
        bytea,bigint,uuid,jsonb,uuid
      ),
      public.worldgraph_recount_proposal_result_v1(
        uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,uuid,uuid,bigint,bigint
      ),
      public.worldgraph_recount_election_result_v1(
        uuid,uuid,uuid,uuid,jsonb,uuid,bytea,bytea,uuid,uuid,bigint,bigint
      ),
      public.worldgraph_proposal_tally_for_certification_v1(uuid,uuid,bytea,uuid),
      public.worldgraph_election_tally_for_certification_v1(uuid,uuid,bytea,uuid),
      public.worldgraph_wallet_spendable_minor_v1(uuid),
      public.worldgraph_wallet_spendable_minor_v1(uuid,uuid),
      public.worldgraph_tax_policy_effective_at_v2(uuid,tax_policy_type,bigint),
      public.worldgraph_insert_governed_tax_policy_v1(
        uuid,uuid,uuid,uuid,text,integer,uuid,uuid,uuid,tax_policy_type,
        tax_collection_mode,integer,bigint,jsonb,bigint,text,text,text,uuid,bytea,
        uuid,bytea,uuid,uuid,uuid,uuid,uuid,bigint,bytea
      ),
      public.worldgraph_issue_recent_credential_proof_v1(
        uuid,bytea,uuid,uuid,uuid,uuid,text,bytea,timestamptz,timestamptz,text,uuid
      ),
      public.worldgraph_consume_recent_credential_proof_v1(
        bytea,uuid,uuid,uuid,uuid,text,bytea,text
      ),
      public.worldgraph_verify_recent_credential_replay_v1(
        bytea,uuid,uuid,uuid,uuid,text,bytea,text
      )
      TO worldgraph_app;

    REVOKE ALL ON public.recent_credential_proofs,
      public.recent_credential_proof_consumptions
      FROM worldgraph_app;

    REVOKE ALL ON public.ballot_choice_revisions,
      public.ballot_effective_revisions,public.secret_ballot_choices,
      public.proposal_tallies,public.proposal_tally_counts,
      public.election_tallies,public.election_tally_counts
      FROM worldgraph_app;
    REVOKE SELECT ON public.eligibility_snapshot_members FROM worldgraph_app;
    REVOKE UPDATE,DELETE ON
      public.compiled_governance_seed_plans,public.governing_charters,
      public.governing_charter_versions,public.institution_powers,public.laws,
      public.law_versions,public.law_effectivity_transitions,
      public.political_office_seats,public.office_powers,
      public.office_power_delegations,public.office_terms,
      public.office_term_transitions,public.proposal_actions,
      public.proposal_sponsors,public.proposal_transitions,
      public.proposal_enactments,public.proposal_action_enactments,
      public.eligibility_snapshots,public.eligibility_snapshot_members,
      public.ballot_receipts,public.public_ballot_choices,public.proposal_results,
      public.candidacy_transitions,public.election_results,
      public.governance_authority_decisions,
      public.governance_authority_decision_sources,
      public.governance_schedule_occurrences,public.governance_overrides,
      public.governance_override_approvals,public.governance_repairs,
      public.governance_repair_approvals,public.public_project_authorizations,
      public.treasury_encumbrances,public.treasury_encumbrance_facts,
      public.governance_tax_policy_lineage
      FROM worldgraph_app;
  END IF;

  IF pg_catalog.has_table_privilege(
      'worldgraph_app','public.secret_ballot_choices','SELECT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.ballot_effective_revisions','SELECT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.proposal_tallies','SELECT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.proposal_tallies','INSERT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.election_tally_counts','INSERT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.recent_credential_proofs','SELECT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.recent_credential_proof_consumptions','SELECT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.recent_credential_proofs','INSERT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.recent_credential_proof_consumptions','INSERT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_app','public.eligibility_snapshot_members','SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
      'worldgraph_governance_tally','public.secret_ballot_choices','SELECT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_governance_tally','public.proposal_tallies','INSERT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_governance_tally','public.users','SELECT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_governance_tally','public.wallet_balances','SELECT'
    ) OR pg_catalog.has_table_privilege(
      'worldgraph_governance_tally','public.ballot_participation','SELECT'
    ) THEN
    RAISE EXCEPTION 'governance ballot role boundary is not least privilege'
      USING ERRCODE = '42501';
  END IF;
END
$grants$;
--> statement-breakpoint
SET CONSTRAINTS ALL DEFERRED;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_assert_compiler_artifact_version_pair()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  run_record record;
  economy_domain text;
  governance_domain text := 'worldgraph.governance-seed-plan.v1';
BEGIN
  SELECT compiler_version, compiler_config_version
    INTO run_record
    FROM public.world_compilation_runs
   WHERE id = NEW.compilation_run_id AND world_id = NEW.world_id;
  IF NOT FOUND OR run_record.compiler_config_version <> 1 THEN
    RAISE EXCEPTION 'compiled artifact requires a known compiler run'
      USING ERRCODE = '55000';
  END IF;
  economy_domain := CASE NEW.artifact_schema_version
    WHEN 2 THEN 'worldgraph.economy-seed-plan.v1'
    WHEN 3 THEN 'worldgraph.economy-seed-plan.v2'
    WHEN 4 THEN 'worldgraph.economy-seed-plan.v2'
    ELSE NULL
  END;
  IF NEW.artifact_kind = 'compiled_world' AND NOT (
    (run_record.compiler_version = '1.0.0' AND NEW.artifact_schema_version = 1
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '1'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.0.0'
      AND NEW.canonical_content ->> 'compilerConfigVersion' = '1'
      AND NOT NEW.canonical_content ? 'economySeedPlan'
      AND NOT NEW.canonical_content ? 'governanceSeedPlan')
    OR
    (run_record.compiler_version = '1.1.0' AND NEW.artifact_schema_version = 2
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '2'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.1.0'
      AND NEW.canonical_content ->> 'compilerConfigVersion' = '1'
      AND jsonb_typeof(NEW.canonical_content -> 'economySeedPlan') = 'object'
      AND NEW.canonical_content ->> 'economySeedPlanHash' ~ '^[a-f0-9]{64}$'
      AND decode(NEW.canonical_content ->> 'economySeedPlanHash', 'hex') =
        extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
          'domain', economy_domain, 'plan', NEW.canonical_content -> 'economySeedPlan'
        )), 'UTF8'), 'sha256')
      AND NOT NEW.canonical_content ? 'governanceSeedPlan')
    OR
    (run_record.compiler_version = '1.2.0' AND NEW.artifact_schema_version = 3
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '3'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.2.0'
      AND NEW.canonical_content ->> 'compilerConfigVersion' = '1'
      AND jsonb_typeof(NEW.canonical_content -> 'economySeedPlan') = 'object'
      AND NEW.canonical_content -> 'economySeedPlan' ->> 'economySeedPlanSchemaVersion' = '2'
      AND NEW.canonical_content ->> 'economySeedPlanHash' ~ '^[a-f0-9]{64}$'
      AND decode(NEW.canonical_content ->> 'economySeedPlanHash', 'hex') =
        extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
          'domain', economy_domain, 'plan', NEW.canonical_content -> 'economySeedPlan'
        )), 'UTF8'), 'sha256')
      AND NOT NEW.canonical_content ? 'governanceSeedPlan')
    OR
    (run_record.compiler_version = '1.3.0' AND NEW.artifact_schema_version = 4
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '4'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.3.0'
      AND NEW.canonical_content ->> 'compilerConfigVersion' = '1'
      AND jsonb_typeof(NEW.canonical_content -> 'economySeedPlan') = 'object'
      AND NEW.canonical_content -> 'economySeedPlan' ->> 'economySeedPlanSchemaVersion' = '2'
      AND NEW.canonical_content ->> 'economySeedPlanHash' ~ '^[a-f0-9]{64}$'
      AND decode(NEW.canonical_content ->> 'economySeedPlanHash', 'hex') =
        extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
          'domain', economy_domain, 'plan', NEW.canonical_content -> 'economySeedPlan'
        )), 'UTF8'), 'sha256')
      AND jsonb_typeof(NEW.canonical_content -> 'governanceSeedPlan') = 'object'
      AND NEW.canonical_content -> 'governanceSeedPlan' ->> 'governanceSeedPlanSchemaVersion' = '1'
      AND NEW.canonical_content ->> 'governanceSeedPlanHash' ~ '^[a-f0-9]{64}$'
      AND decode(NEW.canonical_content ->> 'governanceSeedPlanHash', 'hex') =
        extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
          'domain', governance_domain, 'value', NEW.canonical_content -> 'governanceSeedPlan'
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
CREATE TABLE public.compiled_governance_seed_plans (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id) ON DELETE RESTRICT,
  world_version_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_compiler_version text NOT NULL,
  source_artifact_hash bytea NOT NULL,
  governance_seed_plan_schema_version integer NOT NULL DEFAULT 1,
  canonical_plan jsonb NOT NULL,
  plan_hash bytea NOT NULL,
  adopted_command_id uuid,
  adopted_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compiled_governance_seed_plans_world_identity UNIQUE (world_id,id),
  CONSTRAINT compiled_governance_seed_plans_world_version_unique UNIQUE (world_id,world_version_id),
  CONSTRAINT compiled_governance_seed_plans_world_plan_unique UNIQUE (world_id,plan_hash),
  CONSTRAINT compiled_governance_seed_plans_version_plan_unique
    UNIQUE (world_id,world_version_id,plan_hash),
  CONSTRAINT compiled_governance_seed_plans_version_world_fk
    FOREIGN KEY (world_version_id,world_id)
    REFERENCES public.world_versions(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT compiled_governance_seed_plans_adoption_command_world_fk
    FOREIGN KEY (adopted_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT compiled_governance_seed_plans_adoption_event_world_fk
    FOREIGN KEY (world_id,adopted_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT compiled_governance_seed_plans_source_known CHECK (
    (source_kind = 'compiler_1_3' AND source_compiler_version = '1.3.0'
      AND adopted_command_id IS NULL AND adopted_event_id IS NULL)
    OR (source_kind = 'adopted_legacy' AND source_compiler_version IN ('1.0.0','1.1.0','1.2.0')
      AND adopted_command_id IS NOT NULL AND adopted_event_id IS NOT NULL)
  ),
  CONSTRAINT compiled_governance_seed_plans_schema_known CHECK (
    governance_seed_plan_schema_version = 1
  ),
  CONSTRAINT compiled_governance_seed_plans_plan_safe CHECK (
    public.worldgraph_governance_json_is_safe_v1(canonical_plan,1048576)
  ),
  CONSTRAINT compiled_governance_seed_plans_hashes_valid CHECK (
    octet_length(source_artifact_hash) = 32
    AND octet_length(plan_hash) = 32
    AND plan_hash = extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
      jsonb_build_object('domain','worldgraph.governance-seed-plan.v1','value',canonical_plan)
    ),'UTF8'),'sha256')
  )
);
--> statement-breakpoint
CREATE TABLE public.world_governance_heads (
  world_id uuid PRIMARY KEY REFERENCES public.worlds(id) ON DELETE RESTRICT,
  source_world_version_id uuid NOT NULL,
  seed_plan_hash bytea NOT NULL,
  governance_schema_version integer NOT NULL DEFAULT 1,
  projection_schema_version integer NOT NULL DEFAULT 1,
  checksum bytea NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  updated_state_revision bigint NOT NULL,
  initialized_command_id uuid NOT NULL UNIQUE,
  initialized_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_governance_heads_plan_fk
    FOREIGN KEY (world_id,source_world_version_id,seed_plan_hash)
    REFERENCES public.compiled_governance_seed_plans(world_id,world_version_id,plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT world_governance_heads_command_world_fk
    FOREIGN KEY (initialized_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT world_governance_heads_event_world_fk
    FOREIGN KEY (world_id,initialized_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT world_governance_heads_schema_known CHECK (
    governance_schema_version = 1 AND projection_schema_version = 1
  ),
  CONSTRAINT world_governance_heads_hash_valid CHECK (
    octet_length(seed_plan_hash) = 32 AND octet_length(checksum) = 32
  ),
  CONSTRAINT world_governance_heads_versions_positive CHECK (
    row_version > 0 AND updated_state_revision > 0 AND updated_at >= created_at
  )
);
--> statement-breakpoint
CREATE TABLE public.governing_charters (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id) ON DELETE RESTRICT,
  stable_key extensions.citext NOT NULL,
  jurisdiction_entity_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governing_charters_world_identity UNIQUE (world_id,id),
  CONSTRAINT governing_charters_world_key_unique UNIQUE (world_id,stable_key),
  CONSTRAINT governing_charters_jurisdiction_world_fk
    FOREIGN KEY (world_id,jurisdiction_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governing_charters_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT governing_charters_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governing_charters_key_valid CHECK (
    public.worldgraph_governance_key_is_valid_v1(stable_key::text)
  ),
  CONSTRAINT governing_charters_versions_positive CHECK (
    row_version > 0 AND created_state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE public.governing_charter_versions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  charter_id uuid NOT NULL,
  charter_version integer NOT NULL,
  source_world_version_id uuid NOT NULL,
  seed_plan_hash bytea NOT NULL,
  policy_dsl_version integer NOT NULL DEFAULT 1,
  canonical_policy_document jsonb NOT NULL,
  checksum bytea NOT NULL,
  effective_from_tick bigint NOT NULL,
  declared_until_tick bigint,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governing_charter_versions_world_identity UNIQUE (world_id,id),
  CONSTRAINT governing_charter_versions_number_unique UNIQUE (charter_id,charter_version),
  CONSTRAINT governing_charter_versions_start_unique UNIQUE (charter_id,effective_from_tick),
  CONSTRAINT governing_charter_versions_charter_world_fk
    FOREIGN KEY (world_id,charter_id)
    REFERENCES public.governing_charters(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governing_charter_versions_plan_fk
    FOREIGN KEY (world_id,source_world_version_id,seed_plan_hash)
    REFERENCES public.compiled_governance_seed_plans(world_id,world_version_id,plan_hash)
    ON DELETE RESTRICT,
  CONSTRAINT governing_charter_versions_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT governing_charter_versions_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governing_charter_versions_schema_known CHECK (
    policy_dsl_version = 1 AND charter_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT governing_charter_versions_ticks_valid CHECK (
    effective_from_tick >= 0
    AND (declared_until_tick IS NULL OR declared_until_tick > effective_from_tick)
    AND created_state_revision > 0
  ),
  CONSTRAINT governing_charter_versions_documents_safe CHECK (
    public.worldgraph_governance_json_is_safe_v1(canonical_policy_document,262144)
    AND public.worldgraph_governance_json_is_safe_v1(provenance,32768)
  ),
  CONSTRAINT governing_charter_versions_hash_valid CHECK (
    octet_length(seed_plan_hash) = 32 AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.charter_authority_intervals (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  charter_id uuid NOT NULL,
  charter_version_id uuid NOT NULL,
  effective_ticks int8range NOT NULL,
  created_command_id uuid NOT NULL,
  updated_command_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT charter_authority_intervals_world_identity UNIQUE (world_id,id),
  CONSTRAINT charter_authority_intervals_version_unique UNIQUE (charter_version_id),
  CONSTRAINT charter_authority_intervals_charter_world_fk
    FOREIGN KEY (world_id,charter_id)
    REFERENCES public.governing_charters(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT charter_authority_intervals_version_world_fk
    FOREIGN KEY (world_id,charter_version_id)
    REFERENCES public.governing_charter_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT charter_authority_intervals_created_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT charter_authority_intervals_updated_command_world_fk
    FOREIGN KEY (updated_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT charter_authority_intervals_range_valid CHECK (
    public.worldgraph_governance_range_is_valid_v1(effective_ticks)
  ),
  CONSTRAINT charter_authority_intervals_versions_positive CHECK (
    row_version > 0 AND updated_at >= created_at
  ),
  CONSTRAINT charter_authority_intervals_no_overlap EXCLUDE USING gist (
    world_id WITH =,
    charter_id WITH =,
    effective_ticks WITH &&
  )
);
--> statement-breakpoint
CREATE TABLE public.institutions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  charter_version_id uuid NOT NULL,
  jurisdiction_entity_id uuid NOT NULL,
  stable_key extensions.citext NOT NULL,
  institution_type text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institutions_world_identity UNIQUE (world_id,id),
  CONSTRAINT institutions_entity_unique UNIQUE (world_id,entity_id),
  CONSTRAINT institutions_world_key_unique UNIQUE (world_id,stable_key),
  CONSTRAINT institutions_entity_world_fk
    FOREIGN KEY (world_id,entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT institutions_charter_version_world_fk
    FOREIGN KEY (world_id,charter_version_id)
    REFERENCES public.governing_charter_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT institutions_jurisdiction_world_fk
    FOREIGN KEY (world_id,jurisdiction_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT institutions_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT institutions_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT institutions_key_valid CHECK (
    public.worldgraph_governance_key_is_valid_v1(stable_key::text)
  ),
  CONSTRAINT institutions_type_valid CHECK (
    institution_type IN ('council','executive','electoral','treasury','public_service')
    AND status IN ('active','suspended','retired')
  ),
  CONSTRAINT institutions_versions_positive CHECK (
    row_version > 0 AND created_state_revision > 0 AND updated_at >= created_at
  )
);
--> statement-breakpoint
CREATE TABLE public.institution_powers (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  charter_version_id uuid NOT NULL,
  power_key text NOT NULL,
  action_code text NOT NULL,
  resource_type text NOT NULL,
  scope_policy jsonb NOT NULL,
  policy_dsl_version integer NOT NULL DEFAULT 1,
  checksum bytea NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_powers_world_identity UNIQUE (world_id,id),
  CONSTRAINT institution_powers_key_unique UNIQUE (institution_id,charter_version_id,power_key),
  CONSTRAINT institution_powers_institution_world_fk
    FOREIGN KEY (world_id,institution_id)
    REFERENCES public.institutions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT institution_powers_charter_version_world_fk
    FOREIGN KEY (world_id,charter_version_id)
    REFERENCES public.governing_charter_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT institution_powers_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT institution_powers_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT institution_powers_codes_valid CHECK (
    char_length(power_key) BETWEEN 3 AND 120 AND power_key ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(action_code) BETWEEN 3 AND 120 AND action_code ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(resource_type) BETWEEN 1 AND 80 AND resource_type ~ '^[a-z][a-z0-9._-]*$'
    AND policy_dsl_version = 1
  ),
  CONSTRAINT institution_powers_policy_safe CHECK (
    public.worldgraph_governance_json_is_safe_v1(scope_policy,32768)
  ),
  CONSTRAINT institution_powers_hash_valid CHECK (octet_length(checksum) = 32)
);
--> statement-breakpoint
CREATE TABLE public.laws (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  jurisdiction_entity_id uuid NOT NULL,
  stable_key extensions.citext NOT NULL,
  title text NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT laws_world_identity UNIQUE (world_id,id),
  CONSTRAINT laws_world_key_unique UNIQUE (world_id,stable_key),
  CONSTRAINT laws_jurisdiction_world_fk
    FOREIGN KEY (world_id,jurisdiction_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT laws_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT laws_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT laws_key_valid CHECK (public.worldgraph_governance_key_is_valid_v1(stable_key::text)),
  CONSTRAINT laws_title_valid CHECK (
    char_length(btrim(title)) BETWEEN 1 AND 160 AND title = btrim(title)
    AND title !~ '[[:cntrl:]]' AND created_state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE public.law_versions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  law_id uuid NOT NULL,
  law_version integer NOT NULL,
  version_kind text NOT NULL,
  initial_status text NOT NULL DEFAULT 'scheduled',
  title text NOT NULL,
  summary text NOT NULL,
  policy_ast jsonb NOT NULL,
  action_effects jsonb NOT NULL,
  policy_dsl_version integer NOT NULL DEFAULT 1,
  supersedes_version_id uuid,
  source_proposal_result_id uuid,
  source_action_ordinal integer,
  effective_from_tick bigint NOT NULL,
  checksum bytea NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT law_versions_world_identity UNIQUE (world_id,id),
  CONSTRAINT law_versions_number_unique UNIQUE (law_id,law_version),
  CONSTRAINT law_versions_start_unique UNIQUE (law_id,effective_from_tick),
  CONSTRAINT law_versions_law_world_fk
    FOREIGN KEY (world_id,law_id)
    REFERENCES public.laws(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT law_versions_supersedes_world_fk
    FOREIGN KEY (world_id,supersedes_version_id)
    REFERENCES public.law_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT law_versions_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT law_versions_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT law_versions_shape_valid CHECK (
    law_version BETWEEN 1 AND 2147483647
    AND version_kind IN ('create','amend','repeal')
    AND initial_status IN ('scheduled','active','repealed','expired','superseded')
    AND ((law_version = 1 AND supersedes_version_id IS NULL AND version_kind = 'create')
      OR (law_version > 1 AND supersedes_version_id IS NOT NULL AND version_kind IN ('amend','repeal')))
    AND effective_from_tick >= 0 AND created_state_revision > 0
    AND policy_dsl_version = 1
    AND char_length(btrim(title)) BETWEEN 1 AND 160 AND title = btrim(title)
    AND char_length(btrim(summary)) BETWEEN 1 AND 2000 AND summary = btrim(summary)
    AND translate(title || summary,E'\t\n\r','') !~ '[[:cntrl:]]'
  ),
  CONSTRAINT law_versions_documents_safe CHECK (
    public.worldgraph_governance_json_is_safe_v1(policy_ast,65536)
    AND public.worldgraph_governance_json_is_safe_v1(action_effects,65536)
  ),
  CONSTRAINT law_versions_source_shape CHECK (
    (source_proposal_result_id IS NULL AND source_action_ordinal IS NULL)
    OR (source_proposal_result_id IS NOT NULL AND source_action_ordinal BETWEEN 0 AND 15)
  ),
  CONSTRAINT law_versions_hash_valid CHECK (octet_length(checksum) = 32)
);
--> statement-breakpoint
CREATE TABLE public.law_effectivity_transitions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  law_id uuid NOT NULL,
  law_version_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  effective_tick bigint NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT law_effectivity_transitions_world_identity UNIQUE (world_id,id),
  CONSTRAINT law_effectivity_transitions_tick_unique UNIQUE (law_id,effective_tick),
  CONSTRAINT law_effectivity_transitions_event_unique UNIQUE (event_id),
  CONSTRAINT law_effectivity_transitions_law_world_fk
    FOREIGN KEY (world_id,law_id) REFERENCES public.laws(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT law_effectivity_transitions_version_world_fk
    FOREIGN KEY (world_id,law_version_id)
    REFERENCES public.law_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT law_effectivity_transitions_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT law_effectivity_transitions_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT law_effectivity_transitions_shape_valid CHECK (
    to_status IN ('scheduled','active','repealed','expired','superseded')
    AND (from_status IS NULL OR from_status IN (
      'scheduled','active','repealed','expired','superseded'
    ))
    AND effective_tick >= 0 AND state_revision > 0 AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.law_authority_intervals (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  law_id uuid NOT NULL,
  law_version_id uuid NOT NULL UNIQUE,
  effective_ticks int8range NOT NULL,
  created_command_id uuid NOT NULL,
  updated_command_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT law_authority_intervals_world_identity UNIQUE (world_id,id),
  CONSTRAINT law_authority_intervals_law_world_fk
    FOREIGN KEY (world_id,law_id) REFERENCES public.laws(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT law_authority_intervals_version_world_fk
    FOREIGN KEY (world_id,law_version_id)
    REFERENCES public.law_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT law_authority_intervals_created_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT law_authority_intervals_updated_command_world_fk
    FOREIGN KEY (updated_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT law_authority_intervals_range_valid CHECK (
    public.worldgraph_governance_range_is_valid_v1(effective_ticks)
    AND row_version > 0 AND updated_at >= created_at
  ),
  CONSTRAINT law_authority_intervals_no_overlap EXCLUDE USING gist (
    world_id WITH =,
    law_id WITH =,
    effective_ticks WITH &&
  )
);
--> statement-breakpoint
CREATE INDEX law_authority_intervals_effective_idx
  ON public.law_authority_intervals USING gist (world_id, effective_ticks);
--> statement-breakpoint
CREATE TABLE public.political_offices (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  charter_version_id uuid NOT NULL,
  stable_key extensions.citext NOT NULL,
  title text NOT NULL,
  selection_method text NOT NULL,
  seat_count integer NOT NULL,
  term_ticks bigint NOT NULL,
  eligibility_policy jsonb NOT NULL,
  tie_policy text NOT NULL,
  vacancy_policy text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT political_offices_world_identity UNIQUE (world_id,id),
  CONSTRAINT political_offices_key_unique UNIQUE (institution_id,stable_key),
  CONSTRAINT political_offices_institution_world_fk
    FOREIGN KEY (world_id,institution_id)
    REFERENCES public.institutions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT political_offices_charter_version_world_fk
    FOREIGN KEY (world_id,charter_version_id)
    REFERENCES public.governing_charter_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT political_offices_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT political_offices_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT political_offices_shape_valid CHECK (
    public.worldgraph_governance_key_is_valid_v1(stable_key::text)
    AND char_length(btrim(title)) BETWEEN 1 AND 120 AND title = btrim(title)
    AND title !~ '[[:cntrl:]]'
    AND selection_method IN ('election','appointment')
    AND seat_count BETWEEN 1 AND 64
    AND term_ticks BETWEEN 1 AND 9223372036854775807
    AND tie_policy IN ('vacancy','stable_key')
    AND vacancy_policy IN ('special_election','appointment','remain_vacant')
    AND row_version > 0 AND created_state_revision > 0
    AND updated_at >= created_at
  ),
  CONSTRAINT political_offices_policy_safe CHECK (
    public.worldgraph_governance_json_is_safe_v1(eligibility_policy,32768)
  )
);
--> statement-breakpoint
CREATE TABLE public.political_office_seats (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  office_id uuid NOT NULL,
  seat_ordinal integer NOT NULL,
  stable_key extensions.citext NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT political_office_seats_world_identity UNIQUE (world_id,id),
  CONSTRAINT political_office_seats_world_office_identity
    UNIQUE (world_id,id,office_id),
  CONSTRAINT political_office_seats_ordinal_unique UNIQUE (office_id,seat_ordinal),
  CONSTRAINT political_office_seats_key_unique UNIQUE (office_id,stable_key),
  CONSTRAINT political_office_seats_office_world_fk
    FOREIGN KEY (world_id,office_id)
    REFERENCES public.political_offices(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT political_office_seats_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT political_office_seats_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT political_office_seats_shape_valid CHECK (
    seat_ordinal BETWEEN 1 AND 64
    AND public.worldgraph_governance_key_is_valid_v1(stable_key::text)
    AND status IN ('active','retired')
  )
);
--> statement-breakpoint
CREATE TABLE public.office_powers (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  office_id uuid NOT NULL,
  charter_version_id uuid NOT NULL,
  power_key text NOT NULL,
  action_code text NOT NULL,
  resource_type text NOT NULL,
  scope_policy jsonb NOT NULL,
  policy_dsl_version integer NOT NULL DEFAULT 1,
  checksum bytea NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_powers_world_identity UNIQUE (world_id,id),
  CONSTRAINT office_powers_world_charter_identity
    UNIQUE (world_id,id,charter_version_id),
  CONSTRAINT office_powers_key_unique UNIQUE (office_id,charter_version_id,power_key),
  CONSTRAINT office_powers_office_world_fk
    FOREIGN KEY (world_id,office_id)
    REFERENCES public.political_offices(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_powers_charter_world_fk
    FOREIGN KEY (world_id,charter_version_id)
    REFERENCES public.governing_charter_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_powers_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT office_powers_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT office_powers_shape_valid CHECK (
    char_length(power_key) BETWEEN 3 AND 120 AND power_key ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(action_code) BETWEEN 3 AND 120 AND action_code ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(resource_type) BETWEEN 1 AND 80 AND resource_type ~ '^[a-z][a-z0-9._-]*$'
    AND policy_dsl_version = 1 AND octet_length(checksum) = 32
    AND public.worldgraph_governance_json_is_safe_v1(scope_policy,32768)
  )
);
--> statement-breakpoint
CREATE TABLE public.office_power_delegations (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  office_power_id uuid NOT NULL,
  charter_version_id uuid NOT NULL,
  grantee_organization_entity_id uuid NOT NULL,
  delegation_key text NOT NULL,
  checksum bytea NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_power_delegations_world_identity UNIQUE (world_id,id),
  CONSTRAINT office_power_delegations_power_grantee_unique
    UNIQUE (office_power_id,grantee_organization_entity_id),
  CONSTRAINT office_power_delegations_key_unique
    UNIQUE (office_power_id,delegation_key),
  CONSTRAINT office_power_delegations_power_charter_world_fk
    FOREIGN KEY (world_id,office_power_id,charter_version_id)
    REFERENCES public.office_powers(world_id,id,charter_version_id)
    ON DELETE RESTRICT,
  CONSTRAINT office_power_delegations_charter_world_fk
    FOREIGN KEY (world_id,charter_version_id)
    REFERENCES public.governing_charter_versions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_power_delegations_grantee_world_fk
    FOREIGN KEY (world_id,grantee_organization_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_power_delegations_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT office_power_delegations_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT office_power_delegations_shape_valid CHECK (
    char_length(delegation_key) BETWEEN 3 AND 160
    AND delegation_key ~ '^[a-z][a-z0-9._-]*$'
    AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE INDEX office_power_delegations_grantee_idx
  ON public.office_power_delegations
  (world_id,grantee_organization_entity_id,office_power_id);
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_office_power_delegation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  evidence record;
  expected_checksum bytea;
  open_command_id uuid := NULLIF(
    current_setting('worldgraph.command_id',true),'')::uuid;
BEGIN
  SELECT power.checksum AS office_power_checksum,
         organization.logical_key::text AS organization_key,
         runtime.active_world_version_id,
         EXISTS (
           SELECT 1
           FROM public.governing_charter_versions charter_version
           JOIN public.compiled_governance_seed_plans plan
             ON plan.world_id = charter_version.world_id
            AND plan.world_version_id = charter_version.source_world_version_id
            AND plan.plan_hash = charter_version.seed_plan_hash
           CROSS JOIN LATERAL jsonb_array_elements(
             plan.canonical_plan -> 'offices'
           ) WITH ORDINALITY office_item(value,ordinal)
           CROSS JOIN LATERAL jsonb_array_elements(
             office_item.value -> 'powers'
           ) WITH ORDINALITY power_item(value,ordinal)
           CROSS JOIN LATERAL jsonb_array_elements_text(
             power_item.value -> 'delegatedOrganizationEntityKeys'
           ) WITH ORDINALITY delegated_organization_key(value,ordinal)
           JOIN public.political_offices office
             ON office.world_id = power.world_id
            AND office.id = power.office_id
           WHERE charter_version.world_id = power.world_id
             AND charter_version.id = power.charter_version_id
             AND office_item.value ->> 'stableKey' = office.stable_key::text
             AND power.power_key = replace(office.stable_key::text,':','.')
               || '.power.' || power_item.ordinal::text
             AND power.action_code = power_item.value ->> 'action'
             AND power.resource_type = power_item.value ->> 'resourceType'
             AND power.scope_policy = power_item.value -> 'policy'
             AND organization.logical_key::text = delegated_organization_key.value
             AND NEW.delegation_key = power.power_key || '.delegation.'
               || delegated_organization_key.ordinal::text
             AND power.checksum = extensions.digest(convert_to(
               public.worldgraph_canonical_jsonb(jsonb_build_object(
                 'power',power_item.value,
                 'powerKey',power.power_key
               )),'UTF8'),'sha256')
         ) AS compiled_binding_valid
    INTO evidence
  FROM public.office_powers power
  JOIN public.world_entities organization
    ON organization.world_id = power.world_id
   AND organization.id = NEW.grantee_organization_entity_id
   AND organization.entity_type = 'organization'
   AND organization.retired_world_version_id IS NULL
  JOIN public.world_runtime_heads runtime ON runtime.world_id = power.world_id
  WHERE power.world_id = NEW.world_id
    AND power.id = NEW.office_power_id
    AND power.charter_version_id = NEW.charter_version_id;

  expected_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'charterVersionId',NEW.charter_version_id::text,
      'delegationKey',NEW.delegation_key,
      'granteeOrganizationEntityId',NEW.grantee_organization_entity_id::text,
      'officePowerChecksum',encode(evidence.office_power_checksum,'hex'),
      'officePowerId',NEW.office_power_id::text,
      'worldId',NEW.world_id::text
    )),'UTF8'),'sha256');

  IF evidence.active_world_version_id IS NULL
    OR NOT COALESCE(evidence.compiled_binding_valid,false)
    OR NEW.created_command_id IS DISTINCT FROM open_command_id
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id,open_command_id)
    OR NOT EXISTS (
      SELECT 1 FROM public.command_records command
      WHERE command.id = open_command_id AND command.world_id = NEW.world_id
        AND command.command_type IN (
          'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1'
        )
    )
    OR NEW.checksum IS DISTINCT FROM expected_checksum THEN
    RAISE EXCEPTION 'office power delegation lacks exact charter authority evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'office_power_delegations_exact_authority';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_office_power_delegation_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER office_power_delegations_exact_authority
  BEFORE INSERT ON public.office_power_delegations
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_office_power_delegation_v1();
--> statement-breakpoint
CREATE TABLE public.proposals (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  jurisdiction_entity_id uuid NOT NULL,
  proposer_entity_id uuid NOT NULL,
  proposal_type text NOT NULL,
  proposal_schema_version integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  sponsorship_closes_tick bigint NOT NULL,
  debate_closes_tick bigint NOT NULL,
  voting_opens_tick bigint NOT NULL,
  voting_closes_tick bigint NOT NULL,
  minimum_sponsors integer NOT NULL,
  quorum_numerator integer NOT NULL,
  quorum_denominator integer NOT NULL,
  threshold_numerator integer NOT NULL,
  threshold_denominator integer NOT NULL,
  ballot_mode text NOT NULL,
  ballot_disclosure text NOT NULL,
  allow_ballot_replacement boolean NOT NULL DEFAULT false,
  target_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  aggregate_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposals_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposals_institution_world_fk
    FOREIGN KEY (world_id,institution_id)
    REFERENCES public.institutions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposals_jurisdiction_world_fk
    FOREIGN KEY (world_id,jurisdiction_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposals_proposer_world_fk
    FOREIGN KEY (world_id,proposer_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposals_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT proposals_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proposals_type_valid CHECK (
    proposal_type IN ('ordinary','emergency','appointment','patch_approval')
    AND proposal_schema_version = 1
    AND status IN (
      'draft','sponsoring','debate','scheduled','open','closing','tallied',
      'certified','enacted','rejected','withdrawn','passed_but_enactment_failed'
    )
    AND ballot_mode IN ('public','secret')
    AND ballot_disclosure IN ('aggregate_only','choice_totals','voter_and_choice')
    AND (ballot_mode = 'public' OR ballot_disclosure = 'aggregate_only')
  ),
  CONSTRAINT proposals_text_safe CHECK (
    char_length(btrim(title)) BETWEEN 1 AND 160 AND title = btrim(title)
    AND char_length(btrim(body)) BETWEEN 1 AND 10000 AND body = btrim(body)
    AND translate(title || body,E'\t\n\r','') !~ '[[:cntrl:]]'
  ),
  CONSTRAINT proposals_windows_valid CHECK (
    sponsorship_closes_tick >= 0
    AND debate_closes_tick >= sponsorship_closes_tick
    AND voting_opens_tick >= debate_closes_tick
    AND voting_closes_tick > voting_opens_tick
  ),
  CONSTRAINT proposals_thresholds_valid CHECK (
    minimum_sponsors BETWEEN 0 AND 10000
    AND quorum_denominator = 10000
    AND quorum_numerator BETWEEN 0 AND 10000
    AND threshold_denominator = 10000
    AND threshold_numerator BETWEEN 1 AND 10000
  ),
  CONSTRAINT proposals_targets_safe CHECK (
    public.worldgraph_governance_json_is_safe_v1(target_versions,32768)
  ),
  CONSTRAINT proposals_versions_positive CHECK (
    aggregate_version > 0 AND created_state_revision > 0 AND updated_at >= created_at
  )
);
--> statement-breakpoint
CREATE INDEX proposals_open_window_idx
  ON public.proposals (world_id,status,voting_opens_tick,voting_closes_tick,id);
--> statement-breakpoint
CREATE TABLE public.proposal_actions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  action_ordinal integer NOT NULL,
  action_kind text NOT NULL,
  action_schema_version integer NOT NULL DEFAULT 1,
  target_kind text,
  target_id uuid,
  expected_target_version bigint,
  action_payload jsonb NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum bytea NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_actions_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposal_actions_ordinal_unique UNIQUE (proposal_id,action_ordinal),
  CONSTRAINT proposal_actions_proposal_world_fk
    FOREIGN KEY (world_id,proposal_id)
    REFERENCES public.proposals(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_actions_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT proposal_actions_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proposal_actions_kind_valid CHECK (
    action_ordinal BETWEEN 0 AND 15 AND action_schema_version = 1
    AND action_kind IN (
      'law_create','law_amend','law_repeal','tax_policy_update',
      'public_project_authorization','office_appointment','world_patch_approval'
    )
  ),
  CONSTRAINT proposal_actions_target_shape CHECK (
    (target_kind IS NULL AND target_id IS NULL AND expected_target_version IS NULL)
    OR (
      target_kind IN ('law','tax_policy','public_project','office','world_patch')
      AND target_id IS NOT NULL AND expected_target_version > 0
    )
  ),
  CONSTRAINT proposal_actions_payload_safe CHECK (
    public.worldgraph_governance_json_is_safe_v1(action_payload,65536)
    AND public.worldgraph_governance_json_is_safe_v1(provenance,32768)
    AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.proposal_sponsors (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  sponsor_entity_id uuid NOT NULL,
  sponsored_tick bigint NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_sponsors_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposal_sponsors_member_unique UNIQUE (proposal_id,sponsor_entity_id),
  CONSTRAINT proposal_sponsors_proposal_world_fk
    FOREIGN KEY (world_id,proposal_id)
    REFERENCES public.proposals(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_sponsors_entity_world_fk
    FOREIGN KEY (world_id,sponsor_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_sponsors_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT proposal_sponsors_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proposal_sponsors_tick_valid CHECK (
    sponsored_tick >= 0 AND state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE public.proposal_transitions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  effective_tick bigint NOT NULL,
  aggregate_version bigint NOT NULL,
  reason_code text NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_transitions_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposal_transitions_version_unique UNIQUE (proposal_id,aggregate_version),
  CONSTRAINT proposal_transitions_event_unique UNIQUE (event_id),
  CONSTRAINT proposal_transitions_proposal_world_fk
    FOREIGN KEY (world_id,proposal_id)
    REFERENCES public.proposals(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_transitions_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT proposal_transitions_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proposal_transitions_shape_valid CHECK (
    to_status IN (
      'draft','sponsoring','debate','scheduled','open','closing','tallied',
      'certified','enacted','rejected','withdrawn','passed_but_enactment_failed'
    )
    AND (from_status IS NULL OR from_status IN (
      'draft','sponsoring','debate','scheduled','open','closing','tallied',
      'certified','enacted','rejected','withdrawn','passed_but_enactment_failed'
    ))
    AND effective_tick >= 0 AND aggregate_version > 0 AND state_revision > 0
    AND char_length(reason_code) BETWEEN 3 AND 120
    AND reason_code ~ '^[A-Z][A-Z0-9_]*$'
    AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.elections (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  office_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  election_kind text NOT NULL,
  status text NOT NULL DEFAULT 'nominations_scheduled',
  nomination_opens_tick bigint NOT NULL,
  nomination_closes_tick bigint NOT NULL,
  voting_opens_tick bigint NOT NULL,
  voting_closes_tick bigint NOT NULL,
  certification_tick bigint NOT NULL,
  term_starts_tick bigint NOT NULL,
  quorum_numerator integer NOT NULL,
  quorum_denominator integer NOT NULL,
  tie_rule text NOT NULL,
  ballot_mode text NOT NULL,
  ballot_disclosure text NOT NULL,
  allow_ballot_replacement boolean NOT NULL DEFAULT false,
  election_rule_snapshot jsonb NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT elections_world_identity UNIQUE (world_id,id),
  CONSTRAINT elections_world_office_seat_identity
    UNIQUE (world_id,id,office_id,seat_id),
  CONSTRAINT elections_seat_start_unique UNIQUE (seat_id,term_starts_tick),
  CONSTRAINT elections_institution_world_fk
    FOREIGN KEY (world_id,institution_id)
    REFERENCES public.institutions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT elections_office_world_fk
    FOREIGN KEY (world_id,office_id)
    REFERENCES public.political_offices(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT elections_seat_office_world_fk
    FOREIGN KEY (world_id,seat_id,office_id)
    REFERENCES public.political_office_seats(world_id,id,office_id) ON DELETE RESTRICT,
  CONSTRAINT elections_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT elections_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT elections_shape_valid CHECK (
    election_kind IN ('regular','special')
    AND status IN (
      'nominations_scheduled','nominations_open','voting_scheduled','open',
      'closing','tallied','certified','cancelled'
    )
    AND ballot_mode IN ('public','secret')
    AND ballot_disclosure IN ('aggregate_only','choice_totals','voter_and_choice')
    AND (ballot_mode = 'public' OR ballot_disclosure = 'aggregate_only')
    AND quorum_denominator = 10000 AND quorum_numerator BETWEEN 0 AND 10000
    AND tie_rule IN ('vacancy','stable_key')
    AND aggregate_version > 0 AND created_state_revision > 0
    AND updated_at >= created_at
  ),
  CONSTRAINT elections_windows_valid CHECK (
    nomination_opens_tick >= 0
    AND nomination_closes_tick > nomination_opens_tick
    AND voting_opens_tick >= nomination_closes_tick
    AND voting_closes_tick > voting_opens_tick
    AND certification_tick >= voting_closes_tick
    AND term_starts_tick >= certification_tick
  ),
  CONSTRAINT elections_rules_safe CHECK (
    public.worldgraph_governance_json_is_safe_v1(election_rule_snapshot,65536)
  )
);
--> statement-breakpoint
CREATE INDEX elections_due_idx
  ON public.elections (world_id,status,voting_opens_tick,voting_closes_tick,certification_tick,id);
--> statement-breakpoint
CREATE TABLE public.governance_contests (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id) ON DELETE RESTRICT,
  contest_kind text NOT NULL,
  ballot_mode text NOT NULL,
  ballot_disclosure text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  opens_tick bigint NOT NULL,
  closes_tick bigint NOT NULL,
  allow_replacement boolean NOT NULL DEFAULT false,
  aggregate_version bigint NOT NULL DEFAULT 1,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_contests_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_contests_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT governance_contests_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governance_contests_shape_valid CHECK (
    contest_kind IN ('proposal','election')
    AND ballot_mode IN ('public','secret')
    AND ballot_disclosure IN ('aggregate_only','choice_totals','voter_and_choice')
    AND (ballot_mode = 'public' OR ballot_disclosure = 'aggregate_only')
    AND status IN ('scheduled','open','closing','tallied','certified','cancelled')
    AND opens_tick >= 0 AND closes_tick > opens_tick
    AND aggregate_version > 0 AND created_state_revision > 0
    AND updated_at >= created_at
  )
);
--> statement-breakpoint
CREATE INDEX governance_contests_window_idx
  ON public.governance_contests (world_id,status,opens_tick,closes_tick,id);
--> statement-breakpoint
CREATE TABLE public.proposal_contests (
  contest_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  proposal_id uuid NOT NULL UNIQUE,
  question text NOT NULL,
  CONSTRAINT proposal_contests_world_identity UNIQUE (world_id,contest_id),
  CONSTRAINT proposal_contests_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_contests_proposal_world_fk
    FOREIGN KEY (world_id,proposal_id)
    REFERENCES public.proposals(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_contests_question_valid CHECK (
    char_length(btrim(question)) BETWEEN 1 AND 500 AND question = btrim(question)
    AND translate(question,E'\t\n\r','') !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE TABLE public.election_contests (
  contest_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  election_id uuid NOT NULL,
  office_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  contest_ordinal integer NOT NULL,
  seats_to_fill integer NOT NULL DEFAULT 1,
  CONSTRAINT election_contests_world_identity UNIQUE (world_id,contest_id),
  CONSTRAINT election_contests_election_unique UNIQUE (election_id),
  CONSTRAINT election_contests_ordinal_unique UNIQUE (election_id,contest_ordinal),
  CONSTRAINT election_contests_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_contests_election_world_fk
    FOREIGN KEY (world_id,election_id)
    REFERENCES public.elections(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_contests_election_seat_world_fk
    FOREIGN KEY (world_id,election_id,office_id,seat_id)
    REFERENCES public.elections(world_id,id,office_id,seat_id) ON DELETE RESTRICT,
  CONSTRAINT election_contests_office_world_fk
    FOREIGN KEY (world_id,office_id)
    REFERENCES public.political_offices(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_contests_seat_world_fk
    FOREIGN KEY (world_id,seat_id)
    REFERENCES public.political_office_seats(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_contests_shape_valid CHECK (
    contest_ordinal = 1 AND seats_to_fill = 1
  )
);
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_governance_scheduled_target_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_type_value text;
  target_valid boolean := false;
BEGIN
  IF NEW.action_type NOT IN (
    'OpenProposalVotingV1','CloseAndTallyProposalV1',
    'CertifyAndEnactProposalV1','OpenElectionV1',
    'CloseAndTallyElectionV1','CertifyElectionV1'
  ) THEN RETURN NULL; END IF;
  SELECT command.command_type INTO command_type_value
  FROM public.command_records command
  WHERE command.world_id=NEW.world_id AND command.id=NEW.created_command_id;
  IF NOT public.worldgraph_schedule_pair_is_valid_v2(
      command_type_value,NEW.action_type
    ) THEN
    RAISE EXCEPTION 'governance scheduled action is outside its command pair'
      USING ERRCODE='55000';
  END IF;
  IF NEW.action_type IN (
      'OpenProposalVotingV1','CloseAndTallyProposalV1',
      'CertifyAndEnactProposalV1'
    ) THEN
    SELECT EXISTS (
      SELECT 1 FROM public.proposals proposal
      WHERE proposal.world_id=NEW.world_id
        AND proposal.id::text=NEW.payload ->> 'proposalId'
        AND NEW.due_tick=CASE NEW.action_type
          WHEN 'OpenProposalVotingV1' THEN proposal.voting_opens_tick
          ELSE proposal.voting_closes_tick END
    ) INTO target_valid;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.elections election
      WHERE election.world_id=NEW.world_id
        AND election.id::text=NEW.payload ->> 'electionId'
        AND NEW.due_tick=CASE NEW.action_type
          WHEN 'OpenElectionV1' THEN election.voting_opens_tick
          WHEN 'CloseAndTallyElectionV1' THEN election.voting_closes_tick
          ELSE election.certification_tick END
    ) INTO target_valid;
  END IF;
  IF NOT target_valid THEN
    RAISE EXCEPTION 'governance scheduled action target or due tick is not exact'
      USING ERRCODE='23514',
        CONSTRAINT='governance_scheduled_action_target_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_governance_scheduled_target_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER scheduled_actions_governance_target_exact
  AFTER INSERT ON public.scheduled_actions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_governance_scheduled_target_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_successor_election_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  evidence_valid boolean := false;
  command_type_value text;
BEGIN
  SELECT command.command_type INTO command_type_value
  FROM public.command_records command
  WHERE command.world_id=NEW.world_id AND command.id=NEW.created_command_id;
  IF command_type_value NOT IN ('OpenElectionV1','CertifyElectionV1') THEN
    RETURN NULL;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.command_records command
    JOIN public.elections prior
      ON prior.world_id=command.world_id
     AND prior.id::text=command.payload ->> 'electionId'
    JOIN public.domain_events event
      ON event.world_id=command.world_id
     AND event.id=NEW.created_event_id
     AND event.command_id=command.id
    WHERE command.world_id=NEW.world_id
      AND command.id=NEW.created_command_id
      AND command.command_type IN ('OpenElectionV1','CertifyElectionV1')
      AND command.status='accepted'::command_record_status
      AND command.expected_tick IS NOT NULL
      AND command.resulting_state_revision=NEW.created_state_revision
      AND event.resulting_state_revision=NEW.created_state_revision
      AND prior.status=CASE command.command_type
        WHEN 'OpenElectionV1' THEN 'cancelled' ELSE 'certified' END
      AND prior.election_rule_snapshot ->> 'electionCadenceTicks'
        ~ '^[1-9][0-9]{0,18}$'
      AND NEW.id<>prior.id
      AND NEW.institution_id=prior.institution_id
      AND NEW.office_id=prior.office_id
      AND NEW.seat_id=prior.seat_id
      AND NEW.election_kind=prior.election_kind
      AND NEW.quorum_numerator=prior.quorum_numerator
      AND NEW.quorum_denominator=prior.quorum_denominator
      AND NEW.tie_rule=prior.tie_rule
      AND NEW.ballot_mode=prior.ballot_mode
      AND NEW.ballot_disclosure=prior.ballot_disclosure
      AND NEW.allow_ballot_replacement=prior.allow_ballot_replacement
      AND NEW.election_rule_snapshot=prior.election_rule_snapshot
      AND NEW.aggregate_version=1
      AND NEW.nomination_opens_tick=prior.nomination_opens_tick
        +(prior.election_rule_snapshot ->> 'electionCadenceTicks')::bigint
      AND NEW.nomination_closes_tick=prior.nomination_closes_tick
        +(prior.election_rule_snapshot ->> 'electionCadenceTicks')::bigint
      AND NEW.voting_opens_tick=prior.voting_opens_tick
        +(prior.election_rule_snapshot ->> 'electionCadenceTicks')::bigint
      AND NEW.voting_closes_tick=prior.voting_closes_tick
        +(prior.election_rule_snapshot ->> 'electionCadenceTicks')::bigint
      AND NEW.certification_tick=prior.certification_tick
        +(prior.election_rule_snapshot ->> 'electionCadenceTicks')::bigint
      AND NEW.term_starts_tick=prior.term_starts_tick
        +(prior.election_rule_snapshot ->> 'electionCadenceTicks')::bigint
      AND NEW.status=CASE
        WHEN NEW.nomination_opens_tick<=command.expected_tick
          THEN 'nominations_open' ELSE 'nominations_scheduled' END
      AND NOT EXISTS (
        SELECT 1 FROM public.elections sibling
        WHERE sibling.world_id=NEW.world_id
          AND sibling.created_command_id=NEW.created_command_id
          AND sibling.id<>NEW.id
      )
      AND EXISTS (
        SELECT 1 FROM public.aggregate_stream_heads head
        WHERE head.world_id=NEW.world_id AND head.aggregate_type='election'
          AND head.aggregate_id=NEW.id::text AND head.current_version=1
      )
      AND EXISTS (
        SELECT 1
        FROM public.election_contests link
        JOIN public.governance_contests contest
          ON contest.world_id=link.world_id AND contest.id=link.contest_id
        WHERE link.world_id=NEW.world_id AND link.election_id=NEW.id
          AND link.office_id=NEW.office_id AND link.seat_id=NEW.seat_id
          AND link.contest_ordinal=1 AND link.seats_to_fill=1
          AND contest.contest_kind='election'
          AND contest.ballot_mode=NEW.ballot_mode
          AND contest.ballot_disclosure=NEW.ballot_disclosure
          AND contest.status='scheduled'
          AND contest.opens_tick=NEW.voting_opens_tick
          AND contest.closes_tick=NEW.voting_closes_tick
          AND contest.allow_replacement=NEW.allow_ballot_replacement
          AND contest.aggregate_version=1
          AND contest.created_command_id=NEW.created_command_id
          AND contest.created_event_id=NEW.created_event_id
          AND contest.created_state_revision=NEW.created_state_revision
      )
      AND (
        SELECT count(*)=3
          AND count(*) FILTER (
            WHERE action.action_type='OpenElectionV1'
              AND action.due_tick=NEW.voting_opens_tick
          )=1
          AND count(*) FILTER (
            WHERE action.action_type='CloseAndTallyElectionV1'
              AND action.due_tick=NEW.voting_closes_tick
          )=1
          AND count(*) FILTER (
            WHERE action.action_type='CertifyElectionV1'
              AND action.due_tick=NEW.certification_tick
          )=1
        FROM public.scheduled_actions action
        WHERE action.world_id=NEW.world_id
          AND action.created_command_id=NEW.created_command_id
          AND action.created_state_revision=NEW.created_state_revision
          AND action.status='scheduled'::scheduled_action_status
          AND action.payload=jsonb_build_object('electionId',NEW.id::text)
      )
  ) INTO evidence_valid;
  IF NOT evidence_valid THEN
    RAISE EXCEPTION 'successor election lacks exact cadence, contest, stream, or schedules'
      USING ERRCODE='23514',
        CONSTRAINT='successor_election_exact';
  END IF;
  RETURN NULL;
EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE EXCEPTION 'successor election cadence exceeds the supported tick range'
    USING ERRCODE='22003',CONSTRAINT='successor_election_exact';
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_successor_election_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER elections_successor_exact
  AFTER INSERT ON public.elections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.created_command_id IS NOT NULL)
  EXECUTE FUNCTION public.worldgraph_assert_successor_election_v1();
--> statement-breakpoint
CREATE TABLE public.candidacies (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  election_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  candidate_entity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'nominated',
  nomination_tick bigint NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1,
  nominated_command_id uuid NOT NULL,
  nominated_event_id uuid NOT NULL,
  accepted_command_id uuid,
  accepted_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidacies_world_identity UNIQUE (world_id,id),
  CONSTRAINT candidacies_candidate_unique UNIQUE (contest_id,candidate_entity_id),
  CONSTRAINT candidacies_election_world_fk
    FOREIGN KEY (world_id,election_id)
    REFERENCES public.elections(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT candidacies_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.election_contests(world_id,contest_id) ON DELETE RESTRICT,
  CONSTRAINT candidacies_candidate_world_fk
    FOREIGN KEY (world_id,candidate_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT candidacies_nomination_command_world_fk
    FOREIGN KEY (nominated_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT candidacies_nomination_event_world_fk
    FOREIGN KEY (world_id,nominated_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT candidacies_acceptance_command_world_fk
    FOREIGN KEY (accepted_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT candidacies_acceptance_event_world_fk
    FOREIGN KEY (world_id,accepted_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT candidacies_shape_valid CHECK (
    status IN ('nominated','accepted','withdrawn','ineligible')
    AND nomination_tick >= 0 AND aggregate_version > 0
    AND ((status = 'accepted' AND accepted_command_id IS NOT NULL AND accepted_event_id IS NOT NULL)
      OR (status <> 'accepted'))
    AND updated_at >= created_at
  )
);
--> statement-breakpoint
CREATE TABLE public.candidacy_transitions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  candidacy_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  effective_tick bigint NOT NULL,
  aggregate_version bigint NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidacy_transitions_world_identity UNIQUE (world_id,id),
  CONSTRAINT candidacy_transitions_version_unique UNIQUE (candidacy_id,aggregate_version),
  CONSTRAINT candidacy_transitions_candidacy_world_fk
    FOREIGN KEY (world_id,candidacy_id)
    REFERENCES public.candidacies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT candidacy_transitions_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT candidacy_transitions_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT candidacy_transitions_shape_valid CHECK (
    to_status IN ('nominated','accepted','withdrawn','ineligible')
    AND (from_status IS NULL OR from_status IN ('nominated','accepted','withdrawn','ineligible'))
    AND effective_tick >= 0 AND aggregate_version > 0 AND state_revision > 0
    AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_guard_governance_projection_update_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  open_command_id uuid := NULLIF(
    current_setting('worldgraph.command_id',true),'')::uuid;
  open_command_type text;
  immutable_old jsonb;
  immutable_new jsonb;
  transition_valid boolean := false;
BEGIN
  SELECT command.command_type INTO open_command_type
  FROM public.command_records command
  WHERE command.id=open_command_id AND command.world_id=NEW.world_id
    AND public.worldgraph_command_write_is_open(command.world_id,command.id);
  IF open_command_type IS NULL THEN
    RAISE EXCEPTION '% update requires an open governance command',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'world_governance_heads' THEN
      immutable_old := to_jsonb(OLD)-ARRAY[
        'checksum','row_version','updated_state_revision','updated_at'
      ]::text[];
      immutable_new := to_jsonb(NEW)-ARRAY[
        'checksum','row_version','updated_state_revision','updated_at'
      ]::text[];
      transition_valid := immutable_new=immutable_old
        AND octet_length(NEW.checksum)=32
        AND NEW.updated_at >= OLD.updated_at
        AND (
          (OLD.initialized_command_id=open_command_id
            AND NEW.row_version=OLD.row_version
            AND NEW.updated_state_revision=OLD.updated_state_revision)
          OR (OLD.initialized_command_id<>open_command_id
            AND NEW.row_version=OLD.row_version+1
            AND NEW.updated_state_revision>OLD.updated_state_revision)
        );
    WHEN 'political_offices' THEN
      immutable_old := to_jsonb(OLD)-ARRAY['row_version','updated_at']::text[];
      immutable_new := to_jsonb(NEW)-ARRAY['row_version','updated_at']::text[];
      transition_valid := immutable_new=immutable_old
        AND NEW.row_version=OLD.row_version+1
        AND NEW.updated_at >= OLD.updated_at
        AND open_command_type IN (
          'AppointOfficeholderV1','CertifyElectionV1',
          'CertifyAndEnactProposalV1','ExecuteCreatorOverrideV1',
          'RepairGovernanceResultV1'
        );
    WHEN 'proposals' THEN
      immutable_old := to_jsonb(OLD)-ARRAY[
        'status','aggregate_version','updated_at'
      ]::text[];
      immutable_new := to_jsonb(NEW)-ARRAY[
        'status','aggregate_version','updated_at'
      ]::text[];
      transition_valid := immutable_new=immutable_old
        AND NEW.aggregate_version=OLD.aggregate_version+1
        AND NEW.updated_at >= OLD.updated_at
        AND (
          (open_command_type='SponsorProposalV1'
            AND OLD.status IN ('draft','sponsoring')
            AND NEW.status IN ('sponsoring','debate'))
          OR (open_command_type='WithdrawProposalV1'
            AND OLD.status IN ('draft','sponsoring','debate','scheduled')
            AND NEW.status='withdrawn')
          OR (open_command_type='OpenProposalVotingV1'
            AND OLD.status IN ('scheduled','debate')
            AND NEW.status IN ('open','rejected'))
          OR (open_command_type='CloseAndTallyProposalV1'
            AND OLD.status='open' AND NEW.status='tallied')
          OR (open_command_type='CertifyAndEnactProposalV1'
            AND OLD.status='tallied'
            AND NEW.status IN ('enacted','rejected','passed_but_enactment_failed'))
          OR (open_command_type='RepairGovernanceResultV1'
            AND OLD.status='passed_but_enactment_failed' AND NEW.status='enacted')
        );
    WHEN 'elections' THEN
      immutable_old := to_jsonb(OLD)-ARRAY[
        'status','aggregate_version','updated_at'
      ]::text[];
      immutable_new := to_jsonb(NEW)-ARRAY[
        'status','aggregate_version','updated_at'
      ]::text[];
      transition_valid := immutable_new=immutable_old
        AND NEW.aggregate_version=OLD.aggregate_version+1
        AND NEW.updated_at >= OLD.updated_at
        AND (
          (open_command_type='OpenElectionV1'
            AND OLD.status IN (
              'nominations_scheduled','nominations_open','voting_scheduled'
            ) AND NEW.status IN ('open','cancelled'))
          OR (open_command_type='CloseAndTallyElectionV1'
            AND OLD.status='open' AND NEW.status='tallied')
          OR (open_command_type='CertifyElectionV1'
            AND OLD.status='tallied' AND NEW.status='certified')
        );
    WHEN 'governance_contests' THEN
      immutable_old := to_jsonb(OLD)-ARRAY[
        'status','aggregate_version','updated_at'
      ]::text[];
      immutable_new := to_jsonb(NEW)-ARRAY[
        'status','aggregate_version','updated_at'
      ]::text[];
      transition_valid := immutable_new=immutable_old
        AND NEW.aggregate_version>OLD.aggregate_version
        AND NEW.updated_at >= OLD.updated_at
        AND (
          (open_command_type IN ('OpenProposalVotingV1','OpenElectionV1')
            AND OLD.status='scheduled' AND NEW.status IN ('open','cancelled'))
          OR (open_command_type IN (
              'CloseAndTallyProposalV1','CloseAndTallyElectionV1'
            ) AND OLD.status='open' AND NEW.status='tallied')
          OR (open_command_type IN (
              'CertifyAndEnactProposalV1','CertifyElectionV1'
            ) AND OLD.status='tallied' AND NEW.status='certified')
        )
        AND (
          (NEW.contest_kind='proposal' AND EXISTS (
            SELECT 1 FROM public.proposal_contests link
            JOIN public.proposals proposal
              ON proposal.world_id=link.world_id AND proposal.id=link.proposal_id
            WHERE link.world_id=NEW.world_id AND link.contest_id=NEW.id
              AND proposal.aggregate_version=NEW.aggregate_version
              AND (
                (NEW.status='open' AND proposal.status='open')
                OR (NEW.status='tallied' AND proposal.status='tallied')
                OR (NEW.status='cancelled' AND proposal.status='rejected')
                OR (NEW.status='certified' AND proposal.status IN (
                  'enacted','rejected','passed_but_enactment_failed'
                ))
              )
          ))
          OR (NEW.contest_kind='election' AND EXISTS (
            SELECT 1 FROM public.election_contests link
            JOIN public.elections election
              ON election.world_id=link.world_id AND election.id=link.election_id
            WHERE link.world_id=NEW.world_id AND link.contest_id=NEW.id
              AND election.aggregate_version=NEW.aggregate_version
              AND election.status=NEW.status
          ))
        );
    WHEN 'candidacies' THEN
      immutable_old := to_jsonb(OLD)-ARRAY[
        'status','aggregate_version','accepted_command_id','accepted_event_id','updated_at'
      ]::text[];
      immutable_new := to_jsonb(NEW)-ARRAY[
        'status','aggregate_version','accepted_command_id','accepted_event_id','updated_at'
      ]::text[];
      transition_valid := immutable_new=immutable_old
        AND open_command_type='AcceptNominationV1'
        AND OLD.status='nominated' AND NEW.status='accepted'
        AND NEW.aggregate_version=OLD.aggregate_version+1
        AND OLD.accepted_command_id IS NULL AND OLD.accepted_event_id IS NULL
        AND NEW.accepted_command_id=open_command_id
        AND NEW.accepted_event_id IS NOT NULL
        AND NEW.updated_at >= OLD.updated_at;
    ELSE
      transition_valid := false;
  END CASE;
  IF NOT transition_valid THEN
    RAISE EXCEPTION '% projection transition is invalid',TG_TABLE_NAME
      USING ERRCODE = '55000',
        CONSTRAINT = 'governance_projection_transition_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_guard_governance_projection_update_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER world_governance_heads_update_guard
  BEFORE UPDATE ON public.world_governance_heads
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_projection_update_v1();
--> statement-breakpoint
CREATE TRIGGER political_offices_update_guard
  BEFORE UPDATE ON public.political_offices
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_projection_update_v1();
--> statement-breakpoint
CREATE TRIGGER proposals_update_guard
  BEFORE UPDATE ON public.proposals
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_projection_update_v1();
--> statement-breakpoint
CREATE TRIGGER elections_update_guard
  BEFORE UPDATE ON public.elections
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_projection_update_v1();
--> statement-breakpoint
CREATE TRIGGER governance_contests_update_guard
  BEFORE UPDATE ON public.governance_contests
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_projection_update_v1();
--> statement-breakpoint
CREATE TRIGGER candidacies_update_guard
  BEFORE UPDATE ON public.candidacies
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_projection_update_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_governance_projection_transition_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  evidence_valid boolean := false;
BEGIN
  IF TG_TABLE_NAME='proposals' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.proposal_transitions transition
      JOIN public.command_records command
        ON command.world_id=transition.world_id AND command.id=transition.command_id
      WHERE transition.world_id=NEW.world_id
        AND transition.proposal_id=NEW.id
        AND transition.from_status=OLD.status
        AND transition.to_status=NEW.status
        AND transition.aggregate_version=NEW.aggregate_version
        AND transition.command_id=NULLIF(
          current_setting('worldgraph.command_id',true),'')::uuid
        AND transition.effective_tick=command.expected_tick
    ) INTO evidence_valid;
  ELSIF TG_TABLE_NAME='candidacies' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.candidacy_transitions transition
      JOIN public.command_records command
        ON command.world_id=transition.world_id AND command.id=transition.command_id
      WHERE transition.world_id=NEW.world_id
        AND transition.candidacy_id=NEW.id
        AND transition.from_status=OLD.status
        AND transition.to_status=NEW.status
        AND transition.aggregate_version=NEW.aggregate_version
        AND transition.command_id=NEW.accepted_command_id
        AND transition.event_id=NEW.accepted_event_id
        AND transition.effective_tick=command.expected_tick
    ) INTO evidence_valid;
  END IF;
  IF NOT evidence_valid THEN
    RAISE EXCEPTION '% projection lacks exact transition evidence',TG_TABLE_NAME
      USING ERRCODE = '55000',
        CONSTRAINT = 'governance_projection_transition_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_governance_projection_transition_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER proposals_transition_exact
  AFTER UPDATE ON public.proposals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_governance_projection_transition_v1();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER candidacies_transition_exact
  AFTER UPDATE ON public.candidacies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_governance_projection_transition_v1();
--> statement-breakpoint
CREATE TABLE public.eligibility_snapshots (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL UNIQUE,
  rule_schema_version integer NOT NULL DEFAULT 1,
  policy_dsl_version integer NOT NULL DEFAULT 1,
  snapshot_tick bigint NOT NULL,
  source_state_revision bigint NOT NULL,
  source_membership_cursor bigint NOT NULL,
  eligible_count integer NOT NULL,
  rule_snapshot jsonb NOT NULL,
  checksum bytea NOT NULL,
  generated_command_id uuid NOT NULL,
  generated_event_id uuid NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eligibility_snapshots_world_identity UNIQUE (world_id,id),
  CONSTRAINT eligibility_snapshots_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT eligibility_snapshots_command_world_fk
    FOREIGN KEY (generated_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT eligibility_snapshots_event_world_fk
    FOREIGN KEY (world_id,generated_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT eligibility_snapshots_shape_valid CHECK (
    rule_schema_version = 1 AND policy_dsl_version = 1
    AND snapshot_tick >= 0 AND source_state_revision > 0
    AND source_membership_cursor >= 0 AND eligible_count BETWEEN 0 AND 1000000
    AND public.worldgraph_governance_json_is_safe_v1(rule_snapshot,65536)
    AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.eligibility_snapshot_members (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  voter_entity_id uuid NOT NULL,
  voting_weight integer NOT NULL DEFAULT 1,
  eligibility_basis jsonb NOT NULL,
  member_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eligibility_snapshot_members_world_identity UNIQUE (world_id,id),
  CONSTRAINT eligibility_snapshot_members_voter_unique UNIQUE (snapshot_id,voter_entity_id),
  CONSTRAINT eligibility_snapshot_members_snapshot_world_fk
    FOREIGN KEY (world_id,snapshot_id)
    REFERENCES public.eligibility_snapshots(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT eligibility_snapshot_members_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT eligibility_snapshot_members_voter_world_fk
    FOREIGN KEY (world_id,voter_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT eligibility_snapshot_members_shape_valid CHECK (
    voting_weight = 1
    AND public.worldgraph_governance_json_is_safe_v1(eligibility_basis,16384)
    AND octet_length(member_hash) = 32
  )
);
--> statement-breakpoint
CREATE INDEX eligibility_snapshot_members_voter_idx
  ON public.eligibility_snapshot_members (world_id,voter_entity_id,contest_id,snapshot_id);
--> statement-breakpoint
CREATE TABLE public.ballot_participation (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  eligibility_snapshot_id uuid NOT NULL,
  voter_entity_id uuid NOT NULL,
  ballot_mode text NOT NULL,
  current_revision integer NOT NULL,
  aggregate_version bigint NOT NULL,
  first_cast_tick bigint NOT NULL,
  last_cast_tick bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ballot_participation_world_identity UNIQUE (world_id,id),
  CONSTRAINT ballot_participation_voter_unique UNIQUE (contest_id,voter_entity_id),
  CONSTRAINT ballot_participation_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_participation_snapshot_world_fk
    FOREIGN KEY (world_id,eligibility_snapshot_id)
    REFERENCES public.eligibility_snapshots(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_participation_voter_world_fk
    FOREIGN KEY (world_id,voter_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_participation_shape_valid CHECK (
    ballot_mode IN ('public','secret')
    AND current_revision BETWEEN 1 AND 1000 AND aggregate_version > 0
    AND first_cast_tick >= 0 AND last_cast_tick >= first_cast_tick
    AND updated_at >= created_at
  )
);
--> statement-breakpoint
CREATE INDEX ballot_participation_voter_view_idx
  ON public.ballot_participation (world_id,voter_entity_id,updated_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE public.ballot_receipts (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  participation_id uuid NOT NULL,
  revision integer NOT NULL,
  receipt_hash bytea NOT NULL,
  choice_hash bytea NOT NULL,
  cast_tick bigint NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ballot_receipts_world_identity UNIQUE (world_id,id),
  CONSTRAINT ballot_receipts_revision_unique UNIQUE (participation_id,revision),
  CONSTRAINT ballot_receipts_hash_unique UNIQUE (contest_id,receipt_hash),
  CONSTRAINT ballot_receipts_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_receipts_participation_world_fk
    FOREIGN KEY (world_id,participation_id)
    REFERENCES public.ballot_participation(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_receipts_shape_valid CHECK (
    revision BETWEEN 1 AND 1000 AND cast_tick >= 0
    AND octet_length(receipt_hash) = 32 AND octet_length(choice_hash) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.ballot_choice_revisions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  participation_id uuid NOT NULL,
  receipt_id uuid NOT NULL UNIQUE,
  revision integer NOT NULL,
  storage_mode text NOT NULL,
  choice_schema_version integer NOT NULL DEFAULT 1,
  choice_hash bytea NOT NULL,
  replaces_revision_id uuid,
  cast_command_id uuid NOT NULL,
  cast_event_id uuid NOT NULL,
  cast_state_revision bigint NOT NULL,
  cast_tick bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ballot_choice_revisions_world_identity UNIQUE (world_id,id),
  CONSTRAINT ballot_choice_revisions_number_unique UNIQUE (participation_id,revision),
  CONSTRAINT ballot_choice_revisions_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_choice_revisions_participation_world_fk
    FOREIGN KEY (world_id,participation_id)
    REFERENCES public.ballot_participation(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_choice_revisions_receipt_world_fk
    FOREIGN KEY (world_id,receipt_id)
    REFERENCES public.ballot_receipts(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_choice_revisions_replaced_world_fk
    FOREIGN KEY (world_id,replaces_revision_id)
    REFERENCES public.ballot_choice_revisions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_choice_revisions_command_world_fk
    FOREIGN KEY (cast_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT ballot_choice_revisions_event_world_fk
    FOREIGN KEY (world_id,cast_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ballot_choice_revisions_shape_valid CHECK (
    storage_mode IN ('public','secret') AND choice_schema_version = 1
    AND revision BETWEEN 1 AND 1000 AND cast_state_revision > 0 AND cast_tick >= 0
    AND octet_length(choice_hash) = 32
    AND ((revision = 1 AND replaces_revision_id IS NULL)
      OR (revision > 1 AND replaces_revision_id IS NOT NULL))
  )
);
--> statement-breakpoint
CREATE TABLE public.ballot_effective_revisions (
  participation_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  choice_revision_id uuid NOT NULL UNIQUE,
  effective_revision integer NOT NULL,
  row_version bigint NOT NULL,
  updated_command_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ballot_effective_revisions_world_identity UNIQUE (world_id,participation_id),
  CONSTRAINT ballot_effective_revisions_participation_world_fk
    FOREIGN KEY (world_id,participation_id)
    REFERENCES public.ballot_participation(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_effective_revisions_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_effective_revisions_choice_world_fk
    FOREIGN KEY (world_id,choice_revision_id)
    REFERENCES public.ballot_choice_revisions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT ballot_effective_revisions_command_world_fk
    FOREIGN KEY (updated_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT ballot_effective_revisions_versions_positive CHECK (
    effective_revision BETWEEN 1 AND 1000 AND row_version > 0
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX ballot_one_effective_revision_per_voter_idx
  ON public.ballot_effective_revisions (world_id,contest_id,participation_id);
--> statement-breakpoint
CREATE TABLE public.public_ballot_choices (
  choice_revision_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  participation_id uuid NOT NULL,
  voter_entity_id uuid NOT NULL,
  choice_payload jsonb NOT NULL,
  choice_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_ballot_choices_world_identity UNIQUE (world_id,choice_revision_id),
  CONSTRAINT public_ballot_choices_revision_world_fk
    FOREIGN KEY (world_id,choice_revision_id)
    REFERENCES public.ballot_choice_revisions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT public_ballot_choices_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT public_ballot_choices_participation_world_fk
    FOREIGN KEY (world_id,participation_id)
    REFERENCES public.ballot_participation(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT public_ballot_choices_voter_world_fk
    FOREIGN KEY (world_id,voter_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT public_ballot_choices_payload_valid CHECK (
    public.worldgraph_governance_json_is_safe_v1(choice_payload,8192)
    AND octet_length(choice_hash) = 32
    AND choice_hash = extensions.digest(
      convert_to(public.worldgraph_canonical_jsonb(choice_payload),'UTF8'),'sha256'
    )
  )
);
--> statement-breakpoint
CREATE TABLE public.secret_ballot_choices (
  choice_revision_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  participation_id uuid NOT NULL,
  choice_payload jsonb NOT NULL,
  choice_hash bytea NOT NULL,
  linkage_nonce_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT secret_ballot_choices_world_identity UNIQUE (world_id,choice_revision_id),
  CONSTRAINT secret_ballot_choices_revision_world_fk
    FOREIGN KEY (world_id,choice_revision_id)
    REFERENCES public.ballot_choice_revisions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT secret_ballot_choices_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.governance_contests(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT secret_ballot_choices_participation_world_fk
    FOREIGN KEY (world_id,participation_id)
    REFERENCES public.ballot_participation(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT secret_ballot_choices_payload_valid CHECK (
    public.worldgraph_governance_json_is_safe_v1(choice_payload,8192)
    AND octet_length(choice_hash) = 32 AND octet_length(linkage_nonce_hash) = 32
    AND choice_hash = extensions.digest(
      convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
        'domain','worldgraph.governance.secret-ballot-choice-hash.v1',
        'value',jsonb_build_object(
          'choicePayload',choice_payload,
          'choiceRevisionId',choice_revision_id::text
        )
      )),'UTF8'),'sha256'
    )
  )
);
--> statement-breakpoint
REVOKE ALL ON public.ballot_choice_revisions,
  public.ballot_effective_revisions, public.secret_ballot_choices FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE public.proposal_tallies (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  eligibility_snapshot_id uuid NOT NULL,
  tally_version integer NOT NULL,
  algorithm_version text NOT NULL,
  eligible_count integer NOT NULL,
  participating_count integer NOT NULL,
  quorum_required integer NOT NULL,
  approval_required integer NOT NULL,
  input_checksum bytea NOT NULL,
  output_checksum bytea NOT NULL,
  recount_of_tally_id uuid,
  tallied_tick bigint NOT NULL,
  tallied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_tallies_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposal_tallies_version_unique UNIQUE (contest_id,tally_version),
  CONSTRAINT proposal_tallies_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.proposal_contests(world_id,contest_id) ON DELETE RESTRICT,
  CONSTRAINT proposal_tallies_proposal_world_fk
    FOREIGN KEY (world_id,proposal_id)
    REFERENCES public.proposals(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_tallies_snapshot_world_fk
    FOREIGN KEY (world_id,eligibility_snapshot_id)
    REFERENCES public.eligibility_snapshots(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_tallies_recount_world_fk
    FOREIGN KEY (world_id,recount_of_tally_id)
    REFERENCES public.proposal_tallies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_tallies_shape_valid CHECK (
    tally_version BETWEEN 1 AND 1000 AND algorithm_version = 'proposal_yes_no_v1'
    AND eligible_count BETWEEN 0 AND 1000000
    AND participating_count BETWEEN 0 AND eligible_count
    AND quorum_required BETWEEN 0 AND eligible_count
    AND approval_required BETWEEN 0 AND participating_count
    AND octet_length(input_checksum) = 32 AND octet_length(output_checksum) = 32
    AND tallied_tick >= 0
  )
);
--> statement-breakpoint
CREATE TABLE public.proposal_tally_counts (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  tally_id uuid NOT NULL,
  choice_code text NOT NULL,
  ballot_count integer NOT NULL,
  weighted_count bigint NOT NULL,
  CONSTRAINT proposal_tally_counts_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposal_tally_counts_choice_unique UNIQUE (tally_id,choice_code),
  CONSTRAINT proposal_tally_counts_tally_world_fk
    FOREIGN KEY (world_id,tally_id)
    REFERENCES public.proposal_tallies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_tally_counts_shape_valid CHECK (
    choice_code IN ('yes','no','abstain')
    AND ballot_count BETWEEN 0 AND 1000000 AND weighted_count >= 0
  )
);
--> statement-breakpoint
CREATE TABLE public.proposal_results (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  tally_id uuid NOT NULL UNIQUE,
  outcome text NOT NULL,
  quorum_met boolean NOT NULL,
  threshold_met boolean NOT NULL,
  result_schema_version integer NOT NULL DEFAULT 1,
  result_checksum bytea NOT NULL,
  certified_command_id uuid NOT NULL,
  certified_event_id uuid NOT NULL,
  certified_state_revision bigint NOT NULL,
  certified_tick bigint NOT NULL,
  repair_of_result_id uuid,
  certified_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_results_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposal_results_lineage_identity
    UNIQUE (world_id,id,proposal_id,contest_id),
  CONSTRAINT proposal_results_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.proposal_contests(world_id,contest_id) ON DELETE RESTRICT,
  CONSTRAINT proposal_results_proposal_world_fk
    FOREIGN KEY (world_id,proposal_id)
    REFERENCES public.proposals(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_results_tally_world_fk
    FOREIGN KEY (world_id,tally_id)
    REFERENCES public.proposal_tallies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_results_repair_lineage_fk
    FOREIGN KEY (world_id,repair_of_result_id,proposal_id,contest_id)
    REFERENCES public.proposal_results(world_id,id,proposal_id,contest_id)
    ON DELETE RESTRICT,
  CONSTRAINT proposal_results_command_world_fk
    FOREIGN KEY (certified_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT proposal_results_event_world_fk
    FOREIGN KEY (world_id,certified_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proposal_results_shape_valid CHECK (
    outcome IN ('passed','rejected_quorum','rejected_threshold')
    AND result_schema_version = 1
    AND ((outcome = 'passed' AND quorum_met AND threshold_met)
      OR (outcome = 'rejected_quorum' AND NOT quorum_met)
      OR (outcome = 'rejected_threshold' AND quorum_met AND NOT threshold_met))
    AND certified_state_revision > 0 AND certified_tick >= 0
    AND octet_length(result_checksum) = 32
    AND repair_of_result_id IS DISTINCT FROM id
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX proposal_results_root_proposal_unique
  ON public.proposal_results(proposal_id)
  WHERE repair_of_result_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX proposal_results_root_contest_unique
  ON public.proposal_results(contest_id)
  WHERE repair_of_result_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX proposal_results_repair_parent_unique
  ON public.proposal_results(repair_of_result_id)
  WHERE repair_of_result_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE public.election_tallies (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  election_id uuid NOT NULL,
  eligibility_snapshot_id uuid NOT NULL,
  tally_version integer NOT NULL,
  algorithm_version text NOT NULL,
  eligible_count integer NOT NULL,
  participating_count integer NOT NULL,
  input_checksum bytea NOT NULL,
  output_checksum bytea NOT NULL,
  recount_of_tally_id uuid,
  tallied_tick bigint NOT NULL,
  tallied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT election_tallies_world_identity UNIQUE (world_id,id),
  CONSTRAINT election_tallies_version_unique UNIQUE (contest_id,tally_version),
  CONSTRAINT election_tallies_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.election_contests(world_id,contest_id) ON DELETE RESTRICT,
  CONSTRAINT election_tallies_election_world_fk
    FOREIGN KEY (world_id,election_id)
    REFERENCES public.elections(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_tallies_snapshot_world_fk
    FOREIGN KEY (world_id,eligibility_snapshot_id)
    REFERENCES public.eligibility_snapshots(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_tallies_recount_world_fk
    FOREIGN KEY (world_id,recount_of_tally_id)
    REFERENCES public.election_tallies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_tallies_shape_valid CHECK (
    tally_version BETWEEN 1 AND 1000 AND algorithm_version = 'election_plurality_v1'
    AND eligible_count BETWEEN 0 AND 1000000
    AND participating_count BETWEEN 0 AND eligible_count
    AND octet_length(input_checksum) = 32 AND octet_length(output_checksum) = 32
    AND tallied_tick >= 0
  )
);
--> statement-breakpoint
CREATE TABLE public.election_tally_counts (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  tally_id uuid NOT NULL,
  candidacy_id uuid,
  count_kind text NOT NULL,
  ballot_count integer NOT NULL,
  weighted_count bigint NOT NULL,
  CONSTRAINT election_tally_counts_world_identity UNIQUE (world_id,id),
  CONSTRAINT election_tally_counts_candidate_unique UNIQUE NULLS NOT DISTINCT (tally_id,candidacy_id,count_kind),
  CONSTRAINT election_tally_counts_tally_world_fk
    FOREIGN KEY (world_id,tally_id)
    REFERENCES public.election_tallies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_tally_counts_candidate_world_fk
    FOREIGN KEY (world_id,candidacy_id)
    REFERENCES public.candidacies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_tally_counts_shape_valid CHECK (
    count_kind IN ('candidate','abstain')
    AND ((count_kind = 'candidate' AND candidacy_id IS NOT NULL)
      OR (count_kind <> 'candidate' AND candidacy_id IS NULL))
    AND ballot_count BETWEEN 0 AND 1000000 AND weighted_count >= 0
  )
);
--> statement-breakpoint
CREATE TABLE public.election_results (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  election_id uuid NOT NULL,
  tally_id uuid NOT NULL UNIQUE,
  outcome text NOT NULL,
  winning_candidacy_id uuid,
  result_schema_version integer NOT NULL DEFAULT 1,
  result_checksum bytea NOT NULL,
  certified_command_id uuid NOT NULL,
  certified_event_id uuid NOT NULL,
  certified_state_revision bigint NOT NULL,
  certified_tick bigint NOT NULL,
  repair_of_result_id uuid,
  certified_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT election_results_world_identity UNIQUE (world_id,id),
  CONSTRAINT election_results_lineage_identity
    UNIQUE (world_id,id,election_id,contest_id),
  CONSTRAINT election_results_contest_world_fk
    FOREIGN KEY (world_id,contest_id)
    REFERENCES public.election_contests(world_id,contest_id) ON DELETE RESTRICT,
  CONSTRAINT election_results_election_world_fk
    FOREIGN KEY (world_id,election_id)
    REFERENCES public.elections(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_results_tally_world_fk
    FOREIGN KEY (world_id,tally_id)
    REFERENCES public.election_tallies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_results_winner_world_fk
    FOREIGN KEY (world_id,winning_candidacy_id)
    REFERENCES public.candidacies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT election_results_repair_lineage_fk
    FOREIGN KEY (world_id,repair_of_result_id,election_id,contest_id)
    REFERENCES public.election_results(world_id,id,election_id,contest_id)
    ON DELETE RESTRICT,
  CONSTRAINT election_results_command_world_fk
    FOREIGN KEY (certified_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT election_results_event_world_fk
    FOREIGN KEY (world_id,certified_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT election_results_shape_valid CHECK (
    outcome IN ('elected','vacant_no_quorum','vacant_no_votes','vacant_tie')
    AND result_schema_version = 1
    AND ((outcome = 'elected' AND winning_candidacy_id IS NOT NULL)
      OR (outcome <> 'elected' AND winning_candidacy_id IS NULL))
    AND certified_state_revision > 0 AND certified_tick >= 0
    AND octet_length(result_checksum) = 32
    AND repair_of_result_id IS DISTINCT FROM id
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX election_results_root_election_unique
  ON public.election_results(election_id)
  WHERE repair_of_result_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX election_results_root_contest_unique
  ON public.election_results(contest_id)
  WHERE repair_of_result_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX election_results_repair_parent_unique
  ON public.election_results(repair_of_result_id)
  WHERE repair_of_result_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE public.office_terms (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  office_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  holder_entity_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_election_result_id uuid,
  source_proposal_result_id uuid,
  status text NOT NULL DEFAULT 'scheduled',
  starts_tick bigint NOT NULL,
  planned_ends_tick bigint NOT NULL,
  term_number integer NOT NULL,
  checksum bytea NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_terms_world_identity UNIQUE (world_id,id),
  CONSTRAINT office_terms_number_unique UNIQUE (seat_id,term_number),
  CONSTRAINT office_terms_start_unique UNIQUE (seat_id,starts_tick),
  CONSTRAINT office_terms_office_world_fk
    FOREIGN KEY (world_id,office_id)
    REFERENCES public.political_offices(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_terms_seat_world_fk
    FOREIGN KEY (world_id,seat_id)
    REFERENCES public.political_office_seats(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_terms_holder_world_fk
    FOREIGN KEY (world_id,holder_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_terms_election_result_world_fk
    FOREIGN KEY (world_id,source_election_result_id)
    REFERENCES public.election_results(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_terms_proposal_result_world_fk
    FOREIGN KEY (world_id,source_proposal_result_id)
    REFERENCES public.proposal_results(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_terms_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT office_terms_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT office_terms_shape_valid CHECK (
    source_kind IN ('election','appointment','initial')
    AND status IN ('scheduled','active','ended','removed','superseded_by_repair')
    AND ((source_kind = 'election' AND source_election_result_id IS NOT NULL
        AND source_proposal_result_id IS NULL)
      OR (source_kind = 'appointment' AND source_election_result_id IS NULL)
      OR (source_kind = 'initial' AND source_election_result_id IS NULL
        AND source_proposal_result_id IS NULL))
    AND starts_tick >= 0 AND planned_ends_tick > starts_tick
    AND term_number BETWEEN 1 AND 2147483647
    AND created_state_revision > 0 AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.office_term_transitions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  term_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  effective_tick bigint NOT NULL,
  reason_code text NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_term_transitions_world_identity UNIQUE (world_id,id),
  CONSTRAINT office_term_transitions_kind_unique UNIQUE (term_id,to_status),
  CONSTRAINT office_term_transitions_event_term_unique UNIQUE (event_id,term_id),
  CONSTRAINT office_term_transitions_term_world_fk
    FOREIGN KEY (world_id,term_id)
    REFERENCES public.office_terms(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_term_transitions_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT office_term_transitions_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT office_term_transitions_shape_valid CHECK (
    to_status IN ('scheduled','active','ended','removed','superseded_by_repair')
    AND (from_status IS NULL OR from_status IN (
      'scheduled','active','ended','removed','superseded_by_repair'
    ))
    AND effective_tick >= 0 AND state_revision > 0
    AND char_length(reason_code) BETWEEN 3 AND 120
    AND reason_code ~ '^[A-Z][A-Z0-9_]*$'
    AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.office_seat_authority_intervals (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  office_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  term_id uuid NOT NULL UNIQUE,
  holder_entity_id uuid NOT NULL,
  effective_ticks int8range NOT NULL,
  created_command_id uuid NOT NULL,
  updated_command_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_seat_authority_intervals_world_identity UNIQUE (world_id,id),
  CONSTRAINT office_seat_authority_intervals_office_world_fk
    FOREIGN KEY (world_id,office_id)
    REFERENCES public.political_offices(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_seat_authority_intervals_seat_world_fk
    FOREIGN KEY (world_id,seat_id)
    REFERENCES public.political_office_seats(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_seat_authority_intervals_term_world_fk
    FOREIGN KEY (world_id,term_id)
    REFERENCES public.office_terms(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_seat_authority_intervals_holder_world_fk
    FOREIGN KEY (world_id,holder_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT office_seat_authority_intervals_created_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT office_seat_authority_intervals_updated_command_world_fk
    FOREIGN KEY (updated_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT office_seat_authority_intervals_range_valid CHECK (
    public.worldgraph_governance_range_is_valid_v1(effective_ticks)
    AND row_version > 0 AND updated_at >= created_at
  ),
  CONSTRAINT office_seat_authority_intervals_no_overlap EXCLUDE USING gist (
    world_id WITH =,
    seat_id WITH =,
    effective_ticks WITH &&
  )
);
--> statement-breakpoint
CREATE INDEX office_seat_authority_effective_idx
  ON public.office_seat_authority_intervals USING gist (world_id,effective_ticks);
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_guard_governance_authority_interval_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  open_command_id uuid := NULLIF(
    current_setting('worldgraph.command_id',true),'')::uuid;
  open_command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% authority intervals cannot be deleted',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type INTO open_command_type
  FROM public.command_records command
  WHERE command.id = open_command_id
    AND command.world_id = COALESCE(NEW.world_id,OLD.world_id)
    AND public.worldgraph_command_write_is_open(command.world_id,command.id);
  IF open_command_type IS NULL THEN
    RAISE EXCEPTION '% authority interval requires an open command',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'charter_authority_intervals' THEN
    IF TG_OP <> 'INSERT'
      OR open_command_type NOT IN (
        'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1'
      )
      OR NEW.created_command_id IS DISTINCT FROM open_command_id
      OR NEW.updated_command_id IS DISTINCT FROM open_command_id
      OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'charter authority interval mutation is not seed-bound'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'law_authority_intervals' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.created_command_id IS DISTINCT FROM open_command_id
        OR NEW.updated_command_id IS DISTINCT FROM open_command_id
        OR NEW.row_version <> 1
        OR open_command_type NOT IN (
          'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1',
          'CertifyAndEnactProposalV1','ExecuteCreatorOverrideV1'
        ) THEN
        RAISE EXCEPTION 'law authority interval insert is not command-bound'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.world_id IS DISTINCT FROM OLD.world_id
      OR NEW.law_id IS DISTINCT FROM OLD.law_id
      OR NEW.law_version_id IS DISTINCT FROM OLD.law_version_id
      OR NEW.created_command_id IS DISTINCT FROM OLD.created_command_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR lower(NEW.effective_ticks) IS DISTINCT FROM lower(OLD.effective_ticks)
      OR upper(NEW.effective_ticks) IS NULL
      OR upper(NEW.effective_ticks) <= lower(NEW.effective_ticks)
      OR NOT OLD.effective_ticks @> upper(NEW.effective_ticks)
      OR NEW.updated_command_id IS DISTINCT FROM open_command_id
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.updated_at < OLD.updated_at
      OR open_command_type NOT IN (
        'CertifyAndEnactProposalV1','ExecuteCreatorOverrideV1'
      ) THEN
      RAISE EXCEPTION 'law authority interval transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'office_seat_authority_intervals' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.created_command_id IS DISTINCT FROM open_command_id
        OR NEW.updated_command_id IS DISTINCT FROM open_command_id
        OR NEW.row_version <> 1
        OR open_command_type NOT IN (
          'CertifyElectionV1','AppointOfficeholderV1',
          'CertifyAndEnactProposalV1','ExecuteCreatorOverrideV1'
        ) THEN
        RAISE EXCEPTION 'office seat authority interval insert is not command-bound'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.world_id IS DISTINCT FROM OLD.world_id
      OR NEW.office_id IS DISTINCT FROM OLD.office_id
      OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
      OR NEW.term_id IS DISTINCT FROM OLD.term_id
      OR NEW.holder_entity_id IS DISTINCT FROM OLD.holder_entity_id
      OR NEW.created_command_id IS DISTINCT FROM OLD.created_command_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR lower(NEW.effective_ticks) IS DISTINCT FROM lower(OLD.effective_ticks)
      OR upper(NEW.effective_ticks) IS NULL
      OR upper(NEW.effective_ticks) <= lower(NEW.effective_ticks)
      OR NOT OLD.effective_ticks @> upper(NEW.effective_ticks)
      OR NEW.updated_command_id IS DISTINCT FROM open_command_id
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.updated_at < OLD.updated_at
      OR open_command_type NOT IN (
        'RemoveOfficeholderV1','CertifyElectionV1','AppointOfficeholderV1',
        'CertifyAndEnactProposalV1','ExecuteCreatorOverrideV1'
      ) THEN
      RAISE EXCEPTION 'office seat authority interval transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unsupported governance authority interval table %',TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_guard_governance_authority_interval_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER charter_authority_intervals_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.charter_authority_intervals
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_authority_interval_v1();
--> statement-breakpoint
CREATE TRIGGER law_authority_intervals_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.law_authority_intervals
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_authority_interval_v1();
--> statement-breakpoint
CREATE TRIGGER office_seat_authority_intervals_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.office_seat_authority_intervals
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_guard_governance_authority_interval_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_governance_authority_interval_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_type_value text;
  evidence_valid boolean := false;
  changed_upper bigint := upper(NEW.effective_ticks);
BEGIN
  SELECT command.command_type INTO command_type_value
  FROM public.command_records command
  WHERE command.id = NEW.updated_command_id AND command.world_id = NEW.world_id;

  IF TG_TABLE_NAME = 'charter_authority_intervals' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.governing_charter_versions version
      JOIN public.governing_charters charter
        ON charter.world_id=version.world_id AND charter.id=version.charter_id
      JOIN public.compiled_governance_seed_plans plan
        ON plan.world_id=version.world_id
       AND plan.world_version_id=version.source_world_version_id
       AND plan.plan_hash=version.seed_plan_hash
      WHERE version.world_id=NEW.world_id AND version.id=NEW.charter_version_id
        AND version.charter_id=NEW.charter_id
        AND version.created_command_id=NEW.created_command_id
        AND charter.created_command_id=NEW.created_command_id
        AND lower(NEW.effective_ticks)=version.effective_from_tick
        AND upper(NEW.effective_ticks) IS NOT DISTINCT FROM version.declared_until_tick
        AND plan.canonical_plan -> 'charter' ->> 'stableKey'=charter.stable_key::text
        AND plan.canonical_plan -> 'charter' ->> 'effectiveFromTick'=
          version.effective_from_tick::text
        AND (
          (plan.canonical_plan -> 'charter' -> 'effectiveUntilTick'='null'::jsonb
            AND version.declared_until_tick IS NULL)
          OR plan.canonical_plan -> 'charter' ->> 'effectiveUntilTick'=
            version.declared_until_tick::text
        )
    ) INTO evidence_valid;
  ELSIF TG_TABLE_NAME = 'law_authority_intervals' AND TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.law_versions version
      JOIN public.laws law ON law.world_id=version.world_id AND law.id=version.law_id
      JOIN public.law_effectivity_transitions transition
        ON transition.world_id=version.world_id
       AND transition.law_version_id=version.id
       AND transition.law_id=version.law_id
      WHERE version.world_id=NEW.world_id AND version.id=NEW.law_version_id
        AND version.law_id=NEW.law_id
        AND version.created_command_id=NEW.created_command_id
        AND transition.command_id=NEW.created_command_id
        AND transition.effective_tick=lower(NEW.effective_ticks)
        AND lower(NEW.effective_ticks)=version.effective_from_tick
        AND (
          (command_type_value IN (
            'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1'
          ) AND EXISTS (
            SELECT 1
            FROM public.world_governance_heads head
            JOIN public.compiled_governance_seed_plans plan
              ON plan.world_id=head.world_id
             AND plan.world_version_id=head.source_world_version_id
             AND plan.plan_hash=head.seed_plan_hash
            CROSS JOIN LATERAL jsonb_array_elements(
              plan.canonical_plan -> 'initialLaws'
            ) item(value)
            WHERE head.world_id=NEW.world_id
              AND item.value ->> 'stableKey'=law.stable_key::text
              AND item.value ->> 'effectiveFromTick'=lower(NEW.effective_ticks)::text
              AND (
                (item.value -> 'effectiveUntilTick'='null'::jsonb
                  AND upper(NEW.effective_ticks) IS NULL)
                OR item.value ->> 'effectiveUntilTick'=
                  upper(NEW.effective_ticks)::text
              )
          ))
          OR (command_type_value='CertifyAndEnactProposalV1' AND EXISTS (
            SELECT 1 FROM public.proposal_actions action
            WHERE action.world_id=version.world_id
              AND action.proposal_id=(
                SELECT result.proposal_id FROM public.proposal_results result
                WHERE result.world_id=version.world_id
                  AND result.id=version.source_proposal_result_id
              )
              AND action.action_ordinal=version.source_action_ordinal
              AND action.action_payload ->> 'effectiveFromTick'=
                lower(NEW.effective_ticks)::text
              AND (
                (action.action_payload -> 'effectiveUntilTick'='null'::jsonb
                  AND upper(NEW.effective_ticks) IS NULL)
                OR action.action_payload ->> 'effectiveUntilTick'=
                  upper(NEW.effective_ticks)::text
              )
          ))
          OR (command_type_value='ExecuteCreatorOverrideV1' AND EXISTS (
            SELECT 1 FROM public.command_records command
            WHERE command.id=NEW.created_command_id AND command.world_id=NEW.world_id
              AND command.payload -> 'effect' ->> 'effectType'='execute_proposal_action'
              AND command.payload -> 'effect' -> 'proposalAction' ->> 'effectiveFromTick'=
                lower(NEW.effective_ticks)::text
              AND (
                (command.payload -> 'effect' -> 'proposalAction' -> 'effectiveUntilTick'
                  ='null'::jsonb AND upper(NEW.effective_ticks) IS NULL)
                OR command.payload -> 'effect' -> 'proposalAction'
                  ->> 'effectiveUntilTick'=upper(NEW.effective_ticks)::text
              )
          ))
        )
    ) INTO evidence_valid;
  ELSIF TG_TABLE_NAME = 'law_authority_intervals' THEN
    SELECT changed_upper IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.law_effectivity_transitions transition
      JOIN public.law_versions next_version
        ON next_version.world_id=transition.world_id
       AND next_version.id=transition.law_version_id
      WHERE transition.world_id=NEW.world_id AND transition.law_id=NEW.law_id
        AND transition.command_id=NEW.updated_command_id
        AND transition.effective_tick=changed_upper
        AND next_version.supersedes_version_id=NEW.law_version_id
        AND next_version.created_command_id=NEW.updated_command_id
    ) INTO evidence_valid;
  ELSIF TG_TABLE_NAME = 'office_seat_authority_intervals' AND TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.office_terms term
      JOIN public.office_term_transitions transition
        ON transition.world_id=term.world_id AND transition.term_id=term.id
      WHERE term.world_id=NEW.world_id AND term.id=NEW.term_id
        AND term.office_id=NEW.office_id AND term.seat_id=NEW.seat_id
        AND term.holder_entity_id=NEW.holder_entity_id
        AND term.created_command_id=NEW.created_command_id
        AND transition.command_id=NEW.created_command_id
        AND lower(NEW.effective_ticks)=term.starts_tick
        AND upper(NEW.effective_ticks)=term.planned_ends_tick
        AND transition.effective_tick=term.starts_tick
    ) INTO evidence_valid;
  ELSE
    SELECT changed_upper IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.office_term_transitions transition
      WHERE transition.world_id=NEW.world_id AND transition.term_id=NEW.term_id
        AND transition.command_id=NEW.updated_command_id
        AND transition.effective_tick=changed_upper
        AND transition.to_status IN ('ended','removed','superseded_by_repair')
    ) INTO evidence_valid;
  END IF;

  IF NOT COALESCE(evidence_valid,false) THEN
    RAISE EXCEPTION '% authority interval lacks exact immutable evidence',TG_TABLE_NAME
      USING ERRCODE = '23514',
        CONSTRAINT = 'governance_authority_interval_exact_evidence';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_governance_authority_interval_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER charter_authority_intervals_exact_evidence
  AFTER INSERT OR UPDATE ON public.charter_authority_intervals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_governance_authority_interval_v1();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER law_authority_intervals_exact_evidence
  AFTER INSERT OR UPDATE ON public.law_authority_intervals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_governance_authority_interval_v1();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER office_seat_authority_intervals_exact_evidence
  AFTER INSERT OR UPDATE ON public.office_seat_authority_intervals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_governance_authority_interval_v1();
--> statement-breakpoint
CREATE TABLE public.proposal_enactments (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  proposal_result_id uuid NOT NULL,
  enactment_attempt integer NOT NULL,
  status text NOT NULL,
  failure_code text,
  input_checksum bytea NOT NULL,
  output_checksum bytea,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  enacted_tick bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_enactments_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposal_enactments_attempt_unique UNIQUE (proposal_result_id,enactment_attempt),
  CONSTRAINT proposal_enactments_event_unique UNIQUE (event_id),
  CONSTRAINT proposal_enactments_proposal_world_fk
    FOREIGN KEY (world_id,proposal_id)
    REFERENCES public.proposals(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_enactments_result_world_fk
    FOREIGN KEY (world_id,proposal_result_id)
    REFERENCES public.proposal_results(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_enactments_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT proposal_enactments_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT proposal_enactments_shape_valid CHECK (
    enactment_attempt BETWEEN 1 AND 100 AND status IN ('succeeded','failed')
    AND ((status = 'succeeded' AND failure_code IS NULL AND output_checksum IS NOT NULL)
      OR (status = 'failed' AND failure_code ~ '^[A-Z][A-Z0-9_]*$'
        AND output_checksum IS NULL))
    AND octet_length(input_checksum) = 32
    AND (output_checksum IS NULL OR octet_length(output_checksum) = 32)
    AND state_revision > 0 AND enacted_tick >= 0
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX proposal_enactments_one_success_idx
  ON public.proposal_enactments (proposal_result_id) WHERE status = 'succeeded';
--> statement-breakpoint
CREATE TABLE public.proposal_action_enactments (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  proposal_enactment_id uuid NOT NULL,
  proposal_action_id uuid NOT NULL,
  effect_kind text NOT NULL,
  effect_id uuid NOT NULL,
  effect_version bigint NOT NULL,
  effect_checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_action_enactments_world_identity UNIQUE (world_id,id),
  CONSTRAINT proposal_action_enactments_action_unique UNIQUE (proposal_enactment_id,proposal_action_id),
  CONSTRAINT proposal_action_enactments_enactment_world_fk
    FOREIGN KEY (world_id,proposal_enactment_id)
    REFERENCES public.proposal_enactments(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_action_enactments_action_world_fk
    FOREIGN KEY (world_id,proposal_action_id)
    REFERENCES public.proposal_actions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT proposal_action_enactments_shape_valid CHECK (
    effect_kind IN ('law_version','tax_policy','public_project','office_term','world_patch_approval')
    AND effect_version > 0 AND octet_length(effect_checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.governance_authority_decisions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  actor_mode text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  actor_entity_id uuid,
  action_code text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  evaluated_tick bigint NOT NULL,
  decision text NOT NULL,
  reason_code text NOT NULL,
  policy_dsl_version integer NOT NULL DEFAULT 1,
  input_context jsonb NOT NULL,
  input_checksum bytea NOT NULL,
  decision_checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_authority_decisions_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_authority_decisions_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT governance_authority_decisions_actor_world_fk
    FOREIGN KEY (world_id,actor_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_authority_decisions_shape_valid CHECK (
    actor_mode IN ('in_world','creator','administrator','system')
    AND actor_type IN ('user','system','platform_admin','ai_agent')
    AND char_length(actor_id) BETWEEN 1 AND 160 AND actor_id = btrim(actor_id)
    AND actor_id !~ '[[:cntrl:]]'
    AND char_length(action_code) BETWEEN 3 AND 120 AND action_code ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(resource_type) BETWEEN 1 AND 80 AND resource_type ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(resource_id) BETWEEN 1 AND 240 AND resource_id = btrim(resource_id)
    AND resource_id !~ '[[:cntrl:]]'
    AND evaluated_tick >= 0 AND decision IN ('allow','deny')
    AND reason_code ~ '^[A-Z][A-Z0-9_]*$' AND policy_dsl_version = 1
    AND public.worldgraph_governance_json_is_safe_v1(input_context,65536)
    AND octet_length(input_checksum) = 32 AND octet_length(decision_checksum) = 32
  )
);
--> statement-breakpoint
CREATE INDEX governance_authority_decisions_lookup_idx
  ON public.governance_authority_decisions
  (world_id,actor_entity_id,action_code,resource_type,evaluated_tick DESC,id DESC);
--> statement-breakpoint
CREATE TABLE public.governance_authority_decision_sources (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  source_ordinal integer NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  source_version bigint NOT NULL,
  source_effective_ticks int8range,
  source_checksum bytea NOT NULL,
  contribution text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_authority_sources_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_authority_sources_ordinal_unique UNIQUE (decision_id,source_ordinal),
  CONSTRAINT governance_authority_sources_decision_world_fk
    FOREIGN KEY (world_id,decision_id)
    REFERENCES public.governance_authority_decisions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_authority_sources_shape_valid CHECK (
    source_ordinal BETWEEN 0 AND 255
    AND source_kind IN (
      'charter','institution_power','law','office_power','office_term',
      'membership_role','organization_membership','delegation','override'
    )
    AND source_version > 0
    AND (source_effective_ticks IS NULL
      OR public.worldgraph_governance_range_is_valid_v1(source_effective_ticks))
    AND octet_length(source_checksum) = 32
    AND contribution IN ('allow','deny','context')
  )
);
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_governance_authority_decision_current_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  source_record public.governance_authority_decision_sources%ROWTYPE;
  membership_role_value text;
  current_membership_version bigint;
  held_office_keys text[] := ARRAY[]::text[];
  organization_keys text[] := ARRAY[]::text[];
  expected_checksum bytea;
  source_valid boolean;
  policy_document jsonb;
  policy_action text;
  policy_resource_type text;
  policy_resource_key text;
  policy_matches boolean;
  allowing_policy_count integer := 0;
  office_id_value uuid;
BEGIN
  IF NEW.decision <> 'allow' THEN RETURN NULL; END IF;

  IF NEW.actor_type = 'user' AND NEW.actor_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT membership.role::text,membership.row_version
      INTO membership_role_value,current_membership_version
    FROM public.world_memberships membership
    WHERE membership.world_id=NEW.world_id
      AND membership.user_id=NEW.actor_id::uuid
      AND membership.status='active';
  END IF;

  IF NEW.actor_entity_id IS NOT NULL THEN
    SELECT COALESCE(array_agg(item.office_key ORDER BY item.office_key COLLATE "C"),
      ARRAY[]::text[]) INTO held_office_keys
    FROM (
      SELECT DISTINCT office.stable_key::text AS office_key
      FROM public.office_seat_authority_intervals authority
      JOIN public.political_offices office
        ON office.world_id=authority.world_id AND office.id=authority.office_id
      WHERE authority.world_id=NEW.world_id
        AND authority.holder_entity_id=NEW.actor_entity_id
        AND authority.effective_ticks @> NEW.evaluated_tick
    ) item;
    SELECT COALESCE(array_agg(item.organization_key
      ORDER BY item.organization_key COLLATE "C"),ARRAY[]::text[])
      INTO organization_keys
    FROM (
      SELECT DISTINCT organization.logical_key::text AS organization_key
      FROM public.world_relationships relationship
      JOIN public.world_runtime_heads runtime ON runtime.world_id=relationship.world_id
      JOIN public.world_entities character
        ON character.world_id=relationship.world_id
       AND character.id=relationship.source_entity_id
       AND character.entity_type='player_character'
       AND character.retired_world_version_id IS NULL
      JOIN public.world_entities organization
        ON organization.world_id=relationship.world_id
       AND organization.id=relationship.target_entity_id
       AND organization.entity_type='organization'
       AND organization.retired_world_version_id IS NULL
      WHERE relationship.world_id=NEW.world_id
        AND relationship.source_entity_id=NEW.actor_entity_id
        AND relationship.relationship_type='member_of'
        AND relationship.retired_world_version_id IS NULL
        AND runtime.active_world_version_id IS NOT NULL
    ) item;
  END IF;
  IF cardinality(held_office_keys) > 64 OR cardinality(organization_keys) > 64 THEN
    RAISE EXCEPTION 'governance authority context exceeds finite bounds'
      USING ERRCODE = '42501';
  END IF;

  policy_action := NEW.input_context ->> 'policyActionCode';
  policy_resource_type := NEW.input_context ->> 'policyResourceType';
  policy_resource_key := NEW.input_context ->> 'resourceKey';

  FOR source_record IN
    SELECT source.* FROM public.governance_authority_decision_sources source
    WHERE source.world_id=NEW.world_id AND source.decision_id=NEW.id
    ORDER BY source.source_ordinal
  LOOP
    source_valid := false;
    expected_checksum := NULL;
    policy_document := NULL;
    policy_matches := false;
    office_id_value := NULL;
    CASE source_record.source_kind
      WHEN 'membership_role' THEN
        expected_checksum := extensions.digest(convert_to(
          public.worldgraph_canonical_jsonb(jsonb_build_object(
            'role',membership_role_value,
            'rowVersion',current_membership_version::text,
            'status','active',
            'userId',NEW.actor_id,
            'worldId',NEW.world_id::text
          )),'UTF8'),'sha256');
        source_valid := membership_role_value IS NOT NULL
          AND source_record.source_id=NEW.actor_id::uuid
          AND source_record.source_version=current_membership_version
          AND source_record.source_effective_ticks IS NULL
          AND source_record.source_checksum=expected_checksum;
      WHEN 'organization_membership' THEN
        SELECT extensions.digest(convert_to(
          public.worldgraph_canonical_jsonb(jsonb_build_object(
            'activeWorldVersionId',runtime.active_world_version_id::text,
            'attributes',relationship.attributes,
            'createdWorldVersionId',relationship.created_world_version_id::text,
            'organizationEntityId',organization.id::text,
            'organizationKey',organization.logical_key::text,
            'relationshipId',relationship.id::text,
            'relationshipKey',relationship.logical_key::text,
            'relationshipRowVersion',relationship.row_version::text,
            'relationshipSchemaVersion',relationship.relationship_schema_version,
            'relationshipType','member_of',
            'sourceEntityId',relationship.source_entity_id::text,
            'worldId',relationship.world_id::text
          )),'UTF8'),'sha256')=source_record.source_checksum
          AND source_record.source_version=relationship.row_version+1
          AND source_record.source_effective_ticks IS NULL
          INTO source_valid
        FROM public.world_relationships relationship
        JOIN public.world_runtime_heads runtime ON runtime.world_id=relationship.world_id
        JOIN public.world_entities character
          ON character.world_id=relationship.world_id
         AND character.id=relationship.source_entity_id
         AND character.entity_type='player_character'
         AND character.retired_world_version_id IS NULL
        JOIN public.world_entities organization
          ON organization.world_id=relationship.world_id
         AND organization.id=relationship.target_entity_id
         AND organization.entity_type='organization'
         AND organization.retired_world_version_id IS NULL
        WHERE relationship.world_id=NEW.world_id
          AND relationship.id=source_record.source_id
          AND relationship.source_entity_id=NEW.actor_entity_id
          AND relationship.relationship_type='member_of'
          AND relationship.retired_world_version_id IS NULL;
      WHEN 'office_term' THEN
        SELECT term.checksum=source_record.source_checksum
          AND term.term_number=source_record.source_version
          AND authority.effective_ticks=source_record.source_effective_ticks
          AND authority.effective_ticks @> NEW.evaluated_tick
          INTO source_valid
        FROM public.office_terms term
        JOIN public.office_seat_authority_intervals authority
          ON authority.world_id=term.world_id AND authority.term_id=term.id
        WHERE term.world_id=NEW.world_id AND term.id=source_record.source_id;
      WHEN 'law' THEN
        SELECT version.checksum=source_record.source_checksum
          AND version.law_version=source_record.source_version
          AND authority.effective_ticks=source_record.source_effective_ticks
          AND authority.effective_ticks @> NEW.evaluated_tick,
          version.policy_ast
          INTO source_valid,policy_document
        FROM public.law_versions version
        JOIN public.law_authority_intervals authority
          ON authority.world_id=version.world_id AND authority.law_version_id=version.id
        WHERE version.world_id=NEW.world_id AND version.id=source_record.source_id;
      WHEN 'institution_power' THEN
        SELECT power.checksum=source_record.source_checksum
          AND charter.charter_version=source_record.source_version
          AND authority.effective_ticks=source_record.source_effective_ticks
          AND authority.effective_ticks @> NEW.evaluated_tick
          AND institution.status='active'
          AND power.action_code=policy_action
          AND power.resource_type=policy_resource_type
          AND (
            (NEW.resource_type='institution'
              AND institution.id::text=NEW.resource_id)
            OR (NEW.resource_type='office' AND EXISTS (
              SELECT 1 FROM public.political_offices target_office
              WHERE target_office.world_id=power.world_id
                AND target_office.id::text=NEW.resource_id
                AND target_office.institution_id=power.institution_id
            ))
            OR (NEW.resource_type='office_term' AND EXISTS (
              SELECT 1
              FROM public.office_terms target_term
              JOIN public.political_offices target_office
                ON target_office.world_id=target_term.world_id
               AND target_office.id=target_term.office_id
              WHERE target_term.world_id=power.world_id
                AND target_term.id::text=NEW.resource_id
                AND target_office.institution_id=power.institution_id
            ))
          ),
          power.scope_policy
          INTO source_valid,policy_document
        FROM public.institution_powers power
        JOIN public.institutions institution
          ON institution.world_id=power.world_id AND institution.id=power.institution_id
        JOIN public.governing_charter_versions charter
          ON charter.world_id=power.world_id AND charter.id=power.charter_version_id
        JOIN public.charter_authority_intervals authority
          ON authority.world_id=power.world_id
         AND authority.charter_version_id=power.charter_version_id
        WHERE power.world_id=NEW.world_id AND power.id=source_record.source_id;
      WHEN 'office_power' THEN
        SELECT power.checksum=source_record.source_checksum
          AND charter.charter_version=source_record.source_version
          AND charter_authority.effective_ticks @> NEW.evaluated_tick
          AND power.action_code=policy_action
          AND power.resource_type=policy_resource_type
          AND (
            (NEW.resource_type='office' AND power.office_id::text=NEW.resource_id)
            OR (NEW.resource_type='office_term' AND EXISTS (
              SELECT 1 FROM public.office_terms target_term
              WHERE target_term.world_id=power.world_id
                AND target_term.id::text=NEW.resource_id
                AND target_term.office_id=power.office_id
            ))
          ),
          power.scope_policy,power.office_id
          INTO source_valid,policy_document,office_id_value
        FROM public.office_powers power
        JOIN public.governing_charter_versions charter
          ON charter.world_id=power.world_id AND charter.id=power.charter_version_id
        JOIN public.charter_authority_intervals charter_authority
          ON charter_authority.world_id=power.world_id
         AND charter_authority.charter_version_id=power.charter_version_id
        WHERE power.world_id=NEW.world_id AND power.id=source_record.source_id;
        source_valid := COALESCE(source_valid,false) AND (
          EXISTS (
            SELECT 1
            FROM public.governance_authority_decision_sources term_source
            JOIN public.office_seat_authority_intervals authority
              ON authority.world_id=term_source.world_id
             AND authority.term_id=term_source.source_id
            WHERE term_source.world_id=NEW.world_id
              AND term_source.decision_id=NEW.id
              AND term_source.source_kind='office_term'
              AND authority.office_id=office_id_value
              AND authority.holder_entity_id=NEW.actor_entity_id
              AND authority.effective_ticks=source_record.source_effective_ticks
              AND authority.effective_ticks @> NEW.evaluated_tick
          ) OR EXISTS (
            SELECT 1
            FROM public.governance_authority_decision_sources delegation_source
            JOIN public.office_power_delegations delegation
              ON delegation.world_id=delegation_source.world_id
             AND delegation.id=delegation_source.source_id
             AND delegation.office_power_id=source_record.source_id
            JOIN public.governance_authority_decision_sources membership_source
              ON membership_source.world_id=delegation_source.world_id
             AND membership_source.decision_id=delegation_source.decision_id
             AND membership_source.source_kind='organization_membership'
            JOIN public.world_relationships membership
              ON membership.world_id=membership_source.world_id
             AND membership.id=membership_source.source_id
             AND membership.source_entity_id=NEW.actor_entity_id
             AND membership.target_entity_id=delegation.grantee_organization_entity_id
             AND membership.relationship_type='member_of'
             AND membership.retired_world_version_id IS NULL
            JOIN public.governance_authority_decision_sources term_source
              ON term_source.world_id=delegation_source.world_id
             AND term_source.decision_id=delegation_source.decision_id
             AND term_source.source_kind='office_term'
            JOIN public.office_seat_authority_intervals authority
              ON authority.world_id=term_source.world_id
             AND authority.term_id=term_source.source_id
             AND authority.office_id=office_id_value
            WHERE delegation_source.world_id=NEW.world_id
              AND delegation_source.decision_id=NEW.id
              AND delegation_source.source_kind='delegation'
              AND delegation_source.source_checksum=delegation.checksum
              AND delegation_source.source_version=source_record.source_version
              AND authority.effective_ticks=source_record.source_effective_ticks
              AND authority.effective_ticks @> NEW.evaluated_tick
          )
        );
      WHEN 'delegation' THEN
        SELECT delegation.checksum=source_record.source_checksum
          AND charter.charter_version=source_record.source_version
          INTO source_valid
        FROM public.office_power_delegations delegation
        JOIN public.governing_charter_versions charter
          ON charter.world_id=delegation.world_id
         AND charter.id=delegation.charter_version_id
        WHERE delegation.world_id=NEW.world_id AND delegation.id=source_record.source_id;
      ELSE
        source_valid := false;
    END CASE;

    IF NOT COALESCE(source_valid,false) THEN
      RAISE EXCEPTION 'governance authority source is stale or unbound'
        USING ERRCODE = '42501',
          CONSTRAINT = 'governance_authority_source_current';
    END IF;

    IF source_record.contribution='allow'
      AND source_record.source_kind IN ('law','institution_power','office_power') THEN
      policy_matches := public.worldgraph_governance_policy_matches_v1(
        policy_document,NEW.actor_mode,
        CASE WHEN membership_role_value IS NULL THEN ARRAY[]::text[]
          ELSE ARRAY[membership_role_value]::text[] END,
        held_office_keys,organization_keys,
        CASE WHEN source_record.source_kind='law' THEN NEW.action_code
          ELSE policy_action END,
        policy_resource_type,policy_resource_key,NEW.evaluated_tick
      );
      IF NOT policy_matches THEN
        RAISE EXCEPTION 'governance allowing policy no longer matches current authority'
          USING ERRCODE = '42501',
            CONSTRAINT = 'governance_authority_policy_current';
      END IF;
      allowing_policy_count := allowing_policy_count + 1;
    END IF;
  END LOOP;

  IF NEW.input_context ? 'policySourceCount' AND allowing_policy_count = 0 THEN
    RAISE EXCEPTION 'compiled governance allow lacks a current allowing policy source'
      USING ERRCODE = '42501',
        CONSTRAINT = 'governance_authority_allow_source_required';
  END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'governance authority identity is not canonical'
    USING ERRCODE = '42501';
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_governance_authority_decision_current_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER governance_authority_decisions_current
  AFTER INSERT ON public.governance_authority_decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_governance_authority_decision_current_v1();
--> statement-breakpoint
CREATE TABLE public.governance_schedule_occurrences (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  scheduled_action_id uuid NOT NULL,
  occurrence_key text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  transition_kind text NOT NULL,
  due_tick bigint NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_schedule_occurrences_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_schedule_occurrences_action_unique UNIQUE (scheduled_action_id),
  CONSTRAINT governance_schedule_occurrences_key_unique UNIQUE (world_id,occurrence_key),
  CONSTRAINT governance_schedule_occurrences_schedule_world_fk
    FOREIGN KEY (world_id,scheduled_action_id)
    REFERENCES public.scheduled_actions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_schedule_occurrences_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT governance_schedule_occurrences_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governance_schedule_occurrences_shape_valid CHECK (
    char_length(occurrence_key) BETWEEN 8 AND 200
    AND occurrence_key ~ '^[a-z0-9][a-z0-9:._-]*$'
    AND target_kind IN ('proposal','election','law','office_term','tax_policy')
    AND transition_kind IN ('open','close_tally','certify','activate','complete')
    AND due_tick >= 0 AND state_revision > 0
  )
);
--> statement-breakpoint
ALTER TABLE public.creator_override_records
  ADD CONSTRAINT creator_override_records_governance_world_actor_unique
  UNIQUE (id,world_id,actor_user_id);
--> statement-breakpoint
CREATE TABLE public.governance_overrides (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  creator_override_id uuid NOT NULL UNIQUE,
  actor_user_id uuid NOT NULL,
  actor_mode text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  reason text NOT NULL,
  impact_before jsonb NOT NULL,
  impact_after jsonb NOT NULL,
  requires_second_approval boolean NOT NULL DEFAULT false,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  ledger_entry_id uuid NOT NULL UNIQUE,
  state_revision bigint NOT NULL,
  checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_overrides_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_overrides_creator_world_actor_fk
    FOREIGN KEY (creator_override_id,world_id,actor_user_id)
    REFERENCES public.creator_override_records(id,world_id,actor_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT governance_overrides_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT governance_overrides_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT governance_overrides_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governance_overrides_ledger_world_fk
    FOREIGN KEY (world_id,ledger_entry_id)
    REFERENCES public.ledger_entries(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governance_overrides_shape_valid CHECK (
    actor_mode IN ('creator','administrator')
    AND target_kind IN (
      'charter','world_governance','law','proposal','election','office',
      'office_term','tax_policy','treasury_wallet','public_project','world_patch'
    )
    AND char_length(btrim(reason)) BETWEEN 10 AND 1000 AND reason = btrim(reason)
    AND translate(reason,E'\t\n\r','') !~ '[[:cntrl:]]'
    AND public.worldgraph_governance_json_is_safe_v1(impact_before,65536)
    AND public.worldgraph_governance_json_is_safe_v1(impact_after,65536)
    AND state_revision > 0 AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.governance_override_approvals (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  override_id uuid NOT NULL,
  approver_user_id uuid NOT NULL,
  approval_kind text NOT NULL,
  approval_hash bytea NOT NULL,
  audit_record_id uuid NOT NULL UNIQUE,
  approved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_override_approvals_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_override_approvals_approver_unique UNIQUE (override_id,approver_user_id),
  CONSTRAINT governance_override_approvals_override_world_fk
    FOREIGN KEY (world_id,override_id)
    REFERENCES public.governance_overrides(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_override_approvals_approver_fk
    FOREIGN KEY (approver_user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT governance_override_approvals_audit_world_actor_fk
    FOREIGN KEY (audit_record_id,world_id,approver_user_id)
    REFERENCES public.security_audit_records(id,world_id,actor_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT governance_override_approvals_shape_valid CHECK (
    approval_kind IN ('single','second_party') AND octet_length(approval_hash) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.governance_repairs (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id) ON DELETE RESTRICT,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  repair_kind text NOT NULL,
  reason text NOT NULL,
  before_checksum bytea NOT NULL,
  after_checksum bytea NOT NULL,
  replacement_result_id uuid,
  requires_second_approval boolean NOT NULL DEFAULT true,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  ledger_entry_id uuid NOT NULL UNIQUE,
  actor_user_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_repairs_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_repairs_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT governance_repairs_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governance_repairs_ledger_world_fk
    FOREIGN KEY (world_id,ledger_entry_id)
    REFERENCES public.ledger_entries(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governance_repairs_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT governance_repairs_shape_valid CHECK (
    target_kind IN ('proposal_result','election_result','office_term','law_interval','tax_policy_interval')
    AND repair_kind IN ('recount','replace_result','repair_interval','vacate_term')
    AND char_length(btrim(reason)) BETWEEN 10 AND 1000 AND reason = btrim(reason)
    AND translate(reason,E'\t\n\r','') !~ '[[:cntrl:]]'
    AND octet_length(before_checksum) = 32 AND octet_length(after_checksum) = 32
    AND (repair_kind = 'recount' OR before_checksum <> after_checksum)
    AND state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE public.governance_repair_approvals (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  repair_id uuid NOT NULL,
  approver_user_id uuid NOT NULL,
  approval_hash bytea NOT NULL,
  audit_record_id uuid NOT NULL UNIQUE,
  approved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_repair_approvals_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_repair_approvals_approver_unique UNIQUE (repair_id,approver_user_id),
  CONSTRAINT governance_repair_approvals_repair_world_fk
    FOREIGN KEY (world_id,repair_id)
    REFERENCES public.governance_repairs(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_repair_approvals_approver_fk
    FOREIGN KEY (approver_user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT governance_repair_approvals_audit_world_actor_fk
    FOREIGN KEY (audit_record_id,world_id,approver_user_id)
    REFERENCES public.security_audit_records(id,world_id,actor_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT governance_repair_approvals_hash_valid CHECK (octet_length(approval_hash) = 32)
);
--> statement-breakpoint
CREATE TABLE public.recent_credential_proofs (
  id uuid PRIMARY KEY,
  proof_hash bytea NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  world_id uuid NOT NULL REFERENCES public.worlds(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  command_type text NOT NULL,
  command_request_hash bytea NOT NULL,
  method text NOT NULL,
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  request_id text NOT NULL,
  audit_record_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recent_credential_proofs_binding_unique UNIQUE (
    id,session_id,user_id,world_id,command_id,command_type,command_request_hash
  ),
  CONSTRAINT recent_credential_proofs_audit_world_actor_fk
    FOREIGN KEY (audit_record_id,world_id,user_id)
    REFERENCES public.security_audit_records(id,world_id,actor_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT recent_credential_proofs_shape_valid CHECK (
    octet_length(proof_hash) = 32
    AND octet_length(command_request_hash) = 32
    AND command_type IN ('ExecuteCreatorOverrideV1','RepairGovernanceResultV1')
    AND method = 'password'
    AND expires_at > verified_at
    AND expires_at <= verified_at + interval '15 minutes'
    AND created_at >= verified_at
    AND char_length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE INDEX recent_credential_proofs_expiry_idx
  ON public.recent_credential_proofs (expires_at,id);
--> statement-breakpoint
CREATE TABLE public.recent_credential_proof_consumptions (
  proof_id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  user_id uuid NOT NULL,
  world_id uuid NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  command_type text NOT NULL,
  command_request_hash bytea NOT NULL,
  request_id text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recent_credential_proof_consumptions_binding_fk
    FOREIGN KEY (
      proof_id,session_id,user_id,world_id,command_id,command_type,
      command_request_hash
    ) REFERENCES public.recent_credential_proofs(
      id,session_id,user_id,world_id,command_id,command_type,
      command_request_hash
    ) ON DELETE RESTRICT,
  CONSTRAINT recent_credential_proof_consumptions_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT recent_credential_proof_consumptions_shape_valid CHECK (
    octet_length(command_request_hash) = 32
    AND command_type IN ('ExecuteCreatorOverrideV1','RepairGovernanceResultV1')
    AND char_length(request_id) BETWEEN 1 AND 128
    AND request_id !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
REVOKE ALL ON public.recent_credential_proofs,
  public.recent_credential_proof_consumptions
  FROM PUBLIC,worldgraph_governance_tally,worldgraph_app;
--> statement-breakpoint
CREATE TRIGGER recent_credential_proofs_append_only
  BEFORE UPDATE OR DELETE ON public.recent_credential_proofs
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_reject_update_delete();
--> statement-breakpoint
CREATE TRIGGER recent_credential_proof_consumptions_append_only
  BEFORE UPDATE OR DELETE ON public.recent_credential_proof_consumptions
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_reject_update_delete();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_issue_recent_credential_proof_v1(
  checked_proof_id uuid,
  checked_proof_hash bytea,
  checked_session_id uuid,
  checked_user_id uuid,
  checked_world_id uuid,
  checked_command_id uuid,
  checked_command_type text,
  checked_command_request_hash bytea,
  checked_verified_at timestamptz,
  checked_expires_at timestamptz,
  checked_request_id text,
  checked_audit_record_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  issued_at timestamptz := transaction_timestamp();
BEGIN
  IF checked_proof_id IS NULL OR checked_session_id IS NULL
    OR checked_user_id IS NULL OR checked_world_id IS NULL
    OR checked_command_id IS NULL OR checked_audit_record_id IS NULL
    OR octet_length(checked_proof_hash) <> 32
    OR octet_length(checked_command_request_hash) <> 32
    OR checked_command_type NOT IN (
      'ExecuteCreatorOverrideV1','RepairGovernanceResultV1'
    )
    OR checked_verified_at IS NULL OR checked_expires_at IS NULL
    OR checked_verified_at > issued_at + interval '1 minute'
    OR checked_verified_at < issued_at - interval '1 minute'
    OR checked_expires_at <= issued_at
    OR checked_expires_at > checked_verified_at + interval '15 minutes'
    OR checked_request_id IS NULL
    OR char_length(checked_request_id) NOT BETWEEN 1 AND 128
    OR checked_request_id ~ '[[:cntrl:]]'
    OR NOT EXISTS (
      SELECT 1
      FROM public.sessions session
      JOIN public.users actor ON actor.id = session.user_id
      JOIN public.worlds world ON world.id = checked_world_id
      JOIN public.security_audit_records audit
        ON audit.id = checked_audit_record_id
       AND audit.world_id = checked_world_id
       AND audit.actor_user_id = checked_user_id
      WHERE session.id = checked_session_id
        AND session.user_id = checked_user_id
        AND session.revoked_at IS NULL
        AND session.idle_expires_at > issued_at
        AND session.absolute_expires_at > issued_at
        AND session.auth_version = actor.auth_version
        AND actor.status = 'active'::user_status
        AND world.archived_at IS NULL
        AND checked_expires_at <= session.idle_expires_at
        AND checked_expires_at <= session.absolute_expires_at
        AND (
          actor.platform_role = 'platform_admin'::platform_role
          OR EXISTS (
            SELECT 1 FROM public.world_memberships membership
            WHERE membership.world_id = checked_world_id
              AND membership.user_id = checked_user_id
              AND membership.status = 'active'::membership_status
          )
        )
        AND audit.category = 'identity'
        AND audit.action = 'identity.reauthenticate'
        AND audit.outcome = 'allowed'
        AND audit.reason_code = 'RECENT_CREDENTIAL_VERIFIED'
        AND audit.target_type = 'recent_credential_proof'
        AND audit.target_id = checked_proof_id
        AND audit.request_id = checked_request_id
        AND audit.redacted_metadata ->> 'commandId' = checked_command_id::text
        AND audit.redacted_metadata ->> 'commandType' = checked_command_type
        AND audit.redacted_metadata ->> 'commandRequestHash' =
          encode(checked_command_request_hash,'hex')
        AND audit.redacted_metadata ->> 'method' = 'password'
    ) THEN
    RAISE EXCEPTION 'recent credential proof issuance evidence is invalid'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.recent_credential_proofs (
    id,proof_hash,session_id,user_id,world_id,command_id,command_type,
    command_request_hash,method,verified_at,expires_at,request_id,
    audit_record_id,created_at
  ) VALUES (
    checked_proof_id,checked_proof_hash,checked_session_id,checked_user_id,
    checked_world_id,checked_command_id,checked_command_type,
    checked_command_request_hash,'password',checked_verified_at,
    checked_expires_at,checked_request_id,checked_audit_record_id,
    greatest(issued_at,checked_verified_at)
  );
  RETURN checked_proof_id;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_issue_recent_credential_proof_v1(
  uuid,bytea,uuid,uuid,uuid,uuid,text,bytea,timestamptz,timestamptz,text,uuid
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_consume_recent_credential_proof_v1(
  checked_proof_hash bytea,
  checked_session_id uuid,
  checked_user_id uuid,
  checked_world_id uuid,
  checked_command_id uuid,
  checked_command_type text,
  checked_command_request_hash bytea,
  checked_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_proof_id uuid;
  consumed_time timestamptz := transaction_timestamp();
BEGIN
  IF octet_length(checked_proof_hash) <> 32
    OR octet_length(checked_command_request_hash) <> 32
    OR checked_request_id IS NULL
    OR char_length(checked_request_id) NOT BETWEEN 1 AND 128
    OR checked_request_id ~ '[[:cntrl:]]'
    OR checked_command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')::uuid
    OR NOT public.worldgraph_command_write_is_open(
      checked_world_id,checked_command_id
    ) THEN
    RETURN false;
  END IF;

  SELECT proof.id INTO checked_proof_id
  FROM public.recent_credential_proofs proof
  JOIN public.sessions session
    ON session.id = proof.session_id AND session.user_id = proof.user_id
  JOIN public.users actor ON actor.id = session.user_id
  JOIN public.command_records command
    ON command.id = proof.command_id AND command.world_id = proof.world_id
  WHERE proof.proof_hash = checked_proof_hash
    AND proof.session_id = checked_session_id
    AND proof.user_id = checked_user_id
    AND proof.world_id = checked_world_id
    AND proof.command_id = checked_command_id
    AND proof.command_type = checked_command_type
    AND proof.command_request_hash = checked_command_request_hash
    AND proof.verified_at <= consumed_time
    AND proof.expires_at > consumed_time
    AND session.revoked_at IS NULL
    AND session.idle_expires_at > consumed_time
    AND session.absolute_expires_at > consumed_time
    AND session.auth_version = actor.auth_version
    AND actor.status = 'active'::user_status
    AND command.command_type = checked_command_type
    AND command.actor_id = checked_user_id::text
    AND command.status = 'received'::command_record_status
    AND command.write_gate_opened_at >= transaction_timestamp();
  IF checked_proof_id IS NULL THEN RETURN false; END IF;

  INSERT INTO public.recent_credential_proof_consumptions (
    proof_id,session_id,user_id,world_id,command_id,command_type,
    command_request_hash,request_id,consumed_at
  ) VALUES (
    checked_proof_id,checked_session_id,checked_user_id,checked_world_id,
    checked_command_id,checked_command_type,checked_command_request_hash,
    checked_request_id,consumed_time
  ) ON CONFLICT (proof_id) DO NOTHING;

  RETURN EXISTS (
    SELECT 1 FROM public.recent_credential_proof_consumptions consumption
    WHERE consumption.proof_id = checked_proof_id
      AND consumption.session_id = checked_session_id
      AND consumption.user_id = checked_user_id
      AND consumption.world_id = checked_world_id
      AND consumption.command_id = checked_command_id
      AND consumption.command_type = checked_command_type
      AND consumption.command_request_hash = checked_command_request_hash
      AND consumption.consumed_at >= (
        SELECT proof.verified_at FROM public.recent_credential_proofs proof
        WHERE proof.id = checked_proof_id
      )
      AND consumption.consumed_at < (
        SELECT proof.expires_at FROM public.recent_credential_proofs proof
        WHERE proof.id = checked_proof_id
      )
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_consume_recent_credential_proof_v1(
  bytea,uuid,uuid,uuid,uuid,text,bytea,text
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_verify_recent_credential_replay_v1(
  checked_proof_hash bytea,
  checked_session_id uuid,
  checked_user_id uuid,
  checked_world_id uuid,
  checked_command_id uuid,
  checked_command_type text,
  checked_command_request_hash bytea,
  checked_request_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT octet_length(checked_proof_hash) = 32
    AND octet_length(checked_command_request_hash) = 32
    AND checked_request_id IS NOT NULL
    AND char_length(checked_request_id) BETWEEN 1 AND 128
    AND checked_request_id !~ '[[:cntrl:]]'
    AND EXISTS (
      SELECT 1
      FROM public.recent_credential_proofs proof
      JOIN public.recent_credential_proof_consumptions consumption
        ON consumption.proof_id = proof.id
       AND consumption.session_id = proof.session_id
       AND consumption.user_id = proof.user_id
       AND consumption.world_id = proof.world_id
       AND consumption.command_id = proof.command_id
       AND consumption.command_type = proof.command_type
       AND consumption.command_request_hash = proof.command_request_hash
      JOIN public.sessions session
        ON session.id = proof.session_id AND session.user_id = proof.user_id
      JOIN public.users actor ON actor.id = session.user_id
      JOIN public.command_records command
        ON command.id = proof.command_id AND command.world_id = proof.world_id
      WHERE proof.proof_hash = checked_proof_hash
        AND proof.session_id = checked_session_id
        AND proof.user_id = checked_user_id
        AND proof.world_id = checked_world_id
        AND proof.command_id = checked_command_id
        AND proof.command_type = checked_command_type
        AND proof.command_request_hash = checked_command_request_hash
        AND session.revoked_at IS NULL
        AND session.idle_expires_at > transaction_timestamp()
        AND session.absolute_expires_at > transaction_timestamp()
        AND session.auth_version = actor.auth_version
        AND actor.status = 'active'::user_status
        AND command.command_type = checked_command_type
        AND command.actor_id = checked_user_id::text
        AND command.status IN (
          'accepted'::command_record_status,
          'rejected'::command_record_status,
          'failed'::command_record_status
        )
        AND command.decided_at IS NOT NULL
        AND consumption.consumed_at >= proof.verified_at
        AND consumption.consumed_at < proof.expires_at
    )
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_verify_recent_credential_replay_v1(
  bytea,uuid,uuid,uuid,uuid,text,bytea,text
) FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE public.public_project_authorizations (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  proposal_action_id uuid NOT NULL UNIQUE,
  proposal_result_id uuid NOT NULL,
  project_entity_id uuid NOT NULL,
  treasury_wallet_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  authorized_minor bigint NOT NULL,
  starts_tick bigint NOT NULL,
  expires_tick bigint,
  purpose_code text NOT NULL,
  terms jsonb NOT NULL,
  checksum bytea NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_project_authorizations_world_identity UNIQUE (world_id,id),
  CONSTRAINT public_project_authorizations_action_world_fk
    FOREIGN KEY (world_id,proposal_action_id)
    REFERENCES public.proposal_actions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT public_project_authorizations_result_world_fk
    FOREIGN KEY (world_id,proposal_result_id)
    REFERENCES public.proposal_results(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT public_project_authorizations_project_world_fk
    FOREIGN KEY (world_id,project_entity_id)
    REFERENCES public.world_entities(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT public_project_authorizations_wallet_world_currency_fk
    FOREIGN KEY (world_id,currency_id,treasury_wallet_id)
    REFERENCES public.wallets(world_id,currency_id,id) ON DELETE RESTRICT,
  CONSTRAINT public_project_authorizations_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT public_project_authorizations_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT public_project_authorizations_shape_valid CHECK (
    authorized_minor > 0 AND starts_tick >= 0
    AND (expires_tick IS NULL OR expires_tick > starts_tick)
    AND char_length(purpose_code) BETWEEN 3 AND 80
    AND purpose_code ~ '^[a-z][a-z0-9._-]*$'
    AND public.worldgraph_governance_json_is_safe_v1(terms,32768)
    AND octet_length(checksum) = 32 AND state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE public.treasury_encumbrances (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  project_authorization_id uuid NOT NULL UNIQUE,
  treasury_wallet_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  maximum_minor bigint NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT treasury_encumbrances_world_identity UNIQUE (world_id,id),
  CONSTRAINT treasury_encumbrances_project_world_fk
    FOREIGN KEY (world_id,project_authorization_id)
    REFERENCES public.public_project_authorizations(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT treasury_encumbrances_wallet_world_currency_fk
    FOREIGN KEY (world_id,currency_id,treasury_wallet_id)
    REFERENCES public.wallets(world_id,currency_id,id) ON DELETE RESTRICT,
  CONSTRAINT treasury_encumbrances_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT treasury_encumbrances_event_world_fk
    FOREIGN KEY (world_id,created_event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT treasury_encumbrances_shape_valid CHECK (
    maximum_minor > 0 AND created_state_revision > 0
  )
);
--> statement-breakpoint
CREATE TABLE public.treasury_encumbrance_facts (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  encumbrance_id uuid NOT NULL,
  fact_sequence integer NOT NULL,
  fact_kind text NOT NULL,
  amount_minor bigint NOT NULL,
  command_id uuid NOT NULL,
  event_id uuid NOT NULL,
  state_revision bigint NOT NULL,
  occurred_tick bigint NOT NULL,
  checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT treasury_encumbrance_facts_world_identity UNIQUE (world_id,id),
  CONSTRAINT treasury_encumbrance_facts_sequence_unique UNIQUE (encumbrance_id,fact_sequence),
  CONSTRAINT treasury_encumbrance_facts_event_unique UNIQUE (event_id),
  CONSTRAINT treasury_encumbrance_facts_encumbrance_world_fk
    FOREIGN KEY (world_id,encumbrance_id)
    REFERENCES public.treasury_encumbrances(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT treasury_encumbrance_facts_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT treasury_encumbrance_facts_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT treasury_encumbrance_facts_shape_valid CHECK (
    fact_sequence BETWEEN 1 AND 2147483647
    AND fact_kind IN ('authorize','consume','release','repair')
    AND amount_minor > 0 AND state_revision > 0 AND occurred_tick >= 0
    AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE TABLE public.treasury_encumbrance_projections (
  encumbrance_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  treasury_wallet_id uuid NOT NULL,
  currency_id uuid NOT NULL,
  authorized_minor bigint NOT NULL,
  consumed_minor bigint NOT NULL DEFAULT 0,
  released_minor bigint NOT NULL DEFAULT 0,
  active_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_fact_sequence integer NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  updated_state_revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT treasury_encumbrance_projections_world_identity UNIQUE (world_id,encumbrance_id),
  CONSTRAINT treasury_encumbrance_projections_encumbrance_world_fk
    FOREIGN KEY (world_id,encumbrance_id)
    REFERENCES public.treasury_encumbrances(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT treasury_encumbrance_projections_wallet_world_currency_fk
    FOREIGN KEY (world_id,currency_id,treasury_wallet_id)
    REFERENCES public.wallets(world_id,currency_id,id) ON DELETE RESTRICT,
  CONSTRAINT treasury_encumbrance_projections_shape_valid CHECK (
    authorized_minor > 0 AND consumed_minor >= 0 AND released_minor >= 0
    AND consumed_minor + released_minor <= authorized_minor
    AND active_minor = authorized_minor - consumed_minor - released_minor
    AND status IN ('active','consumed','released')
    AND ((status = 'active' AND active_minor > 0)
      OR (status = 'consumed' AND consumed_minor = authorized_minor AND active_minor = 0)
      OR (status = 'released' AND released_minor > 0 AND active_minor = 0))
    AND last_fact_sequence > 0 AND row_version > 0 AND updated_state_revision > 0
  )
);
--> statement-breakpoint
CREATE INDEX treasury_encumbrance_wallet_active_idx
  ON public.treasury_encumbrance_projections
  (world_id,treasury_wallet_id,currency_id,encumbrance_id)
  WHERE active_minor > 0;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_treasury_encumbrance_authority_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_row jsonb := to_jsonb(NEW);
  checked_world_id uuid := (changed_row ->> 'world_id')::uuid;
  checked_project_id uuid := COALESCE(
    (changed_row ->> 'project_authorization_id')::uuid,
    (changed_row ->> 'id')::uuid
  );
  checked_wallet_id uuid := (changed_row ->> 'treasury_wallet_id')::uuid;
  checked_currency_id uuid := (changed_row ->> 'currency_id')::uuid;
BEGIN
  IF TG_TABLE_NAME = 'public_project_authorizations' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.wallets wallet
      WHERE wallet.world_id = checked_world_id
        AND wallet.id = checked_wallet_id
        AND wallet.currency_id = checked_currency_id
        AND wallet.wallet_kind = 'treasury'::wallet_kind
    ) THEN
      RAISE EXCEPTION 'public project authorization requires a treasury wallet'
        USING ERRCODE = '23514',
          CONSTRAINT = 'public_project_authorizations_treasury_wallet_exact';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM public.public_project_authorizations project
    JOIN public.wallets wallet
      ON wallet.world_id = project.world_id
     AND wallet.id = project.treasury_wallet_id
     AND wallet.currency_id = project.currency_id
    WHERE project.world_id = checked_world_id
      AND project.id = checked_project_id
      AND project.treasury_wallet_id = checked_wallet_id
      AND project.currency_id = checked_currency_id
      AND project.authorized_minor = (changed_row ->> 'maximum_minor')::bigint
      AND wallet.wallet_kind = 'treasury'::wallet_kind
  ) THEN
    RAISE EXCEPTION 'treasury encumbrance must exactly match its project authority'
      USING ERRCODE = '23514',
        CONSTRAINT = 'treasury_encumbrances_authority_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_treasury_encumbrance_authority_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER public_project_authorizations_require_treasury_wallet
  AFTER INSERT ON public.public_project_authorizations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_treasury_encumbrance_authority_v1();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER treasury_encumbrances_require_exact_authority
  AFTER INSERT ON public.treasury_encumbrances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_treasury_encumbrance_authority_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_wallet_spendable_minor_v1(
  checked_world_id uuid,
  checked_wallet_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
RETURN (
  SELECT balance.available_minor - COALESCE((
    SELECT sum(projection.active_minor)
    FROM public.treasury_encumbrance_projections projection
    WHERE projection.world_id = checked_world_id
      AND projection.treasury_wallet_id = checked_wallet_id
      AND projection.active_minor > 0
  ),0)::bigint
  FROM public.wallet_balances balance
  WHERE balance.world_id = checked_world_id
    AND balance.wallet_id = checked_wallet_id
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_wallet_spendable_minor_v1(uuid,uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_wallet_spendable_minor_v1(checked_wallet_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
RETURN (
  SELECT public.worldgraph_wallet_spendable_minor_v1(balance.world_id,balance.wallet_id)
  FROM public.wallet_balances balance
  WHERE balance.wallet_id = checked_wallet_id
);
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_wallet_spendable_minor_v1(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_treasury_encumbrance_solvency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  checked_world_id uuid := (changed_row ->> 'world_id')::uuid;
  checked_wallet_id uuid := COALESCE(
    (changed_row ->> 'treasury_wallet_id')::uuid,
    (changed_row ->> 'wallet_id')::uuid
  );
  spendable bigint;
BEGIN
  spendable := public.worldgraph_wallet_spendable_minor_v1(
    checked_world_id,checked_wallet_id
  );
  IF spendable IS NULL OR spendable < 0 THEN
    RAISE EXCEPTION 'treasury encumbrances exceed the authoritative wallet balance'
      USING ERRCODE = '23514',
        CONSTRAINT = 'treasury_encumbrances_wallet_solvency';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_treasury_encumbrance_solvency()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER treasury_encumbrance_projections_require_solvency
  AFTER INSERT OR UPDATE ON public.treasury_encumbrance_projections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_treasury_encumbrance_solvency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_balances_preserve_encumbrance_solvency
  AFTER UPDATE OF available_minor ON public.wallet_balances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_treasury_encumbrance_solvency();
--> statement-breakpoint
ALTER TABLE public.tax_policies
  DROP CONSTRAINT tax_policies_active_scope_window_exclusion;
--> statement-breakpoint
CREATE TABLE public.tax_policy_authority_intervals (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  tax_policy_id uuid NOT NULL UNIQUE,
  currency_id uuid NOT NULL,
  tax_type tax_policy_type NOT NULL,
  semantic_scope_key text NOT NULL,
  effective_ticks int8range NOT NULL,
  created_command_id uuid NOT NULL,
  updated_command_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_policy_authority_intervals_world_identity UNIQUE (world_id,id),
  CONSTRAINT tax_policy_authority_intervals_policy_world_fk
    FOREIGN KEY (world_id,tax_policy_id)
    REFERENCES public.tax_policies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT tax_policy_authority_intervals_currency_world_fk
    FOREIGN KEY (world_id,currency_id)
    REFERENCES public.currencies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT tax_policy_authority_intervals_created_command_world_fk
    FOREIGN KEY (created_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT tax_policy_authority_intervals_updated_command_world_fk
    FOREIGN KEY (updated_command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT tax_policy_authority_intervals_shape_valid CHECK (
    semantic_scope_key ~ '^[a-f0-9]{64}$'
    AND public.worldgraph_governance_range_is_valid_v1(effective_ticks)
    AND row_version > 0 AND updated_at >= created_at
  ),
  CONSTRAINT tax_policy_authority_intervals_no_overlap EXCLUDE USING gist (
    world_id WITH =,
    currency_id WITH =,
    tax_type WITH =,
    semantic_scope_key WITH =,
    effective_ticks WITH &&
  )
);
--> statement-breakpoint
INSERT INTO public.tax_policy_authority_intervals (
  id,world_id,tax_policy_id,currency_id,tax_type,semantic_scope_key,
  effective_ticks,created_command_id,updated_command_id,row_version,
  created_at,updated_at
)
SELECT policy.id,policy.world_id,policy.id,policy.currency_id,policy.tax_type,
  encode(extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
    CASE WHEN policy.tax_type = 'periodic_flat'::tax_policy_type
      THEN policy.applicability - 'intervalTicks'
      ELSE policy.applicability END
  ),'UTF8'),'sha256'),'hex'),
  int8range(policy.effective_from_tick,policy.effective_until_tick,'[)'),
  policy.created_command_id,policy.created_command_id,1,
  policy.created_at,policy.created_at
FROM public.tax_policies policy
WHERE policy.status = 'active'::tax_policy_status;
--> statement-breakpoint
CREATE INDEX tax_policy_authority_effective_idx
  ON public.tax_policy_authority_intervals
  USING gist (world_id,currency_id,tax_type,effective_ticks);
--> statement-breakpoint
CREATE TABLE public.governance_tax_policy_lineage (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  previous_tax_policy_id uuid NOT NULL UNIQUE,
  new_tax_policy_id uuid NOT NULL UNIQUE,
  policy_stable_key extensions.citext NOT NULL,
  previous_policy_version integer NOT NULL,
  new_policy_version integer NOT NULL,
  previous_policy_checksum bytea NOT NULL,
  new_policy_checksum bytea NOT NULL,
  proposal_result_id uuid NOT NULL,
  proposal_result_checksum bytea NOT NULL,
  proposal_action_id uuid NOT NULL UNIQUE,
  proposal_action_checksum bytea NOT NULL,
  proposal_enactment_id uuid NOT NULL,
  effective_tick bigint NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  state_revision bigint NOT NULL,
  checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_tax_policy_lineage_world_identity UNIQUE (world_id,id),
  CONSTRAINT governance_tax_policy_lineage_stable_version_unique
    UNIQUE (world_id,policy_stable_key,new_policy_version),
  CONSTRAINT governance_tax_policy_lineage_previous_world_fk
    FOREIGN KEY (world_id,previous_tax_policy_id)
    REFERENCES public.tax_policies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_tax_policy_lineage_new_world_fk
    FOREIGN KEY (world_id,new_tax_policy_id)
    REFERENCES public.tax_policies(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_tax_policy_lineage_result_world_fk
    FOREIGN KEY (world_id,proposal_result_id)
    REFERENCES public.proposal_results(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_tax_policy_lineage_action_world_fk
    FOREIGN KEY (world_id,proposal_action_id)
    REFERENCES public.proposal_actions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT governance_tax_policy_lineage_enactment_world_fk
    FOREIGN KEY (world_id,proposal_enactment_id)
    REFERENCES public.proposal_enactments(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governance_tax_policy_lineage_command_world_fk
    FOREIGN KEY (command_id,world_id)
    REFERENCES public.command_records(id,world_id) ON DELETE RESTRICT,
  CONSTRAINT governance_tax_policy_lineage_event_world_fk
    FOREIGN KEY (world_id,event_id)
    REFERENCES public.domain_events(world_id,id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT governance_tax_policy_lineage_shape_valid CHECK (
    previous_tax_policy_id <> new_tax_policy_id
    AND public.worldgraph_governance_key_is_valid_v1(policy_stable_key::text)
    AND previous_policy_version BETWEEN 1 AND 2147483646
    AND new_policy_version = previous_policy_version + 1
    AND effective_tick >= 0 AND state_revision > 0
    AND octet_length(previous_policy_checksum) = 32
    AND octet_length(new_policy_checksum) = 32
    AND octet_length(proposal_result_checksum) = 32
    AND octet_length(proposal_action_checksum) = 32
    AND octet_length(checksum) = 32
  )
);
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_governance_tax_policy_lineage_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  evidence record;
  expected_action_checksum bytea;
  expected_policy_checksum bytea;
  expected_lineage_checksum bytea;
BEGIN
  SELECT true AS present,
         previous_policy.stable_key::text AS previous_stable_key,
         previous_policy.policy_version AS previous_version,
         previous_policy.checksum AS previous_checksum,
         previous_policy.authority_entity_id AS previous_authority_entity_id,
         previous_policy.treasury_wallet_id AS previous_treasury_wallet_id,
         previous_policy.currency_id AS previous_currency_id,
         previous_policy.tax_type AS previous_tax_type,
         previous_policy.collection_mode AS previous_collection_mode,
         previous_policy.rounding_mode AS previous_rounding_mode,
         previous_policy.fixed_amount_minor AS previous_fixed_amount_minor,
         previous_policy.applicability AS previous_applicability,
         previous_policy.primitive_ref AS previous_primitive_ref,
         previous_policy.primitive_key::text AS previous_primitive_key,
         previous_policy.primitive_version AS previous_primitive_version,
         previous_policy.primitive_version_id AS previous_primitive_version_id,
         previous_policy.primitive_content_hash AS previous_primitive_content_hash,
         previous_policy.source_world_version_id AS previous_source_world_version_id,
         previous_policy.source_plan_hash AS previous_source_plan_hash,
         new_policy.stable_key::text AS new_stable_key,
         new_policy.policy_version AS new_version,
         new_policy.checksum AS new_checksum,
         new_policy.authority_entity_id AS new_authority_entity_id,
         new_policy.treasury_wallet_id AS new_treasury_wallet_id,
         new_policy.currency_id AS new_currency_id,
         new_policy.tax_type AS new_tax_type,
         new_policy.collection_mode AS new_collection_mode,
         new_policy.rounding_mode AS new_rounding_mode,
         new_policy.rate_basis_points AS new_rate_basis_points,
         new_policy.fixed_amount_minor AS new_fixed_amount_minor,
         new_policy.applicability AS new_applicability,
         new_policy.effective_from_tick AS new_policy_effective_from,
         new_policy.effective_until_tick AS new_policy_effective_until,
         new_policy.primitive_ref AS new_primitive_ref,
         new_policy.primitive_key::text AS new_primitive_key,
         new_policy.primitive_version AS new_primitive_version,
         new_policy.primitive_version_id AS new_primitive_version_id,
         new_policy.primitive_content_hash AS new_primitive_content_hash,
         new_policy.source_world_version_id AS new_source_world_version_id,
         new_policy.source_plan_hash AS new_source_plan_hash,
         new_policy.status AS new_status,
         new_policy.calculation_version AS new_calculation_version,
         new_policy.tax_policy_schema_version AS new_schema_version,
         new_policy.created_command_id AS new_created_command_id,
         new_policy.created_event_id AS new_created_event_id,
         new_policy.created_state_revision AS new_created_state_revision,
         action.action_kind,action.action_schema_version,action.action_payload,
         action.checksum AS action_checksum,
         result.result_checksum,result.outcome,result.certified_command_id,
         result.certified_tick,
         enactment.status AS enactment_status,
         enactment.command_id AS enactment_command_id,
         enactment.event_id AS enactment_event_id,
         enactment.state_revision AS enactment_state_revision,
         enactment.enacted_tick,
         action_effect.effect_kind,action_effect.effect_id,
         action_effect.effect_version,action_effect.effect_checksum,
         lower(previous_authority.effective_ticks) AS previous_effective_from,
         upper(previous_authority.effective_ticks) AS previous_effective_until,
         previous_authority.row_version AS previous_authority_version,
         previous_authority.updated_command_id AS previous_authority_updated_command,
         previous_authority.semantic_scope_key AS previous_scope_key,
         lower(new_authority.effective_ticks) AS new_effective_from,
         upper(new_authority.effective_ticks) AS new_effective_until,
         new_authority.row_version AS new_authority_version,
         new_authority.created_command_id AS new_authority_created_command,
         new_authority.updated_command_id AS new_authority_updated_command,
         new_authority.semantic_scope_key AS new_scope_key
    INTO evidence
    FROM public.tax_policies previous_policy
    JOIN public.tax_policies new_policy
      ON new_policy.world_id = previous_policy.world_id
     AND new_policy.id = NEW.new_tax_policy_id
    JOIN public.proposal_results result
      ON result.world_id = previous_policy.world_id
     AND result.id = NEW.proposal_result_id
    JOIN public.proposal_actions action
      ON action.world_id = result.world_id
     AND action.id = NEW.proposal_action_id
     AND action.proposal_id = result.proposal_id
    JOIN public.proposal_enactments enactment
      ON enactment.world_id = result.world_id
     AND enactment.id = NEW.proposal_enactment_id
     AND enactment.proposal_result_id = result.id
    JOIN public.proposal_action_enactments action_effect
      ON action_effect.world_id = enactment.world_id
     AND action_effect.proposal_enactment_id = enactment.id
     AND action_effect.proposal_action_id = action.id
    JOIN public.tax_policy_authority_intervals previous_authority
      ON previous_authority.world_id = previous_policy.world_id
     AND previous_authority.tax_policy_id = previous_policy.id
    JOIN public.tax_policy_authority_intervals new_authority
      ON new_authority.world_id = new_policy.world_id
     AND new_authority.tax_policy_id = new_policy.id
   WHERE previous_policy.world_id = NEW.world_id
     AND previous_policy.id = NEW.previous_tax_policy_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed tax lineage lacks referenced immutable evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'governance_tax_policy_lineage_enactment_exact';
  END IF;

  expected_action_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(evidence.action_payload),'UTF8'
  ),'sha256');
  expected_policy_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'action',evidence.action_payload,
      'policyId',NEW.new_tax_policy_id::text,
      'policyVersion',NEW.new_policy_version
    )),'UTF8'
  ),'sha256');
  expected_lineage_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance-tax-policy-lineage.v1',
      'value',jsonb_build_object(
        'commandId',NEW.command_id::text,
        'effectiveTick',NEW.effective_tick::text,
        'eventId',NEW.event_id::text,
        'lineageId',NEW.id::text,
        'newPolicyChecksum',encode(NEW.new_policy_checksum,'hex'),
        'newPolicyId',NEW.new_tax_policy_id::text,
        'newPolicyVersion',NEW.new_policy_version,
        'policyStableKey',NEW.policy_stable_key::text,
        'previousPolicyChecksum',encode(NEW.previous_policy_checksum,'hex'),
        'previousPolicyId',NEW.previous_tax_policy_id::text,
        'previousPolicyVersion',NEW.previous_policy_version,
        'proposalActionChecksum',encode(NEW.proposal_action_checksum,'hex'),
        'proposalActionId',NEW.proposal_action_id::text,
        'proposalEnactmentId',NEW.proposal_enactment_id::text,
        'proposalResultChecksum',encode(NEW.proposal_result_checksum,'hex'),
        'proposalResultId',NEW.proposal_result_id::text,
        'stateRevision',NEW.state_revision::text
      )
    )),'UTF8'
  ),'sha256');

  IF evidence.previous_stable_key IS DISTINCT FROM NEW.policy_stable_key::text
    OR evidence.previous_version IS DISTINCT FROM NEW.previous_policy_version
    OR evidence.previous_checksum IS DISTINCT FROM NEW.previous_policy_checksum
    OR evidence.new_stable_key IS DISTINCT FROM NEW.policy_stable_key::text
    OR evidence.new_version IS DISTINCT FROM NEW.new_policy_version
    OR evidence.new_checksum IS DISTINCT FROM NEW.new_policy_checksum
    OR evidence.new_authority_entity_id IS DISTINCT FROM evidence.previous_authority_entity_id
    OR evidence.new_treasury_wallet_id IS DISTINCT FROM evidence.previous_treasury_wallet_id
    OR evidence.new_currency_id IS DISTINCT FROM evidence.previous_currency_id
    OR evidence.new_tax_type IS DISTINCT FROM evidence.previous_tax_type
    OR evidence.new_collection_mode IS DISTINCT FROM evidence.previous_collection_mode
    OR evidence.new_rounding_mode IS DISTINCT FROM evidence.previous_rounding_mode
    OR evidence.new_fixed_amount_minor IS DISTINCT FROM evidence.previous_fixed_amount_minor
    OR evidence.new_applicability IS DISTINCT FROM evidence.previous_applicability
    OR evidence.new_primitive_ref IS DISTINCT FROM evidence.previous_primitive_ref
    OR evidence.new_primitive_key IS DISTINCT FROM evidence.previous_primitive_key
    OR evidence.new_primitive_version IS DISTINCT FROM evidence.previous_primitive_version
    OR evidence.new_primitive_version_id IS DISTINCT FROM evidence.previous_primitive_version_id
    OR evidence.new_primitive_content_hash IS DISTINCT FROM evidence.previous_primitive_content_hash
    OR evidence.new_source_world_version_id IS DISTINCT FROM evidence.previous_source_world_version_id
    OR evidence.new_source_plan_hash IS DISTINCT FROM evidence.previous_source_plan_hash
    OR evidence.new_policy_effective_from IS DISTINCT FROM NEW.effective_tick
    OR evidence.new_policy_effective_until IS NOT NULL
    OR evidence.new_status IS DISTINCT FROM 'active'::tax_policy_status
    OR evidence.new_calculation_version IS DISTINCT FROM 1
    OR evidence.new_schema_version IS DISTINCT FROM 1
    OR evidence.new_created_command_id IS DISTINCT FROM NEW.command_id
    OR evidence.new_created_event_id IS DISTINCT FROM NEW.event_id
    OR evidence.new_created_state_revision IS DISTINCT FROM NEW.state_revision
    OR evidence.action_kind IS DISTINCT FROM 'tax_policy_update'
    OR evidence.action_schema_version IS DISTINCT FROM 1
    OR evidence.action_payload IS DISTINCT FROM jsonb_build_object(
      'actionSchemaVersion',1,
      'actionType','update_tax',
      'effectiveFromTick',NEW.effective_tick::text,
      'expectedTaxPolicyVersion',NEW.previous_policy_version::text,
      'newRateBps',evidence.new_rate_basis_points,
      'taxPolicyId',NEW.previous_tax_policy_id::text
    )
    OR evidence.action_checksum IS DISTINCT FROM expected_action_checksum
    OR evidence.action_checksum IS DISTINCT FROM NEW.proposal_action_checksum
    OR evidence.result_checksum IS DISTINCT FROM NEW.proposal_result_checksum
    OR evidence.outcome IS DISTINCT FROM 'passed'
    OR evidence.certified_command_id IS DISTINCT FROM NEW.command_id
    OR evidence.certified_tick IS DISTINCT FROM NEW.effective_tick
    OR evidence.enactment_status IS DISTINCT FROM 'succeeded'
    OR evidence.enactment_command_id IS DISTINCT FROM NEW.command_id
    OR evidence.enactment_event_id IS DISTINCT FROM NEW.event_id
    OR evidence.enactment_state_revision IS DISTINCT FROM NEW.state_revision
    OR evidence.enacted_tick IS DISTINCT FROM NEW.effective_tick
    OR evidence.effect_kind IS DISTINCT FROM 'tax_policy'
    OR evidence.effect_id IS DISTINCT FROM NEW.new_tax_policy_id
    OR evidence.effect_version IS DISTINCT FROM NEW.new_policy_version
    OR evidence.effect_checksum IS DISTINCT FROM NEW.new_policy_checksum
    OR evidence.new_checksum IS DISTINCT FROM expected_policy_checksum
    OR evidence.previous_effective_until IS DISTINCT FROM NEW.effective_tick
    OR evidence.previous_authority_version IS DISTINCT FROM 2
    OR evidence.previous_authority_updated_command IS DISTINCT FROM NEW.command_id
    OR evidence.new_effective_from IS DISTINCT FROM NEW.effective_tick
    OR evidence.new_effective_until IS NOT NULL
    OR evidence.new_authority_version IS DISTINCT FROM 1
    OR evidence.new_authority_created_command IS DISTINCT FROM NEW.command_id
    OR evidence.new_authority_updated_command IS DISTINCT FROM NEW.command_id
    OR evidence.new_scope_key IS DISTINCT FROM evidence.previous_scope_key
    OR NEW.checksum IS DISTINCT FROM expected_lineage_checksum THEN
    RAISE EXCEPTION 'governed tax lineage lacks exact immutable policy and enactment evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'governance_tax_policy_lineage_enactment_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_governance_tax_policy_lineage_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER governance_tax_policy_lineage_require_enactment
  AFTER INSERT ON public.governance_tax_policy_lineage
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_governance_tax_policy_lineage_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_tax_policy_effective_at_v2(
  checked_world_id uuid,
  checked_tax_type tax_policy_type,
  checked_tick bigint
)
RETURNS SETOF public.tax_policies
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT policy.*
  FROM public.tax_policy_authority_intervals authority
  JOIN public.tax_policies policy
    ON policy.world_id = authority.world_id
   AND policy.id = authority.tax_policy_id
  WHERE authority.world_id = checked_world_id
    AND authority.tax_type = checked_tax_type
    AND authority.effective_ticks @> checked_tick
  ORDER BY authority.semantic_scope_key COLLATE "C", policy.stable_key::text COLLATE "C", policy.id
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_tax_policy_effective_at_v2(
  uuid,tax_policy_type,bigint
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_tax_policy_authority_interval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  open_command_id uuid := NULLIF(current_setting('worldgraph.command_id',true),'')::uuid;
  open_command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax policy authority intervals cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type INTO open_command_type
  FROM public.command_records command
  WHERE command.id = open_command_id
    AND command.world_id = COALESCE(NEW.world_id,OLD.world_id)
    AND public.worldgraph_command_write_is_open(command.world_id,command.id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_command_id IS DISTINCT FROM open_command_id
      OR NEW.updated_command_id IS DISTINCT FROM open_command_id
      OR open_command_type NOT IN ('InitializeWorldCommerceV1','CertifyAndEnactProposalV1')
      OR NOT EXISTS (
        SELECT 1 FROM public.tax_policies policy
        WHERE policy.world_id = NEW.world_id AND policy.id = NEW.tax_policy_id
          AND policy.currency_id = NEW.currency_id AND policy.tax_type = NEW.tax_type
          AND lower(NEW.effective_ticks) = policy.effective_from_tick
      ) THEN
      RAISE EXCEPTION 'tax policy authority interval requires its exact policy command'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF open_command_type IS DISTINCT FROM 'CertifyAndEnactProposalV1'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.tax_policy_id IS DISTINCT FROM OLD.tax_policy_id
    OR NEW.currency_id IS DISTINCT FROM OLD.currency_id
    OR NEW.tax_type IS DISTINCT FROM OLD.tax_type
    OR NEW.semantic_scope_key IS DISTINCT FROM OLD.semantic_scope_key
    OR lower(NEW.effective_ticks) IS DISTINCT FROM lower(OLD.effective_ticks)
    OR upper(OLD.effective_ticks) IS NOT NULL
    OR upper(NEW.effective_ticks) IS NULL
    OR upper(NEW.effective_ticks) <= lower(NEW.effective_ticks)
    OR NEW.created_command_id IS DISTINCT FROM OLD.created_command_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_command_id IS DISTINCT FROM open_command_id
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'tax policy authority interval transition is invalid or ungoverned'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_tax_policy_authority_interval()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER tax_policy_authority_intervals_protect
  BEFORE INSERT OR UPDATE OR DELETE ON public.tax_policy_authority_intervals
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_tax_policy_authority_interval();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_create_tax_policy_authority_interval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
BEGIN
  IF NEW.status = 'active'::tax_policy_status THEN
    INSERT INTO public.tax_policy_authority_intervals (
      id,world_id,tax_policy_id,currency_id,tax_type,semantic_scope_key,
      effective_ticks,created_command_id,updated_command_id,row_version,
      created_at,updated_at
    ) VALUES (
      NEW.id,NEW.world_id,NEW.id,NEW.currency_id,NEW.tax_type,
      encode(extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        CASE WHEN NEW.tax_type = 'periodic_flat'::tax_policy_type
          THEN NEW.applicability - 'intervalTicks'
          ELSE NEW.applicability END
      ),'UTF8'),'sha256'),'hex'),
      int8range(NEW.effective_from_tick,NEW.effective_until_tick,'[)'),
      NEW.created_command_id,NEW.created_command_id,1,NEW.created_at,NEW.created_at
    );
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_create_tax_policy_authority_interval()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER tax_policies_create_authority_interval
  AFTER INSERT ON public.tax_policies
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_create_tax_policy_authority_interval();
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
  governed_tax_gate uuid := NULLIF(
    current_setting('worldgraph.governed_tax_policy_id',true),''
  )::uuid;
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
      'employment_offers'
    ) AND checked_command_type IS DISTINCT FROM 'InitializeWorldCommerceV1')
    OR (TG_TABLE_NAME = 'business_facility_recipe_versions'
      AND checked_command_type NOT IN (
        'InitializeWorldCommerceV1','ConfigureBusinessFacilityV1'
      ))
    OR (TG_TABLE_NAME = 'tax_policies' AND NOT (
      checked_command_type = 'InitializeWorldCommerceV1'
      OR (checked_command_type = 'CertifyAndEnactProposalV1'
        AND governed_tax_gate = (row_value ->> 'id')::uuid)
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
CREATE FUNCTION public.worldgraph_insert_governed_tax_policy_v1(
  checked_lineage_id uuid,
  checked_world_id uuid,
  checked_previous_tax_policy_id uuid,
  checked_new_tax_policy_id uuid,
  checked_stable_key text,
  checked_policy_version integer,
  checked_authority_entity_id uuid,
  checked_treasury_wallet_id uuid,
  checked_currency_id uuid,
  checked_tax_type tax_policy_type,
  checked_collection_mode tax_collection_mode,
  checked_rate_basis_points integer,
  checked_fixed_amount_minor bigint,
  checked_applicability jsonb,
  checked_effective_from_tick bigint,
  checked_primitive_ref text,
  checked_primitive_key text,
  checked_primitive_version text,
  checked_primitive_version_id uuid,
  checked_primitive_content_hash bytea,
  checked_source_world_version_id uuid,
  checked_source_plan_hash bytea,
  checked_proposal_result_id uuid,
  checked_proposal_action_id uuid,
  checked_proposal_enactment_id uuid,
  checked_command_id uuid,
  checked_event_id uuid,
  checked_state_revision bigint,
  checked_policy_checksum bytea
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  previous_policy public.tax_policies%ROWTYPE;
  previous_authority public.tax_policy_authority_intervals%ROWTYPE;
  proposal_action_record public.proposal_actions%ROWTYPE;
  proposal_result_record public.proposal_results%ROWTYPE;
  expected_action_checksum bytea;
  expected_policy_checksum bytea;
  expected_lineage_checksum bytea;
  expected_scope_key text;
BEGIN
  IF checked_lineage_id IS NULL OR checked_world_id IS NULL
    OR checked_previous_tax_policy_id IS NULL OR checked_new_tax_policy_id IS NULL
    OR checked_previous_tax_policy_id = checked_new_tax_policy_id
    OR checked_proposal_result_id IS NULL OR checked_proposal_action_id IS NULL
    OR checked_proposal_enactment_id IS NULL
    OR checked_command_id IS NULL OR checked_event_id IS NULL
    OR checked_effective_from_tick < 0 OR checked_state_revision < 1
    OR octet_length(checked_policy_checksum) <> 32 THEN
    RAISE EXCEPTION 'governed tax policy inputs are invalid' USING ERRCODE = '22023';
  END IF;
  IF checked_command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')::uuid
    OR public.worldgraph_commerce_command_type(checked_world_id)
      IS DISTINCT FROM 'CertifyAndEnactProposalV1'
    OR NOT public.worldgraph_command_write_is_open(checked_world_id,checked_command_id) THEN
    RAISE EXCEPTION 'governed tax policy requires its exact open enactment command'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.command_records command
    JOIN public.world_simulation_clocks clock ON clock.world_id=command.world_id
    WHERE command.id=checked_command_id AND command.world_id=checked_world_id
      AND command.expected_tick=checked_effective_from_tick
      AND clock.current_tick=checked_effective_from_tick
  ) THEN
    RAISE EXCEPTION 'governed tax authority must begin at the locked command tick'
      USING ERRCODE = '23514';
  END IF;
  SELECT result.* INTO proposal_result_record
    FROM public.proposal_results result
    WHERE result.world_id = checked_world_id
      AND result.id = checked_proposal_result_id
      AND result.outcome = 'passed'
      AND result.certified_command_id = checked_command_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed tax policy lacks exact passed result lineage'
      USING ERRCODE = '23514';
  END IF;
  IF proposal_result_record.certified_tick IS DISTINCT FROM checked_effective_from_tick THEN
    RAISE EXCEPTION 'governed tax authority must begin at the certification tick'
      USING ERRCODE = '23514';
  END IF;
  SELECT action.* INTO proposal_action_record
    FROM public.proposal_results result
    JOIN public.proposal_actions action
      ON action.world_id = result.world_id AND action.proposal_id = result.proposal_id
    WHERE result.world_id = checked_world_id
      AND result.id = checked_proposal_result_id
      AND result.outcome = 'passed'
      AND result.certified_command_id = checked_command_id
      AND action.id = checked_proposal_action_id
      AND action.action_kind = 'tax_policy_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governed tax policy lacks exact passed action lineage'
      USING ERRCODE = '23514';
  END IF;
  expected_action_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(proposal_action_record.action_payload),'UTF8'
  ),'sha256');
  IF proposal_action_record.checksum IS DISTINCT FROM expected_action_checksum THEN
    RAISE EXCEPTION 'governed tax policy action checksum is invalid'
      USING ERRCODE = '23514';
  END IF;
  SELECT policy.* INTO previous_policy
  FROM public.tax_policies policy
  WHERE policy.world_id = checked_world_id
    AND policy.id = checked_previous_tax_policy_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'previous tax policy is missing' USING ERRCODE = '23503';
  END IF;
  SELECT authority.* INTO previous_authority
  FROM public.tax_policy_authority_intervals authority
  WHERE authority.world_id = checked_world_id
    AND authority.tax_policy_id = checked_previous_tax_policy_id
  FOR UPDATE;
  IF NOT FOUND OR upper(previous_authority.effective_ticks) IS NOT NULL
    OR checked_effective_from_tick <= lower(previous_authority.effective_ticks)
    OR NOT previous_authority.effective_ticks @> checked_effective_from_tick THEN
    RAISE EXCEPTION 'previous tax policy is not the active authority at the requested tick'
      USING ERRCODE = '55000';
  END IF;
  expected_scope_key := encode(extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(
      CASE WHEN checked_tax_type = 'periodic_flat'::tax_policy_type
        THEN checked_applicability - 'intervalTicks'
        ELSE checked_applicability END
    ),'UTF8'),'sha256'),'hex');
  IF checked_stable_key IS DISTINCT FROM previous_policy.stable_key::text
    OR checked_policy_version <> previous_policy.policy_version + 1
    OR checked_authority_entity_id IS DISTINCT FROM previous_policy.authority_entity_id
    OR checked_treasury_wallet_id IS DISTINCT FROM previous_policy.treasury_wallet_id
    OR checked_currency_id IS DISTINCT FROM previous_policy.currency_id
    OR checked_tax_type IS DISTINCT FROM previous_policy.tax_type
    OR checked_collection_mode IS DISTINCT FROM previous_policy.collection_mode
    OR expected_scope_key IS DISTINCT FROM previous_authority.semantic_scope_key
    OR proposal_action_record.action_payload IS DISTINCT FROM jsonb_build_object(
      'actionSchemaVersion',1,
      'actionType','update_tax',
      'effectiveFromTick',checked_effective_from_tick::text,
      'expectedTaxPolicyVersion',previous_policy.policy_version::text,
      'newRateBps',checked_rate_basis_points,
      'taxPolicyId',checked_previous_tax_policy_id::text
    ) THEN
    RAISE EXCEPTION 'governed tax update may change only the bounded policy value'
      USING ERRCODE = '23514';
  END IF;
  expected_policy_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'action',proposal_action_record.action_payload,
      'policyId',checked_new_tax_policy_id::text,
      'policyVersion',checked_policy_version
    )),'UTF8'
  ),'sha256');
  IF checked_policy_checksum IS DISTINCT FROM expected_policy_checksum THEN
    RAISE EXCEPTION 'governed tax policy checksum is not canonical'
      USING ERRCODE = '23514';
  END IF;
  expected_lineage_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance-tax-policy-lineage.v1',
      'value',jsonb_build_object(
        'commandId',checked_command_id::text,
        'effectiveTick',checked_effective_from_tick::text,
        'eventId',checked_event_id::text,
        'lineageId',checked_lineage_id::text,
        'newPolicyChecksum',encode(checked_policy_checksum,'hex'),
        'newPolicyId',checked_new_tax_policy_id::text,
        'newPolicyVersion',checked_policy_version,
        'policyStableKey',checked_stable_key,
        'previousPolicyChecksum',encode(previous_policy.checksum,'hex'),
        'previousPolicyId',checked_previous_tax_policy_id::text,
        'previousPolicyVersion',previous_policy.policy_version,
        'proposalActionChecksum',encode(proposal_action_record.checksum,'hex'),
        'proposalActionId',checked_proposal_action_id::text,
        'proposalEnactmentId',checked_proposal_enactment_id::text,
        'proposalResultChecksum',encode(proposal_result_record.result_checksum,'hex'),
        'proposalResultId',checked_proposal_result_id::text,
        'stateRevision',checked_state_revision::text
      )
    )),'UTF8'
  ),'sha256');

  PERFORM set_config(
    'worldgraph.governed_tax_policy_id',checked_new_tax_policy_id::text,true
  );
  UPDATE public.tax_policy_authority_intervals
  SET effective_ticks = int8range(lower(effective_ticks),checked_effective_from_tick,'[)'),
      updated_command_id = checked_command_id,
      row_version = row_version + 1,
      updated_at = clock_timestamp()
  WHERE id = previous_authority.id;

  INSERT INTO public.tax_policies (
    id,world_id,stable_key,policy_version,authority_entity_id,treasury_wallet_id,
    currency_id,tax_type,collection_mode,rounding_mode,rate_basis_points,
    fixed_amount_minor,applicability,effective_from_tick,effective_until_tick,
    primitive_ref,primitive_key,primitive_version,primitive_version_id,
    primitive_content_hash,source_world_version_id,source_plan_hash,status,
    calculation_version,tax_policy_schema_version,checksum,created_command_id,
    created_event_id,created_state_revision
  ) VALUES (
    checked_new_tax_policy_id,checked_world_id,checked_stable_key,
    checked_policy_version,checked_authority_entity_id,checked_treasury_wallet_id,
    checked_currency_id,checked_tax_type,checked_collection_mode,'floor',
    checked_rate_basis_points,checked_fixed_amount_minor,checked_applicability,
    checked_effective_from_tick,NULL,checked_primitive_ref,checked_primitive_key,
    checked_primitive_version,checked_primitive_version_id,
    checked_primitive_content_hash,checked_source_world_version_id,
    checked_source_plan_hash,'active',1,1,checked_policy_checksum,
    checked_command_id,checked_event_id,checked_state_revision
  );
  PERFORM set_config('worldgraph.governed_tax_policy_id','',true);

  INSERT INTO public.governance_tax_policy_lineage (
    id,world_id,previous_tax_policy_id,new_tax_policy_id,policy_stable_key,
    previous_policy_version,new_policy_version,previous_policy_checksum,
    new_policy_checksum,proposal_result_id,proposal_result_checksum,
    proposal_action_id,proposal_action_checksum,proposal_enactment_id,
    effective_tick,command_id,event_id,state_revision,checksum
  ) VALUES (
    checked_lineage_id,checked_world_id,checked_previous_tax_policy_id,
    checked_new_tax_policy_id,checked_stable_key,previous_policy.policy_version,
    checked_policy_version,previous_policy.checksum,checked_policy_checksum,
    checked_proposal_result_id,proposal_result_record.result_checksum,
    checked_proposal_action_id,proposal_action_record.checksum,
    checked_proposal_enactment_id,checked_effective_from_tick,checked_command_id,
    checked_event_id,checked_state_revision,expected_lineage_checksum
  );
  RETURN checked_new_tax_policy_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('worldgraph.governed_tax_policy_id','',true);
  RAISE;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_insert_governed_tax_policy_v1(
  uuid,uuid,uuid,uuid,text,integer,uuid,uuid,uuid,tax_policy_type,
  tax_collection_mode,integer,bigint,jsonb,bigint,text,text,text,uuid,bytea,
  uuid,bytea,uuid,uuid,uuid,uuid,uuid,bigint,bytea
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_economy_reconciliation_tax_documents_v3(
  checked_world_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
AS $function$
WITH RECURSIVE
seed_authority AS (
  SELECT head.initialized_command_id,head.initialized_event_id,
         initialized.resulting_state_revision AS initialized_state_revision,
         plan.world_version_id,plan.plan_hash,plan.canonical_plan
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
seed_policy_rows AS (
  SELECT item.value ->> 'stableKey' AS stable_key,
         1 AS policy_version,
         (
           SELECT lineage.previous_tax_policy_id
           FROM public.governance_tax_policy_lineage lineage
           WHERE lineage.world_id = checked_world_id
             AND lineage.policy_stable_key::text = item.value ->> 'stableKey'
             AND lineage.previous_policy_version = 1
           LIMIT 1
         ) AS policy_id,
         item.value ->> 'taxType' AS tax_type,
         CASE WHEN item.value ->> 'taxType' = 'periodic_flat'
           THEN jsonb_build_object(
             'intervalTicks',item.value ->> 'intervalTicks',
             'payerEntityId',payer.id::text,
             'payerWalletId',payer_wallet.id::text
           )
           ELSE '{}'::jsonb
         END AS applicability,
         seed.canonical_plan -> 'currency' ->> 'stableKey' AS currency_stable_key,
         jsonb_build_object(
           'applicability',CASE WHEN item.value ->> 'taxType' = 'periodic_flat'
             THEN jsonb_build_object(
               'intervalTicks',item.value ->> 'intervalTicks',
               'payerEntityId',payer.id::text,
               'payerWalletId',payer_wallet.id::text
             )
             ELSE '{}'::jsonb END,
           'calculationVersion',1,
           'checksum',encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(jsonb_build_object(
               'domain','worldgraph.tax-policy.v1','policy',item.value
             )),'UTF8'
           ),'sha256'),'hex'),
           'createdCommandId',seed.initialized_command_id::text,
           'createdEventId',seed.initialized_event_id::text,
           'createdStateRevision',seed.initialized_state_revision::text,
           'currencyStableKey',seed.canonical_plan -> 'currency' ->> 'stableKey',
           'policy',item.value,
           'policyVersion',1,
           'sourcePlanHash',encode(seed.plan_hash,'hex'),
           'sourceWorldVersionId',seed.world_version_id::text
         ) AS document
  FROM seed_authority seed
  CROSS JOIN LATERAL jsonb_array_elements(seed.canonical_plan -> 'taxPolicies') item(value)
  LEFT JOIN public.world_entities payer
    ON item.value ->> 'taxType' = 'periodic_flat'
   AND payer.world_id = checked_world_id
   AND payer.logical_key::text = item.value ->> 'payerEntityLogicalKey'
  LEFT JOIN public.wallets payer_wallet
    ON item.value ->> 'taxType' = 'periodic_flat'
   AND payer_wallet.world_id = checked_world_id
   AND payer_wallet.stable_key::text = item.value ->> 'payerWalletStableKey'
),
rebuilt_policy_rows(
  stable_key,policy_version,policy_id,tax_type,applicability,
  currency_stable_key,document,depth
) AS (
  SELECT seed.stable_key,seed.policy_version,seed.policy_id,seed.tax_type,
         seed.applicability,seed.currency_stable_key,seed.document,0
  FROM seed_policy_rows seed
  UNION ALL
  SELECT previous.stable_key,lineage.new_policy_version,lineage.new_tax_policy_id,
         previous.tax_type,previous.applicability,previous.currency_stable_key,
         jsonb_build_object(
           'applicability',previous.applicability,
           'calculationVersion',1,
           'checksum',encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(jsonb_build_object(
               'action',action.action_payload,
               'policyId',lineage.new_tax_policy_id::text,
               'policyVersion',lineage.new_policy_version
             )),'UTF8'
           ),'sha256'),'hex'),
           'createdCommandId',lineage.command_id::text,
           'createdEventId',lineage.event_id::text,
           'createdStateRevision',lineage.state_revision::text,
           'currencyStableKey',previous.currency_stable_key,
           'policy',(previous.document -> 'policy') || jsonb_build_object(
             'effectiveFromTick',lineage.effective_tick::text,
             'effectiveUntilTick',NULL,
             'rateBps',action.action_payload -> 'newRateBps'
           ),
           'policyVersion',lineage.new_policy_version,
           'sourcePlanHash',previous.document ->> 'sourcePlanHash',
           'sourceWorldVersionId',previous.document ->> 'sourceWorldVersionId'
         ),previous.depth + 1
  FROM rebuilt_policy_rows previous
  JOIN public.governance_tax_policy_lineage lineage
    ON lineage.world_id = checked_world_id
   AND lineage.policy_stable_key::text = previous.stable_key
   AND lineage.previous_policy_version = previous.policy_version
   AND (
     previous.policy_id IS NULL
     OR lineage.previous_tax_policy_id = previous.policy_id
   )
  JOIN public.proposal_actions action
    ON action.world_id = lineage.world_id
   AND action.id = lineage.proposal_action_id
  WHERE previous.depth < 1024
),
lineage_children AS (
  SELECT lineage.policy_stable_key::text AS stable_key,
         lineage.previous_policy_version AS policy_version,
         lineage.effective_tick,lineage.command_id
  FROM public.governance_tax_policy_lineage lineage
  WHERE lineage.world_id = checked_world_id
),
authority_live_rows AS (
  SELECT concat(policy.stable_key::text,':v',policy.policy_version::text) AS id,
         jsonb_build_object(
           'createdCommandId',authority.created_command_id::text,
           'currencyStableKey',currency.stable_key::text,
           'effectiveFromTick',lower(authority.effective_ticks)::text,
           'effectiveUntilTick',upper(authority.effective_ticks)::text,
           'policyStableKey',policy.stable_key::text,
           'policyVersion',policy.policy_version,
           'rowVersion',authority.row_version::text,
           'semanticScopeKey',authority.semantic_scope_key,
           'taxType',authority.tax_type::text,
           'updatedCommandId',authority.updated_command_id::text
         ) AS document
  FROM public.tax_policy_authority_intervals authority
  JOIN public.tax_policies policy
    ON policy.world_id = authority.world_id AND policy.id = authority.tax_policy_id
  JOIN public.currencies currency
    ON currency.world_id = authority.world_id AND currency.id = authority.currency_id
  WHERE authority.world_id = checked_world_id
),
authority_rebuilt_rows AS (
  SELECT concat(policy.stable_key,':v',policy.policy_version::text) AS id,
         jsonb_build_object(
           'createdCommandId',policy.document ->> 'createdCommandId',
           'currencyStableKey',policy.currency_stable_key,
           'effectiveFromTick',policy.document -> 'policy' ->> 'effectiveFromTick',
           'effectiveUntilTick',CASE WHEN child.stable_key IS NULL
             THEN policy.document -> 'policy' ->> 'effectiveUntilTick'
             ELSE child.effective_tick::text END,
           'policyStableKey',policy.stable_key,
           'policyVersion',policy.policy_version,
           'rowVersion',CASE WHEN child.stable_key IS NULL THEN '1' ELSE '2' END,
           'semanticScopeKey',encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(
               CASE WHEN policy.tax_type = 'periodic_flat'
                 THEN policy.applicability - 'intervalTicks'
                 ELSE policy.applicability END
             ),'UTF8'
           ),'sha256'),'hex'),
           'taxType',policy.tax_type,
           'updatedCommandId',COALESCE(
             child.command_id::text,policy.document ->> 'createdCommandId'
           )
         ) AS document
  FROM rebuilt_policy_rows policy
  LEFT JOIN lineage_children child
    ON child.stable_key = policy.stable_key
   AND child.policy_version = policy.policy_version
),
lineage_live_rows AS (
  SELECT lineage.id,
         jsonb_build_object(
           'checksum',encode(lineage.checksum,'hex'),
           'commandId',lineage.command_id::text,
           'effectiveTick',lineage.effective_tick::text,
           'eventId',lineage.event_id::text,
           'evidenceValid',true,
           'lineageId',lineage.id::text,
           'newPolicyChecksum',encode(lineage.new_policy_checksum,'hex'),
           'newPolicyId',lineage.new_tax_policy_id::text,
           'newPolicyVersion',lineage.new_policy_version,
           'policyStableKey',lineage.policy_stable_key::text,
           'previousPolicyChecksum',encode(lineage.previous_policy_checksum,'hex'),
           'previousPolicyId',lineage.previous_tax_policy_id::text,
           'previousPolicyVersion',lineage.previous_policy_version,
           'proposalActionChecksum',encode(lineage.proposal_action_checksum,'hex'),
           'proposalActionId',lineage.proposal_action_id::text,
           'proposalEnactmentId',lineage.proposal_enactment_id::text,
           'proposalResultChecksum',encode(lineage.proposal_result_checksum,'hex'),
           'proposalResultId',lineage.proposal_result_id::text,
           'stateRevision',lineage.state_revision::text
         ) AS document
  FROM public.governance_tax_policy_lineage lineage
  WHERE lineage.world_id = checked_world_id
),
lineage_evidence AS (
  SELECT lineage.*,
         previous.document AS previous_document,
         previous.policy_id AS rebuilt_previous_policy_id,
         following.document AS new_document,
         following.policy_id AS rebuilt_new_policy_id,
         action.proposal_id AS action_proposal_id,
         action.action_kind,action.action_schema_version,action.action_payload,
         extensions.digest(convert_to(
           public.worldgraph_canonical_jsonb(action.action_payload),'UTF8'
         ),'sha256') AS expected_action_checksum,
         result.proposal_id AS result_proposal_id,result.outcome,
         result.result_checksum,result.certified_command_id,result.certified_tick,
         enactment.proposal_result_id AS enacted_result_id,
         enactment.status AS enactment_status,
         enactment.command_id AS enactment_command_id,
         enactment.event_id AS enactment_event_id,
         enactment.state_revision AS enactment_state_revision,
         enactment.enacted_tick,
         effect.effect_kind,effect.effect_id,effect.effect_version,effect.effect_checksum
  FROM public.governance_tax_policy_lineage lineage
  LEFT JOIN rebuilt_policy_rows previous
    ON previous.stable_key = lineage.policy_stable_key::text
   AND previous.policy_version = lineage.previous_policy_version
   AND previous.policy_id = lineage.previous_tax_policy_id
  LEFT JOIN rebuilt_policy_rows following
    ON following.stable_key = lineage.policy_stable_key::text
   AND following.policy_version = lineage.new_policy_version
   AND following.policy_id = lineage.new_tax_policy_id
  LEFT JOIN public.proposal_actions action
    ON action.world_id = lineage.world_id AND action.id = lineage.proposal_action_id
  LEFT JOIN public.proposal_results result
    ON result.world_id = lineage.world_id AND result.id = lineage.proposal_result_id
  LEFT JOIN public.proposal_enactments enactment
    ON enactment.world_id = lineage.world_id
   AND enactment.id = lineage.proposal_enactment_id
  LEFT JOIN public.proposal_action_enactments effect
    ON effect.world_id = lineage.world_id
   AND effect.proposal_enactment_id = lineage.proposal_enactment_id
   AND effect.proposal_action_id = lineage.proposal_action_id
  WHERE lineage.world_id = checked_world_id
),
lineage_expected AS (
  SELECT evidence.*,
         decode(evidence.previous_document ->> 'checksum','hex')
           AS expected_previous_checksum,
         decode(evidence.new_document ->> 'checksum','hex') AS expected_new_checksum,
         COALESCE(
           evidence.rebuilt_previous_policy_id = evidence.previous_tax_policy_id
           AND evidence.rebuilt_new_policy_id = evidence.new_tax_policy_id
           AND evidence.action_proposal_id = evidence.result_proposal_id
           AND evidence.action_kind = 'tax_policy_update'
           AND evidence.action_schema_version = 1
           AND evidence.action_payload = jsonb_build_object(
             'actionSchemaVersion',1,
             'actionType','update_tax',
             'effectiveFromTick',evidence.effective_tick::text,
             'expectedTaxPolicyVersion',evidence.previous_policy_version::text,
             'newRateBps',evidence.new_document -> 'policy' -> 'rateBps',
             'taxPolicyId',evidence.previous_tax_policy_id::text
           )
           AND evidence.outcome = 'passed'
           AND evidence.certified_command_id = evidence.command_id
           AND evidence.certified_tick = evidence.effective_tick
           AND evidence.enacted_result_id = evidence.proposal_result_id
           AND evidence.enactment_status = 'succeeded'
           AND evidence.enactment_command_id = evidence.command_id
           AND evidence.enactment_event_id = evidence.event_id
           AND evidence.enactment_state_revision = evidence.state_revision
           AND evidence.enacted_tick = evidence.effective_tick
           AND evidence.effect_kind = 'tax_policy'
           AND evidence.effect_id = evidence.new_tax_policy_id
           AND evidence.effect_version = evidence.new_policy_version
           AND evidence.effect_checksum = decode(evidence.new_document ->> 'checksum','hex'),
           false
         ) AS evidence_valid
  FROM lineage_evidence evidence
),
lineage_rebuilt_rows AS (
  SELECT expected.id,
         jsonb_build_object(
           'checksum',encode(extensions.digest(convert_to(
             public.worldgraph_canonical_jsonb(jsonb_build_object(
               'domain','worldgraph.governance-tax-policy-lineage.v1',
               'value',jsonb_build_object(
                 'commandId',expected.command_id::text,
                 'effectiveTick',expected.effective_tick::text,
                 'eventId',expected.event_id::text,
                 'lineageId',expected.id::text,
                 'newPolicyChecksum',encode(expected.expected_new_checksum,'hex'),
                 'newPolicyId',expected.new_tax_policy_id::text,
                 'newPolicyVersion',expected.new_policy_version,
                 'policyStableKey',expected.policy_stable_key::text,
                 'previousPolicyChecksum',encode(expected.expected_previous_checksum,'hex'),
                 'previousPolicyId',expected.previous_tax_policy_id::text,
                 'previousPolicyVersion',expected.previous_policy_version,
                 'proposalActionChecksum',encode(expected.expected_action_checksum,'hex'),
                 'proposalActionId',expected.proposal_action_id::text,
                 'proposalEnactmentId',expected.proposal_enactment_id::text,
                 'proposalResultChecksum',encode(expected.result_checksum,'hex'),
                 'proposalResultId',expected.proposal_result_id::text,
                 'stateRevision',expected.state_revision::text
               )
             )),'UTF8'
           ),'sha256'),'hex'),
           'commandId',expected.command_id::text,
           'effectiveTick',expected.effective_tick::text,
           'eventId',expected.event_id::text,
           'evidenceValid',expected.evidence_valid,
           'lineageId',expected.id::text,
           'newPolicyChecksum',encode(expected.expected_new_checksum,'hex'),
           'newPolicyId',expected.new_tax_policy_id::text,
           'newPolicyVersion',expected.new_policy_version,
           'policyStableKey',expected.policy_stable_key::text,
           'previousPolicyChecksum',encode(expected.expected_previous_checksum,'hex'),
           'previousPolicyId',expected.previous_tax_policy_id::text,
           'previousPolicyVersion',expected.previous_policy_version,
           'proposalActionChecksum',encode(expected.expected_action_checksum,'hex'),
           'proposalActionId',expected.proposal_action_id::text,
           'proposalEnactmentId',expected.proposal_enactment_id::text,
           'proposalResultChecksum',encode(expected.result_checksum,'hex'),
           'proposalResultId',expected.proposal_result_id::text,
           'stateRevision',expected.state_revision::text
         ) AS document
  FROM lineage_expected expected
),
documents AS (
  SELECT
    COALESCE((SELECT jsonb_agg(policy.document ORDER BY policy.stable_key COLLATE "C",policy.policy_version)
      FROM rebuilt_policy_rows policy),'[]'::jsonb) AS policy_rebuilt,
    COALESCE((SELECT jsonb_agg(authority.document ORDER BY authority.id COLLATE "C")
      FROM authority_live_rows authority),'[]'::jsonb) AS authority_live,
    COALESCE((SELECT jsonb_agg(authority.document ORDER BY authority.id COLLATE "C")
      FROM authority_rebuilt_rows authority),'[]'::jsonb) AS authority_rebuilt,
    COALESCE((SELECT jsonb_agg(lineage.document ORDER BY lineage.id)
      FROM lineage_live_rows lineage),'[]'::jsonb) AS lineage_live,
    COALESCE((SELECT jsonb_agg(lineage.document ORDER BY lineage.id)
      FROM lineage_rebuilt_rows lineage),'[]'::jsonb) AS lineage_rebuilt
)
SELECT jsonb_build_object(
  'governanceTaxPolicyLineageLive',lineage_live,
  'governanceTaxPolicyLineageRebuilt',lineage_rebuilt,
  'taxPolicyAuthorityLive',authority_live,
  'taxPolicyAuthorityRebuilt',authority_rebuilt,
  'taxPolicyRebuilt',policy_rebuilt
)
FROM documents
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_economy_reconciliation_tax_documents_v3(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_economy_reconciliation_documents_v3(
  checked_world_id uuid,
  evidence_command_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT public.worldgraph_economy_reconciliation_documents_v2(
           checked_world_id,evidence_command_id
         ) || public.worldgraph_economy_reconciliation_tax_documents_v3(
           checked_world_id
         )
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_economy_reconciliation_documents_v3(uuid,uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_reconcile_economy_expansion_v3(
  checked_world_id uuid,
  evidence_command_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  documents jsonb;
  retained_v2 jsonb;
  result jsonb;
  result_item_count integer;
BEGIN
  documents := public.worldgraph_economy_reconciliation_documents_v3(
    checked_world_id,evidence_command_id
  );
  retained_v2 := public.worldgraph_reconcile_economy_expansion_v2(
    checked_world_id,evidence_command_id
  );

  WITH hashes AS (
    SELECT
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'businessLive'
      ),'UTF8'),'sha256') AS business_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'businessRebuilt'
      ),'UTF8'),'sha256') AS business_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'checkpointLive'
      ),'UTF8'),'sha256') AS checkpoint_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'checkpointRebuilt'
      ),'UTF8'),'sha256') AS checkpoint_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'contractLive'
      ),'UTF8'),'sha256') AS contract_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'contractRebuilt'
      ),'UTF8'),'sha256') AS contract_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'facilityLive'
      ),'UTF8'),'sha256') AS facility_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'facilityRebuilt'
      ),'UTF8'),'sha256') AS facility_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'inventoryLive'
      ),'UTF8'),'sha256') AS inventory_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'inventoryRebuilt'
      ),'UTF8'),'sha256') AS inventory_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'listingLive'
      ),'UTF8'),'sha256') AS listing_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'listingRebuilt'
      ),'UTF8'),'sha256') AS listing_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'payrollLive'
      ),'UTF8'),'sha256') AS payroll_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'payrollRebuilt'
      ),'UTF8'),'sha256') AS payroll_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'productionLive'
      ),'UTF8'),'sha256') AS production_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'productionRebuilt'
      ),'UTF8'),'sha256') AS production_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'recipeVersionLive'
      ),'UTF8'),'sha256') AS recipe_version_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'recipeVersionRebuilt'
      ),'UTF8'),'sha256') AS recipe_version_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'reservationLive'
      ),'UTF8'),'sha256') AS reservation_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'reservationRebuilt'
      ),'UTF8'),'sha256') AS reservation_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'reservationRecordLive'
      ),'UTF8'),'sha256') AS reservation_record_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'reservationRecordRebuilt'
      ),'UTF8'),'sha256') AS reservation_record_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'taxLive'
      ),'UTF8'),'sha256') AS tax_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'taxRebuilt'
      ),'UTF8'),'sha256') AS tax_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'taxPolicyLive'
      ),'UTF8'),'sha256') AS tax_policy_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'taxPolicyRebuilt'
      ),'UTF8'),'sha256') AS tax_policy_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'taxPolicyAuthorityLive'
      ),'UTF8'),'sha256') AS tax_authority_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'taxPolicyAuthorityRebuilt'
      ),'UTF8'),'sha256') AS tax_authority_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'governanceTaxPolicyLineageLive'
      ),'UTF8'),'sha256') AS tax_lineage_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'governanceTaxPolicyLineageRebuilt'
      ),'UTF8'),'sha256') AS tax_lineage_rebuilt,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'tradeLive'
      ),'UTF8'),'sha256') AS trade_live,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        documents -> 'tradeRebuilt'
      ),'UTF8'),'sha256') AS trade_rebuilt
  ),
  projection_hashes AS (
    SELECT hashes.*,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        jsonb_build_object(
          'domain','worldgraph.economy-expansion-reconciliation.v3',
          'businessChecksum',encode(hashes.business_live,'hex'),
          'checkpointChecksum',encode(hashes.checkpoint_live,'hex'),
          'contractChecksum',encode(hashes.contract_live,'hex'),
          'facilityChecksum',encode(hashes.facility_live,'hex'),
          'inventoryChecksum',encode(hashes.inventory_live,'hex'),
          'listingChecksum',encode(hashes.listing_live,'hex'),
          'payrollChecksum',encode(hashes.payroll_live,'hex'),
          'productionChecksum',encode(hashes.production_live,'hex'),
          'recipeVersionChecksum',encode(hashes.recipe_version_live,'hex'),
          'reservationChecksum',encode(hashes.reservation_live,'hex'),
          'reservationRecordChecksum',encode(hashes.reservation_record_live,'hex'),
          'taxAssessmentChecksum',encode(hashes.tax_live,'hex'),
          'taxPolicyAuthorityChecksum',encode(hashes.tax_authority_live,'hex'),
          'taxPolicyChecksum',encode(hashes.tax_policy_live,'hex'),
          'taxPolicyLineageChecksum',encode(hashes.tax_lineage_live,'hex'),
          'tradeChecksum',encode(hashes.trade_live,'hex')
        )
      ),'UTF8'),'sha256') AS live_projection,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
        jsonb_build_object(
          'domain','worldgraph.economy-expansion-reconciliation.v3',
          'businessChecksum',encode(hashes.business_rebuilt,'hex'),
          'checkpointChecksum',encode(hashes.checkpoint_rebuilt,'hex'),
          'contractChecksum',encode(hashes.contract_rebuilt,'hex'),
          'facilityChecksum',encode(hashes.facility_rebuilt,'hex'),
          'inventoryChecksum',encode(hashes.inventory_rebuilt,'hex'),
          'listingChecksum',encode(hashes.listing_rebuilt,'hex'),
          'payrollChecksum',encode(hashes.payroll_rebuilt,'hex'),
          'productionChecksum',encode(hashes.production_rebuilt,'hex'),
          'recipeVersionChecksum',encode(hashes.recipe_version_rebuilt,'hex'),
          'reservationChecksum',encode(hashes.reservation_rebuilt,'hex'),
          'reservationRecordChecksum',encode(hashes.reservation_record_rebuilt,'hex'),
          'taxAssessmentChecksum',encode(hashes.tax_rebuilt,'hex'),
          'taxPolicyAuthorityChecksum',encode(hashes.tax_authority_rebuilt,'hex'),
          'taxPolicyChecksum',encode(hashes.tax_policy_rebuilt,'hex'),
          'taxPolicyLineageChecksum',encode(hashes.tax_lineage_rebuilt,'hex'),
          'tradeChecksum',encode(hashes.trade_rebuilt,'hex')
        )
      ),'UTF8'),'sha256') AS rebuilt_projection
    FROM hashes
  ),
  retained_candidates AS (
    SELECT CASE item."itemKind"
             WHEN 'inventory_quantity' THEN 1
             WHEN 'inventory_reservation' THEN 2
             WHEN 'reservation_lifecycle' THEN 3
             WHEN 'recipe_version' THEN 8
             WHEN 'business' THEN 12
             WHEN 'facility' THEN 13
             WHEN 'production' THEN 14
             WHEN 'employment_contract' THEN 15
             WHEN 'market_listing' THEN 16
             WHEN 'market_trade' THEN 17
             WHEN 'payroll' THEN 18
             WHEN 'tax_assessment' THEN 19
             WHEN 'projection_checkpoint' THEN 20
             ELSE 100 END AS category_order,
           item."itemKind" AS item_kind,item."itemKey" AS item_key,
           item."expectedValue" AS expected_value,item."actualValue" AS actual_value,
           item."mismatchCode" AS mismatch_code
    FROM jsonb_to_recordset(retained_v2 -> 'items') AS item(
      "actualValue" text,"expectedValue" text,"itemKey" text,
      "itemKind" text,"itemOrdinal" integer,"mismatchCode" text
    )
    WHERE item."itemKind" <> 'tax_policy'
  ),
  tax_candidates AS (
    SELECT candidate.category_order,candidate.item_kind,candidate.item_key,
           encode(candidate.expected_hash,'hex') AS expected_value,
           encode(candidate.actual_hash,'hex') AS actual_value,
           candidate.mismatch_code
    FROM projection_hashes hashes,
      LATERAL (VALUES
        (9,'tax_policy'::text,'tax_policies'::text,
          hashes.tax_policy_rebuilt,hashes.tax_policy_live,
          'TAX_POLICY_CHECKSUM_MISMATCH'::text),
        (10,'tax_policy_authority','tax_policy_authority_intervals',
          hashes.tax_authority_rebuilt,hashes.tax_authority_live,
          'TAX_POLICY_AUTHORITY_CHECKSUM_MISMATCH'),
        (11,'governance_tax_policy_lineage','governance_tax_policy_lineage',
          hashes.tax_lineage_rebuilt,hashes.tax_lineage_live,
          'GOVERNANCE_TAX_POLICY_LINEAGE_CHECKSUM_MISMATCH')
      ) candidate(
        category_order,item_kind,item_key,expected_hash,actual_hash,mismatch_code
      )
    WHERE candidate.expected_hash IS DISTINCT FROM candidate.actual_hash
  ),
  item_candidates AS (
    SELECT * FROM retained_candidates
    UNION ALL
    SELECT * FROM tax_candidates
  ),
  candidate_count AS (
    SELECT least(count(*),10001)::integer AS item_count FROM item_candidates
  ),
  ordered_items AS (
    SELECT (row_number() OVER (
             ORDER BY candidate.category_order,candidate.item_key COLLATE "C"
           ) - 1)::integer AS item_ordinal,
           candidate.item_kind,candidate.item_key,candidate.expected_value,
           candidate.actual_value,candidate.mismatch_code
    FROM item_candidates candidate,candidate_count
    WHERE candidate_count.item_count <= 10000
  ),
  item_document AS (
    SELECT candidate_count.item_count,
           COALESCE(jsonb_agg(jsonb_build_object(
             'actualValue',item.actual_value,
             'expectedValue',item.expected_value,
             'itemKey',item.item_key,
             'itemKind',item.item_kind,
             'itemOrdinal',item.item_ordinal,
             'mismatchCode',item.mismatch_code
           ) ORDER BY item.item_ordinal)
             FILTER (WHERE item.item_ordinal IS NOT NULL),'[]'::jsonb) AS items
    FROM candidate_count
    LEFT JOIN ordered_items item ON candidate_count.item_count <= 10000
    GROUP BY candidate_count.item_count
  )
  SELECT jsonb_build_object(
    'assessmentCount',(SELECT count(*) FROM public.tax_assessments
      WHERE world_id = checked_world_id),
    'inventoryCount',(SELECT count(*) FROM public.inventories
      WHERE world_id = checked_world_id),
    'itemCount',item_document.item_count,
    'items',item_document.items,
    'liveInventoryChecksum',encode(hashes.inventory_live,'hex'),
    'livePayrollChecksum',encode(hashes.payroll_live,'hex'),
    'liveProjectionChecksum',encode(hashes.live_projection,'hex'),
    'liveReservationChecksum',encode(hashes.reservation_live,'hex'),
    'liveTaxChecksum',encode(hashes.tax_live,'hex'),
    'liveTradeChecksum',encode(hashes.trade_live,'hex'),
    'matched',item_document.item_count = 0
      AND hashes.live_projection = hashes.rebuilt_projection,
    'mismatchCount',item_document.item_count,
    'projectionChecksum',encode(
      public.worldgraph_economy_expansion_projection_checksum(checked_world_id),'hex'
    ),
    'rebuiltInventoryChecksum',encode(hashes.inventory_rebuilt,'hex'),
    'rebuiltJournalChecksum',encode(hashes.rebuilt_projection,'hex'),
    'rebuiltPayrollChecksum',encode(hashes.payroll_rebuilt,'hex'),
    'rebuiltReservationChecksum',encode(hashes.reservation_rebuilt,'hex'),
    'rebuiltTaxChecksum',encode(hashes.tax_rebuilt,'hex'),
    'rebuiltTradeChecksum',encode(hashes.trade_rebuilt,'hex'),
    'resourceCount',(SELECT count(*) FROM public.resource_types
      WHERE world_id = checked_world_id),
    'tradeCount',(SELECT count(*) FROM public.market_trades
      WHERE world_id = checked_world_id)
  ),item_document.item_count
    INTO result,result_item_count
  FROM projection_hashes hashes,item_document;

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
  public.worldgraph_reconcile_economy_expansion_v3(uuid,uuid)
  FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.economy_expansion_reconciliation_runs
  ALTER COLUMN reconciliation_schema_version SET DEFAULT 3,
  DROP CONSTRAINT economy_expansion_reconciliation_schema_known,
  ADD CONSTRAINT economy_expansion_reconciliation_schema_known CHECK (
    reconciliation_schema_version IN (2,3)
  );
--> statement-breakpoint
ALTER TABLE public.economy_expansion_reconciliation_items
  DROP CONSTRAINT economy_expansion_reconciliation_items_kind,
  ADD CONSTRAINT economy_expansion_reconciliation_items_kind CHECK (
    item_kind IN (
      'inventory_quantity','inventory_reservation','business','facility',
      'production','employment_contract','market_listing','market_trade',
      'payroll','tax_assessment','projection_checkpoint',
      'reservation_lifecycle','recipe_version','tax_policy',
      'tax_policy_authority','governance_tax_policy_lineage'
    )
  );
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
    NULLIF(current_setting('worldgraph.command_id',true),'')::uuid;
BEGIN
  IF checked_world_id IS NULL OR evidence_command_id IS NULL
    OR NULLIF(current_setting('worldgraph.command_world_id',true),'')
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
  RETURN public.worldgraph_reconcile_economy_expansion_v3(
    checked_world_id,evidence_command_id
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.worldgraph_reconcile_economy_expansion(uuid)
  FROM PUBLIC;
--> statement-breakpoint
DO $reconciliation_v3_guards$
DECLARE
  function_definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.worldgraph_assert_economy_expansion_reconciliation_run()'::regprocedure
  ) INTO function_definition;
  updated_definition := replace(
    function_definition,
    'worldgraph_reconcile_economy_expansion_v2(',
    'worldgraph_reconcile_economy_expansion_v3('
  );
  IF updated_definition = function_definition THEN
    RAISE EXCEPTION 'commerce run evidence guard lacks the retained v2 reconciler clause'
      USING ERRCODE = '55000';
  END IF;
  function_definition := updated_definition;
  updated_definition := replace(
    function_definition,
    'run_record.reconciliation_schema_version <> 2',
    'run_record.reconciliation_schema_version <> 3'
  );
  IF updated_definition = function_definition THEN
    RAISE EXCEPTION 'commerce run evidence guard lacks the retained schema-2 clause'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'public.worldgraph_execute_commerce_projection_repair(uuid,uuid,text,text)'::regprocedure
  ) INTO function_definition;
  updated_definition := replace(
    function_definition,
    'reconciliation_run_id_value, plan_record.world_id, 2,',
    'reconciliation_run_id_value, plan_record.world_id, 3,'
  );
  IF updated_definition = function_definition THEN
    RAISE EXCEPTION 'commerce repair execution lacks the retained schema-2 run clause'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'public.worldgraph_assert_commerce_projection_repair_execution()'::regprocedure
  ) INTO function_definition;
  updated_definition := replace(
    function_definition,
    'run_record.reconciliation_schema_version <> 2',
    'run_record.reconciliation_schema_version <> 3'
  );
  IF updated_definition = function_definition THEN
    RAISE EXCEPTION 'commerce repair evidence guard lacks the retained schema-2 clause'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE updated_definition;
END
$reconciliation_v3_guards$;
--> statement-breakpoint
ALTER TABLE public.law_versions
  ADD CONSTRAINT law_versions_source_result_world_fk
  FOREIGN KEY (world_id,source_proposal_result_id)
  REFERENCES public.proposal_results(world_id,id) ON DELETE RESTRICT;
--> statement-breakpoint
DO $immutability$
DECLARE checked_table text;
BEGIN
  FOREACH checked_table IN ARRAY ARRAY[
    'compiled_governance_seed_plans','governing_charters',
    'governing_charter_versions','institution_powers','laws','law_versions',
    'law_effectivity_transitions','political_office_seats','office_powers',
    'office_power_delegations',
    'proposal_actions','proposal_sponsors','proposal_transitions',
    'candidacy_transitions','eligibility_snapshots','eligibility_snapshot_members',
    'ballot_receipts','ballot_choice_revisions','public_ballot_choices',
    'secret_ballot_choices','proposal_tallies','proposal_tally_counts',
    'proposal_results','election_tallies','election_tally_counts','election_results',
    'office_terms','office_term_transitions','proposal_enactments',
    'proposal_action_enactments','governance_authority_decisions',
    'governance_authority_decision_sources','governance_schedule_occurrences',
    'governance_overrides','governance_override_approvals','governance_repairs',
    'governance_repair_approvals','public_project_authorizations',
    'treasury_encumbrances','treasury_encumbrance_facts',
    'governance_tax_policy_lineage'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION public.worldgraph_reject_update_delete()',
      checked_table || '_append_only',checked_table
    );
  END LOOP;
END
$immutability$;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_ballot_choice_storage_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_revision public.ballot_choice_revisions%ROWTYPE;
  participation_record public.ballot_participation%ROWTYPE;
  changed_row jsonb := to_jsonb(NEW);
  checked_world_id uuid := (changed_row ->> 'world_id')::uuid;
  checked_revision_id uuid := COALESCE(
    (changed_row ->> 'choice_revision_id')::uuid,
    (changed_row ->> 'id')::uuid
  );
  contest_kind text;
  public_count integer;
  secret_count integer;
  stored_choice jsonb;
BEGIN
  SELECT revision.* INTO checked_revision
  FROM public.ballot_choice_revisions revision
  WHERE revision.id = checked_revision_id
    AND revision.world_id = checked_world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ballot choice revision is missing'
      USING ERRCODE = '23514', CONSTRAINT = 'ballot_choice_storage_exact';
  END IF;
  SELECT participation.* INTO participation_record
  FROM public.ballot_participation participation
  WHERE participation.world_id = checked_revision.world_id
    AND participation.id = checked_revision.participation_id;
  SELECT contest.contest_kind INTO contest_kind
  FROM public.governance_contests contest
  WHERE contest.world_id = checked_revision.world_id
    AND contest.id = checked_revision.contest_id;
  SELECT count(*),(jsonb_agg(choice.choice_payload) -> 0)
    INTO public_count,stored_choice
  FROM public.public_ballot_choices choice
  WHERE choice.world_id = checked_revision.world_id
    AND choice.choice_revision_id = checked_revision.id;
  SELECT count(*),COALESCE((jsonb_agg(choice.choice_payload) -> 0),stored_choice)
    INTO secret_count,stored_choice
  FROM public.secret_ballot_choices choice
  WHERE choice.world_id = checked_revision.world_id
    AND choice.choice_revision_id = checked_revision.id;
  IF participation_record.id IS NULL
    OR checked_revision.storage_mode IS DISTINCT FROM participation_record.ballot_mode
    OR (checked_revision.storage_mode = 'public' AND (public_count <> 1 OR secret_count <> 0))
    OR (checked_revision.storage_mode = 'secret' AND (secret_count <> 1 OR public_count <> 0))
    OR checked_revision.choice_hash IS DISTINCT FROM extensions.digest(convert_to(
      public.worldgraph_canonical_jsonb(
        CASE checked_revision.storage_mode
          WHEN 'secret' THEN jsonb_build_object(
            'domain','worldgraph.governance.secret-ballot-choice-hash.v1',
            'value',jsonb_build_object(
              'choicePayload',stored_choice,
              'choiceRevisionId',checked_revision.id::text
            )
          )
          ELSE stored_choice
        END
      ),'UTF8'
    ),'sha256')
    OR (contest_kind = 'proposal' AND NOT (
      stored_choice = jsonb_build_object('choice',stored_choice ->> 'choice')
      AND stored_choice ->> 'choice' IN ('yes','no','abstain')
    ))
    OR (contest_kind = 'election' AND NOT (
      stored_choice = jsonb_build_object('choiceType','abstain')
      OR (
        stored_choice = jsonb_build_object(
          'candidateKey',stored_choice ->> 'candidateKey','choiceType','candidate'
        )
        AND stored_choice ->> 'candidateKey'
          ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'
      )
    )) THEN
    RAISE EXCEPTION 'ballot choice storage is incomplete, mismatched, or invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'ballot_choice_storage_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_ballot_choice_storage_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ballot_choice_revisions_require_exact_storage
  AFTER INSERT ON public.ballot_choice_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_ballot_choice_storage_v1();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER public_ballot_choices_require_exact_revision
  AFTER INSERT ON public.public_ballot_choices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_ballot_choice_storage_v1();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER secret_ballot_choices_require_exact_revision
  AFTER INSERT ON public.secret_ballot_choices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_ballot_choice_storage_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_assert_effective_ballot_revision_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_row jsonb := to_jsonb(NEW);
  checked_world_id uuid := (changed_row ->> 'world_id')::uuid;
  checked_participation_id uuid := COALESCE(
    (changed_row ->> 'participation_id')::uuid,
    (changed_row ->> 'id')::uuid
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.ballot_participation participation
    JOIN public.ballot_effective_revisions effective
      ON effective.world_id = participation.world_id
     AND effective.participation_id = participation.id
    JOIN public.ballot_choice_revisions revision
      ON revision.world_id = effective.world_id
     AND revision.id = effective.choice_revision_id
    WHERE participation.world_id = checked_world_id
      AND participation.id = checked_participation_id
      AND effective.contest_id = participation.contest_id
      AND revision.contest_id = participation.contest_id
      AND revision.participation_id = participation.id
      AND effective.effective_revision = participation.current_revision
      AND revision.revision = participation.current_revision
      AND effective.row_version = participation.aggregate_version
  ) THEN
    RAISE EXCEPTION 'effective ballot revision does not match its voter aggregate'
      USING ERRCODE = '23514', CONSTRAINT = 'ballot_effective_revision_exact';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_assert_effective_ballot_revision_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ballot_participation_require_effective_revision
  AFTER INSERT OR UPDATE ON public.ballot_participation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_effective_ballot_revision_v1();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ballot_effective_revisions_match_participation
  AFTER INSERT OR UPDATE ON public.ballot_effective_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_effective_ballot_revision_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_protect_ballot_mutable_projection_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  checked_id uuid := COALESCE(
    (changed_row ->> 'participation_id')::uuid,
    (changed_row ->> 'id')::uuid
  );
  checked_world_id uuid := (changed_row ->> 'world_id')::uuid;
  open_command_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ballot aggregates cannot be deleted' USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type INTO open_command_type
  FROM public.command_records command
  WHERE command.id = NULLIF(current_setting('worldgraph.command_id',true),'')::uuid
    AND command.world_id = checked_world_id
    AND public.worldgraph_command_write_is_open(command.world_id,command.id);
  IF NULLIF(current_setting('worldgraph.ballot_participation_id',true),'')::uuid
      IS DISTINCT FROM checked_id
    OR open_command_type NOT IN ('CastProposalBallotV1','CastElectionBallotV1') THEN
    RAISE EXCEPTION 'ballot aggregate write requires the fixed cast function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_protect_ballot_mutable_projection_v1()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER ballot_participation_protect
  BEFORE INSERT OR UPDATE OR DELETE ON public.ballot_participation
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_ballot_mutable_projection_v1();
--> statement-breakpoint
CREATE TRIGGER ballot_effective_revisions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON public.ballot_effective_revisions
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_protect_ballot_mutable_projection_v1();
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_cast_governance_ballot_v1(
  checked_world_id uuid,
  checked_contest_id uuid,
  checked_eligibility_snapshot_id uuid,
  checked_voter_entity_id uuid,
  checked_participation_id uuid,
  checked_choice_revision_id uuid,
  checked_receipt_id uuid,
  checked_receipt_hash bytea,
  checked_linkage_nonce_hash bytea,
  checked_choice_payload jsonb,
  checked_expected_contest_version bigint,
  checked_replace_existing boolean,
  checked_cast_tick bigint,
  checked_command_id uuid,
  checked_event_id uuid,
  checked_state_revision bigint
)
RETURNS TABLE (
  participation_id uuid,
  receipt_hash bytea,
  ballot_mode text,
  effective_revision integer,
  participation_version bigint,
  choice_totals jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  contest_record public.governance_contests%ROWTYPE;
  participation_record public.ballot_participation%ROWTYPE;
  previous_revision_id uuid;
  next_revision integer;
  next_participation_version bigint;
  checked_choice_hash bytea;
  computed_choice_totals jsonb := NULL;
  accepted_candidate_count integer;
  open_command_type text;
  open_command_expected_tick bigint;
BEGIN
  IF checked_world_id IS NULL OR checked_contest_id IS NULL
    OR checked_eligibility_snapshot_id IS NULL OR checked_voter_entity_id IS NULL
    OR checked_participation_id IS NULL OR checked_choice_revision_id IS NULL
    OR checked_receipt_id IS NULL OR checked_command_id IS NULL
    OR checked_event_id IS NULL OR checked_expected_contest_version < 1
    OR checked_cast_tick < 0 OR checked_state_revision < 1
    OR pg_column_size(checked_choice_payload) > 8192
    OR public.worldgraph_jsonb_has_sensitive_key(checked_choice_payload)
    OR public.worldgraph_jsonb_has_compiler_private_key(checked_choice_payload)
    OR octet_length(checked_receipt_hash) <> 32 THEN
    RAISE EXCEPTION 'ballot cast inputs are invalid' USING ERRCODE = '22023';
  END IF;
  IF checked_participation_id IN (checked_choice_revision_id,checked_receipt_id)
    OR checked_choice_revision_id = checked_receipt_id THEN
    RAISE EXCEPTION 'ballot record identities must be distinct' USING ERRCODE = '22023';
  END IF;
  IF checked_command_id IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')::uuid
    OR NOT public.worldgraph_command_write_is_open(checked_world_id,checked_command_id) THEN
    RAISE EXCEPTION 'ballot cast requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type,command.expected_tick
    INTO open_command_type,open_command_expected_tick
  FROM public.command_records command
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  SELECT contest.* INTO contest_record
  FROM public.governance_contests contest
  WHERE contest.world_id = checked_world_id AND contest.id = checked_contest_id;
  IF NOT FOUND OR contest_record.status <> 'open'
    OR contest_record.aggregate_version <> checked_expected_contest_version
    OR open_command_expected_tick IS DISTINCT FROM checked_cast_tick
    OR NOT int8range(contest_record.opens_tick,contest_record.closes_tick,'[)')
      @> checked_cast_tick
    OR NOT EXISTS (
      SELECT 1 FROM public.world_simulation_clocks clock
      WHERE clock.world_id = checked_world_id AND clock.current_tick = checked_cast_tick
    )
    OR (contest_record.contest_kind = 'proposal'
      AND open_command_type IS DISTINCT FROM 'CastProposalBallotV1')
    OR (contest_record.contest_kind = 'election'
      AND open_command_type IS DISTINCT FROM 'CastElectionBallotV1') THEN
    RAISE EXCEPTION 'contest is not open for this exact ballot command and tick'
      USING ERRCODE = '55000';
  END IF;
  IF (contest_record.contest_kind='proposal' AND NOT (
      jsonb_typeof(checked_choice_payload)='object'
      AND public.worldgraph_jsonb_has_exact_keys(
        checked_choice_payload,ARRAY['choice']
      )
      AND checked_choice_payload ->> 'choice' IN ('yes','no','abstain')
    )) OR (contest_record.contest_kind='election' AND NOT (
      jsonb_typeof(checked_choice_payload)='object'
      AND (
        (public.worldgraph_jsonb_has_exact_keys(
            checked_choice_payload,ARRAY['choiceType']
          ) AND checked_choice_payload ->> 'choiceType'='abstain')
        OR (public.worldgraph_jsonb_has_exact_keys(
            checked_choice_payload,ARRAY['candidateKey','choiceType']
          ) AND checked_choice_payload ->> 'choiceType'='candidate'
          AND public.worldgraph_governance_key_is_valid_v1(
            checked_choice_payload ->> 'candidateKey'
          )
          AND EXISTS (
            SELECT 1
            FROM public.election_contests link
            JOIN public.candidacies candidacy
              ON candidacy.world_id=link.world_id
             AND candidacy.election_id=link.election_id
             AND candidacy.contest_id=link.contest_id
            JOIN public.world_entities candidate
              ON candidate.world_id=candidacy.world_id
             AND candidate.id=candidacy.candidate_entity_id
            WHERE link.world_id=checked_world_id
              AND link.contest_id=checked_contest_id
              AND candidacy.status='accepted'
              AND candidate.logical_key::text=
                checked_choice_payload ->> 'candidateKey'
          ))
      )
    )) THEN
    RAISE EXCEPTION 'ballot choice does not match the exact contest choice schema'
      USING ERRCODE='22023';
  END IF;
  IF (contest_record.ballot_mode = 'secret'
      AND octet_length(checked_linkage_nonce_hash) <> 32)
    OR (contest_record.ballot_mode = 'public'
      AND checked_linkage_nonce_hash IS NOT NULL)
    OR NOT EXISTS (
      SELECT 1
      FROM public.eligibility_snapshots snapshot
      JOIN public.eligibility_snapshot_members member
        ON member.world_id = snapshot.world_id AND member.snapshot_id = snapshot.id
      WHERE snapshot.world_id = checked_world_id
        AND snapshot.id = checked_eligibility_snapshot_id
        AND snapshot.contest_id = checked_contest_id
        AND member.contest_id = checked_contest_id
        AND member.voter_entity_id = checked_voter_entity_id
    ) THEN
    RAISE EXCEPTION 'voter is not in the frozen eligibility snapshot'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'worldgraph-ballot-v1:' || checked_contest_id::text || ':'
      || checked_voter_entity_id::text,0
  ));
  SELECT participation.* INTO participation_record
  FROM public.ballot_participation participation
  WHERE participation.contest_id = checked_contest_id
    AND participation.voter_entity_id = checked_voter_entity_id
  FOR UPDATE;
  IF FOUND THEN
    IF participation_record.world_id <> checked_world_id
      OR participation_record.eligibility_snapshot_id <> checked_eligibility_snapshot_id
      OR participation_record.ballot_mode <> contest_record.ballot_mode
      OR NOT checked_replace_existing OR NOT contest_record.allow_replacement
      OR participation_record.current_revision >= 1000 THEN
      RAISE EXCEPTION 'existing ballot cannot be replaced under this contest policy'
        USING ERRCODE = '23505', CONSTRAINT = 'ballot_participation_voter_unique';
    END IF;
    IF participation_record.id <> checked_participation_id THEN
      RAISE EXCEPTION 'ballot participation identity is already bound'
        USING ERRCODE = '23505';
    END IF;
    next_revision := participation_record.current_revision + 1;
    next_participation_version := participation_record.aggregate_version + 1;
    SELECT revision.id INTO previous_revision_id
    FROM public.ballot_choice_revisions revision
    WHERE revision.world_id = checked_world_id
      AND revision.participation_id = checked_participation_id
      AND revision.revision = participation_record.current_revision;
  ELSE
    IF checked_replace_existing THEN
      RAISE EXCEPTION 'replacement requested without an existing ballot'
        USING ERRCODE = '22023';
    END IF;
    next_revision := 1;
    next_participation_version := 1;
  END IF;
  checked_choice_hash := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(
      CASE contest_record.ballot_mode
        WHEN 'secret' THEN jsonb_build_object(
          'domain','worldgraph.governance.secret-ballot-choice-hash.v1',
          'value',jsonb_build_object(
            'choicePayload',checked_choice_payload,
            'choiceRevisionId',checked_choice_revision_id::text
          )
        )
        ELSE checked_choice_payload
      END
    ),'UTF8'
  ),'sha256');
  PERFORM set_config(
    'worldgraph.ballot_participation_id',checked_participation_id::text,true
  );
  IF participation_record.id IS NULL THEN
    INSERT INTO public.ballot_participation (
      id,world_id,contest_id,eligibility_snapshot_id,voter_entity_id,ballot_mode,
      current_revision,aggregate_version,first_cast_tick,last_cast_tick
    ) VALUES (
      checked_participation_id,checked_world_id,checked_contest_id,
      checked_eligibility_snapshot_id,checked_voter_entity_id,
      contest_record.ballot_mode,next_revision,next_participation_version,
      checked_cast_tick,checked_cast_tick
    );
  ELSE
    UPDATE public.ballot_participation
    SET current_revision = next_revision,
        aggregate_version = next_participation_version,
        last_cast_tick = checked_cast_tick,
        updated_at = clock_timestamp()
    WHERE id = checked_participation_id AND world_id = checked_world_id;
  END IF;
  INSERT INTO public.ballot_receipts (
    id,world_id,contest_id,participation_id,revision,receipt_hash,choice_hash,cast_tick
  ) VALUES (
    checked_receipt_id,checked_world_id,checked_contest_id,checked_participation_id,
    next_revision,checked_receipt_hash,checked_choice_hash,checked_cast_tick
  );
  INSERT INTO public.ballot_choice_revisions (
    id,world_id,contest_id,participation_id,receipt_id,revision,storage_mode,
    choice_schema_version,choice_hash,replaces_revision_id,cast_command_id,
    cast_event_id,cast_state_revision,cast_tick
  ) VALUES (
    checked_choice_revision_id,checked_world_id,checked_contest_id,
    checked_participation_id,checked_receipt_id,next_revision,
    contest_record.ballot_mode,1,checked_choice_hash,previous_revision_id,
    checked_command_id,checked_event_id,checked_state_revision,checked_cast_tick
  );
  IF contest_record.ballot_mode = 'public' THEN
    INSERT INTO public.public_ballot_choices (
      choice_revision_id,world_id,contest_id,participation_id,voter_entity_id,
      choice_payload,choice_hash
    ) VALUES (
      checked_choice_revision_id,checked_world_id,checked_contest_id,
      checked_participation_id,checked_voter_entity_id,checked_choice_payload,
      checked_choice_hash
    );
  ELSE
    INSERT INTO public.secret_ballot_choices (
      choice_revision_id,world_id,contest_id,participation_id,choice_payload,
      choice_hash,linkage_nonce_hash
    ) VALUES (
      checked_choice_revision_id,checked_world_id,checked_contest_id,
      checked_participation_id,checked_choice_payload,checked_choice_hash,
      checked_linkage_nonce_hash
    );
  END IF;
  INSERT INTO public.ballot_effective_revisions (
    participation_id,world_id,contest_id,choice_revision_id,effective_revision,
    row_version,updated_command_id
  ) VALUES (
    checked_participation_id,checked_world_id,checked_contest_id,
    checked_choice_revision_id,next_revision,next_participation_version,
    checked_command_id
  ) ON CONFLICT ON CONSTRAINT ballot_effective_revisions_pkey DO UPDATE
    SET choice_revision_id = EXCLUDED.choice_revision_id,
        effective_revision = EXCLUDED.effective_revision,
        row_version = EXCLUDED.row_version,
        updated_command_id = EXCLUDED.updated_command_id,
        updated_at = clock_timestamp();
  IF contest_record.ballot_mode='public'
    AND contest_record.ballot_disclosure='choice_totals' THEN
    IF contest_record.contest_kind='proposal' THEN
      SELECT jsonb_build_object(
        'abstainCount',count(*) FILTER (
          WHERE choice.choice_payload=jsonb_build_object('choice','abstain')
        ),
        'noCount',count(*) FILTER (
          WHERE choice.choice_payload=jsonb_build_object('choice','no')
        ),
        'yesCount',count(*) FILTER (
          WHERE choice.choice_payload=jsonb_build_object('choice','yes')
        )
      ) INTO computed_choice_totals
      FROM public.ballot_effective_revisions effective
      JOIN public.public_ballot_choices choice
        ON choice.world_id=effective.world_id
       AND choice.contest_id=effective.contest_id
       AND choice.participation_id=effective.participation_id
       AND choice.choice_revision_id=effective.choice_revision_id
      WHERE effective.world_id=checked_world_id
        AND effective.contest_id=checked_contest_id;
    ELSE
      SELECT count(*)::integer INTO accepted_candidate_count
      FROM public.election_contests link
      JOIN public.candidacies candidacy
        ON candidacy.world_id=link.world_id
       AND candidacy.election_id=link.election_id
       AND candidacy.contest_id=link.contest_id
      WHERE link.world_id=checked_world_id
        AND link.contest_id=checked_contest_id
        AND candidacy.status='accepted';
      IF accepted_candidate_count>128 THEN
        RAISE EXCEPTION 'public election choice totals exceed the finite candidate bound'
          USING ERRCODE='54000';
      END IF;
      SELECT jsonb_build_object(
        'abstainCount',(
          SELECT count(*)
          FROM public.ballot_effective_revisions effective
          JOIN public.public_ballot_choices choice
            ON choice.world_id=effective.world_id
           AND choice.contest_id=effective.contest_id
           AND choice.participation_id=effective.participation_id
           AND choice.choice_revision_id=effective.choice_revision_id
          WHERE effective.world_id=checked_world_id
            AND effective.contest_id=checked_contest_id
            AND choice.choice_payload ->> 'choiceType'='abstain'
        ),
        'candidateTotals',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'candidateKey',candidate_key,
            'voteCount',vote_count
          ) ORDER BY candidate_key COLLATE "C")
          FROM (
            SELECT candidate.logical_key::text AS candidate_key,
              (
                SELECT count(*)
                FROM public.ballot_effective_revisions effective
                JOIN public.public_ballot_choices choice
                  ON choice.world_id=effective.world_id
                 AND choice.contest_id=effective.contest_id
                 AND choice.participation_id=effective.participation_id
                 AND choice.choice_revision_id=effective.choice_revision_id
                WHERE effective.world_id=checked_world_id
                  AND effective.contest_id=checked_contest_id
                  AND choice.choice_payload ->> 'choiceType'='candidate'
                  AND choice.choice_payload ->> 'candidateKey'=
                    candidate.logical_key::text
              ) AS vote_count
            FROM public.election_contests link
            JOIN public.candidacies candidacy
              ON candidacy.world_id=link.world_id
             AND candidacy.election_id=link.election_id
             AND candidacy.contest_id=link.contest_id
            JOIN public.world_entities candidate
              ON candidate.world_id=candidacy.world_id
             AND candidate.id=candidacy.candidate_entity_id
            WHERE link.world_id=checked_world_id
              AND link.contest_id=checked_contest_id
              AND candidacy.status='accepted'
          ) totals
        ),'[]'::jsonb)
      ) INTO computed_choice_totals;
    END IF;
  END IF;
  PERFORM set_config('worldgraph.ballot_participation_id','',true);
  RETURN QUERY SELECT checked_participation_id,checked_receipt_hash,
    contest_record.ballot_mode,next_revision,next_participation_version,
    computed_choice_totals;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('worldgraph.ballot_participation_id','',true);
  RAISE;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_cast_governance_ballot_v1(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,jsonb,bigint,boolean,
  bigint,uuid,uuid,bigint
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_ballot_receipt_v1(
  checked_world_id uuid,
  checked_contest_id uuid,
  checked_receipt_hash bytea
)
RETURNS TABLE (
  contest_id uuid,
  receipt_hash bytea,
  ballot_mode text,
  cast_tick bigint,
  effective boolean,
  public_choice jsonb
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT receipt.contest_id,receipt.receipt_hash,participation.ballot_mode,
    receipt.cast_tick,(effective.choice_revision_id = revision.id),
    CASE WHEN participation.ballot_mode = 'public'
      THEN choice.choice_payload ELSE NULL END
  FROM public.ballot_receipts receipt
  JOIN public.ballot_participation participation
    ON participation.world_id = receipt.world_id
   AND participation.id = receipt.participation_id
  JOIN public.ballot_choice_revisions revision
    ON revision.world_id = receipt.world_id
   AND revision.receipt_id = receipt.id
  LEFT JOIN public.ballot_effective_revisions effective
    ON effective.world_id = receipt.world_id
   AND effective.participation_id = receipt.participation_id
  LEFT JOIN public.public_ballot_choices choice
    ON choice.world_id = receipt.world_id
   AND choice.choice_revision_id = revision.id
  WHERE receipt.world_id = checked_world_id
    AND receipt.contest_id = checked_contest_id
    AND receipt.receipt_hash = checked_receipt_hash
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_ballot_receipt_v1(
  uuid,uuid,bytea
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_seed_governance_aggregate_stream_v1(
  checked_world_id uuid,
  checked_command_id uuid,
  checked_aggregate_type text,
  checked_aggregate_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_type text;
  aggregate_uuid uuid;
BEGIN
  IF checked_world_id IS NULL OR checked_command_id IS NULL
    OR checked_aggregate_type NOT IN ('election','office_term')
    OR checked_aggregate_id IS NULL
    OR checked_aggregate_id !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR checked_command_id::text IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')
    OR NOT public.worldgraph_command_write_is_open(
      checked_world_id,checked_command_id
    ) THEN
    RAISE EXCEPTION 'governance stream seed requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  aggregate_uuid := checked_aggregate_id::uuid;
  SELECT command.command_type INTO command_type
  FROM public.command_records command
  WHERE command.world_id = checked_world_id
    AND command.id = checked_command_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governance stream seed command is missing'
      USING ERRCODE = '55000';
  END IF;
  IF checked_aggregate_type = 'election' THEN
    IF command_type NOT IN (
        'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1',
        'CertifyElectionV1','OpenElectionV1'
      ) OR NOT EXISTS (
        SELECT 1 FROM public.elections election
        WHERE election.world_id = checked_world_id
          AND election.id = aggregate_uuid
          AND election.aggregate_version = 1
          AND election.created_command_id = checked_command_id
      ) THEN
      RAISE EXCEPTION 'election stream seed lacks exact aggregate provenance'
        USING ERRCODE = '55000';
    END IF;
  ELSIF command_type NOT IN (
      'CertifyElectionV1','CertifyAndEnactProposalV1','ExecuteCreatorOverrideV1'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.office_terms term
      WHERE term.world_id = checked_world_id
        AND term.id = aggregate_uuid
        AND term.created_command_id = checked_command_id
    ) THEN
    RAISE EXCEPTION 'office-term stream seed lacks exact aggregate provenance'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.aggregate_stream_heads head
    WHERE head.world_id = checked_world_id
      AND head.aggregate_type = checked_aggregate_type
      AND head.aggregate_id = checked_aggregate_id
  ) THEN
    RAISE EXCEPTION 'governance aggregate stream already exists'
      USING ERRCODE = '23505', CONSTRAINT = 'aggregate_stream_heads_pkey';
  END IF;
  INSERT INTO public.aggregate_stream_heads (
    world_id,aggregate_type,aggregate_id,current_version,updated_at
  ) VALUES (
    checked_world_id,checked_aggregate_type,checked_aggregate_id,1,
    date_trunc('milliseconds',transaction_timestamp())
  );
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_seed_governance_aggregate_stream_v1(
  uuid,uuid,text,text
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_persist_proposal_tally_v1(
  checked_tally_id uuid,
  checked_world_id uuid,
  checked_contest_id uuid,
  checked_proposal_id uuid,
  checked_eligibility_snapshot_id uuid,
  checked_expected_aggregate_version bigint,
  checked_algorithm_version text,
  checked_eligible_count integer,
  checked_participating_count integer,
  checked_quorum_required integer,
  checked_approval_required integer,
  checked_yes_count integer,
  checked_no_count integer,
  checked_abstain_count integer,
  checked_input_checksum bytea,
  checked_output_checksum bytea,
  checked_tallied_tick bigint,
  checked_command_id uuid,
  checked_yes_count_id uuid,
  checked_no_count_id uuid,
  checked_abstain_count_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  command_record record;
  contest_record record;
  ballots_document jsonb;
  expected_input_checksum bytea;
  expected_output_checksum bytea;
  actual_effective_count integer;
  actual_participating_count integer;
  actual_yes_count integer;
  actual_no_count integer;
  actual_abstain_count integer;
  actual_quorum_required integer;
  actual_approval_required integer;
  decisive_count integer;
  quorum_met boolean;
  threshold_met boolean;
  tally_outcome text;
  storage_is_valid boolean;
BEGIN
  IF checked_tally_id IS NULL OR checked_world_id IS NULL
    OR checked_contest_id IS NULL OR checked_proposal_id IS NULL
    OR checked_eligibility_snapshot_id IS NULL OR checked_command_id IS NULL
    OR checked_yes_count_id IS NULL OR checked_no_count_id IS NULL
    OR checked_abstain_count_id IS NULL
    OR checked_expected_aggregate_version < 1 OR checked_tallied_tick < 0
    OR checked_algorithm_version IS DISTINCT FROM 'proposal_yes_no_v1'
    OR checked_eligible_count NOT BETWEEN 0 AND 1000000
    OR checked_participating_count NOT BETWEEN 0 AND 1000000
    OR checked_yes_count NOT BETWEEN 0 AND 1000000
    OR checked_no_count NOT BETWEEN 0 AND 1000000
    OR checked_abstain_count NOT BETWEEN 0 AND 1000000
    OR checked_quorum_required NOT BETWEEN 0 AND 1000000
    OR checked_approval_required NOT BETWEEN 0 AND 1000000
    OR octet_length(checked_input_checksum) IS DISTINCT FROM 32
    OR octet_length(checked_output_checksum) IS DISTINCT FROM 32
    OR (
      SELECT count(DISTINCT identity)
      FROM unnest(ARRAY[
        checked_tally_id,checked_yes_count_id,checked_no_count_id,
        checked_abstain_count_id
      ]) AS identity
    ) <> 4 THEN
    RAISE EXCEPTION 'proposal tally persistence inputs are invalid'
      USING ERRCODE = '22023';
  END IF;

  IF checked_command_id::text IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')
    OR NOT public.worldgraph_command_write_is_open(
      checked_world_id,checked_command_id
    ) THEN
    RAISE EXCEPTION 'proposal tally persistence requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type,command.actor_type::text AS actor_type,command.payload,
    command.expected_tick
    INTO command_record
  FROM public.command_records command
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  IF NOT FOUND OR command_record.command_type IS DISTINCT FROM 'CloseAndTallyProposalV1'
    OR command_record.actor_type IS DISTINCT FROM 'system'
    OR command_record.expected_tick IS DISTINCT FROM checked_tallied_tick
    OR command_record.payload IS DISTINCT FROM jsonb_build_object(
      'algorithmVersion',checked_algorithm_version,
      'eligibilitySnapshotId',checked_eligibility_snapshot_id::text,
      'expectedProposalVersion',checked_expected_aggregate_version::text,
      'occurrenceKey',command_record.payload ->> 'occurrenceKey',
      'proposalId',checked_proposal_id::text
    )
    OR NOT COALESCE(public.worldgraph_governance_key_is_valid_v1(
      command_record.payload ->> 'occurrenceKey'
    ),false) THEN
    RAISE EXCEPTION 'proposal tally persistence command identity is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT contest.status AS contest_status,
    contest.aggregate_version AS contest_version,
    contest.closes_tick AS contest_closes_tick,
    contest.ballot_mode,
    proposal.status AS proposal_status,
    proposal.aggregate_version AS proposal_version,
    proposal.voting_closes_tick,
    proposal.quorum_numerator,
    proposal.threshold_numerator,
    snapshot.eligible_count AS snapshot_eligible_count
    INTO contest_record
  FROM public.governance_contests contest
  JOIN public.proposal_contests contest_link
    ON contest_link.world_id = contest.world_id
   AND contest_link.contest_id = contest.id
   AND contest_link.proposal_id = checked_proposal_id
  JOIN public.proposals proposal
    ON proposal.world_id = contest_link.world_id
   AND proposal.id = contest_link.proposal_id
  JOIN public.eligibility_snapshots snapshot
    ON snapshot.world_id = contest.world_id
   AND snapshot.id = checked_eligibility_snapshot_id
   AND snapshot.contest_id = contest.id
  WHERE contest.world_id = checked_world_id
    AND contest.id = checked_contest_id
    AND contest.contest_kind = 'proposal'
  FOR UPDATE OF contest,proposal;
  IF NOT FOUND OR contest_record.contest_status IS DISTINCT FROM 'open'
    OR contest_record.proposal_status IS DISTINCT FROM 'open'
    OR contest_record.contest_version IS DISTINCT FROM checked_expected_aggregate_version
    OR contest_record.proposal_version IS DISTINCT FROM checked_expected_aggregate_version
    OR contest_record.contest_closes_tick IS DISTINCT FROM contest_record.voting_closes_tick
    OR checked_tallied_tick < contest_record.contest_closes_tick
    OR NOT EXISTS (
      SELECT 1 FROM public.world_simulation_clocks clock
      WHERE clock.world_id = checked_world_id
        AND clock.current_tick = checked_tallied_tick
    ) THEN
    RAISE EXCEPTION 'proposal tally contest, snapshot, version, or tick is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.proposal_tallies tally
    WHERE tally.world_id = checked_world_id
      AND tally.contest_id = checked_contest_id
  ) THEN
    RAISE EXCEPTION 'proposal contest already has a persisted tally'
      USING ERRCODE = '23505', CONSTRAINT = 'proposal_tallies_version_unique';
  END IF;

  SELECT count(*)::integer INTO actual_effective_count
  FROM public.ballot_effective_revisions effective
  WHERE effective.world_id = checked_world_id
    AND effective.contest_id = checked_contest_id;
  WITH stored_ballots AS (
    SELECT revision.id AS ballot_key,
      COALESCE(public_choice.choice_payload,secret_choice.choice_payload) AS choice_payload,
      ((public_choice.choice_revision_id IS NOT NULL)::integer
        + (secret_choice.choice_revision_id IS NOT NULL)::integer) AS storage_count,
      revision.storage_mode,
      revision.choice_hash AS revision_choice_hash,
      COALESCE(public_choice.choice_hash,secret_choice.choice_hash) AS stored_choice_hash,
      effective.participation_id AS effective_participation_id,
      revision.participation_id AS revision_participation_id
    FROM public.ballot_effective_revisions effective
    JOIN public.ballot_choice_revisions revision
      ON revision.world_id = effective.world_id
     AND revision.id = effective.choice_revision_id
     AND revision.contest_id = effective.contest_id
    LEFT JOIN public.public_ballot_choices public_choice
      ON public_choice.world_id = revision.world_id
     AND public_choice.choice_revision_id = revision.id
     AND public_choice.contest_id = revision.contest_id
     AND public_choice.participation_id = revision.participation_id
    LEFT JOIN public.secret_ballot_choices secret_choice
      ON secret_choice.world_id = revision.world_id
     AND secret_choice.choice_revision_id = revision.id
     AND secret_choice.contest_id = revision.contest_id
     AND secret_choice.participation_id = revision.participation_id
    WHERE effective.world_id = checked_world_id
      AND effective.contest_id = checked_contest_id
  )
  SELECT count(*)::integer,
    (count(*) FILTER (WHERE choice_payload ->> 'choice' = 'yes'))::integer,
    (count(*) FILTER (WHERE choice_payload ->> 'choice' = 'no'))::integer,
    (count(*) FILTER (WHERE choice_payload ->> 'choice' = 'abstain'))::integer,
    COALESCE(bool_and(
      storage_count = 1
      AND storage_mode = contest_record.ballot_mode
      AND effective_participation_id = revision_participation_id
      AND revision_choice_hash = stored_choice_hash
      AND choice_payload = jsonb_build_object('choice',choice_payload ->> 'choice')
      AND choice_payload ->> 'choice' IN ('yes','no','abstain')
    ),true),
    COALESCE(jsonb_agg(jsonb_build_object(
      'ballotKey',ballot_key::text,
      'choice',choice_payload ->> 'choice'
    ) ORDER BY (ballot_key::text) COLLATE "C"),'[]'::jsonb)
    INTO actual_participating_count,actual_yes_count,actual_no_count,
      actual_abstain_count,storage_is_valid,ballots_document
  FROM stored_ballots;

  decisive_count := actual_yes_count + actual_no_count;
  actual_quorum_required := (
    (contest_record.snapshot_eligible_count::bigint
      * contest_record.quorum_numerator::bigint + 9999) / 10000
  )::integer;
  actual_approval_required := (
    (decisive_count::bigint * contest_record.threshold_numerator::bigint + 9999)
      / 10000
  )::integer;
  quorum_met := actual_participating_count::bigint * 10000
    >= contest_record.snapshot_eligible_count::bigint
      * contest_record.quorum_numerator::bigint;
  threshold_met := decisive_count > 0
    AND actual_yes_count::bigint * 10000
      >= decisive_count::bigint * contest_record.threshold_numerator::bigint;
  tally_outcome := CASE
    WHEN NOT quorum_met THEN 'rejected_quorum'
    WHEN threshold_met THEN 'passed'
    ELSE 'rejected_threshold'
  END;
  expected_input_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance.proposal-tally-input.v1',
      'value',jsonb_build_object(
        'algorithmVersion','proposal_yes_no_v1',
        'approvalThresholdBps',contest_record.threshold_numerator,
        'ballots',ballots_document,
        'eligibleCount',contest_record.snapshot_eligible_count,
        'quorumBps',contest_record.quorum_numerator
      )
    )),'UTF8'
  ),'sha256');
  expected_output_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance.proposal-tally-result.v1',
      'value',jsonb_build_object(
        'abstainCount',actual_abstain_count,
        'algorithmVersion','proposal_yes_no_v1',
        'approvalThresholdBps',contest_record.threshold_numerator,
        'eligibleCount',contest_record.snapshot_eligible_count,
        'inputChecksum',encode(expected_input_checksum,'hex'),
        'noCount',actual_no_count,
        'outcome',tally_outcome,
        'quorumBps',contest_record.quorum_numerator,
        'quorumSatisfied',quorum_met,
        'thresholdSatisfied',threshold_met,
        'turnoutCount',actual_participating_count,
        'yesCount',actual_yes_count
      )
    )),'UTF8'
  ),'sha256');

  IF NOT storage_is_valid OR actual_effective_count <> actual_participating_count
    OR actual_participating_count > contest_record.snapshot_eligible_count
    OR checked_eligible_count IS DISTINCT FROM contest_record.snapshot_eligible_count
    OR checked_participating_count IS DISTINCT FROM actual_participating_count
    OR checked_quorum_required IS DISTINCT FROM actual_quorum_required
    OR checked_approval_required IS DISTINCT FROM actual_approval_required
    OR checked_yes_count IS DISTINCT FROM actual_yes_count
    OR checked_no_count IS DISTINCT FROM actual_no_count
    OR checked_abstain_count IS DISTINCT FROM actual_abstain_count
    OR checked_input_checksum IS DISTINCT FROM expected_input_checksum
    OR checked_output_checksum IS DISTINCT FROM expected_output_checksum THEN
    RAISE EXCEPTION 'proposal tally evidence does not match the frozen effective ballots'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.proposal_tallies (
    id,world_id,contest_id,proposal_id,eligibility_snapshot_id,tally_version,
    algorithm_version,eligible_count,participating_count,quorum_required,
    approval_required,input_checksum,output_checksum,recount_of_tally_id,tallied_tick
  ) VALUES (
    checked_tally_id,checked_world_id,checked_contest_id,checked_proposal_id,
    checked_eligibility_snapshot_id,1,'proposal_yes_no_v1',checked_eligible_count,
    checked_participating_count,checked_quorum_required,checked_approval_required,
    checked_input_checksum,checked_output_checksum,NULL,checked_tallied_tick
  );
  INSERT INTO public.proposal_tally_counts (
    id,world_id,tally_id,choice_code,ballot_count,weighted_count
  ) VALUES
    (checked_yes_count_id,checked_world_id,checked_tally_id,'yes',
      checked_yes_count,checked_yes_count::bigint),
    (checked_no_count_id,checked_world_id,checked_tally_id,'no',
      checked_no_count,checked_no_count::bigint),
    (checked_abstain_count_id,checked_world_id,checked_tally_id,'abstain',
      checked_abstain_count,checked_abstain_count::bigint);
  RETURN checked_tally_id;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_persist_proposal_tally_v1(
  uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,integer,
  integer,integer,integer,bytea,bytea,bigint,uuid,uuid,uuid,uuid
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_persist_election_tally_v1(
  checked_tally_id uuid,
  checked_world_id uuid,
  checked_contest_id uuid,
  checked_election_id uuid,
  checked_eligibility_snapshot_id uuid,
  checked_expected_aggregate_version bigint,
  checked_algorithm_version text,
  checked_eligible_count integer,
  checked_participating_count integer,
  checked_abstain_count integer,
  checked_input_checksum bytea,
  checked_output_checksum bytea,
  checked_tallied_tick bigint,
  checked_command_id uuid,
  checked_candidate_counts jsonb,
  checked_abstain_count_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  command_record record;
  contest_record record;
  ballots_document jsonb;
  candidate_keys_document jsonb;
  candidate_totals_document jsonb;
  tied_candidate_keys_document jsonb := '[]'::jsonb;
  expected_input_checksum bytea;
  expected_output_checksum bytea;
  actual_effective_count integer;
  actual_participating_count integer;
  actual_abstain_count integer;
  accepted_candidate_count integer;
  non_abstain_count integer;
  maximum_votes integer;
  quorum_met boolean;
  tally_outcome text;
  winner_candidate_key text;
  storage_is_valid boolean;
  candidate_evidence_is_valid boolean;
BEGIN
  IF checked_tally_id IS NULL OR checked_world_id IS NULL
    OR checked_contest_id IS NULL OR checked_election_id IS NULL
    OR checked_eligibility_snapshot_id IS NULL OR checked_command_id IS NULL
    OR checked_abstain_count_id IS NULL
    OR checked_expected_aggregate_version < 1 OR checked_tallied_tick < 0
    OR checked_algorithm_version IS DISTINCT FROM 'election_plurality_v1'
    OR checked_eligible_count NOT BETWEEN 0 AND 1000000
    OR checked_participating_count NOT BETWEEN 0 AND 1000000
    OR checked_abstain_count NOT BETWEEN 0 AND 1000000
    OR octet_length(checked_input_checksum) IS DISTINCT FROM 32
    OR octet_length(checked_output_checksum) IS DISTINCT FROM 32
    OR jsonb_typeof(checked_candidate_counts) IS DISTINCT FROM 'array'
    OR checked_tally_id = checked_abstain_count_id THEN
    RAISE EXCEPTION 'election tally persistence inputs are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(checked_candidate_counts) entry
    WHERE jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT COALESCE(
        entry ? 'countId' AND entry ? 'candidacyId' AND entry ? 'ballotCount'
        AND entry ->> 'countId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND entry ->> 'candidacyId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND entry ->> 'ballotCount' ~ '^(0|[1-9][0-9]{0,6})$',
        false
      )
  ) THEN
    RAISE EXCEPTION 'election candidate tally evidence is malformed'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(checked_candidate_counts) entry
    WHERE entry IS DISTINCT FROM jsonb_build_object(
      'ballotCount',(entry ->> 'ballotCount')::integer,
      'candidacyId',entry ->> 'candidacyId',
      'countId',entry ->> 'countId'
    )
  ) OR (
    SELECT count(DISTINCT (entry ->> 'countId')::uuid)
    FROM jsonb_array_elements(checked_candidate_counts) entry
  ) <> jsonb_array_length(checked_candidate_counts)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(checked_candidate_counts) entry
      WHERE (entry ->> 'countId')::uuid IN (
        checked_tally_id,checked_abstain_count_id
      )
    ) THEN
    RAISE EXCEPTION 'election candidate tally identities are invalid'
      USING ERRCODE = '22023';
  END IF;

  IF checked_command_id::text IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')
    OR NOT public.worldgraph_command_write_is_open(
      checked_world_id,checked_command_id
    ) THEN
    RAISE EXCEPTION 'election tally persistence requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type,command.actor_type::text AS actor_type,command.payload,
    command.expected_tick
    INTO command_record
  FROM public.command_records command
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  IF NOT FOUND OR command_record.command_type IS DISTINCT FROM 'CloseAndTallyElectionV1'
    OR command_record.actor_type IS DISTINCT FROM 'system'
    OR command_record.expected_tick IS DISTINCT FROM checked_tallied_tick
    OR command_record.payload IS DISTINCT FROM jsonb_build_object(
      'algorithmVersion',checked_algorithm_version,
      'electionId',checked_election_id::text,
      'eligibilitySnapshotId',checked_eligibility_snapshot_id::text,
      'expectedElectionVersion',checked_expected_aggregate_version::text,
      'occurrenceKey',command_record.payload ->> 'occurrenceKey'
    )
    OR NOT COALESCE(public.worldgraph_governance_key_is_valid_v1(
      command_record.payload ->> 'occurrenceKey'
    ),false) THEN
    RAISE EXCEPTION 'election tally persistence command identity is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT contest.status AS contest_status,
    contest.aggregate_version AS contest_version,
    contest.closes_tick AS contest_closes_tick,
    contest.ballot_mode,
    election.status AS election_status,
    election.aggregate_version AS election_version,
    election.voting_closes_tick,
    election.quorum_numerator,
    election.tie_rule,
    snapshot.eligible_count AS snapshot_eligible_count
    INTO contest_record
  FROM public.governance_contests contest
  JOIN public.election_contests contest_link
    ON contest_link.world_id = contest.world_id
   AND contest_link.contest_id = contest.id
   AND contest_link.election_id = checked_election_id
  JOIN public.elections election
    ON election.world_id = contest_link.world_id
   AND election.id = contest_link.election_id
  JOIN public.eligibility_snapshots snapshot
    ON snapshot.world_id = contest.world_id
   AND snapshot.id = checked_eligibility_snapshot_id
   AND snapshot.contest_id = contest.id
  WHERE contest.world_id = checked_world_id
    AND contest.id = checked_contest_id
    AND contest.contest_kind = 'election'
  FOR UPDATE OF contest,election;
  IF NOT FOUND OR contest_record.contest_status IS DISTINCT FROM 'open'
    OR contest_record.election_status IS DISTINCT FROM 'open'
    OR contest_record.contest_version IS DISTINCT FROM checked_expected_aggregate_version
    OR contest_record.election_version IS DISTINCT FROM checked_expected_aggregate_version
    OR contest_record.contest_closes_tick IS DISTINCT FROM contest_record.voting_closes_tick
    OR checked_tallied_tick < contest_record.contest_closes_tick
    OR NOT EXISTS (
      SELECT 1 FROM public.world_simulation_clocks clock
      WHERE clock.world_id = checked_world_id
        AND clock.current_tick = checked_tallied_tick
    ) THEN
    RAISE EXCEPTION 'election tally contest, snapshot, version, or tick is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.election_tallies tally
    WHERE tally.world_id = checked_world_id
      AND tally.contest_id = checked_contest_id
  ) THEN
    RAISE EXCEPTION 'election contest already has a persisted tally'
      USING ERRCODE = '23505', CONSTRAINT = 'election_tallies_version_unique';
  END IF;

  SELECT count(*)::integer INTO actual_effective_count
  FROM public.ballot_effective_revisions effective
  WHERE effective.world_id = checked_world_id
    AND effective.contest_id = checked_contest_id;
  WITH stored_ballots AS (
    SELECT revision.id AS ballot_key,
      COALESCE(public_choice.choice_payload,secret_choice.choice_payload) AS choice_payload,
      ((public_choice.choice_revision_id IS NOT NULL)::integer
        + (secret_choice.choice_revision_id IS NOT NULL)::integer) AS storage_count,
      revision.storage_mode,
      revision.choice_hash AS revision_choice_hash,
      COALESCE(public_choice.choice_hash,secret_choice.choice_hash) AS stored_choice_hash,
      effective.participation_id AS effective_participation_id,
      revision.participation_id AS revision_participation_id
    FROM public.ballot_effective_revisions effective
    JOIN public.ballot_choice_revisions revision
      ON revision.world_id = effective.world_id
     AND revision.id = effective.choice_revision_id
     AND revision.contest_id = effective.contest_id
    LEFT JOIN public.public_ballot_choices public_choice
      ON public_choice.world_id = revision.world_id
     AND public_choice.choice_revision_id = revision.id
     AND public_choice.contest_id = revision.contest_id
     AND public_choice.participation_id = revision.participation_id
    LEFT JOIN public.secret_ballot_choices secret_choice
      ON secret_choice.world_id = revision.world_id
     AND secret_choice.choice_revision_id = revision.id
     AND secret_choice.contest_id = revision.contest_id
     AND secret_choice.participation_id = revision.participation_id
    WHERE effective.world_id = checked_world_id
      AND effective.contest_id = checked_contest_id
  )
  SELECT count(*)::integer,
    (count(*) FILTER (WHERE choice_payload ->> 'choiceType' = 'abstain'))::integer,
    COALESCE(bool_and(
      storage_count = 1
      AND storage_mode = contest_record.ballot_mode
      AND effective_participation_id = revision_participation_id
      AND revision_choice_hash = stored_choice_hash
      AND (
        choice_payload = jsonb_build_object('choiceType','abstain')
        OR choice_payload = jsonb_build_object(
          'candidateKey',choice_payload ->> 'candidateKey',
          'choiceType','candidate'
        )
      )
      AND choice_payload ->> 'choiceType' IN ('candidate','abstain')
    ),true),
    COALESCE(jsonb_agg(jsonb_build_object(
      'ballotKey',ballot_key::text,
      'candidateKey',CASE WHEN choice_payload ->> 'choiceType' = 'candidate'
        THEN choice_payload ->> 'candidateKey' ELSE NULL END
    ) ORDER BY (ballot_key::text) COLLATE "C"),'[]'::jsonb)
    INTO actual_participating_count,actual_abstain_count,
      storage_is_valid,ballots_document
  FROM stored_ballots;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(ballots_document) ballot
    WHERE ballot ->> 'candidateKey' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.candidacies candidacy
        JOIN public.world_entities entity
          ON entity.world_id = candidacy.world_id
         AND entity.id = candidacy.candidate_entity_id
        WHERE candidacy.world_id = checked_world_id
          AND candidacy.election_id = checked_election_id
          AND candidacy.contest_id = checked_contest_id
          AND candidacy.status = 'accepted'
          AND entity.logical_key::text = ballot ->> 'candidateKey'
      )
  ) THEN
    storage_is_valid := false;
  END IF;
  WITH accepted_candidates AS (
    SELECT candidacy.id AS candidacy_id,entity.logical_key::text AS candidate_key
    FROM public.candidacies candidacy
    JOIN public.world_entities entity
      ON entity.world_id = candidacy.world_id
     AND entity.id = candidacy.candidate_entity_id
    WHERE candidacy.world_id = checked_world_id
      AND candidacy.election_id = checked_election_id
      AND candidacy.contest_id = checked_contest_id
      AND candidacy.status = 'accepted'
  ), candidate_totals AS (
    SELECT candidate.candidacy_id,candidate.candidate_key,
      (
        SELECT count(*)::integer
        FROM jsonb_array_elements(ballots_document) ballot
        WHERE ballot ->> 'candidateKey' = candidate.candidate_key
      ) AS vote_count
    FROM accepted_candidates candidate
  )
  SELECT count(*)::integer,
    COALESCE(jsonb_agg(to_jsonb(candidate_key)
      ORDER BY candidate_key COLLATE "C"),'[]'::jsonb),
    COALESCE(jsonb_agg(jsonb_build_object(
      'candidateKey',candidate_key,'voteCount',vote_count
    ) ORDER BY candidate_key COLLATE "C"),'[]'::jsonb)
    INTO accepted_candidate_count,candidate_keys_document,candidate_totals_document
  FROM candidate_totals;

  WITH supplied AS (
    SELECT (entry ->> 'countId')::uuid AS count_id,
      (entry ->> 'candidacyId')::uuid AS candidacy_id,
      (entry ->> 'ballotCount')::integer AS ballot_count
    FROM jsonb_array_elements(checked_candidate_counts) entry
  ), accepted AS (
    SELECT candidacy.id AS candidacy_id,entity.logical_key::text AS candidate_key
    FROM public.candidacies candidacy
    JOIN public.world_entities entity
      ON entity.world_id = candidacy.world_id
     AND entity.id = candidacy.candidate_entity_id
    WHERE candidacy.world_id = checked_world_id
      AND candidacy.election_id = checked_election_id
      AND candidacy.contest_id = checked_contest_id
      AND candidacy.status = 'accepted'
  )
  SELECT jsonb_array_length(checked_candidate_counts) = accepted_candidate_count
    AND count(DISTINCT supplied.candidacy_id) = accepted_candidate_count
    AND count(*) = accepted_candidate_count
    AND COALESCE(bool_and(
      accepted.candidacy_id IS NOT NULL
      AND supplied.ballot_count = (
        SELECT count(*)::integer
        FROM jsonb_array_elements(ballots_document) ballot
        WHERE ballot ->> 'candidateKey' = accepted.candidate_key
      )
    ),false)
    INTO candidate_evidence_is_valid
  FROM supplied
  LEFT JOIN accepted ON accepted.candidacy_id = supplied.candidacy_id;

  non_abstain_count := actual_participating_count - actual_abstain_count;
  quorum_met := actual_participating_count::bigint * 10000
    >= contest_record.snapshot_eligible_count::bigint
      * contest_record.quorum_numerator::bigint;
  IF quorum_met AND non_abstain_count > 0 THEN
    SELECT max((candidate_total ->> 'voteCount')::integer)
      INTO maximum_votes
    FROM jsonb_array_elements(candidate_totals_document) candidate_total;
    SELECT COALESCE(jsonb_agg(to_jsonb(candidate_total ->> 'candidateKey')
      ORDER BY (candidate_total ->> 'candidateKey') COLLATE "C"),'[]'::jsonb)
      INTO tied_candidate_keys_document
    FROM jsonb_array_elements(candidate_totals_document) candidate_total
    WHERE (candidate_total ->> 'voteCount')::integer = maximum_votes;
  END IF;
  IF NOT quorum_met THEN
    tally_outcome := 'vacant_no_quorum';
  ELSIF non_abstain_count = 0 THEN
    tally_outcome := 'vacant_no_votes';
  ELSIF jsonb_array_length(tied_candidate_keys_document) > 1
    AND contest_record.tie_rule = 'vacancy' THEN
    tally_outcome := 'vacant_tie';
  ELSE
    tally_outcome := 'elected';
    winner_candidate_key := tied_candidate_keys_document ->> 0;
  END IF;
  expected_input_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance.election-tally-input.v1',
      'value',jsonb_build_object(
        'algorithmVersion','election_plurality_v1',
        'ballots',ballots_document,
        'candidateKeys',candidate_keys_document,
        'eligibleCount',contest_record.snapshot_eligible_count,
        'quorumBps',contest_record.quorum_numerator,
        'tieRule',contest_record.tie_rule
      )
    )),'UTF8'
  ),'sha256');
  expected_output_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance.election-tally-result.v1',
      'value',jsonb_build_object(
        'abstainCount',actual_abstain_count,
        'algorithmVersion','election_plurality_v1',
        'candidateTotals',candidate_totals_document,
        'eligibleCount',contest_record.snapshot_eligible_count,
        'inputChecksum',encode(expected_input_checksum,'hex'),
        'outcome',tally_outcome,
        'quorumBps',contest_record.quorum_numerator,
        'quorumSatisfied',quorum_met,
        'tieRule',contest_record.tie_rule,
        'tiedCandidateKeys',tied_candidate_keys_document,
        'turnoutCount',actual_participating_count,
        'winnerCandidateKey',winner_candidate_key
      )
    )),'UTF8'
  ),'sha256');

  IF NOT storage_is_valid OR NOT candidate_evidence_is_valid
    OR accepted_candidate_count NOT BETWEEN 1 AND 128
    OR actual_effective_count <> actual_participating_count
    OR actual_participating_count > contest_record.snapshot_eligible_count
    OR checked_eligible_count IS DISTINCT FROM contest_record.snapshot_eligible_count
    OR checked_participating_count IS DISTINCT FROM actual_participating_count
    OR checked_abstain_count IS DISTINCT FROM actual_abstain_count
    OR checked_input_checksum IS DISTINCT FROM expected_input_checksum
    OR checked_output_checksum IS DISTINCT FROM expected_output_checksum THEN
    RAISE EXCEPTION 'election tally evidence does not match the frozen effective ballots'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.election_tallies (
    id,world_id,contest_id,election_id,eligibility_snapshot_id,tally_version,
    algorithm_version,eligible_count,participating_count,input_checksum,
    output_checksum,recount_of_tally_id,tallied_tick
  ) VALUES (
    checked_tally_id,checked_world_id,checked_contest_id,checked_election_id,
    checked_eligibility_snapshot_id,1,'election_plurality_v1',
    checked_eligible_count,checked_participating_count,checked_input_checksum,
    checked_output_checksum,NULL,checked_tallied_tick
  );
  INSERT INTO public.election_tally_counts (
    id,world_id,tally_id,candidacy_id,count_kind,ballot_count,weighted_count
  )
  SELECT (entry ->> 'countId')::uuid,checked_world_id,checked_tally_id,
    (entry ->> 'candidacyId')::uuid,'candidate',
    (entry ->> 'ballotCount')::integer,
    (entry ->> 'ballotCount')::bigint
  FROM jsonb_array_elements(checked_candidate_counts) entry;
  INSERT INTO public.election_tally_counts (
    id,world_id,tally_id,candidacy_id,count_kind,ballot_count,weighted_count
  ) VALUES (
    checked_abstain_count_id,checked_world_id,checked_tally_id,NULL,'abstain',
    checked_abstain_count,checked_abstain_count::bigint
  );
  RETURN checked_tally_id;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_persist_election_tally_v1(
  uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,bytea,bytea,
  bigint,uuid,jsonb,uuid
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_recount_proposal_result_v1(
  checked_world_id uuid,
  checked_source_result_id uuid,
  checked_replacement_result_id uuid,
  checked_replacement_tally_id uuid,
  checked_yes_count_id uuid,
  checked_no_count_id uuid,
  checked_abstain_count_id uuid,
  checked_expected_source_checksum bytea,
  checked_expected_replacement_checksum bytea,
  checked_command_id uuid,
  checked_event_id uuid,
  checked_state_revision bigint,
  checked_recount_tick bigint
)
RETURNS TABLE (
  result_id uuid,
  tally_id uuid,
  input_checksum bytea,
  result_checksum bytea,
  outcome text,
  quorum_met boolean,
  threshold_met boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  command_record record;
  source_record record;
  ballots_document jsonb;
  expected_input_checksum bytea;
  expected_output_checksum bytea;
  actual_effective_count integer;
  actual_eligible_count integer;
  actual_participating_count integer;
  actual_yes_count integer;
  actual_no_count integer;
  actual_abstain_count integer;
  actual_quorum_required integer;
  actual_approval_required integer;
  decisive_count integer;
  checked_quorum_met boolean;
  checked_threshold_met boolean;
  tally_outcome text;
  storage_is_valid boolean;
BEGIN
  IF checked_world_id IS NULL OR checked_source_result_id IS NULL
    OR checked_replacement_result_id IS NULL OR checked_replacement_tally_id IS NULL
    OR checked_yes_count_id IS NULL OR checked_no_count_id IS NULL
    OR checked_abstain_count_id IS NULL OR checked_command_id IS NULL
    OR checked_event_id IS NULL OR checked_state_revision < 1
    OR checked_recount_tick < 0
    OR octet_length(checked_expected_source_checksum) IS DISTINCT FROM 32
    OR octet_length(checked_expected_replacement_checksum) IS DISTINCT FROM 32
    OR (
      SELECT count(DISTINCT identity)
      FROM unnest(ARRAY[
        checked_source_result_id,checked_replacement_result_id,
        checked_replacement_tally_id,checked_yes_count_id,checked_no_count_id,
        checked_abstain_count_id
      ]) AS identity
    ) <> 6 THEN
    RAISE EXCEPTION 'proposal recount identities or checksums are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF checked_command_id::text IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')
    OR NOT public.worldgraph_command_write_is_open(
      checked_world_id,checked_command_id
    ) THEN
    RAISE EXCEPTION 'proposal recount requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type,command.actor_type::text AS actor_type,
    command.payload,command.expected_tick,runtime.state_revision
    INTO command_record
  FROM public.command_records command
  JOIN public.world_runtime_heads runtime ON runtime.world_id = command.world_id
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  IF NOT FOUND OR command_record.command_type IS DISTINCT FROM 'RepairGovernanceResultV1'
    OR command_record.actor_type NOT IN ('user','platform_admin')
    OR command_record.expected_tick IS DISTINCT FROM checked_recount_tick
    OR command_record.state_revision + 1 IS DISTINCT FROM checked_state_revision
    OR command_record.payload IS DISTINCT FROM jsonb_build_object(
      'approvalId',command_record.payload -> 'approvalId',
      'confirmation','APPEND LINKED GOVERNANCE REPAIR',
      'expectedCurrentResultChecksum',encode(checked_expected_source_checksum,'hex'),
      'reason',command_record.payload -> 'reason',
      'repairKind','proposal_recount',
      'replacementResultChecksum',encode(checked_expected_replacement_checksum,'hex'),
      'sourceResultId',checked_source_result_id::text
    ) OR NOT EXISTS (
      SELECT 1 FROM public.world_simulation_clocks clock
      WHERE clock.world_id = checked_world_id
        AND clock.current_tick = checked_recount_tick
    ) THEN
    RAISE EXCEPTION 'proposal recount command identity is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT result.contest_id,result.proposal_id,result.tally_id AS source_tally_id,
    result.result_checksum AS source_result_checksum,
    tally.tally_version AS source_tally_version,
    tally.algorithm_version AS source_algorithm_version,
    tally.eligibility_snapshot_id,
    tally.eligible_count AS source_eligible_count,
    tally.input_checksum AS source_input_checksum,
    tally.output_checksum AS source_output_checksum,
    contest.status AS contest_status,contest.ballot_mode AS contest_ballot_mode,
    contest.closes_tick AS contest_closes_tick,
    proposal.status AS proposal_status,
    proposal.ballot_mode AS proposal_ballot_mode,
    proposal.quorum_numerator,proposal.threshold_numerator,
    snapshot.eligible_count AS snapshot_eligible_count
    INTO source_record
  FROM public.proposal_results result
  JOIN public.proposal_tallies tally
    ON tally.world_id = result.world_id AND tally.id = result.tally_id
   AND tally.contest_id = result.contest_id AND tally.proposal_id = result.proposal_id
  JOIN public.proposal_contests contest_link
    ON contest_link.world_id = result.world_id
   AND contest_link.contest_id = result.contest_id
   AND contest_link.proposal_id = result.proposal_id
  JOIN public.governance_contests contest
    ON contest.world_id = contest_link.world_id AND contest.id = contest_link.contest_id
   AND contest.contest_kind = 'proposal'
  JOIN public.proposals proposal
    ON proposal.world_id = result.world_id AND proposal.id = result.proposal_id
  JOIN public.eligibility_snapshots snapshot
    ON snapshot.world_id = tally.world_id AND snapshot.id = tally.eligibility_snapshot_id
   AND snapshot.contest_id = tally.contest_id
  WHERE result.world_id = checked_world_id
    AND result.id = checked_source_result_id
  FOR UPDATE OF result;
  IF NOT FOUND
    OR source_record.source_result_checksum
      IS DISTINCT FROM checked_expected_source_checksum
    OR source_record.source_output_checksum
      IS DISTINCT FROM source_record.source_result_checksum
    OR source_record.source_algorithm_version
      IS DISTINCT FROM 'proposal_yes_no_v1'
    OR source_record.source_tally_version NOT BETWEEN 1 AND 999
    OR source_record.source_eligible_count
      IS DISTINCT FROM source_record.snapshot_eligible_count
    OR source_record.contest_status IS DISTINCT FROM 'certified'
    OR source_record.proposal_status NOT IN (
      'enacted','rejected','passed_but_enactment_failed'
    )
    OR source_record.contest_ballot_mode
      IS DISTINCT FROM source_record.proposal_ballot_mode
    OR checked_recount_tick < source_record.contest_closes_tick
    OR EXISTS (
      SELECT 1 FROM public.proposal_results replacement
      WHERE replacement.world_id = checked_world_id
        AND replacement.repair_of_result_id = checked_source_result_id
    ) OR EXISTS (
      SELECT 1 FROM public.proposal_tallies newer_tally
      WHERE newer_tally.world_id = checked_world_id
        AND newer_tally.contest_id = source_record.contest_id
        AND newer_tally.tally_version > source_record.source_tally_version
    ) THEN
    RAISE EXCEPTION 'proposal recount source is stale or inconsistent'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::integer INTO actual_eligible_count
  FROM public.eligibility_snapshot_members member
  WHERE member.world_id = checked_world_id
    AND member.snapshot_id = source_record.eligibility_snapshot_id
    AND member.contest_id = source_record.contest_id
    AND member.voting_weight = 1;
  SELECT count(*)::integer INTO actual_effective_count
  FROM public.ballot_effective_revisions effective
  WHERE effective.world_id = checked_world_id
    AND effective.contest_id = source_record.contest_id;
  WITH stored_ballots AS (
    SELECT revision.id AS ballot_key,revision.revision,
      revision.cast_tick,revision.storage_mode,
      revision.choice_hash AS revision_choice_hash,
      COALESCE(public_choice.choice_payload,secret_choice.choice_payload)
        AS choice_payload,
      COALESCE(public_choice.choice_hash,secret_choice.choice_hash)
        AS stored_choice_hash,
      ((public_choice.choice_revision_id IS NOT NULL)::integer
        + (secret_choice.choice_revision_id IS NOT NULL)::integer) AS storage_count,
      participation.ballot_mode AS participation_ballot_mode,
      participation.current_revision,participation.aggregate_version,
      participation.eligibility_snapshot_id AS participation_snapshot_id,
      effective.effective_revision,effective.row_version
    FROM public.ballot_effective_revisions effective
    JOIN public.ballot_participation participation
      ON participation.world_id = effective.world_id
     AND participation.id = effective.participation_id
     AND participation.contest_id = effective.contest_id
    JOIN public.eligibility_snapshot_members member
      ON member.world_id = participation.world_id
     AND member.snapshot_id = participation.eligibility_snapshot_id
     AND member.contest_id = participation.contest_id
     AND member.voter_entity_id = participation.voter_entity_id
     AND member.voting_weight = 1
    JOIN public.ballot_choice_revisions revision
      ON revision.world_id = effective.world_id
     AND revision.id = effective.choice_revision_id
     AND revision.contest_id = effective.contest_id
     AND revision.participation_id = effective.participation_id
    LEFT JOIN public.public_ballot_choices public_choice
      ON public_choice.world_id = revision.world_id
     AND public_choice.choice_revision_id = revision.id
     AND public_choice.contest_id = revision.contest_id
     AND public_choice.participation_id = revision.participation_id
     AND public_choice.voter_entity_id = participation.voter_entity_id
    LEFT JOIN public.secret_ballot_choices secret_choice
      ON secret_choice.world_id = revision.world_id
     AND secret_choice.choice_revision_id = revision.id
     AND secret_choice.contest_id = revision.contest_id
     AND secret_choice.participation_id = revision.participation_id
    WHERE effective.world_id = checked_world_id
      AND effective.contest_id = source_record.contest_id
  )
  SELECT count(*)::integer,
    (count(*) FILTER (WHERE choice_payload ->> 'choice' = 'yes'))::integer,
    (count(*) FILTER (WHERE choice_payload ->> 'choice' = 'no'))::integer,
    (count(*) FILTER (WHERE choice_payload ->> 'choice' = 'abstain'))::integer,
    COALESCE(bool_and(
      storage_count = 1
      AND participation_snapshot_id = source_record.eligibility_snapshot_id
      AND participation_ballot_mode = source_record.contest_ballot_mode
      AND storage_mode = source_record.contest_ballot_mode
      AND effective_revision = current_revision
      AND row_version = aggregate_version
      AND revision = current_revision
      AND cast_tick < source_record.contest_closes_tick
      AND revision_choice_hash = stored_choice_hash
      AND stored_choice_hash = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(
          CASE WHEN storage_mode = 'secret' THEN jsonb_build_object(
            'domain','worldgraph.governance.secret-ballot-choice-hash.v1',
            'value',jsonb_build_object(
              'choicePayload',choice_payload,'choiceRevisionId',ballot_key::text
            )
          ) ELSE choice_payload END
        ),'UTF8'
      ),'sha256')
      AND choice_payload = jsonb_build_object('choice',choice_payload ->> 'choice')
      AND choice_payload ->> 'choice' IN ('yes','no','abstain')
    ),true),
    COALESCE(jsonb_agg(jsonb_build_object(
      'ballotKey',ballot_key::text,'choice',choice_payload ->> 'choice'
    ) ORDER BY (ballot_key::text) COLLATE "C"),'[]'::jsonb)
    INTO actual_participating_count,actual_yes_count,actual_no_count,
      actual_abstain_count,storage_is_valid,ballots_document
  FROM stored_ballots;

  decisive_count := actual_yes_count + actual_no_count;
  actual_quorum_required := (
    (source_record.snapshot_eligible_count::bigint
      * source_record.quorum_numerator::bigint + 9999) / 10000
  )::integer;
  actual_approval_required := (
    (decisive_count::bigint * source_record.threshold_numerator::bigint + 9999)
      / 10000
  )::integer;
  checked_quorum_met := actual_participating_count::bigint * 10000
    >= source_record.snapshot_eligible_count::bigint
      * source_record.quorum_numerator::bigint;
  checked_threshold_met := decisive_count > 0
    AND actual_yes_count::bigint * 10000
      >= decisive_count::bigint * source_record.threshold_numerator::bigint;
  tally_outcome := CASE
    WHEN NOT checked_quorum_met THEN 'rejected_quorum'
    WHEN checked_threshold_met THEN 'passed'
    ELSE 'rejected_threshold'
  END;
  expected_input_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance.proposal-tally-input.v1',
      'value',jsonb_build_object(
        'algorithmVersion','proposal_yes_no_v1',
        'approvalThresholdBps',source_record.threshold_numerator,
        'ballots',ballots_document,
        'eligibleCount',source_record.snapshot_eligible_count,
        'quorumBps',source_record.quorum_numerator
      )
    )),'UTF8'
  ),'sha256');
  expected_output_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance.proposal-tally-result.v1',
      'value',jsonb_build_object(
        'abstainCount',actual_abstain_count,
        'algorithmVersion','proposal_yes_no_v1',
        'approvalThresholdBps',source_record.threshold_numerator,
        'eligibleCount',source_record.snapshot_eligible_count,
        'inputChecksum',encode(expected_input_checksum,'hex'),
        'noCount',actual_no_count,'outcome',tally_outcome,
        'quorumBps',source_record.quorum_numerator,
        'quorumSatisfied',checked_quorum_met,
        'thresholdSatisfied',checked_threshold_met,
        'turnoutCount',actual_participating_count,
        'yesCount',actual_yes_count
      )
    )),'UTF8'
  ),'sha256');
  IF NOT storage_is_valid OR actual_effective_count <> actual_participating_count
    OR actual_eligible_count <> source_record.snapshot_eligible_count
    OR actual_participating_count > source_record.snapshot_eligible_count
    OR expected_output_checksum IS DISTINCT FROM checked_expected_replacement_checksum
    OR actual_quorum_required NOT BETWEEN 0 AND source_record.snapshot_eligible_count
    OR actual_approval_required NOT BETWEEN 0 AND actual_participating_count THEN
    RAISE EXCEPTION 'proposal recount does not match frozen aggregate evidence'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.proposal_tallies (
    id,world_id,contest_id,proposal_id,eligibility_snapshot_id,tally_version,
    algorithm_version,eligible_count,participating_count,quorum_required,
    approval_required,input_checksum,output_checksum,recount_of_tally_id,tallied_tick
  ) VALUES (
    checked_replacement_tally_id,checked_world_id,source_record.contest_id,
    source_record.proposal_id,source_record.eligibility_snapshot_id,
    source_record.source_tally_version + 1,'proposal_yes_no_v1',
    source_record.snapshot_eligible_count,actual_participating_count,
    actual_quorum_required,actual_approval_required,expected_input_checksum,
    expected_output_checksum,source_record.source_tally_id,checked_recount_tick
  );
  INSERT INTO public.proposal_tally_counts (
    id,world_id,tally_id,choice_code,ballot_count,weighted_count
  ) VALUES
    (checked_yes_count_id,checked_world_id,checked_replacement_tally_id,'yes',
      actual_yes_count,actual_yes_count::bigint),
    (checked_no_count_id,checked_world_id,checked_replacement_tally_id,'no',
      actual_no_count,actual_no_count::bigint),
    (checked_abstain_count_id,checked_world_id,checked_replacement_tally_id,'abstain',
      actual_abstain_count,actual_abstain_count::bigint);
  INSERT INTO public.proposal_results (
    id,world_id,contest_id,proposal_id,tally_id,outcome,quorum_met,threshold_met,
    result_schema_version,result_checksum,certified_command_id,certified_event_id,
    certified_state_revision,certified_tick,repair_of_result_id
  ) VALUES (
    checked_replacement_result_id,checked_world_id,source_record.contest_id,
    source_record.proposal_id,checked_replacement_tally_id,tally_outcome,
    checked_quorum_met,checked_threshold_met,1,expected_output_checksum,
    checked_command_id,checked_event_id,checked_state_revision,checked_recount_tick,
    checked_source_result_id
  );
  RETURN QUERY SELECT checked_replacement_result_id,checked_replacement_tally_id,
    expected_input_checksum,expected_output_checksum,tally_outcome,
    checked_quorum_met,checked_threshold_met;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_recount_proposal_result_v1(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,uuid,uuid,bigint,bigint
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_recount_election_result_v1(
  checked_world_id uuid,
  checked_source_result_id uuid,
  checked_replacement_result_id uuid,
  checked_replacement_tally_id uuid,
  checked_candidate_count_ids jsonb,
  checked_abstain_count_id uuid,
  checked_expected_source_checksum bytea,
  checked_expected_replacement_checksum bytea,
  checked_command_id uuid,
  checked_event_id uuid,
  checked_state_revision bigint,
  checked_recount_tick bigint
)
RETURNS TABLE (
  result_id uuid,
  tally_id uuid,
  input_checksum bytea,
  result_checksum bytea,
  outcome text,
  winning_candidacy_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  command_record record;
  source_record record;
  ballots_document jsonb;
  candidate_keys_document jsonb;
  candidate_totals_document jsonb;
  tied_candidate_keys_document jsonb := '[]'::jsonb;
  expected_input_checksum bytea;
  expected_output_checksum bytea;
  actual_effective_count integer;
  actual_eligible_count integer;
  actual_participating_count integer;
  actual_abstain_count integer;
  accepted_candidate_count integer;
  non_abstain_count integer;
  maximum_votes integer;
  checked_quorum_met boolean;
  tally_outcome text;
  winner_candidate_key text;
  checked_winning_candidacy_id uuid;
  storage_is_valid boolean;
  candidate_identities_are_valid boolean;
BEGIN
  IF checked_world_id IS NULL OR checked_source_result_id IS NULL
    OR checked_replacement_result_id IS NULL OR checked_replacement_tally_id IS NULL
    OR checked_candidate_count_ids IS NULL OR checked_abstain_count_id IS NULL
    OR checked_command_id IS NULL OR checked_event_id IS NULL
    OR checked_state_revision < 1 OR checked_recount_tick < 0
    OR octet_length(checked_expected_source_checksum) IS DISTINCT FROM 32
    OR octet_length(checked_expected_replacement_checksum) IS DISTINCT FROM 32
    OR jsonb_typeof(checked_candidate_count_ids) IS DISTINCT FROM 'array'
    OR jsonb_array_length(checked_candidate_count_ids) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'election recount identities or checksums are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(checked_candidate_count_ids) entry
    WHERE jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR entry IS DISTINCT FROM jsonb_build_object(
        'candidacyId',entry ->> 'candidacyId','countId',entry ->> 'countId'
      )
      OR NOT COALESCE(
        entry ->> 'candidacyId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND entry ->> 'countId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        false
      )
  ) THEN
    RAISE EXCEPTION 'election recount candidate identities are malformed'
      USING ERRCODE = '22023';
  END IF;
  IF (
    SELECT count(DISTINCT identity)
    FROM (
      SELECT unnest(ARRAY[
        checked_source_result_id,checked_replacement_result_id,
        checked_replacement_tally_id,checked_abstain_count_id
      ]) AS identity
      UNION ALL
      SELECT (entry ->> 'countId')::uuid
      FROM jsonb_array_elements(checked_candidate_count_ids) entry
    ) identities
  ) <> jsonb_array_length(checked_candidate_count_ids) + 4 THEN
    RAISE EXCEPTION 'election recount identities must be unique'
      USING ERRCODE = '22023';
  END IF;
  IF checked_command_id::text IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')
    OR NOT public.worldgraph_command_write_is_open(
      checked_world_id,checked_command_id
    ) THEN
    RAISE EXCEPTION 'election recount requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type,command.actor_type::text AS actor_type,
    command.payload,command.expected_tick,runtime.state_revision
    INTO command_record
  FROM public.command_records command
  JOIN public.world_runtime_heads runtime ON runtime.world_id = command.world_id
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  IF NOT FOUND OR command_record.command_type IS DISTINCT FROM 'RepairGovernanceResultV1'
    OR command_record.actor_type NOT IN ('user','platform_admin')
    OR command_record.expected_tick IS DISTINCT FROM checked_recount_tick
    OR command_record.state_revision + 1 IS DISTINCT FROM checked_state_revision
    OR command_record.payload IS DISTINCT FROM jsonb_build_object(
      'approvalId',command_record.payload -> 'approvalId',
      'confirmation','APPEND LINKED GOVERNANCE REPAIR',
      'expectedCurrentResultChecksum',encode(checked_expected_source_checksum,'hex'),
      'reason',command_record.payload -> 'reason',
      'repairKind','election_recount',
      'replacementResultChecksum',encode(checked_expected_replacement_checksum,'hex'),
      'sourceResultId',checked_source_result_id::text
    ) OR NOT EXISTS (
      SELECT 1 FROM public.world_simulation_clocks clock
      WHERE clock.world_id = checked_world_id
        AND clock.current_tick = checked_recount_tick
    ) THEN
    RAISE EXCEPTION 'election recount command identity is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT result.contest_id,result.election_id,result.tally_id AS source_tally_id,
    result.result_checksum AS source_result_checksum,
    tally.tally_version AS source_tally_version,
    tally.algorithm_version AS source_algorithm_version,
    tally.eligibility_snapshot_id,
    tally.eligible_count AS source_eligible_count,
    tally.input_checksum AS source_input_checksum,
    tally.output_checksum AS source_output_checksum,
    contest.status AS contest_status,contest.ballot_mode AS contest_ballot_mode,
    contest.closes_tick AS contest_closes_tick,
    election.status AS election_status,
    election.ballot_mode AS election_ballot_mode,
    election.quorum_numerator,election.tie_rule,
    snapshot.eligible_count AS snapshot_eligible_count
    INTO source_record
  FROM public.election_results result
  JOIN public.election_tallies tally
    ON tally.world_id = result.world_id AND tally.id = result.tally_id
   AND tally.contest_id = result.contest_id AND tally.election_id = result.election_id
  JOIN public.election_contests contest_link
    ON contest_link.world_id = result.world_id
   AND contest_link.contest_id = result.contest_id
   AND contest_link.election_id = result.election_id
  JOIN public.governance_contests contest
    ON contest.world_id = contest_link.world_id AND contest.id = contest_link.contest_id
   AND contest.contest_kind = 'election'
  JOIN public.elections election
    ON election.world_id = result.world_id AND election.id = result.election_id
  JOIN public.eligibility_snapshots snapshot
    ON snapshot.world_id = tally.world_id AND snapshot.id = tally.eligibility_snapshot_id
   AND snapshot.contest_id = tally.contest_id
  WHERE result.world_id = checked_world_id
    AND result.id = checked_source_result_id
  FOR UPDATE OF result;
  IF NOT FOUND
    OR source_record.source_result_checksum
      IS DISTINCT FROM checked_expected_source_checksum
    OR source_record.source_output_checksum
      IS DISTINCT FROM source_record.source_result_checksum
    OR source_record.source_algorithm_version
      IS DISTINCT FROM 'election_plurality_v1'
    OR source_record.source_tally_version NOT BETWEEN 1 AND 999
    OR source_record.source_eligible_count
      IS DISTINCT FROM source_record.snapshot_eligible_count
    OR source_record.contest_status IS DISTINCT FROM 'certified'
    OR source_record.election_status IS DISTINCT FROM 'certified'
    OR source_record.contest_ballot_mode
      IS DISTINCT FROM source_record.election_ballot_mode
    OR checked_recount_tick < source_record.contest_closes_tick
    OR EXISTS (
      SELECT 1 FROM public.election_results replacement
      WHERE replacement.world_id = checked_world_id
        AND replacement.repair_of_result_id = checked_source_result_id
    ) OR EXISTS (
      SELECT 1 FROM public.election_tallies newer_tally
      WHERE newer_tally.world_id = checked_world_id
        AND newer_tally.contest_id = source_record.contest_id
        AND newer_tally.tally_version > source_record.source_tally_version
    ) THEN
    RAISE EXCEPTION 'election recount source is stale or inconsistent'
      USING ERRCODE = '55000';
  END IF;

  WITH supplied AS (
    SELECT ordinality::integer AS candidate_ordinal,
      (entry ->> 'candidacyId')::uuid AS candidacy_id
    FROM jsonb_array_elements(checked_candidate_count_ids)
      WITH ORDINALITY supplied_entry(entry,ordinality)
  ), accepted AS (
    SELECT candidacy.id AS candidacy_id,
      row_number() OVER (
        ORDER BY entity.logical_key::text COLLATE "C",candidacy.id
      )::integer AS candidate_ordinal
    FROM public.candidacies candidacy
    JOIN public.world_entities entity
      ON entity.world_id = candidacy.world_id
     AND entity.id = candidacy.candidate_entity_id
    WHERE candidacy.world_id = checked_world_id
      AND candidacy.election_id = source_record.election_id
      AND candidacy.contest_id = source_record.contest_id
      AND candidacy.status = 'accepted'
  )
  SELECT count(accepted.candidacy_id)::integer,
    count(accepted.candidacy_id) = jsonb_array_length(checked_candidate_count_ids)
    AND count(supplied.candidacy_id) = count(accepted.candidacy_id)
    AND COALESCE(bool_and(
      supplied.candidacy_id IS NOT DISTINCT FROM accepted.candidacy_id
    ),false)
    INTO accepted_candidate_count,candidate_identities_are_valid
  FROM accepted
  FULL JOIN supplied USING (candidate_ordinal);
  IF NOT candidate_identities_are_valid
    OR accepted_candidate_count NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'election recount candidate set changed'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::integer INTO actual_eligible_count
  FROM public.eligibility_snapshot_members member
  WHERE member.world_id = checked_world_id
    AND member.snapshot_id = source_record.eligibility_snapshot_id
    AND member.contest_id = source_record.contest_id
    AND member.voting_weight = 1;
  SELECT count(*)::integer INTO actual_effective_count
  FROM public.ballot_effective_revisions effective
  WHERE effective.world_id = checked_world_id
    AND effective.contest_id = source_record.contest_id;
  WITH stored_ballots AS (
    SELECT revision.id AS ballot_key,revision.revision,
      revision.cast_tick,revision.storage_mode,
      revision.choice_hash AS revision_choice_hash,
      COALESCE(public_choice.choice_payload,secret_choice.choice_payload)
        AS choice_payload,
      COALESCE(public_choice.choice_hash,secret_choice.choice_hash)
        AS stored_choice_hash,
      ((public_choice.choice_revision_id IS NOT NULL)::integer
        + (secret_choice.choice_revision_id IS NOT NULL)::integer) AS storage_count,
      participation.ballot_mode AS participation_ballot_mode,
      participation.current_revision,participation.aggregate_version,
      participation.eligibility_snapshot_id AS participation_snapshot_id,
      effective.effective_revision,effective.row_version
    FROM public.ballot_effective_revisions effective
    JOIN public.ballot_participation participation
      ON participation.world_id = effective.world_id
     AND participation.id = effective.participation_id
     AND participation.contest_id = effective.contest_id
    JOIN public.eligibility_snapshot_members member
      ON member.world_id = participation.world_id
     AND member.snapshot_id = participation.eligibility_snapshot_id
     AND member.contest_id = participation.contest_id
     AND member.voter_entity_id = participation.voter_entity_id
     AND member.voting_weight = 1
    JOIN public.ballot_choice_revisions revision
      ON revision.world_id = effective.world_id
     AND revision.id = effective.choice_revision_id
     AND revision.contest_id = effective.contest_id
     AND revision.participation_id = effective.participation_id
    LEFT JOIN public.public_ballot_choices public_choice
      ON public_choice.world_id = revision.world_id
     AND public_choice.choice_revision_id = revision.id
     AND public_choice.contest_id = revision.contest_id
     AND public_choice.participation_id = revision.participation_id
     AND public_choice.voter_entity_id = participation.voter_entity_id
    LEFT JOIN public.secret_ballot_choices secret_choice
      ON secret_choice.world_id = revision.world_id
     AND secret_choice.choice_revision_id = revision.id
     AND secret_choice.contest_id = revision.contest_id
     AND secret_choice.participation_id = revision.participation_id
    WHERE effective.world_id = checked_world_id
      AND effective.contest_id = source_record.contest_id
  )
  SELECT count(*)::integer,
    (count(*) FILTER (WHERE choice_payload ->> 'choiceType' = 'abstain'))::integer,
    COALESCE(bool_and(
      storage_count = 1
      AND participation_snapshot_id = source_record.eligibility_snapshot_id
      AND participation_ballot_mode = source_record.contest_ballot_mode
      AND storage_mode = source_record.contest_ballot_mode
      AND effective_revision = current_revision
      AND row_version = aggregate_version
      AND revision = current_revision
      AND cast_tick < source_record.contest_closes_tick
      AND revision_choice_hash = stored_choice_hash
      AND stored_choice_hash = extensions.digest(convert_to(
        public.worldgraph_canonical_jsonb(
          CASE WHEN storage_mode = 'secret' THEN jsonb_build_object(
            'domain','worldgraph.governance.secret-ballot-choice-hash.v1',
            'value',jsonb_build_object(
              'choicePayload',choice_payload,'choiceRevisionId',ballot_key::text
            )
          ) ELSE choice_payload END
        ),'UTF8'
      ),'sha256')
      AND (
        choice_payload = jsonb_build_object('choiceType','abstain')
        OR choice_payload = jsonb_build_object(
          'candidateKey',choice_payload ->> 'candidateKey','choiceType','candidate'
        )
      )
      AND choice_payload ->> 'choiceType' IN ('candidate','abstain')
    ),true),
    COALESCE(jsonb_agg(jsonb_build_object(
      'ballotKey',ballot_key::text,
      'candidateKey',CASE WHEN choice_payload ->> 'choiceType' = 'candidate'
        THEN choice_payload ->> 'candidateKey' ELSE NULL END
    ) ORDER BY (ballot_key::text) COLLATE "C"),'[]'::jsonb)
    INTO actual_participating_count,actual_abstain_count,
      storage_is_valid,ballots_document
  FROM stored_ballots;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(ballots_document) ballot
    WHERE ballot ->> 'candidateKey' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.candidacies candidacy
        JOIN public.world_entities entity
          ON entity.world_id = candidacy.world_id
         AND entity.id = candidacy.candidate_entity_id
        WHERE candidacy.world_id = checked_world_id
          AND candidacy.election_id = source_record.election_id
          AND candidacy.contest_id = source_record.contest_id
          AND candidacy.status = 'accepted'
          AND entity.logical_key::text = ballot ->> 'candidateKey'
      )
  ) THEN
    storage_is_valid := false;
  END IF;
  WITH accepted_candidates AS (
    SELECT candidacy.id AS candidacy_id,entity.logical_key::text AS candidate_key
    FROM public.candidacies candidacy
    JOIN public.world_entities entity
      ON entity.world_id = candidacy.world_id
     AND entity.id = candidacy.candidate_entity_id
    WHERE candidacy.world_id = checked_world_id
      AND candidacy.election_id = source_record.election_id
      AND candidacy.contest_id = source_record.contest_id
      AND candidacy.status = 'accepted'
  ), candidate_totals AS (
    SELECT candidate.candidacy_id,candidate.candidate_key,
      (
        SELECT count(*)::integer
        FROM jsonb_array_elements(ballots_document) ballot
        WHERE ballot ->> 'candidateKey' = candidate.candidate_key
      ) AS vote_count
    FROM accepted_candidates candidate
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(candidate_key)
      ORDER BY candidate_key COLLATE "C"),'[]'::jsonb),
    COALESCE(jsonb_agg(jsonb_build_object(
      'candidateKey',candidate_key,'voteCount',vote_count
    ) ORDER BY candidate_key COLLATE "C"),'[]'::jsonb)
    INTO candidate_keys_document,candidate_totals_document
  FROM candidate_totals;

  non_abstain_count := actual_participating_count - actual_abstain_count;
  checked_quorum_met := actual_participating_count::bigint * 10000
    >= source_record.snapshot_eligible_count::bigint
      * source_record.quorum_numerator::bigint;
  IF checked_quorum_met AND non_abstain_count > 0 THEN
    SELECT max((candidate_total ->> 'voteCount')::integer)
      INTO maximum_votes
    FROM jsonb_array_elements(candidate_totals_document) candidate_total;
    SELECT COALESCE(jsonb_agg(to_jsonb(candidate_total ->> 'candidateKey')
      ORDER BY (candidate_total ->> 'candidateKey') COLLATE "C"),'[]'::jsonb)
      INTO tied_candidate_keys_document
    FROM jsonb_array_elements(candidate_totals_document) candidate_total
    WHERE (candidate_total ->> 'voteCount')::integer = maximum_votes;
  END IF;
  IF NOT checked_quorum_met THEN
    tally_outcome := 'vacant_no_quorum';
  ELSIF non_abstain_count = 0 THEN
    tally_outcome := 'vacant_no_votes';
  ELSIF jsonb_array_length(tied_candidate_keys_document) > 1
    AND source_record.tie_rule = 'vacancy' THEN
    tally_outcome := 'vacant_tie';
  ELSE
    tally_outcome := 'elected';
    winner_candidate_key := tied_candidate_keys_document ->> 0;
    SELECT candidacy.id INTO checked_winning_candidacy_id
    FROM public.candidacies candidacy
    JOIN public.world_entities entity
      ON entity.world_id = candidacy.world_id
     AND entity.id = candidacy.candidate_entity_id
    WHERE candidacy.world_id = checked_world_id
      AND candidacy.election_id = source_record.election_id
      AND candidacy.contest_id = source_record.contest_id
      AND candidacy.status = 'accepted'
      AND entity.logical_key::text = winner_candidate_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'election recount winner identity is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  expected_input_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance.election-tally-input.v1',
      'value',jsonb_build_object(
        'algorithmVersion','election_plurality_v1','ballots',ballots_document,
        'candidateKeys',candidate_keys_document,
        'eligibleCount',source_record.snapshot_eligible_count,
        'quorumBps',source_record.quorum_numerator,
        'tieRule',source_record.tie_rule
      )
    )),'UTF8'
  ),'sha256');
  expected_output_checksum := extensions.digest(convert_to(
    public.worldgraph_canonical_jsonb(jsonb_build_object(
      'domain','worldgraph.governance.election-tally-result.v1',
      'value',jsonb_build_object(
        'abstainCount',actual_abstain_count,
        'algorithmVersion','election_plurality_v1',
        'candidateTotals',candidate_totals_document,
        'eligibleCount',source_record.snapshot_eligible_count,
        'inputChecksum',encode(expected_input_checksum,'hex'),
        'outcome',tally_outcome,'quorumBps',source_record.quorum_numerator,
        'quorumSatisfied',checked_quorum_met,'tieRule',source_record.tie_rule,
        'tiedCandidateKeys',tied_candidate_keys_document,
        'turnoutCount',actual_participating_count,
        'winnerCandidateKey',winner_candidate_key
      )
    )),'UTF8'
  ),'sha256');
  IF NOT storage_is_valid OR actual_effective_count <> actual_participating_count
    OR actual_eligible_count <> source_record.snapshot_eligible_count
    OR actual_participating_count > source_record.snapshot_eligible_count
    OR expected_output_checksum IS DISTINCT FROM checked_expected_replacement_checksum
    OR actual_abstain_count NOT BETWEEN 0 AND actual_participating_count THEN
    RAISE EXCEPTION 'election recount does not match frozen aggregate evidence'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.election_tallies (
    id,world_id,contest_id,election_id,eligibility_snapshot_id,tally_version,
    algorithm_version,eligible_count,participating_count,input_checksum,
    output_checksum,recount_of_tally_id,tallied_tick
  ) VALUES (
    checked_replacement_tally_id,checked_world_id,source_record.contest_id,
    source_record.election_id,source_record.eligibility_snapshot_id,
    source_record.source_tally_version + 1,'election_plurality_v1',
    source_record.snapshot_eligible_count,actual_participating_count,
    expected_input_checksum,expected_output_checksum,source_record.source_tally_id,
    checked_recount_tick
  );
  WITH supplied AS (
    SELECT (entry ->> 'candidacyId')::uuid AS candidacy_id,
      (entry ->> 'countId')::uuid AS count_id
    FROM jsonb_array_elements(checked_candidate_count_ids) entry
  )
  INSERT INTO public.election_tally_counts (
    id,world_id,tally_id,candidacy_id,count_kind,ballot_count,weighted_count
  )
  SELECT supplied.count_id,checked_world_id,checked_replacement_tally_id,
    candidacy.id,'candidate',
    (
      SELECT count(*)::integer FROM jsonb_array_elements(ballots_document) ballot
      WHERE ballot ->> 'candidateKey' = entity.logical_key::text
    ),
    (
      SELECT count(*)::bigint FROM jsonb_array_elements(ballots_document) ballot
      WHERE ballot ->> 'candidateKey' = entity.logical_key::text
    )
  FROM supplied
  JOIN public.candidacies candidacy
    ON candidacy.world_id = checked_world_id
   AND candidacy.id = supplied.candidacy_id
   AND candidacy.election_id = source_record.election_id
   AND candidacy.contest_id = source_record.contest_id
   AND candidacy.status = 'accepted'
  JOIN public.world_entities entity
    ON entity.world_id = candidacy.world_id
   AND entity.id = candidacy.candidate_entity_id;
  INSERT INTO public.election_tally_counts (
    id,world_id,tally_id,candidacy_id,count_kind,ballot_count,weighted_count
  ) VALUES (
    checked_abstain_count_id,checked_world_id,checked_replacement_tally_id,NULL,
    'abstain',actual_abstain_count,actual_abstain_count::bigint
  );
  INSERT INTO public.election_results (
    id,world_id,contest_id,election_id,tally_id,outcome,winning_candidacy_id,
    result_schema_version,result_checksum,certified_command_id,certified_event_id,
    certified_state_revision,certified_tick,repair_of_result_id
  ) VALUES (
    checked_replacement_result_id,checked_world_id,source_record.contest_id,
    source_record.election_id,checked_replacement_tally_id,tally_outcome,
    checked_winning_candidacy_id,1,expected_output_checksum,checked_command_id,
    checked_event_id,checked_state_revision,checked_recount_tick,
    checked_source_result_id
  );
  RETURN QUERY SELECT checked_replacement_result_id,checked_replacement_tally_id,
    expected_input_checksum,expected_output_checksum,tally_outcome,
    checked_winning_candidacy_id;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_recount_election_result_v1(
  uuid,uuid,uuid,uuid,jsonb,uuid,bytea,bytea,uuid,uuid,bigint,bigint
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_proposal_tally_for_certification_v1(
  checked_world_id uuid,
  checked_proposal_id uuid,
  checked_expected_output_checksum bytea,
  checked_command_id uuid
)
RETURNS TABLE (
  tally_id uuid,
  proposal_id uuid,
  algorithm_version text,
  input_checksum bytea,
  output_checksum bytea,
  outcome text,
  quorum_met boolean,
  threshold_met boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_record record;
  tally_record public.proposal_tallies%ROWTYPE;
  yes_count bigint;
BEGIN
  IF checked_world_id IS NULL OR checked_proposal_id IS NULL
    OR checked_command_id IS NULL
    OR octet_length(checked_expected_output_checksum) IS DISTINCT FROM 32
    OR checked_command_id::text IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')
    OR NOT public.worldgraph_command_write_is_open(
      checked_world_id,checked_command_id
    ) THEN
    RAISE EXCEPTION 'proposal tally certification read requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type,command.actor_type::text AS actor_type,command.payload,
    command.expected_tick
    INTO command_record
  FROM public.command_records command
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  IF NOT FOUND
    OR command_record.command_type IS DISTINCT FROM 'CertifyAndEnactProposalV1'
    OR command_record.actor_type IS DISTINCT FROM 'system'
    OR NOT EXISTS (
      SELECT 1 FROM public.world_simulation_clocks clock
      WHERE clock.world_id = checked_world_id
        AND clock.current_tick = command_record.expected_tick
    )
    OR command_record.payload ->> 'proposalId' IS DISTINCT FROM checked_proposal_id::text
    OR command_record.payload ->> 'expectedResultChecksum'
      IS DISTINCT FROM encode(checked_expected_output_checksum,'hex') THEN
    RAISE EXCEPTION 'proposal tally certification command identity is invalid'
      USING ERRCODE = '55000';
  END IF;
  SELECT tally.* INTO tally_record
  FROM public.proposal_tallies tally
  JOIN public.proposals proposal
    ON proposal.world_id = tally.world_id AND proposal.id = tally.proposal_id
  WHERE tally.world_id = checked_world_id
    AND tally.proposal_id = checked_proposal_id
    AND tally.output_checksum = checked_expected_output_checksum
    AND proposal.status = 'tallied'
  ORDER BY tally.tally_version DESC
  LIMIT 1
  FOR UPDATE OF tally;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count.weighted_count INTO yes_count
  FROM public.proposal_tally_counts count
  WHERE count.world_id = checked_world_id
    AND count.tally_id = tally_record.id
    AND count.choice_code = 'yes';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT tally_record.id,tally_record.proposal_id,
    tally_record.algorithm_version,tally_record.input_checksum,
    tally_record.output_checksum,
    CASE WHEN tally_record.participating_count < tally_record.quorum_required
      THEN 'rejected_quorum'
      WHEN yes_count < tally_record.approval_required THEN 'rejected_threshold'
      ELSE 'passed' END,
    tally_record.participating_count >= tally_record.quorum_required,
    yes_count >= tally_record.approval_required;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_proposal_tally_for_certification_v1(
  uuid,uuid,bytea,uuid
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_election_tally_for_certification_v1(
  checked_world_id uuid,
  checked_election_id uuid,
  checked_expected_output_checksum bytea,
  checked_command_id uuid
)
RETURNS TABLE (
  tally_id uuid,
  election_id uuid,
  algorithm_version text,
  input_checksum bytea,
  output_checksum bytea,
  eligible_count integer,
  participating_count integer,
  abstain_count integer,
  candidacy_id uuid,
  candidate_key text,
  ballot_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_record record;
  tally_record public.election_tallies%ROWTYPE;
  checked_abstain_count integer;
BEGIN
  IF checked_world_id IS NULL OR checked_election_id IS NULL
    OR checked_command_id IS NULL
    OR octet_length(checked_expected_output_checksum) IS DISTINCT FROM 32
    OR checked_command_id::text IS DISTINCT FROM
      NULLIF(current_setting('worldgraph.command_id',true),'')
    OR NOT public.worldgraph_command_write_is_open(
      checked_world_id,checked_command_id
    ) THEN
    RAISE EXCEPTION 'election tally certification read requires its exact open command'
      USING ERRCODE = '55000';
  END IF;
  SELECT command.command_type,command.actor_type::text AS actor_type,command.payload,
    command.expected_tick
    INTO command_record
  FROM public.command_records command
  WHERE command.id = checked_command_id AND command.world_id = checked_world_id;
  IF NOT FOUND OR command_record.command_type IS DISTINCT FROM 'CertifyElectionV1'
    OR command_record.actor_type IS DISTINCT FROM 'system'
    OR NOT EXISTS (
      SELECT 1 FROM public.world_simulation_clocks clock
      WHERE clock.world_id = checked_world_id
        AND clock.current_tick = command_record.expected_tick
    )
    OR command_record.payload ->> 'electionId' IS DISTINCT FROM checked_election_id::text
    OR command_record.payload ->> 'expectedResultChecksum'
      IS DISTINCT FROM encode(checked_expected_output_checksum,'hex') THEN
    RAISE EXCEPTION 'election tally certification command identity is invalid'
      USING ERRCODE = '55000';
  END IF;
  SELECT tally.* INTO tally_record
  FROM public.election_tallies tally
  JOIN public.elections election
    ON election.world_id = tally.world_id AND election.id = tally.election_id
  WHERE tally.world_id = checked_world_id
    AND tally.election_id = checked_election_id
    AND tally.output_checksum = checked_expected_output_checksum
    AND election.status = 'tallied'
  ORDER BY tally.tally_version DESC
  LIMIT 1
  FOR UPDATE OF tally;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count.ballot_count INTO checked_abstain_count
  FROM public.election_tally_counts count
  WHERE count.world_id = checked_world_id
    AND count.tally_id = tally_record.id
    AND count.count_kind = 'abstain';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT tally_record.id,tally_record.election_id,tally_record.algorithm_version,
    tally_record.input_checksum,tally_record.output_checksum,
    tally_record.eligible_count,tally_record.participating_count,
    checked_abstain_count,count.candidacy_id,entity.logical_key::text,
    count.ballot_count
  FROM public.election_tally_counts count
  JOIN public.candidacies candidacy
    ON candidacy.world_id = count.world_id AND candidacy.id = count.candidacy_id
  JOIN public.world_entities entity
    ON entity.world_id = candidacy.world_id AND entity.id = candidacy.candidate_entity_id
  WHERE count.world_id = checked_world_id
    AND count.tally_id = tally_record.id
    AND count.count_kind = 'candidate'
  ORDER BY count.ballot_count DESC,entity.logical_key::text COLLATE "C";
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_election_tally_for_certification_v1(
  uuid,uuid,bytea,uuid
) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.scheduled_actions
  DROP CONSTRAINT scheduled_actions_registry_known,
  DROP CONSTRAINT scheduled_actions_payload_safe,
  ADD CONSTRAINT scheduled_actions_registry_known CHECK (
    action_schema_version = 1 AND process_version = '1.0.0'
    AND action_type IN (
      'EmitWorldNoticeV1','CompleteProductionRunV1','SettlePayrollV1',
      'ExpireMarketListingV1','AssessPeriodicTaxV1','OpenProposalVotingV1',
      'CloseAndTallyProposalV1','CertifyAndEnactProposalV1','OpenElectionV1',
      'CloseAndTallyElectionV1','CertifyElectionV1'
    )
  ),
  ADD CONSTRAINT scheduled_actions_payload_safe CHECK (
    jsonb_typeof(payload) = 'object'
    AND pg_column_size(payload) <= 4096
    AND NOT public.worldgraph_jsonb_has_sensitive_key(payload)
    AND NOT public.worldgraph_jsonb_has_compiler_private_key(payload)
    AND CASE action_type
      WHEN 'EmitWorldNoticeV1' THEN
        payload = jsonb_build_object(
          'text',payload ->> 'text','visibility',payload ->> 'visibility'
        )
        AND char_length(payload ->> 'text') BETWEEN 1 AND 500
        AND translate(payload ->> 'text',E'\t\n\r','') !~ '[[:cntrl:]]'
        AND payload ->> 'visibility' IN ('public','member','creator')
      WHEN 'CompleteProductionRunV1' THEN
        payload = jsonb_build_object('productionRunId',payload ->> 'productionRunId')
        AND payload ->> 'productionRunId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'SettlePayrollV1' THEN
        payload = jsonb_build_object('payrollRecordId',payload ->> 'payrollRecordId')
        AND payload ->> 'payrollRecordId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'ExpireMarketListingV1' THEN
        payload = jsonb_build_object('listingId',payload ->> 'listingId')
        AND payload ->> 'listingId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'AssessPeriodicTaxV1' THEN
        payload = jsonb_build_object('taxPolicyId',payload ->> 'taxPolicyId')
        AND payload ->> 'taxPolicyId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'OpenProposalVotingV1' THEN
        payload = jsonb_build_object('proposalId',payload ->> 'proposalId')
        AND payload ->> 'proposalId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'CloseAndTallyProposalV1' THEN
        payload = jsonb_build_object('proposalId',payload ->> 'proposalId')
        AND payload ->> 'proposalId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'CertifyAndEnactProposalV1' THEN
        payload = jsonb_build_object('proposalId',payload ->> 'proposalId')
        AND payload ->> 'proposalId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'OpenElectionV1' THEN
        payload = jsonb_build_object('electionId',payload ->> 'electionId')
        AND payload ->> 'electionId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'CloseAndTallyElectionV1' THEN
        payload = jsonb_build_object('electionId',payload ->> 'electionId')
        AND payload ->> 'electionId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'CertifyElectionV1' THEN
        payload = jsonb_build_object('electionId',payload ->> 'electionId')
        AND payload ->> 'electionId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ELSE false
    END
  );
--> statement-breakpoint
ALTER TABLE public.simulation_batch_runs
  DROP CONSTRAINT simulation_batch_runs_registry_known,
  ADD CONSTRAINT simulation_batch_runs_registry_known CHECK (
    process_registry_version IN (1,2,3)
  );
--> statement-breakpoint
ALTER TABLE public.simulation_failures
  DROP CONSTRAINT simulation_failures_process_known,
  ADD CONSTRAINT simulation_failures_process_known CHECK (
    (process_type IN (
      'EmitWorldNoticeV1','CompleteProductionRunV1','SettlePayrollV1',
      'ExpireMarketListingV1','AssessPeriodicTaxV1','OpenProposalVotingV1',
      'CloseAndTallyProposalV1','CertifyAndEnactProposalV1','OpenElectionV1',
      'CloseAndTallyElectionV1','CertifyElectionV1'
    ) AND process_version = '1.0.0' AND schedule_id IS NOT NULL)
    OR (
      process_type = 'WorldClockV1' AND process_version = '1.0.0'
      AND schedule_id IS NULL AND error_code = 'SIMULATION_INTEGER_OVERFLOW'
    )
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_schedule_pair_is_valid_v2(
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
  WHEN 'OpenProposalVotingV1' THEN checked_command_type = 'CreateProposalV1'
  WHEN 'CloseAndTallyProposalV1' THEN checked_command_type IN (
    'CreateProposalV1','OpenProposalVotingV1'
  )
  WHEN 'CertifyAndEnactProposalV1' THEN
    checked_command_type IN ('CreateProposalV1','CloseAndTallyProposalV1')
  WHEN 'OpenElectionV1' THEN checked_command_type IN (
    'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1',
    'CertifyElectionV1','OpenElectionV1'
  )
  WHEN 'CloseAndTallyElectionV1' THEN checked_command_type IN (
    'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1',
    'OpenElectionV1','CertifyElectionV1'
  )
  WHEN 'CertifyElectionV1' THEN checked_command_type IN (
    'InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1',
    'CloseAndTallyElectionV1','OpenElectionV1','CertifyElectionV1'
  )
  ELSE false
END;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_schedule_pair_is_valid_v2(text,text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_allocate_schedule_sequence(
  checked_world_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  allocated_sequence bigint;
  open_command_type text;
BEGIN
  SELECT command.command_type INTO open_command_type
  FROM public.command_records command
  WHERE command.id = NULLIF(current_setting('worldgraph.command_id', true), '')::uuid
    AND command.world_id = checked_world_id;
  IF NOT public.worldgraph_command_write_is_open(checked_world_id)
    OR open_command_type NOT IN (
      'ScheduleWorldNoticeV1','AdvanceSimulationV1','InitializeWorldCommerceV1',
      'StartProductionRunV1','PerformJobV1','CreateMarketListingV1',
      'AssessPeriodicTaxV1','InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1',
      'CreateProposalV1',
      'OpenProposalVotingV1','CloseAndTallyProposalV1','OpenElectionV1',
      'CloseAndTallyElectionV1','CertifyElectionV1'
    ) THEN
    RAISE EXCEPTION 'schedule allocation requires its exact open registered command'
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
  PERFORM set_config('worldgraph.schedule_world_id',checked_world_id::text,true);
  PERFORM set_config('worldgraph.schedule_sequence',allocated_sequence::text,true);
  RETURN allocated_sequence;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_protect_schedule_head()
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
    WHERE command.id = NULLIF(current_setting('worldgraph.command_id',true),'')::uuid
      AND command.world_id = NEW.world_id;
    IF NOT public.worldgraph_command_write_is_open(NEW.world_id)
      OR open_command_type NOT IN (
        'ScheduleWorldNoticeV1','AdvanceSimulationV1','InitializeWorldCommerceV1',
        'StartProductionRunV1','PerformJobV1','CreateMarketListingV1',
        'AssessPeriodicTaxV1','InitializeWorldGovernanceV1','AdoptGovernanceSeedPlanV1',
        'CreateProposalV1',
        'OpenProposalVotingV1','CloseAndTallyProposalV1','OpenElectionV1',
        'CloseAndTallyElectionV1','CertifyElectionV1'
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
DO $registry_function$
DECLARE
  function_definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.worldgraph_assert_simulation_batch_command()'::regprocedure
  ) INTO function_definition;
  updated_definition := replace(
    function_definition,'IN (1, 2)','IN (1, 2, 3)'
  );
  IF updated_definition = function_definition THEN
    RAISE EXCEPTION 'simulation batch authority function lacks the sealed registry-2 clause'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE updated_definition;
END
$registry_function$;
--> statement-breakpoint
CREATE FUNCTION public.worldgraph_governance_seed_plan_v1_is_valid(
  checked_plan jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  charter jsonb;
  proposal_rules jsonb;
  ballot_policy jsonb;
  item jsonb;
  nested_item jsonb;
  delegation_item jsonb;
  delegation_key text;
  previous_delegation_key text;
BEGIN
  IF NOT public.worldgraph_governance_json_is_safe_v1(checked_plan,1048576)
    OR NOT public.worldgraph_jsonb_has_exact_keys(checked_plan,ARRAY[
      'charter','governanceSeedPlanSchemaVersion','initialLaws','institutions','offices'
    ])
    OR checked_plan ->> 'governanceSeedPlanSchemaVersion' <> '1'
    OR jsonb_typeof(checked_plan -> 'charter') <> 'object'
    OR jsonb_typeof(checked_plan -> 'initialLaws') <> 'array'
    OR jsonb_typeof(checked_plan -> 'institutions') <> 'array'
    OR jsonb_typeof(checked_plan -> 'offices') <> 'array'
    OR jsonb_array_length(checked_plan -> 'initialLaws') > 128
    OR jsonb_array_length(checked_plan -> 'institutions') NOT BETWEEN 1 AND 64
    OR jsonb_array_length(checked_plan -> 'offices') NOT BETWEEN 1 AND 64 THEN
    RETURN false;
  END IF;
  charter := checked_plan -> 'charter';
  IF NOT public.worldgraph_jsonb_has_exact_keys(charter,ARRAY[
      'citizenEligibilityPolicy','effectiveFromTick','effectiveUntilTick',
      'proposalRules','stableKey','summary','title'
    ])
    OR jsonb_typeof(charter -> 'citizenEligibilityPolicy') <> 'object'
    OR NOT public.worldgraph_governance_policy_v1_is_valid(
      charter -> 'citizenEligibilityPolicy'
    )
    OR charter ->> 'effectiveFromTick' !~ '^(?:0|[1-9][0-9]{0,18})$'
    OR NOT (
      charter -> 'effectiveUntilTick' = 'null'::jsonb
      OR charter ->> 'effectiveUntilTick' ~ '^(?:0|[1-9][0-9]{0,18})$'
    )
    OR NOT public.worldgraph_governance_key_is_valid_v1(charter ->> 'stableKey')
    OR char_length(charter ->> 'summary') NOT BETWEEN 1 AND 1000
    OR char_length(charter ->> 'title') NOT BETWEEN 1 AND 160
    OR jsonb_typeof(charter -> 'proposalRules') <> 'object' THEN
    RETURN false;
  END IF;
  proposal_rules := charter -> 'proposalRules';
  IF NOT public.worldgraph_jsonb_has_exact_keys(proposal_rules,ARRAY[
      'approvalThresholdBps','ballotPolicy','debateTicks','minimumSponsors',
      'quorumBps','sponsorshipTicks','votingTicks'
    ])
    OR proposal_rules ->> 'approvalThresholdBps' !~ '^[1-9][0-9]{0,4}$'
    OR (proposal_rules ->> 'approvalThresholdBps')::numeric > 10000
    OR proposal_rules ->> 'quorumBps' !~ '^(?:0|[1-9][0-9]{0,4})$'
    OR (proposal_rules ->> 'quorumBps')::numeric > 10000
    OR proposal_rules ->> 'minimumSponsors' !~ '^(?:0|[1-9][0-9]{0,4})$'
    OR (proposal_rules ->> 'minimumSponsors')::numeric > 10000
    OR proposal_rules ->> 'debateTicks' !~ '^[1-9][0-9]{0,18}$'
    OR proposal_rules ->> 'sponsorshipTicks' !~ '^[1-9][0-9]{0,18}$'
    OR proposal_rules ->> 'votingTicks' !~ '^[1-9][0-9]{0,18}$'
    OR jsonb_typeof(proposal_rules -> 'ballotPolicy') <> 'object' THEN
    RETURN false;
  END IF;
  ballot_policy := proposal_rules -> 'ballotPolicy';
  IF NOT public.worldgraph_jsonb_has_exact_keys(ballot_policy,ARRAY[
      'ballotMode','disclosure','replacementAllowed'
    ])
    OR ballot_policy ->> 'ballotMode' NOT IN ('public','secret')
    OR ballot_policy ->> 'disclosure' NOT IN (
      'aggregate_only','choice_totals','voter_and_choice'
    )
    OR (ballot_policy ->> 'ballotMode' = 'secret'
      AND ballot_policy ->> 'disclosure' <> 'aggregate_only')
    OR jsonb_typeof(ballot_policy -> 'replacementAllowed') <> 'boolean' THEN
    RETURN false;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(checked_plan -> 'institutions') LOOP
    IF jsonb_typeof(item) <> 'object'
      OR NOT public.worldgraph_jsonb_has_exact_keys(item,ARRAY[
        'displayName','institutionType','jurisdictionEntityKey','powers',
        'stableKey','worldEntityKey'
      ])
      OR char_length(item ->> 'displayName') NOT BETWEEN 1 AND 160
      OR item ->> 'institutionType' !~ '^[a-z][a-z0-9._-]{0,99}$'
      OR NOT public.worldgraph_governance_key_is_valid_v1(item ->> 'jurisdictionEntityKey')
      OR NOT public.worldgraph_governance_key_is_valid_v1(item ->> 'stableKey')
      OR NOT public.worldgraph_governance_key_is_valid_v1(item ->> 'worldEntityKey')
      OR jsonb_typeof(item -> 'powers') <> 'array'
      OR jsonb_array_length(item -> 'powers') > 64 THEN
      RETURN false;
    END IF;
    FOR nested_item IN SELECT value FROM jsonb_array_elements(item -> 'powers') LOOP
      IF jsonb_typeof(nested_item) <> 'object'
        OR NOT public.worldgraph_jsonb_has_exact_keys(nested_item,ARRAY[
          'action','policy','resourceType'
        ])
        OR nested_item ->> 'action' !~ '^[a-z][a-z0-9._-]{0,99}$'
        OR nested_item ->> 'resourceType' !~ '^[a-z][a-z0-9._-]{0,99}$'
        OR jsonb_typeof(nested_item -> 'policy') <> 'object'
        OR NOT public.worldgraph_governance_policy_v1_is_valid(
          nested_item -> 'policy'
        ) THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(checked_plan -> 'offices') LOOP
    IF jsonb_typeof(item) <> 'object'
      OR NOT public.worldgraph_jsonb_has_exact_keys(item,ARRAY[
        'ballotPolicy','displayName','electionCadenceTicks','eligibilityPolicy',
        'institutionKey','powers','seats','stableKey','termDurationTicks',
        'tieRule','transitionDelayTicks'
      ])
      OR char_length(item ->> 'displayName') NOT BETWEEN 1 AND 160
      OR item ->> 'electionCadenceTicks' !~ '^[1-9][0-9]{0,18}$'
      OR item ->> 'termDurationTicks' !~ '^[1-9][0-9]{0,18}$'
      OR item ->> 'transitionDelayTicks' !~ '^(?:0|[1-9][0-9]{0,18})$'
      OR item ->> 'seats' !~ '^[1-9][0-9]?$'
      OR (item ->> 'seats')::integer NOT BETWEEN 1 AND 64
      OR item ->> 'tieRule' NOT IN ('vacancy','stable_key')
      OR NOT public.worldgraph_governance_key_is_valid_v1(item ->> 'institutionKey')
      OR NOT public.worldgraph_governance_key_is_valid_v1(item ->> 'stableKey')
      OR jsonb_typeof(item -> 'ballotPolicy') <> 'object'
      OR NOT public.worldgraph_jsonb_has_exact_keys(item -> 'ballotPolicy',ARRAY[
        'ballotMode','disclosure','replacementAllowed'
      ])
      OR item -> 'ballotPolicy' ->> 'ballotMode' NOT IN ('public','secret')
      OR item -> 'ballotPolicy' ->> 'disclosure' NOT IN (
        'aggregate_only','choice_totals','voter_and_choice'
      )
      OR (item -> 'ballotPolicy' ->> 'ballotMode'='secret'
        AND item -> 'ballotPolicy' ->> 'disclosure'<>'aggregate_only')
      OR jsonb_typeof(item -> 'ballotPolicy' -> 'replacementAllowed')<>'boolean'
      OR jsonb_typeof(item -> 'eligibilityPolicy') <> 'object'
      OR NOT public.worldgraph_governance_policy_v1_is_valid(
        item -> 'eligibilityPolicy'
      )
      OR jsonb_typeof(item -> 'powers') <> 'array'
      OR jsonb_array_length(item -> 'powers') > 32 THEN
      RETURN false;
    END IF;
    FOR nested_item IN SELECT value FROM jsonb_array_elements(item -> 'powers') LOOP
      IF jsonb_typeof(nested_item) <> 'object'
        OR NOT public.worldgraph_jsonb_has_exact_keys(nested_item,ARRAY[
          'action','delegatedOrganizationEntityKeys','policy','resourceType'
        ])
        OR nested_item ->> 'action' !~ '^[a-z][a-z0-9._-]{0,99}$'
        OR nested_item ->> 'resourceType' !~ '^[a-z][a-z0-9._-]{0,99}$'
        OR jsonb_typeof(nested_item -> 'policy') <> 'object'
        OR NOT public.worldgraph_governance_policy_v1_is_valid(
          nested_item -> 'policy'
        )
        OR jsonb_typeof(nested_item -> 'delegatedOrganizationEntityKeys') <> 'array'
        OR jsonb_array_length(
          nested_item -> 'delegatedOrganizationEntityKeys'
        ) > 32 THEN
        RETURN false;
      END IF;
      previous_delegation_key := NULL;
      FOR delegation_item IN
        SELECT value FROM jsonb_array_elements(
          nested_item -> 'delegatedOrganizationEntityKeys'
        )
      LOOP
        IF jsonb_typeof(delegation_item) <> 'string' THEN RETURN false; END IF;
        delegation_key := delegation_item #>> '{}';
        IF NOT public.worldgraph_governance_key_is_valid_v1(delegation_key)
          OR (
            previous_delegation_key IS NOT NULL
            AND previous_delegation_key COLLATE "C" >= delegation_key COLLATE "C"
          ) THEN
          RETURN false;
        END IF;
        previous_delegation_key := delegation_key;
      END LOOP;
    END LOOP;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(checked_plan -> 'initialLaws') LOOP
    IF jsonb_typeof(item) <> 'object'
      OR NOT public.worldgraph_jsonb_has_exact_keys(item,ARRAY[
        'effectiveFromTick','effectiveUntilTick','jurisdictionEntityKey','policy',
        'stableKey','summary','title'
      ])
      OR item ->> 'effectiveFromTick' !~ '^(?:0|[1-9][0-9]{0,18})$'
      OR NOT (
        item -> 'effectiveUntilTick' = 'null'::jsonb
        OR item ->> 'effectiveUntilTick' ~ '^(?:0|[1-9][0-9]{0,18})$'
      )
      OR NOT public.worldgraph_governance_key_is_valid_v1(item ->> 'jurisdictionEntityKey')
      OR NOT public.worldgraph_governance_key_is_valid_v1(item ->> 'stableKey')
      OR jsonb_typeof(item -> 'policy') <> 'object'
      OR NOT public.worldgraph_governance_policy_v1_is_valid(item -> 'policy')
      OR char_length(item ->> 'summary') NOT BETWEEN 1 AND 1000
      OR char_length(item ->> 'title') NOT BETWEEN 1 AND 160 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN data_exception OR numeric_value_out_of_range THEN
  RETURN false;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.worldgraph_governance_seed_plan_v1_is_valid(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.compiled_governance_seed_plans
  ADD CONSTRAINT compiled_governance_seed_plans_document_valid CHECK (
    public.worldgraph_governance_seed_plan_v1_is_valid(canonical_plan)
  );
--> statement-breakpoint
ALTER TABLE public.compiled_world_artifacts
  ADD CONSTRAINT compiled_world_artifacts_governance_plan_valid CHECK (
    artifact_schema_version <> 4
    OR public.worldgraph_governance_seed_plan_v1_is_valid(
      canonical_content -> 'governanceSeedPlan'
    )
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_governance_command_is_secret_ballot_v1(
  checked_world_id uuid,
  checked_command_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN COALESCE((
  SELECT CASE command.command_type
    WHEN 'CastProposalBallotV1' THEN EXISTS (
      SELECT 1 FROM public.proposals proposal
      WHERE proposal.world_id = command.world_id
        AND proposal.id::text = command.payload ->> 'proposalId'
        AND proposal.ballot_mode = 'secret'
    )
    WHEN 'CastElectionBallotV1' THEN EXISTS (
      SELECT 1 FROM public.elections election
      WHERE election.world_id = command.world_id
        AND election.id::text = command.payload ->> 'electionId'
        AND election.ballot_mode = 'secret'
    )
    ELSE false
  END
  FROM public.command_records command
  WHERE command.world_id = checked_world_id AND command.id = checked_command_id
),false);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER treasury_encumbrance_facts_require_projection
  AFTER INSERT ON public.treasury_encumbrance_facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_treasury_encumbrance_projection_v1();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER treasury_encumbrance_projection_matches_facts
  AFTER INSERT OR UPDATE ON public.treasury_encumbrance_projections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_assert_treasury_encumbrance_projection_v1();
--> statement-breakpoint
SELECT public.worldgraph_apply_governance_grants_v1();
--> statement-breakpoint
DROP FUNCTION public.worldgraph_apply_governance_grants_v1();
--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;
