import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { todayISO } from '@/utils/time';
import { roundedNowHHMM } from '@/utils/days';

/**
 * Default "day start" time used to seed the time selector for any day that
 * ISN'T today. Picking today seeds the selector to the current time instead
 * (you can't start a day in the past), but a future day has no "now" to anchor
 * to — so it falls back to this sensible morning start.
 */
export const DEFAULT_DAY_START_TIME = '09:00';

interface PlanSetupState {
  /** The day the user is planning, "YYYY-MM-DD". */
  date: string;
  /** The time the day starts, "HH:MM" 24h. */
  startTime: string;
  /** Configurable default start-of-day, used to seed non-today days. */
  dayStartTime: string;

  /** Persist a confirmed day + start time from the planner setup drawer. */
  setSelection: (date: string, startTime: string) => void;
  /** Update the default day-start time (used for future days). */
  setDayStartTime: (hhmm: string) => void;
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
      dayStartTime: DEFAULT_DAY_START_TIME,
      setSelection: (date, startTime) => set({ date, startTime }),
      setDayStartTime: (dayStartTime) => set({ dayStartTime }),
    }),
    {
      name: 'dayflow.plan-setup.v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
