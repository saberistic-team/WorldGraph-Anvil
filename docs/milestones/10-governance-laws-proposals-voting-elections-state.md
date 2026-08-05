# Milestone 10 — Governance, laws, proposals, voting, and elections

Status: **complete and sealed on August 5, 2026 EDT**. The implementation, migration, regression, exact-upgrade, three-session browser, clean/retained Compose recovery, and supply-chain gates recorded below passed. This record authorizes Milestone 11 with the cumulative compatibility state, architecture decisions, and retained risks below as mandatory inputs.

## Inputs consumed

- The complete sealed M01–M09 state records and handoffs, including API v1; PostgreSQL authority; Redis wake-only coordination; identity/membership/controller authority; immutable primitives/manifests; deterministic compiler/activation; command/event/ledger/replay; deterministic ticks/schedules/fencing; closed-loop wallets/title; productive commerce/tax/treasury; and every retained security, deployment, recovery, and supply-chain risk.
- M09 compatibility: contract/runtime 9; compiler `1.2.0`/artifact 3/economy plan 2 with exact `1.1.0`/artifact 2/plan 1 and `1.0.0`/artifact 1 lanes; simulation process registry 2; journal head `0012`; ADRs 0001–0014.
- The standalone M10 prompt and acceptance criteria in `docs/planning/roadmap-g-09-16-h-j.md`.

## Outcome and implementation

WorldGraph now has a PostgreSQL-authoritative governance module. A compiled, schema-defined charter creates scoped institutions, laws, offices, seats, election schedules, and bounded civic policy. Eligible controlled characters can propose, sponsor, withdraw, vote, nominate, accept nominations, appoint/remove where authorized, and inspect public governance state. The worker opens, closes/tallies, and certifies contests from deterministic completed schedules. Proposal certification executes typed law, tax, public-project, appointment, or future-patch-approval effects atomically, or records a safe passed-but-unenacted state after rolling every attempted effect back.

Public and secret ballots share eligibility, window, replacement, and unique-participation invariants but have different disclosure storage. Ordinary application reads never join a secret voter to a choice. Certified results, tallies/counts, laws, terms, overrides, and repairs are append-only. A deterministic recount creates a linked result leaf; it cannot update the source. Explicit creator/admin overrides and repairs require bounded reason/impact/confirmation, retain actor mode, and remain visibly distinct from civic outcomes.

The Govern UI provides charter/institution/office views, active and historical laws, typed tax/project proposal creation, sponsorship/withdrawal/ballots/results, election nomination/acceptance/ballots/results, civic appointment/removal, public audit, secret-receipt messaging, and an isolated override/repair surface. It uses authoritative ticks/versions, keyboard-operable semantic fields, live status/error focus, non-color outcomes, responsive layouts, and an authorized resumable governance SSE proxy.

No LLM, natural-language interpreter, browser state, Redis message, wall clock, or client-computed tally becomes governance authority.

## Compatibility and deterministic artifacts

| Axis                                           | M10 value                                                    |
| ---------------------------------------------- | ------------------------------------------------------------ |
| API                                            | `v1`, unchanged                                              |
| Contract/runtime                               | `10` / `10`                                                  |
| Manifest                                       | `1`, with bounded optional `worldgraph.governance` extension |
| Native compiler/artifact                       | `1.3.0` / `4`                                                |
| Retained compiler lanes                        | exact `1.2.0`/3, `1.1.0`/2, `1.0.0`/1                        |
| Economy seed plan                              | `2`, unchanged; compiler-1.3 provenance retained explicitly  |
| Governance seed plan                           | `1`                                                          |
| Governance/policy schema                       | `1` / `1`                                                    |
| Proposal/election tally                        | `proposal_yes_no_v1` / `election_plurality_v1`               |
| Simulation process registry                    | `3`; process/schedule/action/PRNG schemas unchanged at 1     |
| Command/event/ledger/projection/outbox/history | `1`, unchanged                                               |

The native governed Harbor golden is:

