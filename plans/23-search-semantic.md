# S3 — Semantic and hybrid search

Part of [19-search.md](./19-search.md). Builds on the substrate in
[12-embeddings-and-bedrock.md](./12-embeddings-and-bedrock.md). **Read 12
first**: provider, model, dimensions and the `EmbeddingEngine` interface are
settled there, and this file does not reopen them.

## What semantic search is for

Queries where the words don't overlap the record:

| Query                                                 | Should find                    | Why lexical misses it              |
| ----------------------------------------------------- | ------------------------------ | ---------------------------------- |
| "attack on the emigrant wagon train in southern Utah" | Mountain Meadows massacre      | Record says "Baker–Fancher party"  |
| "when the Aztec capital fell"                         | Fall of Tenochtitlan           | "Aztec capital" ≠ "Tenochtitlan"   |
| "Toltec collapse"                                     | Overthrow of Tula / Rebellion… | No shared content word with either |

**It is not a replacement for lexical search.** Names, exact dates and quoted
phrases are where embeddings are _worse_: a 256-dim vector does not reliably
tell "Young" from "Smith". That is why this is **hybrid**, not a mode switch.

## Tech stack — what has to be installed

| Thing                                                | Where                             | Status / action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pgvector, local + CI**                             | `docker-compose.yml` `db`         | `imresamu/postgis:17-3.5-alpine` has no `vector`. Options are in 12. **Recommend a small Dockerfile** `FROM imresamu/postgis:17-3.5-alpine` that compiles pgvector from a pinned tag. Prebuilt combined images exist (`isopen/pgisvector`, `polypheny/postgres-pgvector-postgis:17-debian`, `ghcr.io/pglayers/pglayers-full:17`), but they are third-party images in the critical path of CI and local dev. A self-built 10-line Dockerfile is safer. CI's `docker-compose.ci.yml` must pick it up too. |
| **pgvector, production**                             | RDS (`infra/rds.tf`, PG **16.4**) | **Confirmed as production** (19, decision 8), which answers plan 12's blocking question 1. RDS 16.4 includes **pgvector 0.7.3**, and 0.8.0 needs RDS **≥ 16.5**. **Action:** bump `db_engine_version` in `infra/variables.tf` (16.4 → current 16.x) and apply it as its own change, ahead of S3 and in a maintenance window. Minor upgrades restart the instance. `CREATE EXTENSION vector` then works as the master user.                                                                              |
| **Version skew**                                     | local vs RDS                      | After the RDS bump, pin the local Dockerfile to the **exact pgvector version** RDS reports (`SELECT extversion FROM pg_extension WHERE extname = 'vector'`), 0.8.x. Local Postgres stays 17 while RDS is 16. That gap already exists today; pgvector doesn't widen it, but don't add PG17-only SQL. Iterative index scans (`hnsw.iterative_scan`) are 0.8-only and are exactly the feature filtered vector search wants (below).                                                                        |
| **Bedrock SDK, ingest**                              | `services/ingest`                 | `@aws-sdk/client-bedrock-runtime` (plan 12).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Bedrock SDK, web app**                             | root package                      | **New for search.** Query embedding happens at request time, inside a Vercel function. The root already depends on `@aws-sdk/client-s3`, so this adds a sibling package and no new auth mechanism.                                                                                                                                                                                                                                                                                                      |
| **IAM**                                              | AWS                               | A user/role limited to `bedrock:InvokeModel` on `amazon.titan-embed-text-v2:0` in **us-west-2** (`BEDROCK_REGION`, plan 12). Its key goes in Vercel env. **Not root**: plan 12 recorded that the CLI is currently using root credentials.                                                                                                                                                                                                                                                               |
| npm `pgvector` package                               | —                                 | **Not needed.** `postgres.js` can send a vector as its text form (`'[0.1,0.2,…]'::vector`). One fewer dependency.                                                                                                                                                                                                                                                                                                                                                                                       |
| Rerankers (`cohere.rerank-v3-5`, `amazon.rerank-v1`) | —                                 | **Not now.** Mentioned so it's a known next step if the golden set shows the hybrid ranker plateauing. Check regional availability then, the way plan 12 had to for embedders.                                                                                                                                                                                                                                                                                                                          |

