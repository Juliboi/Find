// Supabase Edge Function: find-places
//
// Looks up real places near a user-provided coordinate. Picks the best
// provider available at runtime, in this order:
//
//   1. Google Places API (New) — gold standard. Set GOOGLE_PLACES_API_KEY.
//   2. Foursquare Places API v3 — fastest to set up, no billing. Set FOURSQUARE_API_KEY.
//   3. OpenStreetMap Overpass — free fallback, lower quality.
//
// Response shape (provider-agnostic):
//
//   {
//     query: string,
//     provider: "google" | "foursquare" | "osm",
//     category: string | null,
//     places: [{
//       id: string,
//       name: string,
//       address: string | null,
//       distanceM: number,
//       latitude: number,
//       longitude: number,
//       photoUrl: string | null,    // CDN URL, no auth needed
//       rating: number | null,       // 0-5 scale, normalized across providers
//       ratingCount: number | null,
//       priceLevel: number | null,   // 1-4 where available
//       types: string[],             // raw category labels for debugging
//       openNow: boolean | null
//     }]
//   }

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

interface UnifiedPlace {
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

// ------------------------------------------------------------------- helpers

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// --------------------------------------------------------- category mappings

interface CategoryMap {
  category: string;
  google: string[]; // includedTypes for Places API (New)
  foursquare: string[]; // Foursquare category IDs
  osmFilters: string[]; // Overpass tag filters
}

const CATEGORY_MAPS: Array<{ test: RegExp; map: CategoryMap }> = [
  {
    test: /\b(gym|fitness|workout|crossfit|yoga|pilates|spin)\b/i,
    map: {
      category: 'gym',
      google: ['gym', 'fitness_center'],
      foursquare: ['18021'], // Gym / Fitness Center
      osmFilters: [
        '["leisure"="fitness_centre"]',
        '["leisure"="fitness_station"]',
        '["amenity"="gym"]',
      ],
    },
  },
  {
    test: /\b(grocer(y|ies)|supermarket|food shop)\b/i,
    map: {
      category: 'grocery',
      google: ['supermarket', 'grocery_store'],
      foursquare: ['17069', '17142'], // Supermarket, Convenience Store
      osmFilters: [
        '["shop"="supermarket"]',
        '["shop"="grocery"]',
        '["shop"="convenience"]',
      ],
    },
  },
  {
    test: /\b(pharmacy|chemist|drugstore)\b/i,
    map: {
      category: 'pharmacy',
      google: ['pharmacy', 'drugstore'],
      foursquare: ['17050'],
      osmFilters: ['["amenity"="pharmacy"]'],
    },
  },
  {
    test: /\b(cafe|coffee|coffeeshop)\b/i,
    map: {
      category: 'cafe',
      google: ['cafe', 'coffee_shop'],
      foursquare: ['13035'],
      osmFilters: ['["amenity"="cafe"]'],
    },
  },
  {
    test: /\b(restaurant|dinner|lunch|brunch|eat out)\b/i,
    map: {
      category: 'restaurant',
      google: ['restaurant'],
      foursquare: ['13065'],
      osmFilters: [
        '["amenity"="restaurant"]',
        '["amenity"="fast_food"]',
      ],
    },
  },
  {
    test: /\b(bakery|bread|patisserie)\b/i,
    map: {
      category: 'bakery',
      google: ['bakery'],
      foursquare: ['13002'],
      osmFilters: ['["shop"="bakery"]'],
    },
  },
  {
    test: /\b(park|green space)\b/i,
    map: {
      category: 'park',
      google: ['park'],
      foursquare: ['16032'],
      osmFilters: ['["leisure"="park"]'],
    },
  },
  {
    test: /\b(library)\b/i,
    map: {
      category: 'library',
      google: ['library'],
      foursquare: ['12080'],
      osmFilters: ['["amenity"="library"]'],
    },
  },
  {
    test: /\b(bank|atm)\b/i,
    map: {
      category: 'bank',
      google: ['bank', 'atm'],
      foursquare: ['11044'],
      osmFilters: ['["amenity"="bank"]', '["amenity"="atm"]'],
    },
  },
  {
    test: /\b(bar|pub)\b/i,
    map: {
      category: 'bar',
      google: ['bar'],
      foursquare: ['13003'],
      osmFilters: ['["amenity"="bar"]', '["amenity"="pub"]'],
    },
  },
  {
    test: /\b(office|workplace|coworking)\b/i,
    map: {
      category: 'office',
      google: ['corporate_office'],
      foursquare: ['11126'], // Coworking Space
      osmFilters: ['["office"]'],
    },
  },
];

function resolveCategory(q: string): CategoryMap | null {
  for (const entry of CATEGORY_MAPS) {
    if (entry.test.test(q)) return entry.map;
  }
  return null;
}

// ------------------------------------------------------------- Google Places

async function searchGoogle(
  query: string,
  lat: number,
  lon: number,
  radiusM: number,
  limit: number,
  apiKey: string,
  category: CategoryMap,
): Promise<{ provider: 'google'; places: UnifiedPlace[] }> {
  const res = await fetch(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.types,places.rating,places.userRatingCount,places.priceLevel,places.photos,places.currentOpeningHours.openNow',
      },
      body: JSON.stringify({
        includedTypes: category.google,
        maxResultCount: Math.min(20, limit),
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lon },
            radius: radiusM,
          },
        },
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google Places error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const raw: any[] = Array.isArray(data?.places) ? data.places : [];

