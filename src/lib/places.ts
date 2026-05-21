import * as Location from 'expo-location';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

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

// ----------------------------------------------------------------- main API

/**
 * Looks up real places near the user matching `query`. Caches results for
 * 5 minutes per (query, ~100m cell). Requires location permission and the
 * `find-places` edge function to be deployed.
 */
export async function findPlaces(query: string): Promise<FindPlacesResult> {
  if (!isSupabaseConfigured || !supabase) {
    return { places: [], category: null, provider: 'none', reason: 'no_supabase' };
  }
  const coords = await getCurrentCoords();
  if (!coords) {
    return { places: [], category: null, provider: 'none', reason: 'no_location' };
  }
  const key = cacheKey(query, coords);
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const { data, error } = await supabase.functions.invoke('find-places', {
      body: {
        query,
        latitude: coords.latitude,
        longitude: coords.longitude,
        radiusM: 2500,
        limit: 6,
      },
    });
    if (error || !data) {
      return { places: [], category: null, provider: 'none', reason: 'error' };
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
    };
    if (places.length > 0) writeCache(key, result);
    return result;
  } catch {
    return { places: [], category: null, provider: 'none', reason: 'error' };
  }
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}
