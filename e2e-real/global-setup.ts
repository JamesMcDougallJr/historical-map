// Runs once before the real-backend suite. Resets the shared local Postgres
// database (see scripts/reset-test-db.ts for why there's no separate "test"
// database) and reseeds it with this suite's fixture dataset.
import { seedFixtureData } from "./fixtures/db";

export default async function globalSetup(): Promise<void> {
  if (process.env["ALLOW_TEST_DB_RESET"] !== "1") {
    throw new Error(
      "e2e-real requires ALLOW_TEST_DB_RESET=1 — running it truncates " +
        "sources/locations/events/event_groups in whatever database " +
        "POSTGRES_URL points at (there is no separate test database; see " +
        "scripts/reset-test-db.ts). Back up first with `npm run db:backup` " +
        "if you have local data to keep.",
    );
  }
  console.warn(
    "[e2e-real] Resetting the database at POSTGRES_URL for the real-backend " +
      "suite. Run `npm run db:backup` first if you want to keep what's there now.",
  );

  const { execSql, ensureSchema } = await import("../lib/postgres-storage");
  await ensureSchema();
  await execSql(
    "TRUNCATE event_group_members, event_groups, events, locations, sources RESTART IDENTITY CASCADE",
  );
  await seedFixtureData();
}
