import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { formatTime, minutesOfDay } from '@/utils/time';
import type { SavedItinerary } from '@/store/useSavedItineraries';
import type { ItineraryItem } from '@/types/itinerary';

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

/**
 * Discriminator for the "your plan finished building" nudge. Fired from the
 * device the moment a backgrounded plan job resolves (see usePlanJobsStore) —
 * the in-app toast covers the foreground case, so this only ever shows when
 * Diem isn't the active app.
 */
export const PLAN_READY_KIND = 'plan-ready';

/**
 * Discriminator for a per-item "what's next" heads-up scheduled ahead of an
 * upcoming stop in the active plan. How aggressively these fire is governed by
 * the user's {@link PlanRemindersMode} preference (smart / fixed-only / off).
 */
export const PLAN_REMINDER_KIND = 'plan-reminder';

/**
 * How eagerly Diem reminds the user before upcoming stops in their plan:
 *   - 'smart' : a heads-up before every upcoming item, timed off any travel
 *               leg so the nudge lands when it's actually time to head out.
 *   - 'fixed' : only the day's hard commitments (`flexibility === 'fixed'`) —
 *               meetings, reservations, timed events.
 *   - 'none'  : no per-plan reminders at all.
 */
export type PlanRemindersMode = 'smart' | 'fixed' | 'none';

/** Stable identifier so we can reschedule/cancel the daily nudge idempotently. */
const DAILY_REVIEW_ID = 'diem.daily-review';

/** Prefix for per-item plan reminder identifiers (one per scheduled stop). */
const PLAN_REMINDER_ID_PREFIX = 'diem.plan-reminder.';

/**
 * Upper bound on how many plan reminders we keep scheduled at once. iOS caps a
 * single app at 64 pending local notifications, so we stay well under that
 * (the daily review takes one slot) and only ever schedule the soonest stops.
 */
const MAX_PLAN_REMINDERS = 32;

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

/**
 * Minutes ahead of an item's start that its reminder should fire. "Smart": when
 * the stop carries a travel leg we lead by the journey time plus a small buffer
 * so the nudge means "head out now"; otherwise a gentle fixed lead so it reads
 * as "coming up".
 */
function planReminderLeadMinutes(item: ItineraryItem): number {
  const travel = item.travelFromPrev?.minutes ?? 0;
  return travel > 0 ? Math.round(travel) + 5 : 15;
}

/** Build a local Date from a plan's "YYYY-MM-DD" + an item's "HH:MM", or null. */
function itemStartDate(
  dateISO: string | undefined,
  startTime: string | undefined,
): Date | null {
  if (!dateISO || !startTime) return null;
  const mins = minutesOfDay(startTime);
  const [y, m, d] = dateISO.split('-').map(Number);
  if (
    mins == null ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d)
  ) {
    return null;
  }
  return new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60, 0, 0);
}

/** A stop worth reminding about (skips travel legs, elastic gaps, arrivals). */
function isRemindableItem(item: ItineraryItem, mode: PlanRemindersMode): boolean {
  if (item.arrival) return false;
  if (item.kind === 'travel' || item.kind === 'gap') return false;
  if (mode === 'fixed') return item.flexibility === 'fixed';
  return true;
}

function planReminderBody(item: ItineraryItem): string {
  const at = item.startTime ? formatTime(item.startTime) : null;
  const hasTravel = (item.travelFromPrev?.minutes ?? 0) > 0;
  if (hasTravel && at) return `Time to head out — starts at ${at}.`;
  if (at) return `Coming up at ${at}.`;
  return 'Coming up next in your day.';
}

/**
 * Cancel every scheduled plan reminder, leaving the daily review (and any other
 * kind) untouched. We match on the `data.kind` carried by each notification
 * rather than tracking ids, so a stale plan's reminders are always swept even
 * across app restarts.
 */
export async function cancelPlanReminders(): Promise<void> {
  if (Platform.OS === 'web') return;
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(
    () => [] as Notifications.NotificationRequest[],
  );
  await Promise.all(
    scheduled
      .filter((n) => n.content.data?.kind === PLAN_REMINDER_KIND)
      .map((n) =>
        Notifications.cancelScheduledNotificationAsync(n.identifier).catch(
          () => undefined,
        ),
      ),
  );
}

