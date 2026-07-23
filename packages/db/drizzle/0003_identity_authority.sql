CREATE TYPE user_status AS ENUM ('active', 'disabled');
--> statement-breakpoint
CREATE TYPE platform_role AS ENUM ('user', 'platform_admin');
--> statement-breakpoint
CREATE TYPE world_lifecycle AS ENUM ('draft');
--> statement-breakpoint
CREATE TYPE world_role AS ENUM ('creator', 'administrator', 'player', 'observer');
--> statement-breakpoint
CREATE TYPE membership_status AS ENUM ('active', 'removed');
--> statement-breakpoint
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'revoked', 'expired');
--> statement-breakpoint
CREATE TYPE idempotency_state AS ENUM ('processing', 'completed');
--> statement-breakpoint
CREATE FUNCTION worldgraph_jsonb_has_sensitive_key(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  item_key text;
  item_value jsonb;
BEGIN
  IF value IS NULL THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(value) = 'object' THEN
    FOR item_key, item_value IN SELECT key, val FROM jsonb_each(value) AS entry(key, val)
    LOOP
      IF lower(item_key) = ANY (
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
      ) OR worldgraph_jsonb_has_sensitive_key(item_value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR item_value IN SELECT element FROM jsonb_array_elements(value) AS entry(element)
    LOOP
      IF worldgraph_jsonb_has_sensitive_key(item_value) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;

  RETURN false;
END
$function$;
--> statement-breakpoint
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email extensions.citext NOT NULL,
  password_hash text NOT NULL,
  display_name text,
  status user_status NOT NULL DEFAULT 'active',
  platform_role platform_role NOT NULL DEFAULT 'user',
  auth_version integer NOT NULL DEFAULT 1,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_shape CHECK (
    char_length(email::text) BETWEEN 3 AND 320
    AND email::text = btrim(email::text)
    AND email::text = lower(email::text)
    AND email::text !~ '[[:cntrl:]]'
  ),
  CONSTRAINT users_password_hash_bounded CHECK (char_length(password_hash) BETWEEN 20 AND 1024),
  CONSTRAINT users_display_name_bounded CHECK (
    display_name IS NULL
    OR (
      char_length(btrim(display_name)) BETWEEN 1 AND 80
      AND display_name = btrim(display_name)
      AND display_name !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT users_versions_positive CHECK (auth_version > 0 AND row_version > 0),
  CONSTRAINT users_timestamps_ordered CHECK (
    updated_at >= created_at
    AND (last_login_at IS NULL OR last_login_at >= created_at)
  )
);
--> statement-breakpoint
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL,
  csrf_hash bytea NOT NULL,
  auth_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  ip_prefix_hash bytea,
  user_agent_hash bytea,
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_hash_lengths CHECK (
    octet_length(token_hash) = 32
    AND octet_length(csrf_hash) = 32
    AND (ip_prefix_hash IS NULL OR octet_length(ip_prefix_hash) = 32)
    AND (user_agent_hash IS NULL OR octet_length(user_agent_hash) = 32)
  ),
  CONSTRAINT sessions_auth_version_positive CHECK (auth_version > 0),
  CONSTRAINT sessions_expiry_ordered CHECK (
    last_seen_at >= created_at
    AND idle_expires_at > last_seen_at
    AND absolute_expires_at >= idle_expires_at
  ),
  CONSTRAINT sessions_revocation_consistent CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL)
    OR (
      revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL
      AND revoked_at >= created_at
      AND char_length(btrim(revoke_reason)) BETWEEN 1 AND 160
      AND revoke_reason = btrim(revoke_reason)
      AND revoke_reason !~ '[[:cntrl:]]'
    )
  )
);
--> statement-breakpoint
CREATE INDEX sessions_user_active_idx
  ON sessions (user_id, absolute_expires_at)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX sessions_cleanup_idx
  ON sessions (LEAST(idle_expires_at, absolute_expires_at), id);
