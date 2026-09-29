import { test, expect, type Page } from "@playwright/test";
import {
  mockMapData,
  waitForMapReady,
  findHoverPixel,
  TEST_LOCATION,
} from "./fixtures";
import { POPUP_PIN_GAP } from "../app/map/utils/popup-placement";

// The desktop popup card is `hidden md:block` (see MapPopup.tsx) — a mobile
// viewport renders the bottom-sheet variant instead, which these tests don't
// cover. 1280x800 also keeps the center pin well clear of every edge, so the
// default "above, centered" placement applies with no left/right/top flip —
// see e2e/popup-placement.spec.ts for that logic in isolation.
test.use({ viewport: { width: 1280, height: 800 } });

/**
 * The test pin's exact map-coordinate pixel — see fixtures.ts for why this
 * is deterministic. This is what the popup is actually anchored to
 * (`openPopup` calls `overlay.setPosition(fromLonLat(full.coordinates))`),
 * so position assertions compare against this, not against wherever the
 * mouse happened to be when it hit-tested the pin.
 */
function pinAnchor(page: Page): { x: number; y: number } {
  const vp = page.viewportSize();
  if (!vp) throw new Error("no viewport");
  return { x: vp.width / 2, y: vp.height / 2 };
}

test.beforeEach(async ({ page }) => {
  await mockMapData(page);
  await page.goto("/map");
  await waitForMapReady(page);
});

test("hovering a pin opens a popup anchored directly above it", async ({
  page,
}) => {
  const anchor = pinAnchor(page);
  const popup = page.getByTestId("map-popup");

  await expect(popup).toBeHidden();

  const hoverPt = await findHoverPixel(page, anchor);
  await page.mouse.move(hoverPt.x, hoverPt.y, { steps: 5 });

  await expect(popup).toBeVisible();
  await expect(popup.locator("h3")).toHaveText(TEST_LOCATION.name);

  // The regression this guards: the popup must sit directly above the pin —
  // horizontally centered on its exact coordinate, its bottom edge exactly
  // POPUP_PIN_GAP above it — not somewhere else on the map.
  const box = await popup.boundingBox();
  if (!box) throw new Error("popup has no box");

  const popupCenterX = box.x + box.width / 2;
  expect(Math.abs(popupCenterX - anchor.x)).toBeLessThanOrEqual(2);

  const popupBottom = box.y + box.height;
  const expectedBottom = anchor.y - POPUP_PIN_GAP;
  expect(Math.abs(popupBottom - expectedBottom)).toBeLessThanOrEqual(2);
});

test("moving away from the pin closes the popup after a short delay", async ({
  page,
}) => {
  const anchor = pinAnchor(page);
  const popup = page.getByTestId("map-popup");

  const hoverPt = await findHoverPixel(page, anchor);
  await page.mouse.move(hoverPt.x, hoverPt.y, { steps: 5 });
  await expect(popup).toBeVisible();

  // Top-left corner: empty map, nowhere near the pin.
  await page.mouse.move(10, 10, { steps: 5 });

  // toBeHidden polls, so this naturally covers the 300ms hover-close debounce
  // (see MapView.tsx's pointermove handler) without a manual sleep.
  await expect(popup).toBeHidden();
});

test("hovering into the popup itself keeps it open", async ({ page }) => {
  const anchor = pinAnchor(page);
  const popup = page.getByTestId("map-popup");

  const hoverPt = await findHoverPixel(page, anchor);
  await page.mouse.move(hoverPt.x, hoverPt.y, { steps: 5 });
  await expect(popup).toBeVisible();

  const box = await popup.boundingBox();
  if (!box) throw new Error("popup has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 5,
  });

  // Give the debounce window time to have fired if it were going to.
  await page.waitForTimeout(500);
  await expect(popup).toBeVisible();
});

test("clicking a pin pins the popup so it survives the pointer leaving", async ({
  page,
}) => {
  const anchor = pinAnchor(page);
  const popup = page.getByTestId("map-popup");

  const hoverPt = await findHoverPixel(page, anchor);
  await page.mouse.click(hoverPt.x, hoverPt.y);
  await expect(popup).toBeVisible();

  await page.mouse.move(10, 10, { steps: 5 });
  await page.waitForTimeout(500);
  await expect(popup).toBeVisible();

  // Clicking empty map (no feature under the pointer) unpins and closes it.
  await page.mouse.click(10, 10);
  await expect(popup).toBeHidden();
});