  // Resolve photos for top results in parallel
  const places = await Promise.all(
    raw.slice(0, limit).map(async (p) => {
      const elLat = p?.location?.latitude;
      const elLon = p?.location?.longitude;
      const name = p?.displayName?.text;
      if (typeof elLat !== 'number' || typeof elLon !== 'number' || !name) {
        return null;
      }
      let photoUrl: string | null = null;
      const photoName = p?.photos?.[0]?.name;
      if (photoName) {
        try {
          const photoRes = await fetch(
            `https://places.googleapis.com/v1/${photoName}/media?key=${apiKey}&maxHeightPx=400&maxWidthPx=400&skipHttpRedirect=true`,
          );
          if (photoRes.ok) {
            const photoJson = await photoRes.json();
            if (typeof photoJson?.photoUri === 'string') {
              photoUrl = photoJson.photoUri;
            }
          }
        } catch {
          // ignore photo errors, place is still useful
        }
      }
      const place: UnifiedPlace = {
        id: typeof p.id === 'string' ? p.id : `g-${elLat},${elLon}`,
        name,
        address:
          (typeof p.shortFormattedAddress === 'string'
            ? p.shortFormattedAddress
            : null) ??
          (typeof p.formattedAddress === 'string' ? p.formattedAddress : null),
        distanceM: Math.round(haversineMeters(lat, lon, elLat, elLon)),
        latitude: elLat,
        longitude: elLon,
        photoUrl,
        rating: typeof p.rating === 'number' ? p.rating : null,
        ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
        priceLevel:
          p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE'
            ? 1
            : p.priceLevel === 'PRICE_LEVEL_MODERATE'
            ? 2
            : p.priceLevel === 'PRICE_LEVEL_EXPENSIVE'
            ? 3
            : p.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE'
            ? 4
            : null,
        types: Array.isArray(p.types) ? p.types : [],
        openNow:
          typeof p?.currentOpeningHours?.openNow === 'boolean'
            ? p.currentOpeningHours.openNow
            : null,
      };
      return place;
    }),
  );
  return {
    provider: 'google',
    places: places.filter(Boolean) as UnifiedPlace[],
  };
}

// --------------------------------------------------------------- Foursquare

async function searchFoursquare(
  query: string,
  lat: number,
  lon: number,
  radiusM: number,
  limit: number,
  apiKey: string,
  category: CategoryMap,
): Promise<{ provider: 'foursquare'; places: UnifiedPlace[] }> {
  const params = new URLSearchParams({
    ll: `${lat},${lon}`,
    radius: String(radiusM),
    limit: String(limit),
    sort: 'DISTANCE',
    fields: 'fsq_id,name,location,categories,distance,rating,price,photos,hours',
  });
  if (category.foursquare.length > 0) {
    params.set('categories', category.foursquare.join(','));
  } else {
    params.set('query', query);
  }
  const res = await fetch(
    `https://api.foursquare.com/v3/places/search?${params.toString()}`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: apiKey,
      },
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Foursquare error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const results: any[] = Array.isArray(data?.results) ? data.results : [];

  const places: UnifiedPlace[] = results
    .map((p) => {
      const elLat = p?.geocodes?.main?.latitude ?? p?.location?.latitude;
      const elLon = p?.geocodes?.main?.longitude ?? p?.location?.longitude;
      if (typeof elLat !== 'number' || typeof elLon !== 'number') return null;
      const photo0 = Array.isArray(p?.photos) && p.photos.length > 0 ? p.photos[0] : null;
      const photoUrl = photo0?.prefix && photo0?.suffix
        ? `${photo0.prefix}400x400${photo0.suffix}`
        : null;
      const fsqRating = typeof p.rating === 'number' ? p.rating : null;
      return {
        id: p.fsq_id ?? `fsq-${elLat},${elLon}`,
        name: p.name ?? 'Unnamed',
        address:
          typeof p?.location?.formatted_address === 'string'
            ? p.location.formatted_address
            : [p?.location?.address, p?.location?.locality].filter(Boolean).join(', ') || null,
        distanceM:
          typeof p.distance === 'number'
            ? p.distance
            : Math.round(haversineMeters(lat, lon, elLat, elLon)),
        latitude: elLat,
        longitude: elLon,
        photoUrl,
        rating: fsqRating !== null ? Math.round((fsqRating / 2) * 10) / 10 : null,
        ratingCount: null,
        priceLevel: typeof p.price === 'number' ? p.price : null,
        types: Array.isArray(p.categories)
          ? p.categories.map((c: any) => c?.name).filter(Boolean)
          : [],
        openNow:
          typeof p?.hours?.open_now === 'boolean' ? p.hours.open_now : null,
      } as UnifiedPlace;
    })
    .filter(Boolean) as UnifiedPlace[];

  return { provider: 'foursquare', places };
}

