// Historical Events Types

export interface HistoricalEvent {
  id: string;
  title: string;
  description: string;
  date: string; // ISO 8601: "1869-05-10"
  imageUrl?: string;
  tags?: string[];
  /** Free-text citation for this specific event, e.g. a page reference. */
  source?: string;
  /** EventSource.id — which publisher this event came from. */
  sourceId?: string;
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
