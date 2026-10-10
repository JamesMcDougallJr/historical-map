// In-memory search for the static backend (data/map-data.json — local dev
// without Postgres, and the stdio MCP server). Pure: it's a function over
// HistoricalEventsData, so e2e/search-static.spec.ts runs it with no server.
//
// Deliberately modest: tokenise, fold case and accents, weight title > place >
// date text > description > quote, and require every query word to appear
// somewhere. No stemming. It is good enough for a hand-curated file of a few
// dozen events, and it keeps search working where Postgres isn't. Document and
// passage kinds don't exist here — the response says so via `modes.documents`.

import {
  eventInYearRange,
  eventYearSpan,
  yearRangesOverlap,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type Bbox,
  type EventHit,
  type HistoricalEventsData,
  type HistoricalLocation,
  type LocationHit,
  type MatchField,
  type SequenceHit,
  type YearRange,
} from "@historical-map/domain";

export interface StaticSearchInput {
  /** Text with any parsed date removed. Empty means a date-only browse. */
  text: string;
  /** Match the last word as a prefix (typeahead). */
  prefix: boolean;
  years?: YearRange;
  bbox?: Bbox;
  sourceIds?: string[];
  limit: number;
}

const FIELD_WEIGHTS = {
  title: 3,
  place: 2,
  date: 1.5,
  body: 1,
  quote: 0.5,
} as const;

