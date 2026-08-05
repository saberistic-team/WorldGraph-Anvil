# Governance guide

WorldGraph governance is a closed-alpha, server-authoritative civic system. A compiled charter defines institutions, offices, eligibility, proposal rules, ballot disclosure, and scheduled transitions. The application does not interpret legal prose, and neither a browser nor an LLM can count votes, grant authority, move treasury value, or change a law directly.

All ticks in this guide are authoritative world ticks. Displayed UTC time is explanatory only.

## Before participating

Open **Govern** for the world and review:

- **Charter** for citizen eligibility, quorum, approval thresholds, ballot rules, institutions, and office powers.
- **Laws** for current and historical immutable versions and their half-open effective intervals.
- **Offices** for seats, current terms, election rules, and vacancies.
- **Audit** for ordinary civic outcomes and separately labeled creator/administrator actions.

An active membership is necessary but may not be sufficient. Civic commands are evaluated against the currently controlled player character, active laws, institution and office powers, exact world tick, and current aggregate versions. Creator provenance alone does not silently provide civic authority.

## Authority matrix

This matrix describes the coarse gate. Every permitted civic mutation is then rechecked transactionally against the compiled policy, the controlled character, the exact target, and the authoritative tick. “Deny” is non-enumerating when world visibility has not been established.

| Actor or service                | Governance reads                          | Civic proposals, ballots, nominations, and office actions | Initialize governance | Explicit override                                                                       | Result repair                                                                                   | Scheduled lifecycle                                               | Secret choice access                                                |
| ------------------------------- | ----------------------------------------- | --------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Non-member or inactive member   | Deny                                      | Deny                                                      | Deny                  | Deny                                                                                    | Deny                                                                                            | Deny                                                              | Deny                                                                |
| Active observer                 | Allow                                     | Deny                                                      | Deny                  | Deny                                                                                    | Deny                                                                                            | Deny                                                              | Deny                                                                |
| Active player                   | Allow                                     | Policy recheck required                                   | Deny                  | Deny                                                                                    | Deny                                                                                            | Deny                                                              | Deny                                                                |
| Active world administrator      | Allow                                     | Policy recheck required                                   | Deny                  | Deny                                                                                    | Deny                                                                                            | Deny                                                              | Deny; may issue a distinct approval only while currently authorized |
| Active creator                  | Allow                                     | Policy recheck through the controlled character           | Allow                 | Allow only through the dedicated confirmed, password-step-up command                    | Allow only through the dedicated confirmed, password-step-up command                            | Deny                                                              | Deny; may issue a distinct approval only while currently authorized |
| Platform administrator          | Only through an established world context | Civic mode still uses the controlled character and policy | Allow                 | Allow only through the dedicated administrator-mode confirmed, password-step-up command | Allow only through the dedicated administrator-mode confirmed, password-step-up command         | Deny                                                              | Deny; may issue a distinct approval only while currently authorized |
| Governance scheduler (`system`) | No user read path                         | Deny                                                      | Deny                  | Deny                                                                                    | Deny                                                                                            | Allow only for the six due, PostgreSQL-derived lifecycle commands | Deny                                                                |
| Restricted tally database role  | Deny ordinary projections                 | Deny                                                      | Deny                  | Deny                                                                                    | Deny command authority; the application can invoke the separate aggregate-only recount boundary | No command authority                                              | Read only the minimum choice material; no mutation privilege        |

When two-person control is enabled, an override or repair additionally needs one unexpired, command-bound approval from a different current creator, world administrator, or platform administrator. Approval issuance alone grants no mutation authority, is single-use, and is invalidated by session revocation, disablement, demotion, or authentication-version change.

The approval is issued before the initiator's password step-up. The initiator freezes the complete command with `approvalId: null` and shares that exact bounded JSON through the approved incident channel. A distinct reviewer verifies the world, actor mode, target and current version, effective tick, effect, confirmation, reason/impact, command and idempotency IDs, then sends the unchanged command plus their own password to `POST /api/v1/auth/governance-approval` from their authenticated session. The reviewer returns only the resulting approval UUID and expiry. The initiator attaches that UUID to the already frozen command—changing no other field—then performs their own password reauthentication and submits before expiry. The operator page exposes the frozen approval-request JSON and attachment control, but never asks for or handles the reviewer's password. Do not approve screenshots, summaries, or a command that will be regenerated later.

## Player and citizen workflow

### Create and support a proposal

1. Select a typed action. Supported schema-1 actions create, amend, or repeal a law; update a bounded tax policy; authorize a treasury-backed public project; make a charter-authorized appointment; or record approval for a future versioned world patch.
2. Review the target version, fiscal effect, sponsorship/debate/voting ticks, quorum, approval threshold, and ballot disclosure mode.
3. Submit once. An uncertain retry must reuse the same command and idempotency identity. A changed request uses a new identity; changing a payload under an old identity is rejected.
4. Sponsor or withdraw only while the charter-defined window permits it.

Passing a vote does not make an invalid action valid. Certification rechecks the exact target, authority, policy bounds, effective tick, treasury/currency state, and spendable amount. The effect commits with its result, event, ledger, history, and outbox evidence, or every attempted effect rolls back and the proposal becomes visibly `passed_but_enactment_failed`.

### Cast a proposal ballot

