import type { DatePrecision } from "./dates";

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Format an ISO date for display, showing only what the source actually knew.
 *
 * Shared because two consumers must agree: the map renders it, and the
 * embedding text (plans/13, plans/23) includes it — an event's vector should
 * say "1103", not the "January 1, 1103" its stored placeholder implies.
 *
 * `events.date` is `date NOT NULL`, so an event dated only to 1103 is stored as
 * `1103-01-01`. Formatting that without its precision produces "January 1,
 * 1103" — a specific day asserted from nothing, and the overwhelmingly common
 * case: 50 of the first 60 ingested events are year-only. `precision` is what
 * distinguishes a stored placeholder from a real date, so pass it whenever the
 * event carries one.
 *
 * `dateText` is the source's own wording and wins for `season`, which cannot be
 * recovered from the ISO date at all ("Spring 1847" is stored as some day in
 * spring).
 *
 * Absent precision means day, which is correct for hand-curated events.
 *
 * @param isoDate - ISO 8601 date string (e.g., "1869-05-10")
 * @param precision - how much of `isoDate` the source supports
 * @param dateText - the date as the source wrote it
 * @returns e.g. "May 10, 1869", "1103", "c. 1850", "1840s", "Spring 1847"
 */
export function formatDate(
  isoDate: string,
  precision?: DatePrecision,
  dateText?: string,
): string {
  const parts = isoDate.split("-");
  const year = parts[0];
  if (!year) return isoDate;

  switch (precision) {
    case "decade":
      return `${year.slice(0, -1)}0s`;
    case "circa":
      return `c. ${year}`;
    case "season":
      // Only the source's wording carries the season.
      return dateText?.trim() || year;
    case "year":
      return year;
    default:
      break;
  }

  // Year only
  if (parts.length === 1) return year;

  const monthPart = parts[1];
  if (!monthPart) return year;

  const monthIndex = parseInt(monthPart, 10) - 1;
  const monthName = MONTH_NAMES[monthIndex] ?? monthPart;

  // Year and month only — either because the string stops there, or because
  // the source only dated it that far and the day is a stored placeholder.
  if (parts.length === 2 || precision === "month") {
    return `${monthName} ${year}`;
  }

  // Full date
  const dayPart = parts[2];
  if (!dayPart) return `${monthName} ${year}`;

  const day = parseInt(dayPart, 10);
  return `${monthName} ${day}, ${year}`;
}
