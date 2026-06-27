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

import { extractOpeningHours, type VenueOpeningHours } from '../_shared/hours.ts';
import { logTokenUsage, openaiUsage, type TokenUsage } from '../_shared/tokenLog.ts';

// The model behind the discovery re-rank / blurb pass. Named once so the request
// body and the token-usage log can't drift apart.
const RERANK_MODEL = 'gpt-4o-mini';

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
  /**
   * Structured weekly opening hours (Google provider only), so the place-swap
   * sheet can judge whether a candidate is open for the item's SCHEDULED visit
   * time, not just "open right now". Absent for Foursquare/OSM results.
   */
  openingHours?: VenueOpeningHours | null;
  /**
   * GPT-written ~1 sentence pitch for why this place is recommended.
   * Set by the AI re-rank pass; absent if OPENAI_API_KEY is missing
   * or the model gave no reasoning for this specific candidate.
   */
  reasoning?: string;
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

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
      ...(extraHeaders ?? {}),
    },
  });
}

// ----------------------------------------------------------- in-memory cache
//
// Deno Deploy keeps the same isolate warm for a while across requests on
// the same edge, so a process-local Map is a cheap way to absorb repeat
// "gym near home" calls without burning Overpass quota or the user's
// patience. The cache key includes ~100m-rounded coords so small GPS
// drift still hits a warm entry. Cap the size so a long-lived isolate
// doesn't grow unbounded.

interface CachedResponse {
  at: number;
  body: unknown;
}

const SERVER_CACHE_TTL_MS = 5 * 60 * 1000;
const SERVER_CACHE_MAX = 256;
const serverCache = new Map<string, CachedResponse>();

function serverCacheKey(
  query: string,
  lat: number,
  lon: number,
  radiusM: number,
  limit: number,
): string {
  // Round to ~100m
  const rLat = Math.round(lat * 1000) / 1000;
  const rLon = Math.round(lon * 1000) / 1000;
  return `${query.toLowerCase()}@${rLat},${rLon}|r=${radiusM}|n=${limit}`;
}

function readServerCache(key: string): unknown | null {
  const entry = serverCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SERVER_CACHE_TTL_MS) {
    serverCache.delete(key);
    return null;
  }
  return entry.body;
}

