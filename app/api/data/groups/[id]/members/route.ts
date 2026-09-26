import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { corsPreflight } from "@/lib/cors";

export const OPTIONS = corsPreflight;

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!(await storage.getEventGroup(id))) {
    return NextResponse.json(
      { error: "Event group not found" },
      { status: 404 },
    );
  }

  try {
    const body = (await req.json()) as { eventIds: string[] };

    if (!Array.isArray(body.eventIds)) {
      return NextResponse.json(
        { error: "eventIds must be an array" },
        { status: 400 },
      );
    }

    await storage.setEventGroupMembers(id, body.eventIds);

    const result = await storage.getEventGroup(id);
    return NextResponse.json({ group: result?.group, members: result?.members });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}
