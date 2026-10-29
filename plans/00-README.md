# Ingestion Engine — Phase Index

The map at `/map` currently serves **44 hand-curated events across 34 locations from one
source** (`utah-historical`, seeded from `data/map-data.json`). Everything in it was entered
by hand or pasted through `/map/import`. This directory plans the engine that replaces that
with continuous, automated ingestion — and makes adding the _second_ source, and the
fiftieth, a one-file change.

The design is deliberately a port of the State Affairs video pipeline (`~/Code/StateAffairs`),
because the problem is the same shape: poll a set of external publishers on a schedule,
retrieve what's new exactly once, run an expensive transformation over it, and survive
network failure without manual intervention.

## The mapping

| State Affairs                                 | Here                                                | What changed                                                                                                |
| --------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `detect` — poll MI House/Senate video portals | `detect` — poll historical-source catalogues        | Nothing structural. `SourceAdapter` gets a new implementation per source.                                   |
| `download` — `ffmpeg` stream → 16kHz WAV → S3 | `fetch` — HTTP/PDF/IIIF → extracted text → Postgres | No `ffmpeg` and no object storage. Text extraction reuses `unpdf`, already a dependency of the web app.     |
| `transcribe` — Groq Whisper → transcript      | `extract` — Claude API → `ParsedEvent[]`            | Different engine, identical shape: a chunked, retryable, interface-backed transformation behind a DI token. |
| —                                             | `publish` — geocode, dedupe, write                  | **New stage.** See below.                                                                                   |

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
11. [11-identity-and-fusion.md](./11-identity-and-fusion.md) — **gaps recorded, not
    scheduled.** What today's deduplication actually covers, and what breaks when a second
    document describes an event the first already published.
12. [12-embeddings-and-bedrock.md](./12-embeddings-and-bedrock.md) — the shared substrate for
    13 and 14: Bedrock as embedding + judge provider, pgvector in the same Postgres, the
    `EmbeddingEngine`/`JudgeEngine` tokens.
13. [13-similarity-and-fusion.md](./13-similarity-and-fusion.md) — vector search proposes, an
    LLM judge disposes, assertions fuse into clusters. Answers the gaps in 11.
14. [14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md) — anchors, "view the
    source" deep links, and RAG with citations across multiple sources.
15. [19-search.md](./19-search.md) — **search track, design only.** Full-text search over
    events, sequences and source text (20), the typed search bar (21), people (22), and
    semantic/hybrid search on plan 12's substrate (23). Stretch goals: people (22), MCP (24).
16. [25-product-backlog.md](./25-product-backlog.md) — **product track.** The living backlog
    James works from: land the second source, build web ingest, retire the curated seed.
17. [26-wikidata-pilot.md](./26-wikidata-pilot.md) — Wikidata as the first ingestion source,
    **GLOBAL** scope. The 44 curated events are a transient spot-check set, deleted once
    ingestion is validated (James, 2026-10-20).
18. [27-web-ingestor.md](./27-web-ingestor.md) — curl/HTTP fetcher so sources come over the
    web: JSON APIs, HTML, sitemaps — not PDFs only.
19. [28-britannica-link-only.md](./28-britannica-link-only.md) - Britannica "On This Day"
    as a LINK-ONLY source: date + short factual identifier + link back, never the text
    (James, 2026-10-21). Server-rendered day pages; per-date discovery via sitemap scan.
20. [29-source-expansion-dedup.md](./29-source-expansion-dedup.md) - source expansion
    pass (2026-10-23): Muffinlabs Today-in-History API as source #3, OpenHistoricalMap
    as boundary layer, GDELT 2.0 deferred; dedup via Jev pairwise judging (settled 2026-10-23)
    inside plan 13's design; WHG v4 as temporal-gazetteer tier alongside HistGeocoder.
21. [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) - map UX at scale
    (2026-10-24, drafted; pushed 2026-10-25): clustering, density-aware zoom and
    default view, timeline semantic zoom, viewport + time-window fetching gated on
    e2e-real going green. Display-side counterpart to the ingestion plans.
