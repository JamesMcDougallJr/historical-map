import { test, expect, type Page } from "@playwright/test";
import { waitForMapReady } from "../../../e2e/fixtures";
import { dragReorderOverlay } from "../../fixtures/dnd";
import { FX_SOURCES } from "../../fixtures/seed-data";

// `window.__olMap` is already typed (loosely, as `DebugMap`) by e2e/fixtures.ts
// — declared globally there, so it must not be redeclared with a conflicting
// shape here. Cast through `unknown` instead of widening that declaration.
async function eventLayerIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const map = window.__olMap as unknown as {
      getLayers(): { getArray(): Array<{ get(key: string): unknown }> };
    };
    return (map?.getLayers().getArray() ?? [])
      .filter((l) => l.get("layerId") === "events")
      .map((l) => l.get("eventLayerId") as string);
  });
}

test.describe("layer control (real backend)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/map");
    await waitForMapReady(page);
    await page.getByLabel("Toggle layer controls").click();
  });

  test("per-source checkbox toggles that source's layer off and on", async ({
    page,
  }) => {
    const sourceId = FX_SOURCES[1]!.id;
    await expect.poll(() => eventLayerIds(page)).toContain(sourceId);

    await page.getByTestId(`event-layer-checkbox-${sourceId}`).uncheck();
    await expect.poll(() => eventLayerIds(page)).not.toContain(sourceId);

    await page.getByTestId(`event-layer-checkbox-${sourceId}`).check();
    await expect.poll(() => eventLayerIds(page)).toContain(sourceId);
  });

  test("add and remove a custom overlay", async ({ page }) => {
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByPlaceholder("e.g., 1890 Railroad Map").fill("Fixture Overlay");
    await page.getByRole("combobox").selectOption("custom");
    await page
      .getByPlaceholder("https://tiles.example.com/{z}/{x}/{y}.png")
      .fill("https://tiles.example.com/{z}/{x}/{y}.png");
    await page.getByRole("button", { name: "Add Layer" }).click();

    const row = page.locator('[data-testid^="overlay-row-"]', {
      hasText: "Fixture Overlay",
    });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Remove Fixture Overlay" }).click();
    await expect(row).toBeHidden();
  });

  test("opacity slider changes the displayed percentage", async ({ page }) => {
    const row = page.locator('[data-testid^="overlay-row-"]').first();
    const id = (await row.getAttribute("data-testid"))!.replace("overlay-row-", "");
    const slider = page.getByTestId(`overlay-opacity-${id}`);

    await slider.fill("40");
    await expect(row).toContainText("40%");
  });

  test("drag-reordering overlays updates zIndex order", async ({ page }) => {
    const rows = page.locator('[data-testid^="overlay-row-"]');
    const firstId = (await rows.nth(0).getAttribute("data-testid"))!.replace(
      "overlay-row-",
      "",
    );
    const secondId = (await rows.nth(1).getAttribute("data-testid"))!.replace(
      "overlay-row-",
      "",
    );

    await dragReorderOverlay(page, firstId, secondId);

    // After reordering, the previously-second row now renders first.
    await expect(rows.nth(0)).toHaveAttribute("data-testid", `overlay-row-${secondId}`);
  });
});
