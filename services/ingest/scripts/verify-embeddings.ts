/**
 * Checks on the embedding layer (plans/23-search-semantic.md, "`EmbeddingEngine`
 * contract"). Offline by default — no AWS, no network, no database — and run in CI:
 *
 *   npm run embed:verify --workspace=services/ingest
 *
 * `--live` adds the real Bedrock checks. It is run by `bedrock-live.yml` under
 * the CI OIDC role, not by hand: its "other models are denied" check proves
 * the role's policy is one-model, and passes only under that role (an admin or
 * root credential can invoke anything, so it fails there — correctly).
 *
 *   BEDROCK_REGION=us-west-2 npm run embed:verify --workspace=services/ingest -- --live
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BedrockEmbeddingEngine,
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingError,
  FakeEmbeddingEngine,
  classifyEmbeddingError,
  vectorNorm,
  type RecordedVectors,
} from "../libs/embedding/src";

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push([name, ok, detail]);
};

/** ‖v‖ = 1 ± 1e-3 (plan 23, row 5). */
const isUnit = (v: number[]): boolean => Math.abs(vectorNorm(v) - 1) < 1e-3;

/** What the AWS SDK v3 throws, minus the class: a name and HTTP metadata. */
function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(`${name} from the stub`), {
    name,
    $metadata: { httpStatusCode },
  });
}

/** A deterministic unit vector, so the offline checks need no recording. */
function unitVector(seed: number, dims = DEFAULT_EMBEDDING_DIMS): number[] {
  const raw = Array.from({ length: dims }, (_, i) => Math.sin(seed * 31 + i));
  const norm = vectorNorm(raw);
  return raw.map((x) => x / norm);
}

async function offline(): Promise<void> {
  // ── Error classification (plan 12) ─────────────────────────────────────
  const cases: Array<[string, unknown, boolean]> = [
    ["ThrottlingException", awsError("ThrottlingException", 429), true],
    [
      "ServiceUnavailableException",
      awsError("ServiceUnavailableException", 503),
      true,
    ],
    ["ModelNotReadyException", awsError("ModelNotReadyException", 429), true],
    ["ValidationException", awsError("ValidationException", 400), false],
    ["AccessDeniedException", awsError("AccessDeniedException", 403), false],
    [
      "ResourceNotFoundException",
      awsError("ResourceNotFoundException", 404),
      false,
    ],
    ["an unknown error", new Error("something nobody has seen"), false],
    [
      "a socket reset",
      Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      true,
    ],
  ];
  for (const [label, error, retryable] of cases) {
    const classified = classifyEmbeddingError(error);
    check(
      `${label} → ${retryable ? "retryable" : "not retryable"}`,
      classified.retryable === retryable,
      `got retryable=${classified.retryable}, code=${classified.code}`,
    );
  }

  // ── Bedrock engine retry behaviour, against a stubbed client ───────────
  const attemptsFor = async (
    error: Error,
    maxRetries: number,
  ): Promise<{ attempts: number; thrown?: EmbeddingError }> => {
    const engine = new BedrockEmbeddingEngine({
      region: "us-west-2",
      maxRetries,
    });
    let attempts = 0;
    (
      engine as unknown as { client: { send: () => Promise<never> } }
    ).client.send = async () => {
      attempts++;
      throw error;
    };
    try {
      await engine.embed(["x"]);
      return { attempts };
    } catch (thrown) {
      return { attempts, thrown: thrown as EmbeddingError };
    }
  };
  const throttled = await attemptsFor(awsError("ThrottlingException", 429), 2);
  check(
    "worker path: throttling is retried, then surfaces classified",
    throttled.attempts === 3 && throttled.thrown?.retryable === true,
    `attempts=${throttled.attempts}`,
  );
  const invalid = await attemptsFor(awsError("ValidationException", 400), 2);
  check(
    "worker path: a validation error is never retried",
    invalid.attempts === 1 && invalid.thrown?.retryable === false,
    `attempts=${invalid.attempts}`,
  );
  const interactive = await attemptsFor(
    awsError("ThrottlingException", 429),
    0,
  );
  check(
    "interactive path (maxRetries 0): throttling is not retried",
    interactive.attempts === 1,
    `attempts=${interactive.attempts}`,
  );

  // ── Fake engine ────────────────────────────────────────────────────────
  const fake = new FakeEmbeddingEngine({
    model: DEFAULT_EMBEDDING_MODEL,
    dims: DEFAULT_EMBEDDING_DIMS,
    vectors: {
      "Overthrow of Tula": unitVector(1),
      "Toltec collapse": unitVector(2),
    },
  });
  const [a, b] = await fake.embed(["Overthrow of Tula", "Toltec collapse"]);
  check(
    "fake: returns recorded vectors, in input order",
    a.length === DEFAULT_EMBEDDING_DIMS &&
      b.length === DEFAULT_EMBEDDING_DIMS &&
      a !== b,
  );
  check(
    "fake: counts calls and records what it was sent",
    fake.calls === 1 &&
      fake.received.join("|") === "Overthrow of Tula|Toltec collapse",
  );
  let missing: unknown;
  try {
    await fake.embed(["Napoleon's coronation"]);
  } catch (error) {
    missing = error;
  }
  check(
    "fake: throws on unrecorded text, naming it",
    missing instanceof EmbeddingError &&
      missing.message.includes("Napoleon's coronation"),
    String(missing),
  );

  // ── The recorded file, once it exists (fixtures arrive with steps 3–5) ─
  const recordedPath = join(
    __dirname,
    "..",
    "..",
    "..",
    "e2e-real",
    "fixtures",
    "search-vectors.json",
  );
  if (existsSync(recordedPath)) {
    const recorded = JSON.parse(
      readFileSync(recordedPath, "utf8"),
    ) as RecordedVectors;
    const entries = Object.entries(recorded.vectors);
    const bad = entries.filter(
      ([, v]) => v.length !== recorded.dims || !isUnit(v),
    );
    check(
      `search-vectors.json: all ${entries.length} vectors have ${recorded.dims} dims and unit length`,
      entries.length > 0 && bad.length === 0,
      bad.map(([text]) => text).join(", "),
    );
    check(
      "search-vectors.json: recorded with the configured model and dims",
      recorded.model === DEFAULT_EMBEDDING_MODEL &&
        recorded.dims === DEFAULT_EMBEDDING_DIMS,
      `${recorded.model} / ${recorded.dims}`,
    );
  } else {
    console.log("SKIP  search-vectors.json not recorded yet");
  }
}

