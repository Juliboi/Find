import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  cancelDailyReview,
  ensureNotificationPermission,
  scheduleDailyReview,
} from '@/lib/notifications';

/**
 * Default fire time for the evening "review + plan tomorrow" nudge — late
 * enough that the day is mostly done, early enough to still act on it.
 */
export const DEFAULT_DAILY_REVIEW_TIME = '21:00';

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
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);
