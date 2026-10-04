// Creates the web app's tables (sources/locations/events/event_groups/
// event_group_members) via ensureSchema(), with no seeding and no reset.
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
import { ensureSchema } from "../lib/postgres-storage";

ensureSchema()
  .then(() => {
    console.log("Web app schema ready.");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
