import type { GeocodeDecision } from "@app/database";
import { choice, type JevClient } from "@app/jev";
import {
  distanceKm,
  type GeocodeCandidate,
  type GeocodeHit,
  type GeocodeOutcome,
} from "./geocoder.interface";

/** The event a place name came from — what a gazetteer never sees. */
export interface GeocodeContext {
  title: string;
  description?: string;
}

/** Two candidates this close are one place, as in the gazetteer tiers. */
const SAME_PLACE_KM = 25;
/** Bounds the Jev prompt; the tiers' own answer is always first. */
const MAX_OPTIONS = 8;

function samePlace(a: GeocodeCandidate, b: GeocodeCandidate): boolean {
  return distanceKm(a, b) <= SAME_PLACE_KM;
}

/**
 * The places a reader of the event could choose between: the tiers' answer
 * first, then everything they considered — WHG's unmatched records included —
 * one entry per distinct place.
 */
function options(outcome: GeocodeOutcome): GeocodeCandidate[] {
  const pool: GeocodeCandidate[] = [];
  const add = (c: GeocodeCandidate) => {
    if (!pool.some((p) => samePlace(p, c))) pool.push(c);
  };
  if (outcome.hit) add(outcome.hit);
  for (const c of outcome.considered ?? []) add(c);
  for (const c of outcome.declined?.candidates ?? []) add(c);
  return pool.slice(0, MAX_OPTIONS);
}

export interface ContextDecision {
  /** The pin to use: Jev's pick when it was applied, else the tiers' answer. */
  hit: GeocodeHit | null;
  /** Confidence in `hit` — Jev's, when Jev picked or confirmed that place. */
  confidence: number | null;
  decision: GeocodeDecision;
}

/**
 * The context tier. The gazetteer tiers judge a place *name*; this judges it
 * against the event that names it, which is the only way to tell a real
 * same-named place from the one the document means: WHG resolves
 * "Tepeyacac" — unambiguously, a single record — to a village in Puebla,
 * while the event is about the hill of Tepeyac in Mexico City, which WHG
 * returns too but marks `match: false`.
 *
 * Jev chooses among the candidates (or "none"). Its pick replaces the tiers'
 * answer only when it is a different place *and* its confidence clears
 * `threshold`; agreeing with the tiers is recorded as confirmation. Either
 * way the decision is returned for the cache, so a person can later reject
 * it. Returns `null` — the tiers' outcome stands, unrecorded — when there is
 * nothing to choose between or the Jev call fails.
 */
export async function decideWithContext(
  jev: JevClient,
  input: {
    placeName: string;
    outcome: GeocodeOutcome;
    context: GeocodeContext;
    threshold: number;
  },
): Promise<ContextDecision | null> {
  const { placeName, outcome, context, threshold } = input;
  const pool = options(outcome);
  if (pool.length === 0) return null;

  const criteria: Record<string, string> = {};
  pool.forEach((c, i) => {
    criteria[`place_${i}`] = `${c.displayName} (${c.lat.toFixed(3)}, ${c.lon.toFixed(3)})`;
  });
  criteria["none"] = "None of these is where the event happened.";

  const answers = await jev.tryAsk(
    {
      historical_place_name: placeName,
      event_title: context.title,
      ...(context.description ? { event_description: context.description } : {}),
      note:
        "These are gazetteer records for the place name. Several places can share " +
        "a name; a historical document usually means the one tied to its events.",
    },
    {
      place: choice(
        "Which of these places is the one the event happened at?",
        criteria,
      ),
    },
  );
  const answer = answers?.place;
  if (!answer) return null;

  const picked =
    answer.choice === "none"
      ? null
      : (pool[Number(answer.choice.replace("place_", ""))] ?? null);
  const tierHit = outcome.hit
    ? {
        lon: outcome.hit.lon,
        lat: outcome.hit.lat,
        displayName: outcome.hit.displayName,
      }
    : null;
  const agrees = !!(picked && tierHit && samePlace(picked, tierHit));
  const applied = !!picked && !agrees && answer.confidence >= threshold;

  const hit: GeocodeHit | null = applied
    ? { ...picked!, provider: "jev" }
    : outcome.hit;

  return {
    hit,
    confidence: applied || agrees ? answer.confidence : null,
    decision: {
      method: "jev-context",
      tierHit,
      picked,
      confidence: answer.confidence,
      threshold,
      applied,
      context,
      candidates: pool,
    },
  };
}
