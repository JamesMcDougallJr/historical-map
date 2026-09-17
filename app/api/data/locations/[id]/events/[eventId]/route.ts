import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { corsPreflight } from "@/lib/cors";
import type { HistoricalEvent } from "@/app/map/types";

export const OPTIONS = corsPreflight;

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
): Promise<NextResponse> {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, eventId } = await params;
  try {
    const body = (await req.json()) as Partial<
      Pick<
        HistoricalEvent,
        | "title"
        | "date"
        | "description"
        | "datePrecision"
        | "dateText"
        | "source"
        | "sourceId"
        | "tags"
        | "imageUrl"
      >
    >;
    const event = await storage.updateEvent(id, eventId, body);
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return NextResponse.json({ event });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
): Promise<NextResponse> {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, eventId } = await params;
  const deleted = await storage.deleteEvent(id, eventId);
  if (!deleted) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
