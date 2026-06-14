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
  /** The brain's neighbourhood for this item ("Karlín, Prague"), when known.
   * When set, the search centres on that area instead of the day's centroid, so
   * a chain resolves to the branch in the RIGHT part of town. */
  area?: string;
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
 * Resolves each auto-place errand to its best-fit venues. Searches around the
 * centroid of the day's known points and ranks by least detour along the
 * start→end corridor. Returns a map of errandId → RANKED candidate list (best
 * first): the caller anchors the day on `[0]` and keeps the rest as swappable
 * ALTERNATIVES surfaced on the itinerary card. Errands that resolve to nothing
 * are simply absent from the map.
 */
export async function resolveAutoPlaceVenues(opts: {
  items: AutoPlaceItem[];
  /** The day's known points (start, end, home, located errands) — the fallback
   * search center when an item has no area, and the seed for geocoding areas. */
  anchors: Coords[];
  /** Route corridor for least-detour ranking (day start). */
  start: Coords | null;
  /** Route corridor for least-detour ranking (day end). */
  end: Coords | null;
  /** How many ranked candidates to keep per errand (best + alternatives). */
  limit?: number;
}): Promise<Map<string, NearbyPlace[]>> {
  const { items, anchors, start, end } = opts;
  const limit = Math.min(10, Math.max(1, Math.round(opts.limit ?? 6)));
  const out = new Map<string, NearbyPlace[]>();
  if (items.length === 0) return out;

  // The day's average point: the fallback center for items with no area, and the
  // seed used to geocode area names. Without any known point there's nothing to
  // search around, so leave everything unresolved.
  const dayCenter = centroid(anchors) ?? start ?? end;

  // Geocode each DISTINCT neighbourhood the brain named into its own search
  // center (cheap + cached via findPlaces). This is what makes "Max Fitness gym,
  // Karlín" resolve to the Karlín-area branch instead of whichever branch is
  // nearest the day's centroid — the "gym in Holešovice not Karlín" fix.
  const areaCenters = new Map<string, Coords | null>();
  const distinctAreas = Array.from(
    new Set(items.map((it) => it.area?.trim()).filter((a): a is string => !!a)),
  );
  await Promise.all(
    distinctAreas.map(async (area) => {
      try {
        const res = await findPlaces(area, area, dayCenter ?? undefined, undefined, {
          limit: 1,
        });
        const top = res.places[0];
        areaCenters.set(
          area,
          top ? { latitude: top.latitude, longitude: top.longitude } : null,
        );
      } catch {
        areaCenters.set(area, null);
      }
    }),
  );

  const corridor =
    start || end ? { prev: start ?? undefined, next: end ?? undefined } : undefined;

  await Promise.all(
    items.map(async (it) => {
      const q = it.query.trim();
      if (!q) return;
      const area = it.area?.trim();
      const areaCenter = area ? areaCenters.get(area) ?? null : null;
      // Center on the brain's neighbourhood when we resolved one; else the day's
      // centroid. Without any center there's nothing to search around.
      const center = areaCenter ?? dayCenter;
      if (!center) return;
      // With an explicit area center, rank by proximity to it (tight radius, no
      // start→end corridor) so the area wins. Otherwise keep the corridor's
      // least-detour ranking around the day's centroid.
      const route = areaCenter ? undefined : corridor;
      const searchOpts = areaCenter ? { limit, radiusM: 4000 } : { limit };
      try {
        const res = await findPlaces(q, q, center, route, searchOpts);
        const candidates = res.places.slice(0, limit);
        if (candidates.length) out.set(it.id, candidates);
      } catch {
        // best-effort: caller falls back to the prose hint
      }
    }),
  );
  return out;
}
