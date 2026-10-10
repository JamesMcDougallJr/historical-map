/**
 * Normalises text for "does this quote appear in that text?" comparisons.
 *
 * Shared by `validate`'s grounding check and the passage linker in `publish`,
 * so "the quote is in the document" and "the quote is in this paragraph"
 * can't disagree about what counts as the same text. Whitespace is collapsed
 * because reflowed text and the model's copy of it differ in line breaks
 * without differing in content.
 */
export function normaliseQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Quotes shorter than this are too generic to locate reliably. */
export const MIN_QUOTE_CHARS = 20;
