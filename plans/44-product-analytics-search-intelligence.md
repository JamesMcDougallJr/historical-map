# Product analytics and the search-intelligence loop

**Related:** [19-search.md](./19-search.md) (the search track whose
queries this plan measures - lexical, semantic, people, MCP),
[26-wikidata-pilot.md](./26-wikidata-pilot.md) and
[29-source-expansion-dedup.md](./29-source-expansion-dedup.md)
(zero-result queries are the demand signal that ranks the next
source to ingest),
[31-shareable-map-state.md](./31-shareable-map-state.md) (shared
links are the traffic this plan measures; referrer + `sequence`
params are the interesting dimensions),
[34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md)
(the pipeline's alerts and review queue - this plan is the
product-side counterpart, and its weekly zero-result review rides
the same cadence),
[38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md)
(detail pages are the most-visited surface once the sitemap
invites crawlers in; page-level analytics is how the map learns
which events people actually read),
[40-accessible-map-experience.md](./40-accessible-map-experience.md)
(the semantic event list is a second, keyboard-driven way to
reach events - analytics must count it, not only pin clicks),
[43-public-read-surface-protection.md](./43-public-read-surface-protection.md)
(the rate limiter and CDN cache sit in front of the same
endpoints this plan measures; server-side events must not trip
the limiter, and the WAF logs are the only record of the
crawlers JS analytics never sees),
[25-product-backlog.md](./25-product-backlog.md) (step 20, open
questions 42-44).

**Changelog:**
- 2026-11-07 - Created from the daily research loop. Plans 30-43
  build a public, crawlable, shareable map and a pipeline that
  decides what to ingest, but nothing owns learning from the
  readers once they arrive: no plan records which events get
  opened, which searches return nothing, or which journeys get
  finished. The pipeline picks sources on the team's guesses;
  the search box already knows what readers want. This plan is
  the measurement layer and the loop that feeds it back into
  ingestion - before launch, so the first real traffic is the
  first data, not the first guess.

## Why this plan exists

Three facts, none of which any existing plan covers:

- **The map will be flying blind at launch.** Plans 31 and 38
  make the map shareable and crawlable, plan 43 protects it from
  abuse, plan 34 watches the pipeline - and nobody watches the
  readers. Which events get opened, which searches fail, which
  journeys (plan 41) get finished and which get abandoned after
  step one: today there is no answer, and no plan to get one.
  Launching without it means the first month of real usage
  teaches nothing, and the backlog keeps ranking on guesses.
