import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Splits text extraction out of `fetch`, moves text into object storage, and
 * replaces the review table with validated candidates.
 *
 * `extracted_text` is dropped rather than kept in sync. Object storage is
 * authoritative for the text; a Postgres copy would be a second place the same
 * artifact could be wrong, and re-extraction would have to update both.
 */
export class SplitTextExtraction1757980800000 implements MigrationInterface {
  name = "SplitTextExtraction1757980800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Pointers and stats replacing the inline text ────────────────────────
    for (const [column, type] of [
      ["original_key", "text"],
      ["text_key", "text"],
      ["text_extractor_version", "integer"],
      ["text_chars", "integer"],
      ["text_segments", "integer"],
      ["text_ready_at", "timestamptz"],
      ["validated_at", "timestamptz"],
    ]) {
      await queryRunner.query(
        `ALTER TABLE ingest_documents ADD COLUMN IF NOT EXISTS ${column} ${type}`,
      );
    }
    for (const column of ["text_attempts", "validate_attempts"]) {
      await queryRunner.query(
        `ALTER TABLE ingest_documents ADD COLUMN IF NOT EXISTS ${column} integer NOT NULL DEFAULT 0`,
      );
      await queryRunner.query(`
        DO $$ BEGIN
          ALTER TABLE ingest_documents ADD CONSTRAINT ingest_documents_${column}_check
            CHECK (${column} >= 0);
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }

    await queryRunner.query(
      `ALTER TABLE ingest_documents DROP COLUMN IF EXISTS extracted_text`,
    );

    // ── Wider status vocabulary for the two new stages ──────────────────────
    await queryRunner.query(
      `ALTER TABLE ingest_documents DROP CONSTRAINT IF EXISTS ingest_documents_status_check`,
    );
    await queryRunner.query(`
      ALTER TABLE ingest_documents ADD CONSTRAINT ingest_documents_status_check
        CHECK (status IN (
          'discovered','fetching','fetched',
          'extracting_text','text_ready',
          'extracting_events','events_ready',
          'validating','validated',
          'published','skipped','failed'
        ))`);

    // Any document mid-pipeline under the old vocabulary goes back to
    // `discovered`. Cheaper and safer than mapping old states onto new ones —
    // re-running detection is idempotent and costs nothing.
    await queryRunner.query(`
      UPDATE ingest_documents SET status = 'discovered'
      WHERE status NOT IN ('discovered','published','skipped','failed')`);

    // ── Candidates replace review items ────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ingest_event_candidates (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id  uuid NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
        model_run    uuid NOT NULL,
        event_key    text NOT NULL UNIQUE,
        verdict      text NOT NULL,
        checks       jsonb NOT NULL DEFAULT '[]'::jsonb,
        event        jsonb NOT NULL,
        resolved_at  timestamptz,
        published_at timestamptz,
        created_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ingest_event_candidates_verdict_check
          CHECK (verdict IN ('publish','review'))
      )`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ingest_event_candidates_document_idx
        ON ingest_event_candidates (document_id)`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ingest_event_candidates_verdict_idx
        ON ingest_event_candidates (verdict)`);

    await queryRunner.query(`DROP TABLE IF EXISTS ingest_review_items`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ingest_review_items (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
        event_key   text NOT NULL UNIQUE,
        reason      text NOT NULL,
        detail      text,
        event       jsonb NOT NULL,
        resolved_at timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`DROP TABLE IF EXISTS ingest_event_candidates`);

    await queryRunner.query(
      `ALTER TABLE ingest_documents ADD COLUMN IF NOT EXISTS extracted_text text`,
    );
    await queryRunner.query(
      `ALTER TABLE ingest_documents DROP CONSTRAINT IF EXISTS ingest_documents_status_check`,
    );
    await queryRunner.query(`
      UPDATE ingest_documents SET status = 'discovered'
      WHERE status NOT IN ('discovered','published','skipped','failed')`);
    await queryRunner.query(`
      ALTER TABLE ingest_documents ADD CONSTRAINT ingest_documents_status_check
        CHECK (status IN (
          'discovered','fetching','fetched','extracting','extracted',
          'published','skipped','failed'
        ))`);

    for (const column of [
      "original_key",
      "text_key",
      "text_extractor_version",
      "text_chars",
      "text_segments",
      "text_ready_at",
      "validated_at",
      "text_attempts",
      "validate_attempts",
    ]) {
      await queryRunner.query(
        `ALTER TABLE ingest_documents DROP COLUMN IF EXISTS ${column}`,
      );
    }
  }
}
