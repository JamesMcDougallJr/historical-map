import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { generateLocationId } from "@/app/map/utils/storage";
import type { HistoricalLocation } from "@/app/map/types";

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true; // no key configured → open
  return req.headers.get("x-api-key") === key;
}

export async function GET(req: NextRequest) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const locations = storage.getLocations();
  const data = storage.readData();
  return NextResponse.json({ locations, lastUpdated: data.lastUpdated });
}

export async function POST(req: NextRequest) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await req.json()) as Partial<HistoricalLocation> & {
      name: string;
      coordinates: [number, number];
    };

    if (!body.name || !body.coordinates) {
      return NextResponse.json(
        { error: "name and coordinates required" },
        { status: 400 },
      );
    }

    const location: HistoricalLocation = {
      id: body.id ?? generateLocationId(body.name),
      name: body.name,
      coordinates: body.coordinates,
      events: body.events ?? [],
    };

    storage.upsertLocation(location);
    return NextResponse.json({ location }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}
