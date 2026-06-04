import {
  Itinerary,
  ItineraryItem,
  ItineraryItemKind,
  ItineraryPlace,
  ItinerarySection,
  ItineraryTravelMode,
  ITINERARY_KINDS,
  TIME_FLEXIBILITIES,
  TimeFlexibility,
  TravelLeg,
  TravelStep,
  TravelStepMode,
} from '@/types/itinerary';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  findPlacesGrounded,
  isGeminiConfigured,
  isGroundedError,
} from '@/lib/groundedPlaces';
import type { SchedulerContext } from './scheduler';
import { uid } from '@/utils/id';
import { todayISO } from '@/utils/time';

export interface ItineraryDebug {
  request: unknown;
  response: unknown;
}

export interface ItineraryResult {
  itinerary: Itinerary | null;
  /** True when the LLM produced the itinerary; false when it's the sample. */
  usedAi: boolean;
  /**
   * True when the itinerary came from the single-call grounded planner
   * (Gemini + Google Search). Tells the screen to skip the per-stop
   * re-grounding pass — venues are already grounded.
   */
  usedGrounded?: boolean;
  /** Populated only when `options.debug` was set. */
  debug?: ItineraryDebug;
}

interface PlanItineraryOptions {
  context?: SchedulerContext;
  date?: string;
  debug?: boolean;
}

function buildContextPayload(
  ctx?: SchedulerContext,
): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  if (ctx.home) {
    out.home = {
      label: ctx.home.label,
      latitude: ctx.home.latitude,
      longitude: ctx.home.longitude,
    };
  }
  if (ctx.work) {
    out.work = {
      label: ctx.work.label,
      latitude: ctx.work.latitude,
      longitude: ctx.work.longitude,
    };
  }
  if (ctx.endOfDay) {
    out.endOfDay = {
      label: ctx.endOfDay.label,
      latitude: ctx.endOfDay.latitude,
      longitude: ctx.endOfDay.longitude,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- sanitization -----------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asHHMM(v: unknown): string | undefined {
  const s = asString(v);
  if (!s) return undefined;
  return /^\d{1,2}:\d{2}$/.test(s) ? s : undefined;
}

function sanitizeKind(v: unknown): ItineraryItemKind {
  return ITINERARY_KINDS.includes(v as ItineraryItemKind)
    ? (v as ItineraryItemKind)
    : 'other';
}

function sanitizeFlexibility(v: unknown): TimeFlexibility {
  return TIME_FLEXIBILITIES.includes(v as TimeFlexibility)
    ? (v as TimeFlexibility)
    : 'flexible';
}

function sanitizePlace(raw: any): ItineraryPlace | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const name = asString(raw.name);
  if (!name) return undefined;
  const rating = asNumber(raw.rating);
  return {
    name,
    category: asString(raw.category),
    emoji: asString(raw.emoji),
    address: asString(raw.address),
    rating: rating !== undefined ? Math.max(0, Math.min(5, rating)) : undefined,
    ratingCount: asNumber(raw.ratingCount),
    priceLevel: asString(raw.priceLevel),
    openStatus: asString(raw.openStatus),
    coords:
      raw.coords &&
      Number.isFinite(Number(raw.coords.latitude)) &&
      Number.isFinite(Number(raw.coords.longitude))
        ? {
            latitude: Number(raw.coords.latitude),
            longitude: Number(raw.coords.longitude),
          }
        : undefined,
    photoUrl: asString(raw.photoUrl),
    sourceUrl: asString(raw.sourceUrl),
  };
}

const TRAVEL_MODES: ItineraryTravelMode[] = ['walk', 'bike', 'transit', 'drive'];
const TRAVEL_STEP_MODES: TravelStepMode[] = [
  'walk',
  'bus',
  'tram',
  'subway',
  'train',
  'ferry',
  'transit',
];

function asCoords(raw: any): { latitude: number; longitude: number } | undefined {
  if (!raw) return undefined;
  const lat = Number(raw.latitude);
  const lng = Number(raw.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng)
    ? { latitude: lat, longitude: lng }
    : undefined;
}

function sanitizeTravelStep(raw: any): TravelStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const mode = TRAVEL_STEP_MODES.includes(raw.mode as TravelStepMode)
    ? (raw.mode as TravelStepMode)
    : 'transit';
  const durationMinutes = asNumber(raw.durationMinutes);
  const numStops = asNumber(raw.numStops);
  return {
    mode,
    line: asString(raw.line),
    from: asString(raw.from),
    to: asString(raw.to),
    durationMinutes:
      durationMinutes !== undefined && durationMinutes > 0
        ? Math.round(durationMinutes)
        : undefined,
    numStops: numStops !== undefined && numStops >= 0 ? Math.round(numStops) : undefined,
    fromCoords: asCoords(raw.fromCoords),
    toCoords: asCoords(raw.toCoords),
  };
}

