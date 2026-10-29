# Repair the real-backend E2E suite and make it a merge gate

**Related:** [00-README.md](./00-README.md) (product track),
[25-product-backlog.md](./25-product-backlog.md) (bug fix #1, open question 3),
[30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (gated on e2e-real going green),
[26-wikidata-pilot.md](./26-wikidata-pilot.md) (the pilot that needs a trusted suite),
[34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md)
(alerts, not a substitute for a green suite),
[10-deployment.md](./10-deployment.md) (workers do not run on Vercel).

**Changelog:**
- 2026-10-29 - Created from the daily research loop. The mocked E2E suite
  is green and the real-backend suite has been red on main since Oct 19,
  yet no plan owns fixing it: the backlog carries it as bug fix #1 and
  plan 30 is explicitly gated on it, so every later plan that assumes a
  working suite is building on an unverified floor.

## Why this plan exists

The repo already has two Playwright suites, and only one of them can be
trusted today:

- `e2e/` (mocked, root `playwright.config.ts`): every data fetch mocked
  on purpose. Green. It proves the UI renders; it proves nothing about
  the database, the tiles, or S3.
- `e2e-real/` (`e2e-real/playwright.config.ts`, `npm run test:e2e:real`):
  real Postgres, real Martin-served MVT tiles, the real `/map` and
  `apps/admin` apps. Red on main since Oct 19, after PR #19 (the S3
  production-documents change). The backlog records the S3 change as the
  suspect, not the proven cause: that distinction matters, because
  fixing the wrong suspect leaves the suite red and burns the next
  debugging session on a theory nobody tested.

A red real-backend suite masks every later regression. The plan 26 pilot
publishes to the public map; plan 30's viewport + time-window fetching
is gated on this suite going green for exactly that reason. Until it is
green, "the pipeline works" is a claim the repo cannot check, and plan
34's alerts watch the queues, not the map the user actually sees.

## What the suite looks like today (verified Oct 29)

- `e2e-real/playwright.config.ts`: `fullyParallel: false`, `workers: 1`,
  two projects (`map` on port 3000, `admin` on port 3011 to dodge the
  Martin port collision), `retries: 2` on CI only, `trace:
  "on-first-retry"`, and two `webServer` entries (`npm run dev` and
  `npm run dev --workspace=@historical-map/admin -- -p 3011`).
  Serialization is deliberate, not an accident: the specs share one
  fixture dataset with no per-test DB isolation, so parallel workers
  would race each other mutating the same rows. Do not "fix" this by
  turning parallelism on.
- `e2e-real/global-setup.ts` + `scripts/reset-test-db.ts`: the suite
  truncates `sources`, `locations`, `events`, `event_groups`,
  `event_group_members` (plus `ingest_*` tables with `--with-ingest`)
  and reseeds a fixture dataset, behind the `ALLOW_TEST_DB_RESET=1`
  guard. There is no separate test database: Martin's `DATABASE_URL`
  in `docker-compose.yml` is hardcoded to the same `db` database the
  dev server uses, so running the suite locally destroys local map
  data unless `npm run db:backup` ran first. The config already
  accepts `E2E_POSTGRES_URL` / `E2E_MARTIN_URL` overrides for an
  isolated stack, but the Martin half of that override is not wired
  through: Martin still reads the hardcoded database.
- `.github/workflows/e2e.yml` (PR + push to main): starts `db`, `redis`
  and `minio-ci` from `docker-compose.yml` + `docker-compose.ci.yml`,
  waits on Postgres, Redis and the S3 mock, runs
  `npm run db:ensure-schema` *before* starting Martin (Martin discovers
  SQL functions from the Postgres catalog once at boot and never picks
  up later ones, so starting it early serves empty tiles for its whole
  lifetime), runs ingest migrations, builds the MCP bundle, then runs
  the mocked suite, the real suite, and the ingestion fixture test in
  one job, sequentially.
- `docker-compose.ci.yml`: `minio-ci` is `adobe/s3mock:5.2.3`, not real
  MinIO (real MinIO images require an authenticated pull that fails on
  a GitHub-hosted runner), auto-creating the `ingest` bucket, on port
  9000. It implements the plain PutObject/GetObject/HeadObject surface
  in `services/ingest/libs/storage/src/s3-storage.service.ts`, which is
  the whole S3 surface the repo uses. Local dev keeps real MinIO.
  That local-vs-CI storage divergence is a live suspect for a
  PR #19 regression, alongside plain S3 config (endpoint, bucket,
  credentials) in the real suite's environment.

