import { defineConfig, devices } from "@playwright/test";

// Real-backend E2E suite: real Postgres, real Martin-served MVT tiles, the
// real Next.js apps (/map and apps/admin). Separate from the root
// playwright.config.ts, which mocks every data fetch on purpose and must
// stay untouched. See e2e-real/README.md before running this locally — it
// truncates and reseeds the shared dev database.
//
// Do not run this config and the root one concurrently: both bind port 3000
// for the root app's webServer.
const POSTGRES_URL = "postgres://postgres:password@localhost:5433/db";
const MARTIN_URL = "http://localhost:3001";
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
      command: `npm run dev --workspace=apps/admin -- -p ${ADMIN_PORT}`,
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
