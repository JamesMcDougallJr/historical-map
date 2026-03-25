# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Next.js dev server
npm run build        # Production build
npm run lint         # ESLint
npm run type-check   # TypeScript without emitting
npm run format       # Prettier
```

No test suite is configured.

## Architecture

**Next.js App Router** app with a single major feature: an interactive historical map at `/map`.

### Data flow

All user data lives in **localStorage** (`'historical-events'` key) as `HistoricalEventsData` (version, lastUpdated, locations[]). There is no database. The `app/map/utils/storage.ts` module is the sole interface for reads and writes — it handles SSR safety (`typeof window === 'undefined'` guard).

### Map page (`app/map/page.tsx`)

Heavy client component (~660 lines, `'use client'`). Manages the full OpenLayers map lifecycle:

- Map + popup overlay are created in a `useEffect` that re-runs when `locations` state changes — this re-creates the events layer each time rather than diffing features
- `overlayLayersRef` (a `Map<string, BaseLayer>`) caches OL layers by overlay ID to avoid re-creating them on re-renders
- Popup hover uses a 300ms debounce timeout; `isPinnedRef` is a ref mirror of `isPinned` state to prevent stale closures in OL event handlers
- The `?t=` search param (from import navigation) triggers a localStorage reload via `refreshKey`

### Overlay system

`HistoricalOverlay` supports four sources: `allmaps` (IIIF georeferenced via `@allmaps/openlayers`), `ohm` (vector tiles / MVT), `usgs` (WMS), `custom` (XYZ tiles). `DEFAULT_OVERLAYS` in `utils/overlays.ts` are the built-in options; users can add their own. Overlays are filtered by `yearRange` when the timeline slider is active.

### Import feature (`/map/import`)

Multi-step document import: paste text or upload PDF → AI parse (Claude API via `/api/parse`) → review events → save to localStorage. PDF extraction uses `unpdf` on the server (`serverExternalPackages: ['unpdf']`).

### API routes

Thin server-side routes for AI-assisted parsing:
- `/api/parse` — sends text to Claude, returns `ParsedEvent[]` (rate-limited: 10 req/min)
- `/api/parse-pdf` — PDF text extraction via `unpdf` (rate-limited: 3 req/min)
- `/api/fetch-content` — proxies URL fetch (used by import flow)

### Security

`middleware.ts` runs on all non-asset routes: UA-based bot filtering, per-IP sliding-window rate limiting for API routes, and per-request CSP nonce injection. `connect-src *` and `img-src *` are intentionally wide — user-provided tile URLs (Allmaps IIIF, custom XYZ) are arbitrary.

### Types

Shared types live in `app/map/types.ts`. The main interfaces are `HistoricalLocation`, `HistoricalEvent`, `HistoricalEventsData`, and `HistoricalOverlay`.

### Path alias

`@/*` maps to the repo root (e.g. `@/app/map/types`).
