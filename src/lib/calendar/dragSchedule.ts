/**
 * Pure math for the day-calendar's drag-to-schedule EDIT mode.
 *
 * The read-only calendar lives in `dayCalendar.ts`; this module adds the extra
 * geometry the editor needs when the user drags errands around: snapping a Y
 * offset to a minute, turning a set of pending placements into a positioned
 * draft layout, surfacing a "between" errand's availability window, and
 * estimating the commute between consecutive located stops so a drop between
 * two plans can show the travel it implies.
 *
 * Everything here is framework-free and side-effect-free so the editor can call
 * it from worklets' JS callbacks and we can reason about minutes ↔ pixels from a
 * single source of truth (shared with the read-only view's `pxPerMin`).
 */
import type { Errand } from '@/store/useErrandsStore';
import { errandTimeMode, minutesOfDay } from '@/utils/time';
import {
  estimateTravel,
  travelIconName,
  type TravelMode,
} from '@/lib/travel';
import { type TimeWindow } from './dayCalendar';

/** Minutes a dragged block snaps to — quarter-hours read as a tidy calendar. */
export const SNAP_MIN = 15;

const DAY_MIN = 24 * 60;

/**
 * One errand's unsaved edits in the editor, keyed by errand id. Every field is
 * optional and additive: a drag sets `startMin`, a stretch sets `durationMin`, a
 * trash tap sets `deleted`. An untimed ("Anytime") errand appears on the
 * timeline exactly when it gains a `startMin`; a timed errand's `startMin`
 * overrides its stored start. Nothing here is persisted until Confirm.
 */
export interface PendingEdit {
  /** Dragged start, minutes from midnight (absent = keep the stored/base start). */
  startMin?: number;
  /** Stretched WORK length in minutes (absent = keep the errand's own length). */
  durationMin?: number;
  /** Trashed this session — hidden from the canvas, removed/added-skipped on Confirm. */
  deleted?: boolean;
}

/** The user's unsaved edits for the day, keyed by errand id. */
export type PendingPlacements = Record<string, PendingEdit>;

/**
 * One errand placed on the editable timeline. `startMin`/`endMin` bound the
 * solid WORK block (the draggable piece). `window`, when present, is the wider
 * availability range of a "between" errand — drawn as a highlighted band the
 * work block is meant to sit inside (though the user may drag outside it).
 */
export interface DraftEvent {
  id: string;
  errand: Errand;
  startMin: number;
  endMin: number;
  /** The real WORK length in minutes (what gets committed); `endMin` may be drawn taller to stay legible. */
  workMin: number;
  located: boolean;
  recurring: boolean;
  flexible: boolean;
  window: TimeWindow | null;
  col: number;
  cols: number;
}

/** The editable day: positioned draft blocks + the still-untimed tray errands. */
export interface DayDraft {
  events: DraftEvent[];
  unscheduled: Errand[];
}

/**
 * How long an errand's WORK block is, independent of any availability window:
 * an explicit end−start for a fixed block, else its duration estimate, else a
 * sensible hour. Never the full "between" window — that's the band, not the work.
 */
export function workMinutes(errand: Errand): number {
  const start = minutesOfDay(errand.startTime);
  const end = minutesOfDay(errand.endTime);
  const mode = errandTimeMode(errand.startTime, errand.endTime, errand.durationMin);
  if (mode !== 'between' && start != null && end != null && end > start) {
    return end - start;
  }
  if (errand.durationMin && errand.durationMin > 0) return errand.durationMin;
  return 60;
}

/**
 * The availability window of a "between" errand (start = window open, end =
 * window close), or null for a fixed/anytime errand. This is the region the
 * editor highlights as "where this is meant to go".
 */
export function windowOf(errand: Errand): TimeWindow | null {
  if (errandTimeMode(errand.startTime, errand.endTime, errand.durationMin) !== 'between') {
    return null;
  }
  const startMin = minutesOfDay(errand.startTime);
  const endMin = minutesOfDay(errand.endTime);
  if (startMin == null || endMin == null || endMin <= startMin) return null;
  return { startMin, endMin };
}

/** Where an errand's work block sits before any drag: its window open (between), its start (fixed), or nowhere (untimed). */
export function baseStartMin(errand: Errand): number | null {
  const win = windowOf(errand);
  if (win) return win.startMin;
  return minutesOfDay(errand.startTime);
}

