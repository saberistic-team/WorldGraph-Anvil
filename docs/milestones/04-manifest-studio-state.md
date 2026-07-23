# Milestone 04 state — Manifest Studio and deterministic generation

Status: **complete and sealed on 2026-07-21**. Aggregate checks, real-service integration, desktop/mobile browser acceptance, clean/repeat production Compose with dependency recovery, supply-chain review, and an independent adversarial audit are green. No critical/high finding remains.

## Inputs consumed

- The complete sealed M01 state: API v1, contract/runtime schema 1, deployable web/API/worker/PostgreSQL/Redis shell, deterministic utilities, canonical JSON, health/telemetry/CI/Compose baseline, migration/forward-repair discipline, and ADRs 0001–0006.
- The complete sealed M02 state: contract/runtime schema 2, identity/session/world membership and creator/platform authority, Origin/CSRF/BFF boundary, idempotent/audited commands, application notifications, migration `0003_identity_authority`, ADR 0007, and every retained identity/operations risk.
- The complete sealed M03 state: contract/runtime schema 3, primitive/index schema 1, migration `0004_primitive_registry` and digest, exact reviewed 16-item catalog/locks, deterministic bounded retrieval, PostgreSQL-authoritative index jobs, ADR 0008, final M03 release evidence, and every retained registry/security/operations risk.
- The standalone Milestone 4 prompt in `docs/planning/roadmap-g-01-08.md`. Runtime compilation, graph entities, activation, simulation, economy/governance execution, realtime transport, and WebGL were not pulled forward.

## Outcome and implementation summary

Milestone 4 adds a complete Manifest v1 proposal/review/approval boundary. An authenticated creator or world administrator can submit a bounded city-state description, observe a durable asynchronous run, receive a deterministic provider-disabled fallback grounded in exact published primitive versions, create child drafts from structured JSON or safe YAML, inspect validation/provenance/diff/history, and validate. Only the current world creator can explicitly approve the latest valid immutable revision. Approval changes the manifest pointer only; it creates no runtime entity and invokes no compiler.

The sealed implementation adds:

- `packages/contracts`: contract schema 4 for Manifest v1, generation envelope/status/API views, diagnostics/fixes/provenance/diffs, application notifications, schema-1 queue wake, new authority actions, and nullable approved-manifest fields on worlds.
- `packages/manifests`: canonical JSON/content hashing, bounded safe-YAML parse/projection/source locations, layered schema/semantic/catalog/reference/connectivity/mechanics validation, stable report hashing, structural diffing, normalized request/resolved hashes, schema-constrained provider engine, bounded repair/transient retry/circuit/accounting behavior, and the real deterministic city-state fallback.
- `packages/db`: Drizzle parity and forward migration `0005_manifest_studio`, with durable prompts/runs/retrieval/provider-call reservations, immutable revisions/reports/provenance/generation warnings, lease/CAS/cancel/retry/accounting invariants, latest-only creator approval, and deferred world-pointer consistency.
- `apps/api`: membership-scoped query routes, creator/administrator generation/edit/validate commands, creator-only approval, HMAC pagination, exact-version catalog validation, database idempotency/audit, prompt-free best-effort wakes, sanitized errors, limits, metrics, and graceful queue shutdown.
- `apps/worker`: schema-valid wake processing, PostgreSQL claim/reconciliation/lease recovery, deterministic exact primitive retrieval/freezing, provider/fallback generation, cancellation checks, atomic at-most-one revision/report/provenance publication, prompt cleanup, safe application notifications, logs/traces/metrics, and graceful recovery.
- `apps/web`: `/worlds/[worldId]/manifest` staged Describe/Draft/Validate/Review/Approve studio, durable capped-backoff polling and refresh restoration, run cancel/degraded states, structured core editing and safe YAML child creation, exact published primitive replacement, diagnostic focus/source position, history/diff/provenance/assumptions/warnings/downloads, creator approval, read-only approved state, keyboard tabs/live status/unsaved-change guard, responsive behavior, and world-detail entry point. The BFF allowlist remains exact and body-bounded.
- Operations/docs: Manifest v1 and generation/privacy/recovery guides, ADR 0009, low-cardinality instrumentation, and versioned manifest alert rules.

## Compatibility and public contract state

