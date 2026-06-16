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
  currentLocation?: { latitude: number; longitude: number; label?: string };
  /**
   * Whether the user can be routed by car today: `owns` a car AND `useToday`
   * (the per-day switch). When present and not drivable, an explicit "drive"
   * leg is downgraded to the distance auto-pick. Omitted ⇒ mode untouched.
   */
  car?: { owns: boolean; useToday: boolean };
  /**
   * "HH:MM" the day is planned to BEGIN. Seeds the clock cascade when the first
   * block has no time of its own (a fresh compose's morning block), so the day
   * opens at the user's chosen hour instead of the 08:00 fallback.
   */
  dayStart?: string;
  /**
   * "HH:MM" the user sleeps — the day's HARD end (onboarding's "Sleep — the hard
   * end of your day"). When the plan finishes early, the closing "Sleep" block
   * is pushed to here so the evening before it reads as elastic wind-down/free
   * time instead of an hours-early bedtime. Only ever pushes Sleep LATER.
   */
  bedTime?: string;
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

// Idle this long (or longer) before a fixed/window anchor becomes a visible
// free-time block instead of an invisible hole. Matches the client's
// GAP_MIN_MINUTES (app/itinerary.tsx) so server + client agree on what counts
// as a real gap worth surfacing.
const GAP_FILL_MIN_MINUTES = 20;
// Id prefix for gaps the SERVER synthesizes. Lets every recompute strip its own
// previous idle-fillers and rebuild them against the new clock (idempotent),
// without ever touching user-made or AI-made gaps (which carry other ids).
const SYNTH_GAP_PREFIX = 'srv-gap-';

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
  /** Google's REAL scheduled board time, "HH:MM" in the day's tz (transit only). */
  departAt?: string;
  /** Google's REAL scheduled alight time, "HH:MM" in the day's tz (transit only). */
  arriveAt?: string;
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

/** DIAGNOSTIC: compact one-line summary of a route's transit spine (duration,
 *  final arrival, and each vehicle with real board/alight times) — used to log
 *  every alternative Google returns so we can see if routes[0] is suboptimal. */
function summarizeRouteTransit(route: any, tz?: string): string {
  const s = parseInt(String(route?.duration ?? '').replace(/s$/, ''), 10);
  const m = Number.isFinite(s) ? Math.max(1, Math.round(s / 60)) : 0;
  const legsArr = Array.isArray(route?.legs) ? route.legs : [];
  const lines: string[] = [];
  let lastArr: string | undefined;
  for (const lg of legsArr) {
    for (const st of Array.isArray(lg?.steps) ? lg.steps : []) {
      if (st?.travelMode === 'TRANSIT' && st?.transitDetails) {
        const td = st.transitDetails;
        const ln = td?.transitLine?.nameShort || td?.transitLine?.name || '?';
        const dep = td?.stopDetails?.departureTime;
        const arr = td?.stopDetails?.arrivalTime;
        if (arr) lastArr = arr;
        lines.push(
          `${ln} ${fmtClock(dep, tz)}→${fmtClock(arr, tz)} ` +
            `(${td?.stopDetails?.departureStop?.name ?? '?'}→${td?.stopDetails?.arrivalStop?.name ?? '?'})`,
        );
      }
    }
  }
  return `${m}m | arrive ${fmtClock(lastArr, tz)} | ${lines.join('  ·  ') || '(no transit)'}`;
}

/** Pulls a readable walk -> bus -> metro -> train breakdown out of a route.
 *  When `tz` is given, transit steps carry Google's REAL scheduled board/alight
 *  times (HH:MM) so the UI can show the true "152 at 12:40" instead of a clock
 *  it reconstructs by stacking durations. */
function parseSteps(route: any, tz?: string): TravelStep[] {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const out: TravelStep[] = [];
  // Google splits one continuous walk into many turn-by-turn sub-steps. Sum them
  // in raw SECONDS and round ONCE on flush — rounding each tiny piece and
  // dropping the <2min ones (as we used to) badly under-counted: a real 10-min
  // walk to the stop showed as 7. Summing seconds matches Google's "About 10 min".
  let walkSecs = 0;
  const flushWalk = () => {
    const min = Math.round(walkSecs / 60);
    if (min >= 1) out.push({ mode: 'walk', durationMinutes: min });
    walkSecs = 0;
  };
  for (const leg of legs) {
    const steps = Array.isArray(leg?.steps) ? leg.steps : [];
    for (const st of steps) {
      if (st?.travelMode === 'TRANSIT' && st?.transitDetails) {
        flushWalk();
        const td = st.transitDetails;
        const line: string | undefined =
          td?.transitLine?.nameShort || td?.transitLine?.name || undefined;
        // Real scheduled times only when we can localise them; otherwise leave
        // unset so the UI falls back to duration-cascade rather than show a
        // server-tz (UTC) clock.
        const departAt = tz ? fmtClock(td?.stopDetails?.departureTime, tz) : undefined;
        const arriveAt = tz ? fmtClock(td?.stopDetails?.arrivalTime, tz) : undefined;
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
          departAt: departAt && departAt !== '--:--' ? departAt : undefined,
          arriveAt: arriveAt && arriveAt !== '--:--' ? arriveAt : undefined,
          numStops: typeof td?.stopCount === 'number' ? td.stopCount : undefined,
          fromCoords: latLngOf(td?.stopDetails?.departureStop?.location),
          toCoords: latLngOf(td?.stopDetails?.arrivalStop?.location),
        });
      } else if (st?.travelMode === 'WALK') {
        const s =
          typeof st?.staticDuration === 'string'
            ? parseInt(st.staticDuration.replace(/s$/, ''), 10)
            : Number(st?.staticDuration);
        if (Number.isFinite(s) && s > 0) walkSecs += s;
      }
    }
  }
  flushWalk();
  return out;
}

