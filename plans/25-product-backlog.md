# Product backlog - next steps and bug fixes

Standing backlog of candidate product steps and bug fixes for historical-map,
maintained by the daily research loop. Coding agents: pick the top unclaimed
item; note your branch in the item when you start so two agents don't collide.

## What's there today

- The map at `/map` serves **44 hand-curated events across 34 locations from one
  source** (`utah-historical`, seeded from `data/map-data.json`). Everything was
  entered by hand or pasted through `/map/import`.
- Plans 01-24 design the ingestion engine (detect -> fetch -> extract -> publish)
  that replaces manual entry - a port of the State Affairs video pipeline.
- Latest on main (Nov 27): plan 60 added (coverage and gaps: show where the map is thin - H3 hexbin place view at resolution 2 world and 5 city with density per unit area never raw counts, per-century coverage ratios against the pilot's own source-query baselines, modern-country table labelled as such with band mix and image coverage, public /coverage page with honest empty states, internal feed pairing gaps with plan 44 zero-result demand for plan 29 source decisions, coverage block in plan 54 snapshots and GET /v1/coverage under plan 59; after the plan 26 pilot, plans 30, 32, 36, 43, 44, 46 and 51, before public launch, not a pilot blocker) and plan 59 added (public read API: let other people build on the map - read-only v1, five endpoints, cursor pagination, prefixed hm_live_ / hm_test_ keys shown once and revocable self-serve, one error shape with 429 + Retry-After and X-RateLimit-* headers, URI versioning with a six-month Sunset floor, OpenAPI-first spec, licence and attribution travelling with every row, link-only Britannica rows staying link-only, 451 for records whose source terms forbid redistribution, no writes, no OAuth, no GraphQL, no SDKs, no SLA in v1; lands after the plan 26 pilot, plans 38, 33, 43 and 44, before public launch, not a pilot blocker) and plan 58 added (confidence and provenance display: show readers what the map knows and how sure it is - per-field certainty labels computed from plan 32 date signals and plan 36 place bands, the plan 32 display string as the only reader-facing date, a How we know block on plan 38 detail pages with date/place basis and source anchors, disagreements shown side by side, public needs-a-source flags feeding plans 39 and 53, no numeric percentages to readers, labels by text plus shape never color alone; lands with the plan 26 pilot, before public launch, not a pilot blocker) and plan 57 added (offline map experience: the map that works with no signal - Workbox service worker with CacheFirst tiles and NetworkFirst API, precached app shell plus manifest, IndexedDB for last-viewed event windows and collections, explicit save-this-area downloads with size estimates and caps, honest stale labelling, PMTiles never in the precache, tile source must allow caching, read-only offline in v1; after plans 30, 42, 43, 51 and 52 and the pilot's first published set, before public launch, not a plan 26 pilot blocker) and plan 56 added (on this day: a daily view of what happened on this date - /today and /today/MM-DD over published rows, month/day query with plan 46 bands ranking the day, top 10 with show-all, year-only and circa dates excluded, births/deaths out of v1, reader-local today with server-UTC fallback, dated URLs as the shareable form, RSS feed as the no-account daily delivery, no email digest or quiz in v1, February 29 rule, monthly coverage check against the Wikipedia on-this-day feed; after the plan 26 pilot's first published set and plans 30, 32, 38, 40, 43, 44, 46 and 48, before public launch, not a plan 26 pilot blocker) and plan 55 added (embeddable map widget: put the live map on any site - a chrome-less /embed route reusing plan 31's share-state params, a copy-paste plain-iframe snippet from the Share panel with no key and no account, a mandatory non-removable attribution bar with an escape link to the full map, event clicks opening plan 38 detail pages in a new tab, embed traffic under plan 43 limits and counted by Referer under plan 44, noindex on the embed route; after plans 30, 31, 38, 40, 42, 43 and 44, before public launch, not a plan 26 pilot blocker) and plan 54 added (data export: downloadable datasets for readers and researchers - a current-view export as GeoJSON + CSV from plan 30's viewport + time-window query with a 10,000-row cap, and a monthly immutable full snapshot on S3 with a Frictionless datapackage.json manifest, per-row sources and licenses, a file-level license equal to the most restrictive row, link-only Britannica rows staying link-only, tombstoned and unpublished rows never exported; after plans 30, 33 and 37, before public launch, not a plan 26 pilot blocker) and plan 53 added (reader event suggestions: missing-event submissions - anonymous in v1 with an optional contact email and a status token, evidence as links only with at least one source link required, one plan 34 review item per suggestion, approved suggestions enter the plan 26 pipeline as a manual detect and never publish directly, rejected suggestions resolved with a fixed-list reason; answers backlog question 29, after plans 39 and 44, before public launch, not a plan 26 pilot blocker) and plan 52 added (saved collections: reader-curated sets of events - device-local lists in v1, server-stored collections shareable by link in v2 with an anonymous owner token as the only credential and no accounts, private by default with no public directory, member notes that never become event text, and plan 37 lifecycle handling so merged members resolve and tombstoned members show as removed; after plans 30, 31, 32, 37, 38, 40, 41, 42, 46 and 48, before public launch, not a plan 26 pilot blocker) and plan 51 added (historical base maps: period-appropriate boundaries and map layers - an OpenHistoricalMap boundary overlay filtered by the plan 30 / plan 50 cursor date on start_decdate / end_decdate, with a date-labelled toggle and an honest empty state where OHM has no coverage, a full OHM basemap swap as tier 2 gated on a bridge spike and measured coverage, and curated Allmaps georeferenced sheets as a later tier; after plans 29, 30, 32, 40 and 50, before public launch, not a plan 26 pilot blocker) and plan 50 added (temporal playback: play history forward on the map - a moving cursor date shared with plan 30's timeline, play/pause, step-to-next-event, years-per-second vs events-per-second speeds, new-event pulse on already-loaded features with no fetch per frame, pause at the loaded window's edge, no autoplay ever, reduced-motion keeps playback usable without pulses, shared links open paused at the start year; after plans 30, 32 and 40, before public launch, not a plan 26 pilot blocker) and plan 49 added (event relationships: causes, effects, sequence, and part-of links from Wikidata - sourced statements only, causal claims publish only with a reference, sequence never shown as causation, derived part-of kept separate from curated hierarchies, shared participants/places as computed weaker links; lands with the plan 26 pilot, before plan 29 source #3) and plan 48 added (event media: images from Wikimedia Commons - one hero image per event from Wikidata P18, downloaded to S3 at publish time and never hotlinked, licence snapshot and TASL caption stored with the event, relevance measured by a pilot audit sample with reader image-wrong reports to the review queue, imageless events a normal state; lands with the plan 26 pilot, before plan 29 source #3) and plan 47 added (multilingual events and interface language: language-keyed labels with a Wikidata-style fallback chain, GeoNames alternate names as the multilingual place-name tier, Julian calendar-model normalisation to proleptic Gregorian with the original calendar kept for display, next-intl locale routing with hreflang on detail pages, no machine translation of event content in v1; lands with the plan 26 pilot, before plan 29 source #3) and plan 46 added (event selection and notability policy: a versioned per-source class whitelist with measured volumes, significance signals - sitelink count, reference presence, English article, date precision - stored as a high / standard / minor band, thresholds set from the pilot's measured histograms, highest-band cluster representative and a minor-events toggle at low zoom; lands with the plan 26 pilot, before plan 29 source #3) and plan 45 added (public launch readiness and go-live runbook: the launch gate with evidence per item, the release sequence with migrations before code, Vercel rollback plus plan 37 data rollback, the launch-day runbook, and the post-launch week; the last plan before the public launch, not a plan 26 pilot blocker) and plan 44 added (product analytics and the search-intelligence loop: cookieless aggregate web analytics plus a server-side search/event log, with a weekly zero-result review that ranks reader demand into the next source-expansion pass; sequenced before any public launch, not a plan 26 pilot blocker) and plan 43 added (public read surface: rate limiting, caching, and abuse protection before launch - per-endpoint limits, CDN caching with purge on publish, per-query semantic-search result caching, and a transaction-mode pooler in front of RDS; sequenced before any public launch, not a plan 26 pilot blocker) and plan 42 added (mobile map experience: touch-first map with a non-modal bottom sheet replacing the popup on small screens, OpenLayers gesture defaults configured, 44pt touch targets, compact timeline, sequenced after plans 30, 31, 38, 40 and 41 and before any public launch) and plan 41 added (sequence journeys: guided tours through PR #12's event groups as /map?sequence=<id>&step=<n> state, numbered pins, dashed order line labelled as order not a travelled route, plan 40's semantic list as the journey player) and plan 40 added (accessible map experience: a keyboard-operable, escapable OpenLayers map plus a semantic event list as its text equivalent, meaning carried by shape and text never color alone, reduced-motion handling, sequenced after plans 30 and 38 and not a pilot blocker) and plan 39 added (reader corrections: a public report-an-error form on the detail page, routed into the plan 34 review queue as one item per distinct correction, never auto-published, approved corrections applied through plan 37 with a manual-override flag, submitter prose never published) and plan 38 added (event detail pages and search indexing: one server-rendered page per published event at /events/<slug>, stable slugs with slug history, JSON-LD without rich-result chasing, sitemap and robots from the database, merged 301 / split disambiguation / tombstoned 410 / unknown 404, curated-seed pages noindex until retirement) and plan 37 added (post-publish lifecycle: per-source change detection, scoped re-publish, SCD2-lite versions, tombstones, unmerge/split procedure, manual-override preservation) and plan 36 added (geoparsing and place disambiguation for the publish stage: five-step resolution cascade, containment + temporal-validity scoring, confidence bands with abstain path, gold-set eval) and plan 35 added (repair the real-backend E2E
  suite and make it a merge gate: triage the red-since-Oct-19 suite with a
  PR #19 bisect before touching anything, fix the proven cause, give the
  suite its own test database so local runs stop truncating the dev
  database, split the CI job, quarantine flaky specs with a 14-day expiry,
  required check only after a green streak) and plan 34 (pipeline
  observability and publish review queue: Bull Board admin, DLQs with
  replay, durable review queue with fingerprint-verified approval, alerts,
  LLM cost ledger) and plan 33 (source licensing and attribution:
  adapter license declarations, publish gate, merged-event attribution union,
  popup Sources line and /sources page) and plan 32 (fuzzy dates: EDTF Level 1 date
  model with strict bounds and display string; Wikidata precision/circa
  mapping; fuzzy events as timeline spans) and plan 31 (shareable map state:
  deep links for viewport, timeline window, search, selected event) and plan 30
  (map UX at scale: OpenLayers clustering, density-aware zoom/default view,
  timeline semantic zoom, viewport + time-window fetching gated on e2e-real
  going green); plan 29 (source expansion pass, dedup settled as Jev pairwise
  judging 2026-10-23) and plan 28 (Britannica link-only adapter) and plan 26
  (Wikidata pilot, GLOBAL) on deck;
  PR #20 (search) and PR #12 (event sequences) still open; zero open issues.

