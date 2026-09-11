# Embeddings, vector storage, and the Bedrock provider

Shared substrate for [13-similarity-and-fusion.md](./13-similarity-and-fusion.md)
(deduplication) and [14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md)
(RAG). Both need the same three things — an embedding provider, somewhere to put
vectors, and a cheap judge model — so they are settled once, here.

## Verified facts

Measured against this machine and this AWS account, not assumed:

| Fact                          | Detail                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Groq cannot embed**         | `GET /openai/v1/models` returns 14 models, **zero** embedding models. Extraction stays on Groq; embeddings need another provider.                                          |
| **pgvector is not installed** | `pg_available_extensions` on `imresamu/postgis:17-3.5-alpine` lists `postgis`, `pg_trgm`, `fuzzystrmatch`, `unaccent` — **no `vector`**.                                   |
| **AWS works**                 | Account `138630010063`, CLI v2.33.2.                                                                                                                                       |
| **Default region is a trap**  | `aws configure get region` → **us-west-1**, which exposes only **32** Bedrock models and exactly one embedder (`cohere.embed-v4:0`). us-west-2 has 113, us-east-1 has 120. |
| **Titan Embed v2 works live** | `amazon.titan-embed-text-v2:0` in **us-west-2** returned a 256-dim normalized vector; `"Overthrow of Tula"` = 6 input tokens.                                              |
| **Judge models work**         | `amazon.nova-lite-v1:0`, `us.amazon.nova-lite-v1:0`, `mistral.ministral-3-8b-instruct` all answered via Converse.                                                          |
| **One model id does not**     | `amazon.nova-2-lite-v1:0` → `ValidationException: … with on-demand throughput isn't supported`. It requires an inference profile.                                          |
| **SDK is half-present**       | `services/ingest` already depends on `@aws-sdk/client-s3`. The **web app has no AWS SDK at all**.                                                                          |

### Two things to fix before building

**Use us-west-2 (or us-east-1) for Bedrock.** Not us-west-1. Bedrock's region is
independent of where S3/MinIO lives, so this costs nothing but an env var —
`BEDROCK_REGION`, deliberately separate from `AWS_REGION`, so moving the model
calls never moves the object storage.

**Stop using root credentials.** `aws sts get-caller-identity` returns
`arn:aws:iam::138630010063:root`. Long-lived root access keys cannot be scoped
or rotated independently and are the one credential that can never be revoked
without disrupting everything. Before any of this ships, create an IAM user (or
role) limited to `bedrock:InvokeModel` on the specific model ARNs plus the
existing S3 needs. This is not a nice-to-have: these workers are long-lived
processes on a deployed host.

## Decision: Bedrock, one provider for both jobs

Bedrock supplies the embedding model **and** the judge model behind credentials
the repo already uses for object storage. That matters more than it sounds:
`@aws-sdk/client-s3` already resolves the standard credential chain in the
workers, so adding `@aws-sdk/client-bedrock-runtime` introduces a dependency but
**no new secret to distribute**, and dev/prod differ by region rather than by
provider — the same shape as MinIO-vs-S3 differing only by `S3_ENDPOINT`.

Alternatives considered and rejected:

- **Local ONNX embeddings** (`fastembed`, `@xenova/transformers`) — no key, no
  per-token cost, but ships a ~100MB model into every worker image and puts
  embedding throughput on the same CPU that is already doing PDF parsing. Worth
  revisiting if Bedrock cost ever becomes real; the interface below makes it a
  drop-in.
- **A hosted vector DB** (Pinecone, Qdrant Cloud) — rejected on the existing
  locked decision in [00-README.md](./00-README.md): one Postgres, no second
  datastore, no API hop between the workers and the map. That decision is _more_
  load-bearing here, not less, because the web app must query vectors directly
  to serve RAG.

### Model choices

| Role             | Model                          | Why                                                 |
| ---------------- | ------------------------------ | --------------------------------------------------- |
| Embeddings       | `amazon.titan-embed-text-v2:0` | Verified working; configurable dimensions.          |
| Judge            | `amazon.nova-lite-v1:0`        | Verified; cheapest verified Converse model.         |
| Judge escalation | `anthropic.claude-haiku-4-5-…` | Available in-region for pairs Nova marks uncertain. |

**Dimensions: start at 256.** Titan v2 emits 256/512/1024. 256 quarters the
index size against 1024 and is almost certainly sufficient to _rank candidates_
— and ranking is all the vectors do here, because an LLM makes the actual
same/different call (see 13). Treat this as measurable, not settled: re-embedding
the corpus is cheap (~80k tokens for the whole 85-page book, see below), so the
cost of being wrong is one backfill.

**`normalize: true` always.** Normalized vectors make cosine distance and inner
product equivalent, which lets pgvector use the cheaper operator without the
result changing.

## Storage: pgvector in the same Postgres

Requires an image change — the current one has no `vector` extension.

Options, in preference order:

