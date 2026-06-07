// Shared travel routing + day-scheduling logic for the itinerary functions.
//
// Both `plan-itinerary` (fresh AI plan) and `recompute-itinerary` (re-route
// after a user edit) turn an itinerary's structure + durations into a real
// clock: for each consecutive pair of LOCATED stops we ask Google Routes for
// the true door-to-door time (mode-aware), then cascade start/end times from
// the day's anchor, snapping fixed commitments to their hard time. Keeping it
// here means there is ONE source of truth for how a day's travel is computed.

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck Deno runtime - types resolved by Supabase tooling at deploy time.

export type TravelMode = 'walk' | 'bike' | 'transit' | 'drive';

export interface Coords {
  latitude: number;
  longitude: number;
}

export interface LocationPin {
  label: string;
  latitude: number;
  longitude: number;
}

export interface Context {
  home?: LocationPin;
  work?: LocationPin;
  endOfDay?: LocationPin;
  currentLocation?: { latitude: number; longitude: number };
}

export function haversineMeters(a: Coords, b: Coords): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Straight-line under-counts real routing distance; pad before picking mode.
export const DETOUR_FACTOR = 1.3;

const SPEED_M_PER_MIN: Record<TravelMode, number> = {
  walk: 80,
  bike: 250,
  transit: 200,
  drive: 400,
};
const MODE_OVERHEAD_MIN: Record<TravelMode, number> = {
  walk: 1,
  bike: 2,
  transit: 4,
  drive: 3,
};
const ROUTES_TRAVEL_MODE: Record<TravelMode, string> = {
  walk: 'WALK',
  bike: 'BICYCLE',
  transit: 'TRANSIT',
  drive: 'DRIVE',
};

export function pickMode(distanceM: number): TravelMode {
  if (distanceM <= 1300) return 'walk';
  return 'transit';
}

export function estimateMinutes(distanceM: number, mode: TravelMode): number {
  return Math.max(1, Math.round(distanceM / SPEED_M_PER_MIN[mode] + MODE_OVERHEAD_MIN[mode]));
}

export type TravelStepMode = 'walk' | 'bus' | 'tram' | 'subway' | 'train' | 'ferry' | 'transit';

export interface TravelStep {
  mode: TravelStepMode;
  line?: string;
  from?: string;
  to?: string;
  durationMinutes?: number;
  numStops?: number;
  fromCoords?: Coords;
  toCoords?: Coords;
}

export interface RouteResult {
  minutes: number;
  distanceMeters?: number;
  steps?: TravelStep[];
  polyline?: string;
}

/** Google Routes transit vehicle type -> our coarse step sub-mode. */
function vehicleToStepMode(type: unknown): TravelStepMode {
  switch (type) {
    case 'BUS':
    case 'INTERCITY_BUS':
    case 'TROLLEYBUS':
    case 'SHARE_TAXI':
      return 'bus';
    case 'SUBWAY':
    case 'METRO_RAIL':
    case 'MONORAIL':
      return 'subway';
    case 'TRAM':
    case 'LIGHT_RAIL':
    case 'CABLE_CAR':
    case 'GONDOLA_LIFT':
    case 'FUNICULAR':
      return 'tram';
    case 'HEAVY_RAIL':
    case 'RAIL':
    case 'COMMUTER_TRAIN':
    case 'HIGH_SPEED_TRAIN':
    case 'LONG_DISTANCE_TRAIN':
      return 'train';
    case 'FERRY':
      return 'ferry';
    default:
      return 'transit';
  }
}

function secsToMin(v: unknown): number | undefined {
  const secs = typeof v === 'string' ? parseInt(v.replace(/s$/, ''), 10) : Number(v);
  return Number.isFinite(secs) ? Math.max(1, Math.round(secs / 60)) : undefined;
}

/** Reads a {latitude, longitude} out of a Routes API latLng, if present. */
function latLngOf(loc: any): Coords | undefined {
  const ll = loc?.latLng ?? loc;
  const lat = Number(ll?.latitude);
  const lng = Number(ll?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng)
    ? { latitude: lat, longitude: lng }
    : undefined;
}

