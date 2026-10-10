// Pure-function tests for the paragraph splitter behind document_passages
// (services/ingest/libs/parsers/src/passages/split-passages.ts). No server:
// the splitter is a function over text segments, like popup-placement.ts.
import { test, expect } from "@playwright/test";
import {
  endsSentence,
  isHeading,
  MAX_PASSAGE_CHARS,
  MIN_PASSAGE_CHARS,
  passageAnchor,
  splitLong,
  splitPassages,
} from "../services/ingest/libs/parsers/src/passages/split-passages";

/** A sentence-ending paragraph of roughly `n` characters, tagged with `tag`. */
function para(tag: string, n = 260): string {
  const words: string[] = [tag];
  while (words.join(" ").length < n) words.push("history");
  return `${words.join(" ")}.`;
}

test("a sentence end splits; each paragraph keeps its own text", () => {
  const out = splitPassages([
    {
      anchor: "p.1",
      text: [para("alpha"), para("beta"), para("gamma")].join("\n"),
    },
  ]);
  expect(out.map((p) => p.anchor)).toEqual(["p.1¶1", "p.1¶2", "p.1¶3"]);
  expect(out[1]!.text.startsWith("beta")).toBe(true);
});

test("blank lines always split", () => {
  const unterminated = para("alpha").slice(0, -1); // no final period
  const out = splitPassages([
    { anchor: "p.1", text: `${unterminated}\n\n${para("beta")}` },
  ]);
  expect(out).toHaveLength(2);
});

test("a wrap the cleaner declined to join (next line capitalised) does not split", () => {
  // Real text: "…at the time of the\nConquest are, like those…"
  const text =
    para("alpha").slice(0, -1) +
    " at the time of the\nConquest are, like those of their government, exaggerated beyond measure.";
  const out = splitPassages([{ anchor: "p.1", text }]);
  expect(out).toHaveLength(1);
  expect(out[0]!.text).toContain("of the Conquest are");
});

test("abbreviations and initials at line end are not sentence ends", () => {
  for (const line of [
    "under Gen.",
    "led by Mr.",
    "in 1325 A.D.",
    "John Q.",
    "the U.S.",
  ]) {
    expect(endsSentence(line), line).toBe(false);
  }
  for (const line of ["they left.", 'he said "no."', "why?", "(as noted.)"]) {
    expect(endsSentence(line), line).toBe(true);
  }
  const text = `${para("alpha").slice(0, -1)} under Gen.\nTrujillo, who commanded ${"the army ".repeat(20)}to the end.`;
  expect(splitPassages([{ anchor: "p.1", text }])).toHaveLength(1);
});

test("an open paragraph continues across a page break, anchored to its first page", () => {
  const out = splitPassages([
    {
      anchor: "p.1",
      text: `${para("alpha")}\n${para("beta").slice(0, -1)} who practised`,
    },
    { anchor: "p.2", text: `quillwork of great delicacy.\n${para("gamma")}` },
  ]);
  expect(out.map((p) => p.anchor)).toEqual(["p.1¶1", "p.1¶2", "p.2¶1"]);
  expect(out[1]!.text).toContain("practised quillwork");
});

test("a page opening with a heading does not continue the previous paragraph", () => {
  const out = splitPassages([
    {
      anchor: "p.1",
      text: `${para("alpha")}\n${para("beta").slice(0, -1)} unfinished`,
    },
    { anchor: "p.2", text: `CHAPTER II\n${para("gamma")}` },
  ]);
  expect(out.at(-1)!.text.startsWith("CHAPTER II gamma")).toBe(true);
  expect(out.at(-1)!.anchor).toBe("p.2¶1");
});

test("a heading leads the paragraph it introduces, never trails the one before", () => {
  const short = "A short closing paragraph of the chapter.";
  const out = splitPassages([
    {
      anchor: "p.1",
      text: [
        para("alpha"),
        short,
        "CHAPTER II",
        "THE CONQUEST",
        para("beta"),
      ].join("\n"),
    },
  ]);
  expect(out).toHaveLength(2);
  expect(out[0]!.text.endsWith(short)).toBe(true);
  expect(out[1]!.text.startsWith("CHAPTER II THE CONQUEST beta")).toBe(true);
});

test("fragments under the minimum merge; long paragraphs split at sentences", () => {
  const out = splitPassages([
    { anchor: "p.1", text: ["Tiny.", "Also tiny.", para("alpha")].join("\n") },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]!.text.startsWith("Tiny. Also tiny. alpha")).toBe(true);

  const long = Array.from(
    { length: 45 },
    (_, i) => `Sentence number ${i} goes on a while here.`,
  ).join(" ");
  expect(long.length).toBeGreaterThan(MAX_PASSAGE_CHARS);
  const pieces = splitLong(long);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) {
    expect(piece.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
    expect(piece).toMatch(/^Sentence number \d+/); // never starts mid-sentence
    expect(piece).toMatch(/\.$/);
  }
  expect(pieces.join(" ")).toBe(long);

  for (const p of splitPassages([{ anchor: "p.1", text: long }])) {
    expect(p.text.length).toBeGreaterThanOrEqual(MIN_PASSAGE_CHARS);
  }
});

test("¶ numbering restarts on each page", () => {
  const out = splitPassages([
    { anchor: "p.1", text: [para("a"), para("b")].join("\n") },
    { anchor: "p.2", text: [para("c"), para("d")].join("\n") },
  ]);
  expect(out.map((p) => [p.seq, p.anchor])).toEqual([
    [1, "p.1¶1"],
    [2, "p.1¶2"],
    [3, "p.2¶1"],
    [4, "p.2¶2"],
  ]);
});

test("text documents' ¶ segments don't nest anchors", () => {
  expect(passageAnchor("¶3", 1)).toBe("¶3");
  expect(passageAnchor("¶3", 2)).toBe("¶3.2");
  expect(passageAnchor("p.43", 2)).toBe("p.43¶2");
  expect(isHeading("CHAPTER IV")).toBe(true);
  expect(isHeading("Chapter IV")).toBe(false);
});

test("deterministic: the same input gives the same output", () => {
  const segments = [
    {
      anchor: "p.1",
      text: [para("alpha"), para("beta").slice(0, -1) + " and"].join("\n"),
    },
    { anchor: "p.2", text: ["then more.", para("gamma")].join("\n") },
  ];
  expect(splitPassages(segments)).toEqual(
    splitPassages(structuredClone(segments)),
  );
});
