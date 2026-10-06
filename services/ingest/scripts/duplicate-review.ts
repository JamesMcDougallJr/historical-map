/**
 * Review events `publish` held as probable duplicates of one already on the map.
 *
 *   npm run duplicate:review --workspace=services/ingest
 *   npm run duplicate:review --workspace=services/ingest -- --approve=<eventKey>
 *   npm run duplicate:review --workspace=services/ingest -- --dismiss=<eventKey>
 *
 * Only exists when `JEV_PUBLISH_DEDUP_ENABLED` is on **and** `JEV_PUBLISH_DEDUP_HOLD_AT`
 * is above 0 — at the default of 0 nothing is ever held, so the list is empty (the
 * match and its probability are still recorded on each candidate's `checks`).
 *
 * - no arguments: lists held candidates with Jev's reasoning (`P(same)`, and the
 *   existing event it matched).
 * - `--approve`: "this is a different event — publish it." Marks the candidate
 *   resolved and publishable and re-queues its document's publish job.
 * - `--dismiss`: "this is a duplicate — leave it out." Marks it resolved but keeps it
 *   in review, so it stops being listed. `validate` will not overwrite a resolved
 *   candidate, so re-validating the document cannot push it back to `publish`.
 */
import { Queue } from "bullmq";
import { createDataSource } from "../libs/database/src/data-source";
import {
  BULLMQ_PREFIX,
  JOB_NAME_BY_QUEUE,
  JOB_OPTIONS_BY_QUEUE,
  QUEUE_NAMES,
  publishJobId,
} from "../libs/queue/src";

/** Same name `apps/workers/publish/src/publishing/jev-dedup.ts` records. */
const CHECK = "duplicate-published";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

interface HeldRow {
  event_key: string;
  document_id: string;
  event: { title: string; dateText: string; placeName: string | null };
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

async function main(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();

  try {
    const approve = arg("approve");
    const dismiss = arg("dismiss");
    const eventKey = approve ?? dismiss;

    if (!eventKey) {
      const rows: HeldRow[] = await dataSource.query(
        `SELECT event_key, document_id, event, checks
         FROM ingest_event_candidates
         WHERE resolved_at IS NULL
           AND verdict = 'review'
           AND checks @> $1::jsonb
         ORDER BY created_at`,
        [JSON.stringify([{ name: CHECK, passed: false }])],
      );
      if (rows.length === 0) {
        console.log("No events are held as probable duplicates.");
        return;
      }
      for (const row of rows) {
        const check = row.checks.find((c) => c.name === CHECK);
        console.log(
          `${row.event_key}\n  "${row.event.title}" (${row.event.dateText}, ${row.event.placeName ?? "no place"})\n  ${check?.detail ?? ""}\n`,
        );
      }
      console.log(`${rows.length} held. Use --approve=<eventKey> or --dismiss=<eventKey>.`);
      return;
    }

    const found: HeldRow[] = await dataSource.query(
      `SELECT event_key, document_id, event, checks
       FROM ingest_event_candidates
       WHERE event_key = $1 AND resolved_at IS NULL AND verdict = 'review' AND checks @> $2::jsonb`,
      [eventKey, JSON.stringify([{ name: CHECK, passed: false }])],
    );
    const row = found[0];
    if (!row) {
      console.error(
        `No unresolved held duplicate with event key "${eventKey}" (run with no arguments to list them).`,
      );
      process.exitCode = 1;
      return;
    }

    if (dismiss) {
      await dataSource.query(
        `UPDATE ingest_event_candidates SET resolved_at = now() WHERE event_key = $1`,
        [eventKey],
      );
      console.log(`Dismissed "${row.event.title}" — it stays in review and will not be published.`);
      return;
    }

    await dataSource.query(
      `UPDATE ingest_event_candidates
       SET verdict = 'publish', resolved_at = now()
       WHERE event_key = $1`,
      [eventKey],
    );

    // Same remove-then-add as `queue:requeue`: a finished job keeps its
    // deterministic id in the queue, and a plain add against it silently no-ops.
    const queue = new Queue(QUEUE_NAMES.PUBLISH, {
      connection: {
        host: process.env["REDIS_HOST"] ?? "localhost",
        port: Number(process.env["REDIS_PORT"] ?? 6379),
      },
      prefix: BULLMQ_PREFIX,
    });
    try {
      const jobId = publishJobId(row.document_id);
      await (await queue.getJob(jobId))?.remove();
      await queue.add(
        JOB_NAME_BY_QUEUE[QUEUE_NAMES.PUBLISH],
        { documentId: row.document_id },
        { jobId, ...JOB_OPTIONS_BY_QUEUE[QUEUE_NAMES.PUBLISH] },
      );
    } finally {
      await queue.close();
    }
    console.log(`Approved "${row.event.title}" — publish re-queued for its document.`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
