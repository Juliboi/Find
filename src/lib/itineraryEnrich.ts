/**
 * Post-grounding enrichment pass.
 *
 * The single-call grounded planner (Gemini + Google Search) is great at
 * picking the right LOCAL venues but cannot return Google Places assets:
 * photo URLs, exact rating counts, opening-hours strings, canonical Place
 * coordinates. This module backfills that data by calling the existing
 * `find-places` Supabase edge function once per unique venue, using the
 * model's (name, coords) as the lookup anchor.
 *
 * Why through `find-places` instead of a dedicated `enrich-place` function:
 *   - It already has a `GOOGLE_PLACES_API_KEY` configured server-side, so
 *     this works with zero new credentials and zero edge-function changes.
 *   - It already handles photo URL resolution, rating normalization, and
 *     opening-hours mapping. We get all those benefits "for free".
 *
 * Caveats while this is experimental:
 *   - It is a CLIENT-SIDE pass. Once we commit to the grounded architecture
 *     this whole module should be deleted and the same logic should run
 *     inline inside whichever edge function owns planning.
 *   - It costs roughly one `find-places` call per unique venue per plan
 *     (a few cents at most), but no caching — re-planning the same day
 *     re-fires every lookup.
 */

import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { Itinerary, ItineraryPlace } from '@/types/itinerary';

interface EnrichedRecord {
  name: string;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
  photoUrl: string | null;
  openNow: boolean | null;
  latitude: number;
  longitude: number;
}

export interface EnrichItemTrace {
  query: string;
  modelCoords: { latitude: number; longitude: number };
  matchedName?: string;
  matchedAddress?: string;
  hasPhoto: boolean;
  rating?: number;
  ratingCount?: number;
  outcome: 'enriched' | 'no_match' | 'name_mismatch' | 'no_coords' | 'error';
  detail?: string;
}

export interface EnrichStats {
  /** Whether the enrichment pass ran. */
  ran: boolean;
  /** Why it was a no-op when `ran` is false. */
  reason?: string;
  /** Unique venues considered. */
  total: number;
  /** Venues for which we found a Google Places match. */
  enriched: number;
  /** Per-venue trace. */
  items: EnrichItemTrace[];
}

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/** Loose name match: equality, containment, or token Jaccard ≥ 0.5. */
function nameSimilar(a: string, b: string): boolean {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && intersection / union >= 0.5;
}

async function fetchEnrichedRecord(
  query: string,
  lat: number,
  lon: number,
): Promise<EnrichedRecord | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  try {
    const { data, error } = await supabase.functions.invoke('find-places', {
      body: {
        queries: [query],
        intent: query,
        latitude: lat,
        longitude: lon,
        // Tight radius — the model's coords should be within a few hundred
        // metres of the real venue. Wider would risk pulling in a popular
        // doppelgänger somewhere else in the city.
        radiusM: 1500,
        limit: 3,
      },
    });
    if (error) return null;
    const places = Array.isArray((data as any)?.places)
      ? ((data as any).places as any[])
      : [];
    if (places.length === 0) return null;
    const match =
      places.find((p) => nameSimilar(p?.name ?? '', query)) ?? places[0];
    if (
      typeof match?.latitude !== 'number' ||
      typeof match?.longitude !== 'number' ||
      typeof match?.name !== 'string'
    ) {
      return null;
    }
    return {
      name: match.name,
      address: typeof match.address === 'string' ? match.address : null,
      rating: typeof match.rating === 'number' ? match.rating : null,
      ratingCount:
        typeof match.ratingCount === 'number' ? match.ratingCount : null,
      photoUrl: typeof match.photoUrl === 'string' ? match.photoUrl : null,
      openNow: typeof match.openNow === 'boolean' ? match.openNow : null,
      latitude: match.latitude,
      longitude: match.longitude,
    };
  } catch {
    return null;
  }
}

function openStatusFromBool(b: boolean | null): string | undefined {
  if (b === true) return 'Open now';
  if (b === false) return 'Closed now';
  return undefined;
}

/**
 * Walks the itinerary, finds unique venues with coords, looks each one up
 * via `find-places`, and merges Google Places fields back into the items
 * that share that venue.
 */
export async function enrichItineraryPlaces(
  itinerary: Itinerary,
): Promise<{ itinerary: Itinerary; stats: EnrichStats }> {
  if (!isSupabaseConfigured || !supabase) {
    return {
      itinerary,
      stats: {
        ran: false,
        reason: 'no_supabase',
        total: 0,
        enriched: 0,
        items: [],
      },
    };
  }

  interface VenueEntry {
    name: string;
    lat: number;
    lon: number;
  }
  const venueByKey = new Map<string, VenueEntry>();
  const keyOf = (name: string, c: { latitude: number; longitude: number }) =>
    `${normaliseName(name)}|${c.latitude.toFixed(3)},${c.longitude.toFixed(3)}`;

  for (const section of itinerary.sections) {
    for (const item of section.items) {
      const p = item.place;
      if (!p?.name || !p.coords) continue;
      const k = keyOf(p.name, p.coords);
      if (!venueByKey.has(k)) {
        venueByKey.set(k, {
          name: p.name,
          lat: p.coords.latitude,
          lon: p.coords.longitude,
        });
      }
    }
  }

  if (venueByKey.size === 0) {
    return {
      itinerary,
      stats: { ran: true, total: 0, enriched: 0, items: [] },
    };
  }

  const enrichments = new Map<string, EnrichedRecord>();
  const traces: EnrichItemTrace[] = [];

  await Promise.all(
    Array.from(venueByKey.entries()).map(async ([key, v]) => {
      const trace: EnrichItemTrace = {
        query: v.name,
        modelCoords: { latitude: v.lat, longitude: v.lon },
        hasPhoto: false,
        outcome: 'no_match',
      };
      traces.push(trace);

      const record = await fetchEnrichedRecord(v.name, v.lat, v.lon);
      if (!record) {
        trace.outcome = 'no_match';
        return;
      }
      if (!nameSimilar(record.name, v.name)) {
        trace.outcome = 'name_mismatch';
        trace.matchedName = record.name;
        trace.detail = `top match was "${record.name}", which doesn't look like the model's "${v.name}"`;
        return;
      }
      enrichments.set(key, record);
      trace.outcome = 'enriched';
      trace.matchedName = record.name;
      trace.matchedAddress = record.address ?? undefined;
      trace.hasPhoto = !!record.photoUrl;
      trace.rating = record.rating ?? undefined;
      trace.ratingCount = record.ratingCount ?? undefined;
    }),
  );

  const sections = itinerary.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      const p = item.place;
      if (!p?.name || !p.coords) return item;
      const k = keyOf(p.name, p.coords);
      const r = enrichments.get(k);
      if (!r) return item;
      const newPlace: ItineraryPlace = {
        ...p,
        photoUrl: r.photoUrl ?? p.photoUrl,
        rating: r.rating ?? p.rating,
        ratingCount: r.ratingCount ?? p.ratingCount,
        openStatus: openStatusFromBool(r.openNow) ?? p.openStatus,
        address: r.address ?? p.address,
        // Use the canonical Google coords so map pins land on the real
        // building (the model's coord is usually within ~100m but not
        // pixel-perfect).
        coords: { latitude: r.latitude, longitude: r.longitude },
      };
      return { ...item, place: newPlace };
    }),
  }));

  const stats: EnrichStats = {
    ran: true,
    total: venueByKey.size,
    enriched: enrichments.size,
    items: traces,
  };
  console.log('[enrich]', JSON.stringify(stats, null, 2));

  return { itinerary: { ...itinerary, sections }, stats };
}
