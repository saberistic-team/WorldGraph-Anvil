# Operations and runbooks

## Readiness, telemetry, and alerts

Liveness is process-only. API readiness requires runtime schema 9, bounded PostgreSQL/Redis probes, and a worker heartbeat newer than the configured TTL. Worker readiness requires bounded PostgreSQL and dedicated Redis probes. Recovery should not require an API/worker restart.

OTLP/HTTP export is active only when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. Use low-cardinality service, route template, stage, provider configuration, outcome, status, and stable error/diagnostic-code labels. Never attach raw URLs, IDs or hashes as metric labels, prompts, manifests, entity state, provider payloads, request bodies, or provider error text.

Manifest telemetry traces submit → wake/queue → claim → intent/retrieval → provider/fallback → validation → immutable revision using request/run correlation and content hashes. Metrics cover generation outcome/duration/queue wait/retrieval count/token-cost estimate, fallback/provider mode, validation diagnostics, approval conversion, cancellation/stale conflicts, prompt cleanup, and PostgreSQL backlog/age. Versioned rules in `deploy/alerts/manifest-studio.rules.yml` cover queue age, failure/fallback spike, cost ceiling, validator errors, and stale approval conflict. Primitive rules remain in `deploy/alerts/primitive-registry.rules.yml`. A deployment must load/test backend metric-name translation and route severities; local Compose intentionally has no paging backend.

Recommended release alerts also include sustained unready, HTTP 5xx, authentication/retrieval/generation limit spikes, unusual creator overrides, repeated cross-world denials, invitation abuse, old heartbeat, primitive index backlog/dead work, PostgreSQL pool saturation, failed bootstrap, prompt-cleanup failure, graceful-shutdown failure, telemetry loss, backup age, and restore-test failure.

`deploy/alerts/command-ledger-v1.rules.yml` covers command failure/conflict/serialization signals and outbox age/dead letters. Ledger verification, projection checksum comparison, unexpected repair/override, stuck `received` commands, and external hash-checkpoint freshness also require scheduled operator checks or a deployment-specific database exporter; this repository does not claim a privileged continuous scanner or paging route.

`deploy/alerts/simulation-v1.rules.yml` covers worker-observed due lag, queue-wake age, high authoritative command-path time, retry/process failure, lease contention/fencing churn, auto-pause, wake degradation, stalled running clocks, sustained catch-up backlog, overdue actions, and deterministic outcome mismatch. Every rule declares `metric_source`: worker rules refer only to instruments in the exact emitted contract in `docs/simulation.md`; stalled/backlog/overdue/mismatch rules use its separate deployment-owned PostgreSQL reconciliation-exporter contract. Import `deploy/dashboards/simulation-v1.grafana.json` with the environment's Prometheus datasource to see command, lease, process, queue, throughput, and external integrity sources separated. No data in an external panel is unknown coverage, not zero. Local Compose supplies no Prometheus/Grafana deployment, alert routing, receiver credentials, or privileged scanner; each environment must validate OTLP name translation, exporter freshness, thresholds, receivers, and a non-production drill.

## Command, ledger, outbox, and projection incidents

Treat PostgreSQL command/event/ledger rows as authoritative and the readable history table as derived. Never retry an uncertain mutation with a new identity until `GET /api/v1/commands/:commandId` has resolved the original ID. Exact command/idempotency reuse is safe; changed reuse is an incident/client defect.

- **Stuck received command:** stop the affected command type, inspect only command identity/type/timestamps and transaction/database health, and determine whether its transaction committed. A normally rolled-back transaction leaves no row. Do not synthesize an accepted response or event. Reconcile only through a reviewed forward operation that preserves the original identity and ledger ordering.
- **Hash, sequence, or head mismatch:** freeze all active-world writers for the world, retain database/backups and verifier output, run `pnpm ledger verify --world <uuid>` through an audited read connection, and identify the exact first bad sequence. Do not rehash, renumber, edit, or delete an entry. Escalate as an integrity incident and restore/PITR or use a reviewed append-only procedure.
- **Projection checksum mismatch:** freeze the affected command types, verify the ledger first, run `projection replay --target shadow` and `projection compare`, and inspect the durable replay record. Replay never changes live state. Use `repair-swap` only for proven projection divergence with an unchanged source head, two distinct active platform-administrator approvals, an incident reason, owner credentials, and the exact confirmation phrase.
- **Dead or old outbox:** accepted authority is not rolled back. Fix the worker/database cause and inspect only message IDs/types/attempts/age. Pending work remains with the normal leased worker; a published row is immutable. A dead row may return to `pending` only through the audited owner procedure below, which appends a private retry intent while preserving the same message/event identity and attempt count. Unique consumer receipts make duplicate delivery safe.
- **Genesis/backfill failure:** keep active-world commands blocked. Confirm the exact active version/artifact and graph checksum, correct the infrastructure or restore to the pre-migration state, then rerun the forward migration. Never invent prior actions or manually mark `ledger_anchored_at`.

`ledger export` requires an explicit new path and `--actor` identity for an active platform administrator, creates mode `0600`, refuses overwrite, and appends correlated authorization/completion security-audit records without changing the world ledger. Replay, compare, repair, and export verify that `OPERATIONS_DATABASE_URL` connects as the database owner (or a member of that owner role) as well as validating the actor identity. Store exports as sensitive member/operator evidence under the deployment retention policy. `OPERATIONS_DATABASE_URL` is owner-grade and must be supplied only to a human-audited maintenance process; it must not be present in API, web, or ordinary worker environments.

### Reviewed dead-outbox retry

Retry a dead outbox row only after correcting the publisher/consumer incompatibility and verifying that its original domain event, ledger entry, and message type are still valid for redelivery. Use an owner-authorized maintenance connection, a new operator-reviewed retry UUID, an active platform administrator, and a private incident reason:

```sh
: "${OPERATIONS_DATABASE_URL:?inject the owner-authorized operator secret out of band}"
pnpm outbox retry \
  --world "$WORLD_ID" \
  --message "$OUTBOX_ID" \
  --retry "$RETRY_ID" \
  --reason 'INCIDENT-1234 corrected publisher compatibility' \
  --confirm 'RETRY DEAD OUTBOX MESSAGE' \
  --actor "$ADMIN_ID"
```

This operation appends one private `outbox_retry_intents` audit fact and moves the same dead message back to `pending` under the world writer lock. It preserves the original message/event identity and payload and does not reset its attempt count. The reason is 20–1,000 Unicode code points, is never returned in the safe receipt, and must not be copied to telemetry or an ordinary ticket. Application and ordinary worker roles cannot read the private intent table or call the owner function.

Exact reuse of the retry UUID with byte-identical inputs returns the original requeue time and prior-attempt evidence together with the message's current status/attempt count. If that message has become dead again, the CLI fails closed: investigate the new failure generation and use a new reviewed retry UUID only after correcting it. Changed reuse, a cross-world message, a non-dead first attempt, an inactive/non-administrator actor, a forged execution gate, or direct table mutation is prohibited. Never update `outbox_messages`, mark a message published, reset attempts, or synthesize a replacement domain event manually.

## Simulation controls and incidents

PostgreSQL clock, schedule, accepted commands/events/ledger, and semantic simulation checkpoint are authority. Leases and batch/failure rows are operational evidence; Redis/BullMQ is a disposable wake mechanism. Never advance a clock, complete/cancel a schedule, replace a checksum, clear an unexpired lease, resolve a failure, or change `error` mode with direct SQL.

Continuous execution is controlled by `SIMULATION_CONTINUOUS_ENABLED`; disabling it stops automatic advancement while leaving read state and deliberate manual paused-mode advancement available. `SIMULATION_RECONCILIATION_INTERVAL_MS`, `SIMULATION_LEASE_MS`, `SIMULATION_MAXIMUM_WORLDS_PER_RUN`, `SIMULATION_MAXIMUM_ATTEMPTS`, `SIMULATION_RETRY_BASE_MS`, and `SIMULATION_MAXIMUM_BACKOFF_MS` are bounded startup configuration. Lower throughput or disable continuous mode before rollout/rollback; do not raise clock-level batch/catch-up limits as an incident shortcut.

