# G. Detailed milestone specifications — Milestones 1–8

These milestones use one stack throughout: Node.js 22 and strict TypeScript in a pnpm/Turborepo monorepo; Next.js App Router for the web application; a Fastify modular monolith for the authoritative API; BullMQ workers backed by Redis; PostgreSQL with PostGIS, pgvector, and Drizzle migrations; TypeBox-authored JSON Schema Draft 2020-12 contracts validated by Ajv; OpenTelemetry-compatible telemetry; Vitest, Testcontainers, and Playwright. PostgreSQL is authoritative. Redis and queues are disposable coordination mechanisms, never the source of truth. Every implementation milestone must finish or update `docs/milestones/MNN-handoff.md` with its implementation summary, schema and contract changes, exact migration state, test commands/results, architecture decisions, operational notes, and unresolved risks; the next milestone must inspect all prior handoffs before editing.

## Milestone 1 — Foundation & deployable shell

### Outcome

WorldGraph is a locally runnable and continuously verified product shell rather than an empty repository. A developer can start the web application, authoritative API, worker, PostgreSQL/PostGIS/pgvector, and Redis with one documented workflow; the browser reports dependency health and build/version information; CI enforces formatting, linting, type safety, tests, migration checks, and production builds. The repository also contains enforceable dependency boundaries, base versioned contracts, observability, deterministic test utilities, architecture decisions, and a milestone handoff record.

### Why this milestone occurs now

Every later milestone needs one runtime, migration discipline, contract library, test harness, and deployment shape. Establishing those once prevents identity, generation, compilation, simulation, and economy code from inventing incompatible conventions. It remains a thin executable vertical slice: domain features, premature services, and graphical work wait until the foundation can be exercised and deployed.

### User-visible demonstration

1. Copy `.env.example` to the documented local environment file and run the single bootstrap command.
2. Open `/`; confirm the accessible WorldGraph shell identifies itself as “Anvil,” shows the web/API build revisions, and links to service status.
3. Open `/system`; confirm API, PostgreSQL, Redis, and worker readiness are shown without exposing secrets or host details.
4. Stop Redis; confirm liveness remains healthy, readiness becomes unavailable with a stable error code, and the UI renders a retryable degraded state.
5. Restore Redis, run the smoke job, and confirm the worker completes it and readiness recovers.
6. Run the documented verification command from a clean checkout and confirm lint, types, unit/integration tests, migrations, and builds pass.

### Scope

- Create `apps/web`, `apps/api`, and `apps/worker`, plus packages for contracts, database access, configuration, observability, test utilities, and lint/TypeScript configuration.
- Configure pnpm workspaces and Turborepo with reproducible locked dependencies, strict TypeScript, formatting, linting, and import-boundary rules.
- Add a Next.js App Router shell with `/` and `/system`, and a versioned Fastify `/api/v1` surface.
- Add `GET /health/live`, `GET /health/ready`, and `GET /api/v1/system/info`; use bounded dependency timeouts and sanitized structured errors.
- Provision PostgreSQL with PostGIS and pgvector and Redis through Docker Compose; wire Drizzle migration generation and application.
- Add a BullMQ `system-smoke` queue and worker processor used by integration/operational verification, not as authoritative state.
- Establish TypeBox/JSON Schema/Ajv contracts, UUIDv7 identifiers, UTC timestamps, canonical JSON, error envelopes, request/correlation IDs, and schema/version constants.
- Establish structured logging with redaction, OpenTelemetry-compatible traces/metrics, graceful shutdown, health metrics, and environment validation.
- Add CI, unit tests, Testcontainers integration tests, a Playwright smoke test, migration-up verification, and deterministic clock/ID/seed helpers.
- Record ADRs for the modular monolith, relational graph-shaped persistence, server authority, contract format, queues, versioning, and event/LLM boundaries.
- Document setup, commands, package ownership/dependency direction, configuration, troubleshooting, migration rules, and the M01 handoff.

### Non-goals

- Authentication, user/world records, manifests, primitives, compilation, ledger behavior, simulation, wallets, realtime multiplayer, or WebGL.
- Kubernetes, Kafka, a graph database, independent domain services, production multi-region infrastructure, or an external AI provider.
- A generic framework designed for hypothetical world types; only conventions required by the bounded city-state MVP are established.

### Dependencies

- An empty or near-empty repository and local Docker support.
- Product invariants in the WorldGraph master plan. No prior milestone artifact is required.

### Architecture and design

- `apps/web` may call only public API contracts; it never imports database or server domain implementations. `apps/api` owns HTTP/authentication adapters and composes modules. `apps/worker` consumes durable job references and calls application services. Domain packages remain framework-independent; `packages/db` owns Drizzle schemas, transactions, and migrations; `packages/contracts` contains runtime schemas without server imports.
- The initial deployment is three Node processes (web, API, worker), one PostgreSQL database, and Redis. They may ship together but have separate health/readiness checks. PostgreSQL is the only durable authority; a lost Redis instance may delay/retry work but cannot erase accepted state.
- Fastify attaches a UUIDv7 request ID, returns a versioned `{ error: { code, message, requestId, details? } }` envelope, and redacts stack traces from production responses. Dependency probes have deadlines and readiness fails closed.
- Configuration is parsed once at startup with a checked schema. Secrets are never included in client bundles, logs, health results, or `/system/info`.
- Canonical JSON recursively sorts object keys, preserves array order, rejects non-JSON values, and hashes UTF-8 bytes with SHA-256. Injected clocks, ID generators, and seeded PRNG interfaces keep future tests deterministic.
- Queue delivery is at least once. The smoke processor is idempotent by job ID and proves wiring only; no business correctness depends on BullMQ acknowledgement.
- Package-boundary lint rules prohibit web-to-db, contracts-to-framework, and domain-to-UI imports. ADRs document when the modular monolith or relational graph decision may be revisited.

### Data model and migrations

- Migration `0001_platform_extensions` enables `postgis`, `vector`, `citext`, and `pgcrypto` explicitly and fails with an actionable message when unavailable. Extensions are installed in an allowlisted schema and their minimum supported versions are documented.
- Migration `0002_platform_metadata` creates `platform_metadata(key text primary key, value jsonb not null, value_schema_version integer not null check (value_schema_version > 0), created_at timestamptz not null default now(), updated_at timestamptz not null default now())`. Seed an idempotent `runtime_versions` row containing only public schema/compiler/runtime compatibility numbers.
- Drizzle’s migration journal remains the authoritative migration state. Application startup never silently applies migrations in production; a separate documented release command does.
- All tables use UTC `timestamptz`, explicit names, constraints, and least-privilege application roles. Down migrations are provided only when safe; restore/forward-fix is documented for irreversible extension work.
- Integration tests create a fresh database, apply every migration, check required extensions and constraints, and reject schema drift. No domain seed data is introduced.

### APIs, commands, events, and realtime messages

- `GET /health/live`: proves the API event loop is responsive; no authorization; no dependency data; `200 {status:"ok"}`; never cached.
- `GET /health/ready`: probes PostgreSQL, Redis, migration compatibility, and worker heartbeat with deadlines; no authorization; returns `200 ready` or `503 DEPENDENCY_NOT_READY` with only component names and request ID; safe and idempotent; emits no domain event or realtime message.
- `GET /api/v1/system/info`: returns product codename and public API/schema/build compatibility versions; no authorization; validates a response schema; never returns configuration or infrastructure addresses.
- `POST /api/v1/system/smoke-jobs` exists only when `ENABLE_OPERATIONAL_SMOKE=true` and requires a configured operations token; it accepts an idempotency key, enqueues one bounded job, returns `202` plus job ID, and returns stable `401/403/409/429/503` errors. Production defaults it off.
- Internal `SystemSmokeRequested` and `SystemSmokeCompleted` queue payloads contain job ID, request ID, schema version, and no arbitrary code/data. They are operational messages, not domain events. No realtime protocol is introduced.

### User interface

- `/` contains a keyboard-navigable product shell, concise MVP boundary copy, a service-status link, and build/version footer.
- `/system` displays loading skeletons, an empty/not-configured worker state, healthy/degraded/unavailable states, a retry button, timestamps, and stable error codes. It does not expose raw exception text.
- Both routes meet WCAG 2.1 AA basics: semantic headings/landmarks, visible focus, sufficient contrast, status text not encoded only by color, reduced-motion support, and a useful 320-pixel layout.
- Operational smoke controls are hidden unless the server reports the feature enabled; destructive-looking controls require confirmation even though the smoke job is harmless.

### AI behavior

AI is not required. No model SDK or placeholder model call is added. The later AI boundary is documented: generated output is untrusted data, must be schema constrained and approved, and can never invoke a database or command handler directly. Deterministic fixtures must not make network calls.

### Security, privacy, abuse, and integrity

- Validate configuration at process startup; fail closed on missing secrets or unsupported production defaults. Commit only `.env.example` with non-secret placeholders.
- Configure production security headers, restrictive CORS/origin policy, body/URL limits, request timeouts, content-type enforcement, and rate limiting on the optional operational endpoint.
- Redact authorization/cookie/token/password-like keys recursively. Hash the operations token comparison and prevent timing-leaky direct string comparison.
- Run containers/processes without root where packaging supports it, pin the lockfile, enable dependency/license scanning in CI, and document vulnerability response.
- Health endpoints disclose no versions beyond deliberate compatibility numbers. Telemetry uses low-cardinality labels and no request bodies.

### Observability and operations

- JSON logs include timestamp, level, service, environment, build revision, request/job ID, trace ID, route template, duration, outcome, and stable error code; tests assert secret redaction.
- Metrics include HTTP count/latency/errors, dependency probe latency, readiness state, queue waiting/active/failed counts, worker heartbeat age, database pool saturation, process resources, and graceful-shutdown failures.
- Trace HTTP requests, database probes, enqueue, and worker execution with propagated correlation IDs. Local exporters may be console/no-op; production exporter configuration remains environment-driven.
- Document dashboards/alerts for sustained unready service, error-rate increase, old worker heartbeat, queue backlog, and exhausted DB pool. Include runbooks for Redis loss, failed migration, stuck smoke job, and clean local reset.

### Testing requirements

- Unit-test configuration parsing, error mapping, canonical JSON/hash vectors, redaction, deterministic clock/ID/PRNG helpers, and health aggregation.
- Use Testcontainers for PostgreSQL extensions/migrations and Redis/BullMQ enqueue–execute idempotency; test unavailable/timeout dependencies and worker restart.
- Contract-test every response against shared schemas. Playwright tests `/`, `/system`, healthy/degraded rendering, retry, keyboard focus, and axe accessibility rules.
- Security tests cover CORS/origin, headers, body limits, disabled smoke route, invalid operations token, rate limit, and log redaction.
- Verify a clean install, lint, typecheck, unit/integration/e2e tests, migration application, migration-drift check, and production builds. Test fixtures use fixed clocks/seeds and no public network.

### Acceptance criteria

- From a clean checkout, the documented bootstrap starts all five components and `/health/ready` becomes `200` within the documented timeout.
- Removing PostgreSQL or Redis produces `503` readiness with the correct stable component code while `/health/live` remains `200`; recovery requires no restart.
- One authenticated operational smoke request produces one completion despite duplicate submission with the same idempotency key.
- CI rejects type errors, package-boundary violations, formatting/lint failures, schema drift, failed migrations/tests, and failed builds.
- Fresh-database migration tests confirm PostGIS and vector functionality with one spatial and one vector query.
- Browser smoke and automated accessibility checks pass at desktop and 320-pixel viewport.
- No repository/log/client artifact contains a test secret, and production configuration refuses unsafe defaults.
- The architecture/setup/runbook/ADR documents and complete M01 handoff exist and agree with the code and migration journal.

### Definition of done

- Production-quality code is complete with no core TODO, mock server, or skipped required test; lint, types, tests, and production builds pass.
- Migrations are applied to a fresh database and verified for repeatable no-op application; rollback/forward-fix notes are reviewed.
- Setup, architecture, operations, testing, and API documentation plus M01 handoff are current.
- The demo is completed, telemetry is observable, no critical/high known defect remains, and the deployable shell works after a clean restart.

### Risks and mitigations

- **Tooling consumes the milestone:** keep packages minimal and require every abstraction to serve a named next milestone.
- **Local/CI drift:** pin Node/pnpm, use one lockfile and Compose definition, and exercise clean bootstrap in CI.
- **False health:** separate liveness/readiness and test failure/recovery, including worker heartbeat age.
- **Telemetry leaks secrets or explodes cardinality:** centralize recursive redaction and use route templates/stable codes rather than raw URLs or IDs.
- **Migration privilege mismatch:** validate required extensions before release and document managed-PostgreSQL prerequisites.

### Artifacts produced for later milestones

- Executable monorepo/deployment shell and dependency-boundary rules.
- Shared identifier, time, canonical JSON, error, API version, and schema-version contracts.
- Drizzle migration workflow, PostgreSQL extensions, Redis/BullMQ wiring, and deterministic test harness.
- Config, observability, health, CI, security-baseline, and operations libraries.
- ADRs and `docs/milestones/M01-handoff.md`, including the exact migration head and verified commands.

### Standalone implementation prompt

```text
Implement Milestone 1, “Foundation & deployable shell,” for WorldGraph (codename Anvil).

1. Product context: WorldGraph will create persistent multiplayer city-state societies from approved, schema-backed manifests. PostgreSQL will be authoritative; simulation and typed graph state must work without 3D. LLMs may later propose validated data but may never mutate state. The MVP is closed-loop and has no real money.
2. Expected repository state: treat the repository as empty or near-empty. Inspect every existing file, package manifest, configuration, architecture note, migration, and test before editing; preserve useful work and report any conflict. There is no prior milestone handoff.
3. Exact objective: leave a deployable, observable TypeScript product shell in which Next.js, Fastify, a BullMQ worker, PostgreSQL/PostGIS/pgvector, and Redis start through one documented workflow and expose truthful health/version UI and APIs.
4. Exact scope: create a pnpm/Turborepo with apps/web, apps/api, apps/worker and packages/contracts, db, config, observability, test-utils, and shared tooling; strict TypeScript and boundary linting; Docker Compose; CI; graceful startup/shutdown; health/readiness/system-info; an operations-token-gated idempotent smoke job; JSON Schema/Ajv contracts; deterministic clocks/IDs/PRNG/canonical JSON; unit, integration, Playwright, migration, and build checks; ADRs, runbooks, and M01 handoff.
5. Non-goals: no auth, users/worlds, primitives, manifests, compiler, event ledger, simulation, economy, multiplayer, WebGL, graph database, Kafka, Kubernetes, external AI, or speculative service split.
6. Required architecture: Node.js 22, strict TypeScript, pnpm/Turbo, Next.js App Router, Fastify modular monolith, BullMQ/Redis, Drizzle/PostgreSQL, TypeBox JSON Schema Draft 2020-12 with Ajv, OpenTelemetry-compatible instrumentation, Vitest/Testcontainers/Playwright. apps/web cannot import server/db; contracts are runtime-validatable and framework-free; PostgreSQL is durable and Redis is disposable. Use UUIDv7, UTC, stable error envelopes and correlation IDs.
7. Required data model: migration 0001 enables postgis, vector, citext, pgcrypto; migration 0002 creates platform_metadata with key PK, JSONB value, positive schema version, created/updated timestamptz and idempotent public runtime_versions seed. Use explicit constraints and Drizzle’s journal; never auto-migrate production startup.
8. Required APIs/events: GET /health/live, GET /health/ready, GET /api/v1/system/info, and feature-flagged POST /api/v1/system/smoke-jobs protected by an operations token, rate limit, schema validation, and Idempotency-Key. Add versioned bounded SystemSmokeRequested/Completed queue messages only; no domain or realtime events.
9. Required UI: accessible responsive / and /system routes with loading, healthy, degraded, unavailable, retry, and version states; never show raw infrastructure details. Hide smoke controls unless enabled and confirm submission.
10. Required tests: unit contracts/config/errors/redaction/deterministic utilities; Testcontainers migrations, extension queries, dependency timeout/recovery, queue at-least-once idempotency and restart; API contract/security tests; Playwright healthy/degraded/retry plus axe and 320px coverage; clean build and migration-drift tests. Tests cannot require a public network.
11. Security/integrity: validate config and fail closed in production, never commit/log/bundle secrets, recursively redact sensitive values, restrict origins and content types, set headers/body/time limits, rate-limit smoke, compare its token safely, use least privilege, pin dependencies, and keep telemetry low-cardinality.
12. Migration requirements: generate committed Drizzle migrations, prove clean up and repeat no-op, document extension prerequisites and forward-fix/restore strategy; do not rewrite migration history.
13. Documentation: add setup, architecture/dependency direction, commands, configuration, migrations, testing, API/error, observability, security baseline, and failure runbooks; record ADRs for the modular monolith, relational graph direction, server authority, contract format, queue role, and versioning. Create docs/milestones/M01-handoff.md with implementation summary, contracts/schema, exact migration head, tests and actual results, ADRs, operations, and risks.
14. Acceptance criteria: clean bootstrap reaches ready; Redis/DB loss gives 503 readiness but 200 liveness and automatically recovers; duplicate smoke idempotency key completes once; CI enforces all checks; spatial/vector probes work; accessible browser flows pass; unsafe production defaults fail; docs/handoff match code.
15. Commands to run: inspect available scripts first, then run the repository’s install, format check, lint, typecheck, unit tests, integration tests with PostgreSQL/Redis, migration apply/drift checks, Playwright tests, and production builds. Also perform the documented clean bootstrap. Never claim a command passed unless run; record exact commands, exit results, and any unavailable prerequisite.
16. Final response format: concise outcome first; then implementation summary; files added/changed grouped by area; migrations and resulting head; tests/commands with pass/fail; architecture decisions/deviations; security/operations notes; remaining risks/incomplete items. Never hide failure.
17. Preserve existing behavior: work directly in the current repository, retain compatible files and public contracts, avoid unrelated refactors, and do not silently change an existing API or script.
18. Completeness: implement production-quality core behavior; do not leave required functionality as TODOs, mocks, skipped tests, fake health, or placeholder packages. The local telemetry exporter may be no-op/console, but instrumentation and production configuration must be real.
19. Inspect first: before changes, inspect package files, source/layout, docs/ADRs, schemas, migrations/journal, tests, CI, git status, and environment examples. Respect user changes and existing conventions unless they violate a requirement above.
20. Deviations: if an explicit requirement is impossible or conflicts with a stronger repository constraint, explain it before or as soon as discovered, choose the smallest compatible alternative, add/adjust tests and documentation, and call it out in the final response and M01 handoff. Do not introduce a different stack without a documented compelling reason.
```

## Milestone 2 — Identity/membership/authority

### Outcome

A person can register or sign in securely, create a world, see only worlds available to them, invite another person, accept that invitation, and manage membership within explicit authority rules. World creator authority, platform administration, membership roles, and future in-world authority are represented as distinct concepts. Every protected mutation is an authenticated, validated, idempotent application command with an auditable security/authority decision; the web UI provides complete account, world, and membership flows.

### Why this milestone occurs now

All later data must have an authenticated actor, tenant/world boundary, and explicit authorization decision. Adding primitives or manifests before this boundary would create ownership ambiguities and cross-world data leaks. Governance offices and organization roles arrive later, but the authority engine needs an extensible subject/action/resource/context contract now so they can be added without replacing creator/member checks.

### User-visible demonstration

1. Register two local closed-alpha accounts, sign out, and sign back in; refresh the browser and confirm the session persists without exposing a token to JavaScript.
2. As user A, create “Floating Guild City.” Confirm A is its sole creator and sees it on the dashboard.
3. Invite user B as a player using a single-use expiring link. As B, accept it and open the world overview.
4. As B, attempt to rename the world, invite a user, promote a member, and inspect another unjoined world; confirm stable `403`/`404` behavior and no state change.
5. As A, promote B to world administrator, then confirm B can invite/revoke ordinary members but cannot transfer creator authority or remove the last creator.
6. Perform one explicit creator override with a required reason; view the authority audit record. Re-submit its idempotency key and confirm no duplicate change/audit.

### Scope

- Email/password closed-alpha authentication with Argon2id hashes, server-side opaque sessions, secure cookie transport, CSRF/origin protection, logout/revocation, idle/absolute expiry, and current-user endpoint.
- Users, sessions, worlds, memberships, invitations, scoped idempotency records, security audit records, and explicit creator-override records with migrations and constraints.
- World lifecycle state starts as `draft`; world creation atomically grants exactly one active `creator` membership. `created_by_user_id` is provenance, not an alternate authority source.
- Role foundation: world `creator`, `administrator`, `player`, `observer`; platform role `user` or separately granted `platform_admin`. Future office/organization/AI roles are represented as unsupported subject attributes, not conflated with current roles.
- A centralized deny-by-default RBAC+ABAC authority evaluator returning rule ID and machine-readable reason. All queries and mutations enforce world scope on the server.
- Versioned application command envelope/middleware for protected mutations, expected resource version checks, idempotency key/request-hash semantics, audit correlation, and stable errors. The full authoritative world event ledger remains Milestone 6.
- APIs and UI for registration/sign-in/out, account session view, world create/list/get/rename, invitation create/list/revoke/accept, membership list/role update/removal, and creator override confirmation/audit.
- Brute-force protection, generic authentication responses, safe invitation token handling, audit retention/privacy, docs, tests, and M02 handoff.

### Non-goals

- Social login, password reset email delivery, email verification, MFA, public signup, account deletion/export, teams, world transfer/deletion, or billing.
- Political offices, organizations, laws, delegated constitutional powers, AI agents, realtime presence, or the general event ledger.
- Primitive, manifest, compiler, simulation, financial, asset, or 3D behavior.

### Dependencies

- Milestone 1 shell, contracts/config/error/telemetry libraries, migration head, deterministic test utilities, and ADRs.
- `docs/milestones/M01-handoff.md`; implementation must reconcile its actual file layout, migration state, commands, and decisions before editing.

### Architecture and design

- The Fastify modular monolith gains `identity`, `worlds`, and `authority` modules. Routes call application command/query services; only repositories use Drizzle. Authentication establishes a server-owned actor context; authorization evaluates `(subject, action, resource, context)` and defaults to deny.
- The browser stores only `HttpOnly`, `Secure` in production, `SameSite=Lax`, narrowly scoped session cookies. The database stores a SHA-256/HMAC hash of a high-entropy opaque session token, never the token. Rotate on login and privilege change; logout/revocation takes immediate effect. CSRF uses strict allowed-origin checks plus a per-session double-submit token on unsafe methods.
- World membership is the sole current source of world role authority. `worlds.created_by_user_id` is immutable provenance. A partial unique index ensures one active creator; creator transfer is not exposed yet. Transactions and service rules prevent deleting/demoting the last creator.
- Invitation raw tokens appear only in the creation response/development mail sink and are stored hashed. Acceptance locks the invitation, verifies normalized email/expiry/status, and upserts one active membership atomically.
- Every protected mutation receives a server-built command envelope with actor, action, resource, request/correlation ID, schema version, expected row version, and idempotency key. An idempotency key reused with a different request hash is `409 IDEMPOTENCY_KEY_REUSED`; same request returns the stored response.
- Explicit override is a separate boolean path allowed only to creator/platform admin for a named override-capable rule, with nonblank bounded reason and immutable audit entry. It never grants future political powers implicitly.
- Errors avoid account/world enumeration: unauthenticated is `401`; unauthorized access to an unknown/not-visible world is consistently `404`; visible but forbidden operations may be `403` with a stable, nonsensitive code.

### Data model and migrations

