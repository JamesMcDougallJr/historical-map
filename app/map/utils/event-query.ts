// The shape of a spatial + temporal event search.
//
// One query type, two implementations: PostGIS (lib/postgres-storage.ts) pushes
// it down into indexed SQL; the static backend (lib/server-storage.ts) applies
// the same filters in memory over data/map-data.json. Callers — the search API
// route and the MCP search_events tool — never pick.

import type { HistoricalEvent, HistoricalLocation } from "../types";

export interface EventQuery {
  /** [minLon, minLat, maxLon, maxLat] in EPSG:4326. */
  bbox?: [number, number, number, number];
  /** Inclusive. */
  fromYear?: number;
  /** Inclusive. */
  toYear?: number;
  /** Restrict to these EventSource ids. Empty/omitted means all sources. */
  sourceIds?: string[];
  /** Free-text match against event title, description, and location name. */
  q?: string;
}

export interface EventSearchResult {
  location: HistoricalLocation;
  event: HistoricalEvent;
}

/** Parses an EventQuery from URL search params. Shared by the API route. */
export function parseEventQuery(params: URLSearchParams): EventQuery {
  const query: EventQuery = {};

  const q = params.get("q");
  if (q) query.q = q;

  const from = params.get("from");
  if (from && Number.isFinite(Number(from))) query.fromYear = Number(from);

  const to = params.get("to");
  if (to && Number.isFinite(Number(to))) query.toYear = Number(to);

  const sources = params.get("sources");
  if (sources) query.sourceIds = sources.split(",").filter(Boolean);

  const bbox = params.get("bbox");
  if (bbox) {
    const parts = bbox.split(",").map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      query.bbox = parts as [number, number, number, number];
    }
  }

  return query;
}

/** Year of an ISO date string, for in-memory filtering. */
export function eventYear(date: string): number {
  return new Date(date).getFullYear();
}
