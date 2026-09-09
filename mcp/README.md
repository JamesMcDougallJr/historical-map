# Historical Map — MCP App

Embed the interactive historical map inline in Claude, as an [MCP App](https://claude.com/docs/connectors/building/mcp-apps).

Two transports share one registration module (`mcp/register.ts`):

| Transport | Entrypoint | Audience | Tools |
|---|---|---|---|
| stdio | `mcp/server.ts` | you, via Claude Desktop | read **and write** |
| Streamable HTTP | `app/api/mcp/route.ts` | anyone, as a custom connector | read-only |

## Local setup (stdio)

### 1. Build the MCP iframe

```bash
npm run build:mcp
# Produces mcp/dist/mcp-app.html — a single self-contained file
```

### 2. Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "historical-map": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/historical-map/mcp/server.ts"],
      "env": {
        "MAP_DATA_PATH": "/absolute/path/to/historical-map/data/map-data.json"
      }
    }
  }
}
```

Replace `/absolute/path/to/historical-map` with the actual path.

An optional `MAP_API_KEY` env var secures the Next.js data API routes:

```json
{
  "env": {
    "MAP_DATA_PATH": "...",
    "MAP_API_KEY": "your-secret-key"
  }
}
```

### 3. Restart Claude Desktop

The `historical-map` server will appear in the MCP server list.

## Usage

Ask Claude:
- **"Show me my historical map"** → `show_map` tool renders the map inline
- **"Show events from the 1860s"** → `show_map` with a query filter
- **"Add the Golden Spike ceremony to my map"** → `add_event` tool writes to `data/map-data.json`
- **"What events do I have near Salt Lake City?"** → `search_events` tool

## Available Tools

| Tool | Description | Public connector |
|------|-------------|------------------|
| `show_map` | Renders the interactive map inline (with optional keyword filter) | yes |
| `search_events` | Returns matching events as JSON (no UI) | yes |
| `list_locations` | Lists all locations with event counts | yes |
| `add_event` | Creates a location + event, saves to `data/map-data.json` | **no** |
| `delete_location` | Removes a location and its events | **no** |

Write tools are gated by `registerAll(server, { writable: true })`, which only
`mcp/server.ts` passes. The HTTP route is unauthenticated, so it must stay read-only.

## Publishing as a custom connector

The Streamable HTTP endpoint lives at `/api/mcp` and is stateless, so it runs as an
ordinary serverless function. No OAuth — the data is public and read-only.

1. Set `MCP_SERVER_URL` in the deployment environment to the endpoint's public URL,
   e.g. `https://your-app.vercel.app/api/mcp`. It seeds `_meta.ui.domain`, the stable
   origin the sandbox is given; a mismatch with the live URL breaks tile CORS.
2. Deploy. `prebuild` runs `build:mcp`, and `outputFileTracingIncludes` in
   `next.config.mjs` traces `mcp/dist/**` into the function bundle.
3. In Claude: **Customize → Connectors → Add custom connector**, paste the URL.

Verify before adding it to Claude:

```bash
npx @modelcontextprotocol/inspector    # point it at http://localhost:3000/api/mcp
```

`tools/list` should show `_meta.ui.resourceUri` on `show_map`, and `resources/read`
should return `text/html;profile=mcp-app`.

Note `middleware.ts` exempts `/api/mcp` from User-Agent bot filtering — MCP clients and
proxies (`mcp-remote`, the Inspector) present UAs that the filter otherwise blocks.

## Storage

`lib/server-storage.ts` picks a backend at call time:

| `POSTGRES_URL` | Backend | Used by |
|---|---|---|
| unset | `data/map-data.json` | local dev, stdio MCP |
| set | Postgres (`lib/postgres-storage.ts`) | deployments |

Serverless filesystems are ephemeral and read-only, so writes only persist under
Postgres. Tables are created on demand by `ensureSchema()`; seed them from the JSON
file with:

```bash
POSTGRES_URL=... npm run seed:db
```

Re-running is safe — locations upsert and events are `ON CONFLICT DO NOTHING`.

## Browser Sync

When running the Next.js dev server alongside Claude Desktop, the browser map polls
`GET /api/data/locations` every 5 seconds. Events added via MCP appear in the browser
within 5 seconds.

To enable polling, set `NEXT_PUBLIC_MAP_API_KEY` in your `.env.local`:

```
MAP_API_KEY=your-secret-key
NEXT_PUBLIC_MAP_API_KEY=your-secret-key
```

## Debugging

```bash
# Test the MCP server with the inspector
npx @modelcontextprotocol/inspector tsx mcp/server.ts

# Start the server directly (no output expected — stdio transport)
npm run mcp
```

## CSP Limitations

The MCP App runs in a host-controlled sandboxed iframe. The host builds a Content
Security Policy from `_meta.ui.csp` on the resource, and the browser blocks any
undeclared origin **before the request is sent** — so a missing origin shows up as a
blank map, not an error. Origins are declared as `TILE_ORIGINS` in `mcp/register.ts`
and applied to both `connectDomains` (fetch/XHR/WebSocket) and `resourceDomains`
(img/script/style/font/media).

The nesting matters: these belong under `_meta.ui.csp`, not directly on `_meta.ui`.
The schema sets `additionalProperties: false`, so a misplaced key is silently dropped
and every external origin gets blocked.

Currently declared: `tile.openstreetmap.org` + subdomains (the OL `OSM` base layer),
`vtiles.openhistoricalmap.org` (OHM vector tiles), `basemap.nationalmap.gov` (USGS
WMS), `allmaps.org` / `*.allmaps.org`, `cdn-icons-png.flaticon.com`.

Known not to work inside the sandbox — both work normally in the browser at `/map`:

- **Custom tile layers with arbitrary URLs.** They can't be pre-declared, by definition.
- **Allmaps georeferenced overlays.** `*.allmaps.org` covers the annotation fetch, but
  the warped image tiles come from whichever IIIF server hosts the scan, which is
  arbitrary. `WarpedMapLayer` may also want blob-URL Web Workers, and `McpUiResourceCsp`
  has no `worker-src` field to request them.

Upstream host bugs worth knowing when debugging: claude.ai
[ignores `frameDomains`](https://github.com/anthropics/claude-ai-mcp/issues/40) (this App
uses no nested iframes) and has
[intermittent capability-refresh failures](https://github.com/anthropics/claude-ai-mcp/issues/636)
for custom Streamable HTTP connectors.
