/**
 * Exercises `JevClient` and the Jev-backed validation checks against a
 * mocked `fetch`. No network, no database, no Redis — same spirit as
 * `verify-geocoding.ts` and `verify-extraction.ts`.
 *
 *   npm run jev:verify --workspace=services/ingest
 *
 * This is the fast, every-commit layer. The real wiring — does the actual
 * worker process, booted via `tsx`, resolve `JevClient` through Nest's DI
 * container and persist the resulting checks — is covered separately by
 * `run-ingestion-fixture.ts`'s `JEV_FIXTURE=1` mode, because a mocked unit
 * test like this one cannot catch a DI wiring bug (see that file, and
 * `HealthController`, for why that failure mode is real here).
 */
import type { ConfigService } from "@nestjs/config";
import type { ExtractedEvent } from "../../../packages/domain/src/ingestion";
import { JevClient, type JevFeatureFlag, isJevFeatureEnabled } from "../libs/jev/src";
import {
  rescoreConfidenceWithJev,
  scoreDuplicateWithJev,
  scoreGroundingWithJev,
} from "../apps/workers/validate/src/validation/jev-checks";

const checks: Array<[string, boolean, string?]> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push([name, ok, detail]);
}

async function expectRejects(
  fn: () => Promise<unknown>,
): Promise<{ threw: boolean; message: string }> {
  try {
    await fn();
    return { threw: false, message: "" };
  } catch (error) {
    return {
      threw: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function fakeConfig(flags: Partial<Record<string, boolean>>): ConfigService {
  return {
    get: (key: string) => flags[key],
  } as unknown as ConfigService;
}

// ── Mocked fetch harness, same shape as verify-geocoding.ts's ──────────────
type MockResponse = { status: number; body: unknown } | { status: number; rawBody: string };

function installFetchMock(responses: MockResponse[]): {
  calls: Array<{ url: string; init?: RequestInit }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch call to ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => ("rawBody" in next ? next.rawBody : JSON.stringify(next.body)),
      json: async () => ("rawBody" in next ? JSON.parse(next.rawBody) : next.body),
    } as Response;
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Wraps a `{questions} -> {id: {value, probability}}` answer map as the
 * chat-completions-shaped body `JevClient.ask` expects. */
function chatBody(answers: Record<string, { value: number; probability: number }>) {
  return { choices: [{ message: { content: JSON.stringify(answers) } }] };
}

function client(apiKey?: string): JevClient {
  return new JevClient({
    get: (key: string) => (key === "JEV_API_KEY" ? apiKey : undefined),
  } as unknown as ConfigService);
}

const SAMPLE_EVENT: ExtractedEvent = {
  id: "0-0",
  title: "The Founding of Fixture Village",
  description: "Settlers founded Fixture Village on the valley floor.",
  date: "1850",
  confidence: 0.9,
  sourceText:
    "On a spring morning in 1850, the first settlers raised their flag over what would become Fixture Village.",
  dateText: "1850",
  dateIso: "1850-01-01",
  datePrecision: "year",
  placeName: "Fixture Village",
  anchor: "p.1",
};

async function main(): Promise<void> {
  // ── JevClient.ask / tryAsk ────────────────────────────────────────────
  {
    const disabled = client(undefined);
    check("disabled client reports enabled=false", disabled.enabled === false);
    const result = await expectRejects(() =>
      disabled.ask({ context: "x", questions: [{ id: "q", kind: "noul", prompt: "p" }] }),
    );
    check(
      "ask() on a disabled client throws JevDisabledError",
      result.threw && result.message.includes("not configured"),
      result.message,
    );
    check(
      "tryAsk() on a disabled client returns null, does not throw",
      (await disabled.tryAsk({ context: "x", questions: [{ id: "q", kind: "noul", prompt: "p" }] })) === null,
    );
  }

  {
    const mock = installFetchMock([
      { status: 200, body: chatBody({ q1: { value: 1, probability: 0.9 } }) },
    ]);
    const c = client("test-key");
    const answers = await c.ask({
      context: "ctx",
      questions: [{ id: "q1", kind: "noul", prompt: "is it true?" }],
    });
    check(
      "ask() parses a valid response into a JevAnswer",
      answers.length === 1 && answers[0]?.id === "q1" && answers[0]?.value === 1 && answers[0]?.probability === 0.9,
      JSON.stringify(answers),
    );

    const [call] = mock.calls;
    const sentBody = JSON.parse(String(call?.init?.body));
    check(
      "request carries a Bearer token",
      call?.init?.headers !== undefined &&
        (call.init.headers as Record<string, string>)["Authorization"] === "Bearer test-key",
    );
    check(
      "request's response_format schema requires exactly the given question ids",
      JSON.stringify(sentBody.response_format?.json_schema?.schema?.required) === JSON.stringify(["q1"]),
      JSON.stringify(sentBody.response_format),
    );
    mock.restore();
  }

  {
    // Choice question, max index 2 (3 options) — model answers out of range.
    const mock = installFetchMock([
      { status: 200, body: chatBody({ pick: { value: 99, probability: 1.4 } }) },
    ]);
    const c = client("test-key");
    const answers = await c.ask({
      context: "ctx",
      questions: [{ id: "pick", kind: "choice", prompt: "which?", options: ["a", "b", "c"] }],
    });
    check(
      "an out-of-range choice value is clamped to the last option",
      answers[0]?.value === 2,
      JSON.stringify(answers),
    );
    check(
      "an out-of-range probability is clamped to 1",
      answers[0]?.probability === 1,
      JSON.stringify(answers),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 500, rawBody: "internal error" }]);
    const c = client("test-key");
    const result = await expectRejects(() =>
      c.ask({ context: "ctx", questions: [{ id: "q", kind: "noul", prompt: "p" }] }),
    );
    check("a non-2xx response makes ask() throw", result.threw, result.message);
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 200, rawBody: "not json" }]);
    const c = client("test-key");
    const result = await expectRejects(() =>
      c.ask({ context: "ctx", questions: [{ id: "q", kind: "noul", prompt: "p" }] }),
    );
    check(
      "non-JSON content under strict decoding throws rather than silently returning empty",
      result.threw,
      result.message,
    );
    mock.restore();
  }

  {
    // Response is valid JSON but missing the question id entirely.
    const mock = installFetchMock([
      { status: 200, body: chatBody({ wrongId: { value: 1, probability: 0.5 } }) },
    ]);
    const c = client("test-key");
    const result = await expectRejects(() =>
      c.ask({ context: "ctx", questions: [{ id: "q", kind: "noul", prompt: "p" }] }),
    );
    check(
      "a response missing a requested question id throws (schema validation)",
      result.threw,
      result.message,
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 500, rawBody: "boom" }]);
    const c = client("test-key");
    const answers = await c.tryAsk({
      context: "ctx",
      questions: [{ id: "q", kind: "noul", prompt: "p" }],
    });
    check("tryAsk() swallows a failure and returns null rather than throwing", answers === null);
    mock.restore();
  }

  {
    check(
      "ask() with zero questions short-circuits without calling fetch",
      JSON.stringify(await client("test-key").ask({ context: "ctx", questions: [] })) === "[]",
    );
  }

  // ── isJevFeatureEnabled ───────────────────────────────────────────────
  {
    const enabledClient = client("test-key");
    const disabledClient = client(undefined);
    const flag: JevFeatureFlag = "JEV_GROUNDING_ENABLED";

    check(
      "feature is enabled only when both the flag and credentials are present",
      isJevFeatureEnabled(fakeConfig({ [flag]: true }), enabledClient, flag) === true,
    );
    check(
      "feature stays disabled with the flag on but no credentials",
      isJevFeatureEnabled(fakeConfig({ [flag]: true }), disabledClient, flag) === false,
    );
    check(
      "feature stays disabled with credentials but the flag off",
      isJevFeatureEnabled(fakeConfig({ [flag]: false }), enabledClient, flag) === false,
    );
    check(
      "feature stays disabled with the flag entirely unset",
      isJevFeatureEnabled(fakeConfig({}), enabledClient, flag) === false,
    );
  }

  // ── scoreGroundingWithJev ─────────────────────────────────────────────
  {
    const mock = installFetchMock([
      { status: 200, body: chatBody({ grounded: { value: 1, probability: 0.8 } }) },
    ]);
    const result = await scoreGroundingWithJev(
      client("test-key"),
      fakeConfig({ JEV_GROUNDING_ENABLED: true }),
      SAMPLE_EVENT,
      `Some preamble text. ${SAMPLE_EVENT.sourceText} Some trailing text.`,
    );
    check(
      "grounding check (flag on, Jev says yes) is passed, non-gating",
      result?.name === "grounding-jev" && result.passed === true && result.gating === false,
      JSON.stringify(result),
    );
    mock.restore();
  }

  check(
    "grounding check returns null when the flag is off",
    (await scoreGroundingWithJev(
      client("test-key"),
      fakeConfig({ JEV_GROUNDING_ENABLED: false }),
      SAMPLE_EVENT,
      "some document text",
    )) === null,
  );

  check(
    "grounding check returns null for a too-short sourceText, even with the flag on",
    (await scoreGroundingWithJev(
      client("test-key"),
      fakeConfig({ JEV_GROUNDING_ENABLED: true }),
      { ...SAMPLE_EVENT, sourceText: "too short" },
      "some document text",
    )) === null,
  );

  {
    const mock = installFetchMock([
      { status: 200, body: chatBody({ grounded: { value: 0, probability: 0.95 } }) },
    ]);
    const result = await scoreGroundingWithJev(
      client("test-key"),
      fakeConfig({ JEV_GROUNDING_ENABLED: true }),
      SAMPLE_EVENT,
      "a wholly unrelated document with no connection to the quote at all",
    );
    check(
      "grounding check (Jev says no) is unpassed but still non-gating, with detail",
      result?.passed === false && result.gating === false && Boolean(result.detail),
      JSON.stringify(result),
    );
    mock.restore();
  }

  // ── scoreDuplicateWithJev ─────────────────────────────────────────────
  check(
    "duplicate check returns null with no same-year events seen yet",
    (await scoreDuplicateWithJev(
      client("test-key"),
      fakeConfig({ JEV_DEDUP_SCORING_ENABLED: true }),
      SAMPLE_EVENT,
      [],
    )) === null,
  );

  {
    const priorEvent: ExtractedEvent = {
      ...SAMPLE_EVENT,
      id: "0-1",
      title: "Founding Day Ceremony",
      description: "A ceremony marking the founding of the village.",
    };
    // Jev picks index 0 — the one prior same-year event — not the "none" option.
    const mock = installFetchMock([
      { status: 200, body: chatBody({ match: { value: 0, probability: 0.7 } }) },
    ]);
    const result = await scoreDuplicateWithJev(
      client("test-key"),
      fakeConfig({ JEV_DEDUP_SCORING_ENABLED: true }),
      SAMPLE_EVENT,
      [priorEvent],
    );
    check(
      'duplicate check flags a match by name, not just "failed"',
      result?.name === "duplicate-jev" &&
        result.passed === false &&
        result.gating === false &&
        result.detail?.includes("Founding Day Ceremony") === true,
      JSON.stringify(result),
    );
    mock.restore();
  }

  {
    const priorEvent: ExtractedEvent = { ...SAMPLE_EVENT, id: "0-1", title: "A Wholly Different Event" };
    // Jev picks the "none of the above" option — index equal to pool.length.
    const mock = installFetchMock([
      { status: 200, body: chatBody({ match: { value: 1, probability: 0.9 } }) },
    ]);
    const result = await scoreDuplicateWithJev(
      client("test-key"),
      fakeConfig({ JEV_DEDUP_SCORING_ENABLED: true }),
      SAMPLE_EVENT,
      [priorEvent],
    );
    check(
      '"none of the above" passes, with no detail',
      result?.passed === true && result.detail === undefined,
      JSON.stringify(result),
    );
    mock.restore();
  }

  // ── rescoreConfidenceWithJev ──────────────────────────────────────────
  {
    // tiers = 5 (indices 0-4); index 4 ("very high") => jevConfidence 1.0,
    // matching SAMPLE_EVENT.confidence = 0.9 within the 0.34 agreement band.
    const mock = installFetchMock([
      { status: 200, body: chatBody({ confidence: { value: 4, probability: 0.85 } }) },
    ]);
    const result = await rescoreConfidenceWithJev(
      client("test-key"),
      fakeConfig({ JEV_CONFIDENCE_RESCORE_ENABLED: true }),
      SAMPLE_EVENT,
    );
    check(
      "confidence check agrees when Jev's tier and the self-reported score are close",
      result?.name === "confidence-jev" && result.passed === true && result.gating === false,
      JSON.stringify(result),
    );
    mock.restore();
  }

  {
    // index 0 ("very low") => jevConfidence 0.0, vs self-reported 0.9 — disagrees.
    const mock = installFetchMock([
      { status: 200, body: chatBody({ confidence: { value: 0, probability: 0.6 } }) },
    ]);
    const result = await rescoreConfidenceWithJev(
      client("test-key"),
      fakeConfig({ JEV_CONFIDENCE_RESCORE_ENABLED: true }),
      SAMPLE_EVENT,
    );
    check(
      "confidence check disagrees (but stays non-gating) on a wide gap",
      result?.passed === false && result.gating === false,
      JSON.stringify(result),
    );
    mock.restore();
  }

  check(
    "confidence check returns null when the flag is off",
    (await rescoreConfidenceWithJev(
      client("test-key"),
      fakeConfig({ JEV_CONFIDENCE_RESCORE_ENABLED: false }),
      SAMPLE_EVENT,
    )) === null,
  );

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
    if (!ok) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
