import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { DiscoveredDocument, SourceAdapter } from "@historical-map/domain";

/** Extensions a parser exists for. Anything else is ignored, not failed. */
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
]);

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
};

/** Skip VCS and OS cruft rather than trying to parse it. */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".svn",
  "node_modules",
  "__MACOSX",
]);

/**
 * Reads a directory of documents off local disk — the first source, and the one
 * that gets the pipeline working end to end without depending on anyone else's
 * uptime.
 *
 * It satisfies `SourceAdapter` with no changes to the interface, which is the
 * point: a remote archive adapter added later differs only in how it enumerates
 * documents, and reuses the same parsers, the same `fetch` worker and the same
 * queue contracts.
 *
 * Note what this adapter does **not** need, all of which a remote one will:
 * SSRF guards, a redirect policy, `If-None-Match`, and politeness throttling.
 * Building those now would be dead code with no source to exercise them.
 */
export class LocalDirectoryAdapter implements SourceAdapter {
  readonly key: string;
  readonly metadata: SourceAdapter["metadata"];

  constructor(
    private readonly rootDir: string,
    options: { key?: string; displayName?: string; attribution?: string } = {},
  ) {
    this.key = options.key ?? "local-directory";
    this.metadata = {
      displayName: options.displayName ?? "Local corpus",
      attribution: options.attribution ?? "Local document corpus",
      rootDir,
    };
  }

  /**
   * `knownExternalIds` is only a narrowing hint, and this adapter deliberately
   * ignores it: a local scan is cheap, and returning already-known documents is
   * how an *edited* file gets noticed — the hash below is what actually decides
   * whether there is new work. Idempotency is the database's unique index on
   * (source_id, external_id), never this set.
   */
  async fetchAvailableDocuments(
    _knownExternalIds: Set<string>,
  ): Promise<DiscoveredDocument[]> {
    const root = resolve(this.rootDir);
    const files = await walk(root);
    const documents: DiscoveredDocument[] = [];

    for (const absolutePath of files) {
      const extension = extname(absolutePath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) continue;

      const [bytes, stats] = await Promise.all([
        readFile(absolutePath),
        stat(absolutePath),
      ]);

      documents.push({
        // Relative path: stable across machines and readable in a queue
        // dashboard, unlike a hash or an absolute path.
        externalId: relative(root, absolutePath).split(sep).join("/"),
        url: pathToFileURL(absolutePath).href,
        title: relative(root, absolutePath).split(sep).join("/"),
        // The local stand-in for an HTTP ETag. Editing a file changes this,
        // which is exactly the "has this changed?" signal `fetch` already uses
        // to decide whether to re-parse.
        etag: sha256(bytes),
        contentType: CONTENT_TYPES[extension],
        publishedAt: stats.mtime,
        metadata: { sizeBytes: stats.size },
      });
    }

    return documents;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing corpus directory is a configuration state, not a crash — the
      // detect worker logs and skips rather than failing the job.
      return [];
    }
    throw error;
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await walk(full)));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found.sort();
}
