import { test, expect, type Page } from "@playwright/test";
import { waitForMapReady, findHoverPixel } from "../../../e2e/fixtures";
import { FX_LOCATIONS } from "../../fixtures/seed-data";

// fx-loc-1 sits at MapView's hardcoded default view center (see
// e2e-real/fixtures/seed-data.ts), same trick as the mocked suite's
// hover.spec.ts — matches e2e/hover.spec.ts's viewport choice too.
test.use({ viewport: { width: 1280, height: 800 } });

const loc1 = FX_LOCATIONS[0]!;

function pinAnchor(page: Page): { x: number; y: number } {
  const vp = page.viewportSize();
  if (!vp) throw new Error("no viewport");
  return { x: vp.width / 2, y: vp.height / 2 };
}

test.describe("pins and popup (real backend)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/map");
    await waitForMapReady(page);
  });

  test("pin at fx-loc-1 renders and hover opens a popup with the right content", async ({
    page,
  }) => {
    const anchor = pinAnchor(page);
    const hoverPixel = await findHoverPixel(page, anchor);

    await page.mouse.move(hoverPixel.x, hoverPixel.y, { steps: 5 });

    const popup = page.getByTestId("map-popup");
    await expect(popup).toBeVisible();
    await expect(popup.locator("h3")).toHaveText(loc1.name);
    await expect(popup).toContainText(loc1.events[0]!.title);
  });

  test("click pins the popup open, click-away closes it", async ({ page }) => {
    const anchor = pinAnchor(page);
    const hoverPixel = await findHoverPixel(page, anchor);
    const popup = page.getByTestId("map-popup");

    await page.mouse.click(hoverPixel.x, hoverPixel.y);
    await expect(popup).toBeVisible();

    // Moving away should not close a pinned popup.
    await page.mouse.move(10, 10, { steps: 5 });
    await page.waitForTimeout(500);
    await expect(popup).toBeVisible();

    // Clicking empty map (no feature under the pointer) unpins and closes it.
    await page.mouse.click(10, 10);
    await expect(popup).toBeHidden();
  });
});
