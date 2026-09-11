# Phase 5 — Source adapters

**This is the depth area.** State Affairs' was "scale from 1 state to all 50"; here it is
"scale from 1 curated source to an arbitrary number of heterogeneous archives." The interface
is already defined in `packages/domain/src/ingestion.ts`:

```ts
interface SourceAdapter {
  readonly key: string;
  readonly metadata: { displayName: string; homepageUrl?: string; attribution?: string };
  fetchAvailableDocuments(knownExternalIds: Set<string>): Promise<DiscoveredDocument[]>;
}
```

**Adding a source is a new adapter file plus one line in a factory array.** Zero changes to the
detect worker, the queue contracts, or the API. No per-source branching anywhere in
orchestration code — that constraint is the whole point, and any PR that violates it should be
rejected on principle even when the branch would be smaller than the abstraction.

## Why this is harder than the State Affairs version

State Affairs had two adapters against two portals of the same *kind* — video archives with
listing pages. Here the sources are genuinely heterogeneous: a SPARQL endpoint, a REST search
API, a paginated HTML archive, and an OAI-PMH feed are four different retrieval models. The
interface holds because it deliberately says nothing about *how* discovery happens — only that
it yields `DiscoveredDocument[]`. Resist the temptation to add a `type: 'api' | 'html'`
discriminator; the moment orchestration can see the difference, the abstraction has leaked.

## Candidate sources

Ordered by implementation cost, which is roughly inverse to how much scraping is involved:

| Source | Access | Notes |
|---|---|---|
| **Wikidata** | SPARQL | Query events with both `point in time` (P585) and `coordinate location` (P625). Structured, licensed, and **arrives pre-geocoded** — the only source that skips phase 9's geocoding entirely. Best first adapter. |
| **Chronicling America** (LoC) | JSON API | Digitised newspapers, 1777–1963. Well-documented, stable, generous. OCR quality varies, which makes it a good stress test for extraction confidence. |
| **DPLA** | REST API | Aggregates many US archives, needs an API key. Broad coverage, uneven metadata. |
| **OpenHistoricalMap** | Overpass-like API | Geographic features with date ranges rather than events. May be a better fit for the *overlay* system than the event pipeline — worth checking before building. |
| **Utah Historical Society** | HTML | `historytogo.utah.gov` — the origin of the existing 44 curated events. Scraping is the last resort, not the first adapter. |

Start with **Wikidata**, because it exercises the whole pipeline end to end while being the
least likely to break, and because pre-geocoded output lets phases 6–9 be validated before the
geocoder is written.

## Politeness is a correctness constraint

Several of these are volunteer-run or public-good infrastructure, and unlike state government
video portals they will not absorb aggressive polling.

- Identify the crawler in a `User-Agent` with a contact URL.
- Honour `robots.txt` and any published rate limit; default to well under it.
- Send `If-None-Match`/`If-Modified-Since` from the stored `etag` so an unchanged document
  costs one 304 rather than a full transfer.
- Respect each source's licence in `EventSource.attribution` — the map already renders
  attribution per layer, so the plumbing exists. Some of these sources permit reuse only with
  credit, which makes attribution a licensing obligation, not a nicety.

## Testing

Fixture-driven, as in State Affairs (`libs/sources/src/adapters/__fixtures__/`). Each adapter
gets a captured real response and a test asserting it parses to the expected
`DiscoveredDocument[]`. **No adapter test hits the network** — that keeps the suite fast, makes
upstream format changes show up as a deliberate fixture update, and means CI does not hammer a
volunteer archive.

Pair each with a `sources:verify` script (State Affairs has one) that *does* hit the network,
run manually when a source is suspected of having changed.
