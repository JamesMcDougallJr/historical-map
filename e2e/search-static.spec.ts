// Pure-function tests for the static backend's in-memory search
// (lib/search-static.ts) — the path data/map-data.json and the stdio MCP
// server use when there's no Postgres. No server: it's a function over
// HistoricalEventsData.
import { test, expect } from "@playwright/test";
import { searchStatic } from "../lib/search-static";
import type { HistoricalEventsData } from "../app/map/types";

const DATA: HistoricalEventsData = {
  version: "1.0.0",
  lastUpdated: "2026-01-01T00:00:00.000Z",
  locations: [
    {
      id: "loc-meadows",
      name: "Mountain Meadows",
      coordinates: [-113.62, 37.48],
      events: [
        {
          id: "ev-title",
          title: "Massacre at the Meadows",
          description: "Emigrants were killed in southern Utah.",
          date: "1857-09-11",
          datePrecision: "day",
          source: "the Fancher train",
        },
      ],
    },
    {
      id: "loc-cedar",
      name: "Cedar City",
      coordinates: [-113.06, 37.68],
      events: [
        {
          id: "ev-body",
          title: "Emigrant Camp",
          description: "The party rested on the meadows.",
          date: "1857-01-01",
          datePrecision: "year",
        },
      ],
    },
    {
      id: "loc-mexico",
      name: "Mexico City",
      coordinates: [-99.13, 19.43],
      events: [
        {
          id: "ev-accent",
          title: "Fall of Tenochtitlán",
          description: "The Aztec capital fell.",
          date: "1521-01-01",
          datePrecision: "year",
        },
        {
          id: "ev-circa",
          title: "Gold Found",
          description: "Flakes in the millrace.",
          date: "1848-01-01",
          datePrecision: "circa",
        },
      ],
    },
  ],
  groups: [
    {
      id: "grp",
      title: "The Affair",
      memberEventIds: ["ev-title", "ev-body"],
    },
  ],
};

const run = (
  text: string,
  extra: Partial<Parameters<typeof searchStatic>[1]> = {},
) => searchStatic(DATA, { text, prefix: false, limit: 20, ...extra });

test("ranks a title match above a description match", () => {
  const ids = run("meadows").events.map((e) => e.id);
  expect(ids).toEqual(["ev-title", "ev-body"]);
});

test("folds accents both ways", () => {
  expect(run("Tenochtitlan").events.map((e) => e.id)).toEqual(["ev-accent"]);
  expect(run("TENOCHTITLÁN").events.map((e) => e.id)).toEqual(["ev-accent"]);
});

test("requires every word, and honours exclusions", () => {
  expect(run("meadows utah").events.map((e) => e.id)).toEqual(["ev-title"]);
  expect(run("meadows -massacre").events.map((e) => e.id)).toEqual(["ev-body"]);
});

test("matches the place name and the source quote, and says so", () => {
  const place = run("cedar").events[0]!;
  expect(place.id).toBe("ev-body");
  expect(place.matchedOn).toContain("place");
  const quote = run("fancher").events[0]!;
  expect(quote.id).toBe("ev-title");
  expect(quote.matchedOn).toEqual(["quote"]);
});

test("prefix matches the last word only when asked", () => {
  expect(run("tenoch").events).toHaveLength(0);
  expect(run("tenoch", { prefix: true }).events.map((e) => e.id)).toEqual([
    "ev-accent",
  ]);
});

test("applies the precision-aware date filter", () => {
  expect(run("gold", { years: [1850, 1860] }).events.map((e) => e.id)).toEqual([
    "ev-circa",
  ]);
  expect(run("gold", { years: [1855, 1860] }).events).toHaveLength(0);
});

test("an empty query with a range is a browse, in date order", () => {
  const ids = run("", { years: [1500, 1860] }).events.map((e) => e.id);
  expect(ids).toEqual(["ev-accent", "ev-circa", "ev-body", "ev-title"]);
});

test("sequences match through members; locations count in-range events", () => {
  const { sequences, locations } = run("meadows");
  expect(sequences.map((s) => s.id)).toEqual(["grp"]);
  expect(sequences[0]!.matchedOn).toContain("member");
  expect(locations.map((l) => l.id)).toEqual(["loc-meadows"]);

  const mexico = run("mexico", { years: [1500, 1600] }).locations[0]!;
  expect(mexico.eventCount).toBe(1);
});

test("snippets carry sentinel marks, never HTML", () => {
  const hit = run("meadows").events.find((e) => e.id === "ev-body")!;
  expect(hit.snippet).toContain("\u0002meadows\u0003");
  expect(hit.snippet).not.toContain("<mark>");
});
