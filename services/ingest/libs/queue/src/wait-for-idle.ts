import type { Queue } from "bullmq";

/**
 * Polls a queue's job counts until nothing is waiting, active, or delayed —
 * i.e. every job has either completed or permanently failed. Built on
 * `getJobCounts()`, the same read-only call `scripts/queue-inspect.ts` uses.
 *
 * For `run-ingestion-fixture.ts`, which needs to know "has this stage
 * finished" without a worker-side signal to listen for. Fails loudly, naming
 * the queue and the counts it last saw, rather than silently timing out —
 * a stuck queue is exactly the failure this exists to catch.
 *
 * `expectedDelayed` exists for the `detect` queue specifically:
 * `DetectionSchedulerService.onModuleInit` calls `upsertJobScheduler`, which
 * always leaves exactly one placeholder job sitting `delayed` for its next
 * scheduled tick — that is the scheduler working, not a stuck job, so the
 * caller tells this function how many delayed jobs to treat as baseline.
 */
export async function waitForQueueIdle(
  queue: Queue,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    expectedDelayed?: number;
  } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const expectedDelayed = opts.expectedDelayed ?? 0;
  const deadline = Date.now() + timeoutMs;

  let counts = await queue.getJobCounts("waiting", "active", "delayed");
  while (
    counts["waiting"]! +
      counts["active"]! +
      Math.max(counts["delayed"]! - expectedDelayed, 0) >
    0
  ) {
    if (Date.now() > deadline) {
      throw new Error(
        `queue "${queue.name}" did not go idle within ${timeoutMs}ms — ` +
          `last counts: ${JSON.stringify(counts)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    counts = await queue.getJobCounts("waiting", "active", "delayed");
  }
}
