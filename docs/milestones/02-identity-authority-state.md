# Milestone 02 state — Identity, membership, and authority

Status: **accepted and sealed on 2026-07-21**. The final current-source aggregate, real-service integration, browser, dependency-audit, and clean production-Compose gates are green. The bounded deviations below are consciously retained architecture/test debt and do not block Milestone 03.

This is the canonical retained state for Milestone 02. Later work must read this record, [Milestone 01’s canonical state](./01-foundation-state.md), the linked ADRs, and the actual repository before changing code or migrations.

## Inputs consumed

- The attached WorldGraph/Anvil master prompt and the Milestone 02 specification and standalone implementation prompt in `docs/planning/roadmap-g-01-08.md`.
- `docs/milestones/01-foundation-state.md` and its `M01-handoff.md` pointer.
- API v1, contract/runtime schema 1, migration head `0002_platform_metadata`, M01 package boundaries, stable errors, deterministic utilities, health/operations flow, CI, ADRs 0001–0006, and all M01 retained risks.
- The actual repository layout, package files, migration journal/checksums, configuration, CI, tests, and documentation were inspected before M02 changes.

## Outcome and implementation summary

- Added closed-alpha email/password registration and login using a vetted Argon2id adapter with a server-only pepper, bounded password work, normalized email, generic authentication failures, and privacy-hashed account/network throttles.
- Added opaque 256-bit server sessions and CSRF tokens. Only domain-separated HMAC-SHA-256 digests are stored. Cookies are `HttpOnly` for the session, `SameSite=Lax`, secure in production, narrowly scoped, and never placed in browser storage. Login/registration rotate a presented session; logout revokes immediately and is retry-safe.
- Added PostgreSQL-backed users, sessions, worlds, memberships, invitations, idempotency records, insert-only security audit records, and linked insert-only creator override records.
- Added a deny-by-default typed RBAC+ABAC evaluator over subject/action/resource/context. Platform role, world membership role, immutable creator provenance, and future office/organization attributes remain separate concepts.
- Added versioned protected application commands with server-derived actor, resource, expected row version, UUIDv7 command/correlation/request identifiers, canonical request hash, scoped idempotency, and stored safe replay responses. The Milestone 06 authoritative event ledger was not introduced.
- Added world create/list/get/rename, invitations, memberships, explicit administrator-demotion override, and authority-audit services. Membership, invitation, and authority-audit reads share their authorization transaction and locked world row with membership-affecting writers; world list/get remain directly scoped, unlocked queries.
- Added typed schema-1 in-process notification contracts for identity registration, world creation, invitation lifecycle, membership lifecycle, and creator override use. They contain no raw secrets and are explicitly non-authoritative. Contract validators exist, but the production discard sink does not currently validate emitted values at runtime.
- Added accessible responsive registration, sign-in, protected dashboard, world overview/members, one-time fragment invitation, invitation acceptance, authority-aware controls, and explicit override UI. Registration/sign-in resolve protected return paths on the server so credential forms remain rendered without JavaScript and cannot fall back to URL query submission.
- Preserved M01 health, readiness, system information, worker smoke, PostgreSQL/PostGIS/pgvector, Redis, build, and failure/recovery architecture while advancing public contract/runtime schema values to 2.

## Implementation areas

- `apps/api/src/identity`: password policy/hash adapter, token/HMAC helpers, session lifecycle, actor context, and identity service.
- `apps/api/src/authority`: typed deny-by-default authority evaluator and rule/reason decisions.
- `apps/api/src/application`: schema-1 command construction and typed notification boundary.
- `apps/api/src/worlds` and `apps/api/src/repositories`: transactional world, invitation, membership, override, audit, idempotency, and world-scoped query behavior.
- `apps/api/src/routes/domain-routes.ts`: identity/domain HTTP boundary, cookie/CSRF/origin enforcement, throttles, stable errors, and response schemas.
- `packages/contracts`: identity, world, authority, command, notification, and error contracts plus compatibility version 2.
- `packages/db`: Drizzle declarations and forward migration `0003_identity_authority`.
- `apps/web/app`: authentication pages/BFF, world dashboard/detail, invitation acceptance, session-expired behavior, and accessible forms/dialogs.
- `tests/e2e`, API/DB integration tests, `scripts/compose-smoke.mjs`, CI, and identity/authority/security/operations documentation.

