import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the `ingest_*` tables, and adds the three `events` columns that
 * publishing needs.
 *
 * Written by hand rather than via `migration:generate`. Generated migrations
 * are a starting point, not an artifact to trust unread — and this one crosses
 * an ownership boundary (below), which no generator would get right.
 */
export class InitIngestSchema1757808000000 implements MigrationInterface {
  name = "InitIngestSchema1757808000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // gen_random_uuid() is core since Postgres 13; the image is postgis:17.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ingest_sources (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key           text NOT NULL UNIQUE,
        display_name  text NOT NULL,
        homepage_url  text,
        attribution   text,
        enabled       boolean NOT NULL DEFAULT true,
        poll_cron     text,
        lookback_days integer,
        metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ingest_documents (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id        uuid NOT NULL REFERENCES ingest_sources(id) ON DELETE CASCADE,
        external_id      text NOT NULL,
        url              text NOT NULL,
        title            text,
        published_at     timestamptz,
        etag             text,
        content_type     text,
        status           text NOT NULL DEFAULT 'discovered',
        extracted_text   text,
        fetch_attempts   integer NOT NULL DEFAULT 0,
        extract_attempts integer NOT NULL DEFAULT 0,
        publish_attempts integer NOT NULL DEFAULT 0,
        fetched_at       timestamptz,
        extracted_at     timestamptz,
        completed_at     timestamptz,
        error_message    text,
        metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
        detected_at      timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ingest_documents_status_check CHECK (status IN (
          'discovered','fetching','fetched','extracting','extracted',
          'published','skipped','failed'
        )),
        CONSTRAINT ingest_documents_fetch_attempts_check   CHECK (fetch_attempts   >= 0),
        CONSTRAINT ingest_documents_extract_attempts_check CHECK (extract_attempts >= 0),
        CONSTRAINT ingest_documents_publish_attempts_check CHECK (publish_attempts >= 0)
      )`);

    // The idempotency mechanism. Detection inserts ON CONFLICT DO NOTHING and
    // leans entirely on this — dropping it produces silent duplicate ingestion,
    // not a failing test.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ingest_documents_source_external_idx
        ON ingest_documents (source_id, external_id)`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ingest_documents_status_idx
        ON ingest_documents (status)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ingest_extractions (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
        model_run   uuid NOT NULL,
        model       text NOT NULL,
        chunk_index integer NOT NULL DEFAULT 0,
        chunk_count integer NOT NULL DEFAULT 1,
        events      jsonb NOT NULL,
        event_count integer NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);

    // The chunk-level checkpoint: a retried extraction skips indices already
    // present for its run.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ingest_extractions_run_chunk_idx
        ON ingest_extractions (document_id, model_run, chunk_index)`);

    // ── Deliberate boundary crossing ────────────────────────────────────────
    // `events` belongs to the web app's ensureSchema(), and TypeORM must never
    // migrate it. These three columns are the exception, for two reasons:
    // `document_id` is a foreign key *into* ingest_documents and so cannot be
    // created before this migration runs, and the other two exist solely to
    // serve ingestion. Every statement is IF NOT EXISTS, so this and
    // ensureSchema() can run in either order without conflicting.
    //
    // events.date stays `date NOT NULL` — a representative day is always
    // stored. date_precision records how much of it to believe, and date_text
    // preserves what the source actually said ("Spring 1847").
    await queryRunner.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS date_precision text`,
    );
    await queryRunner.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS date_text text`,
    );
    await queryRunner.query(`
      ALTER TABLE events ADD COLUMN IF NOT EXISTS document_id uuid
        REFERENCES ingest_documents(id) ON DELETE SET NULL`);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE events ADD CONSTRAINT events_date_precision_check
          CHECK (date_precision IS NULL OR date_precision IN
            ('day','month','season','year','decade','circa'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS events_document_id_idx ON events (document_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the events additions first — the FK depends on ingest_documents.
    await queryRunner.query(`DROP INDEX IF EXISTS events_document_id_idx`);
    await queryRunner.query(
      `ALTER TABLE events DROP CONSTRAINT IF EXISTS events_date_precision_check`,
    );
    await queryRunner.query(
      `ALTER TABLE events DROP COLUMN IF EXISTS document_id`,
    );
    await queryRunner.query(
      `ALTER TABLE events DROP COLUMN IF EXISTS date_text`,
    );
    await queryRunner.query(
      `ALTER TABLE events DROP COLUMN IF EXISTS date_precision`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS ingest_extractions`);
    await queryRunner.query(`DROP TABLE IF EXISTS ingest_documents`);
    await queryRunner.query(`DROP TABLE IF EXISTS ingest_sources`);
  }
}
