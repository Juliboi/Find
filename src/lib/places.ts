import * as Location from 'expo-location';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { VenueOpeningHours } from '@/types/itinerary';

export interface Coords {
  latitude: number;
  longitude: number;
}

export interface NearbyPlace {
  id: string;
  name: string;
  address: string | null;
  distanceM: number;
  latitude: number;
  longitude: number;
  photoUrl: string | null;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null;
  types: string[];
  openNow: boolean | null;
  /**
   * Structured weekly opening hours (Google provider only). Lets the swap
   * sheet judge a candidate against the item's SCHEDULED visit time, and is
   * carried onto the swapped-in place so the card's hours warning keeps
   * working after a swap. Absent for Foursquare/OSM results.
   */
  openingHours?: VenueOpeningHours | null;
  /**
   * Short AI-written explanation of why this place is being recommended
   * for the user's intent. ~1 sentence, set by the GPT re-rank pass in
   * the `find-places` edge function. Falsy when AI re-ranking is off
   * (no OPENAI_API_KEY) or the model returned no reasoning for this
   * specific candidate.
   */
  reasoning?: string;
}

export type PlacesProvider = 'google' | 'foursquare' | 'osm' | 'none';

interface CachedCoords {
  coords: Coords;
  at: number;
}

const COORDS_CACHE_MS = 5 * 60 * 1000;
let cachedCoords: CachedCoords | null = null;

/**
 * Requests foreground location permission and returns the user's coordinates,
 * cached for ~5 minutes. Returns null if permission is denied.
 */
export async function getCurrentCoords(): Promise<Coords | null> {
  if (cachedCoords && Date.now() - cachedCoords.at < COORDS_CACHE_MS) {
    return cachedCoords.coords;
  }
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const coords: Coords = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
    };
    cachedCoords = { coords, at: Date.now() };
    return coords;
  } catch {
    return null;
  }
}

/**
 * Like `getCurrentCoords`, but never shows the OS permission prompt: it only
 * returns a fix when permission was *already* granted (e.g. via the place
 * picker). Used by passive features such as the weather widget that shouldn't
 * pop a permission dialog the moment the home screen loads. Returns null when
 * permission hasn't been granted yet or the fix fails.
 */
export async function getCurrentCoordsIfPermitted(): Promise<Coords | null> {
  if (cachedCoords && Date.now() - cachedCoords.at < COORDS_CACHE_MS) {
    return cachedCoords.coords;
  }
  try {
    const { granted } = await Location.getForegroundPermissionsAsync();
    if (!granted) return null;
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const coords: Coords = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
    };
    cachedCoords = { coords, at: Date.now() };
    return coords;
  } catch {
    return null;
  }
}

const PLACE_LOOKUP_PATTERNS = [
  /\bfind\b.*\bnearby\b/i,
  /\bfind\b.*\bnew one\b/i,
  /\bfind\b.*\bone\b/i,
  /\bclosest\b/i,
  /\bnear me\b/i,
  /\bnearby\b/i,
  /\bnear home\b/i,
];

export function isPlaceLookupSuggestion(chip: string): boolean {
  return PLACE_LOOKUP_PATTERNS.some((r) => r.test(chip));
}

export interface FindPlacesResult {
  places: NearbyPlace[];
  category: string | null;
  provider: PlacesProvider;
  reason?: 'no_supabase' | 'no_location' | 'no_results' | 'error';
  /**
   * Human-readable detail when something went wrong. Surfaced in the UI
   * so a missing/broken edge function is debuggable instead of a generic
   * "lookup failed" dead-end.
   */
  detail?: string;
  /** Raw error / response payload for the sandbox's debug section. */
  debug?: unknown;
}

// ----------------------------------------------------------------- cache

interface CacheEntry {
  at: number;
  result: FindPlacesResult;
}

const PLACES_CACHE_MS = 5 * 60 * 1000;
const placesCache = new Map<string, CacheEntry>();

