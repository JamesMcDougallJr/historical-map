// Which event layers the map offers, and how each is served.
//
// Mirrors DEFAULT_OVERLAYS in ./overlays.ts: a plain list of layer descriptors
// that MapView turns into OpenLayers layers by switching on `kind`.
//
// The deployed demo (no database) registers static geojson layers. Anywhere
// `NEXT_PUBLIC_MARTIN_URL` is set — local dev, or any deploy with Postgres +
// Martin — every source instead gets a live MVT layer straight from PostGIS,
// filtered to that source with `sourceIds`.

import type { EventLayer, EventSource } from "../types";

/** Source id of the events seeded from data/map-data.json. */
export const DEMO_SOURCE_ID = "utah-historical";

/**
 * Build a layer per event source.
 *
 * The registry was previously a hardcoded list of one id, which meant any
 * source beyond the seeded demo — anything the ingestion pipeline published —
 * had no layer and therefore never appeared, however correctly it had been
 * written to the database. Deriving the list from `sources` makes a newly
 * published source visible without a code change, which is the whole point of
 * the pipeline writing a `sources` row in the first place.
 *
 * Deliberately does NOT append `withMartinLayer`'s comparison layer — that
 * exists to check a *hardcoded static* geojson layer against live PostGIS
 * (see `getEventLayers` below). Here, every layer is already PostGIS-backed
 * MVT whenever Martin is configured, so appending it would just duplicate
 * the demo source under a second, redundant "(PostGIS)" entry.
 */
export function eventLayersFromSources(sources: EventSource[]): EventLayer[] {
  const martinUrl = process.env["NEXT_PUBLIC_MARTIN_URL"];

  return sources.map((source) =>
    martinUrl
      ? {
          id: source.id,
          name: source.name,
          kind: "mvt",
          // Bare tile template — no query string here. `sourceIds` carries the
          // per-layer filter instead, so MapView's timeline updates (which
          // rebuild the query string from scratch) can never clobber it: two
          // things writing into one query string is how a filter silently
          // disappears the first time something else changes it.
          url: `${martinUrl.replace(/\/$/, "")}/event_pins/{z}/{x}/{y}`,
          sourceIds: [source.id],
          ...(source.attribution ? { attribution: source.attribution } : {}),
          ...(source.color ? { color: source.color } : {}),
          enabled: true,
        }
      : {
          id: source.id,
          name: source.name,
          kind: "geojson",
          url: `/api/sources/${source.id}/features`,
          ...(source.attribution ? { attribution: source.attribution } : {}),
          ...(source.color ? { color: source.color } : {}),
          enabled: true,
        },
  );
}

export function getEventLayers(): EventLayer[] {
  const layers: EventLayer[] = [
    {
      id: DEMO_SOURCE_ID,
      name: "Utah Historical Events",
      kind: "geojson",
      url: `/api/sources/${DEMO_SOURCE_ID}/features`,
      attribution: "Utah Historical Events (curated)",
      color: "#3b82f6",
      enabled: true,
    },
  ];

  return withMartinLayer(layers);
}

/**
 * The PostGIS comparison layer, which stays tied to the demo source: it exists
 * to check the two backends agree on the same data, so pointing it at anything
 * else would defeat its purpose.
 */
function withMartinLayer(layers: EventLayer[]): EventLayer[] {
  const martinUrl = process.env["NEXT_PUBLIC_MARTIN_URL"];
  if (martinUrl) {
    layers.push({
      id: `${DEMO_SOURCE_ID}-live`,
      name: "Utah Historical Events (PostGIS)",
      kind: "mvt",
      url: `${martinUrl.replace(/\/$/, "")}/event_pins/{z}/{x}/{y}`,
      // Was unfiltered before `sourceIds` existed, so it silently rendered
      // every source's events under the Utah label. Filtering to the demo
      // source is what makes the label true — and correctly means empty
      // whenever the demo source isn't seeded locally.
      sourceIds: [DEMO_SOURCE_ID],
      attribution: "Utah Historical Events (curated)",
      color: "#f97316",
      // Off by default: enabling it alongside the geojson layer is how you
      // check the two backends agree, but it shouldn't double up on load.
      enabled: false,
    });
  }

  return layers;
}

/**
 * Query params for an MVT request. Pushes timeline and source filtering into
 * PostGIS via Martin's function source (see db/martin-functions.sql).
 * Returns "" when nothing is constrained, so the tile URL stays cacheable.
 */
export function mvtQueryString(opts: {
  fromYear?: number;
  toYear?: number;
  sourceIds?: string[];
}): string {
  const params = new URLSearchParams();
  if (opts.fromYear !== undefined)
    params.set("from_year", String(opts.fromYear));
  if (opts.toYear !== undefined) params.set("to_year", String(opts.toYear));
  if (opts.sourceIds?.length)
    params.set("source_ids", opts.sourceIds.join(","));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
