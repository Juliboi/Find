// Supabase Edge Function: plan-itinerary
//
// The ERRAND-ANCHORED planning architecture, server-side. The AI is the brain
// that ARRANGES the user's real errands into a day — it does NOT invent a day
// from a prose description. Errands are the stable backbone:
//
//   1. ONE Gemini call arranges the day:
//        - ANCHORS (already-located errands) are placed VERBATIM — never
//          renamed, moved, swapped, or re-discovered. They drive the order.
//        - TASKS (unplaced errands) are scheduled; the model names a real
//          venue only for the place-y ones (a workout, a coffee out, focused
//          work at a café), and leaves pure tasks (a call, admin) place-less.
//        - INTENT (the free-text box) is treated as STYLE/NOTES, not a day to
//          generate — UNLESS there are no errands at all, in which case it's a
//          full "plan me a day" request and we discover venues for it.
//      Errand-driven days run in cheap SCHEMA mode (no Google Search); we only
//      turn ON grounding for a no-errand request or when the notes explicitly
//      ask to find/discover somewhere.
//   2. A per-unique-venue Google Places lookup backfills photo URL, canonical
//      coords, ratingCount, and an open/closed hint. ANCHORS skip the lookup
//      (their resolved coords/metadata are trusted); at-home items and the home
//      venue itself are skipped so we never resolve "Home" to a random building.
//
// Routing (real door-to-door legs + the clock cascade) is NOT done here — the
// client runs it afterward via the recompute-itinerary function.
//
// Request body:
//   { date?: "YYYY-MM-DD", now?: "HH:MM", fast?: boolean,
//     context?: { home?: { latitude, longitude, label }, ... },
//     anchors?: Anchor[],   // located errands, placed verbatim (a.k.a. fixedStops)
//     tasks?: Task[],        // unplaced errands the planner schedules
//     intent?: string,       // free-text style/notes (or the whole request when
//                            // there are no errands); legacy alias: `request`
//     dayStart?: { time?, label? }, dayEnd?: { time?, label? } }
//
// Response body: an Itinerary object (see src/types/itinerary.ts).
//
// Required env vars:
//   GEMINI_API_KEY         — Google AI Studio key with the Generative
//                            Language API enabled.
//   GOOGLE_PLACES_API_KEY  — optional. Enables photo / rating / openNow
//                            backfill. Without it the plan still renders,
//                            just without those fields.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

import {
  extractOpeningHours,
  openStatusForVisit,
  visitFitsHours,
  type VenueOpeningHours,
} from '../_shared/hours.ts';

// The planner needs Google Search grounding AND a large strict-JSON output in
// one call. Gemini 2.5 Flash handles that combo reliably; lighter models do
// not — gemini-2.5-flash-lite consistently returns an EMPTY response for this
// grounded JSON prompt (it drifts into conversational mode and emits nothing).
// So Flash is the safe default.
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
// Optional override via Supabase secrets (e.g. to try a new model):
//   supabase secrets set GEMINI_MODEL=gemini-2.5-pro
// If the configured model fails or returns junk, the handler retries once on
// DEFAULT_GEMINI_MODEL, so a bad override degrades to "slower" — never to the
// offline sample. Revert with: supabase secrets unset GEMINI_MODEL.
const CONFIGURED_GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL;

// Re-plans of an EXISTING day — the "Ask the planner" escalation from the
// adjust field, and the auto-replan when an edit no longer fits — favour a
// cheaper + faster grounded model than a cold-start plan: it's a tweak of a
// day that already exists, not a blank-page generation. gemini-3.1-flash-lite
// is both cheaper and faster than 2.5 Flash while still supporting Google
// Search grounding, and (unlike 2.5-flash-lite) it's capable enough to emit
// the big grounded JSON without drifting empty. If it ever fails, the handler
// self-heals to DEFAULT_GEMINI_MODEL, so a replan degrades to "slower" — never
// to the offline sample. Override with:
//   supabase secrets set GEMINI_FAST_MODEL=gemini-2.5-flash
const DEFAULT_FAST_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const CONFIGURED_FAST_GEMINI_MODEL =
  Deno.env.get('GEMINI_FAST_MODEL') ?? DEFAULT_FAST_GEMINI_MODEL;

// Arrange-only model — an errand day whose stops are ALL already located
// (anchors, no venue-finding tasks) is pure arrangement: the planner only
// ORDERS / TIMES / DESCRIBES the located stops and adds connective tissue, so
// there's nothing to discover and no need for Google Search grounding. It runs
// in schema mode where even the cheapest lite model emits reliable JSON
// (grounding is what made lite models drift empty). This is the cost/reliability
// win: cheapest + fastest model, no grounding, no per-venue Places lookups.
// Override with: supabase secrets set GEMINI_COMPOSE_MODEL=gemini-2.5-flash
const DEFAULT_COMPOSE_GEMINI_MODEL = 'gemini-2.5-flash-lite';
const CONFIGURED_COMPOSE_GEMINI_MODEL =
  Deno.env.get('GEMINI_COMPOSE_MODEL') ?? DEFAULT_COMPOSE_GEMINI_MODEL;

// Planning has two mutually-exclusive modes (Gemini forbids combining the
// google_search tool with a JSON responseSchema):
//
//   grounded (default): google_search picks REAL venues via live search.
//     Best venue realism; only Flash-class models follow the "emit one big
//     JSON" instruction reliably. ~8-15s.
//
//   schema (GEMINI_GROUNDING=off): no search, but a strict responseSchema
//     GUARANTEES parseable JSON from ANY model — including flash-lite (~3s).
//     Venues come from the model's training knowledge and are then validated
//     / geocoded by the Google Places enrichment pass below, so they still
//     resolve to real coords, photos and ratings. Slightly weaker on niche
//     venue specificity and post-cutoff places.
//
// Enable fast mode with:
//   supabase secrets set GEMINI_GROUNDING=off
//   supabase secrets set GEMINI_MODEL=gemini-2.5-flash-lite
const GROUNDING_ENABLED =
  (Deno.env.get('GEMINI_GROUNDING') ?? 'on').toLowerCase() !== 'off';

// On an errand-driven day we stay in cheap schema mode UNLESS the user's notes
// explicitly ask the planner to FIND / DISCOVER a place — only then do we turn
// on Google Search grounding. Kept deliberately tight (discovery verbs, not
// every venue noun) so a note like "have a relaxed day" doesn't needlessly
// trigger the slow grounded path.
const INTENT_DISCOVERY_RE =
  /\b(find|finds|discover|recommend|suggest|explore|somewhere|some place|a place|trendy|hidden gem)\b/i;

