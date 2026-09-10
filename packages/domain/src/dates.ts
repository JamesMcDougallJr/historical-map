// Regex patterns for various date formats

export interface DateMatch {
  raw: string;
  normalized: string; // ISO 8601 format
  confidence: number; // 0-1
  index: number; // Position in original text
}

// Pattern definitions with confidence levels
const DATE_PATTERNS: Array<{
  pattern: RegExp;
  confidence: number;
  normalize: (match: RegExpMatchArray) => string | null;
}> = [
  // ISO format: "1869-05-10" (highest confidence)
  {
    pattern: /(\d{4})-(\d{2})-(\d{2})/g,
    confidence: 1.0,
    normalize: (m) => m[0] ?? null,
  },

  // Full month name: "May 10, 1869"
  {
    pattern:
      /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/gi,
    confidence: 0.95,
    normalize: (m) => {
      const monthNames: Record<string, string> = {
        january: '01', february: '02', march: '03', april: '04',
        may: '05', june: '06', july: '07', august: '08',
        september: '09', october: '10', november: '11', december: '12',
      };
      const month = monthNames[m[1]?.toLowerCase() ?? ''];
      const day = m[2]?.padStart(2, '0');
      const year = m[3];
      if (month && day && year) {
        return `${year}-${month}-${day}`;
      }
      return null;
    },
  },

  // Abbreviated month: "May. 10, 1869" or "May 10, 1869"
  {
    pattern: /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})/gi,
    confidence: 0.9,
    normalize: (m) => {
      const monthAbbrevs: Record<string, string> = {
        jan: '01', feb: '02', mar: '03', apr: '04',
        may: '05', jun: '06', jul: '07', aug: '08',
        sep: '09', oct: '10', nov: '11', dec: '12',
      };
      const month = monthAbbrevs[m[1]?.toLowerCase() ?? ''];
      const day = m[2]?.padStart(2, '0');
      const year = m[3];
      if (month && day && year) {
        return `${year}-${month}-${day}`;
      }
      return null;
    },
  },

  // US format: "5/10/1869" or "05/10/1869"
  {
    pattern: /(\d{1,2})\/(\d{1,2})\/(\d{4})/g,
    confidence: 0.85,
    normalize: (m) => {
      const month = m[1]?.padStart(2, '0');
      const day = m[2]?.padStart(2, '0');
      const year = m[3];
      if (month && day && year) {
        return `${year}-${month}-${day}`;
      }
      return null;
    },
  },

  // European format: "10-5-1869" or "10.5.1869"
  {
    pattern: /(\d{1,2})[-.](\d{1,2})[-.](\d{4})/g,
    confidence: 0.8,
    normalize: (m) => {
      const day = m[1]?.padStart(2, '0');
      const month = m[2]?.padStart(2, '0');
      const year = m[3];
      if (day && month && year) {
        return `${year}-${month}-${day}`;
      }
      return null;
    },
  },

  // Month and year: "May 1869"
  {
    pattern:
      /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/gi,
    confidence: 0.7,
    normalize: (m) => {
      const monthNames: Record<string, string> = {
        january: '01', february: '02', march: '03', april: '04',
        may: '05', june: '06', july: '07', august: '08',
        september: '09', october: '10', november: '11', december: '12',
      };
      const month = monthNames[m[1]?.toLowerCase() ?? ''];
      const year = m[2];
      if (month && year) {
        return `${year}-${month}`;
      }
      return null;
    },
  },

  // Year only in context: "in 1869" or "during 1869" (lower confidence)
  {
    pattern: /(?:in|during|around|circa|c\.)\s+(\d{4})/gi,
    confidence: 0.5,
    normalize: (m) => m[1] ?? null,
  },

  // Standalone 4-digit year (lowest confidence, must be reasonable)
  {
    pattern: /\b(1[0-9]{3}|20[0-2][0-9])\b/g,
    confidence: 0.3,
    normalize: (m) => {
      const year = parseInt(m[1] ?? '0', 10);
      // Only accept years between 1000 and 2030
      if (year >= 1000 && year <= 2030) {
        return m[1] ?? null;
      }
      return null;
    },
  },
];

/**
 * Find all dates in text
 * @param text - Text to search for dates
 * @returns Array of date matches sorted by position
 */
export function findDates(text: string): DateMatch[] {
  const matches: DateMatch[] = [];
  const seenPositions = new Set<number>();

  for (const { pattern, confidence, normalize } of DATE_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const index = match.index;

      // Skip if we already found a date at this position (prefer higher confidence patterns)
      if (seenPositions.has(index)) continue;

      const normalized = normalize(match);
      if (normalized) {
        matches.push({
          raw: match[0],
          normalized,
          confidence,
          index,
        });
        seenPositions.add(index);
      }
    }
  }

  // Sort by position in text
  return matches.sort((a, b) => a.index - b.index);
}

/**
 * Extract sentence containing the date
 * @param text - Full text
 * @param dateIndex - Position of date in text
 * @returns Sentence containing the date
 */
export function extractSentence(text: string, dateIndex: number): string {
  // Find sentence boundaries
  const sentenceEnds = /[.!?]/g;
  let sentenceStart = 0;
  let sentenceEnd = text.length;

  // Find previous sentence end
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  sentenceEnds.lastIndex = 0;
  while ((match = sentenceEnds.exec(text)) !== null) {
    if (match.index < dateIndex) {
      lastEnd = match.index + 1;
    } else {
      sentenceEnd = match.index + 1;
      break;
    }
  }
  sentenceStart = lastEnd;

  // Extract and clean the sentence
  const sentence = text.slice(sentenceStart, sentenceEnd).trim();

  // If sentence is too long, extract surrounding context
  if (sentence.length > 300) {
    const start = Math.max(0, dateIndex - 100);
    const end = Math.min(text.length, dateIndex + 200);
    return text.slice(start, end).trim() + '...';
  }

  return sentence;
}

/**
 * Generate a title from sentence context
 * @param sentence - Sentence containing the event
 * @param date - Date match object
 * @returns Generated title
 */
export function generateTitle(sentence: string, date: DateMatch): string {
  // Remove the date from the sentence for title generation
  const withoutDate = sentence.replace(date.raw, '').trim();

  // Take first few words as title (up to 60 chars)
  const words = withoutDate.split(/\s+/).slice(0, 8);
  let title = words.join(' ');

  // Clean up punctuation at start/end
  title = title.replace(/^[,\-:]+\s*/, '').replace(/[,\-:]+\s*$/, '');

  // Capitalize first letter
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // Truncate if too long
  if (title.length > 60) {
    title = title.slice(0, 57) + '...';
  }

  return title || 'Historical Event';
}
