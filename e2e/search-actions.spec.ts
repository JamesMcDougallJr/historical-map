import { test, expect, type Page } from "@playwright/test";
import {
  mockMapDataMany,
  mockSearch,
  mockDocument,
  searchResponse,
  viewCenter,
  waitForMapReady,
  DOC_EMPTY_ID,
  DOC_ID,
  FAR_LOCATION,
  SEARCH_HITS,
  TEST_LOCATION,
} from "./fixtures";

// What clicking each kind of result does (plans/21-search-ui.md).

test.use({ viewport: { width: 1280, height: 800 } });

const ALL_HITS = [
  SEARCH_HITS.event,
  SEARCH_HITS.sequence,
  SEARCH_HITS.location,
  SEARCH_HITS.document,
  SEARCH_HITS.passage,
];

async function open(page: Page, hits: unknown[] = ALL_HITS) {
  await mockMapDataMany(page);
  await mockDocument(page);
  await page.route("**/api/data/groups/test-group-1", (route) =>
    route.fulfill({
      json: {
        group: {
          id: "test-group-1",
          title: "Test Sequence",
          description: "Two events, far first.",
          memberEventIds: ["far-event-1", "test-event-1"],
        },
        members: [TEST_LOCATION, FAR_LOCATION],
      },
    }),
  );
  const mocks = await mockSearch(page, () => searchResponse(hits));
  await page.goto("/map");
  await waitForMapReady(page);
  return mocks;
}

async function searchAndClick(page: Page, kind: string) {
  await page.getByTestId("search-input").fill("far");
  await page
    .locator(`[data-testid="search-row"][data-kind="${kind}"]`)
    .first()
    .click();
}

const near = (a: [number, number], b: [number, number], tol = 0.05) =>
  Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;

const pinned = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __olDebug: { pinned: { current: boolean } } })
        .__olDebug.pinned.current,
  );

const eventLayerIds = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __olMap: {
          getLayers(): { getArray(): Array<{ get(k: string): unknown }> };
        };
      }
    ).__olMap
      .getLayers()
      .getArray()
      .map((l) => l.get("eventLayerId"))
      .filter(Boolean),
  );

test("event: flies there, opens the popup pinned on that event, URL records it", async ({
  page,
}) => {
  await open(page);
  await searchAndClick(page, "event");

  await expect
    .poll(async () => near(await viewCenter(page), FAR_LOCATION.coordinates))
    .toBe(true);
  await expect.poll(() => pinned(page)).toBe(true);
  const popup = page.getByTestId("map-popup");
  await expect(popup).toContainText(FAR_LOCATION.name);
  await expect(popup).toContainText("Far Away Event");

  const url = new URL(page.url());
  expect(url.searchParams.get("q")).toBe("far");
  expect(url.searchParams.get("hit")).toBe("event:far-event-1");
});

test("event: a source layer that was off is switched on first", async ({
  page,
}) => {
  await open(page);
  // Turn the demo layer off through the layer control.
  await page.getByLabel("Toggle layer controls").click();
  await page.getByTestId("event-layer-checkbox-utah-historical").uncheck();
  await expect.poll(() => eventLayerIds(page)).not.toContain("utah-historical");
  await page.getByLabel("Toggle layer controls").click();

  await searchAndClick(page, "event");
  await expect.poll(() => eventLayerIds(page)).toContain("utah-historical");
  await expect
    .poll(async () => near(await viewCenter(page), FAR_LOCATION.coordinates))
    .toBe(true);
  await expect.poll(() => pinned(page)).toBe(true);
});

test("location: flies (not cuts) there and pins its popup at the first event", async ({
  page,
}) => {
  await open(page);
  const start = await viewCenter(page);
  await searchAndClick(page, "location");

  // Mid-animation the centre is somewhere between the two.
  await page.waitForTimeout(250);
  const mid = await viewCenter(page);
  expect(near(mid, start, 0.01)).toBe(false);
  expect(near(mid, FAR_LOCATION.coordinates, 0.01)).toBe(false);

  await expect
    .poll(async () => near(await viewCenter(page), FAR_LOCATION.coordinates))
    .toBe(true);
  await expect.poll(() => pinned(page)).toBe(true);
  await expect(page.getByTestId("map-popup")).toContainText("Far Away Event");
});

