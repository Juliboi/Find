import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { minutesOfDay } from '@/utils/time';

/**
 * Local notifications for Diem. Everything here is scheduled on-device — no
 * server, no push tokens — which matches the app's local-first architecture.
 *
 * For now there is a single notification: the once-a-day "review today and plan
 * tomorrow" nudge. The module is structured so additional opt-in reminders
 * (e.g. a per-plan heads-up) can be added later as their own discriminated
 * `kind` without touching the routing/handler plumbing.
 */

/** Discriminator carried in a notification's `data`, used to route taps. */
export const DAILY_REVIEW_KIND = 'daily-review';

/** Stable identifier so we can reschedule/cancel the daily nudge idempotently. */
const DAILY_REVIEW_ID = 'diem.daily-review';

/** Android delivery channel for gentle, non-urgent reminders. */
const REMINDERS_CHANNEL_ID = 'reminders';

// How a notification behaves when it fires while Diem is in the foreground.
// We still surface the banner + list entry (no sound) so the daily nudge isn't
// silently swallowed when the user happens to have the app open. Set once at
// module load, as Expo recommends.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let configured = false;

/**
 * One-time, idempotent setup. Creates the Android notification channel (a no-op
 * on iOS/web). Safe to call on every launch.
 */
export async function configureNotifications(): Promise<void> {
  if (configured || Platform.OS === 'web') return;
  configured = true;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(REMINDERS_CHANNEL_ID, {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
    }).catch(() => undefined);
  }
}

/**
 * Prompt for notification permission when it hasn't been decided yet. Returns
 * whether the app may now post notifications. Never re-prompts once the user
 * has explicitly denied (iOS only shows the system prompt once); the caller
 * should point them at system settings in that case.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const next = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return next.granted;
}

/**
 * (Re)schedule the daily "review + plan tomorrow" reminder to fire every day at
 * `time` ("HH:MM"). Cancels any existing copy first so the schedule stays
 * deterministic and never stacks duplicates. Does NOT prompt — returns `false`
 * when permission isn't already granted (or the time is unparseable), so the
 * caller can decide whether to ask. On iOS the DAILY trigger maps to a
 * repeating calendar trigger automatically.
 */
export async function scheduleDailyReview(time: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const mins = minutesOfDay(time);
  if (mins == null) return false;
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) return false;

  await cancelDailyReview();
  await Notifications.scheduleNotificationAsync({
    identifier: DAILY_REVIEW_ID,
    content: {
      title: 'Plan tomorrow',
      body: 'Take a minute to add any errands and set up your day so tomorrow is ready to go.',
      data: { kind: DAILY_REVIEW_KIND },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: Math.floor(mins / 60),
      minute: mins % 60,
      channelId: REMINDERS_CHANNEL_ID,
    },
  });
  return true;
}

/** Tear down the daily reminder (when the user turns it off). */
export async function cancelDailyReview(): Promise<void> {
  if (Platform.OS === 'web') return;
  await Notifications.cancelScheduledNotificationAsync(DAILY_REVIEW_ID).catch(
    () => undefined,
  );
}

/** True when a tapped notification is the daily review nudge. */
export function isDailyReviewResponse(
  response: Notifications.NotificationResponse | null | undefined,
): boolean {
  return (
    response?.notification.request.content.data?.kind === DAILY_REVIEW_KIND
  );
}
