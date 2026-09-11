# Event identity, deduplication, and source fusion

**Status: gaps recorded, not a build plan.** Nothing here is scheduled. This
exists because the current deduplication is weaker than it looks, and the
weakness is invisible until a second document arrives — at which point it is
expensive to unpick, because wrong identity decisions are already baked into
published ids.

## The decision this records

**One layer per source, no fusion.** `/map` builds one toggleable layer for
every row in `sources` (`app/map/utils/event-layers.ts`). Two sources
describing the same event produce two pins, on two layers, and the user turns
layers on and off.

This is deliberate for now, and it is also what makes the gaps below survivable:
duplicates across sources are _visibly_ attributable rather than silently
merged. Fusing sources is the eventual goal, but fusing on the current identity
model would produce confident, wrong merges.

## What deduplication exists today

Three mechanisms, none of which is doing as much as its name suggests.

| Mechanism                                                            | Where                               | Scope            |
| -------------------------------------------------------------------- | ----------------------------------- | ---------------- |
| `eventKeyFor(sourceKey, externalId, title, dateIso)` → `ev-<sha256>` | `libs/common/src/event-key.ts`      | one document     |
| `checkDuplicate` against an in-memory `Set`                          | `validate/.../validators.ts`        | one validate run |
| `findOrCreateLocation` — `ST_DWithin` 1000 m snap                    | `publish/.../map-writer.service.ts` | all locations    |

`publish` writes with `ON CONFLICT (id) DO NOTHING`, so identical ids collapse.
That makes **re-running the pipeline idempotent**, which is what these were
built for and what they do correctly. It is not the same as recognising that two
differently-worded records describe one historical event.

## The gaps

### 1. Identity is scoped to the document, not the event

The key mixes in `document.externalId`. Two documents that both describe the
fall of Tenochtitlan produce two different keys and two pins — _even within the
same source_. The same file re-added under a different filename duplicates its
entire contents.

This is the single most consequential gap, because published ids are permanent:
every day this runs, more rows are written under document-scoped ids that a
later fusion pass has to reconcile rather than prevent.

### 2. Title equality is the only content signal

Both the key and `checkDuplicate` normalise whitespace and case, then compare
titles **exactly**. Already visible in the 60 events ingested from one book:

| Title                                            | Date | Place |
| ------------------------------------------------ | ---- | ----- |
| `Overthrow of Tula`                              | 1103 | Tula  |
| `Rebellion that overthrew the Toltec government` | 1103 | Tula  |

Same event, same place, same year, two pins — from a **single document**, so no
cross-source logic would have caught it either.

The same query surfaces pairs that are genuinely _distinct_ despite matching on
place and date (1527: the Inquisition extending to Mexico, and Mexico being
erected as a bishopric). So "same place + same year" is not a usable merge rule
on its own, and the cheap fix is not available. Deciding these apart needs the
description and the quoted `sourceText`, not the title.

### 3. Date precision is part of identity, so refinement forks instead of merging

`dateIso` goes into the key. An event known only as 1547 (`1547-01-01`,
precision `year`) and the same event later extracted as `1547-12-02` (precision
`day`) hash differently and become two pins.

This is exactly backwards: a later, more precise ingest is the _best_ case, and
it currently degrades the map. Any identity scheme has to treat a coarse date
and a finer date that falls inside it as **compatible**, not distinct — and
`date_precision` (now carried end to end, see `formatDate`) is what makes that
decidable rather than guesswork.

### 4. The duplicate check cannot see beyond its own run

`ValidationContext.seen` is a `Set` built fresh per validate job. It cannot see
prior runs, other documents, or what is already published. It catches a model
emitting the same event twice in one pass — worth having, but it is not
deduplication against the corpus.

### 5. Location identity is proximity-only, and inherits geocoder error

`findOrCreateLocation` merges anything within 1 km. Consequences both ways:

- Two names for one place merge only if the geocoder happens to land them
  within 1 km. "Tenochtitlan" and "Mexico City" are the same place and should
  always merge; whether they do is currently luck.
- A bad geocode creates a permanent spurious location. The corpus produced a
  pin named `"the great plaza"` — a phrase, not a place — and it will now
  attract every future event that geocodes near it.

Nominatim being a modern gazetteer (already documented in CLAUDE.md) means this
is not a tail risk; it is the normal case for historical names.

### 6. There is nowhere to record that two sources agree

`events` has a single `source_id` and a single `document_id`. An event asserted
by three documents has no representation — the schema can express "this event
came from that document" but not "these four records are one event, attested
here, here and here."

**Fusion is therefore blocked on a schema change, not on an algorithm.** Merging
without somewhere to put provenance would mean destroying the corroboration
evidence at exactly the moment it becomes valuable — multiple independent
sources agreeing is the strongest confidence signal available, and is also the
best answer to the grounding problem (90/131 quotes located, per the validate
run).

### 7. Published events are never corrected

`ON CONFLICT (id) DO NOTHING` means a re-publish cannot improve an existing row.
Deliberate — it matches the web app's insert path and keeps re-runs free — but
it means better data arriving later has no path onto the map even when identity
_is_ resolved correctly.

## What a design would have to settle

Roughly in dependency order:

1. **A document-independent event key.** Probably `(sourceKey, normalisedTitle,
dateBucket)` at minimum, with the document recorded as provenance rather than
   mixed into identity. Changing this rewrites every published id once — cheaper
   now than later.
2. **A candidate-pair model instead of exact-match.** Block on place and date
   bucket to get a small candidate set, then score on description and
   `sourceText` overlap. Note gap 2: the blocking key alone cannot decide.
3. **Date compatibility, not date equality** — using `date_precision`, with a
   rule for whether a `circa` year may absorb an exact one.
4. **A provenance table** (`event_assertions`?) so one map event can cite many
   documents, and a merge is additive rather than destructive.
5. **A confidence policy for auto-merge vs. review.** The review queue already
   exists (71 events in it) and is the obvious place for uncertain merges.
6. **Place entity resolution**, including historical aliases — the hardest part,
   and the one most likely to need a curated gazetteer rather than Nominatim.

## Why not now

Fusing requires knowing what two sources disagreeing actually looks like, and
there is currently **one** document in the corpus. Every rule above would be
guessed rather than measured — the same mistake the grounding check deliberately
avoided by recording before gating.

The cheap, correct move is to keep sources on separate layers, ingest several
overlapping documents, and then measure how often the naive key collides and how
often it misses. Gap 1 is the exception worth acting on early, because it makes
permanent ids and gets more expensive every run.
