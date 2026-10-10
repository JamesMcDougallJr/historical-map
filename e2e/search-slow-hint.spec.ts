import { test, expect, type Page } from "@playwright/test";
import {
  mockMapDataMany,
  mockSearch,
  mockDocument,
  searchResponse,
  waitForMapReady,
  SEARCH_HITS,
} from "./fixtures";

// The "narrow by time" hint for slow searches (plans/21-search-ui.md).
//
// Real time with margins, not page.clock: faking the page's timers also
// freezes OpenLayers' rendering and the search debounce the specs depend on.
// The threshold is 800ms; requests here take 2.5s, so "visible within 2s"
// and "absent after 1.5s" are both far from the edge.

test.use({ viewport: { width: 1280, height: 800 } });

const SLOW = 2500;

async function open(page: Page, handler: Parameters<typeof mockSearch>[1]) {
  await mockMapDataMany(page);
  await mockDocument(page);
  const mocks = await mockSearch(page, handler);
  await page.goto("/map");
  await waitForMapReady(page);
  return mocks;
}

const hint = (page: Page) => page.getByTestId("search-slow-hint");

test("a slow unfiltered search suggests the timeline while it's still running", async ({
  page,
}) => {
  const { calls } = await open(page, (params) =>
    params.get("from")
      ? {
          response: searchResponse([{ ...SEARCH_HITS.event, title: "FAST" }]),
          delayMs: 50,
        }
      : {
          response: searchResponse([{ ...SEARCH_HITS.event, title: "SLOW" }]),
          delayMs: SLOW,
        },
  );
  await page.getByTestId("search-input").fill("far");
  await page.getByTestId("search-input").press("Enter");

  await expect(hint(page)).toBeVisible({ timeout: 2000 });
  await expect(page.getByTestId("search-spinner")).toBeVisible();

  // "Narrow by time" opens the timeline; enabling it re-runs with a range
  // and aborts the slow request, whose late response must not render.
  await hint(page).getByTestId("search-slow-hint-timeline").click();
  await expect(page.getByText("Time Filter")).toBeVisible();
  await page.getByTestId("timeline-enable-checkbox").check({ force: true });
  await expect.poll(() => calls.at(-1)!.params.get("from")).not.toBeNull();
  await expect(page.getByTestId("search-row-title")).toHaveText(["FAST"]);
  await page.waitForTimeout(SLOW);
  await expect(page.getByTestId("search-row-title")).toHaveText(["FAST"]);
});

test("no hint when the timeline is already on", async ({ page }) => {
  await open(page, () => ({
    response: searchResponse([SEARCH_HITS.event]),
    delayMs: SLOW,
  }));
  await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
  await page.getByTestId("timeline-enable-checkbox").check({ force: true });
  await page.getByTestId("search-input").fill("far");
  await page.getByTestId("search-input").press("Enter");
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("search-spinner")).toBeVisible();
  await expect(hint(page)).toBeHidden();
});

test("no hint when the query carries its own date", async ({ page }) => {
  await open(page, () => ({
    response: searchResponse([SEARCH_HITS.event]),
    delayMs: SLOW,
  }));
  await page.getByTestId("search-input").fill("far 1857");
  await page.getByTestId("search-input").press("Enter");
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("search-spinner")).toBeVisible();
  await expect(hint(page)).toBeHidden();
});

test("a fast response that reports a slow unfiltered search shows the hint after", async ({
  page,
}) => {
  await open(page, () =>
    searchResponse([SEARCH_HITS.event], {
      timing: { ms: 2000, unfiltered: true },
    }),
  );
  await page.getByTestId("search-input").fill("far");
  await expect(page.getByTestId("search-row")).toHaveCount(1);
  await expect(hint(page)).toBeVisible();
  await expect(hint(page)).toContainText("Narrow by time");
});

test("typeahead keystrokes, each aborted by the next, never trigger it", async ({
  page,
}) => {
  await open(page, () => ({
    response: searchResponse([SEARCH_HITS.event]),
    delayMs: SLOW,
  }));
  // 250ms apart: past the 150ms debounce, so each sends a request that the
  // next keystroke aborts well before 800ms.
  for (const text of ["f", "fa", "far", "far ", "far a", "far aw", "far awa"]) {
    await page.getByTestId("search-input").fill(text);
    await page.waitForTimeout(250);
    await expect(hint(page)).toBeHidden();
  }
});

test("once dismissed, it stays hidden for the session", async ({ page }) => {
  await open(page, () => ({
    response: searchResponse([SEARCH_HITS.event]),
    delayMs: SLOW,
  }));
  await page.getByTestId("search-input").fill("far");
  await page.getByTestId("search-input").press("Enter");
  await expect(hint(page)).toBeVisible({ timeout: 2000 });
  await hint(page).getByTestId("search-slow-hint-dismiss").click();
  await expect(hint(page)).toBeHidden();

  await page.getByTestId("search-input").fill("far away");
  await page.getByTestId("search-input").press("Enter");
  await page.waitForTimeout(1500);
  await expect(hint(page)).toBeHidden();

  await page.reload();
  await waitForMapReady(page);
  await page.getByTestId("search-input").fill("far");
  await page.getByTestId("search-input").press("Enter");
  await page.waitForTimeout(1500);
  await expect(hint(page)).toBeHidden();
});
