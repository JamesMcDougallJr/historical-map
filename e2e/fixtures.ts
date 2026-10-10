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
 * Waits for OL to have measured a non-zero size, for the mocked pin GeoJSON
 * to have loaded into the "events" layer's source — size being ready doesn't
 * mean the fetch it kicked off has resolved yet — and for the map to have
 * *settled*.
 *
 * Settling matters: page.tsx loads locations after mount, and MapView
 * rebuilds the whole map when they arrive, briefly leaving a fresh events
 * layer with an empty source. A check that passes on the first map can be
 * stale a few ms later, which is what made the hover specs flaky (measured:
 * features 1 → 0 → 1 across ~150ms right after the old check passed). So
 * this also waits until the centre pin hit-tests on the *same* map instance
 * twice, 300ms apart.
 */
export async function waitForMapReady(page: Page): Promise<void> {
  await waitForMapLoaded(page);
  for (let attempt = 0; attempt < 20; attempt++) {
    const settled = await page.evaluate(async () => {
      const w = window as unknown as {
        __olMap?: DebugMap;
        innerWidth: number;
        innerHeight: number;
      };
      const hitsCentre = (map: DebugMap) => {
        map.renderSync();
        const size = map.getSize();
        if (!size) return false;
        for (let d = 0; d >= -30; d -= 2) {
          if (
            map.forEachFeatureAtPixel(
              [size[0] / 2, size[1] / 2 + d],
              (f) => f,
              {
                layerFilter: (l) => l.get("layerId") === "events",
              },
            )
          )
            return true;
        }
        return false;
      };
      const first = w.__olMap;
      if (!first || !hitsCentre(first)) return false;
      await new Promise((r) => setTimeout(r, 300));
      return w.__olMap === first && hitsCentre(first);
    });
    if (settled) return;
    await waitForMapLoaded(page);
  }
  throw new Error("map never settled with a hit-testable centre pin");
}

async function waitForMapLoaded(page: Page): Promise<void> {
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

// ── Search fixtures (plans/21-search-ui.md) ─────────────────────────────────

/**
 * A second pin, away from the default centre, so "the map flew to the hit"
 * is observable — a hit at TEST_LOCATION would already be centred.
 */
export const FAR_LOCATION = {
  id: "test-location-far",
  name: "Far Test Location",
  coordinates: [PIN_LON + 1.5, PIN_LAT + 0.8] as [number, number],
  events: [
    {
      id: "far-event-1",
      title: "Far Away Event",
      description: "An event at the far pin.",
      date: "1857-01-01",
      datePrecision: "year" as const,
      sourceId: "utah-historical",
    },
  ],
};

type AnyLocation = typeof TEST_LOCATION | typeof FAR_LOCATION;

/** mockMapData for several pins, plus the per-location detail endpoint. */
export async function mockMapDataMany(
  page: Page,
  locations: AnyLocation[] = [TEST_LOCATION, FAR_LOCATION],
): Promise<void> {
  await page.route("**/api/sources", (route) =>
    route.fulfill({ json: { sources: [] } }),
  );
  await page.route("**/api/data/groups", (route) =>
    route.fulfill({ json: { groups: [] } }),
  );
  await page.route("**/api/data/locations", (route) =>
    route.fulfill({
      json: { locations, lastUpdated: new Date().toISOString() },
    }),
  );
  await page.route("**/api/data/locations/*", (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop()!,
    );
    const location = locations.find((l) => l.id === id);
    return location
      ? route.fulfill({ json: { location } })
      : route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.route("**/api/sources/*/features", (route) =>
    route.fulfill({
      json: {
        type: "FeatureCollection",
        features: locations.map((location) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: location.coordinates },
          properties: {
            location_id: location.id,
            source_id: "utah-historical",
            name: location.name,
            min_year: Math.min(
              ...location.events.map((e) => Number(e.date.slice(0, 4))),
            ),
            max_year: Math.max(
              ...location.events.map((e) => Number(e.date.slice(0, 4))),
            ),
            event_count: location.events.length,
            events: JSON.stringify(location.events),
          },
        })),
      },
    }),
  );
}

const M0 = "\u0002";
const M1 = "\u0003";

export const DOC_ID = "00000000-0000-4000-8000-00000000d0c1";
export const DOC_EMPTY_ID = "00000000-0000-4000-8000-00000000d0c2";

/** One canned hit of each of the five kinds. */
export const SEARCH_HITS = {
  event: {
    kind: "event",
    id: "far-event-1",
    title: "Far Away Event",
    snippet: `An event at the ${M0}far${M1} pin.`,
    score: 1,
    matchedOn: ["title", "body"],
    date: "1857-01-01",
    datePrecision: "year",
    locationId: FAR_LOCATION.id,
    locationName: FAR_LOCATION.name,
    coordinates: FAR_LOCATION.coordinates,
    sourceId: "utah-historical",
  },
  sequence: {
    kind: "sequence",
    id: "test-group-1",
    title: "Test Sequence",
    snippet: `A ${M0}sequence${M1} of two events.`,
    score: 1,
    matchedOn: ["title"],
    memberCount: 2,
    membersInRange: 2,
    dateRange: ["1857-01-01", "1900-01-01"],
    bbox: [PIN_LON, PIN_LAT, PIN_LON + 1.5, PIN_LAT + 0.8],
  },
  location: {
    kind: "location",
    id: FAR_LOCATION.id,
    title: FAR_LOCATION.name,
    snippet: `${M0}Far${M1} Test Location`,
    score: 1,
    matchedOn: ["place"],
    coordinates: FAR_LOCATION.coordinates,
    eventCount: 1,
    dateRange: ["1857-01-01", "1857-01-01"],
  },
  document: {
    kind: "document",
    id: DOC_ID,
    title: "Annals of the Test Basin",
    snippet: `The ${M0}far${M1} reaches of the basin.`,
    score: 1,
    matchedOn: ["body"],
    sourceId: "utah-historical",
    bestAnchor: "p.43¶2",
    matchCount: 12,
    eventCount: 1,
  },
  passage: {
    kind: "passage",
    id: `${DOC_ID}:7`,
    title: "Annals of the Test Basin",
    documentId: DOC_ID,
    documentTitle: "Annals of the Test Basin",
    sourceId: "utah-historical",
    anchor: "p.43¶2",
    snippet: `…they travelled ${M0}far${M1} to the north…`,
    score: 1,
    eventIds: ["far-event-1"],
    matchedOn: ["body"],
  },
} as const;

