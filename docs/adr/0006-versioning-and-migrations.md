# ADR 0006 — Independent versions and forward migrations

Status: accepted in M01.

API, contract schema, runtime schema, manifest schema, primitive schema, compiler, ruleset, world configuration, and state sequence are separate concepts. M01 initializes only public compatibility values. Database changes are append-only forward migrations; production startup never migrates. Destructive down migration is not a recovery plan. Later world rollback uses audited compensation/snapshots, not rewritten database history.