- **Redis/wake outage:** disable or observe degraded continuous wake delivery, retain clocks unchanged, restore Redis, and let periodic PostgreSQL reconciliation rediscover due worlds. Do not recreate jobs, batches, schedules, or commands. Manual controls remain authoritative when PostgreSQL is healthy.
- **Stuck running clock or backlog:** inspect safe tick/mode/cadence/wall-anchor, due-action counts, current batch/lease identity, command status, and stable metrics. Confirm the worker binary, runtime schema 9, and simulation schema/process-registry compatibility. If the gap exceeds `maxCatchUpTicks`, repeated wakes intentionally emit no advance. Deliberately pause through `PauseWorldClockV1`, review the gap, apply only creator-approved bounded manual advances, and start again to establish a fresh wall anchor. Do not raise the limit to bypass acknowledgement.
- **Expired/stuck lease:** allow expiry and normal acquisition to increment the fencing token. A stale worker must return fenced. Never reuse an owner/token or delete a current lease; if database time or ownership is suspect, stop workers and treat it as a coordination incident.
- **Uncertain/crashed advance:** query the original command ID. Accepted means the clock, due terminal actions, facts, batch, checkpoints, ledger, and outbox committed together; absent/rolled-back work remains eligible after lease recovery. Do not issue a new command identity until the original result is known.
- **Auto-pause/process failure:** keep the world fail-closed and acknowledge the critical alert. Inspect only process/action versions, tick/schedule/batch identities, attempts, semantic hashes, and the stable redacted code. Verify the released process version against the deterministic fixture. Then submit authenticated `ResolveSimulationFailureV1` with the current world/state/tick and failure aggregate versions: choose `retry_after_repair` only after a compatible versioned handler is deployed and verified, or `cancel_action` to atomically cancel the still-scheduled broken action. Both choices append audit facts and leave the clock `paused`; start or advance later with a separate bounded command. Resolve an uncertain response by its original command ID. Never skip the action, edit rows, or mark the failure resolved manually.
- **Outcome/checkpoint mismatch:** stop automatic and manual advances for the world, retain the database and verifier output, verify the M06 ledger first, run the evidence-only `simulation_runtime` replay/compare commands below, and identify the first divergent canonical path and action/process version. Treat unexpected divergence as an integrity incident; do not overwrite hashes or normalize operational IDs into the semantic checksum.
- **Overdue schedule after pause:** paused time does not advance, so it is not overdue in world ticks. If a scheduled action is at or before the persisted current tick while still scheduled, freeze writers and investigate atomicity/integrity rather than forcing execution.

Safe pause/resume is always a fresh authenticated command against the current tick/state/clock aggregate version. Starting/resuming establishes a new wall anchor; pausing invalidates later stale automatic attempts. Large downtime is recovered through several bounded reconciliations or an explicit creator-reviewed manual range—never one unbounded transaction.

### Simulation projection replay and restoration

Set `OPERATIONS_DATABASE_URL` to an owner-authorized connection and use an active platform-administrator actor. These commands record replay evidence but never print payloads or mutate live simulation state:

```sh
pnpm projection replay --world <uuid> --projection simulation_runtime \
  --target verify --reason "INCIDENT-123 simulation verification" \
  --actor <platform-admin-uuid>
pnpm projection compare --world <uuid> --projection simulation_runtime \
  --run <replay-run-uuid> --actor <platform-admin-uuid>
```

For a mismatch:

1. Freeze API mutation and all simulation workers for the affected world; preserve the database, backup/PITR window, verifier output, replay run ID, source event head, and incident reason.
2. Run `pnpm ledger verify --world <uuid>`. If event bytes, event/ledger ordering, hashes, genesis identity, or heads fail, stop. A projection repair is not a ledger repair.
3. Create the `simulation_runtime` replay above and compare it at the unchanged source head. A stale run must be discarded and repeated; never reinterpret it against a newer head. Review the payload-free divergence path and verify the run's active version, artifact hash, version number, and compiled seed provenance.
4. Prefer restore/PITR into an isolated environment, migrate only forward, and repeat ledger plus graph/simulation comparisons before promotion. `simulation_batch_runs` and lease rows are operational and are not rebuilt by semantic replay.
5. If PITR cannot meet the approved recovery objective, implement a reviewed forward migration or dedicated owner function; do not use an interactive row patch. It must hold the per-world writer lock, prove the same successful replay and unchanged source head, require two distinct active platform-administrator approvals plus a separate owner executor and incident reason, and reject an equal projection. It must derive semantic clock/schedule values from the replay reducer, define any non-event operational row fields through an explicit reviewed rule, reconcile event-recoverable failure state without inventing missing operational batch evidence, and append a new simulation-specific repair command/event/ledger/outbox/history fact while advancing the graph and simulation checkpoint positions coherently. Existing events, ledger entries, and migration `0008` remain byte-identical.
6. Do not call graph `projection repair-swap`: `ProjectionRepairAnchoredV1` validates `world_graph`, not `simulation_runtime`. M07 intentionally ships no automatic simulation swap.
7. After restoration, rerun ledger verification and fresh graph/simulation replay comparisons, verify schedule terminal identities and open failures, clear only expired leases, then resume in `paused` mode before any bounded manual step or continuous start.

The replay state retains event-recoverable failure facts for diagnosis, but the semantic simulation checksum covers only clock and schedule state. Failure redacted context and batch-attempt records are operational evidence; if those rows are lost or inconsistent, restore/PITR is required rather than fabricating them.

## Economy controls and incidents

PostgreSQL commands/events, immutable financial postings and asset transfers, and the synchronous balance/supply/title projections are authority. Redis, browser state, UI previews, and telemetry are not. Never update a balance, supply, owner, offer terminal state, journal fact, or economy checksum directly.

`ECONOMY_TRANSFERS_ENABLED`, `ECONOMY_OFFERS_ENABLED`, and `ECONOMY_ISSUANCE_ENABLED` reject their respective new user commands. `ECONOMY_DEBITS_FROZEN` is the broad emergency stop for new debits. Per-route transfer/offer/issuance limits and the bounded offer-reconciliation interval/batch size are validated at startup. None of these controls disables database invariants, participant privacy, read-only verification, or authoritative-tick offer expiry.

### Failed economy initialization

1. Keep transfers, offers, and issuance disabled for the world. Inspect the active world version, exact artifact/compiler/schema pairing, persisted seed source/adapter/plan hash, adoption command if legacy, and stable failure code. Do not copy plan bytes or controller identities into logs/tickets.
2. For compiler `1.1.0` artifact 2, verify the native plan and domain-separated hash against the content-addressed artifact. For compiler `1.0.0` artifact 1, verify that the exact adapter candidate is unambiguous and that the active creator accepted that exact candidate. Never reinterpret an artifact through the wrong verifier.
3. Resolve an uncertain adoption or initialization by its original command ID. Exact accepted replay is safe; a new identity must not be created until the old result is known.
4. A missing/incompatible plan is a safe `not_initialized` outcome. Correct manifest/compiler intent through a new version, or perform the explicit legacy adoption; do not insert seed rows, alter a stored artifact, or invent balances/title.
5. For a database/transaction failure, restore service and repeat the same idempotent command. A rollback must leave no partial currency, wallet, posting, asset, owner, ledger, history, checkpoint, or outbox state. Unexpected partial state is an integrity incident requiring writer freeze and restore/PITR or reviewed forward repair.

### Economy invariant or reconciliation failure

1. Set the broad debit stop and disable transfer/offer/issuance commands for the affected world. Stop economy workers if their command path is implicated. Preserve the database, backup/PITR window, migration/version state, verifier output, source event/state revision, and reconciliation run/hash.
2. Run general ledger and simulation verification first. If immutable event, ledger, transaction, posting, asset-transfer, or source-head evidence is corrupt, stop; a projection repair cannot repair facts.
3. Repeat economy reconciliation at an unchanged source revision. Compare isolated derived balance, supply, and title material with live projections and record only bounded counts/hashes plus the first safe divergent path. Do not export private memos or full journals to an ordinary ticket.
4. Prefer restore/PITR into an isolated environment, apply only forward migrations, and repeat ledger, simulation, and economy verification before promotion.
5. If the approved recovery objective cannot be met by restore, implement a dedicated versioned compensating command. Require distinct active platform-administrator and creator operational approvals, a bounded incident reason, an owner-authorized executor, the unchanged source head, and a reviewed semantic delta. The command appends facts/events/ledger/history/checkpoints and never edits/deletes the original transaction, posting, transfer, balance, supply, owner, event, or checksum.
6. Reconcile again, review controllers/open offers/frozen state, then re-enable one mutation class at a time. Any attempted negative balance/supply, cap breach, posting imbalance, owner duplication, or paid-title partial state is critical even if the database correctly rejected it.

### Economy command contention

Inspect command kind/outcome, bounded serialization-retry metrics, database lock wait, and the documented acquisition order. Do not log wallet/asset/user IDs or amounts as metric labels. Confirm handlers acquire world → runtime/ledger/economy → tick-sensitive clock → currency/supply → offer → asset/title → sorted wallets. Database-owned allocator heads remain behind owner functions and should not be application-lock targets. Reduce traffic or temporarily freeze debits before changing timeouts. Never weaken isolation, expected versions, nonnegative checks, or idempotency to improve throughput.

### Uncertain transfer or paid purchase

Look up the original command ID. `accepted` means postings, balance/supply, title, offer terminal state, events, ledger, checkpoints, history, and outbox committed as one revision. `rejected` means none of those effects committed. An unavailable/unknown result must be polled with the same ID; do not submit a new idempotency identity, issue a refund, gift title, or edit projections manually. Reconciliation is evidence, not a substitute transaction.

### Expired offer reconciliation

The worker performs bounded PostgreSQL discovery against each world's persisted tick and executes `ExpireAssetTransferOfferV1`. It does not require Redis or continuous simulation. Check the worker heartbeat, database connectivity, interval/batch bounds, open-offer count, current tick, tick lag, and stable command outcomes. Duplicate discovery is safe; accept/cancel/expire races lock and recheck the same row, so exactly one terminal transition wins. Do not change expiry ticks, mark rows expired, enqueue M07 scheduled actions, or enable continuous clocks to force cleanup.