## Public contracts and compatibility versions

| Axis                            | Value                    |
| ------------------------------- | ------------------------ |
| API                             | `v1`                     |
| Contract schema                 | `2`                      |
| Runtime schema                  | `2`                      |
| Application command schema      | `1`                      |
| Application notification schema | `1`                      |
| Manifest schema                 | `0` (not introduced)     |
| Primitive schema                | `0` (not introduced)     |
| Compiler                        | `0.0.0` (not introduced) |

The existing schema-1 error envelope and M01 health/system/smoke APIs remain compatible. M02 adds runtime-validatable contracts for safe current-user/session views, worlds, memberships, invitations, authority audit, command inputs/responses, and authority decisions. `World.role` is `creator | administrator | player | observer | null`; `null` specifically represents a platform administrator addressing a known world without a synthetic membership.

Identity endpoints:

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/csrf`, and `GET /api/v1/auth/me`.

World/authority endpoints:

- `POST/GET /api/v1/worlds`, `GET/PATCH /api/v1/worlds/:worldId`.
- `GET /api/v1/worlds/:worldId/memberships`, role update and removal for a named membership.
- Invitation create/list/revoke under a world and `POST /api/v1/invitations/accept`.
- `POST /api/v1/worlds/:worldId/creator-overrides` and `GET /api/v1/worlds/:worldId/authority/audit`.

Protected mutations require cookie authentication, strict origin/CSRF validation, a typed request body where applicable, and an 8–128 character `Idempotency-Key`. Same scope/actor/key and request hash returns the stored response; conflicting reuse is `409 IDEMPOTENCY_KEY_REUSED`.

## Authority state

| Authority source                      | M02 capability                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Active authenticated user             | Create a world; accept an invitation only after token/email/status/expiry validation.                                              |
| Platform `platform_admin`             | Exercise every current action on a specifically known world, including the explicit override path, without receiving a world role. |
| World `creator`                       | Sole creator; manage roles, read audit, and use the explicit override path.                                                        |
| World `administrator`                 | Rename, invite/list/revoke, list memberships, and remove ordinary player/observer members.                                         |
| World `player` / `observer`           | Read the joined world and membership list.                                                                                         |
| Future office/organization attributes | Representable in authority context but grant nothing in M02.                                                                       |

`worlds.created_by_user_id` is immutable provenance only. Unmatched actions deny with a stable rule ID/reason code. A nonmember addressing a world receives 404; a visible actor denied a target action receives a stable 403. Successful protected mutations and their audit records share a transaction. Target-specific denials are written after the rejected mutation transaction rolls back; repeating a denied attempt creates another attempt audit rather than an idempotent success replay.

## Database schema, migration, and seed state

Authoritative migration head: **`0003_identity_authority`**.

| Migration                      | Purpose                                                                                                      | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `0001_platform_extensions.sql` | M01 extension schema and PostGIS, vector, citext, pgcrypto.                                                  | `94c32a2681812e85a32689f2aee8bf9cb81653c3973e7530d6b406089d03ad66` |
| `0002_platform_metadata.sql`   | M01 public runtime compatibility metadata.                                                                   | `ad2e744815621cbf66242fc0acd72f1faaa7d88c19c4991f780055c4a357e52a` |
| `0003_identity_authority.sql`  | M02 identity/world/authority tables, enums, constraints, indexes, triggers, grants, and version advancement. | `860f0a9c0d77a5c1e0fff88b7516956ab5b900ab52659502020d91b73abf646b` |

`packages/db/drizzle/meta/_journal.json` is the order authority and `meta/checksums.json` seals all three files. Never edit migrations 0001–0003 after this handoff; append a forward migration.

Migration 0003 adds seven enums and eight tables: `users`, `sessions`, `worlds`, `world_memberships`, `world_invitations`, `idempotency_records`, `security_audit_records`, and `creator_override_records`. Important invariants include:

- unique normalized `citext` email/slug, positive row/auth versions, bounded/control-character-free user text, and immutable world creator provenance;
- fixed 32-byte session, CSRF, network, user-agent, invitation, and request hashes with ordered expiry/revocation state;
- one partial unique active creator plus deferred constraint triggers requiring exactly one active creator for every unarchived world;
- one pending invitation per world/email, player/observer-only grants, ordered expiry/acceptance/revocation state, and single hashed token;
- bounded idempotency keys/responses with recursive rejection of secret-like JSON keys;
- bounded, recursively secret-key-checked audit metadata; update/delete rejection on audit/override tables; and a composite FK linking each override to the same actor/world audit record;
- explicit runtime grants: users are selectable, registration may insert only `id/email/password_hash/display_name`, and login may update only `last_login_at`; audit/override tables are select/insert only.

`platform_metadata.runtime_versions` is advanced idempotently from contract/runtime schema 1 to 2. There are no production users, sessions, worlds, invitations, memberships, or other domain seeds. Deterministic users/worlds exist only inside tests. Production startup still never migrates and there is no destructive down migration; recovery uses a stopped incompatible release, restore/PITR where required, and reviewed forward repair.

## Actual verification evidence

Evidence below was collected locally on 2026-07-21. Host checks used Node `v24.18.0`; release/Compose images use pinned Node `22.20.0`. No pending command is represented as passed.

| Command/gate                                                           | Actual result                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./node_modules/.bin/prettier --check .`                               | Passed against the current source after formatting `docs/identity-authority.md`.                                                                                                                                                                                                       |
| `./node_modules/.bin/eslint . --max-warnings 0`                        | Passed with zero warnings against the current source.                                                                                                                                                                                                                                  |
| Direct `tsc -p` for all 8 workspaces                                   | Passed 8/8 against the current source.                                                                                                                                                                                                                                                 |
| `./node_modules/.bin/vitest run --config vitest.unit.config.ts`        | Passed: 12 files, 47/47 tests.                                                                                                                                                                                                                                                         |
| `node --import tsx packages/db/src/cli/check-migrations.ts`            | Passed at `0003_identity_authority`; journal and sealed digests agree. The ordinary `tsx` wrapper first failed only because this restricted agent sandbox denied its local IPC socket.                                                                                                 |
| `apps/web/node_modules/.bin/next build`                                | Passed current source: optimized production build, TypeScript, and 13 routes; `/register` and `/sign-in` are dynamic server-rendered routes.                                                                                                                                           |
| Targeted real-PostgreSQL API integration after the auth-rate-limit fix | Passed: 1 file, 2/2 tests covering the real multi-user lifecycle, authority/audit/idempotency, platform admin, session rotation/logout retry, and normalized-account throttle.                                                                                                         |
| `pnpm test:integration`                                                | Passed final current source: 3 files, 15/15 tests — database migrations/constraints 11, API identity/authority 3, and Redis/BullMQ worker 1.                                                                                                                                           |
| Clean production Compose build and `scripts/compose-smoke.mjs`         | Passed against the final dependency graph after a clean volume/rebuild: migration through 0003, healthy non-root services, real same-origin BFF cookie/CSRF multi-user world/invite/member/override/audit flow, worker idempotency, Redis loss/recovery, and PostgreSQL loss/recovery. |
| `pnpm test:e2e`                                                        | Passed final current source: 14/14 across desktop Chromium and exact 320×720 Chromium, including no-JavaScript credential URL safety and axe flows. An earlier 12/14 stale-image result exposed the server-rendering regression and was superseded by this clean run.                  |
| `pnpm audit --audit-level high`                                        | Passed with zero high/critical findings after pinning patched `sharp` 0.35.3; the registry still reports one low and two moderate findings.                                                                                                                                            |
| Aggregate `pnpm check` after all final edits                           | Passed: formatting, zero-warning lint, 8/8 workspace typechecks, 47/47 unit tests, migration integrity at 0003, and 8/8 production builds including 13 Next.js routes.                                                                                                                 |

