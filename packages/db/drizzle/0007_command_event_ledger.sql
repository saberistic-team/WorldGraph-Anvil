CREATE TYPE command_actor_type AS ENUM ('user', 'system', 'ai', 'platform_admin');
--> statement-breakpoint
CREATE TYPE command_record_status AS ENUM ('received', 'accepted', 'rejected', 'failed');
--> statement-breakpoint
CREATE TYPE payload_classification AS ENUM ('public', 'member', 'private', 'secret');
--> statement-breakpoint
CREATE TYPE ledger_entry_kind AS ENUM (
  'command_accepted', 'command_rejected', 'domain_event', 'override', 'repair_anchor'
);
--> statement-breakpoint
CREATE TYPE projection_checkpoint_status AS ENUM ('current', 'rebuilding', 'diverged', 'failed');
--> statement-breakpoint
CREATE TYPE outbox_message_status AS ENUM ('pending', 'published', 'dead');
--> statement-breakpoint
CREATE TYPE history_visibility AS ENUM ('public', 'member', 'creator', 'operator');
--> statement-breakpoint
CREATE TYPE projection_replay_status AS ENUM (
  'pending', 'running', 'succeeded', 'failed', 'cancelled'
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_canonical_jsonb(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(
        to_jsonb(normalize(item_key, NFC))::text || ':' ||
          public.worldgraph_canonical_jsonb(item_value),
        ',' ORDER BY normalize(item_key, NFC) COLLATE "C"
      ), '') || '}'
      INTO result
      FROM jsonb_each(value) AS item(item_key, item_value);
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(
        public.worldgraph_canonical_jsonb(item_value),
        ',' ORDER BY item_ordinal
      ), '') || ']'
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS item(item_value, item_ordinal);
    WHEN 'string' THEN
      result := to_jsonb(normalize(value #>> '{}', NFC))::text;
    ELSE
      result := value::text;
  END CASE;
  RETURN result;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_timestamp_text(value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
RETURN to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
--> statement-breakpoint
CREATE FUNCTION worldgraph_domain_event_hash_v1(
  event_id uuid,
  event_world_id uuid,
  event_world_sequence bigint,
  event_command_id uuid,
  event_ordinal_value integer,
  event_aggregate_type text,
  event_aggregate_id text,
  event_aggregate_version bigint,
  event_type_value text,
  event_schema_version_value integer,
  event_payload jsonb,
  event_metadata jsonb,
  event_occurred_at timestamptz,
  event_recorded_at timestamptz,
  event_resulting_state_revision bigint
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, extensions
RETURN extensions.digest(
  convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
    'aggregateId', event_aggregate_id,
    'aggregateType', event_aggregate_type,
    'aggregateVersion', event_aggregate_version::text,
    'commandId', event_command_id::text,
    'domain', 'worldgraph.domain-event.v1',
    'eventId', event_id::text,
    'eventOrdinal', event_ordinal_value,
    'eventSchemaVersion', event_schema_version_value,
    'eventType', event_type_value,
    'metadata', event_metadata,
    'occurredAt', public.worldgraph_timestamp_text(event_occurred_at),
    'payload', event_payload,
    'recordedAt', public.worldgraph_timestamp_text(event_recorded_at),
    'resultingStateRevision', event_resulting_state_revision::text,
    'worldEventSequence', event_world_sequence::text,
    'worldId', event_world_id::text
  )), 'UTF8'),
  'sha256'
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_ledger_entry_hash_v1(
  ledger_entry_id uuid,
  ledger_world_id uuid,
  ledger_sequence_value bigint,
  ledger_kind text,
  ledger_command_id uuid,
  ledger_event_id uuid,
  ledger_actor_type text,
  ledger_actor_id text,
  ledger_public_summary_code text,
  ledger_redacted_details jsonb,
  ledger_previous_hash bytea,
  ledger_recorded_at timestamptz
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, extensions
RETURN extensions.digest(
  convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
    'actorId', ledger_actor_id,
    'actorType', ledger_actor_type,
    'commandId', CASE WHEN ledger_command_id IS NULL THEN NULL ELSE ledger_command_id::text END,
    'domain', 'worldgraph.ledger-entry.v1',
    'entryId', ledger_entry_id::text,
    'entryKind', ledger_kind,
    'eventId', CASE WHEN ledger_event_id IS NULL THEN NULL ELSE ledger_event_id::text END,
    'ledgerSchemaVersion', 1,
    'ledgerSequence', ledger_sequence_value::text,
    'previousHash', encode(ledger_previous_hash, 'hex'),
    'publicSummaryCode', ledger_public_summary_code,
    'recordedAt', public.worldgraph_timestamp_text(ledger_recorded_at),
    'redactedDetails', ledger_redacted_details,
    'worldId', ledger_world_id::text
  )), 'UTF8'),
  'sha256'
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_projection_document(
  checked_world_id uuid,
  state_revision_override bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN jsonb_build_object(
  'activeWorldVersionId', (
    SELECT active_world_version_id::text FROM public.world_runtime_heads
    WHERE world_id = checked_world_id
  ),
  'controllers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'controlScope', controller.control_scope,
      'entityLogicalKey', character.logical_key::text,
      'principalKey', account.state ->> 'principalKey'
    ) ORDER BY character.logical_key::text COLLATE "C",
      (account.state ->> 'principalKey') COLLATE "C")
    FROM public.world_entity_controllers controller
    JOIN public.world_entities character
      ON character.world_id = controller.world_id AND character.id = controller.entity_id
    JOIN public.world_relationships control_edge
      ON control_edge.world_id = controller.world_id
      AND control_edge.target_entity_id = controller.entity_id
      AND control_edge.relationship_type = 'account_controls'
      AND control_edge.retired_world_version_id IS NULL
    JOIN public.world_entities account
      ON account.world_id = control_edge.world_id AND account.id = control_edge.source_entity_id
    WHERE controller.world_id = checked_world_id AND controller.revoked_at IS NULL
  ), '[]'::jsonb),
  'domain', 'worldgraph.projection.v1',
  'entities', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'entitySchemaVersion', entity_schema_version,
      'entityType', entity_type,
      'entityVersion', (row_version + 1)::text,
      'logicalKey', logical_key::text,
      'state', state
    ) ORDER BY logical_key::text COLLATE "C", id)
    FROM public.world_entities
    WHERE world_id = checked_world_id AND retired_world_version_id IS NULL
  ), '[]'::jsonb),
  'relationships', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'attributes', relationship.attributes,
      'logicalKey', relationship.logical_key::text,
      'relationshipSchemaVersion', relationship.relationship_schema_version,
      'relationshipType', relationship.relationship_type,
      'sourceLogicalKey', source.logical_key::text,
      'targetLogicalKey', target.logical_key::text
    ) ORDER BY relationship.logical_key::text COLLATE "C", relationship.id)
    FROM public.world_relationships relationship
    JOIN public.world_entities source
      ON source.world_id = relationship.world_id AND source.id = relationship.source_entity_id
    JOIN public.world_entities target
      ON target.world_id = relationship.world_id AND target.id = relationship.target_entity_id
    WHERE relationship.world_id = checked_world_id
      AND relationship.retired_world_version_id IS NULL
  ), '[]'::jsonb),
  'projectionSchemaVersion', 1,
  'stateRevision', COALESCE(state_revision_override, (
    SELECT state_revision FROM public.world_runtime_heads WHERE world_id = checked_world_id
  ))::text,
  'worldId', checked_world_id::text,
  'worldVersionNumber', (
    SELECT version.version_number::text
    FROM public.world_runtime_heads runtime
    JOIN public.world_versions version
      ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
    WHERE runtime.world_id = checked_world_id
  )
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_projection_checksum(
  checked_world_id uuid,
  state_revision_override bigint DEFAULT NULL
)
RETURNS bytea
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
RETURN extensions.digest(
  convert_to(public.worldgraph_canonical_jsonb(
    public.worldgraph_projection_document(checked_world_id, state_revision_override)
  ), 'UTF8'),
  'sha256'
);
--> statement-breakpoint
ALTER TABLE world_runtime_heads
  ADD COLUMN last_event_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN ledger_anchored_at timestamptz,
  ADD COLUMN ledger_anchor_event_id uuid,
  ADD COLUMN anchor_artifact_hash bytea,
  ADD COLUMN ledger_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN event_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN projection_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN projection_checksum bytea;
--> statement-breakpoint
ALTER TABLE world_runtime_heads
  ADD CONSTRAINT world_runtime_heads_ledger_fields_valid CHECK (
    last_event_sequence >= 0
    AND ledger_schema_version = 1
    AND event_schema_version = 1
    AND projection_schema_version = 1
    AND (projection_checksum IS NULL OR octet_length(projection_checksum) = 32)
    AND (anchor_artifact_hash IS NULL OR octet_length(anchor_artifact_hash) = 32)
    AND (
      (ledger_anchored_at IS NULL AND ledger_anchor_event_id IS NULL
        AND anchor_artifact_hash IS NULL AND projection_checksum IS NULL
        AND last_event_sequence = 0 AND last_ledger_sequence = 0)
      OR
      (ledger_anchored_at IS NOT NULL AND ledger_anchor_event_id IS NOT NULL
        AND anchor_artifact_hash IS NOT NULL AND projection_checksum IS NOT NULL
        AND last_event_sequence > 0 AND last_ledger_sequence > 0)
    )
  );
