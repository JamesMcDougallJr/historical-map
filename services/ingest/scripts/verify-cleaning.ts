/**
 * Fixture tests for the text-cleaning rules. No network, no database.
 *
 *   npm run cleaning:verify --workspace=services/ingest
 *   npm run cleaning:verify --workspace=services/ingest -- ../../corpus/some.pdf
 *
 * Every fixture below reproduces a defect measured in a real document. The
 * safety cases matter more than the positive ones: a cleaning rule that
 * corrupts a proper noun is worse than no cleaning at all, because the damage
 * is invisible downstream.
 */
import { readFile } from "node:fs/promises";
import type { TextSegment } from "../libs/parsers/src/document-parser.interface";
import { cleanDocument } from "../libs/parsers/src/cleaning";
import { PdfParser } from "../libs/parsers/src/parsers/pdf.parser";

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push([name, ok, detail]);
};

function doc(segments: TextSegment[]) {
  return { text: segments.map((s) => s.text).join("\n\n"), segments };
}

const HEADER =
  "Original Copyright 1903 by Arthur Howard Noll Distributed by Heritage History 2011";

function main2(): void {
  // ── Running furniture ────────────────────────────────────────────────────
  // The page number is glued to the header with no separator, which is why
  // detection is by longest common prefix rather than exact line match.
  const withHeader = doc(
    Array.from({ length: 10 }, (_, i) => ({
      anchor: `p.${i + 1}`,
      text: `${HEADER}${i + 1}\nReal content on page ${i + 1} about the year 1810.`,
    })),
  );
  const cleanedHeader = cleanDocument(withHeader);
  check(
    "running header detected",
    cleanedHeader.report.runningHeader !== undefined,
    cleanedHeader.report.runningHeader,
  );
  check(
    "header text removed from every page",
    !cleanedHeader.text.includes("Heritage History"),
  );
  check(
    "header years no longer pollute the text",
    !cleanedHeader.text.includes("1903") &&
      !cleanedHeader.text.includes("2011"),
  );
  check(
    "real content survives header removal",
    cleanedHeader.text.includes("Real content on page 1") &&
      cleanedHeader.text.includes("1810"),
  );

  // A banner on one page of ten is content, not furniture.
  const varied = [
    "The conquest began in earnest that spring.",
    "Cortes advanced along the coastal road.",
    "Montezuma sent emissaries bearing gold.",
    "The siege lasted through the summer months.",
    "Famine followed the destruction of the causeways.",
    "Alvarado held the western approach.",
    "Reinforcements arrived from the coast.",
    "The city surrendered after eighty days.",
    "A new order was imposed upon the valley.",
  ];
  const rare = doc([
    { anchor: "p.1", text: `${HEADER}1\nalpha` },
    ...varied.map((text, i) => ({ anchor: `p.${i + 2}`, text })),
  ]);
  check(
    "a banner on one page of ten is not treated as furniture",
    cleanDocument(rare).report.runningHeader === undefined,
  );

  // Content pages often share an opening prefix by accident. Stripping it
  // would be silent data loss, and is what breaks idempotency.
  const sharedPrefix = doc(
    Array.from({ length: 8 }, (_, i) => ({
      anchor: `p.${i + 1}`,
      text: `In the year of our Lord ${1500 + i}, the province of ${"ABCDEFGH"[i]} was much disturbed by war and by rumour of war.`,
    })),
  );
  check(
    "a long shared prefix that is only part of a line is left alone",
    cleanDocument(sharedPrefix).report.runningHeader === undefined,
  );

  // ── Hyphenation safety — the most important cases here ───────────────────
  const hyphen = doc([
    { anchor: "p.1", text: "the city of Mexico-\nTenochtitlan fell" },
    { anchor: "p.2", text: "some fifty-\nnine men remained" },
    { anchor: "p.3", text: "the Tlaca-\ntecuhtli commanded" },
  ]);
  const cleanedHyphen = cleanDocument(hyphen, { disable: ["reflow"] });
  check(
    "proper-noun compound is NOT collapsed (Mexico-Tenochtitlan)",
    cleanedHyphen.text.includes("Mexico-Tenochtitlan") &&
      !cleanedHyphen.text.includes("MexicoTenochtitlan"),
  );
  check(
    "hyphenated word rejoined onto one line (fifty-nine)",
    cleanedHyphen.text.includes("fifty-nine"),
  );
  check("no hyphen-newline sequences remain", !/-\n/.test(cleanedHyphen.text));

  // ── Footnote digits fused to years ───────────────────────────────────────
  const fused = doc([
    {
      anchor: "p.1",
      text: "elected in 1892, again in 18961 and again in 1900.",
    },
  ]);
  const cleanedFused = cleanDocument(fused);
  check(
    "footnote marker stripped from year (18961 -> 1896)",
    cleanedFused.text.includes("1896") && !cleanedFused.text.includes("18961"),
  );
  check(
    "untouched years are left alone",
    cleanedFused.text.includes("1892") && cleanedFused.text.includes("1900"),
  );

  // ── Reflow ───────────────────────────────────────────────────────────────
  const ragged = doc([
    {
      anchor: "p.1",
      text: "the two armies came\ninto collision at Monte de las Cruces, and a terrible battle\nensued.\nInstead of following up.",
    },
  ]);
  const cleanedRagged = cleanDocument(ragged);
  check(
    "soft line wraps are reflowed into a paragraph",
    cleanedRagged.text.includes("the two armies came into collision"),
  );
  check(
    "a sentence boundary is not joined across",
    cleanedRagged.text.includes("ensued.\nInstead"),
  );

  // ── Structural drops ─────────────────────────────────────────────────────
  const toc = doc([
    {
      anchor: "p.2",
      text: 'Reform" ............... 67\nThe French Invasion ................... 72\nThe Republic ............ 76',
    },
    {
      anchor: "p.3",
      text: "Ordinary narrative prose about 1810 and what followed.",
    },
  ]);
  const cleanedToc = cleanDocument(toc);
  check(
    "table-of-contents page dropped",
    cleanedToc.segments.length === 1 &&
      cleanedToc.report.dropped[0]?.reason === "table-of-contents",
  );
  check("narrative page kept", cleanedToc.text.includes("Ordinary narrative"));

  // Prose that merely contains an ellipsis must not be mistaken for a TOC.
  const ellipsis = doc([
    {
      anchor: "p.1",
      text: "He paused.... then continued the march toward the capital in 1810.",
    },
  ]);
  check(
    "prose with an ellipsis is not dropped as a TOC",
    cleanDocument(ellipsis).segments.length === 1,
  );

  // ── Idempotency ──────────────────────────────────────────────────────────
  const once = cleanDocument(withHeader);
  const twice = cleanDocument({ text: once.text, segments: once.segments });
  check(
    "cleaning is idempotent (re-running changes nothing)",
    twice.text === once.text,
  );
}

async function measureRealPdf(path: string): Promise<void> {
  const raw = await new PdfParser().parse(await readFile(path));
  const cleaned = cleanDocument(raw);
  const r = cleaned.report;

  console.log(`\n=== ${path} ===`);
  console.log(
    `chars ${r.charsBefore} -> ${r.charsAfter} ` +
      `(-${(((r.charsBefore - r.charsAfter) / r.charsBefore) * 100).toFixed(1)}%)`,
  );
  console.log(`rules applied: ${r.rules.join(", ")}`);
  console.log(
    `dehyphenated=${r.dehyphenated} reflowed=${r.reflowed} ` +
      `repairedYears=${r.repairedYears} droppedSegments=${r.droppedSegments}`,
  );
  if (r.runningHeader)
    console.log(`header: "${r.runningHeader.slice(0, 70)}…"`);
}

async function main(): Promise<void> {
  main2();

  const pdf = process.argv[2];
  if (pdf) await measureRealPdf(pdf);

  let failed = 0;
  console.log();
  for (const [name, ok, detail] of checks) {
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`,
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
