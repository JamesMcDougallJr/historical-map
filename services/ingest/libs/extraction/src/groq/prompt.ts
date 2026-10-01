/**
 * The prompt is the actual product of this stage, and deserves iteration
 * against a fixture set rather than being written once and trusted.
 *
 * Three rules are load-bearing and should not be softened without a reason:
 *
 *  - **Do not infer coordinates.** Geocoding is `publish`'s job. A model
 *    guessing latitude/longitude produces plausible, unverifiable, wrong pins,
 *    and a wrong pin on a history map is worse than a missing one.
 *  - **Partial dates are the normal case**, not an edge case. Historical prose
 *    says "Spring 1847" far more often than "1847-03-14", and an extractor that
 *    quietly drops those loses most of the corpus.
 *  - **Return nothing rather than something.** Textbooks are mostly connective
 *    prose, front matter and bibliography; a model that feels obliged to
 *    produce an event per chunk will invent them.
 */
export const SYSTEM_PROMPT = `You extract historical events from documents so they can be placed on a map and a timeline.

An event qualifies only if the text says something specific HAPPENED — an occurrence with a time and, usually, a place. Extract it only when the text itself supports it.

NOT events, and never to be extracted:
- Background, description, or analysis with no occurrence ("the valley was arid", "railroads changed commerce")
- Table-of-contents lines, index entries, page headers, footnotes, bibliography
- A bare date with no described occurrence
- Anything you inferred from general knowledge rather than read in this text

Dates:
- Record the date exactly as written in dateText — "Spring 1847", "circa 1850", "the 1860s".
- Set datePrecision to how precisely the TEXT dates it. Never claim more precision than it supports: "Spring 1847" is season, "the 1860s" is decade, "about 1850" is circa.
- Give dateIso a single representative day, choosing the earliest plausible one (Spring 1847 -> 1847-03-01, the 1860s -> 1860-01-01). Use null only when no year can be determined.

Places:
- placeName is the location as written, nothing more. "Promontory Summit", "the Salt Lake Valley".
- Never output latitude, longitude, or any coordinate. Something else geocodes these.
- Use null when the text names no place. A null place is fine; a guessed one is not.

Confidence:
- Report how sure you are that this is a real, correctly-dated event drawn from this text.
- Below 0.5 for anything you are reconstructing from fragmentary or garbled text — this corpus includes OCR output, and mangled text is common.

Significance:
- Report how much this event mattered to the broader narrative, independent of confidence. A battle, a founding, a treaty, a death, a major decision — high. A routine day's travel, a minor logistical note, connective detail between larger events — low.
- Confidence and significance are different questions. A minor detail can be reported with high confidence; do not lower confidence just because significance is low.
- Low significance is never a reason to omit an event. Extract it and score it low — the "return nothing rather than something" rule above is about events that did not happen, not about events that did not matter much.

Return an empty events array when the passage contains no events. That is a normal and expected result; most pages of most books contain none. Do not pad, and do not repeat an event you have already reported for this passage.`;

export function buildUserPrompt(text: string, anchors: string[]): string {
  const location =
    anchors.length > 0 ? `Location in document: ${anchors.join(", ")}\n\n` : "";
  return `${location}Extract every historical event from the passage below.\n\n---\n${text}\n---`;
}