## Bug fixes (triage first)

1. **Real-backend E2E suite red on main.** Observed Oct 19: the mocked E2E suite
   passes, the `e2e-real` suite fails after PR #19 (the S3 production-document
   change). Suspect the S3 change - not yet proven; plan 35 step 0 bisects
   it before any fix. Repro: run the `e2e-real` suite against main.
   Fix before it rots - a red real-backend suite masks every later regression.
   Plan 35 owns the fix and the merge-gate flip.

## Product steps (ranked)

1. **Land the second source.** Wikidata pilot (plan 26), GLOBAL scope, is the
   named second source - it validates detect -> fetch -> extract -> validate ->
   publish end to end. The one-file-per-source `SourceAdapter` design should
   make this the proof point, not another infra plan.
2. **Map UX at scale (plan 30).** The Oct 19 commit moved the timeline and the
   map now opens on the whole world (Oct 14). With 44 events the map is
   navigable; at 4,400 it won't be - plan 30 covers clustering, density-aware
   zoom/default view, timeline semantic zoom, and viewport + time-window
   fetching (gated on e2e-real going green).
3. **Britannica "On This Day" link-only adapter (plan 28).** Editorial curation
   as a link layer: date + short factual identifier + link back, never the
   text. Pending James's call on coordinate enrichment via Wikidata matching.
4. **Retire the curated seed.** Once plan 26's spot-check passes, the 44 curated
   rows leave `data/map-data.json` (keep a snapshot as a test fixture only).
   Standing directive from James (2026-10-20) - do not re-propose keeping them.