--> statement-breakpoint
CREATE TABLE command_records (
  id uuid PRIMARY KEY,
  world_id uuid REFERENCES worlds(id) ON DELETE RESTRICT,
  command_type text NOT NULL,
  command_schema_version integer NOT NULL,
  actor_type command_actor_type NOT NULL,
  actor_id text NOT NULL,
  payload jsonb,
  payload_hash bytea NOT NULL,
  payload_classification payload_classification NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  expected_world_version bigint,
  expected_state_revision bigint,
  opened_state_revision bigint,
  opened_ledger_sequence bigint,
  opened_event_sequence bigint,
  opened_projection_checksum bytea,
  write_gate_opened_at timestamptz,
  status command_record_status NOT NULL DEFAULT 'received',
  rejection_code text,
  authorization_rule_id text,
  override_id uuid REFERENCES creator_override_records(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  resulting_state_revision bigint,
  response_summary jsonb,
  CONSTRAINT command_records_world_identity UNIQUE (id, world_id),
  CONSTRAINT command_records_type_shape CHECK (
    char_length(command_type) BETWEEN 3 AND 120
    AND command_type ~ '^[A-Z][A-Za-z0-9]*V[1-9][0-9]*$'
  ),
  CONSTRAINT command_records_schema_storable CHECK (
    command_schema_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT command_records_actor_id_bounded CHECK (
    char_length(actor_id) BETWEEN 1 AND 160
    AND actor_id = btrim(actor_id) AND actor_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT command_records_payload_safe CHECK (
    payload IS NULL OR (
      jsonb_typeof(payload) = 'object'
      AND pg_column_size(payload) <= 262144
      AND NOT worldgraph_jsonb_has_sensitive_key(payload)
    )
  ),
  CONSTRAINT command_records_hash_lengths CHECK (
    octet_length(payload_hash) = 32 AND octet_length(request_hash) = 32
  ),
  CONSTRAINT command_records_idempotency_bounded CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 128
    AND idempotency_key = btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT command_records_expected_versions_valid CHECK (
    (expected_world_version IS NULL OR expected_world_version > 0)
    AND (expected_state_revision IS NULL OR expected_state_revision >= 0)
  ),
  CONSTRAINT command_records_write_gate_snapshot_valid CHECK (
    (
      write_gate_opened_at IS NULL
      AND opened_state_revision IS NULL
      AND opened_ledger_sequence IS NULL
      AND opened_event_sequence IS NULL
      AND opened_projection_checksum IS NULL
    )
    OR
    (
      write_gate_opened_at IS NOT NULL
      AND opened_state_revision >= 0
      AND opened_ledger_sequence >= 0
      AND opened_event_sequence >= 0
      AND (
        opened_projection_checksum IS NULL
        OR octet_length(opened_projection_checksum) = 32
      )
    )
  ),
  CONSTRAINT command_records_code_shapes CHECK (
    (rejection_code IS NULL OR (
      char_length(rejection_code) BETWEEN 3 AND 120
      AND rejection_code ~ '^[A-Z][A-Z0-9_]*$'
    ))
    AND (authorization_rule_id IS NULL OR (
      char_length(authorization_rule_id) BETWEEN 3 AND 160
      AND authorization_rule_id ~ '^[a-z][a-z0-9._:-]*$'
    ))
  ),
  CONSTRAINT command_records_response_safe CHECK (
    response_summary IS NULL OR (
      jsonb_typeof(response_summary) = 'object'
      AND pg_column_size(response_summary) <= 65536
      AND NOT worldgraph_jsonb_has_sensitive_key(response_summary)
    )
  ),
  CONSTRAINT command_records_terminal_shape CHECK (
    (status = 'received' AND decided_at IS NULL AND rejection_code IS NULL
      AND authorization_rule_id IS NULL AND override_id IS NULL
      AND resulting_state_revision IS NULL AND response_summary IS NULL)
    OR
    (status = 'accepted' AND decided_at IS NOT NULL AND rejection_code IS NULL
      AND authorization_rule_id IS NOT NULL AND resulting_state_revision IS NOT NULL
      AND resulting_state_revision >= 0 AND response_summary IS NOT NULL)
    OR
    (status IN ('rejected', 'failed') AND decided_at IS NOT NULL
      AND rejection_code IS NOT NULL AND resulting_state_revision IS NULL
      AND response_summary IS NOT NULL)
  ),
  CONSTRAINT command_records_timestamps_ordered CHECK (
    decided_at IS NULL OR decided_at >= requested_at
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX command_records_idempotency_unique
  ON command_records (world_id, actor_type, actor_id, command_type, idempotency_key)
  NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX command_records_world_status_cursor_idx
  ON command_records (world_id, status, requested_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX command_records_actor_cursor_idx
  ON command_records (actor_type, actor_id, requested_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE world_ledger_heads (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  next_ledger_sequence bigint NOT NULL DEFAULT 1,
  next_event_sequence bigint NOT NULL DEFAULT 1,
  last_entry_hash bytea,
  ledger_schema_version integer NOT NULL DEFAULT 1,
  anchored_at timestamptz,
  anchor_event_id uuid,
  anchor_artifact_hash bytea,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_ledger_heads_sequences_positive CHECK (
    next_ledger_sequence > 0 AND next_event_sequence > 0
  ),
  CONSTRAINT world_ledger_heads_schema_known CHECK (ledger_schema_version = 1),
  CONSTRAINT world_ledger_heads_anchor_shape CHECK (
    (anchored_at IS NULL AND anchor_event_id IS NULL AND anchor_artifact_hash IS NULL)
    OR
    (anchored_at IS NOT NULL AND anchor_event_id IS NOT NULL
      AND octet_length(anchor_artifact_hash) = 32
      AND octet_length(last_entry_hash) = 32
      AND next_ledger_sequence > 1 AND next_event_sequence > 1)
  )
);
--> statement-breakpoint
CREATE TABLE aggregate_stream_heads (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  current_version bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, aggregate_type, aggregate_id),
  CONSTRAINT aggregate_stream_heads_type_shape CHECK (
    char_length(aggregate_type) BETWEEN 1 AND 80
    AND aggregate_type ~ '^[a-z][a-z0-9._-]*$'
  ),
  CONSTRAINT aggregate_stream_heads_id_bounded CHECK (
    char_length(aggregate_id) BETWEEN 1 AND 240
    AND aggregate_id = btrim(aggregate_id) AND aggregate_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT aggregate_stream_heads_version_positive CHECK (current_version > 0)
);
--> statement-breakpoint
CREATE TABLE domain_events (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  world_event_sequence bigint NOT NULL,
  command_id uuid NOT NULL,
  event_ordinal integer NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version bigint NOT NULL,
  event_type text NOT NULL,
  event_schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  metadata jsonb NOT NULL,
  event_hash bytea NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  resulting_state_revision bigint NOT NULL,
  CONSTRAINT domain_events_world_identity UNIQUE (world_id, id),
  CONSTRAINT domain_events_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT domain_events_world_sequence_unique UNIQUE (world_id, world_event_sequence),
  CONSTRAINT domain_events_command_ordinal_unique UNIQUE (command_id, event_ordinal),
  CONSTRAINT domain_events_aggregate_version_unique
    UNIQUE (world_id, aggregate_type, aggregate_id, aggregate_version),
  CONSTRAINT domain_events_sequences_positive CHECK (
    world_event_sequence > 0 AND event_ordinal >= 0
    AND aggregate_version > 0 AND resulting_state_revision >= 0
  ),
  CONSTRAINT domain_events_names_valid CHECK (
    char_length(aggregate_type) BETWEEN 1 AND 80
    AND aggregate_type ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(aggregate_id) BETWEEN 1 AND 240
    AND aggregate_id = btrim(aggregate_id) AND aggregate_id !~ '[[:cntrl:]]'
    AND char_length(event_type) BETWEEN 3 AND 120
    AND event_type ~ '^[A-Z][A-Za-z0-9]*V[1-9][0-9]*$'
  ),
  CONSTRAINT domain_events_schema_known CHECK (event_schema_version = 1),
  CONSTRAINT domain_events_payload_safe CHECK (
    jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 262144
    AND NOT worldgraph_jsonb_has_sensitive_key(payload)
  ),
  CONSTRAINT domain_events_metadata_safe CHECK (
    jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 32768
    AND NOT worldgraph_jsonb_has_sensitive_key(metadata)
  ),
  CONSTRAINT domain_events_hash_length CHECK (octet_length(event_hash) = 32),
  CONSTRAINT domain_events_timestamps_ordered CHECK (recorded_at >= occurred_at)
);
--> statement-breakpoint
CREATE INDEX domain_events_world_type_cursor_idx
  ON domain_events (world_id, event_type, world_event_sequence DESC);
--> statement-breakpoint
CREATE INDEX domain_events_world_aggregate_cursor_idx
  ON domain_events (world_id, aggregate_type, aggregate_id, aggregate_version DESC);
--> statement-breakpoint
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  ledger_sequence bigint NOT NULL,
  entry_kind ledger_entry_kind NOT NULL,
  command_id uuid,
  event_id uuid,
  actor_type command_actor_type NOT NULL,
  actor_id text NOT NULL,
  public_summary_code text NOT NULL,
  redacted_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash bytea NOT NULL,
  entry_hash bytea NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_world_identity UNIQUE (world_id, id),
  CONSTRAINT ledger_entries_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT ledger_entries_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_entries_world_sequence_unique UNIQUE (world_id, ledger_sequence),
  CONSTRAINT ledger_entries_event_unique UNIQUE (event_id),
  CONSTRAINT ledger_entries_sequence_positive CHECK (ledger_sequence > 0),
  CONSTRAINT ledger_entries_link_shape CHECK (
    (entry_kind = 'domain_event' AND command_id IS NOT NULL AND event_id IS NOT NULL)
    OR (entry_kind IN ('command_accepted', 'command_rejected')
      AND command_id IS NOT NULL AND event_id IS NULL)
    OR (entry_kind IN ('override', 'repair_anchor') AND event_id IS NOT NULL)
  ),
  CONSTRAINT ledger_entries_actor_id_bounded CHECK (
    char_length(actor_id) BETWEEN 1 AND 160
    AND actor_id = btrim(actor_id) AND actor_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ledger_entries_summary_code_shape CHECK (
    char_length(public_summary_code) BETWEEN 3 AND 120
    AND public_summary_code ~ '^[A-Z][A-Z0-9_]*$'
  ),
  CONSTRAINT ledger_entries_details_safe CHECK (
    jsonb_typeof(redacted_details) = 'object'
    AND pg_column_size(redacted_details) <= 32768
    AND NOT worldgraph_jsonb_has_sensitive_key(redacted_details)
  ),
  CONSTRAINT ledger_entries_hash_lengths CHECK (
    octet_length(previous_hash) = 32 AND octet_length(entry_hash) = 32
  )
);
--> statement-breakpoint
CREATE INDEX ledger_entries_world_actor_cursor_idx
  ON ledger_entries (world_id, actor_type, actor_id, ledger_sequence DESC);
--> statement-breakpoint
CREATE INDEX ledger_entries_world_kind_time_idx
  ON ledger_entries (world_id, entry_kind, recorded_at DESC, ledger_sequence DESC);
--> statement-breakpoint
CREATE TABLE projection_checkpoints (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  projection_name text NOT NULL,
  projection_schema_version integer NOT NULL,
  last_event_sequence bigint NOT NULL,
  checksum bytea NOT NULL,
  status projection_checkpoint_status NOT NULL DEFAULT 'current',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, projection_name),
  CONSTRAINT projection_checkpoints_name_shape CHECK (
    char_length(projection_name) BETWEEN 1 AND 120
    AND projection_name ~ '^[a-z][a-z0-9._-]*$'
  ),
  CONSTRAINT projection_checkpoints_version_known CHECK (projection_schema_version = 1),
  CONSTRAINT projection_checkpoints_sequence_nonnegative CHECK (last_event_sequence >= 0),
  CONSTRAINT projection_checkpoints_hash_length CHECK (octet_length(checksum) = 32)
);
--> statement-breakpoint
CREATE TABLE event_consumer_receipts (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL REFERENCES domain_events(id) ON DELETE RESTRICT,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT event_consumer_receipts_name_shape CHECK (
    char_length(consumer_name) BETWEEN 1 AND 120
    AND consumer_name ~ '^[a-z][a-z0-9._-]*$'
  )
);
--> statement-breakpoint
CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  event_id uuid,
  message_type text NOT NULL,
  message_schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  status outbox_message_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT outbox_messages_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT outbox_messages_event_unique UNIQUE (message_type, event_id),
  CONSTRAINT outbox_messages_type_shape CHECK (
    char_length(message_type) BETWEEN 3 AND 120
    AND message_type ~ '^[A-Z][A-Za-z0-9]*V[1-9][0-9]*$'
  ),
  CONSTRAINT outbox_messages_schema_known CHECK (message_schema_version = 1),
  CONSTRAINT outbox_messages_payload_safe CHECK (
    jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 32768
    AND NOT worldgraph_jsonb_has_sensitive_key(payload)
  ),
  CONSTRAINT outbox_messages_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT outbox_messages_lock_shape CHECK (
    (locked_at IS NULL AND locked_by IS NULL)
    OR (locked_at IS NOT NULL AND locked_by IS NOT NULL
      AND char_length(locked_by) BETWEEN 1 AND 160 AND locked_by !~ '[[:cntrl:]]')
  ),
  CONSTRAINT outbox_messages_status_shape CHECK (
    (status = 'pending' AND published_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL)
    OR (status = 'dead' AND published_at IS NULL)
  ),
  CONSTRAINT outbox_messages_timestamps_ordered CHECK (
    available_at >= created_at
    AND (locked_at IS NULL OR locked_at >= created_at)
    AND (published_at IS NULL OR published_at >= created_at)
  )
);
--> statement-breakpoint
CREATE INDEX outbox_messages_pending_idx
  ON outbox_messages (available_at, created_at, id)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE world_history_entries (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  ledger_sequence bigint NOT NULL,
  command_id uuid,
  event_id uuid,
  event_type text,
  history_schema_version integer NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL,
  category text NOT NULL,
  title_key text NOT NULL,
  summary_args jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type command_actor_type NOT NULL,
  actor_id text NOT NULL,
  target_type text,
  target_id text,
  visibility history_visibility NOT NULL DEFAULT 'member',
  correlation_id uuid NOT NULL,
  resulting_state_revision bigint,
  PRIMARY KEY (world_id, ledger_sequence),
  CONSTRAINT world_history_entries_ledger_fk
    FOREIGN KEY (world_id, ledger_sequence)
    REFERENCES ledger_entries(world_id, ledger_sequence) ON DELETE RESTRICT,
  CONSTRAINT world_history_entries_event_world_fk
    FOREIGN KEY (world_id, event_id)
    REFERENCES domain_events(world_id, id) ON DELETE RESTRICT,
  CONSTRAINT world_history_entries_command_world_fk
    FOREIGN KEY (command_id, world_id)
    REFERENCES command_records(id, world_id) ON DELETE RESTRICT,
  CONSTRAINT world_history_entries_names_valid CHECK (
    char_length(category) BETWEEN 1 AND 80
    AND category ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(title_key) BETWEEN 3 AND 160
    AND title_key ~ '^[a-z][a-z0-9._-]*$'
    AND char_length(actor_id) BETWEEN 1 AND 160
    AND actor_id = btrim(actor_id) AND actor_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT world_history_entries_schema_known CHECK (history_schema_version = 1),
  CONSTRAINT world_history_entries_event_shape CHECK (
    (event_id IS NULL AND event_type IS NULL)
    OR (event_id IS NOT NULL AND event_type IS NOT NULL
      AND char_length(event_type) BETWEEN 3 AND 120
      AND event_type ~ '^[A-Z][A-Za-z0-9]*V[1-9][0-9]*$')
  ),
  CONSTRAINT world_history_entries_target_shape CHECK (
    (target_type IS NULL AND target_id IS NULL)
    OR (target_type IS NOT NULL AND target_id IS NOT NULL
      AND char_length(target_type) BETWEEN 1 AND 80
      AND target_type ~ '^[a-z][a-z0-9._-]*$'
      AND char_length(target_id) BETWEEN 1 AND 240
      AND target_id = btrim(target_id) AND target_id !~ '[[:cntrl:]]')
  ),
  CONSTRAINT world_history_entries_summary_safe CHECK (
    jsonb_typeof(summary_args) = 'object' AND pg_column_size(summary_args) <= 16384
    AND NOT worldgraph_jsonb_has_sensitive_key(summary_args)
  ),
  CONSTRAINT world_history_entries_revision_nonnegative CHECK (
    resulting_state_revision IS NULL OR resulting_state_revision >= 0
  )
);
--> statement-breakpoint
CREATE INDEX world_history_entries_filter_cursor_idx
  ON world_history_entries (
    world_id, visibility, category, actor_type, occurred_at DESC, ledger_sequence DESC
  );
--> statement-breakpoint
CREATE INDEX world_history_entries_target_cursor_idx
  ON world_history_entries (world_id, target_type, target_id, ledger_sequence DESC)
  WHERE target_type IS NOT NULL;
--> statement-breakpoint
CREATE TABLE projection_replay_runs (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  projection_name text NOT NULL,
  target_schema_version integer NOT NULL,
  requested_by_actor_type command_actor_type NOT NULL,
  requested_by_actor_id text NOT NULL,
  from_event_sequence bigint NOT NULL DEFAULT 1,
  to_event_sequence bigint NOT NULL,
  status projection_replay_status NOT NULL DEFAULT 'pending',
  source_checksum bytea NOT NULL,
  replay_checksum bytea,
  first_divergence_sequence bigint,
  failure_code text,
  reason text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projection_replay_runs_projection_shape CHECK (
    char_length(projection_name) BETWEEN 1 AND 120
    AND projection_name ~ '^[a-z][a-z0-9._-]*$'
    AND target_schema_version = 1
  ),
  CONSTRAINT projection_replay_runs_actor_bounded CHECK (
    char_length(requested_by_actor_id) BETWEEN 1 AND 160
    AND requested_by_actor_id = btrim(requested_by_actor_id)
    AND requested_by_actor_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT projection_replay_runs_sequences_valid CHECK (
    from_event_sequence > 0 AND to_event_sequence >= from_event_sequence
    AND (first_divergence_sequence IS NULL
      OR first_divergence_sequence BETWEEN from_event_sequence AND to_event_sequence)
  ),
  CONSTRAINT projection_replay_runs_checksums_valid CHECK (
    octet_length(source_checksum) = 32
    AND (replay_checksum IS NULL OR octet_length(replay_checksum) = 32)
  ),
  CONSTRAINT projection_replay_runs_reason_bounded CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 500
    AND reason = btrim(reason) AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT projection_replay_runs_failure_code_shape CHECK (
    failure_code IS NULL OR (
      char_length(failure_code) BETWEEN 3 AND 120
      AND failure_code ~ '^[A-Z][A-Z0-9_]*$'
    )
  ),
  CONSTRAINT projection_replay_runs_status_shape CHECK (
    (status = 'pending' AND started_at IS NULL AND completed_at IS NULL
      AND replay_checksum IS NULL AND failure_code IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'succeeded' AND started_at IS NOT NULL AND completed_at IS NOT NULL
      AND replay_checksum IS NOT NULL AND failure_code IS NULL)
    OR (status IN ('failed', 'cancelled') AND completed_at IS NOT NULL
      AND failure_code IS NOT NULL)
  ),
  CONSTRAINT projection_replay_runs_timestamps_ordered CHECK (
    updated_at >= requested_at
    AND (started_at IS NULL OR started_at >= requested_at)
    AND (completed_at IS NULL OR completed_at >= COALESCE(started_at, requested_at))
  )
);
--> statement-breakpoint
CREATE INDEX projection_replay_runs_world_cursor_idx
  ON projection_replay_runs (world_id, requested_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE shadow_world_entities (
  replay_run_id uuid NOT NULL REFERENCES projection_replay_runs(id) ON DELETE CASCADE,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  entity_id uuid NOT NULL,
  logical_key text NOT NULL,
  entity_type text NOT NULL,
  entity_schema_version integer NOT NULL,
  state jsonb NOT NULL,
  row_version bigint NOT NULL,
  PRIMARY KEY (replay_run_id, entity_id),
  CONSTRAINT shadow_world_entities_key_unique UNIQUE (replay_run_id, logical_key),
  CONSTRAINT shadow_world_entities_state_safe CHECK (
    char_length(logical_key) BETWEEN 3 AND 240
    AND jsonb_typeof(state) = 'object' AND pg_column_size(state) <= 262144
    AND NOT worldgraph_jsonb_has_sensitive_key(state)
    AND row_version >= 0 AND entity_schema_version = 1
  )
);
--> statement-breakpoint
CREATE TABLE shadow_world_relationships (
  replay_run_id uuid NOT NULL REFERENCES projection_replay_runs(id) ON DELETE CASCADE,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  relationship_id uuid NOT NULL,
  logical_key text NOT NULL,
  relationship_type text NOT NULL,
  source_entity_id uuid NOT NULL,
  target_entity_id uuid NOT NULL,
  relationship_schema_version integer NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_version bigint NOT NULL,
  PRIMARY KEY (replay_run_id, relationship_id),
  CONSTRAINT shadow_world_relationships_key_unique UNIQUE (replay_run_id, logical_key),
  CONSTRAINT shadow_world_relationships_source_fk
    FOREIGN KEY (replay_run_id, source_entity_id)
    REFERENCES shadow_world_entities(replay_run_id, entity_id) ON DELETE RESTRICT,
  CONSTRAINT shadow_world_relationships_target_fk
    FOREIGN KEY (replay_run_id, target_entity_id)
    REFERENCES shadow_world_entities(replay_run_id, entity_id) ON DELETE RESTRICT,
  CONSTRAINT shadow_world_relationships_attributes_safe CHECK (
    char_length(logical_key) BETWEEN 5 AND 240
    AND jsonb_typeof(attributes) = 'object' AND pg_column_size(attributes) <= 65536
    AND NOT worldgraph_jsonb_has_sensitive_key(attributes)
    AND row_version >= 0 AND relationship_schema_version = 1
  )
);
--> statement-breakpoint
CREATE TABLE shadow_world_entity_controllers (
  replay_run_id uuid NOT NULL REFERENCES projection_replay_runs(id) ON DELETE CASCADE,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entity_id uuid NOT NULL,
  control_scope text NOT NULL,
  principal_key text NOT NULL,
  entity_logical_key text NOT NULL,
  PRIMARY KEY (replay_run_id, user_id, entity_id, control_scope),
  CONSTRAINT shadow_world_entity_controllers_entity_fk
    FOREIGN KEY (replay_run_id, entity_id)
    REFERENCES shadow_world_entities(replay_run_id, entity_id) ON DELETE RESTRICT,
  CONSTRAINT shadow_world_entity_controllers_shape CHECK (
    control_scope = 'primary'
    AND principal_key ~ '^member-[a-f0-9]{32}$'
    AND char_length(entity_logical_key) BETWEEN 3 AND 240
  )
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_shadow_projection_document(
  checked_replay_run_id uuid,
  state_revision_override bigint
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN jsonb_build_object(
  'activeWorldVersionId', (
    SELECT runtime.active_world_version_id::text
    FROM public.projection_replay_runs replay
    JOIN public.world_runtime_heads runtime ON runtime.world_id = replay.world_id
    WHERE replay.id = checked_replay_run_id
  ),
  'controllers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'controlScope', control_scope,
      'entityLogicalKey', entity_logical_key,
      'principalKey', principal_key
    ) ORDER BY entity_logical_key COLLATE "C", principal_key COLLATE "C")
    FROM public.shadow_world_entity_controllers
    WHERE replay_run_id = checked_replay_run_id
  ), '[]'::jsonb),
  'domain', 'worldgraph.projection.v1',
  'entities', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'entitySchemaVersion', entity_schema_version,
      'entityType', entity_type,
      'entityVersion', (row_version + 1)::text,
      'logicalKey', logical_key,
      'state', state
    ) ORDER BY logical_key COLLATE "C", entity_id)
    FROM public.shadow_world_entities
    WHERE replay_run_id = checked_replay_run_id
  ), '[]'::jsonb),
  'relationships', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'attributes', relationship.attributes,
      'logicalKey', relationship.logical_key,
      'relationshipSchemaVersion', relationship.relationship_schema_version,
      'relationshipType', relationship.relationship_type,
      'sourceLogicalKey', source.logical_key,
      'targetLogicalKey', target.logical_key
    ) ORDER BY relationship.logical_key COLLATE "C", relationship.relationship_id)
    FROM public.shadow_world_relationships relationship
    JOIN public.shadow_world_entities source
      ON source.replay_run_id = relationship.replay_run_id
      AND source.entity_id = relationship.source_entity_id
    JOIN public.shadow_world_entities target
      ON target.replay_run_id = relationship.replay_run_id
      AND target.entity_id = relationship.target_entity_id
    WHERE relationship.replay_run_id = checked_replay_run_id
  ), '[]'::jsonb),
  'projectionSchemaVersion', 1,
  'stateRevision', state_revision_override::text,
  'worldId', (
    SELECT world_id::text FROM public.projection_replay_runs
    WHERE id = checked_replay_run_id
  ),
  'worldVersionNumber', (
    SELECT version.version_number::text
    FROM public.projection_replay_runs replay
    JOIN public.world_runtime_heads runtime ON runtime.world_id = replay.world_id
    JOIN public.world_versions version
      ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
    WHERE replay.id = checked_replay_run_id
  )
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_shadow_projection_checksum(
  checked_replay_run_id uuid,
  state_revision_override bigint
)
RETURNS bytea
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, extensions
RETURN extensions.digest(
  convert_to(public.worldgraph_canonical_jsonb(
    public.worldgraph_shadow_projection_document(
      checked_replay_run_id, state_revision_override
    )
  ), 'UTF8'),
  'sha256'
);
--> statement-breakpoint
DO $backfill$
DECLARE
  active_world record;
  anchor_time timestamptz;
  checksum_value bytea;
  command_id_value uuid;
  event_id_value uuid;
  entry_id_value uuid;
  outbox_id_value uuid;
  payload_value jsonb;
  metadata_value jsonb;
  event_hash_value bytea;
  entry_hash_value bytea;
  zero_hash bytea := decode(repeat('00', 32), 'hex');
