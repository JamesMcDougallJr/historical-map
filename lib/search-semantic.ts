// Query embedding for hybrid search (plans/23-search-semantic.md, "Query
// embedding at request time" and "Cost and abuse").
//
// Returns the query's vector, or null — never throws. Every way this can fail
// (no engine configured, the daily ceiling reached, Bedrock throttling, a
// validation error, a timeout) means the same thing to the caller: search
// lexically and say `modes.semantic = false`. An interactive search never
// fails, or waits on a retry, because the embedder did.

import {
  BedrockEmbeddingEngine,
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingError,
  FakeEmbeddingEngine,
  RecordingEmbeddingEngine,
  recordedVectorsPath,
  type EmbeddingEngine,
} from "@historical-map/embedding";
import { sqlClient } from "./postgres-storage";

/** Characters of query text sent to the embedder; longer queries are clamped. */
export const MAX_EMBED_CHARS = 200;
/** Bedrock calls per UTC day, across all users — what actually bounds the bill. */
const DEFAULT_DAILY_CEILING = 5000;
/** Cached query vectors are re-embedded after this, and swept. */
const CACHE_TTL_DAYS = 30;
/** One Titan call is ~100–300 ms; past this the search goes lexical. */
const EMBED_TIMEOUT_MS = 1500;

/**
 * Recording (`EMBEDDING_ENGINE=record`) is a test run, not a user waiting:
 * it retries throttling and waits it out, because a query that degrades to
 * lexical there is a query that never gets recorded.
 */
const recording = () => process.env["EMBEDDING_ENGINE"] === "record";
const deadlineMs = () => (recording() ? 120_000 : EMBED_TIMEOUT_MS);

export interface QueryVector {
  vector: number[];
  model: string;
}

/** Lowercased, whitespace-collapsed, clamped — the cache key *and* what is embedded. */
export function normaliseQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EMBED_CHARS);
}

// ── The engine ──────────────────────────────────────────────────────────────

let engine: EmbeddingEngine | null | undefined;

/**
 * `EMBEDDING_ENGINE=fake` (CI) uses the recorded vectors, `record` fills them
 * from live Bedrock (`search:record-vectors`); otherwise Bedrock when
 * `BEDROCK_REGION` is set (production, via Terraform), else none — a deploy
 * without it simply has no semantic search.
 */
function getEngine(): EmbeddingEngine | null {
  if (engine !== undefined) return engine;
  const mode = process.env["EMBEDDING_ENGINE"];
  if (mode === "fake") {
    engine = testHooks.wrap(FakeEmbeddingEngine.fromFile());
  } else if (mode === "record") {
    const live = bedrock();
    engine = live
      ? testHooks.wrap(
          new RecordingEmbeddingEngine(live, recordedVectorsPath(false)),
        )
      : null;
  } else {
    engine = bedrock();
  }
  return engine;
}

function bedrock(): EmbeddingEngine | null {
  const env = process.env;
  const region = env["BEDROCK_REGION"];
  if (!region) return null;
  const accessKeyId = env["BEDROCK_ACCESS_KEY_ID"];
  const secretAccessKey = env["BEDROCK_SECRET_ACCESS_KEY"];
  return new BedrockEmbeddingEngine({
    region,
    model: env["EMBEDDING_MODEL"] || DEFAULT_EMBEDDING_MODEL,
    dims: DEFAULT_EMBEDDING_DIMS,
    // Vercel reserves the AWS_* names, so its keys arrive as BEDROCK_*.
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
    maxRetries: recording() ? 8 : 0,
    timeoutMs: EMBED_TIMEOUT_MS,
  });
}

/** The model hybrid search would embed with, or null when it can't. */
export function semanticModel(): string | null {
  return getEngine()?.model ?? null;
}

// ── Cache and ceiling ───────────────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;

/**
 * Web-app-owned, so created here rather than by an ingest migration. The
 * cached vector is `real[]`, not `vector`: these tables must not depend on
 * pgvector being installed, and the cast happens at query time.
 */
function ensureSemanticSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const sql = sqlClient();
    await sql`
      CREATE TABLE IF NOT EXISTS search_query_embeddings (
        q_norm     text   NOT NULL,
        model      text   NOT NULL,
        dims       int    NOT NULL,
        embedding  real[] NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (q_norm, model, dims)
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS search_embedding_usage (
        day   date PRIMARY KEY,
        calls int  NOT NULL
      )`;
  })().catch((error: unknown) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function dailyCeiling(): number {
  if (testHooks.ceiling !== null) return testHooks.ceiling;
  const n = Number(process.env["SEARCH_EMBED_DAILY_CEILING"]);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CEILING;
}

/**
 * Takes one call from today's budget, atomically; false once it's spent.
 * Checked before embedding, so past the ceiling Bedrock is never called.
 */
async function takeFromCeiling(): Promise<boolean> {
  const sql = sqlClient();
  const ceiling = dailyCeiling();
  const rows = await sql<{ calls: number }[]>`
    INSERT INTO search_embedding_usage AS u (day, calls)
    SELECT (now() AT TIME ZONE 'utc')::date, 1 WHERE ${ceiling} > 0
    ON CONFLICT (day) DO UPDATE SET calls = u.calls + 1
      WHERE u.calls < ${ceiling}
    RETURNING calls`;
  return rows.length > 0;
}

/** Expired cache rows, swept on every miss — cheap, and no scheduler needed. */
export async function sweepQueryCache(): Promise<void> {
  await ensureSemanticSchema();
  const sql = sqlClient();
  await sql`
    DELETE FROM search_query_embeddings
    WHERE created_at < now() - make_interval(days => ${CACHE_TTL_DAYS})`;
}

/**
 * The query's vector: from the cache when a fresh row exists, else one
 * embedder call (subject to the daily ceiling), cached for next time.
 */
export async function embedQuery(text: string): Promise<QueryVector | null> {
  const active = getEngine();
  const q = normaliseQuery(text);
  if (!active || !q) return null;
  try {
    await ensureSemanticSchema();
    const sql = sqlClient();
    const [hit] = await sql<{ embedding: number[] }[]>`
      SELECT embedding FROM search_query_embeddings
      WHERE q_norm = ${q} AND model = ${active.model} AND dims = ${active.dims}
        AND created_at >= now() - make_interval(days => ${CACHE_TTL_DAYS})`;
    if (hit) return { vector: hit.embedding.map(Number), model: active.model };

    if (!(await takeFromCeiling())) return null;
    // A hard deadline here, not only the SDK's: whatever the engine does, the
    // search goes lexical once the budget is spent.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new EmbeddingError("embedding timed out", true, "TimeoutError"),
          ),
        // An injected failure is testing the real budget, even while recording.
        testHooks.failure ? EMBED_TIMEOUT_MS : deadlineMs(),
      );
    });
    const [vector] = await Promise.race([active.embed([q]), deadline]).finally(
      () => clearTimeout(timer),
    );
    if (!vector) return null;
    await sql`
      INSERT INTO search_query_embeddings (q_norm, model, dims, embedding)
      VALUES (${q}, ${active.model}, ${active.dims}, ${vector})
      ON CONFLICT (q_norm, model, dims)
        DO UPDATE SET embedding = EXCLUDED.embedding, created_at = now()`;
    await sweepQueryCache();
    return { vector, model: active.model };
  } catch (error) {
    const reason =
      error instanceof EmbeddingError ? error.code : (error as Error)?.message;
    console.warn(`[search] semantic arm unavailable: ${reason}`);
    return null;
  }
}

// ── Test hooks (EMBEDDING_ENGINE=fake only) ─────────────────────────────────

type Failure = "throttle" | "validation" | "timeout" | null;

/**
 * What e2e-real's hybrid spec needs to observe and provoke: how many times
 * the embedder was called and with what (cache, typeahead, length clamp), and
 * an embedder that throttles, rejects, or hangs past the request budget.
 * Reachable only through `/api/search/test-embedder`, which 404s unless
 * `EMBEDDING_ENGINE=fake`.
 *
 * Kept on `globalThis`: Next can give each route handler its own instance of
 * a module, and the test route must see the counters the search route bumps.
 */
const globalHooks = globalThis as typeof globalThis & {
  __searchEmbedderTestHooks?: typeof hooks;
};
const hooks = {
  calls: 0,
  received: [] as string[],
  failure: null as Failure,
  /** Overrides SEARCH_EMBED_DAILY_CEILING. */
  ceiling: null as number | null,
  /** Counters, failure and ceiling back to defaults; the cache and today's usage emptied. */
  async reset(): Promise<void> {
    this.calls = 0;
    this.received = [];
    this.failure = null;
    this.ceiling = null;
    await ensureSemanticSchema();
    const sql = sqlClient();
    await sql`DELETE FROM search_query_embeddings`;
    await sql`DELETE FROM search_embedding_usage`;
  },
  wrap(inner: EmbeddingEngine): EmbeddingEngine {
    const hooks = this;
    return {
      engineName: inner.engineName,
      model: inner.model,
      dims: inner.dims,
      async embed(texts: string[]): Promise<number[][]> {
        hooks.calls++;
        hooks.received.push(...texts);
        switch (hooks.failure) {
          case "throttle":
            throw new EmbeddingError(
              "fake throttling",
              true,
              "ThrottlingException",
            );
          case "validation":
            throw new EmbeddingError(
              "fake validation",
              false,
              "ValidationException",
            );
          case "timeout":
            // Hangs well past the deadline; embedQuery must not wait for it.
            await new Promise((r) => setTimeout(r, EMBED_TIMEOUT_MS * 10));
            return inner.embed(texts);
          default:
            return inner.embed(texts);
        }
      },
    };
  },
};
export const testHooks = (globalHooks.__searchEmbedderTestHooks ??= hooks);
