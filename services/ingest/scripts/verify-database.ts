/**
 * Proves the schema actually enforces the claims the pipeline rests on.
 *
 * Everything runs inside one transaction that is always rolled back, so it is
 * safe against a database with real data in it.
 *
 *   POSTGRES_URL=... npm run db:verify --workspace=services/ingest
 */
import { DOCUMENT_STATUSES } from "@historical-map/domain";
import type { QueryRunner } from "typeorm";
import { createDataSource } from "../libs/database/src/data-source";
import { IngestDocument, IngestSource } from "../libs/database/src/entities";
import {
  JEV_CONTEXT_GEOCODE,
  getConfidenceThreshold,
  listGeocodeReviews,
  reviewGeocode,
  setConfidenceThreshold,
} from "../libs/database/src/geocodes";
import { normalizePlaceName } from "../libs/geocoding/src/geocoder.interface";
import { relocatePublishedPins } from "../libs/geocoding/src/relocate";

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/**
 * Runs `work`, expecting it to fail with `sqlState`.
 *
 * The savepoint is load-bearing, not defensive: in Postgres a failed statement
 * aborts the entire transaction, and every later command returns "current
 * transaction is aborted" until it unwinds. Since this script's whole job is to
 * trigger constraint violations deliberately, each one has to be rolled back to
 * a savepoint or only the first check could ever run.
 */
async function expectViolation(
  runner: QueryRunner,
  sqlState: string,
  work: () => Promise<unknown>,
): Promise<boolean> {
  const savepoint = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await runner.query(`SAVEPOINT ${savepoint}`);
  try {
    await work();
    await runner.query(`RELEASE SAVEPOINT ${savepoint}`);
    return false; // no error raised — the constraint is not doing its job
  } catch (error) {
    await runner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    return (error as { code?: string }).code === sqlState;
  }
}

