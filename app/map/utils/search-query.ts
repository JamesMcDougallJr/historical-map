// Parses what people type into the search bar into text + a date range.
//
// Dates are the most common thing typed into a historical search and,
// lexically, the least useful: "1847" only matches text that happens to
// contain the token. So a recognised date is lifted out of the query and
// becomes a range filter, and the rest is what the text matcher sees.
//
// Everything recognised is reported back (`rawDate`, `unsupported`) so the UI
// can show it as a removable chip. Silently reinterpreting input is how a
// search parser generates bug reports.
//
// Pure: no I/O, so e2e/search-query.spec.ts can test it without a server.

import type { YearRange } from "@historical-map/domain";

export const MAX_QUERY_LENGTH = 200;

/** Years outside this window are treated as plain numbers unless a date word vouches for them. */
const PLAUSIBLE_YEAR_MIN = 1000;
const PLAUSIBLE_YEAR_MAX = 2099;

export interface ParsedSearchQuery {
  /** The query with the recognised date removed, whitespace-normalised. */
  text: string;
  dateRange?: YearRange;
  /** The substring the date came from, as typed. */
  rawDate?: string;
  unsupported?: "bce";
}

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const SEASONS = "spring|summer|autumn|fall|winter";
const YEAR = "(\\d{4})";
// A dash between years: hyphen, en dash, em dash.
const DASH = "\\s*[-\u2013\u2014]\\s*";

// Words that make a following number an identifier, not a year — "Highway
// 1847" is a road.
const NON_YEAR_PREFIX =
  /(?:#|\bno\.?|\bnumber|\bhighway|\bhwy\.?|\broute|\brte\.?|\binterstate|\bi-|\bus|\bsr)\s*$/i;

interface Rule {
  re: RegExp;
  /** Returns the range, or null to decline the match (e.g. an implausible year). */
  range: (m: RegExpExecArray) => YearRange | null;
  /** The rule names its own date context, so the plausible-year window doesn't apply. */
  vouched?: boolean;
}

const plausible = (y: number) =>
  y >= PLAUSIBLE_YEAR_MIN && y <= PLAUSIBLE_YEAR_MAX;

// Ordered most-specific first: the first rule that matches anywhere wins.
const RULES: Rule[] = [
  // "18th century", "18th-century", "1st century"
  {
    re: /\b(\d{1,2})(?:st|nd|rd|th)[\s-]+century\b/i,
    range: (m) => {
      const n = Number(m[1]);
      if (n < 1 || n > 21) return null;
      return [(n - 1) * 100, n * 100 - 1];
    },
    vouched: true,
  },
  // "1847-1850", "1847–1850", "1847 to 1850", "from 1847 to 1850", "between 1847 and 1850"
  {
    re: new RegExp(
      `(?:\\b(?:from|between)\\s+)?\\b${YEAR}(?:${DASH}|\\s+(?:to|until|through|and)\\s+)${YEAR}\\b`,
      "i",
    ),
    range: (m) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (!plausible(a) || !plausible(b)) return null;
      return a <= b ? [a, b] : [b, a];
    },
  },
  // "1700s" — a century when it ends in 00
  {
    re: /\b(\d{2})00s\b/i,
    range: (m) => {
      const start = Number(m[1]) * 100;
      return plausible(start) ? [start, start + 99] : null;
    },
  },
  // "1840s"
  {
    re: /\b(\d{3})0s\b/i,
    range: (m) => {
      const start = Number(m[1]) * 10;
      return plausible(start) ? [start, start + 9] : null;
    },
  },
  // "before 1850", "until 1850"
  {
    re: new RegExp(`\\b(?:before|until|pre)[\\s-]+${YEAR}\\b`, "i"),
    range: (m) => [-Infinity, Number(m[1]) - 1],
    vouched: true,
  },
  // "after 1850", "since 1850"
  {
    re: new RegExp(`\\b(?:after|since|post)[\\s-]+${YEAR}\\b`, "i"),
    range: (m) => [Number(m[1]) + 1, Infinity],
    vouched: true,
  },
  // "March 10, 1847", "March 1847", "spring 1847". Sub-year precision is a
  // later refinement; for now these mean "that year".
  {
    re: new RegExp(
      `\\b(?:(?:${MONTHS})\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?,?)?|${SEASONS})(?:\\s+of)?\\s+${YEAR}\\b`,
      "i",
    ),
    range: (m) => {
      const y = Number(m[1]);
      return [y, y];
    },
    vouched: true,
  },
  // "in 1847", "circa 1847", "c. 1847"
  {
    re: new RegExp(
      `(?:\\b(?:in|during|circa|around|year)|\\bc\\.)\\s*${YEAR}\\b`,
      "i",
    ),
    range: (m) => {
      const y = Number(m[1]);
      return [y, y];
    },
    vouched: true,
  },
  // A bare year.
  {
    re: new RegExp(`\\b${YEAR}\\b`),
    range: (m) => {
      const y = Number(m[1]);
      return plausible(y) ? [y, y] : null;
    },
  },
];

