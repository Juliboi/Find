// Shared venue-selection math for the place pickers.
//
// This is the "don't make the day zig-zag" core: given a candidate venue and
// the stops on either side of it, score how well it fits by detour (extra
// travel added to the route), rating, review volume and open/closed state.
//
// It lives here so there is ONE source of truth shared by:
//   - `find-places`        — the interactive place-swap browser, and
//   - `plan-itinerary`     — initial venue resolution while a day is planned.
// Previously only the swap browser was corridor-aware, so a freshly planned
// day could scatter venues across the city; pulling the logic out lets the
// planner pick on-route venues from the start.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

export interface Coords {
  latitude: number;
  longitude: number;
}

/** Minimal venue shape the scorer needs — both functions' richer place
 *  objects (UnifiedPlace / PlaceCandidate) are structurally compatible. */
export interface ScorablePlace {
  /** Straight-line distance (m) from the reference point shown to the user. */
  distanceM: number;
  rating: number | null;
  ratingCount: number | null;
  openNow: boolean | null;
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Geographic midpoint (good enough at city scale; no need for great-circle). */
export function midpoint(a: Coords, b: Coords): Coords {
  return {
    latitude: (a.latitude + b.latitude) / 2,
    longitude: (a.longitude + b.longitude) / 2,
  };
}

export function distM(a: Coords, b: Coords): number {
  return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}

/**
 * Extra meters added to the day by routing through `c` instead of going
 * straight from the previous stop to the next one:
 *
 *   detour = d(prev, c) + d(c, next) − d(prev, next)
 *
 * A venue sitting right on the prev→next line has ~0 detour; one off to the
 * side that forces a backtrack has a large detour. This is the number that
 * actually captures "don't zig-zag". Falls back to a single-sided distance
 * when only one neighbour is known (first/last located stop), and returns
 * null when there's no route context at all.
 */
export function detourMeters(
  prev: Coords | undefined | null,
  next: Coords | undefined | null,
  c: Coords,
): number | null {
  if (prev && next) {
    return Math.max(0, distM(prev, c) + distM(c, next) - distM(prev, next));
  }
  if (prev) return distM(prev, c);
  if (next) return distM(c, next);
  return null;
}

/** Heuristic: does the intent describe a routine, walk-to-it venue (café,
 *  pharmacy, grocery) versus a destination you commit to (gym, museum)? Drives
 *  how sharply the score decays with distance/detour. */
export function isEverydayIntent(intent: string, queries: string[]): boolean {
  const haystack = [intent, ...queries].join(' ').toLowerCase();
  return /\b(restaurant|food|dinner|lunch|brunch|breakfast|cafe|café|coffee|bar|pub|bistro|grocery|pharmacy|bakery|eat|drink|takeout|takeaway)\b/.test(
    haystack,
  );
}

export interface ScoreContext {
  /** 0 = top of the provider's relevance ranking. */
  bestPosition: number;
  place: ScorablePlace;
  radiusM: number;
  everyday: boolean;
  /**
   * Extra meters added to the route by this candidate (see `detourMeters`).
   * When present it REPLACES raw distance as the proximity signal — for a
   * mid-route stop, "doesn't make me backtrack" matters more than "closest
   * to the bias point".
   */
  detourM?: number | null;
}

/**
 * Composite 0..1 fitness score for a candidate venue. Two weighting profiles:
 *
 *   EVERYDAY (restaurant, café, grocery, …) — distance dominates (people don't
 *   cross town for coffee), sharp decay.
 *   DESTINATION (gym, museum, climbing wall, …) — distance matters less,
 *   quality (rating + reviews) weighs more, gentler decay.
 *
 * With route context the proximity term decays on DETOUR (extra meters added
 * to the path) instead of raw distance, and bites faster — even ~600 m of
 * backtrack for an everyday stop is a meaningful zig-zag.
 */
export function scoreCandidate(c: ScoreContext): number {
  const pos = 1 / (1 + c.bestPosition);
  let proximity: number;
  if (c.detourM != null) {
    const detourDecay = c.everyday
      ? Math.max(500, c.radiusM / 6)
      : Math.max(1000, c.radiusM / 3);
    proximity = Math.exp(-(c.detourM / detourDecay));
  } else {
    const decayConstant = c.everyday
      ? Math.max(800, c.radiusM / 4)
      : Math.max(1500, c.radiusM / 2);
    proximity = Math.exp(-(c.place.distanceM / decayConstant));
  }
  const dist = proximity;
  const rating = c.place.rating != null ? c.place.rating / 5 : 0;
  const reviewsRaw = c.place.ratingCount ?? 0;
  const reviews = reviewsRaw > 0 ? Math.min(1, Math.log10(reviewsRaw + 1) / 3) : 0;
  const open = c.place.openNow === false ? 0 : 1;

  if (c.everyday) {
    return dist * 0.55 + pos * 0.1 + rating * 0.2 + reviews * 0.1 + open * 0.05;
  }
  return (
    dist * 0.35 +
    pos * 0.1 +
    rating * 0.3 +
    reviews * 0.15 +
    open * 0.05 +
    // Small bonus for venues with strong rating + many reviews — well-validated
    // far destinations the user might genuinely commit to.
    (rating >= 0.9 && reviewsRaw >= 200 ? 0.05 : 0)
  );
}
