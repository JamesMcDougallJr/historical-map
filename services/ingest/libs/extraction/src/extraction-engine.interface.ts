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
 * A narrative grouping the model proposed across a document's already-
 * extracted events — e.g. "The Outbound Journey" spanning several events from
 * different chunks. `memberEventIds` are extraction-time `ExtractedEvent.id`
 * values (`"{chunkIndex}-{i}"`), in the narrative order the model gave them.
 */
export interface SequenceProposal {
  title: string;
  description: string;
  memberEventIds: string[];
}

/**
 * Turns a chunk of document text into events, or a document's already-
 * extracted events into proposed narrative sequences.
 *
 * **`extractChunk` is deliberately per-chunk, not per-document.** The engine
 * owns one model call and its retries; the *service* owns chunking and
 * checkpointing, because checkpointing needs database access and an engine
 * that talked to Postgres would not be swappable. This is the one place the
 * shape departs from the transcription engine it is modelled on, which took a
 * whole file — there, chunking was an implementation detail of the audio
 * format; here the chunk is the unit of durable progress.
 *
 * **`proposeSequences` is the opposite shape on purpose**: sequence membership
 * is a whole-document judgment that a chunk-isolated call cannot make, so it
 * takes the complete list of events already extracted from every chunk in one
 * call, after `extractChunk` has finished all of them.
 */
export interface ExtractionEngine {
  readonly engineName: string;
  /** Recorded on every extraction row, so a run is reproducible. */
  readonly model: string;
  extractChunk(chunk: ExtractionChunk): Promise<ExtractedEvent[]>;
  proposeSequences(
    document: { title: string },
    events: Array<{
      id: string;
      title: string;
      dateText: string;
      placeName: string | null;
    }>,
  ): Promise<SequenceProposal[]>;
}