### Creator issuance review

Every issuance is a creator-only, explicit override with a bounded reason, exact supply version, cap check, rate limit, command/event/journal evidence, and alert. Resolve uncertain response by command ID, verify the resulting supply and treasury posting through reconciliation, and review the creator/controller incident context. Initialization is not an issuance override. Do not describe issuance as deposit, cash, investment, or external value and never adjust supply/balance directly.

### Currency or wallet freeze and compromised controller

Use `FreezeCurrencyV1` or `FreezeWalletV1` with current versions and a bounded reason; `ECONOMY_DEBITS_FROZEN` can immediately stop all new debits while the scoped command is prepared. Revoke compromised sessions/controller authority through the identity procedure, inspect redacted command/history evidence, reconcile, and resolve outstanding direct offers normally. Unfreeze only with a separate reviewed command/current version. Frozen state does not authorize direct status edits, cancellation by SQL, or disclosure of another participant's transaction detail.

### Duplicate reward or idempotency investigation

Preserve both request identities and look up their command/idempotency records, request hashes, transaction/event links, and posting counts using an audited operator path. Exact reuse must address one effect; changed reuse must reject. Compare supply and wallet projections to immutable facts. Do not delete a duplicate or reverse it in place. If a true duplicate effect bypassed the guards, freeze debits, treat it as an integrity incident, and use a reviewed append-only compensation only after the source failure is fixed.

### Append-only economy repair

There is no general balance/title editor. First prove the immutable source facts, obtain a current matched reconciliation at an unchanged head, document why PITR is not acceptable, and identify one eligible accepted source command. The V1 owner workflow can prepare only an exact reversal of a currency transfer, issuance, owner gift, or atomic purchase; initialization, another compensation, arbitrary amounts/owners, a non-latest title, an asset with an open offer, and projection-only divergence are ineligible.

`OPERATIONS_DATABASE_URL` is a separate owner-grade credential. Its connected PostgreSQL role must be the database owner or a member of the database-owner role; an ordinary `worldgraph_app` URL is intentionally insufficient. The CLI separately verifies that `--actor` names an active WorldGraph platform administrator. Neither check substitutes for the other. Inject this URL from the approved secret runner only for the human-audited maintenance session. Never place it in a command argument, shell history, plan file, incident ticket, API/web environment, or ordinary worker environment.

Freeze economy mutations and economy workers for the affected world before the final matched reconciliation. Keep them frozen through preparation, both approvals, execution, ledger verification, and post-repair reconciliation. Preparation binds the exact world version, state revision, event sequence, economy head/checksum, source facts, and reconciliation run. Any relevant head change makes the plan stale. The plan expires exactly 24 hours after `preparedAt`; both approvals and first execution must complete before `expiresAt`. Never extend an expiry or replace a stored hash. If the head changes or the plan expires, discard it, reconcile at the new unchanged head, and prepare and approve a new plan.

From the repository root, inject the owner-authorized connection out of band and prepare the plan with an active platform-administrator actor:

```sh
: "${OPERATIONS_DATABASE_URL:?inject the owner-authorized operator secret out of band}"
WORLD_ID='<world-uuid>'
SOURCE_COMMAND_ID='<eligible-accepted-source-command-uuid>'
PREPARING_ADMIN_ID='<active-platform-admin-uuid>'

pnpm economy repair-prepare \
  --world "$WORLD_ID" \
  --source-command "$SOURCE_COMMAND_ID" \
  --actor "$PREPARING_ADMIN_ID" \
  --reason-code DUPLICATE_EFFECT \
  --incident-reason 'INCIDENT-123 duplicate effect confirmed from immutable evidence' \
  --pitr-not-used-reason 'PITR cannot meet the approved recovery objective for this incident'
```

`--reason-code` is exactly `DUPLICATE_EFFECT`, `ERRONEOUS_EFFECT`, or `INCIDENT_RECOVERY`. Each private reason is 8–500 Unicode code points, must not start or end with ASCII U+0020 space, and must contain no C0, DEL, or C1 control; non-ASCII spacing is preserved as incident evidence. The command writes the complete canonical repair plan JSON to standard output. That output is not a safe general-purpose receipt: it contains private reasons, source evidence, entity/wallet/asset IDs, exact amounts, before/after values, reserved IDs, and the semantic delta. Review it only in an audited restricted terminal. If policy requires retention, capture it only in an approved encrypted evidence store with access limited to the incident operators and file-equivalent mode `0600`; never paste it into chat, telemetry, browser analytics, a shared log, or an ordinary ticket. Do not hand-edit, reformat and rehash, or submit a plan copied from another environment.

Approval is deliberately outside the owner CLI. The two approvers independently authenticate through the normal API session, fetch the full exact plan from `GET /api/v1/worlds/:worldId/economy/repair-plans/:planId`, and compare its world, source command, delta, reasons, source heads, expiry, and `planHash` to the reviewed evidence. Then:

1. The world's active creator generates a new approval UUID and posts it to `/api/v1/worlds/:worldId/economy/repair-plans/:planId/approvals` with `authorityKind: "creator"`, the exact plan hash, and `confirmation: "APPROVE APPEND-ONLY ECONOMY REPAIR"`.
2. A distinct active platform administrator performs an independent full-plan review, generates a different approval UUID, and posts the same hash and confirmation with `authorityKind: "platform_admin"`.
3. Each request supplies its approval UUID as both body `approvalId` and the exact `idempotency-key` header, plus the normal allowed `Origin`, session cookie, and matching CSRF token. Exact retry reuses every byte and returns the original approval; changed reuse is a conflict.
4. Re-fetch the plan and require `approvalStatus.creator`, `approvalStatus.platformAdmin`, and the original `planHash` before execution. The platform administrator who supplied the second approval must also be the `--actor` that executes it. Approval does not make the plan safe after expiry or a head change.

Execute only after both approvals and before expiry. Copy only `repairPlanId` and `planHash` from the reviewed private plan into these placeholders; do not pass the plan body:

```sh
: "${OPERATIONS_DATABASE_URL:?inject the owner-authorized operator secret out of band}"
WORLD_ID='<world-uuid>'
PLAN_ID='<repair-plan-uuid>'
PLAN_HASH='<64-lowercase-hex-plan-hash>'
EXECUTING_ADMIN_ID='<same-platform-admin-uuid-that-approved-the-plan>'

pnpm economy repair-execute \
  --world "$WORLD_ID" \
  --plan "$PLAN_ID" \
  --plan-hash "$PLAN_HASH" \
  --actor "$EXECUTING_ADMIN_ID" \
  --confirm 'APPLY APPEND-ONLY ECONOMY REPAIR'
```

Execution rechecks the owner/member database boundary, executing administrator, two distinct still-active approvers, exact hash, expiry, unchanged source/world/economy/reconciliation heads, balances, supply, latest title, open offers, and complete derived delta under the world writer lock. It atomically appends one compensation transaction and/or inverse title transfer, one private event, a `repair_anchor` ledger entry, redacted member/participant history, an outbox reference, checkpoints, execution audit, and the new current projections. It never edits the source fact.

Successful execution prints a bounded JSON receipt containing only `repairPlanId`, command/event/ledger IDs, nullable compensation transaction/asset-transfer IDs, resulting state/event/ledger positions, economy checksum, and world ID. Store that receipt in the restricted incident record; do not replace it with the full plan. If the result is uncertain, repeat the exact `repair-execute` command with the same plan, hash, and administrator. An exact completed replay returns the original receipt, and concurrent execution can create only one effect. Never generate a second execution identity, issue a manual refund, or infer success from a timeout.

Keep writers frozen and verify immediately:

```sh
pnpm ledger verify --world "$WORLD_ID"
```

If ledger verification fails, stop and preserve the database and receipt as an integrity incident. If it passes, immediately submit `ReconcileWorldEconomyV1` through the normal authenticated command API/UI using the new exact economy-head and state/world versions, then fetch the economy summary and require `reconciliation.status: "current"`, the new repaired state revision, a new reconciliation timestamp, and the expected checksum. Review the affected title/open-offer state where applicable. Re-enable one mutation class at a time only after both ledger verification and reconciliation succeed.

A repair that changes or deletes old commands, hashes, postings, transfers, events, ledger entries, approvals, plan evidence, or projections directly is prohibited. Never use interactive SQL, disable triggers/constraints, change a balance/supply/owner row, mark a plan executed, manufacture an approval, or grant the application database role owner membership. Restore/PITR or a new reviewed forward append-only plan are the only alternatives.

## Productive commerce controls and incidents

M09 resource, inventory, business, employment, production, market, tax, and treasury mutations remain PostgreSQL-authoritative. The existing M08 journal is still the only balance/supply authority, and the M07 schedule is the due-time authority. Browser preview, Redis/BullMQ delivery, telemetry, and worker memory confer no authority.

