# Embeddable map widget: put the live map on any site

**Related:** [00-README.md](./00-README.md) (phases 05-09), [25-product-backlog.md](./25-product-backlog.md) (product step #31), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (viewport + time-window query, default view), [31-shareable-map-state.md](./31-shareable-map-state.md) (share-state URL params — the embed URL reuses them), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (attribution, Sources line), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages as click targets), [40-accessible-map-experience.md](./40-accessible-map-experience.md) (semantic list, keyboard, aria-live), [41-sequence-journeys.md](./41-sequence-journeys.md) (journey player), [42-mobile-map-experience.md](./42-mobile-map-experience.md) (bottom sheet, breakpoints), [43-public-read-surface-protection.md](./43-public-read-surface-protection.md) (rate limits), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (embed-view counting), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands), [48-event-media-wikimedia-commons.md](./48-event-media-wikimedia-commons.md) (images), [50-temporal-playback.md](./50-temporal-playback.md) (playback stays paused in embeds), [51-historical-base-maps.md](./51-historical-base-maps.md) (anachronism rule applies in embeds), [52-saved-collections.md](./52-saved-collections.md) (collections render as a filtered view — embeddable too), [54-data-export.md](./54-data-export.md) (export is data out; this plan is the live map out).

**Changelog:**
- 2026-11-18 — First version. No plan owned letting another site carry the live map: plan 31 made a view linkable and plan 54 made the data downloadable, but a teacher, a blogger, or a local-history site that wanted the map itself on their page had no way to put it there.

## Why this plan exists

Every comparable that gets used in classrooms and on blogs ships an embed, and they all converged on the same shape: a copy-paste iframe, no account, no key.

- **Histropedia** sells save, share, and embed as one feature set — timelines are published as a standalone page or embedded seamlessly into any website or intranet — and its HistropediaJS library is a drop-in script-tag integration for the same content. Embed is distribution, not a side feature.
- **Google Maps** is the canonical pattern: Share → Embed a map generates a ready-made `<iframe>`, paste it into HTML, and the map works — no API key and no billing account for the basic embed, free with no usage caps for standard interactive maps. The URL-parameter Embed API adds place/directions/search modes with a key, but the plain share-embed needs none of that.
- **Knight Lab TimelineJS and StoryMapJS** both end their authoring flow the same way: copy the embed code beginning with `<iframe src="...` and paste it into the host page (Omeka, WordPress, a plain HTML file). The tools that win in education win on that one copy-paste step.
- **TimeMapper** (OKFN) does Publish → Embed: paste a spreadsheet URL, publish, click Embed, and get the HTML to insert into your own site. Same shape again.
- **The sizing problem is solved and the solution is old:** an iframe cannot see its content's height, so the child reports it — a `ResizeObserver` in the frame plus `postMessage` to the parent, with the parent matching the sender by `event.source` (not by URL, so two embeds of the same page on one host page do not get confused) and validating the origin. The historymap write-up (July 2026) documents exactly this pattern for a timeline embed, and widget systems like A2Z's Smart Embed do the same with a ~4 KB loader, lazy creation 400 px before the viewport, and height messages clamped to 80–5000 px. Chrome 154 (September 2026) adds native responsive iframes (`frame-sizing: content-height`), which replaces the postMessage dance eventually — but it is one browser generation old, so this plan treats it as progressive enhancement, never the mechanism.
- **The map has the pieces and no embed:** plan 31 already defines the full share state as URL params (`lat`, `lng`, `z`, `from`, `to`, `q`, `event`) with validation and fallbacks; plan 30 already fetches by viewport + time window, which is exactly what an embedded view needs; plan 40 already has a semantic list that works without seeing the map; plan 43/44 already own the rate limiting and the counting that an embed's multiplied traffic needs. What no plan owned is the frame itself — the chrome-less route, the snippet, the attribution bar, the escape hatch back to the full map, and the rule for what an embed may and may not do. Without this plan, one of three things happens: a coding agent ships an embed that is just `/map` in an iframe with the full header and nav (a broken-looking frame inside someone else's page); or the first popular embed hammers the map-data endpoints and plan 43 rate-limits it as abuse because nobody planned for embed traffic; or teachers keep screenshotting the map, and every screenshot is a stale, unlinked, unattributed copy.

## The embed model: one route, one snippet, one attribution bar

### 1. The embed route: `/embed`, chrome-less, same state as plan 31

