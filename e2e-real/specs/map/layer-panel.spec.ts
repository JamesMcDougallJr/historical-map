import { test, expect } from "@playwright/test";
import { deleteEventGroup, upsertEventGroup } from "../../../lib/postgres-storage";
import { waitForRealMapReady } from "../../fixtures/map-ready";

// The layer manager and the toolbar chip, against real tiles. Each of these was
// visibly broken on the live map (verified in the browser before fixing).
const EMPTY_GROUP_ID = "fx-empty-sequence";

test.describe("layer manager (real backend)", () => {
  test.afterEach(async () => {
    await deleteEventGroup(EMPTY_GROUP_ID);
  });

  test("the panel stays inside a short viewport and scrolls to its last section", async ({
    page,
  }) => {
    // The panel is anchored bottom-right and grows upward. With no max-height it
    // overflowed the top of the viewport and Event Sources / Sequences were clipped
    // and unreachable.
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto("/map");
    await waitForRealMapReady(page);

    await page.getByRole("button", { name: "Toggle layer controls" }).click();
    const panel = page.getByTestId("layer-panel");
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box, "panel has a box").not.toBeNull();
    expect(box!.y, "panel top must not leave the viewport").toBeGreaterThanOrEqual(0);

    const scrolls = await panel.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls, "its content is taller than the panel, so it must scroll").toBe(true);

    // The last thing in the panel must be reachable by scrolling.
    const last = panel.getByText("Find maps at");
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    // ...and so must the first.
    const first = panel.getByRole("heading", { name: "Event Sources" });
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport();
  });

  test("a sequence with no events is listed but cannot be selected", async ({ page }) => {
    await upsertEventGroup({ id: EMPTY_GROUP_ID, title: "Empty Sequence" });

    await page.goto("/map");
    await waitForRealMapReady(page);
    await page.getByRole("button", { name: "Toggle layer controls" }).click();

    const row = page.getByTestId(`event-group-radio-${EMPTY_GROUP_ID}`);
    await expect(row).toContainText("Empty Sequence");
    await expect(row).toContainText("no events");
    await expect(row.getByRole("radio")).toBeDisabled();
  });

  test("the locations/events chip reflects the data for tile layers instead of 0", async ({
    page,
  }) => {
    // MVT sources stream pins per tile and have no feature list to count, so the chip
    // always read "0 locations, 0 events" next to a map full of pins (and the score
    // badge's denominator was 0 too). Totals now come from /api/sources.
    await page.goto("/map");
    await waitForRealMapReady(page);

    const chip = page.getByTestId("pin-stats");
    await expect(chip).not.toHaveText(/^0 locations?, 0 events?$/);
    await expect(chip).toHaveText(/^[1-9]\d* locations?, [1-9]\d* events?$/);
  });
});
