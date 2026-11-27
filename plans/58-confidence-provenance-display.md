# Confidence and provenance display: show readers what the map knows and how sure it is

**Related:** [00-README.md](./00-README.md) (phases 05-09), [14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md) (source anchors), [25-product-backlog.md](./25-product-backlog.md) (product step #34), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, publish path), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (popups, clusters), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date model, EDTF display string), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (attribution, licence snapshots), [34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md) (review queue), [36-geoparsing-place-disambiguation.md](./36-geoparsing-place-disambiguation.md) (place confidence bands), [37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md) (versions, disagreements), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages), [39-reader-corrections.md](./39-reader-corrections.md) (corrections), [40-accessible-map-experience.md](./40-accessible-map-experience.md) (semantic list, non-color cues), [42-mobile-map-experience.md](./42-mobile-map-experience.md) (bottom sheet), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (aggregate measurement), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands), [48-event-media-wikimedia-commons.md](./48-event-media-wikimedia-commons.md) (image licence), [50-temporal-playback.md](./50-temporal-playback.md) (cursor date), [53-reader-event-suggestions.md](./53-reader-event-suggestions.md) (suggestions), [56-on-this-day.md](./56-on-this-day.md) (daily feature).

**Changelog:**
- 2026-11-21 — First version. Fills a gap no plan owned: plans 32 and 36 compute date and place confidence inside the pipeline, and plan 14 stores source anchors, but nothing decides what a reader sees. Plan 38's detail pages would present every event as an equally settled fact — a year-only date rendered as a precise day, a geoparsed guess rendered as a certain pin. This plan is the reader-facing half of confidence.

## Why this plan exists

Every comparable product that takes provenance seriously shows its working, and the ones that do not are the cautionary tale:

- **Histropedia** outsources provenance entirely: each timeline event is a click-through to its Wikipedia article. The timeline itself carries no signal about whether the date is exact, approximate, or disputed — the reader has to leave the map to find out. This plan does the opposite: the signal travels with the event.
- **Thought Atlas** (chronologyofculture.com/methodology) puts certainty labels on its entries, applied separately to date and to authorship: **Secure** (not seriously disputed), **Probable** (balance of evidence favors it), **Contested** (specialists genuinely divided), **Traditional** (carried by tradition, not evidence), **Range-uncertain** (the range itself is too wide or disputed to state as one secure reading). Dates are stated as ranges, never collapsed to a single year for tidiness, and a work can carry four distinct dates (event, composition, surviving form, earliest witness) without conflating them.
- **Spine & Watermark** (spineandwatermark.com/source-order) labels every date with its **date basis** — holding record, catalogue, inscription, literature, format estimate — ranked from direct to inferred, and when two sources disagree it sets them side by side ("[Institution A] dates it to...; [Catalogue B] gives...") and leaves the disagreement standing rather than silently picking a winner.
- **The Archivist's honest-timeline guide** (thearchivist.fun/records/GUIDE004) states the rules plainly: match precision to support (a year when only a year is established, never insert January 1 to satisfy a date field), keep the technical sortable value separate from the reader-facing date, express competing evidence as a range, a qualified date, or an explicit unresolved note, and never let visual order imply a known sequence within a year that shares only a year.
- **Wikipedia's Timeline Tracer** has a `{{Timefact}}` "chronology source needed" flag for statements that lack a timeline citation — a public marker that the date is unverified, which is also an invitation to fix it.

The map already has all the raw material: plan 32's EDTF string plus start/end bounds plus display string, Wikidata precision and P1480 (sourcing circumstances: circa / presumably / disputed) plus P1319/P1326 earliest/latest, plan 36's confidence bands and resolution path, plan 14's anchors, plan 33's attribution. What no plan owned is the display contract: which of those signals a reader sees, in what words, on which surfaces, and what happens when the signals disagree or are missing. Without this plan, a coding agent building plan 38's pages invents it ad hoc — most likely by rendering the sortable midpoint as a confident-looking date, which is exactly the false precision the honest-timeline guide warns against.

## The display contract: six decisions

### 1. The reader-facing date is plan 32's display string, never the sortable value

- Every surface (popup, plan 38 detail page, plan 40 semantic list, plan 42 bottom sheet, plan 56 daily page, plan 55 embed) renders the plan 32 display string: "c. 1850", "1850–1852", "May 1869", "1869". The strict start/end bounds and any midpoint exist only for sorting, timeline math, and dedup blocking — they are never rendered as a date.
- No January 1 insertion, ever: a year-only event renders as its year, a month-only event as its month. Where a surface needs a sortable point (plan 50 playback cursor, plan 30 timeline position), the point is internal; the label beside it stays the display string.
- When several events share only a year, their visual order within that year carries no sequence meaning — the plan 30 timeline and plan 50 playback must not imply an order the data does not support (same rule as the honest-timeline guide).

### 2. Certainty labels, per field, computed from stored signals — never editorial

- Each event carries two labels, one for the **date** and one for the **place**, derived only from signals already stored at publish time. No label is ever typed by hand and no label is a vibe check:
  - Date label from plan 32: Wikidata precision (7–11) + P1480 (circa / presumably / disputed) + P1319/P1326 earliest/latest + whether the source gives a range. High precision with no qualifier → Secure; circa/presumably or a wide earliest/latest span → Approximate; P1480 disputed, or two sources giving incompatible dates → Contested; reference-backed and unchallenged → Probable where the evidence favors it without full precision.
  - Place label from plan 36: the confidence band and resolution path. Structured pass-through with coordinates from the source → Secure; local-gazetteer or WHG match with containment + temporal-validity scoring → Probable; LLM-proposed place accepted by the reviewer, or a match that survived on prominence alone → Approximate; abstain-path events never publish, so no label for them.
- Vocabulary (four labels, adapted from Thought Atlas): **Secure / Probable / Contested / Approximate**. Thought Atlas's fifth label, Traditional, is dropped — the map publishes no traditionally-attributed events — and Range-uncertain is folded into Approximate, since a too-wide range is what Approximate already means for a date.
- Labels are text plus shape, never color alone (plan 40 rule): the label word appears next to the date/place, and low-certainty markers use a distinct outline (dashed per plan 32's fuzzy rendering) rather than a color shift. A screen-reader user gets the same information from the plan 40 semantic list.
- **No numeric percentages to readers, anywhere.** A "73% confident" pin is false precision dressed as honesty; the bands are the honest unit. Percentages may exist in plan 34's review queue for reviewers; they never leak to a public surface.

### 3. A "How we know" section on the plan 38 detail page

- Below the event, a short provenance block with four lines, each one plain language:
  - **Date — basis:** what the date rests on, in Spine & Watermark's style ("Wikidata statement with reference", "source gives a year only", "earliest/latest bounds from..."). The label from decision 2 sits beside it.
  - **Place — basis:** how the place was resolved, from plan 36's stored path ("matched to Wikidata Q… via the local gazetteer", "coordinates from the source document"). The place label sits beside it.
  - **Sources:** the plan 14 anchors as a list of links (never pasted source text for link-only sources — the plan 28/33 rule), with plan 33 attribution and the plan 48 image licence note where an image exists.
  - **History of this event:** the plan 37 version note — when the event was last re-published and why (source changed, correction applied, unmerge/split), so a returning reader can see the record moved.
- The block is server-rendered with the page (plan 38), included in the plan 44 aggregate count of "How we know" opens only as a scroll/expand event if it is collapsible — and it is collapsible on mobile (plan 42 sheet), expanded by default on desktop detail pages so provenance is not hidden behind a tap.

### 4. Disagreements are shown side by side, never silently resolved

- When two published sources give incompatible dates or places for the same event, plan 37 keeps both versions; this plan renders both in the "How we know" block ("Source A dates it to 1850; Source B gives 1852") with the label Contested, and the map pin uses the publish-time chosen value with its label — the disagreement is visible, not averaged away. This is the Spine & Watermark rule, and it is why plan 37's no-automatic-remerge guard matters to readers, not just to the pipeline.
- A reader who disagrees with either side uses the plan 39 correction flow (one review item, evidence as links); a reader who knows a missing event uses plan 53. The provenance block links to both, in context: "Think this date is wrong? Report it" beside the date line, "Know a missing event? Suggest it" in the page footer.

### 5. "Needs a source" is a public flag, not a hidden shame

- An event whose date or place has no reference at publish time carries a visible **"date needs a source"** / **"place needs a source"** marker (Wikipedia's `{{Timefact}}` pattern), on the detail page and in the semantic list. The flag links to the plan 39 correction form, prefilled with the field in question.
- The flag is public by default (see open question 86): hiding it would make the map look more certain than it is, and the flag is the cheapest way a weak event gets fixed — a reader who knows the source can supply it. Flagged events are never hidden from search, the sitemap, or the plan 56 daily page; they are labelled, not buried.
- Plan 46 interplay: a low-certainty event is **not** automatically a minor-band event. Certainty and significance are independent axes — a contested date on a major battle stays high-band with a Contested label; a securely-dated parish fair can be minor. The plan 46 band thresholds are set from significance signals only, and this plan's labels must not be smuggled into them.

### 6. The map surface carries the same labels, in miniature

- Popups (plan 30) show the date display string plus its label word, and the place label where the place is approximate or contested; secure/secure events show no extra chrome — the common case stays clean.
- Low-certainty pins use the dashed-outline marker treatment from plan 32's fuzzy rendering so the uncertainty is visible at a glance without opening anything; clusters (plan 30) aggregate labels by worst case (a cluster containing a contested event shows the contested treatment) rather than averaging them away.
- Plan 50 playback does not change confidence display: the cursor date moves, the labels stay attached to their events, and a pulse on a newly-appearing event never implies the event just became certain — it only became visible.
- Plan 55 embeds show the same popup labels (the embed is the same map, smaller); plan 57 offline packs carry the labels as stored data, and stale labelling (plan 57) is separate from certainty labelling — an offline event can be Secure-dated and stale-cached at the same time, and the two labels must never be confused.

## What this plan does not do

- No hand-written certainty judgments. A reviewer who knows better applies a correction through plan 37 (version row, manual-override flag) — the label then recomputes from the new stored signals. The label is a function of the record, not an opinion field.
- No hedging prose in event text. The description does not get "maybe" and "possibly" sprinkled through it; the label beside the date carries the uncertainty, and the "How we know" block carries the evidence. Hedged prose is unsearchable and untranslatable; a label is structured.
- No per-source reliability scoring. Ranking publishers (which source outranks which when they conflict) is a plan 29 source-expansion decision, not this plan's; this plan shows the disagreement and lets the publish-time choice stand with its label.
- No confidence in schema.org JSON-LD beyond what is visible on the page (plan 38 rule: JSON-LD matches visible content only). The labels are visible text, so they may appear in the page body; they are not a structured-data field to invent.
- No hiding of low-confidence events from any public surface. Labelled, never buried — the map's honesty is the feature.

## Sequencing

- After plans 32 (date model + display string), 36 (place confidence bands), 38 (detail pages to host the block), and 40 (semantic list + non-color cues).
- Lands with the plan 26 pilot: the label thresholds need the pilot's measured distributions (precision histograms, P1480 frequency, plan 36 band mix), the same way plan 46's thresholds do. The pilot's first published set is the first set that carries labels; the 44 curated events never get labels — they are deleted per the standing directive, not retrofitted.
- Before any public launch: a launch that presents every date as equally certain would have to walk it back in public. Not a plan 26 pilot blocker — the pilot validates ingestion; labels ship with the pilot's first published set, not before it.

## Done when

- Every published event carries a date label and a place label computed from stored signals; no label is hand-typed and no surface renders the sortable midpoint as a date.
- The plan 38 detail page shows the "How we know" block (date basis, place basis, sources with anchors, version history) with disagreement rendered side by side where sources conflict.
- Popups, the plan 40 semantic list, and the plan 42 bottom sheet carry the same labels; low-certainty pins use the dashed-outline treatment and clusters aggregate by worst case.
- "Needs a source" flags are live on dates/places without references and link to the plan 39 correction form prefilled with the field.
- No numeric confidence percentage appears on any reader-facing surface; labels are text + shape, never color alone.
- Plan 44 aggregate measurement confirms readers open "How we know" (no per-reader tracking); the pilot audit sample checks label accuracy against the stored signals.

## Open to James (see chat summary)

- Label vocabulary: four labels (Secure / Probable / Contested / Approximate, adapted from Thought Atlas) or a simpler three (Certain / Approximate / Disputed)?
- Low-confidence events on the map: shown by default with their labels, or behind a "show uncertain events" toggle?
- "Needs a source" flags: public on the detail page, or reviewer-only in the plan 34 queue until a human confirms the gap?

- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).
