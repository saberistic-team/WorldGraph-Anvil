# API v1

All responses set no-store. Errors use the v1 envelope: error.code, a safe user-facing message, requestId, and optional bounded details. Production responses never return stack traces, infrastructure URLs, credentials, or raw dependency errors.

## GET /health/live

Returns 200 with status ok when the API event loop can serve a request. It intentionally does not probe dependencies.

## GET /health/ready

Runs bounded PostgreSQL migration-compatibility, Redis, and worker-heartbeat probes. Returns 200 with checkedAt and four component statuses when all are healthy. Returns 503 DEPENDENCY_NOT_READY with only safe component names/status codes otherwise. Recovery does not require process restart.

## GET /api/v1/system/info

Returns WorldGraph/Anvil identity, deliberate public build/compatibility versions, and whether operational smoke is enabled. It does not reveal hostnames or secrets.

## POST /api/v1/system/smoke-jobs

Registered only when operational smoke is enabled. Requires Content-Type application/json, an empty object body, Authorization Bearer token, and Idempotency-Key of 8–128 safe characters. It returns 202 queued or completed. Repeating the same key addresses the same BullMQ job and is how the UI polls completion. Invalid credentials return 401, rate limit returns 429, and Redis failure returns bounded 503 DEPENDENCY_NOT_READY. These are operational messages, not domain events.

## Identity

- `POST /api/v1/auth/register` accepts bounded email/password/display name when local closed-alpha registration is enabled; strict Origin; returns 201 safe user/session and two cookies. Conflicts use generic `REGISTRATION_UNAVAILABLE`.
- `POST /api/v1/auth/login` uses the same generic `AUTHENTICATION_FAILED` for unknown email/bad password, rotates a presented session, and returns a new cookie session. Registration/login have separate privacy-hashed account and coarse-network limits.
- `GET /api/v1/auth/me` requires the opaque session and returns only safe user fields plus idle/absolute expiry.
- `POST /api/v1/auth/csrf` requires strict Origin+session, rotates the session-bound double-submit value, and returns it for the browser client.
- `POST /api/v1/auth/logout` requires Origin+session+CSRF while active, revokes immediately, clears cookies, and returns 204. Retries after absence/revocation also return 204.

## Worlds and membership

All mutations below require JSON, strict Origin, active session, matching CSRF cookie/header, and an 8–128 safe-character `Idempotency-Key`; versioned changes also require `expectedRowVersion`.

- `GET/POST /api/v1/worlds`: list the caller’s active worlds or atomically create a draft world plus its one creator membership.
- `GET/PATCH /api/v1/worlds/:id`: view a visible world or rename it with authority/version checks.
- `GET /api/v1/worlds/:id/memberships`: minimum member identity, role, status, join time, and row version.
- `PATCH/DELETE /api/v1/worlds/:id/memberships/:userId`: creator role management or creator/administrator removal of ordinary membership. Creator transfer/demotion is not exposed; ordinary administrator demotion requires override.
- `GET/POST /api/v1/worlds/:id/invitations`: creator/administrator list or create. Creation returns the raw fragment token once; only player/observer are valid.
- `POST /api/v1/worlds/:id/invitations/:invitationId/revoke`: creator/administrator single-use revocation.
- `POST /api/v1/invitations/accept`: consumes a matching, pending, unexpired, email-bound token and activates membership atomically.
- `POST /api/v1/worlds/:id/creator-overrides`: only `membership.force_demote_administrator`; exact confirmation, reason, target, expected version, creator/platform-admin decision, linked immutable audit.
- `GET /api/v1/worlds/:id/authority/audit`: creator/platform-admin bounded audit view without metadata, emails, request bodies, or secrets.

Unknown/unjoined world identifiers return 404 without existence leakage. Visible forbidden actions return 403 with a stable code. Stale rows and changed idempotency reuse return 409. List responses are bounded and currently return `nextCursor: null`; cursor input is a recorded M02 deviation.

Command schema 1 and runtime-validatable application notification schema 1 are internal application contracts. Notification validation is contract-tested, but the current production discard sink does not validate emitted values. Notifications are non-authoritative until the Milestone 6 ledger and never contain raw credentials, cookies, CSRF, or invitation tokens.

## Primitive catalog and retrieval

All primitive endpoints require an active session during the closed alpha. Normal users can see published versions only; platform administrators may explicitly list or inspect drafts and deprecated versions.

- `GET /api/v1/primitives`: cursor-paginated exact versions with optional repeated `kinds`, repeated `tags`, lifecycle (admin), bounded query, and `limit`. The HMAC cursor is opaque and bound to normalized filters, role visibility, and limit.
- `GET /api/v1/primitives/:key/versions/:version`: exact immutable definition, content hash, lifecycle/provenance, schemas/defaults, tags, and dependency declarations/locks. Unauthorized draft access is `404`.
- `GET /api/v1/primitives/:key/versions/:version/dependencies`: `{dependencies}` for the exact version.
- `POST /api/v1/primitive-retrievals`: bounded `{query,kinds?,tags?,compatibility?,limit?}`. Returns deterministic exact-version results, hashes and dependency closure, per-channel rank explanations, index/provider provenance, warnings, and a run ID. Filters apply before rank. Lexical/tag ranking always works; unavailable semantic ranking is an explicit degraded warning.