test("sequence: fetches members, fits, shows the chip and an ordered panel; × clears", async ({
  page,
}) => {
  const groupRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/data/groups/test-group-1"))
      groupRequests.push(req.url());
  });
  await open(page);
  await searchAndClick(page, "sequence");

  const panel = page.getByTestId("sequence-panel");
  await expect(panel).toBeVisible();
  expect(groupRequests.length).toBeGreaterThan(0);
  const members = panel.getByTestId("sequence-panel-member");
  await expect(members).toHaveCount(2);
  await expect(members.nth(0)).toHaveAttribute("data-event-id", "far-event-1");
  await expect(members.nth(1)).toHaveAttribute("data-event-id", "test-event-1");

  // Fit to the bbox: the centre moves to its middle.
  const [minLon, minLat, maxLon, maxLat] = SEARCH_HITS.sequence.bbox;
  await expect
    .poll(async () =>
      near(
        await viewCenter(page),
        [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
        0.3,
      ),
    )
    .toBe(true);

  const chip = page.getByTestId("search-focus-chip");
  await expect(chip).toContainText("Showing: Test Sequence");
  await chip.getByTestId("search-focus-chip-clear").click();
  await expect(chip).toBeHidden();
  await expect(panel).toBeHidden();
});

test("document: panel with header, passages and events; show-all filters; open original", async ({
  page,
}) => {
  const docSearches: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/data/search?document="))
      docSearches.push(req.url());
  });
  await open(page);
  await searchAndClick(page, "document");

  const panel = page.getByTestId("document-panel");
  await expect(panel.getByTestId("document-panel-title")).toHaveText(
    "Annals of the Test Basin",
  );
  await expect(panel.getByTestId("document-panel-source")).toContainText(
    "Utah Historical Events",
  );
  await expect(
    panel.locator(
      '[data-testid^="document-passage-"]:not([data-testid$="page"]):not([data-testid$="event"])',
    ),
  ).toHaveCount(12);
  await expect(panel.getByTestId("document-panel-event")).toHaveCount(1);

  const original = panel.getByTestId("document-panel-open-original");
  await expect(original).toHaveAttribute("target", "_blank");
  await expect(original).toHaveAttribute(
    "href",
    `/api/documents/${DOC_ID}/source`,
  );

  await panel.getByTestId("document-panel-show-all").click();
  await expect(page.getByTestId("search-focus-chip")).toContainText(
    "Showing: Annals of the Test Basin",
  );
  expect(docSearches.some((u) => u.includes(DOC_ID))).toBe(true);
});

test("passage: the panel opens scrolled to and highlighting it; page link; show event", async ({
  page,
}) => {
  await open(page);
  await searchAndClick(page, "passage");

  const focused = page.getByTestId("document-passage-7");
  await expect(focused).toHaveAttribute("data-focused", "true");
  await expect(focused).toHaveClass(/search-passage-focus/);
  await expect(focused).toBeInViewport();
  await expect(focused.getByTestId("document-passage-page")).toHaveAttribute(
    "href",
    new RegExp(`/api/documents/${DOC_ID}/source#page=42$`),
  );

  // The row's inline "show event" runs the event action.
  await page.getByTestId("search-input").fill("far ");
  await page
    .locator(
      '[data-testid="search-row"][data-kind="passage"] [data-testid="search-row-show-event"]',
    )
    .click();
  await expect.poll(() => pinned(page)).toBe(true);
  await expect(page.getByTestId("map-popup")).toContainText("Far Away Event");
});

test("document with no published events says so", async ({ page }) => {
  await open(page, [
    { ...SEARCH_HITS.document, id: DOC_EMPTY_ID, title: "Empty Ledger" },
  ]);
  await searchAndClick(page, "document");
  await expect(page.getByTestId("document-panel-no-events")).toContainText(
    "No published events",
  );
  await expect(page.getByTestId("document-panel-event")).toHaveCount(0);
});

