import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  cancelDailyReview,
  ensureNotificationPermission,
  scheduleDailyReview,
  type PlanRemindersMode,
} from '@/lib/notifications';

/**
 * Default fire time for the evening "review + plan tomorrow" nudge — late
 * enough that the day is mostly done, early enough to still act on it.
 */
export const DEFAULT_DAILY_REVIEW_TIME = '21:00';

/**
 * Default per-plan reminder behaviour for new users. 'smart' mirrors the
 * headline of the onboarding step — a timed heads-up before every upcoming
 * stop — and only ever fires once notification permission is granted.
 */
export const DEFAULT_PLAN_REMINDERS_MODE: PlanRemindersMode = 'smart';

/**
 * User-facing notification preferences. Local-first like the rest of the app:
 * the toggle + time live here (persisted), and the OS schedule is kept in sync
 * as a side effect of changing them. Only the daily review exists today; this
 * is the natural home for any future opt-in reminders.
 */
interface NotificationState {
  /** Whether the once-a-day review reminder is enabled. */
  dailyReviewEnabled: boolean;
  /** "HH:MM" 24h — when the review reminder fires. */
  dailyReviewTime: string;
  /** How eagerly we remind before upcoming stops (smart / fixed-only / off). */
  planRemindersMode: PlanRemindersMode;
  /** True once the persisted prefs have rehydrated (gates the launch sync). */
  hydrated: boolean;

  setHydrated: () => void;
  /**
   * Turn the daily review on/off. Enabling prompts for permission (if needed)
   * and schedules the reminder; returns `false` when permission was refused so
   * the UI can keep the toggle off and nudge toward system settings.
   */
  setDailyReviewEnabled: (enabled: boolean) => Promise<boolean>;
  /** Change the fire time, rescheduling when the reminder is enabled. */
  setDailyReviewTime: (time: string) => Promise<void>;
  /**
   * Choose how aggressively per-plan reminders fire. Prompts for permission
   * when switching to a notifying mode (smart/fixed) and returns whether the
   * app may now post — `false` means permission was refused, so the UI can
   * nudge toward system settings. The actual (re)scheduling is driven from the
   * app root, which reacts to this preference alongside the active plans.
   */
  setPlanRemindersMode: (mode: PlanRemindersMode) => Promise<boolean>;
  /**
   * Re-assert the OS schedule from the saved prefs (run once at launch). This
   * keeps the single daily notification alive across app updates and silently
   * flips the toggle off if the user revoked permission from system settings.
   */
  reconcile: () => Promise<void>;
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set, get) => ({
      dailyReviewEnabled: false,
      dailyReviewTime: DEFAULT_DAILY_REVIEW_TIME,
      planRemindersMode: DEFAULT_PLAN_REMINDERS_MODE,
      hydrated: false,

      setHydrated: () => set({ hydrated: true }),

      setDailyReviewEnabled: async (enabled) => {
        if (!enabled) {
          set({ dailyReviewEnabled: false });
          await cancelDailyReview();
          return false;
        }
        const granted = await ensureNotificationPermission();
        if (!granted) {
          set({ dailyReviewEnabled: false });
          return false;
        }
        await scheduleDailyReview(get().dailyReviewTime);
        set({ dailyReviewEnabled: true });
        return true;
      },

      setDailyReviewTime: async (time) => {
        set({ dailyReviewTime: time });
        if (get().dailyReviewEnabled) await scheduleDailyReview(time);
      },

      setPlanRemindersMode: async (mode) => {
        set({ planRemindersMode: mode });
        // Switching off needs nothing here — the root effect reacts to the new
        // mode and clears any scheduled reminders.
        if (mode === 'none') return true;
        // Ask up front so the prompt is tied to the user's choice; the actual
        // scheduling then runs from the root with permission in hand.
        return ensureNotificationPermission();
      },

      reconcile: async () => {
        if (!get().dailyReviewEnabled) return;
        const ok = await scheduleDailyReview(get().dailyReviewTime);
        if (!ok) set({ dailyReviewEnabled: false });
      },
    }),
    {
      name: 'dayflow.notifications.v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        dailyReviewEnabled: s.dailyReviewEnabled,
        dailyReviewTime: s.dailyReviewTime,
        planRemindersMode: s.planRemindersMode,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);
