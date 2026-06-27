/**
 * The "usable" part of a day — the single source of truth every availability and
 * mindfulness surface measures against, so they all agree on when the day really
 * starts and stops being open for errands.
 *
 *   - START = wake time + the morning ramp-up (`wakeUpDurationMin`). You can't be
 *     out the door the instant the alarm goes off, so the first offerable slot
 *     sits after you're actually up and ready (this is why suggestions no longer
 *     land at 8:30 sharp).
 *   - END   = wind-down time (a SOFT cap): past it the evening turns calm, so we
 *     stop offering/active-counting errand time. Bedtime stays the day's HARD end
 *     elsewhere (the planner's "finish by", sleep) — that's intentionally NOT this
 *     window's job. Falls back to bedtime, then a sensible 22:00.
 *
 * Pure and framework-free: minutes from local midnight in, minutes out.
 */
import { minutesOfDay } from '@/utils/time';
import { DAY_START_FALLBACK, DAY_END_FALLBACK } from '@/lib/planning/conflicts';

const DAY_MIN = 24 * 60;

/** The profile fields the usable window is derived from (all optional/nullable). */
export interface DayWindowProfile {
  /** "HH:MM" wake time. */
  wakeTime?: string | null;
  /** "HH:MM" bedtime — the day's hard end (used only as an end fallback here). */
  bedTime?: string | null;
  /** "HH:MM" after which the evening goes calm — the soft end for offering errands. */
  windDownTime?: string | null;
  /** Minutes to fully wake up before the day is "usable" (morning ramp). */
  wakeUpDurationMin?: number | null;
}

export interface UsableWindow {
  /** Minutes from midnight the day becomes usable (wake + ramp, or `now`). */
  startMin: number;
  /** Minutes from midnight the day stops being open for errands (wind-down cap). */
  endMin: number;
}

/**
 * The usable window for a day. `opts.nowMin` (today only) pushes the start to the
 * current time so we never offer or count time that's already past — pass it for
 * "today", omit it for any other day. The end is always strictly after the
 * wake-based start, even on odd profiles, so callers get a non-empty window.
 */
export function usableDayWindow(
  p: DayWindowProfile,
  opts: { nowMin?: number | null } = {},
): UsableWindow {
  const wakeMin = minutesOfDay(p.wakeTime) ?? DAY_START_FALLBACK;
  const ramp =
    p.wakeUpDurationMin && p.wakeUpDurationMin > 0 ? p.wakeUpDurationMin : 0;
  const baseStart = Math.min(wakeMin + ramp, DAY_MIN);

  // Soft cap: wind-down first, then bedtime, then the default evening. Guard
  // against a misconfigured/earlier value so the window is never empty.
  let endMin =
    minutesOfDay(p.windDownTime) ??
    minutesOfDay(p.bedTime) ??
    DAY_END_FALLBACK;
  if (endMin <= baseStart) endMin = Math.max(DAY_END_FALLBACK, baseStart + 60);
  endMin = Math.min(endMin, DAY_MIN);

  // Today: slide the start to now so the past isn't offered as free. Left
  // uncapped against the end on purpose — a "now" already past the soft cap is a
  // day that's effectively over, which callers handle (no slots / ~0 free).
  const { nowMin } = opts;
  const startMin = nowMin != null ? Math.max(baseStart, nowMin) : baseStart;

  return { startMin, endMin };
}
