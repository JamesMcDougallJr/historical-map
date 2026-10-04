import { test, expect } from "@playwright/test";
import { FX_LOCATIONS } from "../../fixtures/seed-data";

// Locations-crud.spec.ts covers add/edit/delete and the title/date/
// description fields; this covers the remaining EventForm fields —
// date precision, tags, and image URL — on a different fixture location so
// the two specs don't contend over the same rows.
const loc = FX_LOCATIONS[1]!;

test.describe("admin: event fields (real backend)", () => {
  test("date precision, tags, and image URL persist", async ({ page }) => {
    // Unique per run, not a fixed title: if a previous CI attempt's cleanup
    // never ran (the exact failure this test once hit), a fixed title would
    // leave a stray same-titled row behind, and the next attempt's
    // `.filter({ hasText })` locator would match both — "strict mode
    // violation: resolved to 2 elements" — on top of whatever the real
    // failure was.
    const title = `Precision Fields Event ${Date.now()}`;

    await page.goto(`/locations/${encodeURIComponent(loc.id)}`);

    await page.getByTestId("add-event-button").click();
    await page.getByTestId("event-form-title").fill(title);
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
    // The form only unmounts once the add round-trip (API call + reload)
    // finishes — wait for that before looking for the resulting row, rather
    // than relying on the row locator's own auto-wait to paper over it.
    await expect(page.getByTestId("event-form-submit")).toBeHidden();

    const row = page.locator('[data-testid^="event-row-"]', {
      hasText: title,
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
    await page.getByTestId("event-form-title").fill(title);
    await page.getByTestId("event-form-submit").click();
    await expect(page.getByTestId("event-form-submit")).toBeHidden();

    await page.getByTestId(`event-delete-button-${eventId}`).click();
    await expect(page.locator(`[data-testid="event-row-${eventId}"]`)).toBeHidden();
  });
});
