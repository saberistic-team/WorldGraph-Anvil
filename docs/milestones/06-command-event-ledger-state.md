# Milestone 06 state — Authoritative command/event ledger, history, and replay

Status: **complete and sealed**. This is the canonical M06 input and authorizes Milestone 07. No planned or historical result is substituted for the completed evidence below.

## Inputs consumed

- The complete sealed M01 state: API v1, contract/runtime schema 1, deployable modular-monolith shell, PostgreSQL/Redis authority split, canonical JSON and deterministic utilities, health/telemetry/CI/Compose baseline, forward-only migration discipline, and ADRs 0001–0006.
- The complete sealed M02 state: contract/runtime schema 2, identity/session/world membership, creator and platform authority, Origin/CSRF/BFF boundary, idempotency and security-audit foundations, migration `0003_identity_authority`, ADR 0007, and all retained identity/operations risks.
- The complete sealed M03 state: contract/runtime schema 3, primitive/index schema 1, immutable reviewed 16-item catalog, deterministic bounded retrieval, PostgreSQL-authoritative worker recovery, migration `0004_primitive_registry`, ADR 0008, and all retained registry/security risks.
- The complete sealed M04 state: contract/runtime schema 4, immutable Manifest v1 revisions/reports/provenance, latest-only creator approval, durable generation/cancellation/provider accounting, migration `0005_manifest_studio`, ADR 0009, and all retained provider/profile/operations risks.
- The complete sealed M05 state: contract/runtime schema 5; compiler `1.0.0`; compiler configuration, artifact, WorldGraph and wake schemas 1; immutable graph/runtime projections; exact activation authority; migration `0006_deterministic_compiler` and its digest; golden identities; ADR 0010; and all retained compiler/privacy/release risks.
- The standalone M06 prompt in `docs/planning/roadmap-g-01-08.md`. Deterministic simulation clock/ticks, economy, governance, patches, realtime transport, WebGL/media and AI runtime authority were not pulled forward.

## Outcome and implementation summary

Milestone 06 establishes one PostgreSQL-authoritative mutation boundary for active worlds. A command is authenticated, bounded, idempotency-bound, serialized per world, version-checked and decided through a closed registry. Its terminal result, immutable event, hash-chained ledger evidence, synchronous projection change, runtime/checkpoint advancement and minimal outbox reference commit atomically. Relational tables remain the current query projection; events and ledger entries are ordered recovery and audit facts, not a second eventually consistent authority.

The release adds:

- `packages/contracts`: strict v1 command/result/status, actor/metadata, event/genesis/lifecycle/repair, ledger, projection checkpoint, outbox reference, runtime-head and redacted history list/detail contracts; compatibility schema 6; and independent schema constants for each new axis.
- `packages/ledger`: canonical event and ledger hashing; payload privacy classification; typed command/event registries and one-step upcaster chains; the pure `RenameWorldEntityV1` decision and `WorldEntityRenamedV1` reducer; lifecycle/history templates; ledger verification and bounded export models; deterministic compiled-graph replay/checksum/compare; and fixtures that prohibit ambient time, locale, network, AI and randomness from recovery.
- `packages/db`: forward migration `0007_command_event_ledger`, Drizzle mirrors, owner-defined write gates and allocation triggers, lifecycle DML guards, exact terminal deferred proofs, honest M05 import anchors, fresh compiled genesis, replay/shadow storage, and the guarded repair-swap function.
- `apps/api`: the generic command/status/runtime-head/history API, strict Origin/CSRF/session authority, actor/world/type/request-bound idempotency, IP + SHA-256 session + world rate keys, per-world advisory serialization with a stable three-attempt exhaustion result, signed canonical history cursors, and compatibility adapters for preserved world/membership/invitation/override/manifest routes.
- `apps/worker`: PostgreSQL-authoritative outbox reconciliation, fenced claims, retry/dead-letter state, deterministic redacted history projection and unique consumer receipts. Duplicate or lost Redis wakes do not change accepted authority.
- `apps/web`: authoritative entity rename from the graph explorer, uncertain-outcome lookup by command ID, stale-revision refresh behavior, runtime identity, and an accessible responsive World History list/filter/detail experience. Raw command/event payloads are never rendered.
- Operations and observability: `ledger verify/export`, `projection replay/compare/repair-swap`, owner-and-platform-admin operator authorization, mode-`0600` audited exports, ledger/outbox/replay/repair runbooks, bounded command/outbox measurements and spans, and `deploy/alerts/command-ledger-v1.rules.yml`.

