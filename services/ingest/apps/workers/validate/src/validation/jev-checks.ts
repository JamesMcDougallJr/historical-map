import type { ConfigService } from "@nestjs/config";
import type { ExtractedEvent, ValidationCheck } from "@historical-map/domain";
import { JevClient, choice, isJevFeatureEnabled, noul, score } from "@app/jev";

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

  const answers = await client.tryAsk(
    { document_excerpt: snippet, claimed_quote: event.sourceText },
    {
      grounded: noul(
        "Does the document excerpt support the claimed quote, allowing for paraphrase, reflow, or minor wording differences?",
        {
          true: "The excerpt says the same thing as the quote, even in different words.",
          false: "The quote is fabricated, contradicts the excerpt, or is unrelated to it.",
        },
      ),
    },
  );
  const probability = answers?.grounded.noul;
  if (probability === undefined) return null;

  const grounded = probability >= 0.5;
  return {
    name: "grounding-jev",
    passed: grounded,
    gating: false,
    detail: `jev p(grounded)=${probability.toFixed(2)}${grounded ? "" : " — not supported"}`,
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

  const criteria: Record<string, string> = {};
  pool.forEach((c, i) => {
    criteria[`event_${i}`] = `${c.title} — ${c.description}`.slice(0, 160);
  });
  criteria["none"] = "None of the above describe the same event.";

  const answers = await client.tryAsk(
    {
      new_event: {
        title: event.title,
        date: event.dateText,
        description: event.description,
        quote: event.sourceText.slice(0, 300),
      },
    },
    {
      match: choice(
        "Which of these previously-seen events, if any, describes the same real-world historical event as the new event? Sharing a year or place is not by itself enough to call two events the same.",
        criteria,
      ),
    },
  );
  const answer = answers?.match;
  if (!answer) return null;

  const matchedNone = answer.choice === "none";
  const matchedIndex = Number(answer.choice.replace("event_", ""));
  return {
    name: "duplicate-jev",
    passed: matchedNone,
    gating: false,
    detail: matchedNone
      ? undefined
      : `possible duplicate of "${pool[matchedIndex]?.title}" (confidence ${answer.confidence.toFixed(2)}) — flagged for review, not auto-merged`,
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

  const tiers = ["very low", "low", "medium", "high", "very high"] as const;
  const answers = await client.tryAsk(
    {
      event: {
        title: event.title,
        date: event.dateText,
        place: event.placeName ?? "(none given)",
        description: event.description,
        quoted_source_text: event.sourceText.slice(0, 400),
      },
      extraction_self_reported_confidence: event.confidence,
    },
    {
      confidence: score(
        "Independent of the self-reported confidence, how well does the quoted source text substantiate this event being real, and dated and placed as claimed?",
        tiers,
      ),
    },
  );
  const answer = answers?.confidence;
  if (!answer) return null;

  const jevConfidence = answer.score / (tiers.length - 1);
  const agrees = Math.abs(jevConfidence - event.confidence) <= 0.34;
  return {
    name: "confidence-jev",
    passed: agrees,
    gating: false,
    detail: `jev=${jevConfidence.toFixed(2)} (confidence ${answer.confidence.toFixed(2)}) vs self-reported ${event.confidence}`,
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
