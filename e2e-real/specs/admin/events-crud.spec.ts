import { test, expect } from "@playwright/test";
import { FX_LOCATIONS } from "../../fixtures/seed-data";

// Locations-crud.spec.ts covers add/edit/delete and the title/date/
// description fields; this covers the remaining EventForm fields —
// date precision, tags, and image URL — on a different fixture location so
// the two specs don't contend over the same rows.
const loc = FX_LOCATIONS[1]!;

test.describe("admin: event fields (real backend)", () => {
  test("date precision, tags, and image URL persist", async ({ page }) => {
    await page.goto(`/locations/${encodeURIComponent(loc.id)}`);

    await page.getByTestId("add-event-button").click();
    await page.getByTestId("event-form-title").fill("Precision Fields Event");
    await page.getByTestId("event-form-date").fill("1912-01-01");
    await page
      .getByTestId("event-form-date-precision")
      .selectOption("decade");
    await page
      .getByTestId("event-form-description")
      .fill("Exercises date precision, tags, and image URL.");
    await page.getByTestId("event-form-tags").fill("railway, centennial");
    await page
      .getByTestId("event-form-image-url")
      .fill("https://example.com/fixture.jpg");
    await page.getByTestId("event-form-submit").click();

    const row = page.locator('[data-testid^="event-row-"]', {
      hasText: "Precision Fields Event",
    });
    await expect(row).toBeVisible();
    await expect(row).toContainText("decade");

    const eventId = (await row.getAttribute("data-testid"))!.replace(
      "event-row-",
      "",
    );
    await page.getByTestId(`event-edit-button-${eventId}`).click();
    await expect(page.getByTestId("event-form-tags")).toHaveValue(
      "railway, centennial",
    );
    await expect(page.getByTestId("event-form-image-url")).toHaveValue(
      "https://example.com/fixture.jpg",
    );

    // Clean up.
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("event-form-title").fill("Precision Fields Event");
    await page.getByTestId("event-form-submit").click();
    await page.getByTestId(`event-delete-button-${eventId}`).click();
    await expect(page.locator(`[data-testid="event-row-${eventId}"]`)).toBeHidden();
  });
});
