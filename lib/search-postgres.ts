// Postgres arm of search: one ranked query per result kind
// (plans/20-search-lexical.md). lib/search.ts owns parsing, date logic and
// assembling the response; this file only turns a prepared request into rows.
//
// Matching, per kind:
//   - `search_tsv` (hm_english, stemmed, weighted) via websearch_to_tsquery —
//     accepts "phrases", `or` and `-exclusions`, and never throws on input.
//   - `name_tsv`/`locations.search_tsv` (hm_simple, unstemmed) so exact names
//     stay strong where stemming would mangle them.
//   - pg_trgm word similarity on titles and place names only, as a typo
//     fallback ("Tenochitlan"). Off whenever the query uses websearch
//     operators; see hasSearchOperators().
//
// Snippets come from ts_headline, run only on the final top-N rows — it is the
// expensive part — and wrapped in SNIPPET_MARK_* sentinels, never HTML.

import type postgres from "postgres";
import type {
  Bbox,
  DatePrecision,
  DocumentHit,
  EventHit,
  LocationHit,
  MatchField,
  PassageHit,
  SequenceHit,
  YearRange,
} from "@/app/map/types";
import { ensureSchema, sqlClient } from "./postgres-storage";

export interface PgSearchInput {
  /** Text with any parsed date removed. Never empty here — browse has its own path. */
  text: string;
  /** anyTermsQuery(text): the positive words joined with `or`. */
  anyText: string;
  /** Typeahead: `head` goes through websearch syntax, `prefixTerm` matches the last word as a prefix. */
  prefix: { head: string; prefixTerm: string; lastWord: string } | null;
  trigram: boolean;
  /** Effective year filter (parsed date ∩ timeline). */
  years?: YearRange;
  bbox?: Bbox;
  sourceIds?: string[];
  limit: number;
}

type Sql = ReturnType<typeof postgres>;
type Fragment = ReturnType<Sql>;

// ts_headline options. The sentinels are control characters, which source
// text has no business containing, and any that it does are stripped before
// highlighting (see `clean`) so a document can't forge a highlight.
const HEADLINE_OPTS =
  'StartSel=\u0002, StopSel=\u0003, MaxWords=32, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "';

/** Score added for an unstemmed (exact-form) title match, on top of ts_rank_cd. */
const TITLE_NAME_BONUS = 0.5;
/** Score added when the event's place name matches. */
const PLACE_BONUS = 0.3;
/** Multiplier on trigram word similarity, so a typo match ranks below real word matches. */
const TRIGRAM_WEIGHT = 0.5;

/**
 * The four tsqueries every kind is matched with:
 *   - `qe`/`qs`: the full query (all words, phrases, exclusions), stemmed and
 *     unstemmed.
 *   - `qeAny`/`qsAny`: any positive word (anyTermsQuery). Index-friendly
 *     candidate filters, and the basis for per-field match flags.
 */
function queries(sql: Sql, input: PgSearchInput) {
  if (!input.prefix) {
    return {
      qe: sql`websearch_to_tsquery('hm_english', ${input.text})`,
      qs: sql`websearch_to_tsquery('hm_simple', ${input.text})`,
      qeAny: sql`websearch_to_tsquery('hm_english', ${input.anyText})`,
      qsAny: sql`websearch_to_tsquery('hm_simple', ${input.anyText})`,
    };
  }
  const { head, prefixTerm, lastWord } = input.prefix;
  // The last word matches either as a finished word (stemmed — so a fully
  // typed "massacre" still finds the stored lexeme "massacr") or as a prefix.
  // An empty `head` yields an empty tsquery, which `&&` treats as identity.
  return {
    qe: sql`(websearch_to_tsquery('hm_english', ${head})
             && (websearch_to_tsquery('hm_english', ${lastWord})
                 || to_tsquery('hm_simple', ${prefixTerm})))`,
    qs: sql`(websearch_to_tsquery('hm_simple', ${head})
             && to_tsquery('hm_simple', ${prefixTerm}))`,
    qeAny: sql`(websearch_to_tsquery('hm_english', ${input.anyText})
                || to_tsquery('hm_simple', ${prefixTerm}))`,
    qsAny: sql`(websearch_to_tsquery('hm_simple', ${input.anyText})
                || to_tsquery('hm_simple', ${prefixTerm}))`,
  };
}

/**
 * Whether event `e` at location `l` matches — the one definition shared by
 * the ranked list and the highlight ids, so they can't disagree.
 *
 * An event is matched together with its place name: "siege meadows" should
 * find the siege *at* Mountain Meadows, and `meadows -massacre` must exclude
 * the massacre even though its place says "Meadows". So the full query runs
 * against the event's vector and the place's combined. That combination
 * can't be indexed, so the first clause narrows to candidates holding any
 * positive word in either, through the GIN indexes.
 */
