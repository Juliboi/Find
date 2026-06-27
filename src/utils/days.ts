import { todayISO } from './time';
import { devNow } from '@/store/useDevClockStore';

/**
 * A single selectable day in the "which day are you planning?" wheel. Carries
 * both the machine date (`iso`, the value we store + feed the planner) and the
 * human-facing labels the wheel renders (`title` like "Today" / "Tomorrow" /
 * "Saturday", plus a short "Sat · Jun 14" style line).
 */
export interface DayOption {
  /** "YYYY-MM-DD" — the stored value. */
  iso: string;
  isToday: boolean;
  isTomorrow: boolean;
  /** "Sat" */
  weekdayShort: string;
  /** "Saturday" */
  weekdayLong: string;
  /** "Jun" */
  monthShort: string;
  /** Day-of-month, e.g. 14. */
  dayNum: number;
  /** Hero label: "Today" | "Tomorrow" | weekday long name. */
  title: string;
  /** Secondary label, e.g. "Jun 14". */
  dateLabel: string;
}

function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local midnight Date for a "YYYY-MM-DD" string. */
export function dateFromISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

function describe(d: Date, todayIso: string, tomorrowIso: string): DayOption {
  const iso = isoOf(d);
  const isToday = iso === todayIso;
  const isTomorrow = iso === tomorrowIso;
  const weekdayLong = d.toLocaleDateString(undefined, { weekday: 'long' });
  return {
    iso,
    isToday,
    isTomorrow,
    weekdayShort: d.toLocaleDateString(undefined, { weekday: 'short' }),
    weekdayLong,
    monthShort: d.toLocaleDateString(undefined, { month: 'short' }),
    dayNum: d.getDate(),
    title: isToday ? 'Today' : isTomorrow ? 'Tomorrow' : weekdayLong,
    dateLabel: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  };
}

/**
 * The next `count` days starting from today (inclusive). Used by the day-picker
 * wheel — "today" sits first so it can be the pre-selected default, with the
 * rest of the week following.
 */
export function upcomingWeek(count = 7, from: Date = devNow()): DayOption[] {
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const todayIso = isoOf(base);
  const tomorrow = new Date(base);
  tomorrow.setDate(base.getDate() + 1);
  const tomorrowIso = isoOf(tomorrow);

  const out: DayOption[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(describe(d, todayIso, tomorrowIso));
  }
  return out;
}

/** Human description for an arbitrary stored ISO date (today/tomorrow aware). */
export function describeDay(iso: string): DayOption {
  const base = devNow();
  const todayIso = isoOf(new Date(base.getFullYear(), base.getMonth(), base.getDate()));
  const tomorrow = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  return describe(dateFromISO(iso), todayIso, isoOf(tomorrow));
}

/**
 * Current wall-clock time as "HH:MM", rounded to the nearest `step` minutes so
 * the time selector seeds to a clean value (e.g. 15:07 → 15:05). Capped at
 * 23:55 so rounding never spills into the next day.
 */
export function roundedNowHHMM(step = 5): string {
  const d = devNow();
  let mins = d.getHours() * 60 + d.getMinutes();
  mins = Math.round(mins / step) * step;
  mins = Math.min(mins, 23 * 60 + 55);
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** True when `iso` is strictly before today (a stale, past selection). */
export function isPastDay(iso: string): boolean {
  return iso < todayISO();
}

/**
 * Local midnight Date for the start of the week containing `iso`. Defaults to a
 * Monday-start week (`weekStartsOn = 1`, the common European convention); pass
 * `0` for a Sunday-start week.
 */
export function startOfWeek(iso: string, weekStartsOn = 1): Date {
  const d = dateFromISO(iso);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}
