/**
 * Re-runs one document's stage after you have fixed whatever broke it.
 *
 *   npm run queue:requeue --workspace=services/ingest -- --queue=fetch --document=<uuid>
 *
 * This exists because of the deterministic job IDs. Once a job has exhausted
 * its attempts it stays in the queue under `fetch-<documentId>`, and a plain
 * re-enqueue silently no-ops against that ID — the very property that makes
 * re-detection safe is what masks your fix. So: remove the old job explicitly,
 * then add a fresh one with the real job options.
 */
import { Queue } from "bullmq";
import {
  JOB_OPTIONS_BY_QUEUE,
  QUEUE_NAMES,
  extractEventsJobId,
  fetchJobId,
  publishJobId,
  type QueueName,
} from "../libs/queue/src";

const JOB_ID_BUILDERS: Partial<Record<QueueName, (id: string) => string>> = {
  [QUEUE_NAMES.FETCH]: fetchJobId,
  [QUEUE_NAMES.EXTRACT_EVENTS]: extractEventsJobId,
  [QUEUE_NAMES.PUBLISH]: publishJobId,
};

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const queueName = arg("queue") as QueueName | undefined;
  const documentId = arg("document");

  const buildJobId = queueName ? JOB_ID_BUILDERS[queueName] : undefined;
  if (!queueName || !buildJobId || !documentId) {
    console.error(
      `Usage: --queue=<${Object.keys(JOB_ID_BUILDERS).join("|")}> --document=<uuid>`,
    );
    process.exitCode = 1;
    return;
  }

  const queue = new Queue(queueName, {
    connection: {
      host: process.env["REDIS_HOST"] ?? "localhost",
      port: Number(process.env["REDIS_PORT"] ?? 6379),
    },
  });

  try {
    const jobId = buildJobId(documentId);
    const existing = await queue.getJob(jobId);
    if (existing) {
      console.log(
        `Removing existing job ${jobId} (state=${await existing.getState()}, ` +
          `attemptsMade=${existing.attemptsMade})`,
      );
      await existing.remove();
    } else {
      console.log(`No existing job ${jobId}; adding fresh.`);
    }

    await queue.add(
      queueName,
      { documentId },
      { jobId, ...JOB_OPTIONS_BY_QUEUE[queueName] },
    );
    console.log(`Requeued ${jobId} on "${queueName}".`);
  } finally {
    await queue.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
