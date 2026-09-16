import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { GeocodeCandidate, GeocodeHit, Geocoder } from "./geocoder.interface";

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
   * `[lon, lat]`, GeoJSON order. Present even when `has_geom` is false —
   * WHG's "geometry recovery" falls back to a representative point, so unlike
   * the two-step Entity-API design this class used to document, no second
   * request is needed to get coordinates.
   */
  repr_point: [number, number];
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
 * Ties among matched candidates (WHG returned two `score: 100, match: true`
 * hits for "Sutters Mill" — one in California, one in Virginia) are broken
 * by taking the first; there is no further signal available to disambiguate,
 * the same limitation `NominatimGeocoder` has for same-named places.
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
  private lastRequestAt = 0;

  constructor(config: ConfigService) {
    this.token = config.get<string>("WHG_API_TOKEN");
    this.userAgent =
      config.get<string>("GEOCODER_USER_AGENT") ??
      "historical-map-ingest/0.1 (+https://github.com/JamesMcDougallJr/historical-map)";
    this.minScore = config.get<number>("WHG_MIN_SCORE") ?? 40;
    this.minIntervalMs = config.get<number>("WHG_MIN_INTERVAL_MS") ?? 250;
  }

  async geocode(placeName: string): Promise<GeocodeHit | null> {
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

    const accepted = candidates
      .filter((c) => c.match && c.score >= this.minScore)
      .sort((a, b) => b.score - a.score);
    const best = accepted[0];
    if (!best) return null;

    const [lon, lat] = best.repr_point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

    // Ties at the top score — e.g. the CA/VA "Sutters Mill" case this file's
    // fixture is built around — are real ambiguity a human should be able to
    // see, not just the auto-picked winner. Deduped by coordinates: distinct
    // places (however same-named) must all survive; a provider returning a
    // literal duplicate candidate must not.
    const seen = new Set([`${lon},${lat}`]);
    const alternates: GeocodeCandidate[] = [];
    for (const c of accepted.slice(1)) {
      if (c.score !== best.score) break;
      const [altLon, altLat] = c.repr_point;
      if (!Number.isFinite(altLon) || !Number.isFinite(altLat)) continue;
      const key = `${altLon},${altLat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      alternates.push({
        lon: altLon,
        lat: altLat,
        displayName: c.description ? `${c.name} (${c.description})` : c.name,
      });
    }

    return {
      lon,
      lat,
      displayName: best.description
        ? `${best.name} (${best.description})`
        : best.name,
      ...(alternates.length ? { alternates } : {}),
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
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}