function cacheKey(query: string, coords: Coords): string {
  // Round to ~100m grid so small GPS drift still hits the cache.
  const lat = Math.round(coords.latitude * 1000) / 1000;
  const lon = Math.round(coords.longitude * 1000) / 1000;
  return `${query.trim().toLowerCase()}@${lat},${lon}`;
}

/** Coarse (~100m) cache fragment for the optional prev/next route anchors. */
function routeCacheKey(route?: RouteContext): string {
  if (!route || (!route.prev && !route.next)) return '';
  const fmt = (c?: Coords) =>
    c
      ? `${Math.round(c.latitude * 1000) / 1000},${Math.round(c.longitude * 1000) / 1000}`
      : '-';
  return `|r=${fmt(route.prev)}>${fmt(route.next)}`;
}

function readCache(key: string): FindPlacesResult | null {
  const entry = placesCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > PLACES_CACHE_MS) {
    placesCache.delete(key);
    return null;
  }
  return entry.result;
}

function writeCache(key: string, result: FindPlacesResult): void {
  placesCache.set(key, { at: Date.now(), result });
}

export function clearPlacesCache(): void {
  placesCache.clear();
}

// ----------------------------------------------------------------- main API

/**
 * Optional route context for a place-swap lookup. When the venue being
 * swapped sits BETWEEN two other located stops, passing the previous and
 * next stop coordinates lets the edge function bias the search to the
 * corridor between them and rank alternatives by *detour* (extra travel
 * added to the day) instead of raw distance — so the suggestions stay
 * on-route and don't make the day zig-zag.
 */
export interface RouteContext {
  prev?: Coords;
  next?: Coords;
}

/**
 * Looks up real places near the user matching `input`. Accepts either a
 * single query string or an array of query variants (the latter triggers
 * multi-query fan-out + AI re-ranking in the edge function). Caches
 * results for 5 minutes per (joined-query, ~100m cell).
 *
 * `intent`, when provided, is the user's original natural-language plan
 * text ("dinner out", "leg day"). It's used by the GPT re-rank pass to
 * understand the user's *goal* beyond the literal search terms.
 */
