import { devNow } from '@/store/useDevClockStore';

export function formatTime(hhmm?: string): string {
  if (!hhmm) return '';
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = ((h + 11) % 12) + 1;
  return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
}

/** "HH:MM" -> minutes since midnight, or null if unparseable. */
export function minutesOfDay(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * The three ways an errand (or recurring template) can relate to the clock:
 *   - 'anytime'  — no start; the planner places it freely.
 *   - 'at'       — a fixed start (its block is start … start+duration).
 *   - 'between'  — an availability WINDOW [start, end] the planner schedules a
 *                  `durationMin` block inside (the user is "open" in that range).
 *
 * "between" is encoded with the existing fields (start = window start, end =
 * window end, durationMin = length) and recognised by its slack: the window is
 * longer than the work, i.e. `end − start > durationMin`. A fixed "at a time"
 * errand always has `end = start + durationMin` (no slack), so the two never
 * collide.
 */
export type TimeMode = 'anytime' | 'at' | 'between';

export function errandTimeMode(
  startTime?: string | null,
  endTime?: string | null,
  durationMin?: number | null,
): TimeMode {
  if (!startTime) return 'anytime';
  // A fixed "at a time" errand always ends exactly `durationMin` after it starts.
  // An end that DOESN'T match that (a wider — or otherwise different — span) is an
  // availability window the user opened for the errand: "between" mode.
  if (endTime && durationMin != null) {
    const e = minutesOfDay(endTime);
    const expectedEnd = minutesOfDay(addMinutes(startTime, durationMin));
    if (e != null && expectedEnd != null && e !== expectedEnd) return 'between';
  }
  return 'at';
}

export function addMinutes(hhmm: string, minutes: number): string {
  const [hStr, mStr] = hhmm.split(':');
  const total = Number(hStr) * 60 + Number(mStr) + minutes;
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function todayISO(): string {
  const d = devNow();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local "YYYY-MM-DD" for tomorrow. */
export function tomorrowISO(): string {
  const d = devNow();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function currentHHMM(): string {
  const d = devNow();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes()
    .toString()
    .padStart(2, '0')}`;
}
