# Fuzzy dates: an EDTF date model for events

**Related:** [00-README.md](./00-README.md) (phases 03, 08, 09, 13),
[03-database-layer.md](./03-database-layer.md) (event tables),
[08-extract-worker.md](./08-extract-worker.md) (Claude extraction output),
[09-publish-worker.md](./09-publish-worker.md) (geocode, dedup, write),
[13-similarity-and-fusion.md](./13-similarity-and-fusion.md) (Jev judge stage),
[25-product-backlog.md](./25-product-backlog.md) (product steps),
[26-wikidata-pilot.md](./26-wikidata-pilot.md) (source #2, GLOBAL),
[27-web-ingestor.md](./27-web-ingestor.md) (the HTTP fetcher),
[28-britannica-link-only.md](./28-britannica-link-only.md) (link-only layer),
[29-source-expansion-dedup.md](./29-source-expansion-dedup.md) (sources #3+,
Jev dedup), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (timeline
semantic zoom), [31-shareable-map-state.md](./31-shareable-map-state.md)
(timeline window in URLs).

**Changelog:**
- 2026-10-26 - Created from the daily research loop. No source ships
  clean day-precision dates: Wikidata carries precision + circa/earliest/
  latest qualifiers, Muffinlabs is mostly year-only, text extraction
  (plan 08) produces "spring 1850" and "c. 500 BCE". The event model
  needs uncertainty as data, not as text pasted into a date field.

## Why this plan exists

Every plan so far assumes an event has a date. None says what happens
when the date is "circa 1850", "spring 1850", "the 1850s", or "between
1846 and 1855". Today that ambiguity has only two exits, both bad:
coerce it silently to a fake precise day (January 1, 1850 renders as a
fact and sorts as one), or drop the event. The first corrupts the
timeline; the second deletes exactly the deep-history events the map
exists for, since older events are the least precisely dated. Plan 26
(Wikidata, GLOBAL) is the forcing function: its date model already
contains everything this plan needs to preserve, and if the pilot
flattens it to a single day, the information is gone before dedup,
display, or sharing ever see it.

## The standard: EDTF, Level 1 only in v1

EDTF (Extended Date/Time Format, ISO 8601-2:2019 Annex A, originally
the Library of Congress profile) encodes uncertainty, approximation,
unspecified parts, intervals, and seasons as one parseable string:

- `1984?` - possibly 1984, but not definitely (uncertain)
- `1984~` - approximately 1984 (approximate); `1984?~` - both
- `199u` - some year in the 1990s; `1999-uu` - some month in 1999
  (unspecified digits)
- `1964/2008` - interval; `1985-04/..` - open-ended interval
- `2001-21` - Spring 2001 (21-24 = Spring/Summer/Autumn/Winter;
  Level 2 adds hemisphere-specific 25-32 codes)

Level 1 restricts `?`/`~` to the end of the whole string; Level 2
allows per-component qualifiers (`1816?-05-25`, year uncertain, day
and month known). **v1 implements Level 1 only.** Level 2's
per-component qualifiers, sets (`[1760-01,1760-02]`), and exponential
years are deferred: Level 1 covers every case the current sources
produce, and the parser constraint (see below) rejects Level 2 input
at the adapter boundary rather than half-supporting it.

The JS ecosystem already has a parser: the `edtf` npm package
(EDTF.js) parses Levels 0-2, returns level/type/values plus
uncertain/approximate bitmasks, and rejects impossible dates
(`2016-02-3X` fails). Pin a version at implementation time after
checking the current release; constrain the parser to Level 1 in the
adapter (`level: 1`) so a Level 2 string is a validation error, not
silent data loss. Display humanization follows the Duke
edtf-humanize pattern as a small local formatter, not a new
dependency: `1972~` renders "circa 1972", `1975-21` renders
"Spring 1975", `199u` renders "1990s".

## Source mappings (adapter rules, not guesses)

Each adapter normalizes to EDTF at its boundary, per plan 05's
one-file-per-source shape. The mapping table lives in the adapter,
and fixtures pin every row:

| Source fact | EDTF | Notes |
|---|---|---|
| Wikidata precision 11 (day) | `1850-06-14` | Plain Level 0 |
| Wikidata precision 10 (month) | `1850-06` | Month precision, not June 1 |
| Wikidata precision 9 (year) | `1850` | Year precision, not Jan 1 |
| Wikidata precision 8 (decade) | `185u` | "1850s" |
| Wikidata precision 7 (century) | `18uu` | "1800s" |
| Sourcing circumstances (P1480) `circa` (Q5727902) | append `~` | `1850~`; `presumably`/`near` map to `?`; `disputed` (Q18912752) maps to `?` plus a `disputed` flag on the event, not just the date |
| Earliest/latest (P1319/P1326) | interval | "after 741" becomes an open-ended interval starting at 741: store the bounds (see below) and express the open side per the pinned parser's interval syntax; never invent the missing side |
| Refine date (P4241) seasons/halves/quarters | season codes / intervals | Spring (northern hemisphere) maps to `21`; halves and quarters map to intervals over the containing year/decade/century |
| Muffinlabs year-only events | `YYYY` | Year precision; its Wikipedia links stay as provenance |
| Britannica link-only (plan 28) | day or year as published | Link layer only: store the date the link page asserts, never derived text |
| Plan 08 extraction ("spring 1850", "c. 500 BCE") | `1850-21`, `y-500~`-style long years | The extract prompt must emit EDTF, not free-text dates; unparseable dates fail validation and go to the review queue, not to a guessed day |

BCE and pre-1 CE dates use astronomical year numbering (year 0 =
1 BCE), matching Wikidata, with EDTF long-year form for years outside
four digits. Display converts back ("500 BCE"). Julian-calendar
Wikidata values keep their calendar-model marker; the pilot does not
convert Julian to Gregorian silently.

## Storage: one string, two bounds, one display string

Per plan 03's migration pattern, an event's date becomes four
columns, not one:

- `date_edtf` (text) - the canonical EDTF Level 1 string, the
  source of truth. Validated by the parser at write time.
- `date_start` / `date_end` (dates) - the *strict* bounds derived
  from the EDTF string: the earliest and latest day the string can
  mean. `1850` becomes 1850-01-01/1850-12-31; `1850~` keeps the same
  strict bounds (approximation is a display/qualifier fact, not a
  wider interval); intervals use their own endpoints. These two
  columns are what every query, sort, and filter touches, so no query
  ever parses EDTF at read time.
- `date_display` (text) - the human string ("circa 1850",
  "Spring 1850"), computed once at write time by the formatter, so
  the map and popup never re-derive it inconsistently.

A Postgres `daterange` over the two bound columns is the natural
index shape for "does this event intersect the visible window".
Migration must backfill the 44 curated rows (all day- or
year-precision as entered) before they are retired per plan 25
step 4; the backfill is mechanical and reviewed, not a rewrite of
their dates. The curated rows are still slated for deletion once
plan 26's spot-check passes (standing directive 2026-10-20); this
plan changes their date *representation*, not their fate.

## What changes downstream

**Timeline and map (plan 30).** A fuzzy event is not a point.
Year/month-precision events render as spans on the timeline, and
uncertain/approximate events get a visibly different marker (hollow
or dashed, TBD in implementation) so the map never presents a guess
as a fact. At coarse zoom, plan 30's semantic zoom aggregates by
the strict bounds, not by a fake midpoint. An event is visible in a
time window when its `[date_start, date_end]` interval intersects
the window - not when its nominal date falls inside it. A "hide
uncertain dates" toggle is a filter on the qualifier, cheap once the
columns exist.

**Dedup (plans 11, 13, 29).** Jev pairwise judging must compare
intervals, not exact dates: a Wikidata day-precision record and a
Muffinlabs year-precision record for the same event are a match
candidate when their intervals intersect, and a precision mismatch
must never veto a merge on its own. The deterministic blocking
rules (place within 5 km + date) become place within 5 km + interval
overlap. The overlap fixture set from plan 29 gains precision-mismatch
pairs (same event, year vs day) and near-miss pairs (same place,
adjacent years, different events).

**Shareable state (plan 31).** No URL format change: the timeline
window in the URL already denotes an interval, and interval
intersection (above) is what restores correctly against it. The
graceful-degradation rule for merged/deleted ids is unchanged.

**Search (plans 19-24).** Lexical search is unaffected. Any future
date-facet ("events in the 1850s") queries the bound columns, so a
circa-1850 event correctly appears in an 1850s facet.

## Sequencing

1. Plan 26 (Wikidata pilot) is the first consumer: its adapter
   implements the mapping table above, and its fixture set includes
   one row per mapping-table row.
2. This plan's migration lands with the pilot, not before it -
   there is no second source yet to justify a standalone migration,
   and the pilot's spot-check against the curated rows exercises
   the backfill.
3. Plan 08's extract prompt gains the "emit EDTF, never free-text
   dates" rule before Muffinlabs (source #3) lands, since
   Muffinlabs' year-only dates are the coarse end of the same
   problem.
4. Plan 30's timeline rendering picks up span markers and the
   uncertain toggle after the columns exist; plan 30 is not blocked
   on this plan for its clustering work.

## Testing

- Fixture-driven per plan 05: every mapping-table row has a
  recorded source value, an expected EDTF string, expected strict
  bounds, and an expected display string. Parser-constraint test:
  a Level 2 string is rejected at the adapter boundary.
- Timeline: interval-intersection tests (a year-precision event
  visible across its whole year window; a circa event visible in
  its nominal window, hidden by the uncertain toggle).
- Dedup: precision-mismatch pairs merge; adjacent-year near-miss
  pairs do not.
- Backfill test: the 44 curated rows migrate to identical display
  strings before retirement.

## Done when

- Migration adds `date_edtf`, `date_start`, `date_end`,
  `date_display`; all existing events backfill with unchanged
  display strings.
- Plan 26's adapter implements the mapping table with fixtures
  green; the parser is constrained to Level 1.
- Plan 30's timeline renders fuzzy events as spans with distinct
  uncertain markers, and interval-intersection filtering is the
  window rule.
- Plan 13's blocking rules use interval overlap; plan 29's fixture
  set gains precision-mismatch pairs.
- 00-README index and plan 25 backlog reference this plan.

## Open to James (see chat summary)

- Map markers: show uncertainty on the pin itself (hollow/dashed),
  or keep pins uniform and show it only in the popup?
- Timeline filtering: interval intersection (a circa-1850 event
  shows in an 1849-1851 window) or nominal-date only?
- BCE scope: is pre-1 CE in scope for v1, or does the pilot clamp
  to CE dates and defer BCE handling?
