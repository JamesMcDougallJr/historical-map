import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { corsPreflight } from "@/lib/cors";
import type { EventGroup } from "@/app/map/types";

export const OPTIONS = corsPreflight;

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true; // no key configured → open
  return req.headers.get("x-api-key") === key;
}

/**
 * Generate a URL-safe ID from a title with collision avoidance. Mirrors
 * `generateLocationId` in app/map/utils/storage.ts.
 */
function generateEventGroupId(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}-${suffix}`;
}

export async function GET(req: NextRequest) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const groups = await storage.listEventGroups();
  return NextResponse.json({ groups });
}

export async function POST(req: NextRequest) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await req.json()) as Partial<EventGroup> & {
      title: string;
    };

    if (!body.title) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }

    const id = body.id ?? generateEventGroupId(body.title);

    await storage.upsertEventGroup({
      id,
      title: body.title,
      description: body.description,
      parentGroupId: body.parentGroupId,
    });

    const result = await storage.getEventGroup(id);
    return NextResponse.json({ group: result?.group }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}