function sanitizeTravelLeg(raw: any): TravelLeg | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const minutes = asNumber(raw.minutes);
  if (minutes === undefined || minutes <= 0) return undefined;
  const mode = TRAVEL_MODES.includes(raw.mode as ItineraryTravelMode)
    ? (raw.mode as ItineraryTravelMode)
    : 'transit';
  const steps: TravelStep[] | undefined = Array.isArray(raw.steps)
    ? (raw.steps as unknown[])
        .map((s) => sanitizeTravelStep(s))
        .filter((s): s is TravelStep => Boolean(s))
    : undefined;
  return {
    mode,
    minutes: Math.round(minutes),
    distanceMeters: asNumber(raw.distanceMeters),
    fromLabel: asString(raw.fromLabel),
    summary: asString(raw.summary),
    steps: steps && steps.length > 0 ? steps : undefined,
    estimated: typeof raw.estimated === 'boolean' ? raw.estimated : undefined,
    polyline: asString(raw.polyline),
  };
}

function sanitizeItem(raw: any, index: number): ItineraryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = asString(raw.title);
  if (!title) return null;
  const highlights: string[] | undefined = Array.isArray(raw.highlights)
    ? (raw.highlights as unknown[])
        .map((h) => asString(h))
        .filter((h): h is string => Boolean(h))
    : undefined;
  return {
    id: asString(raw.id) ?? uid('item'),
    title,
    kind: sanitizeKind(raw.kind),
    flexibility: sanitizeFlexibility(raw.flexibility),
    startTime: asHHMM(raw.startTime),
    endTime: asHHMM(raw.endTime),
    durationMinutes: (() => {
      const n = asNumber(raw.durationMinutes);
      return n !== undefined && n > 0 ? Math.round(n) : undefined;
    })(),
    windowStart: asHHMM(raw.windowStart),
    windowEnd: asHHMM(raw.windowEnd),
    place: sanitizePlace(raw.place),
    travelFromPrev: sanitizeTravelLeg(raw.travelFromPrev),
    description: asString(raw.description),
    highlights: highlights && highlights.length > 0 ? highlights : undefined,
    orderIndex: index,
  };
}

function sanitizeSection(
  raw: any,
  startIndex: number,
): { section: ItinerarySection | null; nextIndex: number } {
  if (!raw || typeof raw !== 'object') {
    return { section: null, nextIndex: startIndex };
  }
  const title = asString(raw.title);
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  let idx = startIndex;
  const items: ItineraryItem[] = [];
  for (const it of rawItems) {
    const item = sanitizeItem(it, idx);
    if (item) {
      items.push(item);
      idx += 1;
    }
  }
  if (!title || items.length === 0) {
    return { section: null, nextIndex: idx };
  }
  return {
    section: { id: uid('sec'), title, period: asString(raw.period), items },
    nextIndex: idx,
  };
}

