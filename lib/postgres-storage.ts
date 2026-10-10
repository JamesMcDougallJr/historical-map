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
  DatePrecision,
  EventGroup,
  EventSource,
  HistoricalEventsData,
  HistoricalEvent,
  HistoricalLocation,
} from "../app/map/types";
import type { EventQuery } from "../app/map/utils/event-query";

let client: ReturnType<typeof postgres> | null = null;

function sql() {
  if (!client) {
    const url = process.env["POSTGRES_URL"];
    if (!url) throw new Error("POSTGRES_URL is not set");
    // Full-text search raises NOTICEs for stopword-only queries ("the") on
    // every request; they are expected and would otherwise flood the log.
    client = postgres(url, {
      max: 5,
      connection: { client_min_messages: "warning" },
    });
  }
  return client;
}

/** The shared client, for lib/search-postgres.ts. Same pool, same lifetime. */
export function sqlClient() {
  return sql();
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
  date_precision: DatePrecision | null;
  date_text: string | null;
  document_id: string | null;
  anchor: string | null;
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

    // Owned by the ingest side's TypeORM migration too (map-writer writes them
    // via raw SQL there). Adding them here as well means this file's own
    // schema management is self-sufficient on a Postgres that was only ever
    // seeded via `npm run seed:db`, without depending on ingest migrations
    // having run first.
    await db`ALTER TABLE events ADD COLUMN IF NOT EXISTS date_precision text`;
    await db`ALTER TABLE events ADD COLUMN IF NOT EXISTS date_text text`;
    await db`ALTER TABLE events ADD COLUMN IF NOT EXISTS document_id uuid`;
    await db`ALTER TABLE events ADD COLUMN IF NOT EXISTS anchor text`;
    await db`CREATE INDEX IF NOT EXISTS events_document_id_idx ON events (document_id)`;

    // Change watermark, read by readData(). Without it `lastUpdated` was
    // regenerated on every read, so the map's poll saw a "change" every 5s and
    // re-rendered regardless of whether anything had actually happened.
    await db`ALTER TABLE locations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;
    await db`ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;

    await db`CREATE INDEX IF NOT EXISTS events_location_id_idx ON events (location_id)`;
    await db`CREATE INDEX IF NOT EXISTS events_date_idx ON events (date)`;
    await db`CREATE INDEX IF NOT EXISTS events_source_id_idx ON events (source_id)`;

    await db`
      CREATE TABLE IF NOT EXISTS event_groups (
        id              text PRIMARY KEY,
        title           text NOT NULL,
        description     text,
        parent_group_id text REFERENCES event_groups(id) ON DELETE SET NULL
      )`;
    await db`
      CREATE TABLE IF NOT EXISTS event_group_members (
        group_id text NOT NULL REFERENCES event_groups(id) ON DELETE CASCADE,
        event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        seq      int  NOT NULL,
        PRIMARY KEY (group_id, event_id)
      )`;
    await db`CREATE INDEX IF NOT EXISTS event_group_members_event_idx ON event_group_members (event_id)`;

    await ensureSearchSchema();
  })();
  return schemaReady;
}

/**
 * Full-text and trigram search (plans/20-search-lexical.md). Everything here is
 * derived from columns above, so it can be dropped and rebuilt at will.
 *
 * Two text search configurations, both folding accents through `unaccent` so
 * "Tenochtitlan" and "Tenochtitlán" match either way — and, unlike wrapping
 * the input in `unaccent()`, `ts_headline` still highlights the original
 * accented word:
 *   - `hm_english` stems, for prose (titles, descriptions, quotes).
 *   - `hm_simple` doesn't, for names, where stemming mangles proper nouns and
 *     an exact name match should stay strong.
 *
 * `search_tsv` weights: title A, date_text B, description C, source quote D.
 * The place name is not in `events` — it gets its own vector on `locations`,
 * joined at query time rather than denormalised, so a renamed location
 * (`geocode:review --set`) can never leave stale text on its events.
 */
