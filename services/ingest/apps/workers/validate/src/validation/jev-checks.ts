import type { ConfigService } from "@nestjs/config";
import type { ExtractedEvent, ValidationCheck } from "@historical-map/domain";
import { JevClient, isJevFeatureEnabled } from "@app/jev";

/**
 * Jev-backed enhancements to the deterministic checks in `validators.ts`.
 *
 * Deliberately **separate** from `validators.ts` rather than folded into its
 * functions: that file is documented as pure, synchronous, no-network checks,
 * and every function here does a real HTTP call. Each one returns `null`
 * when its flag is off, Jev has no credentials, or the call itself fails —
 * callers simply skip appending the check in that case, so disabling a flag
 * (or Jev being down) reproduces pre-Jev behaviour exactly, not a degraded
 * version of it.
 *
 * All three are **non-gating**, matching `checkGrounding`'s own precedent:
 * record a new, unproven signal until there's evidence for where to set a
 * threshold, rather than let an unvalidated classifier silently start
 * rejecting events.
 */

const MAX_CONTEXT_CHARS = 8_000;
const MAX_DEDUP_CANDIDATES = 15;

/**
 * Independent yes/no check on whether the document excerpt actually supports
 * the quoted `sourceText` — the same question `checkGrounding` asks via exact
 * substring match, but tolerant of paraphrase and reflow, which substring
 * match is not.
 */
export async function scoreGroundingWithJev(
  client: JevClient,
  config: ConfigService,
  event: ExtractedEvent,
  documentText: string,
): Promise<ValidationCheck | null> {
  if (!isJevFeatureEnabled(config, client, "JEV_GROUNDING_ENABLED")) return null;
  if (!event.sourceText || event.sourceText.trim().length < 20) return null;
  if (!documentText) return null;

  const snippet = excerptAround(documentText, event.sourceText, MAX_CONTEXT_CHARS / 2);

  const answers = await client.tryAsk({
    context: `Document excerpt:\n${snippet}\n\nClaimed quote from this document:\n"${event.sourceText}"`,
    questions: [
      {
        id: "grounded",
        kind: "noul",
        prompt:
          "Does the document excerpt actually support the claimed quote, allowing for paraphrase, reflow, or minor wording differences — as opposed to the quote being fabricated or unrelated to this excerpt?",
      },
    ],
  });
  const answer = answers?.[0];
  if (!answer) return null;

  const grounded = answer.value === 1;
  return {
    name: "grounding-jev",
    passed: grounded,
    gating: false,
    detail: `jev p=${answer.probability.toFixed(2)}${grounded ? "" : " — not supported"}`,
  };
}

/**
 * Near-duplicate check beyond `checkDuplicate`'s exact title+date match.
 *
 * Bucketed on year (not year+place) before asking, per `plans/11`'s own
 * caution that place+year alone isn't safe grounds to merge — two distinct
 * events can share both — so the actual same-event judgment is left to Jev,
 * given full descriptions, not inferred from the bucket. Candidates are
 * capped because the question is one Choice call over all same-year events
 * seen so far in this run, which otherwise grows unbounded over a long run.
 *
 * This **flags for review, it does not merge** — plan 11 is explicit that
 * fusion needs a schema change this is not attempting.
 */
export async function scoreDuplicateWithJev(
  client: JevClient,
  config: ConfigService,
  event: ExtractedEvent,
  seenEvents: ExtractedEvent[],
): Promise<ValidationCheck | null> {
  if (!isJevFeatureEnabled(config, client, "JEV_DEDUP_SCORING_ENABLED")) return null;

  const year = yearOf(event);
  const pool = (year === null ? seenEvents : seenEvents.filter((e) => yearOf(e) === year)).slice(
    -MAX_DEDUP_CANDIDATES,
  );
  if (pool.length === 0) return null;

  const noneOptionIndex = pool.length;
  const options = [
    ...pool.map((c) => `${c.title} — ${c.description}`.slice(0, 160)),
    "none of the above describe the same event",
  ];

  const answers = await client.tryAsk({
    context: [
      "New candidate event:",
      `Title: ${event.title}`,
      `Date: ${event.dateText}`,
      `Description: ${event.description}`,
      `Quote: ${event.sourceText.slice(0, 300)}`,
    ].join("\n"),
    questions: [
      {
        id: "match",
        kind: "choice",
        prompt:
          "Which of these previously-seen events, if any, describes the same real-world historical event as the new candidate above? Sharing a year or place is not by itself enough to call two events the same.",
        options,
      },
    ],
  });
  const answer = answers?.[0];
  if (!answer) return null;

  const matchedNone = answer.value === noneOptionIndex;
  return {
    name: "duplicate-jev",
    passed: matchedNone,
    gating: false,
    detail: matchedNone
      ? undefined
      : `possible duplicate of "${pool[answer.value]?.title}" (p=${answer.probability.toFixed(2)}) — flagged for review, not auto-merged`,
  };
}

/**
 * Independent re-scoring of the extraction model's self-reported `confidence`
 * — which `checkConfidence` only thresholds, never verifies. Recorded
 * alongside, not blended into, the existing gating check: the point is to
 * accumulate evidence on how well the two agree before trusting either to
 * override the other.
 */
export async function rescoreConfidenceWithJev(
  client: JevClient,
  config: ConfigService,
  event: ExtractedEvent,
): Promise<ValidationCheck | null> {
  if (!isJevFeatureEnabled(config, client, "JEV_CONFIDENCE_RESCORE_ENABLED"))
    return null;

  const tiers = ["very low", "low", "medium", "high", "very high"];
  const answers = await client.tryAsk({
    context: [
      "Extracted historical event:",
      `Title: ${event.title}`,
      `Date: ${event.dateText}`,
      `Place: ${event.placeName ?? "(none given)"}`,
      `Description: ${event.description}`,
      `Quoted source text: ${event.sourceText.slice(0, 400)}`,
      `Extraction model's self-reported confidence: ${event.confidence}`,
    ].join("\n"),
    questions: [
      {
        id: "confidence",
        kind: "score",
        prompt:
          "Independent of the self-reported confidence above, how well does the quoted source text substantiate this event being real, and dated and placed as claimed?",
        tiers,
      },
    ],
  });
  const answer = answers?.[0];
  if (!answer) return null;

  const jevConfidence = answer.value / (tiers.length - 1);
  const agrees = Math.abs(jevConfidence - event.confidence) <= 0.34;
  return {
    name: "confidence-jev",
    passed: agrees,
    gating: false,
    detail: `jev=${tiers[answer.value]} (${jevConfidence.toFixed(2)}) vs self-reported ${event.confidence}`,
  };
}

function yearOf(event: ExtractedEvent): number | null {
  const match = /\d{4}/.exec(event.dateIso ?? event.dateText);
  return match ? Number(match[0]) : null;
}

/**
 * A window of `documentText` around the quote, rather than the whole
 * (potentially large) document — bounds the context sent to Jev. Located by
 * the quote's first ~40 characters rather than the whole string, since the
 * whole point of this check is tolerating a quote that doesn't match
 * verbatim; the probe only needs to land in the right neighbourhood.
 */
function excerptAround(documentText: string, quote: string, radius: number): string {
  const probe = quote.trim().slice(0, 40).toLowerCase();
  const idx = documentText.toLowerCase().indexOf(probe);
  if (idx === -1) return documentText.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(documentText.length, idx + probe.length + radius);
  return documentText.slice(start, end);
}
