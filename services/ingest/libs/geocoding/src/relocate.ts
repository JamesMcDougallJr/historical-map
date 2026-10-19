/**
 * Moves already-published map pins when a geocode is corrected.
 *
 * `geocode_cache` is only consulted while publishing, so correcting a cache row
 * alone leaves every pin it already produced where it was. `locations` keeps no
 * link back to the cache key, so the only honest join is the coordinates the
 * cache entry used to hold: a pin sitting exactly there was placed by it.
 *
 * Deliberately *not* a radius match. `findOrCreateLocation` snaps nearby places
 * onto one shared pin, so a wider net would drag along pins that belong to a
 * different place which merely lies close by.
 *
 * Pin ids keep their old coordinate-derived suffix; ids are opaque keys, and
 * changing one would orphan every event pointing at it.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface RelocatedPin {
  id: string;
  name: string;
}

/** ~10 cm in degrees: the coordinates were copied, not computed. */
const TOLERANCE_DEG = 1e-6;

export async function relocatePublishedPins(
  db: Queryable,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): Promise<RelocatedPin[]> {
  const result = await db.query(
    `UPDATE locations
        SET lon = $1, lat = $2
      WHERE ABS(lon - $3) < $5 AND ABS(lat - $4) < $5
      RETURNING id, name`,
    [to.lon, to.lat, from.lon, from.lat, TOLERANCE_DEG],
  );
  // TypeORM's Postgres driver answers UPDATE ... RETURNING with [rows, count];
  // a plain pg client answers with the rows. Accept both.
  const rows =
    Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  return rows as RelocatedPin[];
}
