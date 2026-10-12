import { test, expect } from "@playwright/test";
import { PIN_LAT, PIN_LON } from "../../../e2e/fixtures";
import { deleteLocation, upsertLocation } from "../../../lib/postgres-storage";
import { waitForRealMapReady } from "../../fixtures/map-ready";

test.use({ viewport: { width: 1280, height: 800 } });

const ID = "fx-stale-loc";
const COORDS: [number, number] = [PIN_LON + 0.3, PIN_LAT];

test.describe("stale browser storage (real backend)", () => {
  test.afterEach(async () => {
    await deleteLocation(ID);
  });

  test("a pin's card shows the server's events, not an old localStorage snapshot", async ({
    page,
  }) => {
    // localStorage is seeded once and, without an API key, never refreshed — a browser
    // can hold weeks-old data. A pin sharing an id with a stale entry used to show
    // those old events instead of what the database says.
    await upsertLocation({
      id: ID,
      name: "Stale Test Place",
      coordinates: COORDS,
      events: [
        {
          id: "fx-stale-event",
          title: "Current Server Event",
          description: "What the database holds today.",
          date: "1850-01-01",
          datePrecision: "year",
          sourceId: "fx-source-1",
        },
      ],
    });

    await page.addInitScript(
      ({ id, coords }) => {
        localStorage.setItem(
          "historical-events",
          JSON.stringify({
            version: "1.0.0",
            lastUpdated: "2020-01-01T00:00:00.000Z",
            locations: [
              {
                id,
                name: "Stale Test Place",
                coordinates: coords,
                events: [
                  {
                    id: "stale-old-event",
                    title: "Outdated Local Event",
                    description: "From a snapshot that no longer matches.",
                    date: "1700-01-01",
                  },
                ],
              },
            ],
          }),
        );
      },
      { id: ID, coords: COORDS },
    );

    await page.goto("/map");
    await waitForRealMapReady(page);

    // A hit-testable pixel on the fixture's pin, once its tile has arrived.
    const findPin = () =>
      page.evaluate(
        ({ lon, lat }) => {
          const map = window.__olMap;
          if (!map) return null;
          const R = 20037508.34;
          const y =
            (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180) / 180) * R;
          const [px, py] = map.getPixelFromCoordinate([(lon * R) / 180, y]) as number[];
          map.renderSync();
          for (let dy = -4; dy >= -30; dy -= 2) {
            const hit = map.forEachFeatureAtPixel([px!, py! + dy], (f) => f, {
              layerFilter: (l) => l.get("layerId") === "events",
            });
            if (hit) return { x: px!, y: py! + dy };
          }
          return null;
        },
        { lon: COORDS[0], lat: COORDS[1] },
      );

    await expect.poll(findPin, { timeout: 15_000 }).not.toBeNull();
    const pt = (await findPin())!;
    await page.mouse.move(pt.x, pt.y, { steps: 5 });

    const popup = page.getByTestId("map-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Current Server Event");
    await expect(popup).not.toContainText("Outdated Local Event");
  });
});
