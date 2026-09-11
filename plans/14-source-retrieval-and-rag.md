# Source retrieval and RAG over the corpus

Two user-facing features that share one missing piece, which is why they are
planned together: **nothing currently records where in a document an event came
from.** Fix that once and both "show me the source" and "answer my question with
citations" become straightforward.

Depends on [12-embeddings-and-bedrock.md](./12-embeddings-and-bedrock.md).
Designed to survive [13-similarity-and-fusion.md](./13-similarity-and-fusion.md),
where one event gains several sources.

## The missing piece: anchors

The text artifact in object storage is **already** structured as
`{ segments: [{ anchor: "p.43", text }] }`, and `chunkSegments` carries those
anchors into every `ExtractionChunk`. The prompt even receives them.

Then they are dropped. `ExtractedEvent` has `sourceText` (the verbatim quote)
but **no anchor field**, so `publish` has nothing to write and the `events` table
has no column for it. The pipeline knows exactly which page each event came from
and discards it at the last step.

**Fix at the source:** add `anchor: string | null` to `ExtractedEvent`, set it
from `chunk.anchors` in `extract-events`, and carry it to the assertion row
(plan 13) or an `events.anchor` column in the meantime.

### Backfilling the events that already exist

The 60 published events have no anchor. They can get one without re-running the
model, because `validate` already solves this problem: `checkGrounding`
normalises the quote and searches the document text for it. Reuse that search,
but return **which segment matched** instead of a boolean.

The measured hit rate is the honest expectation: **90 of 131 quotes were
located**. So roughly 69% of existing events can be anchored to a page
retroactively, and the rest fall back to a document-level link with no page.
That number is also a good argument for fixing it forward — a freshly extracted
event should never need to be searched for.

> This is the second time the grounding measurement has paid off, and it is
> worth noting why: it was recorded before anyone knew what it was for. A
> gating check that had silently dropped ungrounded events would have left no
> way to know 31% of quotes cannot be located verbatim.

## Feature 1 — view the source

### The route

```
GET /api/events/:eventKey/sources
→ [ { sourceId, sourceName, documentId, documentTitle,
      anchor: "p.43", page: 43, quote, url } ]
```

**A list from day one, even though it always has one element today.** A
single-source endpoint would be rewritten the moment fusion lands; a list of
one costs nothing now. This is the same reasoning that made the map's layer
registry data-driven instead of a hardcoded id.

After plan 13, this reads `event_assertions` for the cluster and returns one
entry per attesting document. Before it, it returns the single row. The client
does not change.

### Serving the bytes

Originals live in object storage at `documents/{documentId}/original` and are
never rewritten — which is exactly why storing them was worth it.

**Use a presigned URL, not a proxy.** `@aws-sdk/s3-request-presigner` mints a
short-lived (say 15 min) URL the browser fetches directly. Proxying an 587 KiB
PDF through a Vercel function on every click burns bandwidth and execution time
to no benefit, and PDFs are large and highly cacheable.

**Deep-link to the page.** Browser PDF viewers honour the `#page=N` fragment, so
`…/original#page=43` opens the right page in a new tab. The `anchor` format is
already `"p.43"` — parse the integer, and degrade to the plain document link
when there is no anchor rather than guessing a page.

For non-PDF sources (HTML, text) `#page=` is meaningless; return the anchor as
a text offset and have the viewer highlight instead. Worth designing the anchor
as an opaque string with a `kind` rather than assuming pages forever.

### The credentials question

The web app has **no AWS SDK at all** today (plan 12). Two options:

1. **Web app mints the presigned URL.** Needs `@aws-sdk/client-s3` +
   presigner and S3 credentials in Vercel env. Simplest request path.
2. **Ingest `api` service mints it**, web app redirects. Keeps AWS credentials
   confined to the hosts that already have them, at the cost of the ingest API
   becoming publicly reachable — which it currently is not.

**Recommend (1)** for retrieval specifically: presigning needs only
`s3:GetObject` on one prefix, which is a genuinely narrow credential, and it
avoids making the operator API public. Pair it with the IAM user from plan 12 —
not root.