`COMMERCE_SCHEDULE_ENABLED` defaults true and controls only the bridge from completed M07 actions to narrow commerce system commands. `COMMERCE_SCHEDULE_BATCH_SIZE` defaults 25 and is bounded 1..250. `COMMERCE_SCHEDULE_RECONCILIATION_INTERVAL_MS` defaults 1,000 ms and is bounded 100..60,000 ms. Disabling the bridge leaves durable schedules and target aggregates unchanged. `ECONOMY_JOBS_ENABLED`, `ECONOMY_PRODUCTION_ENABLED`, `ECONOMY_LISTINGS_ENABLED`, and `ECONOMY_PURCHASES_ENABLED` separately refuse those new public mutations; `ECONOMY_WORK_RATE_LIMIT_PER_MINUTE`, `ECONOMY_PRODUCTION_RATE_LIMIT_PER_MINUTE`, `ECONOMY_LISTING_RATE_LIMIT_PER_MINUTE`, and `ECONOMY_PURCHASE_RATE_LIMIT_PER_MINUTE` are bounded 1..1000. `ECONOMY_DISABLED_TAX_POLICY_IDS` is an empty-by-default allowlist of at most 64 unique policy UUIDs to suppress. Add a policy only after recording its exact ID and operational reason, apply the identical value to API and worker, and restart both processes. API job and purchase commands skip that policy and may select the next eligible policy; existing payroll snapshots do not change. The worker omits a disabled periodic policy from discovery, and its executor rejects direct attempts before opening a database transaction, so the completed M07 occurrence remains recoverable. Remove the ID only after review: the next sweep assesses at the authoritative current tick, then schedules the following occurrence from that tick under the documented skip-missed rule. No switch may bypass authorization, idempotency, exact arithmetic, reservations, balanced postings, tax, ticks, or database constraints.

### Active M08 world and upgraded-database boundary

Migration `0010`–`0012` upgrades the database schema and compatibility metadata; it does not add commerce intent or state to an already-active compiler-1.1/artifact-2/plan-1 world. M09 has no supported post-activation recompile, artifact-upcast, whole-world regeneration, or plan-2 adoption command for that world. Treat any M09 rows attributed to such a world as unexpected state: stop affected writers, preserve the database/PITR window, and reconcile before proceeding. Do not manufacture a plan, change a world-version pointer, or call initialization with another world's artifact.

The M09 upgraded-database acceptance procedure preserves and snapshots the active M08 world's exact artifact/plan, graph/runtime, ledger/checkpoint, scheduler, wallet/journal, and asset/title identities before migration; verifies the same identities and zero M09 state afterward; then creates and compiles a new compiler-1.2/artifact-3/plan-2 harbor world on that same upgraded database for the complete demo. The existing M08 world is preservation evidence, not the demo target. Post-activation world evolution is deferred to the M13 versioned patch/migration workflow.

### Business funding and employment consent boundaries

`CreateBusinessV1` binds a backing organization to one of its existing active organization wallets and does not move or mint value. Fund that wallet only with the ordinary authorized `TransferCurrencyV1` flow and its own expected wallet versions and idempotency identity. If the transfer fails or its outcome is uncertain, resolve the transfer command by its original identity; do not rerun business creation, edit the balance, or describe the two commands as one atomic effect.

Compiler-authored employment offers are role-and-wage templates, not worker-bound contracts. A current business manager creates a bounded contract for a selected worker, and the currently controlled worker separately accepts it. Do not seed or activate a participant contract administratively, infer acceptance from membership, or describe a template as the immutable source of a contract when no source-offer identity was recorded.

### Stuck scheduled commerce effect

A completed M07 action can wait for the bridge, but it must never be reset to `scheduled`, edited, or replaced. The authoritative target remains pending/open/active until its narrow system command commits.

1. Confirm API, worker, PostgreSQL, and Redis readiness, `COMMERCE_SCHEDULE_ENABLED`, and whether the target policy ID is intentionally present in `ECONOMY_DISABLED_TAX_POLICY_IDS`. Redis loss can delay a wake but cannot erase the completed schedule; the PostgreSQL sweep is the recovery path.
2. Compare `worldgraph_commerce_scheduled_effects_pending`, scheduler lag by allowlisted action type, sweep outcomes, and worker heartbeat. Query a bounded set of due rows through an audited operator connection, selecting only world/schedule/target ID, action type, due/current tick, target status, and command causation. Do not export payloads, payroll terms, amounts, or participant data.
3. Require a completed scheduled action of type `CompleteProductionRunV1`, `SettlePayrollV1`, `ExpireMarketListingV1`, or `AssessPeriodicTaxV1`; the target must still be in its expected pending/open/active state. Search for an already accepted command with the schedule completion as causation before assuming it is missing.
4. Restart or wake the worker and let it reuse actor `worldgraph:commerce-scheduler` and idempotency `commerce-schedule-v1:<ActionType>:<scheduledActionId>`. Exact retry is safe. Never create a new key, call a system command through the public route, or hand-edit a target.
5. If the target is already terminal, discovery should ignore it. Verify its command/event/ledger/checkpoint evidence and treat any contradictory effect as an integrity incident.
6. On repeated stable failures, preserve the original command/schedule IDs and safe error codes, pause the affected mutation class and, if continued tick movement would accumulate risk, pause the world clock through its command. Verify ledger, core economy, and commerce reconciliation before resuming.

### Inventory reservation or production backlog

`worldgraph_commerce_inventory_reservations_active` is the current global active-reservation count. `worldgraph_commerce_inventory_reservation_max_age_ticks` subtracts the reservation creation event's persisted `tick` from that world's authoritative simulation tick. `worldgraph_commerce_production_runs_overdue` counts ready runs strictly behind their due tick, and `worldgraph_commerce_production_max_overdue_ticks` reports the maximum such lag. Polling cadence and wall time do not decide age, due state, or expiry.

There is deliberately no targetless operator command to expire or release an “orphan” reservation. A valid reservation is inseparable from its listing or production-run lifecycle: fill/cancel/expiry consumes, releases, or expires the listing reservation, while completion/failure consumes or releases the production inputs. A missing or contradictory target is integrity corruption, not a routine age-based expiry condition.

1. Confirm the snapshot gauges and commerce scheduler gauges are present. A non-zero active count alone is normal; investigate when maximum age or overdue ticks remain above the environment's reviewed threshold.
2. Through an audited operator connection, fetch a bounded oldest-first set with only reservation purpose/status, target status, creation/due/current ticks, schedule state, and safe identifiers. Do not export quantities, recipe snapshots, payroll terms, counterparties, or wallet data.
3. A market reservation is legitimate only while its listing remains open; a production reservation is legitimate only while its run remains ready for its exact completion schedule. If the target is due and its completed schedule has no accepted causally linked system command, follow the stuck-scheduled-effect procedure and retry the original deterministic identity.
4. If target, reservation, immutable movement, or schedule state contradict each other, freeze the affected mutation class and run ledger plus commerce reconciliation. Do not release a reservation, consume inventory, change a due tick, or manufacture a terminal transition directly.
5. A treasury, tax, payroll, production, listing, reservation-fact, or schedule mismatch is outside the narrow inventory projection repair boundary. Preserve the PITR window and use the documented reconciliation/restore decision.

### Production completion incident

Verify the run's exact recipe version, facility/asset container, input snapshot, active reservations, due schedule, and current tick. A valid completion consumes all input reservations and journals all outputs into the configured facility container in one command. Do not consume inputs at start, redirect outputs to another inventory, create output manually, or mark a run complete. If the system command failed, confirm it created no partial inventory movement before exact retry. A corrupted recipe, movement, or reservation requires the mismatch/restore procedure.

### Payroll settlement incident

Verify the immutable work record, pending payroll record, exact schedule, business wallet, worker wallet, and tax-policy snapshot chosen at the work tick. Do not apply the policy active at settlement time or recalculate an old payroll from current policy. A failed payroll must have no financial transaction. For insufficient funds or a legitimate domain failure, retain the failure evidence and resolve through an authorized later product workflow; do not manufacture a wage posting or flip status. A timeout is resolved by original command ID and schedule causation.

### Listing expiry or market settlement incident

For expiry, require current tick at or after `expires_at_tick`, a completed matching schedule, an open listing, and an active reservation equal to its remainder. Exact system-command retry releases the remainder once. Do not change the expiry tick or reservation directly.

For purchase uncertainty, look up the original command ID. Accepted means inventory movement, reservation/listing transition, gross/tax/fee/net postings, trade, assessment, treasury evidence, ledger, outbox, and checkpoints all committed at one state revision. Rejected means none committed. Do not submit a new purchase identity, refund manually, or infer success from a changed balance alone. A final-unit purchase/cancel/expiry race has exactly one winning terminal transition under the listing lock.

### Periodic tax incident

Verify the immutable policy, exact payer entity/wallet, treasury wallet, effective range, occurrence tick, schedule causation, and previous assessment. One due occurrence creates at most one assessment/financial transaction and schedules the next tick as `occurrenceTick + intervalTicks`. Downtime does not authorize catch-up billing: missed periods are skipped according to the code-owned recurrence rule. Do not enqueue one action per missed interval, move effective ticks, change a policy, or edit a treasury balance.

### Treasury settlement reconciliation

