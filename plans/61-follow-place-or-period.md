# Follow a place or period: watch alerts when the map gains events you care about

**Related:** [00-README.md](./00-README.md) (phases 05-09), [25-product-backlog.md](./25-product-backlog.md) (product step #37), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, publish path), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (viewport + time-window query), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date model), [37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md) (versions, merges, tombstones), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages), [41-sequence-journeys.md](./41-sequence-journeys.md) (sequences), [43-public-read-surface-protection.md](./43-public-read-surface-protection.md) (rate limiting, caching), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (aggregate measurement, zero-result demand), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands), [49-event-relationships.md](./49-event-relationships.md) (relationships), [52-saved-collections.md](./52-saved-collections.md) (collections, anonymous owner token), [53-reader-event-suggestions.md](./53-reader-event-suggestions.md) (suggestions), [56-on-this-day.md](./56-on-this-day.md) (daily view, RSS feed), [57-offline-map-experience.md](./57-offline-map-experience.md) (service worker), [59-public-read-api.md](./59-public-read-api.md) (read API), [60-coverage-and-gaps.md](./60-coverage-and-gaps.md) (thin areas, demand signal).

**Changelog:**
- 2026-11-24 - First version. Fills a gap no plan owned: the map publishes continuously (plan 26 pilot, plan 37 lifecycle), but a reader who cares about one place or one era has no way to know when something new appears there. Plans 52, 56, 59 and 60 touch adjacent pieces - keeping, a daily view, a read API, a demand signal - but none owns the return visit. This plan is the follow: what a reader watches, how they hear about it, and how the product stays quiet enough to be worth following.

## Why this plan exists

Every product that treats attention as something to earn, not extract, converges on the same small set of rules, and the ones that break them are the cautionary tale:

- **Wikipedia's watchlist** is the oldest working model and still the sharpest: a follow is private by design (no one, not even an administrator, can see what you watch or who watches a page), the feed marks changed pages in bold until you visit them (read/unread, like an inbox), and email has a re-arm rule - once you miss an email for a page change and do not visit the page, you get no more emails for that page until you do. That last rule is the whole lesson: the system stops shouting at people who stopped listening. MediaWiki also ships watchlist expiry (watch a page for a temporary period) and a token-authenticated RSS/Atom feed of your watchlist, so following works without an account session at all.
- **Google Alerts** is the query-shaped version of the same idea: the follow is a stored search, not a page, and the reader picks the cadence (as-it-happens, daily, weekly) and the channel (email or RSS). The lesson this plan borrows is that a follow on a map is naturally a query - a place plus a time window plus filters - not a single event, and the cadence is a property of the follow, not of the product.
- **Web push** is the channel this plan deliberately defers, and the research is why: it is standards-based (Push API + Notifications API + RFC 8030 delivery, RFC 8291 encryption, RFC 8292 VAPID server identity), the `web-push` library handles VAPID signing and per-message encryption, and a 410/404 from the push service means the subscription is dead and must be retired, not retried. But push annoys faster than email because it appears over everything, the guidance is to ask permission only after a reader has shown interest (never on page load) and to segment by interest, and on iOS it arrives only if the reader added the site to the home screen as a PWA (iOS 16.4+). A no-accounts map that asks for push permission on first visit would be doing the thing every push guide warns against. Push becomes viable later, on top of plan 57's service worker, once follows exist and readers have asked for a louder channel - it is a tier, not the first channel.

What no plan owned is the follow itself: what can be followed, what counts as a change worth telling someone about, which channels carry it, and what stops the product from becoming spam the moment the pilot starts publishing in volume. Without this plan, a coding agent building plan 56's RSS feed or plan 52's collections invents following ad hoc - most likely as an unbounded email-per-publish, which is exactly the failure Wikipedia's re-arm rule exists to prevent.

## The follow model: a stored query, four shapes

- A follow is a stored plan 30 query: viewport (bounding box, or a place id, or a plan 60 H3 cell) plus a time window (plan 32 bounds) plus the filters the map already has (band, source, search text). Four shapes in v1, all the same stored query with different defaults:
  - **Place:** a bounding box the reader drew, or a place id (a town, a county, a battlefield). Fires when a published event lands inside it.
  - **Period:** a date window (a decade, a century, a single year). Fires when a published event lands inside it, anywhere on the map.
  - **Event or sequence:** one published event (plan 38 id/slug) or one plan 41 sequence. Fires only on lifecycle change (plan 37): a merge, a split, a tombstone, a correction applied - never on a new version row that changes nothing the reader sees.
  - **Collection:** a plan 52 collection. Fires when the reader adds an event to it themselves (a reminder, not an alert) or when a followed event in it changes lifecycle state.
- A follow is created from the surface where the reader already is: "follow this area" on the map, "follow this decade" on the timeline, "follow this event" on a plan 38 detail page, "follow this collection" in plan 52. No separate follows page to discover; the button lives where the interest forms.
- Follows are private by default, Wikipedia's rule: the map never shows who follows what, and aggregate counts only (plan 44: N readers follow this place) are the only public number. A follow list is never shared, never exported, never a leaderboard.

## Channels in v1: in-app feed, per-follow RSS, weekly digest - no push, no per-event email

- **In-app following feed.** One page listing the reader's follows with unread markers (bold until visited, Wikipedia's rule). Each entry is one event, once, with the plan 58 certainty labels and the plan 32 display string - never a raw midpoint. Merged events appear once, under the surviving id with the plan 37 "moved" note; tombstoned events appear once as "removed". The feed is the quiet channel: it never interrupts, it waits.
- **Per-follow RSS/Atom feed with a token.** Every follow gets its own feed URL carrying an unguessable token (MediaWiki's `feedwatchlist` pattern), so a reader can follow in their own reader without an account session. The token is revocable per follow, and rotating it invalidates the old URL. The plan 56 daily RSS feed is the same machinery with a fixed query (today's date), which is why this plan reuses it rather than building a second feed system.
- **Weekly email digest, opt-in only, one per reader per week.** One email, all follows, ranked by plan 46 band, capped at ten events with a "more in your feed" link. A digest is skipped entirely in a week with nothing new - no "nothing happened" mail. This is the one place the product collects an email address, and the rules are strict: double opt-in, one address, one purpose (the digest), one-click unsubscribe that actually unsubscribes, never used for anything else, never shared. No per-event email in v1: a publish burst after a pilot run would be a dozen emails in an hour, which is how a follow becomes spam.
- **Web push is deferred to a later tier,** explicitly: after plan 57's service worker ships, after follows exist, and only if readers ask for it - asked for after demonstrated interest, segmented by follow, with quiet hours and a per-follow mute. The VAPID keys and the `web-push` send path are a small build once the service worker exists; the product decision is the hard part, and v1 does not make it.

