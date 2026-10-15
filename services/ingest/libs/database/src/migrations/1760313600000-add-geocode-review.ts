import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Makes model-made geocoding decisions auditable and reversible.
 *
 * `geocode_cache` gains:
 * - `confidence` — how sure the deciding step was (Jev's own confidence for
 *   a context decision; null for the deterministic tiers, which either pass
 *   their checks or decline).
 * - `review_status` — `auto` until a person looks: `confirmed` pins it so no
 *   refresh changes it, `rejected` turns it into a miss so neither a refresh
 *   nor a new event can re-pin it.
 * - `decision` — what each tier said and what Jev picked, with the threshold
 *   in force, so a rejection can be judged against what was actually asked.
 *
 * `confidence_thresholds` holds one minimum per model-judged operation,
 * read at decision time so a threshold changes without a redeploy. Seeded
 * with the Jev context geocode at 0.8 — the same bar
 * `JEV_GEOCODE_MIN_CONFIDENCE` defaults to for Nominatim reranking.
 */
export class AddGeocodeReview1760313600000 implements MigrationInterface {
  name = "AddGeocodeReview1760313600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE geocode_cache
        ADD COLUMN IF NOT EXISTS confidence double precision,
        ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'auto',
        ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
        ADD COLUMN IF NOT EXISTS decision jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE geocode_cache
        ADD CONSTRAINT geocode_cache_review_status_check
        CHECK (review_status IN ('auto', 'confirmed', 'rejected'))
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS confidence_thresholds (
        operation      text PRIMARY KEY,
        min_confidence double precision NOT NULL
                       CHECK (min_confidence >= 0 AND min_confidence <= 1),
        description    text NOT NULL,
        updated_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO confidence_thresholds (operation, min_confidence, description)
      VALUES (
        'geocode.jev_context',
        0.8,
        'Minimum Jev confidence for a context-aware geocode to override the gazetteer tiers or place an event they could not.'
      )
      ON CONFLICT (operation) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS confidence_thresholds`);
    await queryRunner.query(`
      ALTER TABLE geocode_cache
        DROP CONSTRAINT IF EXISTS geocode_cache_review_status_check,
        DROP COLUMN IF EXISTS decision,
        DROP COLUMN IF EXISTS reviewed_at,
        DROP COLUMN IF EXISTS review_status,
        DROP COLUMN IF EXISTS confidence
    `);
  }
}