export type MockSearchResponse = Record<string, unknown> & { hits: unknown[] };

export function searchResponse(
  hits: unknown[],
  extra: Partial<Record<string, unknown>> = {},
): MockSearchResponse {
  return {
    hits,
    modes: { lexical: true, semantic: false, documents: true },
    parsed: { text: "far" },
    timing: { ms: 12, unfiltered: true },
    ...extra,
  };
}

export interface MockSearchCall {
  params: URLSearchParams;
  path: string;
}

/**
 * Routes `/api/search` and `/api/search/matches` to `handler`, which gets the
 * parsed params — so specs can assert on what was *sent* (timeline, prefix,
 * mode) as well as control what comes back. `delayMs` (per call) is for the
 * slow-search and abort specs. Returns the recorded calls.
 */
export async function mockSearch(
  page: Page,
  handler: (
    params: URLSearchParams,
    index: number,
  ) => MockSearchResponse | { response: MockSearchResponse; delayMs: number },
  opts: {
    matches?: (params: URLSearchParams) => {
      locationIds: string[];
      truncated: boolean;
    };
  } = {},
): Promise<{ calls: MockSearchCall[]; matchCalls: MockSearchCall[] }> {
  const calls: MockSearchCall[] = [];
  const matchCalls: MockSearchCall[] = [];
  await page.route("**/api/search/matches?**", async (route) => {
    const url = new URL(route.request().url());
    matchCalls.push({ params: url.searchParams, path: url.pathname });
    const body = opts.matches?.(url.searchParams) ?? {
      locationIds: [FAR_LOCATION.id],
      truncated: false,
    };
    await route.fulfill({ json: body }).catch(() => {});
  });
  await page.route("**/api/search?**", async (route) => {
    const url = new URL(route.request().url());
    const index = calls.length;
    calls.push({ params: url.searchParams, path: url.pathname });
    const out = handler(url.searchParams, index);
    const { response, delayMs } =
      "delayMs" in out && "response" in out
        ? (out as { response: MockSearchResponse; delayMs: number })
        : { response: out as MockSearchResponse, delayMs: 0 };
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    // The page may have aborted it meanwhile; that's the point of some specs.
    await route.fulfill({ json: response }).catch(() => {});
  });
  return { calls, matchCalls };
}

export const DOCUMENT_PANEL = {
  id: DOC_ID,
  title: "Annals of the Test Basin",
  sourceId: "utah-historical",
  sourceName: "Utah Historical Events",
  extractedAt: "2026-10-01T00:00:00.000Z",
  passages: Array.from({ length: 12 }, (_, i) => ({
    seq: i + 1,
    anchor: `p.${40 + Math.floor(i / 3)}¶${(i % 3) + 1}`,
    snippet: `Paragraph ${i + 1} mentions how ${M0}far${M1} they went.`,
    eventIds: i + 1 === 7 ? ["far-event-1"] : [],
  })),
  events: [
    {
      id: "far-event-1",
      title: "Far Away Event",
      date: "1857-01-01",
      datePrecision: "year",
      anchor: "p.43",
      locationId: FAR_LOCATION.id,
    },
  ],
};

/** Serves the document-panel endpoint and the "show all on map" lookup. */
export async function mockDocument(page: Page): Promise<void> {
  await page.route("**/api/documents/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    if (id === DOC_ID) return route.fulfill({ json: DOCUMENT_PANEL });
    if (id === DOC_EMPTY_ID) {
      return route.fulfill({
        json: {
          ...DOCUMENT_PANEL,
          id: DOC_EMPTY_ID,
          title: "Empty Ledger",
          passages: [],
          events: [],
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.route("**/api/documents/*?**", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop();
    if (id === DOC_ID) return route.fulfill({ json: DOCUMENT_PANEL });
    return route.fulfill({
      json: {
        ...DOCUMENT_PANEL,
        id,
        title: "Empty Ledger",
        passages: [],
        events: [],
      },
    });
  });
  await page.route("**/api/data/search?**", (route) =>
    route.fulfill({
      json: {
        results: [{ location: FAR_LOCATION, event: FAR_LOCATION.events[0] }],
      },
    }),
  );
}

/** The live map's view centre in lon/lat (dev handle). */
export async function viewCenter(page: Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const map = (
      window as unknown as {
        __olMap: { getView(): { getCenter(): number[] } };
      }
    ).__olMap;
    const [x, y] = map.getView().getCenter();
    // EPSG:3857 → lon/lat, inline (no OL import in the page context).
    const lon = (x! / 6378137) * (180 / Math.PI);
    const lat =
      (Math.atan(Math.exp(y! / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI);
    return [lon, lat] as [number, number];
  });
}
