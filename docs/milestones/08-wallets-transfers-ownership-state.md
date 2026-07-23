# Milestone 08 state — Wallets, transfers, and ownership

Status: **complete and sealed on 2026-07-22 EDT**. This is the canonical cumulative M08 record and the compatibility input for Milestone 09.

## Inputs consumed

- The complete sealed M01 state: API v1, modular-monolith boundaries, PostgreSQL authority, Redis wake-only coordination, deterministic utilities, health/telemetry/CI/Compose baseline, forward-only migrations, and ADRs 0001–0006.
- The complete sealed M02 state: identity/session/world membership, active creator and controller authority, Origin/CSRF/BFF controls, idempotency, security audit, migration `0003_identity_authority`, ADR 0007, and retained risks.
- The complete sealed M03 state: immutable primitive registry/retrieval, reviewed 16-item catalog, PostgreSQL-owned worker recovery, migration `0004_primitive_registry`, ADR 0008, and retained registry risks.
- The complete sealed M04 state: Manifest v1 revisions, validation and provenance, creator approval, deterministic generation, migration `0005_manifest_studio`, ADR 0009, and retained provider/privacy risks.
- The complete sealed M05 state: compiler `1.0.0`, artifact/graph schema 1, immutable content-addressed artifacts, active graph/controller bindings, migration `0006_deterministic_compiler`, ADR 0010, exact golden evidence, and retained compiler risks.
- The complete sealed M06 state: contract/runtime 6; schema-1 command/event/ledger/projection/outbox/history; honest genesis; serializable command gate; hash ledger; synchronous projections/checkpoints; visibility-before-pagination history; replay/compare/graph repair; migration `0007_command_event_ledger`; ADR 0011; and retained risks.
- The complete sealed M07 state: contract/runtime 7; all simulation axes at 1; process registry 1; `EmitWorldNoticeV1@1.0.0`; PRNG `xorshift32-sha256-v1`; authoritative integer tick, future-only schedule ordering, PostgreSQL lease/fencing, bounded failure auto-pause, simulation replay/compare; migration `0008_deterministic_clock_scheduler` at SHA-256 `48bac393d34660a146ca6d65f9a228e3a0d438cc80ccabba5b6ec7c721c32f74`; ADR 0012; final 445 unit/143 integration/64 browser/two-Compose evidence; and every retained M01–M07 risk.
- The standalone M08 prompt in `docs/planning/roadmap-g-01-08.md`. Real money, cash-out, crypto, exchange, debt/credit, external payment, marketplaces/order books, production, businesses, taxes, governance minting, AI economic decisions, and client authority were not pulled into M08.

## Outcome and implementation summary

M08 implements one deterministic closed-loop virtual currency per initialized world, controlled player/organization/treasury wallets, exact initial balances and supply, immutable accounting, capped and reasoned creator issuance, immutable assets and single-source title, owner gifts, direct offers with atomic paid title transfer, authoritative-tick expiry, participant-private transaction history, read-only reconciliation, and narrowly bounded append-only compensation.

The pure `@worldgraph/economy` package owns canonical amount parsing/formatting, accounting decisions, offer/title state machines, sorted lock planning, participant visibility, seed-plan hashing, and reconciliation decisions without database, network, AI, environment, wall-clock, or random capabilities. `@worldgraph/economy-command` owns the narrow system expiry executor. The API, compiler worker, expiry worker, web Economy/Assets surfaces, telemetry, dashboards, alerts, and operator runbooks consume those versioned contracts while PostgreSQL remains authoritative.

No cash value, cash-out, payment rail, exchange, escrow, reservation, auction, order book, user-created currency, debt, credit, tax, production, business, governance-minting, or AI economic authority was introduced.

## Compatibility and public contract state

| Axis                                           | M08 state                                       |
| ---------------------------------------------- | ----------------------------------------------- |
| Product/API                                    | WorldGraph / Anvil, API `v1` unchanged          |
| Contract/runtime                               | `8` / `8`                                       |
| Command/event/ledger/projection/outbox/history | `1`, stored M06/M07 bytes unchanged             |
| Compiler                                       | `1.1.0` native; exact `1.0.0` verifier retained |
| Compiler config/WorldGraph/queue               | `1` / `1` / `1` unchanged                       |
| Compiled artifact                              | `2` native; exact artifact `1` retained         |
| Economy seed/economy/currency/wallet           | `1` / `1` / `1` / `1`                           |
| Financial transaction/asset/ownership/offer    | `1` / `1` / `1` / `1`                           |
| Economy reconciliation                         | `1`                                             |
| Manifest/primitive/simulation axes             | unchanged from sealed M07                       |

