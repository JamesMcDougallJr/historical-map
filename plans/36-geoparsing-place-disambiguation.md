# Geoparsing and place disambiguation for the publish stage

**Related:** [09-publish-worker.md](./09-publish-worker.md) (the stage this
plan fills in), [08-extract-worker.md](./08-extract-worker.md) (place strings
come from extraction), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (first
consumer), [29-source-expansion-dedup.md](./29-source-expansion-dedup.md)
(source #3 ships no coordinates), [32-fuzzy-dates.md](./32-fuzzy-dates.md)
(EDTF bounds feed the temporal check),
[33-source-licensing-attribution.md](./33-source-licensing-attribution.md)
(every gazetteer result carries a license),
[34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md)
(the uncertain band lands here), [13-similarity-and-fusion.md](./13-similarity-and-fusion.md)
(dedup blocking runs after resolution),
[30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (pins are only as good as
the coordinates behind them), [25-product-backlog.md](./25-product-backlog.md)
(step 6, open question 4).

**Changelog:**
- 2026-10-30 - Created from the daily research loop. No plan owned how a
  free-text place name becomes coordinates: plan 09 says "geocode, dedupe,
  write" and plan 29 names Muffinlabs as source #3, but Muffinlabs ships no
  coordinates at all, and many Wikidata places have no coordinate statement
  or only a historical name. This plan closes that gap before the pilot
  publishes anything it cannot place.

## Why this plan exists

A wrong pin is worse than no pin. A map that puts an event in Paris, Texas
when it happened in Paris, France teaches the user not to trust any pin,
and the error is invisible: the map still renders, the popup still reads
plausibly, nothing fails. Geoparsing errors are silent, so the stage that
produces coordinates needs explicit confidence bands and an abstain path,
not a best-effort lookup that always returns something.

Two concrete triggers, both already on the backlog:

- Plan 26 (Wikidata, GLOBAL): many Wikidata items carry coordinates
  (P625), but many do not, and many carry a historical name ("Constantinople")
  rather than the modern one. Pass-through of P625 covers only part of the
  pilot.
- Plan 29 (Muffinlabs, source #3): the feed ships date + text and no
  coordinates whatsoever. Without a resolver, source #3 cannot publish a
  single event, and the "first real geoparsing test" the backlog promises
  has no design to run against.

The existing tooling landscape shapes the design in one important way:
the mature open geoparsers (Mordecai, the Edinburgh Geoparser, the Irchel
geoparser library on PyPI) are Python. The ingest service is TypeScript/Nest
(plan 02). Importing a Python runtime into the publish stage to get NER
quality the pipeline does not need would complicate plan 10 deployment for
no gain, because recognition is already done: plan 08's extraction outputs
a place string plus source context. This plan therefore covers resolution
only, implemented as TypeScript HTTP clients against gazetteer APIs, and
treats the Python libraries as evaluation references, not runtime
dependencies. If James later wants spaCy-grade recognition over raw source
text, that is a separate sidecar decision, not something smuggled in here.

## The two stages, kept separate

Geoparsing is two jobs, and the pipeline already does the first:

1. **Recognition** - find place names in text. Done by plan 08 extraction:
   the `ParsedEvent` carries a free-text place name and the surrounding
   source context (country or region hints when the source states them).
   Do not re-run NER here.
2. **Resolution** - decide which gazetteer entry that name refers to, and
   take its coordinates. This plan. It takes (place string, event date
   bounds from plan 32, source context) and returns (gazetteer id,
   coordinates, confidence, method, provenance) or an explicit abstention.

Keeping them separate is what makes the resolver testable: a gold set of
(place string, date, expected gazetteer id) exercises resolution alone,
without LLM extraction variance in the loop.

## The resolution cascade

Try in order; stop at the first confident match. Every step records its
method, so a published pin can always answer "which gazetteer said this,
and how sure were we".

1. **Structured pass-through.** If the source already supplies coordinates
   plus a gazetteer id (Wikidata P625, an OpenHistoricalMap geometry),
   use them, after checking the id still resolves in the local gazetteer
   mirror. A stale id falls through to step 2 instead of publishing a
   dead reference.
2. **Local gazetteer cache (Postgres, plan 03 tables).** A name index
   built from Wikidata, GeoNames, HistGeocoder, and WHG dumps: normalized
   name plus variant and historical names, feature type, admin hierarchy,
   `valid_from`/`valid_to`, population/prominence, and source license
   (plan 33 declarations apply per gazetteer row, not just per adapter).
   Most repeat names resolve here at zero external cost, which is the
   whole point of the cache: the pilot's second thousand events should
   cost far fewer API calls than its first hundred.
3. **WHG reconciliation API (live).** For cache misses, query the World
   Historical Gazetteer reconciliation endpoint, namespaced to the
   redistributable sources. WHG is the right fallback because it is an
   aggregator of variant names across centuries: one place, many names
   (Byzantion, Constantinople, Tsargrad, Istanbul) is exactly the case a
   modern-only gazetteer fails. Note the WHG v4 quirk found in research:
   some records answer 451 on entity fetch for license reasons yet remain
   fully searchable and reconcilable, so a 451 on fetch must not be read
   as "no such place"; reconciliation results plus coordinates are usable
   even when the full record is not redistributable, and the namespace is
   recorded in provenance.
4. **Public Nominatim, last resort only.** One request per second, single
   thread, an application-identifying User-Agent, results cached on first
   hit. The public Nominatim usage policy forbids bulk geocoding and
   client-side autocomplete, so this step is a trickle valve, not a
   pipeline: if misses exceed what 1 req/s can serve, the answer is a
   self-hosted Photon or Pelias instance (deferred, see open questions),
   never hammering the public API. OSM-derived coordinates carry ODbL
   obligations through plan 33's gate.
5. **LLM proposer, never authority.** When the cascade fails, Claude may
   propose candidate places with reasoning, but a proposal publishes only
   if it matches a gazetteer entry within tolerance. Raw LLM latitude and
   longitude are never stored as coordinates. The research case for this
   restriction is strong: GeoLLM/GPSBench evaluations find LLMs strong at
   country level but weak at city-level localization with systematic
   regional bias, and a 2026 local-search benchmark found 1 in 5 unsourced
   LLM place recommendations wrong, closed, or in the wrong neighborhood.
   An LLM is a good proposer of "did you mean X"; it is not a gazetteer.

## Disambiguation scoring

When a name has multiple candidates, score them on explicit signals, in
this priority order:

1. **Name similarity**, normalized and variant-aware (diacritics folded,
   historical variants from WHG/HistGeocoder count as matches, not
   near-misses).
2. **Feature-type match**: a city candidate beats a country candidate
   when the source context describes a city, and vice versa.
3. **Containment**: the candidate must sit inside the region or country
   the event context states, when one is stated. This is the highest-value
   signal in the whole plan. The WHG team's 1856-gazetteer experiment
   found name similarity alone routinely matches a same-named place on
   the far side of the planet when no containment polygon is available;
   containment is what prevents that class of error.
4. **Temporal validity**: the candidate must have existed at the event's
   date bounds (plan 32 EDTF interval). HistGeocoder's `valid_from`/
   `valid_to` is the model: a place founded after the event cannot be
   the referent, and a renamed place resolves through its variant name
   at the event date, not through its modern name alone.
5. **Prominence/population, last only.** Population breaks ties between
   otherwise equal candidates; it never outranks containment or temporal
   validity, or every "Paris" becomes Paris, France even when the context
   says Texas.

## Confidence bands and the abstain path

- **Auto-publish band** (top score above a high threshold, margin over
  the runner-up above a second threshold): publish with provenance.
- **Uncertain band** (a candidate exists but the margin is thin, or the
  temporal check is inconclusive): route to plan 34's review queue with
  the candidate list, scores, and source anchors. The reviewer picks or
  rejects; the decision is fingerprinted per plan 34.
- **Reject band** (no candidate, or every candidate fails containment or
  temporal validity): no pin. The event stays unpublished with its
  verbatim place string retained, so a later gazetteer refresh can retry
  resolution without re-running extraction. Publishing a low-confidence
  pin "to fill the map" is explicitly out: an empty spot on the map is
  honest, a wrong pin is not.

## Ordering against the other plans

- Lands with the plan 26 pilot: the pilot's adapter implements structured
  pass-through first and the cascade for the remainder, and the pilot's
  acceptance criteria gain a geoparsing accuracy line (below).
- Required before plan 29 source #3 publishes anything: Muffinlabs has
  no coordinates, so its adapter is cascade-only, and its overlap
  analysis against other sources is meaningless until its events have
  coordinates.
- Dedup blocking (plan 13, updated by plan 32 to interval overlap) runs
  after resolution, so blocking uses resolved coordinates plus EDTF
  intervals, not raw place strings.
- Plan 34's review queue must exist before the pilot publishes, per plan
  34 itself; this plan is the main producer of its uncertain band, which
  is another reason the two land together.

## Evaluation

A hand-checked gold set of about 100 place strings, weighted toward
ambiguity: same-name places in different countries, renamed places,
historical names, and places that no longer exist. Report two numbers,
not one: accuracy within 161 km (the standard geoparsing tolerance) on
the cases the resolver attempts, and the abstention rate. A resolver
that attempts 70, gets 68 right, and abstains on 30 beats one that
attempts 100 and gets 85 right with 15 confident errors on the public
map. The eval is a script run during development, not a CI gate: plan
35's merge gate is for the E2E suite, and this eval must not become a
second required check by accident.

## Non-goals

- Reverse geocoding (coordinates to place names); nothing in the pipeline
  needs it.
- Search autocomplete backed by Nominatim; the public usage policy
  forbids it, and plan 31's shareable state does not need it.
- Boundary polygons for every place; plan 29's OpenHistoricalMap layer
  covers historical geography as a layer, not per-event polygons.
- Re-running named-entity recognition over source text; plan 08 owns that.

## Acceptance criteria

- [ ] Publish stage implements the five-step cascade in order, with
  method + gazetteer id + score + temporal check recorded per location.
- [ ] Local gazetteer cache table exists with variant/historical names
  and valid_from/valid_to; repeat names resolve without external calls.
- [ ] WHG reconciliation fallback handles the 451-on-fetch quirk without
  treating it as "place not found".
- [ ] Public Nominatim calls are rate-limited to 1 req/s, single-threaded,
  cached, and never used for bulk backfill.
- [ ] No raw LLM coordinates reach a published event; LLM proposals are
  verified against a gazetteer entry first.
- [ ] Uncertain band routes to the plan 34 review queue with candidates
  and scores; reject band publishes nothing and retains the verbatim
  place string for retry.
- [ ] Gold-set eval reports accuracy-within-161km and abstention rate;
  pilot acceptance includes a geoparsing line.
- [ ] No Splink anywhere in this plan; dedup remains deterministic
  blocking plus Jev pairwise judging (settled 2026-10-23).
