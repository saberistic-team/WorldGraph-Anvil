CREATE TYPE primitive_kind AS ENUM (
  'government', 'election', 'currency', 'tax', 'resource', 'production_recipe',
  'terrain', 'district', 'building', 'organization', 'office', 'legal_right',
  'player_role', 'visual_style', 'simulation_rule', 'event_template'
);
--> statement-breakpoint
CREATE TYPE primitive_lifecycle AS ENUM ('draft', 'published', 'deprecated');
--> statement-breakpoint
CREATE TYPE primitive_index_status AS ENUM (
  'pending', 'running', 'completed', 'failed', 'dead', 'stale', 'disabled'
);
--> statement-breakpoint
CREATE FUNCTION worldgraph_semver_sort_key(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
  core text;
  core_parts text[];
  core_with_prerelease text;
  identifier text;
  result text;
  prerelease text;
BEGIN
  core_with_prerelease := split_part(value, '+', 1);
  IF position('-' IN core_with_prerelease) > 0 THEN
    core := split_part(core_with_prerelease, '-', 1);
    prerelease := substring(core_with_prerelease FROM position('-' IN core_with_prerelease) + 1);
  ELSE
    core := core_with_prerelease;
    prerelease := NULL;
  END IF;
  core_parts := string_to_array(core, '.');
  IF cardinality(core_parts) <> 3 THEN
    RAISE EXCEPTION 'invalid strict SemVer' USING ERRCODE = '22023';
  END IF;
  result := lpad(length(core_parts[1])::text, 2, '0') || core_parts[1] || '.' ||
            lpad(length(core_parts[2])::text, 2, '0') || core_parts[2] || '.' ||
            lpad(length(core_parts[3])::text, 2, '0') || core_parts[3] || '|';
  IF prerelease IS NULL THEN
    RETURN result || '1';
  END IF;
  result := result || '0|';
  FOREACH identifier IN ARRAY string_to_array(prerelease, '.') LOOP
    IF identifier ~ '^[0-9]+$' THEN
      result := result || '0' || lpad(length(identifier)::text, 2, '0') || identifier || '!';
    ELSE
      result := result || '1' || identifier || '!';
    END IF;
  END LOOP;
  RETURN result;
END
$function$;
--> statement-breakpoint
INSERT INTO users (
  id, email, password_hash, display_name, status, platform_role, auth_version, row_version
)
VALUES (
  '155d9b48-4e26-5672-8854-9ff24f3262fd',
  'catalog-curator@system.invalid',
  '$argon2id$v=19$m=19456,t=2,p=1$N0Z5dUxFN2JvQmdMZ2dBbw$7L9h8uP2H4M5xV6nQ3kC1aJ0sD8fG2wR9tY4eU6iO1A',
  'Bundled catalog curator',
  'disabled',
  'user',
  1,
  1
)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
DO $curator$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = '155d9b48-4e26-5672-8854-9ff24f3262fd'
      AND email = 'catalog-curator@system.invalid'
      AND display_name = 'Bundled catalog curator'
      AND status = 'disabled'
      AND platform_role = 'user'
  ) THEN
    RAISE EXCEPTION 'bundled catalog curator identity conflicts with existing data'
      USING ERRCODE = '23505';
  END IF;
