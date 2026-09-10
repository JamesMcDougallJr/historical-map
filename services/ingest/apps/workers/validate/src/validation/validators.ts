import type { ExtractedEvent, ValidationCheck } from "@historical-map/domain";

/**
 * The checks the pipeline runs on an extracted event before it can reach the
 * map, and whether each one gates publication.
 *
 * Pure functions over an event plus the document text — no database, no
 * network, no model — so they are cheap to run and trivial to test.
 */

export interface ValidationContext {
  /** Full cleaned document text, for the grounding check. */
  documentText: string;
  confidenceMin: number;
  /** Events already seen in this run, for duplicate detection. */
  seen: Set<string>;
}

/**
 * Does the passage the model quoted actually appear in the document?
 *
 * **The strongest hallucination signal available**, and deliberately
 * non-gating for now: it is recorded on every candidate so a gating policy can
 * be set from evidence about how often the model paraphrases rather than
 * fabricates. Turning `gating` on here is a one-word change once that evidence
 * exists.
 *
 * Whitespace is normalised on both sides because reflowed text and the model's
 * copy of it will differ in line breaks without differing in content.
 */
export function checkGrounding(
  event: ExtractedEvent,
  context: ValidationContext,
): ValidationCheck {
  const quote = normalise(event.sourceText);
  if (quote.length < 20) {
    return {
      name: "grounding",
      passed: false,
      gating: false,
      detail: "quote too short to verify",
    };
  }
  const found = normalise(context.documentText).includes(quote);
  return {
    name: "grounding",
    passed: found,
    gating: false,
    detail: found
      ? undefined
      : `quote not found: "${event.sourceText.slice(0, 60)}…"`,
  };
}

export function checkConfidence(
  event: ExtractedEvent,
  context: ValidationContext,
): ValidationCheck {
  const passed = event.confidence >= context.confidenceMin;
  return {
    name: "confidence",
    passed,
    gating: true,
    detail: passed
      ? undefined
      : `${event.confidence} < ${context.confidenceMin}`,
  };
}

/**
 * `events.date` is `date NOT NULL`, so an event with no derivable day cannot be
 * stored at all. Kept for review rather than dropped.
 */
export function checkDatePresent(event: ExtractedEvent): ValidationCheck {
  const passed = Boolean(event.dateIso);
  return {
    name: "date-present",
    passed,
    gating: true,
    detail: passed ? undefined : `no dateIso (dateText: "${event.dateText}")`,
  };
}

/**
 * Rejects dates outside the range a historical corpus can plausibly describe.
 *
 * Catches the `18961` failure mode — a footnote marker fused to a year — for
 * any case that survives cleaning, and any model arithmetic slip.
 */
export function checkDatePlausible(event: ExtractedEvent): ValidationCheck {
  if (!event.dateIso) {
    return { name: "date-plausible", passed: true, gating: true };
  }
  const year = Number(event.dateIso.slice(0, 4));
  const nextYear = new Date().getFullYear() + 1;
  const passed = Number.isFinite(year) && year >= 1 && year <= nextYear;
  return {
    name: "date-plausible",
    passed,
    gating: true,
    detail: passed ? undefined : `implausible year ${year}`,
  };
}

/**
 * Does the claimed precision match what the text actually says?
 *
 * Non-gating and **corrective**: rather than sending the event to review, it
 * downgrades the precision. An event dated "1847" is still worth mapping — it
 * just must not claim to know the day.
 */
export function checkPrecision(event: ExtractedEvent): {
  check: ValidationCheck;
  corrected?: ExtractedEvent;
} {
  const text = event.dateText;
  const hasDay = /\b\d{1,2}(st|nd|rd|th)?\b/.test(
    text.replace(/\b\d{4}\b/g, ""),
  );
  const hasMonth = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(
    text,
  );

  if (event.datePrecision === "day" && !hasDay) {
    return {
      check: {
        name: "precision",
        passed: false,
        gating: false,
        detail: `claimed "day" but dateText "${text}" has none — downgraded`,
      },
      corrected: { ...event, datePrecision: hasMonth ? "month" : "year" },
    };
  }
  if (event.datePrecision === "month" && !hasMonth) {
    return {
      check: {
        name: "precision",
        passed: false,
        gating: false,
        detail: `claimed "month" but dateText "${text}" has none — downgraded`,
      },
      corrected: { ...event, datePrecision: "year" },
    };
  }
  return { check: { name: "precision", passed: true, gating: false } };
}

/**
 * The place must be a name, not coordinates. The prompt forbids coordinates
 * explicitly; this is the check that the instruction was followed, because a
 * pair of numbers would sail through the geocoder as an unresolvable string.
 */
export function checkPlace(event: ExtractedEvent): ValidationCheck {
  if (!event.placeName || event.placeName.trim().length === 0) {
    return {
      name: "place",
      passed: false,
      gating: true,
      detail: "no place named",
    };
  }
  if (/^-?\d+(\.\d+)?\s*[,;]\s*-?\d+(\.\d+)?$/.test(event.placeName.trim())) {
    return {
      name: "place",
      passed: false,
      gating: true,
      detail: `looks like coordinates: "${event.placeName}"`,
    };
  }
  return { name: "place", passed: true, gating: true };
}

/**
 * Same title and date twice in one run.
 *
 * Gating, but toward review rather than deletion — chunk overlap can legitimately
 * surface the same event twice, and a human should decide which copy to keep.
 */
export function checkDuplicate(
  event: ExtractedEvent,
  context: ValidationContext,
): ValidationCheck {
  const key = `${normalise(event.title)}|${event.dateIso ?? event.dateText}`;
  const duplicate = context.seen.has(key);
  context.seen.add(key);
  return {
    name: "duplicate",
    passed: !duplicate,
    gating: true,
    detail: duplicate
      ? "same title and date already seen in this run"
      : undefined,
  };
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
