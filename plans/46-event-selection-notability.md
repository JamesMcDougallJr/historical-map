# Event selection and notability policy

**Related:** [00-README.md](./00-README.md) (phases 05-09), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table), [11-identity-and-fusion.md](./11-identity-and-fusion.md) (dedup), [13-similarity-and-fusion.md](./13-similarity-and-fusion.md) (judge), [25-product-backlog.md](./25-product-backlog.md) (product step #22), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (pilot whitelist + 5,000 cap), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (clustering, density), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date precision), [34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md) (review queue), [37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md) (re-selection on policy change), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (zero-result demand signal).

**Changelog:**
- 2026-11-09 — First version. Fills the gap plan 26 left open: the pilot bounds itself with a class whitelist and a 5,000-event cap and defers the exact class list to code review, but no plan owns what qualifies for the map at full scale, once the cap lifts.

## Why this plan exists

Plan 26 is deliberately small: a global query, a class whitelist, a 5,000-event cap. That is a pilot device, not a policy. The moment the cap lifts, the map meets the real scale of the sources, and "everything Wikidata has" is not a product:

- Even one class is large. A nodegoat count of Wikidata found ~8,049 instances of battle; only ~410 carried a directly attached location and date, and ~2,657 once place/date are resolved a level deeper. One class, thousands of candidates, most of them minor skirmishes.
- The raw material is effectively unbounded. The DBpedia historical-events extraction pulled ~121,821 events out of Wikipedia year articles, and a Wikimedia IdeaLab project extracted ~49 million dates from English Wikipedia. A map that ingests without a selection rule becomes a dot field, not a history product.
- The comparable products all answer this with a significance rule, not with more data. Histropedia holds 1.5M+ events across 300,000+ timelines and shows only the most important event at any one time. Histography draws every event but leans on an Editorial Stories view for anything a human would actually browse. The DBpedia Events dataset ranks detected events by the source article PageRank and edit activity. Nobody ships "all of it, equally weighted".

Without a policy, three things break at once: plan 30 clustering has no principled representative pin (the cluster shows whichever event the query returns first), the review queue in plan 34 drowns in borderline items with no rule to judge them against, and the map's promise — "the history that happened here" — degrades into "the history that happened to have a Wikidata item".

## The policy: three layers

Selection is three stacked rules, evaluated in order at validate/publish time (plans 08-09), never at read time. Each layer is versioned config, not code, so James can change the policy without a deploy of the pipeline.

### Layer 1 — Class whitelist (what kinds of things are events)

Per source, a versioned class list, e.g. `config/event-classes.wikidata.json` (or the equivalent table — verify against the repo; plan 26 predates the shipped six-stage shape). The pilot's list is the v0 of this file, not a separate thing: plan 26's "exact class list is a code-review decision" becomes "the class list is reviewed against the pilot run and then frozen as v1".

Rules for the list:

- A class enters only with its expected volume attached, measured from a real query run, not guessed. The pilot measures per-class counts (with P625 + P585 present) for every candidate class; any class whose measured volume is an order of magnitude above its neighbours gets flagged for a sub-class split or a stricter layer-2 bar before it ships.
- Classes are allow-listed, never block-listed. Wikidata's class tree is too broad for a deny-list to stay correct as editors add items.
- The list carries the reason per class in one line ("battle: core conflict coverage, ~2.7k with place+date"), so a later reader can tell a deliberate inclusion from an accident.

### Layer 2 — Significance signals (which members of a class qualify)

Inside an allowed class, an event qualifies by cheap, auditable signals available at ingest time. No LLM judgment, no PageRank service to call — the signals must be computable from the row itself:

- **Sitelink count** (`wikibase:sitelinks`): the number of Wikimedia projects linking the item. Plan 26 already floats this as a quality gate; this plan makes it the primary significance proxy. A battle with 40 sitelinks is a different object from one with zero.
- **Reference presence:** at least one sourced statement on the date or place claim (plan 26's "reference-present flag"). Zero-reference items fail layer 2 outright, whatever their sitelinks.
- **English Wikipedia article exists:** a weaker, separate signal from sitelink count (an item can have sitelinks in other languages only). Kept as its own flag so the policy can weight it independently.
- **Date precision:** per plan 32, date granularity worse than a year already carries a low-confidence flag. Layer 2 treats "no usable date precision" as a fail, not a flag — an undated event cannot be placed on a timeline at all.

The output of layer 2 is a stored **significance band** on the event row (`high` / `standard` / `minor`), computed once at validate time and carried through fusion (plan 13: a merged cluster inherits the highest band of its members). Bands, not raw scores, are what the read side sees — a raw score invites tuning arguments the product does not need yet.

The thresholds (e.g. sitelink count >= N for `standard`) are **set from the pilot's measured distribution, not guessed in this plan**. The pilot run reports the sitelink-count histogram per class; v1 thresholds are picked from that histogram and recorded in the config file with the date and the pilot run id. Any threshold change is a config version bump, and plan 37 treats a policy change as a change class: previously published events are re-evaluated, not silently grandfathered.

### Layer 3 — Density behaviour (what the reader sees)

Layer 3 is display policy, owned jointly with plan 30:

- Plan 30's cluster representative is the highest-band event in the cluster, not the first returned. A cluster of 40 minor skirmishes shows the one battle a reader would recognise.
- At high zoom-out, `minor`-band events are not rendered as individual pins at all; they appear only when the reader zooms in or explicitly enables a "show minor events" toggle. The default view is the notable map; the comprehensive map is one toggle away.
- The toggle state is part of plan 31's shareable map state, so a link to a minor event still resolves.

## What this plan does not do

- It does not set the thresholds. That is the pilot's job (measure, then pick). A plan that guesses N=5 sitelinks would be wrong in a way that looks authoritative.
- It does not add an LLM significance judge. If the cheap signals prove too coarse, that is a later plan, and it would need a gold set to evaluate against — the same gold-set discipline plan 36 requires for geoparsing.
- It does not touch Britannica link-only records (plan 28): editorially curated by Britannica, they are significant by construction and bypass layer 2.

## Sequencing

- Lands with the plan 26 pilot: the pilot run produces the per-class volumes and sitelink histograms this policy is calibrated from, and the pilot's whitelist becomes the v1 class list.
- Before plan 29 source #3 (Muffinlabs) publishes: Muffinlabs ships no coordinates and no sitelinks, so its layer-2 signals need their own definition (Wikipedia article existence via its links is the obvious one) — defined here as a per-source signal table, not ad hoc in the adapter.
- Plan 30's cluster-representative rule and the minor-events toggle depend on the stored band, so plan 30's implementation reads this plan's schema.

## Done when

- `config/event-classes.*` (or the equivalent table) exists with the pilot's class list as v1, per-class measured volumes, and the reason per class.
- The event row carries a stored significance band, computed at validate time from sitelink count, reference presence, article existence, and date precision; merged clusters inherit the highest band.
- The pilot run's sitelink-count histogram per class is recorded, and v1 thresholds are set from it with the run id noted in config.
- Plan 30's clustering picks the highest-band event as the cluster representative, and `minor` events are hidden at low zoom behind the toggle.
- A policy change re-evaluates published events through plan 37's change classes (no silent grandfathering).
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- Notable-only by default, or comprehensive with a toggle: is the map's default view the significant events, with minor ones one toggle away — or should everything show and significance only order the clusters?
- Sitelink threshold: once the pilot histogram lands, what feels right as the `standard` bar — and does an English Wikipedia article count for more than sitelinks in other languages?
- Minor events: publish them but hide them at low zoom, or hold them unpublished entirely until a reader asks for them?
