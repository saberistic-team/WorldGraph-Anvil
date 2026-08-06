# Milestone 11 compatibility handoff — complete and sealed

Milestone 11 is complete and sealed as of August 5, 2026 EDT for the evidence in [`11-geography-visual-plan-webgl-state.md`](./11-geography-visual-plan-webgl-state.md). This handoff authorizes Milestone 12; later milestones remain sequentially gated by their immediate predecessor.

The compatibility head is API v1; contract/runtime 11; native compiler `1.4.0` with artifact schema 5, geography seed-plan schema 1, visual scene-plan schema 1, style kit 1, and asset catalog schema 1; economy seed-plan schema 2 and governance seed-plan schema 1 retained; economy reconciliation schema 3 with schemas 2 and 1 retained; exact retained compiler `1.3.0`/artifact 4, `1.2.0`/artifact 3, `1.1.0`/artifact 2, and `1.0.0`/artifact 1 verification; governance/policy schemas 1; and simulation process registry 3 with schedule/process/action/PRNG schemas unchanged at 1.

The sealed native golden is:

- manifest `3f6aa7ff355d2d9e4281bbdc52409809bf9f848274e8949fb5fd7fb314553dfd`;
- compiler input `df7f0ee9423b8e4665e88c0653ff45ff2d0ac6f352d71424a4e9b88ca97264a9`;
- artifact `881444dac7977b6fc7aafec03f90b6d3ffd135d3dd10b7b8f36adff16e1720f1`;
- economy seed plan `69ac34721c356be82eb6693620f6cdadb7ec973d128e732ed99a9ee55cf3ef8b`;
- governance seed plan `f468a3eb92a853e30a5d708e4e31128c6830f791477e2d82f20efdab9ed3d93a`;
- geography seed plan `ed2b5d4d31826a32d153c5957090f1fa901ec53ccfcce9f9e9af9e64d4f612f3`; and
- 43,037 canonical bytes, 43 entities, 50 relationships, and 3 controllers.

The migration head is `0015_geography_visual_scene`, journal index 14, SHA-256 `a18243a50606c50c9d8779ee16d744f3aff7acc1a1e88bd20d203f4503e6bb7b`. Exact `0014`→`0015` upgrades create empty geography structures only and never invent spatial or scene-plan rows.

Implemented M11 state includes PostGIS territories/districts/parcels/roads/buildings/POIs/spawns; immutable visual scene plans; allowlisted placeholder assets; creator initialize/publish routes; bounded member reads; outbox geography invalidations; Explore R3F with accessible 2D fallback; and ADR 0016. Geography init currently uses creator HTTP rather than the full public command-bus surface.

Acceptance evidence recorded in the canonical state includes `pnpm check` (139 unit files/989 tests), the dedicated M11 upgrade-origin 1 file/3 tests, geography API membership/bounds 2/2, world-compilation worker 11/11 (including governance lane retention and membership-writer race), and Playwright 94/94. Full aggregate `pnpm test:integration` and Compose clean/retained browser recovery were not re-run as a single seal gate and remain operational residuals.

Milestone 12 must consume every compatibility axis, migration identity, architecture/security decision, and retained risk in the canonical state. In particular, retain trusted-server ballot privacy; the P2 operator-replay finalization risk; mutable base/CI tags; deployment observability/provider hardening; managed restore/external-checkpoint work; the no-client-authority boundary for geography/visual/WebGL; and the incomplete geography command-bus/Compose re-proof items above. Multiplayer presence must not move spatial or economic authority into the client.
