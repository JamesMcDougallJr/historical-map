import { defineConfig, devices } from "@playwright/test";

// e2e/popup-placement.spec.ts tests a pure function directly and needs no
// browser or server at all, but sharing one config keeps `npx playwright
// test` a single command; the webServer block below is a no-op for it.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Touch layouts run on the device projects below.
      testIgnore: /search-touch\.spec\.ts/,
    },
    // Tablets and phones (plans/21-search-ui.md). Scoped to the touch spec, so
    // the hover specs never run where hover doesn't exist. Chromium in device
    // emulation, since CI installs only chromium.
    {
      name: "ipad-landscape",
      testMatch: /search-touch\.spec\.ts/,
      use: { ...devices["iPad (gen 7) landscape"], browserName: "chromium" },
    },
    {
      name: "ipad-portrait",
      testMatch: /search-touch\.spec\.ts/,
      use: { ...devices["iPad (gen 7)"], browserName: "chromium" },
    },
    {
      name: "iphone",
      testMatch: /search-touch\.spec\.ts/,
      use: { ...devices["iPhone 14"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    // Reused rather than always spawned: hover.spec.ts mocks every data
    // fetch it depends on (see e2e/fixtures.ts), so it doesn't care whether
    // the already-running dev server has Postgres/Martin configured.
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
