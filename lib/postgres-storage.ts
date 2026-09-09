// Postgres/PostGIS backend for map data. Used by lib/server-storage.ts whenever
// POSTGRES_URL is set; the JSON file backend takes over when it isn't.
//
// Uses postgres.js (plain TCP) rather than @vercel/postgres, which transports
// over WebSockets and hardcodes a "-pooler." check on the connection string —
// it cannot talk to the local PostGIS container that Martin reads from.
//
// Schema is created on demand by ensureSchema() so a fresh database works
// without a migration step. Seed it with `npm run seed:db`.

import postgres from "postgres";
import type {
  EventSource,
  HistoricalEventsData,
  HistoricalEvent,
  HistoricalLocation,
} from "@/app/map/types";
import type { EventQuery } from "@/app/map/utils/event-query";

let client: ReturnType<typeof postgres> | null = null;

function sql() {
  if (!client) {
    const url = process.env["POSTGRES_URL"];
    if (!url) throw new Error("POSTGRES_URL is not set");
    client = postgres(url, { max: 5 });
  }
  return client;
}

interface LocationRow {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

interface EventRow {
  id: string;
  location_id: string;
  source_id: string | null;
  title: string;
  date: string;
  description: string;
  image_url: string | null;
  source: string | null;
  tags: string[] | null;
}

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  // Memoised per process — concurrent callers await the same round trip.
  schemaReady ??= (async () => {
    const db = sql();
    await db`CREATE EXTENSION IF NOT EXISTS postgis`;

    await db`
      CREATE TABLE IF NOT EXISTS sources (
        id           text PRIMARY KEY,
        name         text NOT NULL,
        description  text,
        homepage_url text,
        attribution  text,
        color        text
      )`;

    await db`
      CREATE TABLE IF NOT EXISTS locations (
        id   text PRIMARY KEY,
        name text NOT NULL,
        lon  double precision NOT NULL,
        lat  double precision NOT NULL
      )`;

    // Generated geometry keeps lon/lat authoritative while giving PostGIS
    // something to index — and giving Martin a discoverable geometry column.
    await db`
      ALTER TABLE locations ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326)
        GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) STORED`;
    await db`CREATE INDEX IF NOT EXISTS locations_geom_idx ON locations USING GIST (geom)`;

    await db`
      CREATE TABLE IF NOT EXISTS events (
        id          text PRIMARY KEY,
        location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        source_id   text REFERENCES sources(id) ON DELETE SET NULL,
        title       text NOT NULL,
        date        date NOT NULL,
        description text NOT NULL,
        image_url   text,
        source      text,
        tags        text[]
      )`;
    await db`ALTER TABLE events ADD COLUMN IF NOT EXISTS source_id text REFERENCES sources(id) ON DELETE SET NULL`;

    await db`CREATE INDEX IF NOT EXISTS events_location_id_idx ON events (location_id)`;
    await db`CREATE INDEX IF NOT EXISTS events_date_idx ON events (date)`;
    await db`CREATE INDEX IF NOT EXISTS events_source_id_idx ON events (source_id)`;
  })();
  return schemaReady;
}

function toEvent(row: EventRow): HistoricalEvent {
  const event: HistoricalEvent = {
    id: row.id,
    title: row.title,
    // `date` comes back as a Date; the app wants YYYY-MM-DD.
    date: new Date(row.date).toISOString().slice(0, 10),
    description: row.description,
  };
  if (row.image_url) event.imageUrl = row.image_url;
  if (row.source) event.source = row.source;
  if (row.tags) event.tags = row.tags;
  if (row.source_id) event.sourceId = row.source_id;
  return event;
}

/** Assembles locations + their events. Two queries, joined in memory. */
async function assemble(
  locationRows: LocationRow[],
): Promise<HistoricalLocation[]> {
  if (locationRows.length === 0) return [];
  const db = sql();
  const ids = locationRows.map((l) => l.id);
  const eventRows = await db<EventRow[]>`
    SELECT * FROM events WHERE location_id = ANY(${ids}) ORDER BY date ASC`;

  const byLocation = new Map<string, HistoricalEvent[]>();
  for (const row of eventRows) {
    const list = byLocation.get(row.location_id) ?? [];
    list.push(toEvent(row));
    byLocation.set(row.location_id, list);
  }

  return locationRows.map((l) => ({
    id: l.id,
    name: l.name,
    coordinates: [l.lon, l.lat] as [number, number],
    events: byLocation.get(l.id) ?? [],
  }));
}

/**
 * Runs a raw SQL script (multi-statement). Used by the seed script to install
 * db/martin-functions.sql; not for user input.
 */
export async function execSql(script: string): Promise<void> {
  await ensureSchema();
  await sql().unsafe(script);
}

// ── Sources ─────────────────────────────────────────────────────────────────

export async function listSources(): Promise<EventSource[]> {
  await ensureSchema();
  const rows = await sql()<
    {
      id: string;
      name: string;
      description: string | null;
      homepage_url: string | null;
      attribution: string | null;
      color: string | null;
    }[]
  >`SELECT * FROM sources ORDER BY name ASC`;

  return rows.map((r) => {
    const s: EventSource = { id: r.id, name: r.name };
    if (r.description) s.description = r.description;
    if (r.homepage_url) s.homepageUrl = r.homepage_url;
    if (r.attribution) s.attribution = r.attribution;
    if (r.color) s.color = r.color;
    return s;
  });
}