| Axis                            | M04 sealed                             |
| ------------------------------- | -------------------------------------- |
| Product/API                     | WorldGraph / Anvil, API `v1` unchanged |
| Contract schema                 | `4`                                    |
| Runtime schema                  | `4`                                    |
| Manifest schema                 | `1`                                    |
| Manifest generator schema       | `1`                                    |
| Prompt template                 | `1`                                    |
| Manifest validator              | `1`                                    |
| Manifest BullMQ wake schema     | `1`                                    |
| Primitive schema/index policy   | `1` unchanged                          |
| Application command schema      | `1` unchanged                          |
| Application notification schema | `1` unchanged                          |
| Compiler                        | `0.0.0` (not introduced)               |

The stable API error envelope and `no-store` policy remain. Manifest API contracts include start/status/cancel generation; cursor-paginated revision history; create/read/validate/diff; exact warning/name/version/hash approval; immutable canonical JSON and safe YAML views; validation reports; and bounded field provenance. New notification types are `ManifestGenerationRequested`, `ManifestGenerationSucceeded`, `ManifestGenerationFailed`, `ManifestRevisionCreated`, `ManifestRevisionValidated`, and `ManifestApproved`; they remain non-authoritative in-process contracts before the M06 ledger.

The queue wake includes only `runId`, base `inputHash`, provider configuration, generator/template/validator/queue versions, and type. It contains no prompt, manifest, world/user ID, raw authority decision, or provider content. Manifest HTTP responses are Ajv-validated against their exact contracts before native JSON serialization.

## Manifest contract, validation, and deterministic golden

`WorldManifestV1` is strict inert data for one bounded city-state: schema/seed/metadata, exact primitive pins and parameters, districts/connections, institutions/organizations/actor blueprints, economy intent, relationships, simulation settings, visual direction, assumptions, and namespaced bounded extensions. Every pin contains primitive UUID, stable key, exact SemVer, kind, published content hash, local reference, and validated inert parameters. No code, tool action, dynamic/remote schema reference, URL fetch, or runtime mutation is representable.

Canonical normalized/key-sorted JSON bytes are authoritative and SHA-256 content-addressed. YAML is an editing projection only; aliases/anchors, merge keys, tags, duplicate/prototype keys, multiple documents, non-JSON values, controls, and resource-limit violations fail before revision creation. Parsed YAML is schema-validated before primitive-catalog access. Validation orders stable diagnostics across schema/bounds, unique normalized keys, exact catalog identity/parameters/dependencies/compatibility/behavior, local references/relationships, connectivity, and critical city-state mechanics. Errors block approval; every current warning code must be acknowledged exactly, and suggested fixes are never silently applied. Generated warning requirements are immutable, capped consistently at 32, inherited by descendants, and reattached during later catalog validation so review debt cannot disappear.

The reviewed deterministic fallback fixture has:

- canonical manifest SHA-256 `c3074930cc920b840e1ad5e1a8d338c621476771f2aa57e0e5c47d9904760174`;
- base request SHA-256 `be412d23469ab19631fbe8a611d50071930c3c4c06aaea7490a9438afedf2890`;
- resolved input SHA-256 `307c8563f0801084d08ddec44b0f83ce7511cc0777ab6e5cdcd293e343639f1c`.

Identical normalized prompt, explicit/derived seed, parent pair, exact catalog ordering/content, generator/template/provider configuration, and validator inputs produce the same bytes/hashes. Catalog retrieval is frozen before the resolved hash is computed; the base request never fabricates a request-time catalog identity. Fallback-derived metadata retains both deterministic-template and hashed prompt provenance without retaining the raw prompt in provenance.

## Authority, revision, and approval state

- All manifest reads require active membership and are scoped before loading private content. Nonmembers and cross-world run/revision IDs receive non-enumerating not-found responses.
- Active creator and administrator memberships may start/cancel generation and create/validate child revisions. All active member roles may read and diff.
- Approval is creator-only. Platform administration or world administration without the creator membership cannot approve; platform administration does not synthesize visibility.
- Generation/edit/validation/approval mutations are authenticated, Origin/CSRF protected, runtime validated, idempotent, audited, and re-authorized inside the transaction. Expected row version/content hash and same-world parent links prevent stale/swapped content.
- Approval locks world/revision, requires the latest draft and normalized typed world name, revalidates current schema/exact pins, requires exact warning acknowledgements, supersedes one prior approval, advances the world row/pointer/schema, and writes audit atomically. It never enqueues compilation.

Every revision is immutable and numbered monotonically under the world lock. A schema-valid but semantically invalid manual document may be retained with a blocking report for review; syntax/schema-invalid YAML/JSON creates no revision. Approved content remains read-only and future edits/regenerations create children.

## Generation, provider, privacy, and cancellation state

