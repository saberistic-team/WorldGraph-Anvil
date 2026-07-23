# ADR 0008 — Immutable primitive versions and derived retrieval indexes

Status: accepted in Milestone 3.

World Primitives are inert, versioned data. A stable family key identifies a concept; an exact strict-SemVer version identifies immutable semantic content. Publication canonicalizes and hashes the definition, resolves dependency ranges to exact published version IDs and hashes, and makes the definition, tags, dependency declarations, and lexical document database-immutable. Corrections require a new version. Deprecation is separate audited lifecycle metadata and never retargets an existing consumer.

PostgreSQL full-text and filter-first tag ranking form the required retrieval path. Reciprocal-rank fusion may add a current 1,536-dimension vector channel with fixed versioned weights, but embeddings are derived, provider-specific, non-authoritative, and removable. Provider failure must leave the lexical result usable and visible as degraded. A future manifest may consume only exact `{key, version}` references plus the content and dependency-lock hashes returned here.

The durable indexing intent lives in `primitive_index_jobs`. BullMQ carries a bounded wake-up message and can be lost or duplicated without losing work; the worker regularly reconciles PostgreSQL, rechecks lifecycle/content/index provenance, and guards every terminal update with the claimed attempt. Provider configuration IDs allow side-by-side rotation without overwriting an older index.

Primitive documentation, schema, visual hints, and provenance remain untrusted content. Definitions cannot contain executable behavior. `behaviorRef` is a bounded name from a compile-time allowlist; later compiler/runtime code owns its meaning. Remote schema references, executable URLs, templates, SQL, and scripts are rejected.

Alternatives rejected for the MVP were mutable “latest” records, vector-only search, provider-managed vector authority, Redis-only job durability, and executable plugin primitives. Revisit ranking weights or approximate vector indexes only with a new index-policy/schema version and measured catalog/query evidence; never change the meaning of an already published version.
