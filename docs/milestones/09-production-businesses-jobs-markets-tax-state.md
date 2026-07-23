# Milestone 09 state — Production, businesses, jobs, markets, treasury, and tax

Status: **implemented at source level; acceptance verification blocked; NOT SEALED**. This is the cumulative M09 record as of the current verification attempt. It does not authorize Milestone 10. The exact migration and compiler identities are frozen below, but the required database, Redis, Compose, browser, aggregate, and supply-chain gates have not completed.

## Inputs consumed

- Every sealed M01–M07 state and handoff, including API v1, PostgreSQL authority, Redis wake-only coordination, identity/membership authority, immutable primitives and manifests, deterministic compiler/activation, command/event/ledger/replay, deterministic tick/schedule/fencing, migrations `0001`–`0008`, ADRs 0001–0012, and retained risks.
- The canonical sealed M08 state and handoff: contract/runtime 8; compiler `1.1.0`/artifact 2/seed plan 1; exact legacy compiler `1.0.0`/artifact 1; schema-1 currency/wallet/journal/asset/title/offer/reconciliation; migration `0009_wallets_transfers_ownership` at SHA-256 `2a7236fa86d9744a15612ad79319683a976e61f56bce3f9f4a95e619801b205e`; ADR 0013; final M08 verification evidence; and every retained M08 privacy, repair, deployment, and operations risk.
- The standalone M09 prompt in `docs/planning/roadmap-g-09-16-h-j.md`. Governance, laws, budgets, external payments, exchange, debt/credit, auctions/order books, escrow, AI runtime decisions, geography, realtime presence, and client authority were not pulled into M09.

## Outcome and implementation summary

M09 adds deterministic productive commerce on top of the sealed M08 closed-loop currency and title system. Versioned resources and recipes drive exact inventory reservations and scheduled production. Organizations back businesses, wallets, facilities, employment offers/contracts, work records, and deferred payroll. Fixed-price listings reserve seller inventory and support atomic partial purchases. Immutable tax policies assess market, payroll, marketplace-fee, and periodic-flat liabilities into ordinary treasury wallets.

The pure `@worldgraph/economy` package owns fixed-point quantity conversion, recipes, inventory/reservation rules, business and employment state machines, production planning, fixed-price settlement, policy assessment, sorted lock planning, and reconciliation without persistence, network, Redis, AI, wall-clock, or ambient-random capabilities. `@worldgraph/economy-command` owns the shared narrow system executor for scheduled commerce effects. The API remains the authenticated command/query boundary; the worker bridges already-completed M07 schedules into idempotent system commands; PostgreSQL remains the only durable authority.

M09 also hardens replay and reconciliation rather than treating projections as self-authenticating. Private command-payload and policy-selection facts, complete production input/output and terminal envelopes, immutable transition bindings, checkpoint boundaries, and authority hashes bind the live document to immutable facts. Reconciliation schema 2 compares inventory, reservations, production, contracts, listings, trades, payroll, tax, recipe versions, and tax policies. Public command rows retain no private payload. Durable target-scoped rate limits and bounded abuse signals cover self-trade and rapid circular-transfer attempts.

Operationally, M09 adds command spans that survive serialization retries, an owner-only dead-outbox retry workflow with append-only audit intent, and browser controls for the implemented commerce actions. These surfaces preserve the existing world advisory-lock, idempotency, privacy, and no-real-money boundaries.

All currency remains simulated closed-loop value with `noCashValue: true` and `cashOutAllowed: false`. No external account, crypto address, payment provider, exchange, credit, escrow, general order book, or runtime AI authority exists.

## Compatibility and public contract state

| Axis                                                       | Implemented M09 state                                    |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| Product/API                                                | WorldGraph / Anvil, API `v1` unchanged                   |
| Contract/runtime                                           | `9` / `9`                                                |
| Command/event/ledger/projection/outbox/history             | `1`; stored M06–M08 bytes unchanged                      |
| Compiler                                                   | `1.2.0` native; exact `1.1.0` and `1.0.0` lanes retained |
| Compiler config/WorldGraph/queue                           | `1` / `1` / `1` unchanged                                |
| Compiled artifact                                          | `3` native; exact artifact `2` and `1` retained          |
| Economy seed plan                                          | `2` native; exact plan `1` retained                      |
| Core economy/currency/wallet/transaction/asset/title/offer | `1` unchanged                                            |
| Economy reconciliation                                     | `2` current; exact schema `1` retained                   |
| Resource/recipe/inventory/business/facility/employment     | `1`                                                      |
| Production/market/trade/tax/commerce expansion             | `1`                                                      |
| Simulation action/process schemas                          | `1` unchanged                                            |
| Simulation process registry                                | `2` current; exact registry `1` retained                 |
| Manifest extension `worldgraph.economy`                    | `2`; Manifest schema remains `1`                         |
| Manifest/primitive/PRNG and other simulation axes          | unchanged from sealed M08                                |