PostgreSQL owns prompt submissions, run input/state, frozen retrieval, leases, per-call provider accounting, terminal outcome, and immutable output. BullMQ wakes are disposable and duplicate-safe. Input-cache reuse considers only queued, running, or succeeded work; cancelled/failed work never prevents a fresh run, and current parent/hash structure is checked before cache reuse. The worker rechecks a UUID claim token on stage/heartbeat/freeze/provider reservation/settlement/publication, limits attempts to three, and atomically inserts at most one output revision/report/provenance before terminal success. Expired claims are requeued with retained provenance and cumulative provider/repair usage or terminally failed. Cancel-first invalidates the lease and prevents late settlement/publication; completion-first makes cancellation conflict.

The provider port receives a system-authored schema task plus bounded, labeled untrusted prompt/primitive material. It has no database, command, tool, URL-fetch, filesystem, compiler, runtime, or WorldGraph network capability. At most two schema repairs and two transient retries are permitted within external timeout/token/cost/concurrency/circuit controls. Provider calls reserve bounded cost/tokens under one global UTC-date database lock, settle exact usage no greater than the reservation, or release only a definitely unmade call; unknown outcome remains conservatively charged. Repair and usage ceilings survive worker retry. Successful provider-mode publication must reconcile its durable call ledger and requires a non-disabled configuration plus a settled call. Raw payloads and chain of thought are not retained. Current production configuration is only `disabled-v1`, daily provider budget zero, and PostgreSQL rejects provider reservations for that configuration; a schema-faithful fake covers the adapter contract and the deterministic fallback is real production behavior. No optional live-provider result exists because no live provider is configured.

Prompt text is access-restricted rather than application-encrypted, is never returned by a read API, and defaults to 30-day retention (allowed 1–365). Cleanup nulls it only after retention; database protection rejects early erase, restoration, provenance/hash changes, or deletion. Approved content, normalized hash, exact retrieval/provenance, and audit identity remain. Logs/metrics/traces/queue/audit exclude raw prompts, manifests, provider payload/error text, secrets, and IDs as labels.

## Database migration and data state

Journal head is **`0005_manifest_studio`**. Migrations 0001–0004 remain immutable with their sealed digests.

| Migration                      | Purpose                                                                                                                            | SHA-256                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `0001_platform_extensions.sql` | PostGIS, pgvector, citext, pgcrypto extension schema.                                                                              | `94c32a2681812e85a32689f2aee8bf9cb81653c3973e7530d6b406089d03ad66` |
| `0002_platform_metadata.sql`   | Public runtime compatibility metadata.                                                                                             | `ad2e744815621cbf66242fc0acd72f1faaa7d88c19c4991f780055c4a357e52a` |
| `0003_identity_authority.sql`  | Identity/world authority, idempotency, and audit.                                                                                  | `860f0a9c0d77a5c1e0fff88b7516956ab5b900ab52659502020d91b73abf646b` |
| `0004_primitive_registry.sql`  | Immutable primitive registry/retrieval/index state.                                                                                | `f498545519e93eba894de171e565a364bdec3ded03f3674dbd8b4ec43d1c0263` |
| `0005_manifest_studio.sql`     | Manifest prompts/runs/retrieval/provider accounting/revisions/reports/provenance, grants/triggers, compatibility 3→4/manifest 0→1. | `7c9ca2c5bbf7c1c573fd73f1a93dc416ea72b8d8abe840b623acbd09d3bfc601` |

M04 adds five enums, the two nullable world compatibility/pointer columns, and seven tables: `world_prompt_submissions`, `manifest_generation_runs`, `generation_retrieval_items`, `manifest_provider_calls`, `manifest_revisions`, `manifest_validation_reports`, and `manifest_field_provenance`. Indexes support retention cleanup, due/running reconciliation, world/request status/history, input/resolved caches, exact retrieval, UTC budget accounting, validation lookup, and provenance. Foreign keys/triggers/functions enforce exact primitive content identity, same-world parent/run/output/pointer links, immutable warning/provenance state, active-prompt retention, allowlisted generation/approval transitions, latest-only approval, durable call/repair/accounting limits, and exactly one approved revision matching a non-null pointer/schema.

The migration adds no production prompt, manifest, generation, or runtime seed. The reviewed 16-item M03 primitive catalog remains the bootstrap data; deterministic prompt/manifests exist only in tests. Migration 0005 is forward-only and must never be edited after this state; recovery is stopped incompatible code, restore/PITR where needed, or reviewed forward repair.

## Observability and operational state

