# Event detail pages and search indexing

**Related:** [31-shareable-map-state.md](./31-shareable-map-state.md)
(shareable links resolve to map state, but there is no page behind them),
[37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md) (merge,
split, and tombstone semantics this plan renders as HTTP statuses),
[32-fuzzy-dates.md](./32-fuzzy-dates.md) (date display and bounds on the
page), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md)
(what text the page may show and how sources are credited),
[36-geoparsing-place-disambiguation.md](./36-geoparsing-place-disambiguation.md)
(the pin the page links back to), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md)
(the map the page links into),
[25-product-backlog.md](./25-product-backlog.md) (step 14, open questions
24-26).

**Changelog:**
- 2026-11-01 - Created from the daily research loop. No plan owned the
  standalone page for a published event: plan 31 gives the map shareable
  URLs, but a shared link, a search result, or an AI crawler lands on a
  client-rendered OpenLayers map whose popup content is not indexable
  HTML. This plan adds one server-rendered page per published event,
  plus the sitemap and robots rules that make the corpus crawlable,
  without inventing a second content store.

## Why this plan exists

Today the only way to see an event is the `/map` client. That has three
consequences, all reachable from the existing backlog:

- **Nothing to link to.** Plan 31 deep links carry viewport, timeline
  window, and selected-event state, but they are map state, not a page
  about an event. A link pasted into chat, a citation, or a search
  result has no stable, readable target.
- **Nothing to index.** Search engines and AI crawlers read the HTML
  the server sends, not the page after hydration. Popup text fetched
  client-side from Postgres is effectively invisible to them, so the
  corpus earns no search presence no matter how good ingestion gets.
- **Nothing honest for removed events.** Plan 37 tombstones and splits
  need a public face: a merged slug must redirect, a deleted event must
  say it is gone, a split must explain itself. Without detail pages,
  those lifecycle states have no URL to attach to, and plan 31 links
  degrade to "graceful degradation" with nowhere graceful to go.

This plan is deliberately narrow. It does not redesign the map, the
search UI (plans 19-24), or publish (plan 09). It adds a read-only
page per published event, rendered from the same Postgres database the
map already reads through `lib/postgres-storage.ts` - no API hop, no
second datastore, per the locked decision in `00-README.md`.

## URL and slug design

- Route: `app/events/[slug]/page.tsx`. One event, one canonical URL.
- Slug: a stable `slug` column on the published event, assigned at
  publish time, human-readable, and never regenerated on later edits.
  A title correction must not break every link ever shared. Suggested
  shape, for James to confirm (open question 24): a date-prefixed
  slug such as `1847-07-24-pioneers-enter-salt-lake-valley` - the date
  prefix keeps slugs unique across same-named events (two battles, two
  treaties) without a numeric suffix, and it reads sensibly in a URL.
  If the date itself is later corrected (plan 37 date correction), the
  slug still does not change; the page shows the corrected date.
- Slug history: every superseded slug is kept in a `slug_history`
  table mapping old slug to current slug (or to a lifecycle state, see
  below). Redirects resolve in one hop: an old slug points straight at
  the final canonical slug, never through a chain, and the chain is
  rewritten when a later merge supersedes an earlier one.
- IDs stay internal. The public URL uses the slug only; database IDs
  never appear in URLs, so a future datastore change does not break
  links.

## Page content

A detail page shows exactly what the map popup shows, plus what a
standalone page owes a reader - nothing more, and nothing the pipeline
does not already know:

- Title, date, and place. The date uses the plan 32 display string,
  including its uncertainty marker (circa, presumably, disputed), so a
  fuzzy event never looks precise on its own page. The place shows the
  plan 36 resolved name plus the pin coordinates.
- A short factual description, subject to plan 33: facts-only text, or
  share-alike text shown verbatim with its CC BY-SA credit - never
  silently adapted share-alike text, and never Britannica text at all.
  A Britannica link-only event (plan 28) shows its date, short factual
  identifier, and link back, and nothing else.
- A Sources line (plan 33): every contributing source with its link,
  as a union over merged assertions, identical in content to the popup
  line so the page and the map never disagree.
- A "View on map" link that opens `/map` with the plan 31 parameters
  (viewport centred on the pin, timeline window around the event,
  event selected), so the page and the map are two views of one record.
- Related events: same place, nearby in time, and shared people where
  plans 19-24 provide them. Cap the list (v1: 8) and link each by slug.
  Related events are a navigation aid, not a recommendation engine;
  no scoring model is in scope.
- No comments, no editing UI, no user accounts. The page is read-only;
  corrections flow through the pipeline and plan 34 review, never
  through the page itself.

## Rendering and cache invalidation

- v1: server-rendered on request (a Next.js Server Component reading
  Postgres directly), with on-demand cache invalidation, not
  build-time static generation. Rationale: the corpus will grow by
  ingestion sweeps, and plan 37 re-publishes change pages after they
  first render. A build-time `generateStaticParams` list goes stale on
  every sweep and makes build time grow with the corpus; dynamic
  rendering with `revalidateTag('events')` on publish, re-publish,
  merge, split, and tombstone stays correct without a rebuild. Revisit
  static prerendering only if measured page latency justifies it.
- Publish and lifecycle events call the same invalidation: a
  re-published event revalidates its page, a merged event revalidates
  both the survivor and the absorbed slug (which becomes a redirect),
  a tombstoned event revalidates its page into its gone state, and a
  split revalidates the old slug into its disambiguation state.
- No per-event image generation in v1. See Open Graph below.

## Metadata, Open Graph, and structured data