The production-built Compose acceptance is real backend/BFF/PostgreSQL evidence. Playwright deliberately intercepts API responses for deterministic UI/accessibility checks and is not evidence of a real browser-to-database two-user lifecycle.

Resolved failures retained for later maintainers:

- The initial auth limiter interpreted Fastify’s `isAllowed` field instead of its `isExceeded` field, rejecting valid registration. The route now uses the correct exceeded predicate and the targeted real-DB API integration passes.
- The BFF initially attempted to construct a `Response` with a body for upstream HTTP 204, causing logout failure. It now preserves a null body for 204.
- Auth pages initially used client `useSearchParams`, which caused no-JavaScript production rendering to fall back to `Loading…`. Server pages now resolve and validate `searchParams` and pass a safe return path into the form.
- A failed-login audit initially supplied a target type without a target ID, violating the audit target-pair constraint. Generic authentication failure audits now preserve the database invariant without exposing account existence.
- Input normalization failures initially escaped as HTTP 500 and unsafe middleware checked Origin before authentication. The final boundary maps identity input to stable 400 responses, normalizes override reasons before commands, and uses authentication → Origin → CSRF ordering with retry-safe logout as the documented exception.
- The final dependency audit found a high-severity transitive `sharp` advisory. The workspace now overrides it to patched 0.35.3; the repeated high/critical audit, build, browser suite, and production-image smoke are green.

