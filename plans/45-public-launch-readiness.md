# Public launch readiness and go-live runbook

**Related:** [26-wikidata-pilot.md](./26-wikidata-pilot.md)
(the pilot data is what launches - no launch without validated
ingested events),
[30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (map UX at scale,
gated on e2e-real going green),
[31-shareable-map-state.md](./31-shareable-map-state.md) (shared
links are the first traffic a launch creates),
[35-e2e-real-repair-merge-gate.md](./35-e2e-real-repair-merge-gate.md)
(the green suite and the merge gate are launch prerequisites, not
nice-to-haves),
[37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md)
(curated-seed retirement runs as tombstone-then-purge, and no
published event is ever final),
[38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md)
(detail pages, sitemap, robots - the crawlable surface the launch
opens),
[40-accessible-map-experience.md](./40-accessible-map-experience.md)
and [42-mobile-map-experience.md](./42-mobile-map-experience.md)
(the launch must be usable, not just up),
[43-public-read-surface-protection.md](./43-public-read-surface-protection.md)
(the limiter, CDN cache, and pooler that stand between the launch
and the first crawl spike),
[44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md)
(the launch must be measured from minute one, or the first week
of real usage teaches nothing),
[25-product-backlog.md](./25-product-backlog.md) (step 21, open
questions 45-47).

**Changelog:**
- 2026-11-08 - Created from the daily research loop. Plans 30, 38,
  40, 42, 43 and 44 all say "before any public launch", but no plan
  defines what launch is: no gate, no release sequence, no rehearsed
  rollback, no runbook, no data floor, no go/no-go owner. This plan
  is the gate and the runbook - the last plan before the map goes
  public, and the one that turns "launch-ready" from a feeling into
  a checklist with evidence behind every item.

## Why this plan exists

Three facts, none of which any existing plan covers:

- **"Before launch" is not a plan.** Six plans defer work to a
  launch that has no owner, no checklist, and no decision point.
  Without this plan, launch happens the day somebody feels like
  announcing it - with the e2e-real suite possibly still red, the
  curated seed possibly still live as the public corpus, and no
  rehearsed way back. The launch gate exists so that the decision
  is made on evidence, in the open, by James - not by momentum.
- **This launch is a data launch as much as a code launch.**
  Shipping the 44 curated events as the public corpus would
  contradict the standing directive to delete them, and launching
  with zero ingested events would be an empty map. The code can
  be perfect and the launch still wrong if the data state is
  wrong, so the gate checks data (pilot published, seed retired,
  sitemap submitted) with the same strictness as code.
- **Rollback is asymmetric, and that asymmetry is the risk.**
  Vercel's instant rollback restores code in seconds - promote a
  previous deployment, no rebuild. It does not roll back
  migrations, and it does not roll back published data. A launch
  without a rehearsed rollback is a rehearsal of failure in front
  of the first real audience. The rehearsal in section 3 exists so
  the first time anyone runs the rollback is not during an
  incident.

## What ships

### 1. The launch gate (go/no-go checklist)

Every item needs evidence - a run, a log, a screenshot - not a
checkbox ticked from memory. James is the go/no-go owner; any
item may be waived only by him, in writing, with the waiver
recorded next to the item.

**Code and CI**
- e2e-real green on main (plan 35) and flipped to a required
  check; the mocked suite green alongside it. A red real-backend
  suite at launch means regressions are invisible from day one.
- `main` branch-protected: merges only through a PR, required
  checks passing. Preview deployments verified on a recent PR
  (the preview caught the issue before merge, at least once, on
  record).
- Zero open P0/P1 issues. Zero open issues today (2026-11-08);
  keep it that way at launch, and any issue opened between now
  and launch is triaged into the gate, not waved past it.

**Data**
- Plan 26 pilot validated and published: ingested events live on
  the map, through detect -> fetch -> extract -> validate ->
  publish, with the curated-events spot-check passed.
- The 44 curated events retired per plan 37: tombstoned, their
  detail pages noindex/410 per plan 38, purge after the
  tombstone window - not live as the public corpus.
- A launch data floor is met: a minimum published-event count
  from at least two sources (open question 47 sets the numbers).
  A map with one source is a demo, not a launch.
- Sitemap generated from the database (plan 38) and submitted to
  the search engines; robots.txt live and verified against the
  plan 43 crawler posture.

**Read surface and measurement**
- Plan 43 live: per-endpoint limits on, CDN cache with purge on
  publish verified by an actual publish-then-check, transaction
  pooler in front of RDS, AI-crawler posture decided (open
  question 41).
- Plan 44 live: analytics receiving events, the server-side
  search event verified on a real query, the weekly zero-result
  review scheduled with an owner.

**Accessibility, mobile, content**
- Plans 40 and 42 acceptance criteria met on real devices, not
  only in the mocked suite: keyboard-only session, screen-reader
  pass, a phone-sized session with the bottom sheet.
- `/sources` page live (plan 33) with every adapter's license
  declared; privacy notice accurate for plan 44's instruments;
  no copyrighted text from link-only sources anywhere (plan 28).

**Backups (the item no plan owned until now)**
- RDS automated backups on with a stated retention window, and
  S3 versioning on for the production documents bucket (PR #19).
  A restore drill has been done once before launch: restore to a
  scratch instance, verify event counts against production, then
  tear the scratch instance down. A backup that has never been
  restored is a hope, not a backup. The drill is repeated after
  any change to the backup configuration.

### 2. The release sequence

Ordered, each step with a named owner and a verify step. The
sequence is the same for launch and for every later release;
launch is just the first time it runs under pressure.

- **T-7d:** Scope freeze. The launch branch list is cut; nothing
  merges after this except fixes to gate items. If a custom
  domain is in play (open question 45), DNS TTL is lowered to
  300s now, not on launch day.
- **T-2d:** Rehearsal. The full runbook (section 4) runs against
  a preview deployment, including the rollback step in section 3
  and a restore-to-scratch verification. Findings are recorded
  in this plan's changelog; a rehearsal that finds nothing was
  not run properly.
- **T-0:** Migrations first, then code. Vercel auto-deploys on
  the merge to `main`; the deploy is not "done" until the smoke
  test passes: the map loads, a search returns results, a pin
  opens, a plan 38 detail page returns 200, a plan 31 share
  link restores the view, the sitemap is reachable. Then purge
  the CDN cache, then verify plan 44 is receiving events.
- **Migrations are backward-compatible with the previous code
  version.** During a Vercel deployment the old and new versions
  run side by side for seconds; new code on an old schema breaks
  in that window. Destructive migrations (a dropped column, a
  renamed table) ship as a separate, later deploy, after the new
  code has proven stable - never bundled with the launch.
- **No feature flags exist in the repo today, so the release is
  all-or-nothing.** That is recorded here as a known gap, not
  silently accepted: plan 44 deferred flags, and if James wants
  a flag for the launch, that is a separate decision with its own
  plan, not smuggled into this one.

### 3. Rollback and recovery

- **Code rollback (seconds):** Vercel dashboard -> Deployments
  -> the last known-good deployment -> Promote to Production.
  No rebuild; the artifact already exists. Follow it with a
  `git revert` of the breaking change and a push, so the next
  push does not reintroduce the bug - a rollback without the
  source fix is a pause, not a fix.
- **Database:** there is no automatic rollback. An RDS snapshot
  restore is for data corruption only, never as a code rollback
  (it would destroy published events created since the
  snapshot). Publish-state mistakes roll back through plan 37's
  version rows and tombstones, not through a restore.
- **Rehearsed once before launch** as part of the T-2d
  rehearsal, with the exact commands written in the runbook -
  not figured out mid-incident. The rehearsal includes the
  failure mode most teams skip: rolling back code that shipped
  with a migration, and confirming the old code still runs
  against the new schema (which is why section 2 requires
  backward-compatible migrations).

### 4. The launch-day runbook

One document, one timeline, one owner per step, one decision
channel. The runbook itself lives as `docs/launch-runbook.md`,
created by the coding agent that executes this plan from the
sections above - it is an operational document, not a design
doc, and it is not written by hand in this plan file. It
contains:

- The timeline: T-2h (final gate re-check, all items green),
  T-1h (deploy window opens, comms drafted), T-0 (merge,
  migrate, smoke test, cache purge, analytics check), T+1h
  (smoke re-check, error-log review), T+24h (checkpoint:
  errors, analytics, zero-result rate, crawler log).
- A named owner for every step. James owns go/no-go; the
  deployer owns the merge and the smoke test; nobody owns a
  step by default.
- **Abort criteria, decided in advance:** any smoke check fails,
  the analytics check shows nothing arriving, or the error rate
  spikes in the first hour - roll back per section 3, announce
  the delay, no heroics. A launch delayed by a day is a story;
  a launch rolled back in public is a different one.

### 5. Post-launch week

- **T+24h checkpoint** with a written note: error counts, top
  pages, search zero-result rate, crawler visits, any reader
  corrections (plan 39) filed. The announcement - if there is
  one - waits until this checkpoint passes (open question 46).
- **First-week review** using plan 44's loop: the ranked
  zero-result intents become the first post-launch source
  prioritisation, not a guess.
- Known defects found in the first week are triaged into the
  plan 25 backlog as bug fixes or deferred items, in the open,
  with the same evidence rule as the gate. Launch is the start
  of operating the map, not the end of building it.

## What this plan does not do

- No new feature, no code, no infrastructure change by itself.
  It sequences and gates other plans; the work is theirs.
- No marketing or announcement copy, and no social posts. The
  announcement decision (open question 46) is James's; the
  copy is his.
- No feature-flag system. Deferred with plan 44; if the launch
  needs one, that is a later plan with its own design.
- No persistent staging environment build-out. Today there is no
  recorded staging deployment - PR preview deployments are the
  pre-production check. If James wants a persistent staging
  environment with its own database, that is a separate plan,
  not a line in this one.
- No load testing beyond the smoke test and plan 43's limits.
  A load test earns its own plan only if the announcement is
  expected to spike traffic; a quiet launch (open question 46)
  does not need one.

## Sequencing

After plans 26 (pilot data - nothing launches without it), 30
(gated on e2e-real), 35 (green suite and merge gate), 37 (seed
retirement), 38 (pages and sitemap), 40, 42, 43 and 44. This is
the last plan before the public launch. The pilot can run, and
the map can be shared privately, before this gate is met - the
gate is for the public, not for James's own testing. Not a plan
26 pilot blocker.

## Acceptance criteria

- The gate checklist in section 1 exists with a pass/fail and an
  owner per item, and every pass has evidence behind it (a run,
  a log, a screenshot) - not a checkbox ticked from memory.
- The T-2d rehearsal ran end to end, including a Vercel rollback
  and a restore-to-scratch verification, and its findings are
  recorded in this plan's changelog.
- The launch-day runbook (`docs/launch-runbook.md`) is written
  from section 4, with the timeline, named owners, abort
  criteria, and the exact rollback commands - and James has
  reviewed it.
- The launch data floor is met: pilot published, curated seed
  retired, sitemap submitted, analytics receiving.
- The T+24h checkpoint completed with a written note, and the
  announcement (if any) waited until it passed.
- A normal launch-day session - load the map, search, open a
  pin, follow a plan 31 share link, open a plan 38 detail page -
  passes the smoke test and never trips plan 43's limiter.
- No Splink anywhere in this plan's implementation or text:
  dedup remains blocking plus Jev pairwise judging per the
  2026-10-23 decision, and this plan touches no dedup code.
- The 44 curated events get no special treatment: they are
  slated for deletion per the standing directive, and a launch
  that ships them as the public corpus fails the gate.

## Open questions (carried to the backlog as 45-47)

45. Launch domain: a dedicated domain or subdomain (for example
    map.jamesmcdougalljr.com) for v1, or the Vercel project URL?
    And who owns the registrar / DNS change - James, or the agent
    with his credentials?
46. Soft launch (quiet, no announcement, watch plan 44's
    analytics for a week and announce only after the T+24h
    checkpoint passes) or an announced launch day with a fixed
    date?
47. Launch data floor: a minimum published-event count and
    source count before the map is worth announcing (for
    example, 500 events from 2+ sources), or launch as soon as
    the pilot validates, regardless of count?