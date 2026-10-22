# Britannica "On This Day" - link-only source adapter

**Related:** [00-README.md](./00-README.md) (phases 05-09), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table), [14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md) (attribution plumbing), [25-product-backlog.md](./25-product-backlog.md) (product step), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (coordinate-enrichment option), [27-web-ingestor.md](./27-web-ingestor.md) (the HTTP fetcher this adapter uses).

**Changelog:**
- 2026-10-22 - Created from the 2026-10-21 standing directive (James approved
  Britannica as a LINK-ONLY source). Corrects the earlier "JS-heavy" note: the
  day-page content is server-rendered (verified live 2026-10-22); only the
  date-picker navigation is JS.

## Why this plan exists

Standing directive from James (2026-10-21): Britannica's "On This Day"
(britannica.com/on-this-day) is an approved ingest source, LINK-ONLY. Ingest
may store an event's date, a short factual identifier, and a link back - never
its copyrighted text.

What Britannica buys the map: editorial curation. Wikidata (plan 26) gives
exhaustive structured events with coordinates; Britannica's editors pick the
~10 items per day they consider worth knowing ("Sam Houston becomes the George
Washington of Texas", "Cuban missile crisis", featured biographies like Franz
Liszt). One source selects, the other geocodes.

## Research findings (verified live 2026-10-22)

- The day page is server-rendered HTML: year, headline, short blurb, READ MORE
  link, and image all arrive without JS (checked on the October 22 page). The
  "JS-heavy" caveat from 2026-10-21 applies to the date-picker navigation, not
  the content - a curl fetcher gets the content fine, and plan 27's
  readability-style HTML path is not even needed for the fields we keep.
- robots.txt allows crawling /on-this-day (only /search and /cdn-cgi/ are
  disallowed). A sitemap index exists at /bps-ssl-gsm-index.xml (topic /
  biography / video sitemaps; no dedicated on-this-day sitemap spotted).
- Per-date discovery is the one open fetch question: scan the sitemaps for
  on-this-day URLs, or find the date-picker's data endpoint. The main page
  shows per-day content (today: October 22), which implies date-scoped pages
  exist.

## Design

One `SourceAdapter` file per 05 (`key: 'britannica-otd'`), routing HTTP through
plan 27's `HttpFetcher` so politeness and conditional fetch come free.

- **detect:** enumerate the 366 date pages once (discovery strategy above,
  documented in the adapter), then re-verify quarterly, not daily. This is
  stable editorial content, not a firehose; conditional fetch
  (ETag/Last-Modified) makes re-verification nearly free. Deterministic job IDs
  per date page per 04.
- **extract:** per date page, one record per item: `{ month_day, year,
  headline, source_url, fetched_at }`. `headline` is a short factual identifier
  (the page's own headline, e.g. "WikiLeaks releases thousands of U.S.
  documents relating to the wars in Iraq and Afghanistan"), capped at ~120
  chars. The blurb and article text are NEVER parsed or stored - dropped at
  parse time.
- **Copyright boundary:** headlines are short factual identifiers (facts are
  not copyrightable); everything expressive stays on Britannica's site behind
  the link. Schema guard: this source writes no body-text column. Add a test
  asserting a stored britannica-otd record contains only date/headline/url
  fields.
- **publish:** Britannica items carry no coordinates, so they cannot be pins
  on their own. Two options - James decides:
  - (a) Display-layer only: Britannica items appear as "further reading" links
    on date/event detail views, never as map pins. Cheapest, zero fusion risk.
  - (b) Coordinate enrichment: match headline + year against already-published
    Wikidata events (plan 26) and inherit their P625 coordinates. Britannica's
    curation does the selection, Wikidata does the geocoding. This exercises
    plans 11/13 fusion and makes Britannica the map's first editorial-ranking
    signal.
- **Attribution per 14:** every rendered link carries the Britannica source
  label and deep link (the map already renders attribution per layer).

## Testing

- Fixture-driven: recorded date-page HTML under the adapters' `__fixtures__/`;
  assert headline/year/url parse and the blurb never lands in the record (the
  guard test). No network in CI.
- A manual `britannica:verify`-style script that hits the network, for when
  the per-date URL pattern is suspected of having changed.

## Done when

- Adapter file + factory line exist; the 366 date pages are discovered through
  the documented strategy; fixture suite green with no network access; guard
  test passes.
- No publish to production data until the coordinate-enrichment question is
  answered (option (a) needs only a display slot; option (b) needs plan 26
  live first).

## Open to James (see chat summary)

- Coordinate enrichment via Wikidata matching (pins), or display-layer links
  only?
- Headline-only identifiers, or is there another field worth adding while
  staying link-only?
