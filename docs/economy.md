# Closed-loop economy and asset ownership

Milestone 8 adds simulated currency, wallets, immutable accounting, assets, title, and direct paid transfers. All value is virtual and has no cash value, cash-out, crypto representation, exchange rate, external address, or external payment rail. The words transfer, issuance, balance, purchase, and treasury describe world simulation state only.

## Compatibility and initialization

Runtime and contract compatibility advance to `8`; API remains `v1`. Native compiler `1.1.0` output uses artifact schema `2` and carries one exact `EconomySeedPlanV1` plus its domain-separated SHA-256 hash. The plan identifies the currency, immutable precision/cap, treasury and controlled wallets, initial distributions, assets, and initial owners using stable logical keys rather than database UUIDs.

Compiler `1.0.0` artifact schema `1` remains accepted by its exact legacy verifier and is never rewritten. An old active world has no economy until its creator reviews and accepts the deterministic candidate with `AdoptLegacyEconomySeedPlanV1`. The adapter is code-owned and versioned; it fails when governance or creator/controller identity is ambiguous. Adoption persists the exact source artifact identity, adapter identity, plan bytes, and plan hash. It does not create runtime value.

`InitializeWorldEconomyV1` is the only initialization transition. It requires an active compatible world and the exact persisted native or adopted plan, then creates the currency, supply, wallets, balances, initial accounting transaction/postings, asset, title history/projection, economy head/checkpoint, ledger/history, and outbox facts atomically. One aggregate `WorldEconomyInitializedV1` is the honest economy-genesis event: its exact plan hash/version, source world version, currency/transaction identity, supply, and row counts anchor every materialized seed row. The initial asset-transfer row provides detailed immutable title history and references that shared genesis event; later title changes use singular `AssetOwnershipTransferredV1` events. This avoids exceeding the inherited 64-domain-fact command budget while retaining bounded plans of up to 100 controllers plus treasury and the one code-owned M8 founding-seal asset. Initialization is idempotent by command and plan identity. A missing, mismatched, partial, or incompatible plan leaves the world `not_initialized`; there is no migration fallback, guessed balance, or guessed owner.

## Amounts

Authoritative amounts are signed 64-bit integers in currency minor units. JSON uses canonical base-10 decimal strings. For a scale-2 currency:

| JSON amount | Minor units | Result                                            |
| ----------- | ----------: | ------------------------------------------------- |
| `"25.00"`   |      `2500` | accepted                                          |
| `"0.01"`    |         `1` | accepted                                          |
| `"25"`      |           — | rejected as noncanonical for scale 2              |
| `"025.00"`  |           — | rejected for leading ambiguity                    |
| `"25.0"`    |           — | rejected for wrong precision                      |
| `"1e2"`     |           — | rejected; exponent notation is forbidden          |
| `"-1.00"`   |           — | rejected for transfer, price, and issuance inputs |
| `"0.00"`    |           — | rejected for transfer, price, and issuance inputs |

No financial decision converts through JavaScript `number`, SQL floating `numeric`, locale parsing, or client-computed minor units. Presentation may be locale-friendly, but submission previews and sends the exact canonical decimal.

## Accounting invariants

Each accepted accounting command creates exactly one immutable financial transaction linked to its command and accounting event. Posting ordinals are unique within the transaction. A deferred database assertion proves:

```text
sum(posting.signed_amount_minor) = transaction.supply_delta_minor
```

All postings must use the transaction's world and currency. Ordinary transfers and asset purchases use supply delta `0`: the source posting is negative and destination posting is positive by the same magnitude. Initialization and explicit creator issuance use a positive supply delta and one or more positive destination postings. Current supply equals the sum of transaction supply deltas; every balance equals the sum of postings for that wallet. Both remain in signed-64-bit range, balances and supply remain nonnegative, and supply never exceeds the immutable cap.

`financial_transactions`, `wallet_postings`, and asset transfers are insert-only. `wallet_balances`, `currency_supply`, and `asset_ownership` are synchronous projections, not alternate facts. Application code cannot update a projection except inside the matching registered command transaction, and cannot update or delete a journal fact.

## Commands and authority

Economy mutations inherit M06 authentication, Origin/CSRF protection, request-bound idempotency, active membership, expected world/state/aggregate versions, one-state-revision event grouping, ledger hashes, checkpoints, and uncertain-result resolution.