Stable retrieval failures include `QUERY_TOO_LARGE`, `NO_COMPATIBLE_PRIMITIVES`, `RETRIEVAL_UNAVAILABLE`, `INVALID_CURSOR`, authentication/rate errors, and the common bounded error envelope. Raw queries/provider errors are not returned or logged.

## Primitive administration

These routes require platform administration, strict Origin, session-bound CSRF, JSON, an `Idempotency-Key`, and expected row version where applicable. Create/update bodies are capped at 160 KiB in both the same-origin BFF and API.

- `POST /api/v1/admin/primitives/drafts`: create a validated draft and return its current validation report.
- `PUT /api/v1/admin/primitives/:key/versions/:version/draft`: replace one matching draft with `{draft,expectedRowVersion}` and return the validation report.
- `POST /api/v1/admin/primitives/:key/versions/:version/publish`: resolve exact dependencies, lock/hash content, publish atomically, and request indexing.
- `POST /api/v1/admin/primitives/:key/versions/:version/deprecate`: record bounded safe reason/lifecycle metadata without editing semantics.
- `POST /api/v1/admin/primitives/:key/versions/:version/reindex`: upsert a provider-specific durable indexing intent and return `202` provenance.

Duplicate identical command keys replay the original bounded response. Reuse for another route/body is `IDEMPOTENCY_KEY_REUSED`; stale expected versions are `STALE_VERSION`; semantic edits after publication are `PRIMITIVE_IMMUTABLE`. A failed BullMQ wake after commit does not turn a successful publish/reindex into failure because PostgreSQL owns the job.

## Manifest Studio

Manifest routes use contract schema 4 and Manifest schema/generator/template/validator/queue schema 1. They preserve API v1, the common `no-store` error envelope, opaque identifiers, session/Origin/CSRF enforcement, idempotency, and bounded bodies. Because the native Fastify serializer cannot resolve the bounded recursive manifest schema, every response is first validated against its exact Ajv contract and only then serialized with native JSON. Cross-world or nonmember run/revision identifiers return non-enumerating `404` responses.

Authority is deliberately narrower than general platform administration:

- every active world member may read generation status, revisions, validation/provenance, and diffs;
- the active world creator or administrator may start/cancel generation and create/validate revisions;
- only the active world creator may approve, even when a platform administrator or world administrator can edit;
- no API returns stored prompt text or raw provider payload.

### Generation

- `POST /api/v1/worlds/:id/manifest-generations` accepts bounded `{prompt,seed?}` or the same body with both `parentRevisionId` and `expectedParentContentHash`. It requires a draft world, mutation protections, generation feature availability, concurrency/budget bounds, and returns `202 {runId,status:"queued",rowVersion}`. An omitted seed is resolved deterministically before persistence. The default limits are one active run per world and two across all worlds per requester; a transaction-scoped advisory lock serializes that cross-world requester count. Only queued/running/succeeded input-cache hits are reusable, so failed or cancelled input may start a fresh run. The request body limit is 16 KiB and the route limit is 10 requests per minute.
- `GET /api/v1/manifest-generations/:runId` returns durable status/stage/progress, attempts, provider/fallback outcome, sanitized error code, exact base/resolved/catalog hashes, output revision, token/cost estimates, and timestamps. It never returns the prompt.
- `POST /api/v1/manifest-generations/:runId/cancel` takes `{expectedRowVersion}` and compare-and-sets queued/running work to cancelled. Repeating the same command key is idempotent; terminal completion versus cancellation is a conflict rather than a state reversal.

Queue messages contain the run ID, base request hash, provider configuration, and generator/template/validator/queue versions. They do not contain prompt, manifest, world/user identity, or an authority decision. A wake failure after the database commit is reported as deferred coordination; PostgreSQL reconciliation retains the work.

### Revisions, validation, diff, and approval

