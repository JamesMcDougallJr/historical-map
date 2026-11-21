# Saved collections: reader-curated sets of events

**Related:** [00-README.md](./00-README.md) (phases 05-09), [25-product-backlog.md](./25-product-backlog.md) (product step #28), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, event volume), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (clustering, viewport + time-window fetching), [31-shareable-map-state.md](./31-shareable-map-state.md) (share links, URL as state), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date model, ordering), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (attribution on shared surfaces), [34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md) (review queue, abuse), [37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md) (merged/tombstoned events), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages, slugs), [39-reader-corrections.md](./39-reader-corrections.md) (reader prose never published), [40-accessible-map-experience.md](./40-accessible-map-experience.md) (semantic list, keyboard), [41-sequence-journeys.md](./41-sequence-journeys.md) (guided tours, journey player), [42-mobile-map-experience.md](./42-mobile-map-experience.md) (bottom sheet, save control), [43-public-read-surface-protection.md](./43-public-read-surface-protection.md) (rate limits on new endpoints), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (save events, no content logging), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands), [47-multilingual-events-i18n.md](./47-multilingual-events-i18n.md) (labels, display_lang), [48-event-media-wikimedia-commons.md](./48-event-media-wikimedia-commons.md) (hero images on saved cards), [49-event-relationships.md](./49-event-relationships.md) (related events), [50-temporal-playback.md](./50-temporal-playback.md) (cursor, playback), [51-historical-base-maps.md](./51-historical-base-maps.md) (boundary layer choice).

**Changelog:**
- 2026-11-15 — First version. Fills the gap every other plan leaves open: the map is read-only and forgetful — a reader finds an event, closes the tab, and it is gone — while every comparable that wins on return visits gives the reader a way to keep what they found.

## Why this plan exists

A map you cannot keep anything from is a map you visit once. The reader's whole journey today ends at the popup: there is no save, no list, no "come back to this". The comparables all learned that keeping is the retention feature, and they learned it in the same shape:

- **Histropedia** lets a reader save a timeline, share it, and embed it — and to save, you sign in; a saved timeline can stay private or be published into the public directory, where anyone can add to it. Saving is what turns a lookup into a thing you own.
- **Atlas Obscura** gives every place three buttons — Been Here, Want to Visit, Add to List — and lists are private by default with one toggle to share. Members build lists around themes, journeys, regions, and personal obsessions; one write-up calls the result "a playlist made from geography". The catch, named by its own users: lists live on the platform, friends must sign up to participate, and there is no co-creation.
- **Google Maps** ships three built-in lists (Favorites, Starred Places, Want to Go) plus unlimited custom lists, capped at 3,000 entries per list. Sharing is at the list level, not the place level: a view-only link anyone can open without an account, or an invite to edit. Starred places cannot be shared at all — the one built-in list that stays private.
- **Apple Maps** (iOS 17+) lets you share a Collection by link, but the recipient needs an Apple device to interact with it fully; its publisher-curated Guides cannot be made public by readers at all.

The map already has the raw material: every published event has a stable id (plan 38 slugs), a date (plan 32), a place, and a hero image (plan 48). What no plan owns is the keeping — where a saved set lives, who can see it, what happens to it when an event is merged or tombstoned, and whether keeping requires an account at all. Without this plan, one of three things happens: a coding agent bolts a localStorage "favorites" star onto the popup with no sharing story and no lifecycle story; or collections are built as accounts-and-passwords before anyone has asked whether the product needs accounts; or shared collections go out as bare URL dumps of event ids that break the first time plan 37 merges one of them.

## The collection model: three decisions

### 1. A collection is a set of event ids plus the reader's own notes — never event edits

- A collection has a title, an optional description, and an ordered list of members. Each member is an event id plus an optional per-item note in the reader's own words. Notes are private to the collection: they are never published as event text (the plan 39 rule — submitter prose is never event content), never indexed, never shown on the plan 38 detail page.
- Member order is the reader's order, not chronological order — a collection is a curation, not a timeline. Chronological order is a view mode (see section 3), not the stored order.
- Collections ignore plan 46's significance bands entirely: a minor-band event a reader chose to keep is kept. Bands order clusters on the public map; they do not overrule a reader's own set.
- **Lifecycle follows plan 37, it does not fight it.** A member event that is merged shows its successor (one hop, the plan 38 redirect rule); a tombstoned member stays in the list as a "removed" entry with its title struck through, never silently deleted — silent deletion is how a reader learns not to trust saving. A split member becomes a disambiguation entry pointing at its successors (plan 38). An unlocated member stays in the list with no pin, exactly as plan 41 treats unlocated journey steps.
- Limits keep the feature honest: 500 members per collection, 20 collections per owner, titles capped at 120 characters. The numbers are small enough that a shared collection renders fast and a share URL stays sane; they are limits, not aspirations — Google Maps allows 3,000 per list and readers still complain long lists are unusable.

### 2. Two tiers: device-local first, server-stored second — and no accounts in either

- **Tier 1 (v1): device-local collections.** Saved in localStorage on the reader's device, no account, no server row, no PII anywhere. The save control lives on the plan 38 detail page and the plan 30 popup (and the plan 42 bottom sheet on mobile): one tap saves to a default "Saved" set, a second tap picks or creates a named list. A reader who never signs in — nobody signs in, there is nothing to sign into — still keeps everything on that device. What tier 1 cannot do is share: a device-local set has no URL, and this plan says so plainly in the UI ("Saved on this device only") rather than letting a reader discover it by sending a link that shows nothing.
- **Tier 2 (v2): server-stored, shareable by link, still no accounts.** A collection is stored in Postgres with a random slug (`/collections/<slug>`) and a separate random owner token. The slug is the read key — anyone with the link can view it, exactly like Google Maps' view-only link, viewable without an account. The owner token is the write key — whoever holds the edit link can add, remove, and reorder, exactly like a document shared with "anyone with the link can edit". There are no passwords, no email addresses, no user rows, and no password-reset flow to build or to breach. The honest trade-off is stated in the product, not buried: lose the edit link and you lose edit access; the collection itself is never lost, and a new owner token can be issued only from a device that still holds the old one.
- **No co-creation in v1 of tier 2.** Atlas Obscura's users name this as the missing piece and Google Maps has it, but shared editing with no accounts means edit-link forwarding is indistinguishable from a new editor, and there is no audit trail to show who changed what. Tier 2 ships view-only sharing plus single-owner editing; collaborative editing is a later plan that starts from the question of whether accounts exist at all (see open question 66).
- **Private by default, always.** A collection is unlisted until its owner shares the link — the Atlas Obscura default. There is no public directory of collections in v1: a directory is a moderation surface (spam, low-effort sets, misleading titles) that would land in plan 34's review queue before the queue has ever reviewed a collection, and the map has no editor to run it. Whether a directory ever exists is a product decision for James, not a quiet default — see open question 67.

### 3. A collection renders as a map view, a list, and optionally a journey

- Opening a shared collection link lands on `/map` filtered to the collection's members: pins for the members, the plan 30 timeline windowed to the collection's date span, the plan 51 boundary layer set to the span's midpoint year. The reader sees the set as a map first, because that is what the product is.
- The plan 40 semantic list is the collection's list view: members in the reader's order, with the per-item notes, the plan 48 hero image as a thumbnail, and the plan 32 date display. On mobile the list lives in the plan 42 bottom sheet. The list is the accessible equivalent and the printable one.
- **Play as journey is a view mode, not a conversion.** A collection opened in chronological order through the plan 41 journey player ("Play this collection") steps through its members one at a time — but it stays a collection: the player does not rewrite the stored order, and the dashed order line is labelled as the reader's order, not a travelled route (plan 41's rule, unchanged). A collection with one member, or with all members unlocated, degrades to the list view with the player hidden, never an error.
- Share links carry the collection slug and nothing else (plan 31): no viewport, no timeline window — the collection defines the view. A shared link opens paused (plan 50), never auto-playing.

