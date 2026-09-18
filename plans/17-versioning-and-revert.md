# Phase 17 — Per-record version history and revert

**Status: design only — not implemented.** Route to: every `locations` and
`events` row keeps a history of its previous states, an admin can revert to
any of them, and a corrected geocode can actually move an already-published
pin instead of only affecting future publishes. No UI toggle on the public
map — confirmed out of scope; the real ask is "make sure we can revert,"
not "let visitors browse old versions."

## Scope, confirmed

- **Granularity: per-record**, not per-layer. Each `locations`/`events` row
  has its own history; there's no single "layer version" concept.
- **Two triggers, both named explicitly**: an admin edit (already possible
  via `apps/admin`, built in the admin-panel work) and a corrected
  geocode (`geocode_cache` fixed via `geocode:review --set`, which today
  only affects *future* publishes — this phase is also the fix for that).
- **No public-map UI change.** History and revert live in the admin app
  only.

## The gap this closes (confirmed via the actual code)

`MapWriterService.findOrCreateLocation` (`services/ingest/apps/workers/publish/src/publishing/map-writer.service.ts`)
derives a location's `id` from a hash of its **coordinates**:

```ts
function locationId(name: string, lon: number, lat: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")...
  const digest = createHash("sha256")
    .update(`${lon.toFixed(4)},${lat.toFixed(4)}`)
    .digest("hex").slice(0, 8);
  return `${slug}-${digest}`;
}
```

This is worth stating plainly because it shapes the fix: a location's **id
is derived from the very coordinates a correction needs to change.**
Re-running `findOrCreateLocation` with corrected coordinates doesn't update
the wrong pin — it mints a *new* id and creates a second row, leaving the
original (wrong) one behind. So the fix cannot be "call the same
find-or-create path again" — it has to be an explicit `UPDATE locations SET
lon = ..., lat = ... WHERE id = ...` against the *existing* row, keeping its
id stable (anything with a `location_id` FK, and anyone with a bookmarked
map link, depends on that id not changing).

`insertEvent`'s own doc comment already says the quiet part about events:
*"this means an event is never corrected by re-publishing."* That gap is
**not** in scope here — the two confirmed triggers (admin edit, gazetteer
correction) are both about **locations**, not event content. Events still
get history + revert (for admin edits to title/description/date/etc via
`apps/admin`), just not a "republish updates content" mechanism — that
would be solving a problem nobody described.

## Design

### 1. History tables

Two new tables, one per versioned entity — not a shared polymorphic table,
matching how this codebase already prefers explicit schema over generics
(see `ingest_extractions` vs. trying to reuse one generic "artifacts"
table).

```sql
CREATE TABLE location_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  lon           double precision NOT NULL,
  lat           double precision NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  change_reason text NOT NULL,   -- 'admin_edit' | 'geocode_correction' | 'revert'
  changed_by    text             -- nullable; no real admin auth yet, see below
);
CREATE INDEX location_history_location_id_idx ON location_history (location_id);