function writeServerCache(key: string, body: unknown): void {
  if (serverCache.size >= SERVER_CACHE_MAX) {
    // Evict oldest. Map iteration order = insertion order.
    const oldestKey = serverCache.keys().next().value;
    if (typeof oldestKey === 'string') serverCache.delete(oldestKey);
  }
  serverCache.set(key, { at: Date.now(), body });
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

// --------------------------------------------------------- route geometry
//
// When the caller is swapping a stop that sits BETWEEN two other located
// stops (the itinerary place-swap browser), it passes the previous and
// next stop coordinates. We use those to (a) bias the candidate pool to
// the corridor between them and (b) rank by *detour* rather than raw
// distance, so a replacement that's a short hop off the existing path
// beats a "closer to the old pin" venue that forces a zig-zag.

interface Coords {
  latitude: number;
  longitude: number;
}

/** Geographic midpoint (good enough at city scale; no need for great-circle). */
function midpoint(a: Coords, b: Coords): Coords {
  return {
    latitude: (a.latitude + b.latitude) / 2,
    longitude: (a.longitude + b.longitude) / 2,
  };
}

function distM(a: Coords, b: Coords): number {
  return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}

/**
 * Extra meters added to the day by routing through `c` instead of going
 * straight from the previous stop to the next one:
 *
 *   detour = d(prev, c) + d(c, next) − d(prev, next)
 *
 * A venue sitting right on the prev→next line has ~0 detour; one off to
 * the side that forces a backtrack has a large detour. This is the number
 * that actually captures "don't zig-zag". Falls back to a single-sided
 * distance when only one neighbour is known (first/last located stop), and
 * returns null when there's no route context at all.
 */
function detourMeters(
  prev: Coords | undefined,
  next: Coords | undefined,
  c: Coords,
): number | null {
  if (prev && next) {
    return Math.max(0, distM(prev, c) + distM(c, next) - distM(prev, next));
  }
  if (prev) return distM(prev, c);
  if (next) return distM(c, next);
  return null;
}

function clampRadius(m: number): number {
  return Math.min(10000, Math.max(200, Math.round(m)));
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

// ----------------------------------------------------- localized vocabulary
//
// Google Text Search keys off the EXACT category word, and the right word is
// locale-specific. In Czech the English "drugstore"/"household goods" resolves
// to *lékárna* (a medicine PHARMACY), NOT *drogerie* (dm / Teta / Rossmann) —
// the shops that actually stock cleaning products (Domestos) + toiletries. A
// bare "drugstore" search therefore returns far pharmacies and misses the
// drogerie next door. Rewrite such queries to the variants that surface the
// right shops; the fan-out + proximity ranking then picks the closest. Mirror
// of the client `expandPlaceQuery` (src/lib/placeQueryExpand.ts) — keep in sync.

const DROGERIE_RE =
  /\b(drugstore|drogerie|household\s*(?:goods|cleaning|supplies)?|cleaning\s*(?:supplies|products|stuff)|toiletr(?:y|ies)|cosmetics?)\b/i;
const HOUSEHOLD_PRODUCT_RE =
  /\b(domestos|savo|bleach|detergent|washing\s*(?:powder|liquid|tablets|gel)|fabric\s*softener|laundry\s*(?:detergent|gel|pods|powder)|dish(?:washer)?\s*(?:soap|tablets|gel|liquid)|toilet\s*paper|paper\s*towels|shampoo|toothpaste|deodorant|sponges?)\b/i;
const DROGERIE_VARIANTS = [
  'drogerie',
  'dm drogerie',
  'Teta drogerie',
  'Rossmann drogerie',
  'supermarket',
];

/** Expand each query into locale-aware variants (household/drugstore →
 *  drogerie), then dedupe (case-insensitive) and cap at 6. */
function expandLocalizedQueries(queries: string[]): string[] {
  const out: string[] = [];
  for (const q of queries) {
    if (DROGERIE_RE.test(q) || HOUSEHOLD_PRODUCT_RE.test(q)) {
      out.push(...DROGERIE_VARIANTS);
    } else {
      out.push(q);
    }
  }
  const seen = new Set<string>();
  const res: string[] = [];
  for (const q of out) {
    const k = q.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    res.push(q);
  }
  return res.slice(0, 6);
}

// ------------------------------------------------------------- Google Places
//
// We use the Text Search endpoint (`places:searchText`) rather than
// Nearby Search. Why:
//
//   - Nearby Search ranks places by raw distance and matches on the
//     `includedTypes` set. For category "gym" that means *any* OSM-style
//     "gym" (including pilates studios and boxing schools, both of which
//     Google tags as type `gym`) — surfacing the wrong kind of place
//     close by instead of the right kind a few hundred meters away.
//   - Text Search uses Google's actual web-search relevance model — the
//     same algorithm behind google.com — which has been trained to
//     understand that "gym" colloquially means a workout facility, not
//     a martial-arts dojo. The result: ONEGYM, Form Factory, Iron Base
//     Gym, etc., for our query, not Boxing Čimice.
//
// Text Search also natively handles open-ended queries the original
// architecture couldn't ("italian dinner", "place to do focused work",
// "specialty coffee shop") because it doesn't depend on our brittle
// regex-based `CATEGORY_MAPS`. We pass the user's raw query verbatim.

// Off-category type heuristics. When the user query implies a
// general-purpose category (e.g. "gym"), Google Text Search is mostly
// right but occasionally drops in a niche venue tagged with the same
// broad type. This list lets us defensively reject obvious mismatches
// based on the `types[]` array returned with each place. Keep it tight:
// false positives here remove legitimate results.
const TYPE_BLACKLIST_BY_QUERY: Array<{ test: RegExp; bad: string[] }> = [
  {
    test: /\b(gym|fitness|workout|crossfit|weights?|lifting)\b/i,
    bad: [
      'pilates_studio',
      'yoga_studio',
      'martial_arts_school',
      'boxing_club', // not always a real google type but harmless to list
      'dance_studio',
    ],
  },
  {
    // Generic "restaurant" shouldn't surface fast-food chains or bars
    test: /\brestaurant\b/i,
    bad: ['fast_food_restaurant', 'bar'],
  },
];

function shouldRejectByTypes(query: string, types: string[]): boolean {
  for (const rule of TYPE_BLACKLIST_BY_QUERY) {
    if (!rule.test.test(query)) continue;
    for (const t of types) {
      if (rule.bad.includes(t)) return true;
    }
  }
  return false;
}

// ----------------------------------------------------------- Google primitive
//
// `searchGoogleOnce` is the single-query primitive: fires one Text Search
// call, resolves photos, applies distance + type post-filters, and returns
// the full filtered candidate list (no truncation). The multi-query
// orchestration layer fans this out across query variants and merges
// results into a single ranked list.

interface ScoredCandidate extends UnifiedPlace {
  /** Best (lowest) position this place achieved across the queries
   *  that returned it. 0 = top of Google's relevance ranking. */
  bestPosition: number;
  /** How many of the user's query variants surfaced this place — a
   *  rough corroboration signal: appearing in 3/3 queries is a much
   *  stronger match than appearing in 1/3. */
  matchCount: number;
  /** Composite score 0..1, used to pick the top-N for the AI re-rank. */
  compositeScore: number;
  /** Which queries surfaced this place (for debugging). */
  matchedQueries: string[];
  /**
   * Extra meters this place adds versus going straight from the previous
   * stop to the next one. Only set when the caller passed route context
   * (prev/next coords); null otherwise. Drives both the composite score
   * and the AI re-rank when present.
   */
  detourM: number | null;
}

async function searchGoogleOnce(
  query: string,
  biasCenter: Coords,
  distRef: Coords,
  radiusM: number,
  apiKey: string,
): Promise<UnifiedPlace[]> {
  const res = await fetch(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.types,places.rating,places.userRatingCount,places.priceLevel,places.photos,places.currentOpeningHours.openNow,places.currentOpeningHours.periods,places.currentOpeningHours.weekdayDescriptions,places.regularOpeningHours.periods,places.regularOpeningHours.weekdayDescriptions',
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: 20,
        rankPreference: 'RELEVANCE',
        // Bias to the corridor center (midpoint of prev/next stops) when
        // the caller passed route context, otherwise the venue itself.
        locationBias: {
          circle: {
            center: { latitude: biasCenter.latitude, longitude: biasCenter.longitude },
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

  const places = await Promise.all(
    raw.map(async (p) => {
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
        // Distance shown to the user stays relative to the venue being
        // swapped (distRef) so "0.3 km" reads as "near the old spot".
        distanceM: Math.round(
          haversineMeters(distRef.latitude, distRef.longitude, elLat, elLon),
        ),
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
        openingHours: extractOpeningHours(p),
      };
      return place;
    }),
  );

  return (places.filter(Boolean) as UnifiedPlace[]).filter((p) => {
    // Cull on distance from the bias center (the corridor midpoint when
    // route context is present), not the display distance.
    const biasDist = distM(biasCenter, { latitude: p.latitude, longitude: p.longitude });
    if (biasDist > radiusM * 1.5) return false;
    if (shouldRejectByTypes(query, p.types)) return false;
    return true;
  });
}

// ----------------------------------------------------------- Composite score
//
// Aggregates signals from one or more query variants into a single
// scalar used to *pre-filter* the candidate pool down to ~15 venues
// before the GPT re-rank. The GPT pass does the final 6-pick; this
// score is just a triage to keep token usage bounded.
//
// Two weighting profiles, keyed off intent type:
//
//   EVERYDAY (restaurant, café, grocery, …)
//   ─ distance dominates (0.55). People don't drive across town for
//     dinner; a 5 km famous restaurant should NOT outrank a 500 m
//     neighbourhood spot.
//   ─ Sharp distance decay: max(800m, radius/4) constant.
//
//   COMMUTE-WORTHY (gym, yoga, museum, climbing wall, …)
//   ─ Distance still matters but less (0.35). A 2.5 km gym with a
//     strong rating and many reviews is a legitimate option — people
//     pick a gym based on equipment / vibe / class schedule, not
//     just walking distance.
//   ─ Quality weighs more (rating 0.30, reviews 0.15).
//   ─ Gentler decay: max(1500m, radius/2) constant.

interface ScoreContext {
  bestPosition: number;
  place: UnifiedPlace;
  radiusM: number;
  everyday: boolean;
  /**
   * Extra meters added to the route by this candidate (see detourMeters).
   * When present it REPLACES raw distance as the proximity signal — for a
   * mid-route swap, "doesn't make me backtrack" matters more than "closest
   * to the old pin".
   */
  detourM?: number | null;
  /**
   * Discovery browsing: when true, "open now" stops being a ranking signal —
   * a venue closed right now is fine because the user is choosing for later.
   */
  includeClosed?: boolean;
}

function scoreCandidate(c: ScoreContext): number {
  const pos = 1 / (1 + c.bestPosition);
  // Proximity term. With route context we decay on detour (extra meters
  // added to the path); without it, on raw distance from the venue.
  let proximity: number;
  if (c.detourM != null) {
    // Detour decays faster than raw distance: even ~600 m of backtrack for
    // an everyday stop is a meaningful zig-zag, so it should bite quickly.
    const detourDecay = c.everyday
      ? Math.max(500, c.radiusM / 6)
      : Math.max(1000, c.radiusM / 3);
    proximity = Math.exp(-(c.detourM / detourDecay));
  } else {
    const decayConstant = c.everyday
      ? Math.max(800, c.radiusM / 4)
      : Math.max(1500, c.radiusM / 2);
    proximity = Math.exp(-(c.place.distanceM / decayConstant));
  }
  const dist = proximity;
  const rating = c.place.rating != null ? c.place.rating / 5 : 0;
  const reviewsRaw = c.place.ratingCount ?? 0;
  const reviews = reviewsRaw > 0
    ? Math.min(1, Math.log10(reviewsRaw + 1) / 3)
    : 0;
  const open = c.includeClosed || c.place.openNow !== false ? 1 : 0;

  if (c.everyday) {
    return (
      dist * 0.55 +
      pos * 0.10 +
      rating * 0.20 +
      reviews * 0.10 +
      open * 0.05
    );
  }
  return (
    dist * 0.35 +
    pos * 0.10 +
    rating * 0.30 +
    reviews * 0.15 +
    open * 0.05 +
    // Small bonus for venues with strong rating + many reviews —
    // the user explicitly wants well-validated far gyms to surface.
    (rating >= 0.9 && reviewsRaw >= 200 ? 0.05 : 0)
  );
}

// --------------------------------------------------- Google multi-query fan-out
//
// Runs the user's queries in parallel, merges by place id, and emits a
// list of ScoredCandidate sorted by composite score, capped at
// `candidatePoolSize`. 20 is a good balance: enough variety for the
// GPT re-rank to actually re-rank (especially with 4-5 input queries
// producing 60-100 unique candidates pre-trim), few enough that token
// use stays low. One failing query doesn't sink the whole call.

async function searchGoogleFanOut(
  queries: string[],
  biasCenter: Coords,
  distRef: Coords,
  radiusM: number,
  apiKey: string,
  everyday: boolean,
  route: { prev?: Coords; next?: Coords } | undefined,
  candidatePoolSize = 20,
  includeClosed = false,
): Promise<{ candidates: ScoredCandidate[]; perQueryCounts: Record<string, number> }> {
  const settled = await Promise.allSettled(
    queries.map((q) => searchGoogleOnce(q, biasCenter, distRef, radiusM, apiKey)),
  );

  const merged = new Map<string, ScoredCandidate>();
  const perQueryCounts: Record<string, number> = {};

  settled.forEach((res, i) => {
    const q = queries[i];
    if (res.status !== 'fulfilled') {
      perQueryCounts[q] = -1; // signal failure
      return;
    }
    const places = res.value;
    perQueryCounts[q] = places.length;
    places.forEach((p, position) => {
      const existing = merged.get(p.id);
      if (existing) {
        existing.matchCount += 1;
        existing.matchedQueries.push(q);
        if (position < existing.bestPosition) existing.bestPosition = position;
      } else {
        merged.set(p.id, {
          ...p,
          bestPosition: position,
          matchCount: 1,
          matchedQueries: [q],
          compositeScore: 0,
          detourM: detourMeters(route?.prev, route?.next, {
            latitude: p.latitude,
            longitude: p.longitude,
          }),
        });
      }
    });
  });

  // Compute composite scores. Multi-query corroboration is folded in
  // as a small additive bonus (capped) rather than a weight — places
  // appearing in 3/3 queries get a +0.05, in 2/3 get +0.025, in 1/3
  // get +0.
  const candidates = Array.from(merged.values()).map((c) => {
    const corroboration = Math.min(0.05, (c.matchCount - 1) * 0.025);
    c.compositeScore =
      scoreCandidate({
        bestPosition: c.bestPosition,
        place: c,
        radiusM,
        everyday,
        detourM: c.detourM,
        includeClosed,
      }) + corroboration;
    return c;
  });

  candidates.sort((a, b) => b.compositeScore - a.compositeScore);
  return {
    candidates: candidates.slice(0, candidatePoolSize),
    perQueryCounts,
  };
}

// --------------------------------------------------------- GPT re-rank pass
//
// Sends the composite-scored top-15 to gpt-4o-mini with the user's
// original intent. The model returns 5-6 picks with a short pitch
// for each. Closed places are deprioritized inside the prompt; the
// model is told to drop them unless excluding them leaves the user
// with too few options.
//
// On any failure we silently fall back to the composite-scored list —
// the user still gets good results, just without reasoning text.

interface LLMPickResult {
  picks: Array<{ id: string; reasoning?: string }>;
  failureReason?: string;
  /** Token spend for this re-rank call; absent when the request never reached the model. */
  usage?: TokenUsage;
}

async function analyzeWithLLM(
  intent: string,
  queries: string[],
  candidates: ScoredCandidate[],
  limit: number,
  apiKey: string,
  everyday: boolean,
  routeAware: boolean,
  includeClosed = false,
): Promise<LLMPickResult> {
  // Compact representation. We only include what the model needs to
  // form a judgement — full coordinates and photo URLs would just
  // burn tokens. `detourM` is only included when we have route context;
  // it's the extra walking/driving the user takes on by slotting this
  // venue between their previous and next stops.
  const compact = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    types: c.types.slice(0, 4),
    rating: c.rating,
    ratingCount: c.ratingCount,
    address: c.address,
    distanceM: c.distanceM,
    ...(routeAware && c.detourM != null ? { detourM: Math.round(c.detourM) } : {}),
    openNow: c.openNow,
    priceLevel: c.priceLevel,
    matchedIn: c.matchedQueries.length,
  }));

  const system = `You are a local-recommendation expert helping a user
pick the best venue for a specific plan. You will be given the user's
intent, the search queries used, and a candidate list from Google Maps
already pre-ranked by composite score (distance + relevance + rating
+ reviews).

Think of this as building a SHOPPING LIST of nearby options, not
curating a critics' top-pick. The user wants to see what's available
to them; they'll choose. Give them every reasonable option.

Your job:
1. SELECT picks using this exact procedure:
     STEP A — Walk every candidate in order. Mark a candidate as
     "QUALIFIED" if ALL of:
       (a) it satisfies the proximity rule below,
       (b) it is on-intent (e.g. not a bar when intent is "lunch"),
       (c) rating is null OR ≥4.0.
     STEP B — ${includeClosed
       ? 'KEEP closed venues too. The user is browsing for a possibly-later time, so "open right now" is NOT a filter here — never drop a venue just because it is currently closed.'
       : 'Apply the openNow rule (rule 3 below) to drop closed venues unless keeping them prevents under-supply.'}
     STEP C — From the remaining QUALIFIED set, output up to
     ${limit} picks. If 5 qualify, output 5. If 7 qualify, output
     ${limit}. If 2 qualify, output 2.

   Two failures you must avoid:
     • Padding with a candidate that didn't qualify in STEP A.
     • Stopping at 3 picks "because that feels enough" when 5 or 6
       candidates actually qualified. Inclusivity is the default.

2. For each pick, write ONE concise, SPECIFIC sentence on what makes
   THIS place distinct — what it is known for or best for. Draw on:
   the cuisine/specialty inferable from its name + types ("ramen
   specialist", "third-wave espresso bar", "24/7 chain pharmacy"); the
   atmosphere or who it suits ("quiet and laptop-friendly", "lively
   after-work spot", "quick grab-and-go", "good for a group"); or the
   venue's character via its price tier in WORDS when it adds meaning
   (a budget counter vs an upscale sit-down room). Make the picks read
   DIFFERENTLY from one another — the blurbs exist to help the user
   choose BETWEEN options, so contrast them.
   CRITICAL — do NOT restate anything already shown on the card: the
   numeric rating, the review count, the price $ symbols, the open/
   closed status, or the distance number. Repeating those is the single
   biggest thing to avoid — they add zero information. If location is
   relevant, paraphrase ("a short walk", "a bit out of the way").
   Never invent specifics you cannot reasonably infer from the name,
   type, or price (don't claim "free Wi-Fi", "free chargers", or "open
   24 hours" unless the data shows it or the place is genuinely well
   known for it).
3. ${includeClosed
  ? `Do NOT drop a venue for being closed right now (openNow === false).
   The user is choosing a place for a later time, so a venue that
   happens to be closed now is a perfectly valid pick. Its open/closed
   status is shown on the card — do NOT mention it in the reasoning
   sentence.`
  : `Drop venues with openNow === false UNLESS removing them would
   leave fewer than 3 picks AND the venue is exceptional (4.7+ rating
   with 200+ reviews). Open/closed status is shown to the user
   visually — do NOT mention it in the reasoning sentence.`}
4. Never invent facts you can't see in the candidate metadata.

PROXIMITY RULE — the intent type determines how strict to be:

${everyday
  ? `This is an EVERYDAY VENUE intent (restaurant, café, bar,
grocery, pharmacy, bakery, food) — something the user might do
multiple times a week and won't travel far for.
  • Strongly prefer ≤1.5 km. These should fill most slots.
  • A venue 1.5–3 km is acceptable ONLY when there are fewer than
    2 reasonable ≤1.5 km venues in the candidate list.
  • A venue >3 km is acceptable ONLY when there is ZERO reasonable
    ≤2 km venue. Popularity / fame does NOT justify the trip.
  • Returning fewer picks (3-4) is strictly better than padding
    with far venues.`
  : `This is a DESTINATION VENUE intent (gym, yoga, climbing wall,
museum, doctor, specialty store) — somewhere the user commits to
going. People pick a gym based on equipment, vibe, hours — distance
matters less.
  • Up to ~3 km is freely acceptable, no justification needed.
  • Venues 3–5 km are good options when they have strong signals:
    rating ≥4.5 OR ≥200 reviews. INCLUDE them — the user wants
    well-validated alternatives, not just the closest 3.
  • Venues 5–7 km are acceptable when they are genuinely standout:
    ≥4.6 rating AND ≥200 reviews. A famous-with-1700-mediocre-
    reviews gym (★3.6) does NOT qualify.
  • Beyond 7 km, only include if the venue is uniquely on-intent
    (e.g. the only climbing wall in the area).
  • For destinations, do NOT prefer few picks. Show every well-
    validated option — the user is choosing where to commit.`}
${routeAware
  ? `
ROUTING RULE (this OVERRIDES the proximity rule above):
The user is swapping a stop that sits BETWEEN a fixed previous stop and
a fixed next stop on their day. Each candidate carries a "detourM" field:
the EXTRA meters added to their journey by routing through this venue
instead of going straight from the previous stop to the next one.

  • detourM is THE proximity signal here — not the "distanceM" field
    (which is just distance from the old pin and may be misleading).
  • Strongly prefer LOW detourM. A venue with a small detour that's
    slightly lower-rated beats a darling that forces a long backtrack.
  • Treat detourM ≤ 400 m as "right on the way" (free to include),
    400–1200 m as "a minor detour" (fine when on-intent and well-rated),
    and > 2000 m as a zig-zag the user is trying to AVOID — only include
    it when there is no reasonable lower-detour option on-intent.
  • Order picks by a blend of low detour + quality, closest-on-the-route
    first. Never surface an unrealistic cross-town option when nearby
    on-route venues exist.`
  : ''}

A "reasonable" venue means rating ≥3.8 (or unrated) AND not visibly
inappropriate for the intent (e.g. don't pick a bar for "lunch").

VARIETY (soft preference, NOT a filter): if you have to ORDER picks,
slot a different cuisine/style near the top after the closest pick.
But you must NEVER drop a qualifying close venue just because another
similar one is already in the list. The user gets value from seeing
multiple comparable options.

Output ONLY JSON:
{ "picks": [ { "id": "...", "reasoning": "..." }, ... ] }`;

  const user = JSON.stringify({
    intent,
    queries,
    candidates: compact,
  });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      // gpt-4o-mini handles this task well at ~$0.0001 per call vs.
      // ~$0.003 for the full-size 4o. Quality difference is marginal
      // once the candidate pool is already pre-ranked by composite
      // score and the proximity rule is enforced server-side.
      model: RERANK_MODEL,
      // Temperature 0.3 gives the most consistent count + variety
      // tradeoff in our probes (0.0 is over-deterministic and
      // sometimes returns 2 picks; higher temps drift into picking
      // far popular venues over close ones).
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { picks: [], failureReason: `OpenAI ${res.status}: ${text.slice(0, 200)}` };
  }
  const completion = await res.json();
  // The discovery flow's second token cost (after parse-errand). Log it so the
  // errand system's full spend is visible from the function logs, and return it
  // so the caller can surface it on the wire.
  const usage = openaiUsage(completion?.usage);
  logTokenUsage({ fn: 'find-places', step: 'rerank', model: RERANK_MODEL, usage });
  const content: string = completion?.choices?.[0]?.message?.content ?? '{}';
  try {
    const parsed = JSON.parse(content);
    const picks = Array.isArray(parsed?.picks) ? parsed.picks : [];
    return {
      picks: picks
        .map((p: any) => ({
          id: typeof p?.id === 'string' ? p.id : '',
          reasoning: typeof p?.reasoning === 'string' ? p.reasoning : undefined,
        }))
        .filter((p: any) => p.id),
      usage,
    };
  } catch {
    return { picks: [], failureReason: 'invalid JSON', usage };
  }
}