- `GET /api/v1/worlds/:id/manifest-revisions?limit=&cursor=` returns HMAC-cursor-paginated immutable summaries, newest first, up to 100.
- `POST /api/v1/worlds/:id/manifest-revisions` accepts a Manifest v1 JSON object or safe YAML string plus `baseRevisionId`/`expectedHash`. It creates one immutable child and returns its summary plus an optional validation report ID. YAML is limited to 131,072 characters and the HTTP body is limited to 160 KiB. Syntax/schema failure creates no revision; a schema-valid but semantically invalid document may be retained as a draft with a blocking report.
- `GET /api/v1/worlds/:id/manifest-revisions/:revisionId` returns canonical JSON, safe YAML, latest report, and bounded field provenance.
- `POST /api/v1/worlds/:id/manifest-revisions/:revisionId/validate` takes `{expectedContentHash}` and creates or reuses the immutable report for validator 1 and the exact current catalog snapshot. The route limit is 30 requests per minute.
- `GET /api/v1/worlds/:id/manifest-revisions/diff?fromRevisionId=&toRevisionId=&limit=&cursor=` returns total added/removed/changed counts and the complete deterministic contract-bounded diff through HMAC-signed cursor pages of at most 200 entries. Both immutable revisions must belong to the scoped world, and the cursor is bound to that world/revision pair.
- `POST /api/v1/worlds/:id/manifest-revisions/:revisionId/approve` takes expected world version/content hash, exact warning-code acknowledgements, and the normalized world-name confirmation. It requires the latest draft, current creator authority, a fresh valid exact-pin report, and one locked transaction. Success advances the world pointer/schema and supersedes an older approval without editing either revision. An identical replay returns the recorded response.

Manifest-specific stable failures include `MANIFEST_GENERATION_DISABLED`, `GENERATION_LIMIT`, `GENERATION_TERMINAL`, `MANIFEST_PARENT_REQUIRED`, `STALE_MANIFEST_REVISION`, `MANIFEST_YAML_INVALID`, `MANIFEST_INVALID`, `APPROVAL_CONFIRMATION_MISMATCH`, `MANIFEST_NOT_LATEST`, `MANIFEST_APPROVAL_CONFLICT`, `MANIFEST_VALIDATION_FAILED`, `MANIFEST_WARNING_ACKNOWLEDGEMENT_REQUIRED`, and inherited authentication/authorization/body/rate/idempotency/stale-version errors. Worker failures surface only as sanitized stable run error codes; provider details are never returned.

`ManifestGenerationRequested`, `ManifestGenerationSucceeded`, `ManifestGenerationFailed`, `ManifestRevisionCreated`, `ManifestRevisionValidated`, and `ManifestApproved` remain schema-defined application notifications, not the Milestone 6 authoritative event ledger. No Manifest Studio route compiles or creates runtime entities.

## Compilation and read-only WorldGraph

Compilation routes use current contract/runtime schema 9, compiler `1.2.0`, compiler configuration/WorldGraph/queue schema 1, and artifact schema 3. Exact compiler `1.1.0`/artifact-2 and compiler `1.0.0`/artifact-1 verifiers remain available for stored worlds but are not selected for new compilations. A manifest approval remains inert until the creator explicitly starts compilation. Compilation is available only before first activation and always rebuilds exact authoritative input server-side; a request cannot provide artifact, graph, primitive, member, adapter, or economy-plan data.

Creator mutations require the common session, exact Origin/CSRF, JSON, `Idempotency-Key`, and current expected values:

- `POST /api/v1/worlds/:id/compilations` accepts `{manifestRevisionId,expectedManifestHash,seed}` and returns `202` with durable run identity/status. It requires the current approved revision/hash, an unactivated world, supported schemas/compiler configuration, and configured entity/relationship bounds. The route limit is 10 requests per minute.
- `POST /api/v1/worlds/:id/compilations/:runId/cancel` accepts `{expectedRowVersion}`. It can compare-and-set queued/validating/compiling work only; seeding or activation is too late.
- `POST /api/v1/worlds/:id/compilations/:runId/retry` accepts `{expectedRowVersion}` and requeues only a failed, retryable, unchanged exact input within the durable three-attempt limit.

An identical idempotency replay returns its recorded response. Reusing a key for another route/body fails. An exact input already queued/running reuses the one run; a failed run requires the retry endpoint; a completed/cancelled input cannot create another initial seed.

Every active member may use these world-scoped reads:

- `GET /api/v1/worlds/:id/compilations/:runId` and `/diagnostics` expose ordered bounded diagnostics, stages, hashes, versions, row version, and safe timestamps/status.
- `GET /api/v1/worlds/:id/compilations/:runId/artifact` reconstructs the complete verified content-addressed artifact for a successful scoped run: native compiler `1.2.0` returns `CompiledArtifactV3`, retained compiler `1.1.0` returns exact `CompiledArtifactV2`, and retained compiler `1.0.0` returns exact `CompiledArtifactV1`. Response serialization preserves every hashed field, including the matching economy seed plan and plan hash where present.
- `GET /api/v1/worlds/:id/runtime-summary` returns lifecycle, active design version, manifest/compiler/schema/seed/artifact identity, graph/controller counts, state revision, and last ledger sequence.
- `GET /api/v1/worlds/:id/entities`, `/entities/:logicalKey`, `/relationships`, and `/entities/:logicalKey/neighbors` return the authoritative relational graph. Lists and one-hop neighbors accept only contract-allowlisted filters and a maximum limit of 100. HMAC cursors bind world, kind, and normalized filters; there is no arbitrary recursion or unbounded JSON query.

