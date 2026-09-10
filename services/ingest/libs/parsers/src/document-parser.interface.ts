/**
 * Turning bytes into text lives here, shared by every source — not inside the
 * adapters.
 *
 * A source describes *what documents exist*; a parser describes *how to read
 * one format*. Keeping them apart is what makes "adding a source is one file"
 * true: a new archive that happens to serve PDFs reuses this registry instead
 * of reimplementing PDF handling.
 */

export type ParserKind = "pdf" | "html" | "text";

/**
 * A contiguous run of text with an anchor describing where it came from.
 *
 * Segments exist so `extract` can cut chunks on boundaries that mean something.
 * Slicing at an arbitrary character count splits an event description in half
 * and the model sees neither piece whole; cutting on page or heading boundaries
 * costs nothing and avoids that entirely.
 */
export interface TextSegment {
  text: string;
  /**
   * Where this came from, for provenance and for anchoring an extracted event
   * back to a location in the document: `"p.12"`, `"§Gold Rush"`, `"¶4"`.
   */
  anchor: string;
}

export interface ParsedDocument {
  /** Full normalised text — the segments joined, cached for convenience. */
  text: string;
  segments: TextSegment[];
}

export interface DocumentParser {
  readonly kind: ParserKind;
  /**
   * `contentType` is a hint and may be null or wrong (a server can label a PDF
   * `application/octet-stream`); `path` is the fallback signal. Implementations
   * should accept on either.
   */
  canParse(contentType: string | null, path: string): boolean;
  parse(bytes: Buffer): Promise<ParsedDocument>;
}

export const DOCUMENT_PARSERS = "DOCUMENT_PARSERS";

/** Joins segments into the full-text form, with a blank line between them. */
export function joinSegments(segments: TextSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}
