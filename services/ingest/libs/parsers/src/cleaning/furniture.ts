import type { TextSegment } from "../document-parser.interface";
import type { CleaningReport } from "./cleaning.types";

/** Below this a "common prefix" is a coincidence, not a header. */
const MIN_FURNITURE_LENGTH = 12;

/**
 * The shared prefix must account for at least this much of the line.
 *
 * This is what separates furniture from content, and it is load-bearing.
 * Prose pages routinely share a long opening prefix by accident — and, worse,
 * *systematically* once a header has been stripped, since the lines beneath it
 * often start alike. Without this ratio, cleaning is not idempotent: a second
 * pass happily eats the first line of real text.
 *
 * A running header is essentially the entire line it sits on (the real one in
 * the test corpus is 80 of 81 characters, the remainder being the page number).
 * A content line that merely starts similarly is not.
 */
const MIN_FURNITURE_LINE_RATIO = 0.8;

/**
 * Removes running headers and footers.
 *
 * **This is the single highest-value rule.** In the test corpus, 84 of 85 pages
 * begin with `Original Copyright 1903 by Arthur Howard Noll Distributed by
 * Heritage History 2011` — and the page number is concatenated with no
 * separator (`...History 20113`). That injects the tokens `1903` and `2011`
 * into *every* chunk, which:
 *
 *   - defeats the `hasDate()` pre-filter completely, since every chunk then
 *     looks like it contains a date, and that filter is the pipeline's main
 *     cost control; and
 *   - hands the model a spurious date on every single request.
 *
 * Detection is by **longest common prefix**, which handles the glued page
 * number for free: the pages agree up to `...History 2011` and diverge at the
 * digits, so the common prefix is exactly the furniture.
 *
 * Must run before hyphen rejoining: a word broken across a page boundary has
 * the next page's header sitting in the middle of it (`"Tlaca-\nOriginal
 * Copyright…"`), so rejoining first would splice the header into a word.
 */
export function stripRunningFurniture(
  segments: TextSegment[],
  report: CleaningReport,
  threshold: number,
): TextSegment[] {
  if (segments.length < 3) return segments;

  const header = detectRepeatedLine(segments, "first", threshold);
  const footer = detectRepeatedLine(segments, "last", threshold);

  if (!header && !footer) return segments;
  if (header) {
    report.runningHeader = header;
    report.rules.push("running-header");
  }
  if (footer) {
    report.runningFooter = footer;
    report.rules.push("running-footer");
  }

  return segments.map((segment) => {
    const lines = segment.text.split("\n");

    if (header && lines.length > 0) {
      lines[0] = stripPrefix(lines[0] ?? "", header);
    }
    if (footer && lines.length > 0) {
      const i = lines.length - 1;
      lines[i] = stripPrefix(lines[i] ?? "", footer);
    }

    // A line that was *only* furniture is now empty and should go, rather than
    // leaving a blank line that later reads as a paragraph break.
    if (header && lines[0]?.trim() === "") lines.shift();
    if (footer && lines[lines.length - 1]?.trim() === "") lines.pop();

    return { ...segment, text: lines.join("\n").trim() };
  });
}

/**
 * The longest prefix shared by the first (or last) line of most segments.
 *
 * Groups by a short signature first, so a header present on only some pages —
 * front matter often differs — still resolves rather than collapsing the common
 * prefix to nothing.
 */
function detectRepeatedLine(
  segments: TextSegment[],
  edge: "first" | "last",
  threshold: number,
): string | undefined {
  const lines = segments
    .map((s) => {
      const parts = s.text.split("\n");
      return (
        (edge === "first" ? parts[0] : parts[parts.length - 1])?.trim() ?? ""
      );
    })
    .filter((line) => line.length >= MIN_FURNITURE_LENGTH);

  if (lines.length === 0) return undefined;

  // Signature = enough of the line to group by, short enough to survive a
  // differing page number at the end.
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const signature = line.slice(0, MIN_FURNITURE_LENGTH);
    groups.set(signature, [...(groups.get(signature) ?? []), line]);
  }

  const largest = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!largest || largest.length < segments.length * threshold)
    return undefined;

  const prefix = largest.reduce(commonPrefix);
  if (prefix.trim().length < MIN_FURNITURE_LENGTH) return undefined;

  // Does the prefix account for essentially the whole line? Median rather than
  // mean, so one unusually long line cannot veto an otherwise obvious header.
  const ratios = largest
    .map((line) => prefix.length / line.length)
    .sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)] ?? 0;

  return median >= MIN_FURNITURE_LINE_RATIO ? prefix : undefined;
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/**
 * Removes the furniture prefix plus whatever page number was glued to it.
 * Anything after that on the line is real content and is kept.
 */
function stripPrefix(line: string, furniture: string): string {
  if (!line.startsWith(furniture)) return line;
  return line.slice(furniture.length).replace(/^[\s\d]+/, "");
}
