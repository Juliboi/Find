import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { todayISO } from '@/utils/time';
import { roundedNowHHMM } from '@/utils/days';
import type { LocationPin } from '@/store/useHomeStore';

/**
 * Default "day start" time used to seed the time selector for any day that
 * ISN'T today. Picking today seeds the selector to the current time instead
 * (you can't start a day in the past), but a future day has no "now" to anchor
 * to — so it falls back to this sensible morning start.
 */
export const DEFAULT_DAY_START_TIME = '09:00';

/** Sensible fallback day-end when the profile has no bedtime yet. */
export const DEFAULT_DAY_END_TIME = '21:00';

/** The three meals the planner can place + reason about. */
export type MealKey = 'breakfast' | 'lunch' | 'dinner';

/**
 * Per-meal dining preference the user sets in the planner drawer:
 *   - 'auto' — no preference; let the planner decide (home or a spot out).
 *   - 'home' — eat at home (no venue, no travel).
 *   - 'out'  — eat out; the planner finds a place near the route at that time.
 * A meal can instead be LINKED to one of the user's own errands (see mealLinks),
 * in which case that errand's place IS the meal and the mode is ignored.
 */
export type MealMode = 'auto' | 'home' | 'out';

/**
 * Sensible per-meal defaults: breakfast is almost always at home, while lunch
 * and dinner are left open for the planner (or the day's errands) to decide.
 */
export const DEFAULT_MEAL_MODES: Record<MealKey, MealMode> = {
  breakfast: 'home',
  lunch: 'auto',
  dinner: 'auto',
};

export const MEAL_KEYS: MealKey[] = ['breakfast', 'lunch', 'dinner'];

/**
 * DEV/TESTING planner pipeline selector:
 *   - 'v2' — the default unified compose brain (compose-itinerary).
 *   - 'v3' — the experimental multi-phase pipeline (order → locate → commute →
 *            gap-fill → re-route).
 *   - 'v4' — the isolated single grounded call (plan-day-v4) that returns the
 *            whole day (order + times + gaps + initial venue picks) in one shot.
 */
export type PlannerMode = 'v2' | 'v3' | 'v4';

/**
 * The full "how does this day look?" selection produced by the planner setup
 * drawer: the day itself, the start/end times, and the start/end locations.
 */
export interface DayPlanSelection {
  date: string;
  startTime: string;
  startLocation: LocationPin | null;
  endTime: string;
  endLocation: LocationPin | null;
  /** Per-meal dining preference for this day (breakfast/lunch/dinner). */
  mealModes: Record<MealKey, MealMode>;
  /**
   * Per-meal link to one of the user's errands (its id) when a dining errand
   * covers that meal — the errand's place becomes the meal. `null` ⇒ unlinked
   * (the mealModes preference applies instead).
   */
  mealLinks: Record<MealKey, string | null>;
}

interface PlanSetupState {
  /** The day the user is planning, "YYYY-MM-DD". */
  date: string;
  /** The time the day starts, "HH:MM" 24h. */
  startTime: string;
  /** Where the day starts. Defaults (in the drawer) to the live GPS location. */
  startLocation: LocationPin | null;
  /** The time the day should wrap up, "HH:MM" 24h. */
  endTime: string;
  /** Where the day ends. Defaults (in the drawer) to home. */
  endLocation: LocationPin | null;
  /** Configurable default start-of-day, used to seed non-today days. */
  dayStartTime: string;
  /**
   * Configurable default end-of-day, seeded from the profile's wind-down (else
   * bed) time so the planner's "finish by" reflects the user's evening instead
   * of a hardcoded 21:00.
   */
  dayEndTime: string;
  /**
   * Whether the user's car is available for THIS day's plan. Only meaningful
   * when the profile says they have a car. Defaults to true so the planner may
   * use it when helpful; the user can switch it off per day (e.g. a night out).
   */
  useCarToday: boolean;
  /**
   * DEV/TESTING: which planning pipeline to run from the planner drawer.
   * Selected by a small segmented control; persisted so a tester keeps their
   * choice across runs. Default 'v2' (the shipping unified compose brain).
   */
  plannerMode: PlannerMode;
  /** Per-meal dining preference for the day being planned. */
  mealModes: Record<MealKey, MealMode>;
  /** Per-meal link to a covering dining errand (its id), or null when unlinked. */
  mealLinks: Record<MealKey, string | null>;

  /** Persist a confirmed day + start time from the planner setup drawer. */
  setSelection: (date: string, startTime: string) => void;
  /** Persist the full day plan (day, start/end times, start/end locations). */
  setDayPlan: (selection: DayPlanSelection) => void;
  /**
   * Drop a confirmed meal link to a specific errand (any meal it covers). Called
   * when the user unticks that errand from the plan, so it stops standing in for
   * its meal once it's no longer folded in.
   */
  clearMealLinksForErrand: (errandId: string) => void;
  /** Update the default day-start time (used for future days). */
  setDayStartTime: (hhmm: string) => void;
  /** Update the default day-end time (synced from the profile). */
  setDayEndTime: (hhmm: string) => void;
  /** Toggle whether the car is in play for the day being planned. */
  setUseCarToday: (useCar: boolean) => void;
  /** Pick which planning pipeline to run (dev/testing selector). */
  setPlannerMode: (mode: PlannerMode) => void;
}

/**
 * Tiny persisted store holding the user's most recent "when am I planning?"
 * selection from the day-picker drawer. Kept separate from the day/itinerary
 * stores so the choice survives across plans and app launches, and so the
 * homepage + button and the itinerary screen can read/write the same value.
 */
export const usePlanSetupStore = create<PlanSetupState>()(
  persist(
    (set) => ({
      date: todayISO(),
      startTime: roundedNowHHMM(),
      startLocation: null,
      endTime: DEFAULT_DAY_END_TIME,
      endLocation: null,
      dayStartTime: DEFAULT_DAY_START_TIME,
      dayEndTime: DEFAULT_DAY_END_TIME,
      useCarToday: true,
      plannerMode: 'v2',
      mealModes: { ...DEFAULT_MEAL_MODES },
      mealLinks: { breakfast: null, lunch: null, dinner: null },
      setSelection: (date, startTime) => set({ date, startTime }),
      setDayPlan: (selection) =>
        set({
          date: selection.date,
          startTime: selection.startTime,
          startLocation: selection.startLocation,
          endTime: selection.endTime,
          endLocation: selection.endLocation,
          mealModes: selection.mealModes,
          mealLinks: selection.mealLinks,
        }),
      clearMealLinksForErrand: (errandId) =>
        set((s) => {
          // No-op (and a stable reference) when this errand covered no meal, so
          // unticking ordinary errands never churns the meal links.
          if (!MEAL_KEYS.some((meal) => s.mealLinks[meal] === errandId)) return {};
          const cleared = { ...s.mealLinks };
          for (const meal of MEAL_KEYS) {
            if (cleared[meal] === errandId) cleared[meal] = null;
          }
          return { mealLinks: cleared };
        }),
      setDayStartTime: (dayStartTime) => set({ dayStartTime }),
      setDayEndTime: (dayEndTime) =>
        set((s) => ({
          dayEndTime,
          // Upgrade the live selection too, but only while it's still the
          // factory default — never clobber an end the user explicitly picked.
          endTime: s.endTime === DEFAULT_DAY_END_TIME ? dayEndTime : s.endTime,
        })),
      setUseCarToday: (useCarToday) => set({ useCarToday }),
      setPlannerMode: (plannerMode) => set({ plannerMode }),
    }),
    {
      name: 'dayflow.plan-setup.v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
