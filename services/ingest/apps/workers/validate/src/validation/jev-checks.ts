import type { ConfigService } from "@nestjs/config";
import type { ExtractedEvent, ValidationCheck } from "@historical-map/domain";
import type { TextSegment } from "@app/parsers";
import {
  JevClient,
  choice,
  isJevFeatureEnabled,
  score,
  type ChoiceResponse,
  type Questions,
  type ScoreResponse,
} from "@app/jev";

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

export interface EventJudgments {
  grounding: ValidationCheck | null;
  confidence: ValidationCheck | null;
}

/**
 * Concrete situations, not adjectives: TypeSafe's Score guidance is that each
 * level must describe something that can be recognised on its own ("very low"
 * ... "very high" gives the model nothing to anchor on).
 */
const CONFIDENCE_LEVELS = [
  "The quoted text is unrelated to the event, or contradicts it.",
  "The quoted text is about the same subject but does not say the event happened as described.",
  "The quoted text says the event happened, but confirms neither its date nor its place.",
  "The quoted text says the event happened and confirms either its date or its place.",
  "The quoted text says the event happened and confirms both its date and its place.",
] as const;

/** Level at which the quote is taken to substantiate the event at all. */
const CONFIDENCE_PASS_LEVEL = 2;

/**
 * Both per-event Jev judgments in **one request**.
 *
 * Grounding and confidence judge the same event and quote, and independent
 * questions over shared state run in parallel server-side, so asking them
 * together costs one round-trip instead of two on a worker hot path. Each is
 * independently flagged: whichever is disabled is simply left out of the
 * request, and if neither is wanted no request is made at all. A failed call
 * (or an answer the service did not deliver) resolves both to `null`, so
 * callers append nothing and behave exactly as they did before Jev.
 *
 * **Grounding** asks Jev whether the section of the document the event came
 * from supports its quoted `sourceText` — for the quotes `checkGrounding`
 * could **not** find verbatim. An exact match is already the strongest
 * grounding evidence there is, so asking about it would spend a call to
 * re-confirm a certainty (90 of 131 quotes on the first real run). The
 * question is a three-way Choice (`supports` / `contradicts` / `says_nothing`)
 * rather than a yes/no, per TypeSafe's citation-check cookbook: a quote the
 * document never mentions and one it flatly contradicts are different
 * failures.
 *
 * `JEV_GROUNDING_MIN_SUPPORT` (0–1, default `0`) is the minimum `P(supports)`
 * for the event to stay publishable. At `0` the check can never fail the gate —
 * it records and reports at the natural 0.5 bar but never holds anything — which
 * is the bypass. Raising it holds low-support events for review. It can only
 * hold events, never rescue one: an exact-match quote is never sent at all.
 *
 * **Confidence** is an independent re-score of the extractor's self-reported
 * `confidence`. The self-reported number is deliberately *not* in the state —
 * showing it would contaminate a judgment meant to be independent — and appears
 * only in the recorded detail, for comparison. Non-gating.
 */
export async function judgeEventWithJev(
  client: JevClient,
  config: ConfigService,
  event: ExtractedEvent,
  input: GroundingInput,
): Promise<EventJudgments> {
  const none: EventJudgments = { grounding: null, confidence: null };

  const wantGrounding =
    isJevFeatureEnabled(config, client, "JEV_GROUNDING_ENABLED") &&
    !input.substringGrounded &&
    event.sourceText.trim().length >= 20 &&
    input.documentText.length > 0;
  const wantConfidence = isJevFeatureEnabled(config, client, "JEV_CONFIDENCE_RESCORE_ENABLED");
  if (!wantGrounding && !wantConfidence) return none;

  const state: Record<string, string | Record<string, string>> = {
    event: {
      title: event.title,
      date: event.dateText,
      place: event.placeName ?? "(none given)",
      description: event.description,
    },
    claim: event.sourceText,
  };
  const questions: Questions = {};

  if (wantGrounding) {
    state["section"] = sectionFor(event, input);
    questions["relation"] = choice("How does the section relate to the claim?", {
      supports: "The section states the claim, or directly implies it is true — even in different words.",
      contradicts: "The section states something that conflicts with the claim.",
      says_nothing: "The section neither supports nor contradicts the claim; it is unrelated or silent on it.",
    });
  }
  if (wantConfidence) {
    questions["confidence"] = score(
      "How well does the claim, a quote from the source document, substantiate the event?",
      CONFIDENCE_LEVELS,
    );
  }

  const answers = await client.tryAsk(state, questions);
  if (!answers) return none;

  const relation = answers["relation"];
  const level = answers["confidence"];
  return {
    grounding:
      wantGrounding && relation?.type === "choice"
        ? groundingCheck(relation, config.get<number>("JEV_GROUNDING_MIN_SUPPORT") ?? 0)
        : null,
    confidence:
      wantConfidence && level?.type === "score" ? confidenceCheck(level, event) : null,
  };
}

function groundingCheck(relation: ChoiceResponse, minSupport: number): ValidationCheck {
  const gating = minSupport > 0;
  const supports = relation.probabilities["supports"] ?? 0;
  const contradicts = relation.probabilities["contradicts"] ?? 0;
  const saysNothing = relation.probabilities["says_nothing"] ?? 0;
  const bar = gating ? minSupport : 0.5;

  return {
    name: "grounding-jev",
    passed: supports >= bar,
    gating,
    detail:
      `jev supports=${supports.toFixed(2)} contradicts=${contradicts.toFixed(2)} ` +
      `says_nothing=${saysNothing.toFixed(2)} (confidence ${relation.confidence.toFixed(2)})` +
      (gating ? ` — min support ${minSupport}` : ""),
  };
}

function confidenceCheck(level: ScoreResponse, event: ExtractedEvent): ValidationCheck {
  return {
    name: "confidence-jev",
    passed: level.score >= CONFIDENCE_PASS_LEVEL,
    gating: false,
    detail:
      `jev score=${level.score.toFixed(1)}/${CONFIDENCE_LEVELS.length - 1} ` +
      `(confidence ${level.confidence.toFixed(2)}) vs self-reported ${event.confidence}`,
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