5. **Geocoder: evaluate HistGeocoder as a temporal tier.** Confirmed live
   2026-10-22 at histgeocoder.app: Postgres-native, `valid_from`/`valid_to`
   ("did this place exist in 1906"), GNIS public-domain + GeoNames CC BY +
   Wikidata CC0 with the OSM layer switchable off. For the text sources, after
   plan 26 proves the pipeline.
6. **Source #3 and the dedup story (plan 29).** Muffinlabs Today-in-History API
   (keyless JSON, daily refresh, CC BY-SA via Wikipedia) is the named third
   source - it forces the first real geoparsing test since it ships no
   coordinates. Before its overlap analysis runs, the dedup path is
   settled (2026-10-23): deterministic blocking plus Jev pairwise judging
   inside plan 13's vector + judge fusion, per plan 11's
   `JEV_PUBLISH_DEDUP_ENABLED` design. OpenHistoricalMap (CC0) lands as a
   boundary/historical-geography
   layer, not an event adapter; GDELT 2.0 stays deferred (post-1979 news
   coding, needs its own CAMEO mapping).
7. **Shareable map state (plan 31).** Deep links for viewport, timeline window,
   search query, and selected event (popup). URL is the single restorable
   state via replaceState + popstate; merged/deleted event ids degrade to the
   described view instead of erroring. Open Graph event previews as a stretch.

8. **Fuzzy dates (plan 32).** No source ships clean day-precision dates, so
   events get an EDTF Level 1 string plus strict start/end bounds plus a
   display string ("circa 1850", "Spring 1850") instead of a coerced fake
   day. Lands with the plan 26 pilot: its adapter implements the Wikidata
   precision/circa/earliest/latest mapping table, dedup blocking switches
   to interval overlap, and plan 30's timeline renders fuzzy events as
   spans with distinct uncertain markers.

9. **Source licensing and attribution (plan 33).** Every adapter declares
   its license at the boundary (Wikidata CC0, GeoNames CC BY 4.0, OHM
   CC0 with per-element exceptions, Muffinlabs CC BY-SA, Britannica
   link-only with no grant); publish rejects undeclared licenses to the
   review queue; merged events carry the union of attributions; popups
   get a Sources line and the map gets a /sources page. Lands with the
   plan 26 pilot.

10. **Pipeline observability and publish review queue (plan 34).**
    Bull Board admin on the ingest service (auth-gated, truncated
    payloads), per-stage dead-letter queues with a replay script,
    a durable Postgres review queue for everything publish refuses
    to auto-approve (plan 33 license rejects, Jev uncertain band)
    with flagged-field highlighting, source anchors, batch-by-reason
    review, and fingerprint-verified approval; alert thresholds for
    backlog, failures, stalls, silent sources, and review age; a
    per-source LLM cost ledger. The review queue must exist before
    the plan 26 pilot publishes anything.