- `users(id uuid PK, email citext unique not null, password_hash text not null, display_name text, status user_status not null, platform_role platform_role not null default 'user', auth_version integer not null default 1, row_version integer not null default 1, created_at, updated_at, last_login_at)`; checks bound display name and versions. Store normalized email through `citext` and never return `password_hash`.
- `sessions(id uuid PK, user_id FK restrict, token_hash bytea unique, csrf_hash bytea, auth_version, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revoke_reason, ip_prefix_hash, user_agent_hash)` with expiry/user indexes; checks expiry order. Cleanup is bounded and operational.
- `worlds(id uuid PK, slug citext unique, name text, lifecycle world_lifecycle default 'draft', created_by_user_id FK restrict, row_version integer default 1, created_at, updated_at, archived_at)` with length/version checks. Created-by is provenance only.
- `world_memberships(world_id FK, user_id FK, role world_role, status membership_status, row_version, joined_at, created_at, updated_at, removed_at, granted_by_user_id FK, primary key(world_id,user_id))`; partial unique `(world_id) where role='creator' and status='active'`; indexes by user/status and world/status. A deferred database constraint trigger plus service transaction prevents zero active creators.
- `world_invitations(id uuid PK, world_id FK, email citext, intended_role restricted to player/observer, token_hash bytea unique, status, expires_at, created_by_user_id, accepted_by_user_id nullable, accepted_at/revoked_at, created_at, row_version)` with partial unique active invite per world/email and time/status checks.
- `idempotency_records(scope, actor_id, key, request_hash, response_status, response_body jsonb, state, created_at, expires_at, primary key(scope,actor_id,key))`; bounded key/payload, cleanup index, no secret response content.
- `security_audit_records(id, actor_user_id nullable, world_id nullable, category, action, outcome, reason_code, target_type/id, request_id, correlation_id, redacted_metadata jsonb, occurred_at)` is insert-only to application roles. `creator_overrides(id, world_id, actor_user_id, action, target_type/id, reason, authority_rule_id, command_id, audit_record_id, created_at)` is insert-only and FK-linked.
- Migrations add enums/types, tables, composite/partial indexes, triggers, RLS-ready world keys, and deterministic local users/world fixtures only in test seed code. Verify upgrade from M01 and fresh install; never edit M01 migrations.

### APIs, commands, events, and realtime messages

- `POST /api/v1/auth/register`: `{email,password,displayName?}`; only when closed-alpha registration flag/dev invite permits; validates strength/length and rate limits; generic conflicts; creates user/session atomically; no idempotency requirement because normalized email is natural uniqueness; emits security audit `identity.registered`.
- `POST /api/v1/auth/login`: credentials to session/user; no existing auth; rate-limited per normalized account and privacy-preserving network bucket; generic `AUTHENTICATION_FAILED`; rotates session and records security audit. `POST /auth/logout` requires session+CSRF, is idempotent, revokes session. `GET /auth/me` returns safe user/session expiry. `POST /auth/csrf` rotates/returns the non-secret CSRF token.
- `CreateWorld {name,slug?}` returns world and creator membership; authenticated; name/slug schema and uniqueness; required `Idempotency-Key`; atomic; errors `WORLD_SLUG_TAKEN`, `VALIDATION_FAILED`; audit now, domain event adapter later.
- `RenameWorld {name,expectedRowVersion}`, `CreateInvitation {email,role,expiresIn}`, `RevokeInvitation`, `AcceptInvitation {rawToken}`, `ChangeMembershipRole`, and `RemoveMembership` use typed command schemas. Authorization is creator/admin per action, with stricter creator-only role changes; expected version and idempotency are enforced; each records allow/deny outcome and relevant security audit.
- `POST /worlds/:id/creator-overrides` wraps only an allowlisted target command and requires reason+confirmation token; creator/platform-admin authorization; creates exactly one override record and ordinary command audit in the same transaction.
- Queries include `GET /worlds`, `/worlds/:id`, `/worlds/:id/memberships`, `/invitations`, and `/authority/audit` with cursor pagination, server-side tenant filters, response schemas, and minimum necessary fields.
- Typed `IdentityRegistered`, `WorldCreated`, `InvitationCreated/Accepted/Revoked`, `MembershipRoleChanged/Removed`, and `CreatorOverrideUsed` application notifications are in-process contracts for now and explicitly not an authoritative event store. No WebSocket/realtime messages; UI refetches after success.

### User interface

- Add accessible `/register`, `/sign-in`, sign-out/session-expired handling, and protected-route return URLs that are validated as same-origin paths.
- `/worlds` has loading skeleton, first-world empty state, create dialog, validation/conflict errors, and responsive cards. `/worlds/[worldId]` has overview and members tabs with role badges and authority-aware controls.
- Invitation creation shows the raw link once with copy confirmation; acceptance handles signed-out, wrong-account email, expired, revoked, already-accepted, and success states without leaking membership lists.
- Membership role/removal and explicit override use confirmation dialogs describing consequences; the last creator control is disabled with explanatory text, but the server remains authoritative.
- Forms have labels, error summaries, focus placement, live status announcements, keyboard operation, 44px targets where relevant, and responsive single-column behavior.

### AI behavior

AI is not required and no AI provider is added. Display names, world names, invitation content, and override reasons are untrusted text: validate lengths/control characters, escape on render, and never interpolate them into future system prompts without delimiting and provenance. No deterministic fallback is needed.

### Security, privacy, abuse, and integrity

- Use a vetted Argon2id implementation with documented parameters and a server pepper from secret configuration; password max length prevents hashing DoS. Constant-time token/hash comparison, session rotation, expiry/revocation, generic login response, and throttling mitigate takeover/enumeration.
- Enforce CSRF/origin on every cookie-authenticated unsafe request, secure cookie flags, no auth tokens in local storage/URLs/logs, and cache-control `no-store` on identity/member responses.
- Every repository query includes world scope; authorization is server-side and deny-by-default. Add horizontal-privilege and guessed-ID tests. Never trust UI-hidden controls.
- Invitation tokens have at least 256 bits entropy, hashes at rest, short configurable expiry, single use, revocation, and no invitation of creator/admin role. Audit raw link access only by event, never content.
- Prevent last-creator removal/demotion under concurrency at database and service levels. Platform admin use and creator overrides are explicit, reasoned, immutable, and alerted.
- Minimize IP/user-agent data using keyed coarse hashes and retention; document audit/session retention and user-facing privacy behavior.

### Observability and operations

- Log authentication/authority outcomes with stable codes, request/command/correlation IDs and actor/world IDs where appropriate, never email/password/token/cookie/CSRF/raw invitation or request bodies.
- Metrics cover register/login success/failure/lockout, active/revoked/expired sessions, authorization denials by rule/action, invitation lifecycle, idempotency replay/conflict, override count, and latency; avoid email/user ID labels.
- Trace command parsing, actor lookup, authorization rule, idempotency lookup, transaction, and response. Insert security/override audits in the same transaction as successful protected changes where possible.
- Alert on login failure spikes, unusual creator overrides, repeated cross-world denials, invitation abuse, and session cleanup failure. Runbooks cover session revocation, compromised account auth-version bump, invite invalidation, last-creator repair under dual approval, and idempotency cleanup.

### Testing requirements

- Unit-test password policy/hash adapter, session/CSRF/token helpers, authority matrix/rule explanations, command/idempotency semantics, normalization, last-creator rules, error privacy, and audit redaction.
- Integration-test all migrations/constraints/triggers and every API against real PostgreSQL/Redis; include concurrent creator demotion/removal, duplicate world/invite/accept commands, invitation acceptance races, stale expected versions, expired/revoked sessions, and transaction rollback.
- Contract-test requests/responses/application notifications. Security tests cover fixation, CSRF, origin, brute-force limits, enumeration, horizontal/vertical privilege escalation, guessed identifiers, open redirects, unsafe rendering, token leakage, and cookie flags.
- Playwright runs registration/login/logout/session refresh, two-user invite/accept, role change, forbidden actions, override confirmation/audit, empty/loading/error/mobile states, keyboard flow, and axe checks.
- Deterministic fixtures create users/worlds through public application services with fixed clocks/IDs; tests must not use production password parameters where that would make CI impractical without a clearly isolated test setting.

### Acceptance criteria

- Two users complete the demo; session cookie is HttpOnly and no bearer/session/invitation secret appears in browser storage, URL history, client logs, or server logs.
- Every protected mutation without authentication is `401`; every cross-world direct-object attempt is consistently denied without existence leakage and leaves all tables unchanged.
- Creating a world atomically creates exactly one active creator membership; tested concurrent operations cannot leave zero or multiple active creators.
- Same idempotency key+request returns the original response and creates one change/audit; same key+different request returns `409`.
- Invitation tokens are stored only as hashes, expire/revoke/accept exactly once, and cannot grant administrator/creator.
- Creator overrides require explicit reason/confirmation and produce linked immutable audit records; ordinary creator actions are distinguishable from overrides.
- Upgrade from M01 and fresh migrations pass; all unit/integration/security/e2e/accessibility checks pass; M01 demo remains operational.
- Identity/authority/API/privacy/runbook docs and complete M02 handoff reflect actual schema, migration head, decisions, and test results.

### Definition of done

- Code and UI flows are complete without core TODOs/mocks; all required tests, lint, types, and builds pass.
- Migrations and upgrade are verified, constraints are concurrency-tested, and rollback/repair notes are documented.
- Demo, telemetry, alerts/runbooks, security review, API/authority matrix, privacy notes, and M02 handoff are complete.
- No known critical/high defect remains and all Milestone 1 health/build behavior remains operational.

### Risks and mitigations

- **Homegrown authentication weakness:** keep the custom surface narrow, use vetted hash/token primitives and OWASP-aligned controls, and plan independent review before alpha.
- **Role model conflates creator and government:** namespace platform/world roles now and make the evaluator accept future office/organization attributes without granting them.
- **Cross-tenant leakage:** make world ID mandatory in repositories, test guessed IDs, and prepare RLS rather than assuming controller checks alone.
- **Last creator race:** enforce inside one locked transaction plus a deferred database constraint.
- **Audit privacy:** schema-allowlist metadata, hash coarse network attributes, redact centrally, and set retention.

### Artifacts produced for later milestones

- Identity/session APIs, actor context, users/worlds/memberships/invitations schema, and deterministic two-user/world fixtures.
- Deny-by-default authority evaluator, action namespace/decision contract, creator override contract, and authority matrix.
- Application command envelope, expected-version/idempotency utilities, security audit records, and stable auth/authorization errors.
- World dashboard/detail/member UI and protected-route infrastructure.
- Identity/privacy/incident runbooks, migration head, ADR updates, and `docs/milestones/M02-handoff.md` retaining M01 state plus M02 results.

### Standalone implementation prompt

```text
Implement Milestone 2, “Identity/membership/authority,” for WorldGraph (codename Anvil).

1. Product context: WorldGraph builds persistent multiplayer city-state societies from approved manifests. The server and PostgreSQL are authoritative. Creator authority is distinct from future in-world government, organization, officeholder, AI-agent, and platform-admin authority. Every meaningful protected mutation must be authenticated, authorized, validated, idempotent where appropriate, and audited. No real money is involved.
2. Expected repository state: Milestone 1 should provide Node 22 strict TypeScript in pnpm/Turborepo; apps/web Next.js, apps/api Fastify modular monolith, apps/worker BullMQ; packages for TypeBox/Ajv contracts, Drizzle/PostgreSQL, config, telemetry, tests; PostGIS/pgvector/Redis Compose; health, CI, deterministic helpers and M01 handoff. Inspect the actual repository, git status, all package files, architecture/ADR docs, schemas, migration journal, tests and docs/milestones/M01-handoff.md before editing. Adapt paths to established conventions without weakening requirements.
3. Exact objective: users can securely register/login/logout, create/list/open a world, invite and admit a second user, manage permitted roles, receive denials for forbidden/cross-world actions, and execute an explicit reasoned creator override with immutable audit.
4. Exact scope: Argon2id email/password auth; opaque hashed server sessions in secure cookies; CSRF/origin defenses; expiry/revocation; users, sessions, worlds, memberships, invitations, idempotency, security audits and override schema; roles creator/administrator/player/observer plus separate platform role; deny-default RBAC+ABAC evaluator; versioned application command envelope; world/invite/member APIs; accessible auth/dashboard/member UI; tests, telemetry, runbooks and M02 handoff.
5. Non-goals: no OAuth, password-reset delivery, verification, MFA, public rollout, account deletion/export, world deletion/transfer, political offices/laws/organizations, event ledger, primitives, manifests, compiler, simulation, finance, realtime or WebGL.
6. Required architecture: add identity, worlds and authority modules to the Fastify monolith. Routes call application command/query services; only repositories use Drizzle. Server creates actor context. Authority evaluates subject/action/resource/context, returns allow/deny with rule ID, and defaults deny. Membership is the sole current world-role source; created_by is provenance. UI never decides permission. Raw sessions/invites are never stored. Protected mutations use actor, typed action/payload schema version, resource, expected row version, idempotency/request hash, request/correlation IDs. Do not build the M6 event ledger yet.
7. Required data model: implement the users, sessions, worlds, world_memberships, world_invitations, idempotency_records, security_audit_records and creator_overrides fields/indexes/FKs/checks described in this milestone. Use citext email/slug, UUIDv7, UTC, row versions, insert-only audits, hashed tokens, partial unique active invitation, partial unique active creator, and a concurrency-safe deferred rule preventing no creator. Never treat worlds.created_by_user_id as authority.
8. Required APIs/events: versioned register/login/logout/csrf/me; create/list/get/rename world; create/list/revoke/accept invitation; list/change/remove membership; creator override and audit queries. Require schemas, stable private errors, CSRF, authorization, expected version and Idempotency-Key as specified. Add typed in-process IdentityRegistered, WorldCreated, invitation/membership and override notifications, explicitly non-authoritative until M6; no realtime.
9. Required UI: accessible responsive register/sign-in/session expiry; protected /worlds empty/loading/create; world overview/members; one-time invitation-link display and all acceptance states; authority-aware member controls; consequence confirmations and override reason/confirmation; server errors and focus management. Validate return URLs as same-origin paths.
10. Required tests: unit password/session/CSRF/token, normalization, authority matrix, idempotency, last-creator, redaction/errors; real-DB API/migration/constraint tests; concurrent demotion/removal, invitation acceptance and duplicates; stale versions and rollback; security tests for fixation, CSRF/origin, enumeration, rate limits, guessed IDs, horizontal/vertical escalation, redirects, XSS and leakage; two-user Playwright flow, mobile/keyboard/axe; retain M01 suite.
11. Security/integrity: vetted Argon2id with documented production parameters and secret pepper; max password length; 256-bit tokens and constant-time checks; Secure/HttpOnly/SameSite cookies; strict origin plus per-session CSRF; no tokens in storage/URL/logs; generic login behavior; bounded throttles; no invite for admin/creator; no cross-world query; atomic last-creator protection; reasoned linked overrides; minimized/retained audit metadata.
12. Migration requirements: add forward Drizzle migrations after the existing head, never rewrite M01; verify upgrade and fresh application, constraints/indexes/triggers, repeat no-op, and document safe rollback/forward repair and test-only seed separation.
13. Documentation: update architecture, auth/session lifecycle, command envelope, authority action/role matrix, API/errors, privacy/retention, configuration, tests and runbooks for compromised account/session revocation, invite invalidation, last-creator repair and idempotency cleanup. Create docs/milestones/M02-handoff.md with implementation summary, schema/contracts, exact migration state, actual tests/results, ADRs/deviations, operations and risks; retain M01 inputs.
14. Acceptance criteria: complete the six-step demo; no browser/log secret leakage; cross-world requests do not reveal/expose state; exactly one creator is preserved under races; duplicate idempotency returns once and conflicting reuse is 409; invites hash/expire/revoke/accept once and cannot elevate; overrides require reason and linked audits; upgrade/fresh migrations and all checks pass; M01 remains operational.
15. Commands to run: use existing scripts after inspection; run install if needed, format check, lint, typecheck, unit, real PostgreSQL/Redis integration and migration tests, security tests, Playwright including accessibility, production builds, and the documented two-user demo/clean bootstrap. Record exact commands and truthful results; do not claim unrun tests.
16. Final response format: lead with outcome; implementation summary; changed/added files by area; migrations and head; tests/commands with actual outcomes; architecture/authority decisions and deviations; security/operations notes; remaining risks/incomplete items. Never hide failures.
17. Preserve behavior: work directly in the existing repository, preserve M01 health/smoke/build and compatible public contracts, respect user changes, avoid unrelated refactors, and version any necessary public contract change.
18. Completeness: no core TODOs, mocks, placeholder authorization, in-memory sessions/idempotency, skipped required tests, or client-only permission checks. Use real PostgreSQL transactions/constraints. A local development mail sink may display invite links, but invitation lifecycle must be real.
19. Inspect first: inspect packages, architecture/ADRs, contracts, Drizzle schema/migrations/journal, health/telemetry, CI/tests, environment docs, git status and M01 handoff before planning edits; follow conventions unless an explicit requirement is stronger.
20. Deviations: explain any necessary departure promptly, select the smallest compatible alternative, test/document it, and record it in the final response and M02 handoff. Do not silently weaken authority, session, audit, idempotency, or database invariants or change the selected stack.
```

## Milestone 3 — Primitive registry/retrieval

### Outcome

Authorized users can browse and search a versioned registry of reusable, schema-backed World Primitives, inspect exact versions and dependencies, and retrieve a deterministic ranked set for a world-design query. Platform administrators can validate, publish, deprecate, and reindex immutable primitive versions. A bundled city-state starter catalog makes retrieval useful without an AI key; optional embeddings improve ranking but never become authoritative or prevent lexical fallback.

### Why this milestone occurs now

Prompt-to-manifest generation needs a trusted, version-pinned vocabulary rather than invented mechanics. Identity and world scoping must exist before registry administration and usage can be authorized. The registry precedes manifest schema work so the next milestone can require every manifest reference to resolve to an immutable published primitive version and preserve retrieval provenance.

### User-visible demonstration

1. Sign in and open `/primitives`; filter published primitives by `government` and tag `city-state`, then inspect documentation, parameter schema, compatibility, and required dependencies for one exact version.
2. Search “guild-led energy-scarce floating city with a council and closed-loop credits.” Confirm a council/government primitive, closed-loop currency, energy/resource, district, and visual-style primitives rank predictably, with matched terms/tags and pinned versions shown.
3. Repeat the query with the embedding provider disabled; confirm lexical/tag retrieval succeeds with a visible “semantic ranking unavailable” notice and stable ordering.
4. As a normal user, attempt registry mutation and receive a stable denial. As platform admin, create a draft version, observe a dependency-validation failure, correct it, publish, and confirm its definition can no longer be edited.
5. Re-submit publish/reindex with the same idempotency key; confirm one publish and one current embedding/index record.

### Scope

- Define the `WorldPrimitive` meta-schema and supported MVP kinds: government, election, currency, tax, resource, production recipe, terrain, district, building, organization, office, legal right, player role, visual style, simulation rule, and event template.
- Store stable primitive keys separately from immutable semantic versions; include schema version, documentation, tags, compatibility constraints, required dependencies, configurable JSON Schema/defaults, behavior references, visual hints, lifecycle, hashes, and provenance.
- Validate semantic version syntax, stable key format, JSON Schema safety, defaults, dependency version ranges/cycles, behavior-reference allowlist, cross references, size/depth/count limits, and canonical content hashes.
- Provide admin create-draft, publish, deprecate, and reindex flows. Published semantic content is database-protected from update/delete; a new version is required.
- Provide cursor-paginated list/detail/version/dependency and deterministic hybrid retrieval APIs. Full-text/tag ranking always works; optional pgvector similarity is fused through reciprocal-rank fusion with deterministic tie breaks.
- Add an embedding provider interface, bounded BullMQ indexing job, content-hash cache, retries/dead-letter behavior, provider-disabled fallback, cost/rate controls, and provenance. Embeddings are derived/non-authoritative.
- Seed a reviewed, idempotent, exact-version city-state starter catalog sufficient for Milestones 4–8, including compatible council, closed-loop currency, district/terrain, energy resource, basic organization/office, visual style, and scheduled-event primitives.
- Build the primitive catalog UI and a minimal protected admin editor/publish workflow; add tests, telemetry, docs, catalog authoring guide, and M03 handoff.

### Non-goals

- User-authored public marketplace, arbitrary runtime code/scripts, remote URLs/assets, billing, ratings, automatic upgrades, or deletion of published versions.
- Prompt-to-manifest generation, manifest approval, compiler behavior, runtime entities, simulation execution, or economic transactions.
- Dependence on embeddings or an LLM for correctness; sophisticated recommendation personalization or fine-tuning.

### Dependencies

- Milestones 1–2: PostgreSQL extensions, queues/worker, contracts, canonical JSON/hashing, auth actor, platform role, authority evaluator, command/idempotency/audit utilities, UI shell, deterministic fixtures.
- `docs/milestones/M01-handoff.md` and `M02-handoff.md`, including their actual migration head, architecture deviations, and test commands/results.

### Architecture and design

- Add a `primitives` module with domain validator, repository, query/retrieval service, admin application commands, and indexing adapter. Registry records are data only. `behavior_ref` names an allowlisted compiler/simulation capability implemented in code; definitions cannot contain executable code, SQL, templates with execution semantics, or arbitrary URLs.
- A primitive stable key uses lowercase reverse-DNS-like segments (for example `worldgraph.government.council`); versions use strict SemVer. A manifest must later pin `{key, version}`—ranges are allowed only in dependency declarations and are resolved at retrieval/generation time.
- Publication canonicalizes the semantic definition, verifies its hash, resolves every required dependency to a published compatible exact version for the publication report, rejects prohibited cycles, validates defaults against parameter schema, and atomically marks it published. Published semantic columns are immutable; deprecation is separate lifecycle metadata.
- Index text is a bounded canonical composition of trusted field labels and untrusted documentation/tags. PostgreSQL weighted `tsvector` and tag matches form the required retrieval path. Optional vector results are separately ranked; reciprocal-rank fusion uses fixed weights and final `(score desc, stable_key asc, semver desc)` ordering. Scores are explanatory, not authorization.
- Index jobs carry only primitive version ID, content hash, index schema version, and provider configuration ID. Before writing, the worker rechecks content hash; unique keys and upserts make delivery idempotent. Timeouts/failure leave lexical search available and record a retryable indexing state.
- Retrieval applies lifecycle/kind/tag/compatibility filters before ranking, caps query/results, resolves dependencies, and returns exact versions, reasons, warnings, and provenance. No primitive text is placed in a privileged future system message as instructions.

### Data model and migrations

- `primitive_families(id uuid PK, stable_key citext unique, kind primitive_kind, display_name, created_by_user_id FK, created_at, updated_at)`; key/kind cannot change after first published version.
- `primitive_versions(id uuid PK, family_id FK restrict, semver text, primitive_schema_version integer, lifecycle draft/published/deprecated, documentation text, parameter_schema jsonb, defaults jsonb, compatibility jsonb, behavior_ref text nullable, visual_hints jsonb, provenance jsonb, content_hash bytea, row_version integer, created_by_user_id, created_at, published_by/at, deprecated_by/at, unique(family_id,semver))`; checks bound JSON/text/version fields and lifecycle timestamps.
- `primitive_tags(primitive_version_id FK cascade for drafts/restrict after publish, tag citext, primary key(...))` with tag index.
- `primitive_dependencies(primitive_version_id FK, dependency_family_id FK, version_range text, required boolean, parameter_mapping jsonb, primary key(primitive_version_id,dependency_family_id))`; no self-edge; publication service performs graph/cycle and range validation.
- `primitive_search_documents(primitive_version_id PK/FK, index_schema_version, content_hash, search_vector tsvector, normalized_text text, updated_at)` with GIN index.
- `primitive_embeddings(id uuid PK, primitive_version_id FK, provider text, model text, dimensions integer, content_hash bytea, embedding vector(1536), created_at, unique(primitive_version_id,provider,model,content_hash))` with an appropriate pgvector index only after measuring catalog size; exact search is acceptable for the small MVP catalog.
- `primitive_index_jobs(primitive_version_id, content_hash, index_schema_version, status, attempts, last_error_code, queued_at, completed_at, primary key(...))` records durable indexing state; BullMQ is only a wake-up mechanism.
- Database trigger rejects update/delete of published semantic fields, tags, and dependencies; lifecycle deprecation remains an audited command. Seed files live in version control, validate against the same contracts, and an idempotent CLI rejects hash mismatch rather than overwriting published content.

