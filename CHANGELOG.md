# Changelog

## Unreleased — Milestone 09 (sealed August 3, 2026 EDT)

- Advanced native compilation to compiler `1.2.0`, artifact schema `3`, and `EconomySeedPlanV2` while retaining exact `1.1.0`/artifact-2/plan-1 and `1.0.0`/artifact-1 verification. The current Harbor golden pins manifest `6452e612ab13f43c9513824fa36dfca6a28303909e0215da1c787cd63d1edc6c`, input `0cf5b43c2a0b09d75aae17b5dd622113e27103843392e17a2a8b64833eb4e837`, artifact `fa53687f451201d80cc4cab4615eed98403341cfd55177158add05579ab22f92`, and economy plan `eff8f07bac7bc63354bd43e0f7607427aece39429cecfe2de3edd70eea6eb6d9`.
- Added fixed-point resources and inventories, immutable recipes and movements, businesses/facilities, employment/work/payroll, deterministic scheduled production, reserved fixed-price listings and partial purchases, immutable tax assessment and treasury settlement, authorized reads, web controls, safe outbox invalidations, and operational metrics/alerts.
- Added deterministic compiler validation and a PostgreSQL exclusion boundary for half-open active tax-policy windows. Policies with the same world, currency, tax type, and normalized applicability cannot overlap; periodic cadence is a term, not a distinct payer scope.
- Added schema-2 commerce reconciliation with private command-authority facts, complete production/listing/payroll/trade/tax comparison, a narrow dual-administrator inventory-projection repair, and an owner-only audited retry intent for dead outbox messages. Frozen migrations are `0010` `6cb7ba473224fc08ad306771db8096aa4f649c28910619144c971f05d91524e4`, `0011` `9b1923c5ccabe62abb1502f7a525f0052bd7c3e015b0ec41aa1bb7833fa7c3b6`, and journal head `0012` `f46f1c39b0e5e8365a7175c96fc72d72e7e0243d7d6e1a010aa31f1aa539aced`.
- Added systemic idle and checked-out PostgreSQL pool-client error observation for API and worker after retained-load outage testing exposed an unhandled client error. Bounded code-only logging and definitive clean/retained recovery drills prove Redis/PostgreSQL recovery without replacing either process.
- Sealed M09 after `pnpm check` passed 111 unit files/734 tests and all 16 typechecks/builds plus journal/golden/CLI gates; PostgreSQL/Redis integration passed 22 files/228 tests; the production-shaped exact-M08 upgrade-origin gate passed 1 file/12 tests; Playwright passed 82/82; and both clean-volume and retained-data two-session browser Compose journeys passed dependency recovery.
- Supply-chain review found zero high/critical advisories at the high gate, zero advisories in the 241-package production graph, 11 complete license groups without GPL-3.0/AGPL-3.0, and retained development-only esbuild moderate/low advisories plus LGPL/CC obligations. Local non-root image/layer/attestation inspection does not claim immutable base/CI digest pinning or container CVE scanning.
- Retained P2: a database outage can leave inert pending/running operator-replay evidence, but it cannot authorize repair, block a new replay, or create a partial/authoritative shadow; finalizer hardening is deferred.

## Unreleased — Milestones 06–08

- Added the serializable authoritative command/event/ledger boundary, immutable hash-chained world history, isolated replay/compare, and append-only projection repair.
- Added the PostgreSQL-authoritative integer-tick clock, deterministic scheduling/process execution, fenced worker leases, bounded failure auto-pause, and simulation replay verification.
- Advanced native compilation to compiler `1.1.0` and artifact schema `2` with a content-addressed `EconomySeedPlanV1`; retained the byte-identical compiler `1.0.0`/artifact-1 verifier. The current golden artifact is `9805d22f0395ebac67d0824f3687e2568675bb148fb0a08fe7ecd05fd92d9bdb`, its economy plan is `4d38443acb4a2c64437e6c8e4cfd1bf7369df16b896d611f881d2259c92a6743`, and the legacy artifact remains `4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`.
- Added closed-loop virtual currency, controlled wallets, exact bigint accounting, capped creator issuance, immutable assets/title, gifts and direct atomic paid transfers, authoritative-tick offer expiry, participant-private history, reconciliation, and exact dual-authority append-only compensation. No cash value, cash-out, crypto, exchange, or external payment rail was introduced.

## 0.1.0 — Milestones 01–05

- Established the deployable WorldGraph/Anvil modular monolith, identity and creator authority, immutable primitive registry, Manifest Studio, and provider-disabled deterministic manifest generation.
- Added compiler `1.0.0` with configuration/artifact/WorldGraph schema 1, byte-reproducible canonical artifacts, and atomic initial relational graph activation.
- Golden compiler output is pinned to artifact `4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`. Future semantic output changes require an explicit compiler/config version change, changelog entry, and ADR.
