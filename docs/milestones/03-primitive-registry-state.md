# Milestone 03 state — Primitive registry and retrieval

Status: complete and sealed on 2026-07-21. The independent adversarial audit found no remaining critical or high Milestone 3 defect.

## Inputs consumed

- The complete M01 state and handoff: API v1, contract/runtime schema 1 at migration head `0002_platform_metadata`, modular-monolith/process boundaries, PostgreSQL/Redis authority rules, canonical JSON/hash/IDs/time/PRNG, health/telemetry/CI/Compose baseline, ADRs 0001–0006, and retained risks.
- The complete M02 state and handoff: API v1, contract/runtime schema 2 at immutable migration head `0003_identity_authority`, command/application-notification schema 1, accounts/sessions/worlds/memberships/invitations/idempotency/security audit, actor/authority evaluator, BFF/cookie/Origin/CSRF boundary, ADR 0007, exact M01→M02 upgrade evidence, and retained risks.
- The standalone Milestone 3 prompt in `docs/planning/roadmap-g-01-08.md`. No manifest, compiler, runtime entity, simulation, economy, governance, realtime, or asset capability was pulled forward.

## Outcome and implementation summary

Milestone 3 adds an authenticated closed-alpha registry of inert, schema-backed World Primitives. Authorized users can browse/filter published exact versions, inspect definitions and exact dependency locks, and run deterministic lexical/tag retrieval. Platform administrators can save validation-aware drafts, publish immutable content, deprecate without retargeting consumers, and request provider-specific reindexing through audited/idempotent commands. A reviewed 16-kind city-state catalog makes the flow useful with semantic indexing disabled.

The implementation adds:

- `packages/catalog`: schema-1 meta-validation, strict SemVer/ranges, safe local JSON Schema/default validation, dependency resolution/cycle checks, canonical content hashes, lexical documents, filter-first tag scoring, weighted RRF, provider/vector validation, deterministic local-only 1,536-dimensional feature hashing, and the reviewed locked seed catalog.
- `packages/contracts`: contract/runtime schema 3 primitive kinds, definitions/views, validation reports, cursor/list/retrieval/rank/index provenance, admin command bodies/responses, application notifications, and schema-1 queue wake payload.
- `packages/db`: Drizzle parity, forward migration `0004_primitive_registry`, starter import/bootstrap CLIs, integrity/upgrade/retrieval/seed tests, and least-privilege runtime state.
- `apps/api`: primitive repository/service/routes, read/admin authority actions, HMAC filter-bound cursors, exact bounded snapshot retrieval, command/idempotency/audit flow, durable index intent, validated best-effort wake adapter, safe errors, abuse limits, and low-cardinality telemetry.
- `apps/worker`: PostgreSQL-authoritative indexing repository/reconciler, bounded provider/cache/retry/dead/stale/disabled handling, deep bounded startup discovery, BullMQ wake validation/coalescing, PostgreSQL+Redis readiness, sanitized terminal notifications, dependency-loss recovery, telemetry, and graceful shutdown.
- `apps/web`: `/primitives`, exact detail, and `/admin/primitives`; a narrow streaming BFF; URL state/cursor controls; safe text-only Markdown; validation/publish/deprecate/reindex flow; provider/index diagnostics; keyboard/dialog/focus/error behavior; responsive and accessibility coverage.
- Compose/Docker: the owner-credential one-shot bootstrap migrates and imports seeds before API/worker; the runtime image contains the bounded catalog/contract sources required by the bootstrap; production smoke checks catalog count, exact detail, lexical fallback, identity/authority, worker delivery both before and after dependency outages, and PostgreSQL/Redis loss/recovery.
- ADR 0008 plus authoring, retrieval-policy, registry-operations, API, migration, architecture, security, testing, and operations documentation.

## Compatibility and public contract state

| Axis                            | M03 state                              |
| ------------------------------- | -------------------------------------- |
| Product/API                     | WorldGraph / Anvil, API `v1` unchanged |
| Contract schema                 | `3`                                    |
| Runtime schema                  | `3`                                    |
| Primitive schema                | `1`                                    |
| Primitive index policy/schema   | `1`                                    |
| Application command schema      | `1` unchanged                          |
| Application notification schema | `1` unchanged                          |
| Primitive BullMQ wake schema    | `1`                                    |
| Manifest schema                 | `0` (not introduced)                   |
| Compiler                        | `0.0.0` (not introduced)               |