/** Raw seconds from a Routes API "123s" duration string (or number). */
function rawSecondsOf(v: unknown): number {
  const s = typeof v === 'string' ? parseInt(v.replace(/s$/, ''), 10) : Number(v);
  return Number.isFinite(s) ? s : 0;
}

/**
 * Real wall-clock arrival at the destination for one returned route: the last
 * transit alight + any trailing walk to the door. This is the right basis for
 * "which alternative is best" — NOT route.duration, which excludes the initial
 * wait at the origin (an alt that leaves 30 min later can show a smaller
 * duration yet arrive much later). Pure-walk routes use departure + total walk.
 * Returns null when arrival can't be determined (caller keeps routes[0]).
 */
function routeArrivalMs(route: any, departureTime?: Date): number | null {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  let lastTransitArrMs: number | null = null;
  let trailingWalkSecs = 0;
  let totalWalkSecs = 0;
  for (const lg of legs) {
    for (const st of Array.isArray(lg?.steps) ? lg.steps : []) {
      if (st?.travelMode === 'TRANSIT' && st?.transitDetails) {
        const ms = Date.parse(st.transitDetails?.stopDetails?.arrivalTime ?? '');
        if (Number.isFinite(ms)) {
          lastTransitArrMs = ms;
          trailingWalkSecs = 0; // walks after this hop count toward arrival
        }
      } else if (st?.travelMode === 'WALK') {
        const s = rawSecondsOf(st?.staticDuration);
        trailingWalkSecs += s;
        totalWalkSecs += s;
      }
    }
  }
  if (lastTransitArrMs != null) return lastTransitArrMs + trailingWalkSecs * 1000;
  if (departureTime) return departureTime.getTime() + totalWalkSecs * 1000;
  return null;
}

/**
 * Real wall-clock LEAVE time for one returned route: the first transit board
 * MINUS the walk that precedes it (door → first stop). The mirror of
 * routeArrivalMs, used for arrive-by (arrivalTime) transit routing so we can
 * reserve the TRUE span from leaving the origin to the appointment — and so the
 * cascade's departure lines up with the trip Google actually picked. Returns
 * null for walk-only routes (no board to anchor to).
 */