## Architecture decisions retained

- ADRs 0001–0006 from M01 remain in force: modular monolith, PostgreSQL durable authority, authoritative server/AI boundary, runtime contracts/canonical JSON, disposable idempotent queue, and independent compatibility axes/forward migrations.
- [ADR 0007](../adr/0007-identity-authority-boundary.md): PostgreSQL-backed opaque identity and explicit typed authority. Membership is the current world-role source; platform role, creator provenance, future authorities, override use, and audit are distinct.
- Application notifications are typed schema-defined in-process integration contracts, not durable domain events or a substitute for the M06 ledger. Runtime schemas/validators exist, but the production discard sink does not currently execute validation.
- World-row locks serialize membership, invitation, and authority-audit reads with membership-affecting writes; directly actor-scoped world list/get queries remain unlocked. Database triggers remain the final exact-one-creator invariant.
- Platform administrator access does not create a synthetic membership. The API returns `role: null` for a known world viewed under platform authority.

## Operational and feature-flag state

- `ENABLE_LOCAL_REGISTRATION` controls the local/closed-alpha registration path. There is no public enrollment, verification, reset delivery, MFA, or social login.
- `AUTH_PEPPER` is API-only, required at 32+ characters, and rejects production values containing `replace-with` or `local-only`. It is both Argon2’s secret and the HMAC key; rotating it invalidates existing password verification plus session/invitation/fingerprint comparisons and therefore requires old-key migration or forced credential re-enrollment.
- `SESSION_IDLE_TTL_SECONDS` and `SESSION_ABSOLUTE_TTL_SECONDS` are bounded and ordered. Sessions extend idle expiry only to the absolute bound.
- Existing M01 `ENABLE_OPERATIONAL_SMOKE`, `OPERATIONS_TOKEN`, OTLP, liveness/readiness, worker heartbeat, and dependency failure/recovery behavior remain.
- Recommended alerts cover authentication failure/rate-limit spikes, repeated cross-world denials, invitation abuse, unusual overrides, expired-record cleanup failure, migration failure, and existing dependency/worker signals.
- Runbooks cover compromised account disable/auth-version bump and session revocation, invitation invalidation, dual-approved last-creator repair, bounded session/idempotency cleanup, migration forward repair, and Redis/PostgreSQL recovery.

## Security, privacy, and integrity state

- Argon2id production parameters are 19,456 KiB memory, two iterations, and one lane; tests use explicitly cheaper isolated settings. Password input is bounded to 12–128 printable characters to limit hashing denial of service.
- Session, CSRF, invitation, network-prefix, and user-agent values use domain-separated keyed hashes; raw passwords, cookies, tokens, CSRF, invitation links, IP addresses, user agents, and request bodies are excluded from logs/audit metadata.
- Unsafe cookie-authenticated requests require an exact allowed Origin and session-bound double-submit CSRF. Identity/member responses are `no-store`; the browser BFF forwards only allowlisted same-origin headers and never bearer credentials.
- Invitation links put the raw token in a URL fragment, remove the fragment before network work, keep the token only in component memory, store only its digest, grant only player/observer, and are single-use/revocable/expiring.
- Repository queries are world-scoped and responses return minimum necessary membership fields. Password hashes and member emails are never returned by membership queries.
- Override use requires an allowlisted action, exact confirmation phrase, bounded nonblank reason, expected membership version, creator/platform-admin decision, and one linked immutable audit/override pair. Replays do not duplicate either record.
- Cleanup indexes exist, but retention durations and legally required audit export/deletion policy must be approved before closed alpha.

