// Historical Events Types

import type { DatePrecision } from "./dates";

export interface HistoricalEvent {
  id: string;
  title: string;
  description: string;
  date: string; // ISO 8601: "1869-05-10"
  /**
   * How much of `date` the source actually supports.
   *
   * `events.date` is `date NOT NULL`, so a year-only event is stored as
   * `1103-01-01` — a representative day, not a claim. Without this field the
   * UI cannot tell that apart from a genuine 1 January and renders
   * "January 1, 1103", inventing a precision no source ever gave. Absent means
   * day precision, which is the right default for hand-curated events.
   */
  datePrecision?: DatePrecision;
  /** The date exactly as the source worded it, e.g. "Spring 1847". */
  dateText?: string;
  imageUrl?: string;
  tags?: string[];
  /** Free-text citation for this specific event, e.g. a page reference. */
  source?: string;
  /** EventSource.id — which publisher this event came from. */
  sourceId?: string;
  /** `ingest_documents.id` — which document asserted this event, if ingested. */
  documentId?: string;
  /** Page/segment within that document, e.g. `"p.43"`. See `/api/events/:id/source`. */
  anchor?: string;
  /** Derived: which EventGroups list this event's id. Never written directly — storage layers populate it by scanning `memberEventIds`. */
  groupIds?: string[];
  /**
   * People named in this event, verbatim. Written to `event_entities`
   * (type "person") by the Postgres backend and searched from there; the JSON
   * backend keeps and searches them inline. Not populated on Postgres reads.
   */
  people?: string[];
}

/**
 * A named, orderable, nestable sequence of events — e.g. "Mountain Meadows
 * Massacre" grouping its constituent sub-events. Membership is many-to-many
 * (an event can belong to several groups) and order is just array order:
 * `memberEventIds` IS the narrative order, with no separate sequence field.
 * Reordering means replacing the whole array in one write, never editing it
 * in place.
 */
export interface EventGroup {
  id: string;
  title: string;
  description?: string;
  /** Parent group id, for nesting. Undefined means top-level. */
  parentGroupId?: string;
  /** Canonical (post-fusion) event ids, in narrative order. */
  memberEventIds: string[];
}

/**
 * A publisher of events — one organisation or dataset, e.g. the Utah Historical
 * Society. Events are grouped by source, and each source surfaces as its own
 * toggleable layer on the map.
 *
 * Distinct from EventLayer, which describes how a source's events are *served*.
 */
export interface EventSource {
  id: string;
  name: string;
  description?: string;
  homepageUrl?: string;
  /** Rendered while this source's layer is visible. */
  attribution?: string;
  /** Pin colour, so layers are visually distinguishable. */
  color?: string;
}

export interface HistoricalLocation {
  id: string;
  name: string;
  coordinates: [number, number]; // [longitude, latitude]
  events: HistoricalEvent[];
}

export interface HistoricalEventsData {
  version: string;
  lastUpdated: string;
  locations: HistoricalLocation[];
  sources?: EventSource[];
  groups?: EventGroup[];
}

/**
 * An event as it comes back from a parser or an LLM extraction pass — before
 * it has been geocoded, deduplicated, or assigned to a `HistoricalLocation`.
 * The web import flow (`/map/import`) and the `extract` worker both produce
 * this shape, which is why it lives here rather than in either one.
 */
export interface ParsedEvent {
  id: string;
  title: string;
  description: string;
  date: string;
  confidence: number; // 0-1, for AI parsing quality
  sourceText: string; // Original text snippet
}
