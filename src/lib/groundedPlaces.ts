/**
 * Minimal "out of the box" place finder — the conceptual opposite of the
 * `find-places` / `plan-itinerary` stack.
 *
 * Instead of regex category maps, a duplicated composite score, a GPT
 * re-rank pass, and code-side proximity safety nets, this hands the raw
 * query + the user's coordinates to ONE grounded model call (Gemini with
 * Google Search grounding) and returns whatever it decides.
 *
 * It runs entirely client-side — no edge function. The key is read from
 * `EXPO_PUBLIC_GEMINI_API_KEY`, which is bundled into the app. That's fine
 * for a testing screen; restrict the key or move this server-side before
 * shipping it to real users.
 */

export interface GroundedPlace {
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  approxDistanceKm: number | null;
  rating: number | null;
  /** One sentence: why this matches the request. */
  why: string | null;
}

export interface GroundedSource {
  title: string;
  uri: string | null;
}

export interface GroundedResult {
  places: GroundedPlace[];
  /** Web/Maps results the model grounded its answer on. */
  sources: GroundedSource[];
  /** Raw model text, kept so the test screen can show exactly what came back. */
  rawText: string;
  /** Full request body and parsed response, for the debug panel. */
  debug: { request: unknown; response: unknown };
  elapsedMs: number;
  model: string;
}

export interface GroundedError {
  error: string;
  detail?: string;
  debug?: { request: unknown; response: unknown };
}

export type GroundedResponse = GroundedResult | GroundedError;

export function isGroundedError(r: GroundedResponse): r is GroundedError {
  return (r as GroundedError).error !== undefined;
}

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
const MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash';

export const isGeminiConfigured = Boolean(API_KEY);

/**
 * Builds the minimal prompt on purpose. We tell the model where the user
 * is, what they want, and the exact JSON to return. Everything else — the
 * semantics of "pull-up bar", staying in the right neighborhood, which
 * venue actually matches — is left to the model + Google Search grounding.
 */
function buildPrompt(
  query: string,
  lat: number,
  lon: number,
  areaHint?: string,
): string {
  const where = areaHint ? ` (${areaHint})` : '';
  const areaName = areaHint || 'that exact location';
  return `The user is located at latitude ${lat}, longitude ${lon}${where}.
They are looking for: "${query}".

Find the real place(s) that best match, AS CLOSE AS POSSIBLE to that exact
coordinate. Use Google Search to ground every fact.

Locality rules (important):
- Strongly prefer places within ~3 km of the coordinate above. The user wants
  something local to ${areaName}, not a famous spot in another part of the city.
- Do NOT return a well-known or highly-rated venue in a different neighborhood
  just because it is popular — proximity to the coordinate matters more than fame.
- Only go farther than ~3 km if there is genuinely nothing suitable nearby, and
  never beyond ~8 km.

Then return ONLY a JSON object, no prose, of this shape:

{
  "places": [
    {
      "name": string,
      "address": string,
      "latitude": number,
      "longitude": number,
      "approxDistanceKm": number,
      "rating": number | null,
      "why": string
    }
  ]
}`;
}

function extractJson(text: string): any | null {
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

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function normalizePlaces(parsed: any): GroundedPlace[] {
  const arr = Array.isArray(parsed?.places) ? parsed.places : [];
  return arr
    .map((p: any) => {
      const name = str(p?.name);
      if (!name) return null;
      return {
        name,
        address: str(p?.address),
        latitude: num(p?.latitude),
        longitude: num(p?.longitude),
        approxDistanceKm: num(p?.approxDistanceKm),
        rating: num(p?.rating),
        why: str(p?.why),
      } as GroundedPlace;
    })
    .filter(Boolean) as GroundedPlace[];
}

function normalizeSources(candidate: any): GroundedSource[] {
  const chunks = candidate?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set<string>();
  const out: GroundedSource[] = [];
  for (const c of chunks) {
    const title = str(c?.web?.title) ?? str(c?.web?.uri);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    out.push({ title, uri: str(c?.web?.uri) });
  }
  return out;
}

/**
 * The single call. Sends `query` + coordinates to Gemini with Google Search
 * grounding and returns the parsed places plus the sources it grounded on.
 */
export async function findPlacesGrounded(
  query: string,
  latitude: number,
  longitude: number,
  areaHint?: string,
): Promise<GroundedResponse> {
  if (!API_KEY) {
    return {
      error: 'Missing EXPO_PUBLIC_GEMINI_API_KEY',
      detail:
        'Add EXPO_PUBLIC_GEMINI_API_KEY to your .env and restart the dev server.',
    };
  }
  const q = query.trim();
  if (!q) return { error: 'Empty query' };

  const requestBody = {
    contents: [
      { role: 'user', parts: [{ text: buildPrompt(q, latitude, longitude, areaHint) }] },
    ],
    // Google Search grounding — what lets a single call behave like a
    // map-aware lookup instead of hallucinating coordinates.
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2 },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const t0 = Date.now();

  let data: any;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) {
      const detail = await res.text();
      return {
        error: `Gemini error ${res.status}`,
        detail: detail.slice(0, 500),
        debug: { request: requestBody, response: detail },
      };
    }
    data = await res.json();
  } catch (e: any) {
    return {
      error: 'Network error',
      detail: String(e?.message ?? e),
      debug: { request: requestBody, response: String(e) },
    };
  }

  const elapsedMs = Date.now() - t0;
  const candidate = data?.candidates?.[0];
  const rawText: string = (candidate?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join('')
    .trim();

  const parsed = extractJson(rawText);
  const places = normalizePlaces(parsed);
  const sources = normalizeSources(candidate);

  return {
    places,
    sources,
    rawText,
    elapsedMs,
    model: MODEL,
    debug: { request: requestBody, response: data },
  };
}