### APIs, commands, events, and realtime messages

- `GET /api/v1/primitives`: public-to-authenticated closed-alpha catalog query with cursor, kind/tag/lifecycle filters; only published by default; stable schemas and deterministic pagination.
- `GET /primitives/:key/versions/:version` and `/dependencies`: return exact definition/docs/resolved dependencies/provenance; draft visibility requires platform admin; `404` avoids leakage.
- `POST /primitive-retrievals`: `{query,kinds?,tags?,compatibility?,limit}`; authenticated; bounded/sanitized; returns ranked exact-version candidates with lexical/tag/vector rank contributions, dependency closure, index/provider state, and retrieval run ID; errors `QUERY_TOO_LARGE`, `NO_COMPATIBLE_PRIMITIVES`, `RETRIEVAL_UNAVAILABLE`; safe idempotent query.
- Admin commands `CreatePrimitiveDraft`, `PublishPrimitiveVersion`, `DeprecatePrimitiveVersion`, and `ReindexPrimitiveVersion` require platform admin, CSRF, expected row version, Idempotency-Key, strict schema, and reason for deprecation. Publish errors enumerate JSON pointers and stable dependency/schema codes.
- Application notifications `PrimitiveVersionPublished`, `PrimitiveVersionDeprecated`, `PrimitiveIndexRequested/Completed/Failed` feed audit/queue adapters; they are not yet M06 authoritative world events. No realtime client messages; generation-status polling is enough.

### User interface

- `/primitives` offers query, kind/tag filters, deterministic results, score explanation, provider-degraded notice, loading skeleton, no-results guidance, retryable failure, and cursor pagination.
- Detail shows stable key/version/lifecycle, rendered sanitized Markdown docs, parameter/default schema, dependency graph as accessible nested lists, compatibility, behavior/visual hints, hash, and provenance.
- `/admin/primitives` is platform-admin-only with JSON/schema-aware draft editor, field and JSON-pointer errors, dependency picker, validation report, publish confirmation emphasizing immutability, deprecation reason, and reindex state. The server independently authorizes everything.
- Preserve filters in URLs, support keyboard operation, semantic tables/lists, non-color status text, focus/error summary, reduced motion, mobile layout, and safe Markdown rendering with raw HTML/links disabled.

### AI behavior

- No generative model is used. An optional embedding provider receives only bounded normalized primitive index text and returns a fixed 1536-dimensional vector. Provider, model, content hash, index schema, latency, token estimate/cost where available, and timestamp are recorded.
- Primitive descriptions are untrusted data, separated/labeled as content, never treated as instructions, and never granted tools. Reject nonfinite/wrong-dimension vectors. Timeout, rate limit, cache by content hash, bounded retry, and dead-letter failures.
- The deterministic fallback is weighted PostgreSQL full-text plus exact tag/compatibility matching; it is always available and its stable ordering is covered by golden tests. Semantic failure never changes registry truth or publication.

### Security, privacy, abuse, and integrity

- Only platform admins mutate registry data; authorization/audit is server-side. Published content is immutable at DB level and changes require a new version. Deprecation cannot silently retarget consumers.
- Strict meta-schema, `$ref` allowlist/local resolution, max depth/properties/regex length, safe regex policy, canonicalization, and Ajv configuration prevent schema bombs, prototype pollution, remote reference fetches, and executable content.
- Sanitize Markdown, disallow raw HTML/javascript/data URLs and remote assets, bound search query/rate/result size, parameterize SQL, and test full-text/vector query abuse.
- Embedding calls receive no account/private world data in this milestone. Provider secrets stay server-side; index provenance and redacted failure codes are auditable.
- Seed provenance and hashes are reviewed. Behavior refs must be compile-time allowlisted; a primitive can describe behavior but cannot supply implementation.

### Observability and operations

- Logs/traces cover validation stages, publish transaction, dependency resolution, lexical/vector retrieval, fusion, enqueue and index execution with primitive ID/version and correlation IDs but no raw query by default.
- Metrics include catalog versions by kind/lifecycle, publish validation failures by code, retrieval latency/results/fallback rate, index backlog/age/failure, provider latency/errors/cost estimate, and content-hash cache hit.
- Alert on sustained index backlog/failure, sudden empty retrieval, or unexpected registry mutation failure. Feature flags select embedding provider and semantic-weight contribution without disabling lexical retrieval.
- Runbooks cover reindex all by schema version, rotate provider/model with side-by-side indexes, recover stuck jobs, deprecate compromised content, verify published hashes, and import/export the reviewed seed catalog.

### Testing requirements

- Unit-test meta-schema, canonical hash golden vectors, SemVer/range handling, defaults, behavior allowlist, dependency graph/cycles, query normalization, RRF scoring/tie breaks, and fallback.
- Real-DB tests cover extensions, GIN/vector queries, filters/pagination, immutable triggers, unique/check/FK constraints, publish/deprecate transactions, seed idempotency/hash mismatch, index job duplication/failure/recovery, and admin/normal-user isolation.
- Contract/security tests include remote `$ref`, malicious regex/deep JSON, prototype keys, huge queries, SQL-like content, unsafe Markdown/URLs, nonfinite/wrong vectors, cross-role access, and redaction.
- Playwright covers browse/filter/search/detail, degraded embedding, empty/error/mobile/keyboard/axe states, and admin invalid-dependency→publish→immutability flow.
- Golden retrieval fixtures assert exact ordered IDs/versions for fixed catalog and queries with embeddings disabled, and deterministic fusion with fixed fake vectors. Preserve M01–M02 tests.

### Acceptance criteria

- Version-controlled seed import publishes the documented starter catalog exactly once and a second import is a no-op; altered content under an existing published key/version fails.
- Every published version validates against the meta-schema, has a canonical hash and provenance, resolves required dependencies, and cannot have semantic fields/tags/dependencies updated or deleted through application credentials.
- The demo query returns the expected exact-version categories in a golden stable order without any AI/embedding key; optional vectors change only ranking, not filtering or validity.
- Normal users cannot mutate or view drafts; admins receive actionable JSON-pointer errors and duplicate publish/reindex is idempotent.
- Provider timeout/bad vector records failure, leaves lexical retrieval healthy, and exposes a sanitized degraded state.
- Fresh/upgrade migrations and all unit/integration/contract/security/e2e/accessibility tests pass; M01–M02 demos remain functional.
- Primitive/meta-schema/retrieval/ranking/authoring/reindex/runbook docs and complete M03 handoff match the implementation and exact migration head.

### Definition of done

- Registry, retrieval, admin/user UI, seed importer, fallback, and optional embedding adapter are production-quality with no core TODO/mock.
- Tests/lint/types/builds pass; migrations, seed repeatability, published immutability, and provider failure recovery are verified.
- Demo, telemetry/alerts/runbooks, security review, docs, and M03 handoff are complete; no critical/high known defect and all prior functionality remains operational.

### Risks and mitigations

- **Primitive schema becomes universal too early:** fix a small kind vocabulary, version the meta-schema, allow bounded kind-specific configuration, and require migrations for change.
- **Untrusted registry content becomes instruction/code:** enforce data-only schemas, sanitize rendering, label retrieved text, and map only allowlisted behavior refs to code.
- **Semantic retrieval is costly/flaky:** lexical path is required, vectors cached by hash, provider controlled by flag/limits, and failures degrade explicitly.
- **Published immutability blocks corrections:** publish a new SemVer and deprecate the old version; never overwrite consumers’ pinned references.
- **Ranking tests become brittle:** separate invariant tests from a small intentional golden catalog and version ranking weights/index schema.

### Artifacts produced for later milestones

- Versioned `WorldPrimitive` meta-schema, kind vocabulary, stable key/SemVer/dependency/provenance contracts, validation library, and starter catalog.
- Immutable registry tables, search/index tables, deterministic hybrid retriever, embedding adapter, reindex worker, and admin commands.
- Primitive browse/detail/admin UI and exact-version/dependency APIs.
- Golden retrieval fixtures and catalog authoring/security/operations documentation.
- Exact migration head and `docs/milestones/M03-handoff.md` carrying forward M01–M02 implementation/test/decision state.

### Standalone implementation prompt

```text
Implement Milestone 3, “Primitive registry/retrieval,” for WorldGraph (codename Anvil).

1. Product context: WorldGraph generates persistent multiplayer city-state societies. A World Primitive is versioned, reusable, schema-backed data with stable ID, docs, tags, dependencies, parameters/defaults, compatibility, validation, allowlisted behavior reference, visual hints, and provenance. Primitives and AI output are untrusted; no primitive executes code. PostgreSQL/server are authoritative and the MVP has no real money.
2. Expected repository state: M01–M02 provide strict TS pnpm/Turbo; Next/Fastify/BullMQ; Drizzle PostgreSQL with postgis/vector/citext/pgcrypto; Redis; contracts/Ajv, canonical JSON/hash and deterministic tests; auth/sessions, users/worlds/memberships, platform role, deny-default authority, application command/idempotency/security audits, UI/CI/telemetry. Inspect all code/config/package files, ADRs, schema/migrations/journal, tests, git status and docs/milestones/M01-handoff.md and M02-handoff.md. Use their actual migration head and conventions.
3. Exact objective: provide a useful immutable-version primitive registry, deterministic searchable retrieval with lexical fallback and optional semantic ranking, secure admin publication/indexing, a reviewed starter catalog, and accessible browse/admin UI.
4. Exact scope: WorldPrimitive meta-schema and listed MVP kinds; family/version/tag/dependency/search/embedding/index-job persistence; validation, publication/deprecation/reindex commands; list/detail/dependency/retrieval APIs; weighted FTS/tag plus optional vector reciprocal-rank fusion; embedding adapter/jobs/cache/failure state; city-state seeds sufficient for M04–M08; UI, telemetry, tests/docs and M03 handoff.
5. Non-goals: no public primitive authoring/marketplace, arbitrary scripts/code/URLs, auto-upgrades, prompt generation, manifests/compiler/runtime graph, simulation/economy, personalization or mandatory AI.
6. Required architecture: primitives module with framework-independent validator/domain, repository, retrieval service, admin commands and index adapter. PostgreSQL registry is authoritative; embeddings/search docs are derived; Redis/BullMQ only wake workers. Pin exact versions in consumers. Publish canonicalizes/hashes and atomically validates meta-schema/defaults/dependencies/ranges/cycles/behavior allowlist. Published semantic data is DB-immutable. Retrieval filters first, computes fixed weighted lexical/tag and optional vector ranks, fuses deterministically, returns reasons/provenance, and always falls back.
7. Required data model: add primitive_families, primitive_versions, primitive_tags, primitive_dependencies, primitive_search_documents with GIN tsvector, primitive_embeddings vector(1536), and durable primitive_index_jobs using the fields, indexes, FKs, checks, lifecycle timestamps and unique keys in the milestone. Add triggers preventing published semantic/tag/dependency update/delete while permitting audited deprecation. Seed files are version controlled; importer is idempotent and rejects same version/hash mismatch.
8. Required APIs/events: authenticated published catalog list; exact key/version detail and dependencies; bounded POST primitive-retrievals returning ranked exact versions, rank contributions, dependency closure and provider state; platform-admin CreatePrimitiveDraft, PublishPrimitiveVersion, DeprecatePrimitiveVersion and ReindexPrimitiveVersion with CSRF, schemas, row version, Idempotency-Key and audits. Add typed in-process publication/deprecation/index notifications and bounded versioned queue messages; no M06 ledger/realtime.
9. Required UI: accessible responsive /primitives query/filter/results/degraded/empty/error/pagination and detail with sanitized docs/schema/defaults/dependencies/hash/provenance. Platform-only /admin/primitives editor, JSON-pointer validation, dependency picker, immutable publish confirmation, deprecation reason and indexing state. URL-preserve filters, keyboard/focus/axe behavior; server authorizes independently.
10. Required tests: unit meta-schema/canonical hashes/SemVer/ranges/defaults/allowlist/dependency cycles/query/RRF/tie/fallback; real-DB migrations, FTS/vector, filters/cursors, triggers/constraints, publish/deprecate, seed idempotency/hash mismatch, duplicate/crashed indexing and auth; contract/security tests for remote refs, schema bombs/regex/prototype pollution, huge/injection queries, unsafe Markdown/URLs, vectors and redaction; golden offline retrieval and fixed-vector fusion; Playwright user/admin/degraded/mobile/keyboard/axe; preserve prior suites.
11. Security/integrity: platform admin only writes; deny/default and audit; strict local-only JSON Schema refs and resource limits; no executable fields/remote assets; allowlisted behavior refs; sanitized raw-HTML-free Markdown; parameterized bounded search/rate limits; provider secrets server-only and provider receives no private world/account data; published DB immutability and provenance hashes.
12. Migration requirements: append Drizzle migrations after actual M02 head; never edit old migrations; verify upgrade/fresh/no-op, triggers/indexes/extensions and restore/forward-fix. Keep test data separate; seed exact versions via idempotent reviewed CLI.
13. Documentation: update primitive contract/meta-schema/versioning, kind catalog, authoring/publication/deprecation, dependency resolution, retrieval scoring/fallback, embedding privacy/cost, APIs/errors, migrations, security and reindex/recovery runbooks. Create docs/milestones/M03-handoff.md with summary, schema/contracts/catalog versions, migration head, actual tests/results, ADRs/deviations, provider/ops state and risks; retain prior inputs.
14. Acceptance criteria: seed import exactly once and hash conflict fails; every published version validates/resolves/hashes/provenance and is DB-immutable; fixed query returns expected stable exact versions with embeddings disabled; vector failure degrades visibly and lexical remains healthy; normal user mutations fail, admin invalid dependency is actionable and publish/reindex idempotent; all checks/migrations pass and prior demos remain.
15. Commands to run: after inspecting scripts, run install if required, catalog/schema validation and seed dry run, format/lint/typecheck, unit, real PostgreSQL/Redis integration/migration/security tests, golden retrieval offline and fixed vector tests, Playwright/axe, production builds, clean seed twice, and demo. Record exact commands/results; never claim unrun success or hide provider-unavailable tests.
16. Final response format: outcome first; implementation summary; files by area; migrations/head and seeded key@versions; tests/commands/results; ranking/architecture decisions and deviations; security/provider/operations notes; remaining risks/incomplete items.
17. Preserve behavior: edit the existing repository directly, preserve M01–M02 health/auth/world/invite flows and compatible contracts, honor user changes, avoid unrelated refactors, and version any necessary contract change.
18. Completeness: no core TODOs, mock registry, in-memory search, mutable published rows, fake vector success, arbitrary code, skipped required tests, or AI-key dependency. Optional provider may be disabled, but its adapter/failure/caching contracts and real lexical fallback must be complete.
19. Inspect first: inspect packages, modules, boundaries, contracts, migrations/journal, auth/authority/idempotency, queue/telemetry, UI/tests/docs, git status and all prior handoffs before editing; follow established conventions unless they violate a stated invariant.
20. Deviations: identify any necessity immediately, choose the smallest compatible alternative, test and document it, and include it in final response/M03 handoff. Never silently weaken immutability, dependency validation, data-only safety, provenance, deterministic retrieval or the fixed stack.
```

## Milestone 4 — Manifest studio & walking skeleton

### Outcome

A creator can open a draft world, enter a short description, receive a versioned city-state World Manifest assembled from exact published primitives, review its assumptions/provenance/validation, edit it as safe YAML or a structured form, compare revisions, and explicitly approve a valid immutable version. Generation runs asynchronously with a schema-constrained AI path and a fully working deterministic offline fallback. The journey from sign-in through world creation to approved declarative intent is integrated; it does not yet create mutable runtime world state.

### Why this milestone occurs now

The manifest must consume exact primitive contracts and operate inside an authenticated world boundary, so Milestones 2–3 are prerequisites. It must precede the compiler so the compiler receives a stable, validated, approved, content-addressed input rather than prompt text. Keeping runtime seeding in Milestone 5 preserves the invariant that a prompt cannot directly mutate authoritative state while still delivering the first half of the early walking skeleton.

### User-visible demonstration

1. Sign in, create a draft world, open its Manifest Studio, and enter: “An energy-scarce floating city-state governed by competing guilds using closed-loop credits.”
2. Submit once; observe queued/running states, then a draft containing pinned primitive versions, districts, institutions, currency intent, initial actors/organizations, assumptions, unresolved warnings, and retrieval/model provenance.
3. Disable the AI provider and repeat in a second world; confirm the deterministic fallback produces a valid usable manifest and the same input/catalog/template/seed produces the same canonical content hash.
4. Introduce an invalid primitive version and duplicate district key in YAML; confirm parsing/validation shows accessible JSON-pointer/source-location errors and approval is blocked without changing the prior revision.
5. Correct the document by selecting a published primitive, review the semantic diff, validate, type the world name in the approval confirmation, and approve it.
6. Confirm the approved canonical JSON/hash/version cannot be edited, the world shows `manifest approved`, and a new edit/regeneration creates a child draft rather than mutating it. No runtime entity has been created yet.

### Scope

- Define and version `WorldManifest` v1 for the bounded city-state: metadata, seed, exact primitive references/configuration, districts/connections, institutions, organizations, actor blueprints, economy intent, initial relationships, simulation settings, visual direction, assumptions, and extension namespace.
- Define a generation-output envelope containing draft manifest, assumptions, unresolved questions/warnings, suggested fixes, and per-field provenance; define canonical JSON, safe YAML projection, hashes, and schema migration hooks.
- Add immutable manifest revisions/versions, prompt submissions, generation runs, retrieval snapshots, validation reports, approval/supersession state, and pointer from world to current approved manifest.
- Implement async prompt analysis/retrieval/generation through BullMQ with strict input/output schemas, provider adapter, time/token/cost/concurrency limits, bounded repair attempts, cancellation, and durable status. Implement a production-quality deterministic city-state template fallback.
- Layer validation: JSON/YAML syntax and limits, manifest JSON Schema, semantic key/reference/dependency/compatibility checks, graph connectivity, bounded counts, critical mechanic presence, and warning/fix reporting. Never silently invent high-impact rules.
- Implement safe edit-as-new-revision, structured core fields, exact primitive picker, validate, diff, regenerate-as-child, approve, version history, and read APIs/UI.
- Approval requires current creator authority, a fully valid latest revision, expected version/hash, explicit confirmation, and idempotency. Approved content and provenance are immutable; prompts never trigger compilation.
- Add telemetry, AI safety/privacy controls, tests, docs, and M04 handoff.

### Non-goals

- Runtime compilation, WorldGraph entity/relationship persistence, world activation, 3D/WebGL preview, simulation, economy execution, governance execution, natural-language patches, or direct geographic drawing.
- Arbitrary manifest code/templates/URLs, remote schema references, general world archetypes, collaborative simultaneous editing, or fully automatic approval.
- Treating AI output, YAML, warnings, or retrieved primitive prose as authoritative state.

### Dependencies

- Milestones 1–3: deployable shell/worker, users/worlds/creator authority, commands/idempotency/audit, primitive registry/exact-version retrieval, canonical JSON/hash, schema validation, UI and deterministic fixtures.
- Complete M01–M03 handoffs, exact migration/catalog state, architecture decisions, and test results.

### Architecture and design

- Add `manifests` domain/application module, `generation` orchestration module and provider ports. The generation worker reads a durable run, performs intent extraction to a strict envelope, retrieves published primitives, generates a strict candidate, then invokes the same validator used by manual edits. It may write only generation/revision records—not runtime tables.
- Manifest v1 is data-only. `primitiveRefs` pin key+SemVer and carry schema-validated parameters. Local stable keys identify blueprints; relationships refer to those keys. Extensions require namespaced JSON with size/depth limits. Schema/version and seed are explicit.
- Store every revision as immutable canonical JSON plus SHA-256 content hash. YAML is a bounded human projection: parse with aliases, custom tags, merge keys, duplicate keys, executable tags, and non-JSON values disabled; canonical JSON is authoritative. Editing/regeneration creates a monotonically numbered child revision under a locked world manifest stream.
- Validation stages return stable severity/code/JSON Pointer/source location, related pointers, and explicit suggested structured fixes. Errors block approval; warnings require acknowledgement but do not silently alter content. Primitive resolution uses the registry snapshot and exact versions; publication/deprecation after retrieval does not retarget the revision.
- Approval transaction locks the world and revision, revalidates against current supported schema/exact pinned definitions, verifies expected row version and content hash, marks one revision approved/current, supersedes the previous approved pointer where applicable, and records audit. It does not enqueue compilation.
- AI provider output is parsed only against the generation schema; reject unknown keys, unknown IDs, unpinned primitive refs, control characters, excessive counts, and illegal references. At most two bounded repair attempts receive only validation errors and the prior structured candidate. A circuit breaker selects the deterministic fallback.
- Deterministic fallback derives a slug/name safely, uses fixed template version plus provided/fixed seed and pinned starter primitives, creates at least two districts, one council/guild organization, one currency intent, actor blueprints, and valid relationships. Its hash is reproducible for identical normalized input, catalog snapshot, template version, and seed.

### Data model and migrations

- `world_prompt_submissions(id uuid PK, world_id FK, submitted_by_user_id FK, prompt_text encrypted-or-access-restricted text, normalized_hash bytea, client_seed text, created_at, retention_until)`; bounds text and indexes world/time. Prompt access is creator/admin only.
- `manifest_generation_runs(id, world_id, prompt_submission_id, requested_by, status queued/running/succeeded/failed/cancelled, generator_schema_version, prompt_template_version, provider/model nullable, seed, input_hash, output_revision_id nullable, attempts, token counts/cost estimate nullable, error_code, queued/started/completed timestamps, row_version, unique(world_id,input_hash,prompt_template_version))` subject to chosen idempotency scope.
- `generation_retrieval_items(run_id FK, rank, primitive_version_id FK restrict, retrieval_score, reason jsonb, content_hash, primary key(run_id,rank), unique(run_id,primitive_version_id))` freezes exact retrieval provenance.
- `manifest_revisions(id uuid PK, world_id FK, revision_number bigint, parent_revision_id nullable FK, manifest_schema_version integer, canonical_manifest jsonb, content_hash bytea, source generation/manual/import, generation_run_id nullable, created_by, created_at, approval_status draft/approved/superseded/rejected, approved_by/at, warning_acknowledgements jsonb, row_version, unique(world_id,revision_number), unique(world_id,content_hash))`. Trigger forbids content/schema/provenance changes after insert and approval reversal; status transitions are allowlisted.
- `manifest_validation_reports(id, manifest_revision_id FK, validator_version, primitive_catalog_snapshot_hash, valid boolean, diagnostics jsonb, report_hash bytea, created_at, unique(revision,validator_version,catalog_hash))` is immutable.
- `manifest_field_provenance(manifest_revision_id, json_pointer, source_type prompt/primitive/model/fallback/manual, source_ref, source_hash, created_at, primary key(revision,pointer,source_type,source_ref))` with bounded pointers.
- Add `worlds.current_approved_manifest_revision_id` nullable FK and `manifest_schema_version` compatibility field; constraint/trigger ensures pointer belongs to that world and is approved. Seed only deterministic test prompt/manifests through fixtures, not production migration.
- Migrations preserve M01–M03 data and include immutability/ownership triggers, indexes for status/world/version, queue polling, and validation lookup. Document prompt retention/deletion without deleting approved provenance hashes.

