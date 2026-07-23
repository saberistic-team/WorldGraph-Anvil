# World Primitive registry and authoring

Milestone 3 introduces schema version 1 of the World Primitive registry. A primitive describes a reusable world-design capability as inert JSON data. It does not execute code and does not grant authority.

## Identity and lifecycle

- `key` is a lowercase reverse-DNS-like stable family key, such as `worldgraph.government.guild-council`.
- `version` is strict SemVer. Leading-zero numeric components, invalid prerelease identifiers, unsafe integers, and loose aliases are rejected.
- A family fixes its key and kind after its first publication. Each family may have many exact versions.
- Draft content can be edited with an expected row version. Publication locks semantic content, tags, dependencies, and the lexical document in PostgreSQL. Deprecation changes lifecycle metadata only.
- Consumers must pin an exact `{key, version}`. Dependency declarations may use bounded SemVer ranges, but publication stores the exact resolved version ID and content hash.

Supported schema-1 kinds are `government`, `election`, `currency`, `tax`, `resource`, `production_recipe`, `terrain`, `district`, `building`, `organization`, `office`, `legal_right`, `player_role`, `visual_style`, `simulation_rule`, and `event_template`.

## Definition fields

A draft includes display name and Markdown documentation; tags; compatibility constraints; local JSON Schema and defaults; required/optional dependencies and parameter mappings; an optional allowlisted behavior reference; visual hints; and provenance. Canonical JSON normalizes Unicode, sorts object keys by code point, rejects non-JSON values, and feeds the SHA-256 content hash.

The validator bounds document bytes, object/array counts, nesting, property counts, regex size, tags, dependencies, and issue output. It rejects remote or unsafe `$ref`, prototype-pollution keys, raw HTML and unsafe URL schemes, control/lone-surrogate characters, executable-looking content, schema bombs, invalid defaults, dependency cycles/conflicts, and behavior names outside the reviewed allowlist. Validation never fetches a remote resource.

## Dependency workflow

Draft saving may retain a reference to an existing family whose range is not currently resolvable; the returned validation report identifies the JSON pointer and stable issue code. Unknown families are rejected because they cannot be represented by a valid foreign key. Publication is stricter: every required dependency must resolve to one compatible published exact version, optional unresolved dependencies remain explicitly unlocked, and prohibited cycles fail atomically.

The detail API returns both declarations and publication locks:

```json
{
  "key": "worldgraph.resource.energy",
  "dependencyFamilyId": "…",
  "versionRange": "^1.0.0",
  "required": true,
  "parameterMapping": {},
  "resolvedVersion": "1.0.0",
  "resolvedVersionId": "…",
  "resolvedContentHash": "…"
}
```

## Reviewed starter catalog

The version-controlled city-state catalog contains one exact `1.0.0` version for each kind: guild council, council ballot, closed-loop credits, flat transaction levy, energy, energy reclamation, floating platform, floating mixed-use district, modular guild hall, guild, councillor, civic charter, citizen, low-poly floating city, discrete city clock, and council session.

Import uses the same validator and hashes as the API. The first import creates the 16 published records and their exact dependency locks; a repeat is a no-op. If an existing bundled identity, semantic hash, dependency lock, lexical document, or durable index intent differs, import fails rather than overwriting published data.

Run a local import after migrations with:

```sh
DATABASE_URL=postgres://… pnpm db:seed:primitives
```

Compose uses the owner-credential one-shot database bootstrap to migrate and import before API or worker startup. Runtime services use the least-privilege application role.

## Safe authoring checklist

1. Choose an existing kind and a stable key that will not be renamed.
2. Treat documentation and JSON fields as public untrusted data; include no secrets, remote assets, scripts, SQL, templates, or instructions to an AI.
3. Keep parameters local and bounded, provide defaults that validate, and use only local `$ref` fragments.
4. Declare the narrowest compatible dependency range and review the exact locks in the validation/publication result.
5. Review the canonical content hash and provenance before confirming publication.
6. Publish a new SemVer for any correction. Deprecate compromised content with a safe reason; never edit or delete it.
