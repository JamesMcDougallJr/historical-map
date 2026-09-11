import type { ParsedDocument, TextSegment } from "../document-parser.interface";
import { joinSegments } from "../document-parser.interface";
import {
  type CleaningOptions,
  type CleaningReport,
  emptyReport,
} from "./cleaning.types";
import { stripRunningFurniture } from "./furniture";
import { dropStructuralSegments } from "./segment-filters";
import {
  reflowParagraphs,
  rejoinHyphenatedBreaks,
  repairFusedFootnoteYears,
} from "./text-rules";

/**
 * Bump when a rule changes in a way that should re-clean existing documents.
 *
 * `extract-text` re-runs any document whose stored version is lower, reading
 * the original back out of object storage — no re-download, no re-hitting the
 * source. That is the entire reason retrieval and text extraction are separate
 * jobs.
 */
export const EXTRACTOR_VERSION = 2;

export interface CleanedDocument extends ParsedDocument {
  report: CleaningReport;
}

/**
 * Runs the cleaning rules in the one order that works.
 *
 * Furniture removal **must** come first: a word hyphenated across a page
 * boundary has the next page's running header sitting inside it
 * (`"Tlaca-\nOriginal Copyright…"`), so rejoining before stripping would splice
 * the header into the middle of a word.
 *
 * Structural drops come last, after the text rules have had their say, so the
 * decision is made against cleaned text rather than raw extraction noise.
 */
export function cleanDocument(
  parsed: ParsedDocument,
  options: CleaningOptions = {},
): CleanedDocument {
  const disabled = new Set(options.disable ?? []);
  const threshold = options.furnitureThreshold ?? 0.6;
  const report = emptyReport(parsed.text.length);

  let segments: TextSegment[] = parsed.segments;

  if (!disabled.has("furniture")) {
    segments = stripRunningFurniture(segments, report, threshold);
  }

  segments = segments.map((segment) => {
    let text = segment.text;
    if (!disabled.has("dehyphenate")) {
      text = rejoinHyphenatedBreaks(text, report);
    }
    if (!disabled.has("footnote-years")) {
      text = repairFusedFootnoteYears(text, report);
    }
    if (!disabled.has("reflow")) {
      text = reflowParagraphs(text, report);
    }
    return { ...segment, text: text.trim() };
  });

  if (!disabled.has("drop-structural")) {
    segments = dropStructuralSegments(segments, report);
  }

  const text = joinSegments(segments);
  report.charsAfter = text.length;

  return { text, segments, report };
}