## Abuse, privacy, and measurement

- A server-stored collection is user-generated content with a public URL, so it gets the same treatment as plan 39's reader corrections, scaled down: titles and descriptions are length-capped and shape-checked, notes are never rendered as HTML, slugs are unguessable (128-bit random, not sequential), and creation is rate-limited per IP under plan 43's read-surface posture (creation is a write, so it is limited harder than reads). There is no reporting flow in v1 — there is no public directory to report from — but the owner token doubles as the takedown key: the owner can delete the collection at any time, and an admin can delete by slug.
- **Plan 44 measures saves, never contents.** The first-party event log records that a save happened and which surface it came from (popup, detail page, bottom sheet); it never records which events are in a collection or what a reader's notes say. A collection's contents are the most personal thing this feature holds, and the analytics vendor (plan 44) never sees them either.
- Attribution travels with the collection (plan 33): a shared collection page names the sources of its member events in the same Sources line the popup carries, and a member from a link-only source (plan 28) shows its Britannica link, never scraped text.

## What this plan does not do

- No accounts, no passwords, no email verification, no social login — the identity question is deferred to open question 66, not smuggled in as a dependency.
- No public directory or discovery of collections, no following other readers' collections, no "featured collections" editorial surface — all deferred, all needing the moderation story first.
- No collaborative editing, no comments on collections, no forking another reader's collection — a fork is just creating your own collection with the same members, which tier 1 already allows by hand.
- No export in v1 (GeoJSON/CSV download of a collection is a researcher feature that belongs with a data-export plan, not a saving plan), no print stylesheet beyond the plan 40 list rendering.
- Does not change plan 30's clustering, plan 31's share-link format for non-collection views, plan 38's slugs, or plan 46's bands: collections consume those surfaces and add no new rule to any of them.