const BCE = /\b\d{1,4}\s*(?:B\.?C\.?E?\.?|BCE)(?=\s|$|[,;])/i;

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const query = input.slice(0, MAX_QUERY_LENGTH);

  // `events.date` is a `date` and the corpus has no BCE events, so half
  // supporting it would be worse than saying so.
  const bce = BCE.exec(query);
  if (bce) {
    return {
      text: squash(
        query.slice(0, bce.index) +
          " " +
          query.slice(bce.index + bce[0].length),
      ),
      rawDate: bce[0].trim(),
      unsupported: "bce",
    };
  }

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.replace("g", "") + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      // A number glued to an identifier word isn't a year ("Highway 1900").
      if (!rule.vouched && NON_YEAR_PREFIX.test(query.slice(0, m.index))) {
        continue;
      }
      // Part of a longer number ("1,847", "18470", "1847.5").
      const before = query[m.index - 1];
      const after = query[m.index + m[0].length];
      if (
        (before && /[\d,.]/.test(before)) ||
        (after &&
          /^(?:\d|[.,]\d)/.test(
            after + (query[m.index + m[0].length + 1] ?? ""),
          ))
      ) {
        continue;
      }
      const range = rule.range(m);
      if (!range) continue;
      return {
        text: squash(
          query.slice(0, m.index) + " " + query.slice(m.index + m[0].length),
        ),
        dateRange: range,
        rawDate: m[0].trim(),
      };
    }
  }

  return { text: squash(query) };
}

/**
 * Splits typeahead input into the part websearch syntax handles whole and a
 * prefix term for the last, still-being-typed word.
 *
 * `prefixTerm` is a complete `to_tsquery` operand. It is built only from
 * letters and digits — every tsquery operator (`& | ! : ( ) '` and the rest)
 * is dropped by construction rather than escaped, so no input can smuggle an
 * operator into `to_tsquery`, which, unlike `websearch_to_tsquery`, throws on
 * malformed syntax.
 *
 * No prefix term when the last word is finished (trailing space), excluded
 * (`-word`), or inside an open quote — those belong to websearch syntax.
 */
export function buildPrefixQuery(text: string): {
  head: string;
  prefixTerm: string | null;
} {
  const m = /[\p{L}\p{N}]+$/u.exec(text);
  if (!m) return { head: text, prefixTerm: null };

  const head = text.slice(0, m.index);
  const openQuote = (head.match(/"/g)?.length ?? 0) % 2 === 1;
  const excluded = /(?:^|\s)-$/.test(head);
  if (openQuote || excluded) return { head: text, prefixTerm: null };

  return {
    head: head.trim(),
    prefixTerm: `'${m[0].toLowerCase()}':*`,
  };
}

/**
 * The query's positive words joined with `or` — a websearch query matching
 * anything that contains *any* of them.
 *
 * Search uses it two ways. As an index-friendly candidate filter: an event
 * matches on its own vector *and* its place's, which can't share one GIN
 * index, so candidates are "has any positive word in either", and the full
 * query (phrases, exclusions, all-words) is then checked against the two
 * combined. And for per-field "why did this match" flags and highlighting,
 * where a field counts if it holds any of the words.
 *
 * Phrases lose their quotes (each word counts), `-excluded` words and the
 * `or` keyword are dropped.
 */
export function anyTermsQuery(text: string): string {
  const words: string[] = [];
  for (const part of text.replace(/"/g, " ").split(/\s+/)) {
    if (!part || /^-/.test(part) || /^or$/i.test(part)) continue;
    words.push(...(part.match(/[\p{L}\p{N}]+/gu) ?? []));
  }
  return words.join(" or ");
}

/**
 * Whether `text` uses websearch operators (phrases, exclusions, `or`). The
 * trigram typo fallback compares the raw string against titles, so it must
 * stay off for these — `meadows -massacre` is trigram-similar to "Massacre
 * at the Meadows", which is exactly what the user excluded.
 */
export function hasSearchOperators(text: string): boolean {
  return /"|(?:^|\s)-\S|\bor\b/i.test(text);
}