All graph responses, including single-entity detail, include design/runtime revision metadata for caching. Logical keys, not physical row UUIDs, are the public graph identity. Unknown/nonmember/cross-world run or logical-key probes return a non-enumerating `404`.

Stable compilation failures include `COMPILER_DISABLED`, `MANIFEST_NOT_CURRENT`, `MANIFEST_HASH_MISMATCH`, `WORLD_ALREADY_ACTIVE`, `COMPILATION_IN_PROGRESS`, `COMPILATION_RETRY_REQUIRED`, `COMPILATION_CANCELLATION_TOO_LATE`, `COMPILATION_INPUT_HASH_MISMATCH`, compiler diagnostic codes, inherited stale/idempotency/auth/rate failures, and bounded internal availability failures. Responses never include manifest/entity content as error details, raw database/provider errors, private identity, or a stack trace.

`WorldCompilationRequested`, `WorldCompilationStarted`, `WorldCompilationFailed`, `WorldCompilationSucceeded`, and `WorldActivated` are typed wake/in-process integration notifications carrying durable IDs, hashes, and stable codes only. They are not retroactively the M06 event ledger and do not provide realtime transport.

## Authoritative world commands and history

Contract/runtime schema 6 keeps API v1 and adds independently versioned command, event, ledger, projection, outbox, and history schemas at 1. Every route below requires an active session. The mutation additionally requires strict Origin, session-bound CSRF, JSON, and the bounded command identity in its body; the server derives actor, authorization, correlation, causation, and override metadata.

- `POST /api/v1/worlds/:id/commands` accepts an allowlisted `{commandId,type,schemaVersion,payload,expectedWorldVersion,expectedStateRevision,expectedAggregateVersion,idempotencyKey}`. The initial public type is `RenameWorldEntityV1`. Exact duplicates return the exact terminal result; different identity reuse is `409`. Accepted results include event/ledger ranges and the resulting state revision. Recorded rejections may return 403/404/409/422 while retaining the typed rejection body with zero event IDs.
- `GET /api/v1/commands/:commandId` returns the scoped safe terminal/received result so a client can resolve an uncertain network outcome. It never returns command payload or hashes.
- `GET /api/v1/worlds/:id/runtime-head` returns active design/state, last event/ledger sequence, anchor artifact, and projection checkpoint identity/checksum/status.
- `GET /api/v1/worlds/:id/history` supports bounded `actorId`, `category`, `eventType`, `targetId`, `targetType`, `limit`, and signed cursor filters. Visibility is applied before pagination.
- `GET /api/v1/worlds/:id/history/:ledgerSequence` returns the visible redacted history entry plus bounded nullable command/event context and projection consequence. It never returns raw payload bytes.

Stable command rejection codes include validation/authorization denial, inactive/unanchored world, design/state/aggregate conflict, identity reuse, missing or non-renameable entity, unchanged name, disabled command type, and bounded internal failure. An unknown or unanchored world fails closed before a truthful ledger append. Accepted history is asynchronous through the durable outbox, so command status/runtime state may be current briefly before the history projection appears.

The browser rename action never applies authority optimistically. A stale result shows the current revision and asks for refresh; a network-uncertain result looks up the original command ID before allowing retry.

## Deterministic simulation clock and schedule

Contract/runtime schema 7 retains API v1 and adds clock, schedule, process, batch, failure, queue, projection, outcome, and PRNG schemas at 1. The process registry is 1 and the supported PRNG algorithm is `xorshift32-sha256-v1`. Every route requires an active membership in the path world; read responses never expose lease owner/token, raw command/event payloads, notice content outside its authorized history visibility, or unredacted failure context.

- `GET /api/v1/worlds/:id/simulation/clock` returns the exact clock/configuration, derived integer world time, design/state/clock aggregate versions, backlog, next due action, latest safe batch, capability hints, and Redis wake degradation. PostgreSQL remains authoritative when degradation is true.
- `GET /api/v1/worlds/:id/simulation/schedule` supports bounded `status`, `limit`, and opaque cursor controls. `GET /api/v1/worlds/:id/simulation/schedule/:scheduleId` is world-scoped and non-enumerating.
- `GET /api/v1/worlds/:id/simulation/batches` supports bounded status/cursor controls and returns operational identity, tick range, versions, semantic hashes, attempts, timestamps, and stable safe failure code only.
- `POST /api/v1/worlds/:id/commands` additionally accepts `ConfigureWorldClockV1`, `StartWorldClockV1`, `PauseWorldClockV1`, `AdvanceSimulationV1`, `ScheduleWorldNoticeV1`, and `CancelScheduledActionV1`. Simulation requests bind `expectedTick` as well as the inherited world/state/aggregate versions and command/idempotency identity.

Clock configuration and manual clock control require creator `simulation.manage` authority. Notice scheduling/cancellation permits active creators and administrators; clock configuration is tick-zero/paused only. System initialization/auto-pause commands, worker actor identity, and lease data are not public command variants and are rejected at the transport boundary. Exact duplicate requests replay their exact terminal result. An uncertain response must be resolved through the original command status before retry.

