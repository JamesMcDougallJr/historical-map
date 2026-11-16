# Event relationships: causes, effects, sequence, and part-of links

**Related:** [00-README.md](./00-README.md) (phases 05-09), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table), [11-identity-and-fusion.md](./11-identity-and-fusion.md) (dedup), [13-similarity-and-fusion.md](./13-similarity-and-fusion.md) (judge), [18-event-hierarchies.md](./18-event-hierarchies.md) (curated hierarchies), [25-product-backlog.md](./25-product-backlog.md) (product step #25), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, relation fetch), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (popups, clustering), [31-shareable-map-state.md](./31-shareable-map-state.md) (share links), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date model), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (license declarations, attribution), [34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md) (review queue), [37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md) (change detection), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages), [39-reader-corrections.md](./39-reader-corrections.md) (corrections), [40-accessible-map-experience.md](./40-accessible-map-experience.md) (semantic list), [41-sequence-journeys.md](./41-sequence-journeys.md) (curated journeys), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (engagement), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands), [47-multilingual-events-i18n.md](./47-multilingual-events-i18n.md) (labels).

**Changelog:**
- 2026-11-12 — First version. Fills the gap the global pilot opens: plan 26 ingests events as isolated rows, and no plan owned how events connect to each other — while the surfaces that would show a connection (plan 38 detail pages, plan 30 popups, plan 41 journeys) are already designed, and the comparable products that win on engagement all sell the connections, not the dots.

## Why this plan exists

A map of isolated pins answers "what happened here" and stops. History is a web — one event causes the next, belongs to a larger one, or follows another in a series — and the products that get this right treat the connections as the product: Histropedia's pitch is that it "helps learners understand the big picture" by showing connections between events, people and things, and the newest timeline tools (OpenEduCat's AI Historical Timeline Creator) sell a causal connection map as the core feature, letting a reader trace a chain from the Treaty of Versailles through the Great Depression to the invasion of Poland. Histography, by contrast, renders every event as an identical black dot with no links at all, and reads as a catalogue, not a story.

The map already has the raw material in its hands, because Wikidata models event-to-event relations as statements:

- **Sequence:** `follows` (P155) / `followed by` (P156) — "immediately prior / next item in a series". P156 has ~3.14M total uses, but most are series of books, films, and office-holders, not events, and the property is often a *qualifier* on an `instance of` statement (e.g. geological periods) rather than a main statement. Usable only when both endpoints are events.
- **Causation:** `has cause` (P828) / `has effect` (P1542) — an inverse pair in Wikidata's own data model — plus `immediate cause of` (P1536) and `contributing factor of` (P1537) with their inverses. Coverage is thin: Hassanzadeh (Wiki Workshop 2022, "Building a Knowledge Graph of Events and Consequences Using Wikipedia and Wikidata") built a base knowledge graph from exactly these properties and got 50 source events before having to augment it with unsupervised extraction from Wikipedia text. Sparse is a fact to measure, not a reason to skip the model.
- **Part-whole:** `part of` (P361) / `has part(s)` (P527) — a battle is part of a war, a war part of a larger conflict. This overlaps plan 18's curated hierarchies and PR #12's event sequences, so the derived links must be kept distinct from the curated ones (see below).
- **Shared context:** `participant` (P710) and `location` (P276) — two events sharing a person or a place are *related*, not causally linked. A weaker, computed signal, kept separate from sourced statements.

Without this plan, three things go wrong at publish time: detail pages ship with no "what led to this / what followed" and the map stays a catalogue; or a coding agent infers causation from chronology (the nearest event in time becomes the "cause"), which is exactly the error every history textbook warns against — order does not prove cause; or derived part-of links silently fight plan 18's curated hierarchies and PR #12's sequences, and the same event shows up as both a child and a sibling of another.

## The relationship model: four families, kept apart

### 1. Sourced statements only for cause, sequence, and part-of

