import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/useTheme';
import { GlassSurface } from './Glass';
import { Text } from './Text';

export interface TopBarAction {
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Display the icon inside a filled accent circle (e.g. confirm). */
  accent?: boolean;
}

interface Props {
  /** Optional small label above the title (e.g. day name, kicker). */
  kicker?: string;
  title?: string;
  /** Left side control (typically a back button). */
  left?: TopBarAction | null;
  /** Right side controls. Rendered grouped in a single glass pill. */
  actions?: TopBarAction[];
  /** Hide the title row — useful when actions alone are enough. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

const PILL_HEIGHT = 40;
const ACTION_SIZE = 32;

/**
 * Contextual top bar. Per the spec, the *content* of the top bar
 * changes per page — that's the whole reason it's a component, not a
 * fixed chrome element. Pass in `left`, `actions`, `kicker`, `title` to
 * make it fit the current page's job.
 *
 * The actions render as a single glass pill on the right, matching the
 * "bell + more" cluster shown in the reference screenshots.
 */
export function TopBar({
  kicker,
  title,
  left,
  actions,
  compact,
  style,
}: Props) {
  const t = useTheme();

  return (
    <View style={[styles.container, { paddingHorizontal: t.spacing.lg }, style]}>
      <View style={styles.row}>
        <View style={styles.side}>
          {left ? (
            <GlassSurface
              variant="regular"
              radius={t.radii.pill}
              style={styles.pillContainer}
              innerStyle={styles.pillInner}
            >
              <ActionButton {...left} />
            </GlassSurface>
          ) : null}
        </View>

        <View style={styles.side}>
          {actions && actions.length > 0 ? (
            <GlassSurface
              variant="regular"
              radius={t.radii.pill}
              style={styles.pillContainer}
              innerStyle={styles.pillInner}
            >
              {actions.map((a, idx) => (
                <ActionButton key={`${a.icon}-${idx}`} {...a} />
              ))}
            </GlassSurface>
          ) : null}
        </View>
      </View>

      {!compact && (kicker || title) ? (
        <View style={styles.titleBlock}>
          {kicker ? (
            <Text variant="caption" tone="secondary" uppercase weight="semibold">
              {kicker}
            </Text>
          ) : null}
          {title ? (
            <Text variant="title1" tight>
              {title}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ActionButton({ icon, onPress, accessibilityLabel, accent }: TopBarAction) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.actionWrap,
        accent && {
          backgroundColor: colors.accent,
          borderRadius: 999,
        },
        pressed && { opacity: 0.6 },
      ]}
    >
      <Ionicons
        name={icon}
        size={18}
        color={accent ? colors.textOnAccent : colors.textPrimary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 8,
    gap: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: PILL_HEIGHT,
  },
  side: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pillContainer: {
    height: PILL_HEIGHT,
  },
  pillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    height: PILL_HEIGHT,
  },
  actionWrap: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
  },
  titleBlock: {
    gap: 4,
  },
});
