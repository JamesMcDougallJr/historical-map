import { test, expect, type APIRequestContext } from "@playwright/test";
import type {
  PassageHit,
  SearchHit,
  SearchResponse,
} from "../../../app/map/types";
import { FX_DOC_1, FX_DOC_2 } from "../../fixtures/search-seed";

// GET /api/search against real Postgres, over the search fixture corpus
// (e2e-real/fixtures/search-seed.ts). Tests *features* — stemming, accents,
// filters, kinds. Ranking quality lives in search-golden.spec.ts, so a
// ranking change that breaks a golden query is obviously that kind of failure.
//
// Document and passage cases use the two ingested fixture documents
// (FX_DOC_1/FX_DOC_2 in search-seed.ts), written through the real ingest
// passage writer.

// The webServer sets MAP_API_KEY, and /api/search follows /api/data/search's
// policy of gating on it when set.
const HEADERS = { "x-api-key": "test-api-key" };

async function search(
  request: APIRequestContext,
  params: Record<string, string>,
): Promise<SearchResponse> {
  const res = await request.get(`/api/search?${new URLSearchParams(params)}`, {
    headers: HEADERS,
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as SearchResponse;
}

const ids = (hits: SearchHit[], kind?: SearchHit["kind"]) =>
  hits.filter((h) => !kind || h.kind === kind).map((h) => h.id);

test.describe("GET /api/search (real backend)", () => {
  test("requires the API key when MAP_API_KEY is set", async ({ request }) => {
    expect((await request.get("/api/search?q=meadows")).status()).toBe(401);
    expect((await request.get("/api/search/matches?q=meadows")).status()).toBe(
      401,
    );
  });

  test("stemming: 'massacred' finds the massacre first", async ({
    request,
  }) => {
    const res = await search(request, { q: "massacred" });
    expect(ids(res.hits, "event")[0]).toBe("fx-ev-massacre");
    const res2 = await search(request, { q: "massacres" });
    expect(ids(res2.hits, "event")[0]).toBe("fx-ev-massacre");
  });

  test("field weighting: a title match ranks above a body match", async ({
    request,
  }) => {
    const events = ids((await search(request, { q: "meadows" })).hits, "event");
    expect(events).toContain("fx-ev-meadows-body");
    expect(events.indexOf("fx-ev-massacre")).toBeLessThan(
      events.indexOf("fx-ev-meadows-body"),
    );
  });

  test("accents fold both ways", async ({ request }) => {
    for (const q of ["Tenochtitlan", "Tenochtitlán", "TENOCHTITLAN"]) {
      expect(ids((await search(request, { q })).hits, "event")).toContain(
        "fx-ev-tenochtitlan",
      );
    }
  });

  test("a typo still finds it (trigram)", async ({ request }) => {
    const events = ids(
      (await search(request, { q: "Tenochitlan" })).hits,
      "event",
    );
    expect(events.slice(0, 3)).toContain("fx-ev-tenochtitlan");
  });

  test("a quoted phrase matches only the exact phrase", async ({ request }) => {
    const events = ids(
      (await search(request, { q: '"emigrant camp"' })).hits,
      "event",
    );
    expect(events).toContain("fx-ev-meadows-body");
    // Has both words, not as the phrase.
    expect(events).not.toContain("fx-ev-camp-split");
  });

  test("exclusion removes the event even when its place name matches", async ({
    request,
  }) => {
    const events = ids(
      (await search(request, { q: "meadows -massacre" })).hits,
      "event",
    );
    expect(events).not.toContain("fx-ev-massacre");
    expect(events).toContain("fx-ev-meadows-body");
  });

  test("words can match across an event and its place", async ({ request }) => {
    const events = ids(
      (await search(request, { q: "siege meadows" })).hits,
      "event",
    );
    expect(events).toEqual(["fx-ev-siege"]);
  });

  test("prefix: the typeahead path finds a partial word", async ({
    request,
  }) => {
    // (Without prefix=1 the trigram fallback can also reach it, so this only
    // asserts the prefix path, not that the plain path misses.)
    const res = await search(request, { q: "tenoch", prefix: "1" });
    expect(ids(res.hits, "event")).toContain("fx-ev-tenochtitlan");
    // A fully typed word still matches its stemmed form under prefix.
    const full = await search(request, { q: "massacre", prefix: "1" });
    expect(ids(full.hits, "event")).toContain("fx-ev-massacre");
  });

  test("every lexical kind comes back typed", async ({ request }) => {
    const res = await search(request, { q: "meadows" });
    expect(ids(res.hits, "event")).toContain("fx-ev-massacre");
    expect(ids(res.hits, "sequence")).toContain("fx-grp-meadows");
    expect(ids(res.hits, "location")).toContain("fx-loc-meadows");
    expect(res.modes).toEqual({
      lexical: true,
      semantic: false,
      documents: true,
    });
  });

  test("kinds= restricts the response", async ({ request }) => {
    const res = await search(request, { q: "meadows", kinds: "sequence" });
    expect(new Set(res.hits.map((h) => h.kind))).toEqual(new Set(["sequence"]));
  });

  test("a sequence matches through a member's title", async ({ request }) => {
    const res = await search(request, { q: "siege" });
    const seq = res.hits.find((h) => h.id === "fx-grp-meadows");
    expect(seq?.kind).toBe("sequence");
    expect(seq?.matchedOn).toContain("member");
  });

  test("location hit with its event count", async ({ request }) => {
    const res = await search(request, { q: "salt lake" });
    const loc = res.hits.find((h) => h.id === "fx-loc-slc");
    expect(loc?.kind).toBe("location");
    expect(loc && "eventCount" in loc ? loc.eventCount : null).toBe(4);
  });

  test("a date-only query browses that period in date order", async ({
    request,
  }) => {
    const res = await search(request, { q: "1840s" });
    expect(res.parsed.dateRange).toEqual([1840, 1849]);
    expect(res.parsed.text).toBe("");
    const events = res.hits.filter((h) => h.kind === "event");
    expect(events.map((e) => e.id)).toEqual(
      expect.arrayContaining(["fx-ev-1840s-a", "fx-ev-1840s-b"]),
    );
    // Only events (a browse), in date order.
    expect(events).toHaveLength(res.hits.length);
    const dates = events.map((e) => (e.kind === "event" ? e.date : ""));
    expect(dates).toEqual([...dates].sort());
  });

  test("precision-aware overlap: circa 1848 reaches into the 1850s, not 1855+", async ({
    request,
  }) => {
    expect(
      ids((await search(request, { q: "gold 1850-1860" })).hits, "event"),
    ).toEqual(["fx-ev-1840s-b"]);
    expect(
      ids((await search(request, { q: "gold 1855-1860" })).hits, "event"),
    ).toEqual([]);
  });

  test("the timeline restricts every kind", async ({ request }) => {
    const res = await search(request, {
      q: "meadows",
      from: "1500",
      to: "1600",
    });
    expect(ids(res.hits)).toEqual([]);
    const slc = await search(request, {
      q: "salt lake",
      from: "1500",
      to: "1600",
    });
    expect(ids(slc.hits, "location")).not.toContain("fx-loc-slc");
  });

  test("timeline counts: location eventCount is in-range events only", async ({
    request,
  }) => {
    const res = await search(request, {
      q: "salt lake",
      from: "1847",
      to: "1850",
    });
    const loc = res.hits.find((h) => h.id === "fx-loc-slc");
    expect(loc && "eventCount" in loc ? loc.eventCount : null).toBe(2);
  });

  test("sequences report how many members are in range", async ({
    request,
  }) => {
    const res = await search(request, {
      q: "meadows",
      from: "1857",
      to: "1857",
    });
    const seq = res.hits.find((h) => h.id === "fx-grp-meadows");
    expect(
      seq && "membersInRange" in seq
        ? [seq.membersInRange, seq.memberCount]
        : null,
    ).toEqual([2, 3]);
  });

  test("a query date outside the timeline is a reported conflict, not silence", async ({
    request,
  }) => {
    const res = await search(request, { q: "1840s", from: "1500", to: "1600" });
    expect(res.hits).toEqual([]);
    expect(res.parsed.conflict).toBe("timeline");
  });

  test("timing.unfiltered says whether any date filter applied", async ({
    request,
  }) => {
    expect((await search(request, { q: "meadows" })).timing.unfiltered).toBe(
      true,
    );
    expect(
      (await search(request, { q: "meadows", from: "1800", to: "1900" })).timing
        .unfiltered,
    ).toBe(false);
    expect(
      (await search(request, { q: "meadows 1857" })).timing.unfiltered,
    ).toBe(false);
  });

  test("clamps: a 1,000-char query and limit=500", async ({ request }) => {
    const long = await search(request, { q: "meadows ".repeat(125) });
    expect(long.parsed.text.length).toBeLessThanOrEqual(200);
    const many = await search(request, { q: "fixture", limit: "500" });
    expect(many.hits.length).toBeLessThanOrEqual(50);
  });

  test("hostile tsquery input is a 200 with no hits, never a 500", async ({
    request,
  }) => {
    // Operators and punctuation only: nothing to match, and nothing breaks.
    for (const q of ["' & | ! :* (", "\\", "''''", ":*", "!()", "<->"]) {
      expect((await search(request, { q })).hits).toEqual([]);
      expect((await search(request, { q, prefix: "1" })).hits).toEqual([]);
    }
    // Operators around real words: whatever matches, it's still a 200
    // (search() asserts the status).
    await search(request, { q: "a:* & !(b" });
    await search(request, { q: "a:* & !(b", prefix: "1" });
  });

  test("snippets mark matches with sentinels, never markup", async ({
    request,
  }) => {
    const res = await search(request, { q: "fancher" });
    const hit = res.hits.find((h) => h.id === "fx-ev-departure")!;
    expect(hit.snippet).toContain("\u0002Fancher\u0003");
    expect(hit.snippet).not.toMatch(/<\/?mark>|<b>/);
  });

  test("a source-quote-only match is found, ranked below a description match", async ({
    request,
  }) => {
    const res = await search(request, { q: "fancher" });
    const events = res.hits.filter((h) => h.kind === "event");
    expect(events.map((e) => e.id)).toEqual([
      "fx-ev-departure",
      "fx-ev-massacre",
    ]);
    expect(events[1]!.matchedOn).toEqual(["quote"]);
  });

  test("an exact title is promoted to the top hit", async ({ request }) => {
    const res = await search(request, { q: "Fall of Tenochtitlan" });
    expect(res.topHit).toEqual({ kind: "event", id: "fx-ev-tenochtitlan" });
    expect(
      (await search(request, { q: "tenochtitlan" })).topHit,
    ).toBeUndefined();
  });

  test("matches endpoint: distinct location ids, timeline-aware", async ({
    request,
  }) => {
    const get = async (qs: string) =>
      (await (
        await request.get(`/api/search/matches?${qs}`, { headers: HEADERS })
      ).json()) as {
        locationIds: string[];
        truncated: boolean;
      };
    const all = await get("q=meadows");
    expect(new Set(all.locationIds)).toEqual(
      new Set(["fx-loc-meadows", "fx-loc-cedar"]),
    );
    expect(all.truncated).toBe(false);
    expect((await get("q=meadows&from=1500&to=1600")).locationIds).toEqual([]);
    expect((await get("q=meadows%20-massacre")).locationIds).toEqual(
      expect.arrayContaining(["fx-loc-cedar"]),
    );
  });

  test("EventQuery.q callers share the matcher: /api/data/search stems", async ({
    request,
  }) => {
    const res = await request.get("/api/data/search?q=massacred", {
      headers: HEADERS,
    });
    const body = (await res.json()) as { results: { event: { id: string } }[] };
    expect(body.results.map((r) => r.event.id)).toContain("fx-ev-massacre");
  });

  // ── Documents and passages ────────────────────────────────────────────────

  const passages = (hits: SearchHit[]) =>
    hits.filter((h): h is PassageHit => h.kind === "passage");

  test("passages and documents come back typed", async ({ request }) => {
    const res = await search(request, { q: "chronicle" });
    expect(passages(res.hits).length).toBeGreaterThan(0);
    expect(ids(res.hits, "document")).toContain(FX_DOC_1);
  });

  test("passage cap: at most 2 per document; the document counts all 8", async ({
    request,
  }) => {
    const res = await search(request, { q: "chronicle", limit: "20" });
    const fromDoc1 = passages(res.hits).filter(
      (p) => p.documentId === FX_DOC_1,
    );
    expect(fromDoc1.length).toBeLessThanOrEqual(2);
    const doc = res.hits.find(
      (h) => h.kind === "document" && h.id === FX_DOC_1,
    );
    expect(doc && "matchCount" in doc ? doc.matchCount : null).toBe(8);
  });

  test("paragraph grain: the snippet is that paragraph, not its page", async ({
    request,
  }) => {
    const hits = passages((await search(request, { q: "zephyr" })).hits);
    expect(hits.map((p) => p.anchor)).toEqual(["p.1¶3"]);
    expect(hits[0]!.snippet).toContain("\u0002zephyr\u0003");
    // Words from other paragraphs on page 1 aren't in it.
    expect(hits[0]!.snippet).not.toMatch(/ochre|ramparts|weavers/);
  });

  test("a paragraph crossing a page break is anchored where it starts", async ({
    request,
  }) => {
    const hits = passages((await search(request, { q: "quillwork" })).hits);
    expect(hits.map((p) => p.anchor)).toEqual(["p.1¶4"]);
  });

  test("a passage lists the event quoted from it", async ({ request }) => {
    // "ramparts" is in p.1¶2 but not in the event's own quote, so the passage
    // isn't folded into the event.
    const hit = passages((await search(request, { q: "ramparts" })).hits)[0];
    expect(hit?.anchor).toBe("p.1¶2");
    expect(hit?.eventIds).toEqual(["fx-ev-doc-q1"]);
  });

  test("one sentence, one hit: the event carries its matching quote paragraph", async ({
    request,
  }) => {
    const res = await search(request, { q: "obsidian fortress" });
    const event = res.hits.find((h) => h.id === "fx-ev-doc-q1");
    expect(event?.kind).toBe("event");
    expect(
      event && "quotePassage" in event ? event.quotePassage?.anchor : null,
    ).toBe("p.1¶2");
    expect(ids(res.hits, "passage")).not.toContain(`${FX_DOC_1}:2`);
  });

  test("an unlinked passage stays a passage hit", async ({ request }) => {
    const hit = passages((await search(request, { q: "basalt" })).hits)[0];
    expect(hit?.anchor).toBe("p.3¶2");
    expect(hit?.eventIds).toEqual([]);
  });

  test("lenient timeline rule for undated passages", async ({ request }) => {
    // FX_DOC_1's events span 1650–1700; nothing is dated 1660–1670.
    const inSpan = await search(request, {
      q: "basalt",
      from: "1660",
      to: "1670",
    });
    expect(passages(inSpan.hits).map((p) => p.anchor)).toEqual(["p.3¶2"]);
    // A document hit is stricter: it needs an event actually in range.
    expect(ids(inSpan.hits, "document")).not.toContain(FX_DOC_1);

    const outOfSpan = await search(request, {
      q: "basalt",
      from: "1800",
      to: "1900",
    });
    expect(passages(outOfSpan.hits)).toEqual([]);
  });

  test("a passage's markup comes back as inert text", async ({ request }) => {
    const hit = passages((await search(request, { q: "lantern" })).hits)[0]!;
    expect(hit.snippet).toContain("\u0002lantern\u0003");
    expect(hit.snippet).not.toContain("<script");
  });

  test("a document title match outranks body matches", async ({ request }) => {
    const res = await search(request, { q: "ledger" });
    const doc = res.hits.find((h) => h.kind === "document");
    expect(doc?.id).toBe(FX_DOC_2);
    expect(doc?.matchedOn).toContain("title");
  });

  test("an unlinked event keeps its page anchor and no passage claims it", async ({
    request,
  }) => {
    const res = await request.get(`/api/documents/${FX_DOC_1}?q=chronicle`, {
      headers: HEADERS,
    });
    expect(res.status()).toBe(200);
    const panel = (await res.json()) as {
      passages: { seq: number; anchor: string; eventIds: string[] }[];
      events: { id: string; anchor: string | null }[];
    };
    const unlinked = panel.events.find((e) => e.id === "fx-ev-doc-unlinked");
    expect(unlinked?.anchor).toBe("p.2");
    expect(panel.passages.flatMap((p) => p.eventIds)).not.toContain(
      "fx-ev-doc-unlinked",
    );
  });

  test("document panel endpoint", async ({ request }) => {
    const get = async (path: string) => {
      const res = await request.get(path, { headers: HEADERS });
      expect(res.status()).toBe(200);
      return (await res.json()) as {
        title: string;
        passages: { seq: number; anchor: string }[];
        events: { id: string }[];
      };
    };
    const panel = await get(`/api/documents/${FX_DOC_1}?q=chronicle`);
    expect(panel.title).toBe("Annals of the Obsidian Basin");
    const seqs = panel.passages.map((p) => p.seq);
    expect(seqs).toHaveLength(8);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(panel.events.map((e) => e.id).sort()).toEqual([
      "fx-ev-doc-q1",
      "fx-ev-doc-q2",
      "fx-ev-doc-unlinked",
    ]);
    // Without q: no passages, just the events.
    expect((await get(`/api/documents/${FX_DOC_1}`)).passages).toEqual([]);
    expect((await get(`/api/documents/${FX_DOC_2}`)).events).toEqual([]);

    const missing = await request.get(
      "/api/documents/00000000-0000-4000-8000-000000000000",
      { headers: HEADERS },
    );
    expect(missing.status()).toBe(404);
  });

  test("EventQuery.documentId: /api/data/search?document= lists a document's events", async ({
    request,
  }) => {
    const res = await request.get(`/api/data/search?document=${FX_DOC_1}`, {
      headers: HEADERS,
    });
    const body = (await res.json()) as { results: { event: { id: string } }[] };
    expect(body.results.map((r) => r.event.id).sort()).toEqual([
      "fx-ev-doc-q1",
      "fx-ev-doc-q2",
      "fx-ev-doc-unlinked",
    ]);
  });
});
