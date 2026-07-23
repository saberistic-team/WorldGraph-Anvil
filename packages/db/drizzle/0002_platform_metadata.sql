CREATE TABLE platform_metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  value_schema_version integer NOT NULL CONSTRAINT platform_metadata_value_schema_version_positive CHECK (value_schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO platform_metadata (key, value, value_schema_version)
VALUES (
  'runtime_versions',
  '{"api":"v1","compiler":"0.0.0","contracts":1,"manifestSchema":0,"primitiveSchema":0,"runtimeSchema":1}'::jsonb,
  1
)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    GRANT SELECT ON platform_metadata TO worldgraph_app;
  END IF;
END
$grant$;
