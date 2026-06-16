/**
 * The recurring-errand engine: turns recurring TEMPLATES (every-Monday rules,
 * see `useRecurringErrandsStore`) into real, editable `Errand` instances for a
 * given day, and keeps the errands list tidy.
 *
 * Why materialize into the errands store instead of a parallel "virtual" list?
 * Because the user wants each occurrence to behave like an ordinary errand —
 * editable (a friend postpones → change the time / place), skippable, and
 * automatically preselected when planning the day. Once an occurrence is a real
 * dated errand, the home screen, the planner's preselect, and the "mark planned"
 * bookkeeping all work with ZERO special-casing. The template stays the source
 * of truth for the RULE; the instance is the editable exception for that day.
 *
 * Instances use a DETERMINISTIC id (`<templateId>_<yyyymmdd>`) so the same
 * occurrence never duplicates — across regeneration passes or across devices
 * (Supabase upsert dedupes by primary key).
 */
import {
  errandStatus,
  useErrandsStore,
  type Errand,
  type ErrandInput,
} from '@/store/useErrandsStore';
import {
  useRecurringErrandsStore,
  type RecurringErrand,
} from '@/store/useRecurringErrandsStore';
import { todayISO } from '@/utils/time';

/** JS weekday (0 = Sunday … 6 = Saturday) for a local "YYYY-MM-DD", or null. */
function weekdayOf(date: string): number | null {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getDay();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Add minutes to an "HH:MM" clock time, clamped to the same day (no wrap). */
function addMinutes(hhmm: string, minutes: number): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return undefined;
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  const clamped = Math.max(0, Math.min(23 * 60 + 59, total));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/**
 * Is this template due on `date`? It fires when the date's weekday is one of the
 * template's `weekdays` AND the user hasn't skipped that specific date.
 */
export function recurringDueOn(template: RecurringErrand, date: string): boolean {
  if (!template.weekdays || template.weekdays.length === 0) return false;
  if (template.skippedDates.includes(date)) return false;
  const dow = weekdayOf(date);
  return dow != null && template.weekdays.includes(dow);
}

/** The deterministic errand id for a template's occurrence on `date`. */
export function recurringInstanceId(templateId: string, date: string): string {
  return `${templateId}_${date.replace(/-/g, '')}`;
}

/** Is `e` a materialized occurrence of any recurring template on `date`? */
export function isRecurringInstanceForDate(e: Errand, date: string): boolean {
  return Boolean(e.recurringId) && e.date === date;
}

/** Today's still-open recurring occurrences (what the home section renders). */
export function recurringInstancesForDate(errands: Errand[], date: string): Errand[] {
  return errands.filter(
    (e) => isRecurringInstanceForDate(e, date) && errandStatus(e, date) === 'open',
  );
}

/** Project a template onto a concrete day as the errand fields to materialize. */
function templateToErrandInput(
  template: RecurringErrand,
  date: string,
): ErrandInput & { recurringId: string } {
  const startTime = template.startTime;
  const durationMin = template.durationMin;
  const endTime =
    startTime && durationMin ? addMinutes(startTime, durationMin) : undefined;
  return {
    title: template.title,
    startTime,
    endTime,
    durationMin,
    date,
    address: template.address,
    latitude: template.latitude,
    longitude: template.longitude,
    placeId: template.placeId,
    autoPlace: template.autoPlace,
    placeQuery: template.placeQuery,
    notes: template.notes,
    source: 'user',
    rawText: template.title,
    recurringId: template.id,
  };
}

/**
 * Generate the errand instances due on `date`, and prune occurrences that
 * shouldn't be shown. Safe to call often (idempotent): re-materializing an
 * existing occurrence is a no-op that preserves the user's edits.
 *
 * Pruning rules (only ever touches OPEN recurring instances — done/planned ones
 * stay as history, like ordinary errands):
 *   - any occurrence dated before TODAY → drop (last week's never lingers). This
 *     keys off the real today, not `date`, so planning a FUTURE day never wipes
 *     today's still-open occurrence;
 *   - the occurrence on `date` whose template is gone or no longer due (deleted,
 *     weekday changed, or skipped) → drop.
 */
export function materializeRecurringForDate(date: string): void {
  const templates = useRecurringErrandsStore.getState().items;
  const store = useErrandsStore.getState();
  const today = todayISO();

  for (const template of templates) {
    if (recurringDueOn(template, date)) {
      store.materializeInstance(
        recurringInstanceId(template.id, date),
        templateToErrandInput(template, date),
      );
    }
  }

  const byId = new Map(templates.map((t) => [t.id, t] as const));
  for (const e of useErrandsStore.getState().items) {
    if (!e.recurringId || !e.date) continue;
    if (errandStatus(e, date) !== 'open') continue; // keep done/planned history
    if (e.date < today) {
      store.remove(e.id);
    } else if (e.date === date) {
      const template = byId.get(e.recurringId);
      if (!template || !recurringDueOn(template, e.date)) store.remove(e.id);
    }
  }
}

/**
 * Skip a single occurrence: record the exception on the template (so it won't
 * regenerate) AND drop the already-materialized instance for instant feedback.
 */
export function skipRecurringOccurrence(templateId: string, date: string): void {
  useRecurringErrandsStore.getState().skipOccurrence(templateId, date);
  useErrandsStore.getState().remove(recurringInstanceId(templateId, date));
}
