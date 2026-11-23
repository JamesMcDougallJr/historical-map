# On this day: a daily view of what happened on this date

**Related:** [00-README.md](./00-README.md) (phases 05-09), [25-product-backlog.md](./25-product-backlog.md) (product step #32), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (the pilot is what fills the day view), [28-britannica-link-only.md](./28-britannica-link-only.md) (link-only day lists are not ingested), [29-source-expansion-dedup.md](./29-source-expansion-dedup.md) (Muffinlabs, source #3, is day-shaped data), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (viewport + time-window query, clustering), [31-shareable-map-state.md](./31-shareable-map-state.md) (share-state URL params), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (which dates qualify for a day), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (attribution, Sources line), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages as click targets, sitemap), [40-accessible-map-experience.md](./40-accessible-map-experience.md) (semantic list, aria-live), [42-mobile-map-experience.md](./42-mobile-map-experience.md) (narrow widths), [43-public-read-surface-protection.md](./43-public-read-surface-protection.md) (caching per date key), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (which dates readers actually open), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands rank the day), [47-multilingual-events-i18n.md](./47-multilingual-events-i18n.md) (the day view in other languages), [48-event-media-wikimedia-commons.md](./48-event-media-wikimedia-commons.md) (hero image), [50-temporal-playback.md](./50-temporal-playback.md) (the day as a playback starting point), [55-embeddable-map-widget.md](./55-embeddable-map-widget.md) (a day view is embeddable).

**Changelog:**
- 2026-11-19 — First version. No plan owned the most obvious daily habit a history map can have: "what happened on this date." Every comparable sells it, the pilot's data is already date-shaped, and the map had no surface for it.

## Why this plan exists

The "on this day" view is the one feature every history product converges on, because it is the only one that gives a reader a reason to come back tomorrow.

- **Wikipedia** exposes it as a first-class API, not a page scrape: `feed/onthisday/{type}/{mm}/{dd}` with types `events`, `selected`, `births`, `deaths`, `holidays`, and `feed/featured/{yyyy}/{mm}/{dd}` for the daily featured set. Free, no auth. The feed is the reference the pilot's day coverage is measured against, not a source — plan 26's Wikidata ingestion already covers the same ground with better provenance, and ingesting the feed would duplicate it.
- **Muffinlabs Today in History** (history.muffinlabs.com) parses the same Wikipedia day pages into JSON, no signup; Microsoft's connector documents 100 calls per 60 seconds per connection. It is already plan 29's source #3, which matters here: Muffinlabs rows are the only adapter output that is naturally month/day keyed, so the day view gets a coverage boost when source #3 lands — but the view must not depend on it.
- **ZenQuotes On This Day API** is the cautionary case: 5 requests per 30 seconds by IP without a key, attribution with a link back required. A third-party day feed with a rate limit and an attribution string is a dependency, not a feature — one more reason the day view is a query over the map's own published rows.
- **Histoday** (histoday.app) is the daily-habit model taken furthest: one true story from this day in history, every day, with video, a 60-second quiz, and AI voices — "designed to be opened every morning." One story a day is a product; a list of everything that happened is a reference. This plan picks the reference first and leaves the one-story hero as an open question (question 80), because the map's strength is the set, not a single editorial pick.
- **The mobile apps agree on the shape and the habit:** "On This Day: History & Facts" sends one notification a day at 9 AM with the fact of the day plus a home-screen widget and a daily quiz; "Today" (SmartUp Tech) pairs daily notifications with famous birthdays and death anniversaries; History Daily (Airship/Noiser) is a podcast that does one event a day, every weekday. The pattern is always the same: a small daily set, a fixed time of day, and a way to come back. The map's v1 is the page and the feed; notifications are deliberately out of v1 (see below).
- **The map has the data and no surface for it:** plan 26 ingests events with dates; plan 32 gives every event a strict start/end bound; plan 46 ranks events by significance band. A day view is a query — month/day equals the reader's date, ordered by band — over rows the pipeline already publishes. What no plan owned is the route, the ranking, the date semantics (whose "today", what counts as a day event, what happens on February 29), and the delivery (page, dated URLs, feed). Without this plan, the pilot publishes thousands of dated events and the only way to see "today" is to scrub plan 30's timeline to the right month and day by hand.

## The day view: one route, one query, one ranking

### 1. The route: `/today` and `/today/MM-DD`

- `/today` renders the day view for the reader's today. `/today/11-19` renders a fixed date and is the shareable, archivable form: a shared "today" must not shift when the reader opens it tomorrow, so every share link, embed, and RSS item uses the dated URL, never bare `/today`.
- `/today` canonicals to the dated URL for the reader's today (plan 38's canonical discipline, applied to a date). The 366 dated pages are stable content — the set for a date only grows as ingestion publishes more — so they are indexed and in the plan 38 sitemap. Bare `/today` is the entry point, not a second canonical.
- A date picker (month/day, no year) sits on the page: any of the 366 dates is one tap away, and the picker is a plain link list, not a calendar widget that needs a year. The day view is deliberately year-free — the point is the date, across all years.

