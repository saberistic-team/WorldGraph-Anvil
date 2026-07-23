# ADR 0004 — Runtime contracts and canonical JSON

Status: accepted in M01.

Use TypeBox-authored JSON Schema contracts validated by Ajv 2020, explicit schema versions, and canonical UTF-8 JSON hashing. Canonicalization normalizes Unicode, sorts keys lexically including integer-like names, preserves array order, rejects non-JSON/cyclic values, and uses SHA-256. TypeScript-only contracts and executable documents were rejected because consumers and untrusted AI input need runtime validation.
