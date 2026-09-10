// The ingestion pipeline's vocabulary: what a *source document* is on its way
// to becoming one or more `HistoricalEvent`s.
//
// Lives in the shared package rather than inside `services/ingest` because the
// web app needs to read it too — a document's provenance is what the map cites
// on an event popup, and an operator dashboard renders `DocumentStatus`.
//
// The pipeline is the same shape as the State Affairs video pipeline this was
// modelled on — detect → fetch → transcribe becomes detect → fetch → extract:
//
//   detect   discover documents a source has published that we have not seen
//   fetch    retrieve the document bytes and park them in object storage
//   extract  turn document text into ParsedEvents via the Claude API
//   publish  geocode, deduplicate, and write HistoricalEvents to Postgres

import type { ParsedEvent } from "./events";

/**
 * One document as a `SourceAdapter` first sees it — the listing-page view,
 * before anything has been fetched. `externalId` is the source's own stable
 * identifier for the document and is the dedupe key: the unique index on
 * (sourceId, externalId) is what actually makes detection idempotent, not any
 * control flow in the detect worker.
 */
export interface DiscoveredDocument {
  externalId: string;
  /** Where the bytes live. The `fetch` worker's only required input. */
  url: string;
  title?: string;
  /** Drives the lookback window that bounds a detection pass. */
  publishedAt?: Date;
  /** Sent back as If-None-Match so an unchanged document costs one 304. */
  etag?: string;
  /** Hint only — the `fetch` worker trusts the response, not this. */
  contentType?: string;
  /** Anything adapter-specific worth carrying through to extraction. */
  metadata?: Record<string, unknown>;
}

/**
 * A publisher the `detect` worker polls. One adapter per source; adding a
 * source is a new adapter file plus one line in the factory array, with no
 * change to the detect worker, the queue contracts, or the API.
 */
export interface SourceAdapter {
  /** Stable key, matched against the `sources` row. Never renamed casually. */
  readonly key: string;
  readonly metadata: {
    displayName: string;
    homepageUrl?: string;
    attribution?: string;
    [key: string]: unknown;
  };
  /**
   * Returns what the source currently offers. `knownExternalIds` is a
   * narrowing hint so an adapter can stop paginating early — it is not the
   * idempotency mechanism, and an adapter that ignores it is still correct.
   */
  fetchAvailableDocuments(
    knownExternalIds: Set<string>,
  ): Promise<DiscoveredDocument[]>;
}

/**
 * Where a document is in the pipeline. Only ever advanced by the worker that
 * owns that stage, and only flipped to `failed` once the queue has exhausted
 * its configured attempts — not on every transient blip.
 *
 * `skipped` is deliberately distinct from `failed`: a scanned page with no OCR
 * layer was fetched perfectly well and simply has no text to extract. Retrying
 * it can never succeed, so conflating the two would burn the whole retry budget
 * on documents that are already in their terminal, correct state.
 */
export type DocumentStatus =
  | "discovered"
  | "fetching"
  | "fetched"
  | "extracting"
  | "extracted"
  | "published"
  | "skipped"
  | "failed";

/** Terminal states — nothing further will be enqueued for these documents. */
export const TERMINAL_DOCUMENT_STATUSES = [
  "published",
  "skipped",
  "failed",
] as const satisfies readonly DocumentStatus[];

/**
 * How precisely a source dated an event. Historical text is routinely vague
 * ("Spring 1847", "circa 1850"), and `events.date` is a `date NOT NULL` column,
 * so a representative day always gets stored — this records how much of it to
 * believe, and lets the timeline widen a range rather than assert a precision
 * the source never had.
 */
export type DatePrecision =
  | "day"
  | "month"
  | "season"
  | "year"
  | "decade"
  | "circa";

/**
 * An event as an LLM extraction pass produces it.
 *
 * Deliberately a separate type rather than extra fields on `ParsedEvent`: the
 * web import flow (`/map/import`) produces `ParsedEvent` from regex parsers
 * that cannot populate any of these, so widening the shared type would either
 * lie about what those parsers return or force every field optional and lose
 * the guarantee that extraction always sets them.
 */
export interface ExtractedEvent extends ParsedEvent {
  /**
   * The date exactly as the document wrote it — "Spring 1847", "circa 1850".
   * Preserved verbatim so the map can cite what the source actually said rather
   * than only the day we picked to represent it.
   */
  dateText: string;

  /**
   * A representative day, or null when the text gives nothing datable.
   * `events.date` is `date NOT NULL`, so `publish` derives one from
   * `datePrecision` when this is null — and sends the event to review when it
   * cannot.
   */
  dateIso: string | null;

  /** How much of `dateIso` to believe. */
  datePrecision: DatePrecision;

  /**
   * Free-text place as written, e.g. "Promontory Summit". Never coordinates —
   * geocoding is `publish`'s job, and a model guessing latitude/longitude
   * produces plausible, unverifiable, wrong pins.
   */
  placeName: string | null;
}

/**
 * What the `extract` worker produces. Geocoding happens in `publish`,
 * deliberately later — it is a separate rate-limited external dependency and
 * should not be able to fail an otherwise-good extraction.
 */
export interface ExtractionResult {
  documentId: string;
  events: ExtractedEvent[];
  /** Model identifier, for reproducing or re-running an extraction. */
  model: string;
  extractedAt: string;
}
