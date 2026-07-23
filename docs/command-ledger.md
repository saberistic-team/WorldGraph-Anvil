# Authoritative commands, ledger, history, and replay

Milestone 06 adds the active-world mutation foundation used by every later runtime domain. PostgreSQL remains authoritative; the ledger records ordered facts and tamper evidence while relational tables remain the current query projection.

## Compatibility

| Axis                  |                  Version |
| --------------------- | -----------------------: |
| API                   |                     `v1` |
| Contracts/runtime     |                      `8` |
| Authoritative command |                      `1` |
| Domain event          |                      `1` |
| Ledger                |                      `1` |
| Projection            |                      `1` |
| Outbox                |                      `1` |
| History               |                      `1` |
| Compiler / WorldGraph |    `1.1.0` / `1` current |
| Compiled artifact     | `2` current / `1` legacy |
| Economy/title schemas |                      `1` |

These axes evolve independently. An event version is immutable after publication. A registry may upcast one known payload version at a time into the current in-memory shape; it never rewrites stored bytes or skips an unknown link.

## Command lifecycle

The fixed order is:

1. Authenticate the session; the client cannot choose actor type or override metadata.
2. Parse the bounded public envelope and hash its canonical request/payload.
3. Check command ID and actor/type/idempotency identity. An exact terminal duplicate returns the exact prior result; different reuse is `IDEMPOTENCY_KEY_REUSED`.
4. Acquire the per-world advisory lock before the serializable snapshot, open the owner-defined database write gate, capture the pre-command revision/sequences/checksum, lock the anchored ledger/runtime head, load membership, and authorize the registered action.
5. Compare expected design version, whole-world state revision, and aggregate/entity version.
6. Run a pure registered decision. `RenameWorldEntityV1` permits only explicit name-bearing entity types and rejects invalid/private-looking names.
7. In one serializable transaction append the terminal command, event, ledger entries, projection update, projection checkpoint, runtime/head advancement, and minimal outbox reference. Security-definer triggers alone allocate heads; a deferred constraint proves exact row cardinality, contiguous positions, outbox linkage, and live checksum before commit.
8. After commit, the outbox worker derives a redacted history row and writes its unique consumer receipt. Failure retries with a fenced lease; a terminal dead letter does not reverse authority.

One accepted mutating command advances `stateRevision` once. A rejection for an anchored world appends a redacted `command_rejected` ledger entry, returns a stable result, and creates no event or projection mutation. Unknown/unanchored worlds fail closed because there is no truthful anchor against which to append.

Preserved world, membership, invitation, override, and manifest mutation routes enter a commands-owned compatibility adapter inside their existing idempotent serializable transaction. The adapter uses a closed action/event registry and the same immutable store, hashing, gate, state revision, outbox, and history contracts. It preserves each legacy HTTP response rather than pretending those routes returned the generic command result. Visible anchored-world denials are durable; unknown worlds and unresolved invitation tokens remain non-enumerating and do not fabricate a world-scoped rejection.

## Public vertical slice

`POST /api/v1/worlds/:worldId/commands` accepts only the bounded transport fields:

```json
{
  "commandId": "UUID",
  "type": "RenameWorldEntityV1",
  "schemaVersion": 1,
  "payload": { "entityKey": "district:harbor", "newDisplayName": "Harbor Ward" },
  "expectedWorldVersion": "1",
  "expectedStateRevision": "1",
  "expectedAggregateVersion": "1",
  "idempotencyKey": "rename-harbor-001"
}
```

An accepted result contains its event and ledger ranges plus resulting revision. A rejected result contains no event IDs, the current revision, and a stable rejection code. HTTP conflict/validation/authorization status does not erase the typed recorded result. `GET /api/v1/commands/:commandId` lets a scoped actor resolve an uncertain network outcome before retrying.

`GET /api/v1/worlds/:id/runtime-head` exposes design/state and ledger/event/checkpoint identities. History list/detail routes use signed world-and-filter-bound cursors, apply visibility before ordering/limit, and return only allowlisted summaries. Raw command or event payloads are not returned.

## Genesis and migration

Migration `0007_command_event_ledger` is the forward-only head. During an exact M05 upgrade, every actually active graph is locked and anchored once with `WorldStateImportedV1`; its checksum and real artifact/counts are recorded. Repeating the migration creates no second anchor. Active-world writes are blocked until `ledger_anchored_at` and its artifact identity exist.

New compiler activation calls `worldgraph_append_compiled_genesis(...)` inside the same activation transaction after graph/runtime seeding and before publication. It appends `WorldCompiledGenesisV1`, initial ledger/checkpoint/outbox/history state, and revision 1. A failure rolls back both graph and genesis.

## History privacy

