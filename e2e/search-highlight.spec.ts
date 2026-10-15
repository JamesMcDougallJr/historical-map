import { test, expect, type Page } from "@playwright/test";
import {
  mockMapDataMany,
  mockSearch,
  mockDocument,
  searchResponse,
  waitForMapReady,
  FAR_LOCATION,
  SEARCH_HITS,
  TEST_LOCATION,
} from "./fixtures";

// Live map highlighting while typing (plans/21-search-ui.md). Styles are read
// through each layer's style function, not from pixels.

test.use({ viewport: { width: 1280, height: 800 } });

async function open(
  page: Page,
  matches?: { locationIds: string[]; truncated: boolean },
) {
  await mockMapDataMany(page);
  await mockDocument(page);
  const mocks = await mockSearch(
    page,
    () => searchResponse([SEARCH_HITS.event, SEARCH_HITS.location]),
    matches ? { matches: () => matches } : {},
  );
  await page.goto("/map");
  await waitForMapReady(page);
  return mocks;
}

type PinState = "hidden" | "normal" | "dim" | "highlight" | "pulse";

/** Each pin's rendered state, keyed by location id. */
function pinStates(page: Page): Promise<Record<string, PinState>> {
  return page.evaluate(() => {
    type OlStyle = {
      getImage(): { getOpacity(): number; getScale(): number } | null;
    };
    const map = (
      window as unknown as {
        __olMap: {
          getView(): { getResolution(): number };
          getLayers(): {
            getArray(): Array<{
              get(k: string): unknown;
              getStyleFunction?: () => (
                f: unknown,
                r: number,
              ) => OlStyle | OlStyle[] | undefined;
              getSource?: () => {
                getFeatures?: () => Array<{ get(k: string): unknown }>;
              } | null;
            }>;
          };
        };
      }
    ).__olMap;
    const resolution = map.getView().getResolution();
    const out: Record<string, string> = {};
    for (const layer of map.getLayers().getArray()) {
      if (layer.get("layerId") !== "events") continue;
      const fn = layer.getStyleFunction?.();
      for (const feature of layer.getSource?.()?.getFeatures?.() ?? []) {
        const id = feature.get("location_id") as string;
        const style = fn?.(feature, resolution);
        if (!style) out[id] = "hidden";
        else if (Array.isArray(style)) {
          const scale = style[1]?.getImage()?.getScale() ?? 1;
          out[id] = scale >= 1.5 ? "pulse" : "highlight";
        } else {
          out[id] =
            (style.getImage()?.getOpacity() ?? 1) < 0.5 ? "dim" : "normal";
        }
      }
    }
    return out as Record<string, PinState>;
  });
}

const A = FAR_LOCATION.id;
const B = TEST_LOCATION.id;

test("typing fires /api/search/matches alongside /api/search, same params", async ({
  page,
}) => {
  const { calls, matchCalls } = await open(page);
  await page.getByTestId("search-input").fill("far");
  await expect.poll(() => matchCalls.length).toBeGreaterThan(0);
  const search = calls.at(-1)!.params;
  const matches = matchCalls.at(-1)!.params;
  for (const key of ["q", "prefix", "mode", "from", "to"]) {
    expect(matches.get(key), key).toBe(search.get(key));
  }
});

test("matching pins highlight and the rest dim; Esc and clearing restore them", async ({
  page,
}) => {
  await open(page, { locationIds: [A], truncated: false });
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "normal", [B]: "normal" });

  await page.getByTestId("search-input").fill("far");
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "highlight", [B]: "dim" });

  await page.keyboard.press("Escape");
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "normal", [B]: "normal" });

  await page.getByTestId("search-input").focus();
  await page.getByTestId("search-input").fill("far");
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "highlight", [B]: "dim" });
  await page.getByTestId("search-input").fill("");
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "normal", [B]: "normal" });
});

test("a truncated match list dims nothing", async ({ page }) => {
  await open(page, { locationIds: [A], truncated: true });
  await page.getByTestId("search-input").fill("far");
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "highlight", [B]: "normal" });
});

test("highlighting never brings back a pin the timeline hides", async ({
  page,
}) => {
  await open(page, { locationIds: [A], truncated: false });
  // Post-1920 keeps B (1900–1950) and hides A (1857).
  await page.getByTestId("timeline-toggle-button").dispatchEvent("click");
  await page.getByTestId("timeline-enable-checkbox").check({ force: true });
  await page.getByTestId("timeline-preset-post-1920").click();
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "hidden", [B]: "normal" });

  await page.getByTestId("search-input").fill("far");
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "hidden", [B]: "dim" });
});

test("re-style, don't refetch: ten keystrokes, no source refresh or refetch", async ({
  page,
}) => {
  let featureFetches = 0;
  page.on("request", (req) => {
    if (req.url().includes("/features")) featureFetches++;
  });
  await open(page, { locationIds: [A], truncated: false });
  await page.evaluate(() => {
    const w = window as unknown as {
      __refreshes: number;
      __olMap: {
        getLayers(): {
          getArray(): Array<{
            get(k: string): unknown;
            getSource?: () => { refresh(): void } | null;
          }>;
        };
      };
    };
    w.__refreshes = 0;
    for (const layer of w.__olMap.getLayers().getArray()) {
      if (layer.get("layerId") !== "events") continue;
      const source = layer.getSource?.();
      if (!source) continue;
      const original = source.refresh.bind(source);
      source.refresh = () => {
        w.__refreshes++;
        original();
      };
    }
  });
  const before = featureFetches;
  const word = "far awayyyy";
  for (let i = 1; i <= 10; i++) {
    await page.getByTestId("search-input").fill(word.slice(0, i));
    await page.waitForTimeout(200);
  }
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "highlight", [B]: "dim" });
  expect(
    await page.evaluate(
      () => (window as unknown as { __refreshes: number }).__refreshes,
    ),
  ).toBe(0);
  expect(featureFetches).toBe(before);
});

test("arrowing onto a row pulses that row's pin, and only that pin", async ({
  page,
}) => {
  await open(page, { locationIds: [A, B], truncated: false });
  await page.getByTestId("search-input").fill("far");
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "highlight", [B]: "highlight" });
  await page.getByTestId("search-input").press("ArrowDown");
  await expect
    .poll(() => pinStates(page))
    .toEqual({ [A]: "pulse", [B]: "highlight" });
});
