# ADR 0014: Fixed-point commerce and atomic treasury consistency

Status: accepted for the implemented Milestone 09 architecture; Milestone 09 is sealed.

Date: 2026-07-22

## Context

Milestone 08 established one closed-loop virtual currency, immutable postings, and single-source asset title. Production, employment, market sales, and taxation add divisible resource quantities, inventory reservations, deferred work, multi-party settlement, and a second family of economy projections. Those operations must remain deterministic across JavaScript and PostgreSQL, survive duplicate worker delivery, preserve the M08 accounting boundary, prove that a rebuilt document came from immutable authority rather than a corrupted projection, and never imply real-money value.

The compiler also has three stored compatibility lanes. Existing compiler `1.0.0`/artifact 1 worlds contain no economy plan, compiler `1.1.0`/artifact 2 worlds contain economy seed-plan schema 1, and new compiler `1.2.0`/artifact 3 worlds contain economy seed-plan schema 2. Migration cannot truthfully infer productive-commerce intent for an old world.

## Decision

### Quantity and rounding

- Resource quantities are canonical fixed-point values with a resource-defined scale from 0 through 12. Domain code converts them directly to scaled bigint atoms; it never routes exact state through JavaScript `number`.
- PostgreSQL stores quantity projections and facts as `numeric(30,12)`, with database constraints and canonical boundary parsing preserving the declared resource scale.
- A fixed-price trade computes gross minor units from quantity atoms and integer unit price with deterministic half-up rounding. Percentage policies use integer basis points. Compiler-authored Milestone 09 tax policies pin floor rounding; the pure kernel retains an explicit, versioned half-up option rather than using ambient language rounding.
- Resource types, recipes, recipe versions, primitive provenance, tax policies, inventory movements, work records, trades, assessments, and reconciliation evidence are append-only. Mutable rows are guarded projections or explicit lifecycle aggregates.

### Inventory, production, and market

- Inventory maintains `0 <= reserved <= quantity`; available quantity is derived as `quantity - reserved`. Every quantity change also appends an immutable movement with source identity and ordinal.
- A production start snapshots one immutable recipe version, reserves its exact inputs, and creates one durable scheduled completion. Completion consumes those reservations and credits the configured facility asset container exactly once.
- The market supports fixed-price listings only. A listing reserves its remaining offered quantity, requires the persisted simulation tick to be strictly before expiry, and allows deterministic partial fills. Cancellation, fill, and expiry release or consume the reservation once.
- Reservation recovery stays bound to the owning listing or production aggregate and its original deterministic terminal command. A reservation with no consistent target/schedule/fact chain is integrity corruption requiring a freeze and reconciliation/restore decision, not a generic release mutation.
- Market purchase, inventory transfer, listing transition, currency postings, taxes, fees, treasury receipt, command/event/ledger records, and projection checkpoints commit in one serializable transaction. Self-trade and client-authored settlement values are rejected. No order book, auction, escrow, dynamic price, credit, or external payment rail is introduced.

### Employment, payroll, tax, and treasury

- Employment contracts follow `offered -> active -> ended|cancelled`, with explicit capacity and cooldown checks. A performed job records work and schedules payroll.
- Compiler seed plan 2 carries bounded employment role/wage templates, not worker-bound contracts. A current business manager creates the participant contract and the currently controlled worker accepts it; compilation cannot supply participant consent.
- Business creation binds an existing organization wallet but neither mints nor transfers value. Funding remains a separate authorized M08 `TransferCurrencyV1` command with its own versions and idempotency identity.
- Payroll snapshots the applicable tax policy at the work tick. Settlement uses that snapshot even if a later policy becomes effective; a failed settlement creates no financial transaction.
- Sales and transaction taxes may be added to the payer or withheld from the recipient as declared by the immutable policy. Payroll tax and marketplace fees are withheld. Periodic flat tax uses an exact minor-unit amount.
- Active policy windows are half-open `[effectiveFromTick, effectiveUntilTick)`, with a missing upper bound treated as infinity. Compiler validation and PostgreSQL both reject overlaps for one world, currency, tax type, and normalized applicability. A periodic policy's payer entity/wallet identifies its scope; changing only cadence or other terms does not create a second scope.
- A periodic policy advances from its authoritative scheduled execution tick by its interval. Missed periods are skipped rather than replayed as an unbounded catch-up charge.
- A treasury is an ordinary M08 wallet selected by a compiled, immutable binding. Its balance remains derived only from the M08 posting journal; there is no second treasury-balance authority.

### Consistency, locking, and scheduling

- Productive commerce has a separate schema-1 expansion head and checksum because graph, core economy, and commerce have different rebuild documents. Every accepted commerce mutation still advances the single world runtime state revision and appends to the same command/event ledger.
- Interactive writes require current core economy and commerce expansion state, expected world/state/aggregate/tick values, and target row versions. Reconciliation is read-only and derives bounded evidence from immutable facts.
- The shared lock order is world advisory lock, runtime/ledger head, core economy head, commerce expansion head, simulation clock, scheduled action when present, then target aggregates in the code-owned rank `listing`, `offer`, `reservation`, `production_run`, `contract`, `business`, `facility`, `inventory`, `asset`, `wallet`; identifiers are sorted within a rank and wallet identifiers are always sorted.
- M07 scheduled actions remain the durable clock-trigger authority. Commerce payloads carry only one target UUID. The worker derives fixed actor, causation, and idempotency identity from the completed schedule and submits the narrow system command through the shared executor. Redis is wake coordination only.
- Reconciliation remains read-only. A separate private `RepairEconomicProjectionV1` recovery workflow may correct only inventory quantity/reserved-quantity projections to exact values rebuilt from immutable movement and reservation facts. Preparation seals the unchanged runtime, event, ledger, core-economy, expansion, and latest mismatch-reconciliation heads plus UUID-sorted row deltas for 15 minutes. A distinct active platform administrator approves the exact plan hash, and that approving administrator executes through an owner-authorized operator session. Execution appends repair facts, a private repair event, approval override and repair-anchor ledger evidence, and a matched reconciliation/current checkpoint; it never rewrites or deletes immutable authority. The workflow is absent from public command, HTTP, browser, and ordinary worker surfaces. All other mismatch classes require restore/PITR or another separately reviewed forward design.

