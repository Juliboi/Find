// Supabase Edge Function: plan-itinerary
//
// The "v2" planning architecture, server-side.
//
//   1. ONE grounded Gemini call (Gemini + Google Search) takes the user's
//      free-form description of a day and returns the WHOLE itinerary
//      (sections, items, time blocks, venues, approximate travel legs) in
//      a single pass — using Google Search to ground real venue names,
//      addresses, and ratings near the user's home.
//   2. A per-unique-venue Google Places lookup backfills the data Gemini
//      can't return: an auth-free CDN photo URL, the canonical place
//      coordinates, ratingCount, and an "Open now / Closed now" hint.
//      At-home activities (the model emits no place block for those) and
//      the home venue itself are skipped so we never resolve "Home" to
//      some random nearby building.
//
// Request body:
//   { request: string, date?: "YYYY-MM-DD", context?: { home?: { latitude, longitude, label } } }
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
import {
  detourMeters,
  distM,
  isEverydayIntent,
  midpoint,
  scoreCandidate,
} from '../_shared/venuePick.ts';

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
                    'pinned',
                    'searchQuery',
                    'area',
                    'locationType',
                    'coords',
                  ],
                  properties: {
                    name: { type: 'string' },
                    category: { type: 'string' },
                    emoji: { type: 'string' },
                    address: { type: 'string' },
                    userQuery: { type: 'string' },
                    // true ONLY for an exact venue/address the user named (kept
                    // verbatim); false/omitted when the model is self-picking.
                    pinned: { type: 'boolean', nullable: true },
                    // For a self-pick: the venue TYPE to search ("specialty
                    // coffee shop") + the area it belongs in ("Karlín"). The
                    // corridor picker resolves the actual on-route venue.
                    searchQuery: { type: 'string' },
                    area: { type: 'string' },
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

interface Context {
  home?: HomePin;
  userName?: string;
  /** "HH:MM" the user usually wakes. */
  wakeTime?: string;
  /** "HH:MM" the user usually winds down. */
  bedTime?: string;
  car?: CarContext;
  /** Canonical dietary tags (vegetarian, gluten-free, …). */
  dietary?: string[];
  /** Freeform dietary notes / allergies. */
  dietaryNotes?: string;
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

// Parcel lockers / pickup points masquerade as the venue type in a Places
// search — a "pharmacy" query surfaces a BENU "výdejní box", a "groceries" one
// a Zásilkovna/Z-BOX/AlzaBox locker. You can't actually shop or pick up a
// counter order there, so they must never win a self-pick. Tuned to known
// CZ/SK locker brands + generic "pickup/parcel box" wording; deliberately does
// NOT match a bare "box" (a CrossFit/bouldering "box" is a real gym).
const PARCEL_LOCKER_RE =
  /(v[ýy]dejn[íi]\s*(box|m[íi]sto|automat)|z[áa]silkovna|\bz-?box\b|alza\s?box|bal[íi]kovna|packeta|paczkomat|(parcel|pickup|package)\s*(box|shop|locker|point)|smart\s?box)/i;

function isParcelLocker(name: string): boolean {
  return !!name && PARCEL_LOCKER_RE.test(name);
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

// ----------------------------------------------------------- Gemini prompt

function buildPlannerPrompt(args: {
  userText: string;
  home: HomePin | null;
  date: string;
  grounded: boolean;
  userName?: string;
  wakeTime?: string;
  bedTime?: string;
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
  const inProgress = !!args.now;
  const homeBlock = home
    ? `- Home: "${home.label}" at latitude ${home.latitude}, longitude ${home.longitude}.`
    : '- The user has not pinned a home location. Keep venue picks generic and assume the day happens close to wherever they start.';
  const originDefault = home?.label ?? 'home';

  // ----- Personalisation context lines (only what we actually know) -----
  const nameLine = args.userName
    ? `- The user's name is ${args.userName}. You may address them warmly by name in the title/summary, but never force it.`
    : '';
  // It is already partway through today, so the wake time is irrelevant — only
  // the wind-down/bed anchor still matters for where the remaining day ends.
  const rhythmLine = inProgress
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
  const nowLine = args.now
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
    ' ALSO set place.locationType: "business" for a public business or point of interest (restaurant, pub, gym, shop, museum, office, station) — we fetch its photo, rating and opening hours — or "residence" for a private home / someone\'s flat or address (e.g. visiting mom at her address, a friend\'s house) — we just pin its exact address and show no rating/photo. When unsure, default to "business". ALSO set place.pinned: true on any venue or address the USER named — it marks an EXACT pick we resolve verbatim and never substitute.';
  // Opening-hours discipline: a venue the model picks ITSELF must be open for
  // the whole planned block at the scheduled time (accounting for how long the
  // activity takes). User-named venues are sacrosanct — kept verbatim even if
  // they might be closed (the app shows a "consider changing" notice instead).
  const hoursRule =
    ` OPENING HOURS (the day is ${args.date}): for any venue YOU choose yourself (the user did NOT name it), pick one that is OPEN for the ENTIRE planned time block at its scheduled start/end time — factor in how long the activity needs. Never self-select a venue that is closed or about to close at that time; choose an alternative that is open for the whole visit instead. EXCEPTION: if the user NAMED the venue or gave its address, keep it EXACTLY as written even if it might be closed — do NOT substitute it.`;
  // Self-picked venues are no longer locked to one specific (often far) branch:
  // the model emits a venue TYPE to search + the area it belongs in, and the
  // corridor-aware picker downstream chooses the real, on-route venue — which
  // is what stops a freshly planned day zig-zagging across the city.
  const selfPickRule =
    ' SELF-PICKED VENUES: when the user did NOT name a specific place (YOU are choosing it), or named only a BRAND/chain without a branch ("a Max Fitness", "a Billa"), do NOT commit to one specific branch. Set place.pinned: false, set place.searchQuery to the venue TYPE in 2–4 words ("specialty coffee shop", "24h pharmacy", "bouldering gym", "vegan lunch spot"), and set place.area to the neighbourhood it should sit in ("Karlín", "near Anděl"). Still include place.name (a real example you know) and approximate place.coords as a HINT for WHERE in the city it belongs — the app then resolves the real, on-route, currently-open venue near that area. Keep searchQuery generic enough to match several venues, never a single branch. ALWAYS emit this place block for ANY stop that physically happens at a venue — even a quick errand (pick up a prescription, grab a coffee, buy groceries); never leave such a stop with no place. CRUCIAL: the app swaps in the real branch AND recomputes the route to it, so anything you write naming a guessed branch will contradict the venue actually pinned. Keep the whole item generic: the TITLE, the DESCRIPTION, and any travel wording must refer to the spot by TYPE and relative position ("grab toothpaste at a pharmacy by the gym", "morning workout at the gym", "head to a café near the office") — do NOT put a specific shop, mall, branch, street or metro-stop name in the title, description, travel labels or transit steps for a self-picked/brand venue. When you must relate a self-picked stop to another stop, name that other stop BY ITS ROLE ("near the gym", "by the café", "close to the office") — NEVER by a neighbourhood, mall or street, because those other stops may themselves be app-picked and land elsewhere, so a named area in the prose contradicts the real route (e.g. write "grab toothpaste at a pharmacy near the gym", never "a pharmacy at OC Krakov").';
  const areaOrderRule =
    ' ROUTE SHAPE: order the located stops so the day flows through neighbourhoods coherently — cluster stops that are near each other and avoid crossing the city and doubling back. A tight, low-travel route matters more than a marginally better-known venue farther away.';
  const venueRule = args.grounded
    ? '4. For every place the user goes to, use Google Search to find a REAL, SPECIFIC venue near home. Strongly prefer venues within ~3 km of home; never beyond ~8 km unless genuinely necessary. Do NOT pick a famous venue across town just because it\'s well-known. Return real name, address, rating (0–5), and an opening-status hint when known. CRITICAL — when the user NAMES a venue or gives an address (e.g. "hostinec U Mišků", "Max Fitness OC Krakov", "Kadaňská 837/18, Dolní Chabry"): use THAT EXACT place — never swap it for a different similarly-named venue. Copy the user\'s exact venue name into place.name and their exact address VERBATIM (street, number, district) into place.address.' + userQueryRule + hoursRule + selfPickRule + areaOrderRule
    : '4. For every place the user goes to, name a REAL, SPECIFIC venue you know near home. Strongly prefer venues within ~3 km of home; never beyond ~8 km unless genuinely necessary. Give the real name, address, and your best APPROXIMATE coords — these are validated and geocoded against Google Places afterward, so approximate is fine. CRITICAL — when the user NAMES a venue or gives an address (e.g. "hostinec U Mišků", "Max Fitness OC Krakov", "Kadaňská 837/18, Dolní Chabry"): use THAT EXACT place — never swap it for a different similarly-named venue. Copy the user\'s exact venue name into place.name and their exact address VERBATIM into place.address.' + userQueryRule + hoursRule + selfPickRule + areaOrderRule;

  const contextLines = [
    homeBlock,
    `- Today is ${args.date}.`,
    nowLine,
    nameLine,
    rhythmLine,
    carLine,
    dietLine,
  ]
    .filter(Boolean)
    .join('\n');

  // Requirement #2 (day coverage) has two shapes. A future day is planned
  // wake-to-sleep; today is ALREADY underway, so we plan only the remainder
  // from "now" and never replay the morning (the "still creates the whole day"
  // bug). Both keep the same gap-vs-break discipline for open stretches.
  const coverageRule = inProgress
    ? `2. The day is ALREADY UNDERWAY — it is currently ${args.now}. Plan ONLY the remaining part of today, beginning at the user's stated start time above (which is at or after ${args.now}). The FIRST block must start then — NEVER schedule anything earlier than ${args.now}, and do NOT replay parts of the day that have already happened (waking up, getting ready, breakfast/lunch already eaten). Plan only what still lies ahead. Still flow continuously with no holes: emit an EXPLICIT free-time block with "kind": "gap", "flexibility": "flexible", a friendly title ("Free time", "Relax", "Downtime"), a realistic duration, and NO place for any open stretch of 20+ minutes; reserve "kind": "break" for a SPECIFIC rest/chore the user named (a nap, a shower, laundry).`
    : `2. Cover the WHOLE day continuously — never leave invisible holes in the clock. Wake → prep → breakfast → depart → travel → activity → rest → travel home → shower → etc. When the day has genuine breathing room (time to relax, recharge, or do whatever they feel like), emit an EXPLICIT free-time block with "kind": "gap", "flexibility": "flexible", a friendly title ("Free time", "Relax", "Downtime"), a realistic duration, and NO place — give 20+ minutes of slack its own gap block rather than padding other activities. Reserve "kind": "break" for a SPECIFIC rest/chore the user named (a nap, a shower, laundry); use "gap" for open, unstructured time the user can later name or fill themselves.`;

  const transportRule =
    car && car.owns && car.useToday
      ? '\n11. TRANSPORT — "mode": "drive" means the user\'s OWN car, and it is available today. Use it ONLY when it genuinely helps (longer or awkward hops, carrying things, real time saved); keep short, easy hops on foot or transit. The car is a physical object: once driven somewhere it stays there until driven again, and it does NOT have to be used all day. It is perfectly fine to drive for only a few stops, return home to PARK it, then continue the rest of the day on foot/transit. CRUCIAL: never have the user drive after drinking alcohol — if the day includes drinks/bars/a night out, route them to drop the car at home (or leave it home) BEFORE the drinking starts, then continue by walking, transit, or taxi. Model "park the car at home" as a "drive" leg back home followed by an onward walk/transit leg.'
      : '\n11. TRANSPORT — the user has no car in play today. Never emit a "mode": "drive" leg for their own travel; move them on foot, by bike, or by public transit (a taxi only when truly necessary). Plan the whole day so it works without a private car.';

  const dietaryRule =
    (args.dietary && args.dietary.length > 0) || args.dietaryNotes
      ? '\n12. DIETARY — honour the user\'s dietary profile for EVERY food or drink venue YOU choose: pick places that genuinely serve suitable options (e.g. for vegan, somewhere with real vegan dishes, not just a token side salad), and never centre a meal on a listed allergen. This does NOT override a venue the USER named themselves — keep those verbatim even if the fit is imperfect.'
      : '';

  return `You are a professional day planner who orders activities so they save time, make sense, flow smoothly, and feel mindful and realistic.

CONTEXT
${contextLines}

USER REQUEST (their own words, between triple quotes):
"""
${args.userText}
"""

REQUIREMENTS
1. Order the activities to save time and respect every constraint the user mentioned (no-later-than, max-time-between, prerequisites). Constraints may be in prose — read carefully.
${coverageRule}
3. NEVER teleport. Between any two stops in different places, the user has to physically move. Model that movement via the "travelFromPrev" field on the SECOND stop, NOT as its own card — do NOT emit a "kind": "travel" item just to describe a short hop. The ONE exception is a long inter-city journey that is itself a meaningful block of the day (e.g. a 2-hour train ride, a flight): emit a "kind": "travel" item whose startTime/endTime/durationMinutes ARE the journey, with the transit breakdown attached as "travelFromPrev.steps" — and do NOT precede it with a "travel to station" lead-in item.
${venueRule}
5. AT-HOME activities (wake & prep, breakfast, cooking, showering, languages/reading at home, sleep) HAPPEN AT HOME. For these items, OMIT the "place" field entirely — do NOT emit "place": { "name": "Home", ... } or anything similar. The card will use the title and the user's home pin. Same rule for the implicit return-home leg. PHONE / ADMIN ERRANDS — anything whose actual action is a call, text, email, online booking, reservation or scheduling ("call Bernard", "reserve a new therapy session", "book a table", "schedule a haircut") is done from wherever the user already is: treat it as AT-HOME and OMIT the "place" field. A place, clinic, neighbourhood or person mentioned in such an errand names WHAT it is about (which therapist, which restaurant) — it is NOT a destination to travel to, so never route the user there or emit a travel leg for it.
6. Be precise about travel. Break transit journeys into concrete steps: walk to stop → bus/tram/metro → walk to destination. Include line labels ("Bus 152", "Metro C") and stop names when you actually know them. Mark every leg "estimated": true — you do not have live routing. If you're not sure of transit details, use a single estimated leg with realistic minutes instead of inventing line numbers.
7. Group items into sections with catchy headlines ("Morning Reset", "Gym & Recovery", "Languages", "Wind Down").
8. Each item needs realistic startTime / endTime / durationMinutes, plus a 1–2 sentence description.
9. Use the user's stated start time. Wrap the day with a sensible end (e.g. "before sleep" implies sleep prep around 22:30–23:30 unless they said otherwise).
10. Set "flexibility" deliberately — it is what lets the day re-flow when edited, so DEFAULT TO "flexible" and use "fixed" sparingly. Use "fixed" ONLY for (a) hard real-world commitments locked to an external clock the user gave or clearly implied — a reservation, ticketed event, class, meeting, appointment, or transport departure — and (b) exactly ONE closing bedtime/end anchor (e.g. a "Sleep" / "Lights out" block at 22:30). Mark EVERYTHING ELSE "flexible": workouts and gym, self-care and routines (skincare, shower, getting ready), deep work, meals at home, walks, and sightseeing with no ticket. A personal routine like nightly skincare is FLEXIBLE — never "fixed" — unless the user explicitly pinned it to a clock time. "gap" and "break" blocks are ALWAYS "flexible". Use "window" for things bound to a range (venue opening hours, "before the last train"). ALWAYS end the day with that single fixed bedtime/end anchor: it is the one hard endpoint that lets a longer activity eat into nearby "gap" time instead of pushing the night past its end.${transportRule}${dietaryRule}

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
            "pinned": true,
            "searchQuery": "gym",
            "area": "Prague 8",
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
 * Picks the best REAL venue for a flexible stop (an AI self-pick, or a brand
 * the user named without a branch) by staying ON-CORRIDOR: it searches the
 * category/brand biased to the midpoint between the surrounding anchors, then
 * scores each candidate by detour (extra travel added to the day), rating,
 * review volume and whether it's open for the SCHEDULED window — the same math
 * the manual swap browser uses. This is the fix for venues scattering across
 * the city: a gym + a pharmacy now land between the stops that bracket them
 * instead of wherever the model first thought of.
 *
 * `brandFilter`, when set, restricts candidates to the named brand so we pick
 * its on-route branch rather than swapping the brand out. Returns null when
 * nothing suitable turns up, so the caller can fall back to a plain lookup.
 */
async function pickOnCorridor(args: {
  searchQuery: string;
  intent: string;
  brandFilter?: string | null;
  prevAnchor?: Coords | null;
  nextAnchor?: Coords | null;
  areaHint?: Coords | null;
  home: Coords | null;
  city: string | null;
  apiKey: string;
  dateISO: string;
  startHHMM: string;
  endHHMM?: string | null;
}): Promise<EnrichedRecord | null> {
  const base = (args.searchQuery ?? '').trim();
  if (!base) return null;
  const query =
    args.city && !base.toLowerCase().includes(args.city.toLowerCase())
      ? `${base}, ${args.city}`
      : base;

  // Seed the search somewhere sane, then bias to the corridor midpoint when we
  // know the brackets — mirrors find-places' route-aware locationBias.
  const seed = args.areaHint ?? args.home ?? args.prevAnchor ?? args.nextAnchor ?? null;
  if (!seed) return null;
  const prev = args.prevAnchor ?? null;
  const next = args.nextAnchor ?? null;
  const clamp = (m: number) => Math.min(10000, Math.max(800, Math.round(m)));
  let biasCenter: Coords = seed;
  let radius = 4000;
  if (prev && next) {
    biasCenter = midpoint(prev, next);
    radius = clamp(Math.max(radius, distM(prev, next) / 2 + 1200));
  } else if (prev) {
    biasCenter = midpoint(prev, seed);
    radius = clamp(Math.max(radius, distM(prev, seed) / 2 + 1200));
  } else if (next) {
    biasCenter = midpoint(next, seed);
    radius = clamp(Math.max(radius, distM(next, seed) / 2 + 1200));
  }

  const candidates = await searchPlaceCandidates(query, biasCenter, radius, args.apiKey, 15);
  if (candidates.length === 0) return null;

  const everyday = isEverydayIntent(args.intent, [base]);
  const brand = args.brandFilter?.trim() || null;
  const homeC = args.home;

  const scored = candidates
    .map((c, i) => {
      const coords: Coords = { latitude: c.latitude, longitude: c.longitude };
      const detourM = detourMeters(prev, next, coords);
      const fit = visitFitsHours(c.openingHours, args.dateISO, args.startHHMM, args.endHHMM);
      return {
        c,
        coords,
        status: fit.status,
        fits: fit.fits,
        score: scoreCandidate({
          bestPosition: i,
          place: {
            distanceM: homeC ? Math.round(distM(homeC, coords)) : 0,
            rating: c.rating,
            ratingCount: c.ratingCount,
            // Open state AT THE PLANNED VISIT TIME (from visitFitsHours), never
            // Google's live "open right now" flag — otherwise the real wall
            // clock, not the day being planned, would nudge venue ranking.
            openNow:
              fit.status === 'closed' ? false : fit.status === 'open' ? true : null,
          },
          radiusM: radius,
          everyday,
          detourM,
        }),
      };
    });
  // Drop the unusable: parcel lockers / pickup boxes (you can't shop there),
  // visibly-bad ratings, and the implausibly-far (a same-named venue resolved
  // in the wrong city).
  // Quality floor: for everyday commodity errands (pharmacy, grocery, café) the
  // nearby low-rated chain is exactly what you want — proximity beats stars, so
  // only screen out the genuinely awful. Destinations you travel to (gym,
  // museum) keep a real bar. A Dr.Max at 3.0★ next door must NOT lose to a 4.5★
  // pharmacy 40 min across town.
  const ratingFloor = everyday ? 2.5 : 3.8;
  const notLockerOrFar = (x) =>
    !isParcelLocker(x.c.name) &&
    !(homeC && haversineMeters(x.coords, homeC) > MAX_PLAUSIBLE_VENUE_M);
  let viable = scored.filter(
    (x) => notLockerOrFar(x) && !(x.c.rating != null && x.c.rating < ratingFloor),
  );
  // If the quality bar emptied the (route-aware) pool, keep the on-corridor
  // candidates anyway rather than returning null — null drops the stop to the
  // non-route-aware home lookup, which is how the pharmacy ended up 40 min away.
  if (viable.length === 0) viable = scored.filter(notLockerOrFar);
  // Prefer the user-named brand's on-route branch — but if NONE of its branches
  // surfaced on this corridor, fall back to the best real venue of the same
  // TYPE rather than returning null. Returning null drops the stop to the
  // caller's home-biased lookup of the model's guess, which is exactly how a
  // gym ended up "pinned at home"; a real on-corridor venue is what the user
  // asked for ("anywhere, as long as it fits the route and is a real place").
  const branded = brand ? viable.filter((x) => nameSimilar(x.c.name, brand)) : viable;
  const eligible = branded.length > 0 ? branded : viable;
  if (eligible.length === 0) return null;

  // Prefer venues open for the WHOLE visit; never let unknown hours exclude a
  // candidate. Drop only the definitively-closed unless that's all we have.
  const usable = eligible.filter((x) => x.status !== 'closed');
  const pool = usable.length > 0 ? usable : eligible;
  pool.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    return b.score - a.score;
  });
  const best = pool[0].c;

  const photoUrl = await resolvePhotoUrl(best.photoName, args.apiKey);
  return {
    name: best.name,
    address: best.address,
    rating: best.rating,
    ratingCount: best.ratingCount,
    photoUrl,
    openNow: best.openNow,
    openingHours: best.openingHours,
    latitude: best.latitude,
    longitude: best.longitude,
  };
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
  // A unique venue + everything needed to place it on-corridor.
  interface VenueGroup {
    slots: Slot[];
    /** Position of the group's first item in day order — its bracket point. */
    order: number;
    /** pinned = user named an EXACT place/address → resolve verbatim + anchor.
     *  flexible = an AI self-pick or a brand/type → corridor-aware pick. */
    pinned: boolean;
    /** What to search for when picking a flexible venue. */
    searchQuery: string;
    /** Restrict candidates to this brand when the user named a brand, not a
     *  specific branch ("a Max Fitness") — we then pick the on-route branch. */
    brandFilter: string | null;
    /** The model's approximate coord, used to seed the search area. */
    areaHint: Coords | null;
    /** Free-text goal, drives everyday-vs-destination distance sensitivity. */
    intent: string;
    /** Resolved venue (filled below); its coords act as an anchor for pinned. */
    record: EnrichedRecord | null;
  }
  const groupsByKey = new Map<string, VenueGroup>();
  const keyOf = (label: string, c: Coords | null) =>
    `${normaliseName(label)}|${c ? `${c.latitude.toFixed(3)},${c.longitude.toFixed(3)}` : 'addr'}`;

  let order = 0;
  for (const section of parsed.sections) {
    if (!section || !Array.isArray(section.items)) continue;
    for (const item of section.items) {
      const pos = order++;
      const p = item?.place;
      if (!p || typeof p !== 'object') continue;
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      const address = typeof p.address === 'string' ? p.address.trim() : '';
      const userQuery = typeof p.userQuery === 'string' ? p.userQuery.trim() : '';
      const locationType = typeof p.locationType === 'string' ? p.locationType.trim().toLowerCase() : '';
      const category = typeof p.category === 'string' ? p.category.trim() : '';
      const searchQueryHint = typeof p.searchQuery === 'string' ? p.searchQuery.trim() : '';
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

      const slot: Slot = {
        item, name, address, userQuery, locationType, coords,
        startTime, endTime, durationMinutes, category,
      };
      const k = keyOf(userQuery || name || address, coords);
      let group = groupsByKey.get(k);
      if (!group) {
        // Classify the venue. The model's `pinned` flag is authoritative when
        // present; absent (legacy / first pass) we keep the SAFE default — a
        // user-named venue stays verbatim, an AI self-pick becomes flexible so
        // it gets chosen on-corridor instead of wherever the model guessed.
        const userNamed = !!userQuery;
        const pinnedFlag = p.pinned === true ? true : p.pinned === false ? false : null;
        const pinned = pinnedFlag === true || (pinnedFlag == null && userNamed);
        const brandFilter = !pinned && userNamed ? name || userQuery : null;
        const searchQuery = pinned
          ? userQuery || name || address
          : brandFilter
            ? userQuery || name
            : searchQueryHint || category || name;
        group = {
          slots: [],
          order: pos,
          pinned,
          searchQuery,
          brandFilter,
          areaHint: coords,
          intent: `${typeof item?.title === 'string' ? item.title : ''} ${category} ${searchQuery}`.trim(),
          record: null,
        };
        groupsByKey.set(k, group);
      }
      group.slots.push(slot);
    }
  }

  const groups = Array.from(groupsByKey.values());
  if (groups.length === 0) return;

  // 1) Resolve the PINNED venues (exact user picks) first — together with home
  //    they are the anchors a flexible pick brackets its corridor against.
  await Promise.all(
    groups
      .filter((g) => g.pinned)
      .map(async (g) => {
        const rep = g.slots[0];
        const center = rep.coords ?? homeC;
        if (!center) return;
        g.record = await lookupGooglePlace({
          name: rep.name,
          address: rep.address,
          userQuery: rep.userQuery,
          locationType: rep.locationType,
          center,
          home: homeC,
          city,
          apiKey,
        });
      }),
  );

  // 2) Ordered anchor list: home brackets each end, resolved pinned venues sit
  //    at their day position. A flexible stop reads the nearest anchor on each
  //    side to define the corridor it must stay on.
  interface Anchor {
    order: number;
    coords: Coords;
  }
  const anchors: Anchor[] = [];
  if (homeC) {
    anchors.push({ order: -1, coords: homeC });
    anchors.push({ order: Number.MAX_SAFE_INTEGER, coords: homeC });
  }
  for (const g of groups) {
    if (g.pinned && g.record) {
      anchors.push({
        order: g.order,
        coords: { latitude: g.record.latitude, longitude: g.record.longitude },
      });
    }
  }
  const anchorBefore = (pos: number): Coords | null => {
    let best: Anchor | null = null;
    for (const a of anchors) if (a.order < pos && (!best || a.order > best.order)) best = a;
    return best?.coords ?? null;
  };
  const anchorAfter = (pos: number): Coords | null => {
    let best: Anchor | null = null;
    for (const a of anchors) if (a.order > pos && (!best || a.order < best.order)) best = a;
    return best?.coords ?? null;
  };

  // 3) Resolve FLEXIBLE venues on-corridor, in parallel — each depends only on
  //    anchors (already resolved). If the corridor search comes up empty we
  //    fall back to the plain home-biased lookup + closed→open re-pick so the
  //    stop still lands on a real, open venue.
  await Promise.all(
    groups
      .filter((g) => !g.pinned)
      .map(async (g) => {
        const rep = g.slots[0];
        const repEnd = visitEndHHMM(rep.startTime, rep.endTime, rep.durationMinutes);
        g.record = await pickOnCorridor({
          searchQuery: g.searchQuery,
          intent: g.intent,
          brandFilter: g.brandFilter,
          prevAnchor: anchorBefore(g.order),
          nextAnchor: anchorAfter(g.order),
          areaHint: g.areaHint,
          home: homeC,
          city,
          apiKey,
          dateISO,
          startHHMM: rep.startTime,
          endHHMM: repEnd,
        });
        if (g.record) return;
        const center = rep.coords ?? homeC;
        if (!center) return;
        let record = await lookupGooglePlace({
          name: rep.name,
          address: rep.address,
          userQuery: rep.userQuery,
          locationType: rep.locationType,
          center,
          home: homeC,
          city,
          apiKey,
        });
        if (record && homeC) {
          const fit = visitFitsHours(record.openingHours, dateISO, rep.startTime, repEnd);
          if (fit.status === 'closed' || fit.status === 'closingSoon') {
            const alt = await findOpenAlternative({
              category: rep.category || rep.item?.title || record.name,
              excludeName: record.name,
              home: homeC,
              city,
              apiKey,
              dateISO,
              startHHMM: rep.startTime,
              endHHMM: repEnd,
            });
            if (alt) record = alt;
          }
        }
        g.record = record;
      }),
  );

  // 4) Merge the resolved venue back onto every item in each group.
  for (const g of groups) {
    const rep = g.slots[0];
    const record = g.record;
    if (!record) {
      // Couldn't verify the venue. Drop the model's coord when keeping it would
      // mislead: (a) it sits absurdly far from home (the "routed 61 km away"
      // hallucination) so routing won't draw a phantom cross-country leg; or
      // (b) it's a venue WE were meant to pick (not a user-pinned address) yet
      // the guess sits right on top of home — that renders as a "gym pinned at
      // home" phantom. Either way the stop falls back to unlocated instead.
      const c = rep.coords;
      const farAway = !!(homeC && c && haversineMeters(c, homeC) > MAX_PLAUSIBLE_VENUE_M);
      const onTopOfHome = !!(homeC && c && !g.pinned && haversineMeters(c, homeC) < 150);
      if (farAway || onTopOfHome) {
        for (const { item } of g.slots) {
          if (item.place && typeof item.place === 'object') item.place.coords = undefined;
        }
      }
      continue;
    }
    // Only an EXACT user pick stays "userNamed" (kept verbatim, no swap nudge).
    // A brand we resolved to a specific branch is an app choice, not flagged.
    const userNamed = g.pinned && !!rep.userQuery;
    // Compact resolution trace — read via `supabase functions logs
    // plan-itinerary`: what we searched and where Google landed it, so a
    // scattered pick is one line away.
    console.log(
      `[enrich] ${g.pinned ? 'pinned' : 'flexible'} q=${JSON.stringify(g.searchQuery)}` +
        (g.brandFilter ? ` brand=${JSON.stringify(g.brandFilter)}` : '') +
        ` → ${record.name} @${record.latitude.toFixed(4)},${record.longitude.toFixed(4)}` +
        (homeC
          ? ` (${Math.round(
              haversineMeters({ latitude: record.latitude, longitude: record.longitude }, homeC) / 1000,
            )}km from home)`
          : ''),
    );
    for (const { item, startTime, endTime, durationMinutes } of g.slots) {
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
  }
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

  let payload: { request?: string; date?: string; now?: string; context?: any; fast?: boolean };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const request = typeof payload.request === 'string' ? payload.request.trim() : '';
  if (!request) {
    return jsonResponse({ error: 'Missing `request` text.' }, 400);
  }
  const date = typeof payload.date === 'string' ? payload.date : todayISO();
  // Current local time, sent by the client only when planning today — drives
  // the "plan from now, don't replay the morning" path in the prompt.
  const now = isHHMM(payload.now) ? payload.now : undefined;
  const context = normalizeContext(payload.context);
  // Re-plans of an existing day ask for the cheaper/faster grounded model.
  const fast = payload.fast === true;
  const primaryModel = fast ? CONFIGURED_FAST_GEMINI_MODEL : CONFIGURED_GEMINI_MODEL;

  // 1) Single Gemini call that produces the whole itinerary (grounded with
  //    live search, or schema-constrained — see GROUNDING_ENABLED).
  const prompt = buildPlannerPrompt({
    userText: request,
    home: context.home ?? null,
    date,
    now,
    grounded: GROUNDING_ENABLED,
    userName: context.userName,
    wakeTime: context.wakeTime,
    bedTime: context.bedTime,
    car: context.car,
    dietary: context.dietary,
    dietaryNotes: context.dietaryNotes,
  });
  let gem = await callGeminiPlanner({
    prompt,
    apiKey: geminiKey,
    model: primaryModel,
    grounded: GROUNDING_ENABLED,
  });
  // Self-heal a primary that fails or returns junk — a bad GEMINI_MODEL
  // override, or the cheaper fast-replan model emitting an empty GROUNDED
  // response. Retry once on the known-reliable default rather than failing the
  // whole request (which would drop the client to its offline sample).
  if (!gem.ok && primaryModel !== DEFAULT_GEMINI_MODEL) {
    console.warn(
      `plan-itinerary: model "${primaryModel}" failed (${gem.detail}); retrying with "${DEFAULT_GEMINI_MODEL}".`,
    );
    gem = await callGeminiPlanner({
      prompt,
      apiKey: geminiKey,
      model: DEFAULT_GEMINI_MODEL,
      grounded: GROUNDING_ENABLED,
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
      await enrichItinerary(parsed, context.home ?? null, googleKey, date);
    } catch {
      // ignore — the unenriched plan is still useful
    }
  }

  return jsonResponse(parsed);
});
