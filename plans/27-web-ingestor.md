# Web ingestor — fetch sources over HTTP, not just PDFs

**Related:** [00-README.md](./00-README.md) (six-stage pipeline), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table), [07-fetch-worker.md](./07-fetch-worker.md) (fetch stage), [25-product-backlog.md](./25-product-backlog.md) (backlog step: build web ingest), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (first adapter routes through this fetcher).

## Why this plan exists

Standing directive from James (2026-10-20): the ingestion pipeline must not be
PDF-only, and sources must be pulled directly over the web. Today `fetch` is
PDF-first by construction — the shipped six-stage shape has fetch →
extract-text, and plan 05's candidate-source table leans on documents you
download and parse. A curl/HTTP ingestor generalizes fetch into a
content-type-aware retrieval stage so JSON APIs, HTML pages, sitemaps, and
text endpoints are first-class. This is the precondition for most of the new
sources below; without it every new adapter starts by reinventing politeness,
retries, and HTML stripping.

## Design

A single `HttpFetcher` in `services/ingest`, behind a DI token so the fetch
worker's contract and the workers' deployment (plan 10) stay untouched. Given
a URL it returns `{ bytes, contentType, finalUrl, etag, lastModified,
fetchedAt }`:

- **Politeness:** identifying `User-Agent` with a contact URL, per-host rate
  limits, `robots.txt` honoring for crawl-style sources, exponential backoff on
  429/5xx.
- **Conditional requests:** send `If-None-Match`/`If-Modified-Since`; a 304
  response keeps detect idempotent (no new job queued, no bytes wasted).
- **Redirects:** follow with a hop cap; record `finalUrl` for dedup and for
  plan 14's "view the source" attribution links.
- **Safety:** timeouts and a per-response byte cap; never fetch user-supplied
  URLs in a privileged network (this fetcher talks to allowlisted
  source-hosts only).
- **Content routing** after fetch:
  - `application/json` (SlashYear, Wikidata, DPLA…) → parse directly;
  - `text/html` → readability-style extraction: strip nav/chrome/boilerplate,
    keep article text (this is what unlocks historical-site pages, Wikipedia
    "On this day", exhibition pages);
  - `text/plain`, XML/RSS/Atom, IIIF text endpoints → pass through;
  - `application/pdf` → existing unpdf path unchanged.
- **No JS rendering in v1.** Sources that require a headless browser are out
  of scope; record them as candidates for a later Playwright-backed tier.
  None of today's new sources need it.
- **Discovery:** `sitemap.xml` and `Link: <…>; rel=…` response headers as cheap
  discovery surfaces for crawl-style sources; RSS/Atom feeds where published.

`SourceAdapter.fetch` gets an optional `http` handle so adapters — including
the Wikidata pilot's per-event retrieval model — issue requests through the
fetcher and inherit politeness and conditional-fetch for free. Document the
adapter-side choice from plan 26's "decisions" note in the same place.

## New sources this unlocks (research 2026-10-21)

| Source | What it offers | Access |
|---|---|---|
| **SlashYear** | dated historical events as JSON, each quoted from a cited Wikipedia revision | no signup, HTTPS |
| Wikidata Query Service | structured events, global | HTTP, rate-limited |
| Wikipedia REST API / "On this day" | per-day events, births, deaths | HTTP |
| Chronicling America (LOC) | newspaper OCR as JSON | HTTP |
| loc.gov JSON API | millions of Library of Congress items with metadata | HTTP |
| DPLA API | 50M+ digitized items from US institutions | free API key |
| Europeana API | European cultural heritage | free API key |
| NYT Article Search API | 1851–present articles | free API key, rate-limited |
| Internet Archive advancedsearch | texts, audio, video metadata | HTTP |

**Selection discipline per 05:** start with what arrives pre-structured and
pre-geocoded. SlashYear is the natural second adapter candidate after Wikidata
(JSON in, dates out, zero PDF parsing). Text-heavy sources (Chronicling
America, DPLA, LOC, NYT) go through the extract + geocoder path and land after
plan 26 proves the pipeline end to end.

## Testing

- Fixture-driven: recorded HTTP exchanges covering content-type sniffing, 304
  handling, redirect chains, and robots.txt denial — **no network in CI.**
- A manual `fetch:verify`-style script that *does* hit the network, for when a
  source endpoint is suspected of having changed.
- Politeness tests: per-host rate limiting enforced, robots.txt denial
  respected, allowlist rejects non-source hosts.

## Done when

- `HttpFetcher` + content router exist behind the DI token; the fetch worker's
  contract is unchanged.
- The Wikidata adapter's traffic routes through it with identical output to
  the direct calls (proves the harness is adapter-neutral).
- Fixtures captured; suite green with no network access.

## Open to James (see chat summary)

- SlashYear as the second adapter after Wikidata — agree?
- Free-API-key sources (DPLA, Europeana, NYT): acceptable, or keys-free only?
- JS-rendered sources deferred to a later tier — any candidate that needs it
  urgently?
