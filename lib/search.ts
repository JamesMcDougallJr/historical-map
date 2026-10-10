// Search, backend-agnostic (plans/20-search-lexical.md).
//
// Parses the query, works out the effective date filter, runs one ranked query
// per requested kind on whichever backend is live, and assembles the typed,
// grouped response. `/api/search` only parses params and serialises; the MCP
// `search` tool (plan 24) will call `search()` directly, the way
// `search_events` calls lib/server-storage.ts today.
//
// Space is global, time is not: the timeline (`from`/`to`) restricts every
// kind, while `bbox`/`sources` arrive only when the user adds "limit to view".
// A date typed into the query and the timeline intersect; when they can't,
// the response says `parsed.conflict = "timeline"` rather than returning an
// unexplained empty list.

import {
  intersectYearRanges,
  SEARCH_KINDS,
  type Bbox,
  type SearchHit,
  type SearchKind,
  type SearchResponse,
  type YearRange,
} from "@historical-map/domain";
import { parseEventQuery } from "@/app/map/utils/event-query";
import {
  anyTermsQuery,
  buildPrefixQuery,
  hasSearchOperators,
  MAX_QUERY_LENGTH,
  parseSearchQuery,
} from "@/app/map/utils/search-query";
import * as pg from "./search-postgres";
import {
  foldText,
  searchStatic,
  staticMatchingLocationIds,
} from "./search-static";
import { readData } from "./server-storage";

export const MAX_LIMIT = 50;
export const MAX_HITS = 50;
export const MATCHES_CAP = 5000;

/** How many hits each kind gets by default — the grouped Spotlight/Linear pattern. */
const DEFAULT_LIMITS: Record<SearchKind, number> = {
  event: 8,
  sequence: 3,
  location: 3,
  document: 3,
  passage: 4,
};
/** A date-only browse lists that period's events, so it gets a longer list. */
const DEFAULT_BROWSE_LIMIT = 20;

export interface SearchRequest {
  q: string;
  mode: "lexical" | "hybrid";
  /** Typeahead: match the last word as a prefix. */
  prefix: boolean;
  kinds: SearchKind[];
  /** Per-kind cap; defaults per kind. */
  limit?: number;
  /** The timeline filter, when enabled. */
  timeline?: YearRange;
  bbox?: Bbox;
  sourceIds?: string[];
}

export function parseSearchRequest(params: URLSearchParams): SearchRequest {
  const eventQuery = parseEventQuery(params);
  const kindsParam = params.get("kinds");
  const kinds = kindsParam
    ? kindsParam
        .split(",")
        .filter((k): k is SearchKind =>
          (SEARCH_KINDS as readonly string[]).includes(k),
        )
    : [...SEARCH_KINDS];
  const limitParam = Number(params.get("limit"));

  const req: SearchRequest = {
    q: (params.get("q") ?? "").slice(0, MAX_QUERY_LENGTH),
    mode: params.get("mode") === "hybrid" ? "hybrid" : "lexical",
    prefix: params.get("prefix") === "1",
    kinds,
  };
  if (Number.isFinite(limitParam) && limitParam > 0) {
    req.limit = Math.min(Math.floor(limitParam), MAX_LIMIT);
  }
  if (eventQuery.fromYear !== undefined || eventQuery.toYear !== undefined) {
    req.timeline = [
      eventQuery.fromYear ?? -Infinity,
      eventQuery.toYear ?? Infinity,
    ];
  }
  if (eventQuery.bbox) req.bbox = eventQuery.bbox;
  if (eventQuery.sourceIds) req.sourceIds = eventQuery.sourceIds;
  return req;
}

const usePostgres = () => Boolean(process.env["POSTGRES_URL"]);

interface Prepared {
  text: string;
  years?: YearRange;
  parsed: SearchResponse["parsed"];
  /** No date filter of any kind applied. */
  unfiltered: boolean;
  conflict: boolean;
}

function prepare(req: SearchRequest): Prepared {
  const parsedQuery = parseSearchQuery(req.q);
  const parsed: SearchResponse["parsed"] = { text: parsedQuery.text };
  if (parsedQuery.dateRange) {
    parsed.dateRange = [
      Number.isFinite(parsedQuery.dateRange[0])
        ? parsedQuery.dateRange[0]
        : null,
      Number.isFinite(parsedQuery.dateRange[1])
        ? parsedQuery.dateRange[1]
        : null,
    ];
  }
  if (parsedQuery.rawDate) parsed.rawDate = parsedQuery.rawDate;
  if (parsedQuery.unsupported) parsed.unsupported = parsedQuery.unsupported;

  let years: YearRange | undefined = parsedQuery.dateRange ?? req.timeline;
  let conflict = false;
  if (parsedQuery.dateRange && req.timeline) {
    const both = intersectYearRanges(parsedQuery.dateRange, req.timeline);
    if (both) years = both;
    else {
      conflict = true;
      parsed.conflict = "timeline";
    }
  }

  const out: Prepared = {
    text: parsedQuery.text,
    parsed,
    unfiltered: !parsedQuery.dateRange && !req.timeline,
    conflict,
  };
  if (years) out.years = years;
  return out;
}