function eventMatch(sql: Sql, input: PgSearchInput): Fragment {
  const raw = input.text.toLowerCase();
  const trigram = input.trigram
    ? sql`OR immutable_unaccent(${raw}) <% immutable_unaccent(e.title)`
    : sql``;
  return sql`
    (e.search_tsv @@ q.qe_any OR e.name_tsv @@ q.qs_any OR l.search_tsv @@ q.qs_any ${trigram})
    AND ((e.search_tsv || to_tsvector('hm_english', l.name)) @@ q.qe
         OR (e.name_tsv || l.search_tsv) @@ q.qs
         ${trigram})`;
}

function withQueries(sql: Sql, input: PgSearchInput): Fragment {
  const { qe, qs, qeAny, qsAny } = queries(sql, input);
  return sql`q AS (SELECT ${qe} AS qe, ${qs} AS qs, ${qeAny} AS qe_any, ${qsAny} AS qs_any)`;
}

/** Precision-aware year overlap on alias `e`, plus a sargable pre-filter on events_date_idx. */
function yearFilter(sql: Sql, years: YearRange | undefined): Fragment {
  if (!years) return sql``;
  const lo = Number.isFinite(years[0]) ? years[0] : null;
  const hi = Number.isFinite(years[1]) ? years[1] : null;
  // No precision widens a date by more than a decade (decade, circa ±5), so
  // the raw date column can be bounded ±10 years for the index.
  return sql`
    AND (${lo}::int IS NULL OR (
          e.date >= make_date(GREATEST(${lo}::int - 10, 1), 1, 1)
          AND event_hi_year(e.date, e.date_precision) >= ${lo}::int))
    AND (${hi}::int IS NULL OR (
          e.date <= make_date(GREATEST(${hi}::int + 10, 1), 12, 31)
          AND event_lo_year(e.date, e.date_precision) <= ${hi}::int))`;
}

/** The "limit to view" chip: viewport and visible layers, on aliases `e`/`l`. */
function viewFilter(sql: Sql, input: PgSearchInput): Fragment {
  const sourceIds = input.sourceIds?.length ? input.sourceIds : null;
  const bbox = input.bbox ?? null;
  return sql`
    AND (${sourceIds}::text[] IS NULL OR e.source_id = ANY(${sourceIds}))
    AND (${bbox}::double precision[] IS NULL
         OR ST_Intersects(l.geom,
              ST_MakeEnvelope(${bbox?.[0] ?? 0}, ${bbox?.[1] ?? 0},
                              ${bbox?.[2] ?? 0}, ${bbox?.[3] ?? 0}, 4326)))`;
}

const clean = (sql: Sql, expr: Fragment) =>
  sql`translate(coalesce(${expr}, ''), chr(2) || chr(3), '')`;