// --------------------------------------------------- Post-AI cleanup helpers
//
// gpt-4o-mini doesn't always follow prompt instructions about
// formatting and proximity. These helpers enforce the contract
// deterministically so a stray model output can't break the UX.

/** Strip patterns the AI keeps hallucinating despite the prompt. */
function scrubReasoning(s: string | undefined): string | undefined {
  if (!s) return s;
  let out = s.trim();
  // Closed-status is shown by a UI badge; the AI sometimes still
  // prefixes "Closed now — " (even when the place is actually open,
  // which is a factual error). Strip the prefix unconditionally.
  out = out.replace(/^closed\s+now\s*[—-]\s*/i, '');
  // Same family: "Currently closed — "
  out = out.replace(/^currently\s+closed\s*[—-]\s*/i, '');
  return out;
}

/** Heuristic: does the intent describe a routine, walk-to-it venue? Includes
 *  everyday SHOPS (drugstore/drogerie, supermarket, convenience, chemist) — a
 *  Domestos/toiletries run is a quick local errand, not a destination you'd
 *  travel 3 km for, so it must get the strict ≤1.5 km proximity rule below. */
function isEverydayIntent(intent: string, queries: string[]): boolean {
  const haystack = [intent, ...queries].join(' ').toLowerCase();
  return /\b(restaurant|food|dinner|lunch|brunch|breakfast|cafe|café|coffee|bar|pub|bistro|grocery|grocer|supermarket|hypermarket|convenience|pharmacy|drugstore|drogerie|chemist|toiletr\w*|household|bakery|eat|drink|takeout|takeaway)\b/.test(
    haystack,
  );
}

