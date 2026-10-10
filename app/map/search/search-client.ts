// The search bar's requests. Plain fetch (not the shared api-client) because
// every one of these must be abortable — a slow response must never overwrite
// a newer one — and the api-client doesn't take a signal.
//
// `/api/search`, `/api/search/matches` and `/api/documents/:id` gate on
// `x-api-key` only when MAP_API_KEY is set, the same policy as /api/data/*,
// so the public key goes along when configured.

import type {
  DatePrecision,
  EventGroup,
  HistoricalEvent,
  HistoricalLocation,
  SearchKind,
  SearchResponse,
} from "../types";

export interface SearchParams {
  q: string;
  prefix: boolean;
  mode: "lexical" | "hybrid";
  /** The timeline filter, when enabled. */
  timeline: [number, number] | null;
  /** "Limit to view". */
  view: {
    bbox: [number, number, number, number] | null;
    sourceIds: string[];
  } | null;
  kinds?: SearchKind[];
}

export interface DocumentPanelData {
  id: string;
  title: string | null;
  sourceId: string;
  sourceName: string;
  extractedAt: string | null;
  passages: Array<{
    seq: number;
    anchor: string;
    snippet: string;
    eventIds: string[];
  }>;
  events: Array<{
    id: string;
    title: string;
    date: string;
    datePrecision?: DatePrecision;
    anchor: string | null;
    locationId: string;
  }>;
}

function headers(): HeadersInit {
  const key = process.env["NEXT_PUBLIC_MAP_API_KEY"];
  return key ? { "x-api-key": key } : {};
}

export function searchQueryString(params: SearchParams): string {
  const qs = new URLSearchParams({ q: params.q, mode: params.mode });
  if (params.prefix) qs.set("prefix", "1");
  if (params.timeline) {
    qs.set("from", String(params.timeline[0]));
    qs.set("to", String(params.timeline[1]));
  }
  if (params.view) {
    if (params.view.bbox)
      qs.set("bbox", params.view.bbox.map((n) => n.toFixed(5)).join(","));
    if (params.view.sourceIds.length)
      qs.set("sources", params.view.sourceIds.join(","));
  }
  if (params.kinds) qs.set("kinds", params.kinds.join(","));
  return qs.toString();
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: headers(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export function fetchSearch(
  params: SearchParams,
  signal: AbortSignal,
): Promise<SearchResponse> {
  return getJson(`/api/search?${searchQueryString(params)}`, signal);
}

export function fetchMatches(
  params: SearchParams,
  signal: AbortSignal,
): Promise<{ locationIds: string[]; truncated: boolean }> {
  return getJson(`/api/search/matches?${searchQueryString(params)}`, signal);
}

export function fetchDocument(
  id: string,
  q: string | null,
  signal?: AbortSignal,
): Promise<DocumentPanelData> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return getJson(`/api/documents/${encodeURIComponent(id)}${qs}`, signal);
}

export function fetchGroup(
  id: string,
  signal?: AbortSignal,
): Promise<{ group: EventGroup; members: HistoricalLocation[] }> {
  return getJson(`/api/data/groups/${encodeURIComponent(id)}`, signal);
}

/** A document's events with their locations — the "Show all on map" filter. */
export function fetchDocumentEvents(
  id: string,
  signal?: AbortSignal,
): Promise<{
  results: Array<{ location: HistoricalLocation; event: { id: string } }>;
}> {
  return getJson(`/api/data/search?document=${encodeURIComponent(id)}`, signal);
}

/** A person's events (by normalised name), in date order — the person action. */
export function fetchPersonEvents(
  personId: string,
  signal?: AbortSignal,
): Promise<{
  results: Array<{ location: HistoricalLocation; event: HistoricalEvent }>;
}> {
  return getJson(
    `/api/data/search?person=${encodeURIComponent(personId)}`,
    signal,
  );
}
