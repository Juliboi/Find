/**
 * Bridges a per-errand travel preference (`commute` | `car`) into the routing
 * layer. The backend router (`recompute-itinerary` → `routeAndSchedule`) honours
 * a per-leg lock — `item.travelFromPrev.modeLocked` + `mode` — and otherwise
 * auto-picks by distance, which only ever yields walk or transit (never a car).
 *
 * So a "car" errand needs an explicit `drive` lock on the hop INTO its stop;
 * a "commute" errand needs nothing (the auto-pick already commutes). The lock is
 * later gated by real car availability inside the router (no car / not driving
 * today → it falls back to the auto-pick), so this can never strand the user.
 */
import type { Errand, TravelPref } from '@/store/useErrandsStore';
import type { Itinerary, ItineraryItem } from '@/types/itinerary';
import { haversineMeters } from '@/lib/travel';

/** A located errand and its stop are "the same place" within this radius. */
const MATCH_M = 75;

function norm(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

/** An errand's effective mode: its explicit choice, else the profile default. */
function effectiveMode(errand: Errand, hasCar: boolean): TravelPref {
  return errand.travelMode ?? (hasCar ? 'car' : 'commute');
}

/**
 * Returns a NEW itinerary with a locked `drive` leg on every stop the user wants
 * to reach by car (matched to the planned errands by coordinates, with a title
 * fallback). The input is left untouched so the optimistic pre-route render
 * stays clean. `hasCar` provides the default for errands with no explicit pick.
 */
export function applyErrandTravelModes(
  itin: Itinerary,
  errands: Errand[],
  hasCar: boolean,
): Itinerary {
  const carCoords: { latitude: number; longitude: number }[] = [];
  const carTitles = new Set<string>();
  for (const e of errands) {
    if (effectiveMode(e, hasCar) !== 'car') continue;
    if (e.latitude != null && e.longitude != null) {
      carCoords.push({ latitude: e.latitude, longitude: e.longitude });
    }
    const title = norm(e.title);
    if (title) carTitles.add(title);
  }
  if (carCoords.length === 0 && carTitles.size === 0) return itin;

  const wantsCar = (item: ItineraryItem): boolean => {
    const c = item.place?.coords;
    if (c) {
      for (const cc of carCoords) {
        if (haversineMeters(c, cc) <= MATCH_M) return true;
      }
    }
    if (carTitles.has(norm(item.title))) return true;
    if (item.place?.name && carTitles.has(norm(item.place.name))) return true;
    return false;
  };

  return {
    ...itin,
    sections: itin.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => {
        // Travel/gap blocks have no inbound "arrive here" leg of their own.
        if (item.kind === 'travel' || item.kind === 'gap') return item;
        if (!wantsCar(item)) return item;
        return {
          ...item,
          travelFromPrev: {
            ...(item.travelFromPrev ?? { minutes: 0, estimated: true }),
            mode: 'drive' as const,
            modeLocked: true,
          },
        };
      }),
    })),
  };
}
