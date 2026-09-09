-- Martin function tile source for event pins.
--
-- A function source rather than a plain table source so filtering happens in
-- PostGIS instead of the browser: Martin passes URL query params through as
-- `query_params`, letting the timeline and layer toggles push predicates down
-- into indexed SQL. That is the whole point of running a tile server here.
--
-- Requested as:
--   /event_pins/{z}/{x}/{y}?from_year=1860&to_year=1880&source_ids=utah-historical
--
-- Applied by `npm run seed:db`. Emits the SAME properties as the static GeoJSON
-- endpoint (app/api/sources/[id]/features/route.ts) so the two layer kinds are
-- interchangeable: location_id, source_id, name, min_year, max_year, event_count.

CREATE OR REPLACE FUNCTION event_pins(
  z integer,
  x integer,
  y integer,
  query_params json DEFAULT '{}'::json
)
RETURNS bytea AS $$
DECLARE
  mvt bytea;
  from_year integer := NULLIF(query_params->>'from_year', '')::integer;
  to_year   integer := NULLIF(query_params->>'to_year', '')::integer;
  source_ids text[] := CASE
    WHEN COALESCE(query_params->>'source_ids', '') = '' THEN NULL
    ELSE string_to_array(query_params->>'source_ids', ',')
  END;
BEGIN
  SELECT INTO mvt ST_AsMVT(tile, 'event_pins', 4096, 'geom') FROM (
    SELECT
      ST_AsMVTGeom(
        ST_Transform(l.geom, 3857),
        ST_TileEnvelope(z, x, y),
        4096, 64, true
      ) AS geom,
      l.id                              AS location_id,
      e.source_id                       AS source_id,
      l.name                            AS name,
      MIN(EXTRACT(YEAR FROM e.date))::int AS min_year,
      MAX(EXTRACT(YEAR FROM e.date))::int AS max_year,
      COUNT(*)::int                     AS event_count
    FROM locations l
    JOIN events e ON e.location_id = l.id
    WHERE ST_Transform(l.geom, 3857) && ST_TileEnvelope(z, x, y)
      AND (from_year  IS NULL OR EXTRACT(YEAR FROM e.date) >= from_year)
      AND (to_year    IS NULL OR EXTRACT(YEAR FROM e.date) <= to_year)
      AND (source_ids IS NULL OR e.source_id = ANY(source_ids))
    -- One pin per (location, source): a location with events from two sources
    -- appears once in each source's layer, which is what independent layers mean.
    GROUP BY l.id, l.name, l.geom, e.source_id
  ) AS tile
  WHERE geom IS NOT NULL;

  RETURN COALESCE(mvt, ''::bytea);
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;
