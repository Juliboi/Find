/**
 * Day anchors — the places a user's day is "moving through" on a given date:
 * their other located errands that day, plus (optionally) home and their current
 * position. A discovered candidate's closeness to these anchors is the routing
 * signal the discover step surfaces ("≈12 min from Dentist") so the user picks a
 * place that fits the day, rather than trusting an opaque proximity rank.
 *
 * Distances are estimated client-side via {@link estimateTravel} (free, instant)
 * — no Distance Matrix calls. Good enough for a "does this fit?" cue.
 */
import type { Coords } from '@/lib/places';
import type { Errand } from '@/store/useErrandsStore';
import type { LocationPin } from '@/store/useHomeStore';
import { estimateTravel, type TravelEstimate } from '@/lib/travel';

export type DayAnchorKind = 'current' | 'home' | 'errand';

export interface DayAnchor {
  id: string;
  /** Short human label: an errand title, or "home" / "you". */
  label: string;
  coords: Coords;
  kind: DayAnchorKind;
}

/**
 * Gathers the day's anchors for `date`. Errand anchors are the real "stops"
 * (other located, not-done errands on that day); home and current position are
 * included when supplied so callers like the map can render them too. The
 * errand being created/edited is excluded via `excludeErrandId`.
 */
export function collectDayAnchors(opts: {
  errands: Errand[];
  date: string | null;
  home?: LocationPin | null;
  current?: Coords | null;
  excludeErrandId?: string;
}): DayAnchor[] {
  const { errands, date, home, current, excludeErrandId } = opts;
  const anchors: DayAnchor[] = [];

  if (current) {
    anchors.push({ id: 'current', label: 'you', coords: current, kind: 'current' });
  }

  for (const e of errands) {
    if (excludeErrandId && e.id === excludeErrandId) continue;
    if (date && e.date !== date) continue;
    if (e.done) continue;
    if (e.latitude == null || e.longitude == null) continue;
    anchors.push({
      id: e.id,
      label: e.title,
      coords: { latitude: e.latitude, longitude: e.longitude },
      kind: 'errand',
    });
  }

  if (home) {
    anchors.push({
      id: 'home',
      label: 'home',
      coords: { latitude: home.latitude, longitude: home.longitude },
      kind: 'home',
    });
  }

  return anchors;
}

export interface NearestAnchor {
  anchor: DayAnchor;
  estimate: TravelEstimate;
}

/** The closest anchor to `place` by estimated travel, or null if there are none. */
export function nearestAnchor(place: Coords, anchors: DayAnchor[]): NearestAnchor | null {
  let best: NearestAnchor | null = null;
  for (const a of anchors) {
    const estimate = estimateTravel(place, a.coords);
    if (!best || estimate.distanceM < best.estimate.distanceM) {
      best = { anchor: a, estimate };
    }
  }
  return best;
}
