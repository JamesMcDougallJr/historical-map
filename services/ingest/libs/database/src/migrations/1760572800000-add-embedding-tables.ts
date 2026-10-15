import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Vectors for published events and for sequences (plans/23-search-semantic.md,
 * "What gets embedded"; plan 12's schema sketch). Written only by the `embed`
 * worker's sweep, read by the web app's hybrid search.
 *
 * Keyed on the map tables' ids, with `ON DELETE CASCADE`, so a deleted event
 * or group never leaves a vector that search could still rank. Plan 12
 * sketched `event_key`; published events are what search returns, and their
 * id is `events.id`.
 *
 * - `model`/`dims` on every row: comparing vectors across models is
 *   meaningless, and a column naming the model is what makes a model change a
 *   re-embed of stale rows rather than a wipe.
 * - `content_hash`: sha256 of `source_text`, the exact composed text. An edit
 *   in the admin app changes the composed text, the hash stops matching, and
 *   the sweep re-embeds that row only.
 * - `vector(256)`: Titan v2 at 256 dims (plan 12). A different size is a new
 *   migration, deliberately — it invalidates every stored vector anyway.
 *
 * No vector index: at this corpus size an exact scan is faster than any index
 * and nothing is being tuned (plan 23, row 11).
 */
export class AddEmbeddingTables1760572800000 implements MigrationInterface {
  name = "AddEmbeddingTables1760572800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS event_embeddings (
        event_id     text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        embedding    vector(256) NOT NULL,
        model        text NOT NULL,
        dims         int  NOT NULL,
        content_hash text NOT NULL,
        source_text  text NOT NULL,
        embedded_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS event_group_embeddings (
        group_id     text PRIMARY KEY REFERENCES event_groups(id) ON DELETE CASCADE,
        embedding    vector(256) NOT NULL,
        model        text NOT NULL,
        dims         int  NOT NULL,
        content_hash text NOT NULL,
        source_text  text NOT NULL,
        embedded_at  timestamptz NOT NULL DEFAULT now()
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS event_group_embeddings`);
    await queryRunner.query(`DROP TABLE IF EXISTS event_embeddings`);
  }
}
