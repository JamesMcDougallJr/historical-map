/**
 * Job payloads carry **identifiers, not content**.
 *
 * The database is the source of truth for state; Redis is a work queue. Keeping
 * payloads to IDs means a job picked up after a restart reads current state
 * rather than a snapshot captured whenever it was enqueued — and it keeps
 * multi-MB document text out of Redis entirely.
 */

export interface DetectJobData {
  /** Matches `ingest_sources.key` and a `SourceAdapter.key`. */
  sourceKey: string;

  /**
   * Overrides the source's (or the global) lookback for this job only — how a
   * one-off backfill widens the window through the API without touching
   * configuration.
   */
  lookbackDays?: number;
}

export interface FetchJobData {
  documentId: string;
}

export interface ExtractTextJobData {
  documentId: string;

  /**
   * Re-clean even if the stored artifact is already at the current extractor
   * version — for testing a rule change against one document without bumping
   * the version for the whole corpus.
   */
  force?: boolean;
}

export interface ValidateJobData {
  documentId: string;
  modelRun?: string;
}

export interface ExtractEventsJobData {
  documentId: string;

  /**
   * Resume an interrupted extraction rather than starting a fresh pass. When
   * set, the worker skips chunk indices already recorded in
   * `ingest_extractions` for this run.
   */
  modelRun?: string;
}

export interface PublishJobData {
  documentId: string;

  /** Which extraction run to publish. Defaults to the most recent. */
  modelRun?: string;
}
