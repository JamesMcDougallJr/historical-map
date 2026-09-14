# Admin UI — reference

Everything you need to build an operator UI that triggers and observes the ingestion
pipeline. This documents what exists today, what you'd have to add, and the handful of
invariants that will silently defeat a naive implementation.

Read `CLAUDE.md` → "Ingestion engine" first for the conceptual model. This file is the
API/contract layer underneath it.

---

## 1. What already exists — don't rebuild it

`services/ingest/apps/api` is already an operator surface. Before writing anything, run it:

```bash
export POSTGRES_URL=postgres://postgres:password@localhost:5433/db
export REDIS_HOST=localhost REDIS_PORT=6379
export BULL_BOARD_PASSWORD=devpassword   # without this the dashboard 503s, by design
npm run start:api --workspace=services/ingest   # → :3100
```

| Route                | Method | What it does                                            |
| -------------------- | ------ | ------------------------------------------------------- |
| `/health`            | GET    | Liveness + Postgres reachability                        |
| `/status`            | GET    | Document counts by status, review counts by verdict     |
| `/documents`         | GET    | Document listing — `?status=`, `?limit=` (max 200)      |
| `/review`            | GET    | Unresolved candidates — `?verdict=review`, `?limit=`    |
| `/detection/trigger` | POST   | Enqueue detection; `{ sourceKey?, lookbackDays? }` → 202 |
| `/queues`            | GET    | **Bull Board** — full job inspector, behind Basic auth   |

**Bull Board is already a competent admin UI for the queue half of the problem.** It gives
you per-queue job lists, payloads, logs, retry and remove buttons. The gap it doesn't cover
is the *document-centric* view — "this document is stuck at `text_ready`, re-run it from
there" — because it's organized by job, not by document.

Scope your UI to that gap and you'll write a fraction of the code. Mounting Bull Board in an
iframe for the queue view is a legitimate choice.

Default port is 3100 (`PORT` overrides). There is **no global prefix** — routes are at the
root, not under `/api`.

---

## 2. The pipeline auto-chains — you almost never trigger a middle stage

Each worker enqueues the next on success. The only entry point in normal operation is
`detect`:

```
POST /detection/trigger
  └→ detect   "poll-source"      writes ingest_documents
      └→ fetch   "fetch-document"   bytes → object storage
          └→ extract-text  "extract-text"     cleaned segments → object storage
              └→ extract-events "extract-events"  → ingest_extractions  [costs money]
                  └→ validate      "validate-document" → ingest_event_candidates
                      └→ publish   "publish-document"  → sources/locations/events
```

Exact enqueue sites, if you need to verify behavior:

| From             | File                                                        | Condition                    |
| ---------------- | ----------------------------------------------------------- | ---------------------------- |
| `detect`         | `detection.service.ts:222`                                  | per new/changed document     |
| `fetch`          | `fetching.service.ts:120`                                   | always on success            |
| `extract-text`   | `text-extraction.service.ts:172`                            | always on success            |
| `extract-events` | `event-extraction.service.ts:139`                           | always on success            |
| `validate`       | `validation.service.ts:220`                                 | **only if `toPublish > 0`**  |

That last row matters for your UI. A document sitting at status `validated` with nothing
published is **not stuck** — the validator judged every event as `review` and correctly
declined to enqueue `publish`. Rendering it as an error will send you chasing a bug that
isn't there. Cross-reference `/review` before calling anything stalled.

---

## 3. The trap: deterministic job IDs make a naive "re-run" button do nothing

This is the single most important thing on this page.

Every stage past `detect` derives its job ID from the document ID (`libs/queue/src/queue.service.ts`):

```ts
fetchJobId(documentId)         // "fetch-<uuid>"
extractTextJobId(documentId)   // "extract-text-<uuid>"
extractEventsJobId(documentId) // "extract-events-<uuid>"
validateJobId(documentId)      // "validate-<uuid>"
publishJobId(documentId)       // "publish-<uuid>"
```

That's deliberate — it's the queue-layer half of idempotency (the database's unique index on
`(source_id, external_id)` is the other half). **BullMQ refuses to add a job whose ID already
exists in the queue, and does so silently — `queue.add()` resolves normally and returns the
*existing* job.**

So a re-run button implemented as `queue.add(name, { documentId }, { jobId })` will:

- return HTTP 200
- log a job ID
- show the user a success toast
- **do absolutely nothing**, because the old completed-or-failed job still holds that ID

