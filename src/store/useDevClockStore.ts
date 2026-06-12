import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * DEV-ONLY fake clock — a "time machine" for testing plans.
 *
 * Lets us pin the whole app to an arbitrary instant (e.g. 9 AM on a weekday)
 * so we can rehearse a plan as if it were that time: shops open, a full day
 * ahead, realistic transit — instead of whatever the real wall clock says at
 * 11 PM. Everything time-sensitive reads `devNow()` instead of `new Date()`.
 *
 * The pinned time is stored *relative* to the real clock (an anchor pair), so
 * once set it keeps ticking forward naturally rather than freezing — the "now"
 * line still moves while you test. Reset snaps back to real time.
 *
 * The control surface is gated behind `__DEV__` in Settings. In production the
 * store stays disabled and `devNow()` is a plain passthrough to `new Date()`.
 */
interface DevClockState {
  /** When true, devNow() returns the simulated time. */
  enabled: boolean;
  /** Real epoch-ms captured the moment the fake time was pinned. */
  anchorRealMs: number | null;
  /** Fake epoch-ms the user pinned (aligned to anchorRealMs). */
  anchorFakeMs: number | null;
  /** Pin the clock to `date` and switch the simulation on. */
  setFakeNow: (date: Date) => void;
  /** Flip the simulation on/off without losing the pinned instant. */
  setEnabled: (on: boolean) => void;
  /** Drop the simulation entirely and snap back to real time. */
  reset: () => void;
}

export const useDevClockStore = create<DevClockState>()(
  persist(
    (set) => ({
      enabled: false,
      anchorRealMs: null,
      anchorFakeMs: null,
      setFakeNow: (date) =>
        set({
          enabled: true,
          anchorRealMs: Date.now(),
          anchorFakeMs: date.getTime(),
        }),
      setEnabled: (on) => set({ enabled: on }),
      reset: () =>
        set({ enabled: false, anchorRealMs: null, anchorFakeMs: null }),
    }),
    {
      name: 'dayflow.devclock.v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/**
 * The app's notion of "now". Identical to `new Date()` in production and
 * whenever the dev clock is off. When the dev clock is on it returns the
 * simulated instant, advancing in real time from the pinned anchor so the
 * clock keeps moving while you test.
 *
 * Read this anywhere the app needs the current time (date selection, the live
 * "now" marker, the planner's start time, business open/closed checks) so the
 * fake clock reaches every corner uniformly.
 */
export function devNow(): Date {
  const { enabled, anchorRealMs, anchorFakeMs } = useDevClockStore.getState();
  if (!enabled || anchorRealMs == null || anchorFakeMs == null) {
    return new Date();
  }
  return new Date(anchorFakeMs + (Date.now() - anchorRealMs));
}