Resource quantities are canonical decimal strings with a declared scale 0..12, scaled bigint atoms in pure decisions, and constrained `numeric(30,12)` storage. Money remains checked signed 64-bit minor units. Price multiplication uses deterministic half-up conversion; compiler-authored percentage policies pin floor basis-point assessment. Invalid precision, exponent notation, unsafe overflow, negative inventory, excessive reservation, and ambiguous client totals fail closed.

## Compiler, artifact, and seed-plan state

Compiler `1.2.0` emits artifact schema 3 with `EconomySeedPlanV2`. The plan extends—not rewrites—the M08 closed-loop seed with resource types, immutable recipe versions, initial inventories, businesses, facility mappings, employment offers, tax policies, treasury bindings, and initial periodic schedules. `InitializeWorldCommerceV1` accepts only an exact compiler-1.2/artifact-3/plan-2 provenance chain. Migration never synthesizes productive-commerce state for an existing world.

The current M09 harbor-city fixture identity passed the current/previous/legacy golden check and the separate offline compiler CLI check:

- manifest content hash `6452e612ab13f43c9513824fa36dfca6a28303909e0215da1c787cd63d1edc6c`;
- compiler input hash `0cf5b43c2a0b09d75aae17b5dd622113e27103843392e17a2a8b64833eb4e837`;
- artifact hash `fa53687f451201d80cc4cab4615eed98403341cfd55177158add05579ab22f92`;
- canonical artifact size 34,753 bytes;
- 41 entities, 46 relationships, and 2 controllers; and
- economy seed-plan hash `eff8f07bac7bc63354bd43e0f7607427aece39429cecfe2de3edd70eea6eb6d9`.

The deterministic harbor fallback template/provider configuration is version 2. It adds Energy Harbor Works backed by `organization:energy-guild`, one organization wallet, one workshop facility/asset, `energy`, `iron-ore`, and `metal-part` resource types at scale 0, 100/100/0 initial inventory, one 12-tick metal-part recipe, one metalworker employment offer at 100 minor units per 12-tick shift and capacity one, a floor-rounded 250-basis-point sales policy collected from the payer, one fixed 10-minor-unit harbor-dues policy every five ticks, and a treasury binding to the guild council. Compiler validation rejects a business without an active controlled-character organization affiliation and a periodic payer/wallet mismatch.

Compiler-authored employment entries are open role-and-wage templates, not participant contracts. A business manager creates a worker-specific offered contract through the authenticated runtime command, and only the currently controlled worker can accept it. This deliberate consent and current-authority boundary avoids assigning a runtime worker during compilation; the present contract command carries manager-authored bounded terms and does not claim an exact source-offer identity.

Compiler `1.1.0`/artifact 2/plan 1 and compiler `1.0.0`/artifact 1 remain exact verifier lanes and are never silently upcast. Their sealed M08 identities remain recorded in `M08-handoff.md`. M09 deliberately does not add a post-activation recompile or commerce-adoption path for an already-active compiler-1.1/artifact-2 world. Such a world remains byte- and state-preserved and commerce-uninitialized; post-activation design evolution belongs to the M13 versioned patch/migration boundary. `0010` does not pretend old graph bytes carried M09 intent, synthesize state, upcast an artifact, or regenerate a world.

For M09 acceptance, “from an upgraded Milestone 8 database” means that the exact sealed-`0009` database is migrated through `0012`, an existing active M08 world is proved unchanged and without M09 rows, and a new compiler-1.2/artifact-3/plan-2 harbor world is then compiled, activated, and initialized on that same upgraded database for the complete two-user demo. It does not mean running that demo inside the pre-existing active M08 world. This interpretation remains an unverified gate until both preservation and the new-world demo have actually run against the same upgraded database.

## Commands, events, routes, realtime, and UI

The generic `POST /api/v1/worlds/:id/commands` registers these public schema-1 M09 commands:

- `InitializeWorldCommerceV1`, `CreateBusinessV1`, and `ConfigureBusinessFacilityV1`;
- `CreateEmploymentContractV1`, `AcceptEmploymentContractV1`, `EndEmploymentContractV1`, and `PerformJobV1`;
- `StartProductionRunV1`;
- `CreateMarketListingV1`, `CancelMarketListingV1`, and `PurchaseMarketListingV1`; and
- `ReconcileWorldCommerceV1`.

`CompleteProductionRunV1`, `SettlePayrollV1`, `ExpireMarketListingV1`, and `AssessPeriodicTaxV1` are registered narrow system commands and are rejected at the public transport boundary. Every command uses server-derived actor/authority and recomputed tick, totals, tax, output, reward, and ownership; clients cannot submit those as authority.

Registered M09 facts are `WorldCommerceInitializedV1`, `BusinessCreatedV1`, `BusinessFacilityConfiguredV1`, `EmploymentContractCreatedV1`, `EmploymentContractAcceptedV1`, `EmploymentContractEndedV1`, `WorkRecordedV1`, `PayrollSettledV1`, `PayrollFailedV1`, `ProductionRunStartedV1`, `ResourcesConsumedV1`, `ResourcesProducedV1`, `ProductionFailedV1`, `MarketListingCreatedV1`, `MarketListingCancelledV1`, `MarketListingExpiredV1`, `MarketListingPartiallyFilledV1`, `MarketListingFilledV1`, `InventoryTransferredV1`, `MarketTradeCompletedV1`, `TaxAssessedV1`, `TreasuryRevenueRecordedV1`, and `WorldCommerceReconciledV1`, plus inherited M07 schedule facts.

The private owner-only projection-repair workflow additionally emits `WorldCommerceProjectionRepairedV1`; it is registered for ledger/replay integrity but is not a public command result or ordinary history surface.

Authorized, bounded read routes are:

- `GET /api/v1/worlds/:id/economy/resources` and `/recipes`;
- `GET /api/v1/worlds/:id/economy/inventories`;
- `GET /api/v1/worlds/:id/economy/businesses` and `/facilities`;
- `GET /api/v1/worlds/:id/economy/employment/offers`, `/contracts`, and `/jobs`;
- `GET /api/v1/worlds/:id/economy/production-runs`;
- `GET /api/v1/worlds/:id/economy/market/listings`, `/market/trades`, and `/market/listings/:listingId/purchase-preview`;
- `GET /api/v1/worlds/:id/economy/transactions`; and
- `GET /api/v1/worlds/:id/economy/treasury`, `/tax-assessments`, and `/reconciliation`.

Lists use signed filter-bound cursors and a maximum page size of 100. Responses include projection status/checkpoint/revision/lag. Contract/job/payroll and other participant-private detail is authorized before pagination. Business authority is current organization control or current control of a player character whose active state names the backing organization; creator provenance alone is insufficient.

Purchase preview uses the same policy-selection semantics as settlement, including exact parity when sales, transaction, or marketplace-fee policies are disabled. A preview is explanatory only; the command rechecks all versions and recomputes every amount.

Safe schema-1 `CommerceNotificationV1` contracts exist for `economy.inventory.changed`, `economy.production.changed`, `economy.listing.changed`, `economy.trade.completed`, and `economy.treasury.changed`. They carry only type, world ID, entity ID, state revision, and cursor. During durable outbox dispatch the worker derives affected IDs from committed facts/private projection rows, validates the exact contract, and publishes to internal channel `worldgraph:commerce:v1:world:<worldId>`. Redis failure leaves the outbox retryable; no subscriber is success; duplicates at the Redis-success/database-commit boundary are harmless invalidations. Consumers compare cursor/revision and refresh an authorized read. The internal transport is delivered, but M09 intentionally has no browser WebSocket/SSE gateway; a future gateway must authorize subscriptions before relaying.

The web Economy workspace exposes resource, business, production, market, treasury, tax, and reconciliation views with a no-real-money disclosure. It now provides business creation, facility configuration, employment creation/acceptance/end, work performance, production start, listing creation/cancellation, and confirmed purchase controls. A zero-lag pending reconciliation permits actions while visibly reporting `Reconciliation pending`; nonzero lag, a mismatch, or a failed reconciliation blocks mutations. These controls were implemented and statically verified before the dependency disruption, but the required browser/accessibility run was not executed.

