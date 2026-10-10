// GET /api/documents/:id?q=… — what the search document panel shows
// (plans/20-search-lexical.md, "The document panel's endpoint"): every
// paragraph matching `q` in document order, plus the document's published
// events. Without `q` it's just the event list.
//
// Gated like /api/search: on `x-api-key` only when MAP_API_KEY is set.
import { NextRequest, NextResponse } from "next/server";
import { MAX_QUERY_LENGTH } from "@/app/map/utils/search-query";
import { getDocumentPanel } from "@/lib/search-postgres";

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Documents only exist where ingestion runs, which means Postgres.
  if (!process.env["POSTGRES_URL"]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id } = await params;
  const q =
    req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? null;
  const panel = await getDocumentPanel(id, q);
  if (!panel) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(panel);
}
