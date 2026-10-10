# Stretch A — Individuals: from words in a description to a searchable field

> **Status: done (2026-10-10), Levels 1 and 2**, on branch `search-lexical`.
> Answers to the questions at the bottom: **the general `event_entities`
> table** (only `type = 'person'` so far), and **no backfill** — existing
> events gain people when re-extracted. Verified locally: the e2e-real
> `search-people` spec and the mocked person-row specs pass; the ingestion
> fixture's people assertions run in CI (they need Redis + MinIO). **Still to
> do by hand:** the Groq gate — `extract:verify -- --live --live-file
> <chapter.txt>` prints the share of events with non-empty `people`; run it
> (needs `GROQ_API_KEY`) before relying on the field. Normalisation strips a
> leading honorific only while two words remain, which reconciles the two
> rules below ("President Brigham Young" → `brigham young`, while "President
> Young" stays its own person hit). Re-running publish is idempotent by
> construction (`ON CONFLICT DO NOTHING`, like the event insert); the fixture
> doesn't re-run it.

Part of [19-search.md](./19-search.md). **A stretch goal** (19, decision 4).
It depends on S1 only, and S1 already gives "events that mention X" for free.

**Yes, it needs new tables, and eventually two:**

| Table          | Holds                                                                 | Level |
| -------------- | --------------------------------------------------------------------- | ----- |
| `event_people` | one row per _mention_: event id, the name as written, normalised name | 1–2   |
| `people`       | one row per _person_: canonical name, aliases, dates, maybe Wikidata  | 3     |

The stretch target is **Level 2**: a clickable `person` result built on the
mention table alone. `people` is what Level 3's identity work fills in later,
and Level 2 is designed so adding it doesn't break anything: `event_people`
gains a nullable `person_id`.

## Where names live today

Nowhere structured. `ExtractedEvent` has `title`, `description`, `dateText`,
`placeName`, `sourceText` and `anchor`. There is no `people` field, and
neither the map tables nor `packages/domain` have a person type. S1's
full-text index will already find "Brigham Young" wherever those words
appear, so **lexical person search comes for free with S1.** The question is
whether that is enough.

What it does _not_ give you:

- **Aliases.** "Young", "President Young", "Brother Brigham" and "the
  governor" all refer to one person. Plain text search finds only the
  spelling you typed.
- **Disambiguation.** "John Smith" is three different people in 19th-century
  Utah alone.
- **A person as a destination.** "Show me everywhere Brigham Young appears,
  in order" is effectively an automatic sequence: a path through time and
  space. That's compelling, but it needs identity.

## Three levels, pick how far to go

### Level 1 — mentions (recommended next step after S1)

Add `people: string[]` to the extraction schema. These are names exactly as
the source wrote them, the same verbatim discipline as `dateText` and
`placeName`. Carry them through `validate` → `publish` into an `event_people`
table:

```sql
CREATE TABLE event_people (
  event_id  text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name      text NOT NULL,            -- verbatim
  name_norm text NOT NULL,            -- unaccented, lowercased, honorifics stripped
  PRIMARY KEY (event_id, name_norm)
);
CREATE INDEX event_people_trgm_idx ON event_people USING GIN (name_norm gin_trgm_ops);
```

Search gains a `person` match field (`matchedOn: ["person"]`), weighted
between title and description, and trigram matching handles spelling drift.
**No person result kind yet.** A person match surfaces the events.

Cost: the Groq strict schema gains one array. That means more output tokens
(the 2,500-token ceiling in CLAUDE.md is a measured floor, so check headroom),
and extraction has to be re-run for existing documents. Plan 13's re-extract
machinery exists, but it is still real spend.

> **Groq-specific check before committing.** Strict JSON schema plus a new
> array field: verify the model actually populates it and doesn't return
> `[]` by default to satisfy the schema. Run it on the fixture corpus and
> one real chapter and count, before re-extracting everything.

### Level 2 — a `person` result kind, without identity

Group `event_people` by `name_norm` and return each distinct normalised name
as a hit: "Brigham Young — 14 events". Clicking filters the map to those
events and draws them as a time-ordered path, reusing the sequence rendering
from plan 18.

Its failure mode is visible and safe: aliases show up as separate rows
("Brigham Young — 14", "President Young — 3"). That is ugly but honest, the
same stance as one-layer-per-source.

### Level 3 — canonical people (entity resolution)

A `people` table with canonical ids, aliases and maybe a Wikidata QID, plus a
resolver that maps mentions to people. **This is plan 11's identity problem
in a different form**, and it should reuse plan 13's machinery rather than
invent its own: vector search proposes, a judge decides, a human arbitrates.
Wikidata linking is attractive, since it gives birth/death dates for
disambiguation. But as with Nominatim, a modern knowledge base will
confidently map historical names to the wrong person. **Not recommended
until plan 13 exists**, and even then only with a `geocode:review`-style
human review step.

## Recommendation

Build Level 1 and Level 2 together as the stretch goal. Level 1 alone would
change extraction without delivering anything visible, and Level 2 is a thin
query plus a reuse of the sequence rendering. Level 3 should be planned with
fusion (plan 13), not with search.

### What the `person` result does (Level 2)

- **Row:** person icon, name, `14 events · 1847–1877`.
- **Click:** filter the map to the person's events, fit to them, and draw them
  as a time-ordered path. This is plan 18's sequence rendering with the
  member order coming from `date` instead of `seq`. The proximity rule still
  applies: someone whose events span a continent gets the filter without the
  path.
- **Panel:** the same shape as the sequence panel, listing events in date
  order. Aliases from Level 2 grouping ("also appears as: President Young")
  show only once Level 3 exists. Until then, separate rows _are_ the alias
  display.

## E2E specs

### Ingestion fixture

- The fake `ExtractionEngine`'s canned output gains `people` for two fixture
  events. After `publish`, `event_people` holds those names verbatim, with
  `name_norm` unaccented, lowercased and honorific-stripped ("President
  Brigham Young" → `brigham young`).
- An event with `people: []` writes no rows. Re-running is idempotent.
- **Groq schema check (manual, `extract:verify -- --live`):** on one real
  chapter, the share of events with non-empty `people` is printed. This is
  the "does the model actually fill it" gate from Level 1, recorded as a
  number before the field is relied on.

### `e2e-real/specs/api/search-people.spec.ts`

Fixture: `fx-ev-young-1/2/3` mention "Brigham Young", "President Young" and
"Brigham Young" across 1847–1877. One also mentions "John Smith".

| Case                  | Asserts                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| person match field    | `q=brigham young` → event hits with `matchedOn` containing `person`, ranked above a body-only mention                   |
| person kind           | the same query → a `person` hit, `brigham young`, with `eventCount = 2` and the date range                              |
| aliases stay separate | `q=young` → `brigham young` and `president young` are **separate** person hits (the Level 2 honesty rule)               |
| trigram               | `q=brigam young` → still finds the person hit                                                                           |
| timeline              | `from=1870&to=1880` → the person's `eventCount` counts in-range events only. A person with no in-range events is absent |

### `e2e/search-actions.spec.ts` — the person row

- Renders with the person icon, name and `N events · range`.
- Clicking filters the map to their events, shows the chip, and draws the
  date-ordered path. With the stubbed members a continent apart, there's no
  path, only the filter (the proximity rule).
- The panel lists events in **date** order, not `seq`.

## Other entities, same pattern

Organisations, ships and tribes/nations all have the same shape: a
`string[]` extracted verbatim with a `*_norm` column. If people work, the
cleanest generalisation is a single `event_entities(event_id, type, name,
name_norm)` table rather than one table per type. Worth deciding now, before
the first one ships, because migrating from `event_people` later means a
rename plus a backfill.

## Questions for you (when the stretch goal is picked up)

1. People only, or the general `event_entities` table from the start?
2. Is it acceptable to re-run extraction over the existing corpus to backfill
   names? Alternatively, a cheaper one-off pass could extract names from
   `description` + `sourceText` only, without re-reading documents.