### APIs, commands, events, and realtime messages

- `StartManifestGeneration {prompt,seed?}` at `POST /worlds/:id/manifest-generations`; creator/admin; draft world only; size/schema/rate/budget checks; Idempotency-Key; returns `202 runId/status`; errors include `WORLD_NOT_DRAFT`, `GENERATION_LIMIT`, `NO_COMPATIBLE_PRIMITIVES`, `PROVIDER_UNAVAILABLE` only if fallback also fails.
- `GET /manifest-generations/:runId` returns durable status/progress stage, sanitized error, cost estimate, output revision; membership-scoped. `CancelManifestGeneration` is creator/admin, idempotent, and prevents publication of late output through status compare-and-set.
- `CreateManifestRevision {baseRevisionId,expectedHash,format,jsonOrYaml}` parses/validates and creates immutable child; `ValidateManifestRevision` creates/reuses a report; `ApproveManifestRevision {expectedWorldVersion,expectedContentHash,acknowledgedWarningCodes,confirmationName}` requires creator (administrator may edit but not approve by default), valid report, Idempotency-Key and lock.
- Queries return current/history/revision, canonical JSON or safe YAML, validation report, provenance, and structural/semantic diff with cursor pagination and world scoping.
- Application notifications `ManifestGenerationRequested/Succeeded/Failed`, `ManifestRevisionCreated/Validated`, and `ManifestApproved` go to audit/queue adapters but are not yet the M06 event ledger. Queue messages are schema-versioned IDs/hashes, not raw prompts when avoidable. No WebSocket; UI polls with capped backoff.

### User interface

- `/worlds/[id]/manifest` is a staged studio: Describe, Draft, Validate, Review, Approve. It restores durable run state after refresh and clearly distinguishes draft intent from runtime state.
- Describe has bounded prompt/seed, privacy notice, cost/latency expectation and cancel. Draft offers structured essential fields plus a safe YAML editor, exact-version primitive picker, validation gutter/error summary, assumptions/warnings/fixes and provenance inspector.
- Review provides accessible tree/semantic diff, added/removed/changed counts, validation severity filters, unresolved-mechanics callouts and downloadable canonical JSON/YAML. Empty, first-run, queued, long-running, provider-degraded, cancelled, malformed, conflict and retry states are complete.
- Approval shows exact revision/hash/schema, warning acknowledgements and typed world-name confirmation. Approved view is read-only and offers “create child revision”; compile is described as the next action but no fake enabled compile behavior is added.
- Keyboard navigation, focus-to-error, ARIA live job status, semantic tabs, contrast, reduced motion, autosave status (only if real), unsaved-change guard, and mobile read/review behavior are tested. The raw editor may recommend desktop but remains readable.

### AI behavior

- Inputs: normalized creator prompt, explicit seed/constraints, manifest v1 schema, a system-authored task contract, bounded retrieved exact primitive summaries/schemas/dependencies, and prior validation errors only during repair. Primitive/prompt text is delimited and labeled untrusted.
- Output: strict `ManifestGenerationEnvelopeV1`; provider structured-output/JSON-schema mode where supported, then local Ajv validation. Unknown/action/tool/code fields fail. The model has no database, network, command, URL-fetch or tool capability.
- Persist provider/model, prompt-template and generator schema versions, input/output hashes, exact primitive versions/ranks, per-field provenance, attempts, latency, token usage/cost estimate, and validation report. Do not retain chain of thought; raw provider payload is disabled or access-restricted/short-retained.
- Retry only transient provider failures with jitter; perform at most two schema-repair calls and never repair critical mechanics silently. If invalid/unavailable/over budget, use the deterministic template and mark provenance/limitations. Identical fallback inputs are byte-reproducible.
- Per-user/world concurrency, prompt size, output token, timeout, daily budget, caching by non-sensitive input hash, cancellation, and feature flags bound cost/latency. Approval is always human and generation never invokes compile or runtime commands.

### Security, privacy, abuse, and integrity

- Treat prompt, YAML, primitive docs and model output as untrusted. Use strict schemas/local refs/resource bounds, no arbitrary URLs/code, safe YAML settings, escaped UI rendering, and prompt/content separation; regex-only injection detection is never a boundary.
- Authorize every run/revision/query by membership and approval by creator. Lock and compare hashes/versions to prevent approving stale or swapped content. Cross-world revision/run IDs return non-enumerating errors.
- Rate/concurrency/cost limit generation and validation. Scan logs/traces to ensure prompt/manifests/provider payloads are not emitted; prompts have documented access/retention, while hashes/provenance needed for an approved manifest remain.
- Primitive refs must resolve to exact immutable published versions and behavior allowlists; all entity keys/refs are bounded, normalized and unique. Approval cannot bypass errors, even by creator override in this milestone.
- YAML parser prohibits aliases/entity expansion, custom tags, duplicate keys and prototype keys. Diff and Markdown renderers sanitize content.

### Observability and operations

- Trace submit→queue→intent/retrieval→generation/fallback→validation→revision with run/request/correlation IDs and content hashes, not raw content. Logs use stage, provider/model, stable validation/error codes and retry count.
- Metrics include run status/latency, queue wait, provider/fallback/repair rate, token/cost estimate, validation errors/warnings by code, retrieval count, approval conversion, cancellations, stale conflicts and prompt retention cleanup.
- Dashboard/alerts cover queue age, failure/fallback spike, cost ceiling, validator error spike, stuck running jobs and approval failures. Feature flags control provider, model/config, budgets and generation rollout; fallback remains on.
- Runbooks cover cancelling/retrying stuck runs, disabling provider, replaying from input/catalog snapshot, invalidating a compromised draft, validator/schema release, prompt deletion, and repairing an inconsistent approved pointer without editing manifest content.

### Testing requirements

- Unit-test manifest and output schemas, canonical JSON/YAML golden conversions, hash determinism, key/reference/dependency/compatibility/connectivity validation, diagnostics/fixes, diffing, fallback golden outputs, provider parse/repair/circuit/cost behavior.
- Real-DB/worker tests cover migrations/triggers/FKs, generation idempotency, duplicate deliveries, cancellation race, immutable revisions, monotonic numbering, simultaneous edits/approvals, current pointer, stale hash/version, provider timeout and transaction rollback.
- Contract/security tests cover prompt injection strings, unknown primitive/behavior, remote refs/URLs/code-like fields, YAML aliases/tags/duplicates/depth bombs/prototype pollution, cross-world IDs, XSS rendering, excessive inputs, approval bypass and redaction.
- Playwright covers the six-step demo, polling/refresh recovery, fallback mode, manual edit validation, diff, warning acknowledgement/approval, immutable approved version, error/empty/mobile/keyboard/axe states.
- Golden fixture fixes prompt, seed, catalog versions and fallback-template version and asserts canonical bytes/hash. Optional provider tests use a schema-faithful fake, never assert prose. Preserve M01–M03 suites.

### Acceptance criteria

- The demo prompt produces a schema-valid revision with exact published primitive versions, assumptions, warnings and provenance; provider-disabled fallback is usable and golden deterministic.
- A generation run/retry/duplicate queue delivery creates at most one output revision for its idempotent input; cancellation cannot later publish output.
- Invalid YAML/schema/semantic references produce stable pointer/location errors and cannot be approved; prior revision remains unchanged.
- Approval requires creator, latest revalidation, expected hash/world version, warning acknowledgement and confirmation; one current approved immutable revision results.
- Editing/regenerating an approved manifest creates a new child draft and never changes runtime tables or triggers compilation.
- Provider/model has no authoritative tool path; raw untrusted content/secrets do not enter logs. Cost/rate/concurrency limits and fallback are tested.
- Upgrade/fresh migrations and all checks pass, prior demos remain operational, and complete manifest/AI safety/privacy/operations docs plus M04 handoff match reality.

### Definition of done

- Generation, fallback, validation, revision/diff/approval APIs and complete studio UI are production-quality without core TODOs/mocks or direct runtime mutation.
- Tests/lint/types/build pass; migrations, immutability, concurrency, deterministic golden output and provider-failure recovery are verified.
- Demo, observability/alerts/runbooks, AI/security review, docs, and M04 handoff are complete; no critical/high known defect and previous milestones remain operational.

### Risks and mitigations

- **Manifest v1 is too broad:** restrict to city-state fields required by the next compilers, version schema, and put experimental data only in bounded namespaced extensions.
- **AI creates plausible but incoherent rules:** exact primitive grounding, layered validation, explicit assumptions/warnings/fixes, deterministic fallback, and mandatory approval.
- **YAML/canonical drift:** canonical JSON is authoritative; test golden round trips and reject unsupported YAML features.
- **Async duplication/stale approval:** durable run states, unique input/output keys, status compare-and-set, world locks and expected hashes/versions.
- **Sensitive prompt leakage/cost:** access/retention policy, telemetry redaction, caching, limits, cancellation, provider flag and offline fallback.

### Artifacts produced for later milestones

- `WorldManifestV1`, generation-envelope, diagnostics/fix, provenance, canonicalization/hash, YAML projection, diff and migration-hook contracts.
- Immutable manifest/prompt/generation/validation/provenance tables and current-approved pointer with exact primitive snapshots.
- Generation/provider orchestration, deterministic fallback, validator and Manifest Studio UI/APIs.
- Golden approved floating-city and offline fallback fixtures for compiler/replay tests.
- AI safety/privacy/operations docs, exact migration/catalog state, and `docs/milestones/M04-handoff.md` retaining all prior decisions/tests.

### Standalone implementation prompt

```text
Implement Milestone 4, “Manifest studio & walking skeleton,” for WorldGraph (codename Anvil).

1. Product context: a creator describes a persistent multiplayer city-state; WorldGraph retrieves immutable primitives and proposes a versioned declarative World Manifest for review/approval. A manifest is intent, never mutable runtime state. Prompt/model output cannot mutate or compile a world, is untrusted, and must be schema-validated. Server/PostgreSQL remain authoritative; no real money.
2. Expected repository state: M01–M03 should provide strict TS pnpm/Turbo, Next/Fastify/BullMQ/Redis, Drizzle PostgreSQL/PostGIS/pgvector, contracts/TypeBox/Ajv/canonical JSON/deterministic tests, auth/world/member/creator authority/commands/idempotency/audits, immutable primitive registry with exact SemVer dependencies, deterministic lexical retrieval and optional embeddings, starter catalog and UI/telemetry. Inspect all files, packages, ADRs, schemas/migrations/journal, tests, git status, and M01–M03 handoffs first; use actual migration/catalog state.
3. Exact objective: an authenticated creator can prompt, receive a durable schema-valid exact-primitive draft via bounded AI or deterministic fallback, inspect/edit/validate/diff/provenance, and explicitly approve one immutable manifest revision without creating runtime state.
4. Exact scope: WorldManifestV1 city-state and generation-envelope schemas; canonical JSON/safe YAML/hash/diff/provenance/validation; prompt/run/retrieval/revision/report persistence; async generation, provider adapter, limits/repair/cancel/fallback; create/edit/validate/history/diff/approve APIs; full Manifest Studio; telemetry, security/privacy, tests/docs and M04 handoff.
5. Non-goals: no compiler/runtime entities/activation, WebGL, simulation/economic/governance execution, patches/rollback, drawing/collaborative editor, arbitrary code/URLs/schema refs, general world types or auto-approval.
6. Required architecture: manifests and generation modules. Worker processes durable runs and may write only run/revision/validation/provenance records. Manifest is data-only and pins key+SemVer/config; local blueprint keys and typed refs. Each edit/regeneration creates immutable monotonic child revision; canonical JSON is authority and YAML is safe projection. Layer syntax/schema/semantic/dependency/compatibility/connectivity validation with stable diagnostics/fixes. Approval locks world/revision, revalidates, compares hash/version, updates one approved pointer, audits, and never compiles. Provider has no tools.
7. Required data model: add world_prompt_submissions, manifest_generation_runs, generation_retrieval_items, manifest_revisions, manifest_validation_reports, manifest_field_provenance and worlds.current_approved_manifest_revision_id/schema compatibility using fields, indexes, hashes, FKs, immutability/status triggers and cross-world pointer constraint described above. Prompts restricted/retained; revisions/reports/provenance immutable. Production migration seeds no user world.
8. Required APIs/events: Start/Cancel/Get ManifestGeneration; Create/Validate/Get/List/Diff ManifestRevision; ApproveManifestRevision with creator-only default, expected world version/content hash, warnings, confirmation and idempotency. Return structured statuses/diagnostics/provenance. Typed in-process generation/revision/approval notifications and versioned ID/hash queue jobs only; no M06 ledger or WebSocket.
9. Required UI: /worlds/[id]/manifest stages Describe/Draft/Validate/Review/Approve; durable polling/refresh/cancel; structured essentials plus safe YAML and exact primitive picker; pointer/location errors, assumptions/warnings/fixes/provenance; accessible semantic diff/download; all loading/empty/degraded/conflict/error states; hash/schema confirmation and immutable approved view/new child. Keyboard/focus/ARIA/mobile/axe.
10. Required tests: unit schemas, canonical JSON/YAML/hash golden, refs/dependencies/connectivity, diagnostics/fixes/diff/fallback/provider parse/repair/limits; real DB/worker migrations, duplicate delivery/idempotency/cancel races, immutable/monotonic revisions, concurrent edits/approval, stale versions/hashes/pointer and rollback; injection/schema/YAML bombs/remote refs/code/URLs/prototype/cross-world/XSS/limits/redaction security; six-step Playwright fallback/edit/diff/approve/immutability/refresh/mobile/keyboard/axe; preserve prior tests.
11. Security/integrity: prompt/YAML/primitive/model content untrusted and delimited; strict local schemas and resource bounds; safe YAML disables aliases/custom/merge/duplicate/prototype features; no model tools/DB/network/actions; exact published refs/allowlisted behaviors; world-scoped auth and creator approval; hash/version locks; no approval override of errors; prompt privacy/retention and telemetry redaction; per-user/world rate/concurrency/cost limits.
12. Migration requirements: append after actual M03 head; do not edit old migrations. Verify upgrade/fresh/no-op, immutability/cross-world/status triggers/indexes/FKs and restore/forward repair. Schema migration hooks may be defined, but do not invent ManifestV2.
13. Documentation: manifest v1 examples/semantics/versioning, canonical JSON/YAML, diagnostics/fixes, generation/provider/fallback/provenance, approval lifecycle/authority, APIs/errors, prompt privacy/retention, costs/config, tests and stuck-run/provider/schema/pointer repair runbooks. Create docs/milestones/M04-handoff.md with summary, schema/catalog refs, migration head, actual tests/results, ADRs/deviations, AI/ops state and risks, retaining M01–M03 inputs.
14. Acceptance criteria: complete six-step demo; exact refs/provenance; deterministic valid fallback hash; duplicate/cancel safety; invalid input cannot approve/change prior revision; approval creator+revalidation+hash/version+warnings+confirmation yields one immutable current revision; child edits do not mutate runtime/compile; provider has no authority/leaks; all migrations/checks and prior demos pass.
15. Commands to run: inspect scripts, then installation if needed, schema/catalog validation, format/lint/typecheck, unit/golden fallback, real PostgreSQL/Redis worker/migration/concurrency/security tests, Playwright/axe, production builds, clean upgrade and demo with provider disabled; run provider contract tests with deterministic fake. Record exact truthful results and unavailable optional live-provider checks.
16. Final response format: outcome; implementation summary; files by area; migrations/head and manifest/schema/template versions; tests/commands/results; architecture/AI decisions/deviations; security/privacy/operations notes; remaining risks/incomplete items. Never hide failures.
17. Preserve behavior: work in current repository, preserve M01–M03 health/auth/world/invite/primitive flows and public contracts, respect user edits, avoid unrelated refactors, version any necessary change.
18. Completeness: no core TODOs, in-memory revisions/jobs, permissive model parsing, fake fallback, mutable approved content, silent fixes, skipped tests or compile/runtime placeholder. Provider may be disabled but adapter/failure path and real deterministic fallback must be complete.
19. Inspect first: inspect packages/modules/boundaries, contracts/catalog, Drizzle schema/migrations, auth/authority/idempotency, queue/telemetry, UI/tests/docs, git status and every prior handoff before edits; follow conventions unless an explicit invariant is stronger.
20. Deviations: surface necessity promptly, use smallest compatible alternative, test/document it and record in final/M04 handoff. Never silently weaken manifest/runtime separation, exact versioning, approval, schema/AI safety, immutability, determinism or selected stack.
```

## Milestone 5 — Deterministic compiler/WorldGraph seeding

### Outcome

A creator can compile an approved manifest into a content-addressed, reproducible compiled artifact and atomically activate a persisted authoritative WorldGraph. The world overview exposes read-only entities and typed relationships—including districts, institutions, organizations, actors, account-to-character control, and their connections—without a 3D client. Recompiling the same manifest/primitive bundle with the same compiler version and seed yields identical logical artifacts and hash; any validation or persistence failure leaves no partially seeded world.

### Why this milestone occurs now

Compilation requires an immutable approved manifest and exact primitive versions from Milestones 3–4. It precedes the event ledger, simulation, and economy because those systems need stable entity keys, graph relations, world/version boundaries, and a deterministic initial state. This completes the early prompt-to-persisted-world walking skeleton while deliberately using a graph-shaped relational model rather than introducing a graph database.

### User-visible demonstration

1. Open the approved floating-guild-city manifest from Milestone 4 and click “Compile world.” Observe queued, validating, compiling, seeding, and activated states that survive refresh.
2. Open the resulting World Overview; confirm world/compiler/manifest/schema/seed versions and artifact hash are visible.
3. Browse persisted entities by type and inspect a district, council, guild, creator character, currency definition intent, and typed inbound/outbound relationships. Confirm at least one `located_in`, `governs`, `member_of`, and `account_controls` edge exists where the manifest implies it.
4. Run the documented reproducibility command twice in isolated databases/processes; confirm canonical artifacts and hashes are byte-identical although physical database row IDs/timestamps may differ.
5. Compile a deliberately invalid cyclic/missing-reference fixture; confirm structured diagnostics, no active world version, no orphan entity/relation rows, and a safe retry after correction.

### Scope

- Define versioned contracts for compiler input bundle, compiled world/artifact, world entity, world relationship, compiler diagnostic, visual-plan placeholder data (declarative only), and active world version.
- Implement an allowlisted compiler adapter registry for supported primitive kinds/behavior references, deterministic dependency resolution/topological ordering, stable logical key generation, deterministic seeded PRNG, canonical sorting/serialization, hashes, and validation.
- Resolve and hash the approved canonical manifest plus every exact primitive definition/dependency, manifest/schema/compiler versions, seed, and compiler configuration. Refuse missing, incompatible, changed-hash, deprecated-policy, unsupported adapter, duplicate key, dangling edge, or unsafe numeric input.
- Compile districts, connections, institutions, organizations, actor/account/character blueprints, primitive instances, economy/configuration intent, simulation configuration, and a replaceable visual plan into immutable artifacts.
- Persist one compilation run, artifacts, one world design version, initial entities/relationships, controller bindings, and runtime head atomically under a world lock. Activate only after all invariants pass; retry/idempotency cannot duplicate the seed.
- Add async compile/status APIs, read-only world summary/entity/relationship/neighbor APIs, compiler diagnostic download, artifact/reproducibility CLI, and graph-oriented browser UI.
- Upgrade world lifecycle from approved draft to active. A later manifest child remains intent and cannot mutate the active world; patches/migrations arrive later.
- Add deterministic/golden/failure/concurrency/security tests, telemetry, compiler/graph docs and M05 handoff.

### Non-goals

- Runtime player mutation, generic command/event ledger/history replay, simulation ticks, balances/ownership, markets, governance execution, patches, rollback, realtime, WebGL rendering, or procedural assets.
- Executing primitive-provided code, arbitrary scripts, remote URLs, nondeterministic LLM calls, or automatically compiling on approval.
- Recompiling over an active world or treating compilation as a general patch mechanism; initial activation only in this milestone.

### Dependencies

- Milestones 1–4, especially the exact M03 primitive catalog/hash state and immutable approved M04 manifest/retrieval/provenance bundle.
- M01–M04 handoffs, migration head, deterministic golden world/prompt, architecture/contract decisions, actual tests, and unresolved risks.

### Architecture and design

- Add a framework-independent `compiler` module with pure `resolve → validate → normalize → lower → link → emit` stages. Each stage receives immutable data and returns data plus ordered diagnostics. Database/queue/UI adapters surround it; the pure compiler cannot read wall time, environment, database, network, Redis, filesystem, or AI.
- Compiler adapters are code reviewed and keyed by supported primitive kind/allowlisted behavior reference. Primitive configuration is validated before invocation. Unknown adapters fail with `UNSUPPORTED_PRIMITIVE_BEHAVIOR`; primitive data never imports or evaluates code.
- `CompilerInputBundleV1` contains canonical manifest bytes/hash, sorted exact primitive bytes/hashes/dependency closure, manifest and primitive schema versions, compiler version/config version, and explicit seed. The input hash covers all semantic bytes. A documented integer-only seeded PRNG and stable key namespace are the only variability source.
- Compiled artifacts use stable logical entity/relationship keys and never include database UUIDs, timestamps, run IDs, object iteration order, locale, timezone, floating nondeterminism, or provider data in their semantic hash. Physical rows use UUIDv7 but refer to stable logical keys; golden tests compare canonical artifacts.
- Persistence takes a transaction-scoped PostgreSQL advisory lock on world ID and uses `SERIALIZABLE`. It verifies the world/current approved revision/hash, writes or reuses the compilation run, artifacts, next world version, entities, relationships, controller bindings and runtime head, then changes the active pointer/lifecycle. Any error rolls back everything except a separately durable failed-run diagnostic update.
- The relational WorldGraph stores typed entities and edges with composite same-world foreign keys and indexed source/target/type access. No recursive arbitrary graph query endpoint is exposed; bounded neighbor queries prevent denial of service.
- Initial active members are compiled into non-PII account-principal and player-character entities, `account_controls` edges, and server authorization bindings. Email/session data never enters artifacts. Membership changes after activation do not create actors until a later command-enabled milestone.

### Data model and migrations

- `world_compilation_runs(id uuid PK, world_id FK, manifest_revision_id FK, input_hash bytea, compiler_version text, compiler_config_version integer, seed text, status, requested_by_user_id, idempotency_key, diagnostics jsonb, artifact_hash bytea nullable, queued/started/completed_at, row_version, unique(world_id,input_hash,compiler_version,compiler_config_version,seed))` with legal-state trigger.
- `compiled_world_artifacts(id uuid PK, compilation_run_id FK, artifact_kind, artifact_schema_version integer, canonical_content jsonb, content_hash bytea, created_at, unique(run,artifact_kind))`; immutable insert/delete protection after successful run.
- `world_versions(id uuid PK, world_id FK, version_number bigint, parent_world_version_id nullable, manifest_revision_id FK, compilation_run_id FK, world_schema_version integer, compiler_version, seed, artifact_hash, status staging/active/superseded, created_by, created_at, activated_at, unique(world_id,version_number), unique(compilation_run_id))`; one active partial unique per world.
- `world_entities(id uuid PK, world_id FK, logical_key citext, entity_type text, entity_schema_version integer, state jsonb, created_world_version_id FK, retired_world_version_id nullable FK, row_version bigint default 0, created_at, updated_at, unique(world_id,logical_key), unique(world_id,id))`; type/key/state checks and GIN only for approved bounded query fields, not indiscriminate JSON indexing.
- `world_relationships(id uuid PK, world_id FK, logical_key citext, relationship_type text, source_entity_id, target_entity_id, relationship_schema_version, attributes jsonb, created_world_version_id, retired_world_version_id nullable, row_version bigint default 0, created_at, updated_at, unique(world_id,logical_key), unique(world_id,id), composite FK(world_id,source/target) to world_entities(world_id,id))`; indexes `(world_id,source,type)`, `(world_id,target,type)` and active type; endpoint/type validation.
- `world_entity_controllers(world_id, user_id FK, entity_id, control_scope text, granted_world_version_id, revoked_at, primary key(world_id,user_id,entity_id,control_scope), composite FK world/entity)`; it is the authorization mapping and has a corresponding graph edge, but contains no session/email data.
- `world_runtime_heads(world_id PK/FK, active_world_version_id FK, state_revision bigint default 0, last_ledger_sequence bigint default 0, updated_at)` establishes separate design version and mutable-state revision for M06.
- Add `worlds.active_world_version_id` with cross-world/status constraint and lifecycle states `manifest_approved`, `compiling`, `active`, `compile_failed`. Test seeds are application fixtures. Migrations upgrade M04 without compiling existing worlds automatically.

