import { NextResponse } from "next/server";
import { ingestFetch } from "@/lib/ingest-api";

export const dynamic = "force-dynamic";

/** Confirm ("this pin is right") or reject ("wrong — back to review") one geocode. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<NextResponse> {
  const { id, action } = await params;
  if (action !== "confirm" && action !== "reject") {
    return NextResponse.json({ error: "action must be confirm or reject" }, { status: 400 });
  }
  try {
    const res = await ingestFetch(`/geocodes/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    });
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "The ingestion API is not reachable (INGEST_API_URL)." },
      { status: 502 },
    );
  }
}
