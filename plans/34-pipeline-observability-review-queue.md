# Pipeline observability and the publish review queue: seeing the engine, and gating what it publishes

**Related:** [00-README.md](./00-README.md) (phases 04, 09, 10),
[04-queue-layer.md](./04-queue-layer.md) (BullMQ contracts, deterministic job IDs),
[09-publish-worker.md](./09-publish-worker.md) (geocode, dedup, write),
[10-deployment.md](./10-deployment.md) (workers do not run on Vercel),
[13-similarity-and-fusion.md](./13-similarity-and-fusion.md) (Jev judge stage),
[25-product-backlog.md](./25-product-backlog.md) (product steps),
[26-wikidata-pilot.md](./26-wikidata-pilot.md) (source #2, GLOBAL),
[27-web-ingestor.md](./27-web-ingestor.md) (the HTTP fetcher),
[30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (popup and timeline display),
[32-fuzzy-dates.md](./32-fuzzy-dates.md) (event date model),
[33-source-licensing-attribution.md](./33-source-licensing-attribution.md)
(publish gate, review queue).

**Changelog:**
- 2026-10-28 - Created from the daily research loop. Every plan so far
  describes what the pipeline does, but none describes how anyone knows
  it is working, what happens when a job fails, or where a flagged
  record waits for a human. Plan 33 sends license-rejected records "to
  the review queue" without designing that queue, and plan 04's queue
  layer has no monitoring story at all. This plan closes both gaps
  before the plan 26 pilot publishes anything.

## Why this plan exists

Today a failed pipeline job has nowhere visible to go. BullMQ marks it
failed and moves on; if nothing watches for that event, the failure
disappears into queue history and is found days later, if at all.
That is the standard failure mode of background-job systems, and it
is worse here than in a typical app for three reasons:

- The workers run off Vercel (plan 10), so there is no Vercel
  dashboard, log drain, or alerting watching them by default.
- The expensive steps are LLM calls (Groq extraction, Jev judging,
  Bedrock embeddings per plan 12), so a stuck or looping job burns
  money silently, not just time.
- Publish is the step that writes to the public map, and plan 33
  already routes its rejects to a review queue that does not exist
  yet. A gate with no queue behind it is a dead letter in disguise:
  records pile up where nobody looks, or worse, get dropped.

So this plan designs two things that must land together: an ops
surface for the queues, and a durable, human-sized review queue for
everything publish refuses to auto-approve.

## The ops surface: read the queues, do not reimplement them

The ingest service (Nest, `services/ingest`) exposes its queues
through Bull Board, mounted as an admin route on the ingest service
itself, not on the Vercel web app. Bull Board is the established
BullMQ dashboard: real-time counts (waiting, active, delayed,
completed, failed), per-job data and error traces, and manual
retry/delete. It reads queue state through the official BullMQ
client, never through raw Redis key scans: a dashboard that slows
the workload it watches is worse than no dashboard, and at pilot
scale the one rule that matters is bounded reads and truncated
payloads (a page of jobs must not pull full multi-KB extraction
payloads into the browser).

Access control is deliberately simple for v1. The admin route is
authenticated and not linked from the public map; James is the only
reviewer today, so single-user auth is acceptable. Multi-user roles
(viewer vs operator), SSO, and an audit log of operator actions
(pause queue, retry-all, delete job) are the documented stretch,
not v1 scope: the pattern exists in larger BullMQ dashboards, and
this plan names it so v1 does not paint itself into a corner.

Alongside the dashboard, the ingest service emits structured JSON
logs with `jobId`, stage, source adapter, attempt count, and error
on every transition, and a metrics endpoint (queue depth, completed
and failed counts, processing time per stage) that any future
Prometheus/Grafana setup can scrape. Alert thresholds are set in
config, not code:

- Queue depth above N for more than M minutes (backlog growing).
- Failed-job rate above X% over a rolling window.
- A job active longer than its stage timeout (stalled worker).
- A source adapter silent for longer than its detect interval
  (a source that stopped producing, which looks identical to "no
  news" without this check).
- Review queue depth or oldest-item age above threshold (see below).

Alerts go to one channel James already reads; the channel itself is
an open question for him, not a plan-time guess. What the plan
locks is fail-closed alerting: an alert that cannot be delivered
is logged as its own incident, not swallowed.

## Dead-letter queues: failed jobs become visible, replayable work

Each stage queue gets a dead-letter queue (DLQ). When a job exhausts
its attempts, a queue-events listener moves it to the DLQ with its
original data, failure reason, and failure timestamp preserved. The
DLQ is itself a BullMQ queue, so it shows up in Bull Board beside
the live queues, and a replay script re-queues DLQ jobs onto their
origin queue once the underlying issue is fixed.

Replay is safe only because plan 04 already made job IDs
deterministic and the stages idempotent: re-running a publish job
must not duplicate an event, and re-running an extract job must not
double-charge the LLM path in a way that double-writes. The replay
script therefore re-queues by original job ID and records the replay
in the job's history; it never edits payloads by hand. Hand-edited
payloads go through the review queue instead, where the edit is
audited.

Retry policy per stage, to be tuned against pilot data (starting
values, not gospel): 5 attempts, exponential backoff starting at
5s for transient failures (rate limits, network blips); immediate
DLQ, no retry, for deterministic failures (bad payload shape,
undeclared license is a review-queue matter, not a retry matter).
Distinguishing the two at the error site is part of each worker's
contract: a thrown error carries a `retryable` flag.

## The review queue: a Postgres table, not a Redis afterthought

Review items live in Postgres, in the same database as everything
else, in a new `ingest_review_items` table. Redis is for queue
state; review is durable, auditable human work, and it must survive
a Redis restart, be queryable by reason and age, and keep its
history after the decision. One row per flagged record:

- `source_adapter`, `stage_flagged` (publish, validate, dedup,
  geocode), `reason` (enum: `LICENSE_UNDECLARED` per plan 33,
  `DEDUP_LOW_CONFIDENCE` for Jev scores in the uncertain band,
  `GEOCODE_AMBIGUOUS`, `DATE_OUT_OF_RANGE` per plan 32,
  `LINK_ONLY_VIOLATION`, `OTHER`).
- `proposed_payload` - the full event snapshot as publish would
  have written it, frozen at flag time.
- `source_anchors` - the plan 14 anchors: what the source actually
  said, linked, so the reviewer judges evidence, not a summary.
- `flagged_fields` - which fields triggered the flag, highlighted
  in the UI. A review screen that shows only the draft and an
  Approve button is a checkbox, not a safety measure: the reviewer
  must see the signal that triggered the flag, the confidence
  score, and the source anchor to make a real decision.
- `decision` (pending / approved / rejected / edited),
  `decided_by`, `decided_at`, `decision_note`, and a fingerprint
  of exactly what was approved. A decision is single-use: once
  decided, the item cannot be decided again, and the publish step
  re-checks the fingerprint before writing. If the payload changed
  after approval, publish refuses and re-queues for review. This
  is the same approve-fingerprint-then-verify shape used by
  human-in-the-loop approval queues generally, and it is what
  keeps "James approved X" true at write time, not just at click
  time.
- `expires_at` - every pending item has a TTL. A watchdog scans
  stalled items past TTL and escalates (alert, not auto-publish).
  Unreviewed records never reach the map by default: the queue
  fails closed.

The review UI is a page in the web app's admin area
(`/admin/review`), backed by an API that reads the Postgres table.
It shows, per item: the proposed event on a mini-map and timeline
context, the flagged fields highlighted, the source anchor, the
confidence or license reason, and Approve / Edit / Reject actions.
Batch review by reason (e.g. clear a run of identical geocode
ambiguities together) and filtering by source, reason, and age are
v1 features, because flagged items cluster by cause and reviewing
them one at a time is how fatigue starts. Chat or email approval
links are explicitly out: scanners and forwards make link-clicks
unreliable as approval, and a forty-item queue is not a chat thread.

Two routing rules keep the queue human-sized:

- Start conservative: high Jev-confidence merges auto-publish,
  the uncertain band goes to review, and thresholds tighten only
  after the pilot's straight-through rate and error rate are
  measured. This is the standard human-in-the-loop ramp: more
  review early, less as the system earns trust.
- Keep a small random sample of auto-approved items flowing to
  review even after thresholds loosen, so drift shows up in the
  queue rather than in a user complaint.

## Cost ledger: the LLM bill, per job, per source

Groq extraction, Jev judging, and Bedrock embeddings are all
metered. Each job records its model calls (provider, model,
tokens in/out where reported) into an `ingest_cost_ledger` table,
and a per-source daily rollup feeds the ops surface. The ledger
exists so that a runaway source, a retry storm, or a prompt
regression shows up as a number the next morning, not as a
surprise invoice. Whether a daily budget cap hard-pauses detect
or only alerts is James's call (open question below); the ledger
lands either way, and the cap is a config flag on top of it.

## Sequencing

1. Structured logs + metrics endpoint + Bull Board admin route
   on the ingest service (auth-gated). No pipeline behavior
   changes; this is visibility only.
2. DLQ per stage queue + queue-events listener + replay script.
   Idempotency re-verified by replaying a DLQ job in staging
   and confirming no duplicate event.
3. `ingest_review_items` table + publish/validate routing for
   the plan 33 license gate and the Jev uncertain band. The
   review queue must exist before the plan 26 pilot publishes
   anything: the pilot is the first thing that can fill it.
4. `/admin/review` UI with flagged-field highlighting, source
   anchors, batch-by-reason, and the approve-fingerprint check
   at publish.
5. Alert thresholds + delivery channel + review-item watchdog.
6. Cost ledger + per-source daily rollup on the ops surface;
   budget-cap flag per James's answer.

## Testing

- DLQ replay test: a failed publish job, replayed, writes
  exactly one event (idempotency via plan 04 job IDs).
- Review decision-once test: a second decision on a decided
  item is rejected; a fingerprint mismatch at publish refuses
  the write and re-queues the item.
- Auth test: the admin route and review API reject
  unauthenticated requests; nothing review- or queue-related
  is reachable from the public map.
- Alert test: a synthetic stalled job and a synthetic silent
  source each fire their threshold alert in staging.
- Cost ledger test: a job with known token counts rolls up
  correctly to the per-source daily total.

## Done when

- Bull Board (or equivalent) shows all six stage queues plus
  DLQs, behind auth, with truncated payloads.
- A job that exhausts retries lands in the DLQ, is visible,
  and replays without duplicating data.
- A plan 33 license-rejected record and a Jev uncertain-band
  record both land in `ingest_review_items`, are reviewable
  with source anchors and flagged fields, and reach the map
  only after an approved, fingerprint-verified decision.
- Review items past TTL escalate by alert and never
  auto-publish.
- Per-stage throughput, failure rate, review depth/age, and
  per-source LLM cost are visible on the ops surface.
- Dedup remains deterministic blocking + Jev pairwise judging
  per the 2026-10-23 decision, and the review queue routes the
  Jev uncertain band.

## Open to James (see chat summary)

- Reviewer: is the review queue James-only for v1, or should it
  be built for a second reviewer from the start?
- Cost cap: should a daily LLM budget cap hard-pause detect,
  or alert only?
- Alert channel: where should pipeline alerts go (the channel
  he already reads for other digests, or a separate one)?
