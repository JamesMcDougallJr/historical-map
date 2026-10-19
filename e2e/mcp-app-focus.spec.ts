import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FAR_LOCATION, TEST_LOCATION } from "./fixtures";

// show_map's `focus` on the inline MCP App (plans/24-search-mcp.md).
//
// There is no MCP App harness, so this is one: a host page embedding the App
// in an iframe and speaking just enough of the ext-apps postMessage protocol
// (ui/initialize → ui/notifications/initialized → ui/notifications/tool-result)
// to hand it a show_map result. The App is a *development* build, so the
// dev-only __olMap/__olDebug handles exist; the production bundle strips them.

test.use({ viewport: { width: 1000, height: 700 } });

let appHtml = "";

test.beforeAll(({}, testInfo) => {
  // Per worker: fullyParallel can run this file's tests in several workers.
  const outDir = path.join(os.tmpdir(), `mcp-app-dev-${testInfo.workerIndex}`);
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    "npx",
    [
      "vite",
      "build",
      "--config",
      "vite.config.mcp.ts",
      "--outDir",
      outDir,
      "--emptyOutDir",
    ],
    { env: { ...process.env, NODE_ENV: "development" }, stdio: "ignore" },
  );
  appHtml = readFileSync(path.join(outDir, "mcp-app.html"), "utf8");
});

const HOST_HTML = `<!doctype html><html><body style="margin:0">
<iframe id="app" src="https://app.test/mcp-app.html" style="width:800px;height:520px;border:0"></iframe>
<script>
  const frame = document.getElementById("app");
  window.__appReady = false;
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    const reply = (result) =>
      frame.contentWindow.postMessage({ jsonrpc: "2.0", id: msg.id, result }, "*");
    if (msg.method === "ui/initialize") {
      reply({
        protocolVersion: msg.params.protocolVersion,
        hostInfo: { name: "test-host", version: "1.0.0" },
        hostCapabilities: {},
        hostContext: { containerDimensions: { width: 800, height: 520 } },
      });
    } else if (msg.method === "ui/notifications/initialized") {
      window.__appReady = true;
    } else if (msg.id !== undefined && msg.method) {
      reply({});
    }
  });
  window.__sendToolResult = (structuredContent) =>
    frame.contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "ok" }], structuredContent },
      },
      "*",
    );
</script></body></html>`;

/** Every request the page (host or App) makes, so CSP-relevant ones can be asserted. */
async function openHost(page: Page): Promise<string[]> {
  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  // Offline: base tiles aren't what's under test.
  await page.route(/tile\.openstreetmap\.org|flaticon\.com/, (route) =>
    route.abort(),
  );
  await page.route("https://host.test/", (route) =>
    route.fulfill({ body: HOST_HTML, contentType: "text/html" }),
  );
  await page.route("https://app.test/mcp-app.html", (route) =>
    route.fulfill({ body: appHtml, contentType: "text/html" }),
  );
  await page.goto("https://host.test/");
  await page.waitForFunction(
    () => (window as unknown as { __appReady: boolean }).__appReady,
  );
  return requests;
}

const appFrame = (page: Page) => page.frame({ url: /app\.test/ })!;

async function sendToolResult(page: Page, structuredContent: unknown) {
  await page.evaluate(
    (content) =>
      (
        window as unknown as { __sendToolResult(c: unknown): void }
      ).__sendToolResult(content),
    structuredContent,
  );
}

async function viewCenterIn(page: Page): Promise<[number, number]> {
  return appFrame(page).evaluate(() => {
    const map = (
      window as unknown as {
        __olMap: { getView(): { getCenter(): number[] } };
      }
    ).__olMap;
    const [x, y] = map.getView().getCenter();
    return [
      (x! / 6378137) * (180 / Math.PI),
      (Math.atan(Math.exp(y! / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI),
    ] as [number, number];
  });
}

const near = (a: [number, number], b: [number, number], tol = 0.05) =>
  Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;

test("focus on an event: the inline map centres on it with the popup pinned", async ({
  page,
}) => {
  await openHost(page);
  await sendToolResult(page, {
    locations: [TEST_LOCATION, FAR_LOCATION],
    focus: {
      kind: "event",
      locationId: FAR_LOCATION.id,
      locationName: FAR_LOCATION.name,
      coordinates: FAR_LOCATION.coordinates,
      eventId: "far-event-1",
      sourceId: null,
    },
  });
  await expect
    .poll(async () => near(await viewCenterIn(page), FAR_LOCATION.coordinates))
    .toBe(true);
  await expect
    .poll(() =>
      appFrame(page).evaluate(
        () =>
          (window as unknown as { __olDebug: { pinned: { current: boolean } } })
            .__olDebug.pinned.current,
      ),
    )
    .toBe(true);
  await expect(appFrame(page).getByTestId("map-popup")).toContainText(
    "Far Away Event",
  );
});

test("focus on a document: text and pages only, and nothing fetches the original", async ({
  page,
}) => {
  const requests = await openHost(page);
  await sendToolResult(page, {
    locations: [TEST_LOCATION, FAR_LOCATION],
    focus: {
      kind: "passage",
      title: "Annals of the Test Basin",
      locationIds: [FAR_LOCATION.id],
      coordinates: [FAR_LOCATION.coordinates],
      path: false,
      passages: [
        {
          anchor: "p.42¶1",
          snippet: "they went \u0002far\u0003 north",
          focused: true,
        },
        { anchor: "p.43¶2", snippet: "and then further still" },
      ],
    },
  });
  const panel = appFrame(page).getByTestId("mcp-focus-panel");
  await expect(panel).toContainText("Annals of the Test Basin");
  const passages = panel.getByTestId("mcp-focus-passage");
  await expect(passages).toHaveCount(2);
  await expect(passages.nth(0)).toHaveAttribute("data-focused", "true");
  await expect(passages.nth(0).locator("mark")).toHaveText("far");
  await expect(passages.nth(0)).toContainText("p.42¶1");
  // No link to, or request for, the original file — its presigned URL is an
  // origin the App's CSP blocks (CLAUDE.md, "CSP is the thing that breaks
  // the inline map").
  await expect(panel.locator("a")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(
    requests.filter((u) =>
      /amazonaws|minio|\/api\/documents\/|presign/i.test(u),
    ),
  ).toEqual([]);
  // The map is filtered to the document's events.
  await expect
    .poll(async () =>
      near(await viewCenterIn(page), FAR_LOCATION.coordinates, 0.3),
    )
    .toBe(true);
});
