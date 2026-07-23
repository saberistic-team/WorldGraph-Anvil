# Milestone 05 state — Deterministic compiler and WorldGraph seeding

Status: **sealed and complete**. Milestone 06 is authorized to consume the exact implementation, migration head, compatibility axes, golden identities, release evidence, decisions, and retained risks recorded here.

## Inputs consumed

- The complete sealed M01 state: API v1, contract/runtime schema 1, deployable web/API/worker/PostgreSQL/Redis shell, deterministic utilities, canonical JSON, health/telemetry/CI/Compose baseline, forward-migration discipline, and ADRs 0001–0006.
- The complete sealed M02 state: contract/runtime schema 2, identity/session/world membership and creator/platform authority, Origin/CSRF/BFF boundary, durable idempotency/audit foundations, application notifications, migration `0003_identity_authority`, ADR 0007, and retained identity/operations risks.
- The complete sealed M03 state: contract/runtime schema 3, primitive/index schema 1, migration `0004_primitive_registry`, exact reviewed 16-item catalog and dependency locks, deterministic bounded retrieval, PostgreSQL-authoritative worker recovery, ADR 0008, and all retained registry/security/operations risks.
- The complete sealed M04 state: contract/runtime schema 4, immutable Manifest v1 revisions/reports/provenance, latest-only creator approval, migration `0005_manifest_studio` and sealed digest, deterministic fallback fixture and hashes, durable generation/cancellation/provider accounting, Manifest Studio UI/API, ADR 0009, and every retained risk.
- The standalone M05 prompt in `docs/planning/roadmap-g-01-08.md`. Runtime mutation/ledger, simulation, economy, governance, patches, realtime, WebGL, generated media, and AI compilation were not pulled forward.

## Outcome and implementation summary

Milestone 05 introduces an explicit deterministic boundary from one approved immutable Manifest v1 plus exact primitive closure, active world-local member principals, compiler/config version, and seed to one content-addressed logical graph. Compilation is pure and side-effect-free. A separate PostgreSQL worker path revalidates the exact source identity and activates the graph in one serializable, world-locked transaction; no partial graph becomes playable.

The sealed release adds:

- `packages/contracts`: compiler input/configuration/diagnostic/artifact contracts, strict discriminated state for all 14 entity types and attributes for all 11 relationship types, runtime revision/summary/graph views, status/start/retry/cancel contracts, queue wake, and compatibility schema 5.
- `packages/compiler`: pure `resolve → validate → normalize → lower → link → emit`; exact closure and semantic input hashing; allowlisted primitive adapters; deterministic code-point ordering, logical keys, integer PRNG and visual plan; state/edge/privacy validation; shared graph semantic verifier; artifact hash verification; golden fixture; and offline CLI.
- `packages/db`: forward migration `0006_deterministic_compiler` and Drizzle mirror for durable runs/artifacts/world versions/entities/relationships/controllers/runtime heads, lifecycle/pointers, typed JSON checks, endpoint and controller-edge constraints, immutable seed/version protection, same-world composite keys, bounded indexes, and exact compatibility metadata.
- `apps/api`: creator-only start/cancel/retry with CSRF, idempotency, expected manifest identity, database serialization, feature/rate/size limits and prompt-free wakes; member-scoped current/status/diagnostic/verified-artifact/runtime/entity/relationship/neighbor reads; signed world/filter/root-bound cursors; and stable redacted errors.
- `apps/worker`: versioned wake validation plus PostgreSQL reconciliation/claim/expiry, exact source loading, compiler execution/self-verification, claim fencing, cancellation rules, private-data-free diagnostics, and atomic artifact/version/graph/controller/runtime activation with serialization retry.
- `apps/web`: creator Compile panel with pre-start version facts, refresh/current-run recovery, durable progress/cancel/retry/diagnostics; authoritative World Overview; accessible bounded graph entity/relationship/neighbor explorer; BFF allowlist and prior world/manifest navigation.
- Operations/docs: compiler/graph/version policy, CLI and activation/repair guidance, ADR 0010, versioned compiler alerts, stage/backlog/lock/retry/integrity telemetry, CI golden-version guard, and extended production Compose smoke.

## Compatibility and public contract state

| Axis                             | M05 sealed state                       |
| -------------------------------- | -------------------------------------- |
| Product/API                      | WorldGraph / Anvil, API `v1` unchanged |
| Contract schema                  | `5`                                    |
| Runtime schema                   | `5`                                    |
| Manifest schema/generator        | `1` unchanged                          |
| Primitive schema/index policy    | `1` unchanged                          |
| Compiler                         | `1.0.0`                                |
| Compiler configuration schema    | `1`                                    |
| Compiled artifact schema         | `1`                                    |
| WorldGraph schema                | `1`                                    |
| Compilation BullMQ wake schema   | `1`                                    |
| Application command/notification | `1` unchanged                          |

