/**
 * Runs pending migrations. Used locally and as the deploy init-container's
 * command, so exactly one process migrates and every app waits on it.
 *
 *   POSTGRES_URL=... npm run migrate --workspace=services/ingest
 *   POSTGRES_URL=... npm run migrate:revert --workspace=services/ingest
 */
import { createDataSource } from "../libs/database/src/data-source";

async function main(): Promise<void> {
  const revert = process.argv.includes("--revert");
  const dataSource = createDataSource();
  await dataSource.initialize();

  try {
    if (revert) {
      await dataSource.undoLastMigration();
      console.log("Reverted the last migration.");
      return;
    }

    const applied = await dataSource.runMigrations();
    if (applied.length === 0) {
      console.log("No pending migrations.");
      return;
    }
    for (const migration of applied) {
      console.log(`Applied ${migration.name}`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