function isoDate(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

// ── Events ──────────────────────────────────────────────────────────────────

interface EventSearchRow {
  id: string;
  title: string;
  date: Date;
  date_precision: DatePrecision | null;
  date_text: string | null;
  location_id: string;
  loc_name: string;
  lon: number;
  lat: number;
  source_id: string | null;
  score: number;
  sim: number;
  m_title: boolean;
  m_date: boolean;
  m_body: boolean;
  m_quote: boolean;
  m_place: boolean;
  snippet: string;
}

export async function searchEventHits(
  input: PgSearchInput,
): Promise<EventHit[]> {
  await ensureSchema();
  const sql = sqlClient();
  const raw = input.text.toLowerCase();

  const sim = input.trigram
    ? sql`word_similarity(immutable_unaccent(${raw}), immutable_unaccent(e.title))`
    : sql`0::real`;

  const rows = await sql<EventSearchRow[]>`
    WITH ${withQueries(sql, input)},
    ranked AS (
      SELECT e.id, e.title, e.date, e.date_precision, e.date_text, e.description,
             e.source, e.search_tsv, e.name_tsv, e.location_id, e.source_id,
             l.name AS loc_name, l.lon, l.lat,
             (l.search_tsv @@ q.qs_any) AS m_place,
             ${sim} AS sim,
             ts_rank_cd(e.search_tsv, q.qe_any)
               + CASE WHEN e.name_tsv @@ q.qs THEN ${TITLE_NAME_BONUS}::real ELSE 0 END
               + CASE WHEN l.search_tsv @@ q.qs_any THEN ${PLACE_BONUS}::real ELSE 0 END
               + ${TRIGRAM_WEIGHT}::real * ${sim} AS score
      FROM events e
      JOIN locations l ON l.id = e.location_id, q
      WHERE ${eventMatch(sql, input)}
        ${yearFilter(sql, input.years)}
        ${viewFilter(sql, input)}
      ORDER BY score DESC, e.date ASC, e.id ASC
      LIMIT ${input.limit}
    ),
    flagged AS (
      SELECT r.*,
             (ts_filter(r.search_tsv, '{a}') @@ q.qe_any OR r.name_tsv @@ q.qs_any
              OR r.sim >= current_setting('pg_trgm.word_similarity_threshold')::real) AS m_title,
             (ts_filter(r.search_tsv, '{b}') @@ q.qe_any) AS m_date,
             (ts_filter(r.search_tsv, '{c}') @@ q.qe_any) AS m_body,
             (ts_filter(r.search_tsv, '{d}') @@ q.qe_any) AS m_quote
      FROM ranked r, q
    )
    SELECT f.id, f.title, f.date, f.date_precision, f.date_text, f.location_id,
           f.loc_name, f.lon, f.lat, f.source_id, f.score, f.sim,
           f.m_title, f.m_date, f.m_body, f.m_quote, f.m_place,
           -- Show the field that explains the match: the description when it
           -- matched, else the source quote, else the description anyway.
           ts_headline('hm_english',
             ${clean(sql, sql`CASE WHEN NOT f.m_body AND f.m_quote THEN f.source ELSE f.description END`)},
             q.qe_any, ${HEADLINE_OPTS}) AS snippet
    FROM flagged f, q
    ORDER BY f.score DESC, f.date ASC, f.id ASC`;

  return rows.map((r) => {
    const matchedOn: MatchField[] = [];
    if (r.m_title) matchedOn.push("title");
    if (r.m_place) matchedOn.push("place");
    if (r.m_date) matchedOn.push("date");
    if (r.m_body) matchedOn.push("body");
    if (r.m_quote) matchedOn.push("quote");
    return toEventHit(r, r.snippet, Number(r.score), matchedOn);
  });
}

function toEventHit(
  r: Pick<
    EventSearchRow,
    | "id"
    | "title"
    | "date"
    | "date_precision"
    | "date_text"
    | "location_id"
    | "loc_name"
    | "lon"
    | "lat"
    | "source_id"
  >,
  snippet: string,
  score: number,
  matchedOn: MatchField[],
): EventHit {
  const hit: EventHit = {
    kind: "event",
    id: r.id,
    title: r.title,
    snippet,
    score,
    matchedOn,
    date: isoDate(r.date),
    locationId: r.location_id,
    locationName: r.loc_name,
    coordinates: [r.lon, r.lat],
    sourceId: r.source_id,
  };
  if (r.date_precision) hit.datePrecision = r.date_precision;
  if (r.date_text) hit.dateText = r.date_text;
  return hit;
}

/**
 * A date-only query ("1840s") is a browse, not a search: that period's events
 * in date order, with nothing to rank and nothing to highlight.
 */
export async function browseEventHits(
  input: Omit<PgSearchInput, "text" | "anyText" | "prefix" | "trigram">,
): Promise<EventHit[]> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql<(EventSearchRow & { description: string })[]>`
    SELECT e.id, e.title, e.date, e.date_precision, e.date_text, e.description,
           e.location_id, e.source_id, l.name AS loc_name, l.lon, l.lat
    FROM events e
    JOIN locations l ON l.id = e.location_id
    WHERE true
      ${yearFilter(sql, input.years)}
      ${viewFilter(sql, { ...input, text: "", anyText: "", prefix: null, trigram: false })}
    ORDER BY e.date ASC, e.id ASC
    LIMIT ${input.limit}`;
  return rows.map((r) =>
    toEventHit(r, truncate(stripMarks(r.description), 200), 0, ["date"]),
  );
}

function stripMarks(s: string): string {
  return s.replace(/[\u0002\u0003]/g, "");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const space = cut.lastIndexOf(" ");
  return (space > n * 0.6 ? cut.slice(0, space) : cut) + "…";
}

// ── Sequences ───────────────────────────────────────────────────────────────

interface SequenceSearchRow {
  id: string;
  title: string;
  score: number;
  m_title: boolean;
  m_body: boolean;
  m_member: boolean;
  member_count: number | null;
  in_range: number | null;
  d0: Date | null;
  d1: Date | null;
  min_lon: number | null;
  min_lat: number | null;
  max_lon: number | null;
  max_lat: number | null;
  snippet: string;
}

/**
 * Sequences match on their own title/description and, at query time, on their
 * members' titles — "Siege" should surface the sequence the siege belongs to.
 * Member titles aren't stored on the group, for the same staleness reason the
 * place name isn't stored on events.
 *
 * Date filter: the sequence's derived range (earliest member's span start to
 * latest member's span end) must overlap. `membersInRange` says how many
 * members actually fall inside.
 */
