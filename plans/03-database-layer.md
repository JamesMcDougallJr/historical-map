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

## Migration tooling — **decided: TypeORM, for everything**

**No Prisma.** TypeORM owns both halves: entities are the query layer, and TypeORM migrations
own the schema. One tool, one source of truth about the ingestion tables' shape.

This drops the State Affairs arrangement — Prisma Migrate for the schema plus hand-mirrored
TypeORM entities, with no codegen bridge between them. That existed because Prisma's migration
DX is better than TypeORM's; the cost was two tools describing one database and a hand-sync
obligation between them. Given this repo already has its own schema owner (below), adding a
fourth tool to the pile was the wrong trade.

Concretely:

- Entities in `libs/database/src/entities/`, one per table, decorated as the query layer.
  TypeORM's repository pattern and query builder fit NestJS's DI well — that half of the State
  Affairs reasoning still holds.
- Migrations in `libs/database/src/migrations/`, generated with
  `typeorm migration:generate` and reviewed by hand before landing. Generated migrations are a
  starting point, not an artifact to trust unread — check the diff for accidental drops.
- **`synchronize` is `false`. Always, in every environment.** It is the single most dangerous
  TypeORM setting; it will silently drop columns to make the database match the entities.
  Migrations are the only way the schema changes.

### Boundary with the existing schema owner

`lib/postgres-storage.ts` (the web app) uses the **`postgres`** library — plain tagged-template
SQL — and creates its tables on demand via `ensureSchema()`. That does not change in this
phase.

So the split is: **TypeORM owns the `ingest_*` tables; `ensureSchema()` keeps owning the map
tables.** One database, two owners, but with a clean table-level boundary rather than two tools
fighting over the same tables — which is the failure mode actually worth avoiding.

The consequence to keep in view: when `publish` (phase 9) writes events into the *map* tables,
it is writing to tables TypeORM does not own. Either give `publish` entities for them
explicitly declared as read/write-but-not-migrated (TypeORM can map an existing table without
managing it), or have `publish` call the same `postgres`-library path the web app uses. Settle
that in the phase 9 discussion — it does not block phase 3.

Folding the map tables into TypeORM migrations later is possible and would give the database a
single owner, but it means changing the deployed web app's storage layer. That is its own
deliberate change, not a rider on the ingestion work.
