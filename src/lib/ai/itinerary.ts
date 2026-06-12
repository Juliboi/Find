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
  VenueOpeningHours,
  VenueOpenPeriod,
} from '@/types/itinerary';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { SchedulerContext } from './scheduler';
import { uid } from '@/utils/id';
import { todayISO } from '@/utils/time';

export interface ItineraryDebug {
  request: unknown;
  response: unknown;
}

export interface ItineraryResult {
  itinerary: Itinerary | null;
  /** True when the planner produced the itinerary; false for the sample fallback. */
  usedAi: boolean;
  /** Populated only when `options.debug` was set. */
  debug?: ItineraryDebug;
}

interface PlanItineraryOptions {
  context?: SchedulerContext;
  date?: string;
  /**
   * "HH:MM" current local time. Pass it ONLY when `date` is the user's today,
   * so the planner schedules the REST of the day from now instead of replaying
   * the morning. Omit for future days (they plan wake-to-sleep as usual).
   */
  now?: string;
  debug?: boolean;
  /**
   * Re-planning an EXISTING day (an adjust-field escalation or an auto-replan
   * after an edit no longer fits) rather than generating from scratch. Routes
   * the request to the planner's cheaper + faster grounded model.
   */
  fast?: boolean;
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
  if (ctx.userName && ctx.userName.trim()) out.userName = ctx.userName.trim();
  if (ctx.wakeTime) out.wakeTime = ctx.wakeTime;
  if (ctx.bedTime) out.bedTime = ctx.bedTime;
  if (typeof ctx.wakeUpDurationMin === 'number' && ctx.wakeUpDurationMin > 0) {
    out.wakeUpDurationMin = ctx.wakeUpDurationMin;
  }
  // Comfortable meal windows, grouped so the planner can schedule each meal
  // inside its range. Each window omits ends it doesn't have.
  const meals: Record<string, { start?: string; end?: string }> = {};
  const addMeal = (
    name: 'breakfast' | 'lunch' | 'dinner',
    start?: string | null,
    end?: string | null,
  ) => {
    const window: { start?: string; end?: string } = {};
    if (start) window.start = start;
    if (end) window.end = end;
    if (window.start || window.end) meals[name] = window;
  };
  addMeal('breakfast', ctx.breakfastStart, ctx.breakfastEnd);
  addMeal('lunch', ctx.lunchStart, ctx.lunchEnd);
  addMeal('dinner', ctx.dinnerStart, ctx.dinnerEnd);
  if (Object.keys(meals).length > 0) out.meals = meals;
  if (ctx.windDownTime) out.windDownTime = ctx.windDownTime;
  if (typeof ctx.allowScreenWindDown === 'boolean') {
    out.allowScreenWindDown = ctx.allowScreenWindDown;
  }
  // Always describe car availability so the planner knows whether it may emit
  // any "drive" legs. `owns` gates the car entirely; `useToday` is the per-day
  // switch (off ⇒ plan as if car-free for, e.g., a night out).
  out.car = {
    owns: ctx.hasCar === true,
    useToday: ctx.hasCar === true && ctx.useCarToday !== false,
  };
  if (ctx.dietary && ctx.dietary.length > 0) out.dietary = ctx.dietary;
  if (ctx.dietaryNotes && ctx.dietaryNotes.trim()) {
    out.dietaryNotes = ctx.dietaryNotes.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- sanitization -----------------------------------------------------------
//
// The edge function returns a normalised Itinerary, but we still sanitise
// defensively so a server bug can't put React into bad shape (e.g. an
// undefined `flexibility` blowing up the rescheduler).

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

/**
 * Defensively reshapes the server's opening-hours blob into our
 * VenueOpeningHours. Drops malformed periods; returns undefined when nothing
 * usable remains so the UI treats hours as unknown (never falsely flagged).
 */
function sanitizeOpeningHours(raw: any): VenueOpeningHours | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.periods)) return undefined;
  const periods: VenueOpenPeriod[] = [];
  for (const p of raw.periods) {
    const o = p?.open;
    if (!o || !Number.isFinite(Number(o.day))) continue;
    const open = {
      day: Number(o.day),
      hour: Number(o.hour) || 0,
      minute: Number(o.minute) || 0,
    };
    const c = p?.close;
    if (c && Number.isFinite(Number(c.day))) {
      periods.push({
        open,
        close: { day: Number(c.day), hour: Number(c.hour) || 0, minute: Number(c.minute) || 0 },
      });
    } else {
      periods.push({ open });
    }
  }
  if (periods.length === 0) return undefined;
  const weekdayDescriptions = Array.isArray(raw.weekdayDescriptions)
    ? raw.weekdayDescriptions.filter((s: unknown) => typeof s === 'string')
    : undefined;
  return weekdayDescriptions && weekdayDescriptions.length
    ? { periods, weekdayDescriptions }
    : { periods };
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
    openingHours: sanitizeOpeningHours(raw.openingHours),
    userNamed: raw.userNamed === true ? true : undefined,
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
    // Google's REAL scheduled board/alight times ("HH:MM"). Must be preserved
    // here or the UI silently falls back to its stack-durations guess (the
    // "152 at 12:37" bug, when the real departure is 12:40).
    departAt: asHHMM(raw.departAt),
    arriveAt: asHHMM(raw.arriveAt),
    numStops:
      numStops !== undefined && numStops >= 0 ? Math.round(numStops) : undefined,
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
  const kind = sanitizeKind(raw.kind);
  // A gap IS open free time — it must always stay flexible so the elastic
  // scheduler can grow/shrink it and the user can drag it freely. A "fixed"
  // gap would wrongly pin the clock and tear holes on reorder, so coerce it.
  const flexibility =
    kind === 'gap' ? 'flexible' : sanitizeFlexibility(raw.flexibility);
  return {
    id: asString(raw.id) ?? uid('item'),
    title,
    kind,
    flexibility,
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
    gapBeforeMin: (() => {
      const n = asNumber(raw.gapBeforeMin);
      return n !== undefined && n >= 0 ? Math.round(n) : undefined;
    })(),
    description: asString(raw.description),
    arrival: raw.arrival === true ? true : undefined,
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

/** Validates a baked per-plan start pin; returns undefined when unusable so the
 *  key is omitted (recompute then falls back to home rather than a bad origin). */
function sanitizeStartLocation(
  v: any,
): { label?: string; latitude: number; longitude: number } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const lat = Number(v.latitude);
  const lon = Number(v.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  const label = asString(v.label);
  return label
    ? { label, latitude: lat, longitude: lon }
    : { latitude: lat, longitude: lon };
}

export function sanitizeItinerary(data: any): Itinerary | null {
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
  const startLocation = sanitizeStartLocation(data.startLocation);
  return {
    id: uid('itin'),
    title: asString(data.title) ?? 'Your day',
    summary: asString(data.summary),
    date: asString(data.date) ?? todayISO(),
    origin: asString(data.origin),
    // Only carry a valid pin — omitting the key (rather than writing undefined)
    // keeps the recompute merge from clobbering an input plan's baked start.
    ...(startLocation ? { startLocation } : {}),
    city: asString(data.city),
    sections,
  };
}

// --- public API -------------------------------------------------------------
//
// One thin call to the `plan-itinerary` edge function, which does the real
// work: a single grounded Gemini call to produce the whole day, then a
// per-unique-venue Google Places enrichment pass to backfill photos /
// ratings / opening hours. Falls back to a curated sample when Supabase
// isn't configured at all (purely offline dev), so the screen and the
// downstream rescheduling/store code are always exercisable.

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

  if (isSupabaseConfigured && supabase) {
    const body: Record<string, unknown> = { request: text };
    if (options.date) body.date = options.date;
    if (options.now) body.now = options.now;
    if (options.fast) body.fast = true;
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

  const sample = sampleItinerary(options.context?.home?.label);
  if (debug && debug.response === null) {
    debug.response = {
      note: 'Supabase not configured — returning sample itinerary.',
    };
  }
  return { itinerary: sample, usedAi: false, debug };
}

/**
 * A hand-built itinerary used as the offline fallback. Mirrors the
 * structure the planner returns so the sandbox demonstrates the full
 * object shape — sections with catchy titles, a sightseeing block
 * dissected into one concrete place per landmark, and "fixed" anchors
 * (meetup, event) the flexible blocks flow around.
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
