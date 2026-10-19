import { test, expect } from "@playwright/test";
import { autoAcceptConfirm, autoDismissConfirm } from "../../fixtures/dialogs";
import { FX_LOCATIONS } from "../../fixtures/seed-data";

const loc1 = FX_LOCATIONS[0]!;
// fx-loc-1 is the pin the map specs hover-test against (it sits at MapView's
// hardcoded default view center) — the drag-reposition test below uses a
// different fixture location instead, so it doesn't move that anchor out
// from under specs that may run after it against the same shared database.
const dragTargetLoc = FX_LOCATIONS[2]!;

declare global {
  interface Window {
    __pinEditorMap?: {
      getPixelFromCoordinate(coord: [number, number]): [number, number] | null;
    };
  }
}

test.describe("admin: locations CRUD (real backend)", () => {
  test("list shows fixtures and links to detail", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId(`location-row-${loc1.id}`)).toContainText(
      loc1.name,
    );
  });

  test("editing the name persists via PATCH", async ({ page }) => {
    await page.goto(`/locations/${encodeURIComponent(loc1.id)}`);
    const input = page.getByTestId("location-name-input");
    await expect(input).toHaveValue(loc1.name);

    await input.fill("Fixture Location One Renamed");
    await page.getByTestId("location-save-name-button").click();

    await page.reload();
    await expect(page.getByTestId("location-name-input")).toHaveValue(
      "Fixture Location One Renamed",
    );

    // Restore so other tests in this shared-DB suite aren't affected.
    await page.getByTestId("location-name-input").fill(loc1.name);
    await page.getByTestId("location-save-name-button").click();
  });

  test("dragging the pin persists new coordinates", async ({ page }) => {
    await page.goto(`/locations/${encodeURIComponent(dragTargetLoc.id)}`);
    await page.waitForFunction(() => !!window.__pinEditorMap);

    const box = await page.locator(".pin-map").boundingBox();
    if (!box) throw new Error("pin map has no box");
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const end = { x: start.x + 40, y: start.y - 20 };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();

    // The displayed coordinates below the editor update once the drag persists.
    await expect(page.locator("main")).not.toContainText(
      `${dragTargetLoc.coordinates[1].toFixed(5)}, ${dragTargetLoc.coordinates[0].toFixed(5)}`,
    );
  });

  test("add, edit, and delete an event — covering both confirm() outcomes", async ({
    page,
  }) => {
    // Unique per run: a fixed title surviving a failed prior attempt's
    // cleanup would leave a stray row behind, and the next attempt's
    // `.filter({ hasText })` locator would then match both.
    const addedTitle = `Admin-Added Event ${Date.now()}`;
    const editedTitle = `Admin-Edited Event ${Date.now()}`;

    await page.goto(`/locations/${encodeURIComponent(loc1.id)}`);

    await page.getByTestId("add-event-button").click();
    await page.getByTestId("event-form-title").fill(addedTitle);
    await page.getByTestId("event-form-date").fill("1905-05-05");
    await page
      .getByTestId("event-form-description")
      .fill("Added via the admin app's event form.");
    await page.getByTestId("event-form-submit").click();
    await expect(page.getByTestId("event-form-submit")).toBeHidden();

    const row = page.locator('[data-testid^="event-row-"]', {
      hasText: addedTitle,
    });
    await expect(row).toBeVisible();
    const eventId = (await row.getAttribute("data-testid"))!.replace(
      "event-row-",
      "",
    );

    // Edit it.
    await page.getByTestId(`event-edit-button-${eventId}`).click();
    await page.getByTestId("event-form-title").fill(editedTitle);
    await page.getByTestId("event-form-submit").click();
    await expect(
      page.locator(`[data-testid="event-row-${eventId}"]`),
    ).toContainText(editedTitle);

    // Delete, cancel path first.
    autoDismissConfirm(page);
    await page.getByTestId(`event-delete-button-${eventId}`).click();
    await expect(page.locator(`[data-testid="event-row-${eventId}"]`)).toBeVisible();

    // Then the accept path, which actually removes it.
    autoAcceptConfirm(page);
    await page.getByTestId(`event-delete-button-${eventId}`).click();
    await expect(page.locator(`[data-testid="event-row-${eventId}"]`)).toBeHidden();
  });
});