END
$curator$;
--> statement-breakpoint
CREATE TABLE primitive_families (
  id uuid PRIMARY KEY,
  stable_key extensions.citext NOT NULL,
  kind primitive_kind NOT NULL,
  display_name text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT primitive_families_stable_key_unique UNIQUE (stable_key),
  CONSTRAINT primitive_families_key_shape CHECK (
    char_length(stable_key::text) BETWEEN 5 AND 160
    AND stable_key::text = lower(stable_key::text)
    AND stable_key::text ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+(-[a-z0-9]+)*){2,}$'
  ),
  CONSTRAINT primitive_families_display_name_bounded CHECK (
    char_length(btrim(display_name)) BETWEEN 1 AND 120
    AND display_name = btrim(display_name)
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT primitive_families_timestamps_ordered CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE INDEX primitive_families_kind_key_idx ON primitive_families (kind, stable_key);
--> statement-breakpoint
CREATE TABLE primitive_versions (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES primitive_families(id) ON DELETE RESTRICT,
  semver text NOT NULL,
  semver_major numeric NOT NULL,
  semver_minor numeric NOT NULL,
  semver_patch numeric NOT NULL,
  semver_prerelease text,
  semver_build text,
  primitive_schema_version integer NOT NULL,
  lifecycle primitive_lifecycle NOT NULL DEFAULT 'draft',
  display_name text NOT NULL,
  documentation text NOT NULL,
  parameter_schema jsonb NOT NULL,
  defaults jsonb NOT NULL,
  compatibility jsonb NOT NULL,
  behavior_ref text,
  visual_hints jsonb NOT NULL,
  provenance jsonb NOT NULL,
  content_hash bytea NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  published_at timestamptz,
  deprecated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  deprecated_at timestamptz,
  deprecation_reason text,
  CONSTRAINT primitive_versions_family_semver_unique UNIQUE (family_id, semver),
  CONSTRAINT primitive_versions_content_identity UNIQUE (id, content_hash),
  CONSTRAINT primitive_versions_resolution_identity UNIQUE (id, family_id, content_hash),
  CONSTRAINT primitive_versions_semver_shape CHECK (
    char_length(semver) BETWEEN 5 AND 64
    AND semver ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
    AND semver_major >= 0 AND semver_minor >= 0 AND semver_patch >= 0
    AND semver_major = trunc(semver_major)
    AND semver_minor = trunc(semver_minor)
    AND semver_patch = trunc(semver_patch)
    AND semver_major = split_part(semver, '.', 1)::numeric
    AND semver_minor = split_part(semver, '.', 2)::numeric
    AND semver_patch = substring(split_part(semver, '.', 3) from '^[0-9]+')::numeric
    AND semver_prerelease IS NOT DISTINCT FROM substring(semver from '-([^+]+)')
    AND semver_build IS NOT DISTINCT FROM substring(semver from '\+(.+)$')
  ),
  CONSTRAINT primitive_versions_schema_version_known CHECK (primitive_schema_version = 1),
  CONSTRAINT primitive_versions_display_name_bounded CHECK (
    char_length(btrim(display_name)) BETWEEN 1 AND 120
    AND display_name = btrim(display_name)
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT primitive_versions_documentation_bounded CHECK (
    char_length(documentation) BETWEEN 1 AND 32000
    AND translate(documentation, E'\n\t', '') !~ '[[:cntrl:]]'
  ),
  CONSTRAINT primitive_versions_json_shapes CHECK (
    jsonb_typeof(parameter_schema) = 'object'
    AND jsonb_typeof(defaults) = 'object'
    AND jsonb_typeof(compatibility) = 'object'
    AND jsonb_typeof(visual_hints) = 'object'
    AND jsonb_typeof(provenance) = 'object'
    AND pg_column_size(parameter_schema) <= 65536
    AND pg_column_size(defaults) <= 32768
    AND pg_column_size(compatibility) <= 16384
    AND pg_column_size(visual_hints) <= 16384
    AND pg_column_size(provenance) <= 16384
    AND NOT worldgraph_jsonb_has_sensitive_key(provenance)
  ),
  CONSTRAINT primitive_versions_behavior_ref_bounded CHECK (
    behavior_ref IS NULL OR (
      char_length(behavior_ref) BETWEEN 1 AND 160
      AND behavior_ref ~ '^[a-z][a-z0-9._-]*$'
    )
  ),
  CONSTRAINT primitive_versions_hash_length CHECK (octet_length(content_hash) = 32),
  CONSTRAINT primitive_versions_row_version_positive CHECK (row_version > 0),
  CONSTRAINT primitive_versions_timestamps_ordered CHECK (updated_at >= created_at),
  CONSTRAINT primitive_versions_lifecycle_consistent CHECK (
    (lifecycle = 'draft'
      AND published_by_user_id IS NULL AND published_at IS NULL
      AND deprecated_by_user_id IS NULL AND deprecated_at IS NULL
      AND deprecation_reason IS NULL)
    OR (lifecycle = 'published'
      AND published_by_user_id IS NOT NULL AND published_at IS NOT NULL
      AND published_at >= created_at
      AND updated_at >= published_at
      AND deprecated_by_user_id IS NULL AND deprecated_at IS NULL
      AND deprecation_reason IS NULL)
    OR (lifecycle = 'deprecated'
      AND published_by_user_id IS NOT NULL AND published_at IS NOT NULL
      AND deprecated_by_user_id IS NOT NULL AND deprecated_at IS NOT NULL
      AND deprecated_at >= published_at
      AND updated_at >= deprecated_at
      AND char_length(btrim(deprecation_reason)) BETWEEN 10 AND 500
      AND deprecation_reason = btrim(deprecation_reason)
      AND deprecation_reason !~ '[[:cntrl:]]')
  )
);
--> statement-breakpoint
CREATE INDEX primitive_versions_family_lifecycle_idx
  ON primitive_versions (family_id, lifecycle, semver_major DESC, semver_minor DESC, semver_patch DESC, semver DESC);
--> statement-breakpoint
CREATE INDEX primitive_versions_lifecycle_published_idx
  ON primitive_versions (lifecycle, published_at DESC, id)
  WHERE lifecycle IN ('published', 'deprecated');
--> statement-breakpoint
CREATE INDEX primitive_versions_lifecycle_semver_idx
  ON primitive_versions (
    lifecycle,
    worldgraph_semver_sort_key(semver) COLLATE "C" DESC,
    semver COLLATE "C" DESC,
    id DESC
  );
--> statement-breakpoint
CREATE TABLE primitive_tags (
  primitive_version_id uuid NOT NULL REFERENCES primitive_versions(id) ON DELETE CASCADE,
  tag extensions.citext NOT NULL,
  PRIMARY KEY (primitive_version_id, tag),
  CONSTRAINT primitive_tags_shape CHECK (
    char_length(tag::text) BETWEEN 1 AND 64
    AND tag::text = lower(tag::text)
    AND tag::text ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  )
);
--> statement-breakpoint
CREATE INDEX primitive_tags_tag_version_idx ON primitive_tags (tag, primitive_version_id);
--> statement-breakpoint
CREATE TABLE primitive_dependencies (
  primitive_version_id uuid NOT NULL REFERENCES primitive_versions(id) ON DELETE CASCADE,
  dependency_family_id uuid NOT NULL REFERENCES primitive_families(id) ON DELETE RESTRICT,
  version_range text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  parameter_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_version_id uuid REFERENCES primitive_versions(id) ON DELETE RESTRICT,
  resolved_content_hash bytea,
  PRIMARY KEY (primitive_version_id, dependency_family_id),
  CONSTRAINT primitive_dependencies_no_self_edge CHECK (primitive_version_id <> resolved_version_id),
  CONSTRAINT primitive_dependencies_range_bounded CHECK (
    char_length(btrim(version_range)) BETWEEN 1 AND 100
    AND version_range = btrim(version_range)
    AND version_range !~ '[[:cntrl:]]'
  ),
  CONSTRAINT primitive_dependencies_mapping_bounded CHECK (
    jsonb_typeof(parameter_mapping) = 'object' AND pg_column_size(parameter_mapping) <= 16384
  ),
  CONSTRAINT primitive_dependencies_resolution_pair CHECK (
    (resolved_version_id IS NULL AND resolved_content_hash IS NULL)
    OR (resolved_version_id IS NOT NULL AND octet_length(resolved_content_hash) = 32)
  ),
  CONSTRAINT primitive_dependencies_resolution_identity
    FOREIGN KEY (resolved_version_id, dependency_family_id, resolved_content_hash)
    REFERENCES primitive_versions(id, family_id, content_hash)
    ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX primitive_dependencies_resolved_idx
  ON primitive_dependencies (resolved_version_id, primitive_version_id)
  WHERE resolved_version_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE primitive_search_documents (
  primitive_version_id uuid PRIMARY KEY,
  index_schema_version integer NOT NULL,
  content_hash bytea NOT NULL,
  search_vector tsvector NOT NULL,
  normalized_text text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT primitive_search_documents_version_hash_fk
    FOREIGN KEY (primitive_version_id, content_hash)
    REFERENCES primitive_versions(id, content_hash) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT primitive_search_documents_schema_known CHECK (index_schema_version = 1),
  CONSTRAINT primitive_search_documents_hash_length CHECK (octet_length(content_hash) = 32),
  CONSTRAINT primitive_search_documents_text_bounded CHECK (
    char_length(normalized_text) BETWEEN 1 AND 40000
    AND translate(normalized_text, E'\n\t', '') !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE INDEX primitive_search_documents_vector_idx
  ON primitive_search_documents USING gin (search_vector);
--> statement-breakpoint
CREATE TABLE primitive_embeddings (
  id uuid PRIMARY KEY,
  primitive_version_id uuid NOT NULL REFERENCES primitive_versions(id) ON DELETE CASCADE,
  provider_configuration_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL,
  content_hash bytea NOT NULL,
  embedding extensions.vector(1536) NOT NULL,
  token_estimate integer,
  cost_estimate_microunits bigint,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT primitive_embeddings_cache_unique UNIQUE (
    primitive_version_id, provider_configuration_id, model, content_hash
  ),
  CONSTRAINT primitive_embeddings_provider_bounded CHECK (
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
  CONSTRAINT primitive_embeddings_dimensions_exact CHECK (
    dimensions = 1536 AND extensions.vector_dims(embedding) = 1536
  ),
  CONSTRAINT primitive_embeddings_hash_length CHECK (octet_length(content_hash) = 32),
  CONSTRAINT primitive_embeddings_metrics_nonnegative CHECK (
    (token_estimate IS NULL OR token_estimate >= 0)
    AND (cost_estimate_microunits IS NULL OR cost_estimate_microunits >= 0)
    AND (latency_ms IS NULL OR latency_ms >= 0)
  )
);
--> statement-breakpoint
CREATE TABLE primitive_index_jobs (
  primitive_version_id uuid NOT NULL REFERENCES primitive_versions(id) ON DELETE CASCADE,
  content_hash bytea NOT NULL,
  index_schema_version integer NOT NULL,
  provider_configuration_id text NOT NULL,
  status primitive_index_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    primitive_version_id, content_hash, index_schema_version, provider_configuration_id
  ),
  CONSTRAINT primitive_index_jobs_hash_length CHECK (octet_length(content_hash) = 32),
  CONSTRAINT primitive_index_jobs_schema_known CHECK (index_schema_version = 1),
  CONSTRAINT primitive_index_jobs_provider_bounded CHECK (
    char_length(provider_configuration_id) BETWEEN 1 AND 120
    AND provider_configuration_id = btrim(provider_configuration_id)
    AND provider_configuration_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT primitive_index_jobs_attempts_bounded CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT primitive_index_jobs_error_allowlisted CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'PROVIDER_DISABLED', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED',
      'PROVIDER_FAILED', 'VECTOR_INVALID', 'CONTENT_STALE'
    )
  ),
  CONSTRAINT primitive_index_jobs_state_consistent CHECK (
    (status = 'pending' AND attempts = 0 AND claimed_at IS NULL
      AND completed_at IS NULL AND last_error_code IS NULL)
    OR (status = 'running' AND attempts BETWEEN 1 AND 5 AND claimed_at IS NOT NULL
      AND completed_at IS NULL AND last_error_code IS NULL)
    OR (status = 'failed' AND attempts BETWEEN 1 AND 4 AND claimed_at IS NOT NULL
      AND completed_at IS NULL AND last_error_code IS NOT NULL)
    OR (status IN ('dead', 'stale') AND attempts BETWEEN 1 AND 5
      AND claimed_at IS NOT NULL AND completed_at IS NOT NULL AND last_error_code IS NOT NULL)
    OR (status = 'completed' AND attempts BETWEEN 1 AND 5 AND claimed_at IS NOT NULL
      AND completed_at IS NOT NULL AND last_error_code IS NULL)
    OR (status = 'disabled' AND attempts BETWEEN 1 AND 5 AND claimed_at IS NOT NULL
      AND completed_at IS NOT NULL AND last_error_code = 'PROVIDER_DISABLED')
  ),
  CONSTRAINT primitive_index_jobs_timestamps_ordered CHECK (
    updated_at >= queued_at AND next_attempt_at >= queued_at
    AND (claimed_at IS NULL OR claimed_at >= queued_at)
    AND (completed_at IS NULL OR completed_at >= queued_at)
    AND (completed_at IS NULL OR claimed_at IS NULL OR completed_at >= claimed_at)
    AND (claimed_at IS NULL OR updated_at >= claimed_at)
    AND (completed_at IS NULL OR updated_at >= completed_at)
  )
);
--> statement-breakpoint
CREATE INDEX primitive_index_jobs_pending_idx
  ON primitive_index_jobs (next_attempt_at, queued_at, primitive_version_id)
  WHERE status IN ('pending', 'failed');
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_primitive_family()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.primitive_versions
    WHERE family_id = OLD.id AND lifecycle IN ('published', 'deprecated')
  ) THEN
    IF TG_OP = 'DELETE'
      OR NEW.stable_key IS DISTINCT FROM OLD.stable_key
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.display_name IS DISTINCT FROM OLD.display_name
      OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'published primitive family identity is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER primitive_families_protect_published
  BEFORE UPDATE OR DELETE ON primitive_families
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_primitive_family();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_primitive_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  family_record record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle <> 'draft' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'primitive versions must be inserted as row-version-one drafts'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.lifecycle <> 'draft' THEN
      RAISE EXCEPTION 'published primitive version is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  FOR family_record IN
    SELECT id FROM public.primitive_families
    WHERE id IN (OLD.family_id, NEW.family_id)
    ORDER BY id
    FOR UPDATE
  LOOP
    NULL;
  END LOOP;

  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'primitive version update must advance row version and timestamp'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle = 'deprecated' THEN
    RAISE EXCEPTION 'deprecated primitive version is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle = 'published' THEN
    IF NEW.lifecycle <> 'deprecated'
      OR NEW.family_id IS DISTINCT FROM OLD.family_id
      OR NEW.semver IS DISTINCT FROM OLD.semver
      OR NEW.semver_major IS DISTINCT FROM OLD.semver_major
      OR NEW.semver_minor IS DISTINCT FROM OLD.semver_minor
      OR NEW.semver_patch IS DISTINCT FROM OLD.semver_patch
      OR NEW.semver_prerelease IS DISTINCT FROM OLD.semver_prerelease
      OR NEW.semver_build IS DISTINCT FROM OLD.semver_build
      OR NEW.primitive_schema_version IS DISTINCT FROM OLD.primitive_schema_version
      OR NEW.display_name IS DISTINCT FROM OLD.display_name
      OR NEW.documentation IS DISTINCT FROM OLD.documentation
      OR NEW.parameter_schema IS DISTINCT FROM OLD.parameter_schema
      OR NEW.defaults IS DISTINCT FROM OLD.defaults
      OR NEW.compatibility IS DISTINCT FROM OLD.compatibility
      OR NEW.behavior_ref IS DISTINCT FROM OLD.behavior_ref
      OR NEW.visual_hints IS DISTINCT FROM OLD.visual_hints
      OR NEW.provenance IS DISTINCT FROM OLD.provenance
      OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
      OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.row_version <> OLD.row_version + 1 THEN
      RAISE EXCEPTION 'published primitive semantic content is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.lifecycle NOT IN ('draft', 'published') THEN
    RAISE EXCEPTION 'invalid primitive lifecycle transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'primitive provenance actor is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.lifecycle = 'published' THEN
    PERFORM target.id
    FROM public.primitive_dependencies d
    JOIN public.primitive_versions target ON target.id = d.resolved_version_id
    WHERE d.primitive_version_id = NEW.id
    ORDER BY target.id
    FOR SHARE OF target;
    IF NOT EXISTS (
      SELECT 1 FROM public.primitive_families f
      WHERE f.id = NEW.family_id AND f.display_name = NEW.display_name
    ) THEN
      RAISE EXCEPTION 'primitive family/version identity mismatch' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.primitive_dependencies d
      LEFT JOIN public.primitive_versions target ON target.id = d.resolved_version_id
      WHERE d.primitive_version_id = NEW.id
        AND (
          d.dependency_family_id = NEW.family_id
          OR (d.required AND d.resolved_version_id IS NULL)
          OR (d.resolved_version_id IS NOT NULL AND target.lifecycle <> 'published')
        )
    ) THEN
      RAISE EXCEPTION 'primitive publication dependencies are unresolved or invalid'
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.primitive_search_documents s
      WHERE s.primitive_version_id = NEW.id
        AND s.content_hash = NEW.content_hash
        AND s.index_schema_version = 1
    ) THEN
      RAISE EXCEPTION 'primitive publication requires a current lexical index'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER primitive_versions_protect_published
  BEFORE INSERT OR UPDATE OR DELETE ON primitive_versions
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_primitive_version();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_primitive_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  parent record;
  old_parent_id uuid;
  new_parent_id uuid;
BEGIN
  old_parent_id := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.primitive_version_id END;
  new_parent_id := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.primitive_version_id END;
  FOR parent IN
    SELECT id, family_id, lifecycle FROM public.primitive_versions
    WHERE id IN (old_parent_id, new_parent_id)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF parent.lifecycle IN ('published', 'deprecated') THEN
      RAISE EXCEPTION 'published primitive child records are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'primitive_dependencies'
      AND TG_OP <> 'DELETE'
      AND parent.id = NEW.primitive_version_id
      AND parent.family_id = (to_jsonb(NEW) ->> 'dependency_family_id')::uuid THEN
      RAISE EXCEPTION 'primitive family cannot depend on itself'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER primitive_tags_protect_published
  BEFORE INSERT OR UPDATE OR DELETE ON primitive_tags
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_primitive_child();
--> statement-breakpoint
CREATE TRIGGER primitive_dependencies_protect_published
  BEFORE INSERT OR UPDATE OR DELETE ON primitive_dependencies
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_primitive_child();
--> statement-breakpoint
CREATE FUNCTION worldgraph_protect_primitive_search_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
  parent record;
  old_parent_id uuid;
  new_parent_id uuid;
BEGIN
  old_parent_id := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.primitive_version_id END;
  new_parent_id := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.primitive_version_id END;
  FOR parent IN
    SELECT id, lifecycle, content_hash FROM public.primitive_versions
    WHERE id IN (old_parent_id, new_parent_id)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF parent.lifecycle IN ('published', 'deprecated') THEN
      RAISE EXCEPTION 'published primitive lexical index is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF TG_OP <> 'DELETE' AND parent.id = NEW.primitive_version_id
      AND (NEW.content_hash IS DISTINCT FROM parent.content_hash OR NEW.index_schema_version <> 1) THEN
      RAISE EXCEPTION 'primitive lexical index provenance is invalid'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER primitive_search_documents_protect_published
  BEFORE INSERT OR UPDATE OR DELETE ON primitive_search_documents
  FOR EACH ROW EXECUTE FUNCTION worldgraph_protect_primitive_search_document();
--> statement-breakpoint
DO $metadata$
DECLARE
  changed integer;
BEGIN
  UPDATE platform_metadata
  SET value = jsonb_set(
        jsonb_set(
          jsonb_set(value, '{contracts}', '3'::jsonb, true),
          '{runtimeSchema}', '3'::jsonb, true
        ),
        '{primitiveSchema}', '1'::jsonb, true
      ),
      value_schema_version = 3,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 2
    AND value ->> 'contracts' = '2'
    AND value ->> 'runtimeSchema' = '2'
    AND value ->> 'primitiveSchema' = '0';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'runtime_versions must be at the exact M02 compatibility state'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT USAGE ON TYPE primitive_kind, primitive_lifecycle, primitive_index_status
      TO worldgraph_app;
    GRANT SELECT, INSERT ON primitive_families TO worldgraph_app;
    GRANT UPDATE (display_name, updated_at) ON primitive_families TO worldgraph_app;
    GRANT SELECT, INSERT ON primitive_versions TO worldgraph_app;
    GRANT UPDATE (
      family_id, semver, semver_major, semver_minor, semver_patch, semver_prerelease,
      semver_build, primitive_schema_version, lifecycle, display_name, documentation,
      parameter_schema, defaults, compatibility, behavior_ref, visual_hints, provenance,
      content_hash, row_version, updated_at, published_by_user_id, published_at,
      deprecated_by_user_id, deprecated_at, deprecation_reason
    ) ON primitive_versions TO worldgraph_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON primitive_tags, primitive_dependencies
      TO worldgraph_app;
    GRANT SELECT, INSERT ON primitive_search_documents, primitive_embeddings TO worldgraph_app;
    GRANT UPDATE (
      index_schema_version, content_hash, search_vector, normalized_text, updated_at
    ) ON primitive_search_documents TO worldgraph_app;
    GRANT SELECT, INSERT ON primitive_index_jobs TO worldgraph_app;
    GRANT UPDATE (
      status, attempts, last_error_code, claimed_at, next_attempt_at, completed_at, updated_at
    ) ON primitive_index_jobs TO worldgraph_app;
    GRANT EXECUTE ON FUNCTION worldgraph_protect_primitive_family(),
      worldgraph_protect_primitive_version(), worldgraph_protect_primitive_child(),
      worldgraph_protect_primitive_search_document(), worldgraph_semver_sort_key(text)
      TO worldgraph_app;
  END IF;
END
$grant$;