The correct pattern is remove-then-add, exactly as `scripts/queue-requeue.ts` does it:

```ts
const jobId = buildJobId(documentId);
const existing = await queue.getJob(jobId);
if (existing) await existing.remove();
await queue.add(queueName, { documentId }, { jobId, ...JOB_OPTIONS_BY_QUEUE[queueName] });
```

Two related rules:

- **Job IDs must not contain `:`.** BullMQ reserves the three-part colon shape for repeatable
  jobs and throws on anything else. `assertUsableJobId()` guards this — use the builders, don't
  hand-roll ID strings.
- **The ad-hoc detect trigger deliberately passes no `jobId`.** The scheduler's per-source jobs
  use deterministic IDs (`detectSchedulerId`), so reusing one would collapse a manual trigger
  into the pending scheduled tick. If you add a "poll now" button, don't "fix" this by adding an ID.

`queue:requeue` currently only has builders for `fetch`, `extract-events`, and `publish` —
`extract-text` and `validate` are missing from its `JOB_ID_BUILDERS` map even though the ID
builders exist. You'll want all five.

---

## 4. Queue contracts

Names — `QUEUE_NAMES` in `libs/queue/src/queue.constants.ts`:

| Constant         | Queue name         | Job name            | Payload                             |
| ---------------- | ------------------ | ------------------- | ----------------------------------- |
| `DETECT`         | `detect`           | `poll-source`       | `{ sourceKey, lookbackDays? }`      |
| `FETCH`          | `fetch`            | `fetch-document`    | `{ documentId }`                    |
| `EXTRACT_TEXT`   | `extract-text`     | `extract-text`      | `{ documentId, force? }`            |
| `EXTRACT_EVENTS` | `extract-events`   | `extract-events`    | `{ documentId, modelRun? }`         |
| `VALIDATE`       | `validate`         | `validate-document` | `{ documentId, modelRun? }`         |
| `PUBLISH`        | `publish`          | `publish-document`  | `{ documentId, modelRun? }`         |

**Payloads carry identifiers, never content.** A job resumed after a restart reads current
state rather than a stale snapshot, and multi-MB document text stays out of Redis. Don't add
content fields to these.

Three optional fields are useful UI affordances:

- **`force` on `extract-text`** — re-clean even when the stored artifact is already at the
  current `EXTRACTOR_VERSION`. This is how you test a cleaning-rule change against one document
  without bumping the version for the whole corpus. Good "Re-clean this document" button.
- **`modelRun` on `extract-events`** — resume an interrupted extraction, skipping chunk indices
  already recorded in `ingest_extractions`. Worth surfacing, since re-running from scratch costs
  real money at the model.
- **`modelRun` on `validate`/`publish`** — pick which extraction run to act on. Defaults to most recent.

Retry budgets are per-stage and intentionally non-uniform (`JOB_OPTIONS_BY_QUEUE`): `fetch` and
`publish` get 5 attempts (patient with flaky third-party archives and geocoder rate limits),
`extract-text`/`validate`/`detect` get 3, `extract-events` gets 3 with a 15s backoff because
each attempt costs money. **Always spread `JOB_OPTIONS_BY_QUEUE[queue]` when enqueueing** —
a re-enqueue with default options silently gives the job `attempts: 1`.

---

## 5. Document state machine

`DOCUMENT_STATUSES` in `packages/domain/src/ingestion.ts` is the runtime source of truth; the
TS union derives from it. Import the array — don't retype the list, that drift is exactly what
`verify-database.ts` exists to catch.

```
discovered → fetching → fetched → extracting_text → text_ready
  → extracting_events → events_ready → validating → validated → published
                                                               ↘ skipped
                                                               ↘ failed
```

Terminal: `published`, `skipped`, `failed` (`TERMINAL_DOCUMENT_STATUSES`).

**`skipped` is not a failure.** A scanned page with no OCR layer fetched perfectly well and
simply has no text. Retrying can never succeed. Style it as neutral, not red, and don't offer
a retry button that can only ever burn the budget again.

Per-stage retry counters on `ingest_documents` are `fetch_attempts`, `text_attempts`,
`extract_attempts`, `validate_attempts`, `publish_attempts` — note the naming is not uniform
with the stage names. Timestamps: `detected_at`, `fetched_at`, `text_ready_at`, `extracted_at`,
`validated_at`, `completed_at`. `published_at` on a **document** means when the *source*
published it, not the pipeline — `completed_at` is the pipeline one. Easy to render wrong.

