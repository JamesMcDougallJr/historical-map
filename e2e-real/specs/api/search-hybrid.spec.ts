import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext } from "@playwright/test";
import type { SearchHit, SearchResponse } from "../../../app/map/types";
import { sqlClient } from "../../../lib/postgres-storage";
import { VECTOR_MIN_SIMILARITY } from "../../../lib/search";
import { normaliseQuery } from "../../../lib/search-semantic";
import { FLOOR_NEGATIVE_QUERIES } from "../../fixtures/golden-queries";

// Hybrid search (plans/23-search-semantic.md, "search-hybrid.spec.ts"), against
// real Postgres and pgvector, with the recorded-vector embedder
// (EMBEDDING_ENGINE=fake) — no spec calls Bedrock. /api/search/test-embedder
// exposes the fake's call log and lets a test make it fail.
//
// Each test searches from its own client IP (x-forwarded-for), so the hybrid
// rate limit only ever trips where a test means it to.

const HEADERS = { "x-api-key": "test-api-key" };

let ipSeq = 0;
let ip = "";
test.beforeEach(async ({ request }) => {
  ip = `10.23.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  await embedder(request, { reset: true });
});

async function hybrid(
  request: APIRequestContext,
  params: Record<string, string>,
): Promise<SearchResponse> {
  const res = await request.get(
    `/api/search?${new URLSearchParams({ mode: "hybrid", ...params })}`,
    { headers: { ...HEADERS, "x-forwarded-for": ip } },
  );
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as SearchResponse;
  // Locations are never embedded (row 4), whatever the query.
  for (const h of body.hits.filter((h) => h.kind === "location")) {
    expect(h.matchedOn, `location ${h.id}`).not.toContain("meaning");
  }
  return body;
}

interface EmbedderState {
  calls: number;
  received: string[];
}

async function embedder(
  request: APIRequestContext,
  body?: Record<string, unknown>,
): Promise<EmbedderState> {
  const res = body
    ? await request.post("/api/search/test-embedder", { data: body })
    : await request.get("/api/search/test-embedder");
  expect(res.status(), "test-embedder needs EMBEDDING_ENGINE=fake").toBe(200);
  return (await res.json()) as EmbedderState;
}

const ofKind = (hits: SearchHit[], kind: SearchHit["kind"]) =>
  hits.filter((h) => h.kind === kind);
const find = (hits: SearchHit[], kind: SearchHit["kind"], id: string) =>
  hits.find((h) => h.kind === kind && h.id === id);

test.describe("hybrid search (real backend)", () => {
  test("paraphrase finds it, by meaning only", async ({ request }) => {
    for (const [q, kind, id] of [
      [
        "emigrant wagon train ambushed in southern Utah",
        "event",
        "fx-ev-baker-fancher",
      ],
      ["when the Aztec capital fell", "event", "fx-ev-tenochtitlan"],
      ["Toltec collapse", "event", "fx-ev-tula"],
      [
        "the sequence of events at the southern Utah valley in 1857",
        "sequence",
        "fx-grp-meadows",
      ],
    ] as const) {
      const res = await hybrid(request, { q });
      expect(res.modes.semantic, q).toBe(true);
      const top3 = ofKind(res.hits, kind)
        .slice(0, 3)
        .map((h) => h.id);
      expect(top3, `${id} in the top 3 ${kind}s for ${q}`).toContain(id);
      if (q !== "when the Aztec capital fell") {
        // Shares no word with its target, so only the vector arm found it.
        expect(find(res.hits, kind, id)!.matchedOn).toEqual(["meaning"]);
      }
    }
  });

  test("passages are found by meaning", async ({ request }) => {
    const res = await hybrid(request, {
      q: "blossoms offered at a hilltop temple each fall",
    });
    const passage = ofKind(res.hits, "passage").find((h) =>
      h.snippet.includes("marigold"),
    );
    expect(passage, "the marigold paragraph").toBeDefined();
    expect(passage!.matchedOn).toEqual(["meaning"]);
  });

  test("hybrid ≥ lexical on names: an exact title keeps its lexical label", async ({
    request,
  }) => {
    const res = await hybrid(request, { q: "Tenochtitlan" });
    // First event: RRF didn't let a vector neighbour displace the name match.
    expect(ofKind(res.hits, "event")[0]?.id).toBe("fx-ev-tenochtitlan");
    const hit = find(res.hits, "event", "fx-ev-tenochtitlan")!;
    expect(hit.matchedOn).toContain("title");
    expect(hit.matchedOn).not.toContain("meaning");
  });

  test("relevance floor: unrelated queries get no meaning hits", async ({
    request,
  }) => {
    for (const q of FLOOR_NEGATIVE_QUERIES) {
      const res = await hybrid(request, { q });
      expect(res.modes.semantic, q).toBe(true);
      const meaning = res.hits.filter((h) => h.matchedOn.includes("meaning"));
      expect(
        meaning.map((h) => `${h.kind}:${h.id}`),
        q,
      ).toEqual([]);
    }
  });

  test("timeline pre-filter: filters run inside the vector query", async ({
    request,
  }) => {
    const q = "pestilence ravaged the people";
    // Unfiltered, fifty 1700s distractors crowd it out of the vector top 50.
    const all = await hybrid(request, { q, kinds: "event" });
    expect(find(all.hits, "event", "fx-ev-1520")).toBeUndefined();

    const ranged = await hybrid(request, {
      q,
      kinds: "event",
      from: "1500",
      to: "1600",
    });
    expect(find(ranged.hits, "event", "fx-ev-1520")?.matchedOn).toEqual([
      "meaning",
    ]);
    expect(
      ranged.hits.filter((h) => h.id.startsWith("fx-ev-distractor-")),
    ).toEqual([]);

    const toltec = await hybrid(request, {
      q: "Toltec collapse",
      from: "1500",
      to: "1600",
    });
    expect(find(toltec.hits, "event", "fx-ev-tula")).toBeUndefined();
  });

  test("limit to view: bbox and sources filter inside the vector query", async ({
    request,
  }) => {
    const q = "pestilence ravaged the people";
    const bbox: [number, number, number, number] = [-101, 18, -97, 22];
    const inView = await hybrid(request, {
      q,
      kinds: "event",
      bbox: bbox.join(","),
    });
    expect(find(inView.hits, "event", "fx-ev-1520")?.matchedOn).toEqual([
      "meaning",
    ]);
    for (const h of ofKind(inView.hits, "event")) {
      const [lon, lat] = (h as Extract<SearchHit, { kind: "event" }>)
        .coordinates;
      expect(
        lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3],
        h.id,
      ).toBe(true);
    }

    const bySource = await hybrid(request, {
      q,
      kinds: "event",
      sources: "fx-source-search",
    });
    expect(find(bySource.hits, "event", "fx-ev-1520")).toBeDefined();
    for (const h of ofKind(bySource.hits, "event")) {
      expect((h as Extract<SearchHit, { kind: "event" }>).sourceId, h.id).toBe(
        "fx-source-search",
      );
    }
  });

  test("inner-product order equals exact cosine order", async ({ request }) => {
    // No event holds every word of this query, so the lexical arm is empty
    // and the fused order is the vector arm's own.
    const q = "emigrant wagon train ambushed in southern Utah";
    const recorded = JSON.parse(
      readFileSync("e2e-real/fixtures/search-vectors.json", "utf8"),
    ) as { vectors: Record<string, number[]> };
    const qv = recorded.vectors[normaliseQuery(q)];
    expect(qv, "the query's recorded vector").toBeDefined();

    const rows = await sqlClient()<{ event_id: string; embedding: string }[]>`
      SELECT event_id, embedding::text FROM event_embeddings`;
    const expected = rows
      .map((r) => {
        const v = JSON.parse(r.embedding) as number[];
        return {
          id: r.event_id,
          cos: v.reduce((s, x, i) => s + x * qv![i]!, 0),
        };
      })
      .filter((r) => r.cos >= VECTOR_MIN_SIMILARITY)
      .sort((a, b) => b.cos - a.cos || a.id.localeCompare(b.id))
      .map((r) => r.id);

    const res = await hybrid(request, { q, kinds: "event", limit: "20" });
    const got = ofKind(res.hits, "event").map((h) => h.id);
    expect(got).toEqual(expected.slice(0, got.length));
    expect(got.length).toBe(Math.min(20, expected.length));
  });

  test("cache: a repeated query embeds once", async ({ request }) => {
    await hybrid(request, { q: "Toltec collapse" });
    await hybrid(request, { q: "Toltec collapse" });
    expect((await embedder(request)).calls).toBe(1);
  });

  test("typeahead never embeds, even when it claims hybrid", async ({
    request,
  }) => {
    const res = await hybrid(request, { q: "Toltec collapse", prefix: "1" });
    expect(res.modes.semantic).toBe(false);
    expect((await embedder(request)).calls).toBe(0);
  });

  test("embedder down: throttling, validation and timeout all degrade to lexical", async ({
    request,
  }) => {
    for (const failure of ["throttle", "validation", "timeout"]) {
      await embedder(request, { reset: true, failure });
      const started = Date.now();
      const res = await hybrid(request, { q: "aztec capital" });
      expect(res.modes.semantic, failure).toBe(false);
      expect(
        find(res.hits, "event", "fx-ev-tenochtitlan"),
        failure,
      ).toBeDefined();
      // The request budget, not the embedder's hang, bounds the wait.
      expect(Date.now() - started, failure).toBeLessThan(5_000);
    }
  });

  test("daily ceiling: past it, hybrid degrades to lexical", async ({
    request,
  }) => {
    await embedder(request, { ceiling: 2 });
    const queries = [
      "Toltec collapse",
      "when the Aztec capital fell",
      "emigrant wagon train ambushed in southern Utah",
    ];
    const semantic = [];
    for (const q of queries)
      semantic.push((await hybrid(request, { q })).modes.semantic);
    expect(semantic).toEqual([true, true, false]);
    expect((await embedder(request)).calls).toBe(2);
  });

  test("rate limit: hybrid past the per-IP limit is 429, lexical still works", async ({
    request,
  }) => {
    const headers = { ...HEADERS, "x-forwarded-for": ip };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await request.get(
        `/api/search?${new URLSearchParams({ q: "Toltec collapse", mode: "hybrid" })}`,
        { headers },
      );
      statuses.push(res.status());
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    const lexical = await request.get(
      `/api/search?${new URLSearchParams({ q: "Toltec collapse" })}`,
      { headers },
    );
    expect(lexical.status()).toBe(200);
  });

  test("model mismatch: vectors from another model are never compared", async ({
    request,
  }) => {
    const sql = sqlClient();
    await sql`UPDATE event_embeddings SET model = model || '#other'`;
    try {
      const res = await hybrid(request, { q: "Toltec collapse" });
      expect(res.modes.semantic).toBe(false);
      expect((await embedder(request)).calls).toBe(0);
    } finally {
      await sql`UPDATE event_embeddings SET model = replace(model, '#other', '')`;
    }
  });

  test("length clamp: at most 200 characters are embedded", async ({
    request,
  }) => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    await hybrid(request, { q: long });
    const { received } = await embedder(request);
    expect(received.length).toBe(1);
    expect(received[0]!.length).toBeLessThanOrEqual(200);
  });

  test("query log: submitted searches only, no client identity, clicks, retention", async ({
    request,
  }) => {
    const sql = sqlClient();
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'search_query_log'`;
    // The table is created on first use; make sure it has been.
    const submitted = await hybrid(request, { q: "Toltec collapse", log: "1" });
    expect(submitted.logId).toBeGreaterThan(0);
    const names = (
      columns.length
        ? columns
        : await sql<{ column_name: string }[]>`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'search_query_log'`
    ).map((c) => c.column_name);
    for (const banned of ["ip", "user_agent", "session_id"]) {
      expect(names).not.toContain(banned);
    }
    const [row] = await sql<{ q_norm: string; mode: string }[]>`
      SELECT q_norm, mode FROM search_query_log WHERE id = ${submitted.logId!}`;
    expect(row).toEqual({ q_norm: "toltec collapse", mode: "hybrid" });

    // Typeahead is never logged, even when asked to.
    const logRows = async () =>
      (
        await sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM search_query_log`
      )[0]!.n;
    const before = await logRows();
    const typed = await hybrid(request, {
      q: "Toltec col",
      prefix: "1",
      log: "1",
    });
    expect(typed.logId).toBeUndefined();
    expect(await logRows()).toBe(before);

    const click = await request.post("/api/search/log", {
      headers: HEADERS,
      data: { id: submitted.logId, clicked: "event:fx-ev-tula" },
    });
    expect(click.status()).toBe(200);
    const [clicked] = await sql<{ clicked: string }[]>`
      SELECT clicked FROM search_query_log WHERE id = ${submitted.logId!}`;
    expect(clicked?.clicked).toBe("event:fx-ev-tula");

    const [old] = await sql<{ id: string }[]>`
      INSERT INTO search_query_log (q_norm, mode, hit_count, ms, created_at)
      VALUES ('backdated', 'lexical', 0, 1, now() - interval '91 days')
      RETURNING id`;
    await embedder(request, { sweep: true });
    const gone =
      await sql`SELECT 1 FROM search_query_log WHERE id = ${old!.id}`;
    expect(gone.length).toBe(0);
  });
});
