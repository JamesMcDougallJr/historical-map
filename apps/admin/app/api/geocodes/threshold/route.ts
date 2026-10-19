import { NextResponse } from "next/server";
import { ingestFetch } from "@/lib/ingest-api";

export const dynamic = "force-dynamic";

/** Sets the minimum Jev confidence for a context geocode (`confidence_thresholds`). */
export async function PUT(req: Request): Promise<NextResponse> {
  try {
    const res = await ingestFetch("/geocodes/threshold", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
    });
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "The ingestion API is not reachable (INGEST_API_URL)." },
      { status: 502 },
    );
  }
}