11. **Repair the real-backend E2E suite; make it a merge gate (plan 35).**
    Triage first (read the latest e2e.yml run, bisect PR #19), fix the
    proven cause in the smallest diff, give the suite an isolated test
    database (Martin's DATABASE_URL is currently hardcoded to the dev
    database, so the E2E_POSTGRES_URL override cannot deliver isolation
    today), split the CI job so failures name their suite, upload
    failure artifacts, quarantine intermittent specs with a 14-day
    expiry (deterministic failures never quarantined), and flip the
    real suite to a required check only after a green streak. Closes
    bug fix #1 and open question 3, and unblocks plan 30's gate.

12. **Geoparsing and place disambiguation (plan 36).** Plan 09 says
    "geocode, dedupe, write" but no plan owned how a free-text place
    name becomes coordinates. Plan 36 fills it in: structured
    pass-through, local gazetteer cache with variant/historical names
    and valid_from/valid_to, WHG reconciliation (handling its 451-on-fetch
    quirk), public Nominatim only at 1 req/s as a last resort, and an
    LLM proposer that never supplies coordinates directly. Scoring ranks
    containment and temporal validity ahead of prominence; uncertain
    cases go to plan 34's review queue and hopeless cases publish no
    pin at all. Lands with the plan 26 pilot; required before plan 29
    source #3 (Muffinlabs ships no coordinates) publishes.

13. **Post-publish lifecycle (plan 37).** No plan owned what happens
    after publish, and sources are living documents. Plan 37 adds
    per-source change detection (Wikidata lastrevid sweep, Muffinlabs
    hash diff, Britannica existence check that stays link-only, book
    file hashes), a 7-day settle rule with three deferrals before
    review, scoped re-publish by change class, SCD2-lite version rows
    and tombstones instead of hard deletes, an unmerge/split procedure
    that never re-merges a recorded split pair automatically, and
    manual-override preservation through the plan 34 review queue.
    The curated-seed retirement runs through it as
    tombstone-then-purge (or immediate purge, per James's call).
    Lands with the plan 26 pilot.

14. **Event detail pages and search indexing (plan 38).** Plan 31
    gives the map shareable URLs but no page behind them, and a
    client-rendered map's popup text is invisible to search engines
    and AI crawlers. Plan 38 adds one server-rendered page per
    published event at /events/<slug> (stable slugs, slug history,
    one-hop redirects), rendered from the same Postgres the map
    reads, with per-page metadata, schema.org/Event JSON-LD that
    never claims more precision than the visible plan 32 date
    display, a sitemap listing only canonical published URLs with
    real lastModified values, and lifecycle states as HTTP statuses
    (merged 301, split disambiguation page, tombstoned 410, unknown
    404). Curated-seed pages stay noindex until retirement so no
    search equity builds on pages slated for purge. Lands with the
    plan 26 pilot, after plans 31 and 37; not a pilot blocker.

15. **Reader corrections (plan 39).** Plan 37 deferred a public
    report-an-error flow; plan 39 is that decision. A form on
    the plan 38 detail page (wrong date, wrong place/pin, wrong
    title/description, duplicate, missing event, inappropriate
    content, other), anonymous in v1, evidence as links only
    (never pasted source text), routed into plan 34's
    /admin/review queue as one ingest_review_items row per
    distinct correction with reason READER_CORRECTION.
    Reports never change a published event, never create a
    public URL, and never enter the sitemap; approved
    corrections apply through plan 37 (version row,
    manual-override flag, scoped plan 32 date or plan 36 place
    re-mapping), and submitter prose is never published as
    event text. Abuse controls: honeypot, hashed-IP rate
    limits, shape limits, no CAPTCHA in v1.

16. **Accessible map experience (plan 40).** No plan owned using
    the map itself by keyboard or screen reader: plan 30 owns map
    behaviour at scale, plan 38 owns the detail page, plan 39 owns
    reporting an error from it. Plan 40 adds a focusable,
    escapable map container (tabindex 0, arrow-key pan, +/-
    zoom, Escape returns focus, skip-map link), a semantic event
    list as the map's text equivalent reusing plan 30's viewport
    + time-window query (clusters expand to individual entries,
    list and pins in sync, one debounced aria-live summary per
    settled view change), meaning by shape and text never color
    alone (settling plan 32 open question 6 on the shape side),
    and prefers-reduced-motion handling. Sequenced after plans
    30 and 38; not a plan 26 pilot blocker; before any public
    launch or SEO push plan 38 enables.

17. **Sequence journeys (plan 41).** No plan owned following a
    sequence: PR #12 builds event groups and the popup only names
    them ("Part of: <sequence>"). Plan 41 turns a group into a
    guided tour on the same map - steps in chronological order
    (plan 32 start bound, PR #12 member order on ties), numbered
    pins, a dashed order line labelled as order not a travelled
    route, plan 31 share links (`sequence` + `step` params),
    unlocated steps kept in the list and merged/tombstoned steps
    degraded per plan 37, and plan 40's semantic list as the
    journey player. No new tables, no authoring UI, no routing
    engine. Hard prerequisite: PR #12 merges first; sequenced
    after plan 38; not a plan 26 pilot blocker.

18. **Mobile map experience (plan 42).** No plan owned the map on a
    phone: plans 30, 31, 38, 40 and 41 all assume a desktop-shaped
    viewport. Plan 42 configures the OpenLayers gesture defaults
    (pinch-rotate off, pin selection on `singleclick`), replaces the
    anchored popup with a non-modal bottom sheet (peek/half/full
    detents, map stays interactive behind it) below the breakpoint,
    sizes every control to 44pt, collapses plan 30's timeline to a
    compact strip, and makes plan 41's journey player the sheet's
    step list on small screens. Sequenced after plans 30, 31, 38, 40
    and 41; before any public launch or SEO push; not a plan 26 pilot
    blocker.

19. **Public read surface protection (plan 43).** No plan owned what
    happens when the public actually arrives: no rate limit on any
    read endpoint, no cached response, nothing between a traffic
    spike and production RDS. Plan 43 adds per-endpoint limits
    (Upstash sliding window in code, Vercel WAF rules where the plan
    tier allows), CDN caching with s-maxage and
    stale-while-revalidate plus purge on publish, per-query result
    caching for semantic search (the Bedrock-embedding endpoint),
    and a transaction-mode pooler (RDS Proxy first choice) in front
    of RDS so a crawl spike cannot exhaust connections. AI training
    crawlers are challenged or blocked via the WAF AI Bots ruleset
    while search crawlers keep access for plan 38's SEO. Sequenced
    before any public launch or SEO push, alongside plans 40 and 42;
    not a plan 26 pilot blocker (the publish purge hook lands with
    the pilot).

20. **Product analytics and the search-intelligence loop (plan 44).**
    Cookieless aggregate web analytics (Plausible default, Vercel
    Analytics or self-hosted Umami as alternatives; PostHog
    deferred) plus a first-party server-side event log in Postgres
    for search queries with result counts, event opens, and
    journey completion. A weekly zero-result review replays and
    classifies failed searches (real gap / vocabulary / retrieval
    miss / filtered out) and ranks the demand into the next source
    expansion pass (plan 29). AI-crawler visits are reported
    separately from server-side logs, since JS analytics never
    sees them. Before any public launch; not a plan 26 pilot
    blocker, but the server-side search event lands with the
    pilot.

21. **Public launch readiness and go-live runbook (plan 45).**
    Six plans say "before any public launch" and none of them
    defines the launch, so plan 45 does: a go/no-go gate with
    evidence per item (e2e-real green and required, pilot
    published, curated seed retired, sitemap submitted, plan 43
    and plan 44 live, backups with a restore drill done once),
    a release sequence (migrations before code, destructive
    migrations as a separate later deploy), Vercel rollback
    rehearsed at T-2d, a launch-day runbook with abort criteria,
    and a T+24h checkpoint before any announcement. The last
    plan before the public launch.


22. **Event selection and notability policy (plan 46).** Plan 26's pilot
    is bounded by a class whitelist and a 5,000-event cap, but no plan owned
    what qualifies at full scale once the cap lifts. Plan 46 adds three
    layers: a versioned per-source class whitelist with measured per-class
    volumes, significance signals (sitelink count, reference presence,
    English Wikipedia article, date precision) stored as a high / standard /
    minor band on the event row with thresholds set from the pilot's measured
    histograms, and density behaviour (highest-band cluster representative,
    minor events behind a toggle at low zoom). Britannica link-only records
    bypass layer 2 as editorially significant by construction. Lands with
    the plan 26 pilot; before plan 29 source #3.


23. **Multilingual events and interface language (plan 47).** Plan 26's
    global pilot returns events whose labels exist only in other languages,
    and no plan owned what language an event title or place name is in, or
    which calendar a pre-1582 date was recorded in. Plan 47 adds the language
    model: language-keyed labels with a Wikidata-style fallback chain
    (requested locale, mul, English, any) and a stored display_lang, GeoNames
    alternate names (isHistoric with from/to dates) as the multilingual tier
    in plan 36's gazetteer cache, Julian calendar-model normalisation to
    proleptic Gregorian for timeline math with the original calendar preserved
    for display, and next-intl `[locale]` routing with hreflang on plan 38
    detail pages (English chrome only in v1, further locales driven by plan 44
    analytics). No machine translation of event content in v1; non-Gregorian
    calendar conversion deferred. Lands with the plan 26 pilot; before plan 29
    source #3.


24. **Event media: images from Wikimedia Commons (plan 48).** Plan 26
    ingests text-only events, and no plan owned whether an event gets a
    picture, where it comes from, or how its licence is honoured. Plan 48
    adds one hero image per event from Wikidata P18 (~5.79M uses), fetched
    as an OPTIONAL in the pilot SPARQL with coverage, rejection rate, and
    median file size measured per class; files are downloaded to the repo's
    S3 at publish time and served from the map's own domain, never hotlinked
    (Commons allows hotlinking but warns a file can be vandalised, renamed,
    or deleted); the licence snapshot (LicenseShortName, LicenseUrl, Artist,
    AttributionRequired, file-page URL) is stored with the event per plan 33
    and every rendered image shows its TASL caption; relevance is a measured
    property (pilot audit sample, plan 39 image-wrong reports to the plan 34
    review queue), merged events keep the winner's image, and events with no
    image ship imageless as a normal state. No generated or AI images. Lands
    with the plan 26 pilot; before plan 29 source #3.


25. **Event relationships: causes, effects, sequence, and part-of links (plan 49).** Plan 26
    ingests events as isolated rows, and no plan owned how events connect to each other. Plan 49 adds
    sourced Wikidata statements only (P155/P156 sequence, P828/P1542 and P1536/P1537 causation, P361/P527
    part-of) in their own table with statement-level provenance; causal claims publish only when the
    source statement carries a reference, unreferenced causal claims go to the plan 34 review queue;
    sequence is never shown as causation and P155/P156 qualifiers are out of v1; derived part-of links
    are stored and shown separately from plan 18 curated hierarchies, disagreements are review items;
    shared participants/places (P710/P276) are computed weaker links, never dedup evidence; links are
    negative dedup evidence for the Jev judge, re-point on merge, re-derive on split, and candidates for
    unpublished targets are re-checked by plan 37. Lands with the plan 26 pilot; before plan 29 source #3.


26. **Temporal playback: play history forward on the map (plan 50).** Plan 30
    gives the reader a timeline to scrub, but nothing moves on its own, and
    every comparable that wins on engagement sells watching history happen.
    Plan 50 adds a cursor date shared with plan 30's timeline and plan 31's
    share state: play/pause, step to the next/previous event date, a speed
    selector with years-per-second and events-per-second modes, a new-event
    pulse (OpenLayers postrender/vectorContext) on already-loaded features
    so playback never triggers a fetch per frame, and a clean pause at the
    loaded window's edge with the fetch running only while paused. Fuzzy
    events appear at interval entry with plan 32's uncertain marker and
    minor-band events obey the plan 46 toggle. No autoplay ever; under
    prefers-reduced-motion the pulses and camera motion go away while
    playback stays usable, Space/arrows/Escape work, and the year is
    announced via plan 40's debounced aria-live summary with the semantic
    list in sync. Shared links open paused at the start year. After plans
    30, 32 and 40; before public launch; not a plan 26 pilot blocker.


27. **Historical base maps: period-appropriate boundaries and map layers (plan 51).** Plan 50
    moves the cursor through time, but the ground under the pins is still a 2026 map — modern borders,
    modern place names, modern roads — under events that predate all of them. Plan 51 makes the ground
    move with the pins: tier 1 is an OpenHistoricalMap boundary overlay on the modern basemap, filtered
    by the cursor date on start_decdate / end_decdate with a date-labelled toggle and an honest empty
    state where OHM has no coverage; tier 2 is a full OHM basemap swap gated on a bridge spike
    (ol-mapbox-style against the repo's pinned ol version, or a second renderer) and on measured
    coverage over the pilot's event set; tier 3 is curated Allmaps georeferenced map sheets, never
    auto-matched. The anachronism rule is non-negotiable: a boundary is shown only inside its validity
    range, fuzzy dates render dashed per plan 32, and the layer fails back to the modern basemap on tile
    error. After plans 29, 30, 32, 40 and 50; before public launch; not a plan 26 pilot blocker.


28. **Saved collections: reader-curated sets of events (plan 52).** The map is
    read-only and forgetful — a reader finds an event, closes the tab, and it is
    gone — while the comparables that win on return visits all let the reader keep
    what they found (Histropedia save/share/embed with sign-in, Atlas Obscura Been
    Here / Want to Visit / Add to List private by default, Google Maps lists with
    view-only links). Plan 52 adds keeping in two tiers: v1 device-local lists
    (localStorage, no account, no sharing), v2 server-stored collections at
    /collections/<slug> shareable by link with an anonymous owner token as the only
    credential and no accounts at all, private by default with no public directory
    in v1. Members are event ids plus the reader's own per-item notes, which never
    become event text; merged members resolve to successors and tombstoned members
    show as removed entries per plan 37, never silently deleted; a collection renders
    as a filtered map view plus the plan 40 semantic list, and plays through the plan
    41 journey player as a view mode. After plans 30, 31, 32, 37, 38, 40, 41, 42, 46
    and 48; before public launch; not a plan 26 pilot blocker.


29. **Reader event suggestions: missing-event submissions (plan 53).** Plan 39 was
    corrections-only and backlog question 29 deferred the missing-event half; plan 53 is
    that half. An anonymous suggestion form (title, plan 32 date, place, short description,
    at least one source link mandatory, evidence as links only, no photo uploads in v1)
    creates one plan 34 review item per distinct suggestion, reason READER_SUGGESTION;
    intake dedup shows the reader near-matches and routes them to plan 39 instead, and a
    close match auto-resolves as already on the map. Approval does not publish: it enters
    the plan 26 pipeline as a manual detect, so extract, geoparse, dedup, licence, and
    notability all run as normal. Rejections carry a fixed-list reason and are resolved,
    not deleted; the reader checks the outcome with an anonymous status token (the plan 52
    owner-token pattern), and an optional contact email gets one decision email at most.
    Surfaced on the detail page, the zero-result search state (feeding plan 44's demand
    signal), and the semantic list; no public suggestion list, no voting, no accounts.
    After plans 39 and 44; before public launch; not a plan 26 pilot blocker.\n\n
30. **Data export: downloadable datasets for readers and researchers (plan 54).** No
    plan owned letting a reader take the map's data with them; plan 54 is the export
    half of plan 33's licensing story. A current-view export (GeoJSON + CSV, plan 30's
    viewport + time-window query, 10,000-row cap, over-cap points at the snapshot) and
    a monthly immutable full snapshot on S3 with a Frictionless datapackage.json manifest
    (version, per-resource schemas, licenses, per-source counts, sha256 checksums, a
    ready-to-paste citation string), listed on a generated /data page. The file's license
    is the most restrictive row inside it (a CC BY-SA row makes the file CC BY-SA);
    Britannica link-only rows export as link-only; tombstoned, unpublished, suggestion,
    correction, and collection data never export. No live query API, no embedded media,
    no accounts, no email gate. After plans 30, 33 and 37; before public launch; the
    first snapshot lands with the plan 26 pilot's first published set.\n\n
31. **Embeddable map widget: put the live map on any site (plan 55).** Plan 31 made\n    a view linkable and plan 54 made the data downloadable, but no plan owned letting\n    another site carry the live map itself. Plan 55 adds a chrome-less /embed route\n    reusing plan 31's share-state params (lat, lng, z, from, to, q, event) with plan\n    31's validation, a copy-paste plain-iframe snippet from the Share panel (width 100%,\n    fixed height presets, loading=lazy, no key, no account, no sandbox attribute in v1),\n    and a mandatory non-removable attribution bar (History Map link + plan 33 Sources\n    line + license) with an escape link to the full map. Event clicks open popups\n    in-frame and plan 38 detail pages in a new tab; the host page's navigation is never\n    hijacked. Embed traffic stays under plan 43 limits and is counted by Referer under\n    plan 44; the embed route is noindex with no sitemap entry. No JS embed API, no\n    per-host customization, no oEmbed endpoint in v1. After plans 30, 31, 38, 40, 42,\n    43 and 44, and after the plan 26 pilot's first published set; before public launch;\n    not a plan 26 pilot blocker.\n\n
32. **On this day: a daily view of what happened on this date (plan 56).** Every\n    comparable sells a daily habit and the pilot's data is already date-shaped, but\n    no plan owned the surface for it. Plan 56 adds /today and /today/MM-DD as a\n    month/day query over published rows, ordered by plan 46 significance band then\n    year descending, top 10 with a show-all expansion; year-only, circa, and\n    interval-spanning events never appear on a single day, fuzzy events with a\n    month/day appear with plan 32's uncertain marker, link-only Britannica rows stay\n    link-only, births/deaths are out of v1, and February 29 events join February 28\n    in non-leap years. "Today" is the reader's local date with server-UTC fallback\n    and dated URLs as the shareable form; delivery is the page plus an RSS feed\n    (/today/feed.xml), no email digest or quiz in v1; a monthly coverage check\n    compares day-set sizes against the Wikipedia on-this-day feed. After the plan 26\n    pilot's first published set and plans 30, 32, 38, 40, 43, 44, 46 and 48; before\n    public launch; not a plan 26 pilot blocker.\n\n
33. **Offline map experience: the map that works with no signal (plan 57).** No\n    plan owned offline use: no service worker, no manifest, no tile cache, no\n    cached event data, so the map dies the moment the reader loses signal —\n    exactly when a history map is most useful, on a walk or at a site. Plan 57\n    adds a Workbox service worker (CacheFirst tiles, NetworkFirst API,\n    precached app shell + manifest for installability), IndexedDB for the\n    last-viewed event windows and device-local collections, and explicit\n    "save this area" downloads with size estimates and caps; offline content\n    is labelled with its cache time and never presented as current, and\n    corrections/suggestions stay disabled offline in v1. The PMTiles trap\n    is a hard rule: no .pmtiles in the precache (a 200 replay breaks Range\n    reads), runtime caching with rangeRequests only. The tile source for the\n    offline pack must be one whose terms allow caching. After plans 30, 42,\n    43, 51 and 52 and the pilot's first published set; before public launch;\n    not a plan 26 pilot blocker.\n\n
34. **Confidence and provenance display: show readers what the map knows and how sure it is (plan 58).** Plans 32\n    and 36 compute date and place confidence inside the pipeline, and plan 14 stores source anchors, but no plan\n    decided what a reader sees — plan 38's pages would present every event as an equally settled fact. Plan 58 is\n    the reader-facing half: per-field certainty labels (Secure / Probable / Contested / Approximate, adapted from\n    Thought Atlas) computed from stored signals only, the plan 32 display string as the only reader-facing date\n    (never the sortable midpoint, never an invented January 1), a "How we know" block on detail pages with\n    date/place basis and source anchors, disagreements shown side by side per Spine & Watermark, public\n    "needs a source" flags in Wikipedia's Timefact pattern feeding plans 39 and 53, no numeric percentages to\n    readers, labels by text + shape never color alone. Lands with the plan 26 pilot; before public launch; not a\n    pilot blocker.\n\n
35. **Public read API: let other people build on the map (plan 59).** The map has an internal read surface\n    (`/api/data/*`), an agent surface (`mcp/`, `/api/mcp`), a bulk surface (plan 54 snapshots) and a browser\n    surface (plan 55 embed), but no contract a third-party developer can build against. Plan 59 is the live,\n    queryable middle: read-only v1, five endpoints (events list with bbox/date-window/band/source filters,\n    event by id or slug, place, sources registry, today), cursor pagination, prefixed `hm_live_` / `hm_test_`\n    keys shown once and revocable self-serve, one error shape with 429 + `Retry-After` and `X-RateLimit-*`\n    headers, URI versioning with a six-month Sunset floor, OpenAPI-first spec, licence and attribution\n    travelling with every row, link-only Britannica rows staying link-only, 451 (not 403) for records whose\n    source terms forbid redistribution per the World Historical Gazetteer pattern, MCP read tools dogfooding\n    the same read layer, no writes, no OAuth, no GraphQL, no SDKs, no SLA in v1. Lands after the plan 26\n    pilot, plans 38, 33, 43 and 44; before public launch; not a pilot blocker.\n\n
36. **Coverage and gaps: show where the map is thin (plan 60).** Every plan so far counts what the map has,\n    but nothing measures what it lacks. Plan 60 is the honest-empty-state half of the product: an H3 hexbin\n    place view (resolution 2 world, 5 city, density per unit area never raw counts), per-century coverage ratios\n    judged against the pilot's own Wikidata source-query baselines (a bucket with no baseline is labelled "no\n    baseline yet", never given a ratio), and a modern-country table labelled as such with band mix, dominant\n    source, latest publish date and image coverage per row. The public /coverage page admits the gaps ("no\n    events published yet", never "nothing happened here") and links thin areas to plan 53 suggestions; the\n    internal feed pairs gaps with plan 44 zero-result demand and plan 34 queue depth to pick the next source\n    under plan 29. Grounded in measured bias: the Global North holds 275.6 geotagged records per 1,000 km2\n    against 79.0 in the Global South (ratio 3.49, "Where the World went Missing", Nov 12, 2026). Lands after\n    the plan 26 pilot, plans 30, 32, 36, 43, 44, 46 and 51; before public launch; not a pilot blocker.\n\n## Open questions for James

1. Britannica: coordinate enrichment via Wikidata matching (pins), or
   display-layer links only?
2. Competitor check: Globe of History runs collector -> generator -> verifier
   (a verifier checks generated summaries against source anchors). Should our
   extract stage (plan 08) get a formal verify-against-source step, or is
   plan 14's RAG-with-citations the grounding story?
3. The red e2e-real suite (bug fix #1, since Oct 19): fix this week, or let it
   ride while ingestion work proceeds?
4. Source #3: Muffinlabs daily feed (needs geoparsing) first, or hold out for a
   second structured source that ships coordinates?
5. GDELT as a modern-history freshness layer: worth the CAMEO mapping work,
   or does the map stay pre-1979 deep history?
6. Fuzzy dates: show uncertainty on the map pin itself (hollow/dashed), or
   keep pins uniform and show it only in the popup?
7. Timeline filtering: interval intersection (a circa-1850 event shows in an
   1849-1851 window) or nominal-date only?
8. BCE scope: is pre-1 CE in scope for v1, or does the pilot clamp to CE
   dates and defer BCE handling?
9. Attribution display: per-event Sources line in the popup plus a
   /sources page, or is the popup line alone enough for v1?
10. Share-alike text: if Muffinlabs/Wikipedia-derived descriptions are
    adapted, show them verbatim with CC BY-SA credit, or stay facts-only
    to keep share-alike out of event records?
11. OHM per-element exceptions: exclude non-CC0 elements outright, or
    carry their individual licenses through like any other source?

12. Review queue: James-only for v1, or built for a second reviewer
    from the start?
13. LLM cost: should a daily budget cap hard-pause detect, or alert
    only?
14. Pipeline alerts: which channel should they go to?
15. E2E test database: isolated test stack locally (second PostGIS +
    Martin on distinct ports) vs keeping the shared dev database with
    the backup ritual?
16. E2E quarantine: 14-day expiry, or a shorter fuse, and who owns
    triaging a quarantined spec when it expires?
17. Merge gate: required check immediately once green, or after a
    five-run green streak - and should the mocked suite become
    required at the same time?
18. Geoparsing prominence: GeoNames population, Wikidata, or something
    else as the tiebreak source when containment and temporal validity
    leave two candidates equal?
19. Geoparsing volume: at what miss rate does the public Nominatim
    trickle valve give way to a self-hosted Photon or Pelias instance?
20. Unresolved events: list-only entries with no pin, or held entirely
    unpublished until resolution succeeds?
21. Lifecycle settle window: 7 days and three deferrals before review,
    or publish corrections immediately and accept edit-war churn?
22. Curated seed: 30-day tombstone window for link stability, or
    purge immediately at retirement?
23. Manual overrides: do reviewer-approved corrections ever expire
    (for example, re-check after a year), or stand until a human
    revisits them?
24. Detail-page slugs: date-prefixed (1847-07-24-pioneers-enter-...)
    for uniqueness, or title-only with numeric suffixes on clash?
25. Per-event OG images (map crop centred on the pin): worth a render
    pipeline for link unfurls, or is the static site-wide OG image
    enough for v1?
26. Split slugs: 200 disambiguation page listing all successors, or
    301 to the first successor with a notice?
27. Reader corrections: anonymous reports (OpenStreetMap Notes
    style) for v1, or require sign-in from the start?
28. Reader reports: one-shot with a single follow-up email at
    most, or a two-way thread and decision emails when a
    contact address is given?
29. Missing-event suggestions in v1 scope, or corrections-only,
    with suggestions deferred?
30. Accessibility target: WCAG AA assumed in plan 40, or AAA for
    any criterion (e.g. enhanced contrast for map labels)?
31. Accessible list placement: below the map on all widths, or a
    side panel on wide screens (simultaneous visibility vs simpler
    focus order)?
32. Live-region verbosity: one summary per settled view change
    enough, or also announce the newly focused event's title when
    selection changes via the list?
33. Sequence journeys: popup and detail-page links only in v1, or a
    browse-all-sequences index page too?
34. Journey route line: dashed order line labelled "not a travelled
    route", or no line at all (numbered pins only) to avoid
    implying a path?
35. Long groups: cap journeys at 30 steps like ArcGIS StoryMaps'
    Guided Tour, stay near 20 per StoryMapJS guidance, or support
    any length with a scrolling step list?
36. Pinch-rotate: disable in v1 to stop accidental rotation, or keep
    OpenLayers' default on?
37. Page-scroll: full-viewport map page on mobile, or an embedded map
    with two-finger pan / tap-to-enable?
38. Geolocation: an opt-in "events near me" button using browser
    geolocation in v1, or skip entirely for privacy and simplicity?
39. Vercel plan tier: Pro (WAF rate limiting and managed rulesets
    available) or Hobby (in-code Upstash limiting only)? The WAF
    layer is the upgrade path, not the baseline.
40. Limiter down: fail open for the map-data endpoints and fail
    closed for semantic search, or one global call?
41. AI training crawlers: challenge/block them via the WAF AI Bots
    ruleset, or allow them behind the same rate limits as humans
    and rely on robots.txt?
42. Analytics vendor: Plausible cloud (cookieless, ~$9/mo at the
    10K-pageview tier, EU-hosted) vs Vercel Analytics (zero setup,
    lives where the app runs) vs self-hosted Umami (MIT, free
    apart from hosting, runs on the Postgres the repo already
    has)?
43. Search-intelligence loop: should a repeated zero-result intent
    auto-create a plan 34 review item (a standing source-request
    queue), or stay a manual weekly read with no automatic ticket?
44. Retention: 90 days for raw search-query rows before aggregating
    and purging, or shorter (30 days) given the queries are the
    most personal thing the table holds?
45. Launch domain: a dedicated domain or subdomain (for example
    map.jamesmcdougalljr.com) for v1, or the Vercel project URL?
    And who owns the registrar / DNS change?
46. Soft launch (quiet, no announcement, watch plan 44's
    analytics for a week and announce only after the T+24h
    checkpoint passes) or an announced launch day with a fixed
    date?
47. Launch data floor: a minimum published-event count and
    source count before the map is worth announcing (for
    example, 500 events from 2+ sources), or launch as soon as
    the pilot validates, regardless of count?
48. Notability default: significant events only by default with minor
    ones one toggle away, or everything shown with significance only
    ordering the clusters?
49. Sitelink bar: once the pilot histogram lands, what sitelink count
    marks `standard` - and does an English Wikipedia article count for
    more than sitelinks in other languages?
50. Minor events: publish but hide at low zoom, or hold unpublished
    entirely until a reader asks for them?
51. Non-English-only events: show them with their native title and a
    language tag, or hold them out of the default view until an English
    label exists?
52. UI languages after English: which locales first (driven by plan 44
    analytics), or a fixed starter set?
53. Julian / Old Style dates: show the original date with an Old Style
    note, or always show the Gregorian equivalent with the original on
    the detail page only?
54. Hero-image relevance: publish P18 as-is and rely on reader
    reports (plan 39) to catch wrong images, or hold images back until a
    human/LLM check verifies each one depicts the event?
55. Serving: download to our S3 at publish (Commons' recommendation,
    full control, storage cost) or hotlink Commons thumbs (zero storage,
    but a vandalised or renamed file changes what readers see)?
56. Imageless events: leave them imageless, or fall back to a non-photo
    visual (e.g. a period map-tile crop of the location) so no event page
    is bare?
57. Causal claims: publish Wikidata's has-cause / has-effect as-is with a
    "Wikidata says" attribution, or hold causal claims for human review until
    verified (causation is a stronger claim than a date)?
58. Detail page: show "followed by" (sequence) and "caused" in separate
    sections, or one combined "Related events" list?
59. Shared participants / places: show "same people were here" style related
    events, or keep relationships to explicit Wikidata statements only?
60. Speed model: fixed years per second (honest about quiet centuries,
    can drag), or event-paced (constant events per second, never stalls
    but time jumps unevenly) — which is the default?
61. End of the loaded window: pause and wait for the reader, or auto-fetch
    and keep playing?
62. Journeys: when a journey is active, should play auto-advance through
    its steps, or should playback stay free-form and ignore the journey?
63. Boundary default: once the cursor is set, should the historical-boundary
    overlay be on by default, or off until the reader turns it on?
64. Full basemap swap: is a second renderer (or the ol-mapbox-style bridge) worth
    it for tier 2, or is the boundaries-only overlay enough for v1?
65. Sparse coverage: where OHM has no boundaries for the cursor date, show the
    modern basemap with a "no historical boundaries here yet" note, or hide
    the toggle entirely for that date/region?
66. Identity: is the anonymous owner-token model (no accounts, edit link is the
    only credential, lose it and you lose edit access) the right call for tier 2,
    or should collections wait for real accounts with email magic links?
67. Discovery: link-only sharing in v1 with no public directory, or should shared
    collections be discoverable from the start?
68. Play as journey: should a collection automatically offer the plan 41 journey
    player, or is that a separate explicit action the reader takes?
69. Evidence bar: is one source link enough to open a review item, or should a
    suggestion need two independent sources before a human looks at it (Wikidata
    asks three for notability)?
70. Approved suggestions: route through the full pipeline as a manual detect, or
    fast-track publish with reviewer approval alone (faster, but skips the dedup
    and geoparse checks)?
71. Status lookup: is the anonymous status token the right call in v1, or should
    status be contact-email-only with one decision email and no token at all?
72. Snapshot cadence: monthly full snapshots, or weekly while the pilot is
    publishing fast and monthly once it settles?
73. Share-alike split: if a snapshot contains any CC BY-SA rows, does the whole
    file carry CC BY-SA, or split into a CC0 file and a CC BY-SA file so the CC0
    rows stay cleanly reusable?
74. Zenodo DOI: worth a manual deposit per snapshot for citability, or is the
    versioned snapshot URL plus immutable filename enough?
75. Open embed or allowlist: anyone may embed from day one (the Google
    share-embed call), or only approved hosts, with everyone else getting a
    "request embed access" path?
76. Attribution bar: always visible at the foot of every embed, or collapsible
    to a small badge once the reader has interacted with the map?
77. Event clicks in an embed: open the plan 38 detail page in a new tab, or keep
    the reader inside the embed popup with the detail link as a secondary action?
78. "Today": the reader's local date (correct for the reader, two readers
    disagree) or server UTC (one canonical today, wrong for half the world
    after local midnight)?
79. Delivery: is an email digest ever worth a provider and a list, or do the
    page plus the RSS feed cover the daily habit?
80. Hero: one featured "story of the day" (Histoday's model, an editorial
    pick) or a flat ranked list led by the highest-band event with an image
    (Wikipedia's model)?
81. Offline scope: whole-app offline (shell + last-viewed area + events,
    everything cached as you browse) or explicit packs only ("save this
    area" is the only way anything goes offline)?
82. Tile source: self-hosted PMTiles built from OSM data, or a paid tile
    provider whose plan permits caching — which one backs the offline pack?
83. Offline submissions: queue corrections and suggestions made offline for
    sending later, or keep the forms disabled offline with the draft
    preserved?
84. Label vocabulary: four labels (Secure / Probable / Contested /
    Approximate, adapted from Thought Atlas) or a simpler three (Certain /
    Approximate / Disputed)?
85. Low-confidence events on the map: shown by default with their labels,
    or behind a "show uncertain events" toggle?
86. "Needs a source" flags: public on the detail page, or reviewer-only
    in the plan 34 queue until a human confirms the gap?
87. Key-required from day one, or an anonymous tier with a much lower
    limit (e.g. 10/minute, no search) for try-before-you-sign-up,
    accepting that anonymous abuse can only be handled by IP blocking?
88. Is the q search-backed list endpoint in v1, or does v1 ship list +
    filter only and search arrives with the plan 19 semantic search
    when it lands?
89. Per-key usage dashboard in v1 (each developer sees their own calls
    and limits), or aggregate-only measurement under plan 44 and no
    dashboard until someone asks for it?
90. Public from day one, or internal-only until the pilot's first
    published set is big enough that the page does not just say "thin
    everywhere"?
91. Country bucketing: modern country only (labelled), or a second
    at-time column from plan 51's OHM boundaries once that lands?
92. Public map view: H3 hexagons (density per area, no large-country
    flattery) or a country choropleth (more familiar, but raw counts
    flatter big countries)?