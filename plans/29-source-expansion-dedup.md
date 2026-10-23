# Source expansion pass and multi-source dedup

**Related:** [00-README.md](./00-README.md) (phases 05-09, 11, 13), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table), [11-identity-and-fusion.md](./11-identity-and-fusion.md) (dedup gaps), [13-similarity-and-fusion.md](./13-similarity-and-fusion.md) (vector search + LLM judge fusion), [25-product-backlog.md](./25-product-backlog.md) (product steps), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (source #2), [27-web-ingestor.md](./27-web-ingestor.md) (the HTTP fetcher), [28-britannica-link-only.md](./28-britannica-link-only.md) (link-only layer).

**Changelog:**
- 2026-10-23 - Created from the standing directives (2026-10-20: more ingest
  sources, curl/web ingestor; 2026-10-21: Britannica link-only). Catalogs three
  new concrete sources vetted 2026-10-23.
- 2026-10-23 - Dedup engine settled by James: **Jev** (TypeSafe AI decision
  model) makes the pairwise same-event calls, per plan 11's
  `JEV_PUBLISH_DEDUP_ENABLED` design and plan 13's judge stage, behind cheap
  deterministic blocking. The probabilistic-linkage engine previously
  considered for the scoring stage was removed at James's direction and is
  not part of the design.

## Why this plan exists

Plans 26 and 28 put two sources on the board (Wikidata, global; Britannica
On This Day, link-only). With sources 3 and 4 on the way, the next bottleneck
is not fetching - it is dedup: Wikidata, Britannica, and an on-this-day API
will all describe the same events (e.g. the Cuban missile crisis), and plan
11's gaps become real the day a second adapter lands. This plan picks the next
sources and the dedup tooling in one pass so the pipeline's third adapter
arrives with its identity story already written.

## New sources (vetted 2026-10-23)

All three route HTTP through plan 27's `HttpFetcher`; all fit the one-file
`SourceAdapter` shape from 05.

1. **Muffinlabs "Today in History" API** (history.muffinlabs.com) - keyless
   JSON: `/date` for today, `/date/{month}/{day}` for any day. Events, births,
   deaths with year, text, and Wikipedia link arrays, parsed from Wikipedia
   day-of-year pages. Free, no key. Caveats: no coordinates (needs geoparsing -
   WHG/HistGeocoder per below), and the data is Wikipedia-derived, so it sits
   in the CC BY-SA chain (attribute Wikipedia, keep no more text than the
   facts need). Recommendation: source #3. It is the cheapest adapter to write,
   it refreshes daily like a firehose-lite, and it pairs naturally with the
   Britannica link layer - editorial selection on one side, exhaustive daily
   coverage on the other.
2. **OpenHistoricalMap** (openhistoricalmap.org) - crowdsourced temporal map
   data, `start_date`/`end_date` on features, 4001 BCE to present, via REST
   API 0.6, an Overpass instance, daily planet dumps, and vector tiles.
   License CC0 (landmask layer ODbL). Caveat: sparse coverage outside cities,
   and it is historical *geography* (boundaries, places over time), not event
   narratives. Recommendation: not an event adapter - treat it as a
   boundary/timeslice layer and a names source for the geocoder tiers
   (plan 09), alongside HistGeocoder from plan 25.
3. **GDELT 2.0 raw data feed** (data.gdeltproject.org/gdeltv2) - global events
   1979-present coded from news in 100 languages, georeferenced, updated every
   15 minutes as zipped TSVs; master list at `gdeltv2/masterfilelist.txt`,
   also free in BigQuery. Free under GDELT ToS. Caveat: post-1979 only and
   news-coded (CAMEO taxonomy) - this is a modern-history freshness layer, not
   deep history. Recommendation: defer past source #4; when it lands, it needs
   a CAMEO-to-`ParsedEvent` mapping doc of its own.

Also noted but not recommended for now: API Ninjas Historical Events API
(free tier with a free key; fine for prototyping, verify terms for any
commercial use) and the Edinburgh Geoparser pipeline docs (a reference
architecture for the curl ingestor's geoparsing stage, not a tool to install).

## Dedup engine: Jev

The overlap problem (Britannica vs Wikidata vs Muffinlabs describing the same
event) is a pairwise same-event judgment problem. The engine is **Jev**
(TypeSafe AI's decision model), as already designed in plan 11
(`JEV_PUBLISH_DEDUP_ENABLED`) and plan 13's judge stage: deterministic
blocking first (place within 5 km + date), then a per-pair Jev "same event?"
call that returns a probability. High-confidence pairs merge, low-confidence
pairs stay separate, and the ambiguous middle is held for review (the
"Bosphore 1819" pattern from plan 26: uncertain readings flagged, not
silently dropped). Jev is not deterministic, so every pair decision is
cached and never re-asked. No separate probabilistic-linkage engine is used:
blocking is hand-rolled SQL/vector work, and Jev makes the calls.

## Gazetteer note: World Historical Gazetteer

**WHG v4** (docs.whgazetteer.org) adds a temporal gazetteer to the mix:
Linked Places model with time-bound attestations for names, geometries, and
classifications - it answers "what was this place called at time T", which is
HistGeocoder's problem from a different direction (WHG is the dataset/model,
HistGeocoder the consumer tool). Evaluate alongside HistGeocoder when plan
09's geocoder tiers get specified, per plan 25's product step 5. License:
CC BY 4.0 for contributed datasets - attribute in the data layer.

## Comparable products (2026-10-23 scan)

- **Bettermaps.ai/History** (bettermaps.ai/en/history) - the closest
  functional competitor for the event-on-map model: event-driven cartography,
  draggable timeline, per-event citations with BibTeX/Zotero export. SaaS.
- **Chronocon** (chronocon.org) - open-source *editor* for historical maps:
  time-stepped maps, events with markers organized into chains
  (geographic/thematic/multi-perspective). The closest content-authoring UX
  model to borrow from.
- **TimeAxis** (timeaxis.org) - horizontal draggable timeline with an AI
  "Wikipedia import" that parses any Wikipedia article URL into an ordered
  timeline. Reference for an LLM-event-extraction workflow in the ingestor.

## Sequencing

1. Plan 26 (Wikidata) validates the pipeline end to end - nothing here moves
   before that.
2. Source #3: Muffinlabs adapter. Exercises geoparsing (no coordinates) -
   the first real test of the plan 09 geocoder tiers.
3. Dedup work queue: wire Jev pairwise judging (plan 11's
   `JEV_PUBLISH_DEDUP_ENABLED`, plan 13's judge stage) behind the
   deterministic blocking rules before sources 3+4 overlap analysis runs.
4. Source #4: pick between GDELT (modern freshness) and a second text source;
   Britannica coordinate enrichment (plan 28, option b) is the first consumer
   of the dedup story.

## Testing

- Each new adapter: fixture-driven per 05 (recorded API responses under
  `__fixtures__/`; no network in CI), plus a manual `*:verify` network script.
- Dedup: a fixture set of intentionally overlapping events across
  Wikidata/Muffinlabs/Britannica-shaped records; assert the blocking + Jev
  pipeline merges true duplicates without merging
  same-place-different-event pairs, with cached pair decisions so reruns
  are stable.
- License guard tests: Muffinlabs records assert Wikipedia attribution is
  stored; Britannica guard test from plan 28 stays green.

## Done when

- Muffinlabs adapter file + factory line exist; daily `/date` fetch runs
  through plan 27's fetcher with fixtures green.
- Jev dedup evaluated against the overlap fixture set; the plan 13 design
  notes the blocking rules and the merge/hold/reject confidence thresholds.
- WHG evaluated as a geocoder-tier candidate alongside HistGeocoder; the
  decision recorded in plan 09's tier notes.
- 00-README index and plan 25 backlog reference this plan.

## Open to James (see chat summary)

- Source #3: Muffinlabs daily feed (needs geoparsing), or hold for a second
  structured source with coordinates?
- GDELT as the modern-history freshness layer: worth the CAMEO mapping work,
  or does the map stay pre-1979 deep history?