Amounts are signed 64-bit minor-unit integers internally and canonical decimal strings at every JSON boundary. JavaScript `number`, exponent notation, extra precision, ambiguous leading zero/sign forms, zero mutation amounts, and overflow fail closed. UUID, hash, timestamp, cursor, reason, version, and expected-state fields are strict and bounded.

## Compiler, artifact, and economy seed state

Compiler `1.1.0` emits artifact schema 2 with an exact `EconomySeedPlanV1`. Its plan hash is domain-separated SHA-256 over canonical `{domain:"worldgraph.economy-seed-plan.v1",plan}`. Native plans are persisted with exact run/version/artifact provenance before activation; a compiler-1.1 activation cannot succeed without that matching plan.

The pinned M08 golden is:

- manifest content hash `c3074930cc920b840e1ad5e1a8d338c621476771f2aa57e0e5c47d9904760174`;
- compiler input hash `a884959c103e9697ecc8da585a3b2149b8b697a7c3245160d45ce5210e08e888`;
- artifact hash `9805d22f0395ebac67d0824f3687e2568675bb148fb0a08fe7ecd05fd92d9bdb`;
- canonical artifact size 26,488 bytes;
- 37 entities, 44 relationships, and 2 controllers; and
- economy seed-plan hash `4d38443acb4a2c64437e6c8e4cfd1bf7369df16b896d611f881d2259c92a6743`.

That plan contains one closed-loop `GCR`/“Guild Credits” currency at scale 2, `noCashValue: true`, `cashOutAllowed: false`, immutable maximum supply `10000000000` minor units, initial supply `20000`, one zero-balance treasury wallet, two player wallets with `10000` minor units each, and one transferable founding-seal asset owned by the unique creator-controlled character.

Compiler `1.0.0`/artifact schema 1 remains byte-identical and is never silently upcast. Its pinned input hash is `47710bce54a581f601e76d3b246b644153d9a33a4658947ef2445823e299d639`; its artifact remains 23,249 canonical bytes at SHA-256 `4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`, with 35 entities, 40 relationships, and 1 controller. The code-owned `LegacyEconomySeedAdapterV1@1.0.0` fails closed unless the old graph has one governing institution, valid controller bindings, and one unique creator-controlled character. `AdoptLegacyEconomySeedPlanV1` records creator acceptance of the exact source artifact, adapter, plan bytes, and plan hash; it creates no money or title. Initialization consumes only a persisted native or explicitly adopted plan.

## Command, event, route, and UI state

The generic `POST /api/v1/worlds/:id/commands` registers these public schema-1 M08 commands:

- `AdoptLegacyEconomySeedPlanV1`, `InitializeWorldEconomyV1`, `TransferCurrencyV1`, and `IssueCurrencyV1`;
- `FreezeCurrencyV1`, `UnfreezeCurrencyV1`, `FreezeWalletV1`, and `UnfreezeWalletV1`;
- `TransferAssetV1`, `CreateAssetTransferOfferV1`, `CancelAssetTransferOfferV1`, and `AcceptAssetTransferOfferV1`; and
- `ReconcileWorldEconomyV1`.

`ExpireAssetTransferOfferV1` is a registered narrow system command submitted by the fixed expiry worker actor. `RepairWorldEconomyV1` is an internal owner-grade command and is deliberately rejected by the public generic command route.

The registered M08 fact types are `LegacyEconomySeedPlanAdoptedV1`, `WorldEconomyInitializedV1`, `CurrencyTransferredV1`, `CurrencyIssuedV1`, `CurrencyFrozenV1`, `CurrencyUnfrozenV1`, `WalletFrozenV1`, `WalletUnfrozenV1`, `AssetOwnershipTransferredV1`, `AssetTransferOfferCreatedV1`, `AssetTransferOfferCancelledV1`, `AssetTransferOfferAcceptedV1`, `AssetTransferOfferExpiredV1`, `AssetPurchasedV1`, `WorldEconomyReconciledV1`, and private `WorldEconomyRepairedV1`. Paid acceptance emits its four facts in the exact order `CurrencyTransferredV1`, `AssetOwnershipTransferredV1`, `AssetTransferOfferAcceptedV1`, `AssetPurchasedV1` at one resulting world revision.

