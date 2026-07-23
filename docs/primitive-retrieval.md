# Primitive retrieval policy

Primitive index schema 1 is deterministic and filter-first. It is designed to remain useful with no model or embedding key.

Schema 1 intentionally supports at most 500 published versions in one compatible filtered retrieval scope. The service counts that scope before scoring and returns bounded `RETRIEVAL_UNAVAILABLE` with `CATALOG_SCOPE_LIMIT` if it is exceeded; it never silently approximates RRF by truncating a channel. Narrower kind/tag/compatibility filters may still be used when the total catalog is larger. Raising this invariant requires exact database-side fusion or another versioned ranking policy with scale tests.

## Query flow

1. Normalize the bounded query with Unicode normalization and stable token rules. Logs and metrics use a hash/run ID, not raw query text.
2. Apply published lifecycle, kind, tag, and compatibility filters before scoring.
3. Rank the eligible population independently by the immutable weighted lexical document and by tag match score. Lexical fields weight identity/display terms above tags and documentation. Tag frequency is computed over the filtered population.
4. If a local, explicitly configured query-vector source and matching current primitive embeddings are available, create a third cosine-similarity rank. No account, world, or private user data is sent to an external provider in Milestone 3.
5. Fuse channel ranks with weighted reciprocal-rank fusion: `lexical=1`, `tag=0.6`, `vector=0.35`, `k=60`. Break ties by stable key, true SemVer descending, then immutable ID.
6. Return exact versions, content hashes, resolved dependency closure, matched terms/tags, per-channel scores/ranks, index provenance, warnings, and a retrieval run ID.

Embeddings can adjust order only. They cannot admit a row excluded by lifecycle or compatibility, validate a primitive, change dependency resolution, or become registry truth. Ranking weights and lexical composition are bound to index policy/schema version 1; changing them requires versioned fixtures and a deliberate reindex.

## Built-in semantic profiles

`disabled-v1` is the production and Compose default. It creates no vector and preserves the golden lexical/tag order. `local-hash-1536-v1` is the only selectable enabled profile in M03. Both primitive index documents and normalized queries use the same deterministic signed unigram/bigram feature hash, L2 normalization, and 1,536 finite float32 dimensions. Its provider/model provenance is `worldgraph-local` / `feature-hash-1536-v1`; estimated cost is always zero. It is a reproducible similarity aid, not an external model or a claim of language understanding.

The API and worker derive profile metadata from the same validated configuration. Semantic contribution can be turned off while local vectors are built, which supports coverage verification before changing ranking. A nonzero cost budget, unknown profile, disabled-profile contribution, or out-of-range timeout/job/rate setting fails startup. No query, account, world data, credential, or network request leaves the process.

## Fallback and public error behavior

- Disabled, timed-out, rate-limited, invalid, missing, partial, failed, dead, or stale semantic indexes return lexical/tag results with bounded warning and error codes.
- `semanticAvailable` is true only when the current request actually receives a vector contribution.
- A query with no compatible lexical/tag/vector match returns `NO_COMPATIBLE_PRIMITIVES` rather than a successful empty ranked response.
- Queries above 500 characters return `QUERY_TOO_LARGE`. Bodies, filters, result limits, cursor bytes, schema structures, provider metadata, and vectors are independently bounded.
- Cursors are authenticated opaque values bound to normalized filters and page limit. Mutation or reuse with different filters returns a stable invalid-cursor error.

Index provenance exposes only allowlisted status/error codes, provider/model/configuration labels, content hash, and index schema. Raw provider errors and secrets never enter API responses.

## Indexing and provider rotation

Publication and explicit reindex atomically create/upsert a PostgreSQL job for `(primitive version, content hash, index schema, provider configuration)`. The API then sends a deterministic BullMQ wake-up notification best-effort. A failed notification cannot roll back a committed publication; periodic worker reconciliation finds the durable job.

At worker startup, bounded reconciliation inserts any missing job for every published/deprecated exact version under the selected profile without updating or resetting jobs for another profile or any existing terminal state. This makes a profile rotation cover the reviewed seed catalog even though its original import recorded `disabled-v1` intent. Periodic discovery covers later imports; publication still creates its target-profile job transactionally.

The worker validates the wake payload, claims with `FOR UPDATE SKIP LOCKED`, rechecks current content/lifecycle and the immutable lexical document, uses a content-hash/provider cache, bounds timeout/cost/metadata/vector dimensions, and records retry, dead, stale, disabled, or complete state. Claim-attempt guards prevent a late worker from overwriting newer state.

Provider/model rotation uses a new configuration ID and side-by-side jobs/embeddings. Keep old data during validation, switch retrieval to the reviewed configuration, request a catalog-wide reindex, observe coverage/backlog, and remove old derived records only under an operational change plan. Published primitive rows and hashes are untouched.
