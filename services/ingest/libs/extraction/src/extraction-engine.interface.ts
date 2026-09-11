import type { ExtractedEvent } from "@historical-map/domain";

/** One unit of work sent to the model: text plus where it came from. */
export interface ExtractionChunk {
  /** Position within this extraction run. The checkpoint key. */
  index: number;
  /** Segment anchors this chunk spans, e.g. `["p.12", "p.13"]`. */
  anchors: string[];
  text: string;
}

/**
 * Turns a chunk of document text into events.
 *
 * **Deliberately per-chunk, not per-document.** The engine owns one model call
 * and its retries; the *service* owns chunking and checkpointing, because
 * checkpointing needs database access and an engine that talked to Postgres
 * would not be swappable. This is the one place the shape departs from the
 * transcription engine it is modelled on, which took a whole file — there,
 * chunking was an implementation detail of the audio format; here the chunk is
 * the unit of durable progress.
 */
export interface ExtractionEngine {
  readonly engineName: string;
  /** Recorded on every extraction row, so a run is reproducible. */
  readonly model: string;
  extractChunk(chunk: ExtractionChunk): Promise<ExtractedEvent[]>;
}
