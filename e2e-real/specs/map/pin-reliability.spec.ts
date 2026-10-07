import { test, expect, type Page } from "@playwright/test";
import { PIN_LAT, PIN_LON } from "../../../e2e/fixtures";
import { deleteLocation, upsertLocation } from "../../../lib/postgres-storage";
import { waitForRealMapReady } from "../../fixtures/map-ready";

// Two regressions that made pins unreliable on the live map, both invisible to the
// other specs here because each of those finds a pin by *scanning* for any pixel
// that hits one, which skips both failure modes.
test.use({ viewport: { width: 1280, height: 800 } });

const FRESH_ID = "fx-freshness-loc";
// Far enough east of the default view centre to be a separate pin at zoom 8.
const FRESH_COORDS: [number, number] = [PIN_LON + 0.3, PIN_LAT];

/** Is any pin drawn within a few pixels of this map coordinate? */
async function pinNear(page: Page, [lon, lat]: [number, number]): Promise<boolean> {
  return page.evaluate(
    ({ lon, lat }) => {
      const map = window.__olMap;
      if (!map) return false;
      const R = 20037508.34;
      const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180) / 180) * R;
      const [px, py] = map.getPixelFromCoordinate([(lon * R) / 180, y]) as number[];
      map.renderSync();
      for (let dy = 0; dy >= -34; dy -= 2) {
        const hit = map.forEachFeatureAtPixel([px!, py! + dy], (f) => f, {
          layerFilter: (l) => l.get("layerId") === "events",
        });
        if (hit) return true;
      }
      return false;
    },
    { lon, lat },
  );
}

test.describe("pin reliability (real backend)", () => {
  test.afterEach(async () => {
    await deleteLocation(FRESH_ID);
  });

  test("a pin disappears once its events are gone (no stale tiles)", async ({ page }) => {
    // Martin's tile cache has no invalidation: with it on, a tile requested before a
    // data change is served unchanged afterwards, so deleted events keep a "ghost"
    // pin that opens no card. docker-compose.yml runs Martin with `--cache-size 0`.
    await upsertLocation({
      id: FRESH_ID,
      name: "Freshness Location",
      coordinates: FRESH_COORDS,
      events: [
        {
          id: "fx-freshness-event",
          title: "Freshness Event",
          description: "Exists only for this test.",
          date: "1850-01-01",
          datePrecision: "year",
          sourceId: "fx-source-1",
        },
      ],
    });

    await page.goto("/map");
    await waitForRealMapReady(page);
    await expect.poll(() => pinNear(page, FRESH_COORDS), { timeout: 15_000 }).toBe(true);

    await deleteLocation(FRESH_ID);
    await page.reload();
    await waitForRealMapReady(page);
    // Give tiles time to arrive before concluding the pin is gone.
    await page.waitForTimeout(1500);
    expect(await pinNear(page, FRESH_COORDS)).toBe(false);
  });

  test("hovering the centre of a pin head opens its card", async ({ page }) => {
    // The marker icon draws its centre dot as a hole in the path. OpenLayers
    // hit-detects on the icon's pixels, so the dead centre of the head — where a
    // user aims — hit nothing and no card opened, while the rim worked. The head
    // centre is 20px above the tip (32px icon, centre at 12/24 of its height).
    await page.goto("/map");
    await waitForRealMapReady(page);

    const vp = page.viewportSize()!;
    const tip = { x: vp.width / 2, y: vp.height / 2 };
    const headCentre = { x: tip.x, y: tip.y - 20 };

    const hit = await page.evaluate(({ x, y }) => {
      window.__olMap?.renderSync();
      return !!window.__olMap?.forEachFeatureAtPixel([x, y], (f) => f, {
        layerFilter: (l) => l.get("layerId") === "events",
      });
    }, headCentre);
    expect(hit, "the pin head's centre must be hit-testable").toBe(true);

    await page.mouse.move(headCentre.x, headCentre.y, { steps: 5 });
    await expect(page.getByTestId("map-popup")).toBeVisible();
  });
});
