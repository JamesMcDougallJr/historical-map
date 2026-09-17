import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Both geocoders now report every candidate tied for the top confidence
 * score, not just the one auto-picked (see `GeocodeHit.alternates`) — a
 * human review tool needs to know a pick was ambiguous, and that can only be
 * answered if the ties survive past the request that found them. Nullable
 * because most places resolve unambiguously and have nothing to store here.
 */
export class AddGeocodeCandidates1760227200000 implements MigrationInterface {
  name = "AddGeocodeCandidates1760227200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE geocode_cache ADD COLUMN IF NOT EXISTS candidates jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE geocode_cache DROP COLUMN IF EXISTS candidates`,
    );
  }
}
