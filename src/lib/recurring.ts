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
  // A template with an explicit end carries a Between availability window
  // (start…end) through verbatim, so the occurrence reads as 'between' and the
  // planner schedules inside it. Without one, the end is just start+duration
  // (a fixed-time block).
  const endTime = template.endTime
    ? template.endTime
    : startTime && durationMin
    ? addMinutes(startTime, durationMin)
    : undefined;
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
    travelMode: template.travelMode,
    notes: template.notes,
    source: 'user',
    rawText: template.title,
    recurringId: template.id,
  };
}

/**
 * Generate the errand instances due on `date`, refresh ones whose template was
 * edited, and prune occurrences that shouldn't be shown. Safe to call often.
 *
 * Edit propagation: the materializer never *creates* over an existing instance
 * (so a freshly-built occurrence keeps its identity), but when the RULE has
 * changed since an OPEN occurrence was last touched (`template.updatedAt >
 * instance.updatedAt`) we push the new title/time/place/duration onto it — that
 * way editing a recurring template updates the days already on screen instead
 * of leaving stale copies. A genuine per-occurrence edit (the instance is newer
 * than the template) wins and is left alone; done / planned occurrences stay
 * frozen as history.
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
    if (!recurringDueOn(template, date)) continue;
    const id = recurringInstanceId(template.id, date);
    const input = templateToErrandInput(template, date);
    const existing = store.items.find((e) => e.id === id);
    if (!existing) {
      store.materializeInstance(id, input);
    } else if (
      errandStatus(existing, today) === 'open' &&
      template.updatedAt > existing.updatedAt
    ) {
      store.update(id, input);
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
 * Apply a just-saved template edit to every already-materialized occurrence of
 * it at once — across all days, not only the one a screen is showing. The
 * per-date materializer heals visible days on its own, but calling this on save
 * makes distant days, the planner's preselect, and the conflict / mindfulness
 * engines pick up the new title/time/place immediately. OPEN, today-or-later
 * occurrences are refreshed (or removed when the edit dropped their weekday /
 * skipped them); done and planned occurrences stay frozen as history, and
 * past-dated ones are left for the regular prune.
 */
export function propagateRecurringEdit(templateId: string): void {
  const template = useRecurringErrandsStore
    .getState()
    .items.find((t) => t.id === templateId);
  if (!template) return;
  const store = useErrandsStore.getState();
  const today = todayISO();
  for (const e of store.items) {
    if (e.recurringId !== templateId || !e.date) continue;
    if (e.date < today) continue;
    if (errandStatus(e, today) !== 'open') continue;
    if (recurringDueOn(template, e.date)) {
      store.update(e.id, templateToErrandInput(template, e.date));
    } else {
      store.remove(e.id);
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