- manifest `3f6aa7ff355d2d9e4281bbdc52409809bf9f848274e8949fb5fd7fb314553dfd`;
- compiler input `9816d6bbedd0880e58e4d893dd78af7955b9a442d5986437ede8a2ec264e62f3`;
- artifact `f900d58b08dd07b4a04dc3d35295c9d72243f2124d012a7b890c1e57734429dd`;
- economy plan `69ac34721c356be82eb6693620f6cdadb7ec973d128e732ed99a9ee55cf3ef8b`;
- governance plan `f468a3eb92a853e30a5d708e4e31128c6830f791477e2d82f20efdab9ed3d93a`; and
- 39,935 canonical bytes, 43 entities, 50 relationships, and 3 controllers in the pinned three-playable-member fixture.

The reviewed plurality primitive is `worldgraph.election.council-ballot@1.1.0`, version ID `8822358c-f68c-5b38-9e02-6860976188ef`, content hash `b30fb010b82c935206cb8128bdfd5a4e573e1cec01b2de708e2167f97bdb0bde`. The sealed ranked-choice `1.0.0` primitive and M09 manifest remain unchanged. Production disabled-provider generation now selects the governed Harbor fallback and the complete reviewed 20-version catalog.

## Commands, events, reads, and schedules

Public governance commands are `InitializeWorldGovernanceV1`, `AdoptGovernanceSeedPlanV1`, `CreateProposalV1`, `SponsorProposalV1`, `WithdrawProposalV1`, `CastProposalBallotV1`, `NominateCandidateV1`, `AcceptNominationV1`, `CastElectionBallotV1`, `AppointOfficeholderV1`, `RemoveOfficeholderV1`, `ExecuteCreatorOverrideV1`, and `RepairGovernanceResultV1`.

Worker-only commands are `OpenProposalVotingV1`, `CloseAndTallyProposalV1`, `CertifyAndEnactProposalV1`, `OpenElectionV1`, `CloseAndTallyElectionV1`, and `CertifyElectionV1`. The process registry recognizes exactly those six governance action classes and the worker can pause opening, voting, enactment, or overrides independently without letting a disabled class starve enabled close/certify recovery.

Schema-1 safe facts include governance initialization/adoption, lifecycle/candidacy changes, public/secret ballot recording, finalized results, law activation, office-term changes, explicit override, and linked repair. Secret selections are absent from events, ledger payloads, history, outbox, logs, traces, metrics, and browser state. A governance command may emit up to 64 contiguous events while advancing one state revision; every scheduled action has its own exact `ScheduledActionCreatedV1`, ledger fact, outbox reference, and history row.

Authorized cursor-bounded reads under `/api/v1/worlds/:id/governance` expose charter, institutions, laws, offices, terms, proposals, caller receipts/results, elections/candidates/results, public audit, caller capabilities, and resumable SSE invalidations. Cross-world/nonmember access fails without enumeration.

## Database and migration state

Journal head is **`0014_governance_read_capabilities`**, index 13, SHA-256 **`c589912323b150085a1f2b4f9dcdba55b16921c56525c73278e3f312a9eaa99b`**. Migration `0013_governance_laws_elections` remains at SHA-256 **`de9e3476f807c18301d4bcab05210e849129b9fd6ee2f225de7a500fce88fd46`**. Migrations `0001`–`0012` retain their sealed identities.

`0013` adds 59 governance tables across compiled plans/heads; charters; institutions/powers; laws/versions/transitions/authority intervals; offices/seats/powers/terms; proposals/actions/sponsors/transitions/enactments; elections/contests/candidacies; eligibility snapshots; separated ballots; immutable tally/count/result facts; authority decisions; schedule occurrences; overrides/repairs/approvals; and narrow public-project/treasury/tax bridges. Same-world keys, half-open exclusion ranges, one-election-per-seat, effective-ballot uniqueness, append-only triggers, command write gates, and deferred terminal proofs enforce invariants.

`0014` is an additive hardening migration that leaves compatibility axes unchanged. It installs one exact-signature, pinned-search-path, `PUBLIC`-revoked capability function so authorized callers can discover bounded allow/deny decisions without receiving restricted eligibility or secret-ballot reads. The ordinary application role receives only `EXECUTE` on that function.