// ------------------------------------------------------- Google high-level API

async function searchGoogle(
  queries: string[],
  intent: string,
  lat: number,
  lon: number,
  radiusM: number,
  limit: number,
  apiKey: string,
  openaiKey: string | undefined,
  route?: { prev?: Coords; next?: Coords },
  /** Discovery browsing: don't drop venues that are closed right now. */
  includeClosed = false,
): Promise<{
  provider: 'google';
  places: UnifiedPlace[];
  /** Token spend for the re-rank pass; absent when the model wasn't called. */
  usage?: TokenUsage;
  debug: {
    perQueryCounts: Record<string, number>;
    candidatePoolSize: number;
    aiUsed: boolean;
    aiFailureReason?: string;
    routeAware?: boolean;
    biasCenter?: Coords;
    searchRadiusM?: number;
  };
}> {
  // Everyday-vs-destination drives composite weighting, the AI's
  // proximity rule, and code-side safety nets. Compute once, pass
  // everywhere.
  const everyday = isEverydayIntent(intent, queries);

  // Route context (place-swap browser): bias the candidate pool to the
  // CORRIDOR between the previous and next stops, not the old pin. This
  // is what keeps a swap from surfacing cross-town venues that would
  // make the day zig-zag. `distRef` stays the old venue so the distance
  // shown in the UI still reads as "distance from the spot you replaced".
  const current: Coords = { latitude: lat, longitude: lon };
  const prev = route?.prev;
  const next = route?.next;
  const routeAware = !!(prev || next);

  let biasCenter: Coords = current;
  let searchRadius = radiusM;
  if (prev && next) {
    biasCenter = midpoint(prev, next);
    // Widen just enough to cover both ends of the corridor plus a buffer
    // so good on-route venues near either stop stay in the pool.
    searchRadius = clampRadius(Math.max(radiusM, distM(prev, next) / 2 + 1200));
  } else if (prev) {
    biasCenter = midpoint(prev, current);
    searchRadius = clampRadius(Math.max(radiusM, distM(prev, current) / 2 + 1200));
  } else if (next) {
    biasCenter = midpoint(next, current);
    searchRadius = clampRadius(Math.max(radiusM, distM(next, current) / 2 + 1200));
  }

  const { candidates, perQueryCounts } = await searchGoogleFanOut(
    queries,
    biasCenter,
    current,
    searchRadius,
    apiKey,
    everyday,
    routeAware ? { prev, next } : undefined,
    20,
    includeClosed,
  );

  if (candidates.length === 0) {
    return {
      provider: 'google',
      places: [],
      debug: { perQueryCounts, candidatePoolSize: 0, aiUsed: false },
    };
  }

  // No OpenAI key → return the top `limit` by composite score as-is.
  if (!openaiKey) {
    return {
      provider: 'google',
      places: candidates.slice(0, limit).map(stripScoringFields),
      debug: {
        perQueryCounts,
        candidatePoolSize: candidates.length,
        aiUsed: false,
        aiFailureReason: 'no OPENAI_API_KEY',
      },
    };
  }

  // With OpenAI → ask the model to pick + reason.
  const llm = await analyzeWithLLM(
    intent,
    queries,
    candidates,
    limit,
    openaiKey,
    everyday,
    routeAware,
    includeClosed,
  );
  if (llm.picks.length === 0) {
    return {
      provider: 'google',
      places: candidates.slice(0, limit).map(stripScoringFields),
      // Tokens were still spent reaching the model even though it gave no picks.
      usage: llm.usage,
      debug: {
        perQueryCounts,
        candidatePoolSize: candidates.length,
        aiUsed: false,
        aiFailureReason: llm.failureReason ?? 'model returned no picks',
      },
    };
  }

  // Apply the model's picks. Order = the order the model returned.
  // We *do not* top up with composite-ranked filler if the AI returned
  // fewer picks than `limit` — when the model says "5 is enough", the
  // user gets 5 confident picks rather than 5 confident + 1 awkward
  // unjustified extra. The AI's prompt explicitly instructs it to
  // return fewer rather than include filler.
  const byId = new Map(candidates.map((c) => [c.id, c]));
  let picked: UnifiedPlace[] = [];
  for (const pick of llm.picks) {
    const c = byId.get(pick.id);
    if (!c) continue;
    picked.push({
      ...stripScoringFields(c),
      reasoning: scrubReasoning(pick.reasoning),
    });
    if (picked.length >= limit) break;
  }

  // Code-side proximity + completeness safety net. The AI is erratic
  // in two opposing ways:
  //   - sometimes pads with a famous-but-distant venue when great
  //     close picks exist (the "U Prince 5 km" problem for dinner),
  //   - sometimes drops great close picks and returns only the
  //     famous-but-distant venues directly.
  //
  // For EVERYDAY intents (restaurant, café, …) the rule is strict:
  // anything >3 km is fallback only — drop it when close alternatives
  // exist, then top up from the close pool.
  //
  // For COMMUTE-WORTHY intents (gym, yoga, museum, …) the rule is
  // looser. The "qualifying" pool extends to 5 km, and we explicitly
  // include WELL-VALIDATED far venues (≥4.5 rating AND ≥200 reviews)
  // up to 7.5 km — those are exactly the "yes I'll commute for this"
  // options the user wants to see surfaced.

  // The axis the safety net reasons about. With route context it's the
  // DETOUR (extra meters added to the path); otherwise raw distance from
  // the venue. detourById lets us look the value back up for AI picks,
  // which have been stripped of scoring fields.
  const detourById = new Map(candidates.map((c) => [c.id, c.detourM]));
  const proximityOf = (id: string, distanceM: number): number => {
    if (routeAware) {
      const d = detourById.get(id);
      if (d != null) return d;
    }
    return distanceM;
  };

  // Thresholds: detour bites sooner than absolute distance — a 1.5 km
  // backtrack for an everyday stop is already a real zig-zag.
  const proxLimit = routeAware
    ? everyday
      ? 1500
      : 3000
    : everyday
    ? 2500
    : 5000;
  const dropLimit = routeAware ? (everyday ? 2200 : 4000) : 3000;

  const closePool = candidates.filter(
    (c) =>
      proximityOf(c.id, c.distanceM) <= proxLimit &&
      (c.rating === null || c.rating >= 4.0) &&
      (includeClosed || c.openNow !== false),
  );
  // Well-validated far pool — only used for non-everyday intents WITHOUT
  // route context. When we have a corridor, surfacing a far-detour venue
  // contradicts the whole point (anti-zig-zag), so we skip it.
  const wellValidatedFarPool = everyday || routeAware
    ? []
      : candidates.filter(
          (c) =>
            c.distanceM > proxLimit &&
            c.distanceM <= 7500 &&
            (c.rating ?? 0) >= 4.5 &&
            (c.ratingCount ?? 0) >= 200 &&
            (includeClosed || c.openNow !== false),
        );

  // Drop AI picks that backtrack too far when on-route/close alternatives
  // exist. For route-aware swaps this applies to BOTH intent types — a
  // zig-zag is undesirable whether it's a café or a gym.
  if (closePool.length > 0 && (everyday || routeAware)) {
    picked = picked.filter((p) => proximityOf(p.id, p.distanceM) <= dropLimit);
  }

  // Top up from the close pool when AI under-included. For non-
  // everyday intents we also fold in well-validated far venues so
  // they don't fall through the cracks.
  const supplementPool = [...closePool, ...wellValidatedFarPool];
  const desiredMin = Math.min(
    limit,
    Math.max(3, supplementPool.length),
  );
  if (picked.length < desiredMin) {
    const pickedIds = new Set(picked.map((p) => p.id));
    for (const c of supplementPool) {
      if (picked.length >= desiredMin) break;
      if (pickedIds.has(c.id)) continue;
      picked.push(stripScoringFields(c));
      pickedIds.add(c.id);
    }
  }

  // Edge case: AI returned 0 picks (very rare — would mean model
  // hallucinated all ids). Fall back to composite-ranked list so the
  // user still sees results instead of an empty state.
  if (picked.length === 0) {
    return {
      provider: 'google',
      places: candidates.slice(0, limit).map(stripScoringFields),
      usage: llm.usage,
      debug: {
        perQueryCounts,
        candidatePoolSize: candidates.length,
        aiUsed: false,
        aiFailureReason: 'model returned only invalid ids',
      },
    };
  }

  return {
    provider: 'google',
    places: picked,
    usage: llm.usage,
    debug: {
      perQueryCounts,
      candidatePoolSize: candidates.length,
      aiUsed: true,
      routeAware,
      biasCenter,
      searchRadiusM: searchRadius,
    },
  };
}