export async function searchSequenceHits(
  input: PgSearchInput,
): Promise<SequenceHit[]> {
  await ensureSchema();
  const sql = sqlClient();
  const raw = input.text.toLowerCase();
  const lo =
    input.years && Number.isFinite(input.years[0]) ? input.years[0] : null;
  const hi =
    input.years && Number.isFinite(input.years[1]) ? input.years[1] : null;
  const filtered = input.years !== undefined;

  const sim = input.trigram
    ? sql`word_similarity(immutable_unaccent(${raw}), immutable_unaccent(g.title))`
    : sql`0::real`;
  const trigramMatch = input.trigram
    ? sql`OR immutable_unaccent(${raw}) <% immutable_unaccent(g.title)`
    : sql``;

  const rows = await sql<SequenceSearchRow[]>`
    WITH ${withQueries(sql, input)},
    mem AS (
      SELECT m.group_id, e.title, e.date, l.lon, l.lat,
             event_lo_year(e.date, e.date_precision) AS lo,
             event_hi_year(e.date, e.date_precision) AS hi,
             (ts_filter(e.search_tsv, '{a}') @@ q.qe OR e.name_tsv @@ q.qs) AS title_hit,
             ts_rank_cd(ts_filter(e.search_tsv, '{a}'), q.qe_any) AS r
      FROM event_group_members m
      JOIN events e ON e.id = m.event_id
      JOIN locations l ON l.id = e.location_id, q
    ),
    agg AS (
      SELECT group_id,
             count(*)::int AS member_count,
             count(*) FILTER (WHERE (${lo}::int IS NULL OR hi >= ${lo}::int)
                                AND (${hi}::int IS NULL OR lo <= ${hi}::int))::int AS in_range,
             min(lo) AS lo, max(hi) AS hi, min(date) AS d0, max(date) AS d1,
             min(lon) AS min_lon, min(lat) AS min_lat, max(lon) AS max_lon, max(lat) AS max_lat,
             bool_or(title_hit) AS m_member,
             coalesce(max(r) FILTER (WHERE title_hit), 0) AS member_r,
             string_agg(title, ' · ') FILTER (WHERE title_hit) AS member_titles
      FROM mem GROUP BY group_id
    ),
    ranked AS (
      SELECT g.id, g.title, g.description, g.search_tsv, g.name_tsv,
             a.member_count, a.in_range, a.d0, a.d1,
             a.min_lon, a.min_lat, a.max_lon, a.max_lat,
             coalesce(a.m_member, false) AS m_member, a.member_titles,
             ${sim} AS sim,
             ts_rank_cd(g.search_tsv, q.qe_any)
               + CASE WHEN g.name_tsv @@ q.qs THEN ${TITLE_NAME_BONUS}::real ELSE 0 END
               -- A member-title match counts, but for less than the group's own title.
               + 0.5 * coalesce(a.member_r, 0)
               + ${TRIGRAM_WEIGHT}::real * ${sim} AS score
      FROM event_groups g
      LEFT JOIN agg a ON a.group_id = g.id, q
      WHERE (g.search_tsv @@ q.qe OR g.name_tsv @@ q.qs OR coalesce(a.m_member, false)
             ${trigramMatch})
        AND (NOT ${filtered}::boolean OR (
              a.member_count > 0
              AND (${lo}::int IS NULL OR a.hi >= ${lo}::int)
              AND (${hi}::int IS NULL OR a.lo <= ${hi}::int)))
      ORDER BY score DESC, g.title ASC
      LIMIT ${input.limit}
    ),
    flagged AS (
      SELECT r.*,
             (ts_filter(r.search_tsv, '{a}') @@ q.qe_any OR r.name_tsv @@ q.qs_any
              OR r.sim >= current_setting('pg_trgm.word_similarity_threshold')::real) AS m_title,
             (ts_filter(r.search_tsv, '{c}') @@ q.qe_any) AS m_body
      FROM ranked r, q
    )
    SELECT f.id, f.title, f.score, f.m_title, f.m_body, f.m_member,
           f.member_count, f.in_range, f.d0, f.d1,
           f.min_lon, f.min_lat, f.max_lon, f.max_lat,
           ts_headline('hm_english',
             ${clean(
               sql,
               sql`CASE WHEN f.m_member AND NOT f.m_body AND NOT f.m_title
                                   THEN f.member_titles ELSE f.description END`,
             )},
             q.qe_any, ${HEADLINE_OPTS}) AS snippet
    FROM flagged f, q
    ORDER BY f.score DESC, f.title ASC`;

  return rows.map((r) => {
    const matchedOn: MatchField[] = [];
    if (r.m_title) matchedOn.push("title");
    if (r.m_body) matchedOn.push("body");
    if (r.m_member) matchedOn.push("member");
    const memberCount = r.member_count ?? 0;
    return {
      kind: "sequence",
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      score: Number(r.score),
      matchedOn,
      memberCount,
      membersInRange: filtered ? (r.in_range ?? 0) : memberCount,
      dateRange: r.d0 && r.d1 ? [isoDate(r.d0), isoDate(r.d1)] : null,
      bbox:
        r.min_lon !== null &&
        r.min_lat !== null &&
        r.max_lon !== null &&
        r.max_lat !== null
          ? [r.min_lon, r.min_lat, r.max_lon, r.max_lat]
          : null,
    };
  });
}