- `AdoptLegacyEconomySeedPlanV1` is a creator-only confirmation of an exact deterministic legacy candidate. It creates plan provenance, not money.
- `InitializeWorldEconomyV1` consumes the exact persisted plan once.
- `TransferCurrencyV1` requires active control of the source wallet's owner entity, compatible active wallets/currency, exact versions, a positive canonical amount, and sufficient funds.
- `IssueCurrencyV1` is a creator-only override with an explicit bounded reason, expected supply version, rate limit, and cap check. It is visibly distinct from initialization and transfer.
- `TransferAssetV1` requires control of the current owner, a transferable active asset, an eligible active recipient, and the exact title version.
- `CreateAssetTransferOfferV1` records one future-tick, optionally buyer-targeted seller intent for an exact positive price.
- `CancelAssetTransferOfferV1` requires seller control and an open offer.
- `AcceptAssetTransferOfferV1` requires eligible buyer control plus exact offer/title/wallet versions and commits payment, title, terminal offer, events, journal, ledger, projections, history, and outbox together.
- `ExpireAssetTransferOfferV1` is server-issued from a bounded PostgreSQL scan at the authoritative current tick and is safe under duplicate discovery.
- `ReconcileWorldEconomyV1` is an audited creator/operator verification command at an exact economy-head version. It appends the isolated run/report and `WorldEconomyReconciledV1` evidence but never changes a balance, supply, title, posting, or transfer fact.
- `FreezeCurrencyV1`, `UnfreezeCurrencyV1`, `FreezeWalletV1`, and `UnfreezeWalletV1` are append-only operational commands; no status row is edited manually.

Stable domain errors include `ECONOMY_NOT_INITIALIZED`, `INVALID_AMOUNT_FORMAT`, `INSUFFICIENT_FUNDS`, `WALLET_NOT_CONTROLLED`, `WALLET_FROZEN`, `CURRENCY_FROZEN`, `CURRENCY_MISMATCH`, `SUPPLY_CAP_EXCEEDED`, `ASSET_NOT_OWNED`, `ASSET_NOT_TRANSFERABLE`, `OFFER_EXPIRED`, `OFFER_NOT_OPEN`, `BUYER_MISMATCH`, and `OWNERSHIP_CONFLICT`. Standard stale-version, idempotency, authorization, rate, and availability errors remain unchanged.

The creator-only economy summary carries the exact server-authorized treasury issuance target even when the creator does not control the treasury organization. This narrowly exposes only the fields and versions required for issuance and does not grant treasury wallet history or ordinary debit authority. Untargeted offers are usable only as private invitations: the buyer supplies the exact UUID, the server returns at most that one open offer, and `canAccept` plus the eligible wallet token are derived from current controller, currency, wallet, and tick state. The ordinary offer page never lists those invitations to unrelated members.

## Locking and atomic purchase

All economic commands run at serializable isolation. The acquisition order is:

1. world advisory lock;
2. mutable runtime, ledger, and economy heads;
3. simulation clock when the decision is tick-sensitive;
4. currency and supply;
5. offer rows;
6. asset and ownership rows; and
7. wallets and balances in ascending UUID order.

Database-owned ledger and aggregate allocator heads remain inside their owner-defined functions and are not application-lock targets. Opposite-direction transfers therefore acquire the same wallet order. After every lock, the handler reloads controller authority, status, versions, funds, title, price, target buyer, and current tick before it decides.

Offer creation does not reserve title or funds. A gift, cancellation, freeze, or another accepted purchase can win first; a later accept then fails without accounting or title effects. One accepted purchase creates a zero-supply transaction, two opposing postings, a purchase-linked asset transfer, the new owner projection, and accepted offer state under one command/state revision. Failure injection at any persistence boundary must roll the whole transaction back.

## Ownership

`assets` has no owner column. Each active owned asset has one `asset_ownership` projection row. Initial, gift, purchase, and compensating transfers are immutable title facts; a paid transfer references its exact financial transaction. Cross-world asset/entity references are rejected by composite foreign keys, from/to owners must differ, and one open direct offer per asset is permitted.

Metadata is strict, bounded, inert JSON for a code-owned asset type/schema. It cannot carry HTML, executable behavior, URLs, external payment identifiers, or arbitrary authority. UI renders it as text.

## Privacy and history

Wallet detail is visible only to active controllers of the wallet owner. A transaction is classified `participant`; controllers of an entity represented by one of its postings may view the private detail. A creator does not automatically gain another member's transaction detail. Treasury or public aggregates are exposed only through their explicit policy and never reveal private memo text or counterparties.

