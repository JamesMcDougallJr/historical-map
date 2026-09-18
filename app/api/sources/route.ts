// The event sources the map can draw as layers.
//
// Exists because the layer registry used to be a hardcoded list containing
// exactly one id. Publishing a new source wrote correct rows to `sources`,
// `locations` and `events`, and `/api/sources/<id>/features` served them
// happily — but nothing rendered them, because no layer existed to ask. The
// failure is silent and looks exactly like "the pipeline didn't publish".
//
// Reads through lib/server-storage.ts, so this is the Postgres source list
// where one is configured and the JSON file's otherwise.

import { NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";
import { corsPreflight } from "@/lib/cors";

export const dynamic = "force-dynamic";

export const OPTIONS = corsPreflight;

export async function GET(): Promise<NextResponse> {
  const sources = await storage.listSources();
  return NextResponse.json({ sources });
}