## Accepted carry-forward deviations and risks

These items are explicit debt, not silently represented as completed scope. The architecture decision at seal is that they do not compromise M03 registry correctness because PostgreSQL authority is re-evaluated per request, registry administration remains platform-admin-only, and M03 does not depend on email delivery, cleanup automation, or real-browser backend fixtures.

- Playwright currently contains 7 deterministic tests executed in desktop and 320×720 projects (14 cases) with mocked API responses. It does not yet execute the required real two-user registration/login/logout/refresh/invite/role/forbidden/override journey and does not cover every invitation error, loading/error, keyboard, XSS, or mobile state. Compose supplies real backend lifecycle evidence but is not a real browser substitute.
- API/DB tests do not yet comprehensively cover invitation acceptance races, duplicate invitation creation, stale versions/rollback, idle/absolute session expiry, every unsafe-origin/CSRF mismatch, authentication enumeration comparison, every unauthenticated mutation, open redirects, unsafe rendering, or log/token leakage. Existing tests cover important representatives, not the full required matrix.
- The real Compose script covers registration, login rotation, world/invite/accept, a forbidden player rename, promotion, administrator invite/revoke, override replay/audit, logout retry, worker idempotency, and dependency recovery. It does not exactly perform every six-step demo action: logout then sign back in both users, player invite/promote denials, or creator-transfer/last-creator attempts.
- Privilege changes do not revoke/rotate all active sessions. Sessions contain no cached world authority and each protected request reloads the user and membership from PostgreSQL, so removal/demotion takes immediate effect; nevertheless, account-wide revocation on privilege changes remains defense-in-depth work before closed alpha.
- The UI returns safe session expiry in `/auth/me` but does not yet present a dedicated account/session-expiry view.
- List queries are bounded to 50 worlds or 100 memberships/invitations/audit records and return `nextCursor: null`; keyset cursor input is not implemented.
- The UI uses native confirmation for ordinary membership/invitation actions. The security-sensitive creator override and one-time invitation have dedicated dialogs.
- Authentication throttles are privacy-keyed but in-process. Through the same-origin Next BFF, the coarse network bucket may identify the BFF/container rather than the end user. Define trusted-proxy forwarding and use a shared bounded limiter before horizontal scaling.
- Cleanup indexes exist, but no scheduled bounded session/idempotency/invitation cleanup worker exists. Monitor growth and add one before closed alpha.
- Alert/runbook text exists, but alerts are not deployed, cleanup is not executable, and no managed backup/PITR restore drill or command-stage trace/decision-by-rule dashboard has run. Production `Secure` cookie configuration is code-reviewed but lacks a dedicated production-mode regression.
- There is no email delivery; local closed-alpha UI displays the raw fragment link once. Platform administrators can address only a known world ID; no global world enumeration endpoint is exposed.
- The custom authentication surface is intentionally narrow and uses vetted primitives, but it still requires independent security review before closed alpha. No hosted preview, managed backup/PITR, retention implementation, or restore drill exists yet.
- Migration 0003 is forward-only. No automated down migration is supplied. The non-authoritative notification adapter intentionally supplies no durable delivery guarantee before M06, and the production discard sink does not yet runtime-validate emitted notification objects.

No social login, password reset/verification/MFA, account deletion/export, teams, world transfer/deletion, political offices/organizations/laws, primitives, manifests, compiler, simulation, economy, assets, realtime multiplayer, WebGL, external AI, graph database, Kafka, or Kubernetes was introduced.

## Inputs for Milestone 03

Milestone 03 will inherit API v1, contract/runtime schema 2, command/notification schema 1, migration head `0003_identity_authority`, users/sessions/worlds/memberships/invitations/idempotency/audit/override tables, the actor context and authority evaluator, the platform/world role separation, the BFF/cookie/CSRF boundary, typed application notifications, ADRs 0001–0007, and every retained M01/M02 risk.

Milestone 03 is authorized to start from this sealed state. It must append after 0003, preserve existing API v1 compatibility, keep all registry mutations inside authenticated/authorized/idempotent/audited commands, and must not treat current application notifications as the M06 ledger. The accepted debt above remains visible until a later milestone closes or explicitly re-retains it.
