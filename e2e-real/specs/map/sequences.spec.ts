import { test, expect } from "@playwright/test";
import { waitForMapReady } from "../../../e2e/fixtures";
import { FX_GROUP } from "../../fixtures/seed-data";

test.describe("sequences (real backend)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/map");
    await waitForMapReady(page);
    await page.getByLabel("Toggle layer controls").click();
  });

  test("selecting a sequence filters the map, deselecting restores it", async ({
    page,
  }) => {
    await expect(page.getByTestId(`event-group-radio-${FX_GROUP.id}`)).toContainText(
      FX_GROUP.title,
    );

    await page.getByTestId(`event-group-radio-${FX_GROUP.id}`).click();
    await expect(
      page.getByTestId(`event-group-radio-${FX_GROUP.id}`).locator("input"),
    ).toBeChecked();

    await page.getByTestId("event-group-radio-none").click();
    await expect(
      page.getByTestId("event-group-radio-none").locator("input"),
    ).toBeChecked();
  });
});
