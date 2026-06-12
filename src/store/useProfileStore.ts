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
  /** Minutes the user takes to fully wake up before focused/productive time. */
  wakeUpDurationMin: number;
  /** "HH:MM" comfortable meal windows (null until onboarding sets them). */
  breakfastStart: string | null;
  breakfastEnd: string | null;
  lunchStart: string | null;
  lunchEnd: string | null;
  dinnerStart: string | null;
  dinnerEnd: string | null;
  /** "HH:MM" after which the planner sticks to calm, sleep-friendly activities. */
  windDownTime: string | null;
  /** Whether screen-heavy wind-down activities are acceptable near bedtime. */
  allowScreenWindDown: boolean;
  /** Whether the user owns/has access to a car (availability, not "always"). */
  hasCar: boolean;
  /** Canonical dietary tags chosen during onboarding. */
  dietary: string[];
  /** Freeform dietary notes / allergies. */
  dietaryNotes: string | null;
  /** Mirror of profiles.onboarding_completed for snappy launch gating. */
  onboardingComplete: boolean;

  hydrate: (next: Partial<Omit<ProfileState, 'hydrate' | 'reset'>>) => void;
  reset: () => void;
}

const EMPTY = {
  fullName: null,
  wakeTime: null,
  bedTime: null,
  wakeUpDurationMin: 30,
  breakfastStart: null,
  breakfastEnd: null,
  lunchStart: null,
  lunchEnd: null,
  dinnerStart: null,
  dinnerEnd: null,
  windDownTime: null,
  allowScreenWindDown: false,
  hasCar: false,
  dietary: [] as string[],
  dietaryNotes: null,
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
        wakeUpDurationMin: s.wakeUpDurationMin,
        breakfastStart: s.breakfastStart,
        breakfastEnd: s.breakfastEnd,
        lunchStart: s.lunchStart,
        lunchEnd: s.lunchEnd,
        dinnerStart: s.dinnerStart,
        dinnerEnd: s.dinnerEnd,
        windDownTime: s.windDownTime,
        allowScreenWindDown: s.allowScreenWindDown,
        hasCar: s.hasCar,
        dietary: s.dietary,
        dietaryNotes: s.dietaryNotes,
        onboardingComplete: s.onboardingComplete,
      }),
    },
  ),
);
