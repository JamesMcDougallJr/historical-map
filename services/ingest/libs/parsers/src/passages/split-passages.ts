/**
 * Cuts a text artifact's segments into paragraph-sized passages — the unit
 * search indexes (`document_passages`, plans/20-search-lexical.md).
 *
 * Extraction keeps chunking by segment (a PDF page, a text block, an HTML
 * section); only search uses this finer grain, so a hit can say *which
 * paragraph* matched rather than "somewhere on page 43".
 *
 * **Measured on the real book before it was written**, per the plan. The
 * plan assumed typeset PDF lines and proposed "a short last line ends a
 * paragraph". The real artifact (A Short History of Mexico, 83 pages, 322k
 * characters after cleaning) has no typeset lines at all: `unpdf` plus
 * `reflowParagraphs` already joins most wraps, leaving 1,670 lines with a
 * median of 123 characters and no blank lines. A surviving newline is either
 * a paragraph end — the line closes a sentence — or a wrap `reflowParagraphs`
 * declined because the next line starts uppercase ("at the time of the\n
 * Conquest are"). So the boundary rule here is sentence punctuation, not line
 * length:
 *
 *   1. Blank lines always split. Otherwise a newline splits only when the
 *      line before it ends a sentence (and not on an abbreviation like "Mr."
 *      or "A.D."), or either side is a heading ("CHAPTER II").
 *   2. A page whose last paragraph is still open continues onto the next
 *      page, unless that page opens with a heading. The passage is anchored
 *      to the page it starts on.
 *   3. Fragments under MIN_PASSAGE_CHARS merge into the following passage
 *      (a heading thereby leads the paragraph it introduces); passages over
 *      MAX_PASSAGE_CHARS split at sentence boundaries, never mid-sentence.
 *
 * Pure and deterministic, so re-running is idempotent. Bump
 * SPLITTER_VERSION whenever the output for the same input changes — it
 * re-cuts passages from stored artifacts without re-cleaning, re-fetching or
 * re-extracting anything.
 */
import type { TextSegment } from "../document-parser.interface";

export const SPLITTER_VERSION = 1;

export const MIN_PASSAGE_CHARS = 200;
export const MAX_PASSAGE_CHARS = 1500;

export interface Passage {
  /** 1-based order within the document. */
  seq: number;
  /** The artifact segment the passage starts in, e.g. "p.43". */
  segmentAnchor: string | null;
  /** 1-based within that segment. */
  paraIndex: number;
  /** Display and link key, e.g. "p.43¶2". */
  anchor: string;
  text: string;
}

// Trailing closers after sentence punctuation: quotes, brackets.
const SENTENCE_END = /[.!?]["'”’)\]]*$/;
// Words whose trailing period is not a sentence end.
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "sr",
  "jr",
  "gen",
  "col",
  "capt",
  "lt",
  "rev",
  "hon",
  "gov",
  "pres",
  "vol",
  "no",
  "vs",
  "etc",
  "viz",
  "cf",
  "ca",
  "ft",
  "mt",
  "messrs",
  "don",
  "dona",
  "fr",
]);

