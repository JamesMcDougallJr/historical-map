// Pure-function tests for the search query parser, the tsquery builders and
// the shared date-interval rule — no browser or server needed, same as
// popup-placement.spec.ts. Table-driven; the cases are
// plans/20-search-lexical.md's "E2E specs" list.
import { test, expect } from "@playwright/test";
import {
  anyTermsQuery,
  buildPrefixQuery,
  hasSearchOperators,
  MAX_QUERY_LENGTH,
  parseSearchQuery,
} from "../app/map/utils/search-query";
import {
  eventInYearRange,
  eventYearSpan,
  intersectYearRanges,
} from "../packages/domain/src/date-interval";

test.describe("parseSearchQuery — dates", () => {
  const cases: Array<[string, [number, number], string]> = [
    ["1847", [1847, 1847], "1847"],
    ["1840s", [1840, 1849], "1840s"],
    ["18th century", [1700, 1799], "18th century"],
    ["18th-century", [1700, 1799], "18th-century"],
    ["1700s", [1700, 1799], "1700s"],
    ["1847-1850", [1847, 1850], "1847-1850"],
    ["1847 to 1850", [1847, 1850], "1847 to 1850"],
    ["1847–1850", [1847, 1850], "1847–1850"],
    ["between 1847 and 1850", [1847, 1850], "between 1847 and 1850"],
    ["1850-1847", [1847, 1850], "1850-1847"],
    ["March 1847", [1847, 1847], "March 1847"],
    ["spring 1847", [1847, 1847], "spring 1847"],
    ["May 10, 1869", [1869, 1869], "May 10, 1869"],
    ["in 1847", [1847, 1847], "in 1847"],
  ];
  for (const [input, range, raw] of cases) {
    test(`${JSON.stringify(input)} → ${range.join("–")}`, () => {
      const parsed = parseSearchQuery(input);
      expect(parsed.dateRange).toEqual(range);
      expect(parsed.rawDate).toBe(raw);
      expect(parsed.text).toBe("");
    });
  }

  test("before / after are open-ended and exclusive", () => {
    expect(parseSearchQuery("before 1850").dateRange).toEqual([
      -Infinity,
      1849,
    ]);
    expect(parseSearchQuery("after 1850").dateRange).toEqual([1851, Infinity]);
  });

  test("BCE is reported as unsupported, not half-supported", () => {
    for (const input of ["1520 BC", "1520 BCE", "44 B.C."]) {
      const parsed = parseSearchQuery(input);
      expect(parsed.dateRange).toBeUndefined();
      expect(parsed.unsupported).toBe("bce");
    }
  });
});

test.describe("parseSearchQuery — residual text", () => {
  test("words and a date split apart", () => {
    const parsed = parseSearchQuery("mountain meadows 1857");
    expect(parsed.text).toBe("mountain meadows");
    expect(parsed.dateRange).toEqual([1857, 1857]);
  });

  test("a date in the middle leaves clean text", () => {
    expect(parseSearchQuery("gold  1840s  rush").text).toBe("gold rush");
  });

  test("a date-only query has empty text (the browse path)", () => {
    expect(parseSearchQuery("1840s").text).toBe("");
  });

  test("the query is clamped", () => {
    const parsed = parseSearchQuery("a".repeat(1000));
    expect(parsed.text.length).toBe(MAX_QUERY_LENGTH);
  });
});

test.describe("parseSearchQuery — non-dates stay text", () => {
  const cases = [
    "Highway 89",
    "Fort 1",
    "Highway 1900",
    "Route 1850",
    "no. 1847",
    "#1847",
    "1,847 emigrants",
    "18470",
    "1847.5",
    "0999",
    "Interstate 2100",
  ];
  for (const input of cases) {
    test(JSON.stringify(input), () => {
      const parsed = parseSearchQuery(input);
      expect(parsed.dateRange).toBeUndefined();
      expect(parsed.text).toBe(input);
    });
  }

  test("a year is still found after a non-year number", () => {
    const parsed = parseSearchQuery("Highway 89 1923");
    expect(parsed.dateRange).toEqual([1923, 1923]);
    expect(parsed.text).toBe("Highway 89");
  });
});