`CreateBusinessV1` specializes an organization and binds its existing active organization wallet; it never mints value or changes a balance. Funding is the separate inherited, authorized, versioned, and idempotent `TransferCurrencyV1` command. The demo therefore creates the business and then funds its bound wallet as two explicit effects, and does not claim atomic create-and-fund behavior.

## Integrity, lock order, and idempotency

- `0 <= inventory.reserved <= inventory.quantity`; available quantity is derived. Every exact quantity change has immutable movement provenance.
- Production start reserves an immutable recipe snapshot; its fixed schedule completes once, consumes exact reservations, and credits the facility asset container, or records failure without partial output.
- An open listing reserves exactly its remainder. Purchase requires current tick before expiry, exact expected versions, sufficient buyer funds/inventory, different buyer and seller, and quantity no greater than the remainder. A partial fill stays open; terminal fill/cancel/expiry releases or consumes all reservation.
- M09 intentionally exposes no targetless “expire orphan reservation” mutation. A valid reservation is bound to its listing or production-run lifecycle and terminalizes only through that aggregate's exact fill/cancel/expiry or completion/failure command. A targetless or contradictory reservation is an integrity incident, not routine expiry.
- Market settlement, gross/tax/fee/net postings, treasury receipt, inventory movement, immutable trade/assessment, listing transition, command/event/ledger/outbox, and all affected checkpoints commit together or not at all. Posting sum remains zero and closed-loop supply is unchanged.
- Employment contracts are capacity/cooldown bounded. Work creates one payroll record. Payroll settles from the policy snapshot selected at the work tick; failure creates no financial transaction.
- Periodic tax schedules the next exact interval from the authoritative occurrence and skips missed periods rather than generating an unbounded catch-up bill.

The global order is world advisory lock → runtime/ledger head → M08 economy head → M09 expansion head → simulation clock → scheduled action for system effects → command targets by rank `listing`, `offer`, `reservation`, `production_run`, `contract`, `business`, `facility`, `inventory`, `asset`, `wallet`, with identifiers sorted inside each rank and wallet identifiers always sorted. Compiler initialization is world-serialized and may use its own internal creation order.

Public commands carry command ID/idempotency key plus expected world version, state revision, expansion aggregate version, expected tick where relevant, and target row versions. The scheduler uses actor `worldgraph:commerce-scheduler`, completed-schedule causation, and `commerce-schedule-v1:<ActionType>:<scheduledActionId>`. Schedule payloads carry only a target UUID. A duplicate wake or uncertain response resolves through the original command identity and never creates a second economic effect.

## Migration and database state

The M09 journal head is `0012_commerce_reconciliation_integrity`, index 11. The reviewed migration SHA-256 values are:

- `0010_production_business_market_tax`: `24b68fd1789c303f937c01dcc5e15c238c253e0fdd6391cac1c9c5f691bb8f75`;
- `0011_commerce_projection_repair`: `9b1923c5ccabe62abb1502f7a525f0052bd7c3e015b0ec41aa1bb7833fa7c3b6`; and
- `0012_commerce_reconciliation_integrity`: `44de5f5ee34430d32b5b6866f4469dc7e843293f378490b935ca7f80295a4709`.

Migrations `0001`–`0009` remain byte-identical; `0009` remains sealed at `2a7236fa86d9744a15612ad79319683a976e61f56bce3f9f4a95e619801b205e`. The dependency-free migration checksum/journal consistency check passed at `0012`. The `0012` checksum was deliberately refrozen before M09 shipment or seal after acceptance review found the missing identical-scope tax-policy overlap invariant; this does not permit editing migrations that have already been applied or released.

`0010` requires the exact sealed M08 metadata. It advances contract/runtime 8→9, compiler `1.1.0`→`1.2.0`, artifact 2→3, economy seed plan 1→2, economy reconciliation 1→2, and simulation process registry 1→2 while retaining API v1 and all prior schema bytes. It expands stored compiler/artifact checks to the exact 1.0/1, 1.1/2, and 1.2/3 lanes.

It adds 15 bounded enums and the authoritative structures documented in `commerce-schema.md`: commerce expansion head; resource/recipe/version; inventory/movement/reservation; business/facility/recipe mapping; production run/transitions; employment offer/contract/work/payroll; tax policy/assessment; market listing/trade; reconciliation run/items; and private command write snapshots. Immutable facts reject update/delete; mutable projections and lifecycle aggregates require the open-command write gate, expected versions, and deferred event/cardinality/checksum proof.

