/**
 * Review events `publish` set aside as duplicates of ones already on the map.
 *
 *   npm run duplicate:review --workspace=services/ingest
 *   npm run duplicate:review --workspace=services/ingest -- --approve=<eventKey>
 *   npm run duplicate:review --workspace=services/ingest -- --dismiss=<eventKey>
 *
 * Only has anything to list when `JEV_PUBLISH_DEDUP_ENABLED` is on **and**
 * `JEV_PUBLISH_DEDUP_MATCH_AT` or `JEV_PUBLISH_DEDUP_NEW_AT` is above 0 — with both at
 * their default of 0 nothing is held or auto-resolved (the match and its probabilities
 * are still recorded on each candidate's `checks`).
 *
 * - no arguments: lists **held** events (Jev was not sure either way) and
 *   **auto-resolved** ones (Jev was confident it is the same event, so it was left off
 *   the map without a person), each with the existing event it matched and both
 *   probabilities.
 * - `--approve`: "this is a different event — publish it." Works on either list, so it
 *   is also how an auto-resolved duplicate is overturned. Re-queues the document's
 *   publish job.
 * - `--dismiss`: "this is a duplicate — leave it out." Held events only.
 *
 * The same logic backs the admin panel's /duplicates page (`libs/database`).
 */
import { Queue } from "bullmq";
import { createDataSource } from "../libs/database/src/data-source";
import { listDuplicates, resolveDuplicate } from "../libs/database/src/duplicates";
import {
  BULLMQ_PREFIX,
  JOB_NAME_BY_QUEUE,
  JOB_OPTIONS_BY_QUEUE,
  QUEUE_NAMES,
  publishJobId,
} from "../libs/queue/src";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();

  try {
    const approve = arg("approve");
    const dismiss = arg("dismiss");
    const eventKey = approve ?? dismiss;

    if (!eventKey) {
      const items = await listDuplicates(dataSource);
      if (items.length === 0) {
        console.log("No events are held or auto-resolved as duplicates.");
        return;
      }
      for (const item of items) {
        console.log(
          `[${item.status}] ${item.eventKey}\n` +
            `  "${item.event.title}" (${item.event.dateText}, ${item.event.placeName ?? "no place"})\n` +
            `  ${item.detail}\n`,
        );
      }
      const held = items.filter((i) => i.status === "held").length;
      console.log(
        `${held} held, ${items.length - held} auto-resolved. ` +
          `Use --approve=<eventKey> or --dismiss=<eventKey>.`,
      );
      return;
    }

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
      const result = await resolveDuplicate(
        dataSource,
        eventKey,
        approve ? "approve" : "dismiss",
        async (documentId) => {
          const jobId = publishJobId(documentId);
          await (await queue.getJob(jobId))?.remove();
          await queue.add(
            JOB_NAME_BY_QUEUE[QUEUE_NAMES.PUBLISH],
            { documentId },
            { jobId, ...JOB_OPTIONS_BY_QUEUE[QUEUE_NAMES.PUBLISH] },
          );
        },
      );
      if (!result.ok) {
        console.error(result.reason + " (run with no arguments to list them).");
        process.exitCode = 1;
        return;
      }
      console.log(
        approve
          ? `Approved "${result.title}" — publish re-queued for its document.`
          : `Dismissed "${result.title}" — it stays in review and will not be published.`,
      );
    } finally {
      await queue.close();
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
