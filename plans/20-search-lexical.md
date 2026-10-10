# S1 — Lexical search: indexes, the unified endpoint, dates

> **Status: done (2026-10-10)** on branch `search-lexical`. Verified locally
> against Postgres (PGlite with `pg_trgm`/`unaccent`/PostGIS): every spec below
> passes — `e2e/search-query`, `search-static`, `split-passages`, and the
> e2e-real `search`/`search-golden` specs, alongside the rest of the API suite.
> The ingestion-fixture additions need Redis + MinIO and run in CI only.
> Deviations from the text below, each recorded where it applies: the
> splitter rule (measured, see "Splitting paragraphs"); an event matches
> together with its place name (so `-exclusions` and cross-field words work);
> `MatchField` gained `"member"`; text documents' passage anchors are `¶3` /
> `¶3.2` rather than nesting; the fixture documents use fixed uuids, since
> `ingest_documents.id` is a uuid. Map pins still filter by the stored year
> while search uses precision-aware spans — S2 aligns the pins.

Part of [19-search.md](./19-search.md). No new infrastructure. Every extension
used here is already available locally and on RDS.

## Why `ILIKE` has to go

`searchEvents` builds `%q%` and `ILIKE`s it against three columns:

- **No ranking.** Results come back `ORDER BY e.date`, so a title match and a
  passing mention in the eighth sentence of a description rank the same.
- **No stemming.** "massacred" does not find "massacre", and "emigrants" does
  not find "emigrant".
- **No phrase handling, no multi-word AND.** `Brigham Young Utah` matches
  only when that exact substring appears.
- **No index use.** A leading `%` defeats every b-tree. That's fine at 60
  rows and quietly linear after that.

Keep `EventQuery.q` working for existing callers (`/api/data/search`, MCP
`search_events`), but route it through the new matcher so those callers
improve too.

## Postgres building blocks

| Need                       | Tool                                                    | Note                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stemmed, ranked word match | `tsvector` + `websearch_to_tsquery('english', q)`       | `websearch_to_tsquery` accepts what users actually type: `"quoted phrase"`, `or`, `-exclude`. It never throws on malformed input, unlike `to_tsquery`.                                                                                  |
| Field weighting            | `setweight(…, 'A'/'B'/'C')` + `ts_rank_cd`              | Weights: title A, place/date_text B, description C, source quote (`events.source`) D.                                                                                                                                                   |
| Prefix (typeahead)         | `to_tsquery('english', 'brigh:*')` on the last token    | Build it from tokenised input, escaping everything. Never hand raw input to `to_tsquery`.                                                                                                                                               |
| Typos and proper names     | `pg_trgm` (`%`, `word_similarity`) + GIN `gin_trgm_ops` | Stemming mangles names ("Young" → "young", "Tula" stays "tula"), and nobody spells "Tenochtitlan" right the first time. Trigrams on **titles and place names only**, not bodies.                                                        |
| Accents                    | `unaccent`                                              | "Tenochtitlán" must match "Tenochtitlan". `unaccent()` is not `IMMUTABLE`, so it can't go directly in a generated column. Wrap it in an `IMMUTABLE` SQL function with the dictionary named explicitly. This is the standard workaround. |
| Snippets                   | `ts_headline`                                           | Expensive, so run it only on the final top-N rows, never inside the ranking CTE.                                                                                                                                                        |

**Text search config: `english` for bodies, `simple` for names.** English
stemming improves recall on prose but can mangle proper nouns. A second
`simple`-config vector over title + place name (no stemming, no stop words)
keeps exact-name matches strong. The cost is one extra GIN index.

## Schema changes

### `events` — owned by `ensureSchema()` in `lib/postgres-storage.ts`

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

ALTER TABLE events ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', immutable_unaccent(coalesce(title, ''))),       'A') ||
    setweight(to_tsvector('english', immutable_unaccent(coalesce(date_text, ''))),   'B') ||
    setweight(to_tsvector('english', immutable_unaccent(coalesce(description, ''))), 'C') ||
    setweight(to_tsvector('english', immutable_unaccent(coalesce(source, ''))),      'D')
  ) STORED;
