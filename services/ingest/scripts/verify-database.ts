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
    await runner.manager.save(runner.manager.create(IngestDocument, doc));

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