The worker's authoritative PostgreSQL snapshot compares every treasury wallet's balance projection with the sum of all its immutable journal postings. `worldgraph_commerce_treasury_reconciliation_delta_minor` is the global sum of absolute differences and `worldgraph_commerce_treasury_reconciliation_mismatches` is the number of differing treasury wallets. Both must be zero. This covers initialization, issuance, market, payroll, periodic-tax, and any reviewed compensation posting without mistaking legitimate non-tax treasury activity for a difference. The minor-unit value is a gauge, never a label, and saturates only above JavaScript's exact telemetry integer range; any positive value is already an incident.

1. Freeze affected commerce writers and the world clock, preserve the database/PITR window, and confirm both gauges from the same worker snapshot. Do not treat a missing series as zero.
2. Through a restricted audited operator path, find a bounded set of differing treasury wallets and compare each projected balance with its complete immutable posting sum. Separately verify relevant tax assessments against their settlement transactions. Keep amounts and wallet, payer, trade, payroll, and policy identifiers out of ordinary telemetry and tickets.
3. Run general ledger verification, core-economy reconciliation, and M09 commerce reconciliation at an unchanged head. A missing assessment or posting is immutable-authority damage; a treasury wallet-balance difference is a core-economy projection incident.
4. Never insert an assessment or posting, edit a treasury balance, issue compensation, or use the inventory-only commerce projection repair to force zero. Follow whole-database restore/PITR or a separately reviewed forward repair design.
5. Resume one mutation class at a time only after ledger verification and both economy reconciliations are current and the next authoritative snapshot reports zero delta and zero mismatches.

### Commerce realtime invalidation failure

The worker publishes schema-1, ID-only invalidations from the durable outbox to `worldgraph:commerce:v1:world:<worldId>`. This Redis channel is internal transport, not authority or an authorization boundary. A browser gateway is not part of M09; any later gateway must authorize the authenticated subscriber for the world before relaying. Never expose Redis directly to a client.

1. Check Redis and worker readiness, outbox age/dead-letter signals, and `worldgraph_commerce_realtime_publications_total{message_type,outcome}`. `published_no_subscribers` is a successful result when no gateway is attached; do not alert on it.
2. For `COMMERCE_REALTIME_NOTIFICATION_INVALID`, stop the incompatible worker and verify its contract/runtime build. Do not remove schema validation or copy event payload fields into the message.
3. For `COMMERCE_REALTIME_PUBLISH_FAILED`, restore Redis and allow the same leased outbox message to retry. A publish acknowledged just before database commit uncertainty may be repeated; this is safe because messages are invalidations with cursor/state revision, not deltas.
4. Consumers must ignore an older/equal cursor as appropriate and refetch the corresponding authorized API projection. They must not apply quantity, money, tax, ownership, or status changes from an invalidation.
5. If a message is dead-lettered, preserve its outbox/event identity, correct the transport or compatible publisher, and follow the outbox replay procedure. Do not synthesize a new domain event or mark the row published manually.

### Commerce reconciliation mismatch

1. Refuse affected production, job, listing, purchase, and scheduled-effect mutations. Pause the clock if further due actions could increase the incident surface. Preserve a database snapshot/PITR window, migration head, source state/event sequence, expansion head/checksum, run/item evidence, and related safe command IDs.
2. Run general ledger verification, M08 economy reconciliation, and simulation verification first. If immutable events, ledger, postings, movements, work, trades, assessments, or schedule facts are corrupt, stop; projection recovery cannot repair authority.
3. Run `ReconcileWorldCommerceV1` once more only if the source revision is unchanged. Compare the isolated inventory, reservation, production, trade, payroll, tax, and aggregate checksums. Use bounded operator-only mismatch items; do not place private keys, wages, amounts, inventories, or counterparties in ordinary tickets.
4. If immutable authority is damaged, the mismatch is outside the inventory quantity/reservation repair domain, or the reviewed repair preconditions cannot be proven, prefer restore/PITR into an isolated environment. Apply migrations only forward, then require ledger, graph, simulation, M08 economy, and M09 commerce checks to match before promotion. Restore the whole coherent database, not one projection table.
5. Keep writers frozen after restore, verify pending schedules against target state and original command causation, then resume in paused mode and re-enable one mutation class at a time.

### Commerce repair boundary

`RepairEconomicProjectionV1` is a private, owner-authorized recovery workflow for one narrow case: restoring inventory quantity and reserved-quantity projections to values rebuilt from immutable inventory-movement and reservation facts. It is absent from the public command registry, API routes, browser, and ordinary worker authority. The M08 `RepairWorldEconomyV1` remains a separate accounting/title compensation workflow.

Keep commerce writers and the world clock frozen throughout the procedure. First verify the general ledger, graph, simulation, M08 economy, immutable commerce facts, and the latest M09 reconciliation. The latest reconciliation must still be a mismatch at the exact current runtime, event, ledger, core-economy, and commerce-expansion heads. If any authoritative fact is corrupt, any head changes, or the mismatch concerns production, payroll, listings, trades, tax, treasury, commands, events, ledger, or checkpoints rather than an inventory projection, stop and restore/PITR the whole coherent database.

Prepare the private 15-minute plan as the first active platform administrator through an owner-grade maintenance session:

```sh
: "${OPERATIONS_DATABASE_URL:?inject the owner-authorized operator secret out of band}"
pnpm economy projection-repair-prepare \
  --world "$WORLD_ID" \
  --actor "$PREPARING_ADMIN_ID" \
  --reason 'INCIDENT-COMMERCE-1234 inventory projection mismatch'
```

The reason is 20–1,000 Unicode code points, may not start or end with an ASCII space, and may not contain control characters. Preparation changes no projection. Its canonical private output seals the exact source heads, latest reconciliation, UUID-sorted affected inventory rows, expected row versions, rebuilt values, reserved command/event/ledger/fact identities, expiry, and plan hash. Treat this output as sensitive incident evidence: do not edit it or paste it into chat, telemetry, browser analytics, shared logs, or ordinary tickets.

A second active platform administrator, distinct from the preparer, must independently review the exact plan and approve its hash:

```sh
pnpm economy projection-repair-approve \
  --world "$WORLD_ID" \
  --plan "$REPAIR_PLAN_ID" \
  --plan-hash "$REPAIR_PLAN_HASH" \
  --approval "$APPROVAL_ID" \
  --actor "$APPROVING_ADMIN_ID" \
  --confirm 'APPROVE APPEND-ONLY COMMERCE REPAIR'
```

The same approving administrator executes before expiry, again presenting the exact hash and a separate confirmation:

```sh
pnpm economy projection-repair-execute \
  --world "$WORLD_ID" \
  --plan "$REPAIR_PLAN_ID" \
  --plan-hash "$REPAIR_PLAN_HASH" \
  --actor "$APPROVING_ADMIN_ID" \
  --confirm 'APPLY APPEND-ONLY COMMERCE REPAIR'
```

Execution revalidates every sealed head, reconciliation, row version, identity, approval, and rebuilt value in one transaction. It appends one immutable repair fact per affected inventory, the private `WorldCommerceProjectionRepairedV1` event, approval override and repair-anchor ledger evidence, and a matched post-repair reconciliation/current commerce checkpoint; it updates only the guarded inventory quantity/reserved-quantity projection fields. It never updates or deletes an immutable movement, reservation, production fact, work/payroll fact, trade, assessment, command, event, or ledger entry. Reusing the exact completed plan is idempotent and returns the same bounded receipt without exposing the reason, plan hash, affected inventories, before/after values, or fact IDs.

After execution, retain the safe receipt, run ledger verification, and read the resulting reconciliation through the authorized operator path. Require its run ID/checksum and current commerce checkpoint to match the receipt at the unchanged resulting head before unfreezing. Resume in paused mode and re-enable one mutation class at a time. Never forge an open command, call a database function outside this CLI, hand-edit a plan, reuse either administrator identity for both roles, bypass expiry or confirmation, edit projections directly, or reuse an M08 repair plan.

### Economy abuse signal review

`worldgraph_economy_abuse_signals_total{signal}` records only two bounded detections: `self_trade_attempt` when a buyer also controls the listing seller entity, and `rapid_circular_transfer` when a new transfer closes any path among same-currency transfers from the preceding ten authoritative world ticks. The counter carries no world, user, entity, wallet, listing, transaction, amount, command, or idempotency value. It is a review signal, not proof of wrongdoing: detection never confiscates value, changes ownership, or bypasses the normal command result.

1. Confirm the alert is a sustained increase and identify the signal class from the bounded label. A single rejection or legitimate reciprocal transfer can be benign.
2. Use an audited, access-controlled investigation path to correlate a narrow time window with authorization decisions and immutable command/transaction evidence. Do not copy private compensation, memo, wallet, counterparty, or account data into telemetry or ordinary tickets.
3. For `self_trade_attempt`, first distinguish the authority case. A same buyer/seller entity must be rejected with no trade, posting, assessment, movement, or listing transition. Common control of distinct buyer and seller entities may commit normally while emitting the review signal; verify its complete atomic settlement rather than assuming rejection. For `rapid_circular_transfer`, inspect the complete same-currency path closed within the preceding ten authoritative ticks (for example A→B→C→A), and verify every transfer was independently authorized, balanced, and supply-conserving. The signal does not itself reject the closing transfer.
4. If activity is abusive, use existing account/session and feature controls under the incident policy. Do not edit balances, inventories, ownership, commands, or ledger facts, and do not infer a new authorization rule from the alert.
5. If the signal rate is expected, document the reviewed reason and tune alert routing or threshold. Do not remove the detector or add high-cardinality labels to make triage easier.