### Where to re-enter after a failure

| Status at failure  | Re-run queue     | Costs money? |
| ------------------ | ---------------- | ------------ |
| `discovered`       | `fetch`          | no           |
| `fetched`          | `extract-text`   | no           |
| `text_ready`       | `extract-events` | **yes**      |
| `events_ready`     | `validate`       | no           |
| `validated`        | `publish`        | no           |

A "retry from current stage" button is just this table plus the remove-then-add from §3.
Consider confirming before anything in the money row.

---

## 6. Data model for the views you'll render

**`ingest_sources`** — `key` (joins to a `SourceAdapter` in code, by string — rename one
without the other and the source silently stops polling), `display_name`, `enabled`,
`poll_cron` (null = `DEFAULT_DETECT_CRON`, `0 3 * * *`), `lookback_days`, `metadata`.

An enable/disable toggle and a cron editor are high-value, low-risk first features — they're
plain column writes on a small table, and `detection-trigger.controller.ts` already reads
`enabled` when fanning out.

**`ingest_documents`** — the state machine above. The listing endpoint has an explicit `select`
list because documents are large; keep any endpoint you add equally disciplined.

**`ingest_extractions`** — per-chunk extraction checkpoints keyed by `model_run`. This is what
makes a resumed extraction skip completed chunks.

**`ingest_event_candidates`** — one row per extracted event plus the validator's verdict.

- `verdict`: `"publish" | "review"`
- `checks`: `ValidationCheck[]` — **every** check, passed and failed, including non-gating
  ones. `{ name, passed, gating, detail? }`. The grounding check (does the quoted `sourceText`
  actually appear in the document) is recorded but **not gating** on purpose — it's the
  strongest hallucination signal available and the threshold should come from evidence.
  Rendering `gating` vs non-gating distinctly is the whole point of this column; a UI that
  shows only pass/fail throws away the reason it exists.
- `event`: the full `ExtractedEvent` as JSONB
- `event_key`: unique — the deterministic ID this event will carry on the map
- `resolved_at` / `published_at`: nullable, currently only ever read

Those last two columns are the schema hook for an approve/reject flow that **does not exist
yet**. `DocumentsController` is deliberately read-only: *"why has nothing appeared on the map"
should be answerable without shell access, not fixable from a browser.* If you build approval,
you're reversing a stated design decision — fine, but do it knowingly, and note that
`event_key`'s uniqueness means an approved candidate can be published under the ID the pipeline
would have used anyway.

---

## 7. Gaps you'll have to fill

Nothing below exists today.

| Need                             | Why it's missing                                        |
| -------------------------------- | ------------------------------------------------------- |
| Re-run a stage for one document  | Only `scripts/queue-requeue.ts` (CLI, and only 3 of 5)  |
| Queue depth as JSON              | Only via Bull Board's HTML                              |
| Source CRUD / enable toggle      | Only `scripts/seed-sources.ts`                          |
| Single-document detail           | Listing only; no `GET /documents/:id`                   |
| Candidate approve/reject         | Read-only by design — see §6                            |
| Geocode review + correction      | Only `scripts/geocode-review.ts`                        |

Sketch for the one you'll definitely want:

```ts
// apps/api/src/documents/requeue.controller.ts
@Post("documents/:id/requeue")
@HttpCode(202)
async requeue(@Param("id", ParseUUIDPipe) id: string, @Body() dto: RequeueDto) {
  const queue = this.queues[dto.queue];                   // validate against QUEUE_NAMES
  const jobId = JOB_ID_BUILDERS[dto.queue](id);
  await (await queue.getJob(jobId))?.remove().catch(() => undefined);
  await queue.add(JOB_NAME_BY_QUEUE[dto.queue], { documentId: id, ...dto.extra },
                  { jobId, ...JOB_OPTIONS_BY_QUEUE[dto.queue] });
  return { requeued: true, jobId };
}
```

Queue depth is cheap to expose and the best single health signal:

```ts
@Get("queues/counts")
async counts() {
  return Object.fromEntries(await Promise.all(
    Object.values(QUEUE_NAMES).map(async (n) => [n, await this.queues[n].getJobCounts()]),
  ));
}
```

`getJobCounts()` returns `{ waiting, active, completed, failed, delayed, paused }`.

---

## 8. Wiring the frontend — read this before choosing where it lives

