# Phase 3 — Database layer

Ingestion writes into **the Postgres the map already reads**, adding its own tables beside the
existing ones. No second datastore, no API hop between the workers and the map.

## Why one database

`lib/postgres-storage.ts` already reads map data from `POSTGRES_URL`, and
`app/map/page.tsx` already polls `/api/data/locations` every 5s to pick up out-of-band writes.
That polling loop was built for writes made through the MCP server — it does not care who
wrote them. **So the moment `publish` writes an event row, the map picks it up with no new
plumbing at all.** That is the strongest argument for sharing the database, and it costs
nothing: the deployed app is already on Postgres, and `docker-compose.yml` already runs PostGIS
locally.

## Tables

Ingestion-owned, prefixed to keep them visually distinct from the map tables:

| Table | Holds |
|---|---|
| `ingest_sources` | One row per publisher. `key` matches a `SourceAdapter.key`; `enabled` gates polling. |
| `ingest_documents` | One row per discovered document. Carries `DocumentStatus`, `external_id`, `url`, `etag`, `published_at`, attempt counters. |
| `ingest_extractions` | One row per extraction pass over a document — the model used, when, and the raw `ParsedEvent[]`. |

**The idempotency mechanism is `UNIQUE (source_id, external_id)` on `ingest_documents`.** Not
any control flow in the detect worker — the insert is `ON CONFLICT DO NOTHING`, and re-running
a detection pass is a no-op at the database level regardless of what the adapter returns. This
is the single most important line in the schema; everything else about "safe to invoke
repeatedly" follows from it.

`ingest_extractions` is separate from `ingest_documents` rather than a column on it so that
re-extracting a document under a better model is an insert, not a destructive update — the
prior extraction stays auditable, and a bad model run is revertible.

## Provenance is a product feature, not just plumbing

`HistoricalEvent.source` is already rendered on the map popup as a citation. Once events are
machine-extracted, a reader needs to know *which document* an event came from and *how
confident* the extraction was. Published events should carry a foreign key back to
`ingest_documents`, so the map can eventually link an event to its source document. Worth
designing the column in now even if nothing renders it in v1 — backfilling provenance after
the fact is not possible.

## Migration tooling — decide in the phase discussion

State Affairs used **Prisma Migrate for the schema plus hand-mirrored TypeORM entities as the
query layer**, deliberately, with no codegen bridge. That is a defensible tradeoff there and
was well documented.

It is likely the wrong call here, for one specific reason: this repo's existing Postgres access
(`lib/postgres-storage.ts`) uses the **`postgres`** library — plain tagged-template SQL, no ORM
— and the schema those queries read is created on demand by `ensureSchema()`. Introducing two
*more* schema tools alongside that gives one database three sources of truth about its shape.

Options, in the order I'd argue for them:

1. **Plain SQL migrations** run by a small runner, with `postgres` as the query layer in the
   workers too. One library, one dialect, consistent with what the repo already does. The
   `db/martin-functions.sql` precedent shows raw SQL is already a normal artifact here.
2. **Prisma Migrate + TypeORM entities** — the State Affairs shape. Better DX for schema
   evolution and a genuinely nicer NestJS query layer, at the cost of a third and fourth tool
   over one database.
3. TypeORM alone — migrations and entities from one tool, but its migration DX is the thing
   State Affairs moved off in the first place.

Recommendation: **option 1**, and fold the existing `ensureSchema()` into the same migration
set so the whole database has one owner. This is the biggest open decision in the plan and
deserves an explicit call before phase 3 starts.