`0011` leaves every version axis unchanged and adds the private commerce projection-repair plan, item, approval, fact, and execution records plus owner-only prepare/approve/execute functions. The 15-minute plan binds the exact current heads and latest mismatch reconciliation. A distinct active administrator approves its hash; that same approver executes. Execution corrects only guarded inventory quantity/reserved-quantity projections while appending repair facts, a private event, approval override and repair-anchor ledger evidence, and an exact matched reconciliation/current checkpoint.

`0012` leaves the public compatibility axes unchanged while making reconstruction authority explicit. It adds private command-payload and payroll-policy facts, expanded immutable snapshots and checkpoint boundaries, durable target-scoped rate state, full reconciliation authority hashes and baselines, exact production input/output and terminal evidence, and immutable initial-transition binding. It installs `btree_gist`, rejects retained identical-scope active tax-policy overlaps before the constraint is created, and provides concurrency-safe half-open non-overlap enforcement thereafter. It also adds the private append-only `outbox_retry_intents` ledger and owner-only functions used to requeue a dead outbox message without changing the message or event identity or resetting attempt history. Application-role access to retry intent and direct retry execution is denied.

The migration integration suite defines fresh and `0011`→`0012` cases for all five payload-fact histories, ended employment, completed production, a filled listing/trade, authority hashes, an ambiguous-listing rejection, transactional rollback, and outbox-retry ownership/constraints. Those scenarios were collected and typechecked before the dependency disruption, but no live PostgreSQL execution occurred. Therefore clean bootstrap, retained-data upgrade, repeat application, and rollback behavior remain **unverified runtime gates**, not inferred passes.

There is no destructive down migration. Before rollout, capture a base backup/PITR point and migration metadata. If rollback is required, stop API/worker writers, preserve incident evidence, restore the whole database to the pre-`0010` point, and redeploy M08-compatible artifacts. Enum additions, triggers, and cross-domain facts make dropping individual M09 objects or editing rows unsafe. Prefer a reviewed forward fix when state has already been used.

## Worker, observability, and operations state

The commerce scheduler bridge polls PostgreSQL for completed M07 actions and submits narrow system commands. Configuration is `COMMERCE_SCHEDULE_ENABLED` (default true), `COMMERCE_SCHEDULE_BATCH_SIZE` (default 25, range 1..250), and `COMMERCE_SCHEDULE_RECONCILIATION_INTERVAL_MS` (default 1,000, range 100..60,000). Disabling the bridge stops new scheduled effects but does not cancel or rewrite durable schedules.

Low-cardinality metrics are `worldgraph_commerce_scheduled_commands_total{action_type,outcome}`, `worldgraph_commerce_scheduled_command_duration_ms`, `worldgraph_commerce_scheduled_effects_pending`, `worldgraph_commerce_scheduler_lag_ticks{action_type}`, `worldgraph_commerce_scheduler_sweeps_total{outcome}`, `worldgraph_commerce_scheduler_sweep_duration_ms`, and `worldgraph_commerce_realtime_publications_total{message_type,outcome}`. Safe failure codes are `COMMERCE_SCHEDULE_COMMAND_FAILED`, `COMMERCE_SCHEDULE_DISCOVERY_FAILED`, `COMMERCE_SCHEDULE_RECONCILIATION_FAILED`, `COMMERCE_REALTIME_NOTIFICATION_INVALID`, and `COMMERCE_REALTIME_PUBLISH_FAILED`; logs retain only bounded IDs, allowlisted message/action types, and stable failure class, never private payloads or financial details.

Every commerce command now runs inside a `world.economy.command` span that remains open across serializable retries and commit. Attributes are bounded or hashed command, correlation, world, PostgreSQL transaction, tick, run, listing, trade, wallet-transaction, tax, event, outbox, and outcome identities; amounts, payloads, and private participant identifiers are excluded. The shared command bus also enters the same world advisory-lock domain as the commerce repository.

Dead outbox recovery is an operator action, not an HTTP or worker capability. `pnpm outbox retry` requires an active platform administrator, an owner-grade database session, an explicit retry UUID, a 20–1,000-code-point incident reason, and the exact confirmation phrase. The transaction preserves the original message/event identity and prior attempt count, records one private append-only retry intent, and changes only `dead` to `pending`. Exact replay of the same retry identity is stable; if the message dies again, the CLI refuses to reuse that identity and requires a new reviewed retry. Direct application-role table/function access is denied.