## The anti-spam rules, borrowed and adapted

- **Re-arm rule (Wikipedia, adapted):** if a reader does not open three consecutive digests, digests pause and the next visit shows one line - "your digest is paused, resume?" - instead of a fourth unread email. Ignored mail stops; it does not pile up.
- **Expiry (MediaWiki watchlist expiry):** a follow defaults to one year, then lapses with one notice ("your follow on 19th-century Utah expired - renew?"). A lapsed follow sends nothing and shows as lapsed in the feed. Permanent follows are an explicit choice, not the default.
- **Batching:** one feed entry per event per digest, however many lifecycle rows plan 37 wrote for it. A merge that also corrects a date is one entry, not two.
- **Quiet hours and caps:** digests send in the reader's morning (their plan 56 local-today rules), never overnight; a single follow that matches more than ten events in a week is summarised ("12 new events in this area, top 10 shown") rather than listed in full.
- **No follow on the seed:** follows fire only on pilot-published rows, never on the 44 curated events - the seed is slated for deletion (standing directive 2026-10-20) and following it would alert readers about rows that are about to disappear.

## No accounts: follows inherit plan 52's identity model

- Plan 52 v1 is device-local lists with an anonymous owner token as the only credential and no accounts. Follows inherit exactly that: a follow lives on the device, the owner token is the credential, and the per-follow RSS token is derived from it. A reader who wants their follows on a second device exports them as an OPML file (the RSS world's standard list format) and imports it there - no account, no sync server, no password.
- Plan 52 v2 (server-stored collections, shareable by link) is the moment follows can become server-stored too, under the same anonymous token. Follows do not pull accounts into v1; they wait for plan 52 v2's identity decision.
- Deletion is total: deleting a follow deletes its RSS token, its digest subscription if it was the last follow, and its feed entries. There is no retained "unsubscribed but still listed" state.

## What following measures: the strongest demand signal the map has

- Plan 44's weekly zero-result review shows demand where readers searched and found nothing. A follow is stronger: a reader who follows a thin area is saying "tell me when this changes", which is intent, not just a failed query. Plan 44 gains a follows table: follows per place bucket, per century, per source - the same buckets as plan 60's coverage view.
- The internal feed pairs the two: a bucket with high follows, low plan 60 coverage ratio, and a flat publish rate is the next source or the next pilot-class whitelist change, ahead of a bucket with only zero-result searches. The plan 29 source-expansion decision for the next source cites follows alongside zero-result demand.
- The plan 59 public API gains `GET /v1/follows` only as an authenticated (token) read of the caller's own follows, never anyone else's - and no aggregate follows endpoint until plan 44 decides what aggregate is safe to publish.

## What this plan does not do

- No web push in v1 (deferred tier, above), no per-event email, no SMS, no in-app notification bell that badges on every publish. The feed waits; it does not interrupt.
- No social following: no following other readers, no public follow lists, no "readers who follow X also follow Y". The map is not a social product.
- No algorithmic ranking of the digest beyond plan 46 bands and recency: no engagement optimisation, no "you might also like". A follow is a query the reader wrote; the digest runs it, nothing more.
- No follow on unpublished, review-queue, or tombstoned rows (plan 37's never-show list is the never-notify list too), and no follow on the curated seed.
- No paid notification infrastructure in v1: RSS is static files, the digest is a weekly batch job on the existing ingest worker host (plan 10), and the in-app feed is a Postgres query over published rows. If digest volume ever justifies a provider, that is a plan 34 cost-ledger decision, not a v1 build.

## Sequencing

After the plan 26 pilot's first published set (follows over the 44 curated events would alert readers about rows slated for deletion), after plans 30 (the query a follow stores), 32 (date windows), 37 (lifecycle changes are the trigger), 44 (the measurement), 52 (collections and the identity model), 56 (the RSS machinery it reuses) and 60 (the coverage buckets it pairs with). Before public launch: launch-day readers who follow a thin area are the readers most likely to come back, and a launch without follows wastes the only return-visit mechanism the map has. Not a plan 26 pilot blocker - the pilot can publish without it, and follows are the first thing that turns publishing into an audience.

## Done when

- A reader can follow a place, a period, an event or a collection from the surface where the interest forms, and the follow is stored as a plan 30 query with the same semantics as the map's own filters.
- The in-app feed lists new published events per follow with unread markers that clear on visit, merges and tombstones shown once with the plan 37 note, never as silent changes.
- Each follow has a token-authenticated RSS/Atom feed; rotating the token invalidates the old URL; the plan 56 daily feed reuses the same code.
- The weekly digest sends at most one email per reader per week, skips empty weeks, caps at ten events, and pauses after three unopened digests with a resume prompt - verified by a test that simulates three unopened digests and asserts the fourth is not sent.
- Follows expire after one year by default with one renewal notice; deleting a follow deletes its token, its digest subscription if it was the last, and its feed entries.
- Plan 44 records follows per place, century and source bucket, and the next plan 29 source-expansion decision cites follows alongside zero-result demand.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open questions for James

93. Channels in v1: in-app feed plus per-follow RSS plus a weekly email digest, or RSS-only until there is evidence readers want email at all?
94. Email: collect addresses for the digest (double opt-in, one address, one purpose) or stay address-free and let RSS carry following until plan 52 v2?
95. Follow scope in v1: place, period, event and collection all at once, or place-only first and expand after measuring which shape gets used?
