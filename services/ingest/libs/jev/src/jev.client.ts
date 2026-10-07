import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  TypeSafeClient,
  type EntryType,
  type Questions,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { JevDisabledError } from "./jev.types";

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 1;

/** Answers keyed by question name, typed from the questions that were asked. */
export type JevAnswers<Q extends Questions> = SystemOneResult<Q>["answers"];

/**
 * Thin, fail-open wrapper over the official `@typesafe-ai/sdk` client.
 *
 * The SDK owns the wire contract (`POST /v1/systemone`), retry with
 * `Retry-After`, per-attempt timeouts and typed answers. What this adds:
 *
 * - **Disabled without credentials.** No `JEV_API_KEY` means no client is
 *   built at all, so every call site's `enabled` check is a plain boolean.
 * - **`tryAsk` never throws.** A Jev outage, rate limit or bad response must
 *   fall back to the pre-Jev behaviour, never break the pipeline — every call
 *   site in this codebase uses it.
 * - **Latency bounds suited to a worker hot path.** The SDK defaults (10s
 *   timeout, 2 retries) could stall one event for ~30s; these default to 5s
 *   and 1 retry, both configurable.
 */
@Injectable()
export class JevClient {
  private readonly logger = new Logger(JevClient.name);
  private readonly client?: TypeSafeClient;

  // Explicit @Inject — see HealthController for why bare constructor-param-type
  // injection of a cross-file class silently resolves to undefined under tsx.
  constructor(@Inject(ConfigService) config: ConfigService) {
    const apiKey = config.get<string>("JEV_API_KEY");
    if (!apiKey) return;

    this.client = new TypeSafeClient({
      apiKey,
      baseURL: config.get<string>("JEV_BASE_URL"),
      defaultModel: config.get<string>("JEV_MODEL") ?? DEFAULT_MODEL,
      timeout: config.get<number>("JEV_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
      retry: { maxRetries: config.get<number>("JEV_MAX_RETRIES") ?? DEFAULT_MAX_RETRIES },
      // `tryAsk` logs failures itself, once; SDK logging would duplicate it.
      logLevel: "off",
      // Resolved per call rather than captured at construction, so tests that
      // swap `globalThis.fetch` after the client exists still intercept it.
      fetch: (input, init) => globalThis.fetch(input, init),
    });
  }

  /** Whether a call to `ask` can actually reach Jev. */
  get enabled(): boolean {
    return this.client !== undefined;
  }

  /**
   * Asks Jev the given questions about `state`, throwing on any failure.
   * Callers that want to fall back to existing behaviour use {@link tryAsk}.
   */
  async ask<const Q extends Questions>(
    state: EntryType,
    questions: Q,
  ): Promise<JevAnswers<Q>> {
    if (!this.client) throw new JevDisabledError();
    if (Object.keys(questions).length === 0) return {} as JevAnswers<Q>;

    const { answers } = await this.client.systemOne({ state, questions });

    // The SDK types `answers` from the questions but does not verify the
    // server delivered them. A 200 with a missing or mistyped answer would
    // otherwise surface as a TypeError inside a check — failing a whole
    // validate job — instead of the fail-open `null` every caller relies on.
    for (const [name, question] of Object.entries(questions)) {
      const answer = (answers as Record<string, { type?: string } | undefined> | undefined)?.[name];
      if (!answer || answer.type !== question.type) {
        throw new Error(`Jev response missing a ${question.type} answer for "${name}"`);
      }
    }
    return answers;
  }

  /**
   * Same as {@link ask}, but never throws — logs a warning and returns `null`.
   * Every call site in this codebase uses this.
   */
  async tryAsk<const Q extends Questions>(
    state: EntryType,
    questions: Q,
  ): Promise<JevAnswers<Q> | null> {
    try {
      return await this.ask(state, questions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Jev call failed, falling back: ${message}`);
      return null;
    }
  }
}
