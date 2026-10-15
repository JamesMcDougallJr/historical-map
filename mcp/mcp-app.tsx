import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
import { MapView, type MapViewHandle } from "../app/map/components/MapView";
import { Snippet } from "../app/map/search/Snippet";
import type { McpFocusTarget } from "./focus-types";
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

// Comfortable card size when the host only offers a growth ceiling rather
// than an exact box — see the maxHeight/maxWidth note in onhostcontextchanged.
const MAX_APP_HEIGHT = 520;
const MAX_APP_WIDTH = 800;

interface McpAppParams {
  locations?: HistoricalLocation[];
  filterYear?: number;
  locationId?: string;
  /** show_map's `focus`, resolved by the server (mcp/register.ts). */
  focus?: McpFocusTarget | null;
}

/**
 * The inline map plus show_map's focus: the same imperative actions /map's
 * search bar drives MapView with. Documents and passages get their text and
 * page in a small overlay — never the original file, whose presigned URL is
 * an origin this sandbox's CSP blocks.
 */
function McpMap({
  locations,
  focus,
}: {
  locations: HistoricalLocation[];
  focus: McpFocusTarget | null;
}): JSX.Element {
  const mapRef = useRef<MapViewHandle>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    switch (focus.kind) {
      case "event":
        map.showEvent(focus);
        break;
      case "location":
        map.showLocation(focus);
        break;
      default:
        map.focusLocations(focus.locationIds, focus.coordinates, {
          path: focus.path,
        });
    }
  }, [focus, locations]);

  const passages = focus && "passages" in focus ? (focus.passages ?? []) : [];
  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <MapView
        ref={mapRef}
        locations={locations}
        initialEventLayers={INLINE_LAYERS}
        showNav={false}
      />
      {focus && "passages" in focus && (
        <aside
          data-testid="mcp-focus-panel"
          className="absolute left-3 top-3 z-30 max-h-[70%] w-72 overflow-y-auto rounded-lg bg-white/95 p-3 text-sm shadow-xl"
        >
          <h2 className="mb-2 font-semibold text-slate-900">{focus.title}</h2>
          {passages.length === 0 && (
            <p className="text-slate-500">
              No passages to show for this document.
            </p>
          )}
          <ol className="space-y-2">
            {passages.map((p, i) => (
              <li
                key={i}
                data-testid="mcp-focus-passage"
                data-focused={p.focused ? "true" : undefined}
                className={`rounded border p-2 ${p.focused ? "border-amber-400 bg-amber-50" : "border-slate-200"}`}
              >
                <p className="text-slate-700">
                  <Snippet text={p.snippet} />
                </p>
                <p className="mt-1 text-xs text-slate-500">{p.anchor}</p>
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}

async function main() {
  const rootEl = document.getElementById("root");
  if (!rootEl) return;

  const root = createRoot(rootEl);

  const render = (
    locations: HistoricalLocation[],
    focus: McpFocusTarget | null = null,
  ) =>
    root.render(
      <StrictMode>
        <McpMap locations={locations} focus={focus} />
      </StrictMode>,
    );

  // Render immediately with empty data to avoid a blank iframe
  render([]);

  if (!isFramed) return;

  const mcpApp = new App({ name: "historical-map", version: "1.0.0" });

  // All handlers must be registered BEFORE connect()
  mcpApp.ontoolresult = (result) => {
    const params = (result.structuredContent as McpAppParams | null) ?? {};
    render(params.locations ?? [], params.focus ?? null);
  };

  mcpApp.onhostcontextchanged = (ctx) => {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.safeAreaInsets) {
      const { top, right, bottom, left } = ctx.safeAreaInsets;
      document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    }
    // OL needs a container with a real pixel size. html/body/#root are
    // height:100%, which resolves against the iframe's own box — but with
    // autoResize on, the host sizes that box from *our* reported content
    // height, and our content has no intrinsic height of its own (it's
    // 100% of the iframe too). That's a 0/0 fixed point: report 0, get
    // sized to 0, measure 0 again. containerDimensions breaks the loop by
    // telling us the size the host actually gave the iframe.
    //
    // `height`/`width` are an exact box the host already allocated — safe to
    // fill 1:1. `maxHeight`/`maxWidth` are only a ceiling autoResize is
    // allowed to grow into, which can be much taller than what's actually
    // visible on-screen without scrolling. Filling the whole ceiling made the
    // map report that height back via autoResize, the host obliged, and only
    // the unscrolled top sliver was visible — the fixed-center view (Utah)
    // sits mid-box, so that sliver reads as somewhere north of it. Clamp to a
    // comfortable constant instead so the whole map fits on-screen.
    const dims = ctx.containerDimensions;
    if (dims) {
      const height =
        "height" in dims
          ? dims.height
          : dims.maxHeight
            ? Math.min(MAX_APP_HEIGHT, dims.maxHeight)
            : undefined;
      const width =
        "width" in dims
          ? dims.width
          : dims.maxWidth
            ? Math.min(MAX_APP_WIDTH, dims.maxWidth)
            : undefined;
      if (height) document.documentElement.style.height = `${height}px`;
      if (width) document.documentElement.style.width = `${width}px`;
    }
  };

  mcpApp.onteardown = async () => ({});

  await mcpApp.connect(); // defaults to PostMessageTransport(window.parent)
}

main().catch(console.error);
