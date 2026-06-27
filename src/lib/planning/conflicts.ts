/**
 * Errand scheduling-conflict engine (pure, UI-free).
 *
 * Powers the "heads up, this clashes" helper in the errand drawer: when a user
 * pins an errand to a time that's already taken, we detect the overlap, then do
 * the heavy lifting of finding where it actually fits — the soonest open days +
 * a concrete start time on each — and where the *other* errand could move to.
 *
 * Design choices that keep this trustworthy (no false alarms):
 *  - A conflict is only raised for a FIXED-time ('at') draft overlapping another
 *    FIXED-time errand on the same day — i.e. two appointments booked over each
 *    other. Availability windows ('between') and untimed ('anytime') errands
 *    flex around fixed blocks, so they never trigger a conflict.
 *  - Free-slot math, by contrast, treats every committed block (fixed blocks AND
 *    availability windows, one-off AND recurring) as busy, so a suggested slot is
 *    never dropped on top of something the user already cares about.
 */
import type { Errand } from '@/store/useErrandsStore';
import type { RecurringErrand } from '@/store/useRecurringErrandsStore';
import { errandTimeMode, minutesOfDay } from '@/utils/time';
import { recurringDueOn, recurringInstanceId } from '@/lib/recurring';
import { upcomingWeek } from '@/utils/days';

/** A half-open clock span `[start, end)` in minutes from local midnight. */
export interface Interval {
  start: number;
  end: number;
}

/** The subset of an errand (or in-progress draft) the engine reasons about. */
export interface ConflictDraft {
  id?: string | null;
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  durationMin?: number | null;
}

export interface ConflictHit {
  errand: Errand;
  /** Minutes the two blocks overlap. */
  overlapMin: number;
  /** The other errand's committed block. */
  interval: Interval;
}

export interface DaySuggestion {
  /** "YYYY-MM-DD". */
  date: string;
  /** First start that fits, minutes from midnight. */
  slotStart: number;
  /** "HH:MM" label for `slotStart`. */
  slotStartLabel: string;
  /** Total free minutes left in the day window — how breathing-room-y it is. */
  freeMin: number;
}

