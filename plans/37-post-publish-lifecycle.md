# Post-publish lifecycle: updates, corrections, retractions, and unmerges

**Related:** [09-publish-worker.md](./09-publish-worker.md) (the stage that
writes events and therefore must also rewrite them),
[06-detect-worker.md](./06-detect-worker.md) (change detection is a detect
job, not a new stage), [13-similarity-and-fusion.md](./13-similarity-and-fusion.md)
(merge decisions this plan can reverse),
[26-wikidata-pilot.md](./26-wikidata-pilot.md) (first source whose edits
will reach published events), [27-web-ingestor.md](./27-web-ingestor.md)
(re-fetching changed web sources), [28-britannica-link-only.md](./28-britannica-link-only.md)
(link-only records can change too, and the diff must stay link-only),
[29-source-expansion-dedup.md](./29-source-expansion-dedup.md) (Muffinlabs
refreshes daily, so its rows churn by design),
[31-shareable-map-state.md](./31-shareable-map-state.md) (old links must
resolve to something honest after a removal or split),
[32-fuzzy-dates.md](./32-fuzzy-dates.md) (date corrections re-run its
bounds mapping), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md)
(a revoked license is a lifecycle event, not a publish-time one),
[34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md)
(uncertain changes land here; lifecycle metrics ride its alerts),
[36-geoparsing-place-disambiguation.md](./36-geoparsing-place-disambiguation.md)
(place corrections re-run resolution),
[25-product-backlog.md](./25-product-backlog.md) (step 13, open questions
21-23).

**Changelog:**
- 2026-10-31 - Created from the daily research loop. No plan owned what
  happens after publish: every ingestion plan so far describes getting an
  event onto the map for the first time. Sources are living documents.
  Wikidata alone sees on the order of hundreds of thousands of edits a
  day, Muffinlabs refreshes daily, and a Jev merge decision can simply be
  wrong. Without a lifecycle design, the first source correction either
  never reaches the map, silently overwrites a human decision, or leaves
  a deleted event on the map forever. This plan closes that gap before
  the plan 26 pilot publishes anything.

## Why this plan exists

Publish is currently a one-way door in every plan that touches it. Plan 09
says "geocode, dedupe, write". Plan 13 fuses assertions into clusters.
Plan 34 queues what publish refuses to auto-approve. None of them says
what happens on the second pass over the same source row: when Wikidata
moves a date, when a gazetteer correction moves a pin, when two events
that were merged turn out to be two different battles, or when a source
entity is deleted outright.

Four concrete failures follow from that omission, all already reachable
from the backlog:

- **Stale pins and dates.** A Wikidata item edited after the pilot
  publishes keeps its old coordinates and EDTF bounds on the map, with
  nothing recording that the source moved on. The map quietly disagrees
  with its own cited source.
- **Uncorrectable merges.** Dedup is settled as deterministic blocking
  plus Jev pairwise judging (2026-10-23). Judges are wrong sometimes.
  Today there is no split procedure: no way to unmerge a cluster, keep
  the audit trail, and keep old links resolving.
- **Ghost events.** If a source entity is deleted or a license is
  revoked (plan 33), the published event has no removal path except a
  manual database edit, which leaves shareable links (plan 31) pointing
  at a row that simply vanished.
- **Overwritten human work.** Plan 34's review queue will accumulate
  manual approvals, corrected pins, and rejected merges. A naive
  re-ingest that replays the source over the published row destroys
  those decisions on the next sweep.

This plan is deliberately narrow. It does not redesign publish, dedup,
or review. It adds the second pass: detect a change, classify it,
re-run only the affected stages, record the version, and preserve
manual decisions.

## Change detection, per source

Detection is a detect job (plan 06), scheduled, not a new pipeline
stage and not a live stream in v1. At publish time, every published
event records, per contributing source assertion: the source's native
revision marker and a hash of the normalized payload the pipeline
actually consumed. The re-check sweep compares markers, never
re-extracts the whole corpus.

| Source | Revision marker | Re-check |
| ------ | --------------- | -------- |
| Wikidata (plan 26) | `lastrevid` from `wbgetentities`, plus payload hash | Weekly sweep over published QIDs only, batched; a changed `lastrevid` enqueues a change job. The public EventStreams mutation feed (`rdf-streaming-updater.mutation.v2`, operations `import` / `diff` / `delete` / `reconcile`) is the v2 upgrade, filtered to published QIDs; do not build the stream consumer for the pilot. |
| Muffinlabs (plan 29) | Daily feed payload hash per row | Each daily refresh diffs hashes; changed rows enqueue change jobs automatically. This is the highest-churn source and the cheapest diff. |
| Britannica link-only (plan 28) | Page existence + the short factual identifier, hashed | Re-check that the day page still exists and the identifier still matches. Link-only stays link-only through the diff: never fetch or store the page text to compare it, and never store a text hash as a workaround for storing text. A 404 or identifier change is a link event, handled below, not a content correction. |
| PDF / book corpus | File hash (S3 original, retained per the index locked decision) | A changed file hash enqueues re-extraction of changed chunks only, reusing stored originals rather than re-downloading. Books change rarely; this path is cheap precisely because it almost never fires. |
| Gazetteer corrections (plan 36) | Gazetteer row version in the local cache | A changed gazetteer entry re-runs resolution for events pinned through it, even when no source event changed. This is a place correction, not a source correction, and it records as such in the version history. |

