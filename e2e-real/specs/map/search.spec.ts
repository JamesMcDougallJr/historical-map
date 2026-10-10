import { test, expect } from "@playwright/test";
import { waitForRealMapReady } from "../../fixtures/map-ready";
import { FX_DOC_1 } from "../../fixtures/search-seed";

// The search bar against the real stack — Postgres, Martin tiles, the real
// /map. Only a few cases: the mocked suite (e2e/search-*.spec.ts) covers the
// UI; these prove the wiring.

const HEADERS = { "x-api-key": "test-api-key" };

test.describe("search bar (real backend)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/map");
    await waitForRealMapReady(page);
  });

  test("type, click an event, get its pinned popup over real tiles", async ({
    page,
  }) => {
    await page.getByTestId("search-input").fill("massacre");
    const row = page
      .locator('[data-testid="search-row"][data-hit="event:fx-ev-massacre"]')
      .first();
    await expect(row).toBeVisible();
    await row.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __olDebug: { pinned: { current: boolean } };
              }
            ).__olDebug.pinned.current,
        ),
      )
      .toBe(true);
    await expect(page.getByTestId("map-popup")).toContainText(
      "Massacre at the Meadows",
    );
  });

  test("with the timeline on, out-of-range events never appear", async ({
    page,
  }) => {
    await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
    await page.getByTestId("timeline-enable-checkbox").check({ force: true });
    await page.getByTestId("timeline-preset-post-1920").click();
    await page.getByTestId("search-input").fill("meadows");
    await expect(page.getByTestId("search-empty")).toBeVisible();
    await expect(page.locator('[data-hit="event:fx-ev-massacre"]')).toHaveCount(
      0,
    );
  });

  test("the highlighted pins are exactly /api/search/matches' locations", async ({
    page,
    request,
  }) => {
    await page.getByTestId("search-input").fill("massacre");
    await expect(page.getByTestId("search-row").first()).toBeVisible();
    const matches = (await (
      await request.get(
        "/api/search/matches?q=massacre&mode=lexical&prefix=1",
        { headers: HEADERS },
      )
    ).json()) as { locationIds: string[] };
    expect(matches.locationIds.length).toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const set = (
            window as unknown as {
              __olDebug: {
                pinStyle: { current: { highlight: Set<string> | null } };
              };
            }
          ).__olDebug.pinStyle.current.highlight;
          return set ? Array.from(set).sort() : null;
        }),
      )
      .toEqual([...matches.locationIds].sort());
  });

  test("a document result opens the panel with its real events", async ({
    page,
  }) => {
    await page.getByTestId("search-input").fill("chronicle");
    const row = page.locator(
      `[data-testid="search-row"][data-hit="document:${FX_DOC_1}"]`,
    );
    await expect(row).toBeVisible();
    await row.click();
    const panel = page.getByTestId("document-panel");
    await expect(panel.getByTestId("document-panel-title")).toHaveText(
      "Annals of the Obsidian Basin",
    );
    await expect(panel.getByTestId("document-panel-event")).toHaveCount(3);
    await expect(panel).toContainText("Fortress Surrenders");
  });
});
