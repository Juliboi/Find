import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { BottomSheetView } from '@gorhom/bottom-sheet';
import Animated, {
  Easing,
  FadeInDown,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from '@/components/Text';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Sheet } from '@/components/Sheet';
import { GradientWave } from '@/components/GradientWave';
import { useAuthStore } from '@/store/useAuthStore';

type EmailMode = 'signIn' | 'signUp';
type Busy = 'apple' | 'email' | null;

/** Apple throws this when the user dismisses the sheet — not a real error. */
function isAppleCancel(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err != null &&
    'code' in err &&
    (err as { code?: string }).code === 'ERR_REQUEST_CANCELED'
  );
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

/** Marketing one-liners that cycle in the hero to pitch the app. */
const HEADLINES = [
  'Plan your perfect day.',
  'Discover places you\u2019ll love.',
  'From first coffee to last call.',
  'Your city, perfectly scheduled.',
  'Less planning, more living.',
];

/**
 * A headline that smoothly cross-fades through the taglines above.
 *
 * Two fixed layers (A/B) are always mounted; a single shared value `t`
 * ping-pongs 0<->1 to drive the crossfade. The currently visible layer's text
 * is NEVER mutated mid-animation — we only swap text into the hidden layer once
 * the transition has fully finished (when its opacity is 0). That removes the
 * one-frame "blink" you get from resetting an animation while React is still
 * committing new text.
 */
function RotatingHeadline() {
  const [slots, setSlots] = useState<[string, string]>([
    HEADLINES[0],
    HEADLINES[1 % HEADLINES.length],
  ]);
  const frontRef = useRef<0 | 1>(0);
  const loadedRef = useRef(1);
  const t = useSharedValue(0);

  useEffect(() => {
    const loadNextIntoHidden = () => {
      const hidden: 0 | 1 = frontRef.current === 0 ? 1 : 0;
      const nextIndex = (loadedRef.current + 1) % HEADLINES.length;
      loadedRef.current = nextIndex;
      setSlots((prev) => {
        const next: [string, string] = [prev[0], prev[1]];
        next[hidden] = HEADLINES[nextIndex];
        return next;
      });
    };

    const id = setInterval(() => {
      const target: 0 | 1 = frontRef.current === 0 ? 1 : 0;
      frontRef.current = target;
      t.value = withTiming(
        target,
        { duration: 760, easing: Easing.inOut(Easing.cubic) },
        (finished) => {
          if (finished) {
            runOnJS(loadNextIntoHidden)();
          }
        },
      );
    }, 3400);
    return () => clearInterval(id);
  }, [t]);

  const aStyle = useAnimatedStyle(() => ({
    opacity: 1 - t.value,
    transform: [{ translateY: interpolate(t.value, [0, 1], [0, -18]) }],
  }));

  const bStyle = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ translateY: interpolate(t.value, [0, 1], [18, 0]) }],
  }));

  return (
    <View style={styles.headline} pointerEvents="none">
      <Animated.View style={[styles.headlineItem, aStyle]}>
        <Text variant="title1" weight="regular" tight style={styles.headlineText}>
          {slots[0]}
        </Text>
      </Animated.View>
      <Animated.View style={[styles.headlineItem, bStyle]}>
        <Text variant="title1" weight="regular" tight style={styles.headlineText}>
          {slots[1]}
        </Text>
      </Animated.View>
    </View>
  );
}