/** Pulls a readable walk -> bus -> metro -> train breakdown out of a route. */
function parseSteps(route: any): TravelStep[] {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const out: TravelStep[] = [];
  for (const leg of legs) {
    const steps = Array.isArray(leg?.steps) ? leg.steps : [];
    for (const st of steps) {
      if (st?.travelMode === 'TRANSIT' && st?.transitDetails) {
        const td = st.transitDetails;
        const line: string | undefined =
          td?.transitLine?.nameShort || td?.transitLine?.name || undefined;
        out.push({
          mode: vehicleToStepMode(td?.transitLine?.vehicle?.type),
          line: typeof line === 'string' ? line : undefined,
          from: typeof td?.stopDetails?.departureStop?.name === 'string'
            ? td.stopDetails.departureStop.name
            : undefined,
          to: typeof td?.stopDetails?.arrivalStop?.name === 'string'
            ? td.stopDetails.arrivalStop.name
            : undefined,
          durationMinutes: secsToMin(st?.staticDuration),
          numStops: typeof td?.stopCount === 'number' ? td.stopCount : undefined,
          fromCoords: latLngOf(td?.stopDetails?.departureStop?.location),
          toCoords: latLngOf(td?.stopDetails?.arrivalStop?.location),
        });
      } else if (st?.travelMode === 'WALK') {
        const dmin = secsToMin(st?.staticDuration);
        // Skip trivial in-station shuffles; keep walks that matter.
        if (dmin && dmin >= 2) out.push({ mode: 'walk', durationMinutes: dmin });
      }
    }
  }
  return out;
}

/**
 * Real door-to-door route via Google Routes (computeRoutes): total minutes
 * plus the transit step breakdown. Returns null on any failure so the
 * caller can fall back to the haversine estimate.
 */
async function computeRoute(
  origin: Coords,
  dest: Coords,
  mode: TravelMode,
  apiKey: string,
  departureTime?: Date,
): Promise<RouteResult | null> {
  try {
    const body: Record<string, unknown> = {
      origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
      destination: { location: { latLng: { latitude: dest.latitude, longitude: dest.longitude } } },
      travelMode: ROUTES_TRAVEL_MODE[mode],
    };
    // Only TRANSIT and DRIVE are time-dependent (schedules / traffic). Google
    // rejects a departureTime in the past, so callers only ever pass a future
    // instant; walk/bike ignore time entirely. DRIVE additionally needs an
    // explicit routing preference to actually use live/predicted traffic.
    if (departureTime && (mode === 'transit' || mode === 'drive')) {
      body.departureTime = departureTime.toISOString();
      if (mode === 'drive') body.routingPreference = 'TRAFFIC_AWARE';
    }
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    if (!route) return null;
    const secs =
      typeof route.duration === 'string'
        ? parseInt(route.duration.replace(/s$/, ''), 10)
        : Number(route.duration);
    if (!Number.isFinite(secs)) return null;
    const steps = parseSteps(route);
    const polyline =
      typeof route?.polyline?.encodedPolyline === 'string'
        ? route.polyline.encodedPolyline
        : undefined;
    return {
      minutes: Math.max(1, Math.round(secs / 60)),
      distanceMeters: typeof route.distanceMeters === 'number' ? route.distanceMeters : undefined,
      steps: steps.length > 1 ? steps : undefined,
      polyline,
    };
  } catch {
    return null;
  }
}