Metrics cover generation runs/outcomes/mode, duration, queue wait, retrieval count, token/cost estimate, validation codes/severity, approval conversion, cancellation/stale conflict, prompt cleanup, and backlog/age. Traces use safe stage/provider configuration/version/hash/run correlation. `deploy/alerts/manifest-studio.rules.yml` defines queue-age, failure/fallback, cost, validator-error, and stale-conflict alerts. Deployment/loading/routing is not supplied by local Compose and remains a release-environment responsibility.

Feature/configuration controls include generation enabled, provider (`disabled` only), zero daily provider budget, 1–3 per-world concurrency (default 1), independent 1–10 cross-world requester concurrency (default 2), 512–16384 output-token limit (default 4096), 500–30000 ms provider timeout (default 8000), 250–60000 ms reconciliation (default 2000), and 1–365 day prompt retention (default 30). The locked world row serializes the world count/create decision; a transaction-scoped requester advisory lock independently serializes the cross-world requester decision. PostgreSQL serializes UTC daily provider reservations across every worker/run.

Runbooks now cover disabling generation/provider, stuck/cancelled/late runs, Redis wake loss, expired leases, provider incidents, exact replay, compromised draft/approval, validator release, prompt erasure/exposure, inconsistent approved pointer, failed migration, and inherited identity/dependency recovery.

## Verification evidence

Evidence was collected locally on 2026-07-21. Failed intermediate checks are retained truthfully: aggregate check first exposed two strict test-lint errors, and a later aggregate run exposed one provider-retry test exceeding Vitest's default five-second timeout under full-suite contention. The lint errors were corrected; that deterministic test now has an explicit 15-second harness timeout and passes in focused/full runs. The first browser run had one transient empty-title accessibility observation during client navigation; the test now waits for the stable root title, passed focused, and the complete suite passed twice afterward.

| Check                                                   | Actual result                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final aggregate `pnpm check`                            | Passed after the final docs/state update: formatting, zero-warning lint, 10/10 package typechecks, 35 unit files with 189/189 tests, migration integrity at `0005_manifest_studio`, and 10/10 production builds.                                                                          |
| Final full `pnpm test:integration`                      | Passed: 9 files, 55/55 real PostgreSQL/Redis tests, including fresh/exact upgrades, authority, primitive lifecycle, M04 API, 12 manifest database invariants, and 9 worker tests for cancellation, UTC budget/repair/accounting races, retry, prompt cleanup, and atomic publication.     |
| Final `pnpm test:e2e`                                   | Passed: 44/44 Playwright cases across desktop Chromium and exact 320-pixel mobile projects, including Manifest Studio generation/recovery/cancel/approval, prior identity/registry journeys, keyboard/mobile behavior, and axe checks.                                                    |
| Clean/repeat production Compose and recovery            | Passed from deleted local volumes: migration head `0005`, 16 primitives imported; repeated one-shot reported `imported=0 unchanged=16`; provider-disabled generation/approval and duplicate-safe worker delivery passed; stopping/restarting Redis and PostgreSQL degraded and recovered. |
| `pnpm audit --audit-level high`                         | Exit 0 with no critical/high advisory. Retained dependency advisories are 2 moderate and 1 low.                                                                                                                                                                                           |
| `pnpm licenses list --prod --json`                      | Completed. License families are 0BSD, Apache-2.0, BSD-3-Clause, CC-BY-4.0, ISC, LGPL-3.0-or-later, and MIT; no GPL-3.0/AGPL-3.0 dependency was found. Normal notice/redistribution obligations remain.                                                                                    |
| Focused final adversarial hardening                     | Passed: 24/24 warning/contract/worker units; 21/21 DB+worker PostgreSQL tests; final four-file PostgreSQL audit 36/36; API/UI focused 15/15; migration checker and changed-package type/lint/format checks passed.                                                                        |
| Independent final adversarial/blocker audit (read-only) | **GO**: no critical/high finding. It verified closure of malformed-YAML, parent/cache, run/revision UI binding, warning-bound, latest-approval, active-prompt, disabled-provider, ledger reconciliation, and repair-race findings; retained live-provider prerequisite is recorded below. |

## Architecture decisions and deviations

