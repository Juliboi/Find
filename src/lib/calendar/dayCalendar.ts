/**
 * Pure layout math for the day-calendar timeline.
 *
 * The calendar shows ONE day as a vertical timeline. Only errands that carry a
 * start time become positioned blocks ("events"); everything else for the day
 * (untimed reminders) is surfaced separately as the "unscheduled" tray. Keeping
 * the geometry here — framework-free and side-effect-free — lets the homepage
 * widget render a mini preview, the full screen render the real thing, and a
 * future drag-to-schedule pass reason about minutes ↔ pixels, all from the same
 * source of truth.
 */
import type { Errand } from '@/store/useErrandsStore';
import { errandTimeMode, minutesOfDay } from '@/utils/time';

/** Default visible window when the day has no early/late outliers (07:00–22:00). */
const DEFAULT_START_HOUR = 7;
const DEFAULT_END_HOUR = 22;

const DAY_MIN = 24 * 60;

/**
 * A timed errand placed on the timeline. `startMin`/`endMin` are minutes from
 * midnight; `col`/`cols` are the overlap-packing result (this event sits in
 * column `col` of `cols` side-by-side columns within its overlap cluster).
 */
export interface CalEvent {
  id: string;
  errand: Errand;
  startMin: number;
  endMin: number;
  /** True for a "between" availability window (start…end wider than its work). */
  flexible: boolean;
  /** True when this came from a recurring template occurrence. */
  recurring: boolean;
  col: number;
  cols: number;
}

export interface TimeWindow {
  startMin: number;
  endMin: number;
}

/** The day split into the timeline's positioned blocks and the unscheduled rest. */
export interface DayCalendar {
  /** Timed errands, overlap-packed and sorted by start. */
  timed: CalEvent[];
  /** Dated, still-open errands with no start time — the "other plans" tray. */
  untimed: Errand[];
}

/**
 * Turn one errand into a positioned event, or null when it has no start time
 * (those flow to the unscheduled tray instead). Duration falls back through
 * end time → duration estimate → a sensible 60-minute default. The span stays
 * true to the real duration; each view floors the block's PIXEL height (not its
 * minutes) so a short stop reads accurately without faking a longer slot.
 */
export function errandToCalEvent(errand: Errand): CalEvent | null {
  const startMin = minutesOfDay(errand.startTime);
  if (startMin == null) return null;

  const mode = errandTimeMode(errand.startTime, errand.endTime, errand.durationMin);
  let endMin: number;
  const explicitEnd = minutesOfDay(errand.endTime);
  if (explicitEnd != null && explicitEnd > startMin) {
    endMin = explicitEnd;
  } else if (errand.durationMin && errand.durationMin > 0) {
    endMin = startMin + errand.durationMin;
  } else {
    endMin = startMin + 60;
  }
  // Keep the REAL span so overlap-packing and labels reflect the true duration
  // (a 15-min stop must not read as 30 and falsely clash with the next block).
  // A legible minimum is a render concern: each view floors the block's PIXEL
  // height, never the minutes here.
  endMin = Math.min(DAY_MIN, Math.max(endMin, startMin + 1));

  return {
    id: errand.id,
    errand,
    startMin,
    endMin,
    flexible: mode === 'between',
    recurring: Boolean(errand.recurringId),
    col: 0,
    cols: 1,
  };
}

/**
 * Assign side-by-side columns to overlapping events so they never visually
 * stack. Events are grouped into clusters of transitively-overlapping blocks;
 * within a cluster each event takes the first column whose last event has
 * already ended, and every event in the cluster is widened/narrowed to the
 * cluster's column count. Returns fresh objects (never mutates the input).
 */
export function packEvents(events: CalEvent[]): CalEvent[] {
  const sorted = [...events].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin,
  );

  const out: CalEvent[] = [];
  let cluster: CalEvent[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    // `columns[c]` holds the running end-minute of column c's last event.
    const columns: number[] = [];
    const placed = cluster.map((ev) => {
      let col = columns.findIndex((end) => end <= ev.startMin);
      if (col === -1) {
        col = columns.length;
        columns.push(ev.endMin);
      } else {
        columns[col] = ev.endMin;
      }
      return { ev, col };
    });
    const cols = columns.length;
    for (const { ev, col } of placed) out.push({ ...ev, col, cols });
    cluster = [];
    clusterEnd = -1;
  };

  for (const ev of sorted) {
    if (cluster.length > 0 && ev.startMin >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  flush();

  return out;
}

/**
 * Split a day's errands into timeline events + the unscheduled tray. Only
 * errands dated to `date` that are still active (not done) are considered, so
 * the calendar reflects what's actually on for that day. Untimed errands are
 * sorted newest-first to mirror the home list.
 */
export function buildDayCalendar(errands: Errand[], date: string): DayCalendar {
  const timed: CalEvent[] = [];
  const untimed: Errand[] = [];
  for (const e of errands) {
    if (e.date !== date || e.done) continue;
    const ev = errandToCalEvent(e);
    if (ev) timed.push(ev);
    else untimed.push(e);
  }
  untimed.sort((a, b) => b.createdAt - a.createdAt);
  return { timed: packEvents(timed), untimed };
}

/**
 * The window the full timeline should render: a comfortable default
 * (07:00–22:00) stretched to include any earlier/later events and — when
 * provided — the current time, so "now" is always on screen. Clamped to a
 * single day.
 */
export function dayWindow(
  events: CalEvent[],
  opts: { nowMin?: number | null } = {},
): TimeWindow {
  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  for (const ev of events) {
    startHour = Math.min(startHour, Math.floor(ev.startMin / 60));
    endHour = Math.max(endHour, Math.ceil(ev.endMin / 60));
  }
  const { nowMin } = opts;
  if (nowMin != null) {
    startHour = Math.min(startHour, Math.floor(nowMin / 60));
    endHour = Math.max(endHour, Math.ceil((nowMin + 60) / 60));
  }
  startHour = Math.max(0, startHour);
  endHour = Math.min(24, Math.max(endHour, startHour + 1));
  return { startMin: startHour * 60, endMin: endHour * 60 };
}

/** "7 AM", "12 PM", "11 PM" for an integer hour 0–24 (used by the timeline gutters). */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = ((h + 11) % 12) + 1;
  return `${hour12} ${period}`;
}

/**
 * The tight window hugging just the events (earliest start → latest end), or
 * null when there are none. Used by the compact homepage preview, which has no
 * room for empty hours.
 */
export function contentWindow(events: CalEvent[]): TimeWindow | null {
  if (events.length === 0) return null;
  let startMin = Infinity;
  let endMin = -Infinity;
  for (const ev of events) {
    startMin = Math.min(startMin, ev.startMin);
    endMin = Math.max(endMin, ev.endMin);
  }
  return { startMin, endMin };
}