The error envelope remains schema 1. New stable domain errors include `QUERY_TOO_LARGE`, `NO_COMPATIBLE_PRIMITIVES`, `RETRIEVAL_UNAVAILABLE`, `INVALID_CURSOR`, primitive validation/version/immutability/conflict errors, and the inherited authentication/authorization/CSRF/idempotency/rate/body errors. Every response remains `no-store`.

## Registry contract and reviewed data

Primitive identity is stable family `key` plus exact strict `version`. Schema 1 supports government, election, currency, tax, resource, production recipe, terrain, district, building, organization, office, legal right, player role, visual style, simulation rule, and event template. Published definitions include bounded inert documentation, tags, compatibility, local parameter schema/defaults, dependency declarations, allowlisted behavior name, visual hints, provenance, canonical SHA-256, lifecycle, and row version.

The seed catalog publishes one `1.0.0` version for every kind:

1. `worldgraph.government.guild-council`
2. `worldgraph.election.council-ballot`
3. `worldgraph.currency.closed-loop-credits`
4. `worldgraph.tax.flat-transaction-levy`
5. `worldgraph.resource.energy`
6. `worldgraph.production-recipe.energy-reclamation`
7. `worldgraph.terrain.floating-platform`
8. `worldgraph.district.floating-mixed-use`
9. `worldgraph.building.modular-guild-hall`
10. `worldgraph.organization.guild`
11. `worldgraph.office.councillor`
12. `worldgraph.legal-right.civic-charter`
13. `worldgraph.player-role.citizen`
14. `worldgraph.visual-style.low-poly-floating-city`
15. `worldgraph.simulation-rule.discrete-city-clock`
16. `worldgraph.event-template.council-session`

Curator identity is deterministic UUID `155d9b48-4e26-5672-8854-9ff24f3262fd` and remains a disabled ordinary user. The reviewed government hash is `c065b367849253adc984cb037de346da9e2391cd4a5d468111e0c0d03776c99e`. The seed/importer rejects identity, definition hash, dependency lock, lexical document, or durable job mismatch instead of overwriting content.

The disabled-provider golden query “guild-led energy-scarce floating city with a council and closed-loop credits” returns these exact first eight keys:

1. `worldgraph.government.guild-council`
2. `worldgraph.currency.closed-loop-credits`
3. `worldgraph.resource.energy`
4. `worldgraph.district.floating-mixed-use`
5. `worldgraph.visual-style.low-poly-floating-city`
6. `worldgraph.organization.guild`
7. `worldgraph.terrain.floating-platform`
8. `worldgraph.production-recipe.energy-reclamation`

The fixed-vector fixture changes only the ordering of the middle results; filters, validity, identity, content, and exact dependency locks remain unchanged.

## Database migration and seed state

Journal head is `0004_primitive_registry`. Migrations 0001–0003 and their immutable digests are carried unchanged from M02.

| Migration                      | Purpose                                                                                          | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `0001_platform_extensions.sql` | Extension schema plus PostGIS, pgvector, citext, pgcrypto.                                       | `94c32a2681812e85a32689f2aee8bf9cb81653c3973e7530d6b406089d03ad66` |
| `0002_platform_metadata.sql`   | Public runtime compatibility metadata.                                                           | `ad2e744815621cbf66242fc0acd72f1faaa7d88c19c4991f780055c4a357e52a` |
| `0003_identity_authority.sql`  | M02 identity, world authority, idempotency, and audit.                                           | `860f0a9c0d77a5c1e0fff88b7516956ab5b900ab52659502020d91b73abf646b` |
| `0004_primitive_registry.sql`  | Immutable primitive registry, dependency/search/vector/job state, grants, and compatibility 2→3. | `f498545519e93eba894de171e565a364bdec3ded03f3674dbd8b4ec43d1c0263` |

`0004` adds `primitive_families`, `primitive_versions`, `primitive_tags`, `primitive_dependencies`, `primitive_search_documents`, `primitive_embeddings`, and `primitive_index_jobs` plus enums/functions/triggers/indexes/grants. SQL enforces strict SemVer decomposition/order, bounded/lifecycle-consistent rows, family/version identity, exact dependency-lock hash identity, provider metadata/job states, published/deprecated semantic immutability, and narrow runtime privileges. Draft derived rows can be replaced atomically; publication locks and validates them before lifecycle transition.

