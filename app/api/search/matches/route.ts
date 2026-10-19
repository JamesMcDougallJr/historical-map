// GET /api/search/matches — distinct location ids of every matching event,
// for live map highlighting while typing. The cheapest query in the search
// track: no ranking, no snippets. Same params, parser and filters as
// /api/search, so the highlighted pins and the result list can't disagree.
import { NextRequest, NextResponse } from "next/server";
import { parseSearchRequest, searchMatches } from "@/lib/search";

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function GET(req: NextRequest) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    await searchMatches(parseSearchRequest(req.nextUrl.searchParams)),
  );
}
