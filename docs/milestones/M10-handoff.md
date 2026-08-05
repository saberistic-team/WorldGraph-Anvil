# Milestone 10 compatibility handoff — complete and sealed

Milestone 10 is complete and sealed as of August 5, 2026 EDT. Its canonical record is [`10-governance-laws-proposals-voting-elections-state.md`](./10-governance-laws-proposals-voting-elections-state.md). This handoff authorizes Milestone 11; later milestones remain sequentially gated by their immediate predecessor.

The compatibility head is API v1; contract/runtime 10; native compiler `1.3.0` with artifact schema 4, economy seed-plan schema 2, and governance seed-plan schema 1; economy reconciliation schema 3 with schemas 2 and 1 retained; exact retained compiler `1.2.0`/artifact 3/plan 2, `1.1.0`/artifact 2/plan 1, and `1.0.0`/artifact 1 verification; governance/policy schemas 1; proposal tally `proposal_yes_no_v1` and election tally `election_plurality_v1`; and simulation process registry 3 with schedule/process/action/PRNG schemas unchanged at 1.

The sealed native golden is:

- manifest `3f6aa7ff355d2d9e4281bbdc52409809bf9f848274e8949fb5fd7fb314553dfd`;
- compiler input `9816d6bbedd0880e58e4d893dd78af7955b9a442d5986437ede8a2ec264e62f3`;
- artifact `f900d58b08dd07b4a04dc3d35295c9d72243f2124d012a7b890c1e57734429dd`;
- economy seed plan `69ac34721c356be82eb6693620f6cdadb7ec973d128e732ed99a9ee55cf3ef8b`;
- governance seed plan `f468a3eb92a853e30a5d708e4e31128c6830f791477e2d82f20efdab9ed3d93a`; and
- 39,935 canonical bytes, 43 entities, 50 relationships, and 3 controllers.

The migration head is `0014_governance_read_capabilities`, journal index 13. The frozen M10 migration SHA-256 values are:

- `0013_governance_laws_elections`: `de9e3476f807c18301d4bcab05210e849129b9fd6ee2f225de7a500fce88fd46`; and
- `0014_governance_read_capabilities`: `c589912323b150085a1f2b4f9dcdba55b16921c56525c73278e3f312a9eaa99b`.

Fresh, exact populated `0012`→`0014`, exact `0013`→`0014`, repeat, and rollback behavior ran against PostgreSQL. The dedicated exact-origin suite preserves prior authority without synthesizing governance state for existing worlds, then compiles and runs the native compiler-1.3/artifact-4/governance-plan-1 harbor journey on that same upgraded database. No migration invents a charter, law, office, contest, ballot, term, override, or repair.

Implemented M10 state includes schema-defined charter/institutions/laws/offices; public and secret ballots with separated storage; deterministic open/close/tally/certify schedules; typed proposal enactment or safe passed-but-unenacted compensation; civic appointment/removal; append-only recount/repair and explicit creator/admin overrides; authorized capability discovery; Govern UI; and authorized resumable governance SSE invalidation. ADR 0015 records the authority, privacy, tally, and enactment boundary. Secret ballots remain trusted-server privacy, not a cryptographic election protocol.

Final acceptance evidence is `pnpm check` with 138 unit files/984 tests, all 18 typechecks and builds, migration/golden/CLI gates; 28 integration files/252 tests; the dedicated M10 upgrade-origin 2 files/2 tests (plus retained M09 upgrade-origin 1 file/12 tests); Playwright 92/92; and two definitive production-image Compose browser/recovery passes, first on clean volumes and then retained data. Both Compose runs exercised Redis and PostgreSQL recovery while the same API and worker processes remained healthy.

Supply-chain review found zero high/critical advisories at the high gate and zero advisories of any severity in the production graph after patched transitive overrides for `fast-uri`, `undici`, `brace-expansion`, and `postcss`. The full development graph retains one moderate esbuild `0.18.20` advisory and one low esbuild `0.27.7` advisory. The clean inventory found 7 license groups across 183 package rows, no missing license, and no GPL-3.0/AGPL-3.0 package; LGPL and CC obligations remain. API, worker, and web run as `node` UID/GID 1000; local images reported 8/8/8 rootfs layers for api/worker/web and 9 for migrate. This does not claim immutable base/CI digest pinning or a container CVE scan.

Milestone 11 must consume every compatibility axis, migration identity, architecture/security decision, and retained risk in the canonical state. In particular, retain trusted-server ballot privacy limits; the P2 operator-replay finalization risk; mutable base/CI tags; deployment observability/provider hardening; managed restore/external-checkpoint work; and the no-client-authority boundary for geography/visual/WebGL work. Geography and Visual Plan may project stable entities but cannot move authority, physics, simulation, governance, economy, or visibility decisions into the client.