BEGIN
  FOR active_world IN
    SELECT runtime.world_id, runtime.active_world_version_id, version.artifact_hash,
      version.version_number,
      (SELECT count(*) FROM world_entities entity
        WHERE entity.world_id = runtime.world_id
          AND entity.retired_world_version_id IS NULL) AS entity_count,
      (SELECT count(*) FROM world_relationships relationship
        WHERE relationship.world_id = runtime.world_id
          AND relationship.retired_world_version_id IS NULL) AS relationship_count,
      (SELECT count(*) FROM world_entity_controllers controller
        WHERE controller.world_id = runtime.world_id
          AND controller.revoked_at IS NULL) AS controller_count
    FROM world_runtime_heads runtime
    JOIN worlds world ON world.id = runtime.world_id
    JOIN world_versions version
      ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
    WHERE world.lifecycle = 'active' AND world.active_world_version_id = runtime.active_world_version_id
    ORDER BY runtime.world_id
  LOOP
    PERFORM public.worldgraph_lock_world_compilation(active_world.world_id);
    SELECT ledger_anchored_at INTO anchor_time
    FROM world_runtime_heads WHERE world_id = active_world.world_id FOR UPDATE;
    IF anchor_time IS NOT NULL THEN
      CONTINUE;
    END IF;

    anchor_time := date_trunc('milliseconds', transaction_timestamp());
    checksum_value := public.worldgraph_projection_checksum(active_world.world_id, 1);
    command_id_value := substr(encode(extensions.digest(convert_to(
      'worldgraph:m06:upgrade:command:' || active_world.world_id::text, 'UTF8'
    ), 'sha256'), 'hex'), 1, 32)::uuid;
    event_id_value := substr(encode(extensions.digest(convert_to(
      'worldgraph:m06:upgrade:event:' || active_world.world_id::text, 'UTF8'
    ), 'sha256'), 'hex'), 1, 32)::uuid;
    entry_id_value := substr(encode(extensions.digest(convert_to(
      'worldgraph:m06:upgrade:ledger:' || active_world.world_id::text, 'UTF8'
    ), 'sha256'), 'hex'), 1, 32)::uuid;
    outbox_id_value := substr(encode(extensions.digest(convert_to(
      'worldgraph:m06:upgrade:outbox:' || active_world.world_id::text, 'UTF8'
    ), 'sha256'), 'hex'), 1, 32)::uuid;
    payload_value := jsonb_build_object(
      'activeWorldVersionId', active_world.active_world_version_id::text,
      'artifactHash', encode(active_world.artifact_hash, 'hex'),
      'projectionSchemaVersions', jsonb_build_object(
        'controllers', 1, 'entities', 1, 'relationships', 1, 'runtimeHead', 1
      ),
      'rowCounts', jsonb_build_object(
        'controllers', active_world.controller_count::text,
        'entities', active_world.entity_count::text,
        'relationships', active_world.relationship_count::text
      ),
      'stateChecksum', encode(checksum_value, 'hex'),
      'worldVersionNumber', active_world.version_number::text
    );
    metadata_value := jsonb_build_object(
      'actor', jsonb_build_object(
        'actorId', 'worldgraph:migration:0007', 'actorType', 'system'
      ),
      'authorizationRuleId', 'system.migration.m06_genesis',
      'causationId', NULL,
      'commandSchemaVersion', 1,
      'commandType', 'WorldStateImportedV1',
      'correlationId', command_id_value::text,
      'overrideId', NULL,
      'payloadClassification', 'member'
    );

    INSERT INTO command_records(
      id, world_id, command_type, command_schema_version, actor_type, actor_id,
      payload, payload_hash, payload_classification, idempotency_key, request_hash,
      expected_world_version, expected_state_revision,
      opened_state_revision, opened_ledger_sequence, opened_event_sequence,
      opened_projection_checksum, write_gate_opened_at,
      status, authorization_rule_id, correlation_id, requested_at, decided_at,
      resulting_state_revision, response_summary
    ) VALUES (
      command_id_value, active_world.world_id, 'WorldStateImportedV1', 1,
      'system', 'worldgraph:migration:0007', payload_value,
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(payload_value), 'UTF8'), 'sha256'),
      'member', 'm06-import-genesis',
      extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
        'commandType', 'WorldStateImportedV1', 'payload', payload_value,
        'worldId', active_world.world_id::text
      )), 'UTF8'), 'sha256'),
      active_world.version_number, 0,
      0, 0, 0, NULL, anchor_time,
      'accepted', 'system.migration.m06_genesis', command_id_value,
      anchor_time, anchor_time, 1,
      jsonb_build_object(
        'commandId', command_id_value::text,
        'eventIds', jsonb_build_array(event_id_value::text),
        'eventSequenceRange', jsonb_build_object('from', '1', 'to', '1'),
        'ledgerSequenceRange', jsonb_build_object('from', '1', 'to', '1'),
        'resultingStateRevision', '1',
        'schemaVersion', 1,
        'status', 'accepted'
      )
    );

    event_hash_value := public.worldgraph_domain_event_hash_v1(
      event_id_value, active_world.world_id, 1, command_id_value, 0,
      'world', active_world.world_id::text, 1, 'WorldStateImportedV1', 1,
      payload_value, metadata_value, anchor_time, anchor_time, 1
    );
    INSERT INTO domain_events(
      id, world_id, world_event_sequence, command_id, event_ordinal,
      aggregate_type, aggregate_id, aggregate_version, event_type,
      event_schema_version, payload, metadata, event_hash, occurred_at,
      recorded_at, resulting_state_revision
    ) VALUES (
      event_id_value, active_world.world_id, 1, command_id_value, 0,
      'world', active_world.world_id::text, 1, 'WorldStateImportedV1', 1,
      payload_value, metadata_value, event_hash_value, anchor_time, anchor_time, 1
    );
    INSERT INTO aggregate_stream_heads(world_id, aggregate_type, aggregate_id, current_version, updated_at)
    VALUES (active_world.world_id, 'world', active_world.world_id::text, 1, anchor_time);

    entry_hash_value := public.worldgraph_ledger_entry_hash_v1(
      entry_id_value, active_world.world_id, 1, 'domain_event', command_id_value,
      event_id_value, 'system', 'worldgraph:migration:0007',
      'WORLD_STATE_IMPORTED', jsonb_build_object(
        'eventType', 'WorldStateImportedV1',
        'stateChecksum', encode(checksum_value, 'hex')
      ), zero_hash, anchor_time
    );
    INSERT INTO ledger_entries(
      id, world_id, ledger_sequence, entry_kind, command_id, event_id,
      actor_type, actor_id, public_summary_code, redacted_details,
      previous_hash, entry_hash, recorded_at
    ) VALUES (
      entry_id_value, active_world.world_id, 1, 'domain_event', command_id_value,
      event_id_value, 'system', 'worldgraph:migration:0007',
      'WORLD_STATE_IMPORTED', jsonb_build_object(
        'eventType', 'WorldStateImportedV1',
        'stateChecksum', encode(checksum_value, 'hex')
      ), zero_hash, entry_hash_value, anchor_time
    );
    INSERT INTO world_history_entries(
      world_id, ledger_sequence, command_id, event_id, event_type, occurred_at,
      category, title_key,
      summary_args, actor_type, actor_id, target_type, target_id, visibility,
      correlation_id, resulting_state_revision
    ) VALUES (
      active_world.world_id, 1, command_id_value, event_id_value,
      'WorldStateImportedV1', anchor_time, 'genesis',
      'history.genesis.imported', jsonb_build_object(
        'artifactHash', encode(active_world.artifact_hash, 'hex'),
        'controllers', active_world.controller_count::text,
        'entities', active_world.entity_count::text,
        'relationships', active_world.relationship_count::text,
        'worldVersionNumber', active_world.version_number::text
      ), 'system', 'worldgraph:migration:0007', 'world_version',
      active_world.active_world_version_id::text,
      'member', command_id_value, 1
    );
    INSERT INTO projection_checkpoints(
      world_id, projection_name, projection_schema_version,
      last_event_sequence, checksum, status, updated_at
    ) VALUES (
      active_world.world_id, 'world_graph', 1, 1, checksum_value, 'current', anchor_time
    );
    INSERT INTO outbox_messages(
      id, world_id, event_id, message_type, message_schema_version,
      payload, status, attempts, available_at, created_at
    ) VALUES (
      outbox_id_value, active_world.world_id, event_id_value,
      'DomainEventReferenceV1', 1,
      jsonb_build_object(
        'eventId', event_id_value::text,
        'eventType', 'WorldStateImportedV1',
        'worldEventSequence', '1',
        'worldId', active_world.world_id::text
      ), 'pending', 0, anchor_time, anchor_time
    );
    INSERT INTO world_ledger_heads(
      world_id, next_ledger_sequence, next_event_sequence, last_entry_hash,
      ledger_schema_version, anchored_at, anchor_event_id, anchor_artifact_hash, updated_at
    ) VALUES (
      active_world.world_id, 2, 2, entry_hash_value, 1, anchor_time,
      event_id_value, active_world.artifact_hash, anchor_time
    );
    UPDATE world_runtime_heads
    SET state_revision = 1,
        last_ledger_sequence = 1,
        last_event_sequence = 1,
        ledger_anchored_at = anchor_time,
        ledger_anchor_event_id = event_id_value,
        anchor_artifact_hash = active_world.artifact_hash,
        projection_checksum = checksum_value,
        updated_at = greatest(updated_at, anchor_time)
    WHERE world_id = active_world.world_id;
  END LOOP;
END
$backfill$;
--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
ALTER TABLE world_ledger_heads
  ADD CONSTRAINT world_ledger_heads_anchor_event_world_fk
  FOREIGN KEY (world_id, anchor_event_id)
  REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE world_runtime_heads
  ADD CONSTRAINT world_runtime_heads_anchor_event_world_fk
  FOREIGN KEY (world_id, ledger_anchor_event_id)
  REFERENCES domain_events(world_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION worldgraph_command_write_is_open(checked_world_id uuid, checked_command_id uuid DEFAULT NULL)
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
  );
