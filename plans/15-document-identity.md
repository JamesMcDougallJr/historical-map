# Document identity: is this the same document we already have?

**Status: gaps recorded, not a build plan.** Nothing here is scheduled. Companion to
[11-identity-and-fusion.md](./11-identity-and-fusion.md), one layer below it.

## The distinction from plan 11

Plan 11 asks: given two documents, do they describe the same *historical event*? It assumes
the two documents are correctly recognised as two separate, real documents.

This file asks the question underneath that one: **is a given document actually new, or is it
something already in the corpus under a different identity?** An online PDF and a local copy
of the same book. The same file re-added under a different path. A source that re-hosts a
document at a new URL. None of these are event-fusion problems — they're the same *document*,
counted twice, before extraction ever runs.

## What identity exists today

The only uniqueness guarantee in the schema is the unique index on
`(source_id, external_id)` (`ingest-document.entity.ts`), enforced via `.orIgnore()` on insert
— not by any control flow in `detect`. `external_id`'s meaning is entirely up to the adapter:
for `LocalDirectoryAdapter` it's the file's path relative to the corpus root
(`local-directory.adapter.ts`).

That means identity today is **path/URL identity, not content identity**:

- Add the same PDF at `corpus/tula.pdf` and `corpus/backup/tula.pdf` → two `external_id`s, two
  document rows, two full trips through fetch → extract-text → extract-events → validate →
  publish. Nothing anywhere compares their bytes.
- `etag` (`fetching.service.ts`) *is* a sha256 of the raw bytes — but it is only ever compared
  to that same row's own previous value, to decide "has this document changed since last
  time" (the `unchanged` check). It is never compared against any other document's `etag`. Two
  rows with byte-identical content are invisible to each other.
- Only one adapter exists (`local-directory`). The moment a remote-archive adapter is added,
  "the same book, once local and once fetched online" stops being hypothetical — and there is
  currently no mechanism, and no schema, prepared for it.

## Two distinct failure modes

**1. Exact-byte duplicates.** Same file, ingested under two identities — a rename, a copy in a
second directory, or the same bytes reachable through two sources. Solvable exactly and
cheaply: compare content hashes.

**2. Same-work, different-bytes duplicates.** A different scan, a different OCR pass, a
different PDF export of the same physical book. This is almost certainly what "an online PDF
vs. our local copy" means in practice — they will essentially never hash equal, even though
they're the same work. This needs a similarity signal over *extracted text*, not bytes.

## Why plan 13's fusion machinery doesn't already cover this

Plan 13 dedupes at the event level, after extraction — a fine safety net once it exists, but
relying on it alone for document-level duplicates is expensive in a way event fusion isn't.
Every duplicate document still gets fully fetched, cleaned, and — critically — sent through
`extract-events`, the one stage in the whole pipeline that costs real money per the Groq notes
in `CLAUDE.md`. Catching the duplicate before `extract-events` is a cost problem, not just a
correctness one, and it also means twice as many permanent `ingest_documents` /
`ingest_extractions` rows for one physical source, forever.

## What a design would have to settle

1. **Exact-duplicate check, globally.** Extend the `etag` comparison in `fetching.service.ts`
   from "does this match my own previous value" to "does this hash exist on *any* document
   row." A match means: mark the new document `skipped` with a pointer to the original rather
   than proceeding to `extract-text`. This needs no judgment call — an identical hash is never
   a false positive — so it's the one piece of this problem that's safe to resolve
   automatically rather than routing to a human.

2. **Near-duplicate check on cleaned text**, after `extract-text` — segments exist, no model
   cost has been spent yet, and it's the same insertion point plan 13 picks for event matching,
   for the same reason: it's the boundary right before the expensive stage. Cheapest-first
   options:
   - `pg_trgm` trigram similarity over normalised full text — already installed per plans 12/13,
     zero new infrastructure.
   - A document-level embedding compared by cosine distance, once plan 12's embedding provider
     exists — likely better recall on reworded or re-OCR'd text, at the cost of pulling that
     dependency in earlier than plan 13 otherwise needs it.

3. **A place to record the finding without destroying anything** — matching plan 13's
   "additive, not destructive" stance for the same reason: a wrong duplicate call is worse than
   a missed one, and both should be recoverable. Something like
   `ingest_document_duplicates(document_id, candidate_document_id, method, score, resolved_at, resolution)`.
   Exact-hash matches can auto-resolve. Near-duplicates go to the same review queue humans
   already use for events — plan 11 and 13 both demonstrate, with the Tula/Inquisition pair,
   that similarity alone cannot decide, and there's no reason document-level similarity would
   be more trustworthy than event-level similarity was.

4. Either way, "duplicate" should never mean delete. The losing document keeps its row and
   provenance; it's marked subsumed and stops descending the pipeline. Same reasoning as plan
   13's assertions being additive.

## Why not now

Same argument plan 11 makes for event fusion, one layer down: there is currently one source
(`local-directory`) and no remote adapter, so there is no live case of "the same document
reachable two ways" to design against — only the case you're anticipating. The exact-hash
piece is worth doing as soon as a second adapter is added, since it's unambiguous and cheap
regardless of corpus size. The near-duplicate piece should wait for a second, overlapping
source to arrive — same as plan 13 recommends for event fusion — and should reuse whatever
plan 13 ends up building for embeddings or `pg_trgm` rather than standing up its own
comparison machinery from scratch.
