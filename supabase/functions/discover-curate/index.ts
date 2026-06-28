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
//      the request and thinks like a knowledgeable local friend. It returns
//      THREE things: a flowing conversational `answer`, a best-first list of
//      specific `venues` (each with a "why"), and `tips` — options that aren't a
//      single mappable venue but still solve the need (a self-service booth, a
//      chain/category, a method). This is the world-knowledge / web step the bare
//      Places API lacks, and it is free to reason UNRESTRICTIVELY about the need.
//
//   2. GROUND (Google Places Text Search): every named `venue` is resolved to a
//      real place — coordinates, rating, price, photo, opening hours — so it
//      renders as a normal discovery card and slots into the day like any other
//      pick. Names the model invents or that no longer exist simply drop out.
//      Grounding is NON-gating: the `answer` and `tips` are returned regardless,
//      so a useful non-business answer is never lost just because nothing mapped.
//
// The response is the `find-places` shape `{ provider, query, places: [...] }`
// plus two curated extras — `answer` (the flowing summary) and `tips` (non-venue
// options) — which the client renders above/around the cards. On any failure (no
// key, model error, nothing found) we return an empty list with a `reason` and
// the caller transparently falls back to the plain `find-places` path.
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
// A search-grounded Gemini call that thinks about the user's NEED like a
// knowledgeable local friend and returns three things: a flowing `answer`, a
// best-first list of mappable `venues` (each with a "why"), and `tips` — options
// that aren't a single mappable venue but still solve the need. Grounding (the
// google_search tool) is what lets it reason about current, real-world options
// ("there's a fotoautomat in most metro stations", "any dm drogerie does this")
// — but grounding is INCOMPATIBLE with responseSchema, so we ask for JSON in the
// prompt and parse it out of the (possibly prose-wrapped) answer.

interface CuratedVenue {
  name: string;
  locality: string | null;
  why: string | null;
}

/** A non-venue option: a self-service method, a chain/category, or a tip. Not a
 *  single mappable place, so it renders as an info row rather than a pin. */
interface CuratedTip {
  title: string;
  detail: string | null;
  /** An optional map search the app can run to find the nearest instance. */
  searchQuery: string | null;
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
    `You are Diem's local discovery concierge — a knowledgeable, resourceful local`,
    `friend with live web access (Google Search). The user wants help finding a`,
    `place or solving a "where do I…" need. Think about what they ACTUALLY need —`,
    `not just the literal words — and answer the way a sharp friend would: warm,`,
    `specific, and genuinely useful.`,
    ``,
    `Request: "${phrase}"`,
    `Area / city: ${areaLine}`,
    `User is near (lat,lng): ${coordLine}`,
    ``,
    `Return THREE things:`,
    ``,
    `1. "answer": 2-4 FLOWING sentences that actually help. Lead with the best way`,
    `   to get what they need, note the trade-offs they care about (cheap / fast /`,
    `   quality), and volunteer the useful specifics a friend would know — rough`,
    `   price, typical hours, "take the metro one stop", "any dm drogerie does this".`,
    `   Conversational prose, not a list.`,
    ``,
    `2. "venues": up to ${want} SPECIFIC, real, currently-operating places the user`,
    `   can go to, BEST FIRST. These render as tappable cards they can add to their`,
    `   day, so each MUST be a single real, mappable place (a studio, shop, station,`,
    `   mall, kiosk — anything Google Maps knows). For each: exact "name", "locality"`,
    `   (city/neighbourhood), and a "why" of 1-2 sentences with the useful specifics`,
    `   (what it's best for, price/speed, what to expect). Returning FEW — even zero`,
    `   — is fine when specific venues aren't the best answer.`,
    ``,
    `3. "tips": options that are NOT a single mappable venue but still solve the`,
    `   need — a self-service option ("photo booth / fotoautomat in most metro`,
    `   stations"), a chain or category ("any dm or Rossmann drogerie"), or a method`,
    `   ("most pharmacies print passport photos in ~10 min"). Each: a short "title",`,
    `   a "detail" of 1-2 sentences, and an optional "searchQuery" the app can run on`,
    `   a map to find the nearest one ("fotoautomat", "dm drogerie"). Omit when none.`,
    ``,
    `Rules:`,
    `- Reason about the NEED. If the literal category isn't the cheapest/fastest`,
    `  answer, say so and offer the better option (a self-service booth or a`,
    `  drugstore over a pro studio for a cheap passport photo).`,
    `- Honour explicit qualities literally: "cheap"/"fast"/"quick" → prioritise the`,
    `  cheap/fast options; "Michelin" → only Michelin venues; "rooftop" → only`,
    `  rooftop venues; "club" → nightclubs, not bars.`,
    `- Stay in or very near the named area/city. If none is named, use the city the`,
    `  coordinates fall in.`,
    `- Real and current only — never invent a venue. If you are not sure a specific`,
    `  place exists, put it in "tips" as a category/method instead of "venues".`,
    `- At least ONE of "answer", "venues", or "tips" must be non-empty.`,
    ``,
    `Return ONLY this JSON object — no prose, no markdown fences:`,
    `{"answer":"<2-4 sentences>","venues":[{"name":"<exact venue name, no city`,
    `suffix>","locality":"<city or neighbourhood>","why":"<1-2 sentences>"}],`,
    `"tips":[{"title":"<short label>","detail":"<1-2 sentences>","searchQuery":`,
    `"<optional map search, or omit>"}]}`,
  ].join('\n');
}