### M09 commerce metrics, dashboard, and alerts

The worker exposes these low-cardinality series:

- `worldgraph_commerce_inventory_reservations_active`;
- `worldgraph_commerce_inventory_reservation_max_age_ticks`;
- `worldgraph_commerce_production_runs_overdue`;
- `worldgraph_commerce_production_max_overdue_ticks`;
- `worldgraph_commerce_production_runs_failed`;
- `worldgraph_commerce_payroll_records_failed`;
- `worldgraph_commerce_market_volume_trades`;
- `worldgraph_commerce_stale_listings`;
- `worldgraph_commerce_tax_settlements`;
- `worldgraph_commerce_treasury_reconciliation_delta_minor`;
- `worldgraph_commerce_treasury_reconciliation_mismatches`;
- `worldgraph_commerce_scheduled_commands_total{action_type,outcome}`;
- `worldgraph_commerce_scheduled_command_duration_ms`;
- `worldgraph_commerce_scheduled_effects_pending`;
- `worldgraph_commerce_scheduler_lag_ticks{action_type}`;
- `worldgraph_commerce_scheduler_sweeps_total{outcome}`;
- `worldgraph_commerce_scheduler_sweep_duration_ms`; and
- `worldgraph_commerce_realtime_publications_total{message_type,outcome}`.

The API additionally emits `worldgraph_economy_commands_total{operation,outcome}`, `worldgraph_economy_serialization_retries_total{operation,failure_class}`, `worldgraph_idempotency_total{scope,outcome}`, and `worldgraph_economy_abuse_signals_total{signal}`. The bounded `failure_class` distinguishes serialization from deadlock retries; world-command idempotency outcomes distinguish exact replay, conflicting reuse, in-progress identity, and prior failure. No request identity or payload value is attached.

The unlabeled operational gauges come from one PostgreSQL statement refreshed by the economy offer worker. Reservation age, production overdue state, and stale listing state use persisted world ticks only. Market volume is a completed-trade count, and tax settlement is an immutable-assessment count; resource quantities and financial amounts are intentionally not exported for those activity signals. Treasury delta compares the balance projection with the complete immutable posting sum. It is exported only because exact zero is an integrity invariant, carries no identifying label, and is accompanied by a mismatched-wallet count.

`deploy/dashboards/economy-v1.grafana.json` version 4 includes command replay/conflict, retry/deadlock, bounded abuse-signal, scheduled-command outcome/duration, pending-effect/tick-lag, scheduler-sweep, realtime-publication, reservation health, production/payroll health, market/tax activity, and treasury-reconciliation views. `deploy/alerts/economy-v1.rules.yml` covers missing operational snapshots, stuck reservations, overdue and repeatedly failing production, payroll failure bursts, stale listings, non-zero treasury reconciliation, command failure, deadlock and abuse-signal bursts, repeated sweep failure, sustained scheduler lag, a stalled pending queue, and Redis publication failure. Worker-snapshot rules are labeled `metric_source: commerce_worker_otlp`; API-emitted command, retry, and abuse rules are not mislabeled as worker snapshots. Operators may also use these direct PromQL views after confirming the environment's OTLP metric-name translation:

```promql
max(worldgraph_commerce_inventory_reservations_active)
max(worldgraph_commerce_inventory_reservation_max_age_ticks)
max(worldgraph_commerce_production_runs_overdue)
max(worldgraph_commerce_production_max_overdue_ticks)
clamp_min(delta(worldgraph_commerce_production_runs_failed[15m]), 0)
clamp_min(delta(worldgraph_commerce_payroll_records_failed[15m]), 0)
clamp_min(delta(worldgraph_commerce_market_volume_trades[15m]), 0)
max(worldgraph_commerce_stale_listings)
clamp_min(delta(worldgraph_commerce_tax_settlements[15m]), 0)
max(worldgraph_commerce_treasury_reconciliation_delta_minor)
max(worldgraph_commerce_treasury_reconciliation_mismatches)
sum(rate(worldgraph_commerce_scheduled_effects_pending_sum[5m])) / clamp_min(sum(rate(worldgraph_commerce_scheduled_effects_pending_count[5m])), 1)
histogram_quantile(0.95, sum by (le, action_type) (rate(worldgraph_commerce_scheduler_lag_ticks_bucket[5m])))
sum by (action_type, outcome) (rate(worldgraph_commerce_scheduled_commands_total[5m]))
sum by (outcome) (rate(worldgraph_commerce_scheduler_sweeps_total[5m]))
sum by (message_type, outcome) (rate(worldgraph_commerce_realtime_publications_total[5m]))
sum by (operation, outcome) (rate(worldgraph_economy_commands_total[5m]))
sum by (failure_class) (rate(worldgraph_economy_serialization_retries_total[5m]))
sum by (scope, outcome) (rate(worldgraph_idempotency_total[5m]))
sum by (signal) (rate(worldgraph_economy_abuse_signals_total[5m]))
```

Before release, validate OTLP-to-Prometheus name translation against the queries, tune the initial tick-lag and failure thresholds with environment evidence, import the dashboard, load the rules, route severities, and exercise a non-production receiver. Never add world, user, business, worker, contract, inventory, production-run, listing, trade, wallet, schedule, command, policy, hash, amount, or idempotency values as metric labels. Checked-in definitions do not claim deployment, routing, receiver credentials, or a successful drill.

Compilation telemetry traces enqueue, claim, validate, compile, and the atomic seed/activate transaction with safe run/world correlation, compiler/config/schema versions, hashes, counts, duration, and stable diagnostic codes. The seed and active-pointer writes intentionally share one `seed_activate` stage because PostgreSQL commits or rolls them back as one unit; telemetry must not imply a measurable boundary that does not exist. Metrics separately cover claim queue latency, queued/running backlog and oldest age, per-stage and end-to-end duration, artifact entity/relationship counts, measured table/advisory-lock wait, successful serialization retries, terminal outcomes/codes, and observed integrity findings. IDs and hashes appear only in logs/traces, never metric labels.

Versioned Prometheus-compatible rules in `deploy/alerts/deterministic-compiler-v1.rules.yml` cover stuck backlog, terminal failure ratio, unsupported adapters, long lock waits, serialization contention, unusually large artifacts, activation/orphan findings, and hash/reproducibility regression. The worker emits findings only when it observes an input/artifact mismatch or PostgreSQL integrity-constraint rejection. The `orphan` label is reserved for an explicit owner-reviewed consistency check; M05 does not deploy a continuous privileged database scanner. No dashboard, alert-manager routing, receiver credentials, or paging backend is supplied by this repository or local Compose. Each target environment must load and syntax-test the rules, validate its OTLP-to-Prometheus metric-name translation, route severities, and exercise a non-production receiver before release.

## Compiler controls and rollout

- `COMPILER_ENABLED=false` rejects new start commands and makes the worker report backlog without claiming it. It does not hide active worlds or weaken correctness checks.
- `COMPILER_MAX_ENTITIES` defaults to 2,000 and is bounded at 5,000. `COMPILER_MAX_RELATIONSHIPS` defaults to 8,000 and is bounded at 10,000. These values are part of compiler input/config identity; changing them is a versioned output-policy decision, not an emergency bypass.
- `WORLD_COMPILATION_RECONCILIATION_INTERVAL_MS` defaults to 2,000 ms. PostgreSQL remains the work ledger, so missed/duplicate Redis wakes are recoverable.
- Only the exact active `COMPILER_VERSION`/config schema may claim a run. During rollback, disable new starts, drain or deliberately retain matching rows, and never make an older binary reinterpret a newer input.

Correctness checks, content-hash revalidation, adapter allowlists, same-world constraints, and atomic activation cannot be disabled by a feature flag.

## Stuck or failed world compilation

Inspect only run/stage/attempt/claim heartbeat, version/hash identities, counts, stable diagnostic codes, worker/Redis/PostgreSQL readiness, and backlog age. Do not copy manifest/entity/artifact content or private member data into logs or tickets.

1. Restore dependencies and allow PostgreSQL reconciliation to recover a missed wake or expired claim. Attempts are bounded at three.
2. If cancellation is still desired, use the authenticated cancel command with current row version before seeding. Never manually reverse a seeding/activated run.
3. For a retryable terminal failure, correct only the external/infrastructure cause and use the authenticated retry route. The worker reloads and rehashes exact input; a changed manifest/catalog/member set requires a new exact run and cannot masquerade as the old run.
4. For `COMPILATION_INPUT_HASH_MISMATCH`, disable new starts, compare the immutable approved manifest and exact primitive semantic hashes, preserve evidence, and treat unexpected database mutation as an integrity incident.
5. For a suspected partial seed, disable compilation and run an owner-reviewed consistency check across runs, artifacts, versions, entities, relationships, controllers, runtime heads, and world pointers. A legal failed transaction retains none of those seed rows. Repair only through reviewed forward SQL or restore/PITR.
6. For an active-pointer inconsistency, keep writers stopped. Verify one successful run, one active same-world version, matching artifact provenance/runtime head, and complete graph/controller invariants before an audited owner repair.

