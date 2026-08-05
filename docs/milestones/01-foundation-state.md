# Milestone 01 state — Foundation and deployable shell

Status: **complete and sealed on 2026-07-21**. This is the canonical retained state for Milestone 01. Milestone 02 must read this record, the linked ADRs, and the actual repository before changing code or migrations.

## Inputs consumed

- The attached WorldGraph/Anvil master prompt.
- `docs/planning/roadmap-a-f.md` and the Milestone 1 specification and standalone implementation prompt in `docs/planning/roadmap-g-01-08.md`.
- No earlier milestone state, schema, or migration existed. The repository contained only planning documents when implementation began.

## Outcome and implementation summary

- Initialized a `main` Git repository and a pinned pnpm 11.9.0/Turborepo workspace. Node 22.20.0 is pinned for release, CI, and containers; TypeScript is strict and ESLint enforces key package boundaries.
- Added three separately runnable process roles: a Next.js App Router web shell, a Fastify authoritative API shell, and a BullMQ worker with a separate health server.
- Added framework-free TypeBox/Ajv 2020 contracts, UUIDv7 identifiers, injected clocks/IDs, seeded XorShift32, Unicode-normalized canonical JSON, and SHA-256 digests.
- Added strict startup configuration, restrictive CORS, Helmet, size/time/rate limits, stable error envelopes, no-store responses, recursive log redaction, OpenTelemetry-compatible metrics/traces, real optional OTLP/HTTP exporters, and graceful shutdown.
- Added truthful API liveness/readiness, public compatibility information, bounded PostgreSQL/Redis/worker probes, and a feature-flagged operations-token-gated idempotent smoke queue.
- Added PostgreSQL 17 with PostGIS, pgvector, citext, and pgcrypto, a least-privilege local runtime role, forward-only Drizzle migrations, immutable migration checksums, and a one-shot migration process. Redis remains disposable coordination state.
- Added a responsive accessible `/` shell and `/system` status UI with loading, healthy, degraded, unavailable, retry/focus, version, and confirmed operational-smoke states.
- Added unit, Testcontainers integration, Playwright/axe, migration-drift, production-build, dependency-audit, and real Compose failure/recovery gates plus a GitHub Actions workflow.
- Added setup, architecture, API, migration, testing, security, operations/runbook documentation and ADRs 0001–0006.

## Repository and dependency shape

- `apps/web`: replaceable browser/UI adapter; may use public API contracts and may not import database/server implementations.
- `apps/api`: Fastify transport/composition root and future authoritative command boundary.
- `apps/worker`: BullMQ processor, idempotent operational job, heartbeat, and independent liveness/readiness.
- `packages/contracts`: TypeBox schemas, validators, compatibility constants, canonicalization, IDs, and time abstractions; no framework imports.
- `packages/db`: Drizzle schema/client, SQL migrations, migration/checksum verification, and migration CLI.
- `packages/config`: process-start configuration parsing and production-safe defaults.
- `packages/observability`: sanitized structured logs and OpenTelemetry instruments/export lifecycle.
- `packages/test-utils`: fixed clock, deterministic ID sequence, and seeded PRNG.

API and worker release builds bundle internal `@worldgraph/*` source. Their ESM build banner supplies Node's native `createRequire` to generated chunks so CommonJS dependencies such as `pg` and OpenTelemetry execute under plain Node without resolving workspace TypeScript. Runtime containers execute built entrypoints directly as the non-root `node` user; they do not invoke pnpm or install dependencies at startup.

## Public contracts and compatibility versions

The public compatibility state is:

| Axis             | Value                    |
| ---------------- | ------------------------ |
| API              | `v1`                     |
| Contract schema  | `1`                      |
| Runtime schema   | `1`                      |
| Manifest schema  | `0` (not introduced)     |
| Primitive schema | `0` (not introduced)     |
| Compiler         | `0.0.0` (not introduced) |

Public HTTP contracts:

- `GET /health/live` → process-only `200 {"status":"ok"}`.
- `GET /health/ready` → bounded PostgreSQL, Redis, runtime-migration, and worker-heartbeat aggregation; `200` ready or safe `503 DEPENDENCY_NOT_READY`.
- `GET /api/v1/system/info` → WorldGraph/Anvil identity, build revision, deliberate compatibility versions, and the operational-smoke feature state.
- `POST /api/v1/system/smoke-jobs` → registered only when enabled; requires a Bearer operations token, JSON content type, and an 8–128 character `Idempotency-Key`; returns the same bounded job for duplicate submissions and `202` queued/completed.
- Errors use schema version 1 shape `{error:{code,message,requestId,details?}}`; no stack, connection address, or credential is public.

