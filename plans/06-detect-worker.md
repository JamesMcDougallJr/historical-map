# Phase 6 — `detect` worker

Polls each enabled source and records what is new. One BullMQ job = one source, so a network
blip against one archive cannot fail the pass for any other.

## Flow

1. Resolve `job.data.sourceKey` → an `ingest_sources` row where `enabled = true`.
2. Find the adapter whose `key` matches.
3. `SELECT external_id FROM ingest_documents WHERE source_id = ?` → `knownExternalIds`.
4. `adapter.fetchAvailableDocuments(knownExternalIds)`, filtered by the lookback window.
5. One multi-row `INSERT ... ON CONFLICT (source_id, external_id) DO NOTHING`.
6. Enqueue a `fetch` job for each row that actually landed.

## Guard rails carried over from State Affairs

Three of these are non-obvious and were each found the hard way:

- **Guard against a missing `sourceKey`.** A query builder given `where: { key: undefined }`
  can drop the condition entirely rather than matching NULL — an unguarded call silently
  processes whichever source the database returns first. Only reachable via a stale scheduler
  entry or a malformed manual enqueue, but the failure is silent and wrong, which is the worst
  kind.
- **Drift is a log-and-skip, never a throw.** A source row with no matching adapter, or an
  adapter with no row, means code and database disagree — normal during a deploy. Failing the
  job would burn retries on a condition retrying cannot fix.
- **Only the rows that landed get a `fetch` job.** `ON CONFLICT DO NOTHING` skips duplicates,
  but a query builder's `identifiers` array is typically **padded with `null` at the position
  of each skipped row rather than pre-compacted** — filter it before enqueueing, or every
  detection pass re-enqueues the entire back catalogue.

## Lookback window

`DETECTION_LOOKBACK_DAYS` bounds how far back a pass considers, overridable per job so a
one-off backfill can widen it via the API without touching config.

**The right default is very different from State Affairs' 60 days.** That number scoped
"the last 1–2 months of hearings." Here the interesting corpus is centuries wide, and the
relevant date is when the *document* was published to the archive, not when the *event*
happened — an 1847 event can appear in a document catalogued last Tuesday. Filter on
`DiscoveredDocument.publishedAt`, and treat a source with no publication dates as "no lookback
filter" rather than "everything is too old."

Initial backfill and steady-state polling therefore want different windows: a wide one once,
then a narrow one daily.

## Observability

The dual-transport `JobLogger` from State Affairs earns its place here — every lifecycle step
mirrored to both the console and BullMQ's `job.log()`, so a queue dashboard's per-job Logs
panel is never empty. Debugging "why did this event not appear on the map" means tracing one
document across four queues; per-job logs are what make that possible without correlating
timestamps across four containers.

`@OnWorkerEvent('failed')` fires only once BullMQ has exhausted the configured attempts, not on
every transient failure. `detect` has no single row to flip to `failed` (a tick spans a whole
source), so its handler is structured logging only.
