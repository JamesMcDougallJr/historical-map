import type { GeocodeReviewItem } from "@historical-map/domain";
import type { Queryable } from "./duplicates";
import type { GeocodeDecision, GeocodeReviewStatus } from "./entities";

/**
 * Reads and reviews model-made geocodes. One implementation behind
 * `npm run geocode:review`, `geocode:refresh` and the admin panel, so they
 * cannot drift — the same arrangement as `duplicates.ts`.
 */

/**
 * The rows of an `UPDATE`/`DELETE … RETURNING`. TypeORM's Postgres driver
 * answers those with `[rows, count]`, a plain pg client with the rows — and
 * reading the pair as rows silently miscounts by one.
 */
function returnedRows<T>(result: unknown): T[] {
  const rows = result as unknown[];
  return (Array.isArray(rows[0]) ? rows[0] : rows) as T[];
}

/** `confidence_thresholds.operation` for the Jev context geocode. */
export const JEV_CONTEXT_GEOCODE = "geocode.jev_context";

/**
 * The minimum confidence for `operation`, read from `confidence_thresholds`
 * at decision time so it can change without a redeploy. `fallback` covers a
 * database the migration hasn't reached yet.
 */
export async function getConfidenceThreshold(
  db: Queryable,
  operation: string,
  fallback: number,
): Promise<number> {
  try {
    const rows = (await db.query(
      `SELECT min_confidence FROM confidence_thresholds WHERE operation = $1`,
      [operation],
    )) as Array<{ min_confidence: number }>;
    return rows[0]?.min_confidence ?? fallback;
  } catch {
    return fallback;
  }
}

/** Changes an operation's minimum; takes effect on the next decision. */
export async function setConfidenceThreshold(
  db: Queryable,
  operation: string,
  minConfidence: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    return { ok: false, reason: "minConfidence must be between 0 and 1." };
  }
  const rows = returnedRows(
    await db.query(
      `UPDATE confidence_thresholds
          SET min_confidence = $2, updated_at = now()
        WHERE operation = $1
        RETURNING operation`,
      [operation, minConfidence],
    ),
  );
  return rows.length
    ? { ok: true }
    : { ok: false, reason: `No threshold for operation "${operation}".` };
}

interface Row {
  id: string;
  normalized_name: string;
  raw_name: string;
  lon: number | null;
  lat: number | null;
  found: boolean;
  provider: string | null;
  display_name: string | null;
  confidence: number | null;
  review_status: GeocodeReviewStatus;
  reviewed_at: string | null;
  decision: GeocodeDecision | null;
  created_at: string;
}

/**
 * Published candidates whose event names this place — matched on the cache
 * key, normalised by the caller's `normalize` (the geocoding lib owns
 * `normalizePlaceName`, and depending on it here would be circular).
 */
export async function publishedFromPlace(
  db: Queryable,
  normalizedName: string,
  normalize: (placeName: string) => string,
): Promise<Array<{ id: string; eventKey: string }>> {
  const rows = (await db.query(
    `SELECT id, event_key, event->>'placeName' AS place
       FROM ingest_event_candidates
      WHERE published_at IS NOT NULL`,
  )) as Array<{ id: string; event_key: string; place: string | null }>;
  return rows
    .filter((r) => r.place && normalize(r.place) === normalizedName)
    .map((r) => ({ id: r.id, eventKey: r.event_key }));
}

/**
 * Takes a place's events off the map and back to review, the way `publish`
 * demotes an event it cannot place. Locations left with no events go too.
 * Returns how many events left the map.
 */
export async function demotePlace(
  db: Queryable,
  normalizedName: string,
  normalize: (placeName: string) => string,
  reason: string,
): Promise<number> {
  const published = await publishedFromPlace(db, normalizedName, normalize);
  if (published.length === 0) return 0;

  const removed = returnedRows<{ location_id: string }>(
    await db.query(
      `DELETE FROM events WHERE id = ANY($1) RETURNING location_id`,
      [published.map((p) => p.eventKey)],
    ),
  );
  await db.query(
    `UPDATE ingest_event_candidates
        SET verdict = 'review',
            published_at = NULL,
            checks = checks || $2::jsonb
      WHERE id = ANY($1)`,
    [
      published.map((p) => p.id),
      JSON.stringify([
        { name: "publish", passed: false, gating: true, detail: reason },
      ]),
    ],
  );
  await db.query(
    `DELETE FROM locations l
      WHERE l.id = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.location_id = l.id)`,
    [[...new Set(removed.map((r) => r.location_id))]],
  );
  return removed.length;
}

