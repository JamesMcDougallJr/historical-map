import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { corsPreflight } from "@/lib/cors";
import type { EventGroup } from "@/app/map/types";

export const OPTIONS = corsPreflight;

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = await storage.getEventGroup(id, {
    includeDescendants: req.nextUrl.searchParams.get("descendants") === "1",
  });

  if (!result) {
    return NextResponse.json(
      { error: "Event group not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ group: result.group, members: result.members });
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
      Pick<EventGroup, "title" | "description" | "parentGroupId">
    >;

    const current = await storage.getEventGroup(id);
    if (!current) {
      return NextResponse.json(
        { error: "Event group not found" },
        { status: 404 },
      );
    }

    await storage.upsertEventGroup({
      ...current.group,
      ...body,
    });

    const updated = await storage.getEventGroup(id);
    return NextResponse.json({ group: updated?.group });
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
  const deleted = await storage.deleteEventGroup(id);
  if (!deleted) {
    return NextResponse.json(
      { error: "Event group not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ deleted: true });
}
