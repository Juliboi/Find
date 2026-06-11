import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useDayStore } from '@/store/useDayStore';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';

interface Props {
  /**
   * When set, the banner stays mounted at the same vertical position
   * while content fades — keeps the layout from jumping as states
   * transition (parsing → composing → done).
   */
  variant?: 'inline' | 'compact';
  /**
   * Optional dismiss handler for the success/summary state. The user
   * can clear the summary after they've read it.
   */
  onDismissSummary?: () => void;
}

type Stage = 'idle' | 'parsing' | 'composing' | 'summary';

function pickStage(s: {
  isScheduling: boolean;
  isComposing: boolean;
  composeSummary?: string;
}): Stage {
  if (s.isScheduling) return 'parsing';
  if (s.isComposing) return 'composing';
  if (s.composeSummary) return 'summary';
  return 'idle';
}

const STAGE_COPY: Record<Stage, { title: string; sub: string }> = {
  idle: { title: '', sub: '' },
  parsing: {
    title: 'Reading your plans…',
    sub: 'Sorting them into a day.',
  },
  composing: {
    title: 'Composing your day…',
    sub: 'Picking venues that flow well together.',
  },
  summary: { title: '', sub: '' },
};

/**
 * Single-source-of-truth banner for the AI pipeline running on the
 * day. Watches the store directly so any screen can drop it in without
 * extra wiring. Visible while either pass is running, then morphs into
 * a calm summary card once compose has a rationale.
 *
 * Dismissing the summary clears `composeSummary` from the store — we
 * treat it as a one-time read by default.
 */
export function ComposerStatus({ onDismissSummary }: Props) {
  const t = useTheme();
  const isScheduling = useDayStore((s) => s.isScheduling);
  const isComposing = useDayStore((s) => s.isComposing);
  const composeSummary = useDayStore((s) => s.composeSummary);

  const stage = pickStage({ isScheduling, isComposing, composeSummary });

  // Fade the wrapper in/out so transitions feel calm — no jarring
  // appear/disappear. We keep the same fade duration for in and out
  // because mirrored timing reads as "settled" rather than "rushed".
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: stage === 'idle' ? 0 : 1,
      duration: 280,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [stage, opacity]);

  if (stage === 'idle') return null;

  const isLoading = stage === 'parsing' || stage === 'composing';
  const copy = STAGE_COPY[stage];

  return (
    <Animated.View style={{ opacity }}>
      <View
        style={[
          styles.card,
          {
            backgroundColor: t.colors.accentSoft,
            borderColor: t.colors.separator,
            borderRadius: t.radii.lg,
            paddingVertical: t.spacing.md,
            paddingHorizontal: t.spacing.lg,
          },
        ]}
      >
        <View style={styles.row}>
          <View style={styles.leadingIcon}>
            {isLoading ? (
              <ActivityIndicator
                size="small"
                color={t.colors.accentText}
              />
            ) : (
              <Ionicons
                name="sparkles"
                size={18}
                color={t.colors.accentText}
              />
            )}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            {isLoading ? (
              <>
                <Text variant="bodySm" tone="accent" weight="semibold">
                  {copy.title}
                </Text>
                <Text variant="caption" tone="accent">
                  {copy.sub}
                </Text>
              </>
            ) : (
              <>
                <Text
                  variant="caption"
                  uppercase
                  weight="bold"
                  tone="accent"
                >
                  Diem composed your day
                </Text>
                <Text variant="bodySm" tone="accent">
                  {composeSummary}
                </Text>
              </>
            )}
          </View>
          {stage === 'summary' && onDismissSummary ? (
            <Pressable
              hitSlop={10}
              onPress={() => {
                Haptics.selectionAsync().catch(() => undefined);
                onDismissSummary?.();
              }}
              accessibilityLabel="Dismiss summary"
              style={({ pressed }) => [
                styles.dismiss,
                { backgroundColor: t.colors.surface1 },
                pressed && { opacity: 0.6 },
              ]}
            >
              <Ionicons
                name="close"
                size={12}
                color={t.colors.textSecondary}
              />
            </Pressable>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  leadingIcon: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismiss: {
    width: 22,
    height: 22,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
