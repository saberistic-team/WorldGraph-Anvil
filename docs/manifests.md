# World Manifest v1

`WorldManifestV1` is immutable declarative intent for one bounded city-state. It is not executable code and it is not runtime WorldGraph state. Approval never compiles, seeds, activates, simulates, transfers value, or changes governance.

## Content and identity

The manifest records schema version `1`, an explicit deterministic seed, city-state metadata, exact primitive references and parameters, districts/connections, institutions, organizations, actor blueprints, economy intent, initial relationships, simulation settings, visual direction, assumptions, and a bounded namespaced extension object. Local keys use lowercase hyphenated identifiers. Relationships point only to those local keys.

Every primitive reference pins all of the following:

- immutable primitive-version UUID;
- stable registry key and exact SemVer;
- primitive kind;
- published content SHA-256;
- manifest-local reference key;
- schema-validated inert parameters.

The validator accepts a pinned version that was published and later deprecated, but emits `MANIFEST_PRIMITIVE_DEPRECATED`; it never retargets to a newer version. Missing identity, version, kind, content hash, dependency, compatibility, allowlisted behavior, or parameter-schema matches are errors.

## Canonical JSON and safe YAML

Canonical JSON is authoritative. Objects are Unicode-normalized and key-sorted by the existing WorldGraph canonical serializer; arrays preserve semantic order. Revision content identity is SHA-256 over those exact canonical UTF-8 bytes. Revision UUIDs, row IDs, timestamps, users, worlds, and provider metadata are outside the content hash.

YAML is a reversible editing projection only. The parser uses the JSON schema mode and rejects aliases/anchors, merge keys, custom or known executable tags, duplicate keys, prototype keys, multiple documents, non-JSON scalars, control characters, excessive depth/nodes/properties/lines, and documents over 131,072 bytes. Source locations are diagnostic metadata and do not enter canonical content. A parse failure creates no revision and leaves the prior revision unchanged.

## Validation and diagnostics

Validation is layered and deterministic:

1. bounded JSON safety and Manifest v1 schema;
2. normalized unique local and primitive-reference keys;
3. exact registry identity/content and parameter schemas;
4. dependency, compatibility, and allowlisted behavior checks;
5. local-reference and relationship endpoint integrity;
6. district connectivity and required city-state mechanics.

A report records validator version `1`, the exact catalog snapshot hash, ordered diagnostics, validity, report SHA-256, and observation time. Diagnostics contain stable severity/code, JSON Pointer, optional YAML location, related pointers, and explicit structured suggestions. A suggestion is never applied silently. Errors block approval. Generation-time warning requirements are immutable, inherited by every child, capped at the same 32-item contract/database limit, and reattached during current-catalog validation. Every current validation or retained-generation warning code must be acknowledged exactly.

## Revisions and approval

Revisions are immutable and monotonically numbered under a locked world row. Manual edits and regenerations create children; approved content is never edited. Provenance entries identify prompt, exact primitive, provider model, deterministic fallback, or manual sources by bounded references and hashes—never chain of thought or raw provider payload.

Approval is a creator-only, idempotent transaction. It locks the world and target revision, requires the latest draft in both the service and database trigger, verifies the expected world row version and content hash, matches the normalized typed world name, revalidates against current support and exact pins, requires exact warning acknowledgements, supersedes the previous approval, advances the world pointer/version, and writes audit. A platform administrator without the creator membership cannot approve or inspect private prompt/manifest content.

Manifest schema migration hooks are reserved, but no Manifest v2 exists. Any future schema changes require a new contract, deterministic migration, compatibility policy, and ADR; existing canonical v1 bytes and hashes remain immutable.
