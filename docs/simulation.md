# Deterministic clock and scheduler

Milestone 7 introduces the first authoritative simulation slice. Every active world owns one PostgreSQL clock and schedule head. A clock begins at tick `0` in `paused` mode; activation does not imply that time passed. World time is derived with checked integer arithmetic:

```text
worldTimeUnixMilliseconds = epochUnixMilliseconds + tick * worldMillisecondsPerTick
```

Wall time, Redis, and BullMQ can request work, but none of them is simulation input or authority. An accepted versioned command records the exact tick transition, events, ledger facts, projections, batch result, checkpoint, and outbox references in one serializable PostgreSQL transaction.

Continuous catch-up is fail-closed. A due window at or below `maxCatchUpTicks` is drained through `maxBatchTicks` transactions; when PostgreSQL reports a larger gap, automatic advancement emits no command on any repeated wake. A creator must deliberately pause, review the gap, use one or more bounded manual advances as appropriate, and start again to establish a fresh wall anchor. Raising limits is not an incident shortcut.

## Compatibility and persisted state

Runtime and contract compatibility are `7`. The independent clock, schedule, process, batch, failure, queue, projection, outcome, and PRNG schemas are each `1`; the process registry is `1`; and the only supported PRNG algorithm is `xorshift32-sha256-v1`. Compiler identity remains `1.0.0`.

Migration `0008_deterministic_clock_scheduler` adds:

- `world_simulation_clocks` and `world_schedule_heads` for synchronous current state and sequence allocation;
- `scheduled_actions` for immutable identity plus one legal scheduled-to-terminal transition;
- `simulation_batch_runs` for bounded execution/reproducibility evidence;
- `simulation_worker_leases` for PostgreSQL-owned fencing epochs; and
- `simulation_failures` for safe, append-only operational failure and resolution state.

The migration initializes every already anchored active world using its valid compiled discrete-clock configuration. If that complete configuration is absent or invalid, it uses the documented M07 defaults as one set and records `m07_default` provenance. Fresh activation initializes the same state atomically. Initialization is an explicit `InitializeWorldSimulationV1` system command with a `WorldSimulationInitializedV1` event, one ledger/history/outbox fact, a simulation-clock aggregate at version `1`, and graph plus simulation checkpoints. Reapplying the exact migration is a no-op; partial or divergent initialization fails closed for forward repair.

## Clock and command semantics

Public commands use the M06 identity, expected-version, authorization, idempotency, event, ledger, projection, and uncertain-result boundary:

- `ConfigureWorldClockV1` is creator-only and valid only at tick `0` while paused.
- `StartWorldClockV1`, `PauseWorldClockV1`, and manual `AdvanceSimulationV1` require `simulation.manage` creator authority.
- `ScheduleWorldNoticeV1` and `CancelScheduledActionV1` require creator or administrator authority scoped to an active membership.
- The worker may submit `AdvanceSimulationV1` only as the fixed `worldgraph:simulation-worker` system principal after proving its PostgreSQL lease in the same transaction.
- `AutoPauseWorldClockV1` is server-only. It records a bounded, redacted failure and moves the clock to fail-closed `error` mode after exhausted retries.

All commands bind the current world version, state revision, aggregate version, and tick. A command can append at most 64 facts. All of its facts share one resulting world state revision even though event and ledger positions remain contiguous. An advance emits one `SimulationAdvancedV1` summary and, for each executed notice, one `ScheduledActionExecutedV1` plus one `WorldNoticeEmittedV1`; therefore one batch executes at most 31 notices. Failure, conflict, fencing, or schema validation rolls back the entire attempted tick range.

Stable errors include `CLOCK_NOT_PAUSED`, `CLOCK_NOT_RUNNING`, `EXPECTED_TICK_MISMATCH`, `ADVANCE_LIMIT_EXCEEDED`, `SCHEDULE_IN_PAST`, `SCHEDULE_ALREADY_TERMINAL`, `SIMULATION_HANDLER_FAILED`, and `WORLD_NOT_ACTIVE`, in addition to the inherited authorization, stale-version, idempotency, and availability errors. Clients must resolve an uncertain mutation with the original command ID before creating another identity.

## Scheduling and pure processes

A new action must be strictly after the current tick; current- and past-tick creation is rejected. Due actions are evaluated in this exact order:

1. due tick ascending;
2. priority ascending;
3. schedule sequence ascending; and
4. stable action ID ascending as the final tie-break.

