import {
  type DocumentParser,
  type ParsedDocument,
  type TextSegment,
  joinSegments,
} from "../document-parser.interface";

/**
 * HTML → one segment per top-level heading section.
 *
 * Lifted from `extractTextFromHtml` in `app/api/fetch-content/route.ts`, with
 * one deliberate change: **site chrome is deleted, not newline-separated.**
 *
 * The original converts `<nav>`, `<header>`, `<footer>` and `<aside>` to line
 * breaks, which keeps every menu, cookie banner and footer link in the output.
 * That is harmless when a human is reading the result in a textarea and
 * expensive when it is going to a token-metered model — on a free tier capped
 * at 8,000 tokens per minute, paying for navigation menus is a real cost, and
 * boilerplate is also exactly the kind of text that invents spurious "events".
 *
 * Regex rather than a DOM parser is a deliberate v0 choice: it has no
 * dependencies, and the corpus is saved article pages rather than arbitrary
 * web. If it proves too blunt, swapping in `cheerio` behind this same
 * `DocumentParser` interface changes nothing else.
 */
export class HtmlParser implements DocumentParser {
  readonly kind = "html" as const;

  canParse(contentType: string | null, path: string): boolean {
    return (
      contentType?.includes("text/html") === true || /\.x?html?$/i.test(path)
    );
  }

  async parse(bytes: Buffer): Promise<ParsedDocument> {
    const html = bytes.toString("utf-8");
    const body = stripNonContent(html);
    const segments = splitOnHeadings(body);
    return { text: joinSegments(segments), segments };
  }
}

/** Elements whose *content* is never document text. */
const DROPPED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "svg",
];

function stripNonContent(html: string): string {
  let text = html;
  for (const tag of DROPPED_ELEMENTS) {
    // Non-greedy, tolerant of attributes, and drops the content along with the
    // tags — the difference from the web route's version.
    text = text.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
      "",
    );
    // Self-closing or unclosed variants.
    text = text.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
  }
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  return text;
}

const HEADING_RE = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi;

function splitOnHeadings(html: string): TextSegment[] {
  const boundaries: Array<{ index: number; title: string }> = [];
  for (const match of html.matchAll(HEADING_RE)) {
    // `index` is optional on a match result. It is always present for a
    // non-sticky global regex, but narrowing beats asserting.
    if (match.index === undefined) continue;
    boundaries.push({
      index: match.index,
      title: toText(match[1] ?? "").slice(0, 80),
    });
  }

  if (boundaries.length === 0) {
    const text = toText(html);
    return text ? [{ text, anchor: "§body" }] : [];
  }

  const segments: TextSegment[] = [];

  // Anything before the first heading is still content (a lede, an abstract).
  const preamble = toText(html.slice(0, boundaries[0]!.index));
  if (preamble) segments.push({ text: preamble, anchor: "§preamble" });

  boundaries.forEach((boundary, i) => {
    const end = boundaries[i + 1]?.index ?? html.length;
    const text = toText(html.slice(boundary.index, end));
    if (text) {
      segments.push({
        text,
        anchor: `§${boundary.title || `section-${i + 1}`}`,
      });
    }
  });

  return segments;
}

/** Tags → structure, entities → characters, whitespace → tidy. */
function toText(html: string): string {
  return html
    .replace(
      /<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|article|section)[^>]*>/gi,
      "\n",
    )
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 10)),
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
