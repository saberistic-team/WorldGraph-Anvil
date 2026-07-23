# WorldGraph (Anvil) roadmap index

This directory is the canonical implementation roadmap for the WorldGraph closed-alpha MVP. The roadmap is split only for maintainability; read and execute it as one document in the required **A → J** order.

## Canonical reading order

| Order | Required section                  | Canonical source                                                                                                                                                                |
| ----: | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     A | Executive interpretation          | [roadmap-a-f.md — A. Executive interpretation](./roadmap-a-f.md#a-executive-interpretation)                                                                                     |
|     B | Assumptions and decisions         | [roadmap-a-f.md — B. Assumptions and decisions](./roadmap-a-f.md#b-assumptions-and-decisions)                                                                                   |
|     C | System architecture               | [roadmap-a-f.md — C. System architecture](./roadmap-a-f.md#c-system-architecture)                                                                                               |
|     D | Canonical domain contracts        | [roadmap-a-f.md — D. Canonical domain contracts](./roadmap-a-f.md#d-canonical-domain-contracts)                                                                                 |
|     E | Milestone dependency map          | [roadmap-a-f.md — E. Milestone dependency map](./roadmap-a-f.md#e-milestone-dependency-map)                                                                                     |
|     F | Milestone summary table           | [roadmap-a-f.md — F. Milestone summary table](./roadmap-a-f.md#f-milestone-summary-table)                                                                                       |
|     G | Detailed milestone specifications | [Milestones 1–8](./roadmap-g-01-08.md#g-detailed-milestone-specifications--milestones-18), then [Milestones 9–16](./roadmap-g-09-16-h-j.md#g-detailed-milestone-specifications) |
|     H | Cross-milestone test strategy     | [roadmap-g-09-16-h-j.md — H. Cross-milestone test strategy](./roadmap-g-09-16-h-j.md#h-cross-milestone-test-strategy)                                                           |
|     I | MVP exit criteria                 | [roadmap-g-09-16-h-j.md — I. MVP exit criteria](./roadmap-g-09-16-h-j.md#i-mvp-exit-criteria)                                                                                   |
|     J | Post-MVP roadmap                  | [roadmap-g-09-16-h-j.md — J. Post-MVP roadmap](./roadmap-g-09-16-h-j.md#j-post-mvp-roadmap)                                                                                     |

## Milestone implementation prompts

Use the `Standalone implementation prompt` inside each linked milestone. The milestone specification around it remains normative for acceptance, risk, operations, and handoff requirements.

| Sequence | Milestone specification                                                                                                                                                                                   |
| -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|        1 | [Milestone 1 — Foundation & deployable shell](./roadmap-g-01-08.md#milestone-1--foundation--deployable-shell)                                                                                             |
|        2 | [Milestone 2 — Identity/membership/authority](./roadmap-g-01-08.md#milestone-2--identitymembershipauthority)                                                                                              |
|        3 | [Milestone 3 — Primitive registry/retrieval](./roadmap-g-01-08.md#milestone-3--primitive-registryretrieval)                                                                                               |
|        4 | [Milestone 4 — Manifest studio & walking skeleton](./roadmap-g-01-08.md#milestone-4--manifest-studio--walking-skeleton)                                                                                   |
|        5 | [Milestone 5 — Deterministic compiler/WorldGraph seeding](./roadmap-g-01-08.md#milestone-5--deterministic-compilerworldgraph-seeding)                                                                     |
|        6 | [Milestone 6 — Command/event ledger/history](./roadmap-g-01-08.md#milestone-6--commandevent-ledgerhistory)                                                                                                |
|        7 | [Milestone 7 — Deterministic clock/scheduler](./roadmap-g-01-08.md#milestone-7--deterministic-clockscheduler)                                                                                             |
|        8 | [Milestone 8 — Wallets/transfers/ownership](./roadmap-g-01-08.md#milestone-8--walletstransfersownership)                                                                                                  |
|        9 | [Milestone 9 — Production, Businesses, Jobs, Markets, Treasury, and Tax](./roadmap-g-09-16-h-j.md#milestone-9--production-businesses-jobs-markets-treasury-and-tax)                                       |
|       10 | [Milestone 10 — Governance, Laws, Proposals, Voting, and Elections](./roadmap-g-09-16-h-j.md#milestone-10--governance-laws-proposals-voting-and-elections)                                                |
|       11 | [Milestone 11 — Geography, Visual Plan, and Basic WebGL World](./roadmap-g-09-16-h-j.md#milestone-11--geography-visual-plan-and-basic-webgl-world)                                                        |
|       12 | [Milestone 12 — Multiplayer Presence, Synchronization, Chat, and Shared Interactions](./roadmap-g-09-16-h-j.md#milestone-12--multiplayer-presence-synchronization-chat-and-shared-interactions)           |
|       13 | [Milestone 13 — Natural-Language World Patches, Impact Analysis, Migrations, and Rollback](./roadmap-g-09-16-h-j.md#milestone-13--natural-language-world-patches-impact-analysis-migrations-and-rollback) |
|       14 | [Milestone 14 — Direct World Editor and Operational Lenses](./roadmap-g-09-16-h-j.md#milestone-14--direct-world-editor-and-operational-lenses)                                                            |
|       15 | [Milestone 15 — Bounded AI Actors, Moderation, and Integrity Hardening](./roadmap-g-09-16-h-j.md#milestone-15--bounded-ai-actors-moderation-and-integrity-hardening)                                      |
|       16 | [Milestone 16 — Integrated City-State, Production Readiness, and Closed Alpha](./roadmap-g-09-16-h-j.md#milestone-16--integrated-city-state-production-readiness-and-closed-alpha)                        |

## Strict sequential execution rule

Implement **Milestone 1 through Milestone 16, exactly once and in order, against the same repository and migration history**. Do not begin Milestone `N+1` until Milestone `N` meets its acceptance criteria and definition of done, its migrations have been applied and verified, its relevant previous-milestone regression tests pass, and its implementation handoff has been retained. A standalone prompt supplies context; it does not authorize skipping repository inspection or replacing current repository truth.

If a milestone uncovers a defect in an earlier contract, repair it through an explicit backward-compatible change or versioned migration and record the deviation. Do not silently rewrite prior migrations, fixtures, public schemas, event meanings, authority rules, ledger history, or checksums. Reduce optional scope behind a feature flag when necessary; never weaken authentication, authorization, atomicity, auditability, deterministic behavior, recovery, or required tests.

## Required handoff to the next milestone

Before editing, the implementer of Milestone `N+1` must inspect the repository and the retained Milestone `N` handoff, including:

1. The concise implementation summary, completed demo, and any documented deviation from the roadmap.
2. Architecture decisions and ADRs, current module/data ownership, dependency direction, and newly frozen invariants.
3. Files and packages added or changed, plus public schemas, API, command, event, realtime, patch, compiler, and client protocol versions.
4. Database migrations in order, the actual applied migration state, extension/seed/backfill/checkpoint status, and the verified clean-install, upgrade, restore, rollback, or forward-recovery result.
5. Test suites and fixtures added or changed, golden world/version/checksum changes, every command actually run and its result, and all failures, skips, flakes, or unavailable dependencies.
6. Feature flags, compatibility windows, deployed/runtime versions, observability dashboards and alerts, operational/repair/reconciliation runbooks, and migration or recovery caveats.
7. Remaining defects, security/privacy findings, accepted risks, performance/capacity evidence, incomplete optional work, and explicit release blockers.
8. Current workspace/package configuration, architecture documents, schema and migration files, test configuration, repository status, and all earlier handoffs needed to understand cumulative state.

The new milestone must preserve working behavior, run the affected cumulative test matrix from [Section H](./roadmap-g-09-16-h-j.md#h-cross-milestone-test-strategy), and end with the same handoff categories for its successor. Never report a test, migration, build, deployment, restore, or demo as successful unless it was actually executed and its result retained.