function pgInput(
  req: SearchRequest,
  p: Prepared,
  limit: number,
): pg.PgSearchInput {
  let prefix: pg.PgSearchInput["prefix"] = null;
  if (req.prefix) {
    const built = buildPrefixQuery(p.text);
    if (built.prefixTerm) {
      prefix = {
        head: built.head,
        prefixTerm: built.prefixTerm,
        lastWord: built.prefixTerm.slice(1, -3),
      };
    }
  }
  const input: pg.PgSearchInput = {
    text: p.text,
    anyText: anyTermsQuery(p.text),
    prefix,
    trigram: !hasSearchOperators(p.text),
    limit,
  };
  if (p.years) input.years = p.years;
  if (req.bbox) input.bbox = req.bbox;
  if (req.sourceIds?.length) input.sourceIds = req.sourceIds;
  return input;
}

/** True when the query, stripped of operators, has something to match on. */
function hasText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export async function search(req: SearchRequest): Promise<SearchResponse> {
  const started = Date.now();
  const p = prepare(req);
  const kinds = new Set(req.kinds);
  const documents = false; // document/passage kinds land with document_passages (S1, part 3)

  const respond = (
    hits: SearchHit[],
    topHit?: SearchResponse["topHit"],
  ): SearchResponse => {
    const res: SearchResponse = {
      hits: hits.slice(0, MAX_HITS),
      modes: { lexical: true, semantic: false, documents },
      parsed: p.parsed,
      timing: { ms: Date.now() - started, unfiltered: p.unfiltered },
    };
    if (topHit) res.topHit = topHit;
    return res;
  };

  if (p.conflict) return respond([]);

  const browse = !hasText(p.text);
  if (browse && !p.years) return respond([]);

  const limitFor = (kind: SearchKind) =>
    req.limit ?? (browse ? DEFAULT_BROWSE_LIMIT : DEFAULT_LIMITS[kind]);

  if (!usePostgres()) {
    const result = searchStatic(await readData(), {
      text: browse ? "" : p.text,
      prefix: req.prefix,
      ...(p.years ? { years: p.years } : {}),
      ...(req.bbox ? { bbox: req.bbox } : {}),
      ...(req.sourceIds?.length ? { sourceIds: req.sourceIds } : {}),
      limit: Math.max(...req.kinds.map(limitFor), 1),
    });
    const hits: SearchHit[] = [
      ...(kinds.has("event") ? result.events.slice(0, limitFor("event")) : []),
      ...(kinds.has("sequence")
        ? result.sequences.slice(0, limitFor("sequence"))
        : []),
      ...(kinds.has("location")
        ? result.locations.slice(0, limitFor("location"))
        : []),
    ];
    return respond(hits, browse ? undefined : findTopHit(hits, p.text));
  }

  if (browse) {
    if (!kinds.has("event")) return respond([]);
    const input = pgInput(req, p, limitFor("event"));
    return respond(await pg.browseEventHits(input));
  }

  const [events, sequences, locations] = await Promise.all([
    kinds.has("event")
      ? pg.searchEventHits(pgInput(req, p, limitFor("event")))
      : [],
    kinds.has("sequence")
      ? pg.searchSequenceHits(pgInput(req, p, limitFor("sequence")))
      : [],
    kinds.has("location")
      ? pg.searchLocationHits(pgInput(req, p, limitFor("location")))
      : [],
  ]);
  const hits: SearchHit[] = [...events, ...sequences, ...locations];
  return respond(hits, findTopHit(hits, p.text));
}

/**
 * One hit whose title is exactly the query (accent- and case-insensitive)
 * clearly dominates, and is promoted above the groups. Two such hits — an
 * event and a sequence both titled "Mountain Meadows Massacre" — and nothing
 * dominates, so there is no top hit.
 */
function findTopHit(
  hits: SearchHit[],
  text: string,
): SearchResponse["topHit"] | undefined {
  const norm = (s: string) => foldText(s).replace(/\s+/g, " ").trim();
  const target = norm(text);
  if (!target) return undefined;
  const exact = hits.filter(
    (h) =>
      (h.kind === "event" || h.kind === "sequence" || h.kind === "location") &&
      norm(h.title) === target,
  );
  if (exact.length !== 1) return undefined;
  return { kind: exact[0]!.kind, id: exact[0]!.id };
}

/** Location ids of every lexically matching event — feeds live map highlighting. */
export async function searchMatches(
  req: SearchRequest,
): Promise<{ locationIds: string[]; truncated: boolean }> {
  const p = prepare(req);
  const empty = { locationIds: [], truncated: false };
  if (p.conflict) return empty;
  const browse = !hasText(p.text);
  if (browse && !p.years) return empty;

  if (!usePostgres()) {
    return staticMatchingLocationIds(
      await readData(),
      {
        text: browse ? "" : p.text,
        prefix: req.prefix,
        ...(p.years ? { years: p.years } : {}),
        ...(req.bbox ? { bbox: req.bbox } : {}),
        ...(req.sourceIds?.length ? { sourceIds: req.sourceIds } : {}),
      },
      MATCHES_CAP,
    );
  }

  const input = pgInput(req, p, MATCHES_CAP);
  return browse
    ? pg.browseLocationIds(input, MATCHES_CAP)
    : pg.matchingLocationIds(input, MATCHES_CAP);
}
