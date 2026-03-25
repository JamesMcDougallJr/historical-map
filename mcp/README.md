# Historical Map — MCP App

Embed the interactive historical map directly in Claude Desktop as an inline MCP App.

## Setup

### 1. Build the MCP iframe

```bash
npm run build:mcp
# Produces dist/mcp-app.html — a single self-contained file
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

| Tool | Description |
|------|-------------|
| `show_map` | Renders the interactive map inline (with optional keyword filter) |
| `search_events` | Returns matching events as JSON (no UI) |
| `list_locations` | Lists all locations with event counts |
| `add_event` | Creates a location + event, saves to `data/map-data.json` |
| `delete_location` | Removes a location and its events |

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

The MCP iframe runs sandboxed. Known tile domains are declared in the resource
`connectDomains` / `resourceDomains` config:

- `tiles.stadiamaps.com` (base map)
- `vtiles.openhistoricalmap.org` (OHM vector tiles)
- `basemap.nationalmap.gov` (USGS WMS)
- `allmaps.org`, `*.allmaps.org` (IIIF georeferenced maps)

**Custom tile layers with arbitrary URLs will not load in MCP mode** — this is a
known trade-off of the sandboxed iframe. They work normally in the browser at `/map`.
