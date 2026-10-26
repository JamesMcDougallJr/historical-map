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
- Latest on main (Oct 26): plan 32 added (fuzzy dates: EDTF Level 1 date
  model with strict bounds and display string; Wikidata precision/circa
  mapping; fuzzy events as timeline spans) and plan 31 (shareable map state:
  deep links for viewport, timeline window, search, selected event) and plan 30
  (map UX at scale: OpenLayers clustering, density-aware zoom/default view,
  timeline semantic zoom, viewport + time-window fetching gated on e2e-real
  going green); plan 29 (source expansion pass, dedup settled as Jev pairwise
  judging 2026-10-23) and plan 28 (Britannica link-only adapter) and plan 26
  (Wikidata pilot, GLOBAL) on deck;
  PR #20 (search) and PR #12 (event sequences) still open; zero open issues.

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
2. **Map UX at scale (plan 30).** The Oct 19 commit moved the timeline and the
   map now opens on the whole world (Oct 14). With 44 events the map is
   navigable; at 4,400 it won't be - plan 30 covers clustering, density-aware
   zoom/default view, timeline semantic zoom, and viewport + time-window
   fetching (gated on e2e-real going green).
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
6. **Source #3 and the dedup story (plan 29).** Muffinlabs Today-in-History API
   (keyless JSON, daily refresh, CC BY-SA via Wikipedia) is the named third
   source - it forces the first real geoparsing test since it ships no
   coordinates. Before its overlap analysis runs, the dedup path is
   settled (2026-10-23): deterministic blocking plus Jev pairwise judging
   inside plan 13's vector + judge fusion, per plan 11's
   `JEV_PUBLISH_DEDUP_ENABLED` design. OpenHistoricalMap (CC0) lands as a
   boundary/historical-geography
   layer, not an event adapter; GDELT 2.0 stays deferred (post-1979 news
   coding, needs its own CAMEO mapping).
7. **Shareable map state (plan 31).** Deep links for viewport, timeline window,
   search query, and selected event (popup). URL is the single restorable
   state via replaceState + popstate; merged/deleted event ids degrade to the
   described view instead of erroring. Open Graph event previews as a stretch.

8. **Fuzzy dates (plan 32).** No source ships clean day-precision dates, so
   events get an EDTF Level 1 string plus strict start/end bounds plus a
   display string ("circa 1850", "Spring 1850") instead of a coerced fake
   day. Lands with the plan 26 pilot: its adapter implements the Wikidata
   precision/circa/earliest/latest mapping table, dedup blocking switches
   to interval overlap, and plan 30's timeline renders fuzzy events as
   spans with distinct uncertain markers.

## Open questions for James

1. Britannica: coordinate enrichment via Wikidata matching (pins), or
   display-layer links only?
2. Competitor check: Globe of History runs collector -> generator -> verifier
   (a verifier checks generated summaries against source anchors). Should our
   extract stage (plan 08) get a formal verify-against-source step, or is
   plan 14's RAG-with-citations the grounding story?
3. The red e2e-real suite (bug fix #1, since Oct 19): fix this week, or let it
   ride while ingestion work proceeds?
4. Source #3: Muffinlabs daily feed (needs geoparsing) first, or hold out for a
   second structured source that ships coordinates?
5. GDELT as a modern-history freshness layer: worth the CAMEO mapping work,
   or does the map stay pre-1979 deep history?
6. Fuzzy dates: show uncertainty on the map pin itself (hollow/dashed), or
   keep pins uniform and show it only in the popup?
7. Timeline filtering: interval intersection (a circa-1850 event shows in an
   1849-1851 window) or nominal-date only?
8. BCE scope: is pre-1 CE in scope for v1, or does the pilot clamp to CE
   dates and defer BCE handling?
