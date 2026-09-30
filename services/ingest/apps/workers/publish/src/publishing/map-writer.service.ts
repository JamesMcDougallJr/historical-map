import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

/**
 * Writes into the **map** tables (`sources`, `locations`, `events`).
 *
 * Raw SQL on purpose. Those tables belong to the web app's `ensureSchema()`;
 * giving TypeORM entities for them would put two tools in charge of one schema
 * and risk `synchronize` ever touching them. Explicit statements make the
 * boundary visible at every call site.
 *
 * Writes go straight to Postgres rather than through `/api/data/*` because that
 * route silently drops `sourceId` — and `event_pins` in `db/martin-functions.sql`
 * groups by `source_id`, so an event without one produces a pin that no layer
 * toggle can ever show.
 */
@Injectable()
export class MapWriterService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Upserts the `EventSource` row backing a map layer. */
  async ensureSource(source: {
    id: string;
    name: string;
    description?: string | null;
    homepageUrl?: string | null;
    attribution?: string | null;
    color?: string | null;
  }): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO sources (id, name, description, homepage_url, attribution, color)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             homepage_url = EXCLUDED.homepage_url,
             attribution = EXCLUDED.attribution,
             color = EXCLUDED.color`,
      [
        source.id,
        source.name,
        source.description ?? null,
        source.homepageUrl ?? null,
        source.attribution ?? null,
        source.color ?? "#3b82f6",
      ],
    );
  }

  /**
   * Finds a location within `radiusMeters` of the point, or creates one.
   *
   * Snapping to a nearby existing location stops a corpus generating dozens of
   * near-identical pins for one place — "Salt Lake Valley" and "Salt Lake City"
   * geocode a few hundred metres apart and should share a pin.
   */
  async findOrCreateLocation(
    name: string,
    lon: number,
    lat: number,
    radiusMeters = 1000,
  ): Promise<string> {
    const near: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM locations
       WHERE ST_DWithin(
         geom::geography,
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         $3
       )
       ORDER BY geom::geography <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
       LIMIT 1`,
      [lon, lat, radiusMeters],
    );
    if (near[0]) return near[0].id;

    const id = locationId(name, lon, lat);
    await this.dataSource.query(
      `INSERT INTO locations (id, name, lon, lat)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, lon, lat],
    );
    return id;
  }

  /**
   * Upserts the `EventGroup` row for one of `extract-events`'s sequence
   * proposals. Id is derived from (title, documentId) — same slug+hash shape
   * as `locationId` below — so re-publishing the same proposal (idempotent
   * re-run, or the backfill script) updates the same row instead of piling up
   * duplicates. Returns the id, the same shape as `findOrCreateLocation`.
   *
   * Raw SQL for the same reason as every other method here: `event_groups`
   * belongs to the web app's `ensureSchema()`, not to this connection's
   * TypeORM entities.
   */
  async ensureEventGroup(
    documentId: string,
    title: string,
    description: string | null,
  ): Promise<string> {
    const id = slugId(title, documentId, "sequence");
    await this.dataSource.query(
      `INSERT INTO event_groups (id, title, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title,
             description = EXCLUDED.description`,
      [id, title, description],
    );
    return id;
  }

  /**
   * Adds an event to a group at a given narrative position.
   *
   * `ON CONFLICT DO NOTHING` on purpose: a member's `seq` is set once, at
   * first insert, and never overwritten — an editor hand-reordering a group
   * later (the admin "Sequences" UI) must not have their change clobbered by
   * a later re-publish finding the same proposal again.
   */
  async addGroupMember(
    groupId: string,
    eventId: string,
    seq: number,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO event_group_members (group_id, event_id, seq)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, event_id) DO NOTHING`,
      [groupId, eventId, seq],
    );
  }

  /**
   * Inserts an event. Returns false when the id already existed.
   *
   * `ON CONFLICT DO NOTHING` plus a content-derived id is what makes publishing
   * idempotent: re-running produces the same ids, so nothing duplicates. Note
   * this means an event is never *corrected* by re-publishing — matching the
   * existing behaviour of the web app's own insert path.
   */
  async insertEvent(event: {
    id: string;
    locationId: string;
    sourceId: string;
    title: string;
    date: string;
    description: string;
    source?: string | null;
    tags?: string[] | null;
    datePrecision?: string | null;
    dateText?: string | null;
    documentId?: string | null;
    anchor?: string | null;
  }): Promise<boolean> {
    const result: unknown[] = await this.dataSource.query(
      `INSERT INTO events (
         id, location_id, source_id, title, date, description,
         source, tags, date_precision, date_text, document_id, anchor
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        event.id,
        event.locationId,
        event.sourceId,
        event.title,
        event.date,
        event.description,
        event.source ?? null,
        event.tags ?? null,
        event.datePrecision ?? null,
        event.dateText ?? null,
        event.documentId ?? null,
        event.anchor ?? null,
      ],
    );
    return result.length > 0;
  }
}


/**
 * Readable slug of `text` plus a hash-derived suffix of `salt`, so ids stay
 * debuggable but never collide on the slug alone. Shared by `locationId`
 * (salted with coordinates) and `ensureEventGroup` (salted with documentId).
 */
function slugId(text: string, salt: string, fallback: string): string {
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || fallback;
  const digest = createHash("sha256").update(salt).digest("hex").slice(0, 8);
  return `${slug}-${digest}`;
}

function locationId(name: string, lon: number, lat: number): string {
  return slugId(name, `${lon.toFixed(4)},${lat.toFixed(4)}`, "place");
}