function sanitizeItinerary(data: any): Itinerary | null {
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.sections)) return null;
  const sections: ItinerarySection[] = [];
  let idx = 0;
  for (const s of data.sections) {
    const { section, nextIndex } = sanitizeSection(s, idx);
    idx = nextIndex;
    if (section) sections.push(section);
  }
  if (sections.length === 0) return null;
  return {
    id: uid('itin'),
    title: asString(data.title) ?? 'Your day',
    summary: asString(data.summary),
    date: asString(data.date) ?? todayISO(),
    origin: asString(data.origin),
    city: asString(data.city),
    sections,
  };
}

// --- single-call grounded planner (preferred) ------------------------------
//
// Mirrors the test-screen approach but for the WHOLE day: ONE Gemini call with
// Google Search grounding, given the user's raw plan text + their home and
// today's date. The model produces the entire `Itinerary` structure directly —
// sections, time-blocked items, grounded venues, and approximate travel legs —
// in one pass. No edge function, no schedule-day call, no per-item pickVenue,
// no separate re-grounding pass.
//
// Trade-off acknowledged: travel `steps` come from the model's general
// knowledge, not live Google Routes, so transit lines/durations are estimated
// (every leg is marked `estimated: true`). Quality of *planning* and *venue
// selection* in exchange for less precise routing — a deliberate choice while
// we evaluate.

const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
const GEMINI_MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash';

