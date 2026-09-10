# Phase 9 — `publish` worker · **Implemented**

Built as described, with the cross-source dedup deliberately **not** built: v1
dedupes only on the deterministic event id (same source + document + title +
date). "Bias toward under-merging" taken to its conclusion — a duplicate pin is
visible and fixable, a wrong merge silently destroys information, and matching
across sources needs real corpora to tune against.

The confidence gate writes rejects to `ingest_review_items` with a reason
rather than dropping them, because a gate whose rejects vanish is a silent
delete.

**Geocoding turned out to be the weakest link, demonstrated not theorised** —
see the note in CLAUDE.md. `geocode:review` is the mitigation the cache makes
cheap.

The stage with no State Affairs equivalent. Turns an `ExtractionResult` into rows the map
actually renders: geocode the place names, deduplicate against what already exists, write.

## Why it is its own stage

Extraction output is not map data. It has a place *name*, not coordinates, and it may describe
an event another source already published. Both remedies depend on external state — a geocoding
service and the existing corpus — and geocoders are rate-limited and go down.

Folding this into `extract` would mean a geocoder outage discards a completed, paid-for LLM
extraction. Split, the extraction is durable the moment it lands and `publish` retries against
it as long as it needs to.

## Geocoding

Resolve `placeName` → `[longitude, latitude]`.

- **Cache aggressively.** A `geocode_cache` table keyed on the normalised place string. Across
  a corpus the same handful of places recur constantly — "Salt Lake Valley" will appear
  hundreds of times and should be geocoded once.
- **Wikidata-sourced events skip this entirely** — they arrive with P625 coordinates. Another
  reason it is the right first adapter.
- **Historical place names are the hard part**, and this is where naive implementations
  quietly produce garbage. Places get renamed, borders move, and a modern geocoder confidently
  returns the *modern* place of that name — which may be hundreds of miles from where the 1847
  document meant. Prefer a gazetteer with historical coverage; where ambiguity is
  irreducible, record it rather than silently picking the first hit.
- **A failed geocode is not a failed event.** Keep the event with its place name and no
  coordinates rather than discarding it. `HistoricalLocation` requires coordinates, so such
  events need somewhere to live — a review queue is more useful than a silent drop.

## Deduplication

Multiple sources will describe the same event. The map should show it once, ideally citing all
of them.

Match on a similarity of (normalised title, date, proximity of coordinates) rather than exact
equality — two archives will not phrase a title identically. Tunable thresholds, and **bias
toward under-merging**: a duplicated pin is a visible, fixable annoyance; a wrongly merged pair
of distinct events silently destroys information and is near-impossible to detect afterwards.

Assign events to a `HistoricalLocation` by coordinate proximity, creating one when nothing is
near enough — the existing shape is location-with-nested-events, and this is what maintains it.

## Confidence gate

`ParsedEvent.confidence` gates publication. Below the threshold, an event goes to review rather
than to the map. Without this, one badly-OCR'd newspaper page can put a dozen hallucinated pins
in front of readers — and the map's whole value is being trustworthy about the past.

The gate needs a human surface to be meaningful. `/map/import` already has a review-and-edit UI
(`EventReviewList`, `EventEditModal`) built for exactly this shape of data. **Reuse it** rather
than building a second review screen; the import flow's "AI proposes, human approves" model is
the same interaction, sourced from a queue instead of a paste box.

## Writing

Write through the same tables `lib/postgres-storage.ts` reads. Because `app/map/page.tsx`
already polls `/api/data/locations` every 5s to pick up out-of-band writes, **a published event
appears on the map with no new plumbing** — that polling loop was built for MCP-server writes
and does not care who wrote them.

Set `sourceId` on every event so it lands in the right toggleable layer and renders its
source's attribution, and carry the `ingest_documents` foreign key for provenance (phase 3).
Ensure an `EventSource` row exists per adapter, populated from `SourceAdapter.metadata`.

**Caveat to verify before relying on the polling path:** that poll is gated on
`NEXT_PUBLIC_MAP_API_KEY` being set. If it is unset in the target deployment, ingested events
will not appear until reload. Check this early — it is a one-line config fix, but a confusing
hour if discovered while debugging the pipeline.
