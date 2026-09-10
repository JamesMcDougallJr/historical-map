import type { ParserKind, TextSegment } from "../document-parser.interface";
import type { CleaningReport } from "./cleaning.types";

/**
 * What `extract-text` writes to object storage and `extract-events` reads.
 *
 * **Segments are stored structurally, not as one joined blob.** The previous
 * design stored joined text plus a parallel array of anchors, and rebuilt the
 * segments by re-splitting on `"\n\n"` and zipping positionally. That worked by
 * luck: any mismatch collapsed the entire document into a single segment, which
 * for an 85-page book is one ~95k-token chunk and an automatic rejection
 * against an 8,000 tokens-per-minute limit. Storing the array removes the
 * failure mode rather than guarding against it.
 */
export interface TextArtifact {
  /** Cleaning ruleset that produced this. Drives re-extraction. */
  extractorVersion: number;
  kind: ParserKind;
  segments: TextSegment[];
  stats: {
    chars: number;
    segments: number;
  };
  /** What cleaning actually did, so a bad transformation is auditable. */
  cleaning: CleaningReport;
  createdAt: string;
}

export function serializeArtifact(artifact: TextArtifact): Buffer {
  return Buffer.from(JSON.stringify(artifact), "utf-8");
}

export function parseArtifact(bytes: Buffer): TextArtifact {
  return JSON.parse(bytes.toString("utf-8")) as TextArtifact;
}

/** Full text, reconstructed from segments when something needs a flat string. */
export function artifactText(artifact: TextArtifact): string {
  return artifact.segments.map((s) => s.text).join("\n\n");
}