--> statement-breakpoint
CREATE FUNCTION worldgraph_open_command_write(checked_command_id uuid, checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_record record;
  ledger_record record;
  snapshot_time timestamptz;
BEGIN
  SELECT id, world_id, command_type, status, causation_id INTO command_record
  FROM public.command_records
  WHERE id = checked_command_id AND world_id = checked_world_id
  FOR UPDATE;
  IF NOT FOUND OR command_record.status <> 'received'::command_record_status THEN
    RAISE EXCEPTION 'command write gate requires the matching received command'
      USING ERRCODE = '55000';
  END IF;
  SELECT ledger.anchored_at,
    ledger.next_ledger_sequence, ledger.next_event_sequence,
    runtime.state_revision, runtime.last_ledger_sequence,
    runtime.last_event_sequence, runtime.projection_checksum
  INTO ledger_record
  FROM public.world_ledger_heads ledger
  JOIN public.world_runtime_heads runtime ON runtime.world_id = ledger.world_id
  WHERE ledger.world_id = checked_world_id
  FOR UPDATE OF ledger, runtime;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'world ledger or runtime head is missing' USING ERRCODE = '55000';
  END IF;
  IF ledger_record.anchored_at IS NULL
    AND command_record.command_type <> 'WorldCompiledGenesisV1' THEN
    RAISE EXCEPTION 'world ledger is not anchored' USING ERRCODE = '55000';
  END IF;
  IF ledger_record.last_ledger_sequence <> ledger_record.next_ledger_sequence - 1
    OR ledger_record.last_event_sequence <> ledger_record.next_event_sequence - 1 THEN
    RAISE EXCEPTION 'world runtime and allocation heads disagree'
      USING ERRCODE = '55000';
  END IF;
  IF ledger_record.anchored_at IS NULL AND NOT EXISTS (
    SELECT 1
    FROM public.world_ledger_heads ledger
    JOIN public.world_runtime_heads runtime ON runtime.world_id = ledger.world_id
    WHERE ledger.world_id = checked_world_id
      AND ledger.next_ledger_sequence = 1
      AND ledger.next_event_sequence = 1
      AND ledger.last_entry_hash IS NULL
      AND ledger.anchor_event_id IS NULL
      AND ledger.anchor_artifact_hash IS NULL
      AND runtime.state_revision = 0
      AND runtime.last_ledger_sequence = 0
      AND runtime.last_event_sequence = 0
      AND runtime.ledger_anchored_at IS NULL
      AND runtime.ledger_anchor_event_id IS NULL
      AND runtime.anchor_artifact_hash IS NULL
      AND runtime.projection_checksum IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.domain_events event WHERE event.world_id = checked_world_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ledger_entries entry WHERE entry.world_id = checked_world_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.projection_checkpoints checkpoint
        WHERE checkpoint.world_id = checked_world_id
      )
  ) THEN
    RAISE EXCEPTION 'compiled genesis requires pristine unanchored authority'
      USING ERRCODE = '55000';
  END IF;
  IF ledger_record.anchored_at IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.world_ledger_heads ledger
    JOIN public.world_runtime_heads runtime ON runtime.world_id = ledger.world_id
    JOIN public.worlds world ON world.id = runtime.world_id
    JOIN public.world_versions version
      ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
    JOIN public.domain_events anchor_event
      ON anchor_event.id = ledger.anchor_event_id AND anchor_event.world_id = ledger.world_id
    JOIN public.ledger_entries anchor_entry
      ON anchor_entry.world_id = anchor_event.world_id
      AND anchor_entry.event_id = anchor_event.id
      AND anchor_entry.command_id = anchor_event.command_id
      AND anchor_entry.ledger_sequence = 1
    LEFT JOIN public.ledger_entries anchor_successor
      ON anchor_successor.world_id = anchor_entry.world_id
      AND anchor_successor.ledger_sequence = 2
    JOIN public.ledger_entries last_entry
      ON last_entry.world_id = ledger.world_id
      AND last_entry.ledger_sequence = runtime.last_ledger_sequence
    LEFT JOIN public.ledger_entries previous_entry
      ON previous_entry.world_id = last_entry.world_id
      AND previous_entry.ledger_sequence = last_entry.ledger_sequence - 1
    JOIN public.domain_events last_event
      ON last_event.world_id = ledger.world_id
      AND last_event.world_event_sequence = runtime.last_event_sequence
    WHERE ledger.world_id = checked_world_id
      AND world.lifecycle = 'active'::world_lifecycle
      AND world.active_world_version_id = runtime.active_world_version_id
      AND version.status = 'active'::world_version_status
      AND runtime.ledger_schema_version = 1
      AND runtime.event_schema_version = 1
      AND runtime.projection_schema_version = 1
      AND ledger.ledger_schema_version = 1
      AND runtime.ledger_anchored_at = ledger.anchored_at
      AND runtime.ledger_anchor_event_id = ledger.anchor_event_id
      AND runtime.anchor_artifact_hash = ledger.anchor_artifact_hash
      AND ledger.anchor_artifact_hash = version.artifact_hash
      AND anchor_event.world_event_sequence = 1
      AND anchor_event.event_type IN ('WorldCompiledGenesisV1', 'WorldStateImportedV1')
      AND anchor_event.payload ->> 'activeWorldVersionId' = runtime.active_world_version_id::text
      AND anchor_event.payload ->> 'artifactHash' = encode(ledger.anchor_artifact_hash, 'hex')
      AND anchor_event.event_hash = public.worldgraph_domain_event_hash_v1(
        anchor_event.id, anchor_event.world_id, anchor_event.world_event_sequence,
        anchor_event.command_id, anchor_event.event_ordinal, anchor_event.aggregate_type,
        anchor_event.aggregate_id, anchor_event.aggregate_version, anchor_event.event_type,
        anchor_event.event_schema_version, anchor_event.payload, anchor_event.metadata,
        anchor_event.occurred_at, anchor_event.recorded_at,
        anchor_event.resulting_state_revision
      )
      AND anchor_entry.entry_kind = 'domain_event'::ledger_entry_kind
      AND anchor_entry.previous_hash = decode(repeat('00', 32), 'hex')
      AND anchor_entry.entry_hash = public.worldgraph_ledger_entry_hash_v1(
        anchor_entry.id, anchor_entry.world_id, anchor_entry.ledger_sequence,
        anchor_entry.entry_kind::text, anchor_entry.command_id, anchor_entry.event_id,
        anchor_entry.actor_type::text, anchor_entry.actor_id, anchor_entry.public_summary_code,
        anchor_entry.redacted_details, anchor_entry.previous_hash, anchor_entry.recorded_at
      )
      AND (
        ledger.next_ledger_sequence = 2
        OR anchor_successor.previous_hash = anchor_entry.entry_hash
      )
      AND runtime.last_ledger_sequence = ledger.next_ledger_sequence - 1
      AND runtime.last_event_sequence = ledger.next_event_sequence - 1
      AND runtime.last_ledger_sequence > 0
      AND runtime.last_event_sequence > 0
      AND ledger.last_entry_hash = last_entry.entry_hash
      AND last_entry.entry_hash = public.worldgraph_ledger_entry_hash_v1(
        last_entry.id, last_entry.world_id, last_entry.ledger_sequence,
        last_entry.entry_kind::text, last_entry.command_id, last_entry.event_id,
        last_entry.actor_type::text, last_entry.actor_id, last_entry.public_summary_code,
        last_entry.redacted_details, last_entry.previous_hash, last_entry.recorded_at
      )
      AND (
        (last_entry.ledger_sequence = 1
          AND last_entry.previous_hash = decode(repeat('00', 32), 'hex'))
        OR (last_entry.ledger_sequence > 1
          AND previous_entry.entry_hash = last_entry.previous_hash)
      )
      AND last_event.resulting_state_revision = runtime.state_revision
      AND last_event.event_hash = public.worldgraph_domain_event_hash_v1(
        last_event.id, last_event.world_id, last_event.world_event_sequence,
        last_event.command_id, last_event.event_ordinal, last_event.aggregate_type,
        last_event.aggregate_id, last_event.aggregate_version, last_event.event_type,
        last_event.event_schema_version, last_event.payload, last_event.metadata,
        last_event.occurred_at, last_event.recorded_at,
        last_event.resulting_state_revision
      )
      AND EXISTS (
        SELECT 1 FROM public.ledger_entries event_entry
        WHERE event_entry.world_id = last_event.world_id
          AND event_entry.event_id = last_event.id
      )
  ) THEN
    RAISE EXCEPTION 'world ledger authority is inconsistent; command writes are frozen'
      USING ERRCODE = '55000';
  END IF;
  IF ledger_record.anchored_at IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.world_runtime_heads runtime
    JOIN public.projection_checkpoints checkpoint
      ON checkpoint.world_id = runtime.world_id AND checkpoint.projection_name = 'world_graph'
    WHERE runtime.world_id = checked_world_id
      AND checkpoint.projection_schema_version = runtime.projection_schema_version
      AND checkpoint.status = 'current'::projection_checkpoint_status
      AND checkpoint.last_event_sequence = runtime.last_event_sequence
      AND checkpoint.checksum = runtime.projection_checksum
      AND runtime.projection_checksum = public.worldgraph_projection_checksum(
        runtime.world_id, runtime.state_revision
      )
  ) THEN
    IF command_record.command_type <> 'ProjectionRepairAnchoredV1'
      OR command_record.causation_id IS NULL
      OR NULLIF(current_setting('worldgraph.repair_run_id', true), '')
        IS DISTINCT FROM command_record.causation_id::text
      OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname = 'worldgraph_projection_repair_swap'
          AND procedure.pronargs = 10
          AND pg_catalog.pg_has_role(
            session_user, pg_catalog.pg_get_userbyid(procedure.proowner), 'MEMBER'
          )
      )
      OR NOT EXISTS (
        SELECT 1 FROM public.projection_replay_runs replay
        WHERE replay.id = command_record.causation_id
          AND replay.world_id = checked_world_id
          AND replay.status = 'succeeded'::projection_replay_status
      ) THEN
      RAISE EXCEPTION 'world projection authority is inconsistent; command writes are frozen'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  snapshot_time := clock_timestamp();
  UPDATE public.command_records
  SET opened_state_revision = ledger_record.state_revision,
      opened_ledger_sequence = ledger_record.last_ledger_sequence,
      opened_event_sequence = ledger_record.last_event_sequence,
      opened_projection_checksum = ledger_record.projection_checksum,
      write_gate_opened_at = snapshot_time
  WHERE id = checked_command_id AND world_id = checked_world_id
    AND write_gate_opened_at IS NULL;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM public.command_records command
    WHERE command.id = checked_command_id AND command.world_id = checked_world_id
      AND command.status = 'received'::command_record_status
      AND command.opened_state_revision = ledger_record.state_revision
      AND command.opened_ledger_sequence = ledger_record.last_ledger_sequence
      AND command.opened_event_sequence = ledger_record.last_event_sequence
      AND command.opened_projection_checksum IS NOT DISTINCT FROM ledger_record.projection_checksum
      AND command.write_gate_opened_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'command write gate snapshot is inconsistent'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('worldgraph.command_id', checked_command_id::text, true);
  PERFORM set_config('worldgraph.command_world_id', checked_world_id::text, true);
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_open_command_write(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_command_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'command records are durable' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'received'::command_record_status THEN
      RAISE EXCEPTION 'command records must begin received' USING ERRCODE = '55000';
    END IF;
    IF NEW.world_id IS NOT NULL AND NEW.command_type <> 'WorldCompiledGenesisV1'
      AND NOT EXISTS (
        SELECT 1 FROM public.world_ledger_heads head
        WHERE head.world_id = NEW.world_id AND head.anchored_at IS NOT NULL
      ) THEN
      RAISE EXCEPTION 'world ledger is not anchored' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'received'::command_record_status
    AND NEW.status = 'received'::command_record_status THEN
    IF current_user <> pg_catalog.pg_get_userbyid((
        SELECT procedure.proowner
        FROM pg_catalog.pg_proc procedure
        WHERE procedure.oid = 'public.worldgraph_open_command_write(uuid,uuid)'::regprocedure
      ))
      OR OLD.write_gate_opened_at IS NOT NULL
      OR OLD.opened_state_revision IS NOT NULL
      OR OLD.opened_ledger_sequence IS NOT NULL
      OR OLD.opened_event_sequence IS NOT NULL
      OR OLD.opened_projection_checksum IS NOT NULL
      OR NEW.write_gate_opened_at IS NULL
      OR NEW.opened_state_revision IS NULL
      OR NEW.opened_ledger_sequence IS NULL
      OR NEW.opened_event_sequence IS NULL
      OR (
        to_jsonb(NEW) - ARRAY[
          'opened_state_revision', 'opened_ledger_sequence', 'opened_event_sequence',
          'opened_projection_checksum', 'write_gate_opened_at'
        ]
      ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
          'opened_state_revision', 'opened_ledger_sequence', 'opened_event_sequence',
          'opened_projection_checksum', 'write_gate_opened_at'
        ]
      ) THEN
      RAISE EXCEPTION 'command write gate snapshot may only be initialized by its owner function'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'received'::command_record_status
    OR NEW.status NOT IN (
      'accepted'::command_record_status,
      'rejected'::command_record_status,
      'failed'::command_record_status
    )
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.command_type IS DISTINCT FROM OLD.command_type
    OR NEW.command_schema_version IS DISTINCT FROM OLD.command_schema_version
    OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.payload_classification IS DISTINCT FROM OLD.payload_classification
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.expected_world_version IS DISTINCT FROM OLD.expected_world_version
    OR NEW.expected_state_revision IS DISTINCT FROM OLD.expected_state_revision
    OR NEW.opened_state_revision IS DISTINCT FROM OLD.opened_state_revision
    OR NEW.opened_ledger_sequence IS DISTINCT FROM OLD.opened_ledger_sequence
    OR NEW.opened_event_sequence IS DISTINCT FROM OLD.opened_event_sequence
    OR NEW.opened_projection_checksum IS DISTINCT FROM OLD.opened_projection_checksum
    OR NEW.write_gate_opened_at IS DISTINCT FROM OLD.write_gate_opened_at
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'command record transition is immutable or invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.world_id IS NOT NULL
    AND NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.id) THEN
    RAISE EXCEPTION 'command terminal transition requires its open write gate'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER command_records_protect
  BEFORE INSERT OR UPDATE OR DELETE ON command_records
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_command_record();
--> statement-breakpoint
CREATE FUNCTION worldgraph_allocate_domain_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  expected_sequence bigint;
  existing_version bigint;
BEGIN
  IF NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.command_id) THEN
    RAISE EXCEPTION 'domain event append requires its open command write gate'
      USING ERRCODE = '55000';
  END IF;
  SELECT next_event_sequence INTO expected_sequence
  FROM public.world_ledger_heads WHERE world_id = NEW.world_id FOR UPDATE;
  IF NOT FOUND OR NEW.world_event_sequence <> expected_sequence THEN
    RAISE EXCEPTION 'world event sequence is not the next contiguous position'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.event_hash IS DISTINCT FROM public.worldgraph_domain_event_hash_v1(
    NEW.id, NEW.world_id, NEW.world_event_sequence, NEW.command_id, NEW.event_ordinal,
    NEW.aggregate_type, NEW.aggregate_id, NEW.aggregate_version, NEW.event_type,
    NEW.event_schema_version, NEW.payload, NEW.metadata, NEW.occurred_at,
    NEW.recorded_at, NEW.resulting_state_revision
  ) THEN
    RAISE EXCEPTION 'domain event hash does not match immutable event bytes'
      USING ERRCODE = '23514', CONSTRAINT = 'domain_events_hash_valid';
  END IF;
  SELECT current_version INTO existing_version
  FROM public.aggregate_stream_heads
  WHERE world_id = NEW.world_id AND aggregate_type = NEW.aggregate_type
    AND aggregate_id = NEW.aggregate_id
  FOR UPDATE;
  IF FOUND THEN
    IF NEW.aggregate_version <> existing_version + 1 THEN
      RAISE EXCEPTION 'aggregate version is not contiguous' USING ERRCODE = '40001';
    END IF;
    UPDATE public.aggregate_stream_heads
    SET current_version = NEW.aggregate_version, updated_at = NEW.recorded_at
    WHERE world_id = NEW.world_id AND aggregate_type = NEW.aggregate_type
      AND aggregate_id = NEW.aggregate_id;
  ELSE
    IF NEW.aggregate_version <> 1 THEN
      RAISE EXCEPTION 'first aggregate version must be one' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.aggregate_stream_heads(
      world_id, aggregate_type, aggregate_id, current_version, updated_at
    ) VALUES (
      NEW.world_id, NEW.aggregate_type, NEW.aggregate_id,
      NEW.aggregate_version, NEW.recorded_at
    );
  END IF;
  UPDATE public.world_ledger_heads
  SET next_event_sequence = next_event_sequence + 1,
      updated_at = greatest(updated_at, NEW.recorded_at)
  WHERE world_id = NEW.world_id;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER domain_events_allocate
  BEFORE INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION worldgraph_allocate_domain_event();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_allocate_domain_event() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_allocate_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  expected_sequence bigint;
  expected_previous_hash bytea;
BEGIN
  IF NEW.command_id IS NOT NULL
    AND NOT public.worldgraph_command_write_is_open(NEW.world_id, NEW.command_id) THEN
    RAISE EXCEPTION 'ledger append requires its open command write gate'
      USING ERRCODE = '55000';
  END IF;
  SELECT next_ledger_sequence,
    COALESCE(last_entry_hash, decode(repeat('00', 32), 'hex'))
  INTO expected_sequence, expected_previous_hash
  FROM public.world_ledger_heads WHERE world_id = NEW.world_id FOR UPDATE;
  IF NOT FOUND OR NEW.ledger_sequence <> expected_sequence THEN
    RAISE EXCEPTION 'ledger sequence is not the next contiguous position'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.previous_hash IS DISTINCT FROM expected_previous_hash THEN
    RAISE EXCEPTION 'ledger previous hash does not match the world head'
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_entries_previous_hash_valid';
  END IF;
  IF NEW.entry_hash IS DISTINCT FROM public.worldgraph_ledger_entry_hash_v1(
    NEW.id, NEW.world_id, NEW.ledger_sequence, NEW.entry_kind::text,
    NEW.command_id, NEW.event_id, NEW.actor_type::text, NEW.actor_id,
    NEW.public_summary_code, NEW.redacted_details, NEW.previous_hash, NEW.recorded_at
  ) THEN
    RAISE EXCEPTION 'ledger entry hash does not match immutable entry bytes'
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_entries_hash_valid';
  END IF;
  UPDATE public.world_ledger_heads
  SET next_ledger_sequence = next_ledger_sequence + 1,
      last_entry_hash = NEW.entry_hash,
      updated_at = greatest(updated_at, NEW.recorded_at)
  WHERE world_id = NEW.world_id;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_allocate
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION worldgraph_allocate_ledger_entry();
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_allocate_ledger_entry() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_reject_update_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$function$;
--> statement-breakpoint
CREATE TRIGGER domain_events_append_only
  BEFORE UPDATE OR DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION worldgraph_reject_update_delete();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION worldgraph_reject_update_delete();
--> statement-breakpoint
CREATE TRIGGER event_consumer_receipts_append_only
  BEFORE UPDATE OR DELETE ON event_consumer_receipts
  FOR EACH ROW EXECUTE FUNCTION worldgraph_reject_update_delete();
--> statement-breakpoint
CREATE TRIGGER world_history_entries_append_only
  BEFORE UPDATE OR DELETE ON world_history_entries
  FOR EACH ROW EXECUTE FUNCTION worldgraph_reject_update_delete();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_world_ledger_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world ledger heads cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.anchored_at IS NOT NULL OR NEW.next_ledger_sequence <> 1
      OR NEW.next_event_sequence <> 1 OR NEW.last_entry_hash IS NOT NULL THEN
      RAISE EXCEPTION 'world ledger heads must begin unanchored at sequence one'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.ledger_schema_version IS DISTINCT FROM OLD.ledger_schema_version
    OR NEW.next_ledger_sequence < OLD.next_ledger_sequence
    OR NEW.next_event_sequence < OLD.next_event_sequence
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.anchored_at IS NOT NULL AND (
      NEW.anchored_at IS DISTINCT FROM OLD.anchored_at
      OR NEW.anchor_event_id IS DISTINCT FROM OLD.anchor_event_id
      OR NEW.anchor_artifact_hash IS DISTINCT FROM OLD.anchor_artifact_hash
    ))
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id) THEN
    RAISE EXCEPTION 'world ledger head update is inconsistent or outside a command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_ledger_heads_protect
  BEFORE INSERT OR UPDATE OR DELETE ON world_ledger_heads
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_world_ledger_head();
--> statement-breakpoint
CREATE FUNCTION worldgraph_projection_repair_write_is_open(checked_world_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN NULLIF(current_setting('worldgraph.repair_run_id', true), '') IS NOT NULL
  AND current_user = (
    SELECT role.rolname
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_roles role ON role.oid = procedure.proowner
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'worldgraph_projection_repair_swap'
      AND procedure.pronargs = 10
      AND procedure.proargtypes[0] = 'uuid'::regtype
      AND procedure.proargtypes[1] = 'uuid'::regtype
      AND procedure.proargtypes[2] = 'text'::regtype
      AND procedure.proargtypes[3] = 'uuid'::regtype
      AND procedure.proargtypes[4] = 'uuid'::regtype
      AND procedure.proargtypes[5] = 'uuid'::regtype
      AND procedure.proargtypes[6] = 'uuid'::regtype
      AND procedure.proargtypes[7] = 'uuid'::regtype
      AND procedure.proargtypes[8] = 'uuid'::regtype
      AND procedure.proargtypes[9] = 'uuid'::regtype
      AND pg_catalog.pg_has_role(
        session_user, pg_catalog.pg_get_userbyid(procedure.proowner), 'MEMBER'
      )
  )
  AND EXISTS (
    SELECT 1 FROM public.projection_replay_runs replay
    WHERE replay.id = NULLIF(current_setting('worldgraph.repair_run_id', true), '')::uuid
      AND replay.world_id = checked_world_id
      AND replay.status = 'succeeded'::projection_replay_status
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_runtime_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.worldgraph_lock_world_compilation(NEW.world_id);
    IF NEW.state_revision <> 0 OR NEW.last_ledger_sequence <> 0
      OR NEW.last_event_sequence <> 0 OR NEW.ledger_anchored_at IS NOT NULL
      OR NEW.ledger_anchor_event_id IS NOT NULL OR NEW.anchor_artifact_hash IS NOT NULL
      OR NEW.projection_checksum IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.world_versions version
        JOIN public.world_compilation_runs run ON run.id = version.compilation_run_id
        WHERE version.id = NEW.active_world_version_id AND version.world_id = NEW.world_id
          AND version.status = 'staging'::world_version_status
          AND run.status = 'running'::world_compilation_status
          AND run.stage = 'seeding'::world_compilation_stage
      ) THEN
      RAISE EXCEPTION 'world runtime head may only begin unanchored in matching compilation'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world runtime heads cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.active_world_version_id IS DISTINCT FROM OLD.active_world_version_id
    OR NEW.ledger_schema_version IS DISTINCT FROM OLD.ledger_schema_version
    OR NEW.event_schema_version IS DISTINCT FROM OLD.event_schema_version
    OR NEW.projection_schema_version IS DISTINCT FROM OLD.projection_schema_version
    OR NEW.state_revision < OLD.state_revision
    OR NEW.last_ledger_sequence < OLD.last_ledger_sequence
    OR NEW.last_event_sequence < OLD.last_event_sequence
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.ledger_anchored_at IS NOT NULL AND (
      NEW.ledger_anchored_at IS DISTINCT FROM OLD.ledger_anchored_at
      OR NEW.ledger_anchor_event_id IS DISTINCT FROM OLD.ledger_anchor_event_id
      OR NEW.anchor_artifact_hash IS DISTINCT FROM OLD.anchor_artifact_hash
    ))
    OR NOT public.worldgraph_command_write_is_open(NEW.world_id) THEN
    RAISE EXCEPTION 'world runtime head update is inconsistent or outside a command'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION worldgraph_protect_compiler_seed_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_version_id uuid;
  checked_world_id uuid;
  membership_record record;
  repair_write boolean;
  source_entity_type text;
  target_entity_type text;