function buildPlannerPrompt(args: {
  userText: string;
  home: { latitude: number; longitude: number; label?: string } | null;
  date: string;
}): string {
  const home = args.home;
  const homeBlock = home
    ? `- Home: "${home.label ?? 'home'}" at latitude ${home.latitude}, longitude ${home.longitude}.`
    : '- The user has not pinned a home location. Keep venue picks generic and assume the day happens close to wherever they start.';
  const originDefault = home?.label ?? 'home';
  return `You are a professional day planner who orders activities so they save time, make sense, flow smoothly, and feel mindful and realistic.

CONTEXT
${homeBlock}
- Today is ${args.date}.

USER REQUEST (their own words, between triple quotes):
"""
${args.userText}
"""

REQUIREMENTS
1. Order the activities to save time and respect every constraint the user mentioned (no-later-than, max-time-between, prerequisites). Constraints may be in prose — read carefully.
2. Cover the WHOLE day continuously. No invisible gaps. Wake → prep → breakfast → depart → travel → activity → rest → travel home → shower → etc. The only allowed gaps are explicit relax/buffer/chores items the user asked for (use kind="break").
3. NEVER teleport. If the user goes somewhere, model the trip there AND the trip back home — either as a separate kind="travel" item or as travelFromPrev on the next located item. If the next activity is at the same place as the previous one, no travel leg is needed.
4. For every place the user goes to, use Google Search to find a REAL, SPECIFIC venue near home. Strongly prefer venues within ~3 km of home; never beyond ~8 km unless genuinely necessary. Do NOT pick a famous venue across town just because it's well-known. Return real name, address, rating (0–5), and an opening-status hint when known. If the user NAMED a venue (e.g. "OC Krakov Max Fitness"), honour that exact venue regardless of distance.
5. Be precise about travel. Break transit journeys into concrete steps: walk to stop → bus/tram/metro → walk to destination. Include line labels ("Bus 152", "Metro C") and stop names when you actually know them. Mark every leg "estimated": true — you do not have live routing. If you're not sure of transit details, use a single estimated leg with realistic minutes instead of inventing line numbers.
6. Group items into sections with catchy headlines ("Morning Reset", "Gym & Recovery", "Languages", "Wind Down").
7. Each item needs realistic startTime / endTime / durationMinutes. Include a 1–2 sentence description, and up to 4 "highlights" for items with concrete to-dos (e.g. ["Eggs", "Toast", "Phone on silent"]).
8. Use the user's stated start time. Wrap the day with a sensible end (e.g. "before sleep" implies sleep prep around 22:30–23:30 unless they said otherwise).

Output ONLY a single JSON object, no prose, no markdown fences. Match this schema. OMIT optional fields you don't have rather than inventing. Use null for unknown ratings; do not make up transit line numbers.

{
  "title": "<catchy day title>",
  "summary": "<2–3 sentence summary of how the day flows>",
  "date": "${args.date}",
  "origin": ${JSON.stringify(originDefault)},
  "city": "<city, e.g. Prague, Czechia>",
  "sections": [
    {
      "title": "<section headline>",
      "period": "Morning" | "Afternoon" | "Evening",
      "items": [
        {
          "title": "<short action title>",
          "kind": "travel" | "work" | "sightseeing" | "meal" | "event" | "meetup" | "drinks" | "activity" | "break" | "other",
          "flexibility": "fixed" | "window" | "flexible",
          "startTime": "HH:MM",
          "endTime": "HH:MM",
          "durationMinutes": 30,
          "place": {
            "name": "Max Fitness Krakov",
            "category": "Gym",
            "emoji": "🏋️",
            "address": "Lodžská 850/6, Prague 8",
            "rating": 4.6,
            "openStatus": "Open · 06:00–22:00",
            "coords": { "latitude": 50.13, "longitude": 14.42 }
          },
          "travelFromPrev": {
            "mode": "transit",
            "minutes": 18,
            "fromLabel": "Home",
            "estimated": true,
            "steps": [
              { "mode": "walk", "durationMinutes": 5 },
              { "mode": "bus", "line": "152", "from": "Přívorská", "to": "Krakov", "durationMinutes": 8 },
              { "mode": "walk", "durationMinutes": 3 }
            ]
          },
          "description": "Strength session at the OC Krakov gym — the Max Fitness spot the user named.",
          "highlights": ["Warm-up 10 min", "Main lift 60 min", "Sauna after"]
        }
      ]
    }
  ]
}`;
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

async function planItineraryGrounded(
  request: string,
  options: PlanItineraryOptions,
  debug: ItineraryDebug | undefined,
): Promise<Itinerary | null> {
  if (!GEMINI_API_KEY) return null;
  const home = options.context?.home;
  const date = options.date ?? todayISO();
  const prompt = buildPlannerPrompt({
    userText: request,
    home: home
      ? { latitude: home.latitude, longitude: home.longitude, label: home.label }
      : null,
    date,
  });
  const requestBody = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // Google Search grounding so the model can resolve real venue details
    // (ratings, addresses, opening hours) in the same call.
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.4 },
  };
  if (debug) debug.request = { prompt, requestBody };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const t0 = Date.now();
  let data: any;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) {
      const body = await res.text();
      if (debug) debug.response = { error: `Gemini ${res.status}`, body: body.slice(0, 800) };
      return null;
    }
    data = await res.json();
  } catch (e: any) {
    if (debug) debug.response = { error: String(e?.message ?? e) };
    return null;
  }
  const elapsedMs = Date.now() - t0;

  const candidate = data?.candidates?.[0];
  const text: string = (candidate?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join('')
    .trim();
  const parsed = extractJsonObject(text);
  if (debug) {
    debug.response = {
      elapsedMs,
      model: GEMINI_MODEL,
      parsedOk: !!parsed,
      groundingSources:
        candidate?.groundingMetadata?.groundingChunks
          ?.map((c: any) => c?.web?.title || c?.web?.uri)
          .filter(Boolean) ?? [],
      rawText: text,
      raw: data,
    };
  }
  if (!parsed) return null;
  return sanitizeItinerary(parsed);
}

// --- public API -------------------------------------------------------------

/**
 * Top-level "plan my whole day" call for the v2 architecture. Tries paths in
 * preferred order:
 *   1. Grounded single call (Gemini + Google Search) — produces the whole
 *      itinerary including grounded venues in one pass. Preferred when an
 *      EXPO_PUBLIC_GEMINI_API_KEY is configured.
 *   2. Existing Supabase `plan-itinerary` edge function — kept as fallback.
 *   3. Curated sample itinerary — final offline fallback.
 */
