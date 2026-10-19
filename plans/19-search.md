# Search — phase index

**Status: design, not scheduled.** Five files, read in order. Each phase gets
discussed again right before it is built, following the working agreement in
[00-README.md](./00-README.md).

One search bar on `/map` that finds **events**, **sequences** and **source
documents**. Each result shows which kind it is, and clicking it does whatever
fits that kind. It runs in two modes:

- **Lexical.** Full-text search over event titles and bodies, dates, place
  names, people's names and the source documents' own text.
- **Semantic.** Natural-language queries ("the attack on the emigrant wagon
  train in southern Utah") that should find the right event even when no word
  in the query appears in it.

## What exists today

| Piece                                                   | State                                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EventQuery.q` → `searchEvents()`                       | `ILIKE '%q%'` over `title`, `description`, `locations.name`. No ranking, no stemming, no index. Results come back `ORDER BY date`. Used by `/api/data/search` and MCP `search_events`. |
| Search UI on `/map`                                     | **None.** No component calls `/api/data/search`.                                                                                                                                       |
| `pg_trgm`, `unaccent`, `fuzzystrmatch`                  | _Available_ in the local image (plan 12). **None are created** (`ensureSchema` only creates `postgis`).                                                                                |
| `vector` (pgvector)                                     | **Not available** in the local image. RDS 16.4 ships pgvector **0.7.3**.                                                                                                               |
| Event embeddings (plan 12/13)                           | Designed, not built. No Bedrock SDK anywhere.                                                                                                                                          |
| Document text                                           | Lives **only in object storage** as the structured text artifact. Postgres stores keys and counts, never the text, so it cannot be full-text searched today.                           |
| Sequences (`event_groups`, plan 18)                     | **Built.** They have a title, description and members, and the admin app edits them.                                                                                                   |
| "View source" (`/api/documents/:id/source` + `#page=N`) | **Built.** A document result can reuse it as-is.                                                                                                                                       |
| People / individuals                                    | **No model at all.** Names exist only as words inside `title`/`description`/`sourceText`.                                                                                              |

## Phases

| #         | File                                             | Delivers                                                                                                                                                                                                         | Needs installed                                                                               |
| --------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| S1        | [20-search-lexical.md](./20-search-lexical.md)   | `tsvector` + `pg_trgm` indexes, the unified `/api/search` returning typed hits for all five kinds, date-aware query parsing, and `document_passages` in Postgres.                                                | Nothing new. `CREATE EXTENSION pg_trgm, unaccent` only.                                       |
| S2        | [21-search-ui.md](./21-search-ui.md)             | The search bar, typed result rows, the click action for each kind, and the document panel. Can start against S1's API as soon as its contract is fixed. None. The combobox and bottom sheet are hand-built (21). |
| S3        | [23-search-semantic.md](./23-search-semantic.md) | Embeddings for events, sequences and passages, a hybrid lexical + vector ranker (RRF), and query embedding at request time.                                                                                      | pgvector in the local/CI image, RDS minor upgrade to ≥ 16.5, Bedrock SDK in web app + ingest. |
| Stretch A | [22-search-people.md](./22-search-people.md)     | People as structured data in their own table, and a `person` result kind.                                                                                                                                        | Nothing. Changes the extraction schema.                                                       |
| Stretch B | [24-search-mcp.md](./24-search-mcp.md)           | A typed `search` tool on the MCP server that reuses `/api/search`'s core.                                                                                                                                        | Nothing.                                                                                      |

S1 and S2 make up the minimum shippable search, and they need no new
infrastructure. S3 is the only core phase that needs any installing, and it
shares its substrate with plans 12–14, so the embedding work gets paid for once
and serves dedup, RAG and search. The stretch goals depend on S1 only.

## Decisions this proposes

1. **Postgres is the search engine.** No Meilisearch, Typesense, OpenSearch or
   Elasticsearch. This is the same locked "one Postgres, no second datastore"
   decision, and at this corpus size (60 events, one book) an external engine
   would add more operational surface than it removes. It would start to pay
   at roughly 10⁵–10⁶ passages, or if we need typo-tolerant faceting that
   `pg_trgm` can't match. Revisit then, not now.
2. **One endpoint, typed hits.** `GET /api/search` returns
   `SearchHit[]`, where each hit carries a `kind` discriminant. Each kind is
   ranked by its own query, and the response merges them (see 20). The bar
   never calls a separate endpoint per kind.
3. **Lexical on every keystroke, semantic only on submit.** Typeahead runs
   lexical search only, because it is cheap, deterministic and fast enough to
   debounce at about 150 ms. Pressing Enter (or a "search by meaning" toggle)
   runs the hybrid query, which costs one Bedrock call. This keeps the per-query
   bill to one embedding per _deliberate_ search rather than one per
   character.
4. **The search index is derived, never authoritative.** `document_passages`
   and every embedding row can be rebuilt from object storage plus the map
   tables. This keeps the existing rule that object storage owns the text and
   bends only the half that says "Postgres holds only keys and counts". 20
   argues why that is acceptable.
5. **Static backend degrades, never errors.** Without `POSTGRES_URL`
   (`data/map-data.json`, the stdio MCP server), search falls back to in-memory
   scoring over events and sequences. It returns no document hits and no
   semantic mode, and the response says which modes ran so the UI can say so.
6. **Measure ranking against a golden set.** About 30 hand-written queries
   with expected hits, checked into `e2e-real/fixtures/`, and run in CI against
   the seeded corpus. Lexical and hybrid are compared on it before S3's ranker
   ships. That is how this repo has made every threshold decision so far. See
   "Testing strategy" below.

## Looking ahead: gamification

Not planned, but noted so search doesn't close doors. `EventCard` already has
an `isAcknowledged`/`onAcknowledge` hook. If "discovering" events becomes a
game mechanic, search is both a shortcut around it and a natural place for
it ("12 of 40 events from this book found"). Two cheap choices now keep that
option open:

- **Every result kind has a stable id** (`kind:id` in the URL state, 21), so a
  later progress table can key on the same ids search returns.
- **Search actions go through one dispatcher** (the imperative `flyTo` /
  `openPopup` / `focusGroup` / `filterToDocument` API in 21), so a later
  "discovered" event has exactly one place to hook in.

Whether search should be _limited_ in a game mode (finding things by
exploring rather than typing) is a design question for when gamification is
planned, not now.

## Testing strategy

Every phase ships with its E2E specs. They are listed per phase under "E2E
specs" in each file, and **a phase isn't done until its specs are green in
the `E2E` workflow** (the CLAUDE.md watch-CI-until-green rule). This section
holds what the phases share.

### Which suite tests what

The repo's three existing suites, each used for what it's already good at:

| Suite                                          | Runs against                                           | Search uses it for                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/` (mocked)                                | `npm run dev`, every fetch stubbed (`e2e/fixtures.ts`) | The UI: rows, kind labels, click actions, timeline chip, slow-search hint. Plus pure-function specs like `popup-placement.spec.ts`. |
| `e2e-real/` (real)                             | Postgres + Martin + the real `/map` and admin apps     | SQL behaviour: ranking, stemming, accents, timeline semantics per kind, the golden set, and a few full round-trips through the UI.  |
| Ingestion fixture (`run-ingestion-fixture.ts`) | Real pipeline, fake `ExtractionEngine`                 | That `extract-text` writes `document_passages`, the embed sweep (S3), and people mentions (Stretch A).                              |

**Pure-function specs go in `e2e/`**, because the repo has no unit-test
runner and `popup-placement.spec.ts` already established that Playwright
specs work fine for this. Adding Vitest just for search would be a second
test runner to maintain. Revisit if pure-function specs reach a dozen files.

### The search fixture corpus — `e2e-real/fixtures/search-seed.ts`

The existing `seed-data.ts` (two sources, a few `fx-*` pins) was built for
pins and popups, not ranking. Search gets its own fixture, seeded by the same
`global-setup.ts` and kept small enough that every expected hit can be
asserted by id:

| Fixture                                                                                                                                    | Exists to test                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `fx-ev-massacre`, "Massacre at the Meadows", 1857, `day`                                                                                   | stemming ("massacred", "massacres"), title-over-body ranking                                                                    |
| `fx-ev-meadows-body`, unrelated title, "meadows" in the body only                                                                          | ranks _below_ the title match                                                                                                   |
| `fx-ev-tenochtitlan`, "Fall of Tenochtitlán", 1521, `year`                                                                                 | accent folding both ways, trigram typo ("Tenochitlan")                                                                          |
| `fx-ev-1840s-a/b`, 1843 `year` and 1848 `circa`                                                                                            | decade parsing, precision-aware overlap (`circa` 1848 hits an 1850–1860 range only within tolerance)                            |
| `fx-ev-1520`, 1520                                                                                                                         | timeline 1500–1600 includes it; the `1840s`-outside-timeline conflict                                                           |
| `fx-grp-meadows`, sequence of 3 members in 1857                                                                                            | sequence kind, match through a member title, "N of M in range"                                                                  |
| `fx-loc-slc`, "Salt Lake City", 4 events across 1847–1896                                                                                  | location kind, in-range `eventCount`                                                                                            |
| `fx-doc-1`: 3 pages, 8 paragraphs (one spans p.1→p.2), events quoted from p.1¶2 and p.3¶1, plus one event whose quote matches no paragraph | paragraph grain, cross-page join, document roll-up, passage cap (2 per doc), `passage_events`, the lenient undated-passage rule |
| `fx-doc-2`, no published events                                                                                                            | the document panel's "no published events" state                                                                                |

**Ownership of the ingest tables.** `fx-doc-*` rows go in
`ingest_sources`/`ingest_documents`/`document_passages`. Today
`global-setup.ts` truncates only the map tables, and the ingestion fixture
owns the `ingest_*` tables. To keep that split, the e2e-real reset **deletes
its own `fx-doc-*` rows by id** rather than truncating `ingest_*`, so neither
suite can wipe the other's data. This also means e2e-real now needs ingest
migrations applied. CI already runs `migrate` before the real suite; the
local recipe in CLAUDE.md gains `npm run migrate --workspace=services/ingest`.

### No Bedrock in CI — a recorded embedder

CI has no AWS credentials, and it shouldn't. S3 adds `EMBEDDING_ENGINE=fake`
(same idiom as `EXTRACTION_ENGINE=fake`). A hash-based fake can't test
paraphrase matching, because the whole point is that the words differ. So
the fake is **a lookup over recorded real vectors**:

- `e2e-real/fixtures/search-vectors.json` holds real Titan v2 vectors (256
  dims) for every fixture text and every semantic golden query. That's around
  40 vectors, a few hundred KB.
- `npm run search:record-vectors` regenerates the file against live Bedrock.
  It runs only by hand, when fixture texts or the model change, the same as
  `extract:verify -- --live`.
- The fake **throws on any text not in the file**, naming it, rather than
  returning a random vector. A fixture edit without re-recording then fails
  loudly instead of quietly testing nothing.

### The golden set — `e2e-real/fixtures/golden-queries.ts`

`{ q, timeline?, kinds?, mode, expect: { top1?, inTop5: [...], absent: [...] } }[]`.
Two consumers:

1. **`e2e-real/specs/api/search-golden.spec.ts`**, as pass/fail Playwright
   cases: every `top1`/`inTop5`/`absent` assertion must hold. This is the
   regression gate.
2. **`npm run search:eval`**, which prints recall@5 and MRR for lexical,
   vector and hybrid side by side. It's for _decisions_ (S3's ship gate, the
   vector floor, 256 vs 512 dims), not gating. With `--live` it runs against
   the real dev corpus and live Bedrock, because fixture-corpus numbers are
   too small to tune thresholds on.

## Decided (2026-10-08)

These were the open questions on the first draft. Recorded here so they aren't
relitigated, and folded into the per-phase files.

1. **Five result kinds:** event, sequence, document (source file), **location**
   and **passage**. Passage is the page of a source that matched, so a
   document result never has to lose which page matched.
2. **Clicking a document opens a document panel**: its matching passages, its
   events (with "show on map"), and "open original".
3. **Search is spatially global, but respects the timeline.** It doubles as
   navigation to places outside the current view, so it ignores the viewport
   and layer toggles. **When the timeline filter is enabled, every search is
   restricted to its range.** The timeline is the primary way to narrow search
   (added 2026-10-08, after the first round of decisions). A "Limit to view"
   chip adds the viewport and visible layers for people who want "what's
   here".
4. **Slow searches suggest the timeline.** If results are slow to arrive and
   no timeline filter is on, the UI suggests enabling one rather than just
   spinning. See 20 (how the server reports it) and 21 (what the user sees).
5. **Live map highlighting** while typing, plus **tablet and phone
   layouts**, are in S2's scope. See 21.
6. **Natural-language search has no constraint parsing.** The date is part of
   the embedded text. S1's free date parser still applies to explicit dates.
   See 23 for the caveat and how it's measured.
7. **Documents are searched by paragraph.** `document_passages` holds one row
   per paragraph, cut from the stored artifact by a versioned splitter. PDF
   paragraph detection is heuristic, so it's measured on the real book
   before it's relied on. See 20.
8. **No new libraries unless absolutely needed.** S2's combobox and bottom
   sheet are hand-built. The only new package in the whole track is
   `@aws-sdk/client-bedrock-runtime` for S3, which has no alternative short
   of hand-signing AWS requests. Anything else proposed later has to justify
   itself the same way.
9. **Real queries are logged** for ranking evaluation. See 23 for what is
   stored and for how long.
10. **An event is findable by its source quote,** at the lowest weight. When
    the event and the paragraph it was quoted from both match, they show as
    one result: the event, with the original wording as its snippet. See 20.
11. **Undated passages use the lenient rule.** With the timeline on, a page with
    no extracted event is kept when its document's events span the range. See 20.
12. **People are a stretch goal** (Stretch A), with their own table.
13. **`localStorage` imports are out of scope.** `/map/import` is going to be
    deprecated, so search covers server-side data only and never merges
    client-side results.
14. **Semantic search is public for now**, protected by rate limiting and a
    query-length clamp, not by an API key. Revisit if the Bedrock bill says
    otherwise.
15. **MCP search is a stretch goal** (Stretch B).
16. **Production is RDS.** pgvector 0.8.0 needs RDS PostgreSQL ≥ 16.5, and
    `infra/` pins 16.4 (0.7.3). The plan assumes a minor-version bump before S3,
    with local pinned to the same pgvector version. See 23.