BEGIN
  checked_world_id := COALESCE(NEW.world_id, OLD.world_id);
  repair_write := public.worldgraph_projection_repair_write_is_open(checked_world_id);
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '55000';
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT public.worldgraph_command_write_is_open(checked_world_id) AND NOT repair_write THEN
      RAISE EXCEPTION '% mutation requires the open command write gate', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'world_entities' THEN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.world_id IS DISTINCT FROM OLD.world_id
        OR NEW.logical_key IS DISTINCT FROM OLD.logical_key
        OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
        OR NEW.entity_schema_version IS DISTINCT FROM OLD.entity_schema_version
        OR NEW.created_world_version_id IS DISTINCT FROM OLD.created_world_version_id
        OR NEW.retired_world_version_id IS DISTINCT FROM OLD.retired_world_version_id
        OR (NOT repair_write AND NEW.row_version <> OLD.row_version + 1)
        OR NEW.row_version < 0 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'world entity command update changes immutable fields'
          USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'world_relationships' THEN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.world_id IS DISTINCT FROM OLD.world_id
        OR NEW.logical_key IS DISTINCT FROM OLD.logical_key
        OR NEW.relationship_type IS DISTINCT FROM OLD.relationship_type
        OR NEW.source_entity_id IS DISTINCT FROM OLD.source_entity_id
        OR NEW.target_entity_id IS DISTINCT FROM OLD.target_entity_id
        OR NEW.relationship_schema_version IS DISTINCT FROM OLD.relationship_schema_version
        OR NEW.created_world_version_id IS DISTINCT FROM OLD.created_world_version_id
        OR NEW.retired_world_version_id IS DISTINCT FROM OLD.retired_world_version_id
        OR (NOT repair_write AND NEW.row_version <> OLD.row_version + 1)
        OR NEW.row_version < 0 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'world relationship command update changes immutable fields'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      IF NEW.world_id IS DISTINCT FROM OLD.world_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
        OR NEW.control_scope IS DISTINCT FROM OLD.control_scope
        OR NEW.granted_world_version_id IS DISTINCT FROM OLD.granted_world_version_id
        OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'controller command update is invalid' USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME IN ('world_entities', 'world_relationships') THEN
    checked_version_id := NEW.created_world_version_id;
    IF NEW.retired_world_version_id IS NOT NULL OR NEW.row_version <> 0 THEN
      RAISE EXCEPTION 'compiler seed rows must begin active at row version zero'
        USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'world_relationships' THEN
      SELECT entity_type INTO source_entity_type FROM public.world_entities
      WHERE world_id = NEW.world_id AND id = NEW.source_entity_id;
      SELECT entity_type INTO target_entity_type FROM public.world_entities
      WHERE world_id = NEW.world_id AND id = NEW.target_entity_id;
      IF source_entity_type IS NOT NULL AND target_entity_type IS NOT NULL AND NOT (
        (NEW.relationship_type = 'account_controls' AND source_entity_type = 'account_principal'
          AND target_entity_type = 'player_character')
        OR (NEW.relationship_type = 'connected_to' AND source_entity_type = 'district'
          AND target_entity_type = 'district')
        OR (NEW.relationship_type = 'cooperates_with' AND source_entity_type = 'organization'
          AND target_entity_type = 'organization')
        OR (NEW.relationship_type = 'governs' AND source_entity_type = 'institution'
          AND target_entity_type IN ('district', 'organization'))
        OR (NEW.relationship_type = 'instantiates' AND source_entity_type = 'player_character'
          AND target_entity_type = 'actor_blueprint')
        OR (NEW.relationship_type = 'located_in'
          AND source_entity_type IN ('actor_blueprint','institution','organization','player_character')
          AND target_entity_type = 'district')
        OR (NEW.relationship_type = 'member_of'
          AND source_entity_type IN ('actor_blueprint','player_character')
          AND target_entity_type = 'organization')
        OR (NEW.relationship_type = 'participates_in' AND source_entity_type = 'organization'
          AND target_entity_type = 'institution')
        OR (NEW.relationship_type = 'rivals' AND source_entity_type = 'organization'
          AND target_entity_type = 'organization')
        OR (NEW.relationship_type = 'supplies' AND source_entity_type = 'organization'
          AND target_entity_type IN ('district','institution','organization'))
        OR (NEW.relationship_type = 'uses_primitive' AND target_entity_type = 'primitive_instance')
      ) THEN
        RAISE EXCEPTION 'relationship endpoints do not match relationship type %', NEW.relationship_type
          USING ERRCODE = '23514', CONSTRAINT = 'world_relationships_endpoint_types_valid';
      END IF;
    END IF;
  ELSE
    checked_version_id := NEW.granted_world_version_id;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'compiler controller bindings must begin active' USING ERRCODE = '55000';
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
    SELECT status, role INTO membership_record FROM public.world_memberships
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
CREATE FUNCTION worldgraph_append_compiled_genesis(
  checked_world_id uuid,
  checked_world_version_id uuid,
  checked_compilation_run_id uuid,
  genesis_command_id uuid,
  genesis_event_id uuid,
  genesis_ledger_entry_id uuid,
  genesis_outbox_message_id uuid
)
RETURNS TABLE (
  event_hash bytea,
  ledger_entry_hash bytea,
  projection_checksum bytea,
  resulting_state_revision bigint,
  world_event_sequence bigint,
  ledger_sequence bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  source_record record;
  anchor_time timestamptz;
  payload_value jsonb;
  metadata_value jsonb;
  checksum_value bytea;
  event_hash_value bytea;
  entry_hash_value bytea;
  zero_hash bytea := decode(repeat('00', 32), 'hex');
BEGIN
  IF genesis_command_id IN (
    genesis_event_id, genesis_ledger_entry_id, genesis_outbox_message_id
  ) OR genesis_event_id IN (genesis_ledger_entry_id, genesis_outbox_message_id)
    OR genesis_ledger_entry_id = genesis_outbox_message_id THEN
    RAISE EXCEPTION 'compiled genesis record identifiers must be distinct'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.worldgraph_lock_world_compilation(checked_world_id);
  SELECT runtime.active_world_version_id, runtime.state_revision,
    runtime.ledger_anchored_at, version.version_number, version.artifact_hash,
    version.compilation_run_id, version.status AS version_status,
    run.status AS run_status, run.stage AS run_stage,
    (SELECT count(*) FROM public.world_entities entity
      WHERE entity.world_id = checked_world_id
        AND entity.retired_world_version_id IS NULL) AS entity_count,
    (SELECT count(*) FROM public.world_relationships relationship
      WHERE relationship.world_id = checked_world_id
        AND relationship.retired_world_version_id IS NULL) AS relationship_count,
    (SELECT count(*) FROM public.world_entity_controllers controller
      WHERE controller.world_id = checked_world_id
        AND controller.revoked_at IS NULL) AS controller_count
  INTO source_record
  FROM public.world_runtime_heads runtime
  JOIN public.world_versions version
    ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
  JOIN public.world_compilation_runs run
    ON run.id = version.compilation_run_id AND run.world_id = version.world_id
  WHERE runtime.world_id = checked_world_id
  FOR UPDATE OF runtime, version, run;

  IF NOT FOUND OR source_record.active_world_version_id <> checked_world_version_id
    OR source_record.compilation_run_id <> checked_compilation_run_id
    OR source_record.version_status <> 'staging'::world_version_status
    OR source_record.run_status <> 'running'::world_compilation_status
    OR source_record.run_stage <> 'seeding'::world_compilation_stage
    OR source_record.state_revision <> 0 OR source_record.ledger_anchored_at IS NOT NULL THEN
    RAISE EXCEPTION 'compiled genesis source is not the matching unanchored seeding world'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.world_ledger_heads(world_id) VALUES (checked_world_id)
  ON CONFLICT (world_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public.world_ledger_heads head
    WHERE head.world_id = checked_world_id AND head.anchored_at IS NULL
      AND head.next_event_sequence = 1 AND head.next_ledger_sequence = 1
      AND head.last_entry_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'compiled genesis requires a pristine unanchored ledger head'
      USING ERRCODE = '55000';
  END IF;

  anchor_time := date_trunc('milliseconds', transaction_timestamp());
  checksum_value := public.worldgraph_projection_checksum(checked_world_id, 1);
  payload_value := jsonb_build_object(
    'activeWorldVersionId', checked_world_version_id::text,
    'artifactHash', encode(source_record.artifact_hash, 'hex'),
    'compilationRunId', checked_compilation_run_id::text,
    'projectionSchemaVersions', jsonb_build_object(
      'controllers', 1, 'entities', 1, 'relationships', 1, 'runtimeHead', 1
    ),
    'rowCounts', jsonb_build_object(
      'controllers', source_record.controller_count::text,
      'entities', source_record.entity_count::text,
      'relationships', source_record.relationship_count::text
    ),
    'stateChecksum', encode(checksum_value, 'hex'),
    'worldVersionNumber', source_record.version_number::text
  );
  metadata_value := jsonb_build_object(
    'actor', jsonb_build_object('actorId', 'worldgraph:compiler', 'actorType', 'system'),
    'authorizationRuleId', 'system.compiler.genesis',
    'causationId', checked_compilation_run_id::text,
    'commandSchemaVersion', 1,
    'commandType', 'WorldCompiledGenesisV1',
    'correlationId', genesis_command_id::text,
    'overrideId', NULL,
    'payloadClassification', 'member'
  );

  INSERT INTO public.command_records(
    id, world_id, command_type, command_schema_version, actor_type, actor_id,
    payload, payload_hash, payload_classification, idempotency_key, request_hash,
    expected_world_version, expected_state_revision, correlation_id, causation_id,
    requested_at
  ) VALUES (
    genesis_command_id, checked_world_id, 'WorldCompiledGenesisV1', 1,
    'system', 'worldgraph:compiler', payload_value,
    extensions.digest(convert_to(public.worldgraph_canonical_jsonb(payload_value), 'UTF8'), 'sha256'),
    'member', 'm06-compiled-' || checked_world_version_id::text,
    extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
      'commandType', 'WorldCompiledGenesisV1', 'payload', payload_value,
      'worldId', checked_world_id::text
    )), 'UTF8'), 'sha256'),
    source_record.version_number, 0, genesis_command_id, checked_compilation_run_id,
    anchor_time
  );
  PERFORM public.worldgraph_open_command_write(genesis_command_id, checked_world_id);

  event_hash_value := public.worldgraph_domain_event_hash_v1(
    genesis_event_id, checked_world_id, 1, genesis_command_id, 0,
    'world', checked_world_id::text, 1, 'WorldCompiledGenesisV1', 1,
    payload_value, metadata_value, anchor_time, anchor_time, 1
  );
  INSERT INTO public.domain_events(
    id, world_id, world_event_sequence, command_id, event_ordinal,
    aggregate_type, aggregate_id, aggregate_version, event_type,
    event_schema_version, payload, metadata, event_hash, occurred_at,
    recorded_at, resulting_state_revision
  ) VALUES (
    genesis_event_id, checked_world_id, 1, genesis_command_id, 0,
    'world', checked_world_id::text, 1, 'WorldCompiledGenesisV1', 1,
    payload_value, metadata_value, event_hash_value, anchor_time, anchor_time, 1
  );

  entry_hash_value := public.worldgraph_ledger_entry_hash_v1(
    genesis_ledger_entry_id, checked_world_id, 1, 'domain_event',
    genesis_command_id, genesis_event_id, 'system', 'worldgraph:compiler',
    'WORLD_COMPILED_GENESIS', jsonb_build_object(
      'eventType', 'WorldCompiledGenesisV1',
      'stateChecksum', encode(checksum_value, 'hex')
    ), zero_hash, anchor_time
  );
  INSERT INTO public.ledger_entries(
    id, world_id, ledger_sequence, entry_kind, command_id, event_id,
    actor_type, actor_id, public_summary_code, redacted_details,
    previous_hash, entry_hash, recorded_at
  ) VALUES (
    genesis_ledger_entry_id, checked_world_id, 1, 'domain_event',
    genesis_command_id, genesis_event_id, 'system', 'worldgraph:compiler',
    'WORLD_COMPILED_GENESIS', jsonb_build_object(
      'eventType', 'WorldCompiledGenesisV1',
      'stateChecksum', encode(checksum_value, 'hex')
    ), zero_hash, entry_hash_value, anchor_time
  );
  UPDATE public.world_ledger_heads
  SET anchored_at = anchor_time,
      anchor_event_id = genesis_event_id,
      anchor_artifact_hash = source_record.artifact_hash,
      updated_at = greatest(updated_at, anchor_time)
  WHERE world_id = checked_world_id;
  UPDATE public.world_runtime_heads
  SET state_revision = 1,
      last_event_sequence = 1,
      last_ledger_sequence = 1,
      ledger_anchored_at = anchor_time,
      ledger_anchor_event_id = genesis_event_id,
      anchor_artifact_hash = source_record.artifact_hash,
      projection_checksum = checksum_value,
      updated_at = greatest(updated_at, anchor_time)
  WHERE world_id = checked_world_id;
  INSERT INTO public.projection_checkpoints(
    world_id, projection_name, projection_schema_version,
    last_event_sequence, checksum, status, updated_at
  ) VALUES (
    checked_world_id, 'world_graph', 1, 1, checksum_value, 'current', anchor_time
  );
  INSERT INTO public.outbox_messages(
    id, world_id, event_id, message_type, message_schema_version,
    payload, status, attempts, available_at, created_at
  ) VALUES (
    genesis_outbox_message_id, checked_world_id, genesis_event_id,
    'DomainEventReferenceV1', 1,
    jsonb_build_object(
      'eventId', genesis_event_id::text,
      'eventType', 'WorldCompiledGenesisV1',
      'worldEventSequence', '1',
      'worldId', checked_world_id::text
    ), 'pending', 0, anchor_time, anchor_time
  );
  INSERT INTO public.world_history_entries(
    world_id, ledger_sequence, command_id, event_id, event_type, occurred_at,
    category, title_key, summary_args, actor_type, actor_id, target_type,
    target_id, visibility, correlation_id, resulting_state_revision
  ) VALUES (
    checked_world_id, 1, genesis_command_id, genesis_event_id,
    'WorldCompiledGenesisV1', anchor_time, 'genesis',
    'history.genesis.compiled', jsonb_build_object(
      'artifactHash', encode(source_record.artifact_hash, 'hex'),
      'controllers', source_record.controller_count::text,
      'entities', source_record.entity_count::text,
      'relationships', source_record.relationship_count::text,
      'worldVersionNumber', source_record.version_number::text
    ), 'system', 'worldgraph:compiler', 'world_version', checked_world_version_id::text,
    'member', genesis_command_id, 1
  );
  UPDATE public.command_records
  SET status = 'accepted', authorization_rule_id = 'system.compiler.genesis',
      decided_at = anchor_time, resulting_state_revision = 1,
      response_summary = jsonb_build_object(
        'commandId', genesis_command_id::text,
        'eventIds', jsonb_build_array(genesis_event_id::text),
        'eventSequenceRange', jsonb_build_object('from', '1', 'to', '1'),
        'ledgerSequenceRange', jsonb_build_object('from', '1', 'to', '1'),
        'resultingStateRevision', '1', 'schemaVersion', 1, 'status', 'accepted'
      )
  WHERE id = genesis_command_id;

  RETURN QUERY SELECT event_hash_value, entry_hash_value, checksum_value,
    1::bigint, 1::bigint, 1::bigint;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_append_compiled_genesis(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_projection_repair_swap(
  checked_replay_run_id uuid,
  checked_world_id uuid,
  checked_reason text,
  requested_by_actor uuid,
  approved_by_first uuid,
  approved_by_second uuid,
  repair_command_id uuid,
  repair_event_id uuid,
  repair_ledger_entry_id uuid,
  repair_outbox_message_id uuid
)
RETURNS TABLE (
  event_hash bytea,
  ledger_entry_hash bytea,
  projection_checksum bytea,
  resulting_state_revision bigint,
  world_event_sequence bigint,
  ledger_sequence bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  source_record record;
  anchor_time timestamptz;
  actual_checksum bytea;
  replay_checksum_value bytea;
  final_checksum bytea;
  payload_value jsonb;
  metadata_value jsonb;
  event_hash_value bytea;
  entry_hash_value bytea;
  next_state_revision bigint;
  next_event_sequence bigint;
  next_ledger_sequence bigint;
  next_aggregate_version bigint;
BEGIN
  IF approved_by_first = approved_by_second THEN
    RAISE EXCEPTION 'projection repair requires two distinct approvers'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(checked_reason)) NOT BETWEEN 1 AND 500
    OR checked_reason <> btrim(checked_reason) OR checked_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'projection repair reason is invalid' USING ERRCODE = '22023';
  END IF;
  IF repair_command_id IN (
    repair_event_id, repair_ledger_entry_id, repair_outbox_message_id
  ) OR repair_event_id IN (repair_ledger_entry_id, repair_outbox_message_id)
    OR repair_ledger_entry_id = repair_outbox_message_id THEN
    RAISE EXCEPTION 'projection repair record identifiers must be distinct'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users requesting_actor
    JOIN public.users first_approver ON first_approver.id = approved_by_first
    JOIN public.users second_approver ON second_approver.id = approved_by_second
    WHERE requesting_actor.id = requested_by_actor
      AND requesting_actor.status = 'active'::user_status
      AND requesting_actor.platform_role = 'platform_admin'::platform_role
      AND first_approver.status = 'active'::user_status
      AND second_approver.status = 'active'::user_status
      AND first_approver.platform_role = 'platform_admin'::platform_role
      AND second_approver.platform_role = 'platform_admin'::platform_role
  ) THEN
    RAISE EXCEPTION 'projection repair actor and approvers must be active platform administrators'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.worldgraph_lock_world_compilation(checked_world_id);
  SELECT replay.status AS replay_status, replay.projection_name,
    replay.target_schema_version, replay.from_event_sequence,
    replay.to_event_sequence, replay.source_checksum, replay.replay_checksum,
    replay.reason, runtime.state_revision, runtime.last_event_sequence,
    runtime.last_ledger_sequence, runtime.projection_checksum AS runtime_checksum,
    version.version_number, ledger.next_event_sequence, ledger.next_ledger_sequence,
    ledger.last_entry_hash
  INTO source_record
  FROM public.projection_replay_runs replay
  JOIN public.world_runtime_heads runtime ON runtime.world_id = replay.world_id
  JOIN public.world_versions version
    ON version.id = runtime.active_world_version_id AND version.world_id = runtime.world_id
  JOIN public.world_ledger_heads ledger ON ledger.world_id = runtime.world_id
  WHERE replay.id = checked_replay_run_id AND replay.world_id = checked_world_id
  FOR UPDATE OF replay, runtime, ledger;
  IF NOT FOUND OR source_record.replay_status <> 'succeeded'::projection_replay_status
    OR source_record.projection_name <> 'world_graph' OR source_record.target_schema_version <> 1
    OR source_record.replay_checksum IS NULL
    OR source_record.reason <> checked_reason
    OR source_record.runtime_checksum IS DISTINCT FROM source_record.source_checksum
    OR source_record.to_event_sequence <> source_record.last_event_sequence
    OR source_record.next_event_sequence <> source_record.last_event_sequence + 1
    OR source_record.next_ledger_sequence <> source_record.last_ledger_sequence + 1 THEN
    RAISE EXCEPTION 'projection repair source/head changed or replay is not eligible'
      USING ERRCODE = '55000';
  END IF;

  replay_checksum_value := public.worldgraph_shadow_projection_checksum(
    checked_replay_run_id, source_record.state_revision
  );
  IF replay_checksum_value IS DISTINCT FROM source_record.replay_checksum THEN
    RAISE EXCEPTION 'durable shadow rows do not match the completed replay checksum'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    (SELECT id, logical_key::text, entity_type, entity_schema_version
     FROM public.world_entities
     WHERE world_id = checked_world_id AND retired_world_version_id IS NULL
     EXCEPT
     SELECT entity_id, logical_key, entity_type, entity_schema_version
     FROM public.shadow_world_entities WHERE replay_run_id = checked_replay_run_id)
    UNION ALL
    (SELECT entity_id, logical_key, entity_type, entity_schema_version
     FROM public.shadow_world_entities WHERE replay_run_id = checked_replay_run_id
     EXCEPT
     SELECT id, logical_key::text, entity_type, entity_schema_version
     FROM public.world_entities
     WHERE world_id = checked_world_id AND retired_world_version_id IS NULL)
  ) OR EXISTS (
    (SELECT id, logical_key::text, relationship_type, source_entity_id,
      target_entity_id, relationship_schema_version
     FROM public.world_relationships
     WHERE world_id = checked_world_id AND retired_world_version_id IS NULL
     EXCEPT
     SELECT relationship_id, logical_key, relationship_type, source_entity_id,
      target_entity_id, relationship_schema_version
     FROM public.shadow_world_relationships WHERE replay_run_id = checked_replay_run_id)
    UNION ALL
    (SELECT relationship_id, logical_key, relationship_type, source_entity_id,
      target_entity_id, relationship_schema_version
     FROM public.shadow_world_relationships WHERE replay_run_id = checked_replay_run_id
     EXCEPT
     SELECT id, logical_key::text, relationship_type, source_entity_id,
      target_entity_id, relationship_schema_version
     FROM public.world_relationships
     WHERE world_id = checked_world_id AND retired_world_version_id IS NULL)
  ) OR EXISTS (
    (SELECT controller.user_id, controller.entity_id, controller.control_scope,
      character.logical_key::text, account.state ->> 'principalKey'
     FROM public.world_entity_controllers controller
     JOIN public.world_entities character
       ON character.world_id = controller.world_id AND character.id = controller.entity_id
     JOIN public.world_relationships edge
       ON edge.world_id = controller.world_id AND edge.target_entity_id = controller.entity_id
       AND edge.relationship_type = 'account_controls' AND edge.retired_world_version_id IS NULL
     JOIN public.world_entities account
       ON account.world_id = edge.world_id AND account.id = edge.source_entity_id
     WHERE controller.world_id = checked_world_id AND controller.revoked_at IS NULL
     EXCEPT
     SELECT user_id, entity_id, control_scope, entity_logical_key, principal_key
     FROM public.shadow_world_entity_controllers WHERE replay_run_id = checked_replay_run_id)
    UNION ALL
    (SELECT user_id, entity_id, control_scope, entity_logical_key, principal_key
     FROM public.shadow_world_entity_controllers WHERE replay_run_id = checked_replay_run_id
     EXCEPT
     SELECT controller.user_id, controller.entity_id, controller.control_scope,
       character.logical_key::text, account.state ->> 'principalKey'
     FROM public.world_entity_controllers controller
     JOIN public.world_entities character
       ON character.world_id = controller.world_id AND character.id = controller.entity_id
     JOIN public.world_relationships edge
       ON edge.world_id = controller.world_id AND edge.target_entity_id = controller.entity_id
       AND edge.relationship_type = 'account_controls' AND edge.retired_world_version_id IS NULL
     JOIN public.world_entities account
       ON account.world_id = edge.world_id AND account.id = edge.source_entity_id
     WHERE controller.world_id = checked_world_id AND controller.revoked_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'shadow repair identity sets differ from the active projection'
      USING ERRCODE = '55000';
  END IF;

  actual_checksum := public.worldgraph_projection_checksum(
    checked_world_id, source_record.state_revision
  );
  IF actual_checksum = replay_checksum_value THEN
    RAISE EXCEPTION 'projection repair requires an actual live divergence'
      USING ERRCODE = '55000';
  END IF;
  next_state_revision := source_record.state_revision + 1;
  next_event_sequence := source_record.last_event_sequence + 1;
  next_ledger_sequence := source_record.last_ledger_sequence + 1;
  SELECT current_version + 1 INTO next_aggregate_version
  FROM public.aggregate_stream_heads
  WHERE world_id = checked_world_id AND aggregate_type = 'world'
    AND aggregate_id = checked_world_id::text
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'projection repair requires the world genesis aggregate stream'
      USING ERRCODE = '55000';
  END IF;

  anchor_time := date_trunc('milliseconds', transaction_timestamp());
  final_checksum := public.worldgraph_shadow_projection_checksum(
    checked_replay_run_id, next_state_revision
  );
  payload_value := jsonb_build_object(
    'fromChecksum', encode(actual_checksum, 'hex'),
    'projectionName', 'world_graph',
    'reasonCode', 'PROJECTION_REPAIR',
    'toChecksum', encode(final_checksum, 'hex')
  );
  metadata_value := jsonb_build_object(
    'actor', jsonb_build_object(
      'actorId', requested_by_actor::text, 'actorType', 'platform_admin'
    ),
    'authorizationRuleId', 'operations.projection.repair',
    'causationId', checked_replay_run_id::text,
    'commandSchemaVersion', 1,
    'commandType', 'ProjectionRepairAnchoredV1',
    'correlationId', repair_command_id::text,
    'overrideId', NULL,
    'payloadClassification', 'private'
  );
  PERFORM set_config('worldgraph.repair_run_id', checked_replay_run_id::text, true);
  INSERT INTO public.command_records(
    id, world_id, command_type, command_schema_version, actor_type, actor_id,
    payload, payload_hash, payload_classification, idempotency_key, request_hash,
    expected_world_version, expected_state_revision, correlation_id, causation_id,
    requested_at
  ) VALUES (
    repair_command_id, checked_world_id, 'ProjectionRepairAnchoredV1', 1,
    'platform_admin', requested_by_actor::text, payload_value,
    extensions.digest(convert_to(public.worldgraph_canonical_jsonb(payload_value), 'UTF8'), 'sha256'),
    'private', 'm06-repair-' || checked_replay_run_id::text,
    extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
      'approvedByFirst', approved_by_first::text,
      'approvedBySecond', approved_by_second::text,
      'requestedByActor', requested_by_actor::text,
      'payload', payload_value,
      'replayRunId', checked_replay_run_id::text,
      'worldId', checked_world_id::text
    )), 'UTF8'), 'sha256'),
    source_record.version_number, source_record.state_revision,
    repair_command_id, checked_replay_run_id, anchor_time
  );
  PERFORM public.worldgraph_open_command_write(repair_command_id, checked_world_id);

  UPDATE public.world_entities live
  SET state = shadow.state, row_version = shadow.row_version, updated_at = anchor_time
  FROM public.shadow_world_entities shadow
  WHERE shadow.replay_run_id = checked_replay_run_id
    AND live.world_id = checked_world_id AND live.id = shadow.entity_id;
  UPDATE public.world_relationships live
  SET attributes = shadow.attributes, row_version = shadow.row_version,
      updated_at = anchor_time
  FROM public.shadow_world_relationships shadow
  WHERE shadow.replay_run_id = checked_replay_run_id
    AND live.world_id = checked_world_id AND live.id = shadow.relationship_id;
  IF public.worldgraph_projection_checksum(
    checked_world_id, source_record.state_revision
  ) IS DISTINCT FROM replay_checksum_value THEN
    RAISE EXCEPTION 'shadow projection swap did not reproduce the replay checksum'
      USING ERRCODE = '55000';
  END IF;

  event_hash_value := public.worldgraph_domain_event_hash_v1(
    repair_event_id, checked_world_id, next_event_sequence, repair_command_id, 0,
    'world', checked_world_id::text, next_aggregate_version,
    'ProjectionRepairAnchoredV1', 1, payload_value, metadata_value,
    anchor_time, anchor_time, next_state_revision
  );
  INSERT INTO public.domain_events(
    id, world_id, world_event_sequence, command_id, event_ordinal,
    aggregate_type, aggregate_id, aggregate_version, event_type,
    event_schema_version, payload, metadata, event_hash, occurred_at,
    recorded_at, resulting_state_revision
  ) VALUES (
    repair_event_id, checked_world_id, next_event_sequence, repair_command_id, 0,
    'world', checked_world_id::text, next_aggregate_version,
    'ProjectionRepairAnchoredV1', 1, payload_value, metadata_value,
    event_hash_value, anchor_time, anchor_time, next_state_revision
  );
  entry_hash_value := public.worldgraph_ledger_entry_hash_v1(
    repair_ledger_entry_id, checked_world_id, next_ledger_sequence, 'repair_anchor',
    repair_command_id, repair_event_id, 'platform_admin', requested_by_actor::text,
    'PROJECTION_REPAIR_ANCHORED', jsonb_build_object(
      'approvedByFirst', approved_by_first::text,
      'approvedBySecond', approved_by_second::text,
      'executedByActor', requested_by_actor::text,
      'projectionName', 'world_graph',
      'replayRunId', checked_replay_run_id::text
    ), source_record.last_entry_hash, anchor_time
  );
  INSERT INTO public.ledger_entries(
    id, world_id, ledger_sequence, entry_kind, command_id, event_id,
    actor_type, actor_id, public_summary_code, redacted_details,
    previous_hash, entry_hash, recorded_at
  ) VALUES (
    repair_ledger_entry_id, checked_world_id, next_ledger_sequence, 'repair_anchor',
    repair_command_id, repair_event_id, 'platform_admin', requested_by_actor::text,
    'PROJECTION_REPAIR_ANCHORED', jsonb_build_object(
      'approvedByFirst', approved_by_first::text,
      'approvedBySecond', approved_by_second::text,
      'executedByActor', requested_by_actor::text,
      'projectionName', 'world_graph',
      'replayRunId', checked_replay_run_id::text
    ), source_record.last_entry_hash, entry_hash_value, anchor_time
  );
  UPDATE public.world_runtime_heads
  SET state_revision = next_state_revision,
      last_event_sequence = next_event_sequence,
      last_ledger_sequence = next_ledger_sequence,
      projection_checksum = final_checksum,
      updated_at = anchor_time
  WHERE world_id = checked_world_id;
  UPDATE public.projection_checkpoints
  SET last_event_sequence = next_event_sequence, checksum = final_checksum,
      status = 'current', updated_at = anchor_time
  WHERE world_id = checked_world_id AND projection_name = 'world_graph';
  INSERT INTO public.outbox_messages(
    id, world_id, event_id, message_type, message_schema_version,
    payload, status, attempts, available_at, created_at
  ) VALUES (
    repair_outbox_message_id, checked_world_id, repair_event_id,
    'DomainEventReferenceV1', 1,
    jsonb_build_object(
      'eventId', repair_event_id::text,
      'eventType', 'ProjectionRepairAnchoredV1',
      'worldEventSequence', next_event_sequence::text,
      'worldId', checked_world_id::text
    ), 'pending', 0, anchor_time, anchor_time
  );
  INSERT INTO public.world_history_entries(
    world_id, ledger_sequence, command_id, event_id, event_type, occurred_at,
    category, title_key, summary_args, actor_type, actor_id, target_type,
    target_id, visibility, correlation_id, resulting_state_revision
  ) VALUES (
    checked_world_id, next_ledger_sequence, repair_command_id, repair_event_id,
    'ProjectionRepairAnchoredV1', anchor_time, 'repair',
    'history.repair.projection_anchored', jsonb_build_object(
      'fromChecksum', encode(actual_checksum, 'hex'),
      'projectionName', 'world_graph',
      'reasonCode', 'PROJECTION_REPAIR',
      'toChecksum', encode(final_checksum, 'hex')
    ), 'platform_admin', requested_by_actor::text, 'projection', 'world_graph',
    'operator', repair_command_id, next_state_revision
  );
  UPDATE public.command_records
  SET status = 'accepted', authorization_rule_id = 'operations.projection.repair',
      decided_at = anchor_time, resulting_state_revision = next_state_revision,
      response_summary = jsonb_build_object(
        'commandId', repair_command_id::text,
        'eventIds', jsonb_build_array(repair_event_id::text),
        'eventSequenceRange', jsonb_build_object(
          'from', next_event_sequence::text, 'to', next_event_sequence::text
        ),
        'ledgerSequenceRange', jsonb_build_object(
          'from', next_ledger_sequence::text, 'to', next_ledger_sequence::text
        ),
        'resultingStateRevision', next_state_revision::text,
        'schemaVersion', 1, 'status', 'accepted'
      )
  WHERE id = repair_command_id;

  RETURN QUERY SELECT event_hash_value, entry_hash_value, final_checksum,
    next_state_revision, next_event_sequence, next_ledger_sequence;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_projection_repair_swap(
  uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_command_terminal(checked_command_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_record record;
  runtime_record record;
  ledger_record record;
  checkpoint_record record;
  event_count bigint;
  linked_event_count bigint;
  outbox_event_count bigint;
  event_min_sequence bigint;
  event_max_sequence bigint;
  events_match_revision boolean;
  ledger_count bigint;
  accepted_marker_count bigint;
  rejected_entry_count bigint;
  ledger_min_sequence bigint;
  ledger_max_sequence bigint;
  calculated_checksum bytea;
BEGIN
  SELECT * INTO command_record FROM public.command_records WHERE id = checked_command_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF command_record.status = 'received'::command_record_status THEN
    IF command_record.write_gate_opened_at IS NOT NULL THEN
      RAISE EXCEPTION 'an opened world command must become terminal before commit'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;
  IF command_record.world_id IS NULL THEN
    RETURN;
  END IF;
  IF command_record.write_gate_opened_at IS NULL
    OR command_record.opened_state_revision IS NULL
    OR command_record.opened_ledger_sequence IS NULL
    OR command_record.opened_event_sequence IS NULL THEN
    RAISE EXCEPTION 'terminal world command is missing its owner-written gate snapshot'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO runtime_record FROM public.world_runtime_heads
  WHERE world_id = command_record.world_id;
  SELECT * INTO ledger_record FROM public.world_ledger_heads
  WHERE world_id = command_record.world_id;
  SELECT * INTO checkpoint_record FROM public.projection_checkpoints
  WHERE world_id = command_record.world_id AND projection_name = 'world_graph';
  IF runtime_record.world_id IS NULL
    OR ledger_record.world_id IS NULL
    OR checkpoint_record.world_id IS NULL THEN
    RAISE EXCEPTION 'terminal command requires runtime, ledger and projection heads'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*), min(event.world_event_sequence), max(event.world_event_sequence),
    bool_and(event.resulting_state_revision = command_record.resulting_state_revision),
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.ledger_entries entry
      WHERE entry.event_id = event.id AND entry.command_id = command_record.id
    )),
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.outbox_messages message
      WHERE message.event_id = event.id
        AND message.message_type = 'DomainEventReferenceV1'
    ))
  INTO event_count, event_min_sequence, event_max_sequence, events_match_revision,
    linked_event_count, outbox_event_count
  FROM public.domain_events event
  WHERE event.command_id = command_record.id;

  SELECT count(*), min(entry.ledger_sequence), max(entry.ledger_sequence),
    count(*) FILTER (
      WHERE entry.entry_kind = 'command_accepted'::ledger_entry_kind
        AND entry.event_id IS NULL
    ),
    count(*) FILTER (
      WHERE entry.entry_kind = 'command_rejected'::ledger_entry_kind
        AND entry.event_id IS NULL
    )
  INTO ledger_count, ledger_min_sequence, ledger_max_sequence,
    accepted_marker_count, rejected_entry_count
  FROM public.ledger_entries entry
  WHERE entry.command_id = command_record.id;

  IF command_record.status = 'accepted'::command_record_status THEN
    IF command_record.resulting_state_revision <> command_record.opened_state_revision + 1
      OR event_count < 1
      OR events_match_revision IS NOT TRUE
      OR linked_event_count <> event_count
      OR outbox_event_count <> event_count
      OR rejected_entry_count <> 0
      OR ledger_count NOT IN (event_count, event_count + 1)
      OR accepted_marker_count <> ledger_count - event_count
      OR event_min_sequence <> command_record.opened_event_sequence + 1
      OR event_max_sequence <> command_record.opened_event_sequence + event_count
      OR ledger_min_sequence <> command_record.opened_ledger_sequence + 1
      OR ledger_max_sequence <> command_record.opened_ledger_sequence + ledger_count THEN
      RAISE EXCEPTION 'accepted command event, ledger or outbox set is not exact and contiguous'
        USING ERRCODE = '55000';
    END IF;
    IF runtime_record.state_revision <> command_record.resulting_state_revision
      OR runtime_record.last_event_sequence <> command_record.opened_event_sequence + event_count
      OR runtime_record.last_ledger_sequence <> command_record.opened_ledger_sequence + ledger_count
      OR runtime_record.last_event_sequence <> ledger_record.next_event_sequence - 1
      OR runtime_record.last_ledger_sequence <> ledger_record.next_ledger_sequence - 1
      OR checkpoint_record.last_event_sequence <> runtime_record.last_event_sequence
      OR runtime_record.projection_checksum IS DISTINCT FROM checkpoint_record.checksum THEN
      RAISE EXCEPTION 'accepted command did not publish consistent runtime/ledger heads'
        USING ERRCODE = '55000';
    END IF;
    calculated_checksum := public.worldgraph_projection_checksum(
      command_record.world_id, command_record.resulting_state_revision
    );
    IF calculated_checksum IS DISTINCT FROM runtime_record.projection_checksum THEN
      RAISE EXCEPTION 'accepted command projection checksum does not match live state'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF event_count <> 0
      OR ledger_count <> 1
      OR accepted_marker_count <> 0
      OR rejected_entry_count <> 1
      OR ledger_min_sequence <> command_record.opened_ledger_sequence + 1
      OR ledger_max_sequence <> command_record.opened_ledger_sequence + 1 THEN
      RAISE EXCEPTION 'rejected or failed command must append exactly one rejection entry'
        USING ERRCODE = '55000';
    END IF;
    IF command_record.opened_projection_checksum IS NULL
      OR runtime_record.state_revision <> command_record.opened_state_revision
      OR runtime_record.last_event_sequence <> command_record.opened_event_sequence
      OR runtime_record.last_ledger_sequence <> command_record.opened_ledger_sequence + 1
      OR runtime_record.last_event_sequence <> ledger_record.next_event_sequence - 1
      OR runtime_record.last_ledger_sequence <> ledger_record.next_ledger_sequence - 1
      OR checkpoint_record.last_event_sequence <> command_record.opened_event_sequence
      OR runtime_record.projection_checksum IS DISTINCT FROM command_record.opened_projection_checksum
      OR checkpoint_record.checksum IS DISTINCT FROM command_record.opened_projection_checksum THEN
      RAISE EXCEPTION 'rejected command changed event, state or projection authority'
        USING ERRCODE = '55000';
    END IF;
    calculated_checksum := public.worldgraph_projection_checksum(
      command_record.world_id, command_record.opened_state_revision
    );
    IF calculated_checksum IS DISTINCT FROM command_record.opened_projection_checksum THEN
      RAISE EXCEPTION 'rejected command changed the live projection'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_command_terminal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.worldgraph_assert_command_terminal(NEW.id);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER command_records_require_atomic_terminal
  AFTER INSERT OR UPDATE ON command_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_command_terminal();
