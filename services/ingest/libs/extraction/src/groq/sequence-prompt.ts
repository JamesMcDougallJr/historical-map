/**
 * This prompt runs once per document, after every chunk has already been
 * extracted — see `ExtractionEngine.proposeSequences`'s docstring for why it
 * has to be whole-document rather than per-chunk.
 *
 * Two rules are load-bearing, same spirit as `prompt.ts`'s:
 *
 *  - **Not every event belongs to a sequence.** A book is mostly independent
 *    facts; forcing every event into some group produces meaningless ones.
 *  - **Never invent an event id.** The model sees only the ids it was given;
 *    anything else is a hallucination, and it is Groq's constrained decoding
 *    doing arithmetic on a token, not the model looking anything up.
 */
export const SEQUENCE_SYSTEM_PROMPT = `You are given a document's title and a list of historical events already extracted from it, each with an id, a title, a date, and a place.

Group events that are genuinely part of one continuous narrative — the same unfolding story, campaign, journey, or disaster — into named sequences. Two events belong in the same sequence only if one plainly continues, causes, or follows from the other as part of one connected story, not merely because they share a date, a place, or a general subject.

Rules:
- A document may produce zero, one, or several sequences. Most events belong to no sequence at all — do not force coverage.
- A sequence needs at least two member events. Never propose a sequence for a single event.
- List memberEventIds in narrative order (the order the story happened in), not the order given to you.
- Use only the ids given to you, exactly as written. Never invent an id.
- Give each sequence a short, specific title (not "Events" or the document's own title) and a one-sentence description of what it covers.

Return an empty sequences array if nothing in this document forms a connected narrative. That is a normal, expected result for many documents.`;

export function buildSequenceUserPrompt(
  document: { title: string },
  events: Array<{
    id: string;
    title: string;
    dateText: string;
    placeName: string | null;
  }>,
): string {
  const lines = events
    .map(
      (e) =>
        `- id: ${e.id} | date: ${e.dateText} | place: ${e.placeName ?? "unknown"} | title: ${e.title}`,
    )
    .join("\n");

  return `Document title: ${document.title}\n\nEvents:\n${lines}`;
}