The schedule sequence is allocated inside the command transaction. A scheduled action can transition exactly once to completed, cancelled, or failed. Completion and its emitted domain event are atomic with the clock advance, so a duplicate wake, worker race, or exact command replay cannot execute it twice.

`@worldgraph/simulation` is a pure package. Its code-owned registry currently admits only `EmitWorldNoticeV1` process version `1.0.0`. The handler receives validated immutable context, derived world time, the current semantic projection checksum, and a deterministic PRNG substream keyed by `schedule:<sequence>`. It returns proposed typed facts and future schedules; it has no database, network, AI, Redis, filesystem, locale, ambient environment, wall-clock, or random capability. Unknown action/process/schema versions and excessive fact/schedule budgets are rejected before persistence.

Notice text is bounded plain text and rendered as text. Visibility is `public`, `member`, or `creator`; history applies visibility before pagination. Logs, traces, metrics, queue messages, and failure context never contain notice text or payload bytes.

## Outcome and projection checksums

The M06 graph projection checksum intentionally remains its existing state-revision-aware graph invariant. M07 adds a separate semantic simulation projection checkpoint. It hashes only clock configuration/current semantic state and ordered schedule semantics: sequence, due tick, priority, action/process/schema versions, payload hash, and status.

The first simulation outcome fold anchors the ID-free starting semantic projection checksum; every fold also covers the world-seed hash, PRNG/process versions, exact tick, ordered due action semantics, returned typed event bytes, and proposed schedules. It excludes world/schedule UUIDs, command/event/ledger IDs, recorded or wall times, state/row revisions, worker/lease identity, attempt metadata, and batch grouping. Thus one three-tick batch and three one-tick batches can have different operational records while converging on the same outcome hash and simulation projection checksum.

## Replay and projection recovery

`@worldgraph/ledger` owns a separate pure `SimulationReplayStateV1` reducer. It validates the full world event stream's schema, hash, contiguous event positions, contiguous command groups, event ordinals, and state revisions, then validates simulation aggregate versions, clock transitions, schedule allocation/terminal identity, notice facts, and failure lifecycle. Non-simulation world facts remain ordered no-ops for this projection. Initialization derives the initial outcome hash from the seed in the immutable compiled-world artifact; the operator rejects an active version, artifact hash, version number, or seed that does not match the honest genesis anchor and artifact.

The reducer reconstructs the typed, event-derived semantic clock and schedule model plus the event-recoverable failure lifecycle. Its checksum material is deliberately the exact ID-free PostgreSQL `worldgraph_simulation_projection_document`: clock configuration/current semantic state, schedule head, and ordered schedule semantics. It is evidence for diagnosis and a reviewed recovery implementation, not a directly restorable row image: non-event operational fields such as wall anchors, row versions, leases, projection-row metadata, and `simulation_batch_runs` are not reconstructed. Failure rows and batch runs remain operational evidence and are not part of the semantic checksum.

An authorized operator can create an evidence-only replay run and compare it with live PostgreSQL without printing notice payloads or changing the live projection:

```sh
pnpm projection replay --world <uuid> --projection simulation_runtime \
  --target verify --reason "INCIDENT-123 simulation verification" \
  --actor <platform-admin-uuid>
pnpm projection compare --world <uuid> --projection simulation_runtime \
  --run <replay-run-uuid> --actor <platform-admin-uuid>
```

Compare refuses a stale source head, proves the durable replay checksum is reproducible, proves JavaScript and PostgreSQL canonical checksum parity, and reports only the first divergent JSON pointer. `ledger verify` also requires the simulation checkpoint to be current, at the runtime event head, and equal to a fresh PostgreSQL checksum.

There is intentionally no simulation auto-swap in M07. The M06 `ProjectionRepairAnchoredV1`/`repair-swap` path is graph-specific and must never be used for clock or schedule state. Follow the frozen-writer, restore/PITR or reviewed-forward-repair procedure in `operations.md`; no operator may patch simulation rows, checkpoint hashes, event bytes, or ledger entries in place.

## Continuous execution and recovery

The worker discovers due running clocks in deterministic PostgreSQL order. For one world at a time it acquires an expiring lease with a monotonically increasing fencing token, reloads the current clock/runtime/aggregate heads, computes a target bounded by `maxBatchTicks` and `maxCatchUpTicks`, and issues the system command. The executor validates the exact owner and fencing token inside the same serializable transaction as all authoritative writes. Workers never trust a Redis value or a preflight check for fencing.