--> statement-breakpoint
-- Authoritative relational lifecycle writes are projections of the same accepted
-- command/event fact as the world ledger.  These checks are deferred because the
-- legacy route adapter opens and seals its command after applying the relational
-- change, but before commit.  A transaction-local command setting by itself is not
-- authority: the matching command must have opened in this transaction, be
-- accepted, and own exactly one target-bound lifecycle event.
CREATE FUNCTION worldgraph_world_requires_lifecycle_ledger(checked_world_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
RETURN EXISTS (
  SELECT 1 FROM public.worlds world
  WHERE world.id = checked_world_id AND world.lifecycle = 'active'::world_lifecycle
)
OR EXISTS (
  SELECT 1 FROM public.world_ledger_heads ledger WHERE ledger.world_id = checked_world_id
)
OR EXISTS (
  SELECT 1 FROM public.world_runtime_heads runtime WHERE runtime.world_id = checked_world_id
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_lifecycle_event_context(
  checked_world_id uuid,
  checked_command_type text,
  checked_event_type text,
  checked_aggregate_type text,
  checked_aggregate_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_setting text;
  event_context jsonb;
BEGIN
  command_setting := NULLIF(current_setting('worldgraph.command_id', true), '');
  IF command_setting IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'actorId', command.actor_id,
    'aggregateId', event.aggregate_id,
    'commandId', command.id,
    'eventId', event.id,
    'payload', event.payload
  )
  INTO event_context
  FROM public.command_records command
  JOIN public.domain_events event ON event.command_id = command.id
  WHERE command.id = command_setting::uuid
    AND command.world_id = checked_world_id
    AND command.command_type = checked_command_type
    AND command.command_schema_version = 1
    AND command.status = 'accepted'::command_record_status
    AND command.write_gate_opened_at >= transaction_timestamp()
    AND command.decided_at IS NOT NULL
    AND NULLIF(current_setting('worldgraph.command_world_id', true), '') = checked_world_id::text
    AND event.world_id = checked_world_id
    AND event.event_ordinal = 0
    AND event.event_schema_version = 1
    AND event.event_type = checked_event_type
    AND event.aggregate_type = checked_aggregate_type
    AND (checked_aggregate_id IS NULL OR event.aggregate_id = checked_aggregate_id)
    AND event.metadata ->> 'commandType' = command.command_type
    AND event.metadata ->> 'commandSchemaVersion' = command.command_schema_version::text
    AND event.metadata ->> 'correlationId' = command.correlation_id::text
    AND event.metadata -> 'actor' ->> 'actorId' = command.actor_id
    AND event.metadata -> 'actor' ->> 'actorType' = command.actor_type::text
    AND (SELECT count(*) FROM public.domain_events owned WHERE owned.command_id = command.id) = 1;

  RETURN event_context;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_world_lifecycle_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  event_context jsonb;
  event_payload jsonb;
  revision_hash text;
BEGIN
  IF NOT public.worldgraph_world_requires_lifecycle_ledger(NEW.id) THEN
    -- Before truthful compiled/imported genesis there is no world ledger to append
    -- to. Draft creation, manifest authoring and compilation remain protected by
    -- their relational constraints until the genesis anchor exists.
    RETURN NULL;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.id, 'RenameWorldV1', 'WorldRenamedV1', 'world', NEW.id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR event_payload ->> 'newName' IS DISTINCT FROM NEW.name
      OR event_payload ->> 'previousName' IS DISTINCT FROM OLD.name THEN
      RAISE EXCEPTION 'anchored world rename requires its exact accepted lifecycle event'
        USING ERRCODE = '55000';
    END IF;
    IF (
        to_jsonb(NEW) - ARRAY['name','row_version','updated_at']
      ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY['name','row_version','updated_at']
      )
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'anchored world rename changes fields outside its projection allowlist'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  ELSIF NEW.current_approved_manifest_revision_id IS DISTINCT FROM
      OLD.current_approved_manifest_revision_id
    OR NEW.manifest_schema_version IS DISTINCT FROM OLD.manifest_schema_version THEN
    IF NEW.current_approved_manifest_revision_id IS NULL THEN
      RAISE EXCEPTION 'anchored manifest pointer cannot change without an approved revision'
        USING ERRCODE = '55000';
    END IF;
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.id, 'ApproveManifestRevisionV1', 'ManifestApprovedV1',
      'manifest_revision', NEW.current_approved_manifest_revision_id::text
    );
    event_payload := event_context -> 'payload';
    SELECT encode(revision.content_hash, 'hex') INTO revision_hash
    FROM public.manifest_revisions revision
    WHERE revision.id = NEW.current_approved_manifest_revision_id
      AND revision.world_id = NEW.id
      AND revision.approval_status = 'approved'::manifest_approval_status;
    IF event_context IS NULL
      OR revision_hash IS NULL
      OR event_payload ->> 'revisionId' IS DISTINCT FROM
        NEW.current_approved_manifest_revision_id::text
      OR event_payload ->> 'manifestSchemaVersion' IS DISTINCT FROM
        NEW.manifest_schema_version::text
      OR event_payload ->> 'contentHash' IS DISTINCT FROM revision_hash THEN
      RAISE EXCEPTION 'anchored manifest pointer requires its exact accepted approval event'
        USING ERRCODE = '55000';
    END IF;
    IF (
        to_jsonb(NEW) - ARRAY[
          'current_approved_manifest_revision_id','manifest_schema_version',
          'lifecycle','row_version','updated_at'
        ]
      ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
          'current_approved_manifest_revision_id','manifest_schema_version',
          'lifecycle','row_version','updated_at'
        ]
      )
      OR NEW.lifecycle <> 'manifest_approved'::world_lifecycle
      OR OLD.lifecycle NOT IN (
        'draft'::world_lifecycle, 'manifest_approved'::world_lifecycle,
        'compile_failed'::world_lifecycle
      )
      OR NEW.active_world_version_id IS NOT NULL
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'anchored manifest approval changes fields outside its projection allowlist'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  ELSIF OLD.lifecycle = 'compiling'::world_lifecycle
    AND NEW.lifecycle = 'active'::world_lifecycle
    AND OLD.active_world_version_id IS NULL
    AND NEW.active_world_version_id IS NOT NULL THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.id, 'WorldCompiledGenesisV1', 'WorldCompiledGenesisV1', 'world', NEW.id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR event_context ->> 'actorId' IS DISTINCT FROM 'worldgraph:compiler'
      OR event_payload ->> 'activeWorldVersionId' IS DISTINCT FROM
        NEW.active_world_version_id::text
      OR NOT EXISTS (
        SELECT 1
        FROM public.world_versions version
        JOIN public.world_compilation_runs run
          ON run.id = version.compilation_run_id AND run.world_id = version.world_id
        WHERE version.id = NEW.active_world_version_id
          AND version.world_id = NEW.id
          AND version.status = 'active'::world_version_status
          AND run.status = 'succeeded'::world_compilation_status
          AND run.stage = 'activated'::world_compilation_stage
          AND event_payload ->> 'compilationRunId' = run.id::text
          AND event_payload ->> 'artifactHash' = encode(version.artifact_hash, 'hex')
      )
      OR (
        to_jsonb(NEW) - ARRAY['lifecycle','active_world_version_id','row_version','updated_at']
      ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY['lifecycle','active_world_version_id','row_version','updated_at']
      )
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'world activation requires its exact compiled genesis event'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'anchored world update is not lifecycle-command backed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER worlds_require_lifecycle_command
  AFTER UPDATE ON worlds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_world_lifecycle_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_membership_lifecycle_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_world_id uuid;
  event_context jsonb;
  event_payload jsonb;
