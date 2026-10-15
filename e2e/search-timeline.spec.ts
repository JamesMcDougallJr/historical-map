import { test, expect, type Page } from "@playwright/test";
import {
  mockMapDataMany,
  mockSearch,
  mockDocument,
  searchResponse,
  waitForMapReady,
  SEARCH_HITS,
} from "./fixtures";

// The timeline as search's primary filter (plans/21-search-ui.md).

test.use({ viewport: { width: 1280, height: 800 } });

async function open(page: Page, handler?: Parameters<typeof mockSearch>[1]) {
  await mockMapDataMany(page);
  await mockDocument(page);
  const mocks = await mockSearch(
    page,
    handler ?? (() => searchResponse([SEARCH_HITS.event])),
  );
  await page.goto("/map");
  await waitForMapReady(page);
  return mocks;
}

async function enableTimeline(page: Page) {
  await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
  await page.getByTestId("timeline-enable-checkbox").check({ force: true });
}

test("timeline off: no from/to, no chip", async ({ page }) => {
  const { calls } = await open(page);
  await page.getByTestId("search-input").fill("far");
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  expect(calls.at(-1)!.params.get("from")).toBeNull();
  expect(calls.at(-1)!.params.get("to")).toBeNull();
  await expect(page.getByTestId("search-timeline-chip")).toBeHidden();
});

test("timeline on: every request carries its range; a non-removable chip opens it", async ({
  page,
}) => {
  const { calls } = await open(page);
  await enableTimeline(page);
  await page.getByTestId("timeline-preset-1850-1920").click();
  // Close the panel so the chip's click is what opens it.
  await page.locator("body").click({ position: { x: 900, y: 400 } });
  await expect(page.getByText("Time Filter")).toBeHidden();

  await page.getByTestId("search-input").fill("far");
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  expect(calls.at(-1)!.params.get("from")).toBe("1850");
  expect(calls.at(-1)!.params.get("to")).toBe("1920");

  const chip = page.getByTestId("search-timeline-chip");
  await expect(chip).toHaveText("1850–1920");
  await expect(chip.getByRole("button")).toHaveCount(0); // no ×
  await chip.click();
  await expect(page.getByText("Time Filter")).toBeVisible();
});

test("moving the slider re-runs the open search once, with the new range", async ({
  page,
}) => {
  const { calls } = await open(page);
  await enableTimeline(page);
  await page.getByTestId("search-input").fill("far");
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  const before = calls.length;

  if (!(await page.getByText("Time Filter").isVisible())) {
    await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
  }
  await page.getByTestId("timeline-preset-pre-1850").click();
  await expect.poll(() => calls.length).toBe(before + 1);
  expect(calls.at(-1)!.params.get("from")).toBe("1820");
  expect(calls.at(-1)!.params.get("to")).toBe("1850");
  await page.waitForTimeout(400);
  expect(calls.length).toBe(before + 1);
});

test("a typed date outside the timeline is explained, with both ways out", async ({
  page,
}) => {
  const { calls } = await open(page, (params) => {
    const q = params.get("q") ?? "";
    const from = Number(params.get("from"));
    if (
      /1840s/.test(q) &&
      params.get("from") &&
      (from > 1849 || Number(params.get("to")) < 1840)
    ) {
      return searchResponse([], {
        parsed: {
          text: "gold",
          dateRange: [1840, 1849],
          rawDate: "1840s",
          conflict: "timeline",
        },
        timing: { ms: 5, unfiltered: false },
      });
    }
    return searchResponse([SEARCH_HITS.event], { parsed: { text: q } });
  });
  await enableTimeline(page);
  await page.getByTestId("timeline-preset-1850-1920").click();
  await page.locator("body").click({ position: { x: 900, y: 400 } });

  await page.getByTestId("search-input").fill("gold 1840s");
  const conflict = page.getByTestId("search-conflict");
  await expect(conflict).toContainText(
    "1840s is outside your timeline (1850–1920)",
  );

  // "Search 1840s" moves the timeline to the typed range and re-runs.
  await conflict.getByTestId("search-conflict-use-date").click();
  await expect.poll(() => calls.at(-1)!.params.get("from")).toBe("1840");
  expect(calls.at(-1)!.params.get("to")).toBe("1849");
  await expect(page.getByTestId("search-timeline-chip")).toHaveText(
    "1840–1849",
  );

  // Back outside, then "Ignore the date" searches the words alone.
  await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
  await page.getByTestId("timeline-preset-1850-1920").click();
  await page.locator("body").click({ position: { x: 900, y: 400 } });
  await expect(conflict).toBeVisible();
  await conflict.getByTestId("search-conflict-ignore-date").click();
  await expect.poll(() => calls.at(-1)!.params.get("q")).toBe("gold");
  await expect(page.getByTestId("search-input")).toHaveValue("gold");
});

test("a parsed date shows as a removable chip", async ({ page }) => {
  const { calls } = await open(page, (params) =>
    /1840s/.test(params.get("q") ?? "")
      ? searchResponse([SEARCH_HITS.event], {
          parsed: { text: "gold", dateRange: [1840, 1849], rawDate: "1840s" },
          timing: { ms: 5, unfiltered: false },
        })
      : searchResponse([SEARCH_HITS.event]),
  );
  await page.getByTestId("search-input").fill("gold 1840s");
  const chip = page.getByTestId("search-date-chip");
  await expect(chip).toContainText("1840–1849");
  await chip.getByTestId("search-date-chip-remove").click();
  await expect.poll(() => calls.at(-1)!.params.get("q")).toBe("gold");
  await expect(chip).toBeHidden();
});

test("'Limit to view' adds bbox and sources, and is off again after a reload", async ({
  page,
}) => {
  const { calls } = await open(page);
  await page.getByTestId("search-input").fill("far");
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  expect(calls.at(-1)!.params.get("bbox")).toBeNull();

  const toggle = page.getByTestId("search-limit-to-view");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => calls.at(-1)!.params.get("bbox")).not.toBeNull();
  const bbox = calls.at(-1)!.params.get("bbox")!.split(",").map(Number);
  expect(bbox).toHaveLength(4);
  expect(bbox[0]!).toBeLessThan(bbox[2]!);
  expect(calls.at(-1)!.params.get("sources")).toBe("utah-historical");

  await page.reload();
  await waitForMapReady(page);
  await page.getByTestId("search-input").fill("far");
  await expect(page.getByTestId("search-limit-to-view")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
