// Creates the web app's tables (sources/locations/events/event_groups/
// event_group_members) via ensureSchema(), and installs Martin's tile
// function source (db/martin-functions.sql). No seeding, no reset.
//
//   POSTGRES_URL=... npx tsx scripts/ensure-schema.ts
//
// For a brand-new database, services/ingest's own migrations must run
// *after* this: its init migration does `ALTER TABLE events ADD COLUMN IF
// NOT EXISTS ...` on columns it owns (document_id, date_precision,
// date_text — see that migration's own comment), and `ALTER TABLE` on a
// table that doesn't exist yet fails outright, `IF NOT EXISTS` only makes
// the column addition idempotent, not the table's existence. Local dev
// usually never hits this because something (`npm run dev`, `seed:db`)
// has already called ensureSchema() by the time anyone runs ingest
// migrations by hand — a fresh CI database has not.
//
// Martin's `martin` container must also start *after* this runs, not just
// after Postgres is healthy: Martin discovers SQL functions from the
// catalog once at boot and does not pick up ones created later, so a
// `martin` already running when this creates `event_pins` serves empty
// tiles for the rest of its process lifetime — found by reproducing a CI
// hang where every page.goto("/map") test timed out waiting for vector
// tile features that Martin had no function to generate.
import { ensureSchema } from "../lib/postgres-storage";
import { applyMartinFunctions } from "./apply-martin-functions";

async function main(): Promise<void> {
  await ensureSchema();
  await applyMartinFunctions();
  console.log("Web app schema ready.");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
