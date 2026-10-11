# Publish-time duplicate decisions: two questions, three outcomes

Builds on the publish-time duplicate check shipped in PR #15
(`apps/workers/publish/src/publishing/jev-dedup.ts`) and is the publish-stage slice
of [13-similarity-and-fusion.md](./13-similarity-and-fusion.md): _candidates are
proposed, Jev disposes, a human arbitrates what Jev is unsure about._ Identity and
merging stay out of scope ([11-identity-and-fusion.md](./11-identity-and-fusion.md)).

**Status:** designed, not built.

## What exists today

For each event about to publish, `publish` collects nearby published events, asks Jev
one yes/no question per candidate ("same as existing event _i_?"), takes the best
`P(same)`, and compares it to one knob, `JEV_PUBLISH_DEDUP_HOLD_AT`: at or above it the
event is held for review, below it the event publishes. `0` never holds. Held events are
resolved only through the CLI (`npm run duplicate:review`); the admin app has no page
for it.

Two weaknesses:

- **One signal, one threshold.** An event Jev is unsure about publishes silently, the
  same as one it is confident is new.
- **No automatic outcome.** A near-certain duplicate (observed `P(same)` 0.93–0.97)
  still waits for a human, so every duplicate costs a review.

## Design

### Two questions, asked in the same request

1. **Per candidate:** "Is the new event the same real-world event as existing event
   _i_?" (unchanged). Take the best, `P(same)`.
2. **Once, over all candidates:** "Is the new event distinct from _every_ existing event
   listed?" Call it `P(distinct)`.

The state is shared, so the second question adds very little cost. It is not redundant:
the two are independent readings of one situation, and **disagreement is itself the
signal** (`P(same)` 0.9 with `P(distinct)` 0.8 means Jev is confused, not that the
event is a duplicate).

### Three outcomes

| Outcome                  | Condition                                                          | Action                                         |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------- |
| **Confident duplicate**  | `P(same)` ≥ `MATCH_AT` **and** `P(distinct)` ≤ `1 − MATCH_AT`      | Auto-resolve as a duplicate; do not publish    |
| **Confident new**        | `P(distinct)` ≥ `NEW_AT` **and** `P(same)` ≤ `1 − NEW_AT`          | Publish                                        |
| **Neither** (incl. the two answers disagreeing) | everything else                             | Hold for review in the admin panel             |

Both signals must agree before anything is decided automatically.

### Knobs

| Env var                          | Default | Meaning                                                              |
| -------------------------------- | ------- | -------------------------------------------------------------------- |
| `JEV_PUBLISH_DEDUP_MATCH_AT`     | `0`     | Auto-resolve as duplicate at/above this. `0` = never auto-decide.    |
| `JEV_PUBLISH_DEDUP_NEW_AT`       | `0`     | Auto-publish at/above this. `0` = no review band; unmatched events publish as today. |

This replaces `JEV_PUBLISH_DEDUP_HOLD_AT`. That is safe because the flag exists only in
the unmerged PR #15. Both defaults are `0`, keeping the repo's convention (see
`JEV_GROUNDING_MIN_SUPPORT`): with the flag on and both knobs at `0` the check is
recorded and decides nothing. Suggested starting values to _try_ on a real corpus:
`MATCH_AT=0.9`, `NEW_AT=0.8` (same pairs scored 0.93–0.97 and distinct pairs 0.02–0.17
on the real API). Tune from recorded probabilities before relying on them, because a
false "duplicate" drops a real event.

### Auto-resolution is reversible

A confident duplicate is **not deleted**. It is recorded the way `duplicate:review
--dismiss` already records one: `resolved_at` set, plus the matched event id, both
probabilities and `auto: true` on the candidate. An admin can overturn it with the same
"approve" action. `validate`'s upsert is already `WHERE resolved_at IS NULL`, so
re-validating cannot undo the decision.

**Decision taken:** a confident duplicate is left off the map and linked to the existing
event, not published as a second source. Attaching it as evidence for the existing event
needs the identity/provenance schema from plan 11.

### Admin panel

A `/duplicates` page in `apps/admin`, next to the existing `locations` and `sequences`
pages:

- Lists held candidates: the new event beside its best match (title, date, place,
  quote, source), both probabilities, and Jev's reasoning.
- **Approve** ("a different event; publish it", re-queues the document's publish job) and
  **Dismiss** ("a duplicate; leave it out"), the same semantics and code path as the CLI.
- Shows recent auto-resolved duplicates so a wrong one is spotted and overturned.

`npm run duplicate:review` stays; the page and the CLI share one resolve function.

## Where candidates come from

Today, **by location and date, in SQL** (`MapWriterService.findNearbyEvents`):

1. Published events whose location is within `DEDUP_RADIUS_M` (5 km) of the new event's
   geocoded point (`ST_DWithin` on `locations.geom`), ordered nearest first.
2. Within `DEDUP_POOL_DAYS` (731) of its date.
3. Excluding the event itself and anything from the same document; up to 25 rows.
4. `selectCandidates` then applies the precision-aware `datesCompatible` rule and keeps
   the nearest 8, which is what Jev sees.

So proximity is already the primary filter, and closer pins rank first. The known gap
(CLAUDE.md "Known limits") is that two name variants geocoding more than 5 km apart are
never compared.

### Adding vector candidates later

When the vector store from plan 12 exists, it becomes a **second candidate source**, not
a replacement:

- Candidates = union of (spatial + date) and (top-_k_ nearest by embedding), de-duplicated
  by event id, then capped at `DEDUP_MAX_CANDIDATES` for Jev. Ranking could interleave
  the two.
- This is what closes the 5 km gap: a vector hit for an event geocoded elsewhere gets
  asked about even though SQL never returned it.
- `selectCandidates` is the single seam. Nothing downstream (the two questions, the
  bands, the admin page) changes, which is why the design above is source-agnostic.
- Open: vector candidates skip the spatial filter, so apply `datesCompatible` to them
  (a different century is not a duplicate) but not the radius. Distance should be shown
  to the reviewer, not used to exclude.

## Build order

1. `judgeDuplicateWithJev`: add the `distinct` question; return both probabilities and the
   outcome; new knobs in `env-validation.schema.ts`; remove `HOLD_AT`.
2. Auto-resolve path in `publishing.service.ts` (writes the resolved candidate, skips
   publishing); hold path unchanged.
3. `jev:verify` cases: each band, both disagreement directions, `0` defaults decide
   nothing, a failed Jev call decides nothing (fail open, as now).
4. Fixture: extend `run-ingestion-fixture.ts` with an auto-duplicate (confident match is
   left off the map and recorded `auto`), keeping the held/approve/dismiss flows.
5. Admin `/duplicates` page + `e2e-real` spec; shared resolve function with the CLI.
6. Docs: CLAUDE.md "Cross-document duplicates at publish time" and the Known limits.

## Risks

- **A wrong auto-duplicate drops a real event.** Mitigated by requiring both signals,
  `0` defaults, reversibility, and showing auto-resolved items in the admin page. Do not
  enable `MATCH_AT` until the recorded probabilities on a real corpus have been reviewed.
- **Corpus effect (from plan 13):** same place and year does not mean same event
  ("Extension of the Inquisition" vs "Mexico erected as a bishopric", 1527). The
  `distinct` question exists partly to keep Jev honest here; add that pair to the
  fixture as a must-stay-distinct case.
- Concurrent publishes can still miss each other (unchanged; the fixture sets
  `PUBLISH_CONCURRENCY=1`).