## What gets embedded

Reuse, don't duplicate:

| Kind     | Table                                                           | Text composed                                                                                   |
| -------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Event    | `event_embeddings` (plan 12, already designed for dedup)        | plan 13's composition: `{title}. {description} Place: … Date: …`                                |
| Sequence | `event_group_embeddings` (new; small)                           | `{title}. {description} Includes: {member titles, seq order}`                                   |
| Passage  | `document_passages.embedding` (S1's table + one column, see 20) | the paragraph text. The splitter's ~1,500-char cap keeps it well inside the model's input limit |

**Locations are not embedded.** A place name is a few tokens with nothing to
infer meaning from, and lexical plus trigram matching (20) does that job
better. A location still surfaces semantically through its events. **Passages
are paragraphs** from `document_passages`, so the passage embedding serves
the passage kind and the document roll-up directly.

**One event embedding serves both dedup and search.** Plan 13 deliberately
leaves out `sourceText` because quotes make cross-source duplicates look less
alike. For search that's also right, since passages already cover the quote
text. If the two uses ever need different text, add a `purpose` column rather
than a second table.

**Staleness:** events are edited in the admin app and through the versioning
plan (17), and sequences are edited by hand. Store `content_hash` of the
composed text beside each embedding, and re-embed when it differs. A periodic
`search:reembed` sweep, or a trigger enqueueing a job, keeps editing from
silently leaving a stale vector. Who runs that job is the real design
question here: the web app has no queue, but the ingest workers do. The
recommendation is that the `embed` worker from plan 13 also sweeps
`content_hash` mismatches for events and groups.

## The hybrid query

Reciprocal rank fusion over a lexical top-N and a vector top-N, per kind:

```sql
WITH lex AS (
  SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_tsv, q) DESC) AS r
  FROM events, websearch_to_tsquery('english', $text) q
  WHERE search_tsv @@ q AND <filters>
  LIMIT 50
), vec AS (
  SELECT event_key AS id, row_number() OVER (ORDER BY embedding <#> $qvec) AS r
  FROM event_embeddings JOIN events … WHERE <filters>
  ORDER BY embedding <#> $qvec LIMIT 50
)
SELECT id, sum(1.0 / (60 + r)) AS score,
       bool_or(src = 'lex') AS lexical, bool_or(src = 'vec') AS semantic
FROM (SELECT id, r, 'lex' src FROM lex UNION ALL SELECT id, r, 'vec' FROM vec) u
GROUP BY id ORDER BY score DESC LIMIT $k;
```

- **RRF, not score blending.** `ts_rank_cd` and inner product live on
  unrelated scales. RRF uses only ranks, has one constant (`k = 60` by
  convention), and needs no tuning to start. `matchedOn: ["meaning"]` is set
  when a hit came only from `vec`.
- **`<#>` (negative inner product)** because vectors are normalised (plan 12),
  which makes it equivalent to cosine and cheaper.
- **A relevance floor on the vector arm.** Nearest-neighbour search always
  returns _something_. For "Napoleon" against a Utah + Mexico corpus, the
  vector arm will happily return its least-bad matches. Drop vector hits
  beyond a distance threshold, set from the golden set (not guessed). This is
  plan 14's "cite or abstain" rule applied to search.
- **Filters and ANN indexes don't mix well.** An HNSW index with a `WHERE`
  (bbox, date, source) can return fewer than k rows, because filtering
  happens after the graph walk. At today's size there is **no index**: an exact
  scan over hundreds of rows is faster than the index, as plan 12 says. When
  an index becomes necessary, pgvector 0.8's iterative scan is the fix, which
  is why version skew matters.
- **With the timeline as the primary filter (19, decision 3), a date-filtered
  vector query is the _common_ case, not an edge case.** So the date filter
  goes inside the `vec` CTE (as a pre-filter joined to `events.date`, or to
  the document's event span for passages), never applied after fusion.
  Filtering after fusion would let out-of-range vector hits take top-50 slots
  and then vanish, so an in-range match ranked 51st would never appear. Add
  the golden-set queries with a timeline range too, because the vector floor
  may need to differ when the candidate pool is small.

## Every mechanism, and what proves it

The whole design in one list. Each row is a decision above (or in 12/13) and
the check that fails if it's broken. Nothing here ships on "it should work":
a row without a check is a bug in this plan.

| #   | Mechanism                                                                                                                                                                   | Verified by                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Events are embedded from composed text** — plan 13's `{title}. {description} Place: {placeName} Date: {dateText}`, without `sourceText`                                   | ingestion fixture: the fake's call log shows exactly that string per event; a pure spec over `composeEventText()` pins the format                                                                                   |
| 2   | **Sequences are embedded** — `{title}. {description} Includes: {member titles, seq order}`                                                                                  | ingestion fixture: every fixture group gets an `event_group_embeddings` row; hybrid spec: a sequence paraphrase finds `fx-grp-meadows` with `meaning`                                                               |
| 3   | **Passages are embedded** — the paragraph text, one vector per `document_passages` row                                                                                      | ingestion fixture: no null `embedding` after the sweep; hybrid spec "passages semantic"                                                                                                                             |
| 4   | **Locations are not embedded**                                                                                                                                              | hybrid spec: no `location` hit ever carries `meaning`; there is no location-embedding table (`db:verify` asserts the table list)                                                                                    |
| 5   | **Vectors are unit length** (`normalize: true`, plan 12), which is what makes `<#>` equal cosine                                                                            | `EmbeddingEngine` contract spec: every vector the Bedrock _and_ fake engines return has ‖v‖ = 1 ± 1e-3; ingestion fixture: `SELECT max(abs(vector_norm(embedding) - 1))` over every embedding table is < 1e-3       |
| 6   | **One model, one dimension**: stored vectors and the query vector come from the same `EMBEDDING_MODEL`/`dims`                                                               | hybrid spec: with stored rows tagged a different model, `mode=hybrid` degrades to lexical with `modes.semantic = false` (comparing across models is meaningless, so the vector arm refuses rather than ranks)       |
| 7   | **Staleness**: `content_hash` beside every embedding; the `embed` worker's sweep re-embeds mismatches                                                                       | ingestion fixture: editing one event re-embeds that row only; editing a group's title re-embeds that group only; changing `EMBEDDING_MODEL` replaces every row                                                      |
| 8   | **The query is embedded only on submit** — typeahead never calls Bedrock                                                                                                    | UI spec: keystrokes never send `mode=hybrid`; hybrid spec: `mode=hybrid&prefix=1` (a typeahead request that claims hybrid) leaves the fake's call counter unchanged — the server enforces it too                    |
| 9   | **Query embeddings are cached** (`search_query_embeddings`, keyed on normalised query + model + dims, with a TTL)                                                           | hybrid spec "cache"; plus: a cache row older than the TTL is ignored and re-embedded (counter +1), and the sweep deletes it                                                                                         |
| 10  | **Comparison is `<#>` (negative inner product)**                                                                                                                            | hybrid spec: for a recorded query, the vector arm's order equals the order of exact cosine similarity computed in the test from `search-vectors.json`                                                               |
| 11  | **No vector index yet — exact scan.** Revisit at ~50k vector rows or when the vector arm's p95 exceeds 50 ms, whichever comes first; the fix is HNSW + 0.8's iterative scan | `search:eval` prints vector-arm latency (p50/p95) and row counts; the CI pgvector-version check (below) guarantees 0.8 is there when the index is needed                                                            |
| 12  | **Hybrid, fused by RRF** (`k = 60`, ranks only), not a mode switch and not score blending                                                                                   | hybrid spec "hybrid ≥ lexical on names"; golden ship gate: hybrid recall@5 ≥ lexical-only, and MRR not lower on the lexical golden entries                                                                          |
| 13  | **`matchedOn: ["meaning"]` only for vector-only hits**; a hit both arms found keeps its lexical fields and gets no `meaning`                                                | hybrid spec: a paraphrase hit has exactly `["meaning"]`; `q=Tenochtitlan&mode=hybrid` → the top hit's `matchedOn` contains `title` and not `meaning`                                                                |
| 14  | **Relevance floor on the vector arm**, set from the golden set                                                                                                              | hybrid spec "relevance floor" over **three** negative queries (not one); `search:eval --floor` prints recall vs. false-meaning-hits per candidate threshold, and the chosen value is recorded here with its numbers |
| 15  | **Filters run inside the vector CTE**, before ranking                                                                                                                       | hybrid spec "timeline pre-filter" (with distractors so an in-range hit sits beyond 50 unfiltered); the same for `sources`/`bbox` under "limit to view"                                                              |
| 16  | **Fallback**: any embedder error → lexical results, `modes.semantic = false`, no retry, never a 5xx                                                                         | hybrid spec "embedder down" for throttling _and_ a validation error _and_ a timeout (the fake sleeps past the request budget)                                                                                       |
| 17  | **Cost limits**: per-IP hybrid limit, daily Bedrock ceiling, query-length clamp, cache                                                                                      | hybrid specs "rate limit", "daily ceiling", "cache"; a 1,000-char hybrid query embeds at most 200 characters (the fake records the text it was given)                                                               |
| 18  | **AWS Budgets alert** on Bedrock spend — the backstop the app can't provide                                                                                                 | manual, before turning hybrid on in the UI: the alert exists in `infra/` (or is recorded as created in the console), with its threshold noted here                                                                  |
| 19  | **Live path works** — the real Bedrock engine, the IAM user's narrow permission, and latency from Vercel's region                                                           | manual `search:verify -- --live` (like `extract:verify -- --live`): one query embeds, ‖v‖ = 1, dims = 256, and the round-trip time is printed; a call to any other model is denied (proves the IAM scope)           |

## Query embedding at request time

- **Only on submit** (19, decision 3). Typeahead never embeds.
- **Cache** query embeddings keyed by `(normalised query, model, dims)`. An
  in-process LRU is useless on serverless, so use a tiny Postgres table
  (`search_query_embeddings`) with a TTL. Repeated and popular queries then
  cost nothing, and it doubles as a log of real queries, the best input for
  growing the golden set. Logging is approved (19); what's kept is set out under "Query log" below.
- **Latency budget.** Bedrock Titan from Vercel's region is roughly 100–300 ms.
  Measure it from the actual Vercel region before promising "instant". If it
  hurts, return the lexical results first and stream the hybrid re-rank in
  after.
- **Failure:** Bedrock errors or throttling return lexical-only results with
  `modes.semantic = false`. The search never fails because the embedder did.
  The error classification is the same as plan 12 (`ThrottlingException`
  retryable, `ValidationException` not), but for an interactive request there
  is **no retry**: degrade instead.

## Cost and abuse

Each semantic search is one Titan call of about 10–30 tokens, which is
negligible per query and unbounded in aggregate on a public URL. **Decided: public for now** (19, decision 6), so the protection is entirely
limits:

- A tighter per-IP limit on `mode=hybrid` than on lexical (the middleware
  already does sliding windows per route).
- Clamp query length before embedding.
- The query-embedding cache, so repeated queries cost nothing.
- **A global daily ceiling** on Bedrock calls: a counter row in Postgres,
  checked before embedding. Past the ceiling, `mode=hybrid` degrades to
  lexical with `modes.semantic = false`. Per-IP limits don't stop a
  distributed crawler, and on a public endpoint the ceiling is what actually
  bounds the bill.
- An AWS Budgets alert on Bedrock spend, as the backstop the app can't
  provide.

If the bill says otherwise, putting `mode=hybrid` behind a key is a one-line
change in the route. Lexical search stays public either way.

## Passages and RAG

Segment-level hybrid search is exactly the retrieval step of plan 14's
`/api/ask`. Build it here as a reusable `retrieveSegments(query, filters, k)`
in `lib/`, so `/api/ask` calls the function rather than reimplementing it.
Search returns the passages, and RAG answers from them. A natural UI
follow-on is an "Ask about these results" action, but that belongs to plan
14, not to search.

## Evaluation

The golden set (19, decision 6) gets a semantic section: around 15
paraphrase queries with expected hits. Report recall@5 for lexical-only,
vector-only and hybrid. **Ship hybrid only if it beats lexical-only on that
set**, and use the same set to choose the vector relevance floor and to
settle plan 12's 256-vs-512-dims question with data.

## E2E specs

Everything here runs with `EMBEDDING_ENGINE=fake`, the recorded-vector
lookup described in 19 ("No Bedrock in CI"). No spec calls Bedrock. The live
check is a separate, manual `--live` flag, the same as `extract:verify`.

### Fixture additions

Three paraphrase events added to `search-seed.ts`, whose titles share **no
content word** with their golden query. That's the only way to prove the
vector arm did the work:

| Fixture                                               | Golden query (`mode: "hybrid"`)                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `fx-ev-baker-fancher`, "Baker–Fancher party attacked" | "emigrant wagon train ambushed in southern Utah"                 |
| `fx-ev-tenochtitlan` (exists)                         | "when the Aztec capital fell"                                    |
| `fx-ev-tula`, "Overthrow of Tula"                     | "Toltec collapse"                                                |
| _none relevant_                                       | "Napoleon's coronation" → expects **no** vector hits (the floor) |
| _none relevant_                                       | "the Battle of Hastings" → no vector hits                        |
| _none relevant_                                       | "Apollo moon landing" → no vector hits                           |
| `fx-grp-meadows` (exists)                             | "the sequence of events at the southern Utah valley in 1857"     |

Their vectors are recorded in `search-vectors.json` by
`search:record-vectors`.

### `e2e-real/specs/api/search-hybrid.spec.ts`

| Case                      | Asserts                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| paraphrase finds it       | each paraphrase query above, `mode=hybrid` → expected event in the top 3, with `matchedOn` containing `meaning`                                                                                                                                                                                         |
| lexical can't             | the same queries with `mode=lexical` → expected event **absent**. This proves the fixture tests the vector arm and not a lucky word overlap, and it fails loudly if someone edits a fixture title into overlap                                                                                          |
| hybrid ≥ lexical on names | `q=Tenochtitlan`, `mode=hybrid` → the exact-name hit still ranks first (RRF didn't let a vector neighbour displace it)                                                                                                                                                                                  |
| relevance floor           | "Napoleon's coronation" → zero `meaning`-only hits                                                                                                                                                                                                                                                      |
| **timeline pre-filter**   | `q=Toltec collapse&from=1500&to=1600&mode=hybrid` → `fx-ev-tula` (1103) absent, **and** an in-range event that would rank below 50 unfiltered still appears. Seed enough distractor vectors near the query for this to be meaningful; it's the test for "filter inside the `vec` CTE, not after fusion" |
| passages semantic         | a paraphrase of a `fx-doc-1` page → that passage returned with `matchedOn: ["meaning"]`                                                                                                                                                                                                                 |
| cache                     | the same hybrid query twice → the fake embedder's call counter (exposed only under `EMBEDDING_ENGINE=fake`) increments once                                                                                                                                                                             |
| embedder down             | `EMBEDDING_FAKE_FAIL=throttle` → 200 with lexical hits and `modes.semantic = false`, never a 5xx, no retry (counter = 1)                                                                                                                                                                                |
| daily ceiling             | set the ceiling to 2, run 3 hybrid queries → the third degrades to lexical with `modes.semantic = false`                                                                                                                                                                                                |
| rate limit                | hybrid requests past the per-IP limit → 429, while lexical requests from the same IP still succeed                                                                                                                                                                                                      |
| static backend            | without Postgres, `mode=hybrid` → lexical results with `modes.semantic = false`                                                                                                                                                                                                                         |
| sequence semantic         | the sequence paraphrase above → `fx-grp-meadows` returned with `matchedOn: ["meaning"]`                                                                                                                                                                                                                 |
| no location vectors       | every hybrid query in this spec → no `location` hit carries `meaning`                                                                                                                                                                                                                                   |
| meaning label             | a paraphrase hit's `matchedOn` is exactly `["meaning"]`; `q=Tenochtitlan&mode=hybrid` → top hit has `title`, not `meaning`                                                                                                                                                                              |
| inner-product order       | for "when the Aztec capital fell", the vector arm's event order equals exact cosine order computed in the test from `search-vectors.json`                                                                                                                                                               |
| typeahead never embeds    | `mode=hybrid&prefix=1` → fake call counter unchanged, `modes.semantic = false`                                                                                                                                                                                                                          |
| model mismatch            | stored embeddings tagged another model → `mode=hybrid` degrades to lexical, `modes.semantic = false`                                                                                                                                                                                                    |
| cache expiry              | a cached query embedding older than the TTL → re-embedded (counter +1); the sweep removes the stale row                                                                                                                                                                                                 |
| embedder failure kinds    | `EMBEDDING_FAKE_FAIL=validation` and `=timeout` behave like `=throttle`: 200, lexical, `modes.semantic = false`, counter = 1                                                                                                                                                                            |
| length clamp              | a 1,000-char hybrid query → the fake recorded at most 200 characters of input                                                                                                                                                                                                                           |
| limit-to-view pre-filter  | `mode=hybrid` with `bbox`/`sources` → no vector hit outside them, and an in-view hit that ranks beyond 50 unfiltered still appears                                                                                                                                                                      |

The golden spec from 20 picks up `mode: "hybrid"` entries automatically.

### Ingestion fixture — the embed sweep

- After `publish` plus the `embed` worker, every published fixture event has
  an `event_embeddings` row, with `model`/`dims` set and `content_hash`
  matching its composed text.
- Editing an event's description (direct SQL, standing in for the admin app)
  and re-running the sweep re-embeds **that row only**. The fake's call log
  shows one text.
- Changing `EMBEDDING_MODEL` re-embeds everything. Rows from the old model
  are replaced, not duplicated.
- The fake's call log shows each event's text in plan 13's composed format,
  without `sourceText` (row 1 of the table above).
- Every fixture group has an `event_group_embeddings` row; editing a group's
  title re-embeds that group only.
- Every embedding table: `max(abs(vector_norm(embedding) - 1)) < 1e-3`, and
  every row's `dims` matches `vector_dims(embedding)`.
- Passages: every `document_passages` row gets a non-null `embedding` after
  the sweep. A `SPLITTER_VERSION` bump re-cuts passages, and the sweep
  re-embeds exactly the new rows. An `EXTRACTOR_VERSION` bump that rewrites passages also clears
  and re-fills their embeddings.

### `EmbeddingEngine` contract — `services/ingest/scripts/verify-embeddings.ts`

`npm run embed:verify` needs nothing (it exercises the fake), and runs in CI:

- Every vector returned has the configured `dims` and unit length.
- The fake throws on a text that isn't in `search-vectors.json`, naming it.
- `composeEventText()` and `composeGroupText()` produce the documented
  strings for a fixed input (pins rows 1 and 2).
- Error classification: `ThrottlingException` → retryable, `ValidationException`
  → not (plan 12); the web app path never retries either.

`npm run embed:verify -- --live` is the manual live check (row 19): one real
Titan call, its dims/norm/latency printed, and one call to a model the IAM
user isn't granted, which must be denied.

### Image and infra checks (CI)

- A step after `docker compose up db` runs
  `SELECT extversion FROM pg_extension WHERE extname = 'vector'` (after
  `CREATE EXTENSION`) and fails unless it equals the version pinned for RDS.
  That turns version skew into a red build instead of a production surprise.
- The existing `timeline.spec.ts` and every other e2e-real spec stay green
  on the new image. PostGIS behaviour must be unchanged by the rebuild.

### UI (mocked, extends 21's specs)

- Enter sends `mode=hybrid`, and keystrokes never do. Assert this on the
  request log over a typed-then-submitted query.
- `modes.semantic = false` in a hybrid response shows "Search by meaning
  unavailable", and the lexical results still render.

## Build order

0. RDS minor-version bump to ≥ 16.5 (pgvector 0.8), as its own infra change.
1. pgvector image change, plus a CI run proving `CREATE EXTENSION vector`
   works there and on RDS.
2. `EmbeddingEngine` + Bedrock implementation (plan 12, shared with 13).
3. Event and sequence embedding + `content_hash` sweep in the `embed` worker.
4. Passage embeddings (backfill from `document_passages`).
5. Web app: query embedding + cache + hybrid SQL behind `mode=hybrid`.
6. Golden-set comparison, floor tuning, then turn it on in the UI.

The E2E specs above land **with** each step, not after step 6, and a step
isn't done until its checks pass:

| Step | Done when                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | RDS reports `extversion` 0.8.x for `vector` (recorded here)                                                                                                                                        |
| 1    | CI's pgvector-version check is green, and every existing e2e-real spec stays green on the new image                                                                                                |
| 2    | `embed:verify` green in CI; `embed:verify -- --live` run once by hand, output recorded here                                                                                                        |
| 3    | ingestion-fixture event + sequence bullets green (composition, staleness, unit length)                                                                                                             |
| 4    | ingestion-fixture passage bullets green                                                                                                                                                            |
| 5    | every `search-hybrid.spec.ts` row green                                                                                                                                                            |
| 6    | `search:eval` shows hybrid ≥ lexical (recall@5, MRR on lexical entries), the floor chosen with its numbers recorded, the Budgets alert in place (row 18), then the UI sends `mode=hybrid` on Enter |

## Decided (2026-10-08)

**No constraint parsing for natural-language queries.** There is no LLM
query-rewriting step, and no place extraction. The composed event text
already includes `Date: {dateText}` and `Place: {placeName}`, so a query that
mentions 1600 or Mexico pulls towards events with that date or place text.

**Recorded caveat: this is a soft pull, not a filter, and it should be
measured.** General-purpose text embeddings encode numbers as tokens, not
quantities: "1600" sits near "1600" but is not reliably nearer "1610" than
"1900". And the date is a few tokens in a composed string dominated by the
title and description. Two things keep this from being a problem without
adding a model call:

1. **S1's date parser still runs on hybrid queries.** It's free and
   deterministic. "battles before 1600" gets a hard `[−∞, 1599]` filter (and a
   removable chip), and the vector arm ranks topics _inside_ it. Only phrases
   the parser doesn't recognise ("the late Aztec period") rely on the vector
   alone.
2. **The golden set measures it.** Add date-flavoured semantic queries with
   the parser _disabled_, e.g. "events around 1600" and "the 1520s in
   Mexico", and report how many top-5 hits fall within ±25 years. If that
   holds up, the vector is handling dates on its own as assumed. If not, the
   parser covers explicit dates, and the remaining fix is putting the
   date first in the composed text, not adding an LLM.

## Query log

Approved (2026-10-09). It's the best ranking-evaluation data there is, and it
is still user data, so it holds only what evaluation needs:

```sql
CREATE TABLE search_query_log (
  id          bigserial PRIMARY KEY,
  q_norm      text NOT NULL,          -- normalised query text
  mode        text NOT NULL,          -- lexical | hybrid
  filters     jsonb,                  -- timeline range, limit-to-view on/off
  hit_count   int  NOT NULL,
  clicked     text,                   -- `kind:id` of the result clicked, if any
  ms          int  NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

- **No IP address, no user agent, no session id.** Rate limiting already has
  the IP in memory; the log doesn't need it. Without a session id, logged
  queries can't be stitched into one person's search history.
- **Only submitted searches** (Enter, or a clicked result) are logged, not
  every typeahead keystroke. Keystroke prefixes are noise, and an
  abandoned half-typed query is the most personal thing a search box sees.
- **`clicked`** is the useful signal: a query whose top hit is never clicked
  is a golden-set candidate. It's recorded by a follow-up `POST` from the
  click handler. The query and the click are joined by the log row's `id`,
  which the search response returns.
- **Retention: 90 days**, deleted by the same sweep that expires the
  embedding cache. Long enough to build a golden set from, short enough that
  the table never becomes an archive.
- The embedding cache (`search_query_embeddings`) stays a separate table. One
  is a cache that can be wiped any time. The other is the evaluation record.
- `npm run search:log-report` lists the most frequent queries, the
  zero-result queries and the no-click queries. This is the input for new
  golden-set entries.

E2E: in `search-hybrid.spec.ts`, a submitted search writes one log row with
no IP field. Typeahead requests write none. A click updates `clicked`. Rows
older than the retention window are removed by the sweep (insert a backdated
row, run the sweep, assert it's gone).