// ── Locations ───────────────────────────────────────────────────────────────

interface LocationSearchRow {
  id: string;
  name: string;
  lon: number;
  lat: number;
  score: number;
  event_count: number;
  d0: Date | null;
  d1: Date | null;
  snippet: string;
}

/**
 * Locations match on their (modern, Nominatim-derived) name only. They rank by
 * name match first and event count second, so the "Salt Lake City" with 14
 * events beats a one-event pin snapped nearby. `eventCount` and `dateRange`
 * count only events passing the date/view filters, and with any filter on, a
 * location with none of those is dropped — it would be a hit with no pin.
 */
export async function searchLocationHits(
  input: PgSearchInput,
): Promise<LocationHit[]> {
  await ensureSchema();
  const sql = sqlClient();
  const raw = input.text.toLowerCase();
  const filtered =
    input.years !== undefined ||
    Boolean(input.sourceIds?.length) ||
    input.bbox !== undefined;

  const sim = input.trigram
    ? sql`word_similarity(immutable_unaccent(${raw}), immutable_unaccent(l.name))`
    : sql`0::real`;
  const trigramMatch = input.trigram
    ? sql`OR immutable_unaccent(${raw}) <% immutable_unaccent(l.name)`
    : sql``;

  const rows = await sql<LocationSearchRow[]>`
    WITH ${withQueries(sql, input)},
    matched AS (
      SELECT l.id, l.name, l.lon, l.lat, l.geom,
             ts_rank_cd(l.search_tsv, q.qs)
               + CASE WHEN l.search_tsv @@ q.qs THEN ${TITLE_NAME_BONUS}::real ELSE 0 END
               + ${TRIGRAM_WEIGHT}::real * ${sim} AS score
      FROM locations l, q
      WHERE (l.search_tsv @@ q.qs ${trigramMatch})
    ),
    counted AS (
      SELECT l.id, l.name, l.lon, l.lat, l.score,
             count(e.id)::int AS event_count, min(e.date) AS d0, max(e.date) AS d1
      FROM matched l
      LEFT JOIN events e ON e.location_id = l.id
        ${yearFilter(sql, input.years)}
        ${viewFilter(sql, input)}
      GROUP BY l.id, l.name, l.lon, l.lat, l.score
    )
    SELECT c.*, ts_headline('hm_simple', ${clean(sql, sql`c.name`)}, q.qs_any, ${HEADLINE_OPTS}) AS snippet
    FROM counted c, q
    WHERE NOT ${filtered}::boolean OR c.event_count > 0
    ORDER BY c.score DESC, c.event_count DESC, c.name ASC
    LIMIT ${input.limit}`;

  return rows.map((r) => ({
    kind: "location",
    id: r.id,
    title: r.name,
    snippet: r.snippet,
    score: Number(r.score),
    matchedOn: ["place"],
    coordinates: [r.lon, r.lat],
    eventCount: r.event_count,
    dateRange: r.d0 && r.d1 ? [isoDate(r.d0), isoDate(r.d1)] : null,
  }));
}

// ── Highlight ids ───────────────────────────────────────────────────────────

/**
 * Distinct location ids of every matching event — what live map highlighting
 * needs, and nothing more: no ranking, no snippets. Shares the event query's
 * match and filters so the list and the map can't disagree.
 */
export async function matchingLocationIds(
  input: PgSearchInput,
  cap: number,
): Promise<{ locationIds: string[]; truncated: boolean }> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql<{ location_id: string }[]>`
    WITH ${withQueries(sql, input)}
    SELECT DISTINCT e.location_id
    FROM events e
    JOIN locations l ON l.id = e.location_id, q
    WHERE ${eventMatch(sql, input)}
      ${yearFilter(sql, input.years)}
      ${viewFilter(sql, input)}
    LIMIT ${cap + 1}`;
  return {
    locationIds: rows.slice(0, cap).map((r) => r.location_id),
    truncated: rows.length > cap,
  };
}

/** Location ids for a date-only query: every event in range. */
export async function browseLocationIds(
  input: Omit<PgSearchInput, "text" | "anyText" | "prefix" | "trigram">,
  cap: number,
): Promise<{ locationIds: string[]; truncated: boolean }> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql<{ location_id: string }[]>`
    SELECT DISTINCT e.location_id
    FROM events e
    JOIN locations l ON l.id = e.location_id
    WHERE true
      ${yearFilter(sql, input.years)}
      ${viewFilter(sql, { ...input, text: "", anyText: "", prefix: null, trigram: false })}
    LIMIT ${cap + 1}`;
  return {
    locationIds: rows.slice(0, cap).map((r) => r.location_id),
    truncated: rows.length > cap,
  };
}

