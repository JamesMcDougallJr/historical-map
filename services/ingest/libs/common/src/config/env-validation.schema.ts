import { z } from "zod";

/**
 * One schema for all five apps.
 *
 * Anything only one app needs is `.optional()` or `.default()`ed, so the other
 * four don't refuse to boot over a variable they never read — the same
 * single-schema-many-apps pattern the pipeline this is modelled on used.
 *
 * `POSTGRES_URL` is deliberately the same variable name the web app uses. The
 * workers and the map must point at the same database; a worker aimed at a
 * different one ingests happily into a void with no error anywhere.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Not `.url()` — a postgres:// DSN is not a URL every zod version accepts,
  // and the connection itself fails loudly enough if this is malformed.
  POSTGRES_URL: z.string().min(1),

  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  /**
   * Object storage. MinIO locally, any S3 in production — only S3_ENDPOINT
   * differs. Holds the original bytes and the cleaned-text artifact; keeping
   * the original is what lets `extract-text` re-run new cleaning rules without
   * going back to the source.
   */
  S3_ENDPOINT: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_BUCKET: z.string().min(1).default("ingest"),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  /**
   * Directory the `local-directory` source scans. Relative paths resolve
   * against the process cwd, so a worker started from the repo root picks up
   * `./corpus` without configuration.
   */
  INGEST_CORPUS_DIR: z.string().min(1).default("./corpus"),

  // Required only by `extract`; optional here so the other apps boot without it.
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),

  /**
   * Input-token budget per extraction chunk. Chunks are cut on segment
   * boundaries, so this is a target rather than a hard cap — a single page
   * larger than this is still sent whole rather than split mid-page.
   *
   * Sized against the free tier's 8,000 tokens/minute, and note what Groq
   * actually meters: input PLUS the output reservation. With a 1,500-token
   * completion ceiling, a 2,000-token chunk reserves ~3,900 per request, which
   * fits two requests per minute. A 3,000-token chunk reserved ~6,000 and
   * managed barely one.
   */
  EXTRACT_CHUNK_TOKENS: z.coerce.number().int().positive().default(2000),

  /** Tokens/minute to throttle against. Raise this on a paid key. */
  GROQ_TOKENS_PER_MINUTE: z.coerce.number().int().positive().default(8000),

  /**
   * Below this, an extracted event goes to the review queue instead of the map.
   * The map's value is being trustworthy about the past, so the default leans
   * toward withholding rather than publishing a guess.
   */
  PUBLISH_CONFIDENCE_MIN: z.coerce.number().min(0).max(1).default(0.6),

  /**
   * Nominatim requires a genuine identifying User-Agent and at most one request
   * per second. Both are policy, not guidance — exceeding them gets an IP
   * blocked from free public infrastructure.
   */
  GEOCODER_USER_AGENT: z.string().min(1).optional(),
  GEOCODER_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(1100),

  /**
   * Comma-separated ISO country codes to restrict geocoding to, e.g. "us".
   * Per-corpus knowledge and the cheapest accuracy win available — unset means
   * the whole world, which is how "Sutter's Mill" resolves to Idaho.
   */
  GEOCODER_COUNTRY_CODES: z.string().min(1).optional(),

  // Read via process.env in @Processor() options (which evaluate at module-load
  // time, before DI exists) — validated here purely so a bad value fails fast.
  DETECT_CONCURRENCY: z.coerce.number().int().positive().default(1),
  FETCH_CONCURRENCY: z.coerce.number().int().positive().default(4),
  EXTRACT_TEXT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  EXTRACT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  VALIDATE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  PUBLISH_CONCURRENCY: z.coerce.number().int().positive().default(2),

  /**
   * How far back a detection pass considers, by document *publication* date —
   * not by when the event happened. An 1847 event can be catalogued last
   * Tuesday, so this bounds crawl volume, not historical scope.
   */
  DETECTION_LOOKBACK_DAYS: z.coerce.number().int().positive().default(365),

  /**
   * Bull Board credentials. With no password the dashboard returns 503 rather
   * than mounting openly — it exposes every job payload and a Remove button.
   */
  BULL_BOARD_USER: z.string().min(1).default("admin"),
  BULL_BOARD_PASSWORD: z.string().min(1).optional(),

  PORT: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `validate` hook for `ConfigModule.forRoot`. Throws with every problem at
 * once rather than one per restart.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
