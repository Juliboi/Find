/**
 * Lightweight geocoding helpers using OpenStreetMap's Nominatim service.
 *
 * - Free, no API key.
 * - Rate-limited (1 req/sec recommended) — fine for interactive UI.
 * - Requires a descriptive User-Agent per Nominatim's usage policy. React
 *   Native sets one automatically on iOS/Android, but we also add a `Referer`
 *   header so the request looks legitimate.
 *
 * For interactive pickers we prefer Google Places (via the `search-places`
 * edge function) — see `autocompletePlaces` / `resolvePlace` at the bottom of
 * this file — and only fall back to Nominatim when Google isn't configured.
 */

import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { VenueOpeningHours } from '@/types/itinerary';

export interface GeocodeHit {
  /** Pretty display label, e.g. "Pařížská 30, Praha". */
  label: string;
  latitude: number;
  longitude: number;
  /** Stable OSM identifier for de-duplication. */
  osmId: string;
}

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

function commonHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'User-Agent': 'DayFlow/0.1.0 (https://github.com/dayflow)',
  };
}

function compactLabel(raw: any): string {
  const a = raw?.address ?? {};
  const street =
    a.road || a.pedestrian || a.footway || a.cycleway || a.path || '';
  const number = a.house_number ?? '';
  const city = a.city || a.town || a.village || a.municipality || '';
  const country = a.country || '';
  const parts = [
    street && number ? `${street} ${number}` : street,
    city,
    country,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : (raw?.display_name as string) ?? 'Unknown';
}

/**
 * Searches addresses worldwide matching `query`. Returns up to `limit` hits
 * ordered by Nominatim's importance ranking.
 */
export async function searchAddresses(
  query: string,
  limit = 6,
): Promise<GeocodeHit[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=${limit}`;
  try {
    const res = await fetch(url, { headers: commonHeaders() });
    if (!res.ok) return [];
    const data: any[] = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((d) => d?.lat && d?.lon)
      .map<GeocodeHit>((d) => ({
        label: compactLabel(d),
        latitude: Number(d.lat),
        longitude: Number(d.lon),
        osmId: `${d.osm_type ?? 'x'}-${d.osm_id ?? d.place_id ?? Math.random()}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Reverse-geocodes `(lat, lon)` to a compact address label. Returns null when
 * the service can't resolve the coordinate.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<string | null> {
  const url = `${NOMINATIM_BASE}/reverse?lat=${latitude}&lon=${longitude}&format=jsonv2&addressdetails=1`;
  try {
    const res = await fetch(url, { headers: commonHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.error) return null;
    return compactLabel(data);
  } catch {
    return null;
  }
}

/**
 * Reverse-geocodes `(lat, lon)` to just the locality name (city / town /
 * village), e.g. "Prague". Falls back through coarser admin levels so even
 * remote coordinates resolve to *something* human. Used by the weather widget
 * to label "where" without showing a full street address. Returns null when
 * the service can't resolve the coordinate.
 */
export async function reverseGeocodeCity(
  latitude: number,
  longitude: number,
): Promise<string | null> {
  // zoom=10 biases Nominatim toward the city level rather than the building.
  const url = `${NOMINATIM_BASE}/reverse?lat=${latitude}&lon=${longitude}&format=jsonv2&addressdetails=1&zoom=10`;
  try {
    const res = await fetch(url, { headers: commonHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.error) return null;
    const a = data.address ?? {};
    return (
      a.city ||
      a.town ||
      a.village ||
      a.municipality ||
      a.suburb ||
      a.county ||
      a.state ||
      a.country ||
      null
    );
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- place search
//
// Google-backed address + place autocomplete via the `search-places` edge
// function. This is what the location pickers use: it finds BOTH named venues
// and plain street addresses with forgiving, typo-tolerant matching (the same
// behaviour as the Google Maps search box). When Google isn't configured the
// helpers transparently fall back to Nominatim so the picker still works.

export interface PlacePrediction {
  /** Opaque id passed back to `resolvePlace` to fetch coordinates. */
  placeId: string;
  /** Headline, e.g. "Blue Bottle Coffee" or "Pírkova". */
  primary: string;
  /** Context line, e.g. "316 California St, San Francisco" (may be empty). */
  secondary: string;
}

export interface ResolvedPlace {
  label: string;
  latitude: number;
  longitude: number;
  /** Google place id, kept so callers can re-fetch fresh details later. */
  placeId?: string | null;
  /** Long-lived CDN photo URL (Google provider only). */
  photoUrl?: string | null;
  /** 0–5 average rating + how many reviews back it. */
  rating?: number | null;
  ratingCount?: number | null;
  /** 1–4 price level where known. */
  priceLevel?: number | null;
  /** Whether the venue is open at resolve time (live; do not persist). */
  openNow?: boolean | null;
  /** Stable weekly opening hours, for "open at the errand's time" display. */
  openingHours?: VenueOpeningHours | null;
}

// Nominatim fallback encodes the coordinates straight into the placeId so
// `resolvePlace` can return them without another network round-trip.
const NOMINATIM_PREFIX = 'osm:';

/**
 * Forgiving type-ahead for addresses and places. Biases results toward
 * `center` (the user's location) when provided. `sessionToken` should be a
 * stable random string for the duration of one edit session so Google bills
 * the autocomplete + details calls as a single session.
 */
export async function autocompletePlaces(
  input: string,
  center?: { latitude: number; longitude: number } | null,
  sessionToken?: string,
): Promise<PlacePrediction[]> {
  const q = input.trim();
  if (q.length < 3) return [];

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.functions.invoke('search-places', {
        body: {
          input: q,
          latitude: center?.latitude,
          longitude: center?.longitude,
          sessionToken,
        },
      });
      const provider = (data as any)?.provider;
      const predictions = (data as any)?.predictions;
      if (!error && provider === 'google' && Array.isArray(predictions)) {
        return predictions
          .filter((p: any) => p?.placeId && p?.primary)
          .map((p: any) => ({
            placeId: String(p.placeId),
            primary: String(p.primary),
            secondary: typeof p.secondary === 'string' ? p.secondary : '',
          }));
      }
      // provider === 'none' or any error → fall through to Nominatim.
    } catch {
      // network/edge error → fall through to Nominatim.
    }
  }

  const hits = await searchAddresses(q, 6);
  return hits.map((h) => ({
    placeId: `${NOMINATIM_PREFIX}${h.latitude},${h.longitude}|${h.label}`,
    primary: h.label,
    secondary: '',
  }));
}

/** Resolves a prediction from `autocompletePlaces` to a concrete location. */
export async function resolvePlace(
  placeId: string,
  sessionToken?: string,
): Promise<ResolvedPlace | null> {
  if (placeId.startsWith(NOMINATIM_PREFIX)) {
    const rest = placeId.slice(NOMINATIM_PREFIX.length);
    const sep = rest.indexOf('|');
    const coords = sep >= 0 ? rest.slice(0, sep) : rest;
    const label = sep >= 0 ? rest.slice(sep + 1) : 'Selected location';
    const [latS, lonS] = coords.split(',');
    const latitude = Number(latS);
    const longitude = Number(lonS);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { label: label || 'Selected location', latitude, longitude };
  }

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.functions.invoke('search-places', {
        body: { placeId, sessionToken },
      });
      const place = (data as any)?.place;
      if (
        !error &&
        place &&
        typeof place.latitude === 'number' &&
        typeof place.longitude === 'number'
      ) {
        return {
          label:
            typeof place.label === 'string' ? place.label : 'Selected location',
          latitude: place.latitude,
          longitude: place.longitude,
          placeId: typeof place.placeId === 'string' ? place.placeId : null,
          photoUrl: typeof place.photoUrl === 'string' ? place.photoUrl : null,
          rating: typeof place.rating === 'number' ? place.rating : null,
          ratingCount:
            typeof place.ratingCount === 'number' ? place.ratingCount : null,
          priceLevel:
            typeof place.priceLevel === 'number' ? place.priceLevel : null,
          openNow: typeof place.openNow === 'boolean' ? place.openNow : null,
          openingHours:
            place.openingHours && Array.isArray(place.openingHours.periods)
              ? (place.openingHours as VenueOpeningHours)
              : null,
        };
      }
    } catch {
      // ignore — caller treats null as "couldn't resolve".
    }
  }
  return null;
}
