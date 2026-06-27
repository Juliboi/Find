// Supabase Edge Function: discover-curate
//
// The "knowledgeable concierge" behind discovery queries that a literal Google
// Text Search can't answer well — the ones that need WORLD KNOWLEDGE or a
// CURATED opinion rather than a category match:
//
//   "michelin restaurant near Olomouc"   → Entrée (the one Michelin spot there)
//   "interesting restaurants in Prague"  → a hand-picked, not-generic shortlist
//   "most popular clubs in Prague"        → the actually-famous nightclubs
//   "where to take my gf for anniversary" → romantic, special-occasion venues
//
// A plain Text Search of those literal words returns junk: Google keys off the
// category word, so "interesting"/"most popular"/"michelin"/"anniversary" either
// match nothing useful or surface random places. So we run TWO stages:
//
//   1. CURATE (Gemini + Google Search grounding): a search-grounded model reads
//      the request and names up to N SPECIFIC, real, currently-operating venues
//      that genuinely fit it, best-first, each with a one-line "why". This is the
//      world knowledge / web step the bare Places API lacks.
//
//   2. GROUND (Google Places Text Search): every named venue is resolved to a
//      real place — coordinates, rating, price, photo, opening hours — so it
//      renders as a normal discovery card and slots into the day like any other
//      pick. Names the model invents or that no longer exist simply drop out.
//
// The response shape is the SAME `{ provider, query, places: [...] }` that
// `find-places` returns, so the client treats curated and ordinary discovery
// identically. On any failure (no key, model error, nothing found) we return an
// empty list with a `reason` and the caller transparently falls back to the
// plain `find-places` path.
//
// Env:
//   GEMINI_API_KEY          — Google AI Studio key (shared with parse-errand).
//   GEMINI_DISCOVER_MODEL   — optional; defaults to gemini-2.5-flash (grounding-
//                             capable; flash-lite tiers don't support the tool).
//   GOOGLE_PLACES_API_KEY   — Places API (New) key, same one find-places uses.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import { extractOpeningHours, type VenueOpeningHours } from '../_shared/hours.ts';
import { geminiUsage, logTokenUsage, type TokenUsage } from '../_shared/tokenLog.ts';

// Grounding REQUIRES a model + tier that supports the google_search tool. The
// cheap flash-lite tiers used elsewhere (parse-errand) do NOT, so default to
// full flash and let an env override pick a newer tier if desired.
const DEFAULT_DISCOVER_MODEL = 'gemini-2.5-flash';
const DISCOVER_MODEL =
  Deno.env.get('GEMINI_DISCOVER_MODEL') ?? DEFAULT_DISCOVER_MODEL;

interface Coords {
  latitude: number;
  longitude: number;
}

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
  openingHours?: VenueOpeningHours | null;
  /** The concierge's one-line pitch for why this place fits the request. */
  reasoning?: string;
}

