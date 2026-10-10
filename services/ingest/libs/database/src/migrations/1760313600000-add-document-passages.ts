import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Source documents' text, in Postgres, one row per paragraph — so search can
 * find which paragraph of which book matched (plans/20-search-lexical.md).
 *
 * A derived, disposable index, not a second copy of the truth: object storage
 * still owns the text, and every row here is rebuilt from the stored artifact
 * by `extract-text` or `search:backfill-passages` with no network fetch.
 *
 * `search_tsv` uses the web app's `hm_english` text search configuration
 * (accent-folding, stemmed), so passages and events tokenize identically.
 * The web app's ensureSchema() normally creates it first; it is created here
 * too when missing, so this migration doesn't depend on the order the two
 * schema owners ran in.
 */
export class AddDocumentPassages1760313600000 implements MigrationInterface {
  name = "AddDocumentPassages1760313600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'hm_english') THEN
          CREATE TEXT SEARCH CONFIGURATION hm_english (COPY = english);
          ALTER TEXT SEARCH CONFIGURATION hm_english
            ALTER MAPPING FOR hword, hword_part, word WITH unaccent, english_stem;
        END IF;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
      END $$`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS document_passages (
        document_id       uuid NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
        seq               int  NOT NULL,
        segment_anchor    text,
        para_index        int  NOT NULL,
        anchor            text NOT NULL,
        text              text NOT NULL,
        extractor_version int  NOT NULL,
        splitter_version  int  NOT NULL,
        search_tsv        tsvector GENERATED ALWAYS AS (to_tsvector('hm_english', text)) STORED,
        PRIMARY KEY (document_id, seq)
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS document_passages_tsv_idx ON document_passages USING GIN (search_tsv)`,
    );

    // Which published events were quoted from which paragraph. Written by
    // publish (and re-derived on every re-split), read by the web app's search.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS passage_events (
        document_id uuid NOT NULL,
        seq         int  NOT NULL,
        event_id    text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        PRIMARY KEY (document_id, seq, event_id),
        FOREIGN KEY (document_id, seq)
          REFERENCES document_passages (document_id, seq) ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS passage_events_event_idx ON passage_events (event_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS passage_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS document_passages`);
  }
}
