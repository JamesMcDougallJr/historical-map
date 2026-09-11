# Phase 7 — `fetch` worker

Retrieve a discovered document's bytes and reduce them to plain text for extraction. The
analogue of State Affairs' `download` worker, minus `ffmpeg`.

## Flow

1. Load the `ingest_documents` row; flip status to `fetching`.
2. `GET document.url`, sending `If-None-Match` from the stored `etag`.
   - **304 Not Modified** → nothing changed; record the check and stop. This is the common case
     on re-fetch and should be cheap.
3. Extract text by content type.
4. Store the text, update `etag`, flip status to `fetched`.
5. Enqueue an `extract` job.

## Text extraction

| Content type | Approach |
|---|---|
| `text/html` | Strip boilerplate to main content. `cheerio` is the State Affairs precedent. |
| `application/pdf` | **`unpdf`** — already a dependency of the web app (`serverExternalPackages`), already used by `/api/parse-pdf`. Same library both sides. |
| `text/plain`, JSON | Pass through / project the relevant fields. |
| IIIF manifests | Follow to the described resource; may yield an image with no text layer. |

**Not every document has usable text.** A scanned page with no OCR layer yields nothing, and
that is a legitimate terminal state, not a failure — mark it and stop rather than retrying five
times. Distinguish "fetch failed" (retryable) from "fetched successfully, contains no
extractable text" (terminal), because conflating them wastes the entire retry budget on
documents that will never succeed.

## Bounded work

State Affairs' documented known limitation was a wall-clock timeout on the whole
extract-audio step: deterministic, so retries all failed identically and an outlier video ended
up permanently `FAILED` with no automatic recovery.

The same trap exists here in milder form — a 4,000-page PDF. Two mitigations, both cheap
because they are being designed in rather than retrofitted:

- **Cap the response size** before parsing, not after. A `Content-Length` check plus a hard
  read limit turns "worker OOMs" into "document marked too large", which is a state a human can
  act on.
- **Page-bounded PDF extraction.** `unpdf` can extract per page; if a document exceeds the
  page budget, extract in bounded chunks as separate units of work rather than one
  all-or-nothing job. This is the fix sketch from State Affairs' limitations section, applied
  up front.

## Storage

**Extracted text goes in a Postgres column. There is no object storage** (decided — see phase
2). Tens of KB per document, so a `text` column is the right tool, and it removes MinIO, the
`S3_*` config, and the whole "which host has the file" class of failure.

Do **not** keep the original bytes. For every source under consideration the URL is stable and
re-fetchable, so storing the source PDF duplicates an archive that already exists and whose
preservation is someone else's job. Storing the extracted text plus the `etag` is enough to
know both what we read and whether it has changed since.

Write the text through a single function so that if some future source does serve very large
artefacts, introducing storage touches one call site rather than the design.