Visibility is applied before cursor pagination. Redacted history contains bounded command/type/status references, never private memo text, raw posting payloads, controller/session/IP data, or uncontrolled identifiers. Logs, traces, metrics, queues, and failures omit private memos and transaction payload bytes.

## Offer expiration

Expiry is an integer world tick, never a wall timestamp. A bounded worker reconciles open offers whose `expires_at_tick` is at or before the persisted simulation tick. PostgreSQL is discovery and transition authority; Redis is unnecessary. The reconciler runs even when `SIMULATION_CONTINUOUS_ENABLED=false` and does not add offers to the M07 scheduled-action/process registry. Racing accept, cancel, and expire commands lock and recheck the same offer; exactly one legal terminal transition can commit.

## Reconciliation and repair

Economy reconciliation reads immutable financial transactions, postings, and asset transfers into isolated derived material. It recomputes every wallet balance, currency supply, and latest asset owner, generates a canonical checksum, and compares counts/checksum with live projections at one unchanged source head. A match advances only reconciliation evidence; it does not make projections authoritative.

On mismatch:

1. disable affected economy mutations and preserve database, command IDs, source revision, reconciliation run, hashes, and backup/PITR window;
2. verify the general ledger and simulation clock first;
3. repeat reconciliation at an unchanged source revision and identify only the safe first divergent path;
4. prefer restore/PITR into an isolated environment and verify all ledgers/projections before promotion; and
5. if restore cannot meet the approved recovery objective, prepare an exact source-command reversal plan through the owner-authorized operator path; bind its private semantic delta to the unchanged head and current matched reconciliation, obtain distinct active creator and platform-administrator approvals over the exact plan hash, and execute it before the fixed 24-hour expiry.

`RepairWorldEconomyV1` may reverse one accepted transfer, issuance, owner gift, or atomic purchase. It derives exact negated postings/supply and/or the inverse latest-title fact from the immutable source; it cannot accept arbitrary amounts or owners, reverse initialization or another compensation, bypass insufficient-funds/supply/title checks, or repair projection-only divergence. Never update/delete a posting, transaction, asset transfer, balance, supply, owner projection, event, ledger entry, or checksum to make verification pass. A compensation appends explicit accounting/title facts and preserves the original error.

## Operations and feature controls

Transfer, offer, and issuance feature flags may refuse new commands. They do not bypass expected versions, controller checks, frozen state, caps, posting balance, title, replay, history, or database gates. Offer expiry and read-only reconciliation continue while user-facing mutation flags are disabled.

An uncertain response is resolved by querying the original command ID. If accepted, journal, title, offer, projections, events, ledger, and outbox committed together; if absent or rejected, no partial effect exists. Never retry with a new command identity until the original outcome is known.

Currency or wallet compromise is contained through its versioned freeze command. Investigate controllers and immutable command/history evidence, revoke compromised identity authority through the identity runbook, reconcile, then unfreeze only through a separate reviewed command. Do not edit status, balance, or title directly.

Telemetry is low-cardinality and records command kind/outcome/latency, serialization retry, insufficient-funds and invariant-rejection counts, creator issuance, explicit reconciliation outcome/duration, and offer-sweep outcome/duration. Authoritative operational gauges publish `worldgraph_economy_object_count{kind=currency|wallet|asset|open_offer}`, `worldgraph_economy_open_expired_offers`, `worldgraph_economy_reconciliation_mismatches`, and `worldgraph_economy_last_repair_timestamp_seconds` from PostgreSQL-backed state. The repair timestamp is zero until an owner-authorized execution commits and contains no world, actor, plan, command, or amount label. Amount, memo, actor/session, wallet, asset, command, and hash values never become metric labels.

See ADR 0013 for the authority decision and `operations.md` for incident procedures.

## Productive commerce extension

Milestone 09 advances contract/runtime to 9, compiler to `1.2.0`, compiled artifact to 3, economy seed plan to 2, economy reconciliation to 2, and simulation process registry to 2. It adds schema-1 resources, recipes, inventory/reservations, businesses/facilities, employment/work/payroll, production runs, fixed-price listings/trades, tax policies/assessments, and a separate commerce expansion head. API remains v1 and every M08 journal, title, offer, and compatibility lane remains exact.

`InitializeWorldCommerceV1` is an explicit, idempotent transition against an exact compiler-1.2/artifact-3/plan-2 chain. It materializes only the compiler-authored plan. Neither migration nor runtime guesses productive intent for a compiler-1.1/plan-1 or compiler-1.0 world. Initialization advances the shared ledger/runtime revision and creates one commerce expansion checkpoint without changing M08 balance/title authority.