const DEFAULT_BLOCK_MIN = 30;
const MIN_SLOT_MIN = 15;
/** Day window when the profile has no wake/bed time. */
export const DAY_START_FALLBACK = 8 * 60;
export const DAY_END_FALLBACK = 22 * 60;
const HORIZON_DAYS = 14;
const MAX_SUGGESTIONS = 3;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Minutes-from-midnight → "HH:MM" (clamped to a single day). */
export function minToHHMM(min: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/**
 * The clock block a timed item commits to:
 *  - 'at'      → `[start, start + duration]` (a fixed appointment),
 *  - 'between' → `[start, end]`              (an availability window),
 *  - 'anytime' → `null`                      (no clock — the planner places it).
 */
export function busyInterval(
  startTime?: string | null,
  endTime?: string | null,
  durationMin?: number | null,
): Interval | null {
  const mode = errandTimeMode(
    startTime ?? undefined,
    endTime ?? undefined,
    durationMin ?? undefined,
  );
  if (mode === 'anytime') return null;
  const s = minutesOfDay(startTime ?? '');
  if (s == null) return null;
  if (mode === 'between') {
    const e = minutesOfDay(endTime ?? '');
    if (e == null || e <= s) return null;
    return { start: s, end: e };
  }
  const dur = durationMin && durationMin > 0 ? durationMin : DEFAULT_BLOCK_MIN;
  return { start: s, end: s + dur };
}

export function overlapMinutes(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function isFixedTime(
  startTime?: string | null,
  endTime?: string | null,
  durationMin?: number | null,
): boolean {
  return (
    errandTimeMode(
      startTime ?? undefined,
      endTime ?? undefined,
      durationMin ?? undefined,
    ) === 'at'
  );
}

/**
 * A recurring template projected onto a concrete day as a minimal Errand, so a
 * routine that hasn't been materialized yet (e.g. on a future day) can still be
 * surfaced as a clash. Carries `recurringId` + `date` so the drawer's "Skip"
 * action can drop just that occurrence.
 */
function recurringOccurrenceAsErrand(t: RecurringErrand, date: string): Errand {
  return {
    id: recurringInstanceId(t.id, date),
    title: t.title,
    startTime: t.startTime,
    endTime: t.endTime,
    durationMin: t.durationMin,
    date,
    address: t.address,
    latitude: t.latitude,
    longitude: t.longitude,
    placeId: t.placeId,
    travelMode: t.travelMode,
    notes: t.notes,
    recurringId: t.id,
    rawText: t.title,
    done: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Every errand committed to `date` — one-off AND recurring (materialized or
 * still only a template, projected on the fly). `excludeId` drops the errand
 * being created/edited so callers can score the day with vs. without it.
 */
export function collectDayErrands(
  date: string,
  errands: Errand[],
  recurring: RecurringErrand[],
  excludeId?: string | null,
): Errand[] {
  const out: Errand[] = [];
  const seenRecurring = new Set<string>();
  for (const e of errands) {
    // Skip the errand being created/edited — and if it's a materialized
    // recurring occurrence, suppress its routine's projection too, so the day
    // is scored *without* it (otherwise the virtual occurrence below re-adds it
    // and the exclude is a no-op).
    if (excludeId && e.id === excludeId) {
      if (e.recurringId) seenRecurring.add(e.recurringId);
      continue;
    }
    if (e.done) continue;
    if (e.date !== date) continue;
    if (e.recurringId) seenRecurring.add(e.recurringId);
    out.push(e);
  }
  for (const t of recurring) {
    if (seenRecurring.has(t.id)) continue;
    if (!recurringDueOn(t, date)) continue;
    out.push(recurringOccurrenceAsErrand(t, date));
  }
  return out;
}

/** Errand length in minutes (committed block, or its duration estimate). */
export function errandLengthMin(e: {
  startTime?: string | null;
  endTime?: string | null;
  durationMin?: number | null;
}): number {
  const iv = busyInterval(e.startTime, e.endTime, e.durationMin);
  if (iv) return iv.end - iv.start;
  return e.durationMin && e.durationMin > 0 ? e.durationMin : DEFAULT_BLOCK_MIN;
}

/**
 * Fixed-time errands on the draft's day whose block overlaps the draft. Empty
 * unless the draft itself is a fixed-time ('at') block with a date — windows and
 * untimed errands are flexible and never clash. Recurring routines are honoured
 * even when not yet materialized for the day, so future-day clashes still show.
 * Sorted by start time.
 */
export function findErrandConflicts(
  draft: ConflictDraft,
  errands: Errand[],
  recurring: RecurringErrand[] = [],
): ConflictHit[] {
  if (!draft.date) return [];
  if (!isFixedTime(draft.startTime, draft.endTime, draft.durationMin)) return [];
  const dIv = busyInterval(draft.startTime, draft.endTime, draft.durationMin);
  if (!dIv) return [];

  const hits: ConflictHit[] = [];
  const seenRecurring = new Set<string>();
  for (const e of errands) {
    // The errand being edited never clashes with itself — and if it's a
    // materialized recurring occurrence, mark its routine seen so the virtual
    // projection below doesn't re-introduce it as a phantom self-clash (the
    // "overlaps itself after moving the date" bug).
    if (draft.id && e.id === draft.id) {
      if (e.recurringId) seenRecurring.add(e.recurringId);
      continue;
    }
    if (e.done) continue;
    if (e.date !== draft.date) continue;
    if (e.recurringId) seenRecurring.add(e.recurringId);
    if (!isFixedTime(e.startTime, e.endTime, e.durationMin)) continue;
    const eIv = busyInterval(e.startTime, e.endTime, e.durationMin);
    if (!eIv) continue;
    const ov = overlapMinutes(dIv, eIv);
    if (ov > 0) hits.push({ errand: e, overlapMin: ov, interval: eIv });
  }
  for (const t of recurring) {
    if (seenRecurring.has(t.id)) continue;
    if (!recurringDueOn(t, draft.date)) continue;
    if (!isFixedTime(t.startTime, t.endTime, t.durationMin)) continue;
    const tIv = busyInterval(t.startTime, t.endTime, t.durationMin);
    if (!tIv) continue;
    const ov = overlapMinutes(dIv, tIv);
    if (ov > 0) {
      hits.push({
        errand: recurringOccurrenceAsErrand(t, draft.date),
        overlapMin: ov,
        interval: tIv,
      });
    }
  }
  hits.sort((a, b) => a.interval.start - b.interval.start);
  return hits;
}

function mergeIntervals(list: Interval[]): Interval[] {
  if (list.length <= 1) return list.map((iv) => ({ ...iv }));
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/**
 * Every committed block on `date` — fixed appointments AND availability windows,
 * from one-off errands AND recurring routines (whether already materialized into
 * the errands list or still only a template) — merged into non-overlapping busy
 * spans. `excludeId` drops the errand being moved so it can't block itself.
 */
export function dayBusyIntervals(
  date: string,
  errands: Errand[],
  recurring: RecurringErrand[],
  excludeId?: string | null,
): Interval[] {
  const out: Interval[] = [];
  const seenRecurring = new Set<string>();
  for (const e of errands) {
    // Drop the errand being moved — and suppress its routine projection when
    // it's a recurring occurrence — so it can't block its own slot.
    if (excludeId && e.id === excludeId) {
      if (e.recurringId) seenRecurring.add(e.recurringId);
      continue;
    }
    if (e.done) continue;
    if (e.date !== date) continue;
    if (e.recurringId) seenRecurring.add(e.recurringId);
    const iv = busyInterval(e.startTime, e.endTime, e.durationMin);
    if (iv) out.push(iv);
  }
  for (const t of recurring) {
    if (seenRecurring.has(t.id)) continue;
    if (!recurringDueOn(t, date)) continue;
    const iv = busyInterval(t.startTime, t.endTime, t.durationMin);
    if (iv) out.push(iv);
  }
  return mergeIntervals(out);
}

/**
 * The minutes reserved by the day's "anytime" items — those with a length but no
 * clock (mode 'anytime'), including duration-only recurring routines, which also
 * project to 'anytime'. They occupy no fixed interval, so the timeline can't
 * place them, but they DO consume the day's capacity: counting them here keeps a
 * suggested slot from quietly overbooking a day that's already spoken for.
 */
export function dayAnytimeLoadMin(
  date: string,
  errands: Errand[],
  recurring: RecurringErrand[],
  excludeId?: string | null,
): number {
  let load = 0;
  for (const e of collectDayErrands(date, errands, recurring, excludeId)) {
    if (busyInterval(e.startTime, e.endTime, e.durationMin) == null) {
      load += errandLengthMin(e);
    }
  }
  return load;
}

/** The free gaps within `[windowStart, windowEnd)`, given busy spans. */
export function freeSlots(
  busy: Interval[],
  windowStart: number,
  windowEnd: number,
): Interval[] {
  const merged = mergeIntervals(busy).filter(
    (b) => b.end > windowStart && b.start < windowEnd,
  );
  const slots: Interval[] = [];
  let cursor = windowStart;
  for (const b of merged) {
    const bs = Math.max(b.start, windowStart);
    if (bs > cursor) slots.push({ start: cursor, end: bs });
    cursor = Math.max(cursor, Math.min(b.end, windowEnd));
  }
  if (cursor < windowEnd) slots.push({ start: cursor, end: windowEnd });
  return slots;
}

function firstFittingSlot(
  busy: Interval[],
  needMin: number,
  windowStart: number,
  windowEnd: number,
  earliest: number,
): number | null {
  const need = Math.max(MIN_SLOT_MIN, needMin);
  for (const slot of freeSlots(busy, windowStart, windowEnd)) {
    const start = Math.max(slot.start, earliest);
    if (start + need <= slot.end) return start;
  }
  return null;
}

export interface SuggestOptions {
  windowStart?: number;
  windowEnd?: number;
  /** Don't suggest a slot before this minute on `todayIso` (skip the past). */
  nowMin?: number;
  todayIso?: string;
  /** Days to skip (e.g. the clashing day itself). */
  excludeDates?: string[];
  count?: number;
  horizonDays?: number;
}

function totalFree(busy: Interval[], windowStart: number, windowEnd: number): number {
  return freeSlots(busy, windowStart, windowEnd).reduce(
    (sum, s) => sum + Math.max(0, s.end - s.start),
    0,
  );
}

/**
 * The soonest upcoming days that can comfortably fit a `durationMin` block, each
 * with the first open start + how free the day is. Recurring routines are
 * honoured even on future days that haven't been materialized yet.
 */
export function suggestDays(
  durationMin: number,
  errands: Errand[],
  recurring: RecurringErrand[],
  opts: SuggestOptions = {},
): DaySuggestion[] {
  const {
    windowStart = DAY_START_FALLBACK,
    windowEnd = DAY_END_FALLBACK,
    nowMin,
    todayIso,
    excludeDates = [],
    count = MAX_SUGGESTIONS,
    horizonDays = HORIZON_DAYS,
  } = opts;
  const need = Math.max(MIN_SLOT_MIN, durationMin || DEFAULT_BLOCK_MIN);
  const skip = new Set(excludeDates);

  const out: DaySuggestion[] = [];
  for (const d of upcomingWeek(horizonDays)) {
    if (skip.has(d.iso)) continue;
    const busy = dayBusyIntervals(d.iso, errands, recurring);
    // On today the day's already underway — place (and measure) from now, not
    // from this morning's wake, so the past isn't offered or counted as free.
    const dayStart =
      todayIso && d.iso === todayIso && nowMin != null
        ? Math.max(windowStart, nowMin)
        : windowStart;
    const slotStart = firstFittingSlot(busy, need, dayStart, windowEnd, dayStart);
    // The block must land in a real opening — that, and only that, decides
    // whether a day can take it. Untimed/routine ("anytime") work never blocks a
    // specific time, so it must NOT hide an otherwise-open day; it only trims the
    // reported breathing room below so a busy-but-open day reads honestly instead
    // of wide open.
    if (slotStart == null) continue;
    const free = Math.max(
      0,
      totalFree(busy, dayStart, windowEnd) -
        dayAnytimeLoadMin(d.iso, errands, recurring),
    );
    out.push({
      date: d.iso,
      slotStart,
      slotStartLabel: minToHHMM(slotStart),
      freeMin: free,
    });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Where an EXISTING errand could move so it stops clashing with the draft. Tries
 * the errand's *own* day first (treating the draft's block as busy, so the two
 * no longer overlap), then falls back to the soonest other day that fits.
 */
export function suggestSlotForErrand(
  errand: Errand,
  draft: ConflictDraft,
  errands: Errand[],
  recurring: RecurringErrand[],
  opts: SuggestOptions = {},
): DaySuggestion | null {
  const { windowStart = DAY_START_FALLBACK, windowEnd = DAY_END_FALLBACK } = opts;
  const len = errandLengthMin(errand);

  if (draft.date) {
    const busy = dayBusyIntervals(draft.date, errands, recurring, errand.id);
    const dIv = busyInterval(draft.startTime, draft.endTime, draft.durationMin);
    if (dIv) busy.push(dIv);
    const merged = mergeIntervals(busy);
    const slotStart = firstFittingSlot(merged, len, windowStart, windowEnd, windowStart);
    if (slotStart != null) {
      const anytimeLoad = dayAnytimeLoadMin(
        draft.date,
        errands,
        recurring,
        errand.id,
      );
      return {
        date: draft.date,
        slotStart,
        slotStartLabel: minToHHMM(slotStart),
        freeMin: Math.max(0, totalFree(merged, windowStart, windowEnd) - anytimeLoad),
      };
    }
  }

  const [soonest] = suggestDays(len, errands, recurring, {
    ...opts,
    excludeDates: draft.date ? [draft.date] : [],
    count: 1,
  });
  return soonest ?? null;
}