## Step 0: triage before touching anything (half a day, not a rewrite)

1. Read the latest `.github/workflows/e2e.yml` run on main and the
   first failing spec, not the last: the first failure is the cause,
   later failures are usually cascade. Record the failing spec, the
   assertion, and whether it fails locally with
   `ALLOW_TEST_DB_RESET=1 npm run test:e2e:real` after
   `npm run db:backup`.
2. Bisect against PR #19 only: run the suite at the parent of the S3
   change and at its head. If the parent is green and the head is red,
   the suspect is confirmed and the diff is the search space. If the
   parent is also red, the S3 theory is dead and the cause is
   environmental (service startup order, Martin boot timing, port
   collision, fixture drift) - say so in the commit message and stop
   chasing S3.
3. Check the three known timing traps explicitly, because each has
   already bitten this repo once: Martin started before
   `db:ensure-schema` (empty tiles forever), the mocked and real
   suites run concurrently (both bind port 3000), and MinIO/s3mock
   not yet accepting connections when the first spec runs (the
   workflow's wait loop covers this in CI; a local run has no
   equivalent guard).

## Step 1: fix the proven cause, in the smallest diff that greens it

- If the cause is S3 config: fix the real suite's S3 environment
  (endpoint, bucket, credentials) in `e2e.yml` and document the
  local-MinIO vs CI-s3mock mapping in `e2e-real/README.md`, so the
  next person does not re-derive it. Add one spec that exercises the
  production-documents S3 path directly (Put, Get, Head through
  `s3-storage.service.ts`) instead of letting it fail incidentally
  inside a map spec, where the error reads as a map bug.
- If the cause is fixture drift: update `e2e-real/fixtures/db` to the
  current schema (the 44 curated events in `data/map-data.json` are
  not the fixture dataset and must not be conflated with it), not the
  specs to the old fixture.
- If the cause is a real product bug the mocked suite hid: fix the
  product code, and keep the failing spec as the regression test.
  That is the suite doing its job, not a suite problem.
- Whatever the cause, the fix lands with the failing spec green, not
  with the spec deleted, skipped, or moved to a quarantine list
  (see step 3 for when quarantine is legitimate).

## Step 2: give the suite its own database, so local runs stop destroying dev data

This is the structural fix, and it is what makes step 0 repeatable
without the `db:backup` ritual:

- Parameterize Martin's `DATABASE_URL` in a test compose override
  (a `db-test` + `martin-test` pair on distinct host ports, e.g. a
  second PostGIS on 5434 and Martin on 3002), and plumb the existing
  `E2E_POSTGRES_URL` / `E2E_MARTIN_URL` overrides in
  `e2e-real/playwright.config.ts` all the way through: test process,
  both `webServer` entries, and Martin. Today the config offers an
  isolated stack it cannot actually deliver; closing that gap is the
  whole step.
- `scripts/reset-test-db.ts` and `e2e-real/global-setup.ts` keep the
  `ALLOW_TEST_DB_RESET=1` guard unchanged: it now guards a database
  that nothing else uses, which is the point. Update
  `e2e-real/README.md` to the new invocation (test stack up, suite
  runs, dev database untouched) and delete the "back up first" warning
  only when the isolated stack is the default path, not before.
