// Supabase Edge Function: search-places
//
// A forgiving address + place finder for location pickers (e.g. the "start
// address" / "end address" fields in the day planner). Unlike `find-places`
// — which AI-curates venues near the user for a plan — this endpoint is a
// plain type-ahead that returns BOTH establishments and street addresses,
// exactly like the Google Maps search box.
//
// It uses Google Places API (New):
//   - places:autocomplete  → forgiving predictions (handles partials /
//                            misspellings) mixing venues + addresses.
//   - places:searchText    → fallback when autocomplete returns nothing for a
//                            full, slightly-wrong string ("pirktova" → the
//                            "Pikrtova" street; "kolkovna pankrac" → the venue).
//   - places/{placeId}     → resolves a chosen prediction to coordinates.
//
// Two modes, picked by the request body:
//   { input, latitude?, longitude?, sessionToken? }  → autocomplete
//   { placeId, sessionToken? }                       → details (resolve)
//
// Response shape:
//   autocomplete → { provider, predictions: [{ placeId, primary, secondary }] }
//   details      → { provider, place: { placeId, label, name, address, latitude,
//                    longitude, photoUrl, rating, ratingCount, priceLevel,
//                    openNow, openingHours } | null }
//
// When GOOGLE_PLACES_API_KEY is absent we return { provider: 'none' } so the
// client can transparently fall back to its own Nominatim search.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
      ...(extraHeaders ?? {}),
    },
  });
}

interface Prediction {
  placeId: string;
  primary: string;
  secondary: string;
}

// --------------------------------------------------------- opening hours
//
// Compacted from ../_shared/hours.ts so this stays a single self-contained
// file (it's deployed standalone). Maps a Google place's hours into our
// { periods, weekdayDescriptions } shape; the client mirrors the period math
// to judge "open at the errand's time".

interface VenueOpenPeriod {
  open: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
}

function mapPeriods(src: any): VenueOpenPeriod[] {
  const periods = Array.isArray(src?.periods) ? src.periods : [];
  const out: VenueOpenPeriod[] = [];
  for (const p of periods) {
    const o = p?.open;
    if (!o || typeof o.day !== 'number') continue;
    const open = {
      day: o.day,
      hour: typeof o.hour === 'number' ? o.hour : 0,
      minute: typeof o.minute === 'number' ? o.minute : 0,
    };
    const c = p?.close;
    if (c && typeof c.day === 'number') {
      out.push({
        open,
        close: {
          day: c.day,
          hour: typeof c.hour === 'number' ? c.hour : 0,
          minute: typeof c.minute === 'number' ? c.minute : 0,
        },
      });
    } else {
      out.push({ open });
    }
  }
  return out;
}

function extractOpeningHours(
  p: any,
): { periods: VenueOpenPeriod[]; weekdayDescriptions?: string[] } | null {
  const regular = p?.regularOpeningHours;
  const current = p?.currentOpeningHours;
  let periods = mapPeriods(regular);
  if (periods.length === 0) periods = mapPeriods(current);
  if (periods.length === 0) return null;
  const weekdayDescriptions =
    (Array.isArray(regular?.weekdayDescriptions) && regular.weekdayDescriptions.length
      ? regular.weekdayDescriptions
      : Array.isArray(current?.weekdayDescriptions) && current.weekdayDescriptions.length
        ? current.weekdayDescriptions
        : undefined) || undefined;
  return weekdayDescriptions ? { periods, weekdayDescriptions } : { periods };
}

/** Resolve a Google photo resource name to a long-lived CDN URL. */
async function resolvePhoto(
  photoName: string | undefined,
  apiKey: string,
): Promise<string | null> {
  if (!photoName) return null;
  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?key=${apiKey}&maxHeightPx=600&maxWidthPx=600&skipHttpRedirect=true`,
    );
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.photoUri === 'string' ? json.photoUri : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- autocomplete

async function autocomplete(
  input: string,
  apiKey: string,
  center: { latitude: number; longitude: number } | null,
  sessionToken: string | undefined,
): Promise<Prediction[]> {
  const body: Record<string, unknown> = {
    input,
    languageCode: 'en',
    ...(sessionToken ? { sessionToken } : {}),
    // A wide bias nudges nearby results to the top without hiding far ones,
    // so "home street" wins when the user is standing on it but a place in
    // another city is still findable.
    ...(center
      ? {
          locationBias: {
            circle: {
              center: { latitude: center.latitude, longitude: center.longitude },
              radius: 50000,
            },
          },
        }
      : {}),
  };

  const res = await fetch(
    'https://places.googleapis.com/v1/places:autocomplete',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google Autocomplete ${res.status}: ${detail.slice(0, 240)}`);
  }
  const data = await res.json();
  const suggestions: any[] = Array.isArray(data?.suggestions)
    ? data.suggestions
    : [];

  return suggestions
    .map((s) => s?.placePrediction)
    .filter((p) => p && typeof p.placeId === 'string')
    .map<Prediction>((p) => {
      const primary =
        p?.structuredFormat?.mainText?.text ?? p?.text?.text ?? '';
      const secondary = p?.structuredFormat?.secondaryText?.text ?? '';
      return { placeId: p.placeId, primary, secondary };
    })
    .filter((p) => p.primary);
}

// ----------------------------------------------------- text search fallback
//
// Autocomplete is tuned for INCREMENTAL typing and is strict about spelling: a
// full, AI-extracted string like "pirktova" (a typo for the street "Pikrtova")
// or "kolkovna pankrac" (venue + area) returns ZERO place predictions — Google
// hands back "query predictions" instead, which aren't pinnable. Text Search
// (the same API `find-places` uses) is far more forgiving for whole queries and
// returns BOTH venues and addresses, so we fall back to it whenever
// autocomplete comes up empty. This is what makes "at <slightly-wrong place>"
// actually resolve to a real pin.