### APIs, commands, events, and realtime messages

- `StartWorldCompilation {manifestRevisionId,expectedManifestHash,seed}` at `POST /worlds/:id/compilations`; creator only; approved current revision and unactivated world; schema/version/Idempotency-Key/cost bounds; returns `202`; conflicts include `MANIFEST_NOT_CURRENT`, `WORLD_ALREADY_ACTIVE`, `COMPILATION_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`.
- `GET /worlds/:id/compilations/:runId` returns stage/status, ordered diagnostics, input/artifact hash and versions; members may read according to role. `RetryWorldCompilation` creates/reuses a run only after retryable failure and unchanged input.
- `GET /worlds/:id/runtime-summary`, `/entities`, `/entities/:logicalKey`, `/relationships`, and `/entities/:logicalKey/neighbors` are authenticated/member-scoped, cursor-paginated, bounded/filter-allowlisted, response-schema validated, and include runtime/design revision metadata for caching.
- Internal application notifications `WorldCompilationRequested/Started/Failed/Succeeded` and `WorldActivated` drive queue/audit adapters; they are not retroactively called the M06 ledger. Queue payload contains IDs/hashes/schema only and is idempotent. No realtime messages; UI polls with capped backoff.
- CLI `worldgraph compile --manifest <fixture> --catalog <snapshot> --seed <seed> --output <dir>` and `worldgraph verify-artifact` run the pure compiler offline and return nonzero on diagnostics errors/hash mismatch without writing runtime tables.

### User interface

- Approved manifest view gains a creator-only Compile panel with exact input versions/seed, confirmation, disabled/ineligible explanations, durable progress, cancel only before seeding begins, retryable/nonretryable diagnostics, and safe navigation/refresh.
- `/worlds/[id]/overview` shows lifecycle, active world version, manifest/compiler/schema/seed/artifact hash and entity/relation counts. It clearly labels the graph as authoritative and the future visual view as a projection.
- `/worlds/[id]/graph` provides accessible searchable/filterable entity and relationship tables, bounded neighbor inspection, typed attributes, inbound/outbound edges, empty/loading/error/cursor states and links back to manifest provenance. It need not render a node-link canvas.
- Errors use stable diagnostic codes, JSON pointers and source primitive/entity links. Long JSON is collapsible/downloadable; focus, keyboard tables, screen-reader labels, contrast, reduced motion and responsive layouts are tested.

### AI behavior

AI is not used during compilation. The compiler accepts only the approved canonical manifest and exact stored primitive versions and performs no model/network call. Any visual-plan output is deterministic declarative data, not generated media. There is no retry/repair by AI; structured diagnostics require a new manifest revision. This boundary is enforced with dependency rules and tests that compile with network disabled.

### Security, privacy, abuse, and integrity

- Creator authorization, CSRF, expected manifest hash/version, idempotency, world advisory lock, bounded compile input/count/depth and rate/concurrency limits prevent unauthorized or duplicate activation.
- Validate all references/types/params again at compile time; content hashes detect registry/database corruption. Never execute behavior/data, fetch URLs, parse unsafe code, or accept a client-supplied compiled artifact as authoritative.
- Same-world composite FKs prevent cross-world edges/controllers. Repository queries scope world; bounded pagination/neighborhood depth and allowlisted filters mitigate graph enumeration/DoS.
- Artifacts contain no email, session, invitation, prompt text, secrets, IP data, or raw model response. Account-principal identifiers are pseudonymous stable world-local keys.
- Transaction/constraint/trigger design ensures one active version, unique logical keys, valid endpoints and all-or-nothing seed. Failed diagnostics are sanitized and do not leak draft content to unauthorized members.

### Observability and operations

- Stage traces and structured logs record run/world IDs, compiler/input/artifact versions/hashes, stage duration, counts and diagnostic codes; never entire manifests/entity state. Metrics track queue/stage latency, success/failure by code, entity/edge counts, lock waits, serialization retries, hash mismatch, reproducibility failures and orphan checks.
- Dashboard/alerts cover compile backlog/stuck run, failure spike, long locks, unsupported primitive adapter, unusually large artifact, activation inconsistency, and deterministic golden regression.
- Feature flags gate compiler version activation and maximum world size, not correctness checks. Runbooks cover retry, failed-run cleanup, artifact verification, active-pointer repair under audited maintenance, compiler rollback for future runs, and detecting/removing orphan staging data.
- A release cannot silently change compiler output under the same compiler/config version. CI fails when golden output changes without an explicit version bump and ADR/changelog.

### Testing requirements

- Unit-test every pure compiler stage, dependency ordering/cycles, adapter allowlist, stable keys, PRNG vectors, numeric normalization, canonical ordering/hash, diagnostics, dangling/duplicate/cross-type edges and artifact verification.
- Golden reproducibility tests compile fixed M04 manifests/catalog snapshots across repeated processes, timezone/locale settings and shuffled input/map insertion order; exact canonical bytes/hash must match. Changed seed/input/compiler version must produce expected different input identity.
- Real-DB/worker tests cover migrations/FKs/triggers, duplicate queue/idempotency, two concurrent compiles, advisory lock/serialization retry, late cancellation, transaction rollback at injected stages, failed-run diagnostics, no orphans, one active version and controller/edge consistency.
- API/security tests cover creator/member/cross-world access, stale/swapped manifest hash, unsupported/mutated primitive, excessive graph/query depth, malicious state keys, client artifact injection and telemetry redaction.
- Playwright covers the five-step demo, refresh/status/retry, diagnostics navigation, overview/graph filtering, empty/mobile/keyboard/axe. Preserve M01–M04 tests and prove no compile occurs on approval alone.

### Acceptance criteria

- The approved golden manifest compiles and activates exactly one world version with the specified entity/relation types and a persisted account-controls-character binding visible through APIs/UI.
- Two isolated runs from identical canonical manifest, exact primitive bytes/hashes, compiler/config versions and seed produce byte-identical artifacts and SHA-256 hash; CI requires a version bump for intentional golden change.
- Concurrent/duplicate starts produce one successful seed; failure at any persistence stage leaves no active pointer or orphan seed rows and is safely retryable.
- All relationships have existing same-world endpoints, all logical keys are unique, and one active world version/runtime head exists; database constraint tests prove these invariants.
- Compilation makes no AI/network call, executes no primitive code, and accepts no client-compiled authority. Artifact contains no identity secrets/private prompt.
- Read APIs are world-scoped, bounded and versioned; the graph UI completes the demo and remains usable without WebGL.
- Upgrade/fresh migrations and every required check pass; M01–M04 demos still work; compiler/graph/version/runbook docs and M05 handoff are accurate.

### Definition of done

- Pure compiler, adapters, durable async run, atomic seeding, artifact CLI/APIs and graph/overview UI are complete with no core TODOs/mocks.
- Lint/types/builds/tests pass; migrations, deterministic golden outputs, failure/concurrency recovery, hash verification and security checks are complete.
- Demo, telemetry/alerts/runbooks, architecture/security review, docs, and M05 handoff are complete; no critical/high defect and previous functionality remains operational.

### Risks and mitigations

- **Hidden nondeterminism:** isolate compiler, inject PRNG, ban wall-clock/network/locale/unsorted iteration, use integer/fixed representations, and gate golden changes on compiler version.
- **JSONB becomes an untyped dumping ground:** every entity/edge has a schema version and type validator; index/query only named fields; evolve with migrations.
- **Partial/duplicate activation:** one serializable locked transaction, unique input/run/version keys, status CAS, same-world FKs and injected-failure tests.
- **Primitive/adapter mismatch:** hash exact closure, version adapter registry, fail with diagnostics and never execute primitive data.
- **Graph query abuse:** cursor limits, allowlisted filters, one-hop bounded neighbors, tenant predicates and metrics.

### Artifacts produced for later milestones

- `CompilerInputBundleV1`, `CompiledWorldV1`, `WorldEntityV1`, `WorldRelationshipV1`, diagnostics, artifact/hash and world-version contracts.
- Pure deterministic compiler, seeded PRNG, adapter registry, artifact verifier/CLI and golden compiled worlds.
- Atomic WorldGraph schema, active version/runtime head, logical-key conventions and user-to-entity controller bindings.
- Read-only runtime/graph APIs and overview/graph UI used by ledger, simulation, economy and later clients.
- Compiler/versioning/repair docs, exact migration head, and `docs/milestones/M05-handoff.md` carrying prior summaries/schema/migrations/tests/ADRs forward.

### Standalone implementation prompt

```text
Implement Milestone 5, “Deterministic compiler/WorldGraph seeding,” for WorldGraph (codename Anvil).

1. Product context: WorldGraph turns a creator-approved, data-only World Manifest into an authoritative persistent city-state graph. The same canonical manifest, exact primitive versions/hashes, compiler/config version and seed must reproduce the same logical compiled artifact. The relational graph/simulation is authoritative and works without 3D. AI cannot compile/mutate; no real money.
2. Expected repository state: M01–M04 provide strict TS pnpm/Turbo, Next/Fastify/BullMQ/Redis, Drizzle PostgreSQL/PostGIS/pgvector, contracts/canonical JSON/hash/deterministic utilities, auth/world/creator authority/commands/idempotency/audits, immutable primitive registry/retrieval/catalog, WorldManifestV1 generation/fallback/validation/revisions/provenance/approval and golden floating-city fixture. Inspect packages, code, ADRs, schemas/catalog, migrations/journal, tests, git status and every M01–M04 handoff before editing; use actual paths/head/versions.
3. Exact objective: explicitly compile an approved manifest into a content-addressed deterministic artifact, atomically seed/activate one relational WorldGraph version, and expose authoritative entities/typed relationships in an accessible read-only UI/API.
4. Exact scope: compiler input/artifact/entity/relationship/diagnostic/version contracts; pure resolve/validate/normalize/lower/link/emit pipeline; allowlisted primitive adapters; exact closure/hash, PRNG, stable keys/canonical sort; async run/status; artifacts/world versions/entities/relationships/controllers/runtime head; serializable locked all-or-nothing activation; offline compile/verify CLI; graph APIs/UI; tests/telemetry/docs/M05 handoff.
5. Non-goals: no runtime player mutation or general event ledger/history, simulation, balances/assets/markets/governance, patches/rollback, realtime/WebGL/media, primitive code, AI/network calls, automatic approval compile, or compile-over-active-world.
6. Required architecture: pure compiler has no DB/Redis/fs/network/env/wall clock/AI and uses only explicit immutable input and documented integer seeded PRNG. Code-owned versioned adapters map allowlisted kinds/behavior refs; data cannot execute. Semantic artifact excludes DB IDs/timestamps/run metadata/locale/order. Persistence uses transaction advisory world lock plus SERIALIZABLE, rechecks approved revision/hash, writes run/artifacts/version/graph/controllers/head and active pointer atomically. PostgreSQL relational entities/edges with same-world composite FKs; bounded queries.
7. Required data model: add world_compilation_runs, compiled_world_artifacts, world_versions, world_entities, world_relationships, world_entity_controllers, world_runtime_heads and worlds.active_world_version_id/lifecycle changes with the fields, versions, hashes, indexes, state triggers, unique input/run/logical-key/one-active constraints and composite same-world FKs specified above. Upgrade does not auto-compile existing worlds.
8. Required APIs/events: creator StartWorldCompilation with current approved revision/hash/seed/Idempotency-Key; get/retry run with ordered diagnostics; member-scoped runtime summary, entity list/detail, relationship list and bounded neighbors; offline compile/verify commands. Add typed application/queue compilation requested/started/failed/succeeded/activated notifications carrying IDs/hashes only; no M06 ledger/realtime.
9. Required UI: approved manifest Compile confirmation/status/refresh/cancel-before-seed/retry/diagnostics; world overview versions/seed/hash/counts; accessible responsive graph entity/edge tables, filters, neighbor inspection and provenance links, with loading/empty/error/cursor/mobile/keyboard/axe states. Do not fake a 3D view.
10. Required tests: pure stage/adapters/dependencies/keys/PRNG/numeric/order/hash/diagnostic tests; golden byte/hash reproducibility across process/timezone/locale/shuffled inputs and version-change guard; real DB/worker migrations/FKs/triggers, duplicates/concurrent compile/locks/serialization/cancel and injected rollback/orphans/one-active/controllers; API authorization/cross-world/stale hash/mutated primitive/limits/injection/redaction; five-step Playwright and accessibility; preserve M01–M04 and prove approval alone does not compile.
11. Security/integrity: creator+CSRF+version/hash/idempotency/rate bounds; revalidate all data/exact hashes; no code/URL/network/AI/client artifact authority; same-world FKs/repository scopes/bounded graph queries; no emails/sessions/prompts/secrets/raw model payload in artifact; pseudonymous local account keys; one transaction guarantees no partial state.
12. Migration requirements: append Drizzle migrations after actual M04 head, never edit old history; verify upgrade/fresh/no-op, all composite/partial constraints/triggers/indexes, injected failure rollback and restore/forward repair. Test fixtures compile through services, not production seed migration.
13. Documentation: compiler input/stages/adapters/determinism/PRNG/stable keys, artifact schemas/hashing/version bump policy, relational graph/data ownership/query limits, activation lifecycle, APIs/errors/CLI, tests and retry/orphan/hash/active-pointer repair runbooks. Create docs/milestones/M05-handoff.md with summary, schema/contracts, exact migration and compiler/catalog/manifest versions, actual tests/results, ADRs/deviations, ops and risks, retaining all prior inputs.
14. Acceptance criteria: complete five-step demo; expected graph/control edge; identical inputs yield byte/hash-identical artifacts and intentional change needs version bump; duplicates/concurrency activate once; injected failure leaves no partial/orphans and retries; DB same-world/logical-key/one-active invariants; no AI/network/code/client authority or private artifact data; bounded scoped UI/API; all upgrades/checks/prior demos pass.
15. Commands to run: inspect scripts, then install if needed, schema/catalog/manifest validation, format/lint/typecheck, unit and golden compiler suite under multiple timezone/locale/order settings, real PostgreSQL/Redis migration/worker/concurrency/failure/security tests, offline compile twice and verify hashes, Playwright/axe, production builds, clean upgrade/demo. Record exact commands and honest results.
16. Final response format: outcome; implementation summary; files by area; migrations/head and compiler/artifact/schema versions; artifact/entity/edge counts and hash; tests/commands/results; architecture/determinism decisions/deviations; security/operations; remaining risks/incomplete items. Never hide failures.
17. Preserve behavior: work directly in existing repo, preserve M01–M04 health/auth/world/invite/primitive/manifest flows and compatible contracts, respect user changes, avoid unrelated refactors, and version migrations/contracts rather than silently changing them.
18. Completeness: no core TODOs, mock compiler, in-memory run, placeholder graph, nondeterministic random/time, skipped tests, client-generated authority, or automatic compile. Physical IDs may vary only because they are excluded from semantic artifact; logical output must be real and deterministic.
19. Inspect first: inspect all modules/boundaries/contracts/catalog/manifests, Drizzle schema/migrations, authority/idempotency/queue/telemetry, UI/tests/docs, git state and M01–M04 handoffs before edits; follow conventions unless an explicit invariant is stronger.
20. Deviations: report necessity immediately, choose the smallest compatible approach, test/version/document it and record final/M05 handoff. Never silently weaken determinism, exact input closure, manifest/runtime separation, transactional activation, graph tenant integrity, no-AI compiler boundary or fixed stack.
```

## Milestone 6 — Command/event ledger/history

### Outcome

Every authoritative world mutation now enters a single versioned command pipeline, receives an authenticated actor and authorization decision, is checked for idempotency and expected revision, and is durably accepted or rejected. Accepted commands atomically append typed domain events, tamper-evident ledger entries, projection updates, and transactional outbox messages. A member can inspect understandable world history, and operators can verify the hash chain and deterministically replay current projections from a documented genesis anchor without changing the active world.

### Why this milestone occurs now

The compiler supplies a deterministic genesis graph and runtime head; the ledger can therefore anchor and evolve a concrete state rather than an undefined model. Simulation and financial commands must not be added before ordering, idempotency, optimistic concurrency, event schemas, projection/replay, and audit semantics are proven. Refactoring existing world-scoped mutations now prevents later domains from creating parallel write paths.

### User-visible demonstration

1. Open an active world and rename an allowed entity through its detail view. Confirm the response contains command ID, accepted status, new state revision, and event/ledger positions; refresh and see the projected name.
2. Submit the same command/idempotency key again; confirm the exact prior result and one event. Reuse the key with different payload and receive `409` with no event.
3. From a stale browser tab submit against the old expected revision; confirm a recorded rejected command with `REVISION_CONFLICT`, no projection change, and a refresh action.
4. Use History to filter by actor/entity/event and open an entry showing command, authorization basis, event summary, correlation/causation, design version, state revision, and explicit creator override status without exposing sensitive payloads.
5. Run ledger verification and projection replay into an isolated shadow projection for the golden world; confirm the hash chain is intact and the replay checksum equals live state.
6. Corrupt a disposable test ledger/projection; confirm verification detects the exact first bad sequence and the documented repair flow never edits an event in place.

### Scope

- Define versioned `CommandEnvelope`, command result/rejection, actor, domain event, ledger entry, event metadata, projection checkpoint, and outbox message contracts with canonical serialization/upcasting rules.
- Implement a command bus that authenticates, schema-validates, authorizes, resolves explicit override, reserves idempotency, checks expected design/state/aggregate versions, executes an allowlisted handler in a transaction, and returns stable outcomes.
- Persist accepted and rejected commands; accepted state-changing handlers append immutable typed events, update synchronous authoritative projections, advance one world state revision, append hash-chained ledger entries, and write outbox records atomically.
- Add event registry/upcasters, per-world and per-aggregate ordering, optimistic concurrency, transaction retry policy, correlation/causation, payload redaction/classification, and creator/system/AI actor distinctions.
- Adapt existing world-scoped mutation entry points from Milestones 2–5 to the command bus without breaking their public routes. Identity login/session internals remain security-audit operations; reads, generation computation, and pure compilation are not fabricated as domain events.
- Add a production command `RenameWorldEntity` for allowed entity types/fields to prove end-to-end projection behavior; no generic arbitrary JSON mutation command.
- Add durable genesis anchoring for already active worlds and direct genesis event creation for newly compiled worlds. Do not invent historical detail that was not recorded.
- Add transactional outbox dispatcher, readable history projection/API/UI, ledger verify/export, replay-to-shadow/checksum CLI, operational repair controls, tests, docs, and M06 handoff.

### Non-goals

- Event sourcing every authentication/session/read/job-status table, deleting current projections, arbitrary temporal queries, event deletion/editing, automatic rollback, branching timelines, or cross-world global ordering.
- Simulation ticks/schedules, currency/assets, markets, governance, patches, realtime WebSockets, or AI actions.
- A generic client-submitted command type, generic JSON patch, user-written event/handler, Kafka, or a separate event-store service.

### Dependencies

- Milestones 1–5: actor/authority/override and idempotency foundations, immutable approved manifests, compilation artifacts, initial graph projections, controller bindings, active world version and runtime head.
- M01–M05 handoffs and exact migrations/contracts/compiler/golden-world state. Existing deployments must be inventoried before genesis anchoring.

### Architecture and design

- `commands` owns the only public authoritative write pipeline; domain modules register named, schema-versioned command handlers and event reducers. Route adapters may preserve existing endpoints but create the same envelope. Repositories reject direct projection writes outside a command transaction except explicitly named compiler/genesis and audited repair paths.
- Pipeline order is fixed: authenticate actor → parse canonical envelope/payload → reserve/check idempotency → load resource and authorize → compare world design/state and aggregate versions → execute pure decision logic → in one `SERIALIZABLE` transaction append command result/events/ledger/outbox, update projections/checkpoints/head → commit → dispatch outbox asynchronously. Validation/authorization/conflict rejection is durably recorded with redacted payload hash and no domain event.
- A per-world ledger-head row locked `FOR UPDATE` allocates contiguous ledger sequence and carries previous entry hash. `entry_hash = SHA-256(canonical versioned entry fields + previous_hash)`. This is tamper-evident, not protection from a fully privileged database administrator; backups/external checkpoint metrics strengthen detection.
- Each event has a per-world event sequence and per-aggregate version. One accepted mutating command increments `world_runtime_heads.state_revision` once; all its events carry that resulting revision and ordered ordinal. Expected state revision gives whole-world optimistic concurrency; handlers may additionally lock/check aggregate versions.
- Current `world_entities`, `world_relationships`, membership/world pointers and future domain tables remain synchronous query projections. Reducers are deterministic, versioned, side-effect-free apart from repositories, and idempotent by event ID. Async readable history and future notifications consume the outbox at least once with unique consumer receipts.
- Existing active worlds receive one honest `WorldStateImportedV1` genesis event/entry containing active artifact hash, projection schema versions, row counts and canonical state checksum—not fabricated prior actions. A release backfill is idempotent, locks each world, and blocks new commands until `ledger_anchored_at` is set. New activation writes `WorldCompiledGenesisV1` atomically.
- Replay reads ordered immutable events from genesis, applies upcasters and reducers into isolated shadow tables/schema, compares canonical projection checksum, and only swaps a projection through a separate explicitly confirmed, audited maintenance operation. Replay never reruns command authorization or calls AI/network/time/random.

### Data model and migrations