The public/query and private-approval routes are:

- `GET /api/v1/worlds/:id/economy/summary`;
- `GET /api/v1/worlds/:id/economy/currencies`;
- `GET /api/v1/worlds/:id/economy/wallets`;
- `GET /api/v1/worlds/:id/economy/wallets/:walletId/transactions`;
- `GET /api/v1/worlds/:id/assets` and `GET /api/v1/worlds/:id/assets/:assetKey`;
- `GET /api/v1/worlds/:id/asset-transfer-offers`;
- `GET /api/v1/worlds/:id/economy/repair-plans/:planId`; and
- `POST /api/v1/worlds/:id/economy/repair-plans/:planId/approvals`.

Ordinary reads require active membership in the path world. Wallets require current entity control; transaction detail uses participant visibility before pagination; offer views are limited to seller, targeted buyer, or one exact open invitation; creator role alone does not reveal another member's wallet or journal. Repair-plan reads deliberately collapse missing, cross-world, and unauthorized results to non-enumerating `404` unless the actor is the current creator or an active platform administrator.

The web application adds keyboard- and mobile-capable Economy and Assets pages. It displays the virtual/no-cash boundary, initialization/provenance state, reconciliation state, controlled balances/history, transfers, creator issuance override, freezes, gifts, direct offer creation/cancel/accept, exact server tick/expiry, uncertainty lookup, stale/conflict recovery, disabled/frozen states, and safe errors without client-computed balance or title authority. The browser proxy admits only the exact bounded M08 read paths and inherited generic command path; private repair routes, direct mutation lookalikes, malformed UUIDs/stable keys, exports, and extra subpaths remain closed.

## Accounting, title, concurrency, and privacy invariants

- Every value mutation is one inherited serializable command transaction. A `financial_transactions` fact plus immutable `wallet_postings` must balance exactly to its explicit supply delta. Transfer and purchase deltas are zero; initialization and issuance are positive; projections remain nonnegative and supply cannot exceed cap.
- Wallet authority derives from active `world_entity_controllers`; submitted user/controller claims never establish authority. Creator issuance is an explicit reasoned override with expected currency/supply/wallet versions, audit evidence, participant history, and an alert signal.
- `assets` has no mutable owner field. Immutable `asset_transfers` plus typed events are title history, and `asset_ownership` is the only current-owner projection.
- An offer is revocable seller intent, not escrow or reservation. Acceptance rechecks authoritative tick, open state, target buyer, seller title, transferability, currency, wallet control/status/versions, balance, and expected title/offer versions, then commits payment, title, terminal offer, events, ledger, history, checkpoint, reconciliation status, and outbox together or none.
- The lock order is world advisory lock → runtime/ledger/economy heads → tick-sensitive clock → currency/supply → offers → assets/title → wallet/balance rows sorted by UUID. Database-owned allocator heads remain behind security-definer functions. Serializable retries preserve command and idempotency identity.
- Offer expiry is discovered in bounded PostgreSQL order from the persisted simulation tick. It is independent of Redis and `SIMULATION_CONTINUOUS_ENABLED`; accept/cancel/expire races converge to one terminal result.
- Economy history visibility adds `participant` and is resolved in SQL before ordering, limiting, and opaque cursor generation. Private memo/posting/wallet/controller/session material is excluded from public history, logs, metrics, and outbox references.
- Economy initialization uses one aggregate `WorldEconomyInitializedV1` event tied to the exact plan hash, source world version, currency, initialization transaction, supply, and all wallet/asset/ownership counts. This preserves the inherited 64-event command limit and the compiler's 100-active-playable-member bound; initialization permits up to 100 bounded nonzero distribution postings.
- `ReconcileWorldEconomyV1` rebuilds balances, supply, and latest title from immutable facts into isolated evidence. It records a matched/mismatch run and reconciliation fact at an unchanged source but cannot modify financial facts, title facts, balances, supply, or ownership.

