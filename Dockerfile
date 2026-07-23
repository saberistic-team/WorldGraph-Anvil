FROM node:22.20.0-bookworm-slim AS build

RUN npm install --global pnpm@11.9.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build --chown=node:node /app/apps/web/.next ./apps/web/.next
COPY --from=build --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build --chown=node:node /app/packages/db/src/index.ts ./packages/db/src/index.ts
COPY --from=build --chown=node:node /app/packages/db/src/schema.ts ./packages/db/src/schema.ts
COPY --from=build --chown=node:node /app/packages/db/src/primitive-seed.ts ./packages/db/src/primitive-seed.ts
COPY --from=build --chown=node:node /app/packages/db/src/cli/bootstrap.ts ./packages/db/src/cli/bootstrap.ts
COPY --from=build --chown=node:node /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build --chown=node:node /app/packages/catalog/package.json ./packages/catalog/package.json
COPY --from=build --chown=node:node /app/packages/catalog/node_modules ./packages/catalog/node_modules
COPY --from=build --chown=node:node /app/packages/catalog/src/dependencies.ts ./packages/catalog/src/dependencies.ts
COPY --from=build --chown=node:node /app/packages/catalog/src/embedding.ts ./packages/catalog/src/embedding.ts
COPY --from=build --chown=node:node /app/packages/catalog/src/index.ts ./packages/catalog/src/index.ts
COPY --from=build --chown=node:node /app/packages/catalog/src/retrieval.ts ./packages/catalog/src/retrieval.ts
COPY --from=build --chown=node:node /app/packages/catalog/src/search.ts ./packages/catalog/src/search.ts
COPY --from=build --chown=node:node /app/packages/catalog/src/seed.ts ./packages/catalog/src/seed.ts
COPY --from=build --chown=node:node /app/packages/catalog/src/semver.ts ./packages/catalog/src/semver.ts
COPY --from=build --chown=node:node /app/packages/catalog/src/starter-catalog.lock.json ./packages/catalog/src/starter-catalog.lock.json
COPY --from=build --chown=node:node /app/packages/catalog/src/validation.ts ./packages/catalog/src/validation.ts
COPY --from=build --chown=node:node /app/packages/config/package.json ./packages/config/package.json
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=node:node /app/packages/contracts/src ./packages/contracts/src
COPY --from=build --chown=node:node /app/packages/manifests/package.json ./packages/manifests/package.json
COPY --from=build --chown=node:node /app/packages/manifests/node_modules ./packages/manifests/node_modules
COPY --from=build --chown=node:node /app/packages/manifests/src ./packages/manifests/src
COPY --from=build --chown=node:node /app/packages/observability/package.json ./packages/observability/package.json
COPY --from=build --chown=node:node /app/packages/test-utils/package.json ./packages/test-utils/package.json
USER node

CMD ["node", "apps/api/dist/index.js"]
