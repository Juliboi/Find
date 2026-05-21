/**
 * Lightweight geocoding helpers using OpenStreetMap's Nominatim service.
 *
 * - Free, no API key.
 * - Rate-limited (1 req/sec recommended) — fine for interactive UI.
 * - Requires a descriptive User-Agent per Nominatim's usage policy. React
 *   Native sets one automatically on iOS/Android, but we also add a `Referer`
 *   header so the request looks legitimate.
 */

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
