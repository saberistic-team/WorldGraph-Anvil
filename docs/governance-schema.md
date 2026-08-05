# Governance schema and runtime boundary

Milestone 10 adds schema-1 governance to WorldGraph. PostgreSQL remains authoritative; browser state, Redis delivery, wall time, natural-language text, and AI output are not authority.

## Version and compiler state

| Axis                                           | Milestone 10 value                         |
| ---------------------------------------------- | ------------------------------------------ |
| API                                            | `v1`                                       |
| Contract/runtime                               | `10` / `10`                                |
| Compiler                                       | `1.3.0` native; exact older lanes retained |
| Compiled artifact                              | `4` native                                 |
| Governance seed plan                           | `1`                                        |
| Governance schema                              | `1`                                        |
| Governance policy DSL                          | `1`                                        |
| Governance tally algorithms                    | `1`                                        |
| Simulation process registry                    | `3`                                        |
| Command/event/ledger/projection/outbox/history | `1`, unchanged                             |

Compiler `1.3.0` extends the approved manifest with a bounded governance configuration and emits one canonical governance seed plan. Activation stores that plan atomically with the artifact, economy plan, graph, and runtime heads. `InitializeWorldGovernanceV1` materializes it explicitly. `AdoptGovernanceSeedPlanV1` is the explicit legacy-world path and requires exact artifact/plan hashes and a reason; migration never silently invents governance intent.

## Owned records

The governance module owns these groups:

- world/charter: `compiled_governance_seed_plans`, `world_governance_heads`, `governing_charters`, immutable `governing_charter_versions`, and `charter_authority_intervals`;
- institutions/law: `institutions`, `institution_powers`, `laws`, immutable `law_versions`, effectivity transitions, and authority intervals;
- offices: `political_offices`, seats, powers, immutable `office_terms`, term transitions, and seat authority intervals;
- proposals: `proposals`, typed actions, sponsors, transitions, enactment attempts, and action enactments;
- contests/ballots: governance/proposal/election contests, eligibility snapshots and members, participation, receipts, restricted choice revisions, effective revisions, and public-choice projection;
- results: proposal/election tallies, counts, and certified results;
- audit/recovery: authority decisions and sources, schedule occurrences, explicit overrides/approvals, linked repairs/approvals;
- economy bridge: public-project authorizations, treasury encumbrance facts/projection, governed tax-policy authority intervals, and tax-policy lineage.

Stable identities are separated from immutable versions. Same-world composite foreign keys prevent cross-world references. Exclusion constraints prevent overlapping authority intervals for one law version, office seat, charter, or tax-policy lineage. Immutable facts reject update/delete; lifecycle projections require the open command gate, expected version, and deferred command/event evidence.

## Policy DSL v1

The finite AST supports:

- `actor_mode`;
- `membership_role`;
- `holds_office`;
- exact `action`;
- resource type/key;
- `tick_at_or_after`, `tick_before`, and bounded tick range;
- bounded `all`, `any`, and `not` composition.

The canonical evaluator is shared by pure TypeScript decisions and a least-privilege PostgreSQL function. It is limited to depth 3, 64 total nodes, and 8 operands per composite expression. Missing context, duplicate/ambiguous sources, unknown kinds, invalid shapes, limit overflow, or evaluation error returns deny. The authority decision stored with each command binds action/resource, actor mode and identities, evaluated tick, safe context, exact source versions/effective intervals/checksums, and a decision checksum.

Authority precedence does not convert creator provenance into civic power. In-world actions require the controlled character's current membership/office/law sources. `creator` and `administrator` bypasses exist only through the dedicated override/repair commands and their separate audit evidence. `system` is restricted to scheduler-derived lifecycle commands.

## Contest and ballot model

All windows use authoritative world ticks and half-open intervals. Opening a proposal or election creates one immutable eligibility snapshot from current active membership/role/office policy. The snapshot has a rule checksum, source state revision, eligible count, and member-set checksum. Later membership changes do not rewrite an open contest's eligibility.

`ballot_participation` has one row per contest and voter. Replacement, where enabled, appends a choice revision and moves one effective-revision pointer; it never edits an earlier choice. Database functions lock the contest and participation identities, recheck the exact open window and snapshot membership, and return a stable receipt. Duplicate first ballots race through the unique participation boundary, so one succeeds and the rest receive a stable conflict without blocking unrelated voters.

Public contests may publish voter identity, choice, both, or aggregate-only data according to the exact charter disclosure mode. Secret contests store the choice revision behind the restricted tally role and retain only safe participation/receipt state in ordinary projections. Ordinary API reads return the caller's receipt and configured public detail; they never join a secret voter to a choice.

## Tally and certification

The worker discovers completed governance schedules from PostgreSQL and derives one system command from the immutable action, target, due tick, completed event, and occurrence key. It computes eligibility using the SQL policy evaluator. Secret ballot rows are loaded through the dedicated tally role; choice material is reduced to deterministic bounded inputs and is not logged or attached to telemetry.