BullMQ carries only a wake hint. Periodic reconciliation discovers due PostgreSQL rows even when the hint is lost or duplicated. Redis loss stops automatic wakes and marks the Simulate lens degraded; it does not advance, rewind, or corrupt a clock. After Redis recovery, reconciliation resumes from the persisted wall anchor and current tick. A pause committed before a stale worker attempt makes that attempt return not-running/conflict/fenced rather than advance.

Transient database/serialization failures use bounded exponential retry and lease renewal. On the final deterministic execution failure, a separate fenced transaction records a sanitized failure, a failed batch, `SimulationFailureRecordedV1`, and `WorldClockAutoPausedV1`, then moves the clock to `error`. It never skips the broken action. Repair is an explicit append-only, audited versioned command or a process-version rollout followed by a deliberate retry/cancel decision; never mutate a schedule, batch, failure, clock, event, or ledger row manually.

## Observability and failure resolution

The simulation worker emits the following low-cardinality OTLP instruments. Names below are the code-owned instrument names before any deployment-specific OTLP-to-Prometheus translation:

| Instrument                                         | Type      | Labels                                       | Meaning                                                                                                                |
| -------------------------------------------------- | --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `worldgraph_simulation_due_worlds`                 | histogram | none                                         | Due worlds returned by one PostgreSQL reconciliation discovery.                                                        |
| `worldgraph_simulation_due_lag_ms`                 | histogram | none                                         | Non-negative wall drift from a clock's computed `next_due_at` until worker discovery.                                  |
| `worldgraph_simulation_batch_ticks`                | histogram | none                                         | Tick count in a candidate automatic advance.                                                                           |
| `worldgraph_simulation_backlog_ticks`              | histogram | none                                         | Authoritative due-tick backlog for a bounded candidate that passed the catch-up limit.                                 |
| `worldgraph_simulation_ticks_total`                | counter   | none                                         | Ticks in advances whose authoritative command result was `advanced`.                                                   |
| `worldgraph_simulation_command_duration_ms`        | histogram | bounded `operation`, `outcome`               | Full authoritative command-port duration for `advance` or `auto_pause`, including connection/serialization/commit.     |
| `worldgraph_simulation_lease_duration_ms`          | histogram | bounded `stage`, `outcome`                   | PostgreSQL lease acquisition, total hold, and best-effort release duration.                                            |
| `worldgraph_simulation_lease_contention_total`     | counter   | none                                         | Lease acquisitions that correctly returned busy because another owner held the epoch.                                  |
| `worldgraph_simulation_fencing_loss_total`         | counter   | bounded `stage`                              | Fencing losses at candidate validation, renewal, authoritative command, or release.                                    |
| `worldgraph_simulation_process_executions_total`   | counter   | code-owned `process_type`, `process_version` | Process executions observed retrospectively only after a newly accepted advance committed.                             |
| `worldgraph_simulation_process_failures_total`     | counter   | stable `code`, process type/version          | Terminal deterministic process failures sent through the fenced auto-pause path.                                       |
| `worldgraph_simulation_queue_wake_age_ms`          | histogram | none                                         | Non-negative age of a validated BullMQ wake hint when its processor receives it.                                       |
| `worldgraph_simulation_reconciliation_duration_ms` | histogram | `outcome`                                    | End-to-end PostgreSQL reconciliation duration.                                                                         |
| `worldgraph_simulation_retry_total`                | counter   | stable `code`                                | Transient advance retries before the bounded terminal attempt.                                                         |
| `worldgraph_simulation_run_total`                  | counter   | `outcome`                                    | Worker result: `advanced`, `auto_paused`, `busy`, `conflict`, `failed`, `fenced`, `idle`, `not_due`, or `not_running`. |
| `worldgraph_simulation_wake_available`             | gauge     | none                                         | `1` when the Redis/BullMQ wake path is available and `0` when degraded.                                                |

Production traces nest `simulation.wake` → `simulation.reconcile` → `simulation.lease.acquire`/`simulation.lease.hold` → `simulation.command.advance` or `simulation.command.auto_pause` → `simulation.lease.release`. Newly committed process executions create retrospective `simulation.process.execute` spans, and terminal deterministic failures create `simulation.process.failure` spans. Safe span attributes are limited to world ID, wake source/outcome, bounded counts and attempts, exact tick/range, code-owned process type/version, stable error/outcome code, and lease stage/outcome. They never include notice text, payload bytes, hashes, lease owner/token, actor data, or raw errors.

