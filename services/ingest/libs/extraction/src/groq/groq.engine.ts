import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ExtractedEvent } from "@historical-map/domain";
import { estimateTokens } from "../chunker";
import type {
  ExtractionChunk,
  ExtractionEngine,
} from "../extraction-engine.interface";
import {
  EXTRACTION_JSON_SCHEMA,
  extractionResponseSchema,
} from "./event-schema";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { TokenBucket, sleep } from "./token-bucket";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS_PER_CHUNK = 3;
const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Output ceiling. Groq charges the *reservation* against tokens-per-minute, not
 * the actual completion — with no ceiling set, a 429 on a ~2,400-token chunk
 * reported `Requested 6018`.
 *
 * **2,500 is empirically the floor, not a guess.** `gpt-oss-120b` is a
 * reasoning model and its reasoning tokens are billed as completion: a measured
 * call spent 898 of 1,334 completion tokens on reasoning alone. Setting 1,500
 * looked like a throughput win and instead produced
 * `json_validate_failed` with an EMPTY `failed_generation` — the budget was
 * exhausted before any JSON was emitted. The failure mode of setting this too
 * low is a hard 400, not a truncated result.
 */
const MAX_COMPLETION_TOKENS = 2_500;

/**
 * Extraction is mechanical: find the events, fill the schema. It does not need
 * deep deliberation, and on this model deliberation is most of the bill.
 *
 * Measured on the same input: default effort spent 898 reasoning tokens for 5
 * events; `low` spent 249 for **the same 5 events** — 24% fewer total tokens
 * for identical output. This is the cheapest quality-neutral saving available.
 */
const REASONING_EFFORT = "low";

/**
 * Marker for failures worth retrying. The retry loop keys on `instanceof` and
 * rethrows anything else immediately — so classification happens once, at the
 * HTTP boundary, rather than being re-derived at each layer.
 */
class RetryableGroqError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableGroqError";
  }
}

/**
 * Groq chat-completions engine using structured outputs.
 *
 * Raw `fetch` rather than `groq-sdk`, deliberately: the SDK's main value is its
 * retry handling, which this replaces wholesale in order to honour `Retry-After`
 * — and a single endpoint with a handful of parameters does not justify a
 * dependency whose types may lag the exact feature (`strict`) being relied on.
 */
@Injectable()
export class GroqExtractionEngine implements ExtractionEngine {
  readonly engineName = "groq";
  readonly model: string;

  private readonly logger = new Logger(GroqExtractionEngine.name);
  private readonly apiKey: string;
  private readonly bucket: TokenBucket;

  constructor(config: ConfigService) {
    this.apiKey = config.getOrThrow<string>("GROQ_API_KEY");
    this.model = config.get<string>("GROQ_MODEL") ?? "openai/gpt-oss-120b";
    this.bucket = new TokenBucket(
      config.get<number>("GROQ_TOKENS_PER_MINUTE") ?? 8000,
    );
  }

  async extractChunk(chunk: ExtractionChunk): Promise<ExtractedEvent[]> {
    const userPrompt = buildUserPrompt(chunk.text, chunk.anchors);

    // Reserve input **plus the output ceiling**, because that is what Groq
    // counts against TPM. Budgeting on input alone under-reserves by more than
    // half, so the bucket waves requests through that then 429 — pacing has to
    // model the same quantity the server is enforcing.
    const estimated =
      estimateTokens(SYSTEM_PROMPT + userPrompt) + MAX_COMPLETION_TOKENS;

    await this.bucket.take(estimated);

    const { content, usedTokens } = await this.requestWithRetry(userPrompt);
    if (usedTokens) this.bucket.reconcile(estimated, usedTokens);

    return this.parse(content, chunk);
  }