// ----------------------------------------------------------------- Overpass

function buildOverpassQuery(
  filters: string[],
  lat: number,
  lon: number,
  radiusM: number,
): string {
  const around = `(around:${radiusM},${lat},${lon})`;
  const parts = filters
    .flatMap((f) => [`node${f}${around};`, `way${f}${around};`])
    .join('\n');
  return `[out:json][timeout:15];(${parts});out center 30;`;
}

function formatOsmAddress(tags: any): string | null {
  if (!tags) return null;
  const parts = [
    tags['addr:housenumber'] && tags['addr:street']
      ? `${tags['addr:street']} ${tags['addr:housenumber']}`
      : tags['addr:street'],
    tags['addr:city'],
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

async function searchOverpass(
  query: string,
  lat: number,
  lon: number,
  radiusM: number,
  limit: number,
  category: CategoryMap,
): Promise<{ provider: 'osm'; places: UnifiedPlace[] }> {
  const overpassQL = buildOverpassQuery(
    category.osmFilters,
    lat,
    lon,
    radiusM,
  );
  // Hard cap the request so the function fails fast when Overpass is
  // overloaded (common for dense categories like restaurants in cities).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let res: Response;
  try {
    res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'DayFlow/0.1.0 (https://github.com/dayflow)',
        Accept: 'application/json',
      },
      body: `data=${encodeURIComponent(overpassQL)}`,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Overpass error ${res.status}`);
  }
  const data = await res.json();
  const elements: any[] = Array.isArray(data?.elements) ? data.elements : [];

  const places: UnifiedPlace[] = elements
    .map((el) => {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      const name = el.tags?.name;
      if (typeof elLat !== 'number' || typeof elLon !== 'number' || !name) {
        return null;
      }
      return {
        id: `${el.type}-${el.id}`,
        name,
        address: formatOsmAddress(el.tags),
        distanceM: Math.round(haversineMeters(lat, lon, elLat, elLon)),
        latitude: elLat,
        longitude: elLon,
        photoUrl: null,
        rating: null,
        ratingCount: null,
        priceLevel: null,
        types: Object.keys(el.tags ?? {})
          .filter((k) => ['leisure', 'amenity', 'shop', 'sport'].includes(k))
          .map((k) => `${k}=${el.tags[k]}`),
        openNow: null,
      } as UnifiedPlace;
    })
    .filter(Boolean)
    .sort((a: UnifiedPlace, b: UnifiedPlace) => a.distanceM - b.distanceM)
    .slice(0, limit);

  return { provider: 'osm', places };
}

// -------------------------------------------------------- handler entrypoint

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let payload: {
    query?: string;
    latitude?: number;
    longitude?: number;
    radiusM?: number;
    limit?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const query = typeof payload.query === 'string' ? payload.query.trim() : '';
  const lat = Number(payload.latitude);
  const lon = Number(payload.longitude);
  if (
    !query ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return jsonResponse(
      { error: 'query, latitude, and longitude are required.' },
      400,
    );
  }

  const radiusM = Math.min(
    10000,
    Math.max(200, Number(payload.radiusM) || 2500),
  );
  const limit = Math.min(20, Math.max(1, Number(payload.limit) || 5));

  const category = resolveCategory(query);
  if (!category) {
    return jsonResponse({
      query,
      provider: 'none',
      category: null,
      places: [],
      note: 'No category mapping for this query. Add one in CATEGORY_MAPS.',
    });
  }

  const googleKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
  const fsqKey = Deno.env.get('FOURSQUARE_API_KEY');

  try {
    let result: { provider: string; places: UnifiedPlace[] };
    if (googleKey) {
      result = await searchGoogle(
        query,
        lat,
        lon,
        radiusM,
        limit,
        googleKey,
        category,
      );
    } else if (fsqKey) {
      result = await searchFoursquare(
        query,
        lat,
        lon,
        radiusM,
        limit,
        fsqKey,
        category,
      );
    } else {
      result = await searchOverpass(
        query,
        lat,
        lon,
        radiusM,
        limit,
        category,
      );
    }
    return jsonResponse({
      query,
      provider: result.provider,
      category: category.category,
      places: result.places,
    });
  } catch (e) {
    return jsonResponse(
      { error: 'Place search failed', detail: String(e) },
      502,
    );
  }
});
