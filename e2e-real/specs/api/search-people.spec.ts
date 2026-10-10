import { test, expect, type APIRequestContext } from "@playwright/test";
import type { SearchResponse } from "../../../app/map/types";

// People as a search field and a result kind (plans/22-search-people.md,
// Levels 1–2), over PEOPLE_LOCATION in e2e-real/fixtures/search-seed.ts.

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

test.describe("people in search (real backend)", () => {
  test("person match field: naming events rank above a description-only mention", async ({
    request,
  }) => {
    const res = await search(request, { q: "brigham young" });
    const events = res.hits.filter((h) => h.kind === "event");
    const ids = events.map((e) => e.id);
    for (const id of ["fx-ev-young-1", "fx-ev-young-3"]) {
      expect(ids).toContain(id);
      expect(events.find((e) => e.id === id)!.matchedOn).toContain("person");
      expect(ids.indexOf(id)).toBeLessThan(ids.indexOf("fx-ev-young-body"));
    }
    expect(
      events.find((e) => e.id === "fx-ev-young-body")!.matchedOn,
    ).not.toContain("person");
  });

  test("person kind: one hit per normalised name, with in-range counts", async ({
    request,
  }) => {
    const res = await search(request, { q: "brigham young" });
    const person = res.hits.find(
      (h) => h.kind === "person" && h.id === "brigham young",
    );
    expect(person?.title).toBe("Brigham Young");
    expect(person && "eventCount" in person ? person.eventCount : null).toBe(2);
    expect(person && "dateRange" in person ? person.dateRange : null).toEqual([
      "1847-07-24",
      "1877-08-29",
    ]);
  });

  test("aliases stay separate person hits (no identity guessing)", async ({
    request,
  }) => {
    const res = await search(request, { q: "young" });
    const people = res.hits.filter((h) => h.kind === "person").map((h) => h.id);
    expect(people).toEqual(
      expect.arrayContaining(["brigham young", "president young"]),
    );
  });

  test("a misspelling still finds the person (trigram)", async ({
    request,
  }) => {
    const res = await search(request, { q: "brigam young" });
    expect(
      res.hits.filter((h) => h.kind === "person").map((h) => h.id),
    ).toContain("brigham young");
  });

  test("timeline: counts in-range events only, and drops people with none", async ({
    request,
  }) => {
    const res = await search(request, { q: "young", from: "1870", to: "1880" });
    const people = res.hits.filter((h) => h.kind === "person");
    const brigham = people.find((p) => p.id === "brigham young");
    expect(brigham && "eventCount" in brigham ? brigham.eventCount : null).toBe(
      1,
    );
    expect(people.map((p) => p.id)).not.toContain("president young");
  });

  test("EventQuery.person lists a person's events, for the map filter", async ({
    request,
  }) => {
    const res = await request.get("/api/data/search?person=brigham%20young", {
      headers: HEADERS,
    });
    const body = (await res.json()) as { results: { event: { id: string } }[] };
    expect(body.results.map((r) => r.event.id).sort()).toEqual([
      "fx-ev-young-1",
      "fx-ev-young-3",
    ]);
  });
});