**The settle rule.** Do not chase edit churn. Wikidata edits include
vandalism, reverts, and edit wars; one downstream pattern is to wait
out the storm (a week of quiet before merging a change is a published
approach for small Wikidata consumers). Adopt a bounded version: a
changed revision enqueues a change job immediately, but the job
re-checks the marker at run time and, if the entity changed again
within the last 7 days, defers itself once and re-queues. High-traffic
entities therefore settle before they republish; low-traffic entities
publish on the first pass. A change deferred three times goes to the
plan 34 review queue with its revision history attached, so a genuinely
fast-moving entity is a human decision, not an infinite deferral loop.
The 7-day window and the three-deferral cap are starting values for
James to confirm (open question 21), not constants to defend.

## Change classes and what each one does

| Change | Handling |
| ------ | -------- |
| Field correction (title, description, attribution) | Re-run extract for the changed source row only, re-publish the affected fields, record a version. No re-geoparsing, no re-judging, unless the changed field is a place or date. |
| Date correction | Re-run the plan 32 mapping (precision, circa / presumably / disputed flags, earliest / latest bounds) and re-derive the EDTF string and strict bounds. Timeline spans (plan 30) move with the new bounds. |
| Place correction | Re-run plan 36 resolution for the affected event only. The old pin stays in the version history; the map shows the new one. |
| Merge correction (split) | See "Unmerge" below. Scoped re-judging of the affected cluster only, never a full-corpus re-dedup. |
| Source retraction (entity deleted, page gone, feed row dropped) | If other independent sources still support the event, drop only that source's assertion and attribution, and re-derive the merged record from the survivors. If no source remains, tombstone the event (below), do not hard-delete it in v1. |
| License revocation or change (plan 33) | Re-run the plan 33 gate on the affected events. A newly undeclared or incompatible license holds the event in the review queue; it does not silently unpublish a multi-source event whose other sources still license it. |
| Manual override conflict | Any field carrying a manual-override flag (set by a plan 34 review approval or a direct correction) is skipped by automatic re-publish. The change job records the conflict and routes it to the review queue with both values side by side. The pipeline never overwrites a human decision by default. |

## Versioning: SCD2-lite, not full bitemporal

Do not build a bitemporal database for this. The questions the map
actually needs to answer are: what does the event say now, what did it
say before, why did it change, and which source revision caused it.
A full valid-time / transaction-time model (the XTDB-style design)
answers harder questions at a cost in storage, indexing, and query
complexity this project does not need yet. If James later needs
as-of queries ("what did the map show on 2027-03-01"), that is a
separate plan, not a reason to overbuild now.

- **Current row stays the read path.** The map, search, and API read
  the current events row exactly as today, with one added filter:
  `deleted_at IS NULL`. No query changes beyond that filter.
- **`event_versions` is append-only.** Every re-publish, split,
  tombstone, and manual correction appends a row: `event_id`,
  `version` (monotonic per event), `changed_fields`, `previous_values`
  (JSON, only the changed fields, not a full snapshot), `source_id`,
  `source_revision`, `reason` (one of the change classes above),
  `actor` (`pipeline`, `review`, or `manual`), `superseded_at`.
  Versions are never updated or deleted in v1.
- **Tombstones, not hard deletes, in v1.** A retracted event gets
  `deleted_at`, `removal_reason`, and `successor_id` (the merged-into
  event, if any) on its current row, and a final version row. Map
  queries exclude it; shareable links (plan 31) resolve it to a
  tombstone view - "This event was removed because [reason]; see
  [successor]" - instead of a generic degraded view or a 404. Search
  indexes drop tombstoned events. The only hard deletes in v1 are
  the curated-seed purge (below) and a future legal / takedown path,
  which this plan does not design.
- **History retention.** Version rows are small (changed fields only)
  and grow with corrections, not with corpus size. No retention policy
  in v1; revisit if version rows ever approach event-row volume,
  which would itself be a signal that a source is churning.

## Unmerge: splitting a cluster

A Jev false merge is discovered one of three ways: a source
correction splits the underlying assertions, a reviewer flags it in
the plan 34 queue, or James reports it. The procedure is the same:

1. Re-run Jev pairwise judging over the cluster's assertions only,
   with the new evidence attached. If the judge still merges, the
   split request goes back to review with the judge's reasoning; the
   pipeline does not split on assertion alone.
