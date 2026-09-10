/**
 * Dumps jobs from a queue in a given state. The first thing to reach for when
 * "why has nothing appeared on the map?" needs an answer.
 *
 *   npm run queue:inspect --workspace=services/ingest -- --queue=fetch
 *   npm run queue:inspect --workspace=services/ingest -- --queue=extract --state=failed
 *
 * States: waiting | active | completed | failed | delayed (default: failed —
 * it is what you almost always want).
 */
import { Queue, type JobState } from "bullmq";
import { QUEUE_NAMES, type QueueName } from "../libs/queue/src";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=")[1];
}

async function main(): Promise<void> {
  const queueName = arg("queue");
  const state = (arg("state") ?? "failed") as JobState;
  const limit = Number(arg("limit") ?? 20);

  const valid = Object.values(QUEUE_NAMES) as string[];
  if (!queueName || !valid.includes(queueName)) {
    console.error(`--queue is required, one of: ${valid.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const queue = new Queue(queueName as QueueName, {
    connection: {
      host: process.env["REDIS_HOST"] ?? "localhost",
      port: Number(process.env["REDIS_PORT"] ?? 6379),
    },
  });

  try {
    const counts = await queue.getJobCounts();
    console.log(`queue=${queueName} counts:`, counts);

    const jobs = await queue.getJobs([state], 0, limit - 1);
    if (jobs.length === 0) {
      console.log(`\nNo jobs in state "${state}".`);
      return;
    }

    console.log(`\n${jobs.length} job(s) in state "${state}":\n`);
    for (const job of jobs) {
      console.log(`  id=${job.id}`);
      console.log(
        `  name=${job.name}  attemptsMade=${job.attemptsMade}/${job.opts.attempts ?? 1}`,
      );
      console.log(`  data=${JSON.stringify(job.data)}`);
      if (job.failedReason) console.log(`  failedReason=${job.failedReason}`);
      // job.log() output — the per-stage trail JobLogger writes.
      const { logs } = await queue.getJobLogs(String(job.id), 0, 5);
      for (const line of logs) console.log(`    log: ${line}`);
      console.log();
    }
  } finally {
    await queue.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
