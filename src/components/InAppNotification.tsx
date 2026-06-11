import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { GlassSurface } from './Glass';
import {
  usePlanJobsStore,
  type ReadyToast,
} from '@/store/usePlanJobsStore';

const AUTO_DISMISS_MS = 6000;
const HIDDEN_Y = -220;

/**
 * A floating, ChatGPT-style in-app banner that drops in from the top edge when
 * a plan finishes building while Diem is foregrounded. Distinct from the
 * homepage plan card (this is a transient nudge, not the day itself) but shares
 * the liquid-glass language: a place thumbnail, a title, a one-line subtitle,
 * and a tap target that opens the finished day. Auto-dismisses, swipe-up to
 * dismiss early, and never co-exists with the OS notification (the store only
 * sets a toast when the app is active — otherwise it posts a push instead).
 *
 * Mounted once at the app root so it overlays every screen.
 */
export function InAppNotification() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = usePlanJobsStore((s) => s.toast);
  const dismissToast = usePlanJobsStore((s) => s.dismissToast);

  // Mirror the store payload locally so the content stays painted through the
  // exit animation (which runs after the store has already been cleared).
  const [data, setData] = useState<ReadyToast | null>(toast);

  const restY = insets.top + 8;
  const translateY = useSharedValue(HIDDEN_Y);
  const opacity = useSharedValue(0);

  const clearStore = useCallback(() => {
    dismissToast();
  }, [dismissToast]);

  const hide = useCallback(() => {
    cancelAnimation(translateY);
    translateY.value = withTiming(HIDDEN_Y, { duration: 240 });
    opacity.value = withTiming(0, { duration: 200 }, (finished) => {
      if (finished) runOnJS(clearStore)();
    });
  }, [clearStore, opacity, translateY]);

  useEffect(() => {
    if (!toast) return;
    setData(toast);
    Haptics.notificationAsync(
      toast.tone === 'error'
        ? Haptics.NotificationFeedbackType.Warning
        : Haptics.NotificationFeedbackType.Success,
    ).catch(() => undefined);
    cancelAnimation(translateY);
    translateY.value = withSpring(restY, { damping: 20, stiffness: 220, mass: 0.8 });
    opacity.value = withTiming(1, { duration: 220 });
    const id = setTimeout(() => hide(), AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast, restY, hide, opacity, translateY]);

  const open = useCallback(() => {
    const current = data;
    hide();
    Haptics.selectionAsync().catch(() => undefined);
    if (!current) return;
    if (current.tone === 'error') {
      router.push('/itinerary');
    } else if (current.savedId) {
      router.push({ pathname: '/itinerary', params: { id: current.savedId } });
    } else {
      router.push('/');
    }
  }, [data, hide, router]);

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      // Follow the finger upward; resist downward drag so it can't be flung
      // past its resting position.
      translateY.value = restY + Math.min(e.translationY, 24);
    })
    .onEnd((e) => {
      // Swipe up (or a fast upward fling) dismisses; otherwise spring back.
      if (e.translationY < -24 || e.velocityY < -400) {
        runOnJS(hide)();
      } else {
        translateY.value = withSpring(restY, { damping: 20, stiffness: 220 });
      }
    });

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  if (!data) return null;

  const isError = data.tone === 'error';

  return (
    <Animated.View
      pointerEvents={toast ? 'box-none' : 'none'}
      style={[styles.wrap, containerStyle]}
    >
      <GestureDetector gesture={pan}>
        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`${data.title}. ${data.subtitle}`}
          style={({ pressed }) => [pressed && { transform: [{ scale: 0.99 }] }]}
        >
          <GlassSurface
            variant="thick"
            radius={t.radii.xl}
            style={[styles.card, { shadowColor: t.colors.shadow }]}
            innerStyle={styles.cardInner}
          >
            <View style={styles.row}>
              <View
                style={[
                  styles.thumb,
                  {
                    backgroundColor: isError
                      ? t.colors.dangerSoft
                      : t.colors.accentSoft,
                  },
                ]}
              >
                {data.thumbUrl && !isError ? (
                  <Image source={{ uri: data.thumbUrl }} style={styles.thumbImg} />
                ) : (
                  <Ionicons
                    name={isError ? 'alert-circle' : 'sparkles'}
                    size={20}
                    color={isError ? t.colors.danger : t.colors.accent}
                  />
                )}
              </View>
              <View style={styles.body}>
                <Text
                  variant="micro"
                  uppercase
                  weight="bold"
                  tone={isError ? 'danger' : 'accent'}
                  style={
                    isError ? undefined : { color: t.colors.accent, letterSpacing: 0.8 }
                  }
                >
                  {isError ? 'Plan failed' : 'Plan ready'}
                </Text>
                <Text variant="bodySm" weight="semibold" numberOfLines={1}>
                  {data.title}
                </Text>
                <Text variant="caption" tone="secondary" numberOfLines={1}>
                  {data.subtitle}
                </Text>
              </View>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={t.colors.textTertiary}
              />
            </View>
            <View style={[styles.grabber, { backgroundColor: t.colors.separator }]} />
          </GlassSurface>
        </Pressable>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    zIndex: 1000,
  },
  card: {
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
    elevation: 12,
  },
  cardInner: {
    paddingHorizontal: 14,
    paddingTop: 13,
    paddingBottom: 9,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  thumb: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    gap: 1,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginTop: 8,
  },
});