BEGIN
  checked_world_id := COALESCE(NEW.world_id, OLD.world_id);
  IF NOT public.worldgraph_world_requires_lifecycle_ledger(checked_world_id) THEN
    -- Creator bootstrap and pre-genesis invitation membership are necessarily
    -- relational: no honest world ledger exists yet.
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'anchored world memberships cannot be deleted'
      USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'AcceptWorldInvitationV1', 'WorldInvitationAcceptedV1',
      'world_invitation'
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR NEW.status <> 'active'::membership_status
      OR NEW.role NOT IN ('player'::world_role, 'observer'::world_role)
      OR event_payload ->> 'targetUserId' IS DISTINCT FROM NEW.user_id::text
      OR event_payload ->> 'intendedRole' IS DISTINCT FROM NEW.role::text
      OR event_payload ->> 'invitationId' IS DISTINCT FROM event_context ->> 'aggregateId'
      OR NOT EXISTS (
        SELECT 1 FROM public.world_invitations invitation
        WHERE invitation.id::text = event_context ->> 'aggregateId'
          AND invitation.world_id = NEW.world_id
          AND invitation.status = 'accepted'::invitation_status
          AND invitation.accepted_by_user_id = NEW.user_id
          AND invitation.accepted_at >= transaction_timestamp()
      ) THEN
      RAISE EXCEPTION 'anchored membership insert requires its exact invitation acceptance event'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR OLD.role = 'creator'::world_role
    OR (
      to_jsonb(NEW) - ARRAY['role','status','row_version','updated_at','removed_at']
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY['role','status','row_version','updated_at','removed_at']
    )
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'anchored membership mutation changes immutable authority fields'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'removed'::membership_status
    AND NEW.status = 'active'::membership_status
    AND NEW.removed_at IS NULL
    AND NEW.role IN ('player'::world_role, 'observer'::world_role) THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'AcceptWorldInvitationV1', 'WorldInvitationAcceptedV1',
      'world_invitation'
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR event_payload ->> 'targetUserId' IS DISTINCT FROM NEW.user_id::text
      OR event_payload ->> 'intendedRole' IS DISTINCT FROM NEW.role::text
      OR event_payload ->> 'invitationId' IS DISTINCT FROM event_context ->> 'aggregateId'
      OR NOT EXISTS (
        SELECT 1 FROM public.world_invitations invitation
        WHERE invitation.id::text = event_context ->> 'aggregateId'
          AND invitation.world_id = NEW.world_id
          AND invitation.status = 'accepted'::invitation_status
          AND invitation.accepted_by_user_id = NEW.user_id
          AND invitation.accepted_at >= transaction_timestamp()
      ) THEN
      RAISE EXCEPTION 'anchored membership restoration requires its invitation acceptance event'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'active'::membership_status
    AND NEW.status = 'removed'::membership_status
    AND NEW.role = OLD.role
    AND NEW.removed_at IS NOT NULL THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'RemoveWorldMembershipV1', 'WorldMembershipRemovedV1',
      'world_membership', NEW.user_id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR event_payload ->> 'targetUserId' IS DISTINCT FROM NEW.user_id::text
      OR event_payload ->> 'previousRole' IS DISTINCT FROM OLD.role::text THEN
      RAISE EXCEPTION 'anchored membership removal requires its exact accepted event'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'active'::membership_status
    AND NEW.status = 'active'::membership_status
    AND NEW.removed_at IS NULL
    AND NEW.role IS DISTINCT FROM OLD.role THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'ChangeWorldMembershipRoleV1', 'WorldMembershipRoleChangedV1',
      'world_membership', NEW.user_id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NOT NULL
      AND event_payload ->> 'targetUserId' = NEW.user_id::text
      AND event_payload ->> 'previousRole' = OLD.role::text
      AND event_payload ->> 'newRole' = NEW.role::text THEN
      RETURN NULL;
    END IF;

    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'UseCreatorOverrideV1', 'CreatorOverrideUsedV1',
      'world_membership', NEW.user_id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR OLD.role <> 'administrator'::world_role
      OR NEW.role <> 'player'::world_role
      OR event_payload ->> 'targetId' IS DISTINCT FROM NEW.user_id::text
      OR event_payload ->> 'targetType' IS DISTINCT FROM 'world_membership'
      OR event_payload ->> 'commandType' IS DISTINCT FROM 'UseCreatorOverrideV1'
      OR NOT EXISTS (
        SELECT 1 FROM public.creator_override_records override
        WHERE override.id::text = event_payload ->> 'overrideId'
          AND override.world_id = NEW.world_id
          AND override.target_type = 'world_membership'
          AND override.target_id = NEW.user_id
          AND override.command_id::text = event_context ->> 'commandId'
      ) THEN
      RAISE EXCEPTION 'anchored membership role change requires its exact accepted event'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'anchored membership transition is not lifecycle-command backed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_memberships_require_lifecycle_command
  AFTER INSERT OR UPDATE OR DELETE ON world_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_membership_lifecycle_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_invitation_lifecycle_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  checked_world_id uuid;
  event_context jsonb;
  event_payload jsonb;
