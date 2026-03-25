// Node.js file-based storage for map data — used by the MCP server and API routes.
// Reads/writes data/map-data.json. API mirrors app/map/utils/storage.ts (browser).

import fs from "node:fs";
import path from "node:path";
import type {
  HistoricalEventsData,
  HistoricalEvent,
  HistoricalLocation,
} from "@/app/map/types";

const DATA_PATH =
  process.env["MAP_DATA_PATH"] ?? path.resolve("data/map-data.json");

const DEFAULT_DATA: HistoricalEventsData = {
  version: "1.0.0",
  lastUpdated: new Date().toISOString(),
  locations: [],
};

export function readData(): HistoricalEventsData {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf-8");
    return JSON.parse(raw) as HistoricalEventsData;
  } catch {
    return { ...DEFAULT_DATA, lastUpdated: new Date().toISOString() };
  }
}

/** Atomic write: tmp file → rename, prevents corrupt reads. */
export function writeData(data: HistoricalEventsData): void {
  const toWrite: HistoricalEventsData = {
    ...data,
    lastUpdated: new Date().toISOString(),
  };
  const json = JSON.stringify(toWrite, null, 2);
  const tmp = DATA_PATH + ".tmp";
  fs.writeFileSync(tmp, json, "utf-8");
  fs.renameSync(tmp, DATA_PATH);
}

export function getLocations(): HistoricalLocation[] {
  return readData().locations;
}

export function getLocation(id: string): HistoricalLocation | undefined {
  return getLocations().find((l) => l.id === id);
}

export function upsertLocation(loc: HistoricalLocation): void {
  const data = readData();
  const idx = data.locations.findIndex((l) => l.id === loc.id);
  if (idx >= 0) {
    data.locations[idx] = loc;
  } else {
    data.locations.push(loc);
  }
  writeData(data);
}

export function deleteLocation(id: string): boolean {
  const data = readData();
  const before = data.locations.length;
  data.locations = data.locations.filter((l) => l.id !== id);
  if (data.locations.length === before) return false;
  writeData(data);
  return true;
}

export function addEventsToLocation(
  locationId: string,
  events: HistoricalEvent[],
): HistoricalLocation | null {
  const data = readData();
  const loc = data.locations.find((l) => l.id === locationId);
  if (!loc) return null;

  const existingIds = new Set(loc.events.map((e) => e.id));
  const newEvents = events.filter((e) => !existingIds.has(e.id));
  loc.events = [...loc.events, ...newEvents];
  writeData(data);
  return loc;
}

export function searchEvents(
  q: string,
  fromYear?: number,
  toYear?: number,
): Array<{ location: HistoricalLocation; event: HistoricalEvent }> {
  const lower = q.toLowerCase();
  const results: Array<{
    location: HistoricalLocation;
    event: HistoricalEvent;
  }> = [];

  for (const location of getLocations()) {
    for (const event of location.events) {
      const matchesText =
        event.title.toLowerCase().includes(lower) ||
        event.description.toLowerCase().includes(lower) ||
        location.name.toLowerCase().includes(lower);

      if (!matchesText) continue;

      if (fromYear !== undefined || toYear !== undefined) {
        const year = new Date(event.date).getFullYear();
        if (fromYear !== undefined && year < fromYear) continue;
        if (toYear !== undefined && year > toYear) continue;
      }

      results.push({ location, event });
    }
  }
  return results;
}