Never fabricate success, recompute stored hashes to fit changed bytes, delete an active graph, reuse an old claim token, disable deferred constraints, or edit a sealed migration.

## Manifest generation controls

- `MANIFEST_GENERATION_ENABLED=false` refuses new generation commands without deleting existing durable runs. Read/review remains available.
- `MANIFEST_GENERATION_PROVIDER=disabled` is the only currently supported value and selects the deterministic fallback path. Fallback remains available when generation is enabled.
- Defaults are one active run per world and two per requester across all worlds, 4,096 output tokens, 8-second provider timeout, 2-second reconciliation, 30-day prompt retention, and zero provider daily budget. The world bound is configurable from 1–3 and its count/create decision is serialized by the locked world row; the requester bound is configurable from 1–10 and independently serialized by a transaction-scoped requester advisory lock. A real provider or raised budget also requires trusted persisted provider/budget authority and narrower worker database capability; any real provider, raised budget, or raised concurrency requires versioned adapter/privacy/security/cost/operational review and release evidence.
- Provider calls use append-only PostgreSQL reservations under a global UTC-date advisory lock. Settlement requires the active claim and exact usage no greater than the reservation; a definitely unmade call releases its reservation, while unknown external-call outcome remains conservatively charged. Provider-call, repair, token, and cost usage survives lease expiry and worker retry.

## Stuck or failed manifest generation

Inspect only safe run status, stage, attempt, heartbeat, provider configuration, cumulative provider-call/repair/token/cost counters, hashes, and stable error code. Confirm worker/Redis/PostgreSQL readiness and the PostgreSQL backlog before acting. Do not copy prompt/provider payloads into logs or tickets, edit the run/revision, fabricate completion, or disable constraints.

1. If the creator no longer wants an active run, use the authenticated cancel command with its current row version.
2. If a worker died, restart it and allow reconciliation to reclaim the expired lease. Claims are capped at three attempts.
3. If Redis lost the wake, restore Redis; reconciliation will wake the due PostgreSQL row. Do not recreate the row.
4. If the provider path is unhealthy, keep it disabled. The circuit/timeout and deterministic fallback preserve proposal-only behavior.
5. If the run terminally fails, inspect sanitized code/counters and exact retained inputs. A retry/regeneration must be a normal new child command, not a mutation of prior output.
6. For a reserved provider call, settle only provider-reported usage from the active claim. Release only when the call is known not to have occurred; retain the full reservation when its outcome is uncertain.

Cancellation is compare-and-set. Cancel-first invalidates the lease so a late result cannot publish; completion-first produces a terminal conflict. Never repair this race by changing status manually.

## Replay and deterministic fallback

Replay requires the retained normalized/base input hash, explicit seed, parent revision/hash pair, exact frozen retrieval rows/catalog hash, generator/template/validator/provider configuration, and resolved input hash. The deterministic fallback is byte-reproducible for identical normalized inputs. Replay may create a new child through the normal command only; it cannot overwrite an existing revision or approved pointer.

## Compromised or invalid manifest

- Draft: cancel related active runs, create a corrected child, revalidate, and leave the compromised immutable draft unapproved.
- Approved: content cannot be edited or unapproved. Create, validate, and approve a newer child, which supersedes the old approval while preserving history.
- Inconsistent approved pointer: stop manifest writes; verify world, exact revision, creator approval, latest valid report, and schema. Apply an owner-reviewed forward repair transaction that ends with exactly one approved revision and the matching world pointer/schema. Never edit canonical content, delete provenance, or disable triggers.
- Validator/schema incident: disable new generation/approval as needed, retain immutable reports, release a reviewed validator/schema version and forward compatibility policy, then revalidate through the application boundary. Existing Manifest v1 bytes/hashes do not change.

## Prompt retention or exposure

For an ordinary deletion request, run bounded cleanup only after `retention_until`; verify `prompt_text IS NULL` and `redacted_at` is present. Do not delete the submission identity/hash, exact retrieval/provenance, approved manifest, or audit evidence. For exposure, disable provider/generation if needed, restrict data/log access, preserve sanitized evidence, inspect telemetry exports, and follow the environment incident/encryption-key policy.

## Redis and PostgreSQL loss

Redis loss makes readiness fail and pauses wakes, including automatic clock advancement and commerce system-command bridging; it does not remove primitive/index/generation/compilation/command/simulation/economy/commerce authority. Restore it and verify readiness plus PostgreSQL reconciliation without recreating records. PostgreSQL loss makes authoritative work unavailable; stop incompatible writers, restore service/PITR under the environment policy, and verify the deployed binary's exact journal/checksum and compatibility head. For sealed M09 this is migration `0012_commerce_reconciliation_integrity` at journal index 11 with SHA-256 `f46f1c39b0e5e8365a7175c96fc72d72e7e0243d7d6e1a010aa31f1aa539aced`, contract/runtime 9, command/event/ledger/projection/outbox/history schemas 1, simulation schemas 1 with process registry 2 and PRNG `xorshift32-sha256-v1`, Manifest 1, compiler `1.2.0`/artifact 3/plan 2 with exact retained older lanes, core economy schemas including reconciliation 1, commerce-expansion schemas 1, and commerce-expansion reconciliation 2. Run ledger-head/hash, graph, simulation, M08 economy, M09 commerce, active-clock, schedule/target terminal, outbox-retry-intent, and fencing consistency verification before workers reconcile. The API and worker observe idle and checked-out pool-client errors; the clean and retained-data Compose drills proved recovery without process replacement, but environment backup/restore drills remain required.

## Failed migration or bootstrap

Keep incompatible processes stopped. Distinguish extension, migration, catalog-import, genesis/simulation/economy/commerce/governance initialization, role/grant, and compatibility failure. Do not edit applied SQL, overwrite published primitives/manifests/artifacts/events, or make runtime startup migrate. Correct infrastructure/permissions, apply a reviewed forward fix, or restore PostgreSQL. Migrations through implemented `0014_governance_read_capabilities` are forward-only.

Before a production database can apply `0013`, a cluster DBA must provision `worldgraph_governance_tally` as `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`, without privileged memberships or object ownership, grant only database `CONNECT`, and issue its unique credential through the deployment secret manager. Migration SQL never creates or stores that credential. Use the flag/membership preflight in `migrations.md`; an absent or over-privileged role intentionally aborts `0013` before governance objects are installed. Correct the external role and rerun the same migration. Never point `GOVERNANCE_TALLY_DATABASE_URL` at the owner, application, or operations credential.

Rotate the tally credential by pausing governance scheduling, rotating it through approved DBA/secret-manager tooling, updating only the worker secret, restarting the worker, requiring restricted-role readiness and positive/negative privilege checks, then resuming. On an abandoned rollout, keep governance workers stopped and make the unused role `NOLOGIN` or rotate it. Do not drop a role referenced by an applied migration or attempt a table-by-table rollback; restore/PITR the coherent database or ship a reviewed forward correction.

The production runner takes the `worldgraph.schema-migration.v1` session advisory lock and runs every pending Drizzle migration on that same physical owner connection. For an exact M08 source, the existing-enum additions and the complete `0010`–`0012` chain are one transaction; migration-time checks compare newly introduced kinds through text rather than using an uncommitted enum label directly. The lock acquisition may wait beyond the ordinary five-second query/statement timeout for another migrator, but migration statements keep their normal timeout. Do not add an out-of-transaction enum preflight or invoke Drizzle through a different pool connection.

Live PostgreSQL production-runner acceptance passed 3/3: exact M08→head with a maximum-one connection pool, a greater-than-five-second advisory wait followed by a no-op, fail-closed corrupt metadata, and an injected final-`0012` failure that preserved the exact M08 enums, nine-row journal, metadata value/timestamp, and schema. The separate fresh-PostgreSQL primitive bootstrap/provenance suite passed 6/6, and `pnpm db:check` passed. If a migration fails, require that same unchanged source boundary before retrying a reviewed correction. Final M09 acceptance additionally passed the complete PostgreSQL/Redis integration and exact-origin suites plus clean and retained-data Compose recovery; managed backup/restore drills remain a deployment responsibility.

## Governance controls and incidents

Governance scheduling is PostgreSQL-authoritative and Redis-wake-only. `GOVERNANCE_SCHEDULE_ENABLED=false` stops worker discovery/execution without changing contests, schedules, results, or authority. The worker requires the separately credentialed `GOVERNANCE_TALLY_DATABASE_URL` whenever governance scheduling is enabled and reports that dependency in readiness. Do not point it at the application or owner role.

The independent product gates are:

- `GOVERNANCE_CONTESTS_ENABLED=false`: reject new proposal/election contests;
- `GOVERNANCE_VOTING_ENABLED=false`: reject new ballots and omit disabled open-voting work from discovery while allowing required close/certify recovery;
- `GOVERNANCE_ENACTMENT_ENABLED=false`: prevent proposal enactment while preserving tally/result evidence;
- `GOVERNANCE_OVERRIDES_ENABLED=false`: reject explicit creator/admin overrides;
- `GOVERNANCE_TWO_PERSON_CONTROL_ENABLED=true`: require a fresh, exact, distinct, one-use approval for override and repair;
- the corresponding `GOVERNANCE_*_RATE_LIMIT_*` variables bound contest, sponsor, vote, and nomination velocity.