export async function planItinerary(
  request: string,
  options: PlanItineraryOptions = {},
): Promise<ItineraryResult> {
  const text = request.trim();
  const debug: ItineraryDebug | undefined = options.debug
    ? { request: null, response: null }
    : undefined;

  if (!text) {
    return { itinerary: null, usedAi: false, debug };
  }

  // Preferred path: one grounded Gemini call.
  if (isGeminiConfigured) {
    const itin = await planItineraryGrounded(text, options, debug);
    if (itin) {
      return { itinerary: itin, usedAi: true, usedGrounded: true, debug };
    }
    // fall through to legacy edge function on grounded failure
  }

  if (isSupabaseConfigured && supabase) {
    const body: Record<string, unknown> = { request: text };
    if (options.date) body.date = options.date;
    const ctx = buildContextPayload(options.context);
    if (ctx) body.context = ctx;
    if (debug) debug.request = body;
    try {
      const { data, error } = await supabase.functions.invoke('plan-itinerary', {
        body,
      });
      if (debug) debug.response = error ?? data;
      if (!error) {
        const itinerary = sanitizeItinerary(data);
        if (itinerary) {
          return { itinerary, usedAi: true, debug };
        }
      }
    } catch (e) {
      if (debug) debug.response = { error: String(e) };
    }
  }

  // Fallback: a curated sample so the new architecture/UI is always testable.
  const sample = sampleItinerary(options.context?.home?.label);
  if (debug && debug.response === null) {
    debug.response = {
      note: 'Supabase/OpenAI not configured — returning sample itinerary.',
    };
  }
  return { itinerary: sample, usedAi: false, debug };
}

// --- client-side grounded re-resolution (experimental) ---------------------
//
// The v2 itinerary resolves venues SERVER-SIDE in the `plan-itinerary` edge
// function (`pickVenue`), which has the locality bugs we diagnosed (locationBias
// instead of restriction, a `trustName` 50 km widening, no distance guard). As a
// stepping stone before touching that function, this re-resolves each venue stop
// CLIENT-SIDE with the grounded finder (one Gemini + Google Search call), anchored
// on the user's home/location, so we can evaluate quality before committing.
//
// Caveats while this is experimental:
//   - Travel legs (`travelFromPrev`) were computed server-side for the OLD
//     coordinates and are NOT recomputed here, so inter-stop minutes can drift.
//   - We skip stops far from the anchor (a day trip to another city) so we don't
//     yank an Olomouc landmark back to Prague.
//   - Photos are dropped (the grounded finder returns none).

const REGROUND_TRIP_SKIP_M = 60000;

function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Per-stop trace of what the re-grounding step did, for the debug panel. */
export interface RegroundItemTrace {
  title: string;
  query: string;
  serverName: string;
  serverCoords?: { latitude: number; longitude: number };
  distanceFromAnchorKm?: number;
  outcome: 'replaced' | 'skipped_trip' | 'no_result' | 'error';
  groundedName?: string;
  groundedCoords?: { latitude: number; longitude: number };
  groundedDistanceKm?: number;
  detail?: string;
}

export interface RegroundStats {
  /** Whether the re-grounding step actually ran. */
  ran: boolean;
  /** Why it was a no-op, when `ran` is false. */
  reason?: string;
  /** The anchor the searches were centered on. */
  anchor?: { latitude: number; longitude: number } | null;
  /** Venue stops considered for re-resolution. */
  total: number;
  /** Stops whose venue was replaced by a grounded pick. */
  replaced: number;
  /** Per-stop detail. */
  items: RegroundItemTrace[];
}

/**
 * Returns a new itinerary with each local venue stop re-resolved via the
 * grounded finder, anchored on `anchor` (the user's home / current location).
 * No-op when Gemini isn't configured or no anchor is known. Captures a
 * per-stop trace so the screen's debug panel can show exactly what happened
 * (anchor, query, server pick vs grounded pick, distances, skips).
 */
