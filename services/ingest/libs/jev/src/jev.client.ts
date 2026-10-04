import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import {
  JevDisabledError,
  JevRequestError,
  type JevAnswer,
  type JevQuestion,
  type JevRequest,
} from "./jev.types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "typesafe/jev-latest";
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Wire format is INFERRED, not taken from TypeSafe's own docs.
 *
 * As of writing, Jev's publicly described interface is a dedicated typed
 * question/answer endpoint (`/v1/systemone`) rather than chat completions,
 * but it is also sold as "available to anyone with an OpenRouter API key" —
 * so this client targets OpenRouter's standard, well-documented chat
 * completions endpoint with a JSON-schema structured-output request (the
 * same pattern `GroqExtractionEngine` already uses in this repo), rather
 * than guessing at a bespoke request shape for an endpoint whose exact
 * contract hasn't been directly verified here.
 *
 * If TypeSafe's actual `/v1/systemone` contract turns out to differ (e.g. it
 * returns probabilities OpenRouter's chat-completions wrapper can't carry),
 * only `buildRequestBody` and `parseResponse` below need to change — every
 * call site talks to `JevClient.ask`, not to this wire format directly.
 */
@Injectable()
export class JevClient {
  private readonly logger = new Logger(JevClient.name);
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  // Explicit @Inject — see HealthController for why bare constructor-param-type
  // injection of a cross-file class silently resolves to undefined under tsx.
  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKey = config.get<string>("JEV_API_KEY");
    this.model = config.get<string>("JEV_MODEL") ?? DEFAULT_MODEL;
    this.baseUrl = config.get<string>("JEV_BASE_URL") ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.get<number>("JEV_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS;
  }

  /** Whether a call to `ask` can actually reach Jev. */
  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Asks Jev the given questions against the given context, throwing on any
   * failure (no API key, network error, bad response). Callers that want to
   * fail open to existing behaviour should use {@link tryAsk} instead.
   */
  async ask(request: JevRequest): Promise<JevAnswer[]> {
    if (!this.apiKey) throw new JevDisabledError();
    if (request.questions.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildRequestBody(this.model, request)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new JevRequestError(`network failure: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new JevRequestError(
        `Jev request failed: ${response.status} ${body.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new JevRequestError("Jev returned no message content");

    return parseResponse(content, request.questions);
  }

  /**
   * Same as {@link ask}, but never throws — logs a warning and returns `null`
   * instead. Every call site in this codebase uses this: a Jev outage, a rate
   * limit, or a malformed response should fall back to the existing
   * non-Jev check, never break the pipeline.
   */
  async tryAsk(request: JevRequest): Promise<JevAnswer[] | null> {
    try {
      return await this.ask(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Jev call failed, falling back: ${message}`);
      return null;
    }
  }
}

function buildRequestBody(model: string, request: JevRequest) {
  return {
    model,
    max_completion_tokens: 200 * Math.max(1, request.questions.length),
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: buildUserPrompt(request),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "jev_answers",
        strict: true,
        schema: buildAnswerSchema(request.questions),
      },
    },
  };
}

const SYSTEM_PROMPT =
  "You answer each typed question about the given context independently. " +
  "For a choice question, `value` is the zero-based index of the best " +
  "option. For a score question, `value` is the zero-based index of the " +
  "best rubric tier. For a noul (yes/no) question, `value` is 1 for yes " +
  "and 0 for no. `probability` is your confidence in `value`, from 0 to 1.";

function buildUserPrompt(request: JevRequest): string {
  const questionBlocks = request.questions.map((q) => describeQuestion(q));
  return [
    `Context:\n${request.context}`,
    "",
    "Questions:",
    ...questionBlocks,
  ].join("\n");
}

function describeQuestion(question: JevQuestion): string {
  switch (question.kind) {
    case "choice":
      return `- [${question.id}] (choice) ${question.prompt}\n  options: ${question.options
        .map((o, i) => `${i}=${o}`)
        .join("; ")}`;
    case "score":
      return `- [${question.id}] (score) ${question.prompt}\n  tiers: ${question.tiers
        .map((t, i) => `${i}=${t}`)
        .join("; ")}`;
    case "noul":
      return `- [${question.id}] (yes/no) ${question.prompt}`;
  }
}

/**
 * Strict-mode JSON Schema, one required property per question id — following
 * the same constraints `EXTRACTION_JSON_SCHEMA` documents for Groq's strict
 * decoding (every property required, `additionalProperties: false`, no
 * `pattern`/length constraints).
 */
function buildAnswerSchema(questions: JevQuestion[]) {
  const properties: Record<string, unknown> = {};
  for (const q of questions) {
    properties[q.id] = {
      type: "object",
      additionalProperties: false,
      required: ["value", "probability"],
      properties: {
        value: { type: "integer" },
        probability: { type: "number" },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: questions.map((q) => q.id),
    properties,
  };
}

const answerShape = z.object({
  value: z.number(),
  probability: z.number(),
});

function parseResponse(
  content: string,
  questions: JevQuestion[],
): JevAnswer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new JevRequestError(
      `Jev returned non-JSON under strict decoding: ${content.slice(0, 200)}`,
    );
  }

  const shape = z.object(
    Object.fromEntries(questions.map((q) => [q.id, answerShape])),
  );
  const parsed = shape.safeParse(raw);
  if (!parsed.success) {
    throw new JevRequestError(
      `Jev response failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
        .slice(0, 300)}`,
    );
  }

  return questions.map((q) => {
    const answer = (parsed.data as Record<string, { value: number; probability: number }>)[
      q.id
    ];
    return {
      id: q.id,
      value: clampValue(q, answer.value),
      probability: Math.min(1, Math.max(0, answer.probability)),
    };
  });
}

function clampValue(question: JevQuestion, value: number): number {
  const max =
    question.kind === "choice"
      ? question.options.length - 1
      : question.kind === "score"
        ? question.tiers.length - 1
        : 1;
  return Math.min(max, Math.max(0, Math.round(value)));
}
