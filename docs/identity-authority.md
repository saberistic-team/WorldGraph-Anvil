# Identity, sessions, worlds, and authority

Milestone 2 adds the first authoritative domain boundary. The Fastify API owns identity, world membership, and authorization; browser controls are guidance only. PostgreSQL is authoritative for users, sessions, membership, invitations, idempotency, and security audit. Redis is not involved in identity correctness.

## Session lifecycle

Closed-alpha registration and login accept email/password only. Email is NFKC-normalized, trimmed, and case-folded. Passwords are bounded to 12–128 printable characters and use Argon2id with a server-only pepper. Production parameters are 19,456 KiB memory, two iterations, and one lane; tests explicitly use cheaper isolated parameters.

A successful registration/login creates new 256-bit session and CSRF tokens. Only HMAC-SHA-256 digests are stored. The session cookie is `HttpOnly`, `SameSite=Lax`, secure in production, and scoped to `/api/v1`; the readable double-submit CSRF cookie is scoped to `/`. Presenting an existing session during registration/login revokes it atomically before the new session is issued. Authentication checks user status, `auth_version`, revocation, idle expiry, and absolute expiry and extends idle expiry only up to the absolute bound. Logout requires origin+CSRF while active, revokes immediately, clears both cookies, and returns 204 on safe retries after the session is already absent/revoked.

Unsafe cookie-authenticated requests authenticate first, then require an exact configured Origin, matching cookie/header CSRF value, and the session-bound CSRF digest. `POST /auth/csrf` authenticates before checking its strict Origin and rotating the token. Logout alone remains retry-safe with 204 after a session is absent/revoked; every other protected unsafe route returns 401 before Origin/CSRF checks when unauthenticated. Registration and login use separate account and coarse-network minute buckets; keys are domain-separated HMACs, so rate-limit state contains neither raw email nor address. The limiter is API-process-local, and through the BFF its network bucket may represent the proxy rather than the end user.

IP addresses are reduced to an IPv4 /24-like or first-four-IPv6-component prefix before keyed hashing. User-agent strings are bounded then keyed-hashed. Raw passwords, cookies, tokens, CSRF values, invitation links, email rate-limit keys, IP addresses, and user agents are not logged or written to audit metadata.

## Authority model

The evaluator receives `(subject, action, resource, context)` and returns `{allowed, ruleId, reasonCode}`. Unknown actions cannot enter the typed contract and unmatched combinations deny. Current sources remain deliberately separate:

| Source                                | Current meaning                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform role `user`                  | Authenticated account; may create a world and accept a validated invitation.                                                                                       |
| Platform role `platform_admin`        | Explicit operational authority over every current action on a specifically known world, including the same reasoned override path, without a synthetic world role. |
| World role `creator`                  | Sole active creator; may manage roles, read authority audit, and explicitly override administrator demotion.                                                       |
| World role `administrator`            | May rename, invite/list/revoke invitations, list members, and remove ordinary player/observer members.                                                             |
| World role `player` / `observer`      | May read that world and its membership list only.                                                                                                                  |
| Future office/organization attributes | Accepted by context contracts but confer no authority in M02.                                                                                                      |

`worlds.created_by_user_id` is immutable provenance, never an authorization source. A nonmember receives 404 for a specifically addressed world; a visible member denied an action receives 403. Platform administrators can intentionally address a known world and receive `role: null`, preserving the fact that no world membership exists.

`world.create` is an authenticated-identity application policy. `invitation.accept` is an application policy allowed only after the repository locks and validates the invitation token hash, normalized email, pending status, and expiry. Both actions are represented in the same typed authority action/decision contract and retain their evaluator rule/reason in successful audit metadata.

Read authorization plus membership/invitation/audit reads execute in one transaction while locking the world row. All membership-affecting writers lock the same world row, closing removal/read races. Creator-affecting writes are also protected by a partial unique creator index and deferred exact-one-creator database triggers.

## Command and audit rules

Protected domain mutations use command schema 1 with server-derived actor, UUIDv7 command/correlation/request identifiers, typed action, resource, optional expected row version, bounded idempotency key, and canonical request SHA-256. `(scope, actor, key)` is unique. Same key/hash replays the stored safe response; changed input returns `IDEMPOTENCY_KEY_REUSED`. Invitation creation stores no raw token in its replay record: the token is deterministically recovered as a domain-separated HMAC of its random UUIDv7 identifier and the secret pepper.

Successful protected changes and their audit records share a transaction. Audit metadata is allowlisted and retains `authorityRuleId` and `authorityReasonCode`; a recursive database check rejects secret-like keys. Target-specific authority denials are persisted after the rejected mutation rolls back and distinguish `world` from `world_membership` targets. Audit and creator-override tables reject update/delete. Application notifications are discriminated, runtime-validatable schema-1 contracts (`IdentityRegistered`, `WorldCreated`, invitation lifecycle, membership lifecycle, and `CreatorOverrideUsed`). Contract tests exercise the validator, but the current production discard sink does not validate emitted values. They are in-process notifications, not the authoritative event ledger planned for Milestone 6.

## Invitation and override rules

Invitation links carry a 256-bit HMAC token in a URL fragment, never a query parameter. The acceptance page removes the fragment with `history.replaceState` before network work and keeps the token only in component memory. The database stores only its HMAC digest. Links grant player/observer only, expire in 15 minutes–7 days, are single-use, and may be revoked. Acceptance locks the invitation and atomically creates/reactivates membership and consumes the invitation.

Normal role changes cannot transfer/demote the creator or demote an administrator. Administrator demotion uses the allowlisted `membership.force_demote_administrator` override, exact confirmation phrase, 10–500 character reason, expected membership version, creator/platform-admin authority, linked immutable audit, and idempotent replay.

## Retention and incident operations

- Sessions: remove expired/revoked rows through a bounded scheduled maintenance operation once one exists; until then, query indexes bound operational cleanup. Keep only the incident/audit window approved for the alpha environment.
- Authentication network fingerprints: they are keyed hashes stored with the session and should expire with session retention. The same pepper is also Argon2’s secret, so rotating it invalidates existing password verification as well as session, invitation, and fingerprint digests; rotation requires an old-key migration or forced credential re-enrollment plan.
- Security audit and creator overrides: immutable at application level. Define environment retention/export policy before closed alpha; deletion, if legally required, must be a separately authorized owner operation with preserved aggregate evidence.
- Idempotency: default records expire after 24 hours. Cleanup must delete only expired rows in bounded batches.
- Compromised account: disable the user or increment `auth_version` in an owner-reviewed operation, revoke active sessions, rotate credentials/pepper if implicated, and inspect sanitized identity/authority audit.
- Invitation compromise: revoke the pending invitation; for broad exposure, revoke all pending invitations in the affected world through a reviewed owner operation and notify its creator.
- Last-creator repair: do not disable the deferred trigger. Repair only under dual approval in one owner transaction that establishes exactly one eligible active creator before constraints are checked.

## Bounded M02 deviations

List endpoints return at most 50 worlds or 100 memberships/invitations/audit records and currently return `nextCursor: null`; keyset cursor input/cleanup workers are deferred until growth requires them. The current UI uses native confirm dialogs for ordinary role/removal/revocation actions; the explicit creator override and one-time invite use dedicated dialogs. Playwright deterministically mocks API responses for UI/accessibility states; the production-built Compose acceptance script separately executes the real BFF/API/PostgreSQL cookie/CSRF two-user lifecycle.
