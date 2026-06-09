import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Local mirror of the user's profile preferences gathered during onboarding.
 *
 * The authoritative copy lives in the `profiles` table (synced via
 * `useAuthStore`), but we cache the day-to-day planning inputs here so the rest
 * of the app can read them synchronously, offline, and without a round-trip —
 * the same way `useHomeStore` caches the home anchor.
 */
interface ProfileState {
  fullName: string | null;
  /** "HH:MM" 24h — when the user's day starts. */
  wakeTime: string | null;
  /** "HH:MM" 24h — when the user wants to be done for the day. */
  bedTime: string | null;
  /** Whether the user has a car (drives default travel mode later). */
  hasCar: boolean;
  /** Mirror of profiles.onboarding_completed for snappy launch gating. */
  onboardingComplete: boolean;

  hydrate: (next: Partial<Omit<ProfileState, 'hydrate' | 'reset'>>) => void;
  reset: () => void;
}

const EMPTY = {
  fullName: null,
  wakeTime: null,
  bedTime: null,
  hasCar: false,
  onboardingComplete: false,
} as const;

export const useProfileStore = create<ProfileState>()(
  persist(
    (set) => ({
      ...EMPTY,
      hydrate: (next) => set((s) => ({ ...s, ...next })),
      reset: () => set({ ...EMPTY }),
    }),
    {
      name: 'dayflow.profile.v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        fullName: s.fullName,
        wakeTime: s.wakeTime,
        bedTime: s.bedTime,
        hasCar: s.hasCar,
        onboardingComplete: s.onboardingComplete,
      }),
    },
  ),
);