export function parseHHMM(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

export function fmtHHMM(totalMin: number): string {
  const wrapped = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface RouteTiming {
  /** IANA zone of the day (e.g. "Europe/Prague"), from the client device. */
  timezone?: string;
  /** "Now" per the client, so a stale departure in the past is dropped. */
  now?: Date;
}

/**
 * Minutes that `tz`'s wall clock is AHEAD of UTC at instant `at` (local = utc +
 * offset). Derived from `Intl` so DST is handled without a tz database.
 */
function tzOffsetMinutes(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) if (p.type !== 'literal') m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return (asUTC - at.getTime()) / 60000;
}

/**
 * Resolves a wall-clock `YYYY-MM-DD` + minutes-of-day in zone `tz` to the true
 * UTC instant. One offset correction is enough except inside the ~1h DST jump,
 * which never matters for picking a transit departure. Returns null on bad
 * input / unknown zone so the caller simply omits the departure time.
 */
function zonedToUtc(dateStr: string, totalMin: number, tz: string): Date | null {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const h = Math.floor(totalMin / 60);
  const mi = ((Math.round(totalMin) % 60) + 60) % 60;
  try {
    const guessMs = Date.UTC(+m[1], +m[2] - 1, +m[3], h, mi, 0);
    if (!Number.isFinite(guessMs)) return null;
    const off = tzOffsetMinutes(new Date(guessMs), tz);
    return new Date(guessMs - off * 60000);
  } catch {
    return null; // invalid IANA zone, etc.
  }
}

/** `YYYY-MM-DD` advanced by `n` whole days (UTC math; safe across months). */
function addDaysISO(dateStr: string, n: number): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  dt.setUTCDate(dt.getUTCDate() + n);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * The future UTC instant a hop departs, for time-aware transit/traffic routing.
 *
 * Google rejects departure times in the past, which would otherwise make this
 * inert for the most common case: editing TODAY's plan in the afternoon, where
 * the morning legs have already elapsed. So when the planned instant is in the
 * past we roll it forward in whole WEEKS — same weekday, same time-of-day — so
 * transit is still priced against the service pattern the user actually planned
 * for (a Sunday plan stays priced on a Sunday) instead of collapsing to "now".
 *
 * Returns undefined (routing falls back to "now") only when we genuinely can't
 * resolve a departure: missing zone/date, bad input, or no future instant found.
 */
function buildDeparture(
  dateStr: string | undefined,
  depMin: number | null | undefined,
  timing: RouteTiming,
): Date | undefined {
  if (depMin == null || depMin < 0 || !timing.timezone || typeof dateStr !== 'string') {
    return undefined;
  }
  const now = timing.now instanceof Date ? timing.now.getTime() : Date.now();
  // Small buffer: a departure within a minute of "now" is effectively now.
  const floor = now + 60_000;
  let date = dateStr;
  let d = zonedToUtc(date, depMin, timing.timezone);
  if (!d) return undefined;
  // Advance by 7-day steps (cap ~6 weeks) until the planned time-of-day lands in
  // the future; recomputed via zonedToUtc each step so the wall clock stays exact
  // across any DST transition in between.
  for (let i = 0; i < 6 && d.getTime() <= floor; i += 1) {
    date = addDaysISO(date, 7);
    const next = zonedToUtc(date, depMin, timing.timezone);
    if (!next) return undefined;
    d = next;
  }
  if (d.getTime() <= floor) return undefined;
  return d;
}

function itemDuration(item: any): number {
  const d = Number(item?.durationMinutes);
  if (Number.isFinite(d) && d > 0) return Math.round(d);
  const s = parseHHMM(item?.startTime);
  const e = parseHHMM(item?.endTime);
  if (s != null && e != null && e > s) return e - s;
  return 30;
}

export function flattenItems(parsed: any): any[] {
  if (!parsed || !Array.isArray(parsed.sections)) return [];
  return parsed.sections.flatMap((s: any) => (s && Array.isArray(s.items) ? s.items : []));
}

/**
 * Safety net: the model is told never to emit "travel" items (the app draws
 * all travel as connectors), but it sometimes still does. Drop any travel
 * items (and now-empty sections) so the journey is rendered as the routed,
 * step-by-step leg between the real places instead.
 */
function stripAiTravelItems(parsed: any): void {
  if (!parsed || !Array.isArray(parsed.sections)) return;
  for (const s of parsed.sections) {
    if (s && Array.isArray(s.items)) {
      s.items = s.items.filter((it: any) => it?.kind !== 'travel');
    }
  }
  parsed.sections = parsed.sections.filter(
    (s: any) => s && Array.isArray(s.items) && s.items.length > 0,
  );
}

/** Routes one hop, attaching the transit step breakdown, with a fallback. */
async function computeLeg(
  origin: Coords,
  dest: Coords,
  apiKey: string,
  fromLabel?: string,
  departureTime?: Date,
): Promise<any> {
  const straight = haversineMeters(origin, dest);
  const distanceM = Math.round(straight * DETOUR_FACTOR);
  const mode = pickMode(distanceM);
  const routed = await computeRoute(origin, dest, mode, apiKey, departureTime);
  const leg: any = routed
    ? {
        mode,
        minutes: routed.minutes,
        distanceMeters: routed.distanceMeters ?? distanceM,
        steps: routed.steps,
        polyline: routed.polyline,
        estimated: false,
      }
    : {
        mode,
        minutes: estimateMinutes(distanceM, mode),
        distanceMeters: distanceM,
        estimated: true,
      };
  if (fromLabel) leg.fromLabel = fromLabel;
  return leg;
}

/**
 * Attaches a real travel leg (with transit steps) to every located stop —
 * from the previous stop, or from HOME for the first one so the day can
 * never "teleport" into another city. Adds a routed trip back home when the
 * day ends away from it. Then cascades the clock around fixed anchors.
 *
 * `stripTravel` strips stray AI-emitted "travel" cards (only wanted on a fresh
 * plan); on a recompute the structure is already clean and the synthetic
 * "Back home" block must not be duplicated, so the caller can skip the append.
 */
export async function routeAndSchedule(
  parsed: any,
  context: Context,
  apiKey: string | undefined,
  opts: { stripTravel?: boolean; appendBackHome?: boolean } = {},
  timing: RouteTiming = {},
): Promise<void> {
  if (!parsed || !Array.isArray(parsed.sections)) return;

  const stripTravel = opts.stripTravel !== false;
  const appendBackHome = opts.appendBackHome !== false;

  // Drop any stray AI-emitted "travel" cards; we draw travel ourselves.
  if (stripTravel) stripAiTravelItems(parsed);

  // 1) Travel legs (needs a Google key to route with). Each hop's endpoints
  //    are already known (from the place coords), so the hops don't depend on
  //    each other — we route them ALL IN PARALLEL.
  if (apiKey) {
    const homeCoords: Coords | null = context.home
      ? { latitude: context.home.latitude, longitude: context.home.longitude }
      : null;

    type RouteNode = { item: any; coords: Coords; isHome: boolean };
    const seq: RouteNode[] = [];
    for (const item of flattenItems(parsed)) {
      const placeCoords: Coords | undefined = item?.place?.coords;
      if (placeCoords) seq.push({ item, coords: placeCoords, isHome: false });
      else if (homeCoords && item?.locationStrategy === 'at_home')
        seq.push({ item, coords: homeCoords, isHome: true });
    }

    const hops: {
      item: any;
      origin: Coords;
      dest: Coords;
      fromLabel?: string;
      /** Provisional minutes-of-day this hop departs, for time-aware routing. */
      departureMin?: number | null;
    }[] = [];

    let prev: RouteNode | null = homeCoords
      ? { item: null, coords: homeCoords, isHome: true }
      : null;
    for (const node of seq) {
      if (prev && haversineMeters(prev.coords, node.coords) > 25) {
        // The client already cascaded provisional start times onto the day, so
        // "depart the previous stop" ≈ this block's start minus its current
        // leg. Good enough to pick the right transit run; the final cascade
        // below re-times everything against the freshly routed minutes.
        const startMin = parseHHMM(node.item?.startTime);
        const legMin = Number(node.item?.travelFromPrev?.minutes);
        const departureMin =
          startMin != null ? startMin - (Number.isFinite(legMin) ? legMin : 0) : null;
        hops.push({
          item: node.item,
          origin: prev.coords,
          dest: node.coords,
          fromLabel: prev.isHome ? context.home?.label : undefined,
          departureMin,
        });
      } else {
        // Same spot as the previous anchor: no travel between them.
        if (node.item) node.item.travelFromPrev = null;
      }
      prev = node;
    }

    let backHomeItem: any = null;
    if (
      appendBackHome &&
      homeCoords &&
      prev &&
      !prev.isHome &&
      haversineMeters(prev.coords, homeCoords) > 400
    ) {
      backHomeItem = {
        title: 'Back home',
        kind: 'travel',
        flexibility: 'flexible',
        durationMinutes: 0,
        place: null,
        arrival: true,
        travelFromPrev: null,
      };
      // The trip home departs when the last real stop ends.
      const lastEnd =
        parseHHMM(prev.item?.endTime) ??
        (parseHHMM(prev.item?.startTime) != null
          ? (parseHHMM(prev.item?.startTime) as number) + itemDuration(prev.item)
          : null);
      hops.push({
        item: backHomeItem,
        origin: prev.coords,
        dest: homeCoords,
        departureMin: lastEnd,
      });
    }

    const routeDebug = !!Deno?.env?.get?.('ROUTE_DEBUG');
    await Promise.all(
      hops.map(async (h) => {
        const departureTime = buildDeparture(parsed?.date, h.departureMin, timing);
        const leg = await computeLeg(h.origin, h.dest, apiKey, h.fromLabel, departureTime);
        h.item.travelFromPrev = leg;
        // Ground-truth trace of the time-aware decision (enable with ROUTE_DEBUG=1
        // and read via `supabase functions logs recompute-itinerary`). Shows the
        // exact departure sent to Google — or that it fell back to "now" — so a
        // "the commute didn't reflect my planned time" report is one log away.
        if (routeDebug) {
          const planned =
            h.departureMin != null && h.departureMin >= 0 ? fmtHHMM(h.departureMin) : '--:--';
          console.log(
            `[route] -> ${h.item?.title ?? 'Back home'}: planned ${planned} | depart ` +
              `${departureTime ? departureTime.toISOString() : 'NOW (past/unresolved → fallback)'}` +
              ` => ${leg?.mode ?? '?'} ${Math.round(leg?.minutes ?? 0)}m` +
              `${leg?.estimated ? ' (estimated)' : ''}`,
          );
        }
      }),
    );

    if (backHomeItem) {
      // Insert "Head Home" immediately AFTER the section containing the
      // last located stop, NOT at the end of the day. A day like
      //   [Pharmacy 18:47] → [Dinner / Relax / Sleep at home (ends 06:30+)]
      // would otherwise schedule the homeward trip after Sleep ends, so the
      // user appears to teleport home and then leave for home at 07:11 the
      // NEXT morning. Splicing the section in the right place lets the
      // cascade time it as "after Pharmacy → arrive home → dinner".
      const lastStop = prev?.item ?? null;
      let insertAt = parsed.sections.length;
      if (lastStop) {
        for (let i = 0; i < parsed.sections.length; i++) {
          const sec = parsed.sections[i];
          if (Array.isArray(sec?.items) && sec.items.includes(lastStop)) {
            insertAt = i + 1;
            break;
          }
        }
      }
      parsed.sections.splice(insertAt, 0, {
        title: 'Head Home',
        period: 'Evening',
        items: [backHomeItem],
      });
    }
  }

  // 2) Cascade the clock (re-flatten so any appended return item is timed).
  const items = flattenItems(parsed);
  if (items.length === 0) return;

  // Pre-walk backwards to find, for each index, the earliest upcoming
  // fixed/window anchor STRICTLY AFTER it. Flexible items use this as
  // their ceiling: if running at full duration would push the next fixed
  // anchor later, shrink the flexible block to fit instead. Keeps things
  // like Skincare-22:00 / Sleep-22:30 honoured even when a 110-min Relax
  // block sits in front of them.
  const nextAnchor: (number | null)[] = new Array(items.length).fill(null);
  let upcoming: number | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    nextAnchor[i] = upcoming;
    const it = items[i];
    if (it?.flexibility === 'fixed') {
      const t = parseHHMM(it.startTime);
      if (t != null && (upcoming == null || t < upcoming)) upcoming = t;
    } else if (it?.flexibility === 'window') {
      const t = parseHHMM(it.windowStart);
      if (t != null && (upcoming == null || t < upcoming)) upcoming = t;
    }
  }

  let cursor = parseHHMM(items[0]?.startTime);
  if (cursor == null) cursor = 8 * 60;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const legMin = Number(item?.travelFromPrev?.minutes);
    if (Number.isFinite(legMin) && legMin > 0) cursor += legMin;
    let start = cursor;
    if (item?.flexibility === 'fixed') {
      const fixed = parseHHMM(item.startTime);
      if (fixed != null && fixed >= start) start = fixed;
    } else if (item?.flexibility === 'window') {
      const ws = parseHHMM(item.windowStart);
      if (ws != null && ws > start) start = ws;
    }
    const isArrival = item?.arrival === true;
    let dur = isArrival ? 0 : itemDuration(item);
    // Shrink flexible/window items so a later fixed anchor doesn't drift.
    // Skipped when there's no room (the fixed item ahead of us would have
    // to be pushed regardless) or no upcoming anchor.
    if (
      !isArrival &&
      (item?.flexibility === 'flexible' || item?.flexibility === 'window') &&
      nextAnchor[i] != null
    ) {
      const room = (nextAnchor[i] as number) - start;
      if (room > 0 && room < dur) dur = room;
    }
    item.startTime = fmtHHMM(start);
    if (dur > 0) {
      item.endTime = fmtHHMM(start + dur);
      item.durationMinutes = dur;
    } else {
      item.endTime = null;
      item.durationMinutes = null;
    }
    cursor = start + dur;
  }
}
