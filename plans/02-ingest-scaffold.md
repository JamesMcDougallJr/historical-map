# Phase 2 — `services/ingest` scaffold

Stand up the Nest workspace the four workers live in, plus the local infrastructure they need.
No pipeline logic in this phase — the goal is `npm run build --workspace=services/ingest`
succeeding and each app booting to a healthy idle.

## Layout

Nest's own monorepo mode (`nest-cli.json`), nested inside the npm workspace — the same shape as
`~/Code/StateAffairs`.

```
services/ingest/
├─ nest-cli.json           projects: api, detect, fetch, extract + libs
├─ package.json            name: @historical-map/ingest
├─ tsconfig.json           @app/* path aliases + @historical-map/domain
├─ apps/
│  ├─ api/                 trigger + read-only status surface
│  └─ workers/
│     ├─ detect/
│     ├─ fetch/
│     ├─ extract/
│     └─ publish/
└─ libs/
   ├─ common/              config, env validation, JobLogger
   ├─ database/            TypeORM entities + migrations
   ├─ queue/               BullMQ contracts and job-id builders
   ├─ sources/             SourceAdapter implementations
   └─ extraction/          ExtractionEngine + the Claude engine
```

No `storage` module — there is no object storage in this design (see below).

Two path-alias families in `tsconfig.json`: `@app/*` → `libs/*/src` (internal, mirrors State
Affairs), and `@historical-map/domain` → `../../packages/domain/src` (cross-workspace). The
second is what keeps the workers and the map agreeing on `HistoricalEvent`.

## Config

`libs/common/src/config` with a schema-validated env (State Affairs used Joi; **prefer `zod`**
here — it is already a dependency of the web app, so the monorepo shares one validation
library rather than adding a second).

Variables: `POSTGRES_URL`, `REDIS_HOST`/`REDIS_PORT`, `ANTHROPIC_API_KEY`, and the per-stage
concurrency knobs. No `S3_*`. `POSTGRES_URL` is deliberately **the same variable the web app
already uses** — one database, one connection string, no divergence.

## Local infrastructure

Extend the existing `docker-compose.yml` rather than adding a second file. It already runs
PostGIS and Martin; ingestion needs **Redis**, and nothing else.

Keep the existing host-port convention: Postgres is already on **5433**, not 5432.

## No object storage — **decided**

State Affairs needed S3/MinIO because audio is large and the download and transcribe workers
may not share a host. Neither applies here: the artifact `fetch` produces is extracted **text**,
typically tens of KB. It goes in a Postgres column.

That deletes MinIO, the bucket-bootstrap service and its readiness retry loop, the `S3_*`
config, the `StorageService` interface and its DI token, and the entire "which host has the
file" class of failure. It also means the compose stack gains exactly one service (Redis)
rather than four.

The escape hatch, if some future source serves 200MB scans, is that `fetch` already writes
through a single function — introducing storage later touches one call site, not the design.
Building the abstraction now to defend against a source that may never exist is the more
expensive choice.

## Verification

- `nest build` succeeds for all five projects.
- Each worker boots, connects to Redis and Postgres, and idles without a queue registered.
- `npm run type-check:all` at the repo root covers both workspaces.
