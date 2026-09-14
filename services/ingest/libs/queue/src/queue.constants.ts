import type { JobsOptions } from "bullmq";

export const QUEUE_NAMES = {
  DETECT: "detect",
  /** Retrieval only: bytes in, original stored in object storage. */
  FETCH: "fetch",
  /** Bytes out of storage, cleaned text artifact back in. No model involved. */
  EXTRACT_TEXT: "extract-text",
  /** Text to events, via the model. The only stage that costs money. */
  EXTRACT_EVENTS: "extract-events",
  /** Judges events and decides publish vs review. */
  VALIDATE: "validate",
  PUBLISH: "publish",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * The job *name* each stage enqueues under — distinct from the queue name, and
 * purely descriptive: every processor is a `WorkerHost` handling all names on
 * its queue, so nothing dispatches on these.
 *
 * They are not cosmetic either. Bull Board lists jobs by name, so a re-enqueue
 * that invents its own name produces a job that looks nothing like the one the
 * pipeline would have created for the same work — which is actively misleading
 * in the one place an operator goes to compare them.
 */
export const JOB_NAME_BY_QUEUE = {
  [QUEUE_NAMES.DETECT]: "poll-source",
  [QUEUE_NAMES.FETCH]: "fetch-document",
  [QUEUE_NAMES.EXTRACT_TEXT]: "extract-text",
  [QUEUE_NAMES.EXTRACT_EVENTS]: "extract-events",
  [QUEUE_NAMES.VALIDATE]: "validate-document",
  [QUEUE_NAMES.PUBLISH]: "publish-document",
} as const satisfies Record<QueueName, string>;

/**
 * Retry budgets are tuned per stage to what the stage actually costs. They are
 * not a uniform policy with the numbers filled in.
 */

/**
 * A detect job is one lightweight HTTP fetch plus a DB write, and it self-heals
 * on the next scheduled tick regardless. These retries exist only to recover
 * faster than waiting out the interval — not because a lost job would be
 * unrecoverable.
 */
export const DETECT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

/**
 * Network-bound against third-party archives of varying reliability, several
 * volunteer-run. Worth being patient rather than giving up and marking a
 * document failed over someone else's brief outage.
 */
export const FETCH_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: 5_000,
};

/**
 * CPU-bound and free — no external service to be patient with. A failure here
 * is usually a malformed document, which retrying will not fix, so the budget
 * is deliberately smaller than `fetch`'s.
 */
export const EXTRACT_TEXT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 200,
  removeOnFail: 2_000,
};

/**
 * Pure computation over data already in hand — no network, no model. Retries
 * exist only for transient database trouble.
 */
export const VALIDATE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 200,
  removeOnFail: 2_000,
};

/**
 * Expensive: every attempt costs real money at the model. Fewer attempts here
 * than `fetch` on purpose — and the in-job chunk checkpoint
 * (`ingest_extractions`) matters far more than this number, because it stops a
 * retry from re-sending chunks that already succeeded.
 */
export const EXTRACT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000 },
  removeOnComplete: 200,
  removeOnFail: 5_000,
};

/**
 * The expected failure is a geocoder rate limit, which clears on its own. Being
 * patient is strictly better than surfacing a half-published extraction.
 */
export const PUBLISH_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: 5_000,
};

export const JOB_OPTIONS_BY_QUEUE: Record<QueueName, JobsOptions> = {
  [QUEUE_NAMES.DETECT]: DETECT_JOB_OPTIONS,
  [QUEUE_NAMES.FETCH]: FETCH_JOB_OPTIONS,
  [QUEUE_NAMES.EXTRACT_TEXT]: EXTRACT_TEXT_JOB_OPTIONS,
  [QUEUE_NAMES.EXTRACT_EVENTS]: EXTRACT_JOB_OPTIONS,
  [QUEUE_NAMES.VALIDATE]: VALIDATE_JOB_OPTIONS,
  [QUEUE_NAMES.PUBLISH]: PUBLISH_JOB_OPTIONS,
};

/**
 * Daily at 03:00, not the 15 minutes a near-real-time video pipeline wants.
 *
 * Nothing about an 1847 event is time-sensitive, archives update on the order
 * of weeks, and several of the target sources are volunteer-run infrastructure
 * that will not absorb aggressive polling. Overridable per source via
 * `ingest_sources.poll_cron` — a source that publishes quarterly should not be
 * hit 90 times between updates.
 */
export const DEFAULT_DETECT_CRON = "0 3 * * *";
