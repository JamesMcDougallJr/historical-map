// Historical Events Types
//
// The event/location vocabulary itself now lives in `packages/domain`, because
// the ingestion workers in `services/ingest` write these exact shapes and the
// two must not drift. It is re-exported here so every existing
// `@/app/map/types` import keeps working — that alias is still the right one to
// use from inside the web app.
//
// `export type *` (not `export *`) is deliberate: it erases completely at
// compile time, so nothing in the browser bundle has to resolve the workspace
// package at runtime.
export type * from "@historical-map/domain";

// Everything below is web-app-only — how events are *served* and *drawn*. The
// ingestion side has no opinion on any of it, so none of it belongs in
// `packages/domain`.

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

import type { ParsedEvent } from "@historical-map/domain";

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
