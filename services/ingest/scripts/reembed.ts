/**
 * One pass of the embedding sweep the `embed` worker runs on a timer
 * (plans/23-search-semantic.md, "Staleness"): re-embeds every event and
 * sequence whose stored vector is missing, stale, or from another model.
 *
 *   POSTGRES_URL=... BEDROCK_REGION=us-west-2 npm run search:reembed --workspace=services/ingest
 *   POSTGRES_URL=... EMBEDDING_ENGINE=fake    npm run search:reembed --workspace=services/ingest
 *
 * Safe to run any time, and as often as you like: an unchanged corpus makes no
 * Bedrock call at all.
 */
import { createDataSource } from "../libs/database/src/data-source";
import {
  embeddingEngineFromEnv,
  runEmbeddingSweep,
} from "../libs/embedding/src";

async function main(): Promise<void> {
  const engine = embeddingEngineFromEnv();
  const dataSource = createDataSource();
  await dataSource.initialize();
  try {
    const { events, groups } = await runEmbeddingSweep(dataSource, engine);
    console.log(
      `${engine.engineName} (${engine.model}, ${engine.dims} dims): ` +
        `embedded ${events.embedded}/${events.checked} events, ` +
        `${groups.embedded}/${groups.checked} sequences`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