See `commerce-schema.md` for the authoritative data dictionary.

## Exact resource quantities and inventory

Each resource declares a quantity scale from 0 through 12. JSON uses one canonical decimal representation at that exact scale; the pure domain uses scaled bigint atoms and PostgreSQL uses constrained `numeric(30,12)`. No exact quantity passes through JavaScript floating point. Quantity multiplication by a positive integer unit price converts to minor units with deterministic half-up rounding; percentage policy assessment uses integer basis points and an explicitly pinned rounding rule.

An inventory has quantity and reserved quantity only. Available quantity is always derived:

```text
available = quantity - reserved
0 <= reserved <= quantity
```

Every quantity effect appends an immutable `inventory_movements` row with source identity and ordinal. An active reservation is tied to exactly one production input or listing; it can become consumed, released, or expired once. Direct edits, negative inventory, reservation beyond quantity, excess resource precision, and source replay are database-rejected.

## Production and scheduled completion

Starting a run locks the facility, exact recipe version, sorted input inventories, reservations, and schedule state. It snapshots the recipe inputs/outputs, reserves every input atomically, and creates one M07 scheduled action due at `currentTick + durationTicks`. No resource is consumed or produced at start.

After M07 marks the action completed, the commerce bridge submits `CompleteProductionRunV1` for only that run ID. The command consumes every exact reservation and journals output into the facility asset's configured container inventory once. Missing/incompatible state records a bounded failure without partial output. The schedule actor, causation event, and `commerce-schedule-v1:<ActionType>:<scheduledActionId>` key make restart and duplicate wake exactly-once in effect.

## Employment, work, and payroll

Employment follows `offered -> active -> ended|cancelled` with current business authority, offer capacity, and cooldown checks. `PerformJobV1` creates immutable work evidence and a pending payroll record; the worker later submits `SettlePayrollV1` from the exact schedule. The applicable payroll policy is snapshotted at the work tick, so a policy effective later cannot change an already-earned settlement.

Paid payroll creates one balanced M08 financial transaction and immutable tax assessment. A failed settlement creates no financial transaction and cannot be disguised as paid. Contract, job, and payroll details are participant/business-manager private and are filtered before pagination.

## Fixed-price market and atomic settlement

A listing binds one seller inventory, resource, seller wallet/currency, positive fixed unit price, offered quantity, remaining quantity, and future expiry tick. Its active reservation equals the remaining quantity. Purchases require `currentTick < expiresAtTick`, exact listing/inventory/wallet/expansion versions, buyer control, sufficient buyer funds, and a different buyer and seller.

The server computes quantity conversion, gross, policy applicability, tax, fee, buyer total, seller net, and treasury destinations. Purchase commits these effects together:

1. consume the purchased listing reservation and move exact inventory;
2. append one zero-supply balanced financial transaction for buyer, seller, and treasury wallet postings;
3. append immutable trade and tax-assessment facts;
4. transition the listing to partial or filled state; and
5. append domain/ledger/outbox evidence and update core-economy, commerce, graph, and history checkpoints at one world revision.

Any failure rolls back all five. Purchase preview is never a reservation or settlement authority. Its sales/transaction and marketplace-fee queries receive the same configured disabled-policy IDs as execution, preventing a disabled policy from appearing only in the quote. Self-trade, client totals, dynamic price, order matching, auction, escrow, external payment, and credit remain absent.

## Tax and treasury

Tax policies are immutable compiler-authored facts with explicit type, collection mode, rate or fixed amount, applicability, effective tick range, provenance, and checksum. Sales/transaction policies may add to the payer or withhold from the recipient; payroll and marketplace fee are withheld. Percentage rates are bounded basis points. Periodic-flat tax names an exact payer entity/wallet and interval.

Settlement and assessment share one transaction: if payment fails, no tax is collected. Periodic recurrence advances from the authoritative occurrence by its interval and skips missed periods; operators must not manufacture catch-up charges. Treasury is an ordinary M08 wallet selected by an immutable binding. Its balance is still the sum of journal postings, while treasury read APIs expose only policy-safe aggregate revenue.

The aggregate commerce transaction timeline is projected directly from immutable financial transactions and their exact trade, paid-payroll, or periodic-assessment source facts. Market purchases and payer-free periodic-tax summaries are member-visible; payroll summaries are visible only to recorded/current worker or business participants and active world creators/administrators. Authorization precedes cursor pagination, and no variant exposes wallet, payer, employer, worker, controller, posting, memo, or command identifiers.