The API remains v1 and preserves the stable error envelope/no-store policy. M05 application notifications and queue wakes are integration signals, not retroactively fabricated M06 events. The queue contains only run/revision/input/version identifiers; PostgreSQL remains authoritative.

## Deterministic compiler and golden identity

`CompilerInputBundleV1` covers canonical Manifest bytes/hash, exact sorted primitive definitions/content hashes/lifecycle/dependency closure, sorted active world-local member principals and roles, Manifest/primitive/compiler/config versions, explicit configuration limits, and seed. `inputHash` omits its own field and hashes the canonical semantic envelope. The pure compiler cannot read environment, wall time, locale, filesystem, database, Redis, network, AI, or ambient randomness; tests spy on the ambient APIs and run isolated processes under different locale/time-zone settings.

The compiler emits sorted immutable logical records with no physical database IDs or timestamps. A shared semantic invariant pass verifies counts, unique/canonical key order, endpoint existence/type policy, strict entity state/relationship attributes, controllers and exact `account_controls` correspondence, privacy policy, wrapper/input identity, canonical bytes, and SHA-256. The CLI and artifact download use the same verifier. A rehashed but semantically corrupt artifact fails closed.

The reviewed floating-guild-city golden identity is currently:

- compiler input SHA-256 `47710bce54a581f601e76d3b246b644153d9a33a4658947ef2445823e299d639`;
- compiled artifact SHA-256 `4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`;
- canonical compiled-world byte length `23,249` UTF-8 bytes;
- 35 entities, 40 relationships and 1 controller in the one-member fixture;
- approved Manifest SHA-256 `c3074930cc920b840e1ad5e1a8d338c621476771f2aa57e0e5c47d9904760174`.

CI runs the golden check and requires a compiler/config version change plus changelog and ADR when canonical output intentionally changes. Physical UUIDv7 rows and timestamps may vary without entering semantic identity.

## Activation, graph, and authority state

- Start requires the current approved revision/hash, active creator, unactivated world, explicit seed, compiler feature enablement, bounded request, CSRF/Origin and an actor/type/request-bound idempotency key. Approval alone never compiles.
- API and worker use one fixed world advisory-lock order. Activation's first PostgreSQL statement directly takes `SHARE` locks on membership/primitive tables before the serializable snapshot and advisory lock. The pinned PostgreSQL 17 application role receives `MAINTAIN` only on those two source tables because column-scoped mutation grants cannot authorize `SHARE`; it does not receive broader row mutation.
- Immediately before seeding, activation re-reads the current approved run/revision, exact active membership principals/roles, and every exact primitive ID/lifecycle/content hash under the stabilized serializable snapshot. Any change yields sanitized nonretryable `COMPILATION_INPUT_CHANGED` and zero seed rows.
- Artifact, three content-addressed artifact kinds, world version, entities, relationships, controller bindings, runtime head, active pointer/lifecycle and terminal run status commit once in the same transaction. Serialization failures retry the entire transaction at most twice; unique/deferred constraints and claim CAS prevent duplicates.
- Cancellation is allowed only while queued/validating/compiling. Once seeding has won the world lock, cancellation waits and then observes terminal success; cancellation-first invalidates the claim so activation cannot publish.
- Account-principal logical keys contain only a world-local pseudonymous member digest. Controller rows must map the same active playable user to the exact account state, `account_controls` edge and player character. Email/session/invitation/IP/prompt/provider/credential material is rejected by deterministic input/emission/verifier privacy inspection and by private-field database checks.
- Runtime reads require active membership, apply world scoping before ID/key lookup, permit only allowlisted types/filters and one-hop neighbors, cap pages at 100, and sign cursors over world, normalized filters, root entity and direction. Entity detail/list/relationship/neighbor responses include active version and state revision metadata.

## Database migration and data state

Journal head is **`0006_deterministic_compiler`**. Migrations 0001–0005 remain byte-identical to their sealed state. The final migration 0006 SHA-256 is **`1e62ff203eb3fd700c27f7c7969ccaa14d3b9ee0bf1a593b668009b4f7f78372`** and is now forward-only; later milestones must append after it.

M05 adds the `world_compilation_status`, `world_compilation_stage`, and `world_version_status` enums; expands world lifecycle; adds the active-world pointer; and creates `world_compilation_runs`, `compiled_world_artifacts`, `world_versions`, `world_entities`, `world_relationships`, `world_entity_controllers`, and `world_runtime_heads`. Composite foreign keys and deferred checks bind revision/run/artifact/version/graph/controller/head records to the same world. Partial uniqueness permits one active version/head and one durable semantic run identity. Protection functions constrain legal transitions, immutable provenance/artifacts/seed rows, current approval, exact compiler versions, initial revisions, endpoint policy and controller-edge correspondence.

