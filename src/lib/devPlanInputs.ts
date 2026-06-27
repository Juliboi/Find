/**
 * DEV helper: gather EVERY user-side input that feeds the day planner into one
 * flat JSON snapshot, so it can be copy-pasted into an external model (Gemini /
 * AI Studio) and tested by hand. It mirrors the home screen's "copy scheduled
 * errands" debug export, but is exhaustive: the three plan-drawer steps (day,
 * start/end time + location, meals) PLUS the user's profile, anchor locations,
 * full errand list, recurring templates, and saved people.
 *
 * Pure data only — no React / React-Native imports — so it stays trivially
 * callable from anywhere. It reads the global zustand stores via `getState()`
 * (the same pattern `src/lib/recurring.ts` uses) and takes the drawer's local,
 * not-yet-persisted selection as its single argument.
 */
import type { LocationPin } from '@/store/useHomeStore';
import { useHomeStore } from '@/store/useHomeStore';
import { useProfileStore } from '@/store/useProfileStore';
import {
  errandStatus,
  useErrandsStore,
  type Errand,
} from '@/store/useErrandsStore';
import {
  useRecurringErrandsStore,
  type RecurringErrand,
} from '@/store/useRecurringErrandsStore';
import { usePeopleStore, type Person } from '@/store/usePeopleStore';
import {
  MEAL_KEYS,
  type MealKey,
  type MealMode,
} from '@/store/usePlanSetupStore';
import { recurringDueOn } from '@/lib/recurring';
import { mealErrandLabel } from '@/lib/meals';
import { todayISO } from '@/utils/time';

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The drawer's live (possibly unsaved) selection across all three steps. Passed
 * in because it's component state, not store state — everything else is read
 * from the persisted stores.
 */
export interface PlanInputsSelection {
  /** "YYYY-MM-DD" — the day being planned (step 0). */
  date: string;
  /** "HH:MM" 24h start (steps 0 + 1). */
  startTime: string;
  /** Where the day starts (step 1), or null if unresolved. */
  startLocation: LocationPin | null;
  /** "HH:MM" 24h end (step 1). */
  endTime: string;
  /** Where the day ends (step 1), or null. */
  endLocation: LocationPin | null;
  /** Per-meal dining preference (step 2). */
  mealModes: Record<MealKey, MealMode>;
  /** Per-meal link to a covering dining errand id, or null (step 2). */
  mealLinks: Record<MealKey, string | null>;
  /** Whether the car is in play for this day (step 0, when the user has one). */
  useCarToday: boolean;
}

function pin(p: LocationPin | null | undefined) {
  return p
    ? { label: p.label, latitude: p.latitude, longitude: p.longitude }
    : null;
}

/** Add minutes to an "HH:MM" clock time, clamped to the same day (no wrap). */
function addMinutes(hhmm: string, minutes: number): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  const clamped = Math.max(0, Math.min(23 * 60 + 59, total));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

/** Full, AI-readable view of one errand (every field the planner can use). */
function serializeErrand(e: Errand, today: string) {
  return {
    id: e.id,
    title: e.title,
    source: e.source ?? 'user',
    status: errandStatus(e, today),
    date: e.date ?? null,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
    durationMin: e.durationMin ?? null,
    address: e.address ?? null,
    latitude: e.latitude ?? null,
    longitude: e.longitude ?? null,
    placeId: e.placeId ?? null,
    travelMode: e.travelMode ?? null,
    rating: e.rating ?? null,
    ratingCount: e.ratingCount ?? null,
    priceLevel: e.priceLevel ?? null,
    notes: e.notes ?? null,
    recurringId: e.recurringId ?? null,
    plannedDate: e.plannedDate ?? null,
    done: e.done,
  };
}

/** Full view of a recurring template, with weekdays spelled out for clarity. */
function serializeTemplate(t: RecurringErrand) {
  return {
    id: t.id,
    title: t.title,
    weekdays: t.weekdays,
    weekdayNames: t.weekdays.map((d) => WEEKDAY_NAMES[d] ?? String(d)),
    startTime: t.startTime ?? null,
    endTime: t.endTime ?? null,
    durationMin: t.durationMin ?? null,
    address: t.address ?? null,
    latitude: t.latitude ?? null,
    longitude: t.longitude ?? null,
    placeId: t.placeId ?? null,
    travelMode: t.travelMode ?? null,
    notes: t.notes ?? null,
    skippedDates: t.skippedDates,
  };
}

function serializePerson(p: Person) {
  return {
    id: p.id,
    name: p.name,
    nicknames: p.nicknames,
    place: p.place
      ? {
          label: p.place.label,
          latitude: p.place.latitude ?? null,
          longitude: p.place.longitude ?? null,
          placeId: p.place.placeId ?? null,
        }
      : null,
    notes: p.notes ?? null,
  };
}

