# Phase 16 — Redis-backed rate limiting for the geocoder retry path

**Status: design only — not implemented.** Written up after a real ingest run
against RDS got stuck for the last ~22 of ~370 event candidates on Nominatim
429s that kept recurring across five job retries. This document explains why,
and lays out a plan to fix it properly. No code here — the intent is that
this gets implemented by hand, using this as a spec.

## What actually happened (the incident this is written from)

Publishing `short_history_of_mexico.pdf`'s ~370 candidates against RDS:

1. Most candidates geocoded fine. A batch of requests hit Nominatim fast
   enough that it started returning 429.
2. BullMQ retried the whole `publish` job per `PUBLISH_JOB_OPTIONS`
   (`attempts: 5`, exponential backoff starting at 5s).
3. Each retry re-hit Nominatim immediately once it started, with no
   awareness that the previous attempt had just been told to slow down —
   so the retries kept landing inside Nominatim's own cooldown window and
   kept getting 429'd, attempt after attempt.
4. Manually requeueing (`queue:requeue`) had the same problem: it's a fresh
   set of BullMQ attempts, but with zero memory of the fact that Nominatim
   was still upset from the last round.

The pacing logic that exists today (`respectRateLimit()` in both
`WhgGeocoder` and `NominatimGeocoder`, `services/ingest/libs/geocoding/src/`)
only prevents *our own* requests from being too close together **within one
process**. It does nothing to prevent hammering a provider that has already
issued a temporary ban, and it has no memory across a job retry, a container
restart, or (if `publish` is ever scaled beyond one replica) across workers.

## Current architecture (as-is, confirmed by reading the code)

**Redis connection.** `services/ingest/libs/queue/src/queue.module.ts`
constructs the BullMQ Redis connection from `REDIS_HOST`/`REDIS_PORT` via
`BullModule.forRootAsync`. Nothing exports a reusable `ioredis` client —
`@nestjs/bullmq` builds its own internally, and `libs/queue/src/index.ts`
doesn't re-export one. Anything new needing Redis has to open its own
connection from the same env vars, or `QueueModule` needs to be extended to
export a shared client.

**Job retry config.** `PUBLISH_JOB_OPTIONS` in
`libs/queue/src/queue.constants.ts`:

```ts
export const PUBLISH_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: 5_000,
};
```

The doc comment above it says the quiet part out loud: *"The expected
failure is a geocoder rate limit, which clears on its own."* That assumption
is what today's design leans on entirely — there's no active cooperation
between the retry schedule and what the geocoder actually knows about the
rate limit, just a fixed backoff and hope.

**Job granularity.** One BullMQ `publish` job = one document
(`publishJobId = documentId`, in `queue.service.ts`). `PublishingService.publish()`
loops over every unpublished candidate for that document in one job
execution. If any single candidate's `GeocodingService.resolve()` call
throws, the exception propagates out of the loop, the whole job fails, and
BullMQ reschedules the **entire remaining batch** — not just the one
candidate that failed. Candidates already published earlier in the same loop
keep their `publishedAt` timestamp (safe), but a job that dies on candidate
200 of 370 still has to wait out the job-level backoff before candidate 201
gets tried again, even though 200 succeeded fine.

**Per-provider pacing (the thing to replace).** Identical shape in both
`WhgGeocoder` and `NominatimGeocoder`:

```ts
private lastRequestAt = 0;

private async respectRateLimit(): Promise<void> {
  const elapsed = Date.now() - this.lastRequestAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  this.lastRequestAt = Date.now();
}
```

`lastRequestAt` is an instance field on a NestJS singleton — process-local,
lost on restart, and (today theoretical, but worth designing for) not shared
if `publish` is ever scaled to more than one replica. The processor's own
doc comment already flags this: *"the geocoder is limited to roughly one
request per second and its throttle is per-process, so extra workers queue
behind each other rather than adding throughput"* — which is optimistic
phrasing for "extra workers would actually multiply real request rate
against Nominatim beyond their policy limit."

**No Retry-After awareness, no circuit breaker.** Both geocoders throw a
plain `Error` on any non-2xx response:

```ts
// nominatim.geocoder.ts
throw new Error(`geocoder returned ${response.status}`);
// whg.geocoder.ts
throw new Error(`whg geocoder returned ${response.status}`);
```

No distinction between "retry immediately" and "back off hard," no reading
of the `Retry-After` header, and nothing recorded anywhere that a 429 just
happened — so the very next call (whether from a BullMQ retry or the next
candidate in the same loop) has no idea it should wait.

**The pattern that already exists and should be mirrored.**
`services/ingest/libs/extraction/src/groq/groq.engine.ts` solves almost
exactly this problem for Groq, in-process:

