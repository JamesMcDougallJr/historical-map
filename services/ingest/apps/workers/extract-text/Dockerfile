# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT, not services/ingest — the workspace root owns
# the lockfile, and packages/domain ships TypeScript source that webpack must
# compile in. Build with:
#
#   docker build -f services/ingest/apps/workers/extract-text/Dockerfile -t ingest-extract-text .
#
FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first so a dependency-only change reuses the install layer.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY services/ingest/package.json services/ingest/
RUN npm ci

COPY packages/domain packages/domain
COPY services/ingest services/ingest

WORKDIR /repo/services/ingest
RUN npx nest build extract-text

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# The runtime layout must mirror the workspace layout, because that is what
# Node's module resolution walks: the bundle lives in services/ingest, so its
# node_modules must be reachable from there.
COPY package.json package-lock.json ./
COPY packages/domain packages/domain
COPY services/ingest/package.json services/ingest/

# NO --include-workspace-root: the root package IS the Next.js web app, and
# pulling in next/react/ol here tripled the image for code that never runs in
# it. This installs only what the workers actually require.
RUN npm ci --omit=dev --workspace=services/ingest \
 && npm cache clean --force

# `nest build` with webpack inlines every @app/* lib and @historical-map/domain
# into one main.js (see webpack.config.js), so only the bundle is needed — never
# the monorepo source.
COPY --from=build /repo/services/ingest/dist/apps/workers/extract-text services/ingest/dist

WORKDIR /app/services/ingest

# Every app serves /health — an orchestrator needs a liveness signal from a
# process that otherwise only talks to Redis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/main.js"]