// responseSchema used in schema mode. A subset of OpenAPI types (the shape
// Gemini structured-output accepts). Mirrors the Itinerary the client expects;
// `sanitizeItinerary` on the client is still the final validator. travelFromPrev
// is intentionally lightweight — the routing layer (recompute-itinerary)
// replaces these estimates with real Google Routes legs.
const PLANNER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  propertyOrdering: ['title', 'summary', 'date', 'origin', 'city', 'sections'],
  required: ['title', 'city', 'sections'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    date: { type: 'string' },
    origin: { type: 'string' },
    city: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        propertyOrdering: ['title', 'period', 'items'],
        required: ['title', 'items'],
        properties: {
          title: { type: 'string' },
          period: { type: 'string', enum: ['Morning', 'Afternoon', 'Evening'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              propertyOrdering: [
                'title',
                'kind',
                'flexibility',
                'startTime',
                'endTime',
                'durationMinutes',
                'place',
                'travelFromPrev',
                'description',
              ],
              required: ['title', 'kind', 'flexibility', 'startTime', 'endTime', 'durationMinutes'],
              properties: {
                title: { type: 'string' },
                kind: {
                  type: 'string',
                  enum: [
                    'travel',
                    'work',
                    'sightseeing',
                    'meal',
                    'event',
                    'meetup',
                    'drinks',
                    'activity',
                    'break',
                    'gap',
                    'other',
                  ],
                },
                flexibility: { type: 'string', enum: ['fixed', 'window', 'flexible'] },
                startTime: { type: 'string' },
                endTime: { type: 'string' },
                durationMinutes: { type: 'integer' },
                place: {
                  type: 'object',
                  nullable: true,
                  propertyOrdering: [
                    'name',
                    'category',
                    'emoji',
                    'address',
                    'userQuery',
                    'locationType',
                    'coords',
                  ],
                  properties: {
                    name: { type: 'string' },
                    category: { type: 'string' },
                    emoji: { type: 'string' },
                    address: { type: 'string' },
                    userQuery: { type: 'string' },
                    locationType: { type: 'string', enum: ['business', 'residence'] },
                    coords: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        latitude: { type: 'number' },
                        longitude: { type: 'number' },
                      },
                    },
                  },
                },
                travelFromPrev: {
                  type: 'object',
                  nullable: true,
                  propertyOrdering: ['mode', 'minutes', 'fromLabel', 'estimated', 'steps'],
                  properties: {
                    mode: { type: 'string', enum: ['walk', 'bike', 'transit', 'drive'] },
                    minutes: { type: 'integer' },
                    fromLabel: { type: 'string' },
                    estimated: { type: 'boolean' },
                    steps: {
                      type: 'array',
                      items: {
                        type: 'object',
                        propertyOrdering: ['mode', 'line', 'from', 'to', 'durationMinutes'],
                        properties: {
                          mode: {
                            type: 'string',
                            enum: ['walk', 'bus', 'tram', 'subway', 'train', 'ferry', 'transit'],
                          },
                          line: { type: 'string' },
                          from: { type: 'string' },
                          to: { type: 'string' },
                          durationMinutes: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
                description: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

interface Coords {
  latitude: number;
  longitude: number;
}

interface HomePin {
  label: string;
  latitude: number;
  longitude: number;
}

interface CarContext {
  /** Whether the user owns/has a car at all. */
  owns: boolean;
  /** Whether the car is in play for this specific day. */
  useToday: boolean;
}

interface MealWindow {
  start?: string;
  end?: string;
}

interface MealWindows {
  breakfast?: MealWindow;
  lunch?: MealWindow;
  dinner?: MealWindow;
}

interface Context {
  home?: HomePin;
  userName?: string;
  /** "HH:MM" the user usually wakes. */
  wakeTime?: string;
  /** "HH:MM" the user usually winds down. */
  bedTime?: string;
  /** Minutes the user takes to fully wake up before focused/productive time. */
  wakeUpDurationMin?: number;
  /** Comfortable meal windows the planner schedules meals within. */
  meals?: MealWindows;
  /** "HH:MM" after which only calm, sleep-friendly activities are scheduled. */
  windDownTime?: string;
  /** Whether screen-heavy wind-down activities are OK near bedtime. */
  allowScreenWindDown?: boolean;
  car?: CarContext;
  /** Canonical dietary tags (vegetarian, gluten-free, …). */
  dietary?: string[];
  /** Freeform dietary notes / allergies. */
  dietaryNotes?: string;
}

/**
 * An ANCHOR: an errand the user has ALREADY located (a placed errand, or an
 * auto-place errand the client resolved before planning). Anchors are the
 * backbone of the day — the planner places each verbatim (never re-discovers,
 * renames, or moves it) and builds the day's order + travel around them.
 * Enrichment uses their trusted coords/metadata directly instead of a Google
 * Places lookup. (Wire-compatible with the legacy `fixedStops` payload.)
 */
interface FixedStop {
  /** What the user is doing here, e.g. "Pick up prescription". */
  title: string;
  /** The venue name/label, copied verbatim into the plan. */
  name: string;
  latitude: number;
  longitude: number;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  notes?: string;
  /** "business" (public venue — show rating/photo) or "residence" (private
   * address — just a pin). Defaults to business when omitted. */
  locationType?: 'business' | 'residence';
  /** Pre-resolved venue metadata (from when the errand's place was picked) so
   * enrichment can skip Google entirely. */
  photoUrl?: string;
  rating?: number;
  ratingCount?: number;
  openingHours?: VenueOpeningHours;
}

/**
 * A TASK: an errand the user wants in the day that is NOT yet located — a phone
 * call, "deep work", a gym session with no venue picked. The planner schedules
 * it, and decides whether it needs a venue: place-y tasks (a workout, a coffee
 * out, focused work better done at a café) get a real model-named venue that
 * the Google Places pass then validates; pure tasks (a call, admin, reading at
 * home) get no place at all.
 */
interface Task {
  title: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  notes?: string;
  /** The client KNOWS this needs a place (e.g. an unresolved auto-place errand);
   * the planner must attach a suitable venue. When false/omitted the planner
   * decides for itself based on what the task is. */
  wantsVenue?: boolean;
  /** Hint for the KIND of place to find ("quiet café", "gym"), when known. */
  placeQuery?: string;
  /** This commitment happens at home / online (a video call, telehealth, remote
   * work). It has NO physical venue: schedule it at home and NEVER invent or
   * search a place for it. Outranks wantsVenue. */
  atHome?: boolean;
}

/** One edge of the day frame — where/when the day starts or should finish. */
interface DayEdge {
  time?: string;
  label?: string;
}

// ----------------------------------------------------------- HTTP helpers

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

// ----------------------------------------------------------- utilities

function haversineMeters(a: Coords, b: Coords): number {
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "HH:MM" + minutes → "HH:MM" (wraps across midnight). */
function addMinutesHHMM(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':');
  const total = Number(h) * 60 + Number(m) + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** The end of a visit, from an explicit endTime or start + duration. */
function visitEndHHMM(startTime: string, endTime: string, durationMinutes: number | null): string {
  if (endTime) return endTime;
  if (startTime && durationMinutes && durationMinutes > 0) {
    return addMinutesHHMM(startTime, durationMinutes);
  }
  return '';
}

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/** Loose name match: equality, containment, or Jaccard ≥ 0.5 on tokens. */
function nameSimilar(a: string, b: string): boolean {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.5;
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

// ----------------------------------------------------------- input normalize

function normalizeHome(input: any): HomePin | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return {
    label: typeof input.label === 'string' ? input.label : 'home',
    latitude: lat,
    longitude: lon,
  };
}

function isHHMM(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v);
}

function normalizeContext(input: any): Context {
  const ctx: Context = {};
  if (!input || typeof input !== 'object') return ctx;
  const home = normalizeHome(input.home);
  if (home) ctx.home = home;

  if (typeof input.userName === 'string' && input.userName.trim()) {
    ctx.userName = input.userName.trim().slice(0, 80);
  }
  if (isHHMM(input.wakeTime)) ctx.wakeTime = input.wakeTime;
  if (isHHMM(input.bedTime)) ctx.bedTime = input.bedTime;

  const rampMin = Number(input.wakeUpDurationMin);
  if (Number.isFinite(rampMin) && rampMin > 0 && rampMin <= 600) {
    ctx.wakeUpDurationMin = Math.round(rampMin);
  }

  if (input.meals && typeof input.meals === 'object') {
    const parseWindow = (w: any): MealWindow | undefined => {
      if (!w || typeof w !== 'object') return undefined;
      const out: MealWindow = {};
      if (isHHMM(w.start)) out.start = w.start;
      if (isHHMM(w.end)) out.end = w.end;
      return out.start || out.end ? out : undefined;
    };
    const meals: MealWindows = {};
    const breakfast = parseWindow(input.meals.breakfast);
    const lunch = parseWindow(input.meals.lunch);
    const dinner = parseWindow(input.meals.dinner);
    if (breakfast) meals.breakfast = breakfast;
    if (lunch) meals.lunch = lunch;
    if (dinner) meals.dinner = dinner;
    if (Object.keys(meals).length > 0) ctx.meals = meals;
  }

  if (isHHMM(input.windDownTime)) ctx.windDownTime = input.windDownTime;
  if (typeof input.allowScreenWindDown === 'boolean') {
    ctx.allowScreenWindDown = input.allowScreenWindDown;
  }

  if (input.car && typeof input.car === 'object') {
    const owns = input.car.owns === true;
    ctx.car = { owns, useToday: owns && input.car.useToday !== false };
  }

  if (Array.isArray(input.dietary)) {
    const tags = input.dietary
      .filter(
        (d: unknown): d is string =>
          typeof d === 'string' && d.trim().length > 0,
      )
      .map((d: string) => d.trim().slice(0, 40))
      .slice(0, 12);
    if (tags.length) ctx.dietary = tags;
  }
  if (typeof input.dietaryNotes === 'string' && input.dietaryNotes.trim()) {
    ctx.dietaryNotes = input.dietaryNotes.trim().slice(0, 300);
  }
  return ctx;
}

/**
 * Shapes the request's `fixedStops` into validated {@link FixedStop}s. A stop is
 * dropped unless it carries finite coordinates and a name/title — a "fixed" stop
 * is by definition already located. Caps the list so a runaway client can't
 * balloon the prompt.
 */
function normalizeFixedStops(input: any): FixedStop[] {
  if (!Array.isArray(input)) return [];
  const out: FixedStop[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const lat = Number(raw.latitude);
    const lon = Number(raw.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const title =
      typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : '';
    const name =
      typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 160) : title;
    if (!title && !name) continue;
    const stop: FixedStop = {
      title: title || name,
      name,
      latitude: lat,
      longitude: lon,
    };
    if (isHHMM(raw.startTime)) stop.startTime = raw.startTime;
    if (isHHMM(raw.endTime)) stop.endTime = raw.endTime;
    const dur = Number(raw.durationMin);
    if (Number.isFinite(dur) && dur > 0 && dur <= 1440) stop.durationMin = Math.round(dur);
    if (typeof raw.notes === 'string' && raw.notes.trim()) stop.notes = raw.notes.trim().slice(0, 300);
    if (raw.locationType === 'business' || raw.locationType === 'residence') {
      stop.locationType = raw.locationType;
    }
    if (typeof raw.photoUrl === 'string' && raw.photoUrl.trim()) stop.photoUrl = raw.photoUrl.trim();
    const rating = Number(raw.rating);
    if (Number.isFinite(rating) && rating >= 0 && rating <= 5) stop.rating = rating;
    const rc = Number(raw.ratingCount);
    if (Number.isFinite(rc) && rc >= 0) stop.ratingCount = Math.round(rc);
    if (raw.openingHours && typeof raw.openingHours === 'object') {
      stop.openingHours = raw.openingHours as VenueOpeningHours;
    }
    out.push(stop);
    if (out.length >= 25) break;
  }
  return out;
}

/**
 * Shapes the request's `tasks` into validated {@link Task}s. A task needs only a
 * title; everything else is optional. Caps the list so a runaway client can't
 * balloon the prompt.
 */
function normalizeTasks(input: any): Task[] {
  if (!Array.isArray(input)) return [];
  const out: Task[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const title =
      typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim().slice(0, 160)
        : '';
    if (!title) continue;
    const task: Task = { title };
    if (isHHMM(raw.startTime)) task.startTime = raw.startTime;
    if (isHHMM(raw.endTime)) task.endTime = raw.endTime;
    const dur = Number(raw.durationMin);
    if (Number.isFinite(dur) && dur > 0 && dur <= 1440) task.durationMin = Math.round(dur);
    if (typeof raw.notes === 'string' && raw.notes.trim()) task.notes = raw.notes.trim().slice(0, 300);
    if (raw.atHome === true) task.atHome = true;
    // An at-home/online commitment never has a venue — drop any conflicting hints.
    if (task.atHome) {
      task.wantsVenue = false;
    } else {
      if (raw.wantsVenue === true) task.wantsVenue = true;
      if (typeof raw.placeQuery === 'string' && raw.placeQuery.trim()) {
        task.placeQuery = raw.placeQuery.trim().slice(0, 120);
      }
    }
    out.push(task);
    if (out.length >= 25) break;
  }
  return out;
}

/** Validates one edge of the day frame (`dayStart` / `dayEnd`). */
function normalizeDayEdge(input: any): DayEdge | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const edge: DayEdge = {};
  if (isHHMM(input.time)) edge.time = input.time;
  if (typeof input.label === 'string' && input.label.trim()) {
    edge.label = input.label.trim().slice(0, 160);
  }
  return edge.time || edge.label ? edge : undefined;
}

// ----------------------------------------------------------- Gemini prompt

function buildPlannerPrompt(args: {
  /** The user's free-text — STYLE/NOTES on an errand day, or the whole request
   *  on a no-errand discovery day. May be empty when the day is pure errands. */
  intent: string;
  home: HomePin | null;
  date: string;
  grounded: boolean;
  /** ANCHORS — already-located errands the planner must place verbatim. */
  anchors?: FixedStop[];
  /** TASKS — unplaced errands the planner schedules (and venues if place-y). */
  tasks?: Task[];
  /** Where/when the day should start and finish. */
  dayStart?: DayEdge;
  dayEnd?: DayEdge;
  userName?: string;
  wakeTime?: string;
  bedTime?: string;
  wakeUpDurationMin?: number;
  meals?: MealWindows;
  windDownTime?: string;
  allowScreenWindDown?: boolean;
  car?: CarContext;
  dietary?: string[];
  dietaryNotes?: string;
  /**
   * "HH:MM" current local time, set ONLY when the day being planned is the
   * user's today (so the day is already in progress). When present, the
   * planner plans the REMAINDER of the day from now instead of replaying the
   * morning. Absent for future days, which plan wake-to-sleep as usual.
   */
  now?: string;
}): string {
  const home = args.home;
  // `now` arrives ONLY when the day is genuinely underway: the client compares
  // the current time (real wall clock OR the dev fake clock) against the user's
  // head-out time and sends `now` only once it's PAST. So its mere presence means
  // "in progress" — plan the remainder from now and skip the morning. Absent (a
  // future day, or a today-plan at/before head-out — including a fake clock pinned
  // to the morning) the day is FRESH: open with the morning routine and plan it all.
  const dayUnderway = !!args.now;
  const includeMorning = !dayUnderway && !!args.wakeTime;
  const anchors = args.anchors ?? [];
  const tasks = args.tasks ?? [];
  // Errand-driven: the day is built from the user's real errands (anchors and/or
  // tasks). Otherwise it's a no-errand "plan me a day" request where the model
  // discovers and connects its own places.
  const errandDriven = anchors.length > 0 || tasks.length > 0;
  const homeBlock = home
    ? `- Home: "${home.label}" at latitude ${home.latitude}, longitude ${home.longitude}.`
    : '- The user has not pinned a home location. Keep venue picks generic and assume the day happens close to wherever they start.';
  const originDefault = args.dayStart?.label ?? home?.label ?? 'home';

  // ----- Personalisation context lines (only what we actually know) -----
  const nameLine = args.userName
    ? `- The user's name is ${args.userName}. You may address them warmly by name in the title/summary, but never force it.`
    : '';
  // Once the day is underway the wake time is irrelevant — only the wind-down/bed
  // anchor still matters for where the remaining day ends.
  const rhythmLine = dayUnderway
    ? args.bedTime
      ? `- The user usually winds down around ${args.bedTime}; end the plan with a wind-down/bed anchor near then.`
      : ''
    : args.wakeTime || args.bedTime
      ? `- Daily rhythm: the user usually ${
          args.wakeTime ? `wakes around ${args.wakeTime}` : 'wakes in the morning'
        } and ${
          args.bedTime ? `winds down around ${args.bedTime}` : 'ends in the evening'
        }. Keep the plan inside these hours and end with a wind-down/bed anchor near ${
          args.bedTime ?? 'their usual bedtime'
        }.`
      : '';
  // When the day is already underway, anchor the whole plan to "now" up front.
  // (A today-plan made BEFORE head-out is still treated as a fresh full day, so
  // no "in progress" framing — we want the morning, not a trimmed remainder.)
  const nowLine = dayUnderway
    ? `- RIGHT NOW it is ${args.now} on ${args.date}: the day being planned is TODAY and is already in progress.`
    : '';
  const dietLine =
    args.dietary && args.dietary.length > 0
      ? `- Dietary profile: ${args.dietary.join(', ')}.${
          args.dietaryNotes ? ` Notes/allergies: ${args.dietaryNotes}.` : ''
        }`
      : args.dietaryNotes
        ? `- Dietary notes/allergies: ${args.dietaryNotes}.`
        : '';

  // ----- Morning ramp-up, meal windows, wind-down (sleep-hygiene) lines -----
  // The day-frame start is the user's HEAD-OUT time (their first away-from-home
  // commitment), NOT when they wake — so on a still-fresh day (see
  // `includeMorning`) we prepend the at-home morning routine (wake → get ready →
  // breakfast) before it.
  const headOutTime = includeMorning ? args.dayStart?.time : undefined;
  const morningLine =
    includeMorning
      ? `- MORNING ROUTINE (at home, BEFORE heading out): the day-frame start${
          headOutTime ? ` (${headOutTime})` : ''
        } is when the user HEADS OUT for their first away-from-home commitment — NOT when they wake. Open the plan EARLIER, at home: a gentle wake/get-up block around ${
          args.wakeTime
        }${
          args.wakeUpDurationMin
            ? `, then about ${args.wakeUpDurationMin} min to get ready (shower, dress, coffee)`
            : ''
        }, and breakfast (inside its window when one is given)${
          headOutTime ? `, all wrapped up by ${headOutTime} so they leave on time` : ''
        }. These are AT-HOME items — omit the place field. Keep this first stretch easy: no demanding or high-focus activity before about ${
          args.wakeUpDurationMin
            ? addMinutesHHMM(args.wakeTime, args.wakeUpDurationMin)
            : args.wakeTime
        }. If the user pinned nothing before the head-out time, that gap is EXPECTED — fill it with this morning routine, not invented errands.`
      : '';

  const fmtWindow = (w?: MealWindow): string | null => {
    if (!w) return null;
    if (w.start && w.end) return `${w.start}–${w.end}`;
    if (w.start) return `from ${w.start}`;
    if (w.end) return `by ${w.end}`;
    return null;
  };
  const mealParts: string[] = [];
  if (args.meals) {
    const b = fmtWindow(args.meals.breakfast);
    const l = fmtWindow(args.meals.lunch);
    const d = fmtWindow(args.meals.dinner);
    if (b) mealParts.push(`breakfast ${b}`);
    if (l) mealParts.push(`lunch ${l}`);
    if (d) mealParts.push(`dinner ${d}`);
  }
  const mealsLine = mealParts.length
    ? `- Preferred meal windows: ${mealParts.join('; ')}. Schedule each meal so it starts inside its window. When a meal is eaten OUT, pick a venue CLOSE to the stops right before/after it (least detour) — never a famous spot across town; a meal at home needs no venue.`
    : '';

  const screenClause =
    args.allowScreenWindDown === false
      ? ' The user prefers NO screen-heavy wind-down — avoid TV/movies, video games, and phone-centric activities close to bed to protect sleep quality.'
      : args.allowScreenWindDown === true
        ? ' Screen-based wind-down (a movie, light gaming, a show) is OK for this user, but keep it low-stimulation as bedtime nears.'
        : '';
  const windDownLine = args.windDownTime
    ? `- Wind-down begins around ${args.windDownTime}: after that, do NOT schedule high-energy or stimulating activities (intense workouts, parties, big errands, anything that spikes adrenaline). Only calm, sleep-friendly activities are allowed then — reading, light stretching, journaling, a warm shower/bath, gentle music.${screenClause}`
    : '';

  // ----- Transport / car context line (the per-day, "only if needed" logic) -----
  const car = args.car;
  const carLine = !car || !car.owns
    ? '- Transport: the user has NO car available. Move them on foot, by bike, or public transit (a taxi/rideshare only when nothing else is reasonable). Never emit a "drive" leg for their own travel.'
    : !car.useToday
      ? '- Transport: the user HAS a car but is NOT using it today. Plan as if car-free — walking, transit, or taxi only. Do NOT emit any "drive" legs.'
      : '- Transport: the user has a car AVAILABLE today, but do NOT overuse it (see the transport rule). It may be used for only part of the day and parked back home before a night out.';
  // Venue-sourcing instruction differs by mode: grounded mode has live Google
  // Search; schema mode relies on the model's own knowledge + a downstream
  // Google Places validation pass, so we ask for approximate coords.
  const userQueryRule =
    ' WHENEVER the user names a venue or gives an address, you MUST set place.userQuery to their EXACT words for that place — verbatim, copied character-for-character from their request, NOT paraphrased (e.g. user wrote "visit mom at Kadaňská 837/18 dolní Chabry" → place.userQuery = "Kadaňská 837/18 dolní Chabry"; user wrote "hostinec u misku" → place.userQuery = "hostinec u misku"; "max fitness oc krakov" → place.userQuery = "max fitness oc krakov"). We geocode place.userQuery against Google Maps EXACTLY as the user typed it, so it is the single most important field — a paraphrased name like "Mom\'s House" geocodes to the WRONG place. Omit place.userQuery only for at-home items (which have no place at all).' +
    ' ALSO set place.locationType: "business" for a public business or point of interest (restaurant, pub, gym, shop, museum, office, station) — we fetch its photo, rating and opening hours — or "residence" for a private home / someone\'s flat or address (e.g. visiting mom at her address, a friend\'s house) — we just pin its exact address and show no rating/photo. When unsure, default to "business".';
  // Opening-hours discipline: a venue the model picks ITSELF must be open for
  // the whole planned block at the scheduled time (accounting for how long the
  // activity takes). User-named venues are sacrosanct — kept verbatim even if
  // they might be closed (the app shows a "consider changing" notice instead).
  const hoursRule =
    ` OPENING HOURS (the day is ${args.date}): for any venue YOU choose yourself (the user did NOT name it), pick one that is OPEN for the ENTIRE planned time block at its scheduled start/end time — factor in how long the activity needs. Never self-select a venue that is closed or about to close at that time; choose an alternative that is open for the whole visit instead. EXCEPTION: if the user NAMED the venue or gave its address, keep it EXACTLY as written even if it might be closed — do NOT substitute it.`;
  const venueRule = errandDriven
    ? '4. VENUES. The ANCHORS above are already located — place EACH one EXACTLY as given: copy its name verbatim into place.name, the same name into place.userQuery, the EXACT given latitude/longitude into place.coords, and set place.locationType. NEVER rename, move, swap, drop, or re-search an anchor. For a TASK that needs a venue (one marked "needs a place", or one that clearly happens somewhere — a workout, a coffee/meal out, focused work the user wants to do out of the house, a shop run, an appointment): name a REAL, SPECIFIC venue you actually know exists (include the branch, e.g. "Max Fitness Bílá Labuť"), set place.category to its type, and give your best APPROXIMATE coords — it is validated and geocoded against Google Places afterward, so approximate is fine. LOCATION IS CRUCIAL: put that venue CLOSE TO the stops scheduled immediately BEFORE and AFTER it so the day flows without backtracking — only fall back to "near home" when the task sits at the very start or end of the day. Minimise detour and NEVER pick a famous venue across town just because it is well-known; keep self-chosen venues within ~3 km of the neighbouring stops where reasonable and never beyond ~8 km. Do NOT set place.userQuery for a venue YOU chose; leaving it empty is what lets us verify your pick and swap it if it turns out closed. A task marked AT-HOME / ONLINE (a video or phone call, telehealth, remote work, a virtual class) has NO venue at all — schedule it at home and OMIT the place field; NEVER invent or search a venue for it. A pure at-home / no-place task (a phone call, admin, reading or a nap at home) also gets NO place. If the user NAMED a venue or address in their notes, use THAT exact place verbatim (and DO set place.userQuery to their words).' + userQueryRule + hoursRule
    : args.grounded
    ? '4. For every place the user goes to, use Google Search to find a REAL, SPECIFIC venue near home. Strongly prefer venues within ~3 km of home; never beyond ~8 km unless genuinely necessary. Do NOT pick a famous venue across town just because it\'s well-known. Return real name, address, rating (0–5), and an opening-status hint when known. CRITICAL — when the user NAMES a venue or gives an address (e.g. "hostinec U Mišků", "Max Fitness OC Krakov", "Kadaňská 837/18, Dolní Chabry"): use THAT EXACT place — never swap it for a different similarly-named venue. Copy the user\'s exact venue name into place.name and their exact address VERBATIM (street, number, district) into place.address.' + userQueryRule + hoursRule
    : '4. For every place the user goes to, name a REAL, SPECIFIC venue you know near home (include the branch, e.g. "Max Fitness Bílá Labuť", not just "Max Fitness"). Strongly prefer venues within ~3 km of home; never beyond ~8 km unless genuinely necessary. Give the real name, address, and your best APPROXIMATE coords — these are validated and geocoded against Google Places afterward, so approximate is fine. CRITICAL — when the user NAMES a venue or gives an address (e.g. "hostinec U Mišků", "Max Fitness OC Krakov", "Kadaňská 837/18, Dolní Chabry"): use THAT EXACT place — never swap it for a different similarly-named venue. Copy the user\'s exact venue name into place.name and their exact address VERBATIM into place.address.' + userQueryRule + hoursRule;

  // ANCHORS — already-located errands the user picked. The model places each
  // verbatim (never re-discover, rename, or move) and builds the day around them.
  const fmtAnchor = (s: FixedStop): string => {
    const when = s.startTime
      ? s.endTime
        ? ` — PINNED ${s.startTime}–${s.endTime} (START exactly at ${s.startTime}, do NOT move)`
        : ` — PINNED to START exactly at ${s.startTime} (do NOT move)`
      : s.durationMin
        ? ` (~${s.durationMin} min, time flexible)`
        : '';
    const note = s.notes ? ` — ${s.notes}` : '';
    const lt = s.locationType ? ` {${s.locationType}}` : '';
    return `- "${s.title}" → ${s.name}${lt} [${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}]${when}${note}`;
  };
  const anchorsBlock = anchors.length
    ? `\n\nANCHORS — stops the user has ALREADY chosen and located. These are the BACKBONE of the day. Include EVERY one as an item placed EXACTLY here: copy the venue name verbatim into place.name, set place.userQuery to that same name, set place.coords to the EXACT latitude/longitude given, and set place.locationType. NEVER rename, move, swap, drop, or re-search them — they are fixed. When an anchor shows a PINNED time, schedule it to START at EXACTLY that clock time and reserve EXACTLY its stated length — never nudge it earlier/later or stretch it to absorb travel, a meal, or the morning routine. Only an anchor with NO given time may be placed sensibly. Order, time, and route everything else AROUND these pinned times:\n${anchors.map(fmtAnchor).join('\n')}`
    : '';

  // TASKS — unplaced errands. The model schedules each; venue rule (#4) decides
  // whether it gets a model-named place or stays place-less (a call, admin).
  const fmtTask = (t: Task): string => {
    const when = t.startTime
      ? t.endTime
        ? ` — PINNED ${t.startTime}–${t.endTime} (START exactly at ${t.startTime}, do NOT move)`
        : ` — PINNED to START exactly at ${t.startTime} (do NOT move)`
      : t.durationMin
        ? ` (~${t.durationMin} min, time flexible)`
        : '';
    const need = t.atHome
      ? ' — AT-HOME / ONLINE: this has NO physical venue. Schedule it at home and OMIT the place field entirely — do NOT search for, invent, or attach a venue.'
      : t.wantsVenue
        ? ' — needs a place; find a suitable venue close to the stops scheduled right BEFORE/AFTER it (least detour), not across town'
        : '';
    const hint = !t.atHome && t.placeQuery ? ` [place hint: ${t.placeQuery}]` : '';
    const note = t.notes ? ` — ${t.notes}` : '';
    return `- "${t.title}"${when}${need}${hint}${note}`;
  };
  const tasksBlock = tasks.length
    ? `\n\nTASKS — things the user wants in the day that are NOT yet located. A task showing a PINNED time MUST start at EXACTLY that clock time and reserve EXACTLY its stated length — do not move it; one with no time you place sensibly:\n${tasks.map(fmtTask).join('\n')}`
    : '';

  // The free-text box: STYLE/NOTES that colour an errand day, or the whole
  // request on a no-errand discovery day.
  const intentLabel = errandDriven ? 'STYLE & NOTES' : 'USER REQUEST';
  const intentBlock =
    args.intent && args.intent.trim()
      ? `\n\n${intentLabel} (the user's own words${
          errandDriven
            ? ' — honour the vibe and any preferences, but the ANCHORS and TASKS above are what the day is actually made of'
            : ''
        }):\n"""\n${args.intent.trim()}\n"""`
      : '';

  const frameLine = [
    args.dayStart?.time
      ? `starts at ${args.dayStart.time}${args.dayStart.label ? ` from ${args.dayStart.label}` : ''}`
      : '',
    args.dayEnd?.time
      ? `finishes by ${args.dayEnd.time}${args.dayEnd.label ? ` at ${args.dayEnd.label}` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('; ');
  const frameContextLine = frameLine ? `- Day frame: ${frameLine}.` : '';

  const contextLines = [
    homeBlock,
    `- Today is ${args.date}.`,
    frameContextLine,
    nowLine,
    nameLine,
    rhythmLine,
    morningLine,
    mealsLine,
    windDownLine,
    carLine,
    dietLine,
  ]
    .filter(Boolean)
    .join('\n');

  // Requirement #2 (day coverage). On an ERRAND-driven day the errands ARE the
  // day — we forbid inventing filler and only add the connective tissue needed
  // to make them flow. On a no-errand discovery day the model builds the day
  // from the request. Both plan only the remainder when the day's underway, and
  // keep the gap-vs-break discipline for open stretches.
  const inProgressClause = dayUnderway
    ? ` The day is ALREADY UNDERWAY — it is currently ${args.now}: plan ONLY what still lies ahead, beginning at the stated start time (at or after ${args.now}), and NEVER schedule anything earlier than ${args.now} or replay what already happened (waking, getting ready, meals already eaten).`
    : '';
  // The at-home wake/wind-down allowance. On a fresh day with a known wake time
  // we WANT the morning routine (wake → prep → breakfast) and a wind-down →
  // sleep close — they're expected, not "invented filler". On a day already
  // underway we don't replay the morning; with no rhythm known we stay minimal.
  const morningAllowance = includeMorning
    ? ' OPEN the day with the at-home morning routine (wake → get ready → breakfast) BEFORE the head-out start time, and CLOSE it with a wind-down → sleep sequence — these personal routines are EXPECTED and never count as invented filler.'
    : dayUnderway
      ? ''
      : ' Add at most ONE light "get ready"/wake block at the start and ONE wind-down/sleep block at the end, and only when the user\'s rhythm calls for it.';
  const coverageRule = errandDriven
    ? `2. The ANCHORS and TASKS above ARE the day — build it AROUND them. Add ONLY the connective tissue that makes them flow: travel between stops, a meal when the user has a meal window and no meal errand covers it, and short rests. Do NOT invent extra activities, errands, or chores the user did not mention (no made-up "TikTok setup", "reserve therapy", or random shopping). You do NOT need to fill every minute: give any genuine open stretch of 20+ minutes its own "kind": "gap" block ("flexibility": "flexible", a friendly title, NO place).${morningAllowance}${inProgressClause}`
    : `2. Build the day from the user's request above, from the stated start to a sensible end. Flow continuously without invisible holes, but don't over-pad: give any genuine open stretch of 20+ minutes its own "kind": "gap" block ("flexibility": "flexible", a friendly title, NO place) rather than inflating activities. Reserve "kind": "break" for a SPECIFIC rest/chore (a nap, a shower).${inProgressClause}`;

  const transportRule =
    car && car.owns && car.useToday
      ? '\n11. TRANSPORT — "mode": "drive" means the user\'s OWN car, and it is available today. Use it ONLY when it genuinely helps (longer or awkward hops, carrying things, real time saved); keep short, easy hops on foot or transit. The car is a physical object: once driven somewhere it stays there until driven again, and it does NOT have to be used all day. It is perfectly fine to drive for only a few stops, return home to PARK it, then continue the rest of the day on foot/transit. CRUCIAL: never have the user drive after drinking alcohol — if the day includes drinks/bars/a night out, route them to drop the car at home (or leave it home) BEFORE the drinking starts, then continue by walking, transit, or taxi. Model "park the car at home" as a "drive" leg back home followed by an onward walk/transit leg.'
      : '\n11. TRANSPORT — the user has no car in play today. Never emit a "mode": "drive" leg for their own travel; move them on foot, by bike, or by public transit (a taxi only when truly necessary). Plan the whole day so it works without a private car.';

  const dietaryRule =
    (args.dietary && args.dietary.length > 0) || args.dietaryNotes
      ? '\n12. DIETARY — honour the user\'s dietary profile for EVERY food or drink venue YOU choose: pick places that genuinely serve suitable options (e.g. for vegan, somewhere with real vegan dishes, not just a token side salad), and never centre a meal on a listed allergen. This does NOT override a venue the USER named themselves — keep those verbatim even if the fit is imperfect.'
      : '';

  const hasMeals = !!(
    args.meals &&
    (args.meals.breakfast || args.meals.lunch || args.meals.dinner)
  );
  const routineRule =
    args.windDownTime || hasMeals || (includeMorning && args.wakeUpDurationMin)
      ? `\n13. DAILY RHYTHM & SLEEP HYGIENE — shape the day around the user's routine above.${
          hasMeals
            ? ' Schedule each meal ("kind": "meal") to START within its stated window, using "window" flexibility with windowStart/windowEnd set to that range so it can flex inside it but not drift outside.'
            : ''
        }${
          includeMorning && args.wakeUpDurationMin
            ? " Ease into the morning — keep the wake-up ramp gentle and don't schedule demanding focus work until the user is fully up."
            : ''
        }${
          args.windDownTime
            ? ` After ${args.windDownTime}, schedule ONLY calm, sleep-friendly activities — and this is exactly where any at-home wind-down TASKS the user has (skincare, reading, stretching, journaling) belong, placed back-to-back as the evening settles. Never put a high-energy block in the wind-down window, and close the day with the single fixed sleep/lights-out anchor near ${
                args.bedTime ?? 'bedtime'
              }.`
            : ''
        } This governs only activities YOU add: if the USER explicitly asks for something (a late workout, a movie, a night out), keep it even if it bends the routine.`
      : '';

  const intro = errandDriven
    ? `You are a thoughtful, practical day planner. The user's ERRANDS — the ANCHORS and TASKS below — are the backbone of the day. Your job is to ARRANGE them into one smooth, realistic, well-routed day: order them sensibly, time them, route between them, and add only the minimal connective tissue they need. You are NOT writing a day from scratch, and you do NOT add activities the user did not ask for.`
    : `You are a thoughtful, practical day planner who builds a great day from the user's request: real, specific venues near home, ordered to save time, flowing smoothly and mindfully.`;

  return `${intro}

CONTEXT
${contextLines}${anchorsBlock}${tasksBlock}${intentBlock}

REQUIREMENTS
1. PINNED TIMES ARE LAW. Any anchor or task shown with a clock time MUST start at EXACTLY that time and last EXACTLY its stated duration — this outranks travel, meals, the morning routine, and tidiness. NEVER slide a pinned item to make room for a commute or another block; instead arrange, compress, or drop the FLEXIBLE things around it. If a commute genuinely cannot fit before a pinned start, keep the pin and let the user arrive late rather than moving it. Also honour any other constraints in their notes (no-later-than, max-time-between, prerequisites). Order the rest of the day to save travel and make sense.
${coverageRule}
3. NEVER teleport. Between any two stops in different places, the user has to physically move. Model that movement via the "travelFromPrev" field on the SECOND stop, NOT as its own card — do NOT emit a "kind": "travel" item just to describe a short hop. The ONE exception is a long inter-city journey that is itself a meaningful block of the day (e.g. a 2-hour train ride, a flight): emit a "kind": "travel" item whose startTime/endTime/durationMinutes ARE the journey, with the transit breakdown attached as "travelFromPrev.steps" — and do NOT precede it with a "travel to station" lead-in item.
${venueRule}
5. AT-HOME activities (wake & prep, breakfast, cooking, showering, languages/reading at home, sleep) HAPPEN AT HOME. For these items, OMIT the "place" field entirely — do NOT emit "place": { "name": "Home", ... } or anything similar. The card will use the title and the user's home pin. Same rule for the implicit return-home leg.
6. Be precise about travel. Break transit journeys into concrete steps: walk to stop → bus/tram/metro → walk to destination. Include line labels ("Bus 152", "Metro C") and stop names when you actually know them. Mark every leg "estimated": true — you do not have live routing. If you're not sure of transit details, use a single estimated leg with realistic minutes instead of inventing line numbers.
7. Group items into sections with catchy headlines ("Morning Reset", "Gym & Recovery", "Languages", "Wind Down").
8. Each item needs realistic startTime / endTime / durationMinutes, plus a 1–2 sentence description.
9. The day-frame start time is when the user HEADS OUT (their first away-from-home commitment), NOT when they wake. Whenever the day hasn't started yet (a future day, or a today-plan where the current time is still at/before head-out), you MUST schedule the at-home morning routine (wake → get ready → breakfast) BEFORE the head-out time, then begin the out-and-about plan at the start time. Only skip the morning when the day is already underway (a current time is given that is PAST head-out). Wrap the day with a sensible end near its finish time (fall back to the user's usual rhythm when no frame is given).
10. Set "flexibility" deliberately — it is what lets the day re-flow when edited, so DEFAULT TO "flexible" and use "fixed" sparingly. Use "fixed" ONLY for (a) an ANCHOR or TASK the user pinned to a clock time, or a hard real-world commitment locked to an external clock — a reservation, ticketed event, class, meeting, appointment, or transport departure — and (b) exactly ONE closing bedtime/end anchor (e.g. a "Sleep" / "Lights out" block at 22:30). An ANCHOR or TASK given WITHOUT a time stays "flexible" — place it sensibly. Mark EVERYTHING ELSE "flexible": workouts and gym, self-care and routines (skincare, shower, getting ready), deep work, meals at home, walks, and sightseeing with no ticket. A personal routine like nightly skincare is FLEXIBLE — never "fixed" — unless the user explicitly pinned it to a clock time. "gap" and "break" blocks are ALWAYS "flexible". Use "window" for things bound to a range (venue opening hours, "before the last train"). ALWAYS end the day with that single fixed bedtime/end anchor: it is the one hard endpoint that lets a longer activity eat into nearby "gap" time instead of pushing the night past its end.${transportRule}${dietaryRule}${routineRule}

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
          "kind": "travel" | "work" | "sightseeing" | "meal" | "event" | "meetup" | "drinks" | "activity" | "break" | "gap" | "other",
          "flexibility": "fixed" | "window" | "flexible",
          "startTime": "HH:MM",
          "endTime": "HH:MM",
          "durationMinutes": 30,
          "place": {
            "name": "Max Fitness Krakov",
            "category": "Gym",
            "emoji": "🏋️",
            "address": "Lodžská 850/6, Prague 8",
            "userQuery": "max fitness oc krakov",
            "locationType": "business",
            "rating": 4.6,
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
          "description": "Strength session at the OC Krakov gym — the Max Fitness spot the user named."
        }
      ]
    }
  ]
}`;
}

// ----------------------------------------------------------- Gemini call

async function callGeminiPlanner(args: {
  prompt: string;
  apiKey: string;
  model: string;
  grounded: boolean;
}): Promise<
  | {
      ok: true;
      parsed: any;
      rawText: string;
      elapsedMs: number;
      sources: string[];
      model: string;
    }
  | { ok: false; status: number; detail: string }
> {
  // Grounded mode: attach the search tool, no schema (the two are mutually
  // exclusive). Schema mode: enforce JSON output via responseSchema so even
  // lighter models can't drift into prose / empty responses.
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
    generationConfig: args.grounded
      ? { temperature: 0.4 }
      : {
          temperature: 0.4,
          responseMimeType: 'application/json',
          responseSchema: PLANNER_SCHEMA,
        },
  };
  if (args.grounded) body.tools = [{ google_search: {} }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent?key=${args.apiKey}`;

  const t0 = Date.now();
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
    return { ok: false, status: 502, detail: `Gemini ${res.status}: ${detail.slice(0, 500)}` };
  }
  const data = await res.json();
  const elapsedMs = Date.now() - t0;
  const candidate = data?.candidates?.[0];
  const rawText: string = (candidate?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join('')
    .trim();
  const parsed = extractJsonObject(rawText);
  if (!parsed) {
    const reason = candidate?.finishReason ? ` finishReason=${candidate.finishReason}` : '';
    return {
      ok: false,
      status: 502,
      detail: `Model ${args.model} returned unparseable JSON.${reason} Raw: ${rawText.slice(0, 500)}`,
    };
  }
  const sources: string[] = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c: any) => c?.web?.title || c?.web?.uri)
    .filter((s: unknown): s is string => typeof s === 'string');
  return { ok: true, parsed, rawText, elapsedMs, sources, model: args.model };
}

// ----------------------------------------------------------- Google enrichment

interface EnrichedRecord {
  name: string;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
  photoUrl: string | null;
  openNow: boolean | null;
  openingHours: VenueOpeningHours | null;
  latitude: number;
  longitude: number;
}

// Field mask shared by the venue lookups — includes the weekly opening-hours
// periods so we can decide whether a stop is open for its SCHEDULED visit time
// (not just "open right now", which is all `openNow` tells us).
const PLACES_FIELD_MASK =
  'places.displayName,places.formattedAddress,places.shortFormattedAddress,' +
  'places.location,places.rating,places.userRatingCount,places.photos,' +
  'places.currentOpeningHours.openNow,places.currentOpeningHours.periods,' +
  'places.currentOpeningHours.weekdayDescriptions,places.regularOpeningHours.periods,' +
  'places.regularOpeningHours.weekdayDescriptions';

async function resolvePhotoUrl(
  photoName: string | undefined,
  apiKey: string,
): Promise<string | null> {
  if (!photoName) return null;
  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?key=${apiKey}&maxHeightPx=400&maxWidthPx=400&skipHttpRedirect=true`,
    );
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.photoUri === 'string' ? json.photoUri : null;
  } catch {
    return null;
  }
}

// A located stop further than this from home is almost certainly a bad
// geocode rather than a genuine plan (the "Dinner with Mom routed 61 km away"
// bug). Generous enough to allow a real trip to a neighbouring town, tight
// enough to reject a same-named venue resolved in the wrong country.
const MAX_PLAUSIBLE_VENUE_M = 80_000;

/**
 * One Google Places Text Search, biased to `center`. Returns the best
 * candidate as an EnrichedRecord (with photo resolved). When `preferName` is
 * given we pick the first NAME-similar hit, else Google's top relevance
 * result. Acceptance (name/address/distance) is the caller's job — this is
 * just the raw fetch + shape.
 */
async function searchPlaceText(
  query: string,
  center: Coords,
  radiusM: number,
  apiKey: string,
  preferName?: string,
): Promise<EnrichedRecord | null> {
  let data: any;
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: 5,
        rankPreference: 'RELEVANCE',
        locationBias: {
          circle: {
            center: { latitude: center.latitude, longitude: center.longitude },
            radius: Math.max(500, Math.min(50000, radiusM)),
          },
        },
      }),
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  const raw: any[] = Array.isArray(data?.places) ? data.places : [];
  if (raw.length === 0) return null;
  const match =
    (preferName && raw.find((p) => nameSimilar(p?.displayName?.text ?? '', preferName))) || raw[0];
  const lat = match?.location?.latitude;
  const lon = match?.location?.longitude;
  const name = match?.displayName?.text;
  if (typeof lat !== 'number' || typeof lon !== 'number' || typeof name !== 'string') {
    return null;
  }
  const photoUrl = await resolvePhotoUrl(match?.photos?.[0]?.name, apiKey);
  return {
    name,
    address:
      (typeof match.shortFormattedAddress === 'string' ? match.shortFormattedAddress : null) ??
      (typeof match.formattedAddress === 'string' ? match.formattedAddress : null),
    rating: typeof match.rating === 'number' ? match.rating : null,
    ratingCount: typeof match.userRatingCount === 'number' ? match.userRatingCount : null,
    photoUrl,
    openNow:
      typeof match?.currentOpeningHours?.openNow === 'boolean'
        ? match.currentOpeningHours.openNow
        : null,
    openingHours: extractOpeningHours(match),
    latitude: lat,
    longitude: lon,
  };
}

// --------------------------------------------------- open-alternative re-pick
//
// A lightweight category search used ONLY to rescue an AI-picked venue that
// turns out closed (or closing before the visit ends) at its scheduled time.
// Unlike `searchPlaceText` (which resolves one named venue) this returns the
// top candidates WITH their opening hours so the caller can pick one that is
// open for the whole planned block. Photos are resolved lazily for the winner.

interface PlaceCandidate {
  name: string;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
  openNow: boolean | null;
  openingHours: VenueOpeningHours | null;
  latitude: number;
  longitude: number;
  photoName?: string;
}

async function searchPlaceCandidates(
  query: string,
  center: Coords,
  radiusM: number,
  apiKey: string,
  limit = 12,
): Promise<PlaceCandidate[]> {
  let data: any;
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: Math.max(1, Math.min(20, limit)),
        rankPreference: 'RELEVANCE',
        locationBias: {
          circle: {
            center: { latitude: center.latitude, longitude: center.longitude },
            radius: Math.max(500, Math.min(50000, radiusM)),
          },
        },
      }),
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch {
    return [];
  }
  const raw: any[] = Array.isArray(data?.places) ? data.places : [];
  const out: PlaceCandidate[] = [];
  for (const p of raw) {
    const lat = p?.location?.latitude;
    const lon = p?.location?.longitude;
    const nm = p?.displayName?.text;
    if (typeof lat !== 'number' || typeof lon !== 'number' || typeof nm !== 'string') continue;
    out.push({
      name: nm,
      address:
        (typeof p.shortFormattedAddress === 'string' ? p.shortFormattedAddress : null) ??
        (typeof p.formattedAddress === 'string' ? p.formattedAddress : null),
      rating: typeof p.rating === 'number' ? p.rating : null,
      ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      openNow:
        typeof p?.currentOpeningHours?.openNow === 'boolean' ? p.currentOpeningHours.openNow : null,
      openingHours: extractOpeningHours(p),
      latitude: lat,
      longitude: lon,
      photoName: p?.photos?.[0]?.name,
    });
  }
  return out;
}

/**
 * Finds a same-category venue near home that is OPEN for the whole planned
 * window, used to replace an AI-picked stop that's closed/closing at its
 * scheduled time. Best-effort: returns null (caller keeps the original, which
 * the client then flags) if nothing suitable is found.
 */
async function findOpenAlternative(args: {
  category: string;
  excludeName: string;
  home: Coords;
  city: string | null;
  apiKey: string;
  dateISO: string;
  startHHMM: string;
  endHHMM: string;
}): Promise<EnrichedRecord | null> {
  const base = (args.category ?? '').trim();
  if (!base || !args.startHHMM) return null;
  const query =
    args.city && !base.toLowerCase().includes(args.city.toLowerCase())
      ? `${base}, ${args.city}`
      : base;
  const candidates = await searchPlaceCandidates(query, args.home, 6000, args.apiKey, 12);
  if (candidates.length === 0) return null;

  const best = candidates
    .map((c) => ({
      c,
      fit: visitFitsHours(c.openingHours, args.dateISO, args.startHHMM, args.endHHMM),
      dist: haversineMeters({ latitude: c.latitude, longitude: c.longitude }, args.home),
    }))
    // Only swap to a venue we can VERIFY is open for the whole visit, isn't the
    // one we're replacing, and isn't visibly low quality.
    .filter(
      (x) =>
        x.fit.fits &&
        !nameSimilar(x.c.name, args.excludeName) &&
        (x.c.rating == null || x.c.rating >= 4.0),
    )
    .sort((a, b) => a.dist - b.dist)[0];
  if (!best) return null;

  const photoUrl = await resolvePhotoUrl(best.c.photoName, args.apiKey);
  return {
    name: best.c.name,
    address: best.c.address,
    rating: best.c.rating,
    ratingCount: best.c.ratingCount,
    photoUrl,
    openNow: best.c.openNow,
    openingHours: best.c.openingHours,
    latitude: best.c.latitude,
    longitude: best.c.longitude,
  };
}

interface GeocodeHit {
  latitude: number;
  longitude: number;
  address: string | null;
  /** Rooftop / interpolated / street-address-typed — i.e. a real pinpoint
   *  rather than a city-center fallback. */
  precise: boolean;
}

/**
 * Google GEOCODING API — the right tool for a plain street address.
 *
 * Places Text Search is business/POI-biased: it answers "what venue is here?"
 * so a residential address ("Kadaňská 837/18, Dolní Chabry") has no business
 * to match and snaps to the nearest named place — that's the "Mom's House in
 * Letná" bug. The geocoder answers "where is this address?" and returns the
 * exact rooftop coordinate with no business required. We bias it to a viewport
 * around home so a same-named street elsewhere in the country loses.
 *
 * Needs the *Geocoding API* enabled on the key (a separate product from
 * Places/Routes); logs a clear, actionable hint if it isn't.
 */
async function geocodeAddress(
  query: string,
  apiKey: string,
  bounds?: string,
): Promise<GeocodeHit | null> {
  try {
    const params = new URLSearchParams({ address: query, key: apiKey });
    if (bounds) params.set('bounds', bounds);
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn(
        `[geocode] status=${data.status} ${data?.error_message ?? ''}` +
          (data.status === 'REQUEST_DENIED'
            ? ' — enable the "Geocoding API" on GOOGLE_PLACES_API_KEY in Google Cloud Console.'
            : ''),
      );
      return null;
    }
    const r = Array.isArray(data?.results) ? data.results[0] : null;
    const lat = Number(r?.geometry?.location?.lat);
    const lng = Number(r?.geometry?.location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const locType = r?.geometry?.location_type;
    const types: string[] = Array.isArray(r?.types) ? r.types : [];
    const precise =
      locType === 'ROOFTOP' ||
      locType === 'RANGE_INTERPOLATED' ||
      types.some((t) =>
        ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest'].includes(t),
      );
    return {
      latitude: lat,
      longitude: lng,
      address: typeof r?.formatted_address === 'string' ? r.formatted_address : null,
      precise,
    };
  } catch {
    return null;
  }
}

/** True when a query names a street + house number — better resolved by the
 *  geocoder than by business-biased Places search. Czech "čp/čo" numbers
 *  ("837/18") are the strongest tell; a standalone house number among words
 *  also counts. A pure venue name ("Max Fitness OC Krakov") has no number and
 *  stays on the Places path. */
function looksLikeStreetAddress(s: string): boolean {
  if (!s) return false;
  if (/\d+\s*\/\s*\d+/.test(s)) return true;
  return /\b\d{1,4}[a-z]?\b/i.test(s) && s.trim().split(/\s+/).length >= 2;
}

/** A ~110 km viewport around home, as Geocoding's `bounds` bias param. */
function boundsAround(home: Coords | null | undefined, deg = 0.5): string | undefined {
  if (!home) return undefined;
  const sw = `${(home.latitude - deg).toFixed(4)},${(home.longitude - deg).toFixed(4)}`;
  const ne = `${(home.latitude + deg).toFixed(4)},${(home.longitude + deg).toFixed(4)}`;
  return `${sw}|${ne}`;
}

// Relational / private-home words that strongly imply a RESIDENCE rather than
// a business — a backstop for when the model omits place.locationType. Kept
// narrow on purpose: generic "house"/"home" appears in real business names
// ("Bowling House") and would wrongly suppress their photo/rating.
const RESIDENCE_HINT_RE =
  /\b(mom|mum|mam|mommy|maminka|mami|dad|daddy|tata|t[áa]ta|parents?|grandma|grandpa|granny|babi|d[ěe]da|aunt|uncle|sister|brother)('?s)?\b/i;

/**
 * Resolves ONE venue to a real coordinate, KEEPING Google's photo/rating/
 * open-now whenever the place is a business. The model hands us a name, the
 * user's exact words, the address, an APPROXIMATE coord, and a locationType
 * ('business' | 'residence'). We route by that, because a business and a home
 * need opposite tools:
 *
 *   - BUSINESS → Places Text Search (gym, pub, shop). Only Places returns the
 *     photo + rating, so we try it FIRST and accept on a NAME match — the gate
 *     that stops a home snapping to a same-named storefront.
 *   - RESIDENCE → Geocoding API. A home isn't a business, so Places would snap
 *     to the nearest shop ("Mom's House in Letná"); the geocoder pins the exact
 *     address instead.
 *   - Unknown → try the business path, then fall back to geocoding the address.
 *
 * Everything is biased to HOME and rejected if it lands implausibly far, so a
 * hallucinated coord or a same-named place in another town can't win.
 */
async function lookupGooglePlace(args: {
  name: string;
  address?: string | null;
  userQuery?: string | null;
  locationType?: string | null;
  center: Coords;
  home?: Coords | null;
  city?: string | null;
  apiKey: string;
  radiusM?: number;
}): Promise<EnrichedRecord | null> {
  const name = (args.name ?? '').trim();
  const addr = typeof args.address === 'string' ? args.address.trim() : '';
  const uq = typeof args.userQuery === 'string' ? args.userQuery.trim() : '';
  const city = typeof args.city === 'string' ? args.city.trim() : '';
  if (!name && !addr && !uq) return null;

  // Home is the trustworthy anchor; the model's own coord is only a fallback
  // for when no home is pinned.
  const biasCenter = args.home ?? args.center;
  const radius = args.radiusM ?? 30000;
  const bounds = boundsAround(args.home);
  const withCity = (q: string) => (city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q}, ${city}` : q);
  const tooFar = (lat: number, lon: number): boolean =>
    !!args.home && haversineMeters({ latitude: lat, longitude: lon }, args.home) > MAX_PLAUSIBLE_VENUE_M;
  // A geocoded address keeps the model's friendly name ("Mom's") but takes the
  // real coordinate + canonical address from the geocoder.
  const fromGeocode = (g: GeocodeHit): EnrichedRecord => ({
    name: name || g.address || uq || addr,
    address: g.address ?? (addr || null),
    rating: null,
    ratingCount: null,
    photoUrl: null,
    openNow: null,
    openingHours: null,
    latitude: g.latitude,
    longitude: g.longitude,
  });

  // Accept a Places hit only when its name resembles what the user actually
  // asked for (their words or the model's name). This is what lets a business
  // through with full metadata while rejecting a wrong storefront.
  const matchesWanted = (n: string): boolean =>
    nameSimilar(n, name) || (uq.length >= 3 && nameSimilar(n, uq));

  const isResidence =
    args.locationType === 'residence' ||
    (args.locationType !== 'business' && RESIDENCE_HINT_RE.test(`${name} ${uq}`));
  const addrText = looksLikeStreetAddress(uq) ? uq : looksLikeStreetAddress(addr) ? addr : '';

  // 1) BUSINESS via Places — the ONLY path that returns photo + rating. Try the
  //    user's exact words first, then name+address, then name; accept on a name
  //    match so a residence can't grab a same-named shop. Skipped for homes.
  if (!isResidence) {
    const queries = [uq, name && addr ? `${name}, ${addr}` : '', name].filter(Boolean) as string[];
    const tried = new Set<string>();
    for (const q of queries) {
      const key = q.toLowerCase();
      if (tried.has(key)) continue;
      tried.add(key);
      const rec = await searchPlaceText(withCity(q), biasCenter, radius, args.apiKey, name || uq);
      if (rec && matchesWanted(rec.name) && !tooFar(rec.latitude, rec.longitude)) return rec;
    }
  }

  // 2) ADDRESS via the geocoder — exact coords, no business needed. This is the
  //    residence path, and the fallback when no business name matched above.
  const geoText = addrText || (isResidence ? uq || addr : '');
  if (geoText) {
    const g = await geocodeAddress(withCity(geoText), args.apiKey, bounds);
    if (g && g.precise && !tooFar(g.latitude, g.longitude)) return fromGeocode(g);
  }

  // 3) Address via Places — for an address that IS a storefront (no name match
  //    required; the address itself is the signal).
  if (addr) {
    const rec = await searchPlaceText(withCity(addr), biasCenter, radius, args.apiKey, name || uq);
    if (rec && !tooFar(rec.latitude, rec.longitude)) return rec;
  }

  // 4) Final geocode net — any words, even without a strong number pattern (an
  //    imprecise pin is still better than a wrong business across town).
  const lastResort = addr || uq;
  if (lastResort) {
    const g = await geocodeAddress(withCity(lastResort), args.apiKey, bounds);
    if (g && !tooFar(g.latitude, g.longitude)) return fromGeocode(g);
  }

  return null;
}

function openStatusFromBool(b: boolean | null): string | null {
  if (b === true) return 'Open now';
  if (b === false) return 'Closed now';
  return null;
}

/**
 * Does this resolved slot correspond to a PRE-PLANNED stop? We instruct the
 * model to copy a fixed stop's exact coords + name, so we match on coordinates
 * first (≤75 m, the same slack used for the home check) and fall back to a fuzzy
 * name match. A hit means we trust the client's pre-resolved place and skip the
 * Google lookup entirely.
 */
function matchFixedStop(
  slot: { name: string; userQuery: string; coords: Coords | null },
  fixedStops: FixedStop[],
): FixedStop | null {
  if (fixedStops.length === 0) return null;
  if (slot.coords) {
    for (const fs of fixedStops) {
      if (haversineMeters(slot.coords, { latitude: fs.latitude, longitude: fs.longitude }) <= 75) {
        return fs;
      }
    }
  }
  const label = slot.userQuery || slot.name;
  if (label) {
    for (const fs of fixedStops) {
      if (nameSimilar(label, fs.name)) return fs;
    }
  }
  return null;
}

/**
 * Walks the parsed itinerary and merges Google Places fields into every
 * unique venue the model returned. Skips:
 *   - items with no place block (at-home / break items the model wisely omits)
 *   - "Home"-looking place blocks (defensive — see scrubHomePlaces below)
 *   - venues whose model coords are essentially at home (≤ 75 m)
 * Mutates `parsed` in place.
 */
async function enrichItinerary(
  parsed: any,
  home: HomePin | null,
  apiKey: string,
  dateISO: string,
  fixedStops: FixedStop[] = [],
): Promise<void> {
  if (!parsed || !Array.isArray(parsed.sections)) return;

  const city = typeof parsed?.city === 'string' ? parsed.city.trim() : null;
  const homeC: Coords | null = home
    ? { latitude: home.latitude, longitude: home.longitude }
    : null;

  // Index every venue across the day. We key by name + rounded-coord so the
  // same place reused twice is resolved once; an address-only stop (a coord-
  // less venue the user named by address) keys on its address instead.
  interface Slot {
    item: any;
    name: string;
    address: string;
    userQuery: string;
    locationType: string;
    coords: Coords | null;
    /** The item's scheduled visit window, for the opening-hours fit check. */
    startTime: string;
    endTime: string;
    durationMinutes: number | null;
    /** Venue type the model assigned ("Czech restaurant"), used to re-pick. */
    category: string;
  }
  const slotsByKey = new Map<string, Slot[]>();
  const keyOf = (label: string, c: Coords | null) =>
    `${normaliseName(label)}|${c ? `${c.latitude.toFixed(3)},${c.longitude.toFixed(3)}` : 'addr'}`;

  for (const section of parsed.sections) {
    if (!section || !Array.isArray(section.items)) continue;
    for (const item of section.items) {
      const p = item?.place;
      if (!p || typeof p !== 'object') continue;
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      const address = typeof p.address === 'string' ? p.address.trim() : '';
      const userQuery = typeof p.userQuery === 'string' ? p.userQuery.trim() : '';
      const locationType = typeof p.locationType === 'string' ? p.locationType.trim().toLowerCase() : '';
      const category = typeof p.category === 'string' ? p.category.trim() : '';
      const startTime = typeof item.startTime === 'string' ? item.startTime : '';
      const endTime = typeof item.endTime === 'string' ? item.endTime : '';
      const durationMinutes = Number.isFinite(Number(item.durationMinutes))
        ? Number(item.durationMinutes)
        : null;
      const lat = Number(p?.coords?.latitude);
      const lon = Number(p?.coords?.longitude);
      const coords: Coords | null =
        Number.isFinite(lat) && Number.isFinite(lon) ? { latitude: lat, longitude: lon } : null;

      // Resolve a stop only when we have a name/address/user-phrase AND
      // something to anchor the search to (a coord hint, an address, or the
      // user's literal words). A bare ambiguous name with nothing else is left
      // alone so we don't geocode an at-home "reading nook" into a random café.
      if (!name && !address && !userQuery) continue;
      if (!coords && !address && !userQuery) continue;

      // Defensive: refuse to enrich anything that looks like "Home" — the
      // model is told not to emit one, but if it slips through we don't
      // want Google's nearest "Home"-named business to override the user.
      if (coords && looksLikeHome(name, coords, home)) {
        item.place = undefined;
        continue;
      }

      const k = keyOf(userQuery || name || address, coords);
      if (!slotsByKey.has(k)) slotsByKey.set(k, []);
      slotsByKey.get(k)!.push({
        item,
        name,
        address,
        userQuery,
        locationType,
        coords,
        startTime,
        endTime,
        durationMinutes,
        category,
      });
    }
  }

  if (slotsByKey.size === 0) return;

  // One lookup per unique venue, in parallel.
  await Promise.all(
    Array.from(slotsByKey.values()).map(async (slots) => {
      const { name, address, userQuery, locationType, coords } = slots[0];

      // PRE-PLANNED stop? The client already resolved this place (a located /
      // auto-resolved errand), so trust its coords + metadata and skip Google
      // entirely — the compose-mode cost win, and it guarantees the user's
      // chosen venue is never swapped.
      const fx = matchFixedStop({ name, userQuery, coords }, fixedStops);
      if (fx) {
        for (const { item, startTime, endTime, durationMinutes } of slots) {
          const hint = item.place && typeof item.place === 'object' ? item.place : {};
          const endForItem = visitEndHHMM(startTime, endTime, durationMinutes);
          const scheduledStatus = fx.openingHours
            ? openStatusForVisit(fx.openingHours, dateISO, startTime, endForItem)
            : null;
          item.place = {
            ...hint,
            name: fx.name,
            address: typeof hint.address === 'string' && hint.address ? hint.address : null,
            rating:
              typeof fx.rating === 'number'
                ? fx.rating
                : typeof hint.rating === 'number'
                  ? hint.rating
                  : null,
            ratingCount: typeof fx.ratingCount === 'number' ? fx.ratingCount : undefined,
            openStatus: scheduledStatus ?? undefined,
            openingHours: fx.openingHours ?? undefined,
            userNamed: true,
            photoUrl: fx.photoUrl ?? (typeof hint.photoUrl === 'string' ? hint.photoUrl : null),
            coords: { latitude: fx.latitude, longitude: fx.longitude },
          };
        }
        console.log(
          `[enrich] FIXED uq=${JSON.stringify(userQuery)} name=${JSON.stringify(name)} → ` +
            `${fx.name} @${fx.latitude.toFixed(4)},${fx.longitude.toFixed(4)} (no lookup)`,
        );
        return;
      }

      const center = coords ?? homeC;
      if (!center) return; // no anchor to bias the search to
      let record = await lookupGooglePlace({
        name,
        address,
        userQuery,
        locationType,
        center,
        home: homeC,
        city,
        apiKey,
      });
      // Compact resolution trace — read via `supabase functions logs
      // plan-itinerary`. Shows what the model gave us (userQuery / name /
      // address) and what Google matched, so a bad geocode is one line away.
      console.log(
        `[enrich] type=${locationType || '?'} uq=${JSON.stringify(userQuery)} ` +
          `name=${JSON.stringify(name)} addr=${JSON.stringify(address)} → ` +
          (record
            ? `${record.name} @${record.latitude.toFixed(4)},${record.longitude.toFixed(4)}` +
              (homeC
                ? ` (${Math.round(
                    haversineMeters({ latitude: record.latitude, longitude: record.longitude }, homeC) /
                      1000,
                  )}km from home)`
                : '')
            : 'NO MATCH'),
      );
      if (!record) {
        // Couldn't verify the venue. A model coord that sits absurdly far from
        // home is almost certainly hallucinated (the "routed 61 km away" bug) —
        // drop it so routing doesn't draw a phantom cross-country leg; the stop
        // falls back to unlocated instead of teleporting the whole day.
        if (homeC && coords && haversineMeters(coords, homeC) > MAX_PLAUSIBLE_VENUE_M) {
          for (const { item } of slots) {
            if (item.place && typeof item.place === 'object') item.place.coords = undefined;
          }
        }
        return;
      }
      // Opening-hours awareness. A venue the user NAMED (userQuery set) is kept
      // verbatim even if it's closed at the visit time — the card shows a
      // "consider changing" notice. A venue the AI chose ITSELF that won't be
      // open for the whole planned block is swapped for an open same-category
      // alternative near home; if none is found we keep it (the card warns).
      const userNamed = !!userQuery;
      const repStart = slots[0].startTime;
      const repEnd = visitEndHHMM(repStart, slots[0].endTime, slots[0].durationMinutes);
      if (!userNamed && homeC) {
        const fit = visitFitsHours(record.openingHours, dateISO, repStart, repEnd);
        if (fit.status === 'closed' || fit.status === 'closingSoon') {
          const alt = await findOpenAlternative({
            category: slots[0].category || slots[0].item?.title || record.name,
            excludeName: record.name,
            home: homeC,
            city,
            apiKey,
            dateISO,
            startHHMM: repStart,
            endHHMM: repEnd,
          });
          if (alt) {
            console.log(
              `[hours] re-picked AI venue ${JSON.stringify(record.name)} (${fit.status}) → ` +
                `${JSON.stringify(alt.name)} for ${repStart}-${repEnd || '?'}`,
            );
            record = alt;
          }
        }
      }

      for (const { item, startTime, endTime, durationMinutes } of slots) {
        const hint = item.place && typeof item.place === 'object' ? item.place : {};
        const endForItem = visitEndHHMM(startTime, endTime, durationMinutes);
        // Scheduled-time status string ("Open · Closes 6:00 PM" / "Closed at
        // this time"). Falls back to the live openNow flag when hours are
        // unknown (e.g. a residence or a venue Google has no hours for).
        const scheduledStatus =
          openStatusForVisit(record.openingHours, dateISO, startTime, endForItem) ??
          openStatusFromBool(record.openNow);
        item.place = {
          ...hint,
          name: record.name,
          address: record.address ?? hint.address ?? null,
          rating: record.rating ?? (typeof hint.rating === 'number' ? hint.rating : null),
          ratingCount: record.ratingCount,
          openStatus: scheduledStatus ?? undefined,
          openingHours: record.openingHours ?? undefined,
          userNamed: userNamed || undefined,
          photoUrl: record.photoUrl,
          coords: { latitude: record.latitude, longitude: record.longitude },
        };
      }
    }),
  );
}

