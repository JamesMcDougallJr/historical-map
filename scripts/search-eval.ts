/**
 * Ranking evaluation over the golden set (plans/19 "The golden set",
 * plans/23 "Evaluation"): recall@5 and MRR for lexical, vector-only and hybrid,
 * side by side. For decisions — the ship gate, the vector floor — not gating;
 * the pass/fail gate is search-golden.spec.ts.
 *
 *   POSTGRES_URL=... npm run search:eval                # recorded vectors (fake)
 *   POSTGRES_URL=... npm run search:eval -- --floor     # + candidate floors
 *   POSTGRES_URL=... BEDROCK_REGION=us-west-2 npm run search:eval -- --live
 *
 * Needs a database seeded with the search fixtures and embedded (e2e-real's
 * global setup does both). `--live` embeds queries with Bedrock instead of
 * the recorded vectors, for a real corpus.
 */
import type { SearchHit, SearchKind } from "@historical-map/domain";
import {
  FLOOR_NEGATIVE_QUERIES,
  GOLDEN_QUERIES,
  type GoldenQuery,
} from "../e2e-real/fixtures/golden-queries";
import { sqlClient } from "../lib/postgres-storage";
import {
  parseSearchRequest,
  search,
  searchVectorOnly,
  VECTOR_MIN_SIMILARITY,
  type SearchRequest,
} from "../lib/search";

if (!process.argv.includes("--live"))
  process.env["EMBEDDING_ENGINE"] ??= "fake";

type Mode = "lexical" | "vector" | "hybrid";
const MODES: Mode[] = ["lexical", "vector", "hybrid"];

function request(g: GoldenQuery | { q: string }, mode: Mode): SearchRequest {
  const params = new URLSearchParams({
    q: g.q,
    mode: mode === "lexical" ? "lexical" : "hybrid",
  });
  if ("timeline" in g && g.timeline) {
    params.set("from", String(g.timeline[0]));
    params.set("to", String(g.timeline[1]));
  }
  if ("kinds" in g && g.kinds) params.set("kinds", g.kinds.join(","));
  return parseSearchRequest(params);
}

async function hits(
  req: SearchRequest,
  mode: Mode,
  floor = VECTOR_MIN_SIMILARITY,
): Promise<SearchHit[]> {
  if (mode === "vector") return (await searchVectorOnly(req, floor)) ?? [];
  return (await search(req)).hits;
}

/** Each kind's own first five — the response is grouped by kind. */
function top5(list: SearchHit[]): Set<string> {
  const seen = new Map<SearchKind, number>();
  const out = new Set<string>();
  for (const h of list) {
    const n = seen.get(h.kind) ?? 0;
    if (n < 5) out.add(`${h.kind}:${h.id}`);
    seen.set(h.kind, n + 1);
  }
  return out;
}

/** 1 / rank of `target` within its kind's list, 0 when absent. */
function reciprocalRank(list: SearchHit[], target: string): number {
  const kind = target.split(":", 1)[0];
  const ofKind = list
    .filter((h) => h.kind === kind)
    .map((h) => `${h.kind}:${h.id}`);
  const i = ofKind.indexOf(target);
  return i < 0 ? 0 : 1 / (i + 1);
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

async function evaluate(): Promise<void> {
  const scores: Record<
    Mode,
    { recall: number[]; mrr: number[]; lexMrr: number[] }
  > = {
    lexical: { recall: [], mrr: [], lexMrr: [] },
    vector: { recall: [], mrr: [], lexMrr: [] },
    hybrid: { recall: [], mrr: [], lexMrr: [] },
  };
  const latencies: number[] = [];

  for (const g of GOLDEN_QUERIES) {
    const target = g.expect.top1 ?? g.expect.inTop5[0];
    for (const mode of MODES) {
      const started = Date.now();
      const list = await hits(request(g, mode), mode);
      if (mode === "vector") latencies.push(Date.now() - started);
      const found = top5(list);
      const recall =
        g.expect.inTop5.filter((id) => found.has(id)).length /
        Math.max(1, g.expect.inTop5.length);
      const rr = target ? reciprocalRank(list, target) : 0;
      scores[mode].recall.push(recall);
      scores[mode].mrr.push(rr);
      if (g.mode === "lexical") scores[mode].lexMrr.push(rr);
    }
  }

  console.log(
    `Golden set: ${GOLDEN_QUERIES.length} queries (${GOLDEN_QUERIES.filter((g) => g.mode === "lexical").length} lexical, ${GOLDEN_QUERIES.filter((g) => g.mode === "hybrid").length} hybrid)\n`,
  );
  console.log("mode      recall@5   MRR      MRR (lexical entries)");
  for (const mode of MODES) {
    const s = scores[mode];
    console.log(
      `${mode.padEnd(9)} ${pct(mean(s.recall)).padStart(8)}   ${mean(s.mrr).toFixed(3).padStart(5)}    ${mean(s.lexMrr).toFixed(3)}`,
    );
  }
  const h = scores.hybrid;
  const l = scores.lexical;
  const gate =
    mean(h.recall) >= mean(l.recall) && mean(h.lexMrr) >= mean(l.lexMrr);
  console.log(
    `\nShip gate (hybrid recall@5 ≥ lexical, and MRR on lexical entries not lower): ${gate ? "PASS" : "FAIL"}`,
  );

  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const [counts] = await sqlClient()<
    { events: number; groups: number; passages: number }[]
  >`
    SELECT (SELECT count(*) FROM event_embeddings)::int AS events,
           (SELECT count(*) FROM event_group_embeddings)::int AS groups,
           (SELECT count(*) FROM document_passages WHERE embedding IS NOT NULL)::int AS passages`;
  console.log(
    `Vector arm: p50 ${p(0.5)} ms, p95 ${p(0.95)} ms over ${counts!.events} event, ${counts!.groups} sequence and ${counts!.passages} passage vectors (exact scan; index at ~50k rows or p95 > 50 ms).`,
  );
}

/**
 * Candidate floors: how many hybrid golden expectations the vector arm still
 * finds, against how many `meaning` hits the negative queries get. The floor
 * belongs where the first stays whole and the second is zero.
 */
async function floorSweep(): Promise<void> {
  const positives = GOLDEN_QUERIES.filter((g) => g.mode === "hybrid");
  const expected = positives.reduce((n, g) => n + g.expect.inTop5.length, 0);
  console.log(
    `\nFloor sweep — ${expected} hybrid expectations, ${FLOOR_NEGATIVE_QUERIES.length} negative queries`,
  );
  console.log("floor   found by vector arm   negative meaning hits");
  for (let t = 0.15; t <= 0.4501; t += 0.025) {
    let found = 0;
    for (const g of positives) {
      const set = top5(await hits(request(g, "vector"), "vector", t));
      found += g.expect.inTop5.filter((id) => set.has(id)).length;
    }
    let negatives = 0;
    for (const q of FLOOR_NEGATIVE_QUERIES) {
      negatives += (await hits(request({ q }, "vector"), "vector", t)).length;
    }
    const mark =
      Math.abs(t - VECTOR_MIN_SIMILARITY) < 1e-9 ? "  ← current" : "";
    console.log(
      `${t.toFixed(3)}   ${`${found}/${expected}`.padStart(8)}              ${String(negatives).padStart(4)}${mark}`,
    );
  }
}

async function main(): Promise<void> {
  if (!process.env["POSTGRES_URL"]) throw new Error("Set POSTGRES_URL.");
  await evaluate();
  if (process.argv.includes("--floor")) await floorSweep();
  await sqlClient().end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
