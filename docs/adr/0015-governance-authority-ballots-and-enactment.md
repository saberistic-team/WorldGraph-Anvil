# ADR 0015: Governance authority, ballots, and deterministic enactment

- Status: accepted for Milestone 10
- Date: 2026-08-03

## Context

WorldGraph already has authenticated membership, immutable compiler inputs, a serializable command/event/ledger boundary, deterministic world ticks, durable schedules, and a closed-loop economy. Governance must use those authorities without turning legal prose, creator status, Redis delivery, browser state, or an AI interpretation into a mutation capability.

The milestone also needs two properties that pull in different directions: ordinary participants must be able to vote and inspect public outcomes, while configured secret ballots must not disclose a voter-choice linkage through the application role, APIs, events, history, logs, or browser state. A passed proposal must be able to affect laws and the economy, but only through bounded effects that preserve every existing ledger and conservation invariant.

## Decision

### Compiled, finite authority

Governance is a bounded module. Compiler `1.3.0` emits artifact schema 4 with governance seed-plan schema 1. Exact compiler `1.0.0`/artifact 1, `1.1.0`/artifact 2, and `1.2.0`/artifact 3 verification lanes remain supported without upcasting.

Charters, institution powers, office powers, office eligibility, and laws use policy DSL version 1. The AST is limited to actor mode, membership role, held office, action, resource, tick predicates, and bounded `all`/`any`/`not` composition. Both TypeScript and PostgreSQL evaluate the same canonical expression with explicit depth, node, and operand limits. Unknown, malformed, ambiguous, or unevaluable policy denies authority. Natural language and arbitrary code are never evaluated.

Every governance command carries one of four explicit modes: `in_world`, `creator`, `administrator`, or `system`. Ordinary creator activity resolves through the creator's currently controlled character and civic powers. Only `ExecuteCreatorOverrideV1` may bypass civic authority, and it requires reason, impact, confirmation, immutable creator-override provenance, a distinct ledger classification, and optional exact second-party approval.

### Tick-bound contests and terms

Proposal and election windows are half-open world-tick intervals. Opening freezes an immutable eligibility snapshot and checksum. Scheduled lifecycle commands are derived only from completed PostgreSQL schedules, use a unique occurrence identity, and recheck the authoritative tick and aggregate version in the same transaction. Redis is wake-only.

Each election is one contest for one office seat. Certification starts the declared term at the scheduled certification/transition tick, closes any prior overlapping seat authority at that exact tick, and creates a non-overlapping authority interval. Laws and tax-policy authority likewise use half-open intervals. Future behavior requires an explicit deterministic schedule; persisted status must never claim that a future interval is already active.

### Ballot boundary

Eligibility, one-participant-per-contest, effective revision, exact window, and replacement rules are enforced in PostgreSQL. A public ballot may expose only the disclosure mode selected by the charter. A secret ballot separates participation and receipt from restricted choice revisions. The ordinary application role cannot select restricted choice rows or eligibility-member linkage; a dedicated tally role can read the minimum rows needed for deterministic tallying but cannot mutate them.

Receipt and choice hashes are domain-separated and keyed/salted with restricted identifiers. Secret selections never enter ordinary domain-event payloads, history, outbox references, logs, traces, metrics, API responses, or browser storage. This is trusted-server privacy, not coercion resistance or a publicly verifiable cryptographic election protocol. Database owners and the tally service remain trusted and backup/key handling remains operationally sensitive.

### Results, enactment, and correction

Tallies and certified results are immutable, versioned, checksum-bearing facts. Repeated scheduler delivery resolves through the original command/schedule identity. Every accepted command appends a contiguous event set, a matching ledger fact for every event, one outbox reference per event, and one state-revision transition. A command that creates schedules must append one exact `ScheduledActionCreatedV1` fact for every schedule; the database deferred constraint remains authoritative and is not weakened for governance.

Proposal actions are schema-1 typed data: create/amend/repeal law, bounded tax update, public-project treasury encumbrance, charter-authorized appointment, and a future world-patch approval reference. Certification rechecks current targets, authority, exact tick, policy bounds, treasury currency/status/spendable amount, and economic invariants. Effects, result, events, ledger, outbox, and projections commit atomically. A safe enactment failure rolls back every attempted effect and records `passed_but_enactment_failed`; `certification_compensation` retries from immutable action/result checksums and appends audit evidence.

Certified facts are never edited in place. Recount or repair must recompute from immutable inputs, bind the prior checksum, append a linked repair record/event, require strong operator authority and optional distinct approval, and preserve the original result. Unsupported correction types fail closed and must not be presented as available UI operations.

### Module ownership

Governance owns charters, institutions and powers, laws, offices and terms, proposals, contests, eligibility snapshots, ballots, tallies/results, authority decisions, overrides, repairs, and governance projections. It does not own identity/membership, wallets/currencies, tax accounting, world patches, simulation schedules, the command/event ledger, or outbox delivery. Enactment crosses those modules only through narrow transaction-aware functions and existing invariants.

## Consequences

- Governance initialization is explicit. Migration `0013` does not synthesize a charter for an already-active older world.
- The worker requires a separate restricted tally connection when secret contests are enabled; readiness fails closed if it is unavailable.
- Public and secret ballot behavior must be tested separately, including database-role access and one-hundred-way duplicate-vote races.
- Schedule-producing governance commands have multiple domain events and ledger/outbox rows while still advancing one state revision.
- Creator override history remains visually and structurally distinct from legitimate civic outcomes.
- Policy expressiveness is deliberately small. New predicates, action types, tally algorithms, or repair kinds require versioned schemas, compatibility review, migration work, and deterministic tests.
- Environment operators must protect tally credentials, ballot hash keys, backups, audit approvals, and telemetry exports; the application boundary alone cannot defend against a privileged database owner.

## Rejected alternatives

- Interpreting natural-language law or using an LLM at authorization or tally time.
- Treating creator provenance as implicit universal civic authority.
- Storing secret voter and choice data in the ordinary application projection.
- Client-time windows, Redis-owned contest state, or worker-memory idempotency.
- Editing a certified result, law version, or term in place.
- Weakening schedule/event or command-terminal database constraints for convenience.
- Letting a passed vote bypass current target, fiscal, conservation, or authority checks.
