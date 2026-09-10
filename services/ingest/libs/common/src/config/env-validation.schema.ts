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

  // Required only by `extract`; optional here so the other apps boot without it.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  // Read via process.env in @Processor() options (which evaluate at module-load
  // time, before DI exists) — validated here purely so a bad value fails fast.
  DETECT_CONCURRENCY: z.coerce.number().int().positive().default(1),
  FETCH_CONCURRENCY: z.coerce.number().int().positive().default(4),
  EXTRACT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  PUBLISH_CONCURRENCY: z.coerce.number().int().positive().default(2),

  /**
   * How far back a detection pass considers, by document *publication* date —
   * not by when the event happened. An 1847 event can be catalogued last
   * Tuesday, so this bounds crawl volume, not historical scope.
   */
  DETECTION_LOOKBACK_DAYS: z.coerce.number().int().positive().default(365),

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
