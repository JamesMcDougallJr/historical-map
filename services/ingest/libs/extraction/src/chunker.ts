import type { TextSegment } from "@app/parsers";
import type { ExtractionChunk } from "./extraction-engine.interface";

/**
 * Rough tokens-per-character for English prose. Deliberately conservative:
 * under-filling a chunk costs an extra request, over-filling costs a 413 or a
 * truncated response, and only one of those is recoverable cheaply.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Packs segments into chunks under a token budget, **always cutting on segment
 * boundaries**.
 *
 * Cutting mid-page splits an event's description across two requests and the
 * model sees neither half whole — it either misses the event or reports two
 * mangled fragments. Since parsers already emit page/heading boundaries, honouring
 * them costs nothing.
 *
 * A single segment larger than the budget is emitted **whole rather than split**.
 * A textbook page that runs long is still one coherent unit, and the budget is a
 * target sized well below the model's context window, not a hard limit.
 */
export function chunkSegments(
  segments: TextSegment[],
  budgetTokens: number,
): ExtractionChunk[] {
  const chunks: ExtractionChunk[] = [];
  let current: TextSegment[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({
      index: chunks.length,
      anchors: current.map((s) => s.anchor),
      text: current.map((s) => s.text).join("\n\n"),
    });
    current = [];
    currentTokens = 0;
  };

  for (const segment of segments) {
    const tokens = estimateTokens(segment.text);

    if (currentTokens > 0 && currentTokens + tokens > budgetTokens) {
      flush();
    }

    current.push(segment);
    currentTokens += tokens;

    // An oversized single segment becomes its own chunk immediately rather
    // than dragging the next one over the budget with it.
    if (currentTokens >= budgetTokens) flush();
  }

  flush();
  return chunks;
}
