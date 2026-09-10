import { extractText } from "unpdf";
import {
  type DocumentParser,
  type ParsedDocument,
  type TextSegment,
  joinSegments,
} from "../document-parser.interface";

/**
 * PDF → one segment per page.
 *
 * `unpdf`'s `extractText` already returns `string[]`, one entry per page, when
 * `mergePages` is left at its default of `false`. The web app's
 * `/api/parse-pdf` route throws that away with `pages.join('\n\n')` — here the
 * per-page split is exactly the chunk boundary `extract` wants, and it costs
 * nothing to keep.
 */
export class PdfParser implements DocumentParser {
  readonly kind = "pdf" as const;

  canParse(contentType: string | null, path: string): boolean {
    return (
      contentType?.includes("application/pdf") === true ||
      path.toLowerCase().endsWith(".pdf")
    );
  }

  async parse(bytes: Buffer): Promise<ParsedDocument> {
    const { text: pages } = await extractText(new Uint8Array(bytes));

    const segments: TextSegment[] = pages
      .map((pageText, i) => ({
        text: normalise(pageText),
        anchor: `p.${i + 1}`,
      }))
      // A textbook has blank pages, plates and separators. Dropping them here
      // keeps empty chunks out of the token budget entirely.
      .filter((segment) => segment.text.length > 0);

    return { text: joinSegments(segments), segments };
  }
}

function normalise(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