The exact M02→M03 upgrade preserves representative user, session, world, membership, idempotency, and audit records. The seed state after a clean bootstrap is 16 imported and then 16 unchanged on repeat. No public/world/user-authored primitive seed exists.

## Retrieval and indexing decisions

- Required retrieval is deterministic weighted lexical plus filter-first inverse-frequency tag ranking. Optional current local query vectors add a cosine channel. Weighted RRF policy is `k=60`, lexical `1`, tag `0.6`, vector `0.35`, with stable key/true SemVer/ID ties.
- Schema 1 guarantees exact fusion for at most 500 published versions in one compatible filtered scope using one repeatable-read snapshot. A larger scope fails closed as `RETRIEVAL_UNAVAILABLE/CATALOG_SCOPE_LIMIT`; no channel is silently approximated.
- Semantic provider/model/configuration must match the index profile when query vectors are enabled. Production defaults to `disabled-v1`; the only enabled M03 profile is deterministic, network-free `local-hash-1536-v1`. Disabled/failed/partial/dead/stale semantic state preserves lexical results and returns bounded warnings/error codes.
- Query vectorization is explicitly local-only in M03, so no account/world/private query data goes to an external provider. Worker provider calls receive only bounded normalized primitive index text.
- PostgreSQL owns every index intent. BullMQ messages contain only primitive version ID, content hash, index schema, provider configuration, type/version. Wake loss/duplication cannot lose or duplicate authority.
- The worker claim/retry/cache/terminal writes recheck content/lifecycle/lexical provenance and are guarded by provider/schema/content/attempt. Embeddings are fixed 1,536 finite nonzero vectors and remain derived/non-authoritative.
- `PrimitiveIndexCompleted/Failed` are runtime-validated best-effort application notifications. The production adapter explicitly discards them until an integration consumer exists; PostgreSQL job state plus sanitized logs are the operational audit trail. No fake user/system actor or premature M06 event ledger was created.

## Authority, security, privacy, and abuse state

- Read actions are explicit deny-default authority actions. Normal users see published content only; exact draft access returns 404. Every registry mutation independently requires active authentication, exact Origin, session-bound CSRF, platform-administrator authority, runtime body/contract validation, expected row version, idempotency key, and safe audit.
- Route identity is part of command request hashing. Cross-resource reuse of one key is rejected; identical successful publish/reindex replay returns the stored bounded response. Publication, audit, durable job request, and idempotency completion share a transaction. Best-effort wake failure cannot convert a committed command to 500.
- Published semantic fields, tags, dependency declarations/locks, and lexical documents reject update/delete through the application role and direct ordinary SQL. Corrections require a new SemVer; deprecation cannot retarget consumers.
- Validator and database bounds cover text/JSON bytes, depth/count/properties, regex, local refs, defaults, dependencies/cycles, normalization collisions, prototype keys, arbitrary URI schemes, raw HTML, template delimiters, SQL statement starts, controls/lone surrogates, behavior references, provider metadata/cost, and vectors. Object keys and values are inspected. No remote schema fetch or executable content is allowed.
- Markdown rendering creates text/headings/lists/code only; raw HTML, links, images, remote assets, and scriptable URL schemes never become DOM capabilities.
- The BFF allowlist is method/path exact, preserves repeated queries, forwards only safe headers/cookies, streams/counts mutation bodies through 160 KiB, and has a bounded timeout beyond the API semantic/request deadlines. API query/admin bodies remain independently bounded.
- Retrieval uses both privacy-HMAC session and coarse-network throttles. Cursors are HMAC-authenticated, bounded, and bound to normalized visibility/filters/limit. Logs/metrics do not contain raw queries, provider errors, secrets, cookies, IDs as labels, or primitive documentation.

## Observability and operations state

