import { test, expect, type Page, type TestInfo } from "@playwright/test";
import {
  mockMapDataMany,
  mockSearch,
  mockDocument,
  searchResponse,
  viewCenter,
  waitForMapReady,
  SEARCH_HITS,
} from "./fixtures";

// Tablets and phones (plans/21-search-ui.md). Runs only on the ipad-landscape,
// ipad-portrait and iphone projects (playwright.config.ts). Taps use real
// touch events; drags go through CDP's Input.dispatchTouchEvent, which
// produces genuine touch *and* pointer events rather than synthetic ones.

const ALL_HITS = [
  SEARCH_HITS.event,
  SEARCH_HITS.sequence,
  SEARCH_HITS.location,
  SEARCH_HITS.document,
  SEARCH_HITS.passage,
];

type Device = "ipad-landscape" | "ipad-portrait" | "iphone";
const device = (info: TestInfo) => info.project.name as Device;

async function open(page: Page) {
  await mockMapDataMany(page);
  await mockDocument(page);
  const mocks = await mockSearch(page, () => searchResponse(ALL_HITS));
  await page.goto("/map");
  await waitForMapReady(page);
  return mocks;
}

/** Opens search on any layout (phones first tap the search icon). */
async function startSearch(page: Page, info: TestInfo, q = "far") {
  if (device(info) === "iphone")
    await page.getByTestId("search-phone-button").tap();
  await page.getByTestId("search-input").fill(q);
  await expect(page.getByTestId("search-row").first()).toBeVisible();
}

async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y }],
  });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        },
      ],
    });
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await client.detach();
}

async function center(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("each device gets its layout", async ({ page }, info) => {
  await open(page);
  switch (device(info)) {
    case "ipad-landscape":
      await expect(page.getByTestId("search-bar")).toHaveAttribute(
        "data-layout",
        "desktop",
      );
      await expect(page.getByTestId("search-phone-button")).toHaveCount(0);
      break;
    case "ipad-portrait": {
      const bar = page.getByTestId("search-bar");
      await expect(bar).toHaveAttribute("data-layout", "tablet");
      // Full-width top bar.
      const box = await bar.boundingBox();
      expect(box!.width).toBeGreaterThan(page.viewportSize()!.width * 0.85);
      break;
    }
    case "iphone":
      await expect(page.getByTestId("search-bar")).toHaveCount(0);
      await expect(page.getByTestId("search-phone-button")).toBeVisible();
      await page.getByTestId("search-phone-button").tap();
      await expect(page.getByTestId("search-fullscreen")).toBeVisible();
      break;
  }
});

test("tapping a result pins the popup, centres the map, and dismisses the keyboard", async ({
  page,
}, info) => {
  await open(page);
  const start = await viewCenter(page);
  await startSearch(page, info);
  await page.locator('[data-testid="search-row"][data-kind="event"]').tap();
  // The input lost focus (keyboard dismissed) before the fly lands.
  // (On a phone the full-screen view closes, unmounting the input entirely.)
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") ?? null,
      ),
    )
    .not.toBe("search-input");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __olDebug: { pinned: { current: boolean } } })
            .__olDebug.pinned.current,
      ),
    )
    .toBe(true);
  // Far pin is 1.5° east, 0.8° north of the start.
  await expect
    .poll(async () => {
      const end = await viewCenter(page);
      return Math.abs(end[0] - start[0]) + Math.abs(end[1] - start[1]);
    })
    .toBeGreaterThan(2);
});

test("phone: the document sheet opens at half and snaps on drag, without panning the map", async ({
  page,
}, info) => {
  test.skip(device(info) !== "iphone", "bottom sheets are the phone layout");
  await open(page);
  await startSearch(page, info);
  await page.locator('[data-testid="search-row"][data-kind="document"]').tap();
  const sheet = page.getByTestId("bottom-sheet");
  await expect(sheet).toHaveAttribute("data-snap", "half");

  const before = await viewCenter(page);
  const vh = page.viewportSize()!.height;
  const handle = await center(page, '[data-testid="bottom-sheet-handle"]');
  await touchDrag(page, handle, { x: handle.x, y: vh * 0.08 });
  await expect(sheet).toHaveAttribute("data-snap", "full");

  const handle2 = await center(page, '[data-testid="bottom-sheet-handle"]');
  await touchDrag(page, handle2, { x: handle2.x, y: vh * 0.9 });
  await expect(sheet).toHaveAttribute("data-snap", "peek");

  expect(await viewCenter(page)).toEqual(before);
});