An exact populated `0012` upgrade advances compatibility and adds empty structures only. It never infers a government for an existing world. Native initialization requires the exact compiler-1.3/artifact-4/governance-plan-1 provenance; legacy adoption is an explicit, reasoned command.

The ordinary app role cannot read eligibility members, restricted choice revisions, effective secret linkage, or direct aggregate heads. The restricted tally role reads only minimum choice material and cannot mutate it. Exact-signature, pinned-search-path, `PUBLIC`-revoked `SECURITY DEFINER` functions provide ballot casting, stream seeding, tally persistence, aggregate-only proposal/election recount, wallet spendability, governed tax insertion, and capability discovery without widening raw grants.

## Architecture decisions and deviations

- ADR 0015 accepts a finite versioned policy DSL, explicit actor modes, tick-bound frozen eligibility, separated secret ballot storage, deterministic tally/certification, typed transaction-scoped enactment, and append-only correction.
- DSL v1 is limited to actor mode, membership role, office holding, exact action/resource predicates, tick predicates, and bounded `all`/`any`/`not` at depth 3, 64 nodes, and 8 operands. Unknown, malformed, repeated, ambiguous, or failed evaluation denies.
- One election models one office seat. This keeps tally, tie/vacancy, certification, and term authority unambiguous; multiple seats use independent contests.
- Proposal certification revalidates every target/economy constraint at commit. Passing a ballot cannot legalize stale, cross-world, out-of-bounds, or unaffordable effects.
- Repeal closes an existing half-open authority interval and does not create a synthetic replacement policy. Election certification starts authority at the declared transition tick and closes any prior term at that exact tick.
- The override proposal-action union is deliberately narrower than ordinary proposal effects: only durable create/amend/repeal-law effects are exposed there; office override uses its own appoint/remove variants. Unsupported override/repair kinds fail closed and are not advertised.
- Recount is an app-invocable aggregate-only security-definer boundary because the API executor deliberately has no restricted tally pool. It validates the open repair command and immutable source/ballot/snapshot/checksum state internally and never grants secret-table reads.
- This is trusted-server ballot privacy, not coercion resistance or a publicly verifiable cryptographic election protocol.

## Operations, observability, and security

Independent configuration controls new contests, voting, enactment, overrides, two-person control, and bounded contest/sponsor/vote/nomination rates. The worker requires a separate `GOVERNANCE_TALLY_DATABASE_URL` when governance scheduling is enabled and fails readiness if that dependency or role boundary is invalid.

Low-cardinality telemetry covers commands, authority denials, ballot rejections, scheduler lag, tally duration/checksum mismatch, failed enactment, overrides, repairs, pending work, and sweep/command outcomes. Failed enactment increments exactly once for a new commit and never on idempotent replay. The checked-in governance dashboard and alert rules cover stuck contests, mismatches, transition/enactment failure, restricted access, overrides, rejection bursts, and projection/outbox lag; environment loading/routing/tuning remains deployment work.

Runbooks cover stuck contests, deterministic recount, passed-but-unenacted compensation, vacancy/transition failure, forward law replacement, secret credential/key/backup exposure, and explicit override/repair response. Security documentation states ordinary-role and trusted-server limitations.

## Verification evidence

Final acceptance ran through August 5, 2026 EDT with Node.js 24.18 and pnpm 11.9 on the sealed tree (commit `fdd93f8` plus the seal-documentation update). Every result below comes from commands actually completed on that tree.