Stable simulation rejections include `CLOCK_NOT_PAUSED`, `CLOCK_NOT_RUNNING`, `EXPECTED_TICK_MISMATCH`, `ADVANCE_LIMIT_EXCEEDED`, `SCHEDULE_IN_PAST`, `SCHEDULE_ALREADY_TERMINAL`, `SIMULATION_HANDLER_FAILED`, and `WORLD_NOT_ACTIVE`, plus inherited authorization, validation, stale-version, idempotency, and availability codes. An accepted advance emits a summary and atomic due-action facts at one resulting state revision; no partial tick or notice execution is returned.

## Closed-loop economy and asset title

Contract/runtime schema 8 retains API v1 and adds schema-1 economy seed, currency, wallet, financial transaction, asset, ownership, direct-offer, and reconciliation contracts. Compiler `1.1.0`/artifact 2 carries a native hashed seed plan; stored compiler `1.0.0`/artifact 1 remains an explicit legacy path. All responses describe simulated virtual value only and expose the required `noCashValue: true`/`cashOutAllowed: false` boundary. Amounts are canonical decimal strings for the currency precision; minor-unit values and versions are canonical integer strings. No route accepts or returns external address, payment token, exchange rate, cash-out, or client-computed balance/title authority.

Every ordinary player-facing read is scoped to an active membership in the path world. Controller and participant filters are resolved server-side before cursor pagination. The private repair-plan read documented below has a narrower active-creator/platform-administrator authority boundary.

- `GET /api/v1/worlds/:id/economy/summary` returns initialization/provenance compatibility, virtual-only disclosure, current tick, feature policy, economy head/checksum, the last reconciliation revision/time/status, and capability hints. A compatible missing/adoptable plan is represented explicitly; it is not auto-initialized. An active creator additionally receives one server-selected `issuanceTarget` with the exact treasury wallet, balance, currency, supply, cap, precision, and concurrency versions needed for the override form. That target is an explicit issuance capability and does not claim that the creator controls the treasury entity; non-creators receive `null`.
- `GET /api/v1/worlds/:id/economy/currencies` returns bounded same-world currency definitions and public aggregate supply according to policy.
- `GET /api/v1/worlds/:id/economy/wallets` returns only wallets whose owner entity the caller actively controls, with authoritative balance/status/row versions.
- `GET /api/v1/worlds/:id/economy/wallets/:walletId/transactions` returns a bounded opaque-cursor page only to an active controller. It includes immutable transaction/posting identity, canonical amounts, tick/revision/kind and safe memo fields. A creator without participant/controller authority receives no private detail.
- `GET /api/v1/worlds/:id/assets` and `/assets/:assetKey` return bounded schema-valid identity/metadata, transferability/status, one current-owner projection and title version according to visibility.
- `GET /api/v1/worlds/:id/asset-transfer-offers` returns a bounded page of direct intents only when the caller controls the seller or targeted buyer. Supplying one exact `offerId` may additionally reveal that one still-open untargeted invitation to an active member; it never enables browsing untargeted offers. Each view includes exact price/expiry and server-derived `canAccept`, eligible-buyer-wallet, offer, and seller-wallet concurrency tokens. A false `canAccept` is authoritative for the returned snapshot.

### Private append-only repair approval API

The repair API is an authenticated review/approval surface, not a general economy editor. Both routes require UUID path parameters and return strict objects with no additional properties:

- `GET /api/v1/worlds/:id/economy/repair-plans/:planId` is available only to the world's active creator or an active platform administrator. PostgreSQL evaluates that authority. A missing plan, an unauthorized actor, or a plan whose `worldId` differs from `:id` all return the same `404 NOT_FOUND`; callers cannot use this route to enumerate plans across worlds.
- Its response is the full private `EconomyRepairPlanV1` plus `approvalStatus: { creator: boolean, platformAdmin: boolean }` and `executed: boolean`. The sealed plan fields are `domain: "worldgraph.economy-repair-plan.v1"`, `repairPlanSchemaVersion: 1`, `repairPlanId`, `worldId`, `preparedByUserId`, `reservedCommandId`, `sourceCommandId`, `sourceReconciliationRunId`, `preparedAt`, `expiresAt`, `reasonCode`, `incidentReason`, `pitrNotUsedReason`, `repairKind`, `sourceWorldVersion`, `sourceStateRevision`, `sourceEventSequence`, `sourceEconomyHeadVersion`, `sourceEconomyChecksum`, `delta`, and `planHash`.
- `repairKind`/`delta.repairKind` must be the same exact value. `reverse_financial_transaction` carries `financialDelta` and a null `titleDelta`; `reverse_asset_transfer` carries a null `financialDelta` and `titleDelta`; `reverse_asset_purchase` carries both. A financial delta contains `compensationTransactionId`, `currencyId`, `reversalOfTransactionId`, one or two `postings`, and `supply`. Each posting contains exactly `walletId`, `sourcePostingOrdinal`, `sourceSignedAmountMinor`, `compensationSignedAmountMinor`, `balanceBeforeMinor`, `balanceAfterMinor`, `balanceVersionBefore`, and `balanceVersionAfter`. Supply contains exactly `currencyId`, `sourceSupplyDeltaMinor`, `compensationSupplyDeltaMinor`, `supplyBeforeMinor`, `supplyAfterMinor`, `supplyVersionBefore`, and `supplyVersionAfter`. A title delta contains exactly `assetId`, `compensationTransferId`, `reversalOfTransferId`, `fromOwnerEntityId`, `toOwnerEntityId`, `ownershipVersionBefore`, and `ownershipVersionAfter`.
- UUID fields use canonical UUID strings; hashes are exactly 64 lowercase hexadecimal characters; version/sequence/minor-unit fields are canonical decimal integer strings; each private incident reason is 8–500 Unicode code points, has no leading/trailing ASCII U+0020 space, and contains no C0, DEL, or C1 control; and timestamps are UTC with exactly millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Treat the entire response—including delta, amounts, entity/wallet IDs, reasons, and source evidence—as private incident material. Do not place it in browser analytics, shared caches, logs, chat, or ordinary tickets.