Proposal tally v1 computes eligible, participating, yes, no, and abstain counts, quorum, threshold, input checksum, and output checksum. Election tally v1 sorts candidate keys canonically, counts abstentions and candidates, applies quorum and the configured vacancy tie rule, and binds the same checksum envelope. Persist functions enforce exact input/output bytes and one immutable tally. Certification inserts one result and is idempotent under repeated schedule delivery.

Election certification starts the winning seat term at the declared transition tick, ends any prior authority interval at that same tick, and creates the new non-overlapping interval. Proposal certification either atomically enacts every typed action or records one safe failed-enactment state with no partial law, tax, project, treasury, or term effect.

## Typed proposal effects

- `create_law`, `amend_law`, and `repeal_law` append immutable law versions and adjust half-open authority intervals. Repeal closes authority and does not create a replacement authority interval.
- `update_tax` calls the governed tax-policy insertion boundary, retains immutable prior/new lineage, applies configured basis-point bounds, and preserves economy policy provenance.
- `authorize_public_project` requires an active treasury wallet, matching active currency, and sufficient spendable balance. It appends an authorization, encumbrance, first immutable fact, and current projection; it does not create currency or spend funds by itself.
- `appoint_officeholder` rechecks the office version and seat, appends a non-overlapping term/authority interval, and advances the office version.
- `approve_world_patch` records bounded approval intent only. Milestone 13 owns patch application.

Effects must begin at the certification tick unless a separately scheduled activation exists. A passed vote cannot make an invalid, stale, unaffordable, cross-world, or unauthorized action valid.

## Commands and transport

Public commands through the existing world command endpoint are:

- initialization/adoption: `InitializeWorldGovernanceV1`, `AdoptGovernanceSeedPlanV1`;
- proposals: `CreateProposalV1`, `SponsorProposalV1`, `WithdrawProposalV1`, `CastProposalBallotV1`;
- elections: `NominateCandidateV1`, `AcceptNominationV1`, `CastElectionBallotV1`;
- offices: `AppointOfficeholderV1`, `RemoveOfficeholderV1`;
- operator: `ExecuteCreatorOverrideV1`, `RepairGovernanceResultV1`.

Worker-only commands are `OpenProposalVotingV1`, `CloseAndTallyProposalV1`, `CertifyAndEnactProposalV1`, `OpenElectionV1`, `CloseAndTallyElectionV1`, and `CertifyElectionV1`. A public request cannot choose the system actor or scheduler provenance.

Authorized reads under `/api/v1/worlds/:id/governance` expose charter, institutions, laws, offices, terms, proposals, caller receipt/result, elections, candidates, caller receipt/result, public audit, and an authorized resumable SSE invalidation stream. Pages are bounded and cursor-versioned. Cross-world or unauthorized targets return non-enumerating responses.

## Events, ledger, history, and schedules

Governance facts use safe schema-1 payloads for initialization/adoption, lifecycle, public/secret ballot recording, candidacy, finalized results, office-term change, explicit override, and linked repair. Secret selections are absent. History is generated only from allowlisted fields and respects public/member/operator visibility.

A governance command may append multiple events while advancing state revision once. The main governance fact and each created `ScheduledActionCreatedV1` receive contiguous world-event sequence and command ordinal, their own ledger fact and outbox reference, and exact aggregate version. The command terminal constraint proves event/ledger/outbox cardinality and runtime/checkpoint heads before commit.

## Override, failure, and repair

The override route is visually separate and requires an exact confirmation, bounded reason and impact, explicit creator/admin mode, immutable override provenance, and optional distinct approval. Only effect types with a real durable implementation are accepted. Its event and ledger entry remain labeled as an override; it cannot impersonate a proposal result.

Safe proposal enactment errors roll back to a savepoint, record `passed_but_enactment_failed`, and retain the immutable result/action checksums. `certification_compensation` recomputes the retry plan from those immutable actions, requires the exact supplied plan checksum, and either atomically enacts or appends another bounded failed attempt. Recount/repair must recompute from immutable ballot/tally inputs and append a linked record; no API updates a certified row.

## Privacy and trusted-server limitation

The ordinary application role cannot select eligibility members, restricted choice revisions, or effective secret-choice linkage. The tally role can read only the minimum contest choice material and has no mutation privilege. Logs/traces use bounded identifiers and checksums where operationally necessary, never selections; metrics contain only allowlisted low-cardinality labels. Events, outbox messages, history, and browser state are choice-free for secret contests.

This design protects against ordinary application/API disclosure and accidental telemetry leakage. It does not protect against a compromised database owner, tally service, application server at vote time, or exposed backup/key material, and it does not provide coercion resistance. Encrypted backups, restricted tally credentials, key rotation, access review, and incident response are deployment requirements.

## Feature controls and operations

Independent flags can pause new contests, voting, enactment, or overrides. Pausing one action class does not let its due schedules starve close/certify work for other enabled classes. Correctness checks, immutable results, policy evaluation, exact tick checks, database privileges, and command/event gates cannot be disabled.

Operational playbooks for stuck contests, failed enactment, vacancy, law replacement, secret-key exposure, and audited repair live in `operations.md`. Security boundaries and ballot limitations live in `security.md`. The architecture decision is ADR 0015.