Internal queue contracts are `SystemSmokeRequested` and `SystemSmokeCompleted`, both schema version 1. They contain only job/request identifiers, type/version, and completion time. They are operational messages, not domain events or durable authority.

## Database schema, migration, and seed state

Authoritative migration head: **`0002_platform_metadata`**.

| Migration                      | Purpose                                                                                                                                | SHA-256                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `0001_platform_extensions.sql` | Creates allowlisted `extensions` schema; enables postgis, vector, citext, and pgcrypto; conditionally grants local runtime schema use. | `94c32a2681812e85a32689f2aee8bf9cb81653c3973e7530d6b406089d03ad66` |
| `0002_platform_metadata.sql`   | Creates constrained `platform_metadata`; inserts public runtime compatibility state; conditionally grants local runtime read access.   | `ad2e744815621cbf66242fc0acd72f1faaa7d88c19c4991f780055c4a357e52a` |

`packages/db/drizzle/meta/_journal.json` is the order authority and `meta/checksums.json` prevents edits to committed history. The schema has one table:

`platform_metadata(key text primary key, value jsonb not null, value_schema_version integer not null check > 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`.

Seed/data state consists only of the idempotent `runtime_versions` public compatibility row. There are no users, worlds, domain fixtures, or object records. Fresh migration, extension functionality, constraint enforcement, and repeat migration as a no-op were verified. Application startup does not migrate; the Compose/CI release shape uses the separate owner-credential `migrate` process. Never rewrite these migrations after M01; append a forward migration.

## Actual verification evidence

Final evidence was collected on 2026-07-21. Host checks used Node `v24.9.0`, pnpm `11.9.0`, Docker `29.6.1`, and Docker Compose `v5.3.0`; the release containers and successful full-stack tests used pinned Node `v22.20.0`.

| Command                                                                                          | Actual result                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                 | Passed; lockfile accepted and supply-chain policy checked 667 entries.                                                                                                                                                    |
| `pnpm check`                                                                                     | Passed: Prettier, ESLint with zero warnings, strict typecheck in 8/8 packages, 7 unit files with 24/24 tests, migration journal/checksum verification at `0002_platform_metadata`, and production builds in 8/8 packages. |
| `pnpm test:integration`                                                                          | Passed: 2 files, 4/4 tests. Fresh PostgreSQL migrations/extensions/spatial/vector/constraint/repeat-no-op checks and Redis/BullMQ duplicate delivery, idempotency, and worker restart checks used Testcontainers.         |
| `pnpm test:e2e`                                                                                  | Passed: 4/4 Playwright tests across desktop Chromium and exact 320×720 mobile projects, including healthy/degraded/retry focus and axe checks.                                                                            |
| `ENABLE_OPERATIONAL_SMOKE=true OPERATIONS_TOKEN=<test-only> docker compose up --build -d --wait` | Passed from a clean volume: PostgreSQL, Redis, API, worker, and web became healthy; migration process exited 0 at head; built Node 22 entrypoints ran as non-root.                                                        |
| `OPERATIONS_TOKEN=<test-only> pnpm test:compose`                                                 | Passed: system info, idempotent worker completion, Redis stop → liveness 200/readiness 503 → recovery, and PostgreSQL stop → liveness 200/readiness 503 → recovery, with no API/worker restart.                           |
| `pnpm audit --audit-level high`                                                                  | Passed the blocking threshold: 0 critical/high; reported 2 moderate and 1 low transitive advisories described under risks.                                                                                                |

Playwright deliberately controls backend responses to make every UI state deterministic. `scripts/compose-smoke.mjs` separately verifies actual built container/network/database/queue wiring and dependency loss/recovery. No test is skipped, and deterministic tests make no public network request.

Resolved failures retained for later maintainers:

- Runtime services originally invoked pnpm, which attempted an install in a non-writable image directory. Compose now executes Node/Next/tsx entrypoints directly.
- Bundling internal packages originally left CommonJS dynamic requires unusable in ESM output. The API/worker tsup banner now installs a native `createRequire` in every output chunk.
- Stopping PostgreSQL originally surfaced an unhandled idle-pool error and exited the API. The pool error is now handled through the sanitized logger; liveness and automatic readiness recovery are proven by the Compose drill.

The GitHub Actions workflow itself was not run on GitHub in this local workspace; all commands it invokes, including the production-shaped Compose gate, were run locally. Pull-request-only dependency/license review will execute when a PR exists.

## Architecture decisions retained