`POST /api/v1/worlds/:id/economy/repair-plans/:planId/approvals` uses normal authenticated mutation origin and CSRF checks. It additionally requires an `idempotency-key` header whose value is exactly equal to the body `approvalId`; a missing header fails schema validation and either mismatch direction returns `400 IDEMPOTENCY_KEY_MISMATCH` before mutation authentication or service execution. The strict request body is:

```json
{
  "approvalId": "<new-approval-uuid>",
  "authorityKind": "creator",
  "confirmation": "APPROVE APPEND-ONLY ECONOMY REPAIR",
  "planHash": "<64-lowercase-hex-plan-hash>"
}
```

`authorityKind` is exactly `creator` or `platform_admin`; the database verifies that the authenticated user currently holds the claimed authority. Creator approval creates a server-controlled creator-override record. Platform-administrator approval cannot create one. A successful `200` response is strict and contains `approvalId`, millisecond UTC `approvedAt`, `approverUserId`, `authorityKind`, `creatorOverrideId`, `planHash`, `repairPlanId`, and `worldId`; `creatorOverrideId` is a UUID for `creator` and `null` for `platform_admin`.

Exact replay means the same authenticated actor, path, `approvalId`/header, authority, confirmation, and plan hash returns the original approval document, including after plan expiry or execution while the actor remains authorized. Reusing an approval ID with changed bytes, approving an already-filled authority, using the same approver for both authorities, or approving a changed/expired/executed plan returns `409 REPAIR_APPROVAL_CONFLICT`. A viewer authorized for the plan but claiming an authority they do not hold receives `403 FORBIDDEN`; a caller who cannot view the plan receives the privacy-preserving `404 NOT_FOUND`. Malformed path/header/body data returns `400 VALIDATION_FAILED`, database-rejected approval data returns `422 REPAIR_APPROVAL_INVALID`, and missing/invalid session, origin/CSRF, rate, and service failures use the inherited `401`, `403`, `429`, `500`, and `503` envelopes.

There is intentionally no HTTP repair-execution route. `RepairWorldEconomyV1` remains rejected by generic `POST /api/v1/worlds/:id/commands`; execution is available only through the audited owner-grade operator workflow in `docs/operations.md`.

The generic `POST /api/v1/worlds/:id/commands` accepts these public M08 variants in addition to the existing M06/M07 set:

- creator-confirmed `AdoptLegacyEconomySeedPlanV1` and `InitializeWorldEconomyV1`;
- controlled `TransferCurrencyV1`;
- creator-override `IssueCurrencyV1` with bounded reason and expected supply version;
- scoped `FreezeCurrencyV1`, `UnfreezeCurrencyV1`, `FreezeWalletV1`, and `UnfreezeWalletV1`;
- owner-controlled `TransferAssetV1`;
- `CreateAssetTransferOfferV1`, `CancelAssetTransferOfferV1`, and `AcceptAssetTransferOfferV1` with exact offer/title/wallet versions; and
- audited read-only-evidence `ReconcileWorldEconomyV1` at an exact economy-head version.

Adoption records an exact deterministic legacy candidate and creates no value. Initialization consumes only a persisted native/adopted plan and emits one aggregate economy-genesis fact tied to the complete materialized rows. Transfer and purchase return only after journal, projections, title/offer, ledger, checkpoints, history and outbox commit together. Issuance is visibly different from initialization and ordinary transfer. Reconciliation records evidence/status but cannot repair a fact or projection. `RepairWorldEconomyV1` is deliberately excluded from this public command surface: a separately authenticated, owner-authorized operational workflow prepares, independently approves, and executes an exact append-only reversal plan.

