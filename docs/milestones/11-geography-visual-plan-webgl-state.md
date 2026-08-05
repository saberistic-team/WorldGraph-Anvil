# Milestone 11 — Geography, Visual Plan, and Basic WebGL World

Status: **complete and sealed on August 5, 2026 EDT** for the evidence recorded below. Full PostgreSQL/Redis integration and Compose browser/recovery were not re-run as a single aggregate gate in this seal window; the focused M11 upgrade-origin suite, `pnpm check`, and Playwright (including Explore) did pass. This record authorizes Milestone 12 with the cumulative compatibility state, architecture decisions, and retained risks below as mandatory inputs.

## Inputs consumed

- The complete sealed M01–M10 state records and handoffs, including API v1; PostgreSQL authority; Redis wake-only coordination; identity/membership/controller authority; immutable primitives/manifests; deterministic compiler/activation; command/event/ledger/replay; deterministic ticks/schedules/fencing; closed-loop wallets/title; productive commerce/tax/treasury; governance/laws/elections; and every retained security, deployment, recovery, and supply-chain risk.
- M10 compatibility: contract/runtime 10; compiler `1.3.0`/artifact 4/governance plan 1 with exact retained lanes; economy reconciliation schema 3; journal head `0014`; ADRs 0001–0015.
- The standalone M11 prompt and acceptance criteria in `docs/planning/roadmap-g-09-16-h-j.md`, ADR 0016, and the audit-gap plan that reconciled sealed-head documentation before implementation.

## Outcome and implementation

WorldGraph now has PostGIS-authoritative city geography and a replaceable visual scene plan / WebGL Explore lens. Compiler `1.4.0` / artifact schema 5 emits `GeographySeedPlanV1` with topology-validated territory/district/parcel/road/building/POI/spawn specs in local meters. Artifact `VisualPlanV1` remains design-intent milliunit layout only. Creators initialize geography from the native seed plan and publish an idempotent `VisualScenePlanV1` keyed by geography version, style kit, compiler version, and seed. Members read bounded bbox snapshots, spatial entities, spawn points, and the published scene plan. The Explore UI offers an accessible 2D list/SVG map plus an optional React Three Fiber canvas with WebGL disable and context-loss fallback. Selection inspects server facts only; Three.js never decides ownership, economy, law, or spawn authority.

Durable outbox messages `GeographyInvalidationV1` carry Redis invalidations `geography.version.published` and `visual-plan.published` (cursor/version/checksum only). Geography creator HTTP routes are CSRF-protected; full command-bus ledger envelopes for geography remain a retained hardening item.

No LLM, natural-language spatial editor, photorealism, physics, interiors, multiplayer presence, or client-authoritative placement was introduced.

## Compatibility and deterministic artifacts

| Axis                                           | M11 value                                        |
| ---------------------------------------------- | ------------------------------------------------ |
| API                                            | `v1`, unchanged                                  |
| Contract/runtime                               | `11` / `11`                                      |
| Native compiler/artifact                       | `1.4.0` / `5`                                    |
| Retained compiler lanes                        | exact `1.3.0`/4, `1.2.0`/3, `1.1.0`/2, `1.0.0`/1 |
| Geography seed / schema                        | `1` / `1`                                        |
| Visual scene plan / style kit / asset catalog  | `1` / `1` / `1`                                  |
| Economy seed plan                              | `2`, unchanged                                   |
| Economy reconciliation                         | `3` (`2`, `1` retained)                          |
| Governance seed/schema/policy                  | `1`, unchanged                                   |
| Simulation process registry                    | `3`, unchanged                                   |
| Command/event/ledger/projection/outbox/history | `1`, unchanged                                   |

The native Harbor golden is:

- manifest `3f6aa7ff355d2d9e4281bbdc52409809bf9f848274e8949fb5fd7fb314553dfd`;
- compiler input `df7f0ee9423b8e4665e88c0653ff45ff2d0ac6f352d71424a4e9b88ca97264a9`;
- artifact `881444dac7977b6fc7aafec03f90b6d3ffd135d3dd10b7b8f36adff16e1720f1`;
- economy plan `69ac34721c356be82eb6693620f6cdadb7ec973d128e732ed99a9ee55cf3ef8b`;
- governance plan `f468a3eb92a853e30a5d708e4e31128c6830f791477e2d82f20efdab9ed3d93a`;
- geography plan `ed2b5d4d31826a32d153c5957090f1fa901ec53ccfcce9f9e9af9e64d4f612f3`; and
- 43,037 canonical bytes, 43 entities, 50 relationships, and 3 controllers.

## Migrations

Journal head `0015_geography_visual_scene`, index 14. Frozen SHA-256:

- `0015_geography_visual_scene`: `a18243a50606c50c9d8779ee16d744f3aff7acc1a1e88bd20d203f4503e6bb7b`.

Exact sealed M10 (`0014`) upgrades advance metadata to contract/runtime 11 and compiler `1.4.0`/artifact 5 without inventing geography or scene plans. Fresh installs create PostGIS tables, GiST indexes, immutable scene-plan storage, and a four-entry placeholder asset catalog.

## Architecture decisions and deviations

- ADR 0016: PostGIS is spatial authority; scene plan and R3F are replaceable projection; inspector uses authorized APIs only.
- Creator HTTP initialize/publish routes implement the vertical slice; they are not yet registered on the full public command bus with sealed domain-event envelopes (retained hardening).
- Outbox invalidations use `GeographyInvalidationV1` without a domain-event FK, dispatched by the outbox worker onto Redis channel `worldgraph:geography:v1:world:<worldId>`.

## Actual verification evidence

| Gate                                                 | Result                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                         | **PASS.** Format, lint, typecheck, golden (5 lanes), 139 unit files / 989 tests, migration journal head `0015`, production builds, offline compiler CLI identity. |
| Focused M11 upgrade-origin (`pnpm test:m11-upgrade`) | **PASS.** 1 file / 3 tests: fresh geography surface, exact `0014`→`0015` empty geography, invalid-geometry + scene-plan immutability.                             |
| Playwright                                           | **PASS.** 94/94 including Explore desktop and 320-pixel mobile (list/map, inspector, WebGL toggle, axe).                                                          |
| Full `pnpm test:integration`                         | Not claimed in this seal window; focused geography upgrade-origin is the recorded M11 database gate.                                                              |
| Compose clean/retained browser/recovery              | Not re-run in this seal window; retained as operational residual before claiming production-image parity for Explore.                                             |

## Retained risks

- Trusted-server ballot privacy (from M10).
- P2 operator-replay finalizer after database loss (from M09/M10).
- Mutable base/CI tags; deployment observability/PITR drills.
- No-client-authority boundary for WebGL (enforced in Explore; must remain for M12+).
- Geography creator routes lack full command-bus/event-envelope parity.
- Aggregate integration + Compose Explore recovery not re-proven in this seal window.

## Authorization

Milestone 12 (multiplayer presence/chat) is authorized only after consuming this record. Later milestones remain sequentially gated.