export async function regroundItineraryPlaces(
  itinerary: Itinerary,
  anchor: { latitude: number; longitude: number; label?: string } | null,
): Promise<{ itinerary: Itinerary; stats: RegroundStats }> {
  if (!isGeminiConfigured) {
    return {
      itinerary,
      stats: { ran: false, reason: 'gemini_not_configured', total: 0, replaced: 0, items: [] },
    };
  }
  if (!anchor) {
    return {
      itinerary,
      stats: {
        ran: false,
        reason: 'no_anchor (home not set and no GPS) — venues left as the server resolved them',
        anchor: null,
        total: 0,
        replaced: 0,
        items: [],
      },
    };
  }

  const sections: ItinerarySection[] = itinerary.sections.map((s) => ({
    ...s,
    items: s.items.map((it) => ({ ...it })),
  }));

  let total = 0;
  let replaced = 0;
  const traces: RegroundItemTrace[] = [];
  const tasks: Promise<void>[] = [];

  for (const section of sections) {
    for (const item of section.items) {
      const place = item.place;
      if (!place || !place.name) continue;
      const serverCoords = place.coords;
      const distM = serverCoords ? haversineMeters(anchor, serverCoords) : undefined;
      const trace: RegroundItemTrace = {
        title: item.title,
        query: item.title,
        serverName: place.name,
        serverCoords,
        distanceFromAnchorKm:
          distM != null ? Math.round((distM / 1000) * 10) / 10 : undefined,
        outcome: 'no_result',
      };
      traces.push(trace);

      // Leave far-away (trip) stops to the server's resolution.
      if (distM != null && distM > REGROUND_TRIP_SKIP_M) {
        trace.outcome = 'skipped_trip';
        continue;
      }
      total += 1;
      tasks.push(
        (async () => {
          const g = await findPlacesGrounded(
            item.title,
            anchor.latitude,
            anchor.longitude,
            anchor.label,
          );
          if (isGroundedError(g)) {
            trace.outcome = 'error';
            trace.detail = g.detail ? `${g.error}: ${g.detail}` : g.error;
            return;
          }
          if (g.places.length === 0) {
            trace.outcome = 'no_result';
            return;
          }
          const best = g.places[0];
          const coords =
            best.latitude != null && best.longitude != null
              ? { latitude: best.latitude, longitude: best.longitude }
              : place.coords;
          trace.outcome = 'replaced';
          trace.groundedName = best.name;
          trace.groundedCoords = coords;
          trace.groundedDistanceKm =
            coords ? Math.round((haversineMeters(anchor, coords) / 1000) * 10) / 10 : undefined;
          item.place = {
            ...place,
            name: best.name,
            address: best.address ?? place.address,
            rating: best.rating ?? place.rating,
            coords,
            // These referenced the previous (server-picked) venue.
            photoUrl: undefined,
            ratingCount: undefined,
            sourceUrl: undefined,
          };
          replaced += 1;
        })(),
      );
    }
  }

  await Promise.all(tasks);

  const stats: RegroundStats = {
    ran: true,
    anchor,
    total,
    replaced,
    items: traces,
  };
  // Also log to the JS console (Metro / browser devtools) for quick triage.
  console.log('[reground]', JSON.stringify(stats, null, 2));
  return { itinerary: { ...itinerary, sections }, stats };
}

/**
 * A hand-built itinerary used as the offline fallback. Mirrors the
 * structure the LLM returns so the sandbox demonstrates the full object
 * shape — sections with catchy titles, a sightseeing block dissected into
 * one concrete place per landmark, and "fixed" anchors (meetup, event)
 * the flexible blocks flow around.
 */
