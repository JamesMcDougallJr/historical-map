# Phase 8 — `extract` worker · **Implemented (Groq, not Claude)**

**This document's premise is superseded.** The engine is Groq
(`openai/gpt-oss-120b`) with strict structured outputs. Three instructions below
are wrong for Groq and were deliberately not followed:

- **Streaming is forbidden** with strict structured outputs, as is tool use — so
  the "stream with `.finalMessage()`" advice does not apply.
- **`strict` defaults to `false`** and must be passed explicitly. Without it the
  response is best-effort schema matching that can also 400.
- The schema must be **strict-mode-native**: every property in `required`,
  `additionalProperties: false` on every object, nullable unions instead of
  optionals, and no `pattern`/`minLength`/`oneOf`. `scripts/verify-extraction.ts`
  audits this offline, because a violation is a 400 on *every* request rather
  than a degraded result.

What carried over verbatim: the interface/token/module triad, the marker-error
retry loop, and per-chunk checkpointing. Two deliberate improvements on the
pipeline this is modelled on — `Retry-After` is honoured rather than doubling a
fixed delay, and chunk checkpointing was built in from the start rather than
left as a documented limitation.

Verified against the live API: the schema is accepted, and precision is
correctly differentiated ("May 10, 1869" → `day`, "July 1847" → `month`).

---

## Original notes, retained for the rationale

Turn document text into `ParsedEvent[]` via the Claude API. Structurally the analogue of State
Affairs' `transcribe` worker: an expensive, chunked, retryable transformation behind an
interface and a DI token.

**This is the first Claude API call in the repo.** Despite what `CLAUDE.md` says, `/api/parse`
runs local regex/structured parsers — there is no `@anthropic-ai/sdk` dependency today.

## The abstraction boundary

```ts
// libs/extraction/src/extraction-engine.interface.ts
interface ExtractionEngine {
  extract(text: string, ctx: ExtractionContext): Promise<ExtractionResult>;
}
export const EXTRACTION_ENGINE = Symbol('EXTRACTION_ENGINE');
```

`ExtractingService` depends only on the interface, never on Claude specifically. A future
engine — a different provider, or a local model for cheap first-pass filtering — is a new
subdirectory plus a one-line import change in the module, with zero changes to the service, the
queue contract, or storage. Exactly the `TRANSCRIPTION_ENGINE` shape from State Affairs, and it
earned its keep there when the local-Whisper default was swapped for Groq.

## Claude configuration

- **SDK**: `@anthropic-ai/sdk` (the official TypeScript SDK). New dependency of
  `services/ingest` only — the web app does not need it.
- **Model**: `claude-opus-5`.
- **Thinking**: `{ type: "adaptive" }`. Deciding whether an 1847 diary passage describes one
  event or three is genuinely multi-step reasoning, and it is worth the tokens.
- **Structured output**: define the event schema with `zod` and pass it via
  `output_config.format`, rather than prompting for JSON and parsing hopefully. This
  guarantees the response validates against `ParsedEvent[]` — the difference between a schema
  violation being impossible and it being a runtime surprise on document 4,000.
- **Streaming**: use `client.messages.stream()` with `.finalMessage()` for long documents.
  Non-streaming requests risk SDK HTTP timeouts at high `max_tokens`.
- **`max_tokens`**: generous (`~64000` when streaming). A dense document can legitimately yield
  dozens of events, and truncating mid-array wastes the whole call.

Do **not** set `temperature`/`top_p` — they are rejected on this model. Steer with the prompt.

## Chunking and checkpointing

Long documents exceed what one call should handle, so `extract` chunks them — the direct
analogue of `GroqEngine`'s WAV chunking.

State Affairs documented the gap it left: no chunk-level checkpointing, so exhausting the
in-job retry budget on chunk 15 of 18 meant a retried job re-sent all 18. **Build the
checkpointing in from the start** — persist each chunk's result as it succeeds (keyed by
document + chunk index) and skip completed indices on a fresh invocation. Retrying an LLM call
costs real money, which makes this materially more worth doing here than it was for a free
transcription tier.

Chunk on semantic boundaries (paragraphs, page breaks) rather than a fixed character count, and
**overlap slightly** — an event described across a chunk boundary is otherwise silently lost or
double-counted.

## Prompt design

The prompt is the actual product here and deserves iteration against a fixture set, not a
one-shot write. It must extract, per event: title, description, ISO-8601 date, the free-text
place name **as written in the document**, and a confidence score.

Three rules worth encoding explicitly:

- **Do not infer coordinates.** Geocoding is phase 9's job, deliberately. A model guessing
  latitude/longitude produces plausible, unverifiable, wrong pins.
- **Dates are frequently partial or uncertain.** "Spring 1847", "circa 1850", "the winter after
  the crossing" are the normal case in historical text, not the edge case. `ParsedEvent.date` is
  a `string`, so it can hold a partial ISO date — but the timeline slider and `eventYear()`
  need to cope. Settle the representation for uncertain dates before writing the prompt; it is
  a schema decision wearing a prompt's clothing.
- **Confidence must be usable.** It is the gate that keeps low-quality OCR from polluting the
  map, so it needs to mean something calibrated rather than being decorative.

## Cost

Unlike transcription's free tier, this has a per-document bill, so cost is a design input:

- Never re-extract a document whose text is unchanged — that is what the `etag`/304 path and
  `ingest_extractions` rows are for.
- Consider a cheap pre-filter (a keyword or date-pattern pass) to skip documents unlikely to
  contain located historical events before spending a call on them.
- Use the **Batches API** for backfill. Ingesting a historical archive is the textbook batch
  workload — not latency-sensitive, high volume, 50% cheaper.
- Prompt caching earns its keep if the instruction block is large and stable: put the frozen
  instructions first, the per-document text last.
