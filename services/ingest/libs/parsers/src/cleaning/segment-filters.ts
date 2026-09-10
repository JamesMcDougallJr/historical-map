import type { TextSegment } from "../document-parser.interface";
import type { CleaningReport } from "./cleaning.types";

/** Three or more dot-leader runs means a contents listing, not prose. */
const DOT_LEADER_RUNS = 3;

/** Phrases that only appear in front-matter licence blocks. */
const BOILERPLATE_MARKERS = [
  "conditions and terms of use",
  "all rights reserved",
  "some rights reserved",
  "terms of service",
  "this ebook is for the use of anyone",
  "project gutenberg license",
];

/**
 * Drops segments that are structure rather than content.
 *
 * Both kinds cost full token price and neither can yield an event: a contents
 * page is a list of page numbers, and a licence block is legal text. Worse,
 * both are exactly the sort of thing that invents spurious "events" — a table
 * of contents is wall-to-wall bare integers that date heuristics latch onto.
 *
 * The HTML parser already makes this argument for site chrome; the PDF path
 * simply never acted on it.
 */
export function dropStructuralSegments(
  segments: TextSegment[],
  report: CleaningReport,
): TextSegment[] {
  return segments.filter((segment) => {
    const reason = structuralReason(segment.text);
    if (!reason) return true;

    report.droppedSegments++;
    report.dropped.push({ anchor: segment.anchor, reason });
    if (!report.rules.includes("drop-structural")) {
      report.rules.push("drop-structural");
    }
    return false;
  });
}

function structuralReason(text: string): string | undefined {
  if (text.trim().length === 0) return "empty";

  const dotRuns = text.match(/\.{4,}/g)?.length ?? 0;
  if (dotRuns >= DOT_LEADER_RUNS) return "table-of-contents";

  const lower = text.toLowerCase();
  const marker = BOILERPLATE_MARKERS.find((m) => lower.includes(m));
  if (marker && proseDensity(text) < 0.004) {
    return `boilerplate (${marker})`;
  }

  return undefined;
}

/**
 * Sentence endings per character. Prose runs well above this; licence blocks,
 * lists and title pages run far below.
 *
 * Paired with a marker match rather than used alone — density on its own would
 * happily discard a page of dialogue or a short poem.
 */
function proseDensity(text: string): number {
  const sentences = text.match(/[.!?](\s|$)/g)?.length ?? 0;
  return sentences / Math.max(text.length, 1);
}