export default function AuthScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const headerHeight = Math.round(winH * 1.2);

  const appleAvailable = useAuthStore((s) => s.appleAuthAvailable);
  const signInWithApple = useAuthStore((s) => s.signInWithApple);
  const signInWithEmail = useAuthStore((s) => s.signInWithEmail);
  const signUpWithEmail = useAuthStore((s) => s.signUpWithEmail);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [mode, setMode] = useState<EmailMode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const openSheet = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setError(null);
    setNotice(null);
    setSheetOpen(true);
  };

  const handleApple = async () => {
    setError(null);
    setNotice(null);
    setBusy('apple');
    try {
      await signInWithApple();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      // The auth gate redirects once the session lands.
    } catch (err) {
      if (!isAppleCancel(err)) {
        setError(messageOf(err, 'Apple sign-in failed. Please try again.'));
      }
    } finally {
      setBusy(null);
    }
  };

  const handleEmail = async () => {
    const e = email.trim();
    if (!e || !e.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setError(null);
    setNotice(null);
    setBusy('email');
    try {
      if (mode === 'signUp') {
        const { needsConfirmation } = await signUpWithEmail(e, password);
        if (needsConfirmation) {
          setNotice('Check your inbox to confirm your email, then sign in.');
          setMode('signIn');
          return;
        }
      } else {
        await signInWithEmail(e, password);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
    } catch (err) {
      setError(messageOf(err, 'Something went wrong. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <StatusBar style="light" />
      <GradientWave height={headerHeight} />

      <View
        style={[
          styles.body,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom + 24,
            paddingHorizontal: t.spacing.xl,
          },
        ]}
      >
        <View style={styles.headlineArea}>
          <RotatingHeadline />
        </View>

        <Animated.View
          entering={FadeInDown.delay(320).duration(700)}
          style={styles.footer}
        >
          <Button
            title="Get started"
            size="lg"
            fullWidth
            onPress={openSheet}
            rightIcon={
              <Ionicons name="arrow-forward" size={18} color={t.colors.textOnAccent} />
            }
          />
          <Text variant="caption" tone="tertiary" style={styles.legal}>
            By continuing you agree to our Terms of Service and Privacy Policy.
          </Text>
        </Animated.View>
      </View>

      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        <BottomSheetView
          style={[styles.sheetBody, { paddingBottom: insets.bottom + 16 }]}
        >
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              <Text variant="micro" tone="tertiary" uppercase weight="bold">
                Welcome
              </Text>
              <Text variant="title3" weight="bold" tight>
                {mode === 'signUp' ? 'Create account' : 'Sign in'}
              </Text>
            </View>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                setSheetOpen(false);
              }}
              hitSlop={10}
              style={[styles.close, { backgroundColor: t.colors.fill1 }]}
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={18} color={t.colors.textSecondary} />
            </Pressable>
          </View>

          {notice ? (
            <View style={[styles.banner, { backgroundColor: t.colors.successSoft }]}>
              <Ionicons name="checkmark-circle" size={18} color={t.colors.success} />
              <Text variant="bodySm" style={{ flex: 1 }}>
                {notice}
              </Text>
            </View>
          ) : null}
          {error ? (
            <View style={[styles.banner, { backgroundColor: t.colors.dangerSoft }]}>
              <Ionicons name="alert-circle" size={18} color={t.colors.danger} />
              <Text variant="bodySm" tone="danger" style={{ flex: 1 }}>
                {error}
              </Text>
            </View>
          ) : null}

          {appleAvailable ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={
                t.isDark
                  ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={t.radii.md}
              style={styles.appleButton}
              onPress={handleApple}
            />
          ) : null}

          {appleAvailable ? (
            <View style={styles.dividerRow}>
              <View style={[styles.line, { backgroundColor: t.colors.separator }]} />
              <Text variant="caption" tone="tertiary" weight="semibold">
                or
              </Text>
              <View style={[styles.line, { backgroundColor: t.colors.separator }]} />
            </View>
          ) : null}

          <View style={{ gap: t.spacing.sm }}>
            <Input
              placeholder="Email"
              leftIcon="mail-outline"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              autoCorrect={false}
              returnKeyType="next"
            />
            <Input
              placeholder="Password"
              leftIcon="lock-closed-outline"
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              secureTextEntry
              returnKeyType="go"
              onSubmitEditing={handleEmail}
            />
            <Button
              title={mode === 'signUp' ? 'Create account' : 'Sign in'}
              onPress={handleEmail}
              loading={busy === 'email'}
              disabled={busy !== null}
              size="lg"
              fullWidth
            />
          </View>

          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              setError(null);
              setNotice(null);
              setMode((m) => (m === 'signIn' ? 'signUp' : 'signIn'));
            }}
            hitSlop={8}
            style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.6 }]}
          >
            <Text variant="bodySm" tone="secondary">
              {mode === 'signIn' ? 'New here? ' : 'Already have an account? '}
              <Text variant="bodySm" tone="accent" weight="semibold">
                {mode === 'signIn' ? 'Create an account' : 'Sign in'}
              </Text>
            </Text>
          </Pressable>
        </BottomSheetView>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: {
    flex: 1,
  },
  headlineArea: {
    flex: 1,
    justifyContent: 'center',
  },
  headline: {
    height: 170,
    justifyContent: 'center',
  },
  headlineItem: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
  },
  headlineText: {
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 16,
  },
  footer: {
    gap: 14,
  },
  legal: {
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  sheetBody: {
    paddingHorizontal: 20,
    paddingTop: 4,
    gap: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 12,
  },
  appleButton: {
    height: 52,
    width: '100%',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  line: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  toggle: {
    alignItems: 'center',
    paddingVertical: 4,
  },
});
