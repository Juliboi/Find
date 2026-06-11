import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * DEV-ONLY clock override.
 *
 * Lets us pretend "now" is some other moment so we can test the planner against
 * real-world time without waiting for it: calibrate open/closed venues, plan a
 * full day from a morning start, or check the in-progress "rest of the day"
 * path — then flip back to the real clock.
 *
 * Stored as an OFFSET from the real clock (ms) rather than a frozen timestamp,
 * so the fake clock keeps TICKING naturally from the instant it was set
 * (08:00 → 08:01 → …) instead of standing still. `enabled = false` ⇒ the real
 * clock, untouched.
 *
 * Everywhere we'd otherwise call `new Date()` for planning-relevant time
 * (today's date, the current "HH:MM", the `now` we hand the planner + router)
 * reads through `devNow()` instead. It is NOT a hook — safe to call from plain
 * functions like `todayISO()`.
 *
 * The toggle is surfaced only behind `__DEV__` in Settings, so production users
 * never see it and the default (disabled) means zero behavioural change there.
 */
interface DevClockState {
  /** When true, `devNow()` returns the offset (fake) clock. */
  enabled: boolean;
  /** Real-clock offset in ms: `fakeNow = Date.now() + offsetMs`. */
  offsetMs: number;
  /** The instant the user picked (ms epoch) — seeds the picker UI on reopen. */
  anchorMs: number | null;
  /** Pretend "now" is `d` (and keep ticking from there). */
  setFakeNow: (d: Date) => void;
  /** Back to the real clock. */
  disable: () => void;
}

export const useDevClockStore = create<DevClockState>()(
  persist(
    (set) => ({
      enabled: false,
      offsetMs: 0,
      anchorMs: null,
      setFakeNow: (d) =>
        set({
          enabled: true,
          offsetMs: d.getTime() - Date.now(),
          anchorMs: d.getTime(),
        }),
      disable: () => set({ enabled: false, offsetMs: 0, anchorMs: null }),
    }),
    {
      name: 'dayflow.dev-clock.v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/**
 * The effective "now": the fake clock when the dev override is on, else the
 * real one. Read this instead of `new Date()` for any planning-relevant time.
 */
export function devNow(): Date {
  const s = useDevClockStore.getState();
  return s.enabled ? new Date(Date.now() + s.offsetMs) : new Date();
}