async function textSearch(
  input: string,
  apiKey: string,
  center: { latitude: number; longitude: number } | null,
): Promise<Prediction[]> {
  const body: Record<string, unknown> = {
    textQuery: input,
    languageCode: 'en',
    maxResultCount: 6,
    ...(center
      ? {
          locationBias: {
            circle: {
              center: { latitude: center.latitude, longitude: center.longitude },
              radius: 50000,
            },
          },
        }
      : {}),
  };

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google Text Search ${res.status}: ${detail.slice(0, 240)}`);
  }
  const data = await res.json();
  const places: any[] = Array.isArray(data?.places) ? data.places : [];

  return places
    .filter((p) => p && typeof p.id === 'string')
    .map<Prediction>((p) => {
      const name = typeof p?.displayName?.text === 'string' ? p.displayName.text : '';
      const addr =
        (typeof p?.shortFormattedAddress === 'string' ? p.shortFormattedAddress : '') ||
        (typeof p?.formattedAddress === 'string' ? p.formattedAddress : '');
      // Prefer the venue name as the headline; for a plain address the name IS
      // the address, so don't repeat it on the secondary line.
      const primary = name || addr;
      const secondary = name ? addr : '';
      return { placeId: p.id, primary, secondary };
    })
    .filter((p) => p.primary);
}

// ------------------------------------------------------------------- details

interface PlaceDetails {
  placeId: string | null;
  label: string;
  name: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
  // Rich venue metadata — what makes the picked place show a photo, rating,
  // and opening hours instead of a bare label.
  photoUrl: string | null;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null;
  openNow: boolean | null;
  openingHours: { periods: VenueOpenPeriod[]; weekdayDescriptions?: string[] } | null;
}

async function details(
  placeId: string,
  apiKey: string,
  sessionToken: string | undefined,
): Promise<PlaceDetails | null> {
  const url =
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}` +
    (sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '');
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask':
        'id,displayName,formattedAddress,shortFormattedAddress,location,' +
        'rating,userRatingCount,priceLevel,photos,' +
        'currentOpeningHours.openNow,currentOpeningHours.periods,currentOpeningHours.weekdayDescriptions,' +
        'regularOpeningHours.periods,regularOpeningHours.weekdayDescriptions',
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google Place Details ${res.status}: ${detail.slice(0, 240)}`);
  }
  const p = await res.json();
  const lat = p?.location?.latitude;
  const lon = p?.location?.longitude;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const name = typeof p?.displayName?.text === 'string' ? p.displayName.text : null;
  const address =
    (typeof p?.shortFormattedAddress === 'string'
      ? p.shortFormattedAddress
      : null) ??
    (typeof p?.formattedAddress === 'string' ? p.formattedAddress : null);
  // Prefer the venue name; for a plain address the name IS the address.
  const label = name ?? address ?? 'Selected location';
  const photoUrl = await resolvePhoto(p?.photos?.[0]?.name, apiKey);
  return {
    placeId: typeof p?.id === 'string' ? p.id : null,
    label,
    name,
    address,
    latitude: lat,
    longitude: lon,
    photoUrl,
    rating: typeof p?.rating === 'number' ? p.rating : null,
    ratingCount: typeof p?.userRatingCount === 'number' ? p.userRatingCount : null,
    priceLevel:
      p?.priceLevel === 'PRICE_LEVEL_INEXPENSIVE'
        ? 1
        : p?.priceLevel === 'PRICE_LEVEL_MODERATE'
        ? 2
        : p?.priceLevel === 'PRICE_LEVEL_EXPENSIVE'
        ? 3
        : p?.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE'
        ? 4
        : null,
    openNow:
      typeof p?.currentOpeningHours?.openNow === 'boolean'
        ? p.currentOpeningHours.openNow
        : null,
    openingHours: extractOpeningHours(p),
  };
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
    input?: string;
    placeId?: string;
    latitude?: number;
    longitude?: number;
    sessionToken?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
  if (!apiKey) {
    // No provider — client falls back to Nominatim.
    return jsonResponse({ provider: 'none', predictions: [], place: null });
  }

  const sessionToken =
    typeof payload.sessionToken === 'string' ? payload.sessionToken : undefined;

  try {
    // DETAILS mode — resolve a chosen prediction to coordinates.
    if (typeof payload.placeId === 'string' && payload.placeId.trim()) {
      const place = await details(payload.placeId.trim(), apiKey, sessionToken);
      return jsonResponse({ provider: 'google', place });
    }

    // AUTOCOMPLETE mode.
    const input = typeof payload.input === 'string' ? payload.input.trim() : '';
    if (input.length < 2) {
      return jsonResponse({ provider: 'google', predictions: [] });
    }
    const lat = Number(payload.latitude);
    const lon = Number(payload.longitude);
    const center =
      Number.isFinite(lat) && Number.isFinite(lon)
        ? { latitude: lat, longitude: lon }
        : null;

    let predictions = await autocomplete(input, apiKey, center, sessionToken);
    // Autocomplete drew a blank (typo'd street, "venue + area", etc.) — retry
    // with the forgiving Text Search so the place still resolves to a real pin.
    if (predictions.length === 0 && input.length >= 3) {
      try {
        predictions = await textSearch(input, apiKey, center);
      } catch {
        // Keep the empty autocomplete result; client falls back to Nominatim.
      }
    }
    return jsonResponse({ provider: 'google', predictions });
  } catch (e) {
    return jsonResponse(
      { error: 'Place search failed', detail: String(e) },
      502,
    );
  }
});
