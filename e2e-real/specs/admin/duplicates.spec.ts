import { test, expect, type Route } from "@playwright/test";
import type { DuplicateItem } from "@historical-map/domain";

// The admin app's /duplicates page. The ingestion API is not part of this suite's
// stack, so the admin app's own /api/duplicates route (which proxies to it) is stubbed
// at the browser level: this covers what the page renders and what its buttons send.
// The proxy and the controller behind it are exercised by the ingestion fixture
// (`npm run test:ingestion-fixture:jev`), which boots the real ingestion API.

const match = {
  id: "ev-existing",
  title: "Founding Day at Fixture Village",
  date: "1850-01-01",
  dateText: "1850",
  placeName: "Fixture Village",
  sourceId: "local-directory",
  description: "Already on the map.",
  quote: "Founding Day quote.",
};

const item = (key: string, title: string, status: DuplicateItem["status"], pSame: number, pDistinct: number): DuplicateItem => ({
  eventKey: key,
  documentId: "doc-1",
  status,
  event: {
    title,
    dateText: "1850",
    placeName: "Fixture Village",
    description: `${title} description.`,
    sourceText: `${title} quote.`,
  },
  pSame,
  pDistinct,
  detail: "jev …",
  match,
  createdAt: "2026-10-11T00:00:00.000Z",
});

test.describe("admin: duplicates (stubbed ingestion API)", () => {
  test("lists held and auto-resolved items; resolving one sends the right request and reloads", async ({
    page,
  }) => {
    let items = [
      item("held-1", "The Founding of Fixture Village", "held", 0.95, 0.85),
      item("auto-1", "Opening of the Village Mill", "auto-resolved", 0.97, 0.03),
    ];
    const posts: string[] = [];

    await page.route("**/api/duplicates", (route: Route) =>
      route.fulfill({ json: { data: items } }),
    );
    await page.route("**/api/duplicates/*/*", (route: Route) => {
      const url = new URL(route.request().url());
      posts.push(`${route.request().method()} ${url.pathname}`);
      if (url.pathname.endsWith("/dismiss")) items = items.filter((i) => i.eventKey !== "held-1");
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto("/duplicates");

    await expect(page.getByRole("heading", { name: "Held for review (1)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Auto-resolved as duplicates (1)" })).toBeVisible();

    const held = page.getByTestId("duplicate-held-1");
    await expect(held).toContainText("The Founding of Fixture Village");
    await expect(held).toContainText("Founding Day at Fixture Village"); // the match
    await expect(held.getByTestId("duplicate-odds")).toHaveText(
      "Jev: 95% the same event · 85% a distinct one",
    );
    // A held item can go either way; an auto-resolved one can only be overturned.
    await expect(held.getByRole("button", { name: "Different event — publish" })).toBeVisible();
    await expect(held.getByRole("button", { name: "Duplicate — leave out" })).toBeVisible();
    const auto = page.getByTestId("duplicate-auto-1");
    await expect(auto.getByRole("button", { name: "Overturn — publish it" })).toBeVisible();
    await expect(auto.getByRole("button", { name: "Duplicate — leave out" })).toHaveCount(0);

    await held.getByRole("button", { name: "Duplicate — leave out" }).click();
    await expect(page.getByRole("heading", { name: "Held for review (0)" })).toBeVisible();
    expect(posts).toEqual(["POST /api/duplicates/held-1/dismiss"]);

    await auto.getByRole("button", { name: "Overturn — publish it" }).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toBe("POST /api/duplicates/auto-1/approve");
  });

  test("shows the API's error instead of an empty list when the ingestion API is unavailable", async ({
    page,
  }) => {
    await page.route("**/api/duplicates", (route: Route) =>
      route.fulfill({ status: 503, json: { message: "Queue dashboard disabled: set BULL_BOARD_PASSWORD." } }),
    );
    await page.goto("/duplicates");
    await expect(page.getByText("Queue dashboard disabled")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Held for review/ })).toHaveCount(0);
  });
});
