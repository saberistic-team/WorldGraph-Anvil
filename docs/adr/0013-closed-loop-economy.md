# ADR 0013: Closed-loop accounting and single-source asset title

- Status: Accepted
- Date: 2026-07-21
- Milestone: 08

## Context

Future production, business, market, taxation, and governance slices need durable value and title primitives. A cached balance, user-owned wallet identifier, mutable owner field, or multi-step payment/title workflow would permit double spending, ambiguous ownership, and partial purchases. JavaScript numbers and SQL floating-point values cannot represent the required minor-unit arithmetic exactly. Redis delivery, browser state, AI output, and wall time cannot be authority.

The original compiler `1.0.0` artifact schema does not contain a complete economy seed plan. Rewriting those content-addressed artifacts would invalidate M05 reproducibility evidence, while silently deriving money during migration would overstate old manifest intent.

## Decision

WorldGraph uses a closed-loop, simulated economy with no cash value, cash-out, external address, exchange rate, or payment rail. Amounts are signed 64-bit minor-unit integers internally and canonical decimal strings at JSON boundaries. The pure `@worldgraph/economy` package owns parsing, formatting, balancing, state-machine, deterministic lock-order, visibility, and reconciliation decisions without database, network, AI, wall-clock, random, or environment capability.

Every accounting mutation is one M06 serializable command transaction. A `financial_transactions` row and its immutable postings are the detailed journal tied to the accepted command/event. The deferred database invariant requires postings to share the transaction's world and currency and requires their signed sum to equal the explicit supply delta. Ordinary transfers and purchases have zero supply delta; initialization and deliberate issuance have a positive delta. `wallet_balances` and `currency_supply` are synchronous, rebuildable projections and must remain nonnegative and within the optional immutable cap.

Wallet control is derived from active world-entity controllers, never from a submitted user ID or wallet ID. Currency and wallet freeze/unfreeze transitions are append-only commands. Issuance is a separate creator override with a bounded reason, expected supply version, cap check, history fact, and alert signal; it is never represented as a deposit or direct balance edit.

Assets contain identity, classification, metadata, status, and transfer rules but no owner field. Immutable asset transfers and typed ownership events are the single title history. `asset_ownership` is the only current-owner projection and is rebuildable from that history. A direct transfer offer is a seller's revocable intent, not a marketplace, order book, reservation, or escrow. Acceptance rechecks the current tick, offer, buyer target, seller title, controller authority, currency, wallet state, expected versions, and funds, then commits payment, title, offer terminal state, ledger facts, checkpoints, history, and outbox in one transaction or commits none of them.

The global acquisition order is world advisory lock, mutable runtime/ledger/economy heads, simulation clock when a tick-sensitive transition needs it, currency and supply, offers, assets and ownership, then wallet and balance rows sorted by UUID. Code does not explicitly lock database-owned ledger or aggregate allocator heads; their owner-defined functions retain that authority. Serializable retries keep the original command and idempotency identity.

Compiler `1.1.0` introduces artifact schema `2` and an exact, content-hashed economy seed plan. Native plans are persisted with their compiler/artifact pairing. Compiler `1.0.0` and artifact schema `1` remain valid and byte-identical through an explicit verifier. A deterministic code-owned legacy adapter can produce a reviewable candidate only when the old graph has one unambiguous governing institution and controller/creator bindings. The creator must accept that exact candidate through `AdoptLegacyEconomySeedPlanV1`; adoption records the source artifact, adapter version, plan bytes, and plan hash. The runtime initializer consumes only a persisted native or adopted plan. Migration never creates currency, balances, or title for an incompatible world.

Transaction visibility is `participant`: only controllers of entities represented by that financial transaction can see its private detail. Creator status alone does not grant access to another member's wallet or transaction history. Public/member history uses bounded redacted summaries. Visibility is resolved before pagination.

Offer expiry uses the authoritative world tick and a bounded PostgreSQL reconciler. It is independent of Redis delivery and of `SIMULATION_CONTINUOUS_ENABLED`; it does not enter the M07 deterministic process registry or scheduled-action table. Expiry produces the same registered versioned command/event and terminal database checks as an interactive transition. Feature flags may reject new transfer, offer, or issuance commands, but cannot relax accounting, title, privacy, replay, or expiry invariants.

Reconciliation recomputes balance, supply, and title material from immutable facts into isolated evidence and compares canonical checksums with live projections. It is read-only by default. Repair is restore/PITR or a separately reviewed append-only compensating command requiring platform-administrator plus creator operational approval; it never edits postings, transfers, events, balances, supply, title, or checksums in place.

The first compensating contract is intentionally narrower than a general journal editor. `RepairWorldEconomyV1` can reverse exactly one already-accepted `TransferCurrencyV1`, `IssueCurrencyV1`, `TransferAssetV1`, or `AcceptAssetTransferOfferV1`. An owner-authorized preparation function derives the exact negated postings/supply and/or inverse latest-title fact from immutable source rows, binds them to the unchanged world/event/economy heads and one current matched reconciliation, hashes the private plan, and gives it a short expiry. The current creator and an active platform administrator approve that exact hash independently; the approved platform administrator executes through the owner-only operator path. Execution re-derives the plan, appends compensation facts and one repair event/anchor, advances only their synchronous projections, and must reconcile exactly. Arbitrary amount/owner deltas, initialization reversal, repair-of-repair, projection-only patching, and reuse of the public command endpoint are rejected.

## Consequences

- Concurrent overspending, duplicate delivery, and two-way transfer races converge through sorted locks, expected versions, idempotency, database constraints, and serializable retry.
- A paid title transfer cannot expose a committed debit without title or a title change without payment.
- Detailed accounting and title history remain durable while current projections can be independently rebuilt and verified.
- Old compiler artifacts and golden hashes remain reproducible. Legacy worlds require a visible, audited product choice before economy initialization.
- Expired offers become terminal even when clocks are paused or Redis and continuous simulation are disabled, because expiration is relative to the already-authoritative persisted tick.
- The MVP deliberately supports one currency per initialized world, although the schema preserves same-world/currency keys for later expansion.
- Operational feature flags can reduce mutation availability but are not integrity bypasses.

## Rejected alternatives

- Floating-point amounts or client-side balance arithmetic: inexact and forgeable.
- A mutable balance row as the journal: loses provenance and cannot prove supply conservation.
- User-owned wallets or submitted controller claims: confuses authentication with world-entity authority.
- Asset owner columns on both asset/entity and projection rows: creates two title authorities.
- Payment followed by a separate ownership command: permits partial purchase and race windows.
- Escrow, reservation, marketplace search, auctions, or order matching: outside the direct-offer MVP and substantially different semantics.
- Migration-time defaults for legacy worlds: invents economic intent and breaks auditability.
- Rewriting compiler `1.0.0` artifacts with a new field: breaks content addressing and golden compatibility.
- Redis timers, wall-clock expiry, or browser expiry: nondeterministic and not authoritative.
- Reusing the M07 scheduled process registry for offer maintenance: mixes operational projection cleanup with deterministic world processes and makes expiry depend on continuous simulation.
- Direct administrative balance/title repair: bypasses the append-only evidence chain.
- A generic compensating amount/owner editor: too broad to prove reviewer intent or exact source provenance; V1 reverses one eligible immutable source command instead.
