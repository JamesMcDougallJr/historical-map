# Similarity search and the fusion judge

Turns the gaps recorded in [11-identity-and-fusion.md](./11-identity-and-fusion.md)
into a design. Depends on [12-embeddings-and-bedrock.md](./12-embeddings-and-bedrock.md)
for the embedding provider and vector storage.

**The shape:** vector search proposes, an LLM disposes, a human arbitrates what
the LLM is unsure about. Nothing merges on cosine distance alone.

## Why similarity alone cannot decide

This is the core constraint, and it comes from the corpus rather than from
theory. Querying the 60 published events for same-place-same-year pairs returns
both of these:

| Pair                                                                                              | Same event? |
| ------------------------------------------------------------------------------------------------- | ----------- |
| `Overthrow of Tula` / `Rebellion that overthrew the Toltec government` (1103, Tula)               | **Yes**     |
| `Extension of the Spanish Inquisition to Mexico` / `Mexico erected as a bishopric` (1527, Mexico) | **No**      |

Both pairs share a place and a year. The second pair will also score high on
embedding similarity — both are short clauses about Spanish ecclesiastical
administration in the same city in the same year. Any threshold that merges the
first will merge the second.

That is the whole argument for a judge stage. Vector similarity is an excellent
_candidate generator_ and an unacceptable _decision procedure_, and the corpus
demonstrates it at n=60 rather than n=60,000.

## Pipeline position

```
… → validate → publish
                  ↓
              embed → match → judge → fuse
```

A new worker, `fuse`, alongside the existing six. It runs **after** publish
rather than inside it for the reason the pipeline already splits stages: judging
is an expensive external call, and a judge outage should never discard a
successful geocode-and-write. Events reach the map first and get reconciled
second.

### Stage 1 — `embed`

For every candidate/published event, embed a composed string and upsert into
`event_embeddings`.

**What to embed matters more than the model.** Titles alone are too short to
separate the 1527 pair. Compose:

```
{title}. {description} Place: {placeName}. Date: {dateText}.
```

Deliberately excluding `sourceText` — the verbatim quote is long, and two
extractions of the _same_ event from _different_ books share no quote at all,
so including it makes genuine cross-source duplicates look less alike. The quote
is evidence for the judge, not signal for the vector.

Idempotent on `(event_key, model, dims)`; skip rows already embedded by the
current model.

### Stage 2 — `match` (candidate generation)

For each event, retrieve neighbours under **hard filters first**, then vector
rank:

1. **Date compatibility, not equality.** Gap 3 in plan 11: an event known to
   1547 and the same event known to 1547-12-02 must be candidates. Compare
   _intervals_ implied by `date_precision` — `year` → the whole year, `circa` →
   the year ± a tolerance, `day` → that day — and require overlap.
2. **Place proximity.** Reuse PostGIS: `ST_DWithin` on the locations, with a
   radius well wider than the 1 km merge radius (historical places drift, and
   plan 11 gap 5 notes the geocoder is the weak link). Events whose place failed
   to geocode are candidates only within the same document.
3. **Vector top-k** within that filtered set, capped (k ≈ 5).

Filtering before ranking is what keeps the judge bill linear. Without the date
and place filters, top-k over the whole corpus returns the globally most
similar events, which for a history book means "other events in the same book".

**Baseline worth keeping.** `pg_trgm` is already installed (plan 12) and gives
trigram similarity for free. Wire it as a comparison arm: if trigram matching
on title+description performs as well as embeddings on the real duplicate set,
that is a genuine finding and saves a provider dependency. Measure before
assuming the vectors win.

### Stage 3 — `judge`

Each surviving pair goes to the Bedrock judge (`amazon.nova-lite-v1:0`) with the
evidence a human would want:

- both titles, descriptions, `dateText`, `placeName`
- both verbatim `sourceText` quotes
- the source and document each came from

Structured output via Converse `toolConfig`:

```jsonc
{
  "verdict": "same" | "different" | "uncertain",
  "confidence": 0.0,
  "reason": "one sentence",
  "conflicts": ["date", "place"]   // where they disagree, if same
}
```

`conflicts` is the interesting field. Two records can be the same event _and_
disagree on the date — that is precisely the case fusion must handle well, and
recording it is what lets a later pass prefer the better-supported value
instead of whichever arrived first.

**Every judgement is persisted**, verdict and reason and model id, in
`event_merge_judgements`:

```sql
CREATE TABLE event_merge_judgements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  left_key      text NOT NULL,
  right_key     text NOT NULL,
  similarity    real NOT NULL,        -- what the vectors thought
  verdict       text NOT NULL CHECK (verdict IN ('same','different','uncertain')),
  confidence    real NOT NULL,
  reason        text,
  conflicts     jsonb NOT NULL DEFAULT '[]',
  model         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (left_key, right_key, model)
);
```

Storing `similarity` next to `verdict` is the point: it is the **labelled
dataset** for choosing the shortlist threshold. Set the cutoff from the observed
distribution of similarity-vs-verdict, exactly as the grounding check was built
to record before gating. Order the key pair deterministically so `(a,b)` and
`(b,a)` cannot both exist.

`uncertain` and low-confidence `same` go to the existing review queue rather
than merging. The queue already exists and already holds 71 events.

### Stage 4 — `fuse`

Blocked on schema, per plan 11 gap 6 — `events` has one `source_id` and one
`document_id`, so there is nowhere to say "three documents attest this."

```sql
-- The thing shown on the map. One pin, one timeline entry.
CREATE TABLE event_clusters (
  id           text PRIMARY KEY,
  canonical    jsonb NOT NULL,   -- resolved title/date/place actually displayed
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- What each source actually said. Never overwritten.
CREATE TABLE event_assertions (
  event_key    text PRIMARY KEY,          -- the existing per-document id
  cluster_id   text NOT NULL REFERENCES event_clusters(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES ingest_documents(id),
  source_id    text NOT NULL,
  anchor       text,                      -- "p.43", see plan 14
  title        text NOT NULL,
  date         date NOT NULL,
  date_precision text NOT NULL,
  source_text  text,
  confidence   real
);
```

Merging becomes **additive**: attach an assertion to a cluster. Nothing is
destroyed, which is what makes a wrong merge recoverable — re-point one
assertion rather than reconstruct a deleted row. It also directly answers the
corroboration question raised in plan 11: how many independent documents attest
this event is now a `COUNT(*)`.

**Canonical value resolution** (which title, which date wins) needs its own
rules, and `date_precision` gives the obvious one: prefer the most precise date
that does not contradict the others. Titles are harder and may be worth leaving
to the longest-attested variant initially.

> Fixing plan 11 gap 1 — identity mixing in `document.externalId` — is
> **subsumed** by this, not separate. The per-document key becomes the assertion
> id, which is the correct thing for it to be; the cluster id becomes the
> event's identity. No id rewrite is needed, which is a good reason to build
> clusters before the corpus grows.

## Map and API impact

- Pins render **clusters**, not assertions. `/api/sources/[id]/features` keeps
  serving per-source layers (one layer per source stays the decision), but a
  cluster attested by two sources appears on both layers and resolves to one
  popup.
- The popup gains a source list — see [14](./14-source-retrieval-and-rag.md).
- `ON CONFLICT DO NOTHING` (plan 11 gap 7) stops being a dead end: the cluster's
  canonical value can be recomputed when a new assertion arrives, without
  mutating any source's record.

## How to know it works

The honest problem is that **there is no labelled duplicate set yet**, and with
one document there cannot be a meaningful one. Sequence:

1. Ingest 2–3 overlapping documents — a second general history of Mexico is the
   obvious choice, since overlap with the existing book is guaranteed.
2. Hand-label the pairs the matcher proposes. At this corpus size that is an
   afternoon, not a project.
3. Report precision/recall for: trigram-only, vectors-only, vectors+judge. If
   the judge does not beat vectors-only on the labelled set, it is not earning
   its cost.
4. Only then choose the auto-merge threshold.

Known-answer cases to keep as fixtures regardless: the Tula 1103 pair **must**
merge; the 1527 Inquisition/bishopric pair **must not**.

## Risks

- **Confident wrong merges are worse than duplicates.** A duplicate is visible
  and annoying; a bad merge silently destroys a distinct historical event.
  Hence: additive assertions, persisted judgements, and review for anything
  uncertain.
- **Judge cost scales with candidate generation quality**, not corpus size.
  Watch the pairs-per-event ratio; if it climbs above ~5 the filters are too
  loose.
- **Geocoder error propagates into matching.** Place proximity assumes the
  geocode is roughly right, and plan 11 gap 5 documents that it often is not
  (`"the great plaza"`). Events with low-confidence geocodes should match on
  text alone rather than being excluded or wrongly co-located.
