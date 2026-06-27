import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';
import { GlassSurface } from './Glass';
import {
  formatLeftover,
  levelLabel,
  scoreNote,
  type DayScore,
  type MindfulnessLevel,
} from '@/lib/planning/mindfulness';
import { formatDuration } from '@/utils/time';

interface Props {
  score: DayScore;
  /**
   * Container chrome. `glass` (default) matches the homepage's liquid-glass
   * cards; `plain` is a flat tinted card for surfaces that sit on their own
   * background (the plan drawer).
   */
  surface?: 'glass' | 'plain';
  style?: StyleProp<ViewStyle>;
}

/** Per-level accent: calm greens → amber → red, with a soft tint to match. */
function levelColors(
  level: MindfulnessLevel,
  t: ReturnType<typeof useTheme>,
): { color: string; soft: string } {
  switch (level) {
    case 'serene':
      return { color: t.colors.success, soft: t.colors.successSoft };
    case 'balanced':
      return { color: t.colors.accent, soft: t.colors.accentSoft };
    case 'busy':
    case 'packed':
      return { color: t.colors.warning, soft: t.colors.warningSoft };
    case 'overloaded':
      return { color: t.colors.danger, soft: t.colors.dangerSoft };
  }
}

/**
 * A compact "how does this day feel?" card: a mindfulness score (0–100, calm →
 * overloaded), the leftover free time, a proportion bar (errands · travel ·
 * free), and a one-line reason. Pure presentation — it renders whatever
 * {@link DayScore} the caller computed, so the homepage (the whole day) and the
 * plan drawer (just the ticked errands) share one look and update live as the
 * inputs change.
 */
export function DayBalanceCard({ score, surface = 'glass', style }: Props) {
  const t = useTheme();
  const { color, soft } = levelColors(score.level, t);

  // The bar represents the day window; when overbooked it represents the load
  // instead (so the over-full state still fills the track).
  const denom = Math.max(score.availableMin, score.committedMin + score.travelMin, 1);
  const committedFlex = score.committedMin;
  const travelFlex = score.travelMin;
  const freeFlex = Math.max(0, score.freeMin);
  const trackFilled = committedFlex + travelFlex + freeFlex > 0;

  const breakdown: string[] = [];
  if (score.committedMin > 0) {
    breakdown.push(`${formatDuration(score.committedMin)} errands`);
  }
  if (score.travelMin > 0) breakdown.push(`${formatDuration(score.travelMin)} travel`);
  if (score.fits && score.freeMin >= 5) {
    breakdown.push(`${formatDuration(score.freeMin)} free`);
  }

  const inner = (
    <>
      <View style={styles.headerRow}>
        <View
          style={[
            styles.badge,
            { backgroundColor: soft, borderColor: color },
          ]}
        >
          <Text variant="title3" weight="bold" tight style={{ color }}>
            {score.score}
          </Text>
        </View>

        <View style={styles.headerText}>
          <Text variant="micro" uppercase weight="bold" tone="accent">
            Mindfulness
          </Text>
          <Text variant="body" weight="semibold" numberOfLines={1}>
            {levelLabel(score.level)}
          </Text>
        </View>

        <View style={[styles.leftoverPill, { backgroundColor: soft }]}>
          <Ionicons
            name={score.fits ? 'leaf-outline' : 'alert-circle-outline'}
            size={13}
            color={color}
          />
          <Text variant="caption" weight="bold" style={{ color }}>
            {formatLeftover(score.freeMin)}
          </Text>
        </View>
      </View>

      {trackFilled ? (
        <View style={styles.bar}>
          <View
            style={[
              styles.track,
              { backgroundColor: t.colors.fill1 },
            ]}
          >
            {committedFlex > 0 ? (
              <View
                style={{
                  flex: committedFlex / denom,
                  backgroundColor: t.colors.accent,
                }}
              />
            ) : null}
            {travelFlex > 0 ? (
              <View
                style={{
                  flex: travelFlex / denom,
                  backgroundColor: t.colors.warning,
                }}
              />
            ) : null}
            {freeFlex > 0 ? (
              <View
                style={{
                  flex: freeFlex / denom,
                  backgroundColor: t.colors.success,
                }}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {breakdown.length > 0 ? (
        <Text variant="caption" tone="secondary" numberOfLines={1}>
          {breakdown.join('  ·  ')}
        </Text>
      ) : null}

      <Text variant="caption" tone="tertiary">
        {scoreNote(score)}
      </Text>
    </>
  );

  if (surface === 'plain') {
    return (
      <View
        style={[
          styles.plain,
          {
            backgroundColor: t.colors.surface2,
            borderColor: t.colors.separator,
            borderRadius: t.radii.lg,
          },
          style,
        ]}
      >
        {inner}
      </View>
    );
  }

  return (
    <GlassSurface
      variant="regular"
      radius={t.radii.xl}
      style={[styles.card, { shadowColor: t.colors.shadow }, style]}
      innerStyle={styles.cardInner}
    >
      {inner}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 22,
    elevation: 8,
  },
  cardInner: {
    padding: 16,
    gap: 12,
  },
  plain: {
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  badge: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    gap: 1,
  },
  leftoverPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  bar: {
    marginTop: 2,
  },
  track: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
});