## Append-only repair model

Ordinary recovery remains restore/PITR first. M08 additionally implements a narrow exact compensation path for one already-accepted `TransferCurrencyV1`, `IssueCurrencyV1`, `TransferAssetV1`, or `AcceptAssetTransferOfferV1`. Initialization, repair-of-repair, arbitrary amount/owner edits, projection-only patches, and generic public repair submission are rejected.

The owner-only `economy repair-prepare` operation requires a current matched reconciliation and derives one exact sealed private plan from immutable source facts. The plan binds world/version, state/event positions, economy head/checksum, source command/transaction/transfer, reserved compensation identities, reasons, and the complete negated accounting and/or inverse latest-title delta. It expires exactly 24 hours after millisecond-precision `preparedAt`. Incident and PITR-not-used reasons are preserved as entered, must be 8–500 Unicode code points, cannot start/end with ASCII U+0020, and reject C0, DEL, and C1 controls.

The current creator and one distinct active platform administrator independently approve the same complete plan hash through the authenticated API. Approval identity equals the `idempotency-key`; creator approval creates server-owned override evidence; the database rechecks current authority, distinct people, exact plan seal, unchanged expiry, and idempotent replay. Expected deferred expiry races map to `409 REPAIR_APPROVAL_CONFLICT` rather than an internal error.

Only the approved platform administrator can run owner-only `economy repair-execute`. Under the world writer lock, execution revalidates the complete seal, both still-active approvers, source/current heads, reconciliation, balances/supply, latest title and offer state, then appends one compensation transaction and/or inverse title transfer, private `WorldEconomyRepairedV1`, `repair_anchor` ledger fact, redacted histories, outbox/checkpoint, execution evidence, and updated projections. It never edits source facts. Exact replay returns the original receipt and concurrent execution creates one effect. The economy head becomes pending until a real post-repair `ReconcileWorldEconomyV1` returns it to current/matched.

Private plans, approvals, executions, reasons, deltas, wallet/entity identities, and source evidence are withheld from ordinary app-table access, logs, browser analytics, shared caches, and public/member history.

## Migration and database state

The sealed journal head is `0009_wallets_transfers_ownership` at SHA-256 `2a7236fa86d9744a15612ad79319683a976e61f56bce3f9f4a95e619801b205e`. It is journal entry index 8 after `0008`; the migration checksum registry pins all nine files. Migrations `0001`–`0008` remain byte-identical, including sealed `0008` SHA-256 `48bac393d34660a146ca6d65f9a228e3a0d438cc80ccabba5b6ec7c721c32f74`.

`0009` requires the exact sealed M07 metadata, advances compiler `1.0.0`→`1.1.0`, compiled artifact schema 1→2, and contract/runtime 7→8, and adds economy seed, economy, currency, wallet, financial transaction, asset, ownership, offer, and reconciliation schema axes at 1. Compiler/artifact database checks retain both the exact legacy 1.0/1 pair and native 1.1/2 pair.

It adds 14 bounded enums and these authoritative structures: `compiled_economy_seed_plans`, `currencies`, `currency_supply`, `wallets`, `wallet_balances`, `financial_transactions`, `wallet_postings`, `assets`, `asset_ownership`, `asset_transfers`, `asset_transfer_offers`, `world_economy_heads`, `economy_reconciliation_runs`, `economy_reconciliation_items`, `economy_participant_history`, private `economy_command_write_snapshots`/`economy_command_mutations`, and private `economy_repair_plans`/`economy_repair_approvals`/`economy_repair_executions`. Reversal foreign keys make compensation source identity explicit.

Deferred constraints and security-definer functions prove native-plan provenance, balanced journal/projection parity, exact title, accepted command/event/cardinality, reconciliation evidence, repair approval windows, and repair execution effects. The application role receives only the reads/inserts and narrow projection columns/functions required for compilation and commands. Immutable financial/title/reconciliation facts cannot update/delete; private command snapshots/mutations and repair evidence are revoked; repair prepare/execute remain owner-only.

Completed focused migration coverage applies `0001`→`0009` fresh, preserves exact M01/M02 upgrade data, repeats as a no-op, verifies spatial/vector extensions, checks Drizzle/runtime metadata parity, and confirms production initialization creates no user, world, currency, wallet, balance, asset, title, offer, or invented legacy plan. The reviewed 16-primitive catalog remains the only production content seed.

