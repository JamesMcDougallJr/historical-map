// Date formatting helpers for historical events

import type { DatePrecision } from "../types";

const MONTH_NAMES = [
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

const MONTH_ABBREVS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Format an ISO date for display, showing only what the source actually knew.
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

/**
 * Format date to short format
 * @param isoDate - ISO 8601 date string
 * @returns Short formatted date (e.g., "May 1869")
 */
export function formatDateShort(isoDate: string): string {
  const parts = isoDate.split("-");
  const year = parts[0];
  if (!year) return isoDate;

  if (parts.length === 1) return year;

  const monthPart = parts[1];
  if (!monthPart) return year;

  const monthIndex = parseInt(monthPart, 10) - 1;
  const monthAbbrev = MONTH_ABBREVS[monthIndex] ?? monthPart;

  return `${monthAbbrev} ${year}`;
}

/**
 * Extract year from ISO date string
 * @param isoDate - ISO 8601 date string
 * @returns Year as string
 */
export function getYear(isoDate: string): string {
  return isoDate.split("-")[0] ?? isoDate;
}

/**
 * Sort events chronologically
 * @param events - Array of events with date property
 * @returns Sorted array (earliest first)
 */
export function sortByDate<T extends { date: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateA - dateB;
  });
}

/**
 * Group events by year
 * @param events - Array of events with date property
 * @returns Map of year to events
 */
export function groupByYear<T extends { date: string }>(
  events: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const event of events) {
    const year = getYear(event.date);
    const existing = groups.get(year) ?? [];
    groups.set(year, [...existing, event]);
  }

  return groups;
}

/**
 * Parse various date formats to ISO 8601
 * @param dateStr - Date string in various formats
 * @returns ISO 8601 date string or null if unparseable
 */
export function parseToISO(dateStr: string): string | null {
  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  // Year only: "1869"
  if (/^\d{4}$/.test(dateStr)) {
    return dateStr;
  }

  // Month Day, Year: "May 10, 1869"
  const mdyMatch = dateStr.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdyMatch) {
    const [, monthStr, day, year] = mdyMatch;
    const monthIndex = MONTH_NAMES.findIndex(
      (m) => m.toLowerCase() === monthStr?.toLowerCase(),
    );
    if (monthIndex !== -1 && day && year) {
      const month = String(monthIndex + 1).padStart(2, "0");
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  // Month abbreviation: "May 10, 1869" or "May. 10, 1869"
  const abbrevMatch = dateStr.match(/^(\w{3})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (abbrevMatch) {
    const [, monthStr, day, year] = abbrevMatch;
    const monthIndex = MONTH_ABBREVS.findIndex(
      (m) => m.toLowerCase() === monthStr?.toLowerCase(),
    );
    if (monthIndex !== -1 && day && year) {
      const month = String(monthIndex + 1).padStart(2, "0");
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  // US format: "5/10/1869" or "05/10/1869"
  const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    if (month && day && year) {
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }

  return null;
}