- `command_records(id uuid PK, world_id FK nullable, command_type, command_schema_version, actor_type user/system/ai/platform_admin, actor_id, payload jsonb nullable, payload_hash bytea, payload_classification, idempotency_key, request_hash, expected_world_version nullable, expected_state_revision nullable, status received/accepted/rejected/failed, rejection_code, authorization_rule_id, override_id nullable, correlation_id, causation_id, requested_at, decided_at, resulting_state_revision nullable, response_summary jsonb, unique(world_id,actor_type,actor_id,command_type,idempotency_key))`; immutable after decision except tightly constrained received→terminal transition.
- `domain_events(id uuid PK, world_id FK, world_event_sequence bigint, command_id FK, event_ordinal integer, aggregate_type, aggregate_id, aggregate_version bigint, event_type, event_schema_version integer, payload jsonb, metadata jsonb, occurred_at, recorded_at, resulting_state_revision bigint, unique(world_id,world_event_sequence), unique(command_id,event_ordinal), unique(world_id,aggregate_type,aggregate_id,aggregate_version))`; insert-only trigger and payload size/version checks.
- `world_ledger_heads(world_id PK/FK, next_ledger_sequence bigint, next_event_sequence bigint, last_entry_hash bytea, ledger_schema_version integer, anchored_at, anchor_artifact_hash, updated_at)` locked for allocation.
- `ledger_entries(id uuid PK, world_id FK, ledger_sequence bigint, entry_kind command_accepted/command_rejected/domain_event/override/repair_anchor, command_id nullable FK, event_id nullable FK, actor_type/id, public_summary_code, redacted_details jsonb, previous_hash bytea, entry_hash bytea, recorded_at, unique(world_id,ledger_sequence), unique(event_id))`; checks require appropriate links and inserts only. Index actor/type/time/entity-summary fields needed by history.
- `aggregate_stream_heads(world_id, aggregate_type, aggregate_id, current_version bigint, updated_at, primary key(...))`; locked/updated with events.
- `projection_checkpoints(world_id, projection_name, projection_schema_version, last_event_sequence, checksum bytea, status, updated_at, primary key(...))` and `event_consumer_receipts(consumer_name,event_id,processed_at,primary key(...))` support idempotent replay/consumers.
- `outbox_messages(id uuid PK, world_id, event_id nullable, message_type, message_schema_version, payload jsonb, status pending/published/dead, attempts, available_at, locked_at/by, created_at, published_at, unique(message_type,event_id))` with pending index. Payloads contain references/minimal safe data.
- `world_history_entries(world_id, ledger_sequence, event_id nullable, occurred_at, category, title_key, summary_args jsonb, actor_type/id, target_type/id, visibility, correlation_id, resulting_state_revision, primary key(world_id,ledger_sequence))` is rebuildable/derived.
- Extend `world_runtime_heads` with ledger-anchor compatibility/checksum fields and enforce state/ledger monotonicity through command transaction functions. Application DB role cannot update/delete event/ledger rows. Migration plus idempotent release backfill anchors existing active worlds; fresh compiler path writes genesis.

### APIs, commands, events, and realtime messages

- Generic transport `POST /api/v1/worlds/:worldId/commands` accepts only registered public command discriminators and `{commandId,type,schemaVersion,payload,expectedWorldVersion,expectedStateRevision,idempotencyKey}`; actor/correlation/override are server-derived. Unknown type/version is rejected; clients cannot submit system/admin/AI actors.
- Existing route-specific mutation APIs remain and adapt into the same pipeline. `RenameWorldEntityV1 {entityKey,newDisplayName}` requires creator/admin (or future delegated capability), expected state/entity version and idempotency; validates type-specific state schema; emits `WorldEntityRenamedV1` and updates the entity projection.
- `GET /commands/:commandId` is actor/member-scoped and returns status, stable rejection, revisions and event IDs; it never returns secrets. `GET /worlds/:id/history` and `/history/:ledgerSequence` support bounded cursor filters and visibility. `GET /worlds/:id/runtime-head` returns design version/state revision/last ledger sequence/checksum metadata.
- Event contracts include honest genesis/import, existing world/membership/manifest/compiler lifecycle events from the adaptation point forward, `WorldEntityRenamedV1`, `CreatorOverrideUsedV1`, and projection/repair audit events. Events are past-tense facts; event upcasters preserve old bytes and produce current in-memory shape.
- Outbox messages mirror allowed event references for at-least-once internal consumers. No browser realtime yet; History refetches after command. Dispatcher retry/dead-letter never rolls back committed authority.
- Operator CLIs: `ledger verify --world`, `ledger export --world --from/--to`, `projection replay --world --target=shadow`, `projection compare`, and explicitly gated `projection repair-swap` with reason/two-person operational procedure where available.

### User interface

- Entity detail adds a type-allowed Rename action with current revision, confirmation, pending/accepted/conflict/rejected states and refresh/retry. The UI sends expected revision/idempotency but never applies authority optimistically as fact.
- `/worlds/[id]/history` provides accessible cursor timeline/table, filters, empty/loading/error states, actor/entity/event labels, design/state/ledger positions, correlation groups and explicit override/system/repair badges. Visibility-filtered entries never hint hidden content.
- Entry detail separates requested command, authorization/result, resulting events and projection consequence; payloads are schema-rendered/redacted, not raw arbitrary JSON. Provide copyable IDs and links to entity/manifest/version.
- On `REVISION_CONFLICT`, show current revision and “refresh state” rather than auto-resubmitting. Commands with uncertain network outcomes poll by command ID/idempotency key before offering retry.
- Keyboard filters/timeline, semantic table/list fallback, focus/error/live status, contrast, reduced motion, mobile layout and axe checks are required.

### AI behavior

AI is not required. No model participates in command validation, authorization, event production, projection, ledger summaries, hash verification, or replay. History titles use deterministic localized templates keyed by event type. Future AI actors are represented only by an actor type contract and will be forced through the same command bus; clients cannot select that type. Replay and tests run with network disabled.

### Security, privacy, abuse, and integrity

- Server constructs actor/authority/override metadata; validates registered command/payload versions; rate limits by actor/action/world; binds idempotency to actor/type/request hash; and rejects replay/stale versions. A user cannot forge command IDs owned by another actor.
- Command/event schemas classify fields as public/member/private/secret. Persist only required data, hash or omit secrets, and generate allowlisted redacted history summaries. Ballot secrecy and financial detail will later use visibility rules; generic raw payload export is operator-restricted/audited.
- Insert-only DB privileges/triggers, canonical hashes, contiguous sequences, external hash checkpoint metric/backup, and verification detect tampering. Repairs append explicit events/entries and never update/delete history.
- Serialization/advisory/row locks, aggregate unique versions, state expected revision and deterministic lock ordering prevent lost updates. Retry only serialization/deadlock before external response and preserve command/idempotency identity.
- World scoping/composite FKs and history visibility prevent tenant leakage. Export/CLI requires operations authorization and writes secure output; logs never include command/event bodies.

### Observability and operations

- Trace full command stages and outbox dispatch with command/correlation/causation/world IDs, types/versions, rule/rejection, revisions and sequence ranges; log no unredacted payload. Metrics include command outcomes/latency by type/code, conflicts/retries, events per command, ledger append latency/sequence gaps/hash failures, projection lag/checksum mismatch, outbox age/failures and replay duration.
- Dashboards show command health, ledger integrity, projection/outbox lag and top rejection codes. Alerts fire on hash/sequence mismatch, checksum divergence, stuck received command, outbox/dead-letter age, unexpected repair/override and serialization exhaustion.
- Runbooks cover uncertain client result/idempotency lookup, stuck received reconciliation, sequence/hash failure freeze, dead outbox replay, shadow projection rebuild/compare/swap, event upcaster release, genesis backfill and audited repair. Writes fail closed when ledger cannot append.
- Feature flags can gate individual new command types/consumers, not bypass ledger or authorization. Backup/restore verification includes ledger head/hash and projection checksums.

### Testing requirements

- Unit-test command registry/envelope, pipeline stage order, auth decisions, idempotency/replay, expected versions, event decisions/reducers/upcasters, canonical entry hashes, redaction/visibility, history templates and deterministic replay/checksums.
- Real-DB tests cover append-only triggers/roles, unique sequences/aggregate versions, atomic command+event+ledger+projection+outbox, accepted/rejected paths, serialization/deadlock retry, 50 concurrent stale/same commands, duplicate delivery/consumer receipts and transaction failure at each stage.
- Genesis migration tests anchor pre-M06 worlds once and create honest fresh genesis; corrupted/missing anchor blocks writes. Replay from each golden world equals live checksum; deliberate event/projection/hash corruption is detected at the first divergence without destructive repair.
- Contract/security tests cover forged actor/override, unknown command/schema/event, cross-world command/history/IDs, payload/ID limits, secret redaction, hidden entry visibility, replay attacks, idempotency collision and operator CLI authorization.
- Playwright covers the six-step demo except deliberate corruption may run in integration harness: accepted duplicate, stale rejection, history filters/detail, override badge, refresh/mobile/keyboard/axe and network-uncertain command lookup. Preserve M01–M05 tests/routes.

### Acceptance criteria

- Every registered authoritative world write exercised by tests enters the command bus; accepted changes atomically produce command record, events, ledger/hash entries, projection/head/checkpoint and outbox, while rejected changes record no event/projection mutation.
- Same idempotency/request returns the same command result and one event set; differing reuse conflicts. Concurrent stale commands have one valid ordered outcome and deterministic rejections/retries without lost updates.
- Ledger sequence and hash chain verify from genesis to head; corruption is detected at the first bad sequence. Application credentials cannot update/delete events/entries.
- Replaying the golden world into an isolated projection produces the same canonical checksum as live state and makes no AI/network/random/time call.
- Existing worlds receive one truthful import anchor, new worlds one compile genesis, and no fabricated historical actions. World writes are blocked until anchoring succeeds.
- History API/UI obey world and visibility boundaries and distinguish user, creator override, system, future AI and repair actors.
- Upgrade/fresh/backfill migrations and all tests pass; prior demos/routes remain operational; ledger/replay/privacy/runbook docs and M06 handoff are complete.

### Definition of done

- Command bus, event/ledger store, projections/outbox, route adaptation, genesis, history and verify/replay tools are production-quality with no core TODO/mock/direct bypass.
- Lint/types/builds/tests pass; migrations/backfill, concurrency, append-only privileges, hash/checksum/replay and failure recovery are verified.
- Demo, telemetry/alerts/runbooks, security/privacy review, docs and M06 handoff are complete; no critical/high known defect and all prior functionality remains operational.

### Risks and mitigations

- **Attempting full event sourcing at once:** retain current synchronous projections and event-source only authoritative changes from an honest genesis; add domains incrementally.
- **Dual write/event divergence:** one DB transaction for event, ledger, projections, head and outbox; injected-failure tests.
- **Hash chain overclaimed as security:** describe it as tamper evidence, restrict DB roles, checkpoint externally/back up, and require audited append-only repairs.
- **Schema evolution breaks replay:** immutable versioned bytes, registry/upcasters, golden historical fixtures and release replay test.
- **Sensitive history exposure:** field classification, deterministic redacted summaries, visibility filters and operator-only audited export.

### Artifacts produced for later milestones

- Versioned command/actor/result/event/ledger/outbox/projection contracts, command registry/bus, event registry/upcasters and concurrency/idempotency semantics.
- Append-only command/event/hash-chain storage, aggregate/world sequencing, runtime revision, transactional outbox, history projection and visibility foundation.
- Truthful compiled-world genesis anchors, golden event streams, projection checksums and verify/export/replay/repair tooling.
- Existing mutation route adapters and production `RenameWorldEntity` vertical slice used as the pattern for simulation/economy/governance.
- Ledger/privacy/replay/operations docs, exact migration/backfill state, and `docs/milestones/M06-handoff.md` retaining all previous summaries/tests/ADRs.

### Standalone implementation prompt

```text
Implement Milestone 6, “Command/event ledger/history,” for WorldGraph (codename Anvil).

1. Product context: WorldGraph is a server-authoritative persistent city-state. Every authoritative mutation must be an authenticated, validated, authorized, versioned command; accepted commands produce immutable events/ledger entries and projections. Creator overrides are explicit. Replay is deterministic and AI-free. The manifest remains separate intent; no real money.
2. Expected repository state: M01–M05 provide strict TS pnpm/Turbo, Next/Fastify/BullMQ/Redis, Drizzle PostgreSQL, contracts/canonical hash/deterministic utilities, auth/world/member/authority/override/idempotency/audits, primitive registry, immutable approved manifests, pure deterministic compiler, active relational entities/relationships/controllers/world versions/runtime head and golden world. Inspect all packages, routes/write paths, contracts, ADRs, schemas/migrations/journal, tests, git status and M01–M05 handoffs; inventory existing active worlds and actual migration head.
3. Exact objective: centralize authoritative world writes through a command bus that durably records accepted/rejected commands, atomically appends typed events and tamper-evident ledger entries, updates projections/head/checkpoints/outbox, exposes safe history, and can verify/replay a world from honest genesis.
4. Exact scope: command/actor/result/event/ledger/outbox/projection contracts and registries/upcasters; fixed pipeline, versions, idempotency and concurrency; command/event/ledger/head/stream/checkpoint/outbox/history schema; adapt existing world-scoped mutations while preserving routes; RenameWorldEntity slice; preexisting import and fresh compile genesis; outbox dispatcher; history UI/API; verify/export/replay-to-shadow/compare and gated repair tooling; tests/docs/telemetry/M06 handoff.
5. Non-goals: do not event-source auth sessions/reads/job progress, remove projections, add arbitrary temporal query/rollback/branching/global order, simulation/finance/governance/patch/realtime/AI, generic JSON patch/client-defined command/event, Kafka or separate event-store service.
6. Required architecture: route adapters call one registered command bus. Order: authenticate→schema→idempotency→load/authorize/override→expected design/state/aggregate versions→decision→one SERIALIZABLE transaction for terminal command, typed events, hash-ledger, projection/head/checkpoint and outbox→commit→at-least-once dispatch. Rejections record redacted command but no event/change. Per-world locked head allocates contiguous sequences/previous hash; aggregate versions unique; one accepted mutating command advances state revision once. Deterministic reducers/upcasters replay into shadow with no auth/AI/network/time/random.
7. Required data model: add command_records, domain_events, world_ledger_heads, ledger_entries, aggregate_stream_heads, projection_checkpoints, event_consumer_receipts, outbox_messages and world_history_entries with fields, version/hash/classification, FKs, unique per-world sequence/idempotency/aggregate version, indexes and insert-only/transition triggers described above; extend runtime head anchor/checksum. Application role cannot update/delete events/ledger. Release backfill anchors existing active worlds once with WorldStateImportedV1; new compiles use WorldCompiledGenesisV1.
8. Required APIs/events: allowlisted generic POST world commands plus preserved route adapters; RenameWorldEntityV1 with expected versions/idempotency emitting WorldEntityRenamedV1; command status, runtime head and bounded visibility-filtered history list/detail; honest genesis/import and adapted lifecycle events; versioned minimal outbox messages; operator ledger verify/export and projection replay/compare/gated repair. No browser realtime.
9. Required UI: entity rename with revision/pending/accepted/conflict/uncertain lookup; accessible responsive History filters/timeline/table/detail showing actor, authority/override, command/events, design/state/ledger positions and correlation with redacted schema rendering; complete loading/empty/error/mobile/keyboard/axe states. Never optimistically claim authority.
10. Required tests: unit pipeline/order/registry/idempotency/versions/decisions/reducers/upcasters/hash/redaction/history/replay; real DB atomicity and failure injection, append-only roles/triggers, accepted/rejected, sequences/aggregate concurrency, 50 concurrent/duplicate commands, outbox receipts; upgrade/fresh genesis/backfill/block-before-anchor; golden replay checksum and deliberate first-divergence detection; forged actor/override/cross-world/schema/limits/secrets/replay/CLI security; Playwright demo/network uncertainty/accessibility; preserve prior suites.
11. Security/integrity: server derives actor/override; allowlisted versioned types; bind idempotency to actor/type/hash; stale/replay/rate protection; schema field visibility/classification and minimal persistence; insert-only DB privileges, hash chain and external checkpoint/backup; repair only appended/audited; deterministic locks/retries; tenant boundaries; operator exports restricted. Do not claim hash prevents privileged tampering.
12. Migration requirements: append after actual M05 head; do not rewrite old migrations/events. Verify fresh/upgrade/no-op, constraints/triggers/roles, idempotent genesis data migration/backfill and recovery. Block active-world commands until anchor succeeds. Document forward repair; never synthesize historical actions or mutate an event.
13. Documentation: command lifecycle/registry/handler guide, event naming/version/upcasting, ledger hashing/order and threat model, projection/transaction/outbox consistency, genesis/backfill, visibility/privacy, APIs/errors, concurrency/idempotency and verify/export/replay/repair/backup runbooks. Create M06 handoff with summary, contracts/schema, migration+backfill state, actual tests/results, ADRs/deviations, ops and risks retaining all prior inputs.
14. Acceptance criteria: all tested authoritative writes use bus; accepted transaction contains all records/projection and rejection no event/change; duplicate/conflicting/stale/concurrent semantics pass; hash chain/first corruption detection and DB immutability pass; golden replay checksum matches without external nondeterminism; honest single anchors and write gate; scoped redacted History distinguishes actors; migrations/tests/prior demos/docs pass.
15. Commands to run: inspect existing scripts, then install if needed, format/lint/typecheck, unit/golden event/replay, real PostgreSQL/Redis migration/backfill/atomicity/concurrency/failure/security tests, ledger verify/export on golden world, shadow replay/compare, Playwright/axe, builds and clean upgrade/demo. Record exact truthful command outcomes; never hide unrun/failing checks.
16. Final response format: outcome; implementation summary; files by area; migrations/backfill/head and command/event/schema versions; ledger/replay checksums/counts; tests/commands/results; architecture/concurrency/privacy decisions/deviations; ops/security; risks/incomplete items.
17. Preserve behavior: edit current repo directly; preserve M01–M05 APIs/demos and adapt routes internally without silent breaking changes; respect user changes, avoid unrelated refactors and version necessary contract changes.
18. Completeness: no core TODOs, in-memory ledger/outbox, mutable events, fake replay, generic mutation escape hatch, skipped concurrency/security tests, direct projection writes or invented historical events. A repair swap may be operations-gated, but verify/replay/compare must be real.
19. Inspect first: inspect code boundaries and every write path, contracts/catalog/manifest/compiler, Drizzle schema/migrations/DB roles, authority/idempotency/audits, queue/telemetry/UI/tests/docs/git and all handoffs before edits; follow conventions unless they violate a stated invariant.
20. Deviations: surface necessity promptly, select smallest compatible versioned approach, test/document it and record final/M06 handoff. Never silently weaken single command path, atomic event/projection/outbox, append-only history, honest genesis, hash/version/concurrency, replay determinism, privacy or selected stack.
```

## Milestone 7 — Deterministic clock/scheduler

### Outcome

Every active world has a persistent, server-authoritative simulation clock whose world time is derived from integer ticks, plus a durable scheduler that executes allowlisted typed actions exactly once in deterministic order. A creator can pause, resume, single-step, advance a bounded number of ticks, schedule/cancel a world notice, and observe due execution in the Simulate and History lenses. Redis/BullMQ and wall time merely wake the system; PostgreSQL state, commands, events, and tick inputs determine outcomes, and concurrent workers cannot advance the same world twice.

### Why this milestone occurs now

Simulation requires the command/event ledger’s ordering, idempotency, state revision, outbox, replay, and failure semantics. It must exist before production, taxation, elections, AI actors, or environmental processes because each needs one shared notion of time and scheduled execution. Establishing the clock with a small real scheduled action keeps the kernel testable without prematurely encoding economy or governance behavior.

### User-visible demonstration

1. Open an active golden world’s Simulate lens; confirm tick 0, derived founding time, configured world-time-per-tick, paused mode, empty schedule, and current state revision.
2. Schedule the public notice “Guild Founding Day” for tick 3, then single-step twice. Confirm it remains pending and History records two clock advances.
3. Advance one tick; confirm the notice executes once at tick 3, becomes completed, appears in History, and cannot execute again after refresh/retry.
4. Schedule notices at the same tick with different priorities and creation order; advance and confirm the documented deterministic order.
5. Start continuous mode, run two worker instances, and confirm ticks advance without duplicates; pause and confirm no later wake-up advances the world.
6. Replay the same genesis plus schedule/clock commands twice with different worker timing/batch wake-ups; confirm equal semantic simulation outcome hash and final projection checksum.

### Scope

- Define versioned `SimulationTick`, clock configuration/state, scheduled action, deterministic simulation context/result, process/handler descriptor, batch, and failure contracts.
- Add a code-owned allowlisted simulation process registry. Handlers receive only immutable state snapshots, tick number/world time, validated payload and deterministic PRNG stream; they return proposed typed domain events and schedules, never write databases directly.
- Persist clock projection, schedule projection, schedule sequence, durable batch attempts, PostgreSQL worker lease and operational failure/dead-letter state. Initialize active existing worlds at tick 0/paused; initialize newly compiled worlds from approved manifest clock config.
- Add ledger commands/events/reducers for configure/start/pause/advance clock, create/cancel schedule, due action execution, auto-pause/failure, and the real `EmitWorldNoticeV1` scheduled action.
- Implement manual bounded advancement and continuous wake-up worker. PostgreSQL lease and command idempotency are authoritative; BullMQ/repeatable jobs are disposable wake-up hints. Catch-up is bounded and backpressure-aware.
- Define deterministic ordering: tick ascending, priority ascending, schedule sequence ascending, stable ID tie-break; schedules created for the current/past tick are rejected or normalized only by an explicit documented rule (choose reject for MVP).
- Derive `worldTime = epoch + tick × worldMillisecondsPerTick` using checked integers. No authoritative handler reads wall time, locale, `Math.random`, external services, Redis, or AI.
- Add Simulate UI/API, replay/golden/concurrency/failure tests, telemetry, clock/scheduler/process authoring and repair docs, and M07 handoff.

### Non-goals

- Resource production/consumption, population needs, businesses, markets, taxes, elections, environmental simulation, physics, AI actor decisions, or arbitrary user-authored processes.
- Realtime animation, client-authoritative time, sub-tick physics, variable floating-point delta time, cron expressions, calendar/time-zone rule engines, or unbounded offline catch-up.
- Exactly-once BullMQ delivery; correctness is achieved through database leases, unique batch/schedule execution identities, command idempotency, and event transactions.

### Dependencies

- Milestones 1–6, especially active world/runtime head, deterministic compiler seed/config, command bus, event/ledger order, projections/outbox, authority and replay tooling.
- M01–M06 handoffs, migration/ledger anchor state, event/upcaster conventions, golden world stream/checksum and current test results.

### Architecture and design

- Add `simulation` domain/application module and a worker adapter. The domain registry maps versioned action/process names to payload schema, compatibility range, authority policy and pure handler. There is no generic function name from a manifest and no dynamic import/eval.
- A world clock projection holds `currentTick`, immutable epoch, integer world milliseconds per tick, wall cadence for continuous wake-up, mode and version. Wall time determines only that a service may request the next bounded advancement; the accepted command explicitly records `fromTick/toTick`. Replay ignores wall timestamps.
- `AdvanceSimulationV1` takes expected tick/state revision and a maximum target no greater than configured batch limit. The handler iterates ticks in ascending order, loads due schedules in deterministic order, invokes pure handlers, validates returned event/schedule schemas and event budgets, then atomically appends domain events/ledger, updates clock/schedule/world projections and outcome hash through the M06 command transaction.
- A PostgreSQL lease uses owner ID, lease version and expiry solely for worker coordination. The worker renews it with fencing token, recomputes the authoritative clock after acquisition, and issues a system-actor command. Losing/crashing a worker leaves an uncommitted batch retryable; Redis loss only stops automatic wake-ups.
- The semantic outcome hash covers starting projection checksum, seed/PRNG algorithm version, tick range, ordered due schedule IDs/payload hashes, process versions and returned semantic event bytes—not command IDs, recorded times, worker IDs or batch grouping. A PRNG substream derives from world seed, process name/version, tick and stable schedule/entity key so worker timing cannot affect results.
- Continuous catch-up computes a bounded target from last accepted wall anchor but advances no more than `maxCatchUpTicks`/batch and yields between batches. Clock starts/resumes reset the wall anchor; pause is immediately authoritative. Large downtime requires explicit creator acknowledgement/manual catch-up.
- `EmitWorldNoticeV1` validates bounded plain text/visibility and emits `WorldNoticeEmittedV1`; it is a genuine reusable world-history notice, not test-only behavior. Unexpected deterministic handler failures roll back the batch; after bounded retries a separate system command auto-pauses the clock and creates an operational failure record. Repair/cancel/retry is explicit and audited.

### Data model and migrations

