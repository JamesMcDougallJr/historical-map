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
  normalizeEntityName,
  SEARCH_KINDS,
  type Bbox,
  type DocumentHit,
  type PassageHit,
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
import { embedQuery, semanticModel, type QueryVector } from "./search-semantic";
import { readData } from "./server-storage";

export const MAX_LIMIT = 50;
export const MAX_HITS = 50;
export const MATCHES_CAP = 5000;

/** How many hits each kind gets by default — the grouped Spotlight/Linear pattern. */
const DEFAULT_LIMITS: Record<SearchKind, number> = {
  event: 8,
  sequence: 3,
  location: 3,
  person: 3,
  document: 3,
  passage: 4,
};
/** One long book mustn't fill the passage list. */
const PASSAGES_PER_DOCUMENT = 2;
/** A date-only browse lists that period's events, so it gets a longer list. */
const DEFAULT_BROWSE_LIMIT = 20;

// ── Hybrid (plans/23-search-semantic.md) ────────────────────────────────────

/** Reciprocal rank fusion's one constant — ranks only, never raw scores. */
const RRF_K = 60;
/** Each arm's candidate pool before fusion. */
const HYBRID_POOL = 50;
/**
 * The vector arm's relevance floor: cosine similarity below this is noise
 * (nearest-neighbour search always returns *something*).
 *
 * Set from `npm run search:eval -- --floor` on the fixture golden set
 * (2026-10-15, Titan v2 at 256 dims, 127 recorded vectors):
 *
 *   floor   hybrid expectations found   negative-query meaning hits
 *   0.275            6/6                            1
 *   0.300            6/6                            0   ← this
 *   0.325            6/6                            0
 *   0.350            5/6                            0
 *
 * The safe band is narrow — Titan's similarities run low (a genuine
 * paraphrase, Tula vs "Toltec collapse", is 0.363) — so re-run the sweep with
 * `--live` against the real corpus before trusting it on more data.
 */
export const VECTOR_MIN_SIMILARITY = 0.3;

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
  // Document and passage hits need Postgres *and* the ingest-owned tables.
  const documents = usePostgres() && (await pg.documentsAvailable());
  let semantic = false;

  const respond = (
    hits: SearchHit[],
    topHit?: SearchResponse["topHit"],
  ): SearchResponse => {
    const res: SearchResponse = {
      hits: hits.slice(0, MAX_HITS),
      modes: { lexical: true, semantic, documents },
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
      ...(kinds.has("person")
        ? result.people.slice(0, limitFor("person"))
        : []),
    ];
    return respond(hits, browse ? undefined : findTopHit(hits, p.text));
  }

  if (browse) {
    if (!kinds.has("event")) return respond([]);
    const input = pgInput(req, p, limitFor("event"));
    return respond(await pg.browseEventHits(input));
  }

  // The vector arm: only for a submitted hybrid search (typeahead never
  // embeds — the server enforces it, not just the UI), only when the corpus
  // holds vectors from the model the query would be embedded with.
  const ranks = await vectorArm(req, p, kinds, documents);
  semantic = ranks !== null;
  const pool = (kind: SearchKind) =>
    ranks ? Math.max(HYBRID_POOL, limitFor(kind)) : limitFor(kind);

  const [lexEvents, lexSequences, locations, people, documentHits] =
    await Promise.all([
      kinds.has("event")
        ? pg.searchEventHits(pgInput(req, p, pool("event")))
        : [],
      kinds.has("sequence")
        ? pg.searchSequenceHits(pgInput(req, p, pool("sequence")))
        : [],
      kinds.has("location")
        ? pg.searchLocationHits(pgInput(req, p, limitFor("location")))
        : [],
      kinds.has("person")
        ? pg.searchPersonHits(
            pgInput(req, p, limitFor("person")),
            normalizeEntityName(p.text),
          )
        : [],
      documents && kinds.has("document")
        ? pg.searchDocumentHits(pgInput(req, p, limitFor("document")))
        : [],
    ]);

  const [events, sequences] = ranks
    ? await Promise.all([
        fuse(lexEvents, ranks.event, limitFor("event"), (ids) =>
          pg.searchEventHits({ ...pgInput(req, p, ids.length), ids }),
        ),
        fuse(lexSequences, ranks.sequence, limitFor("sequence"), (ids) =>
          pg.searchSequenceHits({ ...pgInput(req, p, ids.length), ids }),
        ),
      ])
    : [lexEvents, lexSequences];

  // One sentence, one result: an event's own quote paragraph rides on the
  // event hit and stays out of the passage group.
  const folded = documents
    ? await pg.foldQuotePassages(pgInput(req, p, 0), events)
    : new Set<string>();
  let passages: PassageHit[] = [];
  if (documents && kinds.has("passage")) {
    if (ranks) {
      // Fuse the uncapped pools, then cap per document, so the cap ranks by
      // fused score rather than by either arm alone.
      const lexPassages = await pg.searchPassageHits(
        pgInput(req, p, HYBRID_POOL),
        HYBRID_POOL,
        folded,
      );
      const fused = await fuse(
        lexPassages,
        ranks.passage.filter((id) => !folded.has(id)),
        Infinity,
        (ids) =>
          pg.searchPassageHits(
            { ...pgInput(req, p, ids.length), ids },
            HYBRID_POOL,
            folded,
          ),
      );
      const perDoc = new Map<string, number>();
      passages = fused
        .filter((h) => {
          const n = (perDoc.get(h.documentId) ?? 0) + 1;
          perDoc.set(h.documentId, n);
          return n <= PASSAGES_PER_DOCUMENT;
        })
        .slice(0, limitFor("passage"));
    } else {
      passages = await pg.searchPassageHits(
        pgInput(req, p, limitFor("passage")),
        PASSAGES_PER_DOCUMENT,
        folded,
      );
    }
  }

  // A document whose only match is one passage already listed adds nothing
  // the passage row doesn't say.
  const listed = new Set(passages.map((h) => h.id));
  const docs: DocumentHit[] = documentHits
    .filter(
      (d) =>
        d.titleHit ||
        d.matchCount !== 1 ||
        d.bestSeq === null ||
        !listed.has(`${d.id}:${d.bestSeq}`),
    )
    .map(({ bestSeq: _bestSeq, titleHit: _titleHit, ...hit }) => hit);

  const hits: SearchHit[] = [
    ...events,
    ...sequences,
    ...locations,
    ...people,
    ...docs,
    ...passages,
  ];
  return respond(hits, findTopHit(hits, p.text));
}

