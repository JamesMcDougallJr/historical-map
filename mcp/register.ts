// Shared tool + resource registration for both MCP transports:
//   - mcp/server.ts          → stdio, for Claude Desktop (read/write)
//   - app/api/mcp/route.ts   → Streamable HTTP, the public connector (read-only)

import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as storage from "../lib/server-storage";
import { generateLocationId, generateEventId } from "../app/map/utils/storage";
import type { HistoricalLocation } from "../app/map/types";
import type { EventQuery } from "../app/map/utils/event-query";
import { loadAppHtml } from "./app-html";

export const RESOURCE_URI = "ui://historical-map/mcp-app.html";

// ── CSP ─────────────────────────────────────────────────────────────────────
// The App runs in a host-controlled sandboxed iframe. Origins not declared here
// are blocked by the browser before the request is made — an undeclared tile
// host renders as a blank map, not an error. Every origin goes in both lists:
// resourceDomains covers img/script/style/font/media, connectDomains covers
// fetch/XHR/WebSocket, and OpenLayers uses both depending on the layer type.
const TILE_ORIGINS = [
  "https://tile.openstreetmap.org",
  "https://*.tile.openstreetmap.org",
  "https://tiles.stadiamaps.com",
  "https://vtiles.openhistoricalmap.org",
  "https://basemap.nationalmap.gov",
  "https://allmaps.org",
  "https://*.allmaps.org",
  "https://cdn-icons-png.flaticon.com",
];

/**
 * Stable origin for the sandbox, so tile hosts that echo `Origin` instead of
 * sending `Access-Control-Allow-Origin: *` can succeed. Without this the iframe
 * origin is the string "null" and those requests fail CORS.
 *
 * The hash format is host-specific; this is the shape Claude expects.
 */
function computeAppDomain(mcpServerUrl: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(mcpServerUrl)
    .digest("hex")
    .slice(0, 32);
  return `${hash}.claudemcpcontent.com`;
}

function appDomain(): string | undefined {
  const url =
    process.env["MCP_SERVER_URL"] ??
    (process.env["NEXT_PUBLIC_APP_URL"]
      ? `${process.env["NEXT_PUBLIC_APP_URL"].replace(/\/$/, "")}/api/mcp`
      : undefined);
  return url ? computeAppDomain(url) : undefined;
}

const RESOURCE_UI_META = {
  csp: {
    resourceDomains: TILE_ORIGINS,
    connectDomains: TILE_ORIGINS,
  },
  domain: appDomain(),
  prefersBorder: false,
};

// ── Payload trimming ────────────────────────────────────────────────────────
// Claude.ai caps tool results at ~150k characters. The map only needs enough to
// draw pins and popups.
const MAX_LOCATIONS = 100;
const MAX_DESCRIPTION = 600;

function trimForTransport(locations: HistoricalLocation[]): {
  locations: HistoricalLocation[];
  truncated: boolean;
} {
  const truncated = locations.length > MAX_LOCATIONS;
  const kept = truncated ? locations.slice(0, MAX_LOCATIONS) : locations;

  return {
    truncated,
    locations: kept.map((loc) => ({
      ...loc,
      events: loc.events.map((e) =>
        e.description.length > MAX_DESCRIPTION
          ? { ...e, description: `${e.description.slice(0, MAX_DESCRIPTION)}…` }
          : e,
      ),
    })),
  };
}

export interface RegisterOptions {
  /** Expose add_event / delete_location. Never enable on a public endpoint. */
  writable?: boolean;
}