1. Wait for the scheduled voting-open transition. Eligibility is frozen into an immutable snapshot at that tick.
2. Review whether the ballot is **public** or **secret**, whether replacement is allowed, and what the certified public result will disclose.
3. Confirm the contest and submit the choice. Keep the returned receipt; it proves participation without becoming permission to inspect restricted choice linkage.
4. If replacement is allowed, use the explicit replacement control. Otherwise a second effective ballot is rejected. Reusing the original request returns its original result.

Voting windows are half-open: opening tick is included and closing tick is excluded. Client time cannot extend a window.

### Participate in an election

Nomination, candidate acceptance, voting, tally, and certification are distinct transitions. A candidate must accept the nomination before the configured boundary. At certification, a winning result starts the new term and closes prior seat authority at the exact transition tick in one transaction. A configured tie, no-quorum result, or no-vote contest may legitimately leave a vacancy.

## Ballot disclosure and privacy

Public ballots reveal only the detail configured by the charter. Secret ballots store participation/receipt separately from restricted choice revisions. Ordinary application reads, events, ledger details, history, realtime messages, logs, traces, metrics, and browser state do not expose voter-choice linkage.

This is trusted-server privacy, not end-to-end anonymous or coercion-resistant voting. The tally service, database owners, protected keys, and backup controls remain trusted. Do not promise public cryptographic verifiability, protection from privileged compromise, or national-election suitability.

## Creator workflow

A creator using ordinary civic controls acts through their current player character and the same eligibility/policy rules as another citizen. Initialization is a distinct creator action that materializes the exact compiler-1.3/artifact-4 governance seed plan; it is not a general editing path.

For an emergency action outside civic authority, use the isolated **Override & repair** area. An override requires explicit creator or administrator mode, a bounded reason, a before/after impact statement, the exact confirmation phrase, current target versions, and—when enabled—a fresh approval from a distinct authorized person. The resulting event, ledger entry, history item, and audit row remain permanently labeled as an override.

Submitting is deliberately staged. First choose **Review override** or **Review repair**. Inspect the text-only review of the target, current evidence, effective tick, effect kind, before/after impact, and command ID; editing the form does not silently change that frozen command. If two-person control is enabled, use the displayed exact approval request and attach the returned approval UUID without regenerating the command. Then enter the initiator's current password in the isolated reauthentication form. The password is sent only to the authentication endpoint, and the resulting short-lived proof remains in memory only. If the command response is lost, use **Retry exact command** to resend the frozen command with the same proof; do not edit and reuse it. A changed action requires a new review, approval, and password step-up.

The override vocabulary is deliberately narrow. Law overrides can create, amend, or repeal a versioned law; office overrides use explicit appointment/removal effects. Unsupported effect kinds fail closed.

## Administrator and repair workflow

Do not update a certified result, tally, term, law version, ballot, or audit row. A deterministic recount or supported repair appends a linked immutable result and preserves the source.

Before a repair:

1. Pause the affected certification/enactment path if integrity is uncertain.
2. Verify the exact eligibility snapshot, effective ballot revisions, tally algorithm, input/result checksums, source result, current result leaf, world tick, and current aggregate versions.
3. Record a bounded incident reason and impact. Obtain the configured distinct approval before it expires.
4. Use the exact repair confirmation and source/replacement checksums. Do not export secret linkage into a ticket, spreadsheet, log, or ordinary operator query.

Certification compensation is only for a passed proposal whose enactment rolled back completely. It re-derives the allowed effect from immutable proposal/result/action evidence; it is not an arbitrary effect editor.

After an override or repair, inspect **Audit** and **History**, verify ledger/checkpoint continuity, and run the relevant economy/governance reconciliation at an unchanged head before resuming paused work.

## Conflicts and safe retries

- **Not open / closed:** refresh the authoritative tick and contest state; do not change client time.
- **Opening was delayed past close:** no late eligibility snapshot is created. The proposal is rejected or the election is cancelled with a visible `voting_window_missed` outcome; regular elections continue through a new deterministic successor rather than silently disenfranchising voters in the old contest.
- **Ineligible:** inspect the frozen snapshot and contributing policy sources. Membership changed after opening does not rewrite the snapshot.
- **Already voted:** read the caller receipt. Replace only when the ballot policy permits it.
- **Stale version:** refresh the proposal/election/office/world state and make a new decision. Do not resubmit altered data under the old idempotency identity.
- **Tallying or projection lag:** wait for the durable scheduled transition and use resumable governance invalidations or a bounded refresh. Redis loss cannot erase the action.
- **Passed but enactment failed:** follow the failed-enactment runbook; never apply the law, tax, project, or term with direct SQL.

## Related reference material

- [`governance-schema.md`](./governance-schema.md): schemas, policy DSL, invariants, commands, results, and disclosure model.
- [`api.md`](./api.md): command envelope and authorized governance reads/realtime interface.
- [`compiler-worldgraph.md`](./compiler-worldgraph.md): governed compiler/artifact and seed-plan compatibility.
- [`security.md`](./security.md): threat model, database roles, secret-ballot limitations, and abuse controls.
- [`operations.md`](./operations.md): stuck contests, recount, failed enactment, vacancy, law replacement, key exposure, override, repair, and recovery runbooks.
- [`adr/0015-governance-authority-ballots-and-enactment.md`](./adr/0015-governance-authority-ballots-and-enactment.md): accepted architecture decisions and explicit limits.
