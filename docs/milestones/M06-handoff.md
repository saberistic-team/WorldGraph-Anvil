# Milestone 06 handoff pointer

The canonical Milestone 06 record is [06-command-event-ledger-state.md](./06-command-event-ledger-state.md). It carries the full implementation summary, compatibility axes, sealed `0007_command_event_ledger` digest, honest genesis/backfill state, command/event/ledger/projection/outbox/history invariants, replay/operator/repair controls, verification evidence, ADR 0011 decisions, deviations and retained risks.

Milestone 06 is complete and sealed. Milestone 07 is authorized and must consume that exact record, append after migration `0007`, and never edit prior migrations or stored event contracts.
