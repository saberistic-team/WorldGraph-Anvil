# Deterministic compiler and WorldGraph

Milestone 05 converts one explicitly approved Manifest v1 into the first authoritative WorldGraph design version. Compilation is deliberate, creator-triggered, asynchronous, deterministic, and initial-activation-only. Approval alone never compiles, and a later approved child cannot rewrite an active world.

## Input identity

`CompilerInputBundleV1` contains:

- the approved manifest, its canonical JSON bytes, SHA-256 hash, and schema version;
- every exact primitive version in the manifest dependency closure, including canonical semantic bytes, content hash, lifecycle, and immutable version ID;
- sorted world-local member principal keys and roles, without user IDs or contact/session data;
- compiler `1.2.0`, compiler configuration schema `1`, the integer bounds and adapter registry version, and an explicit seed. Compiler `1.1.0` and `1.0.0` input/artifact identities remain supported only through their exact named verifier paths.

`inputHash` is SHA-256 over canonical JSON of every semantic input other than `inputHash` itself. Both API start and worker execution independently reconstruct the bundle from PostgreSQL. A mismatch fails closed before seeding. Exact primitive content, not a mutable catalog alias or latest version, is authoritative.

## Pure stages and adapters

The compiler performs these immutable stages:

1. `resolve`: validate bundle shape/hash identities, resolve the exact dependency closure in deterministic topological order, and select code-owned adapters.
2. `validate`: reject deprecated policy violations, incompatible references, unsafe non-integer numbers, invalid parameters, private field names/string values, and configured size/depth bounds.
3. `normalize`: establish canonical code-point ordering and normalized explicit defaults.
4. `lower`: create stable logical entities, relationships, controller intents, economy/simulation configuration intent, a deterministic declarative visual plan, and one exact closed-loop economy seed plan. Compiler `1.2.0` additionally lowers validated resource, recipe, initial-inventory, business, facility, employment, tax, treasury, and periodic-schedule intent.
5. `link`: enforce unique logical keys, existing endpoints, and the relationship endpoint-type matrix.
6. `emit`: canonicalize the compiled world, calculate its SHA-256 artifact hash, and return ordered diagnostics.

Adapters are allowlisted by primitive kind and behavior reference in source code. Primitive data is never evaluated, imported, fetched, or treated as a script. Pure-module architecture tests forbid infrastructure dependencies, `fetch`, environment access, wall time, and ambient randomness.

The seeded PRNG derives a 32-bit state from SHA-256 of the explicit seed and uses documented XorShift32 integer operations. Stable logical keys and code-point comparison avoid locale dependence. All coordinates, rotations, capacities, and other compiler arithmetic are integers. Semantic output contains no physical IDs, timestamps, run IDs, object iteration order, user IDs, email/session/invitation data, prompt text, provider output, secrets, IP data, or remote content.

## Artifact and version policy

The current primary `compiled_world` artifact contains `CompiledWorldV3`, canonical bytes, input hash, content hash, exact `EconomySeedPlanV2`, and its domain-separated hash. Artifact schema is `3`; WorldGraph/entity/relationship schema remains `1`. The plan retains closed-loop currency, wallet, and founding-title intent and adds exact resources, immutable recipes, initial inventories, businesses/facilities, employment offers, tax policies, treasury bindings, and bounded periodic schedules. The database also retains bounded `compiler_input` and `visual_plan` artifacts for exact provenance. Entity states and relationship attributes are strict type-discriminated schema-1 unions, not generic JSON bags. After schema validation, the shared verifier checks exact entity/relationship/controller counts and completeness, canonical/unique keys, endpoint types, same-principal controller/character/`account_controls` correspondence, bounded privacy rules, seed-plan stable-key/controller/entity closure, amount/supply/distribution/cap arithmetic, resource scale, recipe/facility references, business authority, periodic payer/wallet linkage, schedule bounds, and exact plan hash. Recomputing an outer hash therefore cannot certify a semantically incomplete, corrupt, private, or mismatched artifact.

