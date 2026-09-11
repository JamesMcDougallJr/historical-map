export interface GeocodeHit {
  lon: number;
  lat: number;
  /** The provider's own label for what it matched, for spot-checking. */
  displayName: string;
}

/**
 * Resolves a place name to coordinates.
 *
 * Returning `null` means "asked and found nothing" — a normal outcome that
 * sends the event to review. Throwing means the provider itself failed, which
 * is retryable. Conflating the two would either retry unresolvable places
 * forever or permanently drop events over a transient outage.
 */
export interface Geocoder {
  readonly providerName: string;
  geocode(placeName: string): Promise<GeocodeHit | null>;
}

export const GEOCODER = "GEOCODER";

/**
 * Cache key for a place name. Aggressive on purpose: the same place is written
 * many ways across a corpus ("Salt Lake Valley", "the Salt Lake valley,"), and
 * every distinct spelling that reaches the provider costs a request against a
 * 1-per-second budget.
 */
export function normalizePlaceName(placeName: string): string {
  return placeName
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^\p{L}\p{N}\s,-]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/,\s*$/, "")
    .trim();
}