```ts
class RetryableGroqError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RetryableGroqError";
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

if (response.status === 429 || response.status >= 500) {
  throw new RetryableGroqError(detail, parseRetryAfter(response.headers.get("retry-after")));
}
```

...paired with a retry loop that honors `retryAfterMs` when present, falling
back to its own exponential schedule otherwise. This is the right shape —
the gap is that it's in-process only (per `TokenBucket`'s own doc comment,
which *already* names Redis as the fix for exactly this class of problem)
and geocoding doesn't have an equivalent at all yet.

**BullMQ's built-in `limiter` option isn't used anywhere** in
`services/ingest` (confirmed by grep), and wouldn't fit this problem even if
it were — it throttles how many *jobs* start per window, not HTTP calls
made *inside* one job's internal loop, which is where geocoding actually
happens.

## Design goals

1. **Shared pacing across processes**, replacing `lastRequestAt` — so
   pacing survives a restart and would stay correct if `publish` is ever
   scaled to more than one replica.
2. **A circuit breaker per provider**: when a 429/5xx comes back, record a
   cooldown in Redis (honoring `Retry-After` when present, falling back to a
   sane default). Every call checks the cooldown *before* making a request —
   a call made during an active cooldown should fail fast without touching
   the network, not go make the ban worse.
3. **Retry-After-aware backoff**, mirroring `RetryableGroqError`/
   `parseRetryAfter` almost verbatim.
4. **Per-candidate failure isolation** in `PublishingService`, so one
   currently-uncooperative candidate doesn't re-queue 199 already-successful
   ones behind it. This is arguably the highest-leverage single change and
   is somewhat independent of the Redis work — worth doing regardless.
5. Keep it provider-agnostic: WHG and Nominatim should share the limiter
   implementation, keyed separately (they have independent rate limits and
   independent ban states).

## Proposed shape

New files under `services/ingest/libs/geocoding/src/rate-limit/` (naming is
a suggestion, not a requirement):

- **`redis-rate-limiter.ts`** — a small class wrapping either a hand-rolled
  Redis `INCR`+`EXPIRE`/Lua sliding-window, or `rate-limiter-flexible`'s
  `RateLimiterRedis` (see library choice below). Exposes something like:
  ```ts
  interface RateLimiter {
    /** Resolves once it's safe to make a request; may wait. */
    acquire(key: string): Promise<void>;
    /** Records a 429/5xx and its Retry-After, tripping the cooldown. */
    reportFailure(key: string, retryAfterMs?: number): Promise<void>;
    /** Throws immediately (no network call) if still cooling down. */
    checkCooldown(key: string): Promise<void>;
  }
  ```
  `key` would be `"nominatim"` or `"whg"` — one bucket + one cooldown flag
  per provider, stored in Redis so every process/replica shares them.

- **`geocoder.errors.ts`** (or add to the existing `geocoder.interface.ts`)
  — a `RetryableGeocoderError` class, structurally identical to
  `RetryableGroqError`, plus the same `parseRetryAfter` helper (small enough
  that duplicating it is fine; a shared `@app/http-retry` lib would be
  over-engineering for two call sites).

- **`WhgGeocoder`/`NominatimGeocoder` changes**: replace the
  `lastRequestAt`/`minIntervalMs`/`setTimeout` block with
  `await this.rateLimiter.acquire("whg" | "nominatim")`. On a non-2xx
  response, classify: 429/5xx → `reportFailure()` then throw
  `RetryableGeocoderError` with the parsed `retryAfterMs`; anything else
  (4xx other than 429) → throw a plain `Error` as today, since those aren't
  something waiting helps with.

- **`GeocodingModule` changes**: construct (or inject) the Redis client and
  the `RateLimiter`, provide it to both geocoder classes. Since
  `QueueModule` doesn't export a shared `ioredis` instance today, either:
  (a) extend `QueueModule` to export one (cleanest — one Redis connection
  policy for the whole app, `REDIS_HOST`/`REDIS_PORT` stay the single source
  of truth), or (b) have `GeocodingModule` open its own connection from the
  same env vars. (a) is the better long-term shape; (b) is less invasive if
  touching `QueueModule` feels out of scope for this change.

- **`PublishingService.publish()` change** (goal 4, and arguably the most
  valuable one on its own): wrap the per-candidate `geocoding.resolve(...)`
  call in its own try/catch inside the loop. On failure, log it, leave that
  candidate's `publishedAt` as `null` (already the case — nothing to
  change there), and `continue` to the next candidate instead of letting the
  exception abort the whole job. The document-level job should only be
  considered "failed" if *every* candidate in a pass failed, or some other
  signal indicates it's worth surfacing — worth deciding deliberately rather
  than defaulting to "any throw anywhere fails everything," which is today's
  accidental behavior.