A release must not change canonical output for the same compiler/config versions. The sealed compiler `1.0.0`/artifact-1 fixture remains byte-identical at input hash `47710bce54a581f601e76d3b246b644153d9a33a4658947ef2445823e299d639`, artifact hash `4ef1761d87fdeb868a79e457333942bb18d0ed3fab26035dab9676f54d6e529d`, 35 entities, 40 relationships, one controller, and 23,249 compiled-world UTF-8 bytes. Its exact `CompiledWorldV1`/`CompiledArtifactV1` verifier remains published. Compiler `1.1.0` retains the sealed M08 artifact-2/plan-1 golden recorded in the M08 state. Compiler `1.2.0` has a separate artifact-3/plan-2 harbor-city golden: manifest `6452e612ab13f43c9513824fa36dfca6a28303909e0215da1c787cd63d1edc6c`, input `0cf5b43c2a0b09d75aae17b5dd622113e27103843392e17a2a8b64833eb4e837`, artifact `fa53687f451201d80cc4cab4615eed98403341cfd55177158add05579ab22f92`, plan `eff8f07bac7bc63354bd43e0f7607427aece39429cecfe2de3edd70eea6eb6d9`, 34,753 bytes, 41 entities, 46 relationships, and two controllers. The local golden gate verifies these bytes; M09 release acceptance remains pending because its database/browser/Compose gates are environment-blocked. Any later intentional output change requires another compiler/config/artifact version decision, ADR/changelog entry, and reviewed golden update.

Artifact dispatch is explicit on the supported compiler/artifact pair. Compiler `1.2.0` must pair with artifact 3 and native hashed plan 2; compiler `1.1.0` must pair with artifact 2 and native hashed plan 1. Compiler `1.0.0` must pair with artifact 1 and has no native plan. It may produce only a deterministic, reviewable legacy M08 plan candidate through `LegacyEconomySeedAdapterV1@1.0.0`; the active creator must adopt that exact candidate before M08 initialization. That adapter does not manufacture M09 productive-commerce intent. Missing/ambiguous governance/controller identity fails closed, and no migration rewrites old artifact bytes or invents value, title, business, resource, inventory, employment, market, or tax state.

## Atomic activation and ownership

`world_compilation_runs` is the durable job ledger. A wake is only coordination. The worker claims a queued run, reloads exact authoritative input, advances validating/compiling/seeding stages with row-version/claim checks, and verifies the emitted artifact before persistence.

Activation uses `SERIALIZABLE`. Its first database statement takes direct `SHARE` table locks on membership and primitive source tables, before PostgreSQL assigns the serializable snapshot; PostgreSQL 17's narrow `MAINTAIN` privilege permits this without granting broader row mutation. It then takes the per-world advisory lock and re-reads the exact active membership roles/principals and primitive IDs/lifecycles/content hashes. One transaction writes artifacts, a staging `world_versions` row, physical entity/relationship rows, controller bindings, exact native compiled-economy plan provenance for artifact 2 or 3, and `world_runtime_heads`; it then marks the version active, advances `worlds.active_world_version_id`, changes lifecycle to `active`, and completes the run. Composite same-world foreign keys, logical-key uniqueness, endpoint-type triggers, controller/edge bijection, compiler/artifact/plan pairing, one-active partial indexes, and deferred pointer checks make partial or cross-tenant activation invalid. Serialization failures retry within a bound. Other failures roll back seed data and transition the run to sanitized failure outside that transaction. Activation persists intent but does not initialize balances/title or productive commerce; those remain separate explicit M08 and M09 commands.

The relational graph is authoritative. `world_versions` is immutable design identity; `world_runtime_heads.state_revision` and `last_ledger_sequence` reserve separate mutable runtime ordering for the next milestone. Initial graph rows remain immutable in M05. The successful activation transaction requires exact graph/controller coverage for active playable memberships at that snapshot and excludes observers. Later membership changes deliberately do not synthesize or retire graph actors/controllers; M06 owns the first event-governed mutation boundary.

## API and UI boundary

Creator mutations require session authentication, exact Origin/CSRF, a bounded `Idempotency-Key`, current manifest revision/hash, and expected run row version where relevant:

- `POST /api/v1/worlds/:id/compilations`
- `POST /api/v1/worlds/:id/compilations/:runId/cancel`
- `POST /api/v1/worlds/:id/compilations/:runId/retry`

All active members may read the scoped status, diagnostics, verified artifact, runtime summary, entities, relationships, and one-hop neighbors. Lists use HMAC-signed cursors bound to world and normalized filters, allowlisted entity/relationship types, and a maximum page size of 100. There is no recursive graph endpoint.

Manifest Studio presents creator eligibility, exact input identity/seed confirmation, durable polling, cancellation only before seeding, and safe retry diagnostics. World Overview exposes design/runtime identity and counts. WorldGraph Explorer provides accessible searchable tables, inbound/outbound neighbor inspection, provenance links, keyboard focus, responsive states, reduced-motion-compatible presentation, and no WebGL dependency.

## Offline reproducibility

After building `@worldgraph/compiler`:

```sh
worldgraph compile --manifest manifest.json --catalog catalog.json --members members.json --seed demo-seed --output first
worldgraph compile --manifest manifest.json --catalog catalog.json --members members.json --seed demo-seed --output second
cmp first/compiled-world.json second/compiled-world.json
worldgraph verify-artifact --artifact first/compiled-artifact.json
```

The catalog file must contain `{ "primitives": [...] }` with exact primitive source records. Member input contains pseudonymous principals and roles, not user records. The built binary bundles its complete required runtime closure and runs directly under plain Node. The CLI reads bounded local JSON only, writes no runtime tables, emits nonzero on compiler diagnostics or verification mismatch, and never calls a model or network service. `pnpm compiler:cli-check` builds on the aggregate production build, launches two separate compile processes plus a verification process, and byte-compares all outputs against the reviewed golden identity.

## Recovery runbook

- **Backlog or lost Redis wake:** restore Redis/worker readiness and let PostgreSQL reconciliation claim queued rows. Do not insert a replacement run.
- **Expired worker claim:** reconciliation marks the stale claim failed with a retryable diagnostic. A creator may use the normal retry command while attempts remain; never reuse an old claim token.
- **Retryable failure:** correct an infrastructure cause without changing semantic input, then use the authenticated retry command with current row version. Retry retains the same deterministic run identity and rechecks the entire input. If a manifest, primitive or membership changed, retain the old failed run and create/approve/start the appropriate new exact input; never relabel the old run.
- **Hash mismatch:** stop activation, compare approved manifest bytes/hash and every exact primitive semantic hash, and treat unexpected mutation as an integrity incident. Do not recompute stored hashes to conceal a mismatch.
- **Orphan/staging suspicion:** disable new compilation, run an owner-reviewed query for nonterminal staging versions/artifacts/graph rows and pointer consistency, retain evidence, and apply only a reviewed forward repair. Never delete an active graph or disable constraints casually.
- **Active-pointer inconsistency:** stop writers; verify successful run, active version, runtime head, world identity, and artifact provenance under an owner transaction. Restore a consistent pointer through audited forward repair or PITR.
- **Compiler rollback:** disable new starts with `COMPILER_ENABLED=false`. Existing active worlds remain readable. A prior binary may process only rows matching its exact compiler/config version; do not silently reinterpret a queued input.
- **Migration failure:** keep incompatible API/worker versions stopped, preserve applied migration history, restore/PITR or append a reviewed forward migration. Never edit `0006` after release.

Telemetry may include run/world correlation IDs, versions/hashes, counts, stage duration, and stable diagnostic codes in logs/traces. Metrics labels stay low-cardinality and never include IDs, hashes, manifest/entity content, prompts, or private identity data. Claim latency, each pure stage, and the atomic `seed_activate` transaction are timed separately; the repository reports measured lock wait and successful serializable retries. Versioned rules in `deploy/alerts/deterministic-compiler-v1.rules.yml` alert on old backlog, failures/unsupported adapters, long locks/retries, large artifacts, hash/self-verification failures, and observed activation/orphan inconsistency. M05 ships rules rather than a deployed dashboard or paging route, and it does not pretend to run a continuous privileged orphan scanner.