CREATE INDEX IF NOT EXISTS events_search_tsv_idx ON events USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS events_title_trgm_idx ON events USING GIN (immutable_unaccent(title) gin_trgm_ops);
```

**The source quote is searchable, at the lowest weight** (decided, 19). An
event can be found by words that appear only in the book's original sentence,
such as "the Fancher train" when the model's description says "a party of
emigrants". Old spellings and names the model paraphrased away stay
findable, and they're exactly what people search for.

- **Where the quote lives:** `events.source`. `publish` writes
  `ExtractedEvent.sourceText` there (`publishing.service.ts`). For the
  hand-curated events in `data/map-data.json`, the same column holds a
  citation ("Utah Division of State History"). Indexing it at weight D is
  harmless for those, since an archive name is a reasonable thing to find an
  event by. But the column's meaning is overloaded. If it's ever split
  (`source_quote` vs `citation`), this generated column follows the quote.
- **Weight D, not C:** a word in the model's own description is better
  evidence of what the event is _about_ than a word that only appears in the
  surrounding sentence.
- **`matchedOn` gains `"quote"`**, so the UI can say "matched the source
  text" when nothing in the title or description is highlighted.

**One sentence, one result.** The quote also lives inside its paragraph in
`document_passages`, so without care the same sentence comes back twice, as
the event and as the passage. Fold them:

- When an event hit and a passage hit are linked by `passage_events`, drop
  the passage from the passage group and attach it to the event hit as
  `quotePassage: { documentId, anchor, snippet }`. The event row then shows
  the original wording as its snippet, which is the better snippet anyway.
- An unlinked passage (no event extracted from it) stays a passage hit, as
  before.
- Folding happens per response, after ranking, in `lib/search.ts`, so both
  `/api/search` and the MCP tool get it.

**The place name is not in `events`.** It lives in `locations.name`, and a
generated column cannot reach across a join. Give `locations` its own
`search_tsv` and trigram index, and in the query take the max of the two
ranks. Avoid denormalising with a trigger: a renamed location
(`geocode:review --set`) would then have to rewrite every event row, which is
the kind of quietly-stale data this codebase keeps getting bitten by.

Same treatment for **`event_groups`** (sequences): title A, description C. A
sequence should _also_ match on its members' titles. "Siege" should surface
the Mountain Meadows sequence. Do that at query time by joining
`event_group_members`, not by storing member titles on the group, for the
same staleness reason.

### `document_passages` — new, owned by ingest (TypeORM migration)

The source documents' text is the one thing not in Postgres today. Full-text
search over source files needs it there, **one row per paragraph** (decided,
19).

**Terms, because both exist:** the text artifact in object storage is split
into _segments_, which are pages for PDFs (`p.43`), blank-line blocks for text
(`¶3`) and sections for HTML (`§…`). Search indexes _passages_: paragraphs cut
from those segments. Extraction keeps chunking by segment, unchanged. Only
the search index uses the paragraph grain.

```sql
CREATE TABLE document_passages (
  document_id      uuid NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
  seq              int  NOT NULL,        -- paragraph order within the document
  segment_anchor   text,                 -- "p.43": the artifact segment it starts in
  para_index       int  NOT NULL,        -- 1-based within that segment
  anchor           text NOT NULL,        -- "p.43¶2": display + link key
  text             text NOT NULL,
  extractor_version int NOT NULL,        -- which cleaning produced the source text
  splitter_version  int NOT NULL,        -- which paragraph splitter cut it
  search_tsv       tsvector GENERATED ALWAYS AS (
                     to_tsvector('english', immutable_unaccent(text))) STORED,
  PRIMARY KEY (document_id, seq)
);
CREATE INDEX document_passages_tsv_idx ON document_passages USING GIN (search_tsv);

-- Which published events were extracted from which paragraph (see below).
CREATE TABLE passage_events (
  document_id uuid NOT NULL,
  seq         int  NOT NULL,
  event_id    text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, seq, event_id),
  FOREIGN KEY (document_id, seq) REFERENCES document_passages ON DELETE CASCADE
);
```

The deep link stays page-level: `p.43¶2` links to `#page=43`, because browser
PDF viewers can't scroll to a paragraph. The paragraph's own text is what the
document panel highlights (21). So "which paragraph" is answered in our UI,
and "which page" is answered in the PDF.