function stripScoringFields(c: ScoredCandidate): UnifiedPlace {
  const { bestPosition, matchCount, compositeScore, matchedQueries, detourM, ...rest } = c;
  return rest;
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
  // `nwr` matches node|way|relation in a single statement, which halves
  // the number of clauses Overpass has to parse compared to listing
  // `node...` and `way...` separately. Internal timeout dropped from 15s
  // to 10s — we'd rather have the server give up early and let us fall
  // back to another mirror than hold a TCP connection for 15s.
  const around = `(around:${radiusM},${lat},${lon})`;
  const parts = filters.map((f) => `nwr${f}${around};`).join('');
  return `[out:json][timeout:10];(${parts});out center 30;`;
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

// Public Overpass mirrors, ordered by observed reliability *right now*.
// Public Overpass mirrors are notoriously volatile (regularly rate-limit
// cloud egress IPs, get DDoSed, get overloaded by OSM contributor scripts)
// so we always race a few of them and take the first 2xx response.
//
// Lessons learned during this iteration:
//   - overpass-api.de       : canonical instance, fast (~0.6s) for typical
//                             radius=2.5km queries. Returns 406 unless
//                             Accept includes "*/*" — see fetchOverpass().
//   - lz4.overpass-api.de   : backup of the canonical, currently times out
//                             (504 from their reverse proxy) but worth
//                             keeping as a tertiary.
//   - overpass.kumi.systems : usually top-tier, currently timing out;
//                             expected to recover.
//   - overpass.private.coffee : EU mirror, currently timing out.
//   - overpass.osm.ch       : DROPPED — returns 200 with an empty dataset
//                             (`elements: []` for *every* query), which
//                             would silently masquerade as "no results".
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

const OVERPASS_PER_TRY_MS = 9000;
const OVERPASS_RETRY_DELAY_MS = 250;

async function fetchOverpass(
  endpoint: string,
  body: string,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERPASS_PER_TRY_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // overpass-api.de rejects POSTs that don't accept "*/*" — using
        // "application/json" alone earns a 406. Send both.
        Accept: 'application/json, */*;q=0.1',
        // Some mirrors require an identifying User-Agent. Keep it short
        // but real so we don't get rejected as a bot.
        'User-Agent': 'DayFlow/0.1.0 (https://github.com/dayflow)',
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      // Try to read a snippet of the body so we can identify what the
      // mirror disliked (e.g. 429 with backoff hint).
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 120);
      } catch {
        // ignore
      }
      throw new Error(
        `HTTP ${res.status}${detail ? ` ${detail}` : ''} from ${endpoint}`,
      );
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race every mirror in parallel and resolve with the first 2xx body.
 * Rejects only when *all* mirrors fail (timeout, non-2xx, network).
 */
