# ADR 0005 — Redis and queue role

Status: accepted in M01.

Redis/BullMQ provide at-least-once ephemeral coordination, never authoritative state. Jobs carry bounded versioned references, processors are idempotent, producer retries are bounded, and PostgreSQL/outbox will later bridge durable events. Kafka was rejected at alpha scale. Revisit a durable broker only with measured throughput/replay needs while preserving a transactionally reliable publication boundary.
