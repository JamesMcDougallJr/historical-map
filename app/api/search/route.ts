// GET /api/search — typed, grouped search hits (plans/20-search-lexical.md).
// Parsing and ranking live in lib/search.ts so the MCP tool can share them;
// this route only reads params and serialises.
//
// Read-only, so it follows /api/data/search's policy: gated on `x-api-key`
// only when MAP_API_KEY is set. Covered by the middleware's per-IP rate limit.
import { NextRequest, NextResponse } from "next/server";
import { parseSearchRequest, search } from "@/lib/search";

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
    await search(parseSearchRequest(req.nextUrl.searchParams)),
  );
}