### 2. The query: month/day over published rows, nothing else

- The day query is `month(event_date) = M AND day(event_date) = D` over published events, ordered by plan 46 significance band (high, then standard, then minor) and then by year descending within a band, so the most recent high-band event leads. It is a new query shape, not plan 30's time window: plan 30 fetches a range, this fetches a recurring date across all years. The map renders the same events as pins (plan 30 clustering, plan 51 boundary layers with the cursor date set to the viewed date) and the plan 40 semantic list renders them as the text equivalent.
- Which dates qualify is plan 32's rule, applied strictly: an event appears on a day only if its date carries month/day precision. Year-only events ("1847"), circa dates, and interval events whose bounds span months do not appear on any single day — they belong on the timeline, not on a date. Fuzzy events with a month/day inside their interval appear with plan 32's uncertain marker. This is a deliberate thinning: a day view that shows "1847" on every date in 1847 is a broken view.
- Births and deaths are out of v1. The map is events; people are plan 22 search entities, not first-class rows, and a births/deaths section would need a people-pages plan first. The Wikipedia feed's `births`/`deaths` types are the coverage reference for that future plan, not a v1 scope. A reader who wants people on this date gets the events those people are participants in (plan 49's shared-participant links), not a births list.
- Link-only Britannica rows (plan 28) appear in the day view as link-only rows — date, short factual identifier, link back — exactly as they appear everywhere else. Link-only stays link-only through the day view, per plan 33.
- February 29: in leap years `/today/02-29` is its own date. In non-leap years it redirects to `/today/02-28` with the February 29 events included and labelled "February 29 (leap day)". Leap-day events must not vanish for three years out of four.

### 3. Ranking and the cap: a day is a set, not a dump

- The day view shows the top 10 events by the band ordering, with the rest behind a "show all N events" expansion. The cap is a display decision, not a data decision: the full set is one query away, and the cap keeps the page readable on the dates with hundreds of events. The walterpinem "Today in History" tool caps at 15 events, 12 births, 12 deaths per date from the same Wikipedia feed — 10 with an expansion is the same instinct, one step stricter.
- The hero is the highest-band event with a plan 48 image, shown large at the top with its TASL caption. If no event on the date has an image, the hero is the highest-band event without one — imageless days are a normal state (plan 48), and the page must not look broken on them. Whether the hero is a single "story of the day" (Histoday's model) or just the first item in a flat ranked list (Wikipedia's model) is question 80 — the plan defaults to flat-with-hero and lets James pick.
- Minor-band events obey the plan 46 toggle: hidden behind it at the default view, shown when the reader asks for them. The day view inherits the toggle; it does not re-decide notability.

### 4. Whose "today": reader-local, with the server as fallback

- "Today" is the reader's local date, computed client-side (`Intl.DateTimeFormat` with the reader's time zone). A reader in Auckland and a reader in Honolulu on the same UTC day are on different dates, and the map shows each their own. The server renders with UTC as the fallback for the first paint and for crawlers, then the client corrects to local time if it differs — the same first-paint-then-correct shape as any localised date display. The dated URL always wins over the computed date: `/today/11-19` is November 19 for everyone, everywhere.
- This is the one design decision in the plan most likely to surprise, so it is question 78: reader-local (correct for the reader, two readers disagree) or server-UTC (one canonical "today", wrong for half the world after local midnight). The plan defaults to reader-local.

### 5. Delivery: the page, the dated URL, and an RSS feed — no accounts, no email in v1

- The page is the product. The dated URL is the share. The RSS/Atom feed (`/today/feed.xml`, one item per day, the day's top events as the item body with links to the plan 38 detail pages) is the no-account daily delivery: it is the subscription mechanism that fits a product with no accounts (plan 52's anonymous-token posture, applied to delivery). A reader who wants "today in history" every morning subscribes to the feed; no email address is collected, no provider is paid.
- Email digest and push notifications are out of v1, deliberately. An email digest needs a provider, a list, and unsubscribes; push needs a service worker and a permission prompt. Both are real products, not features, and the daily-habit apps that do them (9 AM notification, daily quiz) are built around them. Question 79 asks James whether an email digest is ever worth a provider, or whether RSS plus the page covers it. The answer is allowed to be "never" — the feed is the v1 delivery and the question is about v2, not a blocker.
- The quiz is out entirely. Histoday's 60-second quiz and the "On This Day" app's daily challenge are engagement products with their own content and scoring; a quiz on top of the day view is a second plan, not a section of this one. Noted here so nobody adds it as a stretch goal inside this plan's build.

### 6. Caching and counting: a date is the cheapest cache key the product has