export function registerAll(
  server: McpServer,
  { writable = false }: RegisterOptions = {},
): void {
  // ── App tool: renders the map inline ──────────────────────────────────────

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
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (args): Promise<CallToolResult> => {
      const matches = args.query
        ? (await storage.searchEvents({ q: args.query })).map((r) => r.location)
        : await storage.getLocations();

      // Deduplicate — a location appears once per matching event
      const seen = new Set<string>();
      const unique = matches.filter((l) => {
        if (seen.has(l.id)) return false;
        seen.add(l.id);
        return true;
      });

      const { locations, truncated } = trimForTransport(unique);

      const summary = truncated
        ? `Showing the first ${locations.length} of ${unique.length} matching location(s).`
        : `Showing map with ${locations.length} location(s).`;

      return {
        content: [{ type: "text", text: summary }],
        structuredContent: {
          locations,
          filterYear: args.filterYear,
          locationId: args.locationId,
        },
      };
    },
  );

  // ── Text-only tools ───────────────────────────────────────────────────────

  server.tool(
    "search_events",
    {
      q: z
        .string()
        .optional()
        .describe("Free-text search over title, description and location name"),
      fromYear: z
        .number()
        .optional()
        .describe("Filter: events on or after this year"),
      toYear: z
        .number()
        .optional()
        .describe("Filter: events on or before this year"),
      bbox: z
        .array(z.number())
        .length(4)
        .optional()
        .describe(
          "Geographic bounds as [minLon, minLat, maxLon, maxLat] in WGS84",
        ),
      sourceIds: z
        .array(z.string())
        .optional()
        .describe("Restrict to these source ids (see list_sources)"),
    },
    async (args): Promise<CallToolResult> => {
      const query: EventQuery = {};
      if (args.q) query.q = args.q;
      if (args.fromYear !== undefined) query.fromYear = args.fromYear;
      if (args.toYear !== undefined) query.toYear = args.toYear;
      if (args.sourceIds) query.sourceIds = args.sourceIds;
      if (args.bbox) query.bbox = args.bbox as [number, number, number, number];

      const results = await storage.searchEvents(query);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  server.tool("list_sources", {}, async (): Promise<CallToolResult> => {
    const sources = await storage.listSources();
    return {
      content: [{ type: "text", text: JSON.stringify(sources, null, 2) }],
    };
  });

  server.tool("list_locations", {}, async (): Promise<CallToolResult> => {
    const summary = (await storage.getLocations()).map((l) => ({
      id: l.id,
      name: l.name,
      coordinates: l.coordinates,
      eventCount: l.events.length,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  });

  if (writable) registerWriteTools(server);

  // ── App resource ──────────────────────────────────────────────────────────
  // `_meta.ui` here is the resources/list fallback; the copy on the content
  // item below takes precedence at read time. Hosts read one or the other, so
  // both carry the same value.

  registerAppResource(
    server,
    "Historical Map UI",
    RESOURCE_URI,
    {
      description:
        "Interactive historical map with pins, timeline and overlays",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: RESOURCE_UI_META },
    },
    async (): Promise<ReadResourceResult> => {
      const html = await loadAppHtml();
      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: RESOURCE_UI_META },
          },
        ],
      };
    },
  );
}

function registerWriteTools(server: McpServer): void {
  server.tool(
    "add_event",
    {
      locationName: z
        .string()
        .describe("Name of the location (creates if new)"),
      latitude: z.number(),
      longitude: z.number(),
      title: z.string().describe("Event title"),
      date: z.string().describe('ISO 8601 date, e.g. "1869-05-10"'),
      description: z.string(),
      source: z.string().optional().describe("Source citation"),
    },
    async (args): Promise<CallToolResult> => {
      let loc = (await storage.getLocations()).find(
        (l) => l.name === args.locationName,
      );
      if (!loc) {
        const id = generateLocationId(args.locationName);
        await storage.upsertLocation({
          id,
          name: args.locationName,
          coordinates: [args.longitude, args.latitude],
          events: [],
        });
        loc = (await storage.getLocation(id))!;
      }

      const updated = await storage.addEventsToLocation(loc.id, [
        {
          id: generateEventId(),
          title: args.title,
          date: args.date,
          description: args.description,
          source: args.source,
        },
      ]);

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
      const deleted = await storage.deleteLocation(args.id);
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
}
