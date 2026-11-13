# Multilingual events and interface language

**Related:** [00-README.md](./00-README.md) (phases 05-09), [05-source-adapters.md](./05-source-adapters.md) (candidate-source table), [11-identity-and-fusion.md](./11-identity-and-fusion.md) (dedup), [13-similarity-and-fusion.md](./13-similarity-and-fusion.md) (judge), [19-search.md](./19-search.md) (lexical search), [25-product-backlog.md](./25-product-backlog.md) (product step #23), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, label fetch), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (clustering), [31-shareable-map-state.md](./31-shareable-map-state.md) (share links), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date model), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (license declarations), [36-geoparsing-place-disambiguation.md](./36-geoparsing-place-disambiguation.md) (gazetteer cache), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages, hreflang), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (locale demand), [46-event-selection-notability.md](./46-event-selection-notability.md) (sitelink signals).

**Changelog:**
- 2026-11-10 — First version. Fills the gap the global pilot opens: plan 26 queries the whole world, so the first events it returns will include items whose labels exist only in other languages, and no plan owned what language an event title is in, what language a place name is shown in, or which calendar a pre-1582 date was recorded in.

## Why this plan exists

Plan 26 is global by James's explicit decision (2026-10-20), and the global sources are multilingual by construction:

- **Wikidata labels are multilingual.** Every item carries labels, descriptions and aliases per language, served through a language fallback chain (Universal Language Selector / Babel; the API's `wbgetentities` takes `languagefallback=1`). A pilot that stores only the English label silently drops or mis-titles every event with no English label — and plan 46's sitelink signal already counts sitelinks in *other* languages, so the notability policy assumes non-English data exists while no plan says how it is displayed.
- **Place names are multilingual too.** GeoNames holds 25M+ alternate names across ~11M features, tagged with ISO 639 language codes, with `isPreferredName` / `isHistoric` flags and from/to dates for historical names in the V2 format — the multilingual tier plan 36's gazetteer cache needs, and a CC BY 4.0 dataset plan 33 can declare.
- **Dates carry a calendar.** Wikidata time values carry a calendar model (proleptic Gregorian Q1985727 vs Julian Q1985786); Postgres counts dates exclusively in the proleptic Gregorian calendar. A Julian-model date stored raw shifts the timeline by up to 13 days and mis-orders events near adoption boundaries (Britain 1752: 2 September was followed by 14 September; Washington was born 11 February 1731 Old Style, 22 February 1732 New Style).
- **The comparable products sidestep this by being English-only.** Histropedia and the English-first timelines never had to decide. The map's promise — "the history that happened here" — is global, so English-only display is a product decision to make deliberately, not drift into because the first adapter happened to ask for `en` labels.

Without this plan, three things break at once: the pilot publishes events with blank or Q-id titles, plan 36 resolves a place to its current English exonym when the event's own sources call it something else, and plan 32's timeline silently misplaces every pre-adoption Julian date.

## The language model: three decisions

### 1. Event labels — store multilingual, display by fallback chain

- The event row carries labels as a language-keyed map (e.g. a `jsonb` column `labels: { lang: { title, description? } }` — verify against `packages/domain`; do not invent a second table until the pilot measures volume). The pilot's label fetch asks for the fallback chain, not `en` only.
- Display-title resolution, in order: the reader's locale → `mul` (Wikidata's default-value labels, for proper names identical across languages) → English → any available label, picked deterministically. This mirrors Wikidata's own fallback-chain behaviour rather than inventing a new one.
- The row stores which language the displayed title is in (`display_lang`), so the popup can say so honestly ("Title in French — no English label yet") instead of presenting a foreign title as if it were the canonical one, and so plan 39 corrections can target the right language.
- **No machine translation of event content in v1.** Labels come from sources, never from an LLM or MT pass. A mistranslated historical title is worse than a foreign-language title with a language tag, and translated text would drag plan 33 licensing (share-alike, attribution) into every row.
- Aliases in all stored languages feed plan 19 lexical search: an event searchable as "München" and "Munich" is the same event, and multilingual aliases are dedup *evidence* for plan 13 (two rows sharing a rare alias in different languages are more likely the same event), never a reason to split.

### 2. Place names — a multilingual gazetteer tier

- Plan 36's local gazetteer cache gains GeoNames `alternateNames`: per-language preferred names, `isHistoric` names with from/to dates (V2) so a place's name *at the event's date* wins over its current name — the same temporal-validity scoring plan 36 already ranks ahead of prominence.
- Display rule: the place name in the reader's locale where one exists, with the native name alongside where it differs (Wikidata P1559, name in native language, is the source-side equivalent). Never silently substitute the English exonym when the native name is the sourced one.
- Licensing: GeoNames is CC BY 4.0, declared per plan 33. The alternate-names import is a licensed dataset with a daily dump (no rate limits on the dump), not a scrape.

### 3. Calendar model — normalise for math, preserve for display

- Ingest stores Wikidata's `calendarmodel` per date claim. Validate converts Julian-model dates to proleptic Gregorian for the plan 32 strict start/end bounds (timeline math, dedup interval overlap), and keeps the original calendar plus the original date string as display metadata.
- Plan 32's EDTF display string carries the calendar where it matters: "11 February 1731 (Old Style)". The conversion is mechanical (Julian → Gregorian offset for the date), not an LLM judgment.
- Pre-1582 dates and adoption-boundary dates get a verify flag into plan 34's review queue when the source's calendar model is missing or disputed. Never guess the model: an unknown calendar is a valid state, and a guessed conversion is a wrong date.
- Non-Gregorian calendar systems (Islamic, Chinese lunar, etc.) are out of v1: where the source supplies a Gregorian equivalent it is stored with the original calendar noted; where it does not, the event is flagged, not converted. A conversion table is a later plan, not this one.

## Interface language (UI i18n)

- **next-intl**, the App Router standard the Next.js docs link first, with a `[locale]` segment and prefix routing (`/en/map`, `/fr/map`). The App Router has no built-in `i18n` key, so this is a routing convention plus a proxy for detection — next-intl 4.x packages both. The default locale keeps its prefix, which is what makes hreflang correct.
- **v1 ships English chrome only, plus the routing skeleton.** Locale detection from `Accept-Language`, a locale switcher, per-locale metadata and `hreflang` on the plan 38 detail pages (every locale links every other locale, plus `x-default`). Translated chrome (de/fr/es/…) is a post-launch step driven by plan 44 analytics — which locales readers actually come from — not a pre-launch guess.
- Dates and numbers go through the `Intl` APIs (next-intl formatting). Plan 32 display strings are *data*, not locale-formatted text: a "circa 1850" display string does not get re-formatted per locale, and the two must not fight.
- RTL: no RTL locale in v1, but the layout must not break when a label is Arabic or Hebrew — `dir="auto"` on event titles and bidi-safe rendering. Cheap now, expensive later.

## What this plan does not do

- No machine translation of event titles or descriptions (v1). No LLM translation pass in extract.
- No non-Gregorian calendar conversion.
- No full UI translation in v1 (English chrome + routing skeleton only).
- Does not change plan 46 bands: a non-English label is not a significance demerit — sitelink count already counts all languages, and plan 46 open question 49 (does an English article count for more?) is the place that call gets made.

## Sequencing

- Lands with the plan 26 pilot: the pilot measures the share of events with no English label (the number that sizes this work) and records per-class language coverage; the pilot's SPARQL/label fetch uses `languagefallback=1` from the start so the measurement is real.
- Before plan 29 source #3: Muffinlabs is English-only Wikipedia-derived, so its adapter inherits this model without new work — but the model must exist before a second multilingual source arrives.
- Plan 36's gazetteer cache loads GeoNames alternate names as part of this plan; plan 38 detail pages gain hreflang; plan 44 analytics reports locale demand for the post-launch translation decision.
- Plan 30 clustering and plan 31 share links are unaffected except that share links carry the locale prefix, and a link to an event whose title is in another language still resolves — locale is a display choice, not part of the event id.

## Done when

- Event rows store language-keyed labels plus `display_lang`; the fallback chain resolves a title for every published event with no English label — never a blank title, never a Q-id shown as a title.
- GeoNames alternate names are loaded into the plan 36 gazetteer cache with `isHistoric`/from-to honoured; place display shows the locale name plus the native name where they differ.
- Julian-model dates are normalised to proleptic Gregorian for bounds, with the original calendar preserved and shown; missing or disputed calendar models are flagged to plan 34 review.
- next-intl routing is live with a `[locale]` prefix, `Accept-Language` detection, a locale switcher, and hreflang on detail pages; English chrome only in v1.
- Search indexes aliases in all stored languages; the same event is found by any language's name.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- Non-English-only events: show them with their native title and a language tag, or hold them out of the default view until an English label exists?
- UI languages after English: which locales first (driven by plan 44 analytics), or a fixed starter set?
- Julian / Old Style dates: show the original date with an Old Style note, or always show the Gregorian equivalent with the original on the detail page only?
