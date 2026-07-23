# ADR 0003 — Server authority and AI boundary

Status: accepted in M01.

Every meaningful future mutation originates as an authenticated command and passes server authorization/validation. Clients, workers, administrators, simulation, and AI cannot write domain tables around that boundary. LLMs may propose schema-constrained data outside transactions but never execute authoritative changes. This invariant is not subject to scale-based reversal.