- **(Stretch) dynamic BullMQ backoff.** BullMQ supports a custom backoff
  strategy function (registered via `Queue`/`Worker` options) that receives
  the thrown error and can compute a delay instead of using the fixed
  `{ type: "exponential", delay: 5_000 }`. If `RetryableGeocoderError`
  carries `retryAfterMs`, the backoff function can return exactly that
  instead of blind exponential — so a job-level retry (if one is still
  needed after goal 4 lands) waits precisely as long as the provider asked,
  not more, not less. Worth doing, but the per-candidate isolation (goal 4)
  removes most of the pressure that made this matter today.

## Library choice: `rate-limiter-flexible` vs. hand-rolled

- `bullmq` already pulls in `ioredis` (currently transitive — `ioredis` is
  not a direct dependency of `services/ingest/package.json` today, so this
  work should add it explicitly regardless of which path below is chosen).
- **`rate-limiter-flexible`** ships a `RateLimiterRedis` backend, is
  well-maintained, and handles the sliding-window/token-bucket math and
  Lua-script atomicity correctly out of the box — recommended default choice
  unless there's a reason to avoid a new dependency.
- **Hand-rolled** (a Lua script via `ioredis`'s `defineCommand`, or a plain
  `INCR` + `PEXPIRE` fixed window) is a reasonable alternative if minimizing
  dependencies matters more than saving the implementation time — the actual
  algorithm needed here (say, "N requests per second, shared across
  processes") is not complex enough to strictly require the library, but the
  circuit-breaker/cooldown flag (a simple `SET key value PX <ms> NX` /
  `GET`) is trivial either way and doesn't need the library at all.

Recommendation: **`rate-limiter-flexible` for the token-bucket pacing,
plain `ioredis` `SET ... PX ... NX` / `GET` for the cooldown flag** — no
need to force the cooldown logic through the rate-limiter library when two
Redis commands do it directly and transparently.

## Testing plan

- Extend `services/ingest/scripts/verify-geocoding.ts` (the existing mocked
  acceptance script, currently 22/22 green) with new checks:
  - Two `NominatimGeocoder`/`WhgGeocoder` instances sharing one Redis
    connection (or one `ioredis-mock` instance) enforce combined pacing —
    i.e. instance B's request is delayed by instance A's recent request,
    proving the limiter is genuinely shared rather than per-instance.
  - A mocked 429 with a `Retry-After` header trips the cooldown; a
    subsequent `geocode()` call within that window throws
    `RetryableGeocoderError` **without any `fetch` call being made** (assert
    the mock's call count doesn't increase) — proving the circuit breaker
    short-circuits rather than just retrying blindly.
  - `parseRetryAfter` unit-level cases (delta-seconds and HTTP-date forms),
    mirroring the coverage the Groq engine doesn't currently have inline
    (worth checking whether `groq.engine.ts` has its own test coverage for
    this already, and matching it).
- `ioredis-mock` (or a real local Redis via the existing `docker-compose.yml`
  `redis` service) for the shared-pacing test — a real Redis is simplest
  since one is already a dev dependency of this whole stack.
- Integration-level: re-run the exact scenario that surfaced this
  (`detect:trigger` against a corpus with an ambiguous-place-name-heavy PDF,
  under artificial rate-limit pressure) and confirm the `publish` job no
  longer aborts on the first 429 and doesn't re-hit the provider until the
  cooldown clears.

## Config

New env vars, following the existing `WHG_MIN_INTERVAL_MS`/
`GEOCODER_MIN_INTERVAL_MS` naming convention:

- `GEOCODER_COOLDOWN_DEFAULT_MS` — fallback cooldown when a 429 arrives with
  no `Retry-After` header (pick something conservative, e.g. 60_000).
- Reuse `REDIS_HOST`/`REDIS_PORT` for the limiter's connection — no new
  Redis instance or env vars needed unless isolating the limiter's keyspace
  from BullMQ's own (a `REDIS_DB` index, or a key prefix like
  `ratelimit:nominatim`) turns out to matter; a key prefix is simpler and
  sufficient.

## Non-goals for this pass

- Not touching `TokenBucket` (Groq's in-process TPM limiter) — its own doc
  comment already names Redis as a known future direction, but that's a
  separate, unrelated budget (tokens-per-minute for extraction, not
  requests-per-second for geocoding) and a separate change.
- Not changing `ingest-publish`'s replica count or adding horizontal
  scaling — this design makes scaling *safe* later, it doesn't itself
  require or introduce scaling now.
- Not introducing a message queue or additional infra between geocoding and
  publish — this stays inside the existing `publish` worker, using the
  Redis that's already a hard dependency of the whole ingest stack.
