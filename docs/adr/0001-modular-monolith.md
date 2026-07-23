# ADR 0001 — Modular monolith and process roles

Status: accepted in M01.

Use one strict TypeScript workspace with bounded packages and three process roles: web, API, and worker. This keeps future economy/governance transactions local while allowing independent process scaling. The alternative was early domain microservices, rejected for distributed consistency and operational cost. Revisit only when profiling shows a stable module needs independent scaling/failure isolation and its outbox contract is mature.