| Check                                             | Sealed result                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregate repository gate                         | **PASS.** `pnpm check` completed format, lint, 18 package typechecks/builds, migration journal validation at head `0014`, four-lane goldens, standalone compiler CLI, and **138** unit files / **984** tests.                                                                                                                                                                                                                                                                 |
| Real PostgreSQL/Redis integration                 | **PASS.** The full suite completed **28** files / **252** tests, including governance schema/security, ballot concurrency, schedule repository, command executor, economic enactment, and concurrency races.                                                                                                                                                                                                                                                                  |
| Exact-`0012` M10 upgrade origin                   | **PASS.** `pnpm test:m10-upgrade` completed **2** files / **2** tests (command executor + economic enactment) with `WORLDGRAPH_M10_DATABASE_ORIGIN=upgrade`. Retained M09 upgrade-origin gate also passed **1** file / **12** tests.                                                                                                                                                                                                                                         |
| Browser/accessibility                             | **PASS.** Playwright completed **92/92** desktop/mobile cases, including the five governance specs for three-session public/secret/denied ballots, mixed-snapshot pause, keyboard election path, override/repair distinctness, and ambiguous frozen retry, plus axe coverage.                                                                                                                                                                                                |
| Clean plus retained-data Compose browser/recovery | **PASS.** Production-shaped images completed the full Compose browser journey first from clean volumes and then against retained data, with `COMPOSE_SMOKE_BROWSER=true`. Both runs exercised three-account governance plus commerce, Redis and PostgreSQL loss/recovery, and returned the same API and worker processes to healthy readiness.                                                                                                                              |
| Migration journal/checksum                        | **PASS.** Head `0014`, index 13, with `0013` `de9e3476f807c18301d4bcab05210e849129b9fd6ee2f225de7a500fce88fd46` and `0014` `c589912323b150085a1f2b4f9dcdba55b16921c56525c73278e3f312a9eaa99b`.                                                                                                                                                                                                                                                                                  |
| Dependency and license review                     | **PASS with retained development-only advisories.** After pinning patched transitive overrides (`fast-uri`, `undici`, `brace-expansion`, `postcss`), `pnpm audit --audit-level high` and `pnpm audit --prod` both found zero advisories. The complete graph retains development-only esbuild advisories: one moderate via drizzle-kit/`esbuild@0.18.20` and one low via tsup/`esbuild@0.27.7`. Production license inventory found **7** groups across **183** package rows, no missing license, and no GPL-3.0/AGPL-3.0; LGPL and CC obligations remain. |
| Image review                                      | **PASS for the reviewed local properties, without a container-CVE-scanner claim.** API, worker, and web run as non-root `node` UID/GID 1000 (`/app` for api/worker; `/app/apps/web` for web). Local images reported 8/8/8 rootfs layers for api/worker/web and 9 for migrate. Base and CI image references remain mutable tags, so this is neither immutable digest pinning nor a CVE scan.                                                                                                                                                |

Only commands actually completed on the final tree may replace pending entries. A planned or still-running gate is not evidence.

## Known risks and retained incomplete work

- Secret ballots trust the application server at cast time, the restricted tally service, database owners, keys, and backup handling. They do not prevent coercion or privileged compromise.
- Deployment-specific alert loading, metric translation, receiver routing/tuning, restricted credential rotation, encrypted backup/PITR, and a managed restore drill remain environment responsibilities.
- The inherited operator-replay finalizer can leave inert pending/running evidence after database loss; it cannot authorize or create a shadow effect, but automatic terminalization remains deferred.
- The browser realtime path is authorized SSE invalidation rather than a general multiplayer WebSocket transport; richer multiplayer presence/chat arrives in M12.
- Mutable base/CI tags, broad runtime dependency trees, external immutable checkpoints, continuous privileged scans, and the retained development-only esbuild advisories remain release risks.
- Governance intentionally supports a small policy/action/tally vocabulary, one-seat plurality contests, and trusted-server secrecy—not arbitrary law, parliamentary procedure, courts, ranked-choice/STV, campaign finance, or AI politicians.

## Inputs for Milestone 11

**Authorized.** M11 must consume this record and handoff plus API v1; contract/runtime 10; compiler `1.3.0`/artifact 4/governance plan 1/economy plan 2 and all exact retained compiler lanes; governance/policy schemas 1; process registry 3; migration head `0014` and every exact checksum; ADR 0015; the authoritative tick/command/event/ledger/economy/governance boundaries; all final verification evidence; and every retained risk. Geography/visual/WebGL work may project stable entities and visual-plan data but cannot move authority, physics, simulation, governance, economy, or visibility decisions into the client.