  private async requestWithRetry(
    userPrompt: string,
  ): Promise<{ content: string; usedTokens?: number }> {
    let lastError: Error = new Error("unreachable");

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CHUNK; attempt++) {
      try {
        return await this.request(userPrompt);
      } catch (error) {
        if (!(error instanceof RetryableGroqError)) throw error;
        lastError = error;

        if (attempt === MAX_ATTEMPTS_PER_CHUNK) break;

        // Honour Retry-After when the API supplies it. Doubling a fixed base
        // delay instead — as the transcription engine this is modelled on does
        // — means hammering a closed door on a token-limited tier, where the
        // server knows exactly how long the window has left and we do not.
        const delay =
          error.retryAfterMs ?? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(
          `attempt ${attempt} failed (${error.message}); retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }

  private async request(
    userPrompt: string,
  ): Promise<{ content: string; usedTokens?: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(GROQ_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          // Explicit ceiling — see MAX_COMPLETION_TOKENS. Without it Groq
          // reserves the model default against TPM.
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          reasoning_effort: REASONING_EFFORT,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "historical_events",
              // `strict` DEFAULTS TO FALSE, and must be set explicitly.
              //
              // It buys less than the docs imply: it guarantees you never
              // RECEIVE non-conforming JSON, not that the model never
              // GENERATES it. When generation does not conform, Groq rejects
              // the request with a 400 instead — observed on real text with an
              // out-of-enum `datePrecision`. Hence the retry classification
              // below; without it a single unlucky sample fails a whole chunk.
              strict: true,
              schema: EXTRACTION_JSON_SCHEMA,
            },
          },
          // Neither streaming nor tools may be combined with strict
          // structured outputs — the API rejects the request.
        }),
      });
    } catch (error) {
      // Wrapping the fetch itself is load-bearing: a DNS failure, connection
      // reset or abort rejects with a DOMException/TypeError that would skip
      // the retryable check entirely and fail the whole job on one blip.
      const message = error instanceof Error ? error.message : String(error);
      throw new RetryableGroqError(`network failure: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = `${response.status} ${body.slice(0, 300)}`;

      if (response.status === 429 || response.status >= 500) {
        throw new RetryableGroqError(
          detail,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }

      // A 400 is usually deterministic — a malformed request, or a schema that
      // breaks a strict-mode rule — and retrying it just burns the budget.
      //
      // Generation failures are the exception, and they are NOT rare in
      // practice. Strict decoding does not mean the model always emits
      // conforming JSON; it means Groq validates and rejects when it does not.
      // Observed on real text: an invalid `datePrecision` enum value, and a
      // truncated generation when the completion ceiling was too low. Both are
      // stochastic — a second sample usually succeeds — so they are retryable
      // while every other 400 stays fatal.
      if (response.status === 400 && isGenerationFailure(body)) {
        throw new RetryableGroqError(`generation failed: ${detail}`);
      }

      throw new Error(`Groq request failed: ${detail}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned no message content");

    return { content, usedTokens: payload.usage?.total_tokens };
  }

  private parse(content: string, chunk: ExtractionChunk): ExtractedEvent[] {
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      // Should be impossible under strict decoding; surfaced rather than
      // swallowed so a regression in that guarantee is visible.
      throw new Error(
        `Groq returned non-JSON under strict decoding: ${content.slice(0, 200)}`,
      );
    }

    const parsed = extractionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Groq response failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
          .slice(0, 300)}`,
      );
    }

    return parsed.data.events.map((event, i) => ({
      ...event,
      // Deterministic within a run, so a replayed chunk yields the same ids
      // rather than a fresh set that would defeat downstream deduplication.
      id: `${chunk.index}-${i}`,
      date: event.dateIso ?? event.dateText,
    }));
  }
}

/**
 * Did the model fail to produce conforming output, as opposed to the request
 * being wrong? Matched on Groq's own error code and message rather than the
 * status, because both arrive as 400.
 */
function isGenerationFailure(body: string): boolean {
  return (
    body.includes("json_validate_failed") ||
    body.includes("does not match the expected schema") ||
    body.includes("Failed to validate JSON")
  );
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return undefined;
}
