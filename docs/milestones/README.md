# Milestone state records

Sequential implementation agents must read every prior state record before editing. Each milestone creates one canonical NN-name-state.md record and may provide an MNN-handoff.md compatibility pointer.

Every record must retain: outcome and implementation summary; public contracts and schema versions; database migration files and exact journal head; seed/data migration state; commands actually run with timestamp/runtime/result/counts; architecture decisions and deviations; operational/feature-flag state; security/privacy notes; known risks/incomplete items; and the input records consumed. Never copy a planned test result into the actual-results section and never claim an unrun command passed.

Canonical records:

- [Milestone 01 — Foundation and deployable shell](./01-foundation-state.md) ([compatibility pointer](./M01-handoff.md)) — complete and sealed
- [Milestone 02 — Identity, membership, and authority](./02-identity-authority-state.md) ([compatibility pointer](./M02-handoff.md)) — complete and sealed
- [Milestone 03 — Primitive registry and retrieval](./03-primitive-registry-state.md) ([compatibility pointer](./M03-handoff.md)) — complete and sealed
- [Milestone 04 — Manifest Studio and deterministic generation](./04-manifest-studio-state.md) ([compatibility pointer](./M04-handoff.md)) — complete and sealed
- [Milestone 05 — Deterministic compiler and WorldGraph seeding](./05-deterministic-compiler-state.md) ([compatibility pointer](./M05-handoff.md)) — complete and sealed
- [Milestone 06 — Authoritative command/event ledger, history, and replay](./06-command-event-ledger-state.md) ([compatibility pointer](./M06-handoff.md)) — complete and sealed
- [Milestone 07 — Deterministic clock and scheduler](./07-deterministic-clock-scheduler-state.md) ([compatibility pointer](./M07-handoff.md)) — complete and sealed
- [Milestone 08 — Wallets, transfers, and ownership](./08-wallets-transfers-ownership-state.md) ([compatibility pointer](./M08-handoff.md)) — complete and sealed
- [Milestone 09 — Production, businesses, jobs, markets, treasury, and tax](./09-production-businesses-jobs-markets-tax-state.md) ([compatibility handoff](./M09-handoff.md)) — complete and sealed
- [Milestone 10 — Governance, laws, proposals, voting, and elections](./10-governance-laws-proposals-voting-elections-state.md) ([compatibility handoff](./M10-handoff.md)) — complete and sealed
- [Milestone 11 — Geography, Visual Plan, and Basic WebGL World](./11-geography-visual-plan-webgl-state.md) ([compatibility handoff](./M11-handoff.md)) — complete and sealed
- Milestones 12–16 — sequentially locked until each immediately preceding milestone is explicitly sealed. Milestone 12 is authorized by the sealed M11 handoff.

Do not begin a later milestone while the immediately preceding canonical record is marked incomplete or awaiting acceptance evidence.