export async function upsertSource(source: EventSource): Promise<void> {
  await ensureSchema();
  await sql()`
    INSERT INTO sources (id, name, description, homepage_url, attribution, color)
    VALUES (${source.id}, ${source.name}, ${source.description ?? null},
            ${source.homepageUrl ?? null}, ${source.attribution ?? null},
            ${source.color ?? null})
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          description = EXCLUDED.description,
          homepage_url = EXCLUDED.homepage_url,
          attribution = EXCLUDED.attribution,
          color = EXCLUDED.color`;
}

// ── Locations & events ──────────────────────────────────────────────────────

export async function readData(): Promise<HistoricalEventsData> {
  await ensureSchema();
  const rows = await sql()<
    LocationRow[]
  >`SELECT id, name, lon, lat FROM locations ORDER BY name ASC`;
  return {
    version: "1.0.0",
    lastUpdated: new Date().toISOString(),
    locations: await assemble(rows),
    sources: await listSources(),
  };
}

export async function writeData(data: HistoricalEventsData): Promise<void> {
  await ensureSchema();
  for (const source of data.sources ?? []) await upsertSource(source);
  for (const location of data.locations) await upsertLocation(location);
}

export async function upsertLocation(loc: HistoricalLocation): Promise<void> {
  await ensureSchema();
  const [lon, lat] = loc.coordinates;
  await sql()`
    INSERT INTO locations (id, name, lon, lat)
    VALUES (${loc.id}, ${loc.name}, ${lon}, ${lat})
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name, lon = EXCLUDED.lon, lat = EXCLUDED.lat`;
  for (const e of loc.events) await insertEvent(loc.id, e);
}

async function insertEvent(
  locationId: string,
  e: HistoricalEvent,
): Promise<void> {
  await sql()`
    INSERT INTO events (id, location_id, source_id, title, date, description, image_url, source, tags)
    VALUES (${e.id}, ${locationId}, ${e.sourceId ?? null}, ${e.title}, ${e.date},
            ${e.description}, ${e.imageUrl ?? null}, ${e.source ?? null},
            ${e.tags ?? null})
    ON CONFLICT (id) DO NOTHING`;
}

export async function deleteLocation(id: string): Promise<boolean> {
  await ensureSchema();
  // Events go with it via ON DELETE CASCADE.
  const result = await sql()`DELETE FROM locations WHERE id = ${id}`;
  return result.count > 0;
}

export async function addEventsToLocation(
  locationId: string,
  events: HistoricalEvent[],
): Promise<HistoricalLocation | null> {
  await ensureSchema();
  const rows = await sql()<
    LocationRow[]
  >`SELECT id, name, lon, lat FROM locations WHERE id = ${locationId}`;
  const row = rows[0];
  if (!row) return null;

  for (const e of events) await insertEvent(locationId, e);
  const [updated] = await assemble([row]);
  return updated ?? null;
}

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Spatial + temporal search. This is the query the GIST and date indexes exist
 * to serve: bbox via ST_Intersects, year range on events.date, plus optional
 * source and free-text filters.
 */
export async function searchEvents(
  query: EventQuery,
): Promise<Array<{ location: HistoricalLocation; event: HistoricalEvent }>> {
  await ensureSchema();
  const db = sql();

  const like = query.q ? `%${query.q}%` : null;
  const from = query.fromYear !== undefined ? `${query.fromYear}-01-01` : null;
  const to = query.toYear !== undefined ? `${query.toYear}-12-31` : null;
  const bbox = query.bbox ?? null;
  const sourceIds = query.sourceIds?.length ? query.sourceIds : null;

  const rows = await db<(EventRow & LocationRow & { loc_name: string })[]>`
    SELECT e.*, l.name AS loc_name, l.lon, l.lat
    FROM events e
    JOIN locations l ON l.id = e.location_id
    WHERE (${like}::text IS NULL
           OR e.title ILIKE ${like} OR e.description ILIKE ${like} OR l.name ILIKE ${like})
      AND (${from}::date IS NULL OR e.date >= ${from}::date)
      AND (${to}::date IS NULL OR e.date <= ${to}::date)
      AND (${sourceIds}::text[] IS NULL OR e.source_id = ANY(${sourceIds}))
      AND (${bbox}::double precision[] IS NULL
           OR ST_Intersects(
                l.geom,
                ST_MakeEnvelope(${bbox?.[0] ?? 0}, ${bbox?.[1] ?? 0},
                                ${bbox?.[2] ?? 0}, ${bbox?.[3] ?? 0}, 4326)))
    ORDER BY e.date ASC`;

  return rows.map((row) => ({
    event: toEvent(row),
    location: {
      id: row.location_id,
      name: row.loc_name,
      coordinates: [row.lon, row.lat] as [number, number],
      events: [toEvent(row)],
    },
  }));
}