## Worker, observability, and operations state

The compiler worker persists the native economy plan in the same activation transaction. The expiry worker discovers due offers through `worldgraph_due_asset_transfer_offers`, orders by expiry/world/offer, and submits fixed idempotency identity `economy-offer-expiry-v1:<offerId>:<expiresAtTick>`. Defaults are batch 25 and 1,000 ms reconciliation interval; configuration bounds are batch 1–250 and interval 100–60,000 ms.

Feature controls `ECONOMY_TRANSFERS_ENABLED`, `ECONOMY_OFFERS_ENABLED`, `ECONOMY_ISSUANCE_ENABLED`, and `ECONOMY_DEBITS_FROZEN` reduce availability without bypassing database invariants. Bounded transfer/offer/issuance rate controls are operational throttles, not correctness controls.

Low-cardinality telemetry covers command outcome, initialization, issuance override, serialization retry, expiry sweep/tick lag, invariant findings, object counts, open/expired offers, reconciliation mismatches, and last repair timestamp. `deploy/dashboards/economy-v1.grafana.json` and `deploy/alerts/economy-v1.rules.yml` cover those signals. `docs/operations.md` defines failed initialization, freeze/uncertainty, contention, expiry, reconciliation/integrity, duplicate/idempotency, controller compromise, backup/PITR, and full prepare/approve/execute/post-repair reconciliation procedures. Bootstrap and migrate success output truthfully names sealed head `0009_wallets_transfers_ownership`.

## Verification evidence

Evidence below was collected on 2026-07-22 EDT with Node `24.18.0`, pnpm `11.9.0`, PostgreSQL 17 test containers, and Redis `8.4.0`. Only completed commands are recorded as passing.

| Check                                                       | Sealed result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregate repository gate (`pnpm check`)                    | **Passed.** Prettier; ESLint with zero warnings; all workspace typechecks; current and legacy compiler golden verification; **88 files, 561/561 unit tests**; migration journal/checksum validation at `0009_wallets_transfers_ownership`; all 16 production builds; and separate-process offline compiler CLI identity passed on the sealed tree.                                                                                                                                                                                                                                                                                                                            |
| Focused compiler/database/economy evidence                  | **Passed.** Native/legacy golden checks; updated real-PostgreSQL compiler persistence 11/11; migration/ledger/repair database suites 63/63; browser-proxy boundary 9/9; and focused API/contracts/economy/worker/web plus concurrency/race suites all passed, including real 100-way overspend protection and repair replay/tamper/expiry/authority cases.                                                                                                                                                                                                                                                                                                                    |
| Independent blocker audit                                   | **GO.** No P0, P1, or P2 correctness, security, migration, replay, privacy, or architecture blocker remained after repair plan-seal, authority-lock, expiry-race, private-evidence, confirmation, and narrow HTTP conflict-mapping corrections.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Full real PostgreSQL/Redis integration (`test:integration`) | **Passed: 20 files, 201/201 tests.** The final run covered migrations through `0009`, command/event/ledger and simulation inheritance, native/legacy compiler persistence, real economy commands/accounting/title/privacy/reconciliation/repair, workers, API, and concurrency/race boundaries.                                                                                                                                                                                                                                                                                                                                                                               |
| Full browser/accessibility (`test:e2e`)                     | **Passed: 74/74 tests.** The final complete desktop/mobile run included identity/authority, primitives, manifest/compiler/graph, ledger/history, deterministic simulation, and M08 Economy/Assets accessibility and interaction coverage.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Production Compose bootstrap/smoke/repeat                   | **Passed.** `reset:local` removed all volumes; `bootstrap` rebuilt all 16 workspaces and started healthy PostgreSQL 17, Redis 8.4.0, API, worker, and web services; migrate exited 0, reported head `0009_wallets_transfers_ownership`, and imported the reviewed 16 primitives. Two consecutive `test:compose` runs then passed on retained data. Each exercised native V2 compile/plan verification, exact 20,000-minor GCR initialization, private Alice→Bob 25.00 transfer, founding-seal gift, Bob→Alice 10.00 atomic paid return, final 6,500/13,500 balances, unchanged 20,000 supply, matched reconciliation, simulation, Redis/PostgreSQL degradation, and recovery. |

