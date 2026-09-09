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
 * How a source's events reach the map.
 *
 * `geojson` — a static FeatureCollection from a Next API route. No database,
 * nothing to hammer; this is what the deployed demo ships.
 * `mvt` — vector tiles from Martin, backed by PostGIS, with filtering pushed
 * down into the database.
 * `inline` — built from the `locations` already in memory, fetching nothing.
 * Used by the MCP App, whose events arrive via structuredContent and which runs
 * in a sandboxed iframe where a relative URL has no origin to resolve against.
 *
 * Both kinds emit the same feature properties, so everything downstream of
 * layer construction treats them identically.
 */
export type EventLayerKind = "geojson" | "mvt" | "inline";

export interface EventLayer {
  /** Matches the EventSource this layer serves. */
  id: string;
  name: string;
  kind: EventLayerKind;
  /** Static endpoint for `geojson`, Martin tile template for `mvt`. */
  url: string;
  attribution?: string;
  color?: string;
  enabled: boolean;
}

// Parser Types

export interface ParsedEvent {
  id: string;
  title: string;
  description: string;
  date: string;
  confidence: number; // 0-1, for AI parsing quality
  sourceText: string; // Original text snippet
}

export interface ProcessingJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number; // 0-100
  totalChunks: number;
  completedChunks: number;
  results: ParsedEvent[];
  errors: string[];
}

export interface EventProcessingService {
  // Synchronous for small documents (<50KB)
  parseSync(text: string, strategy: string): ParsedEvent[];

  // Async job-based for large documents (future)
  createJob?(text: string, strategy: string): Promise<string>;
  getJobStatus?(jobId: string): Promise<ProcessingJob>;
  cancelJob?(jobId: string): Promise<void>;
}

// Parser strategy type
export type ParserStrategy = "regex" | "structured";

// Historical Map Overlay Types

export type OverlaySource = "allmaps" | "ohm" | "usgs" | "nypl" | "custom";

export interface HistoricalOverlay {
  id: string;
  name: string;
  description?: string;
  yearRange: [number, number]; // e.g., [1860, 1880]
  source: OverlaySource;
  tileUrl?: string; // For XYZ/WMS sources
  annotationUrl?: string; // For Allmaps IIIF georeferenced maps
  opacity: number; // 0-1
  attribution?: string;
  enabled: boolean;
  zIndex?: number; // Layer ordering
}
