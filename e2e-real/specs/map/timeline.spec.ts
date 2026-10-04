import { test, expect } from "@playwright/test";
import { waitForRealMapReady } from "../../fixtures/map-ready";

// Timeline filtering for an MVT event layer re-requests Martin tiles with
// from_year/to_year query params (MapView.tsx's mvtQueryString effect) —
// asserting against that request is far less flaky than counting rendered
// tile features.
test.describe("timeline filter (real backend, MVT)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/map");
    await waitForRealMapReady(page);
  });

  test("enabling the timeline and choosing a preset re-requests tiles with a year range", async ({
    page,
  }) => {
    await page.getByTestId("timeline-toggle-button").click();
    await page.getByTestId("timeline-enable-checkbox").check();

    const tileRequest = page.waitForRequest((req) =>
      /\/event_pins\/\d+\/\d+\/\d+/.test(req.url()) &&
      req.url().includes("from_year=") &&
      req.url().includes("to_year="),
    );
    await page.getByTestId("timeline-preset-pre-1850").click();
    const request = await tileRequest;

    const url = new URL(request.url());
    expect(url.searchParams.get("to_year")).toBe("1850");
  });

  test("decade marker buttons move the nearer thumb", async ({ page }) => {
    await page.getByTestId("timeline-toggle-button").click();
    await page.getByTestId("timeline-enable-checkbox").check();

    const tileRequest = page.waitForRequest((req) =>
      /\/event_pins\/\d+\/\d+\/\d+/.test(req.url()) && req.url().includes("from_year="),
    );
    await page.getByTestId("timeline-decade-1900").click();
    await tileRequest;

    // The range display reflects the moved thumb.
    await expect(page.locator("text=1900").first()).toBeVisible();
  });

  test("disabling the timeline removes the year filter from tile requests", async ({
    page,
  }) => {
    await page.getByTestId("timeline-toggle-button").click();
    await page.getByTestId("timeline-enable-checkbox").check();
    await page.getByTestId("timeline-preset-pre-1850").click();

    const unfiltered = page.waitForRequest(
      (req) => /\/event_pins\/\d+\/\d+\/\d+/.test(req.url()) && !req.url().includes("from_year="),
    );
    await page.getByTestId("timeline-enable-checkbox").uncheck();
    await unfiltered;
  });
});
