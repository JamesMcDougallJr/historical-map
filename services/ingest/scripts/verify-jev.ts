/**
 * Exercises `JevClient` and the Jev-backed validation checks against a
 * mocked `fetch` that speaks TypeSafe's real `/v1/systemone` contract
 * (`answers` keyed by question name; `noul` / `choice`+`probabilities`+
 * `confidence` / `score`+`legend`+`confidence`). No network, no database, no
 * Redis — same spirit as `verify-geocoding.ts` and `verify-extraction.ts`.
 *
 *   npm run jev:verify --workspace=services/ingest
 *
 * This is the fast, every-commit layer. It cannot prove the mock matches the
 * real service — only a real call can — so `--live` makes one (needs
 * `JEV_API_KEY`):
 *
 *   JEV_API_KEY=... npm run jev:verify --workspace=services/ingest -- --live
 *
 * Nor can it catch a Nest DI wiring bug; that is `run-ingestion-fixture.ts`'s
 * `JEV_FIXTURE=1` mode (see `HealthController` for why that failure is real).
 */
import type { ConfigService } from "@nestjs/config";
import type { ExtractedEvent } from "../../../packages/domain/src/ingestion";
import { JevClient, type JevFeatureFlag, choice, isJevFeatureEnabled, noul } from "../libs/jev/src";
import {
  type GroundingInput,
  judgeEventWithJev,
  scoreDuplicateWithJev,
} from "../apps/workers/validate/src/validation/jev-checks";

// Grounding and confidence are one combined request in production; these
// adapters let each be exercised on its own.
const scoreGroundingWithJev = async (
  c: JevClient,
  cfg: ConfigService,
  event: ExtractedEvent,
  input: GroundingInput,
) => (await judgeEventWithJev(c, cfg, event, input)).grounding;

const rescoreConfidenceWithJev = async (c: JevClient, cfg: ConfigService, event: ExtractedEvent) =>
  (await judgeEventWithJev(c, cfg, event, { documentText: "", substringGrounded: true })).confidence;

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

type Env = Partial<Record<string, string | number | boolean>>;

function fakeConfig(env: Env): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

/** A client with credentials and no retries, so failures resolve instantly. */
function client(env: Env = {}): JevClient {
  return new JevClient(fakeConfig({ JEV_API_KEY: "test-key", JEV_MAX_RETRIES: 0, ...env }));
}

// ── Mocked fetch speaking the real /v1/systemone contract ──────────────────
type Mocked = { status: number; body?: unknown; rawBody?: string };

