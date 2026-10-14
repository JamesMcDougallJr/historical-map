import { Logger } from "@nestjs/common";
import type {
  GeocodeDecline,
  GeocodeHints,
  GeocodeHit,
  GeocodeOutcome,
  Geocoder,
} from "./geocoder.interface";

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
    return (await this.lookup(placeName)).hit;
  }

  /**
   * Each tier's hints are passed to the tiers after it, so a later, less
   * historically-aware provider can be held to what an earlier one learned.
   * When every tier comes up empty, their decline reasons are combined: that
   * is what `geocode_cache` records and `geocode:review` shows for a place
   * with no pin.
   */
  async lookup(placeName: string): Promise<GeocodeOutcome> {
    let lastError: unknown;
    let hints: GeocodeHints = {};
    const declines: GeocodeDecline[] = [];

    for (const provider of this.providers) {
      try {
        const outcome = provider.lookup
          ? await provider.lookup(placeName, hints)
          : { hit: await provider.geocode(placeName, hints) };
        if (outcome.hit) {
          return {
            hit: {
              ...outcome.hit,
              provider: outcome.hit.provider ?? provider.providerName,
            },
          };
        }
        if (outcome.hints?.historical?.length) {
          hints = {
            historical: [
              ...(hints.historical ?? []),
              ...outcome.hints.historical,
            ],
          };
        }
        if (outcome.declined) declines.push(outcome.declined);
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
    if (declines.length === 0) return { hit: null };
    return {
      hit: null,
      declined: {
        provider: this.providerName,
        reason: declines.map((d) => `${d.provider}: ${d.reason}`).join("; "),
        candidates: declines.flatMap((d) => d.candidates),
      },
    };
  }
}
