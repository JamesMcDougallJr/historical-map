import type { ConfigService } from "@nestjs/config";
import type { ExtractedEvent, ValidationCheck } from "@historical-map/domain";
import type { TextSegment } from "@app/parsers";
import { JevClient, choice, isJevFeatureEnabled, score } from "@app/jev";

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
 * `duplicate-jev` and `confidence-jev` are **non-gating**, matching
 * `checkGrounding`'s own precedent: record a new, unproven signal until
 * there's evidence for where to set a threshold, rather than let an
 * unvalidated classifier silently start rejecting events. `grounding-jev` is
 * the one that *can* gate, and only when `JEV_GROUNDING_MIN_SUPPORT` is
 * raised above its default of `0`.
 */

const MAX_CONTEXT_CHARS = 8_000;
const MAX_DEDUP_CANDIDATES = 15;
/** Segments of context after the anchor segment when the quote can't be located. */
const ANCHOR_FOLLOWING_SEGMENTS = 2;

export interface GroundingInput {
  documentText: string;
  /** The parsed text artifact's segments; absent for artifacts without them. */
  segments?: TextSegment[];
  /** Whether the deterministic `checkGrounding` already found the exact quote. */
  substringGrounded: boolean;
}

/**
 * Asks Jev whether the section of the document the event came from supports
 * its quoted `sourceText` — for the quotes `checkGrounding` could **not**
 * find verbatim.
 *
 * Only substring misses are sent: an exact match is already the strongest
 * grounding evidence there is, so asking Jev about it would spend a call to
 * re-confirm a certainty. On the first real run that was 90 of 131 quotes —
 * roughly 70% of the calls this skips.
 *
 * The question is a three-way Choice (`supports` / `contradicts` /
 * `says_nothing`) rather than a yes/no, per TypeSafe's citation-check
 * cookbook: a quote the document never mentions and one it flatly contradicts
 * are different failures, and a yes/no cannot tell them apart.
 *
 * **Gating.** `JEV_GROUNDING_MIN_SUPPORT` (0–1, default `0`) is the minimum
 * `P(supports)` for the event to stay publishable. At `0` the check can never
 * fail the gate — it records and reports at the natural 0.5 bar but never holds
 * anything — which is the bypass. Raising it holds substring-missed events whose
 * support falls below it for review. It can only hold events, never rescue
 * one: an exact-match quote is never sent here at all.
 */
export async function scoreGroundingWithJev(
  client: JevClient,
  config: ConfigService,
  event: ExtractedEvent,
  input: GroundingInput,
): Promise<ValidationCheck | null> {
  if (!isJevFeatureEnabled(config, client, "JEV_GROUNDING_ENABLED")) return null;
  if (input.substringGrounded) return null;
  if (!event.sourceText || event.sourceText.trim().length < 20) return null;
  if (!input.documentText) return null;

  const section = sectionFor(event, input);

  const answers = await client.tryAsk(
    { section, claim: event.sourceText },
    {
      relation: choice("How does the section relate to the claim?", {
        supports: "The section states the claim, or directly implies it is true — even in different words.",
        contradicts: "The section states something that conflicts with the claim.",
        says_nothing: "The section neither supports nor contradicts the claim; it is unrelated or silent on it.",
      }),
    },
  );
  const relation = answers?.relation;
  if (!relation) return null;

  const minSupport = config.get<number>("JEV_GROUNDING_MIN_SUPPORT") ?? 0;
  const gating = minSupport > 0;
  const { supports, contradicts, says_nothing } = relation.probabilities;
  const bar = gating ? minSupport : 0.5;

  return {
    name: "grounding-jev",
    passed: supports >= bar,
    gating,
    detail:
      `jev supports=${supports.toFixed(2)} contradicts=${contradicts.toFixed(2)} ` +
      `says_nothing=${says_nothing.toFixed(2)} (confidence ${relation.confidence.toFixed(2)})` +
      (gating ? ` — min support ${minSupport}` : ""),
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
 * The part of the document to show Jev: a section, not the whole (potentially
 * enormous) text. Located three ways, most to least precise:
 *
 * 1. **By the quote's opening words.** The whole point of this check is
 *    tolerating a quote that doesn't match verbatim, so the full string can't
 *    be the probe — but its first ~40 characters often still land in the right
 *    segment. That segment and its neighbours are sent.
 * 2. **By `event.anchor`.** That is the *first segment of the extraction
 *    chunk*, not necessarily the one holding the quote (a chunk spans several
 *    segments), so it takes the anchor segment plus the next few.
 * 3. **The old prefix window**, for artifacts without segments.
 */
function sectionFor(event: ExtractedEvent, input: GroundingInput): string {
  const { segments, documentText } = input;
  if (segments && segments.length > 0) {
    const probe = squash(event.sourceText).slice(0, 40);
    const hit = probe ? segments.findIndex((s) => squash(s.text).includes(probe)) : -1;
    if (hit >= 0) {
      return joinCapped(segments.slice(Math.max(0, hit - 1), hit + 2));
    }
    const anchored = event.anchor ? segments.findIndex((s) => s.anchor === event.anchor) : -1;
    if (anchored >= 0) {
      return joinCapped(segments.slice(anchored, anchored + 1 + ANCHOR_FOLLOWING_SEGMENTS));
    }
  }
  return documentText.slice(0, MAX_CONTEXT_CHARS);
}

function joinCapped(segments: TextSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS);
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