test("touch targets are at least 44×44", async ({ page }, info) => {
  await open(page);
  await startSearch(page, info);
  const targets = [
    ...(await page.getByTestId("search-row").all()),
    page.getByTestId("search-limit-to-view"),
    page.getByTestId("search-input"),
  ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(
      box!.height,
      (await target.getAttribute("data-testid")) ?? "",
    ).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  await page.locator('[data-testid="search-row"][data-kind="document"]').tap();
  const panel = page.getByTestId("document-panel");
  await expect(panel).toBeVisible();
  for (const id of [
    "document-panel-close",
    "document-panel-show-all",
    "document-panel-open-original",
  ]) {
    const box = await panel.getByTestId(id).boundingBox();
    expect(box!.height, id).toBeGreaterThanOrEqual(44);
    expect(box!.width, id).toBeGreaterThanOrEqual(44);
  }
});

test("rotating with a panel open keeps the map sized", async ({
  page,
}, info) => {
  await open(page);
  await startSearch(page, info);
  await page.locator('[data-testid="search-row"][data-kind="document"]').tap();
  await expect(page.getByTestId("document-panel")).toBeVisible();
  const { width, height } = page.viewportSize()!;
  await page.setViewportSize({ width: height, height: width });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = (
          window as unknown as {
            __olMap: {
              getSize(): [number, number];
              getTargetElement(): HTMLElement;
            };
          }
        ).__olMap;
        const [w, h] = map.getSize();
        const el = map.getTargetElement();
        return w > 0 && h > 0 && w === el.clientWidth && h === el.clientHeight;
      }),
    )
    .toBe(true);
});

test("the timeline drags by touch, and the open search follows it", async ({
  page,
}, info) => {
  test.skip(
    device(info) === "iphone",
    "the phone's full-screen search covers the slider",
  );
  const { calls } = await open(page);
  await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
  await page.getByTestId("timeline-enable-checkbox").check({ force: true });
  await page.getByTestId("search-input").fill("far");
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
  if (!(await page.getByText("Time Filter").isVisible())) {
    await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
  }
  await page.getByTestId("timeline-preset-all").tap();
  await page.waitForTimeout(400);

  const thumb = await center(page, '[data-testid="timeline-thumb-high"]');
  await touchDrag(page, thumb, { x: thumb.x - 120, y: thumb.y });
  await expect
    .poll(() => Number(calls.at(-1)!.params.get("to")))
    .toBeLessThan(2006);
});

test("no ⌘K hint on a coarse pointer", async ({ page }, info) => {
  await open(page);
  if (device(info) === "iphone")
    await page.getByTestId("search-phone-button").tap();
  await expect(page.locator(".search-kbd-hint")).toBeHidden();
});

test("the result list fits above the on-screen keyboard", async ({
  page,
}, info) => {
  // Emulate a keyboard: the visual viewport shrinks to 420px.
  await page.addInitScript(() => {
    const target = new EventTarget();
    Object.defineProperty(target, "height", { get: () => 420 });
    Object.defineProperty(target, "width", { get: () => window.innerWidth });
    Object.defineProperty(window, "visualViewport", { get: () => target });
  });
  await open(page);
  await startSearch(page, info);
  const container =
    device(info) === "iphone"
      ? page.getByTestId("search-fullscreen")
      : page.getByTestId("search-results");
  const box = await container.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(420 + 1);
});

test("phone: 'Show on map' collapses the list to a peek over the map", async ({
  page,
}, info) => {
  test.skip(device(info) !== "iphone", "phone layout only");
  await open(page);
  await startSearch(page, info);
  const view = page.getByTestId("search-fullscreen");
  await page.getByTestId("search-phone-peek").tap();
  await expect(view).toHaveAttribute("data-peek", "true");
  const box = await view.boundingBox();
  expect(box!.height).toBeLessThan(page.viewportSize()!.height * 0.4);
  await page.getByTestId("search-phone-peek").tap();
  await expect(view).not.toHaveAttribute("data-peek", "true");
});