export async function findPlaces(
  input: string | string[],
  intent?: string,
  /**
   * Search center. When omitted, falls back to the user's GPS location. Pass a
   * place's own coordinates to surface alternatives "near that spot" (used by
   * the itinerary place-swap browser) rather than near the user.
   */
  center?: Coords,
  /**
   * Previous/next located stops around the venue being swapped. When set,
   * the edge function ranks alternatives by how little they detour the
   * existing route rather than by distance from `center`.
   */
  route?: RouteContext,
  /**
   * Search tuning. `radiusM` (default 5 km, clamped 200 m–10 km) sets how wide
   * to look around the center; `limit` (default 6) caps how many places come
   * back. Discovery passes a tighter radius for "near me" lookups and a wider
   * one when searching around a named area.
   */
  opts?: { radiusM?: number; limit?: number },
): Promise<FindPlacesResult> {
  const queries = (Array.isArray(input) ? input : [input])
    .map((q) => q.trim())
    .filter(Boolean);
  if (queries.length === 0) {
    return { places: [], category: null, provider: 'none', reason: 'no_results' };
  }
  if (!isSupabaseConfigured || !supabase) {
    return { places: [], category: null, provider: 'none', reason: 'no_supabase' };
  }
  // `center` lets callers anchor the search around a specific venue (used by
  // the itinerary place-swap browser to find alternatives "near that spot")
  // instead of around the user's current location.
  const coords = center ?? (await getCurrentCoords());
  if (!coords) {
    return { places: [], category: null, provider: 'none', reason: 'no_location' };
  }
  const radiusM = Math.min(10000, Math.max(200, Math.round(opts?.radiusM ?? 5000)));
  const limit = Math.min(20, Math.max(1, Math.round(opts?.limit ?? 6)));
  // Route context, when present, changes which alternatives win — fold a
  // coarse (~100m) version of both anchors into the cache key so a
  // route-aware lookup never serves a plain "near the old pin" result. Radius
  // and limit are part of the key too, so a tight "near me" lookup and a wide
  // area search don't collide in the cache.
  const routeKey = routeCacheKey(route);
  const key = cacheKey(
    queries.join('|') +
      (intent ? `:${intent}` : '') +
      routeKey +
      `|r=${radiusM}|n=${limit}`,
    coords,
  );
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const { data, error } = await supabase.functions.invoke('find-places', {
      body: {
        queries,
        intent: intent ?? queries[0],
        latitude: coords.latitude,
        longitude: coords.longitude,
        radiusM,
        limit,
        ...(route?.prev ? { prev: route.prev } : {}),
        ...(route?.next ? { next: route.next } : {}),
      },
    });
    if (error) {
      // `supabase.functions.invoke` exposes the underlying Response on
      // `error.context` for FunctionsHttpError. We try to read the body so
      // the user actually sees *why* it failed (not deployed, missing
      // secret, upstream timeout, etc.).
      const detail = await extractFunctionError(error);
      return {
        places: [],
        category: null,
        provider: 'none',
        reason: 'error',
        detail,
        debug: { error: detail, name: (error as any)?.name },
      };
    }
    if (!data) {
      return {
        places: [],
        category: null,
        provider: 'none',
        reason: 'error',
        detail: 'Edge function returned an empty response.',
      };
    }
    if (data && typeof data === 'object' && 'error' in (data as any)) {
      const detail =
        typeof (data as any).error === 'string'
          ? (data as any).error
          : JSON.stringify((data as any).error);
      return {
        places: [],
        category: null,
        provider: 'none',
        reason: 'error',
        detail,
        debug: data,
      };
    }
    const places = Array.isArray(data.places) ? (data.places as NearbyPlace[]) : [];
    const result: FindPlacesResult = {
      places,
      category: typeof data.category === 'string' ? data.category : null,
      provider:
        data.provider === 'google'
          ? 'google'
          : data.provider === 'foursquare'
          ? 'foursquare'
          : data.provider === 'osm'
          ? 'osm'
          : 'none',
      reason: places.length === 0 ? 'no_results' : undefined,
      debug: data,
    };
    if (places.length > 0) writeCache(key, result);
    return result;
  } catch (e: any) {
    return {
      places: [],
      category: null,
      provider: 'none',
      reason: 'error',
      detail: String(e?.message ?? e),
      debug: { thrown: String(e?.message ?? e) },
    };
  }
}

/**
 * Tries hard to extract a useful message from a Supabase Functions error.
 *
 * `supabase.functions.invoke` returns one of:
 *   - FunctionsHttpError: edge function responded non-2xx. `context` is the
 *     Response; we can read the body once.
 *   - FunctionsRelayError: Supabase relay (CORS, project paused, etc.).
 *   - FunctionsFetchError: network failure (no connectivity).
 */
async function extractFunctionError(error: unknown): Promise<string> {
  const anyErr = error as any;
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(error);
  const ctx = anyErr?.context;
  // Newer supabase-js exposes `context` as the raw Response.
  if (ctx && typeof ctx.text === 'function') {
    try {
      const body = await ctx.text();
      if (body) {
        // Try to parse JSON `{ error: "...", detail: "..." }` shape
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed?.error === 'string') {
            return parsed?.detail
              ? `${parsed.error}: ${parsed.detail}`
              : parsed.error;
          }
        } catch {
          // not JSON — fall through to raw body
        }
        return `${name || 'Function error'} (HTTP ${ctx.status ?? '?'}): ${body.slice(0, 240)}`;
      }
      return `${name || 'Function error'} (HTTP ${ctx.status ?? '?'})`;
    } catch {
      // ignore — Response already consumed, fall back below
    }
  }
  return `${name ? `${name}: ` : ''}${msg}`;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}
