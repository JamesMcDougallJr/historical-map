import type { ConfigService } from "@nestjs/config";
import type { ExtractedEvent, ValidationCheck } from "@historical-map/domain";
import { JevClient, isJevFeatureEnabled, noul, type Questions } from "@app/jev";

/**
 * Cross-document duplicate detection at publish time.
 *
 * Two documents describing one real-world event produce two pins today: the
 * event id hashes the document's `externalId`, so nothing ever collides. This
 * finds already-published events that *might* be the same one (nearby place,
 * close date), asks Jev whether each is, and reports the best match. It never
 * merges — a probable duplicate is held for review (or just recorded), because
 * fusing needs event identity and provenance the schema does not have yet
 * (`plans/11-identity-and-fusion.md`).
 */

/** Place radius for candidates. Geocodes of one place vary by a few km. */
export const DEDUP_RADIUS_M = 5_000;
/** Rows pulled from SQL before the precision-aware date filter. */
export const DEDUP_POOL_LIMIT = 25;
/** Candidates actually shown to Jev: bounds the questions (and cost) per event. */
export const DEDUP_MAX_CANDIDATES = 8;
/** Widest date window SQL pre-filters on; `datesCompatible` narrows it. */
export const DEDUP_POOL_DAYS = 366;

/** A published event nearby, as `MapWriterService.findNearbyEvents` returns it. */
export interface NearbyEvent {
  id: string;
  title: string;
  description: string;
  /** `YYYY-MM-DD`; a year-only date is stored as `YYYY-01-01`. */
  date: string;
  datePrecision: string | null;
  dateText: string | null;
  sourceId: string;
  placeName: string;
  /** The quote the event was published from (the `events.source` column). */
  quote: string | null;
}

type Precision = "year" | "month" | "day";

function precisionOf(value: string | null | undefined): Precision {
  // Older rows have no `date_precision`; treat them as the coarsest, so they
  // are compared generously rather than ruled out on a precision nobody knows.
  return value === "day" || value === "month" ? value : "year";
}

const RANK: Record<Precision, number> = { year: 0, month: 1, day: 2 };

const DAY_MS = 86_400_000;

function dayNumber(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

/**
 * Could two events with these dates be the same event?
 *
 * The window is set by the **coarser** of the two precisions: a year-only date
 * (stored as `YYYY-01-01`) says nothing about the day, so an exact-date match
 * would miss "1850" against "1850-06-02". Year → same or adjacent calendar
 * year; month → within 45 days; day → within 14 days.
 */
export function datesCompatible(
  a: string,
  aPrecision: string | null | undefined,
  b: string,
  bPrecision: string | null | undefined,
): boolean {
  const pa = precisionOf(aPrecision);
  const pb = precisionOf(bPrecision);
  const coarser = RANK[pa] <= RANK[pb] ? pa : pb;

  if (coarser === "year") {
    return Math.abs(Number(a.slice(0, 4)) - Number(b.slice(0, 4))) <= 1;
  }
  const gap = Math.abs(dayNumber(a) - dayNumber(b));
  return gap <= (coarser === "month" ? 45 : 14);
}

/** The nearest `DEDUP_MAX_CANDIDATES` of `pool` whose dates are compatible. */
export function selectCandidates(
  event: Pick<ExtractedEvent, "dateIso" | "datePrecision">,
  pool: NearbyEvent[],
): NearbyEvent[] {
  if (!event.dateIso) return [];
  const date = event.dateIso;
  return pool
    .filter((c) => datesCompatible(date, event.datePrecision, c.date, c.datePrecision))
    .slice(0, DEDUP_MAX_CANDIDATES);
}

export const DUPLICATE_PUBLISHED_CHECK = "duplicate-published";

/**
 * One request, one yes/no question per candidate. TypeSafe's reranking
 * cookbook scores each candidate independently rather than asking for a pick
 * from a list, which yields a calibrated probability per pair to threshold on;
 * independent questions over shared state run in parallel server-side.
 *
 * `JEV_PUBLISH_DEDUP_HOLD_AT` (0–1, default `0`) is the `P(same)` at or above
 * which the event is held for review. `0` never holds: the check is still
 * recorded (reported at the natural 0.5 bar), which is also the bypass. Returns
 * `null` — no check, no hold — when the flag is off, there is nothing to compare
 * against, or the call fails: an outage can never newly hold an event.
 */
export async function judgeDuplicateWithJev(
  client: JevClient,
  config: ConfigService,
  event: ExtractedEvent,
  candidates: NearbyEvent[],
): Promise<ValidationCheck | null> {
  if (!isJevFeatureEnabled(config, client, "JEV_PUBLISH_DEDUP_ENABLED")) return null;
  if (candidates.length === 0) return null;

  const state = {
    new_event: {
      title: event.title,
      date: event.dateText,
      place: event.placeName ?? "(none given)",
      description: event.description,
      quote: event.sourceText.slice(0, 300),
    },
    existing: candidates.map((c, index) => ({
      index,
      title: c.title,
      date: c.dateText ?? c.date,
      place: c.placeName,
      description: c.description,
      quote: (c.quote ?? "").slice(0, 300),
      source: c.sourceId,
    })),
  };

  const questions: Questions = {};
  candidates.forEach((_, i) => {
    questions[`same_${i}`] = noul(
      `Is the new event the same real-world historical event as existing event ${i}? ` +
        "Sharing a year or a place is not by itself enough.",
      {
        true: "They describe the same occurrence, even if worded differently or from a different source.",
        false: "They are different events, even if close in place or time.",
      },
    );
  });

  const answers = await client.tryAsk(state, questions);
  if (!answers) return null;

  let best = { index: -1, p: -1 };
  for (let i = 0; i < candidates.length; i++) {
    const answer = answers[`same_${i}`];
    if (answer?.type === "noul" && answer.noul > best.p) best = { index: i, p: answer.noul };
  }
  const match = candidates[best.index];
  if (!match) return null;

  const holdAt = config.get<number>("JEV_PUBLISH_DEDUP_HOLD_AT") ?? 0;
  const gating = holdAt > 0;
  const bar = gating ? holdAt : 0.5;
  const passed = best.p < bar;

  return {
    name: DUPLICATE_PUBLISHED_CHECK,
    passed,
    gating,
    detail:
      `jev p(same)=${best.p.toFixed(2)} with "${match.title}" ` +
      `(matched=${match.id}, source ${match.sourceId}, ${match.dateText ?? match.date})` +
      (passed ? " — kept as distinct" : " — probable duplicate") +
      (gating ? `; hold at ${holdAt}` : ""),
  };
}