test("Esc and the back button return to the result list, query intact", async ({
  page,
}) => {
  await open(page);
  await searchAndClick(page, "document");
  await expect(page.getByTestId("document-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("document-panel")).toBeHidden();
  await expect(page.getByTestId("search-results")).toBeVisible();
  await expect(page.getByTestId("search-input")).toHaveValue("far");

  await page
    .locator('[data-testid="search-row"][data-kind="sequence"]')
    .click();
  await expect(page.getByTestId("sequence-panel")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("sequence-panel")).toBeHidden();
  await expect(page.getByTestId("search-focus-chip")).toBeHidden();
  await expect(page.getByTestId("search-results")).toBeVisible();
  await expect(page.getByTestId("search-input")).toHaveValue("far");
});

test("a shared ?q=&hit= URL reproduces the map state", async ({ page }) => {
  await mockMapDataMany(page);
  await mockDocument(page);
  await mockSearch(page, () => searchResponse(ALL_HITS));
  await page.goto("/map?q=far&hit=event:far-event-1");
  await waitForMapReady(page);
  await expect(page.getByTestId("search-input")).toHaveValue("far");
  await expect
    .poll(async () => near(await viewCenter(page), FAR_LOCATION.coordinates))
    .toBe(true);
  await expect.poll(() => pinned(page)).toBe(true);
  await expect(page.getByTestId("map-popup")).toContainText("Far Away Event");
});

// ── People (plans/22-search-people.md) ──────────────────────────────────────

/** Serves /api/data/search?person=… with two events, given their locations (in date order). */
async function mockPersonEvents(
  page: Page,
  locations: Array<{ id: string; name: string; coordinates: [number, number] }>,
) {
  await page.route("**/api/data/search?person=**", (route) =>
    route.fulfill({
      json: {
        // Deliberately returned newest first: the panel must sort by date.
        results: locations
          .map((location, i) => ({
            location: { ...location, events: [] },
            event: {
              id: `person-ev-${i}`,
              title: `Person event ${i}`,
              description: "",
              date: `${1847 + i * 30}-01-01`,
              datePrecision: "year",
            },
          }))
          .reverse(),
      },
    }),
  );
}

const hasPath = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __olMap: {
          getLayers(): { getArray(): Array<{ get(k: string): unknown }> };
        };
      }
    ).__olMap
      .getLayers()
      .getArray()
      .some((l) => l.get("layerId") === "focus-path"),
  );

test("person row: icon, name and 'N events · range'", async ({ page }) => {
  await open(page, [SEARCH_HITS.person]);
  await page.getByTestId("search-input").fill("brigham");
  const row = page.locator('[data-testid="search-row"][data-kind="person"]');
  await expect(row.getByTestId("search-row-kind")).toHaveText("Person");
  await expect(row.getByTestId("search-row-title")).toHaveText("Brigham Young");
  await expect(row.getByTestId("search-row-icon").locator("svg")).toBeVisible();
  await expect(row.getByTestId("search-row-context")).toHaveText(
    "2 events · 1847–1877",
  );
  await expect(page.getByTestId("search-section-person")).toContainText(
    "People",
  );
});

test("person: filters to their events, chip, date-ordered panel; no path when far apart", async ({
  page,
}) => {
  await open(page, [SEARCH_HITS.person]);
  await mockPersonEvents(page, [TEST_LOCATION, FAR_LOCATION]);
  await searchAndClick(page, "person");

  await expect(page.getByTestId("search-focus-chip")).toContainText(
    "Showing: Brigham Young",
  );
  const items = page.getByTestId("person-panel-event");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-event-id", "person-ev-0"); // 1847
  await expect(items.nth(1)).toHaveAttribute("data-event-id", "person-ev-1"); // 1877
  // ~150km apart: past the proximity threshold, so filter only.
  expect(await hasPath(page)).toBe(false);
});

test("person: close-together events get the date-ordered path", async ({
  page,
}) => {
  await open(page, [SEARCH_HITS.person]);
  const near = {
    id: "test-location-near",
    name: "Near Test Location",
    coordinates: [
      TEST_LOCATION.coordinates[0] + 0.05,
      TEST_LOCATION.coordinates[1],
    ] as [number, number],
  };
  await mockPersonEvents(page, [TEST_LOCATION, near]);
  await searchAndClick(page, "person");
  await expect(page.getByTestId("person-panel-event")).toHaveCount(2);
  await expect.poll(() => hasPath(page)).toBe(true);
  // Clearing the chip removes the filter and the path.
  await page.getByTestId("search-focus-chip-clear").click();
  await expect.poll(() => hasPath(page)).toBe(false);
});
