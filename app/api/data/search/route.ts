import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function GET(req: NextRequest) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const q = searchParams.get("q") ?? "";
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const results = storage.searchEvents(
    q,
    from ? parseInt(from, 10) : undefined,
    to ? parseInt(to, 10) : undefined,
  );

  return NextResponse.json({ results });
}
