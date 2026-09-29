import type { Page } from "@playwright/test";

/**
 * Same lon/lat as MapView's hardcoded default view center
 * (`fromLonLat([-111.8881, 40.7606])`, zoom 8). Putting the one test pin
 * exactly there means it always renders at the dead center of the viewport —
 * `(viewportWidth / 2, viewportHeight / 2)` — regardless of window size, with
 * no need to replicate OL's Web Mercator projection math in the test to find
 * it.
 */
export const PIN_LON = -111.8881;
export const PIN_LAT = 40.7606;

export const TEST_LOCATION = {
  id: "test-location-1",
  name: "Test Pin Location",
  coordinates: [PIN_LON, PIN_LAT] as [number, number],
  events: [
    {
      id: "test-event-1",
      title: "First Test Event",
      description: "A test event for hover coverage.",
      date: "1900-01-01",
      datePrecision: "year" as const,
    },
    {
      id: "test-event-2",
      title: "Second Test Event",
      description: "Another test event, a different year.",
      date: "1950-06-15",
    },
  ],
};

/**
 * Routes every fetch MapView/page.tsx makes for map data to a single, fixed
 * location, instead of whatever the local Postgres/Martin/JSON backend
 * happens to hold. Makes hover tests deterministic (one pin, at a known
 * pixel) and independent of `docker compose` or seeded data — the map only
 * ever needs `NEXT_PUBLIC_MARTIN_URL` unset for this to be the *only* layer
 * (see event-layers.ts's `withMartinLayer`), which is the default for
 * `npm run dev` run without it.
 */
export async function mockMapData(
  page: Page,
  location = TEST_LOCATION,
): Promise<void> {
  await page.route("**/api/sources", (route) =>
    route.fulfill({ json: { sources: [] } }),
  );
  await page.route("**/api/data/groups", (route) =>
    route.fulfill({ json: { groups: [] } }),
  );
  await page.route("**/api/data/locations", (route) =>
    route.fulfill({
      json: { locations: [location], lastUpdated: new Date().toISOString() },
    }),
  );
  // Matches the shape app/api/sources/[id]/features/route.ts emits — see its
  // comment about being interchangeable with the Martin MVT source.
  await page.route("**/api/sources/*/features", (route) =>
    route.fulfill({
      json: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: location.coordinates },
            properties: {
              location_id: location.id,
              source_id: "utah-historical",
              name: location.name,
              min_year: 1900,
              max_year: 1950,
              event_count: location.events.length,
              events: JSON.stringify(location.events),
            },
          },
        ],
      },
    }),
  );
}

type DebugMap = {
  getSize(): [number, number] | undefined;
  getLayers(): { getArray(): DebugLayer[] };
  forEachFeatureAtPixel: (
    pixel: [number, number],
    cb: (f: unknown) => unknown,
    opts: { layerFilter: (l: DebugLayer) => boolean },
  ) => unknown;
  renderSync(): void;
};
type DebugLayer = {
  get(key: string): unknown;
  getSource?: () => { getFeatures?: () => unknown[] } | null;
};
declare global {
  interface Window {
    __olMap?: DebugMap;
  }
}

/**
 * Waits for OL to have measured a non-zero size *and* for the mocked pin
 * GeoJSON to have actually loaded into the "events" layer's source — size
 * being ready doesn't mean the fetch it kicked off has resolved yet.
 */
export async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const size = window.__olMap?.getSize();
    return !!size && size[0] > 0 && size[1] > 0;
  });
  await page.waitForFunction(() => {
    const map = window.__olMap;
    if (!map) return false;
    return map
      .getLayers()
      .getArray()
      .some(
        (l) =>
          l.get("layerId") === "events" &&
          (l.getSource?.()?.getFeatures?.()?.length ?? 0) > 0,
      );
  });
}

/**
 * The pin icon is anchored bottom-center (`anchor: [0.5, 1]` in MapView.tsx)
 * to its feature's exact map coordinate, but the SVG's drawn tip sits a few
 * px above that anchor's own pixel — hit-testing *at* the anchor pixel
 * itself misses; a real cursor resting on the visible glyph, a few px above
 * it, hits. Scans upward from the anchor to find a pixel that actually
 * hit-tests, rather than hardcoding an offset that would silently go stale
 * if the icon's SVG changes.
 *
 * Popup *position* assertions should still use the exact anchor pixel
 * (`pinPixel` in hover.spec.ts) — that's what `openPopup` anchors the
 * overlay to, regardless of where within the icon the pointer actually was.
 */
export async function findHoverPixel(
  page: Page,
  anchor: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const dy = await page.evaluate(({ x, y }) => {
    const map = window.__olMap;
    if (!map) return null;
    map.renderSync();
    for (let d = 0; d >= -30; d -= 2) {
      const hit = map.forEachFeatureAtPixel([x, y + d], (f) => f, {
        layerFilter: (l) => l.get("layerId") === "events",
      });
      if (hit) return d;
    }
    return null;
  }, anchor);
  if (dy === null) {
    throw new Error(
      `no hit-testable pixel found scanning up from anchor (${anchor.x}, ${anchor.y})`,
    );
  }
  return { x: anchor.x, y: anchor.y + dy };
}