- `world_simulation_clocks(world_id PK/FK, clock_schema_version, epoch_at timestamptz, current_tick bigint check >=0, world_milliseconds_per_tick bigint check >0, wall_cadence_milliseconds integer check bounds, mode paused/running/error, max_batch_ticks integer, max_catch_up_ticks integer, prng_algorithm_version, last_wall_anchor_at nullable, row_version bigint, updated_state_revision, updated_at)` is a rebuildable synchronous projection; epoch is normalized UTC and world time uses checked integer arithmetic.
- `world_schedule_heads(world_id PK/FK, next_schedule_sequence bigint check >0, updated_at)` allocates deterministic creation sequence within command transaction.
- `scheduled_actions(id uuid PK, world_id FK, schedule_sequence bigint, due_tick bigint check >=0, priority integer bounded, action_type, action_schema_version, payload jsonb, payload_hash bytea, process_version, status scheduled/completed/cancelled/failed, created_by_actor_type/id, created_command_id FK, completed_event_id nullable, cancelled_command_id nullable, created_state_revision, completed_state_revision nullable, created_at, updated_at, unique(world_id,schedule_sequence), unique(world_id,id))`; partial due index `(world_id,due_tick,priority,schedule_sequence) where status='scheduled'` and legal-state trigger.
- `simulation_batch_runs(id uuid PK, world_id FK, from_tick, to_tick, batch_key bytea, process_registry_version, input_checksum, outcome_hash nullable, status running/completed/failed, attempts, command_id nullable FK, error_code, started/completed_at, unique(world_id,from_tick,to_tick,input_checksum,process_registry_version))` is operational/reproducibility metadata, not authority outside the event stream.
- `simulation_worker_leases(world_id PK/FK, lease_owner, fencing_token bigint, leased_until, heartbeat_at)` is ephemeral coordination in PostgreSQL and may be cleared safely after expiry.
- `simulation_failures(id, world_id, batch_run_id, tick, schedule_id nullable, process_type/version, error_code, redacted_context jsonb, attempts, status open/resolved, opened_at, resolved_by/at, resolution_command_id)` supports operations; no stack/payload secrets.
- Add history projection support for clock/schedule/notice events. Data migration creates clocks/schedule heads for ledger-anchored active worlds from compiled simulation configuration (or documented default with provenance) at tick 0 paused; fresh compilation/genesis creates them atomically after M07.

### APIs, commands, events, and realtime messages

- Queries: `GET /worlds/:id/simulation/clock`, `/schedule`, `/schedule/:id`, and `/batches`; membership-scoped, cursor-bounded, include state revision/process versions and safe failures.
- `ConfigureWorldClockV1 {epoch,worldMillisecondsPerTick,wallCadenceMs,maxBatch,maxCatchUp}` is creator-only and allowed only at tick 0/paused in MVP; expected versions/idempotency; emits `WorldClockConfiguredV1`.
- `StartWorldClockV1`, `PauseWorldClockV1`, and `AdvanceSimulationV1 {ticks}` require creator capability `simulation.manage` for manual actions; automatic advance uses an authenticated scoped system principal. They enforce expected tick/state revision and limits and emit `WorldClockStarted/Paused`, `SimulationAdvancedV1` plus due-action facts.
- `ScheduleWorldNoticeV1 {dueTick,priority,text,visibility}` and `CancelScheduledActionV1` require creator/admin in MVP, validate future tick and schedule status, expected revision/idempotency; emit `ScheduledActionCreated/CancelledV1`. At due tick `ScheduledActionExecutedV1` and `WorldNoticeEmittedV1` are atomic with clock advance.
- Stable errors include `CLOCK_NOT_PAUSED/RUNNING`, `EXPECTED_TICK_MISMATCH`, `ADVANCE_LIMIT_EXCEEDED`, `SCHEDULE_IN_PAST`, `SCHEDULE_ALREADY_TERMINAL`, `SIMULATION_HANDLER_FAILED`, `WORLD_NOT_ACTIVE` and ordinary M06 conflict/idempotency errors.
- Outbox publishes minimal versioned simulation event references for future realtime/history. No browser WebSocket yet; UI refetches/polls continuous mode. Queue messages contain world ID and expected lease fencing token only, never authority.

### User interface

- `/worlds/[id]/simulate` shows derived world date/time and tick, paused/running/error, cadence/config/version, state revision, next due action, backlog/catch-up warning and last batch/outcome hash.
- Creator controls start, pause, single-step, bounded advance and schedule/cancel notice. Each shows required authority, expected revision, consequence and confirmation for multi-tick/catch-up actions; duplicate/uncertain response resolves through command status.
- Schedule table supports status/due tick/type/priority/order, accessible filters and detail. History links show execution and emitted notice. Normal members get read-only view; controls hidden for clarity but server denials remain tested.
- Loading/empty/continuous polling stopped/stale/conflict/error/auto-paused/Redis-degraded states are complete. Tick updates use polite live regions without flooding screen readers; keyboard, focus, contrast, reduced motion, mobile layout and axe tests are required.

### AI behavior

AI is not used. Simulation processes, scheduling, ordering, event production, retries and repairs are deterministic code paths. No handler can import an AI/provider client or network adapter. Future AI may propose a command through the same public schemas, but cannot choose system actor, schedule hidden actions, or execute inside a tick. Tests run with network disabled and fail if `Date.now`/`Math.random` is accessed in the pure handler boundary.

### Security, privacy, abuse, and integrity

- All manual clock/schedule actions traverse M06 authentication, authority, CSRF, version, idempotency and ledger. The worker uses a narrowly scoped service identity/fencing token; clients cannot submit system commands or lease data.
- Enforce hard limits on advance/catch-up ticks, schedule count per world/actor/tick, payload bytes/text/control characters, events/schedules returned per handler and CPU/transaction time. Rate limit controls and reject past/current due ticks.
- Code-only allowlisted handlers, strict payload/event schemas, deterministic dependencies, no eval/dynamic URLs/network/AI/wall-time/random prevent arbitrary execution and nondeterminism.
- Database uniqueness/status transitions plus command transaction ensure each schedule reaches one terminal execution/cancel path. Lock ordering and lease fencing prevent dual workers. Pause/failure is fail-closed; do not skip a broken due action silently.
- Notice visibility and text rendering follow history classification/sanitization; logs and telemetry omit notice content/payloads. System/creator actions remain distinct and auditable.

### Observability and operations

- Trace worker wake/lease/command and per-process stage with world/batch/tick range/process versions/schedule counts, excluding payload. Metrics: tick throughput/latency, wall drift, backlog/catch-up, worlds by mode, due schedule lag, execution/failure/retry, batch size/outcome mismatch, lease contention/fencing loss, queue wake age and auto-pauses.
- Dashboard/alerts cover running world with no advance, excessive drift/backlog, repeated batch/handler failure, overdue schedules, lease churn/dual-attempt, high transaction time and unexpected outcome-hash regression.
- Feature flags gate continuous mode/process versions and rollout batch limits; manual pause/step stays available. Redis outage stops wake-ups but raises degraded alert and never affects authoritative tick state.
- Runbooks cover safe pause/resume, bounded catch-up, stuck/expired lease, retry after crash, failed schedule/process rollout, outcome/checksum comparison, resolving failure by versioned cancel/repair command, and restoring clock/schedule projections from ledger.

### Testing requirements

- Unit-test checked time arithmetic, clock state machine, ordering/ties, future-tick rules, process/payload registry, PRNG substreams, event budgets, outcome hash and deterministic notice handler; prohibit clock/random/network dependencies.
- Real-DB/worker tests cover migrations/initialization, event/projection atomicity, two/ten worker lease races, fencing, duplicate wake/jobs/commands, pause race, schedule/create/cancel/execute races, crash before/after commit, retry, auto-pause and Redis loss/recovery.
- Golden determinism tests replay identical genesis/commands with different wall clock, worker IDs, batching/wake timing, timezone/locale and input insertion order; semantic outcome hash/final checksum match. Deliberate process version change requires fixture/version update.
- Security tests cover forged system actor/fencing token, unauthorized controls, huge advances/catch-up/schedules/payload, past schedule, handler unknown/version mismatch, XSS notice, cross-world IDs and telemetry redaction.
- Playwright covers the six-step demo, read-only member, loading/empty/conflict/auto-pause/Redis-degraded/mobile/keyboard/axe. Preserve M01–M06 and ledger replay tests.

### Acceptance criteria

- Every active world has exactly one valid clock/schedule head; world time derives exactly from epoch+integer tick duration and survives restart/Redis loss.
- Tick 3 notice executes exactly once, atomically with accepted advance, in documented priority/sequence order; retries/concurrent workers produce no duplicate or skipped terminal schedule.
- Start/pause/manual/automatic advancement all use command/event/ledger paths with correct creator/system actor distinction and expected tick/state conflicts.
- Two-worker continuous test advances monotonically without duplicates; pause prevents a stale wake from committing. Redis removal stops automation but does not corrupt state; recovery resumes from DB.
- Golden runs with different worker/wall/batch timing produce equal semantic outcome hash and projection checksum; pure process boundary makes no AI/network/wall/random call.
- Unexpected handler failure rolls back tick, retries boundedly, auto-pauses and alerts rather than silently skipping; documented repair is append-only/audited.
- Fresh/upgrade/data migrations and all required checks pass; prior demos/replay remain operational; simulation docs/runbooks and M07 handoff match exact state.

### Definition of done

- Clock, schedule/process registry, commands/events/reducers, worker lease/advance, notice slice and Simulate UI are production-quality without core TODO/mock/client authority.
- Lint/types/builds/tests pass; migrations, two-worker concurrency, crash/Redis/failure recovery, exact execution and golden determinism are verified.
- Demo, telemetry/alerts/runbooks, security/determinism review, docs and M07 handoff are complete; no critical/high defect and prior functionality remains operational.

### Risks and mitigations

- **Wall time leaks into outcomes:** wall clock only proposes bounded target; commands record ticks and pure handlers receive derived integer world time.
- **Duplicate/missed schedules:** database status/unique identity, deterministic ordering, command atomicity, idempotent reducer and worker fencing.
- **Long catch-up blocks world:** strict batch/catch-up/event/CPU limits, yield between batches, explicit acknowledgement after long downtime and backpressure metrics.
- **Process failure wedges simulation:** validate at scheduling, bounded retries, fail-closed auto-pause, explicit audited cancel/repair and versioned registry rollback.
- **Event volume grows too fast:** bounded batch summary plus material due events, measure before optimizing, retain per-tick deterministic semantics/checksums.

### Artifacts produced for later milestones

- Versioned clock/tick/schedule/process/batch contracts, pure deterministic process registry/context/PRNG substreams and outcome hashes.
- Persistent clock/schedule/batch/lease/failure projections, commands/events/reducers and worker fencing/catch-up infrastructure.
- Real scheduled notice vertical slice and Simulate UI/API/history integration.
- Golden simulation streams and concurrency/crash/Redis-loss fixtures used by production, markets, governance and AI actor milestones.
- Simulation authoring/determinism/repair docs, exact migration/process registry state, and `docs/milestones/M07-handoff.md` retaining all earlier state.

### Standalone implementation prompt

```text
Implement Milestone 7, “Deterministic clock/scheduler,” for WorldGraph (codename Anvil).

1. Product context: WorldGraph is a server-authoritative persistent city-state simulation. World time must advance as deterministic integer ticks; scheduled actions and future economy/governance processes share this kernel. PostgreSQL commands/events are authority; Redis/BullMQ/wall time only wake work. AI, clients and primitive data never execute authoritative tick logic. No real money.
2. Expected repository state: M01–M06 provide strict TS pnpm/Turbo, Next/Fastify/BullMQ/Redis, Drizzle PostgreSQL, deterministic utilities/compiler seed/active graph/runtime head, auth/authority/overrides/idempotency, and a command bus with immutable events/hash-ledger, state/aggregate versions, projections/outbox/history, honest genesis and replay/checksum tools. Inspect all code/packages, process boundaries, ADRs, schemas/migrations, command/event registries/upcasters, tests/git and M01–M06 handoffs first; use actual migration/ledger versions.
3. Exact objective: give each active world a persistent deterministic clock and durable ordered scheduler; allow creator manual/continuous control and a real scheduled notice; ensure concurrent workers/retries/Redis loss cannot duplicate, skip or nondeterministically reorder authoritative execution.
4. Exact scope: clock/tick/schedule/process/context/result/batch/failure contracts; code-owned process registry and deterministic PRNG substreams; clock/schedule/batch/lease/failure persistence/init; commands/events/reducers for configure/start/pause/advance/schedule/cancel/execute/auto-pause; PostgreSQL-fenced worker and bounded catch-up; EmitWorldNoticeV1; Simulate/history UI/APIs; golden/concurrency/failure tests, telemetry/docs/M07 handoff.
5. Non-goals: no production/resources/population/markets/taxes/elections/environment/physics/AI, arbitrary scripts/processes, client time, sub-tick floating delta, cron/timezone engine, unbounded catch-up, WebSocket animation, or reliance on exactly-once BullMQ.
6. Required architecture: pure versioned handlers get immutable state, integer tick/derived time, validated payload and deterministic PRNG and return typed proposed events/schedules only. No DB/network/Redis/AI/Date.now/Math.random/dynamic eval. World clock maps epoch+tick*integer duration. Advance command under M06 transaction processes ticks and due schedules ordered tick, priority, schedule sequence, stable ID, validates budgets, appends events and projections atomically. DB lease/fencing guards workers; queue only wakes. Semantic outcome hash excludes IDs/times/workers/batch grouping. Bounded catch-up and fail-closed auto-pause.
7. Required data model: add world_simulation_clocks, world_schedule_heads, scheduled_actions, simulation_batch_runs, simulation_worker_leases and simulation_failures with exact fields/checks/versions/status transitions/unique schedule sequence/batch identity/due indexes from milestone. Add history projection. Idempotently initialize ledger-anchored active worlds tick 0 paused from compiled config/default provenance; future compiles initialize atomically.
8. Required APIs/events: clock/schedule/batch queries; creator ConfigureWorldClockV1 only tick0 paused, Start/Pause, manual Advance, ScheduleWorldNotice and Cancel with schemas/expected revisions/idempotency; scoped system Advance from worker; events ClockConfigured/Started/Paused, SimulationAdvanced, ScheduledActionCreated/Cancelled/Executed, WorldNoticeEmitted and failure/auto-pause. Minimal outbox refs; polling, no WebSocket. Stable errors specified above.
9. Required UI: accessible responsive /simulate clock/derived time/mode/config/revision/backlog/hash; start/pause/step/bounded advance with consequences; create/cancel notice and ordered schedule/detail/history links; read-only member; full loading/empty/stale/conflict/error/auto-paused/Redis-degraded states; polite ARIA updates, keyboard/mobile/axe.
10. Required tests: unit arithmetic/state/order/registry/payload/PRNG/budgets/hash/notice and forbidden nondeterminism; real DB/event atomicity/init, two/ten workers, leases/fencing, duplicate wake/commands, pause and schedule races, crash around commit, retries/auto-pause, Redis loss; golden equal outcome/checksum across wall/worker/batch/timezone/order; forged system/lease, auth/limits/past/unknown/XSS/cross-world/redaction security; six-step Playwright/axe; preserve M01–M06/replay.
11. Security/integrity: all user controls through command/auth/CSRF/authority/version/idempotency; narrow service identity and fencing server-only; hard tick/catch-up/schedule/payload/event/CPU/rate limits; code-only handlers and strict schemas; reject past/current schedules; unique legal terminal execution; deterministic lock order; fail closed; visibility/sanitization/redaction and actor distinction.
12. Migration requirements: append after actual M06 head; never edit old migrations/events. Verify fresh/upgrade/no-op and idempotent clock init only after ledger anchor, constraints/indexes/transitions, replay equivalence and forward repair. Document any default clock provenance; do not silently advance worlds during migration.
13. Documentation: tick/time/config semantics, handler/process authoring and versioning, deterministic PRNG/outcome hash, ordering/schedule lifecycle, worker lease/fencing/catch-up/Redis role, APIs/errors/UI authority, tests and pause/lease/failure/replay/repair runbooks. Create M07 handoff with summary, schemas/events/process versions, exact migration/init state, actual tests/results, ADRs/deviations, ops and risks retaining prior inputs.
14. Acceptance criteria: exact clock derivation/restart; tick3 notice once/in order/atomic; all controls ledgered with actor distinction; two workers monotonic no duplicate and pause fences stale wake; Redis loss safe/recovery; golden semantic/checksum equal across timing/batching; no forbidden dependencies; handler failure rolls back/auto-pauses/alerts; migrations/tests/prior demos/docs pass.
15. Commands to run: inspect scripts then install if needed, format/lint/typecheck, unit/golden determinism under varied clocks/timezones/batches, real PostgreSQL/Redis migration/worker/two-worker/concurrency/crash/failure/security tests, ledger verify and projection replay/compare, Playwright/axe, builds and clean upgrade/demo including Redis interruption. Record exact truthful results.
16. Final response format: outcome; implementation summary; files by area; migrations/init head and clock/process/event versions; demo tick/schedule/outcome/checksum; tests/commands/results; determinism/concurrency decisions/deviations; security/ops; risks/incomplete items. Never hide failure.
17. Preserve behavior: work in current repo, preserve M01–M06 health/auth/primitives/manifest/compiler/graph/ledger/history APIs and demos, respect user changes, avoid unrelated refactors and upcast/version intentional contract changes.
18. Completeness: no core TODOs, in-memory/Redis-authoritative clock, fake schedule, dynamic handler, client authority, unbounded catch-up, skipped races, wall/random/AI leakage or silent failed-action skip. Continuous automation and real notice lifecycle must work.
19. Inspect first: inspect packages/modules, compiler simulation config, graph/runtime head, command/event/ledger/upcasters/replay/outbox, DB schemas/migrations, authority, queues/telemetry/UI/tests/docs/git and all handoffs before editing; follow conventions unless explicit requirements are stronger.
20. Deviations: explain promptly, choose smallest versioned compatible alternative, test/document it and record final/M07 handoff. Never silently weaken deterministic tick semantics, DB authority/fencing, exact-once schedule effect, command/event atomicity, fail-closed behavior, no-AI boundary or fixed stack.
```

## Milestone 8 — Wallets/transfers/ownership

### Outcome

An active city-state can initialize a closed-loop virtual currency, treasury/member wallets, balances, and transferable world assets from its approved compiled seed plan. Two controlled characters can transfer currency without overdraft, an owner can gift an asset, and a seller can create a direct priced transfer offer that a buyer accepts atomically—payment and ownership either both commit or neither does. Immutable financial postings and ownership events reconcile to nonnegative balance/supply and exactly one current owner, with clear virtual-only UI, auditable creator issuance, concurrency protection, and operational verification/repair.

### Why this milestone occurs now

Economic integrity depends on the command/event transaction, actor-to-entity control, deterministic compiled seed, and simulation clock already being present. Implementing wallets before those foundations would invite double spending and ambiguous ownership. This milestone establishes money and title invariants before production, businesses, markets, taxes, budgets, and governance begin to depend on them.

### User-visible demonstration

1. Compile/initialize the golden world with two members. Open Economy and confirm one closed-loop currency, treasury plus player wallets, initial balances/supply, and the “virtual—no cash value or cash-out” disclosure.
2. As user A, transfer 25.00 guild credits to user B. Confirm both balances, immutable transaction/postings, History entry, command ID and reconciliation status update atomically.
3. From two browser sessions concurrently spend more than A’s remaining balance. Confirm at most one command succeeds, no balance becomes negative, and retrying either idempotency key never duplicates a debit/reward.
4. As A, gift a starter asset to B; confirm exactly one current owner and an immutable ownership transfer. A can no longer transfer it.
5. As B, create a direct offer to sell that asset to A for 10.00 credits. As A accept it; confirm payment to B and title to A share one atomic transaction/state revision. Race two accepts and confirm one wins.
6. Run economy reconciliation for the world; confirm wallet balances equal summed postings, supply equals net issuance, and ownership projection equals events. Demonstrate an injected failure between payment/title in a test database rolls back both.

### Scope

- Define versioned `Currency`, `Wallet`, amount/minor-unit, financial transaction/posting, balance/supply projection, `Asset`, ownership, direct transfer offer, reconciliation report, and economy seed-plan contracts.
- Materialize exact compiled economy/ownership seed plans into one currency per MVP world (schema permits more later), treasury/member wallets, initial issuance/distribution, registered assets, and initial owner projection through one idempotent ledgered initialization command. Update compiler adapters/version so future artifacts emit complete seed plans; migrate existing active worlds through an explicit audited initializer.
- Treat amounts as signed/unsigned 64-bit minor-unit integers internally and decimal strings at JSON boundaries. Currency has immutable code/minor-unit precision and optional capped supply after initialization.
- Implement immutable domain-specific accounting facts: a financial transaction has postings whose signed sum equals its explicit supply delta; transfer supply delta is zero, issuance is positive, burn would be negative. All spendable wallet balances remain nonnegative; current supply remains nonnegative and within cap.
- Implement wallet balance/supply projections and deterministic lock ordering. Transfer commands lock source/destination balance rows; verify actor controls source owner, currency/world/status, amount, rate and expected versions; commit postings/events/projections/general ledger atomically.
- Establish one authoritative ownership event stream and one rebuildable `asset_ownership` current projection with exactly one row per active owned asset. Register compiled assets with stable keys and typed, schema-valid metadata; never duplicate owner fields on asset/entity rows.
- Implement free owner-initiated asset transfer plus seller-created, optionally buyer-targeted, expiring direct transfer offer and atomic acceptance combining payment and title. This is not a browseable marketplace/order book.
- Add carefully scoped creator issuance as an explicit logged override with reason and supply cap. Initial manifest distribution is a system initialization fact, not disguised creator action.
- Add economy/wallet/asset/offer APIs and UI, participant/public visibility policy, reconciliation/verification and append-only repair procedures, adversarial concurrency/invariant tests, telemetry/docs, and M08 handoff.

### Non-goals

- Real money, crypto/blockchain/NFT, deposits, withdrawal/cash-out, custody, exchange rates, interest, debt/credit/negative balances, securities, gambling, external payment rails, or real-world financial terminology/claims.
- Marketplace discovery/order matching/auctions, production recipes, businesses, jobs, payroll, treasury budgets/taxation, contracts, escrow disputes, rent, lending, or governance-authorized minting.
- Client-computed balances/ownership, mutable/deletable postings, arbitrary asset metadata/code, or administrator editing a balance/current owner directly.

### Dependencies

- Milestones 1–7: authenticated actor/member authority, exact compiled economy/asset plan and controller bindings, active WorldGraph/runtime versions, command/event/ledger/projection/outbox/replay, deterministic clock/tick, creator override and idempotency.
- M01–M07 handoffs, exact migration/compiler/event/process versions, golden two-user world and current replay checksum/test state.

### Architecture and design

