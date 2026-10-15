/**
 * Turns text into vectors (plans/12-embeddings-and-bedrock.md).
 *
 * Every file in this library except `embedding.module.ts` is free of Nest and
 * `@app/*` imports, so the web app's query embedding (plan 23, step 5) can use
 * the same engines and the same error classification as the workers.
 */
export interface EmbeddingEngine {
  readonly engineName: string;
  /** Recorded on every stored vector — comparing across models is meaningless. */
  readonly model: string;
  readonly dims: number;
  /**
   * Batch, because per-item HTTP is the dominant cost at corpus scale. Returns
   * one unit-length vector per input, in input order.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/** The only model and size anything here is built for (plan 12). */
export const DEFAULT_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
export const DEFAULT_EMBEDDING_DIMS = 256;

/**
 * An embedding failure, already classified. `retryable` is the whole point:
 * throttling and transient server errors are worth another attempt;
 * validation and access errors never succeed on retry, and retrying them
 * burns budget (plan 12's `nova-2-lite` inference-profile failure is exactly
 * that class). Interactive callers don't retry either way — they degrade.
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The provider's error name, e.g. `ThrottlingException`. */
    readonly code: string,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

const RETRYABLE_CODES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelNotReadyException",
  "ModelTimeoutException",
  "TimeoutError",
  "RequestTimeout",
  "ECONNRESET",
  "ETIMEDOUT",
]);

/**
 * Classifies anything an engine call can throw. AWS SDK v3 errors carry the
 * service's exception name in `name`; network failures carry a Node `code`.
 * Unknown errors are **not** retryable — guessing "yes" on an error nobody
 * has seen is how a deterministic failure becomes a retry storm.
 */
export function classifyEmbeddingError(error: unknown): EmbeddingError {
  if (error instanceof EmbeddingError) return error;
  const name =
    (error as { name?: string })?.name ??
    (error as { code?: string })?.code ??
    "Unknown";
  const code =
    name === "Error" ? ((error as { code?: string })?.code ?? name) : name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  const message = error instanceof Error ? error.message : String(error);
  const retryable =
    RETRYABLE_CODES.has(code) || status === 429 || (status ?? 0) >= 500;
  return new EmbeddingError(`${code}: ${message}`, retryable, code);
}

/** ‖v‖ — `<#>` only equals cosine distance when this is 1. */
export function vectorNorm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
}