`operations.md` contains stuck-run/scheduler, realtime invalidation, reconciliation mismatch, tax/payroll/production/listing, restore, and repair-boundary runbooks plus direct PromQL views. Checked-in `deploy/dashboards/economy-v1.grafana.json` version 4 includes M09 command, abuse, scheduler, realtime, inventory, production/payroll, market/tax, and treasury-reconciliation views. `deploy/alerts/economy-v1.rules.yml` includes the corresponding API- and worker-sourced rules; only worker snapshot rules carry `metric_source: commerce_worker_otlp`. Loading, OTLP translation, threshold tuning, routing, receiver credentials, and a non-production alert drill remain deployment responsibilities.

## Verification evidence

The current verification attempt ran on July 22–23, 2026 with Node.js 24.18 and pnpm 11.9 in the managed workspace. This table distinguishes executed evidence from collected scenarios and blocked gates. No isolated pass is counted as the missing aggregate gate.

| Check                                                     | Current result                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregate repository gate                                | **INCOMPLETE.** Broad unit run excluding worker health completed 107/108 files and 717/718 tests. The only failure was a compiler child-process timeout under contention; its focused 3/3 rerun passed and the timeout was raised, but the aggregate suite was not rerun. |
| Current/previous/legacy compiler golden and offline CLI   | **PASS.** Golden check and a separate multi-process offline CLI check passed; the exact current hashes and byte count are recorded above.                                                                                              |
| Focused source suites                                     | **PASS before dependency disruption.** Commerce-read/compiler route tests passed 18/18, observability/command tests 38/38, the contended focused set 52/52, and the compiler reproducibility rerun 3/3.                                  |
| Typecheck, lint, format, and build                        | **PARTIAL.** Affected API, database, observability, worker, compiler, and integration-test edits had targeted clean checks at their review points. No final repository-wide rerun occurred after the latest changes.                    |
| Migration journal/checksum                               | **PASS for static journal integrity.** Head `0012`, index 11, and all three M09 hashes above passed dependency-free checksum/journal consistency validation after the pre-seal tax-scope correction.                                    |
| Full real PostgreSQL/Redis integration                    | **BLOCKED / UNRUN.** Integration scenarios were collected/typechecked where noted, but PostgreSQL could not start in the managed environment and Docker/network escalation was unavailable.                                            |
| Full browser/accessibility                                | **BLOCKED / UNRUN.** The workspace could not run the browser/accessibility gate.                                                                                                                                                        |
| Clean bootstrap plus repeated retained-data Compose smoke | **BLOCKED / UNRUN.** Docker/Compose and the required services were unavailable.                                                                                                                                                         |
| Fresh/exact-upgrade/repeat migration runtime              | **BLOCKED / UNRUN.** Static SQL/journal review is not a substitute for execution against PostgreSQL.                                                                                                                                   |
| Dependency/license/image review                           | **INCOMPLETE.** The offline installer reported the frozen lockfile passed its recorded supply-chain policy check, but license inventory lacked a package index and reinstall stopped on a missing cached `@axe-core/playwright` tarball. No complete audit was obtained. |
| Independent implementation audits                         | **PARTIAL PASS.** Targeted audits found and closed replay-authority, privilege-boundary, and retry-idempotency defects. Lower-priority outbox concurrency and denial-matrix cases remain unexecuted.                                     |

### Retry and correction record

