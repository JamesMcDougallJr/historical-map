/**
 * Offline checks on the extraction layer. No API key, no network, no database.
 *
 *   npm run extract:verify --workspace=services/ingest
 *
 * With GROQ_API_KEY set it additionally makes ONE real call, which is the only
 * way to prove the schema is accepted rather than merely well-formed:
 *
 *   GROQ_API_KEY=... npm run extract:verify --workspace=services/ingest -- --live
 *   GROQ_API_KEY=... npm run extract:verify --workspace=services/ingest -- --live --live-file chapter.txt
 */
import { findDates } from "../../../packages/domain/src/dates";
import {
  EXTRACTION_JSON_SCHEMA,
  chunkSegments,
  estimateTokens,
  extractionResponseSchema,
} from "../libs/extraction/src";
import { TokenBucket } from "../libs/extraction/src/groq/token-bucket";

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push([name, ok, detail]);
};

/** Keywords Groq's strict mode rejects outright. */
const FORBIDDEN = [
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "multipleOf",
];

interface SchemaProblem {
  path: string;
  problem: string;
}

/**
 * Walks the schema asserting the strict-mode contract. This exists because a
 * violation is not a degraded result — it is a 400 on every request, and
 * finding that out from a live call costs a round trip and an API key.
 */
function auditStrictSchema(node: unknown, path = "$"): SchemaProblem[] {
  if (typeof node !== "object" || node === null) return [];
  const schema = node as Record<string, unknown>;
  const problems: SchemaProblem[] = [];

  for (const keyword of FORBIDDEN) {
    if (keyword in schema) {
      problems.push({ path, problem: `uses forbidden keyword "${keyword}"` });
    }
  }

  const type = schema["type"];
  const isObject =
    type === "object" || (Array.isArray(type) && type.includes("object"));

  if (isObject) {
    if (schema["additionalProperties"] !== false) {
      problems.push({ path, problem: "missing additionalProperties: false" });
    }
    const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
    const required = (schema["required"] ?? []) as string[];
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) {
        problems.push({
          path,
          problem: `property "${key}" is not in required`,
        });
      }
      problems.push(...auditStrictSchema(properties[key], `${path}.${key}`));
    }
  }

  if (schema["items"]) {
    problems.push(...auditStrictSchema(schema["items"], `${path}[]`));
  }

  return problems;
}

