import { NextResponse } from "next/server";
import { ingestFetch } from "@/lib/ingest-api";

export const dynamic = "force-dynamic";

/** Model-made and reviewed geocodes, plus their threshold, proxied from the ingestion API. */
export async function GET(): Promise<NextResponse> {
  try {
    const res = await ingestFetch("/geocodes");
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "The ingestion API is not reachable (INGEST_API_URL)." },
      { status: 502 },
    );
  }
}
