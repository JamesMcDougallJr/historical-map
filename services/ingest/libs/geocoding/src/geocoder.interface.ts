export interface GeocodeCandidate {
  lon: number;
  lat: number;
  displayName: string;
}

export interface GeocodeHit {
  lon: number;
  lat: number;
  /** The provider's own label for what it matched, for spot-checking. */
  displayName: string;
  /**
   * Which provider actually produced this hit. Only meaningful when a
   * `Geocoder` delegates to others (see `FallbackGeocoder`) — a single
   * provider's own hits are attributed via its `providerName` instead, so
   * this is left unset there.
   */
  provider?: string;
  /**
   * Other candidates the provider considered equally confident to this hit
   * (tied top score/importance), excluding the hit itself. A human review
   * tool needs these to know a pick was ambiguous — auto-selection still
   * always takes the first — so every `Geocoder` implementation must
   * populate this whenever its own confidence signal reports a tie, even
   * though nothing consumes it yet.
   */
  alternates?: GeocodeCandidate[];
}

/**
 * What one tier learned that a later tier should use, even when it declined
 * to answer.
 */
export interface GeocodeHints {
  /**
   * Where historical gazetteers put this name. When present, a modern match
   * must lie near one of them — a modern place far from every historical
   * record of the name is its modern namesake ("Tenochtitlan" → a town in
   * Veracruz), the failure a historical gazetteer exists to catch.
   */
  historical?: GeocodeCandidate[];
}

/** A tier found candidates but did not trust any of them enough to pin. */
export interface GeocodeDecline {
  provider: string;
  reason: string;
  candidates: GeocodeCandidate[];
}

/**
 * The full answer from one tier. `hit: null` with a `declined` means "found
 * something, not confident" — distinct from a plain miss — and it is what
 * sends an event to review instead of onto the wrong spot on the map.
 */
export interface GeocodeOutcome {
  hit: GeocodeHit | null;
  hints?: GeocodeHints;
  declined?: GeocodeDecline;
  /**
   * Every plausible place a tier looked at, including ones it would never
   * pick on its own — WHG's `match: false` records among them. "Tepeyacac"'s
   * right answer, Tepeyac Hill, only ever appears here. This is the pool a
   * context-aware step chooses from.
   */
  considered?: GeocodeCandidate[];
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
  geocode(placeName: string, hints?: GeocodeHints): Promise<GeocodeHit | null>;
  /**
   * The same lookup, keeping what `geocode` throws away: hints for later
   * tiers and the reason for a decline. Optional — `FallbackGeocoder` uses it
   * when present and `geocode` otherwise.
   */
  lookup?(placeName: string, hints?: GeocodeHints): Promise<GeocodeOutcome>;
}

export const GEOCODER = "GEOCODER";

/** Great-circle distance in km between two points. */
export function distanceKm(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

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
