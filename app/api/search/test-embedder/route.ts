// Test-only window onto the fake query embedder (plans/23, search-hybrid.spec).
// 404 unless EMBEDDING_ENGINE is fake or record, and always 404 on Vercel
// (previews run fake too) — only e2e-real's local web server can reach it.
//
//   GET  → { calls, received, failure, ceiling }
//   POST { reset?: true, sweep?: true,
//          failure?: "throttle"|"validation"|"timeout"|null, ceiling?: number|null }
import { NextRequest, NextResponse } from "next/server";
import { sweepSearchLog } from "@/lib/search-log";
import { sweepQueryCache, testHooks } from "@/lib/search-semantic";

// `record` too: re-recording runs the same specs against live Bedrock. Never
// on Vercel: previews also run EMBEDDING_ENGINE=fake, and this route can wipe
// the query cache and break the embedder for everyone.
const enabled = () =>
  !process.env["VERCEL"] &&
  (process.env["EMBEDDING_ENGINE"] === "fake" ||
    process.env["EMBEDDING_ENGINE"] === "record");
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
