# Changelog

## Unreleased — Milestone 09 implementation (not sealed)

- Advanced native compilation to compiler `1.2.0`, artifact schema `3`, and `EconomySeedPlanV2` while retaining exact `1.1.0`/artifact-2/plan-1 and `1.0.0`/artifact-1 verification. The current Harbor golden pins manifest `6452e612ab13f43c9513824fa36dfca6a28303909e0215da1c787cd63d1edc6c`, input `0cf5b43c2a0b09d75aae17b5dd622113e27103843392e17a2a8b64833eb4e837`, artifact `fa53687f451201d80cc4cab4615eed98403341cfd55177158add05579ab22f92`, and economy plan `eff8f07bac7bc63354bd43e0f7607427aece39429cecfe2de3edd70eea6eb6d9`.
- Added fixed-point resources and inventories, immutable recipes and movements, businesses/facilities, employment/work/payroll, deterministic scheduled production, reserved fixed-price listings and partial purchases, immutable tax assessment and treasury settlement, authorized reads, web controls, safe outbox invalidations, and operational metrics/alerts.
- Added deterministic compiler validation and a PostgreSQL exclusion boundary for half-open active tax-policy windows. Policies with the same world, currency, tax type, and normalized applicability cannot overlap; periodic cadence is a term, not a distinct payer scope.
- Added schema-2 commerce reconciliation with private command-authority facts, complete production/listing/payroll/trade/tax comparison, a narrow dual-administrator inventory-projection repair, and an owner-only audited retry intent for dead outbox messages. Migration `0012_commerce_reconciliation_integrity` remains unsealed until its real-PostgreSQL clean/upgrade/runtime gates can run.
- Added an unrun 50-principal final-unit purchase race fixture. It is source-level coverage only until executed against PostgreSQL and does not seal M09; the production-shaped active-M08 retained-state upgrade fixture remains open.

## Unreleased — Milestones 06–08

- Added the serializable authoritative command/event/ledger boundary, immutable hash-chained world history, isolated replay/compare, and append-only projection repair.
- Added the PostgreSQL-authoritative integer-tick clock, deterministic scheduling/process execution, fenced worker leases, bounded failure auto-pause, and simulation replay verification.
- Advanced native compilation to compiler `1.1.0` and artifact schema `2` with a content-addressed `EconomySeedPlanV1`; retained the byte-identical compiler `1.0.0`/artifact-1 verifier. The current golden artifact is `9805d22f0395ebac67d0824f3687e2568675bb148fb0a08fe7ecd05fd92d9bdb`, its economy plan is `4d38443acb4a2c64437e6c8e4cfd1bf7369df16b896d611f881d2259c92a6743`, and the legacy artifact remains `4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`.
- Added closed-loop virtual currency, controlled wallets, exact bigint accounting, capped creator issuance, immutable assets/title, gifts and direct atomic paid transfers, authoritative-tick offer expiry, participant-private history, reconciliation, and exact dual-authority append-only compensation. No cash value, cash-out, crypto, exchange, or external payment rail was introduced.

## 0.1.0 — Milestones 01–05

- Established the deployable WorldGraph/Anvil modular monolith, identity and creator authority, immutable primitive registry, Manifest Studio, and provider-disabled deterministic manifest generation.
- Added compiler `1.0.0` with configuration/artifact/WorldGraph schema 1, byte-reproducible canonical artifacts, and atomic initial relational graph activation.
- Golden compiler output is pinned to artifact `4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`. Future semantic output changes require an explicit compiler/config version change, changelog entry, and ADR.
