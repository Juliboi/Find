import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import {
  Stack,
  useGlobalSearchParams,
  useRootNavigationState,
  useRouter,
  useSegments,
} from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Animated, { FadeOut } from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { WaveLoader } from '@/components/WaveLoader';
import { useAuthStore } from '@/store/useAuthStore';
import { useNotificationStore } from '@/store/useNotificationStore';
import {
  activePlanForDate,
  useSavedItineraries,
  type SavedItinerary,
} from '@/store/useSavedItineraries';
import {
  configureNotifications,
  isDailyReviewResponse,
  isPlanReadyResponse,
  isPlanReminderResponse,
  planReadySavedId,
  planReminderSavedId,
  schedulePlanReminders,
} from '@/lib/notifications';
import { todayISO, tomorrowISO } from '@/utils/time';
import { InAppNotification } from '@/components/InAppNotification';

// Hold the native splash until React has painted our themed splash overlay, so
// the home screen can't flash through before the first auth redirect lands.
void SplashScreen.preventAutoHideAsync();

/**
 * Drives the auth/onboarding redirects. Lives inside the navigation tree so it
 * can read the active route via `useSegments` and bounce the user to the right
 * place: signed-out → /auth, signed-in-but-new → /onboarding, otherwise the app.
 *
 * Returns whether the gate has resolved AND the current route already matches
 * the destination, so the caller can keep a splash up and avoid flashing the
 * wrong screen for a frame mid-redirect.
 */
function useAuthGate(): boolean {
  const segments = useSegments();
  const params = useGlobalSearchParams<{ edit?: string }>();
  const router = useRouter();
  const navState = useRootNavigationState();
  const status = useAuthStore((s) => s.status);
  const needsOnboarding = useAuthStore((s) => s.needsOnboarding);
  const profileLoaded = useAuthStore((s) => s.profileLoaded);

  // Don't attempt a redirect until the root navigator is actually mounted,
  // otherwise expo-router throws "navigate before mounting the Root Layout".
  const navReady = navState?.key != null;
  const ready =
    navReady &&
    status !== 'loading' &&
    (status === 'signedOut' || profileLoaded);

  const seg0 = segments[0];
  const inAuth = seg0 === 'auth';
  const inOnboarding = seg0 === 'onboarding';
  // Settings opens onboarding with `?edit=<key>` to tweak a single preference
  // after onboarding is done — keep the gate from bouncing that back to home.
  const editingPrefs =
    inOnboarding && typeof params.edit === 'string' && params.edit.length > 0;

  const target: '/auth' | '/onboarding' | '/' | null = !ready
    ? null
    : status === 'signedOut'
      ? inAuth
        ? null
        : '/auth'
      : needsOnboarding
        ? inOnboarding
          ? null
          : '/onboarding'
        : inAuth || (inOnboarding && !editingPrefs)
          ? '/'
          : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  return ready && target === null;
}

/**
 * Wires up local notifications at the app root: configure the channel/handler
 * once, re-assert the saved daily-review schedule after prefs rehydrate, and
 * route a tap on the reminder to the home screen — where it opens the planner
 * seeded to tomorrow (see app/index.tsx).
 */
function useNotificationsBootstrap(): void {
  const router = useRouter();
  const notifHydrated = useNotificationStore((s) => s.hydrated);
  const planRemindersMode = useNotificationStore((s) => s.planRemindersMode);
  const savedItems = useSavedItineraries((s) => s.items);

  useEffect(() => {
    void configureNotifications();
  }, []);

  useEffect(() => {
    if (notifHydrated) void useNotificationStore.getState().reconcile();
  }, [notifHydrated]);

  // Keep per-plan reminders in sync with the user's choice AND the active plans
  // for today/tomorrow. `schedulePlanReminders` is idempotent (it clears the
  // old set first) and silently no-ops without permission or when off, so we
  // can safely re-run it on every relevant change. Debounced so a burst of
  // store updates (e.g. the initial remote sync) only reschedules once.
  useEffect(() => {
    if (!notifHydrated) return;
    const handle = setTimeout(() => {
      const plans = [
        activePlanForDate(savedItems, todayISO()),
        activePlanForDate(savedItems, tomorrowISO()),
      ].filter((p): p is SavedItinerary => p != null);
      void schedulePlanReminders(plans, planRemindersMode);
    }, 800);
    return () => clearTimeout(handle);
  }, [notifHydrated, planRemindersMode, savedItems]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        if (isDailyReviewResponse(response)) {
          router.navigate('/');
          return;
        }
        // A per-plan reminder: open the plan it belongs to when we know its id,
        // else fall back to home.
        if (isPlanReminderResponse(response)) {
          const savedId = planReminderSavedId(response);
          if (savedId) {
            router.navigate({ pathname: '/itinerary', params: { id: savedId } });
          } else {
            router.navigate('/');
          }
          return;
        }
        // A finished-plan push: open straight to the built day when we know
        // its id, otherwise just surface the home screen where the card lives.
        if (isPlanReadyResponse(response)) {
          const savedId = planReadySavedId(response);
          if (savedId) {
            router.navigate({ pathname: '/itinerary', params: { id: savedId } });
          } else {
            router.navigate('/');
          }
        }
      },
    );
    return () => sub.remove();
  }, [router]);
}

function Splash() {
  const t = useTheme();
  return (
    <Animated.View
      exiting={FadeOut.duration(280)}
      style={[styles.splash, { backgroundColor: t.colors.background }]}
      pointerEvents="auto"
    >
      <WaveLoader width={236} height={128} />
      <Text variant="title2" weight="heavy" tight style={styles.splashTitle}>
        Diem
      </Text>
    </Animated.View>
  );
}

export default function RootLayout() {
  const { colors, scheme } = useTheme();

  useEffect(() => {
    void useAuthStore.getState().init();
  }, []);

  // The themed splash overlay is painted on the first commit, so it's safe to
  // drop the native splash now — the overlay takes over without a gap.
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  useNotificationsBootstrap();

  const settled = useAuthGate();

  return (
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
              animation: 'slide_from_right',
            }}
          >
            <Stack.Screen
              name="auth"
              options={{ animation: 'none', gestureEnabled: false }}
            />
            <Stack.Screen
              name="onboarding"
              options={{ animation: 'none', gestureEnabled: false }}
            />
            <Stack.Screen name="index" />
            <Stack.Screen name="settings" />
            <Stack.Screen name="people" />
            <Stack.Screen name="recurring-errands" />
            <Stack.Screen
              name="add"
              options={{
                presentation: 'modal',
                animation: 'slide_from_bottom',
                contentStyle: { backgroundColor: colors.background },
              }}
            />
            <Stack.Screen name="itinerary" />
            <Stack.Screen name="day-plans" />
            <Stack.Screen name="day-calendar" />
            <Stack.Screen
              name="discover-sandbox"
              options={{
                presentation: 'modal',
                animation: 'slide_from_bottom',
                contentStyle: { backgroundColor: colors.background },
              }}
            />
          </Stack>
          {!settled ? <Splash /> : null}
          <InAppNotification />
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  splash: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashTitle: {
    marginTop: -8,
  },
});