`ExpireAssetTransferOfferV1`, its fixed `worldgraph:economy-offer-reconciler` system actor, and system metadata are not public command variants. The worker discovers due offers directly from PostgreSQL at the authoritative persisted tick and submits the narrow command independently of Redis and continuous simulation. Accept/cancel/expire races yield one terminal result.

Stable economy rejections include `ECONOMY_NOT_INITIALIZED`, `ECONOMY_ALREADY_INITIALIZED`, `SEED_PLAN_INCOMPATIBLE`, `SEED_PLAN_HASH_MISMATCH`, `INVALID_AMOUNT_FORMAT`, `ECONOMY_INTEGER_OVERFLOW`, `ACCOUNTING_UNBALANCED`, `INSUFFICIENT_FUNDS`, `WALLET_NOT_CONTROLLED`, `WALLET_FROZEN`, `CURRENCY_FROZEN`, `CURRENCY_MISMATCH`, `SUPPLY_CAP_EXCEEDED`, `ASSET_NOT_OWNED`, `ASSET_NOT_TRANSFERABLE`, `OFFER_EXPIRED`, `OFFER_NOT_DUE`, `OFFER_NOT_OPEN`, `BUYER_MISMATCH`, and `OWNERSHIP_CONFLICT`, plus inherited authorization, validation, rate/feature, stale-version, idempotency, conflict and availability errors. An uncertain mutation is resolved by the original command ID before any retry identity is created.

## Productive commerce

Contract/runtime schema 9 retains API v1 and adds schema-1 resource, recipe, inventory/reservation, business/facility, employment/work/payroll, production, fixed-price listing/trade, tax/treasury, and commerce-expansion contracts. Economy reconciliation advances to schema 2. Compiler `1.2.0`/artifact 3/economy seed plan 2 is the only native commerce-initialization lane; exact compiler `1.1.0`/artifact 2/plan 1 and `1.0.0`/artifact 1 remain readable/verifiable but do not gain M09 state implicitly.

Every quantity is a canonical decimal string at the resource's declared scale. Every price, wage, gross, fee, tax, net, and treasury amount remains a canonical currency minor-unit integer string. Purchase preview is informational: commands accept identity, quantity, and optimistic concurrency data, while the server reloads and recomputes price, tick, ownership, output, wage, policy, and settlement. Responses retain `noCashValue: true` and `cashOutAllowed: false` and expose no external payment or redemption path.

`POST /api/v1/worlds/:id/commands` additionally accepts these public schema-1 variants:

- `InitializeWorldCommerceV1`, `CreateBusinessV1`, and `ConfigureBusinessFacilityV1`;
- `CreateEmploymentContractV1`, `AcceptEmploymentContractV1`, `EndEmploymentContractV1`, and `PerformJobV1`;
- `StartProductionRunV1`;
- `CreateMarketListingV1`, `CancelMarketListingV1`, and `PurchaseMarketListingV1`; and
- read-only-evidence `ReconcileWorldCommerceV1`.

The inherited envelope supplies `commandId`, `idempotencyKey`, `expectedWorldVersion`, `expectedStateRevision`, and `expectedAggregateVersion`; tick-sensitive requests additionally bind `expectedTick`, and targets bind their exact row versions. Exact duplicate identity returns the original terminal result. Changed payload under an existing identity fails closed. Network-uncertain results are resolved through `GET /api/v1/commands/:commandId` before creating any new key.

`CompleteProductionRunV1`, `SettlePayrollV1`, `ExpireMarketListingV1`, and `AssessPeriodicTaxV1` are registered system-only commands submitted by `worldgraph:commerce-scheduler` from completed M07 scheduled actions. Browsers cannot select that actor, causation, schedule payload, output, payroll amounts, or tax assessment. The generic command route rejects all four system variants.

### Productive-commerce reads

All routes below require active membership in the path world, use strict query schemas, and return non-enumerating not-found responses for unknown/cross-world identifiers. List limits default to the route contract and never exceed 100. Signed cursors are bound to the normalized filters. Every page carries projection status/checkpoint, current state revision, and lag so a client can distinguish empty data from a stale or uninitialized projection.

