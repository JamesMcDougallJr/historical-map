// Seeds Postgres from data/map-data.json.
//
//   POSTGRES_URL=... npx tsx scripts/seed-db.ts
//
// Idempotent: locations upsert, events are ON CONFLICT DO NOTHING, so re-running
// picks up newly added entries without duplicating or clobbering existing ones.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalEventsData } from "../app/map/types";
import {
  ensureSchema,
  execSql,
  upsertLocation,
  upsertSource,
} from "../lib/postgres-storage";

/** Installs the Martin tile function source (db/martin-functions.sql). */
export async function applyMartinFunctions(): Promise<void> {
  const file = path.resolve("db/martin-functions.sql");
  if (!fs.existsSync(file)) return;
  await execSql(fs.readFileSync(file, "utf-8"));
  console.log("Applied db/martin-functions.sql");
}

async function main() {
  if (!process.env["POSTGRES_URL"]) {
    throw new Error("POSTGRES_URL is not set — nothing to seed.");
  }

  const file =
    process.env["MAP_DATA_PATH"] ?? path.resolve("data/map-data.json");
  const data = JSON.parse(
    fs.readFileSync(file, "utf-8"),
  ) as HistoricalEventsData;

  await ensureSchema();
  await applyMartinFunctions();

  // Sources first — events carry a foreign key to them.
  const sources = data.sources ?? [];
  for (const source of sources) await upsertSource(source);

  let events = 0;
  for (const location of data.locations) {
    await upsertLocation(location);
    events += location.events.length;
  }

  console.log(
    `Seeded ${sources.length} source(s), ${data.locations.length} location(s) ` +
      `and ${events} event(s) from ${file}.`,
  );
  process.exit(0);
}

// Only when run directly (`tsx scripts/seed-db.ts`), never on import —
// `applyMartinFunctions` above is also imported by e2e-real/fixtures/db.ts,
// and this file used to have no exports at all, so nothing ever imported it
// before. An unconditional `main()` here seeds the *real* demo dataset from
// data/map-data.json into whatever database a mere import happens to share,
// racing any other seeding the importer is doing on the same connection —
// found by reproducing a CI foreign-key error that made no sense otherwise.
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
