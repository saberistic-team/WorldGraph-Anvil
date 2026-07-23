# ADR 0002 — PostgreSQL authority and relational graph

Status: accepted in M01.

PostgreSQL with PostGIS, pgvector, relational tables, constraints, JSONB, and graph-oriented queries will be the sole durable authority. Redis is disposable. A dedicated graph database was rejected because bounded city-state traversals do not justify dual-write consistency. Revisit after measured recursive-query/materialized-view limits, never because of the product name.
