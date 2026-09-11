/**
 * Upserts the source rows the adapters expect, on their natural key.
 *
 *   POSTGRES_URL=... npm run seed:sources --workspace=services/ingest
 *
 * Idempotent — re-running updates the descriptive fields and leaves `enabled`
 * and any documents alone.
 */
import { createDataSource } from "../libs/database/src/data-source";
import { IngestSource } from "../libs/database/src/entities";

const SOURCES: Array<Partial<IngestSource> & { key: string }> = [
  {
    key: "local-directory",
    displayName: "Local corpus",
    attribution: "Local document corpus",
    enabled: true,
    // Null means *no lookback filter*, not "use the global default". Every
    // file in a local corpus has an mtime of today regardless of whether the
    // book is about 1847, so a window would filter out the whole corpus.
    lookbackDays: null,
    pollCron: null,
  },
];

async function main(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();

  try {
    const repo = dataSource.getRepository(IngestSource);
    for (const source of SOURCES) {
      const existing = await repo.findOne({ where: { key: source.key } });
      if (existing) {
        await repo.update(existing.id, {
          displayName: source.displayName,
          attribution: source.attribution,
        });
        console.log(`updated  ${source.key} (${existing.id})`);
      } else {
        const created = await repo.save(repo.create(source));
        console.log(`created  ${source.key} (${created.id})`);
      }
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