- `/embed` renders the map and nothing else that belongs to the site: no site header, no nav, no search chrome beyond what the view needs. It accepts exactly plan 31's params (`lat`, `lng`, `z`, `from`, `to`, `q`, `event`) with plan 31's validation and fallbacks — a bad embed link degrades to the plan 30 default view, never a whitescreen. The embed URL is a plan 31 share link with the route swapped: `/map?lat=…&event=…` becomes `/embed?lat=…&event=…`, so every shared view is already an embeddable view and no second state shape exists.
- What the embed keeps: the map itself (plan 30 clustering, density-aware zoom, timeline), the plan 40 semantic list as the below-map / toggleable text equivalent, the plan 42 bottom sheet at narrow widths, plan 46 significance bands and their toggle, plan 51 boundary layers with the same date-labelled toggle and the same anachronism rule, and plan 48 images in popups. An embed is the map, not a screenshot of it.
- What the embed drops: site navigation, the import/admin surfaces, the plan 54 export panel (a reader who wants the data follows the escape link to the full map — the export lives there, not in the frame), the plan 53 suggestion form, and the plan 41 journey authoring surface. A plan 41 journey can be the embed's subject (`sequence=<id>&step=<n>` rides in the URL like plan 31's params), but the journey player inside an embed is view-only.
- Plan 50 playback inside an embed is paused on load and stays paused unless the reader presses play: an embedded map that starts animating on someone else's page is the fastest way to get embeds removed. Shared links already open paused per plan 50; embeds inherit that.
- Plan 52 collections are embeddable the same way: a collection renders as a filtered map view, so its share link is an embed URL too. The collection's owner token never travels in the embed URL — a shared collection link is the public view, and the token stays out of it.

### 2. The snippet: a plain iframe first, a loader second

