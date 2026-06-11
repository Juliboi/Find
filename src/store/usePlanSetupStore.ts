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
   * Whether the user's car is available for THIS day's plan. Only meaningful
   * when the profile says they have a car. Defaults to true so the planner may
   * use it when helpful; the user can switch it off per day (e.g. a night out).
   */
  useCarToday: boolean;

  /** Persist a confirmed day + start time from the planner setup drawer. */
  setSelection: (date: string, startTime: string) => void;
  /** Persist the full day plan (day, start/end times, start/end locations). */
  setDayPlan: (selection: DayPlanSelection) => void;
  /** Update the default day-start time (used for future days). */
  setDayStartTime: (hhmm: string) => void;
  /** Toggle whether the car is in play for the day being planned. */
  setUseCarToday: (useCar: boolean) => void;
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
      useCarToday: true,
      setSelection: (date, startTime) => set({ date, startTime }),
      setDayPlan: (selection) =>
        set({
          date: selection.date,
          startTime: selection.startTime,
          startLocation: selection.startLocation,
          endTime: selection.endTime,
          endLocation: selection.endLocation,
        }),
      setDayStartTime: (dayStartTime) => set({ dayStartTime }),
      setUseCarToday: (useCarToday) => set({ useCarToday }),
    }),
    {
      name: 'dayflow.plan-setup.v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
