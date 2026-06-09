/**
 * Client-side opening-hours check for an itinerary stop.
 *
 * Mirrors `supabase/functions/_shared/hours.ts` (the planner's server-side
 * version) so the card can re-evaluate against the LIVE schedule — times reflow
 * on every edit via `cascadeTimes`, so a warning baked once on the server would
 * go stale. Keep the two implementations in sync.
 */

import { ItineraryPlace, VenueOpeningHours, VenueOpenPeriod } from '@/types/itinerary';
import { formatTime } from '@/utils/time';

export type HoursStatus = 'open' | 'closed' | 'closingSoon' | 'unknown';

export interface VenueHoursStatus {
  status: HoursStatus;
  /** True only when the WHOLE visit window fits inside open hours. */
  fits: boolean;
  /** "HH:MM" 24h close time of the interval the visit starts in, when known. */
  closeHHMM?: string;
  /** One-line status for the meta row, e.g. "Open · Closes 6:00 PM". */
  statusLabel?: string;
  /** "Consider changing" copy, set only when the visit doesn't fit. */
  warning?: string;
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
function weekdayOf(dateISO?: string | null): number | null {
  if (!dateISO) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateISO).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

interface Interval {
  open: number;
  close: number;
}

function periodToInterval(p: VenueOpenPeriod): Interval | null {
  const o = p?.open;
  if (!o || !Number.isFinite(Number(o.day))) return null;
  const openAbs = o.day * 1440 + (o.hour || 0) * 60 + (o.minute || 0);
  if (!p.close) return { open: 0, close: WEEK_MIN }; // Google "open 24 hours"
  const c = p.close;
  let closeAbs = c.day * 1440 + (c.hour || 0) * 60 + (c.minute || 0);
  if (closeAbs <= openAbs) closeAbs += WEEK_MIN; // past midnight / week edge
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

interface VisitFit {
  status: HoursStatus;
  fits: boolean;
  closeHHMM?: string;
}

function visitFitsHours(
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
    e = wd * 1440 + (endMin <= startMin ? endMin + 1440 : endMin);
  }

  const intervals: Interval[] = [];
  for (const p of hours.periods) {
    const iv = periodToInterval(p);
    if (iv) intervals.push(iv);
  }
  if (intervals.length === 0) return { status: 'unknown', fits: false };

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

/**
 * Evaluates a place's hours against the item's scheduled visit window and
 * returns display-ready status + warning copy. `status: 'unknown'` (and no
 * warning) when the place has no hours data, so unknown venues are never
 * flagged.
 */
export function getVenueHoursStatus(
  place: ItineraryPlace | undefined,
  dateISO: string | undefined,
  startHHMM: string | undefined,
  endHHMM: string | undefined,
): VenueHoursStatus {
  const fit = visitFitsHours(place?.openingHours, dateISO, startHHMM, endHHMM);
  const closeLabel = fit.closeHHMM ? formatTime(fit.closeHHMM) : undefined;

  if (fit.status === 'open') {
    return {
      status: 'open',
      fits: true,
      closeHHMM: fit.closeHHMM,
      statusLabel: closeLabel ? `Open · Closes ${closeLabel}` : 'Open',
    };
  }
  if (fit.status === 'closingSoon') {
    return {
      status: 'closingSoon',
      fits: false,
      closeHHMM: fit.closeHHMM,
      statusLabel: closeLabel ? `Closes ${closeLabel}` : 'Closes soon',
      warning: closeLabel
        ? `Closes ${closeLabel} — before your visit ends. Consider changing.`
        : 'Closes during your visit. Consider changing.',
    };
  }
  if (fit.status === 'closed') {
    return {
      status: 'closed',
      fits: false,
      statusLabel: 'Closed at this time',
      warning: 'Closed at this time. Consider changing.',
    };
  }
  return { status: 'unknown', fits: false };
}