--> statement-breakpoint
CREATE TABLE worlds (
  id uuid PRIMARY KEY,
  slug extensions.citext NOT NULL,
  name text NOT NULL,
  lifecycle world_lifecycle NOT NULL DEFAULT 'draft',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT worlds_slug_unique UNIQUE (slug),
  CONSTRAINT worlds_slug_shape CHECK (
    char_length(slug::text) BETWEEN 3 AND 63
    AND slug::text = lower(slug::text)
    AND slug::text ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
  ),
  CONSTRAINT worlds_name_bounded CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 120
    AND name = btrim(name)
    AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT worlds_row_version_positive CHECK (row_version > 0),
  CONSTRAINT worlds_timestamps_ordered CHECK (
    updated_at >= created_at
    AND (archived_at IS NULL OR archived_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX worlds_creator_idx ON worlds (created_by_user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX worlds_active_idx ON worlds (created_at DESC, id) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE TABLE world_memberships (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role world_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'active',
  row_version integer NOT NULL DEFAULT 1,
  joined_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  granted_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (world_id, user_id),
  CONSTRAINT world_memberships_row_version_positive CHECK (row_version > 0),
  CONSTRAINT world_memberships_status_consistent CHECK (
    (status = 'active' AND removed_at IS NULL)
    OR (status = 'removed' AND removed_at IS NOT NULL)
  ),
  CONSTRAINT world_memberships_timestamps_ordered CHECK (
    joined_at >= created_at
    AND updated_at >= created_at
    AND (removed_at IS NULL OR removed_at >= created_at)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX world_memberships_one_active_creator_idx
  ON world_memberships (world_id)
  WHERE role = 'creator' AND status = 'active';
--> statement-breakpoint
CREATE INDEX world_memberships_user_status_idx
  ON world_memberships (user_id, status, world_id);
--> statement-breakpoint
CREATE INDEX world_memberships_world_status_idx
  ON world_memberships (world_id, status, role, user_id);
--> statement-breakpoint
CREATE TABLE world_invitations (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  email extensions.citext NOT NULL,
  intended_role world_role NOT NULL,
  token_hash bytea NOT NULL,
  status invitation_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT world_invitations_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT world_invitations_email_shape CHECK (
    char_length(email::text) BETWEEN 3 AND 320
    AND email::text = btrim(email::text)
    AND email::text = lower(email::text)
    AND email::text !~ '[[:cntrl:]]'
  ),
  CONSTRAINT world_invitations_role_restricted CHECK (intended_role IN ('player', 'observer')),
  CONSTRAINT world_invitations_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT world_invitations_row_version_positive CHECK (row_version > 0),
  CONSTRAINT world_invitations_expiry_ordered CHECK (expires_at > created_at),
  CONSTRAINT world_invitations_status_consistent CHECK (
    (status = 'pending' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
    OR (
      status = 'accepted'
      AND accepted_by_user_id IS NOT NULL
      AND accepted_at IS NOT NULL
      AND accepted_at >= created_at
      AND accepted_at <= expires_at
      AND revoked_at IS NULL
    )
    OR (
      status = 'revoked'
      AND accepted_by_user_id IS NULL
      AND accepted_at IS NULL
      AND revoked_at IS NOT NULL
      AND revoked_at >= created_at
    )
    OR (status = 'expired' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX world_invitations_one_pending_email_idx
  ON world_invitations (world_id, email)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX world_invitations_world_status_idx
  ON world_invitations (world_id, status, created_at DESC, id);
--> statement-breakpoint
CREATE INDEX world_invitations_expiry_idx
  ON world_invitations (expires_at, id)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE idempotency_records (
  scope text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key text NOT NULL,
  request_hash bytea NOT NULL,
  response_status integer,
  response_body jsonb,
  state idempotency_state NOT NULL DEFAULT 'processing',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, actor_id, key),
  CONSTRAINT idempotency_records_scope_bounded CHECK (
    char_length(scope) BETWEEN 1 AND 160
    AND scope = btrim(scope)
    AND scope ~ '^[a-z0-9][a-z0-9._:/-]*$'
  ),
  CONSTRAINT idempotency_records_key_bounded CHECK (
    char_length(key) BETWEEN 8 AND 128
    AND key = btrim(key)
    AND key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT idempotency_records_request_hash_length CHECK (octet_length(request_hash) = 32),
  CONSTRAINT idempotency_records_response_bounded CHECK (
    response_body IS NULL OR pg_column_size(response_body) <= 65536
  ),
  CONSTRAINT idempotency_records_response_has_no_secret_keys CHECK (
    response_body IS NULL OR NOT worldgraph_jsonb_has_sensitive_key(response_body)
  ),
  CONSTRAINT idempotency_records_state_consistent CHECK (
    (state = 'processing' AND response_status IS NULL AND response_body IS NULL)
    OR (
      state = 'completed'
      AND response_status BETWEEN 100 AND 599
      AND response_body IS NOT NULL
    )
  ),
  CONSTRAINT idempotency_records_expiry_ordered CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX idempotency_records_cleanup_idx ON idempotency_records (expires_at, scope, actor_id, key);
--> statement-breakpoint
CREATE TABLE security_audit_records (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  world_id uuid REFERENCES worlds(id) ON DELETE RESTRICT,
  category text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  target_type text,
  target_id uuid,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  redacted_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_audit_records_category_bounded CHECK (
    char_length(category) BETWEEN 1 AND 80 AND category ~ '^[a-z][a-z0-9._-]*$'
  ),
  CONSTRAINT security_audit_records_action_bounded CHECK (
    char_length(action) BETWEEN 1 AND 160 AND action ~ '^[a-z][a-zA-Z0-9._:-]*$'
  ),
  CONSTRAINT security_audit_records_outcome_known CHECK (
    outcome IN ('allowed', 'denied', 'succeeded', 'failed')
  ),
  CONSTRAINT security_audit_records_reason_code_bounded CHECK (
    char_length(reason_code) BETWEEN 1 AND 120 AND reason_code ~ '^[A-Z][A-Z0-9_]*$'
  ),
  CONSTRAINT security_audit_records_target_consistent CHECK (
    (target_type IS NULL AND target_id IS NULL)
    OR (
      target_type IS NOT NULL
      AND target_id IS NOT NULL
      AND char_length(target_type) BETWEEN 1 AND 80
      AND target_type ~ '^[a-z][a-z0-9._-]*$'
    )
  ),
  CONSTRAINT security_audit_records_request_id_bounded CHECK (
    char_length(request_id) BETWEEN 1 AND 128 AND request_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT security_audit_records_correlation_id_bounded CHECK (
    char_length(correlation_id) BETWEEN 1 AND 128 AND correlation_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT security_audit_records_metadata_object CHECK (
    jsonb_typeof(redacted_metadata) = 'object'
    AND pg_column_size(redacted_metadata) <= 16384
    AND NOT worldgraph_jsonb_has_sensitive_key(redacted_metadata)
  ),
  CONSTRAINT security_audit_records_actor_world_link_unique UNIQUE (id, world_id, actor_user_id)
);
--> statement-breakpoint
CREATE INDEX security_audit_records_world_cursor_idx
  ON security_audit_records (world_id, occurred_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX security_audit_records_actor_cursor_idx
  ON security_audit_records (actor_user_id, occurred_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX security_audit_records_category_cursor_idx
  ON security_audit_records (category, occurred_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE creator_override_records (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  reason text NOT NULL,
  authority_rule_id text NOT NULL,
  command_id uuid NOT NULL,
  audit_record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_override_records_command_unique UNIQUE (command_id),
  CONSTRAINT creator_override_records_audit_unique UNIQUE (audit_record_id),
  CONSTRAINT creator_override_records_audit_link
    FOREIGN KEY (audit_record_id, world_id, actor_user_id)
    REFERENCES security_audit_records(id, world_id, actor_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT creator_override_records_action_bounded CHECK (
    char_length(action) BETWEEN 1 AND 160 AND action ~ '^[a-z][a-zA-Z0-9._:-]*$'
  ),
  CONSTRAINT creator_override_records_target_type_bounded CHECK (
    char_length(target_type) BETWEEN 1 AND 80 AND target_type ~ '^[a-z][a-z0-9._-]*$'
  ),
  CONSTRAINT creator_override_records_reason_bounded CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 500
    AND reason = btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT creator_override_records_rule_bounded CHECK (
    char_length(authority_rule_id) BETWEEN 1 AND 160
    AND authority_rule_id ~ '^[a-z][a-zA-Z0-9._:-]*$'
  )
);
--> statement-breakpoint
CREATE INDEX creator_override_records_world_cursor_idx
  ON creator_override_records (world_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE FUNCTION worldgraph_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;
--> statement-breakpoint
CREATE TRIGGER security_audit_records_append_only
  BEFORE UPDATE OR DELETE ON security_audit_records
  FOR EACH ROW EXECUTE FUNCTION worldgraph_reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER creator_override_records_append_only
  BEFORE UPDATE OR DELETE ON creator_override_records
  FOR EACH ROW EXECUTE FUNCTION worldgraph_reject_append_only_mutation();
--> statement-breakpoint
CREATE FUNCTION worldgraph_preserve_world_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'world creator provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER worlds_preserve_provenance
  BEFORE UPDATE ON worlds
  FOR EACH ROW EXECUTE FUNCTION worldgraph_preserve_world_provenance();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_active_world_creator(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  active_creator_count integer;
BEGIN
  PERFORM 1
  FROM worlds
  WHERE id = checked_world_id AND archived_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    SELECT count(*)::integer
    INTO active_creator_count
    FROM world_memberships
    WHERE world_id = checked_world_id
      AND role = 'creator'
      AND status = 'active';

    IF active_creator_count <> 1 THEN
      RAISE EXCEPTION 'unarchived world % must have exactly one active creator', checked_world_id
        USING ERRCODE = '23514',
              CONSTRAINT = 'worlds_exactly_one_active_creator';
    END IF;
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_active_world_creator()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  checked_world_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'worlds' THEN
    checked_world_id := COALESCE(NEW.id, OLD.id);
  ELSE
    checked_world_id := COALESCE(NEW.world_id, OLD.world_id);
  END IF;

  PERFORM worldgraph_assert_active_world_creator(checked_world_id);

  IF TG_TABLE_NAME = 'world_memberships' THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.world_id IS DISTINCT FROM NEW.world_id THEN
        PERFORM worldgraph_assert_active_world_creator(OLD.world_id);
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER worlds_require_active_creator
  AFTER INSERT OR UPDATE OF archived_at ON worlds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_active_world_creator();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_memberships_require_active_creator
  AFTER INSERT OR UPDATE OR DELETE ON world_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_active_world_creator();
--> statement-breakpoint
UPDATE platform_metadata
SET value = jsonb_set(
      jsonb_set(value, '{contracts}', '2'::jsonb, true),
      '{runtimeSchema}',
      '2'::jsonb,
      true
    ),
    value_schema_version = 2,
    updated_at = now()
WHERE key = 'runtime_versions';
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT USAGE ON SCHEMA public, extensions TO worldgraph_app;
    GRANT USAGE ON TYPE user_status, platform_role, world_lifecycle, world_role,
      membership_status, invitation_status, idempotency_state TO worldgraph_app;
    GRANT SELECT ON users TO worldgraph_app;
    GRANT INSERT (id, email, password_hash, display_name) ON users TO worldgraph_app;
    GRANT UPDATE (last_login_at) ON users TO worldgraph_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO worldgraph_app;
    GRANT SELECT, INSERT, UPDATE ON worlds TO worldgraph_app;
    GRANT SELECT, INSERT, UPDATE ON world_memberships TO worldgraph_app;
    GRANT SELECT, INSERT, UPDATE ON world_invitations TO worldgraph_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_records TO worldgraph_app;
    GRANT SELECT, INSERT ON security_audit_records, creator_override_records TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION worldgraph_jsonb_has_sensitive_key(jsonb),
      worldgraph_reject_append_only_mutation(),
      worldgraph_preserve_world_provenance(),
      worldgraph_assert_active_world_creator(uuid),
      worldgraph_enforce_active_world_creator() TO worldgraph_app;
  END IF;
END
$grant$;