// ── Documents and passages ──────────────────────────────────────────────────
//
// Source text lives in `document_passages`, one row per paragraph, owned by
// services/ingest (its migration, its writers). The web app only reads it, as
// it already reads ingest_documents for "view source".
//
// Passages carry no date. With a date filter on, the plan's lenient rule
// applies: a passage stays when its document's published events *span* the
// range — an undated page about Aztec religion in a book whose events run
// 1100–1900 is in for 1500–1600. A document hit is stricter: at least one of
// its events must actually be in range.

let documentsReady: boolean | null = null;

/**
 * Whether the ingest-owned search tables exist. A deploy that never ran
 * ingest migrations (local dev on `npm run seed:db` alone) has no
 * document_passages, and search should say "no documents" rather than 500.
 * Only a positive answer is cached: the tables may appear later in a
 * long-lived dev server.
 */
export async function documentsAvailable(): Promise<boolean> {
  if (documentsReady) return true;
  await ensureSchema();
  const [row] = await sqlClient()<{ ok: boolean }[]>`
    SELECT to_regclass('document_passages') IS NOT NULL
       AND to_regclass('passage_events') IS NOT NULL AS ok`;
  documentsReady = row?.ok ? true : null;
  return Boolean(row?.ok);
}

/** Documents whose published events span `years` (the lenient passage rule). */
function documentSpanFilter(sql: Sql, years: YearRange | undefined): Fragment {
  if (!years) return sql``;
  const lo = Number.isFinite(years[0]) ? years[0] : null;
  const hi = Number.isFinite(years[1]) ? years[1] : null;
  return sql`
    AND p.document_id IN (
      SELECT e.document_id FROM events e
      WHERE e.document_id IS NOT NULL
      GROUP BY e.document_id
      HAVING (${lo}::int IS NULL OR max(event_hi_year(e.date, e.date_precision)) >= ${lo}::int)
         AND (${hi}::int IS NULL OR min(event_lo_year(e.date, e.date_precision)) <= ${hi}::int))`;
}

function sourceKeyFilter(sql: Sql, input: PgSearchInput): Fragment {
  const sourceIds = input.sourceIds?.length ? input.sourceIds : null;
  return sql`AND (${sourceIds}::text[] IS NULL OR s.key = ANY(${sourceIds}))`;
}

interface PassageSearchRow {
  document_id: string;
  seq: number;
  anchor: string | null;
  doc_title: string | null;
  source_key: string;
  score: number;
  event_ids: string[];
  snippet: string;
}

/**
 * The top paragraphs, at most `perDocument` from any one document so one long
 * book can't fill the list. `exclude` holds `documentId:seq` keys already
 * shown elsewhere (an event's own quote paragraph — see foldQuotePassages).
 */
export async function searchPassageHits(
  input: PgSearchInput,
  perDocument: number,
  exclude: Set<string>,
): Promise<PassageHit[]> {
  const sql = sqlClient();
  const excluded = Array.from(exclude);
  const rows = await sql<PassageSearchRow[]>`
    WITH ${withQueries(sql, input)},
    matched AS (
      SELECT p.document_id, p.seq, p.anchor, p.text,
             d.title AS doc_title, s.key AS source_key,
             ts_rank_cd(p.search_tsv, q.qe_any) AS score
      FROM document_passages p
      JOIN ingest_documents d ON d.id = p.document_id
      JOIN ingest_sources s ON s.id = d.source_id, q
      WHERE p.search_tsv @@ q.qe
        AND NOT ((p.document_id::text || ':' || p.seq) = ANY(${excluded}::text[]))
        ${documentSpanFilter(sql, input.years)}
        ${sourceKeyFilter(sql, input)}
    ),
    capped AS (
      SELECT m.*, row_number() OVER (PARTITION BY m.document_id ORDER BY m.score DESC, m.seq) AS rn
      FROM matched m
    ),
    top AS (
      SELECT * FROM capped WHERE rn <= ${perDocument}
      ORDER BY score DESC, document_id, seq
      LIMIT ${input.limit}
    )
    SELECT t.document_id, t.seq, t.anchor, t.doc_title, t.source_key, t.score,
           coalesce((SELECT array_agg(pe.event_id ORDER BY pe.event_id) FROM passage_events pe
                      WHERE pe.document_id = t.document_id AND pe.seq = t.seq), '{}') AS event_ids,
           ts_headline('hm_english', ${clean(sql, sql`t.text`)}, q.qe_any, ${HEADLINE_OPTS}) AS snippet
    FROM top t, q
    ORDER BY t.score DESC, t.document_id, t.seq`;

  return rows.map((r) => ({
    kind: "passage",
    id: `${r.document_id}:${r.seq}`,
    title: r.doc_title ?? "Untitled document",
    documentId: r.document_id,
    documentTitle: r.doc_title ?? "Untitled document",
    sourceId: r.source_key,
    anchor: r.anchor,
    snippet: r.snippet,
    score: Number(r.score),
    eventIds: r.event_ids,
    matchedOn: ["body"],
  }));
}