### Replay and reconciliation authority

- Public command rows do not retain private commerce payloads. Private immutable payload facts preserve only the exact fields required to rebuild the five high-impact command histories, and payroll records bind the exact policy selected at the work tick.
- A reconstructed commerce document compares inventory, reservations, production, employment contracts, listings, trades, payroll, tax assessments, recipe versions, and tax policies. Each category contributes to bounded authority hashes and checkpoint evidence.
- Production authority includes complete input/output snapshots, reservation and movement envelopes, the exact terminal event version/ordinal/tick, and an immutable binding to the initial transition. A mutable transition row or self-selected terminal version cannot authorize its own replay.
- Exact duplicate commands must reproduce the same semantic document after canonical UUID aliasing. Corruption of any bound business, facility, recipe version, production, employment, listing/trade, payroll, policy, assessment, reservation, movement, event, or ledger fact must surface as a replay/reconciliation mismatch.

### Dead-outbox recovery

- A dead outbox message may be requeued only through an owner-only operator transaction. The operator must be an active platform administrator and supply a fresh retry UUID, a bounded incident reason, and the exact confirmation phrase.
- The transaction preserves message and event identity, retains the previous attempt count, appends a private immutable retry intent, and changes only `dead` to `pending`. It does not manufacture a replacement message or claim publication succeeded.
- The application role has no direct table or function privilege. A fixed-path security-definer boundary may read only the narrowly keyed private intent needed to validate the one-transaction gate.
- Replaying the same retry UUID is stable. If the message later becomes dead again, that identity cannot authorize a second recovery; a new reviewed retry UUID is required.

### Authority and product boundary

- Business authority is derived from current control of the backing organization or from a currently controlled player character whose active state declares that organization affiliation. Creator provenance alone does not grant business, wallet, employment, inventory, or trade authority.
- Participant-private employment, payroll, inventory, and trade details are filtered before pagination. Realtime notifications contain only world, entity, revision, cursor, and an allowlisted change type; clients refresh authorized reads.
- Commerce rate limits are durable and scoped to bounded targets rather than process memory. Self-trade attempts and rapid circular transfers emit low-cardinality signals; telemetry never carries amounts, payloads, or private participant identifiers.
- Each commerce command runs in a `world.economy.command` span across serializable retries and commit. Only bounded or hashed command, world, transaction, schedule, aggregate, event, outbox, and outcome identities are attached.
- All value is simulated, closed-loop, and permanently marked as having no cash value and no cash-out path. AI/model output cannot make runtime economic decisions, set prices, select workers, create policy, or execute commands.

## Consequences

- Exact arithmetic and stored provenance make replay, reconciliation, preview, and settlement agree across processes, at the cost of explicit scale conversion and larger constraints.
- Reservations prevent overselling and double consumption without introducing escrow, but commands must lock more rows in one global order.
- Scheduled production, payroll, listing expiry, and periodic tax survive Redis loss and worker restarts; completed schedules may wait for the bridge worker, so lag requires explicit monitoring.
- Policy snapshots make historical payroll explainable but prevent retroactive tax-policy changes.
- Compiler `1.2.0`/artifact 3/seed plan 2 is a real compatibility lane. The exact 1.1/2 and 1.0/1 lanes remain verifiable and are never silently upcast.
- An already-active compiler-1.1/artifact-2 world remains unchanged and commerce-uninitialized after the schema upgrade. Milestone 09 validates a new compiler-1.2 world on the same upgraded database; post-activation version evolution belongs to Milestone 13 rather than a one-off artifact rewrite.
- A reconciliation mismatch remains deliberately expensive operationally: there is no general repair mutation, and the narrow inventory projection repair requires an exact unchanged-head plan, two distinct active administrators, an owner-grade execution session, append-only evidence, and post-repair reconciliation.
- Full replay authority requires more immutable evidence and larger reconciliation documents, but it prevents projection rows and corrupt terminal versions from certifying themselves.
- Dead-outbox recovery preserves forensic continuity and idempotency at the cost of an owner-grade incident workflow and one new reviewed retry identity for every later dead generation.
- Durable target-scoped limits and bounded abuse signals behave consistently across API replicas, at the cost of additional PostgreSQL state and contention-sensitive integration coverage.

## Rejected alternatives

- IEEE-754 quantities, database-only rounding, or locale-dependent formatting.
- Mutable inventory balances without an immutable movement journal.
- Dynamic pricing, a general order book, auctions, escrow, or client-submitted totals.
- Recomputing payroll tax from the policy active at settlement time.
- Redis/BullMQ cron state as the authority for due commerce effects.
- Putting rich settlement data into scheduled-action payloads or realtime notifications.
- Charging every missed periodic interval after downtime.
- Silently adding businesses, resources, inventories, jobs, or taxes to old worlds during migration.
- Direct SQL edits to inventory, payroll, market, tax, treasury, or reconciliation projections.
- Direct outbox updates, resetting attempt counts, creating replacement messages, or granting the application role retry authority.
- Treating mutable projections, incomplete production snapshots, or self-selected event versions as replay authority.
