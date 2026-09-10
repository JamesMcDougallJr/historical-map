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
npm run type-check:all  # Nx fan-out: type-check every workspace
npm run build:all       # Nx fan-out: build every workspace
npm run graph           # Nx dependency graph
```

No test suite is configured. **`npm run lint` is broken** — it calls `next lint`, which
Next 16 removed, and there is no `eslint.config.js`. Use `npm run type-check` instead.

`npm run build:mcp` must be re-run after changing anything the MCP App renders
(`MapView` and its imports); the bundle is a build artifact, not live code.

### Debugging note — stale chunks

`next dev` (Turbopack) reuses **the same chunk filename across recompiles**, for both CSS and
JS. Nothing in the URL changes, so the browser can keep serving a cached copy indefinitely.
**Before believing any diagnosis, rule this out first** — it has repeatedly looked like a
logic bug and eaten hours.

The two present differently:

- **Stale CSS** — new utility classes are simply absent, so anything relying on one silently
  loses. A card written `hidden md:flex` collapsed to `display: none`, because the cached
  sheet had `.hidden` but not the newly added `.md\:flex` — the popup rendered with correct
  content and no box. Also looks like broken layout: collapsed heights, an OpenLayers
  `"map container's width or height are 0"` warning, a blank map.
- **Stale JS** — edits appear to have no effect. A newly added global read `undefined` at
  runtime while being plainly present in the file the server returned for that exact URL.

Verifying what is *actually applied* (not what the server would send):

| Ask | Do |
|---|---|
| Which CSS rules are in force | Walk `document.styleSheets` → `cssRules` (CSSOM reflects the applied sheet) |
| What the server would send now | `fetch(href, { cache: 'reload' })` — a plain `fetch` can be served from cache |
| Is the running JS current | Check for a symbol you just added, at runtime, not in the fetched text |

Server content and applied content disagreeing for the same URL *is* the bug — that
comparison is the fastest way to confirm it rather than infer it.

`rm -rf .next && npm run dev` is the reliable fix — it changes the chunk hashes, so the
browser has to fetch new URLs. A hard reload (`Cmd+Shift+R`) cleared the JS case but **not**
the CSS one, which needed the stylesheet re-requested under a cache-busting query. Don't
assume a plain refresh picked up your change.

### Dev-only map debug handles

`MapView` publishes two globals behind `process.env.NODE_ENV !== "production"` (stripped from
production builds):

| Global | What it is |
|---|---|
| `window.__olMap` | The live OpenLayers `Map` — layers, sources, view, hit testing |
| `window.__olDebug` | The popup/hover **refs** (read `.current`): `popupHovered`, `hoverTimeout`, `pinned`, `hoveredId` |

They exist because the hover and popup state deliberately lives in refs rather than state —
OpenLayers event handlers are registered once and would otherwise close over stale values
(see `isPinnedRef`, `isPopupHoveredRef`). Refs are invisible to React DevTools, so without
these handles the only way to reason about "is the pointer considered inside the popup?" or
"is a close timer armed?" is to infer it from behaviour, which is slow and gets it wrong.

```js
__olDebug.popupHovered.current          // is the map standing down for the popup?
!!__olDebug.hoverTimeout.current        // is a close timer armed?
__olMap.getLayers().getArray().map(l => l.get("eventLayerId"))
```

**Hit testing needs a rendered frame.** `forEachFeatureAtPixel` reads the last rendered frame,
and a backgrounded tab has `requestAnimationFrame` paused, so it returns `null` for pins that
are demonstrably there. Call `__olMap.renderSync()` first, and re-render immediately before
dispatching a synthetic `pointermove` — otherwise the pixel you probed and the frame the
handler reads can disagree.

## Architecture

**Next.js App Router** app with one major feature — an interactive historical map — exposed
through two surfaces: the web app at `/map`, and an MCP server that renders the same map
inline in Claude.

### Monorepo layout

npm workspaces, with **Nx as a package-based task runner only** — it owns no build, and every
target it runs is a plain `package.json` script.

| Path | What |
|---|---|
| `/` | **Root package = the Next.js web app.** Not under `apps/` — see below. |
| `packages/domain` | `@historical-map/domain` — event + ingestion types shared with the workers. |
| `services/ingest` | `@historical-map/ingest` — NestJS monorepo: apps `api`/`detect`/`fetch`/`extract`/`publish`, libs under `@app/*`. |
| `plans/` | Phased plan for the ingestion engine. |

**The web app is deliberately the root package.** Moving it to `apps/web` would require
flipping the Vercel project's Root Directory, which is project-wide rather than per-branch —
so PR previews and production cannot both stay green across the change.

`vercel.json` **pins `installCommand` and `buildCommand`**. Vercel infers its build from
detected monorepo tooling, and there is now an `nx.json` for it to detect; pinning means adding
a workspace can never silently reroute the web build. Don't remove those two keys.

`packages/domain` ships **TypeScript source, not a build artifact** — Next compiles it via
`transpilePackages`, resolved through the `@historical-map/domain` tsconfig path. Nothing has
to build it first and there is no `dist/` to go stale. `app/map/types.ts` re-exports it with
`export type *` (which erases at compile time), so every `@/app/map/types` import still works.

#### `services/ingest` needs a monorepo-aware webpack config

`services/ingest/webpack.config.js` exists because **Nest's default externals handling is
wrong in a workspaces monorepo, and fails at runtime rather than at build time.**

`nest build` externalizes `node_modules` via `webpack-node-externals`, which scans exactly one
directory — the one beside the build. npm hoists most packages to the repo root but leaves some
nested under `services/ingest/node_modules`. With only the local directory scanned, hoisted
packages aren't recognised as externals and get **bundled**, while nested ones stay **external**.
`@nestjs/core` (hoisted → bundled) and `@nestjs/typeorm` (nested → external) then hold different
`ModuleRef` class objects, and since Nest's DI matches by class identity, boot dies with:

```
Nest can't resolve dependencies of the TypeOrmCoreModule (TypeOrmModuleOptions, ?)
```

The config scans **both** directories, which fixes it and drops each bundle from ~2.8MB to
~19KB. `@historical-map/*` is allowlisted so it stays *bundled* — those packages are TS source,
so an external `require()` would resolve to a `.ts` file Node can't load.

#### Ingestion engine

`services/ingest` runs the pipeline `detect → fetch → extract → publish`. Local dev:

```bash
docker compose up -d db redis
export POSTGRES_URL=postgres://postgres:password@localhost:5433/db
npm run migrate      --workspace=services/ingest   # TypeORM migrations
npm run seed:sources --workspace=services/ingest   # creates the local-directory source
# drop .pdf/.txt/.md/.html into ./corpus, then run the detect + fetch workers
```

Offline verifiers, none of which need network or an API key: `sources:verify`
(adapter + all three parsers against fixtures), `db:verify`, `queue:verify`.

Two invariants that are easy to break and fail silently:

- **Only `fetch` writes `ingest_documents.etag`.** It is the hash of the bytes
  `fetch` last turned into text, and `fetch` compares it against what it just read
  to decide whether anything changed. If `detect` also wrote it when flagging a
  changed document, the two would already match, `fetch` would take its unchanged
  short-circuit, and the document would keep stale text forever while every status
  field reported success.
- **Parser registration order in `parsers.module.ts`.** `ParserRegistry.select`
  takes the first match and `TextParser` is a deliberate catch-all for unlabelled
  content, so it must stay last or it swallows PDFs whose server omitted a
  content type.

#### One TypeScript, pinned by path

`services/ingest`'s `type-check` script invokes `../../node_modules/typescript/bin/tsc`
by path rather than the bare binary. `@nestjs/cli` depends on an exact
`typescript@5.9.3`, which npm nests under `services/ingest/node_modules` where it
wins `.bin` precedence — while `ts-loader`, which actually compiles the code, resolves
the root's `5.3.3`. The two disagree (`RegExpMatchArray.index` is optional in 5.3.3
and not in 5.9.3), so a bare `tsc` passes on code `nest build` then rejects. Pointing
the script at the root compiler makes the gate match the build.

#### Nx in a worktree

Nx opens a daemon socket under the workspace path; from `.claude/worktrees/<name>` that path
exceeds the OS socket-length limit and `nx run-many` fails. Run it with a short socket dir:

```bash
NX_SOCKET_DIR=$TMPDIR/nxs npx nx run-many -t type-check
```

Not an issue from the main checkout, whose path is short enough.

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

Multi-step document import: paste text or upload PDF → parse → review events → save to
localStorage. PDF extraction uses `unpdf` on the server (`serverExternalPackages: ['unpdf']`).

**`/api/parse` does not call an LLM.** It runs `parseDocument()` from
`app/map/import/services/processing-service.ts` — the local `regex` and `structured` parsers.
There is no Claude API call and no `@anthropic-ai/sdk` dependency anywhere in the repo today;
the first one arrives with the ingestion engine's `extract` worker (`plans/08-extract-worker.md`).

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
