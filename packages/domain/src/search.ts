// The search contract — what `GET /api/search` returns, and what the MCP
// `search` tool (plan 24) and the `/map` search bar (plan 21) consume.
//
// Every hit carries a `kind` discriminant and a stable `id`, so `kind:id`
// identifies a result across the URL state, the dispatcher that acts on a
// click, and anything later keyed on "what did the user find".
//
// Scores are only comparable *within* a kind: `ts_rank_cd` depends on each
// table's weights and document lengths, so the response groups hits by kind
// rather than pretending one sorted list across kinds means something
// (plans/20-search-lexical.md, "Merging across kinds").

import type { DatePrecision } from "./dates";

export const SEARCH_KINDS = [
  "event",
  "sequence",
  "location",
  "person",
  "document",
  "passage",
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** Why a hit matched — lets the UI explain a hit whose snippet doesn't show the query. */
export type MatchField =
  | "title"
  | "place"
  | "date"
  | "body"
  | "quote"
  | "member"
  | "person"
  | "meaning";

/** [minLon, minLat, maxLon, maxLat] in EPSG:4326. */
export type Bbox = [number, number, number, number];

/**
 * Snippets mark matched terms with these sentinels rather than HTML. Source
 * text is untrusted, so the UI splits on them and renders `<mark>` itself —
 * a snippet is never rendered as markup.
 */
export const SNIPPET_MARK_START = "\u0002";
export const SNIPPET_MARK_END = "\u0003";

interface HitBase {
  id: string;
  title: string;
  /** Plain text with `SNIPPET_MARK_*` sentinels around matched terms. */
  snippet: string;
  score: number;
  matchedOn: MatchField[];
}

export interface EventHit extends HitBase {
  kind: "event";
  date: string;
  datePrecision?: DatePrecision;
  dateText?: string;
  locationId: string;
  locationName: string;
  coordinates: [number, number];
  sourceId: string | null;
  /** The paragraph this event was quoted from, when that paragraph also matched (S1 passages). */
  quotePassage?: { documentId: string; anchor: string; snippet: string };
}

export interface SequenceHit extends HitBase {
  kind: "sequence";
  memberCount: number;
  /** Members inside the active date filter — "3 of 5 events in range". Equals `memberCount` with no filter. */
  membersInRange: number;
  /** ISO dates of the earliest and latest member. */
  dateRange: [string, string] | null;
  bbox: Bbox | null;
}

export interface LocationHit extends HitBase {
  kind: "location";
  coordinates: [number, number];
  /** In-range events only, so the count never promises pins the timeline is hiding. */
  eventCount: number;
  dateRange: [string, string] | null;
}

export interface DocumentHit extends HitBase {
  kind: "document";
  sourceId: string;
  bestAnchor: string | null;
  matchCount: number;
  eventCount: number;
}

export interface PassageHit extends HitBase {
  kind: "passage";
  /** `${documentId}:${seq}` */
  id: string;
  documentId: string;
  documentTitle: string;
  sourceId: string;
  anchor: string | null;
  /** Published events extracted from this paragraph. */
  eventIds: string[];
}

/**
 * A distinct normalised name among the events' people mentions (Level 2 of
 * plans/22-search-people.md). Not an identity: "brigham young" and
 * "president young" are separate hits until a resolver says otherwise, and
 * the honest display of that is two rows.
 */
export interface PersonHit extends HitBase {
  kind: "person";
  /** The normalised name — the stable key until people get canonical ids. */
  id: string;
  /** In-range events naming them. */
  eventCount: number;
  dateRange: [string, string] | null;
}

export type SearchHit =
  | EventHit
  | SequenceHit
  | LocationHit
  | PersonHit
  | DocumentHit
  | PassageHit;

/** What the query parser recognised, echoed back so the UI can show (and let the user remove) it. */
export interface ParsedSearch {
  /** The query with any recognised date removed — what the text matcher sees. */
  text: string;
  /**
   * The date range parsed out of the query, before intersecting with the
   * timeline. An open end ("before 1850") is `null` on the wire, since JSON
   * has no Infinity.
   */
  dateRange?: [number | null, number | null];
  /** The substring the date was parsed from, e.g. "1840s". */
  rawDate?: string;
  /** Something date-like the parser deliberately doesn't support. */
  unsupported?: "bce";
  /** The parsed date and the timeline filter don't overlap, so nothing can match. */
  conflict?: "timeline";
}

export interface SearchResponse {
  /** Grouped by kind, each group in its own rank order. */
  hits: SearchHit[];
  /** A single hit that clearly dominates (exact title match), shown above the groups. */
  topHit?: { kind: SearchKind; id: string };
  modes: { lexical: boolean; semantic: boolean; documents: boolean };
  parsed: ParsedSearch;
  timing: {
    ms: number;
    /** No date filter of any kind applied — what the UI's "try the timeline" hint keys on. */
    unfiltered: boolean;
  };
}