export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function tokens(s: string): string[] {
  return foldText(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

interface Query {
  required: string[];
  excluded: string[];
  /** Index into `required` of the word to match as a prefix, if any. */
  prefixIndex: number | null;
}

function parse(text: string, prefix: boolean): Query {
  const required: string[] = [];
  const excluded: string[] = [];
  for (const part of text.split(/\s+/).filter(Boolean)) {
    const words = tokens(part);
    if (part.startsWith("-") && part.length > 1) excluded.push(...words);
    else required.push(...words);
  }
  const endsInWord = /[\p{L}\p{N}]$/u.test(text);
  return {
    required,
    excluded,
    prefixIndex:
      prefix && endsInWord && required.length ? required.length - 1 : null,
  };
}

function wordMatches(
  field: string[],
  word: string,
  asPrefix: boolean,
): boolean {
  return asPrefix
    ? field.some((t) => t.startsWith(word))
    : field.includes(word);
}

/** Scores fields against the query. Null when a required word is missing or an excluded one present. */
function scoreFields(
  fields: Partial<Record<MatchField, string>>,
  q: Query,
): { score: number; matchedOn: MatchField[] } | null {
  const tokenised = Object.entries(fields).map(
    ([name, value]) => [name as MatchField, tokens(value ?? "")] as const,
  );
  for (const word of q.excluded) {
    if (tokenised.some(([, t]) => t.includes(word))) return null;
  }
  let score = 0;
  const matched = new Set<MatchField>();
  for (let i = 0; i < q.required.length; i++) {
    const word = q.required[i]!;
    const asPrefix = i === q.prefixIndex;
    let found = false;
    for (const [name, t] of tokenised) {
      if (wordMatches(t, word, asPrefix)) {
        found = true;
        matched.add(name);
        score +=
          (FIELD_WEIGHTS as Record<string, number>)[name] ?? FIELD_WEIGHTS.body;
      }
    }
    if (!found) return null;
  }
  return { score, matchedOn: Array.from(matched) };
}

/** A short excerpt around the first matched word, with sentinel marks. Never HTML. */
function staticSnippet(text: string, q: Query, max = 200): string {
  const clean = text.replace(/[\u0002\u0003]/g, "");
  const words = q.required;
  if (words.length === 0) return truncate(clean, max);

  const re = /[\p{L}\p{N}]+/gu;
  const marks: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const folded = foldText(m[0]);
    if (
      words.some((w, i) =>
        i === q.prefixIndex ? folded.startsWith(w) : folded === w,
      )
    ) {
      marks.push([m.index, m.index + m[0].length]);
    }
  }
  if (marks.length === 0) return truncate(clean, max);

  const first = marks[0]![0];
  const start = Math.max(0, first - 60);
  const end = Math.min(clean.length, start + max);
  let out = "";
  let pos = start;
  for (const [a, b] of marks) {
    if (a < start || b > end) continue;
    out +=
      clean.slice(pos, a) +
      SNIPPET_MARK_START +
      clean.slice(a, b) +
      SNIPPET_MARK_END;
    pos = b;
  }
  out += clean.slice(pos, end);
  return (start > 0 ? "…" : "") + out + (end < clean.length ? "…" : "");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function inBbox(loc: HistoricalLocation, bbox: Bbox | undefined): boolean {
  if (!bbox) return true;
  const [lon, lat] = loc.coordinates;
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

export interface StaticSearchResult {
  events: EventHit[];
  sequences: SequenceHit[];
  locations: LocationHit[];
}

export function searchStatic(
  data: HistoricalEventsData,
  input: StaticSearchInput,
): StaticSearchResult {
  const q = parse(input.text, input.prefix);
  const browse = q.required.length === 0 && q.excluded.length === 0;
  const sourceFilter = input.sourceIds?.length
    ? new Set(input.sourceIds)
    : null;

  const eventPasses = (
    loc: HistoricalLocation,
    e: HistoricalLocation["events"][number],
  ) =>
    inBbox(loc, input.bbox) &&
    (!sourceFilter || sourceFilter.has(e.sourceId ?? "")) &&
    (!input.years || eventInYearRange(e.date, e.datePrecision, input.years));

  // ── Events
  const events: EventHit[] = [];
  for (const loc of data.locations) {
    for (const e of loc.events) {
      if (!eventPasses(loc, e)) continue;
      let score = 0;
      let matchedOn: MatchField[] = ["date"];
      if (!browse) {
        const s = scoreFields(
          {
            title: e.title,
            place: loc.name,
            date: e.dateText ?? "",
            body: e.description,
            quote: e.source ?? "",
          },
          q,
        );
        if (!s) continue;
        score = s.score;
        matchedOn = s.matchedOn;
      }
      const snippetSource =
        !matchedOn.includes("body") && matchedOn.includes("quote")
          ? (e.source ?? "")
          : e.description;
      const hit: EventHit = {
        kind: "event",
        id: e.id,
        title: e.title,
        snippet: staticSnippet(snippetSource, q),
        score,
        matchedOn,
        date: e.date,
        locationId: loc.id,
        locationName: loc.name,
        coordinates: loc.coordinates,
        sourceId: e.sourceId ?? null,
      };
      if (e.datePrecision) hit.datePrecision = e.datePrecision;
      if (e.dateText) hit.dateText = e.dateText;
      events.push(hit);
    }
  }
  events.sort((a, b) =>
    browse
      ? a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
      : b.score - a.score ||
        a.date.localeCompare(b.date) ||
        a.id.localeCompare(b.id),
  );

  if (browse) {
    return {
      events: events.slice(0, input.limit),
      sequences: [],
      locations: [],
    };
  }

  // ── Sequences
  const eventById = new Map<
    string,
    { loc: HistoricalLocation; e: HistoricalLocation["events"][number] }
  >();
  for (const loc of data.locations) {
    for (const e of loc.events) eventById.set(e.id, { loc, e });
  }

  const sequences: SequenceHit[] = [];
  for (const g of data.groups ?? []) {
    const members = g.memberEventIds
      .map((id) => eventById.get(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));

    const own = scoreFields({ title: g.title, body: g.description ?? "" }, q);
    const memberMatches = members.filter((m) =>
      scoreFields({ title: m.e.title }, q),
    );
    if (!own && memberMatches.length === 0) continue;

    const spans = members.map((m) =>
      eventYearSpan(m.e.date, m.e.datePrecision),
    );
    const derived: YearRange | null = spans.length
      ? [
          Math.min(...spans.map((s) => s[0])),
          Math.max(...spans.map((s) => s[1])),
        ]
      : null;
    if (input.years && (!derived || !yearRangesOverlap(derived, input.years))) {
      continue;
    }

    const matchedOn: MatchField[] = [...(own?.matchedOn ?? [])];
    if (memberMatches.length) matchedOn.push("member");
    const dates = members.map((m) => m.e.date).sort();
    const lons = members.map((m) => m.loc.coordinates[0]);
    const lats = members.map((m) => m.loc.coordinates[1]);
    sequences.push({
      kind: "sequence",
      id: g.id,
      title: g.title,
      snippet: staticSnippet(
        own
          ? (g.description ?? "")
          : memberMatches.map((m) => m.e.title).join(" · "),
        q,
      ),
      score: (own?.score ?? 0) + 0.5 * memberMatches.length,
      matchedOn,
      memberCount: members.length,
      membersInRange: input.years
        ? members.filter((m) =>
            eventInYearRange(m.e.date, m.e.datePrecision, input.years!),
          ).length
        : members.length,
      dateRange: dates.length ? [dates[0]!, dates[dates.length - 1]!] : null,
      bbox: members.length
        ? [
            Math.min(...lons),
            Math.min(...lats),
            Math.max(...lons),
            Math.max(...lats),
          ]
        : null,
    });
  }
  sequences.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  // ── Locations
  const filtered =
    input.years !== undefined ||
    sourceFilter !== null ||
    input.bbox !== undefined;
  const locations: LocationHit[] = [];
  for (const loc of data.locations) {
    const s = scoreFields({ place: loc.name }, q);
    if (!s || !inBbox(loc, input.bbox)) continue;
    const inRange = loc.events.filter((e) => eventPasses(loc, e));
    if (filtered && inRange.length === 0) continue;
    const dates = inRange.map((e) => e.date).sort();
    locations.push({
      kind: "location",
      id: loc.id,
      title: loc.name,
      snippet: staticSnippet(loc.name, q),
      score: s.score,
      matchedOn: ["place"],
      coordinates: loc.coordinates,
      eventCount: inRange.length,
      dateRange: dates.length ? [dates[0]!, dates[dates.length - 1]!] : null,
    });
  }
  locations.sort(
    (a, b) =>
      b.score - a.score ||
      b.eventCount - a.eventCount ||
      a.title.localeCompare(b.title),
  );

  return {
    events: events.slice(0, input.limit),
    sequences: sequences.slice(0, input.limit),
    locations: locations.slice(0, input.limit),
  };
}

/** Location ids of every matching event, for live map highlighting. */
export function staticMatchingLocationIds(
  data: HistoricalEventsData,
  input: Omit<StaticSearchInput, "limit">,
  cap: number,
): { locationIds: string[]; truncated: boolean } {
  const { events } = searchStatic(data, {
    ...input,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const ids = Array.from(new Set(events.map((e) => e.locationId)));
  return { locationIds: ids.slice(0, cap), truncated: ids.length > cap };
}
