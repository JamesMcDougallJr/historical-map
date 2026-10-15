import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingError,
  classifyEmbeddingError,
  type EmbeddingEngine,
} from "../embedding-engine.interface";

export interface BedrockEmbeddingOptions {
  /** `BEDROCK_REGION` — deliberately not `AWS_REGION` (plan 12). */
  region: string;
  model?: string;
  dims?: number;
  /**
   * Explicit keys, for Vercel, which reserves the `AWS_*` names. Omit to use
   * the standard credential chain (workers, CI's OIDC role, a local profile).
   */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Attempts after the first, on retryable errors only. 0 for interactive callers. */
  maxRetries?: number;
  /** Requests in flight at once within one `embed()` call. */
  concurrency?: number;
  /** Per-request budget; an interactive search can't wait out a slow call. */
  timeoutMs?: number;
}

const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Titan Text Embeddings v2 via `InvokeModel`. Titan takes one text per call,
 * so a batch is fanned out with bounded concurrency.
 *
 * The SDK's own retries are off (`maxAttempts: 1`): they retry on their own
 * classification, and this engine's callers need exactly one — the one in
 * `classifyEmbeddingError` — so a worker retries throttling and a web request
 * retries nothing.
 */
export class BedrockEmbeddingEngine implements EmbeddingEngine {
  readonly engineName = "bedrock";
  readonly model: string;
  readonly dims: number;

  private readonly client: BedrockRuntimeClient;
  private readonly maxRetries: number;
  private readonly concurrency: number;

  constructor(options: BedrockEmbeddingOptions) {
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.dims = options.dims ?? DEFAULT_EMBEDDING_DIMS;
    this.maxRetries = options.maxRetries ?? 3;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.client = new BedrockRuntimeClient({
      region: options.region,
      credentials: options.credentials,
      maxAttempts: 1,
      requestHandler: options.timeoutMs
        ? { requestTimeout: options.timeoutMs }
        : undefined,
    });
  }

  /** From the environment the workers and CI share. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): BedrockEmbeddingEngine {
    const region = env["BEDROCK_REGION"];
    if (!region) {
      throw new Error(
        "BEDROCK_REGION is not set. Titan Embed v2 is verified in us-west-2; " +
          "the CLI's default region (us-west-1) has no Titan embedder.",
      );
    }
    const accessKeyId = env["BEDROCK_ACCESS_KEY_ID"];
    const secretAccessKey = env["BEDROCK_SECRET_ACCESS_KEY"];
    return new BedrockEmbeddingEngine({
      region,
      model: env["EMBEDDING_MODEL"] || undefined,
      dims: env["EMBEDDING_DIMS"] ? Number(env["EMBEDDING_DIMS"]) : undefined,
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results = new Array<number[]>(texts.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < texts.length) {
        const i = next++;
        results[i] = await this.embedOneWithRetry(texts[i]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, texts.length) }, worker),
    );
    return results;
  }

  private async embedOneWithRetry(text: string): Promise<number[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.embedOne(text);
      } catch (error) {
        const classified = classifyEmbeddingError(error);
        if (!classified.retryable || attempt >= this.maxRetries) {
          throw classified;
        }
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }

  private async embedOne(text: string): Promise<number[]> {
    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: this.model,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          inputText: text,
          dimensions: this.dims,
          // Unit length makes `<#>` (inner product) equal cosine (plan 12).
          normalize: true,
        }),
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      embedding?: number[];
    };
    if (
      !Array.isArray(parsed.embedding) ||
      parsed.embedding.length !== this.dims
    ) {
      throw new EmbeddingError(
        `${this.model} returned ${parsed.embedding?.length ?? "no"} dims, expected ${this.dims}`,
        false,
        "UnexpectedResponse",
      );
    }
    return parsed.embedding;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
