import { test, expect } from "@playwright/test";
import path from "node:path";

// /api/parse (regex/structured parsers) and /api/parse-pdf (unpdf) do not
// call an LLM and are deterministic — see CLAUDE.md's "Import feature"
// section — so this is a real end-to-end run against those routes, not a
// mock. The import flow itself writes to localStorage, not Postgres (see
// app/map/utils/storage.ts), so this spec doesn't touch the fixture DB.
const SAMPLE_TEXT =
  "On July 4, 1876, the town celebrated its centennial with a parade. " +
  "In 1890, a new railway line reached the valley, changing everything.";

test.describe("import flow (real backend)", () => {
  test("paste text, parse, edit, and save to a new location", async ({
    page,
  }) => {
    await page.goto("/map/import");

    await page.locator("#document-input").fill(SAMPLE_TEXT);
    await page.getByRole("button", { name: "Parse Document" }).click();

    await expect(page.getByText(/Add \d+ Selected Event/)).toBeVisible({
      timeout: 15_000,
    });

    // Create a target location via the "+ Create new location" flow.
    await page.locator("#location-select").selectOption("__new__");
    await page.locator("#new-location-name").fill("Import Flow Test Location");
    await page.locator("#new-location-coords").fill("41.6181, -112.5477");
    await page.getByRole("button", { name: "Create Location" }).click();

    await expect(
      page.locator("#location-select"),
    ).toContainText("Import Flow Test Location");

    await page.getByRole("button", { name: /Add \d+ Selected Event/ }).click();

    await expect(page).toHaveURL(/\/map\?t=/);

    // The new location is now in localStorage, reachable from /map.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem("historical-events"),
    );
    expect(stored).toContain("Import Flow Test Location");
  });

  test("upload a PDF, extracted text appears in the document field", async ({
    page,
  }) => {
    await page.goto("/map/import");

    await page.getByRole("button", { name: "Upload File" }).click();
    const fileInput = page.locator("#file-upload");
    await fileInput.setInputFiles(
      path.join(__dirname, "..", "..", "fixtures", "sample.pdf"),
    );

    await expect(page.getByText(/characters extracted/)).toBeVisible({
      timeout: 15_000,
    });
  });
});
