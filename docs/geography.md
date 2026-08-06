# Geography and visual scene plans

Milestone 11 adds PostGIS-authoritative city geography and a replaceable visual scene plan / WebGL lens. ADR 0016 records the boundary.

## Authority

- PostgreSQL/PostGIS owns territories, districts, parcels, roads, building placements, points of interest, and spawn points in local projected meters (SRID 3857 storage convention).
- Compiler `1.4.0` / artifact schema 5 emits `GeographySeedPlanV1`. Exact `1.3.0`/4, `1.2.0`/3, `1.1.0`/2, and `1.0.0`/1 lanes remain.
- Artifact `VisualPlanV1` remains design-intent milliunit layout only.
- `VisualScenePlanV1` is an immutable checksummed projection from committed geography plus style kit and seed. It never encodes economy, governance, or ownership rules.
- React Three Fiber Explore is a replaceable lens. Selection invokes authorized APIs. With WebGL disabled or context lost, the 2D list/map remains usable.
- App-role readers must call PostGIS as `extensions.ST_*` / `OPERATOR(extensions.&&)` because `worldgraph_app` keeps `extensions` off the default `search_path`.

## Initialization

1. Compile/activate a native compiler-1.4/artifact-5 world.
2. Creator calls `POST /api/v1/worlds/:id/geography/initialize` to materialize the seed plan.
3. Creator calls `POST /api/v1/worlds/:id/geography/visual-scene-plan` to publish the scene plan.
4. Members read `GET /geography`, `/visual-scene-plan`, `/spawn-points`, and `POST /spawn-points/resolve`.

Migration `0015` never invents geography for existing worlds.

## Assets

Placeholder low-poly kit entries live in `visual_asset_catalog` with `asset://worldgraph/...` URIs, content hashes, CC0-1.0 licenses, and byte budgets. Arbitrary remote URLs are rejected.

## Operations runbooks

| Symptom                        | First checks                                                       | Safe action                                                                           |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `PLAN_NOT_READY` after compile | World is active; artifact schema is 5; creator initialize ran once | Re-run initialize with the exact native seed-plan hash; do not invent geometry        |
| Publish checksum mismatch      | Style kit 1, compiler `1.4.0`, seed, and geography version tuple   | Re-publish only; scene plans are append-only/immutable                                |
| Missing active spawn           | `spawn_points` for the geography version                           | Fix seed plan / re-initialize on a new world version; never hand-edit production rows |
| Spatial query saturation       | Bbox size, layer filters, row counts                               | Tighten bbox/layers; alert if endpoints approach the hard feature caps                |
| Bad asset / CSP failure        | Catalog URI must be `asset://worldgraph/...`                       | Disable the catalog entry; Explore falls back to list/map                             |
| WebGL context loss             | Client-only                                                        | Keep 2D/list Explore; server geography/economy/governance continue unchanged          |

## Related docs

- ADR 0016
- `docs/compiler-worldgraph.md`
- `docs/api.md`
- `docs/milestones/11-geography-visual-plan-webgl-state.md`
