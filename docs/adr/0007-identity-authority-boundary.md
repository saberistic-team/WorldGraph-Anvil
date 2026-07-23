# ADR 0007: PostgreSQL-backed identity and explicit authority

Status: accepted in Milestone 2.

WorldGraph uses opaque server sessions, PostgreSQL membership as the current world-role source, and one deny-by-default RBAC+ABAC evaluator. Creator provenance, platform administration, world membership, and future offices/organizations/AI subjects are separate concepts. A platform administrator addressing a known world has no synthetic membership role. All protected mutations use a versioned command/idempotency boundary and immutable security audit; the Milestone 6 event ledger is not preimplemented.

The alternative of browser/JWT-carried roles was rejected because revocation and tenant authorization must take effect immediately. Treating `created_by_user_id` as authority was rejected because provenance must remain immutable while authority may evolve. A generic policy service was rejected for now: the typed in-process evaluator is smaller, testable, and keeps the modular monolith boundary.

Consequences: PostgreSQL is required for authentication and authorization; session/CSRF/invitation secrets are hashed at rest; membership reads and changes share world-row locks; exactly one creator is enforced by database constraints; explicit override use is reasoned, linked, alerted, and immutable. Revisit an external policy engine only if measured policy complexity or independent deployment ownership warrants it.
