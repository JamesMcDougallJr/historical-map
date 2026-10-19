import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * pgvector 0.8.0 is the first version with iterative index scans, which
 * filtered vector search needs once there's an index (plans/23-search-semantic.md).
 */
export const MIN_PGVECTOR_VERSION = "0.8.0";

/** Numeric dotted-version comparison: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Enables pgvector, and refuses any database whose pgvector is older than
 * MIN_PGVECTOR_VERSION.
 *
 * A minimum rather than an exact pin: hosted Postgres decides its own
 * pgvector minor (Neon, which backs the preview database, ships 0.8.x; RDS
 * 16.4 shipped 0.6.2). What must never happen is a database silently older
 * than 0.8 — that is a red migrate. The exact version local dev and CI test
 * against is still pinned by `db/pgvector-version`, which db/Dockerfile builds
 * and CI checks.
 *
 * The check runs after `CREATE EXTENSION` so it also catches a database where
 * the extension was already installed at an older version. TypeORM runs each
 * migration in a transaction, so a failed check rolls the extension back too.
 */
export class AddPgvector1760486400000 implements MigrationInterface {
  name = "AddPgvector1760486400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const available: { default_version: string }[] = await queryRunner.query(
      `SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`,
    );
    if (available.length === 0) {
      throw new Error(
        `pgvector is not installed on this server; ${MIN_PGVECTOR_VERSION} or newer is required. ` +
          "Locally: `docker compose build db && docker compose up -d db`.",
      );
    }

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    const [{ extversion }]: { extversion: string }[] = await queryRunner.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    if (compareVersions(extversion, MIN_PGVECTOR_VERSION) < 0) {
      throw new Error(
        `pgvector is ${extversion} on this database; ${MIN_PGVECTOR_VERSION} or newer is ` +
          `required (server default: ${available[0].default_version}). On RDS the engine's ` +
          "minor version decides pgvector's — upgrade the engine, then `ALTER EXTENSION vector UPDATE`.",
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP EXTENSION IF EXISTS vector`);
  }
}
