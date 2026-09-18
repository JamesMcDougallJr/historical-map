/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,

  serverExternalPackages: ['unpdf'],

  // `packages/domain` ships TypeScript source, not a build artifact, so neither
  // the web app nor the Nest workspace has to build it first. Next therefore
  // has to compile it itself. Today every import of it is `import type` and is
  // erased before bundling — this exists so the first runtime export added to
  // the package (a shared zod schema, say) doesn't fail resolution.
  transpilePackages: ['@historical-map/domain', '@historical-map/api-client'],

  // The MCP App bundle is read at runtime, so Next's tracer can't see it.
  // Built by `npm run build:mcp`, which `prebuild` runs ahead of `next build`.
  outputFileTracingIncludes: {
    '/api/mcp': ['./mcp/dist/**'],
  },

  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60,
  },

  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? { exclude: ['error', 'warn'] }
        : false,
  },

  experimental: {
    optimizePackageImports: ['ol'],
  },

  async headers() {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '*';
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // CSP is set dynamically in middleware.ts (nonce requires per-request generation)
        ],
      },
      {
        // Only immutable in production, where the filename is content-hashed and
        // genuinely never changes. In `next dev`, Turbopack reuses the same chunk
        // filename across recompiles (see CLAUDE.md's stale-chunk section) — an
        // immutable, one-year Cache-Control on that same URL means the browser
        // never re-requests it after an edit, which is indistinguishable from the
        // edit not having happened. `max-age=0, must-revalidate` in dev keeps a
        // reload actually reflecting what the server just built.
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value:
              process.env.NODE_ENV === 'production'
                ? 'public, max-age=31536000, immutable'
                : 'no-cache, must-revalidate',
          },
        ],
      },
      {
        // Must precede /api/:path* — the MCP transport needs GET/DELETE and its
        // own headers, which the generic API block below does not allow.
        source: '/api/mcp/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, DELETE, OPTIONS' },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
          },
          { key: 'Access-Control-Expose-Headers', value: 'Mcp-Session-Id, Mcp-Protocol-Version' },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Access-Control-Allow-Origin', value: appUrl },
          // GET/PATCH/DELETE and the x-api-key header are needed for
          // apps/admin (a separate origin) to read and write /api/data/*.
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PATCH, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, x-api-key' },
        ],
      },
    ]
  },
}

export default nextConfig
