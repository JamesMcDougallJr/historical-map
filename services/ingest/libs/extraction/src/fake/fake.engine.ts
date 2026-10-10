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
      // "PEOPLE: Brigham Young; President Young" — absent means nobody named.
      const people =
        block
          .match(/^PEOPLE:\s*(.+)$/m)?.[1]
          ?.split(";")
          .map((n) => n.trim())
          .filter(Boolean) ?? [];
      if (!title || !date) continue;

      events.push({
        // Deterministic within a run, matching GroqExtractionEngine's own
        // id scheme — downstream dedup keys on this.
        id: `${chunk.index}-${i}`,
        title,
        description: `Fixture event: ${title}.`,
        date,
        confidence: 1,
        sourceText: block,
        dateText: date,
        dateIso: date,
        datePrecision: "day",
        placeName: place ?? null,
        people,
        anchor: chunk.anchors[0] ?? null,
      });
    }
    return Promise.resolve(events);
  }
}
