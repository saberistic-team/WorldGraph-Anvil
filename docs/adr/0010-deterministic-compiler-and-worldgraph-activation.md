# ADR 0010: Deterministic compiler and atomic WorldGraph activation

Status: accepted for Milestone 05.

## Context

An approved Manifest v1 is immutable intent, not runtime authority. WorldGraph needs a reproducible boundary that lowers that intent and its exact reviewed primitive closure into an authoritative relational graph without executing primitive data, consulting a model, or allowing a queue or client to supply the result.

## Decision

`packages/compiler` is a framework-independent pure compiler with explicit `resolve → validate → normalize → lower → link → emit` stages. Its complete input is `CompilerInputBundleV1`: canonical manifest bytes/hash, exact canonical primitive bytes/hashes and dependency closure, sorted world-local member principals, schema/compiler/config versions, explicit integer-only configuration, and seed. The input hash covers every semantic field except its own hash. The compiler may not read the database, network, filesystem, environment, wall clock, locale, or ambient randomness.

Code-owned adapters are allowlisted by primitive kind and behavior reference. Primitive definitions remain inert data and are never imported or evaluated. Unknown/deprecated/incompatible adapters, changed hashes, missing/cyclic dependencies, unsafe numbers, duplicate keys, dangling endpoints, invalid endpoint types, or configured size overflows produce ordered structured diagnostics and no artifact.

Logical keys, XorShift32 seed derivation, integer arithmetic, code-point ordering, canonical JSON, and SHA-256 define reproducibility. A compiled artifact excludes physical UUIDs, timestamps, run IDs, user IDs, email/session data, prompt text, provider data, and object insertion order. Compiler output may change only with an explicit compiler or compiler-configuration version change and an intentional golden update.

PostgreSQL owns compilation state. Redis/BullMQ carries a validated wake containing durable IDs/hashes only. A worker claims with compare-and-set lease state, reloads and rehashes the authoritative manifest/primitive/member inputs, compiles and verifies the artifact, then activates in one `SERIALIZABLE` transaction under a transaction-scoped world advisory lock. That transaction writes immutable artifacts, one staging design version, entities, typed relationships, controller bindings, and one runtime head before advancing the active version pointer and lifecycle. Deferred constraints and triggers require a complete same-world graph and one successful active version; rollback leaves no seed rows or active pointer. Failed diagnostics are persisted separately through the legal run transition.

Compilation is initial activation only. An approved child manifest remains design intent and cannot mutate an active graph. Runtime mutations require the authenticated command/event ledger introduced after this milestone.

World members may read the bounded graph and compilation state. Only the active creator may start, retry, or cancel compilation. Active creator, administrator, and player memberships compile to pseudonymous world-local account principals, characters, `account_controls` edges, and matching controller bindings; observers remain part of input identity but receive no controllable character.

## Consequences

- Identical semantic input produces byte-identical logical artifacts across processes, locale, timezone, insertion order, and physical database identifiers.
- Queue loss or duplicate delivery cannot create a second seed; PostgreSQL reconciliation and unique identities recover safely.
- Database graph rows are immutable after initial activation until a later versioned command-ledger migration deliberately introduces controlled mutation.
- Artifact verification remains an application/compiler responsibility; PostgreSQL enforces provenance coupling, hash shape, graph integrity, and activation consistency.
- Physical row UUIDv7 values and operational timestamps are intentionally outside the semantic artifact hash.
- Migration `0006_deterministic_compiler` is forward-only and must not be edited after M05 sealing.
