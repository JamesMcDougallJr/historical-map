import { test, expect } from "@playwright/test";
import type { SearchResponse } from "../../../app/map/types";
import { GOLDEN_QUERIES } from "../../fixtures/golden-queries";

// One test per lexical entry in golden-queries.ts — ranking *quality*, kept
// apart from search.spec.ts (features) so a failure says which kind it is.

const HEADERS = { "x-api-key": "test-api-key" };

for (const g of GOLDEN_QUERIES.filter((g) => g.mode === "lexical")) {
  const label = `${JSON.stringify(g.q)}${g.timeline ? ` [${g.timeline.join("–")}]` : ""}${g.kinds ? ` kinds=${g.kinds}` : ""}`;

  test(`golden: ${label}`, async ({ request }) => {
    const params = new URLSearchParams({ q: g.q, mode: g.mode });
    if (g.timeline) {
      params.set("from", String(g.timeline[0]));
      params.set("to", String(g.timeline[1]));
    }
    if (g.kinds) params.set("kinds", g.kinds.join(","));

    const res = await request.get(`/api/search?${params}`, {
      headers: HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SearchResponse;
    const keys = body.hits.map((h) => `${h.kind}:${h.id}`);

    // "Top 5" per kind: the response is grouped, so each kind's own ranking
    // is what a user sees as its first five.
    const top5 = new Set<string>();
    const seen = new Map<string, number>();
    for (const h of body.hits) {
      const n = seen.get(h.kind) ?? 0;
      if (n < 5) top5.add(`${h.kind}:${h.id}`);
      seen.set(h.kind, n + 1);
    }

    if (g.expect.top1) {
      const top = body.topHit
        ? `${body.topHit.kind}:${body.topHit.id}`
        : keys.find((k) => k.startsWith("event:"));
      expect(top, `top hit for ${label}; got ${keys.join(", ")}`).toBe(
        g.expect.top1,
      );
    }
    for (const id of g.expect.inTop5) {
      expect(Array.from(top5), `${id} in top 5 for ${label}`).toContain(id);
    }
    for (const id of g.expect.absent ?? []) {
      expect(keys, `${id} absent for ${label}`).not.toContain(id);
    }
  });
}
