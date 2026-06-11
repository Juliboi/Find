import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { PLANNING_PHASES, type PlanJob } from '@/store/usePlanJobsStore';

/**
 * The homepage stand-in for a day that's still being built in the background.
 * Mirrors the real plan card's silhouette (thumb + title + subtitle) but with
 * shimmering placeholders and a status line that rotates through PLANNING_PHASES
 * (driven by the job store, so it reads as live progress). A footer reassures
 * the user we'll ping them when it's ready, so leaving the screen feels safe.
 *
 * Rendered as the full body of the home card's GlassSurface — see app/index.tsx.
 */
export function PlanBuildingCard({ job }: { job: PlanJob }) {
  const t = useTheme();
  const pulse = useSharedValue(0.45);

  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.9, { duration: 820 }), -1, true);
  }, [pulse]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const phase = PLANNING_PHASES[Math.min(job.phase, PLANNING_PHASES.length - 1)];

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Animated.View
          style={[styles.thumb, { backgroundColor: t.colors.fill1 }, pulseStyle]}
        >
          <Ionicons name="sparkles" size={18} color={t.colors.accent} />
        </Animated.View>

        <View style={styles.text}>
          <Text variant="micro" uppercase weight="bold" tone="accent">
            Building your plan
          </Text>
          <Text variant="body" weight="semibold" numberOfLines={1}>
            {job.provisionalTitle}
          </Text>
          {/* Re-keyed on phase so each status line cross-fades in. */}
          <Animated.View key={job.phase} entering={FadeIn.duration(260)}>
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {phase}
            </Text>
          </Animated.View>
        </View>

        <ActivityIndicator color={t.colors.accent} />
      </View>

      <View style={[styles.divider, { backgroundColor: t.colors.separator }]} />

      <View style={styles.footer}>
        <Ionicons
          name="notifications-outline"
          size={14}
          color={t.colors.textTertiary}
        />
        <Text variant="caption" tone="tertiary" style={styles.footerText}>
          You can keep going — we&apos;ll let you know the moment it&apos;s ready.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  thumb: {
    width: 46,
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  text: {
    flex: 1,
    gap: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  footerText: {
    flexShrink: 1,
  },
});
