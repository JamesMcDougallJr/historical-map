// Seeds Postgres from data/map-data.json.
//
//   POSTGRES_URL=... npx tsx scripts/seed-db.ts
//
// Idempotent: locations upsert, events are ON CONFLICT DO NOTHING, so re-running
// picks up newly added entries without duplicating or clobbering existing ones.
//
// A pure CLI entry point, deliberately with no exports: this `main()` call
// is unconditional, so anything that imported from this file would also
// trigger a full demo-data seed as a side effect of the import — see
// scripts/apply-martin-functions.ts, split out for exactly that reason.

import fs from "node:fs";
import path from "node:path";
import type { HistoricalEventsData } from "../app/map/types";
import { ensureSchema, upsertLocation, upsertSource } from "../lib/postgres-storage";
import { applyMartinFunctions } from "./apply-martin-functions";

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
