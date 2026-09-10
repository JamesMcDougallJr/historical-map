/**
 * Text cleaning applied between raw extraction and the model.
 *
 * Every rule here exists because of a defect measured in a real document
 * (`corpus/short_history_of_mexico.pdf`), not because it seemed generally
 * sensible. Each records what it did into `CleaningReport`, which is stored
 * alongside the text so a bad transformation is auditable rather than mysterious.
 *
 * Cleaning is not cosmetic — it is the cost model. That book is ~95k tokens,
 * roughly 65% of a free-tier day, so every rule that removes furniture buys back
 * budget, and one rule (running-header removal) is what makes the date
 * pre-filter work at all.
 */

export interface CleaningReport {
  /** Rule names that actually changed something. */
  rules: string[];
  /** The repeated header text that was stripped, if one was found. */
  runningHeader?: string;
  /** The repeated footer text that was stripped, if one was found. */
  runningFooter?: string;
  /** Segments dropped as table-of-contents or boilerplate. */
  droppedSegments: number;
  /** Reasons those segments were dropped, by anchor. */
  dropped: Array<{ anchor: string; reason: string }>;
  /** Hyphenated line breaks rejoined. */
  dehyphenated: number;
  /** Soft line wraps reflowed into their paragraph. */
  reflowed: number;
  /** `18961` → `1896` style repairs. */
  repairedYears: number;
  charsBefore: number;
  charsAfter: number;
}

export function emptyReport(charsBefore: number): CleaningReport {
  return {
    rules: [],
    droppedSegments: 0,
    dropped: [],
    dehyphenated: 0,
    reflowed: 0,
    repairedYears: 0,
    charsBefore,
    charsAfter: 0,
  };
}

export interface CleaningOptions {
  /**
   * Fraction of segments that must share a first/last line for it to count as
   * page furniture rather than content.
   */
  furnitureThreshold?: number;
  /** Disable individual rules, mainly for isolating one in a test. */
  disable?: string[];
}
