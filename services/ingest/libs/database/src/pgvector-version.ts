import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RELATIVE_PATH = join("db", "pgvector-version");

/**
 * The pgvector version every database must run, read from
 * `db/pgvector-version` at the repo root — the one source of truth shared with
 * the local image (db/Dockerfile) and CI's check.
 *
 * Found by walking up from this file rather than by a fixed relative path, so
 * it resolves both in the checkout (`tsx scripts/migrate.ts`) and in the
 * deploy migrate container, which copies the file to the same place relative
 * to `services/ingest`. Only called at migration time: bundled workers import
 * the migrations but never run them, and have no such file.
 */
export function pinnedPgvectorVersion(start = __dirname): string {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, RELATIVE_PATH);
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8").trim();
    }
    if (dirname(dir) === dir) {
      throw new Error(
        `${RELATIVE_PATH} not found above ${start}. It pins the pgvector ` +
          "version the database must run; the migrate container must copy it.",
      );
    }
  }
}