- **A failed search is the cheapest user research the map will
  ever get.** Every query that returns nothing is a reader
  stating, in their own words, what the map lacks - no survey,
  no interview, no prompt. The pattern is well documented
  elsewhere: the most useful view on a search-analytics page is
  a plain list of failed queries, and the most common mistake is
  reading every failure as a missing record. A zero-result query
  means one of four things, each with a different fix: the event
  genuinely is not in the corpus (a source-prioritisation
  signal); it exists under another name (a vocabulary / synonym
  problem for plan 13's fusion and plan 19's lexical search);
  it exists but the search cannot see it (a retrieval bug);
  or the reader filtered it out (a filter / UI problem, plan
  30's timeline window included). This plan records the query
  with its result count and filter context, and classifies it -
  it never sends a raw zero-result export straight to the
  ingestion backlog.
- **JavaScript analytics cannot see the crawlers, and crawlers
  are half the audience.** AI crawlers (GPTBot, ClaudeBot,
  PerplexityBot and friends) fetch pages without executing
  JavaScript, so no client-side tag ever records them - a blind
  spot that matters more for a content site than for an app,
  because whether those pages get crawled now decides whether
  they can be cited in AI answers later. The only record of
  them is server-side: plan 43's WAF logs and the Vercel /
  origin access logs. This plan pairs a cookieless client-side
  tool with a small server-side event log, so the two audiences
  are measured by the instrument that can actually see them.

## What ships

### 1. Two instruments, and why both

- **Layer 1 - aggregate web analytics, cookieless, no banner.**
  Plausible (cloud) is the default: no cookies, no persistent
  identifiers, visitors counted from a hash of IP + user agent
  + domain with a salt rotated daily, raw IPs never stored.
  The privacy posture is the point - a public history map has
  no reason to fingerprint readers, and a consent banner in
  front of the map would be the first thing a new reader sees.
  Setup is one script tag, or the `next-plausible` package.
  Alternatives, in order: Vercel Analytics (zero setup, lives
  where the app already runs, same cookieless aggregate shape)
  and self-hosted Umami (MIT, Postgres-backed, funnels and
  retention included, free apart from hosting - it runs on the
  Postgres the repo already has). PostHog is explicitly
  deferred: it is a product-analytics suite (funnels, replay,
  feature flags, experiments), it keeps an ID in a cookie plus
  localStorage by default so identified tracking and replay are
  consent-based, and self-hosting it is a ClickHouse + Kafka
  operation. The map does not need session replay or feature
  flags in v1; it needs to know which pages get read. Open
  question 42 asks James to pick among Plausible cloud,
  Vercel Analytics, and Umami - the plan does not assume it.
  Whichever is picked, the choice is recorded in the plan 33
  attribution / privacy surface: what is collected, why, and
  how to object.
- **Layer 2 - first-party product events, server-side, in
  Postgres.** The client-side tool answers "how many visitors,
  from where, to which pages". It cannot answer "what did they
  search for and did it work", because that needs the result
  count, and it cannot answer it for crawlers at all. So the
  search and map routes log their own events server-side, into
  a small `analytics_events` table in the same Postgres (no new
  datastore, per the locked decisions): `event_type`,
  `query_normalized`, `result_count`, `filters` (the plan 30
  time window, any facet), `referrer_kind` (direct, plan 31
  share link, plan 41 journey step, search engine), a
  `day_bucket` and a salted hash of the IP - no raw IP, no
  user agent string, no persistent ID. Raw rows live 90 days
  and are then aggregated and purged (open question 44 sets the
  final number). The table is append-only; nothing in it is
  ever shown to a reader, and nothing in it joins to a person.

### 2. What gets measured (the event list)

Small on purpose. Every event below is a question the backlog
needs answered, not a metric for its own sake:

| Event | Fields | Question it answers |
| ----- | ------ | ------------------- |
| `search` | normalized query, result count, search mode (lexical / semantic / hybrid), filters on | What are readers looking for, and what fraction finds nothing? |
| `search_zero_result` | same as `search`, plus whether a reformulation followed in the same session window | Which queries are real content gaps vs vocabulary vs retrieval misses? |
| `event_open` | event id (never the title in the raw row - join at query time), source (pin, plan 40 list, plan 38 detail page, plan 41 journey) | Which events get read, and through which surface? |
| `journey_step` / `journey_complete` | sequence id, step number, completed or abandoned | Do guided tours get finished, or abandoned after step one? (Plan 41's success metric.) |
| `detail_page_view` | slug, referrer kind | Which events do search engines actually send readers to? |
| `correction_submit` | reason class only, no submitter text | Does the plan 39 form get used, and for what? (Count only - the review queue holds the substance.) |

Deliberately **not** measured: pan / zoom / viewport moves
(plan 30's viewport fetching would drown the table in
interaction noise - sample those separately, or not at all,
in v1); scroll depth; anything that identifies a reader; any
free-text a reader typed outside the search box (plan 39's
submitter prose stays in the review queue and is never an
analytics row).

### 3. The zero-result loop (the part that changes the backlog)

Measurement without a loop is a dashboard nobody opens. The
loop runs weekly, on plan 34's review cadence, and has four
steps:

1. **Replay before judging.** A zero-result row is not yet a
   content gap. Re-run the query against the live index with
   the same filters and confirm it still returns nothing;
   check whether an event exists under another name (the
   vocabulary case) and whether the query was filtered out by
   a time window the reader set. A row that fails only in the
   typeahead dropdown but succeeds on the results page is a
   different bug - predictive interactions need their own
   observation path and are not folded into the results-page
   numbers.
2. **Classify.** Four buckets, each with a different owner:
   real gap (no event, no near match) -> source
   prioritisation, plans 26 / 29; vocabulary gap (exists under
   another name) -> synonyms / alias work in plan 19's lexical
   search and plan 13's fusion; retrieval miss (exists and
   should have matched) -> search bug, plan 19-24 track;
   filtered out -> plan 30 timeline / filter UX.
3. **Rank by demand, not by anecdote.** A query searched once
   is a curiosity; the same intent searched twenty times is a
   priority. Group by intent, not exact string ("Donner Party"
   and "donner party trek" are one demand). The ranked list is
   the input to the next source-expansion pass (plan 29), not a
   ticket per query.
4. **Close the loop visibly.** When a ranked gap gets covered
   by a new source or a vocabulary fix, the zero-result rate
   for that intent is the success metric - it should fall
   toward zero. A query that spikes suddenly to the top of the
   list usually means something changed (a new share link, a
   press mention) and the corpus has not caught up; treat a
   spike as an alert, not a trend.

A search is a demand signal, never a source: no query, however
frequent, becomes an event by itself, and no automated ingest
is triggered from the analytics table. Ingestion still starts
from a source adapter (plans 05, 26-29), with plan 33's license
gate in front of it.

### 4. The crawler half (server-side only)

- JS analytics reports zero AI-crawler visits, by construction.
  The crawler picture comes from plan 43's WAF logs plus the
  origin access logs: per-path crawl frequency, resolved to a
  named crawler and vendor, with the claimed identity verified
  against that crawler's published checks where available.
  Report it monthly, next to the human numbers, not merged
  into them - a crawler is not a reader, and blending the two
  inflates the audience.
- The practical use is plan 38's: which detail pages get
  crawled and cited, and whether the sitemap is being followed.
  If a high-traffic event page is never crawled, that is an SEO
  problem (plan 38), not an analytics problem.

### 5. Privacy and honesty rules (non-negotiable in v1)

- No cookies, no localStorage IDs, no fingerprinting, no
  cross-site tracking, no third-party ad-network anything.
  The client-side tool is chosen for this, and the server-side
  table is built to it: salted IP hash, daily salt, 90-day raw
  retention, aggregates kept, raw rows purged.
- The privacy notice states what is collected, why, and how to
  object, and the opt-out is a real one (the Plausible /
  Umami opt-out, plus `Do Not Track` honoured server-side).
- **Ad-blocker loss is measured, not assumed.** Client-side
  tags are blocked at rates that skew hard by audience, and a
  developer-heavy audience blocks far more than average. The
  server-side event counts and the access logs are the
  denominator: report the gap between them alongside the
  analytics numbers, so a blocked tag never reads as a traffic
  drop. Where the gap matters (script + event endpoint served
  from the project's own domain, not a third-party host), the
  first-party proxy rewrite is the fix - but only if the real
  client IP is forwarded: proxy without it and every visitor
  arrives from the proxy's address, collapsing the audience
  into one country and one daily hash.
- No analytics script loads on plan 34's admin UI or on any
  auth-gated surface. No analytics event is ever sent from a
  page the reader has not asked for.

## What this plan does not do

- No PostHog, no session replay, no feature flags, no
  experiments, no per-user tracking, no GA4. If the map ever
  needs product analytics at that depth, that is a later plan
  with its own consent story - this plan's cookieless posture
  is not a stepping stone to it, it is the decision.
- No A/B testing infrastructure. The map has no variants to
  test yet; when it does, the test belongs in its own plan.
- No ingestion change, no dedup change, no search-ranking
  change. The loop ranks demand; the pipeline still decides
  how to meet it, under plans 13, 26, 29 and 33.
- No PWA or offline analytics. Plan 42 deferred offline
  reading and it stays deferred.
- No changes to plan 43's limiter or cache, except one
  constraint: the server-side event endpoint is exempt from
  the per-IP search limiter (it is the instrument measuring
  the thing being limited, and a 429 on it would silently
  delete the evidence), and its own abuse control is a
  separate, generous cap on events per session window, not the
  search budget.

## Sequencing

After plans 31 and 38 (share links and detail pages create the
traffic worth measuring) and plan 43 (the limiter and the WAF
logs this plan leans on, and the exemption in the section
above). Alongside plan 34's review cadence - the weekly
zero-result review is a standing item in it, not a second
meeting. Before any public launch or SEO push: launching
without measurement means the launch itself teaches nothing.
Not a plan 26 pilot blocker - pilot traffic is James and
reviewers, and the pilot's validation is the curated-events
spot-check, not reader behaviour - but the server-side search
event lands with the pilot, because the pilot is the first
time real searches run against real ingested data, and the
zero-result list from the pilot is the first honest source
ranking the project will have.

## Acceptance criteria

- The chosen analytics tool is live on the map and detail
  pages, cookieless, with no consent banner, and the privacy
  notice describes it accurately.
- A search that returns zero results produces a server-side
  `search_zero_result` row with the normalized query, the
  result count, and the filters that were on; a search that
  returns results produces a `search` row with the same shape.
- The weekly zero-result review runs once on real pilot data
  and produces a ranked intent list with a classification per
  intent (gap / vocabulary / retrieval / filtered-out) - not
  a raw export.
- The gap between client-side analytics counts and server-side
  event counts is reported, so ad-blocker loss is a visible
  number, not a silent one.
- AI-crawler visits are reported from server-side logs, per
  path, separately from human traffic.
- No row in `analytics_events` contains a raw IP, a user
  agent string, a persistent identifier, or reader-submitted
  prose. Raw rows older than the retention window are purged
  and the purge is verifiable.
- A normal map session - pan, zoom, search, open a pin,
  follow a plan 31 share link, finish a plan 41 journey -
  produces the events in section 2 and never trips plan 43's
  limiter on the event endpoint.
- Playwright specs (mocked suite) cover: a zero-result search
  writes one event row with result count 0; a successful
  search writes one with the real count; no analytics script
  loads on an auth-gated page. The e2e-real suite is red since
  Oct 19 and owned by plan 35: specs land in the mocked suite
  first and are not gated on e2e-real going green.
- No Splink anywhere in this plan's implementation or text:
  dedup remains blocking plus Jev pairwise judging per the
  2026-10-23 decision, and this plan touches no dedup code.
- The 44 curated events get no special treatment: they are
  slated for deletion per the standing directive, and
  analytics tuned on them would be a reason to keep them.

## Open questions (carried to the backlog as 42-44)

42. Analytics vendor: Plausible cloud (cookieless, ~$9/mo at
    the 10K-pageview tier, EU-hosted) vs Vercel Analytics
    (zero setup, lives where the app runs) vs self-hosted
    Umami (MIT, free apart from hosting, runs on the Postgres
    the repo already has)? The privacy posture is the same
    shape in all three; the difference is cost, ops, and
    where the data lives.
43. Search-intelligence loop: should a repeated zero-result
    intent auto-create a plan 34 review item (a standing
    source-request queue), or stay a manual weekly read with
    no automatic ticket?
44. Retention: 90 days for raw search-query rows before
    aggregating and purging, or shorter (30 days) given the
    queries are the most personal thing the table holds?