- [ADR 0001](../adr/0001-modular-monolith.md): one strict TypeScript modular monolith with independently runnable web/API/worker roles.
- [ADR 0002](../adr/0002-postgresql-relational-graph.md): PostgreSQL is the sole durable authority and initial graph-shaped store.
- [ADR 0003](../adr/0003-server-authority-and-ai-boundary.md): all future meaningful mutations cross the authoritative server boundary; AI only proposes untrusted validated data.
- [ADR 0004](../adr/0004-contracts-and-canonical-json.md): TypeBox/Ajv runtime contracts and deterministic canonical UTF-8 JSON/SHA-256.
- [ADR 0005](../adr/0005-redis-and-queue-role.md): Redis/BullMQ are at-least-once, idempotent, disposable coordination.
- [ADR 0006](../adr/0006-versioning-and-migrations.md): compatibility axes version independently and database history advances through append-only forward migrations.

## Operational and feature-flag state

- `ENABLE_OPERATIONAL_SMOKE` defaults to false. Enabling it requires `OPERATIONS_TOKEN` of at least 32 characters. Production refuses placeholder build/credential values.
- `OTEL_EXPORTER_OTLP_ENDPOINT` unset means explicit local no-export operation. When set, API and worker start real OTLP/HTTP trace and periodic metric exporters and flush them during graceful shutdown.
- API liveness is dependency-independent. API readiness checks runtime schema 1, PostgreSQL, Redis, and a fresh worker heartbeat using bounded deadlines. Worker readiness uses its own fail-fast Redis connection.
- Redis and PostgreSQL loss/recovery runbooks and a clean local reset are documented. M01 supplies no managed backup system; PITR and restore drills remain a closed-alpha release obligation.

## Security, privacy, and integrity state

- Runtime secrets stay server-side; `.dockerignore` excludes environment files other than the example, key material, source control, reports, tests, and unrelated source from the runtime image.
- CORS uses explicit normalized origins; headers, content types, request/body limits, timeouts, and operational rate limits are enforced server-side.
- Sensitive keys are recursively redacted. Error messages sanitize common Bearer, key/value, and URL credentials, and stacks are omitted from log objects and public responses.
- Operations credentials are compared through fixed-size SHA-256 digests with `timingSafeEqual`; the feature is hidden and unregistered when disabled.
- The local runtime database role is non-superuser and receives only M01 schema use/table read. Production may provision a differently named equivalent role.
- Redis completion markers are not authority. M01 contains no identity, world, player, prompt, money, governance, or personal data.

## Deviations and known risks

- The roadmap summary mentions MinIO/object storage, but the detailed M01 exact scope and data model introduce no assets or object contract. No idle object-store dependency was added. S3-compatible storage remains required when immutable generated assets first enter scope; record its contract and migration/provenance state then.
- No hosted preview was deployed because no deployment target or credentials were provided. The reproducible non-root image, Compose topology, health gates, and CI deployment shape are ready for a later environment-specific hosting decision.
- The audit currently reports two moderate advisories: a dev-only esbuild version under Drizzle Kit, and PostCSS under Next.js; it also reports one low esbuild advisory under tsup. There are no high/critical findings. Track upstream releases and refresh the lockfile; do not expose development servers publicly. The PostCSS path is used to build trusted repository CSS, not untrusted CSS input.
- Extension functions/operators live in the `extensions` schema. Current SQL qualifies them explicitly. A managed production database must either preserve that convention or provision a reviewed search path and equivalent runtime grants.
- M01 telemetry exposes request/dependency latency, readiness, smoke outcomes, sanitized structured logs, and explicit spans/exporters. Production dashboards, alert routing, process-runtime metrics, queue backlog collection, and database pool gauges still require the chosen observability backend before alpha.
- The workspace began without Git history and M01 initialized Git but intentionally did not create a commit. A maintainer should review and commit the complete foundation as one intentional change set.

No authentication, users/worlds, primitives, manifests, compiler, event ledger, simulation, economy, governance, multiplayer, WebGL, external model provider, graph database, Kafka, or Kubernetes was introduced. Do not begin those capabilities without their owning milestone and an appended handoff.

## Inputs for Milestone 02

Milestone 02 inherits API v1, contract schema 1, runtime schema 1, migration head `0002_platform_metadata`, the package boundary and ADR set above, the non-authoritative queue rule, the stable error envelope, the fixed clock/ID/PRNG/canonical JSON utilities, and every green M01 gate. It must preserve the home/system/health/smoke flow, append migrations rather than editing M01, rerun fresh and upgrade paths, update actual test evidence, and explicitly carry this record forward.