export function sampleItinerary(originLabel?: string): Itinerary {
  let order = 0;
  const mk = (item: Omit<ItineraryItem, 'id' | 'orderIndex'>): ItineraryItem => ({
    id: uid('item'),
    orderIndex: order++,
    ...item,
  });

  const sections: ItinerarySection[] = [
    {
      id: uid('sec'),
      title: 'Rise & Shine',
      period: 'Morning',
      items: [
        mk({
          title: 'Wake & get ready',
          kind: 'break',
          flexibility: 'flexible',
          startTime: '05:30',
          endTime: '06:00',
          durationMinutes: 30,
          description: 'Wake up, shower, and get yourself together before heading out.',
        }),
        mk({
          title: 'Breakfast at home',
          kind: 'meal',
          flexibility: 'flexible',
          startTime: '06:00',
          endTime: '06:25',
          durationMinutes: 25,
          description: 'A proper breakfast at home — fuel up before the trip.',
        }),
      ],
    },
    {
      id: uid('sec'),
      title: 'Morning Deep Work',
      period: 'Morning',
      items: [
        mk({
          title: 'Deep work session',
          kind: 'work',
          flexibility: 'flexible',
          startTime: '09:30',
          endTime: '11:30',
          durationMinutes: 120,
          // The whole home → Olomouc journey, broken into real transit legs.
          travelFromPrev: {
            mode: 'transit',
            minutes: 185,
            fromLabel: 'Home',
            estimated: true,
            steps: [
              { mode: 'walk', durationMinutes: 5 },
              { mode: 'bus', line: '102', from: 'Přívorská', to: 'Kobylisy', durationMinutes: 8 },
              { mode: 'subway', line: 'Metro C', from: 'Kobylisy', to: 'Hlavní nádraží', durationMinutes: 14 },
              { mode: 'train', line: 'RegioJet', from: 'Praha hl.n.', to: 'Olomouc hl.n.', durationMinutes: 138 },
              { mode: 'walk', durationMinutes: 7 },
            ],
          },
          place: {
            name: 'Telegraph Coworking',
            category: 'Coworking space',
            emoji: '💻',
            rating: 5.0,
            openStatus: 'Open · Closes at 6.00 pm',
          },
          description:
            '1–2h of high-focus work in a premium coworking space 5 min from the station. Grab a day pass at reception.',
          highlights: ['Fast Wi-Fi', 'Phone booths', 'Great coffee'],
        }),
      ],
    },
    {
      id: uid('sec'),
      title: 'Explore the Old Town',
      period: 'Afternoon',
      items: [
        mk({
          title: 'Meet your friend at Horní náměstí',
          kind: 'meetup',
          flexibility: 'fixed',
          startTime: '12:00',
          endTime: '12:20',
          durationMinutes: 20,
          travelFromPrev: { mode: 'walk', minutes: 8, estimated: true },
          place: { name: 'Horní náměstí', category: 'Historic square', emoji: '🏛️' },
          description:
            "Rendezvous at Olomouc's grand main square to kick off the afternoon together.",
        }),
        mk({
          title: 'Holy Trinity Column',
          kind: 'sightseeing',
          flexibility: 'flexible',
          startTime: '12:22',
          endTime: '12:52',
          durationMinutes: 30,
          travelFromPrev: { mode: 'walk', minutes: 2, estimated: true },
          place: { name: 'Holy Trinity Column', category: 'Monument', emoji: '🗽' },
          description:
            'The UNESCO-listed Baroque column dominating the square — the largest of its kind in Central Europe.',
        }),
        mk({
          title: 'Olomouc Astronomical Clock',
          kind: 'sightseeing',
          flexibility: 'flexible',
          startTime: '12:55',
          endTime: '13:20',
          durationMinutes: 25,
          travelFromPrev: { mode: 'walk', minutes: 3, estimated: true },
          place: { name: 'Olomouc Astronomical Clock', category: 'Landmark', emoji: '🕰️' },
          description:
            'The rare Socialist-Realist redesign of the medieval orloj on the town hall wall.',
        }),
      ],
    },
    {
      id: uid('sec'),
      title: 'Time for Food!',
      period: 'Afternoon',
      items: [
        mk({
          title: 'Lunch at Moravská Restaurace',
          kind: 'meal',
          flexibility: 'window',
          startTime: '13:24',
          endTime: '14:34',
          durationMinutes: 70,
          windowStart: '13:00',
          windowEnd: '14:00',
          travelFromPrev: { mode: 'walk', minutes: 4, estimated: true },
          place: {
            name: 'Moravská Restaurace',
            category: 'Czech restaurant',
            emoji: '🍽️',
            rating: 4.6,
            priceLevel: '$$',
            openStatus: 'Open · Closes at 10.00 pm',
          },
          description:
            'Hearty traditional Moravian cooking right by the square — try the local Olomoucké tvarůžky.',
          highlights: ['Traditional dishes', 'Local cheese'],
        }),
      ],
    },
    {
      id: uid('sec'),
      title: 'The Main Event',
      period: 'Afternoon',
      items: [
        mk({
          title: 'Show-jumping — World Cup qualifier',
          kind: 'event',
          flexibility: 'fixed',
          startTime: '15:00',
          endTime: '17:30',
          durationMinutes: 150,
          travelFromPrev: { mode: 'drive', minutes: 12, estimated: true },
          place: {
            name: 'Equine Sport Center Olomouc',
            category: 'Sports club',
            emoji: '🐎',
            rating: 4.6,
            openStatus: 'Open · Closes at 7.00 pm',
          },
          description:
            'CSI2*-W show jumping — top European riders over big verticals and spreads. A 12-min taxi from the square.',
        }),
      ],
    },
    {
      id: uid('sec'),
      title: 'Wind Down',
      period: 'Evening',
      items: [
        mk({
          title: 'Drinks at The BLACK STUFF',
          kind: 'drinks',
          flexibility: 'flexible',
          startTime: '17:42',
          endTime: '19:42',
          durationMinutes: 120,
          travelFromPrev: { mode: 'drive', minutes: 12, estimated: true },
          place: {
            name: 'The BLACK STUFF Irish Pub & Whisky Bar',
            category: 'Irish pub',
            emoji: '🍺',
            rating: 4.8,
            priceLevel: 'CZK200–CZK600',
            openStatus: 'Open · Closes at 2.00 am',
          },
          description:
            'One of the best bars in the country — 250+ whiskies and perfect Guinness. Cozy spot to catch up before the train home.',
          highlights: ['250+ whiskies', 'On the way to the station'],
        }),
      ],
    },
    {
      id: uid('sec'),
      title: 'Head Home',
      period: 'Evening',
      items: [
        mk({
          title: 'Back home in Prague',
          kind: 'travel',
          flexibility: 'flexible',
          startTime: '22:52',
          travelFromPrev: {
            mode: 'transit',
            minutes: 190,
            estimated: true,
            steps: [
              { mode: 'walk', durationMinutes: 7 },
              { mode: 'train', line: 'RegioJet', from: 'Olomouc hl.n.', to: 'Praha hl.n.', durationMinutes: 138 },
              { mode: 'subway', line: 'Metro C', from: 'Hlavní nádraží', to: 'Kobylisy', durationMinutes: 14 },
              { mode: 'bus', line: '102', from: 'Kobylisy', to: 'Přívorská', durationMinutes: 8 },
              { mode: 'walk', durationMinutes: 5 },
            ],
          },
          description: 'Evening train back, home before midnight.',
        }),
      ],
    },
  ];

  return {
    id: uid('itin'),
    title: 'Prague → Olomouc day trip',
    summary:
      'A focused-then-fun day trip: morning deep work by the station, midday sightseeing and a friend meetup, lunch, the afternoon show-jumping qualifier, and premium drinks before the train home.',
    date: todayISO(),
    origin: originLabel ?? 'Pekařova 859/12, Bohnice',
    city: 'Olomouc, Czechia',
    sections,
  };
}
