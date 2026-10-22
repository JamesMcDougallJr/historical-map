# Product backlog - next steps and bug fixes

Standing backlog of candidate product steps and bug fixes for historical-map,
maintained by the daily research loop. Coding agents: pick the top unclaimed
item; note your branch in the item when you start so two agents don't collide.

## What's there today

- The map at `/map` serves **44 hand-curated events across 34 locations from one
  source** (`utah-historical`, seeded from `data/map-data.json`). Everything was
  entered by hand or pasted through `/map/import`.
- Plans 01-24 design the ingestion engine (detect -> fetch -> extract -> publish)
  that replaces manual entry - a port of the State Affairs video pipeline.
- Latest on main (Oct 22): research-loop plans 25-27 added (Oct 20-21); plan 26
  (Wikidata pilot) widened to GLOBAL scope and the 44 curated events demoted to a
  transient spot-check set slated for deletion (Oct 21); PR #20 (search) and
  PR #12 (event sequences) still open; zero open issues.

## Bug fixes (triage first)

1. **Real-backend E2E suite red on main.** Observed Oct 19: the mocked E2E suite
   passes, the `e2e-real` suite fails after PR #19 (the S3 production-document
   change). Suspect the S3 change. Repro: run the `e2e-real` suite against main.
   Fix before it rots - a red real-backend suite masks every later regression.

## Product steps (ranked)

1. **Land the second source.** Wikidata pilot (plan 26), GLOBAL scope, is the
   named second source - it validates detect -> fetch -> extract -> validate ->
   publish end to end. The one-file-per-source `SourceAdapter` design should
   make this the proof point, not another infra plan.
2. **Timeline UX.** The Oct 19 commit moved the timeline and the map now opens
   on the whole world (Oct 14). With 44 events the map is navigable; at 4,400
   it won't be - clustering or density-aware zoom is the next UX cliff.
3. **Britannica "On This Day" link-only adapter (plan 28).** Editorial curation
   as a link layer: date + short factual identifier + link back, never the
   text. Pending James's call on coordinate enrichment via Wikidata matching.
4. **Retire the curated seed.** Once plan 26's spot-check passes, the 44 curated
   rows leave `data/map-data.json` (keep a snapshot as a test fixture only).
   Standing directive from James (2026-10-20) - do not re-propose keeping them.
5. **Geocoder: evaluate HistGeocoder as a temporal tier.** Confirmed live
   2026-10-22 at histgeocoder.app: Postgres-native, `valid_from`/`valid_to`
   ("did this place exist in 1906"), GNIS public-domain + GeoNames CC BY +
   Wikidata CC0 with the OSM layer switchable off. For the text sources, after
   plan 26 proves the pipeline.

## Open questions for James

1. Britannica: coordinate enrichment via Wikidata matching (pins), or
   display-layer links only?
2. Competitor check: Globe of History runs collector -> generator -> verifier
   (a verifier checks generated summaries against source anchors). Should our
   extract stage (plan 08) get a formal verify-against-source step, or is
   plan 14's RAG-with-citations the grounding story?
3. The red e2e-real suite (bug fix #1, since Oct 19): fix this week, or let it
   ride while ingestion work proceeds?
