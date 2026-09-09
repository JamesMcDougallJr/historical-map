// Which event layers the map offers, and how each is served.
//
// Mirrors DEFAULT_OVERLAYS in ./overlays.ts: a plain list of layer descriptors
// that MapView turns into OpenLayers layers by switching on `kind`.
//
// The deployed demo registers only the static geojson layer — no database,
// nothing to hammer. Set NEXT_PUBLIC_MARTIN_URL locally to additionally get the
// live PostGIS layer, so both can be enabled at once and compared.

import type { EventLayer } from "../types";

/** Source id of the events seeded from data/map-data.json. */
export const DEMO_SOURCE_ID = "utah-historical";

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
