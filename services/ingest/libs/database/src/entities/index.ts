import { GeocodeCache } from "./geocode-cache.entity";
import { IngestDocument } from "./ingest-document.entity";
import { IngestEventCandidate } from "./ingest-event-candidate.entity";
import { IngestExtraction } from "./ingest-extraction.entity";
import { IngestSource } from "./ingest-source.entity";

export {
  GeocodeCache,
  IngestDocument,
  IngestEventCandidate,
  IngestExtraction,
  IngestSource,
};

/**
 * Explicit list rather than a glob. Two reasons, and the second is the one that
 * bites: `autoLoadEntities`/glob paths do not survive webpack bundling, which
 * `nest build` uses — the pattern resolves against a filesystem layout that no
 * longer exists inside `dist/main.js`.
 *
 * Note what is *not* here: the map tables (`sources`, `locations`, `events`).
 * Those belong to the web app's `ensureSchema()`. This connection must never be
 * able to migrate them.
 */
export const INGEST_ENTITIES = [
  IngestSource,
  IngestDocument,
  IngestExtraction,
  IngestEventCandidate,
  GeocodeCache,
];
