SET CONSTRAINTS ALL DEFERRED;
--> statement-breakpoint
SET search_path = pg_catalog, public, extensions;
--> statement-breakpoint
DO $metadata_guard$
DECLARE changed integer;
BEGIN
  UPDATE public.platform_metadata
  SET value = value,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 10
    AND value ->> 'compiler' = '1.3.0'
    AND value ->> 'compilerArtifactSchema' = '4'
    AND value ->> 'contracts' = '10'
    AND value ->> 'runtimeSchema' = '10'
    AND value ->> 'governanceSeedPlanSchema' = '1';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'exact sealed M10 metadata is required before geography migration'
      USING ERRCODE = '55000';
  END IF;
END
$metadata_guard$;
--> statement-breakpoint
CREATE TABLE public.spatial_reference_systems (
  world_id uuid PRIMARY KEY REFERENCES public.worlds(id),
  units text NOT NULL CHECK (units = 'meters'),
  origin_x_milli bigint NOT NULL,
  origin_y_milli bigint NOT NULL,
  bounds_min_x_milli bigint NOT NULL,
  bounds_min_y_milli bigint NOT NULL,
  bounds_max_x_milli bigint NOT NULL,
  bounds_max_y_milli bigint NOT NULL,
  srid integer NOT NULL CHECK (srid = 3857),
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  seed_plan_hash bytea NOT NULL,
  source_artifact_hash bytea NOT NULL,
  compiled_world_version_id uuid NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spatial_reference_bounds_ordered CHECK (
    bounds_min_x_milli < bounds_max_x_milli
    AND bounds_min_y_milli < bounds_max_y_milli
  )
);
--> statement-breakpoint
CREATE TABLE public.world_geography_heads (
  world_id uuid PRIMARY KEY REFERENCES public.worlds(id),
  geography_version bigint NOT NULL DEFAULT 0 CHECK (geography_version >= 0),
  geography_state_revision bigint NOT NULL DEFAULT 0,
  seed_plan_hash bytea,
  active_scene_plan_id uuid,
  active_scene_plan_checksum bytea,
  initialized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.territories (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id),
  stable_key extensions.citext NOT NULL,
  entity_logical_key extensions.citext,
  geom geometry(MultiPolygon, 3857) NOT NULL,
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  created_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT territories_world_stable_key UNIQUE (world_id, stable_key),
  CONSTRAINT territories_world_id UNIQUE (world_id, id),
  CONSTRAINT territories_geom_valid CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom))
);
--> statement-breakpoint
CREATE INDEX territories_geom_gix ON public.territories USING GIST (geom);
--> statement-breakpoint
CREATE TABLE public.districts (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id),
  territory_id uuid NOT NULL,
  stable_key extensions.citext NOT NULL,
  entity_logical_key extensions.citext,
  zoning text NOT NULL,
  geom geometry(Polygon, 3857) NOT NULL,
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  created_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT districts_world_stable_key UNIQUE (world_id, stable_key),
  CONSTRAINT districts_world_id UNIQUE (world_id, id),
  CONSTRAINT districts_world_territory FOREIGN KEY (world_id, territory_id)
    REFERENCES public.territories(world_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT districts_geom_valid CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom))
);
--> statement-breakpoint
CREATE INDEX districts_geom_gix ON public.districts USING GIST (geom);
--> statement-breakpoint
CREATE TABLE public.parcels (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id),
  district_id uuid NOT NULL,
  stable_key extensions.citext NOT NULL,
  parcel_type text NOT NULL,
  geom geometry(Polygon, 3857) NOT NULL,
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  created_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parcels_world_stable_key UNIQUE (world_id, stable_key),
  CONSTRAINT parcels_world_id UNIQUE (world_id, id),
  CONSTRAINT parcels_world_district FOREIGN KEY (world_id, district_id)
    REFERENCES public.districts(world_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT parcels_geom_valid CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom))
);
--> statement-breakpoint
CREATE INDEX parcels_geom_gix ON public.parcels USING GIST (geom);
--> statement-breakpoint
CREATE TABLE public.roads (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id),
  stable_key extensions.citext NOT NULL,
  road_class text NOT NULL CHECK (road_class IN ('primary', 'secondary', 'path')),
  width_milli bigint NOT NULL CHECK (width_milli > 0),
  from_district_id uuid NOT NULL,
  to_district_id uuid NOT NULL,
  geom geometry(LineString, 3857) NOT NULL,
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  created_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roads_world_stable_key UNIQUE (world_id, stable_key),
  CONSTRAINT roads_world_from_district FOREIGN KEY (world_id, from_district_id)
    REFERENCES public.districts(world_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT roads_world_to_district FOREIGN KEY (world_id, to_district_id)
    REFERENCES public.districts(world_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT roads_geom_valid CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom))
);
--> statement-breakpoint
CREATE INDEX roads_geom_gix ON public.roads USING GIST (geom);
--> statement-breakpoint
CREATE TABLE public.building_placements (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id),
  parcel_id uuid NOT NULL,
  stable_key extensions.citext NOT NULL,
  entity_logical_key extensions.citext NOT NULL,
  archetype text NOT NULL,
  centroid geometry(Point, 3857) NOT NULL,
  footprint geometry(Polygon, 3857) NOT NULL,
  elevation_milli bigint NOT NULL CHECK (elevation_milli >= 0),
  yaw_milli_degrees integer NOT NULL CHECK (yaw_milli_degrees >= 0 AND yaw_milli_degrees <= 359999),
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  created_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT building_placements_world_stable_key UNIQUE (world_id, stable_key),
  CONSTRAINT building_placements_world_entity UNIQUE (world_id, entity_logical_key),
  CONSTRAINT building_placements_world_parcel FOREIGN KEY (world_id, parcel_id)
    REFERENCES public.parcels(world_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT building_placements_geom_valid CHECK (
    ST_IsValid(centroid) AND ST_IsValid(footprint) AND NOT ST_IsEmpty(footprint)
  )
);
--> statement-breakpoint
CREATE INDEX building_placements_centroid_gix ON public.building_placements USING GIST (centroid);
--> statement-breakpoint
CREATE INDEX building_placements_footprint_gix ON public.building_placements USING GIST (footprint);
--> statement-breakpoint
CREATE TABLE public.points_of_interest (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id),
  stable_key extensions.citext NOT NULL,
  entity_logical_key extensions.citext NOT NULL,
  kind text NOT NULL,
  location geometry(Point, 3857) NOT NULL,
  radius_milli bigint NOT NULL CHECK (radius_milli > 0),
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  created_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT points_of_interest_world_stable_key UNIQUE (world_id, stable_key),
  CONSTRAINT points_of_interest_geom_valid CHECK (ST_IsValid(location))
);
--> statement-breakpoint
CREATE INDEX points_of_interest_gix ON public.points_of_interest USING GIST (location);
--> statement-breakpoint
CREATE TABLE public.spawn_points (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id),
  stable_key extensions.citext NOT NULL,
  location geometry(Point, 3857) NOT NULL,
  radius_milli bigint NOT NULL CHECK (radius_milli > 0),
  priority integer NOT NULL CHECK (priority >= 0 AND priority <= 1000),
  access_policy text NOT NULL CHECK (access_policy IN ('public', 'member')),
  active boolean NOT NULL DEFAULT true,
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  created_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spawn_points_world_stable_key UNIQUE (world_id, stable_key),
  CONSTRAINT spawn_points_geom_valid CHECK (ST_IsValid(location))
);
--> statement-breakpoint
CREATE INDEX spawn_points_gix ON public.spawn_points USING GIST (location);
--> statement-breakpoint
CREATE TABLE public.visual_scene_plans (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES public.worlds(id),
  geography_version bigint NOT NULL CHECK (geography_version >= 1),
  style_kit_version integer NOT NULL CHECK (style_kit_version = 1),
  compiler_version text NOT NULL,
  seed text NOT NULL,
  canonical_json jsonb NOT NULL,
  checksum bytea NOT NULL,
  status text NOT NULL CHECK (status = 'published'),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance jsonb NOT NULL,
  published_tick bigint NOT NULL,
  created_command_id uuid NOT NULL,
  created_event_id uuid NOT NULL,
  created_state_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visual_scene_plans_input_tuple UNIQUE (
    world_id, geography_version, style_kit_version, compiler_version, seed
  )
);
--> statement-breakpoint
CREATE TABLE public.visual_asset_catalog (
  asset_id extensions.citext PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  uri_reference text NOT NULL CHECK (uri_reference ~ '^asset://worldgraph/[a-z0-9][a-z0-9._/-]*$'),
  content_hash bytea NOT NULL,
  license text NOT NULL,
  provenance text NOT NULL,
  max_bytes integer NOT NULL CHECK (max_bytes > 0 AND max_bytes <= 4194304),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO public.visual_asset_catalog (
  asset_id, schema_version, uri_reference, content_hash, license, provenance, max_bytes
) VALUES
  (
    'kit.lowpoly.district',
    1,
    'asset://worldgraph/kit/lowpoly/district',
    decode(repeat('11', 32), 'hex'),
    'CC0-1.0',
    'WorldGraph placeholder low-poly district prism',
    65536
  ),
  (
    'kit.lowpoly.building',
    1,
    'asset://worldgraph/kit/lowpoly/building',
    decode(repeat('22', 32), 'hex'),
    'CC0-1.0',
    'WorldGraph placeholder low-poly building box',
    65536
  ),
  (
    'kit.lowpoly.road',
    1,
    'asset://worldgraph/kit/lowpoly/road',
    decode(repeat('33', 32), 'hex'),
    'CC0-1.0',
    'WorldGraph placeholder low-poly road segment',
    65536
  ),
  (
    'kit.lowpoly.spawn',
    1,
    'asset://worldgraph/kit/lowpoly/spawn',
    decode(repeat('44', 32), 'hex'),
    'CC0-1.0',
    'WorldGraph placeholder spawn marker',
    32768
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.worldgraph_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'append-only geography/visual table rejects %', TG_OP
    USING ERRCODE = '25006';
END
$function$;
--> statement-breakpoint
CREATE TRIGGER visual_scene_plans_immutable
  BEFORE UPDATE OR DELETE ON public.visual_scene_plans
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER visual_asset_catalog_immutable
  BEFORE UPDATE OR DELETE ON public.visual_asset_catalog
  FOR EACH ROW EXECUTE FUNCTION public.worldgraph_reject_mutation();
--> statement-breakpoint
ALTER TABLE public.world_compilation_runs
  DROP CONSTRAINT world_compilation_runs_compiler_known,
  ADD CONSTRAINT world_compilation_runs_compiler_known CHECK (
    compiler_config_version = 1
    AND compiler_version IN ('1.0.0','1.1.0','1.2.0','1.3.0','1.4.0')
  );
--> statement-breakpoint
ALTER TABLE public.world_versions
  DROP CONSTRAINT world_versions_compiler_known,
  ADD CONSTRAINT world_versions_compiler_known CHECK (
    compiler_config_version = 1
    AND compiler_version IN ('1.0.0','1.1.0','1.2.0','1.3.0','1.4.0')
  );
--> statement-breakpoint
ALTER TABLE public.compiled_world_artifacts
  DROP CONSTRAINT compiled_world_artifacts_schema_known,
  ADD CONSTRAINT compiled_world_artifacts_schema_known CHECK (
    (artifact_kind = 'compiled_world' AND artifact_schema_version IN (1,2,3,4,5))
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
      AND source_compiler_version IN ('1.2.0','1.3.0','1.4.0')
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
ALTER TABLE public.compiled_governance_seed_plans
  DROP CONSTRAINT compiled_governance_seed_plans_source_known,
  ADD CONSTRAINT compiled_governance_seed_plans_source_known CHECK (
    (source_kind = 'compiler_1_3' AND source_compiler_version IN ('1.3.0','1.4.0')
      AND adopted_command_id IS NULL AND adopted_event_id IS NULL)
    OR (source_kind = 'adopted_legacy' AND source_compiler_version IN ('1.0.0','1.1.0','1.2.0')
      AND adopted_command_id IS NOT NULL AND adopted_event_id IS NOT NULL)
  );
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
  geography_domain text := 'worldgraph.geography-seed-plan.v1';
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
    WHEN 5 THEN 'worldgraph.economy-seed-plan.v2'
    ELSE NULL
  END;
  IF NEW.artifact_kind = 'compiled_world' AND NOT (
    (run_record.compiler_version = '1.0.0' AND NEW.artifact_schema_version = 1
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '1'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.0.0'
      AND NEW.canonical_content ->> 'compilerConfigVersion' = '1'
      AND NOT NEW.canonical_content ? 'economySeedPlan'
      AND NOT NEW.canonical_content ? 'governanceSeedPlan'
      AND NOT NEW.canonical_content ? 'geographySeedPlan')
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
      AND NOT NEW.canonical_content ? 'governanceSeedPlan'
      AND NOT NEW.canonical_content ? 'geographySeedPlan')
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
      AND NOT NEW.canonical_content ? 'governanceSeedPlan'
      AND NOT NEW.canonical_content ? 'geographySeedPlan')
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
        )), 'UTF8'), 'sha256')
      AND NOT NEW.canonical_content ? 'geographySeedPlan')
    OR
    (run_record.compiler_version = '1.4.0' AND NEW.artifact_schema_version = 5
      AND NEW.canonical_content ->> 'artifactSchemaVersion' = '5'
      AND NEW.canonical_content ->> 'compilerVersion' = '1.4.0'
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
        )), 'UTF8'), 'sha256')
      AND jsonb_typeof(NEW.canonical_content -> 'geographySeedPlan') = 'object'
      AND NEW.canonical_content -> 'geographySeedPlan' ->> 'geographySeedPlanSchemaVersion' = '1'
      AND NEW.canonical_content ->> 'geographySeedPlanHash' ~ '^[a-f0-9]{64}$'
      AND decode(NEW.canonical_content ->> 'geographySeedPlanHash', 'hex') =
        extensions.digest(convert_to(public.worldgraph_canonical_jsonb(jsonb_build_object(
          'domain', geography_domain, 'value', NEW.canonical_content -> 'geographySeedPlan'
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
DO $economy_plan_provenance_m11$
DECLARE
  function_definition text;
  updated_definition text;
  previous_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.worldgraph_assert_compiled_economy_seed_plan()'::regprocedure
  ) INTO function_definition;
  previous_definition := function_definition;
  -- Replaces both the integer and ::text artifact-schema CASE arms from M10.
  updated_definition := replace(
    previous_definition,
    $needle$CASE plan_record.source_compiler_version
          WHEN '1.3.0' THEN 4
          ELSE plan_record.seed_plan_schema_version + 1 END$needle$,
    $replacement$CASE plan_record.source_compiler_version
          WHEN '1.3.0' THEN 4
          WHEN '1.4.0' THEN 5
          ELSE plan_record.seed_plan_schema_version + 1 END$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'economy plan provenance lacks the sealed M10 artifact-schema clause'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'public.worldgraph_assert_native_economy_plan_activation()'::regprocedure
  ) INTO function_definition;
  previous_definition := function_definition;
  updated_definition := replace(
    previous_definition,
    $needle$IF checked_compiler_version NOT IN ('1.1.0','1.2.0','1.3.0') THEN RETURN NULL; END IF;$needle$,
    $replacement$IF checked_compiler_version NOT IN ('1.1.0','1.2.0','1.3.0','1.4.0') THEN RETURN NULL; END IF;$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'economy activation lacks the sealed M10 compiler registry clause'
      USING ERRCODE = '55000';
  END IF;
  previous_definition := updated_definition;
  updated_definition := replace(
    previous_definition,
    $needle$expected_artifact_schema := CASE checked_compiler_version WHEN '1.1.0' THEN 2 WHEN '1.2.0' THEN 3 ELSE 4 END;$needle$,
    $replacement$expected_artifact_schema := CASE checked_compiler_version WHEN '1.1.0' THEN 2 WHEN '1.2.0' THEN 3 WHEN '1.3.0' THEN 4 ELSE 5 END;$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'economy activation lacks the sealed M10 artifact registry clause'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'public.worldgraph_materialize_world_commerce(uuid,uuid,bytea,uuid,uuid,bigint,timestamptz)'::regprocedure
  ) INTO function_definition;
  previous_definition := function_definition;
  updated_definition := replace(
    previous_definition,
    $needle$version.compiler_version IN ('1.2.0','1.3.0')$needle$,
    $replacement$version.compiler_version IN ('1.2.0','1.3.0','1.4.0')$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'commerce materializer lacks the sealed M10 compiler clause'
      USING ERRCODE = '55000';
  END IF;
  previous_definition := updated_definition;
  updated_definition := replace(
    previous_definition,
    $needle$artifact.artifact_schema_version = CASE version.compiler_version
        WHEN '1.2.0' THEN 3 WHEN '1.3.0' THEN 4 END$needle$,
    $replacement$artifact.artifact_schema_version = CASE version.compiler_version
        WHEN '1.2.0' THEN 3 WHEN '1.3.0' THEN 4 WHEN '1.4.0' THEN 5 END$replacement$
  );
  IF updated_definition = previous_definition THEN
    RAISE EXCEPTION 'commerce materializer lacks the sealed M10 artifact clause'
      USING ERRCODE = '55000';
  END IF;
  updated_definition := replace(
    updated_definition,
    'commerce initialization requires exact compiler/artifact 1.2/3 or 1.3/4 plan-2 provenance',
    'commerce initialization requires exact compiler/artifact 1.2/3, 1.3/4, or 1.4/5 plan-2 provenance'
  );
  EXECUTE updated_definition;
END
$economy_plan_provenance_m11$;
--> statement-breakpoint
DO $metadata$
DECLARE changed integer;
BEGIN
  UPDATE public.platform_metadata
  SET value = value || jsonb_build_object(
        'compiler', '1.4.0',
        'compilerArtifactSchema', 5,
        'contracts', 11,
        'geographySchema', 1,
        'geographySeedPlanSchema', 1,
        'runtimeSchema', 11,
        'visualAssetCatalogSchema', 1,
        'visualScenePlanSchema', 1,
        'visualStyleKitVersion', 1
      ),
      value_schema_version = 11,
      updated_at = now()
  WHERE key = 'runtime_versions'
    AND value_schema_version = 10
    AND value ->> 'compiler' = '1.3.0'
    AND value ->> 'compilerArtifactSchema' = '4'
    AND value ->> 'contracts' = '10'
    AND value ->> 'runtimeSchema' = '10';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'geography migration could not advance exact M10 runtime metadata'
      USING ERRCODE = '55000';
  END IF;
END
$metadata$;
--> statement-breakpoint
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT SELECT, INSERT, UPDATE ON
      public.spatial_reference_systems,
      public.world_geography_heads,
      public.territories,
      public.districts,
      public.parcels,
      public.roads,
      public.building_placements,
      public.points_of_interest,
      public.spawn_points
      TO worldgraph_app;
    GRANT SELECT, INSERT ON public.visual_scene_plans TO worldgraph_app;
    GRANT SELECT ON public.visual_asset_catalog TO worldgraph_app;
  END IF;
END
$grants$;