The process observer receives only bounded counts, tick, and code-owned process identity. It runs best-effort after the authoritative commit and after the checked-out PostgreSQL client is released; its asynchronous completion is not awaited, and neither a synchronous throw nor a rejected observer promise can change the committed result. Exact command replay emits no new process-execution telemetry because it did not execute a process again.

The Prometheus-compatible rules expect translated histogram `_bucket`, `_count`, and `_sum` series and retain the code-owned counter names. Every target environment must verify that translation against its collector before loading the rules. IDs, hashes, notice text, payloads, actors, lease owners, and fencing tokens must never become metric labels. Process labels are safe only because both values come from the bounded code-owned registry; adding a process requires updating this telemetry contract.

Four integrity/backlog rules intentionally depend on a deployment-owned, read-only PostgreSQL reconciliation exporter; the worker does not emit them. The exporter contract is one aggregate series per deployment with no world or record identifiers:

| External metric                                    | Type    | Required value after a successful scan                                                                                                                                         |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `worldgraph_simulation_running_stalled_worlds`     | gauge   | Count of active clocks in `running` mode whose `last_wall_anchor_at + wall_cadence_milliseconds` is at least ten minutes behind PostgreSQL time.                               |
| `worldgraph_simulation_backlog_ticks_max`          | gauge   | Maximum non-negative `floor((PostgreSQL time - last_wall_anchor_at) / wall_cadence_milliseconds)` across active running clocks, or `0` when none exist.                        |
| `worldgraph_simulation_due_schedule_lag_ticks_max` | gauge   | Maximum non-negative `current_tick - due_tick` across actions still in `scheduled` status, or `0` when none exist.                                                             |
| `worldgraph_simulation_outcome_mismatch_total`     | counter | Increment once for each independent replay/reconciliation comparison whose deterministic outcome or semantic simulation projection checksum differs from PostgreSQL authority. |

The exporter must use PostgreSQL time, run with a least-privilege read-only identity, emit zero rather than omit a successfully calculated gauge, and expose/alert its own scrape and last-success freshness. A missing series is unknown coverage, never a healthy zero. Local Compose does not supply this privileged scanner, Prometheus, Grafana, alert routing, or receiver credentials.

`deploy/alerts/simulation-v1.rules.yml` identifies every rule with `metric_source: simulation_worker_otlp` or `metric_source: postgresql_reconciliation_exporter`. `deploy/dashboards/simulation-v1.grafana.json` is the matching importable Grafana dashboard: worker health and throughput appear first, while external reconciliation controls are visually separated and explicitly show no data until that exporter is present.

An auto-paused clock remains in `error` mode until an authorized creator deliberately resolves the open failure through `ResolveSimulationFailureV1`. The command binds the current world version, state revision, tick, failure aggregate version, command ID, and idempotency key. `retry_after_repair` records the resolution, returns the clock to `paused`, and keeps the action scheduled; deploy and verify the compatible process repair before a separate bounded start or manual advance. `cancel_action` atomically resolves the failure, cancels its still-scheduled action, and returns the clock to `paused`. If the original resolution response is uncertain, query that command ID before doing anything else. Neither resolution starts time automatically, and neither permits direct row edits.

## API and Simulate lens

Membership-scoped reads are:

- `GET /api/v1/worlds/:id/simulation/clock`;
- `GET /api/v1/worlds/:id/simulation/schedule`;
- `GET /api/v1/worlds/:id/simulation/schedule/:scheduleId`; and
- `GET /api/v1/worlds/:id/simulation/batches`.

Schedule and batch collections use bounded filters and opaque cursors. Responses expose current versions, safe statuses, hashes, and redacted failure codes, not raw command/event payloads or worker lease data.

`/worlds/:id/simulate` presents tick and derived UTC world time, mode/config/version, backlog, next action, deterministic schedule order, recent batches, and semantic outcome identity. Creators receive clock controls; creators and administrators receive schedule controls; ordinary members see the authoritative read-only state. Running mode polls politely, Redis degradation does not disable manual authority, conflicts require refresh, and uncertain responses query command status. Multi-tick operations and cancellation require confirmation; the lens supports keyboard, mobile, reduced-motion, and screen-reader use.

## Authoring checklist

Adding a future simulation process requires a new versioned action/payload schema, code-owned registry descriptor, pure deterministic handler, proposed-event/schedule schemas, authority policy, fact and CPU budget, history template/privacy classification, outcome golden vector, migration/compatibility decision, failure and replay tests, and operational rollout plan. A manifest string must never select arbitrary code, import a module, call a URL, or relax an existing schema version.