interface DocumentSearchRow {
  id: string;
  title: string | null;
  source_key: string;
  match_count: number;
  best_anchor: string | null;
  best_seq: number | null;
  title_hit: boolean;
  event_count: number;
  score: number;
  snippet: string;
}

/**
 * Documents roll up from the same passage matches as passage hits, plus a
 * title match. Score: best passage, a little for how many matched, and a
 * title match outranks any body match. `bestAnchor` is the top passage's, so
 * clicking can deep-link with the existing `#page=N` machinery.
 */
export async function searchDocumentHits(
  input: PgSearchInput,
): Promise<Array<DocumentHit & { bestSeq: number | null; titleHit: boolean }>> {
  const sql = sqlClient();
  const lo =
    input.years && Number.isFinite(input.years[0]) ? input.years[0] : null;
  const hi =
    input.years && Number.isFinite(input.years[1]) ? input.years[1] : null;
  const filtered = input.years !== undefined;

  const rows = await sql<DocumentSearchRow[]>`
    WITH ${withQueries(sql, input)},
    matched AS (
      SELECT p.document_id, p.seq, p.anchor, p.text, ts_rank_cd(p.search_tsv, q.qe_any) AS r
      FROM document_passages p, q
      WHERE p.search_tsv @@ q.qe
    ),
    agg AS (
      SELECT document_id, count(*)::int AS match_count, max(r) AS best
      FROM matched GROUP BY document_id
    ),
    best AS (
      SELECT DISTINCT ON (document_id) document_id, seq, anchor, text
      FROM matched ORDER BY document_id, r DESC, seq
    ),
    docs AS (
      SELECT d.id, d.title, s.key AS source_key,
             coalesce(a.match_count, 0) AS match_count,
             b.anchor AS best_anchor, b.seq AS best_seq, b.text AS best_text,
             (to_tsvector('hm_english', coalesce(d.title, '')) @@ q.qe) AS title_hit,
             (SELECT count(*)::int FROM events e
               WHERE e.document_id = d.id
                 AND (${lo}::int IS NULL OR event_hi_year(e.date, e.date_precision) >= ${lo}::int)
                 AND (${hi}::int IS NULL OR event_lo_year(e.date, e.date_precision) <= ${hi}::int)
             ) AS event_count,
             coalesce(a.best, 0) + 0.05 * ln(1 + coalesce(a.match_count, 0))
               + CASE WHEN to_tsvector('hm_english', coalesce(d.title, '')) @@ q.qe THEN 1 ELSE 0 END
               AS score
      FROM ingest_documents d
      JOIN ingest_sources s ON s.id = d.source_id
      LEFT JOIN agg a ON a.document_id = d.id
      LEFT JOIN best b ON b.document_id = d.id, q
      WHERE (a.document_id IS NOT NULL OR to_tsvector('hm_english', coalesce(d.title, '')) @@ q.qe)
        ${sourceKeyFilter(sql, input)}
    )
    SELECT docs.id, docs.title, docs.source_key, docs.match_count, docs.best_anchor,
           docs.best_seq, docs.title_hit, docs.event_count, docs.score,
           ts_headline('hm_english',
             ${clean(sql, sql`coalesce(docs.best_text, docs.title)`)}, q.qe_any, ${HEADLINE_OPTS}) AS snippet
    FROM docs, q
    WHERE NOT ${filtered}::boolean OR docs.event_count > 0
    ORDER BY docs.score DESC, docs.id
    LIMIT ${input.limit}`;

  return rows.map((r) => {
    const matchedOn: MatchField[] = [];
    if (r.title_hit) matchedOn.push("title");
    if (r.match_count > 0) matchedOn.push("body");
    return {
      kind: "document",
      id: r.id,
      title: r.title ?? "Untitled document",
      snippet: r.snippet,
      score: Number(r.score),
      matchedOn,
      sourceId: r.source_key,
      bestAnchor: r.best_anchor,
      matchCount: r.match_count,
      eventCount: r.event_count,
      bestSeq: r.best_seq,
      titleHit: r.title_hit,
    };
  });
}

/**
 * One sentence, one result. An event's source quote also sits inside the
 * paragraph it was extracted from; when that paragraph matches too, it rides
 * along on the event hit as `quotePassage` (the original wording is the
 * better snippet anyway) and is kept out of the passage group.
 *
 * Returns the `documentId:seq` keys it attached, for the passage query to
 * exclude.
 */