/** Round a minute to the nearest {@link SNAP_MIN}, kept finite + in-day by callers. */
export function snapMinute(min: number, step: number = SNAP_MIN): number {
  return Math.round(min / step) * step;
}

/** Clamp a work block's start so the whole block stays inside the visible window. */
export function clampStart(startMin: number, workMin: number, win: TimeWindow): number {
  const lo = win.startMin;
  const hi = Math.max(lo, win.endMin - workMin);
  return Math.min(Math.max(startMin, lo), hi);
}

/** Minutes-from-midnight → "HH:MM" (24h), wrapped into a single day. */
export function minutesToHHMM(min: number): string {
  const wrapped = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Side-by-side overlap packing for draft work blocks — the same first-fit
 * column assignment the read-only view uses, so a packed edit reads identically
 * to what it'll commit to. Returns fresh objects (never mutates the input).
 */
function packDraft(events: DraftEvent[]): DraftEvent[] {
  const sorted = [...events].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin,
  );
  const out: DraftEvent[] = [];
  let cluster: DraftEvent[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
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
 * Build the editable day from the raw errands + the user's pending drags. An
 * errand becomes a positioned block when it's timed OR has a pending placement;
 * an untimed errand with no pending entry flows to the `unscheduled` tray. Work
 * blocks are overlap-packed; the tray is newest-first (mirrors the read view).
 */
export function buildDayDraft(
  errands: Errand[],
  date: string,
  pending: PendingPlacements,
): DayDraft {
  const events: DraftEvent[] = [];
  const unscheduled: Errand[] = [];

  for (const e of errands) {
    if (e.date !== date || e.done) continue;
    const edit = pending[e.id];
    if (edit?.deleted) continue;
    const start = edit?.startMin != null ? edit.startMin : baseStartMin(e);
    if (start == null) {
      unscheduled.push(e);
      continue;
    }
    const workMin = edit?.durationMin != null ? edit.durationMin : workMinutes(e);
    events.push({
      id: e.id,
      errand: e,
      startMin: start,
      // Real end — overlap-packing and the block's time label must reflect the
      // true duration (a 15-min stop is 15 min, not padded to 30). A legible
      // MINIMUM draw HEIGHT is a render concern, handled in DayEditor, so it
      // never inflates the logical span into false clashes.
      endMin: Math.min(DAY_MIN, start + workMin),
      workMin,
      located: e.latitude != null && e.longitude != null,
      recurring: Boolean(e.recurringId),
      flexible: windowOf(e) != null,
      window: windowOf(e),
      col: 0,
      cols: 1,
    });
  }

  unscheduled.sort((a, b) => b.createdAt - a.createdAt);
  return { events: packDraft(events), unscheduled };
}

/**
 * A commute that sits between two consecutive located stops. `fromEndMin` and
 * `toStartMin` bound the gap it fills; `minutes`/`mode` are the estimate. The
 * editor draws these as connectors so dropping an errand between two plans makes
 * its travel cost visible.
 */
export interface CommuteSegment {
  key: string;
  fromId: string;
  toId: string;
  fromEndMin: number;
  toStartMin: number;
  minutes: number;
  mode: TravelMode;
  icon: string;
  /** True when the next stop starts before this commute could finish. */
  tight: boolean;
}

/**
 * Estimate the commute between each pair of consecutive located stops in a
 * draft (ordered by start). Untimed/unlocated blocks are skipped — a commute
 * only means something between two points on the map. Pure: safe to recompute
 * live as a dragged block's preview minute crosses each snap step.
 */
export function commuteSegments(events: DraftEvent[]): CommuteSegment[] {
  const located = events
    .filter((e) => e.located)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const segs: CommuteSegment[] = [];
  for (let i = 0; i < located.length - 1; i += 1) {
    const a = located[i];
    const b = located[i + 1];
    const est = estimateTravel(
      { latitude: a.errand.latitude!, longitude: a.errand.longitude! },
      { latitude: b.errand.latitude!, longitude: b.errand.longitude! },
    );
    segs.push({
      key: `${a.id}->${b.id}`,
      fromId: a.id,
      toId: b.id,
      fromEndMin: a.endMin,
      toStartMin: b.startMin,
      minutes: est.minutes,
      mode: est.mode,
      icon: travelIconName(est.mode),
      tight: b.startMin - a.endMin < est.minutes,
    });
  }
  return segs;
}
