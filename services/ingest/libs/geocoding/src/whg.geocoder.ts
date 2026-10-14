import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  distanceKm,
  type GeocodeCandidate,
  type GeocodeHit,
  type GeocodeOutcome,
  type Geocoder,
} from "./geocoder.interface";
import { RateLimiterService } from "@app/common/ratelimit/rate-limiter.service";

const WHG_RECONCILE_URL = "https://whgazetteer.org/reconcile";
const REQUEST_TIMEOUT_MS = 15_000;
/** The single query key sent in every request — one place per call, never batched. */
const QUERY_KEY = "q0";

export interface WhgReconcileResponse {
  [key: string]: { result: WhgCandidate[] };
}

/** Shape of one candidate in a WHG `/reconcile` response, per docs.whgazetteer.org. */
export interface WhgCandidate {
  id: string; // e.g. "place:gn:5285192"
  name: string;
  /** 0-100. Not reliably a confidence signal on its own — see `match`. */
  score: number;
  /**
   * WHG's own verdict on whether this is *the* match, as opposed to merely a
   * plausible candidate worth surfacing for human review (OpenRefine's use
   * case). Non-matches can carry the same score as matches — observed on
   * "Sutter's Mill": a `match: false` Wikidata candidate scored 40, same as
   * several genuine non-matches — so `score` alone cannot stand in for this.
   */
  match: boolean;
  description?: string;
  /**
   * Source gazetteer: `gn` (GeoNames), `osm`, `tgn` (Getty), `wd` (Wikidata),
   * `ohm` (OpenHistoricalMap), `whg`, `hgis`, … — see MODERN_NAMESPACES.
   */
  namespace?: string;
  /**
   * `[lon, lat]`, GeoJSON order. Usually present even when `has_geom` is
   * false — WHG's "geometry recovery" falls back to a representative point,
   * so no second request is needed to get coordinates. But it can be `null`
   * (observed on "Mexico" and "Lago de Texcoco"), so never destructure it
   * unchecked.
   */
  repr_point: [number, number] | null;
}

type LocatedCandidate = WhgCandidate & { repr_point: [number, number] };

/**
 * Namespaces that are modern gazetteers. Nominatim already covers these, and
 * ranks their homonyms better (by OSM importance) than WHG does — WHG scores
 * every same-named modern place 100 with `match: true`, so among them it has
 * no signal at all. What WHG uniquely adds is the historical sources.
 */
const MODERN_NAMESPACES = new Set(["gn", "osm"]);

/**
 * How far apart two candidates may be and still be "the same place" — gazetteers
 * disagree by a few km on a city's representative point. City scale on
 * purpose: a looser radius starts merging distinct same-named towns.
 */
const SAME_PLACE_KM = 25;

/** Distinct places reported in `GeocodeOutcome.considered` — bounds a Jev prompt. */
const MAX_CONSIDERED = 8;

function hasPoint(c: WhgCandidate): c is LocatedCandidate {
  return (
    Array.isArray(c.repr_point) &&
    Number.isFinite(c.repr_point[0]) &&
    Number.isFinite(c.repr_point[1])
  );
}

function toCandidate(c: LocatedCandidate): GeocodeCandidate {
  return {
    lon: c.repr_point[0],
    lat: c.repr_point[1],
    displayName: c.description ? `${c.name} (${c.description})` : c.name,
  };
}

function samePlace(a: LocatedCandidate, b: LocatedCandidate): boolean {
  return distanceKm(toCandidate(a), toCandidate(b)) <= SAME_PLACE_KM;
}

/** One candidate per distinct place — gazetteers repeat each other's records. */
function distinctPlaces(pool: LocatedCandidate[]): LocatedCandidate[] {
  const kept: LocatedCandidate[] = [];
  for (const c of pool) if (!kept.some((k) => samePlace(k, c))) kept.push(c);
  return kept;
}

function isHistorical(c: WhgCandidate): boolean {
  return !MODERN_NAMESPACES.has(c.namespace ?? "");
}

/**
 * The first candidate, if every candidate in `pool` agrees with it on where
 * the place is. Otherwise WHG has named several places and given no way to
 * choose — returning the first would be a coin flip.
 */
function agreed(pool: LocatedCandidate[]): LocatedCandidate | null {
  const first = pool[0];
  if (!first) return null;
  return pool.every((c) => samePlace(c, first)) ? first : null;
}

/**
 * Chooses a match only when the choice is actually informed:
 *
 * 1. Every match agrees on one place → take it ("New Spain": one Wikidata hit).
 * 2. Otherwise, only the historical sources agree → take theirs. "New Mexico"
 *    has GeoNames hits in Québec and Zimbabwe, but OpenHistoricalMap's only
 *    answer is the territory itself.
 * 3. Otherwise → `null`, deferring to the next provider.
 *
 * Step 3 is the fix for what the first production refresh exposed: taking
 * the first of several equally-scored matches put Yucatán in Iowa, Veracruz
 * in Costa Rica and Texcoco in Sonora. Against that corpus first-wins was
 * right once in nine tied cases; Nominatim, ranking the same modern homonyms
 * by importance, was right in all of them.
 */
function pickUnambiguous(accepted: LocatedCandidate[]): LocatedCandidate | null {
  return agreed(accepted) ?? agreed(accepted.filter(isHistorical));
}

