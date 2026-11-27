# Public read API: let other people build on the map

**Related:** [00-README.md](./00-README.md) (phases 05-09), [19-search.md](./19-search.md) (lexical search), [25-product-backlog.md](./25-product-backlog.md) (product step #35), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, publish path), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (viewport + time-window query), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date model, EDTF display string), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (licence declarations, attribution, link-only), [34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md) (observability), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (stable slugs and ids), [43-public-read-surface-protection.md](./43-public-read-surface-protection.md) (rate limiting, caching, abuse protection), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (aggregate measurement), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands), [47-multilingual-events-i18n.md](./47-multilingual-events-i18n.md) (language fallback), [54-data-export.md](./54-data-export.md) (bulk snapshots), [55-embeddable-map-widget.md](./55-embeddable-map-widget.md) (browser embed), [56-on-this-day.md](./56-on-this-day.md) (daily feature), [58-confidence-provenance-display.md](./58-confidence-provenance-display.md) (certainty labels).

**Changelog:**
- 2026-11-22 — First version. Fills a gap no plan owned: the map has an internal read surface (`/api/data/*`), an agent surface (`mcp/`, `/api/mcp`), a bulk surface (plan 54 snapshots) and a browser surface (plan 55 embed), but no contract a third-party developer can build against. A researcher who wants "all published events in this bounding box in 1860-1870" today has two bad options: scrape the site, or download a monthly snapshot and filter it locally. This plan is the live, queryable middle.

## Why this plan exists

Every comparable product that treats its data as a public good exposes a read API, and the ones that do it well converge on the same small set of decisions:

- **World Historical Gazetteer** exposes an Entity API returning Linked Places Format JSON for places, datasets, collections, areas and periods, plus a read-only MCP server that needs no token at all. Its sharpest design decision is the one this plan borrows directly: when a source's terms do not permit redistribution, the API answers **451 Unavailable For Legal Reasons** — not 403. The constraint is on the *content*, not on the caller's permissions, and no token, tier or affiliation changes the answer. The response names the source and where to get the data under its own terms. A 451 is terminal for that identifier, a permanent property of the record's licence, not a transient error.
- **OpenHistoricalMap** splits its surface by job: an Overpass instance for selective queries, a Nominatim instance for name search, a REST API for raw element lookup, and daily planet files on S3 for bulk work — and tells high-volume users explicitly to use the planet files rather than hammer the query endpoints. The lesson for this map: the API and plan 54's snapshots are complements, not competitors, and the API should say so in its own docs.
- **The public-API shipping guides** (MakerHunt, TechConcepts, Touchstone) agree on the v1 shape: scope from three to five real jobs, not from database tables; prefixed API keys with read/write scopes; one consistent error format; clear rate limits with a 429 and a `Retry-After` header; cursor pagination from the start; URI versioning; an OpenAPI spec written *before* the implementation; and a quickstart that gets a developer from a new key to a first successful call in five minutes. A small API that never surprises anyone beats a big one that mirrors the whole database.

The map's own surfaces already imply the API's shape. Plan 30's viewport + time-window query is the list endpoint's filter set. Plan 32's display string is the only reader-facing date. Plan 33's licence declarations and link-only rule decide what a row may carry. Plan 38's stable slugs and ids are the resource identifiers. Plan 43's rate limiting and plan 44's aggregate analytics are the protection and measurement the API inherits rather than re-inventing. What no plan owned is the contract itself: the paths, the key model, the envelope, the versioning promise, and the line between the API and the surfaces that already exist.

## The v1 contract

### 1. Read-only, five endpoints, one envelope

- `GET /v1/events` — list published events. Filters: `bbox` (minLon,minLat,maxLon,maxLat), `from` / `to` (date window, EDTF level 0-1 accepted, interval-overlap semantics per plan 32), `q` (lexical search, plan 19), `band` (plan 46 significance band), `source` (source slug, plan 33), `place` (place id). Sort: `date` (sortable bounds) or `relevance` when `q` is present.
- `GET /v1/events/{id}` and `GET /v1/events/{slug}` — one event, full representation. The id is the stable published id; the slug is the plan 38 slug (with plan 38's slug-history 301 behaviour for renamed events).
- `GET /v1/places/{id}` — one place: names (plan 47 fallback chain, `lang` parameter), geometry, temporal validity, the events at it (as a link to a pre-filtered `/v1/events?place=` call, not an embedded list).
- `GET /v1/sources` — the plan 33 source registry: slug, licence (SPDX), attribution string, link-only flag, coverage note. This endpoint is the machine-readable form of the `/sources` page.
- `GET /v1/today` — the plan 56 daily set: today's events by the reader's date (same ranking, same top-10 + show-all shape).
- Every response uses one envelope: `{ "data": [...], "next_cursor": "..." | null }` for lists, `{ "data": {...} }` for single resources, and every event carries the same fields the site renders: stable `id` and `slug`, plan 32 `display_date` plus `date_start` / `date_end` bounds (never a bare midpoint), plan 58 certainty labels, plan 46 band, place with plan 36 resolution note, plan 33 licence + attribution, plan 48 image URL where one exists, and a `url` back to the plan 38 detail page. No internal fields leak: no ingest job ids, no dedup scores, no reviewer notes, no unpublished or tombstoned rows (plan 37).
- Pagination is cursor-based from day one (opaque cursor, `limit` default 50, max 200). Offset pagination is not offered: it degrades at depth and goes stale under concurrent publishes. Timestamps are RFC 3339 UTC. Field naming is camelCase, matching the web app's existing JSON.

### 2. Keys: prefixed, scoped, self-serve, revocable

- Keys are prefixed `hm_live_` (production) and `hm_test_` (sandbox against the same published rows, for integration tests), shown once at creation and never again, stored hashed, one key per integration with a human-readable name so revoking a leaked key breaks nothing else. Rotation and revocation are immediate and self-serve.
- Scope in v1 is a single scope: `read`. There is no write scope because there are no writes (see decision 6). A key is required for every call, including the free tier — this is the plan 43 decision, not a paywall: without a key there is no per-caller audit trail and no way to revoke a misbehaving caller without blocking everyone. Signup is an email address and nothing else; there is no approval queue and no human review of key requests. The free tier is generous by design (see decision 4) so the key requirement never reads as a gate.
- Keys are server-side credentials. They go in the `Authorization: Bearer <key>` header, never in a URL (they would leak into logs, browser history and referer headers). Browser-side use is explicitly unsupported: a web page that needs the map in a browser uses the plan 55 embed, not a key in client JavaScript. CORS is not opened for the API; a browser fetch with a key is a leaked key.
- The MCP server (`mcp/`, `/api/mcp`) stays the agent surface and stays keyless: it is the project's own agent interface, rate-limited by plan 43's anonymous tier, and it is not the public API. Where the MCP read tools and the public API overlap, both are thin clients over the same read layer — the API is the contract, the MCP tools consume it, so a fix to the read layer fixes both. The API does not re-implement search or retrieval; it exposes plan 19's lexical search and plan 30's query as HTTP.

### 3. Errors, limits and headers: one shape, on every response

- One error shape everywhere: `{ "error": { "code": "rate_limited", "message": "...", "retry_after": 30 } }`, with stable machine-readable codes (`bad_request`, `unauthorized`, `not_found`, `gone`, `unavailable_for_legal_reasons`, `rate_limited`, `too_large`) and human-readable messages. A 404 means the id does not exist; a 410 means it existed and was deliberately removed (plan 37 tombstone, plan 38 rule); a 451 means the record exists but its source terms forbid redistribution (decision 5).
- Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` so clients can self-throttle, and a 429 always carries `Retry-After`. Rate limiting is plan 43's Upstash sliding window, per key, with a lower per-endpoint ceiling on the expensive calls: the search-backed list (`q` present) and the bbox list are the costly paths; single-resource fetches are cheap.
- Default free-tier limits (a starting position, measured and tuned under plan 44, not a promise): 100 requests/minute per key, 10/minute on the search-backed list. There is no paid tier in v1 and no throttling by content — a key that stays inside its budget is never slowed for what it asks about.
- Versioning is in the URI (`/v1/...`). Additive changes (new fields, new optional parameters, new endpoints) never require a version bump. Breaking changes (removed or renamed fields, changed types, changed status-code semantics) always bump to `/v2` and the old version gets `Sunset` and `Deprecation` headers plus a published removal date at least six months out. Removing a version without notice destroys platform trust faster than any bug; the six-month floor is the commitment.

### 4. The contract is written before the code (OpenAPI-first)

- The OpenAPI 3.1 spec is the reviewable artifact: it is written and reviewed before implementation, it generates the docs, the mock server, and the client stubs, and it is the thing a coding agent implements against — not a prose description in this plan. The spec lives in the repo (`docs/api/openapi.yaml`), is versioned with the code, and is published at `/docs/api` (or the repo's docs host) alongside a five-minute quickstart: create a key, first `curl`, first filtered query, first error.
- The quickstart's bar is explicit: a developer goes from key creation to a first successful call in five minutes, and to a first *useful* call (a bbox + date-window query returning real events) in fifteen. If the quickstart takes longer, the API is not done. Usage is measured under plan 44 in aggregate only — keys created, first successful call, weekly active keys — never per-key content tracking.

### 5. Licensing travels with every row, and 451 is a content rule

- Every event and place in a response carries its plan 33 licence and attribution, and the response for a row whose source is link-only (plan 28 Britannica) carries the date, the short factual identifier and the link back — never the source text, exactly as the site does. Link-only stays link-only through the API; the API is not a way around the plan 33 rule.
- When a source's redistribution terms change after publish, the publish gate (plan 33) stops new rows and plan 37's lifecycle re-publishes the affected rows — and the API answers **451 Unavailable For Legal Reasons** for those identifiers, naming the source and where to obtain the data under its own terms, in WHG's pattern. The 451 is terminal for that identifier and is a property of the record's licence, not of the caller's key. A 451 is never an embargo, a takedown, or a sign the data is gone: the record stays searchable through the site's own surfaces where the terms allow, and stays reconcilable.
- The bulk counterpart is explicit in the API docs: for high-volume or whole-dataset work, use plan 54's monthly snapshots, not the API. The API is for live, selective queries; the snapshot is for bulk. A caller paginating through the whole dataset is politely pointed at the snapshot in the docs and, if they persist, in a `Link` header on deep cursors.

### 6. What v1 is not

- **No writes.** No `POST /v1/events`, no corrections endpoint, no suggestion endpoint. Corrections go through plan 39, suggestions through plan 53 — both human-reviewed flows that must not become unauthenticated write paths. A write API is a different product with a different abuse model; it is not smuggled into v1.
- **No OAuth, no user-delegated access.** There are no user accounts on the map (plan 52's anonymous owner token is the closest thing), so there is nothing to delegate. If accounts ever arrive, OAuth arrives with them, as a separate plan.
- **No GraphQL, no SDKs, no SLA.** REST + OpenAPI covers the v1 jobs; generated clients come from the spec if demand appears, and an SLA is a promise the project cannot keep before the plan 45 launch gate is passed. The docs say plainly what the availability target is *not*.
- **No anonymous tier in v1** (see open question 87): the key requirement is the audit and revocation mechanism, and the free tier is self-serve and ungated, so the key is a credential, not a barrier.

## Sequencing

Lands after the plan 26 pilot has published real rows (an API over the 44 curated events would be a demo, not a product), after plan 38 (stable ids and slugs are the resource identifiers), plan 33 (licence declarations are a publish-gate input to the API), plan 43 (the rate limiting it inherits) and plan 44 (the aggregate measurement it reports into). Before public launch (plan 45's launch gate includes the API's own checklist: spec published, quickstart timed, 451 behaviour tested, key revocation tested, snapshot pointer in the docs). Not a plan 26 pilot blocker: the pilot can publish without it, and the API is the first thing built on top of the pilot's published rows.

## Acceptance criteria

- [ ] OpenAPI 3.1 spec in the repo, reviewed before implementation; docs + mock server generated from it, not hand-written.
- [ ] All five endpoints live, returning the single envelope; cursor pagination on every list; `limit` capped at 200; no offset parameter exists.
- [ ] Keys: `hm_live_` / `hm_test_` prefixes, shown once, hashed at rest, named, revocable and rotatable self-serve; signup is an email address only, no approval queue.
- [ ] Error shape is identical across all five endpoints and all failure modes; 429 carries `Retry-After`; `X-RateLimit-*` headers on every response; 410 for tombstoned ids, 451 for non-redistributable records with the source named.
- [ ] Link-only rows (plan 28) return date + identifier + link only, verified by a test that requests a Britannica-sourced event and asserts no source text in the payload.
- [ ] Quickstart timed end-to-end: key to first successful call under five minutes, to first useful bbox + date-window query under fifteen.
- [ ] MCP read tools consume the same read layer as the API (dogfooding); a read-layer fix is verified in both surfaces.
- [ ] No anonymous access in v1; no write endpoints; no GraphQL; no SDKs; no SLA claim.
- [ ] No Splink anywhere in this plan's implementation or in any plan it references for this work (per the 2026-10-23 decision; dedup remains Jev pairwise judging per plans 11 and 13).

## Open questions for James

87. Key-required from day one, or an anonymous tier with a much lower limit (e.g. 10/minute, no search) for try-before-you-sign-up, accepting that anonymous abuse can only be handled by IP blocking?
88. Is the `q` search-backed list endpoint in v1, or does v1 ship list + filter only and search arrives with the plan 19 semantic search when it lands?
89. Per-key usage dashboard in v1 (each developer sees their own calls and limits), or aggregate-only measurement under plan 44 and no dashboard until someone asks for it?
