import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { Text } from './Text';

interface Props {
  title: string;
  body?: string;
  /** Optional Ionicon shown above the title in a soft, large illustration. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Whether to nudge the user toward the FAB with an arrow (per the spec). */
  pointToFab?: boolean;
  action?: React.ReactNode;
  /** Smaller variant for inline empty states (e.g. inside a card). */
  inline?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Two-mode empty state per the spec:
 *   - "Get started" (no content yet): large icon + title + body + arrow
 *     pointing toward the FAB; optional action button.
 *   - "No results" (e.g. search came up empty): icon + title + body
 *     acknowledging the lack of matches, plus an exit action.
 *
 * The arrow doodle is rendered as a chain of dots so it works on any
 * platform without needing an SVG asset, while still feeling hand-drawn.
 */
export function EmptyState({
  title,
  body,
  icon = 'sparkles-outline',
  pointToFab,
  action,
  inline,
  style,
}: Props) {
  const { colors, spacing } = useTheme();

  return (
    <View
      style={[
        styles.container,
        inline ? styles.inline : styles.full,
        style,
      ]}
    >
      <View
        style={[
          styles.iconWrap,
          {
            backgroundColor: colors.fill1,
            width: inline ? 72 : 96,
            height: inline ? 72 : 96,
            borderRadius: inline ? 24 : 32,
          },
        ]}
      >
        <Ionicons
          name={icon}
          size={inline ? 30 : 42}
          color={colors.textSecondary}
        />
      </View>

      <View style={{ gap: spacing.xs, alignItems: 'center' }}>
        <Text variant={inline ? 'title3' : 'title2'} tight style={styles.title}>
          {title}
        </Text>
        {body ? (
          <Text variant="bodySm" tone="secondary" style={styles.body}>
            {body}
          </Text>
        ) : null}
      </View>

      {pointToFab ? <ArrowDoodle color={colors.textTertiary} /> : null}

      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

/** Hand-drawn-feeling curved arrow pointing to the bottom-right FAB. */
function ArrowDoodle({ color }: { color: string }) {
  return (
    <View style={styles.arrow}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <View
          key={i}
          style={[
            styles.arrowDot,
            {
              backgroundColor: color,
              transform: [
                { translateX: i * 14 },
                { translateY: Math.pow(i, 2) * 1.6 },
              ],
            },
          ]}
        />
      ))}
      <Ionicons
        name="arrow-down"
        size={20}
        color={color}
        style={{
          position: 'absolute',
          right: -2,
          bottom: -4,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 20,
  },
  full: {
    paddingVertical: 56,
  },
  inline: {
    paddingVertical: 28,
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    textAlign: 'center',
  },
  body: {
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  action: {
    marginTop: 4,
    width: '100%',
    alignItems: 'center',
  },
  arrow: {
    width: 120,
    height: 80,
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    marginTop: 8,
  },
  arrowDot: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
  },
});