The migration advances runtime metadata from exact M04 compatibility to contract/runtime 5 and compiler/config/artifact/WorldGraph/wake versions above. It does not compile or seed an existing world automatically. The M03 16-primitive bootstrap remains the only production catalog seed; golden worlds are test/Compose service fixtures. Migration 0006 is sealed and must never be edited.

## Observability and operational state

Low-cardinality measurements cover queue latency, ready/running backlog and age, stage/run duration and outcome, artifact entity/relationship counts, activation lock wait, serialization retries and integrity findings. Spans cover enqueue, claim, validate, compile and atomic seed/activate. Structured logs carry identifiers, versions, hashes, stages and diagnostic codes but redact prompt, manifest bytes/content, entity state, provider/model data and credentials.

`deploy/alerts/deterministic-compiler-v1.rules.yml` defines eight sealed rule definitions for backlog/stuck work, failure/adapter spikes, lock wait, large artifacts, integrity/reproducibility and orphan/activation inconsistency. No dashboard deployment, paging route or continuous privileged orphan scanner is claimed. Local Compose remains responsible only for the application stack; alert loading/routing, managed backup/PITR and production restore are deployment responsibilities.

Feature controls gate compiler start and size/reconciliation bounds, never hash/schema/authority/transaction checks. Runbooks cover disable/drain/rollback compatibility, retry/cancel/expired claims, Redis wake loss, artifact verification, input changes, orphan/staging inspection, active-pointer inconsistency, PostgreSQL recovery and forward migration repair.

## Final verification evidence

All evidence below was collected on the sealed source tree after the final privacy, database, runtime-image, standalone-CLI, browser-fixture, and test-stability corrections. No skipped, planned, historical-only, or still-running result is counted.