## Compatibility and public contract state

| Axis                                  | M06 state                              |
| ------------------------------------- | -------------------------------------- |
| Product/API                           | WorldGraph / Anvil, API `v1` unchanged |
| Contract schema                       | `6`                                    |
| Runtime schema                        | `6`                                    |
| Authoritative command schema          | `1`                                    |
| Domain event schema                   | `1`                                    |
| Ledger schema                         | `1`                                    |
| Projection schema                     | `1`                                    |
| Outbox schema                         | `1`                                    |
| History schema                        | `1`                                    |
| Compiler                              | `1.0.0` unchanged                      |
| Compiler config/artifact/WorldGraph   | `1` / `1` / `1` unchanged              |
| Compilation wake                      | `1` unchanged                          |
| Manifest/generator/template/validator | `1` unchanged                          |
| Primitive/index                       | `1` unchanged                          |
| Application notification              | `1` unchanged                          |

The stable API v1 error envelope and `no-store` policy remain. New schema axes evolve independently and stored event bytes are immutable. A registry may explicitly upcast a known prior payload one version at a time; an unknown event/version or a gap fails closed.

The public generic vertical slice is `RenameWorldEntityV1` only. It requires command ID, schema/type, bounded payload, expected world/state/aggregate versions and idempotency key. Exact duplicates return the exact stored result; changed reuse is rejected. Accepted results report event and ledger ranges plus the resulting state revision. Scoped status lookup resolves uncertain transport outcomes without exposing payload/hash data. One accepted mutating command advances the world state revision once.

Preserved active-world routes are adapted from the M06 boundary forward for `world.rename`, membership role change/removal, invitation create/revoke/accept, creator override use, and manifest revision create/approve. Their registered facts are `WorldRenamedV1`, `WorldMembershipRoleChangedV1`, `WorldMembershipRemovedV1`, `WorldInvitationCreatedV1`, `WorldInvitationRevokedV1`, `WorldInvitationAcceptedV1`, `CreatorOverrideUsedV1`, `ManifestRevisionCreatedV1` and `ManifestApprovedV1`. These routes retain their established HTTP responses and idempotency records rather than masquerading as generic command-bus responses.

## Command, ledger, and projection invariants

- The repository takes a per-world session advisory lock before starting the serializable transaction, preventing a waiting writer from inheriting a stale snapshot. At most three complete attempts are made for retryable serialization failures.
- The server derives actor type/identity, world, authorization rule, correlation, causation and override context. Clients cannot select system/AI/platform actors or supply privileged metadata.
- The owner-written gate accepts only pristine unanchored compiled genesis or a structurally valid active anchor. It verifies the active version/artifact, anchor event and sequence-one entry hashes, successor link, current event/ledger hashes and head parity, and live runtime/checkpoint/checksum parity before granting the transaction-local write context.
- Security-definer triggers alone allocate contiguous per-world event/ledger sequences and per-aggregate versions. The application role cannot write the heads. A deferred terminal assertion proves exact accepted/rejected event, ledger and outbox cardinality, head linkage, state-revision and projection-checksum results; an opened command cannot commit in `received` state.
- Anchored rejections append one redacted `command_rejected` ledger fact and no event/projection change. The gate recomputes the opening projection so a rejection cannot hide a mutation. Visible anchored-world denials also produce deterministic security audit evidence.
- Corruption of the anchor entry, the current ledger hash/head, event linkage, runtime/checkpoint identity or live projection freezes ordinary commands. Only the causation-bound, owner-run `ProjectionRepairAnchoredV1` path may open against a demonstrated live projection divergence after a successful unchanged-head replay.
- Active-world lifecycle DML is guarded by exact command/event identity and strict changed-column allowlists. Pregenesis world design, generation/compilation bookkeeping and derived invitation expiration retain their explicitly scoped direct transitions; a missing/corrupt anchor cannot be treated as pregenesis.
- History is a rebuildable redacted view. Visibility (`public`, `member`, `creator`, `operator`) is applied in SQL before ordering, limiting and signed cursor generation. Generic accepted-command history is asynchronous through outbox delivery; adapted legacy routes preserve synchronous relational behavior and idempotent outbox/history handling.

