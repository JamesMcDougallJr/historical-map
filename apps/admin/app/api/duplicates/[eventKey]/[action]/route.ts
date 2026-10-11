import { NextResponse } from "next/server";
import { ingestFetch } from "@/lib/ingest-api";

export const dynamic = "force-dynamic";

/** Approve ("a different event, publish it") or dismiss ("a duplicate") one item. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ eventKey: string; action: string }> },
): Promise<NextResponse> {
  const { eventKey, action } = await params;
  if (action !== "approve" && action !== "dismiss") {
    return NextResponse.json({ error: "action must be approve or dismiss" }, { status: 400 });
  }
  try {
    const res = await ingestFetch(
      `/duplicates/${encodeURIComponent(eventKey)}/${action}`,
      { method: "POST" },
    );
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "The ingestion API is not reachable (INGEST_API_URL)." },
      { status: 502 },
    );
  }
}