// --------------------------------------------------------------- http helpers

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

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function extractJsonObject(text: string): any | null {
  if (!text) return null;
  const fenced = text.replace(/```json\s*|\s*```/g, '');
  const match = fenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- stage 1: curate
//
// A search-grounded Gemini call that turns the request into a ranked list of
// named venues. Grounding (the google_search tool) is what lets it answer
// "michelin near Olomouc" or "most popular clubs in Prague" with real, current
// places — but grounding is INCOMPATIBLE with responseSchema, so we ask for
// JSON in the prompt and parse it out of the (possibly prose-wrapped) answer.

interface CuratedVenue {
  name: string;
  locality: string | null;
  why: string | null;
}

function buildCuratePrompt(args: {
  phrase: string;
  area: string | null;
  nearLabel: string | null;
  center: Coords | null;
  want: number;
}): string {
  const { phrase, area, nearLabel, center, want } = args;
  const areaLine = area?.trim()
    ? area.trim()
    : nearLabel?.trim()
    ? nearLabel.trim()
    : 'not specified — infer the city from the coordinates below';
  const coordLine = center
    ? `${center.latitude.toFixed(4)}, ${center.longitude.toFixed(4)}`
    : 'unknown';
  return [
    `You are Diem's local discovery concierge. You turn a vague or knowledge-heavy`,
    `request into a short, CURATED list of specific real venues, using current web`,
    `knowledge (you have Google Search).`,
    ``,
    `Request: "${phrase}"`,
    `Area / city: ${areaLine}`,
    `User is near (lat,lng): ${coordLine}`,
    ``,
    `Name up to ${want} SPECIFIC, real, currently-operating venues that best`,
    `satisfy the request, BEST FIRST. Rules:`,
    `- Use real, current knowledge — search the web. Prefer places that are`,
    `  genuinely notable, popular, or acclaimed for THIS kind of request, not a`,
    `  generic category dump.`,
    `- Stay in or very near the named area/city. If no area is named, use the city`,
    `  the coordinates fall in.`,
    `- Honour explicit distinctions literally: "Michelin" → only Michelin-listed`,
    `  venues; "rooftop" → only rooftop venues; "club" → nightclubs, not bars.`,
    `- Each pick is ONE venue a person can walk into — never a neighbourhood, a`,
    `  street, or "various spots".`,
    `- If you genuinely can't find good matches, return an empty list rather than`,
    `  padding with weak guesses.`,
    ``,
    `Return ONLY this JSON object — no prose, no markdown fences:`,
    `{"venues":[{"name":"<exact venue name, no city suffix>","locality":"<city or`,
    `neighbourhood>","why":"<= 16 words on why it fits>"}],"note":"<= 12 word`,
    `summary, optional"}`,
  ].join('\n');
}

async function curateVenues(args: {
  prompt: string;
  apiKey: string;
  model: string;
}): Promise<
  | { ok: true; venues: CuratedVenue[]; note: string | null; usage: TokenUsage }
  | { ok: false; status: number; detail: string }
> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
    // Google Search grounding — the world-knowledge / "web" step. Cannot be
    // combined with responseSchema, so the prompt asks for JSON instead.
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.3 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent?key=${args.apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    return { ok: false, status: 502, detail: `Gemini fetch error: ${String(e?.message ?? e)}` };
  }
  if (!res.ok) {
    const detail = await res.text();
    return { ok: false, status: 502, detail: `Gemini ${res.status}: ${detail.slice(0, 400)}` };
  }
  const data = await res.json();
  const rawText: string = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join('')
    .trim();
  const parsed = extractJsonObject(rawText);
  if (!parsed) {
    return { ok: false, status: 502, detail: `Unparseable JSON: ${rawText.slice(0, 300)}` };
  }
  const rawVenues = Array.isArray(parsed?.venues) ? parsed.venues : [];
  const venues: CuratedVenue[] = [];
  for (const v of rawVenues) {
    const name = typeof v?.name === 'string' ? v.name.trim() : '';
    if (!name) continue;
    venues.push({
      name: name.slice(0, 120),
      locality:
        typeof v?.locality === 'string' && v.locality.trim()
          ? v.locality.trim().slice(0, 80)
          : null,
      why:
        typeof v?.why === 'string' && v.why.trim()
          ? v.why.trim().slice(0, 200)
          : null,
    });
  }
  const note =
    typeof parsed?.note === 'string' && parsed.note.trim()
      ? parsed.note.trim().slice(0, 160)
      : null;
  return { ok: true, venues, note, usage: geminiUsage(data?.usageMetadata) };
}

// ------------------------------------------------------------- stage 2: ground
//
// Resolve one named venue to a real place via Google Places Text Search. We
// bias to the user's city (a soft nudge, so a famous venue slightly outside the
// radius still resolves to the RIGHT one) and take Google's top relevance match.