- A broad unit run excluding the three loopback-dependent worker-health cases completed 717/718 tests. The compiler reproducibility child exceeded its old 15-second process limit only under aggregate contention; its focused 3/3 rerun passed, and the process/test limits were raised to 30/70 seconds. Because the aggregate was not rerun, that correction is retained as focused evidence only.
- The 717 passing tests include the deterministic `commerce-invariants` coverage that executes 500 generated sequences while checking money conservation, balanced postings, inventory/reservation bounds, recipe output, payroll uniqueness, and ownership. This is unit/property evidence only; it does not substitute for the blocked PostgreSQL transaction and concurrency gates.
- Worker-health execution remains environmentally blocked by `listen EPERM 127.0.0.1`; product behavior was not weakened to accommodate the sandbox.
- Independent SQL review found that terminal production authority could otherwise be self-authenticated from a corrupted version. The migration now binds exact completed/failed versions, exact selected events, full terminal snapshots, event ordinals/ticks, and the immutable initial transition. Recipe and tax-policy provenance are included in aggregate hashes.
- Independent outbox review found an application-role privilege path into the private retry table and later found a stale replay semantic. Narrow security-definer lookup, explicit revocation, forged-gate tests, stable replay fields, and refusal to reuse a retry identity after a later death closed those issues. A final tuple-exactness check was added to the CLI.
- Payroll duplicate/recovery, failed-production reconciliation, purchase replay corruption, migration-upgrade, and abuse-signal scenarios were implemented. The relevant files typechecked/linted before disruption, and pre-disruption collection covered the migration and economy integration additions through failed-production reconciliation. The later abuse-signal collection attempt was blocked after the executable links disappeared. None was executed against a live database.
- Identical-scope tax-policy overlap review added pure seed-plan validation plus a PostgreSQL exclusion constraint and unit/compiler/fresh-head/exact-upgrade scenarios. These changes came after the dependency disruption; their test cases remain unrun, and no earlier green result is attributed to them.
- The final-unit stress fixture was corrected from 50 commands under one buyer authority to 50 independently authenticated buyers with distinct controlled entities and wallets. It now asserts one accepted trade/movement/financial transaction/assessment and balanced postings, but this strengthened database scenario was added after dependency disruption and remains unrun.
- A proposed direct-insert active-M08 migration fixture was rejected during independent review and removed. Its minimal manifest/artifact and truncated command/simulation/history state could pass selected checks only because trigger enforcement was disabled; it was not runtime-producible M08 state and therefore supplies no acceptance evidence. The required production-shaped active-`0009` preservation phase and same-database native plan-2 demo remain missing.
- The attempted frozen offline reinstall made no source or lockfile change but removed usable workspace dependency links before failing on the uncached `@axe-core/playwright` tarball. Approval to restore dependencies from the network was unavailable. The dependency tree is therefore incomplete, and no later verification command is claimed.

## Architecture decisions and deviations

- ADR 0014 records fixed-point quantities, deterministic rounding, fixed-price/reserved inventory, immutable policy snapshots, treasury-as-wallet, atomic settlement, separate commerce reconciliation, M07 durable scheduling, global lock order, and the no-real-money/AI boundaries.
- Artifact schema advances to 3 and seed plan to 2 because strict artifact-2/plan-1 bytes cannot gain productive-commerce intent. Both old compiler lanes remain exact.
- The upgraded-database acceptance path preserves any active M08 world without M09 state and runs the M09 demo in a newly compiled plan-2 world on the same database. Active-world commerce adoption is deliberately deferred to M13's versioned patch/migration authority rather than introducing an unsafe one-off recompile path.
- Compiler seed plan 2 carries employment offer templates rather than worker-bound contracts. Runtime contract creation plus worker acceptance preserves current participant choice and authority.
- Tax-policy scope is world, currency, tax type, and normalized applicability. Active intervals are half-open; periodic normalization retains payer entity/wallet while excluding cadence. Pure compiler validation and a `btree_gist` exclusion constraint reject overlap.
- `CreateBusinessV1` binds an existing organization wallet; the inherited `TransferCurrencyV1` performs funding separately. Business creation therefore cannot mint or silently move value.
- Reservation recovery remains aggregate-scoped. Listing and production terminal commands release, expire, or consume their own reservations; a generic orphan-release command would bypass the target, schedule, movement, and reconciliation evidence and is intentionally absent.
- The M07 process registry advances to 2 because the schedule system now recognizes four code-owned commerce actions; schedule/process/action payload schemas and PRNG remain unchanged.
- Periodic tax skips missed intervals. This prevents restart downtime from causing an unbounded surprise charge and makes one occurrence correspond to one schedule identity.
- The browser action surface now covers business, facility, employment, work, production, listing create/cancel, and purchase workflows. Reconciliation freshness is an explicit mutation gate, with zero-lag pending treated separately from lag, mismatch, and failure.
- Safe realtime invalidations are schema-validated and published from the durable outbox through internal Redis Pub/Sub; Redis never becomes authority, duplicates are tolerated by cursor/revision, and no browser gateway is claimed.
- `RepairEconomicProjectionV1` is a strict internal contract implemented only through the owner-authorized prepare/approve/execute operator workflow. It is absent from public registries, HTTP, browser, and ordinary worker authority; exact unchanged-head planning, a distinct approving administrator, append-only evidence, and a matched post-repair reconciliation constrain it to inventory quantity/reservation projection recovery.
- Dead outbox requeue is likewise an audited owner-only operator workflow. It preserves the original message/event, retains attempts, denies application-role access, and uses a fresh retry identity for every later dead generation.
- Commerce mutation spans use bounded/hashed identifiers and include commit/retry outcomes without exposing values or private payloads. Durable target-scoped limits and bounded self-trade/circular-transfer signals replace reliance on process-local commerce abuse state.
- The checked-in economy dashboard/rules cover emitted M09 scheduler and realtime signals; their environment-specific loading, translation, tuning, routing, and drill remain outside repository assembly.