Metrics cover catalog queries/count state, publish validation failure, retrieval latency/results/outcome/fallback/empty state, queue notification delivery, per-provider index backlog/age/outcomes/cache/provider latency/tokens/cost, authorization, HTTP, dependencies, readiness, identity, idempotency, and inherited M01/M02 flows. Instruments bind after the OpenTelemetry SDK starts and are exporter-tested. Labels are low-cardinality. Alerts cover correctly computed backlog age, terminal/provider failures, empty retrieval, unexpected mutation, and mandatory audit-write failure. Runbooks cover catalog import/hash verification, reindex, provider rotation, stuck/expired/dead jobs, compromised content, Redis/PostgreSQL loss, and restore/forward repair.

Custom spans cover validation, command transaction, dependency resolution, publication, retrieval/vectorization/filtering/fusion, index enqueue, and index execution. API request correlation and primitive SemVer are attached where available without raw queries or primitive content. The deliberately minimal durable wake contract carries primitive-version UUID/configuration/schema rather than request-trace metadata; that bounded cross-process limitation is retained below.

API liveness remains dependency-independent. API readiness requires runtime schema 3, PostgreSQL, Redis, and current worker heartbeat. Worker readiness requires bounded PostgreSQL and Redis. Compose bootstrap must complete migration plus seed before API/worker; web waits for both healthy runtime roles.

## Commands actually run and results

Only commands actually completed are listed as passed. A transient or diagnostic failure is recorded where it materially changed the final candidate.

| Command/gate                                    | Actual result                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent adversarial audit                   | Final blocker-only pass: no critical/high defect. Focused final audit verification passed 9 files and 67/67 tests plus catalog/config/observability/API/worker typechecks, scoped lint/format, Compose configuration parsing, and all reported SQL bypass probes.                                                                                                                                                      |
| `pnpm check`                                    | Passed on the hardened candidate: repository format/lint, all 9 package typechecks, 25 files and 118/118 unit tests, journal head `0004_primitive_registry`, and all 9 production builds including Next.js. The pinned package-manager shim first failed closed when registry signatures were unreachable; the unchanged escalated verification succeeded.                                                             |
| `pnpm test:integration`                         | Passed: 6 files and 31/31 real PostgreSQL/Redis tests. This includes fresh and exact M02 upgrade, 12 migration checks, seed idempotency/hash mismatch, registry constraints and retrieval, API authorization/immutable command lifecycle, worker indexing/retry/recovery, identity authority, and smoke queue delivery.                                                                                                |
| `pnpm test:e2e`                                 | Passed: 38/38 Playwright tests across Chromium desktop and 320-pixel mobile, including axe/keyboard/focus, browse/filter/search/detail/degraded/empty/error states, normal-user denial, and administrator invalid dependency through publication/immutability/deprecation/reindex.                                                                                                                                     |
| Dependency audit and license inventory          | `pnpm audit --audit-level high` passed with 0 critical/high; retained advisories are 2 moderate and 1 low. Inventory found no AGPL/GPL dependency; four MPL-2.0, one LGPL-3-or-later binary, one CC-BY-4.0 data package, and other permissive licenses require normal notice/redistribution handling.                                                                                                                  |
| Clean Compose bootstrap and idempotent seed     | Passed from removed volumes and freshly built images. Bootstrap reported migration head `0004`, then `imported=16 unchanged=0`; immediate repeat reported `imported=0 unchanged=16`. Supply-chain policy checked all 687 lock entries during the clean image build. API and worker execute as UID/GID 1000 (`node`).                                                                                                   |
| Compose identity/registry/outage/recovery smoke | Final tightened pass: exact reviewed catalog/hash/retrieval, two-user cookie/CSRF authority and idempotency, queue delivery, Redis loss/recovery, PostgreSQL loss/recovery, and a new worker job completed after both recoveries. The first diagnostic pass exposed an unhandled idle PostgreSQL pool error; the worker listener and post-recovery proof were added, then every long-running service remained healthy. |

## Architecture decisions and deviations

