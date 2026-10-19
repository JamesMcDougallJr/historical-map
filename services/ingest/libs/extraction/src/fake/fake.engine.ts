import { Injectable } from "@nestjs/common";
import type { ExtractedEvent } from "@historical-map/domain";
import type {
  ExtractionChunk,
  ExtractionEngine,
} from "../extraction-engine.interface";

/**
 * Deterministic stand-in for `GroqExtractionEngine`, for the ingestion
 * fixture test (`services/ingest/scripts/run-ingestion-fixture.ts`) — real
 * Postgres/Redis/MinIO/queues, no real LLM call.
 *
 * Parses `TITLE:`/`DATE:`/`PLACE:` blocks (one per blank-line-separated
 * paragraph) directly out of the fixture corpus text — see
 * `services/ingest/test-fixtures/corpus/`. No network call, no retry, no
 * schema validation: the fixture corpus is written to always parse cleanly,
 * so assertions in the fixture test can check exact values rather than
 * tolerate an LLM's variance.
 */
@Injectable()
export class FakeExtractionEngine implements ExtractionEngine {
  readonly engineName = "fake";
  readonly model = "fake-deterministic-v1";

  async extractChunk(chunk: ExtractionChunk): Promise<ExtractedEvent[]> {
    const blocks = chunk.text
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean);

    const events: ExtractedEvent[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const title = block.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim();
      const date = block.match(/^DATE:\s*(.+)$/m)?.[1]?.trim();
      const place = block.match(/^PLACE:\s*(.+)$/m)?.[1]?.trim();
      // `PARAPHRASE: yes|contradicted` makes the quote one that is NOT in the
      // document verbatim, so the exact-match grounding check misses and the
      // opt-in Jev grounding check has something to judge. `contradicted`
      // carries a marker the fixture's fake Jev server answers "contradicts"
      // to — the only way to exercise the grounding gate holding an event.
      const paraphrase = block.match(/^PARAPHRASE:\s*(.+)$/m)?.[1]?.trim();
      if (!title || !date) continue;

      const sourceText =
        paraphrase === "contradicted"
          ? `[contradicted] A claim about ${title} that the source disputes, not quoted verbatim.`
          : paraphrase
            ? `A paraphrase of ${title}, not quoted verbatim from the source.`
            : block;

      events.push({
        // Deterministic within a run, matching GroqExtractionEngine's own
        // id scheme — downstream dedup keys on this.
        id: `${chunk.index}-${i}`,
        title,
        description: `Fixture event: ${title}.`,
        date,
        confidence: 1,
        sourceText,
        dateText: date,
        dateIso: date,
        datePrecision: "day",
        placeName: place ?? null,
        anchor: chunk.anchors[0] ?? null,
      });
    }
    return Promise.resolve(events);
  }
}
