# Ingestion Engine — Phase Index

The map at `/map` currently serves **44 hand-curated events across 34 locations from one
source** (`utah-historical`, seeded from `data/map-data.json`). Everything in it was entered
by hand or pasted through `/map/import`. This directory plans the engine that replaces that
with continuous, automated ingestion — and makes adding the *second* source, and the
fiftieth, a one-file change.

The design is deliberately a port of the State Affairs video pipeline (`~/Code/StateAffairs`),
because the problem is the same shape: poll a set of external publishers on a schedule,
retrieve what's new exactly once, run an expensive transformation over it, and survive
network failure without manual intervention.

## The mapping

| State Affairs | Here | What changed |
|---|---|---|
| `detect` — poll MI House/Senate video portals | `detect` — poll historical-source catalogues | Nothing structural. `SourceAdapter` gets a new implementation per source. |
| `download` — `ffmpeg` stream → 16kHz WAV → S3 | `fetch` — HTTP/PDF/IIIF → extracted text → Postgres | No `ffmpeg` and no object storage. Text extraction reuses `unpdf`, already a dependency of the web app. |
| `transcribe` — Groq Whisper → transcript | `extract` — Claude API → `ParsedEvent[]` | Different engine, identical shape: a chunked, retryable, interface-backed transformation behind a DI token. |
| — | `publish` — geocode, dedupe, write | **New stage.** See below. |

**Why a fourth stage.** In State Affairs the transcript was terminal — once written, the job
was done. Here, extraction output is not yet map data: a `ParsedEvent` has a free-text place
name ("Promontory Summit"), not coordinates, and may duplicate an event another source already
published. Geocoding is a separate rate-limited external dependency, and deduplication needs
to read existing rows. Folding either into `extract` would mean a geocoder outage discards an
expensive LLM extraction. Splitting them means the extraction is durable the moment it lands.

This is the same "durable-progress-beats-monolithic-retry" reasoning behind both of State
Affairs' documented known limitations — applied up front this time rather than as a fix
sketch.

## Phases

Each phase gets discussed and adjusted immediately before it is implemented. These files are
a starting point per phase, **not a green light to build all of them in one pass** — the same
working agreement as `~/Code/StateAffairs/plans/00-README.md`.

1. [01-monorepo.md](./01-monorepo.md) — npm workspaces + Nx, `packages/domain`, Vercel
   deploys unchanged. **Implemented.**
2. [02-ingest-scaffold.md](./02-ingest-scaffold.md) — `services/ingest` as a Nest monorepo;
   config/env validation; `docker-compose` gains Redis.
3. [03-database-layer.md](./03-database-layer.md) — TypeORM entities + migrations for the
   ingestion tables, in the existing Postgres alongside what `lib/postgres-storage.ts` reads.
4. [04-queue-layer.md](./04-queue-layer.md) — BullMQ contracts, deterministic job IDs, the
   detection Job Scheduler.
5. [05-source-adapters.md](./05-source-adapters.md) — `SourceAdapter` implementations. The
   scale story lives here.
6. [06-detect-worker.md](./06-detect-worker.md) — discovery and idempotent insert.
7. [07-fetch-worker.md](./07-fetch-worker.md) — retrieval and text extraction.
8. [08-extract-worker.md](./08-extract-worker.md) — Claude API structured extraction.
9. [09-publish-worker.md](./09-publish-worker.md) — geocode, dedupe, write to the map.
10. [10-deployment.md](./10-deployment.md) — where the workers run, given the web app is on
    Vercel.

## Locked decisions

Do not relitigate without discussion.

- **Monorepo tooling: npm workspaces, with Nx as a package-based task runner.** Nx does *not*
  own any build — every target is a plain `package.json` script, and `vercel.json` pins
  `installCommand`/`buildCommand` so Vercel's monorepo detection can never reroute the web
  build through Nx. Rationale and the alternative considered are in
  [01-monorepo.md](./01-monorepo.md).
- **The web app stays the root package.** It is not moved to `apps/web`. That relocation would
  require flipping the Vercel project's Root Directory setting, which is project-wide rather
  than per-branch — so the PR preview would fail and production would break between merge and
  the dashboard change. The monorepo goal (one repo, many deployables) is met without it.
- **Queue: BullMQ + Redis**, with deterministic content-derived job IDs as the queue-layer
  idempotency mechanism. Same rationale as State Affairs — the scheduler's state lives in
  Redis, so it survives a restart of whichever worker registered it.
- **Database: the Postgres this repo already has.** `docker-compose.yml` already runs
  PostGIS + Martin, and `lib/postgres-storage.ts` already reads map data from it. Ingestion
  writes into the *same* database, adding its own tables. No second datastore, and no API hop
  between the workers and the map.
- **ORM: TypeORM, for both entities and migrations.** No Prisma — the State Affairs
  Prisma-schema-plus-hand-mirrored-entities split is not carried over. One tool owns the
  `ingest_*` tables. `synchronize` stays `false` in every environment. See
  [03-database-layer.md](./03-database-layer.md).
- **No object storage.** `fetch` produces extracted *text* — tens of KB — which goes in a
  Postgres column. No MinIO, no S3, no `StorageService` abstraction. The compose stack gains
  one service (Redis), not four. See [02-ingest-scaffold.md](./02-ingest-scaffold.md).
- **Extraction: Claude API via `@anthropic-ai/sdk`**, behind an `ExtractionEngine` interface
  and an `EXTRACTION_ENGINE` DI token — so the engine is swappable without touching the
  worker, the queue contract, or storage. Model and parameters in
  [08-extract-worker.md](./08-extract-worker.md).
- **Shared types live in `packages/domain`**, imported by both the web app and the workers.
  The two must not drift on what a `HistoricalEvent` is.
- **The workers do not run on Vercel.** They are long-lived processes holding Redis
  connections; Vercel functions are neither. See [10-deployment.md](./10-deployment.md).

## Correction to CLAUDE.md

`CLAUDE.md` describes `/api/parse` as "AI parse (Claude API via `/api/parse`)". It is not —
`app/api/parse/route.ts` calls `parseDocument()` from
`app/map/import/services/processing-service.ts`, which runs the local `regex` and `structured`
parsers. **There is no Claude API call anywhere in the repo today**, and no `@anthropic-ai/sdk`
dependency. Phase 8 introduces the first one. Worth fixing in `CLAUDE.md` whenever that file
is next touched.
