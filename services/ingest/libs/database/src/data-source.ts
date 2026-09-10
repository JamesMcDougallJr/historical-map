import { DataSource } from "typeorm";
import { INGEST_ENTITIES } from "./entities";
import { INGEST_MIGRATIONS } from "./migrations";

/**
 * Standalone DataSource for running migrations outside the Nest DI container
 * (the `migrate` script, and the deploy init-container).
 *
 * Kept deliberately free of `@app/*` path aliases so it can be executed
 * directly with `tsx` — no ts-node, no TypeORM CLI datasource discovery, no
 * second module-resolution scheme to keep working.
 */
export function createDataSource(
  url = process.env["POSTGRES_URL"],
): DataSource {
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. Migrations must target the same database the " +
        "web app reads — a worker pointed elsewhere ingests into a void.",
    );
  }

  return new DataSource({
    type: "postgres",
    url,
    entities: INGEST_ENTITIES,
    migrations: INGEST_MIGRATIONS,
    // Never true, in any environment. It silently drops columns to make the
    // database match the entities — and this database also holds the map
    // tables, which these entities do not describe at all.
    synchronize: false,
    migrationsTableName: "ingest_migrations",
  });
}