Flags never bypass exact ticks, versions, policy evaluation, eligibility snapshots, result immutability, database privileges, treasury/economy checks, or command/event/ledger/outbox gates.

With two-person control enabled, freeze the complete intended override/repair command first with `payload.approvalId: null`; do not regenerate it after review. Share that bounded JSON only through the approved incident channel. A distinct active creator, world administrator, or platform administrator independently verifies every command field and, from their own authenticated session, posts `{ worldId, command, password }` to `/api/v1/auth/governance-approval` with the normal exact Origin, CSRF cookie/header, and a new idempotency key. Return only the response's `approvalId`, `commandId`, and expiry to the initiator. The initiator attaches only that UUID to the frozen command, performs their own password reauthentication, and submits before expiry. The binding hash normalizes only the eventual approval UUID; changing any other byte invalidates the approval. Approval is one-use and becomes invalid when the reviewer is the initiator, the reviewer/session/role/auth version is no longer current, the world or command differs, or the bounded expiry passes. The web surface consumes an approval UUID but never handles the reviewer's password; reviewer issuance remains the separate API procedure.

Low-cardinality instruments cover governance commands, authority denies, ballot rejections, enactment failures, overrides, repairs, scheduler lag, tally duration/checksum mismatch, scheduled-command outcomes/duration, pending work, and scheduler sweeps. After each successful PostgreSQL schedule-discovery sweep, the governance worker also performs one bounded PostgreSQL operational-snapshot read and refreshes observable gauges for proposal/election counts, eligible and turnout aggregates, maximum governance-projection lag in revisions, and pending governance outbox messages. The snapshot covers active, unarchived worlds: eligibility is the sum of immutable snapshot counts, turnout is the count of participation projections, projection lag is the maximum nonnegative difference between the latest accepted allowlisted governance command revision and that world's governance-head revision, and governance outbox pending is restricted to messages joined to the same command allowlist. Unrelated simulation, economy, and commerce revisions therefore never manufacture governance lag; an absent governance head or accepted governance command contributes revision zero. `worldgraph_governance_targets`, `worldgraph_governance_eligible`, and `worldgraph_governance_turnout` use only allowlisted `target_kind` and `state`; `worldgraph_governance_projection_lag_revisions` and `worldgraph_governance_outbox_pending` are unlabeled. A snapshot-read failure emits only the bounded `GOVERNANCE_OPERATIONAL_METRICS_REFRESH_FAILED` warning, does not change scheduler authority or sweep outcome, and leaves the last successfully refreshed in-process values observable.

The governance dashboard also shows the inherited `worldgraph_outbox_backlog` and `worldgraph_outbox_oldest_age_ms` histogram families from the shared outbox worker. They describe global cross-domain publishing health and must not be interpreted as governance attribution; use `worldgraph_governance_outbox_pending` for the bounded governance-only pending count. Outside the snapshot gauges, only bounded command/action type, outcome, and rejection-code labels are permitted. Never label metrics with world, actor, voter, contest, receipt, result, approval, schedule, policy, checksum, choice, or other identity values. `deploy/dashboards/governance-v1.grafana.json` and `deploy/alerts/governance-v1.rules.yml` are templates: validate metric-name translation, tune thresholds, route severities, and exercise a non-production receiver before release.

### Stuck proposal or election

1. Freeze new contests if backlog is growing. Keep PostgreSQL online and do not edit contest, schedule, occurrence, eligibility, tally, result, event, or ledger rows.
2. Check worker and restricted-tally readiness, the six action classes, oldest completed-but-unhandled schedule, due/current tick, last occurrence, command response, and bounded scheduler logs. Restore Redis if needed and let PostgreSQL reconciliation rediscover work.
3. If an action is paused, decide deliberately whether to restore it. Disabled opens are excluded so they do not starve enabled close/certify recovery. If voting is restored only after an unopened contest's half-open window has already closed, the worker must not derive a late eligibility snapshot or create a zero-opportunity vote: the original open occurrence terminally rejects the proposal or cancels the election with `voting_window_missed`; a cancelled regular election schedules its deterministic successor. Review that explicit history/audit outcome rather than editing ticks or reopening the old contest.
4. If a system command has a terminal response, replay the identical schedule-derived identity. A changed command, occurrence key, result ID, checksum, or due tick is not a retry.
5. For checksum, event-cardinality, version, or provenance failure, keep affected mutations paused and treat it as an integrity incident. Do not fabricate a tally or mark a schedule complete.

### Deterministic recount or tally mismatch

Stop certification/enactment for the contest. Compare the immutable eligibility rule/member checksum, effective ballot revisions, algorithm version, input/count/output checksums, completed schedule, and result. Use the restricted tally role only through the reviewed service; never export voter-choice linkage into ordinary SQL, tickets, logs, or spreadsheets.

An identical recomputation must produce identical bytes. If it does, replay only the original idempotent command. If it does not, preserve both calculations and inspect binary/version, immutable-row integrity, ballot hash key selection, role access, and backup history. A correction must use a supported linked `RepairGovernanceResultV1` path with exact current/replacement checksums, reason, confirmation, strong authority, and configured second approval. Never update/delete certified results or choices.

### Passed proposal with failed enactment

`passed_but_enactment_failed` means the vote passed but every attempted effect rolled back. Confirm no partial law version, tax lineage, project encumbrance, or office term exists. Inspect only the stable failure code, target versions/status, tick, treasury/currency status and spendable amount, policy bounds, result/action checksums, and attempt count.

Correct the external or target-state cause through its normal command boundary. Derive the certification-compensation checksum from immutable result/actions and run the dedicated repair with reason, exact confirmation, and required distinct approval. Success appends an enactment attempt, repair evidence, transition, event, ledger entry, and outbox reference; another safe failure appends bounded failure evidence. Never submit an arbitrary checksum or run effect SQL directly.

### Office vacancy or transition failure

At the transition tick verify one election per seat, certified result, declared term start, current seat interval, prior transition, and non-overlap constraint. No-quorum, no-vote, and configured tie vacancies are legitimate. Fill them through a charter-authorized appointment or explicit labeled override with current office version, exact seat/term, reason, and configured approval—not by editing the result.

If certification failed while ending a prior term, the transaction should have committed neither side. Pause the seat, preserve result/schedule identities, correct the cause, and replay the original command. Never shorten an interval or insert a term outside the command gate.

### Law replacement or rollback

Reverse a law with a new amendment/repeal at the authoritative tick through a proposal or supported explicit override. It closes the prior half-open authority interval and appends a version/transition. Do not edit policy AST, status, interval, checksum, or provenance. Correct a committed mistake with another forward version; freeze and restore/PITR or use a reviewed forward integrity repair if immutable facts are corrupted.

### Secret ballot credential, key, or backup exposure

Disable new voting and restricted tally work, revoke/rotate the tally credential outside Git, restrict backup/telemetry access, and preserve sanitized evidence. Do not log example selections. Determine affected contests, backup generations, keys, and service instances without exporting voter-choice linkage.

Changing the hash key cannot reinterpret old receipts/checksums. Retain the old key only under a protected compatibility procedure long enough to finish or explicitly invalidate affected contests; otherwise keep certification paused. Restore tests must prove the application role still cannot read restricted choices or eligibility linkage. This is trusted-server privacy, not protection from a compromised database owner or tally service.

### Explicit override or repair alert

Verify actor identity/mode, current membership/platform role, creator-override provenance where applicable, exact target, reason/impact, confirmation, binding hash, approval freshness/distinctness/one-use, event/ledger/outbox cardinality, and durable effect. A request without a real effect implementation must fail closed.

If unexpected, pause overrides, revoke affected sessions/approvals, preserve evidence, inspect later authority/economic effects, and follow account-compromise response. Reversal is another explicit forward action; never relabel/delete the original.

## Identity, authority, and cleanup incidents

- Compromised account: disable the user or increment `auth_version` through an owner-reviewed operation, revoke active sessions, cancel unauthorized runs, and inspect sanitized audit. Pepper rotation requires old-key migration or forced credential re-enrollment.
- Invitation exposure: revoke it immediately; never copy the raw fragment into tickets/logs.
- Last-creator anomaly: do not disable deferred constraints. Repair requires dual approval and one owner transaction ending with exactly one active creator.
- Session/idempotency cleanup: delete only expired rows in bounded batches using cleanup indexes. Monitor growth until first-class scheduled cleanup exists.

## Recovery baseline

M04 supplies migration/catalog/index/manifest recovery procedures but no managed backup service, deployed alert routing, or completed restore drill. Before closed alpha, configure encrypted PostgreSQL PITR, object-store versioning when introduced, approved RPO/RTO, retention/export policy, and scheduled restore drills. Primitive-specific procedures remain in `primitive-operations.md`; manifest contract and generation details are in `manifests.md` and `manifest-generation.md`.