#### Splitting paragraphs — a heuristic for PDFs, so measure it first

Text and HTML sources have real paragraph boundaries. **PDFs don't.**
`reflowParagraphs` (`libs/parsers/src/cleaning/text-rules.ts`) joins line wraps
conservatively: it joins only when the next line starts lowercase and the
previous one doesn't end in punctuation. A newline that survives cleaning is
therefore _either_ a paragraph break _or_ a wrap it declined to join. The
splitter, `libs/parsers/src/passages/split-passages.ts`, is pure and
versioned:

1. **Boundaries:** blank lines always. Otherwise a newline counts as a
   boundary only when the previous line ends in sentence punctuation **and**
   the line is noticeably shorter than the page's typical line length. A
   short last line is the most reliable paragraph signal in typeset text.
2. **Size bounds:** merge fragments under ~200 characters into their
   neighbour, and split paragraphs over ~1,500 characters at sentence
   boundaries. This keeps passages useful as snippets and, in S3, as
   embedding units.
3. **Across page breaks:** when a page's last paragraph doesn't end in
   sentence punctuation and the next page starts lowercase, it's one
   paragraph. Its `anchor` is the page it _starts_ on.

**Before building it**, run the splitter over the real book's artifact and
print the length distribution plus 20 random passages. Same measure-first
rule as the cleaning work. If PDF paragraphs come out unreliable, the
fallback is fixed-size sentence windows (~3 sentences, overlapping by one),
which still gives tight snippets. That's a splitter-version bump, not a
schema change.

> **Measured (2026-10-10), and the heuristic above was replaced.** On the real
> artifact (`short_history_of_mexico.pdf`, 83 pages, 322k characters after
> cleaning) there are no typeset lines to measure: `unpdf` plus
> `reflowParagraphs` already joins most wraps, leaving 1,670 lines with a median
> of 123 characters and **zero blank lines**. A surviving newline is either a
> paragraph end (the line closes a sentence) or a wrap `reflowParagraphs`
> declined because the next line starts uppercase ("at the time of the\n
> Conquest are"). So the shipped splitter (`SPLITTER_VERSION = 1`) splits on
> sentence punctuation (abbreviation- and initialism-aware) and headings, not
> line length; an open paragraph continues across a page break whatever the
> next page's case, unless that page opens with a heading; and a heading always
> starts a passage. Result: **483 passages**, median 639 characters (p5 249,
> p95 1,251), none under 200 or over 1,500, none starting lowercase, none ending
> mid-sentence, 59 crossing a page. Twenty random samples all read as real
> paragraphs, so the sentence-window fallback isn't needed.

#### Writers

- **`extract-text`** writes passages each time it writes the artifact: delete
  then insert in one transaction, keyed on `document_id`, on the same
  `EXTRACTOR_VERSION` trigger as everything else.
- **`SPLITTER_VERSION` is separate from `EXTRACTOR_VERSION`.** Tuning
  paragraph splitting re-cuts passages from the stored artifact. It doesn't
  re-clean, re-fetch or re-extract events. `search:backfill-passages`
  handles both "never indexed" and "indexed by an older splitter".
- **`passage_events` is written by `publish`**, because events don't exist
  yet when `extract-text` runs. For each event it publishes, it looks within
  the event's `anchor` page for the paragraph containing the event's
  normalised `sourceText`, reusing `checkGrounding`'s normalisation (the
  same reuse plan 14 proposes for anchor backfill). If no paragraph contains
  the quote (about 31% of quotes, measured in plan 14), the event links to
  no paragraph. It still has its page anchor, so it degrades to page-level
  rather than guessing. Re-splitting re-runs this linking for the document's
  existing events.

**This deliberately bends the "Postgres keeps only keys" rule, and it is
worth it.** That rule exists so that object storage is the single source of
truth for text, and that still holds: `document_passages` is a derived,
disposable index and can be rebuilt from artifacts with no network fetch.
The alternative is a separate search store, which breaks the bigger rule
(one datastore). It replaces what plan 12 calls
`document_segment_embeddings`: S3 adds an `embedding` column here rather
than creating a second table with the same key. Paragraphs are a better
embedding unit than pages anyway, and plan 14's RAG retrieval gets tighter
citations from them too.

