import type { MigrationInterface, QueryRunner } from "typeorm";

/** Geocode cache and review queue — everything `publish` needs. */
export class AddPublishTables1757894400000 implements MigrationInterface {
  name = "AddPublishTables1757894400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS geocode_cache (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        normalized_name text NOT NULL UNIQUE,
        raw_name        text NOT NULL,
        lon             double precision,
        lat             double precision,
        found           boolean NOT NULL DEFAULT false,
        provider        text,
        display_name    text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        -- A hit must carry coordinates; a miss must not pretend to.
        CONSTRAINT geocode_cache_found_has_coords CHECK (
          (found = false) OR (lon IS NOT NULL AND lat IS NOT NULL)
        )
      )`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ingest_review_items (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
        event_key   text NOT NULL UNIQUE,
        reason      text NOT NULL,
        detail      text,
        event       jsonb NOT NULL,
        resolved_at timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ingest_review_items_reason_check CHECK (reason IN (
          'low_confidence','no_date','geocode_failed','possible_duplicate'
        ))
      )`);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ingest_review_items_document_idx
        ON ingest_review_items (document_id)`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ingest_review_items_reason_idx
        ON ingest_review_items (reason)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ingest_review_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS geocode_cache`);
  }
}
