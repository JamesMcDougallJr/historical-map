// The actual CORS response headers are added by next.config.mjs's `headers()`
// to every response matching `/api/:path*`, regardless of status — but that
// alone does not make a preflight succeed. A browser's preflight `OPTIONS`
// request needs a *successful* response carrying those headers; without an
// exported `OPTIONS` handler, Next's App Router 405s it, and a non-2xx
// preflight fails even though the CORS headers rode along on the 405 too.
// Every route callable cross-origin (i.e. from apps/admin) needs this export.

import { NextResponse } from "next/server";

export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204 });
}
