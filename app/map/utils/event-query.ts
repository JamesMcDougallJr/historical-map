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
  /** Restrict to events belonging to this EventGroup. */
  groupId?: string;
  /** With `groupId`, also include events belonging to its descendant groups. */
  includeDescendants?: boolean;
  /** Restrict to events extracted from this ingested document (search's "show on map"). */
  documentId?: string;
  /** Restrict to events naming this person (a normalised name — search's person action). */
  person?: string;
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

  const documentId = params.get("document");
  if (documentId) query.documentId = documentId;

  const person = params.get("person");
  if (person) query.person = person;

  const groupId = params.get("group");
  if (groupId) {
    query.groupId = groupId;
    if (params.get("descendants") === "1") query.includeDescendants = true;
  }

  return query;
}

/** Year of an ISO date string, for in-memory filtering. */
export function eventYear(date: string): number {
  return new Date(date).getFullYear();
}