export async function foldQuotePassages(
  input: PgSearchInput,
  events: EventHit[],
): Promise<Set<string>> {
  const attached = new Set<string>();
  if (events.length === 0) return attached;
  const sql = sqlClient();
  const rows = await sql<
    {
      event_id: string;
      document_id: string;
      seq: number;
      anchor: string;
      snippet: string;
    }[]
  >`
    WITH ${withQueries(sql, input)}
    SELECT DISTINCT ON (pe.event_id) pe.event_id, p.document_id, p.seq, p.anchor,
           ts_headline('hm_english', ${clean(sql, sql`p.text`)}, q.qe_any, ${HEADLINE_OPTS}) AS snippet
    FROM passage_events pe
    JOIN document_passages p ON p.document_id = pe.document_id AND p.seq = pe.seq, q
    WHERE pe.event_id = ANY(${events.map((e) => e.id)}::text[])
      AND p.search_tsv @@ q.qe
    ORDER BY pe.event_id, p.seq`;

  const byEvent = new Map(rows.map((r) => [r.event_id, r]));
  for (const event of events) {
    const r = byEvent.get(event.id);
    if (!r) continue;
    event.quotePassage = {
      documentId: r.document_id,
      anchor: r.anchor,
      snippet: r.snippet,
    };
    attached.add(`${r.document_id}:${r.seq}`);
  }
  return attached;
}

// ── Document panel ──────────────────────────────────────────────────────────

export interface DocumentPanel {
  id: string;
  title: string | null;
  sourceId: string;
  sourceName: string;
  extractedAt: string | null;
  passages: Array<{
    seq: number;
    anchor: string;
    snippet: string;
    eventIds: string[];
  }>;
  events: Array<{
    id: string;
    title: string;
    date: string;
    datePrecision?: DatePrecision;
    anchor: string | null;
    locationId: string;
  }>;
}

/**
 * Everything the document panel (plans/21) shows: every paragraph matching
 * `q`, in document order, and the document's published events. Null for an
 * unknown document. Without `q`, no passages — the panel is the event list.
 */
export async function getDocumentPanel(
  documentId: string,
  q: string | null,
): Promise<DocumentPanel | null> {
  if (!(await documentsAvailable())) return null;
  const sql = sqlClient();
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return null;

  const [doc] = await sql<
    {
      id: string;
      title: string | null;
      source_key: string;
      source_name: string;
      text_ready_at: Date | null;
    }[]
  >`
    SELECT d.id, d.title, s.key AS source_key, s.display_name AS source_name, d.text_ready_at
    FROM ingest_documents d JOIN ingest_sources s ON s.id = d.source_id
    WHERE d.id = ${documentId}::uuid`;
  if (!doc) return null;

  let passages: DocumentPanel["passages"] = [];
  const text = q?.trim();
  if (text) {
    const input: PgSearchInput = {
      text,
      anyText: text,
      prefix: null,
      trigram: false,
      limit: 0,
    };
    const rows = await sql<
      { seq: number; anchor: string; snippet: string; event_ids: string[] }[]
    >`
      WITH ${withQueries(sql, input)}
      SELECT p.seq, p.anchor,
             ts_headline('hm_english', ${clean(sql, sql`p.text`)}, q.qe_any, ${HEADLINE_OPTS}) AS snippet,
             coalesce((SELECT array_agg(pe.event_id ORDER BY pe.event_id) FROM passage_events pe
                        WHERE pe.document_id = p.document_id AND pe.seq = p.seq), '{}') AS event_ids
      FROM document_passages p, q
      WHERE p.document_id = ${documentId}::uuid AND p.search_tsv @@ q.qe
      ORDER BY p.seq`;
    passages = rows.map((r) => ({
      seq: r.seq,
      anchor: r.anchor,
      snippet: r.snippet,
      eventIds: r.event_ids,
    }));
  }

  const events = await sql<
    {
      id: string;
      title: string;
      date: Date;
      date_precision: DatePrecision | null;
      anchor: string | null;
      location_id: string;
    }[]
  >`
    SELECT id, title, date, date_precision, anchor, location_id
    FROM events WHERE document_id = ${documentId}::uuid
    ORDER BY date, id`;

  return {
    id: doc.id,
    title: doc.title,
    sourceId: doc.source_key,
    sourceName: doc.source_name,
    extractedAt: doc.text_ready_at
      ? new Date(doc.text_ready_at).toISOString()
      : null,
    passages,
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      date: isoDate(e.date),
      ...(e.date_precision ? { datePrecision: e.date_precision } : {}),
      anchor: e.anchor,
      locationId: e.location_id,
    })),
  };
}