## Sequencing

- After plans 30 (viewport + time-window fetching), 31 (share links), 32 (date model), 37 (lifecycle), 38 (detail pages and slugs), 40 (semantic list), 41 (journey player), 42 (mobile bottom sheet), 46 (bands, for the explicit non-rule), and 48 (hero images for the saved cards). Tier 1 is buildable as soon as plans 30 and 38 exist; tier 2 waits on plan 43's rate-limit posture for its creation endpoint.
- Before any public launch (plan 45): saving is the reason a first-time reader comes back, and a launch without it spends the announcement on a single visit. Not a plan 26 pilot blocker — the pilot measures events, not readers — but the tier 1 save control lands with the pilot's first public surface so early readers are not trained that nothing can be kept.
- Step 0 is a decision, not a build: confirm the no-accounts tier 2 model (owner token as the only credential) with James before any server table is drawn — see open question 66. If he wants accounts, tier 2 is re-planned, not patched.

## Done when

- A reader can save an event from the popup, the detail page, and the mobile bottom sheet into a named list on their device, and find it again after closing the tab.
- A server-stored collection opens from its link as a filtered map view plus the semantic list, with per-item notes, hero thumbnails, and the plan 51 layer set to the span's midpoint — viewable with no account.
- Merged members resolve to successors, tombstoned members show as removed entries, and no member ever silently disappears.
- Plan 44 records saves by surface only; no collection contents appear in any log; attribution travels with the shared page.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- Identity: is the anonymous owner-token model (no accounts, edit link is the only credential, lose it and you lose edit access) the right call for tier 2, or should collections wait for real accounts with email magic links?
- Discovery: link-only sharing in v1 with no public directory, or should shared collections be discoverable from the start?
- Play as journey: should a collection automatically offer the plan 41 journey player, or is that a separate explicit action the reader takes?
