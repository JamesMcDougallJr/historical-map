import { createHash } from "node:crypto";
import { formatDate, type DatePrecision } from "@historical-map/domain";

export interface ComposableEvent {
  title: string;
  description: string;
  placeName: string;
  /** ISO `YYYY-MM-DD`, as stored — a placeholder day when precision is coarser. */
  date: string;
  datePrecision?: DatePrecision | null;
  dateText?: string | null;
}

/**
 * Plan 13's composition, the one text an event is embedded as — for dedup and
 * for search alike (plans/23, "What gets embedded"):
 *
 *   {title}. {description} Place: {placeName}. Date: {dateText}.
 *
 * **No `sourceText`.** Two extractions of the same event from different books
 * share no quote, so including it makes real cross-source duplicates look less
 * alike; for search, passages already cover the quote. The date is rendered as
 * the map renders it, so a year-only event says "1103", not a day no source
 * gave.
 */
export function composeEventText(event: ComposableEvent): string {
  const date = formatDate(
    event.date,
    event.datePrecision ?? undefined,
    event.dateText ?? undefined,
  );
  return (
    `${withPeriod(event.title)} ${withPeriod(event.description)} ` +
    `Place: ${withPeriod(event.placeName)} Date: ${withPeriod(date)}`
  )
    .replace(/\s+/g, " ")
    .trim();
}

export interface ComposableGroup {
  title: string;
  description?: string | null;
  /** Member event titles, in the sequence's `seq` order. */
  memberTitles: string[];
}

/**
 * A sequence's text: `{title}. {description} Includes: {member titles, seq order}`.
 * The members are what make "the sequence of events at the southern Utah
 * valley in 1857" find a group whose own title says neither.
 */
export function composeGroupText(group: ComposableGroup): string {
  const includes = group.memberTitles.map((t) => t.trim()).join("; ");
  return (
    `${withPeriod(group.title)} ${withPeriod(group.description ?? "")} ` +
    (includes ? `Includes: ${withPeriod(includes)}` : "")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stored beside every vector; a mismatch with the freshly composed text is
 * what marks it stale after an edit (plans/23, "Staleness").
 */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** "Fall of Tula" → "Fall of Tula."; "Fall of Tula." and "" stay as they are. */
function withPeriod(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]["')\]]?$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