/**
 * World Historical Gazetteer — tried before Nominatim (see `FallbackGeocoder`
 * in `geocoding.module.ts`) because it indexes historical place names and
 * variants rather than only what a place is called today. This is the fix
 * for the failure mode `NominatimGeocoder` documents: "Sutter's Mill" →
 * modern Idaho instead of 1848 Coloma, California.
 *
 * Single request: `POST /reconcile` against https://whgazetteer.org, one
 * query per call. Candidates carry `repr_point` directly, so a second
 * Entity-API round trip isn't needed to get coordinates.
 *
 * **Only `match: true` candidates are accepted.** WHG's reconciliation
 * protocol (shared with OpenRefine) hands back plausible-but-unconfirmed
 * candidates too, scored on the same 0-100 scale as confirmed matches — so
 * treating "score above some cutoff" as good enough would auto-accept
 * exactly the kind of guess `match: false` exists to flag for a human.
 * Ties among matched candidates are common — WHG marks every same-named
 * modern place `score: 100, match: true` — and are only resolved when the
 * matches (or, failing that, the historical sources among them) agree on one
 * place; otherwise this returns `null` and Nominatim decides. See
 * `pickUnambiguous`.
 *
 * Requires a `WHG_API_TOKEN` (free, from a WHG account's Profile page).
 * Daily quota is 5,000 requests — the `geocode_cache` is what makes a
 * corpus-sized run affordable, same reasoning as Nominatim's rate limit.
 */
@Injectable()
export class WhgGeocoder implements Geocoder {
  readonly providerName = "whg";

  private readonly logger = new Logger(WhgGeocoder.name);
  private readonly token: string | undefined;
  private readonly userAgent: string;
  private readonly minScore: number;
  private readonly minIntervalMs: number;

  constructor(
    config: ConfigService,
    private readonly rateLimiter: RateLimiterService,
  ) {
    this.token = config.get<string>("WHG_API_TOKEN");
    this.userAgent =
      config.get<string>("GEOCODER_USER_AGENT") ??
      "historical-map-ingest/0.1 (+https://github.com/JamesMcDougallJr/historical-map)";
    this.minScore = config.get<number>("WHG_MIN_SCORE") ?? 40;
    this.minIntervalMs = config.get<number>("WHG_MIN_INTERVAL_MS") ?? 250;
    this.rateLimiter.registerRateLimit("whg", 30);
  }

  async geocode(placeName: string): Promise<GeocodeHit | null> {
    return (await this.lookup(placeName)).hit;
  }

  /**
   * Tier 1. Besides a hit, always reports where WHG's *historical* sources put
   * the name, so Nominatim can be held to it when WHG itself declines — see
   * `GeocodeHints.historical`.
   */
  async lookup(placeName: string): Promise<GeocodeOutcome> {
    if (!this.token) {
      // Config error, not "no match" — fail loudly rather than silently
      // never trying WHG (which would look identical to a corpus with no
      // historical-name coverage).
      throw new Error(
        "WHG_API_TOKEN is not set; get one from https://whgazetteer.org profile page",
      );
    }

    await this.respectRateLimit();
    const candidates = await this.reconcile(placeName);

    // A candidate without a point is a gazetteer record WHG could not locate
    // (observed: "Mexico", "Madrid", "Lago de Texcoco"). It can't become a pin,
    // and destructuring its null `repr_point` used to throw — which
    // FallbackGeocoder read as an outage and silently routed to Nominatim.
    const accepted = candidates
      .filter(hasPoint)
      .filter((c) => c.match && c.score >= this.minScore)
      .sort((a, b) => b.score - a.score);

    const historical = distinctPlaces(accepted.filter(isHistorical)).map(
      toCandidate,
    );
    const hints = historical.length ? { historical } : undefined;

    // `match: false` included on purpose: never picked by this tier, but
    // exactly what a reader with the event's context can recognise.
    const considered = distinctPlaces(
      candidates
        .filter(hasPoint)
        .filter((c) => c.score >= this.minScore)
        .sort((a, b) => b.score - a.score),
    )
      .slice(0, MAX_CONSIDERED)
      .map(toCandidate);

    const best = pickUnambiguous(accepted);
    if (!best) {
      const places = distinctPlaces(accepted);
      return {
        hit: null,
        considered,
        ...(hints ? { hints } : {}),
        ...(places.length
          ? {
              declined: {
                provider: this.providerName,
                reason: `ambiguous: ${places.length} matched places disagree`,
                candidates: places.map(toCandidate),
              },
            }
          : {}),
      };
    }
    const [lon, lat] = best.repr_point;

    // Tied top-score matches that are a *different place* from the pick are
    // real ambiguity a human should be able to see, not just the winner.
    // Deduped by coordinates: distinct places (however same-named) must all
    // survive; a provider returning a literal duplicate candidate must not.
    const seen = new Set([`${lon},${lat}`]);
    const alternates: GeocodeCandidate[] = [];
    for (const c of accepted) {
      if (c.score !== best.score || samePlace(c, best)) continue;
      const key = `${c.repr_point[0]},${c.repr_point[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      alternates.push(toCandidate(c));
    }

    return {
      hit: {
        lon,
        lat,
        displayName: toCandidate(best).displayName,
        ...(alternates.length ? { alternates } : {}),
      },
      considered,
      ...(hints ? { hints } : {}),
    };
  }

  /** POSTs a single-query reconciliation batch and returns its candidates. */
  private async reconcile(placeName: string): Promise<WhgCandidate[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(WHG_RECONCILE_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
        body: JSON.stringify({
          queries: { [QUERY_KEY]: { query: placeName } },
          unlocated: false,
        }),
      });
    } catch (error) {
      // Transport failures are the provider's problem, not the place's —
      // throw so the job retries rather than caching a miss that was never
      // a miss.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`whg geocoder request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`whg geocoder returned ${response.status}`);
    }

    const json = (await response.json()) as WhgReconcileResponse;
    return json[QUERY_KEY]?.result ?? [];
  }

  private async respectRateLimit(): Promise<void> {
    const canProceed = await this.rateLimiter.isAllowedForSource("whg")("whg");
    if (!canProceed) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs));
    }
  }
}