/**
 * Every geocode a model decided or a person reviewed, newest first. Plain
 * gazetteer answers nobody has looked at are left out: they are what
 * `geocode:review`'s full listing is for.
 */
export async function listGeocodeReviews(
  db: Queryable,
  normalize: (placeName: string) => string,
): Promise<GeocodeReviewItem[]> {
  const rows = (await db.query(
    `SELECT id, normalized_name, raw_name, lon, lat, found, provider,
            display_name, confidence, review_status, reviewed_at, decision,
            created_at
       FROM geocode_cache
      WHERE decision IS NOT NULL OR review_status <> 'auto'
      ORDER BY COALESCE(reviewed_at, created_at) DESC`,
  )) as Row[];

  const items: GeocodeReviewItem[] = [];
  for (const r of rows) {
    const published = r.found
      ? (await publishedFromPlace(db, r.normalized_name, normalize)).length
      : 0;
    items.push({
      id: r.id,
      placeName: r.raw_name,
      status: r.review_status,
      pinned:
        r.found && r.lon != null && r.lat != null
          ? { lon: r.lon, lat: r.lat, displayName: r.display_name ?? r.raw_name }
          : null,
      provider: r.provider,
      confidence: r.confidence,
      threshold: r.decision?.threshold ?? null,
      tierAnswer: r.decision?.tierHit ?? null,
      context: r.decision?.context ?? null,
      publishedEvents: published,
      reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    });
  }
  return items;
}

export type GeocodeReviewAction = "confirm" | "reject";

export type GeocodeReviewResult =
  | { ok: true; placeName: string; demoted: number }
  | { ok: false; reason: string };

/**
 * `confirm`: "this pin is right." Pins the answer so no refresh changes it.
 *
 * `reject`: "this pin is wrong." The row becomes a miss — coordinates
 * cleared, the decision kept as the record of what was rejected — and every
 * event published from the place goes back to review. Because a rejected row
 * is a cached miss, a new event naming the place goes to review too instead
 * of being re-pinned, and `geocode:refresh` skips it. `geocode:review --set`
 * is how a person supplies the right answer afterwards.
 */
export async function reviewGeocode(
  db: Queryable,
  id: string,
  action: GeocodeReviewAction,
  normalize: (placeName: string) => string,
): Promise<GeocodeReviewResult> {
  const found = (await db.query(
    `SELECT id, normalized_name, raw_name, found, review_status
       FROM geocode_cache WHERE id = $1`,
    [id],
  )) as Array<Pick<Row, "id" | "normalized_name" | "raw_name" | "found" | "review_status">>;
  const row = found[0];
  if (!row) return { ok: false, reason: `No geocode with id "${id}".` };

  if (action === "confirm") {
    if (!row.found) {
      return { ok: false, reason: `"${row.raw_name}" has no pin to confirm.` };
    }
    await db.query(
      `UPDATE geocode_cache
          SET review_status = 'confirmed', reviewed_at = now()
        WHERE id = $1`,
      [id],
    );
    return { ok: true, placeName: row.raw_name, demoted: 0 };
  }

  if (row.review_status === "rejected") {
    return { ok: false, reason: `"${row.raw_name}" is already rejected.` };
  }
  await db.query(
    `UPDATE geocode_cache
        SET review_status = 'rejected', reviewed_at = now(),
            found = false, lon = NULL, lat = NULL
      WHERE id = $1`,
    [id],
  );
  const demoted = await demotePlace(
    db,
    row.normalized_name,
    normalize,
    `geocode rejected by a reviewer: ${row.raw_name}`,
  );
  return { ok: true, placeName: row.raw_name, demoted };
}