## Genesis, migration, and data state

Journal head is **`0007_command_event_ledger`**. Migrations 0001–0006 remain byte-identical to their sealed state. The final migration 0007 SHA-256 is **`4ab7ec51af8d137b219f7796e2b41c97b5e49979dea47613cf4323f0d3b3781f`**. It requires exact M05 compatibility, advances contract/runtime from 5 to 6 and starts command/event/ledger/projection/outbox/history at 1. It is forward-only and must never be edited; M07 must append `0008` after it.

M06 adds eight enums for actor, command status, payload classification, ledger entry kind, checkpoint status, outbox status, history visibility and replay status. It extends `world_runtime_heads` with event position, genesis anchor identities, schema axes and projection checksum. New authoritative structures are `command_records`, `world_ledger_heads`, `aggregate_stream_heads`, `domain_events`, `ledger_entries`, `projection_checkpoints`, `event_consumer_receipts`, `outbox_messages`, `world_history_entries`, `projection_replay_runs`, `shadow_world_entities`, `shadow_world_relationships` and `shadow_world_entity_controllers`, plus the canonical-hash/checksum/gate/genesis/replay/repair functions and restrictive grants/triggers.

The exact M05→M06 upgrade locks each real active graph and creates one honest `WorldStateImportedV1` anchor. It uses deterministic per-world command/event/ledger/outbox IDs, the real active version/artifact and graph/controller counts, the recomputed projection checksum, opening state/event/ledger positions of zero with no prior checksum, sequence one event/ledger/checkpoint/history, and one exact pending `DomainEventReferenceV1`. A repeated migration does not create a second anchor. It invents no earlier actions and creates no world, manifest, compilation or graph seed.

Fresh successful activation invokes `worldgraph_append_compiled_genesis` inside the existing activation transaction. `WorldCompiledGenesisV1`, its real artifact/count/checksum provenance, ledger/checkpoint/outbox/history and runtime anchor either commit with the graph or all roll back. The reviewed 16-primitive catalog remains the only production content seed. The M05 compiler golden artifact remains byte-identical at SHA-256 **`4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`**, with 35 entities, 40 relationships and 1 controller in the one-member fixture.

## Replay, operator, and repair state

`ledger verify` checks canonical event bytes, contiguous event/ledger positions, event links, previous/entry hashes, allocation/runtime heads, anchor identity and live projection checksum, and reports the first divergence without editing authority. Replay starts from the immutable compiled genesis artifact, applies the ordered registered events through pure reducers/upcasters and persists isolated shadow graph rows. Compare is read-only. World/membership/invitation/manifest lifecycle facts advance ordering, history and state revision but do not mutate compiled graph entity/relationship/controller rows; those legacy relational tables remain their current projections.

Privileged export/replay/compare/repair requires `OPERATIONS_DATABASE_URL` connected as the database owner or a member of the owner role and an explicit active platform-administrator `--actor`. Export authorizes and audits before reading raw rows, creates a new `0600` file, refuses overwrite and audits completion/range/count/hash without recording the local path or payload. Repair requires explicit confirmation, an incident reason, a successful matching shadow replay at an unchanged source head, a real live divergence and two distinct active administrator approvals. The executor identity is recorded separately; the repair ledger details retain `approvedByFirst`, `approvedBySecond` and `executedByActor`. A successful swap appends `ProjectionRepairAnchoredV1`, ledger/outbox/operator-history evidence and advances `R → R+1`; no existing event or ledger row is changed.

## Security, privacy, and operations state

