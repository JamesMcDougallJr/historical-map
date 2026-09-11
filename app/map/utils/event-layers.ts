// Which event layers the map offers, and how each is served.
//
// Mirrors DEFAULT_OVERLAYS in ./overlays.ts: a plain list of layer descriptors
// that MapView turns into OpenLayers layers by switching on `kind`.
//
// The deployed demo registers only the static geojson layer — no database,
// nothing to hammer. Set NEXT_PUBLIC_MARTIN_URL locally to additionally get the
// live PostGIS layer, so both can be enabled at once and compared.

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
 */
export function eventLayersFromSources(sources: EventSource[]): EventLayer[] {
  const layers: EventLayer[] = sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: "geojson",
    url: `/api/sources/${source.id}/features`,
    ...(source.attribution ? { attribution: source.attribution } : {}),
    ...(source.color ? { color: source.color } : {}),
    enabled: true,
  }));

  return withMartinLayer(layers);
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
