// Full detail for a single location, including its events.
//
// Pin features carry only `location_id` — MVT properties are flat scalars, so
// events can't ride along in the tile. Popups fetch detail through here, which
// keeps pins and their detail on the same data source (previously the popup
// read from localStorage while pins came from the API, so they disagreed).

import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { corsPreflight } from "@/lib/cors";
import type { HistoricalLocation } from "@/app/map/types";

export const dynamic = "force-dynamic";

export const OPTIONS = corsPreflight;

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const location = await storage.getLocation(id);

  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }
  return NextResponse.json({ location });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const body = (await req.json()) as Partial<
      Pick<HistoricalLocation, "name" | "coordinates">
    >;
    const location = await storage.updateLocation(id, {
      name: body.name,
      coordinates: body.coordinates,
    });
    if (!location) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }
    return NextResponse.json({ location });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const deleted = await storage.deleteLocation(id);
  if (!deleted) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