async function ensureSearchSchema(): Promise<void> {
  const db = sql();
  await db`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  await db`CREATE EXTENSION IF NOT EXISTS unaccent`;

  // `unaccent()` is STABLE, so it can't appear in an index expression. Naming
  // the dictionary explicitly makes the result fixed — the standard workaround.
  await db`
    CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
      AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$`;

  // No IF NOT EXISTS for text search configurations; concurrent first boots
  // race on the check, hence the exception handler.
  await db.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'hm_english') THEN
        CREATE TEXT SEARCH CONFIGURATION hm_english (COPY = english);
        ALTER TEXT SEARCH CONFIGURATION hm_english
          ALTER MAPPING FOR hword, hword_part, word WITH unaccent, english_stem;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'hm_simple') THEN
        CREATE TEXT SEARCH CONFIGURATION hm_simple (COPY = simple);
        ALTER TEXT SEARCH CONFIGURATION hm_simple
          ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
      END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END $$`);

  // The SQL twin of eventYearSpan() in packages/domain/src/date-interval.ts:
  // the inclusive span of years an event's date covers, given its precision.
  // Change both together.
  await db`
    CREATE OR REPLACE FUNCTION event_lo_year(d date, prec text) RETURNS int
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $$ SELECT CASE prec
        WHEN 'decade' THEN EXTRACT(YEAR FROM d)::int - (EXTRACT(YEAR FROM d)::int % 10)
        WHEN 'circa'  THEN EXTRACT(YEAR FROM d)::int - 5
        ELSE EXTRACT(YEAR FROM d)::int END $$`;
  await db`
    CREATE OR REPLACE FUNCTION event_hi_year(d date, prec text) RETURNS int
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $$ SELECT CASE prec
        WHEN 'decade' THEN EXTRACT(YEAR FROM d)::int - (EXTRACT(YEAR FROM d)::int % 10) + 9
        WHEN 'circa'  THEN EXTRACT(YEAR FROM d)::int + 5
        ELSE EXTRACT(YEAR FROM d)::int END $$`;

  await db`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS search_tsv tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('hm_english', coalesce(title, '')),       'A') ||
        setweight(to_tsvector('hm_english', coalesce(date_text, '')),   'B') ||
        setweight(to_tsvector('hm_english', coalesce(description, '')), 'C') ||
        setweight(to_tsvector('hm_english', coalesce(source, '')),      'D')
      ) STORED`;
  await db`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS name_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('hm_simple', coalesce(title, ''))) STORED`;
  await db`CREATE INDEX IF NOT EXISTS events_search_tsv_idx ON events USING GIN (search_tsv)`;
  await db`CREATE INDEX IF NOT EXISTS events_name_tsv_idx ON events USING GIN (name_tsv)`;
  await db`CREATE INDEX IF NOT EXISTS events_title_trgm_idx ON events USING GIN (immutable_unaccent(title) gin_trgm_ops)`;

  await db`
    ALTER TABLE locations ADD COLUMN IF NOT EXISTS search_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('hm_simple', coalesce(name, ''))) STORED`;
  await db`CREATE INDEX IF NOT EXISTS locations_search_tsv_idx ON locations USING GIN (search_tsv)`;
  await db`CREATE INDEX IF NOT EXISTS locations_name_trgm_idx ON locations USING GIN (immutable_unaccent(name) gin_trgm_ops)`;

  await db`
    ALTER TABLE event_groups ADD COLUMN IF NOT EXISTS search_tsv tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('hm_english', coalesce(title, '')),       'A') ||
        setweight(to_tsvector('hm_english', coalesce(description, '')), 'C')
      ) STORED`;
  await db`
    ALTER TABLE event_groups ADD COLUMN IF NOT EXISTS name_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('hm_simple', coalesce(title, ''))) STORED`;
  await db`CREATE INDEX IF NOT EXISTS event_groups_search_tsv_idx ON event_groups USING GIN (search_tsv)`;
  await db`CREATE INDEX IF NOT EXISTS event_groups_title_trgm_idx ON event_groups USING GIN (immutable_unaccent(title) gin_trgm_ops)`;
}

function toEvent(row: EventRow, groupIds?: string[]): HistoricalEvent {
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
  // Without these the stored representative day is indistinguishable from a
  // real one, and a year-only event renders as "January 1".
  if (row.date_precision) event.datePrecision = row.date_precision;
  if (row.date_text) event.dateText = row.date_text;
  // Both needed to build the "view source" link: which document, and which
  // page of it. `document_id` has existed since publish started writing it;
  // it was never selected here, so it never reached the client either.
  if (row.document_id) event.documentId = row.document_id;
  if (row.anchor) event.anchor = row.anchor;
  // Derived read-time convenience — never written directly, only populated
  // by scanning event_group_members.
  if (groupIds?.length) event.groupIds = groupIds;
  return event;
}