## Commerce lock and consistency order

Commerce uses the shared serializable world writer order:

1. world advisory lock;
2. runtime/ledger head;
3. M08 core economy head;
4. M09 commerce expansion head;
5. simulation clock and then scheduled action when needed;
6. target rows by rank `listing`, `offer`, `reservation`, `production_run`, `contract`, `business`, `facility`, `inventory`, `asset`, `wallet`; and
7. stable UUID order within a rank, with all wallet IDs sorted.

Handlers reload membership/controller/organization authority, ticks, policies, status, quantities, funds, and expected versions after locks. The separate commerce checksum does not replace the M08 economy or graph checksum; one accepted command updates each affected checkpoint against the same runtime revision.

## Player and creator guide

Players can view public resources, recipes, open offers/listings, safe treasury aggregates, and projections available to their active membership. They can act only for currently controlled entities and authorized organizations. The M09 workspace exposes business/facility, employment/work, production, listing create/cancel, and purchase controls. A zero-lag projection that is awaiting its first reconciliation remains usable and is labeled `Reconciliation pending`; nonzero lag, mismatch, or failed projection state blocks affected actions. A preview can change before submission; stale commands return refresh/version guidance. Retrying an uncertain purchase, job, production start, or listing action must reuse the original command/idempotency identity until its outcome is known.

Creators define bounded economy intent through reviewed Manifest/compiler data and use the same registered commands as other authorized actors. Creator provenance does not reveal another player's wallet, payroll, contract, inventory, or trade detail and does not authorize direct projection edits. Policy changes require a future governance boundary; M09 policy facts are immutable.

World currency, wages, resource prices, taxes, fees, and treasury balances are simulation units only. They cannot be bought for fiat, redeemed, transferred to an external address, exchanged for cryptocurrency, lent with interest, or represented as guaranteed real-world value. Product copy, support guidance, and analytics must preserve this disclosure.

## Commerce reconciliation and recovery boundary

`ReconcileWorldCommerceV1` rebuilds inventory/reservation, production, trade, payroll, tax, and aggregate checksum evidence from immutable facts at one source head. Migration `0012_commerce_reconciliation_integrity` makes that authority explicit: private canonical command payload/authority facts bind the five history-sensitive commands `CreateEmploymentContractV1`, `EndEmploymentContractV1`, `StartProductionRunV1`, `CreateMarketListingV1`, and `PurchaseMarketListingV1`; payroll records bind the policy selected at the work tick; recipe-version and tax-policy provenance participate in checksums; and production comparison includes initial/terminal transitions, exact input/output snapshots, reservations, events, and movements. A match marks that head current. A mismatch records bounded immutable items and freezes affected commerce mutations; it does not repair data.

Migration `0011` implements `RepairEconomicProjectionV1` as a private owner-authorized prepare/approve/execute workflow; migration `0012` strengthens the facts and hashes on which it relies without widening what it may change. The workflow remains absent from public command registries, HTTP, browser, and ordinary worker authority. A 15-minute plan seals the exact current heads, latest mismatch reconciliation, and UUID-sorted inventory quantity/reserved-quantity deltas rebuilt from immutable facts. A distinct active platform administrator approves the exact hash, and that same approver executes. Execution appends repair facts, a private event, approval override and repair-anchor ledger evidence, and a matched reconciliation/current checkpoint while updating only the guarded inventory projection fields. `RepairWorldEconomyV1` remains limited to the M08 accounting/title compensation model. All mismatch classes outside this narrow inventory projection domain require restore/PITR or another separately reviewed forward design. Never edit inventory, reservation, production, payroll, listing, trade, policy, assessment, treasury, event, ledger, or checkpoint rows directly to force a match.

Target-scoped rate limits are durable command facts, not a browser hint. `world.economy.command` traces bound trace-only command/transaction/aggregate/outcome correlation and domain-separate actor, world, idempotency-key, and wallet references; amounts, payloads, and private participant data are excluded. `worldgraph_economy_abuse_signals_total{signal}` has exactly two labels: `self_trade_attempt` for same-entity rejection or same-actor/distinct-entity review, and `rapid_circular_transfer` when a same-currency transfer closes a recent A→…→A path. The signal neither rejects an otherwise valid distinct-entity transaction nor modifies authority. Dead outbox delivery is recovered only through the owner-reviewed `pnpm outbox retry` workflow in `operations.md`, which preserves the original event/message identity and attempt count.

See ADR 0014 for the productive-commerce decision and `operations.md` for scheduler, mismatch, and restore procedures.
