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
  /** Short human label: a PLACE name (e.g. "Cafedu", "Karlín"), or "home" /
   * "you". Deliberately the venue, NOT the errand title — the day moves through
   * places, and two errands at one venue share a single anchor. */
  label: string;
  coords: Coords;
  kind: DayAnchorKind;
  /** The place's photo (when it came from a resolved venue), for richer chips. */
  photoUrl?: string;
}

/**
 * A short, chip-sized place label from an errand's freeform address. Venue names
 * ("Cafedu") have no comma and pass through; a full street address
 * ("Pekařova 859/12, Prague, Czechia") collapses to its leading segment so the
 * chip reads as the place, not a paragraph.
 */
function shortPlaceLabel(address?: string): string | null {
  const a = (address ?? '').trim();
  if (!a) return null;
  return a.split(',')[0]!.trim() || null;
}

/** Stable key that groups errands at the SAME place: a shared Google placeId, or
 *  failing that the rounded coordinate (~11 m). Lets duplicates collapse. */
function placeKey(e: Pick<Errand, 'placeId' | 'latitude' | 'longitude'>): string {
  if (e.placeId) return `id:${e.placeId}`;
  return `xy:${e.latitude!.toFixed(4)},${e.longitude!.toFixed(4)}`;
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

  // Collapse multiple errands at one venue into a single place anchor (keyed by
  // placeId / rounded coords), so e.g. two errands at "Cafedu" surface as ONE
  // chip. Backfill a photo from whichever same-place errand has one.
  const byPlace = new Map<string, DayAnchor>();
  for (const e of errands) {
    if (excludeErrandId && e.id === excludeErrandId) continue;
    if (date && e.date !== date) continue;
    if (e.done) continue;
    if (e.latitude == null || e.longitude == null) continue;
    const key = placeKey(e);
    const existing = byPlace.get(key);
    if (existing) {
      if (!existing.photoUrl && e.photoUrl) existing.photoUrl = e.photoUrl;
      continue;
    }
    byPlace.set(key, {
      id: e.id,
      label: shortPlaceLabel(e.address) ?? e.title,
      coords: { latitude: e.latitude, longitude: e.longitude },
      kind: 'errand',
      photoUrl: e.photoUrl,
    });
  }
  for (const a of byPlace.values()) anchors.push(a);

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