/** Does this line end a sentence (and not an abbreviation)? */
export function endsSentence(line: string): boolean {
  const t = line.trim();
  if (!SENTENCE_END.test(t)) return false;
  if (!/\.["'”’)\]]*$/.test(t)) return true; // ! or ? — always an end
  const lastWord = t
    .replace(/["'”’)\]]+$/, "")
    .split(/\s+/)
    .pop()!;
  // Initialisms: "A.D.", "B.C.", "U.S." — letters separated by periods.
  if (/^(?:\p{L}\.){2,}$/u.test(lastWord)) return false;
  // A single capital initial: "John Q."
  if (/^\p{Lu}\.$/u.test(lastWord)) return false;
  return !ABBREVIATIONS.has(lastWord.slice(0, -1).toLowerCase());
}

/** A short line with no lowercase letters: "CHAPTER II", "THE CONQUEST OF MEXICO". */
export function isHeading(line: string): boolean {
  const t = line.trim();
  return (
    t.length > 0 && t.length <= 80 && /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t)
  );
}

interface Unit {
  segmentAnchor: string | null;
  text: string;
  /** Ended at a boundary (vs. still open at the end of its segment). */
  closed: boolean;
  heading?: boolean;
}

/** Splits text at sentence ends, packing sentences into chunks of at most `max`. */
export function splitLong(text: string, max = MAX_PASSAGE_CHARS): string[] {
  if (text.length <= max) return [text];
  // Candidate sentence breaks: punctuation, closers, whitespace, then a
  // non-lowercase character. Abbreviations are filtered with endsSentence.
  const sentences: string[] = [];
  let start = 0;
  const re = /[.!?]["'”’)\]]*\s+(?=[^\p{Ll}\s])/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const candidate = text.slice(start, end);
    if (!endsSentence(candidate)) continue;
    sentences.push(candidate.trim());
    start = end;
  }
  if (start < text.length) sentences.push(text.slice(start).trim());

  // Pack greedily, then even out: target roughly equal chunks so a 1,600-char
  // paragraph becomes two ~800s, not 1,500 + 100.
  const chunks = Math.ceil(text.length / max);
  const target = Math.ceil(text.length / chunks);
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + 1 + s.length > max) {
      out.push(current);
      current = s;
    } else if (current && current.length >= target) {
      out.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * "p.43" + 2 → "p.43¶2". Text documents' segments are already paragraphs
 * ("¶3"), so they don't nest: the first passage keeps the segment's anchor
 * and any further one cut from it (an over-long block) gets ".2", ".3".
 */
export function passageAnchor(
  segmentAnchor: string | null,
  paraIndex: number,
): string {
  if (segmentAnchor?.startsWith("¶")) {
    return paraIndex === 1 ? segmentAnchor : `${segmentAnchor}.${paraIndex}`;
  }
  return `${segmentAnchor ?? ""}¶${paraIndex}`;
}

export function splitPassages(segments: TextSegment[]): Passage[] {
  // 1. Lines → paragraph units, carrying an open unit across segment breaks.
  const units: Unit[] = [];
  let open: Unit | null = null;

  const close = () => {
    if (open && open.text.trim()) {
      open.closed = true;
      units.push(open);
    }
    open = null;
  };

  for (const segment of segments) {
    const anchor = segment.anchor ?? null;
    const lines = segment.text.split("\n");
    let first = true;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        close();
        continue;
      }
      // Rule 2: an open unit from the previous segment continues, unless this
      // segment opens with a heading.
      if (first && open && isHeading(line)) close();
      first = false;

      if (isHeading(line)) {
        close();
        units.push({
          segmentAnchor: anchor,
          text: line,
          closed: true,
          heading: true,
        });
        continue;
      }
      if (open) {
        (open as Unit).text = `${(open as Unit).text} ${line}`;
      } else {
        open = { segmentAnchor: anchor, text: line, closed: false };
      }
      if (endsSentence(line)) close();
    }
  }
  if (open && (open as Unit).text.trim()) units.push(open);

  // 2. Merge fragments forward, so short pieces (a heading, a one-line
  //    paragraph) join what follows them. A heading always starts a new
  //    passage, so a fragment just before one merges back instead — otherwise
  //    a chapter's last short paragraph would swallow the next chapter's title.
  //    A trailing fragment merges back too.
  const merged: Unit[] = [];
  let carry: Unit | null = null;
  const mergeBack = (unit: Unit) => {
    const last = merged[merged.length - 1];
    if (last) last.text = `${last.text} ${unit.text}`;
    else merged.push(unit);
  };
  for (const unit of units) {
    if (carry && unit.heading && !(carry as Unit).heading) {
      mergeBack(carry);
      carry = null;
    }
    if (carry) {
      unit.text = `${carry.text} ${unit.text}`;
      unit.segmentAnchor = carry.segmentAnchor;
      carry = null;
    }
    if (unit.text.length < MIN_PASSAGE_CHARS) carry = unit;
    else merged.push(unit);
  }
  if (carry) mergeBack(carry);

  // 3. Split long units at sentence boundaries; number within segments.
  const passages: Passage[] = [];
  const perSegment = new Map<string | null, number>();
  for (const unit of merged) {
    for (const text of splitLong(unit.text.replace(/\s+/g, " ").trim())) {
      const paraIndex = (perSegment.get(unit.segmentAnchor) ?? 0) + 1;
      perSegment.set(unit.segmentAnchor, paraIndex);
      passages.push({
        seq: passages.length + 1,
        segmentAnchor: unit.segmentAnchor,
        paraIndex,
        anchor: passageAnchor(unit.segmentAnchor, paraIndex),
        text,
      });
    }
  }
  return passages;
}