/**
 * (Re)schedule per-item reminders for the given active plans according to
 * `mode`. Always clears the previous set first so the schedule is deterministic
 * and never stacks duplicates. Does NOT prompt — silently no-ops when the mode
 * is 'none' or permission isn't already granted, so the caller decides when to
 * ask. Only future stops (more than ~30s out) are scheduled, soonest first, up
 * to {@link MAX_PLAN_REMINDERS}.
 */
export async function schedulePlanReminders(
  plans: SavedItinerary[],
  mode: PlanRemindersMode,
): Promise<void> {
  if (Platform.OS === 'web') return;
  await cancelPlanReminders();
  if (mode === 'none') return;
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) return;

  const now = Date.now();
  const candidates: { fireAt: Date; item: ItineraryItem; savedId: string }[] = [];
  for (const plan of plans) {
    const date = plan.itinerary.date ?? plan.date;
    for (const section of plan.itinerary.sections) {
      for (const item of section.items) {
        if (!isRemindableItem(item, mode)) continue;
        const start = itemStartDate(date, item.startTime);
        if (!start) continue;
        const fireAt = new Date(
          start.getTime() - planReminderLeadMinutes(item) * 60_000,
        );
        // Skip anything already past (or basically now) — DATE triggers in the
        // past either fire instantly or get rejected by the OS.
        if (fireAt.getTime() <= now + 30_000) continue;
        candidates.push({ fireAt, item, savedId: plan.id });
      }
    }
  }

  candidates.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());

  for (const { fireAt, item, savedId } of candidates.slice(0, MAX_PLAN_REMINDERS)) {
    await Notifications.scheduleNotificationAsync({
      identifier: `${PLAN_REMINDER_ID_PREFIX}${savedId}.${item.id}`,
      content: {
        title: item.title,
        body: planReminderBody(item),
        data: { kind: PLAN_REMINDER_KIND, savedId },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
        channelId: REMINDERS_CHANNEL_ID,
      },
    }).catch(() => undefined);
  }
}

/** True when a tapped notification is a per-item plan reminder. */
export function isPlanReminderResponse(
  response: Notifications.NotificationResponse | null | undefined,
): boolean {
  return (
    response?.notification.request.content.data?.kind === PLAN_REMINDER_KIND
  );
}

/** The saved itinerary id a plan reminder belongs to, so a tap can open it. */
export function planReminderSavedId(
  response: Notifications.NotificationResponse | null | undefined,
): string | undefined {
  if (!isPlanReminderResponse(response)) return undefined;
  const id = response?.notification.request.content.data?.savedId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Immediately deliver a "your plan is ready" notification. Used by the plan
 * job runner when a day finishes building while Diem is backgrounded (the
 * foreground case is handled by the in-app toast instead, so the two never
 * double up). Requests permission if it hasn't been decided yet, then posts
 * with a `null` trigger so the OS shows it right away. Carries the saved
 * itinerary id in `data` so a tap can open straight to the finished day.
 */
export async function notifyPlanReady(opts: {
  title: string;
  savedId?: string;
}): Promise<void> {
  if (Platform.OS === 'web') return;
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  const name = opts.title.trim() || 'Your day plan';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${name} is ready`,
      body: 'Your day is all mapped out — tap to take a look.',
      data: { kind: PLAN_READY_KIND, savedId: opts.savedId },
    },
    // `null` fires it right away. Android falls back to its default channel
    // for immediate posts, which is fine for a one-off "it's done" nudge.
    trigger: null,
  }).catch(() => undefined);
}

/** True when a tapped notification is a finished-plan nudge. */
export function isPlanReadyResponse(
  response: Notifications.NotificationResponse | null | undefined,
): boolean {
  return response?.notification.request.content.data?.kind === PLAN_READY_KIND;
}

/**
 * The saved itinerary id carried by a finished-plan notification, if any, so
 * the tap handler can route straight to the built day.
 */
export function planReadySavedId(
  response: Notifications.NotificationResponse | null | undefined,
): string | undefined {
  if (!isPlanReadyResponse(response)) return undefined;
  const id = response?.notification.request.content.data?.savedId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
