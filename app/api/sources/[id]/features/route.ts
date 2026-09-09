// Static GeoJSON pins for one event source — the demo's event layer.
//
// Reads through lib/server-storage.ts, so it works against either backend, but
// on the deployed demo that means data/map-data.json: read-only, no database,
// nothing to hammer.
//
// Emits the SAME feature properties as the Martin `event_pins` function source
// (see db/martin-functions.sql) so the two layer kinds are interchangeable —
// everything downstream of layer construction treats them identically.

import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { eventYear } from "@/app/map/utils/event-query";

export const dynamic = "force-dynamic";

interface PinProperties {
  location_id: string;
  source_id: string;
  name: string;
  min_year: number;
  max_year: number;
  event_count: number;
  /**
   * The location's events, JSON-encoded.
   *
   * GeoJSON has no flat-scalar restriction, so the demo layer can ship events
   * with the pin and render popups without a second request. MVT can't do this
   * — those layers fall back to fetching detail by location_id.
   */
  events: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: sourceId } = await params;
  const locations = await storage.getLocations();

  // One feature per location, restricted to events from this source. A location
  // hosting events from two sources yields one feature in each source's layer —
  // correct while sources stay independent (fusing is deliberately out of scope).
  const features = [];
  for (const location of locations) {
    const events = location.events.filter((e) => e.sourceId === sourceId);
    if (events.length === 0) continue;

    const years = events.map((e) => eventYear(e.date)).filter(Number.isFinite);
    const properties: PinProperties = {
      location_id: location.id,
      source_id: sourceId,
      name: location.name,
      min_year: years.length ? Math.min(...years) : 0,
      max_year: years.length ? Math.max(...years) : 0,
      event_count: events.length,
      events: JSON.stringify(events),
    };

    features.push({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: location.coordinates,
      },
      properties,
    });
  }

  return NextResponse.json({ type: "FeatureCollection", features });
}