const HOME_NAME_RE = /^(home|my home|house|residence)$/i;

function looksLikeHome(name: string, coords: Coords, home: HomePin | null): boolean {
  if (HOME_NAME_RE.test(name.trim())) return true;
  if (!home) return false;
  // The model often parrots the home address back as the place name.
  const homeLabel = home.label?.trim().toLowerCase() ?? '';
  if (homeLabel && normaliseName(name) === normaliseName(home.label)) return true;
  // Or it gives an obvious-home coordinate. 75 m is enough slack for
  // "Bohnice" vs "Pekařova 859/12" both pointing at the same building.
  if (haversineMeters(coords, home) <= 75) return true;
  return false;
}

/**
 * Belt-and-braces pass run BEFORE enrichment: strip any "Home"-looking
 * place block the model managed to emit despite the prompt. Operates on
 * the raw parsed object so the rest of the pipeline never sees them.
 */
function scrubHomePlaces(parsed: any, home: HomePin | null): void {
  if (!parsed || !Array.isArray(parsed.sections)) return;
  for (const section of parsed.sections) {
    if (!section || !Array.isArray(section.items)) continue;
    for (const item of section.items) {
      const p = item?.place;
      if (!p || typeof p !== 'object') continue;
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      const lat = Number(p?.coords?.latitude);
      const lon = Number(p?.coords?.longitude);
      if (!name) {
        item.place = undefined;
        continue;
      }
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        if (looksLikeHome(name, { latitude: lat, longitude: lon }, home)) {
          item.place = undefined;
        }
      } else if (HOME_NAME_RE.test(name)) {
        item.place = undefined;
      }
    }
  }
}

