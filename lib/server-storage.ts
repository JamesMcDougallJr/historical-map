// Server-side storage for map data — used by the MCP server and API routes.
// API mirrors app/map/utils/storage.ts (browser), but async, because the
// Postgres backend below cannot be synchronous.
//
// Two backends, chosen by whether POSTGRES_URL is set:
//   - Postgres  (deployed): the source of truth, survives serverless restarts
//   - JSON file (local dev / stdio MCP): data/map-data.json, no infra needed
//
// Seed Postgres from the JSON file with `npm run seed:db`.

import fs from "node:fs";
import path from "node:path";
import type {
  EventSource,
  HistoricalEventsData,
  HistoricalEvent,
  HistoricalLocation,
} from "@/app/map/types";
import {
  eventYear,
  type EventQuery,
  type EventSearchResult,
} from "@/app/map/utils/event-query";
import * as pg from "./postgres-storage";

const DATA_PATH =
  process.env["MAP_DATA_PATH"] ?? path.resolve("data/map-data.json");

const DEFAULT_DATA: HistoricalEventsData = {
  version: "1.0.0",
  lastUpdated: new Date().toISOString(),
  locations: [],
};

function usePostgres(): boolean {
  return Boolean(process.env["POSTGRES_URL"]);
}

// ── JSON file backend ───────────────────────────────────────────────────────

function readFileData(): HistoricalEventsData {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf-8");
    return JSON.parse(raw) as HistoricalEventsData;
  } catch {
    return { ...DEFAULT_DATA, lastUpdated: new Date().toISOString() };
  }
}

/** Atomic write: tmp file → rename, prevents corrupt reads. */
function writeFileData(data: HistoricalEventsData): void {
  const toWrite: HistoricalEventsData = {
    ...data,
    lastUpdated: new Date().toISOString(),
  };
  const json = JSON.stringify(toWrite, null, 2);
  const tmp = DATA_PATH + ".tmp";
  fs.writeFileSync(tmp, json, "utf-8");
  fs.renameSync(tmp, DATA_PATH);
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function readData(): Promise<HistoricalEventsData> {
  return usePostgres() ? pg.readData() : readFileData();
}

export async function writeData(data: HistoricalEventsData): Promise<void> {
  if (usePostgres()) return pg.writeData(data);
  writeFileData(data);
}

export async function getLocations(): Promise<HistoricalLocation[]> {
  return (await readData()).locations;
}

export async function getLocation(
  id: string,
): Promise<HistoricalLocation | undefined> {
  return (await getLocations()).find((l) => l.id === id);
}

export async function upsertLocation(loc: HistoricalLocation): Promise<void> {
  if (usePostgres()) return pg.upsertLocation(loc);

  const data = readFileData();
  const idx = data.locations.findIndex((l) => l.id === loc.id);
  if (idx >= 0) {
    data.locations[idx] = loc;
  } else {
    data.locations.push(loc);
  }
  writeFileData(data);
}

export async function deleteLocation(id: string): Promise<boolean> {
  if (usePostgres()) return pg.deleteLocation(id);

  const data = readFileData();
  const before = data.locations.length;
  data.locations = data.locations.filter((l) => l.id !== id);
  if (data.locations.length === before) return false;
  writeFileData(data);
  return true;
}

export async function addEventsToLocation(
  locationId: string,
  events: HistoricalEvent[],
): Promise<HistoricalLocation | null> {
  if (usePostgres()) return pg.addEventsToLocation(locationId, events);

  const data = readFileData();
  const loc = data.locations.find((l) => l.id === locationId);
  if (!loc) return null;

  const existingIds = new Set(loc.events.map((e) => e.id));
  const newEvents = events.filter((e) => !existingIds.has(e.id));
  loc.events = [...loc.events, ...newEvents];
  writeFileData(data);
  return loc;
}

export async function listSources(): Promise<EventSource[]> {
  if (usePostgres()) return pg.listSources();
  return readFileData().sources ?? [];
}

/**
 * Spatial + temporal search. Under Postgres this becomes indexed SQL; on the
 * static backend the identical filters run in memory. Same results either way.
 */
export async function searchEvents(
  query: EventQuery,
): Promise<EventSearchResult[]> {
  if (usePostgres()) return pg.searchEvents(query);

  const { q, fromYear, toYear, sourceIds, bbox } = query;
  const lower = q?.toLowerCase();
  const sourceFilter = sourceIds?.length ? new Set(sourceIds) : null;
  const results: EventSearchResult[] = [];

  for (const location of readFileData().locations) {
    if (bbox) {
      const [lon, lat] = location.coordinates;
      const [minLon, minLat, maxLon, maxLat] = bbox;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat)
        continue;
    }

    for (const event of location.events) {
      if (sourceFilter && !sourceFilter.has(event.sourceId ?? "")) continue;

      if (lower) {
        const matchesText =
          event.title.toLowerCase().includes(lower) ||
          event.description.toLowerCase().includes(lower) ||
          location.name.toLowerCase().includes(lower);
        if (!matchesText) continue;
      }

      if (fromYear !== undefined || toYear !== undefined) {
        const year = eventYear(event.date);
        if (fromYear !== undefined && year < fromYear) continue;
        if (toYear !== undefined && year > toYear) continue;
      }

      results.push({ location, event });
    }
  }
  return results;
}
