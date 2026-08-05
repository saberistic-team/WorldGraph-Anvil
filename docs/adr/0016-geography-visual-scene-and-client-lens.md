# ADR 0016: Geography authority, visual scene plans, and client lens

- Status: accepted for Milestone 11
- Date: 2026-08-05

## Context

Milestones 1–10 established server-authoritative identity, compiler artifacts, command/event ledger, deterministic ticks, closed-loop economy, and governance. The scene now has stable entities worth projecting, but a WebGL client must not become authority for placement, ownership, economics, or civic outcomes.

An existing artifact `VisualPlanV1` already stores milliunit district layout as design intent. Milestone 11 needs PostGIS geography as spatial truth and a published visual scene plan derived from that committed geography.

## Decision

### Geography owns spatial truth

PostgreSQL/PostGIS stores world-scoped spatial reference, territories, districts, parcels, roads, building placements, points of interest, and spawn points in a local projected meter CRS (SRID 3857 convention for storage). Geometry is quantized to integer milli-meters, validated for bounds, containment, required non-overlap, road connectivity, and at least one reachable public spawn before publish.

Compiler `1.4.0` emits artifact schema 5 with `GeographySeedPlanV1`. Exact compiler `1.3.0`/artifact 4, `1.2.0`/artifact 3, `1.1.0`/artifact 2, and `1.0.0`/artifact 1 verification lanes remain. Migration does not invent geography for existing worlds; initialization requires the exact native provenance.

### Visual scene plan is a pure projection

`VisualScenePlanV1` is an immutable checksummed adapter from a committed geography snapshot plus style-kit version and seed. It contains only stable entity IDs, transforms, archetypes, material tokens, LOD hints, warnings, and provenance. It never encodes wallet, ownership, law, vote, production, or interaction rules. Artifact `VisualPlanV1` remains design-intent layout only and is not PostGIS authority.

### Client lens is replaceable

The React Three Fiber Explore view consumes versioned read contracts (geography bbox/layers, scene plan, spawn resolution, and existing authoritative identity/economy/governance reads). Selection invokes APIs. Client collision and camera motion are UX only. With WebGL disabled or context lost, the accessible list/2D map remains usable and server systems continue unchanged.

### Commands and reads

`InitializeWorldGeographyV1` materializes the seed plan. `PublishVisualScenePlanV1` publishes an idempotent scene plan keyed by geography version, style kit, and seed. `ResolveSpawnV1` returns a server-validated spawn. Bounded membership-authorized reads never enumerate cross-world geometry.

## Consequences

- Geography and scene-plan modules must stay free of authority decisions that belong to ledger, economy, or governance.
- Golden geography and scene-plan checksums are authoritative; pixel variation is not.
- Asset URIs are allowlisted `asset://worldgraph/...` references with recorded hashes and licenses.
- Multiplayer presence (M12) and spatial editing (M13–14) consume these IDs and plans without moving authority into the client.

## Rejected alternatives

- Treating Three.js transforms or browser localStorage as placement authority.
- Upcasting or inventing geography for pre-1.4 worlds during migration.
- Fetching arbitrary remote meshes or executing scene-embedded scripts.
- Collapsing design-intent `VisualPlanV1` and published scene plans into one mutable document.
