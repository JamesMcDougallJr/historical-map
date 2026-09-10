/**
 * Deterministic job-ID builders — the idempotency mechanism at the queue layer.
 *
 * BullMQ refuses a second job with an ID already active, waiting or delayed, so
 * the same document always produces the same job ID and a duplicate enqueue
 * silently no-ops instead of double-processing. This is the *second* of two
 * independent layers, and both are load-bearing: the database's unique index
 * stops duplicate **rows**, these IDs stop duplicate **work**. Neither
 * subsumes the other.
 *
 * Pure functions rather than an `@Injectable()` — there is no state or
 * dependency to inject.
 */

/**
 * BullMQ's own `Job.validateOptions` rejects a custom job ID containing `:`
 * unless it splits into exactly three parts — that shape is reserved for its
 * internal repeatable-job IDs. `fetch:${id}` is two parts and throws outright.
 *
 * The separator below is therefore `-`, and this guard exists because the one
 * input that is not a UUID (a source key, which comes from a database row) can
 * contain whatever someone typed. Failing here is far cheaper than failing
 * inside `queue.add()` at 3am.
 */
function assertUsableJobId(id: string): string {
  if (id.includes(":")) {
    throw new Error(
      `Job ID "${id}" contains ':', which BullMQ rejects for custom IDs. ` +
        `Use '-' as the separator.`,
    );
  }
  return id;
}

export const fetchJobId = (documentId: string): string =>
  assertUsableJobId(`fetch-${documentId}`);

export const extractJobId = (documentId: string): string =>
  assertUsableJobId(`extract-${documentId}`);

export const publishJobId = (documentId: string): string =>
  assertUsableJobId(`publish-${documentId}`);

/**
 * Scheduler entry ID for one source's recurring detection tick.
 *
 * `upsertJobScheduler` overwrites an entry with the same ID rather than adding
 * a second one, so this is safe to call on every boot **and** safe under
 * multiple `detect` replicas registering independently — exactly one tick per
 * source is produced regardless of how many instances are running.
 */
export const detectSchedulerId = (sourceKey: string): string =>
  assertUsableJobId(`poll-source-${sourceKey}`);
