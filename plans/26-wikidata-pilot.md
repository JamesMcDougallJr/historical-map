# Second source pilot — Wikidata as the first ingestion source

**Related:** [00-README.md](./00-README.md) (phases 05–09), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table; "start with Wikidata"), [11-identity-and-fusion.md](./11-identity-and-fusion.md) (the dedup gaps this pilot will hit), [12-embeddings-and-bedrock.md](./12-embeddings-and-bedrock.md) (judge engine), [14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md) (attribution plumbing), [25-product-backlog.md](./25-product-backlog.md) (product step #1: land the second source), [27-web-ingestor.md](./27-web-ingestor.md) (the HTTP fetcher this adapter uses).

**Changelog:**
- 2026-10-21 — Widened to **GLOBAL** scope per James, who explicitly rejected a
  Utah-only pilot on 2026-10-20. The 44 curated events are demoted to a transient
  spot-check set with a **deletion step** per his standing directive to eliminate
  them, not preserve them.

## Why this plan exists

Plan 05 named Wikidata the best first adapter on implementation-cost grounds; a
day of research sharpened the reasoning without changing the conclusion:

- **Precedent that Wikidata → events-around-a-place works.** Histropedia's
  Histrobot has been generating location-based timelines from Wikidata
  (geo-properties + date properties) for years, and hobbyist builders reproduce
  the pattern cheaply: pick the ~30 date-related properties, filter geo-search
  results on them, and you have a timeline. We get the same events *plus*
  pipeline ownership, provenance, and the fusion engine (plans 11–13) on top.
- **Wikidata arrives pre-geocoded.** Every in-scope item carries P625
  (coordinate location), so the pilot validates phases 06 (detect) through 09
  (publish) *without* the geocoder — exactly what 05 recommended, and doubly
  attractive while the publish-stage geocoder tiers are still being worked. The
  separate geocoder problem then stays isolated to the *text* sources, where
  **HistGeocoder** (histgeocoder.app), a public-domain gazetteer of GNIS +
  GeoNames + OSM + Wikidata that carries `valid_from`/`valid_to` so it can
  answer "did this place exist in 1906", should be evaluated as a tier in the
  geocoder work, not in this pilot.

Until a second source is live, the ingestion pipeline is unproven end to end
(the 44 events are all hand-curated or pasted via `/map/import`).

## The pilot query — small, but global

James rejected a Utah-only pilot, so the pilot is **global in scope** and stays
reviewable through the *event-class whitelist*, not geography:

- **Geography:** none — no P131 or bounding-box filter. Items anywhere with
  P625 pass.
- **Classes:** a whitelist of conflict/suffering/deliberate-act event classes
  (battle, siege, massacre, treaty-signing, earthquake, rail-link event …).
  **The exact class list is a code-review decision against the pilot run, not a
  plan-time guess** — expect 2–3 iterations between the whitelist and the review
  output.
- **Properties required:** P585 (point in time) or an equivalent date property,
  P625 (coordinate location), and a sitelink count or reference-present flag as
  a cheap quality gate (rejects drive-by items with no sources).
- **Volume guard:** a hard cap (e.g. 5,000 events) on the pilot run plus detect
  cursors, so the first global pull stays reviewable and re-runnable.

Without the Utah overlap, dedup gets validated differently: a **spot-check
harness** that takes a ~10-event sample of the 44 curated events and reports
whether the pilot's extracted set (and plan 11's dedup) finds the matches,
near-matches (same place, fuzzy date) and novelties — spot-check, not scoping
mechanism.

## Curated-set retirement

Standing directive from James (2026-10-20): **the 44 curated events are to be
eliminated, not preserved** — he has wanted them gone for a while. They exist
only transiently:

- During the pilot they serve as the spot-check set described above — a
  dedup/overlap test fixture while ingestion is validated.
- **Done-criterion addition:** once the pilot's spot-check passes, the curated
  seed is retired — the rows leave `data/map-data.json`, and the map serves
  pipeline-published output only. Keep a tiny snapshot
  (e.g. `data/curated-retired-2026-10-21.json`) purely as a test fixture for
  the spot-check harness, never as served map data.
- They are not a permanent golden set. Do not propose keeping them as one.

## Interface (per 05 — no orchestration changes)

One file implementing `SourceAdapter` from `packages/domain/src/ingestion.ts`
(`key: 'wikidata'`, attribution metadata included — the map already renders
attribution per layer per 14, and Wikidata's CC0 still deserves the credit),
plus one line in the factory array. Detect → fetch → extract → validate →
publish unchanged. Politeness per 05: identify the crawler in `User-Agent`
with a contact URL, stay well under published rate limits. Route HTTP traffic
through the [27 web ingestor](./27-web-ingestor.md)'s fetcher so politeness
and conditional-fetch come for free.

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
- **Spot-check harness, the pilot's real deliverable:** a script (run manually,
  not in CI) that joins the pilot's extracted events against the ~10-event
  curated sample and reports matches, near-matches (same place, fuzzy date)
  and novelties. Dedup must find the overlaps it should find without merging
  things that merely share a place name. Where matches hit
  [11's gaps](./11-identity-and-fusion.md), write the failure down — that list
  becomes the dedup work queue.
- **Confidence provenance:** uncertain readings explicitly flagged, not
  silently dropped. Wikidata rows with date granularity worse than a year, or
  coordinates below a precision threshold, should carry the low-confidence flag
  into the publish stage rather than being dropped at parse time — the same
  flag the geocoder tiers will need for text sources.

## Done when

- The adapter file + factory line exist; a **globally scoped** pilot query
  (class whitelist + volume cap) runs through detect → fetch → extract →
  validate → publish against a local Postgres with zero orchestration changes.
- The spot-check runs against the curated sample and its findings are recorded
  (the dedup work queue becomes a backlog item if the findings warrant it).
- The curated seed is retired per "Curated-set retirement" above.
- Fixtures are captured; the suite passes with no network access.
- No publish to production data yet — the pilot's output is reviewed against
  the spot-check first. The production-on decision is a separate call.

## Open to James (see chat summary)

- Is the class-whitelist approach the right bound for the global pilot, or do
  you want a stricter cap/first-N run?
- Keep the retired curated snapshot as a test fixture, or delete everything?
- Is HistGeocoder-style temporal validity worth a geocoder tier for the text
  sources (Chronicling America next)?
