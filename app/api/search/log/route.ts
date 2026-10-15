// POST /api/search/log { id, clicked } — records which result a submitted
// search led to (plans/23, "Query log"): `clicked` is the result's `kind:id`.
// The strongest ranking signal there is — a query whose top hit is never
// clicked is a golden-set candidate.
import { NextRequest, NextResponse } from "next/server";
import { SEARCH_KINDS } from "@historical-map/domain";
import { logClick } from "@/lib/search-log";

function checkApiKey(req: NextRequest): boolean {
  const key = process.env["MAP_API_KEY"];
  if (!key) return true;
  return req.headers.get("x-api-key") === key;
}

export async function POST(req: NextRequest) {
  if (!checkApiKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env["POSTGRES_URL"]) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const body = (await req.json().catch(() => null)) as {
    id?: unknown;
    clicked?: unknown;
  } | null;
  const id = Number(body?.id);
  const clicked = typeof body?.clicked === "string" ? body.clicked : "";
  const kind = clicked.split(":", 1)[0] ?? "";
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !(SEARCH_KINDS as readonly string[]).includes(kind)
  ) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const ok = await logClick(id, clicked);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