CREATE TABLE event_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title          text NOT NULL,
  date           date NOT NULL,
  description    text NOT NULL,
  image_url      text,
  source         text,
  tags           text[],
  date_precision text,
  date_text      text,
  source_id      text,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  change_reason  text NOT NULL,
  changed_by     text
);
CREATE INDEX event_history_event_id_idx ON event_history (event_id);
```

Each row is a **prior** state — the current state always lives in
`locations`/`events` themselves, which is also why "show the latest by
default" needs zero code: every existing read path (Martin's `event_pins`,
`/api/data/*`, the admin app) already only ever reads the live tables and
stays completely unaware these history tables exist.

### 2. Capture history with a trigger, not per-call-site code

The strong recommendation here is a Postgres `BEFORE UPDATE` trigger on
`locations` and `events`, not hand-written "snapshot then update" logic
duplicated in every TypeScript call site. Reasons:

- There are (at least) two independent write paths today that need this:
  `lib/postgres-storage.ts`'s `updateLocation`/`updateEvent` (admin panel,
  Part B of the admin-panel work) and whatever new code writes the
  geocode-correction path (Part 4 below). A trigger guarantees neither can
  forget to snapshot — application code literally cannot bypass it by
  writing a plain `UPDATE`.
- It also means *nothing else* has to change in the existing storage
  functions' SQL — `updateLocation`/`updateEvent` in `lib/postgres-storage.ts`
  stay exactly as written in the admin-panel PR; the trigger does the work
  transparently underneath them.

```sql
CREATE OR REPLACE FUNCTION log_location_history() RETURNS trigger AS $$
BEGIN
  INSERT INTO location_history (location_id, name, lon, lat, change_reason, changed_by)
  VALUES (
    OLD.id, OLD.name, OLD.lon, OLD.lat,
    COALESCE(current_setting('app.change_reason', true), 'unknown'),
    NULLIF(current_setting('app.changed_by', true), '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER locations_history BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION log_location_history();
```

(Symmetric `log_event_history()` / `events_history` trigger for `events`.)

The `current_setting('app.change_reason', true)` read is how the trigger
learns *why* — a plain `UPDATE` statement has no way to say "this is an
admin edit" on its own, so the caller sets a session-local Postgres GUC
immediately before issuing the update:

```sql
SET LOCAL app.change_reason = 'admin_edit';
UPDATE locations SET name = $1, lon = $2, lat = $3 WHERE id = $4;
```

`SET LOCAL` only lasts for the current transaction, which is exactly the
lifetime needed — `postgres.js` (already used throughout
`lib/postgres-storage.ts`) supports transactions via `sql.begin(async sql => {...})`,
so `updateLocation`/`updateEvent` wrap their existing `UPDATE` in a
transaction that first does `SET LOCAL app.change_reason = 'admin_edit'`.
`current_setting(..., true)` (the `true` = "missing is OK, return null" form)
means a plain `UPDATE` from anywhere that *doesn't* set it still works and
just gets logged with `change_reason = 'unknown'` rather than erroring —
safe by default, not a hard requirement that breaks other code.

**`changed_by`**: there's no real admin authentication yet (`apps/admin`
only checks the shared `MAP_API_KEY`, per the admin-panel design) — so this
column stays nullable and unpopulated for now, wired up once there's an
actual admin identity to record. Not blocking; the history/revert mechanism
is just as useful with `changed_by IS NULL` today.

### 3. Storage + API additions (admin-panel surface)

New functions in `lib/postgres-storage.ts` (mirrored in `lib/server-storage.ts`
for the JSON-file backend — see note below):

```ts
listLocationHistory(locationId: string): Promise<LocationHistoryEntry[]>
listEventHistory(eventId: string): Promise<EventHistoryEntry[]>
revertLocation(locationId: string, historyId: string): Promise<HistoricalLocation | null>
revertEvent(locationId: string, eventId: string, historyId: string): Promise<HistoricalEvent | null>
```

`revertLocation`/`revertEvent` read the chosen history row and issue the
*same* `UPDATE` `updateLocation`/`updateEvent` already do — wrapped in the
same `SET LOCAL app.change_reason = 'revert'` transaction — so a revert is
simply "apply an old snapshot as a new edit." This is the standard
undo-as-forward-edit pattern: it avoids ever deleting or rewriting history
rows, and "revert a revert" just works because it's history all the way
down.

**JSON-file backend note**: `lib/server-storage.ts`'s file-backed path (used
when `POSTGRES_URL` is unset) has no trigger mechanism available. Simplest
honest option: history/revert simply isn't available there — the functions
above return `[]` / `null` under the file backend, same pattern as
`getIngestedDocument` already uses (*"the JSON file this repo's read-only
demo serves has no ingestion pipeline behind it, so there is nothing to look
up"*). This is a demo/local-dev-only backend; not worth building a
parallel file-based history mechanism for it.

New routes:
- `GET /api/data/locations/[id]/history`
- `POST /api/data/locations/[id]/revert` — body `{ historyId }`
- `GET /api/data/locations/[id]/events/[eventId]/history`
- `POST /api/data/locations/[id]/events/[eventId]/revert` — body `{ historyId }`

All gated by the same `checkApiKey()` pattern every other write route in
`app/api/data/*` already uses.

**`apps/admin` UI**: a small "History" section on the location/event detail
view (`apps/admin/app/locations/[id]/page.tsx`, extending the `EventForm`
area) — a list of past versions (timestamp, reason, and a one-line diff-ish
summary, e.g. "lon/lat changed" or "title changed") each with a "Revert to
this" button. Deliberately simple: a table, not a diff viewer.

### 4. Making a geocode correction actually move an existing pin

This is the part that closes the `geocode:review` gap, and the part with a
real, stated limitation worth being upfront about.

`services/ingest/scripts/geocode-review.ts`'s `--set` flow already corrects
`geocode_cache`. Extend it (or add a sibling script/flag) to also update any
`locations` row that was created from that place name:

```sql
SET LOCAL app.change_reason = 'geocode_correction';
UPDATE locations
   SET lon = $1, lat = $2
 WHERE geocoded_place_name = $3;  -- the corrected normalized_name
```

This requires a new nullable column, `locations.geocoded_place_name text`,
populated by `findOrCreateLocation` whenever it **creates** a new row
(nothing to set on the snap-to-existing branch — the row already has
whatever name created it).

**Stated limitation, not a bug to fix later**: `findOrCreateLocation` snaps
multiple different place names within 1km to one shared location (its whole
point — "Salt Lake Valley" and "Salt Lake City" become one pin). A single
`geocoded_place_name` column only remembers whichever name happened to
*create* the row, not every name that ever snapped to it. So a correction
to a place name that snapped onto someone else's location — rather than
creating its own — won't be found by this column and won't auto-propagate.
Given the admin panel already provides a fully manual per-location fix
(drag the pin), this narrower automatic path covers the common case (a
place name resolves badly and creates its own, wrong, standalone location —
exactly the "Sutter's Mill → Idaho" scenario `WhgGeocoder`'s own docs are
built around) without needing a many-to-many provenance table. If that
limitation turns out to matter in practice, the fix is a
`location_place_names(location_id, normalized_place_name)` join table
recording every name that ever snapped — noted here as the natural next
step, not built preemptively.

### 5. Schema ownership (matches the established pattern in this repo)

Both new tables, the new column, and the two triggers need to exist
regardless of which side's migration path a given Postgres went through —
same reasoning already applied to `date_precision`/`date_text`/`geocode_cache.candidates`
earlier this project:

- **`lib/postgres-storage.ts`'s `ensureSchema()`**: add
  `CREATE TABLE IF NOT EXISTS location_history (...)`,
  `CREATE TABLE IF NOT EXISTS event_history (...)`,
  `ALTER TABLE locations ADD COLUMN IF NOT EXISTS geocoded_place_name text`,
  and the two trigger functions + `DROP TRIGGER IF EXISTS ...; CREATE TRIGGER ...`
  (idempotent re-creation, since `CREATE TRIGGER IF NOT EXISTS` isn't valid
  SQL before Postgres 16 conditionally — using `DROP ... IF EXISTS` first is
  portable regardless of version).
- **A new `services/ingest` TypeORM migration** (`services/ingest/libs/database/src/migrations/`,
  following the existing numbered-timestamp pattern) mirroring the exact
  same DDL, since `MapWriterService` writes to these tables via raw SQL
  outside TypeORM's own entity model (documented reason: *"Raw SQL on
  purpose. Those tables belong to the web app's `ensureSchema()`"*) — the
  ingest side still needs the tables/column/triggers to exist in whatever
  database it's pointed at.

### 6. What does *not* change

- Martin's `event_pins()` SQL function (`db/martin-functions.sql`) —
  unaffected; it only ever reads `locations`/`events`, never the history
  tables.
- `/map`'s rendering, `event-layers.ts`, `LayerControl` — unaffected, no UI
  toggle.
- `insertEvent`'s `ON CONFLICT DO NOTHING` — unaffected; event *content*
  correction-on-republish is explicitly out of scope (see "The gap this
  closes" above).
- `apps/admin`'s existing `updateLocation`/`updateEvent`/`EventForm` — the
  request/response shapes don't change; the trigger works underneath them
  with no caller-visible difference beyond history now existing.

## Testing plan

- Unit/integration (new): edit a location via `updateLocation`, assert
  exactly one new `location_history` row appears with the **pre-edit**
  values and `change_reason = 'admin_edit'`.
- Revert: call `revertLocation` with that history row's id, assert the live
  `locations` row matches the old values again, **and** a second new
  `location_history` row now exists capturing the state just before the
  revert (i.e. reverting doesn't special-case away its own history).
- Geocode correction: seed a `locations` row with a known
  `geocoded_place_name`, correct the matching `geocode_cache` entry, run the
  extended `--set` path, assert the location's lon/lat moved and
  `change_reason = 'geocode_correction'` is recorded.
- Regression: confirm `GET /api/sources/[id]/features` and a Martin
  `event_pins` tile request are byte-identical before/after this change for
  data nobody touched — proves the trigger and history tables are
  genuinely invisible to every existing read path.

## Rollout

1. Ship the migration (both sides) with nothing pointing at it yet — pure
   schema addition, zero behavior change, safe to deploy alone.
2. Wire `updateLocation`/`updateEvent` to set the session GUC before their
   existing `UPDATE`s (trigger starts capturing history from here on).
3. Add the history/revert routes + `apps/admin` UI.
4. Extend `geocode-review.ts --set` last, since it's the one genuinely new
   *capability* (not just instrumenting an existing write) and is easiest
   to verify in isolation once 1–3 are already working and tested.
