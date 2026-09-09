// Loads the single-file MCP App bundle produced by `npm run build:mcp`.
//
// Two callers with different working directories: the stdio server (spawned by
// Claude Desktop, where CWD is arbitrary) and the Next.js route handler (where
// CWD is the app root but `import.meta.url` points into the bundled output).
// Try both roots rather than guessing.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_RELATIVE = path.join("mcp", "dist", "mcp-app.html");

function candidatePaths(): string[] {
  const paths = [path.join(process.cwd(), BUNDLE_RELATIVE)];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    paths.push(path.join(here, "dist", "mcp-app.html"));
    paths.push(path.join(here, "..", BUNDLE_RELATIVE));
  } catch {
    // import.meta.url unavailable (CJS interop) — CWD candidate stands alone
  }
  return paths;
}

let cached: string | null = null;

export async function loadAppHtml(): Promise<string> {
  if (cached !== null) return cached;

  const tried = candidatePaths();
  for (const p of tried) {
    try {
      cached = await fs.readFile(p, "utf-8");
      return cached;
    } catch {
      continue;
    }
  }

  throw new Error(
    `MCP App bundle not found. Run \`npm run build:mcp\`. Looked in:\n  ${tried.join("\n  ")}`,
  );
}
