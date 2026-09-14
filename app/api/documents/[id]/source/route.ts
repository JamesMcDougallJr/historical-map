// Redirects to the original document an event was extracted from.
//
// Deliberately takes the DOCUMENT id, not the event id, and knows nothing
// about `anchor` (the page): the caller builds `href="…/source#page=43"` and
// the browser carries that fragment onto the redirect target itself — a
// fragment is never sent to the server, so this route has nothing to do with
// it. That also means one document can back links from many events, which is
// the shape fusion (plan 13) will need once an event has more than one source.
//
// A presigned URL rather than a proxy: `@aws-sdk/s3-request-presigner` mints a
// short-lived link the browser fetches directly from S3/MinIO. Proxying a
// multi-hundred-KB PDF through a serverless function on every click spends
// bandwidth and execution time for no benefit — the bytes are already public
// once presigned, and PDFs are exactly the kind of asset a browser caches well.

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";
import * as storage from "@/lib/server-storage";

export const dynamic = "force-dynamic";

const PRESIGN_TTL_SECONDS = 900;

function s3Client(): S3Client | null {
  const endpoint = process.env["S3_ENDPOINT"];
  const accessKeyId = process.env["S3_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY"];
  if (!accessKeyId || !secretAccessKey) return null;

  return new S3Client({
    ...(endpoint ? { endpoint } : {}),
    region: process.env["S3_REGION"] ?? "auto",
    // Required for MinIO — virtual-host addressing needs per-bucket DNS a
    // local container does not have. Harmless against real S3 too.
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: documentId } = await params;

  const doc = await storage.getIngestedDocument(documentId);
  if (!doc?.originalKey) {
    return NextResponse.json(
      { error: "no source document found for this event" },
      { status: 404 },
    );
  }

  const bucket = process.env["S3_BUCKET"];
  const client = s3Client();
  if (!bucket || !client) {
    return NextResponse.json(
      { error: "object storage is not configured on this deployment" },
      { status: 501 },
    );
  }

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: doc.originalKey }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  return NextResponse.redirect(url);
}
