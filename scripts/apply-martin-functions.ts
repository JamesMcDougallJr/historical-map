// Installs the Martin tile function source (db/martin-functions.sql).
//
// Split out of scripts/seed-db.ts: that file is a CLI entry point with an
// unconditional `main()` at module scope, and this helper needs to be
// importable (by scripts/reset-test-db.ts and e2e-real/fixtures/db.ts)
// without also running that main() — which an import.meta.url-based
// "only run if invoked directly" guard can't reliably prevent, because tsx
// transpiles a file differently depending on whether it's loaded as the
// entry script (ESM) or require()'d as an import (CJS, where `import.meta`
// is a syntax error) in this CommonJS-by-default repo.
import fs from "node:fs";
import path from "node:path";
import { execSql } from "../lib/postgres-storage";

export async function applyMartinFunctions(): Promise<void> {
  const file = path.resolve("db/martin-functions.sql");
  if (!fs.existsSync(file)) return;
  await execSql(fs.readFileSync(file, "utf-8"));
  console.log("Applied db/martin-functions.sql");
}