- Command payload, event metadata, ledger details, history summaries and outbox references are size-bounded, allowlisted and recursively reject secret-like keys. Entity display-name changes also reject private-looking values. Public APIs/logs/metric labels exclude payload bytes, entity state, request hashes, session/IP material and raw identifiers where cardinality would be unsafe.
- Command rate limiting binds the world plus source IP and a SHA-256 session identity rather than storing a raw session token. Database uniqueness, advisory serialization and expected versions remain the correctness controls when process-local throttling is bypassed.
- Hash chaining provides tamper evidence, not immunity from a fully privileged database operator. Restricted roles, encrypted backups/PITR, external checkpoints, independent verification and incident evidence retention remain separate deployment controls.
- Outbox dead letters never roll back an accepted fact. Redis is only a wake mechanism; PostgreSQL reconciliation and unique consumer receipts make loss and duplicate delivery recoverable.
- Low-cardinality telemetry covers command outcome/duration/event count/conflict/serialization retry, outbox backlog/age/dead state, history delivery, replay outcome/duration and integrity findings. Alert rules cover failure ratio, serialization pressure, conflict spikes, old backlog and dead letters. Rule loading, dashboards and paging routes are deployment responsibilities.

## Final verification evidence

Evidence was collected on 2026-07-21/22 EDT with Node `24.18.0`, pnpm `11.9.0`, the PostgreSQL 17 test image and Redis `8.4.0`. Only completed commands are counted.

| Check                                                       | Final result                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Aggregate repository gate (`pnpm check`)                    | Passed: Prettier and ESLint with zero warnings; **12/12** package typechecks; compiler `1.0.0/config-1` golden SHA-256 `4ef1761d...6e529d`; **61 files, 350/350 unit tests**; migration journal at `0007_command_event_ledger`; **12/12** package production builds including the History route; and the separate-process offline compiler CLI with the same artifact identity.                                                                                          |
| Real PostgreSQL/Redis integration (`pnpm test:integration`) | Passed: **14 files, 105/105 tests**. Coverage includes fresh and exact M05 upgrade/repeat, honest import and fresh compiled genesis, command gate/grants/hash equivalence, accepted/rejected/rollback atomicity, 50-way same-revision concurrency, corruption freeze, lifecycle adapters and denial audit, outbox recovery/receipts/history, replay/compare and guarded repair, plus all retained M01–M05 integration coverage.                                          |
| Browser/accessibility (`pnpm test:e2e`)                     | Passed: **54/54 Playwright journeys** using desktop Chromium and 320-pixel mobile, including accepted rename recovery, stale conflict without retry, visibility-filtered History list/detail, graph/runtime identity, keyboard/mobile flows and retained identity/catalog/manifest/system journeys.                                                                                                                                                                      |
| Production Compose (`pnpm bootstrap`; `pnpm test:compose`)  | Passed: final locked-dependency images rebuilt and all services/migration became healthy; the retained-data production smoke then passed **twice consecutively** with unique worlds, primitive bootstrap/retrieval, two-user authority, provider-disabled generation/approval, compile/activation/artifact/graph, idempotent worker delivery, and live Redis/PostgreSQL stop/degraded/restart/recovery. Fresh/upgrade database paths are covered by the integration row. |
| Focused M06 evidence                                        | Passed: command-event database invariants 17/17; compiler/runtime command cases 6/6; operator CLI 5/5; worker compiler/outbox cases 11/11; focused unit/route/ledger/history coverage 61/61. The compiler golden artifact identity above remained unchanged.                                                                                                                                                                                                             |
| Independent blocker audit                                   | **GO** after the command-gate, lifecycle DML, honest-backfill, corruption-freeze, operator-authorization and cross-suite corrections. No remaining P0/P1 correctness, security, replay, migration or architecture defect was reported.                                                                                                                                                                                                                                   |

One non-failing `pg@8` deprecation warning about `client.query` while a client is already executing can appear during the deliberately concurrent compiler/runtime integration case. The suite completes green; replacing that legacy concurrent client-use pattern remains retained cleanup.

The first two pre-seal Compose attempts failed usefully on stale M05 smoke expectations (contract/runtime `5` and pre-ledger runtime revision/sequence `0`). The smoke contract was corrected to require all six M06 schema axes at version 1 and compiled genesis revision/ledger sequence 1; the two final consecutive runs above are the post-correction evidence. No production implementation was weakened to make the smoke pass.

## Architecture decisions and deviations

