// Geo helpers for EventGroup — deciding whether a group's members are tight
// enough to render as a connected path vs. a plain filter is a later phase's
// concern; this file only provides the pure distance calculation it needs.

export const GROUP_CONNECTIVE_THRESHOLD_KM = 25;

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Haversine great-circle distance in km between two [longitude, latitude] pairs. */
function haversineDistanceKm(
  [lon1, lat1]: [number, number],
  [lon2, lat2]: [number, number],
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Maximum haversine distance in km over all pairs of [longitude, latitude]
 * coordinates. Used to decide whether a group's members are geographically
 * tight enough to render as a connected path vs. a plain filter.
 */
export function maxPairwiseDistanceKm(coords: [number, number][]): number {
  if (coords.length <= 1) return 0;

  let max = 0;
  for (let i = 0; i < coords.length; i++) {
    for (let j = i + 1; j < coords.length; j++) {
      const distance = haversineDistanceKm(coords[i]!, coords[j]!);
      if (distance > max) max = distance;
    }
  }
  return max;
}
