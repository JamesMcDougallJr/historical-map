import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
import { MapView } from "../app/map/components/MapView";
import type { HistoricalLocation } from "../app/map/types";
import "ol/ol.css";
import "../app/global.css";

// In the sandboxed iframe, window.location.origin is "null"
const isMcpApp = window.location.origin === "null";

interface McpAppParams {
  locations?: HistoricalLocation[];
  filterYear?: number;
  locationId?: string;
}

async function main() {
  const rootEl = document.getElementById("root");
  if (!rootEl) return;

  const root = createRoot(rootEl);

  // Render immediately with empty data to avoid blank iframe
  root.render(
    <StrictMode>
      <MapView locations={[]} showNav={false} />
    </StrictMode>,
  );

  if (isMcpApp) {
    const mcpApp = new App({ name: "historical-map", version: "1.0.0" });

    // All handlers must be registered BEFORE connect()
    mcpApp.ontoolresult = (result) => {
      const params = (result.structuredContent as McpAppParams | null) ?? {};
      root.render(
        <StrictMode>
          <MapView locations={params.locations ?? []} showNav={false} />
        </StrictMode>,
      );
    };

    mcpApp.onhostcontextchanged = (ctx) => {
      if (ctx.theme) applyDocumentTheme(ctx.theme);
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    };

    mcpApp.onteardown = async () => ({});

    await mcpApp.connect(); // defaults to PostMessageTransport(window.parent)
  }
}

main().catch(console.error);
