CREATE TYPE manifest_generation_status AS ENUM (
  'queued', 'running', 'succeeded', 'failed', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE manifest_generation_mode AS ENUM ('provider', 'fallback');
--> statement-breakpoint
CREATE TYPE manifest_revision_source AS ENUM ('generation', 'manual', 'import');
--> statement-breakpoint
CREATE TYPE manifest_approval_status AS ENUM (
  'draft', 'approved', 'superseded', 'rejected'
);
--> statement-breakpoint
CREATE TYPE manifest_provenance_source AS ENUM (
  'prompt', 'primitive', 'model', 'fallback', 'manual'
);
--> statement-breakpoint
ALTER TABLE worlds
  ADD COLUMN current_approved_manifest_revision_id uuid,
  ADD COLUMN manifest_schema_version integer,
  ADD CONSTRAINT worlds_manifest_schema_version_known CHECK (
    manifest_schema_version IS NULL OR manifest_schema_version = 1
  );
--> statement-breakpoint
CREATE TABLE world_prompt_submissions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  submitted_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  prompt_text text,
  normalized_hash bytea NOT NULL,
  client_seed text,
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL,
  redacted_at timestamptz,
  CONSTRAINT world_prompt_submissions_world_identity UNIQUE (id, world_id),
  CONSTRAINT world_prompt_submissions_prompt_state CHECK (
    (
      prompt_text IS NOT NULL
      AND redacted_at IS NULL
      AND char_length(prompt_text) BETWEEN 1 AND 8000
      AND translate(prompt_text, E'\n\t', '') !~ '[[:cntrl:]]'
    )
    OR (
      prompt_text IS NULL
      AND redacted_at IS NOT NULL
      AND redacted_at >= retention_until
    )
  ),
  CONSTRAINT world_prompt_submissions_hash_length CHECK (octet_length(normalized_hash) = 32),
  CONSTRAINT world_prompt_submissions_seed_bounded CHECK (
    client_seed IS NULL OR (
      char_length(client_seed) BETWEEN 1 AND 128
      AND client_seed = btrim(client_seed)
      AND client_seed !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT world_prompt_submissions_retention_ordered CHECK (
    retention_until > created_at
    AND (redacted_at IS NULL OR redacted_at >= retention_until)
  )
);
--> statement-breakpoint
CREATE INDEX world_prompt_submissions_world_cursor_idx
  ON world_prompt_submissions (world_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX world_prompt_submissions_retention_idx
  ON world_prompt_submissions (retention_until, id)
  WHERE prompt_text IS NOT NULL;
--> statement-breakpoint
CREATE TABLE manifest_generation_runs (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  prompt_submission_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status manifest_generation_status NOT NULL DEFAULT 'queued',
  generator_schema_version integer NOT NULL,
  prompt_template_version integer NOT NULL,
  stage text NOT NULL DEFAULT 'queued',
  progress_percent integer NOT NULL DEFAULT 0,
  generation_mode manifest_generation_mode,
  provider_configuration_id text NOT NULL,
  provider text,
  model text,
  parent_revision_id uuid,
  expected_parent_content_hash bytea,
  seed text NOT NULL,
  input_hash bytea NOT NULL,
  primitive_catalog_snapshot_hash bytea,
  resolved_input_hash bytea,
  output_review jsonb,
  output_revision_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  repair_attempts integer NOT NULL DEFAULT 0,
  provider_call_count integer NOT NULL DEFAULT 0,
  input_token_count integer,
  output_token_count integer,
  cost_estimate_microunits bigint,
  latency_ms integer,
  error_code text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT manifest_generation_runs_world_identity UNIQUE (id, world_id),
  CONSTRAINT manifest_generation_runs_prompt_world_fk
    FOREIGN KEY (prompt_submission_id, world_id)
    REFERENCES world_prompt_submissions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT manifest_generation_runs_schema_known CHECK (generator_schema_version = 1),
  CONSTRAINT manifest_generation_runs_template_known CHECK (prompt_template_version = 1),
  CONSTRAINT manifest_generation_runs_stage_known CHECK (
    stage IN (
      'queued', 'intent', 'retrieval', 'generation', 'repair',
      'fallback', 'validation', 'persisting', 'complete'
    )
  ),
  CONSTRAINT manifest_generation_runs_progress_bounded CHECK (
    progress_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT manifest_generation_runs_provider_configuration_bounded CHECK (
    char_length(provider_configuration_id) BETWEEN 1 AND 120
    AND provider_configuration_id = btrim(provider_configuration_id)
    AND provider_configuration_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT manifest_generation_runs_provider_pair CHECK (
    (provider IS NULL AND model IS NULL)
    OR (
      provider IS NOT NULL AND model IS NOT NULL
      AND char_length(provider) BETWEEN 1 AND 120
      AND char_length(model) BETWEEN 1 AND 160
      AND provider = btrim(provider)
      AND model = btrim(model)
      AND provider !~ '[[:cntrl:]]'
      AND model !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT manifest_generation_runs_mode_provider_consistent CHECK (
    generation_mode IS DISTINCT FROM 'provider'::manifest_generation_mode
    OR (provider IS NOT NULL AND model IS NOT NULL)
  ),
  CONSTRAINT manifest_generation_runs_seed_bounded CHECK (
    char_length(seed) BETWEEN 1 AND 128
    AND seed = btrim(seed)
    AND seed !~ '[[:cntrl:]]'
  ),
  CONSTRAINT manifest_generation_runs_parent_input_consistent CHECK (
    (parent_revision_id IS NULL AND expected_parent_content_hash IS NULL)
    OR (
      parent_revision_id IS NOT NULL
      AND expected_parent_content_hash IS NOT NULL
      AND octet_length(expected_parent_content_hash) = 32
    )
  ),
  CONSTRAINT manifest_generation_runs_input_hash_length CHECK (octet_length(input_hash) = 32),
  CONSTRAINT manifest_generation_runs_attempts_bounded CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT manifest_generation_runs_repair_attempts_bounded CHECK (
    repair_attempts BETWEEN 0 AND 2
  ),
  CONSTRAINT manifest_generation_runs_provider_call_count_bounded CHECK (
    provider_call_count BETWEEN 0 AND 9
  ),
  CONSTRAINT manifest_generation_runs_catalog_hash_length CHECK (
    (
      primitive_catalog_snapshot_hash IS NULL
      AND resolved_input_hash IS NULL
    )
    OR (
      primitive_catalog_snapshot_hash IS NOT NULL
      AND resolved_input_hash IS NOT NULL
      AND octet_length(primitive_catalog_snapshot_hash) = 32
      AND octet_length(resolved_input_hash) = 32
    )
  ),
  CONSTRAINT manifest_generation_runs_output_review_bounded CHECK (
    output_review IS NULL OR (
      jsonb_typeof(output_review) = 'object'
      AND pg_column_size(output_review) <= 262144
      AND NOT worldgraph_jsonb_has_sensitive_key(output_review)
    )
  ),
  CONSTRAINT manifest_generation_runs_metrics_nonnegative CHECK (
    (input_token_count IS NULL OR input_token_count >= 0)
    AND (output_token_count IS NULL OR output_token_count >= 0)
    AND (cost_estimate_microunits IS NULL OR cost_estimate_microunits >= 0)
    AND (latency_ms IS NULL OR latency_ms >= 0)
  ),
  CONSTRAINT manifest_generation_runs_error_bounded CHECK (
    error_code IS NULL OR (
      char_length(error_code) BETWEEN 1 AND 100
      AND error_code ~ '^[A-Z][A-Z0-9_]*$'
    )
  ),
  CONSTRAINT manifest_generation_runs_row_version_positive CHECK (row_version > 0),
  CONSTRAINT manifest_generation_runs_state_consistent CHECK (
    (
      status = 'queued' AND attempts BETWEEN 0 AND 2 AND stage = 'queued'
      AND progress_percent BETWEEN 0 AND 99
      AND completed_at IS NULL AND output_revision_id IS NULL AND error_code IS NULL
      AND claim_token IS NULL
      AND ((attempts = 0 AND started_at IS NULL AND claimed_at IS NULL AND heartbeat_at IS NULL)
        OR (attempts > 0 AND started_at IS NOT NULL AND claimed_at IS NOT NULL
          AND heartbeat_at IS NOT NULL))
    )
    OR (
      status = 'running' AND attempts BETWEEN 1 AND 3 AND started_at IS NOT NULL
      AND completed_at IS NULL AND output_revision_id IS NULL AND error_code IS NULL
      AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL
      AND stage NOT IN ('queued', 'complete') AND progress_percent BETWEEN 1 AND 99
    )
    OR (
      status = 'succeeded' AND attempts BETWEEN 1 AND 3 AND started_at IS NOT NULL
      AND completed_at IS NOT NULL AND output_revision_id IS NOT NULL AND error_code IS NULL
      AND claim_token IS NULL AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL
      AND stage = 'complete' AND progress_percent = 100
      AND generation_mode IS NOT NULL
      AND primitive_catalog_snapshot_hash IS NOT NULL AND resolved_input_hash IS NOT NULL
      AND output_review IS NOT NULL
    )
    OR (
      status = 'failed' AND attempts BETWEEN 1 AND 3 AND started_at IS NOT NULL
      AND completed_at IS NOT NULL AND output_revision_id IS NULL AND error_code IS NOT NULL
      AND claim_token IS NULL AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL
      AND stage <> 'complete' AND progress_percent BETWEEN 1 AND 99
    )
    OR (
      status = 'cancelled' AND attempts BETWEEN 0 AND 3 AND completed_at IS NOT NULL
      AND output_revision_id IS NULL AND error_code IS NULL
      AND claim_token IS NULL AND stage <> 'complete' AND progress_percent BETWEEN 0 AND 99
      AND ((attempts = 0 AND started_at IS NULL AND claimed_at IS NULL AND heartbeat_at IS NULL)
        OR (attempts > 0 AND started_at IS NOT NULL AND claimed_at IS NOT NULL
          AND heartbeat_at IS NOT NULL))
    )
  ),
  CONSTRAINT manifest_generation_runs_timestamps_ordered CHECK (
    next_attempt_at >= queued_at AND updated_at >= queued_at
    AND (claimed_at IS NULL OR claimed_at >= queued_at)
    AND (heartbeat_at IS NULL OR claimed_at IS NULL OR heartbeat_at >= claimed_at)
    AND (started_at IS NULL OR started_at >= queued_at)
    AND (completed_at IS NULL OR completed_at >= queued_at)
    AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    AND (heartbeat_at IS NULL OR updated_at >= heartbeat_at)
    AND (started_at IS NULL OR updated_at >= started_at)
    AND (completed_at IS NULL OR updated_at >= completed_at)
  )
);
--> statement-breakpoint
CREATE INDEX manifest_generation_runs_queue_idx
  ON manifest_generation_runs (next_attempt_at, queued_at, id)
  WHERE status = 'queued';
--> statement-breakpoint
CREATE INDEX manifest_generation_runs_running_lease_idx
  ON manifest_generation_runs (heartbeat_at, claimed_at, id)
  WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX manifest_generation_runs_world_cursor_idx
  ON manifest_generation_runs (world_id, queued_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX manifest_generation_runs_requester_status_idx
  ON manifest_generation_runs (requested_by_user_id, status, queued_at DESC, id DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX manifest_generation_runs_output_unique_idx
  ON manifest_generation_runs (output_revision_id)
  WHERE output_revision_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX manifest_generation_runs_input_cache_idx
  ON manifest_generation_runs (
    world_id, input_hash, prompt_template_version, queued_at DESC, id DESC
  );
--> statement-breakpoint
CREATE INDEX manifest_generation_runs_resolved_input_cache_idx
  ON manifest_generation_runs (world_id, resolved_input_hash, queued_at DESC, id DESC)
  WHERE resolved_input_hash IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX manifest_generation_runs_one_active_root_world_idx
  ON manifest_generation_runs (world_id)
  WHERE parent_revision_id IS NULL AND status IN ('queued', 'running');
--> statement-breakpoint
CREATE TABLE manifest_provider_calls (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES manifest_generation_runs(id) ON DELETE RESTRICT,
  claim_token uuid NOT NULL,
  run_attempt integer NOT NULL,
  call_number integer NOT NULL,
  call_kind text NOT NULL,
  provider_configuration_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  usage_date date NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  reserved_cost_microunits bigint NOT NULL,
  reserved_input_tokens integer NOT NULL,
  reserved_output_tokens integer NOT NULL,
  actual_cost_microunits bigint,
  actual_input_tokens integer,
  actual_output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CONSTRAINT manifest_provider_calls_run_number_unique UNIQUE (run_id, call_number),
  CONSTRAINT manifest_provider_calls_attempt_bounded CHECK (run_attempt BETWEEN 1 AND 3),
  CONSTRAINT manifest_provider_calls_number_bounded CHECK (call_number BETWEEN 1 AND 9),
  CONSTRAINT manifest_provider_calls_kind_known CHECK (call_kind IN ('generate','repair')),
  CONSTRAINT manifest_provider_calls_identity_bounded CHECK (
    char_length(provider_configuration_id) BETWEEN 1 AND 120
    AND char_length(provider) BETWEEN 1 AND 120
    AND char_length(model) BETWEEN 1 AND 160
    AND provider_configuration_id = btrim(provider_configuration_id)
    AND provider = btrim(provider)
    AND model = btrim(model)
    AND provider_configuration_id !~ '[[:cntrl:]]'
    AND provider !~ '[[:cntrl:]]'
    AND model !~ '[[:cntrl:]]'
  ),
  CONSTRAINT manifest_provider_calls_reservation_bounded CHECK (
    reserved_cost_microunits BETWEEN 0 AND 2147483647
    AND reserved_input_tokens BETWEEN 1 AND 100000
    AND reserved_output_tokens BETWEEN 1 AND 100000
  ),
  CONSTRAINT manifest_provider_calls_state_consistent CHECK (
    (
      status = 'reserved'
      AND actual_cost_microunits IS NULL
      AND actual_input_tokens IS NULL
      AND actual_output_tokens IS NULL
      AND settled_at IS NULL
    ) OR (
      status = 'settled'
      AND actual_cost_microunits BETWEEN 0 AND 2147483647
      AND actual_input_tokens BETWEEN 0 AND 100000
      AND actual_output_tokens BETWEEN 0 AND 100000
      AND actual_cost_microunits <= reserved_cost_microunits
      AND actual_input_tokens <= reserved_input_tokens
      AND actual_output_tokens <= reserved_output_tokens
      AND settled_at IS NOT NULL
    ) OR (
      status = 'released'
      AND actual_cost_microunits IS NULL
      AND actual_input_tokens IS NULL
      AND actual_output_tokens IS NULL
      AND settled_at IS NOT NULL
    )
  ),
  CONSTRAINT manifest_provider_calls_timestamps_ordered CHECK (
    settled_at IS NULL OR settled_at >= created_at
  )
);
--> statement-breakpoint
CREATE INDEX manifest_provider_calls_daily_budget_idx
  ON manifest_provider_calls (usage_date, status, id);
--> statement-breakpoint
CREATE INDEX manifest_provider_calls_run_idx
  ON manifest_provider_calls (run_id, created_at, id);
--> statement-breakpoint
CREATE TABLE generation_retrieval_items (
  run_id uuid NOT NULL REFERENCES manifest_generation_runs(id) ON DELETE RESTRICT,
  rank integer NOT NULL,
  primitive_version_id uuid NOT NULL,
  retrieval_score double precision NOT NULL,
  reason jsonb NOT NULL,
  content_hash bytea NOT NULL,
  PRIMARY KEY (run_id, rank),
  CONSTRAINT generation_retrieval_items_run_primitive_unique UNIQUE (
    run_id, primitive_version_id
  ),
  CONSTRAINT generation_retrieval_items_primitive_identity_fk
    FOREIGN KEY (primitive_version_id, content_hash)
    REFERENCES primitive_versions(id, content_hash)
    ON DELETE RESTRICT,
  CONSTRAINT generation_retrieval_items_rank_bounded CHECK (rank BETWEEN 1 AND 500),
  CONSTRAINT generation_retrieval_items_score_bounded CHECK (
    retrieval_score >= 0 AND retrieval_score <= 1000000
  ),
  CONSTRAINT generation_retrieval_items_reason_bounded CHECK (
    jsonb_typeof(reason) = 'object'
    AND pg_column_size(reason) <= 32768
    AND NOT worldgraph_jsonb_has_sensitive_key(reason)
  ),
  CONSTRAINT generation_retrieval_items_hash_length CHECK (octet_length(content_hash) = 32)
);
--> statement-breakpoint
CREATE INDEX generation_retrieval_items_primitive_idx
  ON generation_retrieval_items (primitive_version_id, run_id);
--> statement-breakpoint
CREATE TABLE manifest_revisions (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  revision_number bigint NOT NULL,
  parent_revision_id uuid,
  manifest_schema_version integer NOT NULL,
  canonical_manifest jsonb NOT NULL,
  content_hash bytea NOT NULL,
  source manifest_revision_source NOT NULL,
  generation_run_id uuid,
  generation_claim_token uuid,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  approval_status manifest_approval_status NOT NULL DEFAULT 'draft',
  approved_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  generation_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  warning_acknowledgements jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT manifest_revisions_world_identity UNIQUE (id, world_id),
  CONSTRAINT manifest_revisions_world_content_identity UNIQUE (id, world_id, content_hash),
  CONSTRAINT manifest_revisions_world_number_unique UNIQUE (world_id, revision_number),
  CONSTRAINT manifest_revisions_world_content_unique UNIQUE (world_id, content_hash),
  CONSTRAINT manifest_revisions_parent_world_fk
    FOREIGN KEY (parent_revision_id, world_id)
    REFERENCES manifest_revisions(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT manifest_revisions_generation_world_fk
    FOREIGN KEY (generation_run_id, world_id)
    REFERENCES manifest_generation_runs(id, world_id)
    ON DELETE RESTRICT,
  CONSTRAINT manifest_revisions_number_bounded CHECK (
    revision_number BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT manifest_revisions_parent_not_self CHECK (
    parent_revision_id IS NULL OR parent_revision_id <> id
  ),
  CONSTRAINT manifest_revisions_schema_known CHECK (manifest_schema_version = 1),
  CONSTRAINT manifest_revisions_manifest_bounded CHECK (
    jsonb_typeof(canonical_manifest) = 'object'
    AND pg_column_size(canonical_manifest) <= 1048576
  ),
  CONSTRAINT manifest_revisions_hash_length CHECK (octet_length(content_hash) = 32),
  CONSTRAINT manifest_revisions_source_consistent CHECK (
    (source = 'generation' AND generation_run_id IS NOT NULL AND generation_claim_token IS NOT NULL)
    OR (
      source IN ('manual', 'import')
      AND generation_run_id IS NULL AND generation_claim_token IS NULL
    )
  ),
  CONSTRAINT manifest_revisions_generation_warnings_bounded CHECK (
    jsonb_typeof(generation_warnings) = 'array'
    AND jsonb_array_length(generation_warnings) <= 32
    AND pg_column_size(generation_warnings) <= 65536
    AND NOT worldgraph_jsonb_has_sensitive_key(generation_warnings)
  ),
  CONSTRAINT manifest_revisions_warning_acknowledgements_bounded CHECK (
    jsonb_typeof(warning_acknowledgements) = 'array'
    AND pg_column_size(warning_acknowledgements) <= 16384
    AND NOT worldgraph_jsonb_has_sensitive_key(warning_acknowledgements)
  ),
  CONSTRAINT manifest_revisions_row_version_positive CHECK (row_version > 0),
  CONSTRAINT manifest_revisions_approval_consistent CHECK (
    (
      approval_status IN ('draft', 'rejected')
      AND approved_by_user_id IS NULL AND approved_at IS NULL
      AND warning_acknowledgements = '[]'::jsonb
    )
    OR (
      approval_status IN ('approved', 'superseded')
      AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_at >= created_at
    )
  )
);
--> statement-breakpoint
CREATE INDEX manifest_revisions_world_cursor_idx
  ON manifest_revisions (world_id, revision_number DESC, id DESC);
--> statement-breakpoint
CREATE INDEX manifest_revisions_world_status_idx
  ON manifest_revisions (world_id, approval_status, revision_number DESC, id DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX manifest_revisions_one_approved_world_idx
  ON manifest_revisions (world_id)
  WHERE approval_status = 'approved';
--> statement-breakpoint
CREATE UNIQUE INDEX manifest_revisions_generation_run_unique_idx
  ON manifest_revisions (generation_run_id)
  WHERE generation_run_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE manifest_generation_runs
  ADD CONSTRAINT manifest_generation_runs_output_world_fk
  FOREIGN KEY (output_revision_id, world_id)
  REFERENCES manifest_revisions(id, world_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE manifest_generation_runs
  ADD CONSTRAINT manifest_generation_runs_parent_input_fk
  FOREIGN KEY (parent_revision_id, world_id, expected_parent_content_hash)
  REFERENCES manifest_revisions(id, world_id, content_hash)
  ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE worlds
  ADD CONSTRAINT worlds_current_approved_manifest_revision_world_fk
  FOREIGN KEY (current_approved_manifest_revision_id, id)
  REFERENCES manifest_revisions(id, world_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE manifest_validation_reports (
  id uuid PRIMARY KEY,
  manifest_revision_id uuid NOT NULL REFERENCES manifest_revisions(id) ON DELETE RESTRICT,
  validator_version integer NOT NULL,
  primitive_catalog_snapshot_hash bytea NOT NULL,
  valid boolean NOT NULL,
  diagnostics jsonb NOT NULL,
  report_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manifest_validation_reports_identity_unique UNIQUE (
    manifest_revision_id, validator_version, primitive_catalog_snapshot_hash
  ),
  CONSTRAINT manifest_validation_reports_validator_known CHECK (validator_version = 1),
  CONSTRAINT manifest_validation_reports_catalog_hash_length CHECK (
    octet_length(primitive_catalog_snapshot_hash) = 32
  ),
  CONSTRAINT manifest_validation_reports_diagnostics_bounded CHECK (
    jsonb_typeof(diagnostics) = 'array'
    AND pg_column_size(diagnostics) <= 131072
    AND NOT worldgraph_jsonb_has_sensitive_key(diagnostics)
  ),
  CONSTRAINT manifest_validation_reports_report_hash_length CHECK (
    octet_length(report_hash) = 32
  )
);
--> statement-breakpoint
CREATE INDEX manifest_validation_reports_revision_lookup_idx
  ON manifest_validation_reports (manifest_revision_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE manifest_field_provenance (
  manifest_revision_id uuid NOT NULL REFERENCES manifest_revisions(id) ON DELETE RESTRICT,
  json_pointer text NOT NULL,
  source_type manifest_provenance_source NOT NULL,
  source_ref text NOT NULL,
  source_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_revision_id, json_pointer, source_type, source_ref),
  CONSTRAINT manifest_field_provenance_pointer_bounded CHECK (
    char_length(json_pointer) <= 500
    AND (json_pointer = '' OR left(json_pointer, 1) = '/')
    AND json_pointer !~ '[[:cntrl:]]'
  ),
  CONSTRAINT manifest_field_provenance_ref_bounded CHECK (
    char_length(source_ref) BETWEEN 1 AND 256
    AND source_ref = btrim(source_ref)
    AND source_ref !~ '[[:cntrl:]]'
  ),
  CONSTRAINT manifest_field_provenance_hash_length CHECK (octet_length(source_hash) = 32)
);
--> statement-breakpoint
CREATE INDEX manifest_field_provenance_source_idx
  ON manifest_field_provenance (source_type, source_hash, manifest_revision_id);
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_prompt_submission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.worlds w
      JOIN public.world_memberships m ON m.world_id = w.id
      WHERE w.id = NEW.world_id
        AND w.archived_at IS NULL
        AND m.user_id = NEW.submitted_by_user_id
        AND m.status = 'active'
        AND m.role IN ('creator', 'administrator')
    ) THEN
      RAISE EXCEPTION 'prompt submission requires active world edit authority'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prompt submission identity and hash are retained'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
    OR NEW.normalized_hash IS DISTINCT FROM OLD.normalized_hash
    OR NEW.client_seed IS DISTINCT FROM OLD.client_seed
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.retention_until IS DISTINCT FROM OLD.retention_until THEN
    RAISE EXCEPTION 'prompt submission provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.prompt_text IS NULL
    OR NEW.prompt_text IS NOT NULL
    OR OLD.redacted_at IS NOT NULL
    OR NEW.redacted_at IS NULL
    OR clock_timestamp() < OLD.retention_until
    OR NEW.redacted_at < OLD.retention_until
    OR NEW.redacted_at > clock_timestamp() THEN
    RAISE EXCEPTION 'prompt text may only be erased once after retention'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.manifest_generation_runs run
    WHERE run.prompt_submission_id = OLD.id
      AND run.status IN ('queued','running')
  ) THEN
    RAISE EXCEPTION 'prompt text cannot be erased while generation is active'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER world_prompt_submissions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON world_prompt_submissions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_prompt_submission();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_generation_retrieval_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_status manifest_generation_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'generation retrieval provenance is append-only'
      USING ERRCODE = '55000';
  END IF;
  SELECT status INTO run_status
  FROM public.manifest_generation_runs
  WHERE id = NEW.run_id
  FOR UPDATE;
  IF run_status IS DISTINCT FROM 'running'::manifest_generation_status THEN
    RAISE EXCEPTION 'retrieval provenance requires a running generation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER generation_retrieval_items_protect
  BEFORE INSERT OR UPDATE OR DELETE ON generation_retrieval_items
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_generation_retrieval_item();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_manifest_revision_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  revision_record record;
  revision_id uuid;
  run_status manifest_generation_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  revision_id := NEW.manifest_revision_id;
  SELECT approval_status, source, generation_run_id
  INTO revision_record
  FROM public.manifest_revisions
  WHERE id = revision_id
  FOR UPDATE;
  IF NOT FOUND OR revision_record.approval_status <> 'draft'::manifest_approval_status THEN
    RAISE EXCEPTION 'manifest child records require a draft revision'
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'manifest_field_provenance'
    AND revision_record.source = 'generation'::manifest_revision_source THEN
    SELECT status INTO run_status
    FROM public.manifest_generation_runs
    WHERE id = revision_record.generation_run_id
    FOR UPDATE;
    IF run_status IS DISTINCT FROM 'running'::manifest_generation_status THEN
      RAISE EXCEPTION 'generated field provenance must be sealed before run completion'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER manifest_validation_reports_protect
  BEFORE INSERT OR UPDATE OR DELETE ON manifest_validation_reports
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_manifest_revision_child();
--> statement-breakpoint
CREATE TRIGGER manifest_field_provenance_protect
  BEFORE INSERT OR UPDATE OR DELETE ON manifest_field_provenance
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_manifest_revision_child();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_manifest_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  expected_revision_number bigint;
  latest_report_id uuid;
  latest_report_valid boolean;
  parent_generation_warnings jsonb := '[]'::jsonb;
  parent_number bigint;
  required_warning_codes jsonb;
  run_record record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'manifest revisions are immutable'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.worlds
  WHERE id = COALESCE(NEW.world_id, OLD.world_id) AND archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manifest revisions require an active world'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_status <> 'draft'::manifest_approval_status
      OR NEW.row_version <> 1
      OR NEW.approved_by_user_id IS NOT NULL
      OR NEW.approved_at IS NOT NULL
      OR NEW.warning_acknowledgements <> '[]'::jsonb THEN
      RAISE EXCEPTION 'manifest revisions must be inserted as row-version-one drafts'
        USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(max(revision_number), 0) + 1
    INTO expected_revision_number
    FROM public.manifest_revisions
    WHERE world_id = NEW.world_id;
    IF NEW.revision_number <> expected_revision_number THEN
      RAISE EXCEPTION 'manifest revision number must be the next world revision'
        USING ERRCODE = '55000';
    END IF;
    IF expected_revision_number = 1 AND NEW.parent_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'the first manifest revision cannot have a parent'
        USING ERRCODE = '55000';
    ELSIF expected_revision_number > 1 THEN
      IF NEW.parent_revision_id IS NULL THEN
        RAISE EXCEPTION 'later manifest revisions require a parent'
          USING ERRCODE = '55000';
      END IF;
      SELECT revision_number, generation_warnings
      INTO parent_number, parent_generation_warnings
      FROM public.manifest_revisions
      WHERE id = NEW.parent_revision_id AND world_id = NEW.world_id;
      IF parent_number IS NULL OR parent_number >= NEW.revision_number THEN
        RAISE EXCEPTION 'manifest parent must be an earlier revision in the same world'
        USING ERRCODE = '55000';
      END IF;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.generation_warnings) AS warning(value)
      WHERE jsonb_typeof(value) <> 'object'
        OR value - 'code' - 'message' - 'pointer' <> '{}'::jsonb
        OR jsonb_typeof(value -> 'code') IS DISTINCT FROM 'string'
        OR (value ->> 'code') !~ '^[A-Z][A-Z0-9_]*$'
        OR char_length(value ->> 'code') > 100
        OR jsonb_typeof(value -> 'message') IS DISTINCT FROM 'string'
        OR char_length(value ->> 'message') NOT BETWEEN 1 AND 500
        OR jsonb_typeof(value -> 'pointer') IS DISTINCT FROM 'string'
        OR char_length(value ->> 'pointer') > 500
        OR ((value ->> 'pointer') <> '' AND left(value ->> 'pointer', 1) <> '/')
    ) THEN
      RAISE EXCEPTION 'manifest generation warning requirements are malformed'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.source IN ('manual'::manifest_revision_source, 'import'::manifest_revision_source)
      AND NEW.generation_warnings IS DISTINCT FROM parent_generation_warnings THEN
      RAISE EXCEPTION 'manual manifest revisions must inherit generation warnings exactly'
        USING ERRCODE = '55000';
    ELSIF NEW.source = 'generation'::manifest_revision_source
      AND NOT (NEW.generation_warnings @> parent_generation_warnings) THEN
      RAISE EXCEPTION 'generated manifest revisions must retain ancestor generation warnings'
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.world_memberships
      WHERE world_id = NEW.world_id
        AND user_id = NEW.created_by_user_id
        AND status = 'active'
        AND role IN ('creator', 'administrator')
    ) THEN
      RAISE EXCEPTION 'manifest revision author lacks active edit authority'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.source = 'generation'::manifest_revision_source THEN
      SELECT status, world_id, requested_by_user_id, output_revision_id, claim_token,
        parent_revision_id
      INTO run_record
      FROM public.manifest_generation_runs
      WHERE id = NEW.generation_run_id
      FOR UPDATE;
      IF NOT FOUND
        OR run_record.status <> 'running'::manifest_generation_status
        OR run_record.world_id <> NEW.world_id
        OR run_record.requested_by_user_id <> NEW.created_by_user_id
        OR run_record.output_revision_id IS NOT NULL
        OR run_record.parent_revision_id IS DISTINCT FROM NEW.parent_revision_id
        OR run_record.claim_token IS DISTINCT FROM NEW.generation_claim_token THEN
        RAISE EXCEPTION 'generated manifest revision requires the matching running generation'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
    OR NEW.manifest_schema_version IS DISTINCT FROM OLD.manifest_schema_version
    OR NEW.canonical_manifest IS DISTINCT FROM OLD.canonical_manifest
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.generation_run_id IS DISTINCT FROM OLD.generation_run_id
    OR NEW.generation_claim_token IS DISTINCT FROM OLD.generation_claim_token
    OR NEW.generation_warnings IS DISTINCT FROM OLD.generation_warnings
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'manifest revision content and provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'manifest revision update must advance row version'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.approval_status = 'draft'::manifest_approval_status
    AND NEW.approval_status = 'approved'::manifest_approval_status THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.world_memberships
      WHERE world_id = NEW.world_id
        AND user_id = NEW.approved_by_user_id
        AND status = 'active'
        AND role = 'creator'
    ) THEN
      RAISE EXCEPTION 'manifest approval requires the active world creator'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.manifest_revisions newer
      WHERE newer.world_id = NEW.world_id
        AND newer.revision_number > NEW.revision_number
    ) THEN
      RAISE EXCEPTION 'manifest approval requires the latest world revision'
        USING ERRCODE = '55000';
    END IF;
    SELECT id, valid INTO latest_report_id, latest_report_valid
    FROM public.manifest_validation_reports
    WHERE manifest_revision_id = NEW.id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
    IF latest_report_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'manifest approval requires a latest valid report'
        USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(jsonb_agg(to_jsonb(required.code) ORDER BY required.code), '[]'::jsonb)
    INTO required_warning_codes
    FROM (
      SELECT DISTINCT value ->> 'code' AS code
      FROM jsonb_array_elements(NEW.generation_warnings) AS warning(value)
      WHERE jsonb_typeof(value -> 'code') = 'string'
      UNION
      SELECT DISTINCT value ->> 'code' AS code
      FROM public.manifest_validation_reports report,
           jsonb_array_elements(report.diagnostics) AS diagnostic(value)
      WHERE report.id = latest_report_id
        AND value ->> 'severity' = 'warning'
        AND jsonb_typeof(value -> 'code') = 'string'
    ) required;
    IF NEW.warning_acknowledgements IS DISTINCT FROM required_warning_codes THEN
      RAISE EXCEPTION 'manifest approval requires exact warning acknowledgements'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.approval_status = 'draft'::manifest_approval_status
    AND NEW.approval_status = 'rejected'::manifest_approval_status THEN
    NULL;
  ELSIF OLD.approval_status = 'approved'::manifest_approval_status
    AND NEW.approval_status = 'superseded'::manifest_approval_status THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.warning_acknowledgements IS DISTINCT FROM OLD.warning_acknowledgements THEN
      RAISE EXCEPTION 'approved manifest provenance is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'manifest approval status transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER manifest_revisions_protect
  BEFORE INSERT OR UPDATE OR DELETE ON manifest_revisions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_manifest_revision();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_manifest_generation_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  output_record record;
  provider_ledger record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'manifest generation runs are durable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued'::manifest_generation_status
      OR NEW.attempts <> 0
      OR NEW.repair_attempts <> 0
      OR NEW.provider_call_count <> 0
      OR NEW.stage <> 'queued'
      OR NEW.progress_percent <> 0
      OR NEW.row_version <> 1
      OR NEW.generation_mode IS NOT NULL
      OR NEW.provider IS NOT NULL
      OR NEW.model IS NOT NULL
      OR NEW.primitive_catalog_snapshot_hash IS NOT NULL
      OR NEW.resolved_input_hash IS NOT NULL
      OR NEW.output_review IS NOT NULL
      OR NEW.output_revision_id IS NOT NULL
      OR NEW.input_token_count IS NOT NULL
      OR NEW.output_token_count IS NOT NULL
      OR NEW.cost_estimate_microunits IS NOT NULL
      OR NEW.latency_ms IS NOT NULL
      OR NEW.error_code IS NOT NULL
      OR NEW.claim_token IS NOT NULL
      OR NEW.claimed_at IS NOT NULL
      OR NEW.heartbeat_at IS NOT NULL
      OR NEW.started_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'manifest generation runs must be inserted as pristine queued work'
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.world_prompt_submissions p
      JOIN public.worlds w ON w.id = p.world_id AND w.archived_at IS NULL
      JOIN public.world_memberships m ON m.world_id = p.world_id
      WHERE p.id = NEW.prompt_submission_id
        AND p.world_id = NEW.world_id
        AND p.prompt_text IS NOT NULL
        AND p.submitted_by_user_id = NEW.requested_by_user_id
        AND m.user_id = NEW.requested_by_user_id
        AND m.status = 'active'
        AND m.role IN ('creator', 'administrator')
      FOR SHARE OF p
    ) THEN
      RAISE EXCEPTION 'manifest generation requires the prompt submitter edit authority'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.prompt_submission_id IS DISTINCT FROM OLD.prompt_submission_id
    OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR NEW.generator_schema_version IS DISTINCT FROM OLD.generator_schema_version
    OR NEW.prompt_template_version IS DISTINCT FROM OLD.prompt_template_version
    OR NEW.provider_configuration_id IS DISTINCT FROM OLD.provider_configuration_id
    OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
    OR NEW.expected_parent_content_hash IS DISTINCT FROM OLD.expected_parent_content_hash
    OR NEW.seed IS DISTINCT FROM OLD.seed
    OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.queued_at IS DISTINCT FROM OLD.queued_at THEN
    RAISE EXCEPTION 'manifest generation input provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'manifest generation update must advance row version and timestamp'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.progress_percent < OLD.progress_percent
    OR NEW.repair_attempts < OLD.repair_attempts
    OR NEW.provider_call_count < OLD.provider_call_count
    OR NEW.next_attempt_at < OLD.next_attempt_at
    OR (
      OLD.input_token_count IS NOT NULL
      AND (NEW.input_token_count IS NULL OR NEW.input_token_count < OLD.input_token_count)
    )
    OR (
      OLD.output_token_count IS NOT NULL
      AND (NEW.output_token_count IS NULL OR NEW.output_token_count < OLD.output_token_count)
    )
    OR (
      OLD.cost_estimate_microunits IS NOT NULL
      AND (
        NEW.cost_estimate_microunits IS NULL
        OR NEW.cost_estimate_microunits < OLD.cost_estimate_microunits
      )
    )
    OR (
      OLD.latency_ms IS NOT NULL
      AND (NEW.latency_ms IS NULL OR NEW.latency_ms < OLD.latency_ms)
    ) THEN
    RAISE EXCEPTION 'manifest generation progress and metrics are monotonic'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'manifest generation start time is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.primitive_catalog_snapshot_hash IS NOT NULL
    AND (
      NEW.primitive_catalog_snapshot_hash IS DISTINCT FROM
        OLD.primitive_catalog_snapshot_hash
      OR NEW.resolved_input_hash IS DISTINCT FROM OLD.resolved_input_hash
    ) THEN
    RAISE EXCEPTION 'generation catalog snapshot is immutable once recorded'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.output_review IS NOT NULL
    AND NEW.output_review IS DISTINCT FROM OLD.output_review THEN
    RAISE EXCEPTION 'generation output review is immutable once recorded'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.provider IS NOT NULL
    AND (
      NEW.provider IS DISTINCT FROM OLD.provider
      OR NEW.model IS DISTINCT FROM OLD.model
    ) THEN
    RAISE EXCEPTION 'generation provider identity is immutable once recorded'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.generation_mode = 'fallback'::manifest_generation_mode
    AND NEW.generation_mode IS DISTINCT FROM OLD.generation_mode THEN
    RAISE EXCEPTION 'fallback generation mode cannot be reversed'
      USING ERRCODE = '55000';
  END IF;
  IF (
      NEW.generation_mode IS DISTINCT FROM OLD.generation_mode
      OR NEW.provider IS DISTINCT FROM OLD.provider
      OR NEW.model IS DISTINCT FROM OLD.model
      OR NEW.primitive_catalog_snapshot_hash IS DISTINCT FROM
        OLD.primitive_catalog_snapshot_hash
      OR NEW.resolved_input_hash IS DISTINCT FROM OLD.resolved_input_hash
      OR NEW.output_review IS DISTINCT FROM OLD.output_review
      OR NEW.provider_call_count IS DISTINCT FROM OLD.provider_call_count
      OR NEW.input_token_count IS DISTINCT FROM OLD.input_token_count
      OR NEW.output_token_count IS DISTINCT FROM OLD.output_token_count
      OR NEW.cost_estimate_microunits IS DISTINCT FROM OLD.cost_estimate_microunits
      OR NEW.latency_ms IS DISTINCT FROM OLD.latency_ms
    )
    AND NOT (
      NEW.status = 'running'::manifest_generation_status
      OR OLD.status = 'running'::manifest_generation_status
    ) THEN
    RAISE EXCEPTION 'generation execution metadata may only change during execution'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'queued'::manifest_generation_status
    AND NEW.status = 'running'::manifest_generation_status THEN
    IF NEW.attempts <> OLD.attempts + 1
      OR NEW.repair_attempts <> OLD.repair_attempts
      OR NEW.provider_call_count <> OLD.provider_call_count
      OR NEW.claim_token IS NULL
      OR NEW.claimed_at IS NULL
      OR NEW.heartbeat_at IS NULL
      OR NEW.claimed_at < OLD.updated_at
      OR NEW.heartbeat_at < NEW.claimed_at
      OR NEW.started_at IS NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at THEN
      RAISE EXCEPTION 'queued generation claim is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'queued'::manifest_generation_status
    AND NEW.status = 'cancelled'::manifest_generation_status THEN
    IF NEW.attempts <> OLD.attempts
      OR NEW.repair_attempts <> OLD.repair_attempts
      OR NEW.provider_call_count <> OLD.provider_call_count
      OR NEW.claim_token IS NOT NULL
      OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at THEN
      RAISE EXCEPTION 'queued generation cancellation is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'running'::manifest_generation_status
    AND NEW.status = 'running'::manifest_generation_status THEN
    IF NEW.attempts <> OLD.attempts
      OR NEW.repair_attempts > OLD.repair_attempts + 1
      OR NEW.provider_call_count > OLD.provider_call_count + 1
      OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
      OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      OR NEW.heartbeat_at < OLD.heartbeat_at
      OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
      OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'running generation heartbeat or progress is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'running'::manifest_generation_status
    AND NEW.status = 'queued'::manifest_generation_status THEN
    IF NEW.attempts <> OLD.attempts
      OR NEW.repair_attempts <> OLD.repair_attempts
      OR NEW.provider_call_count <> OLD.provider_call_count
      OR NEW.claim_token IS NOT NULL
      OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.next_attempt_at < NEW.updated_at
      OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'generation recovery must release its lease and retain provenance'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'running'::manifest_generation_status
    AND NEW.status IN (
      'succeeded'::manifest_generation_status,
      'failed'::manifest_generation_status,
      'cancelled'::manifest_generation_status
    ) THEN
    IF NEW.attempts <> OLD.attempts
      OR NEW.repair_attempts <> OLD.repair_attempts
      OR NEW.provider_call_count <> OLD.provider_call_count
      OR NEW.claim_token IS NOT NULL
      OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.completed_at IS NULL
      OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at THEN
      RAISE EXCEPTION 'terminal generation transition is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'manifest generation status transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> 'succeeded'::manifest_generation_status
    AND EXISTS (
      SELECT 1 FROM public.manifest_revisions WHERE generation_run_id = OLD.id
    ) THEN
    RAISE EXCEPTION 'generation with an output revision must complete successfully'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'succeeded'::manifest_generation_status THEN
    SELECT count(*)::integer AS call_count,
      count(*) FILTER (WHERE call.status = 'settled')::integer AS settled_count,
      count(*) FILTER (
        WHERE call.call_kind = 'repair' AND call.status <> 'released'
      )::integer AS repair_call_count,
      bool_and(call.provider = NEW.provider AND call.model = NEW.model) AS identity_matches,
      coalesce(sum(case
        when call.status = 'settled' then call.actual_cost_microunits
        when call.status = 'reserved' then call.reserved_cost_microunits
        else 0
      end),0)::bigint AS effective_cost,
      coalesce(sum(case
        when call.status = 'settled' then call.actual_input_tokens
        when call.status = 'reserved' then call.reserved_input_tokens
        else 0
      end),0)::bigint AS effective_input,
      coalesce(sum(case
        when call.status = 'settled' then call.actual_output_tokens
        when call.status = 'reserved' then call.reserved_output_tokens
        else 0
      end),0)::bigint AS effective_output
    INTO provider_ledger
    FROM public.manifest_provider_calls call
    WHERE call.run_id = NEW.id;
    IF provider_ledger.call_count <> NEW.provider_call_count
      OR provider_ledger.effective_cost <> coalesce(NEW.cost_estimate_microunits,0)
      OR provider_ledger.effective_input <> coalesce(NEW.input_token_count,0)
      OR provider_ledger.effective_output <> coalesce(NEW.output_token_count,0)
      OR provider_ledger.repair_call_count > 2
      OR (
        provider_ledger.repair_call_count > 0
        AND NEW.repair_attempts < 1
      )
      OR (
        provider_ledger.call_count > 0
        AND provider_ledger.identity_matches IS DISTINCT FROM true
      ) THEN
      RAISE EXCEPTION 'successful generation provider accounting must match its durable ledger'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.generation_mode = 'provider'::manifest_generation_mode
      AND (
        NEW.provider_configuration_id = 'disabled-v1'
        OR provider_ledger.settled_count < 1
      ) THEN
      RAISE EXCEPTION 'provider generation requires an enabled configuration and settled call'
        USING ERRCODE = '55000';
    END IF;
    SELECT world_id, generation_run_id, generation_claim_token, generation_warnings,
      approval_status
    INTO output_record
    FROM public.manifest_revisions
    WHERE id = NEW.output_revision_id;
    IF NOT FOUND
      OR output_record.world_id <> NEW.world_id
      OR output_record.generation_run_id <> NEW.id
      OR output_record.generation_claim_token IS DISTINCT FROM OLD.claim_token
      OR output_record.generation_warnings IS DISTINCT FROM NEW.output_review -> 'warnings'
      OR output_record.approval_status <> 'draft'::manifest_approval_status THEN
      RAISE EXCEPTION 'successful generation must identify its matching draft output'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER manifest_generation_runs_protect
  BEFORE INSERT OR UPDATE OR DELETE ON manifest_generation_runs
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_manifest_generation_run();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_manifest_provider_call()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_record record;
  expected_call_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'manifest provider accounting is durable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved'
      OR NEW.actual_cost_microunits IS NOT NULL
      OR NEW.actual_input_tokens IS NOT NULL
      OR NEW.actual_output_tokens IS NOT NULL
      OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider calls must begin as pristine reservations'
        USING ERRCODE = '55000';
    END IF;
    SELECT status, claim_token, attempts, provider_configuration_id, provider_call_count
      INTO run_record
      FROM public.manifest_generation_runs
      WHERE id = NEW.run_id;
    SELECT coalesce(max(call_number),0) + 1 INTO expected_call_number
      FROM public.manifest_provider_calls WHERE run_id = NEW.run_id;
    IF run_record.status IS NULL
      OR run_record.status <> 'running'::manifest_generation_status
      OR run_record.claim_token IS DISTINCT FROM NEW.claim_token
      OR run_record.attempts <> NEW.run_attempt
      OR run_record.provider_configuration_id <> NEW.provider_configuration_id
      OR NEW.call_number <> expected_call_number
      OR NEW.call_number <> run_record.provider_call_count + 1 THEN
      RAISE EXCEPTION 'provider call reservation does not match the active generation claim'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.run_attempt IS DISTINCT FROM OLD.run_attempt
    OR NEW.call_number IS DISTINCT FROM OLD.call_number
    OR NEW.call_kind IS DISTINCT FROM OLD.call_kind
    OR NEW.provider_configuration_id IS DISTINCT FROM OLD.provider_configuration_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.usage_date IS DISTINCT FROM OLD.usage_date
    OR NEW.reserved_cost_microunits IS DISTINCT FROM OLD.reserved_cost_microunits
    OR NEW.reserved_input_tokens IS DISTINCT FROM OLD.reserved_input_tokens
    OR NEW.reserved_output_tokens IS DISTINCT FROM OLD.reserved_output_tokens
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'provider call reservation provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'reserved'
    OR NEW.status NOT IN ('settled','released')
    OR NEW.settled_at IS NULL
    OR NEW.settled_at < OLD.created_at THEN
    RAISE EXCEPTION 'provider call settlement transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER manifest_provider_calls_protect
  BEFORE INSERT OR UPDATE OR DELETE ON manifest_provider_calls
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_manifest_provider_call();
--> statement-breakpoint
CREATE FUNCTION worldgraph_reserve_manifest_provider_call(
  requested_id uuid,
  requested_run_id uuid,
  requested_claim_token uuid,
  requested_run_attempt integer,
  requested_call_kind text,
  requested_configuration_id text,
  requested_provider text,
  requested_model text,
  daily_budget_microunits bigint,
  requested_cost_microunits bigint,
  requested_input_tokens integer,
  requested_output_tokens integer,
  maximum_provider_calls integer
)
RETURNS TABLE (
  id uuid,
  reserved_cost_microunits bigint,
  reserved_input_tokens integer,
  reserved_output_tokens integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  utc_usage_date date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  already_reserved bigint;
  granted_cost bigint;
  next_call integer;
BEGIN
  IF requested_id IS NULL
    OR requested_run_id IS NULL
    OR requested_claim_token IS NULL
    OR requested_run_attempt NOT BETWEEN 1 AND 3
    OR requested_call_kind NOT IN ('generate','repair')
    OR char_length(requested_configuration_id) NOT BETWEEN 1 AND 120
    OR char_length(requested_provider) NOT BETWEEN 1 AND 120
    OR char_length(requested_model) NOT BETWEEN 1 AND 160
    OR requested_configuration_id <> btrim(requested_configuration_id)
    OR requested_provider <> btrim(requested_provider)
    OR requested_model <> btrim(requested_model)
    OR requested_configuration_id ~ '[[:cntrl:]]'
    OR requested_provider ~ '[[:cntrl:]]'
    OR requested_model ~ '[[:cntrl:]]'
    OR requested_configuration_id = 'disabled-v1'
    OR daily_budget_microunits NOT BETWEEN 0 AND 2147483647
    OR requested_cost_microunits NOT BETWEEN 0 AND 2147483647
    OR requested_input_tokens NOT BETWEEN 1 AND 100000
    OR requested_output_tokens NOT BETWEEN 1 AND 100000
    OR maximum_provider_calls NOT BETWEEN 1 AND 9 THEN
    RAISE EXCEPTION 'manifest provider reservation input is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('manifest-provider-budget:' || utc_usage_date::text, 0)
  );
  PERFORM 1 FROM public.manifest_generation_runs
    WHERE manifest_generation_runs.id = requested_run_id
      AND status = 'running'::manifest_generation_status
      AND claim_token = requested_claim_token
      AND attempts = requested_run_attempt
      AND provider_configuration_id = requested_configuration_id
      AND provider_call_count < maximum_provider_calls
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF requested_call_kind = 'repair'
    AND (
      SELECT count(*)
      FROM public.manifest_provider_calls call
      WHERE call.run_id = requested_run_id
        AND call.call_kind = 'repair'
        AND call.status <> 'released'
    ) >= 2 THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(case
      when call.status = 'settled' then call.actual_cost_microunits
      when call.status = 'reserved' then call.reserved_cost_microunits
      else 0
    end),0)
    INTO already_reserved
    FROM public.manifest_provider_calls call
    WHERE call.usage_date = utc_usage_date;
  IF requested_cost_microunits > 0
    AND already_reserved >= daily_budget_microunits THEN
    RETURN;
  END IF;
  granted_cost := least(
    requested_cost_microunits,
    greatest(daily_budget_microunits - already_reserved, 0)
  );
  SELECT coalesce(max(call_number),0) + 1 INTO next_call
    FROM public.manifest_provider_calls WHERE run_id = requested_run_id;

  INSERT INTO public.manifest_provider_calls (
    id, run_id, claim_token, run_attempt, call_number, call_kind,
    provider_configuration_id, provider, model, usage_date,
    reserved_cost_microunits, reserved_input_tokens, reserved_output_tokens
  ) VALUES (
    requested_id, requested_run_id, requested_claim_token, requested_run_attempt,
    next_call, requested_call_kind, requested_configuration_id,
    requested_provider, requested_model, utc_usage_date,
    granted_cost, requested_input_tokens, requested_output_tokens
  );
  UPDATE public.manifest_generation_runs
    SET provider_call_count = provider_call_count + 1,
        updated_at = clock_timestamp(), row_version = row_version + 1
    WHERE manifest_generation_runs.id = requested_run_id
      AND status = 'running'::manifest_generation_status
      AND claim_token = requested_claim_token
      AND attempts = requested_run_attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manifest generation claim was lost during provider reservation'
      USING ERRCODE = '40001';
  END IF;
  RETURN QUERY SELECT requested_id, granted_cost,
    requested_input_tokens, requested_output_tokens;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_settle_manifest_provider_call(
  requested_id uuid,
  requested_run_id uuid,
  requested_claim_token uuid,
  requested_run_attempt integer,
  actual_cost bigint,
  actual_input integer,
  actual_output integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  settled_call record;
BEGIN
  IF actual_cost NOT BETWEEN 0 AND 2147483647
    OR actual_input NOT BETWEEN 0 AND 100000
    OR actual_output NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'manifest provider settlement input is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT provider, model, reserved_cost_microunits,
         reserved_input_tokens, reserved_output_tokens
    INTO settled_call
    FROM public.manifest_provider_calls
    WHERE id = requested_id AND run_id = requested_run_id
      AND claim_token = requested_claim_token AND run_attempt = requested_run_attempt
      AND status = 'reserved'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF actual_cost > settled_call.reserved_cost_microunits
    OR actual_input > settled_call.reserved_input_tokens
    OR actual_output > settled_call.reserved_output_tokens THEN
    RAISE EXCEPTION 'provider usage exceeded its durable reservation'
      USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.manifest_generation_runs
    WHERE id = requested_run_id
      AND status = 'running'::manifest_generation_status
      AND claim_token = requested_claim_token AND attempts = requested_run_attempt
      AND (provider IS NULL OR provider = settled_call.provider)
      AND (model IS NULL OR model = settled_call.model)
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manifest generation claim was lost before provider settlement'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.manifest_provider_calls
    SET status = 'settled', actual_cost_microunits = actual_cost,
        actual_input_tokens = actual_input, actual_output_tokens = actual_output,
        settled_at = clock_timestamp()
    WHERE id = requested_id AND run_id = requested_run_id
      AND claim_token = requested_claim_token AND run_attempt = requested_run_attempt
      AND status = 'reserved'
    RETURNING provider, model INTO settled_call;
  UPDATE public.manifest_generation_runs
    SET provider = coalesce(provider, settled_call.provider),
        model = coalesce(model, settled_call.model),
        input_token_count = coalesce(input_token_count,0) + actual_input,
        output_token_count = coalesce(output_token_count,0) + actual_output,
        cost_estimate_microunits = coalesce(cost_estimate_microunits,0) + actual_cost,
        updated_at = clock_timestamp(), row_version = row_version + 1
    WHERE id = requested_run_id
      AND status = 'running'::manifest_generation_status
      AND claim_token = requested_claim_token AND attempts = requested_run_attempt
      AND (provider IS NULL OR provider = settled_call.provider)
      AND (model IS NULL OR model = settled_call.model);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manifest generation claim was lost during provider settlement'
      USING ERRCODE = '40001';
  END IF;
  RETURN true;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_release_manifest_provider_call(
  requested_id uuid,
  requested_run_id uuid,
  requested_claim_token uuid,
  requested_run_attempt integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM 1 FROM public.manifest_generation_runs
    WHERE id = requested_run_id
      AND status = 'running'::manifest_generation_status
      AND claim_token = requested_claim_token AND attempts = requested_run_attempt
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manifest generation claim was lost before provider reservation release'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.manifest_provider_calls
    SET status = 'released', settled_at = clock_timestamp()
    WHERE id = requested_id AND run_id = requested_run_id
      AND claim_token = requested_claim_token AND run_attempt = requested_run_attempt
      AND status = 'reserved';
  RETURN FOUND;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_reserve_manifest_provider_call(
  uuid, uuid, uuid, integer, text, text, text, text,
  bigint, bigint, integer, integer, integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_settle_manifest_provider_call(
  uuid, uuid, uuid, integer, bigint, integer, integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worldgraph_release_manifest_provider_call(
  uuid, uuid, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_world_manifest_pointer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.current_approved_manifest_revision_id IS NOT DISTINCT FROM
      OLD.current_approved_manifest_revision_id
    AND NEW.manifest_schema_version IS NOT DISTINCT FROM OLD.manifest_schema_version THEN
    RETURN NEW;
  END IF;
  IF OLD.current_approved_manifest_revision_id IS NOT NULL
    AND NEW.current_approved_manifest_revision_id IS NULL THEN
    RAISE EXCEPTION 'approved manifest pointer cannot be cleared'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'manifest pointer update must advance world version and timestamp'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER worlds_protect_manifest_pointer
  BEFORE UPDATE OF current_approved_manifest_revision_id, manifest_schema_version ON worlds
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_world_manifest_pointer();
--> statement-breakpoint
CREATE FUNCTION worldgraph_assert_world_manifest_pointer(checked_world_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  approved_count integer;
  approved_id uuid;
  world_record record;
BEGIN
  SELECT current_approved_manifest_revision_id, manifest_schema_version
  INTO world_record
  FROM public.worlds
  WHERE id = checked_world_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count(*)::integer, min(id::text)::uuid
  INTO approved_count, approved_id
  FROM public.manifest_revisions
  WHERE world_id = checked_world_id AND approval_status = 'approved';
  IF world_record.current_approved_manifest_revision_id IS NULL THEN
    IF approved_count <> 0 OR world_record.manifest_schema_version IS NOT NULL THEN
      RAISE EXCEPTION 'approved manifest requires the matching world pointer'
        USING ERRCODE = '23514',
              CONSTRAINT = 'worlds_current_approved_manifest_consistent';
    END IF;
  ELSIF approved_count <> 1
    OR approved_id <> world_record.current_approved_manifest_revision_id
    OR NOT EXISTS (
      SELECT 1 FROM public.manifest_revisions
      WHERE id = world_record.current_approved_manifest_revision_id
        AND world_id = checked_world_id
        AND approval_status = 'approved'
        AND manifest_schema_version = world_record.manifest_schema_version
    ) THEN
    RAISE EXCEPTION 'world approved manifest pointer is inconsistent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'worlds_current_approved_manifest_consistent';
  END IF;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION worldgraph_enforce_world_manifest_pointer()
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
  PERFORM public.worldgraph_assert_world_manifest_pointer(checked_world_id);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER worlds_require_current_approved_manifest
  AFTER INSERT OR UPDATE ON worlds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_world_manifest_pointer();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER manifest_revisions_require_world_pointer
  AFTER INSERT OR UPDATE OR DELETE ON manifest_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION worldgraph_enforce_world_manifest_pointer();
--> statement-breakpoint
DO $metadata$
DECLARE
  changed integer;
BEGIN
  UPDATE platform_metadata
  SET value = jsonb_set(
        jsonb_set(
          jsonb_set(value, '{contracts}', '4'::jsonb, true),
          '{runtimeSchema}', '4'::jsonb, true
        ),
        '{manifestSchema}', '1'::jsonb, true
      ),
      value_schema_version = 4,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 3
    AND value ->> 'contracts' = '3'
    AND value ->> 'runtimeSchema' = '3'
    AND value ->> 'manifestSchema' = '0'
    AND value ->> 'primitiveSchema' = '1';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact M03 compatibility state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT USAGE ON TYPE manifest_generation_status, manifest_generation_mode,
      manifest_revision_source,
      manifest_approval_status, manifest_provenance_source TO worldgraph_app;
    REVOKE UPDATE ON worlds FROM worldgraph_app;
    GRANT UPDATE (
      slug, name, lifecycle, row_version, updated_at, archived_at,
      current_approved_manifest_revision_id, manifest_schema_version
    ) ON worlds TO worldgraph_app;
    GRANT SELECT, INSERT ON world_prompt_submissions TO worldgraph_app;
    GRANT UPDATE (prompt_text, redacted_at) ON world_prompt_submissions TO worldgraph_app;
    GRANT SELECT, INSERT ON manifest_generation_runs TO worldgraph_app;
    GRANT UPDATE (
      status, stage, progress_percent, generation_mode,
      provider, model,
      primitive_catalog_snapshot_hash, resolved_input_hash, output_review, output_revision_id,
      attempts, repair_attempts, input_token_count, output_token_count,
      cost_estimate_microunits, latency_ms, error_code, next_attempt_at,
      claim_token, claimed_at, heartbeat_at, started_at, completed_at,
      updated_at, row_version
    ) ON manifest_generation_runs TO worldgraph_app;
    GRANT SELECT ON manifest_provider_calls TO worldgraph_app;
    GRANT SELECT, INSERT ON generation_retrieval_items TO worldgraph_app;
    GRANT SELECT, INSERT ON manifest_revisions TO worldgraph_app;
    GRANT UPDATE (
      approval_status, approved_by_user_id, approved_at,
      warning_acknowledgements, row_version
    ) ON manifest_revisions TO worldgraph_app;
    GRANT SELECT, INSERT ON manifest_validation_reports, manifest_field_provenance
      TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION worldgraph_protect_prompt_submission(),
      worldgraph_protect_generation_retrieval_item(),
      worldgraph_protect_manifest_revision_child(),
      worldgraph_protect_manifest_revision(),
      worldgraph_protect_manifest_generation_run(),
      worldgraph_protect_manifest_provider_call(),
      worldgraph_reserve_manifest_provider_call(
        uuid, uuid, uuid, integer, text, text, text, text,
        bigint, bigint, integer, integer, integer
      ),
      worldgraph_settle_manifest_provider_call(
        uuid, uuid, uuid, integer, bigint, integer, integer
      ),
      worldgraph_release_manifest_provider_call(uuid, uuid, uuid, integer),
      worldgraph_protect_world_manifest_pointer(),
      worldgraph_assert_world_manifest_pointer(uuid),
      worldgraph_enforce_world_manifest_pointer() TO worldgraph_app;
  END IF;
END
$grant$;
