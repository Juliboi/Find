import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import {
  Stack,
  useRootNavigationState,
  useRouter,
  useSegments,
} from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Animated, { FadeOut } from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { useAuthStore } from '@/store/useAuthStore';

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
        : inAuth || inOnboarding
          ? '/'
          : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  return ready && target === null;
}

function Splash() {
  const t = useTheme();
  return (
    <Animated.View
      exiting={FadeOut.duration(280)}
      style={[styles.splash, { backgroundColor: t.colors.background }]}
      pointerEvents="auto"
    >
      <View style={[styles.splashLogo, { backgroundColor: t.colors.accentSoft }]}>
        <Ionicons name="sunny" size={40} color={t.colors.accentText} />
      </View>
      <Text variant="title2" weight="heavy" tight>
        DayFlow
      </Text>
      <ActivityIndicator color={t.colors.accent} style={{ marginTop: 12 }} />
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
            <Stack.Screen
              name="add"
              options={{
                presentation: 'modal',
                animation: 'slide_from_bottom',
                contentStyle: { backgroundColor: colors.background },
              }}
            />
            <Stack.Screen name="itinerary" />
          </Stack>
          {!settled ? <Splash /> : null}
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
    gap: 12,
  },
  splashLogo: {
    width: 92,
    height: 92,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
});
