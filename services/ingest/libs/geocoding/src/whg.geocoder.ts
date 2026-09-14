import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { GeocodeHit, Geocoder } from "./geocoder.interface";

const WHG_RECONCILE_URL = "https://whgazetteer.org/reconcile";
const WHG_ENTITY_BASE_URL = "https://whgazetteer.org/entity";
const REQUEST_TIMEOUT_MS = 15_000;

/** Shape of one candidate in a WHG `/reconcile` response, per docs.whgazetteer.org. */
export interface WhgCandidate {
  id: string; // e.g. "place:169687"
  name: string;
  score: number; // 0-100
  match: boolean;
  description?: string;
}

/**
 * World Historical Gazetteer — tried before Nominatim (see `FallbackGeocoder`
 * in `geocoding.module.ts`) because it indexes historical place names and
 * variants rather than only what a place is called today. This is the fix
 * for the failure mode `NominatimGeocoder` documents: "Sutter's Mill" →
 * modern Idaho instead of 1848 Coloma, California.
 *
 * Two-step lookup, both against https://whgazetteer.org:
 *  1. `POST /reconcile` — free-text query, returns scored candidate matches
 *     but *not* coordinates.
 *  2. `GET /entity/{id}/api` — the winning candidate's full LPF feature,
 *     which carries `geometry.coordinates` as `[lon, lat]`.
 *
 * Requires a `WHG_API_TOKEN` (free, from a WHG account's Profile page).
 * Daily quota is 5,000 requests, charged per HTTP request — so this lookup
 * costs 2 against that budget, same as Nominatim's cost model reasoning: the
 * geocode_cache is what makes a corpus-sized run affordable.
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

    // TODO: implement.
    //
    // 1. await this.respectRateLimit()
    // 2. const candidates = await this.reconcile(placeName)
    // 3. Pick the best candidate — highest `score`, but discard anything
    //    below `this.minScore` (a low-confidence match is worse than no
    //    match: it publishes a wrong pin instead of sending the event to
    //    review). If nothing clears the bar, return null.
    // 4. const coords = await this.fetchEntityCoordinates(best.id)
    // 5. If the entity has no geometry (WHG allows places without a
    //    centroid — see "geometry recovery" in the docs), return null rather
    //    than than a hit with fabricated coordinates.
    // 6. return { lon, lat, displayName: best.name }
    void placeName;
    throw new Error("WhgGeocoder.geocode is not implemented yet");
  }

  /** POSTs a single-query reconciliation batch and returns its candidates. */
  private async reconcile(placeName: string): Promise<WhgCandidate[]> {
    void placeName;
    throw new Error("WhgGeocoder.reconcile is not implemented yet");
  }

  /** Reads `geometry.coordinates` off the winning candidate's Entity API record. */
  private async fetchEntityCoordinates(
    entityId: string,
  ): Promise<{ lon: number; lat: number } | null> {
    void entityId;
    throw new Error("WhgGeocoder.fetchEntityCoordinates is not implemented yet");
  }

  private async respectRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}
