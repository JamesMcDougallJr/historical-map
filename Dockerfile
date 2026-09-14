# syntax=docker/dockerfile:1
#
# The Next.js web app. Build context is the REPO ROOT — same reasoning as
# services/ingest's Dockerfiles: packages/domain ships TypeScript source that
# has to be present (not just its package.json) for Next to compile it via
# `transpilePackages`, and the workspace lockfile lives at the root.
#
#   docker build -f Dockerfile -t historical-map-web .
#
# Not `output: 'standalone'` — deliberately. Vercel already does its own
# bundling for the production deployment this repo ships to; opting into
# standalone output here would be a second, untested packaging path for an app
# that has exactly one deployment target today. Correctness over image size.
FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first so a dependency-only change reuses the install layer.
# Both workspace package.jsons are needed for `npm ci` to resolve against the
# lockfile even though this image only runs the root workspace — the same
# requirement noted in services/ingest/apps/*/Dockerfile.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY services/ingest/package.json services/ingest/
RUN npm ci

COPY packages/domain packages/domain
COPY app app
COPY lib lib
COPY mcp mcp
COPY data data
COPY db db
COPY types types
COPY scripts scripts
COPY next.config.mjs tsconfig.json vite.config.mcp.ts postcss.config.js middleware.ts ./

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, not read
# at runtime — a `docker-compose.yml` `environment:` entry for this arrives too
# late to matter. It has to be a build ARG, and compose has to pass it via
# `build.args`. Getting this wrong looks exactly like the layer picking the
# wrong kind silently (see the MVT-layer commit) rather than failing loudly.
ARG NEXT_PUBLIC_MARTIN_URL
ENV NEXT_PUBLIC_MARTIN_URL=$NEXT_PUBLIC_MARTIN_URL

# `prebuild` (build:mcp) runs automatically via the npm lifecycle.
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/domain packages/domain
RUN npm ci --omit=dev && npm cache clean --force

# `next start` (non-standalone) serves compiled output from `.next` — it does
# not need the raw `app/`/`lib/` source at runtime, only these four.
COPY --from=build /repo/.next .next
COPY --from=build /repo/mcp/dist mcp/dist
COPY --from=build /repo/data data
COPY next.config.mjs ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/map').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["npm", "start"]