async function curateVenues(args: {
  prompt: string;
  apiKey: string;
  model: string;
}): Promise<
  | {
      ok: true;
      venues: CuratedVenue[];
      tips: CuratedTip[];
      answer: string | null;
      usage: TokenUsage;
    }
  | { ok: false; status: number; detail: string }
> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
    // Google Search grounding — the world-knowledge / "web" step. Cannot be
    // combined with responseSchema, so the prompt asks for JSON instead.
    tools: [{ google_search: {} }],
    // A touch warmer than the slot-filler: the concierge writes prose + reasons
    // about the need, so a little creative range helps without losing accuracy.
    generationConfig: { temperature: 0.4 },
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
      // Allow 1-2 sentences now (was a 16-word fragment) so the card blurb can
      // carry the useful specifics the user actually wanted.
      why:
        typeof v?.why === 'string' && v.why.trim()
          ? v.why.trim().slice(0, 320)
          : null,
    });
  }
  const rawTips = Array.isArray(parsed?.tips) ? parsed.tips : [];
  const tips: CuratedTip[] = [];
  for (const tp of rawTips) {
    const title = typeof tp?.title === 'string' ? tp.title.trim() : '';
    if (!title) continue;
    tips.push({
      title: title.slice(0, 120),
      detail:
        typeof tp?.detail === 'string' && tp.detail.trim()
          ? tp.detail.trim().slice(0, 320)
          : null,
      searchQuery:
        typeof tp?.searchQuery === 'string' && tp.searchQuery.trim()
          ? tp.searchQuery.trim().slice(0, 80)
          : null,
    });
    if (tips.length >= 5) break;
  }
  const answer =
    typeof parsed?.answer === 'string' && parsed.answer.trim()
      ? parsed.answer.trim().slice(0, 700)
      : null;
  return { ok: true, venues, tips, answer, usage: geminiUsage(data?.usageMetadata) };
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

  // The concierge produced nothing usable at all — bail so the caller falls back
  // to the plain category search.
  if (curated.venues.length === 0 && curated.tips.length === 0 && !curated.answer) {
    return jsonResponse({
      provider: 'none',
      query: phrase,
      places: [],
      reason: 'no_results',
      usage,
    });
  }

  // Stage 2 — ground every named venue in parallel. Bias generously to the city
  // so a venue just outside the requested radius still resolves correctly, but
  // keep the ranking exactly as the concierge ordered it. Grounding is
  // NON-gating: a venue that won't resolve to a Maps place simply doesn't become
  // a card — the `answer` and `tips` still carry the useful information. Without
  // a center we skip grounding entirely but still return answer + tips.
  const places: UnifiedPlace[] = [];
  if (center && curated.venues.length > 0) {
    const biasRadiusM = Math.min(50000, Math.max(payload.radiusM ?? 8000, 15000));
    const grounded = await Promise.all(
      curated.venues.map((v) => groundVenue(v, center, biasRadiusM, placesKey)),
    );
    const seen = new Set<string>();
    for (const place of grounded) {
      if (!place || seen.has(place.id)) continue;
      seen.add(place.id);
      places.push(place);
      if (places.length >= limit) break;
    }
  }

  const hasContent = places.length > 0 || curated.tips.length > 0 || !!curated.answer;
  return jsonResponse({
    // 'google' signals a usable curated response (cards, tips, or a written
    // answer) so the client keeps it instead of falling back to plain search.
    provider: hasContent ? 'google' : 'none',
    query: phrase,
    places,
    answer: curated.answer ?? undefined,
    tips: curated.tips,
    reason: hasContent ? undefined : 'no_results',
    curated: true,
    usage,
  });
});
