import { Logger } from "@nestjs/common";
import type { GeocodeHit, Geocoder } from "./geocoder.interface";

/**
 * Tries each provider in order until one resolves the place.
 *
 * A provider returning `null` ("asked, found nothing") advances to the next
 * provider — that is the whole point of a fallback chain. A provider
 * *throwing* also advances, on the theory that one provider's outage
 * shouldn't stall publishing when a second, independent provider is healthy;
 * only if every provider throws does this rethrow (the last error), so a
 * total outage still surfaces as retryable rather than caching a false miss.
 */
export class FallbackGeocoder implements Geocoder {
  readonly providerName = "fallback";

  private readonly logger = new Logger(FallbackGeocoder.name);

  constructor(private readonly providers: readonly Geocoder[]) {
    if (providers.length === 0) {
      throw new Error("FallbackGeocoder requires at least one provider");
    }
  }

  async geocode(placeName: string): Promise<GeocodeHit | null> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        const hit = await provider.geocode(placeName);
        if (hit) return { ...hit, provider: hit.provider ?? provider.providerName };
        // A clean miss — move on to the next provider, no error to track.
        lastError = undefined;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `${provider.providerName} failed for "${placeName}", trying next provider: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (lastError !== undefined) throw lastError;
    return null;
  }
}