- A day's set changes only when a publish lands, so plan 43's CDN caching is trivially effective: 366 cache keys, `s-maxage` long, purge on publish (the same purge plan 43 already owns). The day view is the most cacheable surface on the site — the same date fetched twice is the same cached response, worldwide, all day.
- Plan 44 counts day-view opens by date, which is the measurement that matters: the weekly review learns which dates readers actually open (anniversaries spike; random Tuesdays do not), and that ranking feeds the next source-expansion pass the same way zero-result searches do. A date nobody opens is a date whose coverage does not need improving first.
- The coverage check: once a month, compare the published day-set sizes against the Wikipedia `feed/onthisday/selected` counts for the same dates (a read-only comparison, not an ingestion). A date where the feed has 20 selected events and the map has 2 is a coverage gap with a number on it — the same gap-finding instinct as plan 44's zero-result review, applied to dates instead of searches. The check is a script, not a pipeline stage, and its output is a line in the review queue's weekly summary.

## Surfaces

- **`/today` and `/today/MM-DD`:** the day view. Map filtered to the day's events (plan 30 clustering, plan 51 boundaries at the viewed date), plan 40 semantic list as the text equivalent, hero event with plan 48 image, "show all" expansion, date picker, RSS link. Plan 42 bottom sheet at narrow widths; plan 50 playback can start from the day (play forward from the viewed date) but never autoplays on load.
- **`/today/feed.xml`:** the RSS/Atom feed, one item per day. No accounts, no tracking beyond plan 44's aggregate counts.
- **Homepage module (stretch, same plan):** a "Today in history" strip on the home page showing the top 3 events for the reader's today with a link to `/today`. It is the same query with a limit of 3, not a second feature. If the home page has no module slot, it ships without the strip — the strip is not the plan.
- **Plan 55 embeds:** a day view is embeddable the same way any view is — `/embed?date=11-19` renders the day's events in the chrome-less frame with the attribution bar. No separate embed work.

## What this plan does not do

- No ingestion of the Wikipedia on-this-day feed or the Muffinlabs day JSON as day data: the day view is a query over published rows. The feed is a coverage reference (section 6) and Muffinlabs is plan 29's source #3, which the day view benefits from without depending on.
- No births, deaths, or holidays sections in v1: those need people and observance models the map does not have yet. The Wikipedia feed's types are the reference for the future plan, not a scope to absorb here.
- No email digest, no push notifications, no daily quiz in v1: delivery is the page plus RSS. Email is question 79; notifications and quiz are separate plans if James ever wants them.
- No year-scoped day pages (`/today/1969-11-19`): the day view is month/day across all years. A single-year day is a timeline position, and plan 31's share state already expresses it.
- No editorial "story of the day" writing: the hero is a ranking outcome (highest band + image), not a written piece. If James wants a written daily story, that is an editorial plan with an author, not a query.
- No curated-seed special case: the day view serves published rows only. Before the plan 26 pilot's first published set, `/today` redirects to `/map` — the route must not become the thing that keeps the 44 curated events alive (same rule as plan 55).

## Sequencing

- After the plan 26 pilot's first published set: a day view over the 44 curated events is a thin demo, and the feature must not launch on seed data. The pilot is the prerequisite, not the timeline.
- After plans 30 (the query shape it adapts), 32 (which dates qualify), 38 (detail pages, sitemap, canonicals), 40 (semantic list), 46 (ranking bands), and 48 (hero images).
- After plan 43 (date-keyed CDN caching) and plan 44 (counting day opens by date) — both are load-bearing for a surface whose traffic concentrates at the same hour every morning.
- Before any public launch: "what happened today" is the natural first share on launch day, and the RSS feed is the launch announcement's subscription path. The launch post links to today's date, not to the map.
- Not a plan 26 pilot blocker — the pilot validates ingestion; the day view is the pilot's output made into a daily habit, the same way plan 54 is the output made portable as a file and plan 55 is the output made portable as an embed.

## Done when

- `/today` renders the reader's local date with the day's events as pins and as the plan 40 semantic list, ordered high/standard/minor then year descending, top 10 with a "show all" expansion.
- `/today/MM-DD` renders a fixed date for any of the 366 dates, canonicals correctly, and is in the plan 38 sitemap; a shared dated link never shifts.
- Year-only, circa, and interval-spanning events never appear on a single day; fuzzy events with a month/day appear with plan 32's uncertain marker; link-only Britannica rows appear as link-only.
- `/today/02-29` works in leap years and redirects to February 28 with the leap-day events labelled in non-leap years.
- `/today/feed.xml` serves one item per day with links to plan 38 detail pages, no account, no email collection.
- The day view is cached per date under plan 43 and counted by date under plan 44; a burst at the same morning hour does not degrade the map.
- Before the pilot's first published set, `/today` redirects to `/map` instead of serving the curated seed.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- "Today": the reader's local date (correct for the reader, two readers disagree) or server UTC (one canonical today, wrong for half the world after local midnight)?
- Delivery: is an email digest ever worth a provider and a list, or do the page plus the RSS feed cover the daily habit?
- Hero: one featured "story of the day" (Histoday's model, an editorial pick) or a flat ranked list led by the highest-band event with an image (Wikipedia's model)?
