// Full detail for a single location, including its events.
//
// Pin features carry only `location_id` — MVT properties are flat scalars, so
// events can't ride along in the tile. Popups fetch detail through here, which
// keeps pins and their detail on the same data source (previously the popup
// read from localStorage while pins came from the API, so they disagreed).

import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";

export const dynamic = "force-dynamic";

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