**The Nest API calls neither `enableCors()` nor `setGlobalPrefix()`.** A browser page served
from `:3000` calling `:3100` directly will be blocked by CORS on every non-simple request,
which presents as an opaque network error with a perfectly healthy server.

Two ways out, and the second is better:

1. Add `app.enableCors({ origin: ... })` in `apps/api/src/main.ts`. One line, but it puts an
   unauthenticated write surface on a separate origin and you own the origin allowlist forever.
2. **Build the UI as Next routes under `/admin`, and proxy through Next route handlers**
   (`app/api/admin/[...path]/route.ts` → `fetch("http://localhost:3100/...")`). Same origin, so
   no CORS at all; the Nest API never needs to be browser-reachable; and you inherit
   `middleware.ts` (rate limiting, CSP nonce, bot filter) for free. It also matches how the
   rest of the app already talks to data.

If you proxy, remember `/api/data/*` treats a **missing** `MAP_API_KEY` as "allow" — so gate
any admin proxy on its own secret rather than assuming the existing pattern is closed. An
unguarded admin proxy on a deployed Vercel URL is an open pipeline-trigger endpoint.

Also note the Nest API and the web app must share one `POSTGRES_URL`. A worker or API pointed
at a different database ingests happily into a void, with no error anywhere.

### Auth

The only auth in the ingest API today is HTTP Basic on Bull Board, and it **fails closed** —
no `BULL_BOARD_PASSWORD` means 503, not an open dashboard. `basic-auth.middleware.ts` has a
length-padded constant-time compare you can reuse; copy the whole approach rather than
`===`-ing a token.

Whatever you add, fail closed the same way. An admin UI that degrades to "no auth configured,
allow everything" is worse than one that refuses to start.

---

## 9. Things that look like bugs and aren't

- **`Forbidden` from `curl` against the Next app.** `middleware.ts` blocks bot-ish
  User-Agents; `curl` matches. Send a browser UA when testing by hand. `/api/mcp` is the only
  exempt route. (The Nest API on :3100 has no such filter.)
- **A trigger returns 202 and nothing happens.** The workers are separate processes. `detect`
  must be running or the job just sits in `waiting` forever. Check `/queues` or
  `npm run queue:inspect --workspace=services/ingest -- --queue=detect --state=waiting`.
- **A re-run reports success and changes nothing.** §3.
- **Document at `validated`, nothing on the map.** Validator sent everything to review. §2.
- **Bull Board returns 503.** No `BULL_BOARD_PASSWORD`. Intentional.
- **`nest build <app>` wiped the other bundles.** `deleteOutDir` must stay `false` in
  `nest-cli.json` — the flag is per-invocation, not per-app.
- **Edits to the UI appear to do nothing.** Turbopack reuses chunk filenames across recompiles;
  see CLAUDE.md → "Debugging note — stale chunks" before believing any diagnosis.

---

## 10. Useful commands while building

```bash
# Verifiers — the first thing to run when something looks wrong
npm run db:verify      --workspace=services/ingest   # needs Postgres
npm run queue:verify   --workspace=services/ingest   # needs Redis
npm run sources:verify --workspace=services/ingest   # needs nothing

# Queue inspection (states: waiting|active|completed|failed|delayed)
npm run queue:inspect --workspace=services/ingest -- --queue=fetch --state=failed --limit=20

# The behavior your re-run endpoint must replicate
npm run queue:requeue --workspace=services/ingest -- --queue=fetch --document=<uuid>

# Geocoding review — treat as mandatory after a new corpus's first run
npm run geocode:review --workspace=services/ingest
npm run geocode:review --workspace=services/ingest -- --set=...

# Correctness gate (lint is broken — next lint was removed in Next 16)
npm run type-check --workspace=services/ingest
```

Workers, one process each. Note that `extract-text`, `extract-events`, and `validate` have
**no npm script** — `start:extract` refers to an app name that no longer exists:

```bash
npm run start:detect  --workspace=services/ingest
npm run start:fetch   --workspace=services/ingest
npm run start:publish --workspace=services/ingest
cd services/ingest && npx nest start extract-text   --watch
cd services/ingest && npx nest start extract-events --watch
cd services/ingest && npx nest start validate       --watch
```

Every app — workers included — serves `/health`. It reports process liveness and Postgres
reachability only, and deliberately **not** queue depth: a worker with a backlog is healthy,
just busy, and conflating the two makes an orchestrator restart the one process making
progress. If your UI shows per-worker health, give them distinct `PORT`s and don't
editorialize a backlog into a red light.