22. [31-shareable-map-state.md](./31-shareable-map-state.md) - shareable map state
    (2026-10-25): deep links for viewport, timeline window, search, and selected
    event; URL as the single restorable state, with graceful degradation for
    merged/deleted event ids.

23. [32-fuzzy-dates.md](./32-fuzzy-dates.md) - fuzzy dates (2026-10-26):
    EDTF Level 1 date model for events - canonical EDTF string plus strict
    start/end bounds plus a display string; Wikidata precision/circa/
    earliest/latest mapping table; fuzzy events render as timeline spans
    with distinct uncertain markers; dedup blocking uses interval overlap.

24. [33-source-licensing-attribution.md](./33-source-licensing-attribution.md)
    - source licensing and attribution (2026-10-27): every adapter declares
    its license (SPDX) at the boundary; publish rejects undeclared licenses;
    merged events carry the union of attributions; link-only records stay
    link-only through fusion; popup Sources line plus a /sources page;
    OHM is CC0 by default with per-element license exceptions, not ODbL.

25. [34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md)
    - pipeline observability and publish review queue (2026-10-28):
    Bull Board admin on the ingest service, per-stage dead-letter
    queues with replay, a durable Postgres review queue with
    approve-fingerprint verification and TTL escalation, alert
    thresholds, and a per-source LLM cost ledger.

26. [35-e2e-real-repair-merge-gate.md](./35-e2e-real-repair-merge-gate.md)
    - repair the real-backend E2E suite and make it a merge gate
    (2026-10-29): triage the red-since-Oct-19 suite before touching
    anything (bisect PR #19's S3 change vs environment), fix the
    proven cause, give the suite its own test database so local runs
    stop truncating the dev database, split the CI job so failures
    name their suite, quarantine flaky specs with a 14-day expiry,
    and make the real suite a required check only after a green
    streak. Unblocks plan 30's gate.

> **Groq cannot embed, and Bedrock is not in the default region.** Groq exposes no embedding
> models at all, so 12 adds AWS Bedrock alongside it — and the account's configured region
> (`us-west-1`) carries only one embedding model against us-west-2's five. Both verified
> live; see 12.

> **The pipeline shipped as six stages, not four.** `fetch` split into
> `fetch` → `extract-text`, and `validate` was added between extraction and publishing.
> Phases 07–09 above describe the four-stage shape and are kept as the reasoning that led
> here; `CLAUDE.md` describes what actually runs.

## Locked decisions

Do not relitigate without discussion.

- **Monorepo tooling: npm workspaces, with Nx as a package-based task runner.** Nx does _not_
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
  writes into the _same_ database, adding its own tables. No second datastore, and no API hop
  between the workers and the map.
- **ORM: TypeORM, for both entities and migrations.** No Prisma — the State Affairs
  Prisma-schema-plus-hand-mirrored-entities split is not carried over. One tool owns the
  `ingest_*` tables. `synchronize` stays `false` in every environment. See
  [03-database-layer.md](./03-database-layer.md).
- ~~**No object storage.**~~ **Reversed.** The original reasoning — `fetch` produces tens of
  KB of text, so a Postgres column suffices — held only while text extraction lived inside
  `fetch`. Once the two split, keeping the original bytes is what makes re-extraction
  possible without re-downloading, and cleaning rules change constantly. MinIO/S3 now holds
  originals and text artifacts; `StorageService`/`STORAGE_SERVICE` exists. The preference did
  not change, the reasoning did. Retaining the artifacts is also what makes
  [14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md) possible at all.
- **Extraction runs behind an `ExtractionEngine` interface and an `EXTRACTION_ENGINE` DI
  token**, so the engine is swappable without touching the worker, the queue contract, or
  storage. **The engine shipped as Groq** (`openai/gpt-oss-120b`), not the Claude API as
  phase 8 assumed — the interface is what was locked, and it did its job. Measured findings
  in `CLAUDE.md` ("Groq, measured"). Groq exposes **no embedding models**, which is why
  [12-embeddings-and-bedrock.md](./12-embeddings-and-bedrock.md) adds Bedrock beside it
  rather than replacing it.
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