async function main(): Promise<void> {
  // ── Schema ────────────────────────────────────────────────────────────────
  const problems = auditStrictSchema(EXTRACTION_JSON_SCHEMA);
  check(
    "schema satisfies Groq strict-mode rules",
    problems.length === 0,
    problems.map((p) => `${p.path}: ${p.problem}`).join(" | "),
  );

  // The audit must be capable of failing, or it proves nothing.
  const bad = auditStrictSchema({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string", pattern: "x" } },
    required: ["a"],
  });
  check(
    "schema audit detects violations (self-test)",
    bad.length === 3,
    `expected 3 problems, got ${bad.length}`,
  );

  // ── Response validation ───────────────────────────────────────────────────
  const good = extractionResponseSchema.safeParse({
    events: [
      {
        title: "Golden Spike",
        description: "Rails met.",
        dateText: "May 10, 1869",
        dateIso: "1869-05-10",
        datePrecision: "day",
        placeName: "Promontory Summit",
        confidence: 0.95,
        sourceText: "The rails met at Promontory Summit on May 10, 1869.",
        people: ["Leland Stanford"],
      },
    ],
  });
  check("valid response parses", good.success);

  check(
    "imprecise date with null dateIso is accepted",
    extractionResponseSchema.safeParse({
      events: [
        {
          title: "Settlement",
          description: "Settlers arrived.",
          dateText: "sometime in the spring",
          dateIso: null,
          datePrecision: "season",
          placeName: null,
          confidence: 0.4,
          sourceText: "Settlers arrived in the spring.",
          people: [],
        },
      ],
    }).success,
  );

  check(
    "malformed dateIso is rejected",
    !extractionResponseSchema.safeParse({
      events: [
        {
          title: "x",
          description: "x",
          dateText: "1869",
          dateIso: "May 1869",
          datePrecision: "year",
          placeName: null,
          confidence: 0.5,
          sourceText: "x",
          people: [],
        },
      ],
    }).success,
  );

  check(
    "out-of-range confidence is rejected",
    !extractionResponseSchema.safeParse({
      events: [
        {
          title: "x",
          description: "x",
          dateText: "1869",
          dateIso: "1869-01-01",
          datePrecision: "year",
          placeName: null,
          confidence: 4,
          sourceText: "x",
          people: [],
        },
      ],
    }).success,
  );

  // ── Chunker ───────────────────────────────────────────────────────────────
  const pages = Array.from({ length: 10 }, (_, i) => ({
    text: "word ".repeat(200),
    anchor: `p.${i + 1}`,
  }));
  const chunks = chunkSegments(pages, 500);
  check(
    "chunker produces multiple chunks",
    chunks.length > 1,
    `${chunks.length}`,
  );
  check(
    "no chunk splits a segment",
    chunks.every((c) => c.anchors.length >= 1) &&
      chunks.flatMap((c) => c.anchors).length === pages.length,
    `anchors: ${chunks.flatMap((c) => c.anchors).length} vs pages: ${pages.length}`,
  );
  check(
    "chunk indices are sequential from zero",
    chunks.every((c, i) => c.index === i),
  );

  const huge = [{ text: "word ".repeat(5000), anchor: "p.1" }];
  const hugeChunks = chunkSegments(huge, 100);
  check(
    "an oversized single segment is emitted whole, not split",
    hugeChunks.length === 1 && hugeChunks[0]?.anchors.length === 1,
  );
  check("empty input yields no chunks", chunkSegments([], 500).length === 0);

  // ── Date pre-filter ───────────────────────────────────────────────────────
  const dateless =
    "This chapter introduces the themes of settlement and commerce in the region.";
  const dated = "The rails met at Promontory Summit on May 10, 1869.";
  check(
    "pre-filter skips prose with no date",
    !findDates(dateless).some((d) => d.confidence >= 0.5),
  );
  check(
    "pre-filter keeps prose with a date",
    findDates(dated).some((d) => d.confidence >= 0.5),
  );

  // ── Token bucket ──────────────────────────────────────────────────────────
  const bucket = new TokenBucket(1000);
  const t0 = Date.now();
  await bucket.take(400);
  await bucket.take(400);
  check(
    "bucket admits spend under budget without waiting",
    Date.now() - t0 < 100,
  );

  const oversized = new TokenBucket(100);
  const t1 = Date.now();
  await oversized.take(5000); // larger than the whole budget — must not hang
  check(
    "a request larger than the whole budget is not deadlocked",
    Date.now() - t1 < 100,
  );

  check(
    "token estimate is monotonic",
    estimateTokens("ab") < estimateTokens("abcd"),
  );

  // ── Optional live call ────────────────────────────────────────────────────
  if (process.argv.includes("--live")) {
    const key = process.env["GROQ_API_KEY"];
    if (!key) {
      check("live call", false, "--live given but GROQ_API_KEY is unset");
    } else {
      const { GroqExtractionEngine } =
        await import("../libs/extraction/src/groq/groq.engine");
      const engine = new GroqExtractionEngine({
        get: (k: string) => process.env[k],
        getOrThrow: (k: string) => {
          const v = process.env[k];
          if (!v) throw new Error(`${k} is not set`);
          return v;
        },
      } as never);

      // `--live-file <path>` runs a real chapter instead of the one-liner —
      // the plans/22 gate for `people`: does the model actually fill it, or
      // satisfy the strict schema with [] every time?
      const fileIdx = process.argv.indexOf("--live-file");
      const filePath = fileIdx >= 0 ? process.argv[fileIdx + 1] : undefined;
      const text = filePath
        ? (await import("node:fs"))
            .readFileSync(filePath, "utf8")
            .slice(0, 6000)
        : "The transcontinental railroad was completed at Promontory Summit on May 10, 1869, when Leland Stanford drove the last spike. In the spring of 1847, Brigham Young led Mormon pioneers into the Salt Lake Valley.";
      const events = await engine.extractChunk({
        index: 0,
        anchors: ["p.1"],
        text,
      });
      check(
        `live call returned ${events.length} event(s)`,
        events.length >= 1,
        JSON.stringify(
          events.map((e) => [e.title, e.dateText, e.datePrecision, e.people]),
        ),
      );
      const withPeople = events.filter(
        (e) => (e.people ?? []).length > 0,
      ).length;
      console.log(
        `people: ${withPeople}/${events.length} events name at least one person ` +
          `(${events.length ? Math.round((100 * withPeople) / events.length) : 0}%)`,
      );
      if (!filePath) {
        check(
          "live call names people where the text does",
          withPeople >= 1,
          "the sample text names Leland Stanford and Brigham Young",
        );
      }
    }
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${detail && (!ok || process.argv.includes("--live")) ? `  (${detail})` : ""}`,
    );
    if (!ok) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
