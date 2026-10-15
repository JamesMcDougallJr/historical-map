// Dumps the app tables (web app's events/locations/sources plus services/ingest's
// ingest_* pipeline tables) from the local docker-compose Postgres into a
// self-contained, schema+data custom-format file under backups/.
//
// Deliberately NOT a full pg_dump: this database also carries PostGIS's own
// tiger/topology schemas (loaded by the imresamu/postgis image), which are
// system tables recreated by `CREATE EXTENSION postgis` on a fresh container,
// not app data worth backing up.
//
//   npm run db:backup
//
// Restore with `npm run db:restore -- backups/<file>.dump` (see db-restore.ts).
// Requires `docker compose up -d db` already running.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP_TABLES = [
  "sources",
  "locations",
  "events",
  "event_entities",
  "geocode_cache",
  "ingest_sources",
  "ingest_documents",
  "ingest_extractions",
  "ingest_event_candidates",
  "ingest_migrations",
];

function main(): void {
  const backupsDir = path.resolve("backups");
  fs.mkdirSync(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(backupsDir, `db-${timestamp}.dump`);

  const args = [
    "compose",
    "exec",
    "-T",
    "db",
    "pg_dump",
    "-U",
    "postgres",
    "-d",
    "db",
    "-Fc", // custom format: compressed, self-contained (schema + data), restorable with pg_restore
    "--no-owner",
    ...APP_TABLES.flatMap((t) => ["-t", t]),
  ];

  const out = fs.openSync(outFile, "w");
  try {
    execFileSync("docker", args, { stdio: ["ignore", out, "inherit"] });
  } finally {
    fs.closeSync(out);
  }

  const { size } = fs.statSync(outFile);
  console.log(`Wrote ${outFile} (${(size / 1024).toFixed(0)} KiB)`);
}

main();
