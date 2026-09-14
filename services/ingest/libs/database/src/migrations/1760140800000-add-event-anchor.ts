import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Records which segment of the source document an event came from.
 *
 * The text artifact carries page anchors (`"p.43"`) all the way to
 * `extract-events` — `chunkSegments` puts them on every `ExtractionChunk` —
 * and then drops them: `ExtractedEvent` had nowhere to keep one, so `publish`
 * had nothing to write. The page was known and discarded at the last step,
 * which is exactly what made "view source" impossible to build.
 */
export class AddEventAnchor1760140800000 implements MigrationInterface {
  name = "AddEventAnchor1760140800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS anchor text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE events DROP COLUMN IF EXISTS anchor`);
  }
}
