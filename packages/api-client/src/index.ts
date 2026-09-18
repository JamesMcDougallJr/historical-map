// Typed client for the web app's `/api/data/*` and `/api/sources` routes.
//
// Every MFE that reads or writes map data goes through this instead of
// hand-rolling `fetch` + an `x-api-key` header — that duplication is exactly
// what let `datePrecision`/`dateText`/`sourceId` get silently dropped on the
// way into `POST /api/data/locations/:id/events` in the first place (one
// caller building the body by hand, forgetting a field). One request builder
// means one place that has to remember the full shape.
//
// `baseUrl` is `""` for same-origin use (the web app calling its own API)
// and an absolute origin for a separate app (e.g. the admin MFE) calling
// across ports. Cross-origin calls require the target's CORS config to allow
// the calling origin — see `next.config.mjs`.

import type {
  DatePrecision,
  EventSource,
  HistoricalEvent,
  HistoricalLocation,
} from "@historical-map/domain";

export interface MapClientConfig {
  /** "" (default) for same-origin; an absolute origin for cross-origin use. */
  baseUrl?: string;
  /** Sent as `x-api-key` when set. Must match the target's `MAP_API_KEY`. */
  apiKey?: string;
}

export interface EventQueryInput {
  q?: string;
  fromYear?: number;
  toYear?: number;
  sourceIds?: string[];
  /** [minLon, minLat, maxLon, maxLat] in EPSG:4326. */
  bbox?: [number, number, number, number];
}

export interface EventSearchResult {
  location: HistoricalLocation;
  event: HistoricalEvent;
}

export interface CreateLocationInput {
  id?: string;
  name: string;
  coordinates: [number, number];
  events?: HistoricalEvent[];
}

export interface UpdateLocationInput {
  name?: string;
  coordinates?: [number, number];
}

export interface EventInput {
  id?: string;
  title: string;
  date: string;
  description: string;
  datePrecision?: DatePrecision;
  dateText?: string;
  source?: string;
  sourceId?: string;
  tags?: string[];
  imageUrl?: string;
}

export type UpdateEventInput = Partial<Omit<EventInput, "id">>;

class MapClientError extends Error {
  constructor(
    method: string,
    path: string,
    readonly status: number,
    body: string,
  ) {
    super(`${method} ${path} -> ${status}${body ? `: ${body}` : ""}`);
    this.name = "MapClientError";
  }
}

export class MapClient {
  constructor(private readonly config: MapClientConfig = {}) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers["x-api-key"] = this.config.apiKey;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(`${this.config.baseUrl ?? ""}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MapClientError(method, path, res.status, text);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getSources(): Promise<EventSource[]> {
    const { sources } = await this.request<{ sources: EventSource[] }>(
      "GET",
      "/api/sources",
    );
    return sources;
  }

  async getLocations(): Promise<{
    locations: HistoricalLocation[];
    lastUpdated: string;
  }> {
    return this.request("GET", "/api/data/locations");
  }

  async getLocation(id: string): Promise<HistoricalLocation | null> {
    try {
      const { location } = await this.request<{
        location: HistoricalLocation;
      }>("GET", `/api/data/locations/${encodeURIComponent(id)}`);
      return location;
    } catch (error) {
      if (error instanceof MapClientError && error.status === 404) return null;
      throw error;
    }
  }

  async createLocation(
    input: CreateLocationInput,
  ): Promise<HistoricalLocation> {
    const { location } = await this.request<{ location: HistoricalLocation }>(
      "POST",
      "/api/data/locations",
      input,
    );
    return location;
  }

  async updateLocation(
    id: string,
    patch: UpdateLocationInput,
  ): Promise<HistoricalLocation> {
    const { location } = await this.request<{ location: HistoricalLocation }>(
      "PATCH",
      `/api/data/locations/${encodeURIComponent(id)}`,
      patch,
    );
    return location;
  }

  async deleteLocation(id: string): Promise<boolean> {
    const { deleted } = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/api/data/locations/${encodeURIComponent(id)}`,
    );
    return deleted;
  }

  async addEvent(
    locationId: string,
    input: EventInput,
  ): Promise<HistoricalLocation> {
    const { location } = await this.request<{ location: HistoricalLocation }>(
      "POST",
      `/api/data/locations/${encodeURIComponent(locationId)}/events`,
      input,
    );
    return location;
  }

  async updateEvent(
    locationId: string,
    eventId: string,
    patch: UpdateEventInput,
  ): Promise<HistoricalEvent> {
    const { event } = await this.request<{ event: HistoricalEvent }>(
      "PATCH",
      `/api/data/locations/${encodeURIComponent(locationId)}/events/${encodeURIComponent(eventId)}`,
      patch,
    );
    return event;
  }

  async deleteEvent(locationId: string, eventId: string): Promise<boolean> {
    const { deleted } = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/api/data/locations/${encodeURIComponent(locationId)}/events/${encodeURIComponent(eventId)}`,
    );
    return deleted;
  }

  async searchEvents(query: EventQueryInput): Promise<EventSearchResult[]> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.fromYear !== undefined) params.set("from", String(query.fromYear));
    if (query.toYear !== undefined) params.set("to", String(query.toYear));
    if (query.sourceIds?.length) params.set("sources", query.sourceIds.join(","));
    if (query.bbox) params.set("bbox", query.bbox.join(","));

    const { results } = await this.request<{ results: EventSearchResult[] }>(
      "GET",
      `/api/data/search?${params.toString()}`,
    );
    return results;
  }
}

export function createMapClient(config?: MapClientConfig): MapClient {
  return new MapClient(config);
}
