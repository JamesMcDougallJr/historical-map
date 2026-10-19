import { test, expect } from "@playwright/test";
import { waitForRealMapReady } from "../../fixtures/map-ready";

// Timeline filtering for an MVT event layer re-requests Martin tiles with
// from_year/to_year query params (MapView.tsx's mvtQueryString effect) —
// asserting against that request is far less flaky than counting rendered
// tile features.
//
// The timeline no longer has its own floating toggle button — it's the
// first section inside the layer manager's panel (LayerControl.tsx), so
// every test here opens that panel first via the "Toggle layer controls"
// button, same as layer-panel.spec.ts.
//
// `timeline-enable-checkbox` is interacted with via `dispatchEvent("click")`,
// not `.check()`/`.uncheck()`: it's a `sr-only` input with a styled sibling
// <div> drawn on top as the visible switch (same pattern as LayerControl's
// overlay toggle), and `.check()`/`.uncheck()` correctly refuse to interact
// with an input something else visually covers. `dispatchEvent` fires
// directly on the target DOM node, bypassing hit-testing entirely, while
// still triggering React's onChange normally.
test.describe("timeline filter (real backend, MVT)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/map");
    await waitForRealMapReady(page);
    await page.getByRole("button", { name: "Toggle layer controls" }).click();
  });

  test("enabling the timeline and choosing a preset re-requests tiles with a year range", async ({
    page,
  }) => {
    await page.getByTestId("timeline-enable-checkbox").dispatchEvent("click");

    // Matched on the exact expected value, not just that from_year/to_year
    // are present: enabling the checkbox *also* re-requests tiles, using
    // whatever the default range happens to be — a matcher that only
    // checks presence can resolve on that earlier request instead of the
    // preset click's, a real race observed once in CI (asserted "1850",
    // got the enable-triggered request's own default instead).
    const tileRequest = page.waitForRequest(
      (req) =>
        /\/event_pins\/\d+\/\d+\/\d+/.test(req.url()) &&
        req.url().includes("to_year=1850"),
    );
    await page.getByTestId("timeline-preset-pre-1850").click();
    const request = await tileRequest;

    const url = new URL(request.url());
    expect(url.searchParams.get("to_year")).toBe("1850");
  });

  test("decade marker buttons move the nearer thumb", async ({ page }) => {
    await page.getByTestId("timeline-enable-checkbox").dispatchEvent("click");

    const tileRequest = page.waitForRequest(
      (req) =>
        /\/event_pins\/\d+\/\d+\/\d+/.test(req.url()) &&
        req.url().includes("from_year="),
    );
    await page.getByTestId("timeline-decade-1900").click();
    await tileRequest;

    // The range display reflects the moved thumb.
    await expect(page.locator("text=1900").first()).toBeVisible();
  });

  test("disabling the timeline removes the year filter from tile requests", async ({
    page,
  }) => {
    await page.getByTestId("timeline-enable-checkbox").dispatchEvent("click");
    await page.getByTestId("timeline-preset-pre-1850").click();

    const unfiltered = page.waitForRequest(
      (req) =>
        /\/event_pins\/\d+\/\d+\/\d+/.test(req.url()) &&
        !req.url().includes("from_year="),
    );
    await page.getByTestId("timeline-enable-checkbox").dispatchEvent("click");
    await unfiltered;
  });
});
