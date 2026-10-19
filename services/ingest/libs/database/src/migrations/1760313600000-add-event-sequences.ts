import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Raw proposals from `extract-events`'s once-per-document sequence-proposal
 * call (see `ExtractionEngine.proposeSequences`) — one row per sequence the
 * model identified, keyed by extraction-time event ids. `publish` resolves
 * these into the web app's `event_groups`/`event_group_members` tables, which
 * this migration does not touch (they belong to `ensureSchema()`, not to
 * ingest — see `map-writer.service.ts`).
 */
export class AddEventSequences1760313600000 implements MigrationInterface {
  name = "AddEventSequences1760313600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ingest_event_sequences (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id      uuid NOT NULL REFERENCES ingest_documents(id) ON DELETE CASCADE,
        model_run        uuid NOT NULL,
        title            text NOT NULL,
        description      text,
        member_event_ids jsonb NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX ingest_event_sequences_document_id_idx ON ingest_event_sequences (document_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ingest_event_sequences`);
  }
}