/**
 * Ranks from the vector arm, or null when it doesn't run — and null means the
 * response says `modes.semantic = false` and is purely lexical. Any failure
 * on the way (no engine, the daily ceiling, the embedder, a corpus embedded
 * with another model, the query itself) lands here, never as a 5xx.
 */
async function vectorArm(
  req: SearchRequest,
  p: Prepared,
  kinds: ReadonlySet<SearchKind>,
  documents: boolean,
  minSimilarity = VECTOR_MIN_SIMILARITY,
): Promise<pg.VectorRanks | null> {
  if (req.mode !== "hybrid" || req.prefix) return null;
  const vectorKinds = new Set(
    (["event", "sequence", "passage"] as const).filter((k) => kinds.has(k)),
  );
  if (vectorKinds.size === 0) return null;
  const model = semanticModel();
  if (!model) return null;
  try {
    if (!(await pg.semanticReady(model))) return null;
    const query: QueryVector | null = await embedQuery(p.text);
    if (!query) return null;
    return await pg.vectorRanks(
      pgInput(req, p, HYBRID_POOL),
      query.vector,
      query.model,
      minSimilarity,
      HYBRID_POOL,
      vectorKinds,
      documents,
    );
  } catch (error) {
    console.warn(`[search] vector arm failed: ${(error as Error)?.message}`);
    return null;
  }
}

/**
 * The vector arm alone, hydrated, in vector order — for `search:eval`, which
 * compares lexical, vector-only and hybrid, and sweeps candidate floors. Null
 * when the arm can't run. Not used to serve searches.
 */
export async function searchVectorOnly(
  req: SearchRequest,
  minSimilarity = VECTOR_MIN_SIMILARITY,
): Promise<SearchHit[] | null> {
  if (!usePostgres()) return null;
  const p = prepare(req);
  if (p.conflict || !hasText(p.text)) return [];
  const documents = await pg.documentsAvailable();
  const ranks = await vectorArm(
    { ...req, mode: "hybrid", prefix: false },
    p,
    new Set(req.kinds),
    documents,
    minSimilarity,
  );
  if (!ranks) return null;
  const limit = (kind: SearchKind) => req.limit ?? DEFAULT_LIMITS[kind];
  const [events, sequences, passages] = await Promise.all([
    fuse([], ranks.event, limit("event"), (ids) =>
      pg.searchEventHits({ ...pgInput(req, p, ids.length), ids }),
    ),
    fuse([], ranks.sequence, limit("sequence"), (ids) =>
      pg.searchSequenceHits({ ...pgInput(req, p, ids.length), ids }),
    ),
    fuse([], ranks.passage, limit("passage"), (ids) =>
      pg.searchPassageHits(
        { ...pgInput(req, p, ids.length), ids },
        HYBRID_POOL,
        new Set(),
      ),
    ),
  ]);
  return [...events, ...sequences, ...passages];
}

/**
 * Reciprocal rank fusion: each id scores Σ 1/(k + rank) over the arms that
 * found it — ranks only, because `ts_rank_cd` and cosine similarity live on
 * unrelated scales. A hit both arms found keeps its lexical fields
 * (`matchedOn`, snippet); one only the vector arm found is fetched by id
 * through the same query and filters, and says `matchedOn: ["meaning"]`.
 */
async function fuse<H extends SearchHit>(
  lexical: H[],
  vectorIds: string[],
  limit: number,
  hydrate: (ids: string[]) => Promise<H[]>,
): Promise<H[]> {
  const score = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  const add = (id: string, rank: number) => {
    score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    if (!firstSeen.has(id)) firstSeen.set(id, firstSeen.size);
  };
  lexical.forEach((h, i) => add(h.id, i));
  vectorIds.forEach((id, i) => add(id, i));

  const top = Array.from(score.keys())
    .sort(
      (a, b) =>
        score.get(b)! - score.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!,
    )
    .slice(0, limit);

  const byId = new Map<string, H>(lexical.map((h) => [h.id, h]));
  const missing = top.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    for (const hit of await hydrate(missing)) {
      byId.set(hit.id, { ...hit, matchedOn: ["meaning"] });
    }
  }
  return top
    .map((id) => byId.get(id))
    .filter((h): h is H => h !== undefined)
    .map((h) => ({ ...h, score: score.get(h.id)! }));
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
      (h.kind === "event" ||
        h.kind === "sequence" ||
        h.kind === "location" ||
        h.kind === "person") &&
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