> **Size:** one book ≈ 322k characters (plan 12). At roughly 600–800
> characters per paragraph, that's about 400–550 rows per book.

**Who reads `ingest_*` tables from the web app?** `getIngestedDocument` already
does, so the precedent exists. The web app treats `document_passages` and
`passage_events` as read-only, the same as it does the ingest tables.

## Dates in the query

Dates are the most common thing people type into a historical search, and
lexically they are useless: `1847` matches the token `1847` only in text that
happens to contain it. Parse dates **out of the query** and turn them into a
range filter:

| Input                        | Becomes                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `1847`                       | year 1847                                                                                            |
| `1840s`, `the forties` (no)  | 1840–1849 (decade digits only; don't guess words)                                                    |
| `18th century`, `1700s`      | 1700–1799                                                                                            |
| `1847-1850`, `1847 to 1850`  | inclusive range                                                                                      |
| `spring 1847`, `March 1847`  | that year (sub-year precision is a v2 refinement)                                                    |
| `before 1850` / `after 1850` | open-ended range                                                                                     |
| `1520 BC`                    | **out of scope.** `events.date` is a `date` and the corpus has none. Flag it, don't half-support it. |

**Range overlap must respect `date_precision`.** This is the same interval
logic plan 13 needs for dedup: a `year`-precision event stored as
`1847-01-01` covers all of 1847, and a `circa` event covers ± a tolerance. Put
the interval function in one place (`packages/domain`) so search and fusion
share it rather than drifting.

**Ranking with a date:** a parsed query date and an enabled timeline filter
are both applied (their intersection; see "What a timeline range means for
each kind" below). If the query is _only_ a date, return that period's
events in date order. That is a browse, not a search. If the query has both
words and a date, the date is a hard filter and the words rank. The remaining
text also searches `date_text` lexically, so "Spring 1847" still scores for
the event whose source said exactly that.

Put the parser in `app/map/utils/search-query.ts`, pure and unit-testable
(Playwright can test a pure function the way `popup-placement.spec.ts`
does). It returns `{ text, dateRange?, rawDate? }` and reports what it
recognised, so the UI can show a "1840–1849" chip the user can remove.
Silently reinterpreting input is the bug-report generator here.

## The endpoint

```
GET /api/search?q=…&mode=lexical|hybrid&prefix=1&kinds=event,sequence,location,document,passage&limit=…
               [&bbox=…&from=…&to=…&sources=…]   ← reuse parseEventQuery
→ {
    hits: SearchHit[],
    modes: { lexical: true, semantic: false, documents: true },
    parsed: { text: "mountain meadows", dateRange: [1857, 1857] }
  }
```

```ts
// packages/domain/src/search.ts — shared with the MCP tool and the UI
type SearchHit =
  | {
      kind: "event";
      id: string;
      title: string;
      snippet: string;
      score: number;
      date: string;
      datePrecision;
      locationId: string;
      coordinates: [number, number];
      sourceId: string | null;
      matchedOn: MatchField[];
      quotePassage?: { documentId: string; anchor: string; snippet: string };
    }
  | {
      kind: "sequence";
      id: string;
      title: string;
      snippet: string;
      score: number;
      memberCount: number;
      dateRange: [string, string];
      bbox: Bbox | null;
      matchedOn;
    }
  | {
      kind: "document";
      id: string;
      title: string;
      snippet: string;
      score: number;
      sourceId: string;
      bestAnchor: string | null;
      matchCount: number;
      eventCount: number;
      matchedOn;
    }
  | {
      kind: "location";
      id: string;
      title: string;
      snippet: string;
      score: number;
      coordinates: [number, number];
      eventCount: number;
      dateRange: [string, string] | null;
      matchedOn;
    }
  | {
      kind: "passage";
      id: string /* `${documentId}:${seq}` */;
      documentId: string;
      documentTitle: string;
      sourceId: string;
      anchor: string | null;
      snippet: string;
      score: number;
      eventIds: string[] /* from passage_events */;
      matchedOn;
    };
```

**The logic lives in `lib/search.ts`, not in the route.** The route only
parses params and serialises. This lets the MCP `search` tool (24) call the
same function directly, the way `search_events` calls `storage` today,
without a refactor later.

`prefix=1` is the typeahead path: the last token matches as a prefix. The
search bar sends it on keystrokes and drops it on Enter.

`matchedOn` (`"title" | "place" | "date" | "body" | "quote" | "person" | "meaning"`)
is how the UI can show _why_ something matched. That matters most for semantic
hits, where nothing in the snippet looks like the query.

**The timeline is the primary filter; space is global** (19, decision 3).
When `/map`'s timeline filter is enabled, the bar always sends its range as
`from`/`to`. It never sends `bbox` or `sources` unless the user adds the
"limit to view" chip, because search is also how you navigate to places
outside the current view. The MCP tool and plan 14's RAG use the same
optional filters.

### What a timeline range means for each kind

Not every kind has a date, so "filtered by the timeline" needs a definition
per kind. All of them use the precision-aware interval overlap from "Dates in
the query":

| Kind     | In range when                                                                           | Note                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event    | its date interval overlaps the range                                                    | Same rule as the map's pins, so a hit is always a pin you can see.                                                                                                                                                                                       |
| Sequence | its derived date range (from its members) overlaps the range                            | The hit carries how many members are in range ("3 of 5 events in range"). That matches the existing rule that a focused sequence shows all members regardless of year.                                                                                   |
| Location | at least one of its events is in range                                                  | `eventCount` and `dateRange` count **in-range events only**, so "14 events" doesn't promise pins the timeline is hiding.                                                                                                                                 |
| Passage  | the passage has an anchored event in range, **or** its document's events span the range | Segments carry no date of their own. **Decided: lenient** (19). An undated page about Aztec religion in a book whose events span 1100–1900 stays in for 1500–1600. Later refinement: inherit the nearest anchored events' dates from neighbouring pages. |
| Document | at least one of its events is in range                                                  | `eventCount` counts in-range events.                                                                                                                                                                                                                     |

**A query date and the timeline intersect.** "1840s" typed while the timeline
is set to 1500–1600 is an empty intersection. Don't return zero results
silently. Return `parsed.conflict = "timeline"`, so the UI can say "1840s is
outside your timeline (1500–1600)" and offer to widen it.

### Timing and the "add a timeline filter" hint

The response includes `timing: { ms, unfiltered: boolean }`. `unfiltered` is
true when no date filter of any kind applied (no timeline, no parsed date).
That's what the UI's slow-search hint keys on (21). The server doesn't decide
what "slow" means; the client does, because only the client knows how long
the user has been waiting, network included.

**Why the timeline helps performance**, so the hint isn't a placebo:
`events_date_idx` already exists, and a date range lets Postgres intersect it
with the GIN text index. For passages it matters more. Passages have no date
column, so the timeline filter joins through the document's event date span:
`document_id IN (documents with an event in range)`. That cuts the number of
passages that get ranked and `ts_headline`d. For the vector arm (23), a date
pre-filter is exactly the filtered-ANN case pgvector 0.8's iterative scan
exists for.

At today's corpus size nothing will be slow, so the hint is designed now and
will mostly lie dormant. It earns its place when the corpus is many books
and an unfiltered hybrid query ranks every passage in it.

**Merging across kinds.** `ts_rank_cd` scores are not comparable between
tables (they depend on document length and weights), so a single sorted list
across kinds would be noise dressed up as order. Two honest options:

1. **Grouped:** each kind gets its own ranked list, capped (e.g. 2 sequences,
   5 events, 3 documents). This is the Spotlight/Linear pattern.
2. **Interleaved by RRF:** rank within each kind, then fuse by reciprocal
   rank. This is the same machinery S3 needs for lexical + vector.

**Recommend grouped for S1**, with a single "top hit" row above the groups
when one hit dominates (an exact title match). That's simpler and easier to
explain, and the rank-fusion machinery lands properly in S3. See 21 for how
it renders.

**Passages and documents come from the same passage ranking.** This is the
main source of duplicate-looking results, so both are derived from one query:

- **Passages** are the top-ranked paragraphs, capped at 2 per document, so one
  long book can't fill the list.
- **Documents** roll up from passages: group by `document_id`. A document
  scores by its best passage, plus a little for how many passages matched,
  and a title match outranks any body match. `bestAnchor` is the top
  passage's page, so clicking can deep-link with the existing `#page=N`
  machinery. A document whose _only_ match is one passage that is already
  listed is dropped from the document group. The passage already says
  everything the document row would.
- **`eventIds`** on a passage lists the published events `passage_events`
  links to that paragraph. The UI uses it to offer "show event"
  on a passage, which also stops a passage and its own extracted event from
  looking like two unrelated hits.

**Locations** match on `locations.search_tsv` and trigrams of the name. They
rank by name match first and event count second, so the "Salt Lake City" with
14 events beats a single-event pin snapped nearby. Location names come from
Nominatim and are corrected by `geocode:review`, so they are modern names. A
query for a historical name ("Tenochtitlan") will usually find the _events_,
not the location. Aliases on locations would fix that. That's worth noting
here, but it's out of scope for S1.

### The highlight endpoint

```
GET /api/search/matches?q=…   (same params as /api/search)
→ { locationIds: string[], truncated: boolean }
```

This feeds live map highlighting (21). It returns the **distinct location
ids** of every lexically matching event, capped at ~5,000, with no
ranking, no snippets and no `ts_headline`. That makes it the cheapest query in
the track: one GIN index probe plus a `DISTINCT location_id`. Sequences,
documents and passages don't contribute, since they aren't pins. It shares
`lib/search.ts`'s parsing and filters, so the map and the list can't disagree
on what matches.

### The document panel's endpoint

The panel (21) needs more than one hit row can carry:

```
GET /api/documents/:id?q=…
→ { id, title, sourceId, sourceName, extractedAt,
    passages: [{ seq, anchor, snippet, eventIds }],   // all matching paragraphs for q, in document order
    events:   [{ id, title, date, datePrecision, anchor }] }
```

`passages` reuses the passage query restricted to one `document_id`. Without
`q`, it returns no passages and the panel is just the document's event list.
`events` needs `EventQuery.documentId`, the small addition 21 also uses for
"show on map".

## Static backend

`lib/server-storage.ts`'s JSON path gets an in-memory scorer: tokenise,
lowercase, strip accents, weight title > place > description, and use the
same date parser. No stemming. It's good enough for a hand-curated 44-event
file, and it means the stdio MCP server's search keeps working. It returns
`modes.documents = false`, so no document or passage hits. Locations and
sequences still work, because both exist in the JSON tier.

**Not searched: `localStorage`.** Events added through `/map/import` never
reach the server. That feature is being deprecated (19, decision 5), so search
does not merge client-side results.

## Security and limits

- Clamp `q` to around 200 characters and `limit` to 50. `websearch_to_tsquery`
  is safe against syntax errors, but long inputs still cost CPU.
- `/api/search` falls under the existing middleware per-IP rate limit. It is
  read-only, so it follows the same no-key-means-allow policy as
  `/api/data/search`.
- Snippets come from `ts_headline` with `StartSel`/`StopSel` markers the UI
  turns into `<mark>`. **Never render them as HTML.** Source text is
  untrusted data, so treat it the same way RAG treats retrieved passages in
  plan 14.

## E2E specs

Fixture ids refer to the search corpus in 19 ("Testing strategy").

### `e2e/search-query.spec.ts` — pure functions, no server

Table-driven over `parseSearchQuery` and the query builders:

- **Dates:** `1847` → [1847, 1847]. `1840s` → [1840, 1849]. `18th century` and
  `1700s` → [1700, 1799]. `1847-1850`, `1847 to 1850` and `1847–1850` (en dash) →
  [1847, 1850]. `before 1850` → [−∞, 1849]. `after 1850` → [1851, ∞].
  `March 1847` → [1847, 1847] with `rawDate` kept. `1520 BC` → no range, with
  `unsupported: "bce"` reported.
- **Residual text:** `mountain meadows 1857` → text `mountain meadows` plus a
  range. A query that is only a date → empty text (the "browse" path).
- **Non-dates stay text:** `Highway 89` and `Fort 1` aren't years, and a
  four-digit number only counts as a year in a plausible range or with a
  date word. Check this case explicitly; it's where parsers misfire.
- **Prefix builder:** the last token gets `:*`, and `&`, `|`, `!`, `:`, `(`,
  `)` and `'` are escaped. Assert that the built string is exactly what's
  expected, so an injected operator can never reach `to_tsquery`.
- **Interval overlap** (`packages/domain`): `year` 1848 overlaps [1848,
  1848]. `circa` 1848 overlaps [1850, 1860] only within the tolerance. `day`
  1857-09-11 doesn't overlap [1858, 1860].

### `e2e-real/specs/api/search.spec.ts` — the endpoint against real Postgres

Calls `GET /api/search` through Playwright's `request` fixture, the same way
`auth-matrix.spec.ts` does.

| Case                    | Request                                                                    | Asserts                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| stemming                | `q=massacred`                                                              | `fx-ev-massacre` is the top event                                                                                                |
| field weighting         | `q=meadows`                                                                | `fx-ev-massacre` (title) ranks above `fx-ev-meadows-body` (body)                                                                 |
| accents, both ways      | `q=Tenochtitlan`, then `q=Tenochtitlán`                                    | both return `fx-ev-tenochtitlan`                                                                                                 |
| typo (trigram)          | `q=Tenochitlan`                                                            | `fx-ev-tenochtitlan` in the top 3                                                                                                |
| phrase                  | `q="at the meadows"`                                                       | matches the exact phrase only                                                                                                    |
| exclusion               | `q=meadows -massacre`                                                      | `fx-ev-massacre` absent                                                                                                          |
| prefix                  | `q=tenoch&mode=lexical&prefix=1`                                           | typeahead path finds it from a partial word                                                                                      |
| every kind              | `q=meadows`                                                                | `hits` has `event`, `sequence` (`fx-grp-meadows`) and `passage`/`document` (`fx-doc-1`), each with the right `kind`              |
| sequence via member     | `q=<a member-only word>`                                                   | `fx-grp-meadows` appears though its own title doesn't contain the word                                                           |
| location                | `q=salt lake`                                                              | `fx-loc-slc` hit with `eventCount = 4`                                                                                           |
| passage cap             | `q=<word in all 8 paragraphs of fx-doc-1>`                                 | at most 2 passages from `fx-doc-1`, and one `document` hit with `matchCount = 8`                                                 |
| paragraph grain         | `q=<word only in p.1¶3>`                                                   | exactly one passage, anchor `p.1¶3`, and the snippet is from that paragraph, not the rest of page 1                              |
| cross-page paragraph    | `q=<word from the half on page 2>` of the paragraph spanning p.1→p.2       | one passage, anchored `p.1¶4` (where it starts)                                                                                  |
| passage `eventIds`      | `q=<word in p.1¶2>`                                                        | that passage's `eventIds` contains the event whose quote is in it                                                                |
| unlinked quote          | the fixture event whose `sourceText` matches no paragraph                  | no passage lists it, and the event still has its page anchor (degrades to page-level)                                            |
| date-only browse        | `q=1840s`                                                                  | exactly `fx-ev-1840s-a/b` events, in date order                                                                                  |
| **timeline, per kind**  | `q=meadows&from=1500&to=1600`                                              | no 1857 event, `fx-grp-meadows` absent, `fx-loc-slc` absent                                                                      |
| timeline counts         | `q=salt lake&from=1847&to=1850`                                            | `fx-loc-slc` present with `eventCount` = in-range events only                                                                    |
| lenient passages        | `q=<word in unlinked p.3¶2>&from=<within fx-doc-1's event span>`           | the p.3¶2 passage (no linked event) is still returned                                                                            |
| lenient, out of span    | same `q`, `from`/`to` outside the span                                     | p.3¶2 passage absent                                                                                                             |
| conflict                | `q=1840s&from=1500&to=1600`                                                | `hits` empty **and** `parsed.conflict = "timeline"`                                                                              |
| timing                  | any `q`, no dates                                                          | `timing.unfiltered = true`. With `from`/`to`, it's `false`                                                                       |
| clamps                  | `q` of 1,000 chars; `limit=500`                                            | 200 OK, query truncated, at most 50 hits                                                                                         |
| hostile input           | `q=' & \| ! :* (` (tsquery operators)                                      | 200 OK with zero hits, never a 500                                                                                               |
| `ts_headline` is text   | a passage containing `<script>`                                            | snippet is returned with its markers escaped, never as markup (the UI half of this is in 21)                                     |
| matches endpoint        | `GET /api/search/matches?q=meadows`                                        | distinct location ids of the matching events; with `from=1500&to=1600` the 1857 location is absent; cap → `truncated: true`      |
| quote-only match        | `q=<word only in fx-ev-massacre's source quote>`                           | `fx-ev-massacre` is returned with `matchedOn` containing `quote`, ranked **below** an event that has the word in its description |
| one sentence, one hit   | the same query, where the quote's paragraph is linked via `passage_events` | the event hit carries `quotePassage`, and that paragraph is **absent** from the passage group                                    |
| unlinked passage stays  | a word in a paragraph with no linked event                                 | returned as a normal passage hit                                                                                                 |
| `EventQuery.q` callers  | `GET /api/data/search?q=massacred`                                         | the old endpoint now finds the stemmed match (proves the shared matcher reached it)                                              |
| document panel endpoint | `GET /api/documents/fx-doc-1?q=…`                                          | passages in document order, and `events` lists both anchored events. `fx-doc-2` → `events: []`                                   |

### `e2e-real/specs/api/search-golden.spec.ts`

One generated test per entry in `golden-queries.ts` with `mode: "lexical"`.
Kept separate from the spec above, because that one tests _features_ and
this one tests _ranking quality_. When a ranking change breaks a golden
query, it should be obvious which kind of failure it is.

### Ingestion fixture — `run-ingestion-fixture.ts` additions

- After `extract-text`, `document_passages` has rows for every fixture
  document, with `anchor`, `extractor_version` and `splitter_version` set.
  The fixture corpus needs one `.txt` document with blank-line paragraphs
  and one PDF with a paragraph that crosses a page break, so both splitter
  paths run through the real pipeline.
- After `publish`, `passage_events` links each fixture event whose quote is
  in a paragraph. The fake extraction output includes one quote that isn't
  verbatim in the text, and it produces no link.
- Re-running with the same version leaves the row count and content
  unchanged (idempotent delete-then-insert).
- Bumping `EXTRACTOR_VERSION` for the run replaces the rows with the new
  version. No duplicates and no orphaned old-version rows.
- Bumping `SPLITTER_VERSION` alone → passages re-cut, `passage_events`
  re-linked. **No** new `ingest_extractions` rows and no fetch: assert on the
  fake engine's call count and the storage client's GET log.
- `search:backfill-passages` over a document that has an artifact but no
  rows produces the same rows `extract-text` would have.

### `e2e/split-passages.spec.ts` — the splitter, pure

Table-driven over `splitPassages(segments)` (imported from the ingest
parsers lib; a pure function, so the mocked suite can run it like
`popup-placement.spec.ts`):

- Blank lines split. A short last line after `.` splits. A full-length line
  ending in `.` followed by a capitalised line does **not** split (that's a
  mid-paragraph sentence wrap).
- A paragraph whose page ends without punctuation, with the next page
  starting lowercase, is joined, anchored to the first page.
- Fragments under the minimum merge. Over-long paragraphs split at a sentence
  boundary, never mid-sentence.
- Abbreviations ("Mr.", "St.", "A.D.") at line end don't count as sentence
  ends for the boundary rule.
- `¶` anchors restart at 1 on each page.
- The splitter is deterministic: the same input gives the same output, so
  re-runs are idempotent.

### Static backend

`e2e/search-static.spec.ts` is a pure-function spec over the in-memory scorer,
using `TEST_LOCATION`-style data: it ranks title above description, folds
accents, applies the date parser, and reports `modes.documents = false`.
There's no server to stand up, because the JSON path is just a function over
`HistoricalEventsData`.