async function live(): Promise<void> {
  const engine = BedrockEmbeddingEngine.fromEnv();
  const started = Date.now();
  const [vector] = await engine.embed(["Overthrow of Tula"]);
  const latencyMs = Date.now() - started;
  check(
    `live: ${engine.model} returns ${engine.dims} dims`,
    vector.length === engine.dims,
    `got ${vector.length}`,
  );
  check(
    "live: the vector is unit length",
    isUnit(vector),
    `‖v‖ = ${vectorNorm(vector)}`,
  );
  console.log(`INFO  live round trip: ${latencyMs} ms`);

  // Proves the policy is one-model: anything else must be refused by IAM.
  const other = new BedrockEmbeddingEngine({
    region: process.env["BEDROCK_REGION"] ?? "us-west-2",
    model: "cohere.embed-english-v3",
    maxRetries: 0,
  });
  let denied: EmbeddingError | undefined;
  try {
    await other.embed(["Overthrow of Tula"]);
  } catch (error) {
    denied = classifyEmbeddingError(error);
  }
  check(
    "live: a model the role isn't granted is denied",
    denied?.code === "AccessDeniedException",
    denied
      ? denied.message
      : "the call succeeded — this credential is not limited to one model",
  );

  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    appendFileSync(
      summary,
      `### Bedrock live check\n\n| model | dims | ‖v‖ | latency |\n|---|---|---|---|\n` +
        `| ${engine.model} | ${vector.length} | ${vectorNorm(vector).toFixed(4)} | ${latencyMs} ms |\n`,
    );
  }
}

async function main(): Promise<void> {
  await offline();
  if (process.argv.includes("--live")) await live();

  for (const [name, ok, detail] of checks) {
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`,
    );
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
