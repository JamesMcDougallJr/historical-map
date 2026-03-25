import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as storage from "../lib/server-storage.js";
import {
  generateLocationId,
  generateEventId,
} from "../app/map/utils/storage.js";

const server = new McpServer({ name: "historical-map", version: "1.0.0" });

const resourceUri = "ui://historical-map/mcp-app.html";

// Resolve dist path relative to this source file — CWD is unreliable when
// Claude Desktop spawns the server process.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_APP_HTML = path.join(__dirname, "..", "dist", "mcp", "mcp-app.html");

// ── Tool visible to Claude ──────────────────────────────────────────────────

registerAppTool(
  server,
  "show_map",
  {
    title: "Show Historical Map",
    description:
      "Display the interactive historical map. Optionally filter by search query or highlight a specific location.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Search query to filter events by keyword"),
      filterYear: z
        .number()
        .optional()
        .describe("Show only map overlays active in this year"),
      locationId: z
        .string()
        .optional()
        .describe("Pan to and highlight this location ID"),
    },
    _meta: { ui: { resourceUri } },
  },
  async (args): Promise<CallToolResult> => {
    const locations = args.query
      ? storage.searchEvents(args.query).map((r) => r.location)
      : storage.getLocations();

    // Deduplicate locations (a location may appear multiple times in search results)
    const seen = new Set<string>();
    const uniqueLocations = locations.filter((l) => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });

    return {
      content: [
        {
          type: "text",
          text: `Showing map with ${uniqueLocations.length} location(s).`,
        },
      ],
      structuredContent: {
        locations: uniqueLocations,
        filterYear: args.filterYear,
        locationId: args.locationId,
      },
    };
  },
);

// ── Standard tools (text only, no UI) ──────────────────────────────────────

server.tool(
  "search_events",
  {
    q: z.string().describe("Search query"),
    fromYear: z
      .number()
      .optional()
      .describe("Filter: events on or after this year"),
    toYear: z
      .number()
      .optional()
      .describe("Filter: events on or before this year"),
  },
  async (args): Promise<CallToolResult> => {
    const results = storage.searchEvents(args.q, args.fromYear, args.toYear);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
);

server.tool("list_locations", {}, async (): Promise<CallToolResult> => {
  const locations = storage.getLocations();
  const summary = locations.map((l) => ({
    id: l.id,
    name: l.name,
    coordinates: l.coordinates,
    eventCount: l.events.length,
  }));
  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
  };
});

server.tool(
  "add_event",
  {
    locationName: z.string().describe("Name of the location (creates if new)"),
    latitude: z.number(),
    longitude: z.number(),
    title: z.string().describe("Event title"),
    date: z.string().describe('ISO 8601 date, e.g. "1869-05-10"'),
    description: z.string(),
    source: z.string().optional().describe("Source citation"),
  },
  async (args): Promise<CallToolResult> => {
    // Find or create location
    let loc = storage.getLocations().find((l) => l.name === args.locationName);
    if (!loc) {
      const id = generateLocationId(args.locationName);
      storage.upsertLocation({
        id,
        name: args.locationName,
        coordinates: [args.longitude, args.latitude],
        events: [],
      });
      loc = storage.getLocation(id)!;
    }

    const event = {
      id: generateEventId(),
      title: args.title,
      date: args.date,
      description: args.description,
      source: args.source,
    };

    const updated = storage.addEventsToLocation(loc.id, [event]);
    return {
      content: [
        {
          type: "text",
          text: `Added event "${args.title}" to location "${args.locationName}" (id: ${loc.id}).`,
        },
      ],
      structuredContent: { location: updated },
    };
  },
);

server.tool(
  "delete_location",
  { id: z.string().describe("Location ID to delete") },
  async (args): Promise<CallToolResult> => {
    const deleted = storage.deleteLocation(args.id);
    return {
      content: [
        {
          type: "text",
          text: deleted
            ? `Deleted location ${args.id}.`
            : `Location ${args.id} not found.`,
        },
      ],
    };
  },
);

// ── Resource ────────────────────────────────────────────────────────────────

registerAppResource(
  server,
  resourceUri,
  resourceUri,
  {
    name: "Historical Map UI",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        // Known tile domains — custom user tile URLs are arbitrary and cannot be pre-declared
        connectDomains: [
          "https://tile.openstreetmap.org",
          "https://*.tile.openstreetmap.org",
          "https://tiles.stadiamaps.com",
          "https://vtiles.openhistoricalmap.org",
          "https://basemap.nationalmap.gov",
          "https://allmaps.org",
          "https://*.allmaps.org",
          "https://cdn-icons-png.flaticon.com",
        ],
        resourceDomains: [
          "https://tile.openstreetmap.org",
          "https://*.tile.openstreetmap.org",
          "https://tiles.stadiamaps.com",
          "https://vtiles.openhistoricalmap.org",
          "https://basemap.nationalmap.gov",
          "https://allmaps.org",
          "https://*.allmaps.org",
          "https://cdn-icons-png.flaticon.com",
        ],
      },
    },
  },
  async (): Promise<ReadResourceResult> => {
    const html = await fs.readFile(MCP_APP_HTML, "utf-8");
    return {
      contents: [
        { uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html },
      ],
    };
  },
);

// ── Start ───────────────────────────────────────────────────────────────────

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
