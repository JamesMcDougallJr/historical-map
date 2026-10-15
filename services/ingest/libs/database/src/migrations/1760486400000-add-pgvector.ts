import type { MigrationInterface, QueryRunner } from "typeorm";
import { pinnedPgvectorVersion } from "../pgvector-version";

/**
 * Enables pgvector, and refuses any database whose pgvector isn't exactly the
 * version in `db/pgvector-version` (plans/23-search-semantic.md).
 *
 * Production is RDS, where the extension version is whatever the RDS minor
 * ships (16.4 → 0.6.2; 16.15 → 0.8.2). Filtered vector search needs 0.8's
 * iterative index scans, so deploying against an RDS that hasn't taken its
 * maintenance-window upgrade yet must be a red migrate — not a database that
 * silently has an older pgvector than local dev and CI tested against.
 *
 * The check runs after `CREATE EXTENSION` so it also catches a database where
 * the extension was already installed at another version. TypeORM runs each
 * migration in a transaction, so a failed check rolls the extension back too.
 */
export class AddPgvector1760486400000 implements MigrationInterface {
  name = "AddPgvector1760486400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const pinned = pinnedPgvectorVersion();

    const available: { default_version: string }[] = await queryRunner.query(
      `SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`,
    );
    if (available.length === 0) {
      throw new Error(
        `pgvector is not installed on this server; db/pgvector-version requires ${pinned}. ` +
          "Locally: `docker compose build db && docker compose up -d db`.",
      );
    }

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    const [{ extversion }]: { extversion: string }[] = await queryRunner.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    if (extversion !== pinned) {
      throw new Error(
        `pgvector is ${extversion} on this database, but db/pgvector-version pins ${pinned} ` +
          `(server default: ${available[0].default_version}). On RDS, the engine's minor ` +
          "version decides pgvector's — wait for the pending upgrade, or `ALTER EXTENSION " +
          "vector UPDATE` once the server offers the pinned version.",
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP EXTENSION IF EXISTS vector`);
  }
}
