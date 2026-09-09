import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
import { MapView } from "../app/map/components/MapView";
import type { EventLayer, HistoricalLocation } from "../app/map/types";
import "ol/ol.css";
import "../app/global.css";

// The host always renders the App in an iframe. Opening dist/mcp-app.html
// directly (for debugging) is top-level, and skips the handshake.
//
// Deliberately not keyed off `window.location.origin === "null"`: declaring
// `_meta.ui.domain` on the resource gives the sandbox a real origin, which
// would silently disable the handshake.
const isFramed = window.parent !== window;

// The App's events arrive via structuredContent, and the sandbox has no origin
// to resolve a relative URL against — so render pins from memory rather than
// fetching them the way the web app does.
const INLINE_LAYERS: EventLayer[] = [
  {
    id: "mcp-inline",
    name: "Historical Events",
    kind: "inline",
    url: "",
    color: "#3b82f6",
    enabled: true,
  },
];

interface McpAppParams {
  locations?: HistoricalLocation[];
  filterYear?: number;
  locationId?: string;
}

async function main() {
  const rootEl = document.getElementById("root");
  if (!rootEl) return;

  const root = createRoot(rootEl);

  const render = (locations: HistoricalLocation[]) =>
    root.render(
      <StrictMode>
        <MapView
          locations={locations}
          initialEventLayers={INLINE_LAYERS}
          showNav={false}
        />
      </StrictMode>,
    );

  // Render immediately with empty data to avoid a blank iframe
  render([]);

  if (!isFramed) return;

  const mcpApp = new App({ name: "historical-map", version: "1.0.0" });

  // All handlers must be registered BEFORE connect()
  mcpApp.ontoolresult = (result) => {
    const params = (result.structuredContent as McpAppParams | null) ?? {};
    render(params.locations ?? []);
  };

  mcpApp.onhostcontextchanged = (ctx) => {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.safeAreaInsets) {
      const { top, right, bottom, left } = ctx.safeAreaInsets;
      document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    }
  };

  mcpApp.onteardown = async () => ({});

  await mcpApp.connect(); // defaults to PostMessageTransport(window.parent)
}

main().catch(console.error);
