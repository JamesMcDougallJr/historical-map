# S3 — Semantic and hybrid search

Part of [19-search.md](./19-search.md). Builds on the substrate in
[12-embeddings-and-bedrock.md](./12-embeddings-and-bedrock.md). **Read 12
first**: provider, model, dimensions and the `EmbeddingEngine` interface are
settled there, and this file does not reopen them.

> **Status (2026-10-15): step 0 applied; steps 1–6 built on the fixture
> golden set.** Open: the live eval on a real corpus, the RDS upgrade
> (Friday's maintenance window) and the re-recording CI job. `infra/`
> declares everything in "Infrastructure and automation" that lives in
> Terraform (`caa0a8d`, verified by `tofu validate`/`tofu test` in the
> `Infra` workflow), and it was applied to production on 2026-10-15 — 13
> added, 1 changed, 0 destroyed: the Bedrock web-app IAM user and key, the
> GitHub OIDC provider and CI role, the `AWS_EMBEDDINGS_ROLE_ARN` and
> `BEDROCK_REGION` Actions variables, the four Vercel production env vars
> (they reach the app on the next production deploy) and the Bedrock budget.
> RDS is queued for 16.4 → 16.15 in its maintenance window
> (`apply_immediately = false`), **not yet upgraded**. Everything outside
> `infra/` in step 0's row — `db/pgvector-version`, the migration's version
> check, and `bedrock-live.yml` — belongs to steps 1–2; step 0's "done when"
> (the version check passing against RDS) can only pass after that window.
> The build order below carries a status per step.

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
| **pgvector, production**                             | RDS (`infra/rds.tf`, PG **16.4**) | **Confirmed as production** (19, decision 8). RDS 16.4 ships pgvector **0.6.2**; 0.8.0 needs RDS **≥ 16.7**, and 16.15 ships **0.8.2** (AWS's extension-versions table, checked 2026-10-15). **Terraform:** `engine_version` comes from `data "aws_rds_engine_version"` (latest 16.x) instead of the hand-pinned `16.4`, with `apply_immediately = false`, so AWS performs the restart in the instance's maintenance window — no one picks a time. See "Infrastructure and automation" below.           |
| **Version skew**                                     | local vs RDS                      | After the RDS bump, pin the local Dockerfile to the **exact pgvector version** RDS reports (`SELECT extversion FROM pg_extension WHERE extname = 'vector'`), 0.8.x. Local Postgres stays 17 while RDS is 16. That gap already exists today; pgvector doesn't widen it, but don't add PG17-only SQL. Iterative index scans (`hnsw.iterative_scan`) are 0.8-only and are exactly the feature filtered vector search wants (below).                                                                        |
| **Bedrock SDK, ingest**                              | `services/ingest`                 | `@aws-sdk/client-bedrock-runtime` (plan 12).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Bedrock SDK, web app**                             | root package                      | **New for search.** Query embedding happens at request time, inside a Vercel function. The root already depends on `@aws-sdk/client-s3`, so this adds a sibling package. Its credentials reach Vercel through Terraform's `vercel` provider, not the dashboard.                                                                                                                                                                                                                                         |
| **IAM**                                              | AWS                               | **Terraform:** an `aws_iam_user` (web app) and a GitHub OIDC role (CI), both limited to `bedrock:InvokeModel` on the `amazon.titan-embed-text-v2:0` ARN in **us-west-2** (`BEDROCK_REGION`, plan 12). **Not root**: plan 12 recorded that the CLI currently uses root credentials.                                                                                                                                                                                                                      |
| npm `pgvector` package                               | —                                 | **Not needed.** `postgres.js` can send a vector as its text form (`'[0.1,0.2,…]'::vector`). One fewer dependency.                                                                                                                                                                                                                                                                                                                                                                                       |
| Rerankers (`cohere.rerank-v3-5`, `amazon.rerank-v1`) | —                                 | **Not now.** Mentioned so it's a known next step if the golden set shows the hybrid ranker plateauing. Check regional availability then, the way plan 12 had to for embedders.                                                                                                                                                                                                                                                                                                                          |

## Infrastructure and automation — no manual steps

Every piece of S3 that touches AWS, Vercel or CI is declared in `infra/`
(OpenTofu/Terraform, already managing RDS, ECS and CloudFront) or runs in a
GitHub Actions workflow. Nothing is clicked in a console, typed into a
dashboard, or "run once by hand and recorded".

| Need                         | How                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDS ≥ 16.5 (pgvector 0.8)    | `infra/rds.tf`: `data "aws_rds_engine_version" "pg16" { engine = "postgres", version = "16", latest = true }` feeds `engine_version`; `apply_immediately = false` lets AWS restart in the maintenance window. The parameter group family stays `postgres16`.                                                                                                                                                                      |
| Bedrock credentials, web app | `infra/bedrock.tf`: `aws_iam_user` + an inline policy allowing only `bedrock:InvokeModel` on `arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-embed-text-v2:0`, and an `aws_iam_access_key`.                                                                                                                                                                                                                             |
| …into Vercel                 | `infra/vercel.tf` (already managing `POSTGRES_URL` and the `S3_*` document-storage vars on production): adds `BEDROCK_REGION`, `EMBEDDING_MODEL`, `BEDROCK_ACCESS_KEY_ID` and `BEDROCK_SECRET_ACCESS_KEY` (sensitive) to its map. Not `AWS_*` — Vercel reserves those names. Production only, like the rest: previews have no database, so no hybrid search either.                                                               |
| Bedrock credentials, CI      | `infra/github-oidc.tf`: an `aws_iam_openid_connect_provider` for `token.actions.githubusercontent.com` and a role whose trust policy admits only this repository, with the same one-model `InvokeModel` policy. No long-lived secret in GitHub. Its ARN reaches workflows as a repository variable via the `integrations/github` provider (`github_actions_variable`).                                                            |
| Spend backstop               | `infra/budgets.tf`: `aws_budgets_budget` filtered to the Bedrock service, monthly limit `var.bedrock_monthly_budget_usd`, with email notifications at 80% actual and 100% forecast to `var.alert_email`.                                                                                                                                                                                                                          |
| pgvector version skew        | One source of truth, `db/pgvector-version` (e.g. `0.8.0`, matching what the chosen RDS 16.x ships). The local Dockerfile builds that tag; CI fails if the local image's `extversion` differs; and the ingest migration that runs `CREATE EXTENSION vector` **fails against any database whose `extversion` differs from the file** — so deploying to an RDS that hasn't upgraded yet is a red migrate, not a silent 0.7 database. |
| Live Bedrock check           | `.github/workflows/bedrock-live.yml`: nightly, and on PRs that touch `libs/embedding` or the hybrid search code. Assumes the OIDC role and runs `npm run embed:verify -- --live`.                                                                                                                                                                                                                                                 |
| Recorded test vectors        | The same workflow, on PRs that change `search-seed.ts` or `golden-queries.ts`, runs `npm run search:record-vectors` and pushes the regenerated `search-vectors.json` to the PR branch. CI's fake engine still throws on any text missing from the file, so a stale file can't pass either way.                                                                                                                                    |

**The one human action is `tofu apply`.** State is deliberately local
(`infra/versions.tf`: a solo demo stack that tears down from one directory),
so CI can't apply it. Every change above lands in a single plan/apply. Making
that automatic too means moving state to an encrypted S3 backend with a
`tofu apply` workflow, which is a decision about the whole stack, not S3. It's
flagged here, not assumed.

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

| #   | Mechanism                                                                                                                                                                   | Verified by                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Events are embedded from composed text** — plan 13's `{title}. {description} Place: {placeName} Date: {dateText}`, without `sourceText`                                   | ingestion fixture: the fake's call log shows exactly that string per event; a pure spec over `composeEventText()` pins the format                                                                                                                |
| 2   | **Sequences are embedded** — `{title}. {description} Includes: {member titles, seq order}`                                                                                  | ingestion fixture: every fixture group gets an `event_group_embeddings` row; hybrid spec: a sequence paraphrase finds `fx-grp-meadows` with `meaning`                                                                                            |
| 3   | **Passages are embedded** — the paragraph text, one vector per `document_passages` row                                                                                      | ingestion fixture: no null `embedding` after the sweep; hybrid spec "passages semantic"                                                                                                                                                          |
| 4   | **Locations are not embedded**                                                                                                                                              | hybrid spec: no `location` hit ever carries `meaning`; there is no location-embedding table (`db:verify` asserts the table list)                                                                                                                 |
| 5   | **Vectors are unit length** (`normalize: true`, plan 12), which is what makes `<#>` equal cosine                                                                            | `EmbeddingEngine` contract spec: every vector the Bedrock _and_ fake engines return has ‖v‖ = 1 ± 1e-3; ingestion fixture: `SELECT max(abs(vector_norm(embedding) - 1))` over every embedding table is < 1e-3                                    |
| 6   | **One model, one dimension**: stored vectors and the query vector come from the same `EMBEDDING_MODEL`/`dims`                                                               | hybrid spec: with stored rows tagged a different model, `mode=hybrid` degrades to lexical with `modes.semantic = false` (comparing across models is meaningless, so the vector arm refuses rather than ranks)                                    |
| 7   | **Staleness**: `content_hash` beside every embedding; the `embed` worker's sweep re-embeds mismatches                                                                       | ingestion fixture: editing one event re-embeds that row only; editing a group's title re-embeds that group only; changing `EMBEDDING_MODEL` replaces every row                                                                                   |
| 8   | **The query is embedded only on submit** — typeahead never calls Bedrock                                                                                                    | UI spec: keystrokes never send `mode=hybrid`; hybrid spec: `mode=hybrid&prefix=1` (a typeahead request that claims hybrid) leaves the fake's call counter unchanged — the server enforces it too                                                 |
| 9   | **Query embeddings are cached** (`search_query_embeddings`, keyed on normalised query + model + dims, with a TTL)                                                           | hybrid spec "cache"; plus: a cache row older than the TTL is ignored and re-embedded (counter +1), and the sweep deletes it                                                                                                                      |
| 10  | **Comparison is `<#>` (negative inner product)**                                                                                                                            | hybrid spec: for a recorded query, the vector arm's order equals the order of exact cosine similarity computed in the test from `search-vectors.json`                                                                                            |
| 11  | **No vector index yet — exact scan.** Revisit at ~50k vector rows or when the vector arm's p95 exceeds 50 ms, whichever comes first; the fix is HNSW + 0.8's iterative scan | `search:eval` prints vector-arm latency (p50/p95) and row counts; the CI pgvector-version check (below) guarantees 0.8 is there when the index is needed                                                                                         |
| 12  | **Hybrid, fused by RRF** (`k = 60`, ranks only), not a mode switch and not score blending                                                                                   | hybrid spec "hybrid ≥ lexical on names"; golden ship gate: hybrid recall@5 ≥ lexical-only, and MRR not lower on the lexical golden entries                                                                                                       |
| 13  | **`matchedOn: ["meaning"]` only for vector-only hits**; a hit both arms found keeps its lexical fields and gets no `meaning`                                                | hybrid spec: a paraphrase hit has exactly `["meaning"]`; `q=Tenochtitlan&mode=hybrid` → the top hit's `matchedOn` contains `title` and not `meaning`                                                                                             |
| 14  | **Relevance floor on the vector arm**, set from the golden set                                                                                                              | hybrid spec "relevance floor" over **three** negative queries (not one); `search:eval --floor` prints recall vs. false-meaning-hits per candidate threshold, and the chosen value is committed as a constant whose comment carries those numbers |
| 15  | **Filters run inside the vector CTE**, before ranking                                                                                                                       | hybrid spec "timeline pre-filter" (with distractors so an in-range hit sits beyond 50 unfiltered); the same for `sources`/`bbox` under "limit to view"                                                                                           |
| 16  | **Fallback**: any embedder error → lexical results, `modes.semantic = false`, no retry, never a 5xx                                                                         | hybrid spec "embedder down" for throttling _and_ a validation error _and_ a timeout (the fake sleeps past the request budget)                                                                                                                    |
| 17  | **Cost limits**: per-IP hybrid limit, daily Bedrock ceiling, query-length clamp, cache                                                                                      | hybrid specs "rate limit", "daily ceiling", "cache"; a 1,000-char hybrid query embeds at most 200 characters (the fake records the text it was given)                                                                                            |
| 18  | **AWS Budgets alert** on Bedrock spend — the backstop the app can't provide                                                                                                 | `infra/budgets.tf`; `tofu test` (Infra workflow) asserts it exists when `alert_email` is set, filters to Amazon Bedrock, and alerts at 80% actual / 100% forecast                                                                                |
| 19  | **Live path works** — the real Bedrock engine, the IAM scope, and round-trip latency                                                                                        | `bedrock-live.yml` (nightly + relevant PRs): one query embeds, ‖v‖ = 1, dims = 256, latency printed to the job summary; a call to any other model is **denied** (proves the policy is one-model)                                                 |

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
check is the `--live` flag, run only by the `bedrock-live.yml` workflow under
its OIDC role (see "Infrastructure and automation").

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

`npm run embed:verify -- --live` is the live check (row 19), run by
`bedrock-live.yml` under the OIDC role, never by hand: one real Titan call,
its dims/norm/latency printed, and one call to a model the role isn't
granted, which must be denied.

### Image and infra checks (CI)

- A step after `docker compose up db` runs
  `SELECT extversion FROM pg_extension WHERE extname = 'vector'` (after
  `CREATE EXTENSION`) and fails unless it equals `db/pgvector-version`. The
  migration's own check (above) enforces the same file against RDS at deploy.
- `tofu fmt -check`, `tofu validate` and `tofu test` on `infra/` in the
  `Infra` workflow, with no credentials: `infra/tests/` plans the stack
  against mocked providers and asserts the one-model IAM policy, the
  repository-scoped OIDC trust, the maintenance-window upgrade, the budget's
  Bedrock filter and the full Vercel env set. **No real-account drift check**:
  state is local, so CI has nothing to plan against — that arrives only with
  the S3-backend change flagged above.
- The existing `timeline.spec.ts` and every other e2e-real spec stay green
  on the new image. PostGIS behaviour must be unchanged by the rebuild.

### UI (mocked, extends 21's specs)

- Enter sends `mode=hybrid`, and keystrokes never do. Assert this on the
  request log over a typed-then-submitted query.
- `modes.semantic = false` in a hybrid response shows "Search by meaning
  unavailable", and the lexical results still render.

## Build order

| Step | Work                                                                                                            | Status (2026-10-11)                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `infra/`: engine-version data source, Bedrock IAM user + OIDC role, Vercel env vars, Budgets — one `tofu apply` | **Applied 2026-10-15**; RDS 16.15 pending its maintenance window                                                                                                                                           |
| 1    | pgvector image pinned by `db/pgvector-version`, plus the CI and migration version checks                        | **Built** (2026-10-15): pinned to 0.8.2 (RDS 16.15's); `db/Dockerfile`, CI step, `AddPgvector1760486400000`. Waiting on the e2e-real run in CI; the RDS migrate passes only after the upgrade              |
| 2    | `EmbeddingEngine` + Bedrock implementation (plan 12, shared with 13), `embed:verify`, `bedrock-live.yml`        | **Done** (2026-10-15): `libs/embedding` (Bedrock + recorded-vector fake, Nest-free except the module). `embed:verify` in E2E; `bedrock-live.yml` green under the OIDC role, including the one-model denial |
| 3    | Event and sequence embedding + `content_hash` sweep in the `embed` worker                                       | **Built** (2026-10-15): see "Step 3 as built" below. All six fixture bullets green locally, against both live Titan (`record`) and recorded vectors (`fake`)                                               |
| 4    | Passage embeddings (backfill from `document_passages`)                                                          | **Built** (2026-10-15): `document_passages.embedding`/`embedding_model`, filled by the same sweep; fixture passage bullets green (`record` and `fake`)                                                     |
| 5    | Web app: query embedding + cache + hybrid SQL behind `mode=hybrid`                                              | **Built** (2026-10-15): every `search-hybrid.spec.ts` row green locally (126/126 e2e-real, 141 mocked); see "Step 5 as built". The UI still sends lexical on Enter — that's step 6                         |
| 6    | Golden-set comparison, floor tuning, then turn it on in the UI                                                  | **Built** (2026-10-15) on the fixture golden set: ship gate passes, floor 0.30 committed with its numbers, Enter sends `mode=hybrid`. `search:eval --live` on a real corpus still to run                   |

The E2E specs above land **with** each step, not after step 6, and a step
isn't done until its checks pass:

| Step | Done when                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | `tofu validate` + `tofu test` green in the Infra workflow; after apply, the ingest migration's version check passes against RDS (it fails on 0.7)                                                                              |
| 1    | CI's pgvector-version check is green, and every existing e2e-real spec stays green on the new image                                                                                                                            |
| 2    | `embed:verify` green in CI, and `bedrock-live.yml` green under the OIDC role                                                                                                                                                   |
| 3    | ingestion-fixture event + sequence bullets green (composition, staleness, unit length)                                                                                                                                         |
| 4    | ingestion-fixture passage bullets green                                                                                                                                                                                        |
| 5    | every `search-hybrid.spec.ts` row green                                                                                                                                                                                        |
| 6    | `search:eval` shows hybrid ≥ lexical (recall@5, MRR on lexical entries); the floor is committed as a constant whose comment carries the eval numbers; row 18's budget is in `infra/`; then the UI sends `mode=hybrid` on Enter |

### Step 3 as built (2026-10-15)

Where it departs from, or pins down, the text above:

- **Tables** (`AddEmbeddingTables1760572800000`): `event_embeddings` keyed on
  `event_id → events(id)` and `event_group_embeddings` on
  `group_id → event_groups(id)`, both `ON DELETE CASCADE`, `vector(256)`,
  with `model`, `dims`, `content_hash` and the composed `source_text`. Plan
  12 sketched `event_key`; search returns published events, whose key is
  `events.id`. Plan 13's dedup can add candidate rows when it's built.
- **Composition** lives in `libs/embedding/src/compose.ts`. The `Date:` part
  uses `formatDate`, moved to `packages/domain` so the map and the vector
  render a year-only event the same way ("1103", never "January 1, 1103").
- **The sweep** (`runEmbeddingSweep`) is framework-free and shared by the
  `embed` worker (a timer, default 60 s, `EMBED_SWEEP_INTERVAL_MS`),
  `search:reembed` (one pass), and the fixture. It takes an optional scope,
  which only the fixture uses: in CI the database also holds e2e-real's rows,
  and recordings exist only for the fixture's own texts.
- **Recording.** `EMBEDDING_ENGINE=record` serves recorded vectors and calls
  Bedrock for anything missing, writing it back to `search-vectors.json`, so
  the file holds exactly what the suites embed. `search:record-vectors` runs
  the ingestion fixture that way; step 5 extends it to e2e-real's search
  fixtures and wires it into `bedrock-live.yml` for PRs that change them. The
  first recording (15 vectors) was made by hand with admin credentials —
  identical vectors to the CI role's, since only the model decides them.
- **Jev-mode fixture runs skip the embed checks**: Jev holds some events back,
  so the published set and the sequence text over it differ from the
  baseline run's recording.
- **Passages (step 4)** need no `content_hash`: a re-cut (`SPLITTER_VERSION`
  or `EXTRACTOR_VERSION`) deletes and re-inserts a document's rows, so "needs
  embedding" is `embedding IS NULL` or another model. The fixture forces a
  re-cut and checks the sweep sends exactly the new rows' texts; both version
  bumps take that same path, so one check covers them. The backfill is the
  sweep itself — the worker fills every existing passage on its first pass.

### Step 5 as built (2026-10-15)

- **Shared engines.** The framework-free engine code moved to
  `packages/embedding` (`@historical-map/embedding`), so the web app embeds
  queries with the same Bedrock engine, error classification and
  recorded-vector fake as the workers.
- **The query** (`lib/search.ts`): for events, sequences and passages, a
  50-deep lexical pool and the vector arm's top 50 are fused by RRF (k = 60)
  in TypeScript. Vector-only hits are fetched through the same lexical
  queries with an id list in place of the text match (`PgSearchInput.ids`),
  so they keep identical shapes and filters, and carry
  `matchedOn: ["meaning"]`. Every filter (timeline, bbox, sources, the
  document span for passages) and the floor run inside the vector query
  (`vectorRanks`). Documents still roll up lexically only.
- **Query embedding** (`lib/search-semantic.ts`): normalised and clamped to
  200 characters, cached in `search_query_embeddings` (`real[]`, 30-day TTL,
  swept on misses), behind an atomic daily ceiling row
  (`SEARCH_EMBED_DAILY_CEILING`, default 5,000), no retries and a hard
  1.5 s deadline. Every failure → lexical, `modes.semantic = false`.
  Typeahead never embeds; a corpus with no vectors from the current model
  never embeds either.
- **Rate limit**: submitted `mode=hybrid` has its own per-IP bucket in the
  middleware (`SEARCH_HYBRID_RATE_LIMIT`, default 30/min); lexical and
  typeahead are unaffected.
- **Query log**: `search_query_log` exactly as specified, written for `log=1`
  (the search bar's Enter), with `POST /api/search/log` for clicks and
  90-day retention swept on write.
- **Test hooks**: `/api/search/test-embedder` (404 unless
  `EMBEDDING_ENGINE` is `fake` or `record`) exposes call counts and
  received texts, injects throttle/validation/timeout failures, and sets
  the ceiling.
- **Fixtures, departing from the plan**:
  - The Utah paraphrase is "Arkansas Company Attacked at the Springs", not
    "Baker–Fancher party attacked", which would have taken the lexical
    "fancher" golden query's top spot.
  - The filter rows use their own query, "pestilence ravaged the people",
    with target fx-ev-1520 and 50 distractors dated 1700–1798 in Europe.
    Measured with Titan: for "Toltec collapse", Fall of Tenochtitlán (0.478)
    is _nearer_ than Overthrow of Tula (0.363), so no distractor set can bury
    one without burying the other.
- **Recording**: `npm run search:record-vectors` re-records both suites in
  `record` mode, which retries throttling and waits it out. The
  `bedrock-live.yml` job that should re-record on fixture PRs isn't written
  yet.

### Step 6 as built (2026-10-15)

`npm run search:eval [-- --floor] [-- --live]` (`scripts/search-eval.ts`)
runs every golden entry in all three modes. On the fixture corpus, with
every query recorded (127 vectors):

| mode    | recall@5 | MRR   | MRR, lexical entries |
| ------- | -------- | ----- | -------------------- |
| lexical | 77.8%    | 0.708 | 0.896                |
| vector  | 80.6%    | 0.824 | 0.833                |
| hybrid  | 100.0%   | 0.891 | 0.933                |

**Ship gate passes**: hybrid recall@5 ≥ lexical, and MRR on the lexical
entries is higher, not lower. The vector arm's p95 is 26 ms over 91 vectors,
far from the 50 ms index threshold.

**Floor**: the sweep finds 6/6 expectations with 0 negative meaning-hits
from 0.300 to 0.325; one negative hit appears at 0.275, and a paraphrase is
lost at 0.350. `VECTOR_MIN_SIMILARITY = 0.3`, with that table in its comment.
The band is narrow and the corpus small. The plan's own caveat stands:
**re-run `--floor --live` on a real corpus** before trusting it more widely.
That needs a database on the pgvector image, embedded with live Bedrock: a
dev database rebuilt with `docker compose build db`, or production after the
RDS upgrade, followed by the ingest migrations and the `embed` worker.

**UI**: Enter sends `mode=hybrid&log=1`. Keystrokes stay lexical and
unlogged. A timeline or limit-to-view re-run of a submitted search stays
hybrid (its vector is cached) but isn't logged again. Both mocked UI rows
are in `e2e/search-bar.spec.ts`.

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
