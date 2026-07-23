# ADR 0009 — Immutable manifest authority and database-durable generation

Status: accepted in Milestone 4.

WorldGraph separates creator intent from mutable runtime state. `WorldManifestV1` is bounded inert city-state data whose exact primitive versions and parameters are locally validated. Canonical JSON is the authority; safe YAML is an editing projection. Every revision and validation report is immutable/content-addressed. Only an explicit current creator approval may advance the world’s approved-manifest pointer, and that transaction never invokes a compiler or runtime command.

PostgreSQL owns prompt submissions, generation runs, frozen retrieval provenance, revisions, reports, field provenance, cancellation, and approval. BullMQ is wake-only. Workers use database leases and compare-and-set every write, so duplicate/lost queue delivery, process death, retry, or a late provider response cannot create more than one output or defeat cancellation. Base request and catalog-resolved hashes are separate because retrieval occurs asynchronously; inventing a request-time catalog hash without frozen rows would not be reproducible.

Provider output is an untrusted proposal. The pure generation module exposes a strict schema provider port, bounded retries/repair/circuit/accounting, and no authoritative tools. Production currently selects `disabled-v1`; the deterministic fallback is required functionality rather than a mock. Model/fallback outputs pass the same local validator used by manual edits, and approval always revalidates exact pins.

Alternatives rejected were prompt-to-runtime mutation, mutable manifest rows, YAML as database authority, Redis-only job state, request-time unfrozen catalog hashes, permissive model JSON parsing, provider-generated provenance, automatic approval/compilation, and platform-administrator approval without creator membership. A live provider, Manifest v2, compiler, or collaborative editing requires a separately reviewed version/ADR without changing existing v1 bytes or authority.
