# Source licensing and attribution: a license model for every ingested fact

**Related:** [00-README.md](./00-README.md) (phases 03, 05, 09, 14),
[03-database-layer.md](./03-database-layer.md) (event tables),
[05-source-adapters.md](./05-source-adapters.md) (one file per source),
[09-publish-worker.md](./09-publish-worker.md) (geocode, dedup, write),
[13-similarity-and-fusion.md](./13-similarity-and-fusion.md) (Jev judge stage),
[14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md) (source anchors),
[25-product-backlog.md](./25-product-backlog.md) (product steps),
[26-wikidata-pilot.md](./26-wikidata-pilot.md) (source #2, GLOBAL),
[27-web-ingestor.md](./27-web-ingestor.md) (the HTTP fetcher),
[28-britannica-link-only.md](./28-britannica-link-only.md) (link-only layer),
[29-source-expansion-dedup.md](./29-source-expansion-dedup.md) (sources #3+,
Jev dedup), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (popup and
timeline display), [31-shareable-map-state.md](./31-shareable-map-state.md)
(shared links and previews), [32-fuzzy-dates.md](./32-fuzzy-dates.md)
(event date model).

**Changelog:**
- 2026-10-27 - Created from the daily research loop. Every plan so far
  assumes ingested data can be shown, but none records under what terms.
  With sources #2 and #3 landing, the map will mix CC0 facts, CC BY
  coordinates, CC BY-SA derived text, link-only editorial entries, and
  per-record rights statements in one popup. Without a license model
  recorded at ingest time, the map cannot credit anyone correctly, cannot
  tell a share-alike record from a public-domain one, and cannot prove
  the Britannica link-only rule is being kept.

## Why this plan exists

Today the map has one source and one implicit license posture: the 44
curated rows are James's own, so there is nothing to attribute. That
ends at source #2. The sources already on the roadmap do not share a
license, and the differences are not cosmetic:

- A CC0 record needs no permission and no attribution as a legal
  matter, but credit is still good practice and protects against
  plagiarism accusations.
- A CC BY record (GeoNames coordinates via HistGeocoder) legally
  requires credit, a link to the license, and a note when modified.
- A CC BY-SA record (Wikipedia-derived text, which is what Muffinlabs
  source #3 re-serves) requires credit and passes share-alike forward
  to adaptations of that text.
- A link-only record (Britannica, plan 28) carries no license grant
  at all: the map may store a date, a short factual identifier, and a
  link, and nothing else.
- A per-record rights record (DPLA, a future source) has no single
  source-level license: each item carries its own
  RightsStatements.org URI, and some items are still in copyright.

None of this is visible in the current event model. If the license is
not stored when the record is published, it cannot be reconstructed
later: dedup (plan 13) merges records, the popup (plan 30) renders
them, and shared links (plan 31) copy them onward. License is ingest
metadata, recorded at the adapter boundary and carried through publish,
not a display string added at the end.

## The rule: every source declares its license, every event carries its attributions

Per plan 05's one-file-per-source shape, each `SourceAdapter`
declares a license block at its boundary. No adapter ships without
one. The publish worker (plan 09) rejects records whose adapter has
no license declaration: they go to the review queue, not to the map.
An unknown or unparseable license is the same as a missing one.

The declaration, in SPDX identifiers where a license exists:

- `license_spdx` - e.g. `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`,
  `ODbL-1.0`, or `NONE` for link-only and other no-grant cases.
- `attribution_text` - the credit line to display, e.g.
  "Coordinates: GeoNames" or "Source: Wikidata".
- `attribution_url` - link to the source record or the license text.
- `allows_text_reuse` - false for link-only sources, true only where
  the license actually grants it.
- `requires_share_alike` - true for CC BY-SA derived text, so the
  display layer knows an adaptation notice is owed.
- `rights_uri` - for per-record sources, the RightsStatements.org or
  license URI carried on the individual record, not the adapter.

Licenses are snapshotted at publish time, not referenced live. If a
source relicenses later, already-published events keep the terms they
were published under, and the adapter's new declaration applies only
to new publishes. The snapshot is what the popup shows.

## The source table (verified 2026-10-27)

| Source | Terms | What the map may store and show |
|---|---|---|
| Wikidata (plan 26) | CC0-1.0, structured data in main/property namespaces | Facts freely; credit "Wikidata" as practice, never imply endorsement (CC0 deed rule) |
| GeoNames via HistGeocoder (plan 25 step 5) | CC BY 4.0 | Coordinates with credit, license link, and a modified note where coordinates were adjusted |
| GNIS via HistGeocoder | US public domain | Facts freely; credit as practice |
| OpenHistoricalMap boundary layer (plan 29) | CC0 default, per-element exceptions | CC0 elements freely; any element carrying a `license=*` tag other than CC0 (ODbL, CC BY-SA, etc.) must have its own terms honored or be excluded - a blanket CC0 assumption is wrong |
| Muffinlabs / Wikipedia-derived text (plan 29) | CC BY-SA via Wikipedia | Short factual identifiers plus attribution; adapted description text carries credit and share-alike forward - see open question 2 |
| Britannica On This Day (plan 28) | No grant - link-only by James's approval (2026-10-21) | Date + short factual identifier + link back, never the text; `allows_text_reuse: false`, `license_spdx: NONE` |
| DPLA (future source, not yet planned) | Per-item RightsStatements.org URI | Each record carries its own rights URI; in-copyright items are link-or-fact only unless their statement permits more |
| OpenStreetMap basemap tiles (if used as the map layer) | ODbL + attribution | Tile attribution ("(c) OpenStreetMap contributors") is a separate footer obligation from event-data attribution - the two must not be conflated |

Correction worth recording: OpenHistoricalMap is not ODbL-licensed.
OSM is ODbL; OHM deliberately dedicates its data to CC0 unless an
individual element says otherwise. Any plan text that calls OHM
"ODbL" is wrong and should be fixed when touched.

## What changes downstream

**Publish (plan 09) and dedup (plans 11, 13, 29).** A merged event
carries the union of its sources' attributions, not just the winning
source's. When Jev judging merges a Wikidata day-precision record
with a Muffinlabs year-precision record (plan 32's precision-mismatch
case), the merged popup credits both, and the share-alike flag
survives if any merged input had it. Attribution is never the field
that gets deduplicated away. Conversely, a merge must never upgrade
a link-only record into a text record: the Britannica entry keeps
`allows_text_reuse: false` through fusion, and its popup renders as
a link, not as copied text.

**Storage (plan 03).** Per plan 03's migration pattern, add a
`source_licenses` registry table (one row per adapter declaration,
versioned) and an `event_sources` join: event id, source id, source
record id, license snapshot (SPDX + attribution text + URL +
share-alike flag + rights URI), and fetched date. The map's read
path joins this table; no read path re-derives license from the
adapter at display time, so a later adapter change cannot rewrite
history. The 44 curated rows get a single `curated-seed` entry
marked for deletion with the rest of the seed (plan 25 step 4) - this
plan changes their attribution representation, not their fate.

**Display (plans 30, 31).** Every popup gains a "Sources" line:
source names, each linked to its record, with the license short
form where one is owed ("CC BY 4.0", "CC BY-SA 4.0"). A single
`/sources` page lists every source, its license, its attribution
text, and a link to the license - the page the CC BY "reasonable
manner" attribution requirement points at. Shared links (plan 31)
need no license change: the URL restores a view, and the popup at
that view carries the same Sources line. Open Graph previews
(plan 31 stretch) must not embed CC BY-SA or link-only text in the
preview card beyond a short factual identifier; the preview links
back to the event, where the full attribution lives.

**RAG and citations (plan 14).** Citation anchors already carry a
source link; they now also carry the license snapshot, so a
generated summary can say which of its cited facts are CC0, which
are CC BY, and which are link-only pointers rather than quotable
text. A link-only source is never quoted in generated text.

## Sequencing

1. Lands with the plan 26 pilot, not before it: there is no second
   source yet to justify a standalone migration, and the pilot's
   first publish is the first moment a non-curated license enters
   the map. The pilot's adapter is the first license declaration,
   and its fixture set includes one row per source-table row above.
2. Plan 29's Muffinlabs adapter is the first CC BY-SA consumer: its
   fixtures pin the share-alike flag and the adapted-text notice
   before any Muffinlabs text reaches a popup.
3. Plan 28's Britannica adapter is the first `NONE` consumer: its
   fixtures assert that no description text is stored, only date,
   identifier, and link, and that fusion cannot upgrade it.
4. The `/sources` page and popup Sources line land after the pilot
   publishes, since they have nothing to display until then; they
   are not blocked on plan 30's clustering work.

## Testing

- Fixture-driven per plan 05: every source-table row has a recorded
  license declaration, an expected popup Sources line, and an
  expected `/sources` entry.
- Publish gate test: an adapter without a license declaration is
  rejected to the review queue, not published.
- Merge test: merging a CC0 record with a CC BY-SA record yields a
  popup crediting both, with the share-alike flag set; merging with
  a link-only record never adds text.
- Snapshot test: changing an adapter's declaration after publish
  does not change already-published popups.
- Basemap test: the map footer shows tile attribution separately
  from event attribution, and removing the tile layer removes only
  the tile line.

## Done when

- Every adapter declares a license block; publish rejects
  undeclared licenses to the review queue.
- `source_licenses` and `event_sources` exist; popups render a
  Sources line from the snapshot, and `/sources` lists every source
  with its license and attribution text.
- Merged events carry the union of attributions; link-only records
  stay link-only through fusion.
- 00-README index and plan 25 backlog reference this plan.

## Open to James (see chat summary)

- Attribution display: per-event Sources line in the popup plus a
  `/sources` page, or is the popup line alone enough for v1?
- Share-alike text: if Muffinlabs/Wikipedia-derived descriptions
  are adapted, does the map show them verbatim with CC BY-SA
  credit, or stay facts-only to keep share-alike out of event
  records?
- OHM per-element exceptions: exclude non-CC0 elements outright,
  or carry their individual licenses through like any other source?