1. **Extend the existing image.** A three-line Dockerfile `FROM
imresamu/postgis:17-3.5-alpine` that builds pgvector. Keeps PostGIS (which
   `publish` needs for `ST_DWithin`) and adds vectors. One image, one database.
2. **A published image carrying both.** Cleaner if one exists at a version
   matching PostGIS 3.5/PG17 — verify before committing, don't assume.
3. **Managed Postgres in production.** Neon, Supabase and RDS all support
   pgvector; whichever backs `POSTGRES_URL` in production must have it enabled,
   and **this needs checking before the schema depends on it**.

> Production and dev must agree. A migration that runs `CREATE EXTENSION vector`
> locally and fails on the deployed database is the worst outcome — it fails at
> deploy time, after the code that depends on it has merged.

### Schema sketch

Two vector tables, because the two consumers index different things and should
not share a lifecycle:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- For deduplication (13). One row per published/candidate event.
CREATE TABLE event_embeddings (
  event_key    text PRIMARY KEY,
  embedding    vector(256) NOT NULL,
  model        text NOT NULL,         -- provenance: which model, which dims
  dims         int  NOT NULL,
  source_text  text NOT NULL,         -- exactly what was embedded
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- For RAG (14). One row per text-artifact segment, per document.
CREATE TABLE document_segment_embeddings (
  document_id  uuid NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
  anchor       text NOT NULL,         -- "p.43" — carried from the text artifact
  chunk_index  int  NOT NULL,
  embedding    vector(256) NOT NULL,
  model        text NOT NULL,
  text         text NOT NULL,
  PRIMARY KEY (document_id, chunk_index)
);
```

`model` and `dims` are on both tables deliberately. Changing embedding model or
dimensionality invalidates every stored vector, and a column that records which
model produced a row is what makes a partial re-embed possible instead of a
full wipe — the same reasoning as `text_extractor_version` on `ingest_documents`.

Index with HNSW (`vector_ip_ops`, given normalization). At the current corpus
size — 131 candidates, 83 segments — **any** index is theatre; add it when the
table is large enough to measure, and say so rather than pretending it was
tuned.

## The provider interface

Mirrors the established idiom exactly: interface + string DI token + module
binding, the same as `ExtractionEngine`/`EXTRACTION_ENGINE` and
`StorageService`/`STORAGE_SERVICE`.

```ts
export interface EmbeddingEngine {
  readonly model: string;
  readonly dims: number;
  /** Batch, because per-item HTTP is the dominant cost at corpus scale. */
  embed(texts: string[]): Promise<number[][]>;
}
export const EMBEDDING_ENGINE = "EMBEDDING_ENGINE";
```

```ts
export interface JudgeEngine {
  judge<T>(prompt: JudgePrompt, schema: JsonSchema): Promise<T>;
}
export const JUDGE_ENGINE = "JUDGE_ENGINE";
```

Use the **Converse API** (`ConverseCommand`), not per-model `InvokeModel` bodies.
Converse normalises the request shape across Nova, Mistral and Claude, so
swapping judge models is a config change. Structured output goes through
Converse `toolConfig` — the Bedrock equivalent of the strict JSON schema the
Groq engine already relies on.

### Carry over what Groq taught us

The lessons in `groq.engine.ts` were paid for and mostly are not Groq-specific:

- **Set an explicit output ceiling.** Bedrock bills output tokens; a judge that
  returns a paragraph when it needed a word is pure waste.
- **Classify errors before retrying.** Throttling (`ThrottlingException`) is
  retryable; `ValidationException` is not, and retrying it burns budget on a
  request that can never succeed — the `nova-2-lite` inference-profile failure
  above is exactly this class.
- **Reserve batch capacity in a token bucket.** Bedrock throttles per-account
  per-model; embedding 83 segments in one burst is the obvious way to find out.
- **Strict schemas fail differently than advertised.** Assume the model will
  occasionally produce non-conforming output and that the API will reject it;
  retry a bounded number of times rather than failing the job.

## What this costs, measured in tokens

Dollar figures go stale, so size it in what was actually measured:

- The 85-page book cleans to **322,304 characters ≈ 80k tokens**. Embedding
  every segment once is ~80k input tokens — a one-off per document, repeated
  only when `EXTRACTOR_VERSION` or the embedding model changes.
- Event embeddings are tiny: 131 candidates × ~40 tokens ≈ **5k tokens** total.
- The judge is the variable cost, and it is the reason 13 puts vector search
  _before_ the LLM: judging all pairs is O(n²) (131 events → 8,515 pairs), while
  judging only vector-shortlisted pairs is roughly linear.

Embedding is cheap enough to be uninteresting. **Judging is not**, and the
design must keep it proportional to the number of _plausible_ duplicates rather
than the number of events.

## Open questions

1. Does the production `POSTGRES_URL` database support pgvector? Blocking.
2. 256 vs 512 dims — decide from a measured precision/recall curve on real
   duplicate pairs, not a guess.
3. Does the web app call Bedrock directly for RAG (needs AWS credentials on
   Vercel) or proxy through the ingest `api` service? See 14.
