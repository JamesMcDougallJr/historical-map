import { defineConfig, devices } from "@playwright/test";

// Real-backend E2E suite: real Postgres, real Martin-served MVT tiles, the
// real Next.js apps (/map and apps/admin). Separate from the root
// playwright.config.ts, which mocks every data fetch on purpose and must
// stay untouched. See e2e-real/README.md before running this locally — it
// truncates and reseeds the shared dev database.
//
// Do not run this config and the root one concurrently: both bind port 3000
// for the root app's webServer.
//
// Overridable so the suite can run against an isolated Postgres + Martin instead
// of the shared dev stack it would otherwise truncate (set both E2E_* here AND
// POSTGRES_URL for the test process itself — global-setup reads that one).
const POSTGRES_URL =
  process.env["E2E_POSTGRES_URL"] ?? "postgres://postgres:password@localhost:5433/db";
const MARTIN_URL = process.env["E2E_MARTIN_URL"] ?? "http://localhost:3001";
const API_KEY = "test-api-key";
const ADMIN_PORT = 3011;

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  // Shared fixture dataset, no per-test DB isolation — serialize workers so
  // specs don't race each other mutating the same rows.
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: "list",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "map",
      testMatch: /specs\/(map|import|api)\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3000" },
    },
    {
      name: "admin",
      testMatch: /specs\/admin\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${ADMIN_PORT}`,
      },
    },
  ],
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:3000",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        POSTGRES_URL,
        NEXT_PUBLIC_MARTIN_URL: MARTIN_URL,
        MAP_API_KEY: API_KEY,
        NEXT_PUBLIC_MAP_API_KEY: API_KEY,
      },
    },
    {
      // Overriding the port here, not in apps/admin/package.json's own
      // `dev`/`start` scripts: that default (3001) collides with Martin's
      // host port in docker-compose.yml, but it's also what every developer
      // running admin standalone expects.
      //
      // By package name, not path (`--workspace=apps/admin`): Playwright
      // spawns webServer commands with this config file's own directory as
      // cwd, and npm resolves a *path* workspace filter relative to cwd —
      // `apps/admin` from inside `e2e-real/` resolves to a directory that
      // doesn't exist and fails with "No workspaces found". The package
      // name isn't cwd-relative; npm just walks up to the nearest
      // package.json regardless of where it started.
      command: `npm run dev --workspace=@historical-map/admin -- -p ${ADMIN_PORT}`,
      url: `http://localhost:${ADMIN_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NEXT_PUBLIC_MAP_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_MAP_API_KEY: API_KEY,
      },
    },
  ],
});
