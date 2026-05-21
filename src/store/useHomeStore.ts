import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface LocationPin {
  /** Human-readable label, e.g. "Home", "Pařížská 30, Praha". */
  label: string;
  latitude: number;
  longitude: number;
}

interface HomeState {
  /** Where the user lives — primary anchor for planning. */
  home: LocationPin | null;
  /**
   * Where the user wants to finish their day. Defaults to home. Can be
   * overridden per-day (we still persist this so the next day starts with
   * the user's last preference).
   */
  endOfDay: LocationPin | null;

  setHome: (pin: LocationPin) => void;
  setEndOfDay: (pin: LocationPin | null) => void;
  clearHome: () => void;
}

/**
 * Tiny persisted store for the user's anchor locations. Separated from
 * `useDayStore` so that home survives across day resets.
 */
export const useHomeStore = create<HomeState>()(
  persist(
    (set, get) => ({
      home: null,
      endOfDay: null,
      setHome: (home) =>
        set({ home, endOfDay: get().endOfDay ?? home }),
      setEndOfDay: (endOfDay) => set({ endOfDay }),
      clearHome: () => set({ home: null, endOfDay: null }),
    }),
    {
      name: 'dayflow.home-store.v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/**
 * Returns the resolved end-of-day location. Falls back to `home` when no
 * explicit end has been set for the current day.
 */
export function selectEndOfDay(s: {
  home: LocationPin | null;
  endOfDay: LocationPin | null;
}): LocationPin | null {
  return s.endOfDay ?? s.home;
}
