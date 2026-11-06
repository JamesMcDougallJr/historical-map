# Public read surface: rate limiting, caching, and abuse protection before launch

**Related:** [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (viewport +
time-window fetching is what multiplies read requests per session -
every pan and zoom is a query, so this plan protects the pattern
plan 30 creates),
[31-shareable-map-state.md](./31-shareable-map-state.md) (shared links
are the main way strangers arrive; a link that goes viral is the
traffic spike this plan has to absorb),
[34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md)
(alert thresholds and the per-source LLM cost ledger - this plan
feeds both, and the limiter's own Redis bill is a line in the ledger),
[35-e2e-real-repair-merge-gate.md](./35-e2e-real-repair-merge-gate.md)
(the e2e-real suite is red since Oct 19; this plan's specs land in
the mocked suite first, same as plan 42),
[37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md)
(publish is the moment cached responses go stale, so the purge
hooks live here),
[38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (the
sitemap and robots rules invite crawlers in; this plan decides
which crawlers get in and how fast they may ask),
[39-reader-corrections.md](./39-reader-corrections.md) (the
corrections form already has hashed-IP rate limits - this plan is
the read-side counterpart, and does not touch the form),
[25-product-backlog.md](./25-product-backlog.md) (step 19, open
questions 39-41).

**Changelog:**
- 2026-11-06 - Created from the daily research loop. Plans 30-42
  build a public, crawlable, shareable map and nothing owns what
  happens when the public actually arrives: no plan rate-limits a
  read endpoint, caches a response, or puts anything between a
  traffic spike and the production Postgres. The write side has
  abuse controls (plan 39's corrections form); the read side has
  none. This plan is the read side: limits, caches, and a pooler,
  before launch.

## Why this plan exists

Today the map's read surface is unguarded in three ways that only
matter once strangers can reach it, which is exactly what plans 31
and 38 are building toward:

- **Every read hits the database, at whatever rate the reader asks.**
  `/api/data/locations` and `/api/data/groups` return the same
  response to every reader, yet nothing caches it. Plan 30's
  viewport + time-window fetching makes this worse in the good
  direction: a single map session now issues a query per pan and
  zoom, so request volume scales with interaction, not visits.
  A scraper walking the viewport grid, or one shared link going
  mildly viral, turns into Postgres load with no throttle in
  front of it.
- **One endpoint spends money per request.** Semantic search
  (plans 12, 19-24; PR #20) embeds the query with Bedrock before
  it searches. There is no per-query result cache and no limit, so
  a bot replaying searches bills the project an embedding call at
  a time. Plan 34's cost ledger records the spend after the fact;
  nothing stops it while it happens.
- **Serverless functions and Postgres connections do not mix
  without a pooler.** Production Postgres is RDS (PR #20). A
  default Postgres caps out near 100 connections, and a burst of
  Vercel function invocations can each open one. Worse, a
  suspended function instance holds its pool open while its idle
  timers are themselves suspended, so connections leak for
  minutes after traffic falls. The failure mode is not a slow
  query; it is a flat "too many connections" error, first seen in
  production under load.

The comparable failure is documented, not hypothetical: one site
saw an AI bot drive its monthly requests from 3 million to 40
million, turning a manageable bill into tens of thousands of
dollars. Plan 38's sitemap is an invitation to every crawler,
good and bad. This plan is the answer to that invitation:
generous limits for humans, a cache that absorbs repeats, and a
pooler that keeps the database alive when limits are not enough.

## What ships

### 1. Two layers of limiting, and why both

- **Layer 1 - Vercel WAF (dashboard, no code).** Rate-limit custom
  rules and the managed rulesets (OWASP, Bot Protection, AI Bots)
  run before traffic reaches a function, so blocked requests cost
  nothing: since May 18, 2026 Vercel waives CDN-request and
  data-transfer charges for traffic the WAF denies, challenges,
  or rate-limits. Rules take effect immediately with no redeploy.
  Limitation: WAF rules see only infrastructure signals (IP,
  path, user agent), not application context, and rate limiting
  plus managed rulesets are Pro/Enterprise plan features - Hobby
  gets roughly three custom rules and no rate limiting. Open
  question 39 asks which tier this project is on; the plan does
  not assume it.
- **Layer 2 - in-code limiting with Upstash (`@upstash/ratelimit`
  + `@upstash/redis`).** The portable baseline that works on any
  plan tier. Sliding window is the default algorithm: fixed
  windows let a client spend a full budget at 12:59:59 and another
  at 13:00:00, and token bucket is reserved for endpoints where
  deliberate bursts are legitimate. The limiter runs in
  middleware or at the top of each route handler, before
  validation and before any paid call - a rejected search must
  never cost a Bedrock embedding or a database query.

  The repo already has Redis, but not one the web app can use:
  `docker-compose.yml` gains Redis for the ingest workers'
  BullMQ queues (plans 02, 04), and the workers do not run on
  Vercel (plan 10). That Redis is local/dev/CI infrastructure.
  Rate-limit state for the Vercel web app needs an HTTP-based
  store - Upstash Redis, whose client makes stateless HTTP calls
  and needs no connection pool - or the WAF layer above. Do not
  reuse the BullMQ Redis for this, and do not build an in-memory
  limiter: on serverless, each function instance has its own
  memory, so a counter in one instance never sees the requests
  that land on another, and the limiter never trips. An
  in-memory fallback "so it still works without Redis" is fine
  for local development and harmful in production, because it
  silently provides no protection.

  Keys are `IP + route` (one prefix per limiter, so a noisy
  endpoint cannot burn another's budget). The IP comes from the
  platform-set `x-forwarded-for` - Vercel sets it; if the app
  ever sits behind another proxy, only the trusted proxy may set
  that header or the key is spoofable. Responses carry
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
  `X-RateLimit-Reset` on every response, and a `429` carries
  `Retry-After`.

### 2. Per-endpoint limits (starting points, tuned from live traffic)

Limits are starting points, not laws: watch a week of real
traffic (plan 34's alerts) and tune. The shape is what matters -
expensive endpoints are stricter, and the map's own UI must never
trip its own limits in normal use.

| Endpoint | Limit (sliding window, per IP) | Why |
| -------- | ------------------------------ | --- |
| `GET /api/data/locations`, `GET /api/data/groups` | 120 / min | The map's own panning drives these; the CDN cache in section 3 absorbs most of them, so the limiter is a backstop, not the defence. |
| Lexical search | 60 / min | Cheap (Postgres full-text), but still a database query per keystroke-ish request. |
| Semantic / hybrid search | 20 / min | One Bedrock embedding per query; the per-query cache in section 3 is the other half of the defence. |
| `GET /api/mcp` | 30 / min | A tool surface, not a page asset; agents that need more can say so and get a keyed tier later. |
| Plan 38 detail pages (`/events/<slug>`) | No app-level limit | Server-rendered pages served from the CDN cache; WAF layer only. |
| Corrections form, `/map/import`, `/api/parse`, `/admin/review` | Out of scope here | Write paths. The corrections form already has hashed-IP limits (plan 39); admin is auth-gated (plan 34). |

New rules start in the WAF's log action (the firewall-rule
template's default), then flip to deny once the logs show real
readers are not being caught. The same log-first rule applies to
the in-code limiter's first week: count what would have been
rejected before rejecting it.

### 3. Caching: the CDN absorbs repeats, Redis absorbs expensive repeats

- **Public JSON gets CDN cache headers.** `/api/data/locations`
  and `/api/data/groups` return the same bytes to every reader
  and change only when plan 37 publishes something, so they are
  the ideal CDN case: `Cache-Control: public, s-maxage=300,
  stale-while-revalidate=86400`. The shared cache holds the
  response for five minutes and serves it stale for up to a day
  while refreshing in the background, so expiry costs one
  background fetch instead of one slow user request. Where the
  browser and the CDN need different lifetimes, use the targeted
  header (`Vercel-CDN-Cache-Control`, read by the Vercel Edge
  Network only and not forwarded to the browser) instead of
  overloading `Cache-Control`. Detail pages get the same
  treatment with a longer `s-maxage`, since an event's page
  changes less often than the map's feed.
- **Verify the cache actually hits.** Two traps kill hit rates
  silently: a `Set-Cookie` on a public GET response makes most
  shared caches refuse to store it (one session-touching helper
  on a public route is enough to drop the hit rate to zero), and
  Next.js 15 no longer caches `fetch()` by default, so caching
  must be opted into explicitly - never assume a route handler
  is cached. Check `x-vercel-cache` (`HIT`, `MISS`, `STALE`,
  `BYPASS`, `PRERENDER`) while tuning, and add a plan 34 alert
  on the hit rate for `/api/data/*`.
- **Publish purges.** Plan 37's publish step calls
  `revalidateTag` / `revalidatePath` for the affected responses,
  so a publish is never followed by up to a day of stale map
  data. Long cache lifetimes plus explicit purge beat short
  guessed TTLs.
- **Semantic search results cache by normalized query.** The
  cache key is a hash of the query after lowercasing, trimming,
  and collapsing whitespace, plus the search parameters
  (lexical/semantic/hybrid, filters). A hit skips the Bedrock
  embedding entirely. TTL is short (minutes, not hours) because
  search results change as plan 37 publishes. This cache lives
  in Upstash Redis, the same store as the limiter - one new
  dependency, not two.
- **What is never cached.** Anything behind auth (plan 34's
  admin UI) gets `private, no-store`. POSTs are not cached by
  CDN layers by design, but confirm no write response carries a
  cacheable header by accident.

### 4. A pooler in front of RDS

- **RDS Proxy is the first choice** (the production database is
  RDS): managed, IAM-aware, transaction-mode pooling with
  prepared-statement support, at roughly $0.024 per vCPU-hour
  on top of the database. Self-hosted PgBouncer in transaction
  mode is the fallback if the Proxy bill is unjustifiable at
  this traffic level.
- **Transaction mode is the point.** A backend connection is
  checked out for one transaction and returned immediately, so
  a small fixed set of backend connections serves a large number
  of short-lived function clients. Session mode mostly defeats
  the purpose on serverless.
- **Check before flipping.** Anything that depends on session
  state - prepared statements, `SET` session variables,
  `LISTEN`/`NOTIFY` - stops working reliably when the next
  transaction can land on a different backend connection.
  Audit `lib/postgres-storage.ts` and the ingest service's
  TypeORM usage for those before pointing the web app at the
  pooler endpoint. The pooler endpoint replaces the direct RDS
  endpoint in the web app's env (Terraform-managed, per the
  repo's `infra/vercel.tf` pattern); the workers' connection
  path is unchanged unless the audit finds a shared problem.
- **Size from the database's side, not the clients'.** The two
  numbers to reason about are how many clients may connect to
  the pooler and how many backend connections it holds to
  Postgres (10-50 is usually enough). Add a plan 34 alert on
  pool saturation so the first warning arrives before the first
  "too many connections".

### 5. Bots and crawlers: let the good ones in, slow the rest down

- **Good crawlers keep access.** Plan 38's SEO depends on
  search engines fetching detail pages and the sitemap, so
  Googlebot and friends are allow-listed at the WAF layer and
  in `robots.txt` (plan 38 owns the robots file; this plan only
  constrains what the WAF does with it).
- **`robots.txt` is voluntary; the WAF is enforceable.** AI
  training crawlers are the load that matters here, and they do
  not all obey robots. The WAF's managed AI Bots ruleset is the
  enforcement: challenge or block training crawlers, rate-limit
  the rest. Open question 41 asks James for the posture - block
  training crawlers outright, or allow them behind the same
  limits as humans.
- **Scrapers get the same treatment as abuse, not a separate
  system.** A client walking the viewport grid or replaying
  search queries trips the same per-IP limits and the same 429s
  as any other over-limit client. No user-agent allow-list for
  scrapers, no special scraping tier in v1 - if a legitimate
  consumer needs bulk access, that is a keyed API tier, a later
  plan, not a hole in this one.

### 6. Failure modes, decided up front

- **Limiter store unreachable.** Decide per endpoint, not once:
  the map-data endpoints fail open (a down limiter must not
  take the map down with it), semantic search fails closed or
  open per James's call in open question 40 - the money endpoint
  is the one where failing open has a price. Whatever is
  decided, the failure is alerted (plan 34), never silent.
- **The limiter's own bill.** Sliding window costs about 2 Redis
  operations per request. At real volume that is a line item:
  Upstash's free tier was 500K commands/month as of 2025, and
  the per-source LLM cost ledger (plan 34) gains a limiter-ops
  line so the defence's cost is visible next to the cost it
  prevents.
- **Cache stampede on purge.** A publish that purges a popular
  response must not let a hundred concurrent requests all miss
  and all hit Postgres; `stale-while-revalidate` covers this by
  serving stale while one request refreshes.

### 7. Observability (feeds plan 34, not a second dashboard)

- 429 rate per endpoint and per limiter, with the top offending
  IPs/paths in the alert payload.
- CDN hit rate for `/api/data/*` and the detail pages, from
  `x-vercel-cache`.
- Pooler saturation (clients waiting for a backend connection).
- Upstash command volume against the free-tier budget.
- One weekly review in the first month after launch: which
  limits tripped on real readers, and what the tuned values
  should be.

## What this plan does not do

- No authenticated API keys, no per-user tiers, and no paid plan.
  If a legitimate consumer needs bulk access, that is a later
  plan with its own key management; this plan only keeps
  anonymous abuse from costing money or taking the site down.
- No CAPTCHA and no challenge page for human readers. WAF
  challenge mode exists for the AI-bot ruleset, not as a gate in
  front of the map.
- No changes to the ingest workers' connection path, queue, or
  Redis. The workers are long-lived processes with their own
  pool behaviour; this plan is the Vercel web app's read surface.
- No PWA or offline caching. Tile caching and offline reading
  were deferred by plan 42 and stay deferred.
- No dedup, geoparsing, or ingestion change of any kind.

## Sequencing

After plan 30 (viewport fetching defines the request pattern
being protected) and plan 34 (the alerts and cost ledger this
plan feeds). Before any public launch or SEO push plan 38
enables, alongside plans 40 and 42, which share the same gate:
a shared link that opens a map that falls over under its first
real traffic is worse than no link at all. Not a plan 26 pilot
blocker - pilot traffic is James and reviewers - but the publish
purge hook in section 3 lands with the pilot, because the pilot
is the first time publish and caching meet. The WAF rules can
land independently of the code (dashboard change, no deploy);
the in-code limiter and the pooler are code and infra changes
that ship together.

## Acceptance criteria

- A load test simulating a viral share link (sustained 10x
  normal read traffic, plus a viewport-grid crawl) produces no
  5xx and no "too many connections" from Postgres; requests
  past the limits get `429` with `Retry-After` and the
  `X-RateLimit-*` headers.
- A normal map session - pan, zoom, search, open a pin, follow
  a plan 31 share link - never trips a limit.
- Repeated identical map-data and search requests are served
  from cache (CDN `HIT` or Redis hit); no public GET response
  carries `Set-Cookie`.
- Publishing an event (plan 37) purges the affected cached
  responses; the next read shows the new data.
- The pooler holds backend connections steady while simulated
  function concurrency spikes; the saturation alert fires in
  staging before connections exhaust.
- WAF rules run in log mode for a week before any deny, and the
  logs show no real reader caught.
- Playwright specs (mocked suite) cover: over-limit search
  returns 429; cached map-data response served without a
  database query; publish purges the cache. The e2e-real suite
  is red since Oct 19 and owned by plan 35: specs land in the
  mocked suite first and are not gated on e2e-real going green.
- No Splink anywhere in this plan's implementation or text:
  dedup remains blocking plus Jev pairwise judging per the
  2026-10-23 decision, and this plan touches no dedup code.
- The 44 curated events get no special treatment: they are
  slated for deletion per the standing directive, and a
  protection layer tuned on them would be a reason to keep them.

## Open questions (carried to the backlog as 39-41)

39. Vercel plan tier: is the project on Pro (WAF rate limiting
    and managed rulesets available) or Hobby (in-code Upstash
    limiting only, ~3 custom rules)? The WAF layer is the
    upgrade path, not the baseline - the answer decides whether
    section 1's layer 1 ships now or later.
40. Limiter down: fail open for the map-data endpoints and fail
    closed for semantic search, or one global call? The money
    endpoint is the one where failing open has a price.
41. AI training crawlers: challenge/block them via the WAF AI
    Bots ruleset, or allow them behind the same rate limits as
    humans and rely on robots.txt?
