# ADR 0011: Command/event ledger and deterministic replay

- Status: Accepted
- Date: 2026-07-21
- Milestone: 06

## Context

An active WorldGraph needs one authoritative mutation boundary before simulation, economy, governance, or AI actors are introduced. Relational graph tables remain the efficient current-state model, but direct public writes cannot provide stable idempotency, ordering, concurrency, audit, or deterministic recovery. Redis and worker delivery cannot be authority, and an event hash cannot protect against a fully privileged database operator.

## Decision

All newly registered active-world mutations use a versioned command bus. The server derives actor, world, correlation, causation, authorization, and override context. The repository takes a per-world session advisory lock before opening the `SERIALIZABLE` transaction, so a waiter receives a fresh snapshot rather than a stale serializable snapshot. The transaction reserves command identity, locks the world ledger head, checks expected design/state/aggregate versions, runs a pure allowlisted decision, and atomically commits the terminal command result, immutable typed event, hash-chained ledger entries, synchronous projection, runtime/checkpoint advancement, and a minimal transactional outbox reference. Rejections that have a valid anchored world append a redacted command-rejected ledger entry and no domain event or projection change.

The owner-defined write-gate function captures the runtime revision, event/ledger positions, and projection checksum on the command record before granting a transaction-local gate. Security-definer allocation triggers, rather than the application role, advance event, aggregate, and ledger heads. A deferred terminal constraint proves exact contiguous command/event/ledger/outbox cardinality and head/checksum agreement; for rejection it also recomputes the opening projection and rejects any state, event, or checksum change. An opened command cannot commit while still `received`.

The first event is an honest anchor. An exact M05 upgrade records `WorldStateImportedV1` for each active graph, with the real artifact identity, row counts, projection versions, and checksum. A new activation records `WorldCompiledGenesisV1` in the activation transaction. Neither path invents earlier actions.

`world_entities`, `world_relationships`, controllers, and the runtime head remain query projections. The pure `@worldgraph/ledger` package owns canonical event and entry hashes, typed registries/upcasters, rename decision/reducer, history templates, verification, export, and replay. Replay starts from the immutable compiled artifact and ordered genesis/event bytes, performs no authorization, network, AI, wall-time, environment, or random access, and writes only durable shadow projection tables. It never changes live state.

An owner-only repair function may replace a demonstrably divergent live projection only from a successful shadow run at an unchanged source head, with two distinct active platform-administrator approvals and an explicit reason. The transaction appends `ProjectionRepairAnchoredV1`, its ledger entry, checkpoint/head/outbox/history records, and advances the world revision. Events and prior ledger entries are never edited or deleted.

## Hash and ordering semantics

- Per-world event and ledger sequences are positive, contiguous PostgreSQL `bigint` values exposed as decimal strings.
- Per-aggregate event versions are allocated under the same locked world transaction and protected by unique constraints.
- Event hashes and ledger entry hashes are SHA-256 over domain-separated canonical JSON. Canonical timestamps are UTC with millisecond precision; object insertion order, locale, and timezone do not affect bytes.
- A ledger entry commits its previous hash. The database head and runtime head must agree with the last sequence/hash.
- The application role cannot directly update world or aggregate allocation heads. Owner-run allocation triggers advance each head by exactly the inserted immutable row, while deferred command validation rejects orphan events, missing outbox references, sequence jumps, or projection changes hidden behind a rejection.
- Hash chaining is tamper evidence, not administrator-proof immutability. Restricted application grants, insert-only triggers, backups, external verification/checkpoints, and incident procedures are separate controls.

## Consequences

- PostgreSQL is the only authority. Redis or an outbox worker may be unavailable without losing an accepted command.
- Accepted history is an asynchronous derived view. A committed command is authoritative before its history row appears; status lookup resolves uncertain client outcomes.
- Unknown and unanchored worlds fail closed before append because a truthful world/anchor foreign-key chain does not exist.
- Contract/runtime compatibility advances to 6 while command, event, ledger, projection, outbox, and history schemas begin independently at 1.
- The initial public vertical slice is `RenameWorldEntityV1`; later domains must register explicit payload/event/reducer versions and cannot add generic patches or direct projection writes.
- World creation is pre-genesis design state. M02–M05 job computation/status and identity/session internals remain outside the domain-event ledger; active-world authoritative route adapters append from the M06 adaptation boundary forward.
- Preserved M02–M05 mutation routes use a commands-owned compatibility adapter inside their existing serializable idempotency transaction. They share the same registered event contracts, hashes, ledger/outbox/history/checkpoint storage, gate, and terminal invariants, but do not expose the generic command response shape. Known anchored-world validation and authorization failures are recorded; genuinely unknown worlds/tokens remain non-enumerating and cannot acquire a fabricated world ledger entry.
- The deterministic shadow checksum covers the compiled WorldGraph entity/relationship/controller projection. Adapted world, membership, invitation, and manifest lifecycle facts advance ordering/history but are no-op reducers for that graph projection; their existing relational tables remain synchronous current state. Invitation expiry is derived security-token validity/housekeeping, not a simulation or graph revision event.

## Rejected alternatives

- Event-sourcing every read/auth/job table: unnecessary scope and fabricated semantics.
- Redis, BullMQ, or a separate event-store service as authority: adds failure modes and conflicts with the existing PostgreSQL transaction boundary.
- Mutable event correction or automatic rollback: destroys evidence and cannot safely undo external observation.
- Replaying command authorization or AI calls: nondeterministic and reinterprets historical decisions.
- Generic client JSON patch/event types: bypasses domain validation, authority, privacy classification, and stable evolution.
