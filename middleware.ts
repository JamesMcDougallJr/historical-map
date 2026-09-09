import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Bot filtering — block scanners/scrapers that self-identify via User-Agent
// ---------------------------------------------------------------------------
const BLOCKED_UA =
  /sqlmap|nikto|masscan|curl|wget|python-requests|go-http-client/i;

// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter
// Per-edge-isolate, not distributed. Stops sequential floods and naive abuse.
// For distributed DDoS protection, Vercel Firewall (Pro) is required.
// ---------------------------------------------------------------------------
interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "/api/parse-pdf": { maxRequests: 3, windowMs: 60_000 },
  "/api/parse": { maxRequests: 10, windowMs: 60_000 },
};

// Bounded map to prevent unbounded memory growth
const MAX_IPS = 5000;
const ipTimestamps = new Map<string, number[]>();

function isRateLimited(ip: string, path: string): boolean {
  const config = RATE_LIMITS[path];
  if (!config) return false;

  const now = Date.now();
  const key = `${ip}:${path}`;
  const timestamps = ipTimestamps.get(key) ?? [];

  // Slide window: drop timestamps older than windowMs
  const recent = timestamps.filter((t) => now - t < config.windowMs);

  if (recent.length >= config.maxRequests) return true;

  // Evict oldest entry if at capacity (bounded map)
  if (!ipTimestamps.has(key) && ipTimestamps.size >= MAX_IPS) {
    const oldestKey = ipTimestamps.keys().next().value;
    if (oldestKey) ipTimestamps.delete(oldestKey);
  }

  recent.push(now);
  ipTimestamps.set(key, recent);
  return false;
}

// ---------------------------------------------------------------------------
// CSP nonce generation
// ---------------------------------------------------------------------------
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...Array.from(bytes)));
}

function buildCSP(nonce: string): string {
  const directives = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'", // Tailwind v4 + OL inject styles at runtime
    "font-src 'self'", // Geist is self-hosted
    "img-src 'self' data: blob: *", // Allmaps IIIF tiles are arbitrary URLs
    "connect-src 'self' *", // User-provided tile URLs, WMS, OHM, USGS, Allmaps
    "worker-src 'self' blob:", // OL/Allmaps use blob-URL Web Workers
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const isApiRoute = pathname.startsWith("/api/");

  // The MCP connector is spoken to by MCP clients and proxies (mcp-remote, the
  // Inspector) whose User-Agents look exactly like the ones we block below.
  const isMcpRoute =
    pathname === "/api/mcp" || pathname.startsWith("/api/mcp/");

  // 1. Bot filtering (API routes only)
  if (isApiRoute && !isMcpRoute) {
    const ua = request.headers.get("user-agent") ?? "";
    if (BLOCKED_UA.test(ua)) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // 2. Rate limiting (API routes only)
  if (isApiRoute && RATE_LIMITS[pathname] !== undefined) {
    const forwarded = request.headers.get("x-forwarded-for");
    const firstForwarded = forwarded
      ? (forwarded.split(",")[0] ?? "").trim()
      : "";
    const ip =
      firstForwarded || request.headers.get("x-real-ip") || "127.0.0.1";

    if (isRateLimited(ip, pathname)) {
      return new NextResponse("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }

  // 3. CSP nonce — apply to all non-asset routes.
  // The nonce must go on the *request* headers, not just the response: server
  // components read it via headers().get("x-nonce") (see app/layout.tsx). With
  // it only on the response, the layout rendered nonce="" — leaving the inline
  // theme script unnonced (and so blocked by script-src) and producing a
  // hydration mismatch against the nonce Next injects from the CSP header.
  const nonce = generateNonce();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set("x-nonce", nonce);
  response.headers.set("Content-Security-Policy", buildCSP(nonce));

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
