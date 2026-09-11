/**
 * Fires a detection pass now, instead of waiting for the daily scheduler.
 *
 *   npm run detect:trigger --workspace=services/ingest
 *   npm run detect:trigger --workspace=services/ingest -- --source=local-directory
 *   npm run detect:trigger --workspace=services/ingest -- --lookback=30
 *
 * With no `--source` it fans out one job per enabled source, which is what the
 * `/detection/trigger` API endpoint will do once `apps/api` grows one.
 *
 * Deliberately enqueued **without** a jobId: the scheduler's per-source jobs use
 * deterministic ids, and an ad-hoc trigger that reused one would silently
 * collapse into the pending scheduled job instead of running now.
 */
import { Queue } from "bullmq";
import { createDataSource } from "../libs/database/src/data-source";
import { IngestSource } from "../libs/database/src/entities";
import { DETECT_JOB_OPTIONS, QUEUE_NAMES } from "../libs/queue/src";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const only = arg("source");
  const lookback = arg("lookback");

  const dataSource = createDataSource();
  await dataSource.initialize();

  let keys: string[];
  try {
    const repo = dataSource.getRepository(IngestSource);
    const sources = await repo.find({ where: { enabled: true } });
    keys = sources.map((s) => s.key);
    if (only) {
      if (!keys.includes(only)) {
        throw new Error(
          `source "${only}" is not enabled or does not exist. Enabled: ${keys.join(", ") || "(none)"}`,
        );
      }
      keys = [only];
    }
  } finally {
    await dataSource.destroy();
  }

  if (keys.length === 0) {
    console.error("No enabled sources. Run seed:sources first.");
    process.exitCode = 1;
    return;
  }

  const queue = new Queue(QUEUE_NAMES.DETECT, {
    connection: {
      host: process.env["REDIS_HOST"] ?? "localhost",
      port: Number(process.env["REDIS_PORT"] ?? 6379),
    },
  });

  try {
    for (const sourceKey of keys) {
      const job = await queue.add(
        "poll-source",
        {
          sourceKey,
          ...(lookback ? { lookbackDays: Number(lookback) } : {}),
        },
        DETECT_JOB_OPTIONS,
      );
      console.log(`triggered source=${sourceKey} job=${job.id}`);
    }
  } finally {
    await queue.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
