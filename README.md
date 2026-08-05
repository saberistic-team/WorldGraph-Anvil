# WorldGraph (Anvil)

WorldGraph is an AI-native platform for creating and inhabiting persistent multiplayer societies. Anvil is its closed-alpha city-state implementation. Milestones 1–8 are sealed. Milestone 9 is implemented but not sealed: compiler `1.2.0` adds a deterministic productive-commerce plan on top of the exact retained `1.1.0` and `1.0.0` lanes; PostgreSQL-authoritative commands now cover resources, businesses, employment, scheduled production, fixed-price trade, treasury tax, reconciliation, and narrowly audited recovery. Governance, browser realtime play, generated media, geography, and WebGL remain intentionally absent until later milestones. See the M09 state record for the verification gates that remain environment-blocked.

## Quick start

Prerequisites: Git, Docker Desktop/Engine with Compose, and Node 22.23.2. The repository pins pnpm 11.9.0.

1. Copy .env.example to .env only if you need to override local defaults. Never commit .env.
2. Run pnpm install --frozen-lockfile.
3. Run pnpm bootstrap.
4. Open http://localhost:3000 and http://localhost:3000/system.
5. Run pnpm reset:local when you want to remove containers and local database data.

The Compose stack builds separate, pruned, non-root Node 22.23.2 Alpine images for web, API, worker, and the one-shot migration job. Runtime images contain only their service artifact and production dependency closure; the migration job executes compiled JavaScript and does not ship `tsx` or the root development toolchain. PostgreSQL 17 runs on the current PostGIS Alpine line with pgvector 0.8.1 installed, and Redis is pinned to the patched 8.4.5 Alpine image. The upstream PostGIS Alpine image is currently amd64-only, so Compose defaults `POSTGRES_PLATFORM` to `linux/amd64` (including emulation on Apple Silicon). The owner-credential one-shot bootstrap migrates and imports the reviewed primitive catalog before runtime processes start.

## Verification

- pnpm check: formatting, lint, types, unit tests, compiler golden identity, migration-journal drift, production builds, and the separate-process standalone compiler CLI check.
- pnpm test:integration: fresh/exact-upgrade PostgreSQL migrations and constraints plus Redis/BullMQ delivery, primitive indexing, manifest-generation recovery, compiler activation races/rollback, and scoped graph reads through Testcontainers.
- pnpm exec playwright install chromium, then pnpm test:e2e: browser and accessibility tests at desktop and 320-pixel width.
- With Compose running and operational smoke enabled, pnpm test:compose: real catalog import/browse/fallback retrieval, two-user BFF/API cookie+CSRF authority flow, generation/compilation/activation/graph behavior, duplicate delivery, and Redis/PostgreSQL failure/recovery.
- After installing Chromium, pnpm test:compose:browser runs that same real-service journey and adds independent desktop-manager and 375-pixel mobile-buyer sessions. The browser leg commits and exactly replays the UI-generated itemized purchase, then visibly reviews both sides of business/employment authority, completed production, the partial listing and immutable trade, balanced transaction postings, treasury/tax totals, matched reconciliation, and the filtered world-history fact. Axe and viewport-overflow checks cover each key workspace.
- pnpm verify runs the local non-Compose gates; CI additionally runs audit, dependency/license review, Compose build, and recovery smoke.

See docs/development.md for configuration and commands, docs/architecture.md for boundaries, docs/identity-authority.md for the authority contract, docs/primitives.md and docs/primitive-retrieval.md for registry semantics, docs/manifests.md and docs/manifest-generation.md for Manifest Studio, docs/compiler-worldgraph.md for compiler/graph semantics, docs/command-ledger.md for commands/history/replay/repair, docs/simulation.md for tick/schedule/process/fencing semantics, docs/economy.md for accounting/title/commerce semantics, and docs/milestones/09-production-businesses-jobs-markets-tax-state.md for the current unsealed milestone boundary.