function raceOverpass(body: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const errors: string[] = [];
    let remaining = OVERPASS_ENDPOINTS.length;
    let settled = false;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      fetchOverpass(endpoint, body)
        .then((json) => {
          if (settled) return;
          settled = true;
          resolve(json);
        })
        .catch((e) => {
          errors.push(`${endpoint}: ${String(e?.message ?? e)}`);
          remaining -= 1;
          if (remaining === 0 && !settled) {
            settled = true;
            reject(new Error(errors.join(' | ')));
          }
        });
    }
  });
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
  const body = `data=${encodeURIComponent(overpassQL)}`;

  // First round: race mirrors. If all fail, give them a short breath
  // and retry once. In practice the public Overpass mirrors warm up
  // within ~200ms — a single retry catches the majority of intermittent
  // aborts without blowing past the function's 25s budget.
  let data: any;
  try {
    data = await raceOverpass(body);
  } catch (firstError) {
    await new Promise((r) => setTimeout(r, OVERPASS_RETRY_DELAY_MS));
    try {
      data = await raceOverpass(body);
    } catch (secondError) {
      throw new Error(
        `Overpass unavailable after retry. Round 1: ${String(
          (firstError as Error).message,
        )} || Round 2: ${String((secondError as Error).message)}`,
      );
    }
  }

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
    queries?: string[];
    intent?: string;
    latitude?: number;
    longitude?: number;
    radiusM?: number;
    limit?: number;
    /** Previous located stop (place-swap browser) — anchors the corridor. */
    prev?: { latitude?: number; longitude?: number } | null;
    /** Next located stop (place-swap browser) — anchors the corridor. */
    next?: { latitude?: number; longitude?: number } | null;
    /**
     * Discovery browsing: keep venues that are CLOSED right now. The user is
     * choosing a place for a possibly-later time, so "open now" must not hide
     * options — open/closed status is shown on each card, never used to filter.
     */
    includeClosed?: boolean;
  };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  // Normalize queries: prefer the `queries` array, fall back to the
  // legacy single `query` field. Trim, dedupe (case-insensitive), and
  // cap at 6 — that's the upper bound the LLM produces, and beyond
  // that the marginal API cost outweighs the marginal coverage gain.
  const rawQueries = Array.isArray(payload.queries)
    ? payload.queries
    : typeof payload.query === 'string'
    ? [payload.query]
    : [];
  const seen = new Set<string>();
  const queries = rawQueries
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter((q) => {
      if (!q) return false;
      const k = q.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);

  const intent =
    (typeof payload.intent === 'string' && payload.intent.trim()) ||
    queries[0] ||
    '';

  // Locale-aware rewrite of the queries actually sent to the provider
  // (household/drugstore → drogerie). `queries` (the original words) is kept for
  // intent, category detection, and the response so the UI/debug stay truthful.
  const searchQueries = expandLocalizedQueries(queries);

  const lat = Number(payload.latitude);
  const lon = Number(payload.longitude);
  if (
    queries.length === 0 ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return jsonResponse(
      { error: 'queries (or query), latitude, and longitude are required.' },
      400,
    );
  }

  const radiusM = Math.min(
    10000,
    Math.max(200, Number(payload.radiusM) || 5000),
  );
  const limit = Math.min(20, Math.max(1, Number(payload.limit) || 6));
  // Discovery browsing opts out of the "open now" filter entirely (see field
  // doc above). Place-swap / compose callers leave it false to keep the
  // existing behaviour of preferring venues that are currently open.
  const includeClosed = payload.includeClosed === true;

  // Optional route context from the place-swap browser. Both stops are
  // validated independently — a single bad coord just disables that side
  // of the corridor rather than failing the whole request.
  const parseCoords = (
    c: { latitude?: number; longitude?: number } | null | undefined,
  ): Coords | undefined => {
    if (!c) return undefined;
    const la = Number(c.latitude);
    const lo = Number(c.longitude);
    if (
      !Number.isFinite(la) ||
      !Number.isFinite(lo) ||
      la < -90 ||
      la > 90 ||
      lo < -180 ||
      lo > 180
    ) {
      return undefined;
    }
    return { latitude: la, longitude: lo };
  };
  const prevCoords = parseCoords(payload.prev);
  const nextCoords = parseCoords(payload.next);

  const routeKeyPart =
    prevCoords || nextCoords
      ? `|route=${prevCoords ? `${Math.round(prevCoords.latitude * 1000) / 1000},${Math.round(prevCoords.longitude * 1000) / 1000}` : '-'}>${nextCoords ? `${Math.round(nextCoords.latitude * 1000) / 1000},${Math.round(nextCoords.longitude * 1000) / 1000}` : '-'}`
      : '';

  const cacheKey = serverCacheKey(
    queries.join('|') +
      (intent && intent !== queries[0] ? `::${intent}` : '') +
      routeKeyPart +
      (includeClosed ? '|inc' : ''),
    lat,
    lon,
    radiusM,
    limit,
  );
  const cached = readServerCache(cacheKey);
  if (cached) {
    return jsonResponse(cached, 200, {
      'X-Cache': 'hit',
      'Cache-Control': 'public, max-age=300',
    });
  }

  const googleKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  const fsqKey = Deno.env.get('FOURSQUARE_API_KEY');

  // Foursquare / OSM fallbacks still need our regex-based category
  // mapping. Use the first query to detect category.
  const category = resolveCategory(queries[0]);

  if (!googleKey && !fsqKey && !category) {
    return jsonResponse({
      query: queries[0],
      queries,
      intent,
      provider: 'none',
      category: null,
      places: [],
      note:
        'No place provider available for these queries. Either configure ' +
        'a GOOGLE_PLACES_API_KEY (handles any query) or add a category ' +
        'mapping for the OSM fallback.',
    });
  }

  try {
    let result: {
      provider: string;
      places: UnifiedPlace[];
      usage?: TokenUsage;
      debug?: Record<string, unknown>;
    };
    if (googleKey) {
      result = await searchGoogle(
        searchQueries,
        intent,
        lat,
        lon,
        radiusM,
        limit,
        googleKey,
        openaiKey,
        prevCoords || nextCoords
          ? { prev: prevCoords, next: nextCoords }
          : undefined,
        includeClosed,
      );
    } else if (fsqKey && category) {
      result = await searchFoursquare(
        queries[0],
        lat,
        lon,
        radiusM,
        limit,
        fsqKey,
        category,
      );
    } else if (category) {
      result = await searchOverpass(
        queries[0],
        lat,
        lon,
        radiusM,
        limit,
        category,
      );
    } else {
      return jsonResponse(
        { query: queries[0], provider: 'none', category: null, places: [] },
        200,
      );
    }
    const body = {
      query: queries[0],
      queries,
      intent,
      provider: result.provider,
      category: category?.category ?? null,
      places: result.places,
      debug: result.debug,
      // Token spend for THIS call (model + counts), or null when no LLM ran
      // (Foursquare/OSM/no key). Cached as null on purpose — a later cache HIT
      // serves this body without spending any tokens, so it must not re-report
      // the original call's usage.
      usage: null,
    };
    if (result.places.length > 0) writeServerCache(cacheKey, body);
    const liveUsage = result.usage
      ? { model: RERANK_MODEL, ...result.usage }
      : null;
    return jsonResponse({ ...body, usage: liveUsage }, 200, {
      'X-Cache': 'miss',
      'Cache-Control': 'public, max-age=300',
    });
  } catch (e) {
    return jsonResponse(
      { error: 'Place search failed', detail: String(e) },
      502,
    );
  }
});
