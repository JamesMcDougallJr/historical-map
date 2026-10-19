// Resets the local Postgres database to an empty, schema-ready state and
// reseeds it for the real-backend E2E suite (e2e-real/).
//
//   ALLOW_TEST_DB_RESET=1 POSTGRES_URL=... npx tsx scripts/reset-test-db.ts
//
// There is no second "test" database — Martin's DATABASE_URL in
// docker-compose.yml is hardcoded to the same `db` database the dev server
// uses, so this script truncates and reseeds the one database in place.
// ALLOW_TEST_DB_RESET guards against running this against anything other
// than a database you've deliberately pointed it at; it refuses to run
// without it. If you have local map data you want to keep, run
// `npm run db:backup` first.
//
// Pass --with-ingest to also truncate the services/ingest-owned tables, for
// the ingestion fixture test (services/ingest/scripts/run-ingestion-fixture.ts).

import { ensureSchema, execSql } from "../lib/postgres-storage";
import { applyMartinFunctions } from "./apply-martin-functions";

const WEB_APP_TABLES = [
  "event_group_members",
  "event_groups",
  "events",
  "locations",
  "sources",
];

const INGEST_TABLES = [
  "ingest_event_sequences",
  "ingest_event_candidates",
  "ingest_extractions",
  "ingest_documents",
  "ingest_sources",
  "geocode_cache",
];

async function main(): Promise<void> {
  if (process.env["ALLOW_TEST_DB_RESET"] !== "1") {
    throw new Error(
      "Refusing to reset the database without ALLOW_TEST_DB_RESET=1 — this " +
        "truncates sources/locations/events/event_groups in whatever database " +
        "POSTGRES_URL points at. Back up first with `npm run db:backup` if you " +
        "have local data to keep.",
    );
  }
  if (!process.env["POSTGRES_URL"]) {
    throw new Error("POSTGRES_URL is not set — nothing to reset.");
  }

  console.warn(
    "Resetting the database at POSTGRES_URL — this truncates all map data. " +
      "Run `npm run db:backup` first if you want to keep what's there now.",
  );

  await ensureSchema();
  await applyMartinFunctions();

  const withIngest = process.argv.includes("--with-ingest");
  const tables = withIngest
    ? [...WEB_APP_TABLES, ...INGEST_TABLES]
    : WEB_APP_TABLES;

  await execSql(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);

  console.log(
    `Reset ${tables.length} table(s)${withIngest ? " (including ingest tables)" : ""}.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