### Retry and correction record

- The first aggregate integration attempt exposed cumulative pre-M08 fixture assumptions and one real artifact transport defect: the V1 response serializer stripped the V2 economy plan while leaving its V2 hash/version. Fixtures were made cumulative, artifact records/services were typed as the supported union, the route now preserves exact V1 or V2 bytes, and the final 201-test run passed.
- Two pre-final full browser runs reached 73/74 because accessibility analysis raced Next.js streamed title metadata; the isolated test was green. The test now waits for the exact `WorldGraph — Anvil` title before Axe analysis, and the final full run passed 74/74.
- The first Compose attempt activated compiler `1.1.0` correctly but the old smoke still required `1.0.0`. Expanding it to M08 then exposed a real production BFF defect: the Economy/Assets UI read routes were absent from the proxy allowlist and returned 404. Exact stable-key/UUID path matchers, denied-lookalike tests, V2 artifact/plan checks, and the complete two-user economy journey were added. After diagnostic oracle corrections, a fresh rebuild and both counted retained-data smokes passed. No failed attempt was treated as acceptance evidence.

## Architecture decisions and deviations

- ADR 0013 accepts closed-loop bigint accounting, immutable financial/title facts, synchronous rebuildable projections, controller-derived wallet authority, direct atomic purchases, participant privacy, authoritative-tick expiry, compiler compatibility/adoption, read-only reconciliation, and exact append-only compensation.
- Artifact schema advances to 2 because strict artifact-1 identity cannot gain a seed plan. The legacy verifier and golden remain exact instead of falsifying stored bytes through an upcast.
- Legacy economy intent is code-owned and creator-confirmed because Manifest v1/compiler 1.0 do not encode complete treasury, distribution, or founding-asset intent. Migration cannot claim that derived plan was original manifest intent.
- One aggregate initialization event preserves the inherited 64-event command bound for up to 100 playable members while exact plan hash, immutable initialization postings/title rows, and count parity retain detail.
- Economy seed plan v1 admits exactly one transferable founding-seal asset. New seed asset classes require a versioned plan/adapter expansion.
- Offer expiry is operational reconciliation at an already-persisted tick, not an M07 simulated process. It therefore remains available while the clock is paused, Redis is unavailable, or continuous simulation is disabled.
- Repair approval is an authenticated API review surface, but execution is intentionally owner-only. The public command bus cannot manufacture compensating authority.
- Browser access remains an explicit path allowlist. Economy mutation continues through the generic command envelope; direct economy/asset/offer mutation paths and private repair paths are not opened by the BFF.
- API and ordinary workers still share the inherited application database role. Column grants, command gates, immutable triggers, and private-evidence revocations constrain it, but production role separation remains desirable.

## Known risks and retained incomplete work

- This is simulated closed-loop value only. Production, businesses, jobs, markets/order matching, escrow, taxes/budgets, governance minting, debt/credit, external payments/exchange, and AI economic actors remain later work.
- One currency per initialized world, one founding-seal seed asset, and one direct open offer per asset are deliberate MVP bounds, not a general finance or marketplace platform.
- The shared application role, process-local rate limits, external immutable checkpoints, continuous privileged integrity scans, managed PITR/restore drills, alert routing, dependency/license/image hardening, provider/profile work, and managed hosting remain retained deployment risks.
- Repair is intentionally rare and operationally expensive. It depends on protected owner credentials, independent creator/platform-admin review, a current matched reconciliation, and disciplined post-repair verification.

## Inputs exported to Milestone 09

**Authorized.** Milestone 09 inherits API v1; contract/runtime 8; compiler `1.1.0`/artifact 2 and exact legacy `1.0.0`/artifact 1; all economy axes at 1; sealed migration `0009` and its digest; both golden identities and the economy plan hash; the command/event/route registry; accounting/title/lock/privacy/repair invariants; the final 561 unit/201 integration/74 browser/two-Compose evidence; ADR 0013; operations state; retry/deviation record; and every retained M01–M08 risk. M09 must append after `0009` and preserve the compatibility and privacy boundaries above unless it introduces an explicit versioned transition.