async function groundVenue(
  venue: CuratedVenue,
  center: Coords,
  biasRadiusM: number,
  apiKey: string,
): Promise<UnifiedPlace | null> {
  const textQuery = venue.locality ? `${venue.name}, ${venue.locality}` : venue.name;
  let res: Response;
  try {
    res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.types,places.rating,places.userRatingCount,places.priceLevel,places.photos,places.currentOpeningHours.openNow,places.currentOpeningHours.periods,places.currentOpeningHours.weekdayDescriptions,places.regularOpeningHours.periods,places.regularOpeningHours.weekdayDescriptions',
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: 3,
        rankPreference: 'RELEVANCE',
        locationBias: {
          circle: {
            center: { latitude: center.latitude, longitude: center.longitude },
            radius: biasRadiusM,
          },
        },
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json();
  const raw: any[] = Array.isArray(data?.places) ? data.places : [];
  const p = raw[0];
  if (!p) return null;

  const elLat = p?.location?.latitude;
  const elLon = p?.location?.longitude;
  const name = p?.displayName?.text;
  if (typeof elLat !== 'number' || typeof elLon !== 'number' || !name) return null;

  let photoUrl: string | null = null;
  const photoName = p?.photos?.[0]?.name;
  if (photoName) {
    try {
      const photoRes = await fetch(
        `https://places.googleapis.com/v1/${photoName}/media?key=${apiKey}&maxHeightPx=400&maxWidthPx=400&skipHttpRedirect=true`,
      );
      if (photoRes.ok) {
        const photoJson = await photoRes.json();
        if (typeof photoJson?.photoUri === 'string') photoUrl = photoJson.photoUri;
      }
    } catch {
      // a missing photo never disqualifies a place
    }
  }

  return {
    id: typeof p.id === 'string' ? p.id : `g-${elLat},${elLon}`,
    name,
    address:
      (typeof p.shortFormattedAddress === 'string' ? p.shortFormattedAddress : null) ??
      (typeof p.formattedAddress === 'string' ? p.formattedAddress : null),
    distanceM: Math.round(haversineMeters(center.latitude, center.longitude, elLat, elLon)),
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
    reasoning: venue.why ?? undefined,
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
    query?: string;
    area?: string | null;
    nearLabel?: string | null;
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

  const phrase = typeof payload.query === 'string' ? payload.query.trim() : '';
  if (!phrase) {
    return jsonResponse({ provider: 'none', query: '', places: [], reason: 'no_results' });
  }
  const lat = Number(payload.latitude);
  const lon = Number(payload.longitude);
  const center: Coords | null =
    Number.isFinite(lat) && Number.isFinite(lon)
      ? { latitude: lat, longitude: lon }
      : null;
  const limit = Math.min(10, Math.max(1, Math.round(payload.limit ?? 8)));

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  const placesKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
  // Both stages are required for a curated result. Missing either → empty list,
  // and the client falls back to the plain find-places discovery path.
  if (!geminiKey || !placesKey) {
    return jsonResponse({
      provider: 'none',
      query: phrase,
      places: [],
      reason: 'not_configured',
      detail: !geminiKey
        ? 'GEMINI_API_KEY not configured.'
        : 'GOOGLE_PLACES_API_KEY not configured.',
    });
  }

  // Stage 1 — curate. Ask for a few more than we need so dud names that fail to
  // ground still leave us with a full list.
  const prompt = buildCuratePrompt({
    phrase,
    area: payload.area ?? null,
    nearLabel: payload.nearLabel ?? null,
    center,
    want: Math.min(12, limit + 3),
  });
  const curated = await curateVenues({ prompt, apiKey: geminiKey, model: DISCOVER_MODEL });
  if (!curated.ok) {
    return jsonResponse({
      provider: 'none',
      query: phrase,
      places: [],
      reason: 'error',
      detail: curated.detail,
    });
  }
  logTokenUsage({ fn: 'discover-curate', step: 'curate', model: DISCOVER_MODEL, usage: curated.usage });
  const usage = { model: DISCOVER_MODEL, ...curated.usage };

  if (curated.venues.length === 0) {
    return jsonResponse({
      provider: 'none',
      query: phrase,
      places: [],
      reason: 'no_results',
      note: curated.note ?? undefined,
      usage,
    });
  }

  if (!center) {
    // Without a center we can't ground/bias or compute distances. Bail to the
    // fallback — the curated names alone aren't a card list.
    return jsonResponse({
      provider: 'none',
      query: phrase,
      places: [],
      reason: 'no_location',
      note: curated.note ?? undefined,
      usage,
    });
  }

  // Stage 2 — ground every named venue in parallel. Bias generously to the
  // city so a venue just outside the requested radius still resolves correctly,
  // but keep the ranking exactly as the concierge ordered it.
  const biasRadiusM = Math.min(50000, Math.max(payload.radiusM ?? 8000, 15000));
  const grounded = await Promise.all(
    curated.venues.map((v) => groundVenue(v, center, biasRadiusM, placesKey)),
  );

  const seen = new Set<string>();
  const places: UnifiedPlace[] = [];
  for (const place of grounded) {
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    places.push(place);
    if (places.length >= limit) break;
  }

  return jsonResponse({
    provider: places.length > 0 ? 'google' : 'none',
    query: phrase,
    places,
    reason: places.length === 0 ? 'no_results' : undefined,
    note: curated.note ?? undefined,
    curated: true,
    usage,
  });
});
