import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * One vector per paragraph, on the row itself (plans/23-search-semantic.md,
 * "What gets embedded"): the passage embedding serves both the passage kind
 * and the document roll-up.
 *
 * No `content_hash` here, unlike events: a passage's text never changes in
 * place. Re-cutting (a `SPLITTER_VERSION` or `EXTRACTOR_VERSION` bump) deletes
 * a document's rows and inserts new ones, which arrive with a NULL embedding —
 * so "needs embedding" is exactly `embedding IS NULL`, plus rows from another
 * model.
 */
export class AddPassageEmbeddings1760659200000 implements MigrationInterface {
  name = "AddPassageEmbeddings1760659200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE document_passages ADD COLUMN IF NOT EXISTS embedding vector(256)`,
    );
    await queryRunner.query(
      `ALTER TABLE document_passages ADD COLUMN IF NOT EXISTS embedding_model text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE document_passages DROP COLUMN IF EXISTS embedding_model`,
    );
    await queryRunner.query(
      `ALTER TABLE document_passages DROP COLUMN IF EXISTS embedding`,
    );
  }
}