- ADRs 0001–0010 remain. ADR 0011 accepts the PostgreSQL command/event/ledger boundary, pure replay into isolated shadow projections, relational current-state queries, honest genesis, and explicit owner-only evidence-appending repair.
- The generic public command bus currently registers one vertical slice, `RenameWorldEntityV1`. Preserved M02–M05 mutation routes use a commands-owned canonical store/gate adapter but are not literally routed through the generic `WorldCommandBus`; retaining their established response contracts avoids a breaking API fiction.
- The replay checksum covers compiled entities, relationships, controllers, active design identity and world state revision. Lifecycle events have no compiled-graph row mutation; world/membership/invitation/manifest relational tables remain current synchronous projections rather than being rebuilt by the M06 graph replay.
- An unknown/non-visible world or unresolved invitation token cannot receive a world-ledger rejection without leaking existence or fabricating a binding. These cases retain non-enumerating failure; truthful visible anchored-world denials are durable.
- World creation remains pregenesis. Identity/session/auth internals, primitive/manifest generation and compilation job computation/status are not retroactively event-sourced. M06 begins recording adapted active-world actions from its deployment boundary only.
- Invitation expiration is derived security-token housekeeping and may transition directly under its constrained database rule; it is not a simulation fact or graph revision command.
- Generic accepted history is asynchronous and rebuildable from the outbox. Adapted legacy routes retain synchronous relational results plus idempotent outbox/history behavior. Authority is the committed command/event/projection state even when history delivery is briefly pending.
- `expectedAggregateVersion` in history detail is nullable because genesis, compatibility adapters and operator facts do not all originate from the public aggregate-concurrency field. The event itself still carries an allocated positive aggregate version.
- The API and ordinary worker continue to share the inherited application database role. Owner-grade operations credentials are kept out of both, but production should further split API, compiler worker and history worker capabilities.
- External hash checkpoints, continuous privileged integrity scans, managed alert loading/dashboards/paging, encrypted backup/PITR and restore exercises remain deployment responsibilities and are not claimed by local Compose.

## Known risks and retained incomplete work

- M06 is a mutation foundation, not the simulation engine. There is no deterministic clock/scheduler/tick process, economy, market, governance, patch pipeline, realtime transport, WebGL/media client or AI runtime authority.
- The first generic command transaction emits one event. M07 simulation will need bounded multi-event command support and generalized history metadata without weakening one-revision-per-command, terminal cardinality or replay invariants.
- Process-local HTTP throttling is privacy-preserving but not a horizontally shared edge limiter. Database idempotency, locks and constraints bound correctness, not abusive request volume across replicas.
- Hash evidence and local verification do not replace immutable external checkpoints or privileged-operator controls. A database owner can rewrite both data and local hashes; deployment must preserve independent evidence.
- Dead-letter redelivery/replacement and projection repair are intentional reviewed operator procedures, not automatic self-healing. An accepted command remains authoritative while derived history is delayed.
- The shared application role, forward-only recovery, broad development-tool runtime image and all previously retained dependency/license/BFF/provider/profile/managed-hosting risks remain until explicitly closed.
- The non-failing concurrent `pg@8` warning above remains cleanup debt.

## Inputs exported to Milestone 07

**Authorized.** M07 inherits API v1; contract/runtime 6; command/event/ledger/projection/outbox/history 1; Manifest/primitive 1; compiler `1.0.0` and compiler config/artifact/WorldGraph/wake 1; sealed migration head `0007_command_event_ledger` with SHA-256 `4ab7ec51af8d137b219f7796e2b41c97b5e49979dea47613cf4323f0d3b3781f`; unchanged golden artifact SHA-256 `4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`; honest imported/compiled genesis; per-world serialized command gate; immutable event/ledger heads and hashes; live/checkpoint checksum parity; minimal outbox and rebuildable history; deterministic graph replay/shadow/compare; owner-only evidence-appending repair; ADR 0011; the final evidence above; and every retained M01–M06 risk.

M07 must append after `0007`, preserve prior event bytes and compiler identity unless independently versioned, keep PostgreSQL as authority and Redis as wake-only, extend the closed registries with explicit clock/schedule/process event contracts, and generalize the command transaction for a bounded multi-event decision without allowing arbitrary JSON mutation or multiple world-revision increments per accepted command.