function installFetchMock(responses: Mocked[]): {
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
    return new Response(next.rawBody ?? JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

const USAGE = { input_tokens: 10, output_tokens: 2 };

/** A 200 response wrapping the given `answers` map. */
function ok(answers: Record<string, unknown>): Mocked {
  return { status: 200, body: { model: "jev-latest", answers, usage: USAGE } };
}

const noulAnswer = (p: number) => ({ type: "noul", noul: p });
const choiceAnswer = (label: string, confidence: number, probabilities: Record<string, number>) => ({
  type: "choice",
  choice: label,
  confidence,
  probabilities,
});
const scoreAnswer = (value: number, confidence: number) => ({
  type: "score",
  score: value,
  confidence,
  legend: { "0": "a", "1": "b", "2": "c", "3": "d", "4": "e" },
  probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 },
});

function bodyOf(call: { init?: RequestInit } | undefined): any {
  return JSON.parse(String(call?.init?.body ?? "{}"));
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
  // ── JevClient ─────────────────────────────────────────────────────────
  {
    const disabled = new JevClient(fakeConfig({}));
    check("a client with no JEV_API_KEY reports enabled=false", disabled.enabled === false);
    const q = { q: noul("p") };
    const result = await expectRejects(() => disabled.ask("x", q));
    check(
      "ask() on a disabled client throws JevDisabledError",
      result.threw && result.message.includes("not configured"),
      result.message,
    );
    check("tryAsk() on a disabled client returns null", (await disabled.tryAsk("x", q)) === null);
  }

  {
    const mock = installFetchMock([ok({ q1: noulAnswer(0.9) })]);
    const answers = await client().ask("some state", {
      q1: noul("is it true?", { true: "yes", false: "no" }),
    });
    check(
      "ask() returns the typed noul answer",
      answers.q1.noul === 0.9 && answers.q1.type === "noul",
      JSON.stringify(answers),
    );

    const [call] = mock.calls;
    const body = bodyOf(call);
    check(
      "request goes to POST /v1/systemone",
      call?.url.endsWith("/v1/systemone") === true && call.init?.method === "POST",
      call?.url,
    );
    check(
      "request carries a Bearer token",
      new Headers(call?.init?.headers).get("authorization") === "Bearer test-key",
    );
    check(
      "request body is {model, state, questions} with the real question shape",
      body.model === "jev-latest" &&
        body.state === "some state" &&
        body.questions?.q1?.type === "noul" &&
        body.questions.q1.instructions === "is it true?" &&
        body.questions.q1.criteria?.true === "yes",
      JSON.stringify(body),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([
      ok({
        pick: choiceAnswer("b", 0.8, { a: 0.1, b: 0.85, c: 0.05 }),
        rate: scoreAnswer(3.6, 0.7),
      }),
    ]);
    const answers = await client().ask(
      { s: 1 },
      {
        pick: choice("which?", { a: "first", b: "second", c: "third" }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rate: { type: "score", instructions: "how good?", criteria: ["x", "y", "z", "w", "v"] } as const,
      },
    );
    check(
      "choice answers expose the label, confidence and probabilities",
      answers.pick.choice === "b" && answers.pick.confidence === 0.8 && answers.pick.probabilities.b === 0.85,
      JSON.stringify(answers.pick),
    );
    check(
      "score answers expose the expected score and confidence",
      answers.rate.score === 3.6 && answers.rate.confidence === 0.7,
      JSON.stringify(answers.rate),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([]);
    const answers = await client().ask("state", {});
    check(
      "ask() with zero questions short-circuits without calling fetch",
      Object.keys(answers).length === 0 && mock.calls.length === 0,
    );
    mock.restore();
  }

  for (const status of [401, 422, 429, 500, 529]) {
    const mock = installFetchMock([{ status, body: { error: "nope" } }]);
    const answers = await client().tryAsk("x", { q: noul("p") });
    check(`tryAsk() swallows an HTTP ${status} and returns null`, answers === null);
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 200, rawBody: "not json at all" }]);
    const answers = await client().tryAsk("x", { q: noul("p") });
    check("tryAsk() swallows a non-JSON 200 and returns null", answers === null);
    mock.restore();
  }

  {
    const mock = installFetchMock([ok({ someOtherName: noulAnswer(0.5) })]);
    const answers = await client().tryAsk("x", { q: noul("p") });
    check("tryAsk() returns null when a requested answer is missing from the response", answers === null);
    mock.restore();
  }

  {
    const mock = installFetchMock([ok({ q: choiceAnswer("a", 0.9, { a: 1 }) })]);
    const answers = await client().tryAsk("x", { q: noul("p") });
    check("tryAsk() returns null when an answer has the wrong type", answers === null);
    mock.restore();
  }

  {
    // JEV_MAX_RETRIES=1: a 500 then a 200 should succeed on the retry.
    const mock = installFetchMock([{ status: 500, body: {} }, ok({ q: noulAnswer(0.4) })]);
    const answers = await client({ JEV_MAX_RETRIES: 1 }).tryAsk("x", { q: noul("p") });
    check(
      "a retryable failure is retried once when JEV_MAX_RETRIES=1",
      answers?.q.noul === 0.4 && mock.calls.length === 2,
      `calls=${mock.calls.length}`,
    );
    mock.restore();
  }

  // ── isJevFeatureEnabled ───────────────────────────────────────────────
  {
    const flag: JevFeatureFlag = "JEV_GROUNDING_ENABLED";
    const enabled = client();
    const noKey = new JevClient(fakeConfig({}));
    check(
      "feature is enabled only when both the flag and credentials are present",
      isJevFeatureEnabled(fakeConfig({ [flag]: true }), enabled, flag) === true,
    );
    check(
      "feature stays disabled with the flag on but no credentials",
      isJevFeatureEnabled(fakeConfig({ [flag]: true }), noKey, flag) === false,
    );
    check(
      "feature stays disabled with credentials but the flag off",
      isJevFeatureEnabled(fakeConfig({ [flag]: false }), enabled, flag) === false,
    );
    check(
      "feature stays disabled with the flag entirely unset",
      isJevFeatureEnabled(fakeConfig({}), enabled, flag) === false,
    );
  }

  // ── scoreGroundingWithJev ─────────────────────────────────────────────
  const GROUNDING_ON = fakeConfig({ JEV_GROUNDING_ENABLED: true });
  const gated = (min: number) => fakeConfig({ JEV_GROUNDING_ENABLED: true, JEV_GROUNDING_MIN_SUPPORT: min });
  const MISS = { documentText: "some document text", substringGrounded: false };

  /** A relation answer whose label is the argmax of the given probabilities. */
  const relation = (supports: number, contradicts: number, says_nothing: number) => {
    const probabilities = { supports, contradicts, says_nothing };
    const label = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ["supports"])[0];
    return { relation: choiceAnswer(label, 0.8, probabilities) };
  };

  {
    const mock = installFetchMock([]);
    const result = await scoreGroundingWithJev(client(), gated(0.8), SAMPLE_EVENT, {
      ...MISS,
      substringGrounded: true,
    });
    check(
      "an exact-match quote is never sent to Jev (no check, zero calls)",
      result === null && mock.calls.length === 0,
      `calls=${mock.calls.length}`,
    );
    mock.restore();
  }

  check(
    "grounding returns null when the flag is off",
    (await scoreGroundingWithJev(client(), fakeConfig({}), SAMPLE_EVENT, MISS)) === null,
  );
  check(
    "grounding returns null for a too-short sourceText, even with the flag on",
    (await scoreGroundingWithJev(client(), GROUNDING_ON, { ...SAMPLE_EVENT, sourceText: "short" }, MISS)) === null,
  );
  check(
    "grounding returns null with no document text",
    (await scoreGroundingWithJev(client(), GROUNDING_ON, SAMPLE_EVENT, { ...MISS, documentText: "" })) === null,
  );

  {
    const mock = installFetchMock([ok(relation(0.8, 0.05, 0.15))]);
    const result = await scoreGroundingWithJev(client(), GROUNDING_ON, SAMPLE_EVENT, MISS);
    check(
      "a substring miss Jev supports passes, recorded and non-gating at the default knob",
      result?.name === "grounding-jev" && result.passed === true && result.gating === false,
      JSON.stringify(result),
    );
    const body = bodyOf(mock.calls[0]);
    check(
      "grounding asks a three-way choice with the quote as the claim",
      body.questions?.relation?.type === "choice" &&
        Object.keys(body.questions.relation.criteria).join(",") === "supports,contradicts,says_nothing" &&
        body.state?.claim === SAMPLE_EVENT.sourceText,
      JSON.stringify(body.questions?.relation?.criteria && Object.keys(body.questions.relation.criteria)),
    );
    check(
      "the recorded detail carries all three probabilities and the confidence",
      /supports=0\.80 contradicts=0\.05 says_nothing=0\.15 \(confidence 0\.80\)/.test(result?.detail ?? ""),
      result?.detail,
    );
    mock.restore();
  }

  {
    // Default knob (0): a clear "contradicts" is reported failed, but cannot gate.
    const mock = installFetchMock([ok(relation(0.05, 0.9, 0.05))]);
    const result = await scoreGroundingWithJev(client(), GROUNDING_ON, SAMPLE_EVENT, MISS);
    check(
      "at the default knob 0 a contradicted quote is reported failed but never gates",
      result?.passed === false && result.gating === false,
      JSON.stringify(result),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([ok(relation(0.6, 0.2, 0.2))]);
    const result = await scoreGroundingWithJev(client(), gated(0.8), SAMPLE_EVENT, MISS);
    check(
      "with the knob at 0.8, P(supports)=0.6 fails the gate",
      result?.passed === false && result.gating === true,
      JSON.stringify(result),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([ok(relation(0.9, 0.05, 0.05))]);
    const result = await scoreGroundingWithJev(client(), gated(0.8), SAMPLE_EVENT, MISS);
    check(
      "with the knob at 0.8, P(supports)=0.9 passes the (active) gate",
      result?.passed === true && result.gating === true,
      JSON.stringify(result),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([ok(relation(0.5, 0.25, 0.25))]);
    const result = await scoreGroundingWithJev(client(), gated(0.5), SAMPLE_EVENT, MISS);
    check("the knob is inclusive: P(supports) exactly at the knob passes", result?.passed === true, JSON.stringify(result));
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 500, body: {} }]);
    const result = await scoreGroundingWithJev(client(), gated(0.8), SAMPLE_EVENT, MISS);
    check("a Jev outage returns null even with the gate active (fails open, never holds)", result === null);
    mock.restore();
  }

  {
    // Segment selection. The quote's opening words land in segment 2, so it and
    // its neighbours (1, 3) are sent — not the distant 0 or 4.
    const segments = [
      "alpha zero",
      "beta one",
      `${SAMPLE_EVENT.sourceText.slice(0, 60)} and more`,
      "delta three",
      "epsilon four",
    ].map((text, i) => ({ text, anchor: `p.${i}` }));
    const mock = installFetchMock([ok(relation(0.8, 0.1, 0.1))]);
    await scoreGroundingWithJev(client(), GROUNDING_ON, SAMPLE_EVENT, { ...MISS, segments });
    const section = String(bodyOf(mock.calls[0]).state?.section);
    check(
      "the section is the segment holding the quote's opening words plus its neighbours",
      section.includes("beta one") &&
        section.includes("and more") &&
        section.includes("delta three") &&
        !section.includes("alpha zero") &&
        !section.includes("epsilon four"),
      section,
    );
    mock.restore();
  }

  {
    // A paraphrased quote matches nothing, so fall back to the anchor segment
    // plus the next two.
    const segments = ["alpha zero", "beta one", "gamma two", "delta three", "epsilon four"].map((text, i) => ({
      text,
      anchor: `p.${i}`,
    }));
    const mock = installFetchMock([ok(relation(0.8, 0.1, 0.1))]);
    await scoreGroundingWithJev(
      client(),
      GROUNDING_ON,
      { ...SAMPLE_EVENT, sourceText: "A paraphrase that appears nowhere in the document text.", anchor: "p.1" },
      { ...MISS, segments },
    );
    const section = String(bodyOf(mock.calls[0]).state?.section);
    check(
      "an unlocatable quote falls back to the anchor segment plus the next two",
      section.includes("beta one") &&
        section.includes("gamma two") &&
        section.includes("delta three") &&
        !section.includes("alpha zero") &&
        !section.includes("epsilon four"),
      section,
    );
    mock.restore();
  }

  // ── scoreDuplicateWithJev ─────────────────────────────────────────────
  const DEDUP_ON = fakeConfig({ JEV_DEDUP_SCORING_ENABLED: true });
  check(
    "duplicate returns null with no same-year events seen yet",
    (await scoreDuplicateWithJev(client(), DEDUP_ON, SAMPLE_EVENT, [])) === null,
  );

  {
    const prior: ExtractedEvent = {
      ...SAMPLE_EVENT,
      id: "0-1",
      title: "Founding Day Ceremony",
      description: "A ceremony marking the founding of the village.",
    };
    const mock = installFetchMock([
      ok({ match: choiceAnswer("event_0", 0.7, { event_0: 0.8, none: 0.2 }) }),
    ]);
    const result = await scoreDuplicateWithJev(client(), DEDUP_ON, SAMPLE_EVENT, [prior]);
    check(
      "duplicate flags a match by title, non-gating, not merged",
      result?.name === "duplicate-jev" &&
        result.passed === false &&
        result.gating === false &&
        result.detail?.includes("Founding Day Ceremony") === true,
      JSON.stringify(result),
    );
    const criteria = bodyOf(mock.calls[0]).questions?.match?.criteria ?? {};
    check(
      "duplicate offers each prior event plus a 'none' outcome as choice criteria",
      Object.keys(criteria).join(",") === "event_0,none",
      Object.keys(criteria).join(","),
    );
    mock.restore();
  }

  {
    const prior: ExtractedEvent = { ...SAMPLE_EVENT, id: "0-1", title: "A Wholly Different Event" };
    const mock = installFetchMock([ok({ match: choiceAnswer("none", 0.9, { event_0: 0.05, none: 0.95 }) })]);
    const result = await scoreDuplicateWithJev(client(), DEDUP_ON, SAMPLE_EVENT, [prior]);
    check("'none' passes, with no detail", result?.passed === true && result.detail === undefined, JSON.stringify(result));
    mock.restore();
  }

  // ── rescoreConfidenceWithJev ──────────────────────────────────────────
  const CONF_ON = fakeConfig({ JEV_CONFIDENCE_RESCORE_ENABLED: true });
  {
    const mock = installFetchMock([ok({ confidence: scoreAnswer(4, 0.85) })]);
    const result = await rescoreConfidenceWithJev(client(), CONF_ON, SAMPLE_EVENT);
    check(
      "confidence at level 4 substantiates the event; recorded, non-gating",
      result?.name === "confidence-jev" && result.passed === true && result.gating === false,
      JSON.stringify(result),
    );
    check(
      "confidence detail records the score, Jev's confidence and the self-reported value",
      /jev score=4\.0\/4 \(confidence 0\.85\) vs self-reported 0\.9/.test(result?.detail ?? ""),
      result?.detail,
    );

    const sent = bodyOf(mock.calls[0]);
    check(
      "the self-reported confidence is NOT in the state sent to Jev (independence)",
      !JSON.stringify(sent.state).includes("0.9") && !("extraction_self_reported_confidence" in sent.state),
      JSON.stringify(sent.state),
    );
    const levels = sent.questions?.confidence?.criteria ?? [];
    check(
      "the rubric is five concrete situations, not adjectives",
      sent.questions?.confidence?.type === "score" &&
        levels.length === 5 &&
        levels.every((l: string) => l.length > 30),
      JSON.stringify(levels).slice(0, 120),
    );
    mock.restore();
  }
  {
    const mock = installFetchMock([ok({ confidence: scoreAnswer(0, 0.6) })]);
    const result = await rescoreConfidenceWithJev(client(), CONF_ON, SAMPLE_EVENT);
    check(
      "confidence at level 0 does not substantiate the event, still non-gating",
      result?.passed === false && result.gating === false,
      JSON.stringify(result),
    );
    mock.restore();
  }
  check(
    "confidence returns null when the flag is off",
    (await rescoreConfidenceWithJev(client(), fakeConfig({}), SAMPLE_EVENT)) === null,
  );

  // ── judgeEventWithJev: one request per event ──────────────────────────
  const BOTH_ON = fakeConfig({ JEV_GROUNDING_ENABLED: true, JEV_CONFIDENCE_RESCORE_ENABLED: true });
  {
    const mock = installFetchMock([ok({ ...relation(0.9, 0.05, 0.05), confidence: scoreAnswer(3, 0.8) })]);
    const { grounding, confidence } = await judgeEventWithJev(client(), BOTH_ON, SAMPLE_EVENT, MISS);
    const asked = Object.keys(bodyOf(mock.calls[0]).questions ?? {}).join(",");
    check(
      "grounding and confidence share a single request carrying both questions",
      mock.calls.length === 1 && asked === "relation,confidence" && grounding !== null && confidence !== null,
      `calls=${mock.calls.length} asked=${asked}`,
    );
    mock.restore();
  }
  {
    const mock = installFetchMock([ok({ confidence: scoreAnswer(3, 0.8) })]);
    const { grounding, confidence } = await judgeEventWithJev(client(), BOTH_ON, SAMPLE_EVENT, {
      ...MISS,
      substringGrounded: true,
    });
    const asked = Object.keys(bodyOf(mock.calls[0]).questions ?? {}).join(",");
    check(
      "an exact-match quote drops only the grounding question; confidence still goes",
      asked === "confidence" && grounding === null && confidence !== null,
      `asked=${asked}`,
    );
    mock.restore();
  }
  {
    const mock = installFetchMock([]);
    const out = await judgeEventWithJev(client(), fakeConfig({}), SAMPLE_EVENT, MISS);
    check(
      "with both flags off no request is made and both results are null",
      out.grounding === null && out.confidence === null && mock.calls.length === 0,
      `calls=${mock.calls.length}`,
    );
    mock.restore();
  }
  {
    const mock = installFetchMock([{ status: 500, body: {} }]);
    const out = await judgeEventWithJev(client(), BOTH_ON, SAMPLE_EVENT, MISS);
    check("a failed combined request nulls both results (nothing appended)", out.grounding === null && out.confidence === null);
    mock.restore();
  }

  // ── Optional live call ────────────────────────────────────────────────
  // The mocks above encode OUR reading of the contract; this is the only
  // check that proves the real service agrees with it.
  if (process.argv.includes("--live")) {
    const key = process.env["JEV_API_KEY"];
    if (!key) {
      check("live: JEV_API_KEY is set", false, "set JEV_API_KEY to run --live");
    } else {
      const live = new JevClient(fakeConfig({ JEV_API_KEY: key }));
      const answers = await live.tryAsk(
        { quote: "The settlers founded the village in 1850.", excerpt: "In 1850 settlers founded the village." },
        {
          grounded: noul("Does the excerpt support the quote?"),
          kind: choice("Is this about a founding or a battle?", { founding: null, battle: null }),
        },
      );
      check("live: a real noul answer is a probability in [0,1]", answers !== null && answers.grounded.noul >= 0 && answers.grounded.noul <= 1, JSON.stringify(answers));
      check("live: a real choice answer is one of the offered labels", answers?.kind.choice === "founding" || answers?.kind.choice === "battle", JSON.stringify(answers?.kind));
    }
  }

  let failed = 0;
  for (const [name, passed, detail] of checks) {
    console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail && (!passed || process.argv.includes("--live")) ? `  (${detail})` : ""}`);
    if (!passed) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