test.describe("buildPrefixQuery", () => {
  test("the last word becomes a prefix term", () => {
    expect(buildPrefixQuery("brigham you")).toEqual({
      head: "brigham",
      prefixTerm: "'you':*",
    });
    expect(buildPrefixQuery("Tenoch")).toEqual({
      head: "",
      prefixTerm: "'tenoch':*",
    });
  });

  test("accented letters survive, lower-cased", () => {
    expect(buildPrefixQuery("Tenochtitlá").prefixTerm).toBe("'tenochtitlá':*");
  });

  test("tsquery operators can never reach the prefix term", () => {
    // Each of these ends in a word glued to operator characters; only the
    // trailing letters/digits may survive.
    const hostile: Array<[string, string | null]> = [
      ["a&b", "'b':*"],
      ["a|b", "'b':*"],
      ["!b", "'b':*"],
      ["b:*", null],
      ["(b", "'b':*"],
      ["b)", null],
      ["it's", "'s':*"],
      ["x':* | 'y", "'y':*"],
      ["' & | ! :* (", null],
    ];
    for (const [input, expected] of hostile) {
      const { prefixTerm } = buildPrefixQuery(input);
      expect(prefixTerm, input).toBe(expected);
      if (prefixTerm) expect(prefixTerm).toMatch(/^'[\p{L}\p{N}]+':\*$/u);
    }
  });

  test("no prefix when the word is finished, excluded, or inside an open quote", () => {
    expect(buildPrefixQuery("brigham ").prefixTerm).toBeNull();
    expect(buildPrefixQuery("meadows -massac").prefixTerm).toBeNull();
    expect(buildPrefixQuery('"mountain mead').prefixTerm).toBeNull();
    // A closed phrase is fine.
    expect(buildPrefixQuery('"mountain meadows" mass').prefixTerm).toBe(
      "'mass':*",
    );
  });
});

test.describe("anyTermsQuery / hasSearchOperators", () => {
  test("positive words only, joined with or", () => {
    expect(anyTermsQuery("siege meadows")).toBe("siege or meadows");
    expect(anyTermsQuery('"at the meadows" -massacre')).toBe(
      "at or the or meadows",
    );
    expect(anyTermsQuery("gold or silver")).toBe("gold or silver");
    expect(anyTermsQuery("' & | ! :* (")).toBe("");
  });

  test("operators are detected", () => {
    expect(hasSearchOperators('"mountain meadows"')).toBe(true);
    expect(hasSearchOperators("meadows -massacre")).toBe(true);
    expect(hasSearchOperators("gold or silver")).toBe(true);
    expect(hasSearchOperators("Tenochitlan")).toBe(false);
    expect(hasSearchOperators("salt-lake")).toBe(false);
  });
});

test.describe("date intervals (packages/domain)", () => {
  test("year precision covers the whole year", () => {
    expect(eventInYearRange("1848-01-01", "year", [1848, 1848])).toBe(true);
  });

  test("circa overlaps only within the tolerance", () => {
    expect(eventYearSpan("1848-01-01", "circa")).toEqual([1843, 1853]);
    expect(eventInYearRange("1848-01-01", "circa", [1850, 1860])).toBe(true);
    expect(eventInYearRange("1848-01-01", "circa", [1855, 1860])).toBe(false);
  });

  test("decade covers its decade", () => {
    expect(eventYearSpan("1843-01-01", "decade")).toEqual([1840, 1849]);
  });

  test("day precision is that day's year only", () => {
    expect(eventInYearRange("1857-09-11", "day", [1858, 1860])).toBe(false);
    expect(eventInYearRange("1857-09-11", undefined, [1857, 1857])).toBe(true);
  });

  test("open ranges", () => {
    expect(eventInYearRange("1700-01-01", "year", [-Infinity, 1849])).toBe(
      true,
    );
    expect(eventInYearRange("1900-01-01", "year", [1851, Infinity])).toBe(true);
  });

  test("intersection", () => {
    expect(intersectYearRanges([1840, 1849], [1845, 1900])).toEqual([
      1845, 1849,
    ]);
    expect(intersectYearRanges([1840, 1849], [1500, 1600])).toBeNull();
  });
});