- The Share panel on `/map` (next to plan 31's copy-link) gains an Embed tab: size presets plus a copy-snippet button. Presets are width 100% with a fixed height (responsive 100% × 480 px default, 640 × 480, 800 × 600) — width fluid, height explicit, because a map's height is chosen by the embedder, not measured from content. CSS `aspect-ratio` (universal since 2023) is the documented alternative for hosts that want a ratio instead of a fixed height.
- The v1 snippet is a plain `<iframe>` and nothing else: `src` is the `/embed` URL, `width="100%"`, an explicit `height`, `loading="lazy"`, `title="History Map: <view description>"` for screen readers, and `referrerpolicy="strict-origin-when-cross-origin"` so plan 44 can count by Referer. A plain iframe works everywhere scripts are stripped (Wix Embed HTML, Google Sites — the A2Z docs call this out as the reason the simple embed exists), which is exactly where teachers paste things.
- No `sandbox` attribute in the v1 snippet: a sandboxed frame without `allow-same-origin` puts the map in an opaque origin and breaks the map's own storage and same-origin reads; a host that wants sandboxing can add it, but the generated snippet does not pretend it is safe by default. This is a documented tradeoff, not an oversight.
- The loader script is v2, not v1: a ~4 KB script (A2Z's Smart Embed is the model) that turns placeholders into iframes, lazy-creates them near the viewport, and resizes by `postMessage` with origin validation and clamped heights. It is not needed in v1 because the map's height is fixed by the preset — the ResizeObserver + postMessage pattern solves unknown-height content, and a map embed has no unknown height. If a later embed variant has variable height (a semantic-list-first embed, a journey player), the loader is the mechanism, already researched here.
- Chrome 154's `frame-sizing: content-height` is noted as progressive enhancement for that later variant, not used in v1: one browser generation is too young to be the sizing story.

### 3. The attribution bar: mandatory, non-removable, and the price of embedding

- Every embed carries a slim bar at its foot: "History Map" (link to the full `/map` view, `target="_top"` so it breaks out of the frame), the plan 33 Sources line for the events in view, and the license. The bar is part of the embed route's render, not a host-side element — a host cannot remove it by editing the snippet, and stripping it with CSS is a terms violation, not a supported configuration. This is the same rule as plan 54's file-level attribution, applied to a live view: attribution travels with the map the way it travels with the file.
- The bar is also the escape hatch: "Open full map" opens the same view on the full site (`target="_top"`), and event popups inside the embed offer "View event" which opens the plan 38 detail page in a new tab — never navigating the host page. An embed must never trap a reader inside the frame and must never hijack the host page's navigation.
- Plan 38 detail pages are the click targets: an event click inside the embed opens the existing popup in-frame (plan 31's `event` param behaviour), and the popup's detail link opens `/events/<slug>` in a new tab. The embed never renders a detail page inside itself.

### 4. Traffic, abuse, and counting: embeds are plan 43 traffic with a Referer

- Embeds multiply map-data requests: one popular blog post is many readers hitting the same viewport + time-window query. Plan 43's per-endpoint limits apply to embed traffic exactly as to direct traffic — same limits, same CDN caching per query hash (the same embedded view fetched twice is the same cached response), no separate embed quota in v1. A burst test from a single Referer is part of the done-checks, not an afterthought.
- Plan 44's server-side event log counts embed views by Referer (the header the snippet deliberately sends), with no per-user tracking and no cookie. The weekly review can see which hosts drive traffic before any blocking decision is ever made. A runaway embed is visible first and blocked only after — the review loop, not a rate limit, is the abuse control in v1.
- No API key in v1, no allowlist in v1: Google's basic share-embed needs no key, and this plan copies that call — the friction of keys kills the classroom use case that makes embeds worth building. The allowlist question is open to James (question 75), and if he wants it, it is a `frame-ancestors` allowlist plus a per-host key, not a redesign: the embed route already has a single entry point to gate.
- Framing headers are a real step, not an assumption: the coding agent must first verify what the app currently sends (`X-Frame-Options`, `Content-Security-Policy` `frame-ancestors`) and set the embed route to allow framing while the rest of the site keeps its existing policy. If the app currently denies framing site-wide, the embed route is the deliberate, narrow exception — documented in the route, not a global loosening.

### 5. Search engines and the canonical view

- The embed route sends `X-Robots-Tag: noindex` (and no Open Graph tags): search engines index the canonical `/map` view and the plan 38 detail pages, never the chrome-less frame. An embed is a view of a page, not a page.
- The embed route is not a second sitemap entry and not a second canonical URL. Plan 38's sitemap/robots work is untouched.

## Surfaces

- **`/map` Share panel:** an Embed tab beside copy-link, with size presets, a live preview of the snippet's dimensions, and a copy button. The tab shows the attribution-bar note ("embeds always carry a History Map bar") so nobody is surprised by it.
- **`/embed` route:** the chrome-less map. Same OpenLayers map, same timeline, same popups, same semantic list, same bottom sheet — minus site chrome, minus export/suggestion/admin surfaces.
- **Attribution bar:** inside the embed route, always visible, always linked. The one element no preset or parameter may hide.
- **Plan 40 semantic list and plan 42 bottom sheet:** the embed's text equivalent and narrow-width behaviour come from these plans unchanged — an embed at 360 px wide is a plan 42 view, not a special case.

## What this plan does not do

- No JS embed API in v1: no `postMessage` control channel for the host to drive the map (pan, select, play). The widget-provider pattern (namespaced bidirectional messages, `ready`/`maximize`/`hide` verbs) is the model if a host-driven API ever lands, but v1 embeds are view-only — the host chooses the view in the URL and the reader drives the map.
- No per-host customization in v1: no custom colours, logos, or hidden attribution. A white-label embed is a different product with a different abuse story.
- No oEmbed endpoint in v1: a `/api/oembed` discovery endpoint (paste-a-link auto-embed in WordPress and classroom tools) is the natural follow-up once embeds exist, but it needs provider registration to be useful in WordPress core, and it is low value before any embed is live. Deferred, not forgotten.
- No embed of unpublished, review-queue, tombstoned, or suggestion data: the embed serves published rows only, exactly as the map does. Plan 54's never-export list is the never-embed list.
- No accounts, no per-embed analytics dashboard, no email gate. An embed that demands sign-in is not an embed.

## Sequencing

- After plans 30 (the query the embed reuses), 31 (the URL params the embed reuses), 38 (detail pages as click targets), 40 (semantic list), 42 (narrow widths), 43 (rate limits for multiplied traffic), and 44 (Referer counting).
- After the plan 26 pilot's first published set: embeds serve published data, and before the pilot there is nothing worth embedding except the 44 curated events that are slated for deletion. The embed route must not become the thing that keeps the seed alive.
- Before any public launch: the launch announcement can invite embeds ("put the map on your site") instead of discovering after launch that the map cannot leave the site.
- Not a plan 26 pilot blocker — the pilot validates ingestion from sources; the embed is the pilot's output made portable on someone else's page, the same way plan 54 is the output made portable as a file.

## Done when

- `/embed` renders the chrome-less map from plan 31 params with plan 31's validation and fallbacks, and a bad embed link degrades to the plan 30 default view instead of whitescreening.
- The Share panel's Embed tab copies a working plain-iframe snippet for every size preset, and the snippet pasted into a plain HTML page renders the map with the attribution bar visible.
- The attribution bar is present on every embed, links to the full `/map` view with `target="_top"`, and no parameter hides it.
- Event clicks open popups in-frame; "View event" opens the plan 38 detail page in a new tab; "Open full map" breaks out of the frame; the host page's navigation is never hijacked.
- The embed route sends `X-Robots-Tag: noindex`, carries no sitemap entry, and the framing headers allow the embed route while the rest of the site keeps its existing policy.
- Plan 43's rate limits hold under a burst test against the map-data endpoints from a single Referer, and plan 44 counts embed views by Referer with no per-user tracking.
- An embed at 360 px wide renders as a plan 42 view (bottom sheet, no popup overflow), and plan 50 playback inside an embed starts paused.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- Open embed or allowlist: anyone may embed from day one (the Google share-embed call), or only approved hosts, with everyone else getting a "request embed access" path?
- Attribution bar: always visible at the foot of every embed, or collapsible to a small badge once the reader has interacted with the map?
- Event clicks in an embed: open the plan 38 detail page in a new tab, or keep the reader inside the embed popup with the detail link as a secondary action?
