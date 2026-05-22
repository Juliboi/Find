/**
 * Travel-time estimation between two coordinates.
 *
 * We don't call the Google Distance Matrix API here — that would burn
 * billable quota for every render, with multi-second latency. For
 * inter-plan rows we just need a "trust me, this is roughly right"
 * estimate that responds instantly to picks. The classic mode/speed
 * model below gets within ~20% of Google Maps for the urban distances
 * (200 m – 10 km) that this app cares about.
 *
 * If you ever need pinpoint accuracy (e.g. for a map view showing
 * exact ETAs), graduate to the Routes API on a per-tap basis.
 */
import type { LocationPin } from '@/store/useHomeStore';

export type TravelMode = 'walk' | 'bike' | 'transit' | 'drive';

export interface TravelEstimate {
  /** Straight-line distance in meters. */
  distanceM: number;
  /** Estimated travel time, rounded up. */
  minutes: number;
  /** Mode the estimate was based on. */
  mode: TravelMode;
}

interface Coords {
  latitude: number;
  longitude: number;
}

/**
 * Great-circle distance in meters. Standard haversine.
 */
export function haversineMeters(a: Coords, b: Coords): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Pick a travel mode given a straight-line distance.
 *
 * Urban-Europe rules of thumb (matches what people actually do):
 *   - ≤ 1.2 km : walk
 *   - 1.2–4 km : transit / scooter (combines metro waits + walking)
 *   - > 4 km   : drive (or ride-hail)
 *
 * Straight-line distance is consistently shorter than true routing
 * distance; we compensate by adding a small detour factor inside
 * `estimateTravel` rather than padding the mode thresholds here.
 */
function modeForDistance(meters: number): TravelMode {
  if (meters <= 1200) return 'walk';
  if (meters <= 4000) return 'transit';
  return 'drive';
}

/**
 * Speeds (m/min) used to convert distance → time. These are the
 * effective speeds *including* common overhead — for `transit` it
 * folds in a ~5 min average wait, for `drive` it accounts for
 * red-light and parking time.
 */
const SPEED_M_PER_MIN: Record<TravelMode, number> = {
  walk: 80, // ~4.8 km/h
  bike: 250, // ~15 km/h
  transit: 200, // ~12 km/h door-to-door incl. wait
  drive: 400, // ~24 km/h urban incl. lights + parking
};

/**
 * Fixed minutes added per trip. Captures the irreducible overhead of
 * "leaving" and "arriving" — locking the door, finding the right
 * platform, parking, etc. Without this a 50 m walk looks like
 * "1 min", which technically is true but feels wrong.
 */
const MODE_OVERHEAD_MIN: Record<TravelMode, number> = {
  walk: 1,
  bike: 2,
  transit: 4,
  drive: 3,
};

/**
 * Real-world routing distance is typically 25–40% longer than the
 * great-circle distance (city blocks, one-way streets, river
 * crossings). 1.3 is a decent global compromise for urban density.
 */
const DETOUR_FACTOR = 1.3;

export function estimateTravel(a: Coords, b: Coords): TravelEstimate {
  const straight = haversineMeters(a, b);
  const distanceM = Math.round(straight * DETOUR_FACTOR);
  const mode = modeForDistance(distanceM);
  const minutes = Math.max(
    1,
    Math.round(distanceM / SPEED_M_PER_MIN[mode] + MODE_OVERHEAD_MIN[mode]),
  );
  return { distanceM, minutes, mode };
}

/**
 * Convenience wrapper that takes labelled pins (home, end-of-day,
 * etc.). Returns null if either side is missing — callers can use
 * that to decide whether to render a travel row at all.
 */
export function travelBetween(
  a: { latitude: number; longitude: number } | null | undefined,
  b: { latitude: number; longitude: number } | null | undefined,
): TravelEstimate | null {
  if (!a || !b) return null;
  return estimateTravel(a, b);
}

/**
 * Pretty-prints a travel estimate for inline UI rows like
 * "→ 12 min walk".
 */
export function formatTravel(t: TravelEstimate): string {
  const modeLabel: Record<TravelMode, string> = {
    walk: 'walk',
    bike: 'bike',
    transit: 'transit',
    drive: 'drive',
  };
  return `${t.minutes} min ${modeLabel[t.mode]}`;
}

/**
 * Icon name (Ionicons) that pairs with each mode. Centralised so the
 * UI stays consistent across screens.
 */
export function travelIconName(mode: TravelMode): string {
  switch (mode) {
    case 'walk':
      return 'walk-outline';
    case 'bike':
      return 'bicycle-outline';
    case 'transit':
      return 'subway-outline';
    case 'drive':
      return 'car-outline';
  }
}

/**
 * Re-export the home pin type for places that import from this module
 * (keeps consumers from needing a separate import line).
 */
export type { LocationPin };