| Check                             | Final result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregate repository gate         | Passed: Prettier; ESLint with zero warnings; all 11 package typechecks; unchanged compiler golden lock; 47 unit files with 270/270 tests; migration journal/digest check at `0006`; all 11 production builds including all 19 Next routes; and the standalone CLI release check. The unit suite has an explicit bounded 30-second per-test ceiling because schema/compiler cases measured up to 13.6 seconds under full parallel load.                                                                |
| Compiler identity and offline CLI | Golden input/artifact/count/byte identities above passed. The built `worldgraph` binary bundles its internal runtime closure and ran under plain Node in three separate processes: two compiles produced byte-identical compiler input, compiled artifact, and compiled world files; a third verified the artifact hash.                                                                                                                                                                              |
| Real PostgreSQL/Redis integration | 12 files with 80/80 tests passed. This includes 11/11 migration/database compiler checks, 10/10 worker races/faults, 4/4 API compiler/runtime/security cases, fresh/prior-head upgrade/repeat no-op, exact input changes, cancellation/serialization races, failure-depth rollback, tenant/cursor bounds, and corrupt-artifact rejection.                                                                                                                                                             |
| Production Compose                | Passed from an empty volume after building every image. The one-shot bootstrap reached exact head and imported 16 reviewed primitives; the repeat was `imported=0 unchanged=16`. Two complete smoke runs passed deterministic manifest/compile/activation/graph behavior, duplicate delivery, Redis loss/recovery, PostgreSQL loss/recovery, health, BFF, API, and worker paths.                                                                                                                      |
| Browser/accessibility             | 50/50 Playwright cases passed across Chromium desktop and exact 320-pixel mobile, including identity/authority, registry, Manifest Studio, compiler recovery/diagnostics, overview/graph traversal, keyboard behavior, uncertain states, escaped content, and axe checks.                                                                                                                                                                                                                             |
| Supply chain                      | Pinned production audit: 0 critical, 0 high, 1 moderate, 0 low/info across 171 production plus 70 optional dependencies (241 total). The moderate is PostCSS 8.4.31 through Next (`GHSA-qx2v-qp2m-jg93`, patched in 8.5.10); it is retained as an explicit dependency risk rather than hidden. License inventory: MIT 111, Apache-2.0 45, BSD-3-Clause 14, ISC 10, 0BSD 1, CC-BY-4.0 1 (`caniuse-lite` data), and LGPL-3.0-or-later 1 (Sharp's optional prebuilt dynamically linked libvips runtime). |
| Independent blocker audit         | GO after correction and rerun. The reviewer found and blocked a package-bin symlink entrypoint defect; the entrypoint now resolves the invoked path, the release harness executes through an equivalent symlink, the actual pnpm shim returns the correct nonzero result, and CI runs the harness after build. No critical/high correctness, security, determinism, privacy, migration, concurrency, packaging, or architecture blocker remains.                                                      |

## Architecture decisions and deviations

- ADRs 0001–0009 remain. ADR 0010 fixes pure content-addressed compilation, independent compiler/config/artifact/graph versions, database-only activation authority and initial-activation-only scope.
- The compiler is a package inside the modular monolith rather than a network service. The API never accepts an artifact as authority; worker output is rebuilt and verified before persistence and every download is verified again.
- Redis/BullMQ remains a disposable wake mechanism. Claim/status/input/artifact/version/graph authority and reconciliation live in PostgreSQL.
- State is strict per entity/relationship discriminator at contracts, compiler emission/verification and PostgreSQL. JSONB remains a storage representation, not an untyped extension escape hatch.
- Compiler privacy uses a deterministic bounded recursive policy over both field names and string values. Findings expose only code/pointer, never the matched value. This deliberately rejects obvious email, Unicode email, IP, credential/session/invitation/prompt/provider payload patterns even inside otherwise schema-valid descriptive fields; only an exact lowercase 64-hex `promptHash` provenance field is allowed.
- The shared artifact verifier requires exact entity, relationship, controller and `account_controls` completeness—not only shape, counts and hashes. Initial successful activation requires one exact account/character/controller/control-edge set for every active playable membership, excludes observers, and binds the same pseudonymous principal throughout. Membership changes after activation intentionally create no graph rows in M05.
- Compilation over an active version is forbidden. A later approved Manifest is inert intent; M13 will introduce reviewed versioned patches rather than misusing initial compilation.
- Version 1 activation uses one transaction because the bounded graph limit fits the documented database budget. A future measured scale limit may require a staged namespace plus atomic publication pointer without changing artifact identity.
- The API and worker currently share the application database role inherited from earlier milestones. The world advisory helper is fixed and PUBLIC-revoked; direct source locking uses PostgreSQL 17 `MAINTAIN` on two tables so `LOCK TABLE` can be the first serializable statement. This also permits maintenance/locking operations if that credential is compromised, so production should split worker credentials; no client route exposes raw compiler seed authority.
- The `worldgraph` binary bundles its complete required runtime closure, so plain Node can execute the documented offline CLI without following workspace TypeScript exports. Runtime images copy the complete production contract-source closure rather than a hand-maintained module list; Docker excludes tests and generated local build caches.

## Known risks and retained incomplete work

- The current graph is immutable after initial activation. Membership changes after activation do not create/retire runtime actors until the M06 command/event boundary owns mutations.
- Compiler alerts are definitions only; production alert routing, dashboards, external hash checkpoints, backups/PITR and restore drills remain deployment/release work.
- General HTTP rate limiting remains process-local. Database uniqueness/locks bound activation correctness, but horizontally shared privacy-preserving edge throttling remains inherited work.
- The shared API/worker database role and forward-only migration recovery remain conscious local-stack tradeoffs. Production should split capabilities, encrypt storage/backups, and rehearse PITR.
- The unified runtime image currently copies the workspace root dependency tree, including development tooling, because the one-shot bootstrap still executes TypeScript through `tsx`. This increases image size and the physically shipped dependency surface; the recorded `--prod` inventory does not enumerate every dev tool present in that image. CI audits the full lockfile, but a production hardening milestone should build service-specific/pruned runtime trees and a compiled bootstrap before claiming minimal images.
- The production lock retains one moderate PostCSS advisory through Next. Sharp's optional prebuilt libvips runtime is LGPL-3.0-or-later and carries the corresponding dynamic-linking/notice obligations; `caniuse-lite` data is CC-BY-4.0. There are no known high/critical production advisories at seal time.
- M01–M04 retained dependency/license, BFF, provider/profile, prompt-retention and managed-hosting risks remain until explicitly closed.

No command/event ledger, runtime entity mutation, history/replay, clock/tick, economy/balance/market, governance, patch, realtime, WebGL/media or AI compiler authority is introduced.

## Inputs exported to Milestone 06

**Authorized.** M06 inherits API v1; contract/runtime 5; Manifest/primitive 1; compiler `1.0.0` with config/artifact/WorldGraph/wake schema 1; sealed migration head `0006_deterministic_compiler` and SHA-256 `1e62ff203eb3fd700c27f7c7969ccaa14d3b9ee0bf1a593b668009b4f7f78372`; golden input/artifact/count/byte identities; the pure compiler, exact semantic verifier and standalone CLI; active version/entities/relationships/controllers/runtime head; scoped graph UI/API; ADR 0010; the final evidence above; and every retained M01–M05 risk. M06 must append after 0006, preserve compiler `1.0.0` golden identity unless explicitly versioned, and retain activation-only playable membership/controller semantics.
