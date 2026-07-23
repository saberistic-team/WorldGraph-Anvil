# Milestone 09 compatibility handoff — blocked, not sealed

Milestone 09 is implemented at source level but **not sealed**. Its cumulative record is [`09-production-businesses-jobs-markets-tax-state.md`](./09-production-businesses-jobs-markets-tax-state.md). This pointer does not authorize Milestone 10.

The implemented compatibility head is API v1; contract/runtime 9; native compiler `1.2.0` with artifact schema 3 and economy seed-plan schema 2; exact retained compiler `1.1.0`/artifact 2/plan 1 and compiler `1.0.0`/artifact 1 verification; core M08 economy schemas 1; productive-commerce schemas 1; economy reconciliation 2 with schema 1 retained; and simulation process registry 2 with schedule/process/PRNG schemas unchanged.

The verified native golden is:

- manifest `6452e612ab13f43c9513824fa36dfca6a28303909e0215da1c787cd63d1edc6c`;
- compiler input `0cf5b43c2a0b09d75aae17b5dd622113e27103843392e17a2a8b64833eb4e837`;
- artifact `fa53687f451201d80cc4cab4615eed98403341cfd55177158add05579ab22f92`;
- economy seed plan `eff8f07bac7bc63354bd43e0f7607427aece39429cecfe2de3edd70eea6eb6d9`; and
- 34,753 canonical bytes, 41 entities, 46 relationships, and 2 controllers.

The migration head is `0012_commerce_reconciliation_integrity`, journal index 11, SHA-256 `44de5f5ee34430d32b5b6866f4469dc7e843293f378490b935ca7f80295a4709`. The preceding M09 migrations remain `0010` at `24b68fd1789c303f937c01dcc5e15c238c253e0fdd6391cac1c9c5f691bb8f75` and `0011` at `9b1923c5ccabe62abb1502f7a525f0052bd7c3e015b0ec41aa1bb7833fa7c3b6`. Static journal integrity passed; fresh, exact-upgrade, repeat, and rollback runtime behavior has not been exercised against PostgreSQL. This checksum was deliberately refrozen before M09 shipment or seal after acceptance review found the missing identical-scope tax-policy overlap invariant; it is not precedent for editing an applied migration.

Implemented M09 state includes deterministic productive commerce, full browser controls for business/facility/employment/work/production/listing/purchase actions, compile-time and database enforcement of non-overlapping active tax-policy scopes, hardened replay and reconciliation authority, owner-only audited dead-outbox retry, durable commerce rate scopes and abuse signals, and bounded command observability. A browser-authorized realtime gateway remains intentionally outside M09; internal durable-outbox-to-Redis invalidation is present.

Acceptance is blocked. Broad unit verification reached 107/108 files and 717/718 tests; the lone compiler timeout passed 3/3 in isolation and was corrected, but the aggregate suite was not rerun. Integration files typechecked/linted and the pre-disruption migration/economy additions were collected; the final abuse-signal addition could not be recollected after the executable links disappeared. The tax-scope scenarios and corrected 50-independent-buyer final-unit race were added afterward and remain unrun. A reviewed production-shaped active-M08 preservation fixture is still missing, as is the required new plan-2 harbor demo on that same upgraded database. Live PostgreSQL/Redis, Compose, browser/accessibility, and fresh/upgrade migration gates remain unrun. The supply-chain review is incomplete, and the workspace dependency tree is unusable after a frozen offline install stopped on a missing cached `@axe-core/playwright` tarball; source and lockfile were unchanged.

Milestone 10 remains locked until every required M09 acceptance and definition-of-done gate actually passes and the canonical record is marked complete and sealed. A formally approved design deviation may amend scope, but unavailable or unrun migrations, demos, regressions, security, browser, or supply-chain checks cannot be dispositioned into passes.