History is a rebuildable projection, not an authority table. Templates are keyed by known event type and accept only allowlisted summary fields. Visibility is `public`, `member`, `creator`, `participant`, or `operator`; SQL filters invisible rows before cursor pagination so hidden entries do not create gaps or counts. `participant` is resolved from immutable economy participant rows tied to the history ledger position: active controllers of entities represented by the transaction may read its private detail, while creator status alone does not grant another member's wallet history. Rejected command history is creator-visible and never contains the submitted display name or financial payload. Logs and metrics use stable types/codes and never payload, entity state, private memo/amount, controller/session identity, command/event/world IDs, or hashes as metric labels.

## Verification and replay

Set `OPERATIONS_DATABASE_URL` to the database-owner connection only for audited maintenance. Every privileged command also requires an explicit `--actor <active-platform-admin-uuid>`; the CLI verifies both the connected database role and that server-side identity before reading raw exports or creating replay state. Ordinary verification may use `DATABASE_URL` when it has read access.

```sh
pnpm ledger verify --world <uuid>
pnpm ledger export --world <uuid> --from 1 --to 100 --output ./ledger.json --actor <platform-admin-uuid>
pnpm projection replay --world <uuid> --target shadow --reason "release verification" --actor <platform-admin-uuid>
pnpm projection compare --world <uuid> --run <replay-run-uuid> --actor <platform-admin-uuid>
pnpm projection replay --world <uuid> --projection simulation_runtime --target verify --reason "simulation verification" --actor <platform-admin-uuid>
pnpm projection compare --world <uuid> --projection simulation_runtime --run <replay-run-uuid> --actor <platform-admin-uuid>
```

Export creates a new file with mode `0600`, refuses overwrite, and appends correlated authorization/completion rows to `security_audit_records` containing the explicit operator identity, selected sequence range, counts, and export hash but never the local output path or raw payload. The authorization row is committed before raw rows are loaded, so failed or interrupted attempts remain visible. Export does not append to or otherwise mutate the world ledger. Verification checks canonical event bytes, contiguous event/ledger sequences, event links, previous hashes, entry hashes, ledger/runtime heads, and live projection checksum; failure exits nonzero and identifies the first divergence.

Replay loads the immutable compiled genesis artifact, applies ordered registered events through pure reducers/upcasters, persists isolated shadow entities/relationships/controllers, and records a checksum. Lifecycle events for legacy world/membership/invitation/manifest tables deliberately leave this compiled-graph projection unchanged while remaining ordered facts and history inputs. Replay does not call AI, network, current time, environment, or randomness. Compare recomputes live graph state and never swaps data.

`--projection simulation_runtime` selects the M07 pure clock/schedule/failure reducer. Its `verify` target stores only audited replay-run metadata and the exact ID-free semantic checksum; it does not persist payloads or shadow rows and never changes live state. Compare requires the unchanged source event head, reconstructs the checksum from the immutable compiled seed plus events, compares the exact PostgreSQL simulation document, and reports a payload-free first divergent JSON pointer. Operational batch runs are deliberately excluded. Graph and simulation replay runs are projection-bound: a run cannot be compared as another projection, and the graph repair function rejects a simulation run.

Repair is deliberately separate and owner-only:

```sh
pnpm projection repair-swap \
  --world <uuid> --run <successful-run-uuid> \
  --reason "INCIDENT-123 reviewed projection restoration" \
  --approved-by <platform-admin-uuid> \
  --approved-by <second-platform-admin-uuid> \
  --confirm REPAIR-SWAP \
  --actor <platform-admin-uuid>
```

The database rejects identical/non-admin approvers, changed source heads, incomplete or mismatched shadow identity, an equal (non-divergent) projection, or a non-owner caller. A successful swap appends a repair event/ledger/outbox/operator-history record and advances `R → R+1`; it never changes an existing event.

That swap applies only to `world_graph`. M07 intentionally provides no simulation swap. Simulation restoration requires the separately reviewed procedure in `operations.md`; it must not reuse `ProjectionRepairAnchoredV1` because that fact and reducer have graph-specific checksum semantics.

M08 economy replay/reconciliation treats non-economy facts as ordered no-ops while validating the complete event/hash/command grouping first. It derives balance and supply only from immutable financial transactions/postings and current title only from immutable asset transfers/ownership events. The canonical economy document contains sorted currency supply, wallet balances, and asset owner/version material at one event/state head; it excludes generated command/event/transaction IDs, timestamps, private memo text, participant identities, feature flags, worker timing, and reconciliation-run identity. Comparison is evidence-only. There is no general economy projection swap: restoration is PITR or a new reviewed append-only compensating command with creator plus platform-administrator operational approval.

## Handler guide

A later domain handler must add strict command payload and past-tense event contracts, independent version constants, a registry entry, pure decision/reducer/upcaster coverage, redaction classification/template, atomic repository projection logic, outbox reference handling, replay fixture, and concurrency/security tests. Multi-row handlers must publish and follow one cross-domain lock order; they cannot explicitly lock database-owned ledger/aggregate allocator heads. They must not expose a generic JSON mutation, accept client actor/override metadata, perform external I/O in decision/replay, or write an authoritative projection outside the command transaction.