/**
 * Project a recurring template onto the planned day exactly as the materializer
 * would (`templateToErrandInput`): an explicit end is a Between window; without
 * one the end is start+duration. Lets a FUTURE day's repeats show up even
 * though no real instance has been materialized yet.
 */
function occurrenceForDay(t: RecurringErrand) {
  const endTime = t.endTime
    ? t.endTime
    : t.startTime && t.durationMin
      ? addMinutes(t.startTime, t.durationMin)
      : null;
  return {
    templateId: t.id,
    title: t.title,
    startTime: t.startTime ?? null,
    endTime,
    durationMin: t.durationMin ?? null,
    address: t.address ?? null,
    latitude: t.latitude ?? null,
    longitude: t.longitude ?? null,
    placeId: t.placeId ?? null,
    travelMode: t.travelMode ?? null,
    notes: t.notes ?? null,
  };
}

const NOTE =
  "Diem planning inputs snapshot. `planSetup` is what the user configured in the 3-step plan drawer for `date`. " +
  '`errands.forSelectedDay` are errands already dated to that day; `recurring.occurrencesOnSelectedDay` are repeating-errand ' +
  'instances DUE that day (computed from templates, so they appear even for a future day not yet materialized). ' +
  '`errands.all`, `recurring.templates`, and `people` are the full saved lists. Times are "HH:MM" 24h; weekdays are 0=Sun..6=Sat.';

/**
 * Build the full planning-inputs snapshot. Reads the profile, anchor, errand,
 * recurring, and people stores; combines them with the drawer's `selection`.
 */
export function buildPlanInputsPayload(selection: PlanInputsSelection) {
  const today = todayISO();
  const profile = useProfileStore.getState();
  const homeState = useHomeStore.getState();
  const errands = useErrandsStore.getState().items;
  const templates = useRecurringErrandsStore.getState().items;
  const people = usePeopleStore.getState().items;

  const mealWindows: Record<MealKey, { start: string | null; end: string | null }> = {
    breakfast: { start: profile.breakfastStart, end: profile.breakfastEnd },
    lunch: { start: profile.lunchStart, end: profile.lunchEnd },
    dinner: { start: profile.dinnerStart, end: profile.dinnerEnd },
  };

  // Per-meal config, resolving any linked dining errand to its label so the
  // model sees the actual venue standing in for that meal.
  const mealEntry = (meal: MealKey) => {
    const linkId = selection.mealLinks?.[meal] ?? null;
    const linked = linkId ? errands.find((e) => e.id === linkId) ?? null : null;
    return {
      mode: selection.mealModes?.[meal] ?? 'auto',
      window: mealWindows[meal],
      linkedErrand: linked
        ? { id: linked.id, title: linked.title, place: mealErrandLabel(linked) }
        : null,
    };
  };
  const meals = Object.fromEntries(
    MEAL_KEYS.map((meal) => [meal, mealEntry(meal)]),
  ) as Record<MealKey, ReturnType<typeof mealEntry>>;

  const errandsForDay = errands
    .filter((e) => e.date === selection.date)
    .map((e) => serializeErrand(e, today));

  const recurringForDay = templates
    .filter((t) => recurringDueOn(t, selection.date))
    .map(occurrenceForDay);

  return {
    generatedAt: new Date().toISOString(),
    note: NOTE,
    planSetup: {
      date: selection.date,
      startTime: selection.startTime,
      startLocation: pin(selection.startLocation),
      endTime: selection.endTime,
      endLocation: pin(selection.endLocation),
      car: { hasCar: profile.hasCar, useCarToday: selection.useCarToday },
      meals,
    },
    profile: {
      fullName: profile.fullName ?? null,
      wakeTime: profile.wakeTime ?? null,
      bedTime: profile.bedTime ?? null,
      wakeUpDurationMin: profile.wakeUpDurationMin,
      mealWindows,
      windDownTime: profile.windDownTime ?? null,
      allowScreenWindDown: profile.allowScreenWindDown,
      hasCar: profile.hasCar,
      dietary: profile.dietary,
      dietaryNotes: profile.dietaryNotes ?? null,
    },
    locations: {
      home: pin(homeState.home),
      work: pin(homeState.work),
      endOfDay: pin(homeState.endOfDay ?? homeState.home),
    },
    errands: {
      forSelectedDay: errandsForDay,
      all: errands.map((e) => serializeErrand(e, today)),
    },
    recurring: {
      occurrencesOnSelectedDay: recurringForDay,
      templates: templates.map(serializeTemplate),
    },
    people: people.map(serializePerson),
  };
}