## Feature 2 — RAG for the agent UI

"Ask a question about this event / place / period and get an answer drawn from
multiple sources."

### Indexing

Embed the text-artifact segments into `document_segment_embeddings` (schema in
plan 12), keyed by `(document_id, chunk_index)` and carrying the `anchor`.

Index **segments, not events**. Events are lossy summaries; the answer to "why
did the Toltec government collapse" lives in prose the extractor discarded
because it contained no date. The whole book is ~80k tokens — embedding all of
it costs about as much as one extraction pass and is a one-off per document.

Re-embed on the same trigger as re-extraction: when `EXTRACTOR_VERSION` bumps
the artifact changes, so the vectors are stale. The `model`/`dims` columns make
that a targeted backfill.

### Answering

```
POST /api/ask  { question, eventKey?, bbox?, fromYear?, toYear?, sourceIds? }
→ { answer, citations: [{ documentId, anchor, quote, url }], usedSources: [...] }
```

1. Embed the question.
2. Retrieve top-k segments, **filtered by the same dimensions the map already
   has** — source, date range, and place. A question asked while looking at
   Tenochtitlan in 1520 should not retrieve Utah.
3. Generate with the Bedrock judge-tier model, instructed to answer **only**
   from the retrieved passages.
4. Return citations that reuse Feature 1's URL construction, so every claim
   links to the exact page of the exact document.

### Guardrails, which are the actual design

The interesting part of a RAG feature over historical sources is not retrieval
quality, it is **refusing to answer**.

- **Cite or abstain.** If retrieval returns nothing above a relevance floor, say
  so. A fluent unsourced answer about history is indistinguishable from a
  correct one to the reader, and this corpus is a 1903 textbook — confidently
  wrong is the default failure.
- **Attribute, don't adjudicate.** When two sources disagree, report both with
  their citations. The system's job is showing what sources say, not deciding
  history. This is the same stance as one-layer-per-source.
- **Surface the source's own age.** A 1903 account of the Aztecs reflects 1903
  scholarship. Citations should carry the document's date so the reader can
  weigh it.
- **Never let retrieved text act as instructions.** Segments are data. A
  document containing "ignore previous instructions" must not steer the answer —
  fence retrieved content explicitly in the prompt.

### Where the model call happens

Same question as the presigner, different answer. RAG needs `bedrock:InvokeModel`
on the Bedrock region, and it is a **write-shaped** operation in cost terms:
unauthenticated `/api/ask` on a public URL is a bill anyone can run up.

Treat it like the MCP connector precedent — `/api/mcp` is read-only _specifically
because_ `/api/data/*` treats a missing key as "allow", making an unguarded
public write endpoint. Apply the same reasoning: `/api/ask` needs rate limiting
(the middleware already does per-IP sliding windows) and should require a key
when one is configured.

## Build order

1. **Anchors forward** — `ExtractedEvent.anchor`, populated in `extract-events`.
   Small, unblocks everything, and every day without it produces more events
   needing backfill.
2. **Anchor backfill** via the grounding search (~69% expected).
3. **Feature 1** — `/api/events/:key/sources` + presigned URLs + popup link.
   Useful immediately, no embeddings needed, and it makes extraction errors
   _inspectable_, which helps every other workstream.
4. **Segment embeddings** (needs plan 12 decisions settled).
5. **Feature 2** — `/api/ask`, then the UI panel.

Feature 1 before any vector work is deliberate: it is the step that lets a human
check whether an extracted event is actually supported by its source, which is
the same question the grounding check answers statistically and plan 13's judge
answers pairwise. Being able to click through to page 43 is the cheapest
evaluation tool in the whole system.

## Open questions

1. Anchor granularity — page is what the artifact has; segment offsets would let
   the viewer highlight the exact sentence. Worth it only if a custom viewer
   replaces the browser's PDF renderer.
2. Does the agent UI need conversational memory, or is each question standalone?
   Standalone is far cheaper and sidesteps context management entirely.
3. Should RAG answers be cacheable? Identical questions over an unchanged corpus
   are deterministic enough to cache on `(question, filters, corpus version)`.
