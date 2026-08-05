DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_app') THEN
    CREATE ROLE worldgraph_app LOGIN PASSWORD 'worldgraph_app_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worldgraph_governance_tally') THEN
    CREATE ROLE worldgraph_governance_tally LOGIN PASSWORD 'worldgraph_governance_tally_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$roles$;

GRANT CONNECT ON DATABASE worldgraph TO worldgraph_app;
GRANT CONNECT ON DATABASE worldgraph TO worldgraph_governance_tally;
