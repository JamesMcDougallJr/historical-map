import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { generateEventId } from "@/app/map/utils/storage";
import type { HistoricalEvent } from "@/app/map/types";

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!storage.getLocation(id)) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  try {
    const body = (await req.json()) as Partial<HistoricalEvent> & {
      title: string;
      date: string;
      description: string;
    };

    if (!body.title || !body.date || !body.description) {
      return NextResponse.json(
        { error: "title, date, and description required" },
        { status: 400 },
      );
    }

    const event: HistoricalEvent = {
      id: body.id ?? generateEventId(),
      title: body.title,
      date: body.date,
      description: body.description,
      source: body.source,
      tags: body.tags,
      imageUrl: body.imageUrl,
    };

    const location = storage.addEventsToLocation(id, [event]);
    return NextResponse.json({ location }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}
