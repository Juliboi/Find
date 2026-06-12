/**
 * Auto-place resolution — Phase 6a.
 *
 * When the user marks an errand "Diem picks the spot" (`autoPlace`), the planner
 * historically only got the prose hint "find a {category} on the way" and a
 * grounded model guessed the venue — exactly the costly, unreliable behaviour
 * the errand-first pivot wants to move away from. Instead we resolve the
 * category to a CONCRETE, real venue on the client *before* planning, using the
 * day's start→end corridor as route context so `find-places` ranks candidates by
 * least detour ("on the way"). The chosen place is then fed to the planner as a
 * fixed stop.
 *
 * This is a pre-pass with no grounding and no model call — it reuses the existing
 * `find-places` lookup (cached, cheap). Resolution is best-effort: any errand we
 * can't resolve is left for the caller to fall back to the old prose hint.
 */
import { findPlaces, type Coords, type NearbyPlace } from '@/lib/places';

export interface AutoPlaceItem {
  id: string;
  /** The search category, e.g. "pharmacy", "coffee". */
  query: string;
}

/** Average of the supplied coordinates, or null when there are none. */
function centroid(points: Coords[]): Coords | null {
  if (points.length === 0) return null;
  const sum = points.reduce(
    (acc, p) => ({
      latitude: acc.latitude + p.latitude,
      longitude: acc.longitude + p.longitude,
    }),
    { latitude: 0, longitude: 0 },
  );
  return {
    latitude: sum.latitude / points.length,
    longitude: sum.longitude / points.length,
  };
}

/**
 * Resolves each auto-place errand to its best-fit venue. Searches around the
 * centroid of the day's known points and ranks by least detour along the
 * start→end corridor. Returns a map of errandId → chosen place; errands that
 * resolve to nothing are simply absent from the map.
 */
export async function resolveAutoPlaceVenues(opts: {
  items: AutoPlaceItem[];
  /** The day's known points (start, end, home, located errands) — seeds the
   * search center. */
  anchors: Coords[];
  /** Route corridor for least-detour ranking (day start). */
  start: Coords | null;
  /** Route corridor for least-detour ranking (day end). */
  end: Coords | null;
}): Promise<Map<string, NearbyPlace>> {
  const { items, anchors, start, end } = opts;
  const out = new Map<string, NearbyPlace>();
  if (items.length === 0) return out;

  // Anchor the search on the day's geography; without any known point there's
  // nothing meaningful to search around, so leave everything unresolved.
  const center = centroid(anchors) ?? start ?? end;
  if (!center) return out;

  const route = start || end ? { prev: start ?? undefined, next: end ?? undefined } : undefined;

  await Promise.all(
    items.map(async (it) => {
      const q = it.query.trim();
      if (!q) return;
      try {
        const res = await findPlaces(q, q, center, route, { limit: 6 });
        const best = res.places[0];
        if (best) out.set(it.id, best);
      } catch {
        // best-effort: caller falls back to the prose hint
      }
    }),
  );
  return out;
}
