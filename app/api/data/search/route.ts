import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { parseEventQuery } from "@/app/map/utils/event-query";

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function GET(req: NextRequest) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await storage.searchEvents(
    parseEventQuery(req.nextUrl.searchParams),
  );

  return NextResponse.json({ results });
}