- ADRs 0001–0007 remain in force. ADR 0008 fixes immutable exact primitive versions, derived retrieval indexes, lexical authority, PostgreSQL job durability, and inert behavior references.
- Contract/runtime advance together to 3 because public registry/retrieval contracts and runtime-required tables are introduced. API v1, command schema 1, and notification schema 1 remain compatible. Primitive/index schema 1 is independent of the future manifest/compiler axes.
- True SemVer order uses an explicit database sort key and C collation; JavaScript uses code-point comparison. Locale-dependent ordering is prohibited in deterministic paths.
- The reviewed starter catalog contains a hash-bound index-policy boost only when the exact key/version/content already contains the semantic term. Future curator records inherit no kind-level or hidden seed boost.
- Optional unresolved dependencies to known families can remain explicit in a draft; required unresolved dependencies block publication. Unknown families are rejected because valid foreign-key identity does not exist.
- Exact RRF uses a documented 500-version compatible-scope invariant instead of silently approximate top-N fusion. Raising it belongs to a versioned measured retrieval policy.
- Production semantic ranking remains disabled by default. Interfaces, deterministic fixed vectors, provider failure/recovery, cost fields, side-by-side configuration IDs, and rotation path are implemented without introducing an external secret/vendor dependency.
- Application notifications remain non-authoritative in-process contracts; no outbox/event ledger was pulled forward before M06. PostgreSQL durable index jobs close the correctness gap for the only cross-process M03 workflow.

## Known risks and retained incomplete work

- No critical or high defect is known at seal. The remaining items are bounded operational/release debt rather than hidden milestone functionality.
- Outside the shared Compose configuration, API readiness compares worker heartbeat freshness/schema but not semantic provider configuration. A mismatched deployment safely falls back to lexical retrieval but can report ready while enabled-profile jobs remain undrained. Add the provider configuration to a versioned heartbeat before independent API/worker deployment.
- Built-container CI exercises the production-default disabled semantic profile. The enabled deterministic `local_hash` profile is covered by focused API/worker unit and real-database tests, but not a second Compose smoke profile.
- Cross-process enqueue/execution spans correlate by primitive-version UUID, provider configuration, and schema, not original request correlation or SemVer. The schema-1 wake payload intentionally remains minimal; use span links or transport metadata in a future observability-contract change instead of smuggling request data into authority-neutral queue state.
- The retained dependency advisories are moderate PostCSS in the pinned Next.js chain and moderate/low esbuild versions in development tooling. M03 serves only trusted static CSS and does not expose the affected development servers; continue upstream monitoring and update through reviewed lockfile changes.
- License notice/redistribution obligations for MPL-2.0 packages, the LGPL sharp-libvips binary, and CC-BY caniuse data must be represented in release notices. No copyleft application-code change was introduced.
- The custom closed-alpha identity/security surface still requires independent security review. Managed backups/PITR, restore drill, preview/production hosting, formal retention/deletion/export, and real alert routing remain release work.
- API-process-local rate limits do not coordinate horizontally; the coarse-network plus session/account design bounds a single instance only. Move enforcement to a privacy-preserving shared edge/store before multi-instance abuse exposure.
- Production semantic provider selection is intentionally disabled. Enabling one requires approved local query-vector execution, matching side-by-side worker profile, secrets/cost limits, privacy review, coverage observation, and a new operational change record.
- The schema-1 compatible-scope ceiling is 500 exact published versions. M04 may consume the reviewed catalog safely; marketplace-scale retrieval requires a versioned exact database fusion/ANN design and evidence.
- Migration 0004 is forward-only. Recovery is stopped incompatible code, restore/PITR where needed, or reviewed forward repair; no destructive automated down migration is supplied.

No manifest, prompt generation, compiler, WorldGraph runtime graph, simulation tick, economy, governance, assets, realtime transport, WebGL client, public marketplace, remote primitive source, arbitrary script, or model-provider integration was introduced.

## Inputs exported to Milestone 04

Milestone 4 inherits every M01/M02 input plus API v1, contract/runtime schema 3, primitive/index schema 1, command/notification/queue schema 1, migration head `0004_primitive_registry` and its sealed digest, the exact 16-item catalog/hashes/dependency locks, primitive read/admin APIs and UI, exact bounded retrieval/fallback/provenance, PostgreSQL job/worker recovery, ADR 0008, all final test evidence, and every retained risk above.

M04 must make manifests immutable and exact-version pinned; it may use retrieval results as untrusted design suggestions only. It must not mutate primitive versions, resolve “latest” at runtime, treat embeddings as truth, execute primitive documentation/behavior content, bypass authority/idempotency/audit, edit M01–M03 migrations, or prebuild the compiler/simulation/event ledger owned by later milestones.
