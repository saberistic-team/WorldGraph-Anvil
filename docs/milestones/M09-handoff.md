# Milestone 09 compatibility handoff — complete and sealed

Milestone 09 is complete and sealed as of August 3, 2026 EDT. Its canonical record is [`09-production-businesses-jobs-markets-tax-state.md`](./09-production-businesses-jobs-markets-tax-state.md). This handoff authorizes Milestone 10; later milestones remain sequentially gated by their immediate predecessor.

The compatibility head is API v1; contract/runtime 9; native compiler `1.2.0` with artifact schema 3 and economy seed-plan schema 2; exact retained compiler `1.1.0`/artifact 2/plan 1 and compiler `1.0.0`/artifact 1 verification; core M08 economy schemas 1; productive-commerce schemas 1; economy reconciliation 2 with schema 1 retained; and simulation process registry 2 with schedule/process/PRNG schemas unchanged.

The sealed native golden is:

- manifest `6452e612ab13f43c9513824fa36dfca6a28303909e0215da1c787cd63d1edc6c`;
- compiler input `0cf5b43c2a0b09d75aae17b5dd622113e27103843392e17a2a8b64833eb4e837`;
- artifact `fa53687f451201d80cc4cab4615eed98403341cfd55177158add05579ab22f92`;
- economy seed plan `eff8f07bac7bc63354bd43e0f7607427aece39429cecfe2de3edd70eea6eb6d9`; and
- 34,753 canonical bytes, 41 entities, 46 relationships, and 2 controllers.

The migration head is `0012_commerce_reconciliation_integrity`, journal index 11. The frozen M09 migration SHA-256 values are:

- `0010_production_business_market_tax`: `6cb7ba473224fc08ad306771db8096aa4f649c28910619144c971f05d91524e4`;
- `0011_commerce_projection_repair`: `9b1923c5ccabe62abb1502f7a525f0052bd7c3e015b0ec41aa1bb7833fa7c3b6`; and
- `0012_commerce_reconciliation_integrity`: `f46f1c39b0e5e8365a7175c96fc72d72e7e0243d7d6e1a010aa31f1aa539aced`.

Fresh, exact sealed-M08 upgrade, populated `0011`→`0012`, repeat, and rollback behavior ran against PostgreSQL. The dedicated exact-origin suite preserves the active compiler-1.1/artifact-2/plan-1 world and every M08 authority/checksum without synthesizing M09 state, then compiles and runs the native plan-2 harbor demo on that same upgraded database. No migration upcasts old bytes or invents productive-commerce intent.

Implemented M09 state includes deterministic productive commerce; complete manager/worker/buyer browser controls; compile-time and database tax-scope exclusion; hardened replay and schema-2 reconciliation authority; owner-only audited economy repair and dead-outbox retry; durable rate scopes and abuse signals; bounded command observability; and internal durable-outbox-to-Redis invalidation. pg-pool idle and checked-out client errors are observed systemically across API and worker so PostgreSQL loss degrades and recovers without an unhandled Node.js client error. A browser-authorized realtime gateway remains intentionally outside M09.

Final acceptance evidence is `pnpm check` with 111 unit files/734 tests, all 16 typechecks and builds, migration/golden/CLI gates; 22 integration files/228 tests; the dedicated upgrade-origin file/12 tests; Playwright 82/82; and two definitive production-image Compose browser/recovery passes, first on clean volumes and then retained data. Both Compose runs exercised Redis and PostgreSQL recovery while the same API and worker processes remained healthy.

Supply-chain review found zero high/critical advisories at the high gate and zero advisories of any severity in the 241-package production graph. The full development graph retains one moderate esbuild `0.18.20` advisory and one low esbuild `0.27.7` advisory. The clean inventory found 11 license groups, no missing license, and no GPL-3.0/AGPL-3.0 package; LGPL and CC obligations remain. API, migrate, worker, and web run as `node` UID/GID 1000 in `/app`, each with the same 46 rootfs layers and separate local attestation manifest identifiers beginning `api:60f40e`, `migrate:6528aa`, `worker:b642ef`, and `web:3abb7c`. This does not claim immutable base/CI digest pinning or a container CVE scan.

Milestone 10 must consume every compatibility axis, migration identity, architecture/security decision, and retained risk in the canonical state. In particular, retain the P2 operator-replay finalization risk: a database outage can leave inert `pending`/`running` evidence, but it cannot authorize repair, block a new replay, or create a partial/authoritative shadow. Also retain mutable base/CI tags, broad development dependencies in runtime images, absent browser realtime gateway, deployment observability/provider hardening, managed restore/external-checkpoint work, and the no-real-money/client-authority/runtime-AI boundaries.
