import type { CleaningReport } from "./cleaning.types";

/**
 * Rejoins words split across a line break, **keeping the hyphen**.
 *
 * Deliberately conservative. The obvious implementation removes the hyphen —
 * and would turn `Mexico-\nTenochtitlan` into `MexicoTenochtitlan`, destroying a
 * place name the geocoder needs. That compound appears 4+ times in the test
 * corpus, alongside genuine soft breaks like `fifty-\nnine`.
 *
 * Telling the two apart needs a dictionary. Keeping the hyphen is correct for
 * real compounds and leaves a cosmetic extra hyphen in soft breaks
 * (`fifty-nine`), which costs nothing — the model reads it fine. Trading a
 * cosmetic flaw for never corrupting a proper noun is the right way round.
 */
export function rejoinHyphenatedBreaks(
  text: string,
  report: CleaningReport,
): string {
  let count = 0;
  const out = text.replace(/-\n(?=\p{L})/gu, () => {
    count++;
    return "-";
  });
  if (count > 0) {
    report.dehyphenated += count;
    if (!report.rules.includes("dehyphenate")) report.rules.push("dehyphenate");
  }
  return out;
}

/**
 * Repairs a year with a footnote marker fused to it: `18961` → `1896`.
 *
 * Page 85 of the test corpus reads "elected in 1892, again in 18961 and again
 * in 1900" — that is 1896 with footnote marker 1. Left alone the date is either
 * missed or read as year 18961, and an event is lost or badly misdated.
 *
 * Narrowly guarded: the leading four digits must be a plausible year and the
 * run must be exactly five digits. A five-digit number in this range is far
 * more likely to be this artifact than a real quantity in historical prose,
 * and every repair is counted so the assumption stays visible.
 */
export function repairFusedFootnoteYears(
  text: string,
  report: CleaningReport,
): string {
  let count = 0;
  const out = text.replace(
    /\b(1[0-9]{3}|20[0-9]{2})[0-9](?![0-9])/g,
    (_match, year: string) => {
      count++;
      return year;
    },
  );
  if (count > 0) {
    report.repairedYears += count;
    if (!report.rules.includes("footnote-years")) {
      report.rules.push("footnote-years");
    }
  }
  return out;
}

/**
 * Reflows typeset line wraps back into paragraphs.
 *
 * PDF text arrives one physical line at a time, so the model reads ragged prose
 * with no way to tell a line break from a paragraph break. A newline whose next
 * line starts lowercase is a wrap, not a boundary.
 *
 * The "previous line does not end in sentence punctuation" guard keeps this
 * conservative: joining across a real sentence end would be worse than leaving
 * a stray break, and abbreviations make trailing periods ambiguous.
 */
export function reflowParagraphs(text: string, report: CleaningReport): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let count = 0;

  for (const line of lines) {
    const previous = out[out.length - 1];
    const continues =
      previous !== undefined &&
      previous.trim().length > 0 &&
      /^[\p{Ll}]/u.test(line.trim()) &&
      !/[.!?:;”"']$/.test(previous.trim());

    if (continues) {
      out[out.length - 1] = `${previous.replace(/\s+$/, "")} ${line.trim()}`;
      count++;
    } else {
      out.push(line);
    }
  }

  if (count > 0) {
    report.reflowed += count;
    if (!report.rules.includes("reflow")) report.rules.push("reflow");
  }
  return out.join("\n");
}
