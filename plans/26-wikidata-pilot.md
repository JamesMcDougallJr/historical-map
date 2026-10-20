# Second source pilot — Wikidata as the first ingestion source

**Related:** [00-README.md](./00-README.md) (phases 05–09), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table; "start with Wikidata"), [11-identity-and-fusion.md](./11-identity-and-fusion.md) (the dedup gaps this pilot will hit), [12-embeddings-and-bedrock.md](./12-embeddings-and-bedrock.md) (judge engine), [14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md) (attribution plumbing), [25-product-backlog.md](./25-product-backlog.md) (product step #1: land the second source).

## Why this plan exists

Plan 05 named Wikidata the best first adapter on implementation-cost grounds; a
day of research sharpened the reasoning without changing the conclusion:

- **Precedent that Wikidata → events-around-a-place works.** Histropedia's
  Histrobot has been generating location-based timelines from Wikidata
  (geo-properties + date properties) for years, and hobbyist builders (e.g. the
  calishat.com walkthrough) reproduce the pattern cheaply: pick the ~30
  date-related properties, filter geo-search results on them, and you have a
  timeline. We get the same events *plus* pipeline ownership, provenance, and
  the fusion engine (plans 11–13) on top.
- **Wikidata arrives pre-geocoded.** Every in-scope item carries P625
  (coordinate location), so the pilot validates phases 06 (detect) through 09
  (publish) *without* the geocoder — exactly what 05 recommended, and doubly
  attractive now that the publish-stage geocoder tiers are still being worked
  (PR #18). The separate geocoder problem then stays isolated to the *text*
  sources, where today's find — **HistGeocoder** (histgeocoder.app), a
  public-domain gazetteer of GNIS + GeoNames + OSM + Wikidata that carries
  `valid_from`/`valid_to` so it can answer "did this place exist in 1906" —
  should be evaluated as a tier in the geocoder work, not in this pilot.

Until a second source is live, the ingestion pipeline is unproven end to end
(the 44 events are all hand-curated or pasted via `/map/import`).

## The pilot query — deliberately small

Scope the first adapter to **one state and a whitelist of event classes**,
not "everything with P585 + P625 worldwide" (that includes millions of birth
and death items and will drown the review queue):

- **Geography:** items in Utah (via P131, administrative territorial entity,
  or a bounding-box filter on P625 — pick whichever keeps the query honest and
  document why).
- **Classes:** a whitelist of conflict/suffering/deliberate-act event classes
  relevant to the map's existing Utah corpus (battle, siege, massacre,
  treaty-signing, earthquake, rail-link event …). **The exact class list is a
  code-review decision against the pilot run, not a plan-time guess** — expect
  2–3 iterations between the whitelist and the review output.
- **Properties required:** P585 (point in time) or an equivalent date
  property, P625 (coordinate location), and a sitelink count or
  reference-present flag as a cheap quality gate (rejects drive-by items with
  no sources).

The Utah scope is a feature, not a limitation: it *maximally overlaps* the
44 hand-curated events, which makes the pilot the perfect stress test for
[11](./11-identity-and-fusion.md)'s gaps — the second document describing an
event the first already published. If dedup survives Utah, it survives the
world.

## Interface (per 05 — no orchestration changes)

One file implementing `SourceAdapter` from `packages/domain/src/ingestion.ts`
(`key: 'wikidata'`, attribution metadata included — the map already renders
attribution per layer per 14, and Wikidata's CC0 still deserves the credit),
plus one line in the factory array. Detect → fetch → extract → validate →
publish unchanged. Politeness per 05: identify the crawler in `User-Agent`
with a contact URL, stay well under published rate limits.

One genuine extension the pilot will settle: 05's `DiscoveredDocument[]` is a
per-document retrieval model; Wikidata is a per-*event* retrieval model
(the SPARQL row *is* the event). Options are (a) treat the query result page
as one document whose "extraction" is parsing the rows, or (b) give the
adapter a per-row `DiscoveredDocument`. **Pick (a) for the pilot** — it keeps
detect idempotency on the query+cursors and leaves 05's contract untouched;
note the choice and its cost (re-querying, not re-parsing) in the plan's
"decisions" section.

## Testing

- Fixture-driven per 05: capture a real SPARQL response under
  `libs/sources/src/adapters/__fixtures__/` (or the equivalent current path —
  verify against the repo; 05 predates the shipped six-stage shape) and assert
  it parses to the expected `DiscoveredDocument[]`. **No adapter test hits
  the network.**
- A manual `sources:verify`-style script that *does* hit the network, for
  when the endpoint is suspected of having changed.
- **Overlap analysis, the pilot's real deliverable:** a script (run manually,
  not in CI) that joins the pilot's extracted events against
  `data/map-data.json`'s 44 curated events and reports matches, near-matches
  (same place, fuzzy date) and novelties. The 44 curated events double as the
  **golden validation set**: dedup must find the overlaps it should find
  (battles already on the map) without merging things that merely share a
  place name. Where matches hit [11's gaps](./11-identity-and-fusion.md), write
  the failure down — that list becomes the dedup work queue.
- **Confidence provenance:** today's research (the Bosphore 1819 vintage-map
  project) reinforces a pattern worth adopting: uncertain readings explicitly
  flagged, not silently dropped. Wikidata rows with date granularity worse
  than a year, or coordinates below a precision threshold, should carry the
  low-confidence flag into the publish stage rather than being dropped at
  parse time — the same flag the geocoder tiers will need for text sources.

## Done when

- The adapter file + factory line exist; a Utah-scoped pilot query runs
  through detect → fetch → extract → validate → publish against a local
  Postgres with zero orchestration changes.
- The overlap analysis runs against `data/map-data.json` and its findings are
  recorded (plan 27 will be the dedup work queue if the findings warrant it).
- Fixtures are captured; the suite passes with no network access.
- No publish to production data yet — the pilot's output is reviewed against
  the golden set first. The production-on decision is a separate call.

## Open to James (see chat summary)

- Utah-only first, or a wider geography for the pilot?
- Does the hand-curated set stay as the permanent golden set, or get absorbed
  once ingestion is live?
- Where the geocoder tiers land matters to the *next* source (Chronicling
  America OCR) — is HistGeocoder-style temporal validity worth a tier?
