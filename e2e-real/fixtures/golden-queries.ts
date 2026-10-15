// The search golden set (plans/19-search.md, "The golden set"): hand-written
// queries with the hits they must produce, over the search fixture corpus
// (search-seed.ts).
//
// Two consumers: search-golden.spec.ts turns every entry into a pass/fail
// test — the ranking regression gate — and, from S3, `npm run search:eval`
// prints recall@5/MRR per mode for decisions. Ids are `kind:id`.
//
// When a ranking change breaks one of these, decide whether the change or the
// expectation is wrong; don't loosen an entry just to go green.

import type { SearchKind } from "../../app/map/types";

export interface GoldenQuery {
  q: string;
  timeline?: [number, number];
  kinds?: SearchKind[];
  mode: "lexical" | "hybrid";
  expect: {
    /** The single best hit across the response (the top hit, else the first event). */
    top1?: string;
    inTop5: string[];
    absent?: string[];
  };
}

export const GOLDEN_QUERIES: GoldenQuery[] = [
  {
    q: "mountain meadows massacre",
    mode: "lexical",
    expect: {
      top1: "event:fx-ev-massacre",
      inTop5: ["event:fx-ev-massacre", "sequence:fx-grp-meadows"],
    },
  },
  {
    q: "massacred emigrants",
    mode: "lexical",
    expect: { top1: "event:fx-ev-massacre", inTop5: ["event:fx-ev-massacre"] },
  },
  {
    q: "Tenochtitlan",
    mode: "lexical",
    expect: {
      top1: "event:fx-ev-tenochtitlan",
      inTop5: ["event:fx-ev-tenochtitlan"],
    },
  },
  {
    q: "Fall of Tenochtitlán",
    mode: "lexical",
    expect: {
      top1: "event:fx-ev-tenochtitlan",
      inTop5: ["event:fx-ev-tenochtitlan"],
    },
  },
  {
    q: "aztec capital",
    mode: "lexical",
    expect: { inTop5: ["event:fx-ev-tenochtitlan", "event:fx-ev-1520"] },
  },
  {
    q: "aztec capital",
    timeline: [1521, 1600],
    mode: "lexical",
    expect: {
      inTop5: ["event:fx-ev-tenochtitlan"],
      absent: ["event:fx-ev-1520"],
    },
  },
  {
    q: "siege",
    mode: "lexical",
    expect: {
      top1: "event:fx-ev-siege",
      inTop5: ["event:fx-ev-siege", "sequence:fx-grp-meadows"],
    },
  },
  {
    q: "fancher",
    mode: "lexical",
    expect: {
      top1: "event:fx-ev-departure",
      inTop5: ["event:fx-ev-departure", "event:fx-ev-massacre"],
    },
  },
  {
    q: "salt lake",
    kinds: ["location"],
    mode: "lexical",
    expect: { inTop5: ["location:fx-loc-slc"] },
  },
  {
    q: "gold 1850s",
    mode: "lexical",
    expect: { top1: "event:fx-ev-1840s-b", inTop5: ["event:fx-ev-1840s-b"] },
  },
  {
    q: "meadows -massacre",
    mode: "lexical",
    expect: {
      inTop5: ["event:fx-ev-meadows-body"],
      absent: ["event:fx-ev-massacre"],
    },
  },
  {
    q: "statehood 1890s",
    mode: "lexical",
    expect: { top1: "event:fx-ev-slc-1896", inTop5: ["event:fx-ev-slc-1896"] },
  },

  // ── Hybrid (plans/23). Each paraphrase shares no content word with the
  // event it must find, so only the vector arm can find it.
  {
    q: "emigrant wagon train ambushed in southern Utah",
    mode: "hybrid",
    expect: { inTop5: ["event:fx-ev-baker-fancher"] },
  },
  {
    q: "when the Aztec capital fell",
    mode: "hybrid",
    expect: { inTop5: ["event:fx-ev-tenochtitlan"] },
  },
  {
    q: "Toltec collapse",
    mode: "hybrid",
    expect: { inTop5: ["event:fx-ev-tula"] },
  },
  {
    q: "the sequence of events at the southern Utah valley in 1857",
    mode: "hybrid",
    expect: { inTop5: ["sequence:fx-grp-meadows"] },
  },
  {
    // Exact names still win: RRF mustn't let a vector neighbour displace it.
    q: "Tenochtitlan",
    mode: "hybrid",
    expect: {
      top1: "event:fx-ev-tenochtitlan",
      inTop5: ["event:fx-ev-tenochtitlan"],
    },
  },
  {
    q: "aztec capital",
    timeline: [1521, 1600],
    mode: "hybrid",
    expect: {
      inTop5: ["event:fx-ev-tenochtitlan"],
      absent: ["event:fx-ev-1520"],
    },
  },
];

/**
 * Hybrid queries that must find nothing by meaning — the relevance floor's
 * negative set (plans/23, row 14). Not golden entries: there is no hit to
 * expect, only `meaning` hits that must not appear.
 */
export const FLOOR_NEGATIVE_QUERIES = [
  "Napoleon's coronation",
  "the Battle of Hastings",
  "Apollo moon landing",
];
