// Date formatting helpers for historical events

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_ABBREVS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/**
 * Format ISO date string to readable format
 * @param isoDate - ISO 8601 date string (e.g., "1869-05-10")
 * @returns Formatted date string (e.g., "May 10, 1869")
 */
export function formatDate(isoDate: string): string {
  const parts = isoDate.split('-');
  const year = parts[0];
  if (!year) return isoDate;

  // Year only
  if (parts.length === 1) return year;

  const monthPart = parts[1];
  if (!monthPart) return year;

  const monthIndex = parseInt(monthPart, 10) - 1;
  const monthName = MONTH_NAMES[monthIndex] ?? monthPart;

  // Year and month only
  if (parts.length === 2) return `${monthName} ${year}`;

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
  const parts = isoDate.split('-');
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
  return isoDate.split('-')[0] ?? isoDate;
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
export function groupByYear<T extends { date: string }>(events: T[]): Map<string, T[]> {
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
      m => m.toLowerCase() === monthStr?.toLowerCase()
    );
    if (monthIndex !== -1 && day && year) {
      const month = String(monthIndex + 1).padStart(2, '0');
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }

  // Month abbreviation: "May 10, 1869" or "May. 10, 1869"
  const abbrevMatch = dateStr.match(/^(\w{3})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (abbrevMatch) {
    const [, monthStr, day, year] = abbrevMatch;
    const monthIndex = MONTH_ABBREVS.findIndex(
      m => m.toLowerCase() === monthStr?.toLowerCase()
    );
    if (monthIndex !== -1 && day && year) {
      const month = String(monthIndex + 1).padStart(2, '0');
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }

  // US format: "5/10/1869" or "05/10/1869"
  const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    if (month && day && year) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }

  return null;
}
