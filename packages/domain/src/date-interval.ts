// The span of years an event's date actually covers, given its precision.
//
// `events.date` is a single `date`, so a year-only event is stored as
// `1847-01-01` and a "circa 1850" one as some day in 1850. Comparing that
// stored day against a range asserts a precision the source never gave: the
// year-only event "is" in 1847 for all of 1847, and the circa one plausibly
// sits a few years either side. Anything that asks "is this event in that
// range?" — search's timeline filter today, fusion's date-overlap check
// (plan 13) later — should ask it here, so the two can't drift.
//
// Year granularity is deliberate: every range the app filters by (the
// timeline, a parsed query date) is whole years, and at that grain day,
// month and season precision all collapse to "that year".
//
// The SQL twin lives in `ensureSchema()` (`event_lo_year` / `event_hi_year`,
// lib/postgres-storage.ts). Change both together.

import type { DatePrecision } from "./dates";

/** How far either side of its year a `circa` date may fall. */
export const CIRCA_TOLERANCE_YEARS = 5;

/** Inclusive `[firstYear, lastYear]`. Either end may be ±Infinity for an open range. */
export type YearRange = [number, number];

/** Year of an ISO `YYYY-MM-DD` date, without going through `Date` (no timezone shifts). */
export function isoYear(isoDate: string): number {
  return parseInt(isoDate.slice(0, 4), 10);
}

/** The inclusive year span an event dated `isoDate` at `precision` covers. */
export function eventYearSpan(
  isoDate: string,
  precision?: DatePrecision,
): YearRange {
  const year = isoYear(isoDate);
  switch (precision) {
    case "decade": {
      const start = year - (((year % 10) + 10) % 10);
      return [start, start + 9];
    }
    case "circa":
      return [year - CIRCA_TOLERANCE_YEARS, year + CIRCA_TOLERANCE_YEARS];
    default:
      // day, month, season, year — and absent, which means day.
      return [year, year];
  }
}

/** Do two inclusive year ranges share at least one year? */
export function yearRangesOverlap(a: YearRange, b: YearRange): boolean {
  return a[0] <= b[1] && a[1] >= b[0];
}

/** Does an event's precision-aware span overlap `range`? */
export function eventInYearRange(
  isoDate: string,
  precision: DatePrecision | undefined,
  range: YearRange,
): boolean {
  return yearRangesOverlap(eventYearSpan(isoDate, precision), range);
}

/** Intersection of two year ranges, or null when they don't overlap. */
export function intersectYearRanges(
  a: YearRange,
  b: YearRange,
): YearRange | null {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return lo <= hi ? [lo, hi] : null;
}
