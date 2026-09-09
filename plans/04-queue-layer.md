# Phase 4 — Queue layer

`libs/queue` — BullMQ contracts shared by every worker. No processors here; each app's feature
module registers its own queue using these constants.

## Queues and job options

Four queues: `detect`, `fetch`, `extract`, `publish`. Per-queue `attempts`/`backoff` tuned to
what the stage actually costs, following the State Affairs reasoning:

| Queue | Attempts | Why |
|---|---|---|
| `detect` | 3, exp. 10s | A lightweight HTTP fetch + DB write. It self-heals on the next scheduled tick regardless, so retries only exist to recover faster than waiting out the interval. |
| `fetch` | 5, exp. 5s | Network-bound against third-party servers of varying reliability. Worth being patient. |
| `extract` | 3, exp. 15s | Expensive. A whole-job retry re-sends every chunk, so the in-job retry budget matters more than the queue-level one (see phase 8). |
| `publish` | 5, exp. 5s | Geocoder rate limits are the expected failure, and they clear on their own. |

## Idempotency

Deterministic, content-derived job IDs — `fetchJobId(documentId)`, `extractJobId(documentId)`,
`publishJobId(extractionId)`. BullMQ refuses a second job with an ID already
active/waiting/delayed, so re-enqueueing the same document silently no-ops rather than
double-processing.

**Use `-` as the separator, not `:`.** BullMQ's `Job.validateOptions` rejects a custom `jobId`
containing `:` unless it splits into exactly three parts — that format is reserved for its
internal repeatable-job IDs. `fetch:${documentId}` is two parts and throws outright. This was
found the hard way in State Affairs by reading `node_modules/bullmq` after a real `queue.add()`
failed; there is no reason to rediscover it.

Note the two layers are independent and both are load-bearing: the **database** unique index
stops duplicate *rows*, the **job ID** stops duplicate *work*. Neither subsumes the other.

## Scheduling

BullMQ's Job Scheduler (`upsertJobScheduler`) is the cron. One scheduler entry per enabled
source, registered on boot by the `detect` app.

`upsertJobScheduler` overwrites an entry with the same ID rather than creating a second one, so
registration is safe on every restart **and** under multiple `detect` replicas each registering
independently — exactly one tick per source is produced regardless of how many instances run.
The schedule state lives in Redis, not in any process's memory.

**Cadence should be much slower than State Affairs' 15 minutes.** That interval existed because
legislative hearings are published within hours and the product was "near real-time." Nothing
about a 19th-century event is time-sensitive; a historical archive updates on the order of
weeks. Poll **daily**, and make the interval per-source configuration rather than a constant —
a source that publishes quarterly should not be hit 90 times between updates. Politeness toward
volunteer-run archives is a real constraint here in a way it was not for state government
portals.

## Job payloads

Job data carries **identifiers, not content** — `{ documentId }`, not the document text. The
database is the source of truth for state; Redis is a work queue. This keeps job payloads small
and means a job picked up after a restart reads current state rather than a stale snapshot
captured at enqueue time.

`DetectJobData` carries `{ sourceKey, lookbackDays? }` — the optional override lets a one-off
backfill widen the window through the API without touching configuration.

## Verification

- A scheduler entry survives restarting the `detect` app, and does not duplicate.
- Enqueueing the same `documentId` twice produces one job.
- Bull Board (or equivalent) shows per-job logs — see the `JobLogger` note in phase 6.