2. On a confirmed split, keep the original event id for the largest
   surviving member (by assertion count, ties broken by earliest
   publish date) and mint new ids for the splinters. Every splinter
   records `split_from_id` and the original records `split_into_ids`.
3. Attribution, versions, and manual overrides follow their
   assertions to the correct splinter; overrides attached to the
   cluster as a whole go to review rather than being guessed apart.
4. The old shareable link resolves to a split notice listing all
   members, so a link shared before the split still lands somewhere
   truthful.
5. The split, its judge calls, and its reviewer (if any) are recorded
   as version rows on every affected event, and the pair that was
   wrongly merged is added to the dedup eval set so the same pair is
   not re-merged by the next sweep. A re-merge of a recorded split
   pair requires review approval, never automatic judging alone.

## Re-publish mechanics

- A change job is deterministic: its BullMQ job id derives from
  `(source_id, source_row_id, source_revision)`, so a retried or
  duplicated sweep cannot double-apply a change (same idempotency
  reasoning as plan 04).
- A change job re-runs only the stages its change class needs
  (table above), not the full detect-to-publish chain. Extraction
  and LLM calls are the expensive stages; skipping them for a pure
  date or pin correction is the point.
- A change job that fails goes to the per-stage dead-letter queue
  from plan 34 with its source revision attached, so replay resumes
  from the failed stage, not from detect.
- Multi-source events re-derive, not overwrite: when one source
  changes, the merged record is recomputed from all surviving
  assertions (plan 13 fusion), with manual overrides re-applied on
  top. A single-source correction must never silently drop another
  source's contribution.
- Cost accounting rides plan 34's per-source LLM cost ledger: change
  jobs are tagged by change class, so the ledger can answer "how much
  does keeping Wikidata current cost per month" separately from
  first-time ingestion.

## The curated-seed retirement, as a lifecycle operation

The 44 curated events are deleted once plan 26 validates (standing
directive, 2026-10-20) - this plan does not reopen that decision, it
specifies how the deletion executes. Snapshot `data/map-data.json`
as a test fixture first (plan 26's spot-check set becomes the fixture,
nothing more). Tombstone the 44 rows with reason `curated-seed-retired`
and successor links where an ingested event supersedes a curated one,
so shareable links to curated events resolve honestly. Then, after a
30-day tombstone window, hard-purge the rows and their versions.
The window exists only for link stability, not as a reprieve for the
seed: if James wants immediate purge instead, the tombstone step is
skipped and the purge runs at retirement time (open question 22).
Either way, the seed does not survive as a permanent golden set.

## Metrics and alerts (via plan 34)

- Change volume per source per week, by change class.
- Correction rate: share of published events corrected within 90
  days of publish, per source. A rising rate is a source-quality
  signal, not just a pipeline metric.
- Tombstone rate and split rate, with the split-pair eval set size.
- Manual-override conflicts per week: a rising count means the
  pipeline and reviewers disagree often enough to revisit a stage.
- Sweep silence: alert if a scheduled re-check sweep produces no
  marker comparisons for longer than its interval, the same silent-
  source failure mode plan 34 already alerts on for detect.

## Done when

- A Wikidata `lastrevid` change to a published event flows through a
  change job to a corrected map row with a version row, without
  re-extracting the corpus or re-judging unrelated clusters.
- A deleted source entity tombstones its single-source event and
  drops only its assertion from a multi-source event.
- A recorded false merge splits through the procedure above, old
  links resolve to the split notice, and the pair is not re-merged
  automatically.
- A manual override survives a source correction that touches the
  same field, routed to review instead of overwritten.
- A Britannica link-only change is handled without storing any
  Britannica text, including in diffs or hashes of text.
- The curated-seed retirement runs as tombstone-then-purge (or
  immediate purge, per James's call), with the fixture snapshot kept
  and no curated row left as live map data.

## Explicitly out of scope

- Full bitemporal / as-of querying. SCD2-lite version rows only.
- The EventStreams live consumer. Polling published QIDs is v1; the
  stream is the documented v2 upgrade.
- User-submitted corrections (a public "report an error" flow). The
  review queue (plan 34) is the intake for reviewer-flagged splits
  and corrections; a public form is a separate product decision.
- Legal takedown workflow. Tombstones cover source retractions;
  a compelled removal with purge and audit requirements is its own
  plan if it ever arises.
- Rebuilding search indexes from scratch on every change. Search
  updates incrementally from version rows; a full reindex is an
  operational runbook item, not part of this plan.

## Open to James (see chat summary)

- Settle window: 7 days and three deferrals before review, or
  publish corrections immediately and accept edit-war churn?
- Curated seed: 30-day tombstone window for link stability, or
  purge immediately at retirement?
- Manual overrides: should a reviewer-approved correction ever
  expire (for example, re-check after a year), or do manual decisions
  stand until a human revisits them?