// ----------------------------------------------------------- entrypoint

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return jsonResponse(
      {
        error: 'GEMINI_API_KEY not configured on the server.',
        detail:
          'Set it via `supabase secrets set GEMINI_API_KEY=...` and redeploy this function.',
      },
      501,
    );
  }

  let payload: {
    // Errand-anchored contract:
    anchors?: any;
    tasks?: any;
    intent?: string;
    dayStart?: any;
    dayEnd?: any;
    // Shared:
    date?: string;
    now?: string;
    context?: any;
    fast?: boolean;
    // Legacy aliases (replan / adjust / jobs still send prose + fixedStops):
    request?: string;
    fixedStops?: any;
  };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  // ANCHORS — already-located errands. Accept the new `anchors` key or the
  // legacy `fixedStops` alias.
  const anchors = normalizeFixedStops(payload.anchors ?? payload.fixedStops);
  // TASKS — unplaced errands the planner schedules.
  const tasks = normalizeTasks(payload.tasks);
  // The free-text box. Back-compat: a legacy prose `request` (replan/adjust)
  // maps onto `intent`.
  const intent =
    typeof payload.intent === 'string' && payload.intent.trim()
      ? payload.intent.trim()
      : typeof payload.request === 'string'
        ? payload.request.trim()
        : '';
  // Must carry SOMETHING to plan — at least one errand or some text.
  if (anchors.length === 0 && tasks.length === 0 && !intent) {
    return jsonResponse(
      { error: 'Nothing to plan — provide `anchors`, `tasks`, or `intent` text.' },
      400,
    );
  }

  const dayStart = normalizeDayEdge(payload.dayStart);
  const dayEnd = normalizeDayEdge(payload.dayEnd);
  const date = typeof payload.date === 'string' ? payload.date : todayISO();
  // Current local time, sent by the client only when planning today — drives
  // the "plan from now, don't replay the morning" path in the prompt.
  const now = isHHMM(payload.now) ? payload.now : undefined;
  const context = normalizeContext(payload.context);
  // Re-plans of an existing day ask for the cheaper/faster grounded model.
  const fast = payload.fast === true;

  // Errand-driven days ARRANGE the user's real errands and need NO live venue
  // discovery — place-y tasks get a model-named venue the Google Places pass
  // then validates — so they run in schema mode on the cheap/fast model. We
  // only turn ON Google Search grounding when there's nothing to anchor to (a
  // pure "plan me a day" request) or the user's notes explicitly ask to find /
  // discover somewhere. This is the "no mode switch" behaviour: it adapts to
  // how much the model actually has to discover.
  const errandDriven = anchors.length > 0 || tasks.length > 0;
  const wantsDiscovery = !errandDriven || INTENT_DISCOVERY_RE.test(intent);
  const grounded = GROUNDING_ENABLED && wantsDiscovery;
  // A schema day that only ARRANGES located anchors + pure tasks (nothing needs
  // the model to discover a venue) runs the cheapest model — fast and cheap. As
  // soon as a task needs a model-named venue we use the reliable default for
  // better picks. Grounded discovery needs a Flash-class model (lite drifts
  // empty when grounding); a fast replan uses the cheaper grounded model.
  const anyTaskWantsVenue = tasks.some((t) => t.wantsVenue || !!t.placeQuery);
  const arrangeOnly = errandDriven && !anyTaskWantsVenue;
  const primaryModel = grounded
    ? fast
      ? CONFIGURED_FAST_GEMINI_MODEL
      : CONFIGURED_GEMINI_MODEL
    : arrangeOnly
      ? CONFIGURED_COMPOSE_GEMINI_MODEL
      : CONFIGURED_GEMINI_MODEL;

  // 1) Single Gemini call that arranges the day (schema-constrained for errand
  //    days, grounded with live search for discovery — see grounded above).
  const prompt = buildPlannerPrompt({
    intent,
    home: context.home ?? null,
    date,
    now,
    grounded,
    anchors,
    tasks,
    dayStart,
    dayEnd,
    userName: context.userName,
    wakeTime: context.wakeTime,
    bedTime: context.bedTime,
    wakeUpDurationMin: context.wakeUpDurationMin,
    meals: context.meals,
    windDownTime: context.windDownTime,
    allowScreenWindDown: context.allowScreenWindDown,
    car: context.car,
    dietary: context.dietary,
    dietaryNotes: context.dietaryNotes,
  });
  let gem = await callGeminiPlanner({
    prompt,
    apiKey: geminiKey,
    model: primaryModel,
    grounded,
  });
  // Self-heal a primary that fails or returns junk — a bad GEMINI_MODEL
  // override, the cheaper fast-replan model emitting an empty GROUNDED
  // response, or a lite-model hiccup. Retry once on the known-reliable default
  // (keeping the same grounded flag, so a schema-mode day stays schema mode)
  // rather than failing the whole request (which would drop the client to its
  // offline sample).
  if (!gem.ok && primaryModel !== DEFAULT_GEMINI_MODEL) {
    console.warn(
      `plan-itinerary: model "${primaryModel}" failed (${gem.detail}); retrying with "${DEFAULT_GEMINI_MODEL}".`,
    );
    gem = await callGeminiPlanner({
      prompt,
      apiKey: geminiKey,
      model: DEFAULT_GEMINI_MODEL,
      grounded,
    });
  }
  if (!gem.ok) {
    return jsonResponse({ error: 'Planner failed', detail: gem.detail }, gem.status);
  }
  const parsed = gem.parsed;

  // 2) Defensive: drop any "Home"-looking place blocks BEFORE enrichment so
  //    we never look those up in Google (this is what produced "ALZHEIMER
  //    HOME Libeň" as a "Home" match in the previous build).
  scrubHomePlaces(parsed, context.home ?? null);

  // 3) Per-unique-venue Google Places lookup to backfill photo, rating
  //    count, opening status, and canonical coords. Best-effort — never
  //    fail the request if Google hiccups.
  const googleKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
  if (googleKey) {
    try {
      await enrichItinerary(parsed, context.home ?? null, googleKey, date, anchors);
    } catch {
      // ignore — the unenriched plan is still useful
    }
  }

  return jsonResponse(parsed);
});