- Add `economy` and `ownership` modules with pure decision/invariant functions, command handlers and Drizzle repositories. General World Ledger remains the cross-domain audit authority; immutable `financial_transactions`/`wallet_postings` are the detailed accounting journal tied one-to-one to commands/events. Wallet balance and currency supply are synchronous rebuildable projections.
- JSON amounts are canonical base-10 decimal strings converted with currency precision to `bigint`; reject signs where inappropriate, exponent notation, excess fractional digits, leading ambiguity, noncanonical forms, zero transfer and 64-bit overflow. Never use JavaScript `number` or floating SQL numeric for money.
- A financial transaction contains a `supply_delta_minor`. A deferred database constraint trigger verifies all postings belong to the same world/currency and `SUM(signed_amount_minor) = supply_delta_minor`. Ordinary transfers/purchases have zero delta; initialization/explicit issuance has a positive delta. Projection updates verify every wallet remains `>= 0` and supply `0..max`.
- Command transaction takes the M06 world/runtime lock as needed, locks asset/offer and all wallet balance rows in sorted UUID order, rechecks expected versions/control/offer/title/funds, appends accounting facts plus domain/general-ledger events, updates balances/supply/ownership/offer/economy head/checkpoints and outbox, then commits. Serializable retry preserves command/idempotency identity.
- A wallet belongs to exactly one world/currency/owner entity; control is derived only from active `world_entity_controllers` and future authority grants. Treasury wallet belongs to a treasury organization entity. Wallets are not users and user ID is never accepted as proof of control.
- `assets` contains identity/classification/transfer rules but no current-owner column. `AssetOwnershipTransferredV1` events are authoritative history; `asset_ownership` is the single current-owner projection keyed by asset. Asset/entity/world composite FKs prevent cross-world title.
- A direct offer records seller’s authorized intent, asset/version, currency/price, optional buyer, expiry tick and one terminal state. Acceptance checks current tick, buyer target, seller still owns asset and both wallets; emits payment and title facts in one command. No reservation/escrow in MVP, so seller may transfer/cancel first and acceptance then fails safely.
- Reconciliation recomputes wallet balances, supply and current owners from immutable journals/events into isolated results and compares projection checksums. Repair never edits postings/events/balances directly; it appends a reasoned versioned compensating command after platform-admin plus creator operational approval.

### Data model and migrations

- `currencies(id uuid PK, world_id FK, stable_key citext, code citext, name, minor_unit_scale smallint check 0..6, max_supply_minor bigint nullable check >=0, issuer_entity_id nullable, currency_schema_version, status active/frozen/retired, created_event_id FK, created_at, unique(world_id,stable_key), unique(world_id,code), unique(world_id,id))`; currency semantic fields immutable after initialization.
- `currency_supply(currency_id PK/FK, current_supply_minor bigint check >=0, row_version bigint, updated_state_revision, updated_at)` is a rebuildable projection; trigger/check enforces max cap via same transaction.
- `wallets(id uuid PK, world_id, currency_id, owner_entity_id, wallet_kind player/organization/treasury, status active/frozen/closed, wallet_schema_version, created_event_id, created_at, closed_at, unique(world_id,currency_id,owner_entity_id), unique(world_id,id), composite FKs to same-world currency/entity)`; closing requires zero balance and no pending offer dependency.
- `wallet_balances(wallet_id PK/FK, available_minor bigint check >=0, row_version bigint, updated_state_revision, updated_at)`; spendable balance only—no holds/credit in MVP.
- `financial_transactions(id uuid PK, world_id, currency_id, transaction_kind initialization/issuance/transfer/asset_purchase/compensation, supply_delta_minor bigint, command_id FK unique, event_id FK unique, memo_code, memo_text nullable bounded/classified, reversal_of_transaction_id nullable, occurred_tick bigint, state_revision bigint, created_at, unique(world_id,id), composite FK world/currency)` and `wallet_postings(id uuid PK, transaction_id FK, world_id, currency_id, wallet_id, posting_ordinal, signed_amount_minor bigint check <>0, created_at, unique(transaction_id,posting_ordinal), composite same-world/currency wallet FKs)`. Both are insert-only; deferred trigger verifies currency/world and sum equals supply delta.
- `assets(id uuid PK, world_id FK, stable_key citext, asset_type, world_entity_id nullable, asset_schema_version, metadata jsonb, transferable boolean, status active/retired, created_event_id, created_at, retired_at, unique(world_id,stable_key), unique(world_id,world_entity_id), unique(world_id,id))`; no owner field and metadata validated/immutable by type/version.
- `asset_ownership(asset_id PK/FK, world_id, owner_entity_id, ownership_version bigint, acquired_event_id FK, updated_state_revision, updated_at, composite same-world entity FK)` is current projection and guarantees at most one owner.
- `asset_transfers(id uuid PK, world_id, asset_id, from_owner_entity_id nullable, to_owner_entity_id, transfer_kind initial/grant/purchase/compensation, financial_transaction_id nullable, command_id FK unique, event_id FK unique, occurred_tick, state_revision, created_at)` is insert-only and checks owners differ/paid transfer linkage.
- `asset_transfer_offers(id uuid PK, world_id, asset_id, seller_entity_id, buyer_entity_id nullable, currency_id, price_minor bigint check >0, expires_at_tick bigint, status open/accepted/cancelled/expired, created_command_id, accepted_or_cancelled_command_id nullable, row_version, created_at, updated_at, unique(world_id,id))`; partial index by open/asset/buyer/expiry and legal transition trigger; at most one open offer per asset in MVP.
- `world_economy_heads(world_id PK/FK, economy_schema_version, seed_plan_hash, initialized_event_id, reconciliation_status, last_reconciled_state_revision, checksum, updated_at)` and `economy_reconciliation_runs(...)` track initialization/verification, not balances authority.
- Append migrations and a gated idempotent economy initializer. It validates the exact compiled seed plan and artifact hash; worlds without compatible plan remain `not_initialized` with diagnostics, never receive invented money/assets. Update compiler/artifact version for future seed plans and add upcasters rather than mutating old artifacts.

### APIs, commands, events, and realtime messages

- Queries: `GET /worlds/:id/economy/summary`, `/currencies`, `/wallets`, `/wallets/:id/transactions`, `/assets`, `/assets/:key`, `/asset-transfer-offers`. Membership/participant/treasury visibility is enforced server-side; cursor bounds and amount strings are schema validated.
- `InitializeWorldEconomyV1 {compiledWorldVersionId,seedPlanHash}` is creator-confirmed or deployment-controlled system command, one-time/idempotent, only active compatible world; emits currency/wallet/asset/initial ownership and `WorldEconomyInitializedV1` events plus initialization transaction/postings.
- `TransferCurrencyV1 {sourceWalletId,destinationWalletId,amount,expectedSourceVersion,expectedDestinationVersion,memo?}` requires actor control/capability over source, same active world/currency, positive funds and idempotency; emits `CurrencyTransferredV1` linked to immutable financial transaction/postings.
- `IssueCurrencyV1 {treasuryWalletId,amount,reason,expectedSupplyVersion}` requires creator explicit override (until future issuer law), cap and rate limit; emits `CurrencyIssuedV1` and linked override/accounting facts. No ordinary admin balance edit.
- `TransferAssetV1 {assetKey,toOwnerEntityKey,expectedOwnershipVersion}` requires current owner control, transferability and recipient eligibility; emits `AssetOwnershipTransferredV1` and immutable asset transfer.
- `CreateAssetTransferOfferV1`, `CancelAssetTransferOfferV1`, and `AcceptAssetTransferOfferV1 {offerId,buyerWalletId,sellerWalletId,expectedOffer/ownership/walletVersions}` enforce seller/buyer control, future tick, exact price/currency and idempotency. Accept emits `AssetPurchasedV1`, `CurrencyTransferredV1`, `AssetOwnershipTransferredV1`, terminal offer event and one atomic revision.
- Stable errors include `ECONOMY_NOT_INITIALIZED`, `INVALID_AMOUNT_FORMAT`, `INSUFFICIENT_FUNDS`, `WALLET_NOT_CONTROLLED/FROZEN/CURRENCY_MISMATCH`, `SUPPLY_CAP_EXCEEDED`, `ASSET_NOT_OWNED/TRANSFERABLE`, `OFFER_EXPIRED/NOT_OPEN/BUYER_MISMATCH`, `OWNERSHIP_CONFLICT` and standard command conflicts.
- Outbox/realtime consequences are minimal versioned balance/ownership/offer event references for future WebSocket; no realtime browser transport yet. UI confirms via command result then refetches authoritative revisions.

### User interface

- `/worlds/[id]/economy` shows the closed-loop/no-cash-value disclosure, currency precision/supply/cap, treasury/public summary per policy, controlled wallets/balances, transfer form, immutable transaction list/detail and reconciliation status/time.
- Amount input is locale-friendly only at presentation; submission previews exact canonical decimal and minor units, recipient/currency/fee (zero) and resulting balance. Confirmation and pending/uncertain/idempotent retry/conflict/insufficient-funds states are complete.
- `/worlds/[id]/assets` shows asset identity/type/metadata/transferability/current owner according to visibility, owned filter, gift action, direct offer create/cancel/accept, exact price/expiry/current tick, and atomic purchase confirmation.
- Creator issuance is separated under an explicitly labeled override panel with reason, cap/new supply and irreversible audit warning. It never resembles deposit, banking, investing, cash value, or a real payment.
- Loading/empty/not-initialized/frozen/reconciling/mismatch/error/mobile states, keyboard/focus/error summary/live status, semantic transaction/posting tables, copyable IDs, non-color cues and axe coverage are required. Client never calculates authoritative balance or owner.

### AI behavior

AI is not used for amounts, transfers, issuance, ownership, offers, reconciliation, repair, authorization, fraud decisions or transaction-time validation. Economy initialization consumes only the deterministic compiled seed plan. No fallback invents money or owners when the plan is missing. Future AI actors will use the same commands/controller permissions and idempotency limits as users. Tests enforce no model/network dependency in economic handlers.

### Security, privacy, abuse, and integrity

- Server parses canonical decimal strings to checked `bigint`; reject float/exponent/overflow/negative/zero/excess precision. All queries and FKs enforce same world/currency; controller/authority is reloaded under transaction, never accepted from client.
- Serializable transactions, sorted row locks, expected wallet/offer/ownership/supply/state versions, immutable command idempotency and unique event/accounting links prevent double spending, duplicate rewards, race acceptance and lost title.
- Database checks/deferred trigger enforce nonnegative wallet/supply/cap and posting sum=supply delta. Application role cannot update/delete accounting/asset transfer facts. Balance/owner projections can be rebuilt and never repaired by direct edit.
- Rate/velocity limits on transfer/offer/issuance and duplicate-reward keys; frozen wallet/currency stops debit (and policy-defined credit) safely. Creator issuance is reasoned override, capped, highly visible and alerted.
- Balance/transaction visibility: owner/controllers see wallet detail; participants see their transaction; treasury/public aggregate only if configured; creator does not automatically receive private member transaction detail except an explicit audited moderation/repair policy. History uses redacted summaries.
- Asset metadata/rendering is schema bounded/sanitized; recipients and owner entities must be active. No external addresses, payment tokens, URLs, banking terms or real-world value fields exist.

### Observability and operations

- Trace command→locks→invariants→accounting/title events/projections/outbox with IDs, versions, amount bucket or minor amount only where policy allows, never private memo. Metrics include transfer/issue/purchase outcomes/latency, insufficient funds, idempotent duplicates, lock/serialization retries, wallet/supply/asset counts, open/expired offers, reconciliation mismatch, override issuance and projection lag.
- Alerts: any negative/cap/zero-sum invariant attempt, reconciliation mismatch, unusual issuance/override, duplicate reward signal, sustained serialization failure, stuck open offers past expiry, economy init/hash failure and repair command.
- Runbooks cover freeze/unfreeze by append-only command, uncertain transfer lookup, reconcile/verify, failed initialization, expired offer sweep via deterministic scheduler, compromised controller, duplicate reward investigation, backup/restore reconciliation, and append-only compensating repair with two-authority procedure.
- Feature flags gate transfers/offers/issuance independently and can freeze new debits; they cannot bypass ledger/invariants. Operational reconciliation is read-only by default and exports hashes/counts, not private full transaction data.

### Testing requirements

- Unit/property-test decimal↔minor conversion, overflow/precision, transaction/posting balancing, supply/cap, wallet/asset/offer state machines, controller/visibility policy, deterministic lock ordering and reconciliation reducers.
- Real-DB invariant tests exercise deferred posting trigger, same-world/currency composite FKs, nonnegative/cap checks, insert-only facts, one owner/open offer, initialization idempotency/hash and compiler-version upgrade.
- Concurrency tests include 100 simultaneous debits against limited funds, opposite-direction transfers/deadlock order, duplicate idempotency/reward, simultaneous gift/purchase, two offer accepts/cancel-vs-accept/expiry-vs-accept, issuance cap race and injected failure at each payment/title stage. Assert exact journal/event/projection totals and no partial result.
- Reconciliation/replay tests rebuild balances/supply/ownership from facts/events and match live checksums; deliberate projection/posting/event corruption is detected, and compensating repair appends rather than edits.
- Security tests cover forged controller/wallet/owner/system/override, cross-world/currency, stale versions, amount encodings, huge memo/metadata/XSS, rate limits, frozen state, private-history leaks and logs.
- Playwright performs the six-step two-user demo, concurrent insufficient funds, gift, direct offer atomic purchase, issuance override, not-initialized/frozen/conflict/uncertain/mobile/keyboard/axe states. Preserve M01–M07, ledger and simulation determinism suites.

### Acceptance criteria

- Golden economy initialization is deterministic/idempotent and produces exact configured currency/supply, treasury/member wallets/balances, registered assets and one owner each; missing/incompatible seed plan fails without invented state.
- Every committed transfer/purchase has immutable transaction/postings/events/ledger/projections sharing command/state revision; postings sum to supply delta, transfer delta is zero, all spendable balances/supply remain nonnegative and supply respects cap.
- In 100-way overspend and duplicate/reward tests, accepted debits never exceed available balance, each idempotency key has at most one effect, and journal/reconciled totals exactly match projections.
- Asset has no duplicate authoritative owner field; one current projection owner matches latest event. Gift/purchase races yield one winner; paid acceptance commits payment+title+offer terminal together or none.
- Issuance requires an explicit creator override/reason/cap and is distinguishable from system initialization and ordinary transfers in History/alerts.
- UI/API use decimal strings, enforce world/control/privacy and prominently disclose virtual/no-cash-out status; no AI/client/external payment path participates.
- Fresh/upgrade/initializer migrations, replay/reconciliation and all tests pass; prior demos remain operational; economy/security/repair docs and M08 handoff are complete.

### Definition of done

- Economy seed, currencies/wallets/accounting, transfers/issuance, assets/ownership/direct offers, reconciliation and UI are production-quality with no core TODO/mock/direct balance/owner edit.
- Lint/types/builds/tests pass; migration/compiler compatibility, DB invariants, adversarial concurrency/failure injection, replay/reconciliation and privacy/security checks are verified.
- Demo, telemetry/alerts/runbooks, economic-integrity review, virtual-currency disclosures, docs and M08 handoff are complete; no critical/high defect and all earlier functionality remains operational.

### Risks and mitigations

- **Double spend/duplicate reward:** checked bigint, serializable sorted locks, expected versions, idempotency, immutable postings, DB nonnegative constraints and high-contention tests.
- **Accounting journal and balances diverge:** atomic transaction, deferred sum invariant, derived projections, continuous/read-only reconciliation and append-only compensation only.
- **Two ownership sources emerge:** prohibit owner on asset/entity, authoritative transfer events plus one clearly derived current projection, schema review and replay tests.
- **Paid title transfer partially commits:** one command/DB transaction locks offer/title/wallets and writes payment/title facts; inject failure at every boundary.
- **Virtual currency misconstrued as real finance:** no external rails/cash-out/value promises, explicit product/UI/docs disclosure and careful terminology.

### Artifacts produced for later milestones

- Versioned currency/wallet/amount/transaction/posting/asset/ownership/offer/reconciliation and deterministic economy seed-plan contracts.
- Immutable accounting/title journals, balance/supply/current-owner projections, DB triggers/constraints, command handlers/events/upcasters and reconciliation/repair tools.
- Actor/treasury wallet provisioning and controller policy, exact virtual-value/privacy/visibility rules, and economy/asset UI/API.
- Concurrency, overspend, duplicate reward, atomic purchase and replay golden fixtures used by markets, production, taxation and governance milestones.
- Compiler/artifact/event/migration version changes, integrity/operations docs and `docs/milestones/M08-handoff.md` carrying every prior implementation summary, schema/migration state, test result and ADR forward.

### Standalone implementation prompt

```text
Implement Milestone 8, “Wallets/transfers/ownership,” for WorldGraph (codename Anvil).

1. Product context: WorldGraph is a server-authoritative persistent city-state. Its MVP currency is simulated, closed-loop and has no real-world value, cash-out, crypto or external payment rail. Economic and ownership changes must be authenticated commands, atomic, concurrency-safe, immutable/auditable and replayable. An asset has one authoritative ownership history/current projection; AI/client never decides value/title.
2. Expected repository state: M01–M07 provide strict TS pnpm/Turbo, Next/Fastify/BullMQ/Redis, Drizzle PostgreSQL, auth/world/member/authority/controllers/overrides/idempotency, immutable primitives/manifests, deterministic compiler/artifacts/active graph with economy/asset intent, command/event/hash-ledger/projections/outbox/history/replay, and deterministic clock/scheduler. Inspect all code/routes, contracts/catalog/manifests/compiler adapters, DB schema/migrations, event/upcasters/replay, authority/privacy, tests/git and M01–M07 handoffs. Use actual migration/compiler/event heads and golden two-user world.
3. Exact objective: initialize deterministic virtual currency/wallets/balances/assets/owners; enable safe user currency transfer, owner gift, and seller-offer/buyer-accept atomic paid title transfer; prove no overdraft/duplicate/partial ownership under contention and provide reconciliation/UI.
4. Exact scope: currency/wallet/amount/financial transaction/posting/supply/balance/asset/ownership/direct offer/reconciliation/economy seed contracts; compiler seed-plan version update and idempotent existing-world initializer; immutable accounting/title facts and projections/DB invariants; Initialize, TransferCurrency, creator-override IssueCurrency, TransferAsset, Create/Cancel/AcceptOffer commands/events; atomic paid purchase; economy/assets UI/API/privacy; adversarial tests/telemetry/docs/M08 handoff.
5. Non-goals: no real money/crypto/NFT/cash-out/custody/exchange/interest/debt/credit/negative balance/securities/gambling/external payments; no marketplace/order matching/auction, production/business/jobs/payroll/tax/budget/escrow dispute/rent/lending/governance minting; no client balance/title or direct edits.
6. Required architecture: economy/ownership modules with pure decisions and M06 handlers. JSON canonical decimal strings convert to checked bigint minor units; never JS number. Immutable financial transaction postings satisfy sum(signed)=explicit supply delta; transfer/purchase delta zero, initialization/issuance positive. Balance/supply/owner are synchronous rebuildable projections. One SERIALIZABLE command transaction locks wallets sorted plus asset/offer, rechecks controllers/versions/funds/title/expiry, writes accounting+domain+general ledger events/projections/head/outbox, commits all or none. Asset row has no owner; events are history and asset_ownership one current projection. Direct offer is seller intent, not market/escrow.
7. Required data model: add currencies, currency_supply, wallets, wallet_balances, financial_transactions, wallet_postings, assets without owner, asset_ownership, asset_transfers, asset_transfer_offers, world_economy_heads and reconciliation runs with exact bigint/string semantics, versions, checks/statuses/indexes, composite same-world/currency FKs, one wallet/owner/currency, one owner/open offer, insert-only facts and deferred posting sum=supply-delta trigger described above. Update compiler artifact/adapter version; gated initializer validates exact seed hash and never invents state.
8. Required APIs/events: scoped economy/currency/wallet transaction/assets/offer queries; InitializeWorldEconomyV1; controlled TransferCurrencyV1; reasoned creator-override/capped IssueCurrencyV1; owner TransferAssetV1; Create/Cancel/AcceptAssetTransferOfferV1 with exact versions/tick/price/wallets. Emit initialized/issued/transferred, title/offer/purchased events linked to facts and general ledger; minimal outbox refs, no browser realtime. Use stable errors listed above.
9. Required UI: /economy virtual/no-cash-value disclosure, currency supply/cap, authorized wallets/balances, canonical transfer preview/confirmation/transaction+posting detail/reconciliation; /assets identity/owner/owned filter/gift and direct offer create/cancel/accept with price/expiry/atomic confirmation; separated creator override issuance; complete not-initialized/frozen/loading/empty/conflict/uncertain/reconciling/error/mobile/keyboard/axe states. Never client-calculate authority.
10. Required tests: unit/property decimal/bigint/overflow/precision/balance/supply/posting/asset/offer/controller/visibility/locks/reconciliation; real DB deferred trigger/FKs/nonnegative/cap/immutability/one-owner/open-offer/init/compiler migration; 100 concurrent overspends, opposite transfers, duplicate reward/idempotency, gift/purchase/accept/cancel/expiry/issuance races and failure injection between payment/title; replay/reconcile and corruption detection/append compensation; forged/cross-world/amount/XSS/rate/frozen/privacy/redaction security; six-step two-user Playwright/axe; preserve M01–M07.
11. Security/integrity: checked canonical amount parsing, no float/exponent/overflow; server reloads controller/authority/world/currency under lock; serializable sorted locks+expected versions+idempotency+unique links; DB nonnegative/cap/sum and immutable facts; no direct repair; transfer/offer/issuance velocity limits/freeze; issuance explicit alerted override; participant/owner privacy; sanitized metadata/memo; no external addresses/payment/AI.
12. Migration requirements: append after actual M07 head, never rewrite old migrations/events/artifacts. Verify fresh/upgrade/no-op, constraints/triggers/roles, compiler/artifact version/upcaster and gated idempotent initializer. Existing incompatible world stays not_initialized with diagnostics; no migration invents money. Document restore/forward/append-only compensation.
13. Documentation: amount/currency/accounting model and examples, supply/posting/balance invariants, ownership source/projection, commands/concurrency/lock order/idempotency, offers/atomic purchase, seed/compiler migration, API/privacy/virtual disclosure, tests and freeze/uncertain/reconcile/init/duplicate/backup/compensation runbooks. Create M08 handoff with summary, schemas/events/compiler versions, exact migration/initializer state, actual tests/results, ADRs/deviations, ops and risks retaining all prior inputs.
14. Acceptance criteria: deterministic exact initialization or safe incompatible failure; all committed accounting links and zero/supply delta/nonnegative/cap pass; 100-way overspend/duplicate totals exact; one owner source/current projection and race winner; paid offer payment+title+terminal all or none; issuance reasoned capped override; decimal/privacy/disclosure/no AI/payment path; migrations/replay/reconcile/tests/prior demos/docs pass.
15. Commands to run: inspect scripts, then install if needed, format/lint/typecheck, unit/property tests, real PostgreSQL/Redis migration/compiler-init/constraint tests, high-contention/failure/security suite repeatedly, ledger verify and economy reconciliation/replay, Playwright/axe two-user demo, builds and clean upgrade. Record exact command/results and never claim unrun stress tests.
16. Final response format: outcome; implementation summary; files by area; migrations/initializer/compiler/event/accounting versions; demo currency/supply/wallet/asset and reconciliation hashes; tests/commands/results including concurrency counts; architecture/invariant/privacy decisions/deviations; security/ops; remaining risks/incomplete items. Never hide failure.
17. Preserve behavior: work directly in existing repository, preserve M01–M07 APIs/demos/ledger/simulation determinism, respect user changes, avoid unrelated refactors and version/upcast any intentional public/event/artifact change.
18. Completeness: no core TODOs, in-memory/floating accounting, mutable postings/events, duplicated owner column, direct admin balance/title edit, fake concurrency/reconciliation, partial purchase, skipped tests, real-money integration or AI decision. Initialization and direct offer flow must be real.
19. Inspect first: inspect all package/module boundaries, compiled economy/asset plans and versions, controller/authority, command/event/ledger/replay, clock/tick, DB schema/migrations/roles, API/UI/privacy/telemetry/tests/docs/git and every handoff before edits; follow conventions unless explicit integrity requirements are stronger.
20. Deviations: surface necessity promptly, choose smallest versioned compatible solution, test/document it and record final/M08 handoff. Never silently weaken atomicity, bigint amounts, nonnegative/supply/posting constraints, single ownership source, idempotency/concurrency, append-only repair, virtual-only boundary or selected stack.
```