- `generateMetadata` per page: unique title (event title plus site
  name via a title template), a description written from the factual
  description (truncated, never keyword-stuffed), and
  `alternates.canonical` set to the event's own URL. The map page
  keeps its own canonical; v1 sets no cross-canonical between
  `/map?event=...` and `/events/<slug>`, and that decision is
  revisited only if duplicate-content reports appear.
- Open Graph: title, description, and a single static site-wide OG
  image in v1 (a map graphic, 1200x630). Per-event OG images (a map
  crop centred on the pin) are a stretch goal, not v1: they cost a
  render pipeline for a benefit that only shows in link unfurls, and
  the image must not embed copyrighted source text (open question 25).
- JSON-LD: one `schema.org/Event` block per page with `name`,
  `startDate`, and `location` (a `Place` with the resolved name), plus
  `description` matching the visible description exactly. Structured
  data must never claim more than the visible page: for fuzzy events
  (plan 32), `startDate` uses the nominal date at the precision the
  source actually supports (year, or year-month, when no day is
  known) and the visible text carries the circa/uncertain marker;
  never invent a day to fill the field. No `offers`, no
  `eventAttendanceMode` implying a bookable event, and no
  `eventStatus` claiming a future happening.
- Explicit non-goal: Google Event rich results. Those require a
  bookable, future, public event with a unique URL; a historical
  event is none of those. The JSON-LD exists so search engines and AI
  crawlers can parse what the page already says, not to chase a rich
  result the corpus cannot qualify for. Do not report rich-result
  eligibility as a success metric for this plan.

## Sitemap and robots

- `app/sitemap.ts` generated from the database, listing only
  canonical, published, indexable event URLs, each with `lastModified`
  taken from the plan 37 version timestamp (a real change time, not
  "now"). Merged slugs, tombstones, splits, and unpublished events
  are excluded; the sitemap must never list a URL that returns a
  redirect or an error.
- Scale rule, taken from sitemap convention: split into a sitemap
  index once the corpus approaches 50,000 URLs. At pilot scale this
  is a single file; the split is a stated threshold, not v1 work.
- `app/robots.ts`: allow `/events/`, disallow `/admin/` and `/api/`,
  and name the sitemap. Staging/preview deployments must not carry a
  blanket disallow into production, and production must not index a
  staging host: the robots output and the sitemap base URL both derive
  from the deployment's canonical host, never a hardcoded staging
  origin.

## Lifecycle states as HTTP statuses

This is where plan 37 becomes visible. Each state has exactly one
correct response, and soft 404s (a "not found" message with a 200) are
never acceptable:

| Event state | Response |
| ----------- | -------- |
| Published | 200, full page as above. |
| Merged into another event | 301 to the surviving canonical slug, in one hop. The absorbed slug stays in `slug_history` permanently. |
| Split into two or more events | 200 disambiguation page listing the successor events with links, explaining that this record was split. A split has no single successor, so a redirect to one of them would mislead; the disambiguation page is the honest target, and it is excluded from the sitemap. |
| Tombstoned (deleted, no successor) | 410 Gone with a short explanation and a link back to the map. 410, not 404: the removal is deliberate, and search engines drop the URL faster. |
| Purged after the tombstone window (plan 37, open question 22) | 410 as well, for as long as `slug_history` retains the slug. Once a slug is truly forgotten, it falls through to 404. |
| Never existed | 404. No redirect to the home page: a home-page redirect reads as a soft error and misleads the visitor. |

- Internal links are cleaned on lifecycle change: a merged or
  tombstoned event is removed from related-event lists and from the
  sitemap at the same time its status changes, so the site never links
  to its own redirects or gone pages except through `slug_history`.
- Plan 31 share links pointing at a merged or tombstoned event
  resolve to the same target as the slug: the map opens on the
  surviving event, or shows the gone-state notice, rather than
  silently dropping the selection.

## The curated seed and indexing

The 44 hand-curated events are slated for deletion (standing
directive, 2026-10-20), and detail pages must not build search equity
on pages that will be purged. Until retirement, curated-seed event
pages carry `robots: { index: false }` and are excluded from the
sitemap. Ingested events (from the plan 26 pilot onward) are indexed
normally. When the seed retires through plan 37, its slugs follow the
tombstone-then-purge row above, and the noindex period means no
indexed page suddenly becomes a 410.

## Acceptance criteria

- `curl` on a published event URL (no JavaScript) returns complete
  HTML containing the title, the plan 32 date display string, the
  Sources line, and the JSON-LD block, with matching content between
  the visible text and the structured data.
- A republished event's page shows the corrected field without a
  redeploy, via `revalidateTag` on the plan 37 re-publish path.
- Merged slug: single-hop 301 to the survivor. Split slug: 200
  disambiguation page listing all successors. Tombstoned slug: 410
  with a map link. Unknown slug: 404, never a home-page redirect and
  never a 200 with "not found" text.
- Sitemap contains only canonical published URLs with real
  `lastModified` values; a tombstoned or merged slug disappears from
  it on the same change that changes its status.
- Curated-seed pages render `noindex` and do not appear in the
  sitemap; pilot-ingested pages are indexed normally.
- Mocked E2E specs cover the detail page, the 301, the 410, and the
  disambiguation page. Real-backend specs for these routes land after
  plan 35 makes e2e-real a merge gate; this plan does not gate on the
  currently red suite.
- No Splink anywhere in this plan or its implementation. Dedup
  remains deterministic blocking plus Jev pairwise judging
  (2026-10-23 decision).

## Sequencing

Lands with the plan 26 pilot, after plans 31 and 37: it needs share
links to point at and lifecycle states to render. It is not a pilot
blocker in the way plans 34 and 36 are (the pilot can publish without
detail pages), so if pilot scope tightens, this plan slips behind
plans 26, 34, 36, and 37 without endangering the pilot itself.
