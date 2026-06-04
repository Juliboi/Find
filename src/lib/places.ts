import * as Location from 'expo-location';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  findPlacesGrounded,
  isGeminiConfigured,
  isGroundedError,
  type GroundedPlace,
} from '@/lib/groundedPlaces';

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
   * Short AI-written explanation of why this place is being recommended
   * for the user's intent. ~1 sentence, set by the GPT re-rank pass in
   * the `find-places` edge function. Falsy when AI re-ranking is off
   * (no OPENAI_API_KEY) or the model returned no reasoning for this
   * specific candidate.
   */
  reasoning?: string;
}

export type PlacesProvider = 'gemini' | 'google' | 'foursquare' | 'osm' | 'none';

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

// ------------------------------------------------- grounded → NearbyPlace map
//
// The grounded finder (one Gemini + Google Search call) returns a lean shape:
// name, address, coords, approx distance, rating, and a one-line "why". We map
// it into the `NearbyPlace` the rest of the app already consumes so PlanCard,
// the day store, and the compose pass need zero changes.

/**
 * A single grounded call occasionally hallucinates a coordinate in the wrong
 * city. Anything past this from the user is almost certainly wrong for a
 * "find a place near me" intent — this is the distance guard the old edge
 * pipeline was missing (the Mladá Boleslav-from-Bohnice bug).
 */
const GROUNDED_MAX_DISTANCE_M = 30000;

function haversineMeters(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function groundedToNearby(
  places: GroundedPlace[],
  coords: Coords,
): NearbyPlace[] {
  const out: NearbyPlace[] = [];
  const seen = new Set<string>();
  for (const p of places) {
    const lat = p.latitude;
    const lon = p.longitude;
    const hasCoords = lat != null && lon != null;
    // Trust our own haversine over the model's approxDistanceKm; fall back to
    // the model's estimate only when it gave no coordinates.
    const distanceM = hasCoords
      ? Math.round(haversineMeters(coords.latitude, coords.longitude, lat!, lon!))
      : p.approxDistanceKm != null
      ? Math.round(p.approxDistanceKm * 1000)
      : 0;
    // Sanity guard: drop coordinates that are implausibly far away.
    if (hasCoords && distanceM > GROUNDED_MAX_DISTANCE_M) continue;

    const dedupeKey = `${p.name.toLowerCase()}|${Math.round(
      (lat ?? 0) * 1000,
    )},${Math.round((lon ?? 0) * 1000)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      id: `gemini-${lat ?? 'x'},${lon ?? 'x'}-${p.name}`,
      name: p.name,
      address: p.address,
      distanceM,
      latitude: lat ?? coords.latitude,
      longitude: lon ?? coords.longitude,
      photoUrl: null,
      rating: p.rating,
      ratingCount: null,
      priceLevel: null,
      types: [],
      openNow: null,
      reasoning: p.why ?? undefined,
    });
  }
  return out;
}

// ----------------------------------------------------------------- main API

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
): Promise<FindPlacesResult> {
  const queries = (Array.isArray(input) ? input : [input])
    .map((q) => q.trim())
    .filter(Boolean);
  if (queries.length === 0) {
    return { places: [], category: null, provider: 'none', reason: 'no_results' };
  }
  // Both paths need the user's coordinates.
  const coords = await getCurrentCoords();
  if (!coords) {
    return { places: [], category: null, provider: 'none', reason: 'no_location' };
  }
  const key = cacheKey(queries.join('|') + (intent ? `:${intent}` : ''), coords);
  const cached = readCache(key);
  if (cached) return cached;

  // Preferred path: one grounded client-side call (Gemini + Google Search).
  // No edge function, no regex categories, no composite score, no re-rank —
  // the model reasons about intent + locality in a single step. We fall back
  // to the edge pipeline only when Gemini is unconfigured or returns nothing.
  if (isGeminiConfigured) {
    const groundingQuery = (intent && intent.trim()) || queries[0];
    const grounded = await findPlacesGrounded(
      groundingQuery,
      coords.latitude,
      coords.longitude,
    );
    if (!isGroundedError(grounded)) {
      const places = groundedToNearby(grounded.places, coords);
      if (places.length > 0) {
        const result: FindPlacesResult = {
          places,
          category: null,
          provider: 'gemini',
          debug: grounded.debug,
        };
        writeCache(key, result);
        return result;
      }
      // Grounded returned no usable places — fall through to the edge pipeline
      // when it's available, otherwise report no results.
    } else if (!isSupabaseConfigured || !supabase) {
      // Grounded errored and there's no fallback configured — surface it.
      return {
        places: [],
        category: null,
        provider: 'none',
        reason: 'error',
        detail: grounded.detail
          ? `${grounded.error}: ${grounded.detail}`
          : grounded.error,
        debug: grounded.debug,
      };
    }
  }

  // Fallback path: existing Supabase `find-places` edge function.
  if (!isSupabaseConfigured || !supabase) {
    return { places: [], category: null, provider: 'none', reason: 'no_supabase' };
  }

  try {
    const { data, error } = await supabase.functions.invoke('find-places', {
      body: {
        queries,
        intent: intent ?? queries[0],
        latitude: coords.latitude,
        longitude: coords.longitude,
        // 5 km is roughly what Google Maps uses by default when you
        // search for a venue type in a city: wide enough to include
        // popular places a few neighborhoods over, narrow enough to
        // stay locally meaningful.
        radiusM: 5000,
        limit: 6,
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