BEGIN
  checked_world_id := COALESCE(NEW.world_id, OLD.world_id);
  IF NOT public.worldgraph_world_requires_lifecycle_ledger(checked_world_id) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'anchored world invitations cannot be deleted'
      USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'CreateWorldInvitationV1', 'WorldInvitationCreatedV1',
      'world_invitation', NEW.id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR NEW.status <> 'pending'::invitation_status
      OR NEW.created_by_user_id::text IS DISTINCT FROM event_context ->> 'actorId'
      OR event_payload ->> 'invitationId' IS DISTINCT FROM NEW.id::text
      OR event_payload ->> 'intendedRole' IS DISTINCT FROM NEW.intended_role::text THEN
      RAISE EXCEPTION 'anchored invitation insert requires its exact accepted event'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'anchored invitation transition changes immutable identity'
      USING ERRCODE = '55000';
  END IF;

  -- Expiration is derived security housekeeping, not a simulation fact. It is the
  -- only post-anchor direct transition and may change no data beyond status/version.
  IF OLD.status = 'pending'::invitation_status
    AND NEW.status = 'expired'::invitation_status
    AND NEW.expires_at <= clock_timestamp()
    AND (
      to_jsonb(NEW) - ARRAY['status','row_version']
    ) IS NOT DISTINCT FROM (
      to_jsonb(OLD) - ARRAY['status','row_version']
    ) THEN
    RETURN NULL;
  END IF;

  IF (
      to_jsonb(NEW) - ARRAY[
        'status','row_version','accepted_by_user_id','accepted_at','revoked_at'
      ]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'status','row_version','accepted_by_user_id','accepted_at','revoked_at'
      ]
    ) THEN
    RAISE EXCEPTION 'anchored invitation transition changes immutable fields'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending'::invitation_status
    AND NEW.status = 'revoked'::invitation_status
    AND NEW.revoked_at IS NOT NULL
    AND NEW.accepted_by_user_id IS NULL
    AND NEW.accepted_at IS NULL THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'RevokeWorldInvitationV1', 'WorldInvitationRevokedV1',
      'world_invitation', NEW.id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR event_payload ->> 'invitationId' IS DISTINCT FROM NEW.id::text
      OR event_payload ->> 'intendedRole' IS DISTINCT FROM NEW.intended_role::text THEN
      RAISE EXCEPTION 'anchored invitation revocation requires its exact accepted event'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'pending'::invitation_status
    AND NEW.status = 'accepted'::invitation_status
    AND NEW.accepted_by_user_id IS NOT NULL
    AND NEW.accepted_at IS NOT NULL
    AND NEW.revoked_at IS NULL THEN
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'AcceptWorldInvitationV1', 'WorldInvitationAcceptedV1',
      'world_invitation', NEW.id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR event_payload ->> 'invitationId' IS DISTINCT FROM NEW.id::text
      OR event_payload ->> 'intendedRole' IS DISTINCT FROM NEW.intended_role::text
      OR event_payload ->> 'targetUserId' IS DISTINCT FROM NEW.accepted_by_user_id::text
      OR NOT EXISTS (
        SELECT 1 FROM public.world_memberships membership
        WHERE membership.world_id = NEW.world_id
          AND membership.user_id = NEW.accepted_by_user_id
          AND membership.role = NEW.intended_role
          AND membership.status = 'active'::membership_status
      ) THEN
      RAISE EXCEPTION 'anchored invitation acceptance requires its exact accepted event'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'anchored invitation transition is not lifecycle-command backed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER world_invitations_require_lifecycle_command
  AFTER INSERT OR UPDATE OR DELETE ON world_invitations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_invitation_lifecycle_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_manifest_lifecycle_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  event_context jsonb;
  event_payload jsonb;
BEGIN
  IF NOT public.worldgraph_world_requires_lifecycle_ledger(COALESCE(NEW.world_id, OLD.world_id)) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'anchored manifest revisions cannot be deleted'
      USING ERRCODE = '55000';
  ELSIF TG_OP = 'INSERT' THEN
    -- Generated revisions are deterministic worker output already bound to a
    -- running generation claim by worldgraph_protect_manifest_revision(). They are
    -- computation artifacts; manual authoritative edits require a lifecycle event.
    IF NEW.source = 'generation'::manifest_revision_source THEN
      RETURN NULL;
    END IF;
    event_context := public.worldgraph_lifecycle_event_context(
      NEW.world_id, 'CreateManifestRevisionV1', 'ManifestRevisionCreatedV1',
      'manifest_revision', NEW.id::text
    );
    event_payload := event_context -> 'payload';
    IF event_context IS NULL
      OR NEW.source <> 'manual'::manifest_revision_source
      OR NEW.created_by_user_id::text IS DISTINCT FROM event_context ->> 'actorId'
      OR event_payload ->> 'revisionId' IS DISTINCT FROM NEW.id::text
      OR event_payload ->> 'revisionNumber' IS DISTINCT FROM NEW.revision_number::text
      OR event_payload ->> 'manifestSchemaVersion' IS DISTINCT FROM
        NEW.manifest_schema_version::text
      OR event_payload ->> 'contentHash' IS DISTINCT FROM encode(NEW.content_hash, 'hex')
      OR event_payload ->> 'source' IS DISTINCT FROM NEW.source::text THEN
      RAISE EXCEPTION 'anchored manifest revision insert requires its exact accepted event'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR (
      to_jsonb(NEW) - ARRAY[
        'approval_status','approved_by_user_id','approved_at',
        'warning_acknowledgements','row_version'
      ]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'approval_status','approved_by_user_id','approved_at',
        'warning_acknowledgements','row_version'
      ]
    )
    OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'anchored manifest revision transition changes immutable fields'
      USING ERRCODE = '55000';
  END IF;

  event_context := public.worldgraph_lifecycle_event_context(
    NEW.world_id, 'ApproveManifestRevisionV1', 'ManifestApprovedV1',
    'manifest_revision'
  );
  event_payload := event_context -> 'payload';
  IF event_context IS NULL
    OR event_payload ->> 'revisionId' IS DISTINCT FROM event_context ->> 'aggregateId'
    OR event_payload ->> 'manifestSchemaVersion' IS DISTINCT FROM
      NEW.manifest_schema_version::text
    OR event_payload ->> 'contentHash' IS DISTINCT FROM (
      SELECT encode(revision.content_hash, 'hex')
      FROM public.manifest_revisions revision
      WHERE revision.id::text = event_context ->> 'aggregateId'
        AND revision.world_id = NEW.world_id
    ) THEN
    RAISE EXCEPTION 'anchored manifest transition requires its accepted approval event'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.approval_status = 'draft'::manifest_approval_status
    AND NEW.approval_status = 'approved'::manifest_approval_status THEN
    IF NEW.id::text IS DISTINCT FROM event_context ->> 'aggregateId'
      OR NEW.approved_by_user_id::text IS DISTINCT FROM event_context ->> 'actorId'
      OR NOT EXISTS (
        SELECT 1 FROM public.worlds world
        WHERE world.id = NEW.world_id
          AND world.current_approved_manifest_revision_id = NEW.id
      ) THEN
      RAISE EXCEPTION 'anchored manifest approval target does not match its event'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.approval_status = 'approved'::manifest_approval_status
    AND NEW.approval_status = 'superseded'::manifest_approval_status
    AND NEW.approved_by_user_id IS NOT DISTINCT FROM OLD.approved_by_user_id
    AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
    AND NEW.warning_acknowledgements IS NOT DISTINCT FROM OLD.warning_acknowledgements THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.worlds world
      JOIN public.manifest_revisions revision
        ON revision.id = world.current_approved_manifest_revision_id
       AND revision.world_id = world.id
      WHERE world.id = NEW.world_id
        AND revision.id::text = event_context ->> 'aggregateId'
        AND revision.approval_status = 'approved'::manifest_approval_status
    ) THEN
      RAISE EXCEPTION 'superseded manifest does not match the accepted replacement event'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'anchored manifest transition is not lifecycle-command backed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manifest_revisions_require_lifecycle_command
  AFTER INSERT OR UPDATE OR DELETE ON manifest_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_manifest_lifecycle_command();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_active_world_ledger(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.worlds world WHERE world.id = checked_world_id
      AND world.lifecycle = 'active'::world_lifecycle
  ) AND NOT EXISTS (
    SELECT 1 FROM public.world_runtime_heads runtime
    JOIN public.world_ledger_heads ledger ON ledger.world_id = runtime.world_id
    WHERE runtime.world_id = checked_world_id
      AND runtime.ledger_anchored_at IS NOT NULL
      AND runtime.ledger_anchor_event_id = ledger.anchor_event_id
      AND runtime.anchor_artifact_hash = ledger.anchor_artifact_hash
      AND runtime.last_event_sequence = ledger.next_event_sequence - 1
      AND runtime.last_ledger_sequence = ledger.next_ledger_sequence - 1
      AND ledger.anchored_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'active world requires a complete command ledger genesis anchor'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_active_world_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.worldgraph_assert_active_world_ledger(COALESCE(NEW.id, OLD.id));
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER worlds_require_ledger_anchor
  AFTER INSERT OR UPDATE OR DELETE ON worlds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_active_world_ledger();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_projection_checkpoint()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'projection checkpoints cannot be deleted' USING ERRCODE = '55000';
  ELSIF TG_OP = 'UPDATE' AND (
    NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.projection_name IS DISTINCT FROM OLD.projection_name
    OR NEW.projection_schema_version < OLD.projection_schema_version
    OR NEW.last_event_sequence < OLD.last_event_sequence
    OR NEW.updated_at < OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'projection checkpoint cannot move backward' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER projection_checkpoints_protect
  BEFORE UPDATE OR DELETE ON projection_checkpoints
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_projection_checkpoint();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_outbox_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox messages cannot be deleted' USING ERRCODE = '55000';
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
CREATE TRIGGER outbox_messages_protect
  BEFORE UPDATE OR DELETE ON outbox_messages
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_outbox_message();
--> statement-breakpoint
DO $metadata$
DECLARE
  changed integer;
BEGIN
  UPDATE platform_metadata
  SET value = value || jsonb_build_object(
        'commandSchema', 1,
        'contracts', 6,
        'domainEventSchema', 1,
        'historySchema', 1,
        'ledgerSchema', 1,
        'outboxSchema', 1,
        'projectionSchema', 1,
        'runtimeSchema', 6
      ),
      value_schema_version = 6,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 5
    AND value ->> 'compiler' = '1.0.0'
    AND value ->> 'contracts' = '5'
    AND value ->> 'runtimeSchema' = '5'
    AND value ->> 'worldGraphSchema' = '1';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact sealed M05 compatibility state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT USAGE ON TYPE command_actor_type, command_record_status,
      payload_classification, ledger_entry_kind, projection_checkpoint_status,
      outbox_message_status, history_visibility, projection_replay_status
      TO worldgraph_app;
    GRANT SELECT ON command_records, domain_events, ledger_entries,
      event_consumer_receipts, outbox_messages, world_history_entries,
      projection_replay_runs, shadow_world_entities, shadow_world_relationships,
      shadow_world_entity_controllers
      TO worldgraph_app;
    GRANT INSERT ON domain_events, ledger_entries, event_consumer_receipts,
      outbox_messages, world_history_entries
      TO worldgraph_app;
    GRANT INSERT (
      id, world_id, command_type, command_schema_version, actor_type, actor_id,
      payload, payload_hash, payload_classification, idempotency_key, request_hash,
      expected_world_version, expected_state_revision, correlation_id, causation_id,
      requested_at
    ) ON command_records TO worldgraph_app;
    GRANT SELECT ON world_ledger_heads, aggregate_stream_heads, projection_checkpoints
      TO worldgraph_app;
    GRANT INSERT ON projection_checkpoints TO worldgraph_app;
    GRANT UPDATE (
      status, rejection_code, authorization_rule_id, override_id, decided_at,
      resulting_state_revision, response_summary
    ) ON command_records TO worldgraph_app;
    GRANT UPDATE (
      projection_schema_version, last_event_sequence, checksum, status, updated_at
    ) ON projection_checkpoints TO worldgraph_app;
    GRANT UPDATE (
      status, attempts, available_at, locked_at, locked_by, published_at
    ) ON outbox_messages TO worldgraph_app;
    GRANT UPDATE (state, retired_world_version_id, row_version, updated_at)
      ON world_entities TO worldgraph_app;
    GRANT UPDATE (attributes, retired_world_version_id, row_version, updated_at)
      ON world_relationships TO worldgraph_app;
    GRANT UPDATE (revoked_at) ON world_entity_controllers TO worldgraph_app;
    GRANT UPDATE (
      state_revision, last_ledger_sequence, last_event_sequence,
      ledger_anchored_at, ledger_anchor_event_id, anchor_artifact_hash,
      projection_checksum, updated_at
    ) ON world_runtime_heads TO worldgraph_app;
    REVOKE UPDATE, DELETE ON domain_events, ledger_entries,
      event_consumer_receipts, world_history_entries FROM worldgraph_app;
    REVOKE DELETE ON command_records, world_ledger_heads, aggregate_stream_heads,
      projection_checkpoints, outbox_messages FROM worldgraph_app;
    REVOKE INSERT, UPDATE, DELETE ON projection_replay_runs,
      shadow_world_entities, shadow_world_relationships,
      shadow_world_entity_controllers FROM worldgraph_app;
    GRANT EXECUTE ON FUNCTION worldgraph_canonical_jsonb(jsonb),
      worldgraph_timestamp_text(timestamptz),
      worldgraph_domain_event_hash_v1(
        uuid,uuid,bigint,uuid,integer,text,text,bigint,text,integer,
        jsonb,jsonb,timestamptz,timestamptz,bigint
      ),
      worldgraph_ledger_entry_hash_v1(
        uuid,uuid,bigint,text,uuid,uuid,text,text,text,jsonb,bytea,timestamptz
      ),
      worldgraph_projection_document(uuid,bigint), worldgraph_projection_checksum(uuid,bigint),
      worldgraph_command_write_is_open(uuid,uuid),
      worldgraph_open_command_write(uuid,uuid),
      worldgraph_append_compiled_genesis(uuid,uuid,uuid,uuid,uuid,uuid,uuid),
      worldgraph_protect_command_record(), worldgraph_reject_update_delete(),
      worldgraph_protect_world_ledger_head(), worldgraph_protect_runtime_head(),
      worldgraph_protect_compiler_seed_row(), worldgraph_assert_command_terminal(uuid),
      worldgraph_enforce_command_terminal(), worldgraph_assert_active_world_ledger(uuid),
      worldgraph_enforce_active_world_ledger(), worldgraph_protect_projection_checkpoint(),
      worldgraph_protect_outbox_message()
      TO worldgraph_app;
  END IF;
END
$grant$;