/** Batch-fetches group membership for a set of event ids, grouped by event. */
async function groupIdsByEventId(
  eventIds: string[],
): Promise<Map<string, string[]>> {
  const byEvent = new Map<string, string[]>();
  if (eventIds.length === 0) return byEvent;
  const rows = await sql()<
    { group_id: string; event_id: string }[]
  >`SELECT group_id, event_id FROM event_group_members WHERE event_id = ANY(${eventIds})`;
  for (const row of rows) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push(row.group_id);
    byEvent.set(row.event_id, list);
  }
  return byEvent;
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
  const groupIds = await groupIdsByEventId(eventRows.map((r) => r.id));

  const byLocation = new Map<string, HistoricalEvent[]>();
  for (const row of eventRows) {
    const list = byLocation.get(row.location_id) ?? [];
    list.push(toEvent(row, groupIds.get(row.id)));
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

/**
 * Looks up what `ingest_documents` knows about a document, for the
 * "view source" link. Reads a table the ingestion side's TypeORM migrations
 * own — safe as a plain query, since the two apps already share one Postgres
 * and this file already crosses that boundary for `document_id`/`anchor` on
 * `events`. Returns null for a document that predates ingestion (hand-entered
 * events have no `documentId` in the first place) or was never fetched.
 */
export async function getIngestedDocument(
  documentId: string,
): Promise<{ title: string | null; originalKey: string | null } | null> {
  const rows = await sql()<
    { title: string | null; original_key: string | null }[]
  >`SELECT title, original_key FROM ingest_documents WHERE id = ${documentId}`;
  const row = rows[0];
  if (!row) return null;
  return { title: row.title, originalKey: row.original_key };
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

/**
 * Newest `updated_at` across locations and events, or the epoch when both are
 * empty. This is the value `lastUpdated` reports, and the map's 5s poll uses it
 * as a change guard — so it has to actually change only when data changes.
 *
 * `GREATEST` ignores NULL arguments in Postgres and returns NULL only when
 * every argument is NULL, which is exactly the empty-database case.
 */
async function changeWatermark(): Promise<string> {
  const [row] = await sql()<{ last_updated: Date | null }[]>`
    SELECT GREATEST(
      (SELECT MAX(updated_at) FROM locations),
      (SELECT MAX(updated_at) FROM events)
    ) AS last_updated`;
  return row?.last_updated?.toISOString() ?? new Date(0).toISOString();
}

export async function readData(): Promise<HistoricalEventsData> {
  await ensureSchema();
  const rows = await sql()<
    LocationRow[]
  >`SELECT id, name, lon, lat FROM locations ORDER BY name ASC`;
  return {
    version: "1.0.0",
    lastUpdated: await changeWatermark(),
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
      SET name = EXCLUDED.name, lon = EXCLUDED.lon, lat = EXCLUDED.lat,
          updated_at = now()`;
  for (const e of loc.events) await insertEvent(loc.id, e);
}

async function insertEvent(
  locationId: string,
  e: HistoricalEvent,
): Promise<void> {
  await sql()`
    INSERT INTO events (id, location_id, source_id, title, date, description, image_url, source, tags, date_precision, date_text)
    VALUES (${e.id}, ${locationId}, ${e.sourceId ?? null}, ${e.title}, ${e.date},
            ${e.description}, ${e.imageUrl ?? null}, ${e.source ?? null},
            ${e.tags ?? null}, ${e.datePrecision ?? null}, ${e.dateText ?? null})
    ON CONFLICT (id) DO NOTHING`;
}

export async function deleteLocation(id: string): Promise<boolean> {
  await ensureSchema();
  // Events go with it via ON DELETE CASCADE.
  const result = await sql()`DELETE FROM locations WHERE id = ${id}`;
  return result.count > 0;
}

export async function updateLocation(
  id: string,
  patch: { name?: string; coordinates?: [number, number] },
): Promise<HistoricalLocation | null> {
  await ensureSchema();
  const rows = await sql()<LocationRow[]>`
    UPDATE locations
    SET name = COALESCE(${patch.name ?? null}, name),
        lon = COALESCE(${patch.coordinates?.[0] ?? null}, lon),
        lat = COALESCE(${patch.coordinates?.[1] ?? null}, lat),
        updated_at = now()
    WHERE id = ${id}
    RETURNING id, name, lon, lat`;
  const row = rows[0];
  if (!row) return null;
  const [updated] = await assemble([row]);
  return updated ?? null;
}

export async function updateEvent(
  locationId: string,
  eventId: string,
  patch: Partial<
    Pick<
      HistoricalEvent,
      | "title"
      | "date"
      | "description"
      | "datePrecision"
      | "dateText"
      | "source"
      | "sourceId"
      | "tags"
      | "imageUrl"
    >
  >,
): Promise<HistoricalEvent | null> {
  await ensureSchema();
  const rows = await sql()<EventRow[]>`
    UPDATE events
    SET title = COALESCE(${patch.title ?? null}, title),
        date = COALESCE(${patch.date ?? null}, date),
        description = COALESCE(${patch.description ?? null}, description),
        date_precision = COALESCE(${patch.datePrecision ?? null}, date_precision),
        date_text = COALESCE(${patch.dateText ?? null}, date_text),
        source = COALESCE(${patch.source ?? null}, source),
        source_id = COALESCE(${patch.sourceId ?? null}, source_id),
        tags = COALESCE(${patch.tags ?? null}, tags),
        image_url = COALESCE(${patch.imageUrl ?? null}, image_url),
        updated_at = now()
    WHERE id = ${eventId} AND location_id = ${locationId}
    RETURNING *`;
  const row = rows[0];
  return row ? toEvent(row) : null;
}

export async function deleteEvent(
  locationId: string,
  eventId: string,
): Promise<boolean> {
  await ensureSchema();
  const result = await sql()`
    DELETE FROM events WHERE id = ${eventId} AND location_id = ${locationId}`;
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

// ── Event groups ────────────────────────────────────────────────────────────

interface EventGroupRow {
  id: string;
  title: string;
  description: string | null;
  parent_group_id: string | null;
}

function toEventGroup(
  row: EventGroupRow,
  memberEventIds: string[],
): EventGroup {
  const group: EventGroup = {
    id: row.id,
    title: row.title,
    memberEventIds,
  };
  if (row.description) group.description = row.description;
  if (row.parent_group_id) group.parentGroupId = row.parent_group_id;
  return group;
}

/** Groups a member-rows query result by group_id, in seq order. */
function memberIdsByGroup(
  memberRows: { group_id: string; event_id: string }[],
): Map<string, string[]> {
  const byGroup = new Map<string, string[]>();
  for (const row of memberRows) {
    const list = byGroup.get(row.group_id) ?? [];
    list.push(row.event_id);
    byGroup.set(row.group_id, list);
  }
  return byGroup;
}

export async function listEventGroups(): Promise<EventGroup[]> {
  await ensureSchema();
  const db = sql();
  const rows = await db<
    EventGroupRow[]
  >`SELECT * FROM event_groups ORDER BY title ASC`;
  const memberRows = await db<
    { group_id: string; event_id: string }[]
  >`SELECT group_id, event_id FROM event_group_members ORDER BY group_id, seq`;
  const byGroup = memberIdsByGroup(memberRows);
  return rows.map((row) => toEventGroup(row, byGroup.get(row.id) ?? []));
}

/**
 * Walks `parent_group_id` downward from `startId`, returning `startId` plus
 * every descendant group id. Plain repeated queries rather than a recursive
 * CTE, matching this file's existing style.
 */
async function descendantGroupIds(startId: string): Promise<string[]> {
  const db = sql();
  const all = new Set([startId]);
  let frontier = [startId];
  while (frontier.length > 0) {
    const rows = await db<
      { id: string }[]
    >`SELECT id FROM event_groups WHERE parent_group_id = ANY(${frontier})`;
    const next = rows.map((r) => r.id).filter((id) => !all.has(id));
    for (const id of next) all.add(id);
    frontier = next;
  }
  return Array.from(all);
}

export async function getEventGroup(
  id: string,
  opts?: { includeDescendants?: boolean },
): Promise<{ group: EventGroup; members: HistoricalLocation[] } | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db<EventGroupRow[]>`SELECT * FROM event_groups WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return null;

  const groupIds = opts?.includeDescendants
    ? await descendantGroupIds(id)
    : [id];

  const memberRows = await db<
    { group_id: string; event_id: string }[]
  >`SELECT group_id, event_id FROM event_group_members WHERE group_id = ANY(${groupIds}) ORDER BY group_id, seq`;
  const byGroup = memberIdsByGroup(memberRows);

  // Union member ids across the resolved groups, in first-seen order.
  const memberEventIds: string[] = [];
  const seen = new Set<string>();
  for (const gid of groupIds) {
    for (const eventId of byGroup.get(gid) ?? []) {
      if (!seen.has(eventId)) {
        seen.add(eventId);
        memberEventIds.push(eventId);
      }
    }
  }

  const group = toEventGroup(row, byGroup.get(id) ?? []);

  if (memberEventIds.length === 0) return { group, members: [] };

  const eventRows = await db<
    (EventRow & LocationRow & { loc_name: string })[]
  >`
    SELECT e.*, l.name AS loc_name, l.lon, l.lat
    FROM events e
    JOIN locations l ON l.id = e.location_id
    WHERE e.id = ANY(${memberEventIds})`;

  const byEventId = new Map(eventRows.map((r) => [r.id, r]));
  const byLocation = new Map<string, HistoricalLocation>();
  for (const eventId of memberEventIds) {
    const r = byEventId.get(eventId);
    if (!r) continue;
    let loc = byLocation.get(r.location_id);
    if (!loc) {
      loc = {
        id: r.location_id,
        name: r.loc_name,
        coordinates: [r.lon, r.lat] as [number, number],
        events: [],
      };
      byLocation.set(r.location_id, loc);
    }
    loc.events.push(toEvent(r));
  }

  return { group, members: Array.from(byLocation.values()) };
}

export async function upsertEventGroup(
  group: Pick<EventGroup, "id" | "title" | "description" | "parentGroupId">,
): Promise<void> {
  await ensureSchema();
  await sql()`
    INSERT INTO event_groups (id, title, description, parent_group_id)
    VALUES (${group.id}, ${group.title}, ${group.description ?? null},
            ${group.parentGroupId ?? null})
    ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          description = EXCLUDED.description,
          parent_group_id = EXCLUDED.parent_group_id`;
}

export async function setEventGroupMembers(
  groupId: string,
  eventIds: string[],
): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db.begin(async (tx) => {
    await tx`DELETE FROM event_group_members WHERE group_id = ${groupId}`;
    for (let i = 0; i < eventIds.length; i++) {
      await tx`
        INSERT INTO event_group_members (group_id, event_id, seq)
        VALUES (${groupId}, ${eventIds[i]!}, ${i})`;
    }
  });
}

export async function deleteEventGroup(id: string): Promise<boolean> {
  await ensureSchema();
  const result = await sql()`DELETE FROM event_groups WHERE id = ${id}`;
  return result.count > 0;
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

  // Same matcher as /api/search (lib/search-postgres.ts): stemmed full text
  // plus unstemmed names, ranked. Not date-parsed — EventQuery has its own
  // fromYear/toYear, and these callers predate the search bar.
  const q = query.q?.trim() || null;
  const from = query.fromYear !== undefined ? `${query.fromYear}-01-01` : null;
  const to = query.toYear !== undefined ? `${query.toYear}-12-31` : null;
  const bbox = query.bbox ?? null;
  const sourceIds = query.sourceIds?.length ? query.sourceIds : null;
  const groupEventIds = query.groupId
    ? await resolveGroupEventIds(query.groupId, query.includeDescendants)
    : null;

  const rows = await db<(EventRow & LocationRow & { loc_name: string })[]>`
    SELECT e.*, l.name AS loc_name, l.lon, l.lat
    FROM events e
    JOIN locations l ON l.id = e.location_id
    WHERE (${q}::text IS NULL
           OR e.search_tsv @@ websearch_to_tsquery('hm_english', ${q}::text)
           OR e.name_tsv @@ websearch_to_tsquery('hm_simple', ${q}::text)
           OR l.search_tsv @@ websearch_to_tsquery('hm_simple', ${q}::text))
      AND (${from}::date IS NULL OR e.date >= ${from}::date)
      AND (${to}::date IS NULL OR e.date <= ${to}::date)
      AND (${sourceIds}::text[] IS NULL OR e.source_id = ANY(${sourceIds}))
      AND (${groupEventIds}::text[] IS NULL OR e.id = ANY(${groupEventIds}))
      AND (${query.documentId ?? null}::text IS NULL OR e.document_id::text = ${query.documentId ?? null})
      AND (${bbox}::double precision[] IS NULL
           OR ST_Intersects(
                l.geom,
                ST_MakeEnvelope(${bbox?.[0] ?? 0}, ${bbox?.[1] ?? 0},
                                ${bbox?.[2] ?? 0}, ${bbox?.[3] ?? 0}, 4326)))
    ORDER BY CASE WHEN ${q}::text IS NULL THEN 0
                  ELSE ts_rank_cd(e.search_tsv, websearch_to_tsquery('hm_english', ${q}::text)) END DESC,
             e.date ASC`;

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

/** Resolves a groupId (+ optional descendants) filter to its member event ids. */
async function resolveGroupEventIds(
  groupId: string,
  includeDescendants?: boolean,
): Promise<string[]> {
  const db = sql();
  const groupIds = includeDescendants
    ? await descendantGroupIds(groupId)
    : [groupId];
  const rows = await db<
    { event_id: string }[]
  >`SELECT DISTINCT event_id FROM event_group_members WHERE group_id = ANY(${groupIds})`;
  return rows.map((r) => r.event_id);
}
