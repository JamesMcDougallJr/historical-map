# Event media: images from Wikimedia Commons

**Related:** [00-README.md](./00-README.md) (phases 05-09), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table), [11-identity-and-fusion.md](./11-identity-and-fusion.md) (dedup), [13-similarity-and-fusion.md](./13-similarity-and-fusion.md) (judge), [25-product-backlog.md](./25-product-backlog.md) (product step #24), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, P18 fetch), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (popups, clustering), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (license declarations, attribution snapshots), [34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md) (review queue), [36-geoparsing-place-disambiguation.md](./36-geoparsing-place-disambiguation.md) (gazetteer cache), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages), [40-accessible-map-experience.md](./40-accessible-map-experience.md) (alt text), [42-mobile-map-experience.md](./42-mobile-map-experience.md) (bottom sheet, thumbs), [43-public-read-surface-protection.md](./43-public-read-surface-protection.md) (caching, rate limits), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (image demand), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands), [47-multilingual-events-i18n.md](./47-multilingual-events-i18n.md) (labels, display_lang).

**Changelog:**
- 2026-11-11 — First version. Fills the gap the global pilot opens: plan 26 ingests events as text-only rows, and no plan owned whether an event gets a picture, where that picture comes from, or how its licence is honoured — while the surfaces that would show one (plan 30 popups, plan 38 detail pages, plan 42 bottom sheet) are already designed.

## Why this plan exists

A map of history with no pictures is a spreadsheet with pins. The comparable products all learned this: Histropedia lets an editor pick a picture per event (and its timelines without pictures read as bare lists), Histography renders every event as an identical black dot, and the photo-led timelines (Arvren, Historypin) are built around the image first. The map's own surfaces already assume media will exist — plan 38 detail pages and plan 30 popups have a visual slot with nothing specified to fill it — but no plan says where an image comes from, what licence it carries, or what happens when the source image is wrong.

The free source is already in the pipeline's hands:

- **Wikidata P18 (image)** is the standard property for a freely licensed illustration of an item: ~5.79M main-statement uses across Wikidata (Property talk:P18, 2025 snapshot). It returns a Commons filename, not a URL — the adapter resolves it through the Commons API. P18 is "exemplary, representative, unambiguous, and high quality" by the property's own usage notes, and more specific properties (coat of arms, flag, locator map) exist for cases where P18 would be the wrong kind of picture.
- **Wikimedia Commons** holds 100M+ freely licensed files (2026) — public domain or CC BY / CC BY-SA, all reusable with attribution. Fair-use images are *not* on Commons (they live on Wikipedia itself), so P18 can only ever yield freely licensed media — which is exactly what plan 33's licensing gate needs.
- **The metadata is machine-readable.** `action=query&prop=imageinfo&iiprop=url|extmetadata` with `iiextmetadatafilter=LicenseShortName|LicenseUrl|Artist|AttributionRequired` returns the licence short name, artist, and whether attribution is required, parsed from the file description page by the CommonsMetadata extension. `iiurlwidth` returns a scaled thumbnail URL (max 50 scaled images per request). The Core REST API v1 (`api.wikimedia.org/core/v1/commons/file/`) is the newer route for file metadata and binary downloads. A custom User-Agent is required (403 without one); anonymous traffic is capped around 100-200 requests/minute per IP cluster-wide (March 2026 limits).

Without this plan, three things go wrong at publish time: events ship imageless and the detail pages look unfinished, or a coding agent hotlinks Commons thumbs with no attribution and no licence record (a copyright problem, not a cosmetic one), or the pilot silently publishes P18 images that depict the wrong thing — a portrait where a battle belongs — because nobody owned the relevance check.

## The media model: four decisions

### 1. One hero image per event, from P18, fetched in the pilot

- The plan 26 pilot adds an `OPTIONAL { ?item wdt:P18 ?image }` to its SPARQL (and the label fetch already resolves the item, so the filename arrives with the event). The pilot measures P18 coverage per class — the number that sizes this work — alongside the language coverage plan 47 measures.
- v1 takes the P18 claim with the highest rank (preferred over normal); if several P18 claims tie, the first by statement order, recorded so the choice is reproducible. No gallery in v1, no second image, no `depicts` (P180) expansion — one hero image keeps the publish contract simple and the review queue legible.
- The Wikipedia lead image (`prop=pageimages`) is the fallback *only* where the event has a sitelinked article and no P18 — it is usually the same file, so the fallback is a coverage patch, not a second source. Britannica link-only records (plan 28) get no image: there is no free image to fetch, and a scraped one would break the link-only rule.
- P18 filenames are validated before use: the property's format constraint lists placeholder values ("no free image", "image is needed", "Insert image here", and others) that must be rejected, and a filename that resolves to a deleted file is a publish-stage failure, not a silent blank. The pilot records the rejection rate.

### 2. Download to our S3 at publish; never hotlink in v1

- Commons *allows* hotlinking (`Special:FilePath` with a `width=` parameter, or the `upload.wikimedia.org/.../thumb/` URL from `imageinfo`), but its own reuse guide says it is "not generally recommended": anyone can change, vandalise, rename, or delete a hotlinked image, and the map would serve whatever the current file is. A historical map that shows a vandalised image for the Battle of Hastings is a data-integrity failure, and plan 37's lifecycle has no hook to notice it.
- So: at publish time the adapter downloads the file (original, plus the thumbnail widths the surfaces need) into the S3 the repo already runs for production documents, keyed by content hash, and serves it from the map's own domain. The event row stores the Commons filename, the file-page URL, the SHA-1 from `imageinfo`, and the licence snapshot (decision 3) — never a bare hotlink.
- Cost is bounded: one hero image per event, thumbnails generated once at publish (the widths plan 30/38/42 need — verify against those plans, do not invent a size table here), and plan 43's CDN caching applies to the media routes exactly as it does to map data. The pilot measures median file size per class so the storage estimate is real before source #3 multiplies the count.
- The download respects the Commons API limits: one request per file, batched `imageinfo` calls (50 files per call), a descriptive User-Agent identifying the project, and backoff on 429 — the same posture plan 27's curl ingestor already takes toward sources generally.

### 3. Attribution is stored with the image, shown with the image

- Per plan 33, the image is a licensed dataset with a per-file declaration. At publish, the adapter snapshots the `extmetadata` for the file: `LicenseShortName`, `LicenseUrl`, `Artist`, `AttributionRequired`, and the Commons file-page URL. The snapshot is stored with the event (same mechanism as plan 33's licence snapshots at publish), so a later licence change on Commons does not rewrite history silently — plan 37's change detection re-checks it on the same schedule as other source changes.
- Display rule (TASL: Title, Author, Source, Licence): every rendered image carries a caption line — "Photo: [Artist] / [Licence] via Wikimedia Commons", each element linked (artist where a link exists, licence deed, Commons file page). Public-domain images need no attribution legally, but the caption still shows the source link: a reader should always be able to reach the file page. The caption is part of the image component, not optional chrome — a surface that shows the image without its caption is a bug.
- Licence gate: only files whose `LicenseShortName` parses to an allowed licence (CC0, public domain, CC BY, CC BY-SA — verify the allow-list against plan 33) publish. Anything unparseable, or a licence outside the list, goes to the plan 34 review queue instead of the map. Non-free content never reaches the publish stage, because P18 cannot supply it; if a future source can, that source gets its own licence gate in its own plan.

### 4. Relevance is a measured property, not an assumption

- P18 is "representative" of the *item*, and the item is not always the event: a battle's item may carry a portrait of its commander, a town's item a skyline, a treaty's item a scan of the document. Some of those are good hero images; a portrait for a battle is a defensible illustration, a locator map is not. The pilot measures the mismatch rate by sampling published images per class and recording how often a human judge would call the image wrong for the event — the same audit-sample discipline plan 34 uses for publish decisions.
- Until that measurement lands, the rule is: P18 as-is, with a report path. Plan 39's correction form gains an "image is wrong / misleading" reason, and a reader report routes the event's image to the plan 34 review queue, where the reviewer can clear the image (event ships imageless until a better one is chosen) or keep it. No automatic image removal from reports alone, and no LLM image-relevance judge in v1 — the pilot measurement decides whether one is worth building.
- Merged events (plans 11/13) keep the surviving event's image: the merge winner is the higher-significance-band event (plan 46), and its image wins with it. If the loser had the better image, that is a review-queue decision, not an automatic swap — the merge must not silently discard the only good picture.
- Events with no image ship imageless, with the layout designed for it (plan 38 detail page, plan 30 popup, plan 42 sheet all reserve no broken-image box and no grey placeholder rectangle). An absent image is a normal state, recorded in the pilot's coverage measurement, and plan 44 analytics reports image presence against engagement so the value of the work is measured rather than assumed.

## Surfaces

- **Plan 38 detail page:** hero image above the title, full caption line, `loading="lazy"` below the fold is not applicable (it is the hero — eager, with width/height reserved so there is no layout shift). Open Graph image (`og:image`) uses the hero where one exists, which is what makes shared event links show a picture instead of a blank card.
- **Plan 30 popup / plan 42 bottom sheet:** a small thumb (the publish-generated thumbnail width), caption truncated to artist + licence on one line with a tap/hover to expand. No image in the cluster view — clusters are counts, not galleries.
- **Plan 40 accessibility:** `alt` text is the event title plus the image's role, never the Commons filename; a purely decorative crop gets `alt=""`. The caption line is real text, not baked into the image, so screen readers and translation both reach it. `dir="auto"` on the caption, per plan 47.
- **Plan 31 share links:** the locale prefix is unaffected; the image is a property of the event, not of the link.

## What this plan does not do

- No gallery, no multi-image events, no video or audio in v1 (Commons hosts both; the model extends to them, but the publish contract, captioning, and thumbnailing for video are a later plan).
- No generated or AI images: a missing image stays missing. A synthesised "illustration" of a historical event would be a fabrication on a map whose promise is sourced history.
- No hotlinking in v1. No scraping of Commons HTML — API only.
- No image-based search (plan 19 stays text). No cropping or editing of images at publish — a crop is a modification that CC BY-SA attribution must disclose, so v1 serves the file as-is and crops only at display time via CSS.

## Sequencing

- Lands with the plan 26 pilot: the pilot fetches P18, measures coverage and rejection rate per class, and records median file size. The publish-stage download and licence gate are pilot deliverables, not later additions — an event published without its licence snapshot is a plan 33 violation.
- After plan 33 (the licence gate and snapshot mechanism this plan reuses) and plan 47 (captions and alt text follow the language model; `display_lang` is set before the caption is rendered).
- Before plan 29 source #3: Muffinlabs events inherit the P18 fetch through the same Wikidata item link, but the model must exist before a second image-bearing source arrives — and any source #3 that is not Wikidata-linked gets its own image decision in its own plan.
- Plan 38 detail pages, plan 30 popups, and plan 42 sheets gain their image slots as part of this plan; plan 43 caching covers the media routes; plan 44 reports image presence vs engagement.

## Done when

- Every published event carries either a hero image (Commons filename, file-page URL, SHA-1, licence snapshot) or an explicit `image: none` state — never a dangling filename, never a hotlink.
- The publish gate rejects unparseable licences and placeholder filenames; both route to the plan 34 review queue.
- Images are served from the map's own S3/CDN, with thumbnails generated at publish; no request path touches `upload.wikimedia.org` at read time.
- Every rendered image shows its TASL caption with links to artist, licence deed, and file page.
- The pilot reports P18 coverage, rejection rate, and median file size per class; the relevance audit sample is recorded and its mismatch rate is a named number, not a feeling.
- Plan 39 corrections accept an image-wrong report; merged events keep the winner's image.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- Hero-image relevance: publish P18 as-is and rely on reader reports (plan 39) to catch wrong images, or hold images back until a human/LLM check verifies each one depicts the event?
- Serving: download to our S3 at publish (Commons' recommendation, full control, storage cost) or hotlink Commons thumbs (zero storage, but a vandalised or renamed file changes what readers see)?
- Imageless events: leave them imageless, or fall back to a non-photo visual (e.g. a period map-tile crop of the location) so no event page is bare?
