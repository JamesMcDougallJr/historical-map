import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { GeocodeHit, Geocoder } from "./geocoder.interface";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * OSM categories a historical place is never in. Everything else is allowed,
 * so this is a denylist of obvious junk rather than an attempt to enumerate
 * what a "place" is.
 */
const REJECTED_CATEGORIES = new Set([
  "highway",
  "building",
  "shop",
  "amenity",
  "office",
  "craft",
  "healthcare",
  "railway",
  "man_made",
]);

/**
 * OpenStreetMap Nominatim.
 *
 * **Its usage policy is a hard constraint, not a suggestion**: at most one
 * request per second, and a genuine identifying User-Agent. Exceeding either
 * gets an IP blocked, and this is free infrastructure run for the public good.
 * The one-request-per-second spacing below is enforced in-process and is why
 * the cache matters so much — it is the only thing that makes a corpus of
 * thousands of events tractable.
 *
 * **Known limitation: this is a *modern* gazetteer.** It resolves the place
 * that bears a name today, which for a 19th-century document may be the wrong
 * place, or a place that did not exist. Historical names that have since been
 * reused are the dangerous case, because the result looks perfectly plausible.
 * A gazetteer with historical coverage would be the real fix; until then
 * `displayName` is stored precisely so a wrong match can be spotted.
 */
@Injectable()
export class NominatimGeocoder implements Geocoder {
  readonly providerName = "nominatim";

  private readonly logger = new Logger(NominatimGeocoder.name);
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly countryCodes: string | undefined;
  private lastRequestAt = 0;

  constructor(config: ConfigService) {
    this.userAgent =
      config.get<string>("GEOCODER_USER_AGENT") ??
      "historical-map-ingest/0.1 (+https://github.com/JamesMcDougallJr/historical-map)";
    this.minIntervalMs = config.get<number>("GEOCODER_MIN_INTERVAL_MS") ?? 1100;
    // Narrowing the search region is the cheapest accuracy win available, but
    // it is per-corpus knowledge, so it stays configuration rather than a
    // hardcoded assumption about what any source contains.
    this.countryCodes = config.get<string>("GEOCODER_COUNTRY_CODES");
  }

  async geocode(placeName: string): Promise<GeocodeHit | null> {
    await this.respectRateLimit();

    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", placeName);
    url.searchParams.set("format", "jsonv2");
    // More than one candidate, so a plausible result further down the list can
    // be chosen after the junk categories are filtered out.
    url.searchParams.set("limit", "5");
    url.searchParams.set("addressdetails", "0");
    if (this.countryCodes) {
      url.searchParams.set("countrycodes", this.countryCodes);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      });
    } catch (error) {
      // Transport failures are the provider's problem, not the place's — throw
      // so the job retries rather than caching a miss that was never a miss.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`geocoder request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`geocoder returned ${response.status}`);
    }

    const results = (await response.json()) as Array<{
      lon?: string;
      lat?: string;
      display_name?: string;
      category?: string;
    }>;

    // A historical place is a settlement, region, natural feature or historic
    // site — never a road, shop or office. Without this filter "Salt Lake
    // Valley" matches a street called Levoy Drive, which is both wrong and
    // wrong in a way that looks perfectly plausible on a map.
    const usable = results.find(
      (r) =>
        r.lon && r.lat && (!r.category || !REJECTED_CATEGORIES.has(r.category)),
    );
    if (!usable?.lon || !usable?.lat) return null;

    const lon = Number(usable.lon);
    const lat = Number(usable.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

    return { lon, lat, displayName: usable.display_name ?? placeName };
  }

  private async respectRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}
