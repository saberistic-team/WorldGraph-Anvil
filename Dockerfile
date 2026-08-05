FROM node:22.23.2-alpine3.23 AS dependencies

RUN npm install --global pnpm@11.9.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS api-build
RUN pnpm turbo run build --filter=@worldgraph/api...

FROM api-build AS api-prune
RUN pnpm --filter @worldgraph/api deploy --legacy --prod /out/api

FROM dependencies AS worker-build
RUN pnpm turbo run build --filter=@worldgraph/worker...

FROM worker-build AS worker-prune
RUN pnpm --filter @worldgraph/worker deploy --legacy --prod /out/worker

FROM dependencies AS migration-build
RUN pnpm turbo run build --filter=@worldgraph/db...

FROM migration-build AS migration-prune
RUN pnpm --filter @worldgraph/db deploy --legacy --prod /out/migration

FROM dependencies AS web-build
RUN pnpm turbo run build --filter=@worldgraph/web...

FROM node:22.23.2-alpine3.23 AS node-runtime

ENV NODE_ENV=production
WORKDIR /app

FROM node-runtime AS api

COPY --from=api-prune --chown=node:node /out/api/package.json ./package.json
COPY --from=api-prune --chown=node:node /out/api/node_modules ./node_modules
COPY --from=api-build --chown=node:node /app/apps/api/dist ./dist
USER node
CMD ["node", "dist/index.js"]

FROM node-runtime AS worker

COPY --from=worker-prune --chown=node:node /out/worker/package.json ./package.json
COPY --from=worker-prune --chown=node:node /out/worker/node_modules ./node_modules
COPY --from=worker-build --chown=node:node /app/apps/worker/dist ./dist
USER node
CMD ["node", "dist/index.js"]

FROM node-runtime AS migration

COPY --from=migration-prune --chown=node:node /out/migration/package.json ./package.json
COPY --from=migration-prune --chown=node:node /out/migration/node_modules ./node_modules
COPY --from=migration-build --chown=node:node /app/packages/db/dist ./dist
COPY --from=migration-build --chown=node:node /app/packages/db/drizzle ./drizzle
USER node
CMD ["node", "dist/cli/bootstrap.js"]

FROM node-runtime AS web

ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
WORKDIR /app/apps/web
USER node
CMD ["node", "server.js"]
