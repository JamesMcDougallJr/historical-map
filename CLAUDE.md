# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Next.js dev server
npm run build        # Production build (prebuild runs build:mcp first)
npm run type-check   # TypeScript without emitting — the real correctness gate
npm run format       # Prettier
npm run build:mcp    # Bundle the MCP App iframe → mcp/dist/mcp-app.html
npm run mcp          # Run the stdio MCP server (no output; it speaks stdio)
npm run seed:db      # Seed Postgres from data/map-data.json (needs POSTGRES_URL)
```

No test suite is configured. **`npm run lint` is broken** — it calls `next lint`, which
Next 16 removed, and there is no `eslint.config.js`. Use `npm run type-check` instead.

`npm run build:mcp` must be re-run after changing anything the MCP App renders
(`MapView` and its imports); the bundle is a build artifact, not live code.

### Debugging note

`next dev` (Turbopack) can serve a **stale CSS chunk under an unchanged filename**, which
looks exactly like broken layout CSS — collapsed heights, an OpenLayers
`"map container's width or height are 0"` warning, and a blank map. Before believing any
styling diagnosis, `rm -rf .next` and hard-reload. Verify a stylesheet's real content with
`fetch(href, { cache: 'reload' })`, not a plain `fetch`.

## Architecture

**Next.js App Router** app with one major feature — an interactive historical map — exposed
through two surfaces: the web app at `/map`, and an MCP server that renders the same map
inline in Claude.

### The three storage tiers

This is the least obvious part of the codebase. Three separate stores hold the same
`HistoricalEventsData` shape, and which one is authoritative depends on the caller:

| Store | Module | Used by |
|---|---|---|
| `localStorage` (`'historical-events'`) | `app/map/utils/storage.ts` | browser only; SSR-guarded |
| `data/map-data.json` | `lib/server-storage.ts` | local dev, stdio MCP server |
| Postgres | `lib/postgres-storage.ts` | any deploy with `POSTGRES_URL` set |

`lib/server-storage.ts` is the server-side entry point and picks its backend at call time
on `POSTGRES_URL`. Its API mirrors the browser module's but is **async** — serverless
filesystems are ephemeral and read-only, so writes only persist under Postgres. Postgres
tables are created on demand by `ensureSchema()`.

`app/map/page.tsx` (thin, 102 lines) bridges browser and server: on first visit it seeds
`localStorage` from `GET /api/data/locations`, and it polls that endpoint every 5s to pick
up writes made through the MCP server — but **only when `NEXT_PUBLIC_MAP_API_KEY` is set**.

### MapView is shared by both surfaces

`app/map/components/MapView.tsx` (~700 lines, `'use client'`) holds the entire OpenLayers
lifecycle and is rendered by both the web page and the MCP App. `showNav={false}` strips the
nav chrome for embedding. Changing it affects Claude's inline map too.

- Map + popup overlay are created in a `useEffect` keyed on `locations` — this re-creates
  the events layer each time rather than diffing features
- `overlayLayersRef` (a `Map<string, BaseLayer>`) caches OL layers by overlay ID
- Popup hover uses a 300ms debounce; `isPinnedRef` mirrors `isPinned` state to avoid stale
  closures in OL event handlers

### MCP server — two transports, one registration

`mcp/register.ts` is the single source of tools and the UI resource. Two thin entrypoints
consume it:

- `mcp/server.ts` — stdio, for Claude Desktop. Calls `registerAll(server, { writable: true })`
- `app/api/mcp/route.ts` — stateless Streamable HTTP, the public custom connector.
  Read-only, because `/api/data/*` treats a missing `MAP_API_KEY` as "allow", so an
  unguarded write tool on a public URL would be an open write endpoint

**CSP is the thing that breaks the inline map.** The App runs in a host-controlled sandboxed
iframe; the host builds a CSP from `_meta.ui.csp` on the resource, and any undeclared origin
is blocked *before the request is sent* — which renders as a blank map, not an error. The
domain lists must be nested under `_meta.ui.csp`, not directly on `_meta.ui`: the schema is
`additionalProperties: false`, so a misplaced key is silently dropped and every external
origin gets blocked. Origins live in `TILE_ORIGINS` in `mcp/register.ts` and go in both
`connectDomains` and `resourceDomains`. `_meta.ui` is set in two places — on the
registration (the `resources/list` fallback) and on the content item (which takes
precedence at read time).

Arbitrary user tile URLs and Allmaps IIIF overlays cannot work in the sandbox: their origins
are unknowable ahead of time. They work normally at `/map`. See `mcp/README.md`.

The bundle is read from disk at runtime, so Next cannot trace it automatically —
`outputFileTracingIncludes` in `next.config.mjs` pulls `mcp/dist/**` into the
`/api/mcp` function, and `prebuild` guarantees it exists.

### Overlay system

`HistoricalOverlay` supports four sources: `allmaps` (IIIF georeferenced via
`@allmaps/openlayers`), `ohm` (vector tiles / MVT), `usgs` (WMS), `custom` (XYZ tiles).
`DEFAULT_OVERLAYS` in `utils/overlays.ts` are the built-ins; users can add their own.
Overlays are filtered by `yearRange` when the timeline slider is active.

### Import feature (`/map/import`)

Multi-step document import: paste text or upload PDF → AI parse (Claude API via `/api/parse`)
→ review events → save to localStorage. PDF extraction uses `unpdf` on the server
(`serverExternalPackages: ['unpdf']`).

### API routes

- `/api/parse` — sends text to Claude, returns `ParsedEvent[]` (rate-limited 10/min)
- `/api/parse-pdf` — PDF text extraction via `unpdf` (rate-limited 3/min)
- `/api/fetch-content` — proxies URL fetch (used by import flow)
- `/api/data/locations`, `/api/data/locations/[id]/events`, `/api/data/search` — CRUD over
  `lib/server-storage.ts`, gated on an optional `x-api-key` vs `MAP_API_KEY`
- `/api/mcp` — the MCP connector

### Security

`middleware.ts` runs on all non-asset routes: UA-based bot filtering, per-IP sliding-window
rate limiting, and per-request CSP nonce injection. `connect-src *` and `img-src *` are
intentionally wide — user-provided tile URLs are arbitrary.

Two gotchas: `/api/mcp` is **exempt from the UA filter**, because MCP clients and proxies
(`mcp-remote`, the Inspector) send User-Agents matching the blocklist (`curl`, `python-requests`,
…). And `next.config.mjs` needs its `/api/mcp/:path*` CORS block to stay **ahead of** the
generic `/api/:path*` one, which only permits `POST, OPTIONS` and `Content-Type`.

### Types & path alias

Shared types live in `app/map/types.ts`: `HistoricalLocation`, `HistoricalEvent`,
`HistoricalEventsData`, `HistoricalOverlay`. `@/*` maps to the repo root.

Imports under `mcp/` must be **extensionless** (`../lib/server-storage`, not `.js`) —
Turbopack will not map `.js` → `.ts` when bundling `mcp/register.ts` into the route handler.
