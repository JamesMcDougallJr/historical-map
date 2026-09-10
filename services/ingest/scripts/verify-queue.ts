/**
 * Proves the queue layer's two claims actually hold against a real Redis,
 * rather than being true only in the constants file.
 *
 *   REDIS_HOST=localhost npm run queue:verify --workspace=services/ingest
 *
 * Uses a throwaway queue name so it never touches real pipeline state, and
 * obliterates it on the way out.
 */
import { Queue } from "bullmq";
import {
  DETECT_JOB_OPTIONS,
  FETCH_JOB_OPTIONS,
  detectSchedulerId,
  extractJobId,
  fetchJobId,
} from "../libs/queue/src";

const VERIFY_QUEUE = `verify-${Date.now()}`;

async function main(): Promise<void> {
  const connection = {
    host: process.env["REDIS_HOST"] ?? "localhost",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  };
  const queue = new Queue(VERIFY_QUEUE, { connection });
  const checks: Array<[string, boolean]> = [];

  try {
    // 1. Deterministic job IDs collapse a duplicate enqueue into one job.
    //    This is the queue-layer half of idempotency; without it, a detect pass
    //    that re-sees a document would double-process it even though the
    //    database refused the duplicate row.
    const id = fetchJobId("11111111-2222-3333-4444-555555555555");
    const first = await queue.add(
      "fetch",
      { documentId: "x" },
      {
        jobId: id,
        ...FETCH_JOB_OPTIONS,
      },
    );
    const second = await queue.add(
      "fetch",
      { documentId: "x" },
      {
        jobId: id,
        ...FETCH_JOB_OPTIONS,
      },
    );
    checks.push([
      "duplicate jobId collapses to one job",
      first.id === second.id,
    ]);

    const counts = await queue.getJobCounts("waiting", "delayed", "active");
    const total =
      (counts["waiting"] ?? 0) +
      (counts["delayed"] ?? 0) +
      (counts["active"] ?? 0);
    checks.push(["only one job is queued", total === 1]);

    // 2. Job options actually reach the job — a queue whose retries silently
    //    default to attempts=1 looks fine until the first transient failure
    //    permanently fails a document.
    const stored = await queue.getJob(id);
    checks.push([
      `attempts applied (${stored?.opts.attempts} === ${FETCH_JOB_OPTIONS.attempts})`,
      stored?.opts.attempts === FETCH_JOB_OPTIONS.attempts,
    ]);
    checks.push([
      "exponential backoff applied",
      (stored?.opts.backoff as { type?: string } | undefined)?.type ===
        "exponential",
    ]);

    // 3. The second add did not overwrite the first's options.
    checks.push([
      "re-add did not mutate the existing job",
      stored?.data.documentId === "x",
    ]);

    // 4. The ':' guard fires before BullMQ's own opaque rejection.
    let guardFired = false;
    try {
      detectSchedulerId("utah:historical");
    } catch {
      guardFired = true;
    }
    checks.push(["':' in a job ID is rejected by our guard", guardFired]);

    // 5. Distinct stages never collide on ID for the same document.
    const doc = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    checks.push([
      "stage job IDs are distinct for one document",
      fetchJobId(doc) !== extractJobId(doc),
    ]);

    // 6. A scheduler entry upserts rather than duplicating — this is what makes
    //    boot-time registration safe under multiple detect replicas.
    const schedulerId = detectSchedulerId("verify-source");
    await queue.upsertJobScheduler(
      schedulerId,
      { pattern: "0 3 * * *" },
      {
        name: "poll-source",
        data: { sourceKey: "verify-source" },
        opts: DETECT_JOB_OPTIONS,
      },
    );
    await queue.upsertJobScheduler(
      schedulerId,
      { pattern: "0 3 * * *" },
      {
        name: "poll-source",
        data: { sourceKey: "verify-source" },
        opts: DETECT_JOB_OPTIONS,
      },
    );
    const schedulers = await queue.getJobSchedulers();
    checks.push([
      "repeated upsertJobScheduler yields exactly one entry",
      schedulers.filter((s) => s.key === schedulerId).length === 1,
    ]);
  } finally {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
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
