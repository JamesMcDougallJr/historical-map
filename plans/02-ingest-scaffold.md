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
   ├─ common/              config, env validation, JobLogger, storage
   ├─ database/            entities + migrations
   ├─ queue/               BullMQ contracts and job-id builders
   ├─ sources/             SourceAdapter implementations
   └─ extraction/          ExtractionEngine + the Claude engine
```

Two path-alias families in `tsconfig.json`: `@app/*` → `libs/*/src` (internal, mirrors State
Affairs), and `@historical-map/domain` → `../../packages/domain/src` (cross-workspace). The
second is what keeps the workers and the map agreeing on `HistoricalEvent`.

## Config

`libs/common/src/config` with a schema-validated env (State Affairs used Joi; **prefer `zod`**
here — it is already a dependency of the web app, so the monorepo shares one validation
library rather than adding a second).

Variables: `POSTGRES_URL`, `REDIS_HOST`/`REDIS_PORT`, `ANTHROPIC_API_KEY`, `S3_*`, and the
per-stage concurrency knobs. `POSTGRES_URL` is deliberately **the same variable the web app
already uses** — one database, one connection string, no divergence.

## Local infrastructure

Extend the existing `docker-compose.yml` rather than adding a second file. It already runs
PostGIS and Martin; ingestion needs Redis, and object storage for fetched documents.

- **Redis** — BullMQ's backing store.
- **MinIO** — S3-compatible stand-in for whatever object store production uses, with the same
  one-shot bucket-bootstrap service State Affairs uses (and the same retry loop around
  `mc alias set`, because `depends_on` waits for the container, not for MinIO to accept
  connections).

Keep the existing host-port convention: Postgres is already on **5433**, not 5432.

## Open question for the phase discussion

Whether `fetch` needs object storage at all in v1. State Affairs needed S3 because audio is
large and the download/transcribe workers may not share a host. Here the artifact is extracted
*text* — typically tens of KB, occasionally a few MB for a long PDF. That could live in a
Postgres `text`/`bytea` column, deleting MinIO, the `S3_*` config, and a whole class of
"which host has the file" failure from the design.

Recommendation: **start without object storage**; store extracted text in Postgres and keep the
`StorageService` interface in `libs/common` so the escape hatch exists if a source turns out to
serve 200MB scans. The abstraction is cheap; running MinIO for 40KB of text is not.

## Verification

- `nest build` succeeds for all five projects.
- Each worker boots, connects to Redis and Postgres, and idles without a queue registered.
- `npm run type-check:all` at the repo root covers both workspaces.
