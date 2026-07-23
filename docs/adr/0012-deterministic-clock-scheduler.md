# ADR 0012: PostgreSQL-authoritative deterministic clock and scheduler

- Status: Accepted
- Date: 2026-07-21
- Milestone: 07

## Context

Production, taxation, governance, environmental processes, and future AI proposals need one shared notion of world time and one exactly-once terminal path for scheduled work. Wall clocks, queue delivery, worker timing, locale, and process-local randomness are nondeterministic. Redis/BullMQ cannot atomically advance the M06 command/event ledger or fence concurrent workers. The M06 graph checksum also includes world state revision and therefore cannot prove semantic equivalence across different simulation batch groupings.

## Decision

Each active world has one persistent integer-tick clock and schedule head in PostgreSQL. World time is `epoch + tick * worldMillisecondsPerTick` with checked integer arithmetic. Clocks initialize explicitly at tick `0`, paused, during M07 upgrade or fresh activation. Wall time only determines whether a worker may request a bounded command; replay and process handlers use the accepted tick range.

Every manual or automatic transition uses a versioned M06 command transaction. The first event proves the requested aggregate version, all facts share one resulting state revision, and a deferred terminal guard proves event, ledger, outbox, projection, checkpoint, batch, and failure agreement. Scheduled actions use a transaction-allocated sequence and deterministic `(due tick, priority, sequence, stable ID)` order. Current- and past-tick schedules are rejected.

PostgreSQL owns worker coordination through an expiring lease and monotonically increasing fencing token. The shared system-command executor verifies the lease and locks the world inside the same serializable transaction as the advance. Redis/BullMQ carries a disposable wake hint; periodic reconciliation always rediscovers authoritative due rows. After bounded retry exhaustion, a separate still-fenced system command records a redacted failure and failed batch and moves the clock to `error`; it never skips the due action. `retry_after_repair` may reuse that exact semantic batch only when its latest failure has an accepted audited repair event. The row accumulates attempts while immutable failure records preserve every failed cycle; `cancel_action` cannot authorize reuse.

The code-owned process registry is pure and versioned. A handler receives validated immutable inputs, derived integer time, a semantic projection checksum, and a keyed `xorshift32-sha256-v1` PRNG stream. It can return only registered typed events and future schedules. It has no wall time, ambient random, environment, database, network, AI, filesystem, Redis, dynamic-import, or evaluation capability. Milestone 7 registers only `EmitWorldNoticeV1` version `1.0.0`.

The existing M06 graph checkpoint is retained. A distinct simulation checkpoint hashes ID-free semantic clock and schedule state while excluding world/schedule UUIDs, operational identities, timestamps, revisions, leases, attempts, failures, and batch grouping. The first outcome fold anchors that checksum; later folds retain exact ordered tick/process semantics and seed/algorithm versions. Equivalent executions may have different world UUIDs and operational batch rows but must converge on the same outcome hash and semantic simulation checksum.

## Consequences

- Restart, duplicate/lost wakes, and Redis outage cannot create time or execute an action twice.
- Continuous catch-up is deliberately bounded. A gap within `maxCatchUpTicks` may require several `maxBatchTicks` transactions; a larger gap produces no automatic command on repeated wakes and requires a creator’s explicit pause, reviewed bounded manual advances, and restart.
- The clock aggregate, schedule aggregates, and one world state revision express different concurrency dimensions; clients must bind all required expected values.
- Batches and leases are operational evidence/coordination, not alternate authority. Events, ledger, synchronous projections, and terminal schedule state commit together.
- Clock, schedule, and event-recoverable failure state have a separate pure v1 replay reducer. Its canonical checksum document is exactly the PostgreSQL ID-free clock/schedule document; operational batch/lease data and failure context are excluded. Failure resolution intentionally carries the v1 error-to-paused clock transition because the accepted resolution fact updates both projections atomically.
- Simulation replay/compare is evidence-only in M07 and binds the unchanged event head plus the seed/version/artifact from honest genesis. The graph-specific `ProjectionRepairAnchoredV1` swap is not reused. A simulation restoration requires PITR or a new reviewed forward repair contract with owner execution, two-person approval, coherent graph/simulation checkpoints, and a simulation-specific appended fact.
- A broken deterministic process fail-closes the world clock. Recovery is append-only and audited rather than an in-place row fix.
- Process/schema/PRNG changes require explicit versioning and new golden evidence. A compiler or manifest cannot inject executable behavior.

## Rejected alternatives

- Client-authoritative ticks or browser timers: forgeable and unavailable during disconnect.
- Cron, wall timestamps, or floating-point delta time as domain input: environment-dependent and not replayable.
- BullMQ exactly-once semantics: delivery cannot atomically own the domain transaction and duplicate/lost jobs are normal.
- A preflight lease check followed by an unfenced command: permits a stale owner to commit after expiry.
- Generic manifest-selected functions, dynamic imports, network/AI calls, or `Math.random`: unsafe and nondeterministic.
- Reusing the M06 graph checksum as the batching-independent proof: its revision semantics are intentionally different.