- The pilot fetches relation statements as `OPTIONAL` blocks in the plan 26 SPARQL (P155/P156, P828/P1542, P1536/P1537 + inverses, P361/P527), restricted to endpoints that are themselves events in the pilot's classes. The pilot measures coverage per class and per relation type — the numbers that size this work — alongside the language coverage plan 47 and the P18 coverage plan 48 measure.
- Relations live in their own table (`event_relationships`: source event, target event, relation type, source property, source statement id, reference presence, rank), never as columns on the event row. A relation is a first-class record with its own provenance, because a wrong link is a wrong fact, and plan 37's lifecycle needs something to re-check.
- **Sequence is never causation.** `follows`/`followed by` renders as "followed by" and `has cause`/`has effect` renders as "caused / led to", in separate sections, with separate wording. No UI ever merges them into one "related events" list, and no code path ever derives a causal link from two dates being close together.
- **Causal claims are the strongest claim the map makes.** A date can be wrong by a day and still be useful; a false "X caused Y" is a false historical argument. So causal relations publish only when the source statement carries a reference (plan 46's reference-presence signal, reused here); an unreferenced causal statement goes to the plan 34 review queue instead of the map. Sequence and part-of links publish on the statement alone, with the source link shown.
- P155/P156 as *qualifiers* (on `instance of` statements) are out of v1: the pilot fetches main statements only. Qualifier-extracted sequence is a later refinement, not a silent inclusion.

### 2. Derived part-of vs curated hierarchies — both, labelled

- Plan 18 hierarchies and PR #12 sequences are curated: a human (or the extraction pipeline) decided the grouping. Wikidata P361/P527 links are derived: the source asserted them. Both can exist for the same pair, and they can disagree.
- Rule: the two are stored separately and shown separately. A detail page shows "Part of (curated)" and "Part of (Wikidata)" as distinct lines, never merged into one parent. When they agree, the curated one wins the display and the derived one is recorded as corroboration. When they disagree, both are shown and the disagreement itself is a plan 34 review item — a merge/split decision (plans 11/13) may be hiding in it.
- Plan 41 journeys are curated sequences and stay curated: a derived `followed by` chain may *suggest* a journey, but it never becomes one without a human decision. The journey authoring surface (when it exists) can list derived chains as candidates.

### 3. Shared participants and places — computed, clearly weaker

- "Same people were here" and "same place, different time" are computed at read time from P710/P276 on published events, not stored as relationships. They rank below sourced links on the detail page and are labelled as what they are ("Also involving X", "Also at this place"), never as causes or sequence.
- They are capped (verify the cap against plan 30's popup budget, do not invent a number here) and ordered by plan 46 significance band, so a famous person's event list does not flood the page.
- They never feed dedup: sharing a participant is not evidence two events are the same event.

### 4. Dedup interplay — links are evidence, not identity

- A `part of` or `follows` link between two rows is *negative* dedup evidence for plan 13: two distinct events in a sequence are not the same event, however similar their titles. The Jev judge receives linked pairs as a "do not merge" signal (per the 2026-10-23 decision, Jev remains the judge; this plan adds an input to it, not a second judge).
- When two events merge, their relationships re-point to the surviving event, with the loser's links recorded on the merge record so a later split (plan 37) can restore them. When an event splits, its relationships are re-derived, not copied to both children — a cause of the parent is not automatically a cause of each part.
- A relationship whose target is unpublished (below the plan 46 band, or not yet ingested) is stored as a candidate, not materialised on the map. Plan 37's lifecycle re-checks candidates when the target publishes; a candidate older than the settle window is dropped, not left dangling.

## Surfaces

- **Plan 38 detail page:** three sections, in this order — "What led to this" (causes, P828/P1536/P1537), "What followed" (effects + sequence, P1542/P156, kept in separate sub-lists), "Part of" (curated then derived). Each link shows the related event's title (plan 47 language model), its date (plan 32 display string), and a "Source: Wikidata" link to the statement. No section renders when it is empty.
- **Plan 30 popup / plan 42 bottom sheet:** at most the single most significant causal link each way ("Caused by X" / "Led to Y"), as a tappable chip. The full list lives on the detail page.
- **Plan 40 accessibility:** relationships render as a semantic list with the relation type as real text ("Caused by:", "Followed by:"), so the map's causal claims are readable without the canvas.
- **Plan 31 share links:** unaffected — a relationship is a property of the event, not of the link. A shared link to an event whose relationships changed since sharing still resolves; plan 37 tombstones cover the removed-target case.
- **Plan 44 analytics:** relationship clicks are a first-party event (which relation types readers actually follow), feeding the decision in open question 59 about whether to invest in extracted (non-Wikidata) causal links.

## What this plan does not do

- No LLM-extracted causal links in v1. Hassanzadeh's pipeline shows extraction is possible, but an LLM asserting "X caused Y" from article text is a new claim the map would own, and it needs its own plan (with a judge, a review queue, and a measured precision) — not a quiet extension of this one.
- No relationship graph view in v1 (no node-link diagram page). The detail-page sections and popup chips are the surfaces; a graph explorer is a later plan, informed by plan 44 click data.
- No P155/P156 qualifier extraction in v1 (main statements only).
- No cross-source relationships in v1: Muffinlabs and Britannica (plans 29/28) events get relationships only where they link to a Wikidata item. A source #3 with its own relation model gets its own mapping in its own plan.

## Sequencing

- Lands with the plan 26 pilot: the pilot fetches the relation properties, measures coverage per class and per relation type, and records the reference-presence rate for causal statements. The publish-stage gate (referenced causal only) and the candidate store are pilot deliverables.
- After plans 11/13 (dedup evidence input), 18 and PR #12 (curated hierarchies the derived links must not fight), 33 (the Wikidata licence declaration already covers the statements; no new licence work), and 37 (lifecycle re-checks candidates and re-points links on merge/split).
- Before plan 29 source #3: any source #3 with event-to-event relations maps onto this model; without the model, its relations have nowhere to land.
- Plan 38 detail pages, plan 30 popups, and plan 42 sheets gain their relationship sections as part of this plan; plan 44 reports relationship-click engagement.

## Done when

- Every published event carries its sourced relationships (or an explicit "no relations found" state) — never a silently empty section, never an inferred causal link.
- Causal relations publish only with a reference; unreferenced causal statements route to the plan 34 review queue.
- Sequence and causation render in separate sections with separate wording, on the detail page and in the popup chip.
- Derived part-of links are stored and shown separately from curated hierarchies; disagreements are review items.
- Merged events re-point their relationships to the winner; split events re-derive theirs; candidates for unpublished targets are re-checked by plan 37 and dropped after the settle window.
- The pilot reports coverage per class and per relation type, and the reference-presence rate for causal statements, as named numbers.
- Plan 39 corrections accept a "wrong link" report; plan 44 reports relationship-click engagement by type.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- Causal claims: publish Wikidata's has-cause / has-effect as-is with a "Wikidata says" attribution, or hold causal claims for human review until verified (causation is a stronger claim than a date)?
- Detail page: show "followed by" (sequence) and "caused" in separate sections, or one combined "Related events" list?
- Shared participants / places: show "same people were here" style related events, or keep relationships to explicit Wikidata statements only?