function routeDepartureMs(route: any): number | null {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  let leadingWalkSecs = 0;
  for (const lg of legs) {
    for (const st of Array.isArray(lg?.steps) ? lg.steps : []) {
      if (st?.travelMode === 'TRANSIT' && st?.transitDetails) {
        const ms = Date.parse(st.transitDetails?.stopDetails?.departureTime ?? '');
        if (Number.isFinite(ms)) return ms - leadingWalkSecs * 1000;
      } else if (st?.travelMode === 'WALK') {
        leadingWalkSecs += rawSecondsOf(st?.staticDuration);
      }
    }
  }
  return null;
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
  tz?: string,
  dbg?: { label: string; planned: string; tz?: string; sink?: string[] },
  arrivalTime?: Date,
): Promise<RouteResult | null> {
  try {
    const body: Record<string, unknown> = {
      origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
      destination: { location: { latLng: { latitude: dest.latitude, longitude: dest.longitude } } },
      travelMode: ROUTES_TRAVEL_MODE[mode],
    };
    // For a leg that must land at a FIXED appointment, route TRANSIT by arrival:
    // Google then returns trips that arrive BY the pin (picking an earlier
    // vehicle if needed) instead of "leave at X, arrive whenever" — which is
    // what made the user 3 min late to a 14:00 booking. Only TRANSIT supports
    // arrivalTime; it's mutually exclusive with departureTime.
    const useArriveBy = !!arrivalTime && mode === 'transit';
    if (useArriveBy) {
      body.arrivalTime = arrivalTime!.toISOString();
    } else if (departureTime && (mode === 'transit' || mode === 'drive')) {
      // Only TRANSIT and DRIVE are time-dependent (schedules / traffic). Google
      // rejects a departureTime in the past, so callers only ever pass a future
      // instant; walk/bike ignore time entirely. DRIVE additionally needs an
      // explicit routing preference to actually use live/predicted traffic.
      body.departureTime = departureTime.toISOString();
      if (mode === 'drive') body.routingPreference = 'TRAFFIC_AWARE';
    }
    // For transit, ask Google for every alternative and pick the earliest-arriving
    // one ourselves (below). Without this, computeRoutes returns a SINGLE default
    // route that isn't always the soonest — that's why "Back home" kept choosing
    // 152/Ládví (arrive 18:25) over 145/Kobylisy (arrive 18:20, what Maps shows).
    if (mode === 'transit') body.computeAlternativeRoutes = true;
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
    const routes = Array.isArray(data?.routes) ? data.routes : [];
    if (routes.length === 0) return null;
    // Pick the route that ARRIVES soonest (matches how Maps ranks), not just
    // routes[0]. Google's default single route isn't always the earliest. For an
    // arrive-by query, prefer the trip arriving as LATE as possible without
    // passing the deadline (least dead time at the venue), falling back to the
    // earliest-arriving option.
    let route = routes[0];
    if (routes.length > 1) {
      if (useArriveBy) {
        const targetMs = arrivalTime!.getTime();
        let bestLate: number | null = null;
        let bestAny: number | null = null;
        let pickLate: any = null;
        let pickAny: any = route;
        for (let i = 0; i < routes.length; i++) {
          const ms = routeArrivalMs(routes[i]);
          if (ms == null) continue;
          if (bestAny == null || ms < bestAny) {
            bestAny = ms;
            pickAny = routes[i];
          }
          if (ms <= targetMs && (bestLate == null || ms > bestLate)) {
            bestLate = ms;
            pickLate = routes[i];
          }
        }
        route = pickLate ?? pickAny;
      } else {
        let bestMs = routeArrivalMs(route, departureTime);
        for (let i = 1; i < routes.length; i++) {
          const ms = routeArrivalMs(routes[i], departureTime);
          if (ms != null && (bestMs == null || ms < bestMs)) {
            bestMs = ms;
            route = routes[i];
          }
        }
      }
    }
    const secs =
      typeof route.duration === 'string'
        ? parseInt(route.duration.replace(/s$/, ''), 10)
        : Number(route.duration);
    if (!Number.isFinite(secs)) return null;
    const steps = parseSteps(route, tz);
    const polyline =
      typeof route?.polyline?.encodedPolyline === 'string'
        ? route.polyline.encodedPolyline
        : undefined;
    const googleMin = Math.max(1, Math.round(secs / 60));
    // Google's transit `duration` is measured from the OPTIMAL departure — it
    // assumes you leave just in time to board the first vehicle, so it EXCLUDES
    // the slack between the planned leave and that first board. Scheduling the
    // next item as `leaveBy + duration` therefore lands EARLY (the "arrive 18:21
    // but the 145 + final walk really gets you home 18:25" bug). When we know the
    // real arrival (last alight + trailing walk) and the departure we sent, use
    // that TRUE door-to-door span so every following item cascades off the real
    // time you're back, not Google's slack-trimmed figure.
    let minutes = googleMin;
    if (useArriveBy) {
      // Span from leaving the origin to the appointment, so the cascade departs
      // exactly when this trip boards and arrives by the pin (never after).
      const leaveMs = routeDepartureMs(route);
      if (leaveMs != null) {
        const span = Math.round((arrivalTime!.getTime() - leaveMs) / 60000);
        if (span >= 1) minutes = span;
      }
    } else if (mode === 'transit' && departureTime) {
      const arrivalMs = routeArrivalMs(route, departureTime);
      if (arrivalMs != null) {
        const spanMin = Math.round((arrivalMs - departureTime.getTime()) / 60000);
        if (spanMin >= 1) minutes = spanMin;
      }
    }

    // Ground-truth trace: compare the REAL scheduled board/alight times Google
    // returned against the single duration we keep (and the synthetic step times
    // the UI reconstructs). This is what disambiguates "stale/worse route" from
    // "right route, wrong wall-clock".
    if (dbg) {
      const legsArr = Array.isArray(route?.legs) ? route.legs : [];
      const parts: string[] = [];
      let firstDep: string | undefined;
      let lastArr: string | undefined;
      for (const lg of legsArr) {
        for (const st of Array.isArray(lg?.steps) ? lg.steps : []) {
          if (st?.travelMode === 'TRANSIT' && st?.transitDetails) {
            const td = st.transitDetails;
            const line = td?.transitLine?.nameShort || td?.transitLine?.name || '?';
            const dep = td?.stopDetails?.departureTime;
            const arr = td?.stopDetails?.arrivalTime;
            if (!firstDep) firstDep = dep;
            if (arr) lastArr = arr;
            parts.push(
              `${line} ${fmtClock(dep, dbg.tz)}→${fmtClock(arr, dbg.tz)} ` +
                `(${td?.stopDetails?.departureStop?.name ?? '?'}→${td?.stopDetails?.arrivalStop?.name ?? '?'})`,
            );
          } else if (st?.travelMode === 'WALK') {
            const w = secsToMin(st?.staticDuration);
            if (w) parts.push(`walk ${w}m`);
          }
        }
      }
      const o = `${origin.latitude.toFixed(5)},${origin.longitude.toFixed(5)}`;
      const d = `${dest.latitude.toFixed(5)},${dest.longitude.toFixed(5)}`;
      const line =
        `[route] ${dbg.label} | planned ${dbg.planned} | sent ` +
        `${useArriveBy ? 'arrive-by ' + arrivalTime!.toISOString() : departureTime ? departureTime.toISOString() : 'NOW (no time-aware)'} | ` +
        `from ${o} → ${d} | ` +
        `${mode} google=${googleMin}m${minutes !== googleMin ? ` →span ${minutes}m (incl. pre-board slack)` : ''} | ` +
        `real ${fmtClock(firstDep, dbg.tz)}→${fmtClock(lastArr, dbg.tz)} | ` +
        (parts.length ? parts.join('  ·  ') : '(no transit steps)');
      console.log(line);
      dbg.sink?.push(line);

      // Every alternative Google offered, ranked as returned. "(chosen)" now marks
      // the earliest-arriving route we actually selected — which may NOT be alt#0.
      if (routes.length > 1) {
        routes.forEach((rt: any, i: number) => {
          const altLine = `[route]   alt#${i}${rt === route ? ' (chosen)' : ''}: ${summarizeRouteTransit(rt, dbg.tz)}`;
          console.log(altLine);
          dbg.sink?.push(altLine);
        });
      }

      // The FULL, unprocessed Google Routes payload for this leg — the literal
      // "commute response" BEFORE any of our transforms (mode pick, earliest-
      // arrival selection, span-minutes, and the UI's clock rebasing) touch it.
      // This is what disambiguates "Google gave us a bad/odd route" from "Google
      // was right and our display logic shifted the times". Heavy, so it only
      // rides along when ROUTE_DEBUG is on and is dropped client-side after log.
      try {
        const rawLine = `[route-raw] ${dbg.label} (${mode}): ${JSON.stringify(data)}`;
        console.log(rawLine);
        dbg.sink?.push(rawLine);
      } catch {
        // non-serialisable payload — keep the concise trace, skip the raw dump
      }
    }

    return {
      minutes,
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

/** Formats an RFC3339 instant as local HH:MM in `tz` — debug only, used to show
 *  Google's REAL transit board/alight times next to what we schedule. */
function fmtClock(iso: string | undefined, tz?: string): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

export interface RouteTiming {
  /** IANA zone of the day (e.g. "Europe/Prague"), from the client device. */
  timezone?: string;
  /** "Now" per the client, so a stale departure in the past is dropped. */
  now?: Date;
  /** ROUTE_DEBUG sink: when present, each leg's ground-truth `[route]` trace is
   *  pushed here (in addition to console.log) so the caller can echo it back to
   *  the client and read it in Metro instead of the dashboard. */
  debugSink?: string[];
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

/** Smallest length a flexible/window block may be shrunk to when the day is
 *  tight — keeps a token sliver visible instead of collapsing it to nothing. */
const MIN_FLEX_MIN = 5;

/**
 * THE day-scheduling algorithm, shared by the provisional pre-route clock and
 * the final post-route cascade so the two ALWAYS agree on every start time.
 *
 * Why that matters: each transit leg is routed for its PROVISIONAL departure,
 * which bakes Google's real board/alight times into the leg. If the final
 * cascade then lands that stop at a DIFFERENT minute (e.g. because it shrank a
 * flexible block to protect a downstream appointment but the provisional clock
 * didn't), the baked-in board times no longer line up with the card clock and
 * the commute reads "not synced". Running one algorithm for both — differing
 * only in the per-leg minutes (haversine estimate up front, real routed minutes
 * after) — keeps them locked together.
 *
 * Given ordered `items` and `legMinOf(item, idx)` → that item's lead-in travel
 * minutes, it returns each item's chosen { start, dur } in minutes-of-day:
 *   1. propagate every downstream FIXED/WINDOW pin's deadline BACKWARDS,
 *      reserving the travel + intended gap that sit before it, then
 *   2. walk FORWARD snapping pins and shrinking flexible/window blocks (never
 *      below MIN_FLEX_MIN) so those deadlines — and the commutes they protect —
 *      are still met.
 */
function scheduleDay(
  items: any[],
  legMinOf: (item: any, idx: number) => number,
  fallbackStartMin: number | null = null,
): { start: number; dur: number }[] {
  const n = items.length;
  const out: { start: number; dur: number }[] = new Array(n);
  if (n === 0) return out;

  const anchorTimeOf = (it: any): number | null =>
    it?.flexibility === 'fixed'
      ? parseHHMM(it?.startTime)
      : it?.flexibility === 'window'
        ? parseHHMM(it?.windowStart)
        : null;
  const durOf = (it: any): number => (it?.arrival === true ? 0 : itemDuration(it));
  // Travel into items[idx] + any intended free gap before it. Mirrors the
  // forward cursor advance: no lead-in on the first item, no gap on a gap block.
  const leadIn = (idx: number): number => {
    if (idx <= 0 || idx >= n) return 0;
    const it = items[idx];
    const t = legMinOf(it, idx);
    const travel = Number.isFinite(t) && t > 0 ? t : 0;
    const g = Number(it?.gapBeforeMin);
    const gap = it?.kind !== 'gap' && Number.isFinite(g) && g > 0 ? g : 0;
    return travel + gap;
  };

  // 1) Backward: the latest start each item may take without slipping a
  //    downstream pin (reserving the lead-in that precedes that pin).
  const latestStart: (number | null)[] = new Array(n).fill(null);
  let nextLS: number | null = null;
  for (let i = n - 1; i >= 0; i--) {
    const pin = anchorTimeOf(items[i]);
    let ls: number | null;
    if (pin != null) ls = pin;
    else if (nextLS == null) ls = null;
    else ls = nextLS - leadIn(i + 1) - durOf(items[i]);
    latestStart[i] = ls;
    nextLS = ls != null ? ls : nextLS;
  }

  // 2) Forward: place each item, snapping pins and shrinking flexible time.
  // Seed from the first block's own time; if it has none (a fresh compose's
  // morning), open at the day's planned start, and only then the 08:00 default.
  let cursor = parseHHMM(items[0]?.startTime);
  if (cursor == null) cursor = fallbackStartMin != null ? fallbackStartMin : 8 * 60;
  for (let i = 0; i < n; i++) {
    const it = items[i];
    cursor += leadIn(i);
    let start = cursor;
    if (it?.flexibility === 'fixed') {
      const f = parseHHMM(it?.startTime);
      if (f != null && f >= start) start = f;
    } else if (it?.flexibility === 'window') {
      const ws = parseHHMM(it?.windowStart);
      if (ws != null && ws > start) start = ws;
    }
    const isArrival = it?.arrival === true;
    let dur = isArrival ? 0 : itemDuration(it);
    if (
      !isArrival &&
      (it?.flexibility === 'flexible' || it?.flexibility === 'window') &&
      i + 1 < n &&
      latestStart[i + 1] != null
    ) {
      const maxEnd = (latestStart[i + 1] as number) - leadIn(i + 1);
      if (maxEnd - start < dur) dur = Math.max(MIN_FLEX_MIN, maxEnd - start);
    }
    out[i] = { start, dur };
    cursor = start + dur;
  }
  return out;
}

/**
 * A lightweight forward clock used ONLY to pick sane (daytime) transit
 * departure slots BEFORE the real legs are routed. In the v3 compose path the
 * items carry no start times yet at routing time (the real cascade runs
 * afterwards), so without this every transit hop would route with no departure
 * → Google falls back to "now", which at night returns night buses (the "905
 * instead of 145" bug). Delegates to `scheduleDay` with the per-leg HAVERSINE
 * estimates (the real minutes don't exist yet), so the departures it picks
 * match what the final cascade will choose. Returns a map of item →
 * provisional minutes-of-day start.
 */
function provisionalStarts(
  items: any[],
  estLegMinByItem: Map<any, number>,
  fallbackStartMin: number | null = null,
): Map<any, number> {
  const sched = scheduleDay(
    items,
    (item) => {
      const est = estLegMinByItem.get(item);
      return est != null ? est : Number(item?.travelFromPrev?.minutes);
    },
    fallbackStartMin,
  );
  const out = new Map<any, number>();
  for (let i = 0; i < items.length; i++) out.set(items[i], sched[i].start);
  return out;
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

/**
 * Removes the gap blocks a PREVIOUS run synthesized (id prefix `srv-gap-`), so
 * re-routing is idempotent: each pass strips its own old idle-fillers and
 * recomputes fresh ones against the new clock. User-made and AI-made gaps (any
 * other id) are left untouched.
 */
function stripSyntheticGaps(parsed: any): void {
  if (!parsed || !Array.isArray(parsed.sections)) return;
  for (const s of parsed.sections) {
    if (s && Array.isArray(s.items)) {
      s.items = s.items.filter(
        (it: any) =>
          !(
            it?.kind === 'gap' &&
            typeof it?.id === 'string' &&
            it.id.startsWith(SYNTH_GAP_PREFIX)
          ),
      );
    }
  }
  parsed.sections = parsed.sections.filter(
    (s: any) => s && Array.isArray(s.items) && s.items.length > 0,
  );
}

/**
 * Turns unfilled idle before a fixed/window anchor into a real, visible `gap`
 * block, so the day never shows an invisible hole between two stops (the
 * "breakfast ends 09:45, therapy at 11:00, nothing in between" problem). Runs
 * AFTER the clock cascade and only fills the EMPTY space ahead of each anchor —
 * the synthesized block spans [prevEnd, anchorLeaveBy], so it shifts nothing
 * already placed. Idempotent via the `srv-gap-` id prefix (see above).
 */
function fillIdleGaps(parsed: any): void {
  if (!parsed || !Array.isArray(parsed.sections)) return;
  const items = flattenItems(parsed);
  if (items.length === 0) return;

  // Key the insertion on the anchor item itself (flattenItems returns the same
  // object refs that live in the sections), so we can splice gaps back in by
  // identity regardless of section boundaries.
  const insertBefore = new Map<any, any>();
  let counter = 0;
  let prevEnd: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const start = parseHHMM(it?.startTime);
    const isAnchor = it?.flexibility === 'fixed' || it?.flexibility === 'window';
    if (i > 0 && isAnchor && start != null && prevEnd != null) {
      const travel = Number(it?.travelFromPrev?.minutes) || 0;
      const idle = start - travel - prevEnd;
      if (idle >= GAP_FILL_MIN_MINUTES) {
        insertBefore.set(it, {
          id: `${SYNTH_GAP_PREFIX}${counter++}`,
          title: 'Free time',
          kind: 'gap',
          flexibility: 'flexible',
          startTime: fmtHHMM(prevEnd),
          endTime: fmtHHMM(prevEnd + idle),
          durationMinutes: idle,
          gapBeforeMin: 0,
          place: null,
          travelFromPrev: null,
          orderIndex: 0,
        });
      }
    }
    const end =
      parseHHMM(it?.endTime) ?? (start != null ? start + itemDuration(it) : null);
    if (end != null) prevEnd = end;
  }

  if (insertBefore.size === 0) return;
  for (const s of parsed.sections) {
    if (!Array.isArray(s.items)) continue;
    const out: any[] = [];
    for (const it of s.items) {
      const g = insertBefore.get(it);
      if (g) out.push(g);
      out.push(it);
    }
    s.items = out;
  }
}

/**
 * Bedtime guard. The day's HARD end is the user's sleep time (onboarding's
 * "Sleep — the hard end of your day"), NOT the earlier wind-down hour. If the
 * plan ran short and the closing "Sleep" block landed before bedtime, push it
 * to bedtime so the evening before it reads as elastic wind-down / free time —
 * instead of the user "going to sleep at 21:00" when their routine is 23:00.
 *
 * Only ever moves Sleep LATER: a genuinely long day keeps its later bedtime,
 * and we never crush the day to force an early one. Runs AFTER the cascade and
 * BEFORE fillIdleGaps, so the freed evening becomes a visible gap.
 */
function anchorSleepToBedtime(parsed: any, bedMin: number | null): void {
  if (bedMin == null) return;
  const items = flattenItems(parsed);
  if (items.length === 0) return;
  // Only the day's CLOSING block counts — a "sleep" mention mid-day (e.g. a nap)
  // must not be dragged to bedtime.
  const last = items[items.length - 1];
  const title = String(last?.title ?? '').toLowerCase();
  if (!/\bsleep\b|lights out|go to bed|bedtime/.test(title)) return;
  const start = parseHHMM(last?.startTime);
  if (start == null || start >= bedMin) return;

  const dur = itemDuration(last);
  last.startTime = fmtHHMM(bedMin);
  last.endTime = fmtHHMM(bedMin + dur);
  last.durationMinutes = dur;
  // Make it a hard pin so fillIdleGaps treats the evening hole as fill-worthy.
  last.flexibility = 'fixed';

  // If the block right before Sleep is already elastic wind-down/gap time,
  // stretch it to bedtime for ONE clean evening block; otherwise leave the hole
  // for fillIdleGaps to drop a "Free time" gap into.
  const prev = items[items.length - 2];
  if (prev && prev.kind === 'gap') {
    const ps = parseHHMM(prev.startTime);
    if (ps != null && bedMin > ps) {
      prev.endTime = fmtHHMM(bedMin);
      prev.durationMinutes = bedMin - ps;
    }
  }
}

/** Routes one hop, attaching the transit step breakdown, with a fallback. */
async function computeLeg(
  origin: Coords,
  dest: Coords,
  apiKey: string,
  fromLabel?: string,
  departureTime?: Date,
  tz?: string,
  dbg?: { label: string; planned: string; tz?: string; sink?: string[] },
  preferredMode?: TravelMode,
  carAvailable?: boolean,
  arrivalTime?: Date,
): Promise<any> {
  const straight = haversineMeters(origin, dest);
  const distanceM = Math.round(straight * DETOUR_FACTOR);
  // Honour a user-locked mode; otherwise auto-pick by distance. Never route by
  // car when the user has no car / isn't driving today.
  let mode = preferredMode ?? pickMode(distanceM);
  if (mode === 'drive' && carAvailable === false) mode = pickMode(distanceM);
  const routed = await computeRoute(origin, dest, mode, apiKey, departureTime, tz, dbg, arrivalTime);
  if (dbg && !routed) {
    const line =
      `[route] ${dbg.label} | planned ${dbg.planned} | real route UNAVAILABLE → ` +
      `haversine ${estimateMinutes(distanceM, mode)}m (${mode}, est)`;
    console.log(line);
    dbg.sink?.push(line);
  }
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
  // Always drop our own previously-synthesized idle gaps so this pass rebuilds
  // them fresh against the new clock (idempotent across repeated recomputes).
  stripSyntheticGaps(parsed);

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
      /** Haversine estimate for THIS leg — seeds the provisional clock below. */
      estMin: number;
      /** A user-locked transport mode to honour over the distance auto-pick. */
      preferredMode?: TravelMode;
      /** Provisional minutes-of-day this hop departs, for time-aware routing. */
      departureMin?: number | null;
      /**
       * Minutes-of-day this hop must ARRIVE by — set only when the destination is
       * a FIXED appointment, so transit is routed "arrive by the pin" and never
       * lands the user late.
       */
      arrivalMin?: number | null;
    }[] = [];

    // The day's chain starts wherever the user actually begins: the explicit
    // start location they picked in the planner setup drawer if present, else
    // home. Anchoring to `currentLocation` keeps the FIRST commute honest for a
    // day that doesn't begin at home (a hotel, a friend's place, the office).
    const startCoords: Coords | null = context.currentLocation
      ? { latitude: context.currentLocation.latitude, longitude: context.currentLocation.longitude }
      : homeCoords;
    const startLabel = context.currentLocation
      ? context.currentLocation.label
      : context.home?.label;
    const startIsHome = !context.currentLocation && !!homeCoords;
    let prev: RouteNode | null = startCoords
      ? { item: null, coords: startCoords, isHome: startIsHome }
      : null;
    let isFirstHop = true;
    // Estimated minutes per located leg, keyed by the destination item — feeds
    // the provisional clock so every hop gets a daytime departure to query.
    const estLegMinByItem = new Map<any, number>();
    for (const node of seq) {
      if (prev && haversineMeters(prev.coords, node.coords) > 25) {
        const distM = Math.round(haversineMeters(prev.coords, node.coords) * DETOUR_FACTOR);
        const estMin = estimateMinutes(distM, pickMode(distM));
        estLegMinByItem.set(node.item, estMin);
        // Honour a transport mode the user explicitly locked on this leg
        // (LegModeSheet); otherwise the distance auto-pick wins.
        const tp = node.item?.travelFromPrev;
        const preferredMode: TravelMode | undefined =
          tp && tp.modeLocked === true && typeof tp.mode === 'string'
            ? (tp.mode as TravelMode)
            : undefined;
        // A FIXED appointment with a pinned start is an arrive-BY deadline:
        // route transit to land by then (Google picks an earlier vehicle if
        // the next one would be late), instead of departing on a guess.
        const arrivalMin =
          node.item?.flexibility === 'fixed' ? parseHHMM(node.item?.startTime) : null;
        hops.push({
          item: node.item,
          origin: prev.coords,
          dest: node.coords,
          // Label the first hop with the day's start (home or the picked start
          // location); later hops carry no fromLabel (they read the prev stop).
          fromLabel: isFirstHop ? startLabel : undefined,
          estMin,
          preferredMode,
          arrivalMin,
        });
        isFirstHop = false;
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
      const distHome = Math.round(haversineMeters(prev.coords, homeCoords) * DETOUR_FACTOR);
      hops.push({
        item: backHomeItem,
        origin: prev.coords,
        dest: homeCoords,
        estMin: estimateMinutes(distHome, pickMode(distHome)),
      });
    }

    // Run a provisional clock from the estimated leg minutes so every transit
    // hop gets a sane DAYTIME departure to query Google with. Without this, a v3
    // plan (items have no start times until the real cascade below) would route
    // with no departure → Google falls back to "now", which at night returns
    // night buses. The real cascade afterwards still re-times everything against
    // the freshly routed minutes.
    const seedFallback = parseHHMM(context?.dayStart);
    const provStart = provisionalStarts(flattenItems(parsed), estLegMinByItem, seedFallback);
    const lastNode = prev;
    for (const h of hops) {
      if (h.item === backHomeItem) {
        const lastItem = lastNode?.item;
        const ls = lastItem ? provStart.get(lastItem) : undefined;
        h.departureMin = ls != null ? ls + itemDuration(lastItem) : null;
      } else {
        const s = provStart.get(h.item);
        h.departureMin = s != null ? s - h.estMin : null;
      }
    }

    // Whether car routing is allowed today (owns AND using it). Undefined when
    // the caller didn't say — then mode selection is left untouched.
    const carAvailable = context.car
      ? context.car.owns === true && context.car.useToday !== false
      : undefined;

    // Enable with the ROUTE_DEBUG=1 secret and read via the dashboard or
    // `supabase functions logs recompute-itinerary`. Each leg prints the exact
    // departure we sent, the duration Google returned, AND Google's real
    // scheduled board/alight times — so "off by a few minutes" vs "wrong route
    // entirely" is one reproduction away.
    const routeDebug = !!Deno?.env?.get?.('ROUTE_DEBUG');
    await Promise.all(
      hops.map(async (h) => {
        const departureTime = buildDeparture(parsed?.date, h.departureMin, timing);
        // For an arrive-by hop (transit into a fixed appointment) build the pin
        // instant; computeRoute uses it instead of the departure guess.
        const arrivalTime =
          h.arrivalMin != null ? buildDeparture(parsed?.date, h.arrivalMin, timing) : undefined;
        const dbg = routeDebug
          ? {
              label: h.item?.title ?? 'Back home',
              planned:
                arrivalTime && h.arrivalMin != null
                  ? `by ${fmtHHMM(h.arrivalMin)}`
                  : h.departureMin != null && h.departureMin >= 0
                    ? fmtHHMM(h.departureMin)
                    : '--:--',
              tz: timing.timezone,
              sink: timing.debugSink,
            }
          : undefined;
        const leg = await computeLeg(
          h.origin,
          h.dest,
          apiKey,
          h.fromLabel,
          departureTime,
          timing.timezone,
          dbg,
          h.preferredMode,
          carAvailable,
          arrivalTime,
        );
        // Preserve the user's lock so the next recompute keeps honouring it.
        if (h.preferredMode && leg) leg.modeLocked = true;
        h.item.travelFromPrev = leg;
      }),
    );

    if (backHomeItem) {
      // Splice "Back home" in immediately AFTER the last LOCATED stop — i.e.
      // right BEFORE the trailing run of at-home blocks (language practice,
      // wind-down, sleep), not after the whole section. When dinner-out and
      // the evening's at-home blocks share one "Evening" section, inserting
      // after the SECTION put the homeward trip after Sleep, so the at-home
      // blocks rendered as if they happened at the restaurant and the user
      // only "went home" at midnight. Inserting right after the stop lets the
      // cascade read it as "leave the restaurant → arrive home → wind down".
      const lastStop = prev?.item ?? null;
      let placed = false;
      if (lastStop) {
        for (const sec of parsed.sections) {
          if (!Array.isArray(sec?.items)) continue;
          const idx = sec.items.indexOf(lastStop);
          if (idx >= 0) {
            sec.items.splice(idx + 1, 0, backHomeItem);
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        parsed.sections.push({
          title: 'Head Home',
          period: 'Evening',
          items: [backHomeItem],
        });
      }
    }
  }

  // 2) Cascade the clock (re-flatten so any appended return item is timed).
  const items = flattenItems(parsed);
  if (items.length === 0) return;

  // Schedule the day with the SAME algorithm the provisional clock used (now on
  // the REAL routed leg minutes). Because both passes share `scheduleDay`, the
  // start times the cards show line up with the departures the transit legs were
  // routed for — no "commute not synced" drift — while still reserving each
  // commute and shrinking flexible blocks to protect downstream fixed pins.
  const sched = scheduleDay(
    items,
    (item) => Number(item?.travelFromPrev?.minutes),
    parseHHMM(context?.dayStart),
  );
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { start, dur } = sched[i];
    item.startTime = fmtHHMM(start);
    if (dur > 0) {
      item.endTime = fmtHHMM(start + dur);
      item.durationMinutes = dur;
    } else {
      item.endTime = null;
      item.durationMinutes = null;
    }
  }

  // 2b) The day's hard end is bedtime, not the wind-down hour. If the plan ran
  //     short and the closing Sleep block landed early, push it to bedtime so
  //     the evening reads as elastic wind-down/free time instead of an
  //     hours-early "going to sleep at 21:00".
  anchorSleepToBedtime(parsed, parseHHMM(context?.bedTime));

  // 3) Turn any unfilled idle before a fixed/window anchor into a visible
  //    free-time block, so the day never shows an invisible hole between two
  //    stops. Purely additive in the empty space ahead of each anchor — it
  //    shifts nothing already placed.
  fillIdleGaps(parsed);
}
