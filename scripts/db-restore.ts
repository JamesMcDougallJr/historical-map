// Restores a backup written by db-backup.ts into the local docker-compose
// Postgres. Safe to run against an empty, freshly-recreated container (the
// dump carries its own CREATE TABLE statements) or an existing one (--clean
// drops the app tables first so restore doesn't collide with rows already
// there).
//
//   npm run db:restore                       # restores the newest file in backups/
//   npm run db:restore -- backups/db-....dump
//
// Requires `docker compose up -d db` already running. After restoring,
// PostGIS's own schemas (tiger/topology) still need `CREATE EXTENSION postgis`,
// which the imresamu/postgis image already runs on container init — so this
// only ever needs to run on top of a container that has already booted once.
//
// On a *fresh* container, run `npm run db:ensure-schema` first. The dump is
// table-scoped, and the search columns on events/locations/event_groups are
// generated from the `hm_english`/`hm_simple` text search configurations and
// `immutable_unaccent()`, which live outside those tables — without them,
// pg_restore's CREATE TABLE fails on the generated column.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function newestBackup(dir: string): string {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".dump"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const newest = files[0];
  if (!newest) {
    throw new Error(`No .dump files in ${dir}`);
  }
  return path.join(dir, newest.f);
}

function main(): void {
  const arg = process.argv[2];
  const backupsDir = path.resolve("backups");
  const inFile = arg ? path.resolve(arg) : newestBackup(backupsDir);

  if (!fs.existsSync(inFile)) {
    throw new Error(`Backup file not found: ${inFile}`);
  }

  console.log(`Restoring ${inFile} ...`);

  const args = [
    "compose",
    "exec",
    "-T",
    "db",
    "pg_restore",
    "-U",
    "postgres",
    "-d",
    "db",
    "--clean",
    "--if-exists",
    "--no-owner",
  ];

  const input = fs.openSync(inFile, "r");
  try {
    execFileSync("docker", args, { stdio: [input, "inherit", "inherit"] });
  } finally {
    fs.closeSync(input);
  }

  console.log("Restore complete.");
}

main();
