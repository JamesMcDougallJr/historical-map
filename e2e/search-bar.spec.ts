import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  mockMapDataMany,
  mockSearch,
  mockDocument,
  searchResponse,
  waitForMapReady,
  SEARCH_HITS,
} from "./fixtures";

// The search bar's input and rows (plans/21-search-ui.md), against stubbed
// /api/search responses. What clicking does is search-actions.spec.ts.

test.use({ viewport: { width: 1280, height: 800 } });

const ALL_HITS = [
  SEARCH_HITS.event,
  SEARCH_HITS.sequence,
  SEARCH_HITS.location,
  SEARCH_HITS.document,
  SEARCH_HITS.passage,
];

async function open(page: Page) {
  await mockMapDataMany(page);
  await mockDocument(page);
  await page.goto("/map");
  await waitForMapReady(page);
}

const input = (page: Page) => page.getByTestId("search-input");
const rows = (page: Page) => page.getByTestId("search-row");

test("⌘K and / focus the input; Esc blurs it and closes the list", async ({
  page,
}) => {
  await mockSearch(page, () => searchResponse(ALL_HITS));
  await open(page);

  await page.locator("body").click({ position: { x: 900, y: 600 } });
  await page.keyboard.press("/");
  await expect(input(page)).toBeFocused();

  await input(page).blur();
  await page.keyboard.press("Control+k");
  await expect(input(page)).toBeFocused();

  await input(page).fill("far");
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input(page)).not.toBeFocused();
  await expect(page.getByTestId("search-results")).toBeHidden();
});

test("typing sends prefix=1; Enter sends a search without it", async ({
  page,
}) => {
  const { calls } = await mockSearch(page, () => searchResponse(ALL_HITS));
  await open(page);

  await input(page).fill("far");
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  expect(calls.at(-1)!.params.get("prefix")).toBe("1");
  expect(calls.at(-1)!.params.get("q")).toBe("far");

  const before = calls.length;
  await input(page).press("Enter");
  await expect.poll(() => calls.length).toBe(before + 1);
  expect(calls.at(-1)!.params.get("prefix")).toBeNull();
});

test("debounce and abort: a stale response never overwrites a newer one", async ({
  page,
}) => {
  const aborted: string[] = [];
  page.on("requestfailed", (req) => {
    if (req.url().includes("/api/search?")) aborted.push(req.url());
  });
  const { calls } = await mockSearch(page, (params, index) => {
    const q = params.get("q")!;
    // The first request answers last.
    const hit = {
      ...SEARCH_HITS.event,
      id: `ev-${q}`,
      title: `Result for ${q}`,
    };
    return {
      response: searchResponse([hit]),
      delayMs: index === 0 ? 1500 : 50,
    };
  });
  await open(page);

  // Quick typing collapses into one request…
  await input(page).pressSequentially("mas", { delay: 30 });
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]!.params.get("q")).toBe("mas");

  // …but a pause past the debounce starts another, aborting the first.
  await page.waitForTimeout(50);
  await input(page).fill("mass");
  await expect(page.getByTestId("search-row-title")).toHaveText([
    "Result for mass",
  ]);
  // Give the slow first response time to land; it must not take over.
  await page.waitForTimeout(1800);
  await expect(page.getByTestId("search-row-title")).toHaveText([
    "Result for mass",
  ]);
  expect(aborted.length).toBeGreaterThanOrEqual(1);
});

test("each kind renders its section, icon, label and context", async ({
  page,
}) => {
  await mockSearch(page, () => searchResponse(ALL_HITS));
  await open(page);
  await input(page).fill("far");

  for (const [kind, label, section] of [
    ["event", "Event", "Events"],
    ["sequence", "Sequence", "Sequences"],
    ["location", "Place", "Places"],
    ["document", "Document", "Documents"],
    ["passage", "Passage", "Passages"],
  ] as const) {
    const group = page.getByTestId(`search-section-${kind}`);
    await expect(group).toContainText(section);
    const row = group.getByTestId("search-row");
    await expect(row.getByTestId("search-row-kind")).toHaveText(label);
    await expect(
      row.getByTestId("search-row-icon").locator("svg"),
    ).toBeVisible();
  }

  const event = page.locator('[data-testid="search-row"][data-kind="event"]');
  await expect(event.getByTestId("search-row-title")).toHaveText(
    "Far Away Event",
  );
  // year precision → "1857", never "January 1, 1857"
  await expect(event.getByTestId("search-row-date")).toHaveText("1857");
  await expect(event.getByTestId("search-row-context")).toContainText(
    "Far Test Location",
  );

  await expect(
    page.locator('[data-kind="sequence"] [data-testid="search-row-context"]'),
  ).toHaveText("2 events · 1857–1900");
  await expect(
    page.locator('[data-kind="location"] [data-testid="search-row-context"]'),
  ).toHaveText("1 event · 1857");
  await expect(
    page.locator('[data-kind="document"] [data-testid="search-row-context"]'),
  ).toHaveText("p.43 · 12 matches · Utah Historical Events");
  await expect(
    page.locator('[data-kind="passage"] [data-testid="search-row-context"]'),
  ).toHaveText("p.43¶2 · Annals of the Test Basin");
});

