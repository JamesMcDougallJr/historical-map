import {
  type DocumentParser,
  type ParsedDocument,
  type TextSegment,
  joinSegments,
} from "../document-parser.interface";

/**
 * Plain text and Markdown → one segment per blank-line-separated block.
 *
 * The fallback parser: it accepts anything the others declined, because a
 * mislabelled text file is far more likely than a genuinely unreadable one, and
 * failing to parse is worse than parsing crudely.
 */
export class TextParser implements DocumentParser {
  readonly kind = "text" as const;

  canParse(contentType: string | null, path: string): boolean {
    return (
      contentType?.startsWith("text/") === true ||
      /\.(txt|md|markdown|text)$/i.test(path) ||
      // Fallback: nothing else claimed it.
      contentType === null
    );
  }

  async parse(bytes: Buffer): Promise<ParsedDocument> {
    const normalised = bytes
      .toString("utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim();

    const segments: TextSegment[] = normalised
      .split(/\n\s*\n/)
      .map((block, i) => ({ text: block.trim(), anchor: `¶${i + 1}` }))
      .filter((segment) => segment.text.length > 0);

    return { text: joinSegments(segments), segments };
  }
}
