/**
 * (Re)builds `document_passages` + `passage_events` from stored text
 * artifacts — the search index over source documents.
 *
 *   npm run search:backfill-passages --workspace=services/ingest
 *   npm run search:backfill-passages --workspace=services/ingest -- --force
 *   npm run search:backfill-passages --workspace=services/ingest -- --document <uuid>
 *
 * Handles both "never indexed" (documents extracted before passages existed)
 * and "indexed by an older splitter or cleaning". Reads only object storage
 * and Postgres: no fetch, no re-cleaning, no extraction call. `--force`
 * re-cuts every document regardless of version.
 *
 * Needs POSTGRES_URL and the S3_* variables, same as the workers.
 */
import type { ConfigService } from "@nestjs/config";
import { createDataSource } from "../libs/database/src/data-source";
import {
  parseArtifact,
  passagesStale,
  replacePassages,
} from "../libs/parsers/src";
import { S3StorageService } from "../libs/storage/src/s3-storage.service";

function envConfig(): ConfigService {
  const get = (key: string) => process.env[key];
  return {
    get,
    getOrThrow: (key: string) => {
      const value = get(key);
      if (value === undefined) throw new Error(`${key} is not set`);
      return value;
    },
  } as unknown as ConfigService;
}

export async function backfillPassages(opts: {
  force?: boolean;
  documentId?: string;
}): Promise<{ indexed: number; skipped: number; passages: number }> {
  const dataSource = createDataSource();
  await dataSource.initialize();
  const storage = new S3StorageService(envConfig());
  try {
    const documents = (await dataSource.query(
      `SELECT id, text_key, text_extractor_version FROM ingest_documents
        WHERE text_key IS NOT NULL ${opts.documentId ? "AND id = $1" : ""}
        ORDER BY id`,
      opts.documentId ? [opts.documentId] : [],
    )) as Array<{
      id: string;
      text_key: string;
      text_extractor_version: number;
    }>;

    let indexed = 0;
    let skipped = 0;
    let passages = 0;
    for (const doc of documents) {
      if (
        !opts.force &&
        !(await passagesStale(dataSource, doc.id, doc.text_extractor_version))
      ) {
        skipped++;
        continue;
      }
      const artifact = parseArtifact(await storage.getObject(doc.text_key));
      const count = await replacePassages(
        dataSource,
        doc.id,
        artifact.segments,
        artifact.extractorVersion,
      );
      console.log(`${doc.id}: ${count} passages`);
      indexed++;
      passages += count;
    }
    return { indexed, skipped, passages };
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const docIdx = args.indexOf("--document");
  backfillPassages({
    force: args.includes("--force"),
    ...(docIdx >= 0 && args[docIdx + 1]
      ? { documentId: args[docIdx + 1] }
      : {}),
  })
    .then((r) => {
      console.log(
        `indexed ${r.indexed} document(s), ${r.passages} passages; ${r.skipped} already current`,
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