- `GET /api/v1/worlds/:id/economy/resources` supports bounded `status`, `cursor`, and `limit`.
- `GET /api/v1/worlds/:id/economy/recipes` returns immutable current recipe/version summaries.
- `GET /api/v1/worlds/:id/economy/inventories` supports `controlled`, `resourceTypeId`, cursor, and limit; private quantities require current control/management authority.
- `GET /api/v1/worlds/:id/economy/businesses` and `/facilities` return authorized organization-backed projections.
- `GET /api/v1/worlds/:id/economy/employment/offers` returns available bounded offers. `/employment/contracts` supports `status`; `/employment/jobs` returns participant/business-manager data only after authorization and before pagination.
- `GET /api/v1/worlds/:id/economy/production-runs` supports `businessId`, `status`, cursor, and limit.
- `GET /api/v1/worlds/:id/economy/market/listings` supports `resourceTypeId`, `status`, cursor, and limit. `/market/trades` supports `listingId`, cursor, and limit.
- `GET /api/v1/worlds/:id/economy/transactions` returns a bounded opaque-cursor timeline over immutable market-purchase, paid-payroll, and periodic-tax settlement facts. Market and periodic-tax rows contain only public-safe source totals; payroll rows are filtered before pagination to the worker/business participants or an active world creator/administrator. The response never includes wallet, payer, worker, employer, posting, memo, command, or controller identifiers.
- `GET /api/v1/worlds/:id/economy/market/listings/:listingId/purchase-preview?quantity=<canonical-decimal>` returns a server-computed snapshot of quantity, gross, itemized tax/fee, total, expected versions, and virtual-value disclosure. It applies the same configured disabled-policy IDs to both sales/transaction selection and marketplace-fee selection as the purchase command, so the preview cannot quote a policy that execution is configured to suppress. It neither reserves stock nor guarantees a later settlement.
- `GET /api/v1/worlds/:id/economy/treasury` and `/tax-assessments` return safe public aggregate/revenue evidence; private payer or posting detail still follows M08 participant visibility.
- `GET /api/v1/worlds/:id/economy/reconciliation` returns the current expansion checksum/status and bounded safe latest-run summary.

Business mutation authority comes from current control of the backing organization or current control of a player character whose active state declares that organization affiliation. Creator provenance alone does not grant business, employment, inventory, listing, payroll, or transaction access. Contract, job, payroll, and participant trade detail is filtered before pagination.

Stable commerce failures include validation/precision/overflow, not-initialized/incompatible-plan, stale world/state/aggregate/tick/row version, inactive/suspended business or facility, recipe/facility mismatch, insufficient/free inventory, reservation conflict, employment capacity/cooldown/status conflict, insufficient funds, listing stale/expired/not-open, self-trade, invalid policy, unbalanced settlement, schedule state conflict, and inherited authorization, idempotency, rate, feature, and availability failures. Public errors contain stable codes and safe current-version hints only; no raw policy, payroll, posting, SQL, or stack data is returned.

The mutation boundary persists target-scoped rate-limit identity rather than trusting a process-local counter, and accepted/rejected attempts run inside a `world.economy.command` trace. Trace-only command, correlation, database-transaction, tick, run, listing, trade, tax, event, outbox, and outcome fields are bounded; actor, world, idempotency-key, and wallet references are domain-separated hashes. Command payloads, amounts, and private participant data are excluded. Abuse metrics expose only the fixed `self_trade_attempt` or `rapid_circular_transfer` signal label. These signals are review evidence, never authorization or settlement authority.

### Commerce notifications and repair boundary

`CommerceNotificationV1` schema 1 defines `economy.inventory.changed`, `economy.production.changed`, `economy.listing.changed`, `economy.trade.completed`, and `economy.treasury.changed`. Each notification contains only its type, world ID, changed entity ID, state revision, and event cursor. It is an invalidation contract, not an authority or financial delta.

The worker now derives those invalidations from committed commerce domain facts while dispatching the durable outbox, runtime-validates every exact schema-1 payload, and publishes it on the deterministic internal Redis channel `worldgraph:commerce:v1:world:<worldId>`. Redis is disposable transport: a failed publish leaves the outbox message retryable; no subscribers is a successful dispatch; and an uncertain Redis-success/database-commit boundary can produce a duplicate. Consumers compare cursor/state revision, discard older hints, and refresh the authorized API rather than applying the message as state. The internal channel is not a membership boundary; any future browser gateway must authenticate and authorize the world subscription before relaying. M09 does not ship that browser WebSocket/SSE gateway.

`ReconcileWorldCommerceV1` records immutable comparison evidence and changes reconciliation status only; it cannot edit inventory, reservation, production, payroll, listing, trade, tax, treasury, or checkpoint data. Its current evidence model binds private canonical command payload/authority facts and compares exact inventory/reservation, recipe version, production snapshot/transition/movement, employment/payroll, listing/trade, tax-policy/assessment, and checkpoint material. `RepairEconomicProjectionV1` has a strict internal contract, but it is deliberately absent from `COMMERCE_PUBLIC_COMMAND_TYPES`, the API command registry, and every HTTP route. The only callable path is the owner-authorized `economy projection-repair-prepare|approve|execute` operator workflow in `operations.md`. That workflow can correct only inventory quantity/reservation projections to the exact values rebuilt from immutable movement/reservation facts; it cannot alter an immutable movement, trade, work/payroll fact, assessment, command, event, or ledger entry.

Dead-outbox retry is likewise not an HTTP API. The reviewed `pnpm outbox retry` owner workflow appends a private retry intent and requeues the same terminal message without changing its event identity or resetting attempts; see `operations.md`. API, browser, and ordinary worker credentials cannot call its database function or read its private reason.