- CI keeps its current single-database shape (the runner's Postgres
  is already throwaway); the isolated stack is a local-dev fix, and
  saying otherwise would add CI complexity for no CI benefit.
- Out of scope: per-test DB isolation. The shared fixture dataset +
  serialized workers is a deliberate, documented tradeoff. Per-test
  isolation (fresh data per spec, or a database per worker) is the
  right move only when the suite outgrows serialization - measured by
  suite runtime, not by fashion - and it is a separate plan when that
  day comes.

## Step 3: make failures diagnosable and quarantinable, not invisible

- Split the single `e2e` job in `.github/workflows/e2e.yml` into two
  jobs (mocked, real) sharing the service-startup steps, so a red run
  names the suite that failed instead of "E2E failed" and the mocked
  suite's green does not have to wait on the real suite's red.
- Upload Playwright artifacts on failure for both jobs: traces
  (`trace: "on-first-retry"` is already configured), screenshots, and
  the HTML report as a workflow artifact. A failure with no artifact
  is a failure that gets re-run blind, which is how a red suite stays
  red for ten days.
- Quarantine policy, with an expiry date, not a graveyard: a spec that
  fails intermittently (passes on retry, fails on first attempt, no
  product cause found) moves to a `quarantine` project with the issue
  link and a 14-day expiry in its comment. On expiry it either returns
  to the main projects or is deleted with a reason, never silently
  left. A spec that fails deterministically is never quarantined: it
  is either fixed (step 1) or it blocks (step 4). Retries stay at 2
  on CI; raising retries to mask flake is prohibited by this plan.
- Keep the ingestion fixture test (`EXTRACTION_ENGINE=fake`) as its
  own step after the real suite, as today: it covers the pipeline
  path the Playwright suites do not, and folding it into either
  suite would confuse which system failed.

## Step 4: make green a gate, but only after a green streak

- Do not flip branch protection on while the suite is red: a required
  check that is always red blocks every PR and teaches everyone to
  ignore required checks, which is worse than no gate.
- Once the suite is green locally and in CI, require a streak first:
  green on main for five consecutive runs (or one week, whichever is
  longer), then make the real-suite job a required check for merging
  to main. Record the flip in the backlog (bug fix #1 closed) and in
  plan 30: its "gated on e2e-real going green" condition is then met,
  and plan 30's viewport + time-window fetching work is unblocked.
- The mocked suite stays required (or becomes required alongside) on
  its own merits; neither suite's status substitutes for the other's,
  because they test different things by design.

## Acceptance criteria

- [ ] `npm run test:e2e:real` green locally against the isolated test
      stack, without touching the dev database.
- [ ] `.github/workflows/e2e.yml` green on main, mocked and real jobs
      reported separately, failure artifacts uploaded.
- [ ] The PR #19 suspect is confirmed or cleared in writing (step 0
      bisect result), not left as folklore.
- [ ] `e2e-real/README.md` describes the isolated-stack invocation;
      the "back up first" warning is gone or explicitly retained with
      a reason.
- [ ] Zero deterministically-failing specs quarantined; any
      quarantined spec carries an issue link and a 14-day expiry.
- [ ] Backlog bug fix #1 and open question 3 closed; plan 30's gate
      note updated to reflect the green suite.
- [ ] No change to the mocked suite's config, no parallel workers, no
      second datastore, no Splink, no change to the 44 curated events
      (the fixture dataset is not the curated seed).

## Open questions for James

1. Isolated test stack locally (a second PostGIS + Martin on distinct
   ports) vs keeping the shared dev database with the backup ritual -
   is the extra compose surface worth it, or is the backup ritual
   acceptable now the suite is green?
2. Quarantine expiry: 14 days, or a shorter fuse, and who owns
   triaging a quarantined spec when it expires?
3. Once green, required check immediately or after the five-run
   streak - and should the mocked suite become required at the same
   time?