## Security, privacy, and player/creator guidance

- Players control only entities, inventories, contracts, listings, and wallets proven by current membership/controller state. Business managers derive authority from current organization control/affiliation. Creator status is not universal economic access.
- The server recomputes quantity scale, price, gross, fee, tax, net, wage, output, tick, treasury, wallet, and ownership. Client previews are explanatory and can become stale; the command is authoritative.
- Private employment, payroll, inventory, posting, and trade data is filtered before pagination and excluded from logs, metrics, schedule payloads, generic history, and realtime messages.
- Implemented abuse coverage rejects a same-entity self-purchase with a bounded `self_trade_attempt` signal, emits the same signal when one actor controls distinct buyer and seller entities, and detects the bounded A→B→C→A `rapid_circular_transfer` pattern. Those database-backed scenarios still require live execution.
- Creators configure economy intent through validated, provenance-bearing manifest/compiler data and explicit runtime commands. They cannot edit balances, inventory, tax assessments, payroll, trades, or projections directly.
- Currency and resources have no real-world monetary value. There is no purchase for fiat, cash-out, exchange, crypto, external address, lending, interest, or promised redemption. UI and API disclosures must not imply otherwise.
- AI may propose bounded declarative manifest input before human review, but cannot make runtime economic decisions or repair invalid state.

## Known risks and retained incomplete work

- **Acceptance is blocked and M09 is not sealed.** Real PostgreSQL/Redis integration, fresh/upgrade/repeat migrations, Compose, browser/accessibility, the complete aggregate repository gate, and a complete supply-chain review have not run.
- The workspace dependency tree is incomplete after the failed offline frozen reinstall. Source files and the frozen lockfile were unchanged, but verification cannot resume until dependencies are restored in an authorized network-capable environment.
- Browser realtime remains a future gateway concern: M09 publishes internal safe invalidations but does not expose a client WebSocket/SSE subscription.
- Outbox retry still lacks live coverage for same/different retry-ID concurrency and the complete locked/non-dead/cross-world/inactive-admin denial matrix.
- The corrected 50-independent-buyer final-unit race is source-complete but unrun against PostgreSQL; its exactly-one-settlement result remains a release gate rather than recorded evidence.
- The runtime-producible active-M08 preservation fixture is still missing, and the required second-phase native plan-2 harbor demo has not run on that same upgraded database. Neither partial or synthetic state nor either phase alone can seal the upgraded-database gate.
- Dashboard/rule deployment, target-environment OTLP translation, threshold calibration, alert routing, receiver configuration, and a completed drill remain release risks even though their checked-in M09 definitions exist.
- The inherited shared application database role, managed PITR/restore drills, external immutable checkpoints, continuous privileged scans, alert routing, provider/profile hardening, pruned images, and managed deployment risks remain.
- Container images use version tags rather than immutable digests, and the incomplete dependency/license review leaves the supply-chain gate open.
- Fixed-price one-currency commerce, simple policies, one deterministic production chain, and bounded employment are deliberate MVP limits, not a general marketplace, labor, tax, or finance platform.

## Inputs proposed for Milestone 10

**Not authorized while this record is unsealed.** M10 may begin only after every required M09 acceptance and definition-of-done gate has actually passed, any deliberate design deviation has been formally approved without waiving verification, and this record is marked complete and sealed. An unavailable or unrun migration, demo, regression, security, browser, or supply-chain gate cannot be converted into a pass by disposition. The eventual sealed handoff may then carry API v1; contract/runtime 9; compiler `1.2.0`/artifact 3/seed plan 2 plus exact older lanes; resource/business/employment/production/market/tax schema 1; reconciliation 2; process registry 2; the final frozen migration head; ADR 0014; the command/event/route, scheduler, reconciliation-authority, outbox-retry, observability, rate-limit, and abuse-signal decisions; and every retained risk.