- ADRs 0001–0008 remain in force. ADR 0009 fixes canonical immutable Manifest v1 authority, creator-only approval, PostgreSQL-durable generation, separate base/resolved hashes, wake-only Redis, strict proposal-only provider output, and required deterministic fallback.
- Contract/runtime advance to 4 because public manifest contracts and runtime-required authority tables are introduced. Manifest/generator/template/validator/queue start independently at 1. API v1, primitive schema 1, command/notification schema 1, and compiler 0.0.0 remain compatible.
- Safe YAML is not a second authority. Source locations assist review, but canonical normalized JSON bytes determine content identity.
- Validation reports are immutable observations keyed by revision/validator/catalog hash. Approval revalidates current supported schema/exact pins rather than trusting an old report.
- A platform administrator must also be an active world member to access a private manifest and still cannot approve without creator membership. This intentionally prioritizes tenant privacy and creator intent over broad platform role.
- Provider-disabled fallback is the production path, not a mock. A live provider is an optional future adapter and cannot be enabled by configuration alone in this release.
- Diff responses page the complete deterministic contract-bounded change set with a world/revision-bound signed cursor; there is no pre-pagination 2,000-entry rejection.
- Manifest UI edit controls derive only from active creator/administrator world membership. A platform administrator with `role: null` remains read-only/denied exactly as at the API boundary.
- PostgreSQL, not a worker-local counter, owns provider-call reservations and effective usage. The current `disabled-v1` configuration cannot reserve a call or publish provider mode; enabled provider-mode success must reconcile a settled ledger. A future paid adapter still requires persisted trusted per-configuration budget authority rather than caller-supplied ceilings.
- The independent audit's medium findings were fixed before sealing: schema-invalid YAML is rejected before catalog access; parent structure precedes cache reuse; review output binds to its exact generation run; and database triggers enforce latest-only approval, active-prompt retention, the shared 32-warning bound, two repair calls, and terminal accounting reconciliation.
- Generation notifications remain non-authoritative application integration signals. M04 does not add the M06 domain event ledger/outbox.

## Known risks and retained incomplete work

- No live provider is configured or tested. The strict fake and disabled-provider fallback prove the boundary, but enabling an external provider requires an adapter/version, secret/config management, privacy/cost review, real failure observation, and release evidence. Before any paid call, persist trusted/versioned database-side provider configuration and budget authority instead of accepting a caller-supplied daily ceiling, and split or otherwise narrow API/worker database capabilities.
- Alert definitions are versioned but not loaded/routed in local Compose. Managed backups/PITR, restore drill, preview/production hosting, formal retention/export/deletion policy, and independent closed-alpha security review remain release work inherited from M01–M03.
- General HTTP rate limits remain process-local. Manifest generation concurrency decisions are database-serialized, and provider budget/accounting is durable, but horizontal/multi-instance abuse exposure still requires privacy-preserving shared edge/store request-rate controls and a defined trusted-proxy identity.
- Prompt text is access-restricted and subject to one-way retention cleanup, not field-level application encryption. Production requires reviewed database/disk encryption and key/access controls. Cleanup execution is worker reconciliation rather than a separately scheduled compliance service.
- The M03 readiness/profile mismatch risk remains: outside shared Compose, readiness does not attest semantic provider configuration. M04 provider is disabled, but future independent provider deployment needs versioned heartbeat compatibility.
- The M03 500-version exact compatible-scope ceiling remains. The 16-item catalog is safe; marketplace scale needs a versioned measured retrieval design.
- M01–M03 moderate/low dependency advisories, license notice obligations, BFF/identity test debt, local throttles, no managed backups/restore drill, and forward-only migrations remain retained until explicitly closed.
- Migration 0005 is forward-only. There is no automated destructive down migration or manifest deletion/unapproval path.

No compiler artifact, runtime graph entity/relationship, world activation, simulation tick, ledger/event/outbox, economy/governance execution, asset pipeline, realtime presence, WebGL client, natural-language runtime patch, arbitrary template/code/URL, collaborative editing, or automatic approval was introduced.

## Inputs exported to Milestone 05

Milestone 5 inherits API v1; contract/runtime schema 4; Manifest/generator/template/validator/queue schema 1; primitive/index schema 1; migration head `0005_manifest_studio` with SHA-256 `7c9ca2c5bbf7c1c573fd73f1a93dc416ea72b8d8abe840b623acbd09d3bfc601`; immutable canonical revisions/reports/provenance/generation warnings; exact latest-only creator approval and world pointer; deterministic golden fallback/hashes; PostgreSQL-durable generation/cancellation/recovery/provider accounting; Manifest Studio UI/API; ADR 0009; all retained M01–M04 risks; and the final verification evidence above.

M05 must compile only an explicitly approved immutable manifest and exact primitive pins. It must not compile prompt text/model output directly, mutate an approved revision, retarget exact pins, weaken creator approval, treat Redis as authority, reuse generation state as runtime state, or edit migrations 0001–0005.
