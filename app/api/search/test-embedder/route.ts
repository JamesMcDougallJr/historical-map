// Test-only window onto the fake query embedder (plans/23, search-hybrid.spec).
// 404 unless EMBEDDING_ENGINE is fake or record, which only e2e-real's web
// server sets — so in any real deployment this route does not exist in effect.
//
//   GET  → { calls, received, failure, ceiling }
//   POST { reset?: true, sweep?: true,
//          failure?: "throttle"|"validation"|"timeout"|null, ceiling?: number|null }
import { NextRequest, NextResponse } from "next/server";
import { sweepSearchLog } from "@/lib/search-log";
import { sweepQueryCache, testHooks } from "@/lib/search-semantic";

// `record` too: re-recording runs the same specs against live Bedrock.
const enabled = () =>
  process.env["EMBEDDING_ENGINE"] === "fake" ||
  process.env["EMBEDDING_ENGINE"] === "record";
const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

function state() {
  return {
    calls: testHooks.calls,
    received: testHooks.received,
    failure: testHooks.failure,
    ceiling: testHooks.ceiling,
  };
}

export async function GET() {
  if (!enabled()) return notFound();
  return NextResponse.json(state());
}

export async function POST(req: NextRequest) {
  if (!enabled()) return notFound();
  const body = (await req.json().catch(() => ({}))) as {
    reset?: boolean;
    sweep?: boolean;
    failure?: typeof testHooks.failure;
    ceiling?: number | null;
  };
  if (body.reset) await testHooks.reset();
  if (body.sweep) await Promise.all([sweepQueryCache(), sweepSearchLog()]);
  if (body.failure !== undefined) testHooks.failure = body.failure;
  if (body.ceiling !== undefined) testHooks.ceiling = body.ceiling;
  return NextResponse.json(state());
}
