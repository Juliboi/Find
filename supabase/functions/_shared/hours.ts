// Shared opening-hours math for the edge functions (Deno runtime).
//
// Decides whether a planned visit (a date + a [start, end] time window) falls
// inside a venue's weekly opening hours. The client mirrors this logic in
// `src/lib/itinerary/hours.ts` so the card can re-check against the LIVE
// schedule after edits — keep the two in sync.
//
// deno-lint-ignore-file no-explicit-any

export interface VenueOpenPeriod {
  open: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
}

export interface VenueOpeningHours {
  periods: VenueOpenPeriod[];
  weekdayDescriptions?: string[];
}

export type HoursStatus = 'open' | 'closed' | 'closingSoon' | 'unknown';

export interface VisitFit {
  status: HoursStatus;
  /** True only when the WHOLE [start, end] window sits inside open hours. */
  fits: boolean;
  /** "HH:MM" 24h close time of the interval the visit starts in, when known. */
  closeHHMM?: string;
}

const WEEK_MIN = 7 * 24 * 60;

function hhmmToMin(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':');
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function minToHHMM(min: number): string {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 0 = Sunday … 6 = Saturday for a "YYYY-MM-DD" date (UTC to avoid TZ drift). */
export function weekdayOf(dateISO?: string | null): number | null {
  if (!dateISO) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateISO).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

/** Minutes-from-start-of-week interval; `close` may exceed WEEK_MIN on wrap. */
interface Interval {
  open: number;
  close: number;
}

function periodToInterval(p: VenueOpenPeriod): Interval | null {
  const o = p?.open;
  if (!o || !Number.isFinite(Number(o.day))) return null;
  const openAbs = o.day * 1440 + (o.hour || 0) * 60 + (o.minute || 0);
  // No close = Google's "open 24 hours" marker → treat the whole week as open.
  if (!p.close) return { open: 0, close: WEEK_MIN };
  const c = p.close;
  let closeAbs = c.day * 1440 + (c.hour || 0) * 60 + (c.minute || 0);
  if (closeAbs <= openAbs) closeAbs += WEEK_MIN; // trades past midnight / week edge
  return { open: openAbs, close: closeAbs };
}

function isAlwaysOpen(hours: VenueOpeningHours): boolean {
  return hours.periods.some(
    (p) =>
      p?.open &&
      p.open.day === 0 &&
      (p.open.hour || 0) === 0 &&
      (p.open.minute || 0) === 0 &&
      !p.close,
  );
}

/**
 * Does the visit fit inside open hours?
 *   - 'open'        : whole [start, end] sits inside one open interval.
 *   - 'closingSoon' : open at arrival but closes before the visit ends.
 *   - 'closed'      : not open at the arrival time at all.
 *   - 'unknown'     : no usable hours / time data (never flag these).
 * `endHHMM` is optional — without it we only require the venue to be open at
 * arrival (used when an item has no known duration).
 */
export function visitFitsHours(
  hours: VenueOpeningHours | null | undefined,
  dateISO: string | null | undefined,
  startHHMM: string | null | undefined,
  endHHMM?: string | null,
): VisitFit {
  if (!hours || !Array.isArray(hours.periods) || hours.periods.length === 0) {
    return { status: 'unknown', fits: false };
  }
  if (isAlwaysOpen(hours)) return { status: 'open', fits: true };

  const wd = weekdayOf(dateISO);
  const startMin = hhmmToMin(startHHMM);
  if (wd == null || startMin == null) return { status: 'unknown', fits: false };

  const s = wd * 1440 + startMin;
  let e = s;
  const endMin = hhmmToMin(endHHMM ?? null);
  if (endMin != null) {
    e = wd * 1440 + (endMin <= startMin ? endMin + 1440 : endMin); // wraps past midnight
  }

  const intervals: Interval[] = [];
  for (const p of hours.periods) {
    const iv = periodToInterval(p);
    if (iv) intervals.push(iv);
  }
  if (intervals.length === 0) return { status: 'unknown', fits: false };

  // The week is cyclic, so test the visit at its natural position AND one week
  // later — that catches a visit in the small hours covered by an interval that
  // opened late the previous day and wrapped past the week boundary.
  let openAtStart = false;
  let fitsWhole = false;
  let relevantClose: number | null = null;
  for (const off of [0, WEEK_MIN]) {
    const ss = s + off;
    const ee = e + off;
    for (const iv of intervals) {
      if (iv.open <= ss && ss < iv.close) {
        openAtStart = true;
        if (relevantClose == null || iv.close > relevantClose) relevantClose = iv.close;
        if (ee <= iv.close) fitsWhole = true;
      }
    }
    if (fitsWhole) break;
  }

  const closeHHMM = relevantClose != null ? minToHHMM(relevantClose) : undefined;
  if (!openAtStart) return { status: 'closed', fits: false };
  if (fitsWhole) return { status: 'open', fits: true, closeHHMM };
  return { status: 'closingSoon', fits: false, closeHHMM };
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

/**
 * Maps a Google Places (New) place object's opening-hours fields to our shape.
 * Prefers the stable weekly `regularOpeningHours` (works for any future date),
 * falling back to `currentOpeningHours` (this week, holiday-adjusted). Returns
 * null when no periods are available, so the caller treats hours as unknown.
 */
export function extractOpeningHours(googlePlace: any): VenueOpeningHours | null {
  const regular = googlePlace?.regularOpeningHours;
  const current = googlePlace?.currentOpeningHours;
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

/** "18:00" → "6:00 PM" for human-facing open-status strings. */
export function format12h(hhmm?: string | null): string {
  const min = hhmmToMin(hhmm);
  if (min == null) return '';
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * For a venue CLOSED at the visit time, the next moment it opens, formatted
 * like Google Maps — "Opens 8:00 AM" when later the same day, "Opens 8:00 AM
 * Thu" on a following day. Null when no opening lies ahead in the week.
 */
export function nextOpenLabel(
  hours: VenueOpeningHours | null | undefined,
  dateISO: string | null | undefined,
  startHHMM: string | null | undefined,
): string | null {
  if (!hours || !Array.isArray(hours.periods) || hours.periods.length === 0) return null;
  const wd = weekdayOf(dateISO);
  const startMin = hhmmToMin(startHHMM);
  if (wd == null || startMin == null) return null;
  const s = wd * 1440 + startMin;

  const opens: number[] = [];
  for (const p of hours.periods) {
    const iv = periodToInterval(p);
    if (iv) opens.push(iv.open);
  }
  if (opens.length === 0) return null;

  let best: number | null = null;
  for (const off of [0, WEEK_MIN]) {
    for (const o of opens) {
      const oo = o + off;
      if (oo > s && (best == null || oo < best)) best = oo;
    }
  }
  if (best == null) return null;

  const dow = Math.floor((best % WEEK_MIN) / 1440);
  const time = format12h(minToHHMM(best % 1440));
  return dow === wd ? `Opens ${time}` : `Opens ${time} ${DAY_SHORT[dow]}`;
}

/**
 * Builds the short "open status" string we store on a place for display
 * fallbacks, computed against the scheduled visit window. Mirrors the client's
 * `getOpeningHoursStatus` copy (24-hour venues, "Closing soon", next-open).
 */
export function openStatusForVisit(
  hours: VenueOpeningHours | null | undefined,
  dateISO: string | null | undefined,
  startHHMM: string | null | undefined,
  endHHMM?: string | null,
): string | null {
  const fit = visitFitsHours(hours, dateISO, startHHMM, endHHMM);
  const close = fit.closeHHMM ? format12h(fit.closeHHMM) : '';
  // An "open" fit with no close time means open 24 hours.
  if (fit.status === 'open') return close ? `Open · Closes ${close}` : 'Open 24 hours';
  if (fit.status === 'closingSoon') return close ? `Closing soon · ${close}` : 'Closing soon';
  if (fit.status === 'closed') {
    const reopen = nextOpenLabel(hours, dateISO, startHHMM);
    return reopen ? `Closed · ${reopen}` : 'Closed at this time';
  }
  return null;
}