test("the top hit row renders when the response marks one", async ({
  page,
}) => {
  await mockSearch(page, () =>
    searchResponse(ALL_HITS, { topHit: { kind: "event", id: "far-event-1" } }),
  );
  await open(page);
  await input(page).fill("far away event");
  const top = page.locator('[data-testid="search-row"][data-top="true"]');
  await expect(top).toHaveCount(1);
  await expect(top).toHaveAttribute("data-hit", "event:far-event-1");
  await expect(page.getByText("Top hit")).toBeVisible();
});

test("<mark> comes from snippet markers; HTML in a snippet stays text", async ({
  page,
}) => {
  const hostile = {
    ...SEARCH_HITS.event,
    snippet: `before \u0002far\u0003 <img src=x onerror="window.__pwned=1"> after`,
  };
  await mockSearch(page, () => searchResponse([hostile]));
  await open(page);
  await input(page).fill("far");

  const row = rows(page).first();
  await expect(row.locator("mark")).toHaveText("far");
  await expect(row).toContainText('<img src=x onerror="window.__pwned=1">');
  await expect(row.locator("img")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __pwned?: number }).__pwned,
    ),
  ).toBeUndefined();
});

test("a semantic-only hit shows the 'by meaning' marker", async ({ page }) => {
  await mockSearch(page, () =>
    searchResponse([{ ...SEARCH_HITS.event, matchedOn: ["meaning"] }]),
  );
  await open(page);
  await input(page).fill("the wagon train attack");
  await expect(page.getByTestId("search-row-meaning")).toHaveText("by meaning");
});

test("a quote-matched event shows the quote, labelled, and its anchor opens the panel", async ({
  page,
}) => {
  const quoted = {
    ...SEARCH_HITS.event,
    matchedOn: ["quote"],
    snippet: "the model's description",
    quotePassage: {
      documentId: SEARCH_HITS.document.id,
      anchor: "p.42¶1",
      snippet: "the \u0002Fancher\u0003 train was set upon",
    },
  };
  await mockSearch(page, () => searchResponse([quoted]));
  await open(page);
  await input(page).fill("fancher");

  const row = rows(page).first();
  await expect(row.locator("mark")).toHaveText("Fancher");
  await expect(row.getByTestId("search-row-quote")).toContainText(
    "from the source",
  );
  await row.getByTestId("search-row-quote-anchor").click();
  const panel = page.getByTestId("document-panel");
  await expect(panel).toBeVisible();
  // DOCUMENT_PANEL's anchors run p.40¶1, p.40¶2, p.40¶3, p.41¶1, … so p.42¶1
  // is the 7th paragraph.
  await expect(panel.locator('[data-focused="true"]')).toContainText(
    "Paragraph 7",
  );
});

test("keyboard: ↑/↓ move across sections, Enter activates, ARIA is wired", async ({
  page,
}) => {
  await mockSearch(page, () => searchResponse(ALL_HITS));
  await open(page);
  await input(page).fill("far");
  await expect(rows(page)).toHaveCount(5);

  await expect(input(page)).toHaveAttribute("role", "combobox");
  await expect(input(page)).toHaveAttribute("aria-expanded", "true");
  await expect(input(page)).toHaveAttribute("aria-controls", "search-listbox");
  await expect(page.locator("#search-listbox")).toHaveAttribute(
    "role",
    "listbox",
  );
  await expect(page.locator('#search-listbox [role="group"]')).toHaveCount(5);
  for (const group of await page
    .locator('#search-listbox [role="group"]')
    .all()) {
    const labelledBy = await group.getAttribute("aria-labelledby");
    await expect(page.locator(`#${labelledBy}`)).toBeVisible();
  }

  await input(page).press("ArrowDown");
  await expect(input(page)).toHaveAttribute(
    "aria-activedescendant",
    "search-opt-0",
  );
  await input(page).press("ArrowDown");
  await input(page).press("ArrowDown");
  // Third option = the location (event, sequence, location…), across headers.
  await expect(input(page)).toHaveAttribute(
    "aria-activedescendant",
    "search-opt-2",
  );
  await expect(page.locator("#search-opt-2")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#search-opt-2")).toHaveAttribute(
    "data-kind",
    "location",
  );
  await input(page).press("ArrowUp");
  await expect(input(page)).toHaveAttribute(
    "aria-activedescendant",
    "search-opt-1",
  );

  await input(page).press("Enter");
  // Sequence action: its panel opens.
  await expect(page.getByTestId("sequence-panel")).toBeVisible();
});

test("empty and degraded states", async ({ page }) => {
  let response = searchResponse([]);
  await mockSearch(page, () => response);
  await open(page);

  await input(page).fill("zzzz");
  await expect(page.getByTestId("search-empty")).toContainText("No results");

  response = searchResponse([SEARCH_HITS.event], {
    modes: { lexical: true, semantic: false, documents: false },
  });
  await input(page).fill("far");
  await expect(page.getByTestId("search-documents-unavailable")).toHaveText(
    "Source text search unavailable",
  );
});

test("MapView never imports the search UI, so the MCP App embed can't grow one", () => {
  // The embed renders MapView with showNav={false} and none of the search
  // props; the bar, panels and highlight requests all live in app/map/search,
  // which MapView must not import (it would also bloat the MCP bundle).
  const source = readFileSync("app/map/components/MapView.tsx", "utf8");
  expect(source).not.toMatch(/from ["'][^"']*\/search\//);
  expect(source).not.toMatch(/\/api\/search/);
});