async function main(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();

  const checks: Array<[string, boolean]> = [];

  try {
    const source = await runner.manager.save(
      runner.manager.create(IngestSource, {
        key: `verify-${Date.now()}`,
        displayName: "Verification source",
      }),
    );

    const doc = {
      sourceId: source.id,
      externalId: "doc-1",
      url: "https://example.invalid/doc-1",
    };
    const savedDoc = await runner.manager.save(
      runner.manager.create(IngestDocument, doc),
    );

    // 1. The idempotency mechanism: a second (source_id, external_id) is
    //    rejected by the database, not by application control flow.
    checks.push([
      "duplicate (source_id, external_id) rejected",
      await expectViolation(runner, UNIQUE_VIOLATION, () =>
        runner.manager.save(runner.manager.create(IngestDocument, doc)),
      ),
    ]);

    // 2. ON CONFLICT DO NOTHING is therefore a safe re-insert, and reports that
    //    nothing landed — which is what detection relies on to avoid
    //    re-enqueueing the entire back catalogue on every pass.
    const conflictResult: unknown[] = await runner.query(
      `INSERT INTO ingest_documents (source_id, external_id, url)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [doc.sourceId, doc.externalId, doc.url],
    );
    checks.push([
      "ON CONFLICT DO NOTHING returns no rows",
      conflictResult.length === 0,
    ]);

    // 3. The status CHECK actually constrains the state machine.
    checks.push([
      "invalid status rejected",
      await expectViolation(runner, CHECK_VIOLATION, () =>
        runner.query(
          `UPDATE ingest_documents SET status = 'not-a-real-status' WHERE source_id = $1`,
          [source.id],
        ),
      ),
    ]);

    // 4. Every status the domain defines is actually accepted — the CHECK and
    //    the DocumentStatus union must not drift apart.
    //    Iterating the domain's own array is the point: a hand-written copy
    //    here silently passed for two renames, asserting nothing.
    let allStatusesAccepted = true;
    for (const status of DOCUMENT_STATUSES) {
      const ok = !(await expectViolation(runner, CHECK_VIOLATION, () =>
        runner.query(
          `UPDATE ingest_documents SET status = $1 WHERE source_id = $2`,
          [status, source.id],
        ),
      ));
      if (!ok) allStatusesAccepted = false;
    }
    checks.push([
      "every DocumentStatus accepted by CHECK",
      allStatusesAccepted,
    ]);

    // 5. Negative attempt counters are rejected.
    checks.push([
      "negative attempt counter rejected",
      await expectViolation(runner, CHECK_VIOLATION, () =>
        runner.query(
          `UPDATE ingest_documents SET fetch_attempts = -1 WHERE source_id = $1`,
          [source.id],
        ),
      ),
    ]);

    // 6. The columns publishing needs exist on the map's `events` table.
    const [eventCols] = (await runner.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'events'
         AND column_name IN ('date_precision','date_text','document_id')`,
    )) as [{ n: number }];
    checks.push([
      "events has date_precision/date_text/document_id",
      eventCols.n === 3,
    ]);

    // 7. The map tables are untouched by these entities — this connection must
    //    never be able to migrate `events`, `locations`, or `sources`.
    const ownedTables: Array<{ table_name: string }> = await runner.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('events','locations','sources')`,
    );
    checks.push([
      "map tables still exist (not clobbered by synchronize)",
      ownedTables.length === 3,
    ]);

    // 8. Correcting a geocode moves the pins it placed — and only those. A pin
    //    merely *near* the old spot belongs to some other place.
    if (ownedTables.length === 3) {
      const old = { lon: 0.123456, lat: -0.654321 };
      await runner.query(
        `INSERT INTO locations (id, name, lon, lat) VALUES
           ('vfy-exact', 'Exact', $1, $2),
           ('vfy-near', 'Near', $3, $2)`,
        [old.lon, old.lat, old.lon + 0.001],
      );
      const moved = await relocatePublishedPins(runner, old, {
        lon: 10.5,
        lat: 20.5,
      });
      const after: Array<{ id: string; lon: number }> = await runner.query(
        `SELECT id, lon FROM locations WHERE id IN ('vfy-exact','vfy-near')`,
      );
      const lonOf = (id: string): number | undefined =>
        after.find((r) => r.id === id)?.lon;
      checks.push([
        "relocatePublishedPins moves the exact-match pin and leaves a near one",
        moved.length === 1 &&
          moved[0]?.id === "vfy-exact" &&
          lonOf("vfy-exact") === 10.5 &&
          lonOf("vfy-near") === old.lon + 0.001,
      ]);

      // 9. A geocode's review status is a closed set, like a document's.
      checks.push([
        "geocode_cache.review_status CHECK rejects an unknown status",
        await expectViolation(runner, CHECK_VIOLATION, () =>
          runner.query(
            `INSERT INTO geocode_cache (normalized_name, raw_name, review_status)
             VALUES ('vfy status', 'Vfy Status', 'maybe')`,
          ),
        ),
      ]);

      // 10. The context-geocode threshold lives in the database, seeded at
      //     0.8, changeable without a deploy, and bounded to a probability.
      const seeded = await getConfidenceThreshold(runner, JEV_CONTEXT_GEOCODE, -1);
      const set = await setConfidenceThreshold(runner, JEV_CONTEXT_GEOCODE, 0.65);
      const after10 = await getConfidenceThreshold(runner, JEV_CONTEXT_GEOCODE, -1);
      const outOfRange = await setConfidenceThreshold(runner, JEV_CONTEXT_GEOCODE, 1.5);
      checks.push([
        "confidence_thresholds: seeded at 0.8, settable, refuses values outside 0–1",
        seeded === 0.8 && set.ok && after10 === 0.65 && !outOfRange.ok,
      ]);
      checks.push([
        "confidence_thresholds CHECK rejects a minimum above 1 written directly",
        await expectViolation(runner, CHECK_VIOLATION, () =>
          runner.query(
            `UPDATE confidence_thresholds SET min_confidence = 2 WHERE operation = $1`,
            [JEV_CONTEXT_GEOCODE],
          ),
        ),
      ]);

      // 11. Rejecting a geocode takes its published events off the map and
      //     back to review, removes the emptied pin, and makes the place a
      //     miss nothing re-pins.
      await runner.query(
        `INSERT INTO locations (id, name, lon, lat) VALUES ('vfy-reject', 'Vfy Place', 5, 5)`,
      );
      await runner.query(
        `INSERT INTO events (id, location_id, title, date, description)
         VALUES ('vfy-reject-ev', 'vfy-reject', 'Vfy event', '1531-12-09', 'x')`,
      );
      await runner.query(
        `INSERT INTO ingest_event_candidates
           (document_id, model_run, event_key, verdict, checks, event, published_at)
         VALUES ($1, gen_random_uuid(), 'vfy-reject-ev', 'publish', '[]'::jsonb, $2::jsonb, now())`,
        [savedDoc.id, JSON.stringify({ title: "Vfy event", placeName: "Vfy Place" })],
      );
      const [cacheRow]: Array<{ id: string }> = await runner.query(
        `INSERT INTO geocode_cache
           (normalized_name, raw_name, lon, lat, found, provider, confidence, decision)
         VALUES ('vfy place', 'Vfy Place', 5, 5, true, 'jev', 0.9, '{"method":"jev-context"}'::jsonb)
         RETURNING id`,
      );
      const listed = await listGeocodeReviews(runner, normalizePlaceName);
      const rejected = await reviewGeocode(runner, cacheRow!.id, "reject", normalizePlaceName);
      const [cacheAfter]: Array<{ found: boolean; review_status: string; lon: number | null }> =
        await runner.query(
          `SELECT found, review_status, lon FROM geocode_cache WHERE id = $1`,
          [cacheRow!.id],
        );
      const [candidate]: Array<{ verdict: string; published_at: string | null; checks: unknown[] }> =
        await runner.query(
          `SELECT verdict, published_at, checks FROM ingest_event_candidates
            WHERE event_key = 'vfy-reject-ev'`,
        );
      const leftovers: unknown[] = await runner.query(
        `SELECT 1 FROM events WHERE id = 'vfy-reject-ev'
         UNION ALL SELECT 1 FROM locations WHERE id = 'vfy-reject'`,
      );
      checks.push([
        "a Jev-decided geocode is listed for review with its published-event count",
        listed.some(
          (i) => i.id === cacheRow!.id && i.confidence === 0.9 && i.publishedEvents === 1,
        ),
      ]);
      checks.push([
        "rejecting a geocode demotes its events, removes the emptied pin, and caches a miss",
        rejected.ok &&
          rejected.demoted === 1 &&
          leftovers.length === 0 &&
          candidate?.verdict === "review" &&
          candidate.published_at === null &&
          candidate.checks.length === 1 &&
          cacheAfter?.found === false &&
          cacheAfter.review_status === "rejected" &&
          cacheAfter.lon === null,
      ]);
      const again = await reviewGeocode(runner, cacheRow!.id, "reject", normalizePlaceName);
      const confirmRejected = await reviewGeocode(runner, cacheRow!.id, "confirm", normalizePlaceName);
      checks.push([
        "a rejected geocode can't be rejected twice or confirmed without a pin",
        !again.ok && !confirmRejected.ok,
      ]);
    }
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
    await dataSource.destroy();
  }

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
